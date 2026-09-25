#!/usr/bin/env node
/**
 * `memory/journal.md` 的**写入格式层** —— 连续重复条目的折叠。
 *
 * ## 为什么需要
 *
 * journal.md 是她的记忆（见 `PERSONA.md` / `SKILL.md`），读它的是下一个 agent。
 * 但它的写入路径原来是"一行一个 append"，于是**任何重复发生的事件都会按次数灌进去**。
 * 2026-09-23 实测：322 行里 **217 行**是同一条 `(disconnect) 我掉线了（socketClosed）`，
 * 最长连续重复 **104 次**，真实聊天只有 21 行 —— 三分之二的记忆是噪声，
 * 而读记忆的人还得先把它刨掉才能看到内容。
 *
 * 噪声的成因不在这一层（是重连回路，见 `reconnect.js`），但**这一层必须能兜住**：
 * 记忆文件是被反复重写、反复追加的，任何上游回路的抖动最终都会落到这里。
 *
 * ## 折叠规则
 *
 * 连续两条 `type` + `text` 完全相同 → 不新起一行，而是把**上一行**改成
 * `- [首次时间戳] (type) 文本 ×N`。
 *
 * - 保留**首次**时间戳（"什么时候开始掉的"比"最后一次"有用）
 * - `×N` 保留次数（次数本身是诊断信息，不能丢）
 * - 不连续就不折叠 —— 中间插了别的事，说明它们是两次独立事件
 *
 * ## 为什么不是"整文件去重"
 *
 * 因为她可能**真的**在同一个地方掉线两次（中间聊了天、挖了矿）。整文件去重会把
 * 两次独立事件并成一次，那是篡改记忆。只有**连续**才折叠，这样语义无损。
 *
 * ## 重启后要接着折
 *
 * 网桥重启后内存里的"上一行"就没了。如果只是简单地重新开始计数，同一次抖动会被
 * 切成好几段（104 次那个就是这么来的：中间重启过）。所以这里提供
 * `seedFromLines()`，从磁盘尾部把上一行读回来接着折。
 *
 * ## 用法
 *
 *     node journal.js --selftest
 *     node scripts/journal-compact.js        # 一次性修复既有文件
 */

/** 计数后缀。故意用全角 ×，避免和正文里的 x 混淆。 */
const COUNT_RE = /\s×(\d+)$/;

/** 一行记忆的形态：`- [2026-09-23 17:55:01] (disconnect) 我掉线了（socketClosed） ×104` */
const LINE_RE = /^- \[([^\]]+)\] \(([^)]+)\) ([\s\S]*)$/;

/** 正文规整：换行压成空格、去掉首尾空白 —— 和原来 bridge-server 里的处理一致。 */
function normalizeText (text) {
  return String(text).replace(/\r?\n/g, ' ').trim();
}

/**
 * 解析一行。解析不出来返回 null（**不要抛** —— 记忆文件可能被人手改过，
 * 一行看不懂不该让整个网桥起不来）。
 */
function parseEntry (line) {
  if (typeof line !== 'string') return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  let text = m[3];
  let count = 1;
  const c = COUNT_RE.exec(text);
  if (c) {
    count = Number(c[1]);
    text = text.slice(0, c.index);
  }
  return { stamp: m[1], type: m[2], text, count };
}

/** 序列化一行。count <= 1 时不写后缀（保持原来的样子，别给老文件凭空加 ×1）。 */
function formatEntry (entry) {
  const { stamp, type, text, count } = entry;
  const n = Number(count) || 1;
  return `- [${stamp}] (${type}) ${text}${n > 1 ? ` ×${n}` : ''}`;
}

/** 折叠状态：只有"上一行"这一项。 */
function createState () {
  return { prev: null };
}

/**
 * 决定这次写入该怎么落地。**纯函数**：不改文件，只改传入的 state。
 *
 * @param {{prev:object|null}} state
 * @param {{type:string, text:string, stamp:string, fileSize:number}} input
 *        fileSize = 当前文件的字节数（append 时新行的起始偏移）
 * @returns {{kind:'append'|'rewrite', entry:object, line:string, truncateTo?:number}}
 *          rewrite 时 `truncateTo` = 上一行的起始字节偏移（把上一行截掉再写新的）
 */
function planWrite (state, { type, text, stamp, fileSize }) {
  const t = normalizeText(text);
  const prev = state.prev;

  if (prev && prev.type === type && prev.text === t) {
    const entry = {
      stamp: prev.stamp,           // ← 首次时间戳，不是这次的
      type,
      text: t,
      count: (Number(prev.count) || 1) + 1,
      lineStart: prev.lineStart,
    };
    state.prev = entry;
    return { kind: 'rewrite', entry, line: formatEntry(entry), truncateTo: prev.lineStart };
  }

  const entry = { stamp, type, text: t, count: 1, lineStart: fileSize };
  state.prev = entry;
  return { kind: 'append', entry, line: formatEntry(entry) };
}

/**
 * 从磁盘尾部恢复折叠状态，让重启后能接着折。
 *
 * @param {object} state
 * @param {string[]} lines  文件最后若干行（原始行，不含换行符）
 * @param {number} fileSize 文件总字节数
 */
function seedFromLines (state, lines, fileSize) {
  if (!Array.isArray(lines) || lines.length === 0) {
    state.prev = null;
    return null;
  }
  // 从后往前找第一行能解析的 —— 文件末尾可能有空行
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const parsed = parseEntry(raw);
    if (!parsed) break;
    // 该行在文件里的起始字节偏移 = 总字节数 - 本行字节数 - 一个换行
    parsed.lineStart = fileSize - Buffer.byteLength(raw, 'utf8') - 1;
    state.prev = parsed;
    return parsed;
  }
  state.prev = null;
  return null;
}

/**
 * 把整份记忆折叠一遍 —— 给 `scripts/journal-compact.js` 用（一次性修复既有文件）。
 *
 * ⚠️ 与 `planWrite` 的差别：这里处理的是**已经写进文件**的内容，
 * 所以"连续"的判据就是相邻两行。同一套规则，只是批量跑一遍。
 */
function compactLines (lines) {
  const out = [];
  let folded = 0;
  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    const parsed = parseEntry(raw);
    if (!parsed) { out.push(raw); continue; }
    const prev = out.length ? parseEntry(out[out.length - 1]) : null;
    if (prev && prev.type === parsed.type && prev.text === parsed.text) {
      const merged = { ...prev, count: (Number(prev.count) || 1) + (Number(parsed.count) || 1) };
      out[out.length - 1] = formatEntry(merged);
      folded++;
      continue;
    }
    out.push(formatEntry(parsed));
  }
  return { lines: out, folded, before: lines.filter(l => l && l.trim()).length, after: out.length };
}

module.exports = {
  COUNT_RE,
  LINE_RE,
  normalizeText,
  parseEntry,
  formatEntry,
  createState,
  planWrite,
  seedFromLines,
  compactLines,
};

// ------------------------------------------------------------------ 自测

if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };

  console.log('\nparseEntry / formatEntry 往返');
  {
    const e = { stamp: '2026-09-23 17:55:01', type: 'disconnect', text: '我掉线了（socketClosed）', count: 1 };
    check('无计数后缀时往返一致', parseEntry(formatEntry(e)), e);
    const e2 = { ...e, count: 104 };
    check('带 ×104 时往返一致', parseEntry(formatEntry(e2)), e2);
    check('count=1 不写后缀', formatEntry(e), '- [2026-09-23 17:55:01] (disconnect) 我掉线了（socketClosed）');
    check('count=104 写后缀', formatEntry(e2), '- [2026-09-23 17:55:01] (disconnect) 我掉线了（socketClosed） ×104');
  }

  console.log('\nparseEntry 要能扛住脏数据（记忆文件可能被手改）');
  check('空行 → null', parseEntry(''), null);
  check('普通文本 → null', parseEntry('随便写的一行'), null);
  check('非字符串 → null', parseEntry(null), null);
  check('正文里带括号也不影响', parseEntry('- [t] (chat) 他说（真的）'), { stamp: 't', type: 'chat', text: '他说（真的）', count: 1 });
  check('正文里带 × 但后面不是数字 → 不当计数', parseEntry('- [t] (chat) 3 × 4 = 12').count, 1);

  console.log('\n折叠：连续相同才折');
  {
    const st = createState();
    const w = (type, text, stamp, size) => planWrite(st, { type, text, stamp, fileSize: size });
    const a = w('disconnect', '我掉线了（socketClosed）', '17:55:01', 0);
    check('第一条 → append', a.kind, 'append');
    check('append 的内容', a.line, '- [17:55:01] (disconnect) 我掉线了（socketClosed）');
    const b = w('disconnect', '我掉线了（socketClosed）', '17:55:06', 60);
    check('第二条相同 → rewrite', b.kind, 'rewrite');
    check('保留首次时间戳，计数 ×2', b.line, '- [17:55:01] (disconnect) 我掉线了（socketClosed） ×2');
    check('rewrite 告诉调用方截到哪', b.truncateTo, 0);
    const c = w('disconnect', '我掉线了（socketClosed）', '17:55:12', 60);
    check('第三条 → ×3', c.line, '- [17:55:01] (disconnect) 我掉线了（socketClosed） ×3');
  }

  console.log('\n折叠：中间插了别的事就不折（语义无损，不篡改记忆）');
  {
    const st = createState();
    const w = (type, text, stamp) => planWrite(st, { type, text, stamp, fileSize: 0 });
    w('disconnect', '我掉线了', '01');
    const mid = w('chat', 'Ka_sum1: 你在吗', '02');
    check('不同 type → append', mid.kind, 'append');
    const back = w('disconnect', '我掉线了', '03');
    check('中间隔了别的 → 重新起一行', back.kind, 'append');
    check('新行计数从 1 开始', back.line, '- [03] (disconnect) 我掉线了');
  }

  console.log('\n折叠：type 相同但正文不同 → 不折');
  {
    const st = createState();
    const w = (type, text, stamp) => planWrite(st, { type, text, stamp, fileSize: 0 });
    w('disconnect', '我掉线了（socketClosed）', '01');
    const d = w('disconnect', '我掉线了（被服务端断开：同名登录）', '02');
    check('正文不同 → append', d.kind, 'append');
  }

  console.log('\n正文规整：换行不能破坏"一行一条"的格式');
  {
    const st = createState();
    const a = planWrite(st, { type: 'chat', text: '第一行\n第二行', stamp: '01', fileSize: 0 });
    check('换行被压成空格', a.entry.text, '第一行 第二行');
    check('折出来的行不含换行', /\n/.test(a.line), false);
    const b = planWrite(st, { type: 'chat', text: '第一行\r\n第二行', stamp: '02', fileSize: 0 });
    check('规整之后能正确判定为重复', b.kind, 'rewrite');
  }

  console.log('\n重启后接着折（104 次那个就是这么被切成几段的）');
  {
    const st = createState();
    const raw = '- [2026-09-23 17:55:01] (disconnect) 我掉线了（socketClosed） ×103';
    const size = Buffer.byteLength(raw, 'utf8') + 1;
    const seeded = seedFromLines(st, [raw], size);
    check('从尾部恢复了上一行', seeded.count, 103);
    check('并算出了它的起始偏移', seeded.lineStart, 0);
    const next = planWrite(st, { type: 'disconnect', text: '我掉线了（socketClosed）', stamp: '18:25:30', fileSize: size });
    check('重启后继续累加 → ×104', next.line, '- [2026-09-23 17:55:01] (disconnect) 我掉线了（socketClosed） ×104');
    check('时间戳仍是首次那个', next.entry.stamp, '2026-09-23 17:55:01');
  }

  console.log('\nseedFromLines 的边界');
  {
    const st = createState();
    check('空数组 → null', seedFromLines(st, [], 0), null);
    check('空数组后 state 被清干净', st.prev, null);
    const st2 = createState();
    const raw = '- [t] (chat) 你好';
    const size = Buffer.byteLength(raw, 'utf8') + 1;
    check('跳过末尾空行', seedFromLines(st2, [raw, '', ''], size + 2).text, '你好');
    const st3 = createState();
    check('末行解析不了 → null', seedFromLines(st3, ['看不懂的一行'], 30), null);
  }

  console.log('\ncompactLines：批量折叠（既有文件的一次性修复）');
  {
    const input = [
      '- [17:55:01] (disconnect) 我掉线了（socketClosed）',
      '- [17:55:02] (disconnect) 我掉线了（socketClosed）',
      '- [17:55:06] (disconnect) 我掉线了（socketClosed）',
      '- [17:56:00] (chat) Ka_sum1: 你在吗',
      '- [17:57:00] (disconnect) 我掉线了（socketClosed）',
      '',
    ];
    const r = compactLines(input);
    check('3 行折成 1 行 + 1 行聊天 + 1 行新断开', r.after, 3);
    check('折了 2 次', r.folded, 2);
    check('折叠结果带 ×3', r.lines[0], '- [17:55:01] (disconnect) 我掉线了（socketClosed） ×3');
    check('聊天行原样保留', r.lines[1], '- [17:56:00] (chat) Ka_sum1: 你在吗');
    check('断开后那行没被并进去（不连续）', r.lines[2], '- [17:57:00] (disconnect) 我掉线了（socketClosed）');
    check('统计了折叠前行数', r.before, 5);
  }

  console.log('\ncompactLines：已经是 ×N 的行再折一次不会重复计数');
  {
    const r = compactLines([
      '- [t] (disconnect) 掉了 ×3',
      '- [t2] (disconnect) 掉了 ×2',
    ]);
    check('合并为 ×5（幂等：再跑一次不会变成 ×25）', r.lines[0], '- [t] (disconnect) 掉了 ×5');
    const again = compactLines(r.lines);
    check('再跑一次结果不变', again.lines, r.lines);
    check('第二次没有可折的了', again.folded, 0);
  }

  console.log('\ncompactLines：扛脏数据');
  {
    const r = compactLines(['# 她的记忆', '', '- [t] (chat) 你好', '随便一行']);
    check('看不懂的行原样留着', r.lines.includes('随便一行'), true);
    check('标题行也留着', r.lines.includes('# 她的记忆'), true);
  }

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}
