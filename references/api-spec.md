# Minecraft Bridge API Specification

Base URL: `http://127.0.0.1:${MC_BRIDGE_PORT:-3001}`
Content-Type: `application/json`
Authentication: none (bound to `127.0.0.1` only)

> On Windows / proxied environments always call with `curl --noproxy '*'`, otherwise the
> proxy intercepts localhost and you get `upstream connect failed` / `os error 10061`.

---

## Response Format

### Success
```json
{"success": true, "...": "data"}
```

### Failure
```json
{"success": false, "error": "message"}
```

### Bot Offline (503)
```json
{"error": "Bot not connected", "hint": "Open Minecraft and check MC_HOST/MC_PORT"}
```

The following endpoints work **even while the bot is offline** (they are exempt from the
connection guard) and are the right place to start when diagnosing:

| Endpoint | Why it still works offline |
|---|---|
| `GET /status` | reports `connected: false` |
| `GET /config` | shows the effective target/identity — no bot needed |
| `GET /knowledge`, `GET\|POST /knowledge/search` | reads the on-disk modpack knowledge base |
| `GET /memory` | reads the on-disk journal + state snapshot |
| `GET /state` | reads the last cached state snapshot |

---

## GET /config

The configuration actually in effect (after env-var / `config.json` / default resolution).
Read this first so you never have to guess which server or identity is live.

```json
{
  "success": true,
  "identity": "Angel_ICE",
  "identityIsDefault": true,
  "host": "127.0.0.1",
  "port": 25565,
  "version": "1.20.1",
  "auth": "offline",
  "forge": true,
  "bridgePort": 3001,
  "skillDir": ".../skills/minecraft-bridge",
  "configFile": ".../skills/minecraft-bridge/config.json",
  "pathfinder": {
    "canDig": true,
    "digCost": 16,
    "placeCost": 12,
    "liquidCost": 6,
    "allow1by1towers": false,
    "allowParkour": true,
    "allowSprinting": true,
    "scafoldingBlocks": 0,
    "policy": {
      "canDig": true,
      "digCost": 16,
      "protectedCount": 613,
      "protectedSample": ["oak_planks", "gold_ore", "oak_log", "glass"]
    },
    "registryProbe": {"checked": 6, "ok": 6, "mismatched": []}
  }
}
```

`identityIsDefault: false` means `MC_BOT_USERNAME` was overridden somewhere — worth
noticing, since the persona is tied to `Angel_ICE`.

### `pathfinder` — the movement-policy self-check

`null` while the bot has not spawned yet (the policy needs `bot.registry.blocksByName`).
Once online, **read `digCost` and `policy.protectedCount` together — not `canDig` alone.**

`mineflayer-pathfinder` ships `canDig = true` **and `digCost = 1`**. Reading
`lib/movements.js` gives the scale that the readme omits: walking one block costs `1`, and
breaking one dirt block costs `(1 + 3*digTime/1000) * digCost ≈ 1.45`. So by default
**breaking a block is barely more expensive than walking one block** — the pathfinder
treats a wall as a road. Combined with "follow the player", that silently turns into
demolishing the player's house.

> ⚠️ Disabling `canDig` outright is the **wrong** fix — it removes the last resort, so
> places that genuinely must be tunnelled through report `No path to the goal!` instead.
> `canDig` is therefore `true` and the protection is carried by two other things:

| Field | Meaning |
|---|---|
| `digCost` | multiplier on digging (default **16** → one dirt block ≈ walking 23 blocks). Soft layer: detours win, but digging still happens when there is no detour |
| `policy.protectedCount` | how many block IDs were added to `blocksCantBreak` (building materials: wool, planks, glass, doors, stairs, chests, ores…). Hard layer: **never** broken while pathing |
| `policy.protectedSample` | the first dozen names that matched, so you can sanity-check the patterns |
| `registryProbe` | `name → id → name` round-trip for six well-known blocks. The hard layer is keyed by **name**, and names are not fully trustworthy on this 470-mod server — **if `mismatched` is non-empty, only the soft layer is doing real work** |

A useful side effect of the `cost > 100` cutoff inside `movements.js`: a bare-handed stone
dig computes to ≈376 and is discarded, so **without a pickaxe she cannot tunnel stone** —
which is what a real player experiences too.

Costs are tunable: `MC_DIG_COST`, `MC_PLACE_COST`, `MC_LIQUID_COST`. The policy itself
lives in `pathing.js` (`node pathing.js --selftest`, 87 cases).

Known trade-off: **doors are protected** and `canOpenDoors` is off, so a closed door locks
her out. Deliberate — better to be unable to enter than to remove the player's door.

Related: every `bot.dig` is wrapped for audit. A dig that happens while `currentAction`
is not a mining task is appended to `memory/journal.md` as
`⚠️ 非挖掘动作中拆掉了 <block> @ x,y,z`. That line appearing = something is pathfinding
through the world again. Note that `POST /mine` calls `bot.dig` directly and never consults
`blocksCantBreak`, so the hard ban does **not** interfere with explicit mining.

---

## GET /status

Check bridge health and bot connection state.

### Response fields

| Field | Type | Meaning |
|---|---|---|
| connected | boolean | Whether the bot is connected |
| username | string | Bot username |
| position | `{x,y,z}` or null | Current position |
| health | number or null | Health (0–20) |
| food | number or null | Hunger (0–20) |
| saturation | number or null | Food saturation |
| gameTime | number or null | In-game time (0–24000) |
| isDay | boolean | Convenience day/night flag |
| inventoryCount | number | Count of non-empty inventory stacks |
| currentAction | string or null | Current action |
| bridgeVersion | string | Bridge version |

---

## GET /memory?limit=40

**Her memory.** Returns the recent journal lines plus a fresh state snapshot.
Call this *before* speaking so continuity is preserved.

Parameters:
- `limit`: number of journal lines to return from the tail, default 40, max 500

Example:
```json
{
  "success": true,
  "journalFile": ".../memory/journal.md",
  "stateFile": ".../memory/state.json",
  "journalTotal": 128,
  "journal": [
    "- [2026-09-22 23:41:07] (player-join) Ka_sum1 上线了",
    "- [2026-09-22 23:41:12] (chat) <Ka_sum1> 你来啦",
    "- [2026-09-22 23:42:30] (promise) 和你说好下次一起去看日落"
  ],
  "state": {
    "savedAt": "2026-09-22 23:45:00",
    "identity": "Angel_ICE",
    "server": "127.0.0.1:25565",
    "connected": true,
    "position": {"x": 128, "y": 64, "z": -47},
    "dimension": "minecraft:overworld",
    "health": 18,
    "food": 17,
    "gameTime": 6000,
    "isDay": true,
    "inventory": ["iron_orex3", "stone_pickaxex1"],
    "playersOnline": ["Angel_ICE", "Ka_sum1"],
    "currentAction": null
  }
}
```

Journal line format: `- [YYYY-MM-DD HH:MM:SS] (type) text`

Auto-written types: `spawn`, `disconnect`, `death`, `respawn`, `hurt`, `chat`,
`event`, `player-join`, `player-leave`.
Agent-written types (suggested): `note`, `promise`, `plan`, `feeling`, `gift`,
`discovery`.

---

## GET /state

The last cached state snapshot, read straight from disk without refreshing it. Cheaper
than `/memory` when you only need "where is she right now".

```json
{"success": true, "cached": true, "savedAt": "...", "position": {...}, "...": "..."}
```

`cached: false` means the file didn't exist yet and the response is a fresh snapshot.

---

## POST /memory

Write a memory line. Use this for anything that should survive a restart: promises,
plans, discoveries, feelings, things the player said.

Request:
```json
{"text": "和你说好下次一起去看日落", "type": "promise"}
```

`type` defaults to `note`.

Response:
```json
{"success": true, "written": "- [2026-09-22 23:42:30] (promise) 和你说好下次一起去看日落", "journalFile": ".../memory/journal.md"}
```

Write it in **first person, in her voice** — she will read it back later.

---

## GET /knowledge

List the game knowledge base (the modpack's quest book, item names, mods, tips).
Works **while the bot is offline**.

```json
{
  "success": true,
  "dir": ".../skills/minecraft-bridge/knowledge",
  "available": ["README.md", "pack-overview.md", "main-quest.md", "chapters.md",
                "tooltips.md", "mods.md", "quests.json", "item-names.json", "lookup.py"],
  "hint": "GET /knowledge/search?type=quest|item|chapter|tip|mod&q=<关键词>",
  "files": {
    "pack-overview.md": "整合包总览 + 核心机制（必读）",
    "main-quest.md": "主线任务路线图",
    "chapters.md": "61 章全部任务标题",
    "tooltips.md": "物品提示（怎么获得/怎么用）",
    "mods.md": "467 个模组清单"
  }
}
```

---

## GET /knowledge/search
## POST /knowledge/search

Query the knowledge base. **This is how she answers game questions without asking
the player basic things.**

Both verbs take the same parameters. Use POST when the keyword contains non-ASCII
characters (see the warning below).

### Parameters

| Param | Meaning |
|---|---|
| `type` | `quest` \| `item` \| `chapter` \| `tip` \| `mod` \| `raw` (default `quest`) |
| `q` | keyword (required unless `type=raw`) |
| `file` | for `type=raw`: a `.md` filename inside the knowledge dir |
| `limit` | for `type=raw`: max lines (default 400); for others: max output chars (default 6000) |

With POST, send the same fields as a JSON body; body values win over query-string
values, so you can mix them.

### ⚠️ Non-ASCII keywords must be URL-encoded

Node's HTTP parser rejects non-ASCII bytes in the request line with a bare
`400 Bad Request` **and an empty body**. So this looks like "no results" but
never reaches the handler:

```bash
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=quest&q=末影龙"   # ✗ 400, empty
```

Use either of these instead:

```bash
# ✓ let curl percent-encode it
curl --noproxy '*' -G --data-urlencode "type=quest" --data-urlencode "q=末影龙" \
     "http://127.0.0.1:3001/knowledge/search"

# ✓ or put it in a JSON body (no encoding concerns at all)
curl --noproxy '*' -X POST -H "Content-Type: application/json" \
     -d '{"type":"quest","q":"末影龙"}' "http://127.0.0.1:3001/knowledge/search"
```

### Examples

```bash
# 搜任务（标题 / 说明 / 需求物品 / 图标）
curl --noproxy '*' -G --data-urlencode "type=quest" --data-urlencode "q=末影龙" \
     "http://127.0.0.1:3001/knowledge/search"

# 物品名 → modid:item，或反过来（纯 ASCII 的可以直接拼）
curl --noproxy '*' -G --data-urlencode "type=item" --data-urlencode "q=棱彩解药桶" \
     "http://127.0.0.1:3001/knowledge/search"
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=item&q=terramity:"

# 找章节
curl --noproxy '*' -G --data-urlencode "type=chapter" --data-urlencode "q=蜜蜂" \
     "http://127.0.0.1:3001/knowledge/search"

# 物品提示
curl --noproxy '*' -G --data-urlencode "type=tip" --data-urlencode "q=大鳄龟" \
     "http://127.0.0.1:3001/knowledge/search"

# 模组
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=mod&q=terramity"

# 读整个文件（如核心机制总览）
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=raw&file=pack-overview.md"
```

### Response

```json
{
  "success": true,
  "type": "quest",
  "q": "末影龙",
  "result": {
    "output": "找到 12 个任务包含「末影龙」\n\n[冒险之旅 › 末地涉险]\n  任务：末地的主宰\n    需求：击杀 末影龙 x1\n    ...",
    "truncated": false
  }
}
```

When `result.truncated` is `true`, use a more specific keyword.

### Requirements

Querying spawns `python` (or `python3`) to run `knowledge/lookup.py`. If neither is
on `PATH`, set `MC_PYTHON` to an absolute interpreter path, e.g.:

```json
{ "MC_PYTHON": "C:\\Python313\\python.exe" }
```

Errors mention this explicitly if the interpreter can't be found.

---

## GET /inventory

Return all carried items.

Example:
```json
{
  "success": true,
  "items": [
    {
      "name": "iron_ore",
      "displayName": "Iron Ore",
      "count": 24,
      "slot": 36,
      "durability": null
    }
  ],
  "totalStacks": 3
}
```

---

## GET /position

Return position and facing.

Example:
```json
{
  "success": true,
  "x": -142,
  "y": 64,
  "z": 88,
  "yaw": 1.57,
  "pitch": 0.0
}
```

---

## GET /health

Return health and hunger state.

Example:
```json
{
  "success": true,
  "health": 18.0,
  "food": 14,
  "saturation": 5.0,
  "isDead": false
}
```

---

## GET /nearby?radius=16

Return nearby entities.

Parameters:
- `radius`: detection radius in blocks, default 16, practical upper bound ~32

Example:
```json
{
  "success": true,
  "entities": [
    {
      "name": "Zombie",
      "type": "mob",
      "distance": 8,
      "position": {"x": -150, "y": 64, "z": 88}
    }
  ],
  "radius": 16
}
```

---

## GET /block

Query blocks. **Always probe before moving** — the bot can walk off a cliff or into lava
otherwise, because the pathfinder does not always know about unloaded terrain.

### Single block — `?x=&y=&z=`

```json
{
  "success": true,
  "position": {"x": -142, "y": 63, "z": 88},
  "block": "grass_block",
  "solid": true,
  "diggable": true,
  "stateId": 9
}
```

Three things `block` can be — **they are not interchangeable**:

| `block` | Meaning |
|---|---|
| a name | a block mineflayer recognises |
| `null` + `note: "chunk not loaded"` | the chunk isn't in the client's view |
| `""` + `note: "unmapped block state …"` | **a real block whose state has no name** in mineflayer's registry |

> ⚠️ **`""` is not air.** It means "there is a block here and I can't name it", which is
> common on modded servers. Treating it as air will have you reason about an empty space
> that is actually occupied.
>
> ⚠️ **On modded servers the names themselves can be wrong.** Measured on a 1.20.1 Forge
> pack: placing `white_wool` made that coordinate read back as `fire`, before/after on the
> same position. `stateId` is the server's raw value and is the more trustworthy identity
> for "is this the same block as before" — but do not use any of it to confirm a
> placement; confirm via `GET /inventory` instead.

### Vertical column — no parameters

Returns the column around the bot's feet (`dy` from `+2` down to `-4`) plus `onGround`:

```json
{
  "success": true,
  "at": {"x": -142, "y": 64, "z": 88},
  "onGround": true,
  "column": [
    {"dy": 2, "block": "air", "solid": false},
    {"dy": 1, "block": "air", "solid": false},
    {"dy": 0, "block": "fire", "solid": false},
    {"dy": -1, "block": "stone", "solid": true},
    {"dy": -2, "block": "stone", "solid": true},
    {"dy": -3, "block": "stone", "solid": true},
    {"dy": -4, "block": "stone", "solid": true}
  ]
}
```

A long run of `solid: false` below `dy: -1` means a drop.

---

## POST /chat

Send an in-game chat message.

Request:
```json
{"message": "Hello world!"}
```

Response:
```json
{"success": true, "sent": "Hello world!"}
```

---

## POST /command

Send a slash command through the bot.

Request:
```json
{"command": "give Angel_ICE diamond 64"}
```

Notes:
- Leading `/` is optional
- This is potentially high risk if the bot has elevated permissions
- Prefer `minecraft-server-admin` for server-administration tasks

---

## POST /move

Pathfind to target coordinates.

Request:
```json
{"x": -100, "y": 64, "z": 200}
```

If `y` is omitted, the bridge uses an XZ goal and lets the pathfinder determine height.

Success example:
```json
{"success": true, "arrived": {"x": -100, "y": 64, "z": 200}}
```

Failure example:
```json
{"success": false, "error": "No path found"}
```

---

## POST /mine

Mine the nearest matching block(s).

Request:
```json
{"blockName": "iron_ore", "count": 5}
```

Response:
```json
{"success": true, "blockName": "iron_ore", "requested": 5, "mined": 4}
```

`mined` may be lower than `requested` if there are not enough matching blocks nearby.

> ⚠️ **On modded servers this endpoint is unreliable, in two separate ways.**
>
> **1. The name you ask for may not be the name the bot sees.** Measured: asking for
> `white_wool` returned `mined: 0` — the bot's registry calls that block `fire`, so
> `findBlock` matched nothing. It reports no error; it just quietly mines nothing. This is
> the same palette mismatch described under `GET /block`.
>
> **2. It throws instead of reporting partial progress.** Mining 1 of 2 and then failing
> yields `{"success": false, "error": "No path to the goal!"}` with **no `mined` count**,
> even though the dig happened. `GoalLookAtBlock` fails this way fairly often in tight
> interiors, and more often when digging was banned outright; restoring digging at a high
> `digCost` walks that back but does not eliminate it.
>
> **Confirm with `GET /inventory`, never with this response.** Retry after repositioning.

---

## POST /collect

Collect dropped ground items.

Request:
```json
{"itemName": "iron_ingot", "count": 10}
```

---

## POST /craft

Craft an item, using a nearby crafting table when required.

Request:
```json
{"itemName": "iron_pickaxe", "count": 1}
```

Common failure reasons:
- no valid recipe
- missing crafting table
- missing materials

---

## POST /follow

Follow a player continuously until `/stop`.

Request:
```json
{"playerName": "Steve"}
```

---

## POST /stop

Cancel the current movement/mining/follow action.

Response:
```json
{"success": true, "stopped": true}
```

---

## GET /players

List known players. mineflayer's player table contains every player the server has
told us about, but `position` is only filled in once that player's entity is inside
the client's view distance — `distance: null` means "online but not visible".

Example:
```json
{
  "success": true,
  "count": 2,
  "players": [
    {
      "username": "Steve",
      "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
      "ping": 42,
      "gamemode": 0,
      "isSelf": false,
      "position": {"x": -140, "y": 64, "z": 90},
      "distance": 12
    },
    {
      "username": "Angel_ICE",
      "uuid": "f25ba722-7bc5-3d6e-8abf-53e88520b123",
      "ping": 26,
      "gamemode": 0,
      "isSelf": true,
      "position": {"x": -142, "y": 64, "z": 88},
      "distance": 0
    }
  ]
}
```

Sorted by distance, self last.

---

## GET /chatlog?limit=30

Return recently received chat / system messages (ring buffer, last 200 kept).

**This is how you read the output of `POST /command`** — e.g. `/list` or `/msg` replies
land here, they are not returned by the command endpoint itself.

Example:
```json
{
  "success": true,
  "buffered": 3,
  "messages": [
    {"t": 1790096341496, "text": "* Angel_ICE 加入了游戏", "position": "bridge"},
    {"t": 1790096341841, "text": "Custom harness creation is currently only available in single-player mode.", "position": "system"},
    {"t": 1790096397678, "text": "There are 1 of a max of 20 players online: Angel_ICE", "position": "system"}
  ]
}
```

`position` is `"chat"` | `"system"` | `"game_info"` | `"bridge"` (the last one is
synthesised by the bridge for join/leave events).

> ⚠️ **The speaker is embedded in `text`, there is no `username` field.**
> Player lines arrive as `{"t":..., "position":"chat", "text":"<Ka_sum1> 你好"}`.
> Code that reads `m.username` gets `undefined` for every player message and will
> silently conclude "nobody is talking to me". Parse the `<Name>` prefix out of
> `text` instead.

---

## POST /look

Turn the bot's head toward a player or a coordinate.

Request (player):
```json
{"playerName": "Steve"}
```

Request (coordinate):
```json
{"x": -140, "y": 65, "z": 90}
```

Response:
```json
{"success": true, "lookingAt": "Steve"}
```

---

## POST /attack

Melee attack. Defaults to the nearest hostile mob; pass `target` to name a specific
entity type.

Request:
```json
{"radius": 4}
```
```json
{"target": "skeleton", "radius": 6}
```

Response:
```json
{"success": true, "attacked": 6, "targets": ["skeleton"]}
```

`radius` is clamped to 1–16. Up to 3 targets, 6 swings each. If nothing matches:
```json
{"success": true, "attacked": 0, "message": "no hostile mob within 4"}
```

Built-in hostile list: skeleton, zombie, spider, creeper, witch, enderman, husk,
stray, drowned, phantom, pillager, vindicator, ravager, slime, magma_cube, blaze,
ghast, wither_skeleton, zombified_piglin, piglin, hoglin, zoglin.

---

## POST /equip

Equip an item from the inventory.

Request:
```json
{"itemName": "stone_sword", "destination": "hand"}
```

`destination`: `hand` (default) | `off-hand` | `head` | `torso` | `legs` | `feet`

Response:
```json
{"success": true, "equipped": "stone_sword", "destination": "hand"}
```

Fails with `Not carrying <itemName>` if the item isn't in the inventory.

---

## POST /place

Put a block from the inventory down at a world coordinate. Before this existed the bridge
could dig but not build — so a bot that knocked a hole in someone's wall could apologise
but never repair it.

Request:
```json
{"itemName": "white_wool", "x": 35, "y": 74, "z": -135}
```

`itemName` is optional — omit it to place whatever is currently held.
`confirmMs` is optional (default 1500, clamped 200–5000) — how long to wait for the server's
`blockUpdate` before giving up on confirmation.

Response:
```json
{
  "success": true,
  "placed": "white_wool",
  "at": {"x": 35, "y": 74, "z": -135},
  "via": "below",
  "distance": 1.97,
  "confirmed": true,
  "facesTried": 1
}
```

| Field | Meaning |
|---|---|
| `via` | which neighbour face was used — `below` / `above` / `west` / `east` / `north` / `south` |
| `distance` | eye-to-contact-point distance in blocks (must be < 4.5) |
| `confirmed` | `true` = the server pushed a `blockUpdate` for that cell. **`false` does not mean failure** — it may just be latency, or a ghost block. Re-check with `GET /inventory`. |
| `facesTried` | how many faces were attempted before one worked |

### The four hard conditions

Placement fails *silently* if any of these is violated, which is why they are enforced here
rather than left to `placeBlock` to sort out:

| # | Condition | Why |
|---|---|---|
| ① | a solid neighbour exists to place against | you cannot place into open air |
| ② | the chosen face is lookable / unobstructed | needs raycast; the handler uses `lookAt`'s result |
| ③ | **eye**-to-contact-point distance < 4.5 blocks | out of reach means the server ignores it, surfacing as a timeout rather than an error |
| ④ | the bot's own hitbox does not occupy the target cell | otherwise she places a block inside herself |

The body is also brought to a stop (`pathfinder.setGoal(null)` + `clearControlStates()`)
before placing — a drifting body places the block into the neighbouring cell.

①③④ are pure geometry and live in **`place.js`**, which `bridge-server.js` requires directly
(`node place.js --selftest`, 23 cases). Condition ② needs a live raycast, so it is the only
one handled in the handler.

Errors — each names the offending face so the caller knows what to fix:

| Error | Meaning |
|---|---|
| `Refusing to overwrite <block> at x,y,z` | the target holds something non-replaceable — it will not clobber the player's build |
| `Target cell is occupied by my own body (x,y,z) — step aside first` | condition ④ — she is standing in the target cell |
| `Target out of reach (need < 4.5 blocks from eyes) — walk closer first. Faces: below:too-far(7.6), …` | condition ③ — **walk closer** |
| `No solid neighbour to place against at x,y,z. Faces: below:not-solid(air), …` | condition ① — **pick a different spot** |
| `All N geometrically valid faces failed at x,y,z (last: …)` | conditions passed but every face failed at execution (blocked view / server refusal) |
| `Not carrying <itemName>` | not in the inventory |
| `Nothing in hand (pass itemName)` | no `itemName` given and the hand is empty |

> ⚠️ **Success means the item left the inventory — verify that way.** On modded servers
> `GET /block` may report a completely different name for what you just placed (measured:
> `white_wool` reads back as `fire`). `confirmed: true` only tells you *a* block appeared,
> never *which* — do not use the read-back to confirm the placement.

---

## POST /drop

Toss an item on the ground, or hand it to a player.

Request:
```json
{"itemName": "white_wool", "count": 2, "playerName": "Ka_sum1"}
```

All fields optional. `count` defaults to the whole stack; `playerName` makes the bot look
at them first so the item lands in their direction.

Response:
```json
{"success": true, "dropped": "white_wool", "count": 2, "to": "Ka_sum1"}
```

Fails with `Player not visible: <name>` if that player isn't in range, or
`Not carrying <itemName>`.

---

## Common `blockName` Values

| Block | `blockName` |
|---|---|
| Stone | `stone` |
| Cobblestone | `cobblestone` |
| Dirt | `dirt` |
| Sand | `sand` |
| Gravel | `gravel` |
| Oak Log | `oak_log` |
| Coal Ore | `coal_ore` |
| Iron Ore | `iron_ore` |
| Gold Ore | `gold_ore` |
| Diamond Ore | `diamond_ore` |
| Deepslate Diamond Ore | `deepslate_diamond_ore` |
| Redstone Ore | `redstone_ore` |
| Crafting Table | `crafting_table` |
| Furnace | `furnace` |
| Chest | `chest` |

---

# Autopilot Control Plane

A **second, separate** API surface on its own port (default `127.0.0.1:3002`, local only),
served by `autopilot.js` — the perceive → decide → act loop. Everything above this line is
`bridge-server.js` on port 3001 (her hands and eyes); this section is her brain stem.

Both planes return the same envelope: `{"success": true, ...}` or `{"error": "..."}`.

## GET /autopilot

Current state, live config, and the most recent decision.

```json
{
  "running": true,
  "action": "following Ka_sum1",
  "tick": 412,
  "uptimeSec": 903,
  "lastSeenPlayer": {"x": 33, "y": 74, "z": -129, "name": "Ka_sum1", "t": 1790104271379},
  "task": null,
  "taskResult": null,
  "lastDecision": {"action": "follow", "backend": "local", "confidence": 0.8, "menu": ["follow","idle"], "criteria": "…", "state": {"hp": 20}},
  "lastStuck": {"detail": "连续 3 次清路仍无位移", "at": 1790104271379},
  "taskFailures": [{"sig": "[\"mine\",\"iron_ore\",3,\"\",\"\",\"\",\"\"]", "failures": 3, "attempts": 3}],
  "decision": {"configured": "local", "willUse": "local", "jevKeyPresent": false, "jevBreakerOpen": false},
  "pendingQuestions": [],
  "ears": {"polls": 451, "heard": 3, "errors": 0, "lastError": null, "lastPollAt": 1790104271379, "intervalMs": 2000},
  "config": {},
  "log": []
}
```

| Field | Meaning |
|---|---|
| `lastDecision` | why she did the last thing — action, backend, confidence, the candidate `menu`, the chosen action's `criteria`, and the state it was decided from |
| `lastStuck` | most recent stuck verdict (`null` if never). Not spoken aloud — the agent decides whether to tell the player |
| `taskFailures` | per-task-signature failure/attempt counts driving the retry cap |
| `decision.configured` | the configured backend (`local` / `jev` / `auto`). **Defaults to `local`** — a key present in the env does *not* switch it |
| `decision.willUse` | which backend is actually in use (`local` / `jev`), and whether the Jev breaker is open |
| `pendingQuestions` | things the player asked that the autopilot deliberately does **not** answer — it has no language model; the agent answers these |
| `ears.polls` | attempts by the independent chat-listening loop. **Climbs even while offline** — that is the point: a counter that only advanced on success could not distinguish "running but can't read" from "not running" |
| `ears.errors` | consecutive read failures (reset on any success); `lastError` says why (typically `Bot not connected`) |
| `ears.heard` | player messages caught by the ears loop (her own lines are not counted) |

## GET /autopilot/events?n=30

The structured decision trail (`memory/events.jsonl`), most recent last. `n` is clamped to
1–500, default 30.

```json
{
  "count": 30,
  "events": [
    {"t": 1790104271379, "ts": "2026-09-22T19:11:11.379Z", "kind": "decision", "tick": 412,
     "action": "follow", "backend": "local", "confidence": 0.8,
     "menu": ["follow","idle"], "criteria": "玩家走远了…", "state": {"hp": 20, "threat": null, "task": null, "player": {"name":"Ka_sum1","distance":9}, "isDay": true},
     "cached": false, "degraded": null, "lowConfidence": false},
    {"t": 1790104271450, "ts": "…", "kind": "outcome", "tick": 412, "action": "follow",
     "ok": true, "error": null, "interrupted": false, "stuck": false, "gaveUp": false, "ms": 71, "note": "following Ka_sum1"},
    {"t": 1790104271520, "ts": "…", "kind": "task", "phase": "done", "type": "mine", "ms": 8400}
  ]
}
```

Three `kind` values:

| `kind` | Written when | Key fields |
|---|---|---|
| `decision` | every tick, after choosing | `action`, `backend`, `confidence`, `menu`, `criteria`, `state` |
| `outcome` | every tick, after acting | `ok`, `error`, `interrupted`, `stuck`, `gaveUp`, `ms` |
| `task` | task lifecycle | `phase` = `start` \| `done` \| `failed` \| `interrupted` \| `stuck` \| `gave_up` \| `refused` |

The **menu is recorded on purpose**. Logging only the chosen action makes review impossible —
you cannot tell a good choice from a forced one. The candidate set is what makes "why this
one?" answerable.

## GET /autopilot/stats

Aggregate over the whole trail — this is the "can we measure it" endpoint.

```json
{
  "path": "…/memory/events.jsonl",
  "total": 1840, "firstTs": "…", "lastTs": "…",
  "decisions": 920, "byAction": {"idle": 700, "follow": 180, "work": 40},
  "byBackend": {"local": 920},
  "cached": 812, "degraded": 0, "lowConfidence": 3, "avgConfidence": 0.84,
  "outcomes": 918, "ok": 900, "failed": 18, "interrupted": 6, "stuck": 2,
  "failureRate": 0.02, "avgMs": 143,
  "tasksDone": 12, "tasksFailed": 3, "tasksGaveUp": 1, "tasksInterrupted": 2
}
```

## POST /autopilot/task

Queue a job for her to pick up on the next tick.

```json
{"type": "mine", "blockName": "iron_ore", "count": 10}
```

Task types: `mine` · `collect` · `craft` · `goto` · `follow` · `place` · `give` · `say`.

**409 when the task is exhausted** — the retry cap has been hit, so it is refused up front
rather than letting her fail the same way again:

```json
{"success": false, "refused": true,
 "reason": "同一个任务已经失败 3 次（上限 3）",
 "hint": "换个目标/参数，或先 POST /autopilot/config {\"maxTaskFailures\":N} 放宽上限"}
```

Note the subtlety in the counters: **an interruption is not a failure.** Being chased off a
mining job by a creeper does not count toward `failures`, and the task is *kept* so she
resumes it once it is safe. Only genuinely impossible outcomes count, and `attempts` (cap 12)
exists separately to bound the case where she is repeatedly interrupted without ever failing.

## POST /autopilot/say

```json
{"message": "诶？我在呀～"}
```

Bypasses the cooldown and the unsolicited-lecture filter — but still only use it in response
to the player. See PERSONA.md.

## POST /autopilot/config

Runtime retuning. Only keys already in the config are accepted.

```json
{"followMax": 10}
```

> ⚠️ The threshold keys (`followMax`, `criticalHp`, `fightRadius`, `dangerRadius`) are mirrored
> into `decision.js`'s `TUNING`, because the action menu is built from `TUNING`. Setting only
> one copy gives you a parameter that moves without changing behaviour.

## POST /autopilot/forget

Clear task-failure counts, so a previously exhausted task can be attempted again. Needed
because the counters otherwise persist for the process lifetime — if the player hands her a
pickaxe after three "no path" failures, she must be allowed to try again.

```json
{}                 // clear everything  -> {"cleared": 4}
{"type": "mine"}   // only mine tasks   -> {"cleared": 2, "type": "mine"}
```

## POST /autopilot/stop

Stop the loop; the process exits shortly after. `{"stopping": true}`.
