'use strict';

/**
 * 通关主线路线 → knowledge/mainline.json（长期计划 plan.js 读）。
 *
 * 来源：modpack-study/mainline/{mainline,prereq}.json（WorkBuddy 2026-09-27 按 quests.json 依赖 + main-quest.md + knowledge.js 材料树整理；
 * FTB 进度包格式 Claude 反编译核对过，见 ftbq-sync.js）。
 * 用法：$NODE knowledge/_tools/import_mainline.js
 * 核对：每个主线任务 id、每个前置 id 都要在 knowledge/quests.json 里真的存在（前置可以在别的章节）；不对就拒绝写。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.resolve(ROOT, '..', 'modpack-study', 'mainline');

const quests = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'quests.json'), 'utf8'));
const allIds = new Set((quests.chapters || []).flatMap(c => (c.quests || []).map(q => q.id)));
const main = JSON.parse(fs.readFileSync(path.join(SRC, 'mainline.json'), 'utf8'));
const pre = JSON.parse(fs.readFileSync(path.join(SRC, 'prereq.json'), 'utf8'));

const bad = [];
const out = {
  source: 'modpack-study/mainline（WorkBuddy 2026-09-27）',
  quests: main.map(q => {
    if (!allIds.has(q.id)) bad.push(`主线 ${q.title} 的 id ${q.id} 不在 quests.json`);
    for (const d of q.deps || []) if (!allIds.has(d)) bad.push(`${q.title} 的前置 ${d} 不在 quests.json`);
    if (!q.done || !Object.keys(q.done).length) bad.push(`${q.title} 没有完成条件`);
    return {
      id: q.id, title: q.title, deps: q.deps || [], optional: !!q.optional, stage: q.stage,
      done: q.done, hint: q.hint || '', needs: (q.needs || []).map(n => n.text || String(n)).slice(0, 4),
    };
  }),
  prereq: (pre.steps || []).map(s => ({ id: s.id, title: s.title, why: s.why || '', done: s.done || null, hint: s.hint || '' })),
};
if (bad.length) { console.error(`不写：${bad.length} 处不对\n${bad.slice(0, 10).join('\n')}`); process.exit(1); }
const f = path.join(ROOT, 'knowledge', 'mainline.json');
fs.writeFileSync(`${f}.tmp`, JSON.stringify(out, null, 1));
fs.renameSync(`${f}.tmp`, f);
console.log(`mainline.json：主线 ${out.quests.length} 个（可选 ${out.quests.filter(q => q.optional).length}），准备阶段 ${out.prereq.length} 步`);
