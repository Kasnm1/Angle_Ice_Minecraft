'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「build」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3
const paths = require('../paths');
const PROJ_FILE = require('path').join(paths.MEMORY, 'projects.json');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补
const LAYOUT_FILE = process.env.MC_LAYOUT_FILE || require('path').join(paths.MEMORY, 'layouts.json');   // MC_LAYOUT_FILE：测试用，别写进真的规划（拆分时漏搬，2026-09-29 补）

// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleep } = require('../util/time');
const __ns = {};
let BUILT_RE, FURNITURE_RE, N6;   // 常量：load 完成后由 bind() 回填
function airish (...a) { return __ns.airish.apply(null, a); }
function bareId (...a) { return __ns.bareId.apply(null, a); }
function isDoorLike (...a) { return __ns.isDoorLike.apply(null, a); }
function isLiquid (...a) { return __ns.isLiquid.apply(null, a); }
function pathTo (...a) { return __ns.pathTo.apply(null, a); }
function plainTimeout (...a) { return __ns.plainTimeout.apply(null, a); }
function surveyChar (...a) { return __ns.surveyChar.apply(null, a); }
function threatNear (...a) { return __ns.threatNear.apply(null, a); }
// 挖之前挑工具（2026-09-29）：判据在 tool-choice.js，只有那一份
function equipDigTool (...a) { return __ns.equipDigTool.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); BUILT_RE = ns.BUILT_RE; FURNITURE_RE = ns.FURNITURE_RE; N6 = ns.N6; }

function projects (state) {
  if (!state.__projects) { try { state.__projects = JSON.parse(require('fs').readFileSync(PROJ_FILE, 'utf8')); } catch (_) { state.__projects = {}; } }
  return state.__projects;
}

function saveProjects (state) {
  try { const fs = require('fs'); const tmp = PROJ_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__projects || {}, null, 1)); fs.renameSync(tmp, PROJ_FILE); } catch (_) {}
}

function projectSave (bot, state, bp = {}) {
  if (!bp.name || !bp.origin || !bp.legend || !Array.isArray(bp.layers)) throw new Error('蓝图要有 name、origin{x,y,z}、legend、layers[{dy,rows}]');
  const bad = Object.entries(bp.legend).filter(([, id]) => id !== 'air' && !bot.registry.blocksByName[bareId(id)] && !bot.registry.blocksByName[id]).map(([ch, id]) => `${ch}=${id}`);
  if (bad.length) throw new Error(`图例里这些方块不存在：${bad.join(' ')}（用真实注册名）`);
  let cells = 0; const mats = {};
  for (const L of bp.layers) {
    if (!Array.isArray(L.rows)) throw new Error('每层要有 rows');
    if (L.rows.length > 24 || L.rows.some(r => String(r).length > 24)) throw new Error('太大了：一层最多 24×24');
    for (const row of L.rows) for (const ch of String(row)) { const id = bp.legend[ch]; if (!id) continue; cells++; if (id !== 'air') mats[bareId(id)] = (mats[bareId(id)] || 0) + 1; }
  }
  if (bp.layers.length > 16) throw new Error('太高了：最多 16 层');
  const id = bp.id || `p${Date.now().toString(36)}`;
  const P = projects(state);
  P[id] = { ...bp, id, asked: !!bp.asked, origin: { x: Math.floor(bp.origin.x), y: Math.floor(bp.origin.y), z: Math.floor(bp.origin.z) }, created: P[id]?.created || Date.now(), updated: Date.now(), status: 'active' };
  saveProjects(state);
  return { id, name: bp.name, cells, materials: mats };
}

function projectCells (p) {
  const out = [];
  for (const L of p.layers) {
    L.rows.forEach((row, dz) => [...String(row)].forEach((ch, dx) => {
      const want = p.legend[ch]; if (!want) return;
      out.push({ pos: new Vec3(p.origin.x + dx, p.origin.y + (+L.dy || 0), p.origin.z + dz), want: want === 'air' ? 'air' : bareId(want) });
    }));
  }
  return out;
}

function projectDiff (bot, p) {
  const dig = []; const place = []; let ok = 0; let unknown = 0;
  for (const c of projectCells(p)) {
    const b = bot.blockAt(c.pos);
    if (!b) { unknown++; continue; }
    const here = bareId(b.name);
    if (c.want === 'air') {
      if (b.boundingBox === 'empty' && !isLiquid(b)) ok++; else dig.push(c);
    } else if (here === c.want) ok++;
    else if (airish(b) || /^(short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|vine)$/.test(here)) place.push(c);
    else { dig.push({ ...c, thenPlace: true }); }
  }
  const total = ok + dig.length + place.length;
  return { dig, place, ok, unknown, total, pct: total ? Math.round(ok * 100 / total) : 0 };
}

function invCount (bot, id) { return bot.inventory.items().filter(i => bareId(i.name) === id).reduce((a, i) => a + i.count, 0); }

function projectStatus (bot, state, { id } = {}) {
  const P = projects(state);
  const list = id ? [P[id]].filter(Boolean) : Object.values(P).filter(p => p.status === 'active');
  if (id && !list.length) throw new Error(`没有工程 ${id}`);
  return {
    projects: list.map(p => {
      const d = projectDiff(bot, p);
      const need = {}; for (const c of [...d.place, ...d.dig.filter(x => x.thenPlace)]) need[c.want] = (need[c.want] || 0) + 1;
      const missing = {}; for (const [k, n] of Object.entries(need)) { const h = invCount(bot, k); if (h < n) missing[k] = n - h; }
      const digWhat = {}; for (const c of d.dig) { const n = bareId(bot.blockAt(c.pos)?.name); digWhat[n] = (digWhat[n] || 0) + 1; }
      return { id: p.id, name: p.name, purpose: p.purpose, origin: p.origin, done: `${d.pct}%`, toDig: d.dig.length, digWhat, toPlace: d.place.length + d.dig.filter(x => x.thenPlace).length, notLoaded: d.unknown, need, missing };
    }),
  };
}

async function placeAt (bot, pos, id, mount) {
  const it = bot.inventory.items().find(i => bareId(i.name) === id);
  if (!it) return { ok: false, missing: true };
  if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand');
  const faces = mount === 'wall' ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]
    : mount === 'ceiling' ? [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
    : [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const [dx, dy, dz] of faces) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try { await plainTimeout(bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)), 5000); } catch (_) { await sleep(150); }
    const b = bot.blockAt(pos);
    if (b && bareId(b.name) === id) return { ok: true };
  }
  return { ok: false, why: '找不到能贴的面或放不上' };
}

async function projectWork (bot, state, { id, maxMs = 90000, maxOps = 60 } = {}) {
  const P = projects(state); const p = id ? P[id] : Object.values(P).find(x => x.status === 'active');
  if (!p) throw new Error(id ? `没有工程 ${id}` : '没有进行中的工程（先 design_build）');
  // 还没动过工：不是主人要的、材料又不到七成 → 先不开工（开了只会留一排坑等材料）。已经开工的照常接着做
  if (!p.started && !p.asked) {
    const d0 = projectDiff(bot, p);
    const need = {}; for (const c of [...d0.place, ...d0.dig.filter(x => x.thenPlace)]) need[c.want] = (need[c.want] || 0) + 1;
    const total = Object.values(need).reduce((a, n) => a + n, 0);
    const have = Object.entries(need).reduce((a, [k, n]) => a + Math.min(n, invCount(bot, k)), 0);
    if (total && have / total < START_COVER) {
      const miss = Object.entries(need).filter(([k, n]) => invCount(bot, k) < n).map(([k, n]) => `${k}×${n - invCount(bot, k)}`);
      return { ok: false, notStarted: true, cover: Math.round(have * 100 / total), error: `材料只够 ${Math.round(have * 100 / total)}%（要七成才开工，不先挖坑等材料）；还缺 ${miss.slice(0, 6).join('、')}。主人要你马上盖的话，design_build 时写 asked:true` };
    }
  }
  p.started ||= Date.now();
  const t0 = Date.now(); const skip = new Set(); const placed = {}; let dug = 0; let ops = 0; const missing = {}; let reason = null; const protectedCells = [];
  const key = (v) => `${v.x},${v.y},${v.z}`;
  const me = () => bot.entity.position;
  const reachOK = (pos) => me().offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.3;
  const onMe = (pos) => { const f = me().floored(); return pos.x === f.x && pos.z === f.z && (pos.y === f.y || pos.y === f.y + 1); };
  const goNear = async (pos) => { if (reachOK(pos) && !onMe(pos)) return true; await pathTo(bot, pos, 3, 15000, { retry: false }); return reachOK(pos) && !onMe(pos); };
  while (Date.now() - t0 < maxMs && ops < maxOps) {
    if (bot.health < 8) { reason = `血只剩 ${Math.round(bot.health)}`; break; }
    const mob = threatNear(bot, state, me());
    if (mob) { reason = `${mob.name} 靠近了`; break; }
    const d = projectDiff(bot, p);
    if (!d.dig.length && !d.place.length) { if (!d.unknown) { p.status = 'done'; p.doneAt = Date.now(); saveProjects(state); reason = '完工了'; } else reason = `还有 ${d.unknown} 格没加载，走近点再看`; break; }
    // ① 先挖（从上往下，近的先）
    // 人造方块（木板、楼梯、门、玻璃…）默认不拆：设计没看清压到了房子上，照做就会拆家（实测南门石径要拆 3 块云杉木板）。
    // 工程写了 allowDemolish（明确要改造自己的建筑）才拆
    for (const c of d.dig) { const b = bot.blockAt(c.pos); if (!p.allowDemolish && b && BUILT_RE.test(b.name) && !skip.has(key(c.pos))) { skip.add(key(c.pos)); protectedCells.push(`${bareId(b.name)}(${key(c.pos)})`); } }
    // 要"挖掉换成别的"的格子：手上有替换材料才挖，不然挖出一个坑就走了（实测门口留了 4 个坑）
    for (const c of d.dig) if (c.thenPlace && !invCount(bot, c.want)) missing[c.want] = (missing[c.want] || 0) + 1;
    const dig = d.dig.filter(c => !skip.has(key(c.pos)) && !(c.thenPlace && !invCount(bot, c.want))).sort((a, b) => (b.pos.y - a.pos.y) || (a.pos.distanceTo(me()) - b.pos.distanceTo(me())))[0];
    if (dig) {
      if (!await goNear(dig.pos)) { skip.add(key(dig.pos)); continue; }
      const b = bot.blockAt(dig.pos);
      const wet = N6.map(([dx, dy, dz]) => bot.blockAt(dig.pos.offset(dx, dy, dz))).find(isLiquid);
      if (wet) { skip.add(key(dig.pos)); continue; }
      if (b && !b.diggable) { skip.add(key(dig.pos)); continue; }
      // 挖之前挑工具（2026-09-29）：以前是 bestHarvestTool（只看身上，模组方块会挑错）。
      // equipDigTool 挑不出来就照旧 —— 见 tool-choice.js。
      await equipDigTool(bot, b);
      try { await bot.lookAt(dig.pos.offset(0.5, 0.5, 0.5), true); await plainTimeout(bot.dig(b, true), 15000); dug++; ops++; } catch (_) { skip.add(key(dig.pos)); }
      continue;
    }
    // ② 再放（从下往上，有支撑的先，近的先；身上没有的记进 missing）
    const cand = d.place.filter(c => !skip.has(key(c.pos)))
      .filter(c => N6.some(([dx, dy, dz]) => { const n = bot.blockAt(c.pos.offset(dx, dy, dz)); return n && n.boundingBox === 'block'; }))
      .sort((a, b) => (a.pos.y - b.pos.y) || (a.pos.distanceTo(me()) - b.pos.distanceTo(me())));
    const next = cand.find(c => invCount(bot, c.want) > 0);
    for (const c of cand) if (!invCount(bot, c.want)) missing[c.want] = (missing[c.want] || 0) + 1;
    if (!next) { reason = Object.keys(missing).length ? '手上的材料用完了（缺的见 missing）' : '剩下的格子暂时够不着/没支撑'; break; }
    if (!await goNear(next.pos)) { skip.add(key(next.pos)); continue; }
    const r = await placeAt(bot, next.pos, next.want);
    if (r.ok) { placed[next.want] = (placed[next.want] || 0) + 1; ops++; } else skip.add(key(next.pos));
  }
  if (!reason) reason = ops >= maxOps ? '这一段干完了，接着调就继续' : '时间到，接着调就继续';
  p.updated = Date.now(); saveProjects(state);
  const after = projectDiff(bot, p);
  return { id: p.id, name: p.name, done: `${after.pct}%`, placed, dug, missing: Object.keys(missing).length ? missing : undefined, skipped: skip.size || undefined,
    keptBuilt: protectedCells.length ? { cells: protectedCells.slice(0, 10), note: '这几格是人造的，没拆（要改造自己的建筑，设计时写 allowDemolish:true）' } : undefined, reason };
}

function layouts (state) {
  if (!state.__layouts) { try { state.__layouts = JSON.parse(require('fs').readFileSync(LAYOUT_FILE, 'utf8')); } catch (_) { state.__layouts = {}; } }
  return state.__layouts;
}

function saveLayouts (state) {
  try { const fs = require('fs'); const tmp = LAYOUT_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__layouts || {}, null, 1)); fs.renameSync(tmp, LAYOUT_FILE); } catch (_) {}
}

const allSlots = (L) => (L.zones || []).flatMap(z => (z.slots || []).map(sl => ({ ...sl, zone: z.name })));

// ------------------------------------------------------------------ 分区（现用现定，主人 2026-09-27）
//
// 以前的规划给"以后才会有的东西"先定好精确到格子的位置 —— 赶不上变化：主人改了墙、她想法变了，格子还占着。
// 现在规划只记**分区**：{ name, purpose, wants:{物品:数量}, area:{x,y,z,r} }。东西真到手了，
// place_nicely 才在这个区里看布局、当场挑格子（body.js）。区里放不下了 / 被改建了 → stale（"要重新想"），下次需要时再划。
// 旧的带格子的规划照样能读：格子只用来推出分区的范围和想要的东西，不再按格子摆。
function zoneArea (z) {
  if (z.area && Number.isFinite(+z.area.x)) return { x: +z.area.x, y: +z.area.y, z: +z.area.z, r: Math.min(8, Math.max(2, +z.area.r || 3)) };
  const sl = z.slots || [];
  if (!sl.length) return null;
  const c = sl.reduce((a, q) => ({ x: a.x + q.x / sl.length, y: a.y + q.y / sl.length, z: a.z + q.z / sl.length }), { x: 0, y: 0, z: 0 });
  const r = Math.max(...sl.map(q => Math.hypot(q.x - c.x, q.z - c.z))) + 1;
  return { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z), r: Math.min(8, Math.max(2, Math.ceil(r))) };
}

function zoneWants (z) {
  if (z.wants && typeof z.wants === 'object') return Object.fromEntries(Object.entries(z.wants).map(([k, n]) => [bareId(k), Math.max(1, +n || 1)]));
  const w = {}; for (const sl of z.slots || []) w[bareId(sl.item)] = (w[bareId(sl.item)] || 0) + 1;
  return w;
}

function zonePresent (bot, z, wants = zoneWants(z)) {
  const a = zoneArea(z); const out = {};
  if (!a) return out;
  const ids = Object.keys(wants).map(k => bot.registry.blocksByName[k]?.id).filter(v => v != null);
  if (!ids.length) return out;
  for (const p of bot.findBlocks({ point: new Vec3(a.x, a.y, a.z), matching: ids, maxDistance: a.r + 2, count: 200 })) {
    if (Math.abs(p.y - a.y) > 2 || Math.hypot(p.x - a.x, p.z - a.z) > a.r + 0.5) continue;
    const n = bareId(bot.blockAt(p)?.name); out[n] = (out[n] || 0) + 1;
  }
  return out;
}

function zoneFreeFloor (bot, z) {
  const a = zoneArea(z); if (!a) return 0;
  let n = 0;
  for (let dx = -a.r; dx <= a.r; dx++) for (let dz = -a.r; dz <= a.r; dz++) {
    if (Math.hypot(dx, dz) > a.r) continue;
    for (const dy of [0, -1, 1]) {
      const p = new Vec3(a.x + dx, a.y + dy, a.z + dz);
      const b = bot.blockAt(p); const up = bot.blockAt(p.offset(0, 1, 0)); const dn = bot.blockAt(p.offset(0, -1, 0));
      if (b && up && dn && airish(b) && airish(up) && dn.boundingBox === 'block') { n++; break; }
    }
  }
  return n;
}

function zoneMark (state, { id, zone, stale = true, why = '' } = {}) {
  const LS = layouts(state); const L = id ? LS[id] : Object.values(LS).sort((a, b) => b.updated - a.updated)[0];
  if (!L) throw new Error('没有布置规划');
  const z = (L.zones || []).find(q => q.name === zone);
  if (!z) throw new Error(`规划里没有「${zone}」这个区`);
  if (stale) z.stale = { why: String(why).slice(0, 80), at: Date.now() }; else delete z.stale;
  L.updated = Date.now(); saveLayouts(state);
  return { id: L.id, zone: z.name, stale: !!z.stale };
}

function slotState (bot, sl) {
  const b = bot.blockAt(new Vec3(sl.x, sl.y, sl.z));
  if (!b) return 'unknown';
  if (bareId(b.name) === bareId(sl.item)) return 'done';
  if (airish(b) || /^(short_grass|grass|tall_grass|fern|snow|carpet)$/.test(bareId(b.name))) return 'empty';
  return 'taken';
}

function layoutSave (bot, state, L = {}) {
  if (!L.name || !Array.isArray(L.zones) || !L.zones.length) throw new Error('规划要有 name 和 zones[{name,purpose,wants:{物品:数量},area:{x,y,z,r}}]');
  // 新格式（现用现定）：只有分区、没有格子 —— 核对：想要的东西是真方块、范围里有能放东西的地面
  if (L.zones.every(z => !Array.isArray(z.slots) || !z.slots.length)) {
    const rejected = [];
    L.zones = L.zones.filter(z => {
      const bad = Object.keys(zoneWants(z)).filter(k => !bot.registry.blocksByName[k]);
      if (bad.length) { rejected.push(`${z.name}：没有这些方块 ${bad.join(' ')}`); return false; }
      if (!zoneArea(z)) { rejected.push(`${z.name}：没写范围 area`); return false; }
      if (!zoneFreeFloor(bot, z)) { rejected.push(`${z.name}：范围里没有能放东西的空地`); return false; }
      delete z.stale;
      return true;
    });
    if (!L.zones.length) throw new Error(`一个区都不合格：${rejected.join('；')}`);
    const id = L.id || `L${Date.now().toString(36)}`;
    const LS = layouts(state);
    LS[id] = { ...L, id, created: LS[id]?.created || Date.now(), updated: Date.now() };
    saveLayouts(state);
    return { id, name: L.name, zones: L.zones.length, rejected: rejected.length ? rejected : undefined };
  }
  const cx = L.area || allSlots(L)[0];
  const sv = survey(bot, { x: cx.x, y: cx.y, z: cx.z, r: Math.min(12, L.area?.r || 10) });
  const clear = new Set(sv.keepClear || []);
  const rejected = []; let kept = 0; const used = new Set();
  for (const z of L.zones) {
    z.slots = (z.slots || []).filter(sl => {
      const why = (m) => { rejected.push(`${bareId(sl.item)}@(${sl.x},${sl.y},${sl.z})：${m}`); return false; };
      sl.x = Math.floor(sl.x); sl.y = Math.floor(sl.y); sl.z = Math.floor(sl.z);
      const k = `${sl.x},${sl.y},${sl.z}`;
      if (!bot.registry.blocksByName[bareId(sl.item)] && !bot.registry.blocksByName[sl.item]) return why('没有这个方块');
      if (used.has(k)) return why('和别的格子重了'); used.add(k);
      const st = slotState(bot, sl);
      if (st === 'taken') return why(`那里已经有 ${bareId(bot.blockAt(new Vec3(sl.x, sl.y, sl.z)).name)}`);
      if (clear.has(k) && !/torch|lantern/.test(sl.item)) return why('在路上（门口/梯子口/走道）');
      const p = new Vec3(sl.x, sl.y, sl.z);
      const under = bot.blockAt(p.offset(0, -1, 0));
      const anySolid = N6.some(([dx, dy, dz]) => { const n = bot.blockAt(p.offset(dx, dy, dz)); return n && n.boundingBox === 'block'; });
      if (st !== 'done' && !anySolid) return why('悬空，旁边没东西能贴');
      if (st !== 'done' && (sl.mount || 'floor') === 'floor' && !(under && under.boundingBox === 'block')) return why('下面不是实心的');
      kept++; return true;
    });
  }
  if (!kept) throw new Error(`一个格子都不合格：${rejected.slice(0, 8).join('；')}`);
  const id = L.id || `L${Date.now().toString(36)}`;
  const LS = layouts(state);
  LS[id] = { ...L, id, created: LS[id]?.created || Date.now(), updated: Date.now() };
  saveLayouts(state);
  return { id, name: L.name, slots: kept, rejected: rejected.length ? rejected.slice(0, 12) : undefined };
}

function layoutStatus (bot, state, { id, full } = {}) {
  const LS = layouts(state);
  if (id && full && LS[id]) return { full: LS[id] };
  const list = id ? [LS[id]].filter(Boolean) : Object.values(LS);
  return {
    layouts: list.map(L => {
      // 按分区算（现用现定）：想要什么、已经有了多少、手上能摆什么、还剩几格空地、要不要重新想
      const zones = (L.zones || []).map(z => {
        const wants = zoneWants(z); const present = zonePresent(bot, z, wants);
        const still = {}; for (const [k, n] of Object.entries(wants)) if ((present[k] || 0) < n) still[k] = n - (present[k] || 0);
        const free = zoneFreeFloor(bot, z);
        const stale = z.stale ? z.stale.why || '标过要重新想' : (Object.keys(still).length && !free ? '区里没地方了' : null);
        return { name: z.name, purpose: z.purpose || '', area: zoneArea(z), wants, present, stillWant: still, canPlaceNow: Object.keys(still).filter(k => invCount(bot, k) > 0), freeFloor: free, stale };
      });
      const tot = (o) => Object.values(o).reduce((a, n) => a + n, 0);
      const stillAll = {}; for (const z of zones) for (const [k, n] of Object.entries(z.stillWant)) stillAll[k] = (stillAll[k] || 0) + n;
      return {
        id: L.id, name: L.name,
        zones: zones.map(z => `${z.name}（${z.purpose}）：${tot(z.wants) - tot(z.stillWant)}/${tot(z.wants)}${z.stale ? `，要重新想：${z.stale}` : ''}`),
        zoneDetail: zones,
        done: zones.reduce((a, z) => a + tot(z.wants) - tot(z.stillWant), 0), total: zones.reduce((a, z) => a + tot(z.wants), 0),
        stillWant: stillAll, canPlaceNow: [...new Set(zones.flatMap(z => z.canPlaceNow))], stale: zones.filter(z => z.stale).map(z => z.name),
      };
    }),
  };
}

function layoutStatusSlots (bot, state, list) {
  return {
    layouts: list.map(L => {
      const slots = allSlots(L).map(sl => ({ ...sl, state: slotState(bot, sl) }));
      const pend = slots.filter(s => s.state === 'empty');
      const want = {}; for (const s of pend) want[bareId(s.item)] = (want[bareId(s.item)] || 0) + 1;
      const ready = Object.keys(want).filter(k => invCount(bot, k) > 0);
      return {
        id: L.id, name: L.name,
        zones: (L.zones || []).map(z => { const zs = slots.filter(s => s.zone === z.name); return `${z.name}（${z.purpose || ''}）：${zs.filter(s => s.state === 'done').length}/${zs.length}`; }),
        done: slots.filter(s => s.state === 'done').length, total: slots.length,
        stillWant: want, canPlaceNow: ready, blocked: slots.filter(s => s.state === 'taken').length || undefined,
      };
    }),
  };
}

async function furnish (bot, state, { id, items, maxMs = 90000 } = {}) {
  const LS = layouts(state); const L = id ? LS[id] : Object.values(LS).sort((a, b) => b.updated - a.updated)[0];
  if (!L) throw new Error('还没有布置规划（先 plan_layout）');
  const only = items ? new Set([].concat(items).map(bareId)) : null;
  const t0 = Date.now(); const placed = []; const failed = [];
  const me = () => bot.entity.position;
  for (const sl of allSlots(L)) {
    if (Date.now() - t0 > maxMs) break;
    const item = bareId(sl.item);
    if (only && !only.has(item)) continue;
    if (slotState(bot, sl) !== 'empty' || !invCount(bot, item)) continue;
    const pos = new Vec3(sl.x, sl.y, sl.z);
    const onMe = () => { const f = me().floored(); return pos.x === f.x && pos.z === f.z && (pos.y === f.y || pos.y === f.y + 1); };
    if (me().offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2 || onMe()) await pathTo(bot, pos, 3, 20000, { retry: false });
    if (onMe()) { failed.push(`${item}@(${sl.x},${sl.y},${sl.z})：站在格子上`); continue; }
    const r = await placeAt(bot, pos, item, sl.mount);
    if (r.ok) placed.push(`${item}→${sl.zone}(${sl.x},${sl.y},${sl.z})`); else failed.push(`${item}@(${sl.x},${sl.y},${sl.z})：${r.why || '没放上'}`);
  }
  L.updated = Date.now(); saveLayouts(state);
  const st = layoutStatus(bot, state, { id: L.id }).layouts[0];
  return { layout: L.name, placed, failed: failed.length ? failed : undefined, done: `${st.done}/${st.total}`, stillWant: st.stillWant };
}

function survey (bot, { x, y, z, r = 7, below = 2, above = 5 } = {}) {
  const c = x != null ? new Vec3(Math.floor(+x), Math.floor(+y), Math.floor(+z)) : bot.entity.position.floored();
  r = Math.min(Math.max(3, +r || 7), 12);
  const me = bot.entity.position.floored();
  const dyn = new Map(); const layers = []; const furniture = []; const lights = []; const dark = []; const freeFloor = []; const doors = [];
  for (let dy = +above; dy >= -below; dy--) {
    const yy = c.y + dy; const rows = [];
    for (let dz = -r; dz <= r; dz++) {
      let row = '';
      for (let dx = -r; dx <= r; dx++) {
        const p = new Vec3(c.x + dx, yy, c.z + dz);
        const b = bot.blockAt(p);
        if (me.x === p.x && me.z === p.z && (me.y === yy || me.y + 1 === yy)) { row += '@'; continue; }
        const ch = surveyChar(b, dyn); row += ch;
        if (!b) continue;
        const at = `${p.x},${p.y},${p.z}`;
        if (ch === 'i') lights.push(`${b.name.replace(/^minecraft:/, '')}(${at})`);
        else if (FURNITURE_RE.test(b.name)) furniture.push(`${b.name.replace(/^minecraft:/, '')}(${at})`);
        if (isDoorLike(b) && !/trapdoor/.test(b.name)) doors.push(`${b.name.replace(/^.*:/, '')}(${at})`);
        // 地面格：脚下实心、这格和头上是空的
        if (ch === '.' && dy <= 1) {
          const under = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
          if (under && under.boundingBox === 'block' && head && head.boundingBox === 'empty') {
            freeFloor.push(at);
            if (b.light != null && b.light < 1 && !(b.skyLight > 7)) dark.push(at);
          }
        }
      }
      rows.push(row);
    }
    // 整层都是空气就不列
    if (rows.every(rw => /^[.@]*$/.test(rw))) continue;
    layers.push(`y=${yy}${yy === c.y ? '（中心层）' : ''}\n${rows.join('\n')}`);
  }
  const legend = [...dyn.entries()].map(([n, ch]) => `${ch}=${n.replace(/^minecraft:/, '')}`).join(' ');
  const uniq = (a) => [...new Set(a)];
  // 要留空的格子（路）：门前后、梯子上下口、1 格宽的走道。放东西绝不能占（实测箱子堵了路，2026-09-27）
  const free = new Set(freeFloor);
  const keepClear = new Set();
  const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -below; dy <= above; dy++) {
    const p = new Vec3(c.x + dx, c.y + dy, c.z + dz); const b = bot.blockAt(p); if (!b) continue;
    if ((isDoorLike(b) && !/trapdoor/.test(b.name)) || /ladder/.test(b.name)) {
      for (const [ax, az] of H4) for (const k of [1, 2]) for (const yy of [0, 1, -1]) { const q = `${p.x + ax * k},${p.y + yy},${p.z + az * k}`; if (free.has(q)) keepClear.add(q); }
      for (const yy of [1, -1]) { const q = `${p.x},${p.y + yy},${p.z}`; if (free.has(q)) keepClear.add(q); }
    }
  }
  for (const at of freeFloor) {
    const [x0, y0, z0] = at.split(',').map(Number);
    const n = H4.map(([ax, az]) => free.has(`${x0 + ax},${y0},${z0 + az}`));
    const cnt = n.filter(Boolean).length;
    if (cnt === 2 && ((n[0] && n[1]) || (n[2] && n[3]))) keepClear.add(at);   // 两边是墙、前后通：走道
  }
  return {
    center: { x: c.x, y: c.y, z: c.z }, r,
    orientation: `每层俯视：从上到下是 z=${c.z - r}..${c.z + r}（北→南），从左到右是 x=${c.x - r}..${c.x + r}（西→东）`,
    fixed: '. 空气  @ 你  i 光源  H 梯子  D/d 门(关/开)  T/t 活板门  G/g 栅栏门  ~ 水  ! 岩浆  ? 没加载',
    legend,
    layers: layers.join('\n\n'),
    doors: uniq(doors).slice(0, 12), lights: uniq(lights).slice(0, 20), furniture: uniq(furniture).slice(0, 30),
    darkFloor: dark.slice(0, 20), darkCount: dark.length, freeFloorCount: freeFloor.length,
    keepClear: [...keepClear].slice(0, 60), keepClearCount: keepClear.size,
  };
}

const START_COVER = 0.7;   // 材料够七成才开工（主人 2026-09-27：工程也要现用现定，不先挖坑等材料）

module.exports = { START_COVER, allSlots, bind, furnish, invCount, layoutSave, layoutStatus, layoutStatusSlots, layouts, placeAt, projectCells, projectDiff, projectSave, projectStatus, projectWork, projects, saveLayouts, saveProjects, slotState, survey, zoneArea, zoneFreeFloor, zoneMark, zonePresent, zoneWants };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 hands.js 的自测段里（同一个 (async () => {…})() 外套），
// 现在搬到这里 —— 断言一字未改，只是把原来「同一作用域里随手就能用」的 hands 函数
// 改成从 t.h（总表）取名（拆开后它们分在别的文件里）。
// 被汇总 require 时 register（登记不跑）；`node src/body/build.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['[9] 工程：蓝图校验、对照差异（假世界）', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { K, isFiller, projectDiff, projectSave, rankRecipesFor, scaffoldIds, shortfallText, threatNear } = t.h;
      console.log('\n[9] 工程：蓝图校验、对照差异（假世界）');
      {
        const world = new Map([['0,0,0', 'stone'], ['1,0,0', 'oak_planks'], ['0,1,0', 'dirt']]);
        const mkB = (name, pos) => ({ name, position: pos, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true });
        const fbot = { registry: { blocksByName: { stone: {}, oak_planks: {}, dirt: {}, air: {} } }, blockAt: (p) => mkB(world.get(`${p.x},${p.y},${p.z}`) || 'air', p) };
        const st = { __projects: {} };
        let err = null; try { projectSave(fbot, st, { name: 'x', origin: { x: 0, y: 0, z: 0 }, legend: { Q: 'nope:block' }, layers: [{ dy: 0, rows: ['Q'] }] }); } catch (e) { err = e.message; }
        check('图例里不存在的方块会被拒', /不存在/.test(err || ''), true);
        const saved = projectSave(fbot, st, { id: 't1', name: '小墙', origin: { x: 0, y: 0, z: 0 }, legend: { P: 'minecraft:oak_planks', '.': 'air' }, layers: [{ dy: 0, rows: ['PPP'] }, { dy: 1, rows: ['.-P'] }] });
        check('存下来、材料清单对', JSON.stringify(saved.materials), JSON.stringify({ oak_planks: 4 }));
        const d = projectDiff(fbot, st.__projects.t1);
        // (0,0,0) stone→要先挖再放；(1,0,0) 已对；(2,0,0) 空→放；(0,1,0) dirt 要挖成空；(1,1,0) '-' 不管；(2,1,0) 空→放
        check('要挖 2 格（石头要换、泥土要清）', d.dig.length, 2);
        check('其中石头那格挖完还要放', d.dig.filter(c => c.thenPlace).length, 1);
        check('要放 2 格', d.place.length, 2);
        check('已经对 1 格，完成 20%', `${d.ok}/${d.pct}`, '1/20');
      }

      console.log('\n合成缺料说成人话（测跑的那份：rankRecipesFor + shortfallText，用知识库真数据）');
      {
        const k = K(); const KB = k.load();
        const say = (id, have = new Map()) => { const R = (KB.byOutput.get(id) || []).map(i => KB.recipes[i]); const r = rankRecipesFor(k, KB, have, id, R, 1); return shortfallText(k, KB, id, r.needs) || ''; };
        const sp = say('minecraft:stone_pickaxe');
        check('★ 石镐缺料说"圆石"（挖石头掉的就是圆石），不说"石头"', /圆石/.test(sp) && !/石头 \d/.test(sp), true);
        check('★ 石镐缺料不提火成岩（模组配方）', /火成岩/.test(sp), false);
        check('箱子缺料说木板', /木板/.test(say('minecraft:chest')), true);
      }
      console.log('\n搭脚方块名单（整合包标签）');
      {
        const sc = scaffoldIds();
        check('★ 草方块算搭脚方块（以前不认）', sc.includes('minecraft:grass_block'), true);
        check('★ 模组泥土算（RU 泥炭土）', sc.includes('regions_unexplored:peat_dirt'), true);
        check('原版底子还在', sc.includes('minecraft:cobblestone'), true);
        check('沙子不算（会塌）', sc.includes('minecraft:sand'), false);
        check('耕地、小路不算', [sc.includes('regions_unexplored:peat_farmland'), sc.includes('regions_unexplored:peat_dirt_path')], [false, false]);
        check('磨制石头不算（值钱）', sc.includes('minecraft:polished_andesite'), false);
        check('垫脚也认草方块', isFiller('grass_block'), true);
      }
      console.log('\n下矿 / 施工认威胁');
      {
        const V = (x) => ({ distanceTo: (p) => Math.abs(p.x - x) , x });
        const me = { position: V(0) };
        const mk = (name, x, extra = {}) => ({ name, position: V(x), type: 'mob', ...extra });
        const fb = (ents) => ({ entity: me, entities: Object.fromEntries(ents.map((e, i) => [i, e])) });
        const st = { aggroOf: (e) => (e.hate ? { on: 'me' } : null) };
        check('原版僵尸 → 威胁', !!threatNear(fb([mk('zombie', 3)]), st, { x: 0 }), true);
        check('★ 模组怪有仇恨证据 → 威胁（以前名单里没有）', !!threatNear(fb([mk('cataclysm:ignis', 3, { hate: true })]), st, { x: 0 }), true);
        check('模组怪没仇恨 → 不算', !!threatNear(fb([mk('cataclysm:ignis', 3)]), st, { x: 0 }), false);
        check('太远 → 不算', !!threatNear(fb([mk('zombie', 20)]), st, { x: 0 }), false);
        check('没有 aggroOf（旧状态）→ 照旧按名字', !!threatNear(fb([mk('skeleton', 2)]), {}, { x: 0 }), true);
      }
  }],
];
register('build', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 单独跑本文件：先把总表接上（原来所有 hands 函数在同一作用域，小节随手就能取）。
  // 总表用汇总额外导出的 __ns（8 个文件的全部名字），不是那 47 个对外接口。
  require('./testkit').bindHands(require('./index').__ns);
  const { runSuite } = require('./testkit');
  runSuite('build', __sections);
}
