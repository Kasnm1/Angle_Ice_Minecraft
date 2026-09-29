/**
 * routes/mine.js —— 从 server.js 的 handlers 表拆出的 1 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const instinct = require('../../instinct/instinct.js');
const pathing = require('../../world/pathing');
const placeLogic = require('../../world/place');
const survival = require('../../instinct/survival.js');
// 挖之前挑工具（2026-09-29）：判据只此一处（body/tool-choice.js）。
// 这个包在 Windows 上**没装** mineflayer-tool（启动日志："三个反射插件都没装"），
// 所以 bot.dig() 手上是什么就用什么 —— 以前她拿镐子挖黏土、拿剑砍树。
// tool-choice 是独立模块（不 require 兄弟文件），不会成环；ensureCarried 走 hands（同 place.js）。
const toolChoice = require('../../body/tool-choice');
const hands = require('../../body/hands.js');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const { reachableStandY } = require('../../world/place');   // 原 server.js:31 从 place.js 解构；拆分时被错做成 __ns 转发壳（没人导出，DEADLY 还是正则），2026-09-29 改回
// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleep } = require('../../util/time');
const __ns = {};

let state;
let Vec3;
let goals;

/**
 * `/mine` 的水下安全线（第 1/4 条）。
 *
 * ⚠️ 阈值**只有一份**，在 `src/instinct/config.js` 的 `CFG.bridgeMine`（理由写在那里：
 * 为什么 `dryOxygenAt` 是 14、为什么换完气要等 30 秒）。
 * 这里只做"取不到配置就用同一份默认值"的兜底 —— 配置读不到时**不能**退化成"不保护"。
 * 判据本身在 `instinct/survival.js` 的 `mineShouldStop` / `underwaterKeep`，与本文件无关。
 */
const SURVIVE = (() => {
  const d = { dryOxygenAt: 14, afterBreathMs: 30000 };
  try {
    const CFG = require('../../instinct/config.js').CFG;
    return { ...d, ...(CFG.bridgeMine || {}) };
  } catch (_) { return d; }
})();

/**
 * 矿表 `knowledge/ores.json`（byId 不用，这里要 **byName**）。
 *
 * 为什么在这里读：判"水下的东西值不值钱"要它的 `value` / `tier`，而**不许另编一份名单**
 * （AGENTS.md §5-4）。本能采矿用的是同一份文件（`instinct/core.js` 的 `loadTables`，
 * `ores.json` → `{ name, tier, value, drops? }`），所以这里按 `name`（去掉 `minecraft:` 前缀）
 * 建索引，和那边**同一个真值来源**。
 *
 * 读不到 → null（= 判不了"值钱"），调用方据此只保留"只有水下才有"这一条放行 ——
 * **不是**"所有水下的都能挖"（保守一侧）。
 */
let _oreTable;
function oreTable () {
  if (_oreTable !== undefined) return _oreTable;
  try {
    const rows = JSON.parse(require('fs').readFileSync(require('path').join(require('../../paths').KNOWLEDGE, 'ores.json'), 'utf8'));
    const by = {};
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.name) continue;
      by[String(r.name)] = r;
      by[String(r.name).replace(/^minecraft:/, '')] = r;
    }
    _oreTable = by;
  } catch (_) { _oreTable = null; }
  return _oreTable;
}

function gotoWithBudget (...a) { return __ns.gotoWithBudget.apply(null, a); }
function inventoryCount (...a) { return __ns.inventoryCount.apply(null, a); }
function isDropEntity (...a) { return __ns.isDropEntity.apply(null, a); }
function isPlayerBuilt (...a) { return __ns.isPlayerBuilt.apply(null, a); }
function resolveBlocksForItem (...a) { return __ns.resolveBlocksForItem.apply(null, a); }
function stripNamespace (...a) { return __ns.stripNamespace.apply(null, a); }
function sweepUpDrops (...a) { return __ns.sweepUpDrops.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（1 条）：
 *   POST /mine
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'POST /mine': async ({ blockName, byItem, count = 1, maxRadius, allowUnderwater = false, abort }) => {
    if (!blockName && !byItem) throw new Error('blockName 或 byItem 至少给一个');
    count = Math.min(Math.max(1, +count), 64);

    // ---- 解析目标方块 id
    let blockId = null;
    let resolvedVia = null;
    let resolveSource = 'blockName';
    let resolveCandidates = 0;
    if (byItem) {
      const found = resolveBlocksForItem(state.bot, byItem);
      if (!found.blocks.length) {
        // ⚠️ 这里**绝不能说"它不能挖"**。
        //
        // 2026-09-25 的教训（见 memory/field-log.md P4）：第一版把这种情况报成
        // "不是靠挖掘获取的（作物类没有 drops）"，而当时的目标是 `lemon_log` ——
        // 一个明明刚用 blockName 挖成功的方块。原因是我只在原版 `drops` 表里查，
        // 而模组方块一个都不在那张表里。
        //
        // **"我查不到"被写成了"它不行"** —— 这是最坏的错误提示，
        // 因为它会让上层放弃一个完全可行的方法（改回 blockName 就行了）。
        // 所以现在只说"我查不到"，并给出可操作的下一步。
        const known = Object.keys(state.bot.registry.itemsByName || {})
          .some(n => stripNamespace(n) === stripNamespace(byItem));
        throw new Error(known
          ? `找不到会掉落 ${byItem} 的方块（已查原版 drops 表 + 名字规律，都没命中）。`
            + `这不代表它挖不到 —— 直接用 blockName 试，比如 /mine {"blockName":"<方块名>"}`
          : `注册表里没有 ${byItem} 这个物品（名字拼错？）`);
      }
      blockId = found.blocks[0].id;
      resolveSource = found.resolveSource;
      resolveCandidates = found.blocks.length;
      resolvedVia = `byItem:${byItem}[${found.resolveSource}] → ${found.blocks.slice(0, 4).map(f => f.name).join('/')}`;
    } else {
      // 原版方块在注册表里不带 minecraft: 前缀（她常写 minecraft:stone，实测报 Unknown block）
      const def = state.bot.registry.blocksByName[blockName] || state.bot.registry.blocksByName[String(blockName).replace(/^minecraft:/, '')];
      if (!def) throw new Error(`Unknown block: ${blockName}`);
      blockId = def.id;
      resolvedVia = `blockName:${blockName}`;
    }
    const label = byItem || blockName;

    const myTag = `mining ${count}x ${label}`;
    state.currentAction = myTag;
    const mined = [];
    const sweeps = [];
    // 发生过几次"dig 声称成功但方块还在"（见 P1c）。
    // **必须暴露** —— 它和"真的挖不动"是两种完全不同的故障，
    // 混在一起会让运维去查错方向（去查工具/硬度，而不是查动作没生效）。
    const digStalls = [];
    // 挖每块之前挑了什么工具（2026-09-29 新增）。**必须暴露** ——
    // "她还在用错工具挖"和"挑工具没生效"是两种不同的故障，混在一起只能看到"挖得慢"。
    const toolsUsed = [];
    const maxR = maxRadius ? Math.max(1, +maxRadius) : null;
    const ladder = pathing.buildRadiusLadder(maxR ? { initialRadius: Math.min(maxR, 8), maxRadius: maxR } : {});
    let aborted = false;
    let sweep = 1;
    let radius = ladder[0];
    let dropsPicked = 0;   // 真正进背包的件数（由背包增量判定，不是"走过去过"）
    // 掉落物"最后落在哪儿"的坐标集合 —— 用于挖完之后**统一清扫一次**。
    // 见下方 "批量清扫" 段：逐块等待既慢又会互相错位（P10 第二轮）。
    const dropAnchors = [];
    const skipped = new Set();   // 够不着 / 挖不掉的格子：这次不再选
    // 不开透视：只挖她**看得见**的（眼睛到方块的视线没被挡），或者和刚挖掉的那块相连的（顺着矿脉、树干往下挖，玩家也是这样）。
    // 以前直接查方块表，隔着几十格石头也知道哪有铁 —— 主人说"这不就是矿物透视吗"（2026-09-27）。找矿用 POST /delve
    const vein = new Set();
    const invBefore = inventoryCount(state.bot);
    let mineSeen = null;   // 最后一轮的筛选统计（挖不到时拿来说原因）
    // 水下的惜命记录（第 1/2 条）。**必须暴露** —— "她没挖水下的"和"规则把她拦住了"
    // 是两种完全不同的结果，混在一起只能看到"没挖到"。
    let needAir = null;      // {why, oxygen, at} 满足"该停下换气"时的理由
    let underwaterInfo = null;

    // ---- 水里惜命：挖每一块之前（以及走过去之前）都查一次（第 1 条）--------------
    //
    // 2026-09-29 实机：那片沙子在**水底**（水面 y≈63，沙在 y=58–62），她一块接一块往下挖，
    // 氧气 8/20 触发憋气本能、上来换完气又潜回去，第二次跳了 38 下没浮上去，氧气掉到 -1 开始掉血。
    // 判据只在 `instinct/survival.js` 的 `mineShouldStop`（和憋气本能共用一份），这里只负责读世界。
    const airGuard = () => {
      try {
        const oxy = survival.oxygenNum(state.bot.oxygenLevel ?? null);
        const wetHead = survival.headInWater(state.bot);
        const eff = state.instinct?.effectNames?.() ?? null;
        const stop = survival.mineShouldStop({ headInWater: wetHead, oxygen: oxy, waterBreathing: survival.waterBreathing(eff) }, { dryOxygenAt: SURVIVE.dryOxygenAt });
        return { ...stop, oxygen: oxy, headInWater: wetHead };
      } catch (_) { return { stop: false }; }
    };
    // 刚换完气不许马上又潜回去（第 4 条）：本能上浮成功会记 `state.instinct.breathedAt`。
    const justBreathedMs = () => {
      const at = state.instinct?.breathedAt;
      return at ? Date.now() - at : Infinity;
    };

    try {
      for (;;) {
        if (mined.length >= +count) {
          sweeps.push({ sweep, radius, action: 'done', reason: `够了（${mined.length}/${+count}）` });
          break;
        }
        if (typeof abort === 'function' && abort()) {
          aborted = true;
          sweeps.push({ sweep, radius, action: 'aborted', reason: '被新的命令打断' });
          break;
        }
        // ★ 每一轮开始（= 挖下一块之前、走过去之前）先看气
        const air = airGuard();
        if (air.stop) {
          needAir = air;
          sweeps.push({ sweep, radius, action: 'need-air', reason: air.why });
          break;
        }
        const before = inventoryCount(state.bot);
        // 选她够得着的：高度差 ≤4 的优先、露在外面（旁边有空气）的优先；够不着/挖不掉的记进 skipped 不再选。
        // 2026-09-26 实测：直线最近的那块石头在她脚下 17 格（y=106 vs 123），下面 GoalNear 只管水平距离，
        // 一下就"到达"了，然后在 17 格外空挥镐子，同一格来回挖了几十次（主人看到的"在家里跳着不知道在挖什么"）
        const me = state.bot.entity.position;
        const exposed = (p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
          .some(([dx, dy, dz]) => { const b = state.bot.blockAt(p.offset(dx, dy, dz)); return b && b.boundingBox === 'empty'; });
        // 别拆房子：紧挨着人造方块（木板/门/玻璃/楼梯…）的格子不挖。新手小屋的柱子就是 oak_log，
        // 她说"去砍树"时最近的"树"是自己家（2026-09-27 实测家周围 82 块原木被当成可砍）。
        // 目标本身就是人造方块（要拆木板、拆箱子）时不拦 —— 那是有意的。
        const guardHome = !isPlayerBuilt(state.bot.registry.blocks[blockId]?.name);
        const nearBuilt = (p) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const b = state.bot.blockAt(p.offset(dx, dy, dz)); if (b && isPlayerBuilt(b.name)) return true;
        } return false; };
        // 每一关筛掉几块都记下来：一块都挖不到时要说清楚是"没有"还是"看不见 / 太高太低 / 挨着房子"（AGENTS.md §5-1）
        const all = state.bot.findBlocks({ matching: blockId, maxDistance: radius, count: 512 });   // 只取最近 64 块时，附近埋着的会把露出来的挤掉
        const f1 = all.filter(p => !skipped.has(`${p.x},${p.y},${p.z}`));
        const f2 = f1.filter(p => !guardHome || !nearBuilt(p));
        // 看得见 = 视线打得到，或者有一面露在洞里的空气/水里（placeLogic.exposedToOpen；只露一面的矿以前被判成看不见）
        const cands = f2.filter(p => vein.has(`${p.x},${p.y},${p.z}`) || state.bot.canSeeBlock(state.bot.blockAt(p))
          || placeLogic.exposedToOpen(p, (x, y, z) => state.bot.blockAt(new Vec3(x, y, z))));

        // ---- 默认不挖水里的东西（第 2 条。主人 2026-09-29：「不应该优先挖水中的东西，
        //      除非那个只在水里或者很重要」）------------------------------------------
        //
        // 判据只在 `survival.underwaterKeep`（一份）。这里只负责读世界 + 判"值不值钱"。
        // ⚠️ "值不值钱"用**现成的矿表** `knowledge/ores.json` 的 `value` / `tier`
        //    （本能采矿用的就是它，见 `instinct/core.js` 的 `loadTables`），
        //    不另编一份名单。矿表读不到 = 判不了"值钱" → 那就只有"附近只有水下才有"这一条能放行。
        const bareLabel = String(label).replace(/^minecraft:/, '');
        const table = oreTable();
        const oreRow = (table && (table[bareLabel] || table[String(label)])) || null;
        const valuable = !!oreRow && (oreRow.value === 'high' || oreRow.value === 'mid' || oreRow.tier != null);
        const isWet = (p) => {
          // 泡在水里 = 自己这格是水，或者**上方一格是水**（水底的沙子就是这种：它上面是水）
          const self0 = state.bot.blockAt(p);
          if (self0 && survival.blocksWater(self0.name, self0.getProperties?.())) return true;
          const above = state.bot.blockAt(p.offset(0, 1, 0));
          return !!(above && survival.blocksWater(above.name, above.getProperties?.()));
        };
        const dryCount = cands.filter(p => !isWet(p)).length;
        const wetCands = cands.filter(p => isWet(p));
        const uwKeep = survival.underwaterKeep({ underwater: true, drySameCount: dryCount, valuable, requested: !!allowUnderwater });
        if (wetCands.length) {
          underwaterInfo = { found: wetCands.length, skipped: uwKeep.keep ? 0 : wetCands.length, drySame: dryCount, allowedBy: uwKeep.keep ? uwKeep.why : null, why: uwKeep.why, valuable };
        }
        const cands2 = uwKeep.keep ? cands : cands.filter(p => !isWet(p));

        // 高低差 4 → 8（2026-09-28 实机：矿洞里天花板上的矿常超过 4 格，全被筛掉，报成"128 格都没有"）
        const scoredAll = cands2.map(p => ({ p, dy: Math.abs(p.y - Math.floor(me.y)), d: p.distanceTo(me), open: exposed(p) }));
        mineSeen = { radius, found: all.length, skippedBefore: all.length - f1.length, nearHouse: f1.length - f2.length, hidden: f2.length - cands.length, tooHighLow: scoredAll.filter(c => c.dy > 8).length, underwater: wetCands.length, underwaterSkipped: underwaterInfo ? underwaterInfo.skipped : 0 };
        const scored = scoredAll
          .filter(c => c.dy <= 8)
          .sort((a, b) => (b.open - a.open) || (a.d - b.d));
        const block = scored.length ? state.bot.blockAt(scored[0].p) : null;
        const hit = Boolean(block);

        if (hit) {
          const where = { x: block.position.x, y: block.position.y, z: block.position.z };
          try {
            // ★ 这块**在水下**？走过去之前再确认一次气（第 1/4 条）。
            //
            // 为什么还要在这里再查一次：上面那一次检查在"选目标"之前，而选完目标
            // 还要 `gotoWithBudget` 走一段（几秒到几十秒）。玩家日志里她就是
            // "换完气 → 走过去 → 潜下去"，走到半路气就没了。所以走过去**之前**、
            // 以及真正 dig 之前，各查一次。
            const wetTarget = isWet(block.position);
            if (wetTarget) {
              // 第 4 条：刚换完气（本能上浮成功记 `breathedAt`）不许马上又潜回去
              const sinceBreath = justBreathedMs();
              if (sinceBreath < SURVIVE.afterBreathMs) {
                needAir = { why: `刚上去换完气 ${Math.round(sinceBreath / 1000)} 秒，这片东西在水下，先别急着潜回去`, justBreathed: true };
                sweeps.push({ sweep, radius, action: 'just-breathed', reason: needAir.why });
                break;
              }
              const air2 = airGuard();
              if (air2.stop) {
                needAir = air2;
                sweeps.push({ sweep, radius, action: 'need-air', reason: air2.why });
                break;
              }
            }
            // ⚠️ 这里原来用 `GoalLookAtBlock` —— 它要求**能"看到"**那个方块，
            //    也就是必须在同高度或更高处且视线不被挡。而实战里最常挖的木头
            //    长在她**头顶上方 4~5 格**（`(77,68,-128)` vs 她站在 y=64），
            //    于是寻路永远不满足、反复重规划 —— P9 的 150 秒就是这么来的。
            //
            // 挖矿真正需要的只是"**站得够近**"（原版挖掘距离约 4.5 格），
            // 不需要那种严格的视线条件。
            //
            // ⚠️⚠️ 但 `GoalNear(x, y, z, 3)` **仍然不对** —— 这是
            //    2026-09-25 第三次实战抓出来的（field-log P11）。
            //
            //    症状：`[goto] mine autumnity:maple_log → 停滞判定，放弃（moved=0.14）`
            //          连试 3 次、每次 ~15s 全部停滞，`currentAction` 永远卡在 mining。
            //
            //    根因：`GoalNear` 的球心是**方块自己的坐标**。木头在 `(4,94,7)`，
            //    而她在 `y=91` —— 要满足"距 (4,94,7) ≤ 3"，她得**爬高 3 格**。
            //    树干下方那几格是树叶与悬空，寻路器爬不上去（`canDig=false`，
            //    它不能为了爬高而拆方块），于是越走越远 → 停滞 → 放弃。
            //
            //    正确的语义是：**在"她已经站得住的高度"上，水平靠近到够得着**。
            //    · Y 用她自己的 y —— 不去要求她改变高度；
            //    · 只约束水平距离；
            //    · 高度差交给后面的 dig 判断（原版从下往上挖 3~4 格完全够得到）。
            //    下面的实现就是把 y 换成她的 y，并把球心向上抬 1 格，
            //    因为那样"水平距离 ≤3 且脚下有路"的站位通常就在树根边上。
            const eyeY = Math.floor(state.bot.entity.position.y);
            const goRes = await gotoWithBudget(
              state,
              new goals.GoalNear(block.position.x, eyeY, block.position.z, 3),
              { label: `mine ${label}`, abort },
            );
            // ---- 有序中止：这次 goto 是"我们自己收手"，不是"没走成" ----------------
            //
            // N-1 的修法落点。以前这里不传 `abort`、也不看返回值 —— 于是
            // 本能层取消（战斗/危险方块）造成的 `GoalChanged` 会被当成普通寻路失败，
            // 进入下一轮重选目标 + 重规划（81 次里 80 次的观感就是"一直在重规划"）。
            // 现在：取消线一到，goto 归为 `aborted`，这里**立刻退出整条 /mine**，
            // 不再把已作废的挖矿继续跑下去。
            if (goRes?.aborted) {
              aborted = true;
              sweeps.push({ sweep, radius, action: 'aborted', reason: `寻路被取消（${goRes.abortedReason}）` });
              break;
            }

            // ---- 挖，并且**验证真的挖掉了** --------------------------------------
            //
            // ⚠️⚠️⚠️ 这一段是 2026-09-25 第二次实战抓出来的（field-log 的 P1c）。
            //
            // 症状：`POST /mine` 返 `HTTP 200 / 0.14s / mined:1`，
            //       但**那格木头纹丝不动**，`/scan` 里还在原位。
            //
            // 0.14 秒挖一格木头在物理上不可能（徒手也要好几秒）。
            // 真相是：`bot.dig()` **直接 resolve 了，没干活** ——
            // 不抛错、不超时，于是 `withTimeout` 和 `catch` 全都拦不住。
            // 于是 `mined` 是个**假数字**，上层（autopilot）据此以为"挖到了"。
            //
            // 这是最难查的一类 bug：**动作声称成功、世界没有变化**。
            // 唯一可靠的防法是**去世界里核对**，而不是相信返回值。
            // 走完了还够不着（比如隔着地板、在脚下深处）：跳过这一格，别在这儿空挥
            const reach = state.bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
            if (reach > 5) {
              skipped.add(`${block.position.x},${block.position.y},${block.position.z}`);
              sweeps.push({ sweep, radius, action: 'skip', reason: `够不着（${reach.toFixed(1)} 格）` });
              if (skipped.size > 6) { sweeps.push({ sweep, radius, action: 'giveup', reason: '附近的都够不着' }); break; }
              continue;
            }
            const beforeBlock = state.bot.blockAt(block.position);
            const beforeName = beforeBlock?.name ?? null;

            // ★ 真正 dig 之前的最后一道气闸（第 1 条）。选了目标、走了一段、挑完工具之后，
            //   她可能已经在水底待了好几秒 —— 这是"挖这一块之前"的最后一个检查点。
            if (wetTarget) {
              const air3 = airGuard();
              if (air3.stop) {
                needAir = air3;
                sweeps.push({ sweep, radius, action: 'need-air', reason: `${air3.why}（开挖前最后一道）` });
                break;
              }
            }

            // 挖之前把"这个方块该用的工具"弄到手上（2026-09-29）：
            // 用 block 本体（不是 registry 查出来的 def）判 —— 它带着真实的 material / harvestTools。
            // 身上没有就去精妙背包拿（ensureCarried：身上够时不开界面，所以不会每块都慢）。
            // 任何一步失败都只 took:false，**不阻断挖掘**（不许因为没铲子就不挖）。
            // 记进 sweep 记录，便于实机核对"到底换没换"。
            const toolPick = await toolChoice.ensureDigTool(state.bot, block, state, hands.ensureCarried);
            if (toolPick?.name) toolsUsed.push({ at: where, kind: toolPick.kind, name: toolPick.name, source: toolPick.source });

            await withTimeout(state.bot.dig(block));

            // 核对：那格现在还是不是原来那个方块？
            // · 变成 air（或别的方块）→ 真的挖掉了
            // · 还是原方块 → **dig 没生效**
            const afterBlock = state.bot.blockAt(block.position);
            const afterName = afterBlock?.name ?? null;
            const reallyBroken = afterName !== beforeName;

            if (!reallyBroken) {
              // ⚠️ 这里**不 push 进 mined**。宁可如实报 0，也不要一个漂亮但假的数字。
              sweeps.push({
                sweep, radius, action: 'error',
                reason: `dig 声称成功但方块还在（${beforeName} @ ${where.x},${where.y},${where.z}）—— 世界没有变化`,
              });
              // 短暂让路再试：这类"dig 空转"有时是因为动作被上一个动作占用，
              // 或服务端在该 tick 拒了。立刻重试同一个目标往往就成功了。
              digStalls.push({ at: where, name: beforeName });
              await sleep(250);
              continue;
            }

            // ⚠️⚠️ 掉落物回收：**先"轻触"一下，挖完再统一清扫**。
            //
            // 这是 2026-09-25 实战抓出来的（见 memory/field-log.md P1 / P10）。
            //    · P1：`dig()` 只把方块拆掉，物品落在地上要**走过去**才被服务端判定拾取。
            //    · P10（第一层）：掉落物**不是立刻就出现**的 —— 服务端生成 + 网络同步
            //      要几百毫秒。挖完立刻查实体表必然查不到，于是 `seen: 0`。
            //      所以 `sweepUpDrops` 会先**轮询等它出现**，再捡。
            //    · P10（第二层，本轮）：**给每块都等满 2.5 秒是纯浪费**。
            //      实测：连挖 3 格同一棵树，第 1 格 `waitedMs:2600` 什么都没等到
            //      （它的掉落物和后面两块落在同一片区域，直到第 2 轮才被看到），
            //      第 3 格反而 `waitedMs:0` 直接命中。
            //
            //      因为**掉落物堆在一起**，不存在"这一块的掉落物必须在这一轮捡完"。
            //      所以改成：
            //        · 每挖一格后只做一次**极短的**探手（waitMs 小），顺手就捡；
            //        · 把落点记进 `dropAnchors`；
            //        · 挖够 count 之后，对整片区域做**一次**统一清扫（半径大、预算足）。
            //      这样既不会漏，也不会为每块各等一次。
            const swept = await sweepUpDrops(state.bot, where, {
              radius: 3, waitMs: 450, budgetMs: 2000, settleMs: 600,
            });
            dropsPicked += swept.picked;
            if (swept.seen > swept.picked || swept.seen === 0) dropAnchors.push(where);

            mined.push({ at: where, name: beforeName, nowIs: afterName, drops: swept });
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) vein.add(`${where.x + dx},${where.y + dy},${where.z + dz}`);
          } catch (e) {
            sweeps.push({ sweep, radius, action: 'error', reason: `挖 ${block.name} 失败：${e.message}` });
            // 单块失败不直接放弃：可能是被卡住，换个目标还有机会。
            // 但**不扩半径** —— 问题不是"太远"。
            sweeps.push({ sweep, radius, action: 'continue', reason: '单块失败，本轮继续' });
            continue;
          }
        }

        const gained = inventoryCount(state.bot) - before;
        // ⚠️ 判据用"真正到手几件"，不是"挖了几格"。见 pathing.isProductiveSweep 的说明。
        //    `inventoryFull` 是 2026-09-25 补的：P1 那次 8 轮 reason 全是同一句话，
        //    而"背包满"和"没回头捡"的处理方式完全不同，不该共用一句文案。
        const prod = pathing.isProductiveSweep({
          gainedItems: gained,
          brokenBlocks: hit ? 1 : 0,
          inventoryFull: (() => {
            try { return state.bot.inventory.emptySlotCount() === 0; } catch (_) { return false; }
          })(),
        });
        const step = pathing.nextCollectStep({
          sweep, hit, productive: prod.productive,
          wanted: +count, got: mined.length, ladder,
          // ⚠️ 把 `prod.reason`（"背包满" / "没回头捡" / …）**透传**给下一步。
          //    不传的话，P2 在 isProductiveSweep 里分好的三类原因会被
          //    nextCollectStep 自己那句写死的文案盖掉 —— 这正是 P2b 的 bug：
          //    分层诊断做了，最后一跳丢了。见 field-log。
          why: prod.reason,
        });
        // `gained`/`prod.reason` 都要进留痕 —— 光看 action 分不出"背包满"和"没捡"
        sweeps.push({ sweep, radius, hit, gained, action: step.action, why: prod.reason, reason: step.reason });

        if (step.action === 'done' || step.action === 'give-up') break;
        if (step.action === 'widen') {
          if (maxR && step.radius > maxR) { sweeps.push({ sweep, radius, action: 'give-up', reason: `只在 ${maxR} 格内找，不往外扩` }); break; }
          sweep++; radius = step.radius; continue;
        }
        // 同一半径反复无收获的上限。**加 dig 空转的容忍度** ——
        // 一次 dig 空转后我们 `continue`（不让路重试），这会消耗这个计数；
        // 但如果她真的连试几次都挖不动，就该停，而不是刷满整个 count。
        const continues = sweeps.filter(s => s.action === 'continue' && s.radius === radius).length;
        // dig 空转单独一个更紧的上限：连试 2 次都没生效，说明不是"偶发被占用"
        const stallsHere = digStalls.length;
        if (stallsHere >= 2) {
          sweeps.push({
            sweep, radius, action: 'give-up',
            reason: `连续 ${stallsHere} 次 dig 都没有改变世界，停止（不是"挖不动"，是"动作没生效"）`,
          });
          break;
        }
        if (continues > +count) {
          sweeps.push({ sweep, radius, action: 'give-up', reason: '同一半径反复无收获，停止' });
          break;
        }
        if (!hit) { sweep++; radius = step.radius ?? ladder[Math.min(sweep - 1, ladder.length - 1)]; }
      }
    } finally {
      // 只清自己的标记：被打断时新命令可能已经写上了它的（见 instinct.yieldBody）
      if (state.currentAction === myTag) state.currentAction = null;
    }

    // ---- 批量清扫（P10 第二轮 + P13）--------------------------------------
    //
    // 挖够之后，对整片区域做统一清扫。为什么值得单独一步：
    //   · 掉落物会堆在同一片落点，逐块等待时"等到了谁的掉落物"是错位的；
    //   · 逐块各等一次的总耗时 = 块数 × 单块等待，而它们的掉落物其实同时出现；
    //   · 上面每块的探手只给 450ms（顺手捞），真正的兜底放在这里。
    // 判据仍然是**背包增量**，不是"走过去过"。
    //
    // ⚠️⚠️ P13（2026-09-25 第五次实战）：**锚点用"中间那块"是错的**。
    //
    //   实测（m9.json）：挖 4 块，`invDelta: 2`，但紧接着 `/nearby` 报
    //   `drops: 7` 散在 **8 格宽的一片区域**（最近的 6.6 格，最远的 14.1 格）。
    //   树被砍倒后，掉落物会**顺着树干散落到周围**，不是聚在一个点。
    //   拿"中间那块方块"当球心 + 半径 6，自然够不着外圈那几个。
    //
    //   修法是两层：
    //     ① 球心改成**所有落点的质心**，半径覆盖散落范围（而不是固定 6）；
    //     ② 清扫完**再看一眼世界**，对残余掉落物逐个再捡一轮（上限 2 轮，
    //        守住 P9 的"不引入无限循环"纪律）。
    //   这两层都不依赖"我猜掉落物在哪"，而是"去看世界现在有什么"。
    let bulkSweep = null;
    if (dropAnchors.length && mined.length && !aborted) {
      const centroidThat = dropAnchors.reduce(
        (a, p) => ({ x: a.x + p.x / dropAnchors.length, y: a.y + p.y / dropAnchors.length, z: a.z + p.z / dropAnchors.length }),
        { x: 0, y: 0, z: 0 },
      );
      // 半径 = 最远落点到质心的距离 + 余量，至少 6（原来写死的值），最多 12
      const spread = Math.max(
        ...dropAnchors.map(p => Math.hypot(p.x - centroidThat.x, p.y - centroidThat.y, p.z - centroidThat.z)),
      );
      const bulkRadius = Math.min(12, Math.max(6, Math.ceil(spread) + 4));
      try {
        const beforeBulk = inventoryCount(state.bot);
        bulkSweep = await sweepUpDrops(state.bot, centroidThat, {
          radius: bulkRadius, waitMs: 3000, budgetMs: 10000, settleMs: 1500,
        });
        bulkSweep.centroid = { x: +centroidThat.x.toFixed(1), y: +centroidThat.y.toFixed(1), z: +centroidThat.z.toFixed(1) };
        bulkSweep.spread = +spread.toFixed(1);
        // ⚠️ 把**实际用到的半径**也写回去 —— 上一轮漏了这一步，
        //    于是 `bulkSweep.radius` 是 undefined，我无法判断
        //    "清扫半径没生效"和"清扫半径生效了但没扫到"是两种完全不同的故障。
        bulkSweep.radius = bulkRadius;
        bulkSweep.anchors = dropAnchors.length;

        // ---- ② 残余清扫：再去看世界里还有没有掉落物 --------------------------
        // 不看"我猜该在哪"，而是**直接枚举剩余掉落物**逐个靠近。
        // 上限 2 轮，避免"掉落物被地形卡住 → 反复尝试"变成新一个 P9。
        const residueRounds = [];
        for (let round = 1; round <= 2; round++) {
          const left = Object.values(state.bot.entities)
            .filter(isDropEntity)
            .filter(d => d.position.distanceTo(centroidThat) <= bulkRadius + 6)
            .sort((a, b) => a.position.distanceTo(centroidThat) - b.position.distanceTo(centroidThat))
            .slice(0, 8);
          if (!left.length) break;
          const beforeRound = inventoryCount(state.bot);
          let got = 0;
          for (const d of left) {
            // ⚠️ 这里**不走 gotoWithBudget**：它的预算是给"正经寻路任务"用的
            //    （默认 30s 起，还有续期与硬上限那套）。残余清扫只需要
            //    "朝那个方向走一小段，能捡就捡，不行就算了"，
            //    用固定的短赛跑更直接，也不会因为一个够不到的掉落物
            //    把整轮清扫拖长。
            //
            // ⚠️⚠️⚠️ 2026-09-25 实战（P25）：清理**必须在 goto 之前**。
            //     我一开始写成 `finally { stop(); setGoal(null); }` —— 看起来对，
            //     实际是把下一个 goto 打死：`setGoal(null)` 会 emit
            //     `goal_updated(null)`，而下一个 goto 的 listener 已经注册好在等，
            //     收到 null 就报 `GoalChanged`（0ms 内失败）。
            //     实测：地上 6 个掉落物、距离 1.4 格，一个都捡不到。
            //     见 `withTimeout` 顶部的完整时序推导。
            //
            // ⚠️ 球心的 y 走 `reachableStandY`（P30 → P33）—— 理由与 sweepUpDrops
            //    / `/pickup` 完全相同，**三处必须用同一个函数**，
            //    否则就是"修一个反模式只修了一处"（P14）的第四次犯。
            //    简言之：用 `d.position.y` 会让她下不去（P30）；
            //    一律用 `selfY` 会让她永不落坑（P33）。夹到"够得着的那一层"才对。
            const mineSelfY = Math.floor(state.bot.entity?.position?.y ?? 0);
            const mineGoalY = reachableStandY(d.position.y, mineSelfY);
            // ⚠️ P38：半径随垂直落差自适应（同 sweepUpDrops / `/pickup`）。
            const mineRadius = Math.max(2, Math.abs(mineSelfY - mineGoalY) + 1);
            pathing.clearPathfinderGoal(state.bot.pathfinder);
            try {
              await Promise.race([
                state.bot.pathfinder.goto(
                  new goals.GoalNear(d.position.x, mineGoalY, d.position.z, mineRadius),
                ),
                sleep(6000),
              ]);
            } catch (_) { /* 捡不到就下一个，不阻断 */ }
            // 只 stop() 不清 goal（理由见上）。
            // ⚠️ stop() 之后让出一个 tick，给 `goto.js` 的 listener 清理机会
            //    （它是 `setTimeout(..., 0)`）—— 否则下一个 goto 撞残留 listener。
            try { state.bot.pathfinder.stop(); } catch (_) {}
            await sleep(0);
          }
          // 这一轮结束，此时无人等待 —— 安全清理点。
          pathing.clearPathfinderGoal(state.bot.pathfinder);
          // 等背包稳定（与 sweepUpDrops 同款判据）
          await sleep(600);
          got = inventoryCount(state.bot) - beforeRound;
          residueRounds.push({ round, targets: left.length, got });
          if (got > 0) dropsPicked += got;
          else break;   // 这轮一个都没拿到 → 再试也是白试
        }
        if (residueRounds.length) bulkSweep.residueRounds = residueRounds;

        bulkSweep.gainedAtBulk = inventoryCount(state.bot) - beforeBulk;
      } catch (e) {
        bulkSweep = { error: e.message };
      }
    }

    const last = sweeps[sweeps.length - 1];
    return {
      [byItem ? 'itemName' : 'blockName']: label,
      resolvedVia,
      // `resolveSource` 是给调用方的**可信度提示**：
      //   'drops'     —— 从原版 drops 表精确命中，可信
      //   'name'      —— 按命名规律推断，可能猜错
      //   'mixed'     —— 两者都有
      //   'blockName' —— 调用方直接给了方块名，不涉及推断
      resolveSource,
      resolveCandidates,
      requested: +count,
      // ⚠️ `mined` **现在只统计"世界真的发生了变化"的方块**。
      //    这是 P1c 的教训：以前 `dig()` 一返回就计数，于是它空转时
      //    `mined` 是个漂亮但假的数字，上层据此以为挖到了。
      //    宁可报 0，也不要一个骗人的成功。
      mined: mined.length,
      minedBlocks: mined.slice(0, 16),
      dropsPicked,
      // 每块之前挑了什么工具（kind: shovel/axe/pickaxe；source: carried/backpack/none/unknown）。
      // 空数组 = 一次都没挑到（可能身上没工具，也可能方块认不出该用什么）。
      toolsUsed: toolsUsed.slice(0, 16),
      // ★ 2026-09-25（P44 架构修复）：`ok` —— 让这个 handler 也能**否决**路由层的
      //   `success: true`。语义："这次挖掘在世界里有没有真的发生"。
      //   `mined` 已经在 P1c 修成"世界真的变了才算"，所以它 > 0 就是可信判据。
      //   ⚠️ 只在**真正一块都没挖动**时才 false —— 挖到了但没捡起来仍是 ok:true
      //      （"挖"这个动作生效了；"捡"是另一回事，由 `/pickup` 自己负责）。
      ok: mined.length > 0,
      // ★ 为什么提前收手（第 1/4 条）。**有值 = 这次 /mine 是"我自己停的"，不是失败。**
      //   `need_air`   —— 在水底、气不够了（挖水下的东西时的惜命线）
      //   `just_breathed` —— 刚上去换完气，别马上又潜回同一片水下
      // 与 `aborted` 分开：那个是**别人**叫停（新命令 / 战斗），这个是**她为了保命自己停**。
      stopped: needAir ? (needAir.justBreathed ? 'just_breathed' : 'need_air') : undefined,
      stoppedWhy: needAir ? needAir.why : undefined,
      // 水下方块的筛选结果（第 2 条）。`found` 有几块、`skipped` 按规则没挖几块，
      // 让 mind 知道"水下有东西、是规则拦住的"，不会以为附近没有。
      underwater: underwaterInfo || undefined,
      seen: mineSeen || undefined,
      // 一块都没挖到：把原因说成人话带回去（以前只有 ok:false，mind 那边只看到 "failed"）
      error: mined.length > 0 ? undefined : (needAir ? needAir.why : aborted ? '被新的命令打断了' : !mineSeen || !mineSeen.found
        ? `${mineSeen?.radius ?? radius} 格内没有 ${label}`
        : `${mineSeen.radius} 格内有 ${mineSeen.found} 块 ${label}，但挖不到：${[
          mineSeen.hidden ? `${mineSeen.hidden} 块埋在石头里（没有一面露出来，要挖进去，或者用 delve 往那边挖）` : '',
          mineSeen.tooHighLow ? `${mineSeen.tooHighLow} 块高低差超过 8 格` : '',
          mineSeen.nearHouse ? `${mineSeen.nearHouse} 块挨着人造方块（怕拆到房子）` : '',
          mineSeen.skippedBefore ? `${mineSeen.skippedBefore} 块刚才试过挖不动` : '',
          mineSeen.underwaterSkipped ? `${mineSeen.underwaterSkipped} 块在水下（默认不挖水里的，除非只有水下才有或值钱）` : '',
        ].filter(Boolean).join('；') || '都试过了，挖不动'}`),
      // 挖完之后对整片区域的**一次**统一清扫（P10 第二轮）。
      // 与每块的 `drops` 分开报：后者是"顺手捞到的"，这里才是"兜底捞到的"。
      bulkSweep: bulkSweep || undefined,
      // ⚠️ `mined` 与 `dropsPicked` 都**不等于**"进背包几件"。
      //    拾取是服务端判定的，客户端只能"走过去"。要确认真正到手，查 /inventory。
      inventoryDelta: inventoryCount(state.bot) - invBefore,
      // dig 空转了几次（动作声称成功、世界没变）。
      // 与"挖不动"是两回事：前者是**我们的动作没生效**，后者是工具/硬度不够。
      // 分开报，运维才不会去查错方向。
      digStalls: digStalls.length ? digStalls.slice(0, 8) : undefined,
      searchedUpTo: radius,
      // "搜了多大"必须如实报 —— 这是"附近没有"与"我找不到"的区别所在
      note: needAir ? needAir.why
        : (underwaterInfo && underwaterInfo.skipped && !mined.length)
          ? `水下有 ${underwaterInfo.found} 块 ${label}、按规则没挖（${underwaterInfo.why}）`
          : last?.action === 'give-up'
            ? `搜到 ${radius} 格仍未拿够：${last.reason}`
            : !mined.length ? `看得见的地方没有 ${label}（只挖视线里的，不透视）。矿石埋在地下：用 /delve 挖下去找、或进矿洞找` : undefined,
      sweeps,
    };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.gotoWithBudget !== undefined) gotoWithBudget = ns.gotoWithBudget;
  if (ns.inventoryCount !== undefined) inventoryCount = ns.inventoryCount;
  if (ns.isDropEntity !== undefined) isDropEntity = ns.isDropEntity;
  if (ns.isPlayerBuilt !== undefined) isPlayerBuilt = ns.isPlayerBuilt;
  if (ns.resolveBlocksForItem !== undefined) resolveBlocksForItem = ns.resolveBlocksForItem;
  // 第 4 步去重：sleep/sleepMs 已改为 require 的 const，这句 bind 重赋值会报常量赋值错误 —— 删掉。
  if (ns.state !== undefined) state = ns.state;
  if (ns.stripNamespace !== undefined) stripNamespace = ns.stripNamespace;
  if (ns.sweepUpDrops !== undefined) sweepUpDrops = ns.sweepUpDrops;
  if (ns.withTimeout !== undefined) withTimeout = ns.withTimeout;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  Vec3 = ns.Vec3;
  goals = ns.goals;
}

module.exports = {
  routes,
  keys: ["POST /mine"],
  bind,
  rebind,
 };
