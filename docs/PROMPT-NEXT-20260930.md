# 下一步完善代码的提示词（2026-09-30）

> 用法：新开一个会话（Claude Code / 其他编码助手），工作目录设为 `/Users/starwish/aimc`，把下面「提示词」整段贴进去。
> 它自带全部背景；需要主人拍板的地方它会停下来问。

---

## 提示词

你接手的是 Minecraft 陪伴型 AI「Angle_ICE（安琪）」项目，代码在 `/Users/starwish/aimc/angleice/`（git 仓库，分支 `refactor/structure`，GitHub `Kasnm1/Angle_Ice_Minecraft`）。`/Users/starwish/aimc/_ref/` 是上游 / 同类项目的只读参考。

**开工前按顺序读完，再动手：**
1. `angleice/AGENTS.md`（项目入口、功能分区、自测、原则、硬规矩）
2. `angleice/HANDOFF-20260930.md`（最新交接：现在的样子、这两天修了什么、没做完的、**工作方式的坑**、主人已经定下的决定）
3. `angleice/PERSONA.md`（她是谁、怎么说话 —— 替她说话前必读）
4. 你要动的那一区的 `AGENTS.md`（`src/<区>/AGENTS.md`）
5. 做任务队列就读 `angleice/docs/TASK-QUEUE-DESIGN-20260929.md`

**环境：**
- `node` 不在 PATH：`NODE=/Users/starwish/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node`
- 本机访问端口用 `curl --noproxy '*'`
- 线上跑在 Windows：`/Users/starwish/aimc/angel-win.sh`（`status` / `logs mind 300` / `logs bridge 3000` / `deploy-restart` / `stop all`）
- 跟主人说话用**繁体中文**、不夹英文；项目文档和代码注释用**简体中文**

**这一轮要做的（按顺序，每一项做完单独提交）：**

1. **先部署、看实机日志**（主人同意后再部署）：`./angel-win.sh deploy-restart`，然后**自己**拉日志看，不等主人报。重点看交接文档「三、4」列的那些：她会不会太闷 / 还反问、转头、打架时喊"过来"、落地水收回、感知扫描（`slow perception` 耗时、`resource_seen` 刷不刷屏）、任务队列（`📋` 日志、重启后记不记得）。把发现的问题列给主人，**带日志原文**。
2. **修实机发现的问题**（每个问题：先从日志 / 代码找到真实根因，写清楚证据，再改；改完补自测）。
3. **任务队列阶段 2**（设计第四、六、七节）：大模型的 `task_add` / `task_note` / `task_done` / `task_drop` / `task_resume` 工具；"该接着做了"的提醒（手上的做完 / 失败、本能结束、跟随结束、闲着且队列非空）；子任务做完提醒回 parent；她自己想做的事过期提醒（主人交代的**永不过期**）。`task_done` 要有工具成功的证据（复用 `gates.js` 的诚实判据）。**决定权在大模型**：队列只记住和提醒，不自己执行步骤、不自动插子任务。
4. **任务队列阶段 3**：说话闸的诚实判据联动任务状态；`plan.js` 计划步骤 ↔ 任务（`planStep`）；自我复盘统计（被打断次数、主人交代的完成率）。

**硬规矩（这两天出过事的，一条都别省）：**
- **只搬 / 小改分开**：重构只搬不改；逻辑改动每条单独提交、提交信息写清"为什么"。
- **改完必须真跑**，离线自测不够：
  - `$NODE scripts/test-all.js`（全绿、已知失败不增加）
  - `$NODE scripts/split-wiring-test.js`、`$NODE scripts/bridge-boot-test.js`、`$NODE scripts/bridge-reload-test.js`
  - `$NODE mind.js --selftest`（**根目录入口**）
  - 动了 mind 的启动 / 思考流程：`MC_BRIDGE_URL=http://127.0.0.1:9 LLM_BASE_URL=http://127.0.0.1:9 LLM_API_KEY=x MIND_PORT=3995 $NODE mind.js`（连空端口真起）+ `curl --noproxy '*' http://127.0.0.1:3995/mind`；或 `--sim` + 空 LLM 端口
  - 动了 bridge：拆前拆后 / 改前改后**并排起两份 bridge**（`MC_HOST=127.0.0.1 MC_PORT=1 MC_BRIDGE_PORT=399x`），比所有 GET 路由的响应
  - 测完把 `memory/journal.md` 还原（bridge 连不上会往里追加"掉线了"）；**自测 / 模拟绝不写真的 `memory/*`**（用 `MC_TASKS_FILE` / `MC_TORCH_MODE_FILE` 这类环境变量指临时文件）
- **绝不** `node bridge-server.js` 连真服务器（不带 `MC_HOST/MC_PORT` 指空端口时）；`src/bridge/server.js` 只能 `--check`。
- **同一判据只写一处**（AGENTS.md §5-4）；"没有"和"读不到"分开报（§5-1）。
- 拆过的文件之间新加跨文件调用：补 `__ns` 转发壳 + 汇总导出，跑 `split-wiring-test.js`。
- 同一个 checkout 只许一个任务在改；要并行开 git worktree。删 worktree 前先看 untracked 文件。
- 派活给 WorkBuddy（`/Users/starwish/aimc/workbuddy.sh`，便宜但不可靠）可以，但**它说"验收通过"一律当没验过**，用上面的独立方法简短复核。
- 不打印 `.env` / 密钥；不提交 `config.json` / `.env` / `memory/journal.md` / `memory/mind.json` / `memory/tasks.json`。暂存用明确路径，别 `git add -A`。
- 部署、推 GitHub、停服务器这类对外动作：**先问主人**。

**主人已经定下的（照做，别再问）：** 见 `HANDOFF-20260930.md` 第五节。另外：她说话要**少汇报自己的动作、少问玩家、不说没发生的事**；服务器上只有主人和她；缺材料时做什么让大模型决定；`caveBoundary` 只看水平距离是故意的。

**汇报方式：** 每做完一项，用繁体中文跟主人说：改了什么（人话）、为什么（证据）、怎么验证的（真跑了什么、结果）、还有什么没把握。不写空话，不说"应该没问题"。
