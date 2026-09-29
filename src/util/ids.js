'use strict';

/**
 * ids.js —— 方块 / 物品 id 的命名空间处理（第 4 步去重，2026-09-29）。
 *
 * ## 为什么要抽出来（`docs/REFACTOR-PLAN-20260928.md` 第 4 步）
 *
 * "补 `minecraft:`" 和 "去命名空间" 这两件事，项目里各写了好几份，散在 body / instinct /
 * world / mind 里。其中有两对是**逐字重复**：
 *
 *   补前缀：`src/body/util.js:25`  `fullId`
 *           `src/mind/body.js:82`  `fullItemId`      ← 与上面**同一件事**
 *   去前缀（只剥 `minecraft:`）：`src/instinct/mining.js:45` `bareNameOf`
 *           `src/instinct/core.js:676`  `bareName`     ← 与上面**同一件事**
 *   去前缀（剥任意命名空间）：`src/instinct/survival.js:312` `bareOfName`
 *           `src/world/perception.js:169` `bareOf`
 *           `src/mind/plan.js:49`         `bare`      ← 三份**同一件事**
 *
 * ## ⚠️ 关键：`String(n)` 和 `String(n || '')` **不是**同一件事
 *
 * 看仔细这两份的差别（不是笔误，是真的会影响边界输入）：
 *
 *   `String(n).replace(...)`      → `null` → `"null"`；`undefined` → `"undefined"`；`0` → `"0"`
 *   `String(n || '').replace(...)`→ `null` → `""`；    `undefined` → `""`；         `0` → `""`
 *
 * 别小看这点差别：`0` 是**合法**的输入吗？不是 id；但 `''` 和 `'null'` 在后续
 * `=== 'water'` 之类的比较里都判 false，所以对**已经过类型保证的调用方**没区别 ——
 * 但对"可能读到 undefined"的调用方（比如 API 返回里少了字段）就不一样。
 *
 * 所以本模块**不把两份合成一份**，而是各留一个导出、名字不同、语义各自钉死：
 *   · `fullId(name)`          —— `String(name)` 版（补前缀；`null`→`minecraft:null`）
 *   · `bareId(id)`            —— `String(id || '')` 版（只剥 `minecraft:`）
 *   · `bareMinecraft(n)`      —— `String(n)` 版（只剥 `minecraft:`；`null`→`"null"`）
 *   · `stripPrefix(n)`        —— `String(n || '')` 版（剥任意命名空间 `^.*:`）
 *
 * 下面自测把每一对在**同一组边界输入**下的输出并排列出来，证明"哪些合并是安全的、
 * 哪些必须参数化保留"。
 *
 * ## 不搬的东西（写在汇报里，不合并）
 * `bridge/util.js` 的 `stripNamespace` / `nameMatchesItem` / `sameItem`、`knowledge.js:764`
 * 的 `bare`、`body/equip-policy.js:67`、`bridge/routes/scan.js:115` 各有**不同的**约束
 * （同命名空间、保留非 minecraft 前缀、只剥一段）—— 见 `modpack-study/p4-dedup/report.md`。
 */

/** 补 `minecraft:` 前缀。`String(name)` 版：`null` → `minecraft:null`（与 body/util.js 原写法逐字一致） */
const fullId = (name) => (String(name).includes(':') ? String(name) : `minecraft:${name}`);

/** 去掉 `minecraft:` 前缀。`String(id || '')` 版：`null`/`undefined`/`0`/`false` → `''`（与 body/util.js 原写法逐字一致） */
const bareId = (id) => String(id || '').replace(/^minecraft:/, '');

/** 去掉 `minecraft:` 前缀。`String(n)` 版：`null` → `"null"`（与 instinct/mining.js:45、core.js:676 原写法逐字一致） */
const bareMinecraft = (n) => String(n).replace(/^minecraft:/, '');

/** 去掉**任意**命名空间（贪婪到最后一个 `:`）。`String(n || '')` 版（与 instinct/survival.js:312、world/perception.js:169、mind/plan.js:49 逐字一致） */
const stripPrefix = (n) => String(n || '').replace(/^.*:/, '');

module.exports = { fullId, bareId, bareMinecraft, stripPrefix };

// ------------------------------------------------------------------ 自测
//
// 第 4 步要求："两份实现如果有细微差别……先写自测把两份在各种输入下的输出列出来对比"。
// 下面就是那张对比表：四份原实现 vs 本模块的四个导出，逐输入比。
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); } };

  // ---- 四份原实现（逐字抄自上面的出处，仅用于对比）--------------------------
  const oldFullId = (name) => (String(name).includes(':') ? String(name) : `minecraft:${name}`);              // body/util.js:25
  const oldFullItemId = (name) => String(name || '').includes(':') ? String(name) : `minecraft:${name}`;       // mind/body.js:82
  const oldBareId = (id) => String(id || '').replace(/^minecraft:/, '');                                       // body/util.js:215
  const oldBareNameOf = (n) => String(n).replace(/^minecraft:/, '');                                           // instinct/mining.js:45
  const oldCoreBareName = (n) => String(n).replace(/^minecraft:/, '');                                         // instinct/core.js:676
  const oldBareOfName = (n) => String(n || '').replace(/^.*:/, '');                                            // instinct/survival.js:312
  const oldPerceptionBareOf = (n) => String(n || '').replace(/^.*:/, '');                                      // world/perception.js:169
  const oldPlanBare = (n) => String(n || '').replace(/^.*:/, '');                                              // mind/plan.js:49

  // 边界输入：含 undefined / null / '' / 0 / false / 正常名 / 带命名空间 / 多段冒号
  const INPUTS = [undefined, null, '', 0, false, 'stone', 'minecraft:stone', 'mod:foo', 'a:b:c', 'minecraft:', 12];

  const show = (v) => v === undefined ? 'undefined' : (typeof v === 'string' ? JSON.stringify(v) : String(v));

  console.log('  —— 补前缀：fullId（本模块） vs 原 fullId / fullItemId ——');
  for (const v of INPUTS) {
    const mine = fullId(v), a = oldFullId(v), b = oldFullItemId(v);
    console.log(`    ${show(v).padEnd(18)} fullId=${show(mine).padEnd(20)} oldFullId=${show(a).padEnd(20)} oldFullItemId=${show(b)}`);
  }

  console.log('  —— 去 minecraft：bareId / bareMinecraft vs 原三份 ——');
  for (const v of INPUTS) {
    const mineA = bareId(v), mineB = bareMinecraft(v);
    console.log(`    ${show(v).padEnd(18)} bareId=${show(mineA).padEnd(14)} bareMinecraft=${show(mineB).padEnd(14)} oldBareId=${show(oldBareId(v)).padEnd(14)} oldBareNameOf=${show(oldBareNameOf(v)).padEnd(14)} oldCoreBareName=${show(oldCoreBareName(v))}`);
  }

  console.log('  —— 剥任意命名空间：stripPrefix vs 原三份 ——');
  for (const v of INPUTS) {
    const mine = stripPrefix(v);
    console.log(`    ${show(v).padEnd(18)} stripPrefix=${show(mine).padEnd(12)} oldBareOfName=${show(oldBareOfName(v)).padEnd(12)} oldPerceptionBareOf=${show(oldPerceptionBareOf(v)).padEnd(12)} oldPlanBare=${show(oldPlanBare(v))}`);
  }

  // ---- 断言：本模块的每个导出与它**对应的**原实现**逐输入**完全一致 --------
  for (const v of INPUTS) {
    const s = show(v);
    // fullId 对 body/util.js 的 fullId（同一个写法）
    ok(`fullId === oldFullId  @ ${s}`, Object.is(fullId(v), oldFullId(v)), `${show(fullId(v))} vs ${show(oldFullId(v))}`);
    ok(`bareId === oldBareId  @ ${s}`, Object.is(bareId(v), oldBareId(v)), `${show(bareId(v))} vs ${show(oldBareId(v))}`);
    // bareMinecraft 对 instinct 那两份（同一写法）
    ok(`bareMinecraft === oldBareNameOf @ ${s}`, Object.is(bareMinecraft(v), oldBareNameOf(v)));
    ok(`bareMinecraft === oldCoreBareName @ ${s}`, Object.is(bareMinecraft(v), oldCoreBareName(v)));
    // stripPrefix 对 instinct/world 那三份（同一写法）
    ok(`stripPrefix === oldBareOfName @ ${s}`, Object.is(stripPrefix(v), oldBareOfName(v)));
    ok(`stripPrefix === oldPerceptionBareOf @ ${s}`, Object.is(stripPrefix(v), oldPerceptionBareOf(v)));
    ok(`stripPrefix === oldPlanBare @ ${s}`, Object.is(stripPrefix(v), oldPlanBare(v)));
  }

  // ---- 钉死"差别在哪"：证明 fullId ≡ fullItemId，而 bareId ≠ bareMinecraft -------
  // `fullId` 与 `mind/body.js` 的 `fullItemId` 在**所有输入**下都相同（`|| ''` 是惰性的：
  //   `String(n||'')` 只有在 n 为假值时才有别于 `String(n)`，而假值 `String(...)` 都不含 `:`，
  //   两个写法都会落到同一个 `minecraft:${n}` 分支，模板串用的还是原来的 `n`）。
  // 所以 M2 是**真合并**（不是参数化）。下面把它钉死。
  ok('fullId ≡ oldFullItemId 于 undefined', Object.is(fullId(undefined), oldFullItemId(undefined)));
  ok('fullId ≡ oldFullItemId 于 null', Object.is(fullId(null), oldFullItemId(null)));
  ok('fullId ≡ oldFullItemId 于 ""', Object.is(fullId(''), oldFullItemId('')));
  // 而 `bareId`（`String(id||'')`）和 `bareMinecraft`（`String(n)`）在 null/undefined/0/false 上**不同**：
  ok('差异记录：bareId(null) = ""，bareMinecraft(null) = "null"（两派不可合并）',
    bareId(null) === '' && bareMinecraft(null) === 'null');
  ok('差异记录：bareId(undefined) = ""，bareMinecraft(undefined) = "undefined"',
    bareId(undefined) === '' && bareMinecraft(undefined) === 'undefined');
  ok('差异记录：bareId(0) = ""，bareMinecraft(0) = "0"',
    bareId(0) === '' && bareMinecraft(0) === '0');
  ok('无冒号名：stripPrefix("stone") = "stone"', stripPrefix('stone') === 'stone');
  ok('多段冒号：stripPrefix("a:b:c") = "c"（贪婪）', stripPrefix('a:b:c') === 'c');
  ok('只剥 minecraft：bareMinecraft("a:b:c") = "a:b:c"（不贪婪）', bareMinecraft('a:b:c') === 'a:b:c');

  console.log(`  ids.js：${pass} 通过 · ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
