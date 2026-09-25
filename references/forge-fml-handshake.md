# Forge FML Login Handshake — Wire Format & Reverse-Engineering Method

Reference for `fml-handshake.js`. Everything here was derived by reading Forge 1.20.1
source (`MinecraftForge/MinecraftForge`, branch `1.20.1`) and decompiling the actual
mod jars with `javap -p -c -constants` — not from memory.

---

## 1. Why a vanilla client is rejected

Forge identifies a Forge client by a **`\0FML3` suffix on the server-address string**
in the handshake (`set_protocol`) packet:

```java
// net/minecraftforge/network/NetworkHooks.java:57
String ip = packet.getHostName();
return ip.contains("\0") ? NetworkConstants.NETVERSION : NetworkConstants.NOVERSION;
```

Without it the server classifies the connection as `VANILLA` and skips negotiation
entirely — you get `"This server has mods that require Forge to be installed on the
client."` with **zero** handshake packets on the wire.

Fix in nmp: `client.tagHost = '\u0000FML3'` (`src/client/setProtocol.js` appends
`client.tagHost` to the host).

---

## 2. Outer transport

Forge reuses the vanilla login-plugin channel as a wrapper:

- channel name: **`fml:loginwrapper`**
- carrier packets: `login_plugin_request` (S2C) / `login_plugin_response` (C2S)
- outer payload: `[ResourceLocation target][varint length][inner bytes]`

```java
// LoginWrapper.wrapPacket
pb.writeResourceLocation(rl);
pb.writeVarInt(buf.readableBytes());
pb.writeBytes(buf);
```

**Echo the target channel — do not hardcode `fml:handshake`.** Mod channels are
wrapped the same way.

The wrapper's `transactionId` (nmp's `messageId`) **is** the server's `packetPosition`.
Replies must echo it: `HandshakeHandler.sentMessages` is keyed by that index, and
`IndexedMessageCodec.consume(payload, payloadIndex, ...)` looks it up.

---

## 3. Inner format

```
inner = [uint8 discriminator][body...]
```

Single byte, **not** a varint:

```java
// IndexedMessageCodec.tryEncode
target.writeByte(codec.index & 0xff);
```

On `fml:handshake` (`NetworkInitialization`):

| ID | Name | Direction | Reply |
|---|---|---|---|
| 1 | `S2CModList` | S2C | `C2SModListReply` (2) |
| 2 | `C2SModListReply` | C2S | — |
| 3 | `S2CRegistry` | S2C | `C2SAcknowledge` (99) |
| 4 | `S2CConfigData` | S2C | `C2SAcknowledge` (99) |
| 5 | `S2CModData` | S2C | **none** (`noResponse`) |
| 6 | `S2CChannelMismatchData` | S2C | none |
| 99 | `C2SAcknowledge` | C2S | empty body |

`S2CModList` body: `list<string> mods`, `list<[string channel, string version]> channels`,
`list<string> registries`, `list<string> dataPackRegistries`.
`C2SModListReply`: echo mods + channels, then an **empty** registry-hash map.
`S2CRegistry`: `[ResourceLocation name][bool hasSnapshot][bytes]`.
`S2CConfigData`: `[UTF fileName][varint len][bytes]`.

---

## 4. The disconnect rule

```java
// IndexedMessageCodec.consume
void consume(FriendlyByteBuf payload, int payloadIndex, Supplier<NetworkEvent.Context> context) {
    if (payload == null || !payload.isReadable()) {
        if (!HandshakeHandler.packetNeedsResponse(mgr, payloadIndex))
            context.get().setPacketHandled(true);   // empty is only tolerated for noResponse
        return;
    }
    short discriminator = payload.readUnsignedByte();
    MessageHandler<?> h = indicies.get(discriminator);
    if (h == null) return;                          // unknown id is also not handled
    NetworkHooks.validatePacketDirection(...);
    tryDecode(payload, context, payloadIndex, h);
}
```

```java
// ServerLoginPatch.patch
public void m_7223_(ServerboundCustomQueryPacket p) {
    if (!NetworkHooks.onCustomPayload(p, this.f_10013_))
        this.m_10053_(Component.m_237115_("multiplayer.disconnect.unexpected_query_response"));
}
```

`onCustomPayload` returns the `packetHandled` flag. **Not handled ⇒ instant kick.**

`needsResponse` comes from the registration:

```java
// SimpleChannel.MessageBuilder
private boolean needsResponse = true;      // default TRUE
public MessageBuilder<MSG> noResponse() { this.needsResponse = false; return this; }
```

```java
// NetworkRegistry.LoginPayload — the 3-arg ctor defaults to true
public LoginPayload(buf, channelName, ctx) { this(buf, channelName, ctx, true); }
```

`HandshakeHandler.tickServer()` only adds to `sentMessages` when `needsResponse()`.

**Practical consequence:** an empty reply that kicks you is a *positive signal* —
it means that channel needs a real answer. Unknown channels reply empty by design,
so the log names exactly which mod to reverse next.

---

## 5. Reverse-engineering recipe

1. **Scan** for registrations:
   ```bash
   python scripts/scan-login-channels.py "<mods-dir>" login-scan.txt
   ```
   Markers: `markAsLoginPacket`, `buildLoginPacketList`, `noResponse`, `indexFirst`,
   `registerLogin`, `ZetaHandshakeMessage`, `packetsNeedResponse`,
   `dispatchLoginPacket`, `LoginPayloadEvent`.

   > Caveat: substring matches happen. `CreativeCore`'s `OBB.class` /
   > `Interpolation.class` contain `indexFirst` but are math utilities. Always
   > confirm a hit by decompiling.

2. **Find the channel name** — `NetworkRegistry.newSimpleChannel(<ns>, <path>, ...)`,
   or `TaCZTweaks.id("handshake")`, etc. Grep the class's `// String` constants.

3. **Find the discriminator** — `messageBuilder(Class, index, NetworkDirection)`.
   Watch out for `AtomicInteger` counters: **check the `<clinit>` initial value**.
   TACZ uses `new AtomicInteger(1)`, so the first `getAndIncrement()` is **1**, not 0.

4. **Decide needsResponse** — is `.noResponse()` in the builder chain? For
   `GatherLoginPayloadsEvent`, is the 4-arg overload used and what is the boolean?

5. **Derive the C2S body** — decompile the message class's `encode()` /
   `StreamCodec`. If it's a paired S2C/C2S handshake message with identical fields,
   the **echo trick** works: reuse the received body, swap the discriminator.

6. **Verify** — run and watch for `unexpected_query_response`. Then confirm with
   `GET /status` → `connected: true`.

---

## 6. Worked examples

### TACZ — `tacz:handshake` (needsResponse = true)

```java
HANDSHAKE_CHANNEL = NetworkRegistry.newSimpleChannel(new ResourceLocation("tacz","handshake"), ...);
HANDSHAKE_ID_COUNT = new AtomicInteger(1);          // ← initial value 1

// Acknowledge: index 1, no .noResponse()  → server waits for it
messageBuilder(Acknowledge.class, HANDSHAKE_ID_COUNT.getAndIncrement(), LOGIN_TO_SERVER)
    .loginIndex(...).encoder(...).decoder(...)
    .consumerNetworkThread(HandshakeHandler.indexFirst(...))
    .add();

// ServerMessageSyncedEntityDataMapping: index 2, markAsLoginPacket()
```

`Acknowledge.encode()` is empty ⇒ **reply = `[0x01]`**.
Confirmed by the observed S2C first byte `0x02` for the sibling message.

### Zeta — `zeta:main` (needsResponse = true)

```java
// ZetaModInternalNetwork.init()
registerLogin(S2CLoginFlag.class, LOGIN_TO_CLIENT, 98, true,  S2CLoginFlag::generateRegistryPackets);
registerLogin(C2SLoginFlag.class, LOGIN_TO_SERVER, 99, false, null);
```

```java
// ForgeZetaNetworkHandler.registerLogin
MessageBuilder b = builder(clazz, index, toForge(zetaDir)).loginIndex(...);
if (generator != null) b.buildLoginPacketList(generator);
if (zetaDir == LOGIN_TO_SERVER) b.consumerNetworkThread(HandshakeHandler.indexFirst(handler));
else                            b.consumerNetworkThread(handler);
if (!needsResponse) b.noResponse();
b.add();
```

```java
// S2CLoginFlag.receive — the reply is a C2SLoginFlag with identical fields
context.reply(new C2SLoginFlag());
```

Both classes declare `BitSet flags; int expectedLength; int expectedHash;` — and
`ZetaMessageSerializer.writeObject()` has **no class header**, it just walks
`getClassFields()` in order. ⇒ byte layouts are identical.

**Reply = `0x63` + `inner[1..]`.**

`C2SLoginFlag.receive()` compares hashes with `if_icmpne → return true`, so a hash
mismatch only skips the config sync — it never disconnects.

### TACZ Tweaks — `tacztweaks:handshake` (needsResponse = false)

```kotlin
handshake.messageBuilder(clazz, handshakeCounter.getAndIncrement(), LOGIN_TO_CLIENT)
    .loginIndex(...).encoder(...).decoder(...).consumerNetworkThread(...)
    .noResponse()            // ← empty reply is safe
    .markAsLoginPacket()
    .add()
```

### Fzzy Config — `fzzy_config:config_sync_s2c` (needsResponse = false)

```java
// not a SimpleChannel — uses GatherLoginPayloadsEvent
event.add(buf, ConfigSyncS2CCustomPayload.getId(), "Fzzy Config login config sync", false);
//                                                                              iconst_0 ↑
```

---

## 7. Known non-fatal issue: `declare_commands`

On a 500+ mod server, nmp throws:

```
PartialReadError: Read error for undefined : Unexpected buffer end while reading VarInt
    at Object.command_node ... packet_declare_commands ...
```

Cause: modded Brigadier argument types. `minecraft-data`'s `command_node_properties`
only knows vanilla parser ids, so for an unknown parser it reads zero property bytes
and the byte stream desynchronises.

Impact: transient, at join only; nmp re-aligns and position/health/entities/chat work.
Proper fix (not applied): patch the protodef schema so unknown `parser` values are
skipped by length prefix, or ignore the `declare_commands` payload body entirely.
