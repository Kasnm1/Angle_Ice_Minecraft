#!/usr/bin/env node
/**
 * events-reader.js —— 只读的 `memory/events.jsonl` 阅读器。
 *
 * ## 这个文件从哪来（2026-09-28 重构第 1 步）
 *
 * 原来这是 `events.js`：一个**可读可写**的模块，给旧脑干 `autopilot.js` 用 ——
 * 脑干每个 tick 把决策身份（状态快照 + 候选菜单 + 选中项 + 置信度 + 后端）
 * 和结果写进 `memory/events.jsonl`，再通过 `GET /autopilot/events` 读回来复盘。
 *
 * 重构第 1 步删掉了旧脑干，于是**写入侧没有任何调用方了**：全仓唯一还在读这个
 * 文件的，是脑干自己的 `/autopilot/events` 路由（`autopilot.js:3680`）——
 * 它随脑干一起删。
 *
 * 但 `memory/events.jsonl` 本身是**历史证据**（截至 2026-09-25 已积累约 900KB
 * 的决策留痕）。主人 2026-09-28 的决定是删掉旧脑干，**不是**删掉这份证据。
 * 所以这里留下最小的**读取**能力，让以后要复盘历史时还能读：
 *
 *     node events-reader.js --tail 30          # 最近 30 条，人可读
 *     node events-reader.js --path             # 打印实际读取路径
 *     node events-reader.js --selftest         # 离线自测（写到临时文件）
 *
 * `--stats`（聚合统计）故意**没有**搬过来：那是决策质量的度量，而决策的产生方
 * （旧脑干）已经不在了 —— 留着它只会让人以为当前跑的东西还在写这些记录。
 *
 * ## 与 journal.md 的分工（历史，保留供理解文件格式）
 *
 *   journal.md   → 给人和她看的叙事（散文）。写入方是 bridge-server.js 的 `journal()`。
 *   events.jsonl → 给机器和 agent 看的证据（一行一 JSON）。**写入方已随旧脑干删除。**
 *
 * 环境变量 `MC_EVENTS_PATH` 可覆盖路径（自测与测试用）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const DIR = paths.MEMORY;

const EVENTS_PATH = process.env.MC_EVENTS_PATH || path.join(DIR, 'events.jsonl');

/** 读最后 n 条（按写入顺序）。文件不存在返回 []。 */
function read (n = 50) {
  try {
    const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { parseError: l }; } });
  } catch (_) {
    return [];
  }
}

// ------------------------------------------------------------------ CLI

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes('--path')) {
    console.log(EVENTS_PATH);
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
    const { execFileSync } = require('child_process');
    const os = require('os');
    let pass = 0; let total = 0;
    const check = (label, got, expect) => {
      total++;
      const ok = JSON.stringify(got) === JSON.stringify(expect);
      if (ok) pass++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
    };

    // ⚠️ 这里**不**改 EVENTS_PATH 常量 —— 读取路径在加载时求值。
    //    自测改成"用 MC_EVENTS_PATH 指向临时文件后再 require 本模块的子进程"验证：
    const tmp = path.join(os.tmpdir(), `angel-events-reader-selftest-${process.pid}.jsonl`);
    try { fs.unlinkSync(tmp); } catch (_) {}

    // ⚠️ 读取路径在**加载时**求值，所以每一条都要在**独立的子进程**里跑
    //    （父进程的 EVENTS_PATH 已经指向真实的 memory/events.jsonl 了）。
    const probe = (body, envPath = tmp) => execFileSync(process.execPath, ['-e', body], {
      env: { ...process.env, MC_EVENTS_PATH: envPath }, encoding: 'utf8',
    }).trim();
    const readCountExpr = (n) =>
      `process.stdout.write(String(require(${JSON.stringify(__filename)}).read(${n}).length))`;

    console.log('\n读取 —— 坏文件不能拖垮调用方');
    check('文件不存在 → 返回空数组而不是抛', probe(readCountExpr(10)), '0');

    // 写 3 条进去，再在子进程里读回来
    const lines = [
      { t: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'decision', action: 'idle', backend: 'local', confidence: 0.9, menu: ['idle'] },
      { t: 2, ts: '2026-01-01T00:00:01.000Z', kind: 'outcome', action: 'follow', ok: true, ms: 120 },
      { t: 3, ts: '2026-01-01T00:00:02.000Z', kind: 'task', phase: 'done', type: 'mine' },
    ];
    fs.writeFileSync(tmp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    check('写了 3 条就能读回 3 条', probe(readCountExpr(50)), '3');
    check('只取最后 2 条', probe(readCountExpr(2)), '2');
    check('读回的字段就是写进去的（不是占位对象）',
      probe(`const r=require(${JSON.stringify(__filename)}).read(50);
             process.stdout.write(r[0].action+'/'+r[1].kind+'/'+r[2].phase)`), 'idle/outcome/done');

    console.log('\n健壮性 —— 坏行被跳过而不是整体崩掉');
    fs.appendFileSync(tmp, '{不是合法 json}\n');
    check('坏行变成 {parseError} 而不是抛异常',
      probe(`const r=require(${JSON.stringify(__filename)}).read(10);`
        + `process.stdout.write(typeof r[r.length-1].parseError === 'string' ? 'ok' : 'no')`), 'ok');
    check('空文件 → 0 条',
      (() => { try { fs.writeFileSync(tmp, ''); } catch (_) {} return probe(readCountExpr(10)); })(), '0');

    try { fs.unlinkSync(tmp); } catch (_) {}
    console.log(`\n  ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } else {
    console.log('用法：node events-reader.js [--tail N|--path|--selftest]');
  }
}

module.exports = { read, EVENTS_PATH };
