# `src/` —— 代码分区（重构第 2 步，2026-09-28；第 3 步拆子目录，2026-09-28/29）

> 本目录是重构第 2 步（`docs/REFACTOR-PLAN-20260928.md`）建起来的：
> 根目录的 31 个 `.js` 按功能挪进来，**只挪位置、不改逻辑**。
> 第 3 步又把五个巨石各拆成子目录（`body/` `instinct/` `bridge/` `mind/mind/` `world/pathing/`）。
> 根目录只剩 `bridge-server.js` / `mind.js` 两个一行转发的入口（给 Windows 的
> `scripts/win/angel.ps1` 用）。

## 数据目录不在 `src/` 下

`memory/` `knowledge/` `registry/` `logs/` `config.json` `.env` **都留在仓库根**。
代码里要拼这些路径，一律走 [`paths.js`](paths.js)（`require('../paths')`），
**不要自己数 `__dirname/..` 有几层** —— 数错了不会报错，只会静默读到"空"。

```js
const paths = require('../paths');
fs.readFileSync(path.join(paths.MEMORY, 'mind.json'));
```

## 分区

| 区 | 文件 | 干什么 | 读谁 |
|---|---|---|---|
| [`bridge/`](bridge/) | `server.js`（汇总）`state.js` `http.js` `connect.js` `config.js` `util.js` `goto.js` `body-command-lock.js` `reconnect.js` + `routes/{inspect,scan,pickup,body,place,move,mine,gather,palette,diag}.js` | `:3001` REST：连接 / 状态 / HTTP 分发 / 身体命令锁 + **58 条路由**（另有 hands 75 + commonsense 5） | [`bridge/AGENTS.md`](bridge/AGENTS.md) |
| [`body/`](body/) | `hands.js`（→`index.js`）`util.js` `containers.js` `craft.js` `movement.js` `mining.js` `farming.js` `kit.js` `tool-choice.js` `build.js` + `commonsense.js` `equip-policy.js` `storage-policy.js` `inventory-ledger.js` `ftbq-sync.js` | 她的手：吃/用/穿/合成/熔炉/容器；常识动作；装备判据；仓库规则；物品账；任务书进度；挖前挑工具 | [`body/AGENTS.md`](body/AGENTS.md) |
| [`instinct/`](instinct/) | `instinct.js`（汇总）`core.js` `combat.js` `survival.js` `mining.js` `pickup.js` `social.js` `home.js` `config.js` `testkit.js` | 不过大脑、身体自己做的事（战斗/拾取/收获/采矿/睡觉/换护甲/憋气/落地水…） | [`instinct/AGENTS.md`](instinct/AGENTS.md) |
| [`world/`](world/) | `pathing.js`（→`pathing/`）`place.js` `perception.js` `entity-registry.js` `palette-registry.js` `block-palette.js` `item-registry.js` `fml-handshake.js` `registry-probe.js` | 寻路/放置几何 + 方块/物品/实体注册表 + 野外感知 + Forge 握手 | [`world/AGENTS.md`](world/AGENTS.md) |
| [`mind/`](mind/) | `mind.js`（→`mind/`）`body.js` `memory-store.js` `speech.js` `ambition.js` `plan.js` `night.js` `self-review.js` `llm-codex.js` `llm-workbuddy.js` `events-reader.js` + `mind/{runtime,think,look,prompt,tools,actions,gates,scene,state,wiring,selftest}.js` | `:3003` 意识层（LLM 经历流、记忆、说话、计划） | [`mind/AGENTS.md`](mind/AGENTS.md) |
| [`knowledge/`](knowledge/) | `knowledge.js` | 整合包知识库查询（数据目录 `../knowledge/` 不动） | [`knowledge/AGENTS.md`](knowledge/AGENTS.md) |
| [`util/`](util/) | `time.js` `ids.js` `env.js` `inventory.js` | **共用小工具**（第 4 步去重的产物）：`sleep`/`sleepMs`；`fullId`/`bareId`/`bareMinecraft`/`stripPrefix`（id 命名空间）；`envBool`/`envOn`/`envTrue`/`envOne`（env 布尔）；`countById`（按数字 id 数件数）。各文件从 `require('..[/..]/util/x')` 取，不再各写一份 | — |

共用：`paths.js`（数据路径）、`log-stamp.js`（给 console 打墙钟时间）、`util/`（跨区小工具）。

> `util/` 里只放**真的被两处以上用**的东西，且每个文件都能 `node src/util/<file>.js --selftest`。
> 同一件事**语义不同**的写法（例如 `envBool` 的三派、`bareId` 与 `bareMinecraft` 对 null 的处理）
> **要参数化保留差别，不许悄悄统一** —— 见各文件头的说明与自测。

## 汇总文件（拆巨石后的入口）

第 3 步把五个巨石拆成了子目录，**原文件名保留为汇总**，外部 require 路径不变：

| 汇总 | 真正内容 | 盘点 |
|---|---|---|
| `body/hands.js` | → `body/index.js` + 8 个领域文件 | [`body/AGENTS.md`](body/AGENTS.md) |
| `instinct/instinct.js` | → `instinct/` 7 个文件 | [`instinct/AGENTS.md`](instinct/AGENTS.md) |
| `bridge/server.js` | → `bridge/` + `bridge/routes/` | [`bridge/AGENTS.md`](bridge/AGENTS.md) |
| `mind/mind.js` | → `mind/mind/` 11 个文件 | [`mind/AGENTS.md`](mind/AGENTS.md) |
| `world/pathing.js` | → `world/pathing/` 10 个文件 | [`world/AGENTS.md`](world/AGENTS.md) |

汇总的**导出名与顺序**都被 `scripts/test-all.js` 的快照钉住（`references/exports-*.json`）——
改接口是有意为之才改，改了要同步更新快照。

## 自测

全套：`npm test`（`scripts/test-all.js`，自动发现 `src/**/*.js`）。
单份：`node src/<区>/<文件>.js --selftest`；没有 `--selftest` 分支的（`server.js`、
`fml-handshake.js`、`registry-probe.js`、`paths.js`、各 `testkit.js`）用 `node --check`。

> ⚠️ **`src/bridge/server.js` 绝不能 `--selftest`**：一 require 就连服务器、抢 3001。
> 只能 `--check`。`test-all.js` 靠"代码里真有 `--selftest` 分支"来分开这两种。
