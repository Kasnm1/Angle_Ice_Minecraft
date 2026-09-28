# Angle_Ice_Minecraft —— 项目入口

> 仓库：<https://github.com/Kasnm1/Angle_Ice_Minecraft> · 本地目录名仍是 `angleice/`（旧名 Minecraft-AIcompanion / minecraft-bridge）

Minecraft 陪伴型 AI。游戏内 ID 固定 **`Angle_ICE`**，跑在 Forge 1.20.1 模组服（516 模组，离线认证）。
她不是工具，是**一起玩的人** —— 替她说话前必读 [`PERSONA.md`](PERSONA.md)。

> 本文件是**路由**：先看下面的「功能分区」找到你要动的那块，再读那块的专属说明。
> 深层细节不在这里重复，去 `SKILL.md` / `HANDOFF-20260928.md` / `memory/field-log.md` 查。

---

## 一、架构（三层，从下往上）

```
 mind.js      意识层  :3003  LLM 持续经历流 + 自写记忆 + 心愿      ← 当前的"人"
      │ HTTP
 bridge-server.js 手+眼+本能 :3001  REST 包住 mineflayer；hands.js 挂在它上面
      │ mineflayer 4.39 + FML 握手
 Forge 1.20.1 服务器（地址在 config.json，不入库）
```

> 根目录的 `bridge-server.js` / `mind.js` 是**一行转发的入口**（给 Windows 的
> `scripts/win/angel.ps1` 用），真正代码在 [`src/`](src/) 下：
> 意识在 `src/mind/`，桥在 `src/bridge/`。见 [`src/AGENTS.md`](src/AGENTS.md)。

- **必须先起 `bridge-server.js`**，它持有游戏连接；上层都通过 3001 驱动它。
- **身体归谁**：`mind.js` 醒着就持有身体 —— 它说话 / 做事时，本能让路。
  `mind.js` 没起时本能也能单独跑（本能就在 bridge 进程里，不走 HTTP）。
- **本能**（`src/instinct/instinct.js`，bridge 进程内，不走 HTTP）：身体空着时自己捡东西、收庄稼、
  挖看得见的矿、夜里在家睡、换护甲、危险方块退开；任何会动身体的 POST 一到就让出
  （路由里的 `yieldBody`）。
  **唯一反过来的是战斗本能**：怪冲她或玩家来时叫停正在跑的命令（`cancelCommands`），
  打的时候大部分命令回"在打架"。
- **旧脑干已于 2026-09-28 删除**（`autopilot.js` / `brain.js` / `decision.js` /
  `reflex.js` / `journal.js` / `events.js`）：那是"规则自主循环 + 快脑/主脑双模型"的
  上一版设计，已被 `mind.js`（意识）+ `src/instinct/instinct.js`（本能）取代。详见
  `docs/REFACTOR-PLAN-20260928.md`。原来的 `pickAutoEquip` 判据**没有被删**，
  原样搬到了 `equip-policy.js`。

---

## 二、功能分区（路由表）

第 2 步重构（2026-09-28）后，代码按功能**分区放在 [`src/`](src/) 下**；
数据目录（`memory/` `knowledge/` `registry/` `logs/`）与 `config.json` `.env` **留在根**，
路径一律走 [`src/paths.js`](src/paths.js)。根目录只留两个一行转发的入口。
按功能分成 5 区，每区有一个专属 subagent（`.claude/agents/`）：

| 分区 | 文件（`src/` 下） | 相关目录 | Subagent |
|---|---|---|---|
| **① 桥 / 协议 / 注册表**（手+眼） | `bridge/server.js` `bridge/body-command-lock.js` `bridge/reconnect.js` `body/hands.js` `body/commonsense.js` `body/equip-policy.js` `body/storage-policy.js` `body/inventory-ledger.js` `body/ftbq-sync.js` `instinct/instinct.js` `world/fml-handshake.js` `world/registry-probe.js` `world/block-palette.js` `world/palette-registry.js` `world/item-registry.js` `world/entity-registry.js` | [`registry/`](registry/) [`references/`](references/) | `mc-bridge` |
| **② 寻路 / 放置 / 站位**（几何） | `world/pathing.js` `world/place.js` | — | `mc-pathing` |
| **③ 意识 / 人格**（LLM 层） | `mind/mind.js` `mind/body.js` `mind/memory-store.js` `mind/speech.js` `mind/ambition.js` `mind/self-review.js` `mind/llm-codex.js` `mind/llm-workbuddy.js` `mind/night.js` `mind/plan.js` `mind/events-reader.js` `PERSONA.md` | [`memory/`](memory/) | `mc-mind` |
| **④ 知识库**（整合包真值） | `knowledge/knowledge.js` | [`knowledge/`](knowledge/) | `mc-knowledge` |
| **⑤ 运维 / 诊断 / 台账** | `scripts/start.sh` `stop.sh`（一次性诊断脚本在 `scripts/_attic/`） | [`scripts/`](scripts/) `logs/` [`memory/field-log.md`](memory/field-log.md) | 主会话自己做 |

共用（`src/` 根）：`paths.js`（数据路径唯一来源）、`log-stamp.js`（console 打墙钟时间）。

依赖方向（改动时注意下游）：
```
bridge ← body/{hands, commonsense, equip-policy, inventory-ledger, storage-policy, ftbq-sync},
         world/{pathing, place, fml-handshake, registry-probe, block-palette,
                palette-registry, item-registry, entity-registry},
         instinct/instinct, mind/night, knowledge/knowledge
mind   ← mind/{body, memory-store, speech, ambition, night, plan, self-review},
         knowledge/knowledge, body/inventory-ledger(只用 render), body/storage-policy
mind/body ← knowledge/knowledge, mind/{speech, memory-store}, body/storage-policy
hands / ambition ← knowledge/knowledge, mind/memory-store
instinct ← body/equip-policy（打怪前挑武器）
```
⚠️ `body/equip-policy.js` 同时被 `bridge/server.js`（`POST /equip` 的 auto 分支）和
`instinct/instinct.js`（`deps.pickAutoEquip`）引用 —— 改它要两边都测。

每个区有自己的 `AGENTS.md`（进入该目录工作时会自动加载）；`src/AGENTS.md` 是分区总览。

---

## 三、本机环境（macOS）

`node` **不在 PATH 上**。用 WorkBuddy 自带的：

```bash
NODE=/Users/starwish/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
```

- `node_modules/` 已在项目目录内，**不需要** `NODE_PATH`。
- 访问本地端口一律 `curl --noproxy '*'`（环境里可能有代理劫持 localhost）。
- 长驻进程（bridge / mind）用后台方式起，日志写 `logs/`。
- LLM 配置在 `.env`（`LLM_BASE_URL` / `LLM_API_KEY` / `MIND_MODEL` / …）—— **不要打印、不要提交**。
- 模型调用链（`body.js` 的 `llm()`）：**只用 susu 上的 `gemini-3.8-flash`（主）⇄ `deepseek-v4.1-flash`（备）**。
  本机命令行兜底默认关闭（`LOCAL_FALLBACKS` 默认空）；显式设 `LOCAL_FALLBACKS=codex,workbuddy` 才会启用：
  `llm-codex.js`（ChatGPT 账号，`CODEX_MODEL` 默认 gpt-6-luna、`CODEX_EFFORT` 默认 xhigh，实测 13–21s）→ `llm-workbuddy.js`（实测 8–10s）。

---

## 四、自测（改完必须跑，全绿才算改对）

纯逻辑都能 `--selftest`，测的就是跑的那份代码。**只跑你改动所在分区的即可**，跨区改动全跑：

```bash
# ① 桥
$NODE src/world/item-registry.js --selftest;  $NODE src/world/block-palette.js --selftest
$NODE src/world/entity-registry.js --selftest                         # 模组生物补名 + 仇恨判据
$NODE src/instinct/instinct.js --selftest; $NODE src/body/inventory-ledger.js --selftest   # 本能（拾取 / 让出身体）；物品账
$NODE src/body/commonsense.js --selftest; $NODE src/body/ftbq-sync.js --selftest      # 装水倒水锄地、钓鱼、动物、载具；任务书进度包（按反编译格式造包读回）
$NODE src/world/palette-registry.js --selftest; $NODE src/bridge/reconnect.js --selftest
$NODE src/body/equip-policy.js --selftest                            # 该换什么到手上来（空手 / 拿错东西）
$NODE src/mind/events-reader.js --selftest                           # 读 memory/events.jsonl（旧脑干留痕的历史证据）
$NODE scripts/fml-snapshot-test.js; $NODE scripts/palette-guard-test.js
$NODE scripts/angelpal-to-palette.js --selftest
$NODE scripts/angelpal-encoder-parity-test.js               # KubeJS 侧与 Node 侧的形状编码必须逐字节一致
$NODE src/body/hands.js --selftest                                  # 假 bot 驱动真实的 startFollow / go
$NODE --check src/bridge/server.js                             # ⚠️ 这个**只能 --check**
# ② 寻路
$NODE src/world/pathing.js --selftest; $NODE src/world/place.js --selftest
# ③ 意识
$NODE src/mind/mind.js --selftest; $NODE src/mind/memory-store.js --selftest
$NODE src/mind/night.js --selftest; $NODE src/mind/plan.js --selftest; $NODE src/mind/speech.js --selftest; $NODE src/mind/ambition.js --selftest; $NODE src/mind/self-review.js --selftest; $NODE --check src/mind/body.js
$NODE src/mind/llm-codex.js --selftest; $NODE src/mind/llm-workbuddy.js --selftest   # --live 会真调一次（花额度）
# ④ 知识
$NODE src/knowledge/knowledge.js --selftest
```

- 全套一起跑用 `npm test`（`scripts/test-all.js`）：自动发现 `src/` 下带 `--selftest` 的文件 +
  根目录两个入口与 `src/` 下无 selftest 的走 `--check` + `scripts/*-test.js` + 冒烟，
  汇总成一张表，已知失败单列且**不许新增**；另核对 `src/paths.js` 的数据路径都真实存在。
- 根目录入口也能跑：`node mind.js --selftest`（`bridge-server.js` 仍**只能** `--check`）。

- ⚠️ **`src/bridge/server.js` 绝不能 `--selftest`**：一 `require` 就去连服务器、抢 3001 端口。只能 `--check`。
- 自测红了，**先怀疑断言**（`check` 是严格相等，不能比对象）—— 项目里多次差点去改正确的代码。
- 断言数量会变，不要在文档里写死；以实际输出为准。

---

## 五、贯穿全项目的原则（代码注释里反复出现）

1. **"没有"和"读不到"必须分开报** —— 项目里一半的 bug 是这两个被混成了一句。
2. **返回值要回答"做得有多好"**，不只是"做了"（`mined` / `placed` / `moved` / `reach.maxDistance`）。
3. **不信"调用成功"，核对世界的真实变化**（P47：路由层曾无条件贴 `success:true`）。
   handler 返回 `ok: false`（严格布尔）才会被否决；`ok` 缺失 = 不否决。
4. **同一判据只许写一处**（`AIRY` / `DEADLY` / `isStandable` / `findStandY` 都只在 `place.js`，`bestFood` 只有一份）。
   自测也要测**跑的那份**，不许在自测里手抄一份实现来测。
5. **找不到证据时保守为 false，不猜。**
6. **先量再改** —— P45 第一判断"太慢"是错的，实测才找到"看不见"。

---

## 六、硬规矩

- **不入库**：`config.json`（服务器地址/账号）、`.env*`（LLM 密钥）、`memory/journal.md*`（玩家聊天明文）、`logs/`。
- `.gitignore` **绝不写 `*.json`** —— 会吃掉 `package.json` / `config.example.json` / `_meta.json` / `registry/block-palette.json` / `knowledge/*.json`。调试快照用 `.gitignore` 里列出的前缀命名（`m1.json` `sc.json` `_probe*.js` …）。
- `package.json` 的 `version` 与 `bridge-server.js` 的 `BRIDGE_VERSION` **必须一致**（当前 1.11.0）。
- 实机发现的问题记进 [`memory/field-log.md`](memory/field-log.md)（格式见 `memory/AGENTS.md`），**要有命令 + 真实输出**。
- 一次性诊断脚本用完归档到 `scripts/_attic/`，不要留在根目录。
- `KubeJS` 脚本四铁律（只用 `let` / 整体 `try` / 只 `console.info` / 不调 `Java.loadClass`）—— 见 `registry/AGENTS.md`。

---

## 七、现状与待办（截至 2026-09-28）

| 项 | 状态 |
|---|---|
| **重构第 1 步：删除旧脑干** | ✅ 已完成（2026-09-28，分支 `refactor/structure`）：`autopilot.js` `reflex.js` `journal.js` `brain.js` `decision.js` `events.js` 与 `HANDOVER.md` `STATUS.md` `skill-card.md` 已删（git 历史可查）；`pickAutoEquip` 原样搬到 `equip-policy.js`；`events.jsonl` 留只读的 `events-reader.js`。详见 `docs/REFACTOR-PLAN-20260928.md` |
| **重构第 2 步：代码挪进 `src/`** | ✅ 已完成（2026-09-28，分支 `refactor/structure`）：31 个根 `.js` 按区挪进 `src/`（只挪位置、只改 require/paths）；新增 [`src/paths.js`](src/paths.js) 作数据路径唯一来源；根目录剩 `bridge-server.js` / `mind.js` 两个一行转发入口（Windows 脚本不变）。`npm test` 41 通过 · 2 已知失败，各文件断言数与挪前一致；`check-moved` 897 函数一致、19 处仅路径行改动。见 [`src/AGENTS.md`](src/AGENTS.md) |
| **P48** 不会持续发育（缺工具链目标：采木→木镐→石→石镐/剑→打猎） | ✅ 由 `plan.js` 长期计划解决（部署只起 bridge + mind；不另写第二个声音）。实机未验 |
| **本能层**（`src/instinct/instinct.js`） | 战斗、拾取、收获、采矿、睡觉、换护甲、危险方块退开、**转头看人**（2026-09-29 改为"一次互动只看一眼 + 平滑转"：`CFG.gaze.selfTalkMs=0` 她自己说话不再转头、`lookPerWindow=1` 每窗一眼、`turnSteps=6` 不传 `force` 平滑转 —— 主人反馈"不要总突然看玩家"）、工具快坏提醒 **已写完、离线自测全绿，未上实机，未推送**（2026-09-27）。**走路类命令打架时要玩家标记**（2026-09-29）：`/go` `/move` `/follow` `/wear` 若不带 `urgent:'player'`，打架时会被 `yieldBody` 拒（防 mind 顺手走路叫停战斗），`/flee` `/self_rescue` `/stop{hold}` 不受限。战斗锚点：跟人时=人，自己干活时=开打位置，leash 12（主人 2026-09-27 确认）。另有随身物品/背包、开宝箱、洞穴、搭路、落地水、寻路挖天然地形、家范围自动扩大、指令本能。2026-09-27 晚又加：饿了就吃（饥饿 ≤16）、憋气上浮、中毒凋零（喝牛奶）、天气、玩家挨打提醒、家里暗处提醒 |
| **P50** / **P53** 站在草上被判"位置被占"；写死的名单认不出草方块和模组土石 | ✅ 已修（2026-09-27）：可替换方块按 `minecraft:replaceable` 标签；搭脚方块、天然地面、锄地按整合包标签。离线自测全绿，实机未验 |
| `README.md` / `SKILL.md` | README 已按架构更新（2026-09-27）；SKILL 顶部加了现状说明（底层部分仍准） |

## 八、按需阅读

| 想知道 | 读 |
|---|---|
| **最新交接：本能修复与实机调试（2026-09-28），没做完的清单** | [`HANDOFF-20260928.md`](HANDOFF-20260928.md) |
| **本能层 / 长期计划 / 物品账 / 天黑 的交接（2026-09-27），以及接下来的路线** | [`HANDOFF-20260927.md`](HANDOFF-20260927.md) |
| 重构计划（为什么要拆、各阶段、主人 2026-09-28 的决定） | [`docs/REFACTOR-PLAN-20260928.md`](docs/REFACTOR-PLAN-20260928.md) |
| 某个具体问题的证据与根因（P1–P50） | `memory/field-log.md` |
| 她玩的时候自己察觉 / 程序记下的不对劲（新问题的线索） | `node src/mind/self-review.js [--since 2h\|--all]` 或 `GET :3003/mind/review` |
| 技术手册（方块/物品认知、输入层、调色板、寻路、本能机制） | `SKILL.md`（按标题跳读） |
| HTTP 接口 | `references/api-spec.md` |
| 版本变更 | `_meta.json` |
