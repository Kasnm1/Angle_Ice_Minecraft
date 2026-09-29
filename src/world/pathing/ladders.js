'use strict';

/**
 * 可攀爬方块（梯子识别）—— 模组服上梯子**认不出来**，比"名字错位"更隐蔽：
 * 它不是读错，而是 mineflayer-pathfinder / prismarine-physics 判定"能不能爬"
 * 靠的是**数字方块 ID**，模组梯子根本没进那张表。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */


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

module.exports = {
  CLIMBABLE_STATE_IDS,
  parseIdList,
  parseNameList,
  resolveClimbableIds,
  resolveClimbableBlockIds,
  applyClimbables,
  probeClimbables,
  installLadderFix,
};
