#!/usr/bin/env node
'use strict';

/**
 * check-moved.js —— 重构「拆文件」阶段的搬移核对器。
 *
 * ## 它回答的唯一问题
 *
 * REFACTOR-PLAN-20260928 的硬约束第 1 条：**只搬动，不改逻辑**。
 * 拆文件时函数体必须一字不改 —— 但人眼比对 6000 行的 `hands.js` 拆成
 * 十几个文件后还在不在，是做不到的。这个脚本把"一字不改"变成一条可执行的断言：
 *
 *   拆前每个顶层函数 / 路由处理函数的**源码文本**（去掉首尾空白）算一份哈希；
 *   拆后按**函数名**在新文件里找同名函数，比哈希。
 *
 * 报告三种结果：
 *   - `same`    同名函数源码哈希一致 → 搬运无误
 *   - `changed` 同名函数存在但内容变了 → 要么是手滑，要么是偷偷改了逻辑（违规）
 *   - `missing` 拆后找不到这个名字 → 函数在搬运中丢了
 *
 * ## 为什么不用 acorn
 *
 * 任务书要求"看 node_modules 里有没有 acorn；没有就用 node 自带能力 —— **不要装新依赖**"。
 * 这个仓库的 `node_modules/` 里没有 acorn（只有 mineflayer 那条依赖链），
 * 所以这里自带一个**轻量切分器**：只认顶层函数声明、箭头函数常量、对象里的方法
 * 这三种形态，靠**花括号配平**（跳过字符串 / 模板串 / 注释 / 正则）找到函数体末尾。
 *
 * 它**不是**完整 JS 解析器，故意的 —— 越简单越不会在"重构核对"这件事上自己出错。
 * 已知边界（都在下面 selftest 里验证过）：
 *   - 只找**顶层**（花括号深度 0）的函数；对象字面量里的方法会在对象被识别时一并抽出；
 *   - 模板串里的 `${ }` 会当普通字符跳到底（`${` 内若含 `}` 可能提前结束），
 *     但项目里的模板串都不含裸 `}`（用 selftest 的第 4 条钉住这条假设）。
 *
 * ## 用法
 *
 *   # 比对两组文件（前后各一组，路径都相对当前目录）
 *   node scripts/refactor/check-moved.js --before a.js,b.js --after src/x.js,src/y.js
 *
 *   # 约定式：拆前给 git ref + 文件列表，拆后给目录（自动收集目录下所有 .js）
 *   node scripts/refactor/check-moved.js --before <git-ref> --files a.js,b.js --after-dir src/
 *
 * `--before <git-ref>` 时用 `git show <ref>:<file>` 读旧内容，不用先 checkout。
 * 退出码：有 `changed` 或 `missing` → 1；全 `same`（或 --selftest 通过）→ 0。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ============================================================ 轻量切分器

/**
 * 从 `code[i]` 开始，跳过一段"不该被当代码看"的东西（字符串 / 模板串 / 注释 / 正则）。
 * 返回跳过后的下标；`i` 不在这些东西上时返回 `i` 本身。
 *
 * 为什么要单独干这件事：函数体里的 `'}'`（字符串里的花括号）和 `// }`（注释里的）
 * 会把花括号计数带偏，配平就错了 —— 那是这个脚本最容易出错的地方。
 */
function skipNonCode (code, i) {
  const c = code[i];
  const c2 = code[i + 1];

  // 行注释
  if (c === '/' && c2 === '/') {
    const nl = code.indexOf('\n', i);
    return nl === -1 ? code.length : nl;
  }
  // 块注释
  if (c === '/' && c2 === '*') {
    const end = code.indexOf('*/', i + 2);
    return end === -1 ? code.length : end + 2;
  }
  // 单 / 双引号字符串
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < code.length) {
      if (code[j] === '\\') { j += 2; continue; }
      if (code[j] === c) return j + 1;
      // 单双引号字符串不能跨行 —— 跨了说明我们认错了引号（比如它在正则里），
      // 收在这里比一路吞到底安全。
      if (code[j] === '\n') return j;
      j++;
    }
    return code.length;
  }
  // 模板串
  if (c === '`') {
    let j = i + 1;
    while (j < code.length) {
      if (code[j] === '\\') { j += 2; continue; }
      if (code[j] === '`') return j + 1;
      j++;
    }
    return code.length;
  }
  // 正则：只在"表达式位置"起头才算 —— 判据是它前面那个有意义字符不能是
  // 标识符字符 / 右括号 / 右方括号，否则 `a / b` 的除号会被误当正则起头。
  if (c === '/') {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    const prev = k >= 0 ? code[k] : '';
    if (prev === '' || /[=(,:[!&|?{};+\-*%^~<>]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length) {
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;               // 正则不能跨行
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          // 吃掉 flags
          j++;
          while (j < code.length && /[a-z]/i.test(code[j])) j++;
          return j;
        }
        j++;
      }
    }
  }
  return i;
}

/**
 * 从 `{`（或 `(`）开始，返回与之配对的收尾下标 +1。
 * `open` / `close` 是这对括号的字符。
 */
function matchBracket (code, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < code.length) {
    const skipped = skipNonCode(code, j);
    if (skipped !== j) { j = skipped; continue; }
    const c = code[j];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return code.length;   // 没配平：吃到底（宁可哈希错，不静默丢函数）
}

/**
 * 从 `i`（指向某个 `)`）往回找与它配对的 `(` 的下标。
 * 找不到返回 -1。用于 bodyEnd 回退扫形参表时跨过嵌套括号。
 */
function matchBracketBackward (code, i) {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    const c = code[k];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) return k;
    } else if (c === '\n') {
      return -1;   // 形参表不会跨行到"上一个语句"
    }
  }
  return -1;
}

/**
 * 找函数体的结束位置。
 *
 * `i` 指向刚识别出的声明头部末尾。**注意**：正则 `RE_FUNC` / `RE_ARROW` 的
 * `m[0]` 已经吃掉了开括号 `(`，所以这里进来时 `code[i]` 可能是 `)` 或形参内容 ——
 * 不能假定 `(` 还在。判据：往前找这个头部的第一个 `(`，从那里配平形参表。
 *
 * 之后跳过 `=>`，再配平函数体 `{...}`；箭头函数的表达式体（没有 `{}`）
 * 则吃到行 / 顶层逗号 / 分号。
 */
function bodyEnd (code, i) {
  let j = i;
  // 找头部的开 `(`：从 i 往前回退，跳过形参内容直到遇到 `(`。
  // ⚠️ 形参可能是**解构**（`function routes ({ state, withTimeout })`）——
  //    回退时遇到 `}` 要先把配对的 `{` 跳过去，否则会误判成函数体。
  //    判据：只有撞上换行 / 分号才算"这不是形参表"。
  let open = -1;
  for (let k = i - 1; k >= 0; k--) {
    const c = code[k];
    if (c === '(') { open = k; break; }
    if (c === ')') {
      // 从右往左找配对的 `(`：正向配平后回跳
      const end = matchBracketBackward(code, k);
      if (end === -1) break;
      k = end; continue;
    }
    if (c === '\n' || c === ';') break;
  }
  if (open !== -1) {
    j = matchBracket(code, open, '(', ')');
  }
  while (j < code.length && /\s/.test(code[j])) j++;
  // 普通函数声明：形参表后面直接就是 `{` 函数体
  if (code[j] === '{') return matchBracket(code, j, '{', '}');
  // 箭头函数：`=>` 之后才是体
  if (code[j] === '=' && code[j + 1] === '>') {
    j += 2;
    while (j < code.length && /\s/.test(code[j])) j++;
    // 箭头函数的 `{` 体
    if (code[j] === '{') return matchBracket(code, j, '{', '}');
    // 表达式体：吃到换行 / 顶层逗号 / 分号
    let depth = 0;
    while (j < code.length) {
      const skipped = skipNonCode(code, j);
      if (skipped !== j) { j = skipped; continue; }
      const c = code[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === '\n' || c === ';' || c === ',')) break;
      j++;
    }
    return j;
  }
  return j;
}

// 顶层函数声明：`function name (args) {...}` / `async function name (...)`
const RE_FUNC = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
// 箭头函数常量：`const name = (args) => ...` / `const name = async x => ...`
const RE_ARROW = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\(|[A-Za-z_$][\w$]*\s*=>)/;
// 顶层对象常量：`const handlers = { ... }`（路由表主形态）
const RE_OBJ = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/;

/** 在 `{...}` 对象体里按 0 深度找 `key: value` 里的 `key`，value 若是函数就抽出来。
 *
 *  返回 `[{ key, text }]`，`text` 从 key 的第一个字符起、到函数体末尾止
 *  （含签名 —— "只搬动不改逻辑"连签名都不该动）。
 */
function extractObjectMethods (code, objBody) {
  const out = [];
  let j = 0;
  while (j < objBody.length) {
    // 只跳过注释 / 正则（不能把引号跳掉 —— 字符串键正是从这里起头的）
    const c = objBody[j];
    const c2 = objBody[j + 1];
    if (c === '/' && (c2 === '/' || c2 === '*')) { j = skipNonCode(objBody, j); continue; }
    if (c === '{') { j = matchBracket(objBody, j, '{', '}'); continue; }
    if (c === '[') { j = matchBracket(objBody, j, '[', ']'); continue; }
    if (c === '}') { j++; continue; }

    let key = null;
    let afterKey = -1;
    let keyStart = j;
    if (c === '"' || c === "'") {
      // 字符串键：'POST /eat': ...
      const endQ = skipNonCode(objBody, j);
      const raw = objBody.slice(j, endQ);
      let k = endQ;
      while (k < objBody.length && /\s/.test(objBody[k])) k++;
      if (objBody[k] === ':') {
        key = raw.replace(/^['"]|['"]$/g, '');
        afterKey = k + 1;
      } else { j = endQ; continue; }
    } else if (/[A-Za-z_$]/.test(c)) {
      let k = j;
      while (k < objBody.length && /[\w$.\-]/.test(objBody[k])) k++;
      const raw = objBody.slice(j, k);
      let p = k;
      while (p < objBody.length && /\s/.test(objBody[p])) p++;
      if (objBody[p] === ':') { key = raw; afterKey = p + 1; }
      else if (objBody[p] === '(') {
        // 简写方法 `foo (a) {...}`
        const endParen = matchBracket(objBody, p, '(', ')');
        let v = endParen;
        while (v < objBody.length && /\s/.test(objBody[v])) v++;
        if (objBody[v] === '{') {
          const end = matchBracket(objBody, v, '{', '}');
          out.push({ key: raw, text: objBody.slice(j, end) });
          j = end; continue;
        }
        j = endParen; continue;
      } else { j = k; continue; }
    } else { j++; continue; }

    // 取 value：跳过空白，若看起来像函数（async / ( / 标识符 => / function）就抽
    let v = afterKey;
    while (v < objBody.length && /\s/.test(objBody[v])) v++;
    const vRest = objBody.slice(v);
    const looksLikeFn = /^(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(vRest);
    if (!looksLikeFn) { j = v; continue; }
    const end = bodyEnd(objBody, v);
    out.push({ key, text: objBody.slice(keyStart, end) });
    j = end;
  }
  return out;
}

/**
 * 在函数体 `[start, end)` 里找 `return { ... }` 返回的对象，抽出它的方法。
 *
 * 为什么需要：`hands.js` 的路由表不是顶层对象，而是
 *     function routes ({ state, withTimeout }) { return { 'POST /eat': ... }; }
 * 拆文件时真正要核对的是**这些路由处理函数**在不在、改没改，所以得钻进去。
 * 只认字面量 `return {`（项目里的写法），其他形态（变量、函数调用）不猜。
 */
function collectNestedRoutes (code, start, end, map, hash) {
  const body = code.slice(start, end);
  const re = /\breturn\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const braceAt = m.index + m[0].length - 1;
    const braceEnd = matchBracket(body, braceAt, '{', '}');
    const inner = body.slice(braceAt + 1, braceEnd - 1);
    for (const { key, text } of extractObjectMethods(body, inner)) {
      if (!map.has(key)) map.set(key, { hash: hash(text), text });
    }
  }
}

/**
 * 切分一份源码，返回 `Map<name, {hash, text}>`。
 *
 * 不只抽"函数体"，而是抽**整段源码文本**（`function foo(...) {...}` 或
 * `'POST /eat': async (b) => {...}`）—— 因为"只搬动不改逻辑"要的是连签名、
 * 连注释位置都不动。哈希算在去首尾空白后的整段上。
 */
function sliceFunctions (code) {
  const map = new Map();
  const lineStart = new Map();   // 行首下标 → 便于判断"是不是行首"
  let atLineStart = true;

  const hash = (text) => crypto.createHash('sha1').update(text.trim()).digest('hex').slice(0, 12);

  let i = 0;
  while (i < code.length) {
    // 只认"行首第一个非空白字符"处的顶层声明 —— 缩进的都在函数/对象内部，由外层递归抽
    const skipped = skipNonCode(code, i);
    if (skipped !== i) { i = skipped; atLineStart = code[i - 1] === '\n'; continue; }
    const c = code[i];
    if (c === '\n') { atLineStart = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }

    if (atLineStart) {
      const rest = code.slice(i);
      // ① function 声明
      let m = RE_FUNC.exec(rest);
      if (m) {
        const name = m[1];
        const end = bodyEnd(code, i + m[0].length);
        const text = code.slice(i, end);
        if (!map.has(name)) map.set(name, { hash: hash(text), text });
        collectNestedRoutes(code, i, end, map, hash);
        i = end; atLineStart = true; continue;
      }
      // ② const x = (...) => / function
      m = RE_ARROW.exec(rest);
      if (m) {
        const name = m[1] || m[2];
        if (name) {
          // 从 `=` 之后算体
          const eq = rest.indexOf('=');
          const absEq = i + eq;
          const end = bodyEnd(code, absEq);
          const text = code.slice(i, end);
          if (!map.has(name)) map.set(name, { hash: hash(text), text });
          collectNestedRoutes(code, i, end, map, hash);
          i = end; atLineStart = true; continue;
        }
      }
      // ③ 顶层对象常量（handlers / 路由表）
      m = RE_OBJ.exec(rest);
      if (m) {
        const objStart = i + rest.indexOf('{');
        const objEnd = matchBracket(code, objStart, '{', '}');
        const body = code.slice(objStart + 1, objEnd - 1);
        // 对象里的每个方法单独记一份（这是路由拆文件时真正要核对的东西）
        for (const { key, text } of extractObjectMethods(code, body)) {
          if (!map.has(key)) map.set(key, { hash: hash(text), text });
        }
        // 对象常量本身也记一份整体哈希（容器名），便于看"整张表变了没"
        const objText = code.slice(i, objEnd);
        if (!map.has(m[1])) map.set(m[1], { hash: hash(objText), text: objText, isObject: true });
        i = objEnd; atLineStart = true; continue;
      }
    }

    // 其它行首语句：跳过它（可能带自己的花括号）
    if (c === '{') { i = matchBracket(code, i, '{', '}'); atLineStart = false; continue; }
    if (c === '(') { i = matchBracket(code, i, '(', ')'); atLineStart = false; continue; }
    if (c === '[') { i = matchBracket(code, i, '[', ']'); atLineStart = false; continue; }
    if (c === ';') { atLineStart = true; i++; continue; }
    i++;
    atLineStart = false;
  }
  return map;
}

// ============================================================ 读取输入

function readSource (spec) {
  // spec: {file, ref?}  ref 给了就走 git show，否则读磁盘
  if (spec.ref) {
    const out = execFileSync('git', ['show', `${spec.ref}:${spec.file}`], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  }
  return fs.readFileSync(spec.file, 'utf8');
}

function collectFiles (dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ============================================================ 比对

function compare (beforeSpecs, afterSpecs) {
  const beforeFns = new Map();   // name -> {hash, file}
  for (const spec of beforeSpecs) {
    const code = readSource(spec);
    for (const [name, info] of sliceFunctions(code)) {
      if (!beforeFns.has(name)) beforeFns.set(name, { hash: info.hash, file: spec.file, isObject: !!info.isObject });
    }
  }

  const afterFns = new Map();
  for (const spec of afterSpecs) {
    const code = readSource(spec);
    for (const [name, info] of sliceFunctions(code)) {
      if (!afterFns.has(name)) afterFns.set(name, { hash: info.hash, file: spec.file, isObject: !!info.isObject });
    }
  }

  const rows = [];
  for (const [name, b] of beforeFns) {
    if (b.isObject) continue;   // 容器本身不单列（它的方法已逐个列出）
    const a = afterFns.get(name);
    if (!a) rows.push({ name, status: 'missing', before: `${b.file}`, after: '' });
    else if (a.hash === b.hash) rows.push({ name, status: 'same', before: `${b.file}`, after: `${a.file}` });
    else rows.push({ name, status: 'changed', before: `${b.file}`, after: `${a.file}` });
  }
  return rows;
}

function printReport (rows) {
  const width = Math.max(...rows.map(r => r.name.length), 6);
  const same = rows.filter(r => r.status === 'same').length;
  const changed = rows.filter(r => r.status === 'changed');
  const missing = rows.filter(r => r.status === 'missing');

  console.log('  ' + 'function'.padEnd(width) + '  status   before → after');
  console.log('  ' + '-'.repeat(width + 30));
  for (const r of rows) {
    const mark = r.status === 'same' ? '✓' : '✗';
    console.log(`  ${r.name.padEnd(width)}  ${mark} ${r.status.padEnd(7)} ${r.before}${r.after && r.after !== r.before ? ' → ' + r.after : ''}`);
  }
  console.log(`\n  ${same}/${rows.length} 一致 · ${changed.length} 改了内容 · ${missing.length} 找不到`);
  if (changed.length) console.log(`  ✗ 改了内容：${changed.map(r => r.name).join(', ')}`);
  if (missing.length) console.log(`  ✗ 找不到：${missing.map(r => r.name).join(', ')}`);
  return changed.length + missing.length === 0;
}

// ============================================================ CLI

function parseArgs (argv) {
  const args = { before: null, files: [], after: [], afterDir: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') args.selftest = true;
    else if (a === '--before') args.before = argv[++i];
    else if (a === '--files') args.files = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--after') args.after = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--after-dir') args.afterDir = argv[++i];
  }
  return args;
}

function main () {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) return selftest();

  if (!args.files.length || !args.before) {
    console.error('用法: node scripts/refactor/check-moved.js --before <git-ref> --files a.js,b.js --after-dir src/');
    console.error('      node scripts/refactor/check-moved.js --before a.js,b.js --after src/x.js,src/y.js');
    return 2;
  }

  // 前后两组文件
  const beforeSpecs = args.files.map(f => {
    // --before 给了 git ref：files 是仓库内路径；否则 --before 是文件列表
    return { file: f, ref: !args.after.length && !args.afterDir ? null : args.before };
  });

  // 两种调用形态：① --before <ref> --files ... ② --before a.js,b.js --after x.js,y.js
  let bSpecs, aSpecs;
  if (args.after.length || args.afterDir) {
    bSpecs = args.files.map(f => ({ file: f }));
    aSpecs = args.afterDir
      ? collectFiles(args.afterDir).map(f => ({ file: f }))
      : args.after.map(f => ({ file: f }));
  } else {
    bSpecs = args.before.split(',').map(f => ({ file: f.trim() }));
    aSpecs = args.files.map(f => ({ file: f }));
  }

  const rows = compare(bSpecs, aSpecs);
  const ok2 = printReport(rows);
  return ok2 ? 0 : 1;
}

// ============================================================ selftest

function selftest () {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
  };

  console.log('check-moved selftest');

  // 1. 基本切分：函数声明 / 箭头常量 / 对象方法都能认出来
  {
    const src = `
'use strict';
function alpha (a, b) {
  return a + b;
}

const beta = async (x) => {
  return x * 2;
};

const gamma = (y) => y - 1;

const handlers = {
  'POST /eat': async (b = {}) => {
    return { ate: true };
  },
  'GET /status': async () => ({ ok: true }),
  plainMethod (q) {
    return q;
  },
};
`;
    const fns = sliceFunctions(src);
    ok('function 声明被切出', fns.has('alpha'));
    ok('箭头常量（块体）被切出', fns.has('beta'));
    ok('箭头常量（表达式体）被切出', fns.has('gamma'));
    ok("对象方法 'POST /eat' 被切出", fns.has('POST /eat'), [...fns.keys()].join('|'));
    ok("对象方法 'GET /status' 被切出", fns.has('GET /status'));
    ok('简写方法 plainMethod 被切出', fns.has('plainMethod'));
    ok('返回值哈希是 12 位十六进制', /^[0-9a-f]{12}$/.test(fns.get('alpha').hash), fns.get('alpha').hash);
  }

  // 2. 花括号配平：字符串 / 注释 / 模板串里的 `}` 不能把函数体提前掐断
  {
    const src = `
function tricky () {
  const s = '}';
  const t = "}{ not real }";
  const u = \`tpl } \${1 + 1} end\`;
  // 注释里的 } 也不算
  /* 块注释 { } */
  return s;
}

function after () {
  return 42;
}
`;
    const fns = sliceFunctions(src);
    ok('字符串里的 } 没掐断函数体', fns.has('tricky') && fns.has('after'));
    ok('tricky 的源码含 return s', /return s;/.test(fns.get('tricky').text));
  }

  // 3. 正则里的 `/` 不能把后面当注释吞掉
  {
    const src = `
function re () {
  const m = /\\/\\/not-a-comment/.test('x');
  return m;
}

function afterRe () { return 1; }
`;
    const fns = sliceFunctions(src);
    ok('正则里的 // 未被当注释', fns.has('re') && fns.has('afterRe'), [...fns.keys()].join('|'));
  }

  // 4. 项目假设：模板串里 ${} 不含裸 `}`（钉住 doc 里写的那条边界）
  {
    const src = "function t () { return `${a[0]}` + `x${b}`; }\nfunction u () { return 2; }";
    const fns = sliceFunctions(src);
    ok('嵌套 ${} 的模板串能正确配平', fns.has('t') && fns.has('u'));
  }

  // ---- 端到端：造两个小文件，一个函数改了一个字符、一个挪了位置没改 ----
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'check-moved-'));
  const beforeFile = path.join(tmp, 'before.js');
  const afterFile = path.join(tmp, 'after.js');
  fs.writeFileSync(beforeFile, `
function movedIntact (a) {
  return a + 1;
}

function changedOneChar (a) {
  return a + 100;
}

function onlyHere () {
  return 'gone';
}
`);
  fs.writeFileSync(afterFile, `
'use strict';

// 搬到新文件了，位置变了、还多了个文件头注释

function changedOneChar (a) {
  return a + 101;
}

function movedIntact (a) {
  return a + 1;
}
`);

  {
    const rows = compare([{ file: beforeFile }], [{ file: afterFile }]);
    const byName = Object.fromEntries(rows.map(r => [r.name, r.status]));
    ok('挪了位置但没改 → same', byName.movedIntact === 'same', byName.movedIntact);
    ok('改了一个字符 → changed', byName.changedOneChar === 'changed', byName.changedOneChar);
    ok('拆后消失 → missing', byName.onlyHere === 'missing', byName.onlyHere);
    ok('报告条数 = 3', rows.length === 3, rows.length);
    ok('整体判定为失败（有 changed/missing）', printReportQuiet(rows) === false);
  }

  // 5. 全 same 时整体判定通过
  {
    const afterSame = path.join(tmp, 'afterSame.js');
    fs.writeFileSync(afterSame, `
function movedIntact (a) {
  return a + 1;
}

function changedOneChar (a) {
  return a + 100;
}

function onlyHere () {
  return 'gone';
}
`);
    const rows = compare([{ file: beforeFile }], [{ file: afterSame }]);
    ok('内容一字不改 → 全 same', rows.every(r => r.status === 'same'), JSON.stringify(rows.map(r => r.status)));
    ok('全 same 时整体判定通过', printReportQuiet(rows) === true);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n  ${pass}/${pass + fail} 通过`);
  return fail ? 1 : 0;
}

// printReport 的静默版（selftest 里只要布尔）
function printReportQuiet (rows) {
  const changed = rows.filter(r => r.status === 'changed').length;
  const missing = rows.filter(r => r.status === 'missing').length;
  return changed + missing === 0;
}

module.exports = { sliceFunctions, compare, main };

if (require.main === module) process.exit(main() ?? 0);
