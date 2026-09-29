#!/usr/bin/env node
'use strict';
/**
 * check-scope.js —— 拆文件后"用到了却没拿到"的名字（2026-09-29，第 3 步 bridge 上线即崩后补的工具）。
 *
 * 拆前那个文件的每个顶层名字（function / const / let / 解构），在拆出来的每个文件里：
 * 被用到了（**包括模板字符串 `${}` 里、`...x` 展开里**），本文件却没有声明 / 转发壳 → 列出来。
 * 当时 WorkBuddy 的同类检查把字符串整段剥掉了，于是漏了 main() 里 `${BRIDGE_VERSION}`。
 *
 * 用法：node scripts/refactor/check-scope.js <拆前 git ref> <拆前文件> <拆后目录>
 *   例：node scripts/refactor/check-scope.js 02f203a src/bridge/server.js src/bridge
 * 输出是"疑似"：注释 / 字符串里的同名单词会误报，逐条看一眼。
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [ref, oldFile, dir] = process.argv.slice(2);
const old = cp.execFileSync('git', ['show', `${ref}:${oldFile}`], { encoding: 'utf8' });
const names = new Set();
for (const m of old.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([^=;]+?)\s*=)/gm)) {
  if (m[1]) names.add(m[1]);
  else for (const n of m[2].replace(/[{}\[\]]/g, ',').split(',')) { const k = n.split(':').pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) names.add(k); }
}
for (const m of old.matchAll(/^let\s+([^;=]+);/gm)) for (const n of m[1].split(',')) names.add(n.trim());
const files = [];
const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } };
walk(dir);
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const declared = new Set();
  for (const m of src.matchAll(/\b(?:function\s*\*?\s*([A-Za-z_$][\w$]*))/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^=;]+?)\s*[=;]/g)) for (const n of m[1].replace(/[{}\[\]]/g, ',').split(',')) { const k = n.split(':').pop().trim(); if (k) declared.add(k); }
  const miss = [];
  for (const n of names) {
    if (declared.has(n)) continue;
    const re = new RegExp(`(^|[^.\\w$'"]|\\.\\.\\.)${n.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*:(?!:))`, 'm');
    if (re.test(src)) miss.push(n);
  }
  if (miss.length) { bad++; console.log(path.relative(process.cwd(), f).padEnd(28), miss.join(' ')); }
}
console.log(bad ? `\n${bad} 个文件有疑似未拿到的名字` : '全部拿到');
