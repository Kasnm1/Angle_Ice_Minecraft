'use strict';

const paths = require('../../paths');

/**
 * 寻路策略 —— 让"绕路"成为默认，"拆方块"成为最后手段。
 *
 * ## 为什么需要这个模块
 *
 * mineflayer-pathfinder 的默认值是 `canDig = true, digCost = 1`。看 readme 好像没问题，
 * 但读源码（lib/movements.js）才知道代价的真实量级：
 *
 *   getMoveForward             cost = 1                            // 走一格
 *   safeOrBreak（拆一格泥土）   (1 + 3 * digTime/1000) * digCost
 *                            ≈ (1 + 3*0.15) * 1 ≈ 1.45             // 拿铲子
 *
 * 也就是说**拆掉一格方块比走一格贵不了多少** —— 寻路器于是把墙当成了路。
 * 玩家那句"你别拆我房子呀"就是这么来的。
 *
 * ## 上一版的修法是错的（canDig = false）
 *
 * 一刀切禁掉挖掘确实保住了房子，但把"最后手段"也砍了：遇到真正必须穿过的地方，
 * 寻路器直接判定无路，`No path to the goal!` 反而**变多**。这是钝器。
 *
 * ## 正确的修法：两层
 *
 * ① **软的一层：抬高 `digCost`** —— 拆方块变成"很贵但可行"。绕路优先；
 *    实在绕不过去时她仍然能过。这一层**不依赖方块名字**，所以在模组服上一定生效。
 * ② **硬的一层：`blocksCantBreak` 加入建筑材质** —— 羊毛/木板/玻璃/门/楼梯……
 *    这些方块寻路时**永不破坏**，只能绕。房子不会被拆，代价是"过不去就说不过去"，
 *    这比把人家房子推平要好得多，而且上一轮的重试上限会让她承认做不到。
 *
 * ⚠️ 第②层依赖 `registry.blocksByName` 的名字。**这个包约 470 个模组，
 * 已知方块名在模组服上不完全可信**（见 SKILL.md 的"方块名不可信"铁律）。
 * 所以运行时用 `probeRegistry()` 做一次往返自检并把结果暴露在 `GET /config` 上：
 * 如果往返对不上，说明名字这一层不可靠，**实际起作用的是第①层**。
 * 两层一起给，是为了在名字不可信时也不会退化成"什么都不保护"。
 *
 * 判定用**名字模式**而不是固定清单：模组方块（`quark:*_planks`）硬编码必漏。
 */

// ------------------------------------------------------------------ 名字归一

/**
 * 剥掉命名空间前缀。注册表里的名字有的带 `mod:block`，有的不带；
 * 不剥的话 `quark:oak_planks` 会漏掉所有 `_planks` 规则。
 */function bareName (name) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

// ---------------------------------------------------------------- 流体常量

/** 认得出的液体名。带 `flowing_` 的是流动状态，两者都要认。 */
const LIQUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);

/** 向上找液体的最大高度。32 格 ≈ 三层楼，够覆盖水柱与瀑布。 */
const MAX_VERTICAL_FLOW_LOOKAHEAD = 32;

/** 打在同一份 Movements 上的"已装防护"标记，防重复注入。用 Symbol 避免和库撞名。 */
const FLUID_GUARD_FLAG = Symbol('angleice-fluid-guard');

// -------------------------------------------------------------- 受保护方块

/**
 * 命中即"寻路时永不破坏，只能绕行"。
 *
 * 分四组：建筑材料 / 木料 / 容器与功能方块 / 矿物。
 * 每一组都宁可多保护一点 —— 少拆一格是小事，拆了玩家的房子是大事。
 */
const PROTECTED_PATTERNS = [
  // ---- 建筑材料（玩家造房子的东西）----
  /(^|_)wool$/,                                        // 羊毛（16 色 + 模组色）
  /(^|_)carpet$/,                                      // 地毯
  /(^|_)planks?$/,                                     // 木板
  /(^|_)glass$/, /(^|_)pane$/,                         // 玻璃 / 玻璃板
  /(^|_)door$/, /(^|_)trapdoor$/,                      // 门 / 活板门
  /(^|_)stairs?$/, /(^|_)slab$/,                       // 楼梯 / 台阶
  /(^|_)fence$/, /(^|_)fence_gate$/, /(^|_)wall$/,     // 栅栏 / 栅栏门 / 墙
  /(^|_)bricks?$/,                                     // 砖
  /(^|_)concrete$/, /(^|_)concrete_powder$/,           // 混凝土
  /(^|_)terracotta$/, /(^|_)glazed_terracotta$/,       // 陶瓦
  /(^|_)(sign|hanging_sign|banner)$/,                  // 告示牌 / 旗帜
  /(^|_)(button|pressure_plate|lever|rail)$/,          // 按钮 / 踏板 / 拉杆 / 铁轨
  /(^|_)(torch|lantern|lamp|candle|chain)$/,           // 照明
  /(^|_)(bed|flower_pot|painting|item_frame|armor_stand)$/,

  // ---- 木料（树也是景观；想砍树请走 POST /mine）----
  /(^|_)(log|wood|stem|hyphae)$/,

  // ---- 容器与功能方块（里面可能有玩家的东西）----
  /^chest$/, /(^|_)chest$/, /(^|_)barrel$/, /(^|_)shulker_box$/,
  /(^|_)(furnace|smoker|blast_furnace)$/,
  /(^|_)(crafting_table|crafter)$/,
  /(^|_)(anvil|cauldron|bookshelf|lectern|hopper|dropper|dispenser|brewing_stand)$/,
  /(^|_)(enchanting_table|grindstone|smithing_table|stonecutter|loom|composter)$/,
  /(^|_)(beacon|conduit|respawn_anchor|end_portal_frame)$/,

  // ---- 矿物（拆了就是白捡；不该是"顺路"的副产品）----
  /(^|_)ore$/, /^ancient_debris$/,
];

/** 这个方块名是不是"寻路时永不破坏"？纯函数，可离线穷举。 */
function isProtected (name) {
  const n = bareName(name);
  if (!n) return false;
  return PROTECTED_PATTERNS.some(re => re.test(n));
}
// ------------------------------------------------------------------ 代价

/**
 * 代价的基准（读源码得来，不是猜的）：
 *   - 走一格 = 1
 *   - 拆一格 = (1 + 3 * 挖掘秒数) * digCost
 *
 * 所以 `digCost = 16` 的意思是"拆一格泥土 ≈ 走 23 格"：
 * 她宁愿绕二十来格也不动你的地，但真绕不过去时会挖。
 *
 * ⚠️ 注意代价还会被 `cost > 100 就丢弃` 截断（movements.js 里到处是这个判断）。
 * 这带来一个**符合直觉的副作用**：赤手空拳拆石头算出来远超 100，于是"没镐子就挖不动石头"
 * —— 真人也是这样。这不是 bug，是特性。
 */
const COSTS = {
  digCost: parseInt(process.env.MC_DIG_COST || '16'),
  placeCost: parseInt(process.env.MC_PLACE_COST || '12'),
  liquidCost: parseInt(process.env.MC_LIQUID_COST || '6'),
};

// ------------------------------------------------------ 寻路是否允许拆方块

/**
 * 寻路器能不能**拆掉挡路的方块**。默认 **false —— 只绕，不拆**。
 *
 * ⚠️ 2026-09-25 用户明确要求：「寻路器暂时不要挖东西，这个以后我们要通过 jev 去判断行动」。
 *    在此之前默认是 true + digCost=16（"很贵但可行"），理由见本文件开头那一段。
 *    但那条设计有个**已实测的破口**：`PROTECTED_PATTERNS` 是**按名字模式**保护的，
 *    而模组装饰方块的名字（`cluttered:antique_mini_table`、
 *    `ultramarine:medium_white_porcelain_vase_bonsai`）**一个模式都不匹配** ——
 *    于是"最后手段"在模组服上直接变成了"顺手拆掉玩家的装饰"。实测被拆过两格，
 *    见 `memory/2026-09-25.md`。名字是开集，穷举必漏；所以**默认收紧成不拆**。
 *
 * 打开的两种方式（都要显式，不会意外生效）：
 *   · `MC_ALLOW_DIG=true`（config.json / 环境变量）—— 全局放行，回到"很贵但可行"；
 *   · `applyPolicy(mv, names, { allowDig: true })` —— 单次调用放行，留给将来
 *     由 JEV 判定"这一趟该不该挖"的调用方用。
 *
 * 关掉之后的影响（诚实说）：
 *   · 拆不掉墙 ⇒ 绕不过去时直接 `No path`。这是**预期行为**，不是退化 ——
 *     宁可承认走不过去，也不要拆玩家的东西；
 *   · `POST /mine` **不受影响**：它走 `bot.dig`，不经过寻路器。
 *     所以"要挖"这件事仍然做得到，只是必须由上层显式发起（将来就是 JEV）。
 */
// 第 4 步去重：`(process.env.X ?? 'false') === 'true'` → util/env.js 的 B 派（逐字等价）
const { envTrue } = require('../../util/env');
const ALLOW_DIG = envTrue('MC_ALLOW_DIG');
// ------------------------------------------------- 可攀爬方块（梯子识别）
// ------------------------------------------------ 右键"用"一个方块（选面）

/**
 * 选出"她够得着的那一面"—— 返回**朝向她的**面法线。
 *
 * 为什么需要它：`bot.activateBlock(block, direction, cursorPos)` 必须带上点的是哪一面
 * （`direction`），默认是顶面 `(0,1,0)`。而玩家指出的那个活板门在**她头顶上方**
 * （y=78，她在 y≈76），顶面朝向屋顶里面、根本够不着 —— 得点**底面** `(0,-1,0)`。
 *
 * 规则很朴素：拿"眼睛 → 方块中心"的向量，取绝对值最大的那个轴，
 * 法线取同号（指向她）。这就是真人会点的那一面。
 *
 * 纯函数：给两个点就出结果，可以离线穷举，不需要连服务器试。
 *
 * @param {{x:number,y:number,z:number}} blockPos 方块坐标（整数格）
 * @param {{x:number,y:number,z:number}} eyePos   眼睛的世界坐标
 * @returns {number[]} `[nx, ny, nz]`，单位法线
 */
function faceTowardBlock (blockPos, eyePos) {
  const dx = eyePos.x - (blockPos.x + 0.5);
  const dy = eyePos.y - (blockPos.y + 0.5);
  const dz = eyePos.z - (blockPos.z + 0.5);
  const ax = Math.abs(dx); const ay = Math.abs(dy); const az = Math.abs(dz);
  // 平手时的优先级：Y > X > Z。写在注释里而不是靠运气 —— 三轴同距时结果要可预测。
  if (ay >= ax && ay >= az) return [0, dy >= 0 ? 1 : -1, 0];
  if (ax >= az) return [dx >= 0 ? 1 : -1, 0, 0];
  return [0, 0, dz >= 0 ? 1 : -1];
}

// ------------------------------------------------------------ 应用到 Movements

/**
 * 由注册表算出"永不破坏"的方块 ID 集合。
 *
 * @param {object} blocksByName  bot.registry.blocksByName（名字 → 方块定义）
 * @returns {{ids: Set<number>, matched: string[]}}
 */
function buildProtectedIds (blocksByName) {
  const ids = new Set();
  const matched = [];
  if (!blocksByName || typeof blocksByName !== 'object') return { ids, matched };
  for (const name of Object.keys(blocksByName)) {
    if (!isProtected(name)) continue;
    const def = blocksByName[name];
    if (def && typeof def.id === 'number') {
      ids.add(def.id);
      matched.push(name);
    }
  }
  return { ids, matched };
}

/**
 * 把策略写到 pathfinder 的 Movements 实例上。
 *
 * 返回一份"实际生效了什么"的摘要，直接给 GET /config 用 ——
 * 不返回的话，"策略到底有没有装上"就只能靠猜。
 */

const SAFE_DROP = 3;    // 3 格以内落地不掉血
const MAX_DROP = 8;     // 再高就不走
/** 跳下 h 格的额外代价：≤3 格 0；4–8 格每格 +40（走 40 格路的代价）→ 有别的路一定绕 */
function dropPenalty (h) { return h > SAFE_DROP ? (h - SAFE_DROP) * 40 : 0; }
const MLG_DROP = 24;    // 身上有水桶（且不在下界）：落地水保命，最多往下跳这么高（代价照样按 dropPenalty，有路一定绕）
/**
 * 落地水本能（主人 2026-09-27）：有水桶就允许更高的跳落 —— 搭不了路、又要下去的时候跳，落地前倒水（instinct.js 的反射）。
 * 下界放不了水（会蒸发），不放宽。返回生效的 maxDropDown。
 */
function setDropAllowance (mv, { water = false, nether = false } = {}) {
  mv.maxDropDown = water && !nether ? MLG_DROP : MAX_DROP;
  return mv.maxDropDown;
}

const NATURAL_TAGS = [
  'minecraft:base_stone_overworld', 'minecraft:base_stone_nether', 'minecraft:dirt', 'minecraft:sand',
  'minecraft:nylium', 'forge:stone', 'forge:gravel', 'forge:sandstone', 'forge:end_stones', 'forge:ores', 'forge:netherrack',
];
const NATURAL_EXTRA = ['gravel', 'clay', 'mud', 'calcite', 'dripstone_block', 'moss_block', 'soul_sand', 'soul_soil', 'magma_block',
  // 原版泥土类这里逐个列着：知识库的 minecraft:dirt 以前被 decorative_blocks 的 "replace": "false"（字符串）误清空，
  // 2026-09-27 已在 extract_gamedata.py 修好；留着无害，知识库没生成时也兜底
  'dirt', 'end_stone', 'snow_block', 'mycelium', 'podzol', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'muddy_mangrove_roots',
  'sandstone', 'red_sandstone', 'netherrack', 'basalt', 'blackstone', 'tuff', 'deepslate', 'stone', 'granite', 'diorite', 'andesite'].map(n => `minecraft:${n}`);
// 加工过的 / 挖了有麻烦的：一律不进白名单（哪怕某个模组把它打进了 forge:stone）
// suspicious_*：考古方块，一挖里面的东西就没了；soil/farmland/compost：多半是主人的地；boundary/raw_*_block/decorative_blocks：不像天然地形（2026-09-27 看过真名单后补）
const NOT_NATURAL_RE = /polished|brick|smooth|chiseled|(^|:|_)cut_|tiles?($|_)|pillar|_slab$|_stairs$|_wall$|carved|mosaic|planks|infested|cobblestone|cobbled|glass|_block_of_|bookshelf|lamp|suspicious|farmland|compost|soil|boundary|raw_\w+_block|^decorative_blocks:|dirt_path|packed_mud|vase|_pot$|_jar$/;   // vase：etcetera 把陶罐塞进了 dirt 标签
// 标签里有、但查不到"天然生成"证据的（WorkBuddy 2026-09-27 逐个查各模组 jar 的 worldgen / 建筑模板 / Java 生成代码，
// modpack-study/instincts/dig-whitelist-review.md）：只在建筑里出现的、能合成的、没有生成证据的 —— 宁可绕路也不挖
const NOT_NATURAL_IDS = new Set([
  'biomeswevegone:black_sand',
  'biomeswevegone:black_sandstone',
  'biomeswevegone:blue_sand',
  'biomeswevegone:blue_sandstone',
  'biomeswevegone:cracked_red_sand',
  'biomeswevegone:cracked_sand',
  'biomeswevegone:lush_dirt',
  'biomeswevegone:lush_grass_block',
  'biomeswevegone:overgrown_dacite',
  'biomeswevegone:peat',
  'biomeswevegone:pink_sand',
  'biomeswevegone:pink_sandstone',
  'biomeswevegone:podzol_dacite',
  'biomeswevegone:purple_sand',
  'biomeswevegone:purple_sandstone',
  'biomeswevegone:quicksand',
  'biomeswevegone:red_quicksand',
  'biomeswevegone:sandy_dirt',
  'biomeswevegone:white_sand',
  'biomeswevegone:white_sandstone',
  'bountifulfares:grassy_dirt',
  'eeeabsmobs:blighted_stone',
  'eeeabsmobs:dark_erosion_rock',
  'eeeabsmobs:voidshard',
  'etcetera:terracotta_vase',
  'netherexp:silica_sand',
  'netherexp:silica_sandstone',
  'regions_unexplored:alpha_grass_block',
  'regions_unexplored:argillite',
  'regions_unexplored:argillite_grass_block',
  'regions_unexplored:ashen_dirt',
  'regions_unexplored:brimsprout_nylium',
  'regions_unexplored:chalk_grass_block',
  'regions_unexplored:cobalt_nylium',
  'regions_unexplored:deepslate_prismoss',
  'regions_unexplored:mycotoxic_moss',
  'regions_unexplored:overgrown_bone_block',
  'species:alphacene_grass_block',
  'species:alphacene_moss_block',
  'unusualend:prismalitic_gloopslate',
  'unusualend:shiny_gloopstone',
]);
function naturalDigNames (tagOf = () => undefined) {
  const out = new Set();
  for (const t of NATURAL_TAGS) for (const n of tagOf(t) || []) out.add(n);
  for (const n of NATURAL_EXTRA) out.add(n);
  for (const n of [...out]) if (NOT_NATURAL_RE.test(n) || NOT_NATURAL_IDS.has(n)) out.delete(n);
  return out;
}

/**
 * 装上"只挖天然地形"的挖掘闸（取代 applyPolicy 的"只拆树叶"闸；MC_ALLOW_DIG=true 时不装 —— 那是全放行）。
 *   naturalIds ：能挖的方块 id（naturalDigNames 翻成本连接的 id）
 *   forbid     ：(pos) → true = 这里不挖（家的范围）
 *   builtNear  ：(pos) → true = 紧挨着人造方块（很可能是某个建筑的墙/地基）→ 不挖
 * 树叶 / 藤蔓 / 蜘蛛网照旧能打掉（脚下的不打）。挖一格仍是 digCost（≈ 走 23 格），能绕就绕。
 */

function setDigPolicy (mv, { naturalIds = new Set(), forbid = null, builtNear = null } = {}) {
  if (ALLOW_DIG) return { mode: 'all' };
  mv.canDig = true;
  mv.exclusionAreasBreak = (mv.exclusionAreasBreak || []).filter(f => !f.__leavesOnly && !f.__digGuard);
  const guard = (block) => {
    if (!block) return 100;
    const feetY = mv.bot?.entity?.position?.y;
    const underFeet = feetY != null && block.position && block.position.y < Math.floor(feetY);
    if (/leaves|vine|cobweb/.test(block.name || '')) return underFeet ? 100 : 0;
    if (!naturalIds.has(block.type)) return 100;
    if (block.position && forbid && forbid(block.position)) return 100;
    if (block.position && builtNear && builtNear(block.position)) return 100;
    return 0;
  };
  guard.__digGuard = true;
  mv.exclusionAreasBreak.push(guard);
  return { mode: 'natural', natural: naturalIds.size };
}

/**
 * 搭路本能（主人 2026-09-27）：走到断崖 / 沟 / 要往上的地方，用**她自己带的搭脚方块**垫过去。
 *   itemIds  ：能拿来垫的物品 id（只放她随身带的那几种，hands.SCAFFOLD_IDS）；空数组 = 不搭（回到老行为）
 *   forbid   ：(pos) → true 表示这里不许放（家的范围：别在主人的基地里乱垫）
 * 放方块的代价仍是 placeCost（≈ 走 12 格），能绕就绕；allow1by1towers 跟着开（垫高往上爬）。
 */
function setScaffold (mv, { itemIds = [], forbid = null } = {}) {
  mv.scafoldingBlocks = itemIds.slice();
  mv.allow1by1towers = itemIds.length > 0;
  mv.exclusionAreasPlace = (mv.exclusionAreasPlace || []).filter(f => !f.__noPlaceGuard);
  if (forbid) {
    const guard = (block) => (block?.position && forbid(block.position) ? 100 : 0);   // ≥100 = 不许放（pathfinder 的约定）
    guard.__noPlaceGuard = true;
    mv.exclusionAreasPlace.push(guard);
  }
  return { scaffolding: mv.scafoldingBlocks.length, towers: mv.allow1by1towers, guarded: !!forbid };
}

function applyPolicy (mv, blocksByName, opts = {}) {
  if (!mv) throw new Error('applyPolicy: 需要 Movements 实例');

  const costs = { ...COSTS, ...(opts.costs || {}) };
  const { ids, matched } = buildProtectedIds(blocksByName);

  // ① 默认**不拆**（`ALLOW_DIG`，见上方常量注释）。
  //    `opts.allowDig` 是单次调用级的覆盖口子，留给将来 JEV 判定"这一趟允许挖"。
  //    放行时仍然保留"软的一层"：拆一格很贵（digCost=16 ≈ 走 23 格），绕路优先。
  const allowDig = opts.allowDig !== undefined ? !!opts.allowDig : ALLOW_DIG;
  // 不拆的时候也放行**树叶**：玩家穿树林也是随手把挡路的叶子打掉。以前一律不拆，
  // 她走进树林就被叶子困在树干之间（2026-09-27 主人："她又卡在树之中了"）。
  // 做法：canDig 打开，但用 exclusionAreasBreak 把树叶以外的方块全标成"拆不了"（≥100 = safeToBreak 为 false）
  mv.canDig = true;
  mv.exclusionAreasBreak = (mv.exclusionAreasBreak || []).filter(f => !f.__leavesOnly);
  if (!allowDig) {
    // 脚下的叶子不拆：站在树冠/悬崖边的树上，拆了脚下就掉下去（2026-09-27 主人："寻路掉悬崖了"）
    const leavesOnly = (block) => {
      if (!/leaves|vine|cobweb/.test(block.name || '')) return 100;
      const feetY = mv.bot?.entity?.position?.y;
      return feetY != null && block.position && block.position.y < Math.floor(feetY) ? 100 : 0;
    };
    leavesOnly.__leavesOnly = true;
    mv.exclusionAreasBreak.push(leavesOnly);
  }
  mv.digCost = costs.digCost;
  mv.placeCost = costs.placeCost;
  mv.liquidCost = costs.liquidCost;

  // 不垫方块往上爬：消耗玩家的材料，而且看起来像"自己在造塔"。
  mv.allow1by1towers = false;
  mv.scafoldingBlocks = [];

  // 跑酷跳关掉、一次最多往下跳 3 格（3 格以内不掉血）：2026-09-27 她回家路上在悬崖边连摔两次、血剩 6。
  // 以前 allowParkour 保持默认 true（能跨小沟跟上玩家），maxDropDown 默认 4（4 格就扣血）—— 安全优先
  mv.allowParkour = false;
  // 往下跳：3 格以内正常走；4–8 格只在没别的路时才跳（每多一格加很高的代价，有路就绕）；超过 8 格不走。
  // 主人 2026-09-27："偶尔应该允许 4-8 格掉落，但是是在没路的情况下；超过 8 格的掉落不应该寻路"
  mv.maxDropDown = MAX_DROP;
  if (!mv.__dropPenalty && typeof mv.getMoveDropDown === 'function') {
    mv.__dropPenalty = true;
    for (const fn of ['getMoveDropDown', 'getMoveDown']) {
      const orig = mv[fn].bind(mv);
      mv[fn] = (node, a, b) => {
        const out = Array.isArray(b) ? b : a;           // getMoveDropDown(node, dir, neighbors) / getMoveDown(node, neighbors)
        const n0 = out.length;
        orig(node, a, b);
        for (let i = n0; i < out.length; i++) out[i].cost += dropPenalty(node.y - out[i].y);
      };
    }
  }

  // ② 硬的一层：建筑材质永不破坏。
  // blocksCantBreak 是 pathfinder 自己的默认集合（含箱子与不可破坏方块），只增不减。
  for (const id of ids) mv.blocksCantBreak.add(id);

  return {
    canDig: mv.canDig,
    leavesOnly: !allowDig,
    // 这次调用实际用的开关值。`canDig` 是写到 Movements 上的结果，
    // 两者正常情况下相等；分开报是为了让 `GET /config` 能区分
    // "策略要求不挖" 与 "Movements 上确实没开"。
    allowDig,
    digCost: mv.digCost,
    placeCost: mv.placeCost,
    liquidCost: mv.liquidCost,
    allow1by1towers: mv.allow1by1towers,
    scaffoldingCount: mv.scafoldingBlocks.length,
    protectedCount: ids.size,
    protectedSample: matched.slice(0, 12),
  };
}

// ⚠️ 这几个**不在原 module.exports 里**（原来是模块内私有），但 `selftest.js` 用到了
//    （`dropPenalty` / `MAX_DROP` / `NATURAL_EXTRA` / `NOT_NATURAL_RE`）——
//    拆之前它们和自测在同一个作用域，拆开后只能这样递过去。
//    用 `__selftest` 这个键名，是为了**不污染对外导出**：`module.exports` 的名字和顺序
//    必须和拆前逐字一致（62 个，见 references/exports-pathing.json），
//    绝不能把这四个加进去。汇总 `index.js` 单独取它，且只递给自测。
const __selftest = { dropPenalty, MAX_DROP, NATURAL_EXTRA, NOT_NATURAL_RE, paths };

module.exports = {
  __selftest,
  naturalDigNames,
  setDigPolicy,
  setDropAllowance,
  setScaffold,
  MLG_DROP,
  bareName,
  isProtected,
  PROTECTED_PATTERNS,
  COSTS,
  ALLOW_DIG,
  buildProtectedIds,
  applyPolicy,
  faceTowardBlock,
  LIQUID_NAMES,
  MAX_VERTICAL_FLOW_LOOKAHEAD,
};
