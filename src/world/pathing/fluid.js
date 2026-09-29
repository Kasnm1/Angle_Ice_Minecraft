'use strict';

/**
 * 流体安全（逐格判据）—— 挖开一格水/岩浆之前先判"这一步会不会把自己淹了/烫了"。
 * 判据只此一份（`assessExcavationFluidRisk` / `isFlowPassable` / `injectFluidBreakGuard`）。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

// ---------------------------------------------------- 流体安全（逐格判据）

/**
 * 挖掉某一格会不会把液体引过来。
 *
 * 为什么需要独立于 `allowDig`：那个是**全局一刀切**开关，只有"能挖/不能挖"两个状态。
 * 但真实情况是"可以挖，别把水挖穿"—— 挖泥土取平地和挖穿水池下方的隔层是两件事。
 * 实测踩过一次：摘柠檬时挖到水边，人下去了。（记忆见 memory/2026-09-25.md）
 *
 * 判据分两层（第二层是抄 HiyoriAI `assessExcavationFluidRisk` 的，它比第一层重要）：
 *   ① 六邻域有没有液体 —— 直接相邻，挖开就连通了。
 *   ② **正上方 32 格内**有没有液体，且中间一路都是"可流通"的方块。
 *      这一层覆盖的是**服务端更新窗口**：水柱底下是空气时，那些空气格还没变成
 *      `flowing_water`，按第一层的判据看是"安全的"，但挖开的下一 tick 水就下来了。
 *      只看六邻域必然漏掉这种情况。
 *
 * @returns {{unsafe:boolean, liquid?:string, source?:{x,y,z}, via?:'adjacent'|'above'}}
 */
function assessExcavationFluidRisk (bot, position) {
  if (!bot?.blockAt || !position) return { unsafe: false };

  // ① 六邻域（其实只查 5 个：正下方那格是脚底，挖它不会引水到自己头上）
  const adjacent = [
    [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1],
  ];
  for (const [dx, dy, dz] of adjacent) {
    const p = { x: position.x + dx, y: position.y + dy, z: position.z + dz };
    const name = String(bot.blockAt(p, false)?.name ?? '');
    if (LIQUID_NAMES.has(name)) {
      return { unsafe: true, liquid: name, source: p, via: 'adjacent' };
    }
  }

  // ② 正上方一路扫上去，直到撞到实体方块
  for (let dy = 1; dy <= MAX_VERTICAL_FLOW_LOOKAHEAD; dy++) {
    const p = { x: position.x, y: position.y + dy, z: position.z };
    const block = bot.blockAt(p, false);
    const name = String(block?.name ?? '');
    if (LIQUID_NAMES.has(name)) {
      return { unsafe: true, liquid: name, source: p, via: 'above' };
    }
    // 撞到不透水的方块就停 —— 中间有隔断，上面的水是下不来的。
    // `boundingBox === 'empty'` 覆盖空气/草/花/告示牌等一切"能过水"的东西。
    if (!isFlowPassable(block)) break;
  }

  return { unsafe: false };
}

/** 水能不能从这里流过去。空气与一切无碰撞箱的方块都算通透。 */
function isFlowPassable (block) {
  if (!block) return false;
  const name = String(block.name ?? '');
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return true;
  // 名字认不出来（模组方块）时按**不透水**处理：宁可高估安全，也别把水放进来。
  if (!name) return false;
  return block.boundingBox === 'empty' && !LIQUID_NAMES.has(name);
}

/**
 * 把流体风险装进 A* 的破坏代价。
 *
 * ⚠️ 用的是 `exclusionAreasBreak` 而不是 `blocksCantBreak`：
 *    前者是**按位置**判定的函数数组（每一格单独算），后者是**按方块 id**的静态集合。
 *    "这一池水旁边的泥土"和"山那边的泥土"是同一个 id，但风险完全不同 ——
 *    只有按位置才能区分。
 *
 * 为什么返回 100 而不是 Infinity：100 是 pathfinder 里"不可通行"的约定值
 * （见 `movements.js` 的 `if (!this.safeToBreak(block)) return 100`），
 * 但用函数返回它**不会**污染 `blocksCantBreak` 那个集合，也不影响别的寻路任务。
 *
 * @returns {{applied:boolean, reason?:string}}
 */
function injectFluidBreakGuard (bot, mv, opts = {}) {
  if (!mv) return { applied: false, reason: '没有 Movements 实例' };
  if (!bot?.blockAt) return { applied: false, reason: 'bot 还没有 blockAt（未连接？）' };
  if (mv[FLUID_GUARD_FLAG]) return { applied: true, reason: '已经装过了（幂等）' };

  const penalty = opts.penalty ?? 100;
  mv.exclusionAreasBreak = mv.exclusionAreasBreak || [];
  mv.exclusionAreasBreak.push((block) => {
    if (!block?.position) return 0;
    return assessExcavationFluidRisk(bot, block.position).unsafe ? penalty : 0;
  });

  // 打标记：同一个 Movements 上重复调用会不断往数组里塞函数，
  // 每一格被评估 N 次 —— 性能问题，而且没意义。
  Object.defineProperty(mv, FLUID_GUARD_FLAG, { value: true, enumerable: false });

  return { applied: true };
}

// ---- 跨文件名字（第 3 步重构）------------------------------------------------
//
// 拆之前所有顶层声明都在**一个作用域**里，谁先谁后都无所谓；拆开之后本文件用到的
// 隔壁名字必须靠汇总 `index.js` 在**所有子文件都加载完**之后 `bind()` 回来，
// 否则 require 期就 `ReferenceError`（见 src/body/AGENTS.md「循环依赖」那段）。
const __ns = {};
let LIQUID_NAMES;
let MAX_VERTICAL_FLOW_LOOKAHEAD;
let FLUID_GUARD_FLAG;
function bind (ns) { Object.assign(__ns, ns); LIQUID_NAMES = ns.LIQUID_NAMES; MAX_VERTICAL_FLOW_LOOKAHEAD = ns.MAX_VERTICAL_FLOW_LOOKAHEAD; FLUID_GUARD_FLAG = ns.FLUID_GUARD_FLAG; }

module.exports = {
  assessExcavationFluidRisk,
  isFlowPassable,
  injectFluidBreakGuard,
  bind,
};
