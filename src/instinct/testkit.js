'use strict';

/**
 * 本能层自测脚手架（第 3 步重构，2026-09-28）。
 *
 * `instinct.js` 原来是一整个文件，自测段共用一段外套（pass/fail/check/me/d/...）。
 * 拆成子文件后外套放这里，各文件只登记自己的小节：
 *
 *   const { register, runSuite } = require('./testkit');
 *   const __sections = [ ['扔出来的判定', async (t) => { const { check, ... } = t; ... }] ];
 *   register('pickup', __sections);                        // require 时登记，不跑
 *   // 末尾加一个「命令行开关」分支（写法照抄任一子文件，例如 pickup.js 末尾），
 *   // 只跑本文件这几节；被汇总 require 时不跑。
 *
 * 汇总 instinct.js 依次 require 各子文件（登记），再 runSuite('instinct') 跑**全部** ——
 * 顺序与拆分前一致，断言总数一分不少。
 *
 * ⚠️ 本文件本身**不跑任何断言**（只是外套），所以**故意不写**那个开关分支 ——
 * test-all 的自动发现靠「代码里真有那个分支」来认，写了它会被当成"跑了却零断言"而报红。
 * （下面示例里的开关字样是**注释**，别照抄成真代码。）
 */

const SECTIONS = [];   // { file, label, fn }
let NS = {};           // 全部本能名字（汇总装载完所有子文件后塞进来）

/** 登记一批小节（模块加载时调用，不执行）；file 只为排查时知道是谁的 */
function register (file, list) {
  for (const [label, fn] of list) SECTIONS.push({ file, label, fn });
}

/** 汇总把「全部本能名字」的总表交给这里 —— 自测小节原来就在同一作用域，随手能取 */
function bindNs (ns) { NS = ns; }

/**
 * 本能层的**全部源码**（拆分前就是 instinct.js 一个文件）。
 *
 * 原来自测里有几处源码形状锁用 `readFileSync(__filename)` 读原文，检查
 * 「某个判据只写了一处」。拆成子文件后，__filename 已经指不到 —— 这里改成把
 * src/instinct/ 下的**全部** .js 拼起来读，判据的意思不变。
 */
function instinctSrc () {
  const fs = require('fs');
  const path = require('path');
  return fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).sort()
    .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

/** 跑一批小节：mine 传数组就跑那几节，不传就跑**全部**（汇总用） */
async function runSuite (title, mine) {
  const counters = { pass: 0, fail: 0 };
  const check = (name, got, want) => {
    if (got === want) { counters.pass++; return; }
    counters.fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  // 「让出身体」那节原本是巨石自测的收尾，自带 `console.log(\`${pass} passed…\`)` ——
  // 拆开后它读的 pass/fail 改成这里的**实时**计数（t.counters 的取值器），
  // 于是那行打印的是真数，不再是 0；断言/逻辑一字未改。
  const t = {
    check, instinctSrc, ns: NS, CFG: NS.CFG, counters,
    get pass () { return counters.pass; },
    get fail () { return counters.fail; },
  };
  const list = Array.isArray(mine) ? mine.map(([label, fn]) => ({ label, fn })) : SECTIONS;
  for (const s of list) {
    try { await s.fn(t); }
    catch (e) { counters.fail++; console.log(`  ✗ [${s.label}] 抛错：${e && e.message}`); }
  }
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  return counters.fail ? 1 : 0;
}

module.exports = { register, runSuite, bindNs, instinctSrc, SECTIONS };
