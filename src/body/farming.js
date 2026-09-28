'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「farming」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3

const __ns = {};
let REACH;   // 常量：load 完成后由 bind() 回填
function K (...a) { return __ns.K.apply(null, a); }
function approach (...a) { return __ns.approach.apply(null, a); }
function botName (...a) { return __ns.botName.apply(null, a); }
function delta (...a) { return __ns.delta.apply(null, a); }
function doorKey (...a) { return __ns.doorKey.apply(null, a); }
function eyeDist (...a) { return __ns.eyeDist.apply(null, a); }
function fullId (...a) { return __ns.fullId.apply(null, a); }
function invCounts (...a) { return __ns.invCounts.apply(null, a); }
function pathTo (...a) { return __ns.pathTo.apply(null, a); }
function sleep (...a) { return __ns.sleep.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); REACH = ns.REACH; }

function cropInfo (bot, b) {
  if (!b) return null;
  const props = b.getProperties?.() || {};
  const ageKey = Object.keys(props).find(k => k.toLowerCase() === 'age');
  if (!ageKey) return null;
  const below = bot.blockAt(b.position.offset(0, -1, 0));
  const onSoil = below && /farmland|soul_sand|rich_soil/.test(below.name);
  if (!onSoil && !/berr/.test(b.name)) return null;      // 仙人掌、甘蔗、火这些也有 age，不算
  const st = (bot.registry.blocksByName[b.name]?.states || []).find(x => String(x.name).toLowerCase() === 'age');
  const max = st ? (st.num_values ?? st.values?.length ?? 8) - 1 : 7;
  const age = +props[ageKey];
  return { age, max, mature: age >= max, soil: below };
}

function seedFor (bot, cropName) {
  const items = bot.inventory.items();
  const bare = botName(cropName);
  if (SEED_OF[bare]) return items.find(i => botName(i.name) === SEED_OF[bare]) || null;
  const KB = K().load();
  const cropId = fullId(cropName);
  const cands = items.filter(i => (KB.drops.get(fullId(i.name)) || []).some(d => d.from === 'block' && d.id === cropId));
  return cands.sort((a, b) => /seed/.test(b.name) - /seed/.test(a.name))[0] || null;
}

async function collectDrops (bot, radius = 6) {
  let n = 0;
  for (let k = 0; k < 12; k++) {
    const drop = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    await pathTo(bot, drop.position.floored(), 0.6, 6000, { retry: false });
    await sleep(250); n++;
  }
  return n;
}

// abort：进程内调用才能传（收获本能被命令打断时用），每收一棵 / 种一块之前问一次
// only：只收这些格子（收获本能先挑好：右键摘的、别人不让收的已经排除）
async function farm (bot, state, { radius = 12, replant = true, plantEmpty = true, seed = null, abort = null, only = null } = {}) {
  const stop = () => typeof abort === 'function' && abort();
  const t0 = Date.now();
  const inv0 = invCounts(bot);
  // 只找"有生长阶段（age）属性"的方块种类 —— 以前是把周围所有非空气方块都拿来筛，上限 2000 个全是房子的墙
  const ageIds = Object.values(bot.registry.blocksByName)
    .filter(b => (b.states || []).some(x => String(x.name).toLowerCase() === 'age') && !/cactus|sugar_cane|fire|kelp|bamboo|vine|chorus|frosted_ice|twisting|weeping|cave_vines|sapling/.test(b.name))
    .map(b => b.id);
  const pts = bot.findBlocks({ matching: ageIds, maxDistance: radius, count: 1500 })
    .map(p => bot.blockAt(p)).filter(b => b && cropInfo(bot, b));
  const onlySet = Array.isArray(only) ? new Set(only.map(p => `${p.x},${p.y},${p.z}`)) : null;
  const crops = pts.filter(b => !onlySet || onlySet.has(`${b.position.x},${b.position.y},${b.position.z}`)).map(b => ({ b, info: cropInfo(bot, b) }));
  const mature = crops.filter(c => c.info.mature);
  let harvested = 0; let replanted = 0; let planted = 0; const notes = [];
  for (const { b } of mature.sort((a, c) => bot.entity.position.distanceTo(a.b.position) - bot.entity.position.distanceTo(c.b.position))) {
    if (stop()) { notes.push('被新的命令打断'); break; }
    const cur = bot.blockAt(b.position);
    if (!cur || cur.name !== b.name || !cropInfo(bot, cur)?.mature) continue;
    if (eyeDist(bot, cur) > REACH) { const err = await pathTo(bot, cur.position, 2, 15000); if (err && eyeDist(bot, cur) > REACH) { notes.push(`走不到 ${b.name}(${doorKey(b.position)})`); continue; } }
    try { await bot.dig(cur, true); harvested++; } catch (e) { notes.push(`收不了 ${b.name}：${e.message}`); continue; }
    await sleep(150);
    if (replant) {
      const sd = seedFor(bot, b.name);
      const soil = bot.blockAt(b.position.offset(0, -1, 0));
      if (sd && soil && /farmland|soul_sand|rich_soil/.test(soil.name)) {
        try { await approach(bot, soil); await bot.equip(sd, 'hand'); await bot.activateBlock(soil, new Vec3(0, 1, 0)); replanted++; } catch (e) { notes.push(`补种失败：${e.message}`); }
      }
    }
    if (harvested % 8 === 0) await collectDrops(bot, 5);
  }
  if (harvested && !stop()) await collectDrops(bot, 8);
  // 空着的耕地：播种
  if (plantEmpty && !stop()) {
    const lands = bot.findBlocks({ matching: (b) => !!b && /farmland/.test(b.name), maxDistance: radius, count: 400 })
      .filter(p => { const up = bot.blockAt(p.offset(0, 1, 0)); return up && up.name === 'air'; }).map(p => bot.blockAt(p));
    const sdItem = () => (seed ? bot.inventory.items().find(i => fullId(i.name) === fullId(seed)) : bot.inventory.items().find(i => /seed|^carrot$|^potato$/.test(botName(i.name))));
    for (const land of lands) {
      if (stop()) break;
      const sd = sdItem();
      if (!sd) { if (lands.length) notes.push(`还有 ${lands.length - planted} 块空地，背包里没种子了`); break; }
      try { await approach(bot, land); await bot.equip(sd, 'hand'); await bot.activateBlock(land, new Vec3(0, 1, 0)); planted++; await sleep(100); } catch (e) { notes.push(`种不了 ${doorKey(land.position)}：${e.message}`); }
    }
  }
  const d = delta(inv0, invCounts(bot));
  return { crops: crops.length, mature: mature.length, harvested, replanted, plantedEmpty: planted, got: d.gained, used: d.lost, notes: notes.slice(0, 6), seconds: Math.round((Date.now() - t0) / 1000),
    note: crops.length ? null : `附近 ${radius} 格内没有庄稼` };
}

const SEED_OF = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', nether_wart: 'nether_wart', torchflower_crop: 'torchflower_seeds', pitcher_crop: 'pitcher_pod' };

module.exports = { SEED_OF, bind, collectDrops, cropInfo, farm, seedFor };
