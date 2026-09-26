#!/usr/bin/env node
'use strict';

/**
 * 自我复盘 —— 她玩的时候"不对劲"的地方，攒成一份给开发者看的报告。
 *
 * ## 为什么不是日记
 *
 * 她睡前写的日记里其实早就有 bug 了（2026-09-25 那篇：把"铁桶"查成模组的另一种铁桶、
 * 精妙背包只塞进一格、隔九格走不过去）—— 但那是她口吻的散文，混在 mind.json 里，
 * 没证据、没归类，开发者读不到。这里把"给自己看的"和"给做她的人看的"分开。
 *
 * ## 两个来源
 *
 *   auto   程序在明确的异常点自动记（不花模型额度）：动作失败、想的时候出错、
 *          叫了不存在的工具、玩家抱怨、说了要去做却没动、死亡 / 残血、动作被顶掉
 *   self   她自己用 report_issue 写的纸条：发生了什么、本来想干嘛、她猜为什么
 *
 * **证据由程序附，猜测由她写，两者分开存**：她猜的根因不一定对（P45 的第一判断就是错的），
 * 报告里"她猜"只作线索；证据栏只放程序亲眼看到的原文。
 *
 * ## 存盘与读取
 *
 *   memory/self-review.jsonl   只追加，一行一次（含玩家聊天原文 → 不入库，同 journal.md）
 *   node self-review.js                 最近 24 小时的报告（markdown）
 *   node self-review.js --since 2h      / --since 3d / --all
 *   curl --noproxy '*' http://127.0.0.1:3003/mind/review   mind.js 在跑时同一份报告
 *
 * 报告只是线索。确认是 bug 的，按 memory/AGENTS.md 的格式整理进 field-log.md（要有命令 + 真实输出）。
 */

const fs = require('fs');
const path = require('path');

// 用到时才取路径：自测会在 require 之后才设 MC_REVIEW_FILE
const FILE = () => process.env.MC_REVIEW_FILE || path.join(__dirname, 'memory', 'self-review.jsonl');

const CATEGORIES = ['做不到', '查错了', '理解错了', '说错话', '不知道怎么办', '其他'];

/** auto 信号的种类 → 报告里的中文名和排序（越小越靠前） */
const KINDS = {
  action_failed: { zh: '动作没做成', rank: 1 },
  unknown_tool: { zh: '叫了不存在的工具', rank: 2 },
  player_complaint: { zh: '玩家不满意', rank: 3 },
  said_no_action: { zh: '说了要做却没动', rank: 4 },
  died: { zh: '死了', rank: 5 },
  low_hp: { zh: '残血', rank: 6 },
  llm_error: { zh: '想的时候出错', rank: 7 },
  preempted: { zh: '动作被顶掉', rank: 8 },
};

// ------------------------------------------------------------------ 判据（只写这一处）

/** 报错归一：数字、坐标换成 #，这样"走不到 (12,64,-3)"和"走不到 (15,70,8)"算同一类 */
function normErr (e) {
  return String(e || '?').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 同一类问题的签名：用来合并计数 */
function sigOf (r) {
  if (r.source === 'self') return `self:${r.category || '其他'}:${String(r.what || '').slice(0, 30)}`;
  if (r.kind === 'action_failed') return `action_failed:${r.tool}:${normErr(r.error)}`;
  if (r.kind === 'unknown_tool') return `unknown_tool:${r.tool}`;
  if (r.kind === 'llm_error') return `llm_error:${normErr(r.error)}`;
  if (r.kind === 'preempted') return `preempted:${r.tool || '?'}`;
  return r.kind;
}

// "笨"之类也可能是亲昵 —— 这里只筛候选，是不是真不满由读报告的人判断
const COMPLAINT_RE = /扯淡|不对|错了|不是这个|不是那个|你干嘛|搞什么|乱来|别乱|怎么又|又来了|听不懂|答非所问|没用|笨|傻|瞎|我说的是|不是让你|你在干嘛|干啥呢|卡住了|卡了|不动了|发什么呆/;
function looksLikeComplaint (text) { return COMPLAINT_RE.test(String(text || '')); }

// 答应马上去做的话（"我去拿 / 这就来 / 马上"）；"等会儿 / 明天"不算
const PROMISE_RE = /我去|我来|这就|马上|等我|去拿|去做|去砍|去挖|去找|给你拿|给你做|来了/;
function looksLikePromise (text) { return PROMISE_RE.test(String(text || '')); }

// ------------------------------------------------------------------ 写

function clip (s, n = 200) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

/**
 * 记一条。source: 'auto' | 'self'。ctx 是程序附上的现场（证据），调用方传。
 * 写盘失败不抛 —— 记不下来不能影响她玩。
 */
function record (entry) {
  const r = { t: Date.now(), source: 'auto', ...entry };
  r.sig = sigOf(r);
  for (const k of ['error', 'what', 'expected', 'guess', 'text', 'said']) if (r[k] != null) r[k] = clip(r[k], 300);
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.appendFileSync(FILE(), JSON.stringify(r) + '\n');
  } catch (_) { /* 记不下来不影响干活 */ }
  return r;
}

// ------------------------------------------------------------------ 读

function parseSince (s) {
  if (s == null) return Date.now() - 24 * 3600000;
  if (s === 'all') return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([mhd])$/);
  if (!m) throw new Error(`看不懂的时间范围：${s}（例：30m / 2h / 3d / all）`);
  return Date.now() - parseFloat(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

/** 读不到文件（还没记过）返回 []；某一行坏了跳过那一行，不整份作废 */
function read ({ since = 0 } = {}) {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.t >= since) out.push(r); } catch (_) { /* 半行（进程写到一半被杀）*/ }
  }
  return out;
}

/** 按签名合并：次数、首次、最近、最多 3 个样本（最早 1 个 + 最近 2 个） */
function group (entries) {
  const m = new Map();
  for (const r of entries) {
    let g = m.get(r.sig);
    if (!g) m.set(r.sig, g = { sig: r.sig, source: r.source, kind: r.kind, count: 0, first: r.t, last: r.t, samples: [] });
    g.count++; g.first = Math.min(g.first, r.t); g.last = Math.max(g.last, r.t);
    g.samples.push(r);
  }
  for (const g of m.values()) {
    const s = g.samples.sort((a, b) => a.t - b.t);
    g.samples = s.length <= 3 ? s : [s[0], ...s.slice(-2)];
  }
  return [...m.values()];
}

// ------------------------------------------------------------------ 渲染

const fmtT = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function renderContext (r) {
  const L = [];
  if (r.doing) L.push(`当时身体：${r.doing}`);
  if (r.pos) L.push(`位置：(${r.pos.x},${r.pos.y},${r.pos.z})`);
  if (r.hp != null) L.push(`血 ${r.hp}${r.food != null ? `、饥饿 ${r.food}` : ''}`);
  if (r.lastSaid) L.push(`她刚说过：「${clip(r.lastSaid, 60)}」`);
  const out = L.length ? [`  - ${L.join('；')}`] : [];
  if (r.recent?.length) out.push(`  - 之前发生的：\n${r.recent.map(x => `    - ${clip(x, 160)}`).join('\n')}`);
  return out;
}

function renderSample (r) {
  const L = [];
  if (r.source === 'self') {
    L.push(`- **${fmtT(r.t)}** ［${r.category || '其他'}］${r.what}`);
    if (r.expected) L.push(`  - 本来想：${r.expected}`);
    if (r.guess) L.push(`  - 她猜（仅供参考）：${r.guess}`);
    if (r.recentFails?.length) L.push(`  - 最近没做成的：${r.recentFails.map(x => clip(x, 100)).join('；')}`);
  } else if (r.kind === 'action_failed') {
    L.push(`- **${fmtT(r.t)}** \`${r.tool}\` ${r.args ? `\`${clip(JSON.stringify(r.args), 120)}\`` : ''} → ${r.error}`);
    if (r.why) L.push(`  - 为了：${r.why}`);
    if (r.doneBefore?.length) L.push(`  - 前面做完了：${r.doneBefore.join('、')}`);
    if (r.skillId) L.push(`  - 照着技能 ${r.skillId} 做的`);
  } else if (r.kind === 'player_complaint') {
    L.push(`- **${fmtT(r.t)}** ${r.who}：「${r.text}」`);
  } else if (r.kind === 'said_no_action') {
    L.push(`- **${fmtT(r.t)}** 她说了「${r.said}」，这一轮没有任何动作`);
  } else if (r.kind === 'preempted') {
    L.push(`- **${fmtT(r.t)}** 在做 ${r.why || r.tool}（第 ${r.at}/${r.of} 步）时被新动作顶掉，才开始 ${Math.round((r.ranMs || 0) / 1000)}s`);
  } else {
    L.push(`- **${fmtT(r.t)}** ${r.error || r.text || r.tool || ''}`);
  }
  return [...L, ...renderContext(r)].join('\n');
}

function render (entries, { title = 'Angel_ICE 自我复盘', since = null } = {}) {
  if (!entries.length) return `# ${title}\n\n（${since ? `${fmtT(since)} 以来` : ''}没有记到不对劲的地方）\n`;
  const t0 = Math.min(...entries.map(r => r.t)); const t1 = Math.max(...entries.map(r => r.t));
  const self = entries.filter(r => r.source === 'self').sort((a, b) => a.t - b.t);
  const groups = group(entries.filter(r => r.source !== 'self'))
    .sort((a, b) => (KINDS[a.kind]?.rank ?? 99) - (KINDS[b.kind]?.rank ?? 99) || b.count - a.count);
  const out = [
    `# ${title}`,
    '',
    `${fmtT(t0)} ～ ${fmtT(t1)}｜共 ${entries.length} 条：她自己报告 ${self.length} 条，程序记下 ${entries.length - self.length} 条（${groups.length} 类）`,
    '',
    '> 证据栏是程序亲眼看到的原文；"她猜"只是线索。确认是 bug 的整理进 `memory/field-log.md`。',
    '',
  ];
  // 一眼看完：每类一行
  if (groups.length) {
    out.push('## 概览', '', '| 次数 | 类别 | 签名 | 最近 |', '|---:|---|---|---|');
    for (const g of groups) out.push(`| ${g.count} | ${KINDS[g.kind]?.zh || g.kind} | \`${g.sig.replace(/\|/g, '\\|')}\` | ${fmtT(g.last)} |`);
    out.push('');
  }
  if (self.length) {
    out.push('## 她自己察觉的', '');
    for (const r of self) out.push(renderSample(r), '');
  }
  if (groups.length) {
    out.push('## 程序记下的（按类别，同类合并）', '');
    for (const g of groups) {
      out.push(`### ×${g.count} ${KINDS[g.kind]?.zh || g.kind} · \`${g.sig}\``, '');
      if (g.count > 1) out.push(`首次 ${fmtT(g.first)}，最近 ${fmtT(g.last)}${g.count > g.samples.length ? `（下面只列 ${g.samples.length} 个样本）` : ''}`, '');
      for (const r of g.samples) out.push(renderSample(r), '');
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, cond, d) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${JSON.stringify(d)}`}`); };
  const os = require('os');
  process.env.MC_REVIEW_FILE = path.join(os.tmpdir(), `self-review-test-${process.pid}.jsonl`);
  try { fs.unlinkSync(FILE()); } catch (_) {}

  console.log('\n判据');
  check('坐标不同的同一种报错归成一类', normErr('走不到 (12,64,-3)') === normErr('走不到 (15,70,8)'), [normErr('走不到 (12,64,-3)')]);
  check('"你这不扯淡呢" 是抱怨候选', looksLikeComplaint('你这不扯淡呢'));
  check('"干得不错" 不是抱怨', !looksLikeComplaint('干得不错啊'));
  check('"这就来" 是答应马上做', looksLikePromise('好⏎这就来'));
  check('"明天再说" 不是', !looksLikePromise('明天再说'));

  console.log('\n读写');
  check('还没记过 → 空列表（不是报错）', Array.isArray(read()) && read().length === 0);
  record({ kind: 'action_failed', tool: 'goto', args: { x: 1, y: 64, z: 2 }, error: '走不到 (1,64,2)', why: '他叫我过去', recent: ['💬 Ka_sum1 说：过来'] });
  record({ kind: 'action_failed', tool: 'goto', args: { x: 9, y: 70, z: 2 }, error: '走不到 (9,70,2)' });
  record({ kind: 'action_failed', tool: 'craft', error: '缺材料' });
  record({ source: 'self', category: '查错了', what: '他要铁桶，我查成了模组的铁桶', expected: '做原版铁桶', guess: '名字一样，item_info 先返回了模组那个' });
  fs.appendFileSync(FILE(), '{"t":1,"半行\n');
  const all = read({ since: 0 });
  check('坏掉的半行被跳过，其余照读', all.length === 4, all.length);
  check('来源默认 auto', all[0].source === 'auto');
  const g = group(all.filter(r => r.source === 'auto'));
  const gotoG = g.find(x => x.sig.startsWith('action_failed:goto'));
  check('同类合并计数', gotoG?.count === 2 && g.length === 2, g.map(x => [x.sig, x.count]));
  check('since 过滤', read({ since: Date.now() + 1000 }).length === 0);
  check('since 解析 2h', Math.abs(parseSince('2h') - (Date.now() - 7200000)) < 1000);

  console.log('\n报告');
  const md = render(all);
  check('概览里有次数', /\| 2 \| 动作没做成 \|/.test(md), md);
  check('她自己的报告单独一节，猜测标明仅供参考', /## 她自己察觉的[\s\S]*她猜（仅供参考）/.test(md));
  check('证据带上之前发生的事', /Ka_sum1 说：过来/.test(md));
  check('空的时候说没有，不是空白', /没有记到/.test(render([])));

  try { fs.unlinkSync(FILE()); } catch (_) {}
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else {
    const i = argv.indexOf('--since');
    const since = argv.includes('--all') ? 0 : parseSince(i >= 0 ? argv[i + 1] : null);
    process.stdout.write(render(read({ since }), { since }) + '\n');
  }
}

module.exports = { FILE, CATEGORIES, KINDS, normErr, sigOf, looksLikeComplaint, looksLikePromise, record, read, group, render, parseSince };
