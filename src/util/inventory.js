'use strict';

/**
 * inventory.js —— 背包计数的共用小工具（第 4 步去重，2026-09-29）。
 *
 * ## 为什么只放这一项（`docs/REFACTOR-PLAN-20260928.md` 第 4 步）
 *
 * 盘点了 7 份"背包计数"，语义**各不相同**（Map / 总量 / 窗口 / 快照 / 按 id），
 * 大多**不该**合并（见 `modpack-study/p4-dedup/inventory.md` 与 report.md 的"不合并"清单）。
 * 唯一一份**逐字重复**的是：
 *   · `src/bridge/routes/inspect.js:449`  `const countOf = (id) => inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);`
 *   · `src/bridge/routes/gather.js:103`   同上，**一字不差**
 * 两处都是"给一个 `inv` 数组（`bot.inventory.items()`），按**数字 id** 数件数"。
 * 抽成 `countById(inv, id)`（把原来的闭包变量 `inv` 显式变成第一个参数），两处改引用。
 *
 * ⚠️ 注意这不是 `body/util.js` 的 `invCounts`（那个返回 `Map<fullId, count>`、用 `slots`、
 *    按**名字**而不是数字 id）——**不是**同一件事，不合并。
 *
 * ## 自测测的是"跑的那份"
 * 下面 `--selftest` 把 `countById` 与两份**原闭包写法**在几组 `inv` 上逐项比。
 */

/**
 * 数 `inv` 里 `id`（**数字** item id，不是名字）一共有几件。
 * @param {Array} inv  `bot.inventory.items()`（每项形如 `{ id, count, ... }`）
 * @param {number} id  数字 item id
 * @returns {number}
 */
function countById (inv, id) {
  return inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
}

module.exports = { countById };

// ------------------------------------------------------------------ 自测
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); } };

  // 原写法（两处逐字相同，抄一份即可代表）
  const oldCountOf = (inv, id) => inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

  const CASES = [
    { name: '空数组', inv: [], id: 1 },
    { name: '命中一个', inv: [{ id: 1, count: 3 }], id: 1 },
    { name: '命中多个（累加）', inv: [{ id: 1, count: 3 }, { id: 2, count: 5 }, { id: 1, count: 2 }], id: 1 },
    { name: '未命中', inv: [{ id: 2, count: 5 }], id: 1 },
    { name: 'count 为 0', inv: [{ id: 1, count: 0 }], id: 1 },
    { name: 'id 是字符串 vs 数字（严格比较，不命中）', inv: [{ id: '1', count: 7 }], id: 1 },
    { name: '负数 count（异常输入也照样算）', inv: [{ id: 1, count: -2 }], id: 1 },
  ];

  for (const c of CASES) {
    const mine = countById(c.inv, c.id), old = oldCountOf(c.inv, c.id);
    ok(`countById === 原写法的 countOf @ ${c.name}`, Object.is(mine, old), `${mine} vs ${old}`);
  }

  console.log(`  inventory.js：${pass} 通过 · ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
