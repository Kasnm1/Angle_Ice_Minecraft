'use strict';

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
const ALLOW_DIG = (process.env.MC_ALLOW_DIG ?? 'false') === 'true';

// ------------------------------------------------- 可攀爬方块（梯子识别）

/**
 * 模组服上梯子**认不出来** —— 这比"名字错位"更隐蔽：它不是读错，是根本没有那条路径。
 *
 * mineflayer-pathfinder 判定"能不能爬"靠的是**数字方块 ID**，不是名字：
 *
 *   movements.js:64    this.climbables.add(registry.blocksByName.ladder.id)  // 原版 = 196
 *   movements.js:232   b.climbable = this.climbables.has(b.type)
 *
 * 而这个包约 470 个模组把 state ID 空间整体挤开。实测（2026-09-23）：
 * 服务器上真实梯子发的是 stateId **5337**，它在**原版**表里落在
 * `crimson_hanging_sign`（id **215**）上。于是
 *
 *   b.type = 215 ≠ 196   →   climbable = false
 *
 * 她在寻路器眼里根本不知道那是梯子。
 *
 * 后果很精确（读了源码才敢这么说）：`climbable` **只在 `getMoveUp` 里被消费**
 * （movements.js:536）。所以：
 *   - **爬不上去** —— `if (!block1.climbable) { ... }`，而 allow1by1towers=false、
 *     scafoldingBlocks=[]，于是这里直接 return，上行邻居压根不会生成。
 *   - **掉下去不受影响** —— 下落不查 climbable。
 *
 * 为什么不能像受保护方块那样"按名字匹配"绕过去：原版梯子 ID 是库里的写死常量，
 * 没有"按名字找梯子"的代码路径。所以只能**显式告诉它**。
 *
 * 为什么按 state ID 记、而不是直接写 215：state ID 是**服务器侧的稳定身份**，
 * 215 只是"原版恰好也占了这个位置"的巧合。用 state ID 记录，语义才是对的。
 *
 * 配置：`MC_CLIMBABLE_STATE_IDS=5337,1234`，或写进 config.json 的
 * `MC_CLIMBABLE_STATE_IDS` 字段（这样重启不用重新填）。
 */
const CLIMBABLE_STATE_IDS = parseIdList(process.env.MC_CLIMBABLE_STATE_IDS);

/**
 * 首次调用 `installLadderFix` **之前**、注册表里 `blocksByName.ladder.id` 的值。
 *
 * 为什么必须单独记：`prismarine-registry` 按版本缓存**单例**，我们在同一进程里
 * 把 `ladder.id` 从 196 改成别的之后，**下一次连接读到的还是改过的值**。
 * 如果 `report.before` 直接读"此刻的值"，第二次调用就会把"改后"当成"改前"报出去
 * —— 证据被自己的副作用抹掉，正是这个文件里反复踩的那类坑（见
 * `probeClimbables` 的 `baselineLadderId` 参数，同一个理由）。
 */
let PRISTINE_LADDER_ID = null;

/**
 * `"5337, 1234"` / `[5337]` → `[5337, 1234]`。非数字一律丢掉，不炸。
 *
 * ⚠️ **必须先剔空串再转数字**：`Number('')` 和 `Number(' ')` 都等于 **0**，
 * 而 0 是**空气**的方块 id。漏了这一步的话 `"5337,,1234"` 会解析出 0，
 * 于是空气被当成可攀爬方块 —— 这种 bug 不会报错，只会在游戏里表现得莫名其妙。
 */
function parseIdList (raw) {
  const parts = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',') : []);
  return parts
    .map(s => String(s).trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0);
}

/**
 * 解析方块名列表（`MC_CLIMBABLE_BLOCK_NAME`）。与 `parseIdList` 对称。
 *
 * 只做"拆分 + 去空 + 去重"，**不校验名字合不合法** —— 合法性由
 * `resolveClimbableBlockIds` 拿服务端注册表快照来判，判不出的名字会如实报出来。
 */
function parseNameList (raw) {
  const parts = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',') : []);
  return [...new Set(parts.map(s => String(s).trim()).filter(s => s !== ''))];
}

/**
 * state ID → 方块 ID。纯函数，可离线穷举。
 *
 * 为什么需要这一步：`climbables` 装的是**方块 ID**（`b.type`），
 * 而我们手上只有服务器报的 **state ID**。原版表里 state→block 是多对一，
 * 得查一次才能拿到 `id`。
 *
 * ⚠️ 但**只做这一步是不够的**：原版表里查不到的模组方块（本包实测 522772 等），
 * 走不通"方块 ID"这条路 —— 见 `applyClimbables` 里的第②层。
 *
 * @returns {{byBlockId: Set<number>, unmapped: number[]}}
 *          byBlockId = 原版表里查得到、可以直接加进 climbables 的
 *          unmapped  = 原版表里查不到的（要靠 state ID 补丁，见下）
 */
function resolveClimbableIds (blocksByStateId, stateIds) {
  const byBlockId = new Set();
  const unmapped = [];
  if (!blocksByStateId || typeof blocksByStateId !== 'object') return { byBlockId, unmapped: [...stateIds] };
  for (const sid of stateIds) {
    const def = blocksByStateId[sid];
    if (def && typeof def.id === 'number') byBlockId.add(def.id);
    else unmapped.push(sid);
  }
  return { byBlockId, unmapped };
}

/**
 * 用**服务端自己的注册表快照**把方块名解析成方块注册表 id。
 *
 * 这是攀爬修复里唯一"证据驱动"的路线，两个输入都不是猜的：
 *
 *   * **名字**来自玩家 F3 的实测读数（准星指着梯子时调试屏直接写
 *     `minecraft:ladder[facing=…,waterlogged=…]`），或来自已导入的调色板；
 *   * **id** 来自 Forge FML 握手 `S2CRegistry` 快照里的 `minecraft:block` 表
 *     （`registry/minecraft-block.json`，20217 条，自动落盘）。
 *
 * 为什么必须留这条路 —— 另一条路（state ID → 原版表 → 方块 id）在**模组方块上
 * 是错的**：模组 state 在原版表里查不到，硬查就会拿到**恰好占着那个数字的
 * 原版方块**。这正是 2026-09-23 那次误判的机制，见 `installLadderFix` 的注释。
 * 而名字→id 不经过 state，模组方块照样精确。
 *
 * @param {object|Map} nameToId `名字 → 方块注册表 id`（对象或 Map 都收）
 * @param {string[]|string} names 方块名，如 `minecraft:ladder` / `create:ladder`
 * @returns {{byBlockId: Set<number>, unknown: string[]}}
 */
function resolveClimbableBlockIds (nameToId, names) {
  const byBlockId = new Set();
  const unknown = [];
  const list = Array.isArray(names) ? names : String(names == null ? '' : names)
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { byBlockId, unknown };
  const lookup = (n) => {
    if (!nameToId) return undefined;
    if (typeof nameToId.get === 'function') return nameToId.get(n);
    return Object.prototype.hasOwnProperty.call(nameToId, n) ? nameToId[n] : undefined;
  };
  for (const n of list) {
    const id = lookup(n);
    if (typeof id === 'number') byBlockId.add(id);
    else unknown.push(n);
  }
  return { byBlockId, unknown };
}

/**
 * 把实测到的梯子 state ID 装进寻路器。分两层，因为**一层不够**。
 *
 * ### ① 原版表里查得到的 state → 加方块 ID
 * 和库自带那套同一个机制，`movements.climbables.add(blockId)`。只增不减 ——
 * 库里原有的原版梯子 ID 必须留着（别的存档/服务器还要用）。
 *
 * ### ①' `opts.blockIds` → 直接加方块 ID（**可以多个**）
 * 给"名字路线"用：`installLadderFix` 从服务端快照解析出的 id 直接灌进来。
 * 这一层**能装多个** —— 本包有 32 种梯子（Quark 一家就 14 种木材变体），
 * 寻路器该全认。
 *
 * ⚠️ **但物理层（`prismarine-physics` 的 `isOnLadder`）只有一个槽位** ——
 *    它读的是 `blocksByName.ladder.id` 这**一个数字**。所以"能爬上去"只对
 *    `installLadderFix` 选中的那一个成立；这里的其余 id 只影响**寻路怎么规划**。
 *    要让别的梯子也能真爬，得再改 `blocksByName.ladder.id`（或在世界读取层做映射）。
 *
 * ### ② 模组方块（state 在原版表里查不到）→ 只能按 state ID 判
 * 这条路**必须包一层 `getBlock`**，原因是 prismarine-block 的一个细节：
 *
 *   static fromStateId (stateId, biomeId) {
 *     if (usesBlockStates) return new Block(undefined, biomeId, 0, stateId)  // type = undefined
 *   }
 *
 * 而构造函数里对未知 state 走的是 `else` 分支，**不覆盖 `this.type`**。
 * 于是所有模组方块的 `b.type === undefined`：
 *   - `climbables.has(b.type)` 永远为 false；
 *   - 也没法"加个数字"区分它们 —— 全都是同一个 `undefined`，
 *     加进去等于宣布**所有模组方块都可攀爬**（钝器，比 bug 更糟）。
 * 所以只能改成按 **state ID** 判：包一层 `getBlock`，命中就把 `climbable` 置 true。
 *
 * 补丁**只包一次**（`__climbablePatched`），重连时只替换集合，不重复套娃。
 */
/**
 * 开着的门当成能走的格子。
 *
 * mineflayer-pathfinder 判"能不能走进去"只看 `boundingBox === 'block'`（movements.js getBlock），
 * 门（不管开没开）都是 'block' —— 于是在它眼里**开着的门也是一堵墙**，
 * 门里面就成了死路：`POST /move` 到门外 → `No path found`（2026-09-26 实测：
 * 厨房出口那扇被踏板顶开的 dark_oak_door，open=true，她在门里出不来）。
 * 真实碰撞：开着的门只剩贴在门框一侧的一块薄板，顺着门洞方向走过去不受影响。
 *
 * 只放行**开着的**门（名字以 _door / door 结尾，不含活板门 trapdoor）；关着的门仍是墙，
 * 由 hands.js go() 的"开挡路的门"那一步去开（真人也是先开门再走）。
 *
 * ## ⚠️ 整格放行会**沿着门板方向**误放行 —— 这里按门板法线轴收窄
 *
 * 寻路器是**按格**判断的（`getBlock` 只有位置、没有方向），说不出"这一格只许从某个方向进"。
 * 而开着的门板是**一块薄板**：它只挡**门板法线那根轴**（= 与 `facing` 垂直的轴），
 * 顺着门洞方向走过去不挡。于是"整格放行"等于把门板也一起放行了：
 *
 *   · 门**嵌在墙里**（常态）——法线轴两侧是墙，本来就不可能横穿，放行无害 ✓
 *   · 门**独立站着 / 双开门外侧没墙**——寻路器会规划出"从一侧进来、穿过门板、从另一侧出去"
 *     的路径，服务端有真实碰撞把她推回来 → 橡皮筋。
 *
 * 所以加一道**可证伪的闸**：读出门板法线轴，只有该轴**两侧都走得进去**时才不放行
 * （那时当墙 —— 绕过去就行，两侧都是通路所以一定绕得开），其余一律放行。
 * 判据是"从世界读出来的邻格"，不是猜。
 *
 * 读不到 `facing` 时（模组门可能用别的属性名）**保持放行**：这是这一版修好的那个 bug，
 * 不能因为拿不到属性就退回"门里出不去"；但记一笔（`stats.noFacing`），
 * `GET /debug/mvblock` 里看得见 —— "读不到"要报出来，别混进"没有"。
 */
const DOOR_NAME_RE = /(^|_)door$/;

/** 方块的属性表。`getProperties()` 优先，退回 `_properties`。读不到返回 null。 */
function blockProps (b) {
  try {
    const p = typeof b.getProperties === 'function' ? b.getProperties() : (b._properties || b.properties);
    return p || null;
  } catch (_) { return null; }
}

/** 方块的 open 属性（服务器发来的值是字符串，有时大写 —— 一律按字符串比） */
function isOpenBlock (b) {
  const props = blockProps(b);
  const v = props && Object.entries(props).find(([k]) => k.toLowerCase() === 'open')?.[1];
  return String(v).toLowerCase() === 'true';
}

/**
 * 开着的门板在**哪根轴**上挡人。
 *
 * 门板法线 = 与 `facing` 垂直的那根轴：`facing=north/south` → 门板法线是 X（挡东西向），
 * `facing=east/west` → 是 Z（挡南北向）。这是 MC 的 `DoorBlock.getShape` 的分支表：
 * 关着时门板垂直于 facing（挡门洞方向），开着时转过 90° → 垂直于 facing 的那根轴。
 *
 * 读不到 facing 返回 **null**（"不知道"，不是"没有"）—— 调用方据此保持放行并计数。
 */
function doorPlateAxis (b) {
  const props = blockProps(b);
  const f = props && Object.entries(props).find(([k]) => k.toLowerCase() === 'facing')?.[1];
  const v = String(f || '').toLowerCase();
  if (v === 'north' || v === 'south') return 'x';
  if (v === 'east' || v === 'west') return 'z';
  return null;
}

/**
 * 这一格她走不走得进去。判据与 `movements.getBlock` 的 `safe` **同源**（没有碰撞即可走），
 * 但**故意不看**门那条豁免 —— 否则"双开门"里两个门格会互相证明对方可走，
 * 闸门就形同虚设。取的是保守那一侧。
 */
function isWalkableCell (b) {
  return !!b && (b.boundingBox === 'empty' || b.climbable === true);
}

function applyOpenDoors (mv) {
  if (!mv || typeof mv.getBlock !== 'function') throw new Error('applyOpenDoors: 需要 Movements 实例');
  if (mv.__openDoorsPatched) return { installed: true, already: true, stats: mv.__openDoorsStats };
  const orig = mv.getBlock.bind(mv);
  // `stats` 是**活对象**：调用方拿到的引用会一直更新（和 applyUnknownBlockPolicy 的 stats 同理）。
  const stats = { passed: 0, refused: 0, noFacing: 0, refusedAt: [] };
  mv.getBlock = function (pos, dx, dy, dz) {
    const b = orig(pos, dx, dy, dz);
    if (!b || !b.name || !DOOR_NAME_RE.test(bareName(b.name)) || !isOpenBlock(b)) return b;
    const axis = doorPlateAxis(b);
    if (!axis) {
      stats.noFacing++;
    } else if (pos) {
      const nx = axis === 'x' ? 1 : 0;
      const nz = axis === 'z' ? 1 : 0;
      const a = orig(pos, dx - nx, dy, dz - nz);
      const c = orig(pos, dx + nx, dy, dz + nz);
      if (isWalkableCell(a) && isWalkableCell(c)) {
        stats.refused++;
        if (stats.refusedAt.length < 8) {
          stats.refusedAt.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz, name: b.name, axis });
        }
        return b;   // 门板两侧都是通路 → 保守当墙（绕得开），不猜
      }
    }
    // 放行：`height` 取本格地板高度（= "没有碰撞"时 movements.getBlock 自己会算出的值）
    b.safe = true;
    b.physical = false;
    b.height = pos.y + dy;
    stats.passed++;
    return b;
  };
  mv.__openDoorsPatched = true;
  mv.__openDoorsStats = stats;
  return { installed: true, stats };
}

function applyClimbables (mv, registry, stateIds = CLIMBABLE_STATE_IDS, opts = {}) {
  if (!mv || typeof mv.getBlock !== 'function' || !mv.climbables) {
    throw new Error('applyClimbables: 需要 Movements 实例');
  }
  const list = Array.isArray(stateIds) ? stateIds : parseIdList(stateIds);
  const byStateId = new Set(list);
  const { byBlockId, unmapped } = resolveClimbableIds(registry && registry.blocksByStateId, list);
  // 名字路线给的方块 id：**能装多个**（见上面 ①'）
  const extra = Array.isArray(opts.blockIds)
    ? opts.blockIds.filter(n => Number.isInteger(n) && n > 0)
    : [];

  // ① 查得到的：走库自己的机制
  for (const id of byBlockId) mv.climbables.add(id);
  for (const id of extra) mv.climbables.add(id);

  // ② 查不到的：走 getBlock 补丁（集合挂在实例上，便于重连时替换）
  mv.__climbableStateIds = byStateId;
  if (!mv.__climbablePatched) {
    const orig = mv.getBlock.bind(mv);
    mv.getBlock = function (pos, dx, dy, dz) {
      const b = orig(pos, dx, dy, dz);
      // `b.type` 对模组方块恒为 undefined，只有 stateId 是可信的
      if (b && typeof b.stateId === 'number' && mv.__climbableStateIds.has(b.stateId)) {
        b.climbable = true;
      }
      return b;
    };
    mv.__climbablePatched = true;
  }

  return {
    configuredStateIds: list,
    addedBlockIds: [...byBlockId],   // 走①的
    addedExtraBlockIds: extra,       // 走①'的（名字路线，可多个）
    unmappedStateIds: unmapped,      // 走②的（原版表里没有，只能按 state ID 认）
    stateIdPatchInstalled: !!mv.__climbablePatched,
    size: mv.climbables.size,
  };
}

/**
 * 把"库里自带那套到底认不认得出这包里的梯子"变成**可观测事实**。
 *
 * `vanillaPathWouldWork === false` 就是这次的实测现象：梯子存在、名字不对、
 * 原版 ID 也对不上，所以 `climbable` 恒为 false。不报出来的话，
 * "她不会爬梯子"只能靠玩家在游戏里发现。
 *
 * ⚠️ 本函数报的是**注册表此刻的状态**。`installLadderFix()` 改过注册表之后，
 * `blocksByName.ladder.id` 已经不等于原版 196 了 —— 如果还按"当前值"当基准，
 * `vanillaPathWouldWork` 会翻成 true，把"修之前是坏的"这个事实抹掉。
 * 所以基准 id 单独用一个参数传入（`opts.baselineLadderId`，默认取当前值以保持
 * 纯函数语义），并额外给出 `libraryPathWouldWork` 表示"**现在**这套认不认得出"。
 */
function probeClimbables (registry, observedStateIds = CLIMBABLE_STATE_IDS, opts = {}) {
  if (!registry || !registry.blocksByName || !registry.blocksByStateId) {
    return { vanillaLadderId: null, libraryLadderId: null, observed: [], vanillaPathWouldWork: null, libraryPathWouldWork: null };
  }
  const libraryLadderId = registry.blocksByName.ladder ? registry.blocksByName.ladder.id : null;
  // 基准 = "库原本写死的那个原版 id"。修过注册表时要显式传进来。
  const vanilla = opts.baselineLadderId !== undefined ? opts.baselineLadderId : libraryLadderId;
  const observed = observedStateIds.map(sid => {
    const def = registry.blocksByStateId[sid];
    const mapped = !!def && typeof def.id === 'number';
    return {
      stateId: sid,
      mappedInVanilla: mapped,       // false → 只能靠 state ID 补丁
      resolvedId: mapped ? def.id : null,
      resolvedName: mapped && def.name ? def.name : null,
      isVanillaLadder: mapped && def.id === vanilla,
      isLibraryLadder: mapped && def.id === libraryLadderId,
    };
  });
  return {
    vanillaLadderId: vanilla,          // 库原本写死的原版 id（196）
    libraryLadderId,                   // 库此刻实际在用的 id（修过就是 215）
    observed,
    // 只要有一条实测梯子解析出的 id ≠ 原版梯子 id，库自带那套（未修正时）就认不出来。
    vanillaPathWouldWork: observed.length ? observed.every(o => o.isVanillaLadder) : null,
    // 修正之后，库自带那套认不认得出？这才是"修好了没有"的判据。
    libraryPathWouldWork: observed.length ? observed.every(o => o.isLibraryLadder) : null,
  };
}

// -------------------------------------------------- 修掉写死的原版梯子 ID

/**
 * 把共享注册表里的 `blocksByName.ladder.id` 改成**服务器实际用的那个 ID**。
 *
 * ### 这函数为什么存在（两层各自写死了同一个数字）
 *
 *   1. `prismarine-physics/index.js:35` 在**构造 Physics 实例时**把
 *      `blocksByName.ladder.id` 读进闭包，`:442` 的 `isOnLadder()` 只认这个数字
 *      （`block.type === ladderId || block.type === vineId`）；
 *   2. `mineflayer-pathfinder/lib/movements.js:64` 在 `new Movements()` 时
 *      把同一个数字塞进 `climbables`，`:232` 用 `climbables.has(b.type)` 判定。
 *
 * 两个库互不依赖，却各自写死了同一个原版 ID（196）。**两层判的都是 `block.type`
 * （方块注册表 id），不是 `stateId`。** 所以只要服务器上的梯子确实是原版
 * `minecraft:ladder`（id 196），**零配置就能爬** —— 本函数不该被调用。
 *
 * ### ⚠️ 2026-09-23 的撤回：这个"修复"曾经是自我实现的
 *
 * 上一轮曾断言「本包真实梯子 `stateId 5337`，在原版表里落到 `crimson_hanging_sign`
 * （id 215）」，于是把 `blocksByName.ladder.id` 改成 215，她"会爬了"。
 * **那个结论是错的，而且"会爬"是自我实现的**：我们把 215 号方块**告诉**物理层
 * 是梯子，物理层就照做了。
 *
 * 实测反证（同一天）：
 *
 *   * 服务端 1003 个原版方块的注册表 id 与原版**逐个一致（1003/1003，零差异）**，
 *     原版 state 区间 `0..24134` 没被模组挤开 —— 所以 `stateId 5337` 只可能是
 *     **原版**方块，就是 `crimson_hanging_sign`，不可能是梯子；
 *   * `minecraft-data('1.20.1')` 里 `ladder.id === 196`、state 范围 `4654..4661`。
 *
 * 也就是说：**5337 是玩家 F3 读错的一格**，不是梯子；而"改 ID"这剂药治的是
 * 一个不存在的病，副作用是把**本来正确的原版 196 改坏了**。
 *
 * ### 现在正确的用法（二选一，优先第一条）
 *
 *   1. **名字路线（证据驱动，推荐）**：`opts.blockNames` + `opts.nameToId`。
 *      名字来自玩家 F3 实测（准星指着梯子时调试屏直接写 `minecraft:ladder[…]`），
 *      id 来自 Forge FML 握手快照里的 `minecraft:block` 表。**模组梯子也精确**，
 *      因为它不经过 state。
 *   2. **state 路线（只在原版方块上可信）**：`stateIds`。模组 state 在原版表里
 *      查不到，硬查会拿到**恰好占着那个数字的原版方块** —— 这正是上面那次误判的机制。
 *
 * 两条路都没给 → **一个字都不改**（那道闸）。这是**默认且正确**的状态。
 *
 * ⚠️ **必须在 `createBot` 之前调用**。`Physics()` 在构造时求值，
 * 晚一步改就只影响"下一次连接"。
 *
 * ⚠️ 改的是**跨库共享的同一个对象**（实测 `minecraft-data('1.20.1').blocksByName
 * === prismarine-registry('1.20.1').blocksByName` 为 true），
 * 所以不需要分别去 patch 两个库。**但这也意味着改动是全局且粘滞的** ——
 * `prismarine-registry` 按版本缓存单例，同进程内改一次，之后所有连接都受影响。
 * 所以 `report.baseline` 记的是**首次调用前**的那个值，不是"这一次调用前"的值。
 *
 * @param {object} registry 注册表（`prismarine-registry` 或 `bot.registry`）
 * @param {number[]|string} stateIds 服务器实际报的梯子 state ID（模组方块上不可信）
 * @param {{blockNames?: string[]|string, nameToId?: object|Map,
 *          baselineLadderId?: number}} [opts]
 */
function installLadderFix (registry, stateIds = CLIMBABLE_STATE_IDS, opts = {}) {
  const list = Array.isArray(stateIds) ? stateIds : parseIdList(stateIds);
  const names = parseNameList(opts.blockNames);
  const report = {
    configuredStateIds: list,
    configuredBlockNames: names,
    before: null,        // 本次调用**开始时**注册表里的值（可能已被之前调用改过）
    baseline: null,      // **首次调用前**的值 —— 判"我们改过没有"只能看它
    after: null,
    applied: false,
    resolvedFromNames: [],
    resolvedFromStates: [],
    ignoredExtraBlockIds: [],
    unmappedStateIds: [],
    unknownBlockNames: [],
    reason: null,
  };

  // 闸门：两条路都没给就一个字都不改。
  // ⚠️ 这是**默认且正确**的状态，不是"没配置所以凑合" —— 原版 id 零位移，
  //    梯子本来就该是 196，动它才是 bug。
  if (!list.length && !names.length) {
    report.reason = '既没配 MC_CLIMBABLE_STATE_IDS 也没配 MC_CLIMBABLE_BLOCK_NAME —— 不动注册表';
    return report;
  }
  if (!registry || !registry.blocksByName || !registry.blocksByName.ladder) {
    report.reason = '注册表里没有 blocksByName.ladder，无法修正';
    return report;
  }

  const before = registry.blocksByName.ladder.id;
  if (PRISTINE_LADDER_ID === null) PRISTINE_LADDER_ID = before;
  report.before = before;
  report.baseline = opts.baselineLadderId !== undefined ? opts.baselineLadderId : PRISTINE_LADDER_ID;
  report.after = before;

  // ① 名字路线优先 —— 不经过 state，模组方块也精确
  const fromNames = resolveClimbableBlockIds(opts.nameToId, names);
  report.resolvedFromNames = [...fromNames.byBlockId];
  report.unknownBlockNames = fromNames.unknown;

  // ② state 路线（只在原版方块上可信；模组 state 会撞到"恰好占着那个数字的原版方块"）
  const fromStates = resolveClimbableIds(registry.blocksByStateId, list);
  report.resolvedFromStates = [...fromStates.byBlockId];
  report.unmappedStateIds = fromStates.unmapped;

  const ids = [...new Set([...fromNames.byBlockId, ...fromStates.byBlockId])];

  if (!ids.length) {
    report.reason = names.length && fromNames.unknown.length === names.length
      ? `配置的方块名在服务端注册表快照里都查不到（${fromNames.unknown.join(', ')}）`
        + '—— 快照要连过一次服务端才有；先连一次，或改用 MC_CLIMBABLE_STATE_IDS'
      : `配置的 stateId 在原版表里都查不到（${fromStates.unmapped.join(', ')}），`
        + '只能靠 applyClimbables 的 stateId 补丁那一层';
    return report;
  }

  // `blocksByName.ladder.id` 只能装一个数字，多余的如实报出来，不悄悄丢掉
  const target = ids[0];
  report.ignoredExtraBlockIds = ids.slice(1);

  if (target === before) {
    report.reason = `解析出的 id ${target} 与注册表当前值一致，无需改动`;
    return report;
  }

  registry.blocksByName.ladder.id = target;
  report.after = target;
  report.applied = true;
  report.reason = `梯子 id ${before} → ${target}`;
  return report;
}

// ------------------------------------------- 未映射方块：一律按实心处理

/**
 * 是否把"未映射的 block state"当成实心方块。默认**开**。
 *
 * 为什么默认开：这是本包上最容易骗过我们的一类错误认知 ——
 *
 *   `prismarine-block/index.js` 对查不到的 state 走 `else` 分支：
 *       this.name = ''
 *       this.shapes = []            // ← 物理层拿不到碰撞箱 ⇒ 直接穿过去
 *       this.boundingBox = 'empty'  // ← 寻路层判成"可通行"
 *   …而**服务端知道那是什么方块**，它的碰撞照常生效。
 *
 *   于是出现：客户端以为能走 → 走进去 → 服务端把人推回来 → 原地抖动，
 *   位移≈0、连 jump 都不动。实测过一次：玩家 F3 显示她面前是
 *   `cluttered:ancient_codex`（一个模组装饰方块，stateId 506813），
 *   而我们这边读出来是 `solid:false`、名字空 —— 卡了十几分钟。
 *
 * 为什么"当实心"是**安全的那一侧**：服务端有自己的碰撞，客户端说了不算。
 * 猜错成实心，最坏是多绕一步路；猜错成空气，就是无限橡皮筋。
 *
 * 代价（诚实说）：**名字看不出是薄方块**的可穿过模组方块仍会被当成墙
 * （典型是模组的台阶 / 楼梯 —— 半高，服务端靠 step-up 处理，客户端当可穿过会橡皮筋）。
 * 两条补救：
 *   · 名字像薄方块的（踏板 / 地毯 / 按钮 / 花 / 铁轨 / 告示牌…）由 `isThinBlockName`
 *     自动豁免，不用手工列（见下面「薄方块」一节）；
 *   · 剩下的按 stateId 用 `MC_PASSABLE_STATE_IDS` 列进白名单。
 *     ⚠️ 这条路现在是**坏的**：`bridge-server.js` 调 `applyUnknownBlockPolicy` 时
 *        没传 `passableStateIds`，而 config.json 的 `loadFileConfig()` 又**从不写
 *        `process.env`** —— 写在 config.json 里的 `MC_PASSABLE_STATE_IDS` 会被静默忽略，
 *        只有**真正的环境变量**才生效。（与 `MC_ALLOW_DIG` 是同一个坑。）
 */
const UNKNOWN_BLOCK_SOLID = (process.env.MC_UNKNOWN_BLOCK_SOLID ?? 'true') !== 'false';
const PASSABLE_STATE_IDS = parseIdList(process.env.MC_PASSABLE_STATE_IDS);

/** 完整立方体的碰撞箱。`[minX, minY, minZ, maxX, maxY, maxZ]`，单位是格。 */
const FULL_CUBE = [[0, 0, 0, 1, 1, 1]];

/** "没有碰撞箱"。薄方块豁免时用它 —— 等价于 `prismarine-block` else 分支给的 `shapes = []`。 */
const EMPTY_SHAPES = [];

// ------------------------------------------- 薄方块：名字上就不是整块立方体

/**
 * 要不要按**名字**把"薄方块"从实心策略里豁免掉。默认**开**。
 *
 * 为什么需要这一条（2026-09-25 实测，本包）：
 *   上面那套"未映射一律实心"分不清两种东西 ——
 *     · 不透明的墙（`cluttered:ancient_codex`）：补成立方体是对的；
 *     · 薄方块（踏板 / 地毯 / 按钮 / 花）：补成立方体是**错的**，真人抬脚就过去了。
 *   而这两种方块在数据上长得一模一样：调色板只给**名字和属性**、**不给碰撞形状**
 *   （`registry/angel_block_palette.txt` 的格式是 `localId|blockId|stateCount|name|props`，
 *   没有任何形状列）。所以"我们不知道它的形状"这句话，对墙和对花是同一句。
 *
 *   踩到的现场：玩家厨房唯一的出口是一扇 `dark_oak_door`，门前一格铺着
 *   `autumnity:maple_pressure_plate`。踏板被补成立方体之后：
 *     · `POST /move` 到踏板格 → `No path found`（寻路层当它是墙）
 *     · `POST /control {forward}` 纯走 2000ms → 只前进 **0.2 格**，停在 `x=39.7`
 *       （= 40.0 − 0.3，正好是她的包围盒半边宽）—— 撞在整块立方体上停住。
 *   真实踏板的碰撞只有 1/16 高，本该抬脚就过去。玩家当场指出：
 *   **「踏板为什么要跳，直接走」**。
 *
 * 判据为什么用**名字后缀**：调色板对**身份**是权威的（名字准），对形状不是。
 * 于是把能靠名字判的那部分（"它是不是薄方块"）用名字判；判不了的（墙 vs 花）
 * 继续保守当实心。这是把"猜"的范围从"所有模组方块"缩小到"名字像薄方块的模组方块"。
 *
 * ⚠️ 反面：名字像薄方块、其实是整块立方体的，列进 `THIN_BLOCK_DENY`。
 *    今天原版方块**根本走不到这条路径**（它们的 `boundingBox` 由 minecraft-data 提供，
 *    `needsShapeFallback` 不命中），所以那份黑名单是**保险** —— 哪天原版形状也丢了，
 *    它还能挡住那两个。
 *
 * ⚠️ `ladder` / `trapdoor` / `slab` / `stairs` **故意不在名单里**：
 *    · 梯子：寻路器必须把它当墙才会去爬（放行了它就绕过去，永远不爬）；
 *    · 活板门：关着的时候是实体，正确做法是 `POST /activate` 打开、实测通过后再进
 *      运行时白名单；
 *    · 台阶 / 楼梯：半高，服务端靠 step-up 处理，客户端当可穿过会橡皮筋。
 *    这三类的正确解法都是"先开 → 再实测 → 再放行"，不是按名字豁免。
 *
 * 关掉它：`MC_THIN_BLOCK_PASSABLE=false`（退回"所有模组方块一律实心"的老行为）。
 */
const THIN_BLOCK_PASSABLE = (process.env.MC_THIN_BLOCK_PASSABLE ?? 'true') !== 'false';

/**
 * 薄方块名后缀。匹配的是**去掉命名空间之后**的末段，且要求前面是 `_` 或行首。
 *   `autumnity:maple_pressure_plate` → `maple_pressure_plate` → 命中 `_pressure_plate` ✓
 *   `minecraft:torch`                → `torch`                → 命中行首 `torch`     ✓
 *   `minecraft:torchflower`          → 不命中（不是 `torch` 结尾）                  ✓
 *   `minecraft:sea_lantern`          → 不命中（`lantern` 根本不在名单里）           ✓
 *   `minecraft:chorus_flower`        → 命中 `_flower`，但被 `THIN_BLOCK_DENY` 拦下 ✓
 */
const THIN_BLOCK_SUFFIXES = [
  // 真正"踩得过去"的一类
  'pressure_plate', 'button', 'carpet', 'rug', 'candle', 'chain', 'lever',
  'torch', 'rail', 'tripwire', 'tripwire_hook', 'lily_pad', 'cobweb',
  'sign', 'hanging_sign', 'banner',
  // 植物 / 装饰：服务端那边本来就没有碰撞
  'sapling', 'flower', 'fern', 'grass', 'roots', 'root', 'sprout', 'sprouts',
  'petal', 'petals', 'mushroom', 'fungus', 'lichen', 'coral', 'coral_fan',
  'bud', 'crop', 'bush', 'cane', 'vine', 'vines',
];

/**
 * 矮方块：有碰撞但不到一格高。模组的床（handcrafted、touhou_little_maid…）和原版一样是 9/16 高。
 * 返回高度（0–1），不是矮方块返回 0。
 *
 * ⚠️ 2026-09-26 之后这条**只是兜底**，不再是主力：调色板导出逐 state 碰撞箱之后，
 *    床的真实高度（9/16）直接来自注册表，`needsShapeFallback` 不命中、这里根本走不到。
 *    它现在只为两种方块服务：**旧 dump**（没有形状列）和**没进调色板的方块**。
 *    保留它的理由也正是这两种：形状数据缺席时，按名字猜 9/16 比猜"整块实心"好得多
 *    （后者会把她"埋"进方块里，往哪都动不了）。
 */
const LOW_BLOCKS = [[/(^|_)bed$/, 0.5625]];
function lowBlockHeight (name) {
  if (typeof name !== 'string' || !name) return 0;
  const short = name.includes(':') ? name.split(':').pop() : name;
  for (const [re, h] of LOW_BLOCKS) if (re.test(short)) return h;
  return 0;
}

/** 名字像薄方块、其实是整块立方体的反例。 */
const THIN_BLOCK_DENY = new Set([
  'chorus_flower',    // 命中 `_flower`，实心
  'mangrove_roots',   // 命中 `_roots`，实心
  'sea_lantern',      // 保险：万一 `lantern` 以后进名单
  'powder_snow',      // 保险：碰撞是整块（人会陷进去，但客户端不该当空气）
]);

const THIN_BLOCK_NAME_RE = new RegExp('(?:^|_)(?:' + THIN_BLOCK_SUFFIXES.join('|') + ')$');

/**
 * 判"这个名字是不是薄方块"。
 *
 * 空名字 / 非字符串 → **false**：名字都不知道就别豁免，继续当实心（保守那侧）。
 * 带命名空间（`autumnity:maple_pressure_plate`）时只看末段。
 */
function isThinBlockName (name) {
  if (typeof name !== 'string' || !name) return false;
  const short = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  if (THIN_BLOCK_DENY.has(short)) return false;
  return THIN_BLOCK_NAME_RE.test(short);
}

/**
 * 判"这个 state 在注册表里查不到"。
 *
 * 判据用 `type === undefined`，**不是** `name === ''`：
 * `prismarine-block` 的 else 分支不覆盖 `this.type`，而 1.13+ 的 `fromStateId`
 * 传进来的就是 `undefined`，所以"未映射"精确对应 `type === undefined`。
 * 顺带一提，空气的 `type` 是数字 0 —— 这一条同时把空气排除在外了。
 *
 * ⚠️ 为什么**不能**再带上 `name === ''`：下面那个补丁会在拿到真实方块名之后
 *    把 `b.name` 填上，而 `world.getBlock` 返回的是**缓存里的同一个对象** ——
 *    一旦填了名字，`name === ''` 就不成立，"未映射方块按实心处理"这条会**静默失效**，
 *    于是她又开始穿墙。这个坑很小但后果很严重，所以判据只留 `type === undefined`。
 */
function isUnknownBlock (b) {
  return !!b && b.type === undefined;
}

/**
 * 判"这个方块还需要实心策略兜底形状"。
 *
 * 比 `isUnknownBlock` 宽一条：**调色板注入过、但没拿到形状的方块也算**。
 *
 * 为什么必须宽这一条：`palette-registry.js` 把调色板写回注册表之后，模组方块的
 * `b.type` / `b.name` 都有值了，`isUnknownBlock` 就不再命中 —— 可是这个补丁还兼着
 * **可穿过白名单**（她自己打开的那扇门/活板门要在 `runtimePassable` 里放行）。
 * 如果补丁不跑了，白名单跟着一起失效，她会撞上自己刚打开的门。
 *
 * 判据为什么用 `boundingBox === undefined`：这就是"**我们不知道它的碰撞箱**"的
 * 精确表示。实测原版 `blocksByStateId` 里 24135 个 state **无一缺 boundingBox**
 * （0 个缺失）。所以：
 *   · 原版方块 → 有 boundingBox → 不动它；
 *   · 无调色板时的模组方块 → `type === undefined`，同时 boundingBox 也没有；
 *   · 注入过、但 dump **没导形状列**（旧 dump）的模组方块 → `type` 有值、
 *     boundingBox 没有 → 走兜底；
 *   · 注入过、**dump 导了形状列**的模组方块 → 有 boundingBox → 不走兜底，
 *     真实碰撞箱直接生效（这是 2026-09-26 之后的**新**契约）。
 *
 * ⚠️ **契约已经反转过一次，别再按老说法读代码。**
 *    老契约（`palette-registry.js` 早期版本）："注入的记录**故意不填** boundingBox，
 *    谁填了模组方块就全变成'已知形状'、白名单静默失效"。
 *    新契约："**有形状就填、没形状才不填**"。判据本身没变（还是这一行），
 *    变的只是"什么时候会出现 undefined"。
 *    `palette-registry.js` 的自测里两条都钉住了：
 *      · 没导形状列 → `mod.boundingBox === undefined`；
 *      · 导了形状列 → `mod.boundingBox === 'block'` 且 `stateShapes` 逐 state 生效。
 *
 * ⚠️ 白名单**不再依赖这个判据**：`applyUnknownBlockPolicy` 现在先算白名单，
 *    再分"要不要兜底"两条路走 —— 形状已知的方块若在白名单里，照样放行。
 *    所以"填了 boundingBox 白名单就失效"这件事**已经不会发生**了。
 *
 * ⚠️ 判据仍然**不能**带上 `name === ''` —— 见上面 `isUnknownBlock` 的说明：
 *    名字会被补丁自己填上，而 `world.getBlock` 返回的是缓存里的同一个对象。
 */
function needsShapeFallback (b) {
  return !!b && (b.type === undefined || b.boundingBox === undefined);
}

/**
 * 把 `world.getBlock` 包一层：未映射的 state 一律返回"实心立方体"。
 *
 * 为什么只patch一个点就够（这是本包最重要的一条结构事实）：
 *   · 物理层 `prismarine-physics` 用 `world.getBlock(cursor).shapes` 算碰撞；
 *   · 寻路层 `Movements.getBlock` 用 `bot.blockAt(...)`，而 `bot.blockAt`
 *     就是 `world.getBlock` 的薄封装（`mineflayer/lib/plugins/blocks.js:215`）；
 *   · `GET /block` 也走 `bot.blockAt`。
 *   → 一处补丁，三层同时纠正。**而且测的就是跑的**：`bridge-server.js` 直接
 *     require 本模块，没有平行实现。
 *
 * ⚠️ 这个补丁会**改变 `/block` 的读数**：未映射方块从此报 `solid:true`。
 *    这不是"副作用"，这是修好了 —— 之前那个 `solid:false` 才是错的。
 *
 * @param {object} world `bot.world`
 * @param {{enabled?: boolean, passableStateIds?: number[]|string,
 *          runtimePassable?: Set<number>,
 *          thinPassable?: boolean,
 *          nameOf?: (stateId:number) => (string|null)}} [opts]
 *   `thinPassable` 覆盖模块级的 `THIN_BLOCK_PASSABLE`（默认取环境变量 `MC_THIN_BLOCK_PASSABLE`）。
 *   名字像薄方块的（踏板 / 地毯 / 按钮 / 花…）不再被补成立方体，见「薄方块」一节。
 *   `runtimePassable` 是一个**会被后续写入的活 Set**（不是快照）。用来放"运行时
 *   实测确认能穿过去"的 state —— 例如她刚自己打开的那扇活板门。
 *   必须在补丁里**按引用读取**，不能在安装时拷一份，否则后来加进去的没用。
 *   ⚠️ 白名单**同时**管两种方块：形状未知的（兜底那条路）和形状已知的
 *     （调色板导出了真实碰撞箱那条路）。后者以前放不了行 —— 形状一已知，
 *     白名单就整条失效。现在两条路都先算白名单，见 `needsShapeFallback` 的说明。
 *
 *   `nameOf` 是可选的**真实方块名解析器**（来自 `block-palette.js` 的调色板索引）。
 *   给了它，未映射方块会被填上真名（`upgrade_aquatic:glass_trapdoor` 而不是空串）。
 *   ⚠️ 只在 `b.name` 为空时才用它 —— 调色板**注入注册表**之后 `b.name` 已经是
 *     注册表给的权威名字，别用次一级来源覆盖。
 *   ⚠️ 填名字**不会**让实心策略失效 —— 判据是 `needsShapeFallback`，
 *     它只认 `type === undefined` **或** `boundingBox === undefined`，跟名字无关。
 *     （`angelInjected` 只是 `palette-registry.js` 留下的痕迹，判据里**没有**它 ——
 *      以前这段注释这么写，是注释错了，不是代码错了。）
 *   ⚠️ 唯一的例外是**薄方块**：`THIN_BLOCK_PASSABLE` 打开时，名字像薄方块的会被
 *     豁免成可穿过（见「薄方块」一节）。那是**故意**的，不是"填名字导致策略失效"。
 *   ⚠️ 填了名字会**连带改善寻路**：`movements.js` 里 `openable` 是按名字
 *     `includes('gate')` 判的，模组栅栏门从此能被认出来（以前认不出，卡死）。
 */
function applyUnknownBlockPolicy (world, opts = {}) {
  const enabled = opts.enabled !== undefined ? !!opts.enabled : UNKNOWN_BLOCK_SOLID;
  const passable = new Set(
    opts.passableStateIds !== undefined ? parseIdList(opts.passableStateIds) : PASSABLE_STATE_IDS
  );
  const runtimePassable = opts.runtimePassable || null;
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : null;
  // 薄方块豁免：显式传优先，其次环境变量。允许显式传是为了自测能把"开/关"两条分支都钉住。
  const thinPassable = opts.thinPassable !== undefined ? !!opts.thinPassable : THIN_BLOCK_PASSABLE;
  // `stats` 是**活对象**：补丁每被调用一次就累加一次，调用方拿到的引用会一直更新。
  // 这是"薄方块豁免到底有没有生效"的正面证据 —— 只看 `patched: true` 说明不了什么。
  const stats = { thinExempt: 0, thinNames: [], whitelisted: 0 };
  const report = {
    enabled,
    passableStateIds: [...passable],
    nameResolver: !!nameOf,
    thinPassable,
    stats,
    patched: false,
    skipped: null,
    alreadyPatched: false,
  };

  if (!enabled) {
    report.skipped = 'MC_UNKNOWN_BLOCK_SOLID=false';
    return report;
  }
  if (!world || typeof world.getBlock !== 'function') {
    report.skipped = 'world.getBlock 不可用';
    return report;
  }
  if (world.__unknownBlockPatched) {
    // 重连会再装一次，不能套娃包多层。
    // ⚠️ 这里直接返回，但**已经装上的那层闭包仍然持有同一个 runtimePassable 引用**，
    //    所以运行时新增的白名单依旧生效 —— 不会因为"重连"而失效。
    report.alreadyPatched = true;
    report.patched = true;
    return report;
  }

  const orig = world.getBlock.bind(world);
  world.getBlock = function (pos) {
    const b = orig(pos);
    if (!b) return b;
    // ⚠️ 白名单必须在"要不要兜底"**之前**算。理由：调色板导出真实碰撞箱之后，
    //    模组方块有了 boundingBox、`needsShapeFallback` 不再命中 —— 可白名单里那些
    //    是**实测确认能穿过去**的人工结论（她自己打开的那扇门/活板门），
    //    必须能盖过"形状看起来是墙"这一层。以前白名单嵌在兜底分支里，
    //    形状一已知它就整条失效。
    const whitelisted = passable.has(b.stateId) ||
      !!(runtimePassable && runtimePassable.has(b.stateId));
    if (needsShapeFallback(b)) {
      // ⚠️ 名字必须在**判形状之前**解析好 —— 薄方块那条豁免用的就是名字。
      //    这段以前排在形状判定**之后**，于是"按名字豁免"永远看不到名字。
      // ⚠️ 只在**还没有名字**时才解析：调色板注入之后 `b.name` 已经来自注册表
      //    （比旁路查表更权威），别用次一级的来源覆盖它。
      if (nameOf && !b.name) {
        try {
          const n = nameOf(b.stateId);
          if (n) {
            b.name = n;
            b.resolvedName = n; // 留个痕迹，方便和"注册表本来就有名字"区分
          }
        } catch (_) {}
      }
      if (whitelisted) {
        // 白名单：一个字都不改 —— 保持 `prismarine-block` else 分支给的
        // `shapes = []` / `boundingBox = 'empty'`，那才是"可穿过"。
      } else if (thinPassable && isThinBlockName(b.name)) {
        // 薄方块：服务端那边本来就踩得过去，别再补成立方体挡她。
        // 显式写 `shapes = []` / `boundingBox = 'empty'`，不依赖 else 分支的默认值 ——
        // 万一上游改了默认值，这里仍然是"可穿过"。
        b.boundingBox = 'empty';
        b.shapes = EMPTY_SHAPES;
        b.thinBlock = true;
        stats.thinExempt++;
        if (stats.thinNames.length < 32 && !stats.thinNames.includes(b.name)) {
          stats.thinNames.push(b.name);
        }
      } else if (lowBlockHeight(b.name)) {
        // 矮方块（床）：补成整块会把站在上面的她"埋"进方块里 —— 物理层认为她在实心里，往哪都动不了
        // （2026-09-26 实测：站在 handcrafted:oak_fancy_bed 上，y=69.56，寻路和走路全失败）
        // ⚠️ 这是**兜底中的兜底**：调色板导了形状列之后，床的真实 9/16 高碰撞箱直接来自
        //    注册表，根本走不到这里。留着是为了旧 dump（没形状列）和没进调色板的方块。
        b.boundingBox = 'block';
        b.shapes = [[0, 0, 0, 1, lowBlockHeight(b.name), 1]];
        b.lowBlock = true;
      } else {
        // 名字空 / 名字不像薄方块 / 豁免关掉了 → 保守当实心（安全的那一侧）
        b.boundingBox = 'block';
        b.shapes = FULL_CUBE;
      }
    } else if (whitelisted) {
      // 形状**已知**（调色板导出了真实碰撞箱），但在白名单里 → 白名单说了算。
      // 这里必须**主动**写成空碰撞：上面那条分支靠的是 else 分支的默认值，
      // 而这一条下面已经有一个真形状了，"什么都不做"等于不放行。
      b.boundingBox = 'empty';
      b.shapes = EMPTY_SHAPES;
      b.whitelisted = true;
      stats.whitelisted++;
    }
    return b;
  };
  world.__unknownBlockPatched = true;
  report.patched = true;
  return report;
}

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
function applyPolicy (mv, blocksByName, opts = {}) {
  if (!mv) throw new Error('applyPolicy: 需要 Movements 实例');

  const costs = { ...COSTS, ...(opts.costs || {}) };
  const { ids, matched } = buildProtectedIds(blocksByName);

  // ① 默认**不拆**（`ALLOW_DIG`，见上方常量注释）。
  //    `opts.allowDig` 是单次调用级的覆盖口子，留给将来 JEV 判定"这一趟允许挖"。
  //    放行时仍然保留"软的一层"：拆一格很贵（digCost=16 ≈ 走 23 格），绕路优先。
  const allowDig = opts.allowDig !== undefined ? !!opts.allowDig : ALLOW_DIG;
  mv.canDig = allowDig;
  mv.digCost = costs.digCost;
  mv.placeCost = costs.placeCost;
  mv.liquidCost = costs.liquidCost;

  // 不垫方块往上爬：消耗玩家的材料，而且看起来像"自己在造塔"。
  mv.allow1by1towers = false;
  mv.scafoldingBlocks = [];

  // `allowParkour` 保持原样（默认 true）—— 它不破坏任何东西，但能让她跨过小沟跟上玩家。
  // 代价是有摔落风险；想绝对保守可以显式关掉，但那属于另一个取舍，不在这里动。

  // ② 硬的一层：建筑材质永不破坏。
  // blocksCantBreak 是 pathfinder 自己的默认集合（含箱子与不可破坏方块），只增不减。
  for (const id of ids) mv.blocksCantBreak.add(id);

  return {
    canDig: mv.canDig,
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

// ---------------------------------------------------- 流体安全（逐格判据）

/**
 * 挖掉某一格会不会把液体引过来。
 *
 * 为什么需要独立于 `allowDig`：那个是**全局一刀切**开关，只有"能挖/不能挖"两个状态。
 * 但真实情况是"可以挖，别把水挖穿"—— 挖泥土取平地和挖穿水池下方的隔层是两件事。
 * 实测踩过一次：摘柠檬时挖到水边，人下去了。（记忆见 memory/2026-09-25.md）
 *
 * 判据分两层（第二层是抄 HiyoriAI `assessExcavationFluidRisk` 的，它比第一层重要）：
 *   ① 六邻域有没有液体 —— 直接相邻，挖开就连通了。
 *   ② **正上方 32 格内**有没有液体，且中间一路都是"可流通"的方块。
 *      这一层覆盖的是**服务端更新窗口**：水柱底下是空气时，那些空气格还没变成
 *      `flowing_water`，按第一层的判据看是"安全的"，但挖开的下一 tick 水就下来了。
 *      只看六邻域必然漏掉这种情况。
 *
 * @returns {{unsafe:boolean, liquid?:string, source?:{x,y,z}, via?:'adjacent'|'above'}}
 */
function assessExcavationFluidRisk (bot, position) {
  if (!bot?.blockAt || !position) return { unsafe: false };

  // ① 六邻域（其实只查 5 个：正下方那格是脚底，挖它不会引水到自己头上）
  const adjacent = [
    [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1],
  ];
  for (const [dx, dy, dz] of adjacent) {
    const p = { x: position.x + dx, y: position.y + dy, z: position.z + dz };
    const name = String(bot.blockAt(p, false)?.name ?? '');
    if (LIQUID_NAMES.has(name)) {
      return { unsafe: true, liquid: name, source: p, via: 'adjacent' };
    }
  }

  // ② 正上方一路扫上去，直到撞到实体方块
  for (let dy = 1; dy <= MAX_VERTICAL_FLOW_LOOKAHEAD; dy++) {
    const p = { x: position.x, y: position.y + dy, z: position.z };
    const block = bot.blockAt(p, false);
    const name = String(block?.name ?? '');
    if (LIQUID_NAMES.has(name)) {
      return { unsafe: true, liquid: name, source: p, via: 'above' };
    }
    // 撞到不透水的方块就停 —— 中间有隔断，上面的水是下不来的。
    // `boundingBox === 'empty'` 覆盖空气/草/花/告示牌等一切"能过水"的东西。
    if (!isFlowPassable(block)) break;
  }

  return { unsafe: false };
}

/** 水能不能从这里流过去。空气与一切无碰撞箱的方块都算通透。 */
function isFlowPassable (block) {
  if (!block) return false;
  const name = String(block.name ?? '');
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return true;
  // 名字认不出来（模组方块）时按**不透水**处理：宁可高估安全，也别把水放进来。
  if (!name) return false;
  return block.boundingBox === 'empty' && !LIQUID_NAMES.has(name);
}

/**
 * 把流体风险装进 A* 的破坏代价。
 *
 * ⚠️ 用的是 `exclusionAreasBreak` 而不是 `blocksCantBreak`：
 *    前者是**按位置**判定的函数数组（每一格单独算），后者是**按方块 id**的静态集合。
 *    "这一池水旁边的泥土"和"山那边的泥土"是同一个 id，但风险完全不同 ——
 *    只有按位置才能区分。
 *
 * 为什么返回 100 而不是 Infinity：100 是 pathfinder 里"不可通行"的约定值
 * （见 `movements.js` 的 `if (!this.safeToBreak(block)) return 100`），
 * 但用函数返回它**不会**污染 `blocksCantBreak` 那个集合，也不影响别的寻路任务。
 *
 * @returns {{applied:boolean, reason?:string}}
 */
function injectFluidBreakGuard (bot, mv, opts = {}) {
  if (!mv) return { applied: false, reason: '没有 Movements 实例' };
  if (!bot?.blockAt) return { applied: false, reason: 'bot 还没有 blockAt（未连接？）' };
  if (mv[FLUID_GUARD_FLAG]) return { applied: true, reason: '已经装过了（幂等）' };

  const penalty = opts.penalty ?? 100;
  mv.exclusionAreasBreak = mv.exclusionAreasBreak || [];
  mv.exclusionAreasBreak.push((block) => {
    if (!block?.position) return 0;
    return assessExcavationFluidRisk(bot, block.position).unsafe ? penalty : 0;
  });

  // 打标记：同一个 Movements 上重复调用会不断往数组里塞函数，
  // 每一格被评估 N 次 —— 性能问题，而且没意义。
  Object.defineProperty(mv, FLUID_GUARD_FLAG, { value: true, enumerable: false });

  return { applied: true };
}

// ------------------------------------------------------------------ 自检

/**
 * 注册表往返自检：`名字 → id → 名字` 能不能对上。
 *
 * 为什么需要：第②层（按名字保护）依赖注册表可信。模组服上名字可能整体偏移，
 * 那时"保护清单"里装的是错的 ID，她会拒绝拆泥土、却照样拆羊毛。
 * 这个自检把"名字到底可不可信"变成可观测的事实，而不是一个假设。
 */
function probeRegistry (registry, names = ['white_wool', 'oak_planks', 'oak_log', 'glass', 'stone', 'dirt']) {
  const out = [];
  if (!registry || !registry.blocksByName || !registry.blocks) return out;
  for (const name of names) {
    const def = registry.blocksByName[name];
    if (!def || typeof def.id !== 'number') { out.push({ name, ok: false, reason: 'not-in-registry' }); continue; }
    const back = registry.blocks[def.id];
    const backName = back && back.name;
    out.push({ name, id: def.id, back: backName ?? null, ok: backName === name });
  }
  return out;
}

function summarizeProbe (probe) {
  if (!probe.length) return { checked: 0, ok: 0, mismatched: [] };
  const bad = probe.filter(p => !p.ok);
  return { checked: probe.length, ok: probe.length - bad.length, mismatched: bad.map(p => `${p.name}→${p.back ?? p.reason}`) };
}

// ------------------------------------------------------------------ 自适应采集搜索
//
// ## 为什么需要
//
// `/mine` 原来是"在 64 格内找一个方块，找不到就报没有"。问题是这个词的语义：
// **"附近没有"和"我找不到"在接口上是同一句话**。她于是会说"这里没有铁矿"——
// 而实际上矿在 70 格外的洞里，只是搜索半径是 64。
//
// ## 抄什么（对标 HiyoriAI 的 `collectionStrategy.ts`）
//
// `runAdaptiveCollection` 的思路：**半径从一个小的初始值开始，每轮没收获就翻倍**，
// 直到上限为止。两个细节值得照抄：
//   ① 本轮**有收获就不扩半径** —— 说明这一带就有，继续在这儿挖更划算
//   ② 循环的终止判据用 **`gainedItems`**（背包真正多了几件）而**不是**
//      `collectedBlocks`（挖了几格）。两者不等：挖了石头却没捡到（背包满、
//      被别的玩家抢、掉进岩浆）时，"挖到了"是假进展，会让她无意义地待在这里。
//
// 我们这边多一条 HiyoriAI 没有的约束：**搜不到的半径要如实报告**。
// 所以这里返回的是"每轮试了多大、为什么停"，而不是只返回结果。

/** 采集搜索的默认参数。数值与 HiyoriAI 对齐（它有 `MAX_COLLECTION_SEARCH_RADIUS=128`）。 */
const COLLECT_SEARCH = {
  initialRadius: 16,
  /** 半径上限。超过这个就没必要了 —— 寻路本身会先超时。 */
  maxRadius: 128,
  /** 最多扩几次（= 最多搜索轮数）。防止半径停在某个值上永远循环。 */
  maxSweeps: 6,
};

/**
 * 生成采集搜索的半径序列。
 *
 * 纯函数，便于穷举 —— 真正"扩半径"的循环在 bridge-server 里（要调 findBlock）。
 *
 * ⚠️ 为什么"有收获就不扩半径"这件事不在这个函数里：它是**循环的控制流**，
 *    不是半径序列的性质。这里只负责"没收获时下一轮该多大"。
 *
 * @param {object} [opts] { initialRadius, maxRadius, maxSweeps }
 * @returns {number[]} 例：[16, 32, 64, 128]
 */
function buildRadiusLadder (opts = {}) {
  const init = Math.max(1, Math.floor(opts.initialRadius ?? COLLECT_SEARCH.initialRadius));
  const max = Math.max(init, Math.floor(opts.maxRadius ?? COLLECT_SEARCH.maxRadius));
  const sweeps = Math.max(1, Math.floor(opts.maxSweeps ?? COLLECT_SEARCH.maxSweeps));

  const out = [init];
  let r = init;
  while (out.length < sweeps && r < max) {
    r = Math.min(max, r * 2);
    out.push(r);
    if (r === max) break;
  }
  return out;
}

/**
 * 判断这一轮算不算"有收获"。
 *
 * @param {object} p
 * @param {number} p.gainedItems  背包里**真正多了几件**（服务端判定的结果）
 * @param {number} p.brokenBlocks 挖掉了几格（客户端动作成功了）
 * @param {boolean} [p.inventoryFull] 背包是不是满了
 * @returns {{productive:boolean, reason:string}}
 *
 * ⚠️ 判据是 `gainedItems`，不是 `brokenBlocks`。两者不等的情形很具体
 *    （2026-09-25 实战全部见到过）：
 *    - **挖完就走没回头捡** —— 掉落物落在地上，要走过去才被服务端判定拾取。
 *      实测：砍 8 个 lemon_log 只到手 1 个（见 memory/field-log.md P1）
 *    - 背包满：挖下来但捡不起来
 *    - 挖的是水下的方块：方块掉了但物品沉了
 *    - 别的玩家抢走
 *    这几种情况下 `brokenBlocks > 0` 但 `gainedItems === 0`，
 *    按 `brokenBlocks` 判会认为"有进展"，于是她会在一个拿不到东西的地方反复挖。
 *
 * `inventoryFull` 的作用是**让理由说得准**：运维时"背包满"和"没回头捡"
 * 的处理方式完全不同（前者该丢东西，后者是代码问题），不该共用一句文案 ——
 * 这正是 P2 暴露出来的毛病。
 */
function isProductiveSweep ({ gainedItems = 0, brokenBlocks = 0, inventoryFull = false } = {}) {
  if (gainedItems > 0) {
    return { productive: true, reason: `+${gainedItems} 件` };
  }
  if (brokenBlocks > 0) {
    if (inventoryFull) {
      return { productive: false, reason: `挖了 ${brokenBlocks} 格但背包满，捡不起来 —— 该先丢东西` };
    }
    return { productive: false, reason: `挖了 ${brokenBlocks} 格但一件都没进包（没回头捡？被抢？掉水里？）` };
  }
  return { productive: false, reason: '这一带没有可挖的' };
}

/**
 * 决定采集循环的下一步。
 *
 * @param {object} p
 * @param {number} p.sweep        已经搜过几轮（从 1 开始）
 * @param {boolean} p.hit         本轮有没有找到目标方块
 * @param {boolean} p.productive  本轮算不算有收获（见 isProductiveSweep）
 * @param {number} p.wanted       还要几件
 * @param {number} p.got          已经拿到几件
 * @param {number[]} p.ladder     半径序列
 * @param {string} [p.why]        `isProductiveSweep` 给出的**具体原因**，见下
 * @returns {{action:'continue'|'widen'|'done'|'give-up', radius:number|null, reason:string}}
 *
 * ## `why` 这个参数为什么必须存在（P2 → P2b 的教训）
 *
 * P2 把 `isProductiveSweep` 改成了能区分三种"没收获"的原因
 * （背包满 / 挖了没捡 / 没得挖），自测也全绿了。
 * **但实机上 `sweeps` 里看到的还是那句模糊的"目标在但拿不到"** ——
 * 因为这个函数自己硬编码了同一句 reason，把上游的结论**丢掉了**。
 *
 * 于是"分层诊断"做得再好，在最后一跳被抹平：
 *   `isProductiveSweep` 说"背包满" → `nextCollectStep` 说"拿不到" → 运维看不到真正的原因。
 *
 * 修法不是再改一次文案，而是**让原因能透传**：调用方把 `why` 交进来，
 * 本函数原样带出去。谁判断的原因，谁就负责说清楚。
 */
function nextCollectStep ({ sweep = 1, hit = false, productive = false, wanted = 1, got = 0, ladder = [], why = '' } = {}) {
  if (got >= wanted) {
    return { action: 'done', radius: null, reason: `够了（${got}/${wanted}）` };
  }
  // 有收获就不扩半径 —— 这一带就有，继续在这儿挖更划算。
  // 注意这里**也**包括"找到了但还没拿到"：说明目标在，只是还没挖完。
  if (productive) {
    return { action: 'continue', radius: ladder[sweep - 1] ?? null, reason: '这一带有收获，继续' };
  }
  // 没找到目标：扩半径。注意与上一条的区别 —— 上一条是"找到了没收获"，
  // 这条是"连目标都没找到"。两种情况的应对完全不同。
  if (!hit) {
    if (sweep >= ladder.length) {
      return {
        action: 'give-up',
        radius: null,
        reason: `搜到 ${ladder[ladder.length - 1] ?? 0} 格都没有（共 ${sweep} 轮）`,
      };
    }
    return {
      action: 'widen',
      radius: ladder[sweep],
      reason: `这一轮（${ladder[sweep - 1]} 格）没找到，扩到 ${ladder[sweep]} 格`,
    };
  }
  // 找到了但没收获（挖了捡不到）：换地方比死磕更理性，但**不扩半径** ——
  // 问题不在"太远"，在"拿不到"。所以按"continue"处理，让调用方自己决定放弃。
  //
  // ⚠️ reason **必须**用上游给的 `why`。不要再写死一句话 —— 那正是 P2b 的 bug：
  //    分了三类原因，却在这里被统一盖掉。
  //    兜底也保留，但只在调用方**没给**原因时才用（给个诚实的"不知道"）。
  return {
    action: 'continue',
    radius: ladder[sweep - 1] ?? null,
    reason: why || '找到了但没到手（原因未上报 —— 调用方该传 why）',
  };
}

// ------------------------------------------------------------------ 单次寻路的超时与停滞
//
// ## 为什么需要这一节
//
// `bot.pathfinder.goto(goal)` **自己不设超时**。它要么到达、要么明确报
// `No path to the goal!`，要么就永远挂着 —— 而最后一种在真实服务器上很常见：
// 目标点被围住、寻路器算出一条永远走不通的路径、或者服务器在该 tick 卡了一下。
//
// 我们原来的做法是给**整个 HTTP 请求**套一个固定 45s 超时。两个问题：
//   ① 走 3 格和走 60 格用同一个数字。近距离时白等 45 秒才认输；
//      远距离时 45 秒又不够，明明在稳步靠近却被砍掉。
//   ② 它只看总时长，**看不出"还在动"还是"已经卡住"**。顶着墙角站位
//      和正常赶路在固定超时眼里没有区别。
//
// ## 抄什么（对标 HiyoriAI 的 `patchedGoto.ts`）
//
// HiyoriAI 的做法是两层：
//   ① **按路径预估耗时**（`estimatePathTimeMs`）→ `timeout = max(30s, min(300s, eta*2 + 10s))`
//      —— 用节点类型逐段累加（挖 1.5s / 放 0.5s / parkour 1.0s / 跳 0.6s / 直走按速度）
//   ② **每 5s 检查一次有没有真的在靠近**，连续 3 次没有实质进展就直接放弃
//
// 我们照抄这两层，但**把常量重新定过**：HiyoriAI 的 `GRACE_FACTOR=2.0` 给的是
// "允许比预估慢一倍"，实测在模组服（TPS 低）上仍然偏紧。
//
// ## 与 autopilot 的 `stuckTicks` 是两层，不是重复
//
// `autopilot.stuckTicks`（14 tick ≈ 21s）看的是**跨动作**的位置不动，
// 用来发现"整段行为卡死"；这一节看的是**单次 goto 内部**的路径进展。
// 一个反例：`goto` 每次都在 20 秒时被 autopilot 超时砍掉，然后重新发起 ——
// 位置有轻微抖动，`stuckTicks` 永远不触发，但这件事永远做不成。
// 停滞检测能抓住它（路径没在缩短），`stuckTicks` 抓不住。

/** 各动作类型的**悲观**单步耗时（毫秒）。刻意取悲观值 —— 超时宁长勿短。 */
const PATH_STEP_MS = {
  walk: 0,          // 直走按速度算，见 estimatePathTimeMs
  jump: 700,        // 跳跃本身 + 落地缓冲（HiyoriAI 是 600，模组服多给 100）
  parkour: 1100,    // 跳 3 格空隙（HiyoriAI 是 1000）
  place: 600,       // 放一个方块当桥（HiyoriAI 是 500）
  dig: 1800,        // 拆一格（HiyoriAI 是 1500 —— 模组方块硬度普遍更高）
};

/** 疾跑速度（格/秒）。原版疾跑 5.612，取 5.6 与 HiyoriAI 一致。 */
const SPRINT_SPEED = 5.6;

/** 预估之外的宽限系数。2.0 = 允许比预估慢一倍。 */
const PATH_GRACE_FACTOR = 2.0;
/** 固定附加宽限（毫秒）—— 覆盖"起步、转向、服务器卡一下"的固定开销。 */
const PATH_BASE_GRACE_MS = 10000;
/** 超时上下界。 */
const PATH_MIN_TIMEOUT_MS = 30000;
const PATH_MAX_TIMEOUT_MS = 300000;

/** 停滞检测：多久检查一次、一小步算多少格、连续几次算放弃。 */
const PATH_PROGRESS_INTERVAL_MS = 5000;
/** 一次检查里"离目标更近了多少格"低于这个数，视为没有实质进展。 */
const PATH_STAGNATION_THRESHOLD = 1.5;
/** 连续多少次没有进展就放弃。 */
const MAX_STAGNANT_CHECKS = 3;

/**
 * 续期倍率 —— 一次 goto 的总时限最多能涨到初始预算的几倍。
 * 见 `computeHardCap` 的说明（P9：续期必须有头）。
 */
const PATH_RENEW_FACTOR = 3;

/**
 * 把 pathfinder 清回"没有目标"的状态。
 *
 * ## 为什么这是个**必须显式做**的动作（P25，2026-09-25 实战）
 *
 * `pathfinder.goto(goal)` 返回的 promise 在超时/被放弃时，**那个 goal 仍然留在
 * pathfinder 上**。这不是 bug，是 `goto` 的语义：它只是"等这次寻路结束"，
 * 而"结束"的定义是 Goal 的 `isEnd()` 成立。调用方不等了 ≠ 寻路器不跑了。
 *
 * 后果非常隐蔽：
 * ```
 * await race(goto(goalA), sleep(6000));   // sleep 赢了，goalA 还在跑
 * await goto(goalB);                      // → "The goal was changed before
 *                                         //    it could be completed!"
 * ```
 * 报错信息读起来像"我们自己换了目标"，实际是"上一个目标没清干净"。
 * 实测到它时的现象是「地上 9 个掉落物，`walkedTo: 2`」——
 * 看起来像"寻路有点慢"，实际是第 3 个之后**全部秒失败**。
 *
 * ## 为什么 stop() 和 setGoal(null) 都要调
 *
 * `stop()` 掐断当前正在执行的路径（清掉 `path` 与计时器），
 * `setGoal(null)` 清掉目标本身。只调其中一个会留下半个状态：
 * 只 `stop()` 的话，下一轮 `goto` 仍会看到旧 goal 而抛错；
 * 只 `setGoal(null)` 的话，那条正在跑的路径可能还在推进。
 *
 * 两者都包在 try 里：pathfinder 插件可能没装，或 bot 正断开 ——
 * **清理失败不该让主流程失败**，那只会把一个可恢复的小问题升级成任务失败。
 *
 * @param {object} pf  mineflayer-pathfinder 插件实例（`bot.pathfinder`）
 * @returns {boolean}  是否至少成功执行了一次清理（用于自测与诊断）
 */
function clearPathfinderGoal (pf) {
  if (!pf) return false;
  let did = false;
  try { pf.stop(); did = true; } catch (_) {}
  try { pf.setGoal(null); did = true; } catch (_) {}
  return did;
}

/** 按 cost 量级归类这一步属于哪种移动。判据见 `stepCostMs` 的说明。 */
function stepKind (cost) {
  if (!Number.isFinite(cost) || cost <= 0) return 'walk';
  if (cost >= 4) return 'dig';
  if (cost >= 2.5) return 'place';
  if (cost >= 2.2) return 'parkour';
  if (cost >= 1.6) return 'jump';
  return 'walk';
}

/**
 * 把一个路径节点映射成"这一步要花多久"。
 *
 * 之所以不 import pathfinder 的常量而是手写：这些数字是**策略**不是**事实**，
 * 而且我们要能随着"玩家抱怨走太慢/走太久"单独调，不想被动跟着上游改。
 *
 * @param {object} node      pathfinder 的 Move 实例（有 `cost` 字段）
 * @returns {number} 毫秒
 */
function stepCostMs (node) {
  const cost = Number(node?.cost);
  const kind = stepKind(cost);
  if (kind !== 'walk') return PATH_STEP_MS[kind];
  // 直走：cost 通常是 1（正交）或 √2（对角）。
  // 这里要的是量级，不是精确值，所以只区分"斜着"和"正着"。
  const dist = cost >= 1.4 ? Math.SQRT2 : 1;
  return Math.round((dist / SPRINT_SPEED) * 1000);
}

/**
 * 按路径预估走完要多久。
 *
 * @param {Array} path  pathfinder 路径（节点数组）；空/无效返回 null
 * @returns {{etaMs:number, steps:number, breakdown:object}|null}
 */
function estimatePathTimeMs (path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  const breakdown = { walk: 0, jump: 0, parkour: 0, place: 0, dig: 0 };
  let total = 0;
  for (const node of path) {
    const ms = stepCostMs(node);
    breakdown[stepKind(Number(node?.cost))] += ms;
    total += ms;
  }
  return { etaMs: total, steps: path.length, breakdown };
}

/**
 * 由预估耗时推导这次 goto 该给多少超时。
 *
 * 公式抄 HiyoriAI：`max(MIN, min(MAX, eta * GRACE + BASE))`。
 * 路径拿不到（null）时给 MIN —— 拿不到路径说明这次多半会很快报"无路"，
 * 没必要等满。
 *
 * @param {object|null} est estimatePathTimeMs 的返回值
 * @param {object} [opts] { minMs, maxMs, grace, baseMs }
 * @returns {{timeoutMs:number, etaMs:number|null, source:string}}
 */
function computeTimeoutFromEta (est, opts = {}) {
  const minMs = opts.minMs ?? PATH_MIN_TIMEOUT_MS;
  const maxMs = opts.maxMs ?? PATH_MAX_TIMEOUT_MS;
  const grace = opts.grace ?? PATH_GRACE_FACTOR;
  const baseMs = opts.baseMs ?? PATH_BASE_GRACE_MS;
  if (!est || !Number.isFinite(est.etaMs)) {
    return { timeoutMs: minMs, etaMs: null, source: 'no-path' };
  }
  const raw = est.etaMs * grace + baseMs;
  const clamped = Math.max(minMs, Math.min(maxMs, raw));
  return { timeoutMs: Math.round(clamped), etaMs: est.etaMs, source: 'eta' };
}

/**
 * 算出一次 goto 的**绝对上限**，以及它能被续期几次。
 *
 * ## 为什么需要这个（P9，2026-09-25 实战）
 *
 * 原来的设计是"预算涨了就续期"，用意是好的：远距离路径的合理等待
 * 确实该随距离增长，一刀切成固定值会误砍正常的长途移动。
 *
 * **但它没有上限。** 而 `path_update` 会在"路径反复重规划"时高频触发 ——
 * 也就是**恰好在她卡住的时候**。每次重规划都让预算涨一点、watchdog 续一次期，
 * 于是超时永远不到期。实机表现：`POST /mine {count:1}` 跑了 **150 秒**不返回，
 * 而配置的 `PATH_MIN_TIMEOUT_MS` 是 30 秒。
 *
 * > 一个能无限续期的超时，**等于没有超时**。
 *
 * ## 上限怎么取
 *
 * 取 `PATH_MAX_TIMEOUT_MS`（库里的 300s）与"初始预算 × 3"的较大者。
 * - 用 `×3` 而不是 `×1.5`：正常的重规划（绕过临时障碍）会续期一两次，
 *   不该被误判成"卡住"。
 * - 用 `max` 而不是 `min`：初始预算本来就小的近距路径（30s）
 *   不该把上限压到 90s —— 那对某些地形太紧。
 *
 * @param {number} initialTimeoutMs 初始预算
 * @param {object} [opts] 覆盖常量（自测用）
 * @returns {{hardCapMs:number, maxRenewals:number, reason:string}}
 */
function computeHardCap (initialTimeoutMs, opts = {}) {
  const maxMs = opts.maxMs ?? PATH_MAX_TIMEOUT_MS;
  const factor = opts.factor ?? PATH_RENEW_FACTOR;
  const base = Number.isFinite(initialTimeoutMs) && initialTimeoutMs > 0
    ? initialTimeoutMs
    : PATH_MIN_TIMEOUT_MS;
  const hardCapMs = Math.max(maxMs, base * factor);
  return {
    hardCapMs: Math.round(hardCapMs),
    // 能续期几次（**仅供参考**，真正的约束是 hardCapMs 这个时间上限）。
    // 暴露它是为了留痕："续了 40 次"比"超时了"更能说明她在原地打转。
    maxRenewals: Math.max(0, Math.round((hardCapMs - base) / Math.max(1, base * 0.2))),
    reason: `max(${maxMs}, ${base}×${factor}) = ${Math.round(hardCapMs)}ms`,
  };
}

/**
 * 停滞检测器 —— 一次 goto 生命周期内的状态机。
 *
 * 用法：
 *   const m = createStagnationMonitor({ x, y, z });
 *   const verdict = m.sample(bot.entity.position, Date.now());
 *   if (verdict.stagnant >= MAX) 放弃
 *
 * @param {object} origin 起点 {x,y,z}（用来算"总共前进了多少"）
 * @param {object} [opts] 覆盖常量，便于自测
 * @returns {{sample:Function, snapshot:Function}}
 */
function createStagnationMonitor (origin, opts = {}) {
  const interval = opts.intervalMs ?? PATH_PROGRESS_INTERVAL_MS;
  const threshold = opts.threshold ?? PATH_STAGNATION_THRESHOLD;
  const maxStagnant = opts.maxStagnant ?? MAX_STAGNANT_CHECKS;

  const start = { ...origin };
  let lastSampleAt = null;
  let lastPos = { ...origin };
  let bestDistance = null;     // 全程离起点最远的距离 —— 用来算"有没有真的往前走"
  let stagnant = 0;
  let checks = 0;

  const dist2d = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
  const dist3d = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));

  function sample (pos, now = Date.now()) {
    const p = { x: pos?.x ?? start.x, y: pos?.y ?? start.y, z: pos?.z ?? start.z };
    const travelled = dist3d(p, start);
    if (bestDistance === null || travelled > bestDistance) bestDistance = travelled;

    if (lastSampleAt === null) {
      lastSampleAt = now;
      lastPos = p;
      return { due: false, moved: 0, travelled, stagnant, checks, exhausted: false };
    }

    if (now - lastSampleAt < interval) {
      return { due: false, moved: dist3d(p, lastPos), travelled, stagnant, checks, exhausted: false };
    }

    // 到点了 —— 和**上一次采样点**比，而不是和起点比。
    // 和起点比会把"走了又绕回来"算成"一动不动"，那是错的：
    // 绕路是寻路的正常工作方式，不该被惩罚。
    const moved = dist3d(p, lastPos);
    checks++;
    if (moved < threshold) stagnant++; else stagnant = 0;
    lastSampleAt = now;
    lastPos = p;

    return {
      due: true,
      moved: Math.round(moved * 100) / 100,
      travelled: Math.round(travelled * 100) / 100,
      stagnant,
      checks,
      exhausted: stagnant >= maxStagnant,
    };
  }

  function snapshot () {
    return {
      origin: start,
      checks,
      stagnant,
      bestDistance: bestDistance === null ? null : Math.round(bestDistance * 100) / 100,
      intervalMs: interval,
      threshold,
      maxStagnant,
    };
  }

  return { sample, snapshot };
}

// ------------------------------------------------------------------ 自测

// ⚠️ 必须带 `require.main === module`。
//    这里原来是裸的 `if (process.argv.includes('--selftest'))` —— 任何**被 require 进来**
//    的进程只要命令行里有 `--selftest` 就会连带触发本文件的自测。
//    实测：`node palette-registry.js --selftest` 打出来的是 pathing 的用例，
//    自己的用例一条没跑（而且退出码是 pathing 的）。这就是"加载时求值"那类坑。
//    全仓只有 bridge-server.js require 本模块，且从不带 `--selftest`，
//    所以收紧成 require.main 守卫不影响任何现有调用方（decision.js / place.js /
//    block-palette.js 本来就是这么写的）。
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = got === expect;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  };

  console.log('\n[1/7] 受保护判定 —— 建筑材料一格都不许动');
  const SHOULD_PROTECT = [
    'white_wool', 'red_wool', 'oak_planks', 'spruce_planks', 'glass',
    'glass_pane', 'white_stained_glass_pane', 'oak_door', 'oak_trapdoor',
    'oak_stairs', 'oak_slab', 'oak_fence', 'oak_fence_gate', 'cobblestone_wall',
    'stone_bricks', 'white_concrete', 'terracotta', 'oak_log', 'stripped_oak_log',
    'chest', 'barrel', 'furnace', 'bookshelf', 'oak_sign', 'torch', 'lantern',
    'red_bed', 'crafting_table', 'diamond_ore', 'deepslate_iron_ore',
    'ancient_debris', 'white_carpet', 'oak_button', 'rail', 'white_banner',
  ];
  for (const n of SHOULD_PROTECT) check(`保护 ${n}`, isProtected(n), true);

  console.log('\n[2/7] 不该保护 —— 自然地形必须留作最后手段');
  const SHOULD_NOT = [
    'dirt', 'stone', 'grass_block', 'sand', 'gravel', 'deepslate',
    'netherrack', 'oak_leaves', 'cobblestone', 'coal_block', 'andesite',
    'tuff', 'clay', 'snow_block', 'moss_block', 'soul_sand',
  ];
  for (const n of SHOULD_NOT) check(`不保护 ${n}`, isProtected(n), false);

  console.log('\n[3/7] 名字归一与边界');
  check('剥命名空间：quark:oak_planks 仍受保护', isProtected('quark:oak_planks'), true);
  check('剥命名空间：create:dirt 仍不受保护', isProtected('create:dirt'), false);
  check('null 不炸且不保护', isProtected(null), false);
  check('undefined 不炸且不保护', isProtected(undefined), false);
  check('空串不保护', isProtected(''), false);
  check('数字不炸且不保护', isProtected(42), false);
  check('裸名归一：quark:oak_planks → oak_planks', bareName('quark:oak_planks'), 'oak_planks');
  check('无命名空间原样返回', bareName('oak_planks'), 'oak_planks');

  console.log('\n[4/7] 代价与装配 —— 核心不变量');
  // 这是整个修复的核心：走一格 = 1，所以 digCost 必须远大于 1，
  // 否则"拆墙"比"绕路"便宜，她就会拆房子（这就是原来那个 bug）。
  check('digCost 远大于"走一格"的 1（否则拆墙比绕路便宜）', COSTS.digCost >= 10, true);
  check('digCost 是有限值（无限大会让最后手段消失，退回 canDig=false 的毛病）',
    Number.isFinite(COSTS.digCost) && COSTS.digCost < 100, true);
  check('placeCost 为正', COSTS.placeCost > 0, true);
  check('liquidCost 为正（走水路要更贵，免得她一路涉水）', COSTS.liquidCost > 0, true);

  // 假注册表：验证 ID 装配与"只增不减"
  const fakeReg = {
    blocksByName: {
      white_wool: { id: 101 }, oak_planks: { id: 102 }, oak_log: { id: 103 },
      diamond_ore: { id: 104 }, dirt: { id: 105 }, stone: { id: 106 },
    },
  };
  const built = buildProtectedIds(fakeReg.blocksByName);
  check('保护集合只装该保护的（4 个）', built.ids.size, 4);
  check('dirt 不在保护集合里', built.ids.has(105), false);
  check('stone 不在保护集合里', built.ids.has(106), false);
  check('white_wool 在保护集合里', built.ids.has(101), true);
  check('diamond_ore 在保护集合里', built.ids.has(104), true);
  check('matched 里没有 dirt', built.matched.includes('dirt'), false);

  const fakeMv = { blocksCantBreak: new Set([999]), blocksToAvoid: new Set() };
  const summary = applyPolicy(fakeMv, fakeReg.blocksByName);
  check('默认 canDig 关闭（只绕不拆）', fakeMv.canDig, false);
  check('摘要 allowDig 与 canDig 一致（默认关）', summary.allowDig, summary.canDig);
  check('digCost 已写入', fakeMv.digCost, COSTS.digCost);
  check('placeCost 已写入', fakeMv.placeCost, COSTS.placeCost);
  check('liquidCost 已写入', fakeMv.liquidCost, COSTS.liquidCost);
  check('allow1by1towers 关闭（不垫方块爬高）', fakeMv.allow1by1towers, false);
  check('scafoldingBlocks 清空（不消耗玩家材料）', fakeMv.scafoldingBlocks.length, 0);
  check('blocksCantBreak 是"只增不减"：原有 999 还在', fakeMv.blocksCantBreak.has(999), true);
  check('blocksCantBreak 装上了 4 个受保护 ID', fakeMv.blocksCantBreak.size, 5);
  check('摘要里的 protectedCount 与实际一致', summary.protectedCount, 4);
  check('摘要里 canDig 为 false（供控制面核对）', summary.canDig, false);

  // opts.allowDig 是单次调用级的放行口子 —— 将来由 JEV 判定"这一趟该不该挖"时走这条。
  // 默认关闭必须靠这里钉住：一旦有人把默认改回 true，上面两条会立刻红。
  const digMv = { blocksCantBreak: new Set(), blocksToAvoid: new Set() };
  const digSummary = applyPolicy(digMv, fakeReg.blocksByName, { allowDig: true });
  check('opts.allowDig=true 时 canDig 才打开', digMv.canDig, true);
  check('opts.allowDig=true 时摘要同步', digSummary.allowDig, true);
  check('放行时 digCost 仍是"很贵"那一档（绕路仍优先）', digMv.digCost, COSTS.digCost);

  // 空注册表不该炸（网桥还没连上服务器时就是这样）
  const emptyMv = { blocksCantBreak: new Set(), blocksToAvoid: new Set() };
  const emptySummary = applyPolicy(emptyMv, null);
  check('注册表为 null 时不炸，只是保护集合为空', emptySummary.protectedCount, 0);
  check('注册表为 null 时代价仍然写入了（软的一层不依赖名字）', emptyMv.digCost, COSTS.digCost);

  console.log('\n[5/7] 注册表往返自检 —— 名字到底可不可信');
  const goodReg = {
    blocksByName: { white_wool: { id: 1 }, dirt: { id: 2 } },
    blocks: { 1: { name: 'white_wool' }, 2: { name: 'dirt' } },
  };
  const goodProbe = probeRegistry(goodReg, ['white_wool', 'dirt']);
  check('往返对得上时 ok=2', summarizeProbe(goodProbe).ok, 2);
  check('往返对得上时 mismatched 为空', summarizeProbe(goodProbe).mismatched.length, 0);

  const badReg = {
    blocksByName: { white_wool: { id: 1 }, dirt: { id: 2 } },
    blocks: { 1: { name: 'fire' }, 2: { name: 'dirt' } },   // 这就是实测到的偏移现象
  };
  const badSummary = summarizeProbe(probeRegistry(badReg, ['white_wool', 'dirt']));
  check('往返对不上时能被抓到（white_wool→fire）', badSummary.mismatched.length, 1);
  check('对不上的那条报告了实际读到的名字', /white_wool→fire/.test(badSummary.mismatched[0]), true);
  check('查不到的名字标 not-in-registry', probeRegistry({ blocksByName: {}, blocks: {} }, ['x'])[0].reason, 'not-in-registry');
  check('注册表为 null 时返回空数组不炸', probeRegistry(null).length, 0);

  console.log('\n[6/7] 可攀爬方块 —— 梯子在模组服上会被静默漏掉');
  // ⚠️ 撤回（2026-09-23）：这里原本写着「服务器上真实梯子 = stateId 5337」。
  //    **那是错的。** 服务端 1003 个原版方块的 id 与原版零差异 → 原版 state 区间
  //    0..24134 没被挤开 → 5337 只可能是**原版**方块，也就是 crimson_hanging_sign。
  //    真相见 installLadderFix 的注释。
  //
  //    这个 fixture 现在只用来测**机制**：`5337` 代表"一个在原版表里查得到的 state"，
  //    `522772` 代表"一个查不到的模组 state"。数字是什么不重要，名字别再当线索读。
  const climbReg = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: {
      5337: { id: 215, name: 'crimson_hanging_sign' },   // 在原版表里**查得到**的 state
      4654: { id: 196, name: 'ladder' },                 // 原版梯子真正的 state
    },
  };

  check('parseIdList 解析逗号串', parseIdList('5337, 1234').join('|'), '5337|1234');
  check('parseIdList 空串 → 空数组', parseIdList('').length, 0);
  check('parseIdList 非数字被丢掉', parseIdList('a, 12, ').join('|'), '12');
  check('parseIdList 接受数组', parseIdList([1, 2]).join('|'), '1|2');
  check('parseIdList 不炸 null', parseIdList(null).length, 0);
  // 这一条是自测真的抓出来的 bug：Number('') === 0，而 0 是空气的 id。
  // 漏了剔空串的话 "5337,,1234" 会解析出 0，把空气当成可攀爬方块。
  check('parseIdList 丢掉空 token（Number(\'\') === 0 陷阱）',
    parseIdList('5337,,1234').join('|'), '5337|1234');
  check('parseIdList 丢掉纯空格 token', parseIdList('5337, ,1234').join('|'), '5337|1234');
  check('parseIdList 拒绝 0（0 是空气，绝不能进 climbables）', parseIdList('0').length, 0);
  check('parseIdList 拒绝负数与非整数', parseIdList('-1, 2.5, 7').join('|'), '7');

  const rc = resolveClimbableIds(climbReg.blocksByStateId, [5337]);
  check('stateId 5337 解析成方块 id 215', rc.byBlockId.has(215), true);
  check('查得到的 stateId 不进 unmapped', rc.unmapped.length, 0);
  const rcUn = resolveClimbableIds(climbReg.blocksByStateId, [522772]);
  check('原版表里查不到的模组 state 进 unmapped', rcUn.unmapped.join('|'), '522772');
  check('查不到的 state 不会塞进 byBlockId', rcUn.byBlockId.size, 0);
  check('blocksByStateId 为 null 时不炸，全进 unmapped', resolveClimbableIds(null, [1, 2]).unmapped.length, 2);

  // 假 Movements：getBlock 按 stateId 返回方块。
  // ⚠️ 替身必须**忠实模仿库的写法**：真库里 `climbable` 一定是被显式赋值的布尔
  //    （`b.climbable = this.climbables.has(b.type)`），不是"没这个字段"。
  //    第一版替身漏了这句，于是"没配置的 state 不该可攀爬"这条断言拿到的是
  //    `undefined` 而不是 `false` —— 是替身不够真，不是实现有错。
  //    注意 `type: undefined` —— 这就是模组方块在真实运行时的样子。
  const mkMv = (stateId) => {
    const mv = {
      climbables: new Set([196]),
      getBlock: () => {
        const b = { stateId, type: undefined };
        b.climbable = mv.climbables.has(b.type);
        return b;
      },
    };
    return mv;
  };

  const climbMv = mkMv(5337);
  const cl = applyClimbables(climbMv, climbReg, [5337, 522772]);
  check('查得到的梯子 id 215 装进了 climbables（走①）', climbMv.climbables.has(215), true);
  check('只增不减：库里原有的原版梯子 id 196 还在', climbMv.climbables.has(196), true);
  check('摘要报告走①的方块 id', cl.addedBlockIds.join('|'), '215');
  check('摘要报告走②的模组 state', cl.unmappedStateIds.join('|'), '522772');
  check('摘要说明 state 补丁已装', cl.stateIdPatchInstalled, true);

  // ①' 名字路线：从服务端快照解析出的方块 id 直接灌进来，**可以多个**。
  //     本包有 32 种梯子（Quark 一家 14 种木材变体），寻路器该全认。
  const mvNamed = mkMv(99999);
  const clNamed = applyClimbables(mvNamed, climbReg, [], { blockIds: [18811, 18812, 18813] });
  check('名字路线：多个方块 id 全部装进 climbables',
    [18811, 18812, 18813].every(id => mvNamed.climbables.has(id)), true);
  check('名字路线：如实报出装了哪些', clNamed.addedExtraBlockIds.join('|'), '18811|18812|18813');
  check('名字路线：只增不减，原版 196 仍在', mvNamed.climbables.has(196), true);
  check('名字路线：不产生"查不到的 state"', clNamed.unmappedStateIds.length, 0);
  // 非正整数必须挡掉 —— 0 是空气，塞进 climbables 就是"空气可攀爬"
  const mvBad = mkMv(99999);
  applyClimbables(mvBad, climbReg, [], { blockIds: [0, -1, 2.5, 18811] });
  check('名字路线：拒绝 0 / 负数 / 非整数（0 是空气）', mvBad.climbables.has(0), false);
  check('名字路线：合法的那一个仍然装上', mvBad.climbables.has(18811), true);
  check('名字路线：不给 opts 时不炸', (() => {
    try { applyClimbables(mkMv(1), climbReg, []); return true; } catch (e) { return false; }
  })(), true);

  // ② 的核心：模组方块的 type 恒为 undefined，climbables 永远命中不了，
  //    所以必须按 stateId 判 —— 否则"加个数字"等于把所有模组方块都说成可攀爬。
  const mvMod = mkMv(522772);
  applyClimbables(mvMod, climbReg, [522772]);
  check('模组方块：按 stateId 命中，climbable 被置 true',
    mvMod.getBlock(null, 0, 0, 0).climbable, true);

  const mvOther = mkMv(123456);
  applyClimbables(mvOther, climbReg, [522772]);
  check('没配置的 stateId 不会被误判成可攀爬',
    mvOther.getBlock(null, 0, 0, 0).climbable, false);

  // 重连会再装配一次，不能把 getBlock 套娃包多层
  const mvTwice = mkMv(522772);
  applyClimbables(mvTwice, climbReg, [522772]);
  const wrappedOnce = mvTwice.getBlock;
  applyClimbables(mvTwice, climbReg, [522772]);
  check('重复装配不会把 getBlock 套娃包多层', mvTwice.getBlock === wrappedOnce, true);
  check('重复装配后依然能命中', mvTwice.getBlock(null, 0, 0, 0).climbable, true);

  // 这一组断言就是"她为什么不会爬梯子"的可观测化
  const pc = probeClimbables(climbReg, [5337]);
  check('自检发现：原版那套认不出这包里的梯子', pc.vanillaPathWouldWork, false);
  check('自检报出库里写死的原版梯子 id', pc.vanillaLadderId, 196);
  check('自检报出 5337 实际解析成了什么名字', pc.observed[0].resolvedName, 'crimson_hanging_sign');
  check('自检里 5337 解析出的 id 不是原版梯子 id', pc.observed[0].isVanillaLadder, false);
  check('自检标出 5337 在原版表里有映射', pc.observed[0].mappedInVanilla, true);

  const pcUn = probeClimbables(climbReg, [522772]);
  check('自检标出模组方块在原版表里没有映射', pcUn.observed[0].mappedInVanilla, false);

  const pcOk = probeClimbables(climbReg, [4654]);
  check('若 state 恰好就是原版梯子，则判定原版路径可用', pcOk.vanillaPathWouldWork, true);
  check('注册表缺失时自检返回 null 而不是撒谎', probeClimbables(null).vanillaPathWouldWork, null);

  // ---- installLadderFix ----
  // ⚠️ 撤回（2026-09-23）：这一节原本把 `5337` 当成"本包真实梯子的 state"、把 `215`
  //    当成"修好之后该有的 id"，断言**全部通过** —— 因为它忠实复现了一个虚构前提。
  //    现在改成拿**真实 minecraft-data** 当基准：前提一旦漂移，测试自己会红。
  let realMc = null;
  try { realMc = require('minecraft-data')('1.20.1'); } catch (e) { /* 没装就跳过真值断言 */ }
  if (realMc && realMc.blocksByName.ladder) {
    const ld = realMc.blocksByName.ladder;
    check('真值：原版 ladder 的方块 id 是 196', ld.id, 196);
    check('真值：原版 ladder 的 state 区间是 4654..4661',
      `${ld.minStateId}..${ld.maxStateId}`, '4654..4661');
    check('真值：原版表里 4654 就属于 ladder 这个方块',
      realMc.blocksByStateId[ld.minStateId].name, 'ladder');
    // 撤回的**正面证据**，直接打在库上 —— 不是我们自己编的 fixture：
    // 5337 在原版表里是 crimson_hanging_sign(id 215)，跟梯子毫无关系。
    check('撤回：原版表里 5337 是 crimson_hanging_sign',
      realMc.blocksByStateId[5337].name, 'crimson_hanging_sign');
    check('撤回：原版表里 5337 的方块 id 是 215（不是 196）',
      realMc.blocksByStateId[5337].id, 215);
    check('撤回：5337 落在原版 ladder 的 state 区间之外',
      ld.minStateId <= 5337 && 5337 <= ld.maxStateId, false);
  }

  // 忠实模仿 `new Movements()`：climbables 里装的是**当时**从注册表读到的 id
  // （`movements.js:64`）。所以"修完之后新建的 Movements 认不认得出"才是真问题 ——
  // 只断言"注册表里的数字变了"是不够的。
  //
  // ⚠️ `typeOverride` 是必需的，不是方便：**模组方块的 `b.type` 来自服务端注册表，
  //    不来自原版 state 表**。第一版替身只会查原版表，于是模组场景里 `type` 恒为
  //    undefined，把"名字路线修好了"这条断言测成了假的。（自测第 5 次抓到
  //    "替身比实现更不真" —— 这类替身一旦简化过头，测的就是替身自己。）
  const mkMvFromRegistry = (reg, stateId, typeOverride) => {
    const mv = {
      climbables: new Set([reg.blocksByName.ladder.id]),
      getBlock: () => {
        const def = reg.blocksByStateId[stateId];
        const type = typeOverride !== undefined ? typeOverride : (def ? def.id : undefined);
        const b = { stateId, type };
        b.climbable = mv.climbables.has(b.type);
        return b;
      },
    };
    return mv;
  };

  // ① 默认状态：两条路都没配 → 一个字都不改。
  //    ⚠️ 这是**正确的状态**，不是"没配置所以凑合" —— 原版 id 零位移，梯子本来就该是 196。
  const regDefault = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 4654: { id: 196, name: 'ladder' } },
  };
  const fixDefault = installLadderFix(regDefault, [], {});
  check('默认（两条路都没配）不动注册表', fixDefault.applied, false);
  check('默认状态下 id 保持原版 196', regDefault.blocksByName.ladder.id, 196);
  check('默认状态下给出理由', /不动注册表/.test(fixDefault.reason), true);
  // "不用修"的实质：原版梯子在两层里**本来就认得出来**
  check('原版梯子在库自带那套里本来就 climbable',
    mkMvFromRegistry(regDefault, 4654).getBlock(null, 0, 0, 0).climbable, true);

  // ② 名字路线：模组梯子。名字来自玩家 F3，id 来自服务端 FML 快照 —— 不经过 state。
  const regMod = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: {},   // 模组 state 在原版表里查不到，正是要绕开的场景
  };
  const snap = { 'minecraft:ladder': 196, 'create:ladder': 12345, 'quark:iron_ladder': 6789 };
  const fixName = installLadderFix(regMod, [], { blockNames: ['create:ladder'], nameToId: snap });
  check('名字路线：从快照解析出 id', fixName.resolvedFromNames.join('|'), '12345');
  check('名字路线：真的改了注册表', regMod.blocksByName.ladder.id, 12345);
  check('名字路线：报告 applied', fixName.applied, true);
  check('名字路线：不经过 state，所以没有"查不到"的 state', fixName.unmappedStateIds.length, 0);
  check('名字路线：修完之后库自带那套认得出',
    mkMvFromRegistry(regMod, 12345, 12345).getBlock(null, 0, 0, 0).climbable, true);
  check('名字路线：非梯子方块仍不会被误判',
    mkMvFromRegistry(regMod, 99999, 99999).getBlock(null, 0, 0, 0).climbable, false);

  // ③ 快照还没抓到 → 如实报出名字查不到，不静默、不谎报
  const regNoSnap = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixNoSnap = installLadderFix(regNoSnap, [], { blockNames: ['create:ladder'], nameToId: null });
  check('快照缺失时不谎报成功', fixNoSnap.applied, false);
  check('快照缺失时如实报出查不到的名字', fixNoSnap.unknownBlockNames.join('|'), 'create:ladder');
  check('快照缺失时说明要先连一次服务端', /先连一次/.test(fixNoSnap.reason), true);
  check('快照缺失时 id 一点没动', regNoSnap.blocksByName.ladder.id, 196);

  // ④ 名字解析成原版 196 → 不改。
  //    把"本来就是对的"当成需要修，正是上一轮那个 bug 的形状。
  const regVanillaName = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixVanillaName = installLadderFix(regVanillaName, [], { blockNames: ['minecraft:ladder'], nameToId: snap });
  check('名字解析成原版 196 时不改', fixVanillaName.applied, false);
  check('并且说明"与当前值一致"', /一致/.test(fixVanillaName.reason), true);

  // ⑤ baseline：连改两次，baseline 必须仍是**首次调用前**的值。
  //    `prismarine-registry` 是版本单例，改了会粘住；不单独记 baseline 就会把
  //    "改后"当成"改前"报出去 —— 证据被自己的副作用抹掉。
  const regTwice = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const f1 = installLadderFix(regTwice, [], { blockNames: ['create:ladder'], nameToId: snap });
  const f2 = installLadderFix(regTwice, [], { blockNames: ['quark:iron_ladder'], nameToId: snap });
  check('第一次改：196 → 12345', `${f1.before}→${f1.after}`, '196→12345');
  check('第二次改：12345 → 6789', `${f2.before}→${f2.after}`, '12345→6789');
  check('baseline 两次都报原版 196，没被自己的副作用抹掉',
    `${f1.baseline}|${f2.baseline}`, '196|196');

  // ⑥ state 路线（只在原版方块上可信）
  const regAlready = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 4654: { id: 196, name: 'ladder' } },
  };
  const fixAlready = installLadderFix(regAlready, [4654]);
  check('state 路线解析成原版 id 时不改', fixAlready.applied, false);
  check('并且说明"与当前值一致"', /一致/.test(fixAlready.reason), true);

  const regUn = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixUn = installLadderFix(regUn, [522772]);
  check('模组 state 在原版表查不到时不改注册表', fixUn.applied, false);
  check('但如实报出是哪个 state 查不到', fixUn.unmappedStateIds.join('|'), '522772');
  check('并说明改用 stateId 补丁那一层', /applyClimbables/.test(fixUn.reason), true);

  // ⑦ 两条路同时给：名字优先（它不经过 state），多余的如实报出
  const regMulti = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 5337: { id: 215 }, 6000: { id: 777 } },
  };
  const fixMulti = installLadderFix(regMulti, [5337, 6000], { blockNames: ['create:ladder'], nameToId: snap });
  check('名字优先于 state', fixMulti.after, 12345);
  check('state 路线解析出的 id 也如实报出', fixMulti.resolvedFromStates.join('|'), '215|777');
  check('多余的 id 如实报出而不是悄悄丢', fixMulti.ignoredExtraBlockIds.join('|'), '215|777');

  const fixNull = installLadderFix(null, [5337]);
  check('注册表缺失时不炸、也不谎报成功', fixNull.applied, false);

  // ⑧ probeClimbables 的 baseline 语义：修过注册表之后，仍要说得清"库原本写死的是几"
  const regProbe = {
    blocksByName: { ladder: { id: 215 } },   // 已被改过
    blocksByStateId: { 5337: { id: 215, name: 'crimson_hanging_sign' } },
  };
  const pcAfter = probeClimbables(regProbe, [5337], { baselineLadderId: 196 });
  check('修过之后自检仍报出库原本写死的 id', pcAfter.vanillaLadderId, 196);
  check('修过之后自检报出库此刻在用的 id', pcAfter.libraryLadderId, 215);
  const pcBefore = probeClimbables(
    { blocksByName: { ladder: { id: 196 } }, blocksByStateId: { 5337: { id: 215, name: 'x' } } },
    [5337]
  );
  check('未修时 libraryPathWouldWork 为 false（默认基准取当前值）', pcBefore.libraryPathWouldWork, false);

  // ---- applyUnknownBlockPolicy：未映射方块不能再被当成空气 ----
  // 忠实模仿 prismarine-block 的 else 分支（`index.js:156-164`）。
  // ⚠️ 替身必须把"已映射 / 未映射"和"实心 / 可穿过"当成**两件独立的事** ——
  //    第一版替身把它们揉在一起（mapped ⇒ boundingBox:'block'），于是
  //    "已映射的梯子应保持 empty"这条断言拿到的是 'block'。
  //    是替身不忠实，不是实现有错。（这已经是自测第二次抓到"替身比实现更不真"。）
  const mkMapped = (stateId, boundingBox) => ({
    stateId, type: 42, name: 'stone', boundingBox,
    shapes: boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
  });
  const mkUnknown = (stateId) => ({
    stateId, type: undefined, name: '', boundingBox: 'empty', shapes: [],
  });

  const mkWorld = (map) => ({
    getBlock: (pos) => {
      const k = pos.x + ',' + pos.y + ',' + pos.z;
      return map[k] ? { ...map[k], position: pos } : null;
    },
  });

  const w1 = mkWorld({
    '35,74,-136': mkUnknown(506813),         // cluttered:ancient_codex（模组装饰，实心）
    // ⚠️ 这个坐标曾经被注释成"梯子"。**它其实不是。**
    //    5337 在原版表里是 crimson_hanging_sign（悬挂牌），原版 ladder 的 state 区间是
    //    4654..4661。之前把 5337 当梯子喂给物理层，她"爬上去"是自我实现的预言。
    //    保留这个坐标是为了让这条注释留在代码里，别再犯第二次。
    '34,74,-137': mkMapped(5337, 'block'),
    '33,74,-137': mkMapped(0, 'empty'),      // 空气
  });

  // 先记下"补丁之前"的样子，补丁后比对 —— 比猜一个期望值可靠
  const beforeLadder = JSON.stringify(w1.getBlock({ x: 34, y: 74, z: -137 }));
  const beforeAir = JSON.stringify(w1.getBlock({ x: 33, y: 74, z: -137 }));

  const unkRep = applyUnknownBlockPolicy(w1, { passableStateIds: [] });
  check('未映射策略默认装上补丁', unkRep.patched, true);
  check('未映射策略报告已启用', unkRep.enabled, true);

  const codex = w1.getBlock({ x: 35, y: 74, z: -136 });
  check('未映射方块：boundingBox 从 empty 改成 block', codex.boundingBox, 'block');
  check('未映射方块：拿到完整碰撞箱（物理层才会挡）',
    JSON.stringify(codex.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));

  check('已映射方块一个字节都不动（梯子原样）',
    JSON.stringify(w1.getBlock({ x: 34, y: 74, z: -137 })), beforeLadder);
  check('空气原样（type 是数字 0，不会被误判成未映射）',
    JSON.stringify(w1.getBlock({ x: 33, y: 74, z: -137 })), beforeAir);

  check('isUnknownBlock 认得出未映射方块', isUnknownBlock(codex), true);
  check('isUnknownBlock 不认已映射方块', isUnknownBlock(w1.getBlock({ x: 34, y: 74, z: -137 })), false);
  check('isUnknownBlock 不认空气', isUnknownBlock(w1.getBlock({ x: 33, y: 74, z: -137 })), false);
  check('isUnknownBlock 不炸 null', isUnknownBlock(null), false);
  // ⚠️ 关键回归：补丁给未映射方块填了真名之后，**判据不能失效**。
  //    因为 `world.getBlock` 返回的是缓存里的同一个对象，填过名字之后再读，
  //    `name === ''` 就不成立了 —— 如果 isUnknownBlock 还带着那个条件，
  //    "未映射按实心处理"会在第二次读同一格时静默失效，她又开始穿墙。
  check('填过名字的未映射方块仍被判为未映射（type 才是判据）',
    isUnknownBlock({ type: undefined, name: 'upgrade_aquatic:glass_trapdoor' }), true);

  // ---- needsShapeFallback：调色板注入过的方块也要继续走兜底 ----
  //     注入之后 `b.type` 有值了，`isUnknownBlock` 不再命中；但补丁还兼着
  //     可穿过白名单，不能停。判据是"我们没有它的权威碰撞箱"。
  check('needsShapeFallback 认未映射方块', needsShapeFallback({ type: undefined }), true);
  check('needsShapeFallback 认调色板注入过的方块（有 type、没 boundingBox）',
    needsShapeFallback({ type: 18811, name: 'quark:spruce_ladder', angelInjected: true }), true);
  check('needsShapeFallback 不认原版已映射方块（梯子）',
    needsShapeFallback(w1.getBlock({ x: 34, y: 74, z: -137 })), false);
  check('needsShapeFallback 不认空气', needsShapeFallback(w1.getBlock({ x: 33, y: 74, z: -137 })), false);
  check('needsShapeFallback 不炸 null', needsShapeFallback(null), false);

  // 端到端：注入过的方块照样被补成实心，且白名单照样能放行
  // ⚠️ 本文件的 `check` 是 (label, got, expect) 三参数形式，不是布尔断言。
  const mkInjected = (stateId) => ({
    stateId, type: 18811, name: 'quark:spruce_ladder',
    angelInjected: true, boundingBox: undefined, shapes: undefined,
  });
  {
    const w7 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w7, { passableStateIds: [] });
    const b = w7.getBlock({ x: 1, y: 1, z: 1 });
    check('注入过的方块被补成实心', b.boundingBox, 'block');
    check('注入过的方块拿到完整碰撞箱',
      JSON.stringify(b.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));

    const w8 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w8, { passableStateIds: [24135] });
    check('注入过的方块若在白名单里则保持可穿过',
      w8.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);

    const w9 = mkWorld({ '1,1,1': mkInjected(24135) });
    const rt = new Set([24135]);
    applyUnknownBlockPolicy(w9, { passableStateIds: [], runtimePassable: rt });
    check('运行时白名单（她自己开的门）对注入过的方块也生效',
      w9.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);
    rt.delete(24135);
    check('运行时白名单是**按引用**读的：移出后立刻恢复实心',
      w9.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
  }

  // ---- 形状**已知**（调色板导出了真实碰撞箱）之后的三种走法 ----
  //     这是 2026-09-26 契约反转带来的新分支：以前"注入过 ⇒ 一定没 boundingBox"，
  //     现在"导了形状列 ⇒ 一定有 boundingBox"。白名单必须两条路都能用。
  {
    // 真实形状：3/16 厚的模组梯子（从 dump 里解出来的那种）
    const mkShaped = (stateId) => ({
      stateId, type: 18811, name: 'quark:spruce_ladder', angelInjected: true,
      angelShape: 'static', boundingBox: 'block', shapes: [[0, 0, 0, 0.8125, 1, 1]],
    });

    // ① 形状已知 + 不在白名单 → 一个字都不改（真实形状生效，不再被补成整块）
    const ws1 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rep1 = applyUnknownBlockPolicy(ws1, { passableStateIds: [] });
    const s1 = ws1.getBlock({ x: 1, y: 1, z: 1 });
    check('形状已知：不再被补成整块实心（兜底让位）',
      JSON.stringify(s1.shapes), JSON.stringify([[0, 0, 0, 0.8125, 1, 1]]));
    check('形状已知：没有被标成 thinBlock / lowBlock',
      `${s1.thinBlock || false}/${s1.lowBlock || false}`, 'false/false');
    check('形状已知：白名单放行计数保持 0', rep1.stats.whitelisted, 0);

    // ② 形状已知 + 在白名单里 → **主动**写成空碰撞（不是"什么都不做"）
    const ws2 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rep2 = applyUnknownBlockPolicy(ws2, { passableStateIds: [24135] });
    const s2 = ws2.getBlock({ x: 1, y: 1, z: 1 });
    check('形状已知但在白名单里：被放行', s2.boundingBox, 'empty');
    check('形状已知但在白名单里：碰撞箱被清空（主动写的，不是靠默认值）',
      JSON.stringify(s2.shapes), '[]');
    check('形状已知但在白名单里：留了 whitelisted 痕迹', s2.whitelisted, true);
    check('形状已知但在白名单里：计数上报', rep2.stats.whitelisted, 1);

    // ③ 形状已知 + 运行时白名单（她自己开的门）→ 同样放行，且按引用读
    const ws3 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rt3 = new Set([24135]);
    applyUnknownBlockPolicy(ws3, { passableStateIds: [], runtimePassable: rt3 });
    check('形状已知 + 运行时白名单：放行', ws3.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
    rt3.delete(24135);
    check('形状已知 + 运行时白名单：移出后立刻恢复真实形状',
      JSON.stringify(ws3.getBlock({ x: 1, y: 1, z: 1 }).shapes), JSON.stringify([[0, 0, 0, 0.8125, 1, 1]]));

    // ④ 形状已知 + 名字像薄方块 → **不**因为名字再动一次（形状比名字权威）
    const ws4 = mkWorld({
      '1,1,1': {
        stateId: 24135, type: 18811, name: 'autumnity:maple_pressure_plate',
        angelInjected: true, angelShape: 'static', boundingBox: 'block',
        shapes: [[0, 0, 0, 1, 0.0625, 1]],
      },
    });
    const rep4 = applyUnknownBlockPolicy(ws4, { passableStateIds: [] });
    check('形状已知时不再按名字猜薄方块（真实形状更权威）',
      JSON.stringify(ws4.getBlock({ x: 1, y: 1, z: 1 }).shapes), JSON.stringify([[0, 0, 0, 1, 0.0625, 1]]));
    check('形状已知时不记薄方块豁免', rep4.stats.thinExempt, 0);
  }

  // 名字只补空缺：注册表已经有名字（调色板注入）时，旁路解析器不许覆盖
  {
    const w10 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w10, { passableStateIds: [], nameOf: () => 'WRONG:should_not_win' });
    check('注册表已有名字时，旁路 nameOf 不覆盖它',
      w10.getBlock({ x: 1, y: 1, z: 1 }).name, 'quark:spruce_ladder');
    const w11 = mkWorld({ '1,1,1': mkUnknown(522772) });
    applyUnknownBlockPolicy(w11, { passableStateIds: [], nameOf: () => 'upgrade_aquatic:glass_trapdoor' });
    check('没有名字时才用旁路 nameOf 补',
      w11.getBlock({ x: 1, y: 1, z: 1 }).name, 'upgrade_aquatic:glass_trapdoor');
  }

  // ---- nameOf：用调色板给未映射方块填真名 ----
  const w6 = mkWorld({ '1,1,1': mkUnknown(522772) });
  const nameRep = applyUnknownBlockPolicy(w6, {
    passableStateIds: [],
    nameOf: (sid) => (sid === 522772 ? 'upgrade_aquatic:glass_trapdoor' : null),
  });
  check('nameOf 装上时如实报告', nameRep.nameResolver, true);
  const namedBlock = w6.getBlock({ x: 1, y: 1, z: 1 });
  check('未映射方块被填上真名', namedBlock.name, 'upgrade_aquatic:glass_trapdoor');
  check('填名之后**仍然是实心**（两件事互不干扰）', namedBlock.boundingBox, 'block');
  check('填名之后碰撞箱还在', JSON.stringify(namedBlock.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));
  check('留了 resolvedName 痕迹，可与"注册表本来就有名字"区分', namedBlock.resolvedName, 'upgrade_aquatic:glass_trapdoor');
  check('再次读同一格依然是实心（缓存对象被改过也不失效）',
    w6.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  // nameOf 返回 null（调色板查不到）时不能把名字写成 null
  const w7 = mkWorld({ '2,2,2': mkUnknown(777) });
  applyUnknownBlockPolicy(w7, { passableStateIds: [], nameOf: () => null });
  check('调色板查不到时名字保持空串，不写 null', w7.getBlock({ x: 2, y: 2, z: 2 }).name, '');
  check('调色板查不到时仍按实心处理', w7.getBlock({ x: 2, y: 2, z: 2 }).boundingBox, 'block');

  // nameOf 自己抛异常也不能连累实心策略
  const w8 = mkWorld({ '3,3,3': mkUnknown(888) });
  applyUnknownBlockPolicy(w8, { passableStateIds: [], nameOf: () => { throw new Error('boom') } });
  check('nameOf 抛异常时实心策略仍然生效', w8.getBlock({ x: 3, y: 3, z: 3 }).boundingBox, 'block');
  check('nameOf 抛异常时名字保持空串', w8.getBlock({ x: 3, y: 3, z: 3 }).name, '');
  check('nameOf 抛异常时不炸出补丁外', applyUnknownBlockPolicy(mkWorld({}), { nameOf: 'not a function' }).patched, true);

  // 白名单：确实可穿过的模组方块可以豁免
  const w2 = mkWorld({ '1,1,1': mkUnknown(900001) });
  applyUnknownBlockPolicy(w2, { passableStateIds: [900001] });
  check('白名单里的 state 保持可穿过',
    w2.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');

  // 关掉开关就一个字都不改
  const w3 = mkWorld({ '1,1,1': mkUnknown(900001) });
  const offRep = applyUnknownBlockPolicy(w3, { enabled: false });
  check('关掉时不上补丁', offRep.patched, false);
  check('关掉时说明理由', /MC_UNKNOWN_BLOCK_SOLID/.test(offRep.skipped), true);
  check('关掉时方块保持原样', w3.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');

  // 重连会再装一次，不能套娃
  const w4 = mkWorld({ '1,1,1': mkUnknown(900001) });
  applyUnknownBlockPolicy(w4, { passableStateIds: [] });
  const wrappedOnceUnknown = w4.getBlock;
  const againRep = applyUnknownBlockPolicy(w4, { passableStateIds: [] });
  check('重复安装不会套娃包多层', w4.getBlock === wrappedOnceUnknown, true);
  check('重复安装如实报出已装过', againRep.alreadyPatched, true);
  check('重复安装后依然生效', w4.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  check('world 缺失时不炸', applyUnknownBlockPolicy(null).patched, false);
  check('world.getBlock 缺失时不炸', applyUnknownBlockPolicy({}).patched, false);

  // 运行时白名单：她**自己打开**的那扇活板门，实测穿得过去之后才记进来。
  // 关键：补丁必须**按引用**读这个 Set，不能在安装时拷一份 —— 否则后加的不生效。
  const runtime = new Set();
  const w5 = mkWorld({ '1,1,1': mkUnknown(522772) });
  applyUnknownBlockPolicy(w5, { passableStateIds: [], runtimePassable: runtime });
  check('运行时白名单为空时，未映射方块仍是实心',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
  runtime.add(522772);   // ← 安装**之后**才加进去
  check('安装之后加进运行时白名单，立刻生效（按引用读，不是快照）',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
  runtime.delete(522772);
  check('从运行时白名单移除后立刻恢复实心（所以"猜错了能撤"）',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  // ---- 薄方块豁免：名字像薄方块的，不再补成立方体（2026-09-25）----
  // 现场：厨房唯一的出口前那一格是 `autumnity:maple_pressure_plate`，被补成立方体之后
  // 她纯走 2000ms 只前进 0.2 格就撞停（= 撞在整块立方体上）。玩家：「踏板为什么要跳，直接走」。
  check('薄方块：模组踏板命中', isThinBlockName('autumnity:maple_pressure_plate'), true);
  check('薄方块：模组地毯命中', isThinBlockName('natures_spirit:light_gray_rug'), true);
  check('薄方块：模组按钮命中', isThinBlockName('quark:oak_button'), true);
  check('薄方块：模组花命中', isThinBlockName('biomeswevegone:white_flower'), true);
  check('薄方块：模组告示牌命中', isThinBlockName('quark:spruce_hanging_sign'), true);
  check('薄方块：裸名（无命名空间）也命中', isThinBlockName('torch'), true);
  check('薄方块：不命中模组墙（cluttered:ancient_codex）',
    isThinBlockName('cluttered:ancient_codex'), false);
  // ⚠️ 下面这四条是**故意**不豁免的，谁把它们加进名单都会把这里打红：
  check('薄方块：不命中模组梯子（必须当墙，否则寻路器永远不爬）',
    isThinBlockName('quark:spruce_ladder'), false);
  check('薄方块：不命中模组活板门（要 /activate 打开 + 实测放行）',
    isThinBlockName('upgrade_aquatic:glass_trapdoor'), false);
  check('薄方块：不命中模组台阶（半高，靠 step-up，当可穿过会橡皮筋）',
    isThinBlockName('quark:spruce_slab'), false);
  check('薄方块：不命中模组楼梯（半高，同上）',
    isThinBlockName('quark:spruce_stairs'), false);
  check('薄方块：名字里含 torch 但结尾不是（torchflower）不命中',
    isThinBlockName('minecraft:torchflower'), false);
  check('薄方块：黑名单挡住 chorus_flower（名字像花，其实实心）',
    isThinBlockName('minecraft:chorus_flower'), false);
  check('薄方块：黑名单挡住 mangrove_roots（名字像根，其实实心）',
    isThinBlockName('minecraft:mangrove_roots'), false);
  check('薄方块：空名字 → 保守不豁免', isThinBlockName(''), false);
  check('薄方块：null → 保守不豁免', isThinBlockName(null), false);
  check('薄方块：undefined → 保守不豁免', isThinBlockName(undefined), false);

  // 忠实替身：调色板注入过的模组方块（有 type/name、没有 boundingBox/shapes）
  const mkInjectedNamed = (stateId, name) => ({
    stateId, type: 14989, name, angelInjected: true,
    boundingBox: undefined, shapes: undefined,
  });

  // 端到端：同一批里，认识名字的薄方块放行，不认识名字的仍然实心
  {
    const wt = mkWorld({
      '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate'),
      '2,2,2': mkInjectedNamed(506813, 'cluttered:ancient_codex'),
    });
    const thinRep = applyUnknownBlockPolicy(wt, { passableStateIds: [] });
    check('薄方块豁免默认打开', thinRep.thinPassable, true);
    const plate = wt.getBlock({ x: 1, y: 1, z: 1 });
    check('模组踏板：不再补成立方体', plate.boundingBox, 'empty');
    check('模组踏板：碰撞箱清空（物理层才走得过去）',
      JSON.stringify(plate.shapes), JSON.stringify([]));
    check('模组踏板：留了 thinBlock 痕迹', plate.thinBlock, true);
    check('同一批里的模组墙（不认识的名字）仍然实心',
      wt.getBlock({ x: 2, y: 2, z: 2 }).boundingBox, 'block');
    check('薄方块豁免计数累加', thinRep.stats.thinExempt, 1);
    check('薄方块豁免记下了名字',
      thinRep.stats.thinNames.join(','), 'autumnity:maple_pressure_plate');
    // 补丁改的是缓存里那个对象，再读一次必须还是可穿过
    check('再读同一格仍可穿过（缓存对象也被改了）',
      wt.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
  }

  // 白名单优先于薄方块豁免：白名单是"实测确认过"，薄方块是"按名字猜的"
  {
    const w12 = mkWorld({ '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate') });
    applyUnknownBlockPolicy(w12, { passableStateIds: [520973] });
    check('白名单命中时一个字都不改（保持 undefined，不被改写成 empty）',
      w12.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);
  }

  // 关掉豁免 → 退回老行为（所有模组方块一律实心）
  {
    const w13 = mkWorld({ '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate') });
    const offThin = applyUnknownBlockPolicy(w13, { passableStateIds: [], thinPassable: false });
    check('thinPassable:false 时如实报告', offThin.thinPassable, false);
    check('thinPassable:false 时踏板退回实心',
      w13.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
    check('thinPassable:false 时不记豁免计数', offThin.stats.thinExempt, 0);
  }

  // 名字解析必须发生在**判形状之前** —— 否则薄方块豁免永远看不到名字。
  // 这条钉的是"顺序"，不是"结果"：nameOf 是唯一的名字来源时也要能豁免。
  {
    const w14 = mkWorld({ '3,3,3': mkUnknown(520973) });   // name 是空串
    applyUnknownBlockPolicy(w14, {
      passableStateIds: [],
      nameOf: (sid) => (sid === 520973 ? 'autumnity:maple_pressure_plate' : null),
    });
    const b14 = w14.getBlock({ x: 3, y: 3, z: 3 });
    check('只有旁路 nameOf 提供名字时，薄方块照样被豁免', b14.boundingBox, 'empty');
    check('旁路补的名字同时留下 resolvedName 痕迹',
      b14.resolvedName, 'autumnity:maple_pressure_plate');
  }

  // ---- faceTowardBlock：右键"用"方块时点哪一面 ----
  // 真实场景：活板门在 (34,78,-137)，她在下面（眼睛 y≈77.8）→ 必须点**底面**，
  // 因为顶面朝着屋顶里面，够不着。默认的 (0,1,0) 在这里是错的。
  const tp = { x: 34, y: 78, z: -137 };
  check('从下方够方块 → 点底面',
    faceTowardBlock(tp, { x: 34.5, y: 77.8, z: -136.5 }).join(','), '0,-1,0');
  check('从上方够方块 → 点顶面',
    faceTowardBlock(tp, { x: 34.5, y: 79.6, z: -137.5 }).join(','), '0,1,0');
  check('从西边够方块 → 点西面',
    faceTowardBlock(tp, { x: 33.0, y: 78.5, z: -136.5 }).join(','), '-1,0,0');
  check('从东边够方块 → 点东面',
    faceTowardBlock(tp, { x: 36.0, y: 78.5, z: -137.5 }).join(','), '1,0,0');
  check('从北边够方块 → 点北面',
    faceTowardBlock(tp, { x: 34.5, y: 78.5, z: -139.0 }).join(','), '0,0,-1');
  check('从南边够方块 → 点南面',
    faceTowardBlock(tp, { x: 34.5, y: 78.5, z: -135.0 }).join(','), '0,0,1');
  check('返回的一定是单位法线（三个分量都是 -1/0/1）',
    faceTowardBlock(tp, { x: 40, y: 90, z: -120 }).every(v => v === -1 || v === 0 || v === 1), true);
  // 平手时优先级 Y > X > Z，必须是**可预测**的，不能靠运气
  check('三轴等距时优先 Y 轴',
    faceTowardBlock({ x: 0, y: 0, z: 0 }, { x: 1.5, y: 1.5, z: 1.5 }).join(','), '0,1,0');

  let threw = false;
  try { applyClimbables({ climbables: new Set() }, climbReg, [5337]); } catch (e) { threw = true; }
  check('没给 Movements 实例时明确报错（而不是静默什么都不做）', threw, true);

  console.log('\n[7/8] 单次寻路超时与停滞检测 —— 走 3 格和走 60 格不该用同一个数字');
  // 这一节替代了原来"给整个 HTTP 请求套固定 45s"的做法。要验证三件事：
  //   ① 步长归类的边界是**确定**的（cost 刚好卡在阈值上不能飘）
  //   ② ETA → 超时 的钳制范围正确（再短的路径也不会秒超时，再长的也不会无限等）
  //   ③ 停滞检测分得清"绕路"和"卡住"—— 这是最难也最要紧的一条

  // --- ① 归类
  check('cost=1 判直走', stepKind(1), 'walk');
  check('cost=√2 判直走（对角）', stepKind(Math.SQRT2), 'walk');
  check('cost=1.6 判跳（边界含等于）', stepKind(1.6), 'jump');
  check('cost=1.599 判直走', stepKind(1.599), 'walk');
  check('cost=2.2 判跳空隙', stepKind(2.2), 'parkour');
  check('cost=2.5 判放置', stepKind(2.5), 'place');
  check('cost=4 判挖掘', stepKind(4), 'dig');
  check('cost 无效 → 直走兜底', stepKind(NaN), 'walk');
  check('cost 负数 → 直走兜底', stepKind(-3), 'walk');

  // --- 单步耗时
  check('挖一步按 1800ms（比 HiyoriAI 的 1500 保守）', stepCostMs({ cost: 4 }), 1800);
  check('直走一步 1/5.6 s ≈ 179ms', stepCostMs({ cost: 1 }), Math.round(1000 / 5.6));
  check('跳一步 700ms', stepCostMs({ cost: 1.6 }), 700);

  // --- ② ETA
  check('空路径 → null', estimatePathTimeMs([]), null);
  check('非数组 → null', estimatePathTimeMs(null), null);
  const est10 = estimatePathTimeMs(Array.from({ length: 10 }, () => ({ cost: 1 })));
  check('10 格直走：step 数正确', est10.steps, 10);
  check('10 格直走：breakdown 全记在 walk 上', est10.breakdown.walk === est10.etaMs, true);
  check('10 格直走：jump/place/dig 都是 0',
    est10.breakdown.jump + est10.breakdown.place + est10.breakdown.dig, 0);
  const estMix = estimatePathTimeMs([{ cost: 1 }, { cost: 4 }, { cost: 2.5 }]);
  check('混合路径：合计 = 各段之和',
    estMix.etaMs, estMix.breakdown.walk + estMix.breakdown.dig + estMix.breakdown.place);

  // --- 超时钳制
  check('无路径 → 给最小值（多半会立刻报无路，不必等满）',
    computeTimeoutFromEta(null).timeoutMs, PATH_MIN_TIMEOUT_MS);
  check('无路径 → 标记来源', computeTimeoutFromEta(null).source, 'no-path');
  check('极短路径 → 钳到下界，不会秒超时',
    computeTimeoutFromEta({ etaMs: 1 }).timeoutMs, PATH_MIN_TIMEOUT_MS);
  check('极长路径 → 钳到上界，不会无限等',
    computeTimeoutFromEta({ etaMs: 10 ** 9 }).timeoutMs, PATH_MAX_TIMEOUT_MS);
  check('中等路径 → 按 eta*2+10s 推导',
    computeTimeoutFromEta({ etaMs: 60000 }).timeoutMs, 60000 * 2 + 10000);
  check('推导结果始终是整数', Number.isInteger(computeTimeoutFromEta({ etaMs: 12345.67 }).timeoutMs), true);
  check('可覆盖参数（为将来调参留口）',
    computeTimeoutFromEta({ etaMs: 1 }, { minMs: 5, maxMs: 10, baseMs: 0, grace: 1 }).timeoutMs, 5);
  check('该长就长：60 格远路给的超时明显大于 3 格近路',
    computeTimeoutFromEta(estimatePathTimeMs(Array.from({ length: 60 }, () => ({ cost: 1 })))).timeoutMs
    > computeTimeoutFromEta(estimatePathTimeMs(Array.from({ length: 3 }, () => ({ cost: 1 })))).timeoutMs,
    true);

  // --- 续期的绝对上限（P9 的回归锁）-------------------------------------------
  //
  // 实机 bug：`POST /mine {count:1}` 跑 150 秒不返回，而配置超时是 30 秒。
  // 根因是 watchdog 的续期**没有上限**，而 `path_update` 恰好在卡住时高频触发
  // → 每次重规划都续一次期 → 永远不到期。
  //
  // 这一段的全部意义是：**保证任何一次 goto 一定有尽头**。
  const capShort = computeHardCap(PATH_MIN_TIMEOUT_MS);        // 近路：初始 30s
  const capLong = computeHardCap(PATH_MAX_TIMEOUT_MS);         // 远路：初始 300s

  check('任何初始预算都有有限上限', Number.isFinite(capShort.hardCapMs), true);
  check('上限是正数', capShort.hardCapMs > 0, true);
  check('短预算也有足够余量（≥ 库上限 300s）',
    capShort.hardCapMs >= PATH_MAX_TIMEOUT_MS, true);
  check('长预算的上限不低于短预算（单调）',
    capLong.hardCapMs >= capShort.hardCapMs, true);

  // ⚠️ 最关键的一条：**续期不能把时限无限推远**。
  //    旧代码没有这一层，于是 30 秒的预算能靠续期活到 150 秒以上。
  check('★ 初始 30s 的路径，硬上限**不等于**无穷大（旧代码这里挂了）',
    capShort.hardCapMs !== Infinity && Number.isFinite(capShort.hardCapMs), true);
  check('★ 硬上限是有限的：30s 路径最坏也就 ~300s 结束',
    capShort.hardCapMs <= PATH_MAX_TIMEOUT_MS * 2, true);
  check('硬上限的取值理由可读（便于运维）', /max\(/.test(capShort.reason), true);

  // 边界：非法输入不该算出 NaN/负数（NaN 会让 `Date.now() >= NaN` 恒 false → 又回到"永不超时"）
  check('初始值为 0 → 退回最小值，不产生 NaN',
    Number.isFinite(computeHardCap(0).hardCapMs), true);
  check('初始值为 NaN → 退回最小值，不产生 NaN',
    Number.isFinite(computeHardCap(NaN).hardCapMs), true);
  check('负数 → 退回最小值，不产生负上限',
    computeHardCap(-5000).hardCapMs > 0, true);
  check('可覆盖（供将来调参）',
    computeHardCap(1000, { maxMs: 500, factor: 1 }).hardCapMs, 1000);

  // --- ③ 停滞检测
  const t0 = 1_000_000;
  const O = { x: 0, y: 64, z: 0 };

  // 正常前进：每 5 秒走 3 格 → 永远不判卡
  const mGood = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rGood;
  for (let i = 1; i <= 10; i++) rGood = mGood.sample({ x: i * 3, y: 64, z: 0 }, t0 + i * 5000);
  check('稳步前进 → 多次检查后仍未耗尽', rGood.exhausted, false);
  check('稳步前进 → stagnant 始终为 0', rGood.stagnant, 0);
  check('稳步前进 → 检查次数记满（10 次采样 − 1 次初始化 = 9）', rGood.checks, 9);
  // ⚠️ 注意：上一条用的是**第 10 次**采样的返回值，而第一次采样只做初始化、
  //    不计入 checks。所以 10 次采样 → 9 次检查。这个差一曾让我自己写错期望值。
  check('第一次采样只做初始化，不计检查', (() => {
    const m = createStagnationMonitor(O, { intervalMs: 5000 });
    return m.sample({ x: 0, y: 64, z: 0 }, t0 + 5000).checks;
  })(), 0);

  // 完全不动：连续 3 次检查没动 → 耗尽
  const mStuck = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rStuck;
  for (let i = 1; i <= 4; i++) rStuck = mStuck.sample({ x: 0, y: 64, z: 0 }, t0 + i * 5000);
  check('完全不动 → 第 3 次检查时耗尽', rStuck.exhausted, true);
  check('完全不动 → stagnant 累加', rStuck.stagnant, 3);
  check('完全不动 → 但第 2 次检查还没耗尽（给足 3 次机会）', (() => {
    const m = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
    let r;
    for (let i = 1; i <= 2; i++) r = m.sample({ x: 0, y: 64, z: 0 }, t0 + i * 5000);
    return r.exhausted;
  })(), false);

  // ⚠️ 最要紧的一条：**绕路不算卡住**。
  //    寻路器为了避开障碍绕一大圈是正常行为。如果拿"离起点多远"当判据，
  //    绕路时前进方向改变会被误判成卡死 —— 那就把好的寻路给杀了。
  //    这是 HiyoriAI 用"和上一次采样点比"的原因，我们照抄。
  const mDetour = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  const detour = [
    { x: 3, y: 64, z: 0 },    // 前进
    { x: 3, y: 64, z: 3 },    // 拐弯（离起点更远了，但仍在动）
    { x: 0, y: 64, z: 6 },    // 绕回来（离起点距离没变，但这一步走了 3 格）
    { x: -3, y: 64, z: 6 },   // 继续绕
  ];
  let rDetour;
  detour.forEach((p, i) => { rDetour = mDetour.sample(p, t0 + (i + 1) * 5000); });
  check('绕路（位置回退但每步都在动）→ 不判卡死', rDetour.exhausted, false);
  check('绕路 → stagnant 保持 0', rDetour.stagnant, 0);

  // 没到采样间隔时不检查、不累加 —— 否则高频 sample 会瞬间把计数器打满
  const mFast = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rFast;
  for (let i = 0; i < 50; i++) rFast = mFast.sample({ x: 0, y: 64, z: 0 }, t0 + i * 10);
  check('间隔没到就不检查（高频采样不会打满计数）', rFast.checks, 0);
  check('间隔没到 → 不判耗尽', rFast.exhausted, false);
  check('间隔没到 → due 为 false', rFast.due, false);

  // 抖动：每次只动 0.5 格（< 1.5 阈值）。这是"顶着墙角蹭"的典型形状。
  // 需要 4 次采样：第 1 次只初始化，之后 3 次各累加 1。
  const mJitter = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rJitter;
  for (let i = 1; i <= 4; i++) rJitter = mJitter.sample({ x: i * 0.5, y: 64, z: 0 }, t0 + i * 5000);
  check('微小抖动（每步 0.5 格 < 1.5）→ 判卡死', rJitter.exhausted, true);
  check('微小抖动 → 位置确实在变（不是"没动"，是"动得不够"）', rJitter.travelled, 2);

  // 耗尽之后再真的动起来 → 视为恢复。
  //
  // ⚠️ 这里**刻意不是**一次性闩锁。HiyoriAI 的 `stuckDetector` 有个 `emitted`
  //    闩锁（"只播报一次"），那是为事件流设计的；我们的场景不同：
  //    调用方在 `exhausted` 为真时就会 `stop()`，本来就不会再采样。
  //    万一没停成（比如 stop 抛了）而她又自己挣出来了，继续报"卡死"是错的 ——
  //    那会让她永远放弃一个其实能做成的事。
  const recovered = mJitter.sample({ x: 99, y: 64, z: 0 }, t0 + 5 * 5000);
  check('耗尽后真的大幅移动 → 视为恢复（不是永久闩锁）', recovered.exhausted, false);
  check('恢复后 stagnant 归零', recovered.stagnant, 0);

  check('snapshot 报出来源与阈值，便于事后复盘',
    mJitter.snapshot().maxStagnant, 3);
  check('snapshot 的 bestDistance 是全程最远距离',
    mGood.snapshot().bestDistance, 30);

  console.log('\n[8/8] 自适应采集 —— "附近没有"和"我找不到"必须能区分开');
  // 背景：原来的 /mine 是"64 格内找一次，找不到就报没有"。
  // 于是"矿在 70 格外"和"这里真没矿"对外是同一句话。
  //
  // ⚠️ 最容易写错的一条：终止判据必须用**真正到手的东西数**，
  //    而不是"挖了几格"。挖了石头却没捡到（背包满/被抢/掉岩浆）时，
  //    按挖掉数判会认为有进展 → 她在一个拿不到东西的地方反复挖。

  // --- 半径序列
  check('默认序列从 16 翻倍到 128', buildRadiusLadder().join('|'), '16|32|64|128');
  check('序列长度受 maxSweeps 限制', buildRadiusLadder({ maxSweeps: 2 }).join('|'), '16|32');
  check('初始半径已经等于上限 → 序列只有一个', buildRadiusLadder({ initialRadius: 128, maxRadius: 128 }).join('|'), '128');
  check('初始大于上限 → 也被钳住（不会出现比上限还大的半径）',
    buildRadiusLadder({ initialRadius: 200, maxRadius: 64 }).join('|'), '200');
  check('初始 5、上限 20、最多 6 轮 → 5|10|20（到顶就停，不会重复 20）',
    buildRadiusLadder({ initialRadius: 5, maxRadius: 20, maxSweeps: 6 }).join('|'), '5|10|20');
  check('maxSweeps=1 → 只有初始半径', buildRadiusLadder({ maxSweeps: 1 }).join('|'), '16');
  check('非法输入不产生空序列', buildRadiusLadder({ initialRadius: 0, maxRadius: 0, maxSweeps: 0 }).length >= 1, true);

  // --- 收获判据
  check('真正到手 → 有收获', isProductiveSweep({ gainedItems: 3, brokenBlocks: 3 }).productive, true);
  check('挖了但没到手 → **不算**有收获（这一条是核心）',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).productive, false);
  check('挖了但没到手 → 理由里说得出可能的原因',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).reason.includes('没回头捡'), true);
  // 2026-09-25 补：背包满必须与"没回头捡"分开说 —— 两者处置方式完全不同
  check('背包满 → 理由直指"满"',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5, inventoryFull: true }).reason.includes('满'), true);
  check('背包满 → 与"没回头捡"不是同一句话',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5, inventoryFull: true }).reason
    !== isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).reason, true);
  check('背包满但真到手了 → 仍然算有收获',
    isProductiveSweep({ gainedItems: 2, brokenBlocks: 5, inventoryFull: true }).productive, true);
  check('什么都没挖 → 不算有收获', isProductiveSweep({ gainedItems: 0, brokenBlocks: 0 }).productive, false);
  check('空参数不炸', isProductiveSweep({}).productive, false);
  check('undefined 不炸', isProductiveSweep().productive, false);

  // --- 循环决策
  const ladder = buildRadiusLadder();   // [16,32,64,128]
  check('够了就收工',
    nextCollectStep({ got: 3, wanted: 3, ladder }).action, 'done');
  check('有收获就继续（不扩半径）',
    nextCollectStep({ sweep: 1, hit: true, productive: true, got: 1, wanted: 3, ladder }).action, 'continue');
  check('有收获时给出**当前**半径而不是更大的',
    nextCollectStep({ sweep: 2, hit: true, productive: true, got: 1, wanted: 3, ladder }).radius, 32);
  check('没找到目标 → 扩半径',
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).action, 'widen');
  check('扩到的是序列里的下一个', 
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).radius, 32);
  check('最后一轮还没找到 → 放弃，而不是无限扩',
    nextCollectStep({ sweep: 4, hit: false, productive: false, ladder }).action, 'give-up');
  check('放弃时说明搜到多大',
    nextCollectStep({ sweep: 4, hit: false, productive: false, ladder }).reason.includes('128'), true);
  // ⚠️ 这条区分度最细：**找到了但拿不到** != **没找到**。
  //    前者扩半径没用（问题不是"太远"），后者才有用。
  check('找到了但拿不到 → 不扩半径（扩了也没用）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).action, 'continue');
  // ⚠️⚠️ 这一段是 P2b 的回归锁（实机抓出来的）。
  //    原来这条断言写的是 `reason.includes('拿不到')` —— 它**恰好锁住了那个 bug**：
  //    nextCollectStep 自己写死一句"目标在但拿不到"，把上游分的三类原因全盖掉，
  //    而断言只检查"说了拿不到"，于是**测试替 bug 站岗**，一直绿到实机才暴露。
  //    现在改成验证**原因能透传**：上游说什么，这里就必须说什么。
  const whyFull = isProductiveSweep({ gainedItems: 0, brokenBlocks: 1, inventoryFull: true }).reason;
  const whyNotPicked = isProductiveSweep({ gainedItems: 0, brokenBlocks: 1 }).reason;
  check('上游说"背包满" → 原样透出（不被覆盖）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder, why: whyFull }).reason, whyFull);
  check('上游说"没回头捡" → 原样透出',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder, why: whyNotPicked }).reason, whyNotPicked);
  check('两种原因**不共用**一句文案（P2 的全部意义）', whyFull !== whyNotPicked, true);
  check('透出的理由能看出是"满"还是"没捡"',
    /满/.test(nextCollectStep({ hit: true, ladder, why: whyFull }).reason), true);
  check('没传 why 时不假装知道原因（给出显式的"未上报"）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).reason.includes('未上报'), true);
  check('没传 why 也**绝不会**再写死那句旧的"拿不到"',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).reason.includes('拿不到'), false);
  check('没找到才扩半径（对比上一条）',
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).action, 'widen');

  console.log('\n[7/7] 寻路目标的清理契约 —— "超时后必须清干净"（field-log P25）');
  //
  // 为什么要有这一节：这是**唯一一个"代码全对、自测全绿、实机全废"的 bug**。
  // `/pickup` 和 `sweepUpDrops` 都用了 `Promise.race([goto(...), sleep(...)])`，
  // 逻辑上完全正确 —— 问题出在 race 输掉后的**收尾**没人做。
  // 这类 bug 没法靠"给函数喂不同输入看返回值"抓到，只能把**契约**本身做成断言。
  const fakePf = () => {
    const calls = { stop: 0, setGoal: [] };
    return {
      calls,
      stop () { calls.stop++; },
      setGoal (g) { calls.setGoal.push(g); },
    };
  };

  const pf1 = fakePf();
  check('清理会调 stop()', (() => { clearPathfinderGoal(pf1); return pf1.calls.stop; })(), 1);
  check('清理也会调 setGoal(null)', pf1.calls.setGoal.length, 1);
  check('setGoal 的参数确实是 null（不是 undefined）', pf1.calls.setGoal[0], null);
  check('返回 true 表示确实清理了', clearPathfinderGoal(fakePf()), true);

  // ⚠️ 两个都要调，缺一个都不够 —— 只 stop 会让下轮 goto 继续抛
  //    "goal was changed"，只 setGoal(null) 会留下正在跑的路径。
  const pfOnlyStop = { stop () {}, setGoal () { throw new Error('boom'); } };
  check('setGoal 抛错也不影响 —— 清理失败不能升级成任务失败', clearPathfinderGoal(pfOnlyStop), true);
  const pfDead = { get stop () { throw new Error('no pf'); }, get setGoal () { throw new Error('no pf'); } };
  check('pathfinder 整个不可用时不抛异常', clearPathfinderGoal(pfDead), false);
  check('传 null 也不抛（bot 未连接时会出现）', clearPathfinderGoal(null), false);
  check('传 undefined 也不抛', clearPathfinderGoal(undefined), false);

  // 反例锁 ①：不能再退回去用"不会结束的目标 + 超时"这个组合。
  // `GoalFollow` 的 `isEnd()` 要求"进入 range 且视线可达"，
  // 掉落物被自己挖的坑挡住视野时永不成立 —— 配上超时就是必然走满超时。
  //
  // 反例锁 ②（更重要的那条）：**清理不能发生在 goto 之后。**
  // `setGoal(null)` 会 emit `goal_updated(null)`，如果下一个 goto 已经
  // 注册好 listener 在等，它收到 null 就报 GoalChanged —— 实测 0ms 内失败，
  // 地上 1.4 格的掉落物一个都捡不到。清理只允许出现在"无人等待"的时刻。
  const src = require('fs').readFileSync(__filename, 'utf8');
  check('P25 反例锁：catch 块里不会再出现裸的 goto 重试',
    /catch \(_\) \{[^}]*goto\(/.test(src), false);
  check('clearPathfinderGoal 有独立实现（不是散落的 stop+setGoal）',
    /function clearPathfinderGoal/.test(src), true);
  check('clearPathfinderGoal 确实同时做了 stop 与 setGoal(null)',
    /pf\.stop\(\);[\s\S]{0,120}pf\.setGoal\(null\)/.test(src), true);

  // ---- P25 的**行为**回归：用假的 bot 复现"清理时机"的两种写法 --------------
  //
  // 上面那些是源码形状锁（`grep` 级），只能防"改回去"，
  // 不能证明"现在这个写法是对的"。这一段把 `goto.js` 的判定逻辑**照搬**过来，
  // 让两种时序真跑一遍，看结果差在哪。
  //
  // 为什么要照搬而不是 import：`goto.js` 需要一个真的 mineflayer bot 实例。
  // 而这里要验的是**时序**，不是寻路 —— 一个 EventEmitter 就够。
  const EventEmitter = require('events');

  // ⚠️ 这一段是**异步**的（要跑真的事件时序），而自测主体是同步的。
  //    不能直接在顶层 `await`（CommonJS 里没有 top-level await），
  //    所以把场景串成 promise 链，最后在 `.then()` 里收尾退出。
  //
  // 模型要点（第一版模型错了，记下来）：
  //   · 清理必须是**异步触发**的（`setTimeout`）才能复现 —— 因为真实的
  //     `withTimeout` 就是定时器到点才清。同步清的话，下一个 goto 的
  //     listener 还没注册，打不到它，现象反而是"两边都挂着"。
  //   · 一旦改成异步，`setGoal(null)` 就会精准落在"某个 goto 已注册 listener
  //     并在等"的窗口里 → 那个 goto 立刻报 GoalChanged。
  //     实测抛错栈：`at Object.setGoal → at Timeout._onTimeout` ——
  //     罪魁就是这个**定时器里的 setGoal**。

  /** 极简版 goto()：判定逻辑与 mineflayer-pathfinder/lib/goto.js 一致 */
  function fakeGoto (bot, goal) {
    return new Promise((resolve, reject) => {
      function cleanup (err) {
        bot.removeListener('goal_reached', onReached);
        bot.removeListener('goal_updated', onChanged);
        setTimeout(() => (err ? reject(err) : resolve()), 0);
      }
      function onReached () { cleanup(); }
      function onChanged (newGoal) {
        // ★ P25 的核心：newGoal 为 null 时不等于 goal → 立刻报错
        if (newGoal !== goal) {
          const e = new Error('The goal was changed before it could be completed!');
          e.name = 'GoalChanged';
          cleanup(e);
        }
      }
      bot.on('goal_reached', onReached);
      bot.on('goal_updated', onChanged);
      bot.emit('goal_updated', goal, false);   // 等价于 setGoal(goal) 的 emit
    });
  }

  const mkBot = () => {
    const b = new EventEmitter();
    b.pathfinder = {
      goal: null,
      stop () {},
      setGoal (g) { b.pathfinder.goal = g; b.emit('goal_updated', g, false); },
    };
    return b;
  };
  const mkGoal = () => ({ constructor: { name: 'GoalNear' } });
  const settle = (p, ms) => Promise.race([
    p.then(() => 'resolved', e => 'rejected:' + e.name),
    new Promise(r => setTimeout(() => r('STILL-WAITING'), ms)),
  ]);

  // 场景 A（**错的**写法）：`withTimeout` 到点自己清
  //   → `setGoal(null)` 落在"goalA 还在等"的窗口里 → 打死它
  const scenarioWrong = () => {
    const bot = mkBot();
    const pA = fakeGoto(bot, mkGoal());
    return new Promise(resolve => {
      setTimeout(() => {
        bot.pathfinder.setGoal(null);   // ← 我第一版的 cleanup()
        resolve();
      }, 15);
    }).then(() => settle(pA, 30)).then(outcome => {
      check('★ 复现：定时器里清 goal → 正在等的 goto 报 GoalChanged（这就是 0ms 失败）',
        outcome, 'rejected:GoalChanged');
    });
  };

  // 场景 B（**对的**写法）：只在发起 goto **之前**清
  //   → 清的时候无人等待，安全
  const scenarioRight = () => {
    const bot = mkBot();
    const run = async () => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        bot.pathfinder.setGoal(null);           // ← 开始之前清（安全）
        const p = fakeGoto(bot, mkGoal());
        setImmediate(() => bot.emit('goal_reached'));
        out.push(await settle(p, 40));
      }
      return out;
    };
    return run().then(out => {
      check('★ 正确写法：连续 3 个目标全部正常完成',
        out.every(r => r === 'resolved'), true);
    });
  };

  check('模组床是矮方块（9/16 高）', lowBlockHeight('handcrafted:oak_fancy_bed'), 0.5625);
  check('床头柜之类不是', lowBlockHeight('handcrafted:oak_nightstand'), 0);
  // ---- 开着的门能走、关着的门和活板门不变；门板两侧都通时**不当能穿门板放行** ----
  // ⚠️ 用一个**按坐标取方块**的假世界。上一版把 `dx` 当字典键用，所以"读邻格"那条判据
  //    根本走不到（邻格恒为 undefined）—— 自测测不到真代码，等于没测。
  {
    const key = (x, y, z) => `${x},${y},${z}`;
    const makeMv = (cells) => {
      const map = new Map(cells);
      return {
        map,
        getBlock (pos, dx, dy, dz) {
          const d = map.get(key(pos.x + dx, pos.y + dy, pos.z + dz));
          const name = d ? d.name : 'minecraft:air';
          const solid = d ? d.solid !== false : false;
          const props = { open: d && d.open ? 'TRUE' : 'false' };
          if (d && d.facing !== undefined) props.facing = d.facing;
          const b = {
            name,
            getProperties: () => props,
            boundingBox: solid ? 'block' : 'empty',
            safe: !solid,
            physical: solid,
            height: pos.y + dy,
          };
          return b;
        },
      };
    };
    const door = (facing, open = true) => ({ name: 'minecraft:dark_oak_door', open, facing, solid: true });
    const wall = { name: 'minecraft:stone', solid: true };
    const air = { name: 'minecraft:air', solid: false };
    const at = (mv) => mv.getBlock({ x: 0, y: 64, z: 0 }, 0, 0, 0);

    // ⚠️ `stats` 只在 `getBlock` **真的被调用**时才累加（寻路器问一次才记一笔）。
    //    所以凡是断言计数的用例，都必须先自己调一次 `at(mv)` 触发，且**只调一次** ——
    //    写成 `${at(mv).safe}/${at(mv).physical}` 会把同一条断言算成两次，计数对不上。
    {
      // 门嵌在墙里（facing=south → 门板法线是 X → 看 (0,64,±1)）：常态，必须放行
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', wall], ['-1,64,0', wall]]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('门嵌在墙里：开着的门放行（safe/physical）', `${b.safe}/${b.physical}`, 'true/false');
      check('门嵌在墙里：放行计数 1、拒绝 0', `${rep.stats.passed}/${rep.stats.refused}`, '1/0');
    }
    {
      // 独立门：门板法线轴两侧都是通路 → 寻路器会规划出"穿门板"，保守当墙
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', air], ['-1,64,0', air]]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('门板两侧都通：不放行（还是墙）', `${b.safe}/${b.physical}`, 'false/true');
      check('门板两侧都通：记下拒绝与轴', `${rep.stats.refused}/${rep.stats.refusedAt[0]?.axis}`, '1/x');
    }
    {
      // 只有一侧是墙 → 横穿不可能 → 放行
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', air], ['-1,64,0', wall]]);
      applyOpenDoors(mv);
      check('只有一侧是墙：放行（横穿不可能）', at(mv).safe, true);
    }
    {
      // facing=east → 门板法线是 Z：X 两侧通也不该拦
      const mv = makeMv([
        ['0,64,0', door('east')], ['1,64,0', air], ['-1,64,0', air],
        ['0,64,1', wall], ['0,64,-1', wall],
      ]);
      applyOpenDoors(mv);
      check('facing=east：看法线轴 Z，X 两侧通不拦', at(mv).safe, true);
    }
    {
      // 同一个门把 Z 两侧也打通 → 该拦
      const mv = makeMv([
        ['0,64,0', door('east')], ['1,64,0', air], ['-1,64,0', air],
        ['0,64,1', air], ['0,64,-1', air],
      ]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('facing=east：Z 两侧都通 → 拦下', `${b.safe}/${b.physical}/${rep.stats.refused}`, 'false/true/1');
    }
    {
      const mv = makeMv([
        ['0,64,0', door('south', false)],                                                     // 关着的门
        ['2,64,0', { name: 'minecraft:oak_trapdoor', open: true, facing: 'south', solid: true }],
        ['4,64,0', { name: 'mcwdoors:garage_door', open: true, facing: 'south', solid: true }],
        ['5,64,0', wall], ['3,64,0', wall],
      ]);
      applyOpenDoors(mv);
      check('关着的门：还是墙', `${at(mv).safe}/${at(mv).physical}`, 'false/true');
      check('活板门不归它管',
        mv.getBlock({ x: 2, y: 64, z: 0 }, 0, 0, 0).physical, true);
      check('模组的门（名字以 _door 结尾）也认',
        mv.getBlock({ x: 4, y: 64, z: 0 }, 0, 0, 0).safe, true);
      const g1 = mv.getBlock;
      const again = applyOpenDoors(mv);
      check('重复装不会套娃', mv.getBlock === g1, true);
      check('重复装时把原来的 stats 一起报回来', again.stats === mv.__openDoorsStats, true);
    }
    {
      // 读不到 facing（模组门可能用别的属性名）：保持放行 —— 不能退回"门里出不去"
      const mv = makeMv([['0,64,0', { name: 'mod:odd_door', open: true, solid: true }], ['1,64,0', air], ['-1,64,0', air]]);
      const rep = applyOpenDoors(mv);
      check('读不到 facing：保持放行', at(mv).safe, true);
      check('读不到 facing：单独计数（"读不到"不混进"没有"）', rep.stats.noFacing, 1);
    }
  }

  scenarioWrong()
    .then(scenarioRight)
    .then(() => {
      console.log(`\n  ${pass}/${total} 通过`);
      process.exit(pass === total ? 0 : 1);
    })
    .catch(e => {
      console.log(`\n  自测自身出错：${e.message}`);
      process.exit(1);
    });
}

module.exports = {
  bareName,
  isProtected,
  PROTECTED_PATTERNS,
  COSTS,
  ALLOW_DIG,
  buildProtectedIds,
  applyPolicy,
  probeRegistry,
  summarizeProbe,
  CLIMBABLE_STATE_IDS,
  parseIdList,
  parseNameList,
  resolveClimbableIds,
  resolveClimbableBlockIds,
  applyClimbables,
  applyOpenDoors,
  lowBlockHeight,
  probeClimbables,
  installLadderFix,
  UNKNOWN_BLOCK_SOLID,
  PASSABLE_STATE_IDS,
  FULL_CUBE,
  EMPTY_SHAPES,
  isUnknownBlock,
  needsShapeFallback,
  THIN_BLOCK_PASSABLE,
  THIN_BLOCK_SUFFIXES,
  THIN_BLOCK_DENY,
  isThinBlockName,
  applyUnknownBlockPolicy,
  faceTowardBlock,
  LIQUID_NAMES,
  MAX_VERTICAL_FLOW_LOOKAHEAD,
  assessExcavationFluidRisk,
  isFlowPassable,
  injectFluidBreakGuard,
  PATH_STEP_MS,
  SPRINT_SPEED,
  PATH_MIN_TIMEOUT_MS,
  PATH_MAX_TIMEOUT_MS,
  PATH_PROGRESS_INTERVAL_MS,
  PATH_STAGNATION_THRESHOLD,
  MAX_STAGNANT_CHECKS,
  clearPathfinderGoal,
  stepKind,
  stepCostMs,
  estimatePathTimeMs,
  computeTimeoutFromEta,
  computeHardCap,
  createStagnationMonitor,
  COLLECT_SEARCH,
  buildRadiusLadder,
  isProductiveSweep,
  nextCollectStep,
};
