'use strict';

/**
 * tool-choice.js —— **挖方块之前该拿什么工具**（判据只此一处）。
 *
 * 主人 2026-09-29 实机：她拿着镐子挖黏土、拿着剑砍树。原因很简单 ——
 * 真正会换工具的是 `mineflayer-tool` 插件，而这个包在 Windows 上**没装**
 * （启动日志："三个反射插件都没装"），所以 `bot.dig()` 手上是什么就用什么。
 *
 * 寻路库本来有一份"挑最快工具"（`node_modules/mineflayer-pathfinder/index.js:45`
 * `bot.pathfinder.bestHarvestTool(block)`，按 `block.digTime(tool.type, …)` 比最快），
 * 但它有两个缺口，所以不能直接用：
 *   ① 它只看 `bot.inventory.items()`（身上的 36 格），**看不到精妙背包**里的工具 ——
 *      我们的工具经常在背包里（见 `containers.ensureCarried` / `fetchFromBackpack`）；
 *   ② 调色板注入的模组方块，`material` / `harvestTools` 可能是空的，那时**所有工具
 *      digTime 一样**，它返回背包里第一件东西（可能是剑、可能是土块）—— 等于没挑。
 *
 * 所以这里自己判：**先按判据定"该用哪一类工具"**（铲 / 斧 / 镐），
 * 再在这一类里挑 digTime 最快的；身上没有这一类就返回 null（照旧空手/用手上的挖）。
 *
 * ## 判据（按可靠性从高到低，**只有这一处**）
 *
 *   ① `block.material`：原版是 `mineable/shovel` / `mineable/axe` / `mineable/pickaxe`
 *      （实测 `minecraft-data` 1.20.1：clay → mineable/shovel、oak_log → mineable/axe、
 *      stone → mineable/pickaxe）。**权威**，有就用。
 *   ② `block.harvestTools`：一个 `{ itemId: true }` 表（原版 stone 是 4 把镐）。
 *      从表里任意一项反查物品名里的工具后缀。挖得动它的工具 = 它该用的工具。
 *   ③ **名字兜底**（`NAME_RULES`）：模组方块的 material 和 harvestTools 都空时，
 *      按方块名字规律猜 —— 这是"尽最大努力"，不是权威。
 *
 * ## 为什么"没有合适工具"要返回 null 而不是报错
 *
 * 任务要求："没有合适工具就照旧空手/用手上的挖，**不许因为没铲子就不挖**"。
 * 所以 NULL 的语义是"我挑不出来"，调用方拿到 null 就维持原样继续挖。
 */

/** 工具后缀 → 类别。判据的最终归类只有这一处。 */
const TOOL_RE = {
  shovel: /_shovel$/,
  axe: /_axe$/,
  pickaxe: /_pickaxe$/,
};

/**
 * 名字兜底表：方块名命中这些规律时该用什么工具。
 *
 * ⚠️ **只此一份**。顺序有意义（先铲、再斧、最后镐），因为
 * `xxx_grass_block` 这种名字两头都沾边时，"能被铲子快速挖掉"更符合直觉。
 * 这些规律来自原版挖矿手感 + 整合包常见方块命名（泥土系、木系）。
 */
const NAME_RULES = [
  // 铲：土 / 沙 / 黏土 / 雪 / 耕地 / 泥巴 / 混凝土粉末 / 淤泥（silt）…
  // 用"结尾锚定"是为了别把 `sandstone` 之外的 `soul_soil`（对）和
  // `soil_block`（对）误伤；`silt` 是任务点名的模组方块（xxx:silt），也归铲。
  { kind: 'shovel', re: /(^|:)(clay|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|farmland|dirt_path|sand|red_sand|sandstone|gravel|snow|snow_block|soul_soil|soul_sand|mud|muddy_mangrove_roots|concrete_powder|suspicious_sand|suspicious_gravel|silt|siltstone|loam)$/ },
  // 斧：原木 / 木头 / 菌柄 / 木板（人工的，但挖的时候同样是斧最快）
  { kind: 'axe', re: /(^|_)(log|wood|planks|stem|hyphae)$/ },
];

/**
 * 这个方块**该用哪一类工具挖**。返回 `'shovel' | 'axe' | 'pickaxe' | null`。
 *
 * null 的语义是"**我不知道**"（不是"不需要工具"）—— 比如一个名字陌生的模组方块，
 * 三种判据都没命中。调用方拿到 null 就维持原样（用手上的 / 空手）。
 *
 * @param {object} block  mineflayer 的方块对象
 * @param {object} [lookup]  `{ itemNameById(id) }`（可选；用来把 harvestTools 的 id 翻成名字）
 */
function toolKindFor (block, lookup = null) {
  if (!block) return null;
  // ① material：原版权威判据
  const m = String(block.material || '');
  if (/^mineable\/shovel$/.test(m)) return 'shovel';
  if (/^mineable\/axe$/.test(m)) return 'axe';
  if (/^mineable\/pickaxe$/.test(m)) return 'pickaxe';
  // ② harvestTools：挖得动它的工具就是它该用的工具
  const ht = block.harvestTools;
  if (ht && typeof ht === 'object' && lookup?.itemNameById) {
    for (const id of Object.keys(ht)) {
      if (ht[id] !== true) continue;
      const name = String(lookup.itemNameById(id) || '');
      for (const [kind, re] of Object.entries(TOOL_RE)) if (re.test(name)) return kind;
    }
  }
  // ③ 名字兜底（模组方块 material/harvestTools 都空时的唯一线索）
  const name = String(block.name || '');
  for (const r of NAME_RULES) if (r.re.test(name)) return r.kind;
  return null;
}

/**
 * 在"这一类工具"里挑 **digTime 最快**的那件（跟 `bestHarvestTool` 同一套比法）。
 * 类别里的工具 digTime 通常一样，这时返回第一件（稳定、可预期）。
 *
 * @param {Array} items   候选物品（`{name, type, …}`）
 * @param {object} block
 * @param {string} kind   `toolKindFor` 的结果
 */
function fastestOfKind (items, block, kind) {
  const re = TOOL_RE[kind];
  if (!re) return null;
  const cands = (items || []).filter(it => it && re.test(String(it.name || '')));
  if (!cands.length) return null;
  if (!block?.digTime) return cands[0];
  let best = cands[0]; let bestT = Infinity;
  for (const it of cands) {
    let t;
    try { t = block.digTime(it.type); } catch (_) { t = undefined; }
    if (!Number.isFinite(t)) continue;
    if (t < bestT) { bestT = t; best = it; }
  }
  return best;
}

/**
 * 挖这个方块该拿哪件工具（**身上**的；背包里的由调用方用 `ensureCarried` 去拿）。
 *
 * 返回 `null` = 身上没有合适的工具（或不认识这个方块）→ 调用方照旧徒手/用当前手上的挖。
 *
 * @param {object} bot
 * @param {object} block
 * @returns {{item:object, kind:string}|null}
 */
function pickDigTool (bot, block) {
  let items = [];
  try { items = bot?.inventory?.items?.() || []; } catch (_) { items = []; }
  const kind = toolKindFor(block, { itemNameById: (id) => itemNameById(bot, id) });
  if (kind) {
    const it = fastestOfKind(items, block, kind);
    if (it) return { item: it, kind };
  }
  // 判据没命中（模组方块）：退回"比 digTime 最快"的原生行为，但**只认真正的工具**，
  // 免得把背包第一件（剑/土块）当成工具（那正是 bestHarvestTool 的坑）。
  const anyTool = ['pickaxe', 'axe', 'shovel']
    .map(k => fastestOfKind(items, block, k))
    .filter(Boolean);
  if (!anyTool.length) return null;
  // 挑这一类里 digTime 最快的一件；若拿不到 digTime，按 镐 > 斧 > 铲 的通用性兜底
  let best = anyTool[0];
  for (const it of anyTool.slice(1)) {
    let a; let b;
    try { a = block?.digTime?.(best.type); b = block?.digTime?.(it.type); } catch (_) {}
    if (Number.isFinite(a) && Number.isFinite(b) && b < a) best = it;
  }
  return { item: best, kind: kind || 'unknown' };
}

/** 物品 id → 名字（注册表查不到给 null，不编）。 */
function itemNameById (bot, id) {
  try {
    const it = bot?.registry?.items?.[id];
    return it?.name || bot?.registry?.itemsById?.[id]?.name || null;
  } catch (_) { return null; }
}

/**
 * 把工具换到手上（**挖之前**调用）。薄薄一层，方便所有挖方块的调用点复用同一段：
 *   ① 手上已经是合适的那件 → 不动（`bot.heldItem` 和挑出来的 type 相同）；
 *   ② 身上有合适的 → `bot.equip`；
 *   ③ 没有 → 返回 `{ took:false, why }`，**不抛**（不许因为没铲子就不挖）。
 *
 * 不负责从精妙背包拿 —— 那要 `ensureCarried`（需要 `state`），由调用方决定要不要去拿。
 *
 * @returns {Promise<{took:boolean, kind:string|null, name?:string, why?:string}>}
 */
async function equipDigTool (bot, block) {
  try {
    const pick = pickDigTool(bot, block);
    if (!pick) return { took: false, kind: null, why: '身上没有合适的工具（照旧挖）' };
    if (bot.heldItem && bot.heldItem.type === pick.item.type) return { took: false, kind: pick.kind, name: pick.item.name, why: '已经拿在手上' };
    await bot.equip(pick.item, 'hand');
    return { took: true, kind: pick.kind, name: pick.item.name };
  } catch (e) {
    // 换工具失败**不该挡住挖**（手里原来的照样能挖）
    return { took: false, kind: null, why: `换工具没成：${String(e?.message || e).slice(0, 60)}` };
  }
}

// ------------------------------------------------------------------ 自测
//
// 测的是**本文件跑的那份**函数（直接 require 自己，不另抄一份实现）。
// 方块用真的 1.20.1 数据（prismarine-block + minecraft-data），不是照实现手写的假方块 ——
// 这样 `material` / `harvestTools` / `digTime` 三条判据都走的是真实形状。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['挖之前挑工具：镐/铲/斧按方块选，选不到就照旧挖', async (t) => {
    const { check } = t;
      {
        // ---- 造真方块（1.20.1 原版）----
        // 走本项目一直在用的那一套：prismarine-registry（按版本单例）+ prismarine-block。
        // 实测：clay → mineable/shovel、oak_log → mineable/axe、stone → mineable/pickaxe。
        const reg = require('prismarine-registry')('1.20.1');
        const mcd = reg;   // prismarine-registry 就是 minecraft-data 的封装，字段同名
        const Block = require('prismarine-block')(reg);
        const B = (name) => Block.fromStateId(reg.blocksByName[name].defaultState, 0);
        const clay = B('clay'); const oakLog = B('oak_log'); const stone = B('stone');
        const dirt = B('dirt'); const sand = B('sand'); const planks = B('oak_planks');
        // 模组方块：material / harvestTools 都空，只有名字（模拟调色板注入的方块）
        const mkMod = (name) => { const b = Object.create(B('clay')); b.name = name; b.material = undefined; b.harvestTools = undefined; return b; };
        const silt = mkMod('xxx:silt');
        const unknownBlock = mkMod('xxx:mystery_thing');

        // ---- 造假 bot：木镐 + 铁铲 + 石斧（type 用真物品 id，digTime 才比得出来）----
        const itemOf = (name, type) => ({ name, count: 1, type, metadata: 0, stackSize: 1, nbt: null });
        const wpick = itemOf('minecraft:wooden_pickaxe', mcd.itemsByName.wooden_pickaxe.id);
        const ishovel = itemOf('minecraft:iron_shovel', mcd.itemsByName.iron_shovel.id);
        const saxe = itemOf('minecraft:stone_axe', mcd.itemsByName.stone_axe.id);
        const sword = itemOf('minecraft:iron_sword', mcd.itemsByName.iron_sword.id);
        const mkBot = (items) => ({
          registry: { items: Object.fromEntries(Object.entries(mcd.items).map(([id, it]) => [id, it])) },
          inventory: { items: () => items },
        });

        const bot = mkBot([wpick, ishovel, saxe]);

        // ---- 判据：该用哪一类 ----
        check('★ clay（原版 material=mineable/shovel）→ 铲', toolKindFor(clay), 'shovel');
        check('★ oak_log（material=mineable/axe）→ 斧', toolKindFor(oakLog), 'axe');
        check('★ stone（material=mineable/pickaxe）→ 镐', toolKindFor(stone), 'pickaxe');
        check('dirt → 铲', toolKindFor(dirt), 'shovel');
        check('sand → 铲', toolKindFor(sand), 'shovel');
        check('oak_planks → 斧', toolKindFor(planks), 'axe');
        check('★ 模组方块 xxx:silt（无 material）→ 按名字兜底成铲', toolKindFor(silt), 'shovel');
        check('★ 名字也认不出的模组方块 → null（"不知道"，不是"随便"）', toolKindFor(unknownBlock), null);
        check('空方块 → null', toolKindFor(null), null);

        // ---- 挑工具：三类方块各挑对该挑的那件 ----
        check('★ 挖 clay → 铁铲', pickDigTool(bot, clay)?.item?.name, 'minecraft:iron_shovel');
        check('挖 clay 报的 kind = shovel', pickDigTool(bot, clay)?.kind, 'shovel');
        check('★ 挖 oak_log → 石斧', pickDigTool(bot, oakLog)?.item?.name, 'minecraft:stone_axe');
        check('挖 oak_log 报的 kind = axe', pickDigTool(bot, oakLog)?.kind, 'axe');
        check('★ 挖 stone → 木镐', pickDigTool(bot, stone)?.item?.name, 'minecraft:wooden_pickaxe');
        check('挖 stone 报的 kind = pickaxe', pickDigTool(bot, stone)?.kind, 'pickaxe');
        check('挖 xxx:silt（模组，名字兜底）→ 铁铲', pickDigTool(bot, silt)?.item?.name, 'minecraft:iron_shovel');

        // ---- 同类里挑 digTime 最快的（两把镐时选快的）----
        const dpick = itemOf('minecraft:diamond_pickaxe', mcd.itemsByName.diamond_pickaxe.id);
        check('★ 同是镐 → 挑挖得最快的那把（钻石镐）', pickDigTool(mkBot([wpick, dpick]), stone)?.item?.name, 'minecraft:diamond_pickaxe');

        // ---- 身上没有合适的工具 → null（调用方照旧挖，不许因此不挖）----
        const noTools = mkBot([sword, itemOf('minecraft:cobblestone', mcd.itemsByName.cobblestone.id)]);
        check('★ 身上只有剑和方块 → 挖 stone 返回 null（不硬塞剑）', pickDigTool(noTools, stone), null);
        check('★ 挖 clay 也返回 null（没有铲子）', pickDigTool(noTools, clay), null);
        check('★ 空背包 → null', pickDigTool(mkBot([]), stone), null);
        check('没有 inventory 的 bot 也不抛 → null', pickDigTool({}, stone), null);

        // ---- 判据没命中的模组方块：退回"比 digTime 最快"，但只认真正的工具 ----
        check('★ 完全不认识的模组方块 → 兜底挑一把真工具（不是背包第一件）',
          ['minecraft:wooden_pickaxe', 'minecraft:iron_shovel', 'minecraft:stone_axe'].includes(pickDigTool(bot, unknownBlock)?.item?.name), true);

        // ---- equipDigTool：手上已是合适的 → 不动；不然换 ----
        const eqBot = { ...mkBot([wpick, ishovel, saxe]), heldItem: ishovel, equip: async function (it) { this.heldItem = it; this.equipped = it.name; } };
        const r1 = await equipDigTool(eqBot, clay);
        check('★ 手上已经是铁铲、又要挖 clay → 不重复换', { took: r1.took, name: r1.name }, { took: false, name: 'minecraft:iron_shovel' });
        const r2 = await equipDigTool(eqBot, stone);
        check('★ 手上是铲子、要挖 stone → 换成木镐', { took: r2.took, equipped: eqBot.equipped }, { took: true, equipped: 'minecraft:wooden_pickaxe' });
        const r3 = await equipDigTool(noTools, stone);
        check('★ 没有合适工具 → took:false 且不抛（照旧挖）', r3.took, false);
        const failBot = { ...mkBot([wpick]), heldItem: null, equip: async () => { throw new Error('equip 被拒'); } };
        const r4 = await equipDigTool(failBot, stone);
        check('换工具失败也不抛（挖照样进行）', { took: r4.took, hasWhy: /换工具没成/.test(r4.why || '') }, { took: false, hasWhy: true });

        // ---- ensureDigTool：身上没有 → 从精妙背包拿（ensureCarried 由调用方传进来）----
        // 假 ensureCarried：身上有就报 carried、没有就"从背包拿到"并补进 inventory（模拟真拿）
        const mkEnsure = (bot, haveInBag) => async (b, st, pred) => {
          const carried = b.inventory.items().some(pred);
          if (carried) return { have: 1, got: 1, source: 'carried' };
          if (!haveInBag) return { have: 0, got: 0, source: 'none', absenceProven: true };
          b.inventory.items().push(haveInBag);
          return { have: 1, got: 1, source: 'backpack' };
        };
        {
          const bot2 = { ...mkBot([wpick, saxe]), heldItem: wpick, equip: async function (it) { this.heldItem = it; this.equipped = it.name; } };
          const shovelInBag = itemOf('minecraft:iron_shovel', mcd.itemsByName.iron_shovel.id);
          const r5 = await ensureDigTool(bot2, clay, {}, mkEnsure(bot2, shovelInBag));
          check('★ 挖 clay、铲子在背包里 → 从背包拿来并换上', { kind: r5.kind, source: r5.source, equipped: bot2.equipped }, { kind: 'shovel', source: 'backpack', equipped: 'minecraft:iron_shovel' });

          const bot3 = { ...mkBot([ishovel]), heldItem: ishovel, equip: async function (it) { this.heldItem = it; this.equipped = it.name; } };
          const r6 = await ensureDigTool(bot3, clay, {}, mkEnsure(bot3, shovelInBag));
          check('★ 铲子已经在身上 → source=carried，不去开背包', r6.source, 'carried');

          const bot4 = { ...mkBot([wpick, saxe]), heldItem: wpick, equip: async function (it) { this.heldItem = it; } };
          const r7 = await ensureDigTool(bot4, clay, {}, mkEnsure(bot4, null));
          check('★ 身上和背包都没有铲子 → took:false，照旧挖（不抛）', r7.took, false);

          const bot5 = { ...mkBot([wpick]), heldItem: wpick, equip: async function (it) { this.heldItem = it; } };
          const r8 = await ensureDigTool(bot5, unknownBlock, {}, mkEnsure(bot5, null));
          check('认不出该用什么 → took:false + why 说明（照旧挖）', { took: r8.took, hasWhy: /认不出/.test(r8.why || '') }, { took: false, hasWhy: true });
        }

        // ---- 判据只此一处（源码形状锁，防以后在别处再写一份名单）----
        const src = t.handsSrc();
        check('★ 名字兜底表只在 tool-choice.js 一份（clay|dirt|sand… 那条正则）',
          (src.match(/clay\|dirt\|coarse_dirt/g) || []).length, 1);
        check('★ 工具后缀判据也只有一份',
          (src.match(/_shovel\$/g) || []).length, 1);
      }
  }],
];
register('tool-choice', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 本文件是独立的一份（不 require 兄弟文件），小节只用 check / handsSrc —— 两张都是
  // testkit 自带、不依赖 hands 总表，所以**不必** require('./index')（那会绕成循环依赖、
  // 触发 Node 的 warning）。
  const { runSuite } = require('./testkit');
  runSuite('tool-choice', __sections);
}

/**
 * 挖之前把"这个方块该用的工具"弄到手上，**身上没有就去精妙背包拿**。
 *
 * 这是给调用方用的完整版本（`equipDigTool` 只管身上的）。顺序：
 *   ① 先看身上有没有这一类工具（`ensureCarried` 的语义：够就不去开背包）；
 *   ② 没有 → `ensureCarried` 会按 predicate 从精妙背包里取一件（`fetchAnyFromBackpack` 路径）；
 *   ③ 拿到了再 `equipDigTool` 换到手上。
 *
 * ⚠️ **不许因为没铲子就不挖**：任何一步失败都只返回 `took:false`，不抛、不阻断。
 * ⚠️ **别每挖一块都开背包**：`ensureCarried` 身上够时直接返回 `source:'carried'`（不开界面），
 *    所以这里可以每块都调而不怕慢 —— 只有身上真没有时才去开背包（那一次是值得的）。
 *
 * @param {object} bot
 * @param {object} block
 * @param {object} state
 * @param {Function} ensureCarried  hands.js 的 ensureCarried（由调用方传入，避免循环 require）
 * @returns {Promise<{took:boolean, kind:string|null, name?:string, source?:string, why?:string}>}
 */
async function ensureDigTool (bot, block, state, ensureCarried) {
  try {
    const kind = toolKindFor(block, { itemNameById: (id) => itemNameById(bot, id) });
    if (!kind) return { took: false, kind: null, why: '认不出该用什么工具（照旧挖）' };
    const re = TOOL_RE[kind];
    let source = 'carried';
    if (typeof ensureCarried === 'function' && state) {
      const got = await ensureCarried(bot, state, (it) => re.test(String(it?.name || '')), 1);
      source = got?.source || 'unknown';
    }
    // 换到手上（身上没有合适的时 equipDigTool 返回 took:false，照旧用手上的挖）
    const eq = await equipDigTool(bot, block);
    return { ...eq, kind, source };
  } catch (e) {
    return { took: false, kind: null, why: `准备工具没成：${String(e?.message || e).slice(0, 60)}` };
  }
}

module.exports = { NAME_RULES, TOOL_RE, ensureDigTool, equipDigTool, fastestOfKind, pickDigTool, toolKindFor };
