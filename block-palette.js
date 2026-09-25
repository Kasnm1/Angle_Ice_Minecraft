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
 * 解析 dump 文本。返回 `{entries, badLines, dupes}`。
 * 一行格式：`blockId|firstStateId|count|name|propSpec`
 */
function parseDump (text) {
  const entries = [];
  const badLines = [];
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
    entries.push({ blockId, first, count, name, props: parsePropSpec(parts[4]) });
  }
  return { entries, badLines, dupes };
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

/** 二分查 stateId。查不到返回 null（绝不猜）。 */
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
      return {
        blockId: e.blockId,
        name: e.name,
        local,
        count: e.count,
        properties: decodeProps(e.props, local)
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
  selftest
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
