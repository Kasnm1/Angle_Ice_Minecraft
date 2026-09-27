'use strict';

/**
 * 她的长期计划（主人 2026-09-27）：没人找她的时候，自己根据现在的状况推进游戏。
 *
 * ## 为什么要有（field-log P48）
 *
 * 以前她闲下来只有"心愿"（做遍食物）一条线；游戏本身的进展（工具、护甲、家、农田…）没人管 ——
 * 实测背包里 21 个泥土、一件工具都没有，系统却觉得"不缺材料"，于是什么都不做。
 *
 * ## 分工：这里只给"事实"和"可能性"，不替她排顺序（主人："她每次自己定就行"）
 *
 *   facts(ctx)      现在到哪一步了（最好的镐/剑/斧/护甲、有没有家/床、吃的/火把/搭脚方块够不够…）
 *   ideas(facts)    接下来**可以**做的几件事（各带"做成的标志"），她自己挑、自己排
 *   计划            她自己写的：一个目标 + 几步，每步可以带"做成的标志"（done: { have: { 物品: 数量 } }）
 *   autoCheck()     每看一眼就核对：标志达成的步骤自动打勾 → mind 告诉她、让她想下一步（"思考自动更新计划"）
 *   current()       正在做的那一步 —— 闲着的时候接着做它（主人："闲着的时候也可以继续当前任务"）
 *
 * 存在 memory/plan.json（MC_PLAN_FILE 可改；自测用临时文件）。不进 memory-store：那边是她的人际/经历记忆。
 */

const fs = require('fs');
const path = require('path');

const FILE = () => process.env.MC_PLAN_FILE || path.join(__dirname, 'memory', 'plan.json');
let P = null;

function load () {
  if (P) return P;
  try { P = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (_) { P = null; }
  if (!P || typeof P !== 'object') P = { plan: null, history: [] };
  P.history ||= [];
  return P;
}
function save () {
  if (!P) return;
  const f = FILE();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(P, null, 1));
    fs.renameSync(`${f}.tmp`, f);
  } catch (_) {}
}
const note = (text) => { load().history.push({ t: Date.now(), text }); if (P.history.length > 30) P.history.shift(); };

// ------------------------------------------------------------------ 事实

const bare = (n) => String(n || '').replace(/^.*:/, '');
const TIER_ORDER = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
const TIER_ZH = { wooden: '木', stone: '石', golden: '金', iron: '铁', diamond: '钻石', netherite: '下界合金' };
function bestTier (names, re) {
  let best = null;
  for (const n of names) {
    const b = bare(n);
    if (!re.test(b)) continue;
    const t = TIER_ORDER.find(x => b.startsWith(`${x}_`));
    const r = t ? TIER_ORDER.indexOf(t) : 1;   // 认不出材质的模组工具按石级
    if (!best || r > best.rank) best = { rank: r, name: b, tier: t || 'modded' };
  }
  return best;
}

/**
 * @param ctx.items     背包 [{ name, count }]
 * @param ctx.worn      穿着的 [名字]（头/身/腿/脚/副手）
 * @param ctx.homeItems 家里箱子里记得的 [{ name, count }]
 * @param ctx.hasHome / ctx.foodCount（吃的有几个，mind 那边按 knowledge 数）
 */
function facts ({ items = [], worn = [], homeItems = [], hasHome = false, foodCount = null } = {}) {
  const all = [...items, ...worn.filter(Boolean).map(name => ({ name, count: 1 }))];
  const names = all.map(i => i.name);
  const count = (re) => all.filter(i => re.test(bare(i.name))).reduce((a, i) => a + (i.count || 1), 0);
  const homeCount = (re) => homeItems.filter(i => re.test(bare(i.name))).reduce((a, i) => a + (i.count || 1), 0);
  const pick = bestTier(names, /pickaxe$/);
  const sword = bestTier(names, /sword$/);
  const axe = bestTier(names, /(^|_)axe$/);
  const armor = ['helmet', 'chestplate', 'leggings', 'boots'].map(p => bestTier(worn.filter(Boolean), new RegExp(`${p}$`)));
  return {
    pick, sword, axe,
    armorPieces: armor.filter(Boolean).length,
    armorTier: armor.filter(Boolean).reduce((m, a) => Math.min(m, a.rank), 9) === 9 ? null : TIER_ORDER[armor.filter(Boolean).reduce((m, a) => Math.min(m, a.rank), 9)],
    shield: names.some(n => /shield/.test(bare(n))),
    hasHome,
    bed: count(/(^|_)bed$/) + homeCount(/(^|_)bed$/) > 0,
    food: foodCount,
    torches: count(/^torch$/),
    logs: count(/_log$|_stem$/),
    planks: count(/_planks$/),
    cobble: count(/^(cobblestone|cobbled_deepslate)$/),
    coal: count(/^(coal|charcoal)$/),
    ironIngots: count(/^iron_ingot$/), rawIron: count(/^raw_iron$/),
    diamonds: count(/^diamond$/),
    waterBucket: count(/^water_bucket$/) > 0,
    furnace: count(/^furnace$/) + homeCount(/^furnace$/) > 0,
    craftingTable: count(/^crafting_table$/) + homeCount(/^crafting_table$/) > 0,
    seeds: count(/seeds?$/),
  };
}

/** 一句话的现状（给她看） */
function renderFacts (f) {
  const t = (x) => (x ? `${TIER_ZH[x.tier] || '模组'}${x.name.replace(/^(wooden|stone|golden|iron|diamond|netherite)_/, '').replace(/pickaxe$/, '镐').replace(/sword$/, '剑').replace(/_?axe$/, '斧')}` : '没有');
  return `镐：${t(f.pick)}｜剑：${t(f.sword)}｜斧：${t(f.axe)}｜护甲：${f.armorPieces ? `${f.armorPieces} 件（最差是${TIER_ZH[f.armorTier] || '模组'}的）` : '没穿'}${f.shield ? '｜有盾' : ''}`
    + `｜家：${f.hasHome ? '有' : '还没有'}${f.bed ? '、有床' : ''}｜吃的：${f.food ?? '?'}｜火把：${f.torches}｜水桶：${f.waterBucket ? '有' : '没有'}`;
}

/**
 * 接下来可以做什么（不排顺序，她自己挑）。每条带 done（做成的标志），她可以直接抄进计划。
 * 只列"还没做到"的；太远的（比如没铁镐就想钻石镐）不列 —— 列出来也是空想。
 */
function ideas (f) {
  const out = [];
  const add = (text, why, done) => out.push({ text, why, done });
  const pr = f.pick?.rank ?? -1;
  if (!f.craftingTable && f.logs + f.planks === 0) add('砍几棵树（原木）', '什么都要从木头开始', { have: { log: 8 } });
  if (!f.craftingTable) add('做个工作台', '做工具要用', { have: { crafting_table: 1 } });
  if (pr < 0) add('做木镐', '没有镐子挖不了石头', { have: { wooden_pickaxe: 1 } });
  if (pr >= 0 && pr < 1) add('做石镐、石剑', '石头工具便宜又比木头的耐用', { have: { stone_pickaxe: 1 } });
  if (!f.sword && !f.axe) add('做把武器（剑或斧）', '晚上会刷怪', { have: { sword: 1 } });
  if (!f.furnace && pr >= 1) add('做个熔炉', '烧铁、烤肉都要', { have: { furnace: 1 } });
  if (f.torches < 16 && pr >= 0) add('做一组火把（挖煤 / 烧木炭）', '下矿、过夜都要', { have: { torch: 16 } });
  if (pr >= 1 && pr < 3) add('挖铁、烧铁锭，做铁镐', '铁镐才挖得了钻石、金、红石', { have: { iron_pickaxe: 1 } });
  if (pr >= 3 && (f.armorPieces < 4 || ['wooden', 'stone', 'golden'].includes(f.armorTier))) add('做一套铁甲', '下矿、打怪不容易死', { have: { iron_chestplate: 1 } });
  if (pr >= 3 && !f.shield) add('做个盾', '挡骷髅的箭', { have: { shield: 1 } });
  if (pr >= 3 && !f.waterBucket) add('做个水桶装水', '落地水保命、灭火、种地', { have: { water_bucket: 1 } });
  if (pr >= 3 && pr < 4) add('下矿找钻石，做钻石镐', '下一个档次', { have: { diamond_pickaxe: 1 } });
  if (!f.hasHome) add('安个家（新手小屋 / 自己盖）', '有地方放东西、睡觉', null);
  if (f.hasHome && !f.bed) add('做张床放家里', '睡觉跳过夜晚、重生点', { have: { bed: 1 } });
  if (f.food != null && f.food < 16) add('攒吃的（种地 / 打猎 / 做菜）', '吃的不够', null);
  if (f.hasHome && f.seeds > 0) add('在家旁边开块地种庄稼', '吃的有长期来源', null);
  return out;
}

// ------------------------------------------------------------------ 计划

/** "做成的标志"达成了没有。have 的物品名按"名字结尾"比（sword → iron_sword 也算，log → oak_log 也算） */
function doneBy (done, items = []) {
  if (!done?.have) return false;
  return Object.entries(done.have).every(([want, n]) => {
    const w = bare(want);
    const got = items.filter(i => { const b = bare(i.name); return b === w || b.endsWith(`_${w}`); }).reduce((a, i) => a + (i.count || 1), 0);
    return got >= (+n || 1);
  });
}

/** 她写一个新计划（旧的进历史） */
function setPlan ({ goal, why = '', steps = [] } = {}) {
  load();
  if (!goal) throw new Error('计划要有目标（goal）');
  if (P.plan) note(`换了计划：「${P.plan.goal}」→「${goal}」`);
  P.plan = {
    goal: String(goal).slice(0, 80), why: String(why).slice(0, 120), at: Date.now(),
    steps: (steps || []).slice(0, 12).map(s => (typeof s === 'string' ? { text: s } : { text: String(s.text || '').slice(0, 80), done: s.done || null }))
      .filter(s => s.text).map(s => ({ text: s.text, when: s.done || null, ok: false })),
  };
  save();
  return P.plan;
}

/** 改一步：ok（做完）/ text（改写）/ add（在后面加一步）/ drop（去掉） */
function updateStep ({ index, ok, text, add, drop } = {}) {
  load();
  if (!P.plan) throw new Error('还没有计划（先 plan_set）');
  const st = P.plan.steps;
  if (add) st.push({ text: String(add).slice(0, 80), when: null, ok: false });
  const i = index != null ? +index : null;
  if (i != null) {
    if (!st[i]) throw new Error(`没有第 ${i} 步（一共 ${st.length} 步，从 0 数）`);
    if (drop) st.splice(i, 1);
    else {
      if (text) st[i].text = String(text).slice(0, 80);
      if (ok != null) { st[i].ok = !!ok; if (ok) note(`做完：${st[i].text}`); }
    }
  }
  save();
  return P.plan;
}

/** 正在做的那一步（第一个没做完的） */
function current () {
  load();
  if (!P.plan) return null;
  const i = P.plan.steps.findIndex(s => !s.ok);
  return i < 0 ? null : { index: i, ...P.plan.steps[i] };
}

/**
 * 每看一眼核对一次：标志达成的步骤自动打勾。返回这次新打勾的步骤（mind 告诉她），以及计划是不是全做完了。
 */
function autoCheck (items = []) {
  load();
  if (!P.plan) return { newly: [], finished: false };
  const newly = [];
  for (const s of P.plan.steps) {
    if (s.ok || !s.when) continue;
    if (doneBy(s.when, items)) { s.ok = true; newly.push(s.text); note(`做到了：${s.text}`); }
  }
  const finished = P.plan.steps.length > 0 && P.plan.steps.every(s => s.ok);
  if (finished && !P.plan.finishedAt) { P.plan.finishedAt = Date.now(); note(`计划完成：${P.plan.goal}`); }
  if (newly.length || finished) save();
  return { newly, finished: finished && newly.length > 0 };
}

function render ({ full = false } = {}) {
  load();
  if (!P.plan) return '还没有长期计划';
  const pl = P.plan;
  const cur = current();
  const lines = pl.steps.map((s, i) => `${s.ok ? '✓' : (cur && cur.index === i ? '→' : '·')} ${i}. ${s.text}`);
  return `目标：${pl.goal}${pl.why ? `（${pl.why}）` : ''}\n${full ? lines.join('\n') : lines.filter((_, i) => !pl.steps[i].ok).slice(0, 3).join('\n') || '（都做完了）'}`;
}

function get () { return load().plan; }
function history () { return load().history.slice(-10); }
function _reset () { P = { plan: null, history: [] }; }

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  process.env.MC_PLAN_FILE = path.join(require('os').tmpdir(), `plan-test-${process.pid}.json`);
  _reset();
  const I = (o) => Object.entries(o).map(([name, count]) => ({ name, count }));

  // 事实
  const f0 = facts({ items: I({ dirt: 21 }) });
  check('★ 只有 21 个泥土（P48）→ 没有镐', f0.pick, null);
  const id0 = ideas(f0).map(x => x.text);
  check('★ …可能性里有"砍树""做木镐"', id0.some(t => /砍/.test(t)) && id0.some(t => /木镐/.test(t)), true);
  check('没镐子时不列"钻石镐"（空想）', id0.some(t => /钻石镐/.test(t)), false);
  const f1 = facts({ items: I({ 'minecraft:stone_pickaxe': 1, stone_sword: 1, furnace: 1, crafting_table: 1, torch: 20 }), hasHome: true });
  check('石镐 → rank 1', f1.pick?.tier, 'stone');
  const id1 = ideas(f1).map(x => x.text);
  check('★ 有石镐 → 下一步可以做铁镐', id1.some(t => /铁镐/.test(t)), true);
  check('有家没床 → 可以做床', id1.some(t => /床/.test(t)), true);
  check('现状说得出来', /镐：石镐/.test(renderFacts(f1)), true);
  const f2 = facts({ items: I({ iron_pickaxe: 1 }), worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] });
  check('一套铁甲穿着 → 不再提铁甲', ideas(f2).some(x => /铁甲/.test(x.text)), false);

  // 计划
  check('没计划时 current 是 null', current(), null);
  setPlan({ goal: '做铁镐', why: '挖钻石', steps: [{ text: '做石镐', done: { have: { stone_pickaxe: 1 } } }, { text: '挖铁', done: { have: { raw_iron: 3 } } }, '烧铁锭做镐'] });
  check('当前是第 0 步', current()?.index, 0);
  let r = autoCheck(I({ 'minecraft:stone_pickaxe': 1 }));
  check('★ 做出石镐 → 第 0 步自动打勾', r.newly[0], '做石镐');
  check('当前变成第 1 步', current()?.index, 1);
  r = autoCheck(I({ raw_iron: 2 }));
  check('铁不够 3 个 → 不打勾', r.newly.length, 0);
  r = autoCheck(I({ raw_iron: 3 }));
  check('够了 → 打勾', r.newly[0], '挖铁');
  check('没写标志的步骤不会自动打勾', current()?.text, '烧铁锭做镐');
  updateStep({ index: 2, ok: true });
  check('她自己打勾 → 没有当前步骤了', current(), null);
  check('名字结尾匹配：sword 认得 iron_sword', doneBy({ have: { sword: 1 } }, I({ iron_sword: 1 })), true);
  check('log 认得 oak_log', doneBy({ have: { log: 8 } }, I({ oak_log: 5, birch_log: 3 })), true);
  updateStep({ add: '做一套铁甲' });
  check('加一步 → 又有当前步骤', current()?.text, '做一套铁甲');
  setPlan({ goal: '安家', steps: ['找块平地'] });
  check('换计划 → 旧的记进历史', history().some(h => /换了计划/.test(h.text)), true);
  check('计划存盘了（重新读得出来）', (() => { P = null; return get()?.goal; })(), '安家');
  check('render 写得出目标和当前步骤', /目标：安家/.test(render()) && /→ 0\. 找块平地/.test(render()), true);
  let threw = false; try { setPlan({}); } catch (_) { threw = true; }
  check('没目标 → 报错', threw, true);
  try { fs.unlinkSync(process.env.MC_PLAN_FILE); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { facts, renderFacts, ideas, doneBy, setPlan, updateStep, current, autoCheck, render, get, history, _reset, selftest };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
