'use strict';

/**
 * 寻路策略 —— **汇总入口**（第 3 步重构，2026-09-29）。
 *
 * 这个文件原来是 3798 行的巨石。按领域拆成 movements / doors / ladders /
 * unknown-blocks / fluid / probe / collect / budget / selftest，
 * 这里只做四件事：
 *
 *   ① require 全部子文件（都是"只定义不执行"）；
 *   ② 把子文件的导出拼成一张总表 `__ns`，再按**原顺序** `module.exports` 出去 ——
 *      `Object.keys` 与拆分前**逐字一致**（62 个名字，见 `references/exports-pathing.json`）；
 *   ③ 调 `selftest.js` 的 `run(__ns)`：自测是原来的 475 条，一条没改一条没少
 *      （`--selftest` 时用 `require.main === module` 守卫，见那个文件顶部的说明）；
 *   ④ 保留原路径 —— 外部 `require('../world/pathing')` 指的是**本文件**
 *      （`src/world/pathing.js` 是转发到这里的普通文件，不是符号链接：
 *      Windows 的 git 默认把符号链接签出成纯文本，require 会炸）。
 *
 * ⚠️ 本模块**没有循环依赖**，所以不需要 `src/body` / `src/bridge` 那套两阶段 `bind`：
 *    子文件之间只在**运行期通过汇总表**互相取用（`function X (...a) { return __ns.X.apply(null, a); }`
 *    这类转发壳），而且 `__ns` 在 require 时就已经被 `Object.assign` 填满后才第一次被调用。
 *
 * ⚠️ **谁拥有共享状态**（改之前先看这段）：
 *    · `paths`（`src/paths.js`）—— 各子文件按需 require，是**只读**的；
 *    · 运行期可变的模块级状态**只有一份**，全在 `movements.js`：
 *      `FLUID_GUARD_FLAG`（防重复注入的 Symbol）、`PRISTINE_LADDER_ID`（`installLadderFix` 写）、
 *      `_unknownSolidPolicy` / `_fluidGuardInstalled` / `__climbablePatched` 等运行时懒加载标记；
 *    · 常量（`COSTS` / `PROTECTED_PATTERNS` / `PATH_*` / `COLLECT_SEARCH` …）各归各文件，
 *      汇总表里的引用指向同一份对象 —— 别在别处再建一份。
 */

// ---- 子模块（拆自原 pathing.js；都是"只定义不执行"）---------------------------
const movements = require('./movements');
const doors = require('./doors');
const ladders = require('./ladders');
const unknownBlocks = require('./unknown-blocks');
const fluid = require('./fluid');
const probe = require('./probe');
const collect = require('./collect');
const budget = require('./budget');
const runSelftest = require('./selftest');

// ---- 总表 -----------------------------------------------------------------
// 子文件 export 的键与顺序无所谓：下面的 module.exports 才是对外契约。
//
// ⚠️ `bind` 是每个子文件的**装配私有名**（不是对外接口），拼总表时跳过它 ——
//    它是给下面 `Object.assign` 之后回填"隔壁名字"用的（`src/body/AGENTS.md`
//    「循环依赖」那套：拆之前都在一个作用域里，拆开后靠汇总在**全部加载完**之后回填）。
const __ns = {};
const SUBS = [movements, doors, ladders, unknownBlocks, fluid, probe, collect, budget];
for (const mod of SUBS) {
  for (const [k, v] of Object.entries(mod)) {
    if (k === 'bind' || k === '__selftest') continue;   // 装配私有名，不进总表
    if (k in __ns) continue;
    __ns[k] = v;
  }
}
for (const mod of SUBS) if (typeof mod.bind === 'function') mod.bind(__ns);

module.exports = { naturalDigNames: __ns.naturalDigNames, setDigPolicy: __ns.setDigPolicy,
  setDropAllowance: __ns.setDropAllowance, setScaffold: __ns.setScaffold, MLG_DROP: __ns.MLG_DROP,
  bareName: __ns.bareName,
  isProtected: __ns.isProtected,
  PROTECTED_PATTERNS: __ns.PROTECTED_PATTERNS,
  COSTS: __ns.COSTS,
  ALLOW_DIG: __ns.ALLOW_DIG,
  buildProtectedIds: __ns.buildProtectedIds,
  applyPolicy: __ns.applyPolicy,
  probeRegistry: __ns.probeRegistry,
  summarizeProbe: __ns.summarizeProbe,
  CLIMBABLE_STATE_IDS: __ns.CLIMBABLE_STATE_IDS,
  parseIdList: __ns.parseIdList,
  parseNameList: __ns.parseNameList,
  resolveClimbableIds: __ns.resolveClimbableIds,
  resolveClimbableBlockIds: __ns.resolveClimbableBlockIds,
  applyClimbables: __ns.applyClimbables,
  applyOpenDoors: __ns.applyOpenDoors,
  lowBlockHeight: __ns.lowBlockHeight,
  probeClimbables: __ns.probeClimbables,
  installLadderFix: __ns.installLadderFix,
  UNKNOWN_BLOCK_SOLID: __ns.UNKNOWN_BLOCK_SOLID,
  PASSABLE_STATE_IDS: __ns.PASSABLE_STATE_IDS,
  FULL_CUBE: __ns.FULL_CUBE,
  EMPTY_SHAPES: __ns.EMPTY_SHAPES,
  isUnknownBlock: __ns.isUnknownBlock,
  needsShapeFallback: __ns.needsShapeFallback,
  THIN_BLOCK_PASSABLE: __ns.THIN_BLOCK_PASSABLE,
  THIN_BLOCK_SUFFIXES: __ns.THIN_BLOCK_SUFFIXES,
  THIN_BLOCK_DENY: __ns.THIN_BLOCK_DENY,
  isThinBlockName: __ns.isThinBlockName,
  applyUnknownBlockPolicy: __ns.applyUnknownBlockPolicy,
  faceTowardBlock: __ns.faceTowardBlock,
  LIQUID_NAMES: __ns.LIQUID_NAMES,
  MAX_VERTICAL_FLOW_LOOKAHEAD: __ns.MAX_VERTICAL_FLOW_LOOKAHEAD,
  assessExcavationFluidRisk: __ns.assessExcavationFluidRisk,
  isFlowPassable: __ns.isFlowPassable,
  injectFluidBreakGuard: __ns.injectFluidBreakGuard,
  PATH_STEP_MS: __ns.PATH_STEP_MS,
  SPRINT_SPEED: __ns.SPRINT_SPEED,
  PATH_MIN_TIMEOUT_MS: __ns.PATH_MIN_TIMEOUT_MS,
  PATH_MAX_TIMEOUT_MS: __ns.PATH_MAX_TIMEOUT_MS,
  PATH_PROGRESS_INTERVAL_MS: __ns.PATH_PROGRESS_INTERVAL_MS,
  PATH_STAGNATION_THRESHOLD: __ns.PATH_STAGNATION_THRESHOLD,
  MAX_STAGNANT_CHECKS: __ns.MAX_STAGNANT_CHECKS,
  clearPathfinderGoal: __ns.clearPathfinderGoal,
  createGoalOwner: __ns.createGoalOwner,
  classifyGotoOutcome: __ns.classifyGotoOutcome,
  installPhysicsTickGuard: __ns.installPhysicsTickGuard,
  stepKind: __ns.stepKind,
  stepCostMs: __ns.stepCostMs,
  estimatePathTimeMs: __ns.estimatePathTimeMs,
  computeTimeoutFromEta: __ns.computeTimeoutFromEta,
  computeHardCap: __ns.computeHardCap,
  createStagnationMonitor: __ns.createStagnationMonitor,
  COLLECT_SEARCH: __ns.COLLECT_SEARCH,
  buildRadiusLadder: __ns.buildRadiusLadder,
  isProductiveSweep: __ns.isProductiveSweep,
  nextCollectStep: __ns.nextCollectStep,
};

// ---- 自测（原来是本文件末尾那段；现在在 selftest.js）--------------------------
// 把总表递过去：自测里用的名字原来都在同一个作用域里，现在靠这张表取到同一份真身。
//
// ⚠️ 还要并上 `movements.__selftest` 那 4 个**私有**名字（`dropPenalty` / `MAX_DROP` /
//    `NATURAL_EXTRA` / `NOT_NATURAL_RE`）+ `paths`：自测原来直接用它们，而它们不在
//    对外 `module.exports` 里（不能加，会把 62 个导出名弄脏）。只递自测，不外泄。
//
// ⚠️ 这里**不判**"该不该跑"：`node src/world/pathing.js --selftest` 时 `require.main.filename`
//    是转发壳 `src/world/pathing.js`（不是本文件），放这里的 `require.main === module`
//    永远为假 —— 会静默不跑。投票留在转发壳里，本文件只管"票投了就转调 run()"。
runSelftest(Object.assign({}, __ns, movements.__selftest));
