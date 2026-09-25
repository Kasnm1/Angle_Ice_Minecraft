#!/usr/bin/env node
'use strict';

/**
 * 在模拟环境里跑整合包的 KubeJS server_scripts，把它对「配方 / 标签 / 掉落 / 交易」的修改记下来。
 *
 * ## 为什么不直接进游戏 dump
 *
 * 那样最准，但要玩家开一次单人世界。这个包的脚本全是**声明式**的
 * （`event.remove({output:…})`、`event.shaped(…)`、`LootJS…addLoot(…)`），
 * 在一个假的 `ServerEvents` / `LootJS` 下跑一遍就能拿到同样的信息，而且离线、随时可重跑。
 *
 * 做不到的：脚本里如果依赖运行期数据（比如 `event.forEachRecipe` 遍历现有配方再改），
 * 这里拿不到。本包没有这种写法；遇到了会记进 `warnings`，不静默。
 *
 * ## 输出
 *
 * knowledge/generated/kubejs.json：
 *   recipeOps  按脚本顺序的 remove / replaceInput / replaceOutput / add
 *   tagOps     add / remove / removeAll / removeAllTagsFrom
 *   lootOps    给某张表 / 某方块 / 某实体 加或删掉落
 *   trades     村民交易（MoreJS）
 *   warnings   没认出来的调用
 *
 * 用法：node kubejs_emulate.js [整合包目录]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const PACK = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/minecraft');
const SCRIPTS = path.join(PACK, 'kubejs', 'server_scripts');
const OUT = path.join(__dirname, '..', 'generated', 'kubejs.json');

const out = { recipeOps: [], tagOps: [], lootOps: [], trades: [], warnings: [], files: [] };
let currentFile = '';
const warn = (msg) => { if (out.warnings.length < 300) out.warnings.push(`${currentFile}: ${msg}`); };

// ------------------------------------------------------------------ 物品 / 原料的表示

const ITEM = Symbol('item');

/** KubeJS 里原料可以写成 'x' / '3x x' / '#tag' / Item.of(...) / 数组(任选其一) —— 统一成 JSON 原料。 */
function ing (v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(ing).filter(Boolean);
  if (v[ITEM]) return { ...v[ITEM] };
  if (typeof v === 'object') {
    if (v.item || v.tag) return { ...v };
    return null;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d+)\s*x\s+(.+)$/i);
  const count = m ? parseInt(m[1]) : 1;
  const id = (m ? m[2] : s).trim();
  if (id.startsWith('#')) return count > 1 ? { tag: id.slice(1), count } : { tag: id.slice(1) };
  return count > 1 ? { item: id, count } : { item: id };
}

/** 可链式调用的物品对象：Item.of('x', 2).withChance(0.1).withNBT(...) */
function itemObj (id, count, extra) {
  const base = ing(id) || {};
  if (typeof count === 'number') base.count = count;
  const data = { ...base, ...(extra || {}) };
  const self = new Proxy({}, {
    get (_, k) {
      if (k === ITEM) return data;
      if (k === 'id') return data.item;
      if (k === 'count') return data.count || 1;
      if (k === 'toString' || k === Symbol.toPrimitive) return () => data.item || `#${data.tag}`;
      return (...a) => {
        if (k === 'withChance' || k === 'chance') data.chance = a[0];
        if (k === 'withCount') data.count = a[0];
        if (k === 'when' && typeof a[0] === 'function') {
          // LootEntry.of(x).when(c => c.randomChance(0.1))
          a[0](new Proxy({}, { get: (_, kk) => (...aa) => { if (kk === 'randomChance') data.chance = aa[0]; return self; } }));
        }
        return self;
      };
    },
  });
  return self;
}

/** 什么都接、什么都返回自己的对象。用来吞掉我们不关心的 API（Utils、console、Java…）。 */
function sink (label) {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => '' : (k === 'then' ? undefined : sink(`${label}.${String(k)}`))),
    apply: () => sink(label),
  });
}

/** 记录链式调用：返回的对象对任何方法都记一笔再返回自己。 */
function recorder (onCall) {
  const self = new Proxy({}, {
    get: (_, k) => (k === 'then' ? undefined : (...a) => { onCall(String(k), a); return self; }),
  });
  return self;
}

// ------------------------------------------------------------------ 配方事件

function filterJson (f) {
  if (f == null) return {};
  if (Array.isArray(f)) return { or: f.map(filterJson) };
  if (f instanceof RegExp) return { id: { regex: f.source, flags: f.flags } };
  if (typeof f !== 'object') return { id: String(f) };
  const o = {};
  for (const [k, v] of Object.entries(f)) {
    if (v instanceof RegExp) o[k] = { regex: v.source, flags: v.flags };
    else if (k === 'not') o.not = filterJson(v);
    else o[k] = v && v[ITEM] ? (v[ITEM].item || `#${v[ITEM].tag}`) : v;
  }
  return o;
}

function addRecipe (json) {
  const rec = { op: 'add', recipe: json };
  out.recipeOps.push(rec);
  // 返回值还能继续链：.id('x') / .xp(1) / .replaceIngredient(...)
  return recorder((k, a) => {
    if (k === 'id') rec.recipe.__id = String(a[0]);
    else if (k === 'replaceIngredient') {
      rec.recipe.__replace = (rec.recipe.__replace || []).concat([[ing(a[0].item ? a[0].item : a[0]), ing(a[1])]]);
    }
  });
}

const cookLike = (type) => (output, input, xp, time) =>
  addRecipe({ type, ingredient: ing(input), result: ing(output), experience: xp, cookingtime: time });

function recipesEvent () {
  // event.recipes.<ns>.<type>(...) —— 已知的几种按签名翻译，其余原样记下参数
  const KNOWN = {
    'farmersdelight:cooking': (inputs, output, xp, time, container) =>
      ({ type: 'farmersdelight:cooking', ingredients: ing([].concat(inputs)), result: ing(output), experience: xp, cookingtime: time, container: ing(container) }),
    'farmersdelight:cutting': (input, tool, outputs) =>
      ({ type: 'farmersdelight:cutting', ingredients: [ing(input)], tool: ing(tool), result: ing([].concat(outputs)) }),
    'ars_nouveau:imbuement': (input, output, source, pedestals) =>
      ({ type: 'ars_nouveau:imbuement', input: ing(input), output: ing(output), source, pedestalItems: ing([].concat(pedestals || [])) }),
    'ars_nouveau:enchanting_apparatus': (pedestals, reagent, output, source) =>
      ({ type: 'ars_nouveau:enchanting_apparatus', pedestalItems: ing([].concat(pedestals || [])), reagent: [ing(reagent)], output: ing(output), sourceCost: source }),
  };
  const recipes = new Proxy({}, {
    get: (_, ns) => new Proxy({}, {
      get: (_, type) => (...args) => {
        const t = `${String(ns)}:${String(type)}`;
        if (KNOWN[t]) return addRecipe(KNOWN[t](...args));
        warn(`未专门处理的配方类型 ${t}，按参数原样记录`);
        return addRecipe({ type: t, __kubejsArgs: JSON.parse(JSON.stringify(args.map(a => ing(a) || a))) });
      },
    }),
  });

  return {
    recipes,
    remove: (f) => out.recipeOps.push({ op: 'remove', filter: filterJson(f) }),
    replaceInput: (f, from, to) => out.recipeOps.push({ op: 'replaceInput', filter: filterJson(f), from: ing(from), to: ing(to) }),
    replaceOutput: (f, from, to) => out.recipeOps.push({ op: 'replaceOutput', filter: filterJson(f), from: ing(from), to: ing(to) }),
    shaped: (output, pattern, key) => {
      // 两种写法：['A B', ...] + {A: item}，或者直接二维数组 [['item','',...], ...]（本包 shaped2.js 用的就是后者）
      if (Array.isArray(pattern) && pattern.some(row => Array.isArray(row))) {
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const k = {}; const byItem = new Map();
        const rows = pattern.map(row => [].concat(row).map(cell => {
          const v = cell && cell[ITEM] ? (cell[ITEM].item || `#${cell[ITEM].tag}`) : String(cell || '');
          if (!v.trim()) return ' ';
          if (!byItem.has(v)) { const ch = letters[byItem.size]; byItem.set(v, ch); k[ch] = ing(cell); }
          return byItem.get(v);
        }).join(''));
        return addRecipe({ type: 'minecraft:crafting_shaped', pattern: rows, key: k, result: ing(output) });
      }
      const k = {};
      for (const [c, v] of Object.entries(key || {})) k[c] = ing(v);
      return addRecipe({ type: 'minecraft:crafting_shaped', pattern, key: k, result: ing(output) });
    },
    shapeless: (output, inputs) => addRecipe({ type: 'minecraft:crafting_shapeless', ingredients: ing([].concat(inputs)), result: ing(output) }),
    smelting: cookLike('minecraft:smelting'),
    blasting: cookLike('minecraft:blasting'),
    smoking: cookLike('minecraft:smoking'),
    campfireCooking: cookLike('minecraft:campfire_cooking'),
    stonecutting: (output, input) => addRecipe({ type: 'minecraft:stonecutting', ingredient: ing(input), result: ing(output) }),
    smithing: (output, a, b, c) => (c === undefined
      ? addRecipe({ type: 'minecraft:smithing_transform', base: ing(a), addition: ing(b), result: ing(output) })
      : addRecipe({ type: 'minecraft:smithing_transform', template: ing(a), base: ing(b), addition: ing(c), result: ing(output) })),
    custom: (json) => addRecipe(JSON.parse(JSON.stringify(json))),
    forEachRecipe: () => warn('forEachRecipe 依赖运行期配方表，模拟环境里跳过'),
    findRecipes: () => { warn('findRecipes 依赖运行期配方表，模拟环境里跳过'); return []; },
    printTypes: () => {}, printExamples: () => {},
  };
}

// ------------------------------------------------------------------ 标签事件

function tagsEvent (kind) {
  const push = (op, tag, items) => out.tagOps.push({ op, kind, tag: String(tag).replace(/^#/, ''), items: [].concat(items || []).map(String) });
  return {
    add: (tag, items) => push('add', tag, items),
    remove: (tag, items) => push('remove', tag, items),
    removeAll: (tag) => push('removeAll', tag, []),
    removeAllTagsFrom: (items) => out.tagOps.push({ op: 'removeAllTagsFrom', kind, items: [].concat(items).map(String) }),
    get: (tag) => recorder((k, a) => {
      if (k === 'add') push('add', tag, a[0]);
      else if (k === 'remove') push('remove', tag, a[0]);
      else if (k === 'removeAll') push('removeAll', tag, []);
    }),
  };
}

// ------------------------------------------------------------------ 掉落事件（原生 KubeJS）

function lootTablesEvent (kind) {
  const handle = (op) => (id, cb) => {
    const rec = { source: 'kubejs', target: { kind, ids: [String(id)] }, op: 'add', clear: false, items: [] };
    const pool = recorder((k, a) => {
      if (k === 'addItem' || k === 'addEntry') rec.items.push(ing(a[0]));
    });
    const table = recorder((k, a) => {
      if (k === 'clearPools') rec.clear = true;
      if (k === 'addPool' && typeof a[0] === 'function') a[0](pool);
    });
    try { cb && cb(table); } catch (e) { warn(`${op} ${id} 回调出错：${e.message}`); }
    out.lootOps.push(rec);
  };
  return {
    addBlock: handle('addBlock'), modifyBlock: handle('modifyBlock'),
    addEntity: handle('addEntity'), modifyEntity: handle('modifyEntity'),
    addSimpleBlock: (id, drop) => out.lootOps.push({ source: 'kubejs', target: { kind, ids: [String(id)] }, op: 'add', clear: true, items: [ing(drop || id)] }),
  };
}

// ------------------------------------------------------------------ LootJS

function lootJsEvent () {
  const modifier = (kind) => (...ids) => {
    const target = { kind, ids: ids.flat().map(x => (x instanceof RegExp ? `/${x.source}/` : String(x))) };
    const self = recorder((k, a) => {
      const items = [];
      const collect = (v) => {
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && (v[ITEM] || typeof v === 'string')) items.push(ing(v));
      };
      if (k === 'addLoot' || k === 'addWeightedLoot' || k === 'addAlternativesLoot' || k === 'addSequenceLoot') {
        a.forEach(collect);
        out.lootOps.push({ source: 'lootjs', target, op: 'add', items });
      } else if (k === 'removeLoot') {
        a.forEach(collect);
        out.lootOps.push({ source: 'lootjs', target, op: 'remove', items });
      } else if (k === 'replaceLoot') {
        out.lootOps.push({ source: 'lootjs', target, op: 'replace', from: ing(a[0]), to: ing(a[1]) });
      }
    });
    return self;
  };
  return {
    addLootTableModifier: modifier('table'),
    addBlockLootModifier: modifier('block'),
    addEntityLootModifier: modifier('entity'),
    addLootTypeModifier: modifier('type'),
    enableLogging: () => {}, disableLootModification: () => {}, disableWitherStarDrop: () => {},
  };
}

// ------------------------------------------------------------------ 交易（MoreJS）

function tradesEvent () {
  return {
    addTrade: (profession, level, inputs, output) => {
      out.trades.push({ profession: String(profession), level, inputs: ing([].concat(inputs)), output: ing(output) });
      return sink('trade');
    },
    removeModdedTrades: () => {}, removeVanillaTrades: () => {}, removeTrades: () => {},
  };
}

// ------------------------------------------------------------------ 运行

function makeContext () {
  const on = (factory) => (...args) => {
    const cb = args.find(a => typeof a === 'function');
    const extra = args.filter(a => typeof a !== 'function');
    try { cb(factory(...extra)); } catch (e) { warn(`回调出错：${e.message}`); }
  };
  const ctx = {
    ServerEvents: new Proxy({
      recipes: on(recipesEvent),
      tags: on(kind => tagsEvent(String(kind))),
      blockLootTables: on(() => lootTablesEvent('block')),
      entityLootTables: on(() => lootTablesEvent('entity')),
      chestLootTables: on(() => lootTablesEvent('table')),
      genericLootTables: on(() => lootTablesEvent('table')),
    }, { get: (t, k) => t[k] || (() => {}) }),
    LootJS: { modifiers: on(lootJsEvent) },
    MoreJSEvents: new Proxy({ villagerTrades: on(tradesEvent), wandererTrades: on(tradesEvent) }, { get: (t, k) => t[k] || (() => {}) }),
    Item: { of: (id, a, b) => itemObj(id, typeof a === 'number' ? a : undefined, typeof a === 'string' ? { nbt: a } : (typeof b === 'string' ? { nbt: b } : undefined)), empty: itemObj('minecraft:air') },
    Ingredient: { of: (id, n) => itemObj(id, n), all: itemObj('*') },
    LootEntry: { of: (id, n) => itemObj(id, n) },
    console: { info: () => {}, log: () => {}, warn: () => {}, error: () => {} },
  };
  for (const k of ['Utils', 'Java', 'JsonIO', 'Text', 'Fluid', 'Platform', 'global', 'StartupEvents', 'ClientEvents',
    'PlayerEvents', 'EntityEvents', 'BlockEvents', 'ItemEvents', 'LevelEvents', 'NetworkEvents', 'CommonAddedEvents']) {
    if (!(k in ctx)) ctx[k] = sink(k);
  }
  return vm.createContext(ctx);
}

function listScripts (dir) {
  const res = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) res.push(p);
    }
  };
  walk(dir);
  // KubeJS：文件头 `// priority: N` 大的先跑，同优先级按路径
  const prio = (p) => {
    const m = fs.readFileSync(p, 'utf8').slice(0, 200).match(/\/\/\s*priority\s*:\s*(-?\d+)/);
    return m ? parseInt(m[1]) : 0;
  };
  return res.sort((a, b) => prio(b) - prio(a) || a.localeCompare(b));
}

function main () {
  if (!fs.existsSync(SCRIPTS)) { console.error(`没有 ${SCRIPTS}`); process.exit(1); }
  const ctx = makeContext();
  for (const file of listScripts(SCRIPTS)) {
    currentFile = path.relative(SCRIPTS, file);
    out.files.push(currentFile);
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: currentFile, timeout: 10000 });
    } catch (e) {
      warn(`脚本出错：${e.message}`);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const count = (arr, op) => arr.filter(x => x.op === op).length;
  console.log(`脚本 ${out.files.length} 个`);
  console.log(`配方：删 ${count(out.recipeOps, 'remove')} / 换原料 ${count(out.recipeOps, 'replaceInput')} / 换产物 ${count(out.recipeOps, 'replaceOutput')} / 新增 ${count(out.recipeOps, 'add')}`);
  console.log(`标签操作 ${out.tagOps.length}，掉落操作 ${out.lootOps.length}，交易 ${out.trades.length}，警告 ${out.warnings.length}`);
  for (const w of out.warnings.slice(0, 10)) console.log(`  ⚠ ${w}`);
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
module.exports = { ing };
