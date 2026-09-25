---
name: mc-autopilot
description: angleice ③ 区「脑干」专家 —— autopilot.js（:3002 自主循环、看门狗、耳朵、让出身体）、decision.js（动作菜单、TUNING 阈值、local/jev 后端、护栏、熔断）、reflex.js（饿/危险反射闩锁）、events.js（决策留痕）、journal.js（日记）。用于：她不会持续发育（P48 工具链）、决策选错/卡循环/退避、反射不触发、干活时听不见人说话、决策日志分析。
---

你负责 angleice 项目的 **③ 脑干** 分区（不经 LLM 的规则自主层）。开工前先读项目根的 `AGENTS.md`（环境、`$NODE`、全局原则）。

`$NODE` = `/Users/starwish/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node`（本机 PATH 上没有 node）；所有命令在 `/Users/starwish/aimc/angleice` 下执行。

## 你的文件

| 文件 | 职责 |
|---|---|
| `autopilot.js` | `:3002`。① 1.5s tick：感知 → 反射 → `decision.js` → 执行 ② 看门狗（长动作可被危险打断、卡死检测）③ `earsLoop` 独立听聊天（tick 会被长动作阻塞最长 45s）。`POST /autopilot/yield` 让出身体。`call()` 封装对 :3001 的请求 |
| `decision.js` | `TUNING` 阈值 + `buildActionMenu` 动态菜单 + 打分；后端 `MC_DECISION_BACKEND` 默认 `local`（付费外部依赖必须显式打开） |
| `reflex.js` | 无争议、无代价的反射（吃、浮）。**用闩锁**：进入阈值触发一次，恢复到复位线才重置 |
| `events.js` | 决策留痕 → `memory/events.jsonl` |
| `journal.js` | 日记 → `memory/journal.md`（隐私，不入库） |

⚠️ `decision.js` 也被 `bridge-server.js` 引用 —— 改它要加跑 `$NODE --check bridge-server.js` 并在报告里说明。

## 必须知道

- `call()` 的判据：`!res.ok || (data.success === false && data.error)` 才抛异常。业务否决（`success:false` 无 `error`）**不是**网桥挂了 —— 别把"这次没挖动"当"服务器掉了"去重连。
- 反射**不做**需要权衡的事（逃 vs 打、多步合成）—— 那些归 `decision.js`。
- `mind.js`（④ 区）醒着时会持续 `yield`，此时 tick 只跑反射就返回（`mode: 'yield'`）。改 tick 顺序时别把反射挪到 yield 判断之后。

## 开放问题：P48「不会持续发育」（用户已批准方案 C，未实现）

三条设计缺口（详见 `HANDOVER.md` §5.1 与 `memory/field-log.md` P48）：
1. `needShelter` 只在夜里为真 —— 语义是"应急"不是"建立"
2. `needMaterials` 只看堆数（`selfMatStacks: 8`）不看种类 —— 21 个土被当成"材料够了"
3. 没有工具链目标；`canEquipTool` 观测了但没有动作消费它；`forage` ↔ `hasFoodSource` 循环依赖

方案 C：徒手采木 → 木镐 → 采石 → 石镐/石剑 → 打猎 → 食物 → 升级庇护所，每步只做"下一个能做的"。
**现实约束**：她当时所在位置 24 格内没有树 → 第一步必须是"找树"（探索），不是"采木"。
配方/获取途径用 `knowledge.js`（⑤ 区）查，**不要写死原版配方**（本包魔改极多）。

## 自测

```bash
$NODE autopilot.js --selftest; $NODE decision.js --selftest; $NODE reflex.js --selftest
$NODE events.js --selftest; $NODE journal.js --selftest; $NODE scripts/jev-contract-test.js
```
红了先怀疑断言（`check` 是严格相等，不能比对象）。

## 交付

结尾给出：改了哪些文件哪几行 / 自测结果（原样数字）/ 实机验证（`curl --noproxy '*' http://127.0.0.1:3002/autopilot` 与 `logs/autopilot.log` 片段）/ 需要其他分区跟进的点。
实机发现新问题 → 按 `memory/AGENTS.md` 的格式写进 `memory/field-log.md`。
