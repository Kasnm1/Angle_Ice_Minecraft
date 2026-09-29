# `src/world/` —— 寻路 / 放置几何 / 注册表 / 协议

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**与**② 寻路 / 放置**合并拆过来
> （第 2 步重构）。跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `pathing.js` | **汇总入口（转发壳）**：一行转发到 `pathing/index.js`。原先是 3798 行的巨石，第 3 步（2026-09-29）按领域拆进 `pathing/` 子目录，**外部 `require('../world/pathing')` 路径一个不变**。文件划分、共享状态与"该跑自测吗"的判断都见下面的小节 |
| `place.js` | 放置 + 站位几何纯函数：`planPlacement` / `evaluateFace` / `bodyOccupies` / `AIRY` / `REACH`，以及 `DEADLY` / `isStandable` / `reachableStandY` / `findStandY`（P33/P43）。**这些判据全仓只有这一份** |
| `fml-handshake.js` | Forge 登录握手；解析 `S2CRegistry` 快照落盘 `registry/minecraft-{block,item}.json` |
| `registry-probe.js` | 协议补丁：`declare_commands` 改为原样收字节（否则模组命令树让包流错位，表现为 timed out） |
| `block-palette.js` / `palette-registry.js` | 方块调色板解析 + 三道闸 + 写回 `bot.registry` |
| `item-registry.js` | 物品表写回 `bot.registry`（规则与方块**刻意不同**，见 [`registry/AGENTS.md`](../../registry/AGENTS.md)） |
| `entity-registry.js` | 给 mineflayer 认不出的模组生物补服务端真名 + 记"谁打了她 / 打了玩家"（仇恨）；`isHostileEntity` 敌对判据只此一份 |
| `perception.js` | **野外资源感知（她的"余光"，2026-09-29）**：`classifyBlock`（分类，**用真实标签**不是硬编码名单）、`cluster`（同类聚成一片）、`rank` / `renderLine`（排序 + 出那行字）、`scanAround`（32 格分段扫描，复用 `instinct/core.js` 的 `scanColumnsIn`）、以及持久记忆 `load` / `save` / `merge` / `forget` / `containerTargets`。**记忆格式见 [`memory/AGENTS.md`](../../memory/AGENTS.md)**；判据（家里/开过/太远）只此一份 |

## `pathing/`（2026-09-29 第 3 步拆出来的子目录）

| 文件 | 职责 |
|---|---|
| `index.js` | 汇总：require 全部子文件 → 拼总表 `__ns` → 按**原顺序** `module.exports`（62 个名字，快照 `references/exports-pathing.json`）→ 递 `__ns` 给 `selftest` |
| `movements.js` | 寻路策略：`COSTS` / `ALLOW_DIG` / `applyPolicy` / `setDigPolicy` / `setScaffold` / `setDropAllowance` / `isProtected` / `PROTECTED_PATTERNS` / `naturalDigNames` / `bareName` / `dropPenalty` / `LIQUID_NAMES` / `MAX_VERTICAL_FLOW_LOOKAHEAD` / `FLUID_GUARD_FLAG` |
| `doors.js` | 开门：`applyOpenDoors`（门板方向、横穿判据、门口卡住的换路证据） |
| `ladders.js` | 梯子识别：`CLIMBABLE_STATE_IDS` / `parseIdList` / `parseNameList` / `resolveClimbable{,Block}Ids` / `applyClimbables` / `probeClimbables` / `installLadderFix` |
| `unknown-blocks.js` | 未映射方块与薄方块：`UNKNOWN_BLOCK_SOLID` / `PASSABLE_STATE_IDS` / `FULL_CUBE` / `EMPTY_SHAPES` / `isUnknownBlock` / `needsShapeFallback` / `THIN_BLOCK_*` / `applyUnknownBlockPolicy` / `lowBlockHeight` |
| `fluid.js` | 流体安全：`assessExcavationFluidRisk` / `isFlowPassable` / `injectFluidBreakGuard` |
| `probe.js` | 注册表往返自检：`probeRegistry` / `summarizeProbe` |
| `collect.js` | 自适应采集搜索：`COLLECT_SEARCH` / `buildRadiusLadder` / `isProductiveSweep` / `nextCollectStep` |
| `budget.js` | goto 预算与停滞：`PATH_*` 常量 / `clearPathfinderGoal` / `createGoalOwner` / `classifyGotoOutcome` / `installPhysicsTickGuard` / `stepKind` / `stepCostMs` / `estimatePathTimeMs` / `computeTimeoutFromEta` / `computeHardCap` / `createStagnationMonitor` |
| `selftest.js` | 原文件末尾那 475 条断言，原样搬出；`module.exports = run(api)`，由 `index.js` 递接口进来。**它自己不是测试入口** —— 见下面「自测」 |

拆分的三条坑（改之前先看）：

- **子文件之间不许互相 `require`**（会成环）。靠汇总的 `__ns` 运行期互取：`function X (...a) { return __ns.X.apply(null, a); }` 这类**转发壳**，以及各子文件里的 `bind(ns)` 回填。`scripts/split-wiring-test.js` 专门守这个（转发壳指向的名字要真的存在）。
- **`require` 时求值的常量不能留在子文件顶层**。例：`PASSABLE_STATE_IDS = parseIdList(process.env.MC_PASSABLE_STATE_IDS)` —— 拆开后 `parseIdList` 在兄弟文件里，`bind()` 还没跑，`const` 会在加载期直接 `ReferenceError`。改成 `let` + 在 `bind()` 里赋值。
- **运行期可变的模块级状态只有 `movements.js` 那一份**（`FLUID_GUARD_FLAG` 等）；`paths` 是只读。

## 必须知道的历史结论

- `canDig=false` 是钝器：把"最后手段"一起砍了，`No path` 反而变多。正解是高 `digCost` + 名字硬禁。
- 她拆房子的真因：默认代价下"拆一格泥土≈1.45 < 绕路"。
- 梯子两层判据（prismarine-physics 与 pathfinder `movements.js`）都是 `block.type === ladderId` ——
  调色板注入是前置条件。
- 注入记录**故意不填 `boundingBox`**，`needsShapeFallback` 靠它判断 —— 这是契约，别填。
- `canDig` 只解决"方块挡路"，**不解决重力**。

## 自测

```bash
$NODE src/world/pathing.js --selftest; $NODE src/world/place.js --selftest
$NODE src/world/block-palette.js --selftest; $NODE src/world/palette-registry.js --selftest
$NODE src/world/item-registry.js --selftest; $NODE src/world/entity-registry.js --selftest
$NODE --check src/world/fml-handshake.js; $NODE --check src/world/registry-probe.js
$NODE scripts/fml-snapshot-test.js; $NODE scripts/palette-guard-test.js   # 后者 7 条是已知红
$NODE scripts/angelpal-to-palette.js --selftest
```

`pathing` 有若干断言依赖 `minecraft-data`（在 `node_modules` 里）；没装依赖时会**静默少跑**，
看起来全绿其实漏测 —— 核对数字没有变少。

### pathing 自测只从 `src/world/pathing.js --selftest` 进

拆完之后 `src/world/pathing/selftest.js` **不是**一个能单独跑的测试入口 —— 它是
`module.exports = run(api)`，需要 `index.js` 把接口表递进来。**475 条只在**
`node src/world/pathing.js --selftest` 这一条命令里跑。

"该不该跑"由转发壳 `src/world/pathing.js` 判断：它是 `require.main` 时（即 `node src/world/pathing.js …`）
且命令行带 `--selftest`，才投票给 `selftest.js` 的 `markSelftestRequested()`，然后 `index.js` 转调 `run()`。
**投票必须发生在 require `index.js` 之前**（`index.js` 是同步 require + 末尾就调 `run()` 的）。

- 为什么判断不放在 `index.js`：`node src/world/pathing.js --selftest` 时 `require.main.filename`
  是转发壳 `pathing.js`（Node 用解析后的真实路径），`index.js` 里 `require.main === module` **永远为假** → 静默不跑。
- 为什么要这道闸：`bridge-server.js`（`require('../world/pathing')`）**不带 `--selftest` 也绝不能跑 pathing 自测** ——
  多打 475 行会把 `scripts/bridge-boot-test.js` 的 `GET /status` 那步顶掉（该测试靠输出判过，实测会红）。
- `scripts/test-all.js` 的 `RUNNER_ONLY` 把 `src/world/pathing/selftest.js` 排除在自动发现的测试清单外
  （它带 `--selftest` 字样但自己零断言，会被"什么都没测"那条防线误判成新失败）。真正的 475 条在
  `src/world/pathing.js` 那一项里。
