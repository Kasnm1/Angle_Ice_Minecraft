#!/usr/bin/env node
'use strict';

/**
 * 把 WorkBuddy 算好的做菜路线图（modpack-study/route/foods.jsonl）压成她心愿系统用的 knowledge/route.json。
 *
 * ## 为什么
 *
 * ambition.js 原来是自己估"这道菜难不难"（原料在不在背包、是不是原版工作站）。路线图把每道菜
 * 一路拆到原材料、算了档位（T0 徒手/工作台 … T4 跨维度/Boss，C 只能靠机械动力，M 要装没装的模组，X 做不出来）
 * 和步数 —— 比现场估准得多，而且知道原材料从哪来（挖/打/钓/右键…），她缺东西时知道是自己去弄还是跟他要。
 *
 * 只留她挑菜要用的字段，体积小、入库。路线图重跑之后再跑一次这个脚本。
 *
 * 用法：node scripts/import-route.js [路线图 jsonl]
 */

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/Users/starwish/aimc/modpack-study/route/foods.jsonl';
const OUT = path.join(__dirname, '..', 'knowledge', 'route.json');

const rows = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const dishes = {};
const rawUse = {};       // 原材料 → 多少道菜用到（"解锁价值"）
const stationUse = {};   // 工作站 → 多少道菜要用
for (const r of rows) {
  const raw = (r.raw || []).map(x => ({ id: x.item, how: x.how_obtained || null })).filter(x => x.id);
  const prereq = (r.prereq || []).map(x => x.item).filter(Boolean);
  const tools = (r.tools || []).map(t => (typeof t === 'string' ? t : t.item || t.tag || t.id)).filter(Boolean);
  dishes[r.id] = {
    tier: r.tier, depth: r.depth ?? null, station: r.station || null,
    stations: r.all_stations || [], raw, prereq, tools,
    blocked: r.blocked || null, t4: r.t4_reason || null,
    createOnly: !!r.create_only, requiresMod: r.requires_mod || [],
  };
  for (const x of raw) rawUse[x.id] = (rawUse[x.id] || 0) + 1;
  for (const s of r.all_stations || []) stationUse[s] = (stationUse[s] || 0) + 1;
}
const tiers = {};
for (const d of Object.values(dishes)) tiers[d.tier] = (tiers[d.tier] || 0) + 1;
fs.writeFileSync(OUT, JSON.stringify({ source: SRC, builtAt: new Date().toISOString(), count: rows.length, tiers, rawUse, stationUse, dishes }));
console.log(`路线图 ${rows.length} 道 → ${OUT}（${Math.round(fs.statSync(OUT).size / 1024)} KB）档位：${JSON.stringify(tiers)}`);
