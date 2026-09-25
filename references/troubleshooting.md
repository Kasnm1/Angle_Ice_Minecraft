# Minecraft Bridge Troubleshooting

## Quick Diagnosis

```text
1. curl --noproxy '*' http://127.0.0.1:3001/status
   ├─ ECONNREFUSED         -> service not running
   ├─ {"connected":false} -> bridge up, bot offline
   ├─ {"connected":true}  -> bridge connected; investigate the action itself
   └─ other errors         -> inspect logs and config
```

> `--noproxy '*'` is required on Windows / proxied environments. Without it, `curl` to
> localhost may fail with `upstream connect failed` / `os error 10061` even though the
> bridge is up.

`GET /config`, `GET /memory`, and `GET /state` are readable **while the bot is offline** —
use them first when diagnosing (they tell you the effective target and what happened last).

---

## A. Service Not Running (ECONNREFUSED)

Checks:
1. Verify Node.js is installed (`node --version`, ideally v18+)
2. Verify dependencies are installed
3. Start the bridge manually and watch output
4. Check whether the port is already occupied

Example:

```bash
node bridge-server.js            # from the skill directory
curl --noproxy '*' http://127.0.0.1:3001/config
```

On Windows, find the process holding the port:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen |
  Select-Object -ExpandProperty OwningProcess |
  ForEach-Object { Get-Process -Id $_ }
```

---

## B. Bridge Running, Bot Offline

Common causes:

### Minecraft / server is not running
Open Minecraft Java Edition and enter the target world, or start the server.

### Wrong port (very common in singleplayer LAN)
When you use "Open to LAN", the port is random each time.
Update `MC_PORT` to the actual LAN port.

### Version mismatch
Make sure `MC_VERSION` matches the actual game/server version.
(Modded packs are usually pinned — Forge 1.20.1 packs need `MC_VERSION=1.20.1`.)

### Username collision
If another player already uses `Angel_ICE`, the login will fail. Either disconnect the
other session or temporarily override `MC_BOT_USERNAME`.

### Auth mismatch
Public/authenticated servers may require Microsoft auth rather than offline mode.
Set `MC_AUTH=microsoft` when appropriate.

### Forge server rejects the client
See section E.

---

## C. Action Execution Fails

### `/move` -> `No path found`
- target is sealed off
- destination is too far for a reliable single pathing run
- use intermediate waypoints

### `/mine` -> mined < requested
- there are not enough matching blocks nearby
- move closer to the target area first

### `/craft` -> no recipe / missing crafting table
- required workbench not nearby
- recipe unavailable or materials missing

### bot appears stuck
1. send `POST /stop`
2. inspect `GET /status` and `currentAction`
3. restart the bridge if necessary

---

## D. Other Common Problems

### Dependency version mismatch
Reinstall dependencies cleanly if Mineflayer packages are out of sync.

### Firewall / exposure concern
The bridge is intended to listen only on `127.0.0.1`.
Do not expose it publicly.

### High memory usage
Mineflayer can use more memory when many chunks are loaded.
Lower view distance or reduce movement scope if needed.

### `PartialReadError ... command_node` on join
Modded Brigadier argument types are missing from the vanilla protodef schema. Non-fatal —
the byte stream re-aligns and the bot works. Only investigate if live state reads misbehave.

---

## E. Forge / Modded Servers

### Kick: `This server has mods that require Forge to be installed on the client.`
`MC_FORGE` is not enabled. Set `"MC_FORGE": "1"` in `config.json` (or `MC_FORGE=1` in the
environment) and restart. Confirm with `GET /config` → `"forge": true`.

### No `[fml]` log lines at all
The `\0FML3` host marker is missing, so the server classified the client as VANILLA and
never started the handshake. This is handled automatically when `MC_FORGE=1`; if you see
this, the patch did not attach — check for `[bridge] FML 握手挂载失败` in the log.

### Kick: `multiplayer.disconnect.unexpected_query_response`
A login channel was answered with an empty payload but was registered with
`needsResponse=true`. The log names the offending channel on the preceding line:

```text
[fml] mod 登录通道 <channel> index=<n> inner=<hex>(<len>B)
```

Reverse that mod (`javap -p -c -constants`) to find its C2S reply discriminator, then add
it to `MOD_LOGIN_REPLIES` in `fml-handshake.js`.

See `forge-fml-handshake.md` for the full method. `FML_SKIP=<chan1,chan2>` suppresses
replies for listed channels, which helps bisect.

### Auditing a new modpack
Don't discover channels one kick at a time:

```bash
python scripts/scan-login-channels.py "<mods-dir>" login-scan.txt
```

---

## F. Memory

Memory lives in `memory/` inside the skill directory.

```bash
curl --noproxy '*' "http://127.0.0.1:3001/memory?limit=40"
ls -la memory/            # journal.md, state.json
```

### `GET /memory` returns `journalTotal: 0`
Nothing has been journalled yet — the files are created on first event. If the bot has been
running a while and it's still 0, check that the skill directory is writable.

### Memory seems to reset
`memory/` is inside the skill directory. Moving, reinstalling, or re-downloading the skill
replaces it. Back up `memory/journal.md` before reinstalling if the history matters.

### Journal grows unbounded
It is append-only by design. Trim manually if needed:

```bash
tail -n 2000 memory/journal.md > memory/journal.tmp && mv memory/journal.tmp memory/journal.md
```

---

## Useful Log Signals

Typical messages:

```text
[bridge] Bot online @ {"x":-142,"y":64,"z":88}
[bridge] Bot error: read ECONNRESET
[bridge] Bot disconnected (...), retrying...
[bridge] POST /move error: ...
[fml] mod 登录通道 zeta:main index=154 inner=62...(24B) → 回执 63...
```

For deeper debugging:

```bash
DEBUG=mineflayer:* node bridge-server.js
```
