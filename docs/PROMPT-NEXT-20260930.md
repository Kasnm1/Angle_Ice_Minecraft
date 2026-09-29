# 下一步完善代码的提示词（雲端 AI 版，2026-09-30）

> 用法：把下面「提示词」整段贴给能读 GitHub 仓库、能自己改代码并提交的雲端 AI。
> 它**看不到主人的电脑**：没有游戏服务器、连不上 Windows、拿不到实机日志、不能部署。所以这一轮只做"能在仓库里改、能在仓库里验证"的事，
> 凡是需要实机才能确认的，必须老实标成"未验证"，交给主人。

---

## 提示词

你要改进的是 Minecraft 陪伴型 AI「Angle_ICE（安琪）」项目（Node.js，mineflayer 上的 bridge + LLM 意识层 mind）。
仓库：GitHub `Kasnm1/Angle_Ice_Minecraft`，**基于分支 `refactor/structure`** 工作（它比 `main` 新很多，`main` / `rebuild/create-mods` 不要动）。

你只能读这个仓库、在里面改代码、提交、开 PR。你**没有**：游戏服务器、Windows 机器、实机日志、部署权限、主人的私密数据（`.env` / `config.json` / `memory/*` 都不在仓库里）。

### 一、开工前：按顺序读完再动手
1. `AGENTS.md`（项目入口、功能分区、自测、贯穿全项目的原则、硬规矩）
2. `HANDOFF-20260930.md`（现状、这两天修了什么、没做完的、**工作方式的坑**、主人已定的决定）
3. `PERSONA.md`（她是谁、怎么说话 —— 动到说话相关的代码或提示词前必读）
4. 你要动的那一区的 `src/<区>/AGENTS.md`
5. 做任务队列：`docs/TASK-QUEUE-DESIGN-20260929.md`（主人确认过的设计）

### 二、环境准备
```bash
git clone https://github.com/Kasnm1/Angle_Ice_Minecraft.git && cd Angle_Ice_Minecraft
git checkout refactor/structure
npm ci                     # Node 18+（项目在 22 上验证过）
```
- 主人会另外给你一个 `angleice-local-data.zip`（**不入 git 的注册表快照和知识数据**，共 5 个文件）。**如果给了**：在仓库根目录解压（`unzip angleice-local-data.zip`），`npm test` 应该是 **106 通过 · 2 已知失败 · 0 新失败**。**如果没给**：`npm test` 照样能跑，依赖那份数据的 11 项会显示「？未验证（缺本机数据）」—— 那 11 项**不算通过**，你的 PR 里必须写明"这 11 项没验到，请主人在本机补跑 `npm test`"。
- 不要试图伪造那几个数据文件，也不要为了让测试变绿去改白名单 `scripts/test-all.config.json`。

### 三、这一轮要做的（按顺序，每一项单独一个提交）
**A. 任务队列阶段 2**（`docs/TASK-QUEUE-DESIGN-20260929.md` 第四、六、七节；阶段 1 已完成，代码在 `src/mind/mind/tasks.js`）
- 大模型用的工具：`task_add`（`when: now / next / later`，可带 `parent`）、`task_note`、`task_done`（**必须有工具成功的证据**，复用 `src/mind/mind/gates.js` 的诚实判据）、`task_drop`（主人交代的放弃前要允许她跟主人说一声）、`task_resume`。工具注册在 `src/mind/mind/tools.js` / `src/mind/body.js` 的工具表里，照现有工具（如 `set_torch_mode`）的写法。
- "该接着做了"的提醒：手上的事做完 / 失败、本能抢身体结束、跟随结束、闲着且队列非空，触发一次思考，事件里写清楚（做到哪、还有什么排着）。子任务做完提醒回 `parent`。
- 她自己想做的事（`source=self`）过期时上下文里告诉她一句；**主人交代的永不过期**。
- **决定权在大模型**：队列只记住和提醒，**不自己执行步骤、不自动插子任务**（缺材料时先去弄什么，是她决定的）。

**B. 任务队列阶段 3**（设计第八、九、十节）
- 说话闸的"诚实"判据联动任务状态：说"X 做好了"而对应任务不是 `done` → 拦。
- `plan.js` 计划步骤 ↔ 任务（`planStep`）：她开始做计划的下一步时建 `source=plan` 任务，做完 `plan.updateStep` 打勾。**计划本身不改**。
- 自我复盘统计（`src/mind/self-review.js`）：被打断次数、主人交代的完成率、过期件数。

**C. 你自己从代码里发现的、能在仓库里验证的问题**（可选）：先在 PR 里列清单和证据，再改。**不要凭猜测改行为**；需要实机日志才能判断的，只写进 PR 的"待实机验证"，不改。

**不要做**：拆 `src/instinct/core.js` 的 `install()`（1600 行闭包，拆它要改函数体，风险高，主人没要求）；改 `caveBoundary`（只看水平距离是**故意的**）；碰那两条老的红测试白名单；动 `.env` / `config.json` 相关。

### 四、硬规矩（这两天出过事的，一条都别省）
1. **改完必须真跑，光看代码不算验证：**
   - `node scripts/test-all.js`（全绿，已知失败不增加）
   - `node scripts/split-wiring-test.js`、`node scripts/bridge-boot-test.js`、`node scripts/bridge-reload-test.js`
   - `node mind.js --selftest`（**根目录入口**；`src/mind/mind.js --selftest` 是空跑）
   - 动了 mind 的启动 / 思考流程：连空端口真起一遍 ——
     `MC_TASKS_FILE=/tmp/t.json MC_BRIDGE_URL=http://127.0.0.1:9 LLM_BASE_URL=http://127.0.0.1:9 LLM_API_KEY=x MIND_PORT=3995 node mind.js`，再 `curl --noproxy '*' http://127.0.0.1:3995/mind`；或 `node mind.js --sim "帮我做把铁镐" "你在干嘛"`（LLM 指空端口，失败按退避是正常的）
   - 动了 bridge：改前改后**并排起两份 bridge**（`MC_HOST=127.0.0.1 MC_PORT=1 MC_BRIDGE_PORT=3991/3992 node bridge-server.js`，连不上服务器是正常的），比所有 GET 路由的响应（路径 / 端口 / 时间戳除外应一致）
2. **自测 / 模拟不能写真的 `memory/*`**：用 `MC_TASKS_FILE` / `MC_TORCH_MODE_FILE` 这类环境变量指到临时文件；测完 `git status` 确认没有多出 `memory/` 下的文件。
3. **离线测试走不到的路径要单独想**：`main()`、启动 / 重启流程、`try` 里静默失败的读写（存档路径丢了不会报错，只会"记不住"）。上一轮就是这类问题上线才炸的 —— 你写的每个"重启后要保留 / 启动时要读"的东西，都要有一个"重启一遍再检查"的测试。
4. **同一判据只写一处**（`AGENTS.md` §5-4）；**"没有"和"读不到"分开报**（§5-1）；找不到证据保守为 false，不猜。
5. 拆过的文件之间新加跨文件调用：补 `__ns` 转发壳 + 汇总导出，跑 `split-wiring-test.js`（背景见 `src/bridge/AGENTS.md`「四个坑」）。
6. 提示词（`src/mind/mind/prompt.js`、`PERSONA.md`）改动**小而准**：每处在 PR 里贴改前 / 改后，别整段重写。
7. 提交：**用明确路径 `git add <文件>`，别 `git add -A`**；一项一个提交，提交信息说清"为什么"（带证据）。代码注释、文档一律**简体中文**，跟现有风格一致。
8. 不提交 `config.json` / `.env*` / `memory/journal.md` / `memory/mind.json` / `memory/tasks.json` / 注册表快照 / `knowledge/generated/`；不打印任何密钥。
9. 分支与 PR：从 `refactor/structure` 开新分支（例如 `cloud/task-queue-p2`），推到 GitHub，**开 PR 合回 `refactor/structure`**。**不要 force push，不要直接推 `refactor/structure` / `main` / `rebuild/create-mods`。**

### 五、主人已经定下的（照做，别再问）
- 缺材料时做什么**让大模型决定**；队列只负责"记住"和"摆到她眼前"。
- **主人交代的事自动进队列、没有过期时间**；重启后保留，醒来第一轮提醒她。
- 她说话要**少汇报自己的动作、少问玩家、不说没发生的事**；他问她打算干嘛，直接说打算，别把问题反问回去。
- 服务器上**只有主人和她**（野外箱子都能开，不用防"别人家的"）。
- 落地水：家外 ≥ 血量一半或 ≥ 6 点才倒，家里只在会摔死时倒；倒了要收回。
- 水下的东西默认不挖，除非只在水里有或很重要。
- 家里插火把先问一次，下矿 / 探险自动插。
- 重构期间：搬文件只搬不改；逻辑改动每条单独提交。

### 六、需要主人拍板时怎么办
你没法实时问主人。遇到需要决定的事：**选保守的默认做法**（不丢数据、不乱打断、不多说话），在 PR 描述的「需要主人决定」一节写清楚：问题是什么、你选了什么、另一个选择是什么、各自后果。**不要因此停下不干**。

### 七、PR 描述格式（繁体中文，主人直接看）
1. **做了什么**（人话，不超过 10 行）
2. **为什么**（证据：代码位置 / 设计文档条款 / 你复现出的现象；不是猜的）
3. **怎么验证的**（上面第四节列的命令 + 关键输出原文；哪些用了空端口真起、哪些并排比对了）
4. **没验到的**：缺本机数据的 11 项、需要实机才能确认的行为（逐条写：要看什么日志、期待看到什么）
5. **需要主人决定**（第六节）
6. **风险**：这次改动最可能坏在哪里、怎么回退（哪个提交）

不写"应该没问题"这类话。不确定就写不确定。
