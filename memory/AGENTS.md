# memory/ —— 她的记忆 + 项目的问题台账

这个目录混放两类东西，**规矩完全不同**：

| 文件 | 谁写 | 入库 | 动它之前 |
|---|---|---|---|
| `mind.json` (+`.bak`) | `src/mind/memory-store.js`（她自己写的记忆：对人的看法、教训、承诺、知识图谱、心愿进度、每个世界的家） | ❌ 忽略（隐私：含对每个玩家的印象，与 `journal.md` 同等对待） | **`src/mind/mind.js` 在跑时不许手改**（它整份重写，会覆盖你的改动）。先停进程，改完保留 `.bak` |
| `journal.md` | `src/bridge/server.js` 的 `journal()` / `src/mind/mind.js` —— 事件与聊天明文 | ❌ 忽略（隐私） | 只追加。（原来还有个 `journal.js` 做折叠，**2026-09-28 已删**，连同 `scripts/journal-compact.js`） |
| `state.json` | 旧脑干 `autopilot.js` 每次存盘整份覆盖 —— **该文件已删（2026-09-28），所以 `state.json` 不会再更新** | ❌ 忽略 | 只读。是**历史**上"停机时她在哪、血量几、背包有什么"的快照 |
| `self-review.jsonl` | `src/mind/self-review.js` —— 自我复盘：程序在异常点自动记 + 她用 `report_issue` 留的纸条 | ❌ 忽略（现场里有玩家聊天原文） | 只追加。读报告用 `node src/mind/self-review.js`；确认是 bug 的再按下面格式整理进 `field-log.md` |
| `events.jsonl` | 旧脑干 `events.js` 决策留痕，一行一个 JSON —— **写入侧已删（2026-09-28），不再新增**；最后一条 2026-09-25 | ❌ 忽略 | 只读，用 `node src/mind/events-reader.js --tail 30`。查"她**当时**为什么做了这个决定"用它 |
| `containers-seen.json` | `src/body/util.js` 的 `SEEN_FILE` —— **开过的容器**（箱子/木桶/矿车）的 `"x,y,z"` 键数组 | ❌ 忽略 | 原子写（`.tmp` + `renameSync`）。删一条 = 让她"忘了开过"，下次还会去开 |
| **`resources.json`** | `src/world/perception.js` —— **野外资源记忆**（她的"余光"看过就记）：资源片 + 野外容器位置 | ❌ 忽略（是她走过哪儿的行踪） | 见下面「`resources.json` 的格式」。原子写；跑着的时候别手改（本能每 5 秒整份重写） |
| **`field-log.md`** | **开发者**（人或 agent） | ✅ | 见下 —— 项目最有价值的资产 |
| `issues-report.md` | 开发者，阶段性汇总 | ✅ | 历史快照（P1–P21 阶段），新问题不往这里写 |

## `resources.json` 的格式（野外资源记忆）

谁写：`src/world/perception.js`（纯函数）+ `src/instinct/core.js` 的 `perceptionTimer`（每 5 秒一批，
分段让出，不卡进程）。谁读：本能 `tryLoot`、bridge `GET /resources`、mind 的【附近看得见的】。
路径：`$MC_RESOURCES_FILE` 或 `memory/resources.json`（自测一律用临时文件，**绝不写这个真文件**）。

```jsonc
{
  "at": 1790628000000,          // 上次存盘时刻（ms）
  "dim": "minecraft:overworld", // 上次扫描所在维度（跨维度的记忆不合并）
  "places": [
    {
      "kind": "clay",             // 类别键，见 perception.js 的 KIND（log/ore/clay/container/…）
      "name": "minecraft:clay",   // 代表方块名（一片里出现最多的那个）
      "center": { "x": 120, "y": 62, "z": -300 },  // 这一片的中心（整数格）
      "count": 14,                // 这一片有多少块
      "underwater": true,         // **整片**都在水下才是 true（露头的粘土不算）
      "tier": 2,                  // 矿才有：这一片里**最难挖**的等级（来自 knowledge/ores.json）
      "weight": 1,                // 久未确认会被降权（×decayRate）；这是"我多久没见它了"的置信度
      "dim": "minecraft:overworld",
      "seenAt": 1790628000000,    // 第一次看见
      "confirmedAt": 1790628000000 // **最近一次**看见（走一趟没看见 → 会被删，见下）
    }
  ]
}
```

> `distance` / `direction` / `value` / `opened` **不落盘** —— 它们是"此刻相对她"的渲染属性，
> 由 `rank()` / `renderLine()` 在每次读的时候现算（`opened` 由 `containerTargets` 跟
> `containers-seen.json` 对账得到）。存进去只会过期。

**"没了"和"没去确认"必须分开**（任务书硬性要求，主人点名）：

| 情形 | 怎么判 | 结果 |
|---|---|---|
| 她走过去看了，那片没了（采光了 / 别人挖了） | `forget(store, { near: {x,y,z}, goneRadius })` | **删掉**（进 `gone` 列表）——"这里没有了"，下次不再去 |
| 只是好久没再看见（没去那个方向） | 超过 `decayAfterMs`（默认 30 分钟） | **降权**（`weight *= decayRate`，进 `decayed` 列表），低于 `dropBelow` 才删。**不删** —— 她只是没去看，不代表没有 |
| 记忆文件读不出来 | `load()` 抛/返回空 | 报"读不到"，**不是"没有"**。`containerTargets` 返回 `[]`，`tryLoot` 只按看得见的算，绝不编 |

合并：同一维度、`mergeDist`（默认 6 格）内、同 `kind` 的两次发现**合成一条**（`confirmedAt` 刷新）。
容器额外用 `placeKey`（`"x,y,z"`，与 `body/util.js` 的 `storageKey` 同形）跟 `containers-seen.json` 对账。

## 写 `field-log.md` 的格式（必须遵守）

新问题接着最大编号往下编（当前到 P53）。每条：

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
tail -n 50 memory/events.jsonl | python3 -c 'import sys,json;[print(json.loads(l).get("action")) for l in sys.stdin]'   # 历史留痕（不再新增）
curl --noproxy '*' http://127.0.0.1:3003/mind  # src/mind/mind.js 在跑时，她此刻的想法与记忆
```
