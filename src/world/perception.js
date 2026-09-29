'use strict';

/**
 * perception.js —— 她的"余光"：野外资源感知 + 资源记忆（2026-09-29，主人点名）。
 *
 * ## 为什么要有（问题原话）
 *
 * 主人："對野外資源不敏感這個，我實在不知道該怎麼修了"。
 * 查过代码之后的实情（见 `TASK-perception-20260929.md`）：
 *   · mind 每一轮的世界信息来自 `src/mind/mind.js` 的 `look()`：`/status` `/inventory`
 *     `/nearby?radius=16` …，而 **`/nearby` 只有实体，没有方块**；
 *   · 唯一的"余光"是本能 `oreWatch`（`src/instinct/core.js`）：只报值钱的矿、只看 12 格；
 *   · 所以树、黏土、沙子、甘蔗、南瓜、浆果、花、露出的矿……她**完全看不见**，
 *     除非自己想起来调 `scan_blocks`。实机：她扫一次没扫到黏土就说"附近沒黏土"。
 *
 * 这个文件补的就是"余光"：**看周围看得见的方块 → 分类 → 聚成一片一片 → 记进记忆**。
 *
 * ## 分工（本文件是纯的）
 *
 *   · 纯函数：`classifyBlock` / `cluster` / `rank` / `merge` / `forget` / `containerTargets`
 *     —— 不碰 bot，自测直接喂数据。
 *   · 需要世界的只有一个：`scanAround`（要 `bot.world` / `bot.blockAt`）。
 *
 * ## 判据只写一处（AGENTS.md §5-4）
 *
 *   · "看得见"：`bot.canSeeBlock` 或 `place.exposedToOpen` —— **不在这里重写**
 *     （同一份判据 `src/instinct/core.js` 的 `oreVisible` 也在用）。
 *   · "在家范围"：`src/body/util.js` 的 `inHomeArea` —— **不在这里重写**。
 *   · 危险方块：`place.js` 的 `DEADLY` —— **不在这里重写**。
 *   · 矿的 tier / value：`knowledge/ores.json`（本能 `loadTables()` 读的那份）。
 *
 * ## 分类：整合包标签优先，名字兜底（`SPECS` 只有一处）
 *
 * 标签名全部实查过 `knowledge/generated/gamedata.json`（1699 个 block 标签），
 * 存在与不存在都写在下面的 `SPECS` 注释里。**标签里没有的**（黏土、南瓜、甘蔗…）
 * 才走名字正则兜底 —— 兜底规则只在本文件的 `FALLBACK` 里有一份。
 *
 * 自测：`node src/world/perception.js --selftest`
 */

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

// ------------------------------------------------------------------ 类别

/**
 * 类别定义。`useful` = 平时的有用度（0–10，排序用；真正"她现在缺什么"由 rank 的 needs 决定）。
 * `order` = 同类里谁当"代表名字"（大类的代表方块优先）。
 */
const KIND = {
  danger: { zh: '危险', useful: 0 },
  water: { zh: '水', useful: 3 },
  container: { zh: '箱子', useful: 9 },
  ore: { zh: '矿', useful: 8 },
  log: { zh: '树', useful: 7 },
  clay: { zh: '黏土', useful: 5 },
  sand: { zh: '沙', useful: 4 },
  gravel: { zh: '砂砾', useful: 4 },
  crop: { zh: '作物', useful: 7 },
  flower: { zh: '花', useful: 2 },
  mushroom: { zh: '蘑菇', useful: 3 },
  stone: { zh: '石头', useful: 3 },
  other: { zh: '别的', useful: 1 },
};

/**
 * 分类表。**顺序就是优先级** —— 先判的把后判的挡住：
 *   · `ender_chest` 必须被判成"不是容器"（它在 `forge:chests` 里 → 名字排除写在 container 自己那条）；
 *   · `lava` 要排在 water 之前判（岩浆不是水）；
 *   · 矿石要排在 stone 之前（深层铁矿的名字里也有 "stone"，但先命中 ore 就轮不到 stone）。
 *
 * tag 字段的**每一个名字都实查过**。`fallback` 只在标签全不命中时才用（名字规律兜底）。
 * 兜底规则只在这里有一份 —— 别在别处再写一遍。
 */
const SPECS = [
  {
    kind: 'danger',
    // "危险"没有标签可查（`minecraft:lava` 那种"这是岩浆"的标签在这个整合包里不存在，
    // 只有 `minecraft:lava_pool_stone_cannot_replace` 这种"熔岩湖怎么生成"的标签，不能用）。
    // 判据走 `world/place.js` 的 `DEADLY`（同一份），这里只再点几样**会伤人的植物**：
    // 甜浆果丛（走过去扎脚）在原版不属于 DEADLY，但是"危险"—— 先判它，
    // 后面的 crop 才收不到它（`sweet_berry_bush` 本来也可当野果，可**扎人的那片**更该先报危险）。
    fallback: /(^|:)(lava|flowing_lava|fire|soul_fire|magma_block|powder_snow|cactus|campfire|soul_campfire|cobweb|wither_rose)$/,
  },
  {
    kind: 'container',
    // 实查存在：forge:chests、forge:chests/wooden、forge:chests/trapped、forge:chests/ender、
    //           c:chests、lootr:chests（Lootr 的箱子）、forge:barrels、forge:barrels/wooden、minecraft:shulker_boxes
    tags: ['forge:chests', 'forge:chests/wooden', 'forge:chests/trapped', 'c:chests', 'lootr:chests',
      'forge:barrels', 'forge:barrels/wooden', 'minecraft:shulker_boxes'],
    // 末影箱不算：摸不着里面、也不是"野外的奖励箱"（任务书点名排除）。
    // 注意先排除再收 —— 它在 forge:chests 里。
    fallback: /(^|_)(chest|barrel|shulker_box|drawer|cupboard|crate|sack)(s|_minecart|_boat)?$/,
    exclude: /(^|_)(ender_chest|ender_chest_minecart)$/,
  },
  {
    kind: 'ore',
    // 矿单独一步：本文件不查标签（`forge:ores` 有，但价值和 tier 在矿表里），
    // 由调用方把 `knowledge/ores.json` 建成 **数字 id → 行** 的索引（`ctx.oreByName`）。
    viaTable: 'oreByName',
  },
  {
    kind: 'log',
    // 实查存在：minecraft:logs、minecraft:logs_that_burn、minecraft:overworld_natural_logs、
    //           各模组的 *_logs（biomeswevegone:aspen_logs …）以及 minecraft:crimson_stems
    tags: ['minecraft:logs', 'minecraft:logs_that_burn', 'minecraft:overworld_natural_logs',
      'minecraft:crimson_stems', 'minecraft:warped_stems', 'forge:mushroom_stems'],
    fallback: /(_log|_wood|_stem|_hyphae)$/,
  },
  {
    kind: 'clay',
    // ⚠️ 实查：这个整合包里 **clay 相关标签一个都没有**（`clay` 在 1699 个 block 标签里 0 命中）。
    //    所以黏土**只能靠名字兜底** —— 这也是任务书要求"先在数据里查有哪些真实标签名"的原因。
    fallback: /(^|_)(clay|terracotta)$/,
  },
  {
    kind: 'sand',
    // 实查存在：minecraft:sand、forge:sand、forge:sand/colorless、forge:sand/red
    tags: ['minecraft:sand', 'forge:sand', 'forge:sand/colorless', 'forge:sand/red'],
    fallback: /(^|_)sand$/,
  },
  {
    kind: 'gravel',
    // 实查存在：forge:gravel
    tags: ['forge:gravel'],
    fallback: /(^|_)gravel$/,
  },
  {
    kind: 'crop',
    // 实查存在：minecraft:crops、farmersdelight:wild_crops、farm_and_charm:wild_crops
    //   （sereneseasons:*_crops 是"季节能种什么"的表，不是"这是庄稼"，故意不收）
    tags: ['minecraft:crops', 'farmersdelight:wild_crops', 'farm_and_charm:wild_crops'],
    // 甘蔗/南瓜/西瓜/浆果/可可… 实查**都没有标签**（`pumpkin`/`melon`/`berry`/`sugar_cane` 0 命中），
    // 只能名字兜底。这些是野外的食物来源，主人明确点名要算进"作物与可收获的"。
    fallback: /(^|_)(sugar_cane|bamboo|pumpkin|melon|sweet_berry_bush|cave_vines|cave_vines_plant|cocoa|kelp|berry_bush)$/,
  },
  {
    kind: 'flower',
    // 实查存在：minecraft:flowers、minecraft:small_flowers、minecraft:tall_flowers
    tags: ['minecraft:flowers', 'minecraft:small_flowers', 'minecraft:tall_flowers'],
    fallback: /(^|_)flower$/,
  },
  {
    kind: 'water',
    // 实查：没有"这是水"的方块标签（`water` 命中的 9 个都是模组的机制标签）。
    // 水靠名字（`minecraft:water` / 模组的水）—— 判据本身应该走 `instinct/survival.js` 的
    // `blocksWater`（那里是"水下判据只此一份"），本文件只在**分类**里用它。
    fallback: /(^|:)(water|flowing_water|waterlogged)$/,
  },
  {
    kind: 'mushroom',
    // 实查存在：minecraft:mushroom_grow_block 是"蘑菇能长在哪"，不是蘑菇本身。
    // 蘑菇本身没有标签 → 名字兜底。
    fallback: /(^|_)(mushroom|mushroom_block|mushroom_stem|fungus|roots)$/,
  },
  {
    kind: 'stone',
    // 实查存在：forge:cobblestone、forge:cobblestone/normal、minecraft:base_stone_overworld、
    //           minecraft:stone_bricks、forge:cobblestone/deepslate
    tags: ['forge:cobblestone', 'forge:cobblestone/normal', 'minecraft:base_stone_overworld', 'minecraft:stone_bricks'],
    fallback: /(^|_)(stone|cobblestone|deepslate|granite|diorite|andesite|tuff|calcite|basalt|blackstone)$/,
  },
];

/** 纯空气/可替换的：整片空气不是"资源"，也不算进记忆 */
const AIRY = /(^|:)(air|cave_air|void_air|light|moving_piston|structure_void)$/;

// 第 4 步去重：原为本文件本地定义，与 instinct/survival.js:312、mind/plan.js:49 逐字重复
// （三份同一件事）—— 唯一一份在 src/util/ids.js。保留本地名 `bareOf` 不动调用点。
const { stripPrefix: bareOf } = require('../util/ids');

/**
 * 方块的中文名（`knowledge/item-names.json`，15535 条，整合包真值）。
 *
 * 为什么要它：主人的计划是中文的（"合成铁镐"/"去挖点铁矿"），而方块名是英文 id
 * （`iron_ore`）——只靠英文 id 的尾词匹配**永远对不上中文计划**，
 * 于是"缺什么"判断形同虚设（2026-09-29 实机核对发现）。有了中文名，
 * "缺铁"就能对上"铁矿石"（包含关系），也不用另编一份中文名单（判据只此一处）。
 *
 * 读不到就返回空表（"读不到" ≠ "没有"：匹配退化成只用 id，不会误报）。
 */
let __zhNames = null;
function zhNameOf (name) {
  if (__zhNames === null) {
    try {
      __zhNames = require(path.join(paths.KNOWLEDGE, 'item-names.json')).item || {};
    } catch (_) { __zhNames = {}; }
  }
  const full = String(name || '').includes(':') ? String(name) : `minecraft:${name}`;
  return __zhNames[full] || __zhNames[bareOf(name)] || '';
}

/** 事件/日志里念出来的名字：有中文名就用中文名，没有就用 id 尾词（`iron_ore` → `iron ore`）。 */
function displayName (it) {
  if (!it) return '';
  return zhNameOf(it.name) || bareOf(it.name).replace(/_/g, ' ') || (KIND[it.kind]?.zh || '资源');
}

/**
 * 这块方块属于哪一类。
 *
 * @param name    方块全名（`minecraft:oak_log` 或 `oak_log` 都行）
 * @param ctx.type       方块的**注册表数字 id**（mineflayer 的 `block.type`）—— 矿表是数字索引，
 *                       有它才能查 `knowledge/ores.json`。没有就跳过"表驱动"那一类。
 * @param ctx.tags       这个方块**拥有的标签名集合**（查 `knowledge` 的 blockTags；数组/Set 都行）
 * @param ctx.tagOf      (name, tag) => boolean —— 另一种用法：直接问"有没有这个标签"
 * @param ctx.oreByName  Map<number, {tier,value}> —— 真实矿表索引（`scanAround` 建的）
 * @returns { kind, zh, source } | null   —— `source` 是命中方式（'tag' / 'name' / 'table'），
 *                                          为的是"为什么算这一类"能查（AGENTS.md §5-1）
 */
/** 分得出类、但**不主动扫**的（到处都是，扫了只会占满名额） */
const SCAN_SKIP_KINDS = new Set(['stone', 'water']);

function classifyBlock (name, ctx = {}) {
  const full = String(name || '');
  if (!full) return null;
  const bare = bareOf(full);
  if (AIRY.test(bare)) return null;

  // 「有没有这个标签」——两种入参形态都收（调用方从 knowledge 拿到的经常是反查表 / Set）
  const hasTag = (tag) => {
    if (typeof ctx.tagOf === 'function') { try { return !!ctx.tagOf(full, tag); } catch (_) { return false; } }
    const set = ctx.tags;
    if (!set) return false;
    if (typeof set.has === 'function') return set.has(tag);
    if (Array.isArray(set)) return set.includes(tag);
    return false;
  };

  for (const spec of SPECS) {
    // ① 表驱动（矿）：走 `knowledge/ores.json` 的**数字 id** 索引（`block.type` 就是它）
    if (spec.viaTable === 'oreByName') {
      const map = ctx.oreByName;
      if (!map) continue;
      const hit = typeof map.has === 'function' ? (ctx.type != null && map.has(ctx.type)) : false;
      if (hit) return { kind: spec.kind, zh: KIND[spec.kind].zh, source: 'table' };
      continue;
    }
    // ② 先排除（末影箱在 forge:chests 里，必须在收下之前挡掉）
    if (spec.exclude && spec.exclude.test(bare)) continue;
    // ③ 整合包标签优先
    if (spec.tags && spec.tags.some(t => hasTag(t))) return { kind: spec.kind, zh: KIND[spec.kind].zh, source: 'tag' };
    // ④ 名字规律兜底（标签里没有的：黏土、南瓜、甘蔗…）
    if (spec.fallback && spec.fallback.test(bare)) return { kind: spec.kind, zh: KIND[spec.kind].zh, source: 'name' };
  }
  return null;
}

// ------------------------------------------------------------------ 聚片

/**
 * 把同类的一堆点聚成"一片一片"（任务书：别每块一条）。
 *
 * 算法：**广度优先的连通块**，两点的切比雪夫距离（max(|dx|,|dy|,|dz|)）≤ `gap` 就算相邻。
 * 为什么不是"按距离阈值一刀切"：一棵树的叶子分散在 5×5×8 的范围里，
 * 按质心距离聚会把同一棵树劈成两片（树冠一半、树干一半）。
 * 连通块天然把"连在一起的一棵树/一片黏土/一堵墙"算成一条。
 *
 * @param pts  [{ name, pos:{x,y,z}, kind, underwater, tier, value }]
 * @param gap  相邻判定的最大坐标差（默认 3）
 * @returns [{ kind, name, center:{x,y,z}, box:{min,max}, count, underwater, tier, value, samples }]
 *          —— 名字取"片内出现最多的那个"（代表名字）
 */
function cluster (pts = [], { gap = 3 } = {}) {
  const g = clusterSteps(pts, { gap });
  for (;;) { const { done, value } = g.next(); if (done) return value; }
}

/**
 * `cluster` 的**生成器内核** —— 连通块的判据（`near` / chain 扩张 / 代表名字）只在这里有一份。
 *
 * 为什么要有（2026-09-29 实机"走得很亂"）：`cluster` 是 O(n²) 的 `while` + `splice`，
 * 本地实测 4000 点 **49.6ms**（`scanAround` 的 `cap` 正好是 4000），每 5 秒一次
 * 就把事件循环堵住 —— 物理 tick 跑不动，她走路就一顿一顿的。
 * 拆成生成器之后：
 *   · `cluster()`（同步）抽干它 —— 自测里的精确条数断言一字不改；
 *   · `clusterAsync()` 在让出点交出事件循环 —— **上线跑的是这条**。
 * 两份**共用这一个内核**，不存在"同一判据写两遍"（AGENTS.md §5-4）。
 *
 * 让出点：每聚完一个连通块 `yield` 一次（块内是紧循环切不动 —— 但块内没有 `await`，
 * 半成品 `group` 不会被别的代码看到，所以块与块之间让出是安全的）。
 */
function * clusterSteps (pts = [], { gap = 3 } = {}) {
  const left = pts.map((p, i) => ({ ...p, __i: i })).filter(p => p && p.pos);
  const out = [];
  const near = (a, b) => Math.max(
    Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y), Math.abs(a.pos.z - b.pos.z),
  ) <= gap;
  while (left.length) {
    const seed = left.shift();
    const group = [seed];
    // 连通块扩张：新收进来的点也要拿去比（不然只聚到直接相邻的一圈）
    for (let k = 0; k < group.length; k++) {
      for (let j = left.length - 1; j >= 0; j--) {
        if (near(group[k], left[j])) group.push(left.splice(j, 1)[0]);
      }
    }
    const xs = group.map(p => p.pos.x); const ys = group.map(p => p.pos.y); const zs = group.map(p => p.pos.z);
    // 代表名字：整名出现最多的（同类里"橡树 9 棵"要能被叫出来）
    const tally = new Map();
    for (const p of group) tally.set(p.name, (tally.get(p.name) || 0) + 1);
    const name = [...tally.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
    const tiers = group.filter(p => p.tier != null).map(p => p.tier);
    out.push({
      kind: group[0].kind,
      name,
      center: {
        x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
        y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
        z: Math.round((Math.min(...zs) + Math.max(...zs)) / 2),
      },
      box: { min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }, max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) } },
      count: group.length,
      // 水下："整片都在水里"才算（露头的一块不算整片水下 —— 那是常识上的"浅水"）
      underwater: group.every(p => p.underwater === true),
      // 矿：一片里取**最难挖（tier 最大）**的那个当代表 —— 报"露出的铁矿 2"要有 tier 依据
      tier: tiers.length ? Math.max(...tiers) : null,
      samples: group.slice(0, 6).map(p => p.pos),
    });
    yield null;
  }
  return out;
}

/**
 * 分批版聚片 —— **上线跑的就是这条**。
 *
 * 每聚完一个连通块检查一次"这一轮已经花了多久"，超过 `sliceMs` 就让出事件循环。
 * 一个连通块（一棵树、一片黏土）的点数是几十的量级，所以最坏的单块耗时远小于 30ms；
 * 让出的间隔由 `sliceMs` 兜住。
 *
 * @returns 和 `cluster()` 一模一样的数组
 */
async function clusterAsync (pts = [], { gap = 3, yieldFn = null, sliceMs = 12 } = {}) {
  const yielder = yieldFn || (() => new Promise(res => setImmediate(res)));
  const g = clusterSteps(pts, { gap });
  let t0 = Date.now();
  for (;;) {
    const { done, value } = g.next();
    if (done) return value;
    if (Date.now() - t0 >= sliceMs) { await yielder(); t0 = Date.now(); }
  }
}

// ------------------------------------------------------------------ 排序

/** 八个方向的中文（"东北 20 格"这种她要能直接读） */
const DIRS = [
  ['北', 0, -1], ['东北', 1, -1], ['东', 1, 0], ['东南', 1, 1],
  ['南', 0, 1], ['西南', -1, 1], ['西', -1, 0], ['西北', -1, -1],
];

/** 从 (x,z) 到 (tx,tz) 的方向名 */
function directionOf (from, to) {
  const dx = to.x - from.x; const dz = to.z - from.z;
  if (!dx && !dz) return '脚下';
  let best = DIRS[0]; let bestDot = -Infinity;
  for (const [label, ux, uz] of DIRS) {
    const len = Math.hypot(dx, dz) || 1;
    const dot = (dx / len) * (ux / Math.hypot(ux, uz)) + (dz / len) * (uz / Math.hypot(ux, uz));
    if (dot > bestDot) { bestDot = dot; best = [label, ux, uz]; }
  }
  return best[0];
}

/**
 * needs → 关键词集合。**`rank` 和 `worthTelling` 共用这一份**（同一判据不写两遍）。
 * @param needs ['黏土', 'wood', ...] 或 [{ kind|name|zh }]
 */
function needKeysOf (needs = []) {
  const needKeys = new Set();
  for (const n of needs || []) {
    if (!n) continue;
    if (typeof n === 'string') needKeys.add(n.toLowerCase());
    else for (const v of [n.kind, n.name, n.zh, bareOf(n.name)]) if (v) needKeys.add(String(v).toLowerCase());
  }
  return needKeys;
}

/**
 * 这一片的名字/类别**命中"她现在缺的"了吗** —— 判据只此一处。
 *
 * ⚠️ `kind` 一律不参与命中判断（2026-09-29 实机）：`needsFrom` 会把长期计划文本里的
 * **每一个**类别中文名塞成关键词（"矿""树"…），于是裸 kind 命中会把**所有**矿都算成"缺的"，
 * 事件就挂着"（你现在正缺这个）"发出去 —— 缺的是哪种矿根本没说清（任务书点名要修）。
 * 改成只认**具体名字 / 类别中文**（中文仍然宽松匹配，因为是"缺铁"对上"铁矿"这种）。
 *
 * ⚠️ 命中分**两档**（2026-09-29 实机，事件文本"缺去挖点铁矿"那种）：
 *   ① **紧匹配**（相等 / id 尾词互相包含）→ 回带命中的那个词（`iron`）；
 *   ② **松匹配**（中文包含：`zh.includes(k) || k.includes(zh)`）→ 回带 `'*'` 哨兵，
 *      意思是"确实缺这一类，但关键词是整句话，别拿它当名字" → `niceLabel` 用这一片自己的名字。
 *   中间还有个特例：`k` 和 `zh` 相等（"缺黏土"里的"黏土"）算**紧匹配**（它就是名字）。
 *
 * @returns 命中信息 `{ key:string, loose:boolean }` | null
 */
function nameHitsNeedDetail (it, needKeys) {
  if (!needKeys || !needKeys.size) return null;
  const zh = (KIND[it.kind]?.zh || '').toLowerCase();
  const name = String(it.name || '').toLowerCase();
  const bare = bareOf(name);
  const zhName = zhNameOf(it.name).toLowerCase();          // 这一片的中文名（"铁矿石" / "黏土"）
  // ⚠️ 有一类"裸类别名"**不算具体命中**：`needsFrom` 会把自由文本里的类别中文切成关键词，
  //    于是缺"矿"会让**每一种**矿都挂"（你现在正缺这个）"，而缺的是哪种矿根本没说清
  //    （任务书点名："缺的是哪种矿要说清楚，不是所有矿都缺"）。
  //    只有 `ore` 这一类有"类别 ≠ 具体东西"的问题（矿下面有铁/煤/钻石…几十种）。
  //    黏土/花/树这种，类别名本身就指一样东西，说"缺黏土"就是真缺黏土 —— 照旧命中。
  const usable = [];
  for (const k of needKeys) {
    if (k === it.kind) continue;                                // 裸 kind（"ore"）不算
    if (it.kind === 'ore' && k === zh) continue;                // 只有"矿"这个类别名不算
    usable.push(k);
  }
  // ① 紧匹配（id / 中文名 相等，或 id 尾词互相包含）
  for (const k of usable) {
    if (k === name || k === bare) return { key: k, loose: false };
    if (k === zh || (zhName && k === zhName)) return { key: k, loose: false };
    if (bare && (bare.includes(k) || k.includes(bare))) return { key: k, loose: false };
  }
  // ② 松匹配（中文包含：关键词往往是整句话）
  //    ⚠️ `ore` 特例：只跟**类别名**重叠的整句（"去挖点矿"只共享一个"矿"）**不算**
  //       —— 任务书点名"不是所有矿都缺"。要么和这一片的**中文名**重叠（"去挖点铁矿" ∩ "铁矿石" = "铁"），
  //       要么根本不松匹配。
  for (const k of usable) {
    if (!zh && !zhName) continue;
    if (zhName && k.length > 1 && (zhName.includes(k) || k.includes(zhName))) return { key: k, loose: true };
    if (it.kind === 'ore') {
      // 矿只认"和中文名有交集、且交集不只是'矿'这个字"的（"铁矿" ∩ "铁矿石" = "铁"）
      if (!zhName) continue;
      const shared = zhName.split('').filter(ch => ch !== zh[0] && k.includes(ch)).length;
      if (shared > 0) return { key: k, loose: true };
      continue;
    }
    if (zh && (zh.includes(k) || k.includes(zh))) return { key: k, loose: true };
  }
  return null;
}

/** 只要"命中没命中 + 命中的词"的老接口（`rank` 用）—— 判据还是上面那一处 */
function nameHitsNeed (it, needKeys) {
  const d = nameHitsNeedDetail(it, needKeys);
  return d ? d.key : null;
}

/**
 * 这一片**值不值得打断 mind** —— 判据只此一处（2026-09-29 实机修"事件刷屏"）。
 *
 * 主人原话：「只发用得上的：缺的、值钱的、容器」。
 * 实机症状：`resource_seen 余光扫到：花 / 砂砾 / 树…` 几秒一批，花、砂砾这种她不缺的也在发。
 *
 * 只发三类：
 *   ① **她现在缺的** —— 名字命中 needs（具体名字，不是类别；见 `nameHitsNeed`）；
 *   ② **值钱的矿** —— `kind === 'ore'` 且矿表 `value === 'high'`（值钱与否查现成的矿表，不另编名单）；
 *   ③ **没开过的野外容器** —— `kind === 'container'` 且 `opened !== true`（"野外的"由调用方先筛）。
 * 其余（花 / 砂砾 / 普通树 / 石头 / 沙 / 黏土 / 作物，且没被点名缺）→ **不发事件**
 * （照样进【附近看得见的】那一行和资源记忆，只是不打断她）。
 *
 * @param it  聚好的片（含 `kind` / `name` / `opened` / `value`）
 * @param needs 同 `rank`
 * @returns {{ tell:boolean, why:'need'|'valuable'|'container'|null, label:string|null }}
 *          `label` = **要报给主人的那个具体名字**（用来写"缺的是哪种"）：
 *          有中文名就用中文名（`iron_ore` → "铁矿石"）；松匹配（关键词是整句）也用它，
 *          免得事件里出现"缺去挖点铁矿"这种句子。
 */
function worthTelling (it, { needs = [] } = {}) {
  if (!it) return { tell: false, why: null, label: null };
  const d = nameHitsNeedDetail(it, needKeysOf(needs));
  if (d) return { tell: true, why: 'need', label: niceLabel(d, it) };
  if (it.kind === 'ore' && it.value === 'high') return { tell: true, why: 'valuable', label: null };
  if (it.kind === 'container' && it.opened !== true) return { tell: true, why: 'container', label: null };
  return { tell: false, why: null, label: null };
}

/**
 * 命中信息 → "能直接念出来"的名字。
 *
 * 优先用**中文名**（`knowledge/item-names.json`，主人看得懂的就是这个）；
 * 没有中文名才退回 id 尾词 / 命中的那个关键词。
 * ⚠️ 松匹配（关键词是整句计划）时**绝不**回带关键词 —— 事件里不能出现"缺去挖点铁矿"。
 */
function niceLabel (d, it) {
  const zhName = zhNameOf(it?.name);
  if (zhName) return zhName;
  if (d.loose) return String(it?.name || '').replace(/^.*:/, '') || null;
  return d.key || null;
}

/**
 * 该不该重扫 —— 判据只此一处（2026-09-29 实机修"走路很乱"里"少扫"那一条）。
 *
 *   · 没怎么移动（离上次扫描中心 < `minMoveBlocks`）**且**上次扫描 < `minRescanMs` → 不重扫
 *     （原地站着重扫，扫到的几乎全是同一批方块，白发一次 cluster）；
 *   · 上一次还没跑完（`busy`）→ 不重扫（防叠）；
 *   · 她在走路 / 打架 / 开着界面 → 放慢到 `busyEveryMs`（物理 tick 优先，走路稳最要紧）。
 *
 * @param p.sinceMs   距上次扫描多久
 * @param p.moveDist  离上次扫描中心多远（读不到位置时给 null = 按"动过"算，宁可多扫一次）
 * @param p.busy      上一次还没跑完
 * @param p.occupied  在走路 / 打架 / 开着界面
 * @returns {{ scan:boolean, everyMs:number, why:string }}
 */
function shouldRescan ({ sinceMs = Infinity, moveDist = null, busy = false, occupied = false } = {}, cfg = {}) {
  const idleEvery = cfg.everyMs ?? 5000;
  const busyEvery = cfg.busyEveryMs ?? idleEvery * 4;
  const everyMs = occupied ? busyEvery : idleEvery;
  if (busy) return { scan: false, everyMs, why: '上一轮还没跑完（防叠）' };
  if (sinceMs < everyMs) return { scan: false, everyMs, why: `还没到间隔（${Math.round(sinceMs)} < ${everyMs}ms${occupied ? '，她在忙，放慢了' : ''}）` };
  const moved = moveDist == null || moveDist >= (cfg.minMoveBlocks ?? 8);
  if (!moved && sinceMs < (cfg.minRescanMs ?? 60000)) {
    return { scan: false, everyMs, why: `没怎么动（${Math.round(moveDist)} 格 < ${cfg.minMoveBlocks ?? 8}）且距上次不到 ${Math.round((cfg.minRescanMs ?? 60000) / 1000)} 秒` };
  }
  return { scan: true, everyMs, why: moved ? '动过了' : '虽然没动，但距上次够久了' };
}

/**
 * 按"她现在缺什么"排序，最多 `max` 项。
 *
 * 规则（任务书 + 主人原话）：
 *   ① **没开过的野外容器永远在前两位** —— 主人点名"看到之后高优先级去获取内容"。
 *      所以先把 container 类里"还没开过"的挑出来钉在最前（最多 2 个）。
 *   ② 其余按 needs 命中排：needs 是她**现在缺的**（长期计划当前步 / 心愿 / 刚合成缺的料）。
 *      needs 里的词命中类别 zh / 方块名 / 类别 kind → 提前。
 *   ③ 没命中的按"有用度 + 距离 + 块数"降序（近的、多的、有用的在前）。
 *
 * @param items  聚好的片 [{ kind, name, center, count, distance, opened? }]
 * @param needs  ['黏土', 'wood', ...] 或 [{ kind|name|zh }]
 * @returns 排好序的（最多 max 个）
 */
function rank (items = [], needs = [], { max = 6 } = {}) {
  const needKeys = needKeysOf(needs);
  const scored = items.map(it => {
    const useful = KIND[it.kind]?.useful ?? 1;
    const d = Number.isFinite(it.distance) ? it.distance : 999;
    return { it, need: nameHitsNeed(it, needKeys) ? true : false, score: useful * 10 - d * 0.2 + Math.min(it.count || 1, 20) * 0.5 };
  });
  // ① 野外没开过的容器钉在前两位
  const fresh = scored.filter(x => x.it.kind === 'container' && x.it.opened !== true && x.it.outdoor !== false)
    .sort((a, b) => a.it.distance - b.it.distance).slice(0, 2);
  const chosen = [...fresh];
  const rest = scored.filter(x => !fresh.includes(x));
  // ② needs 命中的（先按命中、再按距离）
  rest.sort((a, b) => (b.need - a.need) || (b.score - a.score));
  for (const x of rest) { if (chosen.length >= max) break; chosen.push(x); }
  return chosen.map(x => ({ ...x.it, why: x.need ? 'need' : (x.it.kind === 'container' && x.it.opened !== true ? 'container' : 'useful') }));
}

// ------------------------------------------------------------------ 资源记忆

/** `memory/resources.json`（`MC_RESOURCES_FILE` 可覆盖 —— 自测用临时文件，绝不写真文件） */
const FILE = () => process.env.MC_RESOURCES_FILE || path.join(paths.MEMORY, 'resources.json');

function emptyStore () { return { at: 0, dim: null, places: [] }; }

function load (file = FILE()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object') return emptyStore();
    d.places ||= [];
    return d;
  } catch (_) { return emptyStore(); }   // 文件不存在 / 读坏了 = 还没有记忆（不是"附近没有"）
}

/** 原子写：先 .tmp 再 rename（照 `memory-store.js` / `body/util.js` 的 SEEN_FILE） */
function save (store, file = FILE()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, JSON.stringify(store)); try { fs.unlinkSync(tmp); } catch (__) {} }
    return true;
  } catch (_) { return false; }   // 存不下去如实返回 false（"读不到"和"没有"分开）
}

/**
 * 异步原子写 —— **上线跑的是这条**（2026-09-29 修"走路很乱"）。
 *
 * 为什么要异步：`save()` 用 `fs.writeFileSync`，实测 2000 条 2.9ms —— 本身不慢，
 * 但它是**同步**的，写在每 5 秒一轮的扫描里就是白白堵一下事件循环。
 * 语义与 `save()` **完全一致**（先 `.tmp` 再 `rename`，失败如实返回 false）——
 * 同步的 `save()` 留着给自测（自测要的是确定性），两条都只写这一个文件。
 */
async function saveAsync (store, file = FILE()) {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const text = JSON.stringify(store);
    await fs.promises.writeFile(tmp, text);
    try { await fs.promises.rename(tmp, file); }
    catch (_) { await fs.promises.writeFile(file, text); try { await fs.promises.unlink(tmp); } catch (__) {} }
    return true;
  } catch (_) { return false; }   // 存不下去如实返回 false（"读不到"和"没有"分开）
}

/**
 * 这一轮**要不要写盘** —— 判据只此一处（2026-09-29：不是每轮都写）。
 *
 * 有变化（`added/refreshed/decayed/gone` 加起来 > 0 或条数变了）**且**距上次写超过
 * `saveMinIntervalMs` 才写。理由：她站着一动不动时每 5 秒写一次完全一样的文件没意义，
 * 写盘是同步 IO，攒着写能把"每轮一次"摊成"最多半分钟一次"。
 *
 * @returns {{ write:boolean, why:string }}
 */
function shouldSave ({ changed = false, sinceSaveMs = Infinity, sig = null, lastSig = null } = {}, cfg = {}) {
  const changedNow = changed || (sig != null && lastSig != null && sig !== lastSig);
  if (!changedNow) return { write: false, why: '这一轮记忆没变化，不写' };
  if (sinceSaveMs < (cfg.saveMinIntervalMs ?? 30000)) {
    return { write: false, why: `有变化，但距上次写不到 ${Math.round((cfg.saveMinIntervalMs ?? 30000) / 1000)} 秒，攒着` };
  }
  return { write: true, why: '有变化且过了写盘间隔' };
}

/**
 * 把这一轮扫到的片并进记忆。
 *
 * · 同类别、中心距离 ≤ `mergeDist` → **同一条**（刷新 count 取较大、seenAt / confirmedAt 刷新、权重回满）；
 * · 新片 → 追加；
 * · **只有这一轮又看见的**才刷 `confirmedAt`（`weight` 回 1）—— 很久没确认的靠 `forget` 降权。
 *
 * @param store   上一次 load 出来的
 * @param found   这一轮 cluster 出来的片（带 dim）
 * @param now     Date.now()
 * @param opts.dim 当前维度
 * @returns { store, added, refreshed }  —— added/refreshed 给"新发现才发事件"用
 */
function merge (store, found = [], now = Date.now(), { dim = null, mergeDist = 6 } = {}) {
  const st = store && typeof store === 'object' ? store : emptyStore();
  st.places ||= [];
  const added = []; const refreshed = [];
  for (const f of found) {
    if (!f?.center) continue;
    const same = st.places.find(p => p.kind === f.kind && p.dim === (f.dim || dim)
      && Math.hypot(p.center.x - f.center.x, p.center.z - f.center.z) <= mergeDist
      && Math.abs(p.center.y - f.center.y) <= mergeDist);
    if (same) {
      // 又看见了：计数取较大的（这一轮可能只扫到一半），但"确认时刻"一定是现在
      same.count = Math.max(same.count || 0, f.count || 0);
      same.seenAt = now;
      same.confirmedAt = now;
      same.weight = 1;
      same.underwater = !!f.underwater;
      if (f.tier != null) same.tier = f.tier;
      // ★ 2026-09-29 修：`direction` / `distance` 也一起刷新。
      //   它们是 `scanAround` 算好的（方向判据只在 `directionOf` 一处）；
      //   以前这里不拷，`m.added` 拿到的记录就没有 direction →
      //   事件文字里插值出字面量 `undefined`（"余光扫到：矿（undefined 15 格）"）。
      if (f.direction != null) same.direction = f.direction;
      if (Number.isFinite(f.distance)) same.distance = f.distance;
      refreshed.push(same);
    } else {
      const rec = {
        kind: f.kind, name: f.name, center: { ...f.center },
        count: f.count || 1, underwater: !!f.underwater,
        dim: f.dim || dim, seenAt: now, confirmedAt: now, weight: 1,
        // ★ 2026-09-29 修（上面那段的同一件事）：**不能丢这两个字段**。
        //   调用方（core.js）拿 `added` 直接发事件，缺了就是 "undefined 方向"。
        direction: f.direction ?? null,
        distance: Number.isFinite(f.distance) ? f.distance : null,
      };
      if (f.tier != null) rec.tier = f.tier;
      st.places.push(rec);
      added.push(rec);
    }
  }
  st.at = now;
  st.dim = dim;
  return { store: st, added, refreshed };
}

/**
 * 过期处理 —— **"没了"和"没去确认"分开**（AGENTS.md §5-1）。
 *
 *   ① `gone`：她走到了那片地方（`near` 内）却**没再看到**同类方块 → **删掉**（东西真没了）；
 *      调用方只在"确实走过、且这一轮扫到过那里"时才传（不能拿"没扫到"当"没了"）。
 *   ② 很久没确认（`now - confirmedAt > decayAfterMs`）→ **降权**（不是删）：`weight *= decayRate`，
 *      降到 `dropBelow` 以下才剔掉（"可能还在，但我很久没去了" ≠ "没有了"）。
 *
 * @returns { kept, removed, decayed, gone }
 */
function forget (store, { now = Date.now(), near = null, goneRadius = 8, goneKinds = null,
  decayAfterMs = 30 * 60 * 1000, decayRate = 0.5, dropBelow = 0.2 } = {}) {
  const st = store && typeof store === 'object' ? store : emptyStore();
  st.places ||= [];
  const kept = []; const removed = []; const decayed = []; const gone = [];
  for (const p of st.places) {
    // ① 去过了、没了
    if (near && p.center && Math.hypot(p.center.x - near.x, p.center.z - near.z) <= goneRadius
      && (!goneKinds || goneKinds.has(p.kind) === false)) {
      removed.push(p); gone.push(p);
      continue;
    }
    // ② 久未确认 → 降权
    const age = now - (p.confirmedAt || p.seenAt || 0);
    if (age > decayAfterMs) {
      const w = (p.weight ?? 1) * decayRate;
      if (w < dropBelow) { removed.push(p); continue; }
      p.weight = +w.toFixed(3);
      decayed.push(p);
    }
    kept.push(p);
  }
  st.places = kept;
  return { store: st, kept, removed, decayed, gone };
}

/** 她"现在缺什么" → 类别关键词（长期计划当前步 / 心愿 / 刚合成缺的料，都是中文或 id） */
function needsFrom ({ planStep = '', ambition = '', craftMissing = [], extra = [] } = {}) {
  const out = [];
  for (const s of [planStep, ambition, ...craftMissing, ...extra]) {
    if (!s) continue;
    const t = String(s);
    // 中文类别名直接当关键词；英文 id 的"尾词"也塞进去（oak_log → log / wood）
    for (const k of Object.keys(KIND)) if (t.includes(KIND[k].zh)) out.push(k);
    for (const m of t.matchAll(/[a-z_]+/g)) {
      out.push(m[0]);
      // ⚠️ 复合 id 要**切开**（2026-09-29 实机）：`craftMissing` 给的是 `raw_iron` / `oak_log`
      //    这种带下划线的 id，`[a-z_]+` 会把整串当一个词 → **永远匹配不上** `iron_ore` / `oak_log`。
      //    补上分段词（raw / iron），"缺铁矿"才真能命中铁矿。
      for (const p of m[0].split('_')) if (p) out.push(p);
    }
    out.push(t);
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * 野外没开过的容器（任务书第 4 条，主人点名）。
 *
 * · **家范围外**才算野外的（`home` 传进来的判据是 `body/util.js` 的 `inHomeArea` —— 同一份）；
 * · 开过的（`state.seenContainers` / `SEEN_FILE` 的 keys）不当目标；
 * · **不要求"此刻看得见"** —— 记忆里有、走得到就行（任务书：半径提到跟扫描一致）。
 */
function containerTargets (places = [], { home = null, isHome = null, seenKeys = null, dim = null, now = Date.now(), maxAge = 30 * 60 * 1000 } = {}) {
  const inHome = typeof isHome === 'function' ? isHome : null;
  const out = [];
  for (const p of places) {
    if (p.kind !== 'container') continue;
    if (dim && p.dim && p.dim !== dim) continue;                       // 跨维度的不算（走不过去）
    if (now - (p.confirmedAt || p.seenAt || 0) > maxAge) continue;     // 太久没确认的不去（可能是记忆里的旧地方）
    if (seenKeys && (seenKeys.has(placeKey(p)) || seenKeys.has(doorKeyOf(p)))) continue;   // 开过了
    if (p.opened === true) continue;
    if (inHome && inHome(p.center) === true) continue;                 // 家里的归 organize_storage
    else if (!inHome && home && Math.hypot(p.center.x - home.center.x, p.center.z - home.center.z) <= home.radius
      && Math.abs(p.center.y - home.center.y) <= 16) continue;
    out.push({ ...p, outdoor: true });
  }
  return out;
}

/** 记忆里那条 → 和 `body/containers.js` 的 storageKey 同一个形状："x,y,z" */
const placeKey = (p) => `${Math.round(p.center.x)},${Math.round(p.center.y)},${Math.round(p.center.z)}`;
const doorKeyOf = (p) => `(${Math.round(p.center.x)}, ${Math.round(p.center.y)}, ${Math.round(p.center.z)})`;

// ------------------------------------------------------------------ 扫描（要世界）

/**
 * 绕她一圈扫"看得见的"方块 → 分类 → 聚片。
 *
 * **分段让出**：整块的扫描交给 `src/instinct/core.js` 的 `scanColumnsIn`
 * （逐 chunk 列 + section palette 预筛 + 列间 yield；2026-09-28 修 14 秒冻结用的就是这套）。
 * 本函数**不重写扫描**，只负责"给它 id、把结果分类聚片、报耗时"。
 *
 * 半径 32 的理由：
 *   · mind 的 `/nearby` 是 16、`/chests/unseen` 是 24 —— 32 明显更远，够"余光"；
 *   · 32 格 = 2 个区块，列数 25 个 chunk 列，配合每列 yield 单批可控；
 *   · 再大（48/64）列数按平方涨，而她真要那棵树也是走过去 —— 不如先看见近的。
 *
 * @param bot
 * @param radius     32
 * @param oreIds     矿表 id 集合（`knowledge/ores.json` → registry id）
 * @param scanIn     `scanColumnsIn`（注入，避免本文件 require 本能层成环）
 * @param tagOf      (name, tag) => boolean（查 knowledge 的 blockTags 反查表）
 * @param yieldFn    让出函数
 * @param batchColumns 每多少列让一次（写进诊断）
 * @returns { items, perf, unloadedTop }
 */
async function scanAround ({
  bot, radius = 32, oreIds = null, scanIn, tagOf = null, tagIds = null, yieldFn = null,
  dy = 16, cap = 4000, batchColumns = 8,
  idBuildBatch = 500, clusterSliceMs = 12,
} = {}) {
  const t0 = Date.now();
  const self = bot.entity?.position;
  if (!self) return { items: [], perf: { ms: 0, columns: 0, cells: 0, batches: 0, skipped: '没有位置' }, unloadedTop: [] };
  const registry = bot.registry;
  const { Vec3 } = require('vec3');
  const { exposedToOpen } = require('./place');
  const yielder = yieldFn || (() => new Promise(res => setImmediate(res)));

  // 要扫哪些方块 id：把 SPECS 里出现过的标签展开成 id（**用真实标签**，不写死名单）
  const ids = new Set();
  const idOf = (n) => (registry.blocksByName[n] || registry.blocksByName[bareOf(n)])?.id;
  // 逐阶段耗时（任务书要求"看��出是哪一段慢"，GET /instinct 的 diagnostics 也带）
  const phase = {};
  const mark = (name, t0ns) => { phase[name] = +(Number(process.hrtime.bigint() - t0ns) / 1e6).toFixed(1); };
  // 矿表的方块（tier / value 从表里来）
  const tLoad = process.hrtime.bigint();
  const tables = fs.existsSync(path.join(paths.KNOWLEDGE, 'ores.json'))
    ? JSON.parse(fs.readFileSync(path.join(paths.KNOWLEDGE, 'ores.json'), 'utf8')) : [];
  const oreByName = new Map();
  for (const o of Array.isArray(tables) ? tables : []) {
    const id = idOf(o.name);
    if (id != null) { ids.add(id); oreByName.set(id, o); }
  }
  mark('oresTable', tLoad);
  // ★ 2026-09-29 Claude 复核：只靠"矿表 + 标签展开"凑 id，**只有名字兜底的**（黏土、南瓜、西瓜、甘蔗、岩浆……
  //   整合包里这些没有标签）永远进不了扫描清单 —— 分类写得再对也扫不到。自测靠假 tagIds 把黏土塞进去才绿。
  //   改为：整份方块注册表每个名字都过一遍 classifyBlock（判据仍只此一处），判得出类别的都扫。
  //
  // ★ 2026-09-29 实机（"走路很乱"）：**实机**注册表是 21579 个方块（`registry/minecraft-block.json`，
  //   `minecraft-data` 那 1003 个不是实机规模），整份同步过一遍实测 **30.1ms** —— 正好顶在
  //   "任何同步段 < 30ms"的红线上。现在**分批让出**（每 `idBuildBatch` 个一次），
  //   并把结果缓存到 `registry.__perceptionIds`（每份 registry 只算一次；
  //   自测里断言"第二次不重建"，别让缓存悄悄失效又变回每次 30ms）。
  if (registry && Array.isArray(registry.blocksArray)) {
    const key = '__perceptionIds';
    const tBuild = process.hrtime.bigint();
    const built = !registry[key];
    if (built) {
      const all = new Set();
      const batch = Math.max(1, idBuildBatch | 0);
      for (let i = 0; i < registry.blocksArray.length; i++) {
        const b = registry.blocksArray[i];
        // 石头、水到处都是：扫它们会把 cap 名额占满、挤掉真正要找的东西（分类照旧，只是不进扫描清单）
        try { const k = classifyBlock(b.name, { tagOf, type: b.id, oreByName: oreByName.size ? oreByName : null })?.kind; if (k && !SCAN_SKIP_KINDS.has(k)) all.add(b.id); } catch (_) {}
        if (i && i % batch === 0) await yielder();
      }
      Object.defineProperty(registry, key, { value: all, enumerable: false, configurable: true });
    }
    for (const id of registry[key]) ids.add(id);
    mark('idBuild', tBuild);
    phase.idBuildBuilt = built;          // true = 这一轮真建了清单；false = 走的缓存
    phase.idBuildSize = registry[key].size;
  } else { phase.idBuild = 0; phase.idBuildBuilt = null; }
  // 标签展开：调用方给 `tagIds(tag) → [方块名]`（由 knowledge 的 tags Set 转 registry id）
  if (typeof tagIds === 'function') {
    for (const spec of SPECS) for (const tag of (SCAN_SKIP_KINDS.has(spec.kind) ? [] : spec.tags || [])) {
      for (const name of (tagIds(tag) || [])) { const id = idOf(name); if (id != null) ids.add(id); }
    }
  }

  const c = new Vec3(Math.floor(self.x), Math.floor(self.y), Math.floor(self.z));
  const tScan = process.hrtime.bigint();
  const r = await scanIn({
    world: bot.world, registry, c, ids: [...ids], maxDist: radius, cap,
    opts: { dy, label: 'perception.scanAround' }, yieldFn: yielder,
  });
  mark('scan', tScan);

  // 扫出来的坐标 → 分类 → 聚片。读方块按批让出（每 200 个一次）
  const tCls = process.hrtime.bigint();
  const pts = [];
  let readFail = 0;
  for (let i = 0; i < r.pts.length; i++) {
    const p = r.pts[i];
    const b = bot.blockAt(p);
    if (!b) { readFail++; continue; }
    const cls = classifyBlock(b.name, { tagOf, type: b.type, oreByName: oreByName.size ? oreByName : null });
    if (cls) {
      const pos = { x: p.x, y: p.y, z: p.z };
      const nearWater = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([dx, dy2, dz]) => /water/.test(bot.blockAt(new Vec3(p.x + dx, p.y + dy2, p.z + dz))?.name || ''));
      // 矿：要求"露出一面"（任务书点名：埋着的不算）。别的类别不做这条（树就是树干本身，不存在埋不埋）
      if (cls.kind === 'ore') {
        const exposed = (() => { try { return bot.canSeeBlock(b); } catch (_) {} return false; })()
          || exposedToOpen(p, (x, y, z) => bot.blockAt(new Vec3(x, y, z)));
        if (!exposed) { if ((i + 1) % 200 === 0) await yielder(); continue; }
      }
      const row = oreByName.get(b.type);
      pts.push({
        name: b.name, pos, kind: cls.kind, underwater: nearWater || cls.kind === 'water',
        tier: row?.tier ?? null, value: row?.value ?? null,
      });
    }
    if ((i + 1) % 200 === 0) await yielder();
  }
  mark('classify', tCls);
  // ★ 分批聚片（上线跑这条）：老的同步 `cluster` 4000 点 49.6ms，每 5 秒堵一次事件循环。
  const tCluster = process.hrtime.bigint();
  const items = await clusterAsync(pts, { gap: 3, yieldFn: yielder, sliceMs: clusterSliceMs });
  mark('cluster', tCluster);
  // 距离 / 方向（她"看"这一刻要的是"东北 20 格"）
  // ⚠️ 这两个字段必须在 `merge` 里保住 —— 事件文字直接用它（2026-09-29 修 undefined 方向）
  for (const it of items) {
    it.distance = +Math.hypot(it.center.x - self.x, it.center.z - self.z).toFixed(1);
    it.direction = directionOf({ x: self.x, z: self.z }, it.center);
  }
  const columns = r.columns || 0;
  return {
    items,
    perf: {
      radius, ms: Date.now() - t0,
      columns, cells: r.cells || 0, sections: r.sections || 0,
      // 单批（一列）最长同步耗时 —— 任务书要求写进诊断
      worstMs: +(r.worstMs || 0).toFixed(1),
      // 让出次数 ≈ 列数 / batchColumns（每 batchColumns 列一次 setImmediate）
      batches: Math.ceil(columns / Math.max(1, batchColumns)),
      scannedPts: r.pts.length, classified: pts.length, readFail,
      unloadedColumns: r.unloaded || 0,
      // 逐阶段同步耗时（ms）—— 任务书："slow 日志保留，但要看得出是哪一段慢"
      phases: { ...phase },
    },
  };
}

// ------------------------------------------------------------------ 给 mind 的摘要行

/**
 * 【附近看得见的】那一行（最多 6 项）。
 * 排序由 `rank` 负责（野外没开过的容器永远前两 + needs 命中提前）。
 * 例子：`没开过的箱子 2 个（东北 20 格）、黏土一片（北 18 格，水下）、橡树 9 棵（东 6 格）`
 */
function renderLine (items = []) {
  if (!items.length) return '';
  return items.map(it => {
    const zh = KIND[it.kind]?.zh || '别的';
    const where = `${it.direction || ''}${Number.isFinite(it.distance) ? ` ${Math.round(it.distance)} 格` : ''}`.trim();
    const wet = it.underwater && it.kind !== 'water' ? '，水下' : '';
    if (it.kind === 'container') return `${it.opened === true ? '开过的' : '没开过的'}箱子 ${it.count} 个（${where}）`;
    if (it.kind === 'ore') return `露出的${bareOf(it.name).replace(/_/g, ' ')} ${it.count}（${where}）`;
    if (it.kind === 'log') return `${bareOf(it.name).replace(/_(log|wood|stem)$/, '')}树 ${it.count} 棵（${where}）`;
    if (Number.isFinite(it.area) || it.count > 2) return `${zh}一片（${where}${wet}，${it.count} 块）`;
    return `${bareOf(it.name).replace(/_/g, ' ')} ${it.count}（${where}${wet}）`;
  }).join('、');
}

// ------------------------------------------------------------------ 自测

async function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };

  // ---- 真实数据：minecraft-data 1.20.1 + 整合包 knowledge 标签
  const mcData = require('minecraft-data')('1.20.1');
  const knowledge = require('../knowledge/knowledge');
  let K = null;
  try { K = knowledge.load(); } catch (e) { console.log(`  （knowledge 加载失败：${e.message}）`); }
  check('★ 真实 minecraft-data 1.20.1 可用', !!mcData, true);
  check('★ 真实 knowledge 标签可用（blockTags 反查表）', !!K && K.blockTags instanceof Map, true);

  // 真实反查：方块名 → 它拥有的标签名（用**整合包数据**，不是我们写死的）
  const tagsOf = (name) => {
    const id = name.includes(':') ? name : `minecraft:${name}`;
    return K?.blockTags?.get(id) || new Set();
  };
  const cls = (name, ctx = {}) => classifyBlock(name, { tags: tagsOf(name), ...ctx });

  // ---- 分类（任务书点名的 7 个用例）
  check('★ oak_log → 树', cls('minecraft:oak_log')?.kind, 'log');
  check('★ clay → 黏土', cls('minecraft:clay')?.kind, 'clay');
  check('★ chest → 容器', cls('minecraft:chest')?.kind, 'container');
  check('★ ender_chest → 不算（末影箱排除）', cls('minecraft:ender_chest'), null);
  check('★ lava → 危险', cls('minecraft:lava')?.kind, 'danger');
  check('★ water → 水', cls('minecraft:water')?.kind, 'water');
  check('★ sand → 沙', cls('minecraft:sand')?.kind, 'sand');
  check('★ gravel → 砂砾', cls('minecraft:gravel')?.kind, 'gravel');
  check('★ poppy（花）→ 花', cls('minecraft:poppy')?.kind, 'flower');
  check('★ sugar_cane → 作物（名字兜底，没标签）', cls('minecraft:sugar_cane')?.kind, 'crop');
  check('★ pumpkin → 作物（名字兜底）', cls('minecraft:pumpkin')?.kind, 'crop');
  check('★ sweet_berry_bush → 作物（野果能采；扎脚不致命，Claude 2026-09-29 复核改）', cls('minecraft:sweet_berry_bush')?.kind, 'crop');
  check('★ wheat 长熟前是作物（minecraft:crops 标签）', cls('minecraft:wheat')?.kind, 'crop');
  check('★ barrel → 容器（forge:barrels）', cls('minecraft:barrel')?.kind, 'container');
  check('★ oak_leaves 不是树（叶不是原木）', cls('minecraft:oak_leaves'), null);
  check('空气不算资源', cls('minecraft:air'), null);
  check('分类来源写清了（标签 or 名字）', cls('minecraft:clay')?.source, 'name');
  check('…oak_log 走的是标签', cls('minecraft:oak_log')?.source, 'tag');

  // ---- 矿：露出 / 埋着（任务书点名的用例）
  // 用**真实** knowledge 的 `ores.json` 建"数字 id → 行"的索引（和 scanAround 里那一份同一形状）
  const ores = JSON.parse(require('fs').readFileSync(path.join(paths.KNOWLEDGE, 'ores.json'), 'utf8'));
  const ironRow = (Array.isArray(ores) ? ores : []).find(o => /(^|:)iron_ore$/.test(o.name));
  check('★ knowledge/ores.json 里有 iron_ore', !!ironRow, true);
  const oreByName = new Map();
  for (const o of Array.isArray(ores) ? ores : []) {
    const def = mcData.blocksByName[o.name] || mcData.blocksByName[o.name?.replace(/^.*:/, '')];
    if (def) oreByName.set(def.id, o);
  }
  const ironId = mcData.blocksByName.iron_ore?.id;
  check('★ 矿表索引按**真实注册 id** 建起来了', oreByName.has(ironId), true);
  check('★ iron_ore → 矿（矿表驱动）', classifyBlock('minecraft:iron_ore', { type: ironId, oreByName })?.kind, 'ore');
  check('…来源标了 table（不是标签也不是名字兜底）', classifyBlock('minecraft:iron_ore', { type: ironId, oreByName })?.source, 'table');
  // 露出的判据用真的 place.exposedToOpen（同一份实现，不手抄）
  const { exposedToOpen } = require('./place');
  const mkGet = (map) => (x, y, z) => (map.has(`${x},${y},${z}`) ? { name: map.get(`${x},${y},${z}`) } : { name: 'stone' });
  check('★ 露出的 iron_ore：旁边是空气 → 算→露出', exposedToOpen({ x: 0, y: 5, z: 0 }, mkGet(new Map([['0,6,0', 'air']]))), true);
  check('★ 埋着的 iron_ore：六面都是石头 → 不算露出', exposedToOpen({ x: 0, y: 5, z: 0 }, mkGet(new Map())), false);

  // ---- 聚片
  const P = (kind, x, y, z, name = 'minecraft:oak_log') => ({ kind, name, pos: { x, y, z }, underwater: false });
  // 同类相邻 20 块 → 1 条
  const twenty = [];
  for (let i = 0; i < 20; i++) twenty.push(P('log', 10 + (i % 5), 64, 10 + Math.floor(i / 5)));
  const c1 = cluster(twenty, { gap: 3 });
  check('★ 同类相邻 20 块 → 1 条', c1.length, 1);
  check('…那条记了 20 块', c1[0].count, 20);
  // 两片相隔很远 → 2 条
  const two = [...twenty, ...twenty.map(p => ({ ...p, pos: { x: p.pos.x + 200, y: p.pos.y, z: p.pos.z } }))];
  check('★ 两片相隔很远 → 2 条', cluster(two, { gap: 3 }).length, 2);
  // 一棵树的树冠 + 树干（跨度可能 > gap 但**连通**）不该被劈开
  check('★ 连通的一棵树 → 1 片（chain 扩张）',
    cluster([P('log', 0, 64, 0), P('log', 0, 66, 0), P('log', 0, 68, 0), P('log', 3, 70, 0)], { gap: 3 }).length, 1);
  check('相隔 4 格就断（gap=3）', cluster([P('log', 0, 64, 0), P('log', 0, 68, 0)], { gap: 3 }).length, 2);
  check('代表名字取片内最多的那个', cluster([P('log', 0, 64, 0, 'minecraft:oak_log'), P('log', 1, 64, 0, 'minecraft:oak_log'), P('log', 2, 64, 0, 'minecraft:birch_log')]).at(0).name, 'minecraft:oak_log');
  // 不同类别不并（三类**中心不相邻**，否则连通块按距离扩张会把它们串起来 —— 那是设计如此）
  check('不同类别不并成一条',
    cluster([P('log', 0, 64, 0), P('clay', 20, 64, 0), P('sand', 40, 64, 0)], { gap: 3 }).length, 3);
  check('水下：整片在水里才算', cluster([{ ...P('clay', 0, 60, 0), underwater: true }, { ...P('clay', 1, 60, 0), underwater: true }]).at(0).underwater, true);
  check('…露头一块就不算整片水下', cluster([{ ...P('clay', 0, 60, 0), underwater: true }, { ...P('clay', 1, 60, 0), underwater: false }]).at(0).underwater, false);

  // ---- 排序
  const items = [
    { kind: 'log', name: 'oak_log', center: { x: 6, y: 64, z: 0 }, count: 9, distance: 6, direction: '东' },
    { kind: 'clay', name: 'clay', center: { x: 0, y: 60, z: -18 }, count: 12, distance: 18, direction: '北', underwater: true },
    { kind: 'container', name: 'chest', center: { x: 15, y: 64, z: -15 }, count: 2, distance: 21, direction: '东北' },
    { kind: 'ore', name: 'iron_ore', center: { x: 0, y: 59, z: 5 }, count: 2, distance: 5, direction: '南', tier: 2 },
  ];
  const r1 = rank(items, ['黏土'], { max: 6 });
  // 「野外没开过的容器永远前两位」是**硬要求**（主人点名），所以这条先成立；
  // needs 命中的黏土紧接着占掉第二个位置。
  check('★ 没开过的野外箱子占掉第一或第二位', r1.slice(0, 2).some(x => x.kind === 'container'), true);
  check('★ 计划里缺黏土 → 黏土也在前两位', r1.slice(0, 2).some(x => x.kind === 'clay'), true);
  check('★ 没开过的野外箱子永远在前两位（无 needs 时也一样）',
    rank(items, [], { max: 6 }).slice(0, 2).some(x => x.kind === 'container'), true);
  // 没有容器时，needs 命中的排第一
  const noBox = items.filter(x => x.kind !== 'container');
  check('★ 没有容器时：缺黏土 → 黏土排第一', rank(noBox, ['黏土'], { max: 6 })[0].kind, 'clay');
  check('…黏土那条为什么排前面写清了（why=need）', rank(noBox, ['黏土'], { max: 6 })[0].why, 'need');
  check('…没命中的按有用度/距离（矿比树近）', rank(noBox, ['黏土'], { max: 6 })[1].kind, 'ore');
  const r3 = rank(items, [], { max: 6 });
  check('没有 needs 时容器仍在前两位', r3.slice(0, 2).some(x => x.kind === 'container'), true);
  check('开过的箱子不当"新发现"钉前面', rank([{ kind: 'container', name: 'chest', opened: true, distance: 1, center: { x: 1, y: 64, z: 1 }, count: 1 }, { kind: 'log', name: 'oak_log', distance: 9, center: { x: 9, y: 64, z: 0 }, count: 3 }], [], { max: 6 }).length, 2);
  check('最多 6 项', rank(Array.from({ length: 12 }, (_, i) => ({ kind: 'log', name: 'oak_log', distance: i, center: { x: i, y: 64, z: 0 }, count: 1 })), [], { max: 6 }).length, 6);
  check('rank 写清了为什么排这个（why）', !!r1[0].why, true);

  // ---- 记忆：写入 → 重启读回一致；没了 → 删；久没确认 → 降权
  const tmpFile = path.join(require('os').tmpdir(), `resources-test-${process.pid}.json`);
  process.env.MC_RESOURCES_FILE = tmpFile;
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  const now = 1_700_000_000_000;
  let st = emptyStore();
  const found = [
    { kind: 'log', name: 'oak_log', center: { x: 10, y: 64, z: 10 }, count: 9, underwater: false, dim: 'minecraft:overworld' },
    { kind: 'clay', name: 'clay', center: { x: 0, y: 60, z: -18 }, count: 12, underwater: true, dim: 'minecraft:overworld' },
  ];
  let m = merge(st, found, now, { dim: 'minecraft:overworld' });
  check('★ 新发现两条', m.added.length, 2);
  save(m.store);
  const re = load();
  check('★ 写入→读回一致（kind）', re.places.map(p => p.kind).sort().join(','), 'clay,log');
  check('★ 读回一致（坐标）', re.places.find(p => p.kind === 'clay').center.z, -18);
  check('★ 读回一致（水下标记）', re.places.find(p => p.kind === 'clay').underwater, true);
  // 再扫一次（同位置）→ 不新增，算 refreshed
  m = merge(re, found, now + 1000, { dim: 'minecraft:overworld' });
  check('★ 同类同位置 → 合一条，不新增', m.added.length, 0);
  check('…算"又看见了"（refreshed）', m.refreshed.length, 2);
  check('…条数还是 2', m.store.places.length, 2);
  // 去了发现没了 → 删
  let f = forget(m.store, { now: now + 2000, near: { x: 0, z: -18 }, goneRadius: 8 });
  check('★ 去了发现没了 → 删掉黏土那条', f.gone.length, 1);
  check('…橡树那条还在', f.store.places.some(p => p.kind === 'log'), true);
  // 很久没确认 → 降权（不是删）
  f = forget(f.store, { now: now + 60 * 60 * 1000, decayAfterMs: 30 * 60 * 1000, decayRate: 0.5 });
  check('★ 很久没确认 → 降权（不删）', f.decayed.length, 1);
  check('…权重变成 0.5', f.store.places[0].weight, 0.5);
  check('…还在（只是降权）', f.store.places.length, 1);
  check('"没了"和"没去确认"分开（removed 里没有降权的）', f.removed.length, 0);
  // 降到阈值以下才剔
  f = forget(f.store, { now: now + 60 * 60 * 1000, decayAfterMs: 30 * 60 * 1000, decayRate: 0.1, dropBelow: 0.2 });
  check('★ 降到阈值以下 → 剔掉', f.store.places.length, 0);
  try { fs.unlinkSync(tmpFile); } catch (_) {}

  // ---- 容器目标（家外 / 开过 / 家内）
  const places = [
    { kind: 'container', name: 'chest', center: { x: 100, y: 64, z: 100 }, dim: 'minecraft:overworld', seenAt: now, confirmedAt: now },
    { kind: 'container', name: 'chest', center: { x: 5, y: 64, z: 5 }, dim: 'minecraft:overworld', seenAt: now, confirmedAt: now },
    { kind: 'container', name: 'chest', center: { x: 150, y: 64, z: 150 }, dim: 'minecraft:overworld', seenAt: now, confirmedAt: now },
    { kind: 'log', name: 'oak_log', center: { x: 3, y: 64, z: 3 }, dim: 'minecraft:overworld', seenAt: now, confirmedAt: now },
  ];
  const home = { center: { x: 0, y: 64, z: 0 }, radius: 16 };
  const isHome = (c) => (Math.hypot(c.x - home.center.x, c.z - home.center.z) <= home.radius && Math.abs(c.y - home.center.y) <= 16);
  const seenKeys = new Set(['150,64,150']);   // 那个开过了
  const targets = containerTargets(places, { isHome, home, seenKeys, dim: 'minecraft:overworld', now });
  check('★ 家范围外没开过 → 当目标', targets.some(t => t.center.x === 100), true);
  check('★ 开过的 → 不当目标', targets.some(t => t.center.x === 150), false);
  check('★ 在家范围内 → 不当野外箱子', targets.some(t => t.center.x === 5), false);
  check('…树不算容器目标', targets.some(t => t.kind === 'log'), false);
  check('…一共 1 个目标', targets.length, 1);
  check('…目标标了 outdoor', targets[0].outdoor, true);

  // ---- 摘要行
  const line = renderLine(rank(items, ['黏土'], { max: 6 }));
  check('★ 摘要行能读（含"没开过的箱子"）', /没开过的箱子/.test(line), true);
  check('…含黏土（水下）', /黏土/.test(line), true);
  check('…含方向与距离', /(东|北|东北|南)\s*\d+\s*格/.test(line), true);

  // ---- 性能：模拟 32 格扫描，单批（单柱）最长耗时写进输出
  // 用**真的** scanColumnsIn（分段让出，每列 yield）+ 一个假世界把整块扫描跑一遍，
  // 报真实数字 —— 不是"估一个"。假世界的地表在 y=63，下面是石头 / 黏土 / 沙。
  //
  // ⚠️ 假世界必须给出**真实的 state id**：`scanColumnsGen` 靠 section 的调色板
  //    （`pc.palette` / `pc.value`）预筛 + `getBlockStateId` 精确比对，
  //    给 0 会"整节跳过"（那样测不到东西，还会假装通过）。
  const { scanColumnsIn } = require('../instinct/core');
  const nameAt = (x, y, z) => (y > 63 ? 'air' : y === 63 ? 'grass_block' : y > 58 ? 'stone' : y === 58 ? 'clay' : 'sand');
  const stateOf = (name) => mcData.blocksByName[name]?.defaultState ?? 0;
  const PALETTE = { palette: [...new Set(['air', 'grass_block', 'stone', 'clay', 'sand'].map(stateOf))] };
  const fakeWorld = {
    getColumn (cx, cz) {
      return {
        minY: -64,
        // 一列一个 section（y 0..15）。`scanColumnsGen` 用下标 `(y - minY) >> 4`，
        // 地表在 y≈60 → 下标 7，所以数组要够长（给 8 个），否则 `sec` 是 undefined
        // → 整柱跳过（扫不到东西还不报错 —— 这正是"测试假装通过"的陷阱）。
        sections: Array.from({ length: 8 }, () => ({ data: PALETTE })),
        getBlockName (wx, wy, wz) { return nameAt(wx, wy, wz); },
        getBlockStateId ({ y }) { return stateOf(nameAt(0, y, 0)); },
      };
    },
  };
  const fakeBot = {
    world: fakeWorld,
    registry: mcData,
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (p) => {
      const name = nameAt(p.x, p.y, p.z);
      return { name, type: mcData.blocksByName[name]?.id ?? 0, position: p };
    },
    canSeeBlock: () => false,
  };
  const flatTagOf = (name, tag) => tagsOf(name).has(tag);
  const probeIds = [...new Set(['grass_block', 'stone', 'clay', 'sand', 'oak_log']
    .map(n => mcData.blocksByName[n]?.id).filter(x => x != null))];
  // ① 只量扫描本身（32 格、全量、不分批让出，看单柱最长同步耗时）
  const t0 = Date.now();
  const scanRes = await scanColumnsIn({
    world: fakeWorld, registry: mcData, c: fakeBot.entity.position, ids: probeIds,
    maxDist: 32, cap: 0, opts: { dy: 8, label: 'perception.bench' },
    yieldFn: () => new Promise(res => setImmediate(res)),
  });
  const ms = Date.now() - t0;
  console.log(`  [性能] 32 格扫描：${scanRes.columns} 柱 / ${scanRes.cells} 格 / ${scanRes.sections} 节，`
    + `总 ${ms}ms，单柱最长 ${scanRes.worstMs.toFixed(1)}ms，让出 ${Math.ceil(scanRes.columns / 8)} 批`);
  // 单柱最长必须压得住（2026-09-28 那次 14 秒冻结的教训：单批同步不许长）
  check('★ 单柱最长同步 < 200ms（不许再冻进程）', scanRes.worstMs < 200, true);

  // ② scanAround 端到端（分类 + 聚片也真跑一遍）
  // 少了 `tagIds` 就像真跑时**没有知识库**：只扫矿表里的方块 → 假世界里一个都没有，
  // 会"看起来通过但什么都没扫"。这里显式把假世界那几种方块当标签展开交进去。
  const scan2 = await scanAround({
    bot: fakeBot, radius: 16,
    tagIds: (tag) => (tag === 'minecraft:logs' ? ['oak_log'] : ['grass_block', 'stone', 'clay', 'sand']),
    tagOf: flatTagOf,
    scanIn: scanColumnsIn, yieldFn: () => new Promise(res => setImmediate(res)), cap: 2000,
  });
  check('★ scanAround 端到端跑得通（不抛错）', Number.isFinite(scan2.perf.ms), true);
  check('…报了单批最长耗时（任务书要求）', Number.isFinite(scan2.perf.worstMs), true);
  check('…扫出了东西（假世界里黏土/沙都在）', scan2.items.length > 0, true);
  check('…片上有中心坐标', !!scan2.items[0]?.center, true);
  check('…片上有方向与距离', Number.isFinite(scan2.items[0]?.distance), true);
  console.log(`  [性能] scanAround(radius=16) 总 ${scan2.perf.ms}ms，单柱最长 ${scan2.perf.worstMs}ms，`
    + `柱 ${scan2.perf.columns}，分类命中 ${scan2.perf.classified}/${scan2.perf.scannedPts}`);

  // ================================================================ 2026-09-29 实机修（B/C）
  // 这一段测的是**跑的那份**判据：分批后的 scanAround / clusterAsync / worthTelling / shouldRescan。
  // 起因（实机）：`slow perception.scanAround` 0.5–5 秒、`scheduler.maxLagMs: 908` ——
  //   事件循环被同步代码堵住，物理 tick 跑不动，她走路一顿一顿。
  const { monitorEventLoopDelay } = require('perf_hooks');
  const nowT = 1_700_000_000_000;

  // ---- ① 分批聚片：和同步 cluster **结果必须一致**（同一内核，不是两套实现）----
  {
    const big = [];
    for (let i = 0; i < 3000; i++) {
      big.push({ kind: 'log', name: 'oak_log', pos: { x: (i * 7) % 120 - 60, y: 64 + (i % 5), z: (i * 11) % 120 - 60 }, underwater: false });
    }
    const syncOut = cluster(big, { gap: 3 });
    let yields = 0;
    const asyncOut = await clusterAsync(big, {
      gap: 3, sliceMs: 2,
      yieldFn: () => { yields++; return new Promise(res => setImmediate(res)); },
    });
    check('★ clusterAsync 与同步 cluster **结果一致**（同一内核）', JSON.stringify(asyncOut) === JSON.stringify(syncOut), true);
    check('…真的让出过（不是一次跑完）', yields > 0, true);
    console.log(`  [性能] cluster 3000 点：同步 ${JSON.stringify(syncOut).length} 字节结果，clusterAsync 让出 ${yields} 次`);
  }

  // ---- ② 用**真实 1.20.1 注册表**跑一遍建清单 + 一次 scanAround，量事件循环最大延迟 ----
  // 注册表用 minecraft-data 的（自测环境没有实机那 21579 个；这里如实说明规模，数字一起打出来）
  {
    const reg = mcData;
    delete reg.__perceptionIds;                       // 先清掉，让这一轮真建
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    const tA = Date.now();
    const first = await scanAround({
      bot: fakeBot, radius: 16, tagIds: () => ['grass_block', 'stone', 'clay', 'sand', 'oak_log'],
      tagOf: flatTagOf, scanIn: scanColumnsIn, yieldFn: () => new Promise(res => setImmediate(res)), cap: 2000,
      idBuildBatch: 100, clusterSliceMs: 4,
    });
    const msA = Date.now() - tA;
    const maxNs = h.max;
    h.disable();
    const maxMs = +(maxNs / 1e6).toFixed(1);
    console.log(`  [性能] 真实注册表 ${reg.blocksArray.length} 块：第一次 scanAround ${msA}ms，`
      + `建清单 ${first.perf.phases.idBuild}ms（建了=${first.perf.phases.idBuildBuilt}），`
      + `cluster ${first.perf.phases.cluster}ms，**事件循环最大延迟 ${maxMs}ms**`);
    check('★ 事件循环最大延迟 < 50ms（量出来的数字在上面）', maxMs < 50, true);
    check('…第一次真建了扫描清单', first.perf.phases.idBuildBuilt, true);
    check('…perf 里带了逐阶段耗时（看得出是哪一段慢）', typeof first.perf.phases.cluster === 'number', true);

    // 第二次：**不重建清单**（缓存真的生效）
    const tB = Date.now();
    const second = await scanAround({
      bot: fakeBot, radius: 16, tagIds: () => ['grass_block', 'stone', 'clay', 'sand', 'oak_log'],
      tagOf: flatTagOf, scanIn: scanColumnsIn, yieldFn: () => new Promise(res => setImmediate(res)), cap: 2000,
      idBuildBatch: 100, clusterSliceMs: 4,
    });
    console.log(`  [性能] 第二次 scanAround ${Date.now() - tB}ms，建清单 ${second.perf.phases.idBuild}ms（建了=${second.perf.phases.idBuildBuilt}）`);
    check('★★ 第二次扫描**不重建**清单（走的缓存）', second.perf.phases.idBuildBuilt, false);
    check('…两次扫出来的一样（缓存没改变行为）', second.items.length, first.items.length);
  }

  // ---- ③ shouldRescan：没移动 + 60 秒内 → 不重扫 ----
  {
    const cfg = { everyMs: 5000, busyEveryMs: 20000, minMoveBlocks: 8, minRescanMs: 60000 };
    check('★ 没怎么动（2 格）+ 距上次 10 秒 → 不重扫', shouldRescan({ sinceMs: 10000, moveDist: 2 }, cfg).scan, false);
    check('…理由说清"没怎么动"', /没怎么动/.test(shouldRescan({ sinceMs: 10000, moveDist: 2 }, cfg).why), true);
    check('★ 动过了（20 格）→ 重扫', shouldRescan({ sinceMs: 6000, moveDist: 20 }, cfg).scan, true);
    check('★ 没动但距上次超过 60 秒 → 也重扫（东西会变）', shouldRescan({ sinceMs: 70000, moveDist: 2 }, cfg).scan, true);
    check('★ 上一轮还没跑完 → 不重扫（防叠）', shouldRescan({ sinceMs: 999999, moveDist: 99, busy: true }, cfg).scan, false);
    check('走路/打架/开界面 → 放慢到 busyEveryMs', shouldRescan({ sinceMs: 6000, moveDist: 99, occupied: true }, cfg).everyMs, 20000);
    check('…闲着时用 everyMs', shouldRescan({ sinceMs: 6000, moveDist: 99, occupied: false }, cfg).everyMs, 5000);
    check('★ 忙的时候 6 秒还不到 20 秒 → 先不扫', shouldRescan({ sinceMs: 6000, moveDist: 99, occupied: true }, cfg).scan, false);
  }

  // ---- ④ 事件过滤：只发用得上的（缺的 / 值钱的矿 / 没开过的野外容器）----
  {
    const batch = [
      { kind: 'flower', name: 'minecraft:poppy', center: { x: 1, y: 64, z: 1 }, count: 3, distance: 2, direction: '东' },
      { kind: 'gravel', name: 'minecraft:gravel', center: { x: 2, y: 64, z: 2 }, count: 5, distance: 3, direction: '东' },
      { kind: 'log', name: 'minecraft:oak_log', center: { x: 3, y: 64, z: 3 }, count: 9, distance: 4, direction: '东南' },
      { kind: 'ore', name: 'minecraft:iron_ore', center: { x: 4, y: 59, z: 4 }, count: 2, distance: 5, direction: '南', value: 'high' },
      { kind: 'ore', name: 'minecraft:coal_ore', center: { x: 5, y: 59, z: 5 }, count: 4, distance: 6, direction: '西南', value: 'low' },
      { kind: 'container', name: 'minecraft:chest', center: { x: 6, y: 64, z: 6 }, count: 1, distance: 7, direction: '西', opened: false },
    ];
    const tell = (it, needs) => worthTelling(it, { needs }).tell;
    check('★ 花 → 不发事件（她不需要）', tell(batch[0], []), false);
    check('★ 砂砾 → 不发事件', tell(batch[1], []), false);
    check('★ 普通树 → 不发事件', tell(batch[2], []), false);
    check('★★ 没缺铁矿、不是值钱类别 → 不发', tell(batch[4], []), false);
    check('★ 值钱的矿（iron_ore value=high）→ 发', tell(batch[3], []), true);
    check('…理由标了 valuable', worthTelling(batch[3], { needs: [] }).why, 'valuable');
    check('★ 没开过的箱子 → 发', tell(batch[5], []), true);
    check('…理由标了 container', worthTelling(batch[5], { needs: [] }).why, 'container');
    check('★ 开过的箱子 → 不发（不是新发现了）', tell({ ...batch[5], opened: true }, []), false);
    // needs 命中要**具体**：缺铁 → 铁矿发、"矿"这个大类不发另一条矿
    check('★★ 缺铁矿（needs 有 iron）→ 铁矿发', tell(batch[3], ['iron']), true);
    check('…理由标了 need', worthTelling(batch[3], { needs: ['iron'] }).why, 'need');
    check('★ 缺铁时**另一条**矿（煤，名字不沾 iron）→ 不发', tell(batch[4], ['iron']), false);
    check('★ 缺黏土 → 黏土发', tell({ kind: 'clay', name: 'minecraft:clay', center: { x: 0, y: 60, z: 0 }, count: 12 }, ['黏土']), true);
    // ⚠️ 老 bug：needsFrom 会把**裸类别名**（"矿"）塞进关键词，于是所有矿都算"缺的"，
    //    事件挂"（你现在正缺这个）"却不说缺的是哪种 —— 这条锁住它不再犯。
    check('★★ 裸的类别中文"矿"**不算**具体命中某一条矿（缺的是哪种要说清）',
      nameHitsNeed(batch[4], needKeysOf(['矿'])), null);
    check('…值钱的矿仍然照发（"缺矿"没命中，但它是 valuable）', tell(batch[3], ['矿']), true);
    check('★★ 缺铁 → label 是"具体是何物"（用中文名，主人看得懂），不是泛泛的类别',
      worthTelling(batch[3], { needs: ['iron'] }).label, '铁矿石');
    check('★ …绝不把裸类别名"矿"当 label 回带', worthTelling(batch[3], { needs: ['iron'] }).label === '矿', false);
    // 整句计划当 needs 时，label 必须是"这一片自己的名字"，不能是那句话
    check('★★ 计划写"去挖点铁矿"→ label 仍是个名字，不是整句',
      worthTelling(batch[3], { needs: needsFrom({ planStep: '去挖点铁矿' }) }).label, '铁矿石');
    check('★ …计划只说"挖点矿"（没说是哪种）→ 这条矿**不发**',
      tell(batch[4], needsFrom({ planStep: '挖点矿' })), false);
    check('★ 点名缺花 → 花也发（"缺了就发"这一条留了口子）',
      tell(batch[0], ['poppy']), true);
    // 方向不是 undefined（C3 回归：merge 曾经把 direction 丢掉）
    const mg = merge(emptyStore(), [{
      kind: 'ore', name: 'minecraft:iron_ore', center: { x: 4, y: 59, z: 4 }, count: 2,
      underwater: false, dim: 'overworld', direction: '南', distance: 5,
    }], nowT, { dim: 'overworld' });
    check('★★ merge 出来的新片带着 direction（曾经丢了 → 事件里打出 undefined）', mg.added[0].direction, '南');
    check('★ …也带着 distance', mg.added[0].distance, 5);
    // 又看见一次：刷新分支也要保住
    const mg2 = merge(mg.store, [{
      kind: 'ore', name: 'minecraft:iron_ore', center: { x: 4, y: 59, z: 4 }, count: 3,
      underwater: false, dim: 'overworld', direction: '南', distance: 4,
    }], nowT + 1000, { dim: 'overworld' });
    check('★ merge 刷新分支也保住 direction', mg2.refreshed[0].direction, '南');
    check('…刷新时 distance 一起更新', mg2.refreshed[0].distance, 4);
    // 方向名本身（判据在 directionOf 一处）
    check('★ 方向判据：正南', directionOf({ x: 0, z: 0 }, { x: 0, z: 5 }), '南');
    check('★ 方向判据：原地 → 脚下', directionOf({ x: 0, z: 0 }, { x: 0, z: 0 }), '脚下');
  }

  // ---- ⑤ 写盘节流（改前：每轮无条件 writeFileSync）----
  {
    const cfgSave = { saveMinIntervalMs: 30000 };
    check('★ 没变化 → 不写', shouldSave({ changed: false, sinceSaveMs: 999999 }, cfgSave).write, false);
    check('…理由说清"没变化"', /没变化/.test(shouldSave({ changed: false, sinceSaveMs: 999999 }, cfgSave).why), true);
    check('★ 有变化但刚写过 5 秒 → 攒着不写', shouldSave({ changed: true, sinceSaveMs: 5000 }, cfgSave).write, false);
    check('★ 有变化且过了 30 秒 → 写', shouldSave({ changed: true, sinceSaveMs: 31000 }, cfgSave).write, true);
    check('★ 签名变了也算"有变化"', shouldSave({ sig: 'b', lastSig: 'a', sinceSaveMs: 99000 }, cfgSave).write, true);
    check('…签名没变不算', shouldSave({ sig: 'a', lastSig: 'a', sinceSaveMs: 99000 }, cfgSave).write, false);
    // saveAsync 与同步 save 写出来**一样**（同语义，只是异步）
    const f1 = path.join(require('os').tmpdir(), `perc-async-${process.pid}.json`);
    const storeT = { at: nowT, dim: 'overworld', places: [{ kind: 'log', name: 'oak_log', center: { x: 1, y: 2, z: 3 }, count: 1 }] };
    const wrote = await saveAsync(storeT, f1);
    check('★ saveAsync 写成功', wrote, true);
    const back = load(f1);
    check('…读回来一致（kind）', back.places[0].kind, 'log');
    check('★ saveAsync 是**异步**的（返回 Promise）', typeof saveAsync(storeT, f1).then === 'function', true);
    try { fs.unlinkSync(f1); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = {
  KIND, SPECS, classifyBlock, cluster, clusterAsync, clusterSteps, directionOf, rank, renderLine,
  load, save, saveAsync, shouldSave, emptyStore, merge, forget, needsFrom, containerTargets, placeKey, FILE,
  needKeysOf, nameHitsNeed, worthTelling, shouldRescan, zhNameOf, displayName,
  scanAround, selftest,
};

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
