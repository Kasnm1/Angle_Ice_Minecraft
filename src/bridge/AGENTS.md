# `src/bridge/` —— 桥 / 协议（手 + 眼）

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。
>
> **2026-09-28 第 3 步：`server.js` 6872 行拆成下面的 17 个文件**（纯搬移、零改逻辑）。
> 入口仍是 `server.js`，但现在它是**汇总器**：require 子文件 → 两阶段 `bind` →
> 按原顺序把路由拼回 `handlers` → 照原样 `module.exports`。

## 文件

### 汇总入口

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.js` | ~190 | **汇总 + 入口**。require 全部子文件；建 `__ns` 符号表；对每个模块 `bind(__ns)`；按原顺序 `Object.assign` 回 `handlers`；包一层 `loadDependencies()` 以便调用后 `rebindAll()`；`module.exports` 与拆分前**逐字一致**（13 名、原顺序）；保留 `if (require.main === module) main();` |

### 基础层（子文件）

| 文件 | 行数 | 职责 |
|---|---|---|
| `config.js` | ~90 | 配置：`loadFileConfig` / `cfg` / `CFG` / `BRIDGE_VERSION` / `BOT_IDENTITY` / `REGISTRY_DIR` |
| `state.js` | ~170 | 全局 `state` 对象（**只有这一份**，别人只 require/引用）、chatlog / `pushChat` / journal / `saveState` |
| `util.js` | ~560 | 小工具：`botPos` / `json` / `sleep` / `DBG` / `withTimeout` / `requireConnected` / 物品名比对 / 掉落物 / 指纹 / `sweepUpDrops` / `waitForBlock` |
| `goto.js` | ~230 | 寻路：`gotoWithBudget` / `guardPathfinderCrash` |
| `connect.js` | ~1160 | 连接与装配：`loadDependencies` / `installForgeHandshake` / 调色板导入 / `install*Plugin` / `fixLadderIdBeforeConnect` / `createBot`（439 行，最重的一块） |
| `http.js` | ~320 | `fixMojibake` / `http.createServer` 分发 / `main()` |

### 路由层（`routes/`，每个文件导出普通对象）

| 文件 | 行数 | 路由 |
|---|---|---|
| `routes/inspect.js` | ~930 | 21 条：`GET /config` `/status` `/inventory` `/recipes` `/item` `/position` `/health` `/nearby` `/players` `/block` `/chatlog` `/memory` `/state` `/knowledge` `/knowledge/search`、4 条 `/debug/*`、`POST /reconnect` `/memory` `/knowledge/search` |
| `routes/scan.js` | ~360 | `GET /scan` |
| `routes/pickup.js` | ~360 | `POST /pickup` |
| `routes/body.js` | ~350 | 6 条：`GET /plugins` `/entities`、`POST /look` `/attack` `/equip` `/chat` |
| `routes/place.js` | ~630 | `POST /place` `/shelter` |
| `routes/move.js` | ~360 | `POST /drop` `/unstick` `/command` `/move` |
| `routes/mine.js` | ~600 | `POST /mine`（挖之前先用 `body/tool-choice` 的 `ensureDigTool` 挑工具，回包多一个 `toolsUsed`）。**水里的惜命**（2026-09-29）：挖每块之前 + 走过去之前 + 真 dig 之前各查一次氧气（判据在 `instinct/survival.js` 的 `mineShouldStop`，阈值 `CFG.bridgeMine`），停就回 `stopped:'need_air'`；水下的目标默认**不挖**（`underwaterKeep`，回包带 `underwater`） |
| `routes/gather.js` | ~390 | 6 条：`POST /collect` `/craft` `/follow` `/control` `/climb` `/activate` |
| `routes/palette.js` | ~170 | 5 条：`GET /palette` `/palette/state` `/palette/block` `/palette/climbable`、`POST /registry/import-palette` |
| `routes/diag.js` | ~360 | 11 条：`GET /debug/registries` `/debug/registry` `/debug/packets` `/inventory/ledger` `/ftbq/completed` `/instinct` `/instinct/events`、`POST /jump` `/flee` `/instinct` `/stop`。`/stop`（2026-09-29）：叫停在途命令（`abortCurrent`）+ 推取消线 + 清 goal/控制位 + **释放身体锁**，回包多 `stoppedCommand` / `bodyCommandReleased` |

### 无关本次拆分的旧文件

| 文件 | 职责 |
|---|---|
| `body-command-lock.js` | 身体命令互斥锁：HTTP 请求可重叠，后来的命令收 `busy`，不排队（`/stop` 绕过）。**`setAbort` / `abortCurrent`**（2026-09-29）：命令把自己的 abort 谓词挂在锁 token 上，`/stop` 就能叫停在途命令（`/go` 会"续算"、把 goal 设回去，光 `setGoal(null)` 停不住）。`--selftest` 跑**真的** `POST /stop` handler |
| `reconnect.js` | 断线重连 |

被它 require 的邻居：`../body/*`（hands / commonsense / equip-policy / inventory-ledger /
storage-policy / ftbq-sync）、`../world/*`（pathing / place / 三个注册表 / fml-handshake /
registry-probe）、`../instinct/instinct`、`../mind/night`、`../knowledge/knowledge`、
`../paths`、`../log-stamp`。

## 拼接是怎么把循环依赖解开的（改代码前先读这段）

拆分前整块是一个文件，名字互相引用天然没问题。拆开后 **`handlers` 是个真环**：

- `createBot()`（`connect.js`）把 `handlers` 交给 `instinct.install`；
- `GET /knowledge/search`（`routes/inspect.js`）要回调 `handlers['GET /knowledge/search']`；
- `POST /place` / `POST /shelter` 内部要调 `handlers['POST /go']`。

解法（与第 3a 步拆 `hands.js` 同一套）：

1. **先建表**：`server.js` 在 require 之前就 `const handlers = {}`，放进 `__ns`。
   所有读取方拿到的是**同一个对象引用**；后面 `Object.assign` 往里填键，
   读取方立刻看得到（引用没变、内容变了）。
2. **两阶段 `bind`**：子文件顶部只有 `const __ns = {}` + `let X;` 占位 +
   `function f (...) { return __ns.f.apply(null, a); }` 转发壳，**require 期不调用任何人**。
   等 `server.js` 把 `__ns` 备齐后再逐个 `mod.bind(__ns)` —— 环里有值。
3. **模块级 `let` 用访问器**：`goals` / `Vec3` / `mineflayer` / `autoEatPlugin` /
   `toolPlugin` / `collectBlockPlugin` / `Movements` / `pathfinderPlugin` /
   `BLOCK_NAME_TO_ID` 这 9 个在 `loadDependencies()` / 运行中会被**重新赋值**，
   而 `bind()` 发生在 require 期（更早）。所以 owner（`connect.js`）用
   `exposeReloadable()` 把它们挂成 `__ns` 上的 **getter**，读取方用 `let X;` 占位、
   靠 `rebind(ns)` 抄最新值。`server.js` 把 `loadDependencies()` 包了一层，
   调用后自动 `rebindAll()`。

> ⚠️ **改这块时的四个坑**（都真踩过）：
> ① 不能用 `Object.assign(__ns, ns)` —— owner 的可重赋值属性是 **getter-only**，会
>    `TypeError: Cannot set property … which has only a getter`。用"跳过已存在键"的循环。
> ② 读取方**不能**提前写 `const { goals } = __ns` —— 那是快照，永远 `undefined`。
> ③ 一个可重赋值变量**只能有一个持有者**。`lastHealth` 最初被同时声明在 `state.js` 和
>    `connect.js`，两份永不同步 —— 拆分时的临时工具抓到了（现由 `scripts/bridge-reload-test.js` 守）。
> ④ `exposeReloadable(__ns)` 必须把访问器装在 **server.js 的** `__ns` 上（2026-09-28 验收时抓到：装在 connect.js 自己那份上，
>    离线测试全绿，但 `loadDependencies()` 之后各路由文件的 `Vec3` / `goals` 全是 undefined）。守它的是 `scripts/bridge-reload-test.js`。
>    `BLOCK_NAME_TO_ID` 是第一次 `blockNameToId()` 时才建的，`GET /config` 在 server.js 里包了一层、每次先 rebind。

## 铁律

- **绝不** `node src/bridge/server.js --selftest`（一 require 就连服务器、抢 3001）。只能
  `node --check src/bridge/server.js`。同理**不要** `node bridge-server.js`（不带参数）。
- 新 handler 必须返回能回答"做得有多好"的字段（`mined` / `placed` / `moved` …），动作可能
  没生效时显式给 `ok: <bool>`。`ok` 缺失不会被否决；**不要**写成 `!result.ok`。
- "没有"和"读不到"分开报：注册表查不到 → `nameSource` / `unknown` 标注，不许返回空串冒充"没有"。
- 站位判据（`isStandable` / `findStandY` / `reachableStandY` / `DEADLY`）从 `../world/place.js`
  解构来用，**不要**在这里再写一份。
- 版本号：`BRIDGE_VERSION` 与 `package.json` 的 `version` 必须一致。
- 新增 GET 端点后跑 `node scripts/audit-get-params.js --strict`（GET 参数在 query，别从 body 取）。
- **新路由要挂对文件**：路由按**源码顺序**分组在 `routes/*.js` 里，`server.js` 的
  `routeFiles` 数组顺序 = `Object.keys(handlers)` 的顺序。顺序变了
  `references/handlers-order-bridge.json` 会拦（`routes-test` + `test-all` 都会红）。

## 自测

```bash
$NODE --check src/bridge/server.js                       # 唯一的语法检查（别 --selftest）
for f in src/bridge/*.js src/bridge/routes/*.js; do $NODE --check $f || echo BAD $f; done
$NODE src/bridge/body-command-lock.js --selftest; $NODE src/bridge/reconnect.js --selftest
$NODE scripts/bridge-reload-test.js # 各文件在 loadDependencies() 之后读得到 Vec3 / goals / 插件（真跑一遍，不连服）
$NODE scripts/routes-test.js        # 路由清单契约（138 条）+ bridge 路由键序
$NODE scripts/test-all.js           # 全套；含 checkBridgeExports（13 导出名 + 58 路由键序）
```

拆文件本身的核对用仓库里的：

```bash
$NODE scripts/refactor/check-moved.js --before <拆前 ref> --files src/bridge/server.js --after-dir src/bridge/   # 函数/路由原文一字不改
$NODE scripts/bridge-reload-test.js   # 可重赋值变量：loadDependencies() 之后每个持有者都读得到真值
```


根目录 `bridge-server.js` 是转发壳，`node --check` 它也能过，但真正的语法检查对 `src/bridge/server.js`。
