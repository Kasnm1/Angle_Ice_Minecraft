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
 *
 * 2026-09-27 主人要的生活动作（WorkBuddy 建议不做，主人说要做）：
 *   POST /fish {count, maxMs, radius}                    钓鱼：找露天的水面，甩竿等咬钩（mineflayer bot.fish 听"钓鱼粒子"），核对背包真的多了东西
 *   POST /animal {action:feed|breed|shear|milk, kind, count, radius}  喂 / 繁殖 / 剪羊毛 / 挤奶：右键动物，核对（小崽多了、羊毛多了、奶桶多了）
 *   POST /ride {action:mount|dismount|minecart|boat, kind, x, z}      上下载具；矿车往前推；坐船直线开过水面（实验：见 boatTo）
 *
 * 无限水（cs-01，写进 bucket 工具的说明给她）：挖一个 2×2、一格深的坑，**对角两格**各倒一桶，四格都变成水源；
 * 一行三格的坑倒两头，中间那格变成水源。之后怎么舀都不会少。
 *
 * 只做"手"：什么时候开地、往哪倒水由 mind 决定（锄地会改主人的地面，不做成自动本能）。
 * 每个动作都核对世界真的变了（水桶数、方块名），不信"调用成功"。
 */

const { Vec3 } = require('vec3');

// 第 4 步去重：sleep 原来是本地定义（与 src/body/util.js、src/bridge/util.js 逐字重复），
// 现在全项目唯一一份在 src/util/time.js。
const { sleep } = require('../util/time');
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
  try { dirtTag = require('../knowledge/knowledge').load().tags.get('block:minecraft:dirt'); } catch (_) {}
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
    // 锄地也是"用方块"：先走到跟前、视线要通（判据只写在 hands.js 的 approach 里）
    try { await require('./hands').approach(bot, b); } catch (e) { notes.push(`锄不到 ${b.position}：${e.message}`); continue; }
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

// ------------------------------------------------------------------ 钓鱼

/** 露天的水面格：水、头顶是空气（竿能甩进去）。cells：[{pos, water, above}]（方块名） */
function fishable (c) {
  return !!c && /(^|:)water$/.test(bare(c.water)) && /(^|:)(air|cave_air)$/.test(bare(c.above));
}

async function fish (bot, { count: want = 5, maxMs = 120000, radius = 16, biteMs = 45000, abort } = {}) {
  const rod = bot.inventory.items().find(i => /fishing_rod$/.test(i.name));
  if (!rod) return { ok: false, error: '身上没有钓鱼竿（木棍×3 + 线×2）' };
  const w = bot.registry.blocksByName.water?.id;
  const me = bot.entity.position;
  const spots = bot.findBlocks({ matching: w, maxDistance: radius, count: 200 })
    .map(p => ({ pos: p, water: bot.blockAt(p)?.name, above: bot.blockAt(p.offset(0, 1, 0))?.name }))
    .filter(fishable)
    .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
  if (!spots.length) return { ok: false, error: `${radius} 格内没有露天的水面` };
  const spot = spots.find(sp => sp.pos.distanceTo(me) >= 3) || spots[0];
  if (!await walkNear(bot, spot.pos, 4)) return { ok: false, error: '走不到水边' };
  const inv0 = {}; for (const i of bot.inventory.items()) inv0[i.name] = (inv0[i.name] || 0) + i.count;
  const t0 = Date.now(); let casts = 0; let bites = 0; let lastErr = null;
  while (bites < want && Date.now() - t0 < maxMs) {
    if (typeof abort === 'function' && abort()) break;
    const r = bot.inventory.items().find(i => /fishing_rod$/.test(i.name));
    if (!r) { lastErr = '钓鱼竿用坏了'; break; }
    if (bot.heldItem?.name !== r.name) await bot.equip(r, 'hand');
    await bot.lookAt(spot.pos.offset(0.5, 1, 0.5), true);
    casts++;
    let timer = null;
    const got = await Promise.race([
      bot.fish().then(() => true, (e) => { lastErr = e.message; return false; }),
      new Promise(res => { timer = setTimeout(() => res(null), biteMs); }),
    ]);
    clearTimeout(timer);
    if (got === null) { try { bot.activateItem(); } catch (_) {} lastErr = `${Math.round(biteMs / 1000)} 秒没咬钩（水太浅/太小、或者头顶被挡）`; await sleep(600); continue; }
    if (got) bites++;
    await sleep(900);   // 等东西飞过来
  }
  await sleep(800);
  const gained = {}; const inv1 = {}; for (const i of bot.inventory.items()) inv1[i.name] = (inv1[i.name] || 0) + i.count;
  for (const [k, v] of Object.entries(inv1)) if (v > (inv0[k] || 0)) gained[k] = v - (inv0[k] || 0);
  const n = Object.values(gained).reduce((a, b) => a + b, 0);
  return { ok: n > 0, caught: gained, casts, bites, at: { x: spot.pos.x, y: spot.pos.y, z: spot.pos.z }, ...(n ? {} : { error: lastErr || '甩了竿，没钓上东西' }) };
}

// ------------------------------------------------------------------ 动物

/** 原版动物吃什么（繁殖 / 喂）。只认原版的（模组动物吃什么没证据，不猜） */
const ANIMAL_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'], horse: ['golden_carrot', 'golden_apple'], donkey: ['golden_carrot', 'golden_apple'],
  llama: ['hay_block'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'], panda: ['bamboo'], cat: ['cod', 'salmon'],
  wolf: ['beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit'],
  frog: ['slime_ball'], strider: ['warped_fungus'], hoglin: ['crimson_fungus'], camel: ['cactus'], sniffer: ['torchflower_seeds'],
};
function foodFor (kind, invNames = []) {
  const want = ANIMAL_FOOD[bare(kind)];
  if (!want) return null;
  return want.find(f => invNames.some(n => bare(n) === f)) || false;   // null = 不知道它吃什么；false = 身上没有
}
/** 是不是小崽：1.20.1 可长大的生物 metadata[16] 是"是不是幼崽"。读不到 = null */
function isBaby (e) {
  const v = e?.metadata?.[16];
  return typeof v === 'boolean' ? v : null;
}
/** 羊剪过没有：metadata[17] 字节的 0x10 位。读不到 = null */
function sheared (e) {
  const v = e?.metadata?.[17];
  return typeof v === 'number' ? (v & 0x10) !== 0 : null;
}

async function animal (bot, { action = 'breed', kind = null, count: want = 2, radius = 16, abort } = {}) {
  const inv = () => bot.inventory.items();
  const cnt = (name) => inv().filter(i => bare(i.name) === name).reduce((a, i) => a + i.count, 0);
  const near = (pred) => Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.type !== 'player' && e.position && e.position.distanceTo(bot.entity.position) <= radius && pred(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  const useOn = async (e, itemName) => {
    const it = inv().find(i => bare(i.name) === itemName);
    if (!it) return false;
    if (!await walkNear(bot, e.position.floored(), 2)) return false;
    await bot.equip(it, 'hand');
    await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true);
    bot.useOn(e);
    await sleep(350);
    return true;
  };
  const done = []; const notes = [];
  if (action === 'shear') {
    if (!cnt('shears')) return { ok: false, error: '身上没有剪刀（铁锭×2）' };
    const wool0 = inv().filter(i => /wool$/.test(i.name)).reduce((a, i) => a + i.count, 0);
    for (const e of near(x => bare(x.name) === 'sheep' && sheared(x) !== true && isBaby(x) !== true).slice(0, want)) {
      if (typeof abort === 'function' && abort()) break;
      if (await useOn(e, 'shears')) done.push(e.id);
    }
    await sleep(1200);
    const gained = inv().filter(i => /wool$/.test(i.name)).reduce((a, i) => a + i.count, 0) - wool0;
    return { ok: done.length > 0, sheared: done.length, woolPicked: gained, ...(done.length ? { note: gained > 0 ? undefined : '剪下来的羊毛掉在地上，捡一下（pickup）' } : { error: '附近没有能剪的羊（剪过的要等它吃草长回来）' }) };
  }
  if (action === 'milk') {
    const b0 = cnt('milk_bucket');
    if (!cnt('bucket')) return { ok: false, error: '身上没有空桶' };
    const e = near(x => ['cow', 'goat', 'mooshroom'].includes(bare(x.name)) && isBaby(x) !== true)[0];
    if (!e) return { ok: false, error: `${radius} 格内没有能挤奶的牛/山羊` };
    await useOn(e, 'bucket');
    await sleep(300);
    return cnt('milk_bucket') > b0 ? { ok: true, milked: 1, from: bare(e.name) } : { ok: false, error: '右键了，没接到奶' };
  }
  // feed / breed
  const kinds = kind ? [bare(kind)] : Object.keys(ANIMAL_FOOD);
  const names = inv().map(i => i.name);
  const cands = near(x => kinds.includes(bare(x.name)));
  if (!cands.length) return { ok: false, error: `${radius} 格内没有${kind ? ` ${kind}` : '认得的动物'}` };
  const k = bare(cands[0].name);
  const food = foodFor(k, names);
  if (food === null) return { ok: false, error: `不知道 ${k} 吃什么` };
  if (food === false) return { ok: false, error: `身上没有 ${k} 吃的（${ANIMAL_FOOD[k].join(' / ')}）` };
  const babies0 = near(x => bare(x.name) === k && isBaby(x) === true).length;
  const targets = cands.filter(x => bare(x.name) === k && (action === 'feed' || isBaby(x) !== true)).slice(0, action === 'breed' ? Math.max(2, want) : want);
  if (action === 'breed' && targets.length < 2) return { ok: false, error: `附近能繁殖的 ${k} 不到两只` };
  for (const e of targets) {
    if (typeof abort === 'function' && abort()) break;
    if (!cnt(food)) { notes.push(`${food} 用完了`); break; }
    if (await useOn(e, food)) done.push(e.id); else notes.push(`够不着 ${e.id}`);
  }
  if (action === 'breed') {
    await sleep(4000);
    const born = near(x => bare(x.name) === k && isBaby(x) === true).length - babies0;
    return { ok: born > 0, fed: done.length, kind: k, food, born: Math.max(0, born), notes,
      ...(born > 0 ? {} : { error: done.length >= 2 ? '喂了没看到小崽（刚繁殖过的要等 5 分钟；或者读不到幼崽标记）' : '没喂上两只' }) };
  }
  return { ok: done.length > 0, fed: done.length, kind: k, food, notes };
}

// ------------------------------------------------------------------ 载具

const RIDEABLE_RE = /(^|:)(boat|chest_boat|raft|chest_raft|minecart|horse|donkey|mule|camel|pig|strider|llama)$|smallships:|immersive_aircraft:/;

/** 船直线往目标走一步：每步最多 step 格，返回下一点（到了返回 null） */
function boatStep (from, to, step = 0.35) {
  const dx = to.x - from.x; const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d <= 1) return null;
  const k = Math.min(step, d) / d;
  return { x: from.x + dx * k, y: from.y, z: from.z + dz * k, yaw: Math.atan2(-dx, dz) * 180 / Math.PI };
}

/**
 * 坐船往 (x,z) 直线开。mineflayer 不模拟船的物理（1.20.1 船的位置是客户端算好发给服务器的 vehicle_move），
 * 所以这里自己一步步发：前方那格不是水就停（靠岸 / 撞上东西），每 2 秒核对一次服务器那边船真的动了没有。
 * ⚠️ 实验性：服务器可能把太快的移动拉回去 —— 核对不到进展就如实停下。
 */
async function boatTo (bot, { x, z, maxMs = 90000, abort } = {}) {
  const boat = bot.vehicle;
  if (!boat || !/boat|raft|smallships/.test(boat.name || '')) return { ok: false, error: '不在船上' };
  const t0 = Date.now(); let pos = boat.position.clone(); let checkAt = t0; let checkPos = pos.clone(); let reason = null;
  while (Date.now() - t0 < maxMs) {
    if (typeof abort === 'function' && abort()) { reason = '被打断'; break; }
    if (!bot.vehicle) { reason = '下船了'; break; }
    const n = boatStep(pos, { x, z });
    if (!n) { reason = '到了'; break; }
    const ahead = bot.blockAt(new Vec3(Math.floor(n.x + (n.x - pos.x) * 3), Math.floor(pos.y - 0.2), Math.floor(n.z + (n.z - pos.z) * 3)));
    if (!ahead || !/water/.test(ahead.name)) { reason = ahead ? `前面是 ${bare(ahead.name)}，靠岸了` : '前面没加载'; break; }
    bot._client.write('vehicle_move', { x: n.x, y: pos.y, z: n.z, yaw: n.yaw, pitch: 0 });
    pos = new Vec3(n.x, pos.y, n.z);
    await sleep(50);
    if (Date.now() - checkAt > 2000) {
      const real = bot.vehicle?.position;
      if (real && real.distanceTo(checkPos) < 0.5) { reason = '船没动（服务器可能不认这种开法）'; break; }
      if (real) { pos = real.clone(); checkPos = real.clone(); }
      checkAt = Date.now();
    }
  }
  const end = bot.vehicle?.position || pos;
  return { ok: reason === '到了', reason, at: { x: Math.round(end.x), y: Math.round(end.y), z: Math.round(end.z) }, left: Math.round(Math.hypot(x - end.x, z - end.z)) };
}

async function ride (bot, { action = 'mount', kind = null, x, z, seconds = 20, radius = 8, abort } = {}) {
  if (action === 'dismount') {
    if (!bot.vehicle) return { ok: true, already: true };
    bot.dismount(); await sleep(600);
    return bot.vehicle ? { ok: false, error: '没下来' } : { ok: true };
  }
  if (action === 'mount') {
    if (bot.vehicle) return { ok: true, already: true, on: bare(bot.vehicle.name) };
    const re = kind ? new RegExp(`(^|:)${bare(kind)}$`) : RIDEABLE_RE;
    const e = Object.values(bot.entities).filter(v => v !== bot.entity && v.position && re.test(v.name || '') && v.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!e) return { ok: false, error: `${radius} 格内没有能坐的${kind ? ` ${kind}` : '（船、矿车、马…）'}` };
    await walkNear(bot, e.position.floored(), 2);
    await bot.lookAt(e.position.offset(0, 0.5, 0), true);
    bot.mount(e); await sleep(800);
    return bot.vehicle ? { ok: true, on: bare(bot.vehicle.name) } : { ok: false, error: `坐不上 ${bare(e.name)}（马要先驯服、猪要鞍）` };
  }
  if (action === 'minecart') {
    if (!bot.vehicle || !/minecart/.test(bot.vehicle.name || '')) return { ok: false, error: '不在矿车上' };
    const p0 = bot.vehicle.position.clone(); const t0 = Date.now();
    while (Date.now() - t0 < Math.min(seconds, 120) * 1000 && bot.vehicle) {
      if (typeof abort === 'function' && abort()) break;
      bot.moveVehicle(0, 1); await sleep(100);
    }
    const p1 = bot.vehicle?.position || bot.entity.position;
    return { ok: p1.distanceTo(p0) > 2, moved: Math.round(p1.distanceTo(p0)) };
  }
  if (action === 'boat') {
    if (x == null || z == null) return { ok: false, error: '要给 x、z' };
    if (!bot.vehicle) {
      const m = await ride(bot, { action: 'mount', kind: null, radius });
      if (!m.ok || !/boat|raft|smallships/.test(m.on || '')) return { ok: false, error: m.error || '附近没有船（先把船放到水上）' };
    }
    return boatTo(bot, { x: +x, z: +z, maxMs: Math.min(seconds, 180) * 1000, abort });
  }
  return { ok: false, error: `不认识的 action：${action}` };
}

function routes ({ state }) {
  const bot = () => state.bot;
  return {
    'POST /bucket': async (b = {}) => (b.mode === 'pour' ? pourWater(bot(), b) : fillBucket(bot(), b)),
    'POST /till': async (b = {}) => till(bot(), b),
    'POST /fish': async (b = {}) => fish(bot(), b),
    'POST /animal': async (b = {}) => animal(bot(), b),
    'POST /ride': async (b = {}) => ride(bot(), b),
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
  check('露天水面能钓', fishable({ water: 'water', above: 'air' }), true);
  check('水面上有方块盖着 → 不钓', fishable({ water: 'water', above: 'stone' }), false);
  check('★ 牛吃小麦', foodFor('cow', ['wheat', 'dirt']), 'wheat');
  check('猪：身上有土豆就用土豆', foodFor('minecraft:pig', ['potato']), 'potato');
  check('身上没它吃的 → false', foodFor('sheep', ['carrot']), false);
  check('模组动物不知道吃什么 → null（不猜）', foodFor('untamedwilds:bear', ['wheat']), null);
  check('幼崽标记', [isBaby({ metadata: { 16: true } }), isBaby({ metadata: { 16: false } }), isBaby({ metadata: {} })].join(), 'true,false,');
  check('羊剪过（0x10 位）', [sheared({ metadata: { 17: 0x10 | 3 } }), sheared({ metadata: { 17: 3 } }), sheared({})].join(), 'true,false,');
  check('能坐：船、矿车、马、小船模组', ['boat', 'minecraft:minecart', 'horse', 'smallships:cog'].every(n => RIDEABLE_RE.test(n)), true);
  check('不能坐：牛', RIDEABLE_RE.test('cow'), false);
  const bs = boatStep({ x: 0, y: 62, z: 0 }, { x: 0, y: 0, z: 10 });
  check('船每步 0.35 格、朝目标', Math.abs(bs.z - 0.35) < 1e-9 && bs.x === 0, true);
  check('到了（1 格内）→ null', boatStep({ x: 0, y: 62, z: 0 }, { x: 0.5, z: 0.5 }), null);
  check('高一层的水也算', hydrated({ blockAt: (p) => (p.y === 64 && p.x === 1 ? { name: 'water' } : { name: 'dirt' }) }, new Vec3(0, 63, 0)), true);
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { routes, fillBucket, pourWater, till, tillableNames, fish, fishable, animal, foodFor, isBaby, sheared, ANIMAL_FOOD, ride, boatStep, RIDEABLE_RE, hydrated, isWaterSource, selftest };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
