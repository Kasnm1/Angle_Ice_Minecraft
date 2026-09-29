/**
 * routes/gather.js —— 从 server.js 的 handlers 表拆出的 6 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const hands = require('../../body/hands.js');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleepMs } = require('../../util/time');
const { countById } = require('../../util/inventory');   // 第 4 步去重：原为本文件里的 countOf 闭包
const __ns = {};

let CFG;
let state;
let Vec3;
let goals;

function botPosExact (...a) { return __ns.botPosExact.apply(null, a); }
function gotoWithBudget (...a) { return __ns.gotoWithBudget.apply(null, a); }
function isDropEntity (...a) { return __ns.isDropEntity.apply(null, a); }
function useBlockAt (...a) { return __ns.useBlockAt.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（6 条）：
 *   POST /collect                —— 去捡地上的某种掉落物
 *   POST /craft                  —— 原版配方合成
 *   POST /follow                 —— 跟着某个玩家走
 *   POST /control                —— 直接给移动马达（前后左右）
 *   POST /climb                  —— 攀爬（上 / 下）
 *   POST /activate               —— 右键一个方块（按钮 / 拉杆…）
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'POST /collect': async ({ itemName, count = 1 }) => {
    if (!itemName) throw new Error('itemName field required');
    count = Math.min(Math.max(1, +count), 64);
    const targets = Object.values(state.bot.entities)
      .filter(e => isDropEntity(e) && e.metadata?.[8]?.itemId)
      .filter(e => {
        const meta = e.metadata[8];
        const id = state.bot.registry.items[meta.itemId]?.name;
        return id === itemName;
      })
      .slice(0, +count);

    if (!targets.length) return { collected: 0, message: `No ${itemName} on the ground nearby` };

    state.currentAction = `collecting ${itemName}`;
    let collected = 0;
    const failures = [];
    for (const entity of targets) {
      try {
        // 掉落物会移动（被水冲、被别的玩家带走），按理该用短超时。但 `gotoWithBudget`
        // 的 ETA 是按**静态路径**算的，对会跑的目标偏保守 —— 于是这里只把标签传进去，
        // 让"卡住"时的报错能看出来是捡东西卡住，不额外压超时：
        // 压太紧会让"她还在追"被误判成"追不上"。
        await gotoWithBudget(state, new goals.GoalFollow(entity, 1), { label: `collect ${itemName}` });
        collected++;
      } catch (e) {
        failures.push(e.message);
      }
    }
    state.currentAction = null;
    // ⚠️ 掉落物拾取是**服务端判定**的：客户端走到附近，服务端把物品塞进背包。
    //    所以这里的 `collected` 是"走到了几件旁边"，不等于"真的进了背包"。
    //    要确认真进了，得看 /inventory。接口名保持 `collected` 是为了兼容，
    //    但 note 里把这件事说清楚，免得调用方把它当成"拾取了 N 件"。
    return {
      itemName, collected, attempted: targets.length, failures: failures.slice(0, 3),
      note: 'collected = 走到并停留的件数；是否真进背包由服务端判定，请查 /inventory',
    };
  },

  'POST /craft': async ({ itemName, count = 1 }) => {
    if (!itemName) throw new Error('itemName required');
    const item = state.bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item: ${itemName}`);

    const tableBlock = state.bot.findBlock({
      matching: state.bot.registry.blocksByName['crafting_table']?.id,
      maxDistance: 5,
    });

    const recipes = state.bot.recipesFor(item.id, null, 1, tableBlock);
    if (!recipes.length) {
      // ⚠️⚠️ 2026-09-25（P49）：这句报错以前是
      //   `No recipe for X (or missing crafting table)` —— 把三种情况混成一句，
      //   我**自己**就在排查时被它带着误判了三次（先怪配方表、再怪 minecraft-data）。
      //   现在用 `recipesAll`（**只查配方、不查背包**）把它切开：
      //     · 一条配方都没有         → 真没这个配方（或数据缺失）
      //     · 有配方但材料不够       → **缺材料**，并列出还差什么（可行动）
      const all = (() => { try { return state.bot.recipesAll(item.id, null, tableBlock) || []; } catch (_) { return []; } })();
      if (!all.length) {
        throw new Error(`No recipe for ${itemName}`
          + (tableBlock ? '' : '（附近 5 格内也没有工作台，3×3 配方需要它）'));
      }
      const inv = state.bot.inventory?.items?.() || [];
      // 第 4 步去重：原为本文件内的闭包，与 inspect.js:449 一字不差 —— 唯一一份在 src/util/inventory.js
      const countOf = (id) => countById(inv, id);
      const needLines = [];
      for (const r of all) {
        const gap = (r.delta || []).filter(d => d.count < 0)
          .map(d => ({ name: state.bot.registry.items?.[d.id]?.name || `id:${d.id}`, need: -d.count, have: countOf(d.id) }))
          .filter(g => g.have < g.need);
        if (gap.length) {
          needLines.push((r.requiresTable ? '[需工作台] ' : '')
            + gap.map(g => `${g.name} ${g.have}/${g.need}`).join(' + '));
        }
        if (needLines.length >= 3) break;
      }
      throw new Error(`材料不够（配方有 ${all.length} 条，但一条都做不了）：`
        + (needLines.join(' ｜ ') || '（算不出缺什么）')
        + '　—— 用 `GET /recipes?item=' + itemName + '` 看完整缺口');
    }

    state.currentAction = `crafting ${count}x ${itemName}`;
    await withTimeout(state.bot.craft(recipes[0], +count, tableBlock));
    state.currentAction = null;
    return { crafted: itemName, count: +count };
  },

  'POST /follow': async ({ playerName }) => {
    if (!playerName) throw new Error('playerName required');
    const target = state.bot.players[playerName]?.entity;
    if (!target) throw new Error(`Player ${playerName} not found or too far away`);
    // 先对齐楼层再贴着走（玩家上楼了她不能还在一楼转，见 hands.startFollow）
    return hands.startFollow(state.bot, state, playerName, 2);
  },

  // ================== 原始控制层：直接按键，不经过寻路器 ==================
  //
  // 为什么需要它：`POST /move` 走的是 mineflayer-pathfinder，那是个**高层 API**，
  // 自带一整套世界模型（哪里能走、哪块能拆、哪个能爬）。而它的世界模型在模组服上是
  // **错的** —— 方块名整体偏移、梯子认不出来（climbables 写死原版 ID）、
  // 未映射的模组方块被当成空气。我们前几轮一直在给这个错误的世界模型打补丁。
  //
  // 而"按键"这条路**绕开世界模型**：按 W 就是往前走，梯子、台阶、水、门
  // 全由游戏自己处理。真人爬梯子就是"看着梯子按住 W"，他不需要知道梯子的方块 ID。
  // mineflayer 暴露的这 7 个控制位正好是 WASD + 空格 + Shift：
  //   forward / back / left / right / jump / sprint / sneak
  // 配上 `POST /look` 就是完整的键鼠 —— 也就是说**输入模拟的一半我们早就有了**
  // （lookAt 用了 6 处），缺的只是键盘这一半。
  //
  // ⚠️ 但原始控制**没有闭环**：按住 W 之后，撞墙和前进在"按下去了"这个层面长得一样。
  //    所以这个端点一定返回位移 delta，让调用方（或上层原语）能判断"到底动没动"。
  //    这不是可选项 —— 没有反馈的按键等于把"卡住"变成静默失败。
  'POST /control': async ({ durationMs = 800, ...bits }) => {
    const ALLOWED = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    const wanted = {};
    for (const k of ALLOWED) if (bits[k] !== undefined) wanted[k] = !!bits[k];
    if (!Object.keys(wanted).length) {
      throw new Error(`no control bit given; allowed: ${ALLOWED.join(', ')}`);
    }
    const ms = Math.min(Math.max(+durationMs || 800, 50), CFG.bridge.controlMaxMs);
    const from = botPosExact();
    const held = Object.keys(wanted).filter(k => wanted[k]);

    // ⚠️ 身体只有一个。如果寻路器还有活着的目标，它会**每个 tick 覆盖**我们设的控制位 ——
    //    现象是"按了没反应"（位移≈0、连 jump 都不动），极易误诊成"物理层坏了/她卡住了"。
    //    所以这里显式接管，并如实上报，而不是默默打架。
    let clearedGoal = false;
    if (state.bot.pathfinder.goal) {
      try { state.bot.pathfinder.setGoal(null); clearedGoal = true; } catch (_) {}
      console.log('[control] 寻路器目标还活着，已清除 —— 原始控制接管身体');
    }

    // 先全清：上一次的残留如果叠加进来，"按住 forward"会变成"forward+sprint+..."
    state.bot.clearControlStates();
    for (const k of held) state.bot.setControlState(k, true);
    state.currentAction = `control ${held.join('+')} ${ms}ms`;
    try {
      await sleepMs(ms);
    } finally {
      // ⚠️ 无论正常还是异常都必须松手。异常路径下按键卡住 = 她会一直往前走，
      //    这比"这一步没走成"严重得多。用 finally 而不是顺序执行，就是为了这个。
      state.bot.clearControlStates();
      state.currentAction = null;
    }

    const to = botPosExact();
    return {
      held,
      durationMs: ms,
      clearedGoal,
      from,
      to,
      moved: {
        x: +(to.x - from.x).toFixed(2),
        y: +(to.y - from.y).toFixed(2),
        z: +(to.z - from.z).toFixed(2),
      },
    };
  },

  // 爬梯子：**闭环原语**，不是一次按键。
  //
  // 背景（2026-09-23）：这个端点一开始在模组服上爬不上去，当时的诊断是"物理层写死的
  //    ladder.id 与服务器不符" ——
  //        const ladderId = blocksByName.ladder.id        // 原版 196
  //        function isOnLadder (world, pos) { if (block.type === ladderId) return true }
  //    ⚠️ **那个诊断已被推翻**：服务端 1003 个原版方块 id 与原版**零差异**，
  //       原版梯子就是 196 —— 物理层那套**本来就是对的**。当时看到的"改成 215 就会爬了"
  //       是自我实现：我们把 215 号方块**告诉**物理层是梯子，它当然照做。
  //       真正的失败原因**尚未定论**，下一步是拿服务端实读的 `block.type` 来判
  //       （`GET /block` 的 `stateId` + 调色板/快照）。
  //
  //    仍然成立的那半句：**`setControlState` 并不把按键发给真客户端** —— 它交给
  //    `prismarine-physics` 自己算。所以"模拟输入"和"高层寻路"共用同一个物理模拟。
  //    实测：横向对准成功、走进梯子格、按住 W 多个 700ms，Δy 始终为 0。
  //
  //    所以本端点现在的立场是：**先如实测量，再谈结论**。
  //    修没修上、认不认得出，看 `GET /config` 的 `pathfinder.ladderFix` 与
  //    `pathfinder.climbables.libraryPathWouldWork` —— 不要靠猜。
  //
  // 这个端点把"闭环"做对了：它的 `stalledAtY` 是**如实承认做不到**的出口，
  // 不会无限空转。
  //   看向梯子 → 按住 jump 一小段 → 松开 → 看 y 涨没涨
  //   涨了继续，连着几次不涨就报 stalledAtY，而不是无限按下去。
  //
  // `autoOpen`（默认开）：爬不动时**抬头看头顶那格**。如果是个方块，就右键它一次
  //    （真人这时就是这么做的 —— 玩家原话：「他应该会自己开这种类型的」）。
  //    ⚠️ 关键在**只把实测穿得过去的那个 state 记为可通行**：
  //      右键既能开也能关，猜错方向就会让她穿模（服务端会把她推回来）。
  //      所以流程是"乐观放行 → 实测 → 爬不上去就撤回"，撤回后等于什么都没做。
  'POST /climb': async ({ x, y, z, maxMs = 8000, stepMs = 500, autoOpen = true }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x/y/z required (the ladder block to climb)');
    }
    const targetY = +y;
    const startY = state.bot.entity.position.y;
    const step = Math.min(Math.max(+stepMs, 100), 1500);
    const budget = Math.min(Math.max(+maxMs, 500), CFG.bridge.controlMaxMs * 4);
    const deadline = Date.now() + budget;

    // 视角必须对准梯子 —— 没看着它，按 W 只会往前走
    await state.bot.lookAt(new Vec3(+x, +y, +z), true);

    let attempts = 0;
    let stalled = 0;
    let lastY = startY;
    let opened = null;    // 记录"她抬头处理头顶那格"的经过与验证结果
    let openPhase = 0;    // 0 未试 / 1 已假设"本来就是开的" / 2 已切换过一次 / 3 放弃
    state.currentAction = `climbing to y=${targetY}`;
    try {
      while (Date.now() < deadline && state.bot.entity.position.y < targetY - 0.2) {
        attempts++;
        // ⚠️ **只按 jump，不要同时按 forward。**（2026-09-23 实测，本包）
        //      jump 单独按      → Δy = +2.2 格（有效）
        //      forward + jump   → Δy = 0     （无效）
        //    物理层的攀爬条件（prismarine-physics/index.js:592）是
        //        isOnLadder && (isCollidedHorizontally || (climbUsingJump && control.jump))
        //    —— 两条路都以 `isOnLadder` 为前提。既然 jump 这条实测能走通，
        //    就不该再按 forward：这包里的梯子嵌在**一格宽**的门缝里（33/35 都是门），
        //    按 forward 只会让她顶住墙，白耗掉这次按压。
        state.bot.setControlState('jump', true);
        await sleepMs(step);
        state.bot.clearControlStates();
        await sleepMs(80); // 留一帧让物理结算，否则读到的还是旧 y
        const nowY = state.bot.entity.position.y;
        if (nowY - lastY < 0.05) stalled++; else stalled = 0;
        lastY = nowY;

        if (stalled < 4) continue;

        // 连着四次不动 —— 头顶大概率撞着一扇闭着的门/活板门。真人这时会抬头把它打开。
        // 只试一次：原状态已被实测证明挡人，切换一次若还挡，切回去只会回到已知的挡。
        const headPos = state.bot.entity.position.offset(0, 2, 0).floored();
        const above = state.bot.blockAt(headPos);
        if (!opened && autoOpen && above && above.name !== 'air') {
          let r = null;
          try {
            r = await useBlockAt(headPos);
          } catch (e) {
            console.log(`[climb] 头顶 ${headPos.x},${headPos.y},${headPos.z} 用不了：${e.message}`);
          }
          if (r && r.stateChanged) {
            // 乐观放行 + 立刻实测验证。验证失败会在循环外撤回 ——
            // **绝不能留着猜错的白名单**，留着就是穿模，服务端会把她推回来。
            state.passableStateIdsRuntime.add(r.after.stateId);
            opened = {
              pos: { x: headPos.x, y: headPos.y, z: headPos.z },
              face: r.face,
              fromStateId: r.before.stateId,
              toStateId: r.after.stateId,
              atY: +state.bot.entity.position.y.toFixed(2),
              verified: false,
              rolledBack: false,
            };
            console.log(`[climb] 头顶撞到方块，已右键打开：stateId ${r.before.stateId} → ${r.after.stateId}`
              + `（face=${r.face}，先放行，爬上去才算数）`);
            stalled = 0;
            lastY = state.bot.entity.position.y;
            continue;
          }
          // 点了但 state 没变 → 那不是门，别在这儿耗
          if (r) console.log(`[climb] 头顶方块右键后 state 没变（stateId ${r.before.stateId}），不是门`);
        }
        break; // 承认做不到，别空转
      }
    } finally {
      state.bot.clearControlStates();
      state.currentAction = null;
    }

    const endY = state.bot.entity.position.y;

    // 验证：开了门之后真的爬上去了吗？没上去就把白名单撤回，等于什么都没做。
    if (opened) {
      opened.verified = endY > opened.atY + 0.5;
      if (!opened.verified) {
        state.passableStateIdsRuntime.delete(opened.toStateId);
        opened.rolledBack = true;
        console.log(`[climb] 开了门仍然上不去，已撤回 stateId ${opened.toStateId} 的放行（不猜）`);
      }
    }

    return {
      targetY,
      fromY: +startY.toFixed(2),
      toY: +endY.toFixed(2),
      climbed: +(endY - startY).toFixed(2),
      reached: endY >= targetY - 0.2,
      attempts,
      autoOpen: opened,
      // 非 null 表示"她卡在这个高度上不去了" —— 这是要报给玩家的，不是静默失败
      stalledAtY: endY < targetY - 0.2 ? +endY.toFixed(2) : null,
    };
  },

  // 右键"用"一个方块：开活板门 / 门 / 拉杆 / 按钮 / 栅栏门。
  //
  // 为什么必须有这个端点：**寻路器不会开活板门**。
  //   `mineflayer-pathfinder/lib/movements.js:97` 的 `openable` 只收名字里带 "gate"
  //   的方块，而且 `canOpenDoors` 默认是 `false`（作者注释：Causes issues）。
  //   所以在寻路器眼里，一扇闭着的活板门就是一堵墙。
  //
  //   真人遇到闭着的活板门会怎么做？**右键打开**。这个端点就是那只手。
  //   （别用 MC_PASSABLE_STATE_IDS 把它放行 —— 那是穿模，服务端会拒。）
  //
  // `face` 可以显式给（top/bottom/north/south/east/west），不给就自动选
  // **朝向她的那一面**。自动选很重要：玩家指出的那个活板门在她头顶上方，
  // 顶面朝屋顶里面够不着，必须点底面 —— 而 `activateBlock` 的默认值是顶面。
  'POST /activate': async ({ x, y, z, face, passableAfter = false }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x/y/z required (the block to activate)');
    }
    const r = await useBlockAt(new Vec3(+x, +y, +z), { face });
    // `passableAfter` 要显式打开才记白名单 —— 默认不猜。
    // 因为"右键"既能开也能关：默认放行的话，一次误关就会让她穿模（服务端会把她推回来，
    // 那正是我们刚修掉的那个 bug）。由调用方声明意图，比我们替它猜要诚实。
    if (passableAfter && r.stateChanged) {
      state.passableStateIdsRuntime.add(r.after.stateId);
      r.markedPassable = r.after.stateId;
    }
    return r;
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.botPosExact !== undefined) botPosExact = ns.botPosExact;
  if (ns.gotoWithBudget !== undefined) gotoWithBudget = ns.gotoWithBudget;
  if (ns.isDropEntity !== undefined) isDropEntity = ns.isDropEntity;
  // 第 4 步去重：sleep/sleepMs 已改为 require 的 const，这句 bind 重赋值会报常量赋值错误 —— 删掉。
  if (ns.state !== undefined) state = ns.state;
  if (ns.useBlockAt !== undefined) useBlockAt = ns.useBlockAt;
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
  keys: ["POST /collect","POST /craft","POST /follow","POST /control","POST /climb","POST /activate"],
  bind,
  rebind,
 };
