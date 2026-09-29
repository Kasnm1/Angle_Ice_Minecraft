'use strict';

/**
 * 单次寻路的超时与停滞 —— 固定超时对"远一点的目标"必然误杀，对"一步之遥"又白等。
 * 这里按**路径估算的 ETA** 算超时（`estimatePathTimeMs` / `computeTimeoutFromEta`），
 * 再给一个**硬上限**（`computeHardCap`），并用 `createStagnationMonitor` 判"卡住了"。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

// ------------------------------------------------------------------ 单次寻路的超时与停滞
//
// ## 为什么需要这一节
//
// `bot.pathfinder.goto(goal)` **自己不设超时**。它要么到达、要么明确报
// `No path to the goal!`，要么就永远挂着 —— 而最后一种在真实服务器上很常见：
// 目标点被围住、寻路器算出一条永远走不通的路径、或者服务器在该 tick 卡了一下。
//
// 我们原来的做法是给**整个 HTTP 请求**套一个固定 45s 超时。两个问题：
//   ① 走 3 格和走 60 格用同一个数字。近距离时白等 45 秒才认输；
//      远距离时 45 秒又不够，明明在稳步靠近却被砍掉。
//   ② 它只看总时长，**看不出"还在动"还是"已经卡住"**。顶着墙角站位
//      和正常赶路在固定超时眼里没有区别。
//
// ## 抄什么（对标 HiyoriAI 的 `patchedGoto.ts`）
//
// HiyoriAI 的做法是两层：
//   ① **按路径预估耗时**（`estimatePathTimeMs`）→ `timeout = max(30s, min(300s, eta*2 + 10s))`
//      —— 用节点类型逐段累加（挖 1.5s / 放 0.5s / parkour 1.0s / 跳 0.6s / 直走按速度）
//   ② **每 5s 检查一次有没有真的在靠近**，连续 3 次没有实质进展就直接放弃
//
// 我们照抄这两层，但**把常量重新定过**：HiyoriAI 的 `GRACE_FACTOR=2.0` 给的是
// "允许比预估慢一倍"，实测在模组服（TPS 低）上仍然偏紧。
//
// ## 与 autopilot 的 `stuckTicks` 是两层，不是重复
//
// `autopilot.stuckTicks`（14 tick ≈ 21s）看的是**跨动作**的位置不动，
// 用来发现"整段行为卡死"；这一节看的是**单次 goto 内部**的路径进展。
// 一个反例：`goto` 每次都在 20 秒时被 autopilot 超时砍掉，然后重新发起 ——
// 位置有轻微抖动，`stuckTicks` 永远不触发，但这件事永远做不成。
// 停滞检测能抓住它（路径没在缩短），`stuckTicks` 抓不住。

/** 各动作类型的**悲观**单步耗时（毫秒）。刻意取悲观值 —— 超时宁长勿短。 */
const PATH_STEP_MS = {
  walk: 0,          // 直走按速度算，见 estimatePathTimeMs
  jump: 700,        // 跳跃本身 + 落地缓冲（HiyoriAI 是 600，模组服多给 100）
  parkour: 1100,    // 跳 3 格空隙（HiyoriAI 是 1000）
  place: 600,       // 放一个方块当桥（HiyoriAI 是 500）
  dig: 1800,        // 拆一格（HiyoriAI 是 1500 —— 模组方块硬度普遍更高）
};

/** 疾跑速度（格/秒）。原版疾跑 5.612，取 5.6 与 HiyoriAI 一致。 */
const SPRINT_SPEED = 5.6;

/** 预估之外的宽限系数。2.0 = 允许比预估慢一倍。 */
const PATH_GRACE_FACTOR = 2.0;
/** 固定附加宽限（毫秒）—— 覆盖"起步、转向、服务器卡一下"的固定开销。 */
const PATH_BASE_GRACE_MS = 10000;
/** 超时上下界。 */
const PATH_MIN_TIMEOUT_MS = 30000;
const PATH_MAX_TIMEOUT_MS = 300000;

/** 停滞检测：多久检查一次、一小步算多少格、连续几次算放弃。 */
const PATH_PROGRESS_INTERVAL_MS = 5000;
/** 一次检查里"离目标更近了多少格"低于这个数，视为没有实质进展。 */
const PATH_STAGNATION_THRESHOLD = 1.5;
/** 连续多少次没有进展就放弃。 */
const MAX_STAGNANT_CHECKS = 3;

/**
 * 续期倍率 —— 一次 goto 的总时限最多能涨到初始预算的几倍。
 * 见 `computeHardCap` 的说明（P9：续期必须有头）。
 */
const PATH_RENEW_FACTOR = 3;

/**
 * 把 pathfinder 清回"没有目标"的状态。
 *
 * ## 为什么这是个**必须显式做**的动作（P25，2026-09-25 实战）
 *
 * `pathfinder.goto(goal)` 返回的 promise 在超时/被放弃时，**那个 goal 仍然留在
 * pathfinder 上**。这不是 bug，是 `goto` 的语义：它只是"等这次寻路结束"，
 * 而"结束"的定义是 Goal 的 `isEnd()` 成立。调用方不等了 ≠ 寻路器不跑了。
 *
 * 后果非常隐蔽：
 * ```
 * await race(goto(goalA), sleep(6000));   // sleep 赢了，goalA 还在跑
 * await goto(goalB);                      // → "The goal was changed before
 *                                         //    it could be completed!"
 * ```
 * 报错信息读起来像"我们自己换了目标"，实际是"上一个目标没清干净"。
 * 实测到它时的现象是「地上 9 个掉落物，`walkedTo: 2`」——
 * 看起来像"寻路有点慢"，实际是第 3 个之后**全部秒失败**。
 *
 * ## 为什么 stop() 和 setGoal(null) 都要调
 *
 * `stop()` 掐断当前正在执行的路径（清掉 `path` 与计时器），
 * `setGoal(null)` 清掉目标本身。只调其中一个会留下半个状态：
 * 只 `stop()` 的话，下一轮 `goto` 仍会看到旧 goal 而抛错；
 * 只 `setGoal(null)` 的话，那条正在跑的路径可能还在推进。
 *
 * 两者都包在 try 里：pathfinder 插件可能没装，或 bot 正断开 ——
 * **清理失败不该让主流程失败**，那只会把一个可恢复的小问题升级成任务失败。
 *
 * @param {object} pf  mineflayer-pathfinder 插件实例（`bot.pathfinder`）
 * @returns {boolean}  是否至少成功执行了一次清理（用于自测与诊断）
 */
function clearPathfinderGoal (pf) {
  if (!pf) return false;
  let did = false;
  try { pf.stop(); did = true; } catch (_) {}
  try { pf.setGoal(null); did = true; } catch (_) {}
  return did;
}

/**
 * 寻路目标的**所有者登记簿** —— 修「挖矿 goto 自己跟自己打架」（N-1 / P-1）。
 *
 * ## 症状（实机，`bridge.log`）
 *
 * `[goto] mine stone 开始：…` 之后立刻 `[goto] mine stone 结束：The goal was changed
 * before it could be completed!`，81 次里 80 次。而「续期」那套（`renewals`）**一次都没
 * 触发**（成功那几次全是 `成功到达（续期 0 次）`）—— 说明**不是续期自己打断自己**，
 * 是**别人**在 goto 进行中调了 `setGoal`。
 *
 * ## 是谁（证据链，见报告）
 *
 * `pathfinder.setGoal(goal)` 会 `emit('goal_updated', goal)`（库 `index.js:142-147`），
 * 而 `goto()` 的 `goalChangedListener`（库 `lib/goto.js:32-36`）只要看到
 * `newGoal !== goal` 就立刻以 `GoalChanged` 结束这次 goto。所以**任何**在 goto 期间
 * 的 `setGoal` 都会把它打死，包括：
 *   · `cancelCommands()`（`bridge-server.js:1233`）无条件 `setGoal(null)` ——
 *     它被本能层的 250ms 定时器调：战斗 `checkCombat`（`instinct.js:1777`）、
 *     危险方块 `checkHazard`（`instinct.js:2028`）；
 *   · `fight()` 自己那几处 `setGoal`（`instinct.js:1793/1804/1811/1826/1830`）。
 *
 * 关键是：**这些"换目标"里有一部分是"我们自己要收手"**（取消/让出身体），
 * 不是"任务失败了"。旧代码把两者混成同一句 `GoalChanged` 抛给上层，
 * 上层（`/mine` 循环、`go()` 的 5 级重试）又据此整条链重试 —— 于是"重新规划"吞掉了挖矿。
 *
 * ## 这个登记簿解决什么
 *
 * 一次 goto 开始前 `begin(token)` **取得所有权**；期间记下"这次 goal 变更是不是我们自己
 * 发起的"（`noteSelfChange`）。goto 结束时用 `classify` 判断：
 *   · 被**外部**换掉（别人 setGoal）→ `external`，应如实报失败；
 *   · 被**自己**取消（cancelCommands / abort）→ `selfAbort`，**不算失败**，
 *     应转成有序中止，且**不让上层重试整条链**。
 *
 * 设计成纯状态机（不碰 bot/pathfinder），所以能离线自测。
 *
 * @returns {object} 登记簿
 */
function createGoalOwner () {
  let current = null;      // 当前持有者 token
  let selfChange = false;  // 最近一次目标变更是不是"自己人"发起的
  let selfChanges = 0;
  let externalChanges = 0;
  let begins = 0;
  let refused = 0;         // 被拒的 begin 次数（并发争用时才 >0）

  return {
    /**
     * 取所有权。**真正的互斥锁**：已有持有者时**不抢占**，直接拒绝。
     *
     * ⚠️ 2026-09-28 审计（codex fix2 #3）：原来 `begin()` **无条件覆盖**
     *    `current = { id: ++begins }` —— 名叫"互斥锁"实际只是"计数 + 换 owner"。
     *    后果：两个并发 goto 都能 `begin()` 成功，但只有后一个的 token 是
     *    `current`；先一个结束时 `classify` 会判 `stale`，它的 self/external 归因
     *    全丢、`hasOwner` 也被后一个提前清掉 —— owner 统计与归因错配。
     *    当前主要靠外层 `bodyCommandLock` 挡着，但直接调用 / `/stop` / 内部动作
     *    仍可能绕过它（正是审计指出的路径）。
     *    现在：已有 owner 时返回 `null`（调用方**必须**检查返回值）。
     *
     * @returns {object|null} token；已有人持有时为 null（调用方应放弃本次 goto）
     */
    begin () {
      if (current !== null) { refused++; return null; }
      begins++;
      current = { id: begins, startedAt: Date.now() };
      selfChange = false;
      return current;
    },
    /** 这次目标变更是我们自己发起的（取消 / 换自己的目标）。 */
    noteSelfChange () { selfChange = true; selfChanges++; },
    /** 这次目标变更是**外部**发起的（别人 setGoal / movements 变更等）。 */
    noteExternalChange () { externalChanges++; },
    /** 当前有没有人在持有。 */
    hasOwner () { return current !== null; },
    /** 当前持有者 token（自测/诊断用）。 */
    owner () { return current; },
    /**
     * 结束一次持有，并判定它是怎么结束的。
     * @param {object} token  begin() 返回的 token
     * @param {string} errName  放弃时的错误名（'GoalChanged' / 'PathStopped' / 'Timeout' …）
     * @returns {{reason:'ok'|'selfAbort'|'external'|'stale', selfInitiated:boolean}}
     */
    classify (token, errName) {
      const mine = current && token && current.id === token.id;
      const selfInitiated = mine && selfChange;
      if (mine) current = null;
      // ⚠️ 与 classifyGotoOutcome 同口径（codex fix2 #1）：`null` 才是"没出错"，
      //    读不到错误名（undefined/空串）保守不算成功。
      if (errName === null || errName === undefined) {
        return { reason: mine ? 'ok' : 'stale', selfInitiated };
      }
      if (!String(errName)) return { reason: mine ? 'external' : 'stale', selfInitiated };
      if (!mine) return { reason: 'stale', selfInitiated };   // 已经不是当前持有者了
      if (selfInitiated) return { reason: 'selfAbort', selfInitiated: true };
      return { reason: 'external', selfInitiated: false };
    },
    stats () {
      return { begins, selfChanges, externalChanges, hasOwner: current !== null, refused };
    },
  };
}

/**
 * 一个"目标被换掉"的错误，到底算不算**任务失败**。
 *
 * 这是 N-1 的核心判据，单独抽出来是因为**上层要据此决定"重不重试整条链"** ——
 * 见 `gotoWithBudget` 的返回与 `/mine` 循环。
 *
 *   · `'aborted'` —— 我们自己收手（取消/让出身体）。**不是失败**：
 *     不报错、不计失败、上层不该重试（重试 = 拿已经作废的任务再跑一遍）。
 *   · `'ok'`      —— **只有调用方明确说"没出错"**（`errName` 严格为 `null`）才是 ok。
 *   · `'failed'`  —— 真的没走成（别人抢了目标、超时、卡住）。
 *
 * ⚠️⚠️ 2026-09-28 审计（codex fix2 #1）：**"读不到错误名"改判 `failed`**。
 *
 *    原来 `if (!errName) return 'ok'` —— `!errName` 同时涵盖了 `null`（明确没出错）
 *    与 `undefined`（**读不到**，`e?.name` 缺失）。于是 `catch` 里一个没有 `name`
 *    的异常（`classifyGotoOutcome(undefined, true)`）会被判成 `ok`，
 *    `gotoWithBudget` 随后不设 `failure` → **异常路径被当成成功返回**，
 *    `/collect` 等调用方误以为"已到达"。这与上面注释声称的"读不到时保守按失败"相反。
 *
 *    现在把两者分开：
 *      · `null`      → 调用方明确表示"这次没出错" → `'ok'`
 *      · `undefined` / `''` / 其他读不到 → 证据不足 → `'failed'`（AGENTS §5）
 *      · `'PathStopped'` + 自己发起 → 同 `GoalChanged` 一样算 `'aborted'`
 *        （库在 `stop()` 里可能报这个，也是我们自己收手）
 *
 * @param {string|null} errName    错误名（`null` = 明确没出错）
 * @param {boolean} selfInitiated  这次目标变更是否我们自己发起
 * @returns {'ok'|'aborted'|'failed'}
 */
function classifyGotoOutcome (errName, selfInitiated) {
  if (errName === null || errName === undefined) {
    // 明确传 null（调用方知道没出错）→ ok；读不到（undefined）→ 保守按失败
    return errName === null ? 'ok' : 'failed';
  }
  const name = String(errName);
  if (!name) return 'failed';   // 空字符串也是"读不到"
  const goalChanged = name === 'GoalChanged' || name === 'PathStopped';
  if (goalChanged && selfInitiated) return 'aborted';
  return 'failed';
}

/**
 * 兜住 mineflayer-pathfinder 在 `physicsTick` 里的崩溃（实机 `bridge.log` 33155 行）。
 *
 * ## 为什么会杀掉整个进程
 *
 * `physicsTick` 由 `setInterval` 驱动（`mineflayer/lib/plugins/physics.js:489`），
 * 而 pathfinder 的 `monitorMovement` 是直接挂在上面的监听（`index.js:166`）。
 * 监听里抛出的异常会沿着 `bot.emit` 的同步栈一路冒到定时器回调 —— **没人 catch** →
 * Node 进程退出。一次开门就能终结整场游戏。
 *
 * ## 抛的是什么（库 `index.js:510-545`）
 *
 * `if (placing || nextPoint.toPlace.length > 0)` 分支里，
 * `placingBlock = nextPoint.toPlace.shift()` 可能取到 `undefined`（队列空），
 * 而后面仍读 `placingBlock.y`（第 538 行）→ `Cannot read properties of undefined (reading 'y')`。
 * 库内部 `placing` 是闭包变量，我们在外面**够不到** —— 所以只能兜异常，不能修状态。
 * *不改 node_modules*（Windows 是 npm 装的，改了不会同步）。
 *
 * ## 做法
 *
 * 把 `physicsTick` 上的 pathfinder 监听换成**带 try-catch 的包装**：
 * 崩了记一行、清干净寻路状态、**继续跑**（下一 tick 重新规划）。
 *
 * 判据是"这条监听来自 pathfinder"。**2026-09-28 审计（codex fix2 #4）改了识别方式**：
 *
 *   原来是纯 `toString()` 源码包含 `monitorMovement` / `mineflayer-pathfinder` ——
 *   宽松，可能把**别的插件**里恰好同名的监听也误包进去、吞掉它的异常
 *   （违反"只兜 pathfinder 那条"）。而且自测里给假函数挂自定义 `toString`
 *   对 `Function.prototype.toString.call(fn)` 根本不起作用，测试覆盖是假的。
 *
 *   现在按**可靠性分层**识别，优先用安装时登记的真身份：
 *     ① `opts.isPathfinderListener(fn)` —— 调用方（bridge）在 `loadPlugin` 之后
 *        用 pathfinder 插件自己导出的监听引用登记进来。**最可靠**，命中即认定。
 *     ② `fn.__pfMonitor === true` —— 若上游/我们给监听打过标记。
 *     ③ 源码判据**收紧**：必须**同时**出现 `monitorMovement` **且**出现
 *        `pathfinder`（模块名或其路径片段），而不是任一命中。
 *   三层都不中 → **不假装装上**（返回 `installed:false` + 原因，AGENTS §5）。
 *
 * @param {object} bot          真 bot（EventEmitter）
 * @param {object} [opts]       { onError(err), label, isPathfinderListener(fn) }
 * @returns {{installed:boolean, wrapped:number, reason?:string}}
 */
function installPhysicsTickGuard (bot, opts = {}) {
  try {
    if (!bot || typeof bot.rawListeners !== 'function') {
      return { installed: false, wrapped: 0, reason: '不是 EventEmitter' };
    }
    if (bot.__pfCrashGuard) return { installed: true, wrapped: bot.__pfCrashGuard.wrapped, reason: '已装过' };
    const raw = bot.rawListeners('physicsTick') || [];
    const isPfMovement = (fn) => {
      // ① 调用方登记的权威身份（最可靠）
      try { if (typeof opts.isPathfinderListener === 'function' && opts.isPathfinderListener(fn)) return true; } catch (_) {}
      // ② 上游/我们打的标记
      if (fn && fn.__pfMonitor === true) return true;
      // ③ 源码判据（收紧：两个关键词都要在，避免误包别的插件）
      try {
        const src = Function.prototype.toString.call(fn);
        return /monitorMovement/.test(src) && /pathfinder/i.test(src);
      } catch (_) { return false; }
    };
    const victims = raw.filter(isPfMovement);
    if (!victims.length) return { installed: false, wrapped: 0, reason: '没找到 pathfinder 的 physicsTick 监听' };

    bot.removeAllListeners('physicsTick');
    let wrapped = 0;
    for (const fn of raw) {
      if (!isPfMovement(fn)) { bot.on('physicsTick', fn); continue; }
      bot.on('physicsTick', function guardedPhysicsTick (...args) {
        try {
          return fn.apply(this, args);
        } catch (err) {
          try { opts.onError?.(err); } catch (_) {}
          try { bot.pathfinder.stop(); } catch (_) {}
          try { bot.pathfinder.setGoal(null); } catch (_) {}
          try { bot.clearControlStates(); } catch (_) {}
        }
      });
      wrapped++;
    }
    bot.__pfCrashGuard = { wrapped };
    return { installed: true, wrapped };
  } catch (e) {
    return { installed: false, wrapped: 0, reason: e.message };
  }
}

/** 按 cost 量级归类这一步属于哪种移动。判据见 `stepCostMs` 的说明。 */
function stepKind (cost) {
  if (!Number.isFinite(cost) || cost <= 0) return 'walk';
  if (cost >= 4) return 'dig';
  if (cost >= 2.5) return 'place';
  if (cost >= 2.2) return 'parkour';
  if (cost >= 1.6) return 'jump';
  return 'walk';
}

/**
 * 把一个路径节点映射成"这一步要花多久"。
 *
 * 之所以不 import pathfinder 的常量而是手写：这些数字是**策略**不是**事实**，
 * 而且我们要能随着"玩家抱怨走太慢/走太久"单独调，不想被动跟着上游改。
 *
 * @param {object} node      pathfinder 的 Move 实例（有 `cost` 字段）
 * @returns {number} 毫秒
 */
function stepCostMs (node) {
  const cost = Number(node?.cost);
  const kind = stepKind(cost);
  if (kind !== 'walk') return PATH_STEP_MS[kind];
  // 直走：cost 通常是 1（正交）或 √2（对角）。
  // 这里要的是量级，不是精确值，所以只区分"斜着"和"正着"。
  const dist = cost >= 1.4 ? Math.SQRT2 : 1;
  return Math.round((dist / SPRINT_SPEED) * 1000);
}

/**
 * 按路径预估走完要多久。
 *
 * @param {Array} path  pathfinder 路径（节点数组）；空/无效返回 null
 * @returns {{etaMs:number, steps:number, breakdown:object}|null}
 */
function estimatePathTimeMs (path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  const breakdown = { walk: 0, jump: 0, parkour: 0, place: 0, dig: 0 };
  let total = 0;
  for (const node of path) {
    const ms = stepCostMs(node);
    breakdown[stepKind(Number(node?.cost))] += ms;
    total += ms;
  }
  return { etaMs: total, steps: path.length, breakdown };
}

/**
 * 由预估耗时推导这次 goto 该给多少超时。
 *
 * 公式抄 HiyoriAI：`max(MIN, min(MAX, eta * GRACE + BASE))`。
 * 路径拿不到（null）时给 MIN —— 拿不到路径说明这次多半会很快报"无路"，
 * 没必要等满。
 *
 * @param {object|null} est estimatePathTimeMs 的返回值
 * @param {object} [opts] { minMs, maxMs, grace, baseMs }
 * @returns {{timeoutMs:number, etaMs:number|null, source:string}}
 */
function computeTimeoutFromEta (est, opts = {}) {
  const minMs = opts.minMs ?? PATH_MIN_TIMEOUT_MS;
  const maxMs = opts.maxMs ?? PATH_MAX_TIMEOUT_MS;
  const grace = opts.grace ?? PATH_GRACE_FACTOR;
  const baseMs = opts.baseMs ?? PATH_BASE_GRACE_MS;
  if (!est || !Number.isFinite(est.etaMs)) {
    return { timeoutMs: minMs, etaMs: null, source: 'no-path' };
  }
  const raw = est.etaMs * grace + baseMs;
  const clamped = Math.max(minMs, Math.min(maxMs, raw));
  return { timeoutMs: Math.round(clamped), etaMs: est.etaMs, source: 'eta' };
}

/**
 * 算出一次 goto 的**绝对上限**，以及它能被续期几次。
 *
 * ## 为什么需要这个（P9，2026-09-25 实战）
 *
 * 原来的设计是"预算涨了就续期"，用意是好的：远距离路径的合理等待
 * 确实该随距离增长，一刀切成固定值会误砍正常的长途移动。
 *
 * **但它没有上限。** 而 `path_update` 会在"路径反复重规划"时高频触发 ——
 * 也就是**恰好在她卡住的时候**。每次重规划都让预算涨一点、watchdog 续一次期，
 * 于是超时永远不到期。实机表现：`POST /mine {count:1}` 跑了 **150 秒**不返回，
 * 而配置的 `PATH_MIN_TIMEOUT_MS` 是 30 秒。
 *
 * > 一个能无限续期的超时，**等于没有超时**。
 *
 * ## 上限怎么取
 *
 * 取 `PATH_MAX_TIMEOUT_MS`（库里的 300s）与"初始预算 × 3"的较大者。
 * - 用 `×3` 而不是 `×1.5`：正常的重规划（绕过临时障碍）会续期一两次，
 *   不该被误判成"卡住"。
 * - 用 `max` 而不是 `min`：初始预算本来就小的近距路径（30s）
 *   不该把上限压到 90s —— 那对某些地形太紧。
 *
 * @param {number} initialTimeoutMs 初始预算
 * @param {object} [opts] 覆盖常量（自测用）
 * @returns {{hardCapMs:number, maxRenewals:number, reason:string}}
 */
function computeHardCap (initialTimeoutMs, opts = {}) {
  const maxMs = opts.maxMs ?? PATH_MAX_TIMEOUT_MS;
  const factor = opts.factor ?? PATH_RENEW_FACTOR;
  const base = Number.isFinite(initialTimeoutMs) && initialTimeoutMs > 0
    ? initialTimeoutMs
    : PATH_MIN_TIMEOUT_MS;
  const hardCapMs = Math.max(maxMs, base * factor);
  return {
    hardCapMs: Math.round(hardCapMs),
    // 能续期几次（**仅供参考**，真正的约束是 hardCapMs 这个时间上限）。
    // 暴露它是为了留痕："续了 40 次"比"超时了"更能说明她在原地打转。
    maxRenewals: Math.max(0, Math.round((hardCapMs - base) / Math.max(1, base * 0.2))),
    reason: `max(${maxMs}, ${base}×${factor}) = ${Math.round(hardCapMs)}ms`,
  };
}

/**
 * 停滞检测器 —— 一次 goto 生命周期内的状态机。
 *
 * 用法：
 *   const m = createStagnationMonitor({ x, y, z });
 *   const verdict = m.sample(bot.entity.position, Date.now());
 *   if (verdict.stagnant >= MAX) 放弃
 *
 * @param {object} origin 起点 {x,y,z}（用来算"总共前进了多少"）
 * @param {object} [opts] 覆盖常量，便于自测
 * @returns {{sample:Function, snapshot:Function}}
 */
function createStagnationMonitor (origin, opts = {}) {
  const interval = opts.intervalMs ?? PATH_PROGRESS_INTERVAL_MS;
  const threshold = opts.threshold ?? PATH_STAGNATION_THRESHOLD;
  const maxStagnant = opts.maxStagnant ?? MAX_STAGNANT_CHECKS;

  const start = { ...origin };
  let lastSampleAt = null;
  let lastPos = { ...origin };
  let bestDistance = null;     // 全程离起点最远的距离 —— 用来算"有没有真的往前走"
  let stagnant = 0;
  let checks = 0;

  const dist2d = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
  const dist3d = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));

  function sample (pos, now = Date.now()) {
    const p = { x: pos?.x ?? start.x, y: pos?.y ?? start.y, z: pos?.z ?? start.z };
    const travelled = dist3d(p, start);
    if (bestDistance === null || travelled > bestDistance) bestDistance = travelled;

    if (lastSampleAt === null) {
      lastSampleAt = now;
      lastPos = p;
      return { due: false, moved: 0, travelled, stagnant, checks, exhausted: false };
    }

    if (now - lastSampleAt < interval) {
      return { due: false, moved: dist3d(p, lastPos), travelled, stagnant, checks, exhausted: false };
    }

    // 到点了 —— 和**上一次采样点**比，而不是和起点比。
    // 和起点比会把"走了又绕回来"算成"一动不动"，那是错的：
    // 绕路是寻路的正常工作方式，不该被惩罚。
    const moved = dist3d(p, lastPos);
    checks++;
    if (moved < threshold) stagnant++; else stagnant = 0;
    lastSampleAt = now;
    lastPos = p;

    return {
      due: true,
      moved: Math.round(moved * 100) / 100,
      travelled: Math.round(travelled * 100) / 100,
      stagnant,
      checks,
      exhausted: stagnant >= maxStagnant,
    };
  }

  function snapshot () {
    return {
      origin: start,
      checks,
      stagnant,
      bestDistance: bestDistance === null ? null : Math.round(bestDistance * 100) / 100,
      intervalMs: interval,
      threshold,
      maxStagnant,
    };
  }

  return { sample, snapshot };
}

module.exports = {
  PATH_STEP_MS,
  SPRINT_SPEED,
  PATH_MIN_TIMEOUT_MS,
  PATH_MAX_TIMEOUT_MS,
  PATH_PROGRESS_INTERVAL_MS,
  PATH_STAGNATION_THRESHOLD,
  MAX_STAGNANT_CHECKS,
  clearPathfinderGoal,
  createGoalOwner,
  classifyGotoOutcome,
  installPhysicsTickGuard,
  stepKind,
  stepCostMs,
  estimatePathTimeMs,
  computeTimeoutFromEta,
  computeHardCap,
  createStagnationMonitor,
};
