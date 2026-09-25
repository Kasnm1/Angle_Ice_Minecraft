# references/ —— 参考规格（① 区的外部契约）

| 文件 | 内容 | 什么时候改 |
|---|---|---|
| `api-spec.md` | bridge `:3001` 的 HTTP 接口规格 | **加 / 改 / 删端点时同步改**（包括 `hands.js` 挂上去的 `/eat` `/use` `/wear` `/craft2` `/smelt` `/container/*`） |
| `forge-fml-handshake.md` | Forge/FML 登录握手协议说明 | 改 `fml-handshake.js` / `registry-probe.js` 时 |
| `dependency-guide.md` | 依赖版本与安装 | 升级 mineflayer / minecraft-data 时 |
| `troubleshooting.md` | 连接与运行排错 | 实机踩到新坑、且 `memory/field-log.md` 已记录之后，把**结论**摘过来 |

- 这里写**结论与契约**，证据与过程留在 `memory/field-log.md`，两边用 P 编号互相引用。
- ⚠️ 当前 `api-spec.md` 可能滞后于 `bridge-server.js`（1.11.0）。以代码为准；对照方法：
  `grep -nE "^\s*'(GET|POST) /" bridge-server.js hands.js`。
