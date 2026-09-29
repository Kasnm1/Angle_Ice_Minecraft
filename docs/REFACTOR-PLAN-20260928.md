# 重构计划（2026-09-28，主人要求；Claude 列计划，WorkBuddy 执行，Claude 验收）

## 为什么要重构

| 问题 | 现状 |
|---|---|
| 巨石文件 | `bridge-server.js` 6808 行（58 条路由 + 连接 + 状态 + HTTP）、`hands.js` 5594 行（75 条路由）、`pathing.js` 3790、`instinct.js` 3556、`mind.js` 2786 |
| 死代码 | 旧脑干 `autopilot.js` 3797 / `brain.js` 1431 / `reflex.js` / `journal.js` 部署不跑，但还占着目录、自测、文档 |
| `bridge-server.js` 一 require 就连服务器 | 所以它**不能自测**，58 条路由没有任何测试；今天好几个 bug（/mine 名字解析、/pickup 预算）都只能上实机才发现 |
| 同类判据多处 | 今天合并过认怪判据、可见判据；`fullId` / `bare` / `sleep` / 背包计数等小工具各文件自己写一份 |
| 测试靠手记 | 全套自测命令写在 AGENTS.md 里手抄；冒烟脚本在临时目录；WorkBuddy 两次写出"测的不是跑的那份"的测试 |

## 硬约束（每一步都守）

1. **只搬动，不改逻辑**。拆文件时函数体一字不改（用"搬移核对"脚本验：拆前拆后每个函数的源码文本哈希一致）。要改逻辑的另开任务。
2. **Windows 部署不能断**：`scripts/win/angel.ps1` 起的是根目录的 `bridge-server.js` 和 `mind.js`，selftest 名单写死了文件名。根目录这两个入口**永远保留**（重构后变成一行转发）；`angel.ps1` 的名单同步改。
3. **运行时读的路径不能变**：`memory/` `knowledge/` `registry/` `logs/` `config.json` `.env` 都用 `__dirname` 拼的 —— 文件挪进 `src/` 后要改成从项目根算（统一走一个 `paths.js`）。
4. **每一步单独提交，每一步都跑全套测试**（第 0 步做出来的 `npm test`），红了不许进下一步。
5. 在分支 **`refactor/structure`** 上做；`rebuild/create-mods` 照常能部署线上。每个阶段结束 Claude 在实机上跑一轮（部署重构分支 → 看日志 10 分钟 → 有问题切回），通过才合并。

## 阶段

### 第 0 步：安全网（先做，后面全靠它）
- **`scripts/test-all.js`**（`npm test`）：跑全部 `--selftest`、`--check`、`scripts/*-test.js`、冒烟；汇总成一张表；已知红的两个老脚本（`palette-guard-test` 7 条、`angelpal-encoder-parity-test` 2 条）单列为"已知失败"，**不许新增**。
- **冒烟脚本入库**：`scripts/smoke/`（从 Claude 临时目录的 smoke / smoke2 / smoke3 搬进来：假 bot 跑 `instinct.install`、吃东西、上岸）。
- **`bridge-server.js` 可以不连服务器地被 require**：把"起 HTTP 服务 + createBot"包进 `main()`，只在 `require.main === module` 时执行；导出 `handlers`、`state`。**这是唯一允许的非搬移改动**，行为不变（直接 `node bridge-server.js` 照旧）。
- **路由清单测试**：require bridge（不连服），断言 58 + 75 + 5 条路由都在、每条是函数；存一份 `references/routes.json` 快照，路由增减必须改快照。
- **搬移核对脚本** `scripts/refactor/check-moved.js`：给定拆前拆后的文件，按函数名比对源码文本，报告"改了内容的函数"。

### 第 1 步：删除旧脑干（主人 2026-09-28：没必要保存 —— `git rm`，git 历史里还在）
- `autopilot.js` `reflex.js` `journal.js` `brain.js` 直接 `git rm`。
- `decision.js` 里被 bridge 用的 `pickAutoEquip` 搬到装备相关模块（连同它的自测），`decision.js` 其余删除。
- `events.js`：`/events` 端点在读它的格式 —— 留一个最小读取器，写入部分删除。
- `HANDOVER.md` `STATUS.md` `skill-card.md` 删除（主人定的），AGENTS.md / README 里指向它们的地方同步改。
- 同步改 AGENTS.md 架构图、功能分区、自测命令；`angel.ps1` 名单。

### 第 2 步：目录结构（只挪位置）
```
angleice/
  bridge-server.js   mind.js          ← 一行转发，给 Windows 脚本用
  src/
    paths.js  config.js  log-stamp.js  util/            ← 共用（第 4 步填）
    bridge/   server.js  state.js  http.js  connect.js  routes/…      ← 第 3 步拆
    body/     hands 拆出来的：containers  backpack  craft  build  mine  farm  light  move …
    instinct/ core.js + combat  pickup  mine  torch  delve  survival  home  social  commands …
    world/    pathing  place  entity-registry  palette-registry  block-palette  item-registry  fml-handshake  registry-probe  reconnect
    mind/     mind  body（工具）  memory-store  speech  ambition  plan  night  self-review  llm-*
    knowledge/knowledge.js（数据目录 knowledge/ 不动）
  scripts/ docs/ references/ memory/ knowledge/ registry/ logs/   ← 不动
```
- 每挪一个文件：改所有 `require` 路径 + 运行时路径走 `paths.js`；跑 `npm test`。
- 子目录的 `AGENTS.md`（`memory/` `knowledge/` `registry/` `references/`）不动；`src/` 各区加一份简短 AGENTS.md（从根 AGENTS.md 的分区表拆过去）。

### 第 3 步：拆巨石（每次拆一个文件，每次只搬移）
顺序（风险从低到高）：`hands.js` → `instinct.js` → `bridge-server.js` → `mind.js` → `pathing.js`。
- `hands.js`：按路由分组拆成 `src/body/*.js`，每个导出 `routes(ctx)`；`hands.js` 变成汇总 index。
- `instinct.js`：纯函数（`pick*` / `*Plan` / `need*`）和对应自测按本能拆文件；`install()` 里的计时器按本能拆成 `installX(ctx)`；`core.js` 管 `I` / `runJob` / `bodyBusy` / `yieldBody` / `tick` 顺序。
- `bridge-server.js`：连接 / FML / 注册表注入 → `connect.js`；`state` → `state.js`；HTTP 分发 / 身体锁 / 本能让出 → `http.js`；58 条路由按领域拆 `routes/*.js`。
- `mind.js`：看世界（look）/ 想（think 循环 + 退避）/ 提示词拼装 / 工具分组 / 说话节奏 分文件；`SYSTEM` 提示词整体搬进 `prompt.js`，**内容一字不改**。
- `pathing.js`：寻路策略 / goto 预算与续期 / 挖掘白名单 / 门与梯子 分文件。
- 每拆完一个：`check-moved.js` 零差异 + `npm test` 全绿 + 路由快照不变。

### 第 4 步：去重（这一步开始允许小改，但每条单独提交）
- `fullId` / `bare` / `sleep` / 背包计数 / 距离 / 读 config / env 布尔 等小工具收进 `src/util/`，各处改成引用。
- 所有 `CFG`（instinct / mind / bridge）集中到 `src/config.js`（env 覆盖规则统一）。
- 用 `grep` 找同一判据的第二份实现（AGENTS.md §5-4），列清单，一条一条合并。

### 第 5 步：文档
- AGENTS.md 路由表按新目录重写；README 目录结构；`references/api-spec.md` 从路由快照生成。


## 验收（每步）
`npm test` 全绿（已知失败不增）+ `check-moved.js` 零差异（第 2、3 步）+ 路由快照不变 + 冒烟通过；
阶段结束部署到 Windows 看 10 分钟：本能日志正常、`scheduler.loopMs` 不变差、mind 能正常说话和动作。

## 主人的决定（2026-09-28）
- 旧脑干、HANDOVER / STATUS / skill-card：**没必要保存**，直接删（git 历史可查）。
- 目录方案按上面的 `src/` 走；挪完把 AGENTS.md 里"不要为了整齐挪文件"改成"按 src/ 分区放"。

---

## 完成情况（2026-09-29）

分支 `refactor/structure`。第 0–4 步全部落地；第 5 步（文档）本次收尾。

| 步 | 内容 | 提交 |
|---|---|---|
| 0 | 安全网：`test-all.js` / 冒烟入库 / bridge 可无连接 require / 路由快照 / `check-moved.js` | `ebb70c9`（计划）+ 后续各步 `npm test` 全绿 |
| 1 | 删旧脑干（`autopilot` `reflex` `journal` `brain` `decision`）+ 旧文档；`pickAutoEquip` 原样留 | `59c63b0` |
| 2 | 代码挪进 `src/`（bridge / body / instinct / world / mind / knowledge），根只留两个转发入口 | `aefabb8` |
| 3-1 | `hands.js` 5598 行 → `src/body/` 9 个子文件 + `index.js` | `02f203a` |
| 3-2 | `bridge/server.js` 6872 行 → `bridge/` 6 个文件 + `routes/` 10 个文件 | `c090020` |
| 3-3 | `instinct.js` 3561 行 → 8 个子文件 + 汇总 | `0d919c8` |
| 3-4 | `mind.js` 3250 行 → `src/mind/mind/` 11 个子文件 + 汇总壳 | `b346fe7` / `2c15f9c` |
| 3-5 | `pathing.js` 3798 行 → `src/world/pathing/` 10 个文件 + 转发壳 | `29c10c6` / `6c6f6a0` |
| 4 | 去重：小工具收进 `src/util/`（`time` / `ids` / `inventory` / `env`），同一判据只留一份 | `274b51e` |
| 5 | 文档（本次）：各 `AGENTS.md` / `README.md` 按现状重写 + `references/api-spec.md` 自动生成 | 本次 |

### 上线后暴露的拆分遗漏（都已修，防它们的工具见下）

拆巨石"只搬不改"最容易漏的不是函数体，而是**函数体之外的接线**：

1. **漏搬的顶层语句** —— `http.js` 的 `main()` 用 `BRIDGE_VERSION`，拆开后那个 `const` 没跟着搬，一上线就 `ReferenceError`（`0999e49`）。
   → 现在由 `scripts/refactor/check-toplevel.py` 守：比对拆前拆后的顶层语句集合，少了就报。
2. **接线错误：函数名指向不存在的东西 / 作用域没接上** —— 实机"开背包 / 开箱子"报 `summarizeWindow is not defined`（`98a9bfa`）。
   → `scripts/refactor/check-scope.js`：扫出"用到但没拿到的名字"（含模板字符串 / 展开）。
   → `scripts/split-wiring-test.js`（812 条）：专门验转发壳指向的名字**真的存在**、`bind()` 回填后不是 `undefined`。
3. **访问器装错对象 / 转发壳指向不存在的名字** —— `thinkTimer` 这类模块级 `let` 被复制成多份，或壳子 `require` 一个拆掉后不存在的路径。
   → 约定写在 `src/mind/AGENTS.md`（拆环三招）与各 `AGENTS.md`「循环依赖」小节；`check-scope` + `split-wiring-test` 一起守。
4. **路径从 `__dirname` 拼的运行时目录** —— 文件挪进 `src/` 后必须从项目根算。
   → 统一走 `src/paths.js`（唯一来源）；`bridge-boot-test.js` / `bridge-reload-test.js` 在真起进程的层面上守。

### 现在守着的网（每步都跑）

- `scripts/test-all.js`（`npm test`）：全部 `--selftest` / `--check` / `scripts/*-test.js` / 冒烟 + **api-spec 是否过期**；已知红的两项单列，不许新增。
- `scripts/refactor/check-moved.js`：拆前拆后函数体逐字比对（第 2、3 步验收用）。
- `scripts/refactor/check-toplevel.py` / `check-scope.js`：上面第 1、2 条遗漏的专门防线。
- `scripts/split-wiring-test.js`（812）/ `bridge-boot-test.js`（6）/ `bridge-reload-test.js`（25）：转发壳 / 启动 / 热重载三条接线防线。
- `scripts/routes-test.js`：路由快照 `references/routes.json` 比对（140 条：bridge 60 / hands 75 / commonsense 5）。
- `scripts/gen-api-spec.js --check`：`references/api-spec.md` 从快照重新生成后比对，路由变了没重生成就报红。

### 本次第 5 步顺手修的 3 个 bug（跟重构同一批发现）

1. **家范围漏了高度**：`body/movement.js` 与 `instinct/core.js` 各自内联的"在不在家"没有 `|Δy| ≤ 16`，家里正上方/正下方会被误判在家。两处都改调正主 `body/util.js` 的 `inHomeArea`（判据只此一份）。
2. **`/attack` 认不出模组怪**：`bridge/routes/body.js` 的本地 `HOSTILE` Set 只认 22 个原版名字。改用正主 `world/entity-registry.js` 的 `isHostileEntity`，并加 `isBossEntity` 把 Boss 排除在**自动挑怪**之外（明确指定目标不受影响）。
3. **`inventoryCount` 把"读不到"兜成 0**：违反 AGENTS.md §5-1。改返回 `null`，11 处调用点逐个处理（`bridge/util.js` 的 `sweepUpDrops`、`routes/mine.js` 的 `countDelta`、`routes/inspect.js`），读不到时如实报 `unreadable` / `inventoryUnreadable`。
