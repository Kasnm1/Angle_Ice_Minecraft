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
const { SYSTEM, SPECS, SAY_NUDGE } = require('../mind.js');
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
function formScore (t, says, urgentUsed, perRound = null) {
  const exp = expectedCount(t.say_style);
  const lines = says.flatMap(s => String(s).split(/\n+/)).map(x => x.trim()).filter(Boolean);
  // 条数按"每一轮"算（先说"我看看"、查完再说答案是两轮各一条，真人也这样），取最多的那一轮；连着 3 轮以上都在说才算啰嗦
  const roundLines = perRound ? perRound.map(r => r.flatMap(s => String(s).split(/\n+/)).map(x => x.trim()).filter(Boolean).length) : [lines.length];
  const maxInRound = Math.max(0, ...roundLines);
  const talkRounds = roundLines.filter(n => n > 0).length;
  const notes = [];
  if (exp.max === 0) return lines.length ? { score: 0, notes: ['该闭嘴却开口了'] } : { score: 2, notes };
  if (!lines.length) {
    // 不需要说话的题（纯动作）不扣；要回话的题一字不说 = 0
    return /\d+\s*条|接住|回/.test(t.say_style || '') ? { score: 0, notes: ['该开口却没说话'] } : { score: 2, notes };
  }
  let bad = 0;
  if (maxInRound > exp.max) { bad++; notes.push(`一轮说了 ${maxInRound} 条，上限 ${exp.max}`); }
  if (talkRounds >= 3) { bad++; notes.push(`连着 ${talkRounds} 轮都在说话`); }
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

【她的反应】（多轮：她查完一轮会再想一轮，共 ${resp.rounds?.length || 1} 轮：${(resp.rounds || []).join(' → ')}。
这是离线测评 —— 背包/周围/记忆这类实时查询只会得到"以情况为准"，她据此说"不知道/我看看"不算错；知识库查询是真的）
调用的工具（名字和参数，按先后）：${JSON.stringify(resp.calls.map(c => ({ name: c.name, args: c.args })))}
她从知识库查到的内容（整合包真实数据；她的话若和这里一致就**不是编造**）：
${resp.calls.filter(c => c.result).map(c => `· ${c.name}(${JSON.stringify(c.args)})：${c.result}`).join('\n') || '（没查知识库）'}
她说的话：${JSON.stringify(resp.says)}
她写的心里话（不会发出去）：${JSON.stringify(resp.content || '')}

【打分】输出 JSON：
{"must_not_violation": "none" | "light" | "hard",   // 有没有犯"绝对不能做的"；hard=硬伤（该动没动、编造、违背主人意愿等）
 "content": 0|1|2,   // 说的话内容：2=接住了、口吻对；1=接住但有瑕疵；0=答非所问/该说没说/说了系统词。没说话且本就不该说 → 2
 "facts": 0|1|2,     // 事实：2=没编造、不确定就说不确定；1=有一处含糊；0=编造了配方/位置/数量/记忆，或凭原版印象硬答。没说任何事实性内容 → 2
 "note": "一句话理由"}`;
}

/** 裁判回的 JSON 常常不规整（少逗号、夹说明文字）：先按 JSON 解，不行就用正则把三个字段抠出来；抠不全就重问，最多 3 次 */
function parseVerdict (s) {
  const raw = String(s || '');
  try { const j = JSON.parse((raw.match(/\{[\s\S]*\}/) || [''])[0]); if (valid(j)) return j; } catch (_) {}
  const pick = (k, re) => (raw.match(new RegExp(`"?${k}"?\\s*[:：]\\s*"?(${re})`)) || [])[1];
  const j = { must_not_violation: pick('must_not_violation', 'none|light|hard'), content: +pick('content', '[012]'), facts: +pick('facts', '[012]'), note: (raw.match(/"?note"?\s*[:：]\s*"([^"]*)/) || [])[1] || '' };
  return valid(j) ? j : null;
}
const valid = (j) => j && ['none', 'light', 'hard'].includes(j.must_not_violation) && [0, 1, 2].includes(+j.content) && [0, 1, 2].includes(+j.facts);

async function judge (t, resp) {
  let last = '';
  for (let i = 0; i < 3; i++) {
    const m = await body.llm({ model: JUDGE_MODEL, messages: [{ role: 'system', content: JUDGE_SYS }, { role: 'user', content: judgePrompt(t, resp) }], timeoutMs: 60000, maxTokens: 400 });
    last = String(m.content || '');
    const j = parseVerdict(last);
    if (j) return { ...j, content: +j.content, facts: +j.facts };
  }
  throw new Error(`裁判 3 次都没给出能用的打分：${last.slice(0, 80)}`);
}

// ---- 多轮：照 mind.js think() 的流程 —— 查完的结果喂回去，她查完才开口（只看第一轮会把"先查再说"误判成"该说不说"）
const knowledge = require('../knowledge.js');
const MIND_KIND = (() => {   // mind.js 心里那些工具的类型（没导出，从源码里读，和 think() 用的是同一份定义）
  const src = fs.readFileSync(path.join(__dirname, '..', 'mind.js'), 'utf8');
  const seg = src.slice(src.indexOf('const MIND_TOOLS = {'), src.indexOf('const ALL ='));
  return Object.fromEntries([...seg.matchAll(/\n  (\w+): \{\n    kind: '(\w+)'/g)].map(m => [m[1], m[2]]));
})();
const kindOf = (n) => MIND_KIND[n] || body.TOOLS[n]?.kind || null;
// 和真实运行一样多的轮数（mind.js CFG.maxRounds，现在是 6）—— 少给了会冤枉她"查了半天不说话"
const MAX_ROUNDS = +(fs.readFileSync(path.join(__dirname, '..', 'mind.js'), 'utf8').match(/maxRounds:\s*(\d+)/) || [0, 6])[1];
const OFFLINE_KB = new Set(['item_info', 'recipe', 'how_to_obtain', 'item_uses', 'guide_search']);   // 只读知识库，离线能真跑
const NO_LIVE = { ok: true, note: '（离线测评）这里看不到实时数据：以【此刻】里写的情况为准，情况里没写的就是不知道' };

async function toolResult (name, args) {
  const k = kindOf(name);
  if (!k) return { ok: false, error: `没有 ${name} 这个工具` };
  if (name === 'say') return { ok: true, sent: speech.segment(String(args.text || args.message || '')) };
  if (OFFLINE_KB.has(name)) { try { return { ok: true, ...(await body.TOOLS[name].run(args)) }; } catch (e) { return { ok: false, error: e.message }; } }
  if (name === 'knowledge_search') { try { return { ok: true, text: knowledge.describe(args.q || args.name || '') }; } catch (e) { return { ok: false, error: e.message }; } }
  if (k === 'info') return NO_LIVE;                                   // 背包、周围、记忆、家里存货、心愿进度…
  if (k === 'memory') return { ok: true, note: '（离线测评：记下了，但不会真的写进她的记忆）' };
  if (k === 'skill') return { ok: true, note: '开始照技能做了' };
  if (k === 'end') return { ok: true };
  return { ok: true, note: '身体开始做了，做完会告诉你' };            // 动作：和真实运行时的回执一样
}

async function runOne (t, attempt = 0) {
  const t0 = Date.now();
  const history = [{ role: 'user', content: nowText(t) }];
  const calls = []; const rounds = []; let nudged = false;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const msg = await body.llm({ messages: [{ role: 'system', content: SYSTEM }, ...history], tools: SPECS, timeoutMs: 90000 });
      const cs = msg.tool_calls || [];
      history.push({ role: 'assistant', content: msg.content || '', ...(cs.length ? { tool_calls: cs } : {}) });
      rounds.push(cs.length ? cs.map(c => c.function?.name).join('+') : (msg.content ? '只写了正文' : '空回复'));
      if (!cs.length) {
        // 和 think() 一样：他说了话、她只在正文里回（没调 say）→ 提醒一次
        if ((t.player_says || '').trim() && !calls.some(c => c.name === 'say') && !nudged && round < MAX_ROUNDS - 1 && msg.content) {
          nudged = true; history.push({ role: 'user', content: SAY_NUDGE }); continue;
        }
        break;
      }
      let needMore = false; let end = false; let acted = false;
      for (const c of cs) {
        const name = c.function?.name; const args = body.parseArgs(c.function?.arguments);
        const result = await toolResult(name, args);
        calls.push({ name, args, round, result: (OFFLINE_KB.has(name) || name === 'knowledge_search') ? String(result.text || result.error || '').slice(0, 2000) : undefined });
        const k = kindOf(name);
        if (k === 'info' || !k) needMore = true;
        if (k === 'end') end = true;
        if (k === 'action' || k === 'skill') acted = true;
        history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 1800) });
      }
      // 和 think() 一样：只说话/只记笔记、没动作也没结束 → 再想一轮
      if (!acted && !end && cs.every(c => ['speech', 'memory'].includes(kindOf(c.function?.name)))) needMore = true;
      if (end || !needMore) break;
    }
  } catch (e) {
    // 中转站 502 / 超时是一时的：等一会儿整题重跑（最多再试 2 次），别让一段网络抖动毁掉半张卷子
    if (attempt < 2 && e.message !== 'aborted') { await new Promise(r => setTimeout(r, 15000 * (attempt + 1))); return runOne(t, attempt + 1); }
    return { id: t.id, category: t.category, error: e.message, score: 0, calls, rounds };
  }
  const msg = { content: history.filter(m => m.role === 'assistant').map(m => m.content).filter(Boolean).join(' / ') };
  const says = calls.filter(c => c.name === 'say').map(c => String(c.args.text || c.args.message || ''));
  const urgentUsed = calls.some(c => c.name === 'say' && c.args.urgent);
  const names = calls.map(c => c.name);
  const expect = Array.isArray(t.expect_tools) ? t.expect_tools.flat() : [t.expect_tools];
  const hit = expect.length === 0 ? true : names.some(n => expect.includes(n));
  const perRound = rounds.map((_, i) => calls.filter(c => c.round === i && c.name === 'say').map(c => String(c.args.text || c.args.message || '')));
  const form = formScore(t, says, urgentUsed, perRound);
  const resp = { calls, says, content: msg.content || '', rounds };
  let j = null; let judgeError = null;
  if (JUDGE) { try { j = await judge(t, resp); } catch (e) { judgeError = e.message; } }
  const pen = j?.must_not_violation === 'hard' ? 2 : j?.must_not_violation === 'light' ? 1 : 0;
  const s1 = hit ? Math.max(0, 2 - pen) : 0;
  const s2 = j ? Math.min(form.score, j.content) : form.score;
  const s3 = j ? j.facts : null;   // 裁判失败：事实这一项不计分、也不计入分母（不当成 0 分）
  return {
    id: t.id, category: t.category, player_says: t.player_says, ms: Date.now() - t0,
    tools: names, rounds, says, hit, form: form.notes, judge: j, judgeError,
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

  // 每题满分：工具 2 + 说话 2 +（裁判判出了事实项才加 2）。裁判失败的题，事实项不计入分母
  const maxOf = (r) => 4 + (r.s3 != null ? 2 : 0);
  const byCat = {};
  for (const r of rs) {
    const c = byCat[r.category] ||= { n: 0, score: 0, max: 0, s1: 0, s2: 0, s3: 0, n3: 0, err: 0 };
    c.n++; c.score += r.score || 0; c.max += maxOf(r); c.s1 += r.s1 || 0; c.s2 += r.s2 || 0; if (r.error) c.err++;
    if (r.s3 != null) { c.s3 += r.s3; c.n3++; }
  }
  const total = rs.reduce((a, r) => a + (r.score || 0), 0);
  const totalMax = rs.reduce((a, r) => a + maxOf(r), 0);
  const judged = rs.filter(r => r.s3 != null);
  const fabricated = rs.filter(r => r.s3 === 0);
  const pct = (a, b) => `${Math.round(a / b * 100)}%`;
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  fs.mkdirSync(OUTDIR, { recursive: true });
  const base = path.join(OUTDIR, `${stamp}${LABEL ? '-' + LABEL : ''}`);
  fs.writeFileSync(base + '.json', JSON.stringify({ at: new Date().toISOString(), label: LABEL, model: body.CFG.model, judge: JUDGE ? JUDGE_MODEL : null, total, full: totalMax, results: rs }, null, 1));

  const md = [`# 对话回归测试 ${new Date().toLocaleString('zh-CN')}${LABEL ? `（${LABEL}）` : ''}`, '',
    `她的模型 ${body.CFG.model}｜裁判 ${JUDGE ? JUDGE_MODEL : '不用'}｜${rs.length} 题`, '',
    `**总分 ${total} / ${totalMax}（${pct(total, totalMax)}）**｜工具 ${pct(rs.reduce((a, r) => a + (r.s1 || 0), 0), 2 * rs.length)}｜说话 ${pct(rs.reduce((a, r) => a + (r.s2 || 0), 0), 2 * rs.length)}${JUDGE ? `｜事实 ${pct(judged.reduce((a, r) => a + r.s3, 0), 2 * judged.length || 1)}（裁判判出 ${judged.length}/${rs.length} 题）` : ''}`,
    JUDGE ? `**编造（事实 0 分）：${fabricated.length} 题**${fabricated.length ? ' —— ' + fabricated.map(r => r.id).join('、') : ''}` : '', '',
    '| 类别 | 题数 | 得分率 | 工具 | 说话 | 事实 | 出错 |', '|---|---|---|---|---|---|---|',
    ...Object.entries(byCat).map(([k, c]) => `| ${k} | ${c.n} | ${pct(c.score, c.max)} | ${pct(c.s1, c.n * 2)} | ${pct(c.s2, c.n * 2)} | ${JUDGE && c.n3 ? pct(c.s3, c.n3 * 2) : '-'} | ${c.err} |`),
    '', '## 失分的题', '', '| 题 | 分 | 他说 | 她调了 | 她说 | 问题 |', '|---|---|---|---|---|---|',
    ...rs.filter(r => r.error || r.score < maxOf(r)).sort((a, b) => a.score - b.score).map(r => `| ${r.id} | ${r.error ? '出错' : r.score} | ${(r.player_says || '—').slice(0, 16)} | ${(r.tools || []).join(',') || '—'} | ${(r.says || []).join(' / ').replace(/\n/g, '⏎').slice(0, 40) || '—'} | ${[r.error, r.hit === false ? '没调期望的工具' : '', ...(r.form || []), r.judge?.note, r.judgeError].filter(Boolean).join('；').slice(0, 90)} |`),
  ].filter(x => x !== '').join('\n');
  fs.writeFileSync(base + '.md', md);
  console.log(md.split('\n').slice(0, 20).join('\n'));
  console.log(`\n→ ${base}.md`);
  process.exit(0);
})();
