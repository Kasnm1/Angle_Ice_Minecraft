#!/usr/bin/env node
'use strict';

/**
 * test-all.js —— 全套测试聚合器（`npm test` 跑的就是它）。
 *
 * ## 为什么需要它
 *
 * 重构前，全套自测命令**手抄在 AGENTS.md 第四节**里，几十行 `$NODE x.js --selftest`。
 * 后果（REFACTOR-PLAN-20260928 的问题表里写了）：
 *   - 加一个测试文件 → 没人记得往文档里补；删一个 → 文档里那条永远红着；
 *   - "上次到底跑没跑某份"没人答得上来；
 *   - WorkBuddy 两次写出"测的不是跑的那份"的测试，因为没人统一跑过全套。
 *
 * 这个脚本把"全套"变成**代码里的一个列表**，且**自动发现**：
 *   - 根目录每个 `.js`：含 `--selftest` 分支的跑 `--selftest`；
 *     不含的（bridge-server / body / fml-handshake / registry-probe）跑 `--check` 语法检查；
 *   - `scripts/*-test.js`：直接跑；
 *   - `scripts/angelpal-to-palette.js --selftest`；
 *   - `scripts/smoke/*.js`：假 bot 冒烟（第 0 步新入库）。
 *
 * ## 硬规矩（对齐任务书第 1 条）
 *
 *   1. 每个子进程 **120 秒**超时，超时算失败；
 *   2. 汇总一张表：文件 / 通过 / 失败 / 用时；
 *   3. 退出码：有**非已知**失败 → 1；
 *   4. 已知失败写在 `scripts/test-all.config.json`（**不硬编码在逻辑里**），
 *      失败条数**超过**已知数才算新失败；
 *   5. 并行跑（并发 = CPU 数），总时长写进输出；
 *   6. 跑完核对 `registry/` 里被测试碰过的文件：**内容**若被改回滚
 *      （只比内容，不比 mtime —— 见下面 restoreRegistry）。
 *
 * 用法：
 *   node scripts/test-all.js              # 全跑
 *   node scripts/test-all.js --verbose    # 失败时把子进程输出也打出来
 *   node scripts/test-all.js --only instinct,hands   # 只跑名字含这些的
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;                 // 不写死路径：用当前 node 可执行文件
const TIMEOUT_MS = 120_000;
const CONCURRENCY = Math.max(1, os.cpus().length);

const VERBOSE = process.argv.includes('--verbose');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg >= 0 ? (process.argv[onlyArg + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;

// ---- 已知失败白名单（配置化，不硬编码）--------------------------------------
const CONFIG_PATH = path.join(__dirname, 'test-all.config.json');
let knownFailures = {};
try {
  knownFailures = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).knownFailures || {};
} catch (e) {
  console.warn(`[test-all] ⚠️ 读不到 ${path.relative(ROOT, CONFIG_PATH)}（${e.message}）—— 按"没有已知失败"处理`);
}

// ---- 自动发现测试清单 -------------------------------------------------------

const isSmoke = (name) => name.endsWith('.js');

/** 根目录里哪些 .js 带 `--selftest` 分支（含注释里提一句的不算，要真的在代码里）。 */
function rootSelftestFiles () {
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROOT, entry.name), 'utf8');
    // 项目里有三种写法都算"有 selftest 分支"：
    //   process.argv.includes('--selftest')       （多数）
    //   cmd === '--selftest'                       （knowledge.js：取 argv[0] 比）
    //   process.argv.indexOf('--selftest')         （预留）
    // 只认这几种**真判据**，注释里提一句 `--selftest` 不算。
    if (/['"]--selftest['"]/.test(src) &&
        /(includes|indexOf)\(\s*['"]--selftest['"]\s*\)|===\s*['"]--selftest['"]|['"]--selftest['"]\s*===/.test(src)) {
      out.push(entry.name);
    }
  }
  return out;
}

/** 没有 selftest 的根 .js —— 只做 `--check` 语法检查（不能执行，bridge-server 一跑就连服）。 */
function rootCheckFiles () {
  const all = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => e.name);
  const withSelftest = new Set(rootSelftestFiles());
  return all.filter(f => !withSelftest.has(f)).sort();
}

function buildPlan () {
  const plan = [];
  for (const f of rootSelftestFiles()) {
    plan.push({ label: f, args: [path.join(ROOT, f), '--selftest'], cwd: ROOT });
  }
  for (const f of rootCheckFiles()) {
    plan.push({ label: `${f} --check`, args: ['--check', path.join(ROOT, f)], cwd: ROOT });
  }
  const scriptsDir = path.join(ROOT, 'scripts');
  for (const entry of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
    if (entry.isFile() && /-test\.js$/.test(entry.name)) {
      plan.push({ label: `scripts/${entry.name}`, args: [path.join(scriptsDir, entry.name)], cwd: ROOT });
    }
  }
  // angelpal-to-palette 带 --selftest
  const atp = path.join(scriptsDir, 'angelpal-to-palette.js');
  if (fs.existsSync(atp)) plan.push({ label: 'scripts/angelpal-to-palette.js --selftest', args: [atp, '--selftest'], cwd: ROOT });

  // 冒烟
  const smokeDir = path.join(scriptsDir, 'smoke');
  if (fs.existsSync(smokeDir)) {
    for (const entry of fs.readdirSync(smokeDir, { withFileTypes: true })) {
      if (entry.isFile() && isSmoke(entry.name)) {
        plan.push({ label: `scripts/smoke/${entry.name}`, args: [path.join(smokeDir, entry.name)], cwd: ROOT });
      }
    }
  }
  return plan;
}

// ---- 解析子进程输出里的「通过 / 失败」条数 ----------------------------------
//
// 项目里两种格式（第 0 步实测确认）：
//   "54 passed, 0 failed"        （多数模块）
//   "152/152 通过" / "48 通过 / 0 失败"（hands / pathing / angelpal-to-palette）
// 都解析；解析不到就返回 null，靠退出码兜底。
function parseCounts (out) {
  let m = out.match(/(\d+)\s*(?:passed|通过)[^\d]*?(\d+)\s*(?:failed|失败)/);
  if (m) return { pass: +m[1], fail: +m[2] };
  m = out.match(/(\d+)\s*\/\s*(\d+)\s*通过/);
  if (m) return { pass: +m[1], fail: +m[2] - +m[1] };
  m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  if (m) return { pass: +m[1], fail: +m[2] };
  // Node 自带的 assert 直接抛时没有汇总行 —— 至少认得出它失败了 1 条（第一条挂掉就停）。
  if (/AssertionError/.test(out)) return { pass: null, fail: 1 };
  return null;
}

// ---- 跑一个子进程（带 120s 超时）-------------------------------------------
function runOne (job) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(NODE, job.args, { cwd: job.cwd, env: process.env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, TIMEOUT_MS);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ...job, ok: false, code: -1, ms: Date.now() - started, counts: null, out: `spawn 失败：${e.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const counts = parseCounts(out);
      resolve({
        ...job,
        ok: code === 0 && !timedOut,
        code,
        ms: Date.now() - started,
        counts,
        out,
        timedOut,
      });
    });
  });
}

// ---- registry 还原 ----------------------------------------------------------
//
// 任务书第 1 条：跑完把 registry/ 里被测试碰过的文件还原。
// 实测（第 0 步确认）当前没有任何测试写 registry —— 但这是**约定**，
// 以后加了会写的测试，这里就是防线。做法：跑前给整个 registry/ 的 .json
// 存内容哈希，跑后比对；内容变了的**回滚内容**（不比 mtime，避免无谓写盘）。
function snapshotRegistry () {
  const dir = path.join(ROOT, 'registry');
  const snap = new Map();
  if (!fs.existsSync(dir)) return snap;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const p = path.join(dir, entry.name);
    const buf = fs.readFileSync(p);
    snap.set(entry.name, { buf, hash: crypto.createHash('sha1').update(buf).digest('hex') });
  }
  return snap;
}

function restoreRegistry (snap) {
  const dir = path.join(ROOT, 'registry');
  const changed = [];
  for (const [name, before] of snap) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { changed.push(`${name}（被删）`); continue; }
    const now = fs.readFileSync(p);
    const h = crypto.createHash('sha1').update(now).digest('hex');
    if (h !== before.hash) {
      fs.writeFileSync(p, before.buf);            // 回滚内容
      changed.push(name);
    }
  }
  return changed;
}

// ---- 主流程 ----------------------------------------------------------------

async function main () {
  let plan = buildPlan();
  if (ONLY) plan = plan.filter(j => ONLY.some(k => j.label.includes(k)));

  const total = plan.length;
  if (!total) { console.error('[test-all] 没有匹配的测试'); process.exit(2); }

  const regSnap = snapshotRegistry();
  const t0 = Date.now();

  console.log(`[test-all] ${total} 项测试 · 并发 ${CONCURRENCY}（CPU ${os.cpus().length}）· 子进程超时 ${TIMEOUT_MS / 1000}s`);
  console.log('');

  // 并发跑
  const results = new Array(total);
  let next = 0;
  async function worker () {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results[i] = await runOne(plan[i]);
      const r = results[i];
      const tag = r.ok ? 'ok  ' : (r.timedOut ? 'TIME' : 'FAIL');
      process.stdout.write(`  [${tag}] ${r.label}  (${(r.ms / 1000).toFixed(1)}s)\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  const elapsed = (Date.now() - t0) / 1000;

  // ---- 分类：已知失败 / 新失败 -------------------------------------------------
  const rows = results.map(r => {
    const known = knownFailures[r.label];
    let failCount = r.counts ? r.counts.fail : (r.ok ? 0 : 1);
    if (!r.ok && !r.counts) failCount = Math.max(failCount, 1);   // 退出码非 0 但解析不到条数

    let kind;
    if (r.ok) kind = 'pass';
    else if (known && failCount <= known.maxFail) kind = 'known';
    else kind = 'new';
    return { ...r, failCount, kind, known };
  });

  // ---- 汇总表 ---------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const wLabel = Math.min(46, Math.max(...rows.map(r => r.label.length), 12));

  console.log('');
  console.log('  ┌' + '─'.repeat(wLabel + 2) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(9) + '┬' + '─'.repeat(9) + '┐');
  console.log('  │ ' + pad('测试', wLabel) + ' │ ' + pad('通过', 6) + ' │ ' + pad('失败', 6) + ' │ ' + pad('用时', 7) + ' │ ' + pad('结果', 7) + ' │');
  console.log('  ├' + '─'.repeat(wLabel + 2) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(9) + '┼' + '─'.repeat(9) + '┤');
  for (const r of rows) {
    // 解析不到条数时（比如 Node 断言直接抛出）：通过数用 `—`，失败数用兜底值（至少 1）
    const parsed = !!r.counts;
    const p = parsed ? (r.counts.pass == null ? '—' : r.counts.pass) : '—';
    const f = parsed ? r.counts.fail : (r.ok ? 0 : r.failCount);
    const label = r.label.length > wLabel ? r.label.slice(0, wLabel - 1) + '…' : r.label;
    const verdict = r.kind === 'pass' ? '✓ 通过' : r.kind === 'known' ? '⚠ 已知' : r.timedOut ? '✗ 超时' : '✗ 失败';
    console.log('  │ ' + pad(label, wLabel) + ' │ ' + padL(p, 6) + ' │ ' + padL(f, 6) + ' │ ' + padL((r.ms / 1000).toFixed(1) + 's', 7) + ' │ ' + pad(verdict, 7) + ' │');
  }
  console.log('  └' + '─'.repeat(wLabel + 2) + '┴' + '─'.repeat(8) + '┴' + '─'.repeat(8) + '┴' + '─'.repeat(9) + '┴' + '─'.repeat(9) + '┘');

  // ---- 已知失败清单（逐条说明，别让它变成静音）--------------------------------
  const known = rows.filter(r => r.kind === 'known');
  if (known.length) {
    console.log('\n  已知失败（不拉红总判定）：');
    for (const r of known) {
      console.log(`    ⚠ ${r.label}：${r.failCount} 条失败（白名单上限 ${r.known.maxFail}）`);
      if (r.known.reason) console.log(`       理由：${r.known.reason}`);
    }
  }

  // ---- 新失败 ---------------------------------------------------------------
  const newFails = rows.filter(r => r.kind === 'new');
  if (newFails.length) {
    console.log('\n  ✗ 新失败（超出白名单）：');
    for (const r of newFails) {
      console.log(`    ✗ ${r.label}：${r.counts ? `${r.counts.fail} 条失败` : `退出码 ${r.code}`}${r.timedOut ? '（超时）' : ''}`);
    }
    if (VERBOSE) {
      for (const r of newFails) {
        console.log(`\n  ── ${r.label} 输出（末尾 40 行）──`);
        console.log(r.out.split('\n').slice(-40).join('\n'));
      }
    } else {
      console.log('  （加 --verbose 看子进程输出）');
    }
  }

  // ---- registry 还原 --------------------------------------------------------
  const restored = restoreRegistry(regSnap);
  if (restored.length) console.log(`\n  [registry] 测试改动了这些文件，已回滚内容：${restored.join(', ')}`);

  // ---- 总判定 ---------------------------------------------------------------
  const passed = rows.filter(r => r.kind === 'pass').length;
  console.log('');
  console.log(`  合计：${passed} 通过 · ${known.length} 已知失败 · ${newFails.length} 新失败 · 总用时 ${elapsed.toFixed(1)}s`);

  if (newFails.length) {
    console.log('  ✗ 有非已知失败，退出码 1');
    process.exit(1);
  }
  console.log('  ✓ 全绿（已知失败未增加）');
  process.exit(0);
}

main();
