'use strict';

/**
 * 她的心愿：做遍这个整合包里所有的食物。
 *
 * ## 为什么是这个
 *
 * 这是个"食旅"整合包：任务书里有一整组《食录逸闻》（20 章、2390 种食物），是作者亲手整理的食物图鉴；
 * 还有"次元之胃"—— 每种新食物都给属性。一个在这里生活的人，自然会想把它们都做出来、尝一遍。
 *
 * 有了这个，她闲下来时就**有自己想做的事**：挑一道菜，研究食材从哪来、要什么工作站，
 * 然后去采、去种、去做。做成了打勾，下一道菜可能就用得上这次学会的东西。
 *
 * ## 这里只提供"看得见的进度和可能性"，不替她做决定
 *
 *   catalog()       清单（按章节）
 *   progress()      做出了多少、每章多少
 *   candidates(ctx) 现在最有希望做成的几道（缺几样原料、要的工作站她见过没有）
 *   noteGained()    她手上多了某种食物 → 按来源打勾（made / collected）
 *
 * 进度存在 memory-store 里（和她的其他记忆放在一起）。
 */

const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge');
const mem = require('./memory-store');

let CAT = null;

/** 《食录逸闻》里每一种要提交的食物 */
function catalog () {
  if (CAT) return CAT;
  const q = JSON.parse(fs.readFileSync(path.join(__dirname, 'knowledge', 'quests.json'), 'utf8'));
  const items = new Map();   // id → {id, chapter, quest}
  const chapters = [];
  for (const c of q.chapters || []) {
    if (c.groupTitle !== '食录逸闻') continue;
    const ids = [];
    for (const qq of c.quests || []) {
      for (const t of qq.tasks || []) {
        if (t.type !== 'item' || !t.item || items.has(t.item)) continue;
        // 任务书里的名字带游戏颜色代码（§e…），去掉；有 311 道菜任务书没给中文名（itemZh 就是物品 id）—— 从名字表补
        let zh = t.itemZh ? t.itemZh.replace(/§./g, '').trim() : null;
        if (!zh || zh === t.item || /^[a-z0-9_]+:[a-z0-9_/]+$/.test(zh) || zh.includes('%')) {   // "烤%1$s" 这种带格式占位符的也不算名字
          const n = knowledge.label(t.item).replace(/\([^)]*\)$/, '');
          zh = n && n !== t.item && !n.includes('%') ? n : null;   // "%1$s" 这种是格式占位符，不是名字
        }
        items.set(t.item, { id: t.item, chapter: c.title, quest: qq.title, zh });
        ids.push(t.item);
      }
    }
    chapters.push({ title: c.title, ids });
  }
  // 「机械动力」任务分组里也有食物（红酒、蜂蜜酒、豆腐、米饭…）—— 主人定了也算进心愿（2026-09-26）。
  // 那个分组大部分是机器和材料，只收"是烹饪类工作站的产物、或带食物标签"的，桶一律不算（岩浆桶是 create:mixing 做的，但不是吃的）
  const K = knowledge.load();
  const FOOD_STATION = /^(farmersdelight:cooking|create_central_kitchen:|kaleidoscope_cookery:|kaleidoscope_tea:|vinery:|cosmopolitan:tub_extracting)/;
  const foodTagged = (id) => [...(K.itemTags.get(id) || [])].some(t => /(^|[:/])(foods?|meals?|drinks?)(\/|$)/.test(t));
  const cooked = (id) => (K.byOutput.get(id) || []).some(i => FOOD_STATION.test(K.recipes[i].type));
  for (const c of q.chapters || []) {
    if (c.groupTitle !== '机械动力') continue;
    const ids = [];
    for (const qq of c.quests || []) {
      for (const t of qq.tasks || []) {
        if (t.type !== 'item' || !t.item || items.has(t.item) || /bucket$/.test(t.item)) continue;
        if (!cooked(t.item) && !foodTagged(t.item)) continue;
        const n = knowledge.label(t.item).replace(/\([^)]*\)$/, '');
        items.set(t.item, { id: t.item, chapter: `机械动力·${c.title}`, quest: qq.title, zh: n && n !== t.item ? n : null });
        ids.push(t.item);
      }
    }
    if (ids.length) chapters.push({ title: `机械动力·${c.title}`, ids });
  }
  CAT = { items, chapters };
  return CAT;
}

function state () {
  const S = mem.load();
  S.ambition ||= { made: {}, collected: {}, tasted: {}, tries: {} };
  return S.ambition;
}

function isFood (id) { return catalog().items.has(id); }

/**
 * 手上多了某种食物。how：made（她亲手做的）/ collected（别人给的、捡的）/ tasted（吃了）
 * @returns {null | {first:boolean, id, chapter}} 第一次做成时返回，给意识流一个"做成了！"的时刻
 */
function noteGained (id, how = 'made') {
  if (!isFood(id)) return null;
  const A = state();
  const bucket = A[how] || (A[how] = {});
  const first = !bucket[id];
  if (first) { bucket[id] = Date.now(); mem.touch(); }
  return first ? { first, id, chapter: catalog().items.get(id).chapter } : null;
}

function noteTry (id, ok, why) {
  const A = state();
  const t = A.tries[id] ||= { n: 0, fails: 0 };
  t.n++; if (!ok) { t.fails++; t.lastFail = String(why || '').slice(0, 120); }
  t.last = Date.now();
  mem.touch();
}

function progress () {
  const { chapters, items } = catalog();
  const A = state();
  const made = Object.keys(A.made).filter(id => items.has(id));
  return {
    total: items.size,
    made: made.length,
    collected: Object.keys(A.collected).filter(id => items.has(id) && !A.made[id]).length,
    tasted: Object.keys(A.tasted).filter(id => items.has(id)).length,
    byChapter: chapters.map(c => ({ title: c.title, total: c.ids.length, made: c.ids.filter(id => A.made[id]).length })),
    recent: made.sort((a, b) => A.made[b] - A.made[a]).slice(0, 5),
  };
}

// ------------------------------------------------------------------ 候选

const VANILLA_STATIONS = new Set(['inventory', 'minecraft:crafting_table', 'minecraft:furnace', 'minecraft:smoker', 'minecraft:campfire']);

/**
 * 现在最有希望做成的几道菜。
 * ctx.inventory：背包；ctx.knownStations：她见过（记得在哪）的工作站 id 集合
 *
 * 评分只看"离做成还有多远"：缺几样原材料、要的工作站见没见过、原材料是不是挖/打/种得到。
 * 同样远的，优先她之前试过但没做成的（人会惦记没做成的事）—— 但失败太多次的往后放。
 */
// ---- 路线图（modpack-study 算好的：每道菜的档位、步数、原材料；scripts/import-route.js 导入）
let ROUTE = null;
function route () {
  if (ROUTE) return ROUTE;
  try { ROUTE = JSON.parse(fs.readFileSync(path.join(__dirname, 'knowledge', 'route.json'), 'utf8')); } catch (_) { ROUTE = { dishes: {}, rawUse: {} }; }
  return ROUTE;
}
// 档位代价：T0 徒手/工作台 < T1 原版炉子 < T2 农夫乐事系 < T3 别的模组工作站 < C 只能靠机械动力 < T4 跨维度/Boss
const TIER_COST = { T0: 0, T1: 2, T2: 4, T3: 7, C: 10, T4: 12 };
const TIER_ZH = { T0: '徒手或工作台', T1: '原版炉子', T2: '农夫乐事那套', T3: '别的模组工作站', C: '机械动力', T4: '要去别的维度或打 Boss' };

/** 一样原材料从哪来，说人话（挖 / 打 / 钓 / 右键…） */
function rawHow (id) {
  const K = knowledge.load();
  const d = K.drops.get(id) || [];
  const act = d.find(x => x.from === 'interact'); if (act) return act.how;
  const self = d.find(x => x.from === 'block' && x.id === id); if (self) return '直接挖';
  const blk = d.find(x => x.from === 'block'); if (blk) return `挖${knowledge.label(blk.id).replace(/\([^)]*\)$/, '')}`;
  const ent = d.find(x => x.from === 'entity'); if (ent) return `打${knowledge.label(ent.id).replace(/\([^)]*\)$/, '')}`;
  if (d.some(x => x.from === 'fishing')) return '钓鱼';
  if (d.some(x => x.from === 'chest')) return '结构箱子里翻';
  return K.byOutput.has(id) ? '要先做' : '不知道哪来';
}

function candidates ({ inventory = [], knownStations = new Set(), limit = 5, chapter = null, allowCreate = false } = {}) {
  const R = route();
  const K = knowledge.load();
  const A = state();
  const { items } = catalog();
  const invIds = new Set(inventory.map(i => (i.name.includes(':') ? i.name : `minecraft:${i.name}`)));
  const out = [];
  for (const [id, meta] of items) {
    if (A.made[id]) continue;
    if (chapter && meta.chapter !== chapter) continue;
    const rs = (K.byOutput.get(id) || []).map(i => K.recipes[i]);
    if (!rs.length) continue;   // 做不出来的（只能打/找）不算"做"的心愿候选
    let best = null;
    for (const r of rs) {
      if (!r.in.length) continue;   // 原料没解析出来的配方（格式特殊），别当成"材料都有了"
      // 拆包配方（一个箱子/方块拆出 9 个）不是"做菜"
      if (r.in.length === 1 && r.out.some(o => o.item === id && o.count >= 4)) continue;
      const st = r.station || knowledge.stationOf(r).id || null;
      const vanilla = !st || VANILLA_STATIONS.has(st);
      const stationOk = vanilla || knownStations.has(st);
      let missing = 0; const need = [];
      for (const s of r.in) {
        const have = s.alts.some(a => (a.item ? invIds.has(a.item) : [...invIds].some(x => K.tags.get(`item:${a.tag}`)?.has(x))));
        if (have) continue;
        missing++;
        const alt = s.alts[0];
        const aid = alt.item || [...(K.tags.get(`item:${alt.tag}`) || [])][0];
        const drops = aid ? (K.drops.get(aid) || []) : [];
        const gatherable = drops.some(d => d.from === 'block' || d.from === 'entity' || d.from === 'fishing');
        need.push({ id: aid, tag: alt.tag, gatherable, craftable: aid ? K.byOutput.has(aid) : false });
      }
      const hard = need.filter(n => !n.gatherable && !n.craftable).length;
      // 原版工作站（背包/工作台/熔炉/烟熏炉/营火）谁都有，排前面；没见过的模组工作站排后面
      const score = missing * 2 + hard * 4 + (stationOk ? 0 : 6) + (vanilla ? 0 : 1) + r.in.length * 0.3;
      if (!best || score < best.score) best = { score, r, missing, need, stationOk, st };
    }
    if (!best) continue;
    // 路线图：做不出来（X）、要装没装的模组（M）的不当候选；只能靠机械动力的（C）她学会操作机器之前也先不当
    const rt = R.dishes[id];
    if (rt) {
      if (rt.tier === 'X' || rt.tier === 'M' || (rt.tier === 'C' && !allowCreate)) continue;
      best.tier = rt.tier; best.depth = rt.depth; best.raw = rt.raw;
      best.score += (TIER_COST[rt.tier] ?? 6) + (+rt.depth || 0) * 1.2;
      // 用的原材料很多菜都要（小麦、牛奶…）：先把它弄到手，后面好多菜都顺了 —— 小小加分
      const share = rt.raw.length ? rt.raw.reduce((a, x) => a + (R.rawUse[x.id] || 0), 0) / rt.raw.length : 0;
      best.score -= Math.min(3, Math.log2(1 + share / 50));
    }
    // 她亲手做成过"X → 这道菜"：经验比书可信（书上的配方在这个包里常有冲突）
    const exp = mem.load().memories.find(m => m.kind === 'relation' && m.o === id && m.source === 'experience' && m.status !== 'stale');
    if (exp) { best.score -= 6; best.byExperience = exp.text; }
    const t = A.tries[id];
    const tryAdj = t ? (t.fails >= 3 ? 5 : -1) : 0;
    out.push({ id, meta, ...best, score: best.score + tryAdj });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}

function renderCandidates (cands) {
  return cands.map(c => {
    const where = c.r.station === 'inventory' ? '背包里' : c.st ? knowledge.label(c.st) : c.r.type;
    const needs = c.need.length
      ? `还缺 ${c.need.slice(0, 4).map(n => `${n.id ? knowledge.label(n.id) : `#${n.tag}`}${n.gatherable ? '' : n.craftable ? '(要先做)' : '(不好弄)'}`).join('、')}`
      : '材料都有了！';
    const t = state().tries[c.id];
    const tier = c.tier ? `（${TIER_ZH[c.tier] || c.tier}${c.depth ? `，${c.depth} 步` : ''}）` : '';
    // 缺的东西从哪来：她自己去弄，还是跟他要
    const from = c.need.length && c.raw ? `；原材料：${c.raw.slice(0, 4).map(x => `${knowledge.label(x.id).replace(/\([^)]*\)$/, '')}（${rawHow(x.id)}）`).join('、')}` : '';
    if (c.byExperience) return `· ${knowledge.label(c.id)}〔${c.meta.chapter}〕你做过：${c.byExperience}`;
    return `· ${knowledge.label(c.id)}〔${c.meta.chapter}〕${tier}在${where}${c.stationOk ? '' : '(这个工作站还没见过)'}，${needs}${from}${t ? `（试过 ${t.n} 次${t.lastFail ? `，上次卡在：${t.lastFail}` : ''}）` : ''}`;
  }).join('\n');
}

/** 给意识流看的一段：心愿、进度、可以试的 */
function summary (ctx = {}) {
  const p = progress();
  const A = state();
  const lines = [`你的心愿：做遍《食录逸闻》里的 ${p.total} 种食物。已经亲手做出 ${p.made} 种${p.collected ? `，收集到 ${p.collected} 种` : ''}${p.tasted ? `，尝过 ${p.tasted} 种` : ''}。`];
  if (p.recent.length) lines.push(`最近做成的：${p.recent.map(id => knowledge.label(id)).join('、')}`);
  if (A.focus) lines.push(`正在研究：${knowledge.label(A.focus)}`);
  const c = candidates({ ...ctx, limit: 5 });
  if (c.length) lines.push(`现在看起来最有希望的：\n${renderCandidates(c)}`);
  return lines.join('\n');
}

function setFocus (name) {
  const id = knowledge.resolve(name, 1)[0];
  if (!id) throw new Error(`不认识 ${name}`);
  const A = state();
  A.focus = id;
  mem.touch();
  return { focus: id, label: knowledge.label(id), inCatalog: isFood(id), chapter: catalog().items.get(id)?.chapter || null };
}

function selftest () {
  let pass = 0; let total = 0;
  const check = (l, c, d) => { total++; if (c) pass++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  ${JSON.stringify(d)}`}`); };
  process.env.MC_MIND_FILE = path.join(require('os').tmpdir(), `amb-${process.pid}.json`);
  mem._reset();
  const { items, chapters } = catalog();
  console.log(`\n清单：${items.size} 种，${chapters.length} 章`);
  check('清单来自《食录逸闻》（2000+ 种）', items.size > 2000);
  const egg = [...items.keys()].find(id => /fried_egg/.test(id));
  check('煎蛋在清单里', !!egg, egg);
  const first = noteGained(egg, 'made');
  check('第一次做成 → 返回"第一次"', first && first.first === true);
  check('再做一次不算第一次', noteGained(egg, 'made') === null);
  check('进度 +1', progress().made === 1);
  const c = candidates({ inventory: [{ name: 'egg', count: 7 }, { name: 'bread', count: 2 }], knownStations: new Set(['farmersdelight:cooking_pot']) });
  check('有候选', c.length === 5, c.map(x => x.id));
  check('做过的不再当候选', !c.some(x => x.id === egg));
  const many = candidates({ limit: 400 });
  const bad = many.filter(x => ['X', 'M', 'C'].includes(route().dishes[x.id]?.tier));
  check('路线图里做不出来 / 要装没装的模组 / 只能靠机械动力的不当候选', bad.length === 0, bad.slice(0, 3).map(x => x.id));
  check('候选按档位从易到难（前 5 个都不是 T4）', many.slice(0, 5).every(x => x.tier !== 'T4'), many.slice(0, 5).map(x => x.tier));
  console.log(summary({ inventory: [{ name: 'egg', count: 7 }] }).split('\n').slice(0, 8).join('\n'));
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { catalog, isFood, noteGained, noteTry, progress, candidates, renderCandidates, summary, setFocus, state };
