# scripts/ —— 运维、诊断、契约测试

根目录 `AGENTS.md` 里定义了 `$NODE`。所有脚本都从**项目根目录**运行（`$NODE scripts/xxx.js`）。

## 分类

| 类别 | 脚本 | 说明 |
|---|---|---|
| **进程** | `start.sh` / `stop.sh` | 只托管 `bridge-server.js`；PID 在 `$XDG_RUNTIME_DIR` 或 `/tmp`，日志 `logs/bridge.log`。node 按 `$NODE` → PATH → WorkBuddy 自带 的顺序找 |
| **契约测试**（离线，属于自测集） | `fml-snapshot-test.js` `palette-guard-test.js` `jev-contract-test.js` `angelpal-to-palette.js --selftest` | 改 ① 区 / ③ 区相关代码后必须跑 |
| **网络诊断** | `mc-ping.js` `net-layers.js` `scan-login-channels.py` | 区分"端口 OPEN"与"服务真应答"（SSH 隧道假死时 TCP 6ms 成功但无应答） |
| **注册表工具** | `angelpal-to-palette.js` `make-vanilla-palette.js` | 产物写到 `registry/` |
| **静态审计** | `audit-get-params.js --strict` | 查 GET 端点从 body 取参（GET 的参数在 query，body 恒空）。加新 GET 端点后跑 |
| **实机观察** | `walk-to.js` `watch-player.js` `scan-blocks.py` `map-blocks.py` | 需要 bridge 在线 |
| **数据维护** | `journal-compact.js` `speech-audit.js` | 折叠日记重复条目 / 用数字审计她的发言长度 |
| **归档** | `_attic/` | 一次性诊断脚本，零引用，保留作历史 |

## 规矩

- 新的一次性诊断脚本：先放根目录用 `_probe*.js` / `_dbg*.js` 命名（已被 `.gitignore` 排除），**用完删或移进 `_attic/`**。
- 值得长期保留的脚本放这里，文件头写清"为什么需要它"和用法（照现有脚本的注释格式）。
- Python 脚本访问本地端口：`urllib` 会无视 `os.environ.pop` 走代理，用 `subprocess.run(['curl','-s','--noproxy','*',...])`。
