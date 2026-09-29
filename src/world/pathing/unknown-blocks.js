'use strict';

/**
 * 未映射方块 / 薄方块 —— 模组方块的**碰撞箱**是开集：mineflayer 的表里没有，
 * `boundingBox === undefined` 就是"没有权威碰撞箱"的信号。
 * 这一层的策略是**保守放行**（按名字猜 + 只对认识的薄方块放行），
 * 猜错的代价是不走这一格，而不是把主人的房子推平。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

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
// 第 4 步去重：`(process.env.X ?? 'true') !== 'false'` → util/env.js 的 A 派（逐字等价）
const { envOn } = require('../../util/env');
const UNKNOWN_BLOCK_SOLID = envOn('MC_UNKNOWN_BLOCK_SOLID');
// ⚠️ 拆文件（第 3 步，2026-09-29）之后这里**不能是 const 立即求值**：
//    原来 `parseIdList` 和这一行在**同一个作用域**里（原文件 210 行 vs 727 行，先定义后用），
//    拆开后 `parseIdList` 在 ladders.js，靠汇总 `index.js` 的 `bind()` 回填 ——
//    而 require 期 `bind()` 还没跑，`parseIdList` 还是转发壳背后那个空 `__ns`：
//    立即求值会 `ReferenceError`（离线自测看不见，`require` 就炸）。
//    所以改成 `let` 占位，由下面 `bind()` 回填；对外读到的仍是同一个 Set。
let PASSABLE_STATE_IDS;

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
const THIN_BLOCK_PASSABLE = envOn('MC_THIN_BLOCK_PASSABLE');

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

// ---- 跨文件名字（第 3 步重构）------------------------------------------------
//
// 拆之前所有顶层声明都在**一个作用域**里，谁先谁后都无所谓；拆开之后本文件用到的
// 隔壁名字必须靠汇总 `index.js` 在**所有子文件都加载完**之后 `bind()` 回来，
// 否则 require 期就 `ReferenceError`（见 src/body/AGENTS.md「循环依赖」那段）。
const __ns = {};
function parseIdList (...a) { return __ns.parseIdList.apply(null, a); }
function bind (ns) {
  Object.assign(__ns, ns);
  PASSABLE_STATE_IDS = ns.parseIdList(process.env.MC_PASSABLE_STATE_IDS);
  // 汇总（index.js）在所有 bind 之后才用 __ns 拼 module.exports：把算好的值写回共享表，
  // 否则对外导出的 PASSABLE_STATE_IDS 是 require 期的 undefined（拆前是一个 Set / 数组）。2026-09-29 Claude 复核补
  ns.PASSABLE_STATE_IDS = PASSABLE_STATE_IDS;
  module.exports.PASSABLE_STATE_IDS = PASSABLE_STATE_IDS;
}

module.exports = {
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
  lowBlockHeight,
  bind,
};
