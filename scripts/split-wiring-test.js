#!/usr/bin/env node
'use strict';
/**
 * split-wiring-test.js —— 第 3 步拆出来的文件之间，转发壳有没有接到真东西。
 *
 * 为什么要有（2026-09-29 上线后抓到）：拆分工具给跨文件的名字生成转发壳
 *   `function X (...a) { return __ns.X.apply(null, a); }`
 * 但有些 X 根本没有任何文件导出（原来是从 place.js 解构来的 DEADLY / findStandY / reachableStandY；
 * DEADLY 还是个正则，被做成了函数），调用时才炸 `Cannot read properties of undefined (reading 'apply')`。
 * 反过来，也有文件用了兄弟文件的函数却没生成转发壳（containers.js 的 `...summarizeWindow(...)`），
 * 调用时 `is not defined`。离线测试走不到这些行。
 *
 * 两条断言（对 src/body、src/instinct、src/bridge、src/bridge/routes）：
 *   ① 每个 `__ns.X.apply` 的 X，都有某个已加载模块导出了它；
 *   ② 每个文件里以 `X(` / `...X(` 调用、且 X 是某个兄弟文件导出的函数名 —— 本文件必须有 X 的声明（函数 / 转发壳 / const / let / 解构）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src/body', 'src/instinct', 'src/bridge', 'src/bridge/routes', 'src/world/pathing'].map(d => path.join(ROOT, d));
// 这几个目录里不是拆分产物、自己独立的老文件（它们的名字恰好和别人重名也不算）
const STANDALONE = new Set(['commonsense.js', 'equip-policy.js', 'storage-policy.js', 'inventory-ledger.js', 'ftbq-sync.js', 'body-command-lock.js', 'reconnect.js', 'testkit.js']);

require(path.join(ROOT, 'bridge-server.js'));   // 把三组拆分文件全部加载进 require.cache（不连服务器）

const files = DIRS.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.js')).map(f => path.join(d, f)));
const exported = new Map();   // 名字 → 导出它的文件
for (const f of files) {
  const m = require.cache[f];
  if (m) for (const k of Object.keys(m.exports)) if (!exported.has(k)) exported.set(k, f);
}
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

let pass = 0, fail = 0;
const bad = (msg) => { fail++; console.log(`  FAIL  ${msg}`); };
for (const f of files) {
  if (STANDALONE.has(path.basename(f))) continue;
  const rel = path.relative(ROOT, f);
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  // ① 转发壳的目标要存在
  for (const m of src.matchAll(/__ns\.([A-Za-z_$][\w$]*)\.apply/g)) {
    if (exported.has(m[1])) pass++; else bad(`${rel}：转发壳 ${m[1]} 没有任何文件导出`);
  }
  // ② 调用了兄弟文件导出的函数，本文件要有声明
  const declared = new Set();
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^=;]+?)\s*[=;]/g)) {
    for (const n of m[1].replace(/[{}[\]]/g, ',').split(',')) { const k = n.split(':').pop().trim(); if (k) declared.add(k); }
  }
  // 函数参数（含解构参数）也算声明，例如 craft2(bot, opts, withTimeout)
  for (const m of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$]*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const n of m[1].replace(/[{}[\]]/g, ',').split(',')) { const k = n.split('=')[0].split(':').pop().replace('...', '').trim(); if (k) declared.add(k); }
  }
  // 对象字面量里的方法简写（`classify (token, errName) {` / `setGoal (g) {` …）也算声明。
  // 为什么补（2026-09-29 第 3 步 3d 抓到的误报）：
  //   `budget.js` 的 `createGoalOwner()` 返回一个字面量，里面有 `classify (token, errName) { … }`
  //   —— 它和 `src/body/inventory-ledger.js` 导出的 `classify` **重名**但无关（兄弟文件要调
  //   后者会写成 `ledger.classify(...)`，带 `.`，下面那条 called 正则本来就不收）。
  //   可 declare 这一侧原来是"只认 bare 的 `function` / `const|let|var` 声明"，
  //   认不出方法简写 —— 于是把它当"用了兄弟函数却没声明/转发壳"报 FAIL。
  //   同样的写法在 `src/body/inventory-ledger.js`（`begin (ev) {`）拆之前就存在，
  //   只是那边恰好没有与之重名的兄弟导出，所以从没触发过。
  //   收束住，只在"行首空白 + 名字 + 空格 + ( + 参数 + ) + 空格*{" 时算，且排除控制流关键字。
  const KEYWORD = /^(if|for|while|switch|catch|return|function|typeof|delete|new|throw|do|else|try|await|yield|in|of|case|void|with|super|class|extends|import|export)$/;
  for (const m of src.matchAll(/^[ \t]+([A-Za-z_$][\w$]*)[ \t]+\([^)]*\)[ \t]*\{/gm)) {
    if (!KEYWORD.test(m[1])) declared.add(m[1]);
  }
  const called = new Set();
  for (const m of src.matchAll(/(?:^|[^.\w$]|\.\.\.)([A-Za-z_$][\w$]*)\s*\(/gm)) called.add(m[1]);
  for (const n of called) {
    const owner = exported.get(n);
    if (!owner || owner === f || typeof require.cache[owner].exports[n] !== 'function') continue;
    if (declared.has(n)) pass++; else bad(`${rel}：调用了 ${n}(…)（${path.relative(ROOT, owner)} 导出），本文件没有声明 / 转发壳`);
  }
}
console.log(`\n  ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
