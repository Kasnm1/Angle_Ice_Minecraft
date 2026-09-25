#!/usr/bin/env node
/**
 * 放置方块的几何判定 —— 从 bridge-server 的 `/place` 里抽出来的**纯逻辑**。
 *
 * ## 为什么值得单独抽出来
 *
 * 放置的四个条件（参照面 / 可及性 / <4.5 格 / 自身碰撞箱）全都是**几何**问题，
 * 跟 mineflayer 一点关系都没有。留在 HTTP handler 里的话，想验证就只能
 * "连上服务器试着放一下" —— 而放置恰恰是最容易**静默失败**的操作：
 * `placeBlock` 返回了、客户端也画出来了，服务端其实没认（幽灵方块）。
 *
 * 抽成纯函数之后，六个面 × 四种失败原因可以在离线状态全部穷举，
 * handler 里只剩"选好面 → 看过去 → 放 → 等服务端确认"这四行。
 *
 * ## 用法
 *
 *     node place.js --selftest
 */

// 视为"不是实心参照物"的方块
const AIRY = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava)$/;

// 眼睛到接触点的最大距离。超过就是够不着 —— 服务端会直接无视这次放置，
// 表现成"超时"，而不是一个明确的错误。
const REACH = 4.5;

// 玩家碰撞箱半宽（宽度 0.6）
const HALF_WIDTH = 0.3;

/** 六个面：offset 指向参照方块，face 是"从参照块朝目标块"的方向 */
const FACES = [
  { offset: { x: 0, y: -1, z: 0 }, face: { x: 0, y: 1, z: 0 } },
  { offset: { x: 0, y: 1, z: 0 }, face: { x: 0, y: -1, z: 0 } },
  { offset: { x: -1, y: 0, z: 0 }, face: { x: 1, y: 0, z: 0 } },
  { offset: { x: 1, y: 0, z: 0 }, face: { x: -1, y: 0, z: 0 } },
  { offset: { x: 0, y: 0, z: -1 }, face: { x: 0, y: 0, z: 1 } },
  { offset: { x: 0, y: 0, z: 1 }, face: { x: 0, y: 0, z: -1 } },
];

/** 把偏移量转成人话，用在"每个面为什么放不了"的错误信息里 */
function offsetLabel (v) {
  if (v.y === -1) return 'below';
  if (v.y === 1) return 'above';
  if (v.x === -1) return 'west';
  if (v.x === 1) return 'east';
  if (v.z === -1) return 'north';
  if (v.z === 1) return 'south';
  return `${v.x},${v.y},${v.z}`;
}

/**
 * 条件④：自己的身体是不是正占着目标格？
 *
 * 用方块格（边长 1）与身体包围盒（宽 0.6 × 高 1.8）做重叠判定。
 * 不查这一条的话，`placeBlock` 会把自己卡进方块里 —— 服务端通常直接拒绝，
 * 而客户端会先画出"成功"的样子。
 */
function bodyOccupies (target, feet, height) {
  if (!feet) return false;
  const h = height ?? 1.8;
  return (
    target.x + 1 > feet.x - HALF_WIDTH && target.x < feet.x + HALF_WIDTH &&
    target.y + 1 > feet.y && target.y < feet.y + h &&
    target.z + 1 > feet.z - HALF_WIDTH && target.z < feet.z + HALF_WIDTH
  );
}

/** 眼睛位置（脚的位置往上抬）。够不够得着以**眼睛**为准，不是以脚。 */
function eyeFrom (feet, height) {
  if (!feet) return null;
  return { x: feet.x, y: feet.y + (height ?? 1.8) - 0.18, z: feet.z };
}

/**
 * 评估单个候选面。
 * @returns {{ok:boolean, reason?:string, contact?:object, distance?:number, refPos?:object}}
 */
function evaluateFace ({ target, offset, face, getBlock, eye }) {
  const refPos = {
    x: target.x + offset.x,
    y: target.y + offset.y,
    z: target.z + offset.z,
  };

  // 条件①：参照块必须存在、且是实心的
  const ref = getBlock(refPos);
  if (!ref) return { ok: false, reason: 'out-of-range', refPos };
  if (AIRY.test(ref.name || '')) {
    return { ok: false, reason: `not-solid(${ref.name || '?'})`, refPos };
  }

  // 条件③：眼睛 → 接触点 < REACH。
  // 接触点 = 参照块中心 + 朝目标方向半格，也就是两格的交界面中心。
  const contact = {
    x: refPos.x + 0.5 + face.x * 0.5,
    y: refPos.y + 0.5 + face.y * 0.5,
    z: refPos.z + 0.5 + face.z * 0.5,
  };
  const distance = eye
    ? Math.hypot(contact.x - eye.x, contact.y - eye.y, contact.z - eye.z)
    : 0;
  if (eye && distance >= REACH) {
    return { ok: false, reason: `too-far(${distance.toFixed(1)})`, refPos, contact, distance };
  }

  // 条件②（可及性 / 不遮挡）在这里只做"距离"这一半 —— 真正判断视线
  // 需要射线检测，由 handler 用 lookAt 的结果来兜底。
  return { ok: true, refPos, contact, distance };
}

/**
 * 依次评估六个面，返回**全部可行方案**（按固定顺序）以及每个不可行面的原因。
 *
 * 为什么返回全部而不是只返回第一个：几何上可行 ≠ 实际放得下 ——
 * 面可能被别的方块挡住（这一条需要射线检测，纯几何判不出来），
 * 或者服务端在那一瞬间拒绝了。调用方拿到候选列表就能逐个试，
 * 而不是"第一个失败就整体失败"。
 *
 * @param {object} p
 * @param {{x,y,z}} p.target
 * @param {(pos:{x,y,z})=>({name:string}|null)} p.getBlock
 * @param {{x,y,z}|null} p.feet
 * @param {number} [p.height]
 * @returns {{ok:true, plan:object, plans:object[]} | {ok:false, kind:string, tried:string[]}}
 */
function planPlacement ({ target, getBlock, feet, height }) {
  // 条件④先查：自己被卡在目标格里的话，换哪个面都放不了，直接说清楚
  if (bodyOccupies(target, feet, height)) {
    return { ok: false, kind: 'self-occupied', tried: [] };
  }

  const eye = eyeFrom(feet, height);
  const tried = [];
  const plans = [];

  for (const { offset, face } of FACES) {
    const r = evaluateFace({ target, offset, face, getBlock, eye });
    if (r.ok) {
      plans.push({
        label: offsetLabel(offset),
        offset, face,
        refPos: r.refPos,
        contact: r.contact,
        distance: +r.distance.toFixed(2),
      });
    } else {
      tried.push(`${offsetLabel(offset)}:${r.reason}`);
    }
  }

  if (plans.length) return { ok: true, plan: plans[0], plans };

  // 都不行时给一个"可操作"的结论，而不是笼统的"放不下"：
  // 全是 too-far → 该走近点；全是 not-solid → 该换个位置
  const allTooFar = tried.length > 0 && tried.every(t => t.includes('too-far'));
  const allNotSolid = tried.length > 0 && tried.every(t => t.includes('not-solid') || t.includes('out-of-range'));
  return {
    ok: false,
    kind: allTooFar ? 'too-far' : allNotSolid ? 'no-solid-neighbour' : 'mixed',
    tried,
  };
}

// ------------------------------------------------------------------ 站位

// 从 bridge-server.js 搬来：放置和站位是同一套几何，判据只许有一份（P39）。

// "她能不能站进这一格" —— 脚下的方块不能要命，头/脚两格不能是实心。
// ⚠️ 刻意**不含** lava：上面的 `AIRY` 把岩浆当空气是为了"岩浆能当参照物"，
//    但"她站在岩浆上"是另一回事，必须让 shelter 停下来如实报错。
const DEADLY = /^(lava|flowing_lava|fire|soul_fire|magma_block|cactus|powder_snow)$/;
function isStandable (block) {
  return !!block && AIRY.test(block.name || '') && !DEADLY.test(block.name || '');
}

/**
 * 为了够到某个 y 上的东西，她应该站到**哪一层**。
 *
 * ## 为什么需要（P33，2026-09-25 实机抓出）
 *
 * `GoalNear(x, y, z, r)` 的 `r` 是**水平**半径，但 Minecarft 的**拾取判定是 3D 的**
 * （玩家碰撞箱与物品实体碰撞箱重叠才结算）。所以"水平走到了"不代表"拿得到"。
 *
 * 这个函数把"物品在哪一层"翻译成"她该站哪一层"，规则：
 *
 * | 物品相对她脚底 | 目标层 | 理由 |
 * |---|---|---|
 * | 上方（`dy > 0`） | `selfY` | 不为了够东西往天上爬 |
 * | 同层或下一层（`-1 ≤ dy ≤ 0`） | 物品的 `y` | 1 格落差可以直接走下去，不用挖 |
 * | 更深（`dy < -1`） | `selfY - 1` | 站到最近的可站层，靠拾取半径够 |
 *
 * 关键点是**绝不返回比 `selfY-1` 更低的目标** —— 寻路器 `canDig=false`
 * 不会挖穿地形去达成目标，返回更低的值就是让它超时打转（P30 的病）。
 *
 * ## 两个"相邻的错"都在这条规则里被同时满足
 *   · P30：球心用物品的 y → 她下不去 → 原地打转  ← 被"更深就夹住"修掉
 *   · P33：球心一律用 selfY → 她永不落坑 → 够不着 ← 被"浅就跟着下去"修掉
 *
 * @param {number} dropY  物品所在层（可以是小数，取 floor）
 * @param {number} selfY  她脚底所在层
 * @returns {number} 目标层的整数 y
 */
function reachableStandY (dropY, selfY) {
  const d = Math.floor(Number(dropY));
  const s = Math.floor(Number(selfY));
  if (!Number.isFinite(d) || !Number.isFinite(s)) return s;   // 数据不可信 → 退回她自己那层
  const dy = d - s;
  if (dy > 0) return s;          // 物品在上方 → 不上天
  if (dy >= -1) return d;        // 同层或下一层 → 跟着下去（这是能捡到的关键！）
  return s - 1;                  // 更深 → 站在最近的可站层
}

/**
 * ★ P43（2026-09-25）：**"物品报告的 y"根本不该直接拿去当"目标站位层"。**
 *
 * ## 病在哪
 *
 * `/pickup` 原来只调 `reachableStandY(dropY, selfY)` —— 它只看**两个 y**
 * 就算出一个答案，**完全没有访问世界**。而"物品报告的 y"和"物品所在的空间"
 * 经常不是同一层：
 *
 * ```text
 * (-7,85,-8) = grass_block  solid=True   ← 物品**报告的 y**（它是躺在方块上的）
 * (-7,86,-8) = air          solid=False  ← 物品**真正的空间**
 * ```
 *
 * 于是：`reachableStandY(85, 86)` → `dy = -1` → 返回 **85**（一格实心方块）。
 * 后面 `standable` 检查会把 85 拦掉（这是对的），但拦掉之后退回 `GoalNear`，
 * 球心仍在 85、而她人在 86 —— **球内包含她自己** → 判"已到达" → **一步不动**。
 *
 * ## 为什么这是**第三次**踩同一个坑
 *   · P42：她被困在"1 格高的通道"里 —— 站位的语义是**空间**不是方块
 *   · P43：物品压在方块顶面 —— 物品的语义是**空间**不是方块
 *   · 两次都是"**方块坐标 ≠ 空间坐标**"。P42 是她的空间，P43 是物品的空间。
 *
 * ## 修法：把"算一个数"换成"**找一个真站得进去的层**"
 *
 * 候选顺序（按"离物品最近且她真的能站"排）：
 *   ① 若物品报告层是实心（物品压在方块上）→ 先试它的**上一层**（那才是物品的空间）
 *   ② 物品报告层本身
 *   ③ 物品报告层下一层
 *   ④ 物品报告层上一层
 * 每层都要 **脚 + 头两层都可站**（`isStandable`）才算数。
 *
 * 硬约束（与 `reachableStandY` 一致，不能破）：
 *   · **绝不上天**：`y > selfY` 不选（P30 的症状）
 *   · **绝不下潜超过 1 格**：`selfY - y > 1` 不选（`canDig=false`，下去就上不来）
 *
 * ⚠️ 为什么把 `blockAt` 做成**参数注入**而不是直接闭包引用 `bot`：
 *    这样这个函数仍是**纯函数**，`--selftest` 能用假世界喂它跑断言，
 *    不必连服务器。**P43 的教训就在"纯函数输入不足"** —— 但扩输入的正确
 *    做法是"多给一个参数"，不是"让它去读全局"。
 *
 * @param {number} dropY  物品报告的层（可小数，取 floor）
 * @param {number} selfY  她脚底所在层
 * @param {(x:number,y:number,z:number)=>?object} blockAt  读世界（返回 `{name}` 或 null）
 * @param {number} x      物品所在格
 * @param {number} z
 * @returns {number} 目标层的整数 y（保证 `y ≤ selfY` 且 `selfY - y ≤ 1`）
 */
function findStandY (dropY, selfY, blockAt, x, z) {
  const d = Math.floor(Number(dropY));
  const s = Math.floor(Number(selfY));
  if (!Number.isFinite(d) || !Number.isFinite(s)) return s;

  const standableAt = (yy) => {
    if (typeof blockAt !== 'function') return false;
    try {
      return isStandable(blockAt(x, yy, z)) && isStandable(blockAt(x, yy + 1, z));
    } catch (_) { return false; }
  };

  const cand = [];
  // ① 物品报告层是实心 → 物品的空间在它**上一层**（它躺在方块顶面上）
  let dropBlock = null;
  if (typeof blockAt === 'function') {
    try { dropBlock = blockAt(x, d, z); } catch (_) { dropBlock = null; }
  }
  if (dropBlock && !isStandable(dropBlock)) cand.push(d + 1);
  // ② 物品报告层本身；③ 下一层；④ 上一层
  cand.push(d, d - 1, d + 1);

  for (const yy of cand) {
    if (yy > s) continue;             // 绝不上天
    if (s - yy > 1) continue;         // 绝不下潜超过 1 格（canDig=false）
    if (standableAt(yy)) return yy;
  }
  // 一个可站层都找不到 → 退回旧逻辑（至少保证它落在硬约束内）
  const fallback = reachableStandY(dropY, selfY);
  return Math.min(fallback, s);
}

module.exports = { planPlacement, evaluateFace, bodyOccupies, eyeFrom, offsetLabel, AIRY, REACH, FACES, HALF_WIDTH, DEADLY, isStandable, reachableStandY, findStandY };

// ------------------------------------------------------------------ 自测

if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };

  // 用一个"世界"辅助：solid 是实心方块坐标的集合，其余是空气
  const world = (solidSet) => (pos) => {
    const k = `${pos.x},${pos.y},${pos.z}`;
    if (solidSet === 'all-air') return { name: 'air' };
    return solidSet.has(k) ? { name: 'stone' } : { name: 'air' };
  };

  console.log('\n条件④：自己的身体占着目标格');
  const T = { x: 0, y: 64, z: 0 };
  // 目标格占据 x∈[0,1) y∈[64,65) z∈[0,1)；身体是宽 0.6 高 1.8 的盒子
  check('站在目标格上 → 占着', bodyOccupies(T, { x: 0.2, y: 64, z: 0.1 }, 1.8), true);
  check('站在隔壁一格 → 不占', bodyOccupies(T, { x: 1.5, y: 64, z: 0.1 }, 1.8), false);
  check('在目标格正上方（脚在 y=65）→ 不占', bodyOccupies(T, { x: 0.2, y: 65, z: 0.1 }, 1.8), false);
  check('身体完全在格子 x 范围之外 → 不占', bodyOccupies(T, { x: 1.31, y: 64, z: 0.31 }, 1.8), false);
  check('坐标未知 → 不判占（交给后续步骤失败）', bodyOccupies(T, null, 1.8), false);

  // 六个邻居全是石头 —— 用来测"面都够得着但太远"这种纯距离问题
  const SIX = new Set(['0,63,0', '0,65,0', '-1,64,0', '1,64,0', '0,64,-1', '0,64,1']);
  // 站在目标格旁边（不在里面），距离正常
  const NEAR_FEET = { x: 1.5, y: 64, z: 0.5 };

  console.log('\n条件①：必须有实心参照块');
  check('四周全空气 → no-solid-neighbour',
    planPlacement({ target: T, getBlock: world('all-air'), feet: NEAR_FEET, height: 1.8 }).kind,
    'no-solid-neighbour');
  check('只有正下方是石头 → 可行，走 below 面',
    planPlacement({ target: T, getBlock: world(new Set(['0,63,0'])), feet: NEAR_FEET, height: 1.8 }).plan.label,
    'below');

  console.log('\n条件③：眼睛到接触点必须 < 4.5 格');
  check('六个面都在但站得太远 → too-far',
    planPlacement({ target: T, getBlock: world(SIX), feet: { x: 0, y: 70, z: 0 }, height: 1.8 }).kind,
    'too-far');
  const near = planPlacement({ target: T, getBlock: world(new Set(['0,63,0'])), feet: NEAR_FEET, height: 1.8 });
  check('站得够近 → 可行', near.ok, true);
  // eye=(1.5, 65.62, 0.5)，接触点=(0.5, 64, 0.5) → √(1+1.62²+0.25) ≈ 1.97
  check('距离算出来约 1.97', near.plan.distance >= 1.9 && near.plan.distance <= 2.1, true);
  check('距离是"眼睛到接触点"，不是"脚到方块中心"（后者会是 1.8）',
    near.plan.distance > 1.85, true);

  console.log('\n多个面都可用时的取舍');
  // 实现是**按固定顺序取第一个可用的面**（below → above → west → east → north → south），
  // 不是"挑最近的"。顺序固定是为了行为可预测 —— 同一个位置放两次，走同一个面。
  const two = planPlacement({
    target: T,
    getBlock: world(new Set(['0,63,0', '-1,64,0'])),
    feet: NEAR_FEET, height: 1.8,
  });
  check('below 与 west 都可用时，取顺序在前的 below', two.plan.label, 'below');
  check('同时把两个候选都交出去（方便逐个重试）', two.plans.length, 2);
  check('候选顺序稳定：below 在 west 之前', [two.plans[0].label, two.plans[1].label], ['below', 'west']);
  check('below 不可用时才轮到 west',
    planPlacement({
      target: T,
      getBlock: world(new Set(['-1,64,0'])),   // 只有西边是石头
      feet: NEAR_FEET, height: 1.8,
    }).plan.label,
    'west');

  console.log('\n条件④优先于其它条件');
  check('自己占着目标格时直接报 self-occupied（不再试面）',
    planPlacement({ target: T, getBlock: world(SIX), feet: { x: 0.2, y: 64, z: 0.2 }, height: 1.8 }).kind,
    'self-occupied');
  check('self-occupied 不返回 tried（没试过面）',
    planPlacement({ target: T, getBlock: world(SIX), feet: { x: 0.2, y: 64, z: 0.2 }, height: 1.8 }).tried.length,
    0);

  console.log('\n错误信息要能指导下一步动作');
  const far = planPlacement({ target: T, getBlock: world(SIX), feet: { x: 0, y: 70, z: 0 }, height: 1.8 });
  check('too-far 时每个面都说明了原因', far.tried.every(t => t.includes('too-far')), true);
  check('tried 里带面名', far.tried[0].startsWith('below:'), true);
  check('六个面都试过了', far.tried.length, 6);

  console.log('\n接触点算对了吗');
  // below 面的接触点应是参照块中心 (0,63,0)+0.5 + (0,1,0)*0.5 = (0.5, 64, 0.5)
  const below = planPlacement({ target: T, getBlock: world(new Set(['0,63,0'])), feet: NEAR_FEET, height: 1.8 });
  check('below 面接触点 = (0.5, 64, 0.5)',
    [below.plan.contact.x, below.plan.contact.y, below.plan.contact.z], [0.5, 64, 0.5]);
  // 反过来的 above 面：参照块 (0,65,0) 中心 + (0,-1,0)*0.5 = (0.5, 65, 0.5)
  const above = planPlacement({
    target: T,
    getBlock: world(new Set(['0,65,0'])),
    feet: { x: 1.5, y: 66, z: 0.5 }, height: 1.8,
  });
  check('above 面接触点 = (0.5, 65, 0.5)',
    [above.plan.contact.x, above.plan.contact.y, above.plan.contact.z], [0.5, 65, 0.5]);

  console.log('\n未知坐标（掉线）时的行为');
  check('没有脚的位置时不判自身占用，也不判距离（交给服务端）',
    planPlacement({ target: T, getBlock: world(new Set(['0,63,0'])), feet: null, height: 1.8 }).ok, true);

  console.log('\n站位（P43：物品报告的 y ≠ 目标站位层）');
  // ---------------------------------------------------------------------------
  // P43（2026-09-25）：`findStandY` —— "物品报告的 y" ≠ "目标站位层"
  // ---------------------------------------------------------------------------
  //
  // 【症状】物品报告 y=85，而 (-7,85,-8) = grass_block（实心）——
  //   物品是**躺在方块顶面上**的，它的空间在 y=86。旧代码 `reachableStandY(85,86)`
  //   返回 85 → `standable` 拦掉 → 退回 `GoalNear(球心 85)` → 球内含她自己
  //   → **一步不动**。她距物品只有 0.97 格，就是拿不到（"看得见摸不着"）。
  //
  // 【修法】`findStandY` 把候选层逐个**问世界**（注入 `blockAt`），
  //   找出脚+头都站得进去的那一层。硬约束不变：不上天、不下潜超 1 格。
  //
  // ⚠️ 自测里用**假世界**（Map）喂 `blockAt`，所以纯逻辑、不连服务器。
  const mkWorld = (spec) => (x, y, z) => {
    const n = spec[`${x},${y},${z}`];
    return n ? { name: n } : null;
  };

  // ★ 实机复现：物品报告 y=85 是实心，它的空间在 y=86
  //   ⚠️ 这个假世界必须让 **86 真的站得进去**：脚层 86 = air、头层 87 = **air**。
  //      我第一版把 87 写成 grass_block（那是"她头顶是草坪"的真地形），
  //      于是 86 被正确排除了 —— **是自测造错了世界，不是代码错**。
  const w1 = mkWorld({
    '-7,85,-8': 'grass_block', '-7,86,-8': 'air', '-7,87,-8': 'air',
  });
  check('★ P43：★ 实机复现 —— 物品报告 y=85 是**实心** → 目标层必须是 **86**（物品的空间），不是 85',
    findStandY(85, 86, w1, -7, -8), 86);
  check('★ P43：同一世界，她站在 y=87（在上一层）→ 仍应落在 86（不下潜超 1 格的边界内）',
    findStandY(85, 87, w1, -7, -8), 86);

  // ★ 目标格站不进去（头被堵）→ 不能选它
  //   ⚠️ 这正是**实机那片地形**：一条 1 格高的地道（y=87 整层实心）。
  const w2 = mkWorld({
    '-7,85,-8': 'grass_block', '-7,86,-8': 'air', '-7,87,-8': 'grass_block',
  });
  check('★ P43：★ 实机地形 —— 目标层 86 的**头层 87 是实心**（1 格高的地道）→ 站不进去，不许返回 86',
    findStandY(85, 86, w2, -7, -8) !== 86, true);

  // ★ 物品悬空在空气里（报告层本身可站）→ 就用那一层
  const w3 = mkWorld({
    '-3,60,-3': 'air', '-3,61,-3': 'air', '-3,59,-3': 'stone',
  });
  check('★ P43：物品**悬在空气格**里（报告层脚+头都可站）→ 直接用报告层',
    findStandY(60, 61, w3, -3, -3), 60);

  // ★ 硬约束：绝不上天
  const w4 = mkWorld({
    '-3,70,-3': 'air', '-3,71,-3': 'air',
  });
  check('★ P43：★ 硬约束 —— 物品在**上方**时**绝不上天**（返回她自己的层）',
    findStandY(70, 60, w4, -3, -3), 60);

  // ★ 硬约束：绝不下潜超过 1 格（canDig=false）
  const w5 = mkWorld({
    '-3,50,-3': 'air', '-3,51,-3': 'air',
    '-3,59,-3': 'air', '-3,60,-3': 'air',
  });
  check('★ P43：★ 硬约束 —— 物品在**很深**（9 格下）→ 最多下潜 1 格，绝不追下去',
    findStandY(50, 60, w5, -3, -3), 59);

  // ★ 找不到任何可站层 → 退回旧逻辑，且不破硬约束
  const w6 = mkWorld({ '-3,60,-3': 'stone', '-3,61,-3': 'stone' });
  check('★ P43：全是实心（一个可站层都没有）→ 退回旧逻辑，且**不破硬约束**',
    findStandY(59, 60, w6, -3, -3) <= 60, true);
  check('★ P43：`blockAt` 不是函数（离线/降级）→ 不崩，且不破硬约束',
    findStandY(85, 86, null, -7, -8) <= 86, true);
  check('★ P43：y 非法（NaN）→ 退回她自己那层，不崩',
    findStandY(NaN, 86, w1, -7, -8), 86);

  // ★ 不变量：返回值**永不高过** selfY（上天是 P30 的病）
  //   ⚠️ 每组的比较基准是**它自己的 selfY**，不能拿一个固定数比 ——
  //      我第一版写 `every(v => v <= 61)`，而第一组的 selfY 是 86，
  //      它返回 86 是**合法的**（不高过自己的 selfY），却把断言写红了。
  //      **这又是"心算一个固定阈值"的老毛病**（P42/P43 的教训同源）。
  const upCases = [
    [[findStandY(85, 86, w1, -7, -8)], 86],
    [[findStandY(70, 60, w4, -3, -3)], 60],   // 物品在上方 → 不上天
    [[findStandY(60, 61, w3, -3, -3)], 61],
  ];
  check('★ P43：★ 不变量 —— 返回值永不高过**自己的 selfY**（P30 的病就是"上天"）',
    upCases.every(([vs, s]) => vs.every(v => v <= s)), true);
  // ★ 不变量：返回值的下潜幅度**永不**超过 1 格
  const deepCases = [
    [findStandY(50, 60, w5, -3, -3), 60],
    [findStandY(85, 87, w1, -7, -8), 87],
    [findStandY(85, 86, w6, -7, -8), 86],
  ];
  check('★ P43：★ 不变量 —— 下潜幅度永不超过 1 格（`canDig=false`，下去就上不来）',
    deepCases.every(([v, s]) => s - v <= 1), true);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}
