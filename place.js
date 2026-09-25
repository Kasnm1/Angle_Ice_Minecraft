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

module.exports = { planPlacement, evaluateFace, bodyOccupies, eyeFrom, offsetLabel, AIRY, REACH, FACES, HALF_WIDTH };

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

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}
