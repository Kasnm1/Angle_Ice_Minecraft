# `src/world/` —— 寻路 / 放置几何 / 注册表 / 协议

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**与**② 寻路 / 放置**合并拆过来
> （第 2 步重构）。跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `pathing.js` | 寻路策略：`digCost`（抬高拆方块代价，而不是 `canDig=false`）、`blocksCantBreak`（按名字模式硬禁建筑材质，覆盖模组方块）、`ALLOW_DIG` / `applyPolicy`、`probeClimbables`（可攀爬方块两层装配）、`needsShapeFallback`（`boundingBox === undefined` = 无权威碰撞箱） |
| `place.js` | 放置 + 站位几何纯函数：`planPlacement` / `evaluateFace` / `bodyOccupies` / `AIRY` / `REACH`，以及 `DEADLY` / `isStandable` / `reachableStandY` / `findStandY`（P33/P43）。**这些判据全仓只有这一份** |
| `fml-handshake.js` | Forge 登录握手；解析 `S2CRegistry` 快照落盘 `registry/minecraft-{block,item}.json` |
| `registry-probe.js` | 协议补丁：`declare_commands` 改为原样收字节（否则模组命令树让包流错位，表现为 timed out） |
| `block-palette.js` / `palette-registry.js` | 方块调色板解析 + 三道闸 + 写回 `bot.registry` |
| `item-registry.js` | 物品表写回 `bot.registry`（规则与方块**刻意不同**，见 [`registry/AGENTS.md`](../../registry/AGENTS.md)） |
| `entity-registry.js` | 给 mineflayer 认不出的模组生物补服务端真名 + 记"谁打了她 / 打了玩家"（仇恨）；`isHostileEntity` 敌对判据只此一份 |
| `perception.js` | **野外资源感知（她的"余光"，2026-09-29）**：`classifyBlock`（分类，**用真实标签**不是硬编码名单）、`cluster`（同类聚成一片）、`rank` / `renderLine`（排序 + 出那行字）、`scanAround`（32 格分段扫描，复用 `instinct/core.js` 的 `scanColumnsIn`）、以及持久记忆 `load` / `save` / `merge` / `forget` / `containerTargets`。**记忆格式见 [`memory/AGENTS.md`](../../memory/AGENTS.md)**；判据（家里/开过/太远）只此一份 |

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
