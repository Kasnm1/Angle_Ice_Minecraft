/**
 * goto.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const instinct = require('../instinct/instinct.js');
const pathing = require('../world/pathing');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let state;

function DBG (...a) { return __ns.DBG.apply(null, a); }

async function gotoWithBudget (state, goal, opts = {}) {
  const budget = { timeoutMs: pathing.PATH_MIN_TIMEOUT_MS, etaMs: null };
  let replans = 0;

  // ---- 目标所有权（N-1：`mine stone` 81 次里 80 次以 GoalChanged 结束）--------
  //
  // `pathfinder.goto(goal)` 会在**任何** `setGoal(newGoal)` 且 `newGoal !== goal` 时
  // 立刻以 `GoalChanged` 结束（库 `index.js:142-147` emit → `lib/goto.js:32-36` 抛）。
  // 实机里换目标的**不是续期**（成功那几次都是 `续期 0 次`），而是**别人**在 goto
  // 期间调了 `setGoal(null)` —— 见报告的证据链：`cancelCommands()`（本文件 `:1233`）
  // 被本能层 250ms 的 `checkCombat`/`checkHazard`（`instinct.js:1777/2028`）调用。
  //
  // 那些解除里有一类**不是失败**：我们自己要收手（取消 / 让出身体给紧急本能）。
  // `opts.abort` 就是这件事的唯一判据 —— 它由路由层按"取消线"注入（本文件 `:6438`）。
  // 所以：出错时只要 `opts.abort()` 为真，这次 GoalChanged 就是**有序中止**，
  // 不是失败。上层据此**不重试整条链**（重试 = 拿作废的任务再跑一遍，就是 80/81）。
  const owner = state.__goalOwner || (state.__goalOwner = pathing.createGoalOwner());
  // ⚠️ 2026-09-28 审计（codex fix2 #3）：`begin()` 现在是**真互斥锁**，可能返回 null。
  //    已有 owner 时说明**另一次 goto 正在跑** —— 我们不能抢（抢了会让先一次的
  //    token 变 stale、归因错配）。如实拒绝，让调用方知道"此刻拿不到身体"。
  const token = owner.begin();
  if (!token) {
    const held = owner.owner();
    const heldMs = held?.startedAt ? Date.now() - held.startedAt : null;
    throw new Error(`GoalBusy: 已有一次寻路在跑${heldMs != null ? `（${heldMs}ms）` : ''}，本次不并发`);
  }
  const isAborted = () => {
    try { return typeof opts.abort === 'function' && !!opts.abort(); } catch (_) { return false; }
  };

  const onPathUpdate = (e) => {
    try {
      const est = pathing.estimatePathTimeMs(e?.path);
      const t = pathing.computeTimeoutFromEta(est);
      if (t.etaMs !== null) {
        budget.timeoutMs = t.timeoutMs;
        budget.etaMs = t.etaMs;
        replans++;
      }
    } catch (_) { /* 估时失败不该影响移动本身 */ }
  };

  // 记下"目标被谁换掉"：我们自己发起的（清路径 / 取消）与外部发起的要分开。
  // ⚠️ 只记不抛 —— 判定交给 classifyGotoOutcome，读不到证据时保守按失败。
  const onGoalUpdated = () => {
    if (isAborted()) owner.noteSelfChange();
    else owner.noteExternalChange();
  };

  const origin = state.bot.entity?.position;
  const monitor = origin
    ? pathing.createStagnationMonitor({ x: origin.x, y: origin.y, z: origin.z })
    : null;

  let stagnationTimer = null;
  let watchdog = null;
  let lastBudget = budget.timeoutMs;
  let limit = Date.now() + budget.timeoutMs;
  let settled = false;
  let rejectOuter = null;
  let failure = null;
  let released = false;

  // ⚠️⚠️⚠️ 绝对上限 —— 这是 P9 的修复（2026-09-25 实战抓出来的）。
  //
  // 症状：`POST /mine {count:1}` 跑了 **150 秒**不返回，
  //       而 `PATH_MIN_TIMEOUT_MS = 30000`（30 秒）本该早就放弃。
  //
  // 根因：watchdog 的续期判据是"`budget.timeoutMs` 比上次大就续期"。
  //       而 `onPathUpdate` 在每次 `path_update` 事件里都会**重新估算**路径耗时 ——
  //       `estimatePathTimeMs` 对"看起来更长"的路径给更大的值。
  //       于是每来一次事件，预算就涨一点，watchdog 就续一次期 → **永远不到期**。
  //
  //       `path_update` 在"路径反复重规划"时触发得很频繁（正是我们卡住的时候），
  //       所以这个 bug 只在**真的卡住时**发作 —— 平时完全看不出来。
  //
  // 修法：续期可以有，但**不得超过一个绝对上限**。
  // 为什么还要保留续期：远距离路径的合理等待确实该随距离增长，
  // 一刀切成固定值会误砍正常的长途移动。
  // 为什么上限要存在：**任何"等待"都必须有尽头**。
  // 一个能无限续期的超时，等于没有超时 —— 这正是它在实机上表现出的样子。
  //
  // 上限的算法放在 `pathing.computeHardCap` —— 它不是"一个数字"，
  // 而是"初始预算 + 库上限"的组合规则，值得被自测锁住（见 pathing 的自测）。
  const cap = pathing.computeHardCap(budget.timeoutMs);
  const ABSOLUTE_MAX_MS = cap.hardCapMs;
  const absoluteDeadline = Date.now() + ABSOLUTE_MAX_MS;
  let renewals = 0;

  const trip = (err) => {
    if (settled) return;
    settled = true;
    try { state.bot.pathfinder.stop(); } catch (_) {}
    if (rejectOuter) rejectOuter(err);
  };

  state.bot.on('path_update', onPathUpdate);
  state.bot.on('goal_updated', onGoalUpdated);
  try {
    if (monitor) {
      stagnationTimer = setInterval(() => {
        const v = monitor.sample(state.bot.entity?.position);
        // ⚠️ 打点：P9 的复盘里最缺的就是"停滞检测到底跑了没有"。
        //    没有这行日志，我只能看到"卡了 340 秒"，看不到"检测器在不在工作"。
        DBG(`[goto] ${opts.label || ''} sample #${v.checks} moved=${v.moved} stagnant=${v.stagnant} exhausted=${v.exhausted}`);
        if (v.exhausted) {
          clearInterval(stagnationTimer);
          stagnationTimer = null;
          DBG(`[goto] ${opts.label || ''} → 停滞判定，放弃（moved=${v.moved}）`);
          trip(new Error(
            `Stuck${opts.label ? ` (${opts.label})` : ''}: no meaningful progress for `
            + `${v.stagnant} checks (~${(v.stagnant * pathing.PATH_PROGRESS_INTERVAL_MS) / 1000}s, `
            + `${v.moved} blocks since last check)`,
          ));
        }
      }, pathing.PATH_PROGRESS_INTERVAL_MS);
    } else {
      DBG(`[goto] ${opts.label || ''} ⚠️ 没有 monitor（拿不到起点位置）→ 停滞检测不生效`);
    }

    watchdog = setInterval(() => {
      // ① **绝对上限优先**：无论预算怎么涨，到这里就必须结束。
      //    这一条是 P9 的核心 —— 它保证"卡住"一定有尽头。
      if (Date.now() >= absoluteDeadline) {
        clearInterval(watchdog);
        watchdog = null;
        DBG(`[goto] ${opts.label || ''} → 硬上限 ${ABSOLUTE_MAX_MS}ms 到，放弃（续期 ${renewals} 次）`);
        trip(new Error(
          `Timeout${opts.label ? ` (${opts.label})` : ''}: hit hard cap ${ABSOLUTE_MAX_MS}ms `
          + `(budget renewed ${renewals} times, last budget ${budget.timeoutMs}ms, eta ${budget.etaMs ?? '?'}ms)`,
        ));
        return;
      }
      // ② 续期：预算涨了就延长，但受 ① 约束。
      if (budget.timeoutMs > lastBudget) {
        lastBudget = budget.timeoutMs;
        renewals++;
        limit = Math.min(Date.now() + budget.timeoutMs, absoluteDeadline);
        DBG(`[goto] ${opts.label || ''} 续期 #${renewals} → budget=${budget.timeoutMs}ms eta=${budget.etaMs}ms`);
        return;
      }
      if (Date.now() >= limit) {
        clearInterval(watchdog);
        watchdog = null;
        DBG(`[goto] ${opts.label || ''} → 预算超时 ${budget.timeoutMs}ms，放弃`);
        trip(new Error(
          `Timeout${opts.label ? ` (${opts.label})` : ''}: exceeded ${budget.timeoutMs}ms `
          + `(eta ${budget.etaMs ?? '?'}ms, renewals ${renewals})`,
        ));
      }
    }, Math.max(1000, Math.floor(pathing.PATH_PROGRESS_INTERVAL_MS / 2)));

    DBG(`[goto] ${opts.label || ''} 开始：budget=${budget.timeoutMs}ms hardCap=${ABSOLUTE_MAX_MS}ms`);
    await new Promise((resolve, reject) => {
      rejectOuter = reject;
      Promise.resolve(state.bot.pathfinder.goto(goal)).then(resolve, reject);
    });
    DBG(`[goto] ${opts.label || ''} 成功到达（续期 ${renewals} 次）`);
  } catch (e) {
    // ---- 判据：这次"目标被换掉"算不算失败（N-1）------------------------------
    //
    // ⚠️ `abort()` 要**在这里**读（而不是在 finally 里）：收手那一刻的取消线
    //    才是本次 goto 的事实，晚读会被下一条命令推进。
    const selfInitiated = owner.classify(token, e?.name).selfInitiated || isAborted();
    const outcome = pathing.classifyGotoOutcome(e?.name, selfInitiated);
    if (outcome === 'aborted') {
      // 我们自己收手（取消 / 让出身体）—— **不是失败**：
      //   · 打一行日志说明原因，不 `throw`（上层不该把它当"没走成"再重试整条链）；
      //   · 返回 `aborted: true`，调用方据此**有序退出**（`/mine` 的 aborted 分支）。
      released = true;
      DBG(`[goto] ${opts.label || ''} 中止：${e.message}（本命令已取消，不算失败）`);
      return {
        etaMs: budget.etaMs,
        timeoutMs: budget.timeoutMs,
        replans,
        renewals,
        hardCapMs: ABSOLUTE_MAX_MS,
        checks: monitor ? monitor.snapshot().checks : 0,
        aborted: true,
        abortedReason: e.message,
      };
    }
    failure = e;
    DBG(`[goto] ${opts.label || ''} 结束：${e.message}`);
  } finally {
    settled = true;
    if (stagnationTimer) clearInterval(stagnationTimer);
    if (watchdog) clearInterval(watchdog);
    state.bot.removeListener('path_update', onPathUpdate);
    state.bot.removeListener('goal_updated', onGoalUpdated);
    // 释放所有权。成功 / 失败路径走这里；中止路径已在 catch 里释放（released 标记）。
    if (!released) owner.classify(token, failure ? failure.name : null);
  }
  if (failure) throw failure;

  return {
    etaMs: budget.etaMs,
    timeoutMs: budget.timeoutMs,
    replans,
    renewals,          // 续期了几次 —— 这个数字大就说明"她在原地反复重规划"
    hardCapMs: ABSOLUTE_MAX_MS,
    checks: monitor ? monitor.snapshot().checks : 0,
  };
}

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.DBG !== undefined) DBG = ns.DBG;
  if (ns.state !== undefined) state = ns.state;
}

module.exports = {
  "gotoWithBudget": gotoWithBudget,
  bind,
};
