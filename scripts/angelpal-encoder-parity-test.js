/**
 * angelpal-encoder-parity-test.js —— 钉住"形状列编码在两边逐字节一致"。
 *
 * ## 为什么需要它
 *
 * 形状列的编码**不可避免地写了两份**：
 *   · `block-palette.js` 的 `encodeShapes` —— 导入端（Node）解析用；
 *   · `registry/zz_angel_dump_block_palette.js` 的 `angelEncodeShapes` —— 导出端
 *     （KubeJS / Rhino，跑在客户端里）生产用。
 * 两份必须**逐字节一致**，否则导入端解出来的形状会整片错位 —— 而错位的形状
 * 比"没有形状"危险得多（前者会静默给出错的碰撞箱）。
 *
 * 所以这里做的不是"再写一遍编码逻辑做对比"（那只是把 bug 抄第三遍），而是：
 *   1. **把真正的那个 .js 文件加载进 vm 里**（用桩把 `Client`/`Utils`/`BlockPos`/
 *      `global`/`setInterval` 顶掉），拿到的就是游戏里会跑的那份函数；
 *   2. 用**原版 1003 个方块 / 24135 个 state 的真实形状**全量对拍；
 *   3. 再补一批边界用例（空碰撞 / 多箱 / 非 1/16 网格 / 读不到 / 超 62 种形状）。
 *
 * ⚠️ 这是"自测要测真正跑的那份代码"（AGENTS.md 5.4）在跨语言场景下的写法：
 *    不能 require，就用 vm 把源码原样加载进来。
 *
 * 跑法：`$NODE scripts/angelpal-encoder-parity-test.js`
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'registry', 'zz_angel_dump_block_palette.js');
const palette = require('../block-palette.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
};

/**
 * 把导出脚本加载进一个隔离的 vm 上下文。
 *
 * 桩必须够真到"脚本能跑完顶层那一段"，但**不能**替它实现形状逻辑 ——
 * 我们要测的就是它自己的形状逻辑。
 */
function loadExporter () {
  const sandbox = {
    // ---- 绑定桩：只求顶层那段注册代码能跑完 ----
    Utils: {
      id: (a, b) => `${a}:${b}`,
      getRegistry: () => ({
        entrySet: () => ({ iterator: () => ({ hasNext: () => false, next: () => null }) }),
        getValue: () => null,
        getVanillaRegistry: () => null,
      }),
    },
    Client: { level: null },              // 没进世界 → angelTick 什么都不做
    BlockPos: function BlockPos (x, y, z) { this.x = x; this.y = y; this.z = z; },
    global: {},
    setInterval: () => 1,                 // 不真的起定时器
    clearInterval: () => {},
    console: { info: () => {} },          // 静音：这个测试只看纯函数
    Math, Object, String, Number, Array, JSON, Boolean, Error, isNaN, parseInt, parseFloat,
  };
  sandbox.global = sandbox;               // 脚本里用 `global.__angelDump`
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
  return sandbox;
}

console.log('--- 0. 加载导出脚本（vm，桩掉游戏绑定） ---');
const ex = loadExporter();
ok('拿到 angelEncodeShapes', typeof ex.angelEncodeShapes === 'function');
ok('拿到 angelEncodeShape', typeof ex.angelEncodeShape === 'function');
ok('拿到 angelBoxOf', typeof ex.angelBoxOf === 'function');
ok('拿到 angelBoxesOf', typeof ex.angelBoxesOf === 'function');
ok('拿到 angelProbe', typeof ex.angelProbe === 'function');
ok('拿到 angelPropSpec', typeof ex.angelPropSpec === 'function');
ok('拿到 angelTick / angelSetup', typeof ex.angelTick === 'function' && typeof ex.angelSetup === 'function');

/** 数字形状 → 导出脚本要的字符串形状（模拟它从 AABB 字段读到的东西）。 */
const toStrBoxes = (boxes) => boxes.map(b => b.map(v => String(v)));

console.log('\n--- 1. 空 / 整格 / 多箱 / 非 1/16 网格 ---');
{
  const cases = [
    ['空碰撞', []],
    ['整格', [[0, 0, 0, 1, 1, 1]]],
    ['半砖', [[0, 0, 0, 1, 0.5, 1]]],
    ['梯子 3/16', [[0, 0, 0, 0.8125, 1, 1]]],
    ['13/32（非 1/16 网格）', [[0, 0.40625, 0.40625, 1, 0.59375, 0.59375]]],
    ['24 = 1.5 格高', [[0.375, 0, 0, 0.625, 1.5, 0.625]]],
    ['多箱（栅栏孤立）', [[0, 0, 0.375, 1, 1.5, 0.625], [0.375, 0, 0, 0.625, 1.5, 0.375]]],
    ['-0 要写成 0', [[-0, 0, 0, 1, 1, 1]]],
  ];
  for (const [label, boxes] of cases) {
    const a = ex.angelEncodeShape(toStrBoxes(boxes));
    const b = palette.encodeShape(boxes);
    ok(`def 一致：${label}`, a === b, `导出端 ${a} / 导入端 ${b}`);
  }
}

console.log('\n--- 2. 逐 state 一列：与 block-palette.encodeShapes 逐字节对拍 ---');
{
  const full = [[0, 0, 0, 1, 1, 1]];
  const slab = [[0, 0, 0, 1, 0.5, 1]];
  const cases = [
    ['全整格', [full, full, full]],
    ['全空', [[], [], []]],
    ['两种形状', [full, slab, full, slab]],
    ['一个读不到', [full, null, full]],
    ['全读不到', [null, null]],
    ['混空与整格', [[], full, []]],
    ['非 1/16 网格', [[[0, 0.40625, 0.40625, 1, 0.59375, 0.59375]], full]],
  ];
  for (const [label, shapes] of cases) {
    const a = ex.angelEncodeShapes(shapes.map(s => (s === null ? null : toStrBoxes(s))));
    const b = palette.encodeShapes(shapes);
    ok(`列一致：${label}`, a === b, `导出端 ${a} / 导入端 ${b}`);
  }
}

console.log('\n--- 3. 形状种类 > 62 的兜底（`!` 形态）---');
{
  // 造 70 种互不相同的形状：每个箱子高度不同
  const shapes = [];
  for (let i = 0; i < 70; i++) shapes.push([[0, 0, 0, 1, (i + 1) / 100, 1]]);
  const a = ex.angelEncodeShapes(shapes.map(toStrBoxes));
  const b = palette.encodeShapes(shapes);
  ok('>62 种走 `!` 兜底且两边一致', a === b && a[0] === '!', `${a.slice(0, 40)}… / ${b.slice(0, 40)}…`);
  ok('兜底形态能被导入端解回来（70 条）',
    JSON.stringify(palette.decodeShapes(b, 70)) === JSON.stringify(shapes));
}

console.log('\n--- 4. 全量对拍：原版 1003 个方块 / 24135 个 state ---');
{
  const reg = require('prismarine-registry')('1.20.1');
  require('prismarine-block')(reg);
  let blocks = 0;
  let states = 0;
  let mismatch = 0;
  let bytesA = 0;
  let bytesB = 0;
  const bad = [];
  for (const name of Object.keys(reg.blocksByName)) {
    const b = reg.blocksByName[name];
    const base = reg.blocksByStateId[b.minStateId];
    const n = b.maxStateId - b.minStateId + 1;
    const ss = base.stateShapes;
    const shapes = [];
    for (let i = 0; i < n; i++) {
      const sh = (Array.isArray(ss) && ss[i] !== undefined) ? ss[i] : base.shapes;
      shapes.push(Array.isArray(sh) ? sh : null);
    }
    const a = ex.angelEncodeShapes(shapes.map(s => (s === null ? null : toStrBoxes(s))));
    const b2 = palette.encodeShapes(shapes);
    if (a !== b2) {
      mismatch++;
      if (bad.length < 5) bad.push(name);
    }
    bytesA += a.length;
    bytesB += b2.length;
    blocks++;
    states += n;
  }
  ok(`原版 ${blocks} 个方块 / ${states} 个 state 两边编码完全一致`, mismatch === 0,
    `${mismatch} 个不一致，例：${bad.join(', ')}`);
  ok('两边的字节数也相同（长度一致是最便宜的判据）', bytesA === bytesB, `${bytesA} / ${bytesB}`);
  console.log(`     实测：${states} 个 state → 导出端 ${bytesA} 字符（${(bytesA / 1024).toFixed(0)} KB，`
    + `平均 ${(bytesA / states).toFixed(2)} 字符/state）`);

  // 反向：导出端产出的列，导入端必须能解回来
  let roundTrip = 0;
  let rtBad = 0;
  for (const name of ['oak_fence', 'cobblestone_wall', 'iron_bars', 'oak_stairs', 'ladder', 'snow']) {
    const b = reg.blocksByName[name];
    const base = reg.blocksByStateId[b.minStateId];
    const n = b.maxStateId - b.minStateId + 1;
    const ss = base.stateShapes;
    const shapes = [];
    for (let i = 0; i < n; i++) {
      const sh = (Array.isArray(ss) && ss[i] !== undefined) ? ss[i] : base.shapes;
      shapes.push(Array.isArray(sh) ? sh : null);
    }
    const spec = ex.angelEncodeShapes(shapes.map(toStrBoxes));
    const back = palette.decodeShapes(spec, n);
    roundTrip++;
    if (JSON.stringify(back) !== JSON.stringify(shapes)) { rtBad++; console.log('     不一致:', name); }
  }
  ok(`${roundTrip} 个"形状随 state 变"的方块：导出端产物能被导入端解回原样`, rtBad === 0, `${rtBad} 个不一致`);
}

console.log('\n--- 5. angelBoxesOf 的接线（假 AABB / 假 toAabbs）---');
{
  // 忠实模仿 Java 侧：AABB 有 minX..maxZ 六个 double 字段；toAabbs 返回一个
  // java.util.List（有 iterator()/hasNext()/next()）。
  const fakeAabb = (a, b, c, d, e, f) => ({
    minX: a, minY: b, minZ: c, maxX: d, maxY: e, maxZ: f,
  });
  const fakeList = (arr) => {
    let i = 0;
    return { iterator: () => ({ hasNext: () => i < arr.length, next: () => arr[i++] }) };
  };
  const state = (boxes) => ({
    getCollisionShape: (level, pos) => ({
      toAabbs: () => fakeList(boxes.map(bx => fakeAabb(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5]))),
    }),
  });

  ok('空形状 → 空数组', JSON.stringify(ex.angelBoxesOf(state([]), {}, {})) === '[]');
  ok('整格 → 六个 "0"/"1"',
    JSON.stringify(ex.angelBoxesOf(state([[0, 0, 0, 1, 1, 1]]), {}, {})) === JSON.stringify([['0', '0', '0', '1', '1', '1']]));
  ok('多箱按顺序取全（栅栏两个箱子）',
    JSON.stringify(ex.angelBoxesOf(state([[0, 0, 0.375, 1, 1.5, 0.625], [0.375, 0, 0, 0.625, 1.5, 0.375]]), {}, {}))
      === JSON.stringify([['0', '0', '0.375', '1', '1.5', '0.625'], ['0.375', '0', '0', '0.625', '1.5', '0.375']]));
  // 字段名写错（比如把 minX 写成 minx）会变成 undefined → 编码成 "undefined"，
  // 这一条就是钉住"六个字段名一个都不能错"。
  ok('字段名写错会立刻暴露（不会静默通过）',
    ex.angelEncodeShape(ex.angelBoxesOf(state([[0, 0, 0, 1, 1, 1]]), {}, {})) === '.');
}

console.log('\n--- 6. angelProbe：三个已知答案 + 失败要如实报 ---');
{
  const fakeAabb = (a, b, c, d, e, f) => ({ minX: a, minY: b, minZ: c, maxX: d, maxY: e, maxZ: f });
  const fakeList = (arr) => {
    let i = 0;
    return { iterator: () => ({ hasNext: () => i < arr.length, next: () => arr[i++] }) };
  };
  const mkReg = (shapesByName) => ({
    getValue: (id) => {
      const short = String(id).split(':').pop();
      const boxes = shapesByName[short];
      if (!boxes) return null;
      return {
        defaultBlockState: () => ({
          getCollisionShape: () => ({
            toAabbs: () => fakeList(boxes.map(bx => fakeAabb(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5]))),
          }),
        }),
      };
    },
  });
  const pos = { x: 0, y: 1000, z: 0 };

  const good = ex.angelProbe({}, mkReg({
    stone: [[0, 0, 0, 1, 1, 1]],
    air: [],
    ladder: [[0, 0, 0, 0.8125, 1, 1]],
  }), pos);
  ok('三个都对 → probe.ok 为真', good.ok === true, good.text);
  ok('探针文本里带三个用例的实测值', /stone=\./.test(good.text) && /air=-/.test(good.text) && /ladder=0:0:0:0\.8125:1:1/.test(good.text), good.text);

  const bad = ex.angelProbe({}, mkReg({
    stone: [[0, 0, 0, 1, 1, 1]],
    air: [],
    ladder: [[0, 0, 0, 1, 1, 1]],       // 梯子报成整格 → 形状链显然没接对
  }), pos);
  ok('梯子答错 → probe.ok 为假', bad.ok === false, bad.text);
  ok('答错的用例带 ✗ 和期望值', /✗期望0:0:0:0\.8125:1:1/.test(bad.text), bad.text);

  const missing = ex.angelProbe({}, mkReg({}), pos);
  ok('方块取不到 → 也算不过（不会静默放过）', missing.ok === false, missing.text);
  ok('取不到时如实写"(方块不存在)"', /stone=\(方块不存在\)/.test(missing.text), missing.text);
}

console.log('\n--- 7. angelPropSpec：属性顺序 = state id 展开顺序 ---');
{
  const fakeProp = (name, values) => ({
    getName: () => name,
    getPossibleValues: () => {
      let i = 0;
      return { iterator: () => ({ hasNext: () => i < values.length, next: () => values[i++] }) };
    },
  });
  const mkDef = (props) => {
    let i = 0;
    return { getProperties: () => ({ iterator: () => ({ hasNext: () => i < props.length, next: () => props[i++] }) }) };
  };
  const spec = ex.angelPropSpec(mkDef([
    fakeProp('facing', ['north', 'south', 'west', 'east']),
    fakeProp('waterlogged', ['true', 'false']),
  ]));
  ok('属性规格格式与 dump 一致', spec === 'facing:north,south,west,east;waterlogged:true,false', spec);
  ok('没有属性 → 空串（不是 "?"）', ex.angelPropSpec(mkDef([])) === '', JSON.stringify(ex.angelPropSpec(mkDef([]))));
  // 与导入端对拍：同一串解析出来的属性表必须一样
  const parsed = palette.parsePropSpec(spec);
  ok('导入端解出 2 个属性、取值逐字一致',
    parsed.length === 2 && parsed[0].key === 'facing' && parsed[1].values.join(',') === 'true,false',
    JSON.stringify(parsed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
