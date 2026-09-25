#!/usr/bin/env node
/**
 * 静态审计：`GET` 端点有没有从 **body** 取参。
 *
 * ## 为什么需要这个脚本
 *
 * HTTP 语义上 `GET` 没有 body（或者说我们不发），参数一律在 **query string** 里。
 * 而 `bridge-server.js` 的分发器是 `handler(args, qs)`：
 * 第一个参数对 POST 是 body、对 GET 是 query（分发器已做合并兜底）。
 *
 * 所以写成 `'GET /x': async ({ id }) => …` 曾经是**静默失效**的：
 * 解构全落默认值，不报错、不抛异常，只是永远用默认参数回答。
 * 2026-09-23 真踩过 —— `/palette/state?id=`、`/palette/block?name=`、
 * `/debug/registry?q=` 三个端点全部形同虚设，而 `name` 恰好有默认值，
 * 把症状掩盖成了"查得到但结果不对"，比直接报错难查得多。
 *
 * 分发器已经加了兜底（GET 时把 query 并进第一个参数），所以这不再是 bug；
 * 但**约定**仍是 GET 写 `(_, q)`。本脚本保证约定不被悄悄破坏。
 *
 * ## 用法
 *
 *   node scripts/audit-get-params.js            # 只报告，不退出非零
 *   node scripts/audit-get-params.js --strict   # 发现违例就退出 1（给 CI/自测用）
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'bridge-server.js');
const strict = process.argv.includes('--strict');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');

// 端点定义形如：  'GET /palette/state': async (_, q) => {
const RE = /^\s*'(GET|POST) (\/[^']*)':\s*async\s*\(\s*([^)]*)\)/;

const violations = [];
const seen = [];

for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(RE);
  if (!m) continue;
  const [, method, route, rawParams] = m;
  const params = rawParams.trim();
  seen.push(`${method} ${route}`);

  // 只审 GET。POST 从 body 取参是对的。
  if (method !== 'GET') continue;

  // 合法写法：
  //   (_, q)        → 从 query 取
  //   ()            → 不取参
  //   (_, qs)       → 同上，换个名字
  // 违例：第一个参数被解构 `({ id })` —— 虽然分发器兜住了，但会误导后来人
  if (/^\{/.test(params)) {
    violations.push({ line: i + 1, route: `GET ${route}`, code: lines[i].trim() });
  }
}

console.log(`审计 ${SRC}`);
console.log(`共 ${seen.length} 个端点定义，其中 GET ${seen.filter(s => s.startsWith('GET')).length} 个`);
console.log('');

if (!violations.length) {
  console.log('✓ 所有 GET 端点都没从 body 取参（约定：(_, q) 或 ()）');
  process.exit(0);
}

console.log(`✗ ${violations.length} 个 GET 端点在第一个参数上解构（约定应为 (_, q)）：`);
for (const v of violations) {
  console.log(`  行 ${v.line}  ${v.route}`);
  console.log(`         ${v.code}`);
}
console.log('');
console.log('说明：分发器已做兜底（GET 时合并 query 到第一参数），所以这些不是运行期 bug；');
console.log('      但会让后来人照抄错的写法。改成 async (_, q) => { const { x } = q || {}; … }。');

process.exit(strict ? 1 : 0);
