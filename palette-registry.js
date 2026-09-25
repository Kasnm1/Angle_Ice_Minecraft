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
 * 模组注入记录**故意不填 `boundingBox` / `shapes`**，而 `pathing.js` 的
 * `needsShapeFallback` 正是用 `boundingBox === undefined` 判"我们不知道它的碰撞箱"。
 * 原版 overlay 会保留 minecraft-data 的碰撞字段；扩展 state 没有权威形状时仍走
 * 实心兜底。行为目标是：身份和属性不再未知，碰撞未知时宁可多绕也不穿模。
 *
 * ⚠️ 这是一条**契约**，不是巧合：谁给注入的记录填上 `boundingBox`，
 *    模组方块就会全部变成"已知形状"、白名单静默失效。自测里有断言钉住它。
 * 记录上另带 `angelInjected: true`，只用于 `clearInjected` 认自己的东西 + 调试。
 *
 * ## 刻意不做的事
 *
 * 不给注入的方块填 `hardness` / `diggable` / `shapes` / `boundingBox`。
 * 填了就是**改变行为**（能不能挖、碰撞箱形状），而这两件事调色板并不权威。
 * 保持现状：身份（type/name/属性）由调色板提供，碰撞由实心策略提供。
 */

/** 本地 minecraft-data 1.20.1 的原版基线：1003 个方块、24135 个 state。 */
const VANILLA_BLOCK_COUNT = 1003;
const VANILLA_STATE_TOTAL = 24135;

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
  // cluttered:ancient_codex —— 玩家 F3 实测（也是"她撞上透明墙"那次的主角）
  { blockId: 14286, stateId: 506805, name: 'cluttered:ancient_codex' },
  // upgrade_aquatic:glass_trapdoor —— 玩家 F3 实测；open:false→true 相差 4，
  // 与 facing(4)×half(2)×open(2)×powered(2)×waterlogged(2) 的混合进制展开吻合
  { blockId: 15061, stateId: 522768, name: 'upgrade_aquatic:glass_trapdoor' },
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

/** 由调色板的一条记录造一个方块记录（一个方块**共用一个对象**，不是每个 state 一个）。 */
function buildRecord (entry) {
  return {
    id: entry.blockId,
    name: entry.name,
    displayName: entry.name,
    minStateId: entry.first,
    maxStateId: entry.first + entry.count - 1,
    states: toStateProps(entry.props),
    // 实心策略补丁认这个标记：见 pathing.js 的 needsShapeFallback
    angelInjected: true,
  };
}

/**
 * 用 dump 的 state 布局覆盖一条原版注册表记录，但保留 minecraft-data 提供的
 * 碰撞、挖掘、掉落等运行时字段。整合包会给少数原版方块增加属性值；如果还把
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
  // stateShapes 来自旧布局，扩容后 metadata 不再与它一一对应；让 Block 使用
  // 该方块的默认 shapes，而不是把新 state 错配到旧 stateShapes 的任意一格。
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
 *            cleared: number, samples: Array}}
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
  };

  // 先覆盖整合包真实的 vanilla state 布局，保证扩容后的原版方块不再错译。
  for (const { base, entry } of vanillaEntries) {
    const rec = buildVanillaOverlayRecord(base, entry);
    assign(entry, rec, base.name);
    report.overlayBlocks++;
    report.overlayStates += entry.count;
  }

  // 再写入模组方块；这些记录没有权威碰撞箱，继续交给 pathing 的实心兜底。
  for (const e of modded) {
    const rec = buildRecord(e);
    assign(e, rec, rec.name);
    report.blocks++;
    report.states += e.count;
    if (report.samples.length < 5) {
      report.samples.push({ id: rec.id, name: rec.name, first: e.first, count: e.count });
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
  ok('模组 state 保留未知碰撞箱标记，交给实心策略', mod.boundingBox === undefined, mod.boundingBox);

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
  parseAnchors,
  checkAnchors,
  toStateProps,
  buildRecord,
  injectPalette,
  clearInjected,
  lastInjectionSummary,
  selftest,
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
