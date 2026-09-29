# Angle_Ice_Minecraft

把任意 agent 接到**活着的 Minecraft Java 世界**上的本地 HTTP 桥 —— 支持 Forge/FML 模组服。
它同时是一个**有人格的陪玩**：游戏内 ID 固定 `Angle_ICE`，有自己的情绪、自己的记忆
（`memory/journal.md`），跨会话、跨 agent 都还是同一个人。

> 她不是工具。默认**闭嘴**：你不问，她就不讲。不主动科普、不指路、不报键位、
> 上线也不打招呼（身体可以主动 —— 转头、跟过来；嘴不行）。
> 只有四种情况开口：**被问 / 真实危险 / 她自己出事 / 你先搭话。**
> 人格正文见 [`PERSONA.md`](PERSONA.md)。

当前版本 **1.12.0** · 许可 **MIT-0** · 上游 `minecraft-bridge` 的本地分支

> 开发入口是 [`AGENTS.md`](AGENTS.md)（功能分区路由、自测命令、硬规矩、现状与待办）；
> 最近一次交接见 [`HANDOFF-20260928.md`](HANDOFF-20260928.md)。

---

## 这是什么

三层，从下往上：

| 层 | 文件 | 干什么 |
|---|---|---|
| **手 + 眼 + 本能** | `bridge-server.js`（+ `src/bridge/` `src/body/` …） | 在 `127.0.0.1:3001` 暴露 HTTP 接口：读状态、做动作（走 / 挖 / 放 / 合成 / 开箱子 / 种地 / 任务书 / 命令 …） |
| ↑ 本能 | `src/instinct/instinct.js`（bridge 进程内） | 身体自己会的反射：打有仇恨的怪、捡东西、收庄稼、挖看得见的矿、开宝箱、逛洞、搭路、落地水、睡觉、换护甲、整理随身物品、暗处提醒 …；任何命令一到就让出身体（只有战斗反过来叫停命令） |
| **意识** | `mind.js` + `src/mind/body.js`（`127.0.0.1:3003`） | LLM 持续经历流：她自己决定做什么、说什么、记什么；长期计划 `src/mind/plan.js` 以香草纪元通关主线为骨干 |
| **人** | `PERSONA.md` + `memory/` | 人格与持久记忆，跨会话、跨 agent 都还是同一个人 |

> 早期的自主层 `autopilot.js`（脑干，:3002，规则打分循环）与 `brain.js`（快脑/主脑双模型）
> 已于 **2026-09-28** 删除（`mind.js` + `instinct.js` 取代）。其中 `pickAutoEquip`
> 判据没有丢，原样搬到了 [`src/body/equip-policy.js`](src/body/equip-policy.js)。见
> [`docs/REFACTOR-PLAN-20260928.md`](docs/REFACTOR-PLAN-20260928.md)。

**不绑定任何 agent 运行时** —— 它就是个本地 HTTP 服务，谁都能驱动。

---

## 为什么值得看

这个项目大半时间花在「为什么读不到 / 走不动 / 说不出来」上。结论都钉进了代码注释和
[`SKILL.md`](SKILL.md)，这里是几个最不显然的：

| 症状 | 真因 |
|---|---|
| 模组服上方块名全是错的、甚至物理上不可能 | `prismarine-block/index.js:125` 的 else 分支**不覆盖 `this.type`**，而 1.13+ 的 `fromStateId` 传进来的就是 `undefined`。**调色板必须写回注册表**，光当旁路查表等于没导 |
| 模组物品说不出名字 | 同一处病，在 `prismarine-item/index.js:36`。连带 `/drop`、`/collect`、`/equip`、`/craft`、`/place` 一起失效（1.10.0 修复） |
| 她会拆玩家的房子 | `canDig=false` 把「最后手段」一起砍了，反而让 `No path` 变多。正解是抬高 `digCost` + 按名字硬禁建筑材质 |
| 她走进深水会淹死 | 物理层不会自己浮上来 |
| 她干活时听不见你说话 | `chatlog` 在 tick 开头读，而 tick 会被长动作阻塞最长 45s → 耳朵必须是独立回路 |
| KubeJS 诊断脚本把客户端搞出阻断弹窗 | `startupErrorGUI=true`，任何 startup 脚本错误都会弹窗。四铁律见 [`registry/README.md`](registry/README.md) |

---

## 快速开始

```bash
npm install                          # 必须：自测里的注册表断言依赖 minecraft-data

cp config.example.json config.json   # 改成本机实际值（环境变量优先级更高）
# LLM 配置写进 .env（LLM_BASE_URL / LLM_API_KEY / MIND_MODEL …），不要提交

node bridge-server.js                # 手 + 眼 + 本能 → 127.0.0.1:3001
node mind.js                         # 意识           → 127.0.0.1:3003
```

- **必须先起 `bridge-server.js`**：它持有游戏连接，上层都通过 3001 端口驱动它。
- Windows 上用 `scripts/win/angel.ps1`（只托管 bridge 和 mind 两个进程）。
- **Forge / 模组服**：`config.json` 里 `MC_FORGE: "1"`。没有它，服务端会以
  *"This server has mods that require Forge to be installed on the client."* 拒绝原版协议客户端。
- **单人游戏**：ESC → 对局域网开放，把随机端口填到 `MC_PORT`。
- 连接成功后可以自检一下：
  ```bash
  curl --noproxy '*' http://127.0.0.1:3001/config    # 生效的配置（离线也可读）
  curl --noproxy '*' http://127.0.0.1:3001/status    # 连接状态
  curl --noproxy '*' http://127.0.0.1:3001/item      # 物品注册表注入报告
  ```

---

## 目录结构

代码按功能**分区放在 [`src/`](src/) 下**（第 2 步重构，2026-09-28；第 3–4 步把几个巨石
拆成子目录，2026-09-29；完整路由表见 [`AGENTS.md`](AGENTS.md) 第二节）；根目录只剩
`bridge-server.js` / `mind.js` 两个**一行转发的入口**（Windows 的 `scripts/win/angel.ps1`
起的就是它们）：

| 分区 | 文件（`src/` 下） |
|---|---|
| 共用 | `paths.js`（数据路径唯一来源）`log-stamp.js` `util/`（`env` `ids` `inventory` `time`） |
| ① 桥 / 协议 / 注册表（手+眼） | `bridge/server.js`（汇总）`bridge/{config,state,util,goto,connect,http,reconnect,body-command-lock}.js` `bridge/routes/{body,inspect,diag,palette,scan,gather,move,mine,pickup,place}.js` `body/hands.js`（汇总 → `index.js` + 8 个子文件）`body/{containers,craft,movement,mining,farming,kit,tool-choice,build,util}.js` `body/{commonsense,equip-policy,storage-policy,inventory-ledger,ftbq-sync}.js` `instinct/instinct.js`（汇总 + 8 个子文件）`world/fml-handshake.js` `world/registry-probe.js` `world/block-palette.js` `world/palette-registry.js` `world/item-registry.js` `world/entity-registry.js` |
| ② 寻路 / 放置 | `world/pathing.js`（转发壳 → `pathing/`）`world/pathing/{movements,doors,ladders,unknown-blocks,fluid,probe,collect,budget,selftest,index}.js` `world/place.js` `world/perception.js` |
| ③ 意识 / 人格 | `mind/mind.js`（汇总壳，161 行 → `mind/mind/`）`mind/mind/{state,prompt,runtime,scene,look,gates,tools,actions,think,selftest,wiring}.js` `mind/body.js` `mind/memory-store.js` `mind/speech.js` `mind/ambition.js` `mind/plan.js` `mind/night.js` `mind/self-review.js` `mind/llm-*.js` `mind/events-reader.js` + `PERSONA.md` |
| ④ 知识库 | `knowledge/knowledge.js` + `knowledge/`（配方、标签、掉落、任务书、矿表、作物表、通关主线，从包体自动提取） |
| ⑤ 运维 / 诊断 | `scripts/` `logs/` `memory/field-log.md`（实机问题台帐） |

**数据目录留在仓库根**（`memory/` `knowledge/` `registry/` `logs/` `config.json` `.env`），
代码里要拼这些路径一律走 `src/paths.js`。
其余目录：`registry/`（注册表快照、调色板、KubeJS dump）、`references/`（API 规格、Forge 握手、排错）。

> `src/mind/events-reader.js` 只读 `memory/events.jsonl`（旧脑干留下的决策留痕，历史证据）。
> 巨石拆分后的入口一律是**普通文件转发**（`hands.js` / `instinct.js` / `pathing.js` /
> `mind.js`），**不用符号链接** —— Windows 的 git 默认签出成纯文本，`require` 会炸。

---

## 自测

纯逻辑都抽成了可 require 的模块，**测的就是跑的那份代码**。每个模块 `node src/<区>/<文件>.js --selftest`，
完整命令清单见 [`AGENTS.md`](AGENTS.md) 第四节（断言数量会变，以实际输出为准）。
全套一起跑用 `npm test`（`scripts/test-all.js`）。

> ⚠️ **先把 `npm install` 跑完再测**：注册表相关断言依赖 `minecraft-data`，缺了会报错或静默少跑。
> ⚠️ **`src/bridge/server.js` 绝不能 `--selftest`**（根目录的 `bridge-server.js` 同理）：一 `require` 就去连服务器，只能 `node --check`。

---

## 四条最贵的经验

1. **模组服上 `block.type` 恒为 `undefined`** —— `prismarine-block/index.js:125` 的 else 分支
   不覆盖 `this.type`，而 1.13+ 的 `fromStateId` 传进来的就是 `undefined`。
   后果不止名字空：**梯子的两层判据都是 `block.type === ladderId`**，所以
   *调色板是梯子问题的前置条件，不是可选优化*。
2. **调色板必须写回注册表**，只当旁路查表等于没导。注入记录**故意不填 `boundingBox`**，
   `pathing.needsShapeFallback` 靠它判「我们没有权威碰撞箱」—— **这是契约，别填**。
3. **物品注册表是同一处病，但规则刻意与方块不同**（1.10.0）：物品 id 由快照**直接给定**，
   所以不需要前缀和、不需要 F3 锚点、**允许断点**，且注入失败**不踢线**。
   把它「顺手统一」成方块那套严格连续 + 踢线，会直接把 bot 搞掉线。详见
   [`SKILL.md` 的 *Item identity*](SKILL.md)。
4. **KubeJS 脚本四铁律**（`startupErrorGUI=true`，任何 startup 脚本错误 = 阻断式弹窗）：
   只用 `let` 绝不写 `const`（Rhino `doSetConstVar` 运行期抛 `msg.var.redecl`）/
   整个函数体进 `try` / 只用 `console.info` / 不调 `Java.loadClass`。

---

## 许可与隐私

- **MIT-0**（见 [`LICENSE`](LICENSE)）—— 上游 `minecraft-bridge` 同为 MIT-0。
- **仅限本地**：桥绑定 `127.0.0.1`，**不要**对外暴露。控制 API **无鉴权**，任何能连上
  3001 端口的进程都能驱动这个 bot。
- **`config.json` 不要提交** —— 含服务器地址与本机路径。已在 `.gitignore` 中排除，
  对外请用 `config.example.json`。
- **`/command` 转发任意斜杠命令**。如果 bot 在服务器上有 OP 权限，这包含破坏性操作。
- ⚠️ **`memory/journal.md` 以明文累积玩家聊天与相处记录**，已排除在仓库外。
  fork 后若要保留自己的版本，请自行评估。
- 同样已排除：`node_modules/`、`*.log`、`knowledge/_raw/`（中间产物，与顶层产物重复
  约 5.2 MB）、`.angleice-backup-*/`。

---

## 更多文档

| 文件 | 内容 |
|---|---|
| [`SKILL.md`](SKILL.md) | **完整技术手册**，比这份 README 深得多（方块/物品认知、输入层三层墙、调色板三道闸、寻路安全、本能机制） |
| [`registry/README.md`](registry/README.md) | 注册表快照 / 方块调色板 / 物品表 / KubeJS dump 全流程与四铁律 |
| [`PERSONA.md`](PERSONA.md) | 她的人格正文 —— 替她说话前必读 |
| [`references/`](references/) | API 规格（[`api-spec.md`](references/api-spec.md)，由 `scripts/gen-api-spec.js` 从路由快照自动生成）、Forge 握手说明、依赖指南、排错 |
| [`knowledge/`](knowledge/) | 整合包知识库（含 `lookup.py` 查询脚本） |
| [`AGENTS.md`](AGENTS.md) | **开发入口**：分区路由、自测、硬规矩、现状与待办 |
| [`memory/field-log.md`](memory/field-log.md) | 实机问题台帐（P1 起，带命令和真实输出） |
| `_meta.json` | 逐版本变更记录 |
