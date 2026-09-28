#!/usr/bin/env node
'use strict';
/**
 * bridge-reload-test.js —— 拆开后的 bridge，各文件在 loadDependencies() 之后能不能读到真值。
 *
 * 为什么要有（2026-09-28 第 3 步 c 验收时抓到的）：`Vec3` / `goals` / 插件变量是在
 * `main()` → `loadDependencies()` 里才赋值的；拆文件后各路由文件用 `let X;` 占位、靠 rebind 抄值。
 * 当时 connect.js 把访问器装在了**自己**的 __ns 上，server.js 的那份没有 ——
 * rebind 抄到的全是 undefined，`/mine` `/move` `/pickup` 一跑 `new Vec3` / `goals.GoalNear` 就炸。
 * 离线自测、routes 快照、check-scope 全都是绿的，只有真跑 loadDependencies 才看得见。
 *
 * 做法：require 时给 src/bridge 下每个文件尾部追加一个探针（读它自己作用域里的这些变量），
 * 走 main() 同一条路调一次 loadDependencies()，断言：凡是**声明了** `let X` 的文件，X 都不再是 undefined。
 * 不连服务器、不起 HTTP（只 require + loadDependencies）。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge');
// loadDependencies() 里一定会赋值的（插件变量没装时是 null，也算拿到了）
const VARS = ['mineflayer', 'pathfinderPlugin', 'Movements', 'goals', 'Vec3', 'autoEatPlugin', 'toolPlugin', 'collectBlockPlugin'];

const declared = new Map();   // 文件 → 它用 let 声明了哪些
const orig = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.startsWith(BRIDGE + path.sep) && !filename.endsWith(path.sep + 'server.js')) {
    const mine = VARS.filter(v => new RegExp(`^let [^;=]*\\b${v}\\b`, 'm').test(content));
    if (mine.length) {
      declared.set(filename, mine);
      content += `\nmodule.exports.__peek = () => ({ ${mine.map(v => `${v}: ${v} === undefined ? 'undefined' : 'ok'`).join(', ')} });\n`;
    }
    if (filename.endsWith(path.sep + 'http.js')) content += '\nmodule.exports.__load = () => loadDependencies();\n';
  }
  return orig.call(this, content, filename);
};

require(path.join(ROOT, 'bridge-server.js'));
require.cache[require.resolve(path.join(BRIDGE, 'http.js'))].exports.__load();   // main() 里就是这一行

let pass = 0, fail = 0;
for (const [file, vars] of declared) {
  const got = require.cache[file].exports.__peek();
  for (const v of vars) {
    const rel = path.relative(ROOT, file);
    if (got[v] === 'ok') { pass++; console.log(`  PASS  ${rel} 读得到 ${v}`); }
    else { fail++; console.log(`  FAIL  ${rel} 的 ${v} 在 loadDependencies() 之后还是 undefined`); }
  }
}
if (!declared.size) { fail++; console.log('  FAIL  一个声明了可重赋值变量的文件都没找到（探针没装上？）'); }
console.log(`\n  ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
