#!/usr/bin/env node
'use strict';

/**
 * 她的发言形态审计 —— 不靠"感觉变自然了"，靠数字。
 *
 * 数据源：
 *   memory/journal.md   桥自动记的聊天：`(chat) <名字> 内容`（每条实际发出去的消息一行）
 *
 * 用法：
 *   node scripts/speech-audit.js              全部
 *   node scripts/speech-audit.js --since 19:20   只看今天某个时间之后（改动前后对比用）
 *
 * 验收目标（SPEECH-REFORM.md 第六章）：
 *   平均字数 < 15、<20 字占比 > 80%、单条标点 >1 占比 < 20%、～ 0.2–0.3/条、口头禅每场 1–2 次
 */

const fs = require('fs');
const path = require('path');
const { audit } = require('../speech');

const file = path.join(__dirname, '..', 'memory', 'journal.md');
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? process.argv[sinceArg + 1] : null;
const bot = process.env.MC_BOT_USERNAME || 'Angel_ICE';

const her = []; const players = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^- \[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\] \(chat\) <([^>]+)> (.+)$/);
  if (!m) continue;
  if (since && `${m[2]}` < since.padEnd(8, ':00').slice(0, 8)) continue;
  (m[3] === bot ? her : players).push(m[4].trim());
}

const show = (name, a) => console.log(`${name.padEnd(8)} 条数 ${String(a.count).padStart(4)}｜平均 ${String(a.avgLen).padStart(5)} 字｜<20字 ${String(a.under20).padStart(3)}%｜标点>1 ${String(a.punctOver1).padStart(3)}%｜～ ${a.tildePerMsg}/条｜诶？${a.catchphraseEh} 我去，${a.catchphraseWoqu}`);
console.log(`━━━ 发言形态审计${since ? `（${since} 之后）` : ''} ━━━`);
show('她', audit(her));
show('玩家', audit(players));
const a = audit(her);
const goal = [
  ['平均字数 < 15', a.avgLen < 15],
  ['<20 字占比 > 80%', a.under20 > 80],
  ['标点>1 占比 < 20%', a.punctOver1 < 20],
  ['～ 0.2–0.3/条', a.tildePerMsg <= 0.3],
];
console.log(goal.map(([k, ok]) => `${ok ? '✅' : '❌'} ${k}`).join('   '));
if (process.argv.includes('--samples')) {
  console.log('\n她最近的 15 条：');
  for (const l of her.slice(-15)) console.log(`  ${l}`);
}
