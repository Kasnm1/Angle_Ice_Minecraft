'use strict';

/**
 * 知识层 —— 她懂这个整合包：东西怎么做、怎么来、怎么用、要在哪做。
 *
 * ## 数据从哪来（全部来自整合包本体，不是原版攻略）
 *
 *   knowledge/generated/gamedata.json   ← _tools/extract_gamedata.py
 *       原版 jar + 466 个模组 jar + kubejs/data 的配方、标签、掉落表、说明书、名字
 *   knowledge/generated/kubejs.json     ← _tools/kubejs_emulate.js
 *       整合包 KubeJS 脚本对配方/标签/掉落/交易的修改（删、换、加）
 *   knowledge/item-names.json           中文名（含整合包自己的汉化）
 *   knowledge/quests.json               任务书（奖励 = 一种获取途径）
 *   knowledge/tooltips.md               作者写在物品上的提示
 *
 * 这个包删改了大量配方（KubeJS 删 370 条、换原料 150 处、新增 390 条），
 * 所以**只信这里，不信原版常识** —— 这正是 PERSONA.md 里「别按原版攻略答」的底气来源。
 *
 * ## 对外接口
 *
 *   resolve(q)                 名字 → id（中文 / 英文 / id / 模糊）
 *   recipesFor(id)             怎么做
 *   usesOf(id)                 能拿来做什么 / 它自己是不是工作站
 *   obtain(id)                 怎么获得：合成 / 挖哪个方块（要什么工具）/ 打哪个怪 / 哪里的箱子 / 交易 / 任务奖励
 *   materialTree(id, n, inv)   从现有背包出发，要做 n 个还缺什么、按什么顺序做
 *   guide(q)                   说明书 / 物品提示 / 任务说明 里搜
 *   describe(q)                一句话全貌（上面几样的摘要）—— 给快脑用
 *
 * 全部返回**给模型读的纯文本**（中文名 + id），不是给程序读的结构 —— 模型要的是能直接用的话。
 *
 * 自测：node knowledge.js --selftest
 * 手查：node knowledge.js obtain 铁锭 / recipe 木镐 / uses 煤炭 / tree 铁镐 / guide 七咒之戒
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'knowledge');
const GEN = path.join(DIR, 'generated');

// ------------------------------------------------------------------ 工作站

/**
 * 配方类型 → 在哪做。已知的写死；其余按「同模组里名字最像的方块」猜（标 guess）。
 * inventory = 背包 2×2 就能做（shaped ≤2×2 / shapeless ≤4 在 normalize 时单独判）。
 */
const STATIONS = {
  'minecraft:crafting_shaped': 'minecraft:crafting_table',
  'minecraft:crafting_shapeless': 'minecraft:crafting_table',
  'minecraft:smelting': 'minecraft:furnace',
  'minecraft:blasting': 'minecraft:blast_furnace',
  'minecraft:smoking': 'minecraft:smoker',
  'minecraft:campfire_cooking': 'minecraft:campfire',
  'minecraft:stonecutting': 'minecraft:stonecutter',
  'minecraft:smithing_transform': 'minecraft:smithing_table',
  'minecraft:smithing_trim': 'minecraft:smithing_table',
  'farmersdelight:cooking': 'farmersdelight:cooking_pot',
  'farmersdelight:cutting': 'farmersdelight:cutting_board',
  'create:mixing': 'create:mechanical_mixer',
  'create:milling': 'create:millstone',
  'create:crushing': 'create:crushing_wheel',
  'create:compacting': 'create:mechanical_press',
  'create:pressing': 'create:mechanical_press',
  'create:filling': 'create:spout',
  'create:emptying': 'create:item_drain',
  'create:cutting': 'create:mechanical_saw',
  'create:deploying': 'create:deployer',
  'create:mechanical_crafting': 'create:mechanical_crafter',
  'create:haunting': 'create:encased_fan',
  'create:splashing': 'create:encased_fan',
  'ars_nouveau:imbuement': 'ars_nouveau:imbuement_chamber',
  'ars_nouveau:enchanting_apparatus': 'ars_nouveau:enchanting_apparatus',
  'ars_nouveau:enchantment': 'ars_nouveau:enchanting_apparatus',
  'ars_nouveau:glyph': 'ars_nouveau:scribes_table',
  'ars_nouveau:crush': 'ars_nouveau:glyph_crush',
  'crockpot:crock_pot_cooking': 'crockpot:crock_pot',
  'brewinandchewin:fermenting': 'brewinandchewin:keg',
  'brewinandchewin:keg_pouring': 'brewinandchewin:keg',
  'farmersrespite:brewing': 'farmersrespite:kettle',
  'farmersrespite:kettle_pouring': 'farmersrespite:kettle',
  'kaleidoscope_cookery:pot': 'kaleidoscope_cookery:pot',
  'kaleidoscope_cookery:stockpot': 'kaleidoscope_cookery:stockpot',
  'kaleidoscope_cookery:millstone': 'kaleidoscope_cookery:millstone',
  'meadow:woodcutting': 'meadow:woodcutter',
  'touhou_little_maid:altar_crafting': 'touhou_little_maid:altar',
  'tacz:gun_smith_table_crafting': 'tacz:gun_smith_table',
  'sophisticatedstorage:storage_tier_upgrade': 'minecraft:crafting_table',
  'sophisticatedcore:upgrade_next_tier': 'minecraft:crafting_table',
};

// 这些"配方"不产出物品（繁殖/驯服/食物属性表…），不进索引
const NON_RECIPES = /^(justenoughbreeding:|crockpot:food_values|jeed:|botanypots:(soil|fertilizer)|minecraft:crafting_special_|minecraft:crafting_decorated_pot)/;

// ------------------------------------------------------------------ 加载与构建

let K = null;

function readJson (p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function load () {
  if (K) return K;
  const t0 = Date.now();
  const gd = readJson(path.join(GEN, 'gamedata.json'), null);
  if (!gd) throw new Error('缺 knowledge/generated/gamedata.json —— 先跑 python3 knowledge/_tools/extract_gamedata.py');
  const kj = readJson(path.join(GEN, 'kubejs.json'), { recipeOps: [], tagOps: [], lootOps: [], trades: [] });
  const zh = readJson(path.join(DIR, 'item-names.json'), {});

  K = {
    names: new Map(),        // id → {zh, en}
    tags: new Map(),         // 'item:tag' / 'block:tag' → Set(id)
    itemTags: new Map(),     // id → Set(tag)     （物品标签的反查）
    blockTags: new Map(),
    recipes: [],
    byOutput: new Map(),
    byInput: new Map(),
    byStation: new Map(),
    drops: new Map(),        // item → [{from:'block'|'entity'|'chest'|'fishing'|'other', id, when}]
    trades: kj.trades || [],
    questRewards: new Map(), // item → [任务标题]
    tooltips: new Map(),     // item → [行]
    guide: gd.guide || [],
    meta: gd.meta,
    kubejs: { removed: 0, added: 0, replaced: 0, byFilter: new Map() },   // byFilter：每条删除规则删了几条（查误删用）
  };

  // ---- 名字
  for (const [id, n] of Object.entries(gd.names || {})) K.names.set(id, { zh: n.zh_cn, en: n.en_us });
  for (const kind of ['item', 'block', 'entity']) {
    for (const [id, name] of Object.entries(zh[kind] || {})) {
      const cur = K.names.get(id) || {};
      K.names.set(id, { ...cur, zh: name });   // 整合包汉化优先
    }
  }

  // ---- 标签（先 jar，再套 KubeJS 修改），展开嵌套
  const rawTags = { item: gd.tags.items || {}, block: gd.tags.blocks || {} };
  for (const op of kj.tagOps || []) {
    const kind = op.kind === 'block' || op.kind === 'blocks' ? 'block' : 'item';
    const T = rawTags[kind];
    if (op.op === 'add') T[op.tag] = [...new Set([...(T[op.tag] || []), ...op.items])];
    else if (op.op === 'remove') T[op.tag] = (T[op.tag] || []).filter(x => !op.items.includes(x));
    else if (op.op === 'removeAll') T[op.tag] = [];
    else if (op.op === 'removeAllTagsFrom') for (const t of Object.keys(T)) T[t] = T[t].filter(x => !op.items.includes(x));
  }
  for (const kind of ['item', 'block']) {
    const T = rawTags[kind];
    const memo = new Map();
    const expand = (tag, stack = new Set()) => {
      if (memo.has(tag)) return memo.get(tag);
      if (stack.has(tag)) return new Set();
      stack.add(tag);
      const set = new Set();
      for (const v of T[tag] || []) {
        if (v.startsWith('#')) for (const x of expand(v.slice(1), stack)) set.add(x);
        else set.add(v.replace(/\?$/, ''));
      }
      memo.set(tag, set);
      return set;
    };
    const rev = kind === 'item' ? K.itemTags : K.blockTags;
    for (const tag of Object.keys(T)) {
      const set = expand(tag);
      K.tags.set(`${kind}:${tag}`, set);
      for (const id of set) {
        if (!rev.has(id)) rev.set(id, new Set());
        rev.get(id).add(tag);
      }
    }
  }

  // ---- 配方：jar → KubeJS 删/换/加
  const recs = [];
  for (const [id, r] of Object.entries(gd.recipes || {})) {
    const n = normalize(id, r, 'jar');
    if (n) recs.push(n);
  }
  let auto = 0;
  for (const op of kj.recipeOps || []) {
    if (op.op === 'add') {
      const r = { ...op.recipe };
      const id = r.__id || `kubejs:auto_${++auto}`;
      const repl = r.__replace; delete r.__id; delete r.__replace;
      const n = normalize(id, r, 'kubejs');
      if (!n) continue;
      if (repl) for (const [from, to] of repl) replaceIng(n, from, to);
      recs.push(n); K.kubejs.added++;
      continue;
    }
    // KubeJS 的 remove / replace 只作用于数据包里原有的配方，不碰同一事件里新增的
    for (const n of recs) {
      if (n.removed || n.source !== 'jar' || !matchFilter(n, op.filter)) continue;
      if (op.op === 'remove') {
        n.removed = true; K.kubejs.removed++;
        const key = JSON.stringify(op.filter);
        K.kubejs.byFilter.set(key, (K.kubejs.byFilter.get(key) || 0) + 1);
      }
      else if (op.op === 'replaceInput') { if (replaceIng(n, op.from, op.to)) K.kubejs.replaced++; }
      else if (op.op === 'replaceOutput') {
        for (const o of n.out) if (ingMatches(op.from, o.item)) { o.item = op.to.item || o.item; K.kubejs.replaced++; }
      }
    }
  }
  K.recipes = recs.filter(r => !r.removed);
  K.recipes.forEach((r, i) => {
    for (const o of r.out) push(K.byOutput, o.item, i);
    for (const slot of [...r.in, ...r.tools]) {
      for (const alt of slot.alts) {
        if (alt.item) push(K.byInput, alt.item, i);
        else if (alt.tag) push(K.byInput, `#${alt.tag}`, i);
      }
    }
    if (r.station) push(K.byStation, r.station, i);
  });

  // ---- 掉落：jar 掉落表 → KubeJS/LootJS 修改
  const tables = gd.loot || {};
  const byTarget = new Map();   // 'block:x' / 'entity:x' / 'table:ns:path' → [{item|tag, when, source}]
  for (const [tid, entries] of Object.entries(tables)) {
    const m = tid.match(/^([^:]+):(blocks|entities|chests|gameplay)\/(.+)$/);
    if (!m) continue;
    const key = m[2] === 'blocks' ? `block:${m[1]}:${m[3]}` : m[2] === 'entities' ? `entity:${m[1]}:${m[3]}` : `table:${m[1]}:${m[2]}/${m[3]}`;
    byTarget.set(key, entries.map(e => ({ ...e })));
  }
  for (const op of kj.lootOps || []) {
    for (const id of op.target.ids) {
      const key = op.target.kind === 'table' ? `table:${id}` : `${op.target.kind}:${id}`;
      if (!byTarget.has(key)) byTarget.set(key, []);
      const list = byTarget.get(key);
      if (op.op === 'add') {
        if (op.clear) list.length = 0;
        for (const it of op.items || []) if (it) list.push({ ...it, when: it.chance ? ['概率'] : [], source: op.source });
      } else if (op.op === 'remove') {
        for (const it of op.items || []) {
          for (let i = list.length - 1; i >= 0; i--) if (it && list[i].item && ingMatches(it, list[i].item)) list.splice(i, 1);
        }
      } else if (op.op === 'replace' && op.from && op.to) {
        for (const e of list) if (e.item && ingMatches(op.from, e.item)) e.item = op.to.item;
      }
    }
  }
  for (const [key, list] of byTarget) {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const from = kind === 'block' ? 'block' : kind === 'entity' ? 'entity'
      : /gameplay\/fishing/.test(id) ? 'fishing' : /chests\//.test(id) ? 'chest' : 'other';
    for (const e of list) {
      const items = e.item ? [e.item] : e.tag ? [...(K.tags.get(`item:${e.tag}`) || [])].slice(0, 20) : [];
      for (const it of items) push(K.drops, it, { from, id, when: e.when || [] });
    }
  }

  // ---- 任务奖励 / 物品提示
  const quests = readJson(path.join(DIR, 'quests.json'), { chapters: [] });
  for (const ch of quests.chapters || []) {
    for (const q of ch.quests || []) {
      for (const r of q.rewards || []) {
        const m = r.type === 'item' && String(r.summary || '').match(/（([a-z0-9_.-]+:[a-z0-9_/.-]+)）/);
        if (m) push(K.questRewards, m[1], `${ch.title} › ${q.title || '(无标题)'}`);
      }
    }
  }
  try {
    const md = fs.readFileSync(path.join(DIR, 'tooltips.md'), 'utf8');
    for (const block of md.split(/\n## /).slice(1)) {
      const id = (block.match(/`([a-z0-9_.-]+:[a-z0-9_/.-]+)`/) || [])[1];
      if (id) K.tooltips.set(id, block.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).replace(/^•\s*/, '')));
    }
  } catch (_) {}

  K.buildMs = Date.now() - t0;
  return K;
}

function push (map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

// ------------------------------------------------------------------ 配方正规化

/** 各种写法的原料 → [{item}|{tag}]（任选其一）+ 数量 */
function toSlot (v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.replace(/\{.*$/, '');
    return s.startsWith('#') ? { alts: [{ tag: s.slice(1) }], count: 1 } : { alts: [{ item: s }], count: 1 };
  }
  if (Array.isArray(v)) {
    const alts = v.map(toSlot).filter(Boolean).flatMap(s => s.alts);
    return alts.length ? { alts, count: 1 } : null;
  }
  if (typeof v !== 'object') return null;
  if (v.ingredient) {
    const s = toSlot(v.ingredient);
    if (s) s.count = v.count || v.quantity || s.count;
    return s;
  }
  if (v.item && typeof v.item === 'object') return toSlot({ ...v.item, count: v.count || v.item.count });
  if (typeof v.item === 'string') return { alts: [{ item: v.item }], count: v.count || v.amount || 1 };
  if (typeof v.tag === 'string') return { alts: [{ tag: v.tag }], count: v.count || v.amount || 1 };
  if (v.id && typeof v.id === 'string') return { alts: [{ item: v.id }], count: v.count || v.Count || 1 };
  if (Array.isArray(v.values)) return toSlot(v.values);        // forge:compound 之类
  if (Array.isArray(v.children)) return toSlot(v.children);
  return null;   // fluid 等
}

function toOut (v, amountKey) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(x => toOut(x));
  if (typeof v === 'string') return [{ item: v.replace(/\{.*$/, ''), count: amountKey || 1 }];
  if (typeof v !== 'object') return [];
  const item = v.item || v.id || v.result?.item;
  if (!item || typeof item !== 'string') return [];
  const o = { item, count: v.count || v.amount || v.Count || amountKey || 1 };
  if (v.chance && v.chance < 1) o.chance = v.chance;
  return [o];
}

const IN_KEYS = ['ingredient', 'ingredients', 'input', 'inputs', 'inputItem', 'reagent', 'pedestalItems', 'base', 'addition', 'template', 'container', 'carrier', 'catalyst_ingredient', 'item_input'];
const TOOL_KEYS = ['tool'];
const OUT_KEYS = ['result', 'results', 'output', 'outputs', 'outputItem'];

function normalize (id, r, source) {
  const type = String(r.type || '').includes(':') ? r.type : `minecraft:${r.type}`;
  if (!r.type || NON_RECIPES.test(type)) return null;
  const n = { id, type, source, in: [], tools: [], out: [], station: null, stationGuess: false, grid: null };
  const ct = r.cookingtime ?? r.cookingTime ?? r.cooktime ?? r.processingTime ?? r.time;
  if (typeof ct === 'number') n.time = ct;   // 做多久（tick），厨锅/熔炉等要等的时间

  if (Array.isArray(r.pattern) && r.key) {
    const counts = {};
    for (const row of r.pattern) for (const ch of String(row)) if (ch !== ' ') counts[ch] = (counts[ch] || 0) + 1;
    for (const [ch, c] of Object.entries(counts)) {
      const s = toSlot(r.key[ch]);
      if (s) { s.count = c; n.in.push(s); }
    }
    const w = Math.max(...r.pattern.map(x => String(x).length));
    n.grid = w <= 2 && r.pattern.length <= 2 ? 2 : 3;
    // 保留摆放图案：hands.js 要按它往合成格里摆（normalize 合并数量后就丢了位置信息）
    n.shape = { pattern: r.pattern.map(String), key: {} };
    for (const ch of Object.keys(counts)) { const s = toSlot(r.key[ch]); if (s) n.shape.key[ch] = s.alts; }
  }
  for (const k of IN_KEYS) {
    const v = r[k];
    if (v == null) continue;
    if (Array.isArray(v) && (k === 'ingredients' || k === 'inputs' || k === 'pedestalItems' || k === 'reagent')) {
      for (const x of v) { const s = toSlot(x); if (s) n.in.push(s); }
    } else {
      const s = toSlot(v);
      if (s) { if (k === 'container' || k === 'carrier') s.isContainer = true; n.in.push(s); }
    }
  }
  if (Array.isArray(r.requirements)) {   // crockpot
    for (const q of r.requirements) if (q.ingredient) { const s = toSlot(q.ingredient); if (s) { s.count = q.quantity || 1; n.in.push(s); } }
  }
  if (Array.isArray(r.__kubejsArgs)) {   // 未专门处理的 KubeJS 类型：第一个像产物的当产物，其余当原料
    const a = r.__kubejsArgs;
    n.out.push(...toOut(a[0]));
    for (const x of a.slice(1)) { const s = toSlot(x); if (s) n.in.push(s); }
  }
  for (const k of TOOL_KEYS) { const s = toSlot(r[k]); if (s) n.tools.push(s); }
  for (const k of OUT_KEYS) {
    if (r[k] == null) continue;
    n.out.push(...toOut(r[k], k === 'outputItem' ? r.outputAmount : undefined));
  }
  if (!n.out.length) return null;
  // 同一原料合并数量（shapeless 里写三次 stick = 3 个 stick）
  const merged = new Map();
  for (const s of n.in) {
    const key = JSON.stringify(s.alts) + (s.isContainer ? '|c' : '');
    if (merged.has(key)) merged.get(key).count += s.count; else merged.set(key, { ...s });
  }
  n.in = [...merged.values()];

  if (type === 'minecraft:crafting_shapeless') n.grid = n.in.reduce((a, s) => a + s.count, 0) <= 4 ? 2 : 3;
  n.station = STATIONS[type] || null;
  if (n.grid === 2) n.station = 'inventory';
  return n;
}

/** 没写死的配方类型：在同一个模组里找名字最像的方块当工作站 */
function guessStation (type) {
  load();
  if (!guessStation.memo) guessStation.memo = new Map();
  if (guessStation.memo.has(type)) return guessStation.memo.get(type);
  const [ns, p] = type.split(':');
  const tokens = p.split(/[_/]/).filter(t => t.length > 2 && !['crafting', 'recipe', 'recipes', 'cooking', 'processing'].includes(t));
  let best = null; let bestScore = 0;
  for (const id of K.names.keys()) {
    if (!id.startsWith(ns + ':')) continue;
    const ip = id.slice(ns.length + 1);
    let score = 0;
    if (ip === p) score = 100;
    else if (p.startsWith(ip + '_') || ip.startsWith(p + '_')) score = 50 - Math.abs(ip.length - p.length);
    else score = tokens.filter(t => ip.split('_').includes(t)).length * 10 - ip.length / 10;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  const r = bestScore >= 5 ? best : null;
  guessStation.memo.set(type, r);
  return r;
}

function stationOf (r) {
  if (r.station) return { id: r.station, guess: false };
  const g = guessStation(r.type);
  return { id: g, guess: !!g };
}

// ------------------------------------------------------------------ KubeJS 过滤器

function ingMatches (ing, itemId) {
  if (!ing) return false;
  if (ing.item) return ing.item === itemId;
  if (ing.tag) return !!K.tags.get(`item:${ing.tag}`)?.has(itemId);
  return false;
}

function slotAccepts (slot, target) {
  // target: {item} 或 {tag}
  for (const alt of slot.alts) {
    if (target.tag) { if (alt.tag === target.tag) return true; continue; }
    if (alt.item === target.item) return true;
    if (alt.tag && K.tags.get(`item:${alt.tag}`)?.has(target.item)) return true;
  }
  return false;
}

function strMatch (pat, s) {
  if (pat == null) return true;
  if (typeof pat === 'object' && pat.regex) return new RegExp(pat.regex, pat.flags || '').test(s);
  return String(pat) === s;
}

function toTarget (v) {
  if (typeof v === 'string') return v.startsWith('#') ? { tag: v.slice(1) } : { item: v };
  return v;
}

function matchFilter (n, f) {
  if (!f || !Object.keys(f).length) return true;
  if (f.or) return f.or.some(x => matchFilter(n, x));
  if (f.not && matchFilter(n, f.not)) return false;
  if (f.id !== undefined && !strMatch(f.id, n.id)) return false;
  if (f.mod !== undefined && !strMatch(f.mod, n.id.split(':')[0])) return false;
  if (f.type !== undefined && !strMatch(f.type, n.type)) return false;
  if (f.output !== undefined) {
    const t = toTarget(f.output);
    const ok = n.out.some(o => (t.regex ? strMatch(t, o.item) : t.tag ? K.tags.get(`item:${t.tag}`)?.has(o.item) : o.item === t.item));
    if (!ok) return false;
  }
  if (f.input !== undefined) {
    const t = toTarget(f.input);
    const ok = [...n.in, ...n.tools].some(s => (t.regex ? s.alts.some(a => a.item && strMatch(t, a.item)) : slotAccepts(s, t)));
    if (!ok) return false;
  }
  return true;
}

function replaceIng (n, from, to) {
  if (!from || !to) return false;
  let hit = false;
  for (const slot of [...n.in, ...n.tools]) {
    if (slotAccepts(slot, from.tag ? { tag: from.tag } : { item: from.item })) {
      slot.alts = [to.tag ? { tag: to.tag } : { item: to.item }];
      hit = true;
    }
  }
  return hit;
}

// ------------------------------------------------------------------ 名字

function nameOf (id) {
  if (!id) return '?';
  if (id.startsWith('#')) return `任意「${tagName(id.slice(1))}」`;
  const n = load().names.get(id);
  return n?.zh || n?.en || id;
}

function tagName (tag) {
  const s = load().tags.get(`item:${tag}`);
  const sample = s ? [...s].slice(0, 3).map(x => load().names.get(x)?.zh || x) : [];
  return `#${tag}${sample.length ? `（如 ${sample.join('、')}）` : ''}`;
}

function label (id) {
  const n = nameOf(id);
  return n === id ? id : `${n}(${id})`;
}

/** 名字 → 候选 id。优先：精确 id > 中文全等 > 英文全等 > 包含（有配方/掉落的排前面） */
function resolve (q, limit = 5) {
  load();
  const s = String(q || '').trim().replace(/^minecraft:/, 'minecraft:');
  if (!s) return [];
  if (s.includes(':') && (K.names.has(s) || K.byOutput.has(s) || K.drops.has(s))) return [s];
  if (!s.includes(':') && K.names.has(`minecraft:${s}`)) return [`minecraft:${s}`];
  const lower = s.toLowerCase();
  const exact = []; const partial = [];
  for (const [id, n] of K.names) {
    if (n.zh === s || (n.en && n.en.toLowerCase() === lower) || id.split(':')[1] === lower) exact.push(id);
    else if ((n.zh && n.zh.includes(s)) || (n.en && n.en.toLowerCase().includes(lower)) || id.includes(lower)) partial.push(id);
  }
  const weight = (id) => (K.byOutput.has(id) ? 2 : 0) + (K.drops.has(id) ? 1 : 0) + (id.startsWith('minecraft:') ? 1 : 0) - id.length / 200;
  const sortW = (a) => a.sort((x, y) => weight(y) - weight(x));
  return [...sortW(exact), ...sortW(partial.filter(id => (K.names.get(id).zh || '').length <= s.length + 8))].slice(0, limit);
}

function resolveOne (q) {
  const r = resolve(q, 1);
  return r[0] || null;
}

// ------------------------------------------------------------------ 查询

function fmtSlot (s) {
  const alts = s.alts.slice(0, 3).map(a => (a.item ? label(a.item) : tagName(a.tag)));
  return `${alts.join(' 或 ')}${s.alts.length > 3 ? ' 等' : ''}×${s.count}`;
}

function fmtRecipe (r) {
  const st = stationOf(r);
  const where = r.station === 'inventory' ? '背包里就能做(2×2)'
    : st.id ? `在「${label(st.id)}」${st.guess ? '(推测)' : ''}` : `类型 ${r.type}`;
  const tools = r.tools.length ? `，要用工具 ${r.tools.map(fmtSlot).join('、')}（不消耗）` : '';
  const outs = r.out.map(o => `${label(o.item)}×${o.count}${o.chance ? `(${Math.round(o.chance * 100)}%)` : ''}`).join(' + ');
  return `${where}：${r.in.map(fmtSlot).join(' + ') || '（无原料）'}${tools} → ${outs}${r.source === 'kubejs' ? '［整合包改过］' : ''}`;
}

function recipeRank (r) {
  const st = r.station === 'inventory' ? 0
    : ['minecraft:crafting_table', 'minecraft:furnace'].includes(r.station) ? 1
      : r.type.startsWith('minecraft:') ? 2 : 3;
  const vanillaIn = r.in.filter(s => s.alts.some(a => (a.item || a.tag || '').startsWith('minecraft:') || (a.tag || '').startsWith('forge:'))).length;
  return st * 10 + (r.in.length - vanillaIn) * 2 + r.in.length * 0.1;
}

function recipesFor (q, limit = 6) {
  const id = resolveOne(q);
  if (!id) return `没找到「${q}」这个物品。`;
  const list = (K.byOutput.get(id) || []).map(i => K.recipes[i]);
  if (!list.length) return `${label(id)} 没有任何配方（不能合成，只能靠挖/打/找/任务获得，用 obtain 查）。`;
  // 原版工作台/熔炉类排前面：她最可能做得出来
  list.sort((a, b) => recipeRank(a) - recipeRank(b));
  return `${label(id)} 有 ${list.length} 种做法：\n` + list.slice(0, limit).map((r, i) => `${i + 1}. ${fmtRecipe(r)}`).join('\n')
    + (list.length > limit ? `\n…还有 ${list.length - limit} 种` : '');
}

function usesOf (q, limit = 8) {
  const id = resolveOne(q);
  if (!id) return `没找到「${q}」这个物品。`;
  load();
  const lines = [];
  // 它自己是工作站？
  const asStation = K.byStation.get(id) || [];
  const guessed = asStation.length ? [] : K.recipes.filter(r => !r.station && guessStation(r.type) === id);
  const st = asStation.length ? asStation.map(i => K.recipes[i]) : guessed;
  if (st.length) {
    const types = [...new Set(st.map(r => r.type))];
    lines.push(`它是工作站：放下后右键打开界面，能做 ${st.length} 种配方（${types.join('、')}）。例如：`);
    for (const r of st.slice(0, 4)) lines.push(`  · ${r.in.map(fmtSlot).join(' + ')} → ${r.out.map(o => label(o.item)).join('+')}`);
  }
  const idx = new Set(K.byInput.get(id) || []);
  for (const t of K.itemTags.get(id) || []) for (const i of K.byInput.get(`#${t}`) || []) idx.add(i);
  // 最常被问的是"这东西直接能做成什么"：单一原料、原版工作站/熔炉类的排最前，同一产物只留一条
  const simple = (r) => (r.in.length === 1 ? 0 : 10) + recipeRank(r) / 10;
  const seenOut = new Set();
  const rs = [...idx].map(i => K.recipes[i]).sort((a, b) => simple(a) - simple(b))
    .filter(r => { const k2 = r.out.map(o => o.item).join('+'); if (seenOut.has(k2)) return false; seenOut.add(k2); return true; });
  if (rs.length) {
    const asTool = rs.filter(r => r.tools.some(s => slotAccepts(s, { item: id })));
    if (asTool.length) lines.push(`能当工具用（不消耗）在 ${asTool.length} 个配方里，例如 ${asTool.slice(0, 3).map(r => r.out.map(o => nameOf(o.item)).join('+')).join('、')}`);
    lines.push(`能当原料做 ${rs.length} 样东西，例如：`);
    for (const r of rs.slice(0, limit)) {
      const others = r.in.length > 1 ? `，还要 ${r.in.filter(s2 => !slotAccepts(s2, { item: id })).map(fmtSlot).join(' + ')}` : '（只要它自己）';
      lines.push(`  · ${r.out.map(o => label(o.item)).join('+')} ← ${r.station === 'inventory' ? '背包里' : stationOf(r).id ? nameOf(stationOf(r).id) : r.type}${others}`);
    }
  }
  const tips = K.tooltips.get(id);
  if (tips?.length) lines.push(`物品提示：${tips.join(' ')}`);
  const g = K.guide.filter(e => e.items.includes(id) || e.icon === id).slice(0, 2);
  for (const e of g) lines.push(`说明书《${e.name}》：${e.text.slice(0, 300).replace(/\n+/g, ' ')}`);
  return lines.length ? `${label(id)} 的用途：\n${lines.join('\n')}` : `${label(id)}：没查到它能用来做什么（可能是直接使用的物品，比如食物/装备，右键或装备就行）。`;
}

/** 方块要什么工具挖：mineable/<tool> + needs_<tier>_tool */
function harvestTool (blockId) {
  const tags = load().blockTags.get(blockId);
  if (!tags) return null;
  const tool = ['pickaxe', 'axe', 'shovel', 'hoe'].find(t => tags.has(`minecraft:mineable/${t}`));
  const tier = ['diamond', 'iron', 'stone'].find(t => tags.has(`minecraft:needs_${t}_tool`))
    || (tags.has('forge:needs_netherite_tool') ? 'netherite' : null);
  if (!tool && !tier) return null;
  const toolZh = { pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄' }[tool] || '工具';
  const tierZh = { stone: '石', iron: '铁', diamond: '钻石', netherite: '下界合金' }[tier] || '';
  return { tool, tier, text: tier ? `${tierZh}${toolZh}或更好` : `用${toolZh}挖最快` };
}

function obtain (q) {
  const id = resolveOne(q);
  if (!id) return `没找到「${q}」这个物品。`;
  load();
  const lines = [];
  const drops = K.drops.get(id) || [];
  const blocks = drops.filter(d => d.from === 'block');
  if (blocks.length) {
    const self = blocks.find(d => d.id === id);
    const others = blocks.filter(d => d.id !== id);
    if (self) {
      const ht = harvestTool(id);
      const cond = self.when.length ? `（${self.when.join('，')}）` : '';
      lines.push(`直接挖这个方块就掉${cond}${ht ? `，${ht.text}` : ''}`);
    }
    if (others.length) {
      const desc = others.slice(0, 6).map(d => {
        const ht = harvestTool(d.id);
        return `${label(d.id)}${d.when.length ? `[${d.when.join(',')}]` : ''}${ht ? `（${ht.text}）` : ''}`;
      });
      lines.push(`挖这些方块会掉：${desc.join('、')}${others.length > 6 ? ` 等 ${others.length} 种` : ''}`);
    }
  }
  const ents = drops.filter(d => d.from === 'entity');
  if (ents.length) lines.push(`打这些生物掉：${ents.slice(0, 6).map(d => `${label(d.id)}${d.when.length ? `[${d.when.join(',')}]` : ''}`).join('、')}${ents.length > 6 ? ` 等 ${ents.length} 种` : ''}`);
  const fish = drops.filter(d => d.from === 'fishing');
  if (fish.length) lines.push('钓鱼能钓到');
  const chests = drops.filter(d => d.from === 'chest');
  if (chests.length) lines.push(`这些结构的箱子里有：${[...new Set(chests.map(d => d.id.replace(/^.*chests\//, '')))].slice(0, 6).join('、')}${chests.length > 6 ? ' 等' : ''}`);
  const rs = (K.byOutput.get(id) || []).map(i => K.recipes[i]);
  if (rs.length) {
    rs.sort((a, b) => recipeRank(a) - recipeRank(b));
    lines.push(`能做出来（${rs.length} 种做法），最顺手的：${rs.slice(0, 2).map(fmtRecipe).join('；或 ')}`);
  }
  const tr = K.trades.filter(t => t.output?.item === id);
  if (tr.length) lines.push(`村民交易：${tr.map(t => `${t.profession} ${t.level}级，用 ${t.inputs.map(x => label(x.item || '#' + x.tag)).join('+')}`).join('；')}`);
  const qr = K.questRewards.get(id);
  if (qr?.length) lines.push(`任务奖励：${qr.slice(0, 3).join('；')}${qr.length > 3 ? ` 等 ${qr.length} 个任务` : ''}`);
  const tips = K.tooltips.get(id);
  if (tips?.length) lines.push(`物品提示（作者写的）：${tips.join(' ')}`);
  return lines.length ? `${label(id)} 怎么获得：\n${lines.map(l => `· ${l}`).join('\n')}` : `${label(id)}：本包数据里没查到获取方式（可能是商店/特殊事件，建议在 JEI 里按 R 看）。`;
}

// ------------------------------------------------------------------ 材料树

/**
 * 从现有背包出发，做 count 个 id 需要什么。
 * 选配方的原则：能在背包 2×2 / 工作台 / 熔炉做的优先（她做得出来的），原料越少越好，
 * 原料里有背包已有的优先；绕开会成环的配方。没有配方的就是"原材料"，附上怎么弄。
 */
function materialTree (q, count = 1, inventory = []) {
  const id = resolveOne(q);
  if (!id) return `没找到「${q}」这个物品。`;
  load();
  const inv = new Map();
  for (const it of inventory) {
    const name = (it.name || it.item || '').includes(':') ? (it.name || it.item) : `minecraft:${it.name || it.item}`;
    inv.set(name, (inv.get(name) || 0) + (it.count || 1));
  }
  const steps = []; const raw = new Map(); const used = new Map();
  let nodes = 0;

  const have = (item) => inv.get(item) || 0;
  const take = (item, n) => {
    const k = Math.min(have(item), n);
    if (k) { inv.set(item, have(item) - k); used.set(item, (used.get(item) || 0) + k); }
    return n - k;
  };
  const inSlot = (slot, x) => slot.alts.some(a => (a.item ? a.item === x : K.tags.get(`item:${a.tag}`)?.has(x)));
  const pickAlt = (slot) => {
    // 背包里有的 > 原版的 > 有配方/掉落的
    const owned = [...inv.keys()].filter(x => have(x) > 0 && inSlot(slot, x));
    if (owned.length) return owned.sort((a, b) => have(b) - have(a))[0];
    const cands = slot.alts.flatMap(a => (a.item ? [a.item] : [...(K.tags.get(`item:${a.tag}`) || [])].slice(0, 400)));
    const score = (x) => (have(x) >= slot.count ? 100 : have(x) ? 50 : 0) + (x.startsWith('minecraft:') ? 10 : 0)
      + (K.drops.has(x) ? 3 : 0) + (K.byOutput.has(x) ? 2 : 0);
    return cands.sort((a, b) => score(b) - score(a))[0];
  };
  const rank = (r) => {
    const st = r.station === 'inventory' ? 0 : ['minecraft:crafting_table', 'minecraft:furnace'].includes(r.station) ? 1
      : r.type.startsWith('minecraft:') ? 3 : 6;
    const haveAll = r.in.every(s => [...inv.keys()].some(x => have(x) > 0 && inSlot(s, x))) ? -2 : 0;
    return st + r.in.length * 0.5 + haveAll;
  };

  function need (item, n, depth, stack) {
    if (++nodes > 300) return;
    const rest = take(item, n);
    if (!rest) return;
    const rs = (K.byOutput.get(item) || []).map(i => K.recipes[i])
      .filter(r => !r.in.some(s => s.alts.some(a => a.item && stack.has(a.item))))
      .filter(r => !r.out.some(o => o.chance));
    if (!rs.length || depth > 7) {
      raw.set(item, (raw.get(item) || 0) + rest);
      return;
    }
    const r = rs.sort((a, b) => rank(a) - rank(b))[0];
    const per = r.out.find(o => o.item === item)?.count || 1;
    const times = Math.ceil(rest / per);
    const next = new Set(stack); next.add(item);
    const chosen = [];
    for (const s of r.in) {
      const pick = pickAlt(s);
      if (!pick) continue;
      chosen.push({ item: pick, count: s.count * times });
      need(pick, s.count * times, depth + 1, next);
    }
    const st = stationOf(r);
    steps.push({ item, times, makes: per * times, station: r.station === 'inventory' ? 'inventory' : st.id, guess: st.guess, inputs: chosen, tools: r.tools, type: r.type });
    const extra = per * times - rest;
    if (extra > 0) inv.set(item, have(item) + extra);
  }
  need(id, count, 0, new Set());

  const lines = [`要做 ${label(id)}×${count}：`];
  if (used.size) lines.push(`背包里能直接用上：${[...used].map(([k, v]) => `${nameOf(k)}×${v}`).join('、')}`);
  if (raw.size) {
    lines.push('还缺这些原材料（得去弄）：');
    for (const [k, v] of raw) {
      const d = (K.drops.get(k) || []);
      const self = d.find(x => x.from === 'block' && x.id === k);
      const blk = self ? k : d.find(x => x.from === 'block')?.id;
      const ht = blk && harvestTool(blk);
      const how = blk ? `挖${nameOf(blk)}${ht ? `（${ht.text}）` : ''}` : d.find(x => x.from === 'entity') ? `打${nameOf(d.find(x => x.from === 'entity').id)}` : '查 obtain';
      lines.push(`  · ${label(k)}×${v} ← ${how}`);
    }
  }
  if (steps.length) {
    lines.push('按顺序做：');
    steps.forEach((s, i) => {
      const where = s.station === 'inventory' ? '背包2×2' : s.station ? `${nameOf(s.station)}${s.guess ? '(推测)' : ''}` : s.type;
      const tools = s.tools.length ? `，工具 ${s.tools.map(fmtSlot).join('、')}` : '';
      lines.push(`  ${i + 1}. [${where}] ${s.inputs.map(x => `${nameOf(x.item)}×${x.count}`).join(' + ')}${tools} → ${label(s.item)}×${s.makes}（craft 用 itemName=${s.item.split(':')[0] === 'minecraft' ? s.item.split(':')[1] : s.item}，count=${s.times}）`);
    });
  }
  if (!raw.size && !steps.length) lines.push('背包里已经有了。');
  return lines.join('\n');
}

// ------------------------------------------------------------------ 说明书 / 提示 / 任务 全文搜

function guide (q, limit = 4) {
  load();
  const s = String(q || '').trim();
  if (!s) return '要搜什么？';
  const ids = resolve(s, 3);
  const lower = s.toLowerCase();
  const hits = [];
  for (const e of K.guide) {
    let score = 0;
    if (e.name.includes(s) || e.name.toLowerCase().includes(lower)) score += 5;
    if (ids.some(id => e.items.includes(id) || e.icon === id)) score += 4;
    if (e.text.includes(s)) score += 2;
    if (score) hits.push({ score, e });
  }
  hits.sort((a, b) => b.score - a.score);
  const lines = hits.slice(0, limit).map(({ e }) => {
    const i = Math.max(0, e.text.indexOf(s) - 60);
    return `《${e.name}》(${e.book})：${e.text.slice(i, i + 400).replace(/\n+/g, ' ')}`;
  });
  for (const id of ids) {
    const t = K.tooltips.get(id);
    if (t?.length) lines.push(`${label(id)} 的物品提示：${t.join(' ')}`);
  }
  return lines.length ? lines.join('\n') : `说明书和物品提示里没搜到「${s}」。可以再用 knowledge_search 查任务书。`;
}

/** 一次给全貌：是什么、怎么来、怎么做、能干嘛（各取最要紧的一两行） */
function describe (q) {
  const cands = resolve(q, 4);
  if (!cands.length) return `没找到「${q}」。`;
  const id = cands[0];
  const parts = [obtain(id), recipesFor(id, 2), usesOf(id, 3)];
  const other = cands.slice(1).map(label);
  return parts.join('\n\n') + (other.length ? `\n\n（也可能是：${other.join('、')}）` : '');
}

// ------------------------------------------------------------------ 自测 / 手查

function selftest () {
  let pass = 0; let total = 0;
  const check = (label2, cond, detail = '') => {
    total++; if (cond) pass++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label2}${cond ? '' : `  ${String(detail).slice(0, 300)}`}`);
  };
  load();
  console.log(`\n加载：${K.recipes.length} 条配方，${K.tags.size} 个标签，${K.drops.size} 种物品有掉落来源，${K.buildMs}ms`);
  console.log(`KubeJS：删 ${K.kubejs.removed} / 换 ${K.kubejs.replaced} / 加 ${K.kubejs.added}`);

  console.log('\n名字解析');
  check('中文：木镐 → minecraft:wooden_pickaxe', resolveOne('木镐') === 'minecraft:wooden_pickaxe', resolve('木镐'));
  check('英文：iron ingot → minecraft:iron_ingot', resolveOne('iron ingot') === 'minecraft:iron_ingot', resolve('iron ingot'));
  check('裸 id：oak_log → minecraft:oak_log', resolveOne('oak_log') === 'minecraft:oak_log');
  check('模组 id 原样', resolveOne('farmersdelight:cooking_pot') === 'farmersdelight:cooking_pot');

  console.log('\n配方');
  check('木镐能在工作台做', /工作台/.test(recipesFor('minecraft:wooden_pickaxe')), recipesFor('minecraft:wooden_pickaxe'));
  check('木板在背包里就能做', /背包里就能做/.test(recipesFor('minecraft:oak_planks')), recipesFor('minecraft:oak_planks'));
  check('铁锭能用熔炉烧', /熔炉/.test(recipesFor('minecraft:iron_ingot')), recipesFor('minecraft:iron_ingot'));
  check('厨锅配方指向厨锅', K.recipes.some(r => r.type === 'farmersdelight:cooking' && r.station === 'farmersdelight:cooking_pot'));

  console.log('\nKubeJS 修改生效');
  check('crockpot:tomato 的配方被删光', !(K.byOutput.get('crockpot:tomato') || []).length);
  check('KubeJS 新增的配方在（如 cosmopolitan:tisane 的厨锅配方）', (K.byOutput.get('cosmopolitan:tisane') || []).some(i => K.recipes[i].source === 'kubejs'));
  check('replaceInput 全局换原料：没有配方还在用 alexsmobsdelight:raw_turtle_meat',
    !(K.byInput.get('alexsmobsdelight:raw_turtle_meat') || []).length, (K.byInput.get('alexsmobsdelight:raw_turtle_meat') || []).map(i => K.recipes[i].id).slice(0, 3));

  console.log('\n获取途径');
  check('橡木原木：直接挖、用斧', /直接挖/.test(obtain('minecraft:oak_log')), obtain('minecraft:oak_log'));
  check('铁矿石要石镐', /石镐/.test(obtain('minecraft:iron_ore')), obtain('minecraft:iron_ore'));
  check('钻石：挖钻石矿会掉', /钻石矿/.test(obtain('minecraft:diamond')), obtain('minecraft:diamond'));
  check('腐肉：打僵尸', /僵尸/.test(obtain('minecraft:rotten_flesh')), obtain('minecraft:rotten_flesh'));

  console.log('\n用途 / 工作站');
  check('厨锅是工作站', /工作站/.test(usesOf('farmersdelight:cooking_pot')), usesOf('farmersdelight:cooking_pot'));
  check('煤炭能当原料', /原料/.test(usesOf('minecraft:coal')));

  console.log('\n材料树');
  const t1 = materialTree('minecraft:wooden_pickaxe', 1, []);
  check('空背包做木镐 → 缺原木', /原木|log/i.test(t1), t1);
  check('空背包做木镐 → 步骤里有木棍和木板', /木棍/.test(t1) && /木板/.test(t1), t1);
  const t2 = materialTree('minecraft:wooden_pickaxe', 1, [{ name: 'oak_log', count: 3 }]);
  check('有 3 原木 → 不再缺原材料', !/还缺/.test(t2), t2);
  const t3 = materialTree('minecraft:stone_pickaxe', 1, [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }]);
  check('有圆石和木棍 → 一步做石镐', /背包里能直接用上/.test(t3) && !/还缺/.test(t3), t3);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const q = rest.join(' ');
  if (cmd === '--selftest') selftest();
  else if (cmd === 'recipe') console.log(recipesFor(q));
  else if (cmd === 'uses') console.log(usesOf(q));
  else if (cmd === 'obtain') console.log(obtain(q));
  else if (cmd === 'tree') console.log(materialTree(q, 1, []));
  else if (cmd === 'guide') console.log(guide(q));
  else if (cmd === 'resolve') console.log(resolve(q, 10).map(label).join('\n'));
  else if (cmd === 'describe') console.log(describe(q));
  else console.log('用法：node knowledge.js --selftest | recipe|uses|obtain|tree|guide|resolve|describe <名字>');
}

module.exports = { load, resolve, recipesFor, usesOf, obtain, materialTree, guide, describe, label, harvestTool, recipeRank, stationOf };
