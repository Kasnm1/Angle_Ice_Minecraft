# memory/ —— 她的记忆 + 项目的问题台账

这个目录混放两类东西，**规矩完全不同**：

| 文件 | 谁写 | 入库 | 动它之前 |
|---|---|---|---|
| `mind.json` (+`.bak`) | `memory-store.js`（她自己写的记忆：对人的看法、教训、承诺、知识图谱、心愿进度、每个世界的家） | ❌ 忽略（隐私：含对每个玩家的印象，与 `journal.md` 同等对待） | **`mind.js` 在跑时不许手改**（它整份重写，会覆盖你的改动）。先停进程，改完保留 `.bak` |
| `journal.md` | `journal.js` / `mind.js` —— 事件与聊天明文 | ❌ 忽略（隐私） | 只追加。压缩重复条目用 `scripts/journal-compact.js` |
| `state.json` | `autopilot.js` 每次存盘整份覆盖 | ❌ 忽略 | 只读。是"停机时她在哪、血量几、背包有什么"的最快来源 |
| `events.jsonl` | `events.js` 决策留痕，一行一个 JSON | ❌ 忽略 | 只读。查"她为什么做了这个决定"用它 |
| **`field-log.md`** | **开发者**（人或 agent） | ✅ | 见下 —— 项目最有价值的资产 |
| `issues-report.md` | 开发者，阶段性汇总 | ✅ | 历史快照（P1–P21 阶段），新问题不往这里写 |

## 写 `field-log.md` 的格式（必须遵守）

新问题接着最大编号往下编（当前到 P50）。每条：

```markdown
## P51 —— 一句话症状 ⚠️ 已知未修

**发现时间**：YYYY-MM-DD HH:MM
**当时的任务**：……

### 证据
（命令 + 真实输出，原样贴。不接受"我觉得"）

### 根因
（区分"没有"和"读不到"；说清是哪个文件哪一行）

### 修法
### 验证
（修完回填：怎么证明修好了 —— 自测条目 / 实机命令与输出）

### 教训
```

- 状态只有三种：`已修复` / `已知未修` / `设计如此`。
- 没有回填**验证**，不算修好。
- 推翻了之前的结论，**不删旧条目**，在原条目里追加"纠错"并链接新条目。

## 读取技巧

```bash
grep -n '^## P' memory/field-log.md          # 问题目录
grep -n '已知未修' memory/field-log.md        # 还开着的
tail -n 50 memory/events.jsonl | python3 -c 'import sys,json;[print(json.loads(l).get("action")) for l in sys.stdin]'
curl --noproxy '*' http://127.0.0.1:3003/mind  # mind.js 在跑时，她此刻的想法与记忆
```
