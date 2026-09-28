# `src/bridge/` —— 桥 / 协议（手 + 眼）

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `server.js` | `:3001` REST，包住 mineflayer（原 `bridge-server.js`）。路由层在 handler 返回 `ok === false`（严格布尔）时否决成 `success:false`（P47） |
| `body-command-lock.js` | 身体命令互斥锁：HTTP 请求可重叠，后来的命令收 `busy`，不排队（`/stop` 绕过） |
| `reconnect.js` | 断线重连 |

被它 require 的邻居：`../body/*`（hands / commonsense / equip-policy / inventory-ledger /
storage-policy / ftbq-sync）、`../world/*`（pathing / place / 三个注册表 / fml-handshake /
registry-probe）、`../instinct/instinct`、`../mind/night`、`../knowledge/knowledge`、
`../paths`、`../log-stamp`。

## 铁律

- **绝不** `node src/bridge/server.js --selftest`（一 require 就连服务器、抢 3001）。只能
  `node --check src/bridge/server.js`。
- 新 handler 必须返回能回答"做得有多好"的字段（`mined` / `placed` / `moved` …），动作可能
  没生效时显式给 `ok: <bool>`。`ok` 缺失不会被否决；**不要**写成 `!result.ok`。
- "没有"和"读不到"分开报：注册表查不到 → `nameSource` / `unknown` 标注，不许返回空串冒充"没有"。
- 站位判据（`isStandable` / `findStandY` / `reachableStandY` / `DEADLY`）从 `../world/place.js`
  解构来用，**不要**在这里再写一份。
- 版本号：`BRIDGE_VERSION` 与 `package.json` 的 `version` 必须一致。
- 新增 GET 端点后跑 `node scripts/audit-get-params.js --strict`（GET 参数在 query，别从 body 取）。

## 自测

```bash
$NODE --check src/bridge/server.js
$NODE src/bridge/body-command-lock.js --selftest; $NODE src/bridge/reconnect.js --selftest
$NODE scripts/routes-test.js        # 路由清单契约（138 条，跟 references/routes.json 比）
```

根目录 `bridge-server.js` 是转发壳，`node --check` 它也能过，但真正的语法检查对 `src/bridge/server.js`。
