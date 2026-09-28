/**
 * routes/diag.js —— 从 server.js 的 handlers 表拆出的 11 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const bodyCommandLock = require('../body-command-lock.js');
const fs = require('fs');
const hands = require('../../body/hands.js');
const instinct = require('../../instinct/instinct.js');
const inventoryLedger = require('../../body/inventory-ledger.js');
const itemRegistry = require('../../world/item-registry.js');
const path = require('path');
const pathing = require('../../world/pathing');
const storagePolicy = require('../../body/storage-policy.js');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let REGISTRY_DIR;
let state;
let goals;

function sleep (...a) { return __ns.sleep.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（11 条）：
 *   GET /debug/registries
 *   GET /debug/registry
 *   GET /debug/packets
 *   POST /jump
 *   POST /flee
 *   GET /inventory/ledger
 *   GET /ftbq/completed
 *   GET /instinct
 *   GET /instinct/events
 *   POST /instinct
 *   POST /stop
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'GET /debug/registries': async () => {
    const fmlState = state.__fml && state.__fml.state;
    if (!fmlState) {
      return { enabled: false, hint: '需要 MC_FORGE=1 且已连上服务端' };
    }
    const snaps = fmlState.registrySnapshots || [];
    const withSnap = snaps.filter(s => s.hasSnapshot);
    return {
      enabled: true,
      handshakeDone: fmlState.done,
      acked: fmlState.acked,
      declaredRegistries: fmlState.registries || [],
      declaredCount: (fmlState.registries || []).length,
      declaredHasBlock: (fmlState.registries || []).includes('minecraft:block'),
      receivedCount: snaps.length,
      receivedWithSnapshot: withSnap.length,
      // 全部明细：名字 / 有没有快照 / 字节数 / 解析出多少条 / 是否正好吃完
      snapshots: snaps,
      // 真正拿到手的两张表
      blockRegistry: fmlState.blockRegistry
        ? { entryCount: fmlState.blockRegistry.entries.length, sample: fmlState.blockRegistry.entries.slice(0, 8) }
        : null,
      itemRegistry: fmlState.itemRegistry
        ? { entryCount: fmlState.itemRegistry.entries.length }
        : null,
      files: fs.existsSync(REGISTRY_DIR) ? fs.readdirSync(REGISTRY_DIR) : [],
    };
  },

  // 查一张已落盘的注册表：`?name=minecraft:block&q=glass_trapdoor&limit=20`
  'GET /debug/registry': async (_, qs) => {
    const name = (qs && qs.name) || 'minecraft:block';
    const q = (qs && qs.q) || '';
    const limit = (qs && qs.limit) || 20;
    const file = path.join(REGISTRY_DIR, String(name).replace(':', '-') + '.json');
    if (!fs.existsSync(file)) {
      return { found: false, file, hint: '还没落盘。确认 MC_FORGE=1 且握手已完成。' };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const needle = String(q).toLowerCase();
    const hits = data.entries.filter(([n]) => !needle || n.toLowerCase().includes(needle));
    return {
      found: true, registry: data.registry, capturedAt: data.capturedAt,
      total: data.entryCount, matched: hits.length,
      entries: hits.slice(0, Math.min(+limit || 20, 200)),
    };
  },

  // 诊断：服务端发来的包统计 + 注册表探针结果（MC_PROBE_PACKETS=1 才有内容）。
  // 用途：确认"方块名到底有没有可能从网络流里拿到" —— 不要再靠猜。
  'GET /debug/packets': async () => {
    if (!state.__probe) {
      return { enabled: false, hint: '用 MC_PROBE_PACKETS=1 启动才会挂探针' };
    }
    const s = state.__probe;
    return {
      enabled: true,
      totalPackets: s.packets,
      // 只回传出现次数最多的前 30 个包名，避免响应过大
      topPackets: Object.entries(s.byName).sort((a, b) => b[1] - a[1]).slice(0, 30),
      declareCommands: s.declareCommands,
      tags: s.tags,
      notes: s.notes,
    };
  },

  // 上浮换气。给反射层用（`reflex.js` 的 `reflex:breathe`）。
  //
  // 为什么不用寻路：憋气是以**秒**计的，而 `pathfinder.goto` 先要 A* 算路（几百毫秒起），
  // 三维水下还经常算不出路。原版的解法最简单 —— 一直按跳跃键，人自己就浮上去了。
  //
  // ⚠️ `durationMs` 是**最长**时间，不是保证时间。到水面就提前停：
  //    氧气在回涨就说明已经能呼吸了，继续按着跳会让"站在岸边"变成"一直跳"。
  'POST /jump': async ({ durationMs = 1200, stopAtOxygen = 60, abort } = {}) => {
    durationMs = Math.min(Math.max(100, +durationMs || 1200), 10000);

    state.currentAction = 'jumping（上浮 / 越过障碍）';
    const t0 = Date.now();
    let jumped = 0;
    let stoppedEarly = null;
    try {
      // 每 100ms 一跳而不是"按住不放"：
      // mineflayer 的 setControlState('jump', true) 在服务端只保证**当前 tick** 生效，
      // 按住需要客户端持续发包。分段跳既完成上浮，又给了中断的机会。
      while (Date.now() - t0 < durationMs && !abort?.()) {
        state.bot.setControlState('jump', true);
        await sleep(100);
        state.bot.setControlState('jump', false);
        jumped++;

        // 已经能呼吸了 → 提前收工
        const oxy = state.bot.oxygenLevel;
        if (Number.isFinite(oxy) && oxy >= stopAtOxygen) {
          stoppedEarly = `氧气已回到 ${oxy}，提前停止`;
          break;
        }
        // 掉线/死亡时立刻退出，别空转满 durationMs
        if (!state.connected || state.bot.health === 0) break;
        await sleep(50);
      }
    } finally {
      try { state.bot.setControlState('jump', false); } catch (_) {}
      state.currentAction = null;
    }

    return {
      jumped,
      durationMs: Date.now() - t0,
      oxygen: state.bot.oxygenLevel ?? null,
      onGround: state.bot.entity?.onGround ?? null,
      stoppedEarly: stoppedEarly || undefined,
    };
  },

  // 朝远离某点的方向走一段。给反射层用（`reflex.js` 的 `reflex:fleeFire`）。
  //
  // ⚠️ 与 `POST /stop` 的关系：这个是"动"，那个是"停"。
  //    实现上**必须先 setGoal(null)** —— 否则寻路器还挂着旧目标，
  //    `goto` 会被它自己覆盖掉（实测过：不 clear 的情况下 goto 不动）。
  'POST /flee': async ({ distance = 8, fromX, fromY, fromZ } = {}) => {
    distance = Math.min(Math.max(1, +distance), 32);
    const self = state.bot.entity;
    if (!self?.position) throw new Error('bot 没有位置（未连接？）');

    // 从哪逃：默认是**当前位置**（也就是"离开这里"）。
    // 调用方给了坐标就用它（比如"远离火源那块方块"）。
    const ox = fromX !== undefined ? +fromX : Math.floor(self.position.x);
    const oz = fromZ !== undefined ? +fromZ : Math.floor(self.position.z);

    // 8 个方向各试一遍，选"目标点最远离原点"的那个。
    // ⚠️ 只看水平方向：往垂直方向逃（跳下悬崖/爬上墙）都需要地形信息，
    //    而反射层的全部意义就是**不需要**地形信息。
    const dirs = [
      [1, 0], [1, 1], [0, 1], [-1, 1],
      [-1, 0], [-1, -1], [0, -1], [1, -1],
    ];
    const scored = dirs
      .map(([dx, dz]) => {
        const len = Math.hypot(dx, dz) || 1;
        const tx = Math.floor(self.position.x) + Math.round((dx / len) * distance);
        const tz = Math.floor(self.position.z) + Math.round((dz / len) * distance);
        return { tx, tz, score: Math.hypot(tx - ox, tz - oz) };
      })
      .sort((a, b) => b.score - a.score);

    // 先清掉旧目标，否则 goto 会被 pathfinder 自己的旧 goal 顶掉
    try { state.bot.pathfinder.setGoal(null); } catch (_) {}
    state.bot.clearControlStates();

    state.currentAction = `fleeing to ${scored[0].tx},${scored[0].tz}`;
    const attempted = [];
    try {
      for (const cand of scored.slice(0, 3)) {
        try {
          await withTimeout(
            state.bot.pathfinder.goto(
              new goals.GoalNear(cand.tx, Math.floor(self.position.y), cand.tz, 2),
            ),
            Math.max(2000, distance * 500),
          );
          return {
            fled: true,
            to: { x: cand.tx, z: cand.tz },
            from: { x: ox, z: oz },
            distance: +Math.hypot(cand.tx - ox, cand.tz - oz).toFixed(1),
            alternativesTried: attempted.length,
          };
        } catch (e) {
          attempted.push(`(${cand.tx},${cand.tz}): ${e.message}`);
        }
      }
    } finally {
      state.currentAction = null;
    }

    return {
      fled: false,
      from: { x: ox, z: oz },
      // 三个方向都走不了，很可能是被围住了 —— 如实报告，让上层决定
      reason: `8 个方向里最近的 3 个都走不通：${attempted.join('；')}`,
    };
  },

  // 物品账：背包每次进出（变了什么、为什么）。mind 按 seq 往后读：?since=<上次的 seq>
  'GET /inventory/ledger': async ({ since = 0 } = {}) => {
    if (!state.ledger) return { seq: 0, entries: [] };
    const r = state.ledger.since(+since || 0);
    return { ...r, lines: r.entries.map(e => inventoryLedger.render(e)) };
  },

  // 任务书进度：已完成的任务 id（和 quests.json 同样的 16 位十六进制）。known=false = 还没收到服务器的进度（不是"一个都没做"）
  // ?refresh=1 主动向服务器要一份（ftbquests:request_team_data）
  'GET /ftbq/completed': async ({ refresh } = {}) => {
    if (refresh && state.ftbqRequest) { state.ftbqRequest(); await new Promise(r => setTimeout(r, 1500)); }
    const f = state.ftbq;
    return f ? { known: true, count: f.completed.size, completed: [...f.completed], team: f.teamName, at: f.at }
      : { known: false, error: state.ftbqError || null, requestedAt: state.ftbqRequestedAt || null };
  },

  // 本能的开关与现状：她为什么捡 / 为什么没捡，最近做了什么
  'GET /instinct': async () => {
    const I = state.instinct;
    if (!I) return { installed: false };
    return {
      installed: true,
      pickup: I.cfg.pickup, harvest: I.cfg.harvest, mine: I.cfg.mine, sleep: I.cfg.sleep, armor: I.cfg.armor, gaze: I.cfg.gaze, combat: I.cfg.combat, tidy: I.cfg.tidy, loot: I.cfg.loot, cave: I.cfg.cave, bridge: I.cfg.bridge, mlg: I.cfg.mlg, dig: I.cfg.dig, homeGrow: I.cfg.home, cmd: I.cfg.cmd, death: I.death || null, movePolicy: I.movePolicy || null,
      combatNow: I.combat && I.running?.kind === 'combat' ? { since: I.combat.started, at: Date.now(), engaged: I.combat.engaged.size, killed: I.combat.killed } : null,
      lastCancel: state.lastCancel || null,
      diagnostics: I.diagnostics || {},
      scheduler: I.scheduler || null,
      urgent: I.urgent || null,
      sleepState: I.sleepState || null,
      sleepCorrections: I.sleepCorrections || 0,
      home: I.home,
      running: I.running ? I.running.kind : null,
      inflight: I.inflight,
      bodyCommand: bodyCommandLock.status(state),
      quietForMs: Math.max(0, I.quietUntil - Date.now()),
      last: I.last,
      log: I.log.slice(-10),
    };
  },
  // 本能做了什么 / 看见什么没做成（mind 按 seq 往后读，变成她经历的事）
  'GET /instinct/events': async ({ since = 0 } = {}) => {
    const I = state.instinct;
    if (!I) return { seq: 0, events: [] };
    return { seq: I.evSeq, events: I.events.filter(e => e.seq > (+since || 0)) };
  },
  // home 除了几何位置，也带仓库白名单/保护规则；自动整理和 mind 手动整理必须共用。
  'POST /instinct': async (b = {}) => {
    const { radius, followRadius, home } = b;
    const I = state.instinct;
    if (!I) throw new Error('本能还没装上（bot 还没建好）');
    const KINDS = ['pickup', 'harvest', 'mine', 'sleep', 'armor', 'gaze', 'combat', 'tidy', 'loot', 'cave', 'bridge', 'mlg', 'dig', 'cmd'];
    for (const k of KINDS) if (typeof b[k] === 'boolean') I.cfg[k].enabled = b[k];
    // 家在哪（收获本能：耕地上的庄稼只收家里的）。mind 知道家，定期告诉这里
    if (home === null) I.home = null;
    else if (home && home.center && Number.isFinite(+home.center.x) && Number.isFinite(+home.center.z)) {
      const store = storagePolicy.normalizeStorage(home);
      const nh = {
        center: { x: +home.center.x, y: +home.center.y || 64, z: +home.center.z },
        radius: Math.max(4, +home.radius || 24), storage: store.storage,
        emptyBoxes: store.empty, protected: store.protected,
      };
      // 同一个家（中心没挪）：半径取大的 —— 本能层数出来的"房子长大了"不能被 mind 记忆里的旧半径盖回去（mind 看返回值跟上）
      const same = I.home && Math.hypot(I.home.center.x - nh.center.x, I.home.center.z - nh.center.z) <= 2;
      I.home = same ? { ...nh, radius: Math.max(nh.radius, I.home.radius) } : nh;
    }
    if (radius !== undefined && Number.isFinite(+radius)) I.cfg.pickup.radius = Math.min(Math.max(1, +radius), 16);
    if (followRadius !== undefined && Number.isFinite(+followRadius)) I.cfg.pickup.followRadius = Math.min(Math.max(1, +followRadius), 12);
    if (I.running && b[I.running.kind] === false) I.running.abort();
    return { ...Object.fromEntries(KINDS.map(k => [k, I.cfg[k].enabled])), home: I.home };
  },

  'POST /stop': async () => {
    // ⚠️⚠️ 2026-09-29 实机：`/stop` 停不住一条**在途的 `POST /go`**，
    //    她以为"刚才身体自己在走路，不让我传"（日志 03:48–03:50）：
    //      run_command(home) ✗ 身体正在执行 POST /go（30.7 秒）
    //      stop() ✓
    //      run_command(home) ✗ 身体正在执行 POST /go（77.9 秒）   ← stop 之后 /go 还在跑、锁还占着
    //      stop() ✓ ；go_home() ✗ 走不到（还差 18254.8 格）        ← 第二次 stop 才停下
    //
    //    原来这里只有三样：`setGoal(null)` + `clearControlStates()` + `currentAction = null`。
    //    三样都拦不住 `go()`（`src/body/movement.js`）：它每个 `await` 之后会问一次自己的
    //    `abort` 谓词，然后**接着走下一步、把 goal 重新设回去**（这就是那三样失效的原因，
    //    见 `go()` 顶部注释与 `hands.startFollow`）。而那个 `abort` 谓词是
    //    `http.js` 按"取消线"(`state.cmdCancelledUpTo`) 注进来的 —— `/stop` 从来没碰过它，
    //    也从来**没有释放身体锁**（`state.bodyCommand`），所以下一条命令收到的是
    //    "身体正在执行 POST /go（77.9 秒）"。
    //
    //    现在按现成的两套机制收口（不另造一套）：
    //      ① `cancelCommands` 那套取消线 —— 让 handler 在下一个检查点收手；
    //      ② 身体锁 token 上挂的 `abort`（`http.js` 的 `setAbort`）—— 让 `/go` 立刻抛 aborted。
    //    然后**释放锁**，下一条命令立刻能进。
    const stoppedCommand = bodyCommandLock.abortCurrent(state, '被 /stop 叫停');
    // 取消线推到当前序号：正在跑的 handler 问 `args.abort()` 时会拿到 true。
    state.cmdCancelledUpTo = state.cmdSeq || 0;
    state.lastCancel = { t: Date.now(), why: 'POST /stop' };
    state.bot.pathfinder.setGoal(null);
    // ⚠️ 控制位也必须清 —— 否则"急停"停不住一个按住的 W。
    // 这是原始控制层引入后必须补的一环：看门狗的危险急停走的就是这个端点。
    state.bot.clearControlStates();
    try { state.bot.stopDigging(); } catch (_) {}
    // ⚠️ `currentAction = null` 还是**跟随循环的退出条件**（hands.startFollow 的 alive() 就认这个）：
    // 光清 goal 停不住一条在途路线 —— go() 会接着走下一步、把 goal 重新设回去。
    // 所以 go() 里每一步之后都会问一次 abort 谓词，而这个谓词读的正是 currentAction。
    // 改这里之前先看 hands.startFollow 的注释。
    state.currentAction = null;
    // ★ 释放身体锁（`/stop` 在 http.js 里**绕过锁**进入，所以也不需要 token 就能放）。
    const released = bodyCommandLock.status(state, Date.now())?.key || null;
    if (released) bodyCommandLock.release(state, state.bodyCommand);
    return {
      stopped: true,
      controlsCleared: true,
      // 停掉了哪条命令（null = 当时没有身体命令在跑）。**必须报** ——
      // "没有命令在跑"和"我停不掉它"是两种完全不同的结果（AGENTS.md §5-1）。
      stoppedCommand: stoppedCommand ?? null,
      bodyCommandReleased: !!released,
    };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.REGISTRY_DIR !== undefined) REGISTRY_DIR = ns.REGISTRY_DIR;
  if (ns.sleep !== undefined) sleep = ns.sleep;
  if (ns.state !== undefined) state = ns.state;
  if (ns.withTimeout !== undefined) withTimeout = ns.withTimeout;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  goals = ns.goals;
}

module.exports = {
  routes,
  keys: ["GET /debug/registries","GET /debug/registry","GET /debug/packets","POST /jump","POST /flee","GET /inventory/ledger","GET /ftbq/completed","GET /instinct","GET /instinct/events","POST /instinct","POST /stop"],
  bind,
  rebind,
 };
