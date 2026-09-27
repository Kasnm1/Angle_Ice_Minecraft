'use strict';

/**
 * 把 WorkBuddy 查证的矿表 / 作物表精简成本能要用的字段，写进 knowledge/ores.json、knowledge/crops.json。
 *
 * 来源（2026-09-27，WorkBuddy 按任务书 modpack-study/TASK-instincts-20260927.md 查的，Claude 抽查过）：
 *   modpack-study/instincts/ores.json        —— 调色板里的矿 + 非 ore 命名的天然矿物；tier 来自各 jar 的 needs_*_tool(s) /
 *                                               Fabric needs_tool_level_N / mineable/pickaxe 标签（都不在 = 没查到 → null）
 *   modpack-study/instincts/crops-safe.json  —— 只收"loot table 证明 age 到最大值时打掉 = 标准收获"的作物
 *
 * 用法：$NODE knowledge/_tools/import_instinct_tables.js [ores.json] [crops-safe.json]
 * 读的是 instinct.js（采矿、收获本能）。字段缺了会报出来并拒绝写 —— 宁可没有表（本能只说"没有表"不动），不要半张错表。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STUDY = path.resolve(ROOT, '..', 'modpack-study', 'instincts');
const [oresIn = path.join(STUDY, 'ores.json'), cropsIn = path.join(STUDY, 'crops-safe.json')] = process.argv.slice(2);
const TIERS = new Set(['wood', 'stone', 'iron', 'diamond', 'netherite']);
const VALUES = new Set(['high', 'mid', 'low']);

function writeAtomic (file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function importOres () {
  const src = JSON.parse(fs.readFileSync(oresIn, 'utf8'));
  const bad = [];
  const out = src.map(o => {
    const row = { name: o.name, tier: o.tier ?? null, value: o.value, drops: o.drops || [] };
    if (o.notPickaxe) row.notPickaxe = true;
    if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(row.name || '')) bad.push(`名字不对：${o.name}`);
    if (row.tier !== null && !TIERS.has(row.tier)) bad.push(`${o.name} tier=${o.tier}`);
    if (!VALUES.has(row.value)) bad.push(`${o.name} value=${o.value}`);
    return row;
  });
  if (bad.length) throw new Error(`矿表有 ${bad.length} 处不对：${bad.slice(0, 5).join('；')}`);
  const dup = out.length - new Set(out.map(o => o.name)).size;
  if (dup) throw new Error(`矿表有 ${dup} 个重名`);
  writeAtomic(path.join(ROOT, 'knowledge', 'ores.json'), out);
  const by = (k) => out.reduce((m, o) => ((m[o[k] ?? 'null'] = (m[o[k] ?? 'null'] || 0) + 1), m), {});
  console.log(`ores.json：${out.length} 条  value ${JSON.stringify(by('value'))}  tier ${JSON.stringify(by('tier'))}`);
}

// crops-safe 的口径把"没熟打掉也掉同样产物"的（胡萝卜 / 土豆型）排除了 —— 可这正是它们的正常收法（打掉收，拿产物本身补种）。
// 那一类 44 种里有灌木（茶树、咖啡…可能是右键摘的），没有逐个证据，所以只补回确定的这三种（2026-09-27 Claude 看过）。
const EXTRA_CROPS = [
  { name: 'minecraft:carrots', ageProp: 'age', maxAge: 7, harvest: 'break', seed: 'minecraft:carrot', soil: 'farmland', evidence: '原版：打掉收获，胡萝卜本身补种（crops-safe 口径排除，手动补回）' },
  { name: 'minecraft:potatoes', ageProp: 'age', maxAge: 7, harvest: 'break', seed: 'minecraft:potato', soil: 'farmland', evidence: '原版：打掉收获，土豆本身补种（同上）' },
  { name: 'farmersdelight:onions', ageProp: 'age', maxAge: 7, harvest: 'break', seed: 'farmersdelight:onion', soil: 'farmland', evidence: '农夫乐事：和胡萝卜同型，打掉收获、洋葱本身补种（同上）' },
];

function importCrops () {
  if (!fs.existsSync(cropsIn)) { console.log(`（没有 ${cropsIn}，作物表不动）`); return; }
  const src = [...JSON.parse(fs.readFileSync(cropsIn, 'utf8')), ...EXTRA_CROPS];
  const bad = [];
  const out = src.map(c => {
    const row = { name: c.name, ageProp: c.ageProp || 'age', maxAge: c.maxAge, harvest: c.harvest || 'break', seed: c.seed || null, soil: c.soil || null };
    if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(row.name || '')) bad.push(`名字不对：${c.name}`);
    if (!Number.isInteger(row.maxAge) || row.maxAge < 1) bad.push(`${c.name} maxAge=${c.maxAge}`);
    if (row.harvest !== 'break') bad.push(`${c.name} harvest=${c.harvest}（safe 表只该有 break）`);
    if (!c.evidence) bad.push(`${c.name} 没有证据`);
    return row;
  });
  // 这些 age 不是成熟度 / 打掉就毁了 —— safe 表里不该出现，出现就是查错了
  const NEVER = /(_stem|attached_|bamboo|sugar_cane|cactus|kelp|vine|chorus|sweet_berry_bush|cave_vines|sapling|propagule)/;
  for (const r of out) if (NEVER.test(r.name)) bad.push(`${r.name} 不该在 safe 表里`);
  if (bad.length) throw new Error(`作物表有 ${bad.length} 处不对：${bad.slice(0, 5).join('；')}`);
  writeAtomic(path.join(ROOT, 'knowledge', 'crops.json'), out);
  console.log(`crops.json：${out.length} 条（有补种物品的 ${out.filter(c => c.seed).length} 条）`);
}

importOres();
importCrops();
