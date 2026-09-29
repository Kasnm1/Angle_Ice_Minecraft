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

function needBreath ({ oxygen = null, headInWater = false, waterBreathing = false, underwaterMs = 0 } = {}, cfg = CFG.breathe) {
  // ⚠️ `oxygen` 必须是**归一过**的读数（`oxygenNum().value`），不是 `bot.oxygenLevel` 原值。
  //    2026-09-29 实机：模组/握手把 metadata 槽位挪了，`bot.oxygenLevel` 读到 288（原始 air ticks 量级），
  //    `288 ≤ 8` 为假 → 憋气本能不触发；`288 ≥ 18` 为真 → `POST /jump` 第一跳就"提前成功"退出，
  //    于是 0.3 秒一拍空转。归一后 288 直接按"读不到"处理，不再是有效氧气。
  if (!headInWater || waterBreathing) return false;
  // 读不到氧气（null / 288 这类被归一成 null 的）时**不能当"不用换气"**（2026-09-29 Claude 复核抓到：
  // 原来这里直接 return false，头泡在水里、读数又坏了，她就永远不上浮）。改按"头在水里泡了多久"：
  // 原版满氧 300 tick ≈ 15 秒，泡够 cfg.blindMs 就当该换气了。
  if (oxygen == null || !Number.isFinite(oxygen)) return underwaterMs >= (cfg.blindMs ?? 8000);
  return oxygen <= cfg.at;
}

/**
 * 「这是水」—— **判据只此一处**（AGENTS.md §5-4）。
 *
 * 2026-09-29 抽出来：原来 `core.js` 里同时有几份手写的 "水" 正则
 * （憋气一份、上岸两份、`routes/mine.js` 又一份）—— 现在**只有这里**这一份。
 * 水方块族：`water` / `flowing_water` / 模组的 `xxx:water`；气泡柱（`bubble_column`）也算
 * ——它有水的物理，泡在里面一样呛。
 *
 * @param {string} name 方块名（`bot.blockAt(...).name`）
 * @param {object} [props] 方块属性（可省）；`waterlogged` 的方块（半砖、楼梯）头也在水里
 * @returns {boolean} 读不到名字 → false（不猜）
 */
function blocksWater (name, props) {
  const nm = String(name || '');
  if (/(^|:)water$|flowing_water|bubble_column|seagrass|kelp/.test(nm)) return true;
  return !!(props && props.waterlogged === true);
}

/**
 * 她的头在不在水里（憋气、`/mine` 惜命共用）。
 * 头部位置 = 脚底 + 1.62（眼睛高度），与 `checkBreath` 原来那份逐字一致。
 * @param {object} bot mineflayer bot（要 `entity.position` + `blockAt`）
 * @returns {boolean} 读不到（没连上 / 没位置）→ false
 */
function headInWater (bot) {
  try {
    const p = bot?.entity?.position;
    if (!p) return false;
    const head = bot.blockAt(p.offset(0, 1.62, 0));
    if (!head) return false;
    return blocksWater(head.name, head.getProperties?.());
  } catch (_) { return false; }
}

/**
 * 有没有水下呼吸效果。mineflayer 给的效果名是 `WaterBreathing`（minecraft-data 写法）；
 * 模组可能写成 `water_breathing` —— 大小写/下划线都不敏感地认。
 */
function waterBreathing (effects) {
  if (!Array.isArray(effects)) return false;
  return effects.some(n => /water[_\s-]?breath/i.test(String(n)));
}

/**
 * 氧气读数归一（E：读数不可信时不能当真）。
 *
 * mineflayer 版本本身就存疑：`1.8+` 的路径是
 * `_ref/mineflayer/lib/plugins/entities.js:499` 的 `bot.oxygenLevel = Math.round(metas.air_supply / 15)`，
 * 而 `air_supply` 的**原始值**是 air ticks（满 300）。1.20.1 走的就是这条分支
 * （`mineData.supportFeature('mcDataHasEntityMetadata') === true`，实测）。
 * 也就是说槽位一旦被模组/握手挪动，`metas.air_supply` 会取到别的东西 ——
 * 2026-09-29 实机日志里的 `oxygen=288` 就是这么来的（288/15≈19，量级对得上原始 ticks）。
 *
 * **不替模组猜槽位、不做 288/15 的换算**（猜错会得出一个"看起来正常"的假氧气，比读不到更糟）。
 * 只认 0..20 这个合法区间；其余一律 `reliable:false`，调用方按"读不到"处理
 * （`needBreath` 拿到不可信值不会触发，`/mine` 的氧气保护也不会因为假读数放行）。
 *
 * @returns {{value:number|null, raw:*, reliable:boolean, why:string}}
 */
function oxygenNum (raw, max = 20) {
  if (raw == null || !Number.isFinite(raw)) return { value: null, raw: raw ?? null, reliable: false, why: '读不到氧气' };
  if (raw > max) return { value: null, raw, reliable: false, why: `氧气读数 ${raw} 超出 0..${max}（像是原始 air ticks 或槽位被挪），按读不到处理` };
  if (raw < 0) return { value: null, raw, reliable: false, why: `氧气读数 ${raw} 是负的（已经在掉血或槽位被挪），按读不到处理` };
  return { value: raw, raw, reliable: true, why: `氧气 ${raw}/${max}` };
}

/**
 * `/mine`：还要不要继续挖（第 1 条：水里惜命）。
 *
 * 头在水里、氧气低于安全线 → 停。**有水下呼吸效果不受限**（那是真的不呛）。
 * 读数不可信（`oxygen.reliable === false`）时：头在水里但**读不到气** → 也停
 * （保命动作保守一侧；AGENTS.md §5-5「找不到证据时保守」）。
 *
 * 阈值在 `CFG.bridge.mine.dryOxygenAt`（理由写在那里）。
 *
 * @param {object} p
 * @param {boolean} p.headInWater
 * @param {{value:number|null, reliable:boolean}} p.oxygen  `oxygenNum()` 的结果
 * @param {boolean} p.waterBreathing 有水下呼吸
 * @param {object} cfg `CFG.bridge.mine`
 * @returns {{stop:boolean, why:string}|{stop:false}}
 */
function mineShouldStop ({ headInWater = false, oxygen = null, waterBreathing = false } = {}, cfg = CFG.bridge.mine) {
  if (waterBreathing) return { stop: false };
  if (!headInWater) return { stop: false };
  const at = cfg.dryOxygenAt;
  if (!oxygen || oxygen.reliable === false) {
    return { stop: true, why: `在水底，氧气读不到（${oxygen?.why || '没有读数'}），先上去换气` };
  }
  if (oxygen.value <= at) {
    return { stop: true, why: `在水底，气不够了（${oxygen.value}/${20}，安全线 ${at}），先上去换气` };
  }
  return { stop: false };
}

/**
 * `/mine`：水下的目标该不该挖（第 2 条：默认不挖水里的东西。主人 2026-09-29：
 * 「不应该优先挖水中的东西，除非那个只在水里或者很重要」）。
 *
 * 允许挖水下的三种情况：
 *   ① **附近只有水下才有**（搜索半径内一块不在水下的都没有）；
 *   ② **这个东西很重要** —— 是矿石 / 值钱的（`valuable`，由调用方从**现成的矿表** `knowledge/ores.json`
 *      的 `value` / `tier` 判出来，不另编名单）；
 *   ③ **调用方明确说要**（`requested`，例如玩家点名让挖、带了显式参数）。
 * 其余情况一律排除。
 *
 * @param {object} p
 * @param {boolean} p.underwater        这块目标本身泡在水里
 * @param {boolean} p.drySameCount      搜索半径内**不在水下**的同种方块有几块
 * @param {boolean} p.valuable          是不是矿石 / 值钱的（看矿表的 value/tier）
 * @param {boolean} p.requested         调用方明确要挖水下的
 * @returns {{keep:boolean, why:string}}
 */
function underwaterKeep ({ underwater = false, drySameCount = 0, valuable = false, requested = false } = {}) {
  if (!underwater) return { keep: true, why: '不在水下' };
  if (requested) return { keep: true, why: '调用方明确要挖水下的' };
  // 主人原话是"除非只在水里**或者**很重要"：值钱的不看附近有没有干的（2026-09-29 Claude 复核时按原话改序）
  if (valuable) return { keep: true, why: '值钱的东西（矿表里记着价值），水下的也挖' };
  if (drySameCount > 0) return { keep: false, why: `附近有 ${drySameCount} 块不在水下的同种，先挖干的` };
  return { keep: true, why: '只有水下才有' };
}

/**
 * 头顶这一列往上一路到水面，是不是**都是水/空气**，并且**顶上（水面之上）是空气**。
 * 是 → 照旧往上游就能换到气；不是 → 跳多少下都上不去（沙子塌下来 / 坑顶有方块 / 在悬垂下面）。
 *
 * @param {Array<{dy:number, name:string, props?:object}>} cells 这一列从**脚底往上**的格子（dy=0 是脚底）
 * @param {number} maxUp 最多往上看到多少格（`CFG.breathe.upScan`）
 * @returns {{clear:boolean, at:number|null, blocker:object|null}}
 */
function columnClear (cells = [], maxUp = 24) {
  let sawWater = false;
  for (let dy = 1; dy <= maxUp; dy++) {
    const c = cells.find(x => x.dy === dy);
    if (!c) return { clear: false, at: dy, blocker: null };   // 读不到 → 不猜"能上去"
    const water = blocksWater(c.name, c.props);
    if (water) { sawWater = true; continue; }
    // 第一次遇到非水：它必须**是空气**（水面之上的出口格），且下面是水
    const air = /^(air|cave_air|void_air)$/.test(String(c.name || ''));
    if (air && (sawWater || dy === 1)) return { clear: true, at: dy, blocker: null };
    return { clear: false, at: dy, blocker: { dy, name: c.name } };
  }
  // ⚠️ 一路看到 `maxUp` 格**全是水**就停下了 —— 那不是"上不去"，是"水面还在更上面"。
  //    往下潜几格再上浮是常态（那天沙在水面下 1~5 格），把这种情况判成"头顶被盖住"
  //    会让她不去跳、转而去挖，正好反了。所以**全是水 = 通**（往上跳就能到今天没看到的出口）。
  if (sawWater) return { clear: true, at: maxUp, blocker: null };
  return { clear: false, at: null, blocker: null };
}

/**
 * 憋气：先看清头顶再决定往哪走（第 3 条。主人：「头上有方块，他没有尝试向无方块的地方移动。
 * 他不是知道哪里有什么方块吗？」）。
 *
 * 她**知道周围每一格是什么**，所以不许原地瞎跳：
 *   · `up`   —— 脚下这一列往上一路是水/空气、顶上是空气 → 照旧往上游（现有 `POST /jump`）；
 *   · `swim` —— 旁边（水平 `radius` 格内）有最近的一列通到水面 → 游过去再上浮；
 *              也可以直接给最近的能站的岸（`pickShore`）；
 *   · `dig`  —— 四周都找不到出口，才把头顶挡住的方块挖掉（调用方负责只挖沙子/砂砾/泥土这类，
 *               且 `place.js` 的 `DEADLY` 不含 —— 会放岩浆/危险东西进来的不挖）。
 *
 * 选目标按「游过去要多久 vs 还剩多少气」：气不够远的就选近的；近的也不够 → 返回 `dig`（最近的一手）。
 * `oxygenLeftMs` 由调用方按读数算（1 点气 ≈ 1 秒 1000ms；读不到时给一个保守值）。
 *
 * @param {Array<{dx:number, dz:number, clear:boolean, dist:number, swimMs:number, kind:'column'|'shore'}>} cells
 * @param {object} cfg `CFG.breathe`
 * @returns {{how:'up'|'swim'|'dig', target?:object, why:string}}
 */
function breathPlan ({ self = null, selfClear = false, cells = [], oxygenLeftMs = null } = {}, cfg = CFG.breathe) {
  if (selfClear) return { how: 'up', why: '头顶一路通到水面，直接往上跳' };
  const ok = cells.filter(c => c.clear && c.kind !== 'blocked');
  if (ok.length) {
    const budget = oxygenLeftMs == null ? null : oxygenLeftMs;
    const afford = (c) => budget == null || (c.swimMs ?? 0) <= Math.max(0, budget * cfg.swimBudgetRatio);
    const near = ok.filter(afford).sort((a, b) => (a.dist - b.dist) || ((a.swimMs ?? 0) - (b.swimMs ?? 0)));
    if (near.length) return { how: 'swim', target: near[0], why: `头顶被挡，旁边 ${near[0].dist.toFixed(1)} 格有通到水面的地方，游过去` };
    return { how: 'dig', why: `旁边有出口但都在 ${budget == null ? '?' : Math.round(budget / 1000)} 秒的气以外，来不及游` };
  }
  return { how: 'dig', why: '四周都找不到通到水面的地方，只能挖头顶' };
}

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
    && !blocksWater(c.feet) && !blocksWater(c.head));
  if (!ok.length || !self) return null;
  const cost = (c) => Math.hypot(c.pos.x + 0.5 - self.x, c.pos.z + 0.5 - self.z) + Math.max(0, c.pos.y - self.y) * 2;
  return ok.sort((a, b) => cost(a) - cost(b))[0];
}

/**
 * 「从这个高度摔到这上面，原版会扣几点血」—— **伤害模型只此一处**。
 *
 * 2026-09-29 实机修的根因：老的 `mlgStep` 只看"落差 > 3.5 格"，于是她从 **5 格**高掉下来
 * 就倒水（主人："為什麼他在把家裡放了水？"）。原版摔落伤害是 `落差 − 3`：
 * 5 格 = 2 点 = 1 颗心，根本不值得倒水。
 *
 * 规则（原版 1.20.1）：
 *   · `落差 ≤ 3` → 0（少 3 格不摔）；
 *   · 落点是**不该摔伤的方块** → 0（水 / 干草块 / 黏液块 / 蜂蜜块 / 粉雪 / 蜘蛛网，
 *     以及任何带 `fall_damage_resetting` 标签的方块 —— 由调用方传 `landSafe` 说明）；
 *   · `缓降（SlowFalling）` → 0；`摔落保护（FeatherFalling）` 每级减 `落差 × 12%`。
 *
 * ⚠️ 估算用**原始落差**，不减去落点判定的那 3 格 —— 保守一点（宁可倒水，不要摔死）。
 *
 * @param c.startY  这次离地后到过的最高点
 * @param c.landY   落点顶面高度（null = 读不到，调用方已经挡掉）
 * @param c.landName 落点方块名（可省；给了才能判"不摔伤"）
 * @param c.landSafe 调用方从标签判出来"这块不摔伤"（`fall_damage_resetting`）
 * @param c.effects 效果名数组（可省）；大小写/下划线不敏感
 * @returns {{ dmg:number, fall:number, why:string }}
 */
function mlgFallDamage ({ startY, landY, landName = null, landSafe = false, effects = [] } = {}) {
  if (startY == null || landY == null) return { dmg: 0, fall: 0, why: '不知道落差（读不到落点），当不摔伤' };
  const fall = startY - landY;
  if (fall <= 3) return { dmg: 0, fall, why: `落差 ${fall.toFixed(1)} 格，原版少 3 格不摔` };
  if (landSafe) return { dmg: 0, fall, why: `落点是${landName ? bareOfName(landName) : '不该摔伤的方块'}，不摔伤` };
  if (NOT_FALL_HURT.test(String(landName || ''))) {
    return { dmg: 0, fall, why: `落点是${bareOfName(landName)}，不摔伤` };
  }
  const eff = Array.isArray(effects) ? effects : [];
  if (eff.some(n => /slow[_ -]?fall/i.test(String(n)))) return { dmg: 0, fall, why: '有缓降效果，不摔伤' };
  let dmg = fall - 3;
  const ff = eff.find(n => /feather[_ -]?fall/i.test(String(n)));
  if (ff) {
    const lv = effectLevel(ff) || 1;
    dmg = Math.max(0, dmg - fall * 0.12 * lv);
    return { dmg, fall, why: `落差 ${fall.toFixed(1)} 格、有摔落保护 ${lv} 级，估扣 ${dmg.toFixed(1)} 点` };
  }
  return { dmg, fall, why: `落差 ${fall.toFixed(1)} 格，原版扣 ${dmg.toFixed(1)} 点（${fall.toFixed(1)} − 3）` };
}

/** 落点长这样就不摔伤（水另有 `blocksWater` 判，这里只列固体） */
const NOT_FALL_HURT = /(^|:)(hay_block|slime_block|honey_block|powder_snow|cobweb|sweet_berry_bush|vine|scaffolding|bed)$/;
const bareOfName = (n) => String(n || '').replace(/^.*:/, '');
/** 从效果名里抠等级（`FeatherFalling` 无等级 = 1；`feather_falling_2` 这种模组写法也认） */
function effectLevel (name) {
  const m = String(name || '').match(/(\d+)\s*$/);
  return m ? +m[1] : 1;
}

/**
 * 这一摔**该不该倒水**（阈值只此一处，理由在 `CFG.mlg` 的注释里）。
 *
 *   · 家**外**：预估伤害 ≥ 血量的一半，**或** ≥ `hurtAt`(6) 点 → 倒；
 *   · 家**里**：默认不倒（倒进屋里收不回来会留一滩水），只有"这一下会摔死"（伤害 ≥ 当前血量）才倒。
 *
 * 主人 2026-09-29 定的（选 A）：家外按"≥ 血量一半 或 ≥ 6"，家里只在会摔死时倒。
 *
 * @param c.startY / c.landY / c.landName / c.landSafe / c.effects  见 `mlgFallDamage`
 * @param c.hp       当前血量（读不到时调用方给默认 20）
 * @param c.inHome   在不在家的范围里（`inHome()` 的结果；null/undefined 当"不知道"= 按家外算）
 * @returns {{ place:boolean, dmg:number, why:string, est:object }}
 */
function mlgShouldPlace (c = {}, cfg = CFG.mlg) {
  const est = mlgFallDamage(c);
  if (!(est.dmg > 0)) return { place: false, dmg: est.dmg, why: est.why, est };
  const hp = Number.isFinite(c.hp) ? c.hp : 20;
  const inHome = c.inHome === true;
  if (inHome) {
    if (cfg.homeLethalOnly !== false && est.dmg < hp) {
      return { place: false, dmg: est.dmg, why: `在家里（估扣 ${est.dmg.toFixed(1)} 点、还有 ${hp} 血，摔不死）不倒水 —— 倒了收不回来会留一滩水`, est };
    }
    return { place: true, dmg: est.dmg, why: `在家里但这一下会摔死（估扣 ${est.dmg.toFixed(1)} ≥ 血 ${hp}），保命要紧`, est };
  }
  const half = hp * (cfg.hpRatio ?? 0.5);
  if (est.dmg >= half || est.dmg >= cfg.hurtAt) {
    return { place: true, dmg: est.dmg, why: `${est.why}，够疼（≥ 血一半 ${half.toFixed(1)} 或 ≥ ${cfg.hurtAt}），倒水`, est };
  }
  return { place: false, dmg: est.dmg, why: `${est.why}，不值得倒水（没到血一半 ${half.toFixed(1)}、也没到 ${cfg.hurtAt}）`, est };
}

/**
 * 落地水：这一拍该做什么。
 * @param c.startY 这次离地后到过的最高点；c.y 现在的脚底高度；c.vy 竖直速度（格/tick，往下是负）
 * @param c.landY  下面第一块实心方块的顶面高度（null = 下面 40 格内没有 / 读不到）；c.landIsWater 落点本来就是水
 * @param c.hasBucket / c.holding（手上是不是水桶）/ c.nether / c.placed（这次已经倒过了）
 * @param c.hp / c.inHome / c.landName / c.landSafe / c.effects  见 `mlgShouldPlace`（2026-09-29 加）
 * @returns 'equip' | 'place' | null
 */
function mlgStep (c, cfg = CFG.mlg) {
  const { startY, y, vy, landY, landIsWater = false, hasBucket, holding, nether = false, placed = false } = c;
  if (placed || !hasBucket || nether || landY == null || landIsWater || vy > -0.3) return null;
  if (startY - landY <= (cfg.minFall ?? 4.5)) return null;   // 粗筛：明显不疼的不管（真判据在下面）
  // ★ 2026-09-29：5 格那种"只掉 2 点血"的不倒（老代码只看落差 > 3.5，所以倒了）
  if (!mlgShouldPlace(c, cfg).place) return null;
  if (!holding) return 'equip';
  if (y - landY <= cfg.placeAt) return 'place';
  return null;
}

/**
 * 倒完水怎么收回来。**判据只此一处**（`core.js` 的 `collectWater` 照它跑）。
 *
 * 2026-09-29 实机：水倒在家里没收回来。真因是旧 `collectWater` **没有"走到水边"这一步** ——
 * 落地后她站在水的上面/旁边，`lookAt(水源 + 0.1)` 打出去的射线够不到水面，右键自然装不上水；
 * 而且整段被 `catch (_) {}` 吞掉，事件只能说"没收回来"，说不清为什么。
 * 正确套路是 `body/commonsense.js` 的 `fillBucket`：**先走过去（3 格内）**、再对准、再右键。
 *
 * @param c.attempts 已经试了几次
 * @param c.hasWaterBucket 现在身上有没有满的水桶（有了 = 收回来了）
 * @param c.hasEmptyBucket 有没有空桶（没有就收不了）
 * @param c.sawSource 走到的位置附近看到水源方块了吗（没看到 = 水流走了/根本不是水源）
 * @param c.nearEnough 走到水源附近了吗（`cfg.retrieveWalkNear` 以内）
 * @param c.walked 这一轮有没有成功走过去（走不过去是另一回事，要如实说）
 * @returns {{ done:boolean, act:'walk'|'aim'|'give_up', why:string }}
 */
function waterRetrievePlan (c = {}, cfg = CFG.mlg) {
  if (c.hasWaterBucket) return { done: true, act: 'give_up', why: '水已经收回来了' };
  const tries = c.attempts || 0;
  if (!c.hasEmptyBucket) return { done: true, act: 'give_up', why: '身上没有空桶，收不回来' };
  if (tries >= (cfg.retrieveRetries ?? 3)) return { done: true, act: 'give_up', why: `试了 ${tries} 次都没收回来` };
  if (!c.nearEnough) {
    // 走不过去（被墙挡住 / 水在脚下够不着）：仍然再试一次对准，但要如实说明
    return { done: false, act: 'walk', why: `还没走到水源 ${cfg.retrieveWalkNear} 格以内` };
  }
  if (!c.sawSource) return { done: true, act: 'give_up', why: '到了位置但看不到水源方块（水可能流走了，或者那不是水源）' };
  return { done: false, act: 'aim', why: `第 ${tries + 1} 次：对准水源方块右键` };
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

module.exports = { bind, blocksWater, breathPlan, columnClear, effectPlan, headInWater, mineShouldStop, mlgFallDamage, mlgShouldPlace, mlgStep, needBreath, oxygenNum, pickEat, pickRecovery, pickShore, shoreRingOffsets, underwaterKeep, waterBreathing, waterRetrievePlan };

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
    // ⚠️ 2026-09-29 改：落差默认给 20 格（真的会摔疼），因为"该不该倒"现在按**预估伤害**判
    //    （`mlgShouldPlace`），不是只看落差 > 3.5。"5 格不倒"那一类单独一节测。
    const F = (o) => mlgStep({ startY: 90, y: 75, vy: -1.2, landY: 70, hasBucket: true, holding: true, hp: 20, ...o });
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
  // ---- 2026-09-29 实机：主人"為什麼他在把家裡放了水？"（5 格高就倒水、还收不回来）------
  // 测的是**跑的那份**判据（survival.js 的实现），不另抄一份。
  ['落地水：只在该倒时倒（2026-09-29 实机修）', async (t) => {
    const { check, ns } = t;
    const { mlgFallDamage, mlgShouldPlace, mlgStep } = ns;
    const CFG_ = { hurtAt: 6, hpRatio: 0.5, homeLethalOnly: true, minFall: 4.5, placeAt: 3.0 };
    const S = (o) => mlgShouldPlace({ hp: 20, ...o }, CFG_);
    // ---- 伤害模型：原版 落差 − 3 ----
    check('★ 5 格落差 → 原版只扣 2 点', mlgFallDamage({ startY: 65, landY: 60 }).dmg, 2);
    check('落差 3 格 → 0（少 3 格不摔）', mlgFallDamage({ startY: 63, landY: 60 }).dmg, 0);
    check('落差 4 格 → 扣 1 点', mlgFallDamage({ startY: 64, landY: 60 }).dmg, 1);
    check('★ 25 格落差 → 扣 22 点', mlgFallDamage({ startY: 85, landY: 60 }).dmg, 22);
    check('理由写清了算式', /22\.0/.test(mlgFallDamage({ startY: 85, landY: 60 }).why), true);
    // ---- 落点不摔伤 ----
    check('★ 落点是干草块 → 不摔伤', mlgFallDamage({ startY: 85, landY: 60, landName: 'minecraft:hay_block' }).dmg, 0);
    check('落点是黏液块 → 不摔伤', mlgFallDamage({ startY: 85, landY: 60, landName: 'minecraft:slime_block' }).dmg, 0);
    check('★ 落点是蜘蛛网 → 不摔伤', mlgFallDamage({ startY: 85, landY: 60, landName: 'minecraft:cobweb' }).dmg, 0);
    check('落点带 fall_damage_resetting 标签（调用方说 safe）→ 不摔伤',
      mlgFallDamage({ startY: 85, landY: 60, landSafe: true }).dmg, 0);
    check('普通地面（石头）→ 照常摔', mlgFallDamage({ startY: 85, landY: 60, landName: 'minecraft:stone' }).dmg, 22);
    // ---- 效果 ----
    check('★ 有缓降（SlowFalling）→ 不摔伤', mlgFallDamage({ startY: 85, landY: 60, effects: ['SlowFalling'] }).dmg, 0);
    check('★ 摔落保护 4 级 → 大减', mlgFallDamage({ startY: 85, landY: 60, effects: ['FeatherFalling_4'] }).dmg < 22, true);
    check('效果名大小写/写法不敏感', mlgFallDamage({ startY: 85, landY: 60, effects: ['slow_falling'] }).dmg, 0);
    check('读不到落差 → 当不摔伤（不猜）', mlgFallDamage({ startY: null, landY: 60 }).dmg, 0);
    // ---- 阈值：家外 ----
    check('★★ 5 格落差、血 20 → 不倒水（实机那个 bug）', S({ startY: 65, landY: 60 }).place, false);
    check('5 格不倒的理由点明"不值得"', /不值得倒水/.test(S({ startY: 65, landY: 60 }).why), true);
    check('★★ 25 格落差、血 20 → 倒', S({ startY: 85, landY: 60 }).place, true);
    check('血 20、落差 12（扣 9）→ 倒（≥ 血一半 10 差一点，但 ≥ 6）', S({ startY: 72, landY: 60 }).place, true);
    check('血 20、落差 8（扣 5）→ 不倒（没到 10 也没到 6）', S({ startY: 68, landY: 60 }).place, false);
    check('血 6、落差 8（扣 5）→ 倒（≥ 血一半 3）', S({ hp: 6, startY: 68, landY: 60 }).place, true);
    // ---- 阈值：家里（主人 2026-09-29 选 A）----
    check('★★ 在家里、12 格（扣 9、血 20，摔不死）→ 不倒', S({ startY: 72, landY: 60, inHome: true }).place, false);
    check('家里不倒的理由点明"会留一滩水"', /留一滩水/.test(S({ startY: 72, landY: 60, inHome: true }).why), true);
    check('★★ 在家里、会摔死（扣 22 ≥ 血 20）→ 倒（保命）', S({ startY: 85, landY: 60, inHome: true }).place, true);
    check('在家里、血 30、扣 22（摔不死）→ 不倒', S({ hp: 30, startY: 85, landY: 60, inHome: true }).place, false);
    check('在家、落点不摔伤 → 不倒', S({ startY: 85, landY: 60, inHome: true, landName: 'minecraft:hay_block' }).place, false);
    // ---- 端到端：mlgStep 用上新判据 ----
    const G = (o) => mlgStep({ startY: 65, y: 62, vy: -1.2, landY: 60, hasBucket: true, holding: true, hp: 20, ...o });
    check('★★ mlgStep：5 格落差 → 不倒（实机那个 bug）', G({}), null);
    check('★★ mlgStep：25 格落差 → 到点了就倒', G({ startY: 85, y: 61.5 }), 'place');
    check('★ mlgStep：家里 12 格 → 不倒', G({ startY: 72, y: 61.5, inHome: true }), null);
    check('★ mlgStep：家里会摔死 → 倒', mlgStep({ startY: 85, y: 61.5, vy: -1.2, landY: 60, hasBucket: true, holding: true, hp: 12, inHome: true }, CFG_), 'place');
    check('★ mlgStep：落点是干草块 → 不倒', mlgStep({ startY: 85, y: 61.5, vy: -1.2, landY: 60, hasBucket: true, holding: true, hp: 20, landName: 'minecraft:hay_block' }, CFG_), null);
  }],
  // ---- 收水（2026-09-29 实机：倒了水没收回来，水留在家裡）------
  ['落地水：倒了一定要收回来', async (t) => {
    const { check, ns } = t;
    const { waterRetrievePlan } = ns;
    const CFG_ = { retrieveRetries: 3, retrieveWalkNear: 3 };
    const P = (o) => waterRetrievePlan({ hasEmptyBucket: true, ...o }, CFG_);
    check('★ 已经收回来了 → 收工', P({ hasWaterBucket: true }).done, true);
    check('…理由说清"已经收回来了"', /已经收回来/.test(P({ hasWaterBucket: true }).why), true);
    check('★ 没有空桶 → 收不了，如实说', P({ hasEmptyBucket: false }).done, true);
    check('…理由说清"没有空桶"', /没有空桶/.test(P({ hasEmptyBucket: false }).why), true);
    check('★ 没走到水源附近 → 先走过去（不是直接右键）', P({ attempts: 0, nearEnough: false }).act, 'walk');
    check('★ 走到了、看得到水源 → 对准右键', P({ attempts: 0, nearEnough: true, sawSource: true }).act, 'aim');
    check('★ 到了位置却看不到水源 → 放弃并说明（水可能流走了）', P({ attempts: 1, nearEnough: true, sawSource: false }).done, true);
    check('…理由点明"看不到水源方块"', /看不到水源方块/.test(P({ attempts: 1, nearEnough: true, sawSource: false }).why), true);
    check('★ 试到上限 → 放弃', P({ attempts: 3, nearEnough: true, sawSource: true }).done, true);
    check('…理由报出试了几次', /试了 3 次/.test(P({ attempts: 3, nearEnough: true, sawSource: true }).why), true);
    check('★ 第 2 次还在试 → 继续', P({ attempts: 2, nearEnough: true, sawSource: true }).done, false);
    check('…第几次也报出来（便于查日志）', /第 3 次/.test(P({ attempts: 2, nearEnough: true, sawSource: true }).why), true);
  }],
  // ---- 2026-09-29 实机：在水底挖沙子差点淹死 ----------------------------------
  // 测的是**跑的那份**判据（survival.js 里的实现），不另抄一份。
  ['水下惜命：/mine 该不该继续挖', async (t) => {
    const { check, ns } = t;
    const { mineShouldStop, oxygenNum } = ns;
    const CFG_ = { dryOxygenAt: 14 };
    const O = (v) => oxygenNum(v);
    check('★ 头在水里、氧气 10（低于安全线 14）→ 停', mineShouldStop({ headInWater: true, oxygen: O(10) }, CFG_).stop, true);
    check('停的理由说清"在水底、气不够"', /在水底/.test(mineShouldStop({ headInWater: true, oxygen: O(10) }, CFG_).why), true);
    check('★ 头在水里、氧气 20 → 继续挖', mineShouldStop({ headInWater: true, oxygen: O(20) }, CFG_).stop, false);
    check('氧气正好等于安全线 → 停（≤）', mineShouldStop({ headInWater: true, oxygen: O(14) }, CFG_).stop, true);
    check('★ 有水下呼吸 → 不受限', mineShouldStop({ headInWater: true, oxygen: O(2), waterBreathing: true }, CFG_).stop, false);
    check('头不在水里 → 不用管氧气', mineShouldStop({ headInWater: false, oxygen: O(1) }, CFG_).stop, false);
    check('★ 读数不可信（288）+ 头在水里 → 停（保守）', mineShouldStop({ headInWater: true, oxygen: O(288) }, CFG_).stop, true);
    check('读不到氧气 + 头在水里 → 停', mineShouldStop({ headInWater: true, oxygen: O(null) }, CFG_).stop, true);
  }],
  ['氧气读数归一（E：288 不能当真）', async (t) => {
    const { check, ns } = t;
    const { oxygenNum, needBreath } = ns;
    check('★ 正常 8 → 可信', oxygenNum(8).value, 8);
    check('正常 8 → reliable', oxygenNum(8).reliable, true);
    check('★ 正常 20（满）→ 可信', oxygenNum(20).value, 20);
    check('★ 288（模组/槽位挪了的原始 ticks）→ 读不到', oxygenNum(288).value, null);
    check('288 → reliable=false', oxygenNum(288).reliable, false);
    check('288 的理由点明"像是原始 air ticks"', /air ticks/.test(oxygenNum(288).why), true);
    check('★ -1（已经在掉血）→ 读不到', oxygenNum(-1).value, null);
    check('-1 → reliable=false', oxygenNum(-1).reliable, false);
    check('★ null → 读不到', oxygenNum(null).value, null);
    check('null → reliable=false', oxygenNum(null).reliable, false);
    check('NaN → 读不到', oxygenNum(NaN).reliable, false);
    check('字符串 → 读不到', oxygenNum('x').reliable, false);
    check('原始值仍带回去（便于查）', oxygenNum(288).raw, 288);
    // 归一后接进 needBreath：288 不该触发（旧代码 288≤8 为假所以本来也不触发，
    // 但 288 会传给 POST /jump 的 stopAtOxygen:18 让第一跳"提前成功" —— 这里锁的是**读取侧**）
    check('★ 288 归一后 needBreath 不触发（不是"氧气充足"）', needBreath({ oxygen: oxygenNum(288).value, headInWater: true }), false);
    check('★ 8 归一后 needBreath 触发', needBreath({ oxygen: oxygenNum(8).value, headInWater: true }), true);
  }],
  ['水下的东西默认不挖（第 2 条）', async (t) => {
    const { check, ns } = t;
    const { underwaterKeep } = ns;
    check('★ 氧气读不到（288→null）、头在水里刚 2 秒 → 先不急', needBreath({ oxygen: null, headInWater: true, underwaterMs: 2000 }), false);
    check('★★ 氧气读不到、头在水里泡了 9 秒 → 要换气（不能当"不用换气"）', needBreath({ oxygen: null, headInWater: true, underwaterMs: 9000 }), true);
    check('氧气读不到、头不在水里 → 不用', needBreath({ oxygen: null, headInWater: false, underwaterMs: 99999 }), false);
    check('★ 水下的、附近有干的同种 → 不挖', underwaterKeep({ underwater: true, drySameCount: 3 }).keep, false);
    check('不挖的理由说清"附近有干的"', /不在水下/.test(underwaterKeep({ underwater: true, drySameCount: 3 }).why), true);
    check('★ 只有水下才有（附近一块干的都没有）→ 允许挖', underwaterKeep({ underwater: true, drySameCount: 0 }).keep, true);
    // ⚠️ 顺序：**附近有干的就先挖干的**，哪怕水下的那块值钱 —— 主人要的是"别优先挖水里的"。
    //    值钱只在"够不到干的"时才成为理由（drySameCount = 0 那一条）。
    check('★★ 值钱、附近也有干的 → 水下的也允许（主人：只在水里「或者」很重要）', underwaterKeep({ underwater: true, drySameCount: 5, valuable: true }).keep, true);
    check('★ 水下是值钱的、附近没有干的 → 允许挖', underwaterKeep({ underwater: true, drySameCount: 0, valuable: true }).keep, true);
    check('★ 调用方明确要水下的 → 允许（哪怕附近有干的）', underwaterKeep({ underwater: true, drySameCount: 5, requested: true }).keep, true);
    check('不在水下的 → 一律允许', underwaterKeep({ underwater: false }).keep, true);
  }],
  ['憋气：先看清头顶再决定往哪走（第 3 条）', async (t) => {
    const { check, ns } = t;
    const { breathPlan, columnClear } = ns;
    const COL = (names) => names.map((n, i) => ({ dy: i + 1, name: n }));
    // ---- columnClear：头顶这一列到不到水面 ----
    check('★ 头顶一路是水、最上面是空气 → 通', columnClear(COL(['water', 'water', 'air']), 24).clear, true);
    const blocked = columnClear(COL(['water', 'sand', 'water', 'air']), 24);
    check('★ 头顶第二格就是沙子 → 不通', blocked.clear, false);
    check('不通的位置报在 dy=2', blocked.at, 2);
    check('不通时说出挡路的是什么', blocked.blocker.name, 'sand');
    check('★ 头顶就是空气（头探出水面）→ 通', columnClear(COL(['air', 'air']), 24).clear, true);
    check('★ 一路全是水（水面还在更上面）→ 也算通，照旧往上跳', columnClear(COL(['water', 'water', 'water', 'water']), 4).clear, true);
    check('读不到某一格 → 不猜"能上去"', columnClear([{ dy: 1, name: 'water' }], 3).clear, false);

    const cfg = { swimBudgetRatio: 0.5, swimMsPerBlock: 900 };
    // ---- 头顶是水 → 照旧往上跳 ----
    check('★ 头顶是水 → up（照旧跳）', breathPlan({ selfClear: true }, cfg).how, 'up');
    // ---- 头顶是沙子、旁边 2 格有一列通到水面 → 游过去（不是原地跳、也不是先挖）----
    const p = breathPlan({
      selfClear: false,
      cells: [{ dx: 2, dz: 0, clear: true, kind: 'column', dist: 2, swimMs: 1800, wx: 2, wy: 60, wz: 0 }],
      oxygenLeftMs: 8000,
    }, cfg);
    check('★ 头顶被沙子盖住、旁边 2 格有出口 → swim', p.how, 'swim');
    check('★ 游到的是那 2 格外的列（不是原地）', p.target.wx, 2);
    check('没选"先挖"（挖是最后一手）', p.how !== 'dig', true);
    // ---- 四周全封死 → 才挖头顶 ----
    check('★ 四周全封死 → dig', breathPlan({ selfClear: false, cells: [], oxygenLeftMs: 8000 }, cfg).how, 'dig');
    // ---- 气不够游到出口 → 不硬游，落回 dig ----
    check('★ 还剩 2 秒气、出口要 18 秒 → 不游，选 dig', breathPlan({
      selfClear: false, oxygenLeftMs: 2000,
      cells: [{ dx: 6, dz: 0, clear: true, kind: 'column', dist: 6, swimMs: 18000, wx: 6, wy: 60, wz: 0 }],
    }, cfg).how, 'dig');
    check('气够（8 秒，出口 1.8 秒）→ swim', breathPlan({
      selfClear: false, oxygenLeftMs: 8000,
      cells: [{ dx: 2, dz: 0, clear: true, kind: 'column', dist: 2, swimMs: 1800, wx: 2, wy: 60, wz: 0 }],
    }, cfg).how, 'swim');
    // ---- 两个出口：气只够近的那个，就选近的 ----
    check('★ 气只够近的 → 选近的（远的够不到就别去）', breathPlan({
      selfClear: false, oxygenLeftMs: 3000,
      cells: [
        { dx: 1, dz: 0, clear: true, kind: 'column', dist: 1, swimMs: 900, wx: 1, wy: 60, wz: 0 },
        { dx: 5, dz: 0, clear: true, kind: 'column', dist: 5, swimMs: 4500, wx: 5, wy: 60, wz: 0 },
      ],
    }, cfg).target.wx, 1);
  }],
  ['水里判据只有一份（水方块 / 头在水里 / 水下呼吸）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { blocksWater, waterBreathing } = ns;
    check('★ water / flowing_water / bubble_column 都算水', [blocksWater('water'), blocksWater('flowing_water')].every(Boolean), true);
    check('气泡柱也算水', blocksWater('bubble_column'), true);
    check('★ 模组水（命名空间）也算', blocksWater('upgrade_aquatic:water'), true);
    check('★ waterlogged 的方块（半砖/楼梯）头在里面也在水里', blocksWater('oak_slab', { waterlogged: true }), true);
    check('没 waterlogged 的半砖不算', blocksWater('oak_slab', {}), false);
    check('石头不算水', blocksWater('stone'), false);
    check('沙子不算水', blocksWater('sand'), false);
    check('岩浆不算水', blocksWater('lava'), false);
    check('读不到方块名 → 不猜', blocksWater(null), false);
    check('★ 水下呼吸效果认（大小写/写法不敏感）', [waterBreathing(['WaterBreathing']), waterBreathing(['water_breathing'])].every(Boolean), true);
    check('没有水下呼吸效果 → false', waterBreathing(['Speed']), false);
    check('读不到效果 → false', waterBreathing(null), false);
    // ---- 源码形状锁：判据真的只写一处 ----
    const srcText = instinctSrc();
    // ⚠️ 只看**代码里的用法**（`.test(...)`），不看注释 —— 这段说明本身就写着那个字样。
    check('★ "水方块"的判据只在 survival.js 的 blocksWater 里（不再有手写的 /water|bubble_column/.test）',
      !/\/water\|bubble_column\/\s*\.test\(/.test(srcText.replace(/\/\*[\s\S]*?\*\//g, '')), true);    check('★ 头在不在水里只有真身一份（core.js 只留转发壳）',
      (srcText.match(/function headInWater \(bot\)/g) || []).length, 1);
    check('★ 憋气真的用了 breathPlan（不再是"直接跳"）', /breathEscapePlan\(bot, I, B\)/.test(srcText), true);
    check('★ 挖开会放危险东西的不挖（用了 place.js 的 DEADLY）', /placeLogic\.DEADLY\.test/.test(srcText), true);
  }],
];
register('survival', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('survival', __sections);
}
