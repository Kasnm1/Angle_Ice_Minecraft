'use strict';

/**
 * 自适应采集搜索 —— `POST /mine` 的"这一趟怎么搜"：半径阶梯（`buildRadiusLadder`）、
 * "这一轮有没有收获"（`isProductiveSweep`）、下一轮该扩半径还是该收工（`nextCollectStep`）。
 * 全是纯函数，可离线穷举。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

// ------------------------------------------------------------------ 自适应采集搜索
//
// ## 为什么需要
//
// `/mine` 原来是"在 64 格内找一个方块，找不到就报没有"。问题是这个词的语义：
// **"附近没有"和"我找不到"在接口上是同一句话**。她于是会说"这里没有铁矿"——
// 而实际上矿在 70 格外的洞里，只是搜索半径是 64。
//
// ## 抄什么（对标 HiyoriAI 的 `collectionStrategy.ts`）
//
// `runAdaptiveCollection` 的思路：**半径从一个小的初始值开始，每轮没收获就翻倍**，
// 直到上限为止。两个细节值得照抄：
//   ① 本轮**有收获就不扩半径** —— 说明这一带就有，继续在这儿挖更划算
//   ② 循环的终止判据用 **`gainedItems`**（背包真正多了几件）而**不是**
//      `collectedBlocks`（挖了几格）。两者不等：挖了石头却没捡到（背包满、
//      被别的玩家抢、掉进岩浆）时，"挖到了"是假进展，会让她无意义地待在这里。
//
// 我们这边多一条 HiyoriAI 没有的约束：**搜不到的半径要如实报告**。
// 所以这里返回的是"每轮试了多大、为什么停"，而不是只返回结果。

/** 采集搜索的默认参数。数值与 HiyoriAI 对齐（它有 `MAX_COLLECTION_SEARCH_RADIUS=128`）。 */
const COLLECT_SEARCH = {
  initialRadius: 16,
  /** 半径上限。超过这个就没必要了 —— 寻路本身会先超时。 */
  maxRadius: 128,
  /** 最多扩几次（= 最多搜索轮数）。防止半径停在某个值上永远循环。 */
  maxSweeps: 6,
};

/**
 * 生成采集搜索的半径序列。
 *
 * 纯函数，便于穷举 —— 真正"扩半径"的循环在 bridge-server 里（要调 findBlock）。
 *
 * ⚠️ 为什么"有收获就不扩半径"这件事不在这个函数里：它是**循环的控制流**，
 *    不是半径序列的性质。这里只负责"没收获时下一轮该多大"。
 *
 * @param {object} [opts] { initialRadius, maxRadius, maxSweeps }
 * @returns {number[]} 例：[16, 32, 64, 128]
 */
function buildRadiusLadder (opts = {}) {
  const init = Math.max(1, Math.floor(opts.initialRadius ?? COLLECT_SEARCH.initialRadius));
  const max = Math.max(init, Math.floor(opts.maxRadius ?? COLLECT_SEARCH.maxRadius));
  const sweeps = Math.max(1, Math.floor(opts.maxSweeps ?? COLLECT_SEARCH.maxSweeps));

  const out = [init];
  let r = init;
  while (out.length < sweeps && r < max) {
    r = Math.min(max, r * 2);
    out.push(r);
    if (r === max) break;
  }
  return out;
}

/**
 * 判断这一轮算不算"有收获"。
 *
 * @param {object} p
 * @param {number} p.gainedItems  背包里**真正多了几件**（服务端判定的结果）
 * @param {number} p.brokenBlocks 挖掉了几格（客户端动作成功了）
 * @param {boolean} [p.inventoryFull] 背包是不是满了
 * @returns {{productive:boolean, reason:string}}
 *
 * ⚠️ 判据是 `gainedItems`，不是 `brokenBlocks`。两者不等的情形很具体
 *    （2026-09-25 实战全部见到过）：
 *    - **挖完就走没回头捡** —— 掉落物落在地上，要走过去才被服务端判定拾取。
 *      实测：砍 8 个 lemon_log 只到手 1 个（见 memory/field-log.md P1）
 *    - 背包满：挖下来但捡不起来
 *    - 挖的是水下的方块：方块掉了但物品沉了
 *    - 别的玩家抢走
 *    这几种情况下 `brokenBlocks > 0` 但 `gainedItems === 0`，
 *    按 `brokenBlocks` 判会认为"有进展"，于是她会在一个拿不到东西的地方反复挖。
 *
 * `inventoryFull` 的作用是**让理由说得准**：运维时"背包满"和"没回头捡"
 * 的处理方式完全不同（前者该丢东西，后者是代码问题），不该共用一句文案 ——
 * 这正是 P2 暴露出来的毛病。
 */
function isProductiveSweep ({ gainedItems = 0, brokenBlocks = 0, inventoryFull = false } = {}) {
  if (gainedItems > 0) {
    return { productive: true, reason: `+${gainedItems} 件` };
  }
  if (brokenBlocks > 0) {
    if (inventoryFull) {
      return { productive: false, reason: `挖了 ${brokenBlocks} 格但背包满，捡不起来 —— 该先丢东西` };
    }
    return { productive: false, reason: `挖了 ${brokenBlocks} 格但一件都没进包（没回头捡？被抢？掉水里？）` };
  }
  return { productive: false, reason: '这一带没有可挖的' };
}

/**
 * 决定采集循环的下一步。
 *
 * @param {object} p
 * @param {number} p.sweep        已经搜过几轮（从 1 开始）
 * @param {boolean} p.hit         本轮有没有找到目标方块
 * @param {boolean} p.productive  本轮算不算有收获（见 isProductiveSweep）
 * @param {number} p.wanted       还要几件
 * @param {number} p.got          已经拿到几件
 * @param {number[]} p.ladder     半径序列
 * @param {string} [p.why]        `isProductiveSweep` 给出的**具体原因**，见下
 * @returns {{action:'continue'|'widen'|'done'|'give-up', radius:number|null, reason:string}}
 *
 * ## `why` 这个参数为什么必须存在（P2 → P2b 的教训）
 *
 * P2 把 `isProductiveSweep` 改成了能区分三种"没收获"的原因
 * （背包满 / 挖了没捡 / 没得挖），自测也全绿了。
 * **但实机上 `sweeps` 里看到的还是那句模糊的"目标在但拿不到"** ——
 * 因为这个函数自己硬编码了同一句 reason，把上游的结论**丢掉了**。
 *
 * 于是"分层诊断"做得再好，在最后一跳被抹平：
 *   `isProductiveSweep` 说"背包满" → `nextCollectStep` 说"拿不到" → 运维看不到真正的原因。
 *
 * 修法不是再改一次文案，而是**让原因能透传**：调用方把 `why` 交进来，
 * 本函数原样带出去。谁判断的原因，谁就负责说清楚。
 */
function nextCollectStep ({ sweep = 1, hit = false, productive = false, wanted = 1, got = 0, ladder = [], why = '' } = {}) {
  if (got >= wanted) {
    return { action: 'done', radius: null, reason: `够了（${got}/${wanted}）` };
  }
  // 有收获就不扩半径 —— 这一带就有，继续在这儿挖更划算。
  // 注意这里**也**包括"找到了但还没拿到"：说明目标在，只是还没挖完。
  if (productive) {
    return { action: 'continue', radius: ladder[sweep - 1] ?? null, reason: '这一带有收获，继续' };
  }
  // 没找到目标：扩半径。注意与上一条的区别 —— 上一条是"找到了没收获"，
  // 这条是"连目标都没找到"。两种情况的应对完全不同。
  if (!hit) {
    if (sweep >= ladder.length) {
      return {
        action: 'give-up',
        radius: null,
        reason: `搜到 ${ladder[ladder.length - 1] ?? 0} 格都没有（共 ${sweep} 轮）`,
      };
    }
    return {
      action: 'widen',
      radius: ladder[sweep],
      reason: `这一轮（${ladder[sweep - 1]} 格）没找到，扩到 ${ladder[sweep]} 格`,
    };
  }
  // 找到了但没收获（挖了捡不到）：换地方比死磕更理性，但**不扩半径** ——
  // 问题不在"太远"，在"拿不到"。所以按"continue"处理，让调用方自己决定放弃。
  //
  // ⚠️ reason **必须**用上游给的 `why`。不要再写死一句话 —— 那正是 P2b 的 bug：
  //    分了三类原因，却在这里被统一盖掉。
  //    兜底也保留，但只在调用方**没给**原因时才用（给个诚实的"不知道"）。
  return {
    action: 'continue',
    radius: ladder[sweep - 1] ?? null,
    reason: why || '找到了但没到手（原因未上报 —— 调用方该传 why）',
  };
}

module.exports = {
  COLLECT_SEARCH,
  buildRadiusLadder,
  isProductiveSweep,
  nextCollectStep,
};
