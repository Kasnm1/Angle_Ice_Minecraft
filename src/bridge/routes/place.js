/**
 * routes/place.js —— 从 server.js 的 handlers 表拆出的 2 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const hands = require('../../body/hands.js');
const placeLogic = require('../../world/place');
const { isStandable } = require('../../world/place');   // 拆分时漏搬（原 server.js:31 的解构），2026-09-29 补

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const { DEADLY, findStandY } = require('../../world/place');   // 原 server.js:31 从 place.js 解构；拆分时被错做成 __ns 转发壳（没人导出，DEADLY 还是正则），2026-09-29 改回
const __ns = {};

let handlers;
let state;
let Vec3;
let goals;

function isAiryForPlace (...a) { return __ns.isAiryForPlace.apply(null, a); }
function sameItem (...a) { return __ns.sameItem.apply(null, a); }
function sleepMs (...a) { return __ns.sleepMs.apply(null, a); }
function waitForBlock (...a) { return __ns.waitForBlock.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（2 条）：
 *   POST /place
 *   POST /shelter
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'POST /place': async ({ itemName, x, y, z, confirmMs, mount, chest = 'merge' }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x, y and z required');
    }
    const bot = state.bot;
    const target = new Vec3(Math.round(+x), Math.round(+y), Math.round(+z));

    const at = bot.blockAt(target);
    if (!at) throw new Error(`Position out of range: ${target.x},${target.y},${target.z}`);

    // 目标位置必须是可替换的（空气/水/草之类），否则会覆盖掉玩家的东西
    const REPLACEABLE = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava|grass|tall_grass|short_grass|fern|large_fern|snow|vine|dead_bush|seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/;
    if (!REPLACEABLE.test(at.name)) {
      throw new Error(`Refusing to overwrite ${at.name} at ${target.x},${target.y},${target.z}`);
    }

    // ---- 先站定。身体还在漂的时候放置会打偏到隔壁格去。
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    await sleepMs(150);   // 给服务端一两个 tick 收下"我停下来了"

    // 手里要放的方块：指定 itemName，或默认用当前手持
    // 精妙背包里的也算"随身"（N-9 的 `Not carrying minecraft:crafting_table` ×4）—— 先拿上来再判没有
    if (itemName && !bot.inventory.items().some(i => sameItem(i.name, itemName))) {
      const got = await hands.ensureCarried(bot, state, itemName, 1);
      if (got.source === 'unknown') throw new Error(`拿不到 ${itemName}：${got.why}`);
    }
    const item = itemName
      ? bot.inventory.items().find(i => sameItem(i.name, itemName))
      : bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');

    // ---- 条件 ①③④：交给 place.js 的纯几何判定
    const ep = bot.entity?.position;
    const feet = ep ? { x: ep.x, y: ep.y, z: ep.z } : null;
    const verdict = placeLogic.planPlacement({
      target: { x: target.x, y: target.y, z: target.z },
      getBlock: pos => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)),
      feet,
      height: bot.entity?.height,
    });

    if (!verdict.ok) {
      const faces = verdict.tried.join(', ');
      if (verdict.kind === 'self-occupied') {
        throw new Error(
          `Target cell is occupied by my own body (${target.x},${target.y},${target.z}) — step aside first`);
      }
      if (verdict.kind === 'too-far') {
        throw new Error(
          `Target out of reach (need < ${placeLogic.REACH} blocks from eyes) — walk closer first. Faces: ${faces}`);
      }
      if (verdict.kind === 'no-solid-neighbour') {
        throw new Error(
          `No solid neighbour to place against at ${target.x},${target.y},${target.z}. Faces: ${faces}`);
      }
      throw new Error(
        `Could not place ${item.name} at ${target.x},${target.y},${target.z}. Faces: ${faces}`);
    }

    // ---- 逐个试候选面。几何可行 ≠ 实际放得下：面可能被挡（②），
    //      也可能服务端在这一瞬间拒绝。第一个失败不该整体失败。
    let lastErr = null;
    let attempted = 0;
    // mount：挂墙 / 放地 / 吊顶。火把、灯贴哪一面决定它是壁挂还是插地上（她想挂墙，结果插在了地上）
    const plans = [...verdict.plans];
    if (mount === 'wall' || mount === 'floor' || mount === 'ceiling') {
      const want = (pl) => (mount === 'floor' ? pl.label === 'below' : mount === 'ceiling' ? pl.label === 'above' : pl.label !== 'below' && pl.label !== 'above');
      plans.sort((a, b) => want(b) - want(a));
    }
    // ---- 箱子合并（常识 cs-02，原版 ChestBlock#getStateForPlacement）：
    //   玩家的做法（主人 2026-09-27）：站在旧箱子正面那一侧、面向旁边的空地放下去 → 新箱子朝向和旧的一样，自动合成大箱子（不潜行）
    //   站不到那一侧 / 空地下面不实心：退回"潜行 + 点旧箱子的侧面"（一定合，朝向跟它走）
    //   不想合（chest:'single'）：潜行 + 点地面 → 一定不合
    //   合并条件：同一种箱子、它是单箱子、新箱子在它的左右（不是前后）
    const isChest = /(^|:)(trapped_)?chest$/.test(item.name) && !/ender_chest/.test(item.name);
    let mergeWith = null; let chestSneak = isChest && chest === 'single';
    if (isChest) {
      if (chest !== 'single') {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nPos = target.offset(dx, 0, dz);
          const nb = bot.blockAt(nPos);
          if (!nb || nb.name !== item.name) continue;
          const pr = nb.getProperties?.() || {};
          if (String(pr.type || 'single').toLowerCase() !== 'single') continue;
          const f = String(pr.facing || '').toLowerCase();
          const axisOfDir = dx !== 0 ? 'x' : 'z';
          const axisOfFacing = /east|west/.test(f) ? 'x' : /north|south/.test(f) ? 'z' : null;
          if (!axisOfFacing || axisOfFacing === axisOfDir) continue;   // 在它前后，不在左右 → 合不了
          mergeWith = nPos;
          // ① 玩家的做法：走到新格子正前方（旧箱子朝向那一侧）两格，面向空地点地面放
          const fv = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[f];
          const stand = target.offset(fv[0] * 2, 0, fv[1] * 2);
          try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)), 8000); } catch (_) {}
          try { bot.pathfinder.setGoal(null); } catch (_) {}
          const me = bot.entity.position;
          const inFront = Math.abs(me.x - (stand.x + 0.5)) < 0.8 && Math.abs(me.z - (stand.z + 0.5)) < 0.8;
          const floorPlan = plans.find(pl => pl.label === 'below');
          if (inFront && floorPlan) {
            plans.splice(plans.indexOf(floorPlan), 1); plans.unshift(floorPlan);   // 面向空地、点地面，不潜行
          } else {
            // ② 站不到正面 / 空地下面不实心：潜行 + 点旧箱子朝向新格子的那个侧面
            chestSneak = true;
            plans.unshift({ label: 'merge', refPos: { x: nPos.x, y: nPos.y, z: nPos.z }, face: { x: -dx, y: 0, z: -dz }, contact: { x: nPos.x + 0.5 - dx * 0.5, y: nPos.y + 0.5, z: nPos.z + 0.5 - dz * 0.5 }, distance: null });
          }
          break;
        }
      } else {
        plans.sort((a, b) => (b.label === 'below') - (a.label === 'below'));   // 不合：点地面
      }
    }
    // 依附的方块能右键打开（箱子、木桶、熔炉、工作台…）→ 不潜行的话右键是"打开它"，不是放方块
    const INTERACTIVE = /chest|barrel|furnace|smoker|crafting_table|table|anvil|door|gate|trapdoor|lever|button|bed|shulker|hopper|dispenser|dropper|cabinet|stove|pot|fridge|counter/;
    for (const p of plans) {
      const ref = bot.blockAt(new Vec3(p.refPos.x, p.refPos.y, p.refPos.z));
      if (!ref) { lastErr = new Error(`reference block vanished at ${p.refPos.x},${p.refPos.y},${p.refPos.z}`); continue; }

      const contact = new Vec3(p.contact.x, p.contact.y, p.contact.z);
      const faceVec = new Vec3(p.face.x, p.face.y, p.face.z);

      // 条件②：先看过去。看得见才放得下（也顺手把视角摆正，避免打偏）
      try {
        await withTimeout(bot.lookAt(contact, true), 3000);
      } catch (e) {
        lastErr = new Error(`${p.label} face not lookable (${e.message})`);
        continue;
      }

      state.currentAction = `placing ${item.name} @ ${target.x},${target.y},${target.z}`;
      // 只在放这一下潜行（约 0.1 秒），放完就松开：箱子退回侧面点法 / 不想合，或者依附的方块一右键就会被打开
      const sneak = chestSneak || INTERACTIVE.test(ref.name);
      try {
        attempted++;
        if (sneak) { bot.setControlState('sneak', true); await sleepMs(120); }
        await withTimeout(bot.placeBlock(ref, faceVec));
        // 等世界真的更新 —— placeBlock 返回 ≠ 服务端接受了
        const confirmed = await waitForBlock(bot, target, Math.min(Math.max(+confirmMs || 1500, 200), 5000));
        return {
          placed: item.name,
          at: { x: target.x, y: target.y, z: target.z },
          via: p.label,
          distance: p.distance,
          // confirmed=false 不代表失败，只代表"没在超时内看到更新"。
          // 可能是服务端延迟，也可能是幽灵方块 —— 调用方可用 GET /inventory 复核。
          confirmed,
          facesTried: attempted,
          // 箱子：核对到底合没合（type 不是 single = 成了大箱子的一半）
          ...(isChest ? (() => {
            const t = String(bot.blockAt(target)?.getProperties?.().type || 'single').toLowerCase();
            return { chest: t === 'single' ? 'single' : 'double', ...(mergeWith && t === 'single' ? { mergeNote: '想和旁边的箱子合，但没合上' } : {}) };
          })() : {}),
        };
      } catch (e) {
        lastErr = e;
      } finally {
        if (sneak) bot.setControlState('sneak', false);
        state.currentAction = null;
      }
    }

    throw new Error(
      `All ${verdict.plans.length} geometrically valid faces failed at ` +
      `${target.x},${target.y},${target.z}${lastErr ? ` (last: ${lastErr.message})` : ''}`);
  },

  // 给自己围一个紧急遮蔽（field-log P24 的 `shelter` 动作）。
  //
  // ⚠️⚠️ **为什么这个端点必须在网桥而不是 autopilot：**
  //    `/place` 要求调用方给出精确的 `x,y,z`，而"该把方块放在哪一格"这个问题
  //    只有网桥答得了 —— 它看得到真实地形、朝向、脚下是否悬空、哪一面能靠着放。
  //    autopilot 那边只有 `/scan` 的方块列表，**猜坐标必然打偏**。
  //    这和 P20/P21 是同一条原则：**判据住在看得见真相的那一侧。**
  //
  // ⚠️ **刻意不做的事（很重要）：**
  //    ① 不盖"3×3 土屋"。空间规划需要判断头顶有没有洞、门开在哪、
  //       而她站的位置可能本来就是玩家建筑的一部分 —— 盖错了会破坏玩家的东西。
  //    ② **不封死所有方向。** 最少留一面不封 —— 这是原版的"留门"。
  //       封死会让她卡在里面出不来，**后续所有动作全部失效**（比不搭还糟）。
  //    ③ 不动 `isPlayerBuilt` 的方块（见 P21）—— 只往**空气格**里放。
  //
  // 做法：以她脚下为中心，取水平 4 个相邻格里"最该封"的几格（排除她自己要走的出路），
  //    逐格套用 `/place` 已有的几何判定去放。
  'POST /shelter': async ({ itemName, blocks = 3, keepOpen } = {}) => {
    const bot = state.bot;
    const ep = bot.entity?.position;
    if (!ep) throw new Error('bot 没有位置（未连接？）');

    // 要放的方块
    // 精妙背包里的也算"随身"（N-9）—— 先拿上来再判"没有"
    if (itemName && !bot.inventory.items().some(i => sameItem(i.name, itemName))) {
      const got = await hands.ensureCarried(bot, state, itemName, 1);
      if (got.source === 'unknown') throw new Error(`拿不到 ${itemName}：${got.why}`);
    }
    const item = itemName
      ? bot.inventory.items().find(i => sameItem(i.name, itemName))
      : bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');

    // ⚠️⚠️⚠️ P40（2026-09-25 实机抓出）：**"她站在哪一格"不能用 `Math.floor` 算。**
    //
    //    她的真实坐标是 `x=-9.5006, z=-6.5` —— **半格偏移**，她跨在格子边界上。
    //      · `Math.floor(-9.5006)` = **-10**，`Math.floor(-6.5)` = **-7**
    //      · 于是桥去探测 `(cx=-10, cz=-7)` 的四个方向
    //      · 逐格实测那四个方向：`dirt / andesite / dirt / dirt` —— **全是实心**
    //      · 而她真正占据的格子 `(-9, 87, -6)` 和 `(-10, 87, -7)` 都是 **air**
    //    结果：8 个候选格全被"只往空气格放"的过滤器滤掉 → 集合清空 →
    //    抛"脚边没有可放置的空位（四周全是实心）" —— **而她在开阔地里**。
    //
    //    实机证据：12 次调用**全部**失败，同一句错误，`placed` 永远是 0。
    //
    //    为什么 `floor` 在这里是错的：Minecraft 的格子归属是 `floor`，
    //    但**玩家碰撞箱宽 0.6 格**，站在 `x=-9.5006` 时她的身体横跨
    //    `x∈[-9.801, -9.201]`，**完全落在 -10 那一格之外**；
    //    她的**脚底方块**其实在 `-10` 格（因为 `floor(-9.5006) = -10` 是脚下方块），
    //    但"她人所在的位置"（该往哪几个方向堵）取决于**哪一格是空气、她站得进去**。
    //
    //    正确做法（与 `reachableStandY` 同一思路：**先看她实际能站的地方**）：
    //    ① 先试"她认为自己在的格"（`floor`，Minecraft 的官方语义）；
    //    ② 再试"四舍五入到最近的格"（`Math.round`）—— 半格偏移时它给出另半个格；
    // ⚠️⚠️⚠️ P40（2026-09-25 实机抓出，**两轮才定位对**）：
    //
    // 【第一轮我诊断错了 —— 记在这里当反面教材】
    //   我看到 `exact = {x:-9.5006, z:-6.5}`（半格），就先入为主地判定
    //   "`Math.floor` 在负坐标 + 半格偏移时算错格子归属"，并据此写了
    //   "floor/round 双候选"的代码。**这个结论是错的，而且我没跑逐格探测就下了定论。**
    //   我用 `Math.round(-6.5) = -7` 心算推出"floor 和 round 一样"，然后拿这个
    //   自相矛盾的现象当证据 —— 实际 `Math.round(-6.5) = -6`（向 +∞ 取整）。
    //   **错误的心算被当成了实测数据。**
    //
    // 【第二轮：逐格探测，真相】
    //   用 `/block` 把周围全部探一遍，`exact = (-9.5006, 87.0, -6.5)`：
    //     · 她这格     `(-10,87,-7)` = **air**  ← `Math.floor` 归属**是对的**
    //     · 她脚下     `(-10,86,-7)` = andesite（有地面，不是悬空）
    //     · 4 方向 × 2 层（feetY 与 feetY+1）：
    //         x+ (-9, 87,-7)=dirt        x+ (-9, 88,-7)=grass_block
    //         x- (-11,87,-7)=andesite    x- (-11,88,-7)=grass_block
    //         z+ (-10,87,-6)=dirt        z+ (-10,88,-6)=dirt
    //         z- (-10,87,-8)=dirt        z- (-10,88,-8)=grass_block
    //       → **8 个候选格全是实心，一个 air 都没有**
    //
    //   **所以 `/shelter` 抛"四周全是实心"说的是实话** —— 她正站在一条
    //   **天然形成的一格宽缝隙**里（头顶 `(-10,88,-7)=air`，说明缝只有一格高、
    //   四面被 dirt/andesite/grass_block 封死）。这地方**本来就有遮蔽**，
    //   既不需要、也不允许再封。
    //
    // 【真正的错在哪】不是取整，也不是白名单，而是**选址假设**：
    //   `shelter` 只会"原地封四周"，而她随机游走后经常正好站在这种
    //   天然闭合的缝里 → 必然失败。12 次调用全零，`placed` 永远是 0。
    //
    // 【修法（两件都做）】
    //   ① **先尝试挪一格**：如果四周全实心，就找附近一个"至少有 2 个空邻居"
    //      的位置走过去再封（`tryRelocate`）—— 这才是"建立庇护所"该有的行为。
    //   ② **挪不成，就如实判定"已有天然遮蔽"并返回成功**：因为遮蔽**确实存在**，
    //      报失败会让她陷入"needShelter 永远 true → 每 tick 都来试 → 永远失败"
    //      的死循环（P31 的形态）。**"这里不需要搭"不是错误。**
    //
    // 【保留的设计（第一轮写对的部分）】
    //   · 多格参与探测 + 去重（比"只挑一个 cx/cz"更稳，居中/跨格都对）
    //   · 自己身体占的格由 `place.js` 的 `bodyOccupies` 排除（不另写判定）
    //   · 白名单复用 `place.js` 的 `AIRY`（**不新建副本** —— 我第一轮新建了一个
    //     `AIRY_NAMES`，那正是 P39 说的"同一判据写两处"，已删除）
    const feetY = Math.floor(ep.y);

    // 身体（宽 0.6，半宽 0.3）覆盖到哪些**整格**。
    // 格 n 覆盖区间 [n, n+1)；身体覆盖 [c-hw, c+hw]；两者有**正长度**交集即算覆盖。
    // ⚠️ 必须用严格重叠判定，不能写成 `floor(c-hw)`/`floor(c+hw)` ——
    //    实测 `c=3` 时身体盒是 `[2.7, 3.3]`，**确实横跨格 2 和格 3**；
    //    而 `c=-9.5006` 时盒是 `[-9.8006, -9.2006]`，**完整落在格 -10 内**（不跨格）。
    //    这两种情形的区别就是"要不要多探一格"，得让几何自己说话。
    const spanOf = (c, halfWidth) => {
      const out = [];
      const lo = Math.floor(c - halfWidth) - 1;
      const hi = Math.ceil(c + halfWidth) + 1;
      for (let n = lo; n <= hi; n++) {
        if (n < c + halfWidth - 1e-9 && n + 1 > c - halfWidth + 1e-9) out.push(n);
      }
      return out.length ? out : [Math.floor(c)];
    };
    const selfCells = [];
    for (const x of spanOf(ep.x, placeLogic.HALF_WIDTH)) {
      for (const z of spanOf(ep.z, placeLogic.HALF_WIDTH)) selfCells.push({ x, z });
    }
    // 兜底：`floor` 是她**脚下地面**的归属格（Minecraft 官方语义），永远不该漏
    if (!selfCells.some(s => s.x === Math.floor(ep.x) && s.z === Math.floor(ep.z))) {
      selfCells.push({ x: Math.floor(ep.x), z: Math.floor(ep.z) });
    }
    // "她自己站得进去" —— 脚与头两层都可站立（含岩浆/仙人掌则不算）
    const selfIsAiry = (x, z) => {
      const feet = bot.blockAt(new Vec3(x, feetY, z));
      const head = bot.blockAt(new Vec3(x, feetY + 1, z));
      return isStandable(feet) && isStandable(head);
    };
    const pick = selfCells.find(c => selfIsAiry(c.x, c.z)) || selfCells[0];
    const cx = pick.x;
    const cz = pick.z;

    // 4 个水平方向 × 她覆盖的每一格（去重）
    //
    // ⚠️ `y` 取 feet 与 feet+1 **两层**：单层封不住 —— 僵尸高 1.95 格，
    //    只堵脚那层它能从上面越过来（还能从缝里看到/攻击她）。
    // ⚠️ 但**不封她自己站的那一格**，也不封头顶（否则窒息）—— 由下面的
    //    `bodyOccupies` 负责排除（它用的就是身体跨格的真判定）。
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const wantSeen = new Set();
    let want = [];
    for (const cell of selfCells) {
      for (const [dx, dz] of dirs) {
        for (const dy of [0, 1]) {
          const x = cell.x + dx, y = feetY + dy, z = cell.z + dz;
          // 不能是她自己身体占着的格（`place.js` 的判定，不在客户端也不在服务端"猜"）
          if (placeLogic.bodyOccupies({ x, y, z }, { x: ep.x, y: ep.y, z: ep.z }, bot.entity?.height)) continue;
          const k = `${x},${y},${z}`;
          if (wantSeen.has(k)) continue;
          wantSeen.add(k);
          want.push({ x, y, z });
        }
      }
    }

    // 只往**空气**格放。已经实心的（墙、地形）不用管，也别去覆盖。
    //
    // ⚠️ P40：这里曾经**悄悄把所有格子都滤掉**，然后抛"没有可放置的空位"。
    //    这类"过滤器把集合清空"的 bug 极难从错误信息反推 —— 错误文案说的是
    //    "四周全是实心"，而真相可能是"白名单没匹配上"**或"格子算错了"**。
    //    所以现在**留痕**：把探测到的原始结果记进 `state.__lastShelterProbe`。
    //    实机证据：正是靠这个留痕才看出 `cx/cz` 是错的（见上方 P40 长注释）。
    const probe = want.map(p => {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
      return { ...p, block: b ? b.name : null, ok: isAiryForPlace(b) };
    });
    state.__lastShelterProbe = {
      at: Date.now(), feetY, cx, cz, probe,
      feetRaw: { x: ep.x, y: ep.y, z: ep.z },
      // ⚠️ P40：把"归属是怎么选出来的"也记下来 —— 否则下次还是只能看到结果、看不到理由。
      attribution: {
        selfCells,
        selfAir: selfCells.map(c => ({ ...c, ok: selfIsAiry(c.x, c.z) })),
        chosen: { cx, cz },
        halfWidth: placeLogic.HALF_WIDTH,
      },
    };
    want = probe.filter(p => p.ok).map(({ x, y, z }) => ({ x, y, z }));

    // ---- 留门：最少保留一面完全空的 -------------------------------------------
    //
    // 如果按四面全封，她会出不来。做法是**按方向分组**，最少放过一个方向。
    // 优先放过哪一个：**朝向开阔地的那个**（而不是她自己当前 facing）——
    // 因为"敌人从哪来"和"她朝哪看"没关系，但"外面是不是开阔地"决定了
    // 堵住这一面是不是真的有用。判定方式：该方向 4 格内有没有实心方块可依靠
    // （没有依靠就放不成，等于天然留门）。
    // `keepOpen` 可以让调用方显式指定放过哪个方向（'x+' | 'x-' | 'z+' | 'z-'）。
    //
    // ⚠️ P40：**方向只能相对于"她身体真正占的格"来算。** 半格偏移时她占 4 格，
    //    同一个世界方向（比如 `x+`）对其中某些格来说是"往外堵"，对另一些格
    //    则根本不是邻居。原来的写法只对一个 `cx/cz` 取邻居，于是
    //    "留门方向"可能落在她身体内部 —— 那等于**没留门**，她会把自己砌在里面。
    //    现在改成：**按世界方向给 `want` 分组**（一格相对于最近的 selfCell 往哪边），
    //    并且明确排除掉"她身体会占到的那些格"。
    const dirKey = (dx, dz) => (dx === 1 ? 'x+' : dx === -1 ? 'x-' : dz === 1 ? 'z+' : 'z-');
    const grouped = new Map(dirs.map(([dx, dz]) => [dirKey(dx, dz), []]));
    for (const p of want) {
      // 这一格相对她身体的哪一个 selfCell 是邻居？取那个方向做归属。
      let best = null;
      for (const cell of selfCells) {
        const dx = p.x - cell.x, dz = p.z - cell.z;
        if (Math.abs(dx) + Math.abs(dz) === 1 && (dx === 0 || dz === 0)) { best = dirKey(dx, dz); break; }
      }
      if (best) grouped.get(best).push(p);
    }
    // 默认放过"可放格子最少"的那个方向（它本来就封不严，放过它代价最小）
    const openDir = keepOpen && grouped.has(keepOpen)
      ? keepOpen
      : [...grouped.entries()].sort((a, b) => a[1].length - b[1].length)[0][0];
    const plan = want.filter(p => !grouped.get(openDir).includes(p));

    // 最多放 `blocks` 格 —— 调用方可以要更少（比如只堵一格应急）
    const targets = plan.slice(0, Math.max(1, Math.min(+blocks, 8)));

    if (!targets.length) {
      // ⚠️⚠️ P40【第二轮，正确的根因】：**"没有可放置的空位"有两种完全不同的含义，
      //    而这一段原来把它们混成了一句错误信息：**
      //
      //    ① **她站在天然闭合的缝里**（实机就是这种）：四周本来就是实心，
      //       这地方**已经有遮蔽**了。→ 这**不是错误**。报失败会让她陷进
      //       "needShelter 永远 true → 每 tick 都来试 → 永远失败"的死循环（P31 的形态）。
      //    ② 真的没地方放（比如她悬在半空 / 四周是可替换的植被但探测失败）。
      //
      //    所以先做两件事，都失败才抛错：
      //      a. **挪一格再搭**（`relocate`）—— 这才是"建立庇护所"该有的行为：
      //         站到附近一个"至少 2 个空邻居"的位置去。
      //      b. 挪不成 → **如实判定"已有天然遮蔽"并返回成功**（`naturalShelter: true`）。
      const sample = probe.slice(0, 6)
        .map(p => `(${p.x},${p.y},${p.z})=${p.block || '?'}`).join(' ');

      // ---- a. 找一个"至少有 2 个可放空位"的落脚点 --------------------------
      //
      // 搜索范围刻意很小（半径 3，同一 y 层，不挖不跳）—— 理由与 P34 一致：
      // "带她大范围移动"是新的行为面，掉进岩浆/水里的风险与"多封一格"的收益不成比例。
      // 只在她**能直接走到**的近处找。
      const R = 3;
      let best = null;
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx, nz = cz + dz;
          // 落脚点本身要能站（脚+头两层），且脚下有地面
          if (!selfIsAiry(nx, nz)) continue;
          const below = bot.blockAt(new Vec3(nx, feetY - 1, nz));
          if (!below || isAiryForPlace(below) || DEADLY.test(below.name || '')) continue;
          // 数一数它有几个"可放"的邻居（4 方向 × 2 层）
          let open = 0;
          for (const [ox, oz] of dirs) {
            for (const oy of [0, 1]) {
              const b = bot.blockAt(new Vec3(nx + ox, feetY + oy, nz + oz));
              if (isAiryForPlace(b)) open++;
            }
          }
          if (open < 2) continue;   // 太挤，挪过去也一样放不成
          const dist = Math.abs(dx) + Math.abs(dz);
          if (!best || open > best.open || (open === best.open && dist < best.dist)) {
            best = { x: nx, z: nz, open, dist };
          }
        }
      }

      if (best) {
        try {
          // 清掉上一次的 goal（P25：清理必须在发起下一次 goto **之前**）
          try { bot.pathfinder.setGoal(null); } catch (_) {}
          const goalY = feetY;
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(best.x, goalY, best.z, Math.max(2, best.dist + 1))),
            8000,
          );
          const now = bot.entity?.position;
          if (now && (Math.floor(now.x) !== cx || Math.floor(now.z) !== cz)) {
            // 走动了 → **递归重试一次**（这次在新位置上重新探测、留门、放置）
            state.__lastShelterProbe = {
              ...(state.__lastShelterProbe || {}),
              relocatedTo: { x: best.x, z: best.z, open: best.open, dist: best.dist },
              relocatedFrom: { cx, cz, probe, sample },
            };
            return await handlers['POST /shelter']({ itemName, blocks, keepOpen });
          }
        } catch (e) {
          // 走不过去（被挡住/超时）→ 落到下面的"天然遮蔽"判定
          state.__lastShelterProbe = {
            ...(state.__lastShelterProbe || {}),
            relocateFailed: { to: best, error: e.message },
          };
        }
      }

      // ---- b. 挪不动 → "这地方已经有遮蔽了" ---------------------------------
      //
      // ⚠️ 这**不是**在粉饰失败：她这格是 air、脚下是实心地面、四周（含头顶那层）
      //    全被实心方块包围 —— 从"躲怪"的角度看，她**已经在一个天然的掩体里**。
      //    返回 `ok/sheltered: true` + `naturalShelter: true` 让上层知道
      //    "需求已满足，不用再试"，从而跳出死循环。
      //
      //    ⚠️ 但要**如实报告**这个判定，绝不能默默当成"我搭好了"。所以：
      //      · `placed: 0`（诚实：我一块砖都没放）
      //      · `naturalShelter: true`（说明为什么仍算成功）
      //      · `reason` 带上探测到的方块，供事后核对
      const selfAir = selfIsAiry(cx, cz);
      const groundSolid = (() => {
        const b = bot.blockAt(new Vec3(cx, feetY - 1, cz));
        return !!b && !isAiryForPlace(b) && !DEADLY.test(b.name || '');
      })();
      if (selfAir && groundSolid) {
        return {
          placed: 0,
          naturalShelter: true,   // ★ 诚实标记：没放方块，是靠天然地形
          sheltered: true,        // 需求已满足 → 上层不再重试（跳出 P31 形态的死循环）
          keptOpen: null,
          message: `已经在一个天然掩体里（四周 ${probe.length} 格全是实心，无需再封）`,
          details: [],
          failed: [],
          probe: { at: { cx, feetY, cz }, sample },
        };
      }

      // ---- c. 真的没辙了 → 如实抛错（带上证据，别再指向错的层） -------------
      throw new Error('脚边没有可放置的空位，附近也没有能挪过去的位置'
        + `（归到她站 (${cx},${feetY},${cz})，selfAir=${selfAir} groundSolid=${groundSolid}`
        + `，探测到 ${probe.length} 格：${sample || '无'}）`);
    }

    // 站定再放 —— 身体漂着的时候会打偏（与 `/place` 一致）
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    await sleepMs(150);
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');

    const placed = [];
    const failed = [];
    for (const t of targets) {
      // 每一格都重新确认还是空气 —— 上一格放下去可能改变了地形
      const now = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (!isAiryForPlace(now)) {   // ⚠️ P39：用**同一份**判据（`place.js` 的 AIRY），别再抄一遍
        failed.push({ at: t, reason: `已经不是空格了（${now?.name || '读不到'}）` });
        continue;
      }
      // 手里还有没有这个方块
      const still = bot.inventory.items().find(i => i.name === item.name);
      if (!still) { failed.push({ at: t, reason: '方块用完了' }); break; }
      if (bot.heldItem?.name !== item.name) { try { await bot.equip(still, 'hand'); } catch (_) {} }

      state.currentAction = `sheltering ${t.x},${t.y},${t.z}`;
      try {
        // 复用 `/place` 的几何判定 —— **不另写一份**（P2b/P18 教训）。
        const verdict = placeLogic.planPlacement({
          target: t,
          getBlock: pos => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)),
          feet: { x: ep.x, y: ep.y, z: ep.z },
          height: bot.entity?.height,
        });
        if (!verdict.ok) { failed.push({ at: t, reason: `几何不可行（${verdict.kind}）` }); continue; }

        let done = false;
        for (const p of verdict.plans) {
          const ref = bot.blockAt(new Vec3(p.refPos.x, p.refPos.y, p.refPos.z));
          if (!ref) continue;
          try { await withTimeout(bot.lookAt(new Vec3(p.contact.x, p.contact.y, p.contact.z), true), 3000); } catch (_) { continue; }
          try {
            await withTimeout(bot.placeBlock(ref, new Vec3(p.face.x, p.face.y, p.face.z)));
            const ok = await waitForBlock(bot, new Vec3(t.x, t.y, t.z), 1500);
            placed.push({ at: t, via: p.label, confirmed: ok });
            done = true;
            break;
          } catch (_) { /* 换个面试 */ }
        }
        if (!done) failed.push({ at: t, reason: '所有面都放不下' });
      } catch (e) {
        failed.push({ at: t, reason: e.message });
      } finally {
        state.currentAction = null;
      }
      await sleepMs(120);   // 每格之间让出一点时间，别把服务端刷爆
    }

    return {
      placed: placed.length,
      keptOpen: openDir,     // 如实汇报"哪个方向留了门"——调用方要能知道她出得来
      details: placed,
      failed,
      // 至少要封住 2 格才算"有个遮蔽的样子"；1 格只是象征性的
      sheltered: placed.length >= 2,
      // ★ 2026-09-25（P44 架构修复）：`ok` —— 让 `sheltered: false` 也能**否决**
      //   路由层的 `success: true`。
      //
      //   ⚠️ 注意与上面那个 `naturalShelter` 分支的区别：那里 return 的是
      //      `sheltered: true`（"已有天然掩体"，需求已满足），**不走这里**。
      //      这里只覆盖"真的要搭、但一块都没搭上"的情况 —— 那是真失败。
      //
      //   P41 的教训就在这里：autopilot 当年只看 `success`，于是
      //   `placed: 0` 也被当成"搭好了"，她会站在空地上以为自己有庇护所。
      ok: placed.length >= 2,
    };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.handlers !== undefined) handlers = ns.handlers;
  if (ns.isAiryForPlace !== undefined) isAiryForPlace = ns.isAiryForPlace;
  if (ns.sameItem !== undefined) sameItem = ns.sameItem;
  if (ns.sleepMs !== undefined) sleepMs = ns.sleepMs;
  if (ns.state !== undefined) state = ns.state;
  if (ns.waitForBlock !== undefined) waitForBlock = ns.waitForBlock;
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
  keys: ["POST /place","POST /shelter"],
  bind,
  rebind,
 };
