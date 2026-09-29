'use strict';

/**
 * time.js —— 共用的小工具：等一会儿（第 4 步去重，2026-09-29）。
 *
 * ## 为什么要抽出来（`docs/REFACTOR-PLAN-20260928.md` 第 4 步）
 *
 * "第 3 步只许搬、不许改" 之后发现：同一件事写了好几份 ——
 *   · `src/body/util.js:21`      `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`
 *   · `src/body/commonsense.js:27` 同上（**逐字重复**）
 *   · `src/bridge/util.js:62`    `function sleep (ms) { return new Promise(r => setTimeout(r, ms)); }`
 *   · `src/bridge/util.js:79`    `const sleepMs = ms => new Promise(r => setTimeout(r, ms));`
 *   · `src/instinct/core.js:1899`  `const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));`
 *
 * 这几份**行为完全一致**（都是 `setTimeout` 包 Promise，参数一字不差），
 * 于是收进这里当**唯一一份**；各处改成 `require('.../util/time')`。
 *
 * ## 命名
 * `sleep` 和 `sleepMs` 都是历史名字，两边调用点都不少（`bridge/` 31 处叫 `sleepMs`）。
 * 两个名字都从本文件导出、指向同一个函数 —— 只统一**实现**，不动**名字**（改名风险大、
 * 收益为零）。
 *
 * ## 自测测的是"跑的那份"
 * 下面 `--selftest` 把 `sleep` 真的跑一遍（计时 + 校验"是个 Promise" + 校验"真等够了"），
 * 而不是在测试里手抄一份实现来测（项目里犯过这个错）。
 * 另外用 `sleepMs === sleep` 断言两个名字是同一个函数对象。
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 历史别名：bridge 那边叫 sleepMs（31 处调用），保留同一个函数对象
const sleepMs = sleep;

module.exports = { sleep, sleepMs };

// ------------------------------------------------------------------ 自测
//
// 两份实现的对比（第 4 步要求）：把上面 5 处原定义抄在这里，逐项和本文件跑的那份比 ——
// 但它们都是同一件事（`setTimeout` 包 Promise），**没有输入能让它们不同**。
// 所以这里的自测不是"比两份实现的输出"，而是"证明这一份真的按 Promise + 真延时工作"，
// 并对第二份写法（`bridge/util.js:62` 的 function 形式 / `sleepMs` 别名）做等价断言。
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${name}`); } };

  // 旧实现（原样抄，仅用于行为对比 —— 见上面注释：不是为了"测别的一份"）
  const sleepOldArrow = (ms) => new Promise(r => setTimeout(r, ms));          // body/util.js:21、commonsense.js:27、bridge/util.js:79、instinct/core.js:1899
  function sleepOldFn (ms) { return new Promise(r => setTimeout(r, ms)); }     // bridge/util.js:62（function 形式）

  // ① 三个东西都返回 Promise
  ok('sleep 返回 Promise', sleep(0) instanceof Promise);
  ok('sleepMs 就是 sleep（同一函数对象）', sleepMs === sleep);
  ok('旧箭头函数返回 Promise', sleepOldArrow(0) instanceof Promise);
  ok('旧 function 形式返回 Promise', sleepOldFn(0) instanceof Promise);

  // ② 真的等了（用 Date.now 量，容差放宽到 8ms —— 计时器不精确）
  const t0 = Date.now();
  sleep(30).then(() => {
    const dt = Date.now() - t0;
    ok(`真的等了 ≈30ms（实测 ${dt}ms）`, dt >= 28 && dt < 200);

    // ③ 两份旧实现与新实现在同一输入下：都"等够同样久"（同样的 ms 语义）
    const t1 = Date.now();
    Promise.all([sleepOldArrow(20), sleepOldFn(20), sleep(20)]).then(() => {
      const dt2 = Date.now() - t1;
      ok(`新/旧三份并行都等够 ≈20ms（实测 ${dt2}ms）`, dt2 >= 18 && dt2 < 200);

      // ④ 参数语义一致：undefined → setTimeout 当 0，立即 resolve（三份都一样）
      const t3 = Date.now();
      Promise.all([sleep(undefined), sleepOldArrow(undefined), sleepOldFn(undefined)]).then(() => {
        ok(`undefined 参数下立即完成（实测 ${Date.now() - t3}ms）`, Date.now() - t3 < 100);

        console.log(`  time.js：${pass} 通过 · ${fail} 失败`);
        process.exit(fail ? 1 : 0);
      });
    });
  });
}
