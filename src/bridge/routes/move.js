/**
 * routes/move.js —— 从 server.js 的 handlers 表拆出的 4 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const path = require('path');
const pathing = require('../../world/pathing');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let state;
let goals;

function botPos (...a) { return __ns.botPos.apply(null, a); }
function sameItem (...a) { return __ns.sameItem.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（4 条）：
 *   POST /drop
 *   POST /unstick
 *   POST /command
 *   POST /move
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'POST /drop': async ({ itemName, count, playerName }) => {
    const item = itemName
      ? state.bot.inventory.items().find(i => sameItem(i.name, itemName))
      : state.bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');

    // 先看向玩家，丢出去的东西才会落在他那边
    if (playerName) {
      const ent = state.bot.players[playerName]?.entity;
      if (!ent) throw new Error(`Player not visible: ${playerName}`);
      await state.bot.lookAt(ent.position.offset(0, 1.5, 0), true);
    }

    const n = count === undefined ? item.count : Math.min(Math.max(1, +count), item.count);
    if (n >= item.count) await withTimeout(state.bot.tossStack(item));
    else await withTimeout(state.bot.toss(item.type, null, n));

    return { dropped: item.name, count: n, to: playerName || null };
  },

  // ---------------------------------------------------------------- 自救逃逸（P42）
  //
  // ## 为什么需要这个端点
  //
  // 2026-09-25 实测（field-log **P42**）：她被卡在一条**只有 1 格高**的天然缝隙里，
  // `/move` 四个方向**全部 `No path found`**。决定性证据：从她所在格做 4 邻居
  // 泛洪 → **连通分量 = 1**（整层 21 个 air 格只连通她自己那一格）。
  //
  // 真因：**通道只有 1 格高，而她身高 1.8 格**。站位需要"脚层 + 头层"都非实心 ——
  // 唯一可站的邻格与她**对角**相邻，而正交邻居全实心时 Minecraft 不允许走对角。
  // → **`No path found` 是正确判定，不是 bug。**
  //
  // 但后果是致命的：`canDig = false`（`pathing.js` 的 `ALLOW_DIG`，默认关）
  // 让寻路器**只绕不拆**，绕不过去就永久卡死。她**自己没有任何办法出来** ——
  // 上一次是我从外面调 `/mine` 挖开 `grass_block` 才把她放出来。
  //
  // ⚠️ 而用户的目标是「**自己**建立庇护所并持续发育」。**"自己"这两个字
  //    要求她在被困时能自救**，否则一次意外地形就能让主线永久停滞。
  //
  // ## 这个端点做什么
  //
  // **不改变全局政策**（`canDig` 仍是 false）。它做的是：**临时**打开
  // `canDig`，尝试走到目标；**无论成败都恢复**。这就是
  // `pathing.applyPolicy(mv, names, { allowDig: true })` 那个"单次放行口子"
  // 的第一次真正使用（那句话在 `pathing.js` 里躺了很久，注释写着"留给将来"）。
  //
  // ## 为什么是"临时打开"而不是"永久打开"
  //
  // 永久打开 = `MC_ALLOW_DIG=true`，代价是**她会顺手拆掉玩家的建筑**
  // （实测过：`cluttered:antique_mini_table` 这类模组装饰方块名一个模式都不中，
  //   `blocksCantBreak` 那层形同虚设，被拆过两格）。
  // 而"被困"是一个**可判定的状态**（`No path` / `Stuck` + 原地不动），
  // 所以放行可以是**窄口径**的：只在确认被困时，只放行这一趟。
  //
  // ## 参数
  //   · `x` `y` `z` —— 目标（必填，与 `/move` 同样的语义）
  //   · `reason` —— 可选，调用方为什么认为她被卡住了（**写进返回值，便于审计**）
  //   · `timeoutMs` —— 可选
  //
  // ## 返回
  //   · `escaped: true` —— 她**真的移动了**（用前后位置差判定，与 P44 同源）
  //   · `escaped: false` + `why` —— 打开 canDig 也没用（比如真被基岩围着）
  //   · `restored: true` —— **政策一定恢复**（`finally` 保证）
  'POST /unstick': async ({ x, y, z, reason, timeoutMs = 20000 } = {}) => {
    if (x === undefined || z === undefined) throw new Error('x and z required');
    const mv = state.bot.pathfinder?.movements;
    if (!mv) throw new Error('pathfinder 没装 —— 没有寻路器可自救');

    const origin = state.bot.entity?.position;
    const before = origin ? { x: origin.x, y: origin.y, z: origin.z } : null;
    // 记下**放行前**的 canDig —— 恢复时要用原值，不能硬写 false
    //（万一将来全局政策改成 true，这里硬写 false 就把它悄悄改窄了）。
    const canDigBefore = !(mv.exclusionAreasBreak || []).some(f => f.__leavesOnly) && !!mv.canDig;   // 只拆树叶时 canDig 也是 true，要看有没有 leavesOnly 才知道原来是不是"不拆"

    let escaped = false;
    let why = null;
    let arr = null;
    try {
      // ★ 单次放行。`applyPolicy` 会把 canDig 之外的一整套防护也重新套一遍
      //   （fluidCost / blocksCantBreak / allow1by1towers=false 等），
      //   所以走它比自己写 `mv.canDig = true` 安全得多 —— 后者会把
      //   "不许垫方块上塔"也一起改掉。
      pathing.applyPolicy(mv, state.bot.registry?.blocksByName, { allowDig: true });
      const goal = y !== undefined ? new goals.GoalBlock(+x, +y, +z) : new goals.GoalXZ(+x, +z);
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
      arr = await withTimeout(state.bot.pathfinder.goto(goal), Math.min(Math.max(3000, +timeoutMs), 120000));
      void arr;
    } catch (e) {
      why = e.message;
    } finally {
      // ★★ **恢复是强制的，而且必须在 finally 里** —— 中途 return / 抛错都不能漏。
      //    漏掉的后果很严重：一整套"只绕不拆"的防护静默失效，之后她会开始拆建筑，
      //    而现场**看不出任何异常**（没有任何日志说政策变了）。
      pathing.applyPolicy(mv, state.bot.registry?.blocksByName, { allowDig: canDigBefore });
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
    }

    const now = state.bot.entity?.position;
    const moved = (before && now)
      ? Math.hypot(now.x - before.x, now.y - before.y, now.z - before.z)
      : null;
    // 判据与 P44 同源：**世界真的变了才算逃出来**。
    // ⚠️ 用 0.5 格作阈值 —— `GoalBlock` 只要求"在格内"，站到格边缘也算动了；
    //    但 0.5 格以下的变化在实战里就是"抖动"，不能算脱困。
    escaped = moved !== null && moved > 0.5;

    return {
      escaped,
      moved: moved === null ? null : Math.round(moved * 1000) / 1000,
      from: before && { x: +before.x.toFixed(2), y: +before.y.toFixed(2), z: +before.z.toFixed(2) },
      to: now && { x: +now.x.toFixed(2), y: +now.y.toFixed(2), z: +now.z.toFixed(2) },
      canDigRestored: (mv.exclusionAreasBreak || []).some(f => f.__leavesOnly) === !canDigBefore,
      reason: reason || null,
      why: escaped ? undefined : (why || '打开了 canDig 也走不动 —— 可能真被封死了'),
      hint: escaped
        ? undefined
        : '考虑 POST /mine 直接挖脚边一格（那条路径不经过寻路器，不受 canDig 影响）',
    };
  },

  'POST /command': async ({ command }) => {
    if (!command) throw new Error('command field required');
    const BLOCKED_COMMANDS = /^\/?(?:op|deop|stop|ban|ban-ip|pardon|kick|whitelist|save-off|save-all|save-on|reload|restart)\b/i;
    if (BLOCKED_COMMANDS.test(command.trim())) {
      throw new Error(`Command blocked for safety: "${command}". Use minecraft-server-admin / RCON for server administration.`);
    }
    const cmd = command.startsWith('/') ? command : `/${command}`;
    state.bot.chat(cmd);
    return { executed: cmd };
  },

  'POST /move': async ({ x, y, z }) => {
    if (x === undefined || z === undefined) throw new Error('x and z required');
    const COORD_LIMIT = 30_000_000;
    if (Math.abs(+x) > COORD_LIMIT || Math.abs(+z) > COORD_LIMIT || (y !== undefined && Math.abs(+y) > 320)) {
      throw new Error(`Coordinates out of range (max ±${COORD_LIMIT} XZ, ±320 Y)`);
    }
    state.currentAction = `moving to ${x},${y ?? '?'},${z}`;
    // ⚠️⚠️⚠️ P44（2026-09-25 实机抓出）：**记下出发位置** —— 这是这个端点的
    //    "世界真的变了"的证据，和 `/pickup` 的背包差（P32）同理。
    //
    //    【症状】`POST /move {"x":-8,"y":86,"z":-8}` 返回
    //      `{"success":true,"arrived":{"x":-8,"y":86,"z":-8},"route":{"source":"pending"}}`
    //      而紧接着 `GET /position` → `exact = (-7.67, 86, -7.51)` **纹丝未动**。
    //
    //    【根因 —— 不是谎报，是**语义歧义**，但对调用方同样是致命的】
    //      目标 `GoalBlock(-8,86,-8)` 的 `isEnd()` 只要求"她在这一格**内**"，
    //      不要求"到格中心"。而她 `exact = (-7.67, 86, -7.51)` 的格归属
    //      `floor(-7.67) = -8`、`floor(-7.51) = -8` —— **她已经在了**。
    //      于是 `goal_reached` **立刻**触发 → `res()` → 返回 `success: true`。
    //
    //      严格说这个 `success` 是**对的**（她的确在 (-8,86,-8)），
    //      但调用方（autopilot）拿到 `success: true` 会以为"她动过了" ——
    //      于是任何"先 /move 靠近、再做事"的链路**全部静默失效**。
    //      这正是 P32/P35/P41 那个家族的症状（上层基于 ok 的机制失效），
    //      只是成因从"谎报"变成了"契约没写清"。
    //
    //    【修法】**把位移量写进返回体**，让调用方能区分两种"到了"：
    //      · `moved ≈ 0` → "本来就在这一格，我没动"（调用方要自己决定够不够）
    //      · `moved > 0` → "真的走过去/下去/爬上去了"
    //      再加上 `wasInside`（出发时就已经在目标格里）—— 一眼看清是哪种。
    //      **不改变 `success` 的语义**（它仍是"到达了"），只补充证据。
    //      这样既不破坏现有调用方，又给了新调用方区分的能力。
    const originForMove = state.bot.entity?.position;
    const originSnap = originForMove
      ? { x: originForMove.x, y: originForMove.y, z: originForMove.z }
      : null;
    const goal = y !== undefined ? new goals.GoalBlock(+x, +y, +z) : new goals.GoalXZ(+x, +z);
    const onGoal = () => { state.bot.removeListener('path_update', onPath); res(); };
    const onPath = (e) => { if (e.status === 'noPath') { state.bot.removeListener('goal_reached', onGoal); rej(new Error('No path found')); } };
    let res, rej;
    const done = new Promise((a, b) => { res = a; rej = b; });

    // ⚠️ 这一段必须 try/finally。原来的写法在**超时/无路**时三样东西全漏：
    //   1. `pathfinder.setGoal(null)` 没被调用 → 目标一直挂着，寻路器**继续驱动她的身体**；
    //   2. `state.currentAction` 停在 "moving to …" → 看门狗与审计看到的是错的状态；
    //   3. 两个事件监听器留着 → 下一次 /move 会叠加监听。
    //
    // 第 1 条最要命：它会和 `POST /control` **抢同一个身体**。现象极具误导性 ——
    // 按住 W 位移≈0、连 jump 都不动，看起来像"她卡住了/物理层坏了"，
    // 其实是两个写入者每个 tick 互相覆盖。实测过一次，排查了很久。
    // 身体的唯一性见设计规则 8：行动不能并行。
    //
    // ---- 超时：从"固定 30s"改成"按路径预估"（2026-09-25）------------------------
    //
    // 旧写法是 `withTimeout(done)` 用全局固定值。问题见 pathing.js「单次寻路的超时
    // 与停滞检测」一节的完整说明，一句话：走 3 格和走 60 格用同一个数字，
    // 近距离白等、远距离被砍。
    //
    // 现在：路径算出来后按节点类型估时 → `eta*2 + 10s`，钳在 30s~300s。
    // 路径还没出来时先给下界 30s —— 正常服务器上 `path_update` 在几十毫秒内就有，
    // 30 秒还没路径基本就是没路，不该等更久。
    //
    // ⚠️ 停滞检测是**并联**的第二个退出条件，不能只有超时：
    //    顶着墙角站位时"总时长"一直没到，但她其实一步没往前走。
    //    每 5s 看一眼有没有实质进展，连续 3 次没有就放弃。
    const budget = { timeoutMs: pathing.PATH_MIN_TIMEOUT_MS, etaMs: null, source: 'pending' };
    let stagnation = null;
    let stagnationTimer = null;
    let replans = 0;

    const onPathUpdate = (e) => {
      // 路径每次重算都重新估时。寻路器会在遇到障碍时重规划，
      // 用第一次的 ETA 会低估（第一条路径往往更乐观）。
      try {
        const est = pathing.estimatePathTimeMs(e?.path);
        const t = pathing.computeTimeoutFromEta(est);
        if (t.etaMs !== null) {
          budget.timeoutMs = t.timeoutMs;
          budget.etaMs = t.etaMs;
          budget.source = t.source;
          replans++;
        }
      } catch (_) { /* 估时失败不该影响移动本身 */ }
    };

    try {
      state.bot.pathfinder.setGoal(goal);
      state.bot.once('goal_reached', onGoal);
      state.bot.on('path_update', onPath);
      state.bot.on('path_update', onPathUpdate);

      // 停滞检测：拿到起点才能算"有没有真的在动"。拿不到就退化成纯超时。
      const origin = state.bot.entity?.position;
      if (origin) {
        stagnation = pathing.createStagnationMonitor(
          { x: origin.x, y: origin.y, z: origin.z },
        );
        stagnationTimer = setInterval(() => {
          const v = stagnation.sample(state.bot.entity?.position);
          if (v.exhausted) {
            clearInterval(stagnationTimer);
            stagnationTimer = null;
            try { state.bot.pathfinder.stop(); } catch (_) {}
            rej(new Error(
              `Stuck: no meaningful progress for ${v.stagnant} checks `
              + `(~${(v.stagnant * pathing.PATH_PROGRESS_INTERVAL_MS) / 1000}s, `
              + `${v.moved} blocks since last check)`,
            ));
          }
        }, pathing.PATH_PROGRESS_INTERVAL_MS);
      }

      // 超时随预算走。`withTimeout` 只接受一个固定值，而预算会随重规划上调，
      // 所以这里自己起一个看门狗：每隔一段检查一次，**预算变大了就续期**。
      // 比"直接传最大上界"更省时间 —— 近路仍然会在短预算内就认输。
      //
      // ⚠️ 续期判据用"预算数值有没有变"，不要用 "deadline 是否相等" ——
      //    我第一版就是后者，而 `deadline()` 每次都返回新的时间戳，
      //    那个比较**恒为 false**，等于永远不会续期（远路会被误砍）。
      let limit = Date.now() + budget.timeoutMs;
      let lastBudget = budget.timeoutMs;
      const watchdog = setInterval(() => {
        if (budget.timeoutMs > lastBudget) {
          lastBudget = budget.timeoutMs;
          limit = Date.now() + budget.timeoutMs;   // 重规划给出更长的预估 → 续期
          return;
        }
        if (Date.now() >= limit) {
          clearInterval(watchdog);
          rej(new Error(`Timeout: exceeded ${budget.timeoutMs}ms (eta ${budget.etaMs ?? '?'}ms)`));
        }
      }, Math.max(1000, Math.floor(pathing.PATH_PROGRESS_INTERVAL_MS / 2)));

      try {
        await done;
      } finally {
        clearInterval(watchdog);
      }
      const now = state.bot.entity?.position;
      // ---- P44：把"她到底动了没有"如实写出来 ----
      // 每格中心在 `n + 0.5`，所以她落在格 (x,z) 内 ⟺ `floor(px) === x`。
      // 出发时如果就已经在目标格内，那 `goal_reached` 是**立刻**触发的，
      // 本次调用**没有产生任何位移** —— 这正是 P44 那个"success 却纹丝未动"。
      const destX = Math.floor(+x), destZ = Math.floor(+z);
      const wasInside = !!originSnap
        && Math.floor(originSnap.x) === destX
        && Math.floor(originSnap.z) === destZ
        && (y === undefined || Math.floor(originSnap.y) === Math.floor(+y));
      const moved = (originSnap && now)
        ? Math.hypot(now.x - originSnap.x, now.y - originSnap.y, now.z - originSnap.z)
        : null;
      return {
        arrived: botPos(),
        // ★ 新增（P44）：调用方区分"本来就在"和"真的走过去了"的唯一依据。
        moved: moved === null ? null : Math.round(moved * 1000) / 1000,
        wasInside,
        note: wasInside
          ? '出发时就已在目标格内 —— 本次没有产生位移（目标已满足）'
          : undefined,
        route: { etaMs: budget.etaMs, timeoutMs: budget.timeoutMs, replans, source: budget.source },
      };
    } finally {
      if (stagnationTimer) clearInterval(stagnationTimer);
      state.bot.removeListener('goal_reached', onGoal);
      state.bot.removeListener('path_update', onPath);
      state.bot.removeListener('path_update', onPathUpdate);
      // 到达时清掉是无害的（目标已完成）；失败时清掉才是关键 —— 把身体交还给调用方。
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
      state.currentAction = null;
    }
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.botPos !== undefined) botPos = ns.botPos;
  if (ns.sameItem !== undefined) sameItem = ns.sameItem;
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
  keys: ["POST /drop","POST /unstick","POST /command","POST /move"],
  bind,
  rebind,
 };
