'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「movement」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3

// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleep } = require('../util/time');
const __ns = {};
let REACH;   // 常量：load 完成后由 bind() 回填
function airish (...a) { return __ns.airish.apply(null, a); }
function approach (...a) { return __ns.approach.apply(null, a); }
function commandWords (...a) { return __ns.commandWords.apply(null, a); }
function doorBase (...a) { return __ns.doorBase.apply(null, a); }
function doorKey (...a) { return __ns.doorKey.apply(null, a); }
function doorKind (...a) { return __ns.doorKind.apply(null, a); }
function ensureFiller (...a) { return __ns.ensureFiller.apply(null, a); }
function eyeDist (...a) { return __ns.eyeDist.apply(null, a); }
function give (...a) { return __ns.give.apply(null, a); }
function inHomeArea (...a) { return __ns.inHomeArea.apply(null, a); }
function isDoorLike (...a) { return __ns.isDoorLike.apply(null, a); }
function isOpen (...a) { return __ns.isOpen.apply(null, a); }
function lightUp (...a) { return __ns.lightUp.apply(null, a); }
function passable (...a) { return __ns.passable.apply(null, a); }
function placeFiller (...a) { return __ns.placeFiller.apply(null, a); }
function solidUnder (...a) { return __ns.solidUnder.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); REACH = ns.REACH; }

function installDoorHabit (bot, state) {
  if (typeof bot.activateBlock !== 'function' || bot.__doorHabit) return;
  bot.__doorHabit = true;
  state.doorsIOpened = new Map();   // key → {pos, name, openedAt}
  state.doorActivations = new Map(); // 同一扇门的右键串行化，避免两条路线同时切换两次
  state.doorsLeftOpen = state.doorsLeftOpen || [];   // 走远了没来得及关的
  const orig = bot.activateBlock.bind(bot);
  bot.activateBlock = async (block, ...rest) => {
    let base = block && doorBase(bot, block.position);
    if (!base || !isDoorLike(base)) return orig(block, ...rest);

    const pos = base.position.clone();
    const key = doorKey(pos);
    const wantsOpen = !state.__closingDoor;
    const pending = state.doorActivations.get(key);
    if (pending) await pending.catch(() => {});

    // 规划时可能还是关着的，走到门前时已经被上一条路线打开了。
    // 必须以右键前这一刻的世界状态为准；否则右键会把开门变成关门，下一轮又打开。
    base = doorBase(bot, pos);
    if (!base || !isDoorLike(base)) return orig(block, ...rest);
    const openNow = isOpen(base);
    if (openNow === wantsOpen) {
      state.doorStateSkips = (state.doorStateSkips || 0) + 1;
      state.lastDoorSkipped = { pos: key, name: base.name, open: openNow, wanted: wantsOpen, at: Date.now() };
      return { skipped: true, reason: openNow ? '门已经开着' : '门已经关着' };
    }

    let release;
    const lock = new Promise(resolve => { release = resolve; });
    state.doorActivations.set(key, lock);
    const wasAt = bot.entity?.position?.clone?.();
    try {
      const r = await orig(base, ...rest);
      if (wantsOpen) {
        await sleep(250);
        const now = doorBase(bot, pos);
        if (now && isDoorLike(now) && isOpen(now)) {
          state.doorsIOpened.set(key, { pos, name: now.name, openedAt: Date.now(), wasAt: wasAt || bot.entity.position.clone() });
        }
      }
      return r;
    } finally {
      release();
      if (state.doorActivations.get(key) === lock) state.doorActivations.delete(key);
    }
  };

  // 每 300ms 看一眼：自己开的门，人已经过去了（离开门那格 1.5 格以上）就关上
  setInterval(async () => {
    if (!bot.entity || state.__closingDoor || !state.doorsIOpened.size) return;
    for (const [k, d] of state.doorsIOpened) {
      const b = bot.blockAt(d.pos);
      if (!b || !isDoorLike(b) || !isOpen(b)) { state.doorsIOpened.delete(k); continue; }   // 已经关了（别人关的也算）
      const center = d.pos.offset(0.5, 0.5, 0.5);
      const dist = bot.entity.position.offset(0, 1.62, 0).distanceTo(center);
      const inside = Math.floor(bot.entity.position.x) === d.pos.x && Math.floor(bot.entity.position.z) === d.pos.z
        && Math.abs(bot.entity.position.y - d.pos.y) < 2;
      const young = Date.now() - d.openedAt < 1500;
      if (inside || young) continue;
      // 还站在开门时的位置附近（开了门还没走过去）：别急着关
      if (bot.entity.position.distanceTo(d.wasAt) < 0.8 && Date.now() - d.openedAt < 20000) continue;
      if (dist > 4.4) {
        state.doorsIOpened.delete(k);
        state.doorsLeftOpen.push({ pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, name: d.name, at: Date.now() });
        continue;
      }
      if (dist < 1.3) continue;   // 还贴着门：再走一步
      state.__closingDoor = true;
      try {
        await bot.lookAt(center, true);
        await orig(b);
        await sleep(250);
        const after = bot.blockAt(d.pos);
        if (after && !isOpen(after)) { state.doorsIOpened.delete(k); state.lastDoorClosed = { pos: doorKey(d.pos), name: d.name, at: Date.now() }; }
      } catch (_) { /* 下一轮再试 */ } finally { state.__closingDoor = false; }
    }
  }, 300);
}

function doorsNear (bot, radius = 8) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => /door|gate|trapdoor|hatch/.test(b.name)).map(b => b.id);
  const out = [];
  for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })) {
    const b = doorBase(bot, p);
    if (!b || !isDoorLike(b)) continue;
    const k = doorKey(b.position);
    if (out.some(o => o.key === k)) continue;
    out.push({ key: k, x: b.position.x, y: b.position.y, z: b.position.z, name: b.name, kind: doorKind(b), open: isOpen(b), distance: +bot.entity.position.distanceTo(b.position.offset(0.5, 0, 0.5)).toFixed(1) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

async function setDoor (bot, state, { x, y, z, open }) {
  if ([x, y, z].some(v => v == null) || typeof open !== 'boolean') throw new Error('要给 x y z 和 open(true/false)');
  let b = doorBase(bot, new Vec3(x, y, z));
  if (!b || !isDoorLike(b)) throw new Error(`(${x},${y},${z}) 不是门/栅栏门/活板门（是 ${b?.name || '空'}）`);
  if (isOpen(b) === open) return { already: true, open, name: b.name };
  await approach(bot, b);
  state.__closingDoor = !open;    // 主动关门：别让"随手关门"的习惯再记一笔
  try {
    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(b);
    await sleep(300);
  } finally { state.__closingDoor = false; }
  const pos0 = b.position;
  b = doorBase(bot, pos0);
  if (!b || !isDoorLike(b)) throw new Error(`右键之后 (${pos0.x},${pos0.y},${pos0.z}) 读不到门了（是 ${b?.name || '读不到'}）`);
  if (isOpen(b) !== open) throw new Error(`右键了，但${doorKind(b)}还是${isOpen(b) ? '开' : '关'}着（可能是铁门，要红石）`);
  if (!open) state.doorsIOpened?.delete(doorKey(b.position));
  // 主动打开的门：也按习惯，走过去会随手关（除非她明说要一直开着 —— 那就用 keepOpen）
  return { done: true, open, name: b.name };
}

function ladderColumns (bot, maxDistance = 16) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => /ladder|vine|scaffolding/.test(b.name)).map(b => b.id);
  const pts = bot.findBlocks({ matching: ids, maxDistance, count: 400 });
  const cols = new Map();
  for (const p of pts) {
    const k = `${p.x},${p.z}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(p.y);
  }
  const out = [];
  for (const [k, ys] of cols) {
    const [x, z] = k.split(',').map(Number);
    ys.sort((a, b) => a - b);
    // 连续的一段算一架梯子
    let start = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i === ys.length || ys[i] !== ys[i - 1] + 1) { out.push({ x, z, bottom: start, top: ys[i - 1] }); start = ys[i]; }
    }
  }
  return out;
}

function ladderBottomReachable (col, feetY) {
  return Math.abs(col.bottom - Math.floor(feetY)) <= 2.5;
}

/**
 * 爬到梯子顶以后，从梯子格**迈出去**该踩哪一格。
 *
 * 纯函数（自测直接驱动，不用真游戏）：给定梯子顶那一格的方块（为了读 `facing`）和
 * `blockAt(x,y,z)` 读方块，返回**按优先级排好的可站格**。
 *
 * 为什么先看 facing：梯子是贴在墙上的一片薄板，`facing` 是它**背对墙**的方向，
 * 所以有楼板的那一侧在 **-facing**（梯子正对的那面墙那侧）—— 先往那边迈，命中率最高。
 * 读不到 `facing` 就四个方向都试（任务书给的兜底）。
 *
 * 层高怎么选：先试**梯子顶那一层**（脚踩 top）—— 敞开的阁楼/二层就是这种，人挂在梯子顶
 * 往旁边一迈就上去了；没有才试 `top+1`（活板门那层地板，即梯子穿过的楼板）；再没有才试 `top+2`。
 *
 * ⚠️ 旧版是 `top+2 → top+1 → top` 这个顺序，而且要求先爬到 top+1 才肯迈。
 * 实机 `爬到 y=128.2 就上不去了（梯子顶是 128）`：梯子顶 128、上面全空 → 非要爬到 129，
 * 但梯子到 128 就没了，永远到不了，连迈的机会都没有（2026-09-28 修）。
 */
function ladderExitTargets (ladderTopBlock, col, blockAt) {
  const FACE_BACK = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] };   // facing 的反方向
  const back = FACE_BACK[String(ladderTopBlock?.getProperties?.().facing || '').toLowerCase()];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const order = back ? [back, ...dirs.filter(([dx, dz]) => dx !== back[0] || dz !== back[1])] : dirs;
  const usable = (c) => {
    const under = blockAt(c.x, c.y - 1, c.z);
    const feet = blockAt(c.x, c.y, c.z);
    const head = blockAt(c.x, c.y + 1, c.z);
    return solidUnder(under) && passable(feet) && passable(head);
  };
  const at = (y) => order.map(([dx, dz]) => ({ x: col.x + dx, z: col.z + dz, y })).filter(usable);
  for (const y of [col.top, col.top + 1, col.top + 2]) {
    const hit = at(y);
    if (hit.length) return hit;
  }
  return [];
}

async function holdControls (bot, controls, ms) {
  for (const c of controls) bot.setControlState(c, true);
  await sleep(ms);
  bot.clearControlStates();
  await sleep(60);
}

async function stepInto (bot, x, y, z) {
  const { goals } = require('mineflayer-pathfinder');
  const inCell = () => { const p = bot.entity.position; return Math.floor(p.x) === x && Math.floor(p.z) === z && Math.abs(p.y - y) < 1.2; };
  if (!inCell()) {
    try {
      await Promise.race([bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)), sleep(20000).then(() => { throw new Error('超时'); })]);
    } catch (_) { bot.pathfinder.setGoal(null); }
  }
  for (let i = 0; i < 8 && !inCell(); i++) {
    await bot.lookAt(new Vec3(x + 0.5, bot.entity.position.y + 1.6, z + 0.5), true);
    await holdControls(bot, i % 3 === 2 ? ['forward', 'jump'] : ['forward'], 250);   // 隔几下跳一跳，别只是往墙上顶
    if (i === 4 && !inCell()) await wiggle(bot, { rounds: 1 }).catch(() => {});
  }
  return inCell();
}

async function climbColumn (bot, state, col) {
  const log = [];
  // 头顶（梯子顶上一格）是关着的活板门：先推开
  const hatchPos = new Vec3(col.x, col.top + 1, col.z);
  const hatch = bot.blockAt(hatchPos);
  if (hatch && /trapdoor/.test(hatch.name) && !isOpen(hatch)) {
    log.push(`梯子顶上的活板门关着`);
    // 站在梯子里、够得着的时候再开（先爬到接近顶）
  }
  const onThisLadder = () => { const p = bot.entity.position; return Math.floor(p.x) === col.x && Math.floor(p.z) === col.z && p.y >= col.bottom - 0.2 && p.y <= col.top + 1; };
  if (!onThisLadder()) {
    if (!await stepInto(bot, col.x, col.bottom, col.z)) throw new Error(`走不进梯子 (${col.x},${col.bottom},${col.z})`);
    log.push(`站进了梯子 (${col.x},${col.bottom},${col.z})`);
  } else log.push(`就在梯子上 (y=${bot.entity.position.y.toFixed(1)})，接着爬`);

  // 对准：人爬梯子是贴着梯子、面朝墙按住"前进"。梯子的 facing 是它背对墙的方向，墙在 -facing 那边
  const FACE = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
  const lad = bot.blockAt(new Vec3(col.x, Math.max(col.bottom, Math.min(col.top, Math.floor(bot.entity.position.y))), col.z));
  const [fx, fz] = FACE[String(lad?.getProperties?.().facing || '').toLowerCase()] || [0, 0];
  const spot = { x: col.x + 0.5 - fx * 0.18, z: col.z + 0.5 - fz * 0.18 };
  const wall = new Vec3(col.x + 0.5 - fx * 3, 0, col.z + 0.5 - fz * 3);
  const aligned = () => Math.hypot(bot.entity.position.x - spot.x, bot.entity.position.z - spot.z) <= 0.2;
  const align = async () => {
    if (aligned()) return;
    const r = await nudge(bot, { x: spot.x, z: spot.z, tol: 0.12, maxSteps: 12 });
    log.push(r.reached ? `对准了梯子（误差 ${r.error}）` : `对得不太准（差 ${r.error}）`);
  };
  await align();

  // 往上爬到梯子顶那一格的上面（出口层）。
  // 梯子顶上头顶空间不够时（2026-09-27 她家：梯子顶 128、129 空、130 是屋顶楼梯块）人最高只能到 128.2，
  // 从侧面迈到阁楼上 —— 以前硬要爬到 129，每次都报"上不去"，她在梯子上来回跳
  let ceil = null;
  for (let y = col.top + 1; y <= col.top + 3 && ceil == null; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && !passable(b) && !/trapdoor/.test(b.name)) ceil = y; }
  const exitFeetY = ceil != null ? Math.min(col.top + 1, ceil - 1.8) : col.top + 1;
  const deadline = Date.now() + 4000 + (col.top - col.bottom + 2) * 900;
  let stalled = 0; let lastY = bot.entity.position.y; let opened = false;
  while (Date.now() < deadline && bot.entity.position.y < exitFeetY - 0.25) {
    const h0 = bot.blockAt(hatchPos);
    if (!opened && h0 && /trapdoor/.test(h0.name) && !isOpen(h0) && eyeDist(bot, h0) <= REACH) {
      await bot.lookAt(hatchPos.offset(0.5, 0.2, 0.5), true);
      await bot.activateBlock(h0, new Vec3(0, -1, 0), new Vec3(0.5, 0, 0.5));
      await sleep(300);
      opened = true; log.push('推开了头顶的活板门');
    }
    // 面朝墙按住前进+跳（没有朝向信息的梯子就看向格子中间）
    await bot.lookAt(fx || fz ? wall.offset(0, bot.entity.position.y + 1.6, 0) : new Vec3(col.x + 0.5, bot.entity.position.y + 1.6, col.z + 0.5), true);
    await holdControls(bot, fx || fz ? ['forward', 'jump'] : ['jump'], 400);
    // 爬着爬着偏出梯子格了：停下重新对准（蹲着挪，挂在梯子上也不会掉）
    { const p = bot.entity.position; if (Math.floor(p.x) !== col.x || Math.floor(p.z) !== col.z) { await align(); } }
    const y = bot.entity.position.y;
    if (y - lastY < 0.05) stalled++; else stalled = 0;
    lastY = y;
    if (stalled === 3 && !state.__climbWiggled) {
      state.__climbWiggled = true;
      await holdControls(bot, ['jump'], 300); await align();          // 跳一下、重新贴好梯子再爬
      stalled = 0; continue;
    }
    if (stalled >= 3) {
      state.__climbWiggled = false;
      const h = bot.blockAt(hatchPos);
      if (!opened && h && /trapdoor/.test(h.name) && !isOpen(h)) {
        await bot.activateBlock(h, new Vec3(0, -1, 0), new Vec3(0.5, 0, 0.5));
        await sleep(300);
        opened = true; stalled = 0; log.push('推开了头顶的活板门');
        continue;
      }
      break;
    }
  }
  const topY = bot.entity.position.y;
  // ⚠️ 别在这里就判死（2026-09-28 修）。旧实机日志：`爬到 y=128.2 就上不去了（梯子顶是 128）`×4
  // —— 梯子顶 128、上面 129/130/131 全空（敞开的阁楼），所以 `ceil=null` → `exitFeetY=129`，
  // 于是要求爬到 129；可梯子到 128 就没了，人最高只能挂到 128.2，**永远到不了 129**，
  // 结果连"往旁边迈上楼板"都没试就抛错了。现在：到没到 exitFeetY 都往下走去迈楼板，
  // 只在**离梯子顶还差得远**（连顶都没够着）时才报错。
  if (topY < col.top - 0.6) throw new Error(`爬到 y=${topY.toFixed(1)} 就上不去了（梯子顶是 ${col.top}）`);
  log.push(`爬到了 y=${topY.toFixed(1)}${topY < exitFeetY - 0.6 ? '（上方够不着了，改从侧面迈出去）' : ''}`);

  // 迈出去：找梯子顶旁边能站的格子。挑哪一格 = ladderExitTargets（纯函数，自测直接驱动它）。
  const ladderTop = bot.blockAt(new Vec3(col.x, col.top, col.z));
  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const cands = ladderExitTargets(ladderTop, col, blockAt);
  if (!cands.length) throw new Error(`爬到顶了，但梯子顶 (${col.x},${col.top},${col.z}) 旁边没有能站的地方`);
  log.push(`出口候选：${cands.map(c => `(${c.x},${c.y},${c.z})`).join(' ')}`);
  for (const c of cands) {
    for (let i = 0; i < 6; i++) {
      await bot.lookAt(new Vec3(c.x + 0.5, c.y + 1.6, c.z + 0.5), true);
      await holdControls(bot, ['forward', 'jump'], 350);
      const p = bot.entity.position;
      if (Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y >= c.y - 0.3) {
        await holdControls(bot, ['forward'], 150);   // 再往里走一点，别站在边上又滑回梯子
        log.push(`迈到了 (${c.x},${c.y},${c.z})`);
        return { ok: true, at: { x: c.x, y: c.y, z: c.z }, log };
      }
    }
  }
  throw new Error(`爬到顶了，但迈不出去（试了 ${cands.length} 个方向）`);
}

async function climbUp (bot, state, { targetY, maxLadders = 4 } = {}) {
  const startY = bot.entity.position.y;
  const goal = targetY != null ? +targetY : null;
  const done = []; const used = new Set();
  for (let n = 0; n < maxLadders; n++) {
    const feet = bot.entity.position;
    if (goal != null && feet.y >= goal - 0.5) break;
    // 能从这层走过去的、往上的梯子：底部在脚下附近，顶部比现在高
    const cols = ladderColumns(bot, 16)
      // 梯子最低一格可能装在腰/头顶高度（现场：脚 y=121、梯子 bottom=123）。
      // stepInto 会用寻路 + 跳跃核对是否真能进去；这里先给它尝试机会，别在候选阶段误删。
      .filter(c => !used.has(`${c.x},${c.z},${c.bottom}`) && c.top >= feet.y && ladderBottomReachable(c, feet.y))
      .sort((a, b) => Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z) - Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z));
    if (!cols.length) {
      if (!done.length) throw new Error('附近 16 格内没有从这层往上的梯子');
      break;
    }
    // 最近的那架走不进去（比如厨房里那架）：换下一架试，别直接放弃
    let r = null; let col = null; const errs = [];
    for (const c of cols.slice(0, 4)) {
      used.add(`${c.x},${c.z},${c.bottom}`);
      try { r = await climbColumn(bot, state, c); col = c; break; } catch (e) { errs.push(`(${c.x},${c.z})：${e.message}`); }
    }
    if (!r) { if (!done.length) throw new Error(`附近的梯子都上不去：${errs.join('；')}`); break; }
    done.push({ ladder: `(${col.x},${col.bottom}~${col.top},${col.z})`, landed: r.at, steps: r.log });
    if (goal == null) break;   // 没给目标高度：爬一段就停
  }
  const endY = bot.entity.position.y;
  return { fromY: +startY.toFixed(1), toY: +endY.toFixed(1), ladders: done, reachedTarget: goal == null ? null : endY >= goal - 0.5 };
}

/**
 * 从楼上顺着梯子下去：走到梯子口（地板上那个洞 / 活板门）→ 门关着就推开 →
 * 走进洞口正上方 → 松开所有键，顺着梯子滑下去 → 到底。还没到想去的高度就找下一段。
 * 她自己推开的活板门，走开后"随手关门"的习惯会关回去。
 */
async function climbColumnDown (bot, state, col) {
  const log = [];
  const holeY = col.top + 1;              // 梯子顶上一格：地板上的洞口 / 活板门
  const hatch = bot.blockAt(new Vec3(col.x, holeY, col.z));
  if (hatch && isDoorLike(hatch) && !isOpen(hatch)) {
    await approach(bot, hatch);
    await bot.lookAt(hatch.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(hatch);       // 走 activateBlock → 习惯会记住"这是她开的"
    await sleep(300);
    if (!isOpen(bot.blockAt(hatch.position))) throw new Error(`梯子口的活板门推不开 (${col.x},${holeY},${col.z})`);
    log.push('推开了梯子口的活板门');
  }
  // 先站到洞口旁边
  const { goals } = require('mineflayer-pathfinder');
  const feet = bot.entity.position;
  if (Math.hypot(feet.x - (col.x + 0.5), feet.z - (col.z + 0.5)) > 1.6) {
    try {
      await Promise.race([bot.pathfinder.goto(new goals.GoalNear(col.x, holeY + 1, col.z, 1)), sleep(20000).then(() => { throw new Error('超时'); })]);
    } catch (_) { bot.pathfinder.setGoal(null); }
  }
  // 梯子是贴在墙上的一片薄板（facing = 背对墙的方向）。站在洞口正中会踩在薄板上缘掉不下去（实测停在 y=73.0），
  // 人会自然地站到离墙远的那一侧 —— 往 facing 方向偏 0.3 格
  const FACE = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
  const topLadder = bot.blockAt(new Vec3(col.x, col.top, col.z));
  const [fx, fz] = FACE[String(topLadder?.getProperties?.().facing || '').toLowerCase()] || [0, 0];
  const aim = (y) => new Vec3(col.x + 0.5 + fx * 0.3, y, col.z + 0.5 + fz * 0.3);
  // 走进洞口上方，然后松手往下滑
  const startY = bot.entity.position.y;
  for (let i = 0; i < 10; i++) {
    const p = bot.entity.position;
    if (Math.floor(p.x) === col.x && Math.floor(p.z) === col.z && (fx === 0 || Math.sign(p.x - col.x - 0.5) === fx) && (fz === 0 || Math.sign(p.z - col.z - 0.5) === fz)) break;
    if (p.y < startY - 0.8) break;        // 已经掉进去了
    await bot.lookAt(aim(p.y + 1.2), true);
    await holdControls(bot, ['forward'], 150);
  }
  const p0 = bot.entity.position;
  if (!(Math.floor(p0.x) === col.x && Math.floor(p0.z) === col.z) && p0.y > startY - 0.8) throw new Error(`走不到梯子口上方 (${col.x},${holeY},${col.z})`);
  log.push(`到了梯子口 (${col.x},${holeY},${col.z})`);
  const deadline = Date.now() + 3000 + (col.top - col.bottom + 2) * 1200;
  let still = 0; let lastY = bot.entity.position.y; let nudges = 0;
  while (Date.now() < deadline) {
    await sleep(300);
    const y = bot.entity.position.y;
    if (y <= col.bottom + 0.1) break;
    if (Math.abs(y - lastY) < 0.02) {
      still++;
      // 还卡在上面（踩在梯子薄板或开着的活板门边上）：离墙那侧、正中、四个方向轮着试，直到身体掉进梯子格
      if (still >= 2 && nudges < 10 && y > col.top + 0.5) {
        const tries = [[fx * 0.3, fz * 0.3], [0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]];
        const [ox, oz] = tries[nudges % tries.length];
        nudges++; still = 0;
        await bot.lookAt(new Vec3(col.x + 0.5 + ox, y + 1.2, col.z + 0.5 + oz), true);
        await holdControls(bot, ['forward'], 110);
      } else if (still >= 4) break;
    } else still = 0;
    lastY = y;
  }
  const endY = bot.entity.position.y;
  if (endY > col.bottom + 1.2) throw new Error(`滑到 y=${endY.toFixed(1)} 就停住了（梯子底是 ${col.bottom}）`);
  log.push(`滑到了 y=${endY.toFixed(1)}`);
  // 到底了往旁边迈一步离开梯子格，免得挡路
  return { ok: true, at: { x: Math.floor(bot.entity.position.x), y: Math.round(endY), z: Math.floor(bot.entity.position.z) }, log };
}

async function climbDown (bot, state, { targetY, maxLadders = 4 } = {}) {
  const startY = bot.entity.position.y;
  const pre = await offLadder(bot, state, targetY ?? startY - 5).catch(() => null);
  const goal = targetY != null ? +targetY : null;
  const done = []; const used = new Set();
  for (let n = 0; n < maxLadders; n++) {
    const feet = bot.entity.position;
    if (goal != null && feet.y <= goal + 0.5) break;
    // 从这层能下去的梯子：梯子顶上一格（洞口）就在脚下这层地板里
    const cols = ladderColumns(bot, 16)
      .filter(c => !used.has(`${c.x},${c.z},${c.top}`) && Math.abs((c.top + 2) - Math.floor(feet.y + 0.01)) <= 1 && c.bottom < feet.y - 1)
      .sort((a, b) => Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z) - Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z));
    if (!cols.length) {
      if (!done.length && !pre) throw new Error('附近 16 格内没有从这层往下的梯子');
      break;
    }
    const col = cols[0];
    used.add(`${col.x},${col.z},${col.top}`);
    const r = await climbColumnDown(bot, state, col);
    done.push({ ladder: `(${col.x},${col.bottom}~${col.top},${col.z})`, landed: r.at, steps: r.log });
    if (goal == null) break;
  }
  const endY = bot.entity.position.y;
  return { fromY: +startY.toFixed(1), toY: +endY.toFixed(1), ladders: done, reachedTarget: goal == null ? null : endY <= goal + 0.5, ...(pre ? { firstly: pre } : {}) };
}

/**
 * 以前的 /move 要求"脚正好站进目标那一格"：目标是箱子（实心）、站不进去的格子 → 必定 No path；
 * 寻路器又不开门、不爬梯子，碰到就放弃。实测她找箱子连着 5 次 "No path found"。
 *
 * 这里按真人的办法一样样试：
 *   ① 目标在楼上/楼下（差 3 格以上）→ 先爬梯子
 *   ② 走到目标**旁边**（range 格以内），不是非要站在上面
 *   ③ 路被关着的门挡住 → 开往目标那边的门再走（走过去后"随手关门"的习惯会关回去）
 *   ④ 放宽"旁边"的范围，尽量靠近；再不行先朝目标走一段，换个位置重新找路
 *   ⑤ 到不了：如实报还差多远、试过什么，附上周围地形，让她自己想办法（motor）
 */
async function pathTo (bot, pos, range, ms, { retry = true } = {}) {
  const { goals } = require('mineflayer-pathfinder');
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)),
      sleep(ms).then(() => { throw new Error('走太久了'); }),
    ]);
    return null;
  } catch (e) {
    bot.pathfinder.setGoal(null);
    // 门口失败时别原地蹦跳：门应由寻路器的开门动作处理，跳跃只会撞门框。
    const nearDoor = bot.registry?.blocksByName && doorsNear(bot, 3).some(d =>
      Math.abs(d.y - Math.floor(bot.entity.position.y)) <= 1);
    if (retry && !nearDoor) {
      const w = await wiggle(bot, { rounds: 1 }).catch(() => null);
      if (w?.freed) return pathTo(bot, pos, range, ms, { retry: false });
    }
    return e.message || String(e);
  }
}

async function pathToKeepingFloor (bot, pos, range, ms, minFeetY) {
  const mv = bot.pathfinder?.movements;
  if (!mv?.exclusionAreasStep || !Number.isFinite(minFeetY)) return pathTo(bot, pos, range, ms, { retry: false });
  const floorGuard = block => block?.position?.y < minFeetY ? 100 : 0;
  mv.exclusionAreasStep.push(floorGuard);
  try {
    return await pathTo(bot, pos, range, ms, { retry: false });
  } finally {
    const i = mv.exclusionAreasStep.indexOf(floorGuard);
    if (i !== -1) mv.exclusionAreasStep.splice(i, 1);
  }
}

/**
 * 挂在梯子中间（实测停在 y=71，二楼和三楼之间）：寻路器、下楼、上楼都要求站在地板上，于是全部失败 → 看起来就是"莫名卡住"。
 * 目标在下面：松手滑下去；在上面：从这里接着爬到顶、迈出去。
 */
async function offLadder (bot, state, targetY) {
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  if (!here || !/ladder|vine|scaffolding/.test(here.name)) return null;
  const col = ladderColumns(bot, 3).find(c => c.x === feet.x && c.z === feet.z && feet.y >= c.bottom - 1 && feet.y <= c.top + 1);
  if (!col) return null;
  if (targetY != null && targetY < bot.entity.position.y - 1) {
    const deadline = Date.now() + 2000 + (feet.y - col.bottom + 1) * 800;
    let last = bot.entity.position.y; let still = 0;
    bot.clearControlStates();
    while (Date.now() < deadline && bot.entity.position.y > col.bottom + 0.1) {
      await sleep(250);
      if (Math.abs(bot.entity.position.y - last) < 0.02) { if (++still >= 4) break; } else still = 0;
      last = bot.entity.position.y;
    }
    return `从梯子上滑下来了（y=${bot.entity.position.y.toFixed(1)}）`;
  }
  const r = await climbColumn(bot, state, col);
  return `从梯子上爬上去、迈到了 (${r.at.x},${r.at.y},${r.at.z})`;
}

/**
 * 跟着一个玩家。
 *
 * 原来只是 GoalFollow（按直线距离追）：玩家上了楼，她就跑到玩家**正下方**站着 ——
 * 水平距离对上了，高度差 5 格，寻路器不会从梯子上楼，于是一直在一楼（玩家指出）。
 * 真人跟人是先上同一层楼，再往他身边走。所以：
 *   · 高度差 ≥ 2.5 格（不在同一层）：走带梯子和门的路线（go()）到他那一层
 *   · 同一层：交给 GoalFollow 贴着走
 * 每秒看一次；停止（/stop 清掉 currentAction）或换了跟随对象就退出。
 *
 * ⚠️ 退出这件事有三条路，缺一条就会"看起来还在跟，其实早就跟丢了"：
 *   ① `/stop` / 别的动作改了 `currentAction` → `alive()` 变 false
 *   ② 换了跟随对象 → `followSeq` 变了 → 旧循环退出（新旧两个循环同时驱动寻路器会打架）
 *   ③ 玩家下线 / 走出视野 → `bot.players[name]` 会被 mineflayer **整个删掉**，
 *      `?.entity` 恒为 undefined → 旧写法只会每秒空转、永远不退（`/status` 一直显示在跟随）。
 * 另外：**循环体抛错不能被最外层 `.catch(() => {})` 静默吞掉** —— 吞掉之后循环直接结束，
 * 外面完全看不出来（只有 /debug/follow 里的 lastFollowRoute 停在旧时间戳）。所以内层要 try。
 */
function startFollow (bot, state, playerName, dist = 2, opts = {}) {
  const tag = `following ${playerName}`;
  const id = (state.followSeq = (state.followSeq || 0) + 1);
  state.currentAction = tag;
  // 两个节奏值集中在这里（"同一判据只写一处"）。自测会把它们调小，跑真代码但不用等 15 秒。
  const tickMs = opts.tickMs || FOLLOW_TICK_MS;
  const lostMs = opts.lostMs || FOLLOW_LOST_MS;
  const { goals } = require('mineflayer-pathfinder');
  const alive = () => state.followSeq === id && state.currentAction === tag;
  const setFollow = (e) => { if (!(bot.pathfinder.goal instanceof goals.GoalFollow) || bot.pathfinder.goal.entity !== e) bot.pathfinder.setGoal(new goals.GoalFollow(e, dist), true); };
  // 退出时清掉**我们这一轮**留下的 GoalFollow。
  // 两道闸：① `followSeq` 变了说明换了跟随对象 —— 新循环的 goal 不归我们管；
  //        ② 只清 GoalFollow —— 别的动作（`/move` 的 GoalNear…）刚设的 goal 不能动，
  //           否则跟随循环晚一秒醒来会把那条路线清掉，看起来就是"/move 没反应"。
  const dropGoal = () => {
    if (state.followSeq !== id) return;
    try {
      if (bot.pathfinder.goal instanceof goals.GoalFollow) bot.pathfinder.setGoal(null);
    } catch (_) { /* 断线时 pathfinder 可能整个没了 */ }
  };
  (async () => {
    let routing = false;
    let lostSince = 0;
    try {
      while (alive()) {
        const e = bot.players[playerName]?.entity;
        if (!e) {
          // 看不见人：可能只是走远了，也可能下线了（后者 mineflayer 会删掉 bot.players[name]）。
          // 给一段缓冲，还看不见就退出并如实记下原因 —— 不能每秒空转到天荒地老。
          if (!lostSince) lostSince = Date.now();
          if (Date.now() - lostSince >= lostMs) {
            state.lastFollowStop = { at: Date.now(), reason: `看不见 ${playerName}（下线或走远了）` };
            break;
          }
        } else {
          lostSince = 0;
          if (!routing) {
            const dy = e.position.y - bot.entity.position.y;
            if (Math.abs(dy) >= 2.5) {
              routing = true;
              bot.pathfinder.setGoal(null);
              try {
                const r = await go(bot, state, { player: playerName, range: dist, maxMs: 45000, abort: () => !alive() });
                state.lastFollowRoute = { at: Date.now(), dy: +dy.toFixed(1), arrived: r.arrived, tried: (r.tried || []).slice(-4) };
              } catch (err) {
                // 被叫停不算错：`/stop`、换跟随对象都会走到这里
                state.lastFollowRoute = { at: Date.now(), dy: +dy.toFixed(1), ...(err.aborted ? { aborted: true } : { error: err.message }) };
              }
              routing = false;
              if (!alive()) break;   // 路上被叫停了（/stop 清掉了 currentAction）或换了跟随对象
            } else setFollow(e);
          }
        }
        await sleep(tickMs);
      }
    } catch (err) {
      // 循环体抛错：记下来（/debug/follow 看得见），别让它静默结束
      state.lastFollowStop = { at: Date.now(), reason: `跟随循环出错：${err.message}` };
    } finally {
      routing = false;
      dropGoal();
    }
  })().catch(err => {
    // 兜底：内层 try 没拦住的（比如 finally 里的 dropGoal 又抛了）也不能静默消失。
    // 旧写法是 `.catch(() => {})` —— 循环一死外面完全看不出来。
    state.lastFollowStop = { at: Date.now(), reason: `跟随循环兜底捕获：${err.message}` };
  });
  return { following: playerName };
}

/**
 * 卡住的时候像真人一样：跳一跳，前后左右晃一晃 —— 很多时候就出来了，不用马上换办法或放弃。
 * 往哪个方向晃之前先看一眼：那边是岩浆、或者脚下是 3 格以上的空（会摔），就不往那边晃。
 */
function safeToward (bot, yaw) {
  const p = bot.entity.position;
  const dx = -Math.sin(yaw); const dz = -Math.cos(yaw);
  const nx = Math.floor(p.x + dx * 0.9); const nz = Math.floor(p.z + dz * 0.9); const y = Math.floor(p.y);
  for (let k = 0; k <= 1; k++) { const b = bot.blockAt(new Vec3(nx, y + k, nz)); if (b && /lava|fire/.test(b.name)) return false; }
  let drop = 0;
  for (let k = 1; k <= 4; k++) { const b = bot.blockAt(new Vec3(nx, y - k, nz)); if (!b || b.boundingBox === 'empty' || /water/.test(b.name)) drop++; else break; if (/lava/.test(b?.name)) return false; }
  return drop < 3;
}

async function wiggle (bot, { rounds = 2 } = {}) {
  const start = bot.entity.position.clone();
  const moved = () => bot.entity.position.distanceTo(start) > 0.6;
  const yaw0 = bot.entity.yaw;
  const dirs = [['forward', 0], ['back', Math.PI], ['left', Math.PI / 2], ['right', -Math.PI / 2]];
  const tried = [];
  try {
    for (let r = 0; r < rounds && !moved(); r++) {
      await holdControls(bot, ['jump'], 250);                      // 先原地跳一下
      if (moved()) break;
      for (const [key, off] of dirs) {
        if (!safeToward(bot, yaw0 + off)) { tried.push(`${key}(危险，跳过)`); continue; }
        await holdControls(bot, [key, 'jump'], 300);
        tried.push(key);
        if (moved()) break;
      }
      if (!moved()) { await bot.look(yaw0 + Math.PI / 4 * (r + 1), 0, true); }   // 转个角度再来一轮
    }
  } finally { bot.clearControlStates(); }
  return { freed: moved(), moved: +bot.entity.position.distanceTo(start).toFixed(2), tried };
}

/**
 * 以前的走法是"先直接走，走不通再试梯子、再试开门"—— 都是撞了墙之后的补救，所以她老在撞墙。
 * 人脑子里有张图：门和梯子本来就是路的一部分。这里出发前先规划整条路线：
 *   节点 = 起点、终点、每架梯子的上下两头、每扇门
 *   边   = 同一层的点之间走路；梯子连上下两层；门连两边（关着的走到门口要先开）
 * 按路线一段段走：走路交给寻路器，梯子用爬/滑，门先开再过（过去后随手关门的习惯会关回去）。
 * 某一段真走不通：把这段标成不通，从现在的位置重新规划，而不是在原地撞。
 */
function buildGraph (bot, from, to, bad) {
  const nodes = [{ id: 'S', pos: from, kind: 'point' }, { id: 'G', pos: to, kind: 'point' }];
  for (const c of ladderColumns(bot, 32)) {
    if (c.top - c.bottom < 1) continue;
    const low = { id: `L${c.x},${c.z},${c.bottom}:low`, pos: new Vec3(c.x, c.bottom, c.z), kind: 'ladderLow', col: c };
    const high = { id: `L${c.x},${c.z},${c.bottom}:high`, pos: new Vec3(c.x, c.top + 2, c.z), kind: 'ladderHigh', col: c };
    nodes.push(low, high);
  }
  for (const d of doorsNear(bot, 24)) {
    if (/iron/.test(d.name) || /trapdoor|hatch/.test(d.name)) continue;   // 铁门要红石；活板门归梯子管
    nodes.push({ id: `D${d.key}`, pos: new Vec3(d.x, d.y, d.z), kind: 'door', door: d });
  }
  const edges = new Map(nodes.map(n => [n.id, []]));
  const add = (a, b, cost, kind) => { if (!bad.has(`${a.id}>${b.id}`)) edges.get(a.id).push({ to: b, cost, kind }); };
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      if (a.kind === 'ladderLow' && b.kind === 'ladderHigh' && a.col === b.col) { add(a, b, (a.col.top - a.col.bottom + 2) * 1.5 + 3, 'up'); continue; }
      if (a.kind === 'ladderHigh' && b.kind === 'ladderLow' && a.col === b.col) { add(a, b, (a.col.top - a.col.bottom + 2) * 1.2 + 3, 'down'); continue; }
      // 同一层（脚的高度差 ≤ 1.5）才能走过去
      if (Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
      if (d > 40) continue;
      add(a, b, d + (b.kind === 'door' && !b.door.open ? 2 : 0), 'walk');
    }
  }
  return { nodes, edges };
}

function shortest (graph) {
  const dist = new Map([['S', 0]]); const prev = new Map(); const done = new Set();
  for (;;) {
    let u = null; let best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id; }
    if (u == null) return null;
    if (u === 'G') break;
    done.add(u);
    for (const e of graph.edges.get(u) || []) {
      const nd = best + e.cost;
      if (nd < (dist.get(e.to.id) ?? Infinity)) { dist.set(e.to.id, nd); prev.set(e.to.id, { from: u, e }); }
    }
  }
  const path = []; let cur = 'G';
  while (cur !== 'S') { const p = prev.get(cur); path.unshift({ from: p.from, ...p.e }); cur = p.from; }
  return path;
}

function describeRoute (path) {
  return path.map(e => e.kind === 'up' ? `爬梯子上到 y=${e.to.pos.y}` : e.kind === 'down' ? `顺梯子下到 y=${e.to.pos.y}`
    : e.to.kind === 'door' ? `走到${e.to.door.kind}(${e.to.door.key})` : e.to.kind === 'ladderLow' ? `走到梯子下面(${e.to.pos.x},${e.to.pos.z})`
      : e.to.kind === 'ladderHigh' ? `走到梯子口(${e.to.pos.x},${e.to.pos.z})` : '走到目的地').join(' → ');
}

async function followRoute (bot, state, target, range, tried, t0, maxMs) {
  const bad = new Set();
  for (let plan = 0; plan < 5 && Date.now() - t0 < maxMs; plan++) {
    const from = bot.entity.position.floored();
    const g = buildGraph(bot, from, target(), bad);
    const path = shortest(g);
    if (!path) { tried.push('规划不出路线（附近的梯子和门连不到那里）'); return false; }
    tried.push(`路线：${describeRoute(path)}`);
    let failed = null;
    for (let i = 0; i < path.length; i++) {
      const e = path[i];
      const next = path[i + 1];
      try {
        if (e.kind === 'up') await climbColumn(bot, state, e.to.col);
        else if (e.kind === 'down') await climbColumnDown(bot, state, e.to.col);
        else if (e.to.kind === 'ladderLow' && next?.kind === 'up') continue;       // 爬梯子会自己走进梯子格
        else if (e.to.kind === 'ladderHigh' && next?.kind === 'down') continue;    // 下梯子会自己走到梯子口
        else if (e.to.kind === 'door') {
          if (!e.to.door.open) await setDoor(bot, state, { x: e.to.door.x, y: e.to.door.y, z: e.to.door.z, open: true });
          const err = await pathTo(bot, e.to.pos, 0.8, 20000);
          if (err) throw new Error(err);
        } else {
          const goal = e.to.id === 'G' ? target() : e.to.pos;
          const err = await pathTo(bot, goal, e.to.id === 'G' ? range : 1.2, Math.min(45000, 8000 + bot.entity.position.distanceTo(goal) * 1200));
          if (err && bot.entity.position.distanceTo(goal) > (e.to.id === 'G' ? range + 0.8 : 2)) throw new Error(err);
        }
      } catch (err) { failed = { e, err: err.message }; break; }
    }
    if (!failed) return true;
    bad.add(`${failed.e.from}>${failed.e.to.id}`);
    tried.push(`这段不通（${failed.err.slice(0, 60)}），换条路`);
  }
  return false;
}

function abortError () {
  const e = new Error('被叫停了');
  e.aborted = true;
  return e;
}

async function go (bot, state, { x, y, z, player, range = 1.8, maxMs = 90000, abort } = {}) {
  const t0 = Date.now();
  const tried = [];
  // `abort` 是"还要不要继续"的谓词（见 startFollow）。没有它的时候 `/stop` 停不住一条在途路线：
  // pathTo 里的 goto 会被 setGoal(null) 打断，但 go 会接着走下一步、**重新把 goal 设回去** ——
  // 于是"急停"之后她还在走。所以每个 await 之后都要问一次。
  const stopped = () => { try { return typeof abort === 'function' && !!abort(); } catch (_) { return false; } };
  const checkStop = () => { if (stopped()) throw abortError(); };
  const target = () => {
    if (player) {
      const e = bot.players[player]?.entity;
      if (!e) throw new Error(`看不见 ${player}（不在视野内或不在线）`);
      return e.position.floored();
    }
    if (x == null || z == null) throw new Error('要给 x z（y 可选）或 player');
    return new Vec3(+x, y != null ? +y : Math.floor(bot.entity.position.y), +z);
  };
  const dist = () => bot.entity.position.distanceTo(target().offset(0.5, 0, 0.5));
  const near = () => dist() <= range + 0.8;
  const eta = () => Math.min(45000, 8000 + dist() * 1200);
  const startDist = dist();
  if (near()) return { arrived: true, already: true, distance: +startDist.toFixed(1) };
  try { const o = await offLadder(bot, state, target().y); if (o) tried.push(o); } catch (e) { tried.push(`挂在梯子上，想下来没成：${e.message}`); }
  checkStop();

  // 同一层：先直接走（最常见、最快）；跨层或者直接走不通：规划一条带梯子和门的路线
  const sameFloor = Math.abs(target().y - Math.floor(bot.entity.position.y + 0.01)) < 2;
  if (sameFloor) {
    const err0 = await pathTo(bot, target(), range, eta());
    checkStop();
    // 只信实际距离：寻路器有时一步没走就"完成"了（实测 45ms 返回、还差 3 格，却报了到达）
    if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
    tried.push(`直接走：${err0 || '寻路器说走完了，其实还差 ' + dist().toFixed(1) + ' 格'}`);
  }
  const routed = await followRoute(bot, state, target, range, tried, t0, maxMs);
  checkStop();
  if (routed && near()) {
    return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ① 楼上楼下
  const dy = target().y - Math.floor(bot.entity.position.y + 0.01);
  let keepFloorAt = null;
  if (Math.abs(dy) >= 3) {
    try {
      const r = dy > 0 ? await climbUp(bot, state, { targetY: target().y }) : await climbDown(bot, state, { targetY: target().y });
      tried.push(`${dy > 0 ? '上楼' : '下楼'}：${r.fromY}→${r.toY}`);
      // 已爬到目标所在楼层后，后续横向靠近不能把跳下楼当捷径。
      if (dy > 0 && r.toY >= target().y - 1.5) keepFloorAt = Math.floor(r.toY) - 1;
    } catch (e) { tried.push(`${dy > 0 ? '上楼' : '下楼'}没成：${e.message}`); }
    checkStop();
  }

  // ② 走到旁边
  let err = keepFloorAt == null
    ? await pathTo(bot, target(), range, eta())
    : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
  checkStop();
  if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  err ||= `寻路器说走完了，其实还差 ${dist().toFixed(1)} 格`;
  tried.push(`寻路：${err}`);

  // 跨层路线常会先走到一个更高的平台，再因为当前 A* 搜索边界结束而返回失败。
  // 只要实际距离明显缩短，就以**此刻位置**为新起点继续算；不重复旧起点，也不在没进展时死循环。
  let bestDist = Math.min(startDist, dist());
  for (let retry = 1; retry <= 3 && Date.now() - t0 < maxMs; retry++) {
    checkStop();
    const before = dist();
    if (before > bestDist + 0.75 || before <= range + 0.8) break;
    const leftMs = Math.max(5000, maxMs - (Date.now() - t0));
    const nextErr = keepFloorAt == null
      ? await pathTo(bot, target(), range, Math.min(eta(), leftMs))
      : await pathToKeepingFloor(bot, target(), range, Math.min(eta(), leftMs), keepFloorAt);
    checkStop();
    const after = dist();
    if (near()) return { arrived: true, distance: +after.toFixed(1), tried: [...tried, `从当前位置续算第 ${retry} 次：到达`], ms: Date.now() - t0 };
    if (after < before - 0.75) {
      bestDist = Math.min(bestDist, after);
      tried.push(`从当前位置续算第 ${retry} 次：${before.toFixed(1)}→${after.toFixed(1)} 格`);
      err = nextErr || `还差 ${after.toFixed(1)} 格`;
      continue;
    }
    tried.push(`从当前位置续算第 ${retry} 次没有进展（${after.toFixed(1)} 格），停止重复`);
    break;
  }

  // ③ 开挡路的门（往目标那边的、关着的）
  for (let n = 0; n < 3 && Date.now() - t0 < maxMs; n++) {
    checkStop();
    const me = bot.entity.position; const tg = target();
    const doors = doorsNear(bot, 10).filter(d => !d.open && !/iron|trapdoor|hatch/.test(d.name))
      .map(d => ({ ...d, toTarget: Math.hypot(d.x + 0.5 - tg.x, d.z + 0.5 - tg.z) }))
      .filter(d => d.toTarget < Math.hypot(me.x - tg.x, me.z - tg.z) + 2)
      .sort((a, b) => (a.distance + a.toTarget) - (b.distance + b.toTarget));
    if (!doors.length) break;
    const d = doors[0];
    try {
      await setDoor(bot, state, { x: d.x, y: d.y, z: d.z, open: true });
      tried.push(`开了挡路的${d.kind}(${d.x},${d.y},${d.z})`);
    } catch (e) { tried.push(`想开${d.kind}(${d.x},${d.y},${d.z})没开成：${e.message}`); break; }
    err = keepFloorAt == null
      ? await pathTo(bot, target(), range, eta())
      : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
    checkStop();
    if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ④ 放宽范围 / 先走一段
  for (const r2 of [3, 5]) {
    if (Date.now() - t0 > maxMs) break;
    checkStop();
    err = keepFloorAt == null
      ? await pathTo(bot, target(), r2, eta())
      : await pathToKeepingFloor(bot, target(), r2, eta(), keepFloorAt);
    checkStop();
    if (!err) { tried.push(`放宽到 ${r2} 格：走到了`); break; }
    tried.push(`放宽到 ${r2} 格：${err}`);
  }
  if (!near() && dist() > 6 && Date.now() - t0 < maxMs) {
    const me = bot.entity.position; const tg = target();
    const k = Math.min(1, 8 / dist());
    const mid = new Vec3(Math.floor(me.x + (tg.x - me.x) * k), Math.floor(me.y), Math.floor(me.z + (tg.z - me.z) * k));
    const e2 = keepFloorAt == null
      ? await pathTo(bot, mid, 3, 20000)
      : await pathToKeepingFloor(bot, mid, 3, 20000, keepFloorAt);
    checkStop();
    tried.push(e2 ? `先往目标走一段：${e2}` : `先往目标走了一段到 (${mid.x},${mid.z})`);
    if (!e2) {
      err = keepFloorAt == null
        ? await pathTo(bot, target(), range, eta())
        : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
      checkStop();
      // 只信实际距离（第四处，和上面三处同一个判据）
      if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
    }
  }

  const left = dist();
  if (left <= Math.max(range, 5)) return { arrived: false, close: true, distance: +left.toFixed(1), from: +startDist.toFixed(1), tried, note: '到附近了，没到正旁边' };
  const e = new Error(`走不到（还差 ${left.toFixed(1)} 格，出发时 ${startDist.toFixed(1)} 格）。试过：${tried.join('；')}`);
  e.data = { distance: +left.toFixed(1), tried, around: lookAround(bot, { r: 3, below: 1, above: 2 }).map };
  throw e;
}

/**
 * 微调身位：挪到一格里的精确位置（x、z 可以带小数）。
 * 蹲着小步挪 —— 蹲着不会从边上掉下去，步子也小；每挪一下都核对位置，直到误差 ≤ tol。
 * 下梯子就是靠这个成的（站到离墙那侧，身体才落得进梯子格）。
 */
async function nudge (bot, { x, z, tol = 0.12, maxSteps = 25 } = {}) {
  if (x == null || z == null) throw new Error('要给 x z（可以带小数）');
  const target = { x: +x, z: +z };
  const d = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
  const from = d();
  if (from > 3) throw new Error(`离目标 ${from.toFixed(1)} 格，太远了 —— 微调只管最后一两格，先走过去`);
  let steps = 0;
  try {
    while (d() > tol && steps < maxSteps) {
      steps++;
      const p = bot.entity.position;
      await bot.lookAt(new Vec3(target.x, p.y + 1.62, target.z), true);
      bot.setControlState('sneak', true);
      bot.setControlState('forward', true);
      await sleep(Math.min(250, Math.max(60, d() * 400)));
      bot.setControlState('forward', false);
      await sleep(120);
    }
  } finally { bot.clearControlStates(); }
  const p = bot.entity.position;
  return { reached: d() <= tol, error: +d().toFixed(2), from: +from.toFixed(2), steps, at: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } };
}

async function motor (bot, state, { steps = [], maxMs = 20000 } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 要有动作');
  if (steps.length > 30) throw new Error('一次最多 30 个动作');
  const t0 = Date.now();
  const pos = () => { const p = bot.entity.position; return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }; };
  const trace = [];
  const cond = (u) => {
    if (!u) return false;
    const p = bot.entity.position;
    if (u.yAtLeast != null && p.y >= +u.yAtLeast) return true;
    if (u.yAtMost != null && p.y <= +u.yAtMost) return true;
    if (u.inCell && Math.floor(p.x) === +u.inCell.x && Math.floor(p.z) === +u.inCell.z) return true;
    return false;
  };
  try {
    for (let i = 0; i < steps.length; i++) {
      if (Date.now() - t0 > Math.min(maxMs, 30000)) { trace.push({ i, stop: '总时间到了' }); break; }
      const st = steps[i]; const before = pos(); let note = '';
      if (st.look) {
        await bot.lookAt(new Vec3(+st.look.x, +st.look.y, +st.look.z), true);
      } else if (st.hold) {
        const keys = [].concat(st.hold).filter(k => KEYS.has(k));
        const ms = Math.min(Math.max(+st.ms || 500, 50), 5000);
        for (const k of keys) bot.setControlState(k, true);
        const end = Date.now() + ms; let last = bot.entity.position.clone(); let still = 0;
        while (Date.now() < end) {
          await sleep(50);
          if (cond(st.until)) { note = '条件达成'; break; }
          if (st.until?.stopped) {
            if (bot.entity.position.distanceTo(last) < 0.01) { if (++still >= 4) { note = '停住了'; break; } } else still = 0;
            last = bot.entity.position.clone();
          }
        }
        bot.clearControlStates();
        await sleep(60);
        if (!note) note = st.until ? '时间到，条件没达成' : '时间到';
        if (bot.entity.isCollidedHorizontally) note += '，撞到东西了';
      } else if (st.activate) {
        const b = bot.blockAt(new Vec3(+st.activate.x, +st.activate.y, +st.activate.z));
        if (!b) note = '那里没加载';
        else { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); await sleep(250); note = `右键了 ${b.name}${isDoorLike(b) ? `（现在${isOpen(bot.blockAt(b.position)) ? '开' : '关'}着）` : ''}`; }
      } else if (st.nudge) {
        const r = await nudge(bot, st.nudge);
        note = r.reached ? `挪到了（误差 ${r.error}）` : `没挪准（还差 ${r.error}）`;
      } else if (st.wait) {
        await sleep(Math.min(+st.wait, 3000));
      } else { note = '看不懂这一步'; }
      trace.push({ i, step: st, from: before, to: pos(), note });
    }
  } finally {
    bot.clearControlStates();
  }
  return { steps: trace.length, end: pos(), onGround: bot.entity.onGround, trace };
}

function lookAround (bot, { r = 3, below = 2, above = 3 } = {}) {
  r = Math.min(Math.max(1, +r || 3), 6);
  const p = bot.entity.position;
  const fx = Math.floor(p.x); const fy = Math.floor(p.y + 0.01); const fz = Math.floor(p.z);
  const layers = [];
  for (let y = fy + Math.min(above, 5); y >= fy - Math.min(below, 5); y--) {
    const rows = [];
    for (let z = fz - r; z <= fz + r; z++) {
      let row = '';
      for (let x = fx - r; x <= fx + r; x++) {
        row += (x === fx && z === fz && (y === fy || y === fy + 1)) ? '@' : cellChar(bot.blockAt(new Vec3(x, y, z)));
      }
      rows.push(row);
    }
    layers.push(`y=${y}${y === fy ? '（脚）' : y === fy + 1 ? '（头）' : y === fy - 1 ? '（脚下）' : ''}\n${rows.join('\n')}`);
  }
  return {
    center: { x: fx, y: fy, z: fz },
    legend: '@你 #实心 .空气 H梯子 T关着的活板门 t开着的 D关着的门 d开着的 G关着的栅栏门 g开着的 |栅栏/墙 _台阶 /楼梯 ~水 !岩浆 *树叶 i火把/灯 ,能穿过的小东西',
    orientation: `每层是俯视图：从上到下是 z=${fz - r}..${fz + r}（北→南），从左到右是 x=${fx - r}..${fx + r}（西→东）`,
    map: layers.join('\n\n'),
  };
}

/**
 * 梯子这件事我是怎么解决的：一格格量出周围的立体地形 → 看出"两段梯子、中间迈一格"→
 * 用"按住跳 / 朝某处走"这些基本按键加位置反馈，拼出一套动作。
 * 她缺的就是这两样：**看清地形的眼睛**和**能自己拼的基本动作**。给了她，
 * 以后遇到新的地形难题（跳过缺口、钻半格洞、翻栅栏、下梯子…）她能自己看、自己试、做成了存成技能。
 */
function cellChar (b) {
  if (!b) return '?';
  const n = b.name;
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.';
  if (/lava/.test(n)) return '!';
  if (/water|bubble_column/.test(n)) return '~';
  if (/ladder|vine|scaffolding/.test(n)) return 'H';
  if (isDoorLike(b)) {
    const open = isOpen(b);
    if (/trapdoor|hatch/.test(n)) return open ? 't' : 'T';
    if (/gate/.test(n)) return open ? 'g' : 'G';
    return open ? 'd' : 'D';
  }
  if (/fence|wall(?!_)|_wall$|bars|pane/.test(n)) return '|';
  if (/slab/.test(n)) return '_';
  if (/stairs/.test(n)) return '/';
  if (/leaves/.test(n)) return '*';
  if (/torch|lantern|campfire|candle/.test(n)) return 'i';   // 光源单独标出来（以前和草花一样是 , 她认不出自己插的火把）
  if (b.boundingBox === 'empty') return ',';
  return '#';
}

async function runCommand (bot, state, { command, because, selfTp } = {}) {
  const cmd = String(command || '').trim().replace(/^\/+/, '');
  if (!cmd) throw new Error('command 要写命令，比如 home、tpa Ka_sum1');
  const head = cmd.split(/\s+/)[0].toLowerCase().replace(/^minecraft:/, '');
  if (NEVER_CMDS.has(head)) throw new Error(`/${head} 不归你用`);
  const words = commandWords(bot);
  if (words && !words.has(head)) throw new Error(`服务器没给你 /${head} 这个命令（你能用的：${[...words].filter(w => w.length < 12).slice(0, 40).join(' ')}…）`);
  const trustedSelfTp = typeof selfTp === 'function' && selfTp() === 'self-tp' && SELF_TP_RE.test(cmd);
  if (ADMIN_CMDS.has(head) && !trustedSelfTp) {
    const said = String(because || '').trim();
    const me = bot.username;
    // 聊天缓冲（bridge 的 chatlog：{t, position, text}）里 10 分钟内、不是她自己说的那条要包含这句原话
    const recent = (state.chatlog || []).filter(m => Date.now() - m.t < 10 * 60 * 1000);
    const heard = said.length >= 2 && recent.some(m => { const t = String(m.text || ''); return m.position !== 'bridge' && !t.includes(`<${me}>`) && !t.startsWith(me) && t.includes(said); });
    if (!heard) throw new Error(`/${head} 是管理员命令：只有玩家明确要你用才行 —— because 写他的原话（最近聊天里要真有这句）`);
  }
  const t0 = Date.now();
  bot.chat('/' + cmd);
  await sleep(1200);
  const replies = (state.chatlog || []).filter(m => m.t >= t0).map(m => String(m.text || '')).filter(Boolean).slice(-4);
  return { ran: '/' + cmd, serverSaid: replies };
}

async function sleepInBed (bot, state, { home = null, abort } = {}) {
  if (abort?.()) return { ok: false, aborted: true };
  if (bot.isSleeping) return { already: true };
  // 床：名字以 bed 结尾的；女僕床、宠物床这种不是给人睡的
  const ids = Object.values(bot.registry.blocksByName)
    .filter(b => /(^|_|:)bed$/.test(b.name) && !/bedrock|flower_bed|seabed|riverbed|maid|pet_|dog_|cat_|kennel|nest/.test(b.name)).map(b => b.id);
  const beds = bot.findBlocks({ matching: ids, maxDistance: 48, count: 20 }).map(p => bot.blockAt(p)).filter(Boolean);
  if (!beds.length) throw new Error('附近 48 格内没有床');
  const inHome = (p) => home && Math.hypot(p.x - home.center.x, p.z - home.center.z) <= home.radius;
  beds.sort((a, b) => (inHome(b.position) - inHome(a.position)) || (bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)));
  const why = [];
  for (const bed of beds.slice(0, 4)) {
    if (abort?.()) return { ok: false, aborted: true };
    // 睡不了的时候服务器会在动作栏说原因（只能晚上睡 / 附近有怪 / 床被占了）
    const said = [];
    const onMsg = (m, pos) => { if (pos === 'game_info' || pos === 'system') said.push(String(m.toString())); };
    bot.on('message', onMsg);
    try {
      // 先走到床跟前（4 格内 + 视线通才算够得着；用同一个 approach 判据）
      try { await approach(bot, bed); } catch (e) {
        why.push(`${bed.name}(${doorKey(bed.position)})：${e.message}`);
        continue;
      }
      if (abort?.()) return { ok: false, aborted: true };
      if (bot.isABed(bed)) {
        await bot.sleep(bed);
      } else {
        // 模组的床（比如 handcrafted 的）：mineflayer 只认原版 16 色床名，自己右键它
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        if (abort?.()) return { ok: false, aborted: true };
        await bot.activateBlock(bed);
        for (let t = 0; t < 20 && !bot.isSleeping && !abort?.(); t++) await sleep(100);
      }
      if (abort?.()) return { ok: false, aborted: true };
      await sleep(300);
      if (abort?.()) return { ok: false, aborted: true };
      if (bot.isSleeping) return { sleeping: true, bed: bed.name, at: doorKey(bed.position), inHome: !!inHome(bed.position) };
      why.push(`${bed.name}(${doorKey(bed.position)})：${said.join(' ') || '右键了但没躺下'}`);
    } catch (e) {
      if (abort?.()) return { ok: false, aborted: true };
      const m = `${String(e.message || e)} ${said.join(' ')}`;
      why.push(`${bed.name}(${doorKey(bed.position)})：${/day|night|not possible|time/i.test(m) ? '现在不是晚上，睡不了' : /monster|mob|enem|safe/i.test(m) ? '附近有怪，睡不了' : /occupied/i.test(m) ? '床被占了' : m}`);
      if (/day|night|time|monster|mob|safe/i.test(m)) break;   // 时间/怪的问题换床也没用
    } finally {
      bot.removeListener('message', onMsg);
    }
  }
  throw new Error(`睡不了：${why.join('；')}`);
}

/**
 * 垫方块自救（家外）：
 *   mode=pillar  原地往上垫 height 格（跳起来往脚下放）—— 甩开僵尸/蜘蛛以外的近战怪、从坑里爬出来
 *   mode=enclose 把自己四面两层 + 头顶都堵上（夜里在野外、打不过又跑不掉时）
 */
async function selfRescue (bot, state, { mode = 'pillar', height = 3, home = null } = {}) {
  if (inHomeArea(home, bot.entity.position)) throw new Error('在家里，不往家里乱垫方块 —— 回屋关门就好');
  if (!await ensureFiller(bot, state)) throw new Error('身上没有能垫的方块（圆石/泥土/花岗岩…），先挖点');
  const log = []; const y0 = bot.entity.position.y;
  bot.pathfinder?.setGoal(null); bot.clearControlStates();
  if (mode === 'enclose') {
    const f = bot.entity.position.floored();
    let n = 0;
    const cells = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push(f.offset(dx, 0, dz), f.offset(dx, 1, dz));
    cells.push(f.offset(0, 2, 0));
    for (const c of cells) { try { if (airish(bot.blockAt(c)) && await placeFiller(bot, c, state)) n++; } catch (e) { log.push(e.message); break; } }
    const open = cells.filter(c => airish(bot.blockAt(c))).length;
    if (open === 0) await lightUp(bot, { max: 1, state });
    return { ok: open === 0, mode, placed: n, stillOpen: open, log };
  }
  let up = 0;
  for (let i = 0; i < Math.min(Math.max(1, height), 8); i++) {
    const f = bot.entity.position.floored();
    if (!airish(bot.blockAt(f.offset(0, 2, 0)))) { log.push('头顶被挡住了'); break; }
    const it = await ensureFiller(bot, state);
    if (!it) { log.push('垫的方块用完了'); break; }
    await bot.equip(it, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.setControlState('jump', true);
    const t = Date.now();
    while (bot.entity.position.y < f.y + 1.05 && Date.now() - t < 900) await sleep(20);
    bot.setControlState('jump', false);
    const under = bot.blockAt(f.offset(0, -1, 0));
    try { await bot.placeBlock(under, new Vec3(0, 1, 0)); up++; } catch (e) { log.push(`没垫上：${e.message}`); break; }
    await sleep(300);
  }
  return { ok: up > 0, mode, raised: +(bot.entity.position.y - y0).toFixed(1), blocks: up, log };
}

const plainTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`超时 ${ms}ms`); })]);

const NEVER_CMDS = new Set(['stop', 'op', 'deop', 'ban', 'ban-ip', 'pardon', 'kick', 'whitelist', 'reload', 'save-off', 'debug', 'forceload']);

const SELF_TP_RE = /^tp\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/i;

const FURNITURE_RE = /chest|barrel|shulker|_bed$|crafting_table|furnace|smoker|anvil|enchanting|brewing|lectern|loom|stonecutter|grindstone|smithing|cartography|fletching|composter|bookshelf|cauldron|jukebox|note_block|flower_pot|painting|item_frame|stove|cooking_pot|skillet|cutting_board|keg|fridge|freezer|cabinet|counter|table|chair|sofa|shelf|crate|drawer|waystone/;

const FOLLOW_TICK_MS = 1000;
/** 看不见玩家多久之后放弃（下线 / 走出视野）—— 够久到"他只是跑远了"，又不至于永远挂着 */

const FOLLOW_LOST_MS = 15000;

const KEYS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);

const ADMIN_CMDS = new Set(['give', 'tp', 'teleport', 'gamemode', 'time', 'weather', 'effect', 'kill', 'summon', 'setblock', 'fill', 'clear', 'enchant', 'xp', 'experience', 'difficulty', 'gamerule', 'op', 'deop', 'ban', 'kick', 'whitelist', 'stop', 'item', 'attribute', 'spreadplayers', 'setworldspawn', 'spawnpoint', 'worldborder', 'data', 'execute', 'function', 'reload', 'forge', 'kubejs', 'ftbquests', 'tpx', 'invsee', 'heal', 'feed', 'fly', 'god']);

module.exports = { ADMIN_CMDS, FOLLOW_LOST_MS, FOLLOW_TICK_MS, FURNITURE_RE, KEYS, NEVER_CMDS, SELF_TP_RE, abortError, bind, buildGraph, cellChar, climbColumn, climbColumnDown, climbDown, climbUp, describeRoute, doorsNear, followRoute, go, holdControls, installDoorHabit, ladderBottomReachable, ladderColumns, ladderExitTargets, lookAround, motor, nudge, offLadder, pathTo, pathToKeepingFloor, plainTimeout, runCommand, safeToward, selfRescue, setDoor, shortest, sleepInBed, startFollow, stepInto, wiggle };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 hands.js 的自测段里（同一个 (async () => {…})() 外套），
// 现在搬到这里 —— 断言一字未改，只是把原来「同一作用域里随手就能用」的 hands 函数
// 改成从 t.h（总表）取名（拆开后它们分在别的文件里）。
// 被汇总 require 时 register（登记不跑）；`node src/body/movement.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['[1/8] 同层 → 交给 GoalFollow 贴着走', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[1/8] 同层 → 交给 GoalFollow 贴着走');
      {
        const { bot, pathfinder, setGoalCalls } = rig();
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        check('设的是 GoalFollow', pathfinder.goal instanceof goals.GoalFollow, true);
        check('追的是 Ann 的实体', pathfinder.goal?.entity === bot.players.Ann.entity, true);
        check('currentAction 标着在跟随', state.currentAction, 'following Ann');
        check('同层只设了一次 goal（没在反复重设）', setGoalCalls.length, 1);
        state.currentAction = null;                                   // 模拟 /stop，别让它一直跑
      }
  }],
  ['[2/8] /stop（清掉 currentAction）→ 循环退出并清掉 GoalFollow', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[2/8] /stop（清掉 currentAction）→ 循环退出并清掉 GoalFollow');
      {
        const { bot, pathfinder, setGoalCalls } = rig();
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        state.currentAction = null;                                   // /stop 就是这么做的
        const n = setGoalCalls.length;
        await wait(40);
        // 注意：退出时会**主动** setGoal(null) 收尾，所以 setGoal 的调用数会 +1。
        // 真正要钉住的是"不再设 GoalFollow"—— 否则就是循环没停。
        const refollows = setGoalCalls.slice(n).filter(g => g instanceof goals.GoalFollow).length;
        check('退出后不再设 GoalFollow（循环真的停了）', refollows, 0);
        check('把残留的 GoalFollow 清掉了', pathfinder.goal, null);
      }
  }],
  ['[3/8] 玩家下线（mineflayer 会删掉 bot.players[name]）→ 退出并记下原因', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[3/8] 玩家下线（mineflayer 会删掉 bot.players[name]）→ 退出并记下原因');
      {
        const { bot, players, pathfinder } = rig();
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        delete players.Ann;
        await wait(120);
        check('记下"看不见 Ann"', /看不见 Ann/.test(state.lastFollowStop?.reason || ''), true);
        check('清掉追鬼的 GoalFollow', pathfinder.goal, null);
      }
  }],
  ['[4/8] 换跟随对象 → 旧循环退出，但不清新的 goal', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[4/8] 换跟随对象 → 旧循环退出，但不清新的 goal');
      {
        const { bot, pathfinder } = rig();
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        startFollow(bot, state, 'Bob', 2, TICK);                      // 换人
        await wait(40);
        check('goal 追的是新对象 Bob', pathfinder.goal?.entity === bot.players.Bob.entity, true);
        check('旧循环没有把新的 goal 清掉', pathfinder.goal instanceof goals.GoalFollow, true);
        check('followSeq 递增（旧循环据此退出）', state.followSeq, 2);
      }
  }],
  ['[5/8] 循环体抛错 → 记下来，不静默死掉', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[5/8] 循环体抛错 → 记下来，不静默死掉');
      {
        const { bot } = rig();
        // 读 goal 就抛 —— setFollow 第一步就是读它
        bot.pathfinder = { get goal () { throw new Error('boom'); }, setGoal () {} };
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        check('记下循环体出错', /跟随循环出错：boom/.test(state.lastFollowStop?.reason || ''), true);
      }
  }],
  ['[6/8] 别的动作的 goal 不能被我清掉', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { startFollow } = t.h;
      console.log('\n[6/8] 别的动作的 goal 不能被我清掉');
      {
        const { bot, pathfinder } = rig();
        const state = {};
        startFollow(bot, state, 'Ann', 2, TICK);
        await wait(30);
        // 模拟 /move：先改 currentAction，再把 goal 换成 GoalNear
        state.currentAction = 'moving to 1,64,1';
        const near = new goals.GoalNear(1, 64, 1, 1);
        pathfinder.goal = near;
        await wait(40);
        check('跟随退出时没有动 /move 的 GoalNear', pathfinder.goal === near, true);
      }
  }],
  ['[7/9] 门：右键前读实时状态，已开不再切成关', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { installDoorHabit, ladderBottomReachable, ladderExitTargets, pathToKeepingFloor, sleep } = t.h;
      console.log('\n[7/9] 门：右键前读实时状态，已开不再切成关');
      {
        const makeDoorBot = (initialOpen, delay = 0) => {
          let open = initialOpen; let calls = 0;
          const pos = new Vec3(3, 64, 4);
          const block = () => ({
            name: 'minecraft:oak_door', position: pos.clone(),
            getProperties: () => ({ open, half: 'lower', facing: 'north' }),
          });
          const bot = {
            __get: () => ({ open, calls }),
            entity: { position: new Vec3(3.5, 64, 5.5) },
            blockAt: () => block(),
            lookAt: async () => {},
            activateBlock: async () => { calls++; if (delay) await sleep(delay); open = !open; },
          };
          return { bot, block };
        };

        const a = makeDoorBot(true);
        const sa = {};
        installDoorHabit(a.bot, sa);
        const skipped = await a.bot.activateBlock(a.block());
        check('门已经 open=true → 不右键', `${a.bot.__get().open}/${a.bot.__get().calls}/${skipped.skipped}`, 'true/0/true');
        check('跳过操作会留下状态证据', `${sa.doorStateSkips}/${sa.lastDoorSkipped.open}`, '1/true');

        const b = makeDoorBot(false, 20);
        const sb = {};
        installDoorHabit(b.bot, sb);
        await Promise.all([b.bot.activateBlock(b.block()), b.bot.activateBlock(b.block())]);
        check('同一扇关门并发要求打开 → 只右键一次', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'true/1');
        check('第二次在等待后看到已开并跳过', sb.doorStateSkips, 1);
        sb.doorsIOpened.clear();

        sb.__closingDoor = true;
        await b.bot.activateBlock(b.block());
        check('明确要求关门时，open=true 才右键', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'false/2');
        await b.bot.activateBlock(b.block());
        check('明确要求关门时，已经 closed 就不再右键', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'false/2');
        sb.doorsIOpened.clear();
      }

      console.log('\n跨层入口：高两格的梯子仍应实际尝试');
      check('脚 y=121、梯子底 y=123 → 候选保留', ladderBottomReachable({ bottom: 123 }, 121.02), true);
      check('脚 y=121、梯子底 y=124 → 确实够不到', ladderBottomReachable({ bottom: 124 }, 121.02), false);

      console.log('\n梯子到顶迈楼板：目标格要落在楼板上，且优先 facing 的反方向');
      {
        // 假世界：一列梯子贴在 z-1 那面墙（facing=south → 背对墙朝 +z，楼板在 -facing=-z 那侧）。
        // 实机现场：梯子顶 y=128，129/130/131 全空（敞开阁楼），楼板在 (0,128,-1)。
        const world = new Map();
        const put = (x, y, z, name) => world.set(`${x},${y},${z}`, { name, boundingBox: /air/.test(name) || /ladder/.test(name) ? 'empty' : 'block' });
        const blockAt = (x, y, z) => world.get(`${x},${y},${z}`) || { name: 'air', boundingBox: 'empty' };
        // 梯子 z=0，从 120 到 128
        for (let y = 120; y <= 128; y++) put(0, y, 0, 'ladder');
        // 楼板（阁楼地板）在 z=-1 那一层，脚踩 y=128
        put(0, 127, -1, 'oak_planks');
        put(0, 128, -1, 'air'); put(0, 129, -1, 'air');
        // 四周墙都堵上，只留 -z 那一侧能站（复现实机"只有楼板那边能迈"）
        put(0, 127, 1, 'oak_planks'); put(0, 128, 1, 'oak_planks');   // +z 那面是墙
        put(1, 127, 0, 'oak_planks'); put(1, 128, 0, 'oak_planks');
        put(-1, 127, 0, 'oak_planks'); put(-1, 128, 0, 'oak_planks');
        const ladderFacingSouth = { getProperties: () => ({ facing: 'south' }) };
        const col = { x: 0, z: 0, bottom: 120, top: 128 };
        const cands = ladderExitTargets(ladderFacingSouth, col, blockAt);
        check('找得到楼板上的可站格', cands.length > 0, true);
        check('★ 首选格是楼板那边 (0,128,-1)（facing=south 的反方向）', `${cands[0].x},${cands[0].y},${cands[0].z}`, '0,128,-1');
        check('是**梯子顶那一层**（y=128），不是 top+2=130', cands[0].y, 128);
        // 读不到 facing：也要能靠"脚下实心、头顶空"找到楼板
        const noFacing = { getProperties: () => ({}) };
        const cands2 = ladderExitTargets(noFacing, col, blockAt);
        check('读不到 facing 时仍能找到楼板格', cands2.some(c => c.x === 0 && c.z === -1 && c.y === 128), true);
        // 活板门那层（top+1）当出口的情况：梯子顶那层（128）四周没地板，只有 129 层有
        const w2 = new Map();
        const put2 = (x, y, z, name) => w2.set(`${x},${y},${z}`, { name, boundingBox: /air/.test(name) ? 'empty' : 'block' });
        for (let y = 120; y <= 128; y++) put2(0, y, 0, 'ladder');
        // 脚下实心在 128、身体空在 129、头顶空在 130 → 可站格是 y=129
        put2(0, 128, -1, 'oak_planks'); put2(0, 129, -1, 'air'); put2(0, 130, -1, 'air');
        // 128 那一层（脚踩 128）脚下是 127：不放地板 → 128 层不可站
        put2(0, 127, -1, 'air');
        const blockAt2 = (x, y, z) => w2.get(`${x},${y},${z}`) || { name: 'air', boundingBox: 'empty' };
        const cands3 = ladderExitTargets(ladderFacingSouth, col, blockAt2);
        check('top 那层没得站时退到 top+1（活板门那层地板）', cands3[0] && cands3[0].y, 129);
      }

      {
        const mv = { exclusionAreasStep: [] };
        let costs = null;
        const bot = {
          pathfinder: {
            movements: mv,
            goto: async () => { const guard = mv.exclusionAreasStep[0]; costs = [guard({ position: { y: 127 } }), guard({ position: { y: 128 } })]; },
            setGoal: () => {},
          },
        };
        await pathToKeepingFloor(bot, new Vec3(0, 129, 0), 2, 100, 128);
        check('爬上楼后：低于守住楼层的路径被禁', costs, [100, 0]);
        check('楼层保护只在本次寻路期间安装', mv.exclusionAreasStep.length, 0);
      }
  }],
  ['[8/9] go：被叫停时立刻抛 aborted（`/stop` 要停得住在途路线）', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { go } = t.h;
      console.log('\n[8/9] go：被叫停时立刻抛 aborted（`/stop` 要停得住在途路线）');
      {
        let aborted = false;
        const bot = mkGoBot(async () => { aborted = true; throw new Error('GoalChanged'); });
        let err = null;
        try { await go(bot, {}, { player: 'Ann', range: 1.8, abort: () => aborted }); } catch (e) { err = e; }
        check('goto 失败后 abort 变真 → 抛 aborted', err?.aborted, true);
        check('错误信息是"被叫停了"', err?.message, '被叫停了');
      }
  }],
  ['[9/9] go：abort 一直为假 → 不误报"被叫停"', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { go } = t.h;
      console.log('\n[9/9] go：abort 一直为假 → 不误报"被叫停"');
      {
        const bot = mkGoBot(async () => { throw new Error('GoalChanged'); });
        let err = null;
        // maxMs: 1 → 跳过"规划路线"和"放宽范围"两段，让这条用例跑得快
        try { await go(bot, {}, { player: 'Ann', range: 1.8, maxMs: 1, abort: () => false }); } catch (e) { err = e; }
        check('走不通就如实报走不通（不是 aborted）',
          !!(err && !err.aborted && /走不到/.test(err.message)), true);
      }
  }],
];
register('movement', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 单独跑本文件：先把总表接上（原来所有 hands 函数在同一作用域，小节随手就能取）。
  // 总表用汇总额外导出的 __ns（8 个文件的全部名字），不是那 47 个对外接口。
  require('./testkit').bindHands(require('./index').__ns);
  const { runSuite } = require('./testkit');
  runSuite('movement', __sections);
}
