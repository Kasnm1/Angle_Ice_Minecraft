'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「mining」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const paths = require('../paths');
const __ns = {};
let TIER, CFG;   // 跨文件常量：load 完成后由 bind() 回填
function hdist (...a) { return __ns.hdist.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); TIER = ns.TIER; CFG = ns.CFG; }

function pickaxeTier (itemNames = []) {
  let best = -1;
  for (const n of itemNames) {
    const bare = String(n).replace(/^.*:/, '');
    if (!/pickaxe/.test(bare)) continue;
    const m = /^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/.exec(bare);
    const t = m ? { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }[m[1]]
      : /netherite/.test(bare) ? 4 : /diamond/.test(bare) ? 3 : /iron|steel/.test(bare) ? 2 : 1;
    if (t > best) best = t;
  }
  return best;   // -1 = 没有镐子
}

const needTier = (tier) => (tier && TIER[tier] != null ? TIER[tier] : TIER.iron);

/**
 * 身上的 + 精妙背包里的物品名清单（主人 2026-09-28，codex 审计 P-4 / N-9）。
 *
 * 以前 `pickaxeTier(bot.inventory.items()…)` 只看普通物品栏 —— 镐子放在精妙背包（108 格）里时
 * 判"镐子不够"，看见矿也不挖。这里把 `state.backpackSeen` 里的也并进来。
 *
 * ⚠️ 只是**算上背包里的**，不真的把镐子拿出来 —— 判据用；真要取工具是 hands 的活。
 * 读不到背包时（没背 / 从没打开过）返回 `readable:false`，调用方要按原逻辑算，并且**不能说"没有"**。
 *
 * @returns {{ names:string[], source:'carried'|'carried+backpack', readable:boolean }}
 */
// instinct 里的裸名（去 minecraft: 前缀）—— 和 loadTables 的 bareName 同一规则
// 第 4 步去重：原为本文件本地定义，与 instinct/core.js:676 的 `bareName` 逐字重复 ——
// 唯一一份在 src/util/ids.js（`String(n)` 版）。保留本地名 `bareNameOf` 不动调用点。
const { bareMinecraft: bareNameOf } = require('../util/ids');

/**
 * 挖哪条矿。
 * @param ctx.ores   [{ name, pos, value, tier, drops?, visible, hazard }]  hazard = 旁边有岩浆/水
 * @param ctx.self   她的位置；ctx.pick = pickaxeTier()；ctx.have = 物品名 → 数量（判断 low 矿缺不缺）
 * @param ctx.fails  Map "x,y,z" → until
 * @param ctx.followIdle  跟着的玩家**原地不动**（>8s）时给她当前位置；null = 不在跟随模式
 *                        这时用的是 cfg.followRadius（跟着人时别跑太远，跟丢了她会追不上）
 * @returns { target, count } | { skip, lacking? }   lacking = [{ name, pos, need }] 看得见但镐子不够的（告诉 mind）
 */
function pickOre (ctx, cfg = CFG.mine) {
  const { ores = [], self, pick = -1, have = {}, fails = new Map(), now = Date.now(), followIdle = null } = ctx;
  const early = pick < TIER.iron;   // 还没有铁镐：前期，铁和煤就是最值钱的
  if (!self) return { skip: '没有位置' };
  const radius = followIdle ? Math.min(cfg.radius, cfg.followRadius ?? cfg.radius) : cfg.radius;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const lacking = [];
  const why = { far: 0, hidden: 0, hazard: 0, failed: 0, cheap: 0, tool: 0, shovel: 0, follow: 0 };
  const ok = [];
  for (const o of ores) {
    if (!o?.pos) continue;
    if (hdist(o.pos, self) > radius || Math.abs(o.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!o.visible) { why.hidden++; continue; }
    if (o.hazard) { why.hazard++; continue; }
    if (o.notPickaxe) { why.shovel++; continue; }   // 不是镐子挖的（化石矿要铲子）—— 矿表里标出来的
    const f = fails.get(key(o.pos));
    if (f && now < f) { why.failed++; continue; }
    // 跟着人时：矿不能离**他**太远（不然挖完她在远处，人走了就丢）
    if (followIdle && hdist(o.pos, followIdle.pos) > (cfg.followLeash ?? 16)) { why.follow++; continue; }
    const isIron = (o.drops || []).some(d => /(^|:)(raw_iron|iron_ingot|iron_nugget)$/.test(d));
    if (o.value === 'low') {
      const got = (o.drops || []).reduce((n, d) => n + (have[d] || 0), 0);
      if (got >= (early ? cfg.lowWhenBelow * 2 : cfg.lowWhenBelow)) { why.cheap++; continue; }
    }
    const need = needTier(o.tier);
    if (pick < need) { why.tool++; lacking.push({ name: o.name, pos: o.pos, need }); continue; }
    // 价值排序（第 3 条：按 knowledge/ores.json 的 value 排，没价值/很低价值的排最后）：
    //   0 = high（钻石、铁…，以及前期最缺的铁）
    //   1 = mid（铜、金、油矿…）
    //   2 = low（煤、青金石…，够用就不挖，上面已经筛过一遍）
    //   3 = 没有 value 字段 / value 不认识 —— **排最后但不永久排除**（可能是新模组矿、矿表还没补；
    //       排最后意味着"附近只有它时才挖"，不会为了它放弃铁矿，也不会因为表里没记就彻底看不见）
    const v = o.value === 'high' ? 0 : o.value === 'mid' ? 1 : o.value === 'low' ? 2 : 3;
    const rank = (early && isIron && v > 0) ? 0 : v;   // 前期：铁优先于一切（含钻石那档，因为挖不动）
    ok.push({ ...o, dist: hdist(o.pos, self), rank, unknownValue: v === 3 });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: parts.length ? `有矿但不挖（${parts.join(' ')}）` : '看不见矿', lacking };
  }
  ok.sort((a, b) => (a.rank - b.rank) || (a.dist - b.dist));
  const t = ok[0];
  const count = Math.min(cfg.maxVein, ok.filter(o => o.name === t.name).length);
  return { target: { name: t.name, pos: t.pos }, count, lacking };
}

/**
 * 洞里下一步去哪。cells：候选的落脚点 [{ pos, visible, lavaNear, dark }]（已经是"脚和头是空的、脚下实心"的格子）。
 * 只去看得见的、没去过的、旁边没岩浆的、不太低的、不出入口 range 的；先挑暗的（没点亮 = 没人来过），再挑远一点的。
 */
function pickCaveStep ({ cells = [], self, entry = null, visited = new Set() }, cfg = CFG.cave) {
  if (!self) return null;
  const cell = (p) => `${Math.floor(p.x / cfg.visitCell)},${Math.floor(p.y / cfg.visitCell)},${Math.floor(p.z / cfg.visitCell)}`;
  const ok = cells.filter(c => c.visible && !c.lavaNear
    && !visited.has(cell(c.pos))
    && self.y - c.pos.y <= cfg.maxDrop
    && Math.hypot(c.pos.x - self.x, c.pos.z - self.z) >= cfg.minStep
    && (!entry || Math.hypot(c.pos.x - entry.x, c.pos.y - entry.y, c.pos.z - entry.z) <= cfg.range));
  if (!ok.length) return null;
  ok.sort((a, b) => ((b.dark ? 1 : 0) - (a.dark ? 1 : 0))
    || (Math.hypot(b.pos.x - self.x, b.pos.z - self.z) - Math.hypot(a.pos.x - self.x, a.pos.z - self.z)));
  return { ...ok[0], cell: cell(ok[0].pos) };
}

/**
 * 该不该在这儿插个火把（2026-09-28 第 8 批 第 4 条，纯函数）。
 *
 * 主人："插火把很慢。" 实机：`light_up() ✗ 正在执行紧急本能：combat` ——
 * 火把只有 mind 想起来调 `light_up`、或 `delve` 每 8 格插一根时才插；
 * 本能层根本没有"暗了就点灯"这一条。这条顶上。
 *
 * 判据（全部满足才插）：
 *   ① 在地下 / 洞里：exposure.kind === 'underground' 或（sheltered 且头顶有顶 roofAt != null）
 *      —— 露天的黑（夜里）不算，那是该回家睡觉的事，不是点灯的事；
 *   ② 脚下那格的**方块光**读得到（block 是数字）且 ≤ darkMax（默认 7，原版怪物在方块光 0 刷，留余量）
 *      —— 读不到就不插（主人：区分"没有"和"读不到"，读不到不猜）；
 *   ③ 身上有火把（torches > 0）；
 *   ④ 最近的光源 > spacing 格（默认 7）—— 和 `lightUp` 的判据一致，不重复插。
 * **打架时不插**（由调用方保证，不在这个纯函数里）。
 *
 * @returns {{place:true, why:string}|{place:false, why:string}}
 */
function pickTorchStep (c = {}, cfg = CFG.torch) {
  const { exposure = null, light = null, torches = 0, nearestLight = null, movedSince = Infinity } = c;
  if (!(torches > 0)) return { place: false, why: '身上没火把' };
  // ① 地下？
  const kind = exposure?.kind;
  if (!(kind === 'underground' || (kind === 'sheltered' && exposure?.roofAt != null))) {
    return { place: false, why: kind ? `不在洞里（exposure=${kind}）` : '不知道头顶有没有遮挡' };
  }
  // ④ 移动够了才检查（每 ~6 格一次，别每拍都点）
  if (movedSince < cfg.everyBlocks) return { place: false, why: `才走了 ${movedSince.toFixed(1)} 格，还没到 ${cfg.everyBlocks}` };
  // ② 亮度读得到才算暗
  if (!Number.isFinite(light)) return { place: false, why: '脚下亮度读不到，不插' };
  if (light > cfg.darkMax) return { place: false, why: `脚下不暗（方块光 ${light}）` };
  // ③ 附近已经有光源就不插
  if (nearestLight && nearestLight.distance <= cfg.spacing) return { place: false, why: `${nearestLight.distance} 格内已经有光源` };
  return { place: true, why: `脚下暗（方块光 ${light}）且 ${cfg.spacing} 格内没光源` };
}

/**
 * 家里的暗处（mindcraft modes.js 调研后建议的"只提醒、不动手"：插不插、插哪由 mind / 主人定，基地的布局归主人）。
 * 1.20.1 敌对怪要**方块光照 0** 才刷。亮度先要证明读得到：家里的光源（火把、灯…）自己那格读出来 ≥ 10 才信；
 * 有光源却都读成暗的 = 亮度数据读不到（mindcraft 就栽在这：block.light 是坏的），**不报暗**。
 * @param sourceLights  家里光源所在格读到的方块光照（数组；undefined/null = 读不到）
 * @param cells         家里可站的地面格 [{ pos, light }]（light = 脚那格的方块光照）
 * @returns null | { kind: 'unreadable' } | { kind: 'no_source' } | { kind: 'dark', count, sample:[pos] }
 */
function darkReport ({ sourceLights = [], cells = [] } = {}, minCount = 3) {
  const readable = sourceLights.some(l => typeof l === 'number' && l >= 10);
  if (sourceLights.length && !readable) return { kind: 'unreadable' };
  if (!sourceLights.length) return cells.length >= minCount ? { kind: 'no_source' } : null;
  const dark = cells.filter(c => c.light === 0);
  if (dark.length < minCount) return null;
  return { kind: 'dark', count: dark.length, sample: dark.slice(0, 3).map(c => c.pos) };
}

/**
 * mind 让下矿（`POST /delve`）之后，本能记下"正在下矿"（2026-09-28 第 8 批 第 5 条）。
 *
 * 实机证据：`delve(seconds=90 …) ✓ gained={raw_copper:5, cobblestone:21}` 只跑了 50 秒
 * 就因为战斗中断，然后她**站在原地等 mind 再想起来** —— 那段洞里看得见的矿就白瞎了。
 *
 * 这里只记"目标 / 方向 / 开始时刻 / 上次被打断的时刻"，不自己决定什么时候下矿。
 * 是否续探的判据在 `pickDelveResume`（纯函数，可离线自测）：
 *   · 5 分钟内（resumeMs）有 mind 发起的下矿记录；
 *   · 记录里的洞口离她现在不远（不跨维度、不跨半个世界）；
 *   · 体力/背包/mind 没有别的安排（由 tick 的顺序保证）；
 *   · 中途没有"她自己要走的事"（由调用点保证）。
 *
 * @param {object} I      state.instinct
 * @param {object} a      `POST /delve` 的参数（target / targetY / seconds）
 * @param {object} r      delve 的返回（reason / at / entry / deepest / heading）
 * @param {number} now
 */
function noteDelve (I, a = {}, r = {}, now = Date.now()) {
  if (!I) return null;
  const tgt = a.target || null; const ty = a.targetY != null ? +a.targetY : null;
  const rec = {
    target: tgt, targetY: ty, seconds: +a.seconds || +a.maxMs ? Math.round((+a.seconds || +a.maxMs / 1000)) : null,
    at: r.at ? { x: r.at.x, y: r.at.y, z: r.at.z } : null,
    entry: r.entry || null,
    heading: r.heading || null,
    startedAt: I.delve?.target === tgt ? (I.delve.startedAt || now) : now,
    resumes: a.resumed ? (I.delve?.target === tgt ? (I.delve.resumes || 0) + 1 : 1) : 0,   // mind 自己发起的下矿：计数归零
    lastAt: now,
    reason: r.reason || null,
    // 被战斗/怪打断：delve 的 reason 里会写"僵尸/骷髅 在 N 格外"这种
    interrupted: /在 \d+(\.\d+)? 格外/.test(String(r.reason || '')) ? String(r.reason) : null,
    // 这些原因停下的不自己接着下（Claude 复查）：血少回洞里危险；背包满 / 火把用完接着下会马上又停，来回抖
    noResume: /血只剩|背包快满|火把用完|没有火把|镐子不够/.test(String(r.reason || '')) ? String(r.reason) : null,
  };
  I.delve = rec;
  return rec;
}

/**
 * 该不该由**本能**把被打断的下矿接着走下去（第 5 条，纯函数）。
 *
 * cave 本能保持默认关（Codex 的理由成立：会把"人在洞里"误当成"主人让我探险"）。
 * 但**mind 明确发起过的下矿**不算"误当成" —— 有目标、有时间、有记录，接着走是照吩咐办事。
 *
 * @param {{delve:?object, self:?{x,y,z}, now:number, resumeMs:number, reach:number, enabled:boolean, caveEnabled:boolean}} c
 * @returns {null|{resume:true, why:string, target:?string, entry:?object}|{resume:false, why:string}}
 */
function pickDelveResume (c = {}) {
  const { delve = null, self = null, now = Date.now(), resumeMs = 300000, reach = 96 } = c;
  if (!c.enabled) return { resume: false, why: '续探本能关着' };
  if (!delve) return { resume: false, why: '最近没有下过矿' };
  if (delve.noResume) return { resume: false, why: `上次是因为「${delve.noResume}」停的，不自己接着下` };
  if ((delve.resumes || 0) >= (c.maxResumes ?? 3)) return { resume: false, why: `已经自己接着下了 ${delve.resumes} 次，等 mind 决定` };
  if (!self) return { resume: false, why: '没有位置' };
  const since = now - (delve.lastAt || delve.startedAt || 0);
  if (!(since < resumeMs)) return { resume: false, why: `上次下矿已是 ${Math.round(since / 1000)} 秒前（超过 ${Math.round(resumeMs / 1000)} 秒就不主动接着走了）` };
  // 离记录里的地方太远 → 不跨半张地图去"接着挖"
  const p = delve.at || delve.entry;
  if (p && Number.isFinite(p.x)) {
    const d = Math.hypot(self.x - p.x, self.z - p.z);
    if (d > reach) return { resume: false, why: `上次下矿的地方在 ${Math.round(d)} 格外（超过 ${reach} 格）` };
  }
  return { resume: true, why: delve.interrupted ? `上次因为「${delve.interrupted}」断了 ${Math.round(since / 1000)} 秒，接着把它挖完` : `上次下矿结束 ${Math.round(since / 1000)} 秒，还能接着挖`, target: delve.target, entry: delve.entry };
}

module.exports = { bareNameOf, bind, darkReport, needTier, noteDelve, pickCaveStep, pickDelveResume, pickOre, pickTorchStep, pickaxeTier };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/mining.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['镐子等级', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { TIER, needTier, pickaxeTier } = ns;
    // ---- 镐子等级 ----
    check('没有镐子 → -1', pickaxeTier(['minecraft:stick']), -1);
    check('石镐 + 铁镐 → 取最好的（铁=2）', pickaxeTier(['stone_pickaxe', 'minecraft:iron_pickaxe']), 2);
    check('金镐只算木级', pickaxeTier(['golden_pickaxe']), 0);
    check('模组镐认得出材质的按材质', pickaxeTier(['somemod:diamond_pickaxe_plus']), 3);
    check('模组镐认不出材质 → 按石镐（宁可少挖）', pickaxeTier(['somemod:crystal_pickaxe']), 1);
    check('★ 矿表没查到等级 → 保守按铁镐', needTier(null), TIER.iron);
  }],
  ['挖哪条矿', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { TIER, pickOre } = ns;
    // ---- 挖哪条矿 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const fails = new Map([[1, { n: 2, until: 1e12 }]]);
    const ore = (name, x, z, extra = {}) => ({ name, pos: { x, y: 64, z }, value: 'mid', tier: 'stone', drops: ['raw_iron'], visible: true, hazard: false, ...extra });
    const O = (ores, extra = {}) => pickOre({ ores, self: me, pick: 2, ...extra });
    check('看得见的铁矿 → 挖', O([ore('iron_ore', 3, 0)]).target?.name, 'iron_ore');
    check('★ 看不见的（透视）→ 不挖', O([ore('iron_ore', 3, 0, { visible: false })]).target, undefined);
    check('★ 旁边有岩浆 → 不挖', O([ore('iron_ore', 3, 0, { hazard: true })]).target, undefined);
    check('太远 → 不去', O([ore('iron_ore', 30, 0)]).target, undefined);
    check('★ 高价值优先，哪怕远一点', O([ore('iron_ore', 2, 0), ore('diamond_ore', 8, 0, { value: 'high', tier: 'iron' })]).target?.name, 'diamond_ore');
    const noTool = O([ore('diamond_ore', 3, 0, { value: 'high', tier: 'iron' })], { pick: 1 });
    check('★ 石镐遇钻石矿 → 不挖', noTool.target, undefined);
    check('★ …但告诉 mind 要铁镐', noTool.lacking?.[0]?.need, TIER.iron);
    check('没有镐子 → 什么都不挖', O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { pick: -1 }).target, undefined);
    const coal = (n) => O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { have: { coal: n } });
    check('煤不够（缺火把）→ 挖', coal(3).target?.name, 'coal_ore');
    check('★ 煤够多了 → 不为煤停下', coal(40).target, undefined);
    check('一条矿脉一起挖（同名的数）', O([ore('iron_ore', 3, 0), ore('iron_ore', 3, 1), ore('iron_ore', 4, 1)]).count, 3);
    check('要铲子的矿（化石矿）→ 不用镐去敲', O([ore('fossil_ore', 3, 0, { notPickaxe: true })]).target, undefined);
    check('失败过的格子冷却中 → 不挖', O([ore('iron_ore', 3, 0)], { fails: new Map([['3,64,0', 9e9]]), now: 0 }).target, undefined);
  }],
  ['按进度', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickOre } = ns;
    // ---- 按进度 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const ore = (name, x, z, extra = {}) => ({ name, pos: { x, y: 64, z }, value: 'mid', tier: 'stone', drops: ['raw_iron'], visible: true, hazard: false, ...extra });
    const early = (ores, have = {}) => pickOre({ ores, self: me, pick: 1, have });   // 石镐：前期
    check('★ 前期（石镐）：铁矿排在最前，哪怕旁边有青金石', early([ore('lapis_ore', 2, 0, { drops: ['lapis_lazuli'] }), ore('iron_ore', 8, 0)]).target?.name, 'iron_ore');
    check('★ 前期：煤有 20 个还挖（前期门槛翻倍到 32）', early([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { coal: 20 }).target?.name, 'coal_ore');
    check('后期（铁镐）：煤有 20 个就不为它停', pickOre({ ores: [ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], self: me, pick: 2, have: { coal: 20 } }).target, undefined);
    check('后期：钻石排在铁前面', pickOre({ ores: [ore('iron_ore', 2, 0), ore('diamond_ore', 9, 0, { value: 'high', tier: 'iron' })], self: me, pick: 2 }).target?.name, 'diamond_ore');
  }],
  ['洞里下一步', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickCaveStep } = ns;
    // ---- 洞里下一步 ----
    const cv = (x, y, z, extra = {}) => ({ pos: { x, y, z }, visible: true, lavaNear: false, dark: true, ...extra });
    const here = { x: 0, y: 30, z: 0 };
    check('往看得见、够远的地方走', pickCaveStep({ cells: [cv(8, 30, 0)], self: here })?.pos.x, 8);
    check('★ 旁边有岩浆 → 不去', pickCaveStep({ cells: [cv(8, 30, 0, { lavaNear: true })], self: here }), null);
    check('看不见（隔着墙）→ 不去', pickCaveStep({ cells: [cv(8, 30, 0, { visible: false })], self: here }), null);
    check('★ 太低（落差 >4）→ 不跳', pickCaveStep({ cells: [cv(8, 20, 0)], self: here }), null);
    check('太近（原地挪）→ 不算一步', pickCaveStep({ cells: [cv(2, 30, 0)], self: here }), null);
    check('★ 去过的格子 → 不再去', pickCaveStep({ cells: [cv(8, 30, 0)], self: here, visited: new Set(['2,7,0']) }), null);
    check('★ 暗的优先（没点亮 = 没人来过）', pickCaveStep({ cells: [cv(14, 30, 0, { dark: false }), cv(7, 30, 0)], self: here })?.pos.x, 7);
    check('出了入口范围 → 不去', pickCaveStep({ cells: [cv(10, 30, 0)], self: here, entry: { x: -60, y: 30, z: 0 } }), null);
  }],
  ['暗处插火把（第 8 批 第 4 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, mobKind, pickTorchStep } = ns;
    // ---- 暗处插火把（第 8 批 第 4 条）----
    const T = (name, dist, extra = {}) => ({ id: dist * 10, name, pos: { x: dist, y: 64, z: 0 }, dist, on: 'me', evidence: 'aggressive', kind: mobKind(name), ...extra });
    {
      const T = { ...CFG.torch };
      const under = { kind: 'underground', roofAt: 5, solidAbove: 9 };
      check('★ 地下 + 脚下黑 + 有火把 + 附近没光源 → 插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
      check('没火把 → 不插', pickTorchStep({ exposure: under, light: 0, torches: 0, nearestLight: null, movedSince: 10 }, T).place, false);
      check('★ 亮度读不到 → 不插（不猜）', pickTorchStep({ exposure: under, light: null, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
      check('★ 地面露天（kind=open）→ 不插（夜里黑该回家睡）', pickTorchStep({ exposure: { kind: 'open', skyLight: 15 }, light: 0, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
      check('露天但头顶有顶（sheltered + roofAt）→ 就当洞里，照插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: 3, skyLight: 5 }, light: 3, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
      check('sheltered 但读不出 roofAt → 不插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: null }, light: 3, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
      check('★ 脚下够亮（方块光 9）→ 不插', pickTorchStep({ exposure: under, light: 9, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
      check('★ 7 格内已经有光源 → 不插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: { distance: 5 }, movedSince: 10 }, T).place, false);
      check('最近光源在 9 格（>7）→ 插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: { distance: 9 }, movedSince: 10 }, T).place, true);
      check('★ 才走了 2 格（没到 6）→ 先不检查', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: 2 }, T).place, false);
      check('★ 第一次（movedSince=Infinity）→ 也算走够了', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: Infinity }, T).place, true);
      check('亮度刚好在阈值上（7）→ 插（判据是 ≥ 阈值才不插）', pickTorchStep({ exposure: under, light: 7, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
      check('亮度 8（阈值上一个）→ 不插', pickTorchStep({ exposure: under, light: 8, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
      check('亮度 6 → 插', pickTorchStep({ exposure: under, light: 6, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
      check('不插时说的理由里含"火把/光/暗"', /火把|光|暗|洞|走/.test(pickTorchStep({ exposure: under, light: 0, torches: 0, nearestLight: null, movedSince: 10 }, T).why), true);
    }
  }],
  ['续挖下矿（第 8 批 第 5 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { noteDelve, pickDelveResume } = ns;
    // ---- 续挖下矿（第 8 批 第 5 条）----
    {
      const now = 2000000;
      const drec = { target: 'iron_ore', targetY: 16, at: { x: 100, y: 20, z: 100 }, entry: { x: 100, y: 64, z: 100 }, lastAt: now - 60000, interrupted: '僵尸 在 3 格外' };
      check('★ 3 分钟前被打断的下矿 → 接着挖', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
      check('★ 8 分钟前断的（超过 5 分钟）→ 不主动接着走', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now: now + 300000, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('★ 记录的地方在 200 格外 → 不跨地图去接', pickDelveResume({ delve: drec, self: { x: 400, y: 20, z: 400 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('从没下过矿 → 不续', pickDelveResume({ delve: null, self: { x: 0, y: 64, z: 0 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('续挖本能关着 → 不续', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: false }).resume, false);
      check('没有位置 → 不续', pickDelveResume({ delve: drec, self: null, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('★ 续挖时带上原来的目标矿', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).target, 'iron_ore');
      // noteDelve：mind 下矿后被喂一条记录
      {
        const I2 = {};
        noteDelve(I2, { target: 'iron_ore', targetY: 16, seconds: 90 }, { reason: '时间到（90 秒），可以接着挖', at: { x: 1, y: 30, z: 2 }, entry: { x: 1, y: 64, z: 2 }, heading: [1, 0] }, now);
        check('★ noteDelve 记下目标', I2.delve.target, 'iron_ore');
        { const I3 = { cfg: {} }; const t = now;
          noteDelve(I3, { target: 'iron_ore' }, { reason: '血只剩 6', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 血少停下的 → 不自己接着下', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          noteDelve(I3, { target: 'iron_ore' }, { reason: '背包快满了', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 背包满停下的 → 不自己接着下（会来回抖）', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          const I4 = { cfg: {} };
          noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          for (let i = 0; i < 3; i++) noteDelve(I4, { target: 'coal_ore', resumed: true }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 自己接着下了 3 次 → 不再接', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          const I5 = { cfg: {} };
          noteDelve(I5, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ mind 自己又下一次矿 → 计数归零，又能接着下', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true);
          check('被怪打断一次 → 接着下', pickDelveResume({ enabled: true, delve: I5.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true); }
        check('noteDelve 记下位置', I2.delve.at.x, 1);
        check('★ 正常结束（时间到）不算 interrupted', I2.delve.interrupted, null);
        noteDelve(I2, { target: 'iron_ore' }, { reason: '僵尸 在 4 格外', at: { x: 3, y: 20, z: 4 } }, now + 1000);
        check('★ 被怪打断 → 记 interrupted', /僵尸/.test(String(I2.delve.interrupted)), true);
        check('★ 被怪打断后 5 分钟内续挖的判据成立', pickDelveResume({ delve: I2.delve, self: { x: 3, y: 20, z: 4 }, now: now + 6000, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
        const I3 = {};
        noteDelve(I3, { target: 'diamond' }, { reason: '没带火把，不下去（没有煤/木炭）' }, now);
        check('失败也记一笔（免得当成从没下过矿）', I3.delve.target, 'diamond');
      }
    }
  }],
  ['遇到矿就挖：价值排序（第 8 批 第 3 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickOre } = ns;
    // ---- 遇到矿就挖：价值排序（第 8 批 第 3 条）----
    const O = (ores, extra = {}) => pickOre({ ores, self: me, pick: 2, ...extra });
    const me = { x: 0.5, y: 64, z: 0.5 };
    {
      const mkCfg = { radius: 16, maxDy: 6, maxVein: 8, lowWhenBelow: 16, followLeash: 16 };
      const self = { x: 0, y: 30, z: 0 };
      const O = (name, value, dist, extra = {}) => ({ name, value, tier: 'stone', pos: { x: dist, y: 30, z: 0 }, visible: true, drops: [name], ...extra });
      // 近处 mid（油矿）vs 远处 high（铁矿）→ 该选 high（第 3 条的现场：她挖了油矿没挖铁矿）
      const r1 = pickOre({ ores: [O('ltc2:underground_oil_ore', 'mid', 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
      check('★ 近处 mid 油矿 vs 远处 high 铁矿 → 挖 high（价值优先于距离）', r1.target.name, 'minecraft:iron_ore');
      // 同档才比距离
      const r2 = pickOre({ ores: [O('a:high1', 'high', 9), O('b:high2', 'high', 3)], self, pick: 2 }, mkCfg);
      check('同一档 → 近的先挖', r2.target.name, 'b:high2');
      // 没有 value 字段的 → 排最后
      const r3 = pickOre({ ores: [O('mystery:ore', undefined, 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
      check('★ 矿表里没有 value 的排在 high 后面', r3.target.name, 'minecraft:iron_ore');
      // 只有没价值的 → 还是挖（比什么都不做强，且能顺手补矿表）
      const r4 = pickOre({ ores: [O('mystery:ore', undefined, 3)], self, pick: 2 }, mkCfg);
      check('★ 附近只有"没价值的"矿 → 也挖（不挑三拣四）', r4.target.name, 'mystery:ore');
      // 半径从 12 放到 16：15 格外的矿现在算"眼前"
      const r5 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 15)], self, pick: 2 }, mkCfg);
      check('★ 15 格外的铁矿（>旧半径 12）→ 现在挖得到', r5.target.name, 'minecraft:iron_ore');
      const r6 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 18)], self, pick: 2 }, mkCfg);
      check('18 格外（>新半径 16）→ 还是太远', r6.target, undefined);
      // 跟随模式：矿不能离被跟的人太远
      const r7 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: 0, y: 30, z: 0 } } }, mkCfg);
      check('跟着人时：矿在她脚下（离人也近）→ 能挖', r7.target.name, 'minecraft:iron_ore');
      const r8 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: -14, y: 30, z: 0 } } }, mkCfg);
      check('★ 跟着人时：矿离他 28 格（>跟随半径）→ 不挖（挖完追不上）', r8.target, undefined);
    }
  }],
];
register('mining', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('mining', __sections);
}
