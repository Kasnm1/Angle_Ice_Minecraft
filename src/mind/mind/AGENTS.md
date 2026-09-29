# `src/mind/mind/` —— 意识 / 人格的正文（第 3 步 e 拆出来的）

> 从 [`../AGENTS.md`](../AGENTS.md)（`src/mind/` 意识 / 人格）拆过来。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../../AGENTS.md)，
> 以及 [`PERSONA.md`](../../../PERSONA.md)（替她说话前必读）。
>
> **2026-09-29 第 3 步 e：`src/mind/mind.js` 3250 行拆成这里的 11 个文件**（纯搬移、零改逻辑）。
> 入口仍是 `src/mind/mind.js`，但现在它只剩 160 行的**汇总壳**：require 子文件 →
> 按**原顺序** `module.exports`（导出名与顺序钉在 `references/exports-mind.json`）。
> 外部照旧 `require('../mind/mind')`，路径没变；它是**普通文件，不是符号链接**。

## 文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `state.js` | 137 | **唯一的 `W`**（历史 / 待办 / 统计 / 工作 / 慢看缓存…）与 `CFG`；集中所有对外部模块的 `require`（`../body` / `../speech` / `../memory-store` / `../knowledge` / `../ambition` / `../self-review` / `../inventory-ledger` / `../night` / `../plan` / `../storage-policy` / `../../log-stamp` …）。其余文件一律从这里取共享引用 |
| `prompt.js` | 137 | `SYSTEM` 提示词整体搬来，**一字不改** |
| `runtime.js` | 132 | `log` / `hhmmss` / `scene`（此刻场记）/ `emit`（事件入流）/ `chatWaitLeft` / `typingMs` / `chatGate` / `scheduleThink`（debounce）。模块级 `thinkTimer` / `thinkTimerAt` **只在这里** |
| `scene.js` | 234 | 情境快照与拼装：`humanState` / `tonight` / `combatInstinct` / `combatGuard` / `survivalFocus` / `dayKey` / `dropsNear` / `invText` / `surroundNeeds` / `pickJoinMood` / `JOIN_MOODS` / `shortName` … |
| `look.js` | 245 | `look()`：每轮"想"之前看一眼世界（状态 / 背包 / 附近 / 玩家 / 聊天 / 门 / 装备 / 箱 / 亮度 / 余光），新东西 `emit()`；第一次见某人 `mem.meet()` |
| `gates.js` | 167 | 说话 / 汇报 / 提问的判据表：`REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `ASK_BACK_NUDGE` / `HONEST_NUDGE` / `FACT_CLAIMS` / `claimState` / `liveFails` / `unbackedClaim` / `taskDoneAllowed` / `isOverAsking` / `lastProactiveUnanswered` / `isBareAffirmative` / `PLAYER_MOVE_*` / `TASK_*` / `*_NUDGE` … |
| `tools.js` | 328 | `MIND_TOOLS` 工具表与分组：`ALL` / `SPECS` / `GROUPS` / `TOOL_GROUPS` / `UNGROUPED` / `GROUP_ROUNDS` / `GROUP_CUES` / `pickSpecs` / `groupsFromBody` / `activateGroup` / `activeGroups` / `kindOf`；仓库位 `knownStations` / `homeStockItems` / `shortName` |
| `actions.js` | 214 | 把"想"变成"做"：`startJob` / `runTool` / `toolResultLine` / `fmtArgs` / `celebrate` / `learnFromDoing`；反射级 `instinctEat` / `NAME_RE` / `FAST` / `matchFast` / `fastPath` |
| `think.js` | 771 | `think()` 多轮调模型主循环 + 上下文压实：`historyChars` / `bodyNow` / `planExtras` / `planLine` / `buildNow` / `repetitionHint` / `particleHint` / `idleGate` / `compactLastNow` / `clipText` / `repairHistory` / `trimDangling` / `sleepAndSort` / `sortMemories` / `holdBody` / `startControl` … |
| `selftest.js` | 1071 | `selftest()`（243 条）与 `mockBridge()`。**>900 行**（原样搬移，未再拆）——可选下一步 |
| `wiring.js` | 41 | **拆环中枢**：每个导出是 `() => require('./x')`，第一次调用时才加载（见下） |

## 拼接是怎么把循环依赖解开的（改代码前先读这段）

拆分前整块是一个文件，名字互相引用天然没问题。拆开后有两个**真环**：

- `think ↔ runtime`：`runtime.scheduleThink()` 到点要调 `think()`；`think()` 里又要 `emit()` / `scene()`（runtime）。
- `tools ↔ actions`：`tools.js` 的 `MIND_TOOLS` 表里直接调 `startJob` / `runTool`（actions）；`actions.runTool` 又要查 `MIND_TOOLS`。

解法（与 `src/bridge/` 拆分同一套思路）：

1. **延迟取（`wiring.js`）**：互相递归的两文件**不在加载期解构**，而是
   `const wiring = require('./wiring')` + 转发壳 `function think (...a) { return wiring.think().think.apply(null, a); }`，
   第一次调用才 `require`。
2. **Proxy 门面**：`actions.js` / `think.js` 要读工具表，但 `tools.js` 回头用本文件的函数 ——
   用 `new Proxy({}, { get: (_, k) => wiring.tools().MIND_TOOLS[k], … })` 把"读"延迟到访问那一刻
   （原来那份原件靠 `typeof MIND_TOOLS !== 'undefined'` 守卫，拆开后换成 Proxy 取**同一份**）。
3. **模块级 `let` 用访问器**：`thinkTimer` / `thinkTimerAt` 在运行中被**重新赋值**，不能复制。
   只有 `runtime.js` 持有，别的文件经 `runtime.readingThinkTimer()` / `readingThinkTimerAt()` /
   `clearThinkTimer()` 读改（`sim` 1 处、`selftest` 16 处按此改写，是**唯一允许**改逻辑以外的改动）。

## 铁律

- **`W` 是进程内唯一一份可变状态**。只在 `state.js` 里 `const W = {…}`；别的文件
  `require('./state')` 解构拿到的是**同一个对象引用**。**绝不**在别处再写一份 `W` / `CFG`。
- **不自测就空转**：子文件都**没有** `--selftest` 分支（跑了是空操作）。自测一律走根入口
  `$NODE mind.js --selftest`（243 条）。`$NODE src/mind/mind.js --selftest` 是空操作，别用。
- **导出名与顺序不许动**：`module.exports` 的名字与顺序钉在 `references/exports-mind.json`，
  由 `scripts/test-all.js` 的 `checkMindExports` 守。加/改导出名会被拦。
- **改正文要对得上快照**：拆分后的核对用
  `$NODE scripts/refactor/check-moved.js --before <拆前 ref> --files src/mind/mind.js --after <逗号列表>`，
  函数体必须逐字节一致（唯一例外是上面那条 `thinkTimer` 访问器）。
- **`look()` 里拼"长期计划"那一小段整块留在 `look.js`**，别挪去别处 ——
  `feat/campaign-quests` 分支（也在改长期计划）之后要合这一块。
- 说话出口的五道闸（`REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `ASK_BACK_NUDGE` / `HONEST_NUDGE` + 原有 `LOOK_NUDGE` / `DECIDE_NUDGE`）
  在 `gates.js`。**加一类完成式只改 `gates.js` 的 `FACT_CLAIMS` 表**；加一类说话内容改 `speech.js` 的 `classify()` / `asksBack()`。
- `dark_spot` 事件报的暗处坐标（`sample`）由 `look()` 记进 `W.darkSpots`，`actions.js` 的 `runTool` 在她调
  `light_up` 且没自己给 `spots` 时自动带上 —— 本能已经数过是哪几格了，不用她再找一遍（2026-09-29 问题 B）。
- 别把"聪明规则"加回程序里（见 `../AGENTS.md` 的设计立场）。程序只保留**本能**。

## 自测

```bash
$NODE mind.js --selftest                                  # 243 条，唯一的 mind 自测入口
for f in src/mind/mind/*.js; do $NODE --check $f || echo BAD $f; done
$NODE scripts/refactor/check-moved.js  --before <ref> --files src/mind/mind.js --after <清单>   # 原文一字不改
$NODE scripts/refactor/check-toplevel.py <ref> src/mind/mind.js src/mind/mind                   # 函数之间的顶层语句没丢
$NODE scripts/refactor/check-scope.js    <ref> src/mind/mind.js src/mind/mind                   # 没有用到没拿到的名字
$NODE scripts/split-wiring-test.js        # 转发壳目标存在 + 兄弟文件导出调用的声明齐全
$NODE scripts/test-all.js                 # 全套；含 checkMindExports（36 导出名 + 顺序）
```
