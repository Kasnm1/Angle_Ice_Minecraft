#!/usr/bin/env node
/**
 * Angel_ICE 的结构化决策留痕 —— `memory/events.jsonl`。
 *
 * ## 为什么要有这个文件（而不是继续写 journal.md）
 *
 * `memory/journal.md` 是**给她自己和玩家看的散文日记**：
 *
 *     - [02:36:24] (chat) <Angel_ICE> 唔…我记不清具体是哪几块了啦（心虚低头）
 *
 * 它写的是"发生了什么"，读起来有温度，但**机器读不了**。于是出现了一个
 * 尴尬的局面：我们讨论出了 12 条改进方向（见调研笔记），却**一条都无法验证** ——
 * 因为没有任何结构化记录能回答"她做了什么决定、依据是什么、结果如何"。
 *
 * 这个文件补上那一半：每个 tick 的**决策身份**（状态快照 + 候选菜单 + 选中项 +
 * 置信度 + 用的哪个后端）和**结果**（成功/失败/被打断/卡死/耗时）各写一行 JSON。
 *
 * 两者分工：
 *   journal.md   → 给人和她看的叙事（散文，保留）
 *   events.jsonl → 给机器和 agent 看的证据（一行一 JSON，可聚合、可回归）
 *
 * ## 为什么记"菜单"而不只记"选了什么"
 *
 * 只记结果的话，"她选了 idle" 是无从判断对错的 —— 也许当时根本没有别的选项。
 * 记下菜单，才能回答"当时有哪些路可以走，她为什么走了这条"。这正是 WISE 那篇
 * 论文强调的：记忆要存 **why**（因果），不只是 what / where / when。
 *
 * ## 用法
 *
 *     node events.js --tail 30       # 最近 30 条，人可读
 *     node events.js --stats         # 聚合：各动作次数、失败率、卡死次数…
 *     node events.js --selftest      # 离线自测（写到临时文件，不污染真实留痕）
 *     node events.js --path          # 打印实际写入路径
 *
 * 环境变量 `MC_EVENTS_PATH` 可覆盖路径（自测与测试用）。
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'memory');

// ⚠️ 用 let 而不是 const：这个模块在加载时就把路径定下来了，而自测是
// **加载之后**才设 MC_EVENTS_PATH 的 —— 写成 const 的话自测会写进真实留痕文件。
// （decision.js 那边的 JEV_URL 也有同样的"加载时求值"特性，契约测试里是
//   靠"先设环境变量再 require"绕开的，这里选更直白的写法。）
let EVENTS_PATH = process.env.MC_EVENTS_PATH || path.join(DIR, 'events.jsonl');

// 留痕是追加写的，跑久了会长大。超过阈值就只保留尾部若干行 ——
// 这是"证据"，不是"账本"，不需要无限期全量保留。
const MAX_BYTES = parseInt(process.env.MC_EVENTS_MAX_BYTES || String(2 * 1024 * 1024));
const KEEP_LINES = parseInt(process.env.MC_EVENTS_KEEP_LINES || '2000');

function ensureDir () {
  try { fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true }); } catch (_) {}
}

function rotateIfNeeded () {
  try {
    const st = fs.statSync(EVENTS_PATH);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-KEEP_LINES);
    fs.writeFileSync(EVENTS_PATH, kept.join('\n') + '\n');
  } catch (_) {
    // 文件不存在 / 权限问题都不该影响主流程
  }
}

/**
 * 追加一条事件。**永不抛异常** —— 留痕是旁路，不能因为它挂了就让她停摆。
 * @param {object} ev  至少含 kind；t/ts 自动补
 */
function append (ev) {
  try {
    ensureDir();
    rotateIfNeeded();
    const rec = { t: Date.now(), ts: new Date().toISOString(), ...ev };
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(rec) + '\n');
    return rec;
  } catch (_) {
    return null;
  }
}

/** 读最后 n 条（按写入顺序）。文件不存在返回 []。 */
function read (n = 50) {
  try {
    const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { parseError: l }; } });
  } catch (_) {
    return [];
  }
}

/** 全部事件（用于聚合）。大文件时会有点慢，但这是离线分析，可以接受。 */
function readAll () {
  try {
    return fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * 聚合统计。这是"先能测量"的具体兑现 —— 它直接回答：
 *   她最爱干什么？失败率多少？有没有反复卡死？决策缓存命中了没有？
 */
function stats () {
  const all = readAll();
  const dec = all.filter(e => e.kind === 'decision');
  const out = all.filter(e => e.kind === 'outcome');
  const tasks = all.filter(e => e.kind === 'task');

  const tally = (arr, keyFn) => {
    const m = {};
    for (const e of arr) {
      const k = keyFn(e);
      if (k == null) continue;
      m[k] = (m[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };

  const okOut = out.filter(e => e.ok === true).length;
  const conf = dec.map(e => e.confidence).filter(v => typeof v === 'number' && v > 0);
  const durations = out.map(e => e.ms).filter(v => typeof v === 'number');

  return {
    path: EVENTS_PATH,
    total: all.length,
    firstTs: all[0]?.ts || null,
    lastTs: all[all.length - 1]?.ts || null,
    decisions: dec.length,
    byAction: tally(dec, e => e.action),
    byBackend: tally(dec, e => e.backend),
    // 决策质量信号
    cached: dec.filter(e => e.cached).length,
    degraded: dec.filter(e => e.degraded).length,
    lowConfidence: dec.filter(e => e.lowConfidence).length,
    avgConfidence: conf.length ? +(conf.reduce((a, b) => a + b, 0) / conf.length).toFixed(3) : null,
    // 结果信号
    outcomes: out.length,
    ok: okOut,
    failed: out.filter(e => e.ok === false).length,
    interrupted: out.filter(e => e.interrupted).length,
    stuck: out.filter(e => e.stuck).length,
    failureRate: out.length ? +((out.length - okOut) / out.length).toFixed(3) : null,
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    // 任务信号
    tasksDone: tasks.filter(e => e.phase === 'done').length,
    tasksFailed: tasks.filter(e => e.phase === 'failed').length,
    tasksGaveUp: tasks.filter(e => e.phase === 'gave_up').length,
    tasksInterrupted: tasks.filter(e => e.phase === 'interrupted').length,
  };
}

// ------------------------------------------------------------------ CLI

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes('--path')) {
    console.log(EVENTS_PATH);
  } else if (argv.includes('--stats')) {
    console.log(JSON.stringify(stats(), null, 2));
  } else if (argv.includes('--tail')) {
    const n = parseInt(argv[argv.indexOf('--tail') + 1] || '30');
    for (const e of read(n)) {
      const time = (e.ts || '').slice(11, 19);
      if (e.kind === 'decision') {
        console.log(`${time}  DECIDE  ${e.action}  (${e.backend}${e.cached ? ',cached' : ''}${e.degraded ? ',degraded' : ''})  conf=${e.confidence}  menu=[${(e.menu || []).join(',')}]`);
      } else if (e.kind === 'outcome') {
        console.log(`${time}  OUTCOME ${e.action}  ${e.ok ? 'ok' : 'FAIL'}${e.interrupted ? ' (被打断)' : ''}${e.stuck ? ' (卡死)' : ''}  ${e.ms}ms  ${e.error || ''}`);
      } else if (e.kind === 'task') {
        console.log(`${time}  TASK    ${e.phase}  ${e.type}  ${e.detail || ''}`);
      } else {
        console.log(`${time}  ${e.kind}  ${JSON.stringify(e).slice(0, 140)}`);
      }
    }
  } else if (argv.includes('--selftest')) {
    // 写到临时文件，别污染真实留痕
    const tmp = path.join(require('os').tmpdir(), `angel-events-selftest-${process.pid}.jsonl`);
    process.env.MC_EVENTS_PATH = tmp;
    EVENTS_PATH = tmp;   // 必须同时改这个 —— 见文件顶部关于"加载时求值"的说明
    try { fs.unlinkSync(tmp); } catch (_) {}

    let pass = 0; let total = 0;
    const check = (label, got, expect) => {
      total++;
      const ok = JSON.stringify(got) === JSON.stringify(expect);
      if (ok) pass++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
    };

    console.log('\n写入与读取');
    append({ kind: 'decision', action: 'idle', backend: 'local', confidence: 0.9, menu: ['idle'] });
    append({ kind: 'decision', action: 'follow', backend: 'jev', confidence: 0.8, cached: true, menu: ['follow', 'idle'] });
    append({ kind: 'outcome', action: 'follow', ok: true, ms: 120 });
    append({ kind: 'outcome', action: 'work', ok: false, error: 'No path', ms: 45000, stuck: true });
    append({ kind: 'task', phase: 'gave_up', type: 'mine', detail: '连续失败 3 次' });
    check('写了 5 条就能读回 5 条', read(50).length, 5);
    check('t / ts 自动补上', typeof read(1)[0].t === 'number' && typeof read(1)[0].ts === 'string', true);

    console.log('\n聚合统计');
    const s = stats();
    check('决策数 = 2', s.decisions, 2);
    check('结果数 = 2', s.outcomes, 2);
    check('按动作聚合', s.byAction, { idle: 1, follow: 1 });
    check('按后端聚合', s.byBackend, { local: 1, jev: 1 });
    check('缓存命中 = 1', s.cached, 1);
    check('平均置信度 = 0.85', s.avgConfidence, 0.85);
    check('成功 = 1', s.ok, 1);
    check('失败 = 1', s.failed, 1);
    check('卡死 = 1', s.stuck, 1);
    check('失败率 = 0.5', s.failureRate, 0.5);
    check('放弃的任务 = 1', s.tasksGaveUp, 1);
    check('总条数 = 5', s.total, 5);

    console.log('\n健壮性 —— 留痕坏了不能拖垮主流程');
    check('空文件不炸', (() => { const p = EVENTS_PATH; try { fs.writeFileSync(p, ''); return read(10).length; } catch { return -1; } })(), 0);
    check('坏行被跳过而不是整体崩掉', (() => {
      fs.appendFileSync(EVENTS_PATH, '{不是合法 json}\n');
      fs.appendFileSync(EVENTS_PATH, JSON.stringify({ kind: 'outcome', ok: true, t: 1, ts: 'x' }) + '\n');
      return readAll().length;
    })(), 1);
    check('append 永不抛异常', (() => { try { return typeof append({ kind: 'x' })?.t; } catch { return 'threw'; } })(), 'number');

    try { fs.unlinkSync(tmp); } catch (_) {}
    console.log(`\n  ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } else {
    console.log('用法：node events.js [--tail N|--stats|--selftest|--path]');
  }
}

module.exports = { append, read, readAll, stats, EVENTS_PATH };
