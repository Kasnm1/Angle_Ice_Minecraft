# angleice（Minecraft-AIcompanion）—— 项目入口

Minecraft 陪伴型 AI。游戏内 ID 固定 **`Angel_ICE`**，跑在 Forge 1.20.1 模组服（516 模组，离线认证）。
她不是工具，是**一起玩的人** —— 替她说话前必读 [`PERSONA.md`](PERSONA.md)。

> 本文件是**路由**：先看下面的「功能分区」找到你要动的那块，再读那块的专属说明。
> 深层细节不在这里重复，去 `SKILL.md` / `HANDOVER.md` / `memory/field-log.md` 查。

---

## 一、架构（四层，从下往上）

```
 mind.js      意识层  :3003  LLM 持续经历流 + 自写记忆 + 心愿      ← 当前的"人"
 (brain.js)   旧大脑  :3003  快脑/主脑双模型；已被 mind.js 取代，保留作参考
      │ HTTP
 autopilot.js 脑干    :3002  1.5s tick → decision.js 打分 → 执行；reflex.js 先跑
      │ HTTP
 bridge-server.js 手+眼 :3001  REST 包住 mineflayer；hands.js 挂在它上面
      │ mineflayer 4.39 + FML 握手
 Forge 1.20.1 服务器（地址在 config.json，不入库）
```

- **必须先起 `bridge-server.js`**，它持有游戏连接；上层都通过 3001 驱动它。
- **身体归谁**：`mind.js` 醒着就一直持有身体 —— 每 8s 续一次 `POST /autopilot/yield`（20s），并关掉脑干的罐头应答；
  脑干此时只跑反射（吃、浮），不做决策。`mind.js` 正常退出立即归还；崩了脑干 20s 后自动接回。脑干没起 `mind.js` 也能单独跑。
- `mind.js` 与 `brain.js` 共用 3003，只能起一个。

---

## 二、功能分区（路由表）

根目录的 `.js` 是扁平摆放的（`require('./x')` 相对路径互相引用，**不要为了"整齐"挪文件**）。
按功能分成 6 区，每区有一个专属 subagent（`.claude/agents/`）：

| 分区 | 文件 | 相关目录 | Subagent |
|---|---|---|---|
| **① 桥 / 协议 / 注册表**（手+眼） | `bridge-server.js` `hands.js` `fml-handshake.js` `registry-probe.js` `block-palette.js` `palette-registry.js` `item-registry.js` `reconnect.js` | [`registry/`](registry/) [`references/`](references/) | `mc-bridge` |
| **② 寻路 / 放置 / 站位**（几何） | `pathing.js` `place.js` | — | `mc-pathing` |
| **③ 脑干**（规则自主循环） | `autopilot.js` `decision.js` `reflex.js` `events.js` `journal.js` | — | `mc-autopilot` |
| **④ 意识 / 人格**（LLM 层） | `mind.js` `body.js` `memory-store.js` `speech.js` `ambition.js` `brain.js`(旧) `PERSONA.md` | [`memory/`](memory/) | `mc-mind` |
| **⑤ 知识库**（整合包真值） | `knowledge.js` | [`knowledge/`](knowledge/) | `mc-knowledge` |
| **⑥ 运维 / 诊断 / 台账** | `scripts/start.sh` `stop.sh` `probe-*.js` | [`scripts/`](scripts/) `logs/` [`memory/field-log.md`](memory/field-log.md) | 主会话自己做 |

依赖方向（改动时注意下游）：
```
bridge-server ← hands, pathing, place, decision, fml-handshake, registry-probe,
                block-palette, palette-registry, item-registry
autopilot     ← decision, reflex, events
mind          ← body, memory-store, knowledge, ambition      body ← knowledge, speech, memory-store
hands / ambition ← knowledge, memory-store
```
⚠️ `decision.js` 同时被 `bridge-server` 和 `autopilot` 引用 —— 改它要两边都测。

每个子目录有自己的 `AGENTS.md`（进入该目录工作时会自动加载）。

---

## 三、本机环境（macOS）

`node` **不在 PATH 上**。用 WorkBuddy 自带的：

```bash
NODE=/Users/starwish/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
```

- `node_modules/` 已在项目目录内，**不需要** `NODE_PATH`（`HANDOVER.md` 里的 `NODE_PATH` / `C:\...` 路径是 Windows 旧环境，已不适用）。
- 访问本地端口一律 `curl --noproxy '*'`（环境里可能有代理劫持 localhost）。
- 长驻进程（bridge / autopilot / mind）用后台方式起，日志写 `logs/`。
- LLM 配置在 `.env`（`LLM_BASE_URL` / `LLM_API_KEY` / `MIND_MODEL` / …）—— **不要打印、不要提交**。

---

## 四、自测（改完必须跑，全绿才算改对）

纯逻辑都能 `--selftest`，测的就是跑的那份代码。**只跑你改动所在分区的即可**，跨区改动全跑：

```bash
# ① 桥
$NODE item-registry.js --selftest;  $NODE block-palette.js --selftest
$NODE palette-registry.js --selftest; $NODE reconnect.js --selftest
$NODE scripts/fml-snapshot-test.js; $NODE scripts/palette-guard-test.js
$NODE scripts/angelpal-to-palette.js --selftest
$NODE --check bridge-server.js && $NODE --check hands.js   # ⚠️ 这两个没有 --selftest
# ② 寻路
$NODE pathing.js --selftest; $NODE place.js --selftest
# ③ 脑干
$NODE autopilot.js --selftest; $NODE decision.js --selftest; $NODE reflex.js --selftest
$NODE events.js --selftest; $NODE journal.js --selftest; $NODE scripts/jev-contract-test.js
# ④ 意识
$NODE mind.js --selftest; $NODE brain.js --selftest; $NODE memory-store.js --selftest
$NODE speech.js --selftest; $NODE ambition.js --selftest; $NODE --check body.js
# ⑤ 知识
$NODE knowledge.js --selftest
```

- ⚠️ **`bridge-server.js` 绝不能 `--selftest`**：一 `require` 就去连服务器、抢 3001 端口。只能 `--check`。
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

## 七、现状与待办（截至 2026-09-25）

| 项 | 状态 |
|---|---|
| **P48** 不会持续发育（缺工具链目标：采木→木镐→石→石镐/剑→打猎） | 方案 C 已批准，**未实现**（③ 区 `decision.js`） |
| **P50** `place.js` 的 `AIRY` 不含植物，站在草上被判"不在地面" | **未修**（② 区；先查清 `grass` 身份与 `lava` 在 AIRY 里的疑点）。判据已收拢到 `place.js` 一处，改那里即全局生效 |
| `README.md` / `SKILL.md` / `HANDOVER.md` | 滞后于代码（不含 ④ 区的 mind 体系） |

## 八、按需阅读

| 想知道 | 读 |
|---|---|
| 现状一页纸 | `STATUS.md` |
| 架构 / 本轮修复 / 环境坑 | `HANDOVER.md` |
| 某个具体问题的证据与根因（P1–P50） | `memory/field-log.md` |
| 技术手册（方块/物品认知、输入层、调色板、寻路、autopilot 机制） | `SKILL.md`（1500 行，按标题跳读） |
| HTTP 接口 | `references/api-spec.md` |
| 版本变更 | `_meta.json` |
