'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「core」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { monitorEventLoopDelay } = require('perf_hooks');
const storagePolicy = require('../body/storage-policy');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补
const { isHostileEntity } = require('../world/entity-registry.js');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补
const __ns = {};
let CFG, TIER, TIER_NAME, STRUCTURE_SIGNS, COMBAT_YIELD;   // 跨文件常量：load 完成后由 bind() 回填
function fillCfg (...a) { return __ns.fillCfg.apply(null, a); }
function mobKind (...a) { return __ns.mobKind.apply(null, a); }
function attackCooldownMs (...a) { return __ns.attackCooldownMs.apply(null, a); }
function combatPlan (...a) { return __ns.combatPlan.apply(null, a); }
function pickArmor (...a) { return __ns.pickArmor.apply(null, a); }
function toolWorn (...a) { return __ns.toolWorn.apply(null, a); }
function hazardUnder (...a) { return __ns.hazardUnder.apply(null, a); }
function pickStepOff (...a) { return __ns.pickStepOff.apply(null, a); }
function pickEat (...a) { return __ns.pickEat.apply(null, a); }
function needBreath (...a) { return __ns.needBreath.apply(null, a); }
function effectPlan (...a) { return __ns.effectPlan.apply(null, a); }
function shoreRingOffsets (...a) { return __ns.shoreRingOffsets.apply(null, a); }
function pickShore (...a) { return __ns.pickShore.apply(null, a); }
function mlgStep (...a) { return __ns.mlgStep.apply(null, a); }
function pickRecovery (...a) { return __ns.pickRecovery.apply(null, a); }
function pickaxeTier (...a) { return __ns.pickaxeTier.apply(null, a); }
function needTier (...a) { return __ns.needTier.apply(null, a); }
function pickOre (...a) { return __ns.pickOre.apply(null, a); }
function pickCaveStep (...a) { return __ns.pickCaveStep.apply(null, a); }
function pickTorchStep (...a) { return __ns.pickTorchStep.apply(null, a); }
function darkReport (...a) { return __ns.darkReport.apply(null, a); }
function noteDelve (...a) { return __ns.noteDelve.apply(null, a); }
function pickDelveResume (...a) { return __ns.pickDelveResume.apply(null, a); }
function whoThrew (...a) { return __ns.whoThrew.apply(null, a); }
function pickPickup (...a) { return __ns.pickPickup.apply(null, a); }
function pickHarvest (...a) { return __ns.pickHarvest.apply(null, a); }
function pickLoot (...a) { return __ns.pickLoot.apply(null, a); }
function pickTidy (...a) { return __ns.pickTidy.apply(null, a); }
function carriedNames (...a) { return __ns.carriedNames.apply(null, a); }
function carriedTally (...a) { return __ns.carriedTally.apply(null, a); }
function pickupFailIds (...a) { return __ns.pickupFailIds.apply(null, a); }
function gazeEngaged (...a) { return __ns.gazeEngaged.apply(null, a); }
function pickGaze (...a) { return __ns.pickGaze.apply(null, a); }
function pickCommand (...a) { return __ns.pickCommand.apply(null, a); }
function weatherChange (...a) { return __ns.weatherChange.apply(null, a); }
function followIdlePlan (...a) { return __ns.followIdlePlan.apply(null, a); }
function recognizeStructures (...a) { return __ns.recognizeStructures.apply(null, a); }
function homeFootprint (...a) { return __ns.homeFootprint.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; TIER = ns.TIER; TIER_NAME = ns.TIER_NAME; STRUCTURE_SIGNS = ns.STRUCTURE_SIGNS; COMBAT_YIELD = ns.COMBAT_YIELD; }

/**
 * 身体空不空。返回 null = 空着；否则是一句"为什么不空"。
 * following 的时候算空（本能会打断跟随，干完再接上）。
 */
function bodyBusy ({ inflight = 0, currentAction = null, windowOpen = false, quietUntil = 0, now = Date.now() }) {
  if (inflight > 0) return `有 ${inflight} 个命令在跑`;
  if (windowOpen) return '开着界面';
  if (now < quietUntil) return '刚被叫停，站着别动';
  if (currentAction && !/^following /.test(currentAction)) return `在忙：${currentAction}`;
  return null;
}

function createCheck (name, fn, diagnostics, now = Date.now) {
  let active = false;
  return async (source = 'timer') => {
    if (active) return;
    active = true;
    const d = diagnostics[name] = { at: now(), source, active: true };
    try { await fn(d); } catch (e) { d.error = String(e.message || e); } finally {
      d.durationMs = now() - d.at;
      d.active = false;
      active = false;
    }
  };
}

async function settleJob (job, ms = 800) {
  if (!job) return true;
  let timer;
  try {
    return await Promise.race([
      job.done.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * 一个 job 结束收尾时，**它还有没有资格动身体**（清寻路目标 / 清 `I.running` 标记）。
 *
 * ⚠️ 2026-09-28 审计（codex fix0 #4）：抽出来是因为原来的原地判据只保住了"标记"、
 *    保不住"寻路目标"。战斗的 `finally` 里无条件 `bot.pathfinder.setGoal(null)` ——
 *    战斗被叫停、等旧动作超时、新命令已经接管身体时，旧战斗的 `finally` 仍会跑，
 *    把**新命令的**寻路目标一起清掉（新命令刚 `setGoal` 完就发现自己没目标了）。
 *
 *    正确的判据是"**当前 owner 还是不是我**"：
 *      · `I.running === myJob` → 期间没人接管 → 还是我，可以清；
 *      · 否则（被打断 / 被 yieldBody 换成新 job）→ 不是我的了 → 别动。
 *
 *    这是**纯函数**，所以能离线自测（见 selftest 的"收尾资格"一节）。
 *
 * @param {object} I        state.instinct
 * @param {object} myJob    本次要收尾的 job（拿到时的引用）
 * @returns {boolean} 还有没有资格动身体
 */
function ownsBodyAtCleanup (I, myJob) {
  return !!I && I.running === myJob && myJob != null;
}

/**
 * 憋气这一跳"到底跳了没有"。
 *
 * ⚠️ 2026-09-28 二轮审计（wbR2 新发现，高）：`runJob` 会把**某些情况下**的上浮直接拒掉
 *    （`I.urgent` 被 yieldBody / 战斗 finally 改掉时走早退分支，返回
 *    `{ r: { error: '已让出身体给紧急本能' }, aborted: true }`）。
 *    早退发生在 `I.running = job` 之前 —— 这次上浮连 owner 都没拿到，一跳都没跳。
 *    保命动作**不能有条件不满足就静默放弃的路径**，所以调用方必须能看出
 *    "这一下根本没跳成、需要直接补跳"。判据抽到这里（纯函数，可离线自测）：
 *    当真跳了（handler 报 `jumped > 0`）才放行；被拒 / 报错 / 跳了 0 下，
 *    都算"没跳成"，调用方要**直接补一次**。
 *
 * @param {{aborted?:boolean, r?:{error?:string, jumped?:number}}} res runJob 的返回
 * @returns {boolean} true = 这一下没真跳成，必须补跳
 */
function breatheRefused (res, cfg = CFG.breathe) {
  if (!res) return true;
  if (res.r?.error) return true;                                                   // 被拒 / 出错
  if (Number.isFinite(res.r?.oxygen) && res.r.oxygen > cfg.at) return false;       // 氧气回来了 = 成了（不管报没报跳了几下）
  if (Number.isFinite(res.r?.jumped)) return res.r.jumped <= 0;                    // 报了跳几下：0 下就是没成
  return !!res.aborted;                                                            // 什么都没报：被打断才算没成
}

/** 以实体姿态纠正 mineflayer 的睡眠缓存；缺失姿态时不猜。
 * 来源：mineflayer/lib/plugins/entities.js 只在姿态 2 时 emit entitySleep，
 * 恢复清醒却依赖另一个 animation 包；若未收到该包，会一直拦住本能。
 */
function syncSleepState (bot, sleepAnchor = null, { sleptAt = 0, staleMs = 480000, now = Date.now() } = {}) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys;
  const index = keys?.indexOf('pose') ?? -1;
  const pose = index >= 0 ? bot.entity?.metadata?.[index] : undefined;
  if (!Number.isInteger(pose) || pose < 0) {
    // 某些登录/重连包没有 pose，但身体已经走离当时睡觉的位置：这比旧缓存可靠。
    const moved = !!(bot.isSleeping && sleepAnchor && bot.entity?.position
      && bot.entity.position.distanceTo(sleepAnchor) > 1.5);
    // 2026-09-28 审计：卡住时恰恰不会动 → 永远"在睡" → 本能主循环永远早退。再加两条证据：
    //   天亮了（0–12000 是白天，床睡不了）、或者"睡着"已经超过 staleMs（原版一觉最多几秒就跳夜）
    const t = bot.time?.timeOfDay;
    const day = Number.isFinite(t) && t >= 0 && t < 12000 && !(bot.isRaining && (bot.thunderState ?? 0) > 0);
    const stale = !!(bot.isSleeping && sleptAt && now - sleptAt > staleMs);
    const wake = moved || (bot.isSleeping && (day || stale));
    if (wake) { bot.isSleeping = false; bot.emit('wake'); }
    return { pose: null, sleeping: !!bot.isSleeping, corrected: wake, reason: moved ? '已走离睡觉位置' : wake ? (day ? '天亮了' : '"睡着"太久了') : '姿态未读到' };
  }
  const sleeping = pose === 2;
  const corrected = !!bot.isSleeping !== sleeping;
  if (corrected) {
    bot.isSleeping = sleeping;
    bot.emit(sleeping ? 'sleep' : 'wake');
  }
  return { pose, sleeping, corrected };
}

function caveBoundary (self, home) {
  if (!home?.center || !Number.isFinite(home.radius)) return '家的范围未知，暂不自动探洞';
  if (Math.hypot(self.x - home.center.x, self.z - home.center.z) <= home.radius) return '家范围内不自动探洞，等明确下矿指令';
  return null;
}

/**
 * 按区块柱逐个扫方块（2026-09-28 Claude 重写：第 8 批的版本用错了 mineflayer 的接口 ——
 *   `bot.world.getColumn({x,z})` 传对象（真接口是 `getColumn(chunkX, chunkZ)`）、`sections[sy]` 没减 minY，
 *   实机永远拿不到区块 → **什么都扫不到、也不报错**；它的自测用的假世界照同一套错接口写，所以是绿的）。
 * 现在：`world.getColumn(cx, cz)`（WorldSync 同步版）→ `column.getBlockStateId({x:局部, y:绝对, z:局部})`；
 *   section 下标 `(y - column.minY) >> 4`，section 的调色板（`section.data.palette` / 单值 `section.data.value`）
 *   里一个目标状态都没有就整节跳过。每扫完一柱 `await yieldFn()` 让出事件循环。
 * 没加载的柱记进 `unloaded`（"读不到"和"没有"分开报）。
 * @returns {Promise<{pts, sections, cells, columns, unloaded, worstMs}>}
 */
function * scanColumnsGen ({ world, registry, c, ids, maxDist, cap = 0, opts = {} }) {
  const { Vec3 } = require('vec3');
  const dy = opts.dy ?? 16; const minDist = opts.minDist || 0;
  const states = new Set();
  for (const id of ids || []) {
    const b = registry?.blocks?.[id];
    if (b && Number.isFinite(b.minStateId) && Number.isFinite(b.maxStateId)) for (let st = b.minStateId; st <= b.maxStateId; st++) states.add(st);
  }
  const out = []; let sections = 0; let cells = 0; let columns = 0; let unloaded = 0; let worstMs = 0;
  const r2 = maxDist * maxDist; const rMin2 = minDist * minDist;
  const cx0 = Math.floor(c.x / 16); const cz0 = Math.floor(c.z / 16); const cCols = Math.ceil(maxDist / 16) + 1;
  const yLo = Math.floor(c.y - dy); const yHi = Math.floor(c.y + dy);
  for (let dx = -cCols; dx <= cCols; dx++) {
    for (let dz = -cCols; dz <= cCols; dz++) {
      const sx = cx0 + dx; const sz = cz0 + dz;
      const ddx = Math.max(0, Math.abs(sx * 16 + 8 - c.x) - 8); const ddz = Math.max(0, Math.abs(sz * 16 + 8 - c.z) - 8);
      if (ddx * ddx + ddz * ddz > r2) continue;
      const t0 = process.hrtime.bigint();
      const col = world?.getColumn?.(sx, sz);
      if (!col) { unloaded++; continue; }
      const minY = Number.isFinite(col.minY) ? col.minY : -64;
      for (let sy = Math.floor(yLo / 16); sy <= Math.floor(yHi / 16); sy++) {
        const sec = col.sections?.[(sy * 16 - minY) >> 4];
        if (!sec) continue;
        sections++;
        const pc = sec.data;
        const pal = Array.isArray(pc?.palette) ? pc.palette : (pc && Number.isFinite(pc.value) ? [pc.value] : null);
        if (pal && !pal.some(st => states.has(st))) continue;   // 调色板里没有目标 → 整节跳过
        for (let lx = 0; lx < 16; lx++) {
          for (let lz = 0; lz < 16; lz++) {
            const wx = sx * 16 + lx; const wz = sz * 16 + lz;
            const hx = wx + 0.5 - c.x; const hz = wz + 0.5 - c.z; const h2 = hx * hx + hz * hz;
            if (h2 > r2 || (minDist && h2 < rMin2)) continue;
            for (let y = Math.max(sy * 16, yLo); y <= Math.min(sy * 16 + 15, yHi); y++) {
              cells++;
              if (!states.has(col.getBlockStateId({ x: lx, y, z: lz }))) continue;
              out.push(new Vec3(wx, y, wz));
              if (cap && out.length >= cap) break;
            }
            if (cap && out.length >= cap) break;
          }
          if (cap && out.length >= cap) break;
        }
        if (cap && out.length >= cap) break;
      }
      worstMs = Math.max(worstMs, Number(process.hrtime.bigint() - t0) / 1e6);
      columns++;
      yield null;   // 一柱扫完：让调用方有机会让出事件循环
      if (cap && out.length >= cap) return { pts: out, sections, cells, columns, unloaded, worstMs };
    }
  }
  return { pts: out, sections, cells, columns, unloaded, worstMs };
}

async function scanColumnsIn (args) {
  const yieldFn = args.yieldFn || (() => new Promise(res => setImmediate(res)));
  const g = scanColumnsGen(args);
  for (;;) { const { value, done } = g.next(); if (done) return value; await yieldFn(); }
}

function scanColumnsSync (args) {
  const g = scanColumnsGen(args);
  for (;;) { const { value, done } = g.next(); if (done) return value; }
}

function install (bot, state, deps) {
  const I = state.instinct = state.instinct || {
    cfg: {},
    inflight: 0,
    quietUntil: 0,
    running: null,      // { kind, abort(), done: Promise }
    last: null,         // 最近一次判断（每个本能为什么做 / 为什么没做）
    log: [],            // 最近做过的事
    events: [], evSeq: 0,   // 给 mind 的事（GET /instinct/events?since=）
    told: new Set(),        // 已经告诉过 mind 的"镐子不够"的矿位
    home: null,             // { center:{x,y,z}, radius }，mind 通过 POST /instinct {home} 告诉
    gazeEngagedUntil: new Map(),   // 玩家名 → 到什么时候为止还可以看他（见 gazeEngaged）
  };
  // 跨重连保留状态；新加的本能补上默认配置（老的 state.instinct 里没有）
  fillCfg(I.cfg);
  I.gazeEngagedUntil ||= new Map();   // 老 state 里没有（见 gazeEngaged）；趁早建好，礼物钩子要用
  I.torchAnchor ||= null;             // 暗处插火把：上次检查时她在哪（走够 everyBlocks 才再检查）—— 第 8 批第 4 条
  I.followSeen ||= null;              // 跟随中：上一帧看到的玩家位置（判断他动不动）—— 第 8 批第 6 条
  I.followMovedAt ||= 0;              // 跟随中：他上一次"动过"的时间戳
  I.delve ||= null;                   // 正在进行的下矿记录（mind 发起 / 本能续探）—— 第 8 批第 5 条
  I.noteDelve = (a, r, now) => noteDelve(I, a, r, now);   // hands.js 的 /delve 路由回调（接线只此一处）
  I.diagnostics = {};
  I.urgent = null;

  // ---- 慢活计时 + 事件循环延迟（2026-09-28）
  //
  // 起因：实机每 5 分钟整个进程冻 ~14 秒。`scheduler.lagMs` 是"本能这一拍自己算的拍间隔"，
  // 它能看出"某一拍晚了"，但 `busyForMs:0`（本能没在忙）时它分不清是谁堵的。
  // 这里加两样：
  //   · `slow(name, ms)` —— 每个大活干完量一次，超 200ms 打一行 `[instinct HH:MM:SS] slow <名字> <ms>`；
  //   · `monitorEventLoopDelay` —— 量**事件循环本身**的延迟（和本能忙不忙无关）。
  //     抓的是"同步代码堵住了整个进程"这种，正是 homeTimer 大扫描干的事。
  if (!I.slowLog) I.slowLog = [];              // 最近几条慢活（GET /instinct 看）
  const SLOW_MS = 200;
  const slow = (name, ms) => {
    if (!(ms >= SLOW_MS)) return ms;
    const stamp = new Date().toTimeString().slice(0, 8);
    console.log(`[instinct ${stamp}] slow ${name} ${ms.toFixed(0)}`);
    I.slowLog.push({ at: Date.now(), name, ms: Math.round(ms) });
    if (I.slowLog.length > 20) I.slowLog.shift();
    return ms;
  };
  /** 量一段同步大活的耗时。fn 必须是同步的（这里就是要抓同步堵住事件循环的那段）。 */
  const timed = (name, fn) => { const t0 = process.hrtime.bigint(); const r = fn(); slow(name, Number(process.hrtime.bigint() - t0) / 1e6); return r; };

  let loopHist = null;
  try {
    loopHist = monitorEventLoopDelay({ resolution: 20 });
    loopHist.enable();
  } catch (_) { loopHist = null; }
  /** 事件循环延迟（毫秒）。p50/p99/max；max 是**自上次读以来**的最大值，读完就重置，别让它一直粘着历史峰值。 */
  const loopDelay = () => {
    if (!loopHist) return null;
    const ms = (ns) => Math.round(ns / 1e6);
    const out = { p50: ms(loopHist.percentile(50)), p99: ms(loopHist.percentile(99)), max: ms(loopHist.max) };
    loopHist.reset();
    return out;
  };

  let ended = false;
  let sleepAnchor = null; let sleptAt = 0;
  const sleeping = () => {
    if (bot.isSleeping && !sleepAnchor && bot.entity?.position) { sleepAnchor = bot.entity.position.clone(); sleptAt = Date.now(); }
    const result = syncSleepState(bot, sleepAnchor, { sleptAt });
    if (!result.sleeping) { sleepAnchor = null; sleptAt = 0; }
    const bedKey = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('sleeping_pos') ?? -1;
    I.sleepState = { ...result, bedPosition: bedKey >= 0 ? bot.entity?.metadata?.[bedKey] ?? null : null, at: Date.now() };
    if (result.corrected) I.sleepCorrections = (I.sleepCorrections || 0) + 1;
    return result.sleeping;
  };
  const spawned = new Map();   // 掉落物 id → { t, thrower }
  const fails = new Map();
  const mineFails = new Map();   // "x,y,z" → 到什么时候之前不再试

  bot.on('entitySpawn', (e) => {
    try {
      if (!deps.isDropEntity(e)) return;
      const players = Object.values(bot.players || {})
        .filter(p => p.entity?.position)
        .map(p => ({ name: p.entity === bot.entity ? 'self' : p.username, pos: p.entity.position }));
      spawned.set(e.id, { t: Date.now(), thrower: whoThrew(e.position, players) });
    } catch (_) {}
  });
  // 她捡起了别人扔的东西：告诉物品账"这是谁给的"（collect 包点名了是哪个实体，是确证）
  // 同时开一个"可以看他"的窗口（主人 2026-09-28：有人给她东西是互动）
  bot.on('playerCollect', (collector, collected) => {
    try {
      if (collector !== bot.entity) return;
      const s = spawned.get(collected?.id);
      if (!s?.thrower || s.thrower === 'self') return;
      I.gazeEngagedUntil.set(String(s.thrower), Date.now() + (I.cfg.gaze.giftMs || 15000));
      const item = deps.droppedItemOf(collected)?.name;
      if (item) state.ledger?.note({ gift: { from: s.thrower, item } });
    } catch (_) {}
  });
  bot.on('entityGone', (e) => { spawned.delete(e?.id); fails.delete(e?.id); });

  // 落盘工具（主人 2026-09-28）：光进内存环形 30 条，出了问题日志里查不到 ——
  // 审计里遍地"日志里没找到 X"就是这么来的。这里**同时** console.log 一行。
  // 高频调用者（每 400ms 的 skip 等）**不要**走这里，只走 note/event 本身。
  const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

  const note = (entry) => {
    const at = Date.now();
    I.log.push({ t: at, ...entry });
    if (I.log.length > 30) I.log.shift();
    try {
      const { kind, ...rest } = entry;
      // 一行 ≤200 字符：长的字符串截断，不换行（日志按行读）
      let body = '';
      for (const [k, v] of Object.entries(rest)) {
        if (v == null || v === false || v === '') continue;
        let s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s && s.length > 80) s = s.slice(0, 77) + '...';
        body += ` ${k}=${s}`;
      }
      console.log(`[instinct ${hhmmss(at)}] ${kind ?? '?'}${body}`.slice(0, 200));
    } catch (_) {}
  };

  function canHold (itemName) {
    try {
      if (bot.inventory.emptySlotCount() > 0) return true;
      if (!itemName) return false;   // 读不出是什么，又没有空格 —— 保守：不去
      return bot.inventory.items().some(i => i.name === itemName && i.count < (i.stackSize || 64));
    } catch (_) { return false; }
  }

  /**
   * 这堆掉落物她**看得见**吗（远处拾取用）。
   *
   * mineflayer 只有 `canSeeBlock`（blocks.js:229，用 `world.raycast` 打一条视线），没有 `canSeeEntity`。
   * 这里用同样的 `world.raycast` 从眼睛打到掉落物那格：中途撞到实心方块 = 被挡住。
   * 读不到（没有 world/raycast、或位置缺失）返回 null —— 上层按"未知不远去"处理（AGENTS.md §5）。
   */
  function readVisible (e) {
    try {
      const self = bot.entity;
      if (!e?.position || !self?.position) return null;
      const dist = e.position.distanceTo(self.position);
      if (dist <= 8) return true;            // 脚边的不必打光：8 格内不会被挡得看不见
      const world = bot.world;
      if (!world?.raycast) return null;      // 读不到视线就说不清 —— 返回 null，不当"看得见"
      const eye = (self.eyeHeight || 1.62);
      const headPos = self.position.offset(0, eye, 0);
      const target = e.position.offset(0, 0.25, 0);   // 掉落物很小，瞄它的下半身
      const dir = target.minus(headPos);
      const range = dir.norm();
      if (!(range > 0)) return null;
      const hit = world.raycast(headPos, dir.scale(1 / range), Math.max(0, range - 0.6),
        (block) => !!block && block.boundingBox === 'block');   // 撞到实心方块就算挡住
      return !hit;                            // 没撞到东西 = 一路通到掉落物跟前 = 看得见
    } catch (_) { return null; }
  }

  function threatened () {
    const self = bot.entity;
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === self || e.type === 'player') continue;
      if (e.position.distanceTo(self.position) > I.cfg.pickup.threatRadius) continue;
      const a = deps.aggroOf(e);
      if (a && a.on === 'me') return `${e.name} 冲她来了`;
    }
    return null;
  }

  const event = (kind, text, extra = {}) => {
    const at = Date.now();
    // ⚠️ 2026-09-28 审计（codex fix1 #3）：**先把换行拍平再截断**。
    //    原来只 `slice(0, 300)` —— 异常消息里带 `\r\n` 时会输出成多行，
    //    破坏"一条事件一行日志"的格式（mind 侧按行读，多行会被误当成多条）。
    //    先 `replace(/[\r\n]+/g, ' ')` 再截断，保证单行。
    const line = String(text ?? '').replace(/[\r\n]+/g, ' ');
    I.events.push({ seq: ++I.evSeq, t: at, kind, text: line, ...extra });
    if (I.events.length > 50) I.events.shift();
    try { console.log(`[instinct-event ${hhmmss(at)}] ${kind} ${line}`.slice(0, 300)); } catch (_) {}
  };

  /**
   * 跑一件本能的事。abort() 由 yieldBody 调：置标记 + 停寻路 + 停挖（手上的 goto/dig 立刻结束，循环在下一步检查标记）。
   * ledgerEv：这期间背包的进出算谁的（物品账）。
   */
  async function runJob (kind, ledgerEv, fn) {
    if (ended || (I.urgent && I.urgent !== kind)) return { r: { error: '已让出身体给紧急本能' }, aborted: true };
    let aborted = false;
    const endLedger = state.ledger && ledgerEv ? state.ledger.begin(ledgerEv) : null;
    const done = (async () => {
      try { return await fn(() => aborted); } catch (e) { return { error: e.message }; }
    })();
    const job = I.running = {
      kind,
      abort: () => {
        aborted = true;
        try { bot.pathfinder.stop(); } catch (_) {}
        try { bot.stopDigging(); } catch (_) {}
      },
      done,
    };
    try { return { r: await done, aborted }; } finally {
      if (I.running === job) I.running = null;
      if (endLedger) { endLedger(); state.ledgerKick?.(); }
    }
  }

  async function runPickup (ids, followName) {
    const { r, aborted } = await runJob('pickup', { instinct: 'pickup' }, (abort) => deps.handlers['POST /pickup']({
      ids, count: ids.length, radius: I.cfg.pickup.radius + 2, timeoutMs: I.cfg.pickup.timeoutMs, budgetMs: I.cfg.pickup.budgetMs, abort,
    }));
    // 只有"真的试过、还在地上"的才记失败；被打断、没轮到（预算用完）的不算（2026-09-28 审计：以前一律记，打怪时捡两次就拉黑一分钟）
    for (const id of pickupFailIds({ ids, r, aborted, exists: (i) => !!bot.entities[i] })) {
      const f = fails.get(id) || { n: 0, until: 0 };
      f.n++; f.until = Date.now() + I.cfg.pickup.failCooldownMs;
      fails.set(id, f);
    }
    note({ kind: 'pickup', aborted: aborted || undefined, ids: ids.length, picked: r?.picked ?? 0, ms: r?.ms, stopped: r?.stopped, error: r?.error });
    // 本来在跟人：接着跟（被命令打断的不接 —— 命令说了算）
    if (followName && !aborted && !state.currentAction && bot.players[followName]?.entity) {
      try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {}
    }
  }

  // ---- 矿表 / 作物表（整合包真值，knowledge/ores.json、crops.json）→ 本连接的方块 id
  let tables = null;
  function loadTables () {
    if (tables) return tables;
    const read = (f) => { try { return JSON.parse(require('fs').readFileSync(require('path').join(paths.KNOWLEDGE, f), 'utf8')); } catch (_) { return null; } };
    const ores = deps.tables?.ores || read('ores.json');
    const crops = deps.tables?.crops || read('crops.json');
    const reg = bot.registry;
    const idOf = (n) => (reg.blocksByName[n] || reg.blocksByName[String(n).replace(/^minecraft:/, '')])?.id;
    const index = (list) => {
      const byId = new Map();
      for (const x of Array.isArray(list) ? list : []) { const id = idOf(x.name); if (id != null) byId.set(id, x); }
      return byId;
    };
    tables = { ores: index(ores), crops: index(crops), oresLoaded: Array.isArray(ores), cropsLoaded: Array.isArray(crops) };
    return tables;
  }

  const bareName = (n) => String(n).replace(/^minecraft:/, '');
  // 矿看不看得见：视线打得到，或者有一面露在空气/水里（矿洞里露出来的）—— 判据在 place.exposedToOpen，只一处
  const oreVisible = (b) => {
    if (!b) return false;
    try { if (bot.canSeeBlock(b)) return true; } catch (_) {}
    return require('../world/place').exposedToOpen(b.position, (x, y, z) => bot.blockAt(new (require('vec3').Vec3)(x, y, z)));
  };
  const hazardAround = (p) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (b && /lava|water/.test(b.name)) return true;
    }
    return false;
  };
  const inHome = (p) => {
    const h = I.home;
    if (!h) return null;
    return Math.hypot(p.x - h.center.x, p.z - h.center.z) <= h.radius && Math.abs(p.y - h.center.y) <= 16;
  };

  async function tryHarvest () {
    const H = I.cfg.harvest;
    if (!H.enabled || Date.now() - (I.lastHarvestAt || 0) < H.cooldownMs) return null;
    const T = loadTables();
    if (!T.cropsLoaded || !T.crops.size) return { skip: '没有作物表（knowledge/crops.json）' };
    const pts = bot.findBlocks({ matching: [...T.crops.keys()], maxDistance: H.radius, count: 256 });
    const crops = pts.map(p => {
      const b = bot.blockAt(p); if (!b) return null;
      const row = T.crops.get(b.type);
      const props = b.getProperties?.() || {};
      const below = bot.blockAt(p.offset(0, -1, 0));
      return {
        name: b.name, pos: p, age: +props[row.ageProp || 'age'], maxAge: row.maxAge, harvest: row.harvest,
        farmland: !!below && /farmland/.test(below.name),
        visible: bot.canSeeBlock(b),
      };
    }).filter(Boolean);
    const pick = pickHarvest({ crops, self: bot.entity.position, inHome });
    if (!pick.only) return pick;
    I.lastHarvestAt = Date.now();
    const { r, aborted } = await runJob('harvest', { route: 'POST /farm' }, (abort) => deps.hands.farm(bot, state, {
      radius: H.radius + 2, replant: true, plantEmpty: false, only: pick.only, abort,
    }));
    note({ kind: 'harvest', aborted: aborted || undefined, harvested: r?.harvested ?? 0, replanted: r?.replanted ?? 0, error: r?.error });
    if (r?.harvested) event('harvest', `顺手收了 ${r.harvested} 棵成熟的庄稼${r.replanted ? `，补种了 ${r.replanted} 棵` : '（没种子补种）'}`);
    return { did: 'harvest' };
  }

  async function tryMine (followIdle = null) {
    const M = I.cfg.mine;
    if (!M.enabled || Date.now() - (I.lastMineAt || 0) < M.cooldownMs) return null;
    if (bot.inventory.emptySlotCount() < CFG.minFreeSlots) return { skip: '背包快满了，不挖' };
    const T = loadTables();
    if (!T.oresLoaded || !T.ores.size) return { skip: '没有矿表（knowledge/ores.json）' };
    const pts = bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: M.radius, count: 256 });   // 64 会被附近埋着的矿占满，露出来的轮不到
    const ores = pts.map(p => {
      const b = bot.blockAt(p); if (!b) return null;
      const row = T.ores.get(b.type);
      return { name: row.name, pos: p, value: row.value, tier: row.tier, notPickaxe: !!row.notPickaxe, drops: (row.drops || []).map(bareName), visible: oreVisible(b), hazard: hazardAround(p) };
    }).filter(Boolean);
    // 镐子和"缺不缺这种矿"都要算上精妙背包里的（N-9：镐子在背包里时以前判"镐子不够"不挖）。
    // 背包读不到就按老逻辑（只看身上），并在 skip 原因里写清"背包读不到"——不能说"没有"。
    const carry = carriedNames(bot, state);
    const tally = carriedTally(bot, state);
    const have = tally.have;
    const pick = pickOre({ ores, self: bot.entity.position, pick: pickaxeTier(carry.names), have, fails: mineFails, followIdle });
    // 看得见、值钱、但镐子不够：告诉 mind（一个位置只说一次）
    for (const l of pick.lacking || []) {
      const k = `${l.pos.x},${l.pos.y},${l.pos.z}`;
      if (I.told.has(k)) continue;
      I.told.add(k);
      event('ore_lacking_tool', `看见 ${l.name}（${k}），但要${TIER_NAME[l.need] || '更好的镐子'}才挖得出东西${carry.readable ? '' : '（背包读不到，只算了身上的）'}`, { ore: l.name, pos: l.pos, backpackReadable: carry.readable });
    }
    if (!pick.target) {
      // 背包读不到时补一句，免得把"读不到"当成"真的没有"
      if (!carry.readable && pick.skip) return { ...pick, skip: `${pick.skip}；背包读不到（只算了身上的）` };
      return pick;
    }
    // ★ 挖之前先把镐子拿在身上（2026-09-28 第 8 批 第 2 条的后半）：
    //   pickaxeTier 把背包里的镐子也算"有"，但真去挖时手里没镐子会白跑一趟。
    //   ensureCarried 按"随身装备"同一套判据（re /pickaxe$/）从背包拿出来。
    if (deps.hands.ensureCarried) {
      try { await deps.hands.ensureCarried(bot, state, (it) => /pickaxe$/.test(it.name), 1); } catch (_) {}
    }
    I.lastMineAt = Date.now();
    const { r, aborted } = await runJob('mine', { route: 'POST /mine' }, (abort) => deps.handlers['POST /mine']({
      blockName: pick.target.name, count: pick.count, maxRadius: M.radius, abort,
    }));
    const got = typeof r?.mined === 'number' ? r.mined : 0;   // /mine 回的是挖掉的块数
    const k = `${pick.target.pos.x},${pick.target.pos.y},${pick.target.pos.z}`;
    // 被打断（战斗/命令）**不记失败冷却** —— 打断不是"挖不动"，
    // 下一拍身体空了要接着挖同一个矿（这就是"遇到矿石也不挖"的另一半原因：
    // 以前战斗插进来一次，这个矿位就被 failCooldownMs=10 分钟封掉了）。
    if (!got && !aborted) mineFails.set(k, Date.now() + M.failCooldownMs);
    if (aborted) mineFails.delete(k);   // 清掉早先可能记下的失败，让它下一拍能接着来
    note({ kind: 'mine', ore: pick.target.name, aborted: aborted || undefined, mined: got, error: r?.error });
    if (got) event('mine', `看见 ${pick.target.name} 就顺手挖了 ${got} 块`, { ore: pick.target.name });
    return aborted ? { skip: '挖矿被战斗或命令打断，下一拍接着挖' } : { did: 'mine' };
  }

  // ---- 接着把 mind 交待的下矿走完（第 5 条）
  // cave 本能仍然默认关；这条只对"mind 明确下过 /delve 且 5 分钟内被打断"的情况生效。
  async function tryResumeDelve () {
    const D = I.cfg.delve;
    const plan = pickDelveResume({
      delve: I.delve, self: bot.entity.position, now: Date.now(),
      resumeMs: D.resumeMs, reach: D.reach, enabled: D.enabled,
    });
    if (!plan.resume) { if (!I.delve) return null; return { skip: plan.why }; }
    if ((bot.health ?? 20) < D.minHp) return { skip: `血 ${bot.health}，先不接着挖` };
    if (bot.inventory.emptySlotCount() < CFG.minFreeSlots) return { skip: '背包快满了，先不接着挖' };
    if (!I.caveDone) I.caveDone = new Set();
    // 从记录里的洞口接着走 —— delve 自己会读取 state 里的 mines.json / heading 接着挖
    I.lastDelveAt = Date.now();
    const { r, aborted } = await runJob('delve', { route: 'POST /delve' }, (abort) => deps.handlers['POST /delve']({
      target: plan.target, targetY: I.delve?.targetY ?? undefined, seconds: Math.round(D.seconds), abort,
    }));
    if (aborted) return { skip: '续挖被战斗或命令打断' };
    noteDelve(I, { target: plan.target, seconds: D.seconds, resumed: true }, r || {}, Date.now());   // 本能自己接着下的：计数，封顶见 pickDelveResume
    note({ kind: 'delve', resume: true, reason: r?.reason, gained: r?.gained, error: r?.error });
    event('delve_resume', `接着把上次没挖完的矿挖下去：${String(r?.reason || '').slice(0, 60)}${r?.gained ? `（进账 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}）` : ''}`, { gained: r?.gained });
    return { did: 'delve' };
  }

  // ---- 暗处插火把（第 4 条，新本能，无 LLM）
  // 不在战斗里插（调用方 tick 已经在 fighting 时早退；这里再兜一层），每 ~6 格检查一次。
  async function tryTorch () {
    const TC = I.cfg.torch;
    if (!TC.enabled) return null;
    if (Date.now() - (I.lastTorchCheck || 0) < TC.checkMs) return null;
    I.lastTorchCheck = Date.now();
    // ④ 走了多少格：按水平位移累计（原地不动不插）
    let ex = null; try { ex = deps.exposureOf?.(bot); } catch (_) { ex = null; }
    const here = bot.entity.position;
    const moved = I.torchAnchor ? Math.hypot(here.x - I.torchAnchor.x, here.z - I.torchAnchor.z) : Infinity;
    const li = (() => { try { return deps.hands.lightAt?.(bot); } catch (_) { return null; } })();
    const near = (() => { try { return deps.hands.nearestLight?.(bot, TC.spacing); } catch (_) { return null; } })();
    const torches = (() => { try { return deps.hands.torchCount?.(bot) ?? 0; } catch (_) { return 0; } })();
    const plan = pickTorchStep({
      exposure: ex, light: li?.block ?? null, torches, nearestLight: near, movedSince: moved,
    }, TC);
    if (!plan.place) {
      // 走了够远就把锚点挪过来，免得一直在"还没走够"里打转
      if (moved >= TC.everyBlocks) I.torchAnchor = { x: here.x, z: here.z };
      return { skip: plan.why };
    }
    // 火把可能在精妙背包里 → 先补到身上（和 hands.lightUp 的判据同一处）
    if (deps.hands.ensureCarried) { try { await deps.hands.ensureCarried(bot, state, (it) => /(^|:)torch$/.test(it.name), 1); } catch (_) {} }
    const { r, aborted } = await runJob('torch', null, (abort) => deps.handlers['POST /light_up']({ max: 1, abort }));
    I.torchAnchor = { x: here.x, z: here.z };
    if (aborted) return { skip: '插火把被战斗或命令打断' };
    const placed = typeof r?.placed === 'number' ? r.placed : 0;
    note({ kind: 'torch', placed, why: plan.why, error: r?.error });
    if (placed > 0) { event('torch', `这里暗，插了 ${placed} 根火把`, { placed }); return { did: 'torch' }; }
    return { skip: `想插火把没插成（${r?.error || r?.note || '没有合适的位置'}）` };
  }

  // ---- 危险方块退开（保命：连"刚被叫停"也不拦它）
  function stepOffPlan () {
    const f = bot.entity.position.floored();
    const nm = (p) => bot.blockAt(p)?.name ?? null;
    const me = bot.entity.position;
    const fallingAbove = Object.values(bot.entities).some(e => e?.name === 'falling_block' && e.position
      && Math.abs(e.position.x - me.x) < 1 && Math.abs(e.position.z - me.z) < 1 && e.position.y > me.y && e.position.y - me.y < 8);
    const why = hazardUnder({ feet: nm(f), below: nm(f.offset(0, -1, 0)), fallingAbove });
    if (!why) return null;
    const cells = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = f.offset(dx, 0, dz);
      cells.push({ dx, dz, feet: nm(c), head: nm(c.offset(0, 1, 0)), below: nm(c.offset(0, -1, 0)) });
    }
    const to = pickStepOff(cells);
    if (!to) return { why };
    return { why, f, to };
  }

  async function tryStepOff (plan = stepOffPlan()) {
    if (!plan) return null;
    const { why, f, to } = plan;
    if (!to) { event('hazard_stuck', `${why}，旁边也没有能站的地方`); return { skip: why }; }
    const { goals } = require('mineflayer-pathfinder');
    await runJob('stepoff', null, async (abort) => {
      await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(f.x + to.dx, f.y, f.z + to.dz)), new Promise(r => setTimeout(r, 2500))]);
      if (!abort()) { try { bot.pathfinder.setGoal(null); } catch (_) {} }
    });
    note({ kind: 'stepoff', why });
    return { did: 'stepoff' };
  }

  // ---- 夜里在家有床就睡
  async function trySleep () {
    const S = I.cfg.sleep;
    if (!S.enabled || bot.isSleeping || Date.now() < (I.sleepRetryAt || 0)) return null;
    if (deps.night?.phaseOf(bot.time?.timeOfDay) !== 'night' && !I.weather?.thunder) return null;   // 打雷时白天也能睡
    if (inHome(bot.entity.position) !== true) return { skip: '不在家（或不知道家在哪）' };
    const { r, aborted } = await runJob('sleep', null, (abort) => deps.handlers['POST /sleep']({ home: I.home, abort }));
    if (aborted || r?.aborted) return { skip: '睡觉被紧急动作或命令打断' };
    if (r?.sleeping || r?.already) event('sleep', '天黑了，在家上床睡了');
    else {
      I.sleepRetryAt = Date.now() + S.retryMs;
      if (!I.sleepToldNight || Date.now() - I.sleepToldNight > 600000) {
        I.sleepToldNight = Date.now();
        event('sleep_failed', `天黑了想睡，没睡成：${String(r?.error || '不知道为什么').slice(0, 80)}（过几分钟再试）`);
      }
    }
    return { did: 'sleep' };
  }

  // ---- 换更好的护甲
  async function tryArmor () {
    const A = I.cfg.armor;
    if (!A.enabled || Date.now() - (I.lastArmorAt || 0) < A.everyMs) return null;
    I.lastArmorAt = Date.now();
    const sl = bot.inventory.slots;
    const worn = { head: sl[5]?.name ?? null, torso: sl[6]?.name ?? null, legs: sl[7]?.name ?? null, feet: sl[8]?.name ?? null };
    const items = bot.inventory.items().map(i => ({ name: i.name, slot: deps.hands.slotByName(i.name) })).filter(i => ['head', 'torso', 'legs', 'feet'].includes(i.slot));
    const plan = pickArmor(worn, items);
    if (!plan.length) return null;
    const p0 = plan[0];
    const { r } = await runJob('armor', { route: 'POST /wear' }, async () => {
      const it = bot.inventory.items().find(i => i.name === p0.name);
      if (!it) return { error: '背包里没了' };
      await bot.equip(it, p0.slot);
      await new Promise(res => setTimeout(res, 300));
      const idx = { head: 5, torso: 6, legs: 7, feet: 8 }[p0.slot];
      return { worn: bot.inventory.slots[idx]?.name === p0.name };
    });
    note({ kind: 'armor', ...p0, ok: !!r?.worn });
    if (r?.worn) event('armor', `换上了 ${p0.name}${p0.from ? `（原来穿的是 ${p0.from}）` : ''}`);
    return { did: 'armor' };
  }

  // ---- 开宝箱 / 进建筑
  I.visitedStructures ||= new Set();
  let signIds = null;
  // structureBlocks 结果缓存：findBlocks 是全量扫（40 格 ×128），每拍都跑明显拖 tick。
  // 缓存 3 秒；她走动了 4 格以上就作废（换地方了，旧的扫描结果不作数）。
  let sbCache = null;
  const structureBlocks = (radius) => {
    const self = bot.entity?.position;
    if (sbCache && Date.now() - sbCache.at < 3000 && self && (!sbCache.from || self.distanceTo(sbCache.from) <= 4)) return sbCache.list;
    if (!signIds) signIds = Object.values(bot.registry.blocksByName).filter(b => STRUCTURE_SIGNS.some(S => S.re.test(b.name))).map(b => b.id);
    const list = bot.findBlocks({ matching: signIds, maxDistance: radius, count: 128 })
      .map(p => bot.blockAt(p)).filter(b => b && bot.canSeeBlock(b)).map(b => ({ name: b.name, pos: b.position }));
    sbCache = { at: Date.now(), from: self ? self.clone() : null, list };
    return list;
  };
  const summarizeLoot = (checked = []) => {
    const got = {};
    for (const c of checked) for (const [k, n] of Object.entries(c.looted || {})) got[k] = (got[k] || 0) + n;
    const top = Object.entries(got).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k.replace(/^minecraft:/, '')}×${n}`);
    const opened = checked.filter(c => !c.error).length;
    const failed = checked.filter(c => c.error).map(c => `${c.name}：${c.error}`).slice(0, 2);
    return { opened, top, failed };
  };
  async function tryLoot (nightOut) {
    const L = I.cfg.loot;
    if (!L.enabled || Date.now() - (I.lastLootAt || 0) < L.cooldownMs) return null;
    const self = bot.entity.position;
    const chests = deps.hands.unseenChests(bot, state, L.radius).length + deps.hands.unseenCarts(bot, state, 16).length;
    const bp = state.backpackSeen;
    // 同一拍里 recognizeStructures 只算一次（以前结构那一支算两遍，等于白扫两趟）
    const structs = chests ? [] : recognizeStructures(structureBlocks(L.structRadius));
    const pick = pickLoot({
      chests, structures: structs,
      hp: bot.health ?? 20, free: bot.inventory.emptySlotCount(),
      packFree: deps.hands.wearingBackpack?.(bot, state) && bp ? bp.slots - bp.used : null,
      nightOut, visited: I.visitedStructures, self,
    }, L);
    // 认出有 boss 的遗迹：只告诉 mind（一座一次），去不去她定
    if (!chests) {
      for (const S of structs.filter(x => x.danger)) {
        if (I.told.has(`danger:${S.key}`)) continue;
        I.told.add(`danger:${S.key}`);
        event('structure_danger', `认出附近是${S.label}（${S.anchor.x},${S.anchor.y},${S.anchor.z}），里面有好东西但很危险，没自己进去`, { structure: S.label, pos: S.anchor });
      }
    }
    if (!pick.mode) return pick;
    I.lastLootAt = Date.now();
    if (pick.mode === 'open') {
      const { r, aborted } = await runJob('loot', { route: 'POST /chests/check' }, (abort) => deps.handlers['POST /chests/check']({ radius: L.radius, home: I.home, max: 4, abort }));
      const sm = summarizeLoot(r?.checked);
      note({ kind: 'loot', opened: sm.opened, aborted: aborted || undefined, error: r?.error });
      if (sm.opened || sm.failed.length) event('loot', `开了 ${sm.opened} 个箱子${sm.top.length ? `，拿到：${sm.top.join('、')}` : ''}${sm.failed.length ? `；没开成：${sm.failed.join('；')}` : ''}`);
      return { did: 'loot' };
    }
    const S = pick.structure;
    I.visitedStructures.add(S.key);   // 先记下：进不去也别来回折腾
    event('structure', `认出附近有${S.label}（${S.anchor.x},${S.anchor.y},${S.anchor.z}，${Math.round(S.dist)} 格），里面应该有宝箱，进去看看`, { structure: S.label, pos: S.anchor });
    const { r, aborted } = await runJob('loot', { route: 'POST /chests/check' }, async (abort) => {
      const g = await deps.handlers['POST /go']({ x: S.anchor.x, y: S.anchor.y, z: S.anchor.z, range: 3, abort });
      if (abort()) return { checked: [] };
      const near = { ...S.anchor, r: L.structNear };
      const res = await deps.handlers['POST /chests/check']({ radius: L.structNear + 6, home: I.home, max: 6, near, abort });
      return { ...res, arrived: g?.arrived };
    });
    const sm = summarizeLoot(r?.checked);
    note({ kind: 'explore', structure: S.label, opened: sm.opened, aborted: aborted || undefined, error: r?.error });
    if (!aborted) {
      event('structure_done', sm.opened
        ? `${S.label}里开了 ${sm.opened} 个箱子${sm.top.length ? `，拿到：${sm.top.join('、')}` : ''}`
        : `${S.label}里没找到能开的箱子${r?.arrived === false ? '（没走进去）' : ''}${sm.failed.length ? `：${sm.failed.join('；')}` : ''}`);
    }
    return { did: 'explore' };
  }

  // ---- 洞穴探险
  async function tryCave () {
    const C = I.cfg.cave;
    I.caveDone ||= new Set();
    if (!C.enabled || !deps.hands.inCave?.(bot)) return null;
    const boundary = caveBoundary(bot.entity.position, I.home);
    if (boundary) return { skip: boundary };
    if ((bot.health ?? 20) < C.minHp) return { skip: `血 ${bot.health}，先不逛洞` };
    const here = bot.entity.position.floored();
    const caveKey = (p) => `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
    // 换了一个洞（离上一个洞的入口够远）：重新开始记
    if (!I.cave || Math.hypot(here.x - I.cave.entry.x, here.y - I.cave.entry.y, here.z - I.cave.entry.z) > C.range) {
      const key = caveKey(here);
      if (I.caveDone.has(key)) return { skip: '这个洞逛过了' };
      I.cave = { key, entry: { x: here.x, y: here.y, z: here.z }, steps: 0, visited: new Set() };
      event('cave', `当前位置像洞穴（${here.x},${here.y},${here.z}），自动探洞本能准备探索；未记录进入方式`, { pos: I.cave.entry, source: 'instinct', entryMethod: 'unknown' });
    }
    if (I.cave.steps >= C.maxSteps) {
      if (!I.caveDone.has(I.cave.key)) { I.caveDone.add(I.cave.key); event('cave_done', `这个洞逛了 ${I.cave.steps} 步，差不多了`); }
      return { skip: '这个洞逛完了' };
    }
    // 候选落脚点：附近的空气格里，脚下实心、头顶也空的
    const airIds = ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x != null);
    const isLava = (p) => /lava/.test(bot.blockAt(p)?.name || '');
    const cells = [];
    for (const p of bot.findBlocks({ matching: airIds, maxDistance: C.scan, count: 600 })) {
      const below = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
      if (!below || below.boundingBox !== 'block' || !head || head.boundingBox !== 'empty') continue;
      const feet = bot.blockAt(p);
      cells.push({
        pos: p,
        visible: bot.canSeeBlock(below),
        lavaNear: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([dx, dy, dz]) => isLava(p.offset(dx, dy, dz))),
        dark: (feet?.light ?? 0) < 4,
      });
    }
    const step = pickCaveStep({ cells, self: bot.entity.position, entry: I.cave.entry, visited: I.cave.visited }, C);
    if (!step) {
      // 同一洞之后每 400ms 仍会走到这里。只在第一次完成时记事件，避免 mind
      // 收到几十条相同“探完了”并误以为她反复执行过探险任务。
      if (!I.caveDone.has(I.cave.key)) {
        I.caveDone.add(I.cave.key);
        event('cave_done', `这个洞看得见的地方都走过了（${I.cave.steps} 步）`);
      }
      return { skip: '洞里没有新地方了' };
    }
    I.cave.visited.add(step.cell);
    I.cave.visited.add(`${Math.floor(here.x / C.visitCell)},${Math.floor(here.y / C.visitCell)},${Math.floor(here.z / C.visitCell)}`);
    I.cave.steps++;
    const from = { x: here.x, y: here.y, z: here.z };
    const { r, aborted } = await runJob('cave', null, async (abort) => {
      const g = await deps.handlers['POST /go']({ x: step.pos.x, y: step.pos.y, z: step.pos.z, range: 1.5, maxMs: 20000, abort });
      if (!abort()) { try { await deps.handlers['POST /light_up']({ max: 1 }); } catch (_) {} }
      return g;
    });
    note({ kind: 'cave', from, to: step.pos, step: I.cave.steps, aborted: aborted || undefined, arrived: r?.arrived, error: r?.error });
    if (!aborted && r?.arrived === true) event('cave_move', `自动探洞本能执行走路：从（${from.x},${from.y},${from.z}）走到（${step.pos.x},${step.pos.y},${step.pos.z}）；这是寻路到达记录，不是挖穿或坠落的证据`, { from, to: step.pos, action: 'go', arrived: true });
    return { did: 'cave' };
  }

  // ---- 寻路挖掘白名单：本连接的方块 id（按整合包方块标签算一次）
  let natIds = null;
  const naturalIds = () => {
    if (natIds) return natIds;
    let tagOf = () => undefined;
    try { const kb = require('../knowledge/knowledge').load(); tagOf = (t) => kb.tags.get(`block:${t}`); } catch (_) {}
    const reg = bot.registry;
    natIds = new Set();
    for (const n of deps.pathing.naturalDigNames(tagOf)) {
      const b = reg.blocksByName[n] || reg.blocksByName[n.replace(/^minecraft:/, '')];
      if (b) natIds.add(b.id);
    }
    return natIds;
  };
  const builtNear = (p) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (b && deps.isPlayerBuilt?.(b.name)) return true;
    }
    return false;
  };

  // ---- 指令本能
  let cmdCache = { at: 0, set: new Set() };
  const serverCmds = async () => {
    if (Date.now() - cmdCache.at < 300000) return cmdCache.set;
    try { const r = await deps.handlers['GET /commands'](); cmdCache = { at: Date.now(), set: new Set(r?.all || []) }; } catch (_) {}
    return cmdCache.set;
  };
  const runCmd = async (cmd, why, { selfTp = false } = {}) => {
    I.lastCmdAt = Date.now();
    let r = null;
    // selfTp：把她自己 /tp 回去过的坐标 —— 管理员命令里唯一放给本能的（runCommand 只认 tp x y z + 这个函数）
    try { r = await deps.handlers['POST /cmd']({ command: cmd, ...(selfTp ? { selfTp: () => 'self-tp' } : {}) }); } catch (e) { r = { error: e.message }; }
    event('command', `${why}：用了 /${cmd}${r?.error ? `，没成：${r.error}` : (r?.serverSaid?.length ? `（服务器说：${r.serverSaid.join(' / ').slice(0, 80)}）` : '')}`, { cmd });
    return r;
  };
  const dimNow = () => String(bot.game?.dimension || '').replace(/^minecraft:/, '') || '?';
  bot.on('death', () => {
    try {
      const p = bot.entity.position.floored();
      // 身边 3×3×3 有岩浆就算"死在岩浆里"：掉的东西多半烧了，/back 回去也是站进岩浆边（以前只看脚、头、脚下 3 格会漏）
      let lava = false;
      for (let dx = -1; dx <= 1 && !lava; dx++) for (let dy = -1; dy <= 1 && !lava; dy++) for (let dz = -1; dz <= 1 && !lava; dz++) lava = /lava/.test(bot.blockAt(p.offset(dx, dy, dz))?.name || '');
      I.death = { pos: { x: p.x, y: p.y, z: p.z }, dim: dimNow(), at: Date.now(), lava, recovered: false };
      if (I.running) I.running.abort();
    } catch (_) {}
  });
  bot.on('spawn', () => {
    // 重生（spawn 在死后重生时也会发）：告诉 mind，再回去捡
    const d = I.death;
    if (!d || d.told) return;
    d.told = true;
    event('died', `死了一次（死在 ${d.pos.x},${d.pos.y},${d.pos.z}，${d.dim}${d.lava ? '，掉进了岩浆' : ''}），已经重生；身上的东西掉在那里，5 分钟内不捡就没了`, { pos: d.pos });
  });
  async function tryRecover () {
    const d = I.death;
    if (!I.cfg.cmd.enabled || !d || d.recovered || !d.told) return null;
    const cmds = await serverCmds();
    const pick = pickRecovery({ death: d, here: bot.entity.position, dim: dimNow(), hasBack: cmds.has('back'), hasTp: cmds.has('tp'), sinceMs: Date.now() - d.at }, I.cfg.cmd);
    // 先置位，别让同一次死在下一拍又发一遍。但**被打断不算回收过了** ——
    // 战斗本能打断 / 让出身体时这一趟白跑，允许下一拍再试一次（最多多试 1 次，不无限来回）。
    d.recovered = true;
    const tries = d.recoverTries = (d.recoverTries || 0) + 1;
    const allowRetry = tries < 2;   // 第 1 次被打断就再给一次；第 2 次之后不再试
    if (!pick.how) { event('recover_skip', `没回去捡东西：${pick.skip}`); return { skip: pick.skip }; }
    const { r, aborted } = await runJob('recover', { instinct: 'pickup' }, async (abort) => {
      if (pick.how === 'back') await runCmd('back', '回死的地方捡东西');
      else if (pick.how === 'tp') await runCmd(`tp ${d.pos.x} ${d.pos.y + 1} ${d.pos.z}`, '传回死的地方捡东西', { selfTp: true });
      else {
        event('recover', `走回死的地方捡东西（${pick.dist} 格）`);
        const g = await deps.handlers['POST /go']({ x: d.pos.x, y: d.pos.y, z: d.pos.z, range: 3, maxMs: 240000, abort });
        if (abort() || g?.arrived === false) return { error: `没走到${g?.error ? `：${g.error}` : ''}` };
      }
      if (abort()) return {};
      return deps.handlers['POST /pickup']({ radius: 10, count: 32, timeoutMs: 6000, abort });
    });
    if (!aborted) event('recover_done', r?.error ? `回去捡东西没成：${r.error}` : `回到死的地方，捡回来 ${r?.picked ?? 0} 件`);
    else if (allowRetry) d.recovered = false;   // 被打断 → 放开一次，下一拍再来（最多 1 次）
    return { did: 'recover' };
  }
  async function tryCommand (nightOut) {
    if (!I.cfg.cmd.enabled) return null;
    const cmds = await serverCmds();
    if (!cmds.size) return null;
    const h = I.home;
    const pick = pickCommand({
      cmds, hp: bot.health ?? 20, fleeing: I.running?.kind === 'combat' && I.combat?.retreating, nightOut,
      homeDist: h ? Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) : null,
      atHome: inHome(bot.entity.position) === true, homeSynced: !!(h && I.homeSyncedAt && I.homeSyncedFor === `${h.center.x},${h.center.z}`),
      sinceLast: Date.now() - (I.lastCmdAt || 0),
      day: deps.night?.phaseOf(bot.time?.timeOfDay) === 'day', returnTo: I.returnTo?.pos || null, sameDim: !I.returnTo || I.returnTo.dim === dimNow(),
    }, I.cfg.cmd);
    if (!pick) return null;
    const from = bot.entity.position.floored();
    const r = await runCmd(pick.cmd, pick.why, { selfTp: !!pick.selfTp });
    if (pick.cmd === 'sethome' && !r?.error) { I.homeSyncedAt = Date.now(); I.homeSyncedFor = `${h.center.x},${h.center.z}`; }
    if (pick.remember && !r?.error) I.returnTo = { pos: { x: from.x, y: from.y, z: from.z }, dim: dimNow(), at: Date.now() };
    if (pick.returned) I.returnTo = null;   // 成不成都只回一次，不来回传
    return { did: 'command' };
  }

  // ---- 家的范围随基地长大
  let builtIds = null;
  // ---- 家的范围随基地长大
  //
  // ⚠️ 这一段曾经是**同步**的一大坨（2026-09-28 修）：`findBlocks` 是同步函数，一次要逐格扫
  // 十几万到几百万格（基准见 modpack-study/fix6-20260928/bench-findblocks.js），
  // 4 次大扫描叠起来把整个事件循环堵住十几秒 —— 实机 `scheduler.lagMs` 每 5 分钟飙到 13.5~14 秒。
  // 现在：每个大扫描之间 `await yieldLoop()` 让出事件循环；扫描本身按**竖直分段**（小 maxDistance）
  // 拆成多轮，单轮同步占用控制在 50ms 以内。目标是"任何一个计时器回调单次同步 < 50ms"。
  const yieldLoop = () => new Promise(res => setImmediate(res));

  // 方块 id → 它在"人造方块名单"里。用 Set 而不是 Array.includes：逐格判定是热路径（几百万次）

  /**
   * 逐 **chunk 列**（16×16 的水平柱）扫人造方块 —— 2026-09-28 第 8 批真修。
   *
   * 为什么不是 `findBlocks`：它是**同步**函数，而且候选 section 是按八面体一层层往外扩的
   * （mineflayer/lib/plugins/blocks.js:164），maxDistance 越大层数越多、扫的 section 越多 ——
   * 批次 6 按距离拆成 32/64/91 三段，每段仍是**一次同步调用**，体积随半径三次方长，
   * 实机一条 `slow home.scanBuilt d=91 13049` = 单次同步 13 秒。
   *
   * 现在：把扫描拆成"一列一列"，列与列之间 `await yieldLoop()` 让出事件循环，
   * 单列的同步成本 = 列内 section 数 × 每 section 的逐格成本，和整圆半径无关。
   * 列内**先看 section.palette**：这节里一个目标 id 都没有就整节跳过（不逐格扫 4096 格）。
   *
   * @param {object} c        扫描中心（Vec3 形状即可：有 x/y/z）
   * @param {number[]} ids    目标方块 id 列表（人造方块名单）
   * @param {number} maxDist  水平半径（列的选择用圆柱，竖直范围另给）
   * @param {number} cap      最多返回几个（0 = 不限）
   * @param {object} [opts]
   * @param {number|null} [opts.minDist]  只扫这么远**之外**的列（家生长的前沿环带）；null/0 = 从中心开始
   * @param {number} [opts.dy]            竖直范围：|y - c.y| <= dy 才算（和原来的 filter 一致）
   * @param {string} [opts.label]         slow 日志里的名字
   * @returns {Promise<{pts: Array, sections: number, cells: number, columns: number, worstMs: number}>}
   */
  async function scanColumns (bot, c, ids, maxDist, cap = 0, opts = {}) {
    const r = await scanColumnsIn({ world: bot.world, registry: bot.registry, c, ids, maxDist, cap, opts, yieldFn: yieldLoop });
    if (r.worstMs > 200) slow(`${opts.label || 'home.scanColumns'} n=${r.pts.length}`, r.worstMs);
    return r;
  }
  let homeScanBusy = false;
  const homeTimer = setInterval(async () => {
    if (homeScanBusy) return;                             // 上一轮还没跑完（分列后可能跨多拍）：别叠
    try {
      const H = I.cfg.home; const h = I.home;
      // grow 只管“家的范围随基地长大”那一段；耕地干了 / 暗处提醒不受它影响（以前一起被挡掉）
      if (!h || !bot.entity) return;
      if (Date.now() - (I.lastHomeScan || 0) < H.everyMs) return;
      if (Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) > h.radius + H.near) return;   // 不在家附近：区块可能没加载，数不准
      homeScanBusy = true;
      I.lastHomeScan = Date.now();
      try {
        if (!builtIds) builtIds = Object.values(bot.registry.blocksByName).filter(b => deps.isPlayerBuilt?.(b.name) || /farmland/.test(b.name)).map(b => b.id);
        const { Vec3 } = require('vec3');
        const c = new Vec3(h.center.x, h.center.y, h.center.z);
        // ① 家的范围：每 30 分钟只扫**当前半径外的环带**（生长前沿），不再扫整个圆盘。
        //    理由：家里的方块上次已经数过，反复扫整个圆盘是 99% 的重复劳动（也是 13 秒冻结的来源）。
        //    环带 = 半径 (h.radius - 4) 之外、到 cap 为止；只要前沿还在长，半径就会继续涨，
        //    下一轮环带自然往外推（r-4 的重叠保证不会因为一格之差漏掉）。
        const geoR = Math.min(H.cap, h.radius + H.near);
        const band = { minDist: Math.max(0, Math.min(h.radius, geoR) - 4), dy: 16, label: 'home.scanRing' };
        const scan = H.grow ? await scanColumns(bot, c, builtIds, geoR, 4000, band) : { pts: [] };
        const pts = scan.pts;
        const r = H.grow ? homeFootprint(pts.map(p => Math.hypot(p.x - h.center.x, p.z - h.center.z)), h.radius, H) : h.radius;
        await yieldLoop();
        // ② 家里的耕地湿不湿（moisture=0 = 4 格内没水，会退化回泥土、庄稼长得慢）—— 只告诉 mind，不自己引水（会动主人的布局）
        //    半径封顶 32 + 分列扫描：以前用 findBlocks 一次同步扫 h.radius（最大 128）格半径的圆盘。
        const dryIds = ['farmland'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
        const dryScan = await scanColumns(bot, c, dryIds, Math.min(geoR, 32), 400, { dy: 16, label: 'home.scanFarmland' });
        const dryPts = dryScan.pts;
        // 每个点都要 blockAt 读 moisture：分段让出，别一次全读完
        const dry = [];
        for (let i = 0; i < dryPts.length; i++) {
          const b = bot.blockAt(dryPts[i]);
          if (b && +(b.getProperties?.().moisture ?? 7) === 0) dry.push(b);
          if ((i + 1) % 100 === 0) await yieldLoop();
        }
        const day = Math.floor(Date.now() / 86400000);
        if (dry.length && I.dryToldDay !== day) {
          I.dryToldDay = day;
          const p0 = dry[0].position;
          event('farmland_dry', `家里有 ${dry.length} 块耕地是干的（比如 ${p0.x},${p0.y},${p0.z}）：4 格内没有水，会退化回泥土、庄稼长得慢`, { count: dry.length });
        }
        await yieldLoop();
        // ③ 家里有没有暗处（光照 0 夜里会刷怪）—— 只告诉 mind，不自己插火把
        if (I.darkToldDay !== day) {
          const LIGHT_RE = /(^|:|_)(torch|lantern|glowstone|shroomlight|froglight|campfire|redstone_lamp|end_rod|candle|light)$/;
          const srcIds = Object.values(bot.registry.blocksByName).filter(b => LIGHT_RE.test(b.name) && !/redstone_torch|soul_torch_off/.test(b.name)).map(b => b.id);
          const srcScan = await scanColumns(bot, c, srcIds, Math.min(geoR, 32), 64, { dy: 8, label: 'home.scanLights' });
          const sourceLights = srcScan.pts.filter(p => Math.abs(p.y - h.center.y) <= 8).map(p => bot.blockAt(p)?.light);
          await yieldLoop();
          const airIds = ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
          const airScan = await scanColumns(bot, c, airIds, Math.min(h.radius, 32), 3000, { dy: 4, label: 'home.scanAir' });
          const airPts = airScan.pts;
          // cells 循环里每格要 3 次 blockAt：分段让出（原来一次性同步跑 3000 格）
          const cells = [];
          for (let i = 0; i < airPts.length; i++) {
            const p = airPts[i];
            if (Math.abs(p.y - h.center.y) <= 4) {
              const below = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
              if (below && below.boundingBox === 'block' && !/farmland|glass|leaves|slab|stairs|carpet|water|lava/.test(below.name)
                && head && head.boundingBox === 'empty') {
                cells.push({ pos: { x: p.x, y: p.y, z: p.z }, light: bot.blockAt(p)?.light });
              }
            }
            if ((i + 1) % 200 === 0) await yieldLoop();
          }
          const d = darkReport({ sourceLights, cells });
          if (d) {
            I.darkToldDay = day;
            if (d.kind === 'unreadable') I.lastDarkNote = '家里有光源，但亮度读出来都是暗的 —— 读不到亮度，不报暗处';
            else if (d.kind === 'no_source') event('dark_spot', '家里一个光源（火把、灯）都没看到，夜里整片都会刷怪', { count: cells.length });
            else event('dark_spot', `家里有 ${d.count} 格地面是全黑的（比如 ${d.sample.map(q => `${q.x},${q.y},${q.z}`).join(' / ')}），夜里会刷怪`, { count: d.count, sample: d.sample });
          }
        }
        if (r > h.radius + 2) {
          const old = h.radius;
          h.radius = r;
          event('home_grow', `家的范围跟着房子长大了：半径 ${old} → ${r} 格（环带扫到 ${pts.length} 块人造方块）`, { radius: r, center: h.center });
        }
      } finally { homeScanBusy = false; }
    } catch (_) { homeScanBusy = false; }
  }, 30000);

  // ---- 搭路 / 落地水：按身上的东西随时调寻路（有搭脚方块才搭路；有水桶才敢往下跳高）
  const policyTimer = setInterval(() => {
    try {
      const mv = bot.pathfinder?.movements;
      if (!mv || !bot.inventory || !deps.pathing) return;
      const names = new Set(bot.inventory.items().map(i => i.name));
      const nether = /nether/.test(String(bot.game?.dimension || ''));
      const drop = deps.pathing.setDropAllowance(mv, { water: I.cfg.mlg.enabled && names.has('water_bucket'), nether });
      let sc = { scaffolding: 0 };
      if (I.cfg.bridge.enabled && !state.noScaffoldDepth) {
        const ids = (deps.hands.scaffoldIds ? deps.hands.scaffoldIds() : deps.hands.SCAFFOLD_IDS).map(n => bot.registry.itemsByName[n.replace(/^minecraft:/, '')]?.id).filter(x => x != null);
        sc = deps.pathing.setScaffold(mv, { itemIds: ids, forbid: (p) => inHome(p) === true });
      } else deps.pathing.setScaffold(mv, {});
      // 寻路挖掘：只挖天然地形（白名单），家里不挖，紧挨人造方块不挖
      let dg = { mode: 'leavesOnly' };
      if (I.cfg.dig.enabled && deps.pathing.setDigPolicy) {
        dg = deps.pathing.setDigPolicy(mv, { naturalIds: naturalIds(), forbid: (p) => inHome(p) === true, builtNear });
      }
      I.movePolicy = { maxDrop: drop, scaffoldKinds: sc.scaffolding, scaffoldCount: mv.countScaffoldingItems?.() ?? null, homeGuard: !!I.home, dig: dg };
    } catch (_) {}
  }, 2000);

  // ---- 落地水反射（每个物理 tick）
  const M = { startY: null, placed: null, equipping: false, collecting: false };
  // "身上有没有水桶"缓存：physicsTick 每 50ms 跑一次，以前每次都遍历整个背包（物品多时白烧 CPU）。
  // 背包变化（mineflayer 的 window 插件在格子变动时发 updateSlot）才失效。读不到时就现算一次。
  let waterBucket = null;
  const hasWaterBucket = () => {
    if (waterBucket === null) waterBucket = bot.inventory.items().some(i => i.name === 'water_bucket');
    return waterBucket;
  };
  try { bot.inventory?.on?.('updateSlot', () => { waterBucket = null; }); } catch (_) {}
  const groundBelow = (p) => {
    const f = p.floored();
    for (let dy = 0; dy <= 40; dy++) {
      const b = bot.blockAt(f.offset(0, -dy, 0));
      if (!b) return null;
      if (/water/.test(b.name)) return { y: b.position.y + 1, water: true };
      if (b.boundingBox === 'block') return { y: b.position.y + 1, water: false, pos: b.position };
    }
    return null;
  };
  async function collectWater () {
    if (M.collecting || !M.placed) return;
    M.collecting = true;
    try {
      await sleepMs(250);
      const bucket = bot.inventory.items().find(i => i.name === 'bucket');
      if (bucket && bot.heldItem?.name !== 'bucket') await bot.equip(bucket, 'hand');
      const tgt = M.placed.pos;
      for (let k = 0; k < 3 && !bot.inventory.items().some(i => i.name === 'water_bucket'); k++) {
        await bot.lookAt(tgt.offset(0.5, 0.1, 0.5), true);
        bot.activateItem();
        await sleepMs(300);
      }
      const ok = bot.inventory.items().some(i => i.name === 'water_bucket');
      event('mlg', ok ? `从 ${Math.round(M.placed.fall)} 格高掉下来，落地前倒了水、又收回来了` : `从 ${Math.round(M.placed.fall)} 格高掉下来倒了水，但水没收回来（${tgt.x},${tgt.y},${tgt.z}）`);
    } catch (_) {} finally { M.placed = null; M.collecting = false; }
  }
  bot.on('physicsTick', () => {
    try {
      const e = bot.entity;
      if (!e || !I.cfg.mlg.enabled) return;
      if (e.onGround || e.isInWater || e.isInLava) {
        M.startY = null;
        if (M.placed && !M.collecting && (e.velocity?.y ?? 0) > -0.1) collectWater();
        return;
      }
      if (M.startY == null || e.position.y > M.startY) M.startY = e.position.y;
      const g = groundBelow(e.position);
      const act = mlgStep({
        startY: M.startY, y: e.position.y, vy: e.velocity?.y ?? 0, landY: g?.y ?? null, landIsWater: !!g?.water,
        hasBucket: hasWaterBucket(), holding: bot.heldItem?.name === 'water_bucket',
        nether: /nether/.test(String(bot.game?.dimension || '')), placed: !!M.placed,
      });
      if (act === 'equip' && !M.equipping) {
        M.equipping = true;
        const it = bot.inventory.items().find(i => i.name === 'water_bucket');
        bot.equip(it, 'hand').catch(() => {}).finally(() => { M.equipping = false; });
      } else if (act === 'place') {
        bot.look(e.yaw, -Math.PI / 2, true);   // 低头看正下方
        bot.activateItem();
        M.placed = { pos: g.pos.offset(0, 1, 0), fall: M.startY - g.y };
        state.ledger?.note({ route: 'mlg' });
      }
    } catch (_) {}
  });

  // ---- 赶路 / 干别的时候看见值钱的矿：不打断命令，告诉 mind（一个位置一次）
  const oreWatch = setInterval(() => {
    try {
      if (!bot.entity || !I.cfg.mine.enabled) return;
      if (!(I.inflight > 0 || (state.currentAction && !/^following /.test(state.currentAction)))) return;   // 闲着时采矿本能自己会去
      const T = loadTables();
      if (!T.ores.size) return;
      const pick = pickaxeTier(carriedNames(bot, state).names);   // 算上精妙背包里的镐子（N-9）
      for (const p of bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: 12, count: 96 })) {   // 同上：别让埋着的占满名额
        const b = bot.blockAt(p); if (!b || !oreVisible(b)) continue;   // 同一判据：露出一面也算看得见
        const row = T.ores.get(b.type);
        const isIron = (row.drops || []).some(d => /raw_iron|iron_ingot/.test(d));
        if (!(row.value === 'high' || (pick < TIER.iron && isIron))) continue;
        const k = `${p.x},${p.y},${p.z}`;
        if (I.told.has(`seen:${k}`)) continue;
        I.told.add(`seen:${k}`);
        event('ore_seen', `路上看见 ${row.name}（${k}）${pick >= needTier(row.tier) ? '' : `，不过要${TIER_NAME[needTier(row.tier)]}`}`, { ore: row.name, pos: { x: p.x, y: p.y, z: p.z } });
      }
    } catch (_) {}
  }, 2000);

  // ---- 随身物品：缺什么（告诉 mind）/ 回家整理
  const kitNow = () => {
    // 精妙背包里的也算"随身"（N-9）：镐子/吃的/火把在背包里时，不该报"身上没带够"。
    // 背包读不到就只算身上的（下面的 pack.free/has 本来就会说明"读不到"）。
    const tally = carriedTally(bot, state);
    const items = Object.entries(tally.have).map(([name, count]) => ({ name, count }));
    const short = deps.hands.kitShortfall(bot, items).filter(x => x.essential).map(x => x.label);
    // 家里箱子里记得有什么（开过的箱子，hands.noteSeen 记的）
    const homeItems = [];
    for (const c of state.seenContainers?.values?.() || []) {
      const [x, y, z] = String(c.key).split(',').map(Number);
      if (inHome({ x, y, z }) !== true) continue;
      for (const [name, count] of Object.entries(c.items || {})) homeItems.push({ name, count });
    }
    const atHomeHas = short.length ? deps.hands.kitAvailable(bot, homeItems, short) : [];
    // 精妙背包：背着就算一层"随身仓库"。里面有什么是上次打开时记的（不开看不到）
    let pack = null;
    if (deps.hands.wearingBackpack?.(bot, state)) {
      const bp = state.backpackSeen;
      const packItems = Object.entries(bp?.items || {}).map(([name, count]) => ({ name, count }));
      pack = { free: bp ? bp.slots - bp.used : null, readable: tally.readable, has: short.length ? deps.hands.kitAvailable(bot, packItems, short) : [] };
    }
    return { short, atHomeHas, homeKnown: homeItems.length > 0, pack };
  };
  const kitTimer = setInterval(() => {
    try {
      if (!bot.entity || !bot.inventory) return;
      const k = kitNow();
      const sig = k.short.join(',');
      if (sig === (I.kitSig ?? '')) return;
      I.kitSig = sig;
      if (!k.short.length) return;
      const have = [k.pack && !k.pack.readable ? '背包读不到（只算了身上的）' : null,
        k.pack?.has?.length ? `背包里有：${k.pack.has.join('、')}` : null,
        k.atHomeHas.length ? `家里箱子里有：${k.atHomeHas.join('、')}` : (k.homeKnown ? '家里的箱子里也没看到' : null)].filter(Boolean).join('；');
      event('kit_short', `身上没带够：${k.short.join('、')}${have ? `（${have}）` : ''}`, { short: k.short });
    } catch (_) {}
  }, CFG.tidy.checkMs);

  async function tryTidy (nightOut) {
    const TD = I.cfg.tidy;
    if (!TD.enabled || Date.now() - (I.lastTidyCheck || 0) < TD.checkMs) return null;
    I.lastTidyCheck = Date.now();
    const k = kitNow();
    const h = I.home;
    const pick = pickTidy({
      free: bot.inventory.emptySlotCount(), short: k.short, atHomeHas: k.atHomeHas,
      homeDist: h ? Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) : null,
      nightOut, sinceLast: Date.now() - (I.lastTidyAt || 0),
      pack: k.pack, sincePack: Date.now() - (I.lastPackAt || 0),
    }, TD);
    if (!pick.go) return pick;
    if (pick.where === 'backpack') {
      I.lastPackAt = Date.now();
      const { r, aborted } = await runJob('tidy', { route: 'POST /backpack/tidy' }, (abort) => deps.handlers['POST /backpack/tidy']({ abort }));
      note({ kind: 'backpack', why: pick.why, aborted: aborted || undefined, stashed: r?.stashed, took: r?.took, error: r?.error });
      if (!aborted && (r?.stashed || r?.took || r?.error)) {
        event('backpack', r?.error ? `想倒腾背包（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
          : `倒腾了一下背包：装进去 ${r.stashed} 组、拿出来 ${r.took} 组${r.backpackFree != null ? `（背包还剩 ${r.backpackFree} 格）` : ''}`);
      }
      return { did: 'backpack' };
    }
    I.lastTidyAt = Date.now();
    const { r, aborted } = await runJob('tidy', { route: 'POST /storage/organize' }, async (abort) => {
      if (inHome(bot.entity.position) !== true) {
        const g = await deps.handlers['POST /go']({ x: h.center.x, y: h.center.y, z: h.center.z, range: 3, abort });
        if (abort() || g?.arrived === false) return { error: `没走到家${g?.error ? `：${g.error}` : ''}` };
      }
      // 背着背包：先把背包里的倒出来一起整理（不然背包满了就永远满着，每次都白跑回家）。最多两轮
      let r = null; let unpacked = 0;
      const organizeArgs = storagePolicy.storageRequest(h, { abort, mode: 'daily' }, { discover: false });
      if (!organizeArgs.only?.length) return { error: '家里没有可自动整理的已登记箱子（还没登记，或都受保护）；不会猜哪些箱子能动' };
      for (let round = 0; round < 2 && !abort(); round++) {
        let u = null;
        if (deps.hands.wearingBackpack?.(bot, state)) {
          try { u = await deps.handlers['POST /backpack/tidy']({ stash: false, restock: false, unpack: true, abort }); } catch (_) {}
          unpacked += u?.unpacked || 0;
        }
        r = await deps.handlers['POST /storage/organize'](organizeArgs);
        if (!u?.unpacked) break;
      }
      return { ...r, unpacked };
    });
    const after = kitNow();
    note({ kind: 'tidy', why: pick.why, aborted: aborted || undefined, moved: r?.moved, error: r?.error });
    if (!aborted) {
      event('tidy', r?.error
        ? `想回家整理（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
        : `${r?.completed === false ? '回家整理了一部分' : '回家整理了'}（${pick.why}）：搬了 ${r?.moved ?? 0} 组${r?.unpacked ? `（其中从背包倒出来 ${r.unpacked} 组）` : ''}${after.short.length ? `；还缺 ${after.short.join('、')}` : '，该带的都带上了'}`,
      r?.boxes ? { storage: { completed: r.completed === true, boxes: r.boxes } } : {});
    }
    return { did: 'tidy' };
  }

  // ---- 转头看人（独立的小节拍：只转头，不占身体、不打断任何动作）
  //
  // 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
  // 所以这里**只对"刚和我互动过"的玩家**转头（窗口见 gazeEngaged）。窗口外 6 格内有人也不看。
  const engage = (player, ms) => {
    if (!player) return;
    try { I.gazeEngagedUntil.set(String(player), Date.now() + ms); } catch (_) {}
  };
  let nextGaze = 0;
  const lookAtPlayer = (ent) => {
    try { bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true); } catch (_) {}
  };
  const idleEyes = () => !I.running && !I.inflight && !bot.isSleeping && !bot.currentWindow && !bot.pathfinder?.isMoving?.() && !bot.targetDigBlock;
  const gazeTimer = setInterval(() => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity || !idleEyes()) return;
      // 过期窗口定期清掉，Map 不无限长
      const now = Date.now();
      for (const [k, at] of I.gazeEngagedUntil) if (now >= +at) I.gazeEngagedUntil.delete(k);
      const players = Object.values(bot.players || {}).filter(p => p.entity && p.entity !== bot.entity).map(p => ({ name: p.username, ent: p.entity, pos: p.entity.position }));
      const g = pickGaze({ players, self: bot.entity.position, now, next: nextGaze, engagedUntil: I.gazeEngagedUntil }, G);
      if (!g) return;
      lookAtPlayer(g.ent);
      nextGaze = now + G.minGapMs + Math.random() * (G.maxGapMs - G.minGapMs);
    } catch (_) {}
  }, 1000);
  // 他跟她说话 → 立刻看一眼，并在 G.talkMs 内保持"可以看他"
  bot.on('chat', (username) => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || username === bot.username) return;
      const ent = bot.players[username]?.entity;
      if (!ent || ent.position.distanceTo(bot.entity.position) > G.chatRadius) return;
      engage(username, G.talkMs);
      if (!idleEyes()) return;
      lookAtPlayer(ent);
      nextGaze = Date.now() + G.maxGapMs;
    } catch (_) {}
  });
  /**
   * 她自己开口说话（bridge 的 `POST /chat` 调）—— 对 16 格内**最近的玩家**开一个 selfTalkMs 的互动窗口。
   * 她刚说完话，看的是"在听她说话的人"，不一定是最近的谁；只有一个玩家时就是他。
   */
  I.noteSelfSpoke = () => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity) return null;
      const near = Object.values(bot.players || {})
        .filter(p => p.entity && p.entity !== bot.entity)
        .map(p => ({ name: p.username, ent: p.entity, d: p.entity.position.distanceTo(bot.entity.position) }))
        .filter(p => p.d <= G.chatRadius)
        .sort((a, b) => a.d - b.d);
      if (!near.length) return null;
      engage(near[0].name, G.selfTalkMs);
      return near[0].name;
    } catch (_) { return null; }
  };

  // ---- 工具快坏了：告诉 mind（一件只说一次；修好 / 换了新的再坏会再说）
  const toolTimer = setInterval(() => {
    try {
      for (const it of bot.inventory.items()) {
        const w = toolWorn({ name: it.name, durabilityUsed: it.durabilityUsed, maxDurability: it.maxDurability, enchanted: (it.enchants || []).length > 0 });
        const k = `${it.name}@${it.slot}`;
        if (!w) { I.toolWarned?.delete(k); continue; }
        I.toolWarned ||= new Set();
        if (I.toolWarned.has(k)) continue;
        I.toolWarned.add(k);
        event('tool_worn', `${it.name} 快坏了（还剩 ${w.left}/${w.max}）${(it.enchants || []).length ? '，有附魔，别用断了' : ''}`, { item: it.name });
      }
    } catch (_) {}
  }, CFG.toolWarn.everyMs);

  // ================================================================ 战斗
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  bot.on('entityDead', (e) => { try { if (I.combat?.engaged.has(e.id)) I.combat.killed.push(e.name); } catch (_) {} });

  /** 现在有哪些对她 / 对玩家有仇恨的目标（带类别、距离） */
  function hostileTargets () {
    const self = bot.entity;
    const out = [];
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === self || e.type === 'player' || deps.isDropEntity(e)) continue;
      const dist = e.position.distanceTo(self.position);
      if (dist > I.cfg.combat.detect + 4) continue;
      const a = deps.aggroOf(e);
      // 静态敌对实体（例如刚刷出的、还没挥拳的僵尸）没有 aggro 记录，
      // 但仍然应该进入战斗本能的视野；aggro 只负责补充“正在打谁”的证据。
      if (!a && !isHostileEntity(e)) continue;
      out.push({ id: e.id, ent: e, name: e.name, pos: e.position, dist, on: a?.on || null, evidence: a?.evidence || 'visible_hostile', kind: mobKind(e.name, e.equipment?.[0]?.name) });
    }
    return out;
  }

  async function equipForFight () {
    try {
      const inv = bot.inventory.items().map(i => i.name);
      const pick = deps.pickAutoEquip?.({ held: bot.heldItem?.name ?? null, inventory: inv, want: 'weapon' });
      if (pick?.itemName && pick.itemName !== bot.heldItem?.name) {
        const it = bot.inventory.items().find(i => i.name === pick.itemName);
        if (it) await bot.equip(it, 'hand');
      }
      // 盾：放到副手（有的话）
      if (!/shield/.test(bot.inventory.slots[45]?.name || '')) {
        const sh = bot.inventory.items().find(i => /shield/.test(i.name));
        if (sh) await bot.equip(sh, 'off-hand');
      }
    } catch (_) {}
    return /shield/.test(bot.inventory.slots[45]?.name || '');
  }

  async function fight (first) {
    const C = I.cfg.combat;
    const { goals } = require('mineflayer-pathfinder');
    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    // 手上有命令 / 在做别的本能：叫停，先打；先停止移动，再等旧动作清理
    if (I.running && I.running.kind !== 'combat') { const old = I.running; old.abort(); if (!await settleJob(old)) { I.last = { t: Date.now(), skip: '战斗等待旧本能收尾' }; return; } }
    if (ended || I.urgent !== 'combat') return;
    const interrupted = I.inflight > 0 || (state.currentAction && !followName) ? (state.currentAction || '一个命令') : null;
    if (I.inflight > 0 || state.currentAction) deps.cancelCommands?.(`战斗本能：${first.name} ${first.on ? (first.on === 'me' ? '冲她来了' : `在打 ${first.on}`) : '在附近'}`);
    const anchorAt = () => (followName ? bot.players[followName]?.entity?.position : null) || I.combat.anchor;
    I.combat = { anchor: bot.entity.position.clone(), engaged: new Set(), killed: [], started: Date.now(), followName, hp0: bot.health };
    const hasShield = await equipForFight();
    if (ended || I.urgent !== 'combat') return;
    let lastSeen = Date.now(); let lastHit = 0; let shieldUp = false; let lastMode = null; let lastTargetId = null;
    const shield = (up) => { if (up === shieldUp) return; shieldUp = up; try { up ? bot.activateItem(true) : bot.deactivateItem(); } catch (_) {} };
    let aborted = false;
    const job = (async () => {
      while (!aborted && Date.now() - I.combat.started < C.maxMs) {
        const targets = hostileTargets();
        const a = anchorAt();
        const plan = combatPlan({ targets, hp: (bot.health ?? 20) - (I.effectHpCost || 0), hasShield, anchor: a ? { x: a.x, y: a.y, z: a.z } : null }, C);
        if (!plan) {
          shield(false);
          if (Date.now() - lastSeen > C.loseMs) break;
          if (lastMode) { try { bot.pathfinder.setGoal(null); } catch (_) {} lastMode = null; }
          await sleepMs(C.loopMs); continue;
        }
        lastSeen = Date.now();
        const t = plan.target; const ent = targets.find(x => x.id === t.id)?.ent;
        if (!ent) { await sleepMs(C.loopMs); continue; }
        I.combat.engaged.add(ent.id);
        const modeKey = `${plan.mode}:${ent.id}`;
        if (plan.mode === 'retreat' || plan.mode === 'avoid') {
          shield(false);
          if (modeKey !== `${lastMode}:${lastTargetId}`) {
            bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(ent, plan.keep || 16)), true);
            if (plan.mode === 'retreat' && lastMode !== 'retreat') event('combat_retreat', `血只剩 ${bot.health}，先从 ${ent.name} 身边跑开`);
          }
          I.combat.retreating = plan.mode === 'retreat';
          // 跑着还在掉血、血到底了：服务器给了 /home 或 /spawn 就传走（指令本能）
          if (plan.mode === 'retreat' && typeof tryCommand === 'function') { const c = await tryCommand(false); if (c?.did) { aborted = true; break; } }
        } else {
          if (modeKey !== `${lastMode}:${lastTargetId}`) bot.pathfinder.setGoal(new goals.GoalFollow(ent, 2), true);
          const dist = ent.position.distanceTo(bot.entity.position);
          const cd = attackCooldownMs(bot.heldItem?.name);
          if (dist <= C.reach && Date.now() - lastHit >= cd) {
            shield(false);
            try { await bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.8, 0), true); } catch (_) {}
            try { bot.attack(ent); lastHit = Date.now(); } catch (_) {}
          } else if (plan.mode === 'shield' && dist <= 10) {
            shield(true);   // 举着盾贴过去；挥之前放下（上面那支）
          }
        }
        lastMode = plan.mode; lastTargetId = ent.id;
        await sleepMs(C.loopMs);
      }
    })();
    const mine = {
      kind: 'combat',
      abort: () => { aborted = true; try { bot.pathfinder.setGoal(null); } catch (_) {} },
      done: job,
    };
    I.running = mine;
    // ⚠️ 2026-09-28 审计（codex fix0 #4）：**路径目标清理也要认 owner**。
    //    原来 `finally` 里无条件 `bot.pathfinder.setGoal(null)` —— 战斗被叫停、
    //    等旧动作超时、新命令已经接管身体时，旧战斗的 `finally` 仍会跑，
    //    把**新命令的**寻路目标一起清掉（新命令刚 setGoal 完就发现自己没目标了）。
    //    `I.running === mine` 只保住了"标记"，保不住"寻路目标" —— 两者要同一个判据。
    //    判据抽成纯函数 `ownsBodyAtCleanup`（有独立自测），"标记清理"和"目标清理"
    //    走**同一句**判断，不会再分叉。
    try { await job; } catch (_) {} finally {
      shield(false);
      if (ownsBodyAtCleanup(I, mine)) {
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        I.running = null;   // 只清自己的（打断后新任务可能已经占上了）
      }
    }
    const cb = I.combat;
    const names = [...new Set(cb.killed)];
    event('combat', `${interrupted ? `（打断了：${interrupted}）` : ''}打完了${names.length ? `：打死 ${cb.killed.length} 只（${names.join('、')}）` : '（没打死，怪跑了或者够不着）'}，血 ${cb.hp0} → ${bot.health}${aborted ? '，被叫停' : ''}`, { killed: cb.killed });
    note({ kind: 'combat', killed: cb.killed.length, hp: bot.health, aborted: aborted || undefined });
    // 回位交给普通本能；战斗扫描立即恢复，不在回程的 15 秒里失明。
    if (aborted) return;
    if (followName && bot.players[followName]?.entity) { try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {} return; }
    if (cb.anchor && bot.entity.position.distanceTo(cb.anchor) > 3) I.returnAfterCombat = cb.anchor;
  }

  // 战斗的"眼睛"：比别的本能快（250ms），不等身体空闲 —— 紧急本能可抢身体
  let fighting = false;
  const checkCombat = createCheck('combat', async (d) => {
    if (ended || !state.connected || !bot.entity || !I.cfg.combat.enabled) { d.skip = '未就绪或已关闭'; return; }
    if (fighting || I.urgent) { d.skip = '紧急动作正在执行'; return; }
    if (sleeping()) { d.skip = '正在睡觉'; return; }
    if (I.running?.kind === 'combat') return;
    try {
      const targets = hostileTargets();
      d.targets = targets.length;
      if (!targets.length) { d.skip = '没有可见敌对目标'; return; }
      const plan = combatPlan({ targets, hp: (bot.health ?? 20) - (I.effectHpCost || 0), hasShield: /shield/.test(bot.inventory.slots[45]?.name || '') || bot.inventory.items().some(i => /shield/.test(i.name)), anchor: null }, I.cfg.combat);
      if (!plan) return;
      fighting = true;
      I.urgent = 'combat';
      // 有确证的敌人时先关闭容器，不能因为开着箱子一直挨打。
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      event('combat_start', `发现 ${plan.target.name}${plan.target.on ? `正在攻击${plan.target.on === 'me' ? '她' : plan.target.on}` : '在附近'}，立即接管`, { source: d.source });
      await fight(plan.target);
    } catch (e) { I.last = { t: Date.now(), error: `combat: ${e.message}` }; } finally { fighting = false; if (I.urgent === 'combat') I.urgent = null; }
  }, I.diagnostics);
  const combatTimer = setInterval(() => checkCombat(), CFG.combat.scanMs);

  // ---- 身上的效果（读不到 = null，不猜）：minecraft-data 的名字 'Poison' 'Wither' …
  const effectNames = () => {
    const eff = bot.entity?.effects;
    if (!eff || typeof eff !== 'object') return null;
    return Object.values(eff).map(e => bot.registry.effects?.[e.id]?.name).filter(Boolean);
  };
  I.effectNames = effectNames;

  // ---- 吃（主人 2026-09-27：饥饿条掉 2 格就吃）
  let eating = false;
  const checkEat = createCheck('eat', async (d) => {
    if (ended || !state.connected || !I.cfg.eat.enabled || eating || !bot.entity || sleeping() || I.urgent) return;
    const hasFood = bot.inventory.items().some(i => deps.hands.foodScore(i) > 0);
    const busy = bodyBusy({ inflight: I.inflight, currentAction: state.currentAction, windowOpen: false, quietUntil: 0 }) || (I.running && I.running.kind !== 'combat' ? `本能在做 ${I.running.kind}` : null);
    const pick = pickEat({ food: bot.food, busy, fighting, windowOpen: !!bot.currentWindow, eating, hasFood, failUntil: I.eatFailUntil || 0 }, I.cfg.eat);
    d.skip = pick?.skip || (pick?.eat ? null : '还不饿');
    if (!pick?.eat) {
      if (pick?.skip === '身上没有吃的' && bot.food <= I.cfg.eat.urgentAt && Date.now() - (I.hungryToldAt || 0) > 600000) {
        I.hungryToldAt = Date.now();
        event('hungry', `饿了（饥饿 ${bot.food}/20），身上没有吃的`);
      }
      return;
    }
    eating = true;
    try {
      const r = await deps.handlers['POST /eat']({});
      if (r?.ate) note({ kind: 'eat', item: r.item, from: r.foodBefore, to: r.foodAfter, urgent: pick.urgent || undefined });
      else I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
    } catch (e) {
      I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
      event('eat_failed', `想吃东西没吃成：${String(e.message).slice(0, 80)}`);
    } finally { eating = false; }
  }, I.diagnostics);
  const eatTimer = setInterval(() => checkEat(), CFG.eat.checkMs);

  // ---- 憋气：头在水里、氧气快没了 → 叫停命令，一直跳上去（寻路算不出水下的路，跳最快）
  let breathing = false;
  const checkBreath = createCheck('breathe', async (d) => {
    if (ended || !state.connected || !I.cfg.breathe.enabled || breathing || !bot.entity) return;
    if (I.urgent && I.urgent !== 'combat') return;
    if (fighting && I.running?.kind !== 'combat') return; // 战斗装备/收尾期间先等它进入可取消阶段
    const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
    const headInWater = !!head && (/water|bubble_column/.test(head.name) || head.getProperties?.().waterlogged === true);
    const eff = effectNames();
    if (!needBreath({ oxygen: bot.oxygenLevel ?? null, headInWater, waterBreathing: !!eff?.includes('WaterBreathing') }, I.cfg.breathe)) return;
    breathing = true;
    I.urgent = 'breathe';
    try {
      if (I.running) I.running.abort();
      deps.cancelCommands?.('憋不住气了，先上去换气');
      if (Date.now() - (I.breathToldAt || 0) > 20000) { I.breathToldAt = Date.now(); event('breathe', `在水里憋不住气了（氧气 ${bot.oxygenLevel}/20），先游上去换气`); }
      const old = I.running;
      // 保命不能等：旧动作 800ms 内没收尾也照样往上跳（它已经被 abort、寻路目标也清了；以前这里 return，下一拍再等，会一直等到淹死）
      const settled = await settleJob(old);
      if (ended || I.urgent !== 'breathe') return;
      // ⚠️ 2026-09-28 审计（codex fix0 #5）：**强制上浮也要有自己的 owner**。
      //    原来旧动作没收尾时走 `{ r: await jump(() => ended) }` —— 直接调 handler，
      //    **绕过 runJob**：上浮期间 `I.running` 还挂在**旧** job 上（甚至一直是 null），
      //    于是没有 owner 管它，旧 job 的 finally 也可能在并行清理状态。
      //    现在统一经 `runJob('breathe', ...)`：上浮自己成为当前 `I.running` owner，
      //    旧 job 的 finally 里"只清自己"的判据（`I.running === mine`）就会放行、
      //    不再与新上浮抢状态。`settled` 只用来标记"这次是强制的"（诊断用），
      //    两种情形走同一条有 owner 的路径。
      //
      //    ⚠️⚠️ 2026-09-28 二轮审计（wbR2 新发现，高）：**runJob 自己会把这次上浮拒掉**。
      //      `runJob` 开头写着 `if (ended || (I.urgent && I.urgent !== kind)) return
      //      { r: { error: '已让出身体给紧急本能' }, aborted: true }` —— 它假设
      //      "`I.urgent` 有值但不是我自己 ⇒ 有别的事在急"。而憋气这条恰恰是
      //      **先 `I.urgent = 'breathe'`、再 `runJob('breathe')`**，看着能对上；
      //      但 `I.urgent` 是**共享字段**，`yieldBody`（命令来了）和战斗的 `finally`
      //      都会把它清成别的值/null：只要在 `settleJob(old)` 这 800ms 窗口里
      //      来过一条 `COMBAT_YIELD` 类命令，`I.urgent` 就被清成 `null`，
      //      再晚一点气泡/战斗把它设成别的值，`runJob` 就**直接早退、一跳都不跳**。
      //      早退分支在 `I.running = job` **之前**，所以这次上浮连 owner 都没拿到，
      //      旧 job 反而可能还占着 `I.running` —— 淹死的路径就回来了（只是从
      //      "绕过 runJob"换成了"被 runJob 拒绝"）。
      //      **保命动作不能有一条"条件不满足就静默不跳"的路径**：早退/出错都
      //      必须照样把这一下跳完。所以这里显式检查 `aborted`/`r.error`，
      //      被拒就**直接调 handler**（不带 owner 也比淹死强 —— 宁可有竞态也不要溺水）。
      if (!settled) d.forced = true;
      let { r, aborted: bAborted } = await runJob('breathe', null, (abort) =>
        deps.handlers['POST /jump']({ durationMs: I.cfg.breathe.jumpMs, stopAtOxygen: 18, abort }));
      if (breatheRefused({ r, aborted: bAborted })) {
        // 被 runJob 拒了（urgent 被别人占了 / ended）。保命优先：直接跳。
        d.refused = r?.error || 'aborted';
        try {
          r = await deps.handlers['POST /jump']({ durationMs: I.cfg.breathe.jumpMs, stopAtOxygen: 18 });
          bAborted = false;
        } catch (e2) { I.last = { t: Date.now(), error: `breathe 兜底也失败: ${e2.message}` }; }
      }
      note({ kind: 'breathe', forced: d.forced || undefined, refused: d.refused, oxygen: r?.oxygen, jumped: r?.jumped });
      I.breathedAt = Date.now();
    } catch (e) { I.last = { t: Date.now(), error: `breathe: ${e.message}` }; } finally { breathing = false; if (I.urgent === 'breathe') I.urgent = null; }
  }, I.diagnostics);
  const breathTimer = setInterval(() => checkBreath(), CFG.breathe.checkMs);

  // ---- 上岸：身体空着泡在水里 → 走到最近的陆地（刚上浮换完气也算）
  let inWaterSince = 0;
  const shoreTimer = setInterval(async () => {
    const S = I.cfg.shore;
    if (!S.enabled || !bot.entity || bot.vehicle || fighting || breathing || I.urgent || I.running) return;
    const feet = bot.blockAt(bot.entity.position.floored());
    const wet = !!bot.entity.isInWater || /water|bubble_column/.test(feet?.name || '');
    if (!wet) { inWaterSince = 0; return; }
    if (!inWaterSince) inWaterSince = Date.now();
    const justBreathed = Date.now() - (I.breathedAt || 0) < 10000;
    if (!justBreathed && Date.now() - inWaterSince < S.afterMs) return;
    if (Date.now() < (I.shoreRetryAt || 0)) return;
    if (bodyBusy({ inflight: I.inflight, currentAction: state.currentAction, windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil })) return;
    I.shoreRetryAt = Date.now() + S.retryMs;
    const me = bot.entity.position.floored();
    // 由近到远一圈一圈找（第 1 圈、第 2 圈…到 radius）：找到第一圈里有能站的格子就停，
    // 只把那一圈交给 pickShore 挑。判据不变（place.isStandable + pickShore），只是不再一口气扫 3750 格。
    let pick = null; let scanned = 0; let rings = 0;
    for (let k = 0; k <= S.radius && !pick; k++) {
      const cells = [];
      for (const o of shoreRingOffsets(k)) {
        scanned++;
        const p = me.offset(o.dx, o.dy, o.dz);
        const f = bot.blockAt(p); if (!f || /water/.test(f.name)) continue;
        const b = bot.blockAt(p.offset(0, -1, 0)); if (!b || b.boundingBox !== 'block') continue;
        const h = bot.blockAt(p.offset(0, 1, 0));
        cells.push({ pos: p, below: b.name, feet: f.name, head: h?.name, ok: require('../world/place').isStandable(f) && require('../world/place').isStandable(h) });
      }
      rings = k + 1;
      if (cells.length) pick = pickShore(cells, me);   // 这一圈里有可站的 → 就在这圈挑
    }
    if (!pick) { note({ kind: 'shore', skip: `${S.radius} 格内没找到能上的岸`, rings, scanned }); return; }
    const { r, aborted } = await runJob('shore', null, (abort) => deps.handlers['POST /go']({ x: pick.pos.x, y: pick.pos.y, z: pick.pos.z, range: 1, maxMs: 20000, abort }));
    const dry = !bot.entity.isInWater && !/water/.test(bot.blockAt(bot.entity.position.floored())?.name || '');
    note({ kind: 'shore', to: pick.pos, ok: dry, aborted: aborted || undefined, error: r?.error });
    if (dry) { inWaterSince = 0; event('shore', `从水里上岸了（${pick.pos.x},${pick.pos.y},${pick.pos.z}）`); }
  }, CFG.shore.checkMs);

  // ---- 中毒 / 凋零
  let drinking = false;
  const effectTimer = setInterval(async () => {
    if (!I.cfg.effects.enabled || drinking || !bot.entity) return;
    const eff = effectNames();
    const hasMilk = bot.inventory.items().some(i => i.name === 'milk_bucket');
    const plan = effectPlan({ effects: eff, hp: bot.health ?? 20, hasMilk }, I.cfg.effects);
    I.effectHpCost = plan?.hpCost || 0;
    const key = plan ? plan.bad.join('+') : '';
    if (key && key !== I.effectTold) event('effect', `中了${plan.bad.map(b => ({ Poison: '毒', Wither: '凋零' }[b])).join('和')}（血 ${Math.round(bot.health ?? 0)}）${hasMilk ? '' : '，身上没有牛奶'}`, { effects: plan.bad });
    I.effectTold = key;
    if (!plan?.milk || bot.currentWindow || fighting || I.urgent || eating || I.running || I.inflight) return;
    drinking = true;
    try {
      const milk = bot.inventory.items().find(i => i.name === 'milk_bucket');
      await bot.equip(milk, 'hand');
      await bot.consume();
      await new Promise(res => setTimeout(res, 300));
      const left = effectNames() || [];
      const cleared = !plan.bad.some(b => left.includes(b));
      event('effect_milk', cleared ? '喝了牛奶，毒解了' : '喝了牛奶，但效果还在（可能读不准）');
    } catch (e) { event('effect_milk', `想喝牛奶解毒没成：${String(e.message).slice(0, 60)}`); } finally { drinking = false; }
  }, CFG.effects.checkMs);

  // ---- 天气
  I.weather = { rain: !!bot.isRaining, thunder: !!bot.isRaining && (bot.thunderState ?? 0) > 0 };
  const onWeather = () => {
    if (!I.cfg.weather.enabled) return;
    const now = { rain: !!bot.isRaining, thunder: !!bot.isRaining && (bot.thunderState ?? 0) > 0 };
    const ch = weatherChange(I.weather, now);
    I.weather = now;
    if (ch) event('weather', ch.text, { weather: ch.kind });
  };
  bot.on('rain', onWeather);
  bot.on('weatherUpdate', onWeather);

  // ---- 玩家挨打：告诉 mind（打人的怪战斗本能本来就会打，这里只是让她"知道"）
  const hurtTold = new Map();
  bot.on('entityHurt', (victim, source) => {
    try {
      const H = I.cfg.playerHurt;
      if (!H.enabled || victim?.type !== 'player' || victim === bot.entity || !victim.username) return;
      if (source?.type === 'player') return;   // 玩家之间闹着玩不归本能管
      if (!bot.entity || victim.position.distanceTo(bot.entity.position) > H.radius) return;
      if (Date.now() - (hurtTold.get(victim.username) || 0) < H.quietMs) return;
      hurtTold.set(victim.username, Date.now());
      const dist = Math.round(victim.position.distanceTo(bot.entity.position));
      event('player_hurt', `${victim.username} 挨打了${source?.name ? `（${source.name}）` : '（摔的、烧的或者看不见的东西）'}，离她 ${dist} 格`, { player: victim.username, by: source?.name || null });
    } catch (_) {}
  });

  const checkHazard = createCheck('hazard', async (d) => {
    if (ended || !state.connected || !bot.entity || I.urgent || sleeping()) return;
    const plan = stepOffPlan();
    if (!plan) { d.skip = '脚下安全'; return; }
    if (!plan.to) { d.skip = `${plan.why}，没有安全落脚点`; return; }
    I.urgent = 'stepoff';
    try {
      const old = I.running;
      if (old) old.abort();
      deps.cancelCommands?.(`危险方块：${plan.why}，先退开`);
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      // 等旧动作真正收尾，避免旧 finally 清掉新的寻路。
      if (!await settleJob(old)) { d.skip = '等待旧本能收尾'; return; }
      if (ended || I.urgent !== 'stepoff') return;
      await tryStepOff();
    } finally { if (I.urgent === 'stepoff') I.urgent = null; }
  }, I.diagnostics);
  const hazardTimer = setInterval(() => checkHazard(), 250);

  async function tick () {
    const skip = ended || !state.connected ? '已断线或等待出生' : !bot.entity ? '等待实体' : sleeping() ? '正在睡觉'
      : I.urgent ? `紧急动作：${I.urgent}` : I.running ? `本能在做：${I.running.kind}` : fighting ? '正在战斗' : null;
    if (skip) { I.last = { t: Date.now(), skip }; return; }
    const P = I.cfg.pickup;
    const busy = bodyBusy({
      inflight: I.inflight, currentAction: state.currentAction,
      windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil,
    });
    if (eating || drinking || breathing) { I.last = { t: Date.now(), skip: '正在吃喝或换气' }; return; }
    if (busy) { I.last = { t: Date.now(), skip: busy }; return; }
    if (I.returnAfterCombat) {
      const pos = I.returnAfterCombat;
      I.returnAfterCombat = null;
      await runJob('combatReturn', null, (abort) => deps.handlers['POST /go']({ x: pos.x, y: pos.y, z: pos.z, range: 1, maxMs: 15000, abort }));
      return;
    }
    // 换护甲放在"有怪盯着"和"血少"之前：被盯上时正是该穿好的时候（WorkBuddy 建议 17，Claude 核实）
    const ar = await tryArmor();
    if (ar?.did) { I.last = { t: Date.now(), armor: '做了' }; return; }
    if ((bot.health ?? 20) < P.minHealth) { I.last = { t: Date.now(), skip: `血 ${bot.health}，不弯腰` }; return; }
    const danger = threatened();
    if (danger) { I.last = { t: Date.now(), skip: danger }; return; }

    // ⓪' 死后回去捡东西（掉落物 5 分钟就没了，比什么都急）
    const rc = await tryRecover();
    if (rc?.did) { I.last = { t: Date.now(), recover: '做了' }; return; }

    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    const followEnt = followName ? bot.players[followName]?.entity : null;
    let nightOut = false;
    try {
      const ph = deps.night?.phaseOf(bot.time?.timeOfDay);
      nightOut = (ph === 'night' || ph === 'dusk' || !!I.weather?.thunder) && deps.night.isOut(deps.exposureOf(bot)?.kind);   // 打雷时白天也刷怪
    } catch (_) {}
    const now = Date.now();
    const last = {};
    // 掉落物清单：① 的近距离拾取和末尾的远处拾取共用一份（都只是把地上的实体读出来）
    const dropList = () => Object.values(bot.entities)
      .filter(e => e?.position && e.isValid !== false && deps.isDropEntity(e))
      .map(e => {
        const sp = spawned.get(e.id);
        // 本能装上之前就在地上的：没有刷出记录，当作早就落地、不是扔的
        return {
          id: e.id, pos: e.position, ageMs: sp ? now - sp.t : Infinity, thrower: sp ? sp.thrower : null,
          item: deps.droppedItemOf(e)?.name ?? null,
          visible: readVisible(e),   // 远处拾取要看"看不看得见"；读不到给 null（当未知，不远去）
        };
      });

    // ① 拾取（掉落物 5 分钟就没了，最先）
    if (P.enabled) {
      const drops = dropList();
      // 夜里在露天：半径收到脚边
      const cfg = nightOut ? { ...P, radius: Math.min(P.radius, P.nightOutRadius), followRadius: Math.min(P.followRadius, P.nightOutRadius) } : P;
      const pick = pickPickup({ self: bot.entity.position, drops, fails, canHold, now, following: followEnt ? { pos: followEnt.position } : null }, cfg);
      last.pickup = pick.skip || `捡 ${pick.ids.length} 堆`;
      if (pick.ids) { I.last = { t: now, ...last }; await runPickup(pick.ids, followName); return; }
    }
    // 跟着人走。2026-09-28 第 8 批 第 6 条：以前这里无条件 `return`，
    // 于是"跟着 X"期间她只会捡东西 —— 人站着不动（挂机看背包）她也跟着干站着。
    // 现在：他**站着不动超过 idleMs（默认 8 秒）**时，允许就地做点"顺手的事"
    // （插火把 / 挖看得见的矿 / 开看得见的箱子）；他一动（followIdlePlan 返回 null）立刻回到"只捡东西"。
    if (followName) {
      let idle = null;
      if (followEnt) {
        const prev = I.followSeen?.name === followName ? I.followSeen.pos : null;
        const movedNow = prev ? Math.hypot(followEnt.position.x - prev.x, followEnt.position.y - prev.y, followEnt.position.z - prev.z) : 0;
        if (prev && movedNow > 0.35) I.followMovedAt = now;              // 他在动 → 刷新"动过"的时刻
        if (!I.followMovedAt) I.followMovedAt = now;                     // 第一次见到：先记下
        I.followSeen = { name: followName, pos: { x: followEnt.position.x, y: followEnt.position.y, z: followEnt.position.z } };
        idle = followIdlePlan({ now, idleMs: I.cfg.follow.idleMs, lastPos: prev, pos: followEnt.position, movedAt: I.followMovedAt });
      } else {
        I.followSeen = null; I.followMovedAt = 0;
      }
      if (!idle) { I.last = { t: now, ...last, other: `跟着 ${followName}，只捡东西` }; return; }
      // 他站着不动：顺手的事按"最急"排 —— 插火把（防刷怪）→ 挖看得见的矿 → 开看得见的箱子。
      // 都离她/他不远（follow.reach / 采集本能自己的半径）。做完一件就回 tick，下一拍再看他还动没动。
      last.follow = `${followName} 站着不动 ${(idle.idleMs / 1000).toFixed(0)}s，顺手做点事`;
      const tf = await tryTorch();
      if (tf?.did) { I.last = { t: now, ...last, torch: '做了' }; return; }
      const tm = await tryMine({ pos: followEnt.position });
      if (tm?.did) { I.last = { t: now, ...last, mine: '做了' }; return; }
      if (tm?.skip) last.mine = tm.skip;
      const tl = await tryLoot(nightOut);
      if (tl?.did) { I.last = { t: now, ...last, loot: '做了' }; return; }
      if (tl?.skip) last.loot = tl.skip;
      I.last = { t: now, ...last }; return;
    }
    I.followSeen = null; I.followMovedAt = 0;
    // ② 夜里在家就睡（在自家院子的露天处也算 —— 所以放在"夜里露天不做事"之前）
    const sl = await trySleep();
    if (sl?.did) { I.last = { t: now, ...last, sleep: '做了' }; return; }
    if (sl?.skip) last.sleep = sl.skip;
    // ②' 需要的时候用命令（设 /sethome、夜里离家太远 /home）
    const cm = await tryCommand(nightOut);
    if (cm?.did) { I.last = { t: now, ...last, command: '做了' }; return; }
    // ③ 回家整理（背包快满 / 缺吃的缺镐子而家里有）—— 夜里家近也回
    const td = await tryTidy(nightOut);
    if (td?.did) { I.last = { t: now, ...last, tidy: '做了' }; return; }
    if (td?.skip) last.tidy = td.skip;
    if (nightOut) { I.last = { t: now, ...last, other: '夜里在露天，不收不挖' }; return; }

    // ④ 收获  ⑤ 开宝箱 / 进建筑  ⑥ 采矿  ⑦ 换护甲
    // ⑧ 洞穴探险（最后：先把看得见的矿挖了、箱子开了，再往里走）
    // ★ 插火把放在最前：地下暗处会刷怪，比收获更该先做（第 8 批第 4 条）。身体空着才轮到它。
    // ★ delve 续挖排在采矿**之后**：先挖脚边看得见的矿（收获最快），再接着往洞里走。
    for (const [k, f] of [['torch', tryTorch], ['harvest', tryHarvest], ['loot', () => tryLoot(nightOut)], ['mine', tryMine], ['delve', tryResumeDelve], ['cave', tryCave]]) {
      const r = await f();
      if (!r) continue;
      if (r.did) { I.last = { t: now, ...last, [k]: '做了' }; return; }
      last[k] = r.skip;
    }
    // ⑨ 远处拾取（2026-09-28 加）：上面全都没事做、身体空着 = 真闲着了。
    // 实机 10 分钟里 `pickup` 一直是 `有掉落物但都不捡（far=6~17）` —— 掉落物在 8 格拾取半径外，
    // 她整整 10 分钟没去。这里在"真闲着"时去捡看得见的远处掉落物（farRadius，默认 24）。
    // 夜里在露天早就在上面 return 了；血不够、有怪、背包满都不会走到这里（或 pickPickup 自己会拒）。
    if (P.enabled && P.farRadius > P.radius) {
      const drops = dropList();
      const pick = pickPickup({ self: bot.entity.position, drops, fails, canHold, now, following: null }, { ...P, far: true });
      if (pick.ids) { last.pickup = `去捡远处 ${pick.ids.length} 堆（far）`; I.last = { t: now, ...last }; await runPickup(pick.ids, null); return; }
      if (pick.skip && /far=/.test(pick.skip)) last.pickup = pick.skip;
    }
    I.last = { t: now, ...last };
  }

  let ticking = false;
  let lastTickAt = Date.now();
  let tickStartedAt = 0;
  const timer = setInterval(async () => {
    const now = Date.now();
    // lagMs = 这一拍比"应该来的时刻"晚了多少（本能自己的拍子）。它只在**这一拍真的被叫到时**才算，
    // 所以事件循环被同步代码堵住时它也会偏大 —— 但分不清"堵"还是"本能在忙"。
    // loopMs 是 monitorEventLoopDelay 量的**事件循环本身**的延迟，和本能忙不忙无关：
    // 两者一起看就能分清（实机 12:20 那次：lagMs=13511 而 busyForMs=0 → 就是被堵了）。
    I.scheduler = {
      at: now,
      maxLagMs: Math.max(I.scheduler?.maxLagMs || 0, now - lastTickAt - CFG.pickup.tickMs),
      lagMs: Math.max(0, now - lastTickAt - CFG.pickup.tickMs),
      busyForMs: ticking ? now - tickStartedAt : 0,
      loopMs: loopDelay(),
      slow: I.slowLog.length ? I.slowLog[I.slowLog.length - 1] : null,
    };
    lastTickAt = now;
    if (ticking) return;
    tickStartedAt = now;
    ticking = true;
    try { await tick(); } catch (e) { I.last = { t: Date.now(), error: e.message }; } finally { ticking = false; }
  }, CFG.pickup.tickMs);
  let wakeQueued = false;
  const wakeChecks = () => {
    if (ended || wakeQueued) return;
    wakeQueued = true;
    setImmediate(() => {
      wakeQueued = false;
      if (ended) return;
      // 氧气优先；合并同一个包触发的多个事件，避免密集包重复扫描。
      checkBreath('event');
      checkCombat('event');
      checkEat('event');
    });
  };
  let lastUpdateWake = 0;
  const onUpdate = (e) => {
    if (Date.now() - lastUpdateWake < 100) return; // 高频姿态包合并；受伤/氧气事件不受此限制
    if (e === bot.entity || (e?.position && bot.entity?.position && e.position.distanceTo(bot.entity.position) <= I.cfg.combat.detect)) {
      lastUpdateWake = Date.now(); wakeChecks();
    }
  };
  bot.on('entityHurt', wakeChecks);
  bot.on('breath', wakeChecks);
  bot.on('health', wakeChecks);
  bot.on('entityUpdate', onUpdate);
  bot.once('end', () => { ended = true; bot.removeListener('entityHurt', wakeChecks); bot.removeListener('breath', wakeChecks); bot.removeListener('health', wakeChecks); bot.removeListener('entityUpdate', onUpdate); clearInterval(hazardTimer); clearInterval(timer); clearInterval(gazeTimer); clearInterval(toolTimer); clearInterval(combatTimer); clearInterval(kitTimer); clearInterval(oreWatch); clearInterval(policyTimer); clearInterval(homeTimer); clearInterval(eatTimer); clearInterval(breathTimer); clearInterval(shoreTimer); clearInterval(effectTimer); });
}

/**
 * 命令来了：本能让出身体。bridge 路由在执行会动身体的 POST 之前调用。
 * 打断正在做的本能，并等它收拾干净（最多 yieldWaitMs）—— 不然它的 finally 会清掉新命令刚设的寻路目标。
 */
async function yieldBody (state, key, args = {}) {
  const I = state.instinct;
  if (!I) return;
  // 只有明说"站住"（hold）才静默。mind 换任务前、脑干看门狗脱困时也会调 /stop —— 那是"换件事"，不是"别动"。
  if (key === 'POST /stop' && args?.hold) I.quietUntil = Date.now() + I.cfg.pickup.quietAfterStopMs;
  if (I.urgent && !COMBAT_YIELD.has(key)) return { reject: `正在执行紧急本能：${I.urgent}` };
  if (I.urgent && key === 'POST /stop' && !args?.hold) return { reject: `正在执行紧急本能：${I.urgent}` };
  const r = I.running;
  if (I.urgent && (!r || r.kind !== 'combat')) I.urgent = null;
  if (!r) return;
  // 打架的时候：只让 停 / 逃 / 跟随 / 走 / 关本能 这几类打断；别的命令等打完（不然两边抢身体）
  // /stop 只有明说"站住"（hold）才算：脑干看门狗一见怪就发不带 hold 的 /stop，不能让它把正在打的架叫停
  if (r.kind === 'combat' && (!COMBAT_YIELD.has(key) || (key === 'POST /stop' && !args?.hold))) return { reject: '在打架（战斗本能），打完再做' };
  r.abort();
  await Promise.race([r.done.catch(() => {}), new Promise(res => setTimeout(res, CFG.yieldWaitMs))]);
}

module.exports = { bind, bodyBusy, breatheRefused, caveBoundary, createCheck, install, ownsBodyAtCleanup, scanColumnsGen, scanColumnsIn, scanColumnsSync, settleJob, syncSleepState, yieldBody };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/core.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['身体空不空', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { bodyBusy } = ns;
    // ---- 身体空不空 ----
    check('什么都没在做 → 空', bodyBusy({}), null);
    check('跟随中 → 算空（捡完接着跟）', bodyBusy({ currentAction: 'following starwish' }), null);
    check('★ 有命令在跑 → 不空', typeof bodyBusy({ inflight: 1 }), 'string');
    check('在挖矿 → 不空', typeof bodyBusy({ currentAction: 'mining 3x stone' }), 'string');
    check('开着箱子 → 不空', typeof bodyBusy({ windowOpen: true }), 'string');
    check('★ 刚被叫停 → 站着别动', typeof bodyBusy({ quietUntil: 100, now: 50 }), 'string');
    check('停的时间过了 → 空', bodyBusy({ quietUntil: 100, now: 150 }), null);
  }],
  ['让出身体', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, PASSIVE_POSTS, breatheRefused, followIdlePlan, ownsBodyAtCleanup, paths, pickTorchStep, scanColumnsSync, yieldBody } = ns;
    // ---- 让出身体 ----
    const { pass, fail } = t;   // 读 testkit 的实时计数（原来是巨石自测自己的计数器）
    const P = CFG.pickup;
    const st = { instinct: { cfg: { pickup: { ...P } }, running: null, quietUntil: 0 } };
    let aborted = false;
    let finish;
    st.instinct.running = { abort: () => { aborted = true; finish(); }, done: new Promise(res => { finish = res; }) };
    const stC = { instinct: { cfg: { pickup: { ...P } }, running: { kind: 'combat', abort: () => {}, done: Promise.resolve() }, quietUntil: 0 } };
    return yieldBody(stC, 'POST /mine').then((y) => {
      check('★ 打架时来了挖矿命令 → 回"在打架"', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /flee');
    }).then((y) => {
      check('打架时说"逃" → 让', y?.reject, undefined);
      return yieldBody(stC, 'POST /stop');
    }).then((y) => {
      check('★ 看门狗的 /stop（不带 hold）→ 不叫停正在打的架', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /stop', { hold: true });
    }).then((y) => {
      check('主人喊"站住"（hold）→ 停', y?.reject, undefined);
      return yieldBody(st, 'POST /move');
    }).then(() => {
      check('★ 命令来了 → 本能被打断', aborted, true);
      return yieldBody(st, 'POST /stop');
    }).then(() => {
      check('★ 不带 hold 的 /stop（mind 换任务）→ 不静默', st.instinct.quietUntil, 0);
      return yieldBody(st, 'POST /stop', { hold: true });
    }).then(() => {
      check('/stop {hold} → 一段时间站着别动', st.instinct.quietUntil > Date.now(), true);
      check('chat 不碰身体', PASSIVE_POSTS.has('POST /chat'), true);
      check('pickup 会动身体', PASSIVE_POSTS.has('POST /pickup'), false);

      // ---- 收尾资格（codex fix0 #4：战斗 finally 不能清掉别人的寻路目标）----
      // ⚠️ 回归点：改前 `finally` 无条件 setGoal(null)，`ownsBodyAtCleanup` 这条判据
      //    不存在。现在"清标记"和"清目标"共用它 —— 不是当前 owner 就一个都不动。
      const myJob = { kind: 'combat' };
      const I1 = { running: myJob };
      check('★ 收尾时还是当前 owner → 有资格动身体', ownsBodyAtCleanup(I1, myJob), true);
      const otherJob = { kind: 'mine' };
      const I2 = { running: otherJob };            // 被新命令/新 job 接管了
      check('★ 已被别人接管 → 没资格（不清目标、不误清标记）', ownsBodyAtCleanup(I2, myJob), false);
      const I3 = { running: null };                // 标记已被别人提前清掉
      check('★ 标记为 null → 没资格', ownsBodyAtCleanup(I3, myJob), false);
      check('myJob 为空（没拿到 job）→ 没资格', ownsBodyAtCleanup({ running: null }, null), false);
      check('I 为空也不抛', ownsBodyAtCleanup(null, myJob), false);

      // ---- 源码形状锁：修好的两处"绕过 owner"不许改回去 ----
      const srcText = instinctSrc();
      // fix0 #4：战斗 finally 里的清目标必须在 ownsBodyAtCleanup 判断之内
      check('★ 战斗 finally 用 ownsBodyAtCleanup 判据（不再无条件 setGoal(null)）',
        /finally \{[\s\S]{0,200}ownsBodyAtCleanup\(I, mine\)[\s\S]{0,200}setGoal\(null\)/.test(srcText), true);
      // fix0 #5：强制上浮也必须经 runJob（有自己的 owner），不再裸调 handler
      check('★ 憋气强制上浮也走 runJob（不再裸调 POST /jump）',
        /settled[\s\S]{0,400}runJob\('breathe'/.test(srcText)
        && !/settled \? await runJob\('breathe'[^)]*\) : \{ r: await jump\(/.test(srcText), true);
      // fix1 #3：event() 先拍平换行
      check('★ event() 会拍平换行（一条事件一行）',
        /replace\(\/\[\\r\\n\]\+\/g, ' '\)/.test(srcText), true);

      // ---- wbR2 新发现（高）：憋气上浮被 runJob 拒绝时必须有补跳 ----
      // ⚠️ 回归点：改前 `const { r } = await runJob('breathe', …)` 直接吞掉早退结果，
      //    被拒 = 一跳都不跳；测试 `breatheRefused` 判据 + 源码里真的用了它。
      check('★ runJob 正常跳成 → 不算被拒', breatheRefused({ aborted: false, r: { jumped: 3 } }), false);
      check('★ runJob 早退（aborted + error，jumped 无）→ 必须补跳',
        breatheRefused({ aborted: true, r: { error: '已让出身体给紧急本能' } }), true);
      check('★ 没报错但一跳没跳（jumped 0）→ 也要补跳', breatheRefused({ aborted: false, r: { jumped: 0 } }), true);
      check('★ 被 abort 但 handler 真跳了（jumped>0）→ 不用补跳',
        breatheRefused({ aborted: true, r: { jumped: 2 } }), false);
      check('r 为空 → 保守算没跳成', breatheRefused({ aborted: true }), true);
      check('res 为空 → 保守算没跳成', breatheRefused(null), true);
      check('★ 没报跳了几下但氧气回来了 → 成了，不重复跳', breatheRefused({ aborted: false, r: { oxygen: 20 } }), false);
      check('氧气还低、跳了 0 下 → 补跳', breatheRefused({ aborted: false, r: { oxygen: 3, jumped: 0 } }), true);
      check('★ checkBreath 真的用了 breatheRefused 兜底（不是靠人记得）',
        /breatheRefused\(\{ r, aborted: bAborted \}\)/.test(srcText), true);
      check('★ 兜底里直接调 POST /jump（保命路径不能只有一条）',
        /breatheRefused[\s\S]{0,400}deps\.handlers\['POST \/jump'\]/.test(srcText), true);

      const scanRealOk = (() => {
        const mcd = require('minecraft-data')('1.20.1');
        const Chunk = require('prismarine-chunk')('1.20.1');
        const { Vec3 } = require('vec3');
        const cols = new Map();
        const colAt = (cx, cz) => { const k = `${cx},${cz}`; if (!cols.has(k)) cols.set(k, new Chunk({ minY: -64, worldHeight: 384 })); return cols.get(k); };
        const put = (x, y, z, name) => colAt(Math.floor(x / 16), Math.floor(z / 16)).setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), mcd.blocksByName[name].defaultState);
        put(3, 64, 3, 'oak_planks'); put(20, 70, -5, 'oak_planks'); put(-10, 60, 12, 'torch'); put(5, -20, 5, 'oak_planks'); put(90, 64, 0, 'oak_planks');
        colAt(-2, 0);   // 一个加载了但没东西的区块
        const world = { getColumn: (cx, cz) => cols.get(`${cx},${cz}`) || null };
        const ids = [mcd.blocksByName.oak_planks.id, mcd.blocksByName.torch.id];
        const r = scanColumnsSync({ world, registry: mcd, c: { x: 0, y: 64, z: 0 }, ids, maxDist: 40, opts: { dy: 16 } });
        const has = (x, y, z) => r.pts.some(p => p.x === x && p.y === y && p.z === z);
        const deep = scanColumnsSync({ world, registry: mcd, c: { x: 0, y: -20, z: 0 }, ids, maxDist: 40, opts: { dy: 4 } });
        return {
          found: has(3, 64, 3) && has(20, 70, -5) && has(-10, 60, 12),
          deep: deep.pts.some(p => p.x === 5 && p.y === -20 && p.z === 5),
          skipped: r.sections > 0 && r.cells < r.sections * 4096,
          unloaded: r.unloaded > 0,
          radius: !has(90, 64, 0),
        };
      })();

      // ---- 第 8 批的源码形状锁 ----
      check('★ 冻结真修：home 扫描用 scanColumns（逐 chunk 列），不再用 findBlocks 扫整圆',
        /scanColumns\(bot, c, builtIds/.test(srcText) && !/findBlocks\(\{ point: c, matching: builtIds/.test(srcText), true);
      check('★ 逐列之间让出事件循环（await yieldLoop 在列循环里）',
        /scanColumns[\s\S]{0,2600}await yieldLoop\(\)/.test(srcText), true);
      // 行为测试（用**真的** 1.20.1 区块数据，不是照着实现写的假世界 —— 第 8 批的假世界照错接口写，所以绿着上线也扫不到东西）
      check('★ 逐列扫描：真区块（prismarine-chunk 1.20.1）里放的方块都找得到', scanRealOk.found, true);
      check('★ 逐列扫描：y 为负（minY=-64）的层也找得到', scanRealOk.deep, true);
      check('★ 逐列扫描：没目标的区段整节跳过（只扫到有东西的那几节）', scanRealOk.skipped, true);
      check('★ 逐列扫描：没加载的区块记成 unloaded（读不到 ≠ 没有）', scanRealOk.unloaded, true);
      check('逐列扫描：半径外的不算', scanRealOk.radius, true);
      check('★ 家生长只扫环带（minDist 前沿），不再扫整个圆盘',
        /minDist: Math\.max\(0, Math\.min\(h\.radius, geoR\) - 4\)/.test(srcText), true);
      check('★ 暗处/耕地扫描半径封顶 32',
        /Math\.min\(geoR, 32\)/.test(srcText) && /Math\.min\(h\.radius, 32\)/.test(srcText), true);
      check('★ 家生长 30 分钟一次',
        /everyMs: 1800000/.test(srcText), true);
      check('★ 存东西时不存随身装备的判据在 body/kit.js（那里也有源码锁）',
        /isLoadoutItem/.test(require('fs').readFileSync(require('path').join(paths.ROOT, 'src', 'body', 'kit.js'), 'utf8')), true);
      check('★ 挖之前先把镐子拿到身上（ensureCarried /pickaxe$/）',
        /ensureCarried\(bot, state, \(it\) => \/pickaxe\$\/\.test\(it\.name\)/.test(srcText), true);
      check('★ 挖矿被打断 → 清失败冷却、下一拍接着挖',
        /if \(aborted\) mineFails\.delete\(k\)/.test(srcText), true);
      check('★ pickTorchStep 在 tick 的本能循环里（torch 那一条）',
        /\['torch', tryTorch\]/.test(srcText), true);
      check('★ 跟随时"他站着不动才顺手做事"（followIdlePlan 在 tick 里）',
        /followIdlePlan\(\{ now, idleMs: I\.cfg\.follow\.idleMs/.test(srcText), true);
      check('★ delve 续挖在 tick 的本能循环里',
        /\['delve', tryResumeDelve\]/.test(srcText), true);

      console.log(`\n${pass} passed, ${fail} failed`);
      return fail ? 1 : 0;
    });
  }],
];
register('core', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('core', __sections);
}
