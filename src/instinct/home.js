'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「home」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const __ns = {};
let STRUCTURE_SIGNS, CFG;   // 跨文件常量：load 完成后由 bind() 回填
function bind (ns) { Object.assign(__ns, ns); STRUCTURE_SIGNS = ns.STRUCTURE_SIGNS; CFG = ns.CFG; }

function recognizeStructures (blocks = []) {
  const out = [];
  for (const S of STRUCTURE_SIGNS) {
    const hit = blocks.filter(b => S.re.test(b.name));
    if (hit.length < S.min) continue;
    const c = hit.reduce((a, b) => ({ x: a.x + b.pos.x / hit.length, y: a.y + b.pos.y / hit.length, z: a.z + b.pos.z / hit.length }), { x: 0, y: 0, z: 0 });
    const anchor = { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) };
    out.push({ label: S.label, danger: !!S.danger, anchor, count: hit.length, key: `${S.label}@${Math.floor(anchor.x / 16)},${Math.floor(anchor.y / 16)},${Math.floor(anchor.z / 16)}` });
  }
  return out;
}

/**
 * 家该多大。dists：家周围人造方块到家中心的水平距离（任意顺序）。
 * 从中心往外走，相邻两个人造方块的距离差 ≤ gap 就算"还连着"；连着的最远那个 + margin 就是新半径。只扩不缩，封顶 cap。
 */
function homeFootprint (dists = [], radius = 24, cfg = CFG.home) {
  const d = dists.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  let reach = 0;
  for (const x of d) { if (x - reach > cfg.gap && x > radius) break; reach = Math.max(reach, x); }
  if (reach <= radius) return radius;   // 房子都还在范围里：不动（只有盖出去了才扩）
  return Math.min(cfg.cap, Math.ceil(reach + cfg.margin));
}

module.exports = { bind, homeFootprint, recognizeStructures };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/home.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['认建筑 / 开宝箱', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickLoot, recognizeStructures } = ns;
    // ---- 认建筑 / 开宝箱 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const blk = (name, x, n = 1) => Array.from({ length: n }, (_, i) => ({ name, pos: { x: x + i, y: 40, z: 0 } }));
    check('★ 看见刷怪笼 → 认出地牢', recognizeStructures(blk('spawner', 10))[0]?.label, '刷怪笼（地牢 / 矿井）');
    check('一两块苔石不算地牢', recognizeStructures(blk('mossy_cobblestone', 10, 2)).length, 0);
    check('一片苔石 → 地牢', recognizeStructures(blk('mossy_cobblestone', 10, 8)).length, 1);
    check('村庄的钟', recognizeStructures(blk('minecraft:bell', 5))[0]?.label, '村庄');
    const dung = recognizeStructures(blk('spawner', 10));
    check('★ 看得见没开过的箱子 → 去开', pickLoot({ chests: 2, self: me }).mode, 'open');
    check('★ 认出建筑、没进过 → 进去', pickLoot({ structures: dung, self: me }).mode, 'explore');
    check('进过的建筑不再进', pickLoot({ structures: dung, self: me, visited: new Set([dung[0].key]) }).mode, undefined);
    check('建筑太远 → 不去', pickLoot({ structures: recognizeStructures(blk('spawner', 90)), self: me }).mode, undefined);
    check('★ 血少 → 先不闯', pickLoot({ chests: 2, hp: 9, self: me }).mode, undefined);
    check('身上满了、背包也满 → 不去', pickLoot({ chests: 2, free: 1, packFree: 1, self: me }).mode, undefined);
    check('身上满了但背包还空 → 去', pickLoot({ chests: 2, free: 1, packFree: 20, self: me }).mode, 'open');
    check('夜里在露天 → 不去', pickLoot({ chests: 2, nightOut: true, self: me }).mode, undefined);
    check('模组建筑：幽灵船认得出', recognizeStructures(blk('more_critters:ghostly_planks', 5, 12))[0]?.label, '幽灵船');
    const boss = recognizeStructures(blk('cataclysm:obsidian_bricks', 5, 8));
    check('★ 灾变遗迹认得出、标了危险', boss[0]?.danger, true);
    check('★ 有 boss 的遗迹 → 不自己闯', pickLoot({ structures: boss, self: me }).mode, undefined);
  }],
  ['家的范围', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { fillCfg, homeFootprint } = ns;
    // ---- 家的范围 ----
    check('房子都在半径里 → 不变', homeFootprint([3, 8, 15, 20], 24), 24);
    check('★ 房子往外盖到 35 格（连着的）→ 扩到 41', homeFootprint([5, 12, 20, 26, 31, 35], 24), 41);
    check('★ 远处孤零零一个（隔了一大段）→ 不算（不把邻居家当自己家）', homeFootprint([5, 12, 20, 60], 24), 24);
    check('只扩不缩', homeFootprint([2, 3], 40), 40);
    check('封顶 128', homeFootprint(Array.from({ length: 40 }, (_, i) => i * 5), 24), 128);
    { const c = fillCfg({ pickup: { radius: 3 } });
      check('★ 配置补全：每个本能段都有（实机崩过：I.cfg.breathe 缺）', ['eat', 'breathe', 'effects', 'weather', 'playerHurt', 'combat', 'home'].every(n => c[n] && typeof c[n] === 'object'), true);
      check('配置补全：已有的改动保留', c.pickup.radius, 3); }
  }],
];
register('home', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('home', __sections);
}
