# 实战问题台账（field log）

> 用户指令（2026-09-25）：**「允许自己去服务器玩，目标是自己建立庇护所并持续发育。中间遇到任何问题都应当记录并尝试修复。」**
>
> 这个文件是**实战**记录，不是设计文档。规则：
> - 每条问题必须有**可复现的证据**（命令 + 真实输出），不接受"我觉得"。
> - 状态只有三种：`已修复` / `已知未修` / `设计如此`。
> - 修完要回填**验证方式**，否则不算修好。

环境：`139.196.98.255:25565`（Forge 1.20.1、离线认证、516 个模组）
会话起点：`(76, 63, -127)`，站在河边草地，背包只有 1 个柠檬。`gameTime=5758`（正午）。

---

## P1 —— 挖完就走，掉落物没捡 ⚠️ 已修复

**发现时间**：2026-09-25 04:14
**当时的任务**：砍 8 个 `bountifulfares:lemon_log`

### 证据

```
POST /mine {"blockName":"bountifulfares:lemon_log","count":8}
→ {"mined":8, "minedBlocks":[…8 条坐标…], "sweeps":[{"gained":0,"reason":"目标在但拿不到"}, …]}
```

`mined: 8` 但每轮 `gained: 0`。查背包：

```
GET /inventory → items:[柠檬×1, lemon_log×1]   ← 只到手 1 个，掉了 7 个
```

### 根因

**不是"看不见掉落物"，是"挖完就走"。**

`POST /mine` 的循环是：找方块 → `goto` 到它旁边 → `bot.dig()` → **立刻找下一个方块**。
`dig()` 只负责把方块拆掉；拆下来的物品变成 `Object` 类型的实体**落在地上**，
必须由客户端**走过去**，服务端才会判定拾取并塞进背包。

她的循环从头到尾没有"停下来捡"这一步。挖得越快，漏得越多 ——
8 个木头丢 7 个，因为木头是**一柱一柱**的，挖完最下面那格时上面的还在掉，
她已经在走去挖下一柱了。

这也解释了用户问题 4 的另一半：他看到的"对可收获可拾取的东西视而不见"，
很可能不是"看不到地上的东西"，而是**"自己挖掉的东西都没捡"**。

### 修复

在 `/mine` 的每一轮里，`dig()` 之后插入一次**原地拾取**：

```js
await withTimeout(state.bot.dig(block));
await sweepUpDrops(state.bot, block.position);   // ← 新增
```

`sweepUpDrops(bot, around)` 做的事：
1. 找 `around` 半径 3 格内的 `Object` 实体（掉落物）
2. `goto(GoalNear(drop, 1))` 走过去 —— 服务端判定拾取
3. 总预算 4 秒，超时就放弃（掉落物可能掉进岩浆/水里，不值得等）

关键设计：**它不抛异常**。捡不到不是错误 —— 是"那件东西拿不到"。
把捡不到当失败会让 `/mine` 整体失败率虚高，进而触发任务放弃计数。

### 验证方式

```
POST /mine {"blockName":"<任意木头>","count":4}
GET  /inventory   ← lemon_log 的数量应该 ≈ mined 的数量
```

（回填：见下方「P1 验证」段）

### 顺带纠正一个我自己的误判

`sweeps` 里的 `"reason":"目标在但拿不到"` 这条文案**是我写的，写得不准确**。
当时的情况根本不是"拿不到"，是"拿到了但立刻掉地上没捡"。
文案应该改成能区分"背包满"和"没回头捡"的。见 P2。

---

## P2 —— `isProductiveSweep` 的理由文案掩盖了两种不同故障 ⚠️ 已修复

**发现时间**：2026-09-25 04:15（由 P1 顺带暴露）

### 证据

P1 的输出里，8 轮 `sweeps` 的 reason 全是同一个字符串
`"目标在但拿不到，本轮不再扩大范围"`，而实际原因至少有两种可能：
① 背包满 ② 挖完没捡。运维时**这两种的处理方式完全不同**，却给同一句话。

### 根因

`isProductiveSweep({gainedItems:0, brokenBlocks:1})` 只判断"没到手"，
不去分辨为什么。当时我加这条文案是为了"说得出口"，但没说准。

### 修复

`isProductiveSweep` 增加一个 `inventoryFull` 入参，分出三种：
- `背包满` —— 明确，且可操作（该丢东西）
- `挖掉了但没进包` —— 就是 P1 那种（"没回头捡"）
- `这一带没有可挖的`

调用方（`/mine`）传入 `bot.inventory.emptySlotCount() === 0`。

### 验证方式

自测里加一条：`isProductiveSweep({gainedItems:0, brokenBlocks:1, inventoryFull:true}).reason.includes('满')`。

---

## P4 —— `byItem` 在模组服上不可用；错误提示误导性极强 ⚠️ 已修复

**发现时间**：2026-09-25 04:24
**当时的操作**：`POST /mine {"byItem":"bountifulfares:lemon_log","count":5}`（想验证 P1 修复）

### 证据

```json
{"success":false,"error":"bountifulfares:lemon_log 不是靠挖掘获取的（作物类没有 drops），试试 /collect 或 /use"}
```

而 `bountifulfares:lemon_log` **显然**是挖出来的（上一轮刚用 `blockName` 挖了 8 个）。

### 根因

两层错误叠加：

**① `resolveBlocksForItem` 只查 `minecraft-data`，而它只含原版方块。**

```
node -e "const mc=require('minecraft-data')('1.20.1');
  console.log(!!mc.blocksByName['bountifulfares:lemon_log'])"
→ false
```

这个服有 **516 个模组、19214 个模组方块**，全部不在 `minecraft-data` 里。
所以 `byItem` 在真实环境里**基本不可用** —— 它只能找到原版的 `iron_ore`/`coal_ore` 那几种。
实测过的"能用"是假象：我在离线环境用原版表验证时全部通过，因为**离线的表里本来就有**。

**② 错误提示的判据是错的。**

我写的：
```js
const known = Object.keys(registry.itemsByName).some(n => stripNamespace(n) === stripNamespace(byItem));
throw new Error(known ? `${byItem} 不是靠挖掘获取的（作物类没有 drops）` : `注册表里没有 ${byItem}`);
```

`lemon_log` 确实在 `itemsByName` 里（它既是方块也是物品）→ 于是走第一个分支 →
报"不是靠挖掘获取的"。但真相是**我查不到它怎么获取**，不是"它不能挖"。

**"我不知道"被写成了"它不行"** —— 这是最坏的一种错误提示：它会让上层
（agent / 人）**放弃一个完全可行的方法**。上一轮我用 `blockName` 挖成功过 8 个，
如果我只信这句话，就会以为这条路不通。

### 修复

三条一起改：

1. **`byItem` 兜底到名字匹配**：`drops` 表查不到时，退化成"方块名去掉后缀后 == 物品名"
   （`bountifulfares:lemon_log` → 去掉 `_log` → `bountifulfares:lemon`）。
   原木/矿石/作物大量遵守这个命名规律，覆盖面远大于原版 drops 表。

2. **错误提示改成区分"不知道"和"不行"**：
   - 注册表里没这个物品 → `注册表里没有 X`
   - 有物品但找不到对应方块 → `找不到会掉落 X 的方块（已查原版 drops 表 + 名字匹配）`
   **不再断言"不是靠挖掘获取的"** —— 我们没有证据说这句话。

3. **把"查不到 drops"这件事本身当作已知限制**上报（返回里带 `resolveSource`），
   让调用方知道这个结论有多可信。

### 验证方式

```
POST /mine {"byItem":"bountifulfares:lemon_log","count":5}
→ success:true, resolveSource 里能看到是走 name-fallback 还是 drops
```

### 教训（写给未来的自己）

**离线的"通过"要问一句"我的测试数据里是不是本来就有它"。**
我这次就是这么被自己骗的：原版表里有 `iron_ore`，于是 `resolveBlocksForItem('raw_iron')`
返回 2 条、自测绿了。但生产环境 96% 的方块不在那张表里。

**判据的表必须来自**服务端注册表**（我们已经有了：`registry/angel_block_palette.txt`
+ `registry/minecraft-item.json`），不能来自 `minecraft-data` 这个"原版答案册"。**

---

## P5 —— autopilot 启动后静默退出，日志只有 5 行 🔴 已知未修（阻塞实战）

**发现时间**：2026-09-25 04:19（重启环境时）
**影响面**：**致命**。autopilot 是"自主发育"的脑干，它不跑，bot 就是一具挂在服务器上的躯壳。

### 证据

```
$ ls -la autopilot-run.log
-rw-r--r-- 1 Kasumi 197121 311 Sep 25 04:13 autopilot-run.log   ← 311 字节，之后从未增长
$ cat autopilot-run.log
[20:13:16] Angel_ICE 自主循环启动
[20:13:16]   网桥   http://127.0.0.1:3001
[20:13:16]   控制面 http://127.0.0.1:3002/autopilot
[20:13:16]   说话纪律：只在被问 / 危险时开口（冷却 25s）
[20:13:16]   耳朵   每 2000ms 听一次聊天（独立回路，长动作期间也听得见）
```

而网桥 `bridge-run.log` 一直在写（16980 字节）→ **网桥活着，autopilot 死了**。
同时 `curl 127.0.0.1:3002/autopilot/state` → `upstream connect failed (os error 10061)` 连接被拒。

**注意**：这 5 行是"启动横幅"，**不是** tick 日志。也就是说我们连它跑了几个 tick 都不知道。
若 tick 有日志，311 字节根本装不下 6 分钟的循环（6 分钟 / 1.5s ≈ 240 tick）。

### 初步判断（待验证，不要当成结论）

最可能是**进程被信号杀掉**，而不是内部异常：
- 内部异常会在 stderr 打堆栈 → 但它只重定向了 stdout 到文件，**stderr 丢了**
- 上一次我也是用 `nohup ... &` / `| head` 启动的，同样症状 → 这是**同一类环境问题**

**这解释了"整整一个夜晚毫无作为"**：不是她不想动，是脑干根本没在跑。

### 修复方向

1. **启动方式**：改用工具的 `run_in_background: true`（不经过 shell 的作业控制，不会被 SIGPIPE/SIGHUP 带走）。已在上一轮验证过这样启动是持久的。
2. **日志必须同时捕 stderr**：`> autopilot-run.log 2>&1`，否则崩溃原因直接丢失。
3. **加启动自检**：启动后立刻打一行带 pid 的日志，再打第一 tick 的日志 —— 让"没起"和"起了没跑"在日志里可区分。

### 验证方式

```
启动后 30 秒：
  cat autopilot-run.log  ← 应能看到 >5 行，且有 tick 记录
  curl 127.0.0.1:3002/autopilot/state  ← 应返回 JSON 而不是连接被拒
```

---

## P6 —— `npm` 级错误提示走丢：`minHunger=null` 🟡 已知未修（低危）

**发现时间**：2026-09-25 04:19

### 证据

```
GET /plugins
→ "runtime": {"autoEat": {"available": true, "enabled": true, "minHunger": null},
              "collectBlockPolicy": {"applied": true}}
→ "capabilities": {"autoEatMinHunger": 16, ...}
```

同一个响应里，`runtime.autoEat.minHunger` 是 `null`，而 `capabilities.autoEatMinHunger` 是 `16`。
启动日志也印证：`[plugins] auto-eat：已开启，阈值 minHunger=null`。

### 根因（已定位）

我们调 `autoEat.setOpts({minHunger: 16})` 设置了阈值，但**回读时读错了字段名** ——
`mineflayer-auto-eat` 的选项存在 `bot.autoEat.options.minHunger`，我们读的是别的路径，
读到 `undefined` 就被 JSON 序列化成了 `null`。

**危险点**：`enabled: true` 是可信的（`autoEat.enable()` 真的调了），但 `minHunger: null`
会让人误判"阈值没设置成功"，进而去重复 setOpts —— 而真正的问题只是**观测错了**。

> 教训同 P4：**"我读不到"和"它没设置"是两件事**，必须区分开。

### 修复方向

回读改成 `bot.autoEat?.options?.minHunger ?? null`，并且在响应里显式区分
`minHunger`（真实读到的值）与 `minHungerConfigured`（我们设置的目标值 16）。

---

## P7 —— `/nearby` 用了已废弃的 `entity.objectType` 🟡 已知未修（低危但吵）

**发现时间**：2026-09-25 04:19

### 证据

```
Trace: Warning: entity.objectType is deprecated. Use entity.displayName instead
    at GET /nearby (bridge-server.js:2015:8)
```

每次调 `/nearby` 都打一大坨堆栈。**这不只是噪音**：`/nearby` 是打怪时高频调用的端点，
堆栈会污染日志、拖慢 I/O —— 而用户本轮的要求正是"提高感知速度"。

### 修复方向

`prismarine-entity` 里 `Object.values(bot.entities)` 拿到的实体，
判断掉落物改用 `e.name === 'item'`（`displayName`），不再碰 `objectType`。
注意 `sweepUpDrops` 里也用了 `e.objectType === 'Item'` —— **要一起改**，否则 P1 的修复会依赖废弃字段。

---

## P8 —— 所有实体的名字都是 `'unknown'`：她**认不出任何东西** 🔴 已定位，最高优先级

**发现时间**：2026-09-25 04:40
**影响面**：**这是 P1 的真正根因，也是"打怪感知慢"的根因。**

### 证据

`P1b` 的诊断留痕（为查 P1 加的）直接把它照出来了：

```json
POST /mine {"byItem":"bountifulfares:lemon_log","count":3}
→ mined: 3, dropsPicked: 0, inventoryDelta: 0

每个方块后的 drops 诊断：
  totalEntities 65 | inRange 0 | seen 0 | picked 0
  near: {'name': 'unknown', 'displayName': 'unknown', 'type': 'other', 'isDrop': False, 'dist': 26.1}
  near: {'name': 'unknown', 'displayName': 'unknown', 'type': 'other', 'isDrop': False, 'dist': 27.0}
  near: {'name': 'unknown', 'displayName': 'unknown', 'type': 'other', 'isDrop': False, 'dist': 28.0}
```

再看 `/nearby`：

```json
GET /nearby?radius=32
→ counts: {'total': 5, 'drops': 0, 'hostile': 0, 'players': 0}
  {'name': 'unknown', 'type': 'other', 'position': {'x': 87, 'y': 42, 'z': -128}, 'distance': 24.6}
  {'name': 'unknown', 'type': 'other', 'position': {'x': 57, 'y': 59, 'z': -148}, 'distance': 28.7}
  …
```

### 结论（三条，都是实测）

**① 实体表不是空的 —— 有 65 个实体，位置也是真的。**
所以"看不到"不是网络问题、也不是实体没同步。

**② 名字解析 100% 失败 —— 每一个都是 `'unknown'` / `type: 'other'`。**
`prismarine-entity` 的 `name` 来源于服务端下发的 `entity_type` 字段。
这服有 **516 个模组**，大量实体类型是模组自己的 —— 客户端的类型表里没有对应项，
于是 `name` 落成 `'unknown'`，`type` 落成 `'other'`。

**③ 于是两件事同时坏掉：**

- **掉落物认不出** → `isDropEntity()` 返回 false → `sweepUpDrops` 的 `seen` 恒为 0
  → **这就是 P1 为什么"修了还是 0"**。我修的是"挖完没回头捡"，
  但真实情况是**她连"地上有东西"都不知道**。
- **敌对生物认不出** → `nearby.counts.hostile` 恒为 0 → `nearestHostile()` 恒返回 null
  → **`decision.js` 的整套威胁菜单（fight / backoff / equip weapon）永远不会被触发**
  → 用户说的"打怪时反应慢"，真相是**她根本看不见怪**。

### 为什么之前没发现

`/nearby` 一直返回 `hostile: 0`，而我们一直以为"这附近确实没怪"。
**一个恒为 0 的指标和一个"确实没有"的指标，从外部看是一样的** ——
直到这次为 P1 加诊断，才把 `totalEntities: 65` 和 `inRange: 0` 摆在一起看。

> 教训：**"没有"和"读不到"必须能在输出里区分开。**
> 这也是为什么 `sweepUpDrops` 现在要同时报 `totalEntities` / `inRange` / `candidates`
> / `nearestAny` —— 光报一个 `seen: 0` 是查不出任何东西的。

### 修复方向（待验证）

名字解析要接**服务端注册表**，而不是依赖客户端的类型表：

1. `bot.registry.entities` —— mineflayer 的实体注册表，看它认不认得这服的模组实体
2. 服务端下发的 `entity_type` 是数字 id，需要一张 **id → 名字** 的表
   （我们已经有抓取注册表的现成机制：`registry/minecraft-item.json` 那套）
3. 兜底：名字认不出时，用**其他可观测特征**判类别 ——
   - 掉落物：`metadata[8].itemId` 存在（`getDroppedItem()` 就是这么做的）
   - 生物：有没有 `health`/`metadata[9]`、移动速度、`objectData` 等

**优先级最高的线索**：`/collect` 里已经用了 `e.metadata?.[8]?.itemId` 来解析掉落物的**物品 id** ——
那条路**不依赖 `name`**。如果它能工作，就说明"认不出名字"不影响识别掉落物，
只是我们的 `isDropEntity()` 用错了判据。

### 下一步（可复现）

```
# 看 mineflayer 自己的实体注册表认不认得这服的实体
node -e "const mc=require('minecraft-data')('1.20.1');
         console.log(Object.keys(mc.entitiesByName).length)"
# 再实测：挖一个方块后，逐个打印实体的 metadata，看哪些字段能区分"掉落物"
```

### 后续澄清（P8b）—— 名字解析其实**只有模组实体**是坏的

补了 `GET /entities`（原始实体诊断口）之后，真相和初判**不一样**：

```
total 63 | named 18 | unknown 12
entityType=54  name='item'      registryName='item'     ← 掉落物**认得出来**
entityType=19  name='creeper'   registryName='creeper'  ← 苦力怕**认得出来**
entityType=701 name='unknown'   registryName=None       ← 模组实体，认不出
entityType=732 name='unknown'   registryName=None       ← 模组实体，认不出
name=None      entityType=None                          ← 包还没解析完的实体
```

`registryEntityCount: 124` —— 实体注册表**只有原版**。

所以 P8 是**三个问题被同一句 `unknown` 掩盖**：

| 现象 | 真实性质 | 严重度 |
|---|---|---|
| `entityType=701/732, name='unknown'` | 模组实体不在 124 条原版表里 | 中（不影响原版怪/掉落物） |
| `name=None, entityType=None` | **实体刚收到、字段还没填完**就出现在列表里 | 中（会污染判据） |
| `name='item'` 但 `metadataKeys=1` | 掉落物的 itemId 拿不到（见下） | 高 |

**纠正我前面的误判**：我一开始说"所有实体都认不出"，是因为第一次 `/nearby` 采样
恰好只抽到模组实体。**采样偏差** —— 下结论前必须看全量。

---

## P1c —— `mined` 是个假数字：`dig()` 声称成功但世界没变 🔴 已修（待复验）

**发现时间**：2026-09-25 04:47
**这是 P1 的真根因。** P1 的 `sweepUpDrops` 修复方向是对的，但它一直被上游的假数据骗着。

### 证据

```
POST /mine {"blockName":"bountifulfares:lemon_log","count":1}
→ HTTP 200, **0.14 秒**, {"mined": 1, "dropsPicked": 0, "inventoryDelta": 0}
```

0.14 秒挖一格木头**物理上不可能**（徒手要好几秒）。立刻用 `/scan` 核对：

```
GET /scan?radius=8&verticalRadius=6
→ bountifulfares:lemon_log  x1  最近={x:77, y:68, z:-128}    ← 方块纹丝不动
```

正是刚才 `/mine` 声称挖掉的那个坐标。

### 根因

原来的代码：

```js
await withTimeout(state.bot.dig(block));
const swept = await sweepUpDrops(...);
mined.push({ at: where, name: block.name, drops: swept });   // ← 无条件计数
```

`dig()` **直接 resolve 了，没有干活** —— 不抛错、不超时，
于是 `withTimeout` 拦不住、`catch` 也拦不住，`mined` 就记了一个假数。

**这是最难查的一类 bug：动作声称成功、世界没有变化。**
所有基于返回值的判断（"挖到了"→"该捡了"）全部建立在一个谎言上。

而 `sweepUpDrops` 报 `seen: 0` 是**完全正确**的 —— 地上确实没东西，因为根本没挖掉。
**我错怪了 P1 的修复，它一直是对的；错的是喂给它的前提。**

### 修复

**不信返回值，去世界里核对**：

```js
const beforeName = state.bot.blockAt(block.position)?.name ?? null;
await withTimeout(state.bot.dig(block));
const afterName = state.bot.blockAt(block.position)?.name ?? null;
const reallyBroken = afterName !== beforeName;

if (!reallyBroken) {
  // 不 push 进 mined。宁可报 0，也不要漂亮但假的数字。
  digStalls.push({ at: where, name: beforeName });
  await sleep(250);   // 让路再试：有时是动作被上一个占用了
  continue;
}
mined.push({ at: where, name: beforeName, nowIs: afterName, drops: swept });
```

返回新增 `digStalls`（空转次数与坐标），并且**与"挖不动"分开报**——
前者是"我们的动作没生效"，后者是"工具/硬度不够"，运维方向完全不同。

另加一条更紧的上限：连续 2 次 dig 空转就 `give-up`，
理由是"不是挖不动，是动作没生效"，不要耗满整个 count。

### 教训

**"成功"必须由世界状态证实，不能由 API 返回值证实。**
这条对**所有**动作都成立：放置、移动、装备。返回值的语义是
"我发出了这个请求"，不是"世界变成了我期望的样子"。

### 验证方式

```
POST /mine {"blockName":"bountifulfares:lemon_log","count":1}
→ 正常情况下 mined=1 且 nowIs 字段存在（说明真变了）
→ 异常情况下 mined=0 且 digStalls 非空（说明动作没生效）
```

### 顺带发现：挖一格模组木头很慢

修好之后 `POST /mine {count:1}` 要 **90 秒以上**（之前 0.14 秒假的）。
原因：**她背包里没有任何工具**，而 `lemon_log` 是模组木头。
空手挖它要走完整的 `block.digTime` 计算，比原版木头慢得多。

这直接决定了**实战路线**：**必须先搞到工具，否则每一个动作都是几十秒**。
`mineflayer-tool` 的 `equipForBlock` 里 `itemList.unshift(undefined)`
（背包有空位时空手也算合法选项），所以它**不会**抛 `NoItem`，
只会静默地空手慢慢挖 —— 这是我们观察到的现象。

## P9 —— 超时能被无限续期，等于没有超时 🔴 已修（待复验）

**发现时间**：2026-09-25 04:52
**这是"挖矿慢"的主因之一。**

### 证据

```
POST /mine {"blockName":"bountifulfares:lemon_log","count":1}
→ HTTP 000（curl 超时）  150.0 秒
```

而配置是：
```
pathing.PATH_MIN_TIMEOUT_MS = 30000      ← 30 秒
pathing.MAX_STAGNANT_CHECKS = 3          ← 连续 3 次无进展就放弃
pathing.PATH_PROGRESS_INTERVAL_MS = 5000 ← 5 秒检查一次
```

**两套机制都该在 30 秒内结束它，但它跑了 150 秒还没停。**

同时 `GET /status` 显示：
```
pos {x:80, y:63, z:-130}   action: "mining 1x bountifulfares:lemon_log"
```
目标在 `(77,68,-128)` —— **水平 3.6 格，但高 5 格（在头顶上方）**。

### 根因（两层，都修了）

**① watchdog 的续期没有上限。**

原代码的意图是好的：远距离路径的合理等待该随距离增长，
一刀切成固定值会误砍正常的长途移动。所以：

```js
if (budget.timeoutMs > lastBudget) {   // ← 预算涨了就续期
  lastBudget = budget.timeoutMs;
  limit = Date.now() + budget.timeoutMs;
  return;
}
```

**但它没有上限。** 而 `path_update` 事件会在**路径反复重规划**时高频触发 ——
**也就是恰好在她卡住的时候**。每次重规划 → `estimatePathTimeMs` 重估 →
预算涨一点 → 续期 → 永远不到期。

> **一个能无限续期的超时，等于没有超时。**
>
> 这条的阴险之处：它**只在真卡住时发作**。平时完全看不出来，
> 自测也测不出来（自测里不会有"反复重规划"的事件流）。

**② `GoalLookAtBlock` 对"头顶上方"的方块是走不到的。**

`GoalLookAtBlock` 要求**能"看到"**方块 —— 需要在同高度或更高处、视线不被挡。
而实战里最常挖的木头长在她**头顶上方 4~5 格**，
于是寻路永远不满足、反复重规划 —— 正好喂给了 ① 那个无限续期的 bug。

### 修复

**① 加绝对上限**（`pathing.computeHardCap`）：

```js
const cap = pathing.computeHardCap(budget.timeoutMs);
const absoluteDeadline = Date.now() + cap.hardCapMs;
// watchdog 里：绝对上限**优先于**续期判断
if (Date.now() >= absoluteDeadline) { trip(...); return; }
if (budget.timeoutMs > lastBudget) { renewals++; limit = Math.min(..., absoluteDeadline); return; }
```

上限取 `max(PATH_MAX_TIMEOUT_MS, 初始预算 × 3)`：
- 用 `×3` 而非 `×1.5`：正常的绕障重规划会续期一两次，不该被误判成卡住
- 用 `max` 而非 `min`：近距路径的初始预算本来就小（30s），
  不该把上限压到 90s —— 那对某些地形太紧

顺带把 `renewals` 暴露出来：**"续了 40 次"比"超时了"更能说明她在原地打转**。

**② 挖矿改用 `GoalNear`**：挖矿真正需要的只是"站得够近"（原版挖掘距离约 4.5 格），
不需要严格的视线条件。`GoalNear` 在"目标在上方"时依然能找到可行站位。

### 回头检查同类问题

`computeHardCap` 的注释里我写了一句，值得抄到这里：

> 这条对**所有**动作都成立 —— 凡是"等一个可能永远不来的结果"，
> 都要问一句"它最坏等多久"。**没有上限的等待就是死锁。**

同类隐患（**已检查，暂未发现**）：
- `withTimeout` 用的是固定值，没有续期逻辑 ✓
- autopilot 的 `actionTimeoutMs` 是固定值 ✓
- `sweepUpDrops` 的 `budgetMs` 是固定值 ✓

## P10 —— 动作完成的时刻 ≠ 结果可观测的时刻 🔴 已修（待复验）

**发现时间**：2026-09-25 05:00
**这是 P1 链条上的最后一环。**

### 证据

P1c（dig 校验）修好之后，实机数据变得**干净**了：

```
POST /mine {"blockName":"autumnity:maple_log","count":3}
→ HTTP 200, 1.86 秒
  mined: 3, dropsPicked: 0, inventoryDelta: 0
  minedBlocks: [
    { name:'autumnity:maple_log', at:{4,89,7}, nowIs:'air' },   ← 真的挖掉了
    { name:'autumnity:maple_log', at:{4,90,7}, nowIs:'air' },
    { name:'autumnity:maple_log', at:{4,91,7}, nowIs:'air' },
  ]
  每个的 drops 诊断：seen=0, inRange=0, totalEntities=220
```

`nowIs: 'air'` ×3 —— **方块真的没了**。`digStalls: None` —— 没有空转。
但 `seen: 0`，而世界里**有 220 个实体**。

**几秒后再查 `/nearby`：**

```
counts: {total: 2, drops: 1}
drop: {name:'item', isDrop:true, distance:2, position:{x:4,y:89,z:7}}
```

**掉落物就在 `(4,89,7)` —— 正是刚挖掉的那格。它只是当时还没出现。**
接着调 `POST /pickup` 就成功捡到了（背包从空 → `{maple_log: 1}`）。

### 根因

**掉落物实体的生成与同步有延迟。**

`dig()` 返回时，客户端只是"把方块改成了空气"。
服务端还要：生成掉落物实体 → 打包 → 发过来 → 客户端解出实体。
这几步加起来是**几百毫秒量级**。

而原来的代码是：**dig 一返回就立刻查一次实体表，查不到就走人。**

> 这是"事件驱动的世界"和"轮询式读取"之间的经典错配：
> **动作完成的时刻 ≠ 结果可观测的时刻。**

而且这个 bug 有个阴险的性质：**它和"这个方块本来就不掉落东西"症状完全一样**
（都是 `seen: 0`）。区别只在"再等几百毫秒"。

### 修复

`sweepUpDrops` 增加一个**等待阶段**：

```js
// 轮询直到看见掉落物，或超时 —— 不是"睡固定时长再看一眼"
const waitDeadline = Date.now() + waitMs;   // 默认 2500ms
let drops = findDrops();
while (!drops.length && Date.now() < waitDeadline) {
  await sleep(pollMs);                       // 默认 200ms
  drops = findDrops();
}
```

为什么是**轮询**而不是"睡固定时长"：掉落物通常几十毫秒就同步过来了，
睡满 2.5 秒纯属浪费时间（每个方块都亏 2.5 秒，挖 64 个就是 160 秒）。
轮询让"正常情况快、异常情况才慢"。

同时把 `waitMs`（等世界反应）与 `budgetMs`（花在走过去上）**分开算** ——
两者是不同性质的时间，共用一个预算会导致"等太久就没时间走"。

**成功判据也换了**：

```js
const invBefore = inventoryCount(bot);
// …走过去了…
out.picked = Math.max(0, inventoryCount(bot) - invBefore);   // ← 背包增量
out.walked = out.walkedTo || 0;
```

`/pickup` 的注释里写的"走到即会拾取"是**期望**，不是**保证**
（可能被水冲走、被抢、或卡在够不到的地方）。唯一可信的判据是**背包件数**。

并且 `walked` 与 `picked` **分开报**：两者的差值有信息量 ——
`walked > picked` 就是"走过去了但没进包"，只报一个 `picked` 的话这种摩擦永远看不出来。

### 教训

**凡是"做完一个动作，然后去读它的结果"，都要问一句"结果什么时候才可观测"。**

更一般地：**poll after act, don't assert after act.**
（这跟 P1c 的 "verify against the world, not the return value" 是一对。）

---


## P11 —— `GoalNear` 对"头顶上方的方块"仍然走不到（卡在爬树）

**发现时间**：2026-09-25 第四次实战（本轮）

### 证据

```
POST /mine {"blockName":"autumnity:maple_log","count":4}
→ 挂住不返回，bridge-run.log 反复刷：

[goto] mine autumnity:maple_log → 停滞判定，放弃（moved=0.14）
[goto] mine autumnity:maple_log 结束：Stuck: no meaningful progress for 3 checks (~15s, 0.14 blocks)
[goto] mine autumnity:maple_log 开始：budget=30000ms hardCap=300000ms
[goto] mine autumnity:maple_log sample #2 moved=0 stagnant=2 exhausted=false
```

位置对照：她在 `(2,91,9)`，木头在 `(4,94,7)` —— **高出 3 格**。

### 根因

P9 把 `GoalLookAtBlock` 换成 `GoalNear(x, y, z, 3)` 修好了"150 秒不返回"，
但 **`GoalNear` 的球心是方块自己的坐标**。要满足"距 (4,94,7) ≤ 3"，
她得**爬高 3 格**；而树干下方是树叶与悬空，寻路器又 `canDig=false`
（不能为爬高拆方块），于是越走越远 → 停滞 → 放弃。

**P9 只解决了"不会无限续期"，没解决"目标本身不可达"。**

### 修复

```js
const eyeY = Math.floor(state.bot.entity.position.y);
await gotoWithBudget(state,
  new goals.GoalNear(block.position.x, eyeY, block.position.z, 3),
  { label: 'mine ' + label });
```

语义纠正：**在"她已经站得住的高度"上水平靠近到够得着**。
· Y 用她自己的 y —— 不要求她改变高度；
· 只约束水平距离；
· 高度差交给 `dig` 判断（原版从下往上挖 3~4 格够得到）。

### 验证

```
HTTP:200
mined: 4   dropsPicked: 0   invDelta: 2
  autumnity:maple_log @ 4,94,7   nowIs=air   ← 树上那块也挖到了
  autumnity:maple_log @ 10,91,-2 nowIs=air
  autumnity:maple_log @ 10,90,-2 nowIs=air
  autumnity:maple_log @ 10,89,-2 nowIs=air
```

不再有停滞日志，4 块全部 `nowIs=air`。

### 教训

**"站得够近"和"走到那一格"是两个不同的目标。**
换成"更宽松的 goal"之前，要先问"这个 goal 的球心在哪、它隐含要求了什么"。

---

## P12 —— 计数判据读得太早 / 条件写错，导致"东西到手了但三个数字都是 0"

**发现时间**：2026-09-25 第四次实战（本轮），紧接 P11

### 证据（同一次调用里三个互相矛盾的数字）

```
mined: 4   dropsPicked: 0   invDelta: 2
bulkSweep: {"seen":1,"picked":0,"walked":0,"gainedAtBulk":0}
```

但**紧接着**查 `GET /inventory`：

```
{"items":[{"name":"autumnity:maple_log","count":5}]}
```

砍树前是 2，**实际到手 3 个**。三个计数（`dropsPicked` / `invDelta` / `picked`）
全部小于真实值，`picked` 甚至是 0。
再调 `/pickup` 返回 `found: 0 —— 1.5 格内没有掉落物`，**印证东西早就被捡完了**。

### 根因（三层叠加）

1. **`invBefore` 采样太早** —— 它在"走之前"读，但上一轮遗留的拾取可能还在同步中，
   于是基准值本身有噪声。
2. **settle 的循环条件写错**（本轮新写的那段）：
   · `walkedTo > 0` 当**前置** —— **她站着不动也可能捡到**（掉落物落到脚下）。
     加了这个前置 = "只要我没走路，我就拒绝承认捡到了"。
   · `gained <= 0` 当**唯一继续条件** —— 一旦某拍读到 >0 就立刻退出，
     但背包可能是**分几批**陆续到的，于是"第一批到手就收工"。
3. **每块 450ms 的探手窗口太短** —— 单块调用内根本等不到同步。
   （这是 P10 第一轮"逐块等 2.5 秒"的过度修正，本轮矫枉过正到了另一个极端。）

### 修复

```js
const hadCandidates = drops.length > 0;
let gained = inventoryCount(bot) - invBefore;
let lastGained = gained;
while (hadCandidates && Date.now() < settleDeadline) {
  await sleep(150);
  gained = inventoryCount(bot) - invBefore;
  if (gained > 0 && gained === lastGained) break;   // 已稳定：拿完了
  lastGained = gained;
}
```

· 去掉 `walkedTo > 0` 前置 —— 有候选掉落物就该等；
· 不满足于"第一次 >0"，而是**等到不再增长**；
· 上限仍是 `settleMs`（不引入新的无限等待，守住 P9 的纪律）。

### 教训

**"等结果"这件事有两个独立的坑：等得不够久，和"等对了"这个信号没被认出来。**
P10 修了前者（加等待），P12 暴露了后者（条件写反）。
写 `while` 条件时应当先问：
**这个条件为假的时候，我想表达的是"还没到"还是"不可能到"？**

---


## P13 —— 批量清扫的锚点用"中间那块"导致散落的掉落物永远收不回来

**发现时间**：2026-09-25 第五次实战（本轮）

### 证据

上一轮加了"批量清扫"之后，\`invDelta\` 依然远小于开采量：

```
POST /mine {"blockName":"autumnity:maple_log","count":4}
→ mined: 4   dropsPicked: 2   invDelta: 2
   bulk: seen=1 picked=1 walked=0

紧接着 /nearby?radius=20：
counts: {"total":8,"drops":7,"hostile":0,"players":0}    ← **地上还剩 7 个**
   item d=6.6  @ 7,88,5
   item d=9.9  @ 6,88,8
   item d=9.9  @ 4,89,7
   item d=10.1 @ 6,88,8
   item d=10.2 @ 5,89,8
   item d=11.7 @ 5,88,10
   item d=14.1 @ 1,92,10
```

散落范围约 **8 格宽**。

### 根因

批量清扫的球心取的是 **\`dropAnchors\` 中间那一块方块**，半径写死 6。

但**树被砍倒后，掉落物会顺着树干散落到周围**，不是一个点。
拿"中间那块"当球心 + 固定半径 6，外圈那几个自然够不着 ——
于是"清扫过了"和"清扫干净了"被混为一谈。

### 修复（两层）

**① 球心改质心，半径按实际散落范围算**

```js
const centroidThat = dropAnchors.reduce(
  (a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n, z: a.z + p.z / n }), { x:0, y:0, z:0 });
const spread = Math.max(...dropAnchors.map(p =>
  Math.hypot(p.x - centroidThat.x, p.y - centroidThat.y, p.z - centroidThat.z)));
const bulkRadius = Math.min(12, Math.max(6, Math.ceil(spread) + 4));
```

**② 清扫完再"看一眼世界"，对残余掉落物逐个再捡（上限 2 轮）**

这一层才是关键 —— 它**不依赖"我猜掉落物在哪"**，而是
\`Object.values(bot.entities).filter(isDropEntity)\` 直接枚举现存掉落物，
一个个靠近。上限 2 轮、每轮每目标 6 秒赛跑，守住 P9 的"不引入无限循环"纪律。

### 验证（单块采集，数字首次全部自洽）

```
POST /mine {"blockName":"autumnity:maple_log","count":1}
→ HTTP:200
  mined: 1   dropsPicked: 3   invDelta: 4        ← 三个数字都指向同一次回收

bulk: {"seen":1,"picked":1,"walked":1,"radius":6,"anchors":1,
       "centroid":{"x":10,"y":93,"z":-2},"spread":0,
       "residueRounds":[{"round":1,"targets":2,"got":2},
                        {"round":2,"targets":1,"got":1}]}

背包：maple_log 10→11、maple_sapling 3→6（总 16→20）
```

**\`invDelta: 4\` 与真实背包增量完全一致。回收率 100%。**
两轮残余清扫各自都捞到了东西 —— 证明"再看一眼世界"这一步是必要的，
不是防御性冗余。

### 教训

**"清扫过了"不等于"清扫干净了"。**
任何"覆盖一片区域"的操作，都应当以**该区域当前的实际内容**为判据，
而不是以"我发起过清扫"为判据。

---

## P14 —— `/pickup` 漏改：P7 的错误在这里复发了

**发现时间**：2026-09-25 第五次实战，紧接 P13

### 证据

\`bridge-run.log\` 里每个 \`/pickup\` 请求都刷一大坨：

```
Trace: Warning: entity.objectType is deprecated. Use entity.displayName instead
    at printObjectTypeWarning (.../prismarine-entity/index.js:78:11)
    at get objectType (.../prismarine-entity/index.js:39:7)
    at C:\Users\Kasumi\Desktop\angleice\bridge-server.js:2761:22
    at Array.filter (<anonymous>)
    at POST /pickup (C:\Users\Kasumi\Desktop\angleice\bridge-server.js:2761:8)
```

### 根因

修 P7 时把判据统一到了 \`isDropEntity\`，但**只改了 \`/nearby\` 和 \`/collect\`**，
\`/pickup\` 里那行原样的 \`e.objectType === 'Item'\` 被漏掉了。

**同一个反模式出现多次时，只改"我这次碰到的那几处"，就是给自己埋复发。**

### 修复

\`/pickup\` 改用 \`isDropEntity\`；
并全仓 grep \`\.objectType\` 确认代码里已无裸用（只剩注释）。

### 附带纠正

原来那条注释写着"别用 \`name === 'item'\`，会一条都匹配不到" —— **这条注释是错的**。
实战里掉落物的 \`name\` 恰好就是 \`'item'\`，\`displayName\` 才是 \`'Item'\`。
真正不能用的是 \`objectType\`（废弃）和 \`e.name === 物品显示名\`（会一条不中）。
注释已改。

### 教训

**修一个反模式时，先 grep 它在全仓出现几次。**
测试替 bug 站岗（P2b）和"只改碰到的那处"（P14）是同一类失误：
**局部修复 + 全局存在 = 复发**。

---


## P15 —— `/craft` 在模组服完全不可用：配方表从来没被填过（**"持续发育"的硬阻塞**）

**发现时间**：2026-09-25 第五次实战（本轮）。**严重度：最高** —— 它挡住了整条发育链。

### 证据

先是合模组木板失败，这可以理解（以为又是"只有原版表"）：

```
POST /craft {"itemName":"autumnity:maple_planks","count":4}
→ HTTP:500  {"success":false,"error":"No recipe for autumnity:maple_planks (or missing crafting table)"}
```

但接着试**原版**配方，**也失败**：

```
POST /craft {"itemName":"oak_planks","count":4}
→ HTTP:500  {"success":false,"error":"No recipe for oak_planks (or missing crafting table)"}
```

日志里对上了根：

```
bridge-run.log:187
Chunk size is 28 but only 12 was read ; partial packet :
{"name":"unlock_recipes","params":{"action":0,"craftingBookOpen":false,
 "recipes1":[],"recipes2":[], ...}};
buffer :3d000000000000000000000000000000000000000000000000000000
```

**`recipes1:[]` 和 `recipes2:[]` 都是空的。**

### 根因

Forge 1.20.1 **不用**原版的 `unlock_recipes` 下发配方，而是走
**内联配方同步**（配方随物品/方块注册表一起，或在 `declare_recipes` 里）。
而 mineflayer 的 `bot.recipes` 依赖 `unlock_recipes` 包 ——
于是 **`bot.recipes` 永远是空的**，`recipesFor()` 恒返回 `[]`。

也就是说：**不是"模组配方没覆盖到"，是"整个配方系统一个配方都没有"。**

### 影响链（为什么这是最高优先级）

```
不能合成 → 没有工作台 → 没有木镐/石镐 → 挖不了石头/矿
         → 没有石制工具 → 没有铁 → 没有盔甲/武器
         → 无法建像样的庇护所、无法自保
```

**"自己建立庇护所并持续发育"这条主线，在这里被一个 0 字节的包掐住了。**

### 修复方向（本轮只做定位，未实施）

三条路，按可行性排序：

1. **从服务端数据包读配方**（最正）
   `minecraft:recipe_serializer` 的注册表快照**是收到了的**
   （日志第 49 行：`snapshot=8278B → 解析出 264 条`），
   也就是说**序列化器**有了，缺的是**配方实例数据**。
   需要顺着 FML 的自定义 payload 找 Forge 下发配方的那条通道。

2. **本地配方库兜底**（最实用）
   既然 `registry/` 下已经有 `angel_block_palette.txt` / `minecraft-item.json` 这类
   服务端快照，同样可以导入一份**配方快照**作为本地表，
   在 `recipesFor` 为空时回退到它自己算。
   （这条路和 P4 的"名字兜底"是同一种思路：**当官方表覆盖不到时，自建表**。）

3. **绕开合成**（治标）
   她已经有 `stick ×3`（不知从何而来），说明这批掉落物里混进了别的产物。
   但纯靠捡不能发育 —— 只能应急，不能作为方案。

**下一步先做 ① 的诊断：确认 Forge 到底有没有下发配方数据、下到哪条通道。**

### 教训

**"这个功能在模组服不可用"和"这个功能一个数据都没有"是两件事。**
前者的排查方向是"覆盖度"，后者是"管道通不通"。
如果我只试了 `maple_planks` 就下结论，会去查错方向（查模组配方兼容），
而真相是**连 `oak_planks` 都不行** —— 根本不是覆盖度问题。

**判据习惯：拿一个"绝对应该能用"的原版样例做对照。**
这一条在 P4 里救过一次（当时是 `lemon_log` vs 原版矿石），这次又救了一次。

---


### P15 深度诊断（同日追加）—— 根因比"配方没下发"更具体

**① 独立探针反证了"是 mineflayer 的锅"这个猜测**

写了个最小 `probe-recipes.js`（纯 mineflayer，不带 FML 握手）直连服务器：

```
[probe] end: socketClosed
=== 包名汇总 ===
  disconnect      x1
配方相关包总数: 0
```

**被服务端直接断线，一个包都没收到。** 这证明：**这服必须走完整 FML 握手上线**，
普通 mineflayer 根本进不来。所以"配方缺失"不是 mineflayer 的 bug，
而是**我们的握手没有把配方拉下来**。

**② 在 FML 握手代码里找到了那条被写死的"空表"**

`fml-handshake.js:301`：

```js
// C2SModListReply：原样回显 mod 列表与通道表
out.push(wVarint(0)) // registries 映射为空
```

注释写着"Forge 客户端本身也是空表，见 C2SModListReply 构造里的 TODO"。
也就是说：**客户端回"我没有需要的注册表"**，而服务端据此决定**发什么/跳过什么**。
这个 TODO 是整条链上最早埋下、也最贵的一个坑。

**③ 关键区分：`recipe_serializer` 在清单里，`recipe` 不在**

服务端声明的 37 个会同步的注册表里**有** `minecraft:recipe_serializer`
（且我们已成功解析出 **264 条**），**但没有** `minecraft:recipe`。

这解释了为什么"序列化器有了、配方实例没有"：

```
recipe_serializer  = 「怎么做」的**工厂**（JSON ↔ 对象）—— 有了
recipe             = 「做什么」的**数据**（具体哪几样合成哪样）—— 没有，且不在注册表清单里
```

Forge 1.20.1 的配方数据**不走注册表同步**，它走 **`forge:registry_data` 的自定义 payload**
或**内联配方同步**通道 —— 而那 202 个通道里我们只处理了少数几个已知的
（`tacz:handshake`、`zeta:main`…），配方那条**从来没被识别过**。

### 结论（对"能解决/不能解决"的回答）

| 问题 | 结论 |
|---|---|
| 我们能不能自己拿到配方？ | **理论上能** —— 配方数据确实在网络上传输过，只是走了我们没解析的通道 |
| 现在能不能合任何东西？ | **不能**。一个配方都没有，包括原版 |
| 有没有不看配方也能发育的路？ | **有** —— 见下面"绕开合成" |

### 绕开合成的三条现实路径（不依赖配方）

1. **世界拾取**：工作台/木棍在遗迹、村庄、地牢里会自然生成，可以捡成品。
   她背包里那 `stick ×3` 就是**捡来的**，不是合成的 —— 说明这条路口是通的。
2. **直接挖矿发育**：石镐挖不了可以用**手挖软方块**（泥土/沙/砾石/黏土/煤），
   石头虽然徒手挖不掉石块但**能徒手挖掉煤**（部分版本），铜矿需要石镐。
   所以至少"挖土改造地形 + 盖土屋"这条路**不依赖任何工具**。
3. **纯土/木结构庇护所**：不需要工作台也能盖 —— 土块、沙、木头都是直接放置的。

**所以主线目标（建立庇护所 + 持续发育）在"无合成"约束下仍然可行**，
只是发育上限被压到"石器前"级别。这也正是接下来要实测的。

---


## P8 完整根因 —— "打怪感知"整条链断在两处分类表上（**本轮最重要的发现**）

**发现时间**：2026-09-25 第六次实战。这是 P8 的最终结论，也是"打怪感知慢"的真正答案。

### 完整证据链（她正在被骷髅射）

autopilot 启动后立刻开始记录掉血：

```
[21:05:02] Angel_ICE 自主循环启动
[21:05:05] 💔 掉血 15.333333969116211 → 9.333333969116211
[21:05:22] 💔 掉血 18 → 12
[21:05:33] 💔 掉血 14.833333015441895 → 1        ← 只剩 1 点血
[21:05:42] 💬 (danger) 呜…我血不多了，先躲一下下
[21:05:58] 💔 掉血 12 → 3.0000009536743164
[21:06:26] 💔 掉血 13.5 → 10.333333015441895
[21:06:55] 💔 掉血 18 → 3.166666984558055
```

而她的位置**全程没变**：`(-8,87,-4)` —— **站桩挨打，从头到尾没有躲。**

### 根因（两个独立 bug 叠加，各自都足以致命）

**① 网桥侧：`type === 'hostile'` 漏了**

`GET /nearby` 的分类原来只有：

```js
kind: drop ? 'drop' : (e.type === 'player' ? 'player' : (e.type === 'mob' ? 'mob' : 'other'))
```

而 prismarine-entity 对敌对生物给的 `type` 是 **`'hostile'`**，不是 `'mob'`：

```
name=skeleton  type=hostile  kind=other   d=7.7     ← 骷髅被打进了 'other'
counts: {"total":17,"drops":8,"hostile":0,"players":0}   ← hostile 恒为 0
```

**② autopilot 侧：只查原版名字白名单**

```js
function nearestHostile (nearby) {
  return nearby.filter(e => HOSTILE.has(e.name))   // 34 个原版名字
    .sort((a, b) => a.distance - b.distance)[0] || null;
}
```

34 个名字**全是原版的**，而这服有 **516 个模组**。模组怪物的名字常常是 `unknown`，
**永远进不了白名单**。

两者叠加的后果：`nearestHostile()` 恒返回 `null` → 决策菜单里 `flee` 分支
**永远进不去** → 她感知到了掉血（说话层给出了 danger 台词），但**没有任何躲避动作**。

**这就是"对怪的反应慢"的真相 —— 不是反应慢，是分类表漏了一整类。**

### 修复

**网桥侧**（`bridge-server.js` 的 `/nearby`）：

```js
kind: drop ? 'drop'
  : (e.type === 'player' ? 'player'
  : (e.type === 'hostile' ? 'hostile'
  : (e.type === 'mob' || e.type === 'animal' || e.type === 'water_creature' ? 'mob' : 'other'))),
entityType: e.type ?? null,   // 原样透出，下次再漏一眼能看出来
```

`counts.hostile` 也必须与 `kind` 判据**保持一致**（两个地方各写一套判据，
正是 P14 那种"局部修复 + 全局存在 = 复发"的温床）。

**autopilot 侧**（`nearestHostile`）：判据改成**三级**，名字白名单降级为兜底：

```js
.filter(e => e.kind === 'hostile'
  || e.type === 'hostile'
  || e.entityType === 'hostile'
  || HOSTILE.has(e.name))
```

### 验证

网桥侧：

```
counts: {"total":16,"drops":8,"hostile":1,"mobs":0,"players":0}
  skeleton  type=hostile  kind=hostile  d=8.4      ← 正确分类了
  arrow     type=projectile kind=other  d=9.7      ← 箭不算威胁
```

autopilot 侧：新增 **9 条**回归锁（自测 76 → **85**），其中最关键的一条是：

```
PASS  ★ 模组怪（name=unknown）也要认得出 —— 这是她被射到 1 血的那个 case
PASS  ★ 而且它确实是最近的那一个
PASS  箭（projectile）不是威胁 —— 要躲的是射箭的，不是箭
```

**"箭不算威胁"这条以前从没测过，但正是实战现场的场景**（9 支箭 + 1 个骷髅）。
要躲的是射箭的人，躲箭本身没有意义。

### 教训

**"认不出来"和"没有"在输出上长得一样。**
`counts.hostile: 0` 看起来像"这里没有怪"，实际是"有怪但我没认出来"。
**判据表（白名单）在模组环境下天然是漏的** —— 凡是"按名字列举"的地方，
在 516 个模组的服上都要重新怀疑一遍。

**并且：单测只用原版名字是测不出这个 bug 的。**
新增的自测专门用了 `name: 'unknown'` —— **测试数据必须覆盖真实的失败 case**，
否则测试只是在替现状站岗（P2b 的另一种形态）。

---

## P16 —— 逃跑动作"自己算坐标"，绕过网桥已有的更好实现，导致每次都超时

**发现时间**：2026-09-25 第六次实战，紧接 P8 修复

### 证据

P8 修好之后，威胁**立刻被识别**（1 秒内就触发了）：

```
[21:07:45] Angel_ICE 自主循环启动
[21:07:46] 💬 (danger) 呜…我血不多了，先躲一下下
[21:07:56] 逃跑失败（The operation was aborted due to timeout）—— 退回原地
```

威胁识别链路通了（之前根本进不来），但**逃跑动作本身失败**，她又退回原地继续挨打。

### 根因

`autopilot.js` 的 `fleeFrom` 在**自己算目标坐标**，然后调 `POST /move`：

```js
const tx = Math.round(threat.position.x + (dx / len) * CFG.fleeDistance);
const tz = Math.round(threat.position.z + (dz / len) * CFG.fleeDistance);
await post('/move', { x: tx, z: tz });
```

这条路缺了三样东西：

1. **地形可达性** —— 算出来的点可能根本走不到。
   实战现场四周是 `calcite×76` / `meadow:limestone×444`，她被围在中间。
2. **多方向备选** —— 一条路走不通就整个失败，没有 Plan B。
3. **没有把"实际走到的距离"当判据**。

而**网桥侧的 `POST /flee` 早就把这些全做了**（本文件里就写着）：
8 个方向全部评分 → 按"离威胁最远"排序 → 前 3 个各试一遍 → 按距离给超时。
**autopilot 却绕开它另写了一套更差的。**

### 修复

`fleeFrom` 改成**直接调 `/flee`**：

```js
async function fleeFrom (threat, self) {
  try {
    return await post('/flee', {
      distance: CFG.fleeDistance,
      // 从**威胁的位置**往外逃，不是"从当前位置往外逃" ——
      // 威胁已经贴脸时，这两者会给出完全相反的方向
      fromX: threat?.position ? Math.round(threat.position.x) : undefined,
      fromZ: threat?.position ? Math.round(threat.position.z) : undefined,
    });
  } catch (e) {
    log(`逃跑失败（${e.message}）—— 退回原地`);
    return null;
  }
}
```

### 验证

```
修复前：位置 (-8,87,-4) 持续数分钟不变，血量在 3~18 之间反复
修复后：位置 (-8,87,-4) → (-6,69,16)
        水平移动 20+ 格、垂直下降 18 格，日志无"逃跑失败"
```

**她真的逃出去了。**

### 教训

**"我在上层写一个简单版"之前，先看下层是不是已经有更好的实现。**
这次是重复实现，而且是**更差的**重复实现 ——
网桥侧那份带 8 方向评分和地形感知，autopilot 那份只有一个方向。

更一般地：**同一个能力有两个实现时，较弱的那个会成为瓶颈，而它往往在更上层**
（因为上层的人不知道下层已经有了）。

---

## P17 —— `/health` 与 `/status` 的血量读数互相矛盾

**发现时间**：2026-09-25 第六次实战

### 证据

同一秒内两个端点给出完全不同的血量：

```
GET /health  → {"health": 3.1666669845581055, ...}    05:03:41
GET /health  → {"health": 18, ...}                    05:03:46
GET /status  → {"health": 18, ...}                    05:03:46
GET /status  → {"health": 6.5, ...}                   05:04:12
```

而两个端点读的**都是** `state.bot.health`（无缓存）：
`bridge-server.js:729` 与 `2173` —— 不存在代码层面的不一致。

### 结论（不是 bug，但**非常危险**）

**读数本身是对的：她真的在 3 ↔ 18 之间反复。**
这是"被箭打中 → 掉血 → 短暂恢复 → 又被打中"的真实节奏。

但这带来一个**真实的观测困难**：**单次采样无法判断她是"正在危险中"还是"刚脱险"**。

对"打怪"场景，这是致命的 —— 上层如果只采一次样就看到 18，会以为安全；
只看到 3，会以为要死了。而真相是她一直在被打。

### 处理

不在网桥侧"修正"读数（**读数没错，改它才是错的**），而是：

1. **autopilot 侧改为连续观测 + 掉血事件**（已经这么做了）：
   `💔 掉血 15.33 → 9.33` 这条日志就是**差值检测**，而不是绝对值采样。
   **差值比绝对值更能反映"正在挨打"。**
2. 记入台账，提醒后续任何"看她血够不够"的判断都要用**趋势**，不要用**瞬时值**。

### 教训

**"两个端点读数不一样"不一定是 bug —— 先确认它们读的是不是同一份数据。**
这里两个端点确实读同一份，矛盾的来源是**采样时刻不同的世界**，不是代码。

**但这也暴露了一个设计缺口：`/health` 和 `/status` 都只给瞬时值，
没有任何"最近 N 秒掉过血吗"的信息。** 对战斗场景，后者才是有用的那个。

---


## P19 —— 深挖隧道时掉落物全丢在洞里，一件都没回收

**发现时间**：2026-09-25 第六次实战（建庇护所的第一次采集）

### 证据

想采 10 块方解石（地表建材）。客户端 90 秒超时，但网桥侧日志显示她**一路向下挖了 15 格**：

```
[goto] mine calcite 开始：budget=30000ms hardCap=300000ms
[goto] mine calcite 成功到达（续期 0 次）
[dig] calcite @ 7,60,22
[dig] calcite @ 8,59,22
[dig] calcite @ 7,59,22
[dig] calcite @ 8,58,22
```

位置从 `(-6,69,16)` 到 `(9,73,19)`，垂直从 y=73 降到 y=58。

**结果：背包一件都没多**（还是 `dirt ×7`），而且 `/nearby` 报 `drops: 0` ——
**掉落物全部不见了**（20 个实体全是鸡）。

### 根因（两层）

**① 掉落物掉在洞里，而回收半径只在**她当时的位置**附近**

`sweepUpDrops` 的球心是"**被挖的那一格**"，半径 3。挖一竖列 15 格深的方块时，
最早那几块的掉落物落在 y=60，而她挖到 y=58 时已经在下方 ——
两者**垂直距离**超出半径，收不到。

更关键的是：**她没有回头**。挖完就往上走了（`action: null` 时已在 y=73）。

**② 上层的客户端超时打断了这次调用**

我用 90 秒超时，而挖 15 格深需要更久。**调用方超时后，`/mine` 内部仍在继续** ——
于是"我以为失败了，其实她在继续挖"，中间状态完全不可观测。
（这跟 P9 是同一类：**超时要把"谁的超时"说清楚**。）

### 修复方向（未实施，先记录）

1. **竖直挖取要专门处理** —— 挖到下方方块时，球心不应是"方块位置"，
   而应是"她站的位置往下"。或者干脆**挖一层收一层**（每挖 3~4 格就回头收一次）。
2. **`/mine` 应该分片返回进度**，而不是憋一个巨大的响应。
   长任务应该有**中间可观测性**，否则任何客户端超时都会变成"盲区"。
3. **调用方（我）的超时要给足**：挖 10 块地下方块，90 秒是不够的。

### 教训

**"挖到了"和"拿到了"之间隔着一条隧道。**
当挖掘是**竖直**进行时，"走回去捡"的距离是**三维**的 ——
而我们的回收半径是按**她当时的水平位置**算的。
**动作的空间形态变了，回收策略没跟着变。**

---

## P20 —— ⚠️ `drops` 表没有"需要什么工具"这一列，导致徒手挖石头**只破坏方块、不掉落物品**

**发现时间**：2026-09-25 第六次实战。**这是"持续发育"路上最隐蔽的一个陷阱。**

### 证据

**决定性实验**（`stone` 是最标准的"需要镐子"的方块）：

```
POST /mine {"blockName":"stone","count":3}
→ HTTP:200
  mined: 3        ← 世界真的变了，3 块石头消失了
  invDelta: 0     ← 但背包**一件都没多**
  dropsPicked: 0
```

对照位置确认方块确实被破坏了：

```
GET /block?x=7&y=60&z=22
→ {"block":"air", ...}     ← 挖过的地方确实空了
```

### 根因

原版规则：**石头/方解石这类方块，徒手挖会"破坏"但`不掉落物品`**，
必须用镐子（且要够等级）。而我们的判据链完全没表达这一点：

```
GET /scan 的 mineable：
  stone    x92  d=5.9 → ["cobblestone"]  worthMining: true   ← 看起来完全可行
  calcite  x76  d=0.5 → ["calcite"]      worthMining: true   ← 同上
```

问题出在 `minecraft-data` 的 `blocks[*].drops`：
**它只写"掉什么"，不写"需要什么工具才掉"。**
于是 `drops: ["cobblestone"]` 被读成了"挖了就有鹅卵石" ——
而真相是"**用镐子挖**才有鹅卵石"。

同类混淆还有 `GET /block` 的字段：

```
GET /block?x=0&y=60&z=0 → {"block":"stone","solid":true,"diggable":true, ...}
```

`diggable: true` 的含义是**"这个方块可以被挖掘动作破坏"**，
**不是"挖了会掉落物品"**。这两个语义在字段名上几乎无法区分 ——
我自己第一次读也读成了后者。

### 影响

这是**最隐蔽的陷阱**：她"成功地"挖了一整片石头，`mined` 数字漂亮，
世界也真的变了，**但背包永远是空的**。上层看到的全是"成功"，
而进展是零。

**这直接解释了为什么"她一直在挖但一直没东西"** —— 不是 bug 在偷东西，
是**我们让她在做没有产出的劳动**。

### 修复方向（未实施，先记录）

1. **建一张"需要工具等级"表**。`minecraft-data` 里其实有
   `harvestTools` 字段（原版方块上有），应当把它接进 `/scan` 的判据：
   `worthMining` 必须同时满足"有 drops" **和**"当前手持工具够格"。
2. **新增 `harvestable` 字段**，明确区分三态（与 P4 的"我查不到 ≠ 它不行"同构）：
   · `true`  —— 现在挖就有产出
   · `false` —— 挖了也没有（缺工具），**要在输出里说出来**
   · `null` —— 我不知道（模组方块，表里没有）
3. **`/scan` 的 `mineable` 短名单要过滤掉 `false`** ——
   把"看起来能挖但没有产出"的方块排到最后或标注出来。

### 教训

**"能做"和"做了有收获"是两个判据，而数据表往往只给前一个。**

尤其要注意字段名的误导性：
`diggable`（能不能挖）≠ `drops`（掉什么）≠ `harvestable`（挖了有没有产出）。

**判据链上每加一层"看起来可以"，都要问一句"这一层验证的是哪个问题"。**
这次的代价是：她徒手挖了 15 格隧道 + 3 块石头，**背包零增长**，
而所有返回值都在说"成功"。

---


## P21 —— ⚠️ 她其实站在**玩家的建筑**里，而且一直在拆它（本轮最重要的环境发现）

**发现时间**：2026-09-25 第六次实战，修好 P20 之后立刻暴露。

### 证据

P20 修好（`mineable` 开始过滤"缺工具"的方块）之后，`/scan` 的
"现在挖就有产出"短名单**完全变了一副样子**：

```
=== mineable（现在挖就有产出）===
  acacia_stairs        x67    d=0.5   → ["acacia_stairs"]
  oak_planks           x53    d=1.5   → ["oak_planks"]
  acacia_fence_gate    x14    d=1.5   → ["acacia_fence_gate"]
  stripped_oak_log     x26    d=1.8   → ["stripped_oak_log"]
  acacia_slab          x8     d=2.3   → ["acacia_slab"]
  oak_fence            x5     d=2.5   → ["oak_fence"]
  acacia_planks        x8     d=2.7   → ["acacia_planks"]
  mangrove_planks      x16    d=2.9   → ["mangrove_planks"]

=== toolBlocked（有产出但缺工具）===
  stone_bricks         x20    → ["stone_bricks"]
  lantern              x1     → ["lantern"]
  smooth_red_sandstone x4     → ["smooth_red_sandstone"]
  smooth_quartz_slab   x7     → ["smooth_quartz_slab"]
```

**这不是自然地形。** 判据很硬：

· `planks` / `stairs` / `slab` / `fence` / `fence_gate` **全部是合成产物**，
  自然界不生成（自然树只有 `*_log` 和 `*_leaves`）；
· 而且**跨了三种木材**（acacia / oak / mangrove）混在一起 ——
  自然界不会在一个点上混三种树的合成件；
· 还带 `lantern`（灯笼）、`stone_bricks`（石砖）、`smooth_quartz_slab`（石英台阶）——
  这些**只能由玩家合成并放置**。

**结论：她正站在玩家建造的房子里。**

### 这解释了之前的所有怪异现象

| 之前的现象 | 现在的解释 |
|---|---|
| 背包里莫名有 `stick ×3` | 是从玩家建筑/箱子里捡的，不是合成的 |
| `POST /mine calcite` 一路向下挖 15 格 | 挖的是**建筑的地基**，不是自然矿脉 |
| 挖了半天背包零增长 | 一部分是 P20（缺工具），一部分是**挖的根本不是能发育的资源** |
| 位置从 `(-6,69,16)` 跑到 `(9,73,19)` | 在建筑内部移动，找它认为"能挖"的方块 |

### 处理（立刻）

1. **停止拆建筑。** 在别人（或公共）的建筑上挖方块，不是"发育"，是**破坏**。
   这既不符合"建立自己的庇护所"的目标，也不该是她的行为。
2. **`/scan` 的 `mineable` 需要排除"人造方块"。**
   判据可以是"合成件白名单"（`*_planks`/`*_stairs`/`*_slab`/`*_fence`/
   `*_fence_gate`/`*_door`/`*_trapdoor`/`lantern`/`*_bricks`/`*_glass`…）
   —— 但**不能直接删掉**（她可能真的需要这些材料去建自己的房子）。
   正确做法是**分成两类**：`mineable.natural`（自然资源）与
   `mineable.built`（人造方块），并把后者标注为"这可能是别人的建筑"。
3. **换地方建庇护所。** 目标是**在空地上**建自己的，而不是占别人的。

### 教训

**"这里有很多能挖的方块"不等于"这里适合挖"。**
修好 P20（判据正确性）之后才看见 P21（目标正当性）——
**这说明判据修得越对，被掩盖的问题暴露得越快。**
如果 P20 没修，`mineable` 里全是石头，我根本不会注意到周围是建筑。

更一般地：**在多人服务器上做自动化，"周围的东西是不是别人的"是一条必须显式检查的维度。**
我们的所有判据（能不能挖、掉了什么、值不值得）里，**没有一条问"这是谁的东西"**。

---

（后续问题按 P22… 追加，不覆盖上面的内容。）

## P22 —— autopilot "主循环卡死"是**误判**，真实症状是"决策无限空转"

**发现**：2026-09-25 21:14
**严重度**：🟡 观测缺陷（不是功能故障）—— 但它**掩盖**了真正的 P24

### 证据

```
$ wc -c autopilot-run.log     → 462
$ sleep 20
$ wc -c autopilot-run.log     → 462        ← 20 秒零增长

$ curl /autopilot | jq '{tick, uptimeSec}'
{ "tick": 1486, "uptimeSec": 706 }          ← 但 tick 一直在涨！
```

第一次看只截取了 `tail -4`，看到日志停在启动横幅 21:13:43，
加上 `GET` 返回里 `tick` 恰好被 python 取值时读成了 `undefined`
（我用 `d['tick']`，而当时那份输出里字段是 `S.tick` 名下的 `"tick": 1486`，
是我的取值姿势错了），于是得出"主循环卡死"的错误结论。

再等一轮看：
```
tick: 1508   uptime: 716   → 10 秒涨了 22 拍 ≈ 450ms/拍   ✔ 完全正常
```

### 根因（观测层）

**心跳正常，但日志只在"有值得写的事件"时才落盘。**
`loop()` 里除了启动横幅和 `tick 异常`，**没有任何周期性输出**：

```js
while (S.running) {
  const t0 = Date.now();
  try { delay = await tick(); } catch (e) { log(`tick 异常：${e.message}`); }
  S.tickDelay = delay;
  await sleep(Math.max(60, delay.ms - (Date.now() - t0)));
}
```

运转正常 = 一行都不写 = **日志文件不增长看起来和"死了"完全一样**。

而且 `S.log` 环形缓冲（`GET /autopilot` 的 `log` 字段）也被这条规则影响 ——
它同样只有 6 条启动横幅，说明**环形缓冲里也没有后续内容**。
两个观测面同时失声。

### 处理

1. **不要以"日志文件大小"判断进程是否活着** —— 改用
   `GET /autopilot` 的 `tick` / `uptimeSec`（干净、无副作用、不用改代码）。
   这条立刻写进排查手册。
2. 心跳日志**待评估**：加周期性 `log('tick=… action=… hp=…')` 能消除误判，
   但代价是夜间空转时日志会持续膨胀（706 秒 ≈ 1500 行）。
   倾向于**不写文件、只在 `GET /autopilot` 暴露**（已经有 `S.tick`），
   因为文件日志的价值是"崩溃后还能看"，而心跳不是崩溃相关信号。
   → 结论：**保持现状，改判读方式**。

### 教训

**"没输出"和"没在跑"是两件事，必须能区分开。**
这跟 P4/P8/P20 是同一条原则的第 4 次出现：
- P4  —— "没有掉落物" vs "读不到掉落物"  → 三态
- P8  —— "没有敌对生物" vs "认不出敌对生物" → 三级判据
- P20 —— "挖了没有产出" vs "缺工具所以没产出" → `needsTool` 三态
- P22 —— "进程没在跑" vs "进程在跑但没输出" → 看 `tick`，不看日志文件

**判据本身没错，错的是我选的观测面。**

---

## P24 —— ⚠️⚠️ 她**架构上做不到"自主发育"**：菜单里没有"为自己做事"这一类

**发现**：2026-09-25 21:16（P22 排查时顺带暴露）
**严重度**：🔴 **最高** —— 这是用户本轮目标「自己建立庇护所并持续发育」**无法达成**的直接原因

### 证据

`GET /autopilot` 的 `lastDecision`：

```json
{
  "action": "explore",
  "backend": "local",
  "cached": true,
  "menu": ["explore", "idle"],          ← 整个菜单只有这两项
  "state": {
    "hp": 5.33, "isDay": false,
    "capability": {
      "canEat": false,                   ← 背包 1 种物品（dirt×7），没食物
      "canEquipTool": false,             ← 没有工具
      "canEquipWeapon": false,
      "dropCount": 0,                    ← 地上没有掉落物
      "canScan": true,
      "itemKinds": 1
    }
  }
}
```

`/autopilot/events` 连续 25 条全是 `decision: explore` / `outcome: explore`，
**无限循环**（tick 1486→1508，10 秒 22 拍，每拍都选 explore）。

### 根因

`decision.js` 的 `buildActionMenu()` 里，动作分四类：

| 类别 | 进菜单条件 | 代表动作 |
|---|---|---|
| 对自己（应急） | `cap.canEat` / `canEquipTool` / `canEquipWeapon` | eat、equip |
| 对威胁 | `threat && dist <= dangerRadius` | flee、fight、backoff |
| 对人 | `s.player && s.player.distance != null` | follow、approach |
| **对活** | **`if (s.task)`** | **work（mine/collect/craft/place 全在这里面）** |
| 信息 | `cap.canScan` | explore |
| 兜底 | 永远 | idle |

```js
if (s.task) add('work', 70 + awayFromTask);   // ← 唯一入口，且被 s.task 守着
if (cap.canScan) add('explore', 20);
add('idle', 1);
```

**`mine` / `collect` / `place` 不是独立动作 —— 它们只是 `work` 这个动作的 payload。**
而 `work` 只在**外部（玩家/agent）通过 `POST /autopilot/task` 派了活**时才存在。

所以链条是：

```
没人派活 → s.task === null → work 不进菜单
         → 菜单 = [eat?, equip?, pickup?, follow/approach?, explore, idle]
         → 她背包空、没工具、没掉落物、没人在线
         → 菜单 = [explore, idle]
         → localDecide 在 20 vs 1 里挑了 explore
         → 循环 1500 拍，什么都不做
```

**这不叫"待命"，这叫"没有行为能力"。**
她此刻 hp=5.33、入夜、food=11，**既不觅食、也不找掩护、也不采集** ——
不是她不想，是**菜单里没有这些选项**。

### 加剧它的第二条规则

`decision.js` 的 `ACTION_INSTRUCTIONS`：

```js
zh: '你是 Angel_ICE，一个陪玩家玩 Minecraft 的伙伴。看当前状态，选下一步做什么。' +
    '宁可安静地待命，也不要自己找事做。',
```

**这句话直接禁止了自发性。** 它是为"陪玩"场景写的（那时候她确实该等玩家），
但用户本轮的指令是「**自己**建立庇护所并**持续发育**」——
目标和 prompt 现在**互相矛盾**：

> 系统告诉她"不要自己找事做"，而人告诉她"自己盖房子活下去"。

### 这解释了本轮所有"发育停滞"的表象

| 现象 | 真实原因 |
|---|---|
| 背包一直是 `dirt×7` 不动 | 她**没有采集动作可选**，不是采集失败 |
| 血 5.33 却不觅食（周围 20 只鸡） | 菜单里没有"狩猎/吃"这条自发路径 |
| 天黑了不找掩护 | 没有"搭庇护所"这个动作 |
| 一直在建筑里"探路" | `explore` 是唯一 != idle 的选项，只能反复选它 |

**回头看，之前所有"修好的"采集链路（P11/P12/P13/P20）都是"玩家派活时才走得到"的路。**
链路本身是对的、验证过的（`invDelta` 与背包完全一致、回收率 100%），
**但触发它的入口，在自主模式下恒定关闭。**

### 修复方向（待设计）

需要一个**新的动作类别：自主生存（survival / self-directed）**，
它的进入条件不是 `s.task`，而是"我自己的状态需要照顾"：

| 动作 | 进入条件 | 做什么 |
|---|---|---|
| `forage` | `food <= 14` 且周围有可狩猎物 | 打猎/采果 |
| `gather` | 背包里没有木头/泥土（盖房材料为 0） | 徒手采集 `*_log` / `dirt` / `sand` |
| `shelter` | `!isDay` 且没有安全落脚点 | 3×3 封闭土屋 |
| `hunt` | 周围有被动生物且有武器/徒手可行 | 获取食物 |
| `retreat` | `hp <= 8` 且无敌对威胁 | 离开暴露位置，回遮蔽处 |

⚠️ 三个必须一起解决的配套问题：

1. **`ACTION_INSTRUCTIONS` 要分模式。**
   有人在场 + 被叫过 → "宁可待命"；
   没人在场 / 有自主目标 → "照顾好自己"。
   不能一句 prompt 走天下 —— 它现在和目标直接冲突。

2. **`explore` 的优先级 20 太低但又是唯一选项，会变成事实上的"默认动作"。**
   加了一堆真动作之后要复查排序，否则 `explore` 还是会把它们全挤掉
   （cached 命中时 localDecide 会偏向第一个）。

3. **P20/P21 的教训必须延续到新动作上：**
   新动作的每个进入条件都要有**真实证据**（背包里有木头吗？周围真的是自然空地吗？），
   不能靠"我觉得可以"。

### 教训

**"加一个动作"和"给一个动作一个入口"是两件事，而且后者更容易被忽略。**
我们的自测有 798 条，`buildActionMenu` 也有覆盖 ——
但**没有一条测试问"当 `s.task === null` 且周围什么都没发生时，菜单里还有哪些实际动作"**。
测试全绿、功能全对、她**在真实世界里什么都不做**。

**下一次写测试时，要专门加一个"空状态"用例**：
所有 capability 为 false、没有 task、没有威胁、没有玩家 ——
然后断言"菜单不为空（至少有一个能改变世界状态的动作）"。

## P25 —— ⚠️⚠️ 地上 1.4 格的掉落物一个都捡不到：`setGoal(null)` 把**正在等的** goto 顶掉

**发现**：2026-09-25 21:40
**严重度**：🔴 高 —— 它让"挖到的东西拿不回来"，且**错误信息把我引向了三个错误方向**

### 现象

```
$ POST /mine {"blockName":"dirt","count":6}
mined: 5  dropsPicked: 0  invDelta: 0
bulkSweep: picked=0 seen=4 gainedAtBulk=0 residueRounds=[{round:1, targets:4, got:0}]

$ GET /nearby?radius=20
counts: {"drops": 4}                       ← 地上确实有 4 个

$ 自身 (-12,92,-8)   掉落物 (-13,91,-6) d=1.4   ← 就在 1.4 格外
```

**1.4 格**。走过去**一步**的事。`goto` 却在 **0ms 内立刻失败**：

```
$ POST /pickup {"radius":8,"count":1,"timeoutMs":5000}
{"found":1,"walkedTo":0,"failed":[{"reason":"The goal was changed before it could be completed!"}]}
```

挖掘结果**全部丢失**，背包一件没多。

### 三次错误的方向（记下来，因为下一次我还会走）

| # | 我的猜测 | 为什么听起来合理 | 实际 |
|---|---|---|---|
| ① | `GoalFollow` 是"永不结束"的目标，配超时必然走满 | 读 `goals.js` 确认 `GoalFollow.isEnd()` 要求视线可达，确实会卡 | 是**次因**，不是主因 |
| ② | 超时后没 `stop()`，残留 goal 让下一个 goto 抛错 | 完全符合"第 3 个之后全秒失败"的症状 | **方向对，但我修的方式是错的**（见下） |
| ③ | 有别的插件（collectblock / auto-eat）在抢 pathfinder | 源码里确实有 `pathfinder.goto` | **不是**，它们只在被调用时才动 |

**错误信息 "The goal was changed" 的字面意思是"目标被换了"，我一直在找"谁换了目标"，
而它真正想说的是"有人把目标清成了 null"。** 这两件事在代码里是完全不同的路径。

### 定位过程（关键是加对观测面）

猜了三次都没中之后，我停止猜测，加了两个**只读**观测面：

1. `GET /debug/pathfinder` —— 暴露
   - `bot.pathfinder.goal`（**这个 getter 是可读的**，见 pathfinder/index.js 的
     `Object.defineProperties(bot.pathfinder, { goal: { get () { return stateGoal } } })`）
   - `bot.listeners(event).length`（抓"有没有残留监听"）
2. **`goal_updated` 变更轨迹**（`state.__goalTrace`）—— 每次事件记
   `{ at, goal: 构造函数名, dynamic, who: 调用栈里第一帧非 node_modules 的代码 }`

装上之后一次就抓到了：

```
--- goal_updated 轨迹 ---
 goal=GoalNear     ← 我们的 goto 设的
 goal=None         ← ★ 紧接着被清成 null
 goal=None
 goal=GoalNear
 goal=None         ← 又被清掉
 goal=None
 goal=GoalNear
 ...
```

**`GoalNear` 后面永远紧跟一个 `None`。**

### 根因：**我的修复自己就是凶手**

`goto.js` 的判定是：

```js
function goalChangedListener (newGoal) {
  if (newGoal !== goal) {           // goal = 传进来的那个 GoalNear 实例
    cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'))
  }
}
```

`newGoal = null` → `null !== goalNear` → **立刻抛错**。

而把 goal 设成 `null` 的，是我为了解决"残留 goal"而加的清理：

```js
// 我在 withTimeout 里加的
const cleanup = () => {
  const pf = opts?.cleanupGoal || null;
  if (pf) return pathing.clearPathfinderGoal(pf);   // stop() + setGoal(null)
};
new Promise((_, rej) => setTimeout(() => {
  cleanup();                     // ← ★ 在 reject 之前清
  rej(new Error('Action timed out'));
}, ms)),
```

以及 `/pickup` 循环里的：

```js
} finally {
  try { state.bot.pathfinder.stop(); } catch (_) {}
  try { state.bot.pathfinder.setGoal(null); } catch (_) {}   // ← ★ 同一个错
}
```

**`setGoal(null)` 会 emit `goal_updated(null)`**（pathfinder/index.js:145-146）。
而**下一次 `goto()` 已经注册好 listener 并在等**的时候，这个 `null` 打到它身上
→ `null !== goalNear` → 立刻 `GoalChanged`。

时序是：

```
第1轮：goto(goalA)
        ├ setGoal(goalA) → emit goal_updated(goalA) → 自己的 listener：相等，OK
        └ …超时/完成
      finally { setGoal(null) }        ← emit goal_updated(null)
                                         （此时 goalA 的 listener 已卸载，无害）
        ↓
第2轮：goto(goalB) 开始
        ├ bot.on('goal_updated', listenerB)   ← 注册
        ├ bot.pathfinder.setGoal(goalB)       ← 还没来得及执行…
        └ ✗ 上一步的 setGoal(null) 若因异步延后到这里 → listenerB 收到 null → 抛
```

⚠️ 更常见的情形是**同一个 goto 内部**：`withTimeout` 的定时器与 `goto` 的
`cleanup()` 之间差一个 `setTimeout(..., 0)`（见 goto.js:50），
在这个窗口里 `setGoal(null)` 就能把一个**仍在等待的** goto 打死。

### 修复

**核心原则：`setGoal(null)` 只能在"确定没有 goto 在等"的时候调。**

1. **`withTimeout` 不再主动 `setGoal(null)`** ——
   超时时它只 `reject`。至于"残留 goal"，交给下一个调用方自己处理：
   **在发起新的 goto 之前**清一次，而不是在结束之后清。
   这个顺序的差别是整个修复的关键：
   - 结束之后清 → 清的那一下会打到"下一个已经在等的 goto"
   - 开始之前清 → 清的时候还没有任何 listener 在等，安全

2. **`/pickup`、`sweepUpDrops`、`/mine` 残余清扫**：
   把 `finally { setGoal(null) }` 改成**循环体的第一步**：
   ```js
   for (const d of drops) {
     clearPathfinderGoal(pf);   // ← 先清干净（此时无人等待）
     await goto(...);
   }
   ```
   循环**全部结束后**再清一次（那时也没有人在等了）。

3. **保留 `stop()`** —— 它 emit 的是 `path_stop`，语义是"路径停了"，
   不影响 `goal_updated`。它才是"真·中断"，本来就该调。

### 验证

（见下方"验证"小节，本节先记录方法）

### 教训

**① 「修 A 引入 B」在这一轮里出现了第二次**（P18 是第一次：修 P8 时把
`hostile` 的判据写成 `kind==='hostile' || kind==='mob'`，把 20 只鸡报成敌对）。
而且这次更隐蔽：P18 是**判据写错**（能靠读代码发现），
P25 是**时序写错**（读代码看不出来，必须靠运行时观测）。

**结论：涉及"事件 + 监听器 + 异步清理"的修改，不能只靠读代码确认，
必须有一个能打出事件序列的观测面。** 这就是加 `__goalTrace` 的价值 ——
它不是"调试用的临时代码"，它是**这类 bug 唯一可能的证据来源**。

**② 错误文案会主动误导人。**
"The goal was changed" 让我去找"谁换了目标"，真相是"有人清空了目标"。
如果 `mineflayer-pathfinder` 写成 `"The goal was cleared (set to null)"`，
我大概 10 分钟就能定位，而不是绕了三轮。

**推论：我们自己写的错误信息也要遵守这条。**
如果一个错误文案让人往错误方向找，那它比"没有错误信息"更糟 ——
因为它同时消耗了排查时间和信任。

**③ 观测面要在"猜了三次都没中"的时候立刻加，而不是第四次继续猜。**
我前两次猜测花了不少时间，而且第二次的修复**引入了新 bug**。
如果第一次猜不中就加 `__goalTrace`，整个过程会短得多。

## P25 修复验证 —— 部分生效，但发现**第四个**更根本的干扰源

**时间**：2026-09-25 22:05

### ✅ 已确认修复的部分

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `dropsPicked` | 恒为 **0** | **3** |
| `residueRounds[0].got` | `0` | **1** |
| `residueRounds` 轮数 | 只 1 轮就 break | **跑到第 2 轮** |
| `goto` 失败的时机 | **0ms 立刻** | 不再立刻失败（有真实寻路尝试） |

所以「`setGoal(null)` 打死了正在等的 goto」这个根因**是对的**，
第 ③ 层（`stop()` 后让出一个 tick 给 listener 清理）也确实起了作用。

### 🔴 但采集的最终结果仍然是"背包为空"

```
mined: 6  dropsPicked: 3  inventoryDelta: 0
bulkSweep: picked=0  seen=8  gainedAtBulk=-2
residueRounds: [{round:1, targets:8, got:1}, {round:2, targets:8, got:-3}]
```

**`inventoryDelta: 0` 而 `dropsPicked: 3`** —— 这两个数字又一次矛盾。
而 `got: -3`（**负数**）是新的关键线索：**背包里的东西变少了**。

### 第四个干扰源：**autopilot 进程还活着，在抢同一个 bot**

排查中调 `POST /stop` 后 `goal` 仍然显示 `GoalNear`、listener 数不下降 ——
一个"停不掉的 goal"意味着**有别人在反复设它**。查端口：

```
$ curl http://127.0.0.1:3002/autopilot
{"running": true, "tick": 4748, "action": "走过去捡东西"}
```

**autopilot 一直在跑，每 450ms 发一次 `pickup`。**
我和它**同时**操作同一个 bot：

```
我： POST /pickup → goto(goal_A)
autopilot（450ms 后）： POST /pickup → goto(goal_B)   ← 把 goal_A 顶掉
我： 收到 GoalChanged
```

**这才是"每次 goto 都报 GoalChanged"的最后一个来源。**
之前所有对 `setGoal` 时序的分析都是对的，但**没有考虑到会有第二个进程也在发请求**。

### 这是本轮方法论上的第二个教训

**「单进程内时序正确」≠「系统整体正确」。**
我一直在读 `bridge-server.js` 内部的调用顺序，但真实运行时
**有两个独立进程**在通过 HTTP 操作同一个 bot。这类问题的观测面不在代码里，
在**"谁在这段时间里发过请求"**。

正确做法（下次直接用）：排查任何"状态被意外改变"的问题时，
**第一件事是列出所有可能改这个状态的进程，并确认它们的活跃度**，
而不是先读代码里的时序。

本次的具体动作：
1. 停掉 autopilot（PID 57816）
2. 重测：`listeners` 从 `goal_updated: 2` 降到 **`1`**（只剩我的 `__goalTrace`），
   `goal` 从 `GoalNear` 变成 **`None`** —— 干净了

### 环境干扰：夜间 + 敌对生物

清干净后重测，`dropsPicked: 3`（进步），但：

```
status: hp=6.83  food=20  day=false   pos=(6,89,7)
挖掘点: (-3,87,-2)                      ← 她跑出去 10 格
counts: {"hostile": 1, "mobs": 2}       ← 挖掘期间有敌对生物
```

**她在挖掘过程中被袭击并离开了现场**，所以"背包为空"这次的成因是**环境**，
不是代码。`got: -3`（负数）与 `inventoryDelta: 0` 都能由此解释：
- 她被打 → 掉落物/背包内容变化
- 她跑开 → 剩余掉落物被遗弃、自然消失

**结论：验证 P25 需要一个"白天 + 无敌对"的窗口。** 夜间在野外做采集验证，
会把"采集链路的正确性"和"生存反应"混在一起，两个都测不准。

### 待办

- [ ] 在白天、无敌对时重做一次 6 块泥土的采集验证（判据：`inventoryDelta === 6`）
- [ ] `bulkSweep.picked` 仍为 0 但 `dropsPicked` 为 3 —— 两个计数口径不一致，要查
- [ ] `gainedAtBulk: -2` 与 `residueRounds got: -3` 的负数需要能解释（当前推测是**被袭击导致背包减少**，
      但代码里没有"背包可能变少"的假设，`Math.max` 之类也没兜住）

---

## P26 —— 我误判"有幽灵在改寻路目标"，其实是我自己遗留的长任务

**发现时间**：2026-09-25 凌晨
**严重度**：🟡 中（观测面缺陷 + 判断方法错误）
**状态**：✅ 已定性并修复观测面

### 症状

重启前的 `GET /debug/pathfinder` 里，`recentGoalEvents` 出现规律到可疑的模式：

```
1790287337542 | None     | EventEmitter.<anonymous>
1790287337542 | GoalNear | EventEmitter.<anonymous>     ← 同毫秒
1790287343579 | None     | EventEmitter.<anonymous>
1790287343579 | GoalNear | EventEmitter.<anonymous>     ← 同毫秒
... 每 ~5 秒重复一次
```

`autopilot` 已经被我停掉了，`currentAction` 也是 `null`，所以我的第一反应是
**"有幽灵在改 goal"** —— 这又是一个"先猜后验"的开头。

### 真相（两条，一条是观测面坏，一条是我误判）

**① 观测面本身是废的：`who` 字段从来没有定位到过真正的调用者。**

我写的提取逻辑是：

```js
const own = stack.find(l => !l.includes('node_modules'));
who = own ? own.trim().replace(/^at\s+/, '').replace(/\(.*\)$/, '') : 'node_modules only';
```

两个错叠在一起：

- `EventEmitter.<anonymous>` 这一帧**不含字符串 `node_modules`**，于是被选中了 ——
  它是 emitter 内部的匿名回调，文件名却顶成业务层的。`find` 的第一个条件就选错了。
- `.replace(/\(.*\)$/, '')` 把 `(file:line:col)` **整段删掉** ——
  **包括行号**。也就是说：即使选中了对的帧，行号也已经被我亲手扔了。

结果就是：这个本该回答"谁改的 goal"的字段，输出恒为 `EventEmitter.<anonymous>`。
**它一直没在工作，而我一直以为它在工作。**

**② 幽灵是我自己：一个尚未返回的 `/mine` 长任务。**

`bridge-run.log`（kill 之前的最后一份）尾部写着：

```
[goto] mine dirt 开始：budget=30000ms hardCap=300000ms
[goto] mine dirt 成功到达（续期 0 次）
[dig] dirt @ -2,85,-3
[goto] mine dirt 开始：budget=30000ms hardCap=300000ms
...
[dig] dirt @ -8,87,-2
```

`mine dirt` 的 `dirt` 是插值 —— 来自 `bridge-server.js:3787` 的
`{ label: \`mine ${label}\` }`，也就是 **`/mine` 端点内部的 goto**。
`/mine` 的主循环是 `for (;;)`，**只有 `mined.length >= count` 才 break**。
那个 5 秒一次的 `None → GoalNear`，正是这个循环每挖一块就
`clearPathfinderGoal` + `goto` 一次 —— **不是幽灵，是我的请求。**

### 教训

1. **观测面自己也要被观测。** 一个字段"有输出"不等于"输出是对的"。
   这次如果我没去读那两行提取代码，就会基于 `EventEmitter.<anonymous>`
   得出"pathfinder 从插件层改目标"的完全错误的结论。
   这和 P20/P21 是同一条：**判据本身也要有验证**。
2. **"我以为它跑完了"和"它真的跑完了"是两件事** —— 这是 P22
   （"没输出"≠"没在跑"）的**镜像版本**。P22 是我把"没在跑"看成"卡死"，
   这次是我把"还在跑"看成"跑完了"。两次都源于**同一个坏习惯：拿一个间接信号
   （日志文件大小）推断进程状态，而不是去问进程本身。**
   → 正确做法：**问进程**。`GET /status` 的 `currentAction` 非 null 就说明有活在跑；
   长任务的 HTTP 连接没返回就说明它没结束。

### 修复

`bridge-server.js` 的 `goal_updated` 追踪器重写：

- 跳过 `EventEmitter` / `emit` 帧，优先取**既不含 `node_modules` 也不含 `EventEmitter`** 的帧
- **保留完整 `file:line:col`**（只裁掉绝对路径前缀，便于阅读）
- 额外保留最多 4 帧原始信息（`stack` 字段）—— 单帧常常不够

同时 `recentGoalEvents` 从 12 条扩到 20 条。

**待验证**：重启后重新观察 `who` 字段是否能给出真实行号。

---

## P27 —— ⚠️⚠️ 本机 HTTP 代理会劫持 `127.0.0.1` 请求，并返回**看似成功的无关网页**

**发现时间**：2026-09-25 凌晨
**严重度**：🔴 高（会让所有本地验证得出错误结论）
**状态**：✅ 已定性，有明确规避方式

### 症状

`bridge` 明明在监听 `127.0.0.1:3001`（`netstat` 可见），但 curl 拿不到数据：

```
$ curl -s http://127.0.0.1:3001/status
HTTP/1.1 502 Bad Gateway
upstream connect failed: 由于目标计算机积极拒绝，无法连接。 (os error 10061)
```

紧接着换一种写法，**却拿到了一个真实的、完全无关的网站**：

```
$ curl -s --noproxy * http://127.0.0.1:3001/status
<!doctype html>
<title>Persona &#8211; Centrul de sănătate și frumusețe</title>
... http://persona.md/feed/ ...
```

### 根因（两层，第二层更危险）

**① 代理环境变量把 localhost 也送进了代理。**
本机 shell 里有：

```
HTTP_PROXY=http://127.0.0.1:14867
HTTPS_PROXY=http://127.0.0.1:14867
http_proxy=... / https_proxy=...
```

curl 默认**只看 `NO_PROXY`**，不看"目标是不是 localhost"。`NO_PROXY` 没设，
于是 `127.0.0.1:3001` 被当成外网主机发给代理，代理连不上上游 → 502。

**② `--noproxy *` 里的 `*` 被 shell 当成 glob 展开了。**

我写的是 `curl --noproxy *`，**没加引号**。MSYS/Git-Bash 把裸 `*` 展开了成
当前目录下的文件名列表，`--noproxy` 的值变成了一堆文件名 —— 于是
**noproxy 实际没生效，请求照样走代理**，只是这次代理把 `127.0.0.1:3001`
解释成了它自己的某个后端，返回了一个 200 的**真实网页**（persona.md）。

**这比 502 危险得多：502 会让我知道"失败了"，200 + HTML 会让我以为"成功了"。**
如果我不看返回体内容、只看 HTTP 状态码，就会把一个罗马尼亚健康中心的网页
当成 bridge 的 JSON 响应去解析。

### 规避方式

```bash
# 方式一：清掉代理变量（推荐，一次性）
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

# 方式二：显式设 NO_PROXY
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

# 方式三：--noproxy 必须加引号
curl --noproxy '*' http://127.0.0.1:3001/status
```

### 教训

1. **本地服务的返回体必须看一眼格式。** 只判 HTTP 状态码不足以说明请求打到了对的地方。
   这和 P1c（"动作声称成功、世界没变化"）是同一个错误模式，
   只是这次伪装成了"HTTP 200"。
2. **shell 里所有 `*` 都要按字面量思考一遍。** `--noproxy *` 和 `--noproxy '*'`
   在 Git-Bash 下是两条完全不同的命令。
3. **需要复核结论：**此前"她跑出去 10 格、背包为空、周围无实体"这类
   通过 curl 得到的观测，**可能混入了代理污染**。凡是来自 `bridge` 自身日志
   （如 `dropsPicked: 3`、`residueRounds`）的数据不受影响 —— 那些不经过 curl。

---

## P24 —— ✅ 已修：她架构上做不到"自主发育"，因为菜单里没有"为自己做事"这一类

**发现时间**：2026-09-25 凌晨
**严重度**：🔴 **最高**（这是用户目标「自己建立庇护所并持续发育」无法达成的直接原因）
**状态**：✅ 代码已实现，自测全绿，待实机验证

### 根因（原文照抄当时的诊断）

> **`mine` / `collect` / `place` 不是独立动作 —— 它们只是 `work` 这个动作的 payload。**
> 而 `work` 只在**外部（玩家/agent）通过 `POST /autopilot/task` 派了活**时才存在。
> **这不叫"待命"，这叫"没有行为能力"。**
> 她此刻 hp=5.33、入夜、food=11，**既不觅食、也不找掩护、也不采集** ——
> 不是她不想，是**菜单里没有这些选项**。

证据：`menu: ["explore", "idle"]` —— 整个菜单只有这两项。
`/autopilot/events` 连续 25 条全是 `decision: explore / outcome: explore`。

**另一半根因在 prompt 里：**

```js
const ACTION_INSTRUCTIONS = {
  zh: '你是 Angel_ICE，一个陪玩家玩 Minecraft 的伙伴。看当前状态，选下一步做什么。' +
      '宁可安静地待命，也不要自己找事做。',   // ← 与用户目标直接矛盾
};
```

菜单决定"**能**选什么"，instructions 决定"**倾向**选什么"。
只修菜单不修这句话，等于开了门却贴着"请勿入内"。

### 修复（四层）

**① `decision.js`：新增"自主生存"一类动作（进入条件不看 `s.task`）**

| 动作 | 进入条件 | 优先级 | 做什么 |
|---|---|---|---|
| `forage` | `food ≤ 14` **且**有食物来源 | 75 | 背包有吃的就吃，没有就去打猎 |
| `shelter` | `isDay === false`（**必须是明确的 false**） | 74 | 用背包方块围出紧急遮蔽（留门） |
| `retreat` | `hp ≤ 8` **且**无贴身威胁 | 66 | 回记忆中的安全点养伤 |
| `gather` | 建材 ≤ 8 **且**周围有可徒手采的建材 | 50 | 采木头/泥土/沙 |
| `hunt` | 周围有被动生物 | 46 | 打鸡/牛/猪 |

**② `buildSelfNeeds()`：把「证据 → 需求」集中在一处**

单一实现，autopilot 与 decision 共用（P2b/P18 的教训：两处各判一遍迟早漂移）。
每一项都注明证据来源，**缺证据一律 false**：

- `needFood` ← `food ≤ 14` 且（有可狩猎物 ∨ 有食物掉落 ∨ 背包已有食物）
- `needShelter` ← `cap.isDay === false`（**`null` 不算！**"读不到天色"不等于"天黑了"）
- `needMaterials` ← `matStacks ≤ 8` 且周围有可徒手采的建材

**③ `ACTION_INSTRUCTIONS` 分模式（solo / company）**

- `solo`（无人在场/未被叫）：「**照顾好你自己**：饿了就去弄吃的；没有建材就去采；天黑了没地方躲就给自己围一个。照顾自己的生存**不是**'自己找事做'」
- `company`（有人在场或刚被叫过）：保留原来的「宁可安静地待命」

分派判据 `pickInstructMode()`：`player.distance != null` ∨ `attention.recent` → company。

**④ `autopilot.js`：`buildCapability` 扩展 + `perform` 五个新分支 + `/shelter` 端点**

`buildCapability` 新增（全部要有真实证据）：
`gatherableCount`（`worth && !toolBlocked && !isPlayerBuilt`）、`buildMatCount`、
`matStacks`（**按堆叠数累加**，不是物品种类数）、`huntableCount`、`foodDropCount`、`isDay`（三态）。

### ★ 实测对比（模拟她的真实处境：深夜、背包空、周围有料有鸡）

```
修复前:  menu: ["explore", "idle"]                                  ← 两个都不改变世界
修复后:  menu: ["shelter:74", "gather:50", "hunt:46", "explore:20", "idle:1"]
         self: { needMaterials: true, needShelter: true, canHunt: true, reasons: ["建材 0 ≤ 8"] }
         mode: solo
```

**`shelter:74` 排第一** —— 深夜无遮蔽时，搭遮蔽优先于闲逛。这正是"能活下来才能持续发育"。

### ⚠️ 优先级设计踩过的三个坑（全部由自测抓出，不是我事后想到的）

**坑 1：`retreat` 和 `flee` 同时进菜单。**
第一版只写 `if (self.hpLow) add('retreat', 66)`，于是残血遇僵尸时菜单里
**同时有 `flee` 和 `retreat`** —— 两个都是"跑"，但语义完全不同
（`flee` = 正在被追着打；`retreat` = 没人打我，只是状态差）。
后会有概率选中语义错的那个。
→ 修：`retreat` 的前提就是"**没有**贴身威胁"，与 `flee` 互斥。

**坑 2：慢性需求的优先级必须低于 `work` 的**下界**，不是基准值。**

`work` 的最终值是 `70 + awayFromTask`，而 `awayFromTask` 在"刚被叫过"时是 **−12**。
所以 work 的实际取值范围是 **[58, 70]**，不是 70 一个点。

- 第一版 `gather = 73` → 注释写"只比 work 低一点点"，但 73 > 70，**注释和代码不一致**
- 第二版 `gather = 64` → 看起来低于基准 70 了，但 **64 > 58**，刚被叫过时照样越权

→ 最终 `gather = 50`、`hunt = 46`（都低于下界 58）。
**这条已写成不变量测试**：遍历所有 attention 状态断言 `gather < work` ——
以后有人动了优先级常数，只要违反"慢性需求不打断工作"就会红。

**坑 3：`retreat` 该不该越权？我原本想当然地回答"该"，是自测纠正的。**

我一开始把它归进"保命例外"，断言它高于 work。实测 66 < 70，红了。
然后想清楚：**`retreat` 的条件是"低血 + 没有贴身威胁"** ——
她**并不在流血**，只是状态不佳。而 work 是玩家亲口派的活。
如果"血低于 8 就搁置玩家的活"，被打一下（很常见）她就会停手，"不打断工作"成空话。

→ 真正配越权的只有两个：`forage`（再饿就会掉血、跑不动，**正在滑向死亡**）、
`shelter`（不处理就会**被持续耗死**）。两者都是"不处理就真的会死"。

### 关键判据：`shelter` 刻意只做"紧急遮蔽"，不做 3×3 土屋

理由与 P1c 一致：**先要一个"世界状态真的改变了"的动作**，
而不是一个听起来完整但必然中途失败的复杂计划。
`/shelter` 端点实现要点：

- 封她脚下 4 个水平相邻格的**上下两层**（y 与 y+1）——
  单层封不住（僵尸高 1.95 格，能从上面越过来）
- **最少留一面不封（留门）** —— 封死会让她卡在里面出不来，
  **后续所有动作全部失效，比不搭还糟**
- 只往**空气格**放，绝不覆盖已有方块（尤其不动 `isPlayerBuilt` 的，P21）
- 复用 `/place` 的 `planPlacement` 几何判定，**不另写一份**（P2b/P18）
- 返回里如实汇报 `keptOpen`（哪个方向留了门）——调用方要能知道她出得来

### 自测

```
decision:  71 → 116 通过（+45 条，含 P24 的完整回归段 [8/8]）
autopilot: 85 → 106 通过（+21 条，猎物判据穷举 + capability 新字段证据链）
```

**其中最重要的一条**是 decision 的 `★ 最空的状态下菜单不为空`：

> P24 的故障形态是"菜单里没有那一类动作"，而菜单为空**不会报错、不会崩、
> 不会留下任何日志** —— 她只是永远选 idle。
> 也就是说：**这是一个沉默的故障，只有显式断言才能发现它。**

### 待验证（实机）

- [ ] 实机跑一段时间，`GET /autopilot/events` 里应能看到
      `menu` 包含 `shelter`/`gather`，且 `action` 真的落到这些动作上
- [ ] `shelter` 端点的实机表现（她真的会放方块吗？留的门对不对？）
- [ ] 她能否在无人派活的情况下，真的攒出建材并搭起遮蔽

---

## P28 —— 她跑去打流浪商人的羊驼（`hunt` 的白名单凭感觉写的）

**发现时间**：2026-09-25 凌晨（P24 实机验证时立刻暴露）
**严重度**：🟡 中（会得罪商人、且打不到）
**状态**：✅ 已修

### 症状

P24 修复后第一次实机跑到 `hunt`，`GET /autopilot` 显示：

```
action: 打了 trader_llama（命中 0 次）
lastDecision: {"action":"hunt","menu":["hunt","explore","idle"]}
```

周围实体：

```
unknown          | kind=other     | dist=5.8
trader_llama     | kind=mob       | dist=12.9
wandering_trader | kind=other     | dist=14
trader_llama     | kind=mob       | dist=14.5
```

**周围只有流浪商人和他的两只羊驼，没有鸡牛猪。**

### 根因（三层都错）

我把 `llama` 写进了 `pickPrey` 的 PASSIVE 白名单，**理由只是"它看起来像被动生物"**：

1. **羊驼是中立生物** —— 打它会激怒它；而它身边的 `wandering_trader`
   是玩家可能需要的交易对象。为了"找吃的"去得罪一个商人，是纯粹的负收益。
2. **羊驼不掉肉**（原版只掉皮革）—— 打它根本解决不了饥饿问题。
3. **距离 12.9 格，超出 `radius: 6`** —— 所以 `命中 0 次`，白跑一趟还暴露了自己。

第 3 点还暴露了另一个缺陷：**`pickPrey` 没有任何距离约束**，
而"走过去打"这个动作本身要求她先接近 —— 接近 12 格外的目标意味着
穿越未知地形，风险远大于收益。

### 修复

```js
// 白名单收紧到"确定掉肉/可食用"的和平生物
const PASSIVE = ['chicken','cow','pig','sheep','rabbit','duck','turkey'];
//   ↑ 去掉 llama / alpaca / horse / donkey / goat
//      goat 也去掉：原版山羊掉山羊角（要挤奶），不是稳定的肉来源
// 显式排除 llama/alpaca（商队生物，中立，不掉肉）
.filter(e => !/llama|alpaca/i.test(String(e.name || '')))
// ④ 新增：够得着才去；距离未知（undefined）保守跳过
.filter(e => typeof e.distance === 'number' && e.distance <= maxDist)
```

并把 `maxDist` 默认值设为 **5**，且**与 `POST /attack` 的 `radius` 强制一致**
（原本一个 5 一个 6，会出现"挑中了但网桥说够不着"的自相矛盾）。

### 教训

**白名单里的每一项都要能被证据支持，不能靠"感觉它应该算"。**
我要能回答"打死它，我能得到什么吃的" —— 答不出来就不该在白名单里。
这与 P20/P21 是同一条：**判据必须有据可查。**

新加的回归锁里有一条我特别满意：

```
★ 羊驼与鸡并存时，她挑鸡（不会被羊驼骗走）
```

### 附带修正：测试脆弱性

自测里"挑得出最近的鸡"原本用了 `distance: 9` 和 `3` —— 加上距离约束后，
9 那条被过滤掉了，结果**碰巧**还是 3。这是"靠巧合通过"的测试。
改成 `4` 和 `2`（都在上限内），让断言真正检验排序。

### 自测

`autopilot: 106 → 120 通过`（+14 条，含 P28 的白名单穷举与距离约束）

---

## P29 —— ⚠️⚠️ 我用错了 `/scan` 的字段名，导致"自主采集"这条链路从来没接上

**发现时间**：2026-09-25 凌晨（准备实机验证 `gather` 时，先用 curl 核对数据才发现）
**严重度**：🔴 高（**沉默故障** —— 不报错、不崩溃，只是永远不触发）
**状态**：✅ 已修

### 症状

准备验证 `gather` 时，我先 curl 了一次 `/scan` 核对字段，结果：

```
$ curl .../scan?radius=8&verticalRadius=4
grass_block x 200 worth= None toolBlocked= None
dirt        x 360 worth= None toolBlocked= None
andersite   x 293 worth= None toolBlocked= None
```

**`worth` 和 `toolBlocked` 全是 `None`（null）。**

而我在 `buildCapability` / `perform('gather')` 里写的筛选条件是：

```js
.filter(b => b.worth === true && b.toolBlocked === false && b.isPlayerBuilt !== true)
```

→ 条件**永远不成立** → `gatherableCount` 恒为 0 →
`needMaterials` 永远 false → **`gather` 永远不进菜单**。

**也就是说：我刚刚"修好"的自主采集能力，其实一次都不会被触发。**

### 根因（两个错叠在一起）

**① 三个字段名全写错了。**

`/scan` 的真实字段是：

| 我写的（错） | 实际字段（对） | 含义 |
|---|---|---|
| `worth` | **`worthMining`** | 三态：true / false / undefined(模组方块不知道) |
| `toolBlocked`（当成布尔用） | **`needsTool`** | true = 缺工具，挖了白挖 |
| `isPlayerBuilt`（当成字段用） | **`built`** | true = 很可能是玩家建筑 |

我是凭"这个名字应该叫什么"写的，**没有去核对 `/scan` 的实际输出**。

**② 更根本的错误：`/scan` 已经给出了 `mineable` 短名单，我不该再过滤一遍。**

`/scan` 的返回里有一个 **`mineable`** 字段 —— 那是网桥按正确判据
**已经算好的"值得挖"列表**（`worthMining !== false`，并排过序）。

我在 autopilot 里从裸 `blocks` 重新过滤一遍，等于：
- 复刻了一份判据（P2b/P18 的"两处各判一遍"）
- 而且复刻错了（字段名不对）
- 还读的是**没有这些字段**的 `blocks`

### 修复

```js
// ⚠️ 必须用 `/scan` 的 `mineable` 短名单，不要自己从 `blocks` 里过滤
const mineable = Array.isArray(scan?.mineable) ? scan.mineable : [];
const gatherable = mineable.filter(b =>
  b && b.worthMining !== false && b.needsTool !== true && b.built !== true);
```

`S.lastScan` 的存储也补上 `mineable`（`explore` 动作与 `gather` 里现扫都补）。

### 实机验证（修复后）

```
$ curl .../scan?radius=8&verticalRadius=4
mineable count: 6
  grass_block | worthMining= True | needsTool= None | built= None | dist= 0.5
  dirt        | worthMining= True | needsTool= None | built= None | dist= 1.8
  gravel      | worthMining= True | needsTool= None | built= None | dist= 5.3
  bountifulfares:wild_leeks   | worthMining= None | ... | dist= 3.2
  ltc2:underground_oil_ore    | worthMining= None | ... | dist= 7.3
  meadow:limestone            | worthMining= None | ... | dist= 7.6
```

```
GET /autopilot:
  menu: ['gather','hunt','explore','idle']
  lastDecision.action: gather        backend: local
  state.self.needMaterials: true     reasons: ["建材 0 ≤ 8"]
  state.capability.gatherableCount: 6      ← 修复前恒为 0
  state.capability.buildMatCount: 3
  instructMode: solo
```

**她真的去挖泥土了**（`bridge-run.log`）：

```
[goto] mine dirt 成功到达（续期 0 次）
[dig] dirt @ -1,85,-3
[goto] mine dirt 成功到达（续期 0 次）
[dig] dirt @ -1,85,-4
[dig] dirt @ -1,86,-5
[dig] dirt @ -2,85,-4
```

### 教训

**这类 bug 的可怕之处：它不报错、不崩溃，只是"永远不触发"。**

和 P24（菜单里没有那一类动作）是**同一种故障形态** —— 沉默故障。
区别是 P24 是"设计上故意没有"，P29 是"写了但写错了，于是等于没有"。

**唯一能发现它的方式**：
① 显式断言（已加回归锁）；
② **在实机验证前先用 curl 核对一次原始数据** —— 这一步是这次能发现的原因。

> **不要相信"我写的字段名"**，要去读一次真实返回。
> 这和 P20 的"不要相信我以为的判定，要去读 harvestTools"是同一条。

### 新加的回归锁

```
★ 模组方块（worthMining 缺失）算可用 —— "不知道"不该被当成"不行"
★ worthMining === false 明确排除
★ needsTool === true 明确排除（缺工具，挖了白挖）
★ built === true 明确排除（很可能是玩家的建筑，P21）
★ 裸 blocks 不算数 —— 判定只认 mineable
```

### ⚠️ 一条写错过的测试（记下来）

我第一版写的断言是"用错字段名（`worth` 而非 `worthMining`）→ 结果为 0"。
**实测不是 0**，因为 `{name:'dirt', worth:true}` 里 `worthMining` 是 `undefined`，
而我的过滤条件 `worthMining !== false` 让 undefined 通过 —— **这是刻意的**
（`/scan` 对模组方块给不出 `worthMining`，"不知道"应该算可用，而不是一票否决）。

所以 P29 真正的防线**不是**"字段名错就返回 0"（数据上分辨不出来），而是
**"只认 `mineable`"** —— 因为它已经是网桥按正确字段名算好的短名单，
我从根上消掉了"用错字段名"的机会。

---

## P30 —— 掉落物掉在她**下方 2 格**，于是永远捡不到（与 P11 同一个错误）

**发现时间**：2026-09-25 凌晨（P24 实机验证时，观察到她挖了 4 块泥土但背包仍为空）
**严重度**：🔴 高（"挖了但拿不到"，与 P25 同属采集链路）
**状态**：✅ 已修（三处），待实机验证

### 症状

P24 实机跑起来后，`bridge-run.log` 显示她连着挖了 4 块泥土：

```
[dig] dirt @ -1,85,-3
[dig] dirt @ -1,85,-4
[dig] dirt @ -1,86,-5
[dig] dirt @ -2,85,-4
```

但 `GET /inventory` **始终是空**，而 `GET /status` 显示：

```
pos: (0,87,-2) → 后来 (-1,87,-3)       ← 她在 y=87
dig 的位置: y=85~86                      ← 掉落物在 y=85
currentAction: picking up 3 drops
```

**她在 y=87，掉落物在 y=85 —— 垂直差 2 格。**

### 根因

三处寻路目标的构造都是：

```js
new goals.GoalNear(d.position.x, d.position.y, d.position.z, 1)   // ← 用掉落物的 y
```

`GoalNear` 的球心是**掉落物自己的坐标**，半径 1。也就是要求她
**走到 y≈85 那一层**才算"到达"。而 y=87 → 85 是两格落差，
寻路器配置 `canDig=false`（只绕不拆）找不到下去的路 →
原地打转 → 超时 → 背包为空。

**而日志上一切正常**（`picking up 3 drops`、`found: 3`），所以极难发现。

### 根因之根因：P11 修过同一个错误，我只修了一处

这是最值得记住的部分。**P11 当时修的是 `/mine` 的寻路球心**，
结论写得很清楚：

> 正确的语义是：**在"她已经站得住的高度"上，水平靠近到够得着**。
> · Y 用她自己的 y —— 不去要求她改变高度
> · 只约束水平距离

**但我只改了 `/mine` 那一处，没有 grep 全仓看还有几处在用同样的写法。**

这正是 **P14 的教训**（"修一个反模式时，先 grep 它在全仓出现几次"），
而我这次**又一次没做**。台账里 P14 已经写过一次，这是第二次犯同一个方法论错误。

### 修复（三处）

`grep -n "GoalNear(" bridge-server.js` 找出全部 7 处，逐一核对：

| 行 | 位置 | 状态 |
|---|---|---|
| 1849 | `sweepUpDrops` | ❌ 用 `d.position.y` → **改为 `selfY`，半径 1→2** |
| 3191 | `POST /pickup` | ❌ 用 `p.y` → **改为 `selfY`，半径 1→2** |
| 3948 | `POST /mine` 主体 | ✅ 已经是 `eyeY`（P11 修过） |
| 4153 | `POST /mine` 残余清扫 | ❌ 用 `d.position.y` → **改为 `mineSelfY`，半径 1→2** |
| 4806 | `POST /flee` | ✅ 已经是 `self.position.y` |

```js
// ⚠️ 球心的 y 必须用她自己的高度，不能用掉落物的。
const selfY = Math.floor(bot.entity?.position?.y ?? 0);
await Promise.race([
  bot.pathfinder.goto(new goals.GoalNear(d.position.x, selfY, d.position.z, 2)),
  sleep(...),
]);
```

半径同时从 1 放到 2 —— 掉落物会散落，1 格太紧；拾取判定本来就只看水平距离。

### 编辑事故（记下来）

改 `sweepUpDrops` 时我的第一次编辑把代码搞乱了：
- 删掉了 `clearPathfinderGoal` 调用和 `selfY` 定义
- 并造成 `1849`/`1854` **两处完全相同的重复块**

靠 `grep -n "GoalNear("` 复查时发现（同一断言出现两次），
再读那一段源码确认并删掉重复。

**教训：大段替换后必须 grep 一次关键锚点，确认没有重复或缺失。**
`--check` 只验语法，**语法正确不代表语义正确**。

### 待验证

- [ ] 重启后观察 `GET /inventory` 是否真的拿到泥土
- [ ] `bulkSweep.picked` 与 `dropsPicked` 的口径一致性

---

## P31 —— `shelter` 与 `gather` 互相锁死（实机死循环）🔴

**发现时间**：2026-09-25
**状态**：✅ 已修（`decision.js` 1 处判据 + 3 组自测 + `autopilot.js` 退避机制）

### 症状（实机）

重启 autopilot 后，事件流**连续 40 条 decision 全是 `shelter`**，
20 次 outcome **全是同一句错误**：

```
"error": "没有可以放置的方块，无法搭遮蔽（需要先去采集）"
```

`state.self` 显示 `needShelter: true`、`matStacks: 0`。

### 根因

`decision.js` 的 `buildActionMenu` 里：

```js
if (self.needShelter) add('shelter', 74);    // 只看"天黑了"
if (self.needMaterials) add('gather', 50);   // 唯一能满足前置条件的，被永久压制
```

`shelter` 是**有前置条件的动作**（手里得有方块放），但它的判据只看天色。
于是：`shelter`(74) 稳居第一 → `perform` 报告"没方块" → **它没有任何副作用**，
世界状态一个字没变 → 下一 tick 判据完全相同 → 又选 `shelter`。

而 `gather`(50) 永远轮不到 → `matStacks` 永远是 0 → **自 locks 死**。

### 这是 P24 的镜像

| | 形态 | 后果 |
|---|---|---|
| **P24** | 动作**根本不在菜单里** | 她永远不动（静默） |
| **P31** | 动作在菜单里但**永远够不着** | 她疯狂空转（假忙） |

两者都不崩溃、不报错、日志看着还挺忙 —— 同属**沉默故障**。

### 修复 A：`shelter` 补上它本来就隐含的前置条件

```js
if (self.needShelter && (cap.matStacks || 0) > 0) add('shelter', 74);
```

`matStacks > 0` = "手里有砖可砌"。加上之后：
夜晚 + 空背包 → shelter 不进菜单 → `gather`(50) 成为最高分 → 她去采土 →
`matStacks > 0` → 下一 tick shelter 进菜单 → 搭起来。**这才是自驱动发育链路。**

⚠️ 不能用 `hasMaterials`（周围有可采的建材）当这个条件 —— 那是"**外面**有矿"，
不是"**手里**有砖"。差一个词，用错会在"手里没砖、外面也没矿"时重新锁死。

### 修复 B：自主动作的**失败退避**（防第二层锁死）

修了 A 之后，如果 `gather` **也**失败（周围真没可采的），`needMaterials` 依然 true
→ 菜单依然只剩 `gather` → **依然无限空转**。我只是把死循环从 shelter 搬到了 gather。

所以 `autopilot.js` 新增 `selfFailures` 表 + 三个纯函数：

```js
function noteSelfFailure (table, action, now)   // 记账 + 指数退避，封顶 90s
function selfActionBlocked (table, action, now) // 是否在退避期
function clearSelfFailure (table, action)       // 成功清零
```

接入三处：`chooseAction` 过滤菜单、tick 里按 outcome 记账、`SELF_ACTIONS` 界定范围。

**必须自我衰减** —— 否则一次网络抖动就永久放弃，那是另一个极端。

### 三个自测抓出来的坑

**坑 1 — off-by-one 的语义歧义**：第一版 `noteSelfFailure` 用 `>= grace`，
`grace=2` 时第 2 次失败就罚，与注释"前两次不罚"**差一个**。改成 `>`，并定死口径：
`grace = N` ⇔ "允许 N 次免费失败，第 N+1 次开始罚"。两处（note / blocked）必须同口径。

**坑 2 — 测试本身锁死了 bug**：原有的断言是
```
check('天黑了 → shelter 进菜单', has8({...emptiest, capability:{isDay:false}}, 'shelter'), true)
```
而 `emptiest.matStacks = 0`（**空背包**）—— 它断言"空背包 + 天黑 → 菜单里有 shelter"，
**正是那个死循环**。测试通过 ≠ 行为正确，它会忠实地把 bug 锁进回归集。

**坑 3 — 断言写错，不是代码错**：`p.gather > p.explore` 红了。查下去发现
`explore` 的进入条件是 `cap.canScan`，而 fixture 里是 `false` → `explore` 不在菜单
→ `50 > undefined` = false。**是断言选错了场景**，但它红得有价值：逼我把
"这条断言到底在测什么"想清楚。

**坑 4 — 编辑吃掉函数头**：加退避函数时，`Edit` 把 `async function runTask (task) {`
这一行吃掉了，`--check` 立刻报 `await is only valid in async functions`。
**又一次验证"大段替换后必须 grep 关键锚点"。**

---

## P32 —— `/pickup` 谎报成功（动作层的"我以为"）🔴

**发现时间**：2026-09-25（P31 修完重启后的第一批实机数据）
**状态**：✅ 已修（bridge + autopilot **两端**）

### 症状

P31 修完后，事件流变成 **40/40 全是 `pickup`**，**零错误**，
而 `inventoryCount` 恒为 0 —— 她脚下明明有 3 件掉落物。

### 根因：两端各自的谎言，合起来等于"永远成功地捡不到东西"

**bridge 端**（`/pickup`）：
```js
// 注释早就写对了：
//   ⚠️ `walkedTo` 是"走到了"不是"捡到了"。捡了几个得看背包 ——
//      客户端没有"拾取成功"这个事件，只能靠前后对比。
// 但返回体里**从来就没有 picked 这个字段**。它只说了，没做。
return { found, walkedTo, failed, note: '...走到即会拾取' };
```

**autopilot 端**（`perform` 的 `pickup` case）：
```js
if (r?.found === 0) return { ok: true, note: '已经没有掉落物了' };
return { ok: true, note: `走到 ${r?.walkedTo}/${r?.found} 件` };  // ← 走到 ≠ 捡到
```

**两端都报成功。** 于是所有基于 `ok` 的上层机制（失败退避、重试上限、
任务放弃计数）**全部失效**。

### 这是 P26 在动作层的复现

P26 的原话：「**我以为它跑完了**」和「**它真的跑完了**」是两件事。
P26 发生在**观测层**（`goal_updated` 的 `who` 字段是废的）；
P32 发生在**动作层**（动作自己谎报成功）。

**教训：一个动作的返回值里必须有"世界真的变了"的证据**，
不能只有"我发了请求 / 我走到了"。判据住在看得见真相的那一侧（P20/P21/P29）。

### 修复

bridge 新增两个纯函数 + `/pickup` 改造：
```js
function inventoryFingerprint ()      // 背包快照 {items:{name:count}, total}
function fingerprintDelta (before, after)  // **真的多了**几件（只数变多的）
```
`/pickup` 循环前后对比，返回：
```json
{"found":3, "walkedTo":3, "picked":0, "gained":0, "ok":false,
 "note":"走到了掉落地，但有几件没进背包（可能被地形挡住或在脚下够不着）"}
```
**`ok` 改成"真的进背包了没"** —— 谎报被消除。

autopilot 端判据换成 `picked`，且 `pickup` 加入 `SELF_ACTIONS`（让它能被退避）。

### ⚠️ 只数"变多的"，不数净变化

拾取过程中她可能同时吃掉东西。净变化会把"捡了 3 个、吃了 1 个"算成 2，
那是错的答案。`gained`（净变化）另算，两者用途不同。

### 实测验证（✅）

```
POST /pickup  →  {"found":3, "walkedTo":3, "picked":0, "ok":false, ...}
```
修复前是 `walkedTo: 3` → 上层当成功。现在如实报失败。**P32 验证通过。**

---

## P33 —— `GoalNear` 的半径是**球**不是"必须站到某格" 🔴

**发现时间**：2026-09-25（P32 验证过程中，被 `picked: 0` 逼出来）
**状态**：✅ 已修（三处统一走 `reachableStandY`）

### 症状

P32 修好后 `/pickup` 如实报失败，于是可以**诊断**了：
`walkedTo: 2` 但 **她的位置一动没动**（`(-1,87,-4)` → `(-1,87,-4)`）。

### 根因

P30 的修法是"球心一律用 `selfY`"。但这**引入了反向的错**：

- 球心锁在她**当前**高度 → 她**永远不下坑** → 站在坑沿上够不着坑底
- `GoalNear` 的判据是**欧氏距离 ≤ r**：球心 `(x, 86, z)`、r=2、她 `y=87`，
  水平距离只要 ≤ √3 ≈ 1.73 就算"到达" → **她不动，判定成功**
- 而**拾取是 3D 碰撞箱判定** → 差那 1 格高度就是拿不到

实测地形（她站 `(-1,87,-4)`）：
```
y=86:  air(!)   ← (-1,86,-5) 空的，只差 1 格就能下去
y=85:  air      ← 掉落物在这里，站在这层就能捡
y=84:  andesite ← 坑底，实心可站
```
**她有能力下去**（2 格落差），但 `GoalNear` 判定"已到达"所以不会动。

### 两个相邻的错

| | 球心 | 后果 |
|---|---|---|
| **P30** | 用物品的 y | 她下不去 → 原地打转 → 超时 |
| **P33** | 一律用 selfY | 她永不落坑 → 够不着 |

### 修复：`reachableStandY(dropY, selfY)`

| 物品相对她脚底 | 目标层 | 理由 |
|---|---|---|
| 上方（`dy > 0`） | `selfY` | 不为了够东西往天上爬 |
| 同层或下一层（`-1 ≤ dy ≤ 0`） | 物品的 `y` | **1 格落差可以直接走下去，这是能捡到的关键** |
| 更深（`dy < -1`） | `selfY - 1` | 站到最近的可站层，靠拾取半径够 |

**关键不变量：返回值永不低于 `selfY-1`** —— 更低就要挖穿地形了，
而 `canDig=false` 不会挖，返回更低的值就是让它超时打转（P30 的病）。

**三处统一**（`sweepUpDrops` / `/pickup` / `/mine` 残余清扫）——
这次**先 grep 再改**，P14 的教训第三次终于记住了。

### ⚠️ 但 P33 的修复**没有解决问题**，反而暴露了 P34

修完后实测：`walkedTo: 2`、`picked: 0`、**位置仍然没动**。
因为 `GoalNear` 的球判据在"水平够近 + 垂直差 1"时**照样返回到达**。
换球心治不了"她不肯主动往下走"。→ 见 P34。

---

## P34 —— 寻路器不会主动往下跳（`canDig=false` 的结构性限制）🔴

**发现时间**：2026-09-25（P33 修复实测后）
**状态**：⏳ 已定位，**修复方案待定**（需要按键控制，属较大的改动）

### 症状

P33 修复后，`/pickup` 的 `walkedTo: 2, picked: 0`，她位置纹丝不动。
地形显示她**只要往下走 2 格**就能捡到（`y=85` 可站，`y=84` 实心）。

### 根因

`GoalNear` 是"球判据"：水平够近（≤ √3）就返回到达，**不会为了"垂直更近"而移动**。
而她要下到坑底需要：
- 从 `y=87` 走到 `y=86`（1 格落差，可以走）
- 再从 `y=86` 走到 `y=85`（又一个 1 格落差）

寻路配置 `canDig=false`（只绕不拆）+ 目标是"到达球内"→
**它没有动机去走那两格**。这不是参数问题，是**目标语义与地形不匹配**。

### 可能的修法（未决）

1. **点式目标**：改用 `GoalBlock(坑底格)` —— 强制她走到具体某格。
   风险：坑底可能不适合站立（有岩浆/水），且会让"够不着"的情况变成硬失败。
2. **按键辅助**：已知桥里有 `setControlState`（`/jump` 在用）。
   可以先 `GoalNear` 接近到坑沿，再**主动向下走一格 + 跳**。
   代价：需要写一小段"下台阶"的逻辑，且有掉进危险格的风险。
3. **接受现状**：认为"掉在够不着的坑底的物品就是拿不到"，
   **靠 P32 的退避机制让她去做别的事**。这也是一种合理的产品决策。

倾向 **先按 3 走**（退避机制已经能让链路不卡死），
把 1/2 作为后续增强。**理由**：P34 的修复涉及"主动带她下坑"，
那是新的行为面，风险（掉进岩浆/水里）与收益（捡回几块泥土）不成比例，
而用户体验上"她卡住捡不到"这件事已经被 P32/P33 的退避机制解决了。

---

## P35 —— `gather` 也谎报成功（P32 的同型，第三次出现）🔴

**发现时间**：2026-09-25（P31 修完后观察 `gather` 的实际产出）
**状态**：✅ 已修（`autopilot.js` 的 `gather` case 判据换成 `dropsPicked`）

### 症状

事件流里 `gather` 报 `ok: true`（8 次成功），她**真的在移动**（位置从
`(-1,87,-4)` 移到 `(-6,88,-6)`），但 `inventoryCount` 恒为 0、`matStacks` 恒为 0。

即：**菜单正确、动作在跑、每次都"成功"、背包永远是空的。**

### 根因

```js
const r = await post('/mine', { blockName: cand.name, count: 4 });
S.action = `采了 ${r?.mined?.length ?? 0} 个 ${cand.name}`;
return { ok: true, note: `${cand.name} ×${r?.mined?.length ?? 0}` };
//              ↑ mined = 拆掉了几块方块，不是"拿到几件"
```

实机数据对照：`POST /mine` 返回 `"mined": 2, "dropsPicked": 0`。

| 字段 | 含义 |
|---|---|
| `mined` | **拆掉了几块方块**（世界变了：方块没了） |
| `dropsPicked` | **真的进背包了几件**（我拿到了吗） |

在"掉落物够不着"时两者**完全分岔**。

### 这是同一个 bug 的第三次出现

| | 做了什么 | 误当成 | 实际应为 |
|---|---|---|---|
| **P32** `/pickup` | `walkedTo`（走到了） | 成功 | `picked` |
| **P35** `gather` | `mined`（挖掉了） | 成功 | `dropsPicked` |

**而我在修 P32 时没有 grep 全仓找同类** —— P14 的教训**第四次**违反。
"修一个反模式时先 grep 全仓"这条原则，我在这个项目里已经违反四次了。
它值得被提升为**硬性流程**：任何"某某字段不代表某某"的修复，
必须跟一次 `grep -n` 找出所有同类消费点。

### 为什么这个谎报比"捡不到"更严重

`ok: true` → 退避永远不触发 → `needMaterials` 永远是 true →
她**永远在采、永远采不到、永远觉得缺砖** → 又是一种"表面上很忙"的沉默死循环。

### 修复

判据换成 `dropsPicked`，并区分两种失败（排查时需要能分辨）：
- `mined > 0 && picked === 0` → `挖掉了 N 个 X 但一件没拿到（掉落物够不着）`
- `mined === 0` → `没能挖到 X（目标可能已消失）`

---

## P36 —— `/mine` 越挖越低，掉落物系统性沉积在坑底 🔴

**发现时间**：2026-09-25（P35 修完后观察剩余掉落物）
**状态**：⏳ 已定位，属结构性问题（与 P34/P38 同源）

### 症状

一次 `/mine` 之后的世界状态：

```
她：      (-7, 90, 2)     ← y=90
掉落物：  16 件，**全部**在 y=85/86  ← 坑底
最近一件  9.8 格（超出 /pickup 默认 radius: 8）
背包：    空
```

**她挖出了一个巨大的坑，自己爬到了高处，16 件掉落物全部沉在坑底拿不到。**

### 根因

`/mine` 的循环是「找方块 → 走过去 → dig → 立刻找下一个」。
在**斜坡或山体**上连续挖时，她越挖位置越低，然后寻路把她带到别处 ——
**她再也回不到坑底**。

`sweepUpDrops` 的设计其实考虑过这件事（`dropAnchors` + 质心 + `bulkSweep` +
两轮残余清扫），但它的**靠近方式是水平行走**：
```js
bot.pathfinder.goto(new goals.GoalNear(d.position.x, goalY, d.position.z, 2))
```
而 `GoalNear` 是**球判据** —— 见 P33。她会在"水平够近"时停下，
不会为了"垂直更近"继续下行。**所以坑底的东西她够不着。**

这是 P19（深挖掉落物丢失）的**规模化实机确认** —— 之前只是偶发，
现在是"挖得越多、丢得越多"的系统性行为。

---

## P37 —— 我一度以为 `picked` 统计不准（**自我纠正：不是 bug**）🟢

**发现时间**：2026-09-25
**状态**：✅ **结论：代码是对的，是我读错了**

### 我的怀疑

`POST /pickup {"radius":16}` 返回 `picked: 0`，但紧接着 `GET /inventory`
显示 `dirt × 2`（`totalStacks: 1`）。看起来像"拿到了 2 个却报 0"。

### 实际原因

那 2 个泥土是**上一次** `/pickup` 调用拿到的。本次调用的 `snapBefore`
已经是 `{dirt: 2}`，本次确实一件没捡到 → **`picked: 0` 是正确的**。

`fingerprintDelta` 单独验证也正确（0→2 得 2，1→2 得 1）。

### 为什么还是值得记

**这个误判本身有价值 —— 因为它证明了上一次 `/pickup` 真的成功了。**

`radius: 16` 那次调用：她位置从 `(-7,90,2)` → `(-6,88,-7)`，**她下到了坑里**，
背包从 0 → 2。**P33 的修复是有效的**（她确实会为了够东西而下行）。

⚠️ 教训：**跨调用的状态对比，一定要看清"这次调用之前的状态是什么"**。
我把"上一次的成果"当成了"这一次的产出"，差点去修一个没坏的东西。

---

## P38 —— 她的下降是"不彻底的"（`GoalNear` 球判据的必然结果）🔴

**发现时间**：2026-09-25（P37 澄清之后）
**状态**：⏳ 已定位，**已实现最小修复**

### 症状

`radius: 16` 的 `/pickup` 让她从 `y=90` 下到 `y=88`（**下行了 2 格**，证明会走），
但坑底物品在 `y=85` —— **还差 3 格**。第二次调用 `picked: 0`。

### 根因（与 P34 是同一件事的两个面）

`GoalNear(x, goalY, z, 2)` 的判据是**欧氏距离 ≤ 2**。
她降到 `y=88` 后，到`(x,85,z)` 的距离是 `sqrt(水平² + 3²)` ——
只要水平距离 ≤ √(4−9)…… **负数**。也就是说**垂直差 3 格时，球内根本没有点**，
她**永远不可能"到达"**。于是 `goto` 走满超时，而她只下行了 2 格（寻路器的局部最优）。

**P30 / P33 / P34 / P38 是同一个问题的四个面：**
> `GoalNear` 是**球判据**，它描述的是"到达某个球内"，
> 而"够得着某个掉落物"描述的是**碰撞箱重叠**。
> 用球判据去实现接触需求，在垂直落差大于球半径时**必然失败**。

### 已实现的最小修复：自适应半径

在 `/pickup` 里，**球心用 `reachableStandY`（P33），半径按垂直落差自适应**：

```js
const vertGap = Math.abs(selfFeetY - goalY);   // 还需下行几格
const r = Math.max(2, vertGap + 1);            // 保证球内一定有点
```

道理：垂直差 3 格时，半径至少要 > 3 才能让球内存在可站的点。
`+1` 是余量。这样 `goto` 有**明确的可达目标**，她就会真的下到坑底那一层。

⚠️ 这仍然**不保证**够得着 —— 如果坑壁是垂直的、她下不去，
她会走满超时然后由 P32 的退避机制接管（**不会卡死**）。
这是"尽力而为 + 有界失败"的取舍，不是"保证成功"。

---

## P39 —— 退避事件里的 `backoff=-1790289721s`（两个错叠加）🟡

**发现时间**：2026-09-25（观察 `self_backoff` 事件流时）
**状态**：✅ 已修

### 症状

```
t7 self_backoff pickup  fail=2 backoff=-1790289721s
```

那个数字约等于 `-Date.now()/1000` —— 也就是 `0 - Date.now()`。

### 两个错叠在一起

**① 阈值不一致（真 bug）**

`noteSelfFailure` 里是 `failures > grace`（我到 P31 的坑 1 才修正成 `>`），
但**记账点**写的是：

```js
if (rec.failures >= (CFG.selfFailGrace ?? 2)) {   // ← 这里是 >=
  events.append({ ..., untilMs: rec.until - Date.now() });
```

`failures === grace`（= 2）时，`noteSelfFailure` **还没设退避**（`until` 仍为 0），
而记账点却认为"该记一笔" → `0 - Date.now()` = **巨大的负数**。

**同一个判据写在两个地方，就会漂移** —— 这是本项目的老毛病
（P2b「两处各判一遍」、P18、P29）。这次它现身在一个"日志字段"上，
所以只影响可读性、不影响行为，但**没被自测抓住**（因为它是日志，不是返回值）。

**② 字段名撒谎（认知 bug）**

字段时间叫 `untilMs` —— 读起来像**时间戳**（"到什么时候为止"），
实际装的是**时长**（"还有多久"）。

我第一眼看到 `-1790289721s` 时的反应是"时钟不对吗"，
**因为名字把我引到了错误的方向**。名字骗的不只是读者，还有排查问题的人。

### 修复

- 阈值统一成 `> grace`，并注释说明"必须与 `noteSelfFailure` 同口径"
- 改名 `backoffMs` / `backoffSec` —— **明确是时长**
- `Math.max(0, ...)` clamp 到非负 —— **双保险**：即使将来逻辑再漂移也不会出负数

### 教训

1. **同一个判据写在两处，一定会漂移。** 阈值 2 这件事应该有**一个**定义点。
2. **字段名是一次契约声明。** 名字说"时间戳"就得是时间戳。
   用 `At` 结尾表示时刻、`Ms`/`Sec` 结尾表示时长 —— 这类约定值得坚持。
3. **日志字段也要有断言。** 它不进返回值、不影响行为，所以**没有任何机制会检查它**。
   这次的 `-1790289721s` 在事件流里挂了很久才被我看到。

---

## P40 · `/shelter` 从未成功过一次 —— 而我第一轮诊断错了

**日期**：2026-09-25
**严重度**：🔴 高（主线目标「建立庇护所」的字面实现，12 次调用 `placed` 恒为 0）
**状态**：✅ 已修（含一次**自我推翻**）

### 症状

`POST /shelter` 从上线起**一次都没成功过**。实机 12 次调用，全部返回同一句：

```
脚边没有可放置的空位（脚下可能已经被封住，或四周全是实心）
```

而她**显然在开阔地里**（`isDay: false`，站在有草、有花、有树的野外）。

### 第一轮诊断（错的，记下来当反面教材）

我看到她的 `exact` 坐标是 `{x: -9.5006, z: -6.5}` —— **半格偏移**，
身体骑在 `x=-10/-9`、`z=-7/-6` 的**边界**上。于是：

> "`Math.floor(-9.5006) = -10`，格子归属算错了！她真正站的格是另一个！"

我据此写了"`floor` / `round` 双候选"的代码，还加了一整套自测去锁它。

**这个诊断是错的。** 而且我犯了一个具体的错误：

- 我用**心算**得到 `Math.round(-6.5) = -7`，然后拿"`floor` 和 `round` 给出同一个值"
  这个自相矛盾的现象当作"取整一定有问题"的证据。
- 实际 `Math.round(-6.5) = -6`（JS 的 `round` 向 **+∞** 取整）。
- **错误的心算被当成了实测数据。** 我甚至没跑一次逐格探测就下了结论。

### 第二轮：逐格探测（真相）

用 `/block` 把她周围 `y=86/87/88` 三层完整探了一遍：

```
她 exact = (-9.5006, 87.0, -6.5)
她这格     (-10,87,-7) = air        ← Math.floor 归属**是对的**
她脚下     (-10,86,-7) = andesite   ← 有地面，不是悬空

4 方向 × 2 层（= 桥探测的 8 个候选格）：
  x+  (-9, 87,-7)=dirt        x+  (-9, 88,-7)=grass_block
  x-  (-11,87,-7)=andesite    x-  (-11,88,-7)=grass_block
  z+  (-10,87,-6)=dirt        z+  (-10,88,-6)=dirt
  z-  (-10,87,-8)=dirt        z-  (-10,88,-8)=grass_block
  → **8 格全是实心，一个 air 都没有**
```

**所以那句"四周全是实心"说的是实话。** 她正站在一条**天然形成的一格宽缝隙**里
（头顶 `(-10,88,-7)=air`，说明缝只有一格高、四面被 dirt/andesite/grass_block 封死）。

这地方**本来就有遮蔽** —— 既不需要、也不允许再封。

### 真正的根因（比"取整"深一层）

不是取整，不是白名单，而是**选址假设**：

> `shelter` 只会"原地封四周"，而她随机游走后经常正好站在这种天然闭合的缝里
> → 必然失败 → `placed: 0` → 而失败**没有副作用**（世界没变）
> → 下一 tick 判据相同 → 又选 shelter → **P31 那个死循环的翻版**。

### 修复（两件都做）

1. **先尝试挪一格**：四周全实心时，在半径 3 内找"至少有 2 个可放空位"的落脚点
   （要求：脚+头可站、脚下有地面、不致命），走过去后**递归重试一次**。
   半径刻意小 —— 理由与 P34 一致：大范围移动是新行为面，
   掉进岩浆/水的风险与"多封一格"的收益不成比例。
2. **挪不成 → 如实判定"已有天然遮蔽"并返回成功**：
   ```json
   {"placed": 0, "naturalShelter": true, "sheltered": true,
    "message": "已经在一个天然掩体里（四周 8 格全实心，无需再封）",
    "probe": {"at": {...}, "sample": "(-9,87,-7)=dirt ..."}}
   ```
   ⚠️ **这不是粉饰失败**：她这格是 air、脚下是实心地面、四周（含头顶层）全实心
   —— 从"躲怪"的角度看，她**确实已经在一个天然掩体里**。
   报 `sheltered: true` 是为了让 `needShelter` 得到满足，**跳出死循环**。
   但 `placed: 0` 诚实说明"我一块砖都没放"，`naturalShelter: true` 说明为什么仍算成功，
   `probe.sample` 带上证据供事后核对 —— **绝不默默当成"我搭好了"**。

### 顺带修掉的同型问题（P41）

`autopilot.js` 的 `shelter` case 也是**谎言家族的一员**（P32 / P35 之后的第三次）：
旧代码无视返回值直接 `return { ok: true }`，于是 `placed: 0` 时照样报成功。

**教训：改一个动作的"成功判据"时，必须 Ctrl+F 找 `ok: true` 的所有直写点。**

修法：判据改用 `r.placed`，并与网桥的 `sheltered = placed >= 2` 口径对齐；
`placed < 2` 时如实失败并带上失败原因（`failed[].reason`）。

### 第一轮写对、予以保留的部分

- **多格参与探测 + 去重**：比"只挑一个 `cx/cz`"更稳，居中/跨格都对。
  （顺带纠正一个直觉：`x=3` 时身体盒 `[2.7, 3.3]` **确实横跨格 2 与格 3**；
  而 `x=-9.5006` 时盒 `[-9.8, -9.2]` **完整落在格 -10 内**。得让几何说话。）
- **自己身体占的格由 `place.js` 的 `bodyOccupies` 排除** —— 不另写判定。
- **白名单复用 `place.js` 的 `AIRY`**：
  ⚠️ 我第一轮**新建了一个 `AIRY_NAMES` 数组**，那是同一判据的**第四处副本**
  （`place.js` 早有 `AIRY` 正则）—— 正是 P39 说的"写两处一定漂移"。**已删除。**
  同时明确区分两个语义：`isAiryForPlace`（能不能当参照物/往里放）
  vs `isStandable`（她能不能站进去，**不含岩浆**）。

### 验证（实机）

同一位置、同一坐标（`-9.5, 87, -6.5`）、同一背包（`dirt × 13`），
那个失败了 12 次的地方：

```json
{"success":true,"placed":0,"naturalShelter":true,"sheltered":true,
 "message":"已经在一个天然掩体里（四周 8 格全是实心，无需再封）"}
```

**死循环解除。** `/shelter` 不再抛错，返回诚实且可核对的结果。

### 教训

1. **心算不能当证据。** 我把 `Math.round(-6.5)` 算成 `-7`，然后拿这个算错的值
   支撑了一整套（错误的）修复方案和自测。**任何关于数值行为的断言，先跑一行代码。**
2. **"错误信息指向的层"可能是错的层。** 「四周全是实心」这句话本身没问题，
   但它让我以为问题在**白名单/取整**（同一层），而真相在**选址**（上一层）。
   这次能翻案，靠的是**逐格探测原始方块** —— 所以探测留痕
   （`state.__lastShelterProbe` / `GET /debug/shelter-probe`）必须保留。
3. **"没有可放置的空位"有两种含义，不能共用一句错误信息**：
   ① 天然闭合（已有遮蔽，**不是错误**）；② 真没地方放。混在一起就必然误判。
4. **修 `ok: true` 类问题要全仓 grep。** P32 → P35 → P41 已经是**第三次**同型；
   P14（"修一个反模式先 grep 全仓"）累计被违反**五次**。
5. **同一个白名单/判据不要新建副本。** 我第一轮差点又加一份（`AIRY_NAMES`）。

---

## P42 · 她被「关」在只有 1 格的孤立空腔里 —— `canDig=false` 下 `No path found`

**日期**：2026-09-25
**严重度**：🔴🔴 **最高**（她**物理上出不来**，主线「持续发育」在当前位置完全停摆）
**状态**：⏳ 已定位，**未修**（需要决策：这是 `canDig=false` 的**预期行为**，还是需要一条"自救逃逸"通道）

### 怎么发现的

修完 P40 后我发现 `/shelter` 报了 `naturalShelter: true`。顺着"为什么四周全实心"
查下去，顺手试了一下 `/move` —— **四个方向全部 `No path found`**：

```
→ (-11,87,-9): {"success":false,"error":"No path found"}
→ (-10,87,-5): {"success":false,"error":"No path found"}
→ (-9,87,-8):  {"success":false,"error":"No path found"}
→ (-9,87,-5):  {"success":false,"error":"No path found"}
```

### 决定性证据：连通分量 = 1

把她所在 `y=87` 层、`x∈[-14,-4]`、`z∈[-12,-1]` 的**全部 air 格**探出来
（共 21 格），然后从她所在的格做 **4 邻居**泛洪：

```
从 (-10,-7) 出发连通到的 air 格：
    (-10, -7)          ← 只有它自己
总共连通 1 格 / 全层 21 格 air
```

**她被完全隔离在一个单元格大小的空腔里。**

她周围的实况（`/block` 逐格实测）：

```
               +-----------+-----------+
               | z=-8      | z=-6      |
  x=-11        | andesite  | andesite  |
  x=-10        | air ★     | dirt      |
  x=-9         | dirt      | air ★     |
               +-----------+-----------+
     ★ = air，但**对角相邻**，4 邻居不通
```

关键：`(-10,-8)` 和 `(-9,-6)` 都是 **air**，但都只是**对角**相邻 ——
Minecraft 的行走需要**正交**相邻+可站立，**走对角线**在
"两侧都有方块"时是不允许的（这是一个 1 格宽的斜缝，物理上过不去）。

### 与 `canDig=false` 的关系

`pathing.js` 的 `ALLOW_DIG` 默认 `false`（2026-09-25 起，用户明确要求
"寻路器暂时不要挖东西"）。所以寻路器**只能绕、不能拆** —— 绕不出去就
`No path found`。上面那段代码注释里写得很清楚：

> 绕不过去时直接 `No path`，这是**预期行为**，不是退化。

**在这条设计下，P42 是"符合设计"的。** 但它的后果比设计时预想的严重：
她不是"绕远路"，而是**永久困住** —— 所有依赖移动的动作（`gather`/`forage`/
`hunt`/`explore`/`follow`/`goto`）全部失效，只有"原地能做的事"还work。

### 但 `/mine` 不受影响，而且**真的能挖开**

`POST /mine` 走 `bot.dig`，**不经过寻路器**，所以不受 `canDig` 影响。
实测：让她挖身旁的 `dirt`：

```json
{"success":true,"mined":1,"minedBlocks":[{"at":{"x":-10,"y":87,"z":-8},
 "name":"dirt","nowIs":"air","drops":{"seen":1,"picked":1,...}}],
 "dropsPicked":1,"inventoryDelta":1}
```

她**真的挖开了 `(-10,87,-8)`**，而且**捡到了掉落物**（`dropsPicked: 1`，
背包 `dirt` 13→14）—— 这同时验证了 P32/P33/P35/P38 那条链是通的。

**挖开后 `(-10,87,-8) = air`，与她的格正交相邻。**

### 但挖开之后**仍然** `No path found`

这是本轮最意外的一点。挖开后她的 4 邻居变成：

```
  x+ (-9, 87,-7) = dirt       ← 实心
  x- (-11,87,-7) = andesite   ← 实心
  z+ (-10,87,-6) = dirt       ← 实心
  z- (-10,87,-8) = **air**    ← 挖开了！
```

而且 `(-10,86,-8) = andesite`（有地面，可站立）、`(-10,88,-8) = grass_block`
（头顶不空，但只有 2 格高，1.8 格的她是站得下的）。

**按理她能往 z- 迈一步，但 `/move` 仍报 `No path found`。**

已验证的**不是**原因：
- 不是物理层坏：`POST /jump` 返回 `{success:true, jumped:8, onGround:true}`，她能跳。
- 不是目标格式问题：`GoalBlock(x,y,z)` 与 `GoalXZ(x,z)` **都** `No path`。
- 不是目标本身不可达：目标格 `(-10,87,-8)` 确实是 air。
- 不是寻路器残留状态：`/debug/pathfinder` 显示 `goal: null, isMoving: false`。

**已定位（第三条，正确答案）**：**通道只有 1 格高，而她身高 1.8 格，站不进去。**

站位需要**两层**（脚 + 头）。逐格实测挖开后的目标格 `(-10, 87, -8)`：

```
  脚层 y=87 → air        ✓
  头层 y=88 → grass_block ✗   ← 实心！站不进去
```

我一开始以为"挖开了就通了"，是因为只看了**脚层**。她 1.8 格高，
**必须有 2 格高的空间**才能站进去。

把所有**对角** air 格（这些是唯一"看起来通"的方向）的头部空间全查一遍：

| 候选格 | 脚层 y=87 | 头层 y=88 | 能站？ |
|---|---|---|---|
| `(-11,87,-8)` | air | **air** | ✅ **唯一可站** |
| `(-10,87,-8)` | air | grass_block | ✗ 头被堵 |
| `(-9,87,-6)` | air | grass_block | ✗ 头被堵 |
| `(-9,87,-8)` | air | grass_block | ✗ 头被堵 |
| `(-8,87,-8)` | air | grass_block | ✗ 头被堵 |
| `(-11,87,-9)` | air | grass_block | ✗ 头被堵 |
| `(-8,87,-9)` | air | grass_block | ✗ 头被堵 |
| `(-7,87,-9)` | air | grass_block | ✗ 头被堵 |

**唯一可站的 `(-11,87,-8)` 与她是对角关系** —— 而 Minecraft 在两个正交
邻居都实心时**不允许走对角**（那会穿墙）。所以她**确实一步都走不了**。

**`No path found` 是正确的判定，不是 bug。**

之前列的三条假设**全部排除**：
- ✗ 不是寻路器缓存陈旧（`/block` 读到的就是 `air`）
- ✗ 不是薄方块误判（`(-10,88,-8)` 真的是实心 `grass_block`）
- ✗ 不是碰撞盒间隙不足（跟宽度无关，是**高度**不够）

**这条诊断的教训**：我第三次才问对问题。
第 1 次问"取整对不对"，第 2 次问"白名单对不对"，第 3 次才问
**"她到底能不能站进去"** —— 而 `selfIsAiry` 这个函数**是我自己在 P40 修复里写的**，
它检查的正是"脚+头两层"，**我却没有拿它去验证这个目标格**。
**手里有正确的判据，却没用它。**

### 为什么这条比 P40 重要

- P40 是"一个动作失败"，P42 是"**她整个人被困住**"。
- P42 直接阻断主线目标的后半句「**持续发育**」—— 发育需要移动、
  采集、探索，而她一步都走不了。
- P42 暴露的是 `canDig=false` 这条设计的**边界条件没被考虑过**：
  设计时想的是"别拆玩家的房子"，没想"她自己会被自然地形困死"。

### 脱困验证（实机，成功）✅

判据是"头上那层也要挖开"（2 格高）。用 `/mine` 挖 `grass_block`：

```
第 1 次: mined (-10,88,-8) grass_block      picked 0
第 2 次: mined (-9,86,-8) (-9,87,-7)        picked 2
第 3 次: mined (-9,87,-9) (-9,88,-8)        picked 2
→ (-10,88,-8) 变成 air，通道有 2 格高了
```

然后移动：

```
POST /move {"x":-10,"y":87,"z":-8}
→ {"success":true,"arrived":{"x":-9,"y":87,"z":-7},"route":{"replans":0}}

POST /move {"x":-5,"y":87,"z":-5}
→ {"success":true,"arrived":{"x":-4,"y":87,"z":-5},"route":{"etaMs":1964,"replans":1}}
```

**她自由了 —— 本会话第一次真正走动起来。** 背包也从 `dirt × 13` 长到 `dirt × 20`。

这也顺带证明：`/mine`（不受 `canDig` 影响）是**可靠的脱困通道**。

### 待决

1. **要不要给她一条"自救逃逸"**。现在她被困时**完全没有自救能力** ——
   只有人类（我）从外面调 `/mine` 才能救她。这在"自主生存"目标下是个硬伤：
   用户要的是「**自己**建立庇护所并持续发育」，而现在**"自己"这三个字做不到**。
   可选项：
   - **A（推荐）**：`gather` 失败/`No path` 连续 N 次且原地不动 → 判定"被困"
     → 允许**单次** `{ allowDig: true }` 放行，或直接调 `/mine` 挖脚边一格。
     这与用户"寻路器不要挖"的本意**不冲突**：正常寻路仍然只绕不拆，
     只有**被困**这一种情形才挖。`pathing.applyPolicy` 早留好了单次放行口子。
   - **B**：只挖"脚边、非玩家建造、`worthMining !== false`"的一格。
   - **C**：不做。接受"困住就等人救"，并**如实上报**"我被困住了"（至少别静默）。
2. **`/shelter` 现在能判断"她是否被困"吗**？不能 —— 它只看四周有没有空位。
   可以考虑把"被困检测"做成一个**独立能力**（`GET /trapped` 之类），
   让它同时服务于 `shelter`、`gather` 和将来的任务规划。

### 第三条教训（比前两条重要）

**我在同一个 bug 上问错了三次问题**：
1. "取整对不对"（P40 第一轮 —— 错）
2. "白名单对不对"（P40 第二轮 —— 错）
3. "**她到底能不能站进去**"（P42 —— 对）

而第 3 条的判据（脚+头两层）**正是我自己在 P40 修复里写的 `selfIsAiry`**。
**我手里有正确的判据，却没拿它去验证那个目标格。**

→ **教训：写完一个判定函数，第一件事是用它去解释"眼前的失败"，
而不是先怀疑别的层。** 尤其当那个函数是**你自己**刚写的时候。

---

## P43 —— 掉落物"报告 y"不等于"可站层"，`pickup` 的判据要换（2026-09-25）

### 一、症状链

修完 P34 后继续验证，同一个人、同一格物品，反复出现：

```json
{"found":1,"walkedTo":1,"picked":0,"gained":0,"ok":false,
 "note":"走到了掉落地，但有几件没进背包（可能被地形挡住或在脚下够不着）"}
```

她位置**一动没动**（`exact = (-7.67, 86, -7.51)`），而物品就在旁边。

### 二、逐步排除（每一步都实测，不心算）

**Step 1 —— 物品 y 那一格是什么？**

```text
(-7,84,-8) = meadow:limestone  solid=True
(-7,85,-8) = grass_block       solid=True   ← 物品**报告的 y**
(-7,86,-8) = air               solid=False
(-7,87,-8) = grass_block       solid=True
```

→ **物品报告的 `y=85` 是实心的**。物品实体其实是**躺在 `y=85` 这块 grass_block 的上表面**，
它的"站立空间"在 `y=86`。

→ **我的 P34 修复里 `standable` 检查正确地拒绝了 `(-7,85,-8)`**
（那一格不是可站层），退回 `GoalNear`。**修复按设计工作。**

**Step 2 —— 那 `(-7,86,-8)` 能站吗？**

```text
(-7,86,-8) 脚层 = air          ✓
(-7,87,-8) 头层 = grass_block  ✗   ← 头被堵死
```

→ **站不进去**。实测 `POST /move {"x":-7,"y":86,"z":-8}`（GoalBlock）
→ `Stuck: no meaningful progress for 3 checks` —— **寻路器正确判定不可达**。

**Step 3 —— 她周围哪些格能站？（y=86 层，脚+头都 air）**

```text
(-8,86,-8) 脚=air 头=air           ← 唯一可站
(-7,86,-7) 脚=air 头=grass_block
(-8,86,-7) 脚=air 头=grass_block
(-6,86,-8) 脚=air 头=grass_block
(-7,86,-9) 脚=grass_block 头=air
(-8,86,-9) 脚=grass_block 头=air
```

→ **这是 P42 的同一片地形**：`y=87` 整层是实心的，这就是一条
**只有 1 格高**的地道。她人高 1.8 格，整片区域**只有极少数格能站**。

**Step 4 —— 距离够吗？**

```text
她 exact (-7.67, 86, -7.51) → 物品 (-7, 85.5, -8)
水平 0.83  垂直 0.5  3D 0.969
```

→ **0.969 < 1**，理论上正好在拾取半径边缘。实测：让 `/look` 朝向物品、
等 4 秒 —— **物品仍在**（`drops: 1`）。

### 三、根因（两条，都为真）

**(a) `reachableStandY` 不知道"目标格是不是实心"**

```js
function reachableStandY (dropY, selfY) {
  const d = Math.floor(Number(dropY));
  const s = Math.floor(Number(selfY));
  const dy = d - s;
  if (dy > 0) return s;
  if (dy >= -1) return d;      // ← 这里：dropY=85, selfY=86 → 返回 85
  return s - 1;
}
```

它返回 `85`，而 `85` 是实心方块 —— **函数不知道这件事**。
`standable` 兜住了（没走错），但结果是**退回 `GoalNear` → 球心仍在 85 →
她在 86，球内包含她自己 → 判"已到达" → 一步不动**。

→ **P34 的修复方向是对的（换 goal 类型），但触发条件用错了层。**
  判据不该是"**物品报告的那一格**可不可站"，而该是
  **"物品**实际所在的空间**（`y+1`，因为它在方块上表面）可不可站"**，
  或者更稳的：**在 `[dropY, dropY+1, dropY-1]` 里找第一个可站层**。

**(b) 1 格高的通道 + 0.969 格的临界距离**

她**站在通道里**，物品在**通道地板**上（同一层地板），3D 距离 0.969 —— 
但 Minecraft 玩家拾取判定比 1 格略严（实际约 1.0，且服务端要 tick 到），
**0.969 卡在了"看得见摸不着"的临界带**。

→ 这不是 bug，是**几何**。要拿到它，她需要**站得更近**（走到 `(-8,86,-8)`
中心，距离会降到约 `0.87`），或者**把 `(-7,86,-7)` 那个"头被堵"的格挖开**，
让站位空间扩大。

### 四、修复方案（待实施）

**改 `reachableStandY`，让它变成"找可站层"而不是"算一个数"：**

```js
// 在物品的 y 及其邻层里，找**第一个**她真的站得进去的层。
// 优先序：物品实际空间（是方块顶面就 +1）→ 物品报告层 → 下一层 → 上一层。
function findStandY (dropY, selfY, blockAt, x, z) {
  const d = Math.floor(Number(dropY));
  const s = Math.floor(Number(selfY));
  if (!Number.isFinite(d) || !Number.isFinite(s)) return s;
  const cand = [];
  const below = blockAt(x, d, z);
  // 物品报告层是实心 → 它的空间在上一层
  if (below && !isStandable(below)) cand.push(d + 1);
  cand.push(d, d - 1, d + 1);
  for (const y of cand) {
    if (y > s) continue;                      // 不上天
    if (s - y > 1) continue;                  // 更深不管（canDig=false）
    const f = blockAt(x, y, z), h = blockAt(x, y + 1, z);
    if (isStandable(f) && isStandable(h)) return y;
  }
  return s - 1 < d ? s - 1 : d;               // 找不到就退回原逻辑
}
```

**关键在于：这个函数需要 `blockAt` 访问世界** —— 所以它不能是纯函数了，
或者把 `blockAt` 作为参数注入（后者更好，自测仍可跑纯逻辑）。

### 五、教训

1. **"物品的 y"和"物品所在的格"是两件事。**
   物品实体躺在实心方块**顶面**时，报告 `y=85`，但它的空间是 `y=86`。
   这和 P42 一模一样：**方块坐标 ≠ 空间坐标**。
2. **我第三次在同一个坑里** —— P42 是"空间的 y"，P43 又是"空间的 y"。
   我在开头还特意写"不要心算"，然后**又用 `y=85.5` 去心算距离**。
3. **判据函数的输入如果不够，就该扩输入，而不是在外面打补丁。**
   `reachableStandY` 只看两个 `y` 就算出了答案 —— 这在"物品压在方块上"时
   必然错。**输入不足 → 输出必然错**，与算法无关。

---

## P44 —— `POST /move` 也谎报成功（P32/P35/P41 家族**第四次**）

### 证据

```text
POST /move {"x":-8,"y":86,"z":-8,"timeoutMs":12000}
→ {"success":true,"arrived":{"x":-8,"y":86,"z":-8},
   "route":{"etaMs":null,"timeoutMs":30000,"replans":0,"source":"pending"}}

紧接着 GET /position
→ exact = (-7.67, 86, -7.51)          ← **一毫米都没动！**
```

`success: true` + `arrived` 报的坐标**和请求的一模一样**，
但 `source: "pending"`、`etaMs: null`、`replans: 0` —— 这些字段在说
"路径还没算出来"。**它把"我收到了请求"当成了"我走到了"。**

### 为什么这是**第四次同型**

| 编号 | 位置 | 谎报形态 |
|------|------|----------|
| P32 | `POST /pickup` | 用 `walkedTo` 当成功（走到了 ≠ 捡到了） |
| P35 | autopilot `gather` | 用 `mined` 当成功（挖了 ≠ 得到了） |
| P41 | autopilot `shelter` | 直接 `return { ok: true }`（无视返回值） |
| **P44** | **`POST /move`** | **请求成功 = 移动成功** |

**P14 的反模式（"修一个先 grep 全仓"）到现在被违反第六次了。**
每次修完都只修被点名的那一处，下次换个端点又冒出来。

### 待办

1. `/move` 的判据改为**前后位置差**（和 `/pickup` 的背包差同理）：
   `ok = (移动后位置 与 移动前位置 的距离) > 0.5` 或**已到达目标 1 格内**。
2. **全仓审计所有返回 `success: true` 的端点**，逐个问：
   "这个 `success` 是拿什么算出来的？有没有世界状态的证据？"
   这是 P14 应该做而一直没做的那件事。


---

## P45 —— `/scan` 的感知瓶颈不是"慢"，是"看不见远处"（2026-09-25）

### 一、我一开始找错了方向

用户的要求是「**提高对环境的感知速度，比如挖矿和打怪的时候**」。
我的第一反应是"扫描算法太慢" —— **但实测立刻否掉了**：

```text
/scan radius=8  →  0.0127s / 0.0083s / 0.0079s    （三次）
/scan radius=16 →  0.0112s / 0.0125s / 0.0097s
```

**8~12 毫秒。一点也不慢。** 我如果就此收手，就会漏掉真正的问题。

### 二、真正的异常在返回体里

```text
radius=8 :  scanned 1536  truncated **true**  distinct 6
radius=16:  scanned 1536  truncated **true**  distinct 6   ← 和 radius=8 **完全一样**
```

**两个半径拿到的是同一份结果**，而且都被截在 1536。
`1536 格 ≈ 球半径 7.16` —— **她无论怎么看，最远只能看见约 7 格、6 种方块。**

而实测那 6 种是：`andesite ×614 / grass_block ×172 / dirt ×314 /
meadow:limestone ×109 / wild_leeks ×1 / gravel ×1` ——
**全是包住她的那坨土。一个矿都没有。**

### 三、两个根因（都实测确认）

**(a) 旧注释的算术就是错的**

> 旧注释：「半径 16 / 垂直 8 的立方体是 33 × 17 × 33 = 18513 格…
>  **1536 格在半径 8（默认）下刚好扫完**」

`radius=8` 的实际格子数是 `17 × 17 × 9 = **2601**`，**不是 1536**。
所以"刚好扫完"是假的 —— 实测 `truncated: true`，**连默认半径都扫不完**。

**(b) 真正的开销不是 `blockAt`，是排序**

我用 `_bench_blockat.js` 量了（本机，Node 22.22.2）：

| 操作 | 成本 |
|------|------|
| 分配 18513 个 `Vec3` | 0.10 ms（6 ns/个） |
| **排序 18513 个（比较器含 `sqrt`）** | **11.80 ms** ← 就是它 |
| 排序，改用距离**平方**（免 sqrt） | 7.96 ms |
| **纯三重循环，不分配不排序** | **0.82 ms** ← **快 14 倍** |

`/scan` 整体才 8~12 ms —— **也就是说这个端点的时间几乎全花在排序上**。
旧注释里"全扫会把主线程卡住几百毫秒"的担心，代价被高估了**一个数量级**。

### 四、修法（三处，都靠数据定，不靠推测）

**① 删掉排序，改"按层（洋葱）向外扩"**

从 `dy=0` 那一层开始，`level = 0,1,2,…` 逐层加大水平半径，每层只走**边框**
（内部的在更小的 level 里已经走过）。遍历顺序本身就从近到远，**不需要 sort**。
够上限就 `break` —— 停下的位置语义与"排序后取前 N"完全一致。

**② `dy` 放在外层**（先扫完同层的所有水平距离，再扫上下层）

我第一版把 `dy` 写在里层，**自测立刻红了**。想清楚哪个才对：
她站在地面（y=87），20 格外的矿在 y=88。若 `dy` 在里层，`level=0`
就把 `dy=0,±1,±2…` 全走完 —— **脚底下的土先吃配额，那个矿要等预算用完**。
而**能走过去的地方才是她该优先知道的**（走过去免费，上下挖不是）。
→ `dy` 外层。自测第 ③ 条也据此改成"**同一 dy 层内部**单调"，不能对全局断言单调。

**③ 配额口径：从"走过多少**坐标格**"改成"读到多少个**非空气方块**"**

这是最关键的一条。旧口径下空气也吃配额 → 她被实心土围着时配额全被吃光。
新口径：空气直接跳过、不计数。另设 `MAX_SCAN_VISITS = 18513` 作**兜底**
（全空气区域里 `solids` 永不涨，必须有第二个闸门）。

上限 `1536 → 6000`（免掉排序后，多扫格子的边际成本只有几微秒）。

### 五、实机验证（A/B 对比，同一位置 `(-10,87,-8)`）

| 指标 | 旧版 | 新版 | 变化 |
|------|------|------|------|
| `radius=8` `scanned` | 1536（截断） | **2601（扫完）** | 完整覆盖 |
| `radius=8` `truncated` | **true** | **false** | ✅ |
| `radius=8` `distinct` | **6** | **11** | **+83%** |
| `radius=8` `maxDistance` | ~7.5 | **12.3** | **+64%** |
| `radius=8` 能看见矿吗 | **不能** | **`copper_ore×4`(8.5格) / `ltc2:salt_ore×2`(8.8格)** | ✅ |
| `radius=16` `maxDistance` | **7.16（永远是）** | **22.9** | **+220%** |
| `radius=16` `distinct` | **6（永远是）** | **14** | **+133%** |
| `radius=16` 能看见矿吗 | **0 个** | **`emerald_ore×1`(14.2格) / `alpine_coal_ore×17`(11.3格) / `salt_ore×5` / `alpine_salt_ore×5`** | ✅ |
| 耗时 | 8~12 ms | **8~15 ms** | 基本持平 |

**最关键的一条：她以前看不见 7 格外的任何东西，现在能看见 22.9 格外的石头、
14.2 格外的绿宝石矿、11.3 格外的煤矿。** 耗时只多了 3 ms。

**新增的能力**：
* `reach: { solids, maxDistance, farthest }` —— **"她到底看多远"变成一个可核对的数字**。
  旧返回体答不了这个问题（`radius=8` 和 `radius=16` 返回一模一样，调用方无从知道）。
* `filter=ore` 现在真正有用：**"附近有什么矿"** 是一个请求就能问的了。
  实测：`filter=ore` → `salt_ore / alpine_coal_ore / emerald_ore / alpine_salt_ore`，17 ms。

### 六、教训

1. **"慢"和"看不见"是两个完全不同的问题。** 我一开始假设是"慢"，
   实测 8ms 直接否掉。**如果以"优化速度"为目标收工，就完全修不到真问题。**
   → **先量，再改；量出来的数字如果不符合预期，要问"是不是我问错了问题"。**
2. **返回体应该能回答"你做得有多好"，而不只是"我做了"。**
   旧的 `scanned: 1536, truncated: true` 看着正常 —— 它**没说谎**，
   但它**答不了"她看多远"**。`reach.maxDistance` 一加，问题立刻现形（7.16 格）。
3. **注释里的算术也要验证。** "1536 在半径 8 下刚好扫完"是错的（实际 2601）。
   这跟 P40 那个"心算 `Math.round(-6.5)`"是同一类错误 ——
   **写在注释里的数字，一样会错，而且错了没人发现**（因为它不影响运行）。
4. **自测的比较器能力要匹配断言的形状。** 我写了 4 条断言直接比**对象**，
   而这个自测的 `check` 是 `got === expect` —— **对象永远不等**，4 条全红，
   而逻辑其实是对的（`_dbg.js` 单独验证过值完全相等）。
   → **红的时候先怀疑断言，别急着改代码**（这次差点又去改正确的代码）。


---

## P46 —— `/unstick` 的逃逸目标不能是"原任务的坐标"（2026-09-25）

### 一、怎么发现的

实现 P42 自救之后，我拿 `/unstick` 做实测，目标选了 `(-14, 87, -6)`（随手挑的"远处"）。
结果 `escaped: false, moved: 0`，`why: "打开了 canDig 也走不动"`。

我一开始以为"打开 canDig 也没用"意味着地形真的过不去。**但逐格探测推翻了它：**

```text
          z=-10  z=-9   z=-8   z=-7   z=-6
x=-13:    ##     ##     ##     ##     ##
x=-12:    ##     ##     ##     ##     ##
x=-11:    #.     .#     ..     #.     ##
x=-10:    ##     #.     ..     ..     ##
x=-9:     #.     ..     ..     ..     .#
x=-8:     ##     .#     .#     #.     #.
```

（每格两位 = 脚层 y=87 + 头层 y=88；`.` 可穿过，`#` 实心）

**`x=-13` 与 `x=-12` 两列整列都是 `##`** —— 那个目标格 `(-14, -6)` **根本不存在**，
它在实心岩体内部。

→ **`/unstick` 失败是必然的，而且跟"她被不被困"毫无关系。**
→ 更糟的是：我的三级手段（① 临时放行 canDig ② 挖脚边一格）**全部注定失败**，
   因为**目标本身不可达** —— 白挖方块、白等超时。

### 二、想穿这件事之后，"脱困"的定义浮出来了

> **脱困 ≠ 到达原任务的坐标。**
> **脱困 = 能走到任何一个新的地方。**

原任务的坐标可能本来就不可达（那是"**做不到**"，不是"**被困**"）——
这两件事在旧代码里被混成了一件。

### 三、修法

加 `pickEscapeTarget(p)`：半径 6 内逐格问"这里站得进去吗"
（**脚层 + 头层都非实心** —— 与她身高 1.8 格一致，`isStandable` 同源），
取**最近的**那个。

* 刻意**不检查"能不能走到"** —— 那要跑寻路，而寻路正是当前坏掉的东西。
  只检查"可站"，由 `/unstick` 或 `/mine` 去解决"怎么过去"。
* 最多问 40 格（每次都是 HTTP 往返，要有界）。
* **一个可站格都没有 → 返回 `null` → 如实放弃**（那才是真的被困）。

### 四、实机验证时抓到的**第二个**真相 —— `escaped: false` 可能是对的

修完之后继续实测，发现她卡在 `(-9.62, 87, -7.5)`，目标 `(-9, 87, -8)`：

```text
z=-8 列：
  (-11,87,-8) 脚=air 头=air 下=andesite   ✓ 可站
  (-10,87,-8) 脚=air 头=air 下=andesite   ✓ 可站
  (-9,87,-8)  脚=air 头=air 下=**air**    ← 悬空！走进去会掉
  (-8,87,-8)  脚=air 头=**grass_block**   ← 头被堵
z=-7 列：
  (-10,87,-7) 脚=air 头=air 下=andesite   ✓ 可站（她在这一列）
  (-9,87,-7)  脚=air 头=air 下=grass_block ✓ 可站
```

**她过不去的原因不是"方块挡路"，是"要掉下去"。**
`(-9,86,-8)` 是空气 —— 那一格是个 1 格深的坑。`GoalBlock(-9,87,-8)` 要求她
**站在坑口那一层**，而她走进去会掉到 y=86。

→ **`canDig` 打开也没用 —— 挖方块解决不了重力。**
→ 所以 `escaped: false` + `why: "打开了 canDig 也走不动"` **是正确的**。

**关键对照实验（证明寻路器没坏）**：反方向到 `(-11, 87, -8)`
→ `{"success":true,"moved":0.882,"wasInside":false,"route":{"etaMs":179,"replans":1}}`
**走通了。** 所以 `Stuck` 是"这条路真的不通"，不是"寻路器死了"。

### 五、P44 的新字段在实战中第一次发挥作用

那条反方向的返回体里：

```json
"moved": 0.882, "wasInside": false
```

* `moved: 0.882` —— **她真的动了**（而不只是"请求成功"）
* `wasInside: false` —— **出发时不在目标格里**（不是"本来就在"那种假成功）

**这正是 P44 想解决的问题**：没有这两个字段，调用方看到 `success: true`
根本分不清"她走过去了"和"她本来就在那儿"。

### 六、教训

1. **"失败了"和"被困住了"是两个不同的诊断。**
   前者是"这个目标做不到"，后者是"任何目标都做不到"。
   我把 `S.task` 的目标直接当逃逸目标，等于**用"做不到"的目标去证明"被被困"** ——
   逻辑上根本不成立。**验证 A 之前先确认 A 是可验证的。**
2. **"手段用尽仍失败"之前，要先确认"手段是否对症"。**
   `/unstick` 打不开局面，我第一反应是"地形真过不去" —— 其实是
   **目标选错了**。症状一样，根因完全不同（跟 P40 那次一模一样：
   错误信息指向的层是错的层）。
3. **`canDig` 不是万能钥匙** —— 它只解决"方块挡路"，不解决"重力"。
   脱困手段要和**卡住的原因**匹配：挡路 → 挖；悬空/高度不够 → 换落脚点或垫方块；
   对角 → 先走到正交邻格。
4. **对照实验的价值**：反方向 `moved: 0.882` 这一个数据点，
   同时排除了"寻路器坏了"和"物理层坏了"两个方向 ——
   比盯着同一个失败重试十次有用得多。


---

## P47 —— 路由层无条件贴 `success: true`（**架构级根因**，P32/P35/P41/P44 四次同型的真凶）

**发现时间**：2026-09-25
**严重度**：🔴🔴 **最高**（它不是"某个端点坏了"，它是"所有端点都可能说谎"）
**状态**：✅ **已修 + 16 条自测锁定**（autopilot 247 → **263**）

### 症状（第四次才被当成根因看）

这个 bug 长出了四次，每一次我都只在**单点**修：

| 次 | 编号 | 症状 | 我当时的修法 |
|---|---|---|---|
| 1 | P32 | `/pickup` 报 `walkedTo: 3` 但背包没变 | 加 `picked`（背包前后差）当判据 |
| 2 | P35 | `/gather` 同型 | 加 `mined` 当判据 |
| 3 | P41 | `/shelter` 直接 `return {ok:true}` | 改判据为 `r.placed` |
| 4 | P44 | `/move` 报 `success:true` 但她纹丝未动 | 加 `moved` / `wasInside` |

**四次都在改"判据字段"，四次都没问"为什么调用方会信 success"。**

### 定位

全仓 `grep "success: true"` → 只有 5 处。其中 4 处是 handler 内部自己写死的
（`/reconnect` ×2、`/registry/import-palette` ×2），**唯一有害的那处**在路由层：

```js
// bridge-server.js（旧，约 5795 行）
const result = await handler(args, qs);
json(res, 200, { success: true, ...result });   // ← 无条件
```

它的语义**只有一个**：*handler 没抛异常*。

但**所有调用方都读成**：*动作在世界里生效了*。

而 handler 内部其实**经常知道没做成** —— 它老老实实算了 `ok: false`
（`/pickup` 写在 3675 行：`ok: picked > 0`），然后路由层把 `success: true`
贴在最前面，覆盖了它。调用方读到 `success: true` 就往下走。

### 修法（三处，一个原则）

**原则：handler 有权否决路由层的 `success`。**

**① 路由层加否决规则**（约 5795 行）：
```js
const vetoed = result && typeof result === 'object' && result.ok === false;
if (vetoed) {
  json(res, 200, {
    success: false,
    ...result,                    // result 自己的字段优先（含它自己的 ok:false）
    _successNote: 'success 由 handler 的 ok:false 否决 —— 它明确表示这个动作**没有在世界里生效**…',
  });
} else {
  json(res, 200, { success: true, ...result });   // 向后兼容：绝大多数端点走这条
}
```

**② 补上缺失的 `ok` 判据** —— `/mine` 和 `/shelter` 从来没给过 `ok`，
所以它们即使失败也享受"无条件 success"：

```js
// /mine（约 5079 行）
ok: mined.length > 0,   // 「这次挖掘在世界里有没有真的发生」

// /shelter（约 4396 行）
ok: placed.length >= 2, // 与它自己那句 `sheltered: placed.length >= 2` 同口径
```

**③ 客户端判据必须同步收紧**（`autopilot.js` `call()`）：
```js
// 旧：if (!res.ok || data.success === false) throw ...
// 新：
if (!res.ok || (data.success === false && data.error)) throw ...
```

⚠️ **这一条不收紧的话，修①会直接造成回归**：`success: false` 多了"业务否决"
这一合法来源，而 `call()` 会把它当异常抛出 → 落到 `catch` → 当成"网桥挂了"去重连。
**那就成了"这次没挖动"被报成"服务器掉了"** —— 比原 bug 更糟。

### 判别规则（写进代码注释，防下次改坏）

| `result.ok` | 路由产物 | 理由 |
|---|---|---|
| `false`（严格布尔） | `success: false` | handler 明确否决 |
| `true` | `success: true` | 明确认可 |
| **缺失** | `success: true` | **绝大多数 handler 属于这种，不许否决** |
| `0` / `null` / `''` / `"false"` | `success: true` | 只认布尔，防假值误伤 |

**必须是 `=== false` 严格相等。** 写成 `!result.ok` 会让所有不返回 `ok` 的
handler 集体翻车 —— 那比原 bug 更糟。

### 验证

**自测新增 16 条**（12 条路由规则 + 4 条客户端抛错规则），覆盖：
* `ok:false` → `success:false`，且 **`ok:false` 本身保留**（调用方还要读它）
* `ok:true` / **`ok` 缺失** / `ok:0` / `ok:null` / `ok:"false"` → **都不否决**
* `result` 为 `null`/`undefined` → 不崩
* 三个真实场景复现：`/mine` 挖不动、`/shelter` 一块没放下、`/pickup` 走到没捡到 → 全部 `success:false`
* **反向断言**：`/pickup` 真捡到了 → 仍是 `success:true`（别误伤成功路径）
* 客户端：带 `error` 才抛，不带 `error` 的否决**不抛**

**自测**：`autopilot.js` 247 → **263 通过**；`bridge-server.js` `node --check` 通过。

### 教训

1. **同一个 bug 出现第二次，就该怀疑架构；出现第四次，就是没在治根。**
   我前三次都只改"判据字段"，因为那样改动小、见效快 ——
   但根因是**共享的**，所以它必然长第五次。
2. **"向后兼容"是这次能一次修完的关键**：新规则的默认分支（`ok` 缺失 → 照旧）
   覆盖了绝大多数端点，所以不需要动 100 多个 handler。
   如果设计成"必须显式 `ok:true` 才算成功"，那就得改遍全仓 —— 反而不会有人敢修。
3. **修完必须查调用方怎么读**。`success` 的语义变了（多了"业务否决"这一支），
   客户端判据不同步收紧就立刻回归 —— 修 A 造成 B 的事故，通常发生在这一步。
4. **"如实"不只是返回值要诚实，还要保证诚实能被传递到决策处。**
   handler 早就诚实了（`ok: false` 写在 3675 行），是中间层把它洗成了"成功"。

---

## P48 —— 她不会"持续发育"：缺少"进步"这个维度（**对上用户主线目标**）

**发现时间**：2026-09-25（autopilot 重启后实机观察）
**严重度**：🟡 **中**（不崩溃、不报错、日志干净 —— 她只是"什么都不做"）
**状态**：📋 **已定位，方案待批**（属新增动作，未擅自动手）

### 症状

autopilot 重启后 91 秒，她一直停在 `approach`（陪伴模式），**零自主建设行为**。
控制面 `lastDecision.state`：

```json
"self": {
  "needFood": false, "needMaterials": false, "needShelter": false,
  "canHunt": false, "hasFoodSource": false, "hasMaterials": true,
  "reasons": ["周围没有可获得的食物来源"]
},
"capability": {
  "canEat": false, "canEquipTool": false, "canEquipWeapon": false,
  "itemKinds": 1, "matStacks": 21, "huntableCount": 0, "foodDropCount": 0,
  "isDay": true, "gatherableCount": 8, "buildMatCount": 3
}
```

**决策日志完全干净、判定也完全诚实** —— 这不是 bug，是**设计缺了一个维度**。

### 定位（三条互相独立的缺口）

**① `needShelter` 只在夜里为 true**（`decision.js:574`）

```js
const nightKnown = cap.isDay === false;
const noShelterAtNight = nightKnown;
needShelter: noShelterAtNight,
```

白天 `isDay: true` → `needShelter: false` → **她永远只在日落时才想起搭房子**。
而用户的指令是"**自己**建立庇护所" —— 一个**白天就该主动规划**的目标。
现在的行为是"天黑了才手忙脚乱找地方封起来"，不是"建立庇护所"。

**② `needMaterials` 用"建材**堆数**"当判据，不看**种类/价值**（`decision.js:127, 592`）

```js
selfMatStacks: 8,   // 背包建材少于 8 个 → 值得去采
needMaterials: (cap.matStacks || 0) <= T.selfMatStacks && hasMaterials,
```

她是 `matStacks: 21`（**21 个 dirt**）→ `21 > 8` → `needMaterials: false` → **不再采集**。

⚠️ **但"21 个土"和"21 个能用的材料"完全不是一回事。**
她 `itemKinds: 1` —— 背包里只有一种东西。`canEquipTool: false`，
`canEquipWeapon: false` —— **她没有任何工具**。

所以"发育"在她这里**已经静止了**：阈值达标 → 停止采集 → 手上永远只有土 →
永远做不出工具 → 永远打不了猎 → 白天的菜单只剩 `approach(25) / explore(20) / idle(1)`。

**这解释了 `reasons` 里那句孤零零的"周围没有可获得的食物来源"**：
她不是"不缺"，是**没有任何一个动作能让她变得更好**。

**③ 没有"工具链"这个发展目标**

`capability` 里有 `canEquipTool` / `canEquipWeapon` 两个字段（说明这个维度**被观测了**），
但**决策层没有任何动作消费它们** —— `decision.js` 的菜单里没有一个动作的准入条件是
"我没有工具，应该去做一把"。观测了却没用来决策，等于没观测。

对照 `canEat` 也一样：有 `eat` 动作（autopilot:3315），
但 `canEat: false` 时 `eat` 不进菜单，也没有"去找食物"的链路接上它 ——
`forage` 需要 `needFood`，而 `needFood` 需要 `hasFoodSource`，
`hasFoodSource` 又需要 `canEat || huntableCount>0 || foodDropCount>0` —— **循环依赖**：
没食物源 → 不觉得饿 → 不去找食物 → 永远没食物源。

### 为什么这是"对上用户主线"而非小毛病

用户原话：**「目标是自己建立庇护所并持续发育」**。拆开看：

| 用户要的 | 现在系统做的 | 差在哪 |
|---|---|---|
| **自己**建立 | 只在夜里被动封两格 | 没有白天的主动规划 |
| 庇护所 | `needShelter` = "天黑了" | 语义是"应急"，不是"建立" |
| **持续**发育 | `matStacks 21 > 8` → 停了 | 没有"进步"的量度 |
| 发育 | `itemKinds: 1`，无工具 | 没有工具链目标 |

**四条里三条没达成，且全部是"设计缺维度"，不是"代码有 bug"。**
这也说明前面的 P40-P47 修的都是**地基**（她能动、能看见、不说谎），
现在地基稳了，**上层目标层是空的**这件事才显出来。

### 待批方案（三选一或组合，**未动手**）

**A. 给 `needShelter` 加"白天规划"维度**
```js
// 伪代码：白天 + 有建材 + 附近没有可用遮蔽 → 也值得搭
needShelter: nightKnown || (cap.isDay === true && (cap.matStacks||0) >= 6 && !cap.hasShelterNearby)
```

**B. 给 `needMaterials` 加"种类/质量"判据**
```js
// 不只看堆数，还看：有没有工具材料（木/石）、种类数是否过少
needMaterials: ((cap.matStacks||0) <= T.selfMatStacks
                || cap.itemKinds <= 2        // ★ 种类太少 = 没有发展
                || cap.canEquipTool === false) // ★ 没工具 = 需要去搞
               && hasMaterials,
```

**C. 新增"工具链"目标**（最接近"持续发育"的本意）
按 Minecraft 的天然进度做一条链，每步只做"下一个能做的"：
```
徒手采木 → 木镐 → 采石 → 石镐/石剑 → 打猎得食物 → 食物充足 → 升级庇护所
```
这条链的每一步都产出**可测量的进步**（工具一件一件到手），
天然满足"持续发育"，且不需要她"理解"整条链 —— 只需知道"下一步是什么"。

**我的倾向：C（含 B 的判据）**，因为 A 单独做只是把"夜里封两格"提前到白天，
仍然是"应急"语义，不会产生"发育"；B 是 C 的准入条件；C 才是用户真正要的东西。

⚠️ **C 的工作量明显大于 A/B**（要设计链条、接进决策菜单、为每一步写自测）。
需要用户点头再动。

---

## P50 —— `AIRY` 判据不含植物（她站在草丛里被判"位置被占"）

**发现时间**：2026-09-25（P49 排查的副产物）
**严重度**：🟡 **中**（挡住 `/shelter`，但不是唯一原因）
**状态**：📋 **已定位，未修**（改动有风险，见下）

### 症状

`/shelter` 报：`脚边没有可放置的空位（归到她站 (1,67,24)，selfAir=false groundSolid=true）`

逐格实测：

```
(1,67,24) = grass          solid=false  diggable=true   ← 她站的格
(1,67,23) = spruce_button  solid=false
(2,67,24) = spruce_button  solid=false
(1,68,24) = air            solid=false                  ← 头层正常
(0,67,24) = dirt           solid=true
```

**她的脚层是 `grass`（`solid: false`）—— 是可穿过的草，她当然站得进去。**

### 根因

`place.js` 的 `AIRY` 判据**只认真正的空气/流体**，不含任何植物：

```js
const AIRY = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava)$/;
```

`grass` 不匹配 → `isAiryForPlace()` 返回 false → `selfIsAiry()` 返回 false
→ `selfAir = false` → 错误信息指向"位置被占"。

### ⚠️ 为什么没有直接修（风险）

`AIRY` 被 **两处**使用，**口径不同**：

| 用处 | 需要什么语义 | 草算不算 |
|---|---|---|
| **放置目标**（`planPlacement`） | "这个格能不能被方块替换" | **能** ✅ 该加 |
| **她自己的站位**（`selfIsAiry`） | "她能不能站进去" | **能** ✅ 该加 |

看起来两边都该加 —— **但必须先查清两件事**：

1. **`grass` 的真实身份**：它是模组方块名（`bountifulfares` / `meadow`），
   可能是 `short_grass` 的别名。`registry` 只给了 `grass`，
   **不能假设它就等于原版 `short_grass`** —— 名字相同而语义不同的模组方块
   在这个包里已经踩过（P4 的 `lemon_log`）。
2. **`lava` 为什么在 `AIRY` 里**：岩浆**不能站**（会死），
   却出现在"可站立"判据的白名单里。这是 P40 遗留的设计疑问 ——
   目前靠 `DEADLY` 正则（含 `lava`）在 `isStandable` 里兜底拦下。
   **"可放置"和"可站立"混用同一个正则**，本身就是这类 bug 的温床。

**建议修法**（待批）：
- 把 `AIRY` 拆成两个**语义明确**的判据：
  - `REPLACEABLE`（可被方块替换，含植物、不含岩浆）
  - `STANDABLE`（她能站，含植物、不含岩浆/火/仙人掌）
- 或者最小改动：`AIRY` 加植物白名单，但**同时把 `lava` 从里面拿出来**
  （`lava` 该由 `DEADLY` 单独负责）

### 教训

**"同一个正则服务两个语义"是可复现的 bug 温床。**
`AIRY` 同时回答"能放吗"和"能站吗"两个问题，而这两个问题的答案**不完全一样**
（岩浆：不能放吗？不能站吗？—— 都对，但"为什么不能"不同）。
一旦将来有人只考虑其中一个语义去改这个正则，另一处就会静默出错。

---

## P51 —— `README-FIRST` 里写错自测命令（我自己的文档 bug）

**发现时间**：2026-09-25（生成交接包时）
**严重度**：🟢 **低**（只误导人，不影响运行）
**状态**：✅ **已修复**

### 症状

起草 `README-FIRST-提交前必读.md` 时，我在"自测跑法"一节先写下了：

```bash
node bridge-server.js --selftest   # ⚠️ 这一行是错的
```

随即在同一段里又自己否定了它。**留下的是一段自相矛盾的文档**：
先给一条会挂住的命令，再说"该文件其实没有 --selftest"。

### 根因

我从别的模块（`pathing.js` / `autopilot.js` / `decision.js` 都真有意 `--selftest`）
**外推**到了 `bridge-server.js`，没有先核实。

而 `bridge-server.js` 一 `require` 就会尝试连服务器 ——
执行那条命令**不是报错，是挂住**，比报错更难察觉。

### 修法

删掉那一行，只保留正确的那条：

```bash
node --check bridge-server.js      # 语法检查
```

### 教训

这是本项目**第三次**栽在"没有 vs 读不到"上（P49 我连栽三次）。
**外推一个模块的能力之前，先看一眼它到底有没有。**
尤其当"没有"的表现是**静默挂起**而不是报错时。

---

## P52 —— 交接包里混进 `config.json`（敏感文件泄漏）

**发现时间**：2026-09-25（打包交接时）
**严重度**：🔴 **高**（内含真实服务器地址与账号，一旦外发不可撤回）
**状态**：✅ **已修复**

### 症状

第一次尝试打包"含 `.git` 的完整目录"时，我直接对**整个项目目录**做了
`Compress-Archive`。校验脚本立刻报出：

```
文件数: 234
含 config.json : True    ← ★
含备份目录     : True
含日志         : True
```

`config.json` 含 `139.196.98.255:25565` 的**连接凭据**；
`.angleice-backup-*` 是修复前的代码备份；`*.log` 是运行日志。

**这个包如果发出去，等于把服务器凭据一起送人。**

### 根因

我用了**两个不同的口径**去做同一个包：

| 包 | 口径 | 结果 |
|---|---|---|
| 第一个（handover） | `git ls-files -c -o --exclude-standard` | 84 个，干净 ✅ |
| 第二个（full） | 直接压缩整个目录 | 234 个，**含敏感文件** ❌ |

第二个包之所以"看起来还行"，是因为 `.gitignore` 里**确实写了** `config.json` ——
但 `.gitignore` **只约束 git，不约束 `Compress-Archive`**。

**工具的过滤规则不会自动传递到打包工具上。**

### 修法

删掉那个包，重建：**先按 git 清单提取干净快照，再单独拷入 `.git/` 目录**
（`.git/config` 只有 `[core]` 段，已核实无身份残留；`git rev-list --all --count` = 0，无历史）。

复验：

```
━━━ angleice-handover-20260925.zip  (1.95 MB) ━━━
  业务文件数 : 84      含 .git : False     敏感/冗余 : 无 ✅
━━━ angleice-git-ready-20260925.zip  (4.86 MB) ━━━
  业务文件数 : 84      含 .git : True      敏感/冗余 : 无 ✅
```

### 教训

**打包前必须对"包内条目"做一次独立校验，而不是相信 `.gitignore` / `.dockerignore`
之类的规则会自动生效。**

这条与 P44（"handler 的 `success:true` 被跨层误读"）是**同型**的：
一次隐式假设（"忽略规则会传递"）替代了一次显式校验（"列一下包里到底有什么"），
代价是把凭据打进了一个待外发的压缩包。

**判据**：任何对外交付物，在生成后必须有一道**独立于生成逻辑**的校验，
且校验的依据是**产物本身**（解压列目录），不是生成时的意图。
