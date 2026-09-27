'use strict';

/**
 * 常识动作（主人 2026-09-27："常识本能"；WorkBuddy 审计见 modpack-study/common-sense/audit.md）
 *
 * 审计结论：36 条玩家常识她有 25 条，缺的集中在"主动改变环境"。这里补上最常用的三样手上功夫：
 *
 *   POST /bucket {mode:'fill'}         空桶去装水：找最近的**水源**（流动的水装不了），右键装满（cs-32）
 *   POST /bucket {mode:'pour', x,y,z}  往某一格倒水（灭火、流动岩浆变黑曜石、给耕地引水、造无限水）（cs-13）
 *   POST /till {x?,z?, radius, count, allowDry}  锄地开新地：泥土/草方块 → 耕地（cs-31）。默认只锄 4 格内有水的（没水会退化回泥土，cs-04）
 *
 * 无限水（cs-01，写进 bucket 工具的说明给她）：挖一个 2×2、一格深的坑，**对角两格**各倒一桶，四格都变成水源；
 * 一行三格的坑倒两头，中间那格变成水源。之后怎么舀都不会少。
 *
 * 只做"手"：什么时候开地、往哪倒水由 mind 决定（锄地会改主人的地面，不做成自动本能）。
 * 每个动作都核对世界真的变了（水桶数、方块名），不信"调用成功"。
 */

const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bare = (n) => String(n || '').replace(/^minecraft:/, '');
const count = (bot, name) => bot.inventory.items().filter(i => bare(i.name) === name).reduce((a, i) => a + i.count, 0);

async function walkNear (bot, pos, range = 3, ms = 20000) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return true;
  const { goals } = require('mineflayer-pathfinder');
  try {
    await Promise.race([bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), sleep(ms).then(() => { throw new Error('走太久了'); })]);
  } catch (_) {}
  try { bot.pathfinder.setGoal(null); } catch (_) {}
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 1;
}

/** 水源：方块名是水、level=0（流动的水 level 1–7，装不了） */
function isWaterSource (b) {
  if (!b || bare(b.name) !== 'water') return false;
  const p = b.getProperties?.() || {};
  return p.level == null || +p.level === 0;
}

async function fillBucket (bot, { radius = 16, abort } = {}) {
  if (!count(bot, 'bucket')) throw new Error('身上没有空桶');
  const w = bot.registry.blocksByName.water?.id;
  const src = bot.findBlocks({ matching: w, maxDistance: radius, count: 64 })
    .map(p => bot.blockAt(p)).filter(isWaterSource)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  if (!src.length) return { ok: false, error: `${radius} 格内没有水源（流动的水装不了；可以造个无限水）` };
  const before = count(bot, 'water_bucket');
  for (const b of src.slice(0, 3)) {
    if (typeof abort === 'function' && abort()) break;
    if (!await walkNear(bot, b.position, 3)) continue;
    const bucket = bot.inventory.items().find(i => bare(i.name) === 'bucket');
    if (!bucket) break;
    await bot.equip(bucket, 'hand');
    await bot.lookAt(b.position.offset(0.5, 0.8, 0.5), true);
    bot.activateItem();
    await sleep(400);
    if (count(bot, 'water_bucket') > before) return { ok: true, filled: 1, at: { x: b.position.x, y: b.position.y, z: b.position.z } };
  }
  return { ok: false, error: '走到水边右键了，桶没装上水' };
}

async function pourWater (bot, { x, y, z, abort } = {}) {
  if (x == null || y == null || z == null) throw new Error('要给倒在哪一格（x,y,z）');
  if (/nether/.test(String(bot.game?.dimension || ''))) return { ok: false, error: '下界倒不了水（会蒸发）' };
  if (!count(bot, 'water_bucket')) return { ok: false, error: '身上没有水桶（先 bucket mode=fill 装水）' };
  const at = new Vec3(Math.floor(+x), Math.floor(+y), Math.floor(+z));
  if (!await walkNear(bot, at, 3)) return { ok: false, error: '走不到那里' };
  if (typeof abort === 'function' && abort()) return { ok: false, error: '被打断' };
  const wb = bot.inventory.items().find(i => bare(i.name) === 'water_bucket');
  await bot.equip(wb, 'hand');
  const before = count(bot, 'water_bucket');
  // 看向这一格底面（下面那块的顶面）：服务端从眼睛打射线，碰到下面那块 → 水放进这一格
  await bot.lookAt(at.offset(0.5, 0.05, 0.5), true);
  bot.activateItem();
  await sleep(400);
  const now = bot.blockAt(at);
  const ok = count(bot, 'water_bucket') < before;
  return { ok, poured: ok ? 1 : 0, now: now?.name ?? null, ...(ok ? {} : { error: '右键了，水没倒出去（看不到那一格的底面？）' }) };
}

/** 4 格内（水平）同一层或高一层有水 = 这块耕地会湿（原版规则） */
function hydrated (bot, p) {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (b && bare(b.name) === 'water') return true;
      }
    }
  }
  return false;
}

/**
 * 锄得动的方块名。原版锄头：泥土、草方块、土径 → 耕地。
 * 模组的（草方块同类的问题：以前只认原版，RU 的泥炭土、淤泥土锄不了）：在 `#minecraft:dirt` 标签里、
 * **同一模组有对应的 `<前缀>_farmland`** 才算（有自己的耕地就是给锄的；没有耕地的不猜）。
 * names：本连接的全部方块名（bot.registry.blocksByName 的键）；dirtTag：标签成员（可空）
 */
function tillableNames (names, dirtTag) {
  const have = new Set(names);
  const out = ['dirt', 'grass_block', 'dirt_path'].filter(n => have.has(n));
  for (const id of dirtTag || []) {
    const m = /^([a-z0-9_]+):(\w+?)_(dirt|grass_block|dirt_path)$/.exec(id);
    if (m && have.has(id) && have.has(`${m[1]}:${m[2]}_farmland`)) out.push(id);
  }
  return out;
}

async function till (bot, { x, z, radius = 4, count: want = 9, allowDry = false, abort } = {}) {
  const hoe = bot.inventory.items().find(i => /_hoe$/.test(bare(i.name)));
  if (!hoe) return { ok: false, error: '身上没有锄头' };
  const center = x != null && z != null ? new Vec3(+x, bot.entity.position.y, +z) : bot.entity.position;
  let dirtTag = null;
  try { dirtTag = require('./knowledge').load().tags.get('block:minecraft:dirt'); } catch (_) {}
  const ids = tillableNames(Object.keys(bot.registry.blocksByName), dirtTag).map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
  const cands = bot.findBlocks({ matching: ids, point: center, maxDistance: radius + 1, count: 200 })
    .map(p => bot.blockAt(p))
    .filter(b => b && Math.abs(b.position.y - Math.floor(center.y - 1)) <= 1)
    .filter(b => { const up = bot.blockAt(b.position.offset(0, 1, 0)); return up && up.boundingBox === 'empty' && !/water|lava/.test(up.name); })
    .sort((a, b) => a.position.distanceTo(center) - b.position.distanceTo(center));
  let tilled = 0; let dry = 0; const notes = [];
  for (const b of cands) {
    if (tilled >= want || (typeof abort === 'function' && abort())) break;
    const wet = hydrated(bot, b.position);
    if (!wet && !allowDry) { dry++; continue; }
    if (!await walkNear(bot, b.position, 3, 15000)) { notes.push(`走不到 ${b.position}`); continue; }
    if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand');
    try {
      await bot.lookAt(b.position.offset(0.5, 1, 0.5), true);
      await bot.activateBlock(b, new Vec3(0, 1, 0));
      await sleep(250);
      if (/(^|_)farmland$/.test(bare(bot.blockAt(b.position)?.name))) tilled++;
      else notes.push(`${b.position} 锄了没变成耕地`);
    } catch (e) { notes.push(e.message); }
  }
  return {
    ok: tilled > 0, tilled, skippedDry: dry,
    ...(tilled ? {} : { error: cands.length ? (dry ? `附近的地 4 格内都没有水（锄了也会退化）；先引水（bucket pour），或者 allowDry:true` : '锄不动') : '附近没有能锄的泥土/草地' }),
    notes: notes.slice(0, 4),
  };
}

function routes ({ state }) {
  const bot = () => state.bot;
  return {
    'POST /bucket': async (b = {}) => (b.mode === 'pour' ? pourWater(bot(), b) : fillBucket(bot(), b)),
    'POST /till': async (b = {}) => till(bot(), b),
  };
}

// ------------------------------------------------------------------ 自测（只测纯判据）

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`); } };
  const W = (level) => ({ name: 'water', getProperties: () => ({ level }) });
  check('水源（level 0）能装', isWaterSource(W(0)), true);
  check('★ 流动的水（level 3）装不了', isWaterSource(W(3)), false);
  check('不是水', isWaterSource({ name: 'lava', getProperties: () => ({ level: 0 }) }), false);
  // hydrated：假世界 —— (3,63,0) 有水
  const fakeBot = { blockAt: (p) => (p.x === 3 && p.y === 63 && p.z === 0 ? { name: 'water' } : { name: 'dirt' }) };
  check('★ 4 格内同层有水 → 湿', hydrated(fakeBot, new Vec3(0, 63, 0)), true);
  check('5 格外 → 干', hydrated(fakeBot, new Vec3(-2, 63, 0)), false);
  const tn = tillableNames(['dirt', 'grass_block', 'dirt_path', 'regions_unexplored:peat_dirt', 'regions_unexplored:peat_grass_block', 'regions_unexplored:peat_farmland', 'biomeswevegone:lush_dirt'],
    ['minecraft:dirt', 'regions_unexplored:peat_dirt', 'regions_unexplored:peat_grass_block', 'biomeswevegone:lush_dirt']);
  check('★ 模组泥土有自己的耕地 → 锄得动', tn.includes('regions_unexplored:peat_dirt') && tn.includes('regions_unexplored:peat_grass_block'), true);
  check('模组泥土没有对应耕地 → 不猜', tn.includes('biomeswevegone:lush_dirt'), false);
  check('原版三种照旧', ['dirt', 'grass_block', 'dirt_path'].every(n => tn.includes(n)), true);
  check('高一层的水也算', hydrated({ blockAt: (p) => (p.y === 64 && p.x === 1 ? { name: 'water' } : { name: 'dirt' }) }, new Vec3(0, 63, 0)), true);
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { routes, fillBucket, pourWater, till, tillableNames, hydrated, isWaterSource, selftest };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
