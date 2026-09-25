'use strict'
/*
 * fml-handshake.js —— 让原版协议客户端（mineflayer / node-minecraft-protocol）
 * 通过 Forge 的 FML 登录握手，从而进入 Forge 服务端。
 *
 * 协议来源（逐条对照源码，非记忆）：
 *   MinecraftForge/MinecraftForge @ branch 1.20.1
 *     net/minecraftforge/network/NetworkConstants.java
 *     net/minecraftforge/network/NetworkInitialization.java
 *     net/minecraftforge/network/LoginWrapper.java
 *     net/minecraftforge/network/HandshakeMessages.java
 *     net/minecraftforge/network/HandshakeHandler.java
 *     net/minecraftforge/network/simple/IndexedMessageCodec.java
 *
 * 线上格式：
 *   1) 外层用原版 login_plugin_request / login_plugin_response 承载
 *      （Forge NetworkDirection: LOGIN_TO_CLIENT=ClientboundCustomQueryPacket,
 *        LOGIN_TO_SERVER=ServerboundCustomQueryPacket）
 *      channel = "fml:loginwrapper"
 *   2) 外层 payload = [ResourceLocation 目标通道][varint 长度][内层字节]
 *      目标通道固定为 "fml:handshake"
 *   3) 内层 = [uint8 包ID][包体]        ← 单字节，不是 varint
 *      (IndexedMessageCodec.tryEncode: target.writeByte(codec.index & 0xff))
 *   4) 回复包的 transactionId 必须回显请求的 transactionId
 *      (NetworkEvent.PacketDispatcher.NetworkManagerDispatcher 用收到包的 packetIndex)
 */

const WRAPPER_CHANNEL = 'fml:loginwrapper'
const HANDSHAKE_CHANNEL = 'fml:handshake'

// fml:handshake 通道上的包 ID（NetworkInitialization 注册顺序）
const ID = {
  S2C_MOD_LIST: 1, //  服务端 mod 列表
  C2S_MOD_LIST_REPLY: 2, //  客户端 mod 列表回复
  S2C_REGISTRY: 3, //  注册表快照
  S2C_CONFIG_DATA: 4, //  配置同步
  S2C_MOD_DATA: 5, //  mod 元数据（noResponse）
  S2C_CHANNEL_MISMATCH: 6, //  通道不匹配
  C2S_ACKNOWLEDGE: 99 //  确认（包体为空）
}

// ---------------------------------------------------------------- 读

class Reader {
  constructor (buf) {
    this.b = buf
    this.o = 0
  }

  varint () {
    let v = 0
    let shift = 0
    let byte
    do {
      if (this.o >= this.b.length) throw new Error('varint 越界')
      byte = this.b[this.o++]
      v |= (byte & 0x7f) << shift
      shift += 7
      if (shift > 35) throw new Error('varint 过长')
    } while (byte & 0x80)
    return v >>> 0
  }

  u8 () {
    if (this.o >= this.b.length) throw new Error('u8 越界')
    return this.b[this.o++]
  }

  str () {
    const n = this.varint()
    if (this.o + n > this.b.length) throw new Error('string 越界')
    const s = this.b.toString('utf8', this.o, this.o + n)
    this.o += n
    return s
  }

  bytes (n) {
    if (this.o + n > this.b.length) throw new Error('bytes 越界')
    const s = this.b.subarray(this.o, this.o + n)
    this.o += n
    return s
  }

  remaining () {
    return this.b.length - this.o
  }
}

// ---------------------------------------------------------------- 写

function wVarint (n) {
  n = n >>> 0
  const out = []
  for (;;) {
    let t = n & 0x7f
    n >>>= 7
    if (n !== 0) t |= 0x80
    out.push(t)
    if (n === 0) break
  }
  return Buffer.from(out)
}

function wU8 (n) {
  return Buffer.from([n & 0xff])
}

function wStr (s) {
  const b = Buffer.from(String(s), 'utf8')
  return Buffer.concat([wVarint(b.length), b])
}

// ---------------------------------------------------------------- 外层包装

/** 拆外层：[ResourceLocation 目标通道][varint 长度][内层] */
function unwrap (data) {
  const r = new Reader(data)
  const target = r.str()
  const len = r.varint()
  const inner = r.bytes(len)
  return { target, inner }
}

/** 装外层：目标通道必须回显请求里的那个（不是固定 fml:handshake） */
function wrap (target, inner) {
  return Buffer.concat([wStr(target), wVarint(inner.length), inner])
}

// ---------------------------------------------------------------- mod 登录通道回执
// Forge 之外，mod 也可以注册自己的登录通道（同样被 fml:loginwrapper 包着）。
// 服务端对这些包同样在等回执，判定规则来自 IndexedMessageCodec.consume()：
//
//   void consume(FriendlyByteBuf payload, int payloadIndex, Context ctx) {
//     if (payload == null || !payload.isReadable()) {          // ← 空载荷
//       if (!HandshakeHandler.packetNeedsResponse(mgr, payloadIndex))
//         ctx.setPacketHandled(true);                          // ← 只有 noResponse 包才容忍空
//       return;                                                // ← 否则不 handled
//     }
//     short discriminator = payload.readUnsignedByte();        // ← 首字节是包 ID
//     MessageHandler<?> h = indicies.get(discriminator);
//     if (h == null) return;                                   // ← 未知 ID 也不 handled
//     ...
//   }
//
// 而 ServerLoginPacketListenerImpl.handleCustomQuery 的补丁是：
//   if (!NetworkHooks.onCustomPayload(packet, conn))
//       disconnect("multiplayer.disconnect.unexpected_query_response");
//
// 即：**只要最终没被 setPacketHandled(true)，立刻断线**。
// 于是每个 mod 登录通道只有两条活路：
//   (a) 该包注册时调了 noResponse()  → 回空包（或不回）即可
//   (b) 该包注册时没调 noResponse()  → 必须回一个「discriminator 在服务端 codec 表里、
//       且方向校验通过」的合法 C2S 消息
//
// 下表是把这个整合包 487 个 jar 全量扫描 + 逐个反编译得出的结果
// （扫描器：mc-play/scan_login.py，报告：mc-play/login-scan.txt）。
// 真正注册了登录握手包的只有 4 个 mod，其中只有 2 个需要回执：
//
// ┌──────────────────────────┬──────────────┬──────────────────────────────────────┐
// │ 通道                     │ needsResponse│ 客户端应答                            │
// ├──────────────────────────┼──────────────┼──────────────────────────────────────┤
// │ tacz:handshake           │ true         │ 0x01 = Acknowledge（空包体）          │
// │ zeta:main                │ true         │ 0x63 = C2SLoginFlag（回显 S2C 包体）  │
// │ tacztweaks:handshake     │ false        │ 空包（注册时调了 noResponse()）        │
// │ fzzy_config:config_sync_s2c │ false     │ 空包（GatherLoginPayloadsEvent 传 false）│
// └──────────────────────────┴──────────────┴──────────────────────────────────────┘
//
// --- tacz:handshake （[永恒枪械工坊：零] tacz-1.20.1-1.1.8-hotfix.jar） ---
//   com/tacz/guns/network/NetworkHandler
//     <clinit>: HANDSHAKE_CHANNEL = newSimpleChannel(tacz:handshake, …)
//               HANDSHAKE_ID_COUNT = new AtomicInteger(1)      ← 初值 1，不是 0！
//     registerAcknowledge():  messageBuilder(Acknowledge, HANDSHAKE_ID_COUNT.getAndIncrement(), …)
//                             .loginIndex(…).encoder(…).decoder(…)
//                             .consumerNetworkThread(indexFirst(…))   ← 没调 noResponse() → 必须回
//     registerHandshakeMessage(ServerMessageSyncedEntityDataMapping):
//                             getAndIncrement() → 2，配 markAsLoginPacket() + buildLoginPacketList()
//     （实测服务端发来的 S2C 内层首字节 = 0x02，与推导一致）
//   com/tacz/guns/network/message/handshake/Acknowledge.encode() 为空实现 → 包体 0 字节
//   ⇒ 内层 = [uint8 0x01]
//
// --- zeta:main （Zeta-1.0-29.jar） ---
//   org/violetmoon/zeta/network/ZetaModInternalNetwork.init():
//     registerLogin(S2CLoginFlag, LOGIN_TO_CLIENT, 98, true,  S2CLoginFlag::generateRegistryPackets)
//     registerLogin(C2SLoginFlag, LOGIN_TO_SERVER, 99, false, null)
//   org/violetmoon/zetaimplforge/network/ForgeZetaNetworkHandler.registerLogin():
//     方向 == LOGIN_TO_SERVER → consumerNetworkThread(indexFirst(…))
//     needsResponse == false  → noResponse()
//   org/violetmoon/zeta/network/message/S2CLoginFlag.receive():
//     比较 expectedLength/expectedHash 后 context.reply(new C2SLoginFlag())
//     → 所以 C2S 侧的包体结构与 S2C 完全相同（都是 BitSet flags + int expectedLength + int expectedHash）
//   org/violetmoon/zeta/network/ZetaMessageSerializer.writeObject():
//     只按 getClassFields() 顺序写字段，**没有任何类名/长度头** → 两个方向的字节布局逐字节一致
//   ⇒ 内层 = [uint8 0x63] + 收到的 inner[1..]  （把 discriminator 从 0x62 换成 0x63，其余原样回显）
//   补充：C2SLoginFlag.receive() 在 hash 不匹配时只是跳过同步、依然 return true，
//         所以即使回显的是服务端的 hash 也不会被踢，最坏情况仅是该玩家不吃这套配置同步。
//
// 未登记的通道：回空包。对 noResponse 通道安全；对 needsResponse 通道会立刻断线并在日志里点名，
// 便于补表（这也是这套实现的自我诊断机制）。
//
// 值可以是 Buffer（固定应答），也可以是 (inner) => Buffer（按收到的包体动态构造）。
const MOD_LOGIN_REPLIES = {
  // tacz:handshake —— Acknowledge，索引 1，空包体
  'tacz:handshake': Buffer.from([0x01]),
  // zeta:main —— S2CLoginFlag(0x62) → C2SLoginFlag(0x63)，字节布局一致，换 discriminator 后原样回显
  'zeta:main': (inner) => Buffer.concat([Buffer.from([0x63]), inner.subarray(1)])
}

// ---------------------------------------------------------------- 握手状态

function readList (r, fn) {
  const n = r.varint()
  const out = []
  for (let i = 0; i < n; i++) out.push(fn(r))
  return out
}

/**
 * 解析 Forge 的 `ForgeRegistry.Snapshot` 负载。
 *
 * 格式（核对 1.20.x 源码 `ForgeRegistry.Snapshot#getPacketData` 后确认，**不是**猜的）：
 *   ids:       writeMap        → varint 计数 + N × (ResourceLocation, varint)
 *   aliases:   writeMap        → varint 计数 + N × (ResourceLocation, ResourceLocation)
 *   overrides: writeMap        → varint 计数 + N × (ResourceLocation, UTF)
 *   blocked:   writeCollection → varint 计数 + N × varint
 *
 * ⚠️ 同一个类的 **NBT 版本用的是 putInt**，跟这个网络版本不一样，别照 NBT 写。
 * ⚠️ `writeResourceLocation` 就是 `writeUtf(toString())` = varint 长度 + UTF-8，
 *    和 `Reader.str()` 完全同构，所以这里能直接复用。
 *
 * 这一步的意义：如果服务端真的把 `minecraft:block` 快照发过来了，
 * 那 `ids` 就是**服务端那份完整的「方块名 → 注册表 id」表** ——
 * 470 个模组的方块全在里面。这正是"我们到底能不能拿到方块信息"的判据。
 */
function parseSnapshot (r) {
  const ids = new Map()
  const n1 = r.varint()
  for (let i = 0; i < n1; i++) { const k = r.str(); ids.set(k, r.varint()) }

  const n2 = r.varint()
  for (let i = 0; i < n2; i++) { r.str(); r.str() }

  const n3 = r.varint()
  for (let i = 0; i < n3; i++) { r.str(); r.str() }

  const n4 = r.varint()
  for (let i = 0; i < n4; i++) r.varint()

  return { ids, aliasCount: n2, overrideCount: n3, blockedCount: n4 }
}

function createHandshake (log = () => {}, onSnapshot = null) {
  const state = {
    mods: null,
    channels: null,
    registries: null,
    dataPackRegistries: null,
    registryCount: 0,
    // 每个 S2CRegistry 的摘要（名字 / 有没有快照 / 多少字节 / 解析出多少条）
    registrySnapshots: [],
    // 只留我们真正关心的两张表，避免把 37 张全塞内存
    blockRegistry: null, // { name, entries: [[名字, id], …] }
    itemRegistry: null,
    acked: 0,
    done: false,
    mismatch: null
  }

  /**
   * 处理一个内层包，返回要发回的内层字节（null = 不回）。
   * 注意：服务端 sentMessages 靠 transactionId 回执清空，该回的必须回。
   */
  function handle (inner) {
    const r = new Reader(inner)
    const id = r.u8()

    switch (id) {
      case ID.S2C_MOD_LIST: {
        // HandshakeMessages.S2CModList
        state.mods = readList(r, rr => rr.str())
        state.channels = readList(r, rr => [rr.str(), rr.str()])
        state.registries = readList(r, rr => rr.str())
        state.dataPackRegistries = readList(r, rr => rr.str())
        log(`[fml] S2CModList: ${state.mods.length} mods, ${state.channels.length} channels, ${state.registries.length} registries`)
        log(`[fml] mods = ${state.mods.slice(0, 12).join(', ')}${state.mods.length > 12 ? ' …' : ''}`)
        // ⚠️ 这里必须把 37 个注册表**全**列出来。之前只打了 5 条，
        //    结果"minecraft:block 到底在不在里面"这个问题悬了一整轮。
        //    列表本身很短，全打出来成本为零，信息量却是决定性的。
        log(`[fml] 注册表清单（服务端声明会同步的 ${state.registries.length} 个）：${state.registries.join(', ')}`)
        {
          const hasBlock = state.registries.includes('minecraft:block')
          log(`[fml] ▶ 其中包含 minecraft:block 吗？ ${hasBlock ? 'YES —— 方块名有可能从网络上直接拿到' : 'NO —— 方块名拿不到，必须走别的路'}`)
        }

        // C2SModListReply：原样回显 mod 列表与通道表（通道表回显即可通过服务端 validateServerChannels），
        // 注册表哈希表留空（Forge 客户端本身也是空表，见 C2SModListReply 构造里的 TODO）
        const out = [wU8(ID.C2S_MOD_LIST_REPLY)]
        out.push(wVarint(state.mods.length))
        for (const m of state.mods) out.push(wStr(m))
        out.push(wVarint(state.channels.length))
        for (const [k, v] of state.channels) { out.push(wStr(k)); out.push(wStr(v)) }
        out.push(wVarint(0)) // registries 映射为空
        return Buffer.concat(out)
      }

      case ID.S2C_REGISTRY: {
        // HandshakeMessages.S2CRegistry: [ResourceLocation][bool][可选快照字节]
        //
        // 1.5.x 之前这里只读了名字和 bool，然后把快照字节**原样跳过丢掉**——
        // 那是"她认不出方块"这件事上我犯过的最贵的一次错：数据一直在手上，
        // 我们只是把它扔了。现在改成真解析。
        const name = r.str()
        const hasSnapshot = r.u8() !== 0
        const info = { name, hasSnapshot, bytes: 0 }
        if (hasSnapshot) {
          const rest = r.remaining()
          const raw = r.bytes(rest)
          info.bytes = raw.length
          try {
            const rr = new Reader(raw)
            const snap = parseSnapshot(rr)
            info.entryCount = snap.ids.size
            info.aliasCount = snap.aliasCount
            info.overrideCount = snap.overrideCount
            info.blockedCount = snap.blockedCount
            // ⚠️ 必须读**解析时那个** Reader 的 remaining —— 新建一个 Reader
            //    拿到的是整段长度，会把"没吃完"永远判成"没吃完"。
            info.leftoverBytes = rr.remaining()
            // 解析后剩余必须是 0，否则说明格式假设错了 —— 当场暴露，别悄悄吞掉
            info.consumedExactly = info.leftoverBytes === 0
            const entries = [...snap.ids.entries()]
            if (name === 'minecraft:block') state.blockRegistry = { name, entries }
            else if (name === 'minecraft:item') state.itemRegistry = { name, entries }
            if (onSnapshot) { try { onSnapshot(name, entries, info) } catch (e) { log(`[fml] onSnapshot 回调出错: ${e.message}`) } }
          } catch (e) {
            info.parseError = e.message
          }
        }
        state.registrySnapshots.push(info)
        state.registryCount++
        state.acked++
        log(`[fml] S2CRegistry #${state.registryCount}: ${name}`
          + (hasSnapshot
            ? ` snapshot=${info.bytes}B`
              + (info.entryCount !== undefined
                ? ` → 解析出 ${info.entryCount} 条${info.consumedExactly ? '' : `（⚠ 剩 ${info.leftoverBytes}B 没吃完，格式假设有问题）`}`
                : ` → ⚠ 解析失败: ${info.parseError}`)
            : ' (无快照)'))
        return wU8(ID.C2S_ACKNOWLEDGE)
      }

      case ID.S2C_CONFIG_DATA: {
        // HandshakeMessages.S2CConfigData: [UTF 文件名][varint 长度 + 字节]
        const fileName = r.str()
        const n = r.varint()
        r.bytes(n)
        state.acked++
        log(`[fml] S2CConfigData: ${fileName} (${n} bytes)`)
        return wU8(ID.C2S_ACKNOWLEDGE)
      }

      case ID.S2C_MOD_DATA: {
        // HandshakeMessages.S2CModData: map<modId -> [name, version]>，注册时标了 noResponse
        const n = r.varint()
        for (let i = 0; i < n; i++) { r.str(); r.str(); r.str() }
        log(`[fml] S2CModData: ${n} entries`)
        return null
      }

      case ID.S2C_CHANNEL_MISMATCH: {
        const n = r.varint()
        const bad = []
        for (let i = 0; i < n; i++) bad.push(`${r.str()}=${r.str()}`)
        state.mismatch = bad
        log(`[fml] S2CChannelMismatchData: ${bad.join(', ')}`)
        return null
      }

      default:
        log(`[fml] 未知握手包 ID ${id}（忽略）`)
        return null
    }
  }

  return { state, handle }
}

// ---------------------------------------------------------------- 挂到 nmp 客户端

/**
 * 把 FML 握手挂到一个 minecraft-protocol 客户端上。
 * 必须在客户端进入 LOGIN 状态前调用，并移除 nmp 自带的
 * “回一个空 login_plugin_response（表示没看懂）”的默认监听。
 */
function attach (client, { log = console.log, onSnapshot = null } = {}) {
  const hs = createHandshake(log, onSnapshot)

  // nmp 的 src/client/pluginChannels.js 会先注册一个自动回空响应的监听，
  // 那个响应会让 Forge 服务端认为客户端不懂 FML，握手卡死 → 先摘掉它。
  client.removeAllListeners('login_plugin_request')

  client.on('login_plugin_request', (packet) => {
    // 不是 Forge 的包装通道 → 按原版行为回“没看懂”
    if (packet.channel !== WRAPPER_CHANNEL) {
      log(`[fml] 非 Forge 登录插件请求 channel=${packet.channel}，按原版回空`)
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    let target, inner
    try {
      ({ target, inner } = unwrap(packet.data))
    } catch (e) {
      log(`[fml] 拆外层失败: ${e.message}`)
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    // ---- 分支 A：Forge 自己的握手通道 ----
    if (target === HANDSHAKE_CHANNEL) {
      let reply
      try {
        reply = hs.handle(inner)
      } catch (e) {
        log(`[fml] 处理握手包失败: ${e.message}`)
        client.write('login_plugin_response', { messageId: packet.messageId })
        return
      }
      if (reply) {
        client.write('login_plugin_response', { messageId: packet.messageId, data: wrap(target, reply) })
      } else {
        // 该包标了 noResponse（如 S2CModData），回空即可
        client.write('login_plugin_response', { messageId: packet.messageId })
      }
      return
    }

    // ---- 分支 B：mod 自注册的登录通道 ----
    // 诊断用开关：FML_SKIP=<channel1,channel2> 时对这些通道完全不回包
    const skip = String(process.env.FML_SKIP || '').split(',').map(s => s.trim()).filter(Boolean)
    const head = inner.length ? inner.subarray(0, 8).toString('hex') : '(空)'
    if (skip.includes(target)) {
      log(`[fml] mod 登录通道 ${target} index=${packet.messageId} inner=${head} → 按 FML_SKIP 不回包`)
      return
    }

    const rule = MOD_LOGIN_REPLIES[target]
    if (rule) {
      let modReply
      try {
        modReply = typeof rule === 'function' ? rule(inner) : rule
      } catch (e) {
        log(`[fml] mod 登录通道 ${target} 应答构造失败: ${e.message} → 回空包`)
        client.write('login_plugin_response', { messageId: packet.messageId })
        return
      }
      log(`[fml] mod 登录通道 ${target} index=${packet.messageId} inner=${head}(${inner.length}B) → 回执 ${modReply.toString('hex')}`)
      client.write('login_plugin_response', { messageId: packet.messageId, data: wrap(target, modReply) })
      return
    }

    // ---- 分支 C：未知通道 ----
    // 回空只对 noResponse 通道安全。若这里出现断线（unexpected_query_response），
    // 说明该通道在等回执，需要照上面 tacz / zeta 的做法补表。
    log(`[fml] ⚠ 未知 mod 登录通道 ${target} index=${packet.messageId} inner=${head}(${inner.length}B) → 回空包；若断线需补表`)
    client.write('login_plugin_response', { messageId: packet.messageId })
  })

  return hs
}

module.exports = {
  attach,
  createHandshake,
  unwrap,
  wrap,
  parseSnapshot,
  // 导出 Reader 是为了让测试**用真的读字节器**。
  // 教训：契约测试里自己另写一个简化版 Reader，会把"越界抛错"这类行为悄悄测掉 ——
  // 替身比实现宽松，测试就变成自证。已经栽过四次，不再自建。
  Reader,
  ID,
  WRAPPER_CHANNEL,
  HANDSHAKE_CHANNEL
}
