# Minecraft-AIcompanion

把任意 agent 接到**活着的 Minecraft Java 世界**上的本地 HTTP 桥 —— 支持 Forge/FML 模组服。
它同时是一个**有人格的陪玩**：游戏内 ID 固定 `Angel_ICE`，有自己的情绪、自己的记忆
（`memory/journal.md`），跨会话、跨 agent 都还是同一个人。

> 她不是工具。默认**闭嘴**：你不问，她就不讲。不主动科普、不指路、不报键位、
> 上线也不打招呼（身体可以主动 —— 转头、跟过来；嘴不行）。
> 只有四种情况开口：**被问 / 真实危险 / 她自己出事 / 你先搭话。**
> 人格正文见 [`PERSONA.md`](PERSONA.md)。

当前版本 **1.10.0** · 许可 **MIT-0** · 上游 `minecraft-bridge` 的本地分支

---

## 这是什么

三层，可以只用第一层：

| 层 | 文件 | 干什么 |
|---|---|---|
| **手 + 眼** | `bridge-server.js` | 在 `127.0.0.1:3001` 暴露一套 HTTP 接口：读状态（位置 / 背包 / 血量 / 方块 / 附近实体 / 聊天），做动作（走 / 挖 / 放 / 给 / 丢 / 跟随 / 攻击 / 说话 / 裸按键） |
| **脑干** | `autopilot.js` | 在 `127.0.0.1:3002` 跑自主循环 —— 感知 → 决策 → 行动，带长动作看门狗和**耳朵**（独立于 tick 的聊天监听） |
| **人** | `PERSONA.md` + `memory/` | 她有人格和持久记忆，跨会话、跨 agent 都还是同一个人 |

**不绑定任何 agent 运行时** —— 它就是个本地 HTTP 服务，谁都能驱动。
`bridge-server.js` **自己没有自主循环**，只起它的话她会站在原地：有手有眼，没有脑干。

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

node bridge-server.js                # 手 + 眼 → 127.0.0.1:3001
node autopilot.js                    # 脑干   → 127.0.0.1:3002
```

- **必须先起 `bridge-server.js`**：它持有游戏连接，`autopilot.js` 通过 3001 端口操作它。
  反过来的顺序会得到一个空转的脑干。
- 或者用脚本：`bash scripts/start.sh` / `bash scripts/stop.sh`（只托管 `bridge-server.js`）。
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

| 路径 | 作用 |
|---|---|
| `bridge-server.js` | **手 + 眼**。动作接口 + 状态读取。**没有自主循环** |
| `autopilot.js` | **脑干**。① 1.5s tick ② 看门狗 700ms ③ 耳朵 2s 听聊天。后两条独立于 tick |
| `decision.js` | 决策层。动态动作菜单 + 可插拔后端（`local`/`jev`/`auto`）+ 护栏 + 熔断 |
| `pathing.js` | 寻路策略。代价函数 + 建筑材质硬禁 + 注册表自检 + 可攀爬方块 |
| `place.js` | 放置几何。四个硬条件抽成纯函数 |
| `palette-registry.js` | 把**方块**调色板写回 prismarine 注册表 |
| `item-registry.js` | 把**物品**注册表写回 prismarine 注册表（1.10.0 新增） |
| `block-palette.js` | 调色板解析 / 归一化 / 三道导入闸 |
| `fml-handshake.js` | Forge 登录握手（含 `minecraft:block` / `minecraft:item` 快照解析） |
| `registry-probe.js` | 协议补丁。修原版 `declare_commands` 解析模组命令树导致的流错位 |
| `journal.js` | 记忆写入（`memory/journal.md`） |
| `reconnect.js` | 断线重连 |
| `events.js` | 决策留痕 `memory/events.jsonl` |
| `knowledge/` | 整合包知识库（任务书 / 物品中英对照 / 模组 / 提示），从包体自动提取 |
| `registry/` | 注册表快照、调色板、KubeJS dump 脚本与说明 |
| `references/` | API 规格、Forge 握手说明、依赖与排错 |
| `scripts/` | 工具与自测（一次性诊断脚本归档在 `scripts/_attic/`） |
| `memory/` | `journal.md`（她的记忆）+ `state.json`（运行时状态） |

---

## 自测

纯逻辑都抽成了可 require 的模块，**测的就是跑的那份代码**。

> ⚠️ **先把 `npm install` 跑完再测。** `pathing` 有 6 条、`block-palette` /
> `palette-registry` / `item-registry` 全部断言依赖 `minecraft-data`：没有 `node_modules`
> 时前三个直接 `MODULE_NOT_FOUND`，而 `pathing` 会**静默少跑 6 条**（报 `246/246`
> 而不是 `252/252` —— 看起来全绿，其实漏测）。

```bash
# 模块（10 个，共 627 条）
node decision.js         --selftest   #  37
node autopilot.js        --selftest   #  54
node events.js           --selftest   #  17
node place.js            --selftest   #  23
node pathing.js          --selftest   # 252
node block-palette.js    --selftest   #  51
node palette-registry.js --selftest   #  39
node item-registry.js    --selftest   #  54
node journal.js          --selftest   #  41
node reconnect.js        --selftest   #  59

# 脚本（4 个，共 105 条）
node scripts/fml-snapshot-test.js                # 19
node scripts/palette-guard-test.js               # 28
node scripts/jev-contract-test.js                # 34
node scripts/angelpal-to-palette.js --selftest   # 24
```

合计 **732 条断言**。全绿才算改对了。

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
| [`SKILL.md`](SKILL.md) | **完整技术手册**，比这份 README 深得多（方块/物品认知、输入层三层墙、调色板三道闸、寻路安全、autopilot 全部机制） |
| [`registry/README.md`](registry/README.md) | 注册表快照 / 方块调色板 / 物品表 / KubeJS dump 全流程与四铁律 |
| [`PERSONA.md`](PERSONA.md) | 她的人格正文 —— 替她说话前必读 |
| [`references/`](references/) | API 规格、Forge 握手说明、依赖指南、排错 |
| [`knowledge/`](knowledge/) | 整合包知识库（含 `lookup.py` 查询脚本） |
| `_meta.json` | 逐版本变更记录（1.2.0 → 1.10.0） |
