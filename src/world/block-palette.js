/**
 * block-palette.js —— 「全局 state id → 真实方块名 + 属性值」的查表。
 *
 * ## 为什么需要它（这是本包最根本的一条认知限制）
 *
 * 1.13 之后，服务端在 `chunk_data` 里只发**全局调色板数字 ID**，方块名靠**客户端本地
 * 注册表**翻译。原版客户端装了模组所以认识 `upgrade_aquatic:glass_trapdoor`；我们只有
 * 原版 `minecraft-data`，于是任何模组方块都查成空名字 —— 而 `prismarine-block` 对查不到
 * 的 state 会给 `shapes=[] / boundingBox='empty'`，客户端以为能穿过去，服务端照自己的
 * 碰撞把人推回来，表现为**原地抖动、位移≈0**。
 *
 * ## 已经确证的事实（2026-09-23，都是实测不是推测）
 *
 * 1. **方块注册表能从网络上直接拿到。** Forge 通过 FML 登录握手的 `S2CRegistry` 把
 *    `minecraft:block` 快照推过来，里面是**服务端完整的 `方块名 → blockId`**。
 *    本包实测 **20217 个方块**（原版 1003 + 模组 19214），另有 `minecraft:item` 30729 条。
 * 2. **原版的注册表 id 与 state 区间都没有被模组挤开。** 1003 个原版方块的注册表 id
 *    与服务端**逐个一致（1003/1003，零差异）**；原版 state 区间是 0..24134。
 *    模组方块是**追加**在后面的。
 * 3. **state id 按方块注册顺序连续分配**（原版数据里严格单调，已验），所以
 *        stateId = 原版state总数 + Σ_{前面每个模组方块的 state 数} + 方块内局部序号
 * 4. **方块内部 state 的展开顺序** = 属性按名字排序、取值按声明顺序、嵌套展开
 *    （最后一个属性变化最快）。用玩家 F3 给的锚点验证过：`glass_trapdoor` 的
 *    `open:false → true` 两个 state 的 id 相差正好 4，与
 *    `facing(4) × half(2) × open(2) × powered(2) × waterlogged(2)` 的混合进制展开完全吻合。
 *
 * ## 那还差什么
 *
 * 只差 `每个模组方块的 state 数`。**这个数不能从模组 jar 的 `blockstates/*.json` 反推** ——
 * MC 允许 `variants` 的键省略属性当通配符，`glass_trapdoor` 真值 64 态只数得出 16 态，
 * 而且累计偏移会让整张表报废（实测两个锚点全部越界 27 万位）。
 *
 * 精确来源只有一个：**跑着的那个客户端**。它手里就有 `Block.BLOCK_STATE_REGISTRY`。
 * 用 KubeJS 启动脚本把它倒出来（见 `kubejs/startup_scripts/src/zz_angel_dump_block_palette.js`），
 * 每行格式：
 *
 *     blockRegistryId | 第一个state的全局id | state个数 | 方块名 | 属性规格
 *
 * 属性规格形如 `facing:north,south,west,east;half:top,bottom;open:false,true`。
 * 这个模块就负责解析它，并提供 `stateId → {name, properties}` 的查询。
 *
 * ## 设计原则
 *
 * * **纯函数**：解析、建索引、查询、解码属性全是纯函数，能离线穷举（`--selftest`）。
 * * **自洽性自检**：相邻方块的 `[first, first+count)` 必须严丝合缝。只要有一处不连续，
 *   就说明 dump 不完整或被改过 —— 那时**整张表作废**，宁可报错也不要给出错名字。
 * * **查不到就返回 null**，绝不猜。
 */

// ---------------------------------------------------------------- 碰撞形状（第 6 列）

/**
 * 碰撞形状这一列怎么编。
 *
 * ## 为什么要有它
 *
 * 名字和属性只能告诉 `pathing.js`「这是什么方块」，**告诉不了它「这一格挡不挡人」**。
 * 于是模组方块只能按名字猜（薄方块白名单 → 可穿过；`_bed` → 9/16；其余 → 整块实心），
 * 整合包里大量非整格方块（家具、模组台阶/楼梯/栅栏/地毯/路径块…）全被猜错 ——
 * 这才是"卡在门口出不去"那类问题的根，`lowBlockHeight` 那条名字规则只是补丁。
 *
 * 形状**不可能**从模组 jar 反推（同 state 数那件事：`blockstates` 的 variants 能省属性当通配符），
 * 唯一精确来源还是那个跑着的客户端。所以 dump 多导一列：**每个 state 的碰撞箱**。
 *
 * ## 编码（逐 state + 方块内形状表）
 *
 * 一列的形态：
 *
 * | 串 | 含义 |
 * |---|---|
 * | `?` | 整块**读不到** |
 * | `<def>` | 所有 state 同一个形状（最常见：整格方块就写一个 `.`） |
 * | `<def0>;<def1>;…~<idx…>` | 表 + 逐 state 索引 |
 * | `!<def>,<def>,…` | 兜底：形状种类 > 62，直接逐 state 列（很少见） |
 *
 * `def`（一个形状）的写法：
 *
 * | 串 | 含义 |
 * |---|---|
 * | `.` | 整格 `[[0,0,0,1,1,1]]` |
 * | `-` | **没有碰撞**（空气、草、火把…）—— 与"读不到"是两回事，必须分开 |
 * | `x1:x2:…:z2` | 6 个数字，单位是**格**（1.20.1 高度用 24 = 1.5 格） |
 * | `a+b` | 多个箱子（栅栏/楼梯那种）用 `+` 连 |
 *
 * 索引字符用 `0-9a-zA-Z`（62 个）；某个 state **读不到**就在索引位上写 `?`。
 * 分隔符只用 `;~+:!,-.` 这些不会出现在方块名/属性里的字符 —— 整行本来就是 `|` 分列。
 *
 * 数字按二进制小数存：1/16=0.0625、13/32=0.40625 都是**精确**的二进制小数，
 * `String()` 能原样写回，不掉精度。
 *
 * 实测（原版 1003 方块 / 24135 state）：往返 100% 一致，编码后 **167 KB / 平均 7.1 字符每 state**。
 * 逐 state 直接列要 575 KB，所以"方块内形状表"这层压缩是必需的。
 *
 * ## 向后兼容
 *
 * 旧 dump 只有 5 列 → `shapes = null` → 调用方照旧按名字猜（`applyUnknownBlockPolicy`）。
 * **条数对不上 count 也一律当"读不到"** —— 宁可退回按名字猜，也不要错位一格。
 */

/** 整格碰撞箱。`encodeShape` 遇到它就写一个 `.`。 */
const FULL_CUBE_BOX = [0, 0, 0, 1, 1, 1];

/** 索引字母表：0-9a-zA-Z（62 个）。`?` 留给"这个 state 读不到"。 */
const SHAPE_INDEX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 坐标 → 紧凑串。保留 6 位小数（够覆盖 1/64 网格），并消掉 `-0`。 */
function fmtCoord (v) {
  const r = Math.round(Number(v) * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/** 一个 state 的碰撞箱数组 → 串。`null`（读不到）→ `?`。 */
function encodeShape (boxes) {
  if (!Array.isArray(boxes)) return '?';
  if (!boxes.length) return '-';
  if (boxes.length === 1) {
    const b = boxes[0];
    if (Array.isArray(b) && b.length === 6 && b.every((v, i) => Number(v) === FULL_CUBE_BOX[i])) return '.';
  }
  return boxes.map(b => (Array.isArray(b) ? b.map(fmtCoord).join(':') : '?')).join('+');
}

/** 串 → 碰撞箱数组。`?` 或坏串 → `null`（"读不到"，不是"没有"）。 */
function decodeShape (s) {
  if (s === '.') return [FULL_CUBE_BOX.slice()];
  if (s === '-') return [];
  if (!s || s === '?') return null;
  const out = [];
  for (const boxStr of String(s).split('+')) {
    const nums = boxStr.split(':').map(Number);
    if (nums.length !== 6 || nums.some(n => !Number.isFinite(n))) return null;
    out.push(nums);
  }
  return out;
}

/** 整个方块的逐 state 形状 → 一列。`shapes` 不是数组 → `?`。 */
function encodeShapes (shapes) {
  if (!Array.isArray(shapes)) return '?';
  const defs = [];
  const seen = new Map();
  const idx = [];
  for (const boxes of shapes) {
    if (!Array.isArray(boxes)) { idx.push('?'); continue; }   // 读不到，不进表
    const k = encodeShape(boxes);
    if (!seen.has(k)) { seen.set(k, defs.length); defs.push(k); }
    idx.push(SHAPE_INDEX_ALPHABET[seen.get(k)]);
  }
  if (!defs.length) return '?';                                // 全是读不到
  if (defs.length === 1 && idx.every(c => c === SHAPE_INDEX_ALPHABET[0])) return defs[0];
  // 兜底：形状种类比索引字母表还多（原版只有 chorus_plant 一个），逐 state 直接列 def
  if (defs.length > SHAPE_INDEX_ALPHABET.length) return '!' + shapes.map(s => encodeShape(s)).join(',');
  return defs.join(';') + '~' + idx.join('');
}

/**
 * 解码结果缓存。
 *
 * 为什么必须有：整表 **826k 个 state**，但**不同**的形状串很少（实测原版 24135 个
 * state 只有约 2.4k 种）。不缓存的话每个 state 都 new 一批 AABB 数组，光形状对象
 * 就要几百 MB；缓存之后同一形状全表共用一份。
 *
 * ⚠️ 所以返回的数组是**共享的**，调用方**不得就地修改** —— 和 `minecraft-data`
 *    自己的 `stateShapes` 是同一个约定（它也在多个 state 之间共用形状数组）。
 *    `prismarine-block` 只读不写；`pathing.js` 只读 `shape[4]`。
 * ⚠️ 有上限：喂进来的是坏数据（每个 state 都不同）时不会把内存吃光。
 */
const SHAPE_CACHE = new Map();
const SHAPE_CACHE_MAX = 20000;

/** 带缓存的 `decodeShape`。`null`（读不到）也缓存 —— 它是合法结果，不是异常。 */
function decodeShapeCached (s) {
  const hit = SHAPE_CACHE.get(s);
  if (hit !== undefined) return hit;
  const v = decodeShape(s);
  if (SHAPE_CACHE.size < SHAPE_CACHE_MAX) SHAPE_CACHE.set(s, v);
  return v;
}

/**
 * 一列 → 逐 state 形状数组；**用不了就返回 null**（宁可退回按名字猜）。
 * `count` 给了就必须条数相等 —— 错位一格比没有更糟。
 */
function decodeShapes (spec, count) {
  if (!spec || spec === '?') return null;
  const s = String(spec);
  const want = count == null ? null : count;

  // 兜底形态：逐 state 直接列
  if (s[0] === '!') {
    const parts = s.slice(1).split(',');
    if (want != null && parts.length !== want) return null;
    return parts.map(decodeShapeCached);
  }
  // 无表：所有 state 同一个形状
  if (s.indexOf('~') < 0) {
    const one = decodeShapeCached(s);
    if (one === null) return null;
    return want == null ? [one] : new Array(want).fill(one);
  }
  const cut = s.indexOf('~');
  const defs = s.slice(0, cut).split(';').map(decodeShapeCached);
  if (defs.some(d => d === null)) return null;                 // 表里有坏 def
  const idxStr = s.slice(cut + 1);
  if (want != null && idxStr.length !== want) return null;
  const out = [];
  for (const ch of idxStr) {
    if (ch === '?') { out.push(null); continue; }
    const i = SHAPE_INDEX_ALPHABET.indexOf(ch);
    if (i < 0 || i >= defs.length) return null;
    out.push(defs[i]);
  }
  return out;
}

/** 一列里写了几个 state 的形状（给"条数对不上 count"这类报错用）。 */
function shapeEntryCount (spec) {
  const s = String(spec == null ? '' : spec);
  if (!s || s === '?') return 0;
  if (s[0] === '!') return s.slice(1).split(',').length;
  const cut = s.indexOf('~');
  if (cut < 0) return 1;                       // 无表 = 所有 state 同一个形状
  return s.length - cut - 1;                   // 索引位一人一个
}

// ---------------------------------------------------------------- 解析

/**
 * 解析属性规格串。`facing:north,south;open:false,true` → 有序数组。
 * 顺序很重要：它就是 state id 的混合进制展开顺序。
 */
function parsePropSpec (spec) {
  if (!spec || spec === '?') return [];
  const out = [];
  for (const chunk of spec.split(';')) {
    if (!chunk) continue;
    const i = chunk.indexOf(':');
    if (i <= 0) continue;
    const key = chunk.slice(0, i);
    const values = chunk.slice(i + 1).split(',');
    if (!values.length || values.some(v => v === '')) continue;
    out.push({ key, values });
  }
  return out;
}

/**
 * 把各种形态的 dump 输入统一成 `parseDump` 能吃的文本。
 *
 * 为什么需要：客户端那份 KubeJS 脚本有两种输出形态（见 registry/README.md）——
 *   ① 首选写成 JSON：`{"generatedBy":…, "rows":["196|4654|8|minecraft:ladder|…", …]}`
 *      （KubeJS 的 `JsonIO.write` 只会写 JSON，写不了自由文本）
 *   ② 兜底把每行打进日志，前缀 `ANGELPAL|`（把前缀去掉就是标准 dump 文本）
 * 再加上"手写一份 dump 文本"这条老路，一共三种输入。归一化放在这里（纯函数、可自测），
 * 而不是散在 `bridge-server.js` 里。
 *
 * ⚠️ 判据只看**第一个非空白字符**：dump 文本一定以数字（blockId）开头，
 *    JSON 一定以 `{` 或 `[` 开头。不做"猜"——两边都不像就原样返回，
 *    让 `parseDump` 去报"字段不足"。
 */
function normalizeDumpText (raw) {
  let s = String(raw ?? '')
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1) // BOM
  const t = s.trimStart()
  if (!t) return s
  const c = t[0]
  if (c !== '{' && c !== '[') return s // 已经是 dump 文本

  let obj
  try {
    obj = JSON.parse(t)
  } catch (e) {
    return s // 不是合法 JSON —— 原样交给 parseDump 去报错
  }
  const rows = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.rows) ? obj.rows : null)
  if (!rows) return s
  return rows.map(r => String(r)).join('\n')
}

/**
 * 解析 dump 文本。返回 `{entries, badLines, dupes, shapeIssues}`。
 * 一行格式：`blockId|firstStateId|count|name|propSpec[|shapeSpec]`
 *
 * ⚠️ 第 6 列（形状）是**可选**的：旧 dump 没有它 → `entry.shapes = null`，
 *    调用方照旧按名字猜（向后兼容）。有这一列但**条数对不上 count** 也当读不到，
 *    并记进 `shapeIssues` —— 那是"导出了但不可信"，和"根本没导"要分开报。
 */
function parseDump (text) {
  const entries = [];
  const badLines = [];
  const shapeIssues = [];
  const seen = new Set();
  let dupes = 0;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 4) { badLines.push({ line: i + 1, why: '字段不足 4 个' }); continue; }
    const blockId = Number(parts[0]);
    const first = Number(parts[1]);
    const count = Number(parts[2]);
    const name = parts[3];
    if (!Number.isInteger(blockId) || blockId < 0) { badLines.push({ line: i + 1, why: `blockId 非法: ${parts[0]}` }); continue; }
    if (!Number.isInteger(first) || first < 0) { badLines.push({ line: i + 1, why: `firstStateId 非法: ${parts[1]}` }); continue; }
    if (!Number.isInteger(count) || count <= 0) { badLines.push({ line: i + 1, why: `count 非法: ${parts[2]}` }); continue; }
    if (!name) { badLines.push({ line: i + 1, why: '方块名为空' }); continue; }
    if (seen.has(blockId)) { dupes++; continue; }
    seen.add(blockId);
    const shapeSpec = parts.length > 5 ? parts[5] : '';
    const shapes = decodeShapes(shapeSpec, count);
    if (!shapes && shapeSpec && shapeSpec !== '?') {
      // 有列但用不了：条数对不上、或者 `^` 出现在第一条
      if (shapeIssues.length < 20) {
        shapeIssues.push({ line: i + 1, name, count, entries: shapeEntryCount(shapeSpec) });
      }
    }
    entries.push({ blockId, first, count, name, props: parsePropSpec(parts[4]), shapes });
  }
  return { entries, badLines, dupes, shapeIssues };
}

/**
 * 建索引。按 `first` 排序，并检查**严格连续**：
 *   对每个相邻对，必须  prev.first + prev.count === next.first
 * 不连续 → `gaps > 0` → 调用方应当拒绝使用这张表（宁可报"认不出"，也不要给错名字）。
 */
function buildIndex (entries) {
  const sorted = entries.slice().sort((a, b) => a.first - b.first);
  const gapList = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const expect = prev.first + prev.count;
    if (sorted[i].first !== expect) {
      if (gapList.length < 20) {
        gapList.push({ after: prev.name, expectFirst: expect, actualFirst: sorted[i].first, delta: sorted[i].first - expect });
      }
    }
  }
  const firstState = sorted.length ? sorted[0].first : 0;
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  const totalStates = last ? last.first + last.count : 0;
  return { sorted, gaps: gapList.length, gapList, firstState, totalStates };
}

/**
 * 把方块内的局部序号展开成属性值。
 * 展开顺序：属性按名字排序（= 索引里存的顺序），**最后一个属性变化最快**。
 * 例：`glass_trapdoor` 的 facing(4)×half(2)×open(2)×powered(2)×waterlogged(2)，
 *     局部序号 4 → open=true（其余保持第一个取值）。
 */
function decodeProps (props, local) {
  const out = {};
  if (!props || !props.length) return out;
  let rem = local;
  for (let i = props.length - 1; i >= 0; i--) {
    const n = props[i].values.length;
    if (n <= 0) continue;
    out[props[i].key] = props[i].values[rem % n];
    rem = Math.floor(rem / n);
  }
  return out;
}

/**
 * 二分查 stateId。查不到返回 null（绝不猜）。
 *
 * 返回里带**这一格的碰撞形状**（`shape` / `shapeKnown`）：
 *   · `shapeKnown === false` → 我们**不知道**它的形状（旧 dump、或这一条没导出来）
 *   · `shapeKnown === true, shape = []` → 知道，而且**没有碰撞**（草、火把、空气…）
 * 这两件事必须分开 —— `pathing.js` 就是靠这个决定"信真实形状"还是"退回按名字猜"。
 */
function lookupState (index, stateId) {
  if (!index || !index.sorted || !index.sorted.length) return null;
  const arr = index.sorted;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = arr[mid];
    if (stateId < e.first) hi = mid - 1;
    else if (stateId >= e.first + e.count) lo = mid + 1;
    else {
      const local = stateId - e.first;
      const shape = Array.isArray(e.shapes) ? (e.shapes[local] ?? null) : null;
      return {
        blockId: e.blockId,
        name: e.name,
        local,
        count: e.count,
        properties: decodeProps(e.props, local),
        shape,
        shapeKnown: Array.isArray(shape)
      };
    }
  }
  return null;
}

/** 反向：方块名 → 它的 state 区间（给"我该把哪个 stateId 当梯子"这类问题用）。 */
function findBlock (index, name) {
  if (!index || !index.sorted) return null;
  const want = String(name);
  for (const e of index.sorted) {
    if (e.name === want) return { blockId: e.blockId, name: e.name, first: e.first, count: e.count, props: e.props };
  }
  return null;
}

/**
 * 从索引里挑出"真正的梯子"的 stateId 列表。
 *
 * 这是 `MC_CLIMBABLE_STATE_IDS` 的正确填法 —— 之前那一版把 5337 当梯子，
 * 而 5337 其实是 `crimson_hanging_sign`（悬挂牌）。她"爬上去"只是因为我们
 * 骗了物理层，属于自我实现的预言。
 */
function climbableStateIds (index, blockName = 'minecraft:ladder') {
  const b = findBlock(index, blockName);
  if (!b) return [];
  const out = [];
  for (let i = 0; i < b.count; i++) out.push(b.first + i);
  return out;
}

/** 把属性值渲染成 `facing=north,open=true` 这种可读串（按 key 排序，稳定）。 */
function formatProps (properties) {
  if (!properties) return '';
  return Object.keys(properties).sort().map(k => `${k}=${properties[k]}`).join(',');
}

// ---------------------------------------------------------------- 自测

function selftest () {
  let pass = 0; let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
  };

  // --- 1. 属性规格解析
  {
    const p = parsePropSpec('facing:north,south,west,east;half:top,bottom;open:false,true');
    ok('规格解析出 3 个属性', p.length === 3, p.length);
    ok('属性顺序保留', p.map(x => x.key).join(',') === 'facing,half,open');
    ok('取值顺序保留', p[0].values.join(',') === 'north,south,west,east');
    ok('空规格 → 空数组', parsePropSpec('').length === 0);
    ok('坏规格（没有冒号）被丢掉', parsePropSpec('facing').length === 0);
    ok('取值里有空项就整条丢掉（防 `Number("")===0` 那类坑）', parsePropSpec('a:,x').length === 0);
  }

  // --- 2. dump 解析
  {
    const text = [
      '0|0|1|minecraft:air|',
      '196|4654|8|minecraft:ladder|facing:north,south,west,east;waterlogged:false,true',
      '',
      '15061|522768|64|upgrade_aquatic:glass_trapdoor|facing:north,south,west,east;half:top,bottom;open:false,true;powered:false,true;waterlogged:false,true',
      'bad line here',
      '12|x|3|whatever|',
      '13|100|0|zero|',
      '14|100|5||',
    ].join('\n');
    const r = parseDump(text);
    ok('解析出 3 条有效行', r.entries.length === 3, r.entries.length);
    ok('空行被跳过、坏行被记录', r.badLines.length === 4, r.badLines.length);
    ok('air 的 props 为空数组', r.entries[0].props.length === 0);
  }

  // --- 2b. 输入形态归一化（dump 文本 / JSON{rows} / JSON 数组 / 日志抽出的行）
  {
    const dump = '0|0|1|minecraft:air|\n196|4654|8|minecraft:ladder|facing:north,south,west,east'
    ok('纯 dump 文本原样通过', normalizeDumpText(dump) === dump)
    ok('带 BOM 的 dump 文本被剥掉 BOM',
      normalizeDumpText('\uFEFF' + dump).startsWith('0|0|1|'))
    const jsonObj = JSON.stringify({ generatedBy: 'x', rows: dump.split('\n') })
    ok('JSON {rows:[…]} 被展开成 dump 文本',
      normalizeDumpText(jsonObj) === dump, JSON.stringify(normalizeDumpText(jsonObj).slice(0, 40)))
    const jsonArr = JSON.stringify(dump.split('\n'))
    ok('JSON 数组被展开成 dump 文本', normalizeDumpText(jsonArr) === dump)
    ok('JSON 里没有 rows 字段 → 原样返回（交给 parseDump 报错）',
      normalizeDumpText('{"foo":1}') === '{"foo":1}')
    ok('坏 JSON → 原样返回，不抛', normalizeDumpText('{oops') === '{oops')
    ok('空输入不抛', normalizeDumpText('') === '' && normalizeDumpText(null) === '')
    // 归一化之后必须能被 parseDump 正常吃下（这才是端到端的判据）
    const r2 = parseDump(normalizeDumpText(jsonObj))
    ok('JSON 形态归一化后 parseDump 得到 2 条', r2.entries.length === 2, r2.entries.length)
    ok('归一化后名字正确', r2.entries[1].name === 'minecraft:ladder', r2.entries[1].name)
    ok('归一化后属性规格被解析',
      r2.entries[1].props.length === 1 && r2.entries[1].props[0].key === 'facing',
      JSON.stringify(r2.entries[1].props))
  }

  // --- 3. 重复 blockId 只留一条
  {
    const r = parseDump('1|10|2|a|\n1|20|2|b|');
    ok('重复 blockId 只留一条', r.entries.length === 1, r.entries.length);
    ok('重复计数被记录', r.dupes === 1, r.dupes);
  }

  // --- 4. 连续性自检：严丝合缝 = 0 gap
  {
    const idx = buildIndex([
      { blockId: 0, first: 0, count: 1, name: 'air', props: [] },
      { blockId: 1, first: 1, count: 4, name: 'a', props: [] },
      { blockId: 2, first: 5, count: 8, name: 'b', props: [] },
    ]);
    ok('连续的索引 gaps = 0', idx.gaps === 0, idx.gaps);
    ok('totalStates = 13', idx.totalStates === 13, idx.totalStates);
  }

  // --- 5. 不连续必须被报出来（这是"表作废"的信号）
  {
    const idx = buildIndex([
      { blockId: 0, first: 0, count: 1, name: 'air', props: [] },
      { blockId: 1, first: 1, count: 4, name: 'a', props: [] },
      { blockId: 2, first: 99, count: 8, name: 'b', props: [] },
    ]);
    ok('中间缺 94 个 state → gaps = 1', idx.gaps === 1, idx.gaps);
    ok('gap 明细里记了期望值', idx.gapList[0].expectFirst === 5 && idx.gapList[0].actualFirst === 99);
  }

  // --- 6. 混合进制展开：**用玩家 F3 的锚点当判据**
  //     glass_trapdoor 真值 64 态，open 是第 3 个属性（facing,half,open,powered,waterlogged），
  //     所以 open:false 的局部序号 {0,1,2,3}、open:true 的 {4,5,6,7}。
  //     实测 522768(关) 与 522772(开) 相差正好 4 —— 与这里必须一致。
  {
    const props = parsePropSpec('facing:north,south,west,east;half:top,bottom;open:false,true;powered:false,true;waterlogged:false,true');
    const p0 = decodeProps(props, 0);
    const p4 = decodeProps(props, 4);
    ok('局部 0 → facing=north', p0.facing === 'north');
    ok('局部 0 → half=top', p0.half === 'top');
    ok('局部 0 → open=false', p0.open === 'false');
    ok('局部 0 → waterlogged=false', p0.waterlogged === 'false');
    ok('局部 4 → open=true，其余不变（对应实测 522768→522772 差 4）',
      p4.open === 'true' && p4.facing === 'north' && p4.half === 'top' && p4.powered === 'false');
    ok('局部 5 → waterlogged=true（最后一个属性变化最快）', decodeProps(props, 5).waterlogged === 'true');
    ok('局部 63 是最后一个状态', decodeProps(props, 63).waterlogged === 'true' && decodeProps(props, 63).facing === 'east');
  }

  // --- 7. 二分查询 + 边界
  {
    const idx = buildIndex([
      { blockId: 0, first: 0, count: 1, name: 'minecraft:air', props: [] },
      { blockId: 196, first: 4654, count: 8, name: 'minecraft:ladder', props: parsePropSpec('facing:north,south,west,east;waterlogged:false,true') },
      { blockId: 15061, first: 522768, count: 64, name: 'upgrade_aquatic:glass_trapdoor', props: parsePropSpec('facing:north,south,west,east;half:top,bottom;open:false,true;powered:false,true;waterlogged:false,true') },
    ]);
    ok('查 air (0)', lookupState(idx, 0).name === 'minecraft:air');
    ok('查梯子区间起点', lookupState(idx, 4654).name === 'minecraft:ladder');
    ok('查梯子区间终点', lookupState(idx, 4661).name === 'minecraft:ladder');
    ok('梯子区间外（4662）返回 null', lookupState(idx, 4662) === null);
    ok('查锚点 522768 → glass_trapdoor 且 open=false',
      lookupState(idx, 522768).name === 'upgrade_aquatic:glass_trapdoor' && lookupState(idx, 522768).properties.open === 'false');
    ok('查锚点 522772 → open=true', lookupState(idx, 522772).properties.open === 'true');
    ok('越界（很大）返回 null', lookupState(idx, 9999999) === null);
    ok('空索引返回 null', lookupState({ sorted: [] }, 5) === null);
    ok('undefined 索引返回 null', lookupState(null, 5) === null);
  }

  // --- 8. 反查 + 挑梯子（这才是 MC_CLIMBABLE_STATE_IDS 的正确填法）
  {
    const idx = buildIndex([
      { blockId: 0, first: 0, count: 1, name: 'minecraft:air', props: [] },
      { blockId: 196, first: 4654, count: 8, name: 'minecraft:ladder', props: parsePropSpec('facing:north,south,west,east;waterlogged:false,true') },
    ]);
    const b = findBlock(idx, 'minecraft:ladder');
    ok('反查到 ladder', b && b.first === 4654 && b.count === 8);
    ok('ladder 的 8 个 stateId 全列出来', climbableStateIds(idx).join(',') === '4654,4655,4656,4657,4658,4659,4660,4661');
    ok('查不存在的方块 → null', findBlock(idx, 'nope:nope') === null);
    ok('查不存在时挑梯子 → 空数组（不猜）', climbableStateIds(idx, 'mod:x').length === 0);
  }

  // --- 9. 关键回归：**5337 不是梯子**
  //     这是上一版真实犯过的错 —— 把 crimson_hanging_sign 的 state 当梯子喂给物理层。
  {
    const mcData = require('minecraft-data')('1.20.1');
    const sid = 5337;
    const vanilla = mcData.blocksByStateId[sid];
    ok('原版表里 5337 是 crimson_hanging_sign', vanilla && vanilla.name === 'crimson_hanging_sign', vanilla && vanilla.name);
    const lad = mcData.blocksByName['ladder'];
    ok('原版 ladder 区间不含 5337', !(sid >= lad.minStateId && sid <= lad.maxStateId),
      `${lad.minStateId}..${lad.maxStateId}`);
    ok('原版 ladder 区间是 4654..4661', lad.minStateId === 4654 && lad.maxStateId === 4661,
      `${lad.minStateId}..${lad.maxStateId}`);
  }

  // --- 10. 属性渲染稳定
  {
    ok('属性渲染按 key 排序', formatProps({ open: 'true', facing: 'north' }) === 'facing=north,open=true');
    ok('空属性渲染成空串', formatProps({}) === '');
    ok('null 渲染成空串', formatProps(null) === '');
  }

  // --- 11. 碰撞形状：编解码往返（纯函数）
  {
    const full = [[0, 0, 0, 1, 1, 1]];
    ok('整格 → `.`', encodeShape(full) === '.');
    ok('无碰撞 → `-`', encodeShape([]) === '-');
    ok('读不到 → `?`', encodeShape(null) === '?');
    ok('`.` 解回整格', JSON.stringify(decodeShape('.')) === '[[0,0,0,1,1,1]]');
    ok('`-` 解回空数组（不是 null）', Array.isArray(decodeShape('-')) && decodeShape('-').length === 0);
    ok('`?` 解回 null（读不到 ≠ 没有）', decodeShape('?') === null);
    ok('半砖精确写出 0.5', encodeShape([[0, 0, 0, 1, 0.5, 1]]) === '0:0:0:1:0.5:1');
    ok('13/32 精确写出（二进制小数不掉精度）',
      encodeShape([[0, 0.40625, 0.40625, 1, 0.59375, 0.59375]]) === '0:0.40625:0.40625:1:0.59375:0.59375');
    ok('多个箱子用 + 连', encodeShape([[0, 0, 0, 1, 1, 0.5], [0, 0.5, 0.5, 1, 1, 1]]) === '0:0:0:1:1:0.5+0:0.5:0.5:1:1:1');
    ok('坏串解回 null', decodeShape('1:2:3') === null && decodeShape('a:b:c:d:e:f') === null);
  }

  // --- 12. 逐 state 的方块内形状表
  {
    const full = [[0, 0, 0, 1, 1, 1]];
    const slab = [[0, 0, 0, 1, 0.5, 1]];
    ok('全同形 → 只写一个 def（不带表）', encodeShapes([full, full, full, full]) === '.');
    ok('全同形解回来 4 条', JSON.stringify(decodeShapes('.', 4)) === JSON.stringify([full, full, full, full]));
    ok('两种形状 → 表 + 索引', encodeShapes([full, slab, full, slab]) === '.;0:0:0:1:0.5:1~0101');
    ok('表 + 索引解回来一致',
      JSON.stringify(decodeShapes('.;0:0:0:1:0.5:1~0101', 4)) === JSON.stringify([full, slab, full, slab]));
    ok('条数对不上 → null（错位一格比没有更糟）', decodeShapes('.;0:0:0:1:0.5:1~01', 4) === null);
    ok('索引越界 → null', decodeShapes('.~0z', 2) === null);
    ok('空列 / `?` → null（读不到）', decodeShapes('', 3) === null && decodeShapes('?', 3) === null);
    ok('全是读不到 → 整块 `?`', encodeShapes([null, null]) === '?');
    ok('混着来：读不到的 state 在索引位上写 `?`',
      encodeShapes([full, null, full]) === '.~0?0');
    ok('混着来解回来：那一位是 null（读不到）',
      JSON.stringify(decodeShapes('.~0?0', 3)) === JSON.stringify([full, null, full]));
    ok('表里出现坏 def → null', decodeShapes('.;1:2:3~00', 2) === null);
    // 缓存：整表 826k 个 state 但形状种类很少，必须共用同一份数组，否则内存爆掉。
    // ⚠️ 代价是"返回的数组是共享的、调用方不得就地改" —— 和 minecraft-data 的约定一致。
    {
      const a = decodeShapes('.', 3);
      const b = decodeShapes('.', 5);
      ok('同一形状跨方块共用一份数组（826k state 的内存前提）', a[0] === b[0]);
      const c = decodeShapes('.;0:0:0:1:0.5:1~0101', 4);
      const d = decodeShapes('.;0:0:0:1:0.5:1~0101', 4);
      ok('同一张表也共用', c[1] === d[1]);
      ok('共享不影响取值', JSON.stringify(c) === JSON.stringify(d) && c[1][0][4] === 0.5);
      const n1 = decodeShapes('.~0?0', 3);
      const n2 = decodeShapes('.~0?0', 3);
      ok('"读不到"（null）也缓存，不会变成新对象', n1[1] === null && n2[1] === null);
    }
  }

  // --- 13. parseDump 认第 6 列 + 向后兼容
  {
    const withShape = '0|0|1|minecraft:air|0|-\n' +
      '196|4654|8|minecraft:ladder|facing:north,south,west,east;waterlogged:false,true|0:0:0:0.8125:1:1';
    const r = parseDump(withShape);
    ok('6 列：air 是"知道没有碰撞"', r.entries[0].shapes.length === 1 && r.entries[0].shapes[0].length === 0);
    ok('6 列：梯子逐 state 解出 8 条', r.entries[1].shapes.length === 8, r.entries[1].shapes && r.entries[1].shapes.length);
    ok('6 列：梯子的箱子是 0.8125（实测值）',
      JSON.stringify(r.entries[1].shapes[0]) === '[[0,0,0,0.8125,1,1]]');
    ok('6 列：没有 shapeIssues', r.shapeIssues.length === 0, JSON.stringify(r.shapeIssues));

    const old5 = parseDump('0|0|1|minecraft:air|\n196|4654|8|minecraft:ladder|facing:north,south,west,east');
    ok('旧 5 列 dump 仍然能解析（向后兼容）', old5.entries.length === 2);
    ok('旧 5 列 → shapes = null（"读不到"，不是"没有碰撞"）', old5.entries.every(e => e.shapes === null));
    ok('旧 5 列不产生 shapeIssues', old5.shapeIssues.length === 0);

    const bad = parseDump('1|1|4|mod:thing||.~01');       // 4 个 state 只给了 2 个索引
    ok('条数对不上 → shapes 作废（退回按名字猜）', bad.entries[0].shapes === null);
    ok('条数对不上会被记进 shapeIssues（"导了但不可信"要报出来）',
      bad.shapeIssues.length === 1 && bad.shapeIssues[0].entries === 2, JSON.stringify(bad.shapeIssues));
  }

  // --- 14. lookupState 把"读不到"和"没有碰撞"分开
  {
    const idx = buildIndex(parseDump(
      '0|0|1|minecraft:air|0|-\n' +
      '1|1|2|mod:thing|a:x,y|.;0:0:0:1:0.5:1~01\n' +
      '2|3|1|mod:unknown|a:z|').entries);
    ok('air：知道没有碰撞', lookupState(idx, 0).shapeKnown === true && lookupState(idx, 0).shape.length === 0);
    ok('mod:thing 第 0 态是整格', lookupState(idx, 1).shapeKnown === true && lookupState(idx, 1).shape.length === 1);
    ok('mod:thing 第 1 态是半砖', lookupState(idx, 2).shapeKnown === true && lookupState(idx, 2).shape[0][4] === 0.5);
    ok('mod:unknown：读不到（shapeKnown=false）', lookupState(idx, 3).shapeKnown === false && lookupState(idx, 3).shape === null);
    ok('旧表（没有形状列）→ 全都 shapeKnown=false', lookupState(buildIndex(parseDump('0|0|1|minecraft:air|').entries), 0).shapeKnown === false);
  }

  // --- 15. 拿原版真实形状做全量往返 —— 这才是"测跑的那份代码"
  //     prismarine-registry 的形状要 prismarine-block 挂上才有（它会往 blocksByStateId 里补 shapes/stateShapes）。
  {
    const reg = require('prismarine-registry')('1.20.1');
    require('prismarine-block')(reg);
    let blocks = 0; let states = 0; let holes = 0; let mismatch = 0; let bytes = 0; let fallback = 0;
    for (const name of Object.keys(reg.blocksByName)) {
      const b = reg.blocksByName[name];
      const base = reg.blocksByStateId[b.minStateId];
      const n = b.maxStateId - b.minStateId + 1;
      const ss = base.stateShapes;
      const shapes = [];
      for (let i = 0; i < n; i++) {
        // stateShapes 只在"各 state 形状不同"时才存在；缺项按默认形状算
        const sh = (Array.isArray(ss) && ss[i] !== undefined) ? ss[i] : base.shapes;
        if (sh === undefined) holes++;
        shapes.push(sh);
      }
      const spec = encodeShapes(shapes);
      if (spec[0] === '!') fallback++;
      bytes += spec.length;
      const back = decodeShapes(spec, n);
      if (JSON.stringify(back) !== JSON.stringify(shapes)) mismatch++;
      blocks++; states += n;
    }
    ok(`原版 ${blocks} 个方块 / ${states} 个 state 往返全部一致`, mismatch === 0, `${mismatch} 个不一致`);
    ok('没有 state 拿不到形状（stateShapes 不缺项）', holes === 0, `${holes} 个缺项`);
    ok('压缩有效：平均 < 12 字符/state', bytes / states < 12, (bytes / states).toFixed(2));
    console.log(`     形状列实测：原版 ${states} 个 state → ${bytes} 字符（${(bytes / 1024).toFixed(0)} KB，`
      + `平均 ${(bytes / states).toFixed(2)} 字符/state，>62 种形状走兜底的方块 ${fallback} 个）`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = {
  parsePropSpec,
  normalizeDumpText,
  parseDump,
  buildIndex,
  decodeProps,
  lookupState,
  findBlock,
  climbableStateIds,
  formatProps,
  // 碰撞形状（第 6 列）
  FULL_CUBE_BOX,
  SHAPE_INDEX_ALPHABET,
  encodeShape,
  decodeShape,
  encodeShapes,
  decodeShapes,
  shapeEntryCount,
  selftest
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
