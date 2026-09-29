# `src/mind/` —— 意识 / 人格（LLM 层）

> 从根 AGENTS.md「功能分区」的**③ 意识 / 人格**拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)，
> 以及 [`PERSONA.md`](../../PERSONA.md)（替她说话前必读）。

## 文件

| 文件 | 职责 |
|---|---|
| `mind.js` | `:3003`。**汇总入口**（第 3 步 e 之后只剩 161 行，普通文件不是符号链接）：`require('./mind/*')` 后按原顺序 `module.exports`，导出名与顺序钉在 `references/exports-mind.json`；`main()` / `sim()` / `cli(argv)`（`--selftest` / `--sim` / 直接跑）也在这里。正文按下面 `mind/` 子表拆开。**仓库根的 `mind.js` 只有 22 行**，是 Windows 脚本用的转发壳（`require('./src/mind/mind.js')` + 转调 `cli`） |
| `body.js` | "能做什么"：`TOOLS`（bridge 动作 + 查书）、`bridge` 客户端、模型调用（主/备线路、重试）、读 `.env`。**不放任何"该怎么做"的判断**。`personalInventory`（`inventory` 工具，2026-09-29 问题 4）：背包快照太旧/从没看过时**自己 `POST /backpack/open` 刷新一次**，不再让 LLM 先 `open_backpack`；刷不动就如实报"读不到"，绝不说"没有" |
| `memory-store.js` | `memory/mind.json`：`people` / `memories` / `journal` / `episodes` / `skills` / `ambition` / `homes`。强化、遗忘（半衰期 14 天）、按此刻涉及的人/物 `recall` |
| `speech.js` | 发送前把一段话拆成 2–4 条短消息；**只拆不改字**（保真校验）；危险提示不拆；括号小动作不发 |
| `ambition.js` | 《食录逸闻》食物清单与进度；`candidates()` 只给可能性，不替她决定 |
| `plan.js` | 长期计划：没人找她时自己推进游戏，以香草纪元通关主线为骨干 |
| `night.js` | 天黑本能：天色变化的事件 + 今晚怎么安排 |
| `self-review.js` | 她玩的时候自己察觉 / 程序记下的不对劲（新问题的线索） |
| `llm-codex.js` / `llm-workbuddy.js` | 中转站全挂时的本机兜底（Codex gpt-6-luna xhigh → WorkBuddy）。对话翻译只在 `llm-workbuddy.js` 里有一份，Codex 复用它 |
| `events-reader.js` | 只读 `memory/events.jsonl`（旧脑干留下的决策留痕，历史证据；文件已冻结不再新增） |

### `mind/`（第 3 步 e 从 `mind.js` 拆出，只搬移不改逻辑）

原 `mind.js` 3250 行 → 汇总壳 161 行 + 下列子文件。**`W` 是进程内唯一一份可变状态**，
只有 `state.js` 持有，其余文件 `require('./state')` 取同一份，绝不复制。

| 文件 | 行数 | 职责 |
|---|---|---|
| `mind/state.js` | 137 | 唯一的 `W`（历史/待办/统计/工作…）与 `CFG`；集中所有对外部模块的 `require`（`body` / `speech` / `memory-store` / `knowledge` / …）。其余文件从这里取共享引用 |
| `mind/prompt.js` | 137 | `SYSTEM` 提示词整体搬来，**一字不改** |
| `mind/runtime.js` | 132 | `log` / `hhmmss` / `scene`（此刻场记）/ `emit`（事件入流）/ `chatWaitLeft` / `typingMs` / `chatGate` / `scheduleThink`（debounce）。模块级 `thinkTimer` / `thinkTimerAt` **只在这里**，外部经 `readingThinkTimer()` / `readingThinkTimerAt()` / `clearThinkTimer()` 读改 |
| `mind/scene.js` | 234 | 情境快照与拼装：`humanState` / `tonight` / `combatInstinct` / `survivalFocus` / `dropsNear` / `invText` / `surroundNeeds` / `pickJoinMood` / `JOIN_MOODS` … |
| `mind/look.js` | 245 | `look()`：每轮"想"之前看一眼世界（状态/背包/聊天/余光/门/箱/亮度），新东西 `emit()`。**拼"长期计划"那段整块留在这里**，方便与 `feat/campaign-quests` 分支合并 |
| `mind/gates.js` | 167 | 说话/汇报/提问的判据表：`REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `ASK_BACK_NUDGE` / `HONEST_NUDGE` / `FACT_CLAIMS` / `claimState` / `liveFails` / `taskDoneAllowed` / `isOverAsking` / `lastProactiveUnanswered` … |
| `mind/tools.js` | 328 | `MIND_TOOLS` 工具表与分组：`SPECS` / `GROUPS` / `TOOL_GROUPS` / `GROUP_CUES` / `pickSpecs` / `groupsFromBody` / `activateGroup` / `activeGroups`；仓库位 `knownStations` / `homeStockItems` / `shortName` |
| `mind/actions.js` | 239 | 把"想"变成"做"：`startJob`（**阶段 1 起先问任务层该不该打断**、busy 有限次重试）/ `runTool`（附"同一目的地"提醒）/ `toolResultLine` / `fmtArgs` / `celebrate` / `learnFromDoing`；反射级 `instinctEat` / `NAME_RE` / `FAST` / `matchFast` / `fastPath`。`MIND_TOOLS` 经 Proxy 延迟取（见下） |
| `mind/tasks.js` | 836 | **任务队列（阶段 1，2026-09-29）**：任务对象 + 队列 + 持久化（`memory/tasks.json`）+ 打断判据（只此一份）。纯函数 + 显式状态（挂 `W.tasks`），不 require 兄弟文件，可单独 `$NODE src/mind/mind/tasks.js --selftest`。本阶段不做 `task_*` 工具 / 提醒 / 联动（阶段 2、3），字段已留位 |
| `mind/think.js` | 823 | `think()` 多轮调模型主循环 + 上下文压实：`historyChars` / `bodyNow` / `tasksBlock` / `planExtras` / `planLine` / `buildNow` / `repetitionHint` / `idleGate` / `compactLastNow` / `clipText` / `trimDangling` / `sleepAndSort` / `sortMemories` / `holdBody` / `startControl` … |
| `mind/selftest.js` | 1367 | `selftest()`（312 条）与 `mockBridge()`。**>1300 行**（原样搬移 + 阶段 1 任务队列那段）——下一步可选再分 |
| `mind/wiring.js` | 43 | **拆环中枢**：`think ↔ runtime`、`tools ↔ actions` 互相调用，只能延迟取。每个导出是 `() => require('./x')`，首次调用才加载。含 `tasks` |

**循环依赖怎么办**（拆环的三招，改名前先看这里）：

1. `wiring.js` 的 `lazy(name)` —— 互相递归的两文件不在加载期解构，而是**第一次调用时**才 `require`。
2. `MIND_TOOLS` **Proxy 门面** —— `actions.js` / `think.js` 要读工具表，但 `tools.js` 又回头用
   `startJob` / `runTool`。用 `new Proxy({}, { get: … wiring.tools().MIND_TOOLS[k] })` 把"读"延迟到访问那一刻。
3. `thinkTimer` 的**访问器转发** —— 模块级 `let` 不能复制，只在 `runtime.js` 一份，别的文件调 `readingThinkTimer()`。

## 设计立场（别走回头路）

- **不往程序里加"聪明规则"**替她做判断。该让她学会的，走记忆（她自己写 lesson），
  或者改 `PERSONA.md` / 给她的工具说明。程序只保留**本能**。
- 说与做一致：她说"在做木镐"，状态里就必须真有这件事。
- 动作结果以 bridge 返回的**实际变化**为准，不以"调用成功"为准。
- **说话出口的五道闸是例外**（现在在 `mind/gates.js` 的 `REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `ASK_BACK_NUDGE` / `HONEST_NUDGE`，
  以及原有的 `LOOK_NUDGE` / `DECIDE_NUDGE`）：它们是主人 2026-09-29 明确要的"少汇报、少问、不说没发生的事、别把问题反问回去"，
  拦下后**不静默吞掉** —— 往历史里塞一条 `ok:false` + 提示，让她自己重想。
  判据在 `speech.js` 的 `classify()` / `asksBack()`（**只此一处**，`scripts/speech-audit.js` 也用这一份）。
  **加一类完成式只改 `mind/gates.js` 的 `FACT_CLAIMS` 表**；加一类说话内容改 `classify()`。
  ⚠️ `ASK_BACK_NUDGE` 与 `HONEST_NUDGE` 一样**不看 `heJustSpoke`** —— 他刚开口时"回答他不受限"是给
  **回答**的，不是给"把决定推回给他"的反问的（2026-09-29 实机 19:10:16 的"你想去哪呀"）。

## 必须知道

- `memory/mind.json` 在 `mind.js` 运行时会被整份重写 —— **进程在跑时不要手改**。
- 自测 / `--sim` 用 `MC_MIND_FILE` 指向临时文件，**绝不能写进真的 `memory/mind.json`**。
- `.env` 里有 `LLM_API_KEY` —— 不打印、不写进日志、不提交。
- 调人格/说话形态后用 `node scripts/speech-audit.js` 拿数字说话。
  实机日志也能直接量：`node scripts/speech-audit.js logs/mind-win-20260929.log`（形态 + 汇报/问/回话/其他 的比例）。

## 自测

```bash
# mind.js 拆开后（第 3 步 e）：根入口跑 --selftest（312 条）；
# 子文件都没有 --selftest 分支（跑了是空操作）——例外是 mind/tasks.js（纯函数，自带 65 条），只做 --check。
$NODE mind.js --selftest
$NODE src/mind/mind/tasks.js --selftest          # 任务队列（阶段 1），可单独跑
for f in src/mind/mind/*.js; do $NODE --check $f || echo BAD $f; done
$NODE src/mind/memory-store.js --selftest; $NODE src/mind/night.js --selftest
$NODE src/mind/plan.js --selftest; $NODE src/mind/speech.js --selftest
$NODE src/mind/ambition.js --selftest; $NODE src/mind/self-review.js --selftest
$NODE src/mind/events-reader.js --selftest; $NODE --check src/mind/body.js
$NODE src/mind/llm-codex.js --selftest; $NODE src/mind/llm-workbuddy.js --selftest   # --live 会真调一次（花额度）
# 从根入口跑（Windows 脚本用的就是这个）：
$NODE mind.js --sim "安琪你好" "给你7个鸡蛋"    # 假身体 + 真模型，会消耗 API 额度
```

> ⚠️ `$NODE src/mind/mind.js --selftest` 是**空操作**（汇总壳没有 CLI 分支）——自测一律走根入口 `mind.js`。
> 导出名/顺序的防线在 `references/exports-mind.json`，由 `scripts/test-all.js` 的 `checkMindExports` 校验。

## 第 3 步 e 已完成（2026-09-29）

`mind.js`（3250 行）已拆成 `mind.js` 汇总壳 + `mind/*.js`（见上表）。**只搬移、不改逻辑**：
函数体逐字节一致（`scripts/refactor/check-moved.js` 核对），唯一允许的改动是
require / 转发壳 / 汇总导出、以及 `thinkTimer` 的访问器转发（`sim` 1 处、`selftest` 16 处）。
对外 `module.exports` 的名字与顺序不变。之后改正文去 `mind/` 下对应文件。
