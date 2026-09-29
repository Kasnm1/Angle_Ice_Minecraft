# `src/mind/` —— 意识 / 人格（LLM 层）

> 从根 AGENTS.md「功能分区」的**③ 意识 / 人格**拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)，
> 以及 [`PERSONA.md`](../../PERSONA.md)（替她说话前必读）。

## 文件

| 文件 | 职责 |
|---|---|
| `mind.js` | `:3003`。一条连续的经历流：`look()` 看世界 → 事件 debounce → `think()` 多轮调模型（可查书）→ `runTool()`；`instinctEat` / `fastPath`（"停""跟我来"）是仅有的程序本能；上下文快满 → `sleepAndSort()` 她自己整理记忆、写日记。`cli(argv)` 是命令行入口（`--selftest` / `--sim` / 直接跑） |
| `body.js` | "能做什么"：`TOOLS`（bridge 动作 + 查书）、`bridge` 客户端、模型调用（主/备线路、重试）、读 `.env`。**不放任何"该怎么做"的判断**。`personalInventory`（`inventory` 工具，2026-09-29 问题 4）：背包快照太旧/从没看过时**自己 `POST /backpack/open` 刷新一次**，不再让 LLM 先 `open_backpack`；刷不动就如实报"读不到"，绝不说"没有" |
| `memory-store.js` | `memory/mind.json`：`people` / `memories` / `journal` / `episodes` / `skills` / `ambition` / `homes`。强化、遗忘（半衰期 14 天）、按此刻涉及的人/物 `recall` |
| `speech.js` | 发送前把一段话拆成 2–4 条短消息；**只拆不改字**（保真校验）；危险提示不拆；括号小动作不发 |
| `ambition.js` | 《食录逸闻》食物清单与进度；`candidates()` 只给可能性，不替她决定 |
| `plan.js` | 长期计划：没人找她时自己推进游戏，以香草纪元通关主线为骨干 |
| `night.js` | 天黑本能：天色变化的事件 + 今晚怎么安排 |
| `self-review.js` | 她玩的时候自己察觉 / 程序记下的不对劲（新问题的线索） |
| `llm-codex.js` / `llm-workbuddy.js` | 中转站全挂时的本机兜底（Codex gpt-6-luna xhigh → WorkBuddy）。对话翻译只在 `llm-workbuddy.js` 里有一份，Codex 复用它 |
| `events-reader.js` | 只读 `memory/events.jsonl`（旧脑干留下的决策留痕，历史证据；文件已冻结不再新增） |

## 设计立场（别走回头路）

- **不往程序里加"聪明规则"**替她做判断。该让她学会的，走记忆（她自己写 lesson），
  或者改 `PERSONA.md` / 给她的工具说明。程序只保留**本能**。
- 说与做一致：她说"在做木镐"，状态里就必须真有这件事。
- 动作结果以 bridge 返回的**实际变化**为准，不以"调用成功"为准。
- **说话出口的四道闸是例外**（`mind.js` 的 `REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `HONEST_NUDGE`，
  以及原有的 `LOOK_NUDGE` / `DECIDE_NUDGE`）：它们是主人 2026-09-29 明确要的"少汇报、少问、不说没发生的事"，
  拦下后**不静默吞掉** —— 往历史里塞一条 `ok:false` + 提示，让她自己重想。
  判据在 `speech.js` 的 `classify()`（只此一处，`scripts/speech-audit.js` 也用这一份）。
  **加一类完成式只改 `mind.js` 的 `FACT_CLAIMS` 表**；加一类说话内容改 `classify()`。

## 必须知道

- `memory/mind.json` 在 `mind.js` 运行时会被整份重写 —— **进程在跑时不要手改**。
- 自测 / `--sim` 用 `MC_MIND_FILE` 指向临时文件，**绝不能写进真的 `memory/mind.json`**。
- `.env` 里有 `LLM_API_KEY` —— 不打印、不写进日志、不提交。
- 调人格/说话形态后用 `node scripts/speech-audit.js` 拿数字说话。
  实机日志也能直接量：`node scripts/speech-audit.js logs/mind-win-20260929.log`（形态 + 汇报/问/回话/其他 的比例）。

## 自测

```bash
$NODE mind.js --selftest; $NODE src/mind/memory-store.js --selftest
$NODE src/mind/night.js --selftest; $NODE src/mind/plan.js --selftest
$NODE src/mind/speech.js --selftest; $NODE src/mind/ambition.js --selftest
$NODE src/mind/self-review.js --selftest; $NODE src/mind/events-reader.js --selftest
$NODE --check src/mind/body.js
$NODE src/mind/llm-codex.js --selftest; $NODE src/mind/llm-workbuddy.js --selftest   # --live 会真调一次（花额度）
# 从根入口跑（Windows 脚本用的就是这个）：
$NODE mind.js --selftest
$NODE mind.js --sim "安琪你好" "给你7个鸡蛋"    # 假身体 + 真模型，会消耗 API 额度
```

## 第 3 步会拆

`mind.js`（2786 行）第 3 步按"看世界（look）/ 想（think 循环 + 退避）/ 提示词拼装 /
工具分组 / 说话节奏"分文件；`SYSTEM` 提示词整体搬进 `prompt.js`，**内容一字不改**。
现在只管放对区。
