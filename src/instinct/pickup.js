'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「pickup」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { storagePolicy } = require('../body/storage-policy');
const paths = require('../paths');
const __ns = {};
let CFG;   // 跨文件常量：load 完成后由 bind() 回填
function pickaxeTier (...a) { return __ns.pickaxeTier.apply(null, a); }
function bareNameOf (...a) { return __ns.bareNameOf.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; }

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 物品刷出时是不是从某个玩家手里扔出来的。
 * 原版 `Player.drop()`：生成点 = 眼睛高度 - 0.3（站立时脚底 +1.32，潜行 +1.27-0.3），水平就在玩家身上。
 * 挖方块掉的在方块中心 ±0.25（离玩家至少 ~0.75），怪死掉的在怪脚下 —— 都不会落在这个小圈里。
 */
function whoThrew (spawnPos, players, radius = CFG.pickup.thrownRadius) {
  if (!spawnPos) return null;
  for (const { name, pos: p } of players) {
    if (!p) continue;
    const dy = spawnPos.y - (p.y + 1.32);
    if (hdist(spawnPos, p) <= radius && dy >= -0.5 && dy <= 0.3) return name;
  }
  return null;
}

/**
 * 捡不捡、捡哪几堆。
 *
 * @param ctx.self       { x, y, z }   她的脚底
 * @param ctx.drops      [{ id, pos, ageMs, thrower, item, visible }]  thrower = 谁扔的（'self' = 她自己，玩家名，null = 不是扔的）；item = 物品名或 null（读不到）；visible = 看得见吗（远处拾取用）
 * @param ctx.following  { pos } | null   正在跟的玩家
 * @param ctx.fails      Map id → { n, until }
 * @param ctx.canHold    (itemName|null) → boolean
 * @param ctx.now
 * @param cfg.far        true 才走"远处拾取"模式：只挑 farRadius 以内**看得见**的（任务书第 4 条）。
 *                       默认 false = 老行为（只用 radius，8 格内）。远处拾取是**显式**的另一件事，
 *                       不能因为 cfg 里多了个数字就把普通拾取的半径悄悄放大。
 * @returns { ids: number[] } | { skip: string }   skip 写明为什么不捡（调试用，/instinct 看得到）
 */
function pickPickup (ctx, cfg = CFG.pickup) {
  const { self, drops = [], following = null, fails = new Map(), canHold = () => true, now = Date.now() } = ctx;
  if (!self) return { skip: '没有位置' };
  const radius = following ? cfg.followRadius : cfg.radius;
  // 远处拾取模式：任务是"闲着时去捡看得见的"，所以只认 visible !== false 的；半径放宽到 farRadius。
  const far = !!cfg.far && !following && cfg.farRadius > radius;
  const reach = far ? cfg.farRadius : radius;
  const why = { young: 0, mine: 0, far: 0, full: 0, failed: 0, hidden: 0 };
  const ok = [];
  for (const d of drops) {
    if (!d?.pos) continue;
    if (d.thrower === 'self') { why.mine++; continue; }
    if (d.ageMs < (d.thrower ? cfg.thrownSettleMs : cfg.settleMs)) { why.young++; continue; }
    const dist = hdist(d.pos, self);
    if (dist > reach || Math.abs(d.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (far && d.visible === false) { why.hidden++; continue; }   // 远处：看不见的不去（不往黑处/墙后跑）
    if (following && hdist(d.pos, following.pos) > cfg.followLeash) { why.far++; continue; }
    const f = fails.get(d.id);
    if (f && f.n >= cfg.maxFails && now < f.until) { why.failed++; continue; }
    if (!canHold(d.item)) { why.full++; continue; }
    ok.push({ id: d.id, dist });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    const tag = far ? `far=${reach} ` : '';
    return { skip: parts.length ? `有掉落物但都不捡（${tag}${parts.join(' ')}）` : '附近没有掉落物' };
  }
  ok.sort((a, b) => a.dist - b.dist);
  return { ids: ok.slice(0, cfg.batch).map(o => o.id) };
}

/**
 * 收哪些庄稼。
 * @param ctx.crops [{ name, pos, age, maxAge, harvest, farmland, visible }]
 * @param ctx.inHome (pos) → boolean | null（null = 不知道家在哪）
 * @returns { only: [pos] } | { skip }
 */
function pickHarvest (ctx, cfg = CFG.harvest) {
  const { crops = [], self, inHome = () => null } = ctx;
  if (!self) return { skip: '没有位置' };
  const why = { far: 0, green: 0, useType: 0, notOurs: 0, hidden: 0 };
  const ok = [];
  for (const c of crops) {
    if (!c?.pos) continue;
    if (hdist(c.pos, self) > cfg.radius || Math.abs(c.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!(c.age >= c.maxAge)) { why.green++; continue; }
    if (c.harvest === 'use') { why.useType++; continue; }
    if (c.farmland && inHome(c.pos) !== true) { why.notOurs++; continue; }   // 耕地上的是有人种的：只收家里的
    if (c.visible === false) { why.hidden++; continue; }
    ok.push(c);
  }
  if (ok.length < cfg.minMature) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: ok.length ? `成熟的只有 ${ok.length} 棵，攒一攒再收` : (parts.length ? `有庄稼但不收（${parts.join(' ')}）` : '附近没有庄稼') };
  }
  return { only: ok.map(c => c.pos) };
}

function pickLoot (c, cfg = CFG.loot) {
  const { chests = 0, structures = [], hp = 20, free = 36, packFree = null, nightOut = false, visited = new Set(), self } = c;
  if (hp < cfg.minHp) return { skip: `血 ${hp}，先不闯` };
  if (free < cfg.minFree && !(packFree != null && packFree >= 4)) return { skip: '身上和背包都没地方装了' };
  if (nightOut) return { skip: '夜里在露天，不去闯' };
  if (chests > 0) return { mode: 'open' };
  const todo = structures.filter(s => !visited.has(s.key) && !s.danger)   // 有 boss 的不自己闯（tryLoot 告诉 mind）
    .map(s => ({ ...s, dist: self ? Math.hypot(s.anchor.x - self.x, s.anchor.z - self.z) : 0 }))
    .filter(s => s.dist <= cfg.structRadius)
    .sort((a, b) => a.dist - b.dist);
  if (todo.length) return { mode: 'explore', structure: todo[0] };
  return { skip: structures.length ? '看见的建筑都进过了' : '没看见箱子，也没认出建筑' };
}

/**
 * 该不该回家整理。
 * @param c.free        背包空格数
 * @param c.short       缺的 essential 标签
 * @param c.atHomeHas   其中家里箱子里记得有的
 * @param c.homeDist    离家多远（null = 不知道家在哪）
 * @param c.nightOut / c.sinceLast（上次整理过去多久，ms）
 * @returns { go: true, why } | { skip }
 */
function pickTidy (c, cfg = CFG.tidy) {
  const { free = 36, short = [], atHomeHas = [], homeDist = null, nightOut = false, sinceLast = Infinity,
    pack = null, sincePack = Infinity } = c;   // pack = { free: 背包空格(null=没开过不知道), has: [背包里有的缺项] } | null（没背）
  const full = free <= cfg.fullAt;
  // 先用背包：满了还能装、缺的背包里有 —— 就地倒腾，不跑回家
  if (pack && sincePack >= cfg.packCooldownMs) {
    const packRoom = pack.free == null || pack.free >= cfg.packMinFree;
    if ((full && packRoom) || (pack.has || []).length) {
      return { go: true, where: 'backpack', why: [full && packRoom ? `身上只剩 ${free} 格，先装进背包` : null, (pack.has || []).length ? `从背包里拿 ${pack.has.join('、')}` : null].filter(Boolean).join('，') };
    }
  }
  const restock = atHomeHas.length > 0;
  if (!full && !restock) return { skip: short.length ? `缺 ${short.join('、')}，家里也没记得有` : '身上齐全，也没满' };
  if (homeDist == null) return { skip: '不知道家在哪' };
  if (sinceLast < cfg.cooldownMs) return { skip: '刚整理过' };
  if (homeDist > cfg.maxHomeDist) return { skip: `离家 ${Math.round(homeDist)} 格，太远了（mind 决定要不要回）` };
  if (nightOut && homeDist > cfg.nightHomeDist) return { skip: '夜里在露天，家不够近' };
  return { go: true, where: 'home', why: [full ? `身上快满了（只剩 ${free} 格${pack ? '，背包也快满了' : ''}）` : null, restock ? `回家拿 ${atHomeHas.join('、')}` : null].filter(Boolean).join('，') };
}

function carriedNames (bot, state) {
  const names = bot.inventory.items().map(i => i.name);
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return { names, source: 'carried', readable: false };
  // 判据只关心"有没有这一种"，不需要真的按数量铺开（pickaxeTier / have 只看名字）
  for (const name of Object.keys(seen.items)) names.push(name);
  return { names, source: 'carried+backpack', readable: true };
}

/**
 * 名字 → 数量（身上的 + 背包记录里的）。背包读不到时 readable:false，只算身上的，
 * 调用方据此判断要不要在 skip 原因里写「背包读不到」。
 */
function carriedTally (bot, state) {
  const have = {};
  for (const it of bot.inventory.items()) have[bareNameOf(it.name)] = (have[bareNameOf(it.name)] || 0) + it.count;
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return { have, readable: false };
  for (const [name, count] of Object.entries(seen.items)) have[bareNameOf(name)] = (have[bareNameOf(name)] || 0) + count;
  return { have, readable: true };
}

/**
 * 一次拾取之后，哪些掉落物算"她没捡到"（要记失败、累计到 maxFails 就先放下）。
 * 被打断（aborted / r.stopped）的一律不算；只算"试过"的、还在地上的。
 *
 * ⚠️ 2026-09-28 审计（codex fix0 #3）：`r.tried` **缺失**时不再"退回全部 ids"。
 *
 *    旧行为是：`Array.isArray(r?.tried) ? new Set(r.tried) : null`，
 *    `null` 在下面被当成"没这个字段 → 全部算试过"。这对**旧版 bridge**（真的
 *    不返回 `tried`）是兼容，但对**异常 / 不完整响应**（handler 抛了、连不上、
 *    返回 `{error}`）就是误伤：会把全部 id 记成失败 → 拉黑一分钟。
 *    两者在旧判据里长得一模一样，分不开。
 *
 *    现在按**响应来自哪一版 bridge** 区分，而不是"字段在不在"：
 *      · 有 `tried` 数组 → 就按它算（新 bridge 的正常路径）；
 *      · 响应**明确是本次调用的正常返回**（有 `found`/`walkedTo` 这些本端点
 *        自有的字段）却没有 `tried` → 视为"说不清，一条都不记"（保守，
 *        AGENTS §5：证据不足不累计失败）；
 *      · 其余（handler 异常 / `{error}` / `null`）→ 一条都不记。
 *    真正的旧版 bridge 兼容改由 `found` 字段做锚点 —— 旧版也有 `found`
 *    但没有 `tried`，那种情况**只有**在调用方显式声明 `legacyOk` 时才按全部算。
 *
 * @param r         `POST /pickup` 的返回（可能为 null / {error}）
 * @param legacyOk  调用方确认"对面是旧版 bridge"时才为 true（默认 false）
 */
function pickupFailIds ({ ids = [], r = null, aborted = false, exists = () => true, legacyOk = false } = {}) {
  if (aborted || r?.stopped === 'aborted') return [];
  if (!r || typeof r !== 'object' || r.error) return [];      // 异常 / 不完整响应：不记
  const tried = Array.isArray(r.tried) ? new Set(r.tried) : null;
  // 没有 tried、又不是旧版：说不清她试过哪些 → 一条都不记（不误伤、不误冷却）
  if (!tried && !legacyOk) return [];
  return ids.filter(id => (!tried || tried.has(id)) && exists(id));
}

module.exports = { bind, carriedNames, carriedTally, hdist, pickHarvest, pickLoot, pickPickup, pickTidy, pickupFailIds, whoThrew };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/pickup.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['扔出来的判定', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { whoThrew } = ns;
    // ---- 扔出来的判定 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const owner = { x: 5.5, y: 64, z: 0.5 };
    const P2 = [{ name: 'starwish', pos: owner }, { name: 'self', pos: me }];
    check('★ 从玩家眼前生成 → 他扔的', whoThrew({ x: 5.6, y: 65.32, z: 0.5 }, P2), 'starwish');
    check('从她自己眼前生成 → 她自己扔的', whoThrew({ x: 0.5, y: 65.3, z: 0.4 }, P2), 'self');
    check('挖旁边的方块掉的（方块中心 ±0.25）→ 不是扔的', whoThrew({ x: 6.75, y: 65.5, z: 0.5 }, P2), null);
    check('怪死在玩家脚边掉的（脚底高度）→ 不是扔的', whoThrew({ x: 5.6, y: 64.1, z: 0.5 }, P2), null);
  }],
  ['挑哪几堆', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, pickPickup } = ns;
    // ---- 挑哪几堆 ----
    const P = CFG.pickup;
    const me = { x: 0.5, y: 64, z: 0.5 };
    const d = (id, x, z, extra = {}) => ({ id, pos: { x, y: 64, z }, ageMs: 5000, thrower: null, item: 'cobblestone', ...extra });
    check('附近一堆 → 捡', pickPickup({ self: me, drops: [d(1, 3, 0)] }).ids?.[0], 1);
    check('刚落地 → 等等', pickPickup({ self: me, drops: [d(1, 3, 0, { ageMs: 200 })] }).ids, undefined);
    check('★ 玩家扔的（常常是扔给她的）→ 捡', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'starwish' })] }).ids?.[0], 1);
    check('玩家刚扔出 1.5 秒 → 再等等（拾取延迟 + 给他反悔的时间）', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'starwish', ageMs: 1500 })] }).ids, undefined);
    check('★ 她自己扔的 → 不捡（不然丢了又捡）', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'self' })] }).ids, undefined);
    check('太远 → 不管', pickPickup({ self: me, drops: [d(1, 20, 0)] }).ids, undefined);
    check('楼下 5 格 → 不管', pickPickup({ self: me, drops: [{ ...d(1, 2, 0), pos: { x: 2, y: 59, z: 0 } }] }).ids, undefined);
    check('装不下 → 不去', pickPickup({ self: me, drops: [d(1, 3, 0)], canHold: () => false }).ids, undefined);
    const fails = new Map([[1, { n: 2, until: 1e12 }]]);
    check('★ 试了两次没捡到 → 先放着', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 0 }).ids, undefined);
    check('冷却过了 → 再试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 2e12 }).ids?.[0], 1);
    check('只失败一次 → 还试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails: new Map([[1, { n: 1, until: 1e12 }]]), now: 0 }).ids?.[0], 1);
    const many = [d(1, 7, 0), d(2, 1, 0), d(3, 4, 0), d(4, 2, 0), d(5, 3, 0), d(6, 5, 0)];
    const r = pickPickup({ self: me, drops: many }, { ...P, batch: 4 });   // 测"截到 batch"这件事，batch 固定成 4（默认值会调）
    check('一次最多 batch 堆', r.ids.length, 4);
    check('从近到远', r.ids.join(','), '2,4,5,3');
    check('跳过的原因写得出来', /mine=1/.test(pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'self' })] }).skip), true);
    check('没有掉落物 → 如实说没有', pickPickup({ self: me, drops: [] }).skip, '附近没有掉落物');
  }],
  ['远处拾取（任务书第 4 条）：闲着时才去捡 farRadius 内看得见的', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, pickPickup } = ns;
    // ---- 远处拾取（任务书第 4 条）：闲着时才去捡 farRadius 内看得见的
    const P = CFG.pickup;
    const me = { x: 0.5, y: 64, z: 0.5 };
    const d = (id, x, z, extra = {}) => ({ id, pos: { x, y: 64, z }, ageMs: 5000, thrower: null, item: 'cobblestone', ...extra });
    const fails = new Map([[1, { n: 2, until: 1e12 }]]);
    {
      const farCfg = { ...P, far: true };
      // 实机现场：掉落物在 6~17 格（8 格半径外），她不去 → 远处模式要选中它
      check('★ 闲着 + 12 格外的 → 远处模式会去捡', pickPickup({ self: me, drops: [d(9, 12, 0)] }, farCfg).ids?.[0], 9);
      check('远处模式：15 格内也去（实机 far=15）', pickPickup({ self: me, drops: [d(9, 15, 0)] }, farCfg).ids?.[0], 9);
      check('远处模式：超出 farRadius(24) 的不去', pickPickup({ self: me, drops: [d(9, 30, 0)] }, farCfg).ids, undefined);
      check('远处模式：看不见的（墙后）不去', pickPickup({ self: me, drops: [d(9, 12, 0, { visible: false })] }, farCfg).ids, undefined);
      check('远处模式：看得见的才去', pickPickup({ self: me, drops: [d(9, 12, 0, { visible: true })] }, farCfg).ids?.[0], 9);
      check('★ 不开 far 时老行为不变：12 格外的仍然不管', pickPickup({ self: me, drops: [d(9, 12, 0)] }).ids, undefined);
      check('★ 跟随中不给远处模式（只捡 6 格内的）', pickPickup({ self: me, drops: [d(9, 12, 0)], following: { pos: me } }, farCfg).ids, undefined);
      check('远处模式也照样不捡自己扔的', pickPickup({ self: me, drops: [d(9, 12, 0, { thrower: 'self' })] }, farCfg).ids, undefined);
      check('远处模式也照样受"两次没捡到"冷却', pickPickup({ self: me, drops: [d(9, 12, 0)], fails: new Map([[9, { n: 2, until: 1e12 }]]), now: 0 }, farCfg).ids, undefined);
    }

    // 跟随中：离她近、离玩家也近才捡
    const fol = { pos: { x: 3, y: 64, z: 0 } };
    check('跟随中：玩家身边的 → 捡', pickPickup({ self: me, drops: [d(1, 4, 0)], following: fol }).ids?.[0], 1);
    const folFar = { pos: { x: 6, y: 64, z: 0 } };   // 玩家已经往前走出 6 格
    check('★ 跟随中：离玩家太远的 → 不为它把人跟丢', pickPickup({ self: me, drops: [d(1, -4, 0)], following: folFar }).ids, undefined);
  }],
  ['随身物品：精妙背包里的也要算（P-4 / N-9）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { carriedNames, carriedTally, pickaxeTier } = ns;
    // ---- 随身物品：精妙背包里的也要算（P-4 / N-9）
    const cbot = (carried) => ({ inventory: { items: () => carried.map(c => ({ name: c.name, count: c.count })) } });
    check('★ 镐子在精妙背包里 → 算得上（以前只看身上，判成"没镐子"）',
      pickaxeTier(carriedNames(cbot([]), { backpackSeen: { items: { 'minecraft:iron_pickaxe': 1 } } }).names), 2);
    check('背包读不到 → readable:false（调用方不能说"没有"）', carriedNames(cbot([{ name: 'torch', count: 1 }]), {}).readable, false);
    check('★ 背包读得到 → readable:true', carriedNames(cbot([]), { backpackSeen: { items: { 'minecraft:torch': 1 } } }).readable, true);
    check('身上 + 背包同名 → 合并计数', carriedTally(cbot([{ name: 'torch', count: 4 }]), { backpackSeen: { items: { 'minecraft:torch': 10 } } }).have.torch, 14);
    check('背包读不到时只算身上的', carriedTally(cbot([{ name: 'torch', count: 4 }]), {}).have.torch, 4);
    check('背包里的原铁算了（"缺不缺这种矿"用它判断）', carriedTally(cbot([]), { backpackSeen: { items: { 'minecraft:raw_iron': 9 } } }).have.raw_iron, 9);
  }],
  ['收哪些庄稼', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickHarvest } = ns;
    // ---- 收哪些庄稼 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const crop = (x, z, extra = {}) => ({ name: 'wheat', pos: { x, y: 64, z }, age: 7, maxAge: 7, harvest: 'break', farmland: true, visible: true, ...extra });
    const home = () => true; const away = () => false;
    check('家里三棵熟了 → 收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)], inHome: home }).only?.length, 3);
    check('只熟了两棵 → 攒一攒', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0, { age: 4 })], inHome: home }).only, undefined);
    check('★ 别人（家外）耕地上的 → 不收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)], inHome: away }).only, undefined);
    check('★ 不知道家在哪 → 耕地上的也不收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)] }).only, undefined);
    check('野生的（不在耕地上）→ 收', pickHarvest({ self: me, crops: [crop(1, 0, { farmland: false }), crop(2, 0, { farmland: false }), crop(3, 0, { farmland: false })] }).only?.length, 3);
    check('★ 右键摘的（浆果丛）→ 不打掉', pickHarvest({ self: me, crops: [1, 2, 3].map(x => crop(x, 0, { harvest: 'use' })), inHome: home }).only, undefined);
  }],
  ['回家整理', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickTidy } = ns;
    // ---- 回家整理 ----
    const TD = (o) => pickTidy({ free: 20, short: [], atHomeHas: [], homeDist: 30, ...o });
    check('身上齐全、没满 → 不回', TD({}).go, undefined);
    check('★ 背包快满 → 回家整理', TD({ free: 2 }).go, true);
    check('★ 没吃的、家里箱子里有 → 回家拿', TD({ short: ['吃的'], atHomeHas: ['吃的'] }).go, true);
    check('★ 没吃的、家里也没有 → 不空跑（告诉 mind 就行）', TD({ short: ['吃的'], atHomeHas: [] }).go, undefined);
    check('不知道家在哪 → 不回', TD({ free: 1, homeDist: null }).go, undefined);
    check('离家太远 → 不专程回（mind 决定）', TD({ free: 1, homeDist: 500 }).go, undefined);
    check('刚整理过 → 不回', TD({ free: 1, sinceLast: 1000 }).go, undefined);
    check('夜里在露天、家远 → 不回', TD({ free: 1, homeDist: 100, nightOut: true }).go, undefined);
    check('夜里在露天、家就在旁边 → 回', TD({ free: 1, homeDist: 20, nightOut: true }).go, true);
    check('★ 身上快满、背着背包还有空 → 先装背包，不回家', TD({ free: 2, pack: { free: 20, has: [] } }).where, 'backpack');
    check('★ 缺吃的、背包里有 → 从背包拿（哪怕家里也有）', TD({ short: ['吃的'], atHomeHas: ['吃的'], pack: { free: 10, has: ['吃的'] } }).where, 'backpack');
    check('★ 身上满、背包也满 → 回家', TD({ free: 2, pack: { free: 1, has: [] } }).where, 'home');
    check('背包没开过（不知道剩多少）→ 试一次', TD({ free: 2, pack: { free: null, has: [] } }).where, 'backpack');
    check('刚倒腾过背包 → 这次回家', TD({ free: 2, pack: { free: 20, has: [] }, sincePack: 1000 }).where, 'home');
  }],
];
register('pickup', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('pickup', __sections);
}
