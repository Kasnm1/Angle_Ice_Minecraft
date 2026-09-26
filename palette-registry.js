/**
 * palette-registry.js —— 把「方块调色板」**真正注入** prismarine 的注册表。
 *
 * ## 为什么必须有这一步（这才是"为什么读不到方块信息"的根因）
 *
 * `prismarine-block` 的构造函数（`node_modules/prismarine-block/index.js:125`）是：
 *
 *     const blockEnum = registry.blocksByStateId[this.stateId]
 *     if (blockEnum) {
 *       this.type = blockEnum.id          // ← 方块注册表 id
 *       this.name = blockEnum.name        // ← 真实方块名
 *       this.boundingBox = blockEnum.boundingBox
 *       ...
 *     } else {
 *       this.name = ''
 *       this.shapes = []
 *       this.boundingBox = 'empty'
 *       // ⚠️ 注意：**不覆盖 this.type**，所以它保持 fromStateId 传进来的 undefined
 *     }
 *
 * 而 1.13+ 的 `Block.fromStateId(stateId, biomeId)` 就是
 * `new Block(undefined, biomeId, 0, stateId)` —— type 本来就是 undefined。
 *
 * → **注册表里没有的 state，`b.type` 永远是 `undefined`。**
 *
 * 后果不止"名字是空的"：
 *
 * 1. **梯子的两层判据都读 `block.type`**：
 *    `prismarine-physics/index.js` 在构造时取 `blocksByName.ladder.id` 存成
 *    一个数字，然后判 `block.type === ladderId`；`mineflayer-pathfinder` 的
 *    `movements.climbables` 同理。所以**光配 `MC_CLIMBABLE_BLOCK_NAME` 没用** ——
 *    它只把那个数字换成模组梯子的注册表 id，而 `block.type` 是 `undefined`，
 *    永远不等于任何数字。**必须先有调色板，梯子配置才开始有意义。**
 * 2. `boundingBox='empty'` → 客户端以为能穿过去（已由 `applyUnknownBlockPolicy`
 *    的"未映射一律实心"兜住）。
 *
 * 所以调色板**不能只当旁路查表**（只喂 `GET /block` 和名字解析器）。必须写回
 * `registry.blocksByStateId`。写回之后：
 *
 *   · `b.type` / `b.name` / `b._properties`（属性）全部自动正确；
 *   · 属性解码是**免费的** —— `Block` 构造函数会用我们塞进去的 `states` 做
 *     混合进制展开，不必自己写；
 *   · `MC_CLIMBABLE_BLOCK_NAME` 从"空操作"变成"真的生效"。
 *
 * ## 与原版数据的分工（重要）
 *
 * `minecraft-data` 只提供**原版布局基线**：1003 个方块、24135 个 state。
 * 这个整合包会给少数原版方块扩展属性值，实测原版尾界变成 `25019`，所以不能再
 * 用固定 `0..24134` 判断原版/模组，也不能直接按 dump 的 `first` 去旧表反查。
 *
 * 安全校验按原版 block registry id 对齐：名字必须一致，`first` 必须等于本地基线
 * 加前面已验证的累计扩容，dump 的 count 只能增加不能减少。通过后，原版 state
 * 区间会 overlay 到共享注册表，模组区间也会写入注册表；这样 `b.type`、`b.name`
 * 和属性才与本地整合包一致。`registry/block-palette.json` 这种连续但错位的历史
 * 反例仍会被 F3 锚点拒绝。
 *
 * ## 与"未映射一律实心"策略的关系
 *
 * 注入之后 `b.type` 有值了，`pathing.js` 里那个补丁的判据 `type === undefined`
 * 就不再命中 —— 但补丁还负责**可穿过白名单**（她自己开的门/活板门），不能停。
 *
 * ## 碰撞形状：dump 给了就填，没给才退回按名字猜
 *
 * 名字和属性告诉不了 `pathing.js`「这一格挡不挡人」。调色板最初只有名字和属性，
 * 于是模组方块只能**按名字猜**形状（薄方块白名单 → 可穿过；`_bed` → 9/16；
 * 其余 → 整块实心），整合包里大量非整格方块（家具、模组台阶/楼梯/栅栏/地毯/路径块…）
 * 全被猜错 —— 那才是"卡在门口出不去"的根，`lowBlockHeight` 只是补丁。
 *
 * 现在 dump 多导一列**逐 state 碰撞箱**（`block-palette.js` 的 `encodeShapes`）。
 * 有这一列、且整块都能用的时候，注入的记录带三个字段：
 *
 *   · `shapes`      = 默认 state 的形状（`minecraft-data` 的同一约定）
 *   · `stateShapes` = 逐 state 形状，`prismarine-block` 用 `metadata` 索引它
 *   · `boundingBox` = 有任一 state 有碰撞 → `'block'`，否则 → `'empty'`
 *     （实测 `minecraft-data` 的 1003 个原版方块里，这条规则只对 `snow` 有 1 处例外）
 *
 * 于是 `pathing.js` 的 `needsShapeFallback` 不再命中，`applyUnknownBlockPolicy`
 * 只做它真正该做的事（白名单），**按名字猜形状的那几条自动退居兜底**。
 *
 * ⚠️ 旧的 5 列 dump（没有形状列）**照旧工作**：`entry.shapes === null` →
 *    一个形状字段都不填 → `needsShapeFallback` 命中 → 走原来的按名字猜。
 *    向后兼容是硬要求：没有形状数据时，宁可保守，也不要假装知道。
 *
 * ⚠️ **条数对不上 `count`、或有一个 state 读不到 → 整块不填。**
 *    错位一格比"没有"更糟；"有一个 state 不知道"意味着这一块不能当权威。
 *
 * ⚠️ 这是**原契约的反转**。老契约是"注入的记录故意不填 `boundingBox`，
 *    谁填了白名单就静默失效"。新契约是"**有形状就填、没形状才不填**"。
 *    兜底的判据本身没变（`needsShapeFallback` 仍然只看 `boundingBox === undefined`），
 *    变的只是"什么时候会出现 `undefined`"。
 *
 * 记录上另带 `angelInjected: true`（`clearInjected` 认自己的东西）、
 * `angelShape`（`'static'` 有形状 / `'absent'` 没导 / `'unusable'` 导了但不可用 /
 * `'base'` 沿用 minecraft-data），都只用于调试与上报，判据里**没有**它们。
 *
 * ## 形状"不能由单个 state 静态决定"的方块
 *
 * 逐 state 导出对**绝大多数**方块是完整的 —— 包括看起来最像"要看邻居"的那几类：
 * 栅栏 / 墙 / 铁栏 / 玻璃板的连接状态**本身就是 block state 属性**
 * （`north`/`south`/`east`/`west`/`up`）。实测 `oak_fence` 32 个 state → 16 种形状、
 * `iron_bars` 32 → 16、`cobblestone_wall` 324 → 32（其中一种就是**空碰撞**：
 * 孤立的一根柱子）。所以这几类不存在"邻居读不到"的问题。
 *
 * 真正静态决定不了的，原版用 `BlockBehaviour.Properties.dynamicShape()` 标出来。
 * 反汇编客户端 srg jar 的 `Blocks.<clinit>`，1.20.1 只有 **6 处**注册：
 *
 * | 方块 | 类 | 为什么静态决定不了 |
 * |---|---|---|
 * | `shulker_box`（含 16 色） | `ShulkerBoxBlock` | 开合由**方块实体**驱动，开着时碰撞会缩 |
 * | `moving_piston` | `MovingPistonBlock` | 只在活塞推动的**那一瞬**存在，形状跟着方块实体走 |
 * | `bamboo` | `BambooStalkBlock` | 形状要看**下面那格**（是不是竹子） |
 * | `scaffolding` | `ScaffoldingBlock` | `bottom` 属性由**下面那格**推导 |
 * | `powder_snow` | `PowderSnowBlock` | 碰撞取决于**踩上去的实体**（人会陷进去） |
 * | `pointed_dripstone` | `PointedDripstoneBlock` | 形状要看**上方/下方**的滴水石 |
 *
 * 处理办法：**照导不误，并标记出来**（原版记录上带 `angelShapeDynamic: true`，
 * `/config` 里单独报个数）。理由是静态采样得到的形状对这几个方块是**保守的那一侧**：
 * 关着的潜影盒 / 未伸出的活塞 / 单根竹子 / 未连接的脚手架 / 没被踩入的细雪 /
 * 孤立的滴水石，碰撞都不小于动态时的最小值。宁可多绕一步，也不要穿模。
 * 想更精确只能运行时按方块实体改形状 —— 那是寻路层的事，不是调色板的事。
 *
 * ⚠️ 模组方块**拿不到**这个标记 —— 模组不会把 `dynamicShape()` 导出来，没有任何
 *    权威依据可查。所以对模组方块只有"静态采样 + 保守"这一条。名字后缀撞上的
 *    （`kaleidoscope_cookery:chair_bamboo`、`sophisticatedstorage:iron_shulker_box`…）
 *    只记在 `angelShapeDynamicGuessed` 里，与上面那个**权威**计数分开报 ——
 *    把"按名字猜的"混进"有依据的"，数字就没法解释了。
 * 残余风险与边界写在 `registry/README.md` 的「形状这一列的边界」一节。
 *
 * ## 刻意不做的事
 *
 * 不给注入的方块填 `hardness` / `diggable` —— 填了就是**改变行为**（能不能挖），
 * 而调色板对这两件事并不权威。碰撞形状**已经**由 dump 提供（见上），
 * 所以它从"刻意不做"的名单里移出去了。
 */

/** 本地 minecraft-data 1.20.1 的原版基线：1003 个方块、24135 个 state。 */
const VANILLA_BLOCK_COUNT = 1003;
const VANILLA_STATE_TOTAL = 24135;

/**
 * 形状**不能由单个 state 静态决定**的方块 —— 原版用 `dynamicShape()` 标出来的那 6 处。
 *
 * 反汇编客户端 srg jar 的 `Blocks.<clinit>` 实测（`Properties.dynamicShape()` 的
 * SRG 名是 `m_60988_`，全表只有 6 个调用点）：`ShulkerBoxBlock`（shulker_box 及 16 色）、
 * `MovingPistonBlock`、`BambooStalkBlock`、`ScaffoldingBlock`、`PowderSnowBlock`、
 * `PointedDripstoneBlock`。理由逐条见文件头。
 *
 * ⚠️ **只用于标记，不改变"填不填形状"的决定。** 静态采样对它们是保守值，
 *    比"因为不精确就整块不填、退回按名字猜"要好得多（后者会把细雪猜成整块实心）。
 * ⚠️ 用正则而不是集合：`white_shulker_box` … 16 色都要命中。
 * ⚠️ **必须排除 `potted_*`**：原版 `potted_bamboo` 的名字以 `_bamboo` 结尾，但它的形状
 *    来自 `FlowerPotBlock`（静态），**不在**那 6 个 `dynamicShape()` 调用点里 ——
 *    实测端到端演练时它被误标了（`/config` 里 shapeDynamic 虚高 1）。花盆一律排除。
 */
const DYNAMIC_SHAPE_RE =
  /^(?!potted_)(?:[a-z_]+_)?(?:shulker_box|moving_piston|bamboo|scaffolding|powder_snow|pointed_dripstone)$/;

/**
 * 模组方块里名字**后缀撞上**上面那几个词的（`…_bamboo`、`…_shulker_box`、`…_scaffolding`）。
 *
 * 这些**没有任何权威依据**，只是"说不定也是动态形状，标记一下别当已知"。实测整合包里
 * 撞上的 22 个全是普通家具/箱子（bamboo 材质的椅子桌子、储存模组的潜影盒…），
 * 形状其实是静态的 —— 所以它只能进 `angelShapeDynamicGuessed`，不能进权威计数。
 */
const DYNAMIC_SHAPE_GUESS_RE =
  /(?:^|[_:])(?:shulker_box|moving_piston|bamboo|scaffolding|powder_snow|pointed_dripstone)$/;

/**
 * **锚点**：玩家 F3 直接读出来的 `方块 → state id` 真值。
 *
 * 为什么必须有它 —— 只靠"连续性 + 原版交叉校验"**拦不住**错表：
 * `registry/block-palette.json`（jar 反推产物）的原版部分是抄自 minecraft-data 的
 * （所以正确），整张表也严格连续（0 断点），可是模组部分从某个方块起累计偏移就错了
 * （`glass_trapdoor` 报 base 239686，真值 **522768**，差 28 万位）。
 * 那种表"看起来完美"，光看结构检查是发现不了的。
 *
 * 锚点是唯一能钉住**模组区间**的证据，因为它来自游戏本身。
 * 判据：锚点的 stateId 必须落在该方块的 `[first, first + count)` 里。
 * 差一位就说明这份 dump 的累计偏移错了 → 整份拒绝。
 *
 * 新增锚点的办法：让玩家在她站的地方按 F3，报出 `方块名` 和 `state id`，
 * 然后加进 `MC_PALETTE_ANCHORS`（格式 `blockId=stateId,blockId=stateId`）。
 * **锚点越多越硬**，而且它们互相独立 —— 一个锚点只能证明"它前面那一段的和"对了。
 */
const DEFAULT_ANCHORS = [
  // ⚠️ 加/删/升级模组后方块 state 会整体平移，锚点必须重测（ADD-MODS-REBUILD.md 第 5 节）。
  // 2026-09-26 加机械动力后重测：不用 F3，直接取服务端区块数据里的真实 state（她出生点附近的自然地形），
  // 用新调色板反查译名与地形吻合才采用（旧调色板把同一批 state 译成悬空的石墙/楼梯）。
  // natures_spirit:tall_oat_grass 下半株（half=lower 是第 1 个 state），(-27,128,-19)；上面 y=129 正好是 219728（上半株）
  { blockId: 4439, stateId: 219729, name: 'natures_spirit:tall_oat_grass' },
  // natures_spirit:orange_maple_leaves，(17,128,25)，一棵树上 229072–229084 一簇
  { blockId: 4776, stateId: 229072, name: 'natures_spirit:orange_maple_leaves' },
  // 旧锚点（加机械动力之前，玩家 F3 实测）：cluttered:ancient_codex 14286=506805、upgrade_aquatic:glass_trapdoor 15061=522768 —— 已过期
];

/** 解析 `MC_PALETTE_ANCHORS`：`14286=506805,15061=522768` → 锚点数组。 */
function parseAnchors (raw) {
  if (raw === undefined || raw === null) return DEFAULT_ANCHORS.slice();
  const out = [];
  for (const tok of String(raw).split(',')) {
    const t = tok.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    // ⚠️ `Number('') === 0` —— 不显式挡空串的话，`5=` 会被当成"方块 5 的 state 0"，
    //    一个手滑的配置就变成一个**看起来合法**的锚点，然后默默把好表拒掉。
    const left = t.slice(0, i).trim();
    const right = t.slice(i + 1).trim();
    if (!left || !right) continue;
    const blockId = Number(left);
    const stateId = Number(right);
    if (!Number.isInteger(blockId) || !Number.isInteger(stateId)) continue;
    out.push({ blockId, stateId, name: null });
  }
  return out;
}

/**
 * 拿锚点校验调色板。返回 `{checked, violations, missing}`。
 * 锚点**没被覆盖到**（调色板里没这个方块）不算违规，只记一笔 —— 但要报出来，
 * 免得"一个锚点都没验上"被当成"全过了"。
 */
function checkAnchors (index, anchors) {
  const out = { checked: 0, violations: [], missing: [] };
  if (!index || !index.sorted) return out;
  for (const a of anchors || []) {
    const hit = index.sorted.find(e => e.blockId === a.blockId);
    if (!hit) {
      if (out.missing.length < 8) out.missing.push({ blockId: a.blockId, name: a.name });
      continue;
    }
    out.checked++;
    if (!(a.stateId >= hit.first && a.stateId < hit.first + hit.count)) {
      out.violations.push({
        blockId: a.blockId,
        name: hit.name,
        anchorStateId: a.stateId,
        dumpRange: [hit.first, hit.first + hit.count - 1],
        offBy: a.stateId - hit.first,
      });
    }
  }
  return out;
}

/**
 * 归一化方块名以便比较。
 *
 * ⚠️ **必须做这一步，否则一份完全正确的 dump 会被误拒。**
 * 客户端 dump 写的是 `String(entry.getKey().location())` = `minecraft:air`
 * （`ResourceLocation` 一定带命名空间），而 `minecraft-data` 里原版方块的
 * `name` 是**裸名** `air`、`stone`、`ladder` —— 不带 `minecraft:` 前缀。
 * 直接比字符串会 1003 条全部"对不上"。
 *
 * 注入时**保留** dump 里的全名（模组方块只有全名才不歧义），只在这里比较时归一化。
 */
function normName (n) {
  const s = String(n ?? '');
  return s.startsWith('minecraft:') ? s.slice('minecraft:'.length) : s;
}

/** 上一次注入写进注册表的东西，换 dump 时要先清干净，不留幽灵。 */
let lastInjection = null;

/**
 * 把 dump 里的属性规格转成 `prismarine-block` 需要的 `states` 形状。
 *
 * `propValue` 的取值规则（`prismarine-block/index.js:410`）：
 *     if (state.type === 'enum' || state.values) return state.values[value]
 *     if (state.type === 'bool') return !value
 *     return value
 * 我们**总是给 `values`**，所以走第一条 —— 返回的字符串与 dump 里写的
 * 取值列表**逐字一致**，是 MC 全局 state id 编号的忠实逆运算。
 *
 * ⚠️ 但 `values` 是字符串会踩一个坑：`_properties.waterlogged` 会是字符串
 *    `'false'`，而**字符串 'false' 是真值** —— `prismarine-physics:629` 的
 *    `if (block.isWaterlogged) return 0` 就会误判成"泡在水里"。
 *    所以纯布尔属性要还原成**真布尔**。
 */
function toStateProps (props) {
  const out = [];
  for (const p of props || []) {
    if (!p || !p.key || !p.values || !p.values.length) continue;
    const allBool = p.values.every(v => v === 'true' || v === 'false');
    out.push({
      name: p.key,
      type: allBool ? 'bool' : 'enum',
      num_values: p.values.length,
      values: allBool ? p.values.map(v => v === 'true') : p.values.slice(),
    });
  }
  return out;
}

/**
 * 从调色板的一条记录算出要写进注册表的碰撞字段。
 *
 * 返回 `null` = **一个字段都不写**（调用方让 `needsShapeFallback` 命中，退回按名字猜）。
 * 只有下面全部成立才写：
 *   · `entry.shapes` 是**非空数组**，且条数**恰好等于** `entry.count`（错位一格比没有更糟）
 *   · 每一个 state 的形状都**知道**（`Array.isArray`）—— 有一个"读不到"就不拿这一块当权威
 *
 * `boundingBox` 的规则照抄 `minecraft-data`：有任一 state 有碰撞 → `'block'`，否则 `'empty'`。
 * 这条规则在本地 1003 个原版方块上只对 `snow` 有 1 处例外（`snow` 是 `'empty'` 却有
 * 1/8–1 格高的碰撞），属于上游数据的小毛病，不影响寻路的安全侧。
 *
 * @returns {{shapes: number[][], stateShapes: number[][][], boundingBox: 'block'|'empty'}|null}
 */
function shapeFieldsFor (entry) {
  const shapes = entry && entry.shapes;
  if (!Array.isArray(shapes) || !shapes.length) return null;
  if (shapes.length !== entry.count) return null;
  for (const s of shapes) if (!Array.isArray(s)) return null;
  return {
    // `shapes` 是"默认 state 的形状"，和 minecraft-data 的约定一致；
    // 真正逐 state 生效的是 `stateShapes`（prismarine-block 用 metadata 索引它）。
    shapes: shapes[0],
    stateShapes: shapes,
    boundingBox: shapes.some(s => s.length > 0) ? 'block' : 'empty',
  };
}

/**
 * 把形状字段盖到一条记录上，并如实标出这一块的形状是从哪来的。
 *
 * @param {boolean} authoritative 这个名字有没有**权威依据**判"形状动态"。
 *   原版方块传 `true`（能反汇编出那 6 个 `dynamicShape()` 调用点）；
 *   模组方块只能传 `false` —— 它的 `dynamicShape()` 没有导出，任何判断都是按名字猜的。
 *   两种标记**分开存**（`angelShapeDynamic` / `angelShapeDynamicGuessed`），
 *   上报时也分开数，免得"有依据的"和"按名字猜的"混成一个没法解释的数字。
 * @returns {boolean} 是否真的填了形状
 */
function applyShapeFields (rec, entry, authoritative = false) {
  const shape = shapeFieldsFor(entry);
  if (!shape) {
    rec.angelShape = !entry || entry.shapes === undefined
      ? 'absent'          // 旧 dump：根本没导这一列
      : 'unusable';       // 导了，但条数对不上 / 有 state 读不到
    return false;
  }
  rec.shapes = shape.shapes;
  rec.stateShapes = shape.stateShapes;
  rec.boundingBox = shape.boundingBox;
  rec.angelShape = 'static';
  const bare = normName(entry.name);
  if (authoritative) {
    if (DYNAMIC_SHAPE_RE.test(bare)) rec.angelShapeDynamic = true;
  } else if (DYNAMIC_SHAPE_GUESS_RE.test(bare)) {
    rec.angelShapeDynamicGuessed = true;
  }
  return true;
}

/** 由调色板的一条记录造一个方块记录（一个方块**共用一个对象**，不是每个 state 一个）。 */
function buildRecord (entry) {
  const rec = {
    id: entry.blockId,
    name: entry.name,
    displayName: entry.name,
    minStateId: entry.first,
    maxStateId: entry.first + entry.count - 1,
    states: toStateProps(entry.props),
    // 实心策略补丁认这个标记：见 pathing.js 的 needsShapeFallback
    angelInjected: true,
  };
  // 有形状就填 → `needsShapeFallback` 不再命中 → 不再按名字猜；
  // 没形状就不填 → 兜底照旧（旧 dump 的行为一个字节都不变）。
  // ⚠️ `authoritative = false`：模组方块的名字没有权威依据可判"形状动态"。
  applyShapeFields(rec, entry, false);
  return rec;
}

/**
 * 用 dump 的 state 布局覆盖一条原版注册表记录，但保留 minecraft-data 提供的
 * 挖掘、掉落等运行时字段。整合包会给少数原版方块增加属性值；如果还把
 * 原版记录留在旧 state 区间，后面的所有 state 都会被翻译成错误方块。
 */
function buildVanillaOverlayRecord (base, entry) {
  const rec = { ...base };
  rec.id = entry.blockId;
  // prismarine-registry 的原版 blocksByName 使用裸名；dump 使用 minecraft: 前缀。
  rec.name = base.name;
  rec.displayName = base.displayName;
  rec.minStateId = entry.first;
  rec.maxStateId = entry.first + entry.count - 1;
  rec.states = toStateProps(entry.props);
  rec.angelInjected = true;
  rec.angelVanillaOverlay = true;
  if (applyShapeFields(rec, entry, true)) return rec;
  // 没有可用的形状列 → 沿用 minecraft-data 的碰撞字段。
  // 但 stateShapes 来自**旧布局**，扩容后 metadata 不再与它一一对应；
  // 让 Block 使用该方块的默认 shapes，而不是把新 state 错配到旧 stateShapes 的任意一格。
  if (entry.count !== (base.maxStateId - base.minStateId + 1)) delete rec.stateShapes;
  return rec;
}

function stateCount (rec) {
  if (!rec || rec.minStateId == null || rec.maxStateId == null) return null;
  return rec.maxStateId - rec.minStateId + 1;
}

function vanillaRecords (registry) {
  return Object.values(registry?.blocks || {})
    .filter(Boolean)
    .filter(b => Number.isInteger(b.id) && b.id >= 0 && b.id < VANILLA_BLOCK_COUNT)
    .filter(b => Number.isInteger(b.minStateId) && Number.isInteger(b.maxStateId))
    .sort((a, b) => a.id - b.id);
}

/**
 * 清掉上一次注入。换一份 dump（或自测收尾）时用，避免旧记录的幽灵。
 * 会恢复被 overlay 覆盖的原版 state，而不是简单 delete；否则换回旧表后会留下
 * 半张 shifted vanilla registry。
 * @returns {number} 清掉/恢复的 state 槽位数
 */
function clearInjected (registry) {
  if (!registry || !lastInjection) return 0;
  const byStateId = registry.blocksByStateId;
  const byId = registry.blocks;
  const byName = registry.blocksByName;
  let n = 0;
  for (const r of lastInjection.ranges || []) {
    for (let s = r.first; s < r.first + r.count; s++) {
      const current = byStateId && byStateId[s];
      if (current !== r.assigned) continue;
      const previous = lastInjection.previousState?.get(s);
      if (previous === undefined) delete byStateId[s];
      else byStateId[s] = previous;
      n++;
    }
  }
  for (const rec of lastInjection.records || []) {
    if (byId && byId[rec.id] === rec.assigned) {
      const previous = lastInjection.previousById?.get(rec.id);
      if (previous === undefined) delete byId[rec.id];
      else byId[rec.id] = previous;
    }
    if (byName && byName[rec.name] === rec.assigned) {
      const previous = lastInjection.previousByName?.get(rec.name);
      if (previous === undefined) delete byName[rec.name];
      else byName[rec.name] = previous;
    }
  }
  lastInjection = null;
  return n;
}

/**
 * 把调色板注入注册表。
 *
 * @param {object} registry `prismarine-registry('1.20.1')` 或 `bot.registry`
 *   （两者是**同一个对象**，见 SKILL.md；所以离线导入、重连后依然有效）
 * @param {object} index `block-palette.js` 的 `buildIndex()` 产物
 * @param {{vanillaStateTotal?: number, anchors?: Array, commit?: boolean}} [opts]
 *   `anchors` 默认用 `DEFAULT_ANCHORS`（玩家 F3 的实测真值）。传 `[]` 可显式跳过。
 *   `commit:false` 只做完整校验，不修改注册表；用于 bot.registry 尚未创建时的离线预检。
 * @returns {{ok: boolean, reason: string|null, blocks: number, states: number,
 *            vanillaChecked: number, vanillaMismatches: Array, vanillaMissing: Array,
 *            anchorsChecked: number, anchorViolations: Array, anchorMissing: Array,
 *            cleared: number, samples: Array,
 *            shapeBlocks: number, shapeStates: number,
 *            shapeAbsent: number, shapeUnusable: number,
 *            shapeDynamic: number, shapeDynamicGuessed: number}}
 */
function injectPalette (registry, index, opts = {}) {
  const vanillaTotal = opts.vanillaStateTotal ?? VANILLA_STATE_TOTAL;
  const anchors = opts.anchors === undefined ? DEFAULT_ANCHORS : opts.anchors;
  const report = {
    ok: false,
    reason: null,
    blocks: 0,
    states: 0,
    overlayBlocks: 0,
    overlayStates: 0,
    totalBlocks: 0,
    totalStates: 0,
    vanillaChecked: 0,
    vanillaMismatches: [],
    vanillaMissing: [],
    vanillaExpanded: 0,
    vanillaStateEnd: null,
    duplicateBlockIds: 0,
    anchorsChecked: 0,
    anchorViolations: [],
    anchorMissing: [],
    cleared: 0,
    samples: [],
    // 形状列到底带来了多少真实碰撞箱（这是"兜底该不该让位"的唯一正面证据）
    shapeBlocks: 0,        // 填上了真实形状的方块数（原版 overlay + 模组）
    shapeStates: 0,        // 填上了真实形状的 state 数
    shapeAbsent: 0,        // 没导这一列（旧 dump）
    shapeUnusable: 0,      // 导了但不可用（条数对不上 / 有 state 读不到）
    shapeDynamic: 0,       // 形状"静态决定不了"的，**原版、有权威依据**（反汇编出的那 6 类）
    shapeDynamicGuessed: 0,// 模组方块里名字后缀撞上那几个词的（**按名字猜的，无依据**）
  };

  if (!registry || !registry.blocksByStateId) {
    report.reason = 'registry.blocksByStateId 不可用';
    return report;
  }
  if (!index || !index.sorted || !index.sorted.length) {
    report.reason = '调色板为空';
    return report;
  }
  if (index.gaps > 0) {
    report.reason = `调色板不连续（${index.gaps} 处断点）—— 整张表会错位`;
    return report;
  }

  const byStateId = registry.blocksByStateId;
  const byId = registry.blocks || {};
  const byName = registry.blocksByName || {};
  // 重复导入发生在同一进程时，registry.blocks 里已经有 overlay 记录；优先
  // 使用首次注入前保存的 pristine vanilla 记录，避免把 shifted first 当新基线。
  const localVanilla = lastInjection?.baseVanillaRecords || vanillaRecords(registry);
  const vanillaIds = new Set(localVanilla.map(b => b.id));
  const dumpById = new Map();
  for (const e of index.sorted) {
    if (dumpById.has(e.blockId)) report.duplicateBlockIds++;
    else dumpById.set(e.blockId, e);
  }
  if (report.duplicateBlockIds) {
    report.reason = `调色板含 ${report.duplicateBlockIds} 个重复 blockId，拒绝注入`;
    return report;
  }

  // ---- 1. 以 blockId 对齐原版，再按累计扩容计算预期 first。 ----
  // 不能再用 byStateId[e.first] 反查：整合包扩展一个原版方块后，后续所有
  // vanilla first 都会漂移，旧 state 表里的那个位置已经属于别的方块。
  const vanillaEntries = [];
  let drift = 0;
  for (const base of localVanilla) {
    const e = dumpById.get(base.id);
    report.vanillaChecked++;
    if (!e) {
      if (report.vanillaMissing.length < 8) {
        report.vanillaMissing.push({ blockId: base.id, name: base.name });
      }
      continue;
    }
    const localCount = stateCount(base);
    const expectedFirst = base.minStateId + drift;
    const nameOk = normName(base.name) === normName(e.name);
    const firstOk = e.first === expectedFirst;
    const countOk = localCount !== null && e.count >= localCount;
    if (!nameOk || !firstOk || !countOk) {
      if (report.vanillaMismatches.length < 20) {
        report.vanillaMismatches.push({
          blockId: base.id,
          first: e.first,
          dump: { name: e.name, count: e.count },
          registry: { name: base.name, first: base.minStateId, count: localCount },
          expectedFirst,
          why: [nameOk ? null : '名字', firstOk ? null : '起始 state', countOk ? null : 'state 个数不足']
            .filter(Boolean).join('+'),
        });
      }
    }
    vanillaEntries.push({ base, entry: e, localCount, expectedFirst });
    if (countOk) {
      if (e.count > localCount) report.vanillaExpanded++;
      drift += e.count - localCount;
    }
  }
  if (report.vanillaMissing.length || report.vanillaChecked !== localVanilla.length) {
    report.reason = `原版方块不完整（检查 ${report.vanillaChecked}/${localVanilla.length}，` +
      `缺少 ${report.vanillaMissing.length} 条）—— 拒绝注入`;
    return report;
  }
  if (report.vanillaMismatches.length) {
    report.reason = `原版布局校验失败（${report.vanillaMismatches.length} 处对不上）` +
      ' —— 名字必须一致，first 必须匹配累计扩容，count 只能增加；拒绝注入';
    return report;
  }
  const lastVanilla = vanillaEntries[vanillaEntries.length - 1];
  report.vanillaStateEnd = lastVanilla.entry.first + lastVanilla.entry.count;
  report.totalStates = index.totalStates;

  // 原版/模组分界使用本地 vanilla blockId 集合，而不是固定 24135。
  const modded = index.sorted.filter(e => !vanillaIds.has(e.blockId));
  const firstModded = modded.length ? modded[0].first : null;
  if (!modded.length) {
    report.reason = '这份 dump 里没有模组方块，不能建立完整的模组注册表';
    return report;
  }
  if (firstModded !== report.vanillaStateEnd) {
    report.reason = `模组区间起点 ${firstModded} 与原版尾界 ${report.vanillaStateEnd} 不连续，拒绝注入`;
    return report;
  }

  // ---- 2. 用玩家 F3 的锚点钉住模组区间累计偏移。 ----
  const anchor = checkAnchors(index, anchors);
  report.anchorsChecked = anchor.checked;
  report.anchorViolations = anchor.violations;
  report.anchorMissing = anchor.missing;
  if (anchor.violations.length) {
    report.reason = `锚点校验失败（${anchor.violations.length} 个 F3 实测 stateId 落不到对应方块的区间里）` +
      ' —— 这份 dump 的累计偏移错了，拒绝注入';
    return report;
  }

  // ---- 3. 离线预检只验证，不碰任何注册表槽位。 ----
  if (opts.commit === false) {
    report.validationOnly = true;
    report.ok = true;
    return report;
  }

  // ---- 4. 清掉上一次注入，并保存所有被覆盖的旧槽位。 ----
  report.cleared = clearInjected(registry);
  const previousState = new Map();
  const previousById = new Map();
  const previousByName = new Map();
  const ranges = [];
  const records = [];

  const assign = (entry, rec, nameKey) => {
    for (let s = entry.first; s < entry.first + entry.count; s++) {
      const previous = byStateId[s];
      if (previous !== undefined && !previousState.has(s)) previousState.set(s, previous);
      byStateId[s] = rec;
    }
    if (byId[rec.id] !== undefined && !previousById.has(rec.id)) previousById.set(rec.id, byId[rec.id]);
    byId[rec.id] = rec;
    if (byName && nameKey) {
      if (byName[nameKey] !== undefined && !previousByName.has(nameKey)) previousByName.set(nameKey, byName[nameKey]);
      byName[nameKey] = rec;
    }
    ranges.push({ first: entry.first, count: entry.count, assigned: rec });
    records.push({ id: rec.id, name: nameKey || rec.name, assigned: rec });
    // 形状统计：只看"这一块最终有没有权威形状"，不看 dump 有没有那一列。
    if (rec.angelShape === 'static') {
      report.shapeBlocks++;
      report.shapeStates += entry.count;
      if (rec.angelShapeDynamic) report.shapeDynamic++;
      if (rec.angelShapeDynamicGuessed) report.shapeDynamicGuessed++;
    } else if (rec.angelShape === 'absent') report.shapeAbsent++;
    else if (rec.angelShape === 'unusable') report.shapeUnusable++;
  };

  // 先覆盖整合包真实的 vanilla state 布局，保证扩容后的原版方块不再错译。
  for (const { base, entry } of vanillaEntries) {
    const rec = buildVanillaOverlayRecord(base, entry);
    assign(entry, rec, base.name);
    report.overlayBlocks++;
    report.overlayStates += entry.count;
  }

  // 再写入模组方块：dump 有形状就用真实形状，没有才继续交给 pathing 的实心兜底。
  for (const e of modded) {
    const rec = buildRecord(e);
    assign(e, rec, rec.name);
    report.blocks++;
    report.states += e.count;
    if (report.samples.length < 5) {
      report.samples.push({
        id: rec.id, name: rec.name, first: e.first, count: e.count, shape: rec.angelShape || null,
      });
    }
  }

  report.totalBlocks = report.overlayBlocks + report.blocks;
  lastInjection = {
    ranges,
    records,
    previousState,
    previousById,
    previousByName,
    baseVanillaRecords: localVanilla,
  };
  report.ok = true;
  return report;
}

/** 上一次注入的摘要（给 `/palette`、`/config` 用）。没有就返回 null。 */
function lastInjectionSummary () {
  if (!lastInjection) return null;
  return { blocks: lastInjection.records.length, ranges: lastInjection.ranges.length };
}

// ---------------------------------------------------------------- 自测

function selftest () {
  let pass = 0; let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
  };

  const registry = require('prismarine-registry')('1.20.1');
  const Block = require('prismarine-block')(registry);
  const palette = require('./block-palette.js');
  const base = vanillaRecords(registry).map(b => ({ ...b }));

  ok('前置：本地原版基线是 1003 个方块', base.length === VANILLA_BLOCK_COUNT, base.length);
  ok('前置：本地原版 state 总数是 24135',
    base[base.length - 1].maxStateId + 1 === VANILLA_STATE_TOTAL,
    base[base.length - 1].maxStateId + 1);
  ok('前置：24135 在未注入注册表中未知', registry.blocksByStateId[24135] === undefined);

  const oakProps = palette.parsePropSpec(
    'distance:1,2,3,4,5,6,7,8,9,10,11,12,13,14;' +
    'persistent:true,false;waterlogged:true,false'
  );
  const modProps = palette.parsePropSpec('facing:north,south,west,east;waterlogged:true,false');

  function makeEntries ({ expandedOak = 28, expandedTail = 856, withMod = true } = {}) {
    let cursor = 0;
    const out = [];
    for (const b of base) {
      const localCount = stateCount(b);
      const extra = b.id === 82 ? expandedOak : (b.id === 1002 ? expandedTail : 0);
      const count = localCount + extra;
      out.push({
        blockId: b.id,
        first: cursor,
        count,
        name: `minecraft:${b.name}`,
        props: b.id === 82 ? oakProps : [],
      });
      cursor += count;
    }
    if (withMod) {
      out.push({ blockId: 1003, first: cursor, count: 8, name: 'quark:spruce_ladder', props: modProps });
      out.push({ blockId: 1004, first: cursor + 8, count: 1, name: 'quark:decorative_block', props: [] });
    }
    return out;
  }

  const entries = makeEntries();
  const index = palette.buildIndex(entries);
  ok('合成整合包布局连续', index.gaps === 0, index.gapList);
  ok('合成整合包原版尾界为 25019', entries[1002].first + entries[1002].count === 25019,
    entries[1002].first + entries[1002].count);
  ok('合成表在原版扩容后仍有模组区间', entries[1003].first === 25019, entries[1003].first);

  // ---- 1. 全量 overlay：允许合法原版扩容，并把模组 state 写入注册表 ----
  const injected = injectPalette(registry, index, { anchors: [] });
  ok('合法扩容调色板注入成功', injected.ok === true, injected.reason);
  ok('原版校验完整覆盖 1003 个方块', injected.vanillaChecked === 1003, injected.vanillaChecked);
  ok('识别到 2 个原版扩容方块', injected.vanillaExpanded === 2, injected.vanillaExpanded);
  ok('原版 overlay 写入 1003 个方块', injected.overlayBlocks === 1003, injected.overlayBlocks);
  ok('原版 overlay 覆盖 25019 个 state', injected.overlayStates === 25019, injected.overlayStates);
  ok('模组区写入 2 个方块', injected.blocks === 2, injected.blocks);
  ok('模组区写入 9 个 state', injected.states === 9, injected.states);
  ok('报告的原版尾界是 25019', injected.vanillaStateEnd === 25019, injected.vanillaStateEnd);
  ok('报告的总 state 数与索引一致', injected.totalStates === index.totalStates, injected.totalStates);

  const oak = Block.fromStateId(237, 0);
  const oakEnd = Block.fromStateId(292, 0);
  const spruce = Block.fromStateId(293, 0);
  ok('扩容后的 oak_leaves 覆盖 237..292',
    oak.name === 'oak_leaves' && oakEnd.name === 'oak_leaves', `${oak.name}/${oakEnd.name}`);
  ok('扩容后的后继 state 293 正确指向 spruce_leaves', spruce.name === 'spruce_leaves', spruce.name);
  ok('扩容方块属性可读且是布尔值',
    oak._properties.distance === '1' && oak._properties.persistent === true && oak._properties.waterlogged === true,
    JSON.stringify(oak._properties));
  ok('扩容方块的 waterlogged=false 可读',
    Block.fromStateId(238, 0)._properties.waterlogged === false);

  const modState = entries[1003].first;
  const mod = Block.fromStateId(modState, 0);
  ok('模组 state 有真实名字', mod.name === 'quark:spruce_ladder', mod.name);
  ok('模组 state 有真实方块 id', mod.type === 1003, mod.type);
  ok('模组 state 属性可读', mod._properties.facing === 'north' && mod._properties.waterlogged === true,
    JSON.stringify(mod._properties));
  // ⚠️ 这一条钉的是**旧 dump 的行为**（没有形状列）。有形状列时相反 —— 见下面 3b。
  ok('没导形状列时，模组 state 保留未知碰撞箱标记，交给实心策略',
    mod.boundingBox === undefined, mod.boundingBox);
  ok('没导形状列时如实标成 absent', registry.blocksByStateId[modState].angelShape, 'absent');

  // ---- 2. 重复注入必须基于 pristine vanilla，而不是上一轮 shifted overlay ----
  const injectedAgain = injectPalette(registry, index, { anchors: [] });
  ok('重复注入仍然成功', injectedAgain.ok === true, injectedAgain.reason);
  ok('重复注入先清掉旧 state', injectedAgain.cleared > 0, injectedAgain.cleared);
  ok('重复注入后仍能读到 shifted spruce_leaves',
    Block.fromStateId(293, 0).name === 'spruce_leaves');

  // ---- 3. 清理必须恢复原始注册表，而不是只删除模组段 ----
  const cleared = clearInjected(registry);
  ok('清理恢复了被 overlay 的 state 槽位', cleared >= 25019, cleared);
  ok('清理后模组 state 再次未知', registry.blocksByStateId[modState] === undefined);
  ok('清理后模组名字索引没有幽灵', registry.blocksByName['quark:spruce_ladder'] === undefined);
  ok('清理后原版 oak 回到旧区间',
    registry.blocksByName.oak_leaves.minStateId === 237 && registry.blocksByName.oak_leaves.maxStateId === 264);
  ok('清理后 293 回到原版 spruce 之外的旧布局',
    Block.fromStateId(293, 0).name === 'birch_leaves');

  // ---- 3b. 形状列：有就填真实碰撞箱，按名字猜的那几条自动退居兜底 ----
  //     这是**契约反转**的正面证据。老契约"注入的记录故意不填 boundingBox"，
  //     新契约"有形状就填、没形状才不填"。两条都要钉住（3b 钉前者，上面第 1 节钉后者）。
  {
    const shaped = makeEntries();
    const ladder = shaped.find(e => e.name === 'quark:spruce_ladder');
    const deco = shaped.find(e => e.name === 'quark:decorative_block');
    // 梯子 8 个 state：偶数 state 有 3/16 厚的板，奇数 state 空碰撞
    ladder.shapes = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? [[0, 0, 0, 0.8125, 1, 1]] : []));
    deco.shapes = [[[0, 0, 0, 1, 1, 1]]];
    const rep = injectPalette(registry, palette.buildIndex(shaped), { anchors: [] });
    ok('带形状列的调色板注入成功', rep.ok === true, rep.reason);
    ok('报告 2 个方块带形状', rep.shapeBlocks === 2, rep.shapeBlocks);
    ok('报告 9 个 state 带形状', rep.shapeStates === 9, rep.shapeStates);
    ok('报告里没有"导了但不可用"', rep.shapeUnusable === 0, rep.shapeUnusable);
    ok('原版 overlay 那 1003 条如实标成"没导形状列"', rep.shapeAbsent === 1003, rep.shapeAbsent);

    const lad0 = Block.fromStateId(ladder.first, 0);
    const lad1 = Block.fromStateId(ladder.first + 1, 0);
    ok('模组梯子 state0 拿到逐 state 形状（3/16 厚）',
      JSON.stringify(lad0.shapes) === JSON.stringify([[0, 0, 0, 0.8125, 1, 1]]), JSON.stringify(lad0.shapes));
    ok('模组梯子 state1 是**空碰撞**（"知道没有"，不是"不知道"）',
      Array.isArray(lad1.shapes) && lad1.shapes.length === 0, JSON.stringify(lad1.shapes));
    ok('模组梯子 boundingBox = block（有 state 有碰撞）', lad0.boundingBox, 'block');
    ok('模组整格方块拿到整格碰撞箱',
      JSON.stringify(Block.fromStateId(deco.first, 0).shapes) === JSON.stringify([[0, 0, 0, 1, 1, 1]]),
      JSON.stringify(Block.fromStateId(deco.first, 0).shapes));
    ok('有形状的记录标着 angelShape=static',
      registry.blocksByStateId[ladder.first].angelShape, 'static');
    ok('原版 overlay 没形状列时仍沿用 minecraft-data 的碰撞箱（没被清空）',
      Block.fromStateId(0, 0).boundingBox, 'empty');

    clearInjected(registry);
    ok('清理后形状字段随记录一起消失', registry.blocksByStateId[ladder.first] === undefined);
  }

  // ---- 3c. 形状列不可用时必须整块不填（宁可退回按名字猜） ----
  {
    const partial = makeEntries();
    const ladder = partial.find(e => e.name === 'quark:spruce_ladder');
    ladder.shapes = Array.from({ length: 8 }, () => [[0, 0, 0, 1, 1, 1]]);
    ladder.shapes[3] = null;                       // 有一个 state 读不到
    const r1 = buildRecord(ladder);
    ok('有一个 state 读不到 → 整块不填 boundingBox', r1.boundingBox === undefined, r1.boundingBox);
    ok('并如实标成 unusable', r1.angelShape, 'unusable');

    const short = makeEntries();
    const s2 = short.find(e => e.name === 'quark:spruce_ladder');
    s2.shapes = [[[0, 0, 0, 1, 1, 1]]];            // 只有 1 条，count 是 8
    ok('条数对不上 count → 整块不填', buildRecord(s2).boundingBox === undefined);

    const old = makeEntries();
    const r3 = buildRecord(old.find(e => e.name === 'quark:spruce_ladder'));
    ok('旧 5 列 dump（shapes 是 undefined）→ 不填且标成 absent',
      r3.boundingBox === undefined && r3.angelShape === 'absent', r3.angelShape);

    const empt = makeEntries();
    const s4 = empt.find(e => e.name === 'quark:spruce_ladder');
    s4.shapes = [];                                 // 空数组：不算"知道"
    ok('shapes 是空数组 → 不填', buildRecord(s4).boundingBox === undefined);
  }

  // ---- 3d. 原版 overlay：dump 的形状比 minecraft-data 更权威 ----
  {
    const over = makeEntries();
    // 把 air（blockId 0，原版 count 1）改成"整块实心" —— 只为验证 dump 能盖过 base
    const airEntry = over.find(e => e.blockId === 0);
    airEntry.shapes = [[[0, 0, 0, 1, 1, 1]]];
    const rep = injectPalette(registry, palette.buildIndex(over), { anchors: [] });
    ok('原版 overlay 也吃 dump 的形状', rep.shapeBlocks === 1, rep.shapeBlocks);
    const air = Block.fromStateId(airEntry.first, 0);
    ok('overlay 后 air 的碰撞箱来自 dump 而不是 minecraft-data',
      JSON.stringify(air.shapes) === JSON.stringify([[0, 0, 0, 1, 1, 1]]) && air.boundingBox === 'block',
      `${JSON.stringify(air.shapes)}/${air.boundingBox}`);
    clearInjected(registry);
    ok('清理后 air 回到 minecraft-data 的空碰撞',
      Block.fromStateId(0, 0).boundingBox === 'empty', Block.fromStateId(0, 0).boundingBox);
  }

  // ---- 3e. 形状"静态决定不了"的原版方块要**标记**出来，不是不填 ----
  //     反汇编 Blocks.<clinit> 实测 1.20.1 只有 6 处 dynamicShape()。
  //     ⚠️ 模组方块只能**按名字猜**，标记与权威标记分开存、分开报。
  {
    // 原版（有权威依据）：走 buildVanillaOverlayRecord 那条路 → authoritative = true
    const mkVan = (name, shapes) => buildVanillaOverlayRecord(
      { id: 1, name, displayName: name, minStateId: 0, maxStateId: shapes.length - 1, states: [] },
      { blockId: 1, first: 0, count: shapes.length, name: 'minecraft:' + name, props: [], shapes });
    // 模组（按名字猜）：走 buildRecord → authoritative = false
    const mkMod = (name, shapes) => buildRecord(
      { blockId: 1, first: 0, count: shapes.length, name, props: [], shapes });

    const box = mkVan('white_shulker_box', [[[0, 0, 0, 1, 1, 1]]]);
    ok('潜影盒被标成动态形状', box.angelShapeDynamic, true);
    ok('动态形状**照样填**（静态采样是保守值，比退回按名字猜好）', box.boundingBox, 'block');
    ok('竹子也被标记', mkVan('bamboo', [[[0, 0, 0, 1, 1, 1]]]).angelShapeDynamic, true);
    ok('脚手架/细雪/滴水石/被推的活塞都认',
      ['scaffolding', 'powder_snow', 'pointed_dripstone', 'moving_piston']
        .every(n => mkVan(n, [[[0, 0, 0, 1, 1, 1]]]).angelShapeDynamic === true));
    ok('普通方块不标', mkVan('stone', [[[0, 0, 0, 1, 1, 1]]]).angelShapeDynamic === undefined);
    // `potted_bamboo` 名字以 `_bamboo` 结尾，但形状来自 FlowerPotBlock（静态）。
    // 端到端演练实测被误标过一次，这条断言钉住它。
    ok('potted_bamboo 不误标（花盆形状是静态的）',
      mkVan('potted_bamboo', [[[0, 0, 0, 1, 1, 1]]]).angelShapeDynamic === undefined);
    // 模组：只能猜，进另一个字段
    const modBamboo = mkMod('some_mod:bamboo', [[[0, 0, 0, 1, 1, 1]]]);
    ok('模组方块撞上同名后缀 → 标成"猜的"（不是权威标记）',
      modBamboo.angelShapeDynamicGuessed === true && modBamboo.angelShapeDynamic === undefined);
    ok('模组方块的名字不会混进权威计数', modBamboo.angelShapeDynamic === undefined);
    ok('只是名字里含 bamboo 的模组方块不误伤',
      mkMod('some_mod:bamboo_mat', [[[0, 0, 0, 1, 1, 1]]]).angelShapeDynamicGuessed === undefined);
  }

  // ---- 4. 累计 drift / count 下限校验 ----
  {
    const bad = makeEntries();
    const oakEntry = bad.find(e => e.blockId === 82);
    const oldOakCount = oakEntry.count;
    oakEntry.count = 27;
    const delta = oakEntry.count - oldOakCount;
    for (const e of bad) if (e.first > oakEntry.first) e.first += delta;
    const badIndex = palette.buildIndex(bad);
    ok('count 变小的 dump 仍保持连续但被拒绝', badIndex.gaps === 0);
    const rr = injectPalette(registry, badIndex, { anchors: [] });
    ok('count 小于本地基线会拒绝', rr.ok === false && rr.vanillaMismatches.some(m => /state 个数不足/.test(m.why)), rr.reason);
    ok('拒绝报告包含 count 不足证据', rr.vanillaMismatches.some(m => m.blockId === 82 && /state 个数不足/.test(m.why)),
      JSON.stringify(rr.vanillaMismatches.slice(0, 2)));
  }
  {
    const bad = makeEntries();
    bad[0].name = 'minecraft:not_air';
    const badIndex = palette.buildIndex(bad);
    const rr = injectPalette(registry, badIndex, { anchors: [] });
    ok('原版名字错会拒绝', rr.ok === false && /名字/.test(rr.reason), rr.reason);
  }

  // ---- 5. 锚点是区间判据，不要求 state 必须等于 first ----
  {
    const hit = checkAnchors({ sorted: [{ blockId: 1003, first: 25019, count: 8 }] }, [
      { blockId: 1003, stateId: 25022, name: 'quark:spruce_ladder' },
    ]);
    ok('锚点落在区间内通过', hit.checked === 1 && hit.violations.length === 0);
    const miss = checkAnchors({ sorted: [{ blockId: 1003, first: 25019, count: 8 }] }, [
      { blockId: 1003, stateId: 25027, name: 'quark:spruce_ladder' },
    ]);
    ok('锚点落在区间外拒绝', miss.checked === 1 && miss.violations.length === 1);
    ok('锚点报告保留区间与偏移',
      JSON.stringify(miss.violations[0].dumpRange) === JSON.stringify([25019, 25026]) &&
      miss.violations[0].offBy === 8);
  }

  // ---- 6. 只有原版、没有模组段时不宣称“完整识别” ----
  {
    const onlyVanilla = injectPalette(registry, palette.buildIndex(makeEntries({ withMod: false })), { anchors: [] });
    ok('只有原版段会被拒绝为不完整调色板',
      onlyVanilla.ok === false && /没有模组方块/.test(onlyVanilla.reason), onlyVanilla.reason);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = {
  VANILLA_BLOCK_COUNT,
  VANILLA_STATE_TOTAL,
  DEFAULT_ANCHORS,
  DYNAMIC_SHAPE_RE,
  DYNAMIC_SHAPE_GUESS_RE,
  parseAnchors,
  checkAnchors,
  toStateProps,
  shapeFieldsFor,
  applyShapeFields,
  buildRecord,
  buildVanillaOverlayRecord,
  injectPalette,
  clearInjected,
  lastInjectionSummary,
  selftest,
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
