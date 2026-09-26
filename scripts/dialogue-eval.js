#!/usr/bin/env node
'use strict';

/**
 * 对话回归测试：把 modpack-study/tests/dialogue.jsonl 的题逐题喂给她的"脑子"，按 tests/README.md 的三项打分。
 *
 * ## 为什么
 *
 * 改人设/提示词/思考流程之后，靠进游戏玩一段来判断"是不是变好了"太慢，也说不清。
 * 这里不接游戏：用她真实的 SYSTEM 和全部工具（mind.js 导出的同一份），把每道题拼成她运行时看到的
 * 【此刻】消息，只看**第一反应**（调了哪些工具、说了什么），工具一个都不执行。
 *
 * ## 打分（tests/README.md 第四节，单题 0–6）
 *
 *   项一 工具（0–2）：命中 expect_tools 任意一个（规则判）；must_not 里有没有犯 → 裁判模型判轻/重
 *   项二 说话（0–2）：条数 / 每条 ≤12 字 / 标点 ≤1 / urgent（规则数）；接没接住 → 裁判模型判；取两者较低
 *   项三 事实（0–2）：有没有编造 → 裁判模型判（红线项：0 分的题数必须为 0）
 *   裁判用便宜的模型（默认 MIND_FALLBACK，susu 上的 deepseek），不花主力额度。
 *
 * 用法：
 *   node scripts/dialogue-eval.js                     全部 120 题
 *   node scripts/dialogue-eval.js --only g01,g02      只跑这几题
 *   node scripts/dialogue-eval.js --cat danger_urgent 只跑一类
 *   node scripts/dialogue-eval.js --limit 10 --no-judge
 *   node scripts/dialogue-eval.js --label 改说话前     结果文件名里带上标签，方便前后对比
 * 结果：modpack-study/tests/results/<时间>-<标签>.json + .md
 */

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const body = require('../body.js');
const { SYSTEM, SPECS } = require('../mind.js');
const speech = require('../speech.js');

const TESTS = '/Users/starwish/aimc/modpack-study/tests/dialogue.jsonl';
const OUTDIR = '/Users/starwish/aimc/modpack-study/tests/results';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const CAT = arg('--cat');
const LIMIT = +arg('--limit', 0);
const JUDGE = !has('--no-judge');
const JUDGE_MODEL = arg('--judge-model', body.CFG.fallback);
const LABEL = arg('--label', '');
const CONC = +arg('--conc', 4);
const PLAYER = 'Ka_sum1';

const hhmmss = () => new Date().toTimeString().slice(0, 8);

/** 题 → 她运行时看到的【此刻】消息（和 mind.js buildNow 同样的骨架） */
function nowText (t) {
  const said = (t.player_says || '').trim();
  const lines = [`【此刻 ${hhmmss()}】`, `情况：${t.context}`];
  lines.push(said ? `\n刚才发生的：\n[${hhmmss()}] ${PLAYER} 说：${said}` : '\n（没有人说话）');
  if (said) lines.push(`\n【他刚说的】${PLAYER} 说：${said}（先接这一句）`);
  if (said) lines.push('\n（打字：几条短的，一条 ≤12 字，换行分条；不用括号动作和～）');
  return lines.join('\n');
}

/** 从 say_style 里读出"应该说几条"：0 / 上限 / 不限 */
function expectedCount (style) {
  const s = String(style || '');
  if (/不说话|0\s*条|闭嘴|不开口/.test(s)) return { max: 0 };
  const m = s.match(/(\d+)\s*[–-]\s*(\d+)\s*条/) || s.match(/[≤<=]\s*(\d+)\s*条/) || s.match(/(\d+)\s*条/);
  if (!m) return { max: 3 };
  return { max: +(m[2] || m[1]) };
}

/** 项二的"形态"部分：纯规则 */
function formScore (t, says, urgentUsed) {
  const exp = expectedCount(t.say_style);
  const lines = says.flatMap(s => String(s).split(/\n+/)).map(x => x.trim()).filter(Boolean);
  const notes = [];
  if (exp.max === 0) return lines.length ? { score: 0, notes: ['该闭嘴却开口了'] } : { score: 2, notes };
  if (!lines.length) {
    // 不需要说话的题（纯动作）不扣；要回话的题一字不说 = 0
    return /\d+\s*条|接住|回/.test(t.say_style || '') ? { score: 0, notes: ['该开口却没说话'] } : { score: 2, notes };
  }
  let bad = 0;
  if (lines.length > exp.max) { bad++; notes.push(`说了 ${lines.length} 条，上限 ${exp.max}`); }
  const long = lines.filter(l => speech.len(l) > 12); if (long.length) { bad++; notes.push(`超 12 字：${long.slice(0, 2).join(' / ')}`); }
  const punct = lines.filter(l => speech.punctCount(l) > 1); if (punct.length) { bad++; notes.push('单条标点 >1'); }
  if (/[（(][^）)]*[）)]|[~～]/.test(lines.join(''))) { bad++; notes.push('括号动作或～'); }
  if (/urgent/.test(t.say_style || '') && !urgentUsed) { bad++; notes.push('该加 urgent 没加'); }
  return { score: bad === 0 ? 2 : bad === 1 ? 1 : 0, notes };
}

const JUDGE_SYS = `你是一个严格的测评员，给一个 Minecraft 陪伴型 AI（Angel_ICE）的单轮反应打分。只输出 JSON，不要别的文字。`;
function judgePrompt (t, resp) {
  return `【题目】
类别：${t.category}
情境：${t.context}
玩家说：${t.player_says || '（没说话）'}
期望调用的工具（任意一个即可）：${JSON.stringify(t.expect_tools)}
绝对不能做的：${JSON.stringify(t.must_not)}
说话要点：${t.say_style}
出题理由：${t.why}

【她的反应】
调用的工具（名字和参数）：${JSON.stringify(resp.calls)}
她说的话：${JSON.stringify(resp.says)}
她写的心里话（不会发出去）：${JSON.stringify(resp.content || '')}

【打分】输出 JSON：
{"must_not_violation": "none" | "light" | "hard",   // 有没有犯"绝对不能做的"；hard=硬伤（该动没动、编造、违背主人意愿等）
 "content": 0|1|2,   // 说的话内容：2=接住了、口吻对；1=接住但有瑕疵；0=答非所问/该说没说/说了系统词。没说话且本就不该说 → 2
 "facts": 0|1|2,     // 事实：2=没编造、不确定就说不确定；1=有一处含糊；0=编造了配方/位置/数量/记忆，或凭原版印象硬答。没说任何事实性内容 → 2
 "note": "一句话理由"}`;
}

async function judge (t, resp) {
  const m = await body.llm({ model: JUDGE_MODEL, messages: [{ role: 'system', content: JUDGE_SYS }, { role: 'user', content: judgePrompt(t, resp) }], timeoutMs: 60000, maxTokens: 400 });
  const s = String(m.content || '');
  const j = JSON.parse((s.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  return j;
}

async function runOne (t) {
  const t0 = Date.now();
  let msg;
  try {
    msg = await body.llm({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: nowText(t) }], tools: SPECS, timeoutMs: 60000 });
  } catch (e) { return { id: t.id, category: t.category, error: e.message, score: 0 }; }
  const calls = (msg.tool_calls || []).map(c => ({ name: c.function?.name, args: body.parseArgs(c.function?.arguments) }));
  const says = calls.filter(c => c.name === 'say').map(c => String(c.args.text || c.args.message || ''));
  const urgentUsed = calls.some(c => c.name === 'say' && c.args.urgent);
  const names = calls.map(c => c.name);
  const expect = Array.isArray(t.expect_tools) ? t.expect_tools.flat() : [t.expect_tools];
  const hit = expect.length === 0 ? true : names.some(n => expect.includes(n));
  const form = formScore(t, says, urgentUsed);
  const resp = { calls, says, content: msg.content || '' };
  let j = null; let judgeError = null;
  if (JUDGE) { try { j = await judge(t, resp); } catch (e) { judgeError = e.message; } }
  const pen = j?.must_not_violation === 'hard' ? 2 : j?.must_not_violation === 'light' ? 1 : 0;
  const s1 = hit ? Math.max(0, 2 - pen) : 0;
  const s2 = j ? Math.min(form.score, +j.content) : form.score;
  const s3 = j ? +j.facts : null;
  return {
    id: t.id, category: t.category, player_says: t.player_says, ms: Date.now() - t0,
    tools: names, says, hit, form: form.notes, judge: j, judgeError,
    s1, s2, s3, score: s1 + s2 + (s3 ?? 0),
  };
}

async function pool (items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); process.stdout.write(`\r  ${out.filter(Boolean).length}/${items.length}`); }
  }));
  process.stdout.write('\n');
  return out;
}

(async () => {
  let tests = fs.readFileSync(TESTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  if (ONLY) tests = tests.filter(t => ONLY.has(t.id));
  if (CAT) tests = tests.filter(t => t.category === CAT);
  if (LIMIT) tests = tests.slice(0, LIMIT);
  console.log(`跑 ${tests.length} 题｜她的模型 ${body.CFG.model}｜裁判 ${JUDGE ? JUDGE_MODEL : '（不用）'}`);
  const rs = await pool(tests, CONC, runOne);

  const full = JUDGE ? 6 : 4;
  const byCat = {};
  for (const r of rs) {
    const c = byCat[r.category] ||= { n: 0, score: 0, s1: 0, s2: 0, s3: 0, err: 0 };
    c.n++; c.score += r.score || 0; c.s1 += r.s1 || 0; c.s2 += r.s2 || 0; c.s3 += r.s3 || 0; if (r.error) c.err++;
  }
  const total = rs.reduce((a, r) => a + (r.score || 0), 0);
  const fabricated = rs.filter(r => r.s3 === 0);
  const pct = (a, b) => `${Math.round(a / b * 100)}%`;
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  fs.mkdirSync(OUTDIR, { recursive: true });
  const base = path.join(OUTDIR, `${stamp}${LABEL ? '-' + LABEL : ''}`);
  fs.writeFileSync(base + '.json', JSON.stringify({ at: new Date().toISOString(), label: LABEL, model: body.CFG.model, judge: JUDGE ? JUDGE_MODEL : null, total, full: full * rs.length, results: rs }, null, 1));

  const md = [`# 对话回归测试 ${new Date().toLocaleString('zh-CN')}${LABEL ? `（${LABEL}）` : ''}`, '',
    `她的模型 ${body.CFG.model}｜裁判 ${JUDGE ? JUDGE_MODEL : '不用'}｜${rs.length} 题`, '',
    `**总分 ${total} / ${full * rs.length}（${pct(total, full * rs.length)}）**｜工具 ${pct(rs.reduce((a, r) => a + (r.s1 || 0), 0), 2 * rs.length)}｜说话 ${pct(rs.reduce((a, r) => a + (r.s2 || 0), 0), 2 * rs.length)}${JUDGE ? `｜事实 ${pct(rs.reduce((a, r) => a + (r.s3 || 0), 0), 2 * rs.length)}` : ''}`,
    JUDGE ? `**编造（事实 0 分）：${fabricated.length} 题**${fabricated.length ? ' —— ' + fabricated.map(r => r.id).join('、') : ''}` : '', '',
    '| 类别 | 题数 | 得分率 | 工具 | 说话 | 事实 | 出错 |', '|---|---|---|---|---|---|---|',
    ...Object.entries(byCat).map(([k, c]) => `| ${k} | ${c.n} | ${pct(c.score, c.n * full)} | ${pct(c.s1, c.n * 2)} | ${pct(c.s2, c.n * 2)} | ${JUDGE ? pct(c.s3, c.n * 2) : '-'} | ${c.err} |`),
    '', '## 失分的题', '', '| 题 | 分 | 他说 | 她调了 | 她说 | 问题 |', '|---|---|---|---|---|---|',
    ...rs.filter(r => r.error || r.score < full).sort((a, b) => a.score - b.score).map(r => `| ${r.id} | ${r.error ? '出错' : r.score} | ${(r.player_says || '—').slice(0, 16)} | ${(r.tools || []).join(',') || '—'} | ${(r.says || []).join(' / ').replace(/\n/g, '⏎').slice(0, 40) || '—'} | ${[r.error, r.hit === false ? '没调期望的工具' : '', ...(r.form || []), r.judge?.note].filter(Boolean).join('；').slice(0, 90)} |`),
  ].filter(x => x !== '').join('\n');
  fs.writeFileSync(base + '.md', md);
  console.log(md.split('\n').slice(0, 20).join('\n'));
  console.log(`\n→ ${base}.md`);
  process.exit(0);
})();
