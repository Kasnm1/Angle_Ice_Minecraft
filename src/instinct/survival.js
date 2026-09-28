'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「survival」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const __ns = {};
let CFG;   // 跨文件常量：load 完成后由 bind() 回填
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; }

/**
 * 该不该吃。主人 2026-09-27：饥饿条掉 2 格（饥饿值 ≤16）就吃。
 * 身体被命令占着时不抢（换到手上的东西会打断挖掘、放置），除非饿到 urgentAt 以下（再不吃就不回血、跑不动）。
 * @returns null（不饿）| { eat: true, urgent } | { skip }
 */
function pickEat ({ food = null, busy = null, fighting = false, windowOpen = false, eating = false, hasFood = true, now = Date.now(), failUntil = 0 } = {}, cfg = CFG.eat) {
  if (food == null) return { skip: '读不到饥饿值' };
  if (food > cfg.at) return null;
  if (eating) return { skip: '正在吃' };
  if (fighting) return { skip: '在打架' };
  if (windowOpen) return { skip: '开着界面' };
  if (!hasFood) return { skip: '身上没有吃的' };
  if (now < failUntil) return { skip: '刚才没吃成，等一会儿再试' };
  const urgent = food <= cfg.urgentAt;
  if (busy && !urgent) return { skip: `在忙（${busy}），还不太饿，忙完再吃` };
  return { eat: true, urgent };
}

function needBreath ({ oxygen = null, headInWater = false, waterBreathing = false } = {}, cfg = CFG.breathe) {
  if (oxygen == null || !Number.isFinite(oxygen)) return false;
  if (!headInWater || waterBreathing) return false;
  return oxygen <= cfg.at;
}

/**
 * 中毒 / 凋零怎么办。effects：身上的效果名（minecraft-data 的写法：'Poison' 'Wither'）；null = 读不到 → 不猜。
 * @returns null | { bad:[...], milk:boolean, hpCost }
 */
function effectPlan ({ effects = null, hp = 20, hasMilk = false } = {}, cfg = CFG.effects) {
  if (!Array.isArray(effects)) return null;
  const bad = ['Poison', 'Wither'].filter(n => effects.includes(n));
  if (!bad.length) return null;
  const wither = bad.includes('Wither');
  const hpCost = (bad.includes('Poison') ? cfg.poisonHpCost : 0) + (wither ? cfg.witherHpCost : 0);
  return { bad, milk: hasMilk && (wither || hp <= cfg.milkHp), hpCost };
}

/**
 * 第 k 圈（水平切比雪夫距离 = k）的所有偏移，每个 (dx,dz) 配 dyMin..dyMax 的竖直偏移。
 * k=0 是她脚下那一列。由近到远一圈一圈找 —— 找到第一圈有能站的岸就不再往外看
 * （以前 25×25×6 ≈ 3750 格一次扫完，1 秒一拍，白扫大半）。
 *
 * 纯函数，便于自测。返回：[{ dx, dy, dz }]，顺序：按圈内水平距离近的优先。
 */
function shoreRingOffsets (k, dyMin = -2, dyMax = 3) {
  const out = [];
  if (k < 0) return out;
  const hs = [];
  for (let dx = -k; dx <= k; dx++) for (let dz = -k; dz <= k; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== k) continue;   // 只要这一圈
    hs.push({ dx, dz, h: Math.abs(dx) + Math.abs(dz) });
  }
  hs.sort((a, b) => a.h - b.h);   // 圈内斜角最后（先看正前/正侧）
  for (const { dx, dz } of hs) for (let dy = dyMin; dy <= dyMax; dy++) out.push({ dx, dy, dz });
  return out;
}

/**
 * 上岸去哪。cells：候选的陆地格 [{ pos, below, feet, head }]（方块名；feet/head 已经按 isStandable 判过能站 → ok 字段）。
 * 要求：脚下实心且不是水/岩浆/会伤人的，脚和头能站、不是水；挑水平最近的，高差小的优先（爬不上去的岸没用）。
 */
function pickShore (cells = [], self) {
  const ok = cells.filter(c => c.ok && c.below && !/water|lava|magma|fire|cactus|powder_snow|campfire|air$/.test(c.below)
    && !/water|bubble_column/.test(c.feet || '') && !/water|bubble_column/.test(c.head || ''));
  if (!ok.length || !self) return null;
  const cost = (c) => Math.hypot(c.pos.x + 0.5 - self.x, c.pos.z + 0.5 - self.z) + Math.max(0, c.pos.y - self.y) * 2;
  return ok.sort((a, b) => cost(a) - cost(b))[0];
}

/**
 * 落地水：这一拍该做什么。
 * @param c.startY 这次离地后到过的最高点；c.y 现在的脚底高度；c.vy 竖直速度（格/tick，往下是负）
 * @param c.landY  下面第一块实心方块的顶面高度（null = 下面 40 格内没有 / 读不到）；c.landIsWater 落点本来就是水
 * @param c.hasBucket / c.holding（手上是不是水桶）/ c.nether / c.placed（这次已经倒过了）
 * @returns 'equip' | 'place' | null
 */
function mlgStep (c, cfg = CFG.mlg) {
  const { startY, y, vy, landY, landIsWater = false, hasBucket, holding, nether = false, placed = false } = c;
  if (placed || !hasBucket || nether || landY == null || landIsWater || vy > -0.3) return null;
  if (startY - landY <= cfg.minFall) return null;   // 摔不伤
  if (!holding) return 'equip';
  if (y - landY <= cfg.placeAt) return 'place';
  return null;
}

/**
 * 死了之后怎么把东西拿回来。
 * @returns { how: 'back' | 'walk' } | { skip }
 */
function pickRecovery (c, cfg = CFG.cmd) {
  const { death, here, dim, hasBack = false, hasTp = false, sinceMs = 0 } = c;
  if (!death) return { skip: '没死过' };
  if (death.lava) return { skip: '死在岩浆里，东西烧没了' };
  if (sinceMs > cfg.despawnMs - 20000) return { skip: '掉的东西快消失了（或者已经没了）' };
  if (hasBack) return { how: 'back' };
  if (death.dim !== dim) return { skip: `死在${death.dim}，现在在${dim}，走不回去` };
  if (hasTp) return { how: 'tp' };
  const d = here ? Math.hypot(death.pos.x - here.x, death.pos.z - here.z) : Infinity;
  if (d > cfg.recoverMax) return { skip: `死的地方离这里 ${Math.round(d)} 格，太远了` };
  return { how: 'walk', dist: Math.round(d) };
}

module.exports = { bind, effectPlan, mlgStep, needBreath, pickEat, pickRecovery, pickShore, shoreRingOffsets };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/survival.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['吃 / 憋气 / 中毒 / 天气', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { darkReport, effectPlan, needBreath, pickEat, pickShore, pickupFailIds, shoreRingOffsets, syncSleepState, weatherChange } = ns;
    // ---- 吃 / 憋气 / 中毒 / 天气
    const me = { x: 0.5, y: 64, z: 0.5 };
    { const E = require('events');
      const mk = (t, extra = {}) => Object.assign(new E(), { isSleeping: true, time: { timeOfDay: t }, entity: { metadata: {}, position: { distanceTo: () => 0 } }, registry: { entitiesByName: { player: { metadataKeys: ['pose'] } } } }, extra);
      check('★ 睡眠：读不到姿态、天亮了 → 不再当成在睡', syncSleepState(mk(2000), null).sleeping, false);
      check('睡眠：读不到姿态、夜里、刚躺下 → 还在睡', syncSleepState(mk(15000), null, { sleptAt: 1000, now: 5000 }).sleeping, true);
      check('★ 睡眠：夜里"睡着"超过 8 分钟 → 醒', syncSleepState(mk(15000), null, { sleptAt: 1, now: 600000 }).sleeping, false);
      check('睡眠：打雷的白天能睡 → 不强醒', syncSleepState(mk(2000, { isRaining: true, thunderState: 1 }), null, { sleptAt: 1000, now: 5000 }).sleeping, true); }
    check('★ 拾取被打断 → 一个都不记失败', pickupFailIds({ ids: [1, 2], aborted: true }).length, 0);
    check('★ 预算用完没轮到的 → 不记', pickupFailIds({ ids: [1, 2, 3], r: { tried: [1], stopped: 'budget' } }).join(), '1');
    check('试过、还在地上 → 记', pickupFailIds({ ids: [1, 2], r: { tried: [1, 2] }, exists: (i) => i === 2 }).join(), '2');
    // ⚠️ 2026-09-28 审计（codex fix0 #3）：`r.tried` 缺失的三种情形要分开 ——
    //    旧版 bridge（调用方显式声明 legacyOk）才按全部算；异常/不完整响应一条都不记。
    check('★ handler 异常（{error}）→ 一条都不记（不误伤拉黑）', pickupFailIds({ ids: [1, 2], r: { error: 'boom' } }).length, 0);
    check('★ 响应是 null（连不上）→ 一条都不记', pickupFailIds({ ids: [1, 2], r: null }).length, 0);
    check('★ 新 bridge 正常返回但缺 tried → 也一条都不记（说不清就保守）', pickupFailIds({ ids: [1, 2], r: { found: 2, walkedTo: 0, picked: 0 } }).length, 0);
    check('旧版 bridge（显式 legacyOk）没有 tried → 才按全部', pickupFailIds({ ids: [1, 2], r: { found: 2, walkedTo: 1 }, legacyOk: true }).length, 2);
    check('★ 饥饿 16（掉了 2 格）、身体空着 → 吃', pickEat({ food: 16 })?.eat, true);
    check('饥饿 17 → 不饿', pickEat({ food: 17 }), null);
    check('饥饿 12、在忙 → 等忙完', typeof pickEat({ food: 12, busy: '在挖矿' })?.skip, 'string');
    check('★ 饥饿 5、在忙 → 也吃（急）', pickEat({ food: 5, busy: '在挖矿' })?.urgent, true);
    check('在打架不吃', typeof pickEat({ food: 3, fighting: true })?.skip, 'string');
    check('身上没吃的 → 如实说', pickEat({ food: 10, hasFood: false })?.skip, '身上没有吃的');
    check('读不到饥饿值 → 不猜', pickEat({ food: null })?.skip, '读不到饥饿值');
    check('★ 头在水里、氧气 6 → 上浮', needBreath({ oxygen: 6, headInWater: true }), true);
    check('氧气 6 但头在水外 → 不用', needBreath({ oxygen: 6, headInWater: false }), false);
    check('有水下呼吸 → 不用', needBreath({ oxygen: 2, headInWater: true, waterBreathing: true }), false);
    check('读不到氧气 → 不猜', needBreath({ oxygen: null, headInWater: true }), false);
    check('★ 凋零 + 有牛奶 → 喝', effectPlan({ effects: ['Wither'], hp: 18, hasMilk: true })?.milk, true);
    check('中毒、血还多 → 不喝（毒不致死）', effectPlan({ effects: ['Poison'], hp: 18, hasMilk: true })?.milk, false);
    check('中毒、血 8 → 喝', effectPlan({ effects: ['Poison'], hp: 8, hasMilk: true })?.milk, true);
    check('中毒打架按少 4 滴血算', effectPlan({ effects: ['Poison'], hp: 20 })?.hpCost, 4);
    check('没中毒 → 无事', effectPlan({ effects: ['Speed'] }), null);
    check('读不到效果 → 不猜', effectPlan({ effects: null }), null);
    { const L = (x, z, y = 64, extra = {}) => ({ pos: { x, y, z }, below: 'grass_block', feet: 'air', head: 'air', ok: true, ...extra });
      const me = { x: 0, y: 63, z: 0 };
      check('★ 上岸：挑最近的岸', pickShore([L(6, 0), L(3, 0), L(0, 9)], me)?.pos.x, 3);
      check('上岸：脚下是水的不算', pickShore([L(2, 0, 64, { below: 'water' })], me), null);
      check('上岸：高 3 格的崖比远 2 格的平岸差', pickShore([L(2, 0, 66), L(4, 0, 64)], me)?.pos.x, 4);
      check('上岸：站不进去的不算', pickShore([L(2, 0, 64, { ok: false })], me), null);
      check('上岸：旁边没有岸 → null', pickShore([], me), null); }
    // 上岸分圈扫：第 k 圈只含水平切比雪夫距离 = k 的格子，逐圈由近到远
    { const r0 = shoreRingOffsets(0), r1 = shoreRingOffsets(1), r2 = shoreRingOffsets(2);
      check('★ 第 0 圈只有中心一列（1 个水平位 ×6 个高度）', r0.length, 6);
      check('第 1 圈水平位 8 个（3×3 去掉中心）→ ×6', r1.length, 8 * 6);
      check('第 2 圈水平位 16 个（5×5 去掉 3×3）→ ×6', r2.length, 16 * 6);
      check('★ 第 1 圈的每个水平偏移切比雪夫距离都是 1',
        r1.every(o => Math.max(Math.abs(o.dx), Math.abs(o.dz)) === 1), true);
      check('★ 第 2 圈的每个水平偏移切比雪夫距离都是 2',
        r2.every(o => Math.max(Math.abs(o.dx), Math.abs(o.dz)) === 2), true);
      check('★ 第 0 圈就是脚下（dx=0,dz=0）', r0.every(o => o.dx === 0 && o.dz === 0), true);
      check('高度下限 -2 覆盖到', Math.min(...r1.map(o => o.dy)), -2);
      check('高度上限 3 覆盖到', Math.max(...r1.map(o => o.dy)), 3);
      check('k<0 → 空', shoreRingOffsets(-1).length, 0); }
    check('开始下雨', weatherChange({ rain: false, thunder: false }, { rain: true, thunder: false })?.kind, 'rain');
    check('★ 打雷', weatherChange({ rain: true, thunder: false }, { rain: true, thunder: true })?.kind, 'thunder');
    check('雨停', weatherChange({ rain: true, thunder: true }, { rain: false, thunder: false })?.kind, 'clear');
    check('没变 → 不说', weatherChange({ rain: true, thunder: false }, { rain: true, thunder: false }), null);
    check('★ 暗处：光源读得到、3 格全黑 → 报', darkReport({ sourceLights: [14], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }, { pos: 3, light: 0 }, { pos: 4, light: 9 }] }).count, 3);
    check('★ 暗处：有光源却都读成 0 → 读不到，不报暗', darkReport({ sourceLights: [0, undefined], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }, { pos: 3, light: 0 }] }).kind, 'unreadable');
    check('暗处：只有 2 格黑 → 不吵', darkReport({ sourceLights: [14], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }] }), null);
    check('暗处：家里一个光源都没有 → 报没有光源', darkReport({ sourceLights: [], cells: [{ pos: 1 }, { pos: 2 }, { pos: 3 }] }).kind, 'no_source');
  }],
  ['落地水', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { mlgStep } = ns;
    // ---- 落地水 ----
    const F = (o) => mlgStep({ startY: 90, y: 75, vy: -1.2, landY: 70, hasBucket: true, holding: true, ...o });
    check('还在半空（离地 5 格）→ 先不倒', F({}), null);
    check('★ 离地 3 格以内 → 倒水', F({ y: 72.5 }), 'place');
    check('★ 会摔伤、手上还没拿水桶 → 先换上', F({ holding: false }), 'equip');
    check('落差 3 格（摔不伤）→ 不管', F({ startY: 73, y: 72, landY: 70 }), null);
    check('★ 下界 → 不倒（水会蒸发）', F({ y: 72.5, nether: true }), null);
    check('落点本来就是水 → 不用倒', F({ y: 72.5, landIsWater: true }), null);
    check('没有水桶 → 什么都做不了', F({ y: 72.5, hasBucket: false }), null);
    check('这次已经倒过 → 不再倒', F({ y: 72.5, placed: true }), null);
    check('只是跳一下（速度小）→ 不管', F({ y: 72.5, vy: -0.1 }), null);
  }],
];
register('survival', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('survival', __sections);
}
