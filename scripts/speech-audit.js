#!/usr/bin/env node
'use strict';

/**
 * 她的发言审计 —— 不靠"感觉变自然了"，靠数字。
 *
 * 数据源两种，自动认：
 *   1. `logs/mind-*.log` 实机日志 —— 抽 `说[...]` 字段（` / ` 分隔 = 一条实际发出去的消息）
 *   2. `memory/journal.md` 桥记的聊天 —— `(chat) <名字> 内容`
 * 给了参数就用那个文件；`--since HH:MM` 只看某个时间之后。
 *
 * 用法：
 *   node scripts/speech-audit.js                         记忆（默认）
 *   node scripts/speech-audit.js logs/mind-win-20260929.log   实机日志
 *   node scripts/speech-audit.js logs/xxx.log --since 19:20
 *   node scripts/speech-audit.js logs/xxx.log --samples 20
 *
 * 两件事：
 *   · 发言**形态**（`speech.js` 的 audit）：条数 / 平均字数 / 标点 / ～
 *   · 发言**内容**（`speech.js` 的 classify）：汇报自己的动作 / 问玩家 / 回他的话 / 其他
 *
 * 验收目标（SPEECH-REFORM.md 第六章）：
 *   平均字数 < 15、<20 字占比 > 80%、单条标点 >1 占比 < 20%、～ 0.2–0.3/条、口头禅每场 1–2 次
 * 说话内容目标（TASK-speech-20260929）：「汇报」和「问玩家」都要压下去，其余归「其他」。
 */

const fs = require('fs');
const path = require('path');
const { audit, classify } = require('../src/mind/speech.js');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const since = opt('--since', null);
if (since) { args.splice(args.indexOf('--since'), 2); }
const flag = args.filter(a => a.startsWith('--'));
const pos = args.filter(a => !a.startsWith('--'));
const samples = pos.includes('--samples') ? null : null;
const sampleArg = args.indexOf('--samples');
let sampleN = 15;
if (sampleArg >= 0) { sampleN = Number(args[sampleArg + 1]) || 15; args.splice(sampleArg, 2); }

const file = pos[0]
  ? path.resolve(process.cwd(), pos[0])
  : path.join(__dirname, '..', 'memory', 'journal.md');
const isLog = /\.log$/.test(file);
const bot = process.env.MC_BOT_USERNAME || 'Angle_ICE';

const hhmm = (s) => String(s).slice(0, 5);
const afterSince = (t) => !since || hhmm(t) >= hhmm(since.padEnd(5, ':00'));

/** 一行行拆出她说的话；`at` 用来判断"他刚说过话没有" */
const her = []; const players = [];
if (!fs.existsSync(file)) {
  console.error(`没有这个文件：${file}`);
  process.exit(2);
}
const raw = fs.readFileSync(file, 'utf8').split('\n');

if (isLog) {
  for (const line of raw) {
    const m = line.match(/^\[(\d\d:\d\d:\d\d)\]\s+🧠\s+\S+\s+\d+ms｜说\[(.*?)\] 做\[/);
    if (!m) continue;
    if (!afterSince(m[1])) continue;
    for (const s of m[2].split(' / ').map(x => x.trim()).filter(Boolean)) her.push({ at: m[1], text: s });
  }
} else {
  for (const line of raw) {
    const m = line.match(/^- \[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\] \(chat\) <([^>]+)> (.+)$/);
    if (!m) continue;
    if (!afterSince(m[2])) continue;
    (m[3] === bot ? her : players).push({ at: m[2], text: m[4].trim() });
  }
}

const texts = (a) => a.map(x => x.text);
const show = (name, a) => console.log(`${name.padEnd(8)} 条数 ${String(a.count).padStart(4)}｜平均 ${String(a.avgLen).padStart(5)} 字｜<20字 ${String(a.under20).padStart(3)}%｜标点>1 ${String(a.punctOver1).padStart(3)}%｜～ ${a.tildePerMsg}/条｜诶？${a.catchphraseEh} 我去，${a.catchphraseWoqu}`);

console.log(`━━━ 发言审计${isLog ? `（实机日志 ${path.basename(file)}）` : '（memory/journal.md）'}${since ? ` ${since} 之后` : ''} ━━━`);
const a = audit(texts(her));
show('她', a);
if (!isLog && players.length) show('玩家', audit(texts(players)));
const goal = [
  ['平均字数 < 15', a.avgLen < 15],
  ['<20 字占比 > 80%', a.under20 > 80],
  ['标点>1 占比 < 20%', a.punctOver1 < 20],
  ['～ 0.2–0.3/条', a.tildePerMsg <= 0.3],
];
console.log(goal.map(([k, ok]) => `${ok ? '✅' : '❌'} ${k}`).join('   '));

// ------------------------------------------------------------------ 内容分类
// 他刚说过话之后的 40 秒内，她的话算"在接他"；之外的算"自己开口"
const HEARD_MS = 40 * 1000;
const heardAt = (t) => {
  const [h, m, s] = hhmm(t) === t ? [t.slice(0, 2), t.slice(3, 5), '00'] : [t.slice(0, 2), t.slice(3, 5), t.slice(6, 8)];
  return ((+h) * 3600 + (+m) * 60 + (+s)) * 1000;
};
const saidRecent = (at, saidTimes) => saidTimes.some(t => { const d = heardAt(at) - heardAt(t); return d >= 0 && d <= HEARD_MS; });

// 他说过话的时间点：日志里没有原话，用"他又说了一句（这一轮作废重想）"当锚 —— 那只有他说话才会出现
const playerTimes = [];
for (const line of raw) {
  const m = line.match(/^\[(\d\d:\d\d:\d\d)\].*🔁 他又说了一句/);
  if (m) playerTimes.push(m[1]);
}

const counts = { report: 0, ask: 0, asksback: 0, reply: 0, other: 0 };
const buckets = { report: [], ask: [], asksback: [], reply: [], other: [] };
for (const { at, text } of her) {
  let c = classify(text);
  // 他刚说完话 → 先算"回他的话"（接下来的那段本来就是在接他）
  if (c !== 'other' && playerTimes.length && saidRecent(at, playerTimes)) c = 'reply';
  counts[c]++; buckets[c].push(text);
}
const tot = her.length || 1;
const pct = (n) => `${((n / tot) * 100).toFixed(0)}%`;
console.log(`\n内容分类（共 ${her.length} 条${playerTimes.length ? `；他在 ${playerTimes.length} 个时刻说过话，之后 ${HEARD_MS / 1000} 秒内算"回他的话"` : '；没找到他说过话的锚点，无法区分"回话"和"自己开口"'}）：`);
console.log(`  汇报自己的动作/进度  ${String(counts.report).padStart(4)} 条  ${pct(counts.report)}`);
console.log(`  问玩家               ${String(counts.ask).padStart(4)} 条  ${pct(counts.ask)}`);
console.log(`  把决定反问回给他     ${String(counts.asksback).padStart(4)} 条  ${pct(counts.asksback)}`);
console.log(`  回他的话             ${String(counts.reply).padStart(4)} 条  ${pct(counts.reply)}`);
console.log(`  其他（感受/发现/闲聊）${String(counts.other).padStart(4)} 条  ${pct(counts.other)}`);

if (sampleArg >= 0 || process.argv.includes('--samples')) {
  for (const [k, name] of [['report', '汇报'], ['ask', '问玩家'], ['asksback', '反问决定'], ['other', '其他']]) {
    if (!buckets[k].length) continue;
    console.log(`\n${name}（${buckets[k].length} 条，前 ${Math.min(sampleN, buckets[k].length)} 条）：`);
    for (const l of buckets[k].slice(0, sampleN)) console.log(`  ${l}`);
  }
}
