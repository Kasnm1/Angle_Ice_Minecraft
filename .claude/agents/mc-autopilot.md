---
name: mc-autopilot
description: 【已废弃 2026-09-28】angleice ③ 区「脑干」专家 —— 该分区及其全部文件（autopilot.js、decision.js、reflex.js、events.js、journal.js）已于 2026-09-28 删除。此 subagent 不再有可负责的文件，请勿使用；改用 mc-bridge（① 本能/bridge）或 mc-mind（③ 意识/人格）。
---

> ⚠️ **这个 subagent 已于 2026-09-28 废弃。** 它负责的 **③ 脑干** 分区整体删除了：
> `autopilot.js` `decision.js` `reflex.js` `events.js` `journal.js` `brain.js`。
> 见 `docs/REFACTOR-PLAN-20260928.md`（第 1 步）。
>
> **不要再用它。** 原本会派到这里的活现在归：
>
> | 原来的活 | 现在找谁 |
> |---|---|
> | 自主行动、拾取 / 采矿 / 战斗 / 睡觉等反射 | `mc-bridge`（① 区，看 `src/instinct/instinct.js` —— 本能在 bridge 进程内，不走 HTTP） |
> | 决策、该做什么、长期计划、说话 | `mc-mind`（③ 区，看 `src/mind/mind.js` / `src/mind/plan.js` / `src/mind/body.js`） |
> | 活干到一半被打断、退避、重试上限 | `mc-bridge`（原 `autopilot` 的看门狗与重试上限没有搬过来，是**有意**删的；现在的防护在 bridge 和本能里） |
> | 决策留痕分析（`memory/events.jsonl`） | 没有对应 subagent —— 用 `node src/mind/events-reader.js --tail 30` 离线读，**文件已冻结不再新增** |
>
> 仍然存活、且原属这个分区的两个模块：
>
> - `src/body/equip-policy.js` —— `pickAutoEquip`（"该换成什么"，原样搬出），归 `mc-bridge`
> - `scripts/jev-contract-test.js`（Jev 集成契约测试）**已删**；如果以后重新接 Jev 那类
>   决策后端，先看 `SKILL.md` 的 "The Jev endpoint" 一节（契约与坑都记在那里）
>
> 下面的原文保留**仅作历史**，描述的文件都不存在了。

---

## 原文（历史，勿按此执行）

`$NODE` = `/Users/starwish/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node`（本机 PATH 上没有 node）；所有命令在 `/Users/starwish/aimc/angleice` 下执行。

### 文件

| 文件 | 职责 |
|---|---|
| `autopilot.js` | `:3002`。① 1.5s tick：感知 → 反射 → `decision.js` → 执行 ② 看门狗（长动作可被危险打断、卡死检测）③ `earsLoop` 独立听聊天（tick 会被长动作阻塞最长 45s）。`POST /autopilot/yield` 让出身体。`call()` 封装对 :3001 的请求 |
| `decision.js` | `TUNING` 阈值 + `buildActionMenu` 动态菜单 + 打分；后端 `MC_DECISION_BACKEND` 默认 `local`（付费外部依赖必须显式打开） |
| `reflex.js` | 无争议、无代价的反射（吃、浮）。**用闩锁**：进入阈值触发一次，恢复到复位线才重置 |
| `events.js` | 决策留痕 → `memory/events.jsonl` |
| `journal.js` | 日记 → `memory/journal.md`（隐私，不入库） |

### 教训（这些还成立，值得继承）

- 业务否决（`success:false` 无 `error`）**不是**网桥挂了 —— 别把"这次没挖动"当"服务器掉了"去重连。
- 反射**不做**需要权衡的事（逃 vs 打、多步合成）—— 那些归决策层。
- 平行跑的东西只在"把 I/O 等待挪出时间敏感路径"时才正当（看门狗、耳朵都是这个理由）。
- **测试通过 ≠ 行为正确**：`decision.js` 的 shelter 断言曾经把死循环锁进回归集。
