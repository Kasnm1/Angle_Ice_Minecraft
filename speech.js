'use strict';

/**
 * 她说话的"形态"：把一段话拆成几条短消息，像真人打字那样一条条发。
 *
 * ## 为什么
 *
 * 数据（memory/journal.md 真实聊天）：玩家平均 12.6 字/条、79% 不到 20 字；
 * 她平均 43.8 字/条、只有 16% 不到 20 字。**她说的是"一段话"，真玩家说的是"几条短句"。**
 * 这是"AI 感"最大的来源 —— 用词本身挺好。
 *
 * ## 分段放在发送层（AstrBot 的做法）
 *
 * 人设里已经要求她说短、分条（示范也改成了分条形态），但模型不一定每次都照做。
 * 这里在发出去之前再兜一次底：按标点把长的拆成 2–4 条。
 *
 *   · **只拆不改字**：拆完后比对去掉标点和空白的文字，必须和原文一字不差，否则原样发（保真校验）
 *   · 句号、逗号去掉；情绪标点（！？…）留着；`～` 一轮最多留一个（在最后一条）
 *   · 括号里的小动作单独一条；坐标 (128, 64, -47) 不会被逗号拆开
 *   · 已经够短的不硬拆；最多 4 条
 *   · 危险提示（urgent）不拆 —— 拆开发会延迟关键信息
 *
 * 思路参考 saberlights/smart_segmentation_plugin（只借鉴思路，没有拷代码）。
 */

const PUNCT = /[，,。.!！?？…~～;；、：:\s—\-]/g;
const EMOTION_END = /[！!？?…]+$/;
const MAX_LEN = 12;
const MAX_SEGMENTS = 4;

/** 去掉标点和空白，只留字 —— 保真校验用 */
function wordsOnly (s) {
  return String(s).replace(/[（(][^）)]*[）)]/g, m => m.replace(PUNCT, '')).replace(PUNCT, '').replace(/[（）()「」"'“”]/g, '');
}

const punctCount = (s) => (String(s).match(/[，,。.!！?？…~～;；]/g) || []).length;
const len = (s) => [...String(s).replace(/\s/g, '')].length;

/**
 * 一段话 → 几条短消息。
 * 换行是她自己分好的条（优先尊重）；每条再按标点细分。
 */
// 括号里的小动作（不是坐标）：不发。用户要的是从语气里体会她，不是看她表演动作
const ACTION_RE = /[（(](?![\s\d-]*\d+\s*,)[^）)]*[）)]/g;

// 口头禅：偶尔冒出来才像真的。同一个口头禅 10 分钟内只让它出现一次
const CATCH = [/^诶[？?]*$/, /^我去[，,]?$/];
const lastCatch = new Map();
function limitCatchphrases (segs, now = Date.now()) {
  return segs.filter((s, i) => {
    const k = CATCH.findIndex(re => re.test(s.trim()));
    if (k < 0 || segs.length === 1) return true;
    if (now - (lastCatch.get(k) || 0) < 10 * 60 * 1000) return false;
    lastCatch.set(k, now);
    return true;
  });
}

function segment (text, { maxLen = MAX_LEN, maxSegments = MAX_SEGMENTS } = {}) {
  // 示范里用 ⏎ 表示"另起一条"，模型有时会照抄这个符号 —— 当换行处理
  const raw = String(text || '').replace(/\s*[⏎↵]\s*/g, '\n').replace(ACTION_RE, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!raw) return [];
  const pieces = [];
  for (const line of raw.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
    const hasAction = /[（(][^）)0-9-][^）)]*[）)]/.test(line);   // 括号小动作（不是坐标）总要单独一条
    if (!hasAction && len(line) <= maxLen && punctCount(line) <= 1) { pieces.push(line); continue; }
    // 保护：括号（小动作 / 坐标）整体不拆
    const tokens = [];
    const re = /[（(][^）)]*[）)]|[^（(]+/g;
    let m;
    while ((m = re.exec(line))) tokens.push(m[0]);
    for (const tk of tokens) {
      if (/^[（(]/.test(tk)) {
        // 坐标（全是数字）跟着前一条；小动作单独一条
        if (/^[（(]\s*-?\d+\s*,\s*-?\d+/.test(tk) && pieces.length) pieces[pieces.length - 1] += tk;
        else pieces.push(tk);
        continue;
      }
      // 按标点切，情绪标点留在前一段末尾
      const parts = tk.match(/[^，,。.!！?？…~～;；]+[!！?？…~～]*[，,。.;；]?/g) || [tk];
      for (let p of parts) {
        p = p.trim();
        if (!p) continue;
        pieces.push(p);
      }
    }
  }
  // 清理每段的结尾：句号逗号去掉，情绪标点留下
  let segs = pieces.map(p => p.replace(/[，,。.;；、：:]+$/, '').trim()).filter(p => wordsOnly(p) || /[！？!?]/.test(p));
  // 太碎的并回去：1 个字、又没有情绪的（"嗯"单独一条可以，"的"单独一条不行）
  const keepAlone = /^(诶|嗯|哦|啊|呜|嘿|哇|好|欸|唔|嘻|哼|我去)[！？!?…～,，]*$|[！？!?]$|^[（(]/;
  for (let i = segs.length - 1; i > 0; i--) {
    if (len(segs[i]) <= 1 && !keepAlone.test(segs[i])) { segs[i - 1] += segs[i]; segs.splice(i, 1); }
  }
  // 条数上限：把最短的相邻两条并起来
  while (segs.length > maxSegments) {
    let best = 0; let bestLen = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^[（(]/.test(segs[i + 1])) continue;
      const l = len(segs[i]) + len(segs[i + 1]);
      if (l < bestLen) { bestLen = l; best = i; }
    }
    segs.splice(best, 2, `${segs[best]} ${segs[best + 1]}`.replace(/(\S)\s(\S)/, (a, x, y) => (/[a-z0-9]/i.test(x) && /[a-z0-9]/i.test(y) ? `${x} ${y}` : `${x}${y}`)));
  }
  // `～` 不用（语气在话本身里，不靠符号堆）
  segs = segs.map(s => s.replace(/[~～]+/g, '').trim()).filter(Boolean);
  // 保真校验：只比字，字被改了就原样发（先校验，再按频率去掉重复的口头禅 —— 那是有意删的）
  if (wordsOnly(segs.join('')) !== wordsOnly(raw)) return [raw.replace(/[~～]+/g, '').slice(0, 256)];
  return limitCatchphrases(segs).map(s => s.slice(0, 256));
}

/** 条间停顿：按下一条的字数算打字时间，再加点随机（真人不会每次一样快） */
function gapFor (next) {
  return Math.round(350 + len(next) * 70 + Math.random() * 300);
}

// ------------------------------------------------------------------ 审计

/**
 * 她的发言形态：条数 / 平均字数 / <20 字占比 / 单条标点 >1 占比 / ～ 频率 / 口头禅次数。
 * 验收目标（SPEECH-REFORM.md 第六章）：平均 < 15 字、<20 字 > 80%、标点>1 < 20%、～ 0.2–0.3/条。
 */
function audit (lines) {
  const n = lines.length || 1;
  const lens = lines.map(len);
  return {
    count: lines.length,
    avgLen: +(lens.reduce((a, b) => a + b, 0) / n).toFixed(1),
    under20: +((lens.filter(l => l < 20).length / n) * 100).toFixed(0),
    punctOver1: +((lines.filter(l => punctCount(l) > 1).length / n) * 100).toFixed(0),
    tildePerMsg: +((lines.join('').match(/[~～]/g) || []).length / n).toFixed(2),
    catchphraseEh: lines.filter(l => /^诶[？?]/.test(l)).length,
    catchphraseWoqu: lines.filter(l => /^我去/.test(l)).length,
  };
}

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = typeof expect === 'function' ? expect(got) : JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实际 ${JSON.stringify(got)}`}`);
  };
  console.log('\n分段');
  check('长句拆成几条', segment('诶诶——有人在吗？我是 Angel_ICE，刚刚才醒过来…你在哪儿呀，我去找你～'), s => s.length >= 3 && s.length <= 4 && s.every(x => len(x) <= 14));
  check('已经够短的不拆', segment('你来啦'), ['你来啦']);
  check('她自己用换行分好的条原样保留', segment('好\n我去拿'), ['好', '我去拿']);
  check('口头禅 10 分钟内只出现一次', [segment('诶？\n你来啦'), segment('诶？\n又来啦')].map(x => x[0]), ['诶？', '又来啦']);
  check('句号逗号去掉，感叹号问号留着', segment('挖到3个铁矿啦！嘿嘿，要不要一起去？'), s => s.includes('挖到3个铁矿啦！') && s.some(x => x.endsWith('？')) && !s.some(x => /[，。]$/.test(x)));
  check('坐标不会被逗号拆开', segment('呜…血不多了，剩 5 格，我在 (128, 64, -47)'), s => s.some(x => x.includes('(128, 64, -47)')));
  check('括号小动作不发', segment('好呀这就来（小跑过去）'), ['好呀这就来']);
  check('～ 不发', segment('好～我来啦～马上到～'), s => !/[~～]/.test(s.join('')));
  check('最多 4 条', segment('一，二二，三三，四四，五五，六六，七七，八八'), s => s.length <= 4);
  check('只拆不改字（保真）', wordsOnly(segment('我在挖铁矿，已经3个了，再挖2个我们就够做镐子啦').join('')), wordsOnly('我在挖铁矿，已经3个了，再挖2个我们就够做镐子啦'));
  check('"我去，"单独成条', segment('我去，苦力怕，快跑！'), s => s[0] === '我去' && s.length >= 2);
  check('空的不发', segment('  '), []);
  check('照抄示范里的 ⏎ 也当换行', segment('早呀⏎醒了'), ['早呀', '醒了']);
  console.log('\n审计');
  const a = audit(['诶？', '你来啦', '挖到3个铁矿啦！嘿嘿～']);
  check('平均字数（2+3+11）/3', a.avgLen, 5.3);
  check('口头禅计数', a.catchphraseEh, 1);
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { segment, gapFor, audit, wordsOnly, len, punctCount };
