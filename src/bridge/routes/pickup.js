/**
 * routes/pickup.js —— 从 server.js 的 handlers 表拆出的 1 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const { isStandable } = require('../../world/place');   // 拆分时漏搬（原 server.js:31 的解构），2026-09-29 补
const instinct = require('../../instinct/instinct.js');
const pathing = require('../../world/pathing');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let state;
let Vec3;
let goals;

function findStandY (...a) { return __ns.findStandY.apply(null, a); }
function fingerprintDelta (...a) { return __ns.fingerprintDelta.apply(null, a); }
function inventoryFingerprint (...a) { return __ns.inventoryFingerprint.apply(null, a); }
function isDropEntity (...a) { return __ns.isDropEntity.apply(null, a); }
function sleep (...a) { return __ns.sleep.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

/**
 * 本文件负责的路由（1 条）：
 *   POST /pickup
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'POST /pickup': async ({ radius = 8, count = 4, timeoutMs = 8000, budgetMs = 15000, ids, abort } = {}) => {
    radius = Math.min(Math.max(1, +radius), 32);
    count = Math.min(Math.max(1, +count), 32);

    const self = state.bot.entity;
    // ⚠️⚠️ 这里原来用 `e.objectType === 'Item'` 判掉落物 —— 而 `objectType`
    //   在 prismarine-entity 里是**废弃 getter**，实现是 `return this.displayName`，
    //   每次读取都会 `console.trace()` 打一整坨堆栈（见 field-log P7）。
    //   上次修 P7 时只改了 `/nearby` 和 `/collect`，**漏了这个 `/pickup`** ——
    //   于是堆栈又从这里冒出来。现在统一走 `isDropEntity`。
    //
    //   顺带纠正上面那条旧注释的错误：`name === 'item'` 其实**是**能匹配到的
    //   （实战里掉落物的 `name` 就正好是 'item'，`displayName` 才是 'Item'）。
    //   真正不能用的是 `objectType`（废弃）和 `e.name === 物品显示名`（会一条不中）。
    const drops = Object.values(state.bot.entities)
      .filter(e => e && e !== self && e.position && e.isValid !== false)
      .filter(isDropEntity)
      .filter(e => !Array.isArray(ids) || ids.includes(e.id))
      .filter(e => e.position.distanceTo(self.position) <= radius)
      .sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position))
      .slice(0, count);

    // ⚠️ 2026-09-28 审计（codex fix0 #2）：**空掉落物也要回完整的结构**。
    //    原来这里直接 `return { found: 0, walkedTo: 0, picked: 0, message }` ——
    //    没有 `tried/reached/stopped/ms`。调用方（`instinct.pickupFailIds`、
    //    autopilot）拿到的形状随"地上有没有东西"而变，没法当固定契约用
    //    （`r.tried` 缺失还会被旧协议兜底逻辑读成"全部失败"，见 instinct.js）。
    //    现在所有返回路径都保证有这四个字段：数组、数组、`null` 或字符串、数字。
    if (!drops.length) {
      return {
        found: 0, walkedTo: 0, picked: 0,
        tried: [], reached: [], stopped: null, ms: 0,
        message: `${radius} 格内没有掉落物`,
      };
    }

    // ⚠️⚠️⚠️ P32（2026-09-25 实机抓出）：**必须自己统计"捡到了几个"。**
    //
    //    上面那段注释早就写对了 —— "`walkedTo` 是走到了不是捡到了；捡了几个
    //    得看背包，客户端没有拾取事件，只能靠前后对比"。**但它只说了，没做。**
    //    返回体里从来就没有 `picked` 这个字段。
    //
    //    后果是真的会卡死（实机证据）：
    //      · 她站在 y=87，掉落物在 y=85（掉进自己挖的坑里）
    //      · `goto` 到"水平 2 格内"就返回成功（球心已按 P30 修成 selfY）
    //      · 但她够不着 y=85 的东西 → 背包一件没多
    //      · `/pickup` 照样报 `walkedTo: 3`（走到了！）→ autopilot 看到
    //        `ok: true` → 不退避 → 下一拍又去捡 → **无限循环**
    //
    //    这是 P26 的同类问题（"我以为它做完了" vs "它真的做完了"），
    //    只是从**观测层**下沉到了**动作层**：动作自己谎报成功，
    //    于是上层所有基于 `ok` 的机制（失败退避、重试上限）**全部失效**。
    //
    //    教训：**一个动作的返回值里，必须有"世界真的变了"的证据**，
    //    不能只有"我发了请求 / 我走到了"。所以这里记背包快照，循环后对比。
    const snapBefore = inventoryFingerprint();

    const myTag = `picking up ${drops.length} drops`;
    state.currentAction = myTag;
    let walkedTo = 0;
    const failed = [];
    const tried = []; const reached = []; let stopped = null;
    const t0 = Date.now();
    // ⚠️ 2026-09-28 审计（codex fix0 #1）：**严格总预算**。
    //    原来是 `if (Date.now() - t0 > budgetMs) { stopped='budget'; break; }` ——
    //    它有两个洞：
    //      ① 每次 goto 的超时被 `Math.max(1000, budgetMs - elapsed)` 托底成 1000ms，
    //         于是最后一项即使只剩 50ms，仍会再跑满 1 秒，总时长可超预算约 1 秒；
    //      ② 如果那一项正好是**最后一项**，循环自然结束，`stopped` 永远停在
    //         `null` —— 调用方看不出"其实是预算用光了，没轮完"。
    //    现在：用明确 deadline；剩余不足 1 秒就**不再发起新的 goto**（记 `stopped:'budget'`
    //    并 break）；每次 goto 返回后**补判一次预算**，把"最后一项也吃超了"记成 `budget`
    //    而不是误报成正常跑完。
    const deadline = t0 + Math.max(0, +budgetMs);
    const budgetLeftMs = () => deadline - Date.now();
    try {
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        if (typeof abort === 'function' && abort()) { stopped = 'aborted'; break; }
        // 严格：剩余不到 1 秒（goto 的最小可用超时）就停下，不再发起新目标
        if (budgetLeftMs() <= 1000) { stopped = 'budget'; break; }
        // ⚠️ 2026-09-28 审计（codex fix0 #3）：**确认它是"能试的有效目标"再记 tried**。
        //    原来 `tried.push(d.id)` 在读 `isValid` 之前 —— 实体已经失效/位置读不到时
        //    她其实**一步没试**，却仍被记成"试过但没捡到"，进而记失败、进冷却。
        if (!d.isValid || !d.position) continue;
        tried.push(d.id);
        // ⚠️⚠️⚠️ 2026-09-25 实战（P25）：这个循环里踩了**三层**坑，
        //     全部围绕"`goto()` 的 promise 什么时候算结束"。写清楚，别再犯：
        //
        //   ① **目标类型**：原来用 `GoalFollow(d, 1)`。它在 `isEnd()` 里要求
        //      "进入 range 且视线可达"，掉落物掉进自己挖的坑里（视野被挡）
        //      就**永不完成** —— 配上超时 = 每次必然走满超时。
        //      → 换成 `GoalNear`（"到达"型目标，到了就结束）
        //
        //   ② **不能在结束之后清 goal**：`setGoal(null)` 会 emit
        //      `goal_updated(null)`，而下一个 goto 的 listener 已经注册好在等，
        //      收到 null 就报 `GoalChanged`。
        //      → 清理只放在**发起 goto 之前**（此刻无人等待）
        //
        //   ③ **超时会让 goto 的 promise 永远挂着**（这一层最隐蔽）。
        //      `withTimeout` 只是 `Promise.race([goto, timer])` —— timer 赢了
        //      只是**我们不等了**，`goto` 自己的 promise 还在 pump，
        //      它的 `goal_updated` / `goal_reached` / `path_stop` listener
        //      **全部挂着不摘**。下一个 goto 一 `setGoal(goalB)` 就撞上
        //      上一个残留的 listener（它绑的是 `goalA`）→ `goalB !== goalA`
        //      → 报 `GoalChanged`。
        //      实测证据：`GET /debug/pathfinder` 的 `goal_updated` listener
        //      数**稳定停在 2**（正常应该是 1 或 0），而 `walkedTo` 恒为 1
        //      —— 也就是"只有第一个目标真的跑过"。
        //
        //      → 修法：**超时时把那个 promise 收干净**。`stop()` 会让它收到
        //        `path_stop` 并 settle，listener 随之摘掉。所以 `stop()` 必须调，
        //        而且**要给它一个 tick 去完成清理**（`goto.js` 的 `cleanup()`
        //        里是 `setTimeout(..., 0)`）。
        //
        //   ④ **球心的 y 不能直接用掉落物的，也不能死锁在她自己的高度**（P30 + P33）。
        //
        //      P30 修的是"用 `p.y` → 她下不去坑 → 原地打转"；
        //      但 P30 的修法（球心一律用 `selfY`）**引入了反向的错**：
        //      球心锁在她**当前**高度 → 她永远不下坑 → 站在坑沿上够不着坑底。
        //
        //      ⚠️ 实机证据（P33，2026-09-25）：
        //        `POST /pickup` 返回 `walkedTo: 3, picked: 0, ok: false`
        //        她 (-1,87,-3) 站在坑沿，掉落物在 y=85/86 的坑底空气格里，
        //        中间 (-1,86,-4) 是实心 —— 那是个 1 格宽的竖井，她在井口外。
        //        走到"水平 2 格内"就停，而**拾取是 3D 判定**，垂直差 2 格拿不到。
        //
        //      正确的语义：**"站到她能够着这堆东西的那一层"**。
        //        · 物品在她脚下 1 格内（y ∈ [selfY-1, selfY]）→ 就用物品的 y
        //          （那里她下得去：1 格落差可以直接走下去，不需要挖）
        //        · 物品更深（y < selfY-1）→ 夹到 `selfY-1`，即"站在最近的
        //          可站层，靠拾取半径够到"。**绝不要求她挖穿地形**（canDig=false）。
        //        · 物品在她头顶之上 → 夹到 `selfY`（不要为了够着而往天上爬）
        //
        //      这样 P30（不下坑打转）和 P33（永不落坑）同时被满足。
        const selfY = Math.floor(state.bot.entity?.position?.y ?? 0);
        const selfFeetY = selfY;
        // ⚠️⚠️⚠️ P43（2026-09-25）：**改了这里**。原来只有
        //    `const targetY = reachableStandY(d.position.y, selfFeetY);`
        //    —— 那是"只看两个 y 就算出答案"的纯函数，**它不知道物品压在方块上**。
        //
        //    实测反例：物品报告 `y=85`，而 `(-7,85,-8) = grass_block`（实心），
        //    物品真正的空间在 `y=86`。旧函数返回 85 → `standable` 拦掉 →
        //    退回 `GoalNear(球心 85)` → 球内含她自己 → **一步不动**，
        //    而她其实距物品只有 0.97 格。**"看得见摸不着"就是这个。**
        //
        //    新函数会把候选层逐个拿去问世界（脚+头都要可站），
        //    找出**真的站得进去**的那一层。硬约束（不上天 / 不下潜超 1 格）保留。
        const targetY = findStandY(
          d.position.y, selfFeetY,
          (bx, by, bz) => state.bot.blockAt(new Vec3(bx, by, bz)),
          Math.floor(d.position.x), Math.floor(d.position.z),
        );

        // ⚠️⚠️ P38：**半径随垂直落差自适应** —— 但要说清楚它修了什么、没修什么。
        //
        //    【修了什么】`GoalNear` 判据是"欧氏距离 ≤ r"。落差 3 格时，
        //      r=2 的球内**在 xz 平面上一个点都没有**（√(h²+9) ≥ 3 > 2 恒成立）
        //      → `goto` **必然走满超时**，纯浪费时间。半径 ≥ 落差+1 保证球内有点。
        //
        //    【没修什么】落差 1 格、r=2 时球内**有**点 —— **就是她自己站的格**
        //      → 她判定"已到达" → 不动 → 还是拿不到。
        //      **所以自适应半径治不了"她不肯往下走"。**
        //      实测里她从 y=90 下到 y=88，那是寻路器**为了进入球内**自己走的路，
        //      不是"为了捡东西而下行"。
        //
        //    【真正的限制】`GoalNear` 在原理上无法表达"下到那一格去"。
        //      要做到那个，需要点式目标（`GoalBlock`）或按键控制 ——
        //      那是 P34 的待决项，**刻意没做**（"主动带她下坑"是新行为面，
        //      掉进岩浆/水里的风险与捡回几块泥土的收益不成比例）。
        //
        //    ⚠️ 所以这里的定位是：**把最坏情况从"必然超时"降到"有界失败"**，
        //       失败后由 P32 的退避机制接管，链路不会卡死。
        const vertGap = Math.abs(selfFeetY - targetY);
        const reachRadius = Math.max(2, vertGap + 1);

        pathing.clearPathfinderGoal(state.bot.pathfinder);
        try {
          const p = d.position;
          // ⚠️⚠️⚠️ P34 修复（2026-09-25 实机验证）：
          //    物品**在她下方**时改用 `GoalBlock`，不再用 `GoalNear`。
          //
          //    【为什么】`GoalNear(p.x, selfY-1, p.z, r)` 的球心在 `selfY-1`，
          //      而**球内包含她自己当前站的格**（水平距离 0 ≤ r）→
          //      寻路器判定"已经到达" → **一步不动**。
          //      实机：`{"walkedTo":1,"picked":0,"ok":false}` 反复出现。
          //
          //    【实机反证】同一个人、同一格物品，我手动 POST /move 到
          //      `{"x":-9,"y":86,"z":-8}`（即 `GoalBlock`）→ **她真的下去了**：
          //        `{"success":true,"arrived":{"x":-8,"y":87,"z":-8}}`
          //        位置 `y: 87 → 86` ✓，而且**顺手把物品捡了**（背包 20→21）。
          //      结论：**她能下这一格，只是 `GoalNear` 表达不了"下到那一格去"。**
          //
          //    【所以】落差 ≥ 1 且**目标格站得进去**（脚+头两层都可站）时，
          //      用 `GoalBlock(targetY 那一格)` —— 那是"点式目标"，没有"already
          //      there"的歧义。落差 0 时仍用 `GoalNear`（保留原来的容错，
          //      不必精确踩到某一格）。
          //
          //    ⚠️ 为什么**只在她下方**时才换：物品在她**上方**时 `targetY = selfY`
          //      （见 `findStandY` 的"绝不上天"约束），本来就是同一层，
          //      用 `GoalNear` 更稳（不会因为要求精确站位而失败）。
          //
          //    ⚠️⚠️ P43 修正：`wantY` 从 `floor(物品的 y)` 改成 **`targetY`**。
          //      理由就是 P43 的根因 —— 物品报告的 y **可能是实心方块**
          //      （物品躺在方块顶面上），直接拿它当目标层必然站不进去。
          //      `targetY` 是 `findStandY` 已经**逐层问过世界**选出来的可站层，
          //      所以 `standable` 这一步现在是**校验**（防竞态：选完之后世界变了），
          //      而不是"原来那样用错误的层去试"。
          const wantY = targetY;
          const descends = Number.isFinite(wantY) && wantY < selfFeetY;
          // 目标格站得进去吗？（脚层与头层都不是实心）
          // 复用 `isStandable` —— 与 `/shelter` 的 `selfIsAiry` **同一个判据**
          //（P42 的教训：写完判定函数就该拿它解释眼前的失败）。
          const standable = (() => {
            if (!descends) return false;
            const feet = state.bot.blockAt(new Vec3(p.x, wantY, p.z));
            const head = state.bot.blockAt(new Vec3(p.x, wantY + 1, p.z));
            return isStandable(feet) && isStandable(head);
          })();

          // ⚠️ P43 第二处：落差为 0 时也**值得**用 `GoalBlock` —— 只要目标格
          //    真的站得进去、且她**不在那一格**（在隔壁）。否则 `GoalNear` 的
          //    球内会包含她自己站的格 → 判"已到达" → 一步不动（这就是 0.97 格
          //    那个"看得见摸不着"）。但**不能无脑换**：物品就在她自己那格时
          //    `GoalBlock` 只会立刻 success（P44 的语义歧义），没有收益。
          const selfCellX = Math.floor(state.bot.entity?.position?.x ?? 0);
          const selfCellZ = Math.floor(state.bot.entity?.position?.z ?? 0);
          const adjacent = (Math.floor(p.x) !== selfCellX || Math.floor(p.z) !== selfCellZ);
          const useBlock = standable && (descends || adjacent);

          const goal = useBlock
            ? new goals.GoalBlock(p.x, wantY, p.z)     // ★ "走到/下到那一格去"
            : new goals.GoalNear(p.x, targetY, p.z, reachRadius);

          // ⚠️ 严格预算（codex fix0 #1）：超时取"剩余预算 + 1s 余量"，但绝不无限托底。
          //    到这一行时 `budgetLeftMs() > 1000` 已经由循环头保证，所以
          //    `Math.min(timeoutMs, budgetLeftMs())` 不会退化成负数/0；
          //    再兜一个 1000ms 下限，避免极端抖动把单次 goto 压成 0。
          const r = await withTimeout(state.bot.pathfinder.goto(goal), Math.min(timeoutMs, Math.max(1000, budgetLeftMs())));
          walkedTo++;
          reached.push(d.id);
          // 挖到/走到之后**立刻试着真正拾取一次**：有些情况下服务端要等到
          // 下一次实体 tick 才结算，`goto` 返回时她其实已经在范围内了。
          // 这一步是"顺手一捞"，失败不影响主流程（真正的判据在循环末尾的背包对比）。
          try { await sleep(120); } catch (_) {}
          void r;
        } catch (e) {
          failed.push({ name: d.name || 'unknown', reason: e.message });
        }
        // ★ 让上一个 goto 彻底 settle：`stop()` 会 emit `path_stop`，
        //   触发 `goto.js` 的 `pathStopped` → 摘掉全部 listener。
        //   后面再等一个 tick 是必须的 —— `goto.js` 的 cleanup 自己就是
        //   `setTimeout(..., 0)`，不等的话下一个 goto 会撞上尚未摘掉的 listener。
        try { state.bot.pathfinder.stop(); } catch (_) {}
        await sleep(0);
        // ⚠️ 2026-09-28 审计（codex fix0 #1）：**每次动作结束补判预算**。
        //    这一项若已经是最后一项、且它自己吃超了预算，循环会自然结束 ——
        //    原来 `stopped` 就停在 `null`，调用方误以为"全部轮完了"。
        //    现在把"预算已耗尽但还有没轮到的"如实记成 `budget`。
        //
        //    ⚠️ 2026-09-28 二轮审计（wbR2 新发现，低）：判据用 `i < drops.length - 1`
        //      是**索引**上界，不是"还有有效目标没轮" —— `drops` 里被上面
        //      `(!d.isValid || !d.position) continue` 跳过的无效实体**照样占索引**。
        //      于是"最后一个**有效**目标刚处理完、后面全是无效项、预算恰好耗尽"时，
        //      会被误报成 `stopped:'budget'`（其实所有有效目标都轮过了）。
        //      改为按"已处理的有效目标数 < 有效目标总数"判 —— 与上面 `tried` 的口径一致。
        const moreValidLeft = i + 1 < drops.length
          && drops.slice(i + 1).some(x => x.isValid !== false && x.position);
        if (moreValidLeft && budgetLeftMs() <= 1000 && stopped === null) { stopped = 'budget'; break; }
      }
    } finally {
      // 循环彻底结束，**此时没有任何 goto 在等** —— 这是唯一安全的清理位置。
      pathing.clearPathfinderGoal(state.bot.pathfinder);
      // 只清自己的标记：被打断时新命令可能已经写上了它的（见 instinct.yieldBody）
      if (state.currentAction === myTag) state.currentAction = null;
    }

    // ⚠️ P32：用**背包前后差**给出"真的捡到了几个"。这是这个端点的**唯一可信答案**。
    //    `walkedTo` 保留（它对排查仍有价值 —— 能区分"没走到"和"走到了但拿不着"），
    //    但它**不再是成功判据**。
    const snapAfter = inventoryFingerprint();
    const picked = fingerprintDelta(snapBefore, snapAfter);
    const gained = snapAfter.total - snapBefore.total;

    return {
      found: drops.length,
      walkedTo,
      picked,                       // ★ 真的进背包的件数（P32）
      gained,                       // 件数净变化（可能因消耗为负）
      // 判据：走到了、但背包没变 → **明确报失败**，让上层能退避。
      // 只"走到"不算数 —— 这正是 P32 要修的那个谎。
      ok: picked > 0,
      // ⚠️ 2026-09-28 审计（codex fix0 #2）：`stopped` 原来写 `stopped || undefined`，
      //    正常跑完时被序列化成"字段不存在"（JSON 里 undefined 会被丢掉）。
      //    调用方没法区分"没停"和"字段没实现"，所以现在明写 `null`（= 没被停过）。
      tried, reached, stopped: stopped || null, ms: Date.now() - t0,
      failed: failed.length ? failed : undefined,
      note: picked > 0
        ? undefined
        : (walkedTo > 0
          ? '走到了掉落地，但有几件没进背包（可能被地形挡住或在脚下够不着）'
          : '一件都没走到'),
    };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.findStandY !== undefined) findStandY = ns.findStandY;
  if (ns.fingerprintDelta !== undefined) fingerprintDelta = ns.fingerprintDelta;
  if (ns.inventoryFingerprint !== undefined) inventoryFingerprint = ns.inventoryFingerprint;
  if (ns.isDropEntity !== undefined) isDropEntity = ns.isDropEntity;
  if (ns.sleep !== undefined) sleep = ns.sleep;
  if (ns.state !== undefined) state = ns.state;
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
  keys: ["POST /pickup"],
  bind,
  rebind,
 };
