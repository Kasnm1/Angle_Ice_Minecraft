'use strict';

/**
 * 开门 —— 寻路经过**关着的门**时，把这一格当"可走"并安排一次右键。
 *
 * 2026-09-29 第 3 步重构从 `src/world/pathing.js` 原样搬出（函数体一字未改）。
 */

/** 门格放行，门板的横向碰撞在 getNeighbors 的有向边上判断。 */
const DOOR_NAME_RE = /(^|_)door$/;

/** 方块的属性表。`getProperties()` 优先，退回 `_properties`。读不到返回 null。 */
function blockProps (b) {
  try {
    const p = typeof b.getProperties === 'function' ? b.getProperties() : (b._properties || b.properties);
    return p || null;
  } catch (_) { return null; }
}

/** 方块的 open 属性（服务器发来的值是字符串，有时大写 —— 一律按字符串比） */
function isOpenBlock (b) {
  const props = blockProps(b);
  const v = props && Object.entries(props).find(([k]) => k.toLowerCase() === 'open')?.[1];
  return String(v).toLowerCase() === 'true';
}

/**
 * 开着的门板在**哪根轴**上挡人。
 *
 * 门板法线 = 与 `facing` 垂直的那根轴：`facing=north/south` → 门板法线是 X（挡东西向），
 * `facing=east/west` → 是 Z（挡南北向）。这是 MC 的 `DoorBlock.getShape` 的分支表：
 * 关着时门板垂直于 facing（挡门洞方向），开着时转过 90° → 垂直于 facing 的那根轴。
 *
 * 读不到 facing 返回 **null**（"不知道"，不是"没有"）—— 调用方据此保持放行并计数。
 */
function doorPlateAxis (b) {
  const props = blockProps(b);
  const f = props && Object.entries(props).find(([k]) => k.toLowerCase() === 'facing')?.[1];
  const v = String(f || '').toLowerCase();
  if (v === 'north' || v === 'south') return 'x';
  if (v === 'east' || v === 'west') return 'z';
  return null;
}

/**
 * 这一格她走不走得进去。判据与 `movements.getBlock` 的 `safe` **同源**（没有碰撞即可走），
 * 但**故意不看**门那条豁免 —— 否则"双开门"里两个门格会互相证明对方可走，
 * 闸门就形同虚设。取的是保守那一侧。
 */
function applyOpenDoors (mv, bot = null) {
  if (!mv || typeof mv.getBlock !== 'function') throw new Error('applyOpenDoors: 需要 Movements 实例');
  if (mv.__openDoorsPatched) return { installed: true, already: true, stats: mv.__openDoorsStats };
  const orig = mv.getBlock.bind(mv);
  // `stats` 是**活对象**：调用方拿到的引用会一直更新（和 applyUnknownBlockPolicy 的 stats 同理）。
  const stats = { passed: 0, refused: 0, noFacing: 0, refusedAt: [], closedOpenable: 0, reroutes: 0, blockedAt: [] };
  const blockedEdges = new Map();
  const edgeKey = (a, b) => `${a.x},${a.y},${a.z}>${b.x},${b.y},${b.z}`;
  mv.canOpenDoors = true;
  mv.getBlock = function (pos, dx, dy, dz) {
    const b = orig(pos, dx, dy, dz);
    if (!b || !b.name || !DOOR_NAME_RE.test(bareName(b.name))) return b;
    if (!isOpenBlock(b)) {
      if (/iron/.test(bareName(b.name))) return b;
      const half = String(blockProps(b)?.half || '').toLowerCase();
      if (half === 'upper') {
        // pathfinder 先检查头部，再处理下半格的 useOne；上半格不能先把路堵死。
        b.safe = true;
        b.physical = false;
        return b;
      }
      b.openable = true;
      // 模组调色板有些门缺形状；非空形状是库触发 useOne 的必要条件。
      if (!b.shapes?.length) b.shapes = [[0, 0, 0, 1, 1, 1]];
      stats.closedOpenable++;
      return b;
    }
    if (!doorPlateAxis(b)) stats.noFacing++;
    // 开门后门洞可走；不能横穿门板的约束由下方 getNeighbors 检查整条边。
    b.safe = true;
    b.physical = false;
    b.height = pos.y + dy;
    stats.passed++;
    return b;
  };
  if (typeof mv.getNeighbors === 'function') {
    const originalNeighbors = mv.getNeighbors.bind(mv);
    mv.getNeighbors = function (node) {
      const sourceBlock = orig(node, 0, 0, 0);
      return originalNeighbors(node).filter(next => {
        const key = edgeKey(node, next);
        const until = blockedEdges.get(key);
        if (until) {
          if (until > Date.now()) return false;
          blockedEdges.delete(key);
        }
        const dx = next.x - node.x;
        const dz = next.z - node.z;
        if (!dx && !dz) return true;
        if (dx && dz) {
          // 库的斜走只要求两个转角有一边能走；门板、立起的活板门有真实厚度，
          // 贴角抄近路会在门框反复撞停。门口统一走正交格，再由当前格重新规划。
          const corners = [
            { x: node.x + dx, y: node.y, z: node.z },
            { x: node.x, y: node.y, z: node.z + dz },
            { x: node.x + dx, y: node.y + 1, z: node.z },
            { x: node.x, y: node.y + 1, z: node.z + dz },
          ];
          if (corners.some(p => /(^|_)(trap)?door$/.test(bareName(orig(p, 0, 0, 0)?.name)))) {
            stats.refused++;
            return false;
          }
        }
        for (const [p, b] of [[node, sourceBlock], [next, orig(next, 0, 0, 0)]]) {
          if (!b?.name || !DOOR_NAME_RE.test(bareName(b.name))) continue;
          const axis = doorPlateAxis(b);
          if (axis && (axis === 'x' ? dx : dz)) {
            stats.refused++;
            if (stats.refusedAt.length < 8) stats.refusedAt.push({ x: p.x, y: p.y, z: p.z, name: b.name, axis });
            return false;
          }
        }
        return true;
      });
    };
  }
  if (bot?.on && bot?.entity) {
    let livePath = null;
    const { Vec3 } = require('vec3');
    bot.on('path_update', result => { if (result?.path?.length) livePath = result.path; });
    bot.on('path_reset', reason => {
      if (reason !== 'stuck' || !livePath?.length || !bot.entity?.position) return;
      const from = bot.entity.position.floored();
      const next = livePath[0];
      livePath = null;
      if (Math.abs(next.x - from.x) > 1 || Math.abs(next.z - from.z) > 1 || Math.abs(next.y - from.y) > 1) return;
      // 只给门口的停滞边记短期禁行；普通障碍交给库原有的重规划。
      let nearDoor = false;
      for (const p of [from, next, { x: from.x, y: from.y, z: next.z }, { x: next.x, y: from.y, z: from.z }]) {
        for (const y of [p.y, p.y + 1]) {
          const b = bot.blockAt(new Vec3(p.x, y, p.z));
          if (/(^|_)(trap)?door$/.test(bareName(b?.name))) nearDoor = true;
        }
      }
      if (!nearDoor) return;
      blockedEdges.set(edgeKey(from, next), Date.now() + 20000);
      stats.reroutes++;
      if (stats.blockedAt.length >= 8) stats.blockedAt.shift();
      stats.blockedAt.push({ from: `${from.x},${from.y},${from.z}`, to: `${next.x},${next.y},${next.z}` });
    });
  }
  mv.__openDoorsPatched = true;
  mv.__openDoorsStats = stats;
  return { installed: true, stats };
}

// ---- 跨文件名字（第 3 步重构）------------------------------------------------
//
// 拆之前所有顶层声明都在**一个作用域**里，谁先谁后都无所谓；拆开之后本文件用到的
// 隔壁名字必须靠汇总 `index.js` 在**所有子文件都加载完**之后 `bind()` 回来，
// 否则 require 期就 `ReferenceError`（见 src/body/AGENTS.md「循环依赖」那段）。
const __ns = {};
function applyUnknownBlockPolicy (...a) { return __ns.applyUnknownBlockPolicy.apply(null, a); }
function bareName (...a) { return __ns.bareName.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); }

module.exports = {
  applyOpenDoors,
  bind,
};
