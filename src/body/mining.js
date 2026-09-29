'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「mining」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3
const paths = require('../paths');
const MINES_FILE = require('path').join(paths.MEMORY, 'mines.json');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补

// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleep } = require('../util/time');
const __ns = {};
let N6, REACH;   // 常量：load 完成后由 bind() 回填
function airish (...a) { return __ns.airish.apply(null, a); }
function checkChests (...a) { return __ns.checkChests.apply(null, a); }
function collectDrops (...a) { return __ns.collectDrops.apply(null, a); }
function craft2 (...a) { return __ns.craft2.apply(null, a); }
function delta (...a) { return __ns.delta.apply(null, a); }
function doorKey (...a) { return __ns.doorKey.apply(null, a); }
function ensureCarried (...a) { return __ns.ensureCarried.apply(null, a); }
function eyeDist (...a) { return __ns.eyeDist.apply(null, a); }
function fullId (...a) { return __ns.fullId.apply(null, a); }
function holdControls (...a) { return __ns.holdControls.apply(null, a); }
function inHomeArea (...a) { return __ns.inHomeArea.apply(null, a); }
function invCounts (...a) { return __ns.invCounts.apply(null, a); }
function isLiquid (...a) { return __ns.isLiquid.apply(null, a); }
function pathTo (...a) { return __ns.pathTo.apply(null, a); }
function plainTimeout (...a) { return __ns.plainTimeout.apply(null, a); }
function scaffoldIds (...a) { return __ns.scaffoldIds.apply(null, a); }
function threatNear (...a) { return __ns.threatNear.apply(null, a); }
function unseenChests (...a) { return __ns.unseenChests.apply(null, a); }
// 挖之前挑工具（2026-09-29）：判据在 tool-choice.js，只有那一份
function equipDigTool (...a) { return __ns.equipDigTool.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); N6 = ns.N6; REACH = ns.REACH; }

async function digBlock (bot, block) {
  if (airish(block)) return { ok: true };
  if (BUILT_RE.test(block.name)) return { ok: false, why: `前面是 ${block.name}（人造的，不拆）` };
  if (!block.diggable || block.hardness == null || block.hardness < 0) return { ok: false, why: `${block.name} 挖不动` };
  // 挖之前先挑最合适的工具拿到手上（2026-09-29）：判据在 tool-choice.js。
  // 以前用 `bot.pathfinder.bestHarvestTool` —— 它只看身上背包、且模组方块（material 空）
  // 会返回背包第一件东西（可能是剑）。equipDigTool 认不出就返回 took:false，照旧挖。
  await equipDigTool(bot, block);
  const need = block.harvestTools && Object.keys(block.harvestTools).length;
  if (need && !(bot.heldItem && block.harvestTools[bot.heldItem.type])) return { ok: false, needTool: true, why: `${block.name} 要更好的镐子才掉东西` };
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await Promise.race([bot.dig(block, true), sleep(15000).then(() => { throw new Error('挖了 15 秒还没挖掉'); })]);
  await sleep(80);
  const after = bot.blockAt(block.position);
  return after && after.name === block.name ? { ok: false, why: `挖了但 ${block.name} 还在` } : { ok: true, name: block.name };
}

async function clearCell (bot, pos) {
  for (let i = 0; i < 6; i++) {
    const b = bot.blockAt(pos);
    if (airish(b)) return null;
    if (isLiquid(b)) return `(${pos.x},${pos.y},${pos.z}) 是${/lava/.test(b.name) ? '岩浆' : '水'}`;
    const wet = N6.map(([dx, dy, dz]) => bot.blockAt(pos.offset(dx, dy, dz))).find(isLiquid);
    if (wet) return `挖开 (${pos.x},${pos.y},${pos.z}) 会放出${/lava/.test(wet.name) ? '岩浆' : '水'}`;
    const r = await digBlock(bot, b);
    if (!r.ok) return r.why;
  }
  return `(${pos.x},${pos.y},${pos.z}) 挖了好几次还是满的（上面一直掉沙砾？）`;
}

async function stepTo (bot, dest) {
  const { goals } = require('mineflayer-pathfinder');
  try {
    await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(dest.x, dest.y, dest.z)), sleep(6000).then(() => { throw new Error('走不进去'); })]);
  } catch (_) {
    bot.pathfinder.setGoal(null);
    await bot.lookAt(dest.offset(0.5, 1.6, 0.5), true);
    await holdControls(bot, ['forward'], 400);
  }
  const p = bot.entity.position;
  return Math.floor(p.x) === dest.x && Math.floor(p.z) === dest.z && Math.abs(p.y - dest.y) < 1;
}

function visibleOres (bot, want, radius, skip) {
  if (oreIdsRegistry !== bot.registry) {
    oreIdsRegistry = bot.registry;
    oreIdsCache = Object.values(bot.registry.blocksByName).filter(b => ORE_RE.test(b.name)).map(b => b.id);
  }
  const ids = oreIdsCache;
  const me = bot.entity.position;
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 })
    .filter(p => !skip.has(doorKey(p)))
    .map(p => bot.blockAt(p)).filter(b => b && bot.canSeeBlock(b))
    .sort((a, b) => ((want && b.name.includes(want)) - (want && a.name.includes(want))) || me.distanceTo(a.position) - me.distanceTo(b.position));
}

function mines (state) {
  if (!state.__mines) { try { state.__mines = JSON.parse(require('fs').readFileSync(MINES_FILE, 'utf8')); } catch (_) { state.__mines = {}; } }
  return state.__mines;
}

function saveMines (state) {
  try { const fs = require('fs'); const tmp = MINES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__mines || {}, null, 1)); fs.renameSync(tmp, MINES_FILE); } catch (_) {}
}

function sensedOres (bot, want, radius, skip) {
  if (oreIdsRegistry !== bot.registry) {
    oreIdsRegistry = bot.registry;
    oreIdsCache = Object.values(bot.registry.blocksByName).filter(b => ORE_RE.test(b.name)).map(b => b.id);
  }
  const ids = oreIdsCache;
  const me = bot.entity.position;
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 })
    .filter(p => !skip.has(doorKey(p))).map(p => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => ((want && b.name.includes(want)) - (want && a.name.includes(want))) || me.distanceTo(a.position) - me.distanceTo(b.position));
}

async function tunnelTo (bot, target, maxSteps = 24, state = null) {
  for (let i = 0; i < maxSteps; i++) {
    const t0 = bot.blockAt(target);
    if (eyeDist(bot, t0 || { position: target }) <= REACH) return { ok: true, steps: i };
    const f = bot.entity.position.floored();
    const dx = target.x - f.x; const dz = target.z - f.z; const dy = target.y - f.y;
    const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    if (!sx && !sz) return { ok: false, why: '就在正上/正下方，不直着挖', steps: i };
    const up = dy > 1 ? 1 : dy < -1 ? -1 : 0;
    const dest = f.offset(sx, up, sz);
    const cells = up > 0 ? [f.offset(0, 2, 0), dest.offset(0, 1, 0), dest] : up < 0 ? [f.offset(sx, 1, sz), dest.offset(0, 1, 0), dest] : [dest.offset(0, 1, 0), dest];
    const floor = bot.blockAt(dest.offset(0, -1, 0));
    if (isLiquid(floor)) return { ok: false, why: '前面脚下是液体', steps: i, stop: /lava/.test(floor.name) };
    for (const c of cells) { const why = await clearCell(bot, c); if (why) return { ok: false, why, steps: i, stop: /岩浆/.test(why) }; }
    // 垫脚方块也可能在精妙背包里：先补齐再放（以前只看 bot.inventory，背包里的石头用不上）
    if (airish(floor)) { if (await ensureFiller(bot, state)) { try { await placeFiller(bot, dest.offset(0, -1, 0), state); } catch (_) {} } }
    if (!await stepTo(bot, dest)) return { ok: false, why: `挖开了走不进 (${dest.x},${dest.y},${dest.z})`, steps: i };
  }
  return { ok: false, why: `挖了 ${maxSteps} 步还没到`, steps: maxSteps };
}

async function caveStep (bot, D, targetY) {
  const me = bot.entity.position.floored();
  const cands = [];
  // 上下只看 3 格以内：以前能挑低 8 格的落脚点，寻路过去就是跳下去（2026-09-27 挖矿时"哎哟 磕到了"）
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let dy = -3; dy <= 3; dy++) {
    if (Math.abs(dx) + Math.abs(dz) < 5) continue;
    const p = me.offset(dx, dy, dz);
    const vk = `${p.x >> 2},${p.y >> 2},${p.z >> 2}`;
    if (D.visited.has(vk)) continue;
    const floor = bot.blockAt(p.offset(0, -1, 0));
    if (!floor || floor.boundingBox !== 'block' || isLiquid(floor)) continue;
    if (!airish(bot.blockAt(p)) || !airish(bot.blockAt(p.offset(0, 1, 0)))) continue;
    const down = me.y > targetY ? -dy : Math.abs(dy) * -0.5;     // 没到深度：越往下越好
    cands.push({ p, floor, score: down * 2 + Math.hypot(dx, dz) * 0.3 + Math.random() });
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 12)) {
    if (!bot.canSeeBlock(c.floor)) continue;
    D.visited.add(`${c.p.x >> 2},${c.p.y >> 2},${c.p.z >> 2}`);
    const err = await pathTo(bot, c.p, 1, 20000, { retry: false });
    if (!err) return { to: { x: c.p.x, y: c.p.y, z: c.p.z } };
  }
  return null;
}

function inCave (bot) {
  const f = bot.entity.position.floored();
  let air = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = 0; dy <= 2; dy++) if (airish(bot.blockAt(f.offset(dx, dy, dz)))) air++;
  const sky = bot.blockAt(f)?.skyLight;
  return air > 60 && !(sky > 0);
}

/**
 * 像玩家一样找矿：
 *   还没到目标深度 → 朝一个方向挖楼梯往下（每步挖前方 3 格高，走下去；从不直着往脚下挖）
 *   到了深度 → 挖 1×2 的矿道往前
 *   挖穿了洞、或本来就在矿洞里 → 沿视线里没去过的地方逛，往下找
 *   一路上：看得见的矿挖掉，看得见的没开过的箱子走过去开（家外的拿走）
 *   每 8 步插一个火把；挖开会放出岩浆/水就换方向；血少、怪近、背包满就停下交还给她
 */
async function delve (bot, state, { target = null, targetY = null, maxMs = 120000, home = null, torchEvery = 8 } = {}) {
  const t0 = Date.now();
  const want = target ? String(target).replace(/^.*:/, '').replace(/^deepslate_/, '').replace(/_ore$/, '') : null;
  const ty = targetY != null ? +targetY : (ORE_Y[Object.keys(ORE_Y).find(k => want?.includes(k))] ?? 16);
  // 矿洞存盘（memory/mines.json）：以前方向、进度只在内存里，重启就忘，下次在原地另挖一条楼梯。
  // 现在在一个老矿洞附近（入口或上次停下的地方 48 格内）就接着它：先走回上次停下的地方，按原方向接着挖
  const here = bot.entity.position;
  const near = (a, r) => a && Math.hypot(a.x - here.x, a.z - here.z) <= r;
  let D = state.delve && state.delve.last && here.distanceTo(state.delve.last) < 32 ? state.delve : null;
  let resumed = false;
  if (!D) {
    const old = Object.values(mines(state)).filter(m => near(m.last, 48) || near(m.entry, 48))
      .sort((a, b) => Math.hypot(a.last.x - here.x, a.last.z - here.z) - Math.hypot(b.last.x - here.x, b.last.z - here.z))[0];
    if (old) { D = state.delve = { ...old, visited: new Set(), last: new Vec3(old.last.x, old.last.y, old.last.z) }; resumed = true; }
    else D = state.delve = { heading: null, visited: new Set(), steps: 0, last: null, entry: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, deepest: Math.floor(here.y) };
  }
  if (!resumed && inHomeArea(home, bot.entity.position)) throw new Error(`在家附近（离家中心 ${home.radius} 格内）不往下挖 —— 先走远一点再挖`);
  if (resumed && here.distanceTo(D.last) > 4) {
    const err = await pathTo(bot, D.last, 1, 90000);
    if (err && bot.entity.position.distanceTo(D.last) > 6) throw new Error(`想回上次挖到的地方 (${D.last.x},${D.last.y},${D.last.z}) 没走到：${err}`);
  }
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  if (!D.heading) { const yaw = bot.entity.yaw; const vx = -Math.sin(yaw); const vz = -Math.cos(yaw); D.heading = Math.abs(vx) > Math.abs(vz) ? [Math.sign(vx), 0] : [0, Math.sign(vz)]; }
  // 下矿先备火把（主人：真要去暗处，就带着火把把那里点亮）
  const prep = await makeTorches(bot, 16, state);
  if (!prep.torches) throw new Error(`没带火把，不下去（${prep.note || '做不出来'}）—— 先弄点煤/木炭做火把（煤/木炭 + 木棍 → 4 个火把）`);
  const invBefore = invCounts(bot);
  const oreSkip = new Set(); const oreAttempts = new Map(); const chests = []; const log = []; let reason = null; let turns = 0; let caveMoves = 0; let dug = 0;
  const y0 = bot.entity.position.y;

  while (Date.now() - t0 < maxMs) {
    D.last = bot.entity.position.clone(); D.deepest = Math.min(D.deepest ?? 999, Math.floor(D.last.y));
    if (bot.health < 8) { reason = `血只剩 ${Math.round(bot.health)}`; break; }
    const mob = threatNear(bot, state, bot.entity.position);
    if (mob) { reason = `${mob.name} 在 ${mob.position.distanceTo(bot.entity.position).toFixed(0)} 格外`; break; }
    if (bot.inventory.emptySlotCount() <= 1) { reason = '背包快满了'; break; }

    // 1. 视野里没开过的箱子（主人说优先级高）
    if (unseenChests(bot, state, 24).length) { chests.push(...await checkChests(bot, state, { home, max: 2 })); continue; }

    // 2. 视野里的矿；y<0 的深层还能感知附近 12 格内看不见的矿（主人 2026-09-27 允许），挖通道过去
    const deep = bot.entity.position.y < 0;
    const ore = visibleOres(bot, want, 16, oreSkip)[0] || (deep ? sensedOres(bot, want, 16, oreSkip)[0] : null);
    if (ore) {
      const oreKey = doorKey(ore.position);
      if (eyeDist(bot, ore) > REACH) await pathTo(bot, ore.position, 3, 15000, { retry: false });
      if (eyeDist(bot, ore) > REACH && deep) { const t = await tunnelTo(bot, ore.position, 24, state); log.push(t.ok ? `挖了 ${t.steps} 步通道到 ${ore.name}` : `挖不到 ${ore.name}：${t.why}`); if (t.stop) { reason = t.why; break; } }
      if (eyeDist(bot, ore) <= REACH + 0.3) {
        const wet = N6.map(([dx, dy, dz]) => bot.blockAt(ore.position.offset(dx, dy, dz))).find(isLiquid);
        if (wet) { log.push(`${ore.name} 旁边有${/lava/.test(wet.name) ? '岩浆' : '水'}，没挖`); oreSkip.add(oreKey); continue; }
        const r = await digBlock(bot, ore).catch(e => ({ ok: false, why: e.message }));
        if (r.ok) { dug++; oreAttempts.delete(oreKey); await collectDrops(bot, 5); if (/coal/.test(ore.name) && torchCount(bot) < 16) await makeTorches(bot, 16, state); }
        else { log.push(r.why); const tries = (oreAttempts.get(oreKey) || 0) + 1; oreAttempts.set(oreKey, tries); if (tries >= 2) oreSkip.add(oreKey); if (r.needTool) { reason = r.why; break; } }
      } else {
        const tries = (oreAttempts.get(oreKey) || 0) + 1;
        oreAttempts.set(oreKey, tries);
        if (tries >= 2) oreSkip.add(oreKey);
      }
      continue;
    }

    // 3. 在矿洞里：逛
    if (inCave(bot) && caveMoves < 12) {
      const m = await caveStep(bot, D, ty);
      if (m) { caveMoves++; log.push(`矿洞里走到 (${m.to.x},${m.to.y},${m.to.z})`); const lu = await lightUp(bot, { max: 1, state }); if (lu.placed) log.push('矿洞里插了个火把'); continue; }
    }

    // 4. 挖楼梯往下 / 挖矿道往前（到了深度用鱼骨：主道每 3 格向左、向右各挖一条 BRANCH 格的支道，再回主道）
    //    主人 2026-09-27 问"挖矿方法是什么"：以前到深度后只一条直道，两侧各只露一格墙，效率低
    const f = bot.entity.position.floored();
    const goingDown = f.y > ty;
    const idxOf = (h) => DIRS.findIndex(d => d[0] === h[0] && d[1] === h[1]);
    if (!goingDown) {
      D.fb ||= { main: D.heading, phase: 'main', since: 0, len: 0, anchor: null, branches: 0 };
      const mi = idxOf(D.fb.main);
      D.heading = D.fb.phase === 'L' ? DIRS[(mi + 3) % 4] : D.fb.phase === 'R' ? DIRS[(mi + 1) % 4] : D.fb.main;
    }
    const endBranch = async () => {   // 支道挖完/挖不动：回到主道分叉处，换另一侧或接着挖主道
      const a = D.fb.anchor;
      if (a) await pathTo(bot, new Vec3(a.x, a.y, a.z), 0.6, 20000, { retry: false });
      if (D.fb.phase === 'L') { D.fb.phase = 'R'; D.fb.len = 0; } else { D.fb.phase = 'main'; D.fb.branches++; }
    };
    const [dx, dz] = D.heading;
    const cells = goingDown ? [f.offset(dx, 1, dz), f.offset(dx, 0, dz), f.offset(dx, -1, dz)] : [f.offset(dx, 1, dz), f.offset(dx, 0, dz)];
    const dest = goingDown ? f.offset(dx, -1, dz) : f.offset(dx, 0, dz);
    const floor = bot.blockAt(dest.offset(0, -1, 0));
    let why = null;
    if (isLiquid(floor)) why = `前面脚下是${/lava/.test(floor.name) ? '岩浆' : '水'}`;
    else if (airish(floor)) {
      // 前面脚下是空的：挖穿到洞里了。身上有圆石/泥土就垫一块接着走（像玩家搭路），不往下掉；
      // 以前坑不到 4 格就直接走下去 = 掉 1–3 格
      let depth = 1; while (depth < 6 && airish(bot.blockAt(dest.offset(0, -1 - depth, 0)))) depth++;
      let bridged = false;
      if (await ensureFiller(bot, state)) { try { bridged = await placeFiller(bot, dest.offset(0, -1, 0), state); } catch (_) {} }
      if (!bridged) depth = Math.max(depth, 4);   // 垫不上：当成坑，不走下去
      if (depth >= 4 && !bridged) {
        for (const c of cells) { why = await clearCell(bot, c); if (why) break; }   // 开个口看看下面
        const m = !why && await caveStep(bot, D, ty);
        if (m) { caveMoves++; log.push(`挖穿到矿洞，走到 (${m.to.x},${m.to.y},${m.to.z})`); continue; }
        why = why || `前面是 ${depth}+ 格深的坑，下不去`;
      }
    }
    if (!why) for (const c of cells) { why = await clearCell(bot, c); if (why) break; }
    if (!why && !await stepTo(bot, dest)) why = `挖开了但走不进 (${dest.x},${dest.y},${dest.z})`;
    if (why) {
      log.push(why);
      if (/镐子/.test(why)) { reason = why; break; }
      if (!goingDown && D.fb && D.fb.phase !== 'main') { await endBranch(); continue; }   // 支道挖不动：提前收这条
      D.heading = DIRS[(DIRS.findIndex(d => d[0] === dx && d[1] === dz) + 1 + (turns % 2) * 2) % 4];   // 右转，再不行掉头
      if (!goingDown && D.fb) D.fb.main = D.heading;
      if (++turns >= 4) { reason = `四个方向都挖不下去：${why}`; break; }
      continue;
    }
    turns = 0; D.steps++;
    D.visited.add(`${dest.x >> 2},${dest.y >> 2},${dest.z >> 2}`);
    if (!goingDown && D.fb) {
      if (D.fb.phase === 'main') {
        if (++D.fb.since >= 3) { D.fb.since = 0; D.fb.phase = 'L'; D.fb.len = 0; D.fb.anchor = { x: dest.x, y: dest.y, z: dest.z }; }
      } else if (++D.fb.len >= BRANCH) { await endBranch(); }
    }
    // 脚下暗了就插（读不到亮度时每 torchEvery 步插一个）
    if (!nearestLight(bot, torchEvery)) { if (await placeTorchHere(bot)) log.push('插了个火把'); }   // 身边 8 格没光源才插
    // 火把也可能在精妙背包里：先补到身上再判"用完了"（否则会误报、白跑一趟回去拿）
    if (!torchItem(bot) && state) await ensureCarried(bot, state, TORCH_SPEC, 1);
    if (!torchItem(bot)) { reason = '火把用完了，别再往暗处挖 —— 回去补火把'; break; }
  }
  if (!reason) reason = `时间到（${Math.round((Date.now() - t0) / 1000)} 秒），可以接着挖`;
  {
    const f = bot.entity.position.floored();
    D.last = bot.entity.position.clone(); D.deepest = Math.min(D.deepest ?? f.y, f.y);
    if (D.entry) { mines(state)[`${D.entry.x},${D.entry.y},${D.entry.z}`] = { entry: D.entry, last: { x: f.x, y: f.y, z: f.z }, heading: D.fb ? D.fb.main : D.heading, fb: D.fb || null, steps: D.steps, deepest: D.deepest, updated: Date.now() }; saveMines(state); }
  }
  const d = delta(invBefore, invCounts(bot));
  const p = bot.entity.position;
  return {
    ok: true, reason, at: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, fromY: Math.floor(y0), targetY: ty,
    entry: D.entry, deepest: D.deepest, resumed,
    method: D.fb ? `鱼骨：主道朝 ${['北', '东', '南', '西'][DIRS.findIndex(d => d[0] === D.fb.main[0] && d[1] === D.fb.main[1])]}，已挖 ${D.fb.branches} 对支道，现在在${D.fb.phase === 'main' ? '主道' : D.fb.phase === 'L' ? '左支道' : '右支道'}` : '挖楼梯往下',
    heading: D.heading, steps: D.steps, oresDug: dug, torchesLeft: torchCount(bot), gained: d.gained, chests: chests.length ? chests : undefined, log: log.slice(-8),
  };
}

function lightAt (bot, pos = bot.entity.position.floored()) {
  const b = bot.blockAt(pos);
  if (!b || b.light == null) return null;
  return { block: b.light, sky: b.skyLight ?? null };
}

const isDark = (l) => !!l && l.block < 8 && !(l.sky > 7);

const TORCH_SPEC = (it) => TORCH_RE.test(fullId(it.name));

const torchItem = (bot) => bot.inventory.items().find(i => TORCH_RE.test(i.name));

const torchCount = (bot) => bot.inventory.items().filter(i => TORCH_RE.test(i.name)).reduce((a, i) => a + i.count, 0);

/**
 * 火把不够就用身上的煤/木炭 + 木棍做（背包 2×2 就能做）。
 * 主人 2026-09-28：火把/煤/木板都可能躺在精妙背包里 —— 先按"随身物品"补齐（身上没有就从背包拿），
 * 不能因为"手里没有"就判"没有燃料"（N-9 日志里的 `没有燃料` ×5）。
 */
async function makeTorches (bot, want = 8, state = null) {
  if (state) await ensureCarried(bot, state, TORCH_SPEC, want);   // 背包里有火把就先拿出来
  const have = torchCount(bot);
  if (have >= want) return { torches: have };
  const count = (re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((a, i) => a + i.count, 0);
  const COAL_RE = /(^|:)(coal|charcoal)$/;
  // 煤/木炭不够 → 从背包拿（燃料可能在背包里）
  if (state && !count(COAL_RE)) await ensureCarried(bot, state, (it) => COAL_RE.test(fullId(it.name)), 1);
  const fuel = count(COAL_RE);
  if (!fuel) return { torches: have, note: '没有煤/木炭' };
  const times = Math.min(fuel, Math.ceil((want - have) / 4));
  // 木棍不够：木板做木棍（木板也不够就先把原木劈成木板）—— 玩家也是顺手这么做的
  // 木板 / 原木也可能在背包里：做之前先把它们拿到身上
  if (count(/(^|:)stick$/) < times) {
    if (state && count(/_planks$/) < 2) await ensureCarried(bot, state, (it) => /_planks$/.test(fullId(it.name)), 2);
    if (state && !count(/_log$/)) await ensureCarried(bot, state, (it) => /_log$/.test(fullId(it.name)) && !/stripped/.test(it.name), 1);
    try {
      if (count(/_planks$/) < 2) await craft2(bot, { itemName: bot.inventory.items().find(i => /_log$/.test(i.name) && !/stripped/.test(i.name))?.name.replace(/_log$/, '_planks') || 'minecraft:oak_planks', count: 4 }, plainTimeout);
      await craft2(bot, { itemName: 'minecraft:stick', count: Math.max(4, times) }, plainTimeout);
    } catch (e) { return { torches: have, note: `缺木棍，做木棍没成：${e.message}` }; }
  }
  try { await craft2(bot, { itemName: 'minecraft:torch', count: times * 4 }, plainTimeout); } catch (e) { return { torches: torchCount(bot), note: `做火把没成：${e.message}` }; }
  return { torches: torchCount(bot), made: torchCount(bot) - have };
}

async function placeTorchHere (bot) {
  const t = torchItem(bot);
  if (!t) return false;
  const f = bot.entity.position.floored();
  try {
    await bot.equip(t, 'hand');
    const under = bot.blockAt(f.offset(0, -1, 0));
    if (under && under.boundingBox === 'block') { await plainTimeout(bot.placeBlock(under, new Vec3(0, 1, 0)), 5000); return true; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wall = bot.blockAt(f.offset(dx, 1, dz));
      if (wall && wall.boundingBox === 'block') { await plainTimeout(bot.placeBlock(wall, new Vec3(-dx, 0, -dz)), 5000); return true; }
    }
  } catch (_) {}
  return false;
}

function nearestLight (bot, r = 7) {
  if (lightIdsRegistry !== bot.registry) {
    lightIdsRegistry = bot.registry;
    lightIdsCache = Object.values(bot.registry.blocksByName).filter(b => LIGHT_RE.test(b.name) && !/redstone_torch/.test(b.name)).map(b => b.id);
  }
  const ids = lightIdsCache;
  const p = bot.findBlock({ matching: ids, maxDistance: r });
  return p ? { name: p.name, at: doorKey(p.position), distance: +p.position.distanceTo(bot.entity.position).toFixed(1) } : null;
}

/**
 * 点亮身边：像玩家一样按间距插 —— 身边 7 格内已经有光源就不插；没有就插一个，插完就停。
 * 以前按亮度判断：矿道口照得到天光（天空光 11）就判"够亮"一根不插；她觉得不对就换着工具反复插，
 * 主人说"也不用一直插吧"（2026-09-27）。亮度读数还有延迟，插完马上读仍是暗，一次会连插好几个。
 */
async function lightUp (bot, { max = 1, force = false, spacing = 7, state = null } = {}) {
  let placed = 0;
  const near = nearestLight(bot, spacing);
  if (near && !force) return { placed: 0, alreadyLit: near, torchesLeft: torchCount(bot), note: `${spacing} 格内已经有光源，不用再插` };
  if (state && !torchItem(bot)) await ensureCarried(bot, state, TORCH_SPEC, Math.max(1, max));   // 火把在背包里就先拿出来
  for (let i = 0; i < Math.min(max, 3); i++) {
    if (!torchItem(bot)) break;
    if (!await placeTorchHere(bot)) break;
    placed++;
    if (i + 1 < max) { const moved = nearestLight(bot, spacing); if (moved) break; }   // 插一个就够照这片
  }
  return { placed, torchesLeft: torchCount(bot) };
}

const isFiller = (name) => FILLER_RE.test(fullId(name)) || scaffoldIds().includes(fullId(name));   // 和搭脚方块同一份名单（含草方块、模组泥土石头）

const fillerItem = (bot) => bot.inventory.items().filter(i => isFiller(i.name)).sort((a, b) => b.count - a.count)[0]
  || bot.inventory.items().find(i => /_planks$/.test(i.name));

/**
 * 垫脚方块也可能在精妙背包里（N-9）—— 身上没有就从背包拿一把。
 * 拿的是 `isFiller` 认可的任意一种（含模组泥土石头、草方块）。
 */
async function ensureFiller (bot, state, want = Infinity) {
  if (!state || fillerItem(bot)) return fillerItem(bot);
  await ensureCarried(bot, state, (it) => isFiller(it.name), want);
  // 木板也算能垫（placeFiller 的兜底名单）：上面拿不到时再试木板
  if (!fillerItem(bot)) await ensureCarried(bot, state, (it) => /_planks$/.test(fullId(it.name)), want === Infinity ? 16 : want);
  return fillerItem(bot);
}

async function placeFiller (bot, pos, state = null) {
  if (!airish(bot.blockAt(pos))) return true;
  const it = state ? await ensureFiller(bot, state) : fillerItem(bot);
  if (!it) throw new Error('身上没有能垫的方块（圆石/泥土/花岗岩…）');
  await bot.equip(it, 'hand');
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (ref && ref.boundingBox === 'block') {
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true; } catch (_) {}
    }
  }
  return false;
}

const ORE_RE = /(_ore|ancient_debris)$/;

const ORE_Y = { coal: 48, copper: 48, iron: 16, lapis: 0, gold: -16, redstone: -58, diamond: -58, emerald: 100 };

const LIGHT_RE = /torch|lantern|campfire|glowstone|sea_lantern|shroomlight|froglight|jack_o_lantern|redstone_lamp|end_rod|candle/;

const TORCH_RE = /(^|:)torch$/;

const FILLER_RE = /(^|:)(cobblestone|cobbled_deepslate|dirt|coarse_dirt|granite|diorite|andesite|netherrack|tuff|calcite|stone|deepslate|blackstone|basalt|end_stone|mossy_cobblestone|cobbled_\w+)$/;

const BUILT_RE = /planks|_stairs|_slab|door|glass|brick|wool|carpet|chest|barrel|torch|lantern|ladder|fence|_bed$|crafting_table|furnace/;

let oreIdsCache = null; let oreIdsRegistry = null;
// 1.20 原版矿石数量最多的高度（分布峰值）；模组矿、没写目标就按铁

let lightIdsCache = null; let lightIdsRegistry = null;

const BRANCH = 8;   // 鱼骨支道长度（主道每 3 格一对，支道间隔 2 格实心：1×2 通道两侧各露一格，正好不漏）

module.exports = { BRANCH, BUILT_RE, FILLER_RE, LIGHT_RE, ORE_RE, ORE_Y, TORCH_RE, TORCH_SPEC, bind, caveStep, clearCell, delve, digBlock, ensureFiller, fillerItem, inCave, isDark, isFiller, lightAt, lightIdsCache, lightIdsRegistry, lightUp, makeTorches, mines, nearestLight, oreIdsCache, oreIdsRegistry, placeFiller, placeTorchHere, saveMines, sensedOres, stepTo, torchCount, torchItem, tunnelTo, visibleOres };
