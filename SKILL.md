---
name: minecraft-bridge
description: >
  Local HTTP bridge for Mineflayer-based live control of a Minecraft Java bot —
  including Forge/FML modded servers. Trigger when the user wants to connect a bot
  to their world/server, check bot status/inventory/position, or make the bot move,
  mine, craft, follow, fight, or chat in-game. Also carries a knowledge base for the
  modpack (quest book, item names, mods, tips) so the bot can answer game questions.
  Examples: 'connect to my server', 'start the minecraft bot', 'what is in my
  inventory', 'go mine iron', 'craft a pickaxe', 'follow me', 'come play minecraft
  with me', 'what should I do next in this modpack', 'is the bridge running'.
  Also use when another minecraft-* skill needs live game data. Do NOT trigger for
  Minecraft knowledge questions (use minecraft-wiki) or server administration via
  RCON / server.properties (use minecraft-server-admin).
version: 1.1.0
metadata:
  emoji: "🎮"
  identity: "Angel_ICE"
  persona: "PERSONA.md"
  requires:
    bins:
      - node
  install:
    - id: mineflayer
      kind: node
      package: mineflayer
      label: "Mineflayer — Minecraft bot API"
    - id: mineflayer-pathfinder
      kind: node
      package: mineflayer-pathfinder
      label: "Pathfinder — navigation plugin"
    - id: vec3
      kind: node
      package: vec3
      label: "Vec3 — 3D coordinate helper"
---

# Minecraft Bridge

Persistent local HTTP service that bridges **any agent** to a live Minecraft Java
Edition bot session. Exposes a REST API on `http://127.0.0.1:${MC_BRIDGE_PORT|3001}`
for live state reads and in-game bot actions.

Runs standalone (`node bridge-server.js`) — it is not tied to any particular agent
runtime. Configuration lives in `config.json` next to this file, overridable by
environment variables, so the same skill works unchanged from any agent.

**Boundary**:
- Use this skill for **live bot control** and **live game-state reads**
- Use `minecraft-wiki` for knowledge questions
- Use `minecraft-server-admin` for RCON, server.properties, whitelist/ban/op

---

## 她是 Angel_ICE（先读这个）

**这个 bot 不是一个工具，是一个有独立人格的陪玩助手。**

在任何 agent 里，只要你要替她说话、替她做事，**先读 `PERSONA.md`**，
然后照她的样子说话：卖萌、装可爱、有情绪、有记忆。

- **固定身份**：游戏内 ID 永远是 `Angel_ICE`
- **人格文件**：`PERSONA.md` ← 语气、性格、说话方式全在这里
- **她的记忆**：`memory/journal.md` + `memory/state.json`

### 记忆机制（她不会忘记）

记忆写在磁盘上，跨会话、跨 agent、跨重启都在。

```bash
# 说话之前：先读记忆 + 当前状态
curl --noproxy '*' "http://127.0.0.1:3001/memory?limit=40"

# 有事发生：记一笔（第一人称，用她的语气）
curl --noproxy '*' -X POST http://127.0.0.1:3001/memory \
  -H 'Content-Type: application/json' \
  -d '{"text":"和你说好下次一起去看日落","type":"promise"}'
```

桥会自动记：上线下线、死亡重生、玩家进出、聊天、掉血、每 30 秒状态快照。
她需要**主动**记：约定、计划、重要发现、心情、玩家说过的话。

> 完整人格规则、语气示例、该记什么不该记什么 → 见 **`PERSONA.md`**。

---

## 游戏知识库（她懂这个整合包）

**`knowledge/` 目录是当前所连整合包的知识库。**
回答任何游戏内问题之前先查这里 —— 这样她就不会问玩家"这是什么""怎么玩"这种基础问题。

内容来自整合包本体（任务书 SNBT、模组 jar、kubejs 脚本），不是网上抄的：

| 文件 | 内容 |
|---|---|
| `pack-overview.md` | **整合包总览 + 核心机制**（键位、Boss 料理循环、经济、七咒之戒、次元之胃…）**必读** |
| `main-quest.md` | 主线任务路线图（按依赖排序，含每个任务的说明与奖励） |
| `chapters.md` | 61 章全部任务标题（快速定位） |
| `tooltips.md` | 作者写在物品上的提示（怎么获得、怎么用） |
| `mods.md` | 467 个模组清单 |
| `quests.json` | 全量结构化任务数据（3878 个任务） |
| `item-names.json` | 33189 条物品中英对照 |
| `lookup.py` | 查询脚本 |

### 怎么查

**方式一：HTTP（推荐，任何 agent 都能用）**

```bash
# 知识库有哪些文件
curl --noproxy '*' http://127.0.0.1:3001/knowledge

# 搜任务（标题/说明/需求物品）—— 中文关键词必须交给 curl 编码
curl --noproxy '*' -G --data-urlencode "type=quest" --data-urlencode "q=末影龙" \
     "http://127.0.0.1:3001/knowledge/search"

# 物品名 → modid:item（或反过来）
curl --noproxy '*' -G --data-urlencode "type=item" --data-urlencode "q=棱彩解药桶" \
     "http://127.0.0.1:3001/knowledge/search"

# 找章节
curl --noproxy '*' -G --data-urlencode "type=chapter" --data-urlencode "q=蜜蜂" \
     "http://127.0.0.1:3001/knowledge/search"

# 读某个文件（type=raw，纯 ASCII，直接拼就行）
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=raw&file=pack-overview.md"
```

关键词含中文时也可以走 POST，把内容放进 JSON body，完全不用操心编码：

```bash
curl --noproxy '*' -X POST -H "Content-Type: application/json" \
     -d '{"type":"quest","q":"七咒之戒"}' "http://127.0.0.1:3001/knowledge/search"
```

> ⚠️ **别把中文直接拼进 URL**（`?q=七咒之戒`）。请求行里的非 ASCII 字节会被 Node 判成
> `400 Bad Request`，返回体是空的 —— 看起来就像"知识库里没有"，其实根本没查。

`type` 取值：`quest` | `item` | `chapter` | `tip` | `mod` | `raw`
（`/knowledge` 与 `/knowledge/search` 在机器人离线时也能用）

**方式二：直接跑脚本**

```bash
cd knowledge
python lookup.py quest 末影龙
python lookup.py item terramity:      # 某模组的全部物品
python lookup.py main                # 打印主线顺序
python lookup.py stats
```

### 硬性规则

1. **回答游戏问题前先查知识库。** 尤其是"怎么获得""有什么用""我该做什么"。
2. **不要问玩家基础问题。** 键位、Boss 料理循环、经济系统、七咒之戒、次元之胃
   都在 `pack-overview.md` 里，是常识。
3. **查不到就说"我不太确定"**，不要编造。可以说"你在 JEI 里按 R 看看？"
4. **不要按原版/原模组攻略回答。** 这个包魔改极多（删了大量配方、作物来源统一、
   Alex 洞穴拆成六维度、Boss 线改成做菜），原版攻略经常是错的。

---

## Quick State Machine

```
UNSTARTED → run bridge-server.js → STARTING → bot spawns → CONNECTED
CONNECTED → game closes or kick → DISCONNECTED → auto-reconnect → CONNECTED
```

Check current state with: `GET http://127.0.0.1:3001/status`

---

## Setup (first time)

### 1. Configuration — `config.json`

Copy the template and edit it:

```bash
cp config.example.json config.json
```

```json
{
  "MC_HOST": "127.0.0.1",
  "MC_PORT": "25565",
  "MC_BOT_USERNAME": "Angel_ICE",
  "MC_VERSION": "1.20.1",
  "MC_AUTH": "offline",
  "MC_FORGE": "1",
  "MC_BRIDGE_PORT": "3001"
}
```

**Precedence: environment variable > `config.json` > built-in default.**
So you can override any value for a single run without touching the file.

| Key | Meaning | Default |
|---|---|---|
| `MC_HOST` | server address | `localhost` |
| `MC_PORT` | game port | `25565` |
| `MC_BOT_USERNAME` | bot's in-game name | `Angel_ICE` |
| `MC_BRIDGE_PORT` | local HTTP port | `3001` |
| `MC_VERSION` | Minecraft version string | `1.21.1` |
| `MC_AUTH` | `offline` or `microsoft` | `offline` |
| `MC_FORGE` | `1` enables the FML login handshake | `0` |
| `MC_PACK_DIR` | modpack version dir — where to find the client-exported `angel_block_palette.txt` | *(empty)* |
| `MC_CLIMBABLE_BLOCK_NAME` | **preferred** way to declare a non-vanilla ladder, by block name (e.g. `create:ladder`) | *(empty)* |
| `MC_CLIMBABLE_STATE_IDS` | same, by state ID. **Only trustworthy for vanilla blocks.** | *(empty)* |
| `MC_PALETTE_ANCHORS` | `blockId=stateId,…` F3-measured anchors that pin the *modded* range's cumulative offset | *(empty ⇒ 2 built-in)* |
| `MC_UNKNOWN_BLOCK_SOLID` | `false` disables "unmapped block ⇒ solid" | `true` |
| `MC_PASSABLE_STATE_IDS` | extra state IDs treated as passable (decoration only, never doors) | *(empty)* |
| `MC_PROBE_PACKETS` | `1` attaches the packet-stats probe (diagnostics only) | `0` |

> ⚠️ **Both `MC_CLIMBABLE_*` should normally stay empty.** On a modded server the vanilla
> block IDs are **not** displaced (measured: 1003/1003 identical), so `minecraft:ladder`
> is still id `196` and both the physics and pathfinding layers already recognise it.
> Configure them only when you have **evidence** of a non-vanilla ladder. See
> "Block perception & the ladder" below.

Verify what's actually in effect at any time:

```bash
curl --noproxy '*' http://127.0.0.1:3001/config
```

### 2. Install dependencies (once)

```bash
cd <this skill dir> && npm install mineflayer mineflayer-pathfinder vec3
```

### 3. Start the bridge

```bash
node bridge-server.js
```

Or the wrapper (handles background + logging):

```bash
bash scripts/start.sh
```

Wait for the banner showing identity, API address, and Forge status.

### 4. Verify

```bash
curl --noproxy '*' http://127.0.0.1:3001/status
```

> **Windows / sandbox note**: if `curl` to `127.0.0.1` fails with
> `upstream connect failed` / `os error 10061`, a proxy is intercepting localhost.
> Add `--noproxy '*'` to every curl call.

---

## Forge / Modded Servers (`MC_FORGE=1`)

Vanilla-protocol clients (mineflayer / node-minecraft-protocol) are **rejected outright**
by a Forge server:

```
Bot kicked: "This server has mods that require Forge to be installed on the client."
```

To get in, the client must speak the **FML login handshake**. This skill ships an
implementation in `fml-handshake.js`; enable it with one config key:

```json
{ "MC_FORGE": "1" }
```

or per-run:

```bash
MC_FORGE=1 node bridge-server.js
```

When `MC_FORGE=1`, `bridge-server.js` monkey-patches `nmp.createClient` to
(a) append the `\0FML3` marker to the handshake host and (b) attach the handshake
handler. Nothing else changes.

**What the handshake does**

1. `S2CModList` → echo the mod list + channel table back as `C2SModListReply`
2. every `S2CRegistry` → `C2SAcknowledge`
3. every `S2CConfigData` → `C2SAcknowledge`
4. `S2CModData` → no reply (registered `noResponse`)
5. **each mod's own login channel** → channel-specific reply (see below)

**The one rule that matters**

> If the server sends a login packet on channel X and the reply is not marked
> `packetHandled`, the server disconnects **immediately** with
> `multiplayer.disconnect.unexpected_query_response`.

`IndexedMessageCodec.consume()` marks a packet handled only when:
- the payload is **empty** *and* the packet was registered with `noResponse()`, or
- the payload is **non-empty**, its first byte is a discriminator present in the
  server-side codec table, and the direction check passes.

So an empty reply is only safe for `noResponse()` channels. For everything else you
must send the correct C2S discriminator. **An empty reply that gets you kicked is
itself the diagnostic**: it names the channel that needs a real answer.

**Per-mod reply table** (`MOD_LOGIN_REPLIES` in `fml-handshake.js`):

| Channel | needsResponse | Reply |
|---|---|---|
| `tacz:handshake` | yes | `01` (Acknowledge) |
| `zeta:main` | yes | `63` + echo of `inner[1..]` (C2SLoginFlag) |
| `tacztweaks:handshake` | no | empty |
| `fzzy_config:config_sync_s2c` | no | empty |

**Auditing a new modpack** — don't discover channels one kick at a time:

```bash
python scripts/scan-login-channels.py "<mods-dir>" login-scan.txt
```

Then reverse the hits with `javap -p -c -constants` and extend `MOD_LOGIN_REPLIES`.

**Diagnostics**

- `FML_SKIP=chan1,chan2` — suppress replies for the listed channels (bisecting)
- every mod-channel packet is logged with its index, inner hex, and length

See `references/forge-fml-handshake.md` for the full wire format, the reverse-engineering
method, and the per-mod derivation.

---

## Block perception & the ladder (read this before "fixing" either)

This section exists because two consecutive sessions got it **wrong**, in a way that
looked like success. Both errors are recorded here so they don't get re-derived.

### The question that started it

> "We can obviously get block info — look at my screen. Why can't you?"

**Answer: we can, and the data was arriving all along — we were discarding it.**
Since 1.13 the server sends only **numeric global-palette state IDs** in `chunk_data`;
names are resolved from a **client-local registry**. The real client has the 516 mods, so
it resolves `upgrade_aquatic:glass_trapdoor`. A `minecraft-data`-only client can't, so
every modded block resolved to `name=''`.

But Forge pushes the whole registry during the FML login handshake — `S2CRegistry`
packets carry a `ForgeRegistry.Snapshot`. `fml-handshake.js` was reading the registry
*name*, then **skipping the snapshot bytes and throwing them away**. Measured on this
pack: **20217 blocks** in `minecraft:block`, **30729** in `minecraft:item`.

```bash
curl --noproxy '*' http://127.0.0.1:3001/debug/registries
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=ladder&limit=6'
```

The facts that make everything else easier:

* **Vanilla block registry IDs stay aligned, but vanilla state layout can expand.** Full
  comparison: **1003/1003 ids identical, zero differences**. This pack nevertheless
  expands 31 vanilla blocks; the vanilla tail is `25019`, not the baseline `24135`.
* ⚠️ `stateId` is **not** `blockId`. The safe formula is the prefix sum of state counts in
  Forge S2C block-registry-id order. KubeJS `entrySet()` order is not that order (this pack
  has measured +3-style offsets), so the converter maps names back through the local
  `registry/minecraft-block.json` before sorting. Per-block state counts live in mod **code**
  (`createBlockStateDefinition`), not in jar data; the running client dump is the exact source.

### 🔴 KubeJS dump script: four rules (all verified against the jars with `javap`)

`registry/zz_angel_dump_block_palette.js` is the client-side dump. **Getting it wrong
breaks the player's client** — `common.properties` has `startupErrorGUI=true`, so any
startup-script error pops a blocking KubeJS error screen. Three earlier versions did
exactly that. Rules, each backed by bytecode:

| Rule | Why |
|---|---|
| **Never write `const`** — use `let` | Rhino's `Interpreter.doSetConstVar` throws `msg.var.redecl` ("redeclaration of var X") at runtime. Every *working* script in this pack (`effect.js`, `vefcblocks.js`, `vefcfoods.js`) uses **`let` and zero `const`**; the failing version used `const`. |
| **Wrap the *entire* function body in `try`** | A `const OUT_NAME = …` placed *outside* the `try` becomes an uncaught startup error → error screen. Nothing may sit outside the guard. |
| **Only `console.info`, never `console.error`** | KubeJS counts error-level log lines as script errors → same GUI. A broken diagnostic must degrade to one INFO line. |
| **Don't call `Java.loadClass`** | `JavaWrapper` only has `loadClass / tryLoadClass / createConsole` — **there is no `Java.from`**. And `const X = Java.loadClass('…X')` is the exact construct that trips rule 1. Use the KubeJS bindings instead: `Utils.getRegistry(Utils.id('minecraft','block'))` → `RegistryInfo.entrySet()`. |

**Bindings that actually exist** (complete list from `BuiltinKubeJSPlugin.registerBindings`):
`global, Platform, console, JavaMath, ResourceLocation, Duration, settings, onEvent, java,
setTimeout, clearTimeout, setInterval, clearInterval, KMath, Utils, Java, Text, Component,
UUID, JsonIO, Block, Blocks, Item, Items, Ingredient, IngredientHelper, NBT, NBTIO,
Direction, Facing, AABB, Stats, FluidAmounts, Notification, InputItem, OutputItem, Fluid,
SECOND, MINUTE, HOUR, Color, BlockStatePredicate, Vec3d, Vec3i, Vec3f, Vec4f, Matrix3f,
Matrix4f, Quaternionf, RotationAxis, BlockPos, DamageSource, SoundType, BlockProperties`
+ every event group.

⚠️ **`BuiltInRegistries` is NOT in that list.** A version assumed it was pre-bound and
referenced it directly — that is a `ReferenceError`, so the dump silently produced nothing.

**Readable method names are safe**: KubeJS's Rhino remaps members via `mm.jsmappings`
(gzip, 781 KB, inside `rhino-forge-*.jar`). Confirmed present: `getStateDefinition`
(`m_49958_`), `getPossibleStates` (`m_61092_`), `getProperties`, `getPossibleValues`
(`m_6908_`), `getName` (`m_6940_`), `entrySet` (`m_6579_`), `location` (`m_135782_`).

The dump deliberately **does not emit base state IDs** — only `count|name|propSpec` per
block. `firstStateId` is computed after mapping the name to the Forge S2C block registry id,
sorting by that id, and taking the prefix sum. The converter checks the local vanilla baseline,
allows only non-decreasing vanilla state counts with cumulative drift, then checks F3 anchors.
That removes any dependency on a state-ID API (`Block.BLOCK_STATE_REGISTRY` is private;
`BlockWrapper.getId` returns a `ResourceLocation`, not a numeric state ID).

### ❌ Retraction: the "ladder is stateId 5337" fix was a self-fulfilling prophecy

An earlier session concluded "the real ladder is `stateId 5337`, which lands on
`crimson_hanging_sign` (id 215), so set `blocksByName.ladder.id = 215`". She then
"climbed". **Both halves were wrong, and the assertions all passed** because the tests
faithfully reproduced the fiction.

Verified three independent ways:

```bash
# 1) directly on the library
node -e "const m=require('minecraft-data')('1.20.1');console.log(m.blocksByStateId[5337].name, m.blocksByStateId[5337].id)"
#    → crimson_hanging_sign 215        (not a ladder)

# 2) the vanilla ladder range
node -e "const b=require('minecraft-data')('1.20.1').blocksByName.ladder;console.log(b.id,b.minStateId,b.maxStateId)"
#    → 196 4654 4661

# 3) through the palette (after importing registry/vanilla-palette-1.20.1.txt)
curl --noproxy '*' 'http://127.0.0.1:3001/palette/state?id=5337'
#    → minecraft:crimson_hanging_sign | attached=false,rotation=11,waterlogged=false
```

`5337` is a *vanilla* block, and vanilla IDs aren't displaced — so it can't be the ladder.
The "fix" changed a **correct** value (196) into a wrong one; the physics engine climbed
because we told it that spot was a ladder.

**The mechanism, pinned down** (both layers key on `block.type` = block registry id,
**not** stateId):

| Layer | Where | Reads |
|---|---|---|
| physics | `prismarine-physics/index.js:35` → `:442` | `block.type === blocksByName.ladder.id` |
| pathfinding | `mineflayer-pathfinder/lib/movements.js:64` → `:232` | `climbables.has(block.type)` |

Both capture the ID **at construction time**, from the **same shared registry object**
(`minecraft-data(...).blocksByName === prismarine-registry(...).blocksByName`).

⇒ **A vanilla ladder already works with zero configuration.** `MC_CLIMBABLE_*` empty is
the correct default, not a fallback.

### If there *is* a non-vanilla ladder — the name route

This pack has **32 ladder-type blocks**; Quark alone adds 14 wood variants
(`quark:spruce_ladder` = 18811, …). A player-built house ladder is quite likely one of
them, and then `block.type ≠ 196` and both layers fail.

Fix it **by name**, which does not go through `stateId` at all:

```bash
# 1) ask the player to look at the ladder and read F3 → e.g. quark:spruce_ladder
# 2) resolve the id from the server's own snapshot
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=spruce_ladder'
# 3) declare it
#    config.json:  "MC_CLIMBABLE_BLOCK_NAME": "quark:spruce_ladder"
```

* The name→id table is read from `registry/minecraft-block.json` **at startup** — needed
  because the fix must run *before* `createBot()`, while the snapshot only arrives
  *during* login.
* ⚠️ **The physics layer has exactly one slot** (`blocksByName.ladder.id` is one number).
  Extra names only reach the pathfinder's `climbables` set. So "can actually go up" holds
  for the one selected ladder.
* `MC_CLIMBABLE_STATE_IDS` is the fallback and is **only trustworthy for vanilla blocks** —
  a modded state looked up in the vanilla table returns whichever vanilla block happens to
  own that number. That is precisely the 5337 mistake.

### ⭐ The root fix: the palette must be written **into the registry**

This is the part that was missing for a whole session, and it explains why "the name route"
above **cannot work on its own**.

Read `prismarine-block/index.js:125`:

```js
const blockEnum = registry.blocksByStateId[this.stateId]
if (blockEnum) { this.type = blockEnum.id; this.name = blockEnum.name; /* … */ }
else          { this.name = ''; this.shapes = []; this.boundingBox = 'empty' }
//              ⚠️ the else branch does NOT overwrite this.type — and 1.13+'s
//                 Block.fromStateId(stateId, biome) calls new Block(undefined, …),
//                 so this.type stays **undefined**.
```

⇒ **For any state the registry doesn't know, `b.type` is `undefined`.** Consequences:

1. **Both ladder layers key on `block.type`.** So configuring
   `MC_CLIMBABLE_BLOCK_NAME=quark:spruce_ladder` only rewrites the *number*
   `blocksByName.ladder.id`; the comparison `undefined === 18811` still never holds.
   **No ladder configuration can work until the palette is in the registry.**
2. `b.name` is `''`, so she can't name what she's looking at — the player's original
   complaint.

So the palette is not a nice-to-have lookup table; it is the **root dependency**.
`palette-registry.js` writes it back:

```js
paletteRegistry.injectPalette(registry, index)
//  · blocksByStateId[state] = rec   for every state of every modded block
//  · blocks[rec.id] = rec           blocksByName[rec.name] = rec
//  · rec.states = [{name, num_values, values}]  → property decoding comes for FREE
//    (Block's constructor does the mixed-radix expansion itself)
```

Three properties worth knowing:

* **The real vanilla layout is overlaid.** `minecraft-data` remains the collision/behavior
  baseline, but the dump's `first/count/states` replace the old state ranges for all 1003
  vanilla ids. This is required when the pack expands a vanilla block; leaving states
  `0..24134` untouched would translate later map states to the wrong blocks.
* **Modded records are added too.** After the overlay, every modded state range is written
  into `blocksByStateId`, `blocks`, and `blocksByName`. In the current dump that is 19214
  modded blocks and 801485 modded states. Injected modded records deliberately omit
  authoritative collision boxes, so `pathing.needsShapeFallback` keeps them solid by default.
* **It works offline and is reversible.** `prismarine-registry` caches a per-version singleton;
  the bridge imports before connect, verifies the bot sees the same registry, and re-injects
  on spawn. The injector snapshots overwritten state slots and can restore them on replacement
  or test cleanup. Boolean-valued properties are coerced back to real `true`/`false` values.

And the interaction with the solid-block policy — **this is a real trap**:

> Injecting the palette makes `b.type` defined, so the old `isUnknownBlock` test
> (`type === undefined`) stops firing… and that patch also owns the **passable whitelist**
> (doors/trapdoors she opened herself). It would silently stop working.
>
> The test is now `pathing.needsShapeFallback(b)` = `b.type === undefined ||
> b.boundingBox === undefined` — i.e. "we don't have an authoritative collision box".
> Injected records **deliberately omit** `boundingBox`/`shapes`, and that omission is a
> **contract** with a self-test asserting it. Vanilla records all have one (0 missing out
> of 24135), so the test is clean on both sides.

Check it at any time:

```bash
curl --noproxy '*' http://127.0.0.1:3001/palette      # injectedIntoRegistry + registryIsSharedSingleton
curl --noproxy '*' http://127.0.0.1:3001/config       # top-level "palette" (visible while offline)
```

### Vanilla-range palette (no client dump needed)

```bash
node scripts/make-vanilla-palette.js            # → registry/vanilla-palette-1.20.1.txt
curl --noproxy '*' -X POST -H "Content-Type: application/json" \
  -d '{"file":"<abs path>/registry/vanilla-palette-1.20.1.txt"}' \
  http://127.0.0.1:3001/registry/import-palette
```

Exact and strictly contiguous for states `0..24134` (verified 0 gaps), so it passes the
import safety valve. It does **not** cover the modded range — returning `found: false`
there is honest, not a bug.

### Safety valve: a shifted table is worse than an unknown one

`POST /registry/import-palette` runs **three** gates and rejects the **whole** file on any
of them. Knowing *why three* matters, because two of them are not enough:

| # | Gate | What it catches |
|---|---|---|
| 1 | strict contiguity (`gaps === 0`) | a truncated or edited dump |
| 2 | vanilla-range cross-check | the dump disagrees with `minecraft-data` on names / base state / state count — also catches a mod that *shifted* the vanilla ranges |
| 3 | **F3 anchors** (`MC_PALETTE_ANCHORS`) | the **modded** range's cumulative offset being wrong |

Gate 1+2 alone are **demonstrably insufficient**, and there is a real file in this repo
that proves it: `registry/block-palette.json` (`extract_blockstates.py`, `verified: false`).
It is contiguous, complete, and its vanilla half is copied from `minecraft-data` — so it
**passes gates 1 and 2**. But the modded state counts were derived from mod-jar
`blockstates/*.json`, and MC lets `variants` keys omit properties as wildcards
(`glass_trapdoor` truly has 64 states, that file counts 16), so the running total drifts:

```
glass_trapdoor   table: base 239686   F3 truth: 522768   → off by 283082
ancient_codex    table: base 233076   F3 truth: 506805   → off by 273729
```

Reproduce the whole chain, including the exact rejection:

```bash
node scripts/palette-guard-test.js    # 12 assertions; shows gates 1+2 passing, gate 3 rejecting
```

Gate 2 needs one non-obvious detail: **the client dump writes `minecraft:air` while
`minecraft-data` uses the bare name `air`.** Without normalising the `minecraft:` prefix,
a *perfectly correct* dump is rejected with 1003 "mismatches". (That bug was caught by
exactly this guard test — the test earned its keep before it was even committed.)

Gate 3's anchors come from the player's F3 readout and are the only evidence that can pin
the *modded* range. They are independent: one anchor only proves the sum *up to that
block*. Add more via `MC_PALETTE_ANCHORS=14286=506805,15061=522768`.

A shifted table yields names that are *plausible but wrong* — much more dangerous than
"I don't know".

### Offline diagnostics

`/palette*`, `POST /registry/import-palette`, `/debug/registr*` and the knowledge
endpoints deliberately **bypass the "bot connected" precondition** — they only read local
files/memory. Requiring a live game to inspect why you can't connect is a circular
dependency. A 503 lists every offline-readable route in `offlineOk`.

### Two traps worth remembering

* **`GET` params come from the query string, not the body.** Writing
  `'GET /x': async ({ id }) => …` used to silently fall back to defaults (empty body →
  every destructure takes its default) — no error, just wrong answers. `/palette/state?id=`,
  `/palette/block?name=` and `/debug/registry?q=` were all dead this way, and `name`
  having a default masked the symptom. The dispatcher now merges the query into the first
  argument, and `node scripts/audit-get-params.js --strict` guards the convention.
* **"Port open" ≠ "service reachable".** The SSH tunnel to the server can accept a local
  TCP connection in 6 ms and still never forward it. A plain TCP connect test passes; a
  real Minecraft status ping hangs. Use it before blaming your own changes:

  ```bash
  node scripts/mc-ping.js      # ✗ 卡在「handshake」= 本地接受了连接，但远端没应答
  ```

---

## Item identity — the same root fix, applied to items

The palette fix above gives blocks their names back. **Items have an identical, independent
failure**, and for a whole session it was the reason she couldn't say what she was holding.

### The failure

`prismarine-item/index.js:36`:

```js
const itemEnum = registry.items[type]
if (itemEnum) { this.name = itemEnum.name; this.displayName = itemEnum.displayName; /* … */ }
else          { this.name = 'unknown'; this.displayName = 'unknown'; this.stackSize = 1 }
```

Any modded item is not in `minecraft-data`, so it takes the `else` branch and
**`i.name === 'unknown'`**. `GET /inventory` still reports the slot and the count, but the
name is the literal string `unknown` — neither she nor the caller can tell a lemon from a
sword.

The damage is wider than cosmetics. Every name-keyed item primitive resolves through
`registry.itemsByName`, so all of them go dead at once:

| Broken while items are unnamed | Why |
|---|---|
| `POST /drop` (by name) | looks the name up in the registry |
| `POST /collect` | matches `registry.items[itemId].name === itemName` → can never match |
| `POST /equip` | same lookup |
| `POST /craft` | ingredient matching is by name |
| `POST /place` | needs the held item's name to pick the block |

The case that exposed it: picking a `hanging_lemon` produced an inventory slot with
`type: 1284` and `name: "unknown"`. `POST /collect` answered
`No lemon on the ground nearby` **forever** — not because no lemon was there, but because
that comparison could never hold. Walking over the drop by hand was the only way to get it.

### The fix: `item-registry.js`

`registry/minecraft-item.json` is the server's own `name → registry id` snapshot for all
**30729 items**, captured during the same FML handshake as the block table and rewritten on
every login. `item-registry.js` writes it into `bot.registry` at the `inject_allowed` stage:

```js
itemRegistry.injectItems(bot.registry, itemRegistry.buildIndex(snapshot))
//  · registry.items[id] = rec   registry.itemsByName[name] = rec
//  · registry.itemsArray[id] = rec
```

`GET /inventory` now carries the raw numeric **`type`** on every entry, and `GET /item`
reverses it:

```bash
curl --noproxy '*' 'http://127.0.0.1:3001/item?id=1284'                     # -> bountifulfares:lemon
curl --noproxy '*' 'http://127.0.0.1:3001/item?name=bountifulfares:lemon'   # -> id 1284
curl --noproxy '*' 'http://127.0.0.1:3001/item?name=stone'                  # bare name -> minecraft:stone
curl --noproxy '*' 'http://127.0.0.1:3001/item'                             # overview + liveRegistryProbe
```

### ⚠️ Items are **deliberately** simpler than blocks — do not "unify" them

The two injectors look alike. **Five of their rules differ on purpose.** Someone tidying
this up by making items behave like blocks would break them:

| Aspect | Blocks (`palette-registry.js`) | Items (`item-registry.js`) |
|---|---|---|
| Key | `stateId`, with a property dimension | registry id, **no property dimension** |
| Where the id comes from | must be **computed** — prefix sum over state counts | **given directly** by the snapshot |
| Anchors | F3 anchors required to pin the modded range | **none needed** |
| Contiguity | **hard gate** — `gaps === 0` or reject the whole file | **gaps allowed** — reported, not fatal |
| On injection failure | kick the bot | **never kick** |

Why items tolerate gaps: blocks need strict contiguity because their `first` state is
*derived* by prefix sum, so one missing state silently shifts every later block — a
plausible-but-wrong table, which is the worst possible outcome. An item's id is **handed
over by the snapshot**, so a missing id cannot displace anything else. The live snapshot has
exactly **two** gaps (`16961` and `28651` absent) and they are harmless.

Why items never kick: a wrong item name costs you "she can't name what she's holding". A
dropped connection costs you the session. **Wrong-but-present beats absent.**

Also deliberate, to keep the record honest:

* **`maxDurability` is left unset** — the snapshot doesn't carry it, and inventing a number
  would make tool-wear logic silently wrong.
* **`stackSize` is a flat 64** — a guess, but a visible one; the field only drives
  merge/split decisions.
* **`displayName` is the full `modid:item` name**, never a prettified label — do not
  fabricate a friendly name.
* Injected records carry **`angelInjected: true`** so they stay distinguishable from real
  vanilla entries.

### The boundary must be read from the *pre-injection* baseline

This is the one bug that will bite anyone re-reading the code:

```js
const base = lastInjection?.baseVanillaIds || localItemIds(registry)
```

Do **not** recompute the boundary from `registry.items` on a second pass. After the first
injection the registry also holds 29474 modded items, so a fresh count lands at 30731 —
modded items then get checked as if they were vanilla and the whole table fails. The
baseline is snapshotted before the first write for exactly this reason.

### What was verified

Vanilla prefix check: **1255/1255, zero differences** — `minecraft-data`'s 1255 vanilla
items (ids `0..1254`) match the server snapshot exactly, so the boundary is trustworthy.
Then **29474** modded items from id `1255` up.

```
[items] 物品快照已载入：30729 条；id 0..30730，断点 2 处
[items] bot.registry 注入成功：29474 个模组物品（原版前缀核对 1255/1255，断点 2 处）
```

Writing a table is not the same as the running bot seeing it, so the endpoint probes the
**live** registry with the snapshot's first modded item:

```json
"liveRegistryProbe": {
  "id": 1255,
  "snapshotName": "ordertocook:order_machine",
  "resolvedInLiveRegistry": "ordertocook:order_machine",
  "byNameIndexed": true
}
```

`node item-registry.js --selftest` runs 54 assertions — a real on-disk snapshot read, an
offline pre-check that must not mutate the registry, an end-to-end `new Item(1284, 1)`
name resolution, re-injection leaving no ghost entries, `clearInjected` restoring
`unknown`, and 7 negative cases.

> **Trap:** `new Item(id, count)` takes a **numeric id** as its first argument. Passing the
> registry record object makes it look up `registry.items[object]`, miss, and return
> `unknown` — i.e. it reintroduces the exact bug you are fixing, inside the test.

---

## Being Present (watching for the player)

**The bridge has no autonomous loop of its own.** Its only timer is a 30-second state
snapshot. Without something driving it, the bot just stands there — it has hands and eyes
but no brain stem. Two things provide that:

### `autopilot.js` — the real answer (recommended)

```bash
node autopilot.js
```

A separate process that talks to the bridge over HTTP on a tick loop
(perceive → decide → act). It is **not** a wrapper around the bridge — you can stop and
start it without dropping the bot.

#### Where the decisions live — `decision.js`

The tick does **not** contain a hardcoded priority chain. It asks `decision.js`, which is
built around two ideas borrowed from Jev (TypeSafe AI's System One decision model, 2026-09)
and from `rmalde/minecraft-agent` (Astra planner + JEV controller, 8m43s Ender Dragon run):

1. **Possible vs advisable are different questions.**
   `buildActionMenu(state)` returns only the actions that are *physically doable right now*.
   Impossible ones **never enter the menu** — a creeper at melee range does not get
   "attack" with a low score, "attack" is simply absent. The backend then picks among the
   survivors. "Should I" is the model's job; "can I" is not.
2. **The backend is pluggable, and `local` is the default — it does *not* switch itself.**
   - `local` — deterministic rules, no network, works offline (**the default**)
   - `jev` — real API call, needs a TypeSafe API key
   - `auto` — use Jev if a key is present, else local

```bash
node autopilot.js                    # default: local, even if a key is in the env
MC_DECISION_BACKEND=jev node autopilot.js     # opt in explicitly
MC_DECISION_BACKEND=auto node autopilot.js    # the old "key present → jev" behaviour
# JEV_API_KEY is also accepted (this project's earlier name); TYPESAFE_API_KEY is preferred
```

> ⚠️ **The default used to be `auto` (key present → Jev). It is now `local`.** A paid external
> dependency must be **opted into**, never opted out of — otherwise the day a key appears in
> the environment, her behaviour changes silently *and* starts costing money. `decision.js`
> pins this with five assertions that read the default in a clean-env subprocess, including
> "a key is present but the backend is still `local`".

With no key it uses `local` and everything still works — the menu, the guard, the
confidence gate and the event trail are all backend-independent.

##### The Jev endpoint — get this right, it was wrong once

```bash
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
```

**Not** an OpenAI-compatible `chat/completions` shape. The body is
`{model, state, questions}`; `questions` is a map of `{type, instructions, criteria}`.
Verified against the official quickstart, and pinned by a regression test
(`scripts/jev-contract-test.js` asserts the default URL, so this cannot silently drift again).

| Type | `criteria` shape | Response fields |
|---|---|---|
| `choice` | **object** `{optionId: criteria}` | `choice`, `confidence`, `probabilities` |
| `score` | **ordered array** of labels | `score`, `confidence`, `legend`, `probabilities` |
| `noul` | absent — `instructions` only | `noul` (0–1). **No `confidence`.** |

`noul` genuinely returns no confidence — that is official behaviour, not a parsing bug, so
any caller reading `confidence` must tolerate its absence.

Get a key at <https://console.typesafe.ai/> (new accounts get **$5 of credit**, ≈120M input
tokens at the current rate). Model aliases `jev-latest` / `jev-preview` both resolve to
`jev-1.13.0`; we **pin the version** rather than use the alias, per the official advice that
you should pin a version if you have tuned confidence thresholds against it.

> ⚠️ **Chinese criteria are an unmeasured risk.** The official model page says English is the
> primary training language and where accuracy is best, and that **CJK scripts are handled but
> not equally well** — test on your own content before relying on Jev for non-English work.
> Our criteria were all Chinese, which means a bad result could be misread as "Jev is bad"
> when the real cause is language. So criteria are bilingual and switchable:
>
> ```bash
> MC_CRITERIA_LANG=en node autopilot.js     # isolate the language variable in one run
> ```
>
> The state itself is mostly English/enum values (`hp`, `threat.name='zombie'`,
> `task.type='mine'`), so the Chinese exposure is exactly the criteria + instructions —
> precisely what this switch covers.

**Confidence gate:** if the backend returns confidence below `MC_MIN_CONFIDENCE`
(default 0.55) she does *not* act on it — she idles. Fail closed, not "pick something".

> ⚠️ That 0.55 is a guess, not a calibrated threshold. The official docs are explicit that
> confidence is derived from the probability distribution and is **not** an independent
> verifier — thresholds must be tested against labelled examples from your own workload.
> Once there are real decision records in `events.jsonl`, calibrate it from those.

**Circuit breaker:** if Jev fails, it is skipped for 60s and the local rules take over.
Without this, a 6s Jev timeout on a 1.5s tick would stall the whole loop.

> ⚠️ **Degraded results are never cached.** A fallback is not a decision — caching it would
> freeze one transient blip onto that decision identity, so she would keep using the local
> rules even after Jev recovered, without ever retrying upstream. (Found by the contract test:
> testing 429 then 500, the second call got the cached 429 result and the 500 path never ran.)

#### ⚠️ Long actions get a watchdog — this is what makes her feel alive

A real player keeps glancing around while mining. The original code did
`await post('/mine', …)` for **up to 45 seconds** with the loop fully blocked — so a creeper
could walk up and she would not react until the call returned. **Faster decisions don't help
if the decision loop is blocked.**

Long actions (`mine` / `collect` / `craft` / `goto` / `place` / `give`) now run with a
watchdog polling every 700ms; on danger it calls `POST /stop` to interrupt and reports why.

Interruption is deliberately conservative — a zombie 6 blocks away while walking is normal,
and stopping for it would cause a stop/resume/stop stutter:

| Situation | Interrupt? |
|---|---|
| health ≤ 8 | ✅ |
| a `DO_NOT_MELEE` mob (creeper) within 6 blocks | ✅ |
| any other hostile within 3 blocks | ✅ |
| zombie 6 blocks away | ❌ |

Being interrupted is reported as "先躲一下" (danger), not "我做不到" (failure) — different
branch, different line, because it is not a failure.

**The same watchdog also does stuck detection.** This is not decoration: the main `tick` is
blocked inside `await runTask()`, so it cannot possibly notice that she has been walking
into a wall for 20 seconds. Only the concurrent watchdog can see it.

The rule is *"intent to move, but almost no displacement"* — not merely "didn't move",
because standing still while idle is correct:

| Signal | Meaning |
|---|---|
| intent to move + moved ≥ 0.1 blocks | fine, counter resets |
| intent to move + moved < 0.1 for ~21s | **stuck** → `POST /stop` to clear the path and let the main loop re-plan |
| idle / not a moving action | not evaluated at all |

A blocked path is not a failure — it is "this route is no good", so `S.task` is **kept** and
the next tick re-issues it. Three failed clear-outs escalate to a real `stuck` verdict, which
the retry cap below then handles.

#### ⚠️ Listening is a *second* loop, for the same reason the watchdog is

The watchdog exists because the main `tick` blocks. **Chat has exactly the same problem**, and
it was worse than it looks: `chatlog` is read at the *top* of `tick`, so while she is inside
`await perform()` — up to 45s of mining or walking — she is not merely slow to answer, she
**cannot hear you at all**. You would have to wait for the ore to be mined.

So `earsLoop()` runs alongside the main loop, polling `GET /chatlog` every `MC_EARS_MS`
(default 2000ms) and feeding the same `watchChat()`.

> **This is not "a third sub-agent", and the distinction matters.** It makes no decisions,
> touches no body state, and changes nothing — it does one **I/O-bound** thing (read chat).
> The only legitimate reason to run something in parallel is **to move I/O waiting off a
> time-sensitive path**, which is the same rule the watchdog follows. There is exactly one
> body, and only `tick` ever moves it. That is why "acting" cannot be parallelised and
> "listening" can.

`watchChat()` is **idempotent** (deduped through `S.seenChat`), which is what makes it safe for
both loops to call it — no double acknowledgements. A self-test pins this, plus the invariant
that `earsMs` is at least 10× smaller than `actionTimeoutMs` (otherwise moving it off the tick
would buy nothing).

Health is exposed so you can tell "running but can't read" from "not running at all":

```bash
curl --noproxy '*' http://127.0.0.1:3002/autopilot | grep -A6 '"ears"'
# {"polls":4,"heard":0,"errors":4,"lastError":"Bot not connected","intervalMs":2000}
```

`polls` must keep climbing **even while offline** — if the counter only advanced on success,
a healthy-but-offline loop would be indistinguishable from a dead one. `errors` (reset on any
success) then tells you *why* it can't read.

#### ⚠️ The retry cap — how she avoids the classic agent death spiral

The single most common way a long-horizon agent dies is *spinning forever on a goal it can
never reach*: retry → fail → retry, looking busy while accomplishing nothing. There is now a
cap, counted two ways because "didn't succeed" has two very different flavours:

| Counter | Counts | Cap | Why |
|---|---|---|---|
| `failures` | genuinely impossible (no path, no item, guard blocked) | `maxTaskFailures` (3) | retrying an impossible goal is pointless |
| `attempts` | *everything* non-successful, including interruptions | `maxTaskAttempts` (12) | bounds the case where she is repeatedly interrupted and never actually fails |

**An interruption does NOT count as a failure.** A creeper walking past is not the task's
fault, and she should resume the job afterwards — which she now does, because an interrupted
task is *kept*, not discarded. That is what a real player does; being interrupted once does
not make you forget what you were doing.

Once a task is exhausted, `POST /autopilot/task` **refuses it immediately (409)** instead of
letting her walk into the same wall again — the agent learns right away instead of finding out
from the log 40 seconds later. Clear the record when the situation changes (the player gives
her a pickaxe, she moves somewhere else):

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3002/autopilot/forget \
  -H 'Content-Type: application/json' -d '{"type":"mine"}'
```

#### Decision trail — `memory/events.jsonl` (measure before optimising)

`memory/journal.md` is her **prose diary** — warm, readable, and completely unparseable:

```
- [02:36:24] (chat) <Angel_ICE> 唔…我记不清具体是哪几块了啦（心虚低头）
```

That is fine for humans, but it left a real gap: a dozen improvement ideas were on the table
and **not one of them could be verified**, because nothing recorded *what she decided, on what
basis, and how it turned out*. `events.js` fills that half in — one JSON line per decision and
per outcome, in `memory/events.jsonl`:

```bash
node events.js --tail 30     # human-readable tail
node events.js --stats       # action counts, failure rate, stuck count, cache hits
node events.js --path        # where it writes
curl --noproxy '*' 'http://127.0.0.1:3002/autopilot/events?n=30'
curl --noproxy '*' http://127.0.0.1:3002/autopilot/stats
```

It records the **menu**, not just the choice. Logging only "she picked `idle`" is useless for
review — maybe nothing else was available. Recording the candidate set is what lets you ask
"what were her options, and why this one" (the same *store the why, not just the what* idea
that WISE's causal event graph is built on).

Writing is best-effort by design: `append()` **never throws**, bad lines are skipped on read,
and the file self-trims past 2 MB. Losing a log line must never stop her from playing.

#### Control plane (`127.0.0.1:3002`, local only)

| Route | What it does |
|---|---|
| `GET /autopilot` | current action, tick, pending questions, `lastDecision`, `lastStuck`, `taskFailures`, decision-backend status, **`ears` health**, last 12 log lines, live config |
| `GET /autopilot/events?n=30` | the structured decision trail (`memory/events.jsonl`) |
| `GET /autopilot/stats` | aggregate: action counts, failure rate, stuck count, cache hits |
| `POST /autopilot/task` | queue a job: `{"type":"mine","blockName":"iron_ore","count":10}` |
| `POST /autopilot/say` | have her say something (bypasses cooldown) |
| `POST /autopilot/config` | retune at runtime: `{"followMax":10}` |
| `POST /autopilot/forget` | clear task-failure counts (`{"type":"mine"}`, or all) |
| `POST /autopilot/stop` | stop the loop |

`lastDecision` answers "why did she do that" — action, backend, confidence, and any
degradation reason.

> ⚠️ `POST /autopilot/config` mirrors the threshold keys (`followMax`, `criticalHp`,
> `fightRadius`, `dangerRadius`) into `decision.js`'s `TUNING`. Change only one and you get
> the worst kind of bug: the parameter moves but the behaviour doesn't.

Task types: `mine` · `collect` · `craft` · `goto` · `follow` · `place` · `give` · `say`.
`mine` auto-equips the best pickaxe first — without it she digs stone at a crawl.
`place` needs `{x,y,z}` (she puts a block back); `give` hands an item to `playerName`
(approaches first, then tosses it toward them).

```bash
# send her off to mine 10 iron ore, then watch what she's doing
curl --noproxy '*' -X POST http://127.0.0.1:3002/autopilot/task \
  -H 'Content-Type: application/json' -d '{"type":"mine","blockName":"iron_ore","count":10}'
curl --noproxy '*' http://127.0.0.1:3002/autopilot

# have her put a block back, or hand one over
curl --noproxy '*' -X POST http://127.0.0.1:3002/autopilot/task \
  -H 'Content-Type: application/json' -d '{"type":"place","itemName":"white_wool","x":35,"y":74,"z":-135}'
curl --noproxy '*' -X POST http://127.0.0.1:3002/autopilot/task \
  -H 'Content-Type: application/json' -d '{"type":"give","itemName":"white_wool","playerName":"Ka_sum1"}'
```

#### Speaking discipline — the whole point

`speak()` is the only way she talks, and it enforces:

- a cooldown between utterances
- no repeating herself
- **a `looksLikeLecture()` filter that drops unsolicited tutorial text**

She speaks only when asked, or when there is real danger / she is the one in trouble.
A companion that recites the quest book at you unprompted is a bad companion.
Verify the filter after touching the patterns:

```bash
node autopilot.js --selftest            # 54 cases — speech filter, watchdog, stuck detection, retry cap, ears contract
node decision.js --selftest             # 37 cases — action menu, backend, guard, bilingual criteria, default-backend regression
node events.js --selftest               # 17 cases — trail write/read/aggregate, corrupt-line tolerance
node place.js --selftest                # 23 cases — the four placement conditions
node pathing.js --selftest              # 119 cases — protected blocks, cost invariants, policy assembly, registry probe, climbable blocks
node scripts/jev-contract-test.js       # 34 cases — Jev endpoint, request/response contract, degradation
```

All six exit non-zero on failure — **284 assertions total**. Run them after touching decision
logic; the whole point of extracting `decision.js` / `place.js` / `events.js` was to make this
testable without a live server.

Two of these exist specifically because the logic they cover **cannot be reached offline**:

- `place.js` — the four placement conditions are pure geometry, but `/place` can only be
  exercised against a live server, and placement is the operation most prone to *silent*
  failure (the client predicts success that the server never accepted). Extracting the
  geometry lets all six faces × four failure modes be enumerated with no server at all.
  **`bridge-server.js` requires this module** — the tested code is the shipped code.
- `pathing.js` — the movement policy only exists after `spawn` (it needs
  `bot.registry.blocksByName`), so `GET /config` returns `pathfinder: null` while the world
  is closed and the policy is unreachable by hand. Two things were checked offline instead:
  the 87-assertion suite over the pure functions, **and** an assembly dry-run against the
  real `minecraft-data` 1.20.1 registry — 613 of 1003 blocks protected, zero false
  positives on natural terrain. `bridge-server.js` requires this module too.
- the retry cap in `autopilot.js` — `tick()` returns before deciding while the server is
  down, so the cap would otherwise never run until the player logs in.
- the **ears contract** — `earsLoop()` is an async I/O loop that cannot run offline, so the
  self-test pins what it *depends on* instead: that `watchChat()` is idempotent (both loops
  call it), that her own lines are not counted as "heard", and that `earsMs` stays ≥10×
  smaller than `actionTimeoutMs`. Without that last one, moving chat off the tick buys nothing.

`jev-contract-test.js` starts a **fake Jev server**, so it verifies the request body shape
(`criteria` must be `{optionName: criteria}` for `choice` and an ordered **array** for `score`
— not our internal array with `priority`), the auth header, the response parsing including
`noul`'s missing `confidence`, and degradation on 429 / 500 / malformed-200 plus the circuit
breaker. It also **asserts the default endpoint URL**, because that value was wrong once and
silently cost a full integration. **All of that without an API key.** When a real key arrives,
the only thing left to verify is whether the model actually decides well.

### `scripts/scan-blocks.py` — verifying what you placed

```bash
python scripts/scan-blocks.py --center 34 74 -135 --radius 4
```

Because block *names* are unreliable on modded servers (see below), the way to confirm a
placement is to scan before and after and diff the **changed set** — never trust a single
coordinate's name.

### `scripts/watch-player.js` — minimal alternative

```bash
node scripts/watch-player.js Ka_sum1            # follow on login, say nothing
node scripts/watch-player.js Ka_sum1 --greet    # also greet (off by default)
```

Narrower and older: it only follows (and optionally greets). Superseded by `autopilot.js`
unless you want exactly this one action. Greeting is **opt-in** — see PERSONA.md on why
she does not greet unprompted.

> Pair either one with a scheduled automation if the agent should *also* be told the
> player came online — neither script notifies anyone.

### Shortcut: teleport requests (`/tpa`)

Walking to a player is unreliable — mineflayer only learns a player's coordinates once
their entity enters view distance, so `POST /follow` fails for anyone far away. If the
server has a teleport mod, **use it instead**:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3001/command \
  -H 'Content-Type: application/json' \
  -d '{"command":"/tpa <player>"}'
# -> {"success":true,"executed":"/tpa <player>"}
```

Then read `GET /chatlog` — a working teleport mod replies `Request sent!`. The target
player must accept (`/tpaccept`). Confirmed working on servers with **FTB Essentials**
(`/tpa`, `/tpaccept`, `/tpdeny`, `/spawn`, `/home`, `/back`).

> Mod commands are not blocked by the `/command` safety filter (that only blocks
> admin-level vanilla commands like `/op`, `/ban`, `/stop`), so `/tpa` works even when
> the bot has no operator permissions.

---

## Runtime Operations

When user gives a live-game command:

1. **Read her memory first** — `GET /memory`; this returns the journal and the current
   state, so she knows what was said before. (Skip only for pure first-contact commands.)
2. **Check bridge health** — `GET /status`; if unreachable → show setup instructions above
3. **Execute action** — call appropriate endpoint (see API Reference below)
4. **Report result in her voice** — see `PERSONA.md`; include coordinates, item names,
   counts, but wrap them in Angel_ICE's tone
5. **Persist what matters** — `POST /memory` for promises, plans, discoveries, feelings,
   and things the player said about themselves

### Interpreting /status response
```json
{
  "connected": true,
  "username": "Angel_ICE",
  "position": {"x": -142, "y": 64, "z": 88},
  "health": 18.0,
  "food": 14,
  "gameTime": 6000,
  "inventoryCount": 12
}
```
- `gameTime` 0–6000 = morning, 6000–12000 = day, 12000–18000 = dusk/night
- `health` max 20.0; below 6 = danger
- `food` max 20; below 6 = can't sprint, below 1 = taking damage

### ⚠️ Pathfinder safety — she must never remodel the world

`mineflayer-pathfinder`'s `Movements` defaults are hostile to someone else's base:

| Default | What it causes |
|---|---|
| `canDig = true` | **she breaks blocks to shortcut her path** |
| `digCost = 1` | breaking a block costs almost the same as walking one block — see below |
| `allow1by1towers = true` | she pillars up by placing blocks |
| `scafoldingBlocks` | she consumes the player's building blocks |

Left alone, "follow the player" turns into "demolish the player's house". This is not
hypothetical — it happened, and the player noticed before we did.

**Why `digCost` is the real culprit.** The readme just says "additional cost". Reading
`lib/movements.js` gives the actual scale:

```
getMoveForward              cost = 1                        // walking one block
safeOrBreak (one dirt)      (1 + 3 * digTime/1000) * digCost
                          ≈ (1 + 3*0.15) * 1 ≈ 1.45         // with a shovel
```

So with the default `digCost = 1`, **breaking a block is barely more expensive than
walking one block** — the pathfinder treats a wall as a road.

**And why the first fix was wrong.** Setting `canDig = false` did save the house, but it
also removed the *last resort*: where she genuinely had to pass through, the pathfinder
declared no route, and `No path to the goal!` became **more** frequent. A blunt instrument.

> ↩️ **2026-09-25: we went back to `false` anyway — and this time it is the right call.**
> The "expensive but possible" middle ground only works if the *hard* layer can actually
> recognise what must not be broken. It cannot: it matches **name patterns**, and modded
> decor matches none. See the next section.

#### The policy now lives in `pathing.js` — digging is **off** by default

**2026-09-25: `canDig` is `false`.** The user's call: *"the pathfinder should not dig for
now — later we'll gate actions through JEV."* Why the previous "expensive but possible"
design had to go: the **hard** layer below is keyed by block **name patterns**, and modded
decor names match none of them (`cluttered:antique_mini_table`,
`ultramarine:medium_white_porcelain_vase_bonsai`) — so the "last resort" degenerated into
"casually demolish the player's furniture". **Two blocks were destroyed in practice.**
Names are an open set; enumeration always leaks.

Toggle: `MC_ALLOW_DIG=true` (environment variable, or `config.json`) restores the old
behaviour. A future JEV layer can allow digging for a single call via
`applyPolicy(mv, names, { allowDig: true })`.

> ⚠️ **`POST /mine` is unaffected** — it goes through `bot.dig`, not the pathfinder.
> Digging is still possible; it just has to be requested explicitly by a higher layer.

Consequence: where there is genuinely no way around, she now reports `No path found`
instead of tunnelling. **That is the intended behaviour, not a regression.**

##### The two layers (still applied whenever digging is enabled)

| Layer | Mechanism | Depends on block names? |
|---|---|---|
| **soft** | raise `digCost` (default **16**) → digging is *expensive but possible*. Detours win; if there is no detour she still gets through | ❌ no — always works |
| **hard** | add **building materials** to `blocksCantBreak` → wool / planks / glass / doors / stairs / chests / ores … are **never** broken while pathing, only walked around | ✅ yes |

Costs, in units of "one block of walking = 1":

| Block | Cost | Meaning |
|---|---|---|
| one dirt block (shovel) | ≈ 23 | she'd rather walk ~23 blocks than touch your ground |
| one stone block (pickaxe) | ≈ 35 | |
| one stone block (bare hands) | ≈ 376 → **discarded** | cost > 100 is dropped, so **without a pickaxe she cannot tunnel stone** — exactly like a real player |

That last row is a *feature*, not a bug: `movements.js` drops any move costing > 100, and
a hand-dig of stone exceeds it on its own.

```bash
curl --noproxy '*' http://127.0.0.1:3001/config
# -> "pathfinder": { "canDig": false, "digCost": 16, "placeCost": 12, "liquidCost": 6,
#                    "allow1by1towers": false, "scafoldingBlocks": 0,
#                    "policy": { "canDig": false, "allowDig": false,
#                                "protectedCount": 6724, "protectedSample": [...] },
#                    "registryProbe": { "checked": 6, "ok": 6, "mismatched": [] } }
```

> ⚠️ **`canDig` is `false` — that is deliberate (2026-09-25).** Do not flip it back to
> `true` on your own: that is exactly what destroyed two of the player's decor blocks.
> `policy.allowDig` is the switch value this call actually used; `protectedCount` only
> becomes load-bearing again once digging is re-enabled.
> The **hard** layer is keyed by **name patterns**, so it only ever covered vanilla-shaped
> names: **6724 blocks matched** on this modpack — but modded decor names slip through
> every pattern, which is precisely why the default had to move.

**Why `blocksCantBreak` needs a probe.** That layer is keyed by block **name**, and names
are not fully trustworthy on this 470-mod server (see the "block names are unreliable"
rule). If names are offset, the protected set would contain the wrong IDs — she would
refuse to break dirt and happily break wool. `registryProbe` round-trips
`name → id → name` for six well-known blocks and reports mismatches, turning an assumption
into an observable fact. **If `mismatched` is non-empty, the soft layer is the one doing
the work.**

Known trade-off: **doors are protected**, and `canOpenDoors` is off (the library disables
it for non-Paper servers). So a closed door locks her out — she will neither open nor break
it. That is deliberate: being unable to enter is better than removing the player's door.
Relax it by removing `/(^|_)door$/` from `PROTECTED_PATTERNS` if that becomes annoying.

#### Getting her *through* an open door (2026-09-25, measured)

The paragraph above covers the closed case. Once the door is **open** there are two more
facts, and both are counter-intuitive:

1. **The pathfinder will never path through a door — open or closed.**
   `minecraft-data` gives `dark_oak_door` a *block-level* `boundingBox: "block"` with no
   per-state override, so `canWalkThrough()` sees a wall in every state. `POST /activate
   {passableAfter:true}` does **not** fix this: the runtime whitelist lives *inside* the
   `needsShapeFallback` branch, and a vanilla door never enters it (its `boundingBox` is
   defined). Symptom: `POST /move` → `No path found` while the door stands wide open.
2. **Raw walking works, but only if she is aligned — the slack is 0.21 blocks.**
   Physics reads `block.shapes` (`prismarine-physics/index.js:133`), and `minecraft-data`'s
   shape for an open `facing=west` door is `[[0,0,0,1,1,0.1875]]` — a **3/16 panel on the
   block's north edge, not "empty"**. So only `z ∈ [min+0.1875, min+1]` (0.8125 wide) is
   free, and her 0.6-wide box must fit inside it.

   Measured in door block `z ∈ [-134,-133]`: at `z = -133.52` her box was
   `[-133.82, -133.22]`, clipping the panel by **0.0075** — she stopped dead after 0.2
   blocks, three attempts running. A 50 ms sneak-strafe to `z = -133.47` freed the box, and
   `POST /control {forward:true}` then carried her 4.34 blocks straight out.

   → **To move her through an open door: use `POST /control`, and centre her on the free
   side of the block first. Never `POST /move`.**
3. **A pressure plate in front of the door makes it worse.** Stepping on it powers the
   door, flipping it to `open=true, powered=true` — a *different* stateId from the
   `open=true, powered=false` one `POST /activate` whitelists. So the whitelist entry never
   covers the door you actually walk through.

#### Modded thin blocks must not be forced solid (2026-09-25)

`applyUnknownBlockPolicy` used to send **every** shape-less block to `FULL_CUBE`. That is
right for an opaque wall and wrong for a pressure plate, and the palette cannot tell them
apart — `registry/angel_block_palette.txt` carries `localId|blockId|stateCount|name|props`
and **no shape column at all**.

Cost of getting it wrong, measured: `autumnity:maple_pressure_plate` in the kitchen doorway
became a full cube. `POST /move` → `No path found`; `POST /control {forward}` for 2000 ms
moved her **0.2 blocks** and stopped at `x = 39.7` (= `40.0 − 0.3`, her half-width) — a hard
stop against a cube where the real plate is 1/16 tall. The player's verdict:
*"why jump on a pressure plate, just walk"*.

Fix: `isThinBlockName()` exempts name-matched thin blocks (`*_pressure_plate`, `*_button`,
`*_carpet`, `*_torch`, `*_rail`, `*_sign`, `*_flower`, `*_sapling`, …) — they keep
`shapes: []` / `boundingBox: 'empty'` instead of becoming cubes. `THIN_BLOCK_DENY` blocks the
known false positives (`chorus_flower`, `mangrove_roots`). Toggle: `MC_THIN_BLOCK_PASSABLE=false`.

> ⚠️ **`ladder` / `trapdoor` / `slab` / `stairs` are deliberately absent from that list.**
> A ladder must stay a wall or the pathfinder walks past it instead of climbing; a trapdoor
> is solid while closed and belongs to the `/activate` + runtime-whitelist path; slabs and
> stairs are half-height and are handled by step-up. Do not "helpfully" add them.

> ⚠️ **`MC_PASSABLE_STATE_IDS` is currently a no-op when set in `config.json`.**
> `bridge-server.js` never passes `passableStateIds` to `applyUnknownBlockPolicy`, and
> `loadFileConfig()` never writes `process.env`, so only a *real* environment variable takes
> effect. Same trap as `MC_ALLOW_DIG`. (Not fixed — reported, so it does not get "found"
> again later.)

`allowParkour` is intentionally left on — it destroys nothing and lets her follow across
small gaps.

Deliberate digging belongs to `POST /mine` and nothing else — that path calls `bot.dig`
directly and never consults `blocksCantBreak`, so **mining is unaffected by the hard ban**.
Every `bot.dig` call is wrapped for audit: digs that happen while `currentAction` is **not**
a mining task get written to `memory/journal.md` as `⚠️ 非挖掘动作中拆掉了 …`. If that line
ever appears, something is pathfinding through the world again.

---

### ⚠️ The input layer — three routes, three walls (read before "fixing" movement)

When something can't be reached, the instinct is "just simulate input like other AI
game-players do". That instinct is half right, and it's worth knowing exactly why.

**"Simulated input" is two independent halves:**

| | Read (perception) | Write (execution) |
|---|---|---|
| What | screen pixels → "where am I, what's ahead" | emit key/mouse events |
| Cost | **research-grade** | **nearly free** |
| Ours | mineflayer structured state — exact and free | was entirely delegated to the pathfinder |

So the useful move is to take the **write** half and skip the read half. That's why
`POST /control` and `POST /climb` exist. What it is *not* is a way to escape the
library's world model — see the trap below.

**The three routes, and what each one costs:**

| Route | Examples | Cost |
|---|---|---|
| Pixel-level (screenshot → keyboard/mouse) | VPT (20 binary buttons + 11×11 = 121 camera bins, mu-law), Cradle (BAAI, ICML'25) | **Perception is a research problem.** Cradle's GCC setting is a *self-imposed restriction* — the paper's own words: "to **restrict** foundation agents to interact with software through … screenshots as input and keyboard and mouse actions as output … without relying on any built-in APIs". It's a generality proof, not an engineering optimum; it pays for it with six modules. **Don't copy it** — our constraint is the opposite. |
| Structured state + high-level API | Voyager, Odyssey, `rmalde/minecraft-agent`, this bridge | Exact and free — but **the high-level API ships its own world model, and on a modded server that model is wrong**. |
| Structured state + raw control | `POST /control` / `POST /climb` | Bypasses the *pathfinder's* model. Does **not** bypass the *physics* model, and it won't align itself laterally. |

**Measured, same trip (walking to the foot of a ladder):**

| | `POST /move` (pathfinder) | `POST /control` (raw keys) |
|---|---|---|
| Result | 45 s timeout, wandered in place | **held W for 2 s → moved 6.4 blocks** |
| Feedback | only arrived / didn't | `moved: {x, y, z}`, exact |

So raw control wins at gross movement. Two honest limits:

1. **It does not align itself.** Threading a 1-block-wide gap (measured: `warped_door` +
   ladder + `warped_door` at `z=-137`) needs an outer loop that nudges left/right by
   distance. A single `forward` press just jams into the door frame.
2. **The physics layer has the same hard-coded ID as the pathfinder.**

```js
// prismarine-physics/index.js
const ladderId = blocksByName.ladder.id            // vanilla ladder = 196, hard-coded
function isOnLadder (world, pos) {
  if (block.type === ladderId || block.type === vineId) return true
```

On this pack the real ladder resolves to `type` **215**, so `isOnLadder` is permanently
false. **`setControlState` does not send keystrokes to a real client — it feeds
`prismarine-physics` and lets it integrate.** So raw input inherits the exact same bug.
Measured: lateral alignment succeeded, she walked into the ladder cell, held W across
several 700 ms presses — **Δy stayed 0**.

> **The same wrong ID is written twice, in two independent libraries**
> (`mineflayer-pathfinder`'s `climbables` and `prismarine-physics`' `isOnLadder`).
> `pathing.js` fixes the first via `applyClimbables()`. The second is **still unfixed**;
> the identified patch is to rewrite `blocksByName.ladder.id` in the shared registry
> **before `createBot`** (prismarine-registry's `blocksByName` is shared across registry
> instances, and `Physics(bot.registry, world)` reads it into a closure during `inject`).
> One change fixes both layers. Only do it for a modded pack — leave
> `MC_CLIMBABLE_STATE_IDS` empty when connecting to vanilla.

**Safety requirements that come with raw control** (all already implemented — don't remove them):

- A single press **must** be capped (`MC_CONTROL_MAX_MS`, default 5 s). Holding `forward`
  has no natural end — she can walk into lava.
- `POST /control` releases the keys in a `try/finally`, and returns the exact displacement
  so a caller can tell "jammed" from "moved". Presses without feedback turn "stuck" into a
  silent failure.
- `POST /stop` clears control states. It originally only cleared the pathfinder goal —
  an emergency brake that can't release a held `W` isn't a brake.
- `GET /position` gained an **`exact`** field. `x/y/z` are **rounded**; in a closed loop a
  half-block step reads as 0, so lateral alignment loops never converge.

---

### ⚠️ Block *names* are unreliable on modded servers — trust inventory, not `/block`

Measured on a 1.20.1 Forge pack (~470 mods). **Placing a `white_wool` block made that
exact coordinate read back as `fire`** — verified before/after on the same position:

```
GET /block?x=35&y=74&z=135   ->  air      (before placing)
POST /place {white_wool, 35,74,135}       (success: true)
GET /block?x=35&y=74&z=135   ->  fire     (after placing)
```

A volume scan turned up physically impossible readings — `warped_door`,
`crimson_hanging_sign` and `redstone_wire` each appearing as **vertical columns** several
blocks tall. None of those blocks can stack that way. The cause is a palette mismatch:
mineflayer resolves the server's block-state IDs through its own (vanilla) registry, and
modded blocks shift those IDs.

**What this means in practice:**

| Reliable | Unreliable |
|---|---|
| `GET /inventory` counts — the ground truth | `GET /block` names — can be flatly wrong |
| `POST /place` succeeding (item leaves inventory) | identifying a block by its name |
| `/position`, `/players`, `/status` | `/mine <blockName>` — the name you ask for isn't the name the bot sees |

> **Item names had the same disease and are now fixed.** `GET /inventory` used to report
> `name: "unknown"` for every modded item — which silently killed `/drop`, `/collect`,
> `/equip`, `/craft` and `/place`. It now resolves them; see *Item identity* above.

Corollaries:

- **`GET /block` returns `block: ""` for unloaded positions.** An empty string is not
  "air" — it means "not loaded". A naive caller reads it as air and then reasons about a
  block that was never there. Treat `""` as unknown.
- **`/mine` silently misses.** `{"blockName":"white_wool"}` returned `mined: 0` because
  the bot's registry calls that block `fire`. It found nothing, and reported no error.
- **`/mine` throws instead of returning partial progress.** Mining 1 of 2 and then failing
  yields `No path to the goal!` with **no count** — yet the dig happened. Always confirm
  with `GET /inventory`, never with the `/mine` response alone.
- `GoalLookAtBlock` fails with `No path to the goal!` surprisingly often in tight
  interiors. Since digging is **off** by default (2026-09-25), expect this **more** often:
  where the only route requires breaking a block, the pathfinder now reports no path
  instead of tunnelling. That is intended. Retry, reposition first, or have the higher
  layer explicitly allow digging for that call
  (`MC_ALLOW_DIG=true`, or `applyPolicy(mv, names, { allowDig: true })`).

**Verification recipe used above** (works even when names are wrong): drive the world
through inventory deltas, and confirm the block *left* the inventory. To find where a
placed block landed, scan a small volume with `/block` and look for the *changed* set
rather than trusting any single name.

---

## API Overview

See `references/api-spec.md` for the full schema.

Core endpoints:
- `GET /config` — the config actually in effect (identity, host, port, version, forge) — readable while offline
- `GET /status` — bridge + bot connection state
- `GET /knowledge` — list the game knowledge base; `/knowledge/search?type=&q=` to query it — readable while offline. Non-ASCII keywords need percent-encoding (`curl -G --data-urlencode`) or the `POST /knowledge/search` JSON-body form.
- `GET /memory` — **her memory**: journal (what happened) + state (what's now) — readable while offline
- `GET /state` — cached state snapshot only
- `POST /memory` — write a memory line (`{"text":"...","type":"promise"}`)
- `GET /inventory`, `GET /position`, `GET /nearby`, `GET /health` — live state reads. **`/position` returns both rounded `x/y/z` and an `exact` object** — closed-loop control must use `exact`, because a half-block step rounds to 0.
- `GET /players` — who is online, with distance (use this before trying to follow someone)
- `GET /chatlog` — recent chat/system messages; **this is where `POST /command` output lands**. Messages are `{t, position, text}` — the speaker is **embedded in `text`** as `<Name> ...`, there is no separate `username` field. Parsing on `username` silently yields nothing.
- `POST /move`, `POST /mine`, `POST /collect`, `POST /craft`, `POST /follow`, `POST /stop` — live bot actions
- `POST /control` — **raw key state, bypassing the pathfinder**: `{"forward":true,"durationMs":800}`. Accepts `forward/back/left/right/jump/sprint/sneak` (= WASD + space + shift). Capped at `MC_CONTROL_MAX_MS`, always releases in a `finally`, and **returns the exact displacement** `moved:{x,y,z}` so you can tell "jammed" from "moved". Use `POST /look` first to aim. See *The input layer* above for what this does and does not fix.
- `POST /climb` — closed-loop ladder primitive: `{"x","y","z"}` of the ladder block. Looks at it, holds `forward`+`jump` in short bursts, and checks whether `y` actually rose. Gives up and reports `stalledAtY` rather than pressing forever. **Currently cannot succeed on a modded pack** — blocked by the physics layer, see *The input layer*.
- `POST /place` — put a block down at `{x,y,z}`. Enforces four hard conditions (solid neighbour to place against, lookable face, eyes within 4.5 blocks, own hitbox not occupying the target), settles the body first, then **waits for the server's `blockUpdate`** rather than trusting client prediction. Refuses to overwrite anything non-replaceable. Geometry lives in `place.js` (`node place.js --selftest`). Errors name the offending face, e.g. `Target out of reach (need < 4.5 blocks from eyes) — walk closer first. Faces: below:too-far(7.6), …`
- `POST /drop` — toss an item on the ground, or hand it to `playerName` (looks at them first)
- `POST /look` — turn the bot's head toward a player or coordinate
- `POST /attack` — melee the nearest hostile mob (or a named `target`)
- `POST /equip` — equip an inventory item to a slot
- `POST /chat` — send in-game chat
- `POST /command` — send arbitrary slash commands; use with caution

The **autopilot control plane** lives on its own port (default `3002`) — see
[`### autopilot.js`](#autopilotjs--the-real-answer-recommended) above:
- `GET /autopilot` — action, tick, pending questions, `lastDecision`, `lastStuck`, `taskFailures`, `ears` health, live config
- `GET /autopilot/events?n=30` / `GET /autopilot/stats` — the structured decision trail
- `POST /autopilot/task` / `POST /autopilot/say` / `POST /autopilot/config` / `POST /autopilot/forget` / `POST /autopilot/stop`

> `POST /command` returns only `{"executed": "/list"}`. To see what a command actually
> printed, call `GET /chatlog` afterwards.

> **Security note**: `/command` forwards arbitrary slash commands. On servers where the bot has elevated permissions, this may include destructive or admin-level commands. Prefer `minecraft-server-admin` for server administration tasks.

---

## Dependent Skills

Dependent skills should health-check the bridge before using it.
See `references/dependency-guide.md` for the canonical dependency-check pattern and degradation behavior.

---

## Error Handling

| Error | Cause | Recovery |
|-------|-------|---------|
| `ECONNREFUSED` | Bridge not started | Run `node bridge-server.js` |
| `{"connected":false}` | Bridge up, bot offline | Open Minecraft, check MC_HOST/PORT |
| `{"error":"pathfinding failed"}` | Path blocked | Try `/stop` then retry with different coords |
| `{"error":"no crafting table"}` | Craft without workbench | Move near crafting table first |
| Bot stuck looping | Pathfinding bug | POST /stop, then resume |
| Kick: `...require Forge...` | Forge server, vanilla client | Restart with `MC_FORGE=1` |
| Kick: `unexpected_query_response` | Replied empty to a login channel that needs an answer | Read the log's last `⚠ 未知 mod 登录通道 <channel>` line, reverse that mod, add it to `MOD_LOGIN_REPLIES` |
| `PartialReadError ... command_node` | Modded Brigadier argument types not in the vanilla protodef schema | Non-fatal; the stream re-aligns. Only fix if state reads misbehave |

Auto-reconnect is built in — bridge retries every 5 s after disconnect.

---

## Additional Resources
- **`PERSONA.md`** — **Angel_ICE 的人格设定**：语气、性格、记忆规则（替她说话前必读）
- **`knowledge/`** — **整合包知识库**：总览与核心机制、主线路线、全章节任务、物品名、模组清单、查询脚本
- `config.example.json` — configuration template (copy to `config.json`)
- `memory/journal.md` / `memory/state.json` — her memory (auto-created on first run)
- `references/api-spec.md` — Full API schema with all request/response fields
- `references/dependency-guide.md` — How other skills should declare bridge dependency
- `references/troubleshooting.md` — Detailed error diagnosis
- `references/forge-fml-handshake.md` — Forge FML login handshake: wire format, reverse-engineering method, per-mod reply derivation
- `fml-handshake.js` — The FML handshake implementation (enable with `MC_FORGE=1`)
- `scripts/scan-login-channels.py` — Scan a mods dir for login-handshake registrations
- `scripts/watch-player.js` — Watch for a player joining, greet them, optionally follow
- `scripts/start.sh` / `scripts/stop.sh` — Convenience wrappers
