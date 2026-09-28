#!/usr/bin/env node
'use strict';

/**
 * routes-test.js —— 路由清单契约测试（不连服务器）。
 *
 * ## 为什么这个测试是第 0 步的核心
 *
 * `bridge-server.js` 一 require 就连服务器（重构前），所以它那 58 条路由
 * **一条都没有测试** —— 今天好几个 bug（/mine 名字解析、/pickup 预算）
 * 都只能上实机才发现。第 0 步把"起服务 + 连服务器"收进 main() 之后，
 * 这个模块终于可以被 require，于是能离线断言：
 *
 *   ① 每条路由的值都是函数（不是被 `...` 覆盖成 undefined、不是拼错的字符串键）；
 *   ② 路由集合与快照 `references/routes.json` **逐条一致**（多了少了都失败）。
 *
 * 为什么必须钉快照：拆巨石（第 3 步）时路由要从 `hands.js` 拆进 `src/body/*.js`。
 * 拆的过程中**最容易发生的事就是丢一条路由**（复制漏一行、键盘名打错），
 * 而丢一条路由不会让任何现有测试变红 —— 只有实机调用时才发现 404。
 * 快照把"路由增减"变成必须显式确认的动作。
 *
 * ## 怎么拿到三条来源
 *
 * `handlers` 是 bridge 自带 58 条 + hands.routes() 75 条 + commonsense.routes() 5 条
 * **Object.assign** 在一起的。要区分来源，这里重新各调一次那两个 `routes()`
 * （纯函数、无副作用），看某个 key 属于谁。bridge 的那些就是 `handlers` 里
 * 扣掉后两组剩下的。
 *
 * 用法：
 *   node scripts/routes-test.js            # 比对快照
 *   node scripts/routes-test.js --update   # 重新生成快照（路由有意增减时）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'references', 'routes.json');

const UPDATE = process.argv.includes('--update');

let pass = 0; let fail = 0;
function ok (name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
}

// ---- 收集当前路由 ----------------------------------------------------------

/**
 * 返回 `[{ key, source }]`，按 key 排序。
 * source ∈ 'bridge' | 'hands' | 'commonsense'。
 */
function collectRoutes () {
  // 注意：require bridge **不连服务器**（第 3 条重构保证）。这里只要它的 handlers。
  const bridge = require(path.join(ROOT, 'src', 'bridge', 'server.js'));
  const hands = require(path.join(ROOT, 'src', 'body', 'hands.js'));
  const commonsense = require(path.join(ROOT, 'src', 'body', 'commonsense.js'));

  const handRoutes = hands.routes({ state: bridge.state, withTimeout: bridge.withTimeout });
  const csRoutes = commonsense.routes({ state: bridge.state });

  const sourceOf = new Map();
  for (const k of Object.keys(handRoutes)) sourceOf.set(k, 'hands');
  for (const k of Object.keys(csRoutes)) sourceOf.set(k, 'commonsense');
  // bridge 自己的：handlers 里有、但不属于 hands / commonsense 的
  for (const k of Object.keys(bridge.handlers)) if (!sourceOf.has(k)) sourceOf.set(k, 'bridge');

  const all = Object.keys(bridge.handlers).map(k => ({ key: k, source: sourceOf.get(k) || 'bridge' }));
  all.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { routes: all, bridge, handRoutes, csRoutes };
}

console.log('routes-test：路由清单契约（离线，不连服务器）');

const { routes, bridge, handRoutes, csRoutes } = collectRoutes();

// ---- 断言 1：每条都是函数 --------------------------------------------------

const notFn = Object.entries(bridge.handlers).filter(([, v]) => typeof v !== 'function');
ok('handlers 里每条路由都是函数', notFn.length === 0,
  notFn.map(([k, v]) => `${k}=${typeof v}`).join(', '));

// ---- 断言 2：三条来源的数量（这不是硬编码，是"哪一层少了一半"的早期信号）----
//
// 数字不写死成 58 / 75 / 5 —— 那样加一条路由就要改测试。这里只断言"三层都非空"，
// 具体数量交给快照。真正会把数量变化钉住的是下面第 3 条。
const bySource = { bridge: 0, hands: 0, commonsense: 0 };
for (const r of routes) bySource[r.source]++;
ok('bridge 自带路由非空', bySource.bridge > 0, bySource.bridge);
ok('hands 路由非空', bySource.hands > 0, bySource.hands);
ok('commonsense 路由非空', bySource.commonsense > 0, bySource.commonsense);
console.log(`  来源分布：bridge=${bySource.bridge} · hands=${bySource.hands} · commonsense=${bySource.commonsense} · 合计=${routes.length}`);

// ---- 断言 3：与快照逐条比对 ------------------------------------------------

if (UPDATE) {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(routes, null, 2) + '\n');
  console.log(`\n  ✓ 快照已写入 ${path.relative(ROOT, SNAPSHOT)}（${routes.length} 条）`);
  console.log(`\n  ${pass} 通过${fail ? `，${fail} 失败` : ''}`);
  process.exit(fail ? 1 : 0);
}

if (!fs.existsSync(SNAPSHOT)) {
  console.log(`\n  ✗ 快照不存在：${path.relative(ROOT, SNAPSHOT)}`);
  console.log('    第一次运行请用 --update 生成。');
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const snapMap = new Map(snapshot.map(r => [r.key, r.source]));
const curMap = new Map(routes.map(r => [r.key, r.source]));

const added = routes.filter(r => !snapMap.has(r.key));
const removed = snapshot.filter(r => !curMap.has(r.key));
const changedSource = routes.filter(r => snapMap.has(r.key) && snapMap.get(r.key) !== r.source)
  .map(r => `${r.key}: ${snapMap.get(r.key)} → ${r.source}`);

if (added.length) console.log(`  ✗ 新增路由（快照里没有）：\n      ${added.map(r => `${r.key} [${r.source}]`).join('\n      ')}`);
if (removed.length) console.log(`  ✗ 丢失路由（当前没有）：\n      ${removed.map(r => `${r.key} [${r.source}]`).join('\n      ')}`);
if (changedSource.length) console.log(`  ✗ 来源变了：\n      ${changedSource.join('\n      ')}`);

ok('路由集合与快照一致（无新增 / 无丢失 / 来源不变）',
  added.length === 0 && removed.length === 0 && changedSource.length === 0,
  `+${added.length} / -${removed.length} / ~${changedSource.length}`);

ok('快照条数 = 当前条数', snapshot.length === routes.length, `${snapshot.length} vs ${routes.length}`);

// ---- 断言 4：bridge 自有路由的**键序**（第 3 步拆巨石的防线，只加不减）--------
//
// 上面第 3 条把 `routes` **按 key 排序**后才比对（第 71 行 `all.sort(…)`），
// 因此它只保证"集合相同"，**不保证顺序**。而 `Object.keys(handlers)` 的顺序
// 是被依赖的：`GET /404` 的 `available` 字段直接吐这个数组。
//
// 拆巨石后 handlers 是"按 routeFiles 数组顺序逐组 Object.assign"拼回来的，
// 一旦分组顺序写错，键序就变、但**条数不变** —— 只查集合抓不到。
// 所以这里额外锚定 bridge 自己那 58 个键的相对次序（hands/commonsense 的键
// 排在它们之后，不参与比对）。
//
// ⚠️ 快照不存在时**跳过而不是失败**：这份文件是第 3 步新增的，
//    老分支上可能还没有；缺了就少一道防线，不该把测试拉红。
const orderSnapPath = path.join(ROOT, 'references', 'handlers-order-bridge.json');
let orderOk = true;
if (fs.existsSync(orderSnapPath)) {
  const wantOrder = JSON.parse(fs.readFileSync(orderSnapPath, 'utf8'));
  const liveKeys = Object.keys(bridge.handlers);
  const misplaced = [];
  let prev = -1;
  for (const k of wantOrder) {
    const at = liveKeys.indexOf(k);
    if (at < 0) { misplaced.push(`${k}（没了）`); continue; }
    if (at < prev) misplaced.push(`${k}（顺序后移）`);
    prev = at;
  }
  orderOk = misplaced.length === 0;
  ok('bridge 自有路由的键序与快照一致', orderOk,
    misplaced.length ? misplaced.slice(0, 5).join(', ') : '');
} else {
  console.log('  (跳过键序校验：references/handlers-order-bridge.json 不存在)');
}

console.log(`\n  ${pass}/${pass + fail} 通过（快照 ${snapshot.length} 条 / 当前 ${routes.length} 条）`);
if (fail) {
  console.log('\n  路由有意增减时：node scripts/routes-test.js --update，然后提交 references/routes.json');
}
process.exit(fail ? 1 : 0);
