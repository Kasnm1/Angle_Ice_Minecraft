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
const { sleepMs } = require('../util/time');   // 第 4 步去重：原为本文件 install() 内的本地定义
const { bareMinecraft } = require('../util/ids');   // 第 4 步去重：原为本文件几处本地的 bareName/bare
const __ns = {};
let CFG, TIER, TIER_NAME, STRUCTURE_SIGNS, COMBAT_YIELD, isPlayerUrgent;   // 跨文件常量：load 完成后由 bind() 回填
function fillCfg (...a) { return __ns.fillCfg.apply(null, a); }
function mobKind (...a) { return __ns.mobKind.apply(null, a); }
function attackCooldownMs (...a) { return __ns.attackCooldownMs.apply(null, a); }
function combatPlan (...a) { return __ns.combatPlan.apply(null, a); }
function fightGearFetchPlan (...a) { return __ns.fightGearFetchPlan.apply(null, a); }
function pickArmor (...a) { return __ns.pickArmor.apply(null, a); }
function toolWorn (...a) { return __ns.toolWorn.apply(null, a); }
function hazardUnder (...a) { return __ns.hazardUnder.apply(null, a); }
function pickStepOff (...a) { return __ns.pickStepOff.apply(null, a); }
function pickEat (...a) { return __ns.pickEat.apply(null, a); }
function needBreath (...a) { return __ns.needBreath.apply(null, a); }
function oxygenNum (...a) { return __ns.oxygenNum.apply(null, a); }
function headInWater (...a) { return __ns.headInWater.apply(null, a); }
function waterBreathing (...a) { return __ns.waterBreathing.apply(null, a); }
function blocksWater (...a) { return __ns.blocksWater.apply(null, a); }
function columnClear (...a) { return __ns.columnClear.apply(null, a); }
function breathPlan (...a) { return __ns.breathPlan.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }
// `place.js` 的 DEADLY：只用来判"挖开会不会放危险东西进来"（判据只此一份，不另写）
const placeLogic = require('../world/place');
const { Vec3 } = require('vec3');

function effectPlan (...a) { return __ns.effectPlan.apply(null, a); }
function shoreRingOffsets (...a) { return __ns.shoreRingOffsets.apply(null, a); }
function pickShore (...a) { return __ns.pickShore.apply(null, a); }
function mlgStep (...a) { return __ns.mlgStep.apply(null, a); }
function mlgShouldPlace (...a) { return __ns.mlgShouldPlace.apply(null, a); }
function waterRetrievePlan (...a) { return __ns.waterRetrievePlan.apply(null, a); }
function pickRecovery (...a) { return __ns.pickRecovery.apply(null, a); }
function pickaxeTier (...a) { return __ns.pickaxeTier.apply(null, a); }
function needTier (...a) { return __ns.needTier.apply(null, a); }
function pickOre (...a) { return __ns.pickOre.apply(null, a); }
function pickCaveStep (...a) { return __ns.pickCaveStep.apply(null, a); }
function pickTorchStep (...a) { return __ns.pickTorchStep.apply(null, a); }
function pickTorchAsk (...a) { return __ns.pickTorchAsk.apply(null, a); }
function torchSituation (...a) { return __ns.torchSituation.apply(null, a); }
function loadTorchMode (...a) { return __ns.loadTorchMode.apply(null, a); }
function markTorchAsked (...a) { return __ns.markTorchAsked.apply(null, a); }
function noteTorchAnswer (...a) { return __ns.noteTorchAnswer.apply(null, a); }
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
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; TIER = ns.TIER; TIER_NAME = ns.TIER_NAME; STRUCTURE_SIGNS = ns.STRUCTURE_SIGNS; COMBAT_YIELD = ns.COMBAT_YIELD; isPlayerUrgent = ns.isPlayerUrgent; }

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

/**
 * 读一个**别的玩家实体**的血量。读不到返回 null（不是 20、不是 0）。
 *
 * mineflayer 只给 bot 自己维护 `bot.health`（`lib/plugins/health.js`：只有
 * `update_health` 包会写它）。别的玩家没有这个属性 —— 他们的血量在**实体 metadata**
 * 里：`mineflayer/lib/plugins/entities.js:461` 收到 `entity_metadata` 包时，
 * 若 `bot.supportFeature('mcDataHasEntityMetadata')` 成立，会按
 * `bot.registry.entitiesByName[entity.name].metadataKeys` 把包里的 key 映射成
 * 带名字的对象，但**只挂进局部变量 `metas`，不写回 entity**。
 *
 * 所以唯一可靠的读法是：拿同一份 `metadataKeys`，用 `indexOf('health')` 找到槽位，
 * 再去 `entity.metadata[该槽位]` 取值。查过 `minecraft-data` 1.20.1：
 * player 与 zombie 的 metadataKeys 里都有 `health`（124/124 个实体都有这张表）。
 *
 * ⚠️ 明确的"读不到"：查不到 metadataKeys、没有 entity.metadata、取到的不是有限数、
 *    或者值 > maxHp（比如读成了别的字段）→ **一律返回 null**。
 *    调用方据此走"读不到"分支，绝不把它当成满血或危险（AGENTS.md §5-1）。
 *
 * @returns {number|null} 血量（0..maxHp），读不到 = null
 */
function victimHealth (bot, victim, maxHp = 20) {
  try {
    const keys = bot?.registry?.entitiesByName?.[victim?.name]?.metadataKeys;
    const i = Array.isArray(keys) ? keys.indexOf('health') : -1;
    if (i < 0) return null;
    const md = victim?.metadata;
    if (!md) return null;
    const hp = typeof md === 'object' && !Array.isArray(md) ? md[i] : undefined;
    if (!Number.isFinite(hp) || hp < 0 || hp > maxHp) return null;
    return hp;
  } catch (_) { return null; }
}

/**
 * 这个玩家这一下挨打，"值不值得惊动 mind"。
 *
 * 主人 2026-09-29 实机：掉一点血她每次都问"你没事吧"。原判据是"48 格内玩家挨打就发"
 * （core.js 的 entityHurt）+ 同一人 20 秒冷却，摔一下、被怪擦一下都触发，太吵。
 * 现在按**严重度**判（阈值与理由见 `config.js` 的 `CFG.playerHurt`）：
 *   ① 血量 ≤ lowHp（8 = 4 颗心）→ 危险，报；
 *   ② windowMs（10 秒）内累计掉血 ≥ burstHp（6 = 3 颗心）→ 掉得多，报；
 *   ③ windowMs 内挨打次数 ≥ burstHits（3）→ 被连着打（"被围攻"），报。
 * 不满足 = 小伤，**不报**（她不该每次都问）。
 *
 * ⚠️ **"没有"和"读不到"必须分开**（AGENTS.md §5-1）：
 *   读得到血量（hp 是有限数）→ 按 ①②③ 判；
 *   读不到血量（hp === null）→ **既不当满血（会漏报）也不当危险（会误报）**，
 *   只按 ③ 的"挨打次数"判 —— 次数是可靠的（每次挨打都真收到了事件）。
 *
 * 纯函数（`history` 由调用方维护，只放窗口内**本次之前**的事件），可离线自测。
 *
 * @param {object} p
 * @param {number|null} p.hp     这一下之后读到的血量（null = 读不到）
 * @param {number} p.hpLoss      这一下掉了多少血（读不到时按 0 计）
 * @param {Array<{at:number, loss:number}>} p.history  窗口内本次之前的挨打记录
 * @param {object} cfg           CFG.playerHurt
 * @returns {{tell:boolean, why:string, kind:string}}
 */
function playerHurtPlan ({ hp = null, hpLoss = 0, history = [] } = {}, cfg = CFG.playerHurt) {
  const hits = history.length + 1;                                              // 含这一次
  const cumulativeLoss = hpLoss + history.reduce((a, e) => a + (+e?.loss || 0), 0);
  const seen = hp != null;                                                      // 读得到血量吗
  const lowNow = seen && hp <= cfg.lowHp;                                       // ① 现在血就低
  const burstLoss = seen && cumulativeLoss >= cfg.burstHp;                      // ② 窗口内掉了不少（要读得到血才算得出）
  const burstHits = hits >= cfg.burstHits;                                      // ③ 窗口内挨打够多次（不依赖血量）
  if (lowNow) return { tell: true, why: `血只剩 ${hp}（${Math.round(hp / 2)} 颗心）`, kind: 'low_hp' };
  if (burstLoss) return { tell: true, why: `${Math.round(cfg.windowMs / 1000)} 秒内掉了 ${cumulativeLoss} 点血`, kind: 'burst' };
  if (burstHits) return { tell: true, why: `${Math.round(cfg.windowMs / 1000)} 秒内挨了 ${hits} 下`, kind: 'hits' };
  // 读不到血量、挨打次数也不够 → 不报（但不能因此说"他没事"，只是这次够不上"危险"）
  if (!seen) return { tell: false, why: `读不到血量，这一下只挨了 ${hits} 次（够不上危险）`, kind: 'unknown_hp' };
  return { tell: false, why: `小伤（血 ${hp}）`, kind: 'minor' };
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
  // ⚠️ **故意只看水平距离、不看高度**（别"修"成 inHomeArea）：这里保护的是**房子正下方的地底** ——
  //    她自己探洞时不许从家底下挖过去（塌房、挖穿地板、把怪引进家）。inHomeArea 的 |Δy| ≤ 16 是
  //    "人在不在家里"的判据，用在这里会让住宅下方 17 格以下变成可以自主探洞。
  //    守它的测试：scripts/instinct-scheduling-test.js「住宅下32格仍在自动探洞禁区」。
  //    （2026-09-29 第 5 步 WorkBuddy 把它当 bug 改掉、还把测试翻了，Claude 复核时改回。）
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

/**
 * 憋气时往哪走 —— 把世界读成 `breathPlan` 要的形状。
 *
 * 她**知道周围每一格是什么**（`bot.blockAt`），所以不许原地瞎跳。
 * 只在**头在水里**时才有意义（调用方已经确认过）。
 *
 * 读世界的方式（全部来自 `bot.blockAt`，不猜）：
 *   · 自己脚下这一列（dx=0,dz=0）从脚底往上 `upScan` 格 → `columnClear`
 *   · 周围 escapeRadius 内的每一列，同样从**她现在的脚底高度**往上扫 → `columnClear`
 *   · 另外把最近的能站的岸也算一个候选（`pickShore` 现成判据，不另写）
 *
 * 选谁交给 `breathPlan`（那里按"游过去要多久 vs 还剩多少气"挑）。
 *
 * @returns {{how, target?, why, oxygenLeftMs, selfClear}}
 */
function breathEscapePlan (bot, I, B) {
  const oxy = oxygenNum(bot.oxygenLevel ?? null);
  // 1 点氧气 ≈ 1 秒；读数不可信时给一个保守的 6 秒（宁可只挑近的）
  const oxygenLeftMs = oxy.reliable ? Math.max(0, oxy.value * 1000) : 6000;
  const self = bot.entity.position;
  const baseY = Math.floor(self.y);
  const cells = [];
  const colOf = (dx, dz) => {
    const out = [];
    for (let dy = 1; dy <= B.upScan; dy++) {
      const b = bot.blockAt(new Vec3(Math.floor(self.x) + dx, baseY + dy, Math.floor(self.z) + dz));
      if (!b) return null;   // 读不到这一格 → 不猜
      out.push({ dy, name: b.name, props: b.getProperties?.() });
    }
    return out;
  };
  const selfCol = colOf(0, 0);
  const selfClear = !!selfCol && columnClear(selfCol, B.upScan).clear;
  for (let dx = -B.escapeRadius; dx <= B.escapeRadius; dx++) {
    for (let dz = -B.escapeRadius; dz <= B.escapeRadius; dz++) {
      if (!dx && !dz) continue;
      const col = colOf(dx, dz);
      if (!col) continue;
      const cc = columnClear(col, B.upScan);
      if (!cc.clear) continue;
      const dist = Math.hypot(dx, dz);
      cells.push({ dx, dz, clear: true, kind: 'column', dist, swimMs: Math.round(dist * B.swimMsPerBlock), wx: Math.floor(self.x) + dx, wy: baseY, wz: Math.floor(self.z) + dz });
    }
  }
  // 最近能站的岸（`pickShore` 的判据只此一份，这里只负责把周围一圈读成它的输入）
  try {
    const ring = [];
    for (const o of shoreRingOffsets(2)) {
      const p = new Vec3(Math.floor(self.x) + o.dx, baseY + o.dy, Math.floor(self.z) + o.dz);
      const f = bot.blockAt(p); if (!f) continue;
      const below = bot.blockAt(p.offset(0, -1, 0));
      ring.push({ pos: { x: p.x, y: p.y, z: p.z }, below: below?.name || null, feet: f.name, head: bot.blockAt(p.offset(0, 1, 0))?.name || null, ok: true });
    }
    const shore = pickShore(ring, { x: self.x, y: self.y, z: self.z });
    if (shore) {
      const d = Math.hypot(shore.pos.x + 0.5 - self.x, shore.pos.z + 0.5 - self.z);
      cells.push({ dx: 0, dz: 0, clear: true, kind: 'shore', dist: d, swimMs: Math.round(d * B.swimMsPerBlock), wx: shore.pos.x, wy: shore.pos.y, wz: shore.pos.z });
    }
  } catch (_) { /* 岸读不到就不算候选（不是"没有岸"） */ }
  const plan = breathPlan({ self, selfClear, cells, oxygenLeftMs }, B);
  return { ...plan, oxygenLeftMs, selfClear };
}

/**
 * 四周全封死时的最后一手：把头顶挡住的方块挖掉（第 3 条）。
 *
 * 只挖**软的、能挖的**：沙子 / 砂砾 / 泥土 / 黏土 / 雪 / 草方块这类（她那天挖的就是沙子）。
 * **不挖**会放岩浆/危险东西进来的 —— 判据用 `place.js` 的 `DEADLY`（只此一份），命中就换下一格。
 * 一格都挖不了 → 如实报 `dug: 0`（**不留静默分支**：调用方照样会去跳，见 `checkBreath`）。
 */
async function breathDigOut (bot, state, I, plan, deps) {
  const DIGGABLE = /(^|:)(sand|red_sand|gravel|dirt|coarse_dirt|rooted_dirt|clay|snow|grass_block|podzol|mud|soul_sand|soul_soil|sandstone|terracotta)$/;
  const pos = bot.entity.position;
  const self = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const triedDirs = [[0, 1], [1, 1], [-1, 1], [0, 2], [1, 2], [-1, 2], [0, 3], [1, 3], [-1, 3]];
  const dug = [];
  const skippedDeadly = [];
  for (const [dx, dy] of triedDirs) {
    const p = new Vec3(self.x + dx, self.y + dy, self.z);
    const b = bot.blockAt(p);
    if (!b || /^(air|cave_air|void_air)$/.test(b.name) || blocksWater(b.name, b.getProperties?.())) continue;
    if (placeLogic.DEADLY.test(b.name)) { skippedDeadly.push(b.name); continue; }
    if (!DIGGABLE.test(b.name)) continue;   // 石头/矿石不挖（挖不动也危险）
    try {
      await withTimeout(bot.dig(b));
      const after = bot.blockAt(p);
      if (after?.name !== b.name) dug.push({ at: { x: p.x, y: p.y, z: p.z }, name: b.name });
    } catch (e) { /* 挖不动就下一个 */ }
    if (dug.length) break;   // 开了一个口子就去跳
  }
  const r = { dug: dug.length, blocks: dug.slice(0, 3), skippedDeadly, why: plan.why };
  note({ kind: 'breathe_dig', ...r });
  return r;
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
    gazeSeen: new Map(),           // 玩家名 → 这个窗口里已经看过他几眼了（见 gazeQuotaLeft；2026-09-29 问题 1）
  };
  // 跨重连保留状态；新加的本能补上默认配置（老的 state.instinct 里没有）
  fillCfg(I.cfg);
  I.gazeEngagedUntil ||= new Map();   // 老 state 里没有（见 gazeEngaged）；趁早建好，礼物钩子要用
  I.gazeSeen ||= new Map();           // 老 state 里没有（见 gazeQuotaLeft）；"这个窗口看过几眼"
  I.torchAnchor ||= null;             // 暗处插火把：上次检查时她在哪（走够 everyBlocks 才再检查）—— 第 8 批第 4 条
  I.followSeen ||= null;              // 跟随中：上一帧看到的玩家位置（判断他动不动）—— 第 8 批第 6 条
  I.followMovedAt ||= 0;              // 跟随中：他上一次"动过"的时间戳
  I.delve ||= null;                   // 正在进行的下矿记录（mind 发起 / 本能续探）—— 第 8 批第 5 条
  I.noteDelve = (a, r, now) => noteDelve(I, a, r, now);   // hands.js 的 /delve 路由回调（接线只此一处）
  I.torchMode ||= null;               // 火把开关的**缓存**（`memory/torch-mode.json` 的镜像）—— 2026-09-29
  I.torchModeAt ||= 0;                // 上次从盘上读的时刻（见 torchModeState）；别每拍都读盘
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
      // 礼物往来也是一次"新互动"：重开窗口并刷新看他一眼的额度（`engage` 时行为一致，
      // 但那函数定义在后面，这里没法提前调 —— 所以两处都写，判据仍在 social.js 的 gazeQuotaLeft）。
      I.gazeEngagedUntil.set(String(s.thrower), Date.now() + (I.cfg.gaze.giftMs || 15000));
      I.gazeSeen?.delete(String(s.thrower));
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

  // 第 4 步去重：原为本函数内的本地定义，与 instinct/mining.js:45 的 `bareNameOf` 逐字重复 ——
  // 唯一一份在 src/util/ids.js（本文件顶层已 require）。保留本地名 `bareName` 不动调用点。
  const bareName = bareMinecraft;
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

  // ------------------------------------------------------------------ 火把开关（2026-09-29）
  //
  // 场合判定 / 冷却 / 存盘**全在 `mining.js` 那三个纯函数里**（`torchSituation` / `pickTorchAsk` /
  // `pickTorchStep`）—— 这里只做"接线"：把实时状态喂进去、把结果落盘、把该问的话变成事件。
  // 判据不再写第二份（AGENTS.md §5-4）。
  //
  // **谁读谁写**：本进程（bridge）是 `memory/torch-mode.json` **唯一**的写者。mind 经 HTTP
  // （`POST /torch_mode` / `GET /instinct`）读写，不碰文件 —— 否则两个进程各写一份必互相覆盖。
  const TORCH_REREAD_MS = 4000;   // 缓存保鲜期：`mind` 刚改完开关，最多 4 秒后本进程就能看见

  /**
   * 读开关（带缓存）。写者只有本进程的 `torchAskPlan` / `POST /torch_mode`，
   * 它们改完会**主动刷新** `I.torchMode`，所以这里的保鲜期只为"人工改了文件"兜底。
   * 读不出来（坏 JSON / 没权限）**照默认值走但带 `why`**，调用方要能把"读不到"说出来（AGENTS.md §5-1）。
   */
  function torchModeState (now = Date.now()) {
    if (!I.torchMode || now - (I.torchModeAt || 0) > TORCH_REREAD_MS) {
      const L = loadTorchMode();
      I.torchMode = L.state;
      I.torchModeAt = now;
      I.torchModeWhy = L.unreadable ? L.why : null;   // 正常读出来就把上次的错清掉
    }
    return I.torchMode;
  }

  /** 刚改过盘上的开关 → 立刻把缓存对齐（不等保鲜期，免得下一拍按旧值判断） */
  function refreshTorchMode () { I.torchModeAt = 0; return torchModeState(); }

  /**
   * "正在下矿" —— `I.delve` 有效且这次下矿还"活着"（`pickDelveResume` 同一套判据，不另写一份）。
   * 纯函数里只认这个 boolean：**它是"主人让下矿"的直接证据**，哪怕她已经走到洞口（地面上）也算下矿中。
   */
  const delvingOf = () => !!pickDelveResume({
    delve: I.delve, self: bot.entity?.position ?? null, now: Date.now(),
    resumeMs: I.cfg.delve.resumeMs, reach: I.cfg.delve.reach, enabled: I.cfg.delve.enabled,
    caveEnabled: I.cfg.cave.enabled,
  }).resume;

  /**
   * **要不要经 mind 问主人一次**"家里挺暗的，要插火把吗" —— 该问才问。
   *
   * 家里那条路上"发现暗处"和"开口问"是**两件事**：暗处照样记（`dark_spot` 报给 mind，她
   * 心里有数），但**只在 `home=ask` 且冷却过了**才真的请 mind 开口。所以：
   *   · 该问 → 发 `torch_ask` 事件（**带 `askPlayer:'torch'`** —— 这是放行"这句话能说出口"的标记，
   *     见 `src/mind/mind/think.js` 的 `torchAskAllowed`。不放行的话它会被"少问 / 反问"那道闸拦掉）；
   *   · 不该问 → `null`，调用方退回原来的 `dark_spot`（免得连"家里有暗处"都不告诉她了）。
   *
   * @param {number} darkCount  这一轮数出几格暗（0 = 没暗处，不发）
   * @returns {?{ask:boolean, why:string, leftMs:number}} null = 不该开口（走 `dark_spot`）
   */
  function torchAskPlan (darkCount, now = Date.now()) {
    const sits = torchSituation({
      exposure: (() => { try { return deps.exposureOf?.(bot) ?? null; } catch (_) { return null; } })(),
      atHome: bot.entity ? inHome(bot.entity.position) : null,
      delving: delvingOf(),
      modes: torchModeState(now),
    });
    if (sits.where !== 'home' || sits.mode !== 'ask') return null;
    const pick = pickTorchAsk({ mode: sits.mode, state: torchModeState(now), now, darkCount });
    if (!pick.ask) return null;
    // 问的时刻**立刻落盘**：没回答的 6 小时冷却按它算，进程重启也不能丢（不然一重启又问一遍）。
    const w = markTorchAsked(torchModeState(now), now);
    I.torchMode = w.state; I.torchModeAt = now;
    return pick;
  }

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
    const torches = (() => { try { return deps.hands.torchCount?.(bot) ?? 0; } catch (_) { return 0; } })();
    // "暗不暗"只认**这一格的实测亮度**（判据只此一份：body/util.js 的 lightVerdict，这里注入真身）。
    // 2026-09-29 问题 B：以前还探 `nearestLight`，于是"附近有火把"就让这一步不插 —— 和 lightUp 同一个错。
    const verdict = deps.hands.lightVerdict || undefined;
    const plan = pickTorchStep({
      exposure: ex, light: li?.block ?? null, torches, movedSince: moved, lightVerdict: verdict,
      // 场合（2026-09-29 火把开关）：在家那格按 `home`（ask/off 都**不自己插**），
      // 下矿 / 地下永远 auto（`away=off` 也照插 —— 洞里是当场危险，理由见 mining.js 那段）。
      atHome: bot.entity ? inHome(here) : null,
      delving: delvingOf(),
      modes: torchModeState(),
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
    // 视野里看得见的（原判据，`canSeeBlock`）
    const visible = deps.hands.unseenChests(bot, state, L.radius).length + deps.hands.unseenCarts(bot, state, 16).length;
    // ★ 2026-09-29（主人："看到之后高優先級去獲取內容"）：**记忆里记得的**野外没开过的容器也算。
    //   为什么：`unseenChests` 要求"此刻看得见"（`bot.canSeeBlock`），可她的"余光"是 32 格、
    //   而且看过就记进了 `memory/resources.json` —— 人走过一个箱子、转个身看不见了，
    //   依然会去开。只要**记得 + 走得到**就该去。判据在 `perception.containerTargets`（同一份）。
    let remembered = [];
    try {
      const P = require('../world/perception');
      const store = P.load();
      const seenKeys = state.seenContainers || null;
      remembered = P.containerTargets(store.places, { home: I.home, seenKeys, dim: dimNow(), now: Date.now() })
        // 只算走得到的（太远的记忆不当"现在就去做"的目标 —— 那是长期计划的事）
        .filter(c => Math.hypot(c.center.x - self.x, c.center.z - self.z) <= L.radius);
    } catch (_) { remembered = []; }   // 记忆读不到 = 只按看得见的算（不猜成"没有"）
    const chests = visible + remembered.length;
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
      // 记忆里的目标也带上（`near` 让 `unseenChests` 把它们当"确实要开的那几个"：
      // 该参数本来只给"进了建筑"用，语义就是"看不看得见都算"）。
      const near = remembered.length
        ? { ...remembered[0].center, r: L.radius }
        : null;
      const { r, aborted } = await runJob('loot', { route: 'POST /chests/check' }, (abort) => deps.handlers['POST /chests/check']({ radius: L.radius, home: I.home, max: 4, near, abort }));
      const sm = summarizeLoot(r?.checked);
      note({ kind: 'loot', opened: sm.opened, from: remembered.length ? 'memory+visible' : 'visible', aborted: aborted || undefined, error: r?.error });
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
            // 2026-09-29 火把开关：这一轮该不该**开口问主人**（`home=ask` 且冷却过了）。
            // 该问 → `torch_ask`（带 `askPlayer:'torch'`，放行"要插火把吗"这句话）；
            // 不过问的冷却 / 主人说过"不用"的 24 小时 → 退回 `dark_spot`：**暗处照报**（该告诉她的
            // 一句不少），只是不再催她"去插火把"——"别催"拦的是"催插火把"这个动作，不是"家里有暗处"这条信息。
            // 为什么是退回 `dark_spot` 而不是干脆不发：`dark_spot` 只是**告知**（mind 拿去记 `W.darkSpots`、
            // 需要时自己调 `light_up`；想插的话那条路不经过开关，见 TASK 的硬规则"只改本能层的自动插"）。
            // 真要说"连说都别说"的是 `home=off` —— 那时 `torchAskPlan` 返回 null 且暗处也**不必报**。
            const q = d.kind === 'unreadable' ? null : torchAskPlan(d.count ?? cells.length);
            if (q?.ask) {
              event('torch_ask', '家里有些地方挺暗的，要插火把吗？', {
                askPlayer: 'torch',                                  // ← 放行标记（见 mind/think.js）
                count: d.count ?? cells.length,
                sample: d.sample || [],
                why: q.why,
              });
            } else if (d.kind === 'no_source') event('dark_spot', '家里一个光源（火把、灯）都没看到，夜里整片都会刷怪', { count: cells.length });
            else if (d.kind === 'dark') event('dark_spot', `家里有 ${d.count} 格地面是全黑的（比如 ${d.sample.map(q => `${q.x},${q.y},${q.z}`).join(' / ')}），夜里会刷怪`, { count: d.count, sample: d.sample });
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
  //
  // ⚠️ 2026-09-29 实机修（主人："為什麼他在把家裡放了水？"）：
  //   ① 她从 **5 格** 高掉下来就倒水 —— 原版摔落伤害 = 落差 − 3，5 格只扣 2 点（1 颗心）。
  //      判据换成 `mlgShouldPlace`（`survival.js`，伤害模型 `mlgFallDamage`，只此一处）：
  //      家外"≥ 血一半 或 ≥ 6 点"才倒，家里**只在会摔死时**倒。
  //   ② 倒完的水**没收回来**：旧的 `collectWater` 直接在原地 `lookAt` + `activateItem`，
  //      **没有"走到水边"这一步** —— 落地后她站在水的上面/旁边，射线够不到水面，右键当然装不上；
  //      而且整段 `catch (_) {}` 把异常吞了，事件只能说"没收回来"，说不清为什么。
  //      现在照 `body/commonsense.js` 的 `fillBucket`（现成判据，不抄第二遍）：
  //      走过去（3 格内）→ 对准 → 右键 → 失败重试 `retrieveRetries` 次 → 仍失败则如实报坐标与原因。
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
      if (blocksWater(b.name, b.getProperties?.())) return { y: b.position.y + 1, water: true };
      if (b.boundingBox === 'block') return { y: b.position.y + 1, water: false, pos: b.position };
    }
    return null;
  };
  /** 身上的效果名（读不到 = []；判"缓降 / 摔落保护"要用，反正读不到就不减伤） */
  const mlgEffects = () => {
    try {
      const eff = bot.entity?.effects;
      if (!eff || typeof eff !== 'object') return [];
      return Object.values(eff).map(e => bot.registry?.effects?.[e.id]?.name).filter(Boolean);
    } catch (_) { return []; }
  };
  /** 落点是不是"带 fall_damage_resetting 标签"的方块（整合包真值，不写死名单） */
  const landSafeTag = (name) => {
    if (!name) return false;
    try {
      const id = name.includes(':') ? name : `minecraft:${name}`;
      return !!deps.knowledge?.load?.().blockTags?.get(id)?.has('minecraft:fall_damage_resetting');
    } catch (_) { return false; }
  };
  // 收不回来的水点（闲时回去收；**绝不写死坐标**）。最多 CFG.mlg.pendingMax 条。
  I.pendingWater ||= [];
  async function collectWater () {
    if (M.collecting || !M.placed) return;
    M.collecting = true;
    const { Vec3 } = require('vec3');
    const tgt = M.placed.pos;
    const fall = M.placed.fall;
    try {
      await sleepMs(250);
      let reason = '还没开始试';
      for (let tries = 0; ; tries++) {
        const hasWB = bot.inventory.items().some(i => i.name === 'water_bucket');
        const hasEmpty = bot.inventory.items().some(i => i.name === 'bucket');
        // 1 格半径内找水源方块（水可能往下/往旁边流了一点）
        let src = null;
        for (let dx = -1; dx <= 1 && !src; dx++) for (let dy = -2; dy <= 1 && !src; dy++) for (let dz = -1; dz <= 1 && !src; dz++) {
          const b = bot.blockAt(tgt.offset(dx, dy, dz));
          if (b && blocksWater(b.name, b.getProperties?.()) && bot.blockAt(tgt.offset(dx, dy, dz))?.name === 'water') src = b;
        }
        const d = src ? Math.hypot(src.position.x + 0.5 - bot.entity.position.x, src.position.z + 0.5 - bot.entity.position.z) : Infinity;
        const plan = waterRetrievePlan({
          attempts: tries, hasWaterBucket: hasWB, hasEmptyBucket: hasEmpty,
          nearEnough: d <= I.cfg.mlg.retrieveWalkNear, sawSource: !!src,
        }, I.cfg.mlg);
        if (plan.done) { reason = plan.why; break; }
        if (plan.act === 'walk' && src) {
          // 走过去（复用 bridge 的运动：本能走位，和 fillBucket 同一套）
          try {
            await deps.handlers['POST /go']({ x: src.position.x, y: src.position.y, z: src.position.z, range: I.cfg.mlg.retrieveWalkNear, maxMs: 4000 });
          } catch (_) {}
          await sleepMs(200);
          continue;   // 走完再判一次（下一轮会走到 aim）
        }
        // aim：对准水源方块右键（照 fillBucket 的 offset(0.5, 0.8, 0.5)）
        if (!src) { reason = '找不到水源方块'; break; }
        const bucket = bot.inventory.items().find(i => i.name === 'bucket');
        if (!bucket) { reason = '身上没有空桶'; break; }
        if (bot.heldItem?.name !== 'bucket') await bot.equip(bucket, 'hand');
        await bot.lookAt(src.position.offset(0.5, 0.8, 0.5), true);
        bot.activateItem();
        await sleepMs(400);
        reason = `第 ${tries + 1} 次右键了，桶没装上水`;
      }
      const ok = bot.inventory.items().some(i => i.name === 'water_bucket');
      if (ok) {
        event('mlg', `从 ${Math.round(fall)} 格高掉下来，落地前倒了水、又收回来了`);
        // 收回来了：把它从"待收"清单里删掉（闲时收水那一份）
        I.pendingWater = I.pendingWater.filter(p => !(p.x === tgt.x && p.y === tgt.y && p.z === tgt.z));
      } else {
        // ★ 说不清原因就等于没说（AGENTS.md §5-1）：坐标 + 为什么 + 还会不会再试
        event('mlg', `从 ${Math.round(fall)} 格高掉下来倒了水，但**没收回**（在 ${tgt.x},${tgt.y},${tgt.z}，因为${reason}）—— 记下来了，闲下来回去收`, { at: { x: tgt.x, y: tgt.y, z: tgt.z }, reason });
        state.ledger?.note({ route: 'mlg', retrieved: false, why: reason, at: `${tgt.x},${tgt.y},${tgt.z}` });
        // 记进"没收回来的水"，闲时（身体空着）回去收 —— 不写死坐标
        if (I.pendingWater.length < (I.cfg.mlg.pendingMax ?? 8)
          && !I.pendingWater.some(p => p.x === tgt.x && p.y === tgt.y && p.z === tgt.z)) {
          I.pendingWater.push({ x: tgt.x, y: tgt.y, z: tgt.z, at: Date.now(), why: reason });
        }
      }
    } catch (e) {
      event('mlg', `从 ${Math.round(fall)} 格高掉下来倒了水，收回时出错了（在 ${tgt.x},${tgt.y},${tgt.z}）：${e.message}`);
      state.ledger?.note({ route: 'mlg', retrieved: false, error: e.message, at: `${tgt.x},${tgt.y},${tgt.z}` });
    } finally { M.placed = null; M.collecting = false; }
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
      const landName = g?.pos ? bot.blockAt(g.pos)?.name ?? null : null;
      const act = mlgStep({
        startY: M.startY, y: e.position.y, vy: e.velocity?.y ?? 0, landY: g?.y ?? null, landIsWater: !!g?.water,
        hasBucket: hasWaterBucket(), holding: bot.heldItem?.name === 'water_bucket',
        nether: /nether/.test(String(bot.game?.dimension || '')), placed: !!M.placed,
        // ★ 2026-09-29：这些是"该不该倒"的输入（判据在 survival.js 的 mlgShouldPlace）
        hp: bot.health ?? 20, inHome: inHome(e.position),
        landName, landSafe: landSafeTag(landName), effects: mlgEffects(),
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

  /**
   * 闲时回去收"之前没收回来的水"（2026-09-29 实机：家里 `17,123,6` 那摊水就是这么留下的）。
   *
   * **不写死坐标** —— 位置只来自 `I.pendingWater`（倒水那次失败时记下的）。
   * 判据全在 `waterRetrievePlan`（和落地那次收水共用），这里只负责"走过去 + 右键"。
   * 只在她真闲着时做（身体空着、有桶、不在打架），够近才去（不为收一滩水跑半个地图）。
   */
  async function tryCollectPendingWater () {
    if (!I.cfg.mlg.enabled || M.collecting || !bot.entity) return null;
    if (I.running || state.currentAction || I.inflight > 0) return null;   // 身体被占着
    const list = I.pendingWater || [];
    if (!list.length) return null;
    if (Date.now() - (I.lastPendingWaterAt || 0) < 60000) return null;
    const hasEmpty = bot.inventory.items().some(i => i.name === 'bucket');
    if (!hasEmpty) return null;
    const here = bot.entity.position;
    // 只挑够近的（20 格以内），且优先最近的
    const near = list.filter(p => Math.hypot(p.x - here.x, p.z - here.z) <= 20)
      .sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
    if (!near.length) return null;
    I.lastPendingWaterAt = Date.now();
    const p = near[0];
    // 用**落地收水那一套**：走过去 → 对准 → 右键（M.placed 只是"收水流程"的入参载体）
    const saved = M.placed;
    M.placed = { pos: { x: p.x, y: p.y, z: p.z, offset: (dx, dy, dz) => require('vec3').Vec3(p.x + dx, p.y + dy, p.z + dz) }, fall: 0 };
    await collectWater();
    const still = (I.pendingWater || []).some(q => q.x === p.x && q.y === p.y && q.z === p.z);
    if (!still) event('mlg', `回去把之前在 ${p.x},${p.y},${p.z} 留下的水收回来了`);
    M.placed = saved;
    return { did: 'mlg_water' };
  }

  // ---- 野外资源感知：她的"余光"（2026-09-29，主人："對野外資源不敏感"）------
  //
  // 为什么要有：mind 每一轮看到的只有**实体**（`/nearby`），树 / 黏土 / 沙 / 甘蔗 /
  //   露出的矿……她完全看不见（唯一的 `oreWatch` 只报值钱的矿、只看 12 格）。
  //   实机表现：她扫一次没扫到黏土就说"附近沒黏土"。
  //
  // 这一段**只做三件事**（判断全在 `world/perception.js` 的纯函数里）：
  //   ① 扫一圆看得见的方块（分段让出，绝不冻进程）→ 分类 → 聚片；
  //   ② 并进 `memory/resources.json`（同片合一、久未确认降权、去了没了就删）；
  //   ③ 新发现的、用得上的（缺的 / 值钱的 / **没开过的野外容器**）告诉 mind，同类冷却。
  //
  // ⚠️ 绝不在 `tick()` 里同步扫（`scanColumnsIn` 虽然逐列让出，但仍是个长活）——
  //    这是独立计时器 + `busy` 防叠，和 `homeTimer` 同一套写法
  //    （`homeTimer` 以前同步扫 14 秒冻结过一次，见 HANDOFF-20260928.md）。
  let perception = null;
  try { perception = require('../world/perception'); } catch (_) { perception = null; }
  if (!perception) perception = deps.perception || null;   // 注入的优先（测试/装配时给的）
  let perceptionBusy = false;
  const perceptionTimer = setInterval(async () => {
    const PC = I.cfg.perception;
    if (!PC?.enabled || !perception || !bot.entity || !I.cfg.loot) return;   // perception 读不到就整段不跑
    // ① 该不该扫 —— 判据在 `perception.shouldRescan`（同一判据只写一处）：
    //    没怎么动 + 距上次不到 minRescanMs → 不扫；走路/打架/开着界面 → 放慢到 busyEveryMs。
    //    ⚠️ 以前只有"到点就扫"一条：原地站着也每 5 秒整个重扫一遍（cluster 是最贵的一段），
    //    而且她走路时照样全速扫，正是"走路很乱"的一分子（2026-09-29 实机）。
    const _pp = bot.entity?.position;
    const _moveDist = (_pp && I.lastPerceptionPos)
      ? Math.hypot(_pp.x - I.lastPerceptionPos.x, _pp.z - I.lastPerceptionPos.z) : null;
    const _occupied = !!(I.inflight > 0 || state.pathing || state.gui || I.combat?.engaged);
    const _rs = perception.shouldRescan({
      sinceMs: Date.now() - (I.lastPerceptionAt || 0),
      moveDist: _moveDist, busy: perceptionBusy, occupied: _occupied,
    }, PC);
    if (!_rs.scan) {
      // 只在"本来该扫却没扫"时留一行（否则每 2 秒一条纯噪声）
      if ((Date.now() - (I.lastPerceptionAt || 0)) >= PC.everyMs * 3) {
        I.diagnostics ||= {};
        I.diagnostics.perceptionSkip = { at: Date.now(), why: _rs.why, everyMs: _rs.everyMs };
      }
      return;
    }
    perceptionBusy = true;
    I.lastPerceptionAt = Date.now();
    if (_pp) I.lastPerceptionPos = { x: _pp.x, z: _pp.z };
    try {
      // 真实标签 → registry id（整合包真值，不写死名单）
      const tagIds = (tag) => {
        try { const s = deps.knowledge?.load?.().tags?.get(`block:${tag}`); return s ? [...s] : []; } catch (_) { return []; }
      };
      const tagOf = (name, tag) => {
        try {
          const id = name.includes(':') ? name : `minecraft:${name}`;
          return !!deps.knowledge?.load?.().blockTags?.get(id)?.has(tag);
        } catch (_) { return false; }
      };
      const r = await perception.scanAround({
        bot, radius: PC.radius, tagIds, tagOf, scanIn: scanColumnsIn, yieldFn: yieldLoop,
        dy: PC.dy, batchColumns: PC.batchColumns,
        // 建 ID 名单每 500 个方块让出一次（整合包 registry 2 万多个，整段跑完 30ms 会冻进程）；
        // 聚片每切完一片 / 每 12ms 让出一次（点多了 cluster 本身能到 50ms+）。两个都进 CFG，理由写在 config.js。
        idBuildBatch: PC.idBuildBatch, clusterSliceMs: PC.clusterSliceMs,
      });
      const dim = dimNow();
      const before = perception.load();
      // ① 并进记忆（同片合一 / 刷新"又看见了"）
      const m = perception.merge(before, r.items.map(it => ({ ...it, dim })), Date.now(), { dim, mergeDist: PC.mergeDist });
      // ② 过期：她走过那片（近处）却整类都没再扫到 → 那类删掉；久未确认 → 降权
      const nearKinds = new Set(r.items.filter(it => Math.hypot(it.center.x - bot.entity.position.x, it.center.z - bot.entity.position.z) <= PC.goneRadius).map(it => it.kind));
      const f = perception.forget(m.store, {
        now: Date.now(), near: bot.entity.position, goneRadius: PC.goneRadius,
        goneKinds: nearKinds.size ? nearKinds : null,
        decayAfterMs: PC.decayAfterMs, decayRate: PC.decayRate,
      });
      // goneKinds 传的是"这一轮在这一带扫到的类别"：只有这一类**在近处出现过**，
      // 才谈得上"同一个位置的同类没了"。整类都没扫到 ≠ 没了（可能是没加载）—— 不删。
      // ② 写盘：**不是每轮都写**（`shouldSave`）—— 没变化不写；有变化也攒到 saveMinIntervalMs 再写；
      //    而且用**异步** `saveAsync`（同步 `writeFileSync` 写在 5 秒一轮里就是白白堵一下事件循环）。
      //    场景签名（条数 + 最近一条的 seenAt）用来判断"文件内容变了没"，省得为了比内容再 JSON 一遍。
      const _sig = `${f.store.places.length}:${f.store.places.length ? f.store.places[f.store.places.length - 1].seenAt : 0}`;
      const _sv = perception.shouldSave({
        changed: (m.added.length + m.refreshed.length + f.decayed.length + f.gone.length) > 0,
        sinceSaveMs: Date.now() - (I.lastPerceptionSaveAt || 0), sig: _sig, lastSig: I.lastPerceptionSaveSig,
      }, PC);
      let _saved = false;
      if (_sv.write) {
        _saved = await perception.saveAsync(f.store);
        if (_saved) { I.lastPerceptionSaveAt = Date.now(); I.lastPerceptionSaveSig = _sig; }
      }
      // ③ 新发现才说话，而且只说用得上的（缺的 / 值钱的 / 没开过的野外容器）
      //    —— `worthTelling` 是唯一判据（花 / 砂砾 / 普通树 / 石头都不发事件，
      //       它们照样进【附近看得见的】那一行和资源记忆，只是不打断 mind）。2026-09-29 修刷屏。
      const needs = perception.needsFrom({
        planStep: deps.plan?.current?.()?.text || '',
        ambition: deps.ambition?.state?.()?.focus || '',
      });
      const ranked = perception.rank(m.added.map(it => ({ ...it, distance: Math.hypot(it.center.x - bot.entity.position.x, it.center.z - bot.entity.position.z) })), needs, { max: 6 });
      // 同类同区域冷却（同一类别 + 同一 16 格网格 N 分钟只报一次）+ 全局每分钟上限 —— 都在 CFG.perception
      const _minute = Math.floor(Date.now() / 60000);
      if (I.resourceToldMinute !== _minute) { I.resourceToldMinute = _minute; I.resourceToldCount = 0; }
      const _grid = PC.tellRegionGrid || 16;
      for (const it of ranked) {
        const w = perception.worthTelling(it, { needs });
        if (!w.tell) continue;                                   // 花 / 砂砾 / 普通树 → 不发
        if ((I.resourceToldCount || 0) >= (PC.tellPerMinute ?? 4)) break;   // 全局每分钟帽
        // 冷却键：**类别 + 区域**（不是"类别 + 精确中心"）—— 同一片花挪了两格不该再报一次
        const gx = Math.round(it.center.x / _grid), gz = Math.round(it.center.z / _grid);
        const key = `res:${it.kind}:${gx},${gz}`;
        I.resourceTold ||= new Map();
        const last = I.resourceTold.get(key) || 0;
        if (Date.now() - last < PC.tellCooldownMs) continue;
        I.resourceTold.set(key, Date.now());
        I.resourceToldCount = (I.resourceToldCount || 0) + 1;
        // 「缺这个」要说清是**哪种**：`w.label` 是命中 needs 的那个具体词（"铁"→"铁矿（你现在正缺铁）"）
        const why = w.why === 'need' ? `（你现在正缺${w.label || it.name || ''}）` : '';
        const wet = it.underwater && it.kind !== 'water' ? '，在水下' : '';
        const dir = it.direction || '附近';                      // merge 里已补 direction 字段（这里再加一道兜底）
        const dist = Number.isFinite(it.distance) ? Math.round(it.distance) : '?';
        event('resource_seen', `余光扫到：${perception.displayName(it)}（${dir} ${dist} 格，${it.center.x},${it.center.y},${it.center.z}）${wet}${why}`, { kind: it.kind, name: it.name, pos: it.center, count: it.count });
      }
      // ★ 野外**没开过**的容器：立刻高优先级告诉 mind（主人点名）
      // 判据 `containerTargets` 已筛过"野外的 + 没开过的 + 这个维度 + 够新"；
      // 这里再用 `visitedStructures`/`resourceTold` 去重（一个箱子只喊一次）。
      const seenKeys = state.seenContainers || null;
      const boxes = perception.containerTargets(f.store.places, {
        home: I.home, seenKeys, dim: dimNow(), now: Date.now(),
      });
      for (const c of boxes.slice(0, 2)) {
        const key = `chest:${c.center.x},${c.center.y},${c.center.z}`;
        if (I.visitedStructures?.has(key) || (I.resourceTold?.get(key) || 0) > 0) continue;
        I.resourceTold ||= new Map();
        I.resourceTold.set(key, Date.now());
        const who = /barrel/.test(c.name) ? '木桶' : /shulker/.test(c.name) ? '潜影盒' : '箱子';
        event('chest_seen', `看见一个没开过的${who}（${c.center.x},${c.center.y},${c.center.z}，${Math.round(Math.hypot(c.center.x - bot.entity.position.x, c.center.z - bot.entity.position.z))} 格）—— 手上没急事就去开`, { name: c.name, pos: c.center, urgent: true });
      }
      // 每轮耗时写进诊断（任务书要求能在 GET /instinct 看到）
      // ⚠️ 关键：`slow` 要说清**是哪一段**慢 —— `r.perf.phases` 里最长的那个（2026-09-29 修"只报总时长"）。
      const _ph = r.perf.phases || {};
      let _worst = null;
      for (const [k, v] of Object.entries(_ph)) if (!_worst || v > _ph[_worst]) _worst = k;
      I.diagnostics ||= {};
      I.diagnostics.perception = {
        at: Date.now(), radius: PC.radius, ...r.perf,
        found: r.items.length, added: m.added.length, refreshed: m.refreshed.length,
        decayed: f.decayed.length, gone: f.gone.length, places: f.store.places.length,
        containers: boxes.length, saved: _saved, saveWhy: _sv.why, scanned: true,
        slowest: _worst, slowestMs: _worst ? _ph[_worst] : null,
        told: I.resourceToldCount || 0,
      };
      // 单段 > phaseWarnMs（默认 30ms）就报，并且**点名是哪一段**；
      // 总时长 > 500ms 也报（老判据，保留）。
      if (_worst && _ph[_worst] > (PC.phaseWarnMs ?? 30)) slow(`perception.${_worst}`, _ph[_worst]);
      if (r.perf.ms > 500) slow('perception.scanAround', r.perf.ms);
    } catch (e) {
      I.diagnostics ||= {};
      I.diagnostics.perception = { at: Date.now(), error: e.message };
    } finally { perceptionBusy = false; }
  }, 2000);

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
      // 背着背包：**organizeStorage 自己就会把背包里的倒出来再归位**（2026-09-29 移到身体层）。
      // 以前这里是"外面套一层 unpack + organize，最多两轮" —— 背包一大两轮清不完，而且
      // 那层 unpack 是盲倒（不看倒出来了什么），和身体层各写一份。现在只调一次，让它自己做到底。
      const organizeArgs = storagePolicy.storageRequest(h, { abort, mode: 'daily' }, { discover: false });
      if (!organizeArgs.only?.length) return { error: '家里没有可自动整理的已登记箱子（还没登记，或都受保护）；不会猜哪些箱子能动' };
      const r = await deps.handlers['POST /storage/organize'](organizeArgs);
      return { ...r, unpacked: r?.backpack?.unpacked || 0 };
    });
    const after = kitNow();
    // 背包那一段单独说清（读不到 / 箱子满了 / 倒完了），不和"整理完了"混成一句
    const bp = r?.backpack;
    const bpNote = bp && bp.status === 'unreadable' ? `；背包读不到（${bp.why || '打不开'}），里面的没算`
      : bp && bp.status === 'chestsFull' ? `；箱子装不下背包里剩下的（还剩 ${bp.remaining ?? '?'} 件）`
        : bp && bp.unpacked ? `（其中从背包倒出来 ${bp.unpacked} 件）` : '';
    note({ kind: 'tidy', why: pick.why, aborted: aborted || undefined, moved: r?.moved, error: r?.error, backpack: bp?.status });
    if (!aborted) {
      event('tidy', r?.error
        ? `想回家整理（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
        : `${r?.completed === false ? '回家整理了一部分' : '回家整理了'}（${pick.why}）：搬了 ${r?.moved ?? 0} 组${bpNote}${after.short.length ? `；还缺 ${after.short.join('、')}` : '，该带的都带上了'}`,
      r?.boxes ? { storage: { completed: r.completed === true, boxes: r.boxes } } : {});
    }
    return { did: 'tidy' };
  }

  // ---- 转头看人（独立的小节拍：只转头，不占身体、不打断任何动作）
  //
  // 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
  // 所以这里**只对"刚和我互动过"的玩家**转头（窗口见 gazeEngaged）。窗口外 6 格内有人也不看。
  //
  // 2026-09-29 二次修正（主人："不要總突然看玩家"，问题 1）：上面那条没解决 —— 她说话频繁，
  // `noteSelfSpoke` 每句都开 15 秒窗口，窗口几乎一直开着，而这里每 3–6 秒就转一次头。
  // 现在两道新判据：
  //   ① **每个窗口只看一眼**（`G.lookPerWindow`，计数在 `I.gazeSeen`，`pickGaze` 里判）；
  //   ② 转头**平滑**（`turnTo`，不再 `lookAt(..., true)` 瞬间到位）。
  // `engage()` 开新窗口时清掉 `I.gazeSeen` 的对应计数 —— 他再说一句就又看他一眼。
  const engage = (player, ms) => {
    if (!player) return;
    if (!(ms > 0)) return;   // selfTalkMs=0（她自己开口不看他）→ 连窗口都不开
    try {
      I.gazeEngagedUntil.set(String(player), Date.now() + ms);
      I.gazeSeen?.delete(String(player));   // 新窗口 = 额度刷新（他再说一句又能看他一眼）
    } catch (_) {}
  };
  let nextGaze = 0;

  /**
   * 平滑转头：把视角一点一点转到目标，**不是**瞬间到位。
   *
   * 为什么不用 `bot.lookAt(p, true)`（任务书要求写清 `force` 的真实含义）：
   *
   * `_ref/mineflayer/lib/plugins/physics.js:342` 是 `bot.look(yaw, pitch, force)` 的定义。
   * 它先把差值按 **100ms 内线性插值**算成 `yawChange`/`pitchChange`（:`350-357`），
   * 累加到 `bot.entity.yaw`/`pitch` 上，再：
   *   · `force` 为真（:`361-365`）→ 直接设 `lastSentYaw/Pitch = 目标` 并 **立即 return**。
   *     官方注释（physics.js 顶部/各调用点）说得清楚：force 的语义是
   *     **"立刻把视角设成目标值、不等服务器确认"** —— 用于物理层同步（纠正飘移）、
   *     以及"必须马上面对某处"的场合（比如原版 `block_dig` 前）。它**跳过等待**，
   *     于是下一个 tick 的视角就是目标视角：世界看起来就是**瞬间**转过去的。
   *   · `force` 为假 / 省略 → `await lookingTask.promise`（:`367`），
   *     真的等那 ~100ms 的插值走完，视角中间有过渡帧 → 看着是**转过去**的。
   *   · 另外 `bot.lookAt(point, force)`（:`370-376`）只是把坐标算成 yaw/pitch 再转调 `look`。
   *
   * 所以：**给 `lookAt` 传第三个参数 `true` = 瞬间转**，正是"突然看玩家"的来源之一。
   * 这里改成分几次调用 `bot.look(yaw, pitch)`（不传 force）并 `await` 每次的插值，
   * 视觉上就是"慢慢转过去"。分 `G.turnSteps` 次是为了让转向更柔和、不像一次弹过去；
   * 中途每一小段都重新算目标（`bot.look` 自己会 finish 上一段），所以中途被打断也不会卡住。
   *
   * @param {object} ent 目标实体
   */
  const lookAtPlayer = (ent) => {
    try {
      const eye = ent.position.offset(0, (ent.height || 1.8) * 0.9, 0);
      const G = I.cfg.gaze;
      const steps = Math.max(1, Math.round(+G.turnSteps || 1));
      const self = bot.entity?.position;
      if (!self) return;
      // 目标 yaw/pitch 用和 mineflayer `lookAt` 一样的算法（physics.js:371-374），
      // 免得自己另写一套角度约定出偏差。
      const dx = eye.x - self.x;
      const dy = eye.y - (self.y + (bot.entity.eyeHeight || 1.62));
      const dz = eye.z - self.z;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
      // 一次转到位（steps=1）时就直接调，不多绕一层循环
      if (steps === 1) { bot.look(yaw, pitch); return; }
      // 分步：每一步都朝"目标"再走一点。`bot.look` 内部对上一次没走完的插值会
      // finish 掉，所以这里的 await 只是让这一小段插值跑完，不会互相打架。
      const startYaw = bot.entity.yaw || 0;
      const startPitch = bot.entity.pitch || 0;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        bot.look(startYaw + (yaw - startYaw) * k, startPitch + (pitch - startPitch) * k);
      }
    } catch (_) {}
  };
  const idleEyes = () => !I.running && !I.inflight && !bot.isSleeping && !bot.currentWindow && !bot.pathfinder?.isMoving?.() && !bot.targetDigBlock;
  const gazeTimer = setInterval(() => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity || !idleEyes()) return;
      // 过期窗口定期清掉，Map 不无限长
      const now = Date.now();
      for (const [k, at] of I.gazeEngagedUntil) if (now >= +at) { I.gazeEngagedUntil.delete(k); I.gazeSeen?.delete(k); }
      const players = Object.values(bot.players || {}).filter(p => p.entity && p.entity !== bot.entity).map(p => ({ name: p.username, ent: p.entity, pos: p.entity.position }));
      const g = pickGaze({ players, self: bot.entity.position, now, next: nextGaze, engagedUntil: I.gazeEngagedUntil, seen: I.gazeSeen }, G);
      if (!g) return;
      I.gazeSeen.set(String(g.name), (I.gazeSeen.get(String(g.name)) || 0) + 1);   // 记下"这个窗口已经看过他一眼"
      lookAtPlayer(g.ent);
      nextGaze = now + G.minGapMs + Math.random() * (G.maxGapMs - G.minGapMs);
    } catch (_) {}
  }, 1000);
  // 他跟她说话 → 立刻看一眼，并在 G.talkMs 内保持"可以看他一次"
  bot.on('chat', (username) => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || username === bot.username) return;
      const ent = bot.players[username]?.entity;
      if (!ent || ent.position.distanceTo(bot.entity.position) > G.chatRadius) return;
      engage(username, G.talkMs);
      if (!idleEyes()) return;             // 手上在干活/在走路：先别转头，等身体空下来再说
      I.gazeSeen.set(String(username), (I.gazeSeen.get(String(username)) || 0) + 1);   // 这一眼算在额度里
      lookAtPlayer(ent);
      nextGaze = Date.now() + G.maxGapMs;
    } catch (_) {}
  });
  /**
   * 她自己开口说话（bridge 的 `POST /chat` 调）。
   *
   * 2026-09-29（问题 1）：主人"她自己开口也不必每句都转头看人" —— 现在
   * `G.selfTalkMs` 默认 **0**，本函数直接不开窗（`engage` 对 ms<=0 会拒），
   * 于是她说话**不再**触发转头。留这个函数是为了接口不变 + 需要时能一键恢复
   * （把 `selfTalkMs` 设回 15000 就回到旧行为：对 16 格内最近的玩家开窗）。
   *
   * @returns {string|null} 开窗的玩家名；没开窗返回 null
   */
  I.noteSelfSpoke = () => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity) return null;
      if (!(G.selfTalkMs > 0)) return null;   // 默认：自己说话不看人（见 CFG.gaze 的注释）
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

  // 第 4 步去重：原来是本地定义（与 body/util.js、commonsense.js、bridge/util.js 逐字重复），
  // 现在唯一一份在 src/util/time.js（本文件顶层已 require）。
  // ================================================================ 战斗
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

  /**
   * 打架前换武器 / 上盾（2026-09-29 问题 2c：也要看精妙背包）。
   *
   * **什么时候才去背包拿** —— 阈值取 `first.dist >= 5`（`I.cfg.combat.fightFromBackpackDist`，默认 5）：
   *   · 怪还在 5 格开外 = "看见了"而不是"已经贴脸"。这时多花 0.7~1.4 秒开背包换把好剑是划算的
   *     （精妙背包一次 shift 拿一组要 `sleep(700)`，见 `fetchFromBackpack` 的注释）。
   *   · 怪已经 5 格以内（`C.detect` 默认值附近）→ **不碰背包**：开背包界面会关掉当前窗口 +
   *     暂停一瞬，贴脸时这一下足够被连打好几拳，得不偿失。宁可先用手上这把打，边打边拉开距离。
   *   · 阈值比"怪会不会立刻够到我"略宽一点：僵尸/骷髅的仇恨范围常在 8~16 格，5 格开外
   *     通常还有 1~2 秒缓冲，够一次拿取。
   *
   * 有距离就不猜：`first.dist` 读不到（测试桩）时按"贴脸"处理（保守，不乱开背包）。
   */
  async function equipForFight (first = null) {
    try {
      const dist = first?.dist ?? null;
      const hasShieldNow = /shield/.test(bot.inventory.slots[45]?.name || '') || bot.inventory.items().some(i => /shield/.test(i.name));
      const firstPick = deps.pickAutoEquip?.({ held: bot.heldItem?.name ?? null, inventory: bot.inventory.items().map(i => i.name), want: 'weapon' });
      // 判据是纯函数（instinct/combat.js 的 fightGearFetchPlan），理由写在那里的注释里
      const plan = fightGearFetchPlan({ dist, hasShield: hasShieldNow, hasWeapon: !!(firstPick?.itemName && firstPick.itemName !== bot.heldItem?.name) });
      // 盾：优先补（纯收益）。身上没有、怪又还远 → 去精妙背包拿
      if (!hasShieldNow) {
        let sh = bot.inventory.items().find(i => /shield/.test(i.name));
        if (!sh && plan.fetchShield && state && deps.hands.ensureCarried) {
          try {
            const got = await deps.hands.ensureCarried(bot, state, (it) => /shield/.test(it.name || ''), 1);
            if (got?.got > 0) sh = bot.inventory.items().find(i => /shield/.test(i.name));
          } catch (_) {}
        }
        if (sh) await bot.equip(sh, 'off-hand');
      }
      // 武器：先用手上这把的最优（pickAutoEquip 的结论），没有更好的、怪又还远才去背包翻
      let pick = firstPick;
      if (!(pick?.itemName && pick.itemName !== bot.heldItem?.name) && plan.fetchWeapon && state && deps.hands.ensureCarried) {
        try {
          const got = await deps.hands.ensureCarried(bot, state, (it) => /(sword|(^|_)axe)$/.test(it.name || ''), 1);
          if (got?.got > 0) pick = deps.pickAutoEquip?.({ held: bot.heldItem?.name ?? null, inventory: bot.inventory.items().map(i => i.name), want: 'weapon' });
        } catch (_) {}
      }
      if (pick?.itemName && pick.itemName !== bot.heldItem?.name) {
        const it = bot.inventory.items().find(i => i.name === pick.itemName);
        if (it) await bot.equip(it, 'hand');
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
    // 「有没有吃的」要连**精妙背包**一起算（2026-09-29 主人：实机 `hungry 饿了（饥饿 6/20），身上没有吃的`，
    // 其实面包塞在背包里）。三步，判据全部复用现成的，不另写名单：
    //   ① 身上有 → 有；
    //   ② 身上没有、背包快照里有吃的（`state.backpackSeen`，foodScore 只此一份）→ 也算有（`POST /eat` 会去拿）；
    //   ③ 快照读不到（从没开过 / 没背背包）→ **先打开看一眼**（`lookIntoBackpack`），还读不到才按"身上没有"报。
    // 不能把"背包读不到"直接当"没有吃的" —— 那正是她饿着不吃、还报错的根因（AGENTS.md §5-1）。
    let hasFood = bot.inventory.items().some(i => deps.hands.foodScore(i) > 0);
    if (!hasFood) {
      const seenFood = () => {
        const items = state.backpackSeen?.items;
        if (!items) return null;   // 读不到
        return Object.entries(items).some(([name, count]) => count > 0 && deps.hands.foodScore({ name }) > 0);
      };
      let inPack = seenFood();
      // ⚠️ 开背包看一眼会打断手上的事（开界面）：只在**真饿了、没在打架、没开着别的界面**时看，而且一分钟最多一次
      //    （2026-09-29 Claude 复核：原来这一步在判"饿不饿 / 忙不忙"之前，快照一直读不到时每 2 秒开一次背包）。
      //    忙着的时候只有饿到 urgentAt 才看（跟 pickEat 的"忙完再吃"一致）。
      const hungry = bot.food != null && bot.food <= I.cfg.eat.at;
      const busyNow = !!(I.inflight || state.currentAction || (I.running && I.running.kind !== 'combat'));
      const mayPeek = hungry && !fighting && !bot.currentWindow && (!busyNow || bot.food <= I.cfg.eat.urgentAt)
        && Date.now() - (I.eatPeekAt || 0) > 60000;
      if (inPack == null && deps.hands.lookIntoBackpack && mayPeek) {
        I.eatPeekAt = Date.now();
        try { await deps.hands.lookIntoBackpack(bot, state); } catch (_) {}
        inPack = seenFood();
      }
      hasFood = inPack === true;
      d.foodInBackpack = inPack;
    }
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
      if (r?.ate) note({ kind: 'eat', item: r.item, from: r.foodBefore, to: r.foodAfter, took: r.from === 'backpack' ? 'backpack' : undefined, urgent: pick.urgent || undefined });
      else I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
    } catch (e) {
      I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
      event('eat_failed', `想吃东西没吃成：${String(e.message).slice(0, 80)}`);
    } finally { eating = false; }
  }, I.diagnostics);
  const eatTimer = setInterval(() => checkEat(), CFG.eat.checkMs);

  // ---- 憋气：头在水里、氧气快没了 → 叫停命令，**先看清头顶再决定往哪走** ----
  //
  // 2026-09-29 实机（在水底挖沙子差点淹死）：原来只会原地往上跳（`POST /jump`），
  // 而头顶被沙子塌下来 / 坑顶有方块 / 在悬垂下面时，跳多少下都上不去
  // （那天 `jumped=38`，氧气从 8 一路掉到 -1 开始掉血）。
  // 她**知道周围每一格是什么**（`bot.blockAt`），所以现在：
  //   · 脚下这一列往上通到水面     → 照旧往上游（`up`）
  //   · 旁边（≤ escapeRadius）有出口 → 游过去再上浮（`swim`），或直接去最近的岸
  //   · 四周全封死                 → 才挖头顶（`dig`，只挖沙子/砂砾/泥土这类，见下）
  // 每一步都在 `note()` 里写清做了什么、为什么；上浮一段就回看氧气，没起色就换下一手，
  // **不许在一个办法上耗到淹死**。
  let breathing = false;
  const checkBreath = createCheck('breathe', async (d) => {
    if (ended || !state.connected || !I.cfg.breathe.enabled || breathing || !bot.entity) return;
    if (I.urgent && I.urgent !== 'combat') return;
    if (fighting && I.running?.kind !== 'combat') return; // 战斗装备/收尾期间先等它进入可取消阶段
    const B = I.cfg.breathe;
    // ⚠️ 氧气先归一（`oxygenNum`）：模组/握手把 metadata 槽位挪过之后
    //    `bot.oxygenLevel` 会读到 288 这种原始 air ticks 量级（2026-09-29 实机）。
    //    不可信的读数按"读不到"处理 —— 既不当作"氧气充足"（会漏掉憋气），
    //    也不传给 `POST /jump` 的 `stopAtOxygen`（288 ≥ 18 会让第一跳就"提前成功"，0.3 秒空转一拍）。
    const oxy = oxygenNum(bot.oxygenLevel ?? null);
    const headWet = headInWater(bot);
    // 头在水里泡了多久：氧气读不到时 needBreath 靠它判（见 survival.js needBreath）
    if (!headWet) I.headWetSince = null; else if (!I.headWetSince) I.headWetSince = Date.now();
    const underwaterMs = I.headWetSince ? Date.now() - I.headWetSince : 0;
    const eff = effectNames();
    if (!needBreath({ oxygen: oxy.value, headInWater: headWet, waterBreathing: waterBreathing(eff), underwaterMs }, B)) return;
    breathing = true;
    I.urgent = 'breathe';
    try {
      if (I.running) I.running.abort();
      deps.cancelCommands?.('憋不住气了，先上去换气');
      if (Date.now() - (I.breathToldAt || 0) > 20000) { I.breathToldAt = Date.now(); event('breathe', `在水里憋不住气了（${oxy.reliable ? `氧气 ${oxy.value}/20` : '氧气读不到'}），先游上去换气`); }
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

      // ---- 先看清头顶：这一跳到底跳不跳得上去 ----------------------------------
      const plan = breathEscapePlan(bot, I, B);
      d.plan = plan.how;
      d.planWhy = plan.why;
      note({ kind: 'breathe', step: plan.how, why: plan.why, forced: d.forced || undefined, oxygen: oxy.value, raw: oxy.reliable ? undefined : oxy.raw });

      // 上一个办法试过没起色 → 记下来，下面按顺序换（up → swim → dig），不反复试同一个
      const tried = (I.__breathTried = I.__breathTried || {});
      const sinceTried = (how) => Date.now() - (tried[how] || 0) < B.stepRetryMs;
      if (sinceTried(plan.how)) d.note = `刚试过 ${plan.how}，这一拍不重复`;

      if (plan.how === 'swim' && !sinceTried('swim')) {
        // 游到那一列（同列内的上浮由下一拍的 `up` 收尾）。用 `POST /go`：它支持 abort 谓词，
        // 被打断能立刻收手，也不会像 `POST /jump` 那样只在原地动。
        tried.swim = Date.now();
        const t = plan.target;
        try {
          const rr = await deps.handlers['POST /go']({ x: t.wx, y: t.wy, z: t.wz, range: 1, maxMs: Math.min(6000, Math.max(1500, (plan.oxygenLeftMs ?? 6000))) });
          d.swim = { to: { x: t.wx, y: t.wy, z: t.wz }, arrived: !!rr?.arrived, dist: rr?.distance };
        } catch (e) { d.swimError = e.message; }
      } else if (plan.how === 'dig' && !sinceTried('dig')) {
        // 四周全封死：挖头顶挡住的方块。只挖能挖软的（沙子/砂砾/泥土/黏土/雪/草方块），
        // 而且**不挖会放岩浆/危险东西进来的** —— 判据用 `place.js` 的 `DEADLY`（只此一份）。
        tried.dig = Date.now();
        const digRes = await breathDigOut(bot, state, I, plan, deps);
        d.dig = digRes;
      }

      // ---- 照旧往上跳（无论走哪条路，最后都要出水；up 就是它本身）--------------
      let { r, aborted: bAborted } = await runJob('breathe', null, (abort) =>
        deps.handlers['POST /jump']({ durationMs: (plan.how === 'swim' ? 1500 : B.jumpMs), stopAtOxygen: 18, abort }));
      if (breatheRefused({ r, aborted: bAborted })) {
        // 被 runJob 拒了（urgent 被别人占了 / ended）。保命优先：直接跳。
        d.refused = r?.error || 'aborted';
        try {
          r = await deps.handlers['POST /jump']({ durationMs: B.jumpMs, stopAtOxygen: 18 });
          bAborted = false;
        } catch (e2) { I.last = { t: Date.now(), error: `breathe 兜底也失败: ${e2.message}` }; }
      }
      // 这一跳有没有起色？氧气回来了（或读数不可信时至少头不在水里了）就算上去了；
      // 没起色 → 记下这个办法没成，下一拍 `breathEscapePlan` 会换下手。
      const after = oxygenNum(bot.oxygenLevel ?? null);
      const stillWet = headInWater(bot);
      const improved = !stillWet || (oxy.reliable && after.reliable && after.value > oxy.value);
      d.improved = improved;
      if (!improved) tried[plan.how] = Date.now();
      note({ kind: 'breathe', step: plan.how, jumped: r?.jumped, oxygen: r?.oxygen, improved, refused: d.refused, forced: d.forced || undefined });
      I.breathedAt = Date.now();
      if (!stillWet) I.__breathTried = null;   // 上来了，清掉"这几个办法都试过"的记录
    } catch (e) { I.last = { t: Date.now(), error: `breathe: ${e.message}` }; } finally { breathing = false; if (I.urgent === 'breathe') I.urgent = null; }
  }, I.diagnostics);
  const breathTimer = setInterval(() => checkBreath(), CFG.breathe.checkMs);

  // ---- 上岸：身体空着泡在水里 → 走到最近的陆地（刚上浮换完气也算）
  let inWaterSince = 0;
  const shoreTimer = setInterval(async () => {
    const S = I.cfg.shore;
    if (!S.enabled || !bot.entity || bot.vehicle || fighting || breathing || I.urgent || I.running) return;
    const feet = bot.blockAt(bot.entity.position.floored());
    const wet = !!bot.entity.isInWater || blocksWater(feet?.name, feet?.getProperties?.());
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
        const f = bot.blockAt(p); if (!f || blocksWater(f.name, f.getProperties?.())) continue;
        const b = bot.blockAt(p.offset(0, -1, 0)); if (!b || b.boundingBox !== 'block') continue;
        const h = bot.blockAt(p.offset(0, 1, 0));
        cells.push({ pos: p, below: b.name, feet: f.name, head: h?.name, ok: require('../world/place').isStandable(f) && require('../world/place').isStandable(h) });
      }
      rings = k + 1;
      if (cells.length) pick = pickShore(cells, me);   // 这一圈里有可站的 → 就在这圈挑
    }
    if (!pick) { note({ kind: 'shore', skip: `${S.radius} 格内没找到能上的岸`, rings, scanned }); return; }
    const { r, aborted } = await runJob('shore', null, (abort) => deps.handlers['POST /go']({ x: pick.pos.x, y: pick.pos.y, z: pick.pos.z, range: 1, maxMs: 20000, abort }));
    const dry = !bot.entity.isInWater && !blocksWater(bot.blockAt(bot.entity.position.floored())?.name, bot.blockAt(bot.entity.position.floored())?.getProperties?.());
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

  // ---- 玩家挨打：**只有真的危险才**告诉 mind（主人 2026-09-29 实机：掉一点血她每次都问）
  //
  // 判据在纯函数 `playerHurtPlan()`（文件上方）里，阈值在 `CFG.playerHurt`（config.js）。
  // 这里只做三件事：维护"每个玩家最近挨打的记录"、读血量、按 plan 决定发不发。
  //
  // ⚠️ 读血量：别的玩家没有 `bot.health`，只有在实体 metadata 里（见 `victimHealth` 的注释）。
  //    读不到时 `playerHurtPlan` 会**只按挨打次数**判，绝不猜满血/危险。
  //    掉血量 = 上一次读到的血 − 这一次读到的血；两次里有一次读不到就算不出，记 0。
  const hurtSeen = new Map();   // username → { lastHealth:number|null, events:[{at,loss}] }
  bot.on('entityHurt', (victim, source) => {
    try {
      const H = I.cfg.playerHurt;
      if (!H.enabled || victim?.type !== 'player' || victim === bot.entity || !victim.username) return;
      if (source?.type === 'player') return;   // 玩家之间闹着玩不归本能管
      if (!bot.entity || victim.position.distanceTo(bot.entity.position) > H.radius) return;
      const now = Date.now();
      const rec = hurtSeen.get(victim.username) || { lastHealth: null, events: [], toldAt: 0 };
      const hp = victimHealth(bot, victim, H.maxHp);
      const hpLoss = (hp != null && rec.lastHealth != null) ? Math.max(0, rec.lastHealth - hp) : 0;
      // 只留窗口内的记录（窗口外的老账不算"短时间掉血/连着挨打"）
      rec.events = rec.events.filter(e => now - e.at <= H.windowMs);
      const plan = playerHurtPlan({ hp, hpLoss, history: rec.events }, H);
      rec.events.push({ at: now, loss: hpLoss });     // 记下这一次，供后面判"短时间累计/连打"
      rec.lastHealth = hp;
      // 冷却按**发出去的那一次**算：小伤没发，不该占掉冷却（不然真危险那一下可能被压掉）
      const quiet = now - rec.toldAt < H.quietMs;
      hurtSeen.set(victim.username, rec);
      if (!plan.tell || quiet) return;
      rec.toldAt = now;
      const dist = Math.round(victim.position.distanceTo(bot.entity.position));
      const by = source?.name ? `${source.name}` : '摔的、烧的或者看不见的东西';
      event('player_hurt', `${victim.username} 有危险：${plan.why}（${by}），离她 ${dist} 格`, { player: victim.username, by: source?.name || null, reason: plan.kind });
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

    // ④ 开宝箱 / 进建筑  ⑤ 插火把  ⑥ 收获  ⑦ 采矿  ⑧ 换护甲
    // ⑨ 洞穴探险（最后：先把看得见的矿挖了、箱子开了，再往里走）
    //
    // ★★ 2026-09-29 调整顺序（主人："野外的箱子，木桶也要作為重點，看到之后高優先級去獲取內容"）：
    //    `loot` 从第 3 位提到**最前**。
    //
    //    【为什么放在插火把之前】安全相关的**永远更前面，而且根本不在这个队列里**：
    //      憋气（`checkBreath`，氧气事件直接叫停命令）、战斗（`combatTimer`，会 cancelCommands）、
    //      危险方块退开（`hazardTimer`）—— 它们都在 tick 之前就动手了，不受这里影响。
    //      剩下的几件里，插火把是"防刷怪"的长线收益，而野外箱子是**一次性的、过期不候**
    //      （Lootr 箱子被别人开过就没了；主人也点名要高优先级）。她已经在露天走动，
    //      开完箱子再插火把完全来得及。
    //
    //    【为什么不放在收获/采矿之前也一样】收获和采矿是**可持续**的（庄稼会长、矿不会跑），
    //      晚一拍没损失；箱子晚一拍可能就没了。
    //
    //    `pickLoot` 自己的跳过条件（血 < minHp、背包没地方、夜里在露天）**一个字没改** ——
    //      所以"血低 / 夜里露天"时她照样不去开，只调整了"别的都不冲突时先做哪件"。
    for (const [k, f] of [['loot', () => tryLoot(nightOut)], ['torch', tryTorch], ['harvest', tryHarvest], ['mine', tryMine], ['delve', tryResumeDelve], ['cave', tryCave]]) {
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
    // ⑩ 回去收"之前没收回来的水"（2026-09-29 加）：上面全都没事做、身体空着 = 真闲着了。
    //    实机：家里 `17,123,6` 那摊水就是落地水倒了没收回留下的。位置**只来自** `I.pendingWater`
    //    （倒水失败那次记下的，**不写死坐标**），判据和落地收水共用 `waterRetrievePlan`。
    //    够近（20 格）且手上有空桶才去 —— 不为收一滩水跑半个地图。
    const pw = await tryCollectPendingWater();
    if (pw?.did) { I.last = { t: now, ...last, water: '去收留下的水了' }; return; }
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
  bot.once('end', () => { ended = true; bot.removeListener('entityHurt', wakeChecks); bot.removeListener('breath', wakeChecks); bot.removeListener('health', wakeChecks); bot.removeListener('entityUpdate', onUpdate); clearInterval(hazardTimer); clearInterval(timer); clearInterval(gazeTimer); clearInterval(toolTimer); clearInterval(combatTimer); clearInterval(kitTimer); clearInterval(oreWatch); clearInterval(policyTimer); clearInterval(homeTimer); clearInterval(eatTimer); clearInterval(breathTimer); clearInterval(shoreTimer); clearInterval(effectTimer); clearInterval(perceptionTimer); });
}

/**
 * 命令来了：本能让出身体。bridge 路由在执行会动身体的 POST 之前调用。
 * 打断正在做的本能，并等它收拾干净（最多 yieldWaitMs）—— 不然它的 finally 会清掉新命令刚设的寻路目标。
 *
 * 2026-09-29 问题 2（打架被 mind 的走路命令叫停，她被打死）：
 * 打架时原先只按"命令类型"放行（`COMBAT_YIELD` 里的 /go /follow /move…），
 * 于是 **mind 自己顺手发的 `/go`（goto / come_to）也能把架叫停**。现在把"走路类"再拆一层：
 *   · **玩家在聊天里明确喊她跑 / 叫她过来**（mind 转达，`args.urgent === 'player'`）→ 放行；
 *   · **mind 自己顺手走路**（`/go` `/move` `/follow` `/wear`，不带标记）→ **拒**
 *     （`在打架（战斗本能），这条是顺手发的，打完再去`）。
 * 判据在 `config.js` 的 `isPlayerUrgent`（只此一份）。**默认不放行**。
 *
 * ⚠️ 两类命令**不受**这个标记限制，照旧能打断战斗（不能被这次改动误伤）：
 *   · `/flee`（血低撤退）—— 这是**保命**，本来就不该等玩家发话；
 *   · `/stop {hold:true}`（明说"站住"）—— 玩家/调度明确要她停手，`hold` 本身就是显式信号。
 *   · `/self_rescue` 同理：那是脱困保命。
 * 其余（`/go` `/move` `/follow` `/wear` `/stop` 不带 hold）在战斗中必须有 `urgent:'player'`。
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
  // 2026-09-29：走路类（/go /move /follow /wear）还要"玩家明确要求"（urgent:'player'），
  //   否则 mind 顺手走路也会叫停打架（见函数头注释）。保命类（/flee /self_rescue）与
  //   `/stop {hold}` 不在此列 —— 那些照旧放行。
  if (r.kind === 'combat') {
    const allowedClass = COMBAT_YIELD.has(key) && (key !== 'POST /stop' || !!args?.hold);
    // 保命类 + 明确"站住"不要求玩家标记（`hold` 本身就是显式信号，见函数头注释）
    const exempt = key === 'POST /flee' || key === 'POST /self_rescue'
      || (key === 'POST /stop' && !!args?.hold);
    if (!allowedClass) return { reject: '在打架（战斗本能），打完再做' };
    if (!exempt && !isPlayerUrgent(args)) {
      return { reject: '在打架（战斗本能），这条是顺手发的，打完再去' };
    }
  }
  r.abort();
  await Promise.race([r.done.catch(() => {}), new Promise(res => setTimeout(res, CFG.yieldWaitMs))]);
}

module.exports = { bind, bodyBusy, breatheRefused, caveBoundary, createCheck, install, ownsBodyAtCleanup, playerHurtPlan, scanColumnsGen, scanColumnsIn, scanColumnsSync, settleJob, syncSleepState, victimHealth, yieldBody };

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
  // ---- 玩家受伤：只有真的危险才惊动 mind（主人 2026-09-29 实机）----
  // 测的是**跑的那份** playerHurtPlan（core.js 上方），不另抄一份实现。
  ['玩家受伤：小伤不吭声，危险才报', async (t) => {
    const { check, ns } = t;
    const { playerHurtPlan, victimHealth, CFG } = ns;
    const H = CFG.playerHurt;

    // ---- 掉 1 点血：满血边上、只挨一下 → 不报 ----
    check('★ 掉 1 点血（血 19，没连续）→ 不报', playerHurtPlan({ hp: 19, hpLoss: 1, history: [] }).tell, false);
    check('掉 1 点血的 why 明说是小伤', playerHurtPlan({ hp: 19, hpLoss: 1, history: [] }).kind, 'minor');
    check('★ 血 10 挨一下（还不算低）→ 不报', playerHurtPlan({ hp: 10, hpLoss: 1, history: [] }).tell, false);

    // ---- ① 血量低（≤ lowHp=8）→ 报 ----
    check('★ 血 8（4 颗心）→ 报', playerHurtPlan({ hp: 8, hpLoss: 1, history: [] }).tell, true);
    check('血量低的理由 = low_hp', playerHurtPlan({ hp: 8, hpLoss: 1, history: [] }).kind, 'low_hp');
    check('血 3 → 报', playerHurtPlan({ hp: 3, hpLoss: 2, history: [] }).tell, true);
    check('★ 血 9（差一点）→ 不报', playerHurtPlan({ hp: 9, hpLoss: 1, history: [] }).tell, false);

    // ---- ② 短时间累计掉血 ≥ burstHp=6 → 报（即使现在血还高）----
    check('★ 10 秒内累计掉 6 点（血还有 12）→ 报', playerHurtPlan({ hp: 12, hpLoss: 3, history: [{ at: 0, loss: 3 }] }).tell, true);
    check('累计掉血的理由 = burst', playerHurtPlan({ hp: 12, hpLoss: 3, history: [{ at: 0, loss: 3 }] }).kind, 'burst');
    check('累计掉 5 点（差一点）→ 不算 burst', playerHurtPlan({ hp: 13, hpLoss: 3, history: [{ at: 0, loss: 2 }] }).kind !== 'burst', true);

    // ---- ③ 短时间连续挨打 ≥ burstHits=3 → 报（读不到血量也能判）----
    check('★ 窗口内挨第 3 下（前两下各掉 1）→ 报', playerHurtPlan({ hp: 17, hpLoss: 1, history: [{ at: 0, loss: 1 }, { at: 1, loss: 1 }] }).tell, true);
    check('连续挨打的理由 = hits', playerHurtPlan({ hp: 17, hpLoss: 1, history: [{ at: 0, loss: 1 }, { at: 1, loss: 1 }] }).kind, 'hits');
    check('★ 只挨第 2 下 → 还不报', playerHurtPlan({ hp: 18, hpLoss: 1, history: [{ at: 0, loss: 1 }] }).tell, false);

    // ---- 读不到血量：既不当满血也不当危险，只按挨打次数 ----
    const unk1 = playerHurtPlan({ hp: null, hpLoss: 0, history: [] });
    check('★ 读不到血量、只挨一下 → 不报（不当满血，也不当危险）', unk1.tell, false);
    check('读不到血量的 why 明说"读不到"（不是"没事"）', /读不到血量/.test(unk1.why), true);
    check('读不到血量的 kind = unknown_hp', unk1.kind, 'unknown_hp');
    check('★ 读不到血量，但窗口内挨了 3 下 → 照样报（次数可靠）',
      playerHurtPlan({ hp: null, hpLoss: 0, history: [{ at: 0, loss: 0 }, { at: 1, loss: 0 }] }).tell, true);
    check('读不到血量时不会因为 hpLoss 大就报（算不出，不猜）',
      playerHurtPlan({ hp: null, hpLoss: 99, history: [] }).tell, false);

    // ---- victimHealth：从实体 metadata 按 metadataKeys 取，读不到给 null ----
    const mkBot = (keys) => ({ registry: { entitiesByName: { player: keys ? { metadataKeys: keys } : {} } } });
    const keys = ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health'];
    check('★ 从 metadata 里按 health 的槽位取值', victimHealth(mkBot(keys), { name: 'player', metadata: { 9: 13 } }), 13);
    check('★ 没有 metadataKeys 表 → null（读不到，不是满血）', victimHealth(mkBot(null), { name: 'player', metadata: { 9: 13 } }), null);
    check('★ 表里没有 health 槽位 → null', victimHealth(mkBot(['pose']), { name: 'player', metadata: { 0: 1 } }), null);
    check('★ 没有 metadata → null', victimHealth(mkBot(keys), { name: 'player' }), null);
    check('★ 取到的不是数 → null', victimHealth(mkBot(keys), { name: 'player', metadata: { 9: 'x' } }), null);
    check('★ 值 > maxHp（读成别的字段）→ null，不猜', victimHealth(mkBot(keys), { name: 'player', metadata: { 9: 300 } }), null);
    check('值为负 → null', victimHealth(mkBot(keys), { name: 'player', metadata: { 9: -1 } }), null);
    check('bot 为空也不抛', victimHealth(null, { name: 'player', metadata: { 9: 5 } }), null);

    // ---- 源码形状锁：entityHurt 真的走了 playerHurtPlan，且冷却只给小伤放行 ----
    const srcText = t.instinctSrc();
    check('★ entityHurt 用 playerHurtPlan 判严重度（不再"挨打就发"）',
      /playerHurtPlan\(\{ hp, hpLoss, history: rec\.events \}, H\)/.test(srcText), true);
    check('★ 挨打记录只留窗口内的（老账不算"短时间"）',
      /rec\.events\.filter\(e => now - e\.at <= H\.windowMs\)/.test(srcText), true);
    check('★ 小伤不占冷却：只有 plan.tell 才更新 toldAt',
      /rec\.toldAt = now/.test(srcText) && /if \(!plan\.tell \|\| quiet\) return;[\s\S]{0,80}rec\.toldAt = now/.test(srcText), true);
    check('★ 阈值在 CFG.playerHurt（不是散在代码里）', H.quietMs >= 60000 && H.lowHp === 8 && H.burstHp === 6 && H.burstHits === 3, true);
    check('★ 事件文字不再像在催她关心（写了"有危险"+理由）',
      /event\('player_hurt', `\$\{victim\.username\} 有危险：\$\{plan\.why\}/.test(srcText), true);
  }],
  ['让出身体', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, PASSIVE_POSTS, breatheRefused, followIdlePlan, ownsBodyAtCleanup, paths, pickTorchStep, scanColumnsSync, yieldBody } = ns;
    const { pickTorchAsk, torchSituation } = ns;   // 火把开关（2026-09-29）：接线用的是它们的纯函数真身
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
      // ---- 2026-09-29 问题 2：打架时"顺手发的走路"要被拒，只有玩家明确要求的才放行 ----
      return yieldBody(stC, 'POST /go');
    }).then((y) => {
      check('★ 打架时 mind 顺手 /go（无标记）→ 被拒', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /go', { x: 1, z: 2, urgent: 'player' });
    }).then((y) => {
      check('★ 打架时玩家明确叫她过去（urgent:player）→ 让', y?.reject, undefined);
      return yieldBody(stC, 'POST /follow', { playerName: 'Ka_sum1' });
    }).then((y) => {
      check('★ 打架时顺手 /follow（无标记）→ 被拒', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /follow', { playerName: 'Ka_sum1', urgent: 'player' });
    }).then((y) => {
      check('★ 玩家明确叫她跟（urgent:player）→ 让', y?.reject, undefined);
      return yieldBody(stC, 'POST /go', { urgent: true });
    }).then((y) => {
      check('★ urgent:true（不是 \'player\'）→ 不放行（默认保守）', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /go', { urgent: 'mind' });
    }).then((y) => {
      check('★ urgent 是别的字符串 → 不放行', typeof y?.reject, 'string');
      return yieldBody(st, 'POST /go');
    }).then((y) => {
      check('不在打架 → 顺手 /go 照常打断本能', y?.reject, undefined);
      return yieldBody(stC, 'POST /move');
    }).then((y) => {
      check('★ /move 同样要玩家标记（顺手的不放行）', typeof y?.reject, 'string');
      return yieldBody(stC, 'POST /flee');
    }).then((y) => {
      check('★ 血低撤退（/flee）不受标记限制、照旧能打断', y?.reject, undefined);
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

      // ---- 火把开关的接线（2026-09-29）：判据在 mining.js 的纯函数，core.js 只喂状态 + 落盘 ----
      check('★ tryTorch 把场合（atHome / delving / modes）喂给 pickTorchStep（不再只看"暗不暗"）',
        /pickTorchStep\(\{[\s\S]{0,400}?atHome: bot\.entity \? inHome\(here\) : null[\s\S]{0,200}?delving: delvingOf\(\)[\s\S]{0,200}?modes: torchModeState\(\)/.test(srcText), true);
      check('★ "正在下矿"复用 pickDelveResume 的判据（不另写一份）',
        /delvingOf[\s\S]{0,200}?pickDelveResume\(\{[\s\S]{0,200}?resumeMs: I\.cfg\.delve\.resumeMs/.test(srcText), true);
      check('★ 家里发现暗处走 torchAskPlan（该问才问），不再无条件 dark_spot',
        /const q = d\.kind === 'unreadable' \? null : torchAskPlan\(d\.count \?\? cells\.length\)/.test(srcText), true);
      check('★ 问主人时带 askPlayer:\'torch\'（放行标记，见 mind/think.js）',
        /torch_ask'[\s\S]{0,300}?askPlayer: 'torch'/.test(srcText), true);
      check('★ 问的时刻立刻落盘（markTorchAsked）——重启不忘，6 小时冷却才算得准',
        /torchAskPlan[\s\S]{0,700}?markTorchAsked\(torchModeState\(now\), now\)/.test(srcText), true);
      check('★ 开关存盘只有本进程写（loadTorchMode / markTorchAsked 都在 core.js）',
        /function torchModeState[\s\S]{0,300}?loadTorchMode\(\)/.test(srcText), true);
      // 冷却边界"刚好到点不算过"是 pickTorchAsk 的判据（这里用真身钉住，不靠读源码）
      check('★ 问过之后 6 小时内不追问（askedAt 判据在 pickTorchAsk，真身调用）',
        pickTorchAsk({ mode: 'ask', state: { home: 'ask', askedAt: 1000, answer: null }, now: 1000 + 5 * 3600 * 1000, darkCount: 1 }).ask, false);
      check('★ 过了 6 小时可以再问一次',
        pickTorchAsk({ mode: 'ask', state: { home: 'ask', askedAt: 1000, answer: null }, now: 1000 + 7 * 3600 * 1000, darkCount: 1 }).ask, true);
      check('★ 主人说过"不用"→ 24 小时内不问（quietUntil 判据）',
        pickTorchAsk({ mode: 'ask', state: { home: 'ask', answer: 'no', answeredAt: 1000, quietUntil: 1000 + 86400000 }, now: 1000 + 3600000, darkCount: 1 }).ask, false);
      check('★ home=off → 连问都不问（也不退回 dark_spot 催）',
        pickTorchAsk({ mode: 'off', state: { home: 'off' }, darkCount: 3 }).ask, false);
      check('★ 在洞里（underground）判 auto：开关关着也不问、照插',
        torchSituation({ exposure: { kind: 'underground' }, atHome: true, delving: false, modes: { home: 'off', away: 'off' } }).mode, 'auto');
      check('★ 下矿中（delving）判 auto，哪怕人已经站在家/地面上',
        torchSituation({ exposure: { kind: 'open' }, atHome: true, delving: true, modes: { home: 'ask', away: 'off' } }).where, 'mine');
      check('★ 跟随时"他站着不动才顺手做事"（followIdlePlan 在 tick 里）',
        /followIdlePlan\(\{ now, idleMs: I\.cfg\.follow\.idleMs/.test(srcText), true);
      check('★ delve 续挖在 tick 的本能循环里',
        /\['delve', tryResumeDelve\]/.test(srcText), true);

      console.log(`\n${pass} passed, ${fail} failed`);
      return fail ? 1 : 0;
    });
  }],
  // ---- 打架前翻不翻精妙背包（2026-09-29 问题 2c）----
  // 测的是**跑的那份** fightGearFetchPlan（instinct/combat.js），不另抄一份实现。
  ['打架前：怪远才翻背包找武器/盾，贴脸不翻', async (t) => {
    const { check, ns, instinctSrc } = t;
    const { fightGearFetchPlan, CFG } = ns;
    const TH = CFG.combat.fightFromBackpackDist;
    check('阈值默认是 5 格', TH, 5);
    const p8 = fightGearFetchPlan({ dist: 8, hasShield: false, hasWeapon: false });
    check('★ 怪在 8 格、身上没盾没武器 → 武器去翻', p8.fetchWeapon, true);
    check('★ 怪在 8 格 → 盾也去翻', p8.fetchShield, true);
    const p3 = fightGearFetchPlan({ dist: 3, hasShield: false, hasWeapon: false });
    check('★ 怪在 3 格（贴脸）→ 武器不翻', p3.fetchWeapon, false);
    check('★ 怪在 3 格（贴脸）→ 盾也不翻', p3.fetchShield, false);
    check('正好 5 格（=阈值）→ 翻', fightGearFetchPlan({ dist: 5, hasShield: false, hasWeapon: false }).fetchWeapon, true);
    check('差一点点 4.9 格 → 不翻', fightGearFetchPlan({ dist: 4.9, hasShield: false, hasWeapon: false }).fetchWeapon, false);
    check('★ 距离读不到 → 武器不翻', fightGearFetchPlan({ dist: null, hasWeapon: false }).fetchWeapon, false);
    check('★ 距离读不到 → 盾不翻（保守，不乱开背包）', fightGearFetchPlan({ dist: null, hasShield: false }).fetchShield, false);
    check('说明是"距离读不到"', /距离读不到/.test(fightGearFetchPlan({ dist: null }).reason), true);
    check('★ 身上已经有更好的武器 → 不用去背包翻武器', fightGearFetchPlan({ dist: 9, hasWeapon: true, hasShield: false }).fetchWeapon, false);
    check('★ 已经有盾 → 不用去翻盾', fightGearFetchPlan({ dist: 9, hasWeapon: false, hasShield: true }).fetchShield, false);
    // 源码形状锁：equipForFight 真的用了这个判据（不是只在旁边写着）
    check('★ equipForFight 用 fightGearFetchPlan 决定去不去背包', /const plan = fightGearFetchPlan\(\{ dist, hasShield: hasShieldNow/.test(instinctSrc()), true);
    check('★ 贴脸时不碰背包（去背包拿都必须过 plan.fetch*）', /plan\.fetchShield && state && deps\.hands\.ensureCarried/.test(instinctSrc()), true);
  }],
  // ---- 落地水：收不回来要说清"在哪、为什么"（2026-09-29 实机）----
  // 测的是**跑的那份**：`collectWater` 失败分支的事件文本 + `tryCollectPendingWater` 的入队规则。
  // 不另抄实现 —— 断言打在源码形状和 `waterRetrievePlan`（survival.js，另一节单测）上。
  ['落地水：没收回来必须说清在哪、为什么', async (t) => {
    const { check, ns, instinctSrc } = t;
    const { waterRetrievePlan, mlgShouldPlace, CFG } = ns;
    const src = instinctSrc();

    // ---- 事件文本：坐标 + 原因（"说不清原因就等于没说"）----
    check('★ 失败事件带坐标（在哪）', /倒了水，但\*\*没收回\*\*（在 \$\{tgt\.x\},\$\{tgt\.y\},\$\{tgt\.z\}，因为\$\{reason\}/.test(src), true);
    check('★ 失败事件带原因（为什么）', /因为\$\{reason\}）—— 记下来了，闲下来回去收/.test(src), true);
    check('★ 失败时写进 ledger（route=mlg, retrieved=false）', /state\.ledger\?\.note\(\{ route: 'mlg', retrieved: false, why: reason/.test(src), true);
    check('★ 出错分支也说清坐标 + 异常信息', /收回时出错了（在 \$\{tgt\.x\},\$\{tgt\.y\},\$\{tgt\.z\}）：\$\{e\.message\}/.test(src), true);

    // ---- 收水流程：先"走过去"再"对准"（旧代码漏了走这一步 → 射线够不到水面）----
    check('★ 收水走 waterRetrievePlan（判据只此一处）', /const plan = waterRetrievePlan\(\{/.test(src), true);
    check('★ 收水有"走过去"这一步（旧代码没有 → 站在水上面/旁边够不到）', /plan\.act === 'walk'[\s\S]{0,200}POST \/go/.test(src), true);
    check('★ 对准用 offset\(0\.5, 0\.8, 0\.5\)（照 fillBucket 现成判据）', /lookAt\(src\.position\.offset\(0\.5, 0\.8, 0\.5\), true\)/.test(src), true);
    check('★ 失败重试次数来自 CFG（retrieveRetries）', /attempts: tries/.test(src) && Number.isFinite(CFG.mlg.retrieveRetries), true);

    // ---- 待收清单：不写死坐标，位置只来自 pendingWater ----
    // ⚠️ 断言的 regex 不能把**自己这行**也匹配上（源码形状锁的常见坑）：坐标字符串在这里拼出来。
    // 只看"代码行"（去注释）—— 注释里提到实机那摊水是**说明**，不是写死。
    const codeOnly = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const HARDCODED = new RegExp(['17', '123', '6'].join(',\\s*'));
    check('★ 没有把实机那摊水的坐标写死进代码（注释里提到不算）', HARDCODED.test(codeOnly), false);
    check('★ 待收点只来自 I.pendingWater', /I\.pendingWater\.push\(\{ x: tgt\.x, y: tgt\.y, z: tgt\.z, at: Date\.now\(\), why: reason \}\)/.test(src), true);
    check('★ 待收点有上限（pendingMax）', /I\.pendingWater\.length < \(I\.cfg\.mlg\.pendingMax \?\? 8\)/.test(src), true);
    check('★ 闲时才回去收（身体空着 / 没命令 / 不在打架）', /async function tryCollectPendingWater[\s\S]{0,200}I\.running \|\| state\.currentAction \|\| I\.inflight > 0/.test(src), true);
    check('★ 只有够近（≤20 格）才去收，不为收一滩水跑半个地图', /Math\.hypot\(p\.x - here\.x, p\.z - here\.z\) <= 20/.test(src), true);
    check('★ 真闲着时才会走到这一步（tick 的 ⑩）', /tryCollectPendingWater\(\)[\s\S]{0,60}I\.last = \{ t: now, \.\.\.last, water:/.test(src), true);

    // ---- 收不到水源方块 → 如实说"找不到水源方块"，不假装成功 ----
    check('★ 找不到水源 → 明确原因（不是静默）', /if \(!src\) \{ reason = '找不到水源方块'; break; \}/.test(src), true);
    check('★ 没空桶 → 明确原因', /if \(!bucket\) \{ reason = '身上没有空桶'; break; \}/.test(src), true);

    // ---- 与判据的一致性：倒的条件里"家里"是致命才倒（配合 mlgShouldPlace 一节）----
    check('★ physicsTick 把 hp/inHome/landSafe/effects 喂给 mlgStep',
      /hp: bot\.health \?\? 20, inHome: inHome\(e\.position\)[\s\S]{0,120}landName, landSafe: landSafeTag\(landName\), effects: mlgEffects\(\)/.test(src), true);
    check('★ 落安全方块（落点带 fall_damage_resetting 标签）不倒水',
      mlgShouldPlace({ hp: 20, startY: 90, landY: 70, landSafe: true, landName: 'water' }, CFG.mlg).place, false);
  }],
  // ---- 感知：少扫、只说用得上的、别每轮写盘（2026-09-29 实机修）----
  // 测的是**跑的那份**：`perceptionTimer` 里真的调了 perception 的判据（源码形状锁），
  // 加上判据本身的边界（worthTelling / shouldRescan / shouldSave 都在 perception.js 单测过，这里测接线）。
  ['感知：少扫 / 只说用得上的 / 别每轮写盘', async (t) => {
    const { check, ns, instinctSrc } = t;
    const src = instinctSrc();
    // ⚠️ 这几个判据住在 `src/world/perception.js`（不在本能层 56 个名字的总表里），
    //    所以直接 require 那一份**跑的那份** —— 绝不是把实现再抄一遍。
    const P = require('../world/perception');
    const { shouldRescan, worthTelling, shouldSave } = P;
    // CFG 从本能层取（`t.cfg` 在 core.js 单跑时可能没绑上 —— 直接要 config.js 那份更稳）
    const cfg = ns.CFG || require('./config.js').CFG;
    // 只看"代码行"（去掉行注释 / 块注释行）—— 源码形状锁别把说明文字也算进去
    const codeOnly = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // ---- 接线：perceptionTimer 用 shouldRescan 决定扫不扫（不再"到点就扫"）----
    check('★ 用 shouldRescan 决定扫不扫', /const _rs = perception\.shouldRescan\(\{/.test(src), true);
    check('★ 没动 + 距上次不到 minRescanMs → 不扫', /if \(!_rs\.scan\)/.test(src), true);
    check('★ 走路/打架/开界面 → 算"忙"（放慢）', /I\.inflight > 0 \|\| state\.pathing \|\| state\.gui \|\| I\.combat\?\.engaged/.test(src), true);
    check('★ 记下上次扫描中心（算移动距离用）', /I\.lastPerceptionPos = \{ x: _pp\.x, z: _pp\.z \}/.test(src), true);

    // ---- 接线：事件过 worthTelling（花/砂砾/树不发）----
    check('★ 事件前过 worthTelling', /const w = perception\.worthTelling\(it, \{ needs \}\)/.test(src), true);
    check('★ worthTelling 说不发就不发', /if \(!w\.tell\) continue;/.test(src), true);
    // ---- 接线：区域冷却 + 全局每分钟帽 ----
    check('★ 冷却键是"类别 + 区域网格"（不是精确中心）', /const key = `res:\$\{it\.kind\}:\$\{gx\},\$\{gz\}`/.test(src), true);
    check('★ 全局每分钟上限', /\(I\.resourceToldCount \|\| 0\) >= \(PC\.tellPerMinute \?\? 4\)/.test(src), true);
    check('★ 每分钟归零（按分钟桶）', /if \(I\.resourceToldMinute !== _minute\)/.test(src), true);

    // ---- 接线：「缺这个」说出具体是什么 ----
    check('★ "缺这个"带上具体名字（w.label）', /（你现在正缺\$\{w\.label \|\| it\.name \|\| ''\}）/.test(src), true);
    // 同样：注释里引述旧写法是说明；只在代码行里判。判据的 regex 拼出来，免得匹配到自己这行。
    const generic = new RegExp(['你现在正缺', '这个'].join(''));
    check('★ 代码里不再写死那句泛泛的"缺这个"（注释里引述不算）', generic.test(codeOnly), false);
    // ---- 接线：direction 兜底（merge 已补，这里再兜一次，绝不出现 undefined）----
    check('★ direction 有兜底（undefined 不会进事件文本）', /const dir = it\.direction \|\| '附近'/.test(src), true);
    check('★ 事件里用的是 dir，不是裸 it.direction', /（\$\{dir\} \$\{dist\} 格/.test(src), true);

    // ---- 接线：写盘用 saveAsync + shouldSave（不是每轮写）----
    check('★ 写盘用 shouldSave 判"要不要写"', /const _sv = perception\.shouldSave\(\{/.test(src), true);
    check('★ 写盘用异步 saveAsync（不是同步 save）', /await perception\.saveAsync\(f\.store\)/.test(src), true);
    check('★ 写成功后记下时刻与签名', /I\.lastPerceptionSaveAt = Date\.now\(\); I\.lastPerceptionSaveSig = _sig;/.test(src), true);
    check('★ perception.save( 同步写不再出现在扫描里', /perception\.save\(f\.store\)/.test(src), false);

    // ---- 接线：slow 要说清哪一段 ----
    check('★ slow 报最慢的那一段（r.perf.phases）', /slow\(`perception\.\$\{_worst\}`/.test(src), true);
    check('★ 诊断里有 slowest / slowestMs', /slowest: _worst, slowestMs: _worst \? _ph\[_worst\] : null/.test(src), true);

    // ---- 接线：扫的分段参数来自 CFG ----
    check('★ 建 ID 名单与聚片的分段都来自 CFG', /idBuildBatch: PC\.idBuildBatch, clusterSliceMs: PC\.clusterSliceMs/.test(src), true);

    // ---- 判据边界（跑的那份，不另抄）----
    check('★ 花 → worthTelling 不发', worthTelling({ kind: 'flower', name: 'dandelion' }, { needs: ['黏土'] }).tell, false);
    check('★ 砂砾 → 不发', worthTelling({ kind: 'gravel', name: 'gravel' }, { needs: [] }).tell, false);
    check('★ 钻石矿（value=high）→ 发', worthTelling({ kind: 'ore', name: 'diamond_ore', value: 'high' }, { needs: [] }).why, 'valuable');
    check('★ 缺铁（合成缺粗铁）时铁矿 → 发，并说清"铁矿石"',
      worthTelling({ kind: 'ore', name: 'iron_ore', value: 'low' }, { needs: P.needsFrom({ craftMissing: ['raw_iron'] }) }).label, '铁矿石');
    check('★ 缺"矿"（只写"挖点矿"）时铁矿 → 不发（不是所有矿都缺）',
      worthTelling({ kind: 'ore', name: 'iron_ore', value: 'low' }, { needs: P.needsFrom({ planStep: '挖点矿' }) }).tell, false);
    check('★ 缺"铁矿"（写了具体）时铁矿 → 发，说清"铁矿石"',
      worthTelling({ kind: 'ore', name: 'iron_ore', value: 'low' }, { needs: P.needsFrom({ planStep: '去挖点铁矿' }) }).label, '铁矿石');
    check('★ 缺黏土时黏土 → 发，说清"黏土"',
      worthTelling({ kind: 'clay', name: 'clay' }, { needs: P.needsFrom({ planStep: '挖点黏土' }) }).label, '黏土');
    check('★ 缺树时石头 → 不发（只发真正缺的那类）',
      worthTelling({ kind: 'stone', name: 'stone' }, { needs: P.needsFrom({ planStep: '砍点树' }) }).tell, false);
    check('★ 没开过的野外箱子 → 发', worthTelling({ kind: 'container', name: 'chest', opened: false }, { needs: [] }).why, 'container');
    check('★ 开过的箱子 → 不发', worthTelling({ kind: 'container', name: 'chest', opened: true }, { needs: [] }).tell, false);

    check('★ 原地没动 + 刚扫过 → 不重扫', shouldRescan({ sinceMs: 5000, moveDist: 2, busy: false, occupied: false }, cfg.perception).scan, false);
    check('★ 动过 10 格 → 重扫', shouldRescan({ sinceMs: 5000, moveDist: 10, busy: false, occupied: false }, cfg.perception).scan, true);
    check('★ 没动但过了 60 秒 → 重扫', shouldRescan({ sinceMs: 61000, moveDist: 2, busy: false, occupied: false }, cfg.perception).scan, true);
    check('★ 上一轮没跑完 → 不叠', shouldRescan({ sinceMs: 99000, moveDist: 30, busy: true }, cfg.perception).scan, false);
    check('★ 忙着（走路）时间隔变长', shouldRescan({ sinceMs: 6000, moveDist: 10, occupied: true }, cfg.perception).scan, false);

    check('★ 没变化 → 不写盘', shouldSave({ changed: false, sinceSaveMs: 99999 }, cfg.perception).write, false);
    check('★ 有变化但刚写过 → 攒着', shouldSave({ changed: true, sinceSaveMs: 1000 }, cfg.perception).write, false);
    check('★ 有变化且过了间隔 → 写', shouldSave({ changed: true, sinceSaveMs: 40000 }, cfg.perception).write, true);
  }],
];
register('core', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('core', __sections);
}
