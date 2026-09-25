# Angle_Ice_Minecraft

**一个住在 Minecraft 模组服里的 AI 玩伴。** 游戏内 ID 固定 `Angel_ICE`。

她不是指令机器人，也不是攻略助手 —— 她是**一起玩的人**：会记得你是谁、答应过你什么、
上次被苦力怕炸了学到什么；闲下来有自己想做的事；你不问，她就不讲。

- 跑在 **Forge 1.20.1** 整合包服务器上（实测 516 个模组、离线认证），也能连原版 / 单人局域网
- 纯本地：Node.js + [mineflayer](https://github.com/PrismarineJS/mineflayer)，没有客户端模组，不改服务器
- 意识层接任意 **OpenAI 兼容**的 LLM 接口；不接 LLM 时，规则脑干也能让她独自生存

当前版本 **1.11.0** · 许可 **MIT-0** · 起源于 `minecraft-bridge` 的本地分支

> **她的说话纪律**（人格正文见 [`PERSONA.md`](PERSONA.md)）
> 默认闭嘴：不主动科普、不指路、不报键位，上线也不打招呼 —— 身体可以主动（转头、跟过来），嘴不行。
> 只有四种情况开口：**被问 / 真实危险 / 她自己出事 / 你先搭话。**
> 说话像真玩家打字：几条短句，而不是一段话。

---

## 她能做什么

| 方面 | 具体 |
|---|---|
| **听懂人话、马上反应** | 聊天进她的「经历流」，想完就说、就做；「停」「跟我来」走本能通道，不等模型 |
| **记得人和事** | 对每个玩家有自己的印象、好感、信任；教训、承诺、打算、发现都是**她自己写**的，会强化、会淡忘、会改错 |
| **睡觉整理** | 上下文快满时，她自己挑要记住的写下来、写日记、检查旧教训有没有过时 |
| **懂这个整合包** | 配方 / 获取途径 / 用途 / 工作站 / 材料树全部从整合包本体抽取（含 KubeJS 改动），**不按原版攻略答** |
| **有自己的心愿** | 做遍整合包任务书《食录逸闻》里的食物 —— 闲下来会挑一道菜，研究原料、去采、去种、去做 |
| **真的动手** | 走、挖、放、合成（按整合包真实配方）、熔炉 / 烟熏炉、开箱子、吃、穿戴（含模组装备 / 饰品）、打猎、跟随 |
| **自己活下去** | 饿了吃、溺水上浮、卡住自救、危险时打断长动作；寻路不拆玩家的房子 |
| **不说谎** | 每个动作都核对世界的真实变化，报告「做得有多好」而不只是「做了」 |

---

## 架构：四层

```
 mind.js       意识层  :3003   LLM 持续经历流 + 自写记忆 + 心愿        ← 现在的「她」
      │ HTTP
 autopilot.js  脑干    :3002   1.5s tick → 反射（reflex.js）→ 决策（decision.js）→ 执行
      │ HTTP
 bridge-server.js 手+眼 :3001  REST 包住 mineflayer；hands.js 挂在它上面
      │ mineflayer 4.39 + Forge FML 登录握手
 Minecraft 服务器（Forge 1.20.1 / 原版）
```

- **手 + 眼**（`bridge-server.js`）只提供能力，**自己没有自主循环** —— 只起它，她会站在原地。
  它**不绑定任何 agent 运行时**：本地 HTTP 服务，谁都能驱动。
- **脑干**（`autopilot.js`）是规则驱动的生存循环，不需要 LLM，能单独跑。
- **意识**（`mind.js`）醒着时持有身体：每 8s 向脑干续一次让出（20s），脑干此时只跑反射（吃、浮）。
  `mind.js` 正常退出立即归还；崩了，脑干 20s 后自动接回。
- `brain.js` 是上一代快脑 / 主脑双模型大脑，已被 `mind.js` 取代，保留作参考（两者共用 3003，只能起一个）。

---

## 快速开始

需要 Node.js 18+（开发环境用 22）。

```bash
npm install                          # 必须：自测里的注册表断言依赖 minecraft-data

cp config.example.json config.json   # 填服务器地址 / 端口 / 版本（环境变量优先级更高）
```

**1. 只要手 + 眼 + 脑干（不需要 LLM）**

```bash
node bridge-server.js                # 手 + 眼 → 127.0.0.1:3001（必须最先起：它持有游戏连接）
node autopilot.js                    # 脑干   → 127.0.0.1:3002
```

`bridge-server.js` 也可以用 `bash scripts/start.sh` / `bash scripts/stop.sh` 托管。

**2. 加上意识层**

在项目根目录建 `.env`（已被 `.gitignore` 排除，**不要提交**）：

```ini
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_API_KEY=...
MIND_MODEL=...                       # 她用来思考的模型
# 可选：LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY / MIND_FALLBACK  备用线路
# 可选：MIND_IDLE_MS（多久没事就自己想想，默认 90000）/ MIND_MAX_CHARS（经历流多长就睡觉整理）
```

```bash
node mind.js                         # 意识 → 127.0.0.1:3003
node mind.js --sim "安琪你好" "给你7个鸡蛋"   # 假身体 + 真模型，不进游戏也能和她对话
```

**连接说明**

- **Forge / 模组服**：`config.json` 里设 `"MC_FORGE": "1"`。否则服务端会以
  *"This server has mods that require Forge to be installed on the client."* 拒绝连接。
- **单人游戏**：ESC → 对局域网开放，把随机端口填到 `MC_PORT`。
- 起来之后自检（本机有代理时加 `--noproxy '*'`）：
  ```bash
  curl --noproxy '*' http://127.0.0.1:3001/status    # 连接状态、血量、饥饿、氧气
  curl --noproxy '*' http://127.0.0.1:3001/item      # 模组物品注册表注入报告
  curl --noproxy '*' http://127.0.0.1:3001/plugins   # 可选插件装了哪些
  curl --noproxy '*' http://127.0.0.1:3003/mind      # 她此刻在想什么、记得什么
  ```

完整 HTTP 接口见 [`references/api-spec.md`](references/api-spec.md)。

---

## 目录结构

根目录的 `.js` 是扁平摆放的（相对路径互相 `require`），按功能分成六区：

| 分区 | 文件 | 干什么 |
|---|---|---|
| **① 手 + 眼** | `bridge-server.js` `hands.js` | REST 接口：读状态 / 背包 / 方块 / 实体 / 聊天；走、挖、放、合成、熔炉、容器、吃、穿戴 |
| | `fml-handshake.js` `registry-probe.js` `reconnect.js` | Forge 登录握手（含注册表快照解析）、模组命令树协议补丁、断线重连 |
| | `block-palette.js` `palette-registry.js` `item-registry.js` | 把模组的**方块**与**物品**注册表写回 prismarine，让她叫得出模组东西的名字 |
| **② 几何** | `pathing.js` `place.js` | 寻路代价 + 建筑材质硬禁 + 挖掘引水防护 + 可攀爬方块；放置与站位判据（全项目只此一处） |
| **③ 脑干** | `autopilot.js` `decision.js` `reflex.js` `events.js` `journal.js` | 自主循环 + 看门狗 + 独立的聊天「耳朵」；动作菜单与护栏；饿 / 溺水反射；决策留痕；日记 |
| **④ 意识** | `mind.js` `body.js` `memory-store.js` `speech.js` `ambition.js` | 经历流与睡觉整理；工具与模型调用；她自写的记忆；分条发言；做遍食物的心愿 |
| | `PERSONA.md` · `brain.js`（旧） | 人格正文 · 上一代双脑 |
| **⑤ 知识库** | `knowledge.js` · [`knowledge/`](knowledge/) | 整合包真值：配方 / 获取 / 用途 / 材料树 / 任务书 / 中英名 / 物品提示 |
| **⑥ 运维** | [`scripts/`](scripts/) | 启停脚本、诊断工具、契约测试（一次性脚本归档在 `scripts/_attic/`） |
| | [`registry/`](registry/) · [`references/`](references/) · [`memory/`](memory/) | 注册表快照与 KubeJS dump · API 规格与排错 · 实机问题台账 `field-log.md` |

每个子目录有自己的 `AGENTS.md`；给 AI 编码助手的项目入口是 [`AGENTS.md`](AGENTS.md)。

---

## 自测

纯逻辑都抽成了可 `require` 的模块，**测的就是跑的那份代码**。先 `npm install` 再测 ——
缺 `minecraft-data` 时注册表相关模块会直接报错，`pathing` 更会**静默少跑几条**（看起来全绿，其实漏测）。

```bash
# ① 桥
node item-registry.js --selftest;  node block-palette.js --selftest
node palette-registry.js --selftest; node reconnect.js --selftest
node scripts/fml-snapshot-test.js; node scripts/palette-guard-test.js
node scripts/angelpal-to-palette.js --selftest
node --check bridge-server.js && node --check hands.js
# ② 几何
node pathing.js --selftest; node place.js --selftest
# ③ 脑干
node autopilot.js --selftest; node decision.js --selftest; node reflex.js --selftest
node events.js --selftest; node journal.js --selftest; node scripts/jev-contract-test.js
# ④ 意识
node mind.js --selftest; node brain.js --selftest; node memory-store.js --selftest
node speech.js --selftest; node ambition.js --selftest; node --check body.js
# ⑤ 知识
node knowledge.js --selftest
```

> ⚠️ **`bridge-server.js` 绝不能 `--selftest`**：一 `require` 就会去连服务器、抢 3001 端口，只能 `--check`。

全绿才算改对。断言数量随版本变化，以实际输出为准。

---

## 为什么值得一看

这个项目大半时间花在「为什么读不到 / 走不动 / 说不出来」上。结论都钉进了代码注释、
[`SKILL.md`](SKILL.md) 和 [`memory/field-log.md`](memory/field-log.md)，这里是最不显然的几条：

| 症状 | 真因 |
|---|---|
| 模组服上方块名全错、甚至物理上不可能 | `prismarine-block/index.js:125` 的 else 分支**不覆盖 `this.type`**，1.13+ 的 `fromStateId` 传进来就是 `undefined`。**调色板必须写回注册表**，只当旁路查表等于没导 |
| 模组物品说不出名字，连带 `/drop` `/collect` `/equip` `/craft` `/place` 失效 | 同一处病在 `prismarine-item/index.js:36`。但物品注入的规则**刻意与方块不同**：id 由快照直接给定、允许断点、失败不踢线 —— 「顺手统一」会把 bot 搞掉线 |
| 爬不上梯子 | 物理层写死原版梯子 id，而模组服上 `block.type` 恒为 `undefined` —— 调色板是梯子问题的**前置条件** |
| 她会拆玩家的房子 | 默认参数下「拆一格泥土」比「绕一步路」还便宜。`canDig=false` 反而让 `No path` 变多；正解是抬高 `digCost` + 按名字硬禁建筑材质 |
| 她挖着挖着把自己淹了 | 挖掘代价里没有「这一格挖开会不会引水」—— 现在按六邻域加正上方 32 格判断 |
| 她干活时听不见你说话 | 聊天在 tick 开头读，而 tick 会被长动作阻塞最长 45s → 「耳朵」必须是独立回路 |
| 报「成功」但世界纹丝未动 | 路由层曾无条件贴 `success: true`（同型根因出现四次）。现在所有动作核对前后状态再报 |
| 她说话一股「AI 味」 | 用词没问题，是**形态**：真玩家平均 12.6 字 / 条，她 43.8 字 / 条。发送层按标点拆成短句，只拆不改字 |
| KubeJS 诊断脚本弹出阻断窗口 | `startupErrorGUI=true`。四铁律：只用 `let` / 整个函数体进 `try` / 只用 `console.info` / 不调 `Java.loadClass` |

---

## 现状

地基已稳（能动、能看见、不说谎、会说人话、记得人）。正在做的：

- **持续发育**（P48）：缺「采木 → 木镐 → 石头 → 石镐 / 剑 → 打猎」的工具链目标，方案已定、未实现
- **站在草上被判「不在地面」**（P50）：`place.js` 的 `AIRY` 判据未含植物，待修
- `SKILL.md` / `HANDOVER.md` 尚未覆盖意识层

一页纸现状见 [`STATUS.md`](STATUS.md)。

---

## 许可与隐私

- **MIT-0**（见 [`LICENSE`](LICENSE)）—— 上游 `minecraft-bridge` 同为 MIT-0。
- **仅限本机**：各服务绑定 `127.0.0.1`，**不要对外暴露**。控制 API **无鉴权**，任何能连上端口的进程都能驱动她。
- **`/command` 转发任意斜杠命令** —— 如果 bot 在服务器上有 OP 权限，这包含破坏性操作。
- **不入库**（已在 `.gitignore`）：
  - `config.json`（服务器地址、本机路径）—— 对外用 `config.example.json`
  - `.env*`（LLM 密钥）
  - `memory/journal.md*`、`memory/mind.json*` —— **以明文保存玩家聊天、她对每个玩家的印象与承诺**，fork 后请自行评估
  - `registry/minecraft-block.json` / `minecraft-item.json`（登录时自动重建，含服务器地址）
  - `knowledge/generated/`（20 MB+，可用 `knowledge/_tools` 从整合包重新生成）、`node_modules/`、`logs/`

---

## 更多文档

| 文件 | 内容 |
|---|---|
| [`PERSONA.md`](PERSONA.md) | 她的人格正文 —— 替她说话前必读 |
| [`STATUS.md`](STATUS.md) | 现状一页纸 |
| [`SKILL.md`](SKILL.md) | 完整技术手册：方块 / 物品认知、输入层、调色板三道闸、寻路安全、autopilot 机制 |
| [`HANDOVER.md`](HANDOVER.md) | 架构、修复记录、环境坑 |
| [`memory/field-log.md`](memory/field-log.md) | 实机问题台账（P1–P50），每条带命令与真实输出 |
| [`references/`](references/) | HTTP API 规格、Forge 握手说明、依赖指南、排错 |
| [`registry/README.md`](registry/README.md) | 注册表快照 / 方块调色板 / 物品表 / KubeJS dump 全流程 |
| [`knowledge/`](knowledge/) | 整合包知识库（含 `lookup.py` 命令行查询） |
| `_meta.json` | 逐版本变更记录 |
