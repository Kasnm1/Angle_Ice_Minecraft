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
 *   - `src/` 下每个 `.js`：含 `--selftest` 分支的跑 `--selftest`；
 *     不含的（`server.js` / `body.js`? / `fml-handshake` / `registry-probe` …）跑 `--check` 语法检查；
 *   - 根目录两个入口 `bridge-server.js` / `mind.js`：**只** `--check`
 *     （`mind.js` 现在一行转发到 `src/mind/mind.js`，它有 selftest，但入口本身不该跑）；
 *   - `scripts/*-test.js`：直接跑；
 *   - `scripts/angelpal-to-palette.js --selftest`；
 *   - `scripts/smoke/*.js`：假 bot 冒烟（第 0 步新入库）。
 *
 * ⚠️ **绝不能**对 `src/bridge/server.js` 跑 `--selftest`：它一 require 就连服务器、抢 3001。
 *    自动发现靠"代码里真有 `--selftest` 分支"来区分，server.js 没有这个分支 → 走 `--check`。
 *    （第 2 步重构前它在根目录，名叫 `bridge-server.js`，同样是 `--check`。）
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
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  knownFailures = CONFIG.knownFailures || {};
} catch (e) {
  console.warn(`[test-all] ⚠️ 读不到 ${path.relative(ROOT, CONFIG_PATH)}（${e.message}）—— 按"没有已知失败"处理`);
}

// ---- 自动发现测试清单 -------------------------------------------------------

const isSmoke = (name) => name.endsWith('.js');

/** 递归收集 `dir` 下所有 `.js`（相对 ROOT 的路径，排序稳定）。 */
function collectJs (dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

/**
 * 哪些 `.js` 带 `--selftest` 分支（含注释里提一句的不算，要真的在代码里）。
 * 项目里有三种写法都算"有 selftest 分支"：
 *   process.argv.includes('--selftest')       （多数）
 *   cmd === '--selftest'                       （knowledge.js：取 argv[0] 比）
 *   process.argv.indexOf('--selftest')         （预留）
 * 只认这几种**真判据**，注释里提一句 `--selftest` 不算。
 *
 * ⚠️ 这是安全关键：`src/bridge/server.js` 没有这个分支 → 不会被 `--selftest`（一跑就连服务器）。
 */
function hasSelftest (file) {
  const src = fs.readFileSync(file, 'utf8');
  return /['"]--selftest['"]/.test(src) &&
    /(includes|indexOf)\(\s*['"]--selftest['"]\s*\)|===\s*['"]--selftest['"]|['"]--selftest['"]\s*===/.test(src);
}

/** 根目录两个入口：永远只 `--check`（它们是转发壳，跑起来会起服务）。 */
const ROOT_ENTRIES = ['bridge-server.js', 'mind.js'];

function buildPlan () {
  const plan = [];

  // src/ 下的所有 .js
  const srcDir = path.join(ROOT, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of collectJs(srcDir)) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (hasSelftest(f)) {
        // 有些模块自己不启动（由根入口调 cli()）—— 直接 node 它什么都不跑、还会被算成"通过"。
        // 配置里写了 selftestVia 的，改从根入口跑（2026-09-28：src/mind/mind.js 的 198 条就这样漏了一轮）
        const via = (CONFIG.selftestVia || {})[rel];
        const runFile = via ? path.join(ROOT, via) : f;
        plan.push({ label: via ? `${rel}（经 ${via}）` : rel, args: [runFile, '--selftest'], cwd: ROOT, expectAsserts: true });
      }
      else plan.push({ label: `${rel} --check`, args: ['--check', f], cwd: ROOT });
    }
  }

  // 根目录入口：只 --check（即使它们转发到的模块有 selftest）
  for (const f of ROOT_ENTRIES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) plan.push({ label: `${f} --check`, args: ['--check', p], cwd: ROOT });
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

// ---- paths.js 数据路径存在性检查 -------------------------------------------
//
// 第 2 步重构把代码挪进 `src/`，"项目根"从 `__dirname` 变成了
// `path.resolve(__dirname, '..')`。要是这个 `..` 数错了，`memory/` `knowledge/`
// 这些路径会**静默指到不存在的地方** —— 读不到 config 只是"用默认值"，
// 读不到 memory 只是"记忆是空的"，**全套自测照样全绿**。
//
// 所以每次跑 test-all 都核对一遍：paths.js 里每个**数据路径**都真实存在。
// 只查目录 / 根文件这类"必须存在"的；不查 memory/ 里的具体文件（可能还没生成）。
function checkPaths () {
  const PROBLEMS = [];
  let paths;
  try {
    paths = require(path.join(ROOT, 'src', 'paths.js'));
  } catch (e) {
    return [`src/paths.js 加载失败：${e.message}`];
  }
  // ROOT 必须真的是仓库根（有 package.json）
  if (!fs.existsSync(path.join(paths.ROOT, 'package.json'))) {
    PROBLEMS.push(`paths.ROOT 不像仓库根（没有 package.json）：${paths.ROOT}`);
  }
  // 数据目录：这几份留着就得在
  for (const key of ['MEMORY', 'KNOWLEDGE', 'REGISTRY']) {
    const p = paths[key];
    if (!p) { PROBLEMS.push(`paths.${key} 没导出`); continue; }
    if (!fs.existsSync(p)) PROBLEMS.push(`paths.${key} 不存在：${p}`);
  }
  // LOGS：允许不存在（跑起来才建），但父目录必须是 ROOT
  if (paths.LOGS && path.dirname(paths.LOGS) !== paths.ROOT) {
    PROBLEMS.push(`paths.LOGS 不在项目根下：${paths.LOGS}`);
  }
  // 根文件：config.json / .env 是"不入库的本机配置"，**允许不存在**，
  // 但路径必须落在 ROOT 下（算错了才是真问题）。
  for (const key of ['CONFIG', 'ENV']) {
    const p = paths[key];
    if (!p) { PROBLEMS.push(`paths.${key} 没导出`); continue; }
    if (path.dirname(p) !== paths.ROOT) PROBLEMS.push(`paths.${key} 不在项目根下：${p}`);
  }
  return PROBLEMS;
}

/**
 * hands.js 对外接口快照（第 3 步拆巨石用的防线）。
 *
 * 为什么要有：hands.js 被拆成 src/body/*.js 之后，它自己变成汇总（一行转发到 index.js，不用
 * 符号链接）。别的模块照旧 `require('../body/hands')` —— 只要有一个导出名丢了/改名了，
 * 那些模块会在**运行到那一条**时才炸（运行时 undefined），全套自测未必覆盖得到。
 * 这里把 `Object.keys(require('.../hands'))` 钉成快照：名字、**顺序**都要一模一样。
 */
function checkHandsExports () {
  const PROBLEMS = [];
  const snapFile = path.join(ROOT, 'references', 'exports-hands.json');
  let want;
  try {
    want = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  } catch (e) {
    return [`references/exports-hands.json 读不到：${e.message}`];
  }
  let hands;
  try {
    hands = require(path.join(ROOT, 'src', 'body', 'hands.js'));
  } catch (e) {
    return [`src/body/hands.js 加载失败：${e.message}`];
  }
  const got = Object.keys(hands);
  if (got.length !== want.length) PROBLEMS.push(`导出个数变了：快照 ${want.length}，现在 ${got.length}`);
  const missing = want.filter(n => !got.includes(n));
  const added = got.filter(n => !want.includes(n));
  if (missing.length) PROBLEMS.push(`快照里有、现在没了：${missing.join(', ')}`);
  if (added.length) PROBLEMS.push(`快照里没有、现在多了：${added.join(', ')}`);
  // 顺序也要一致（原来的 module.exports 是什么顺序，现在还得是什么顺序）
  const sameOrder = want.every((n, i) => got[i] === n);
  if (!missing.length && !added.length && !sameOrder) {
    const at = want.findIndex((n, i) => got[i] !== n);
    PROBLEMS.push(`导出顺序变了（第 ${at + 1} 个：快照 ${want[at]}，现在 ${got[at]}）`);
  }
  return PROBLEMS;
}

/**
 * bridge-server（`src/bridge/server.js`）接口快照（第 3 步拆巨石的防线，照 checkHandsExports）。
 *
 * 为什么要有：`src/bridge/server.js` 被拆成 config/state/util/goto/connect/http +
 * routes/*.js 之后，它自己变成**汇总入口**（require 各子文件、两阶段 bind、
 * 按原顺序把路由拼回一张 handlers）。两个东西一旦漂移，只有实机才炸：
 *
 *   ① **导出名与顺序** —— `bridge-server.js`（根目录那个一行转发器）与若干测试
 *      按名字取用；丢一个就是运行时 undefined。
 *   ② **handlers 的键序** —— `Object.keys(handlers)` 被 `GET /404` 的 `available`
 *      字段和 `routes-test` 的快照依赖。分组重排后若逐组 assign 的顺序不对，
 *      键序会变，但"有多少个路由"不变 —— 只查数量抓不到。
 *
 * 因为 server.js 在 require 时**只有定义、没有副作用**（不起服务器、不连游戏），
 * 所以这里可以直接 require 它。绝不要在这条路径上调 main()/createBot()。
 */
function checkBridgeExports () {
  const PROBLEMS = [];
  const expFile = path.join(ROOT, 'references', 'exports-bridge.json');
  const orderFile = path.join(ROOT, 'references', 'handlers-order-bridge.json');
  let wantExports, wantOrder;
  try {
    wantExports = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  } catch (e) {
    return [`references/exports-bridge.json 读不到：${e.message}`];
  }
  try {
    wantOrder = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  } catch (e) {
    return [`references/handlers-order-bridge.json 读不到：${e.message}`];
  }

  let bridge;
  try {
    bridge = require(path.join(ROOT, 'src', 'bridge', 'server.js'));
  } catch (e) {
    return [`src/bridge/server.js 加载失败：${e.message}`];
  }

  // ---- ① 导出名 + 顺序 ----
  const got = Object.keys(bridge);
  if (got.length !== wantExports.length) {
    PROBLEMS.push(`导出个数变了：快照 ${wantExports.length}，现在 ${got.length}`);
  }
  const missing = wantExports.filter(n => !got.includes(n));
  const added = got.filter(n => !wantExports.includes(n));
  if (missing.length) PROBLEMS.push(`快照里有、现在没了：${missing.join(', ')}`);
  if (added.length) PROBLEMS.push(`快照里没有、现在多了：${added.join(', ')}`);
  const sameOrder = wantExports.every((n, i) => got[i] === n);
  if (!missing.length && !added.length && !sameOrder) {
    const at = wantExports.findIndex((n, i) => got[i] !== n);
    PROBLEMS.push(`导出顺序变了（第 ${at + 1} 个：快照 ${wantExports[at]}，现在 ${got[at]}）`);
  }

  // ---- ② handlers 键序 ----
  // bridge 自己贡献的 58 个键必须**按快照里的相对顺序**出现。
  // 后面还有 hands.js / commonsense.js 挂上来的键，所以只校验这 58 个的相对次序，
  // 且允许别的键插在中间之外（真实情况是它们全排在 bridge 之后）。
  const keys = Object.keys(bridge.handlers || {});
  if (!keys.length) {
    PROBLEMS.push('handlers 是空的（汇总没拼回来？）');
    return PROBLEMS;
  }
  let prev = -1;
  for (const k of wantOrder) {
    const at = keys.indexOf(k);
    if (at < 0) { PROBLEMS.push(`路由键快照里有、现在没了：${k}`); continue; }
    if (at < prev) PROBLEMS.push(`路由键顺序变了：${k}（快照里在 ${wantOrder[keys.indexOf(k)]} 之前，实际排在后面）`);
    prev = at;
  }
  const notFn = keys.filter(k => typeof bridge.handlers[k] !== 'function');
  if (notFn.length) PROBLEMS.push(`这些路由不是函数：${notFn.join(', ')}`);

  return PROBLEMS;
}

/**
 * instinct.js 对外接口快照（第 3 步拆巨石用的防线）。
 *
 * 为什么要有：`src/instinct/instinct.js` 被拆成 `src/instinct/*.js` 之后，它自己变成
 * 汇总（普通文件，不是符号链接）。`src/bridge/server.js`（`require('../instinct/instinct.js')`）
 * 和 bridge-server.js / 各 smoke 脚本照旧从同一个路径取 —— 只要有一个导出名丢了/改名了，
 * 那些模块会在**运行到那一条**时才炸（运行时 undefined），全套自测未必覆盖得到。
 * 这里把 `Object.keys(require('.../instinct'))` 钉成快照：名字、**顺序**都要一模一样。
 *
 * 与 checkHandsExports 同一套判据，只是对象换成本能层。
 */
function checkInstinctExports () {
  const PROBLEMS = [];
  const snapFile = path.join(ROOT, 'references', 'exports-instinct.json');
  let want;
  try {
    want = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  } catch (e) {
    return [`references/exports-instinct.json 读不到：${e.message}`];
  }
  let instinct;
  try {
    instinct = require(path.join(ROOT, 'src', 'instinct', 'instinct.js'));
  } catch (e) {
    return [`src/instinct/instinct.js 加载失败：${e.message}`];
  }
  const got = Object.keys(instinct);
  if (got.length !== want.length) PROBLEMS.push(`导出个数变了：快照 ${want.length}，现在 ${got.length}`);
  const missing = want.filter(n => !got.includes(n));
  const added = got.filter(n => !want.includes(n));
  if (missing.length) PROBLEMS.push(`快照里有、现在没了：${missing.join(', ')}`);
  if (added.length) PROBLEMS.push(`快照里没有、现在多了：${added.join(', ')}`);
  // 顺序也要一致（原来的 module.exports 是什么顺序，现在还得是什么顺序）
  const sameOrder = want.every((n, i) => got[i] === n);
  if (!missing.length && !added.length && !sameOrder) {
    const at = want.findIndex((n, i) => got[i] !== n);
    PROBLEMS.push(`导出顺序变了（第 ${at + 1} 个：快照 ${want[at]}，现在 ${got[at]}）`);
  }
  return PROBLEMS;
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
    // 跑的是 --selftest 却一条断言都没数到：什么都没测，不能算通过
    const zero = r.ok && r.expectAsserts && (!r.counts || !r.counts.pass);
    if (zero) { r.ok = false; r.zeroAsserts = true; failCount = Math.max(failCount, 1); }
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

  // ---- paths.js 数据路径存在性 -----------------------------------------------
  // 第 2 步的防线：路径算错了会让所有"读不到"变成静默的默认值，全套自测照样绿。
  const pathProblems = checkPaths();
  if (pathProblems.length) {
    console.log('\n  ✗ paths.js 数据路径检查失败（路径算错了？）：');
    for (const p of pathProblems) console.log(`      ${p}`);
  } else {
    console.log('\n  [paths] src/paths.js 的数据路径都在（memory / knowledge / registry）');
  }

  // ---- hands.js 导出快照 -----------------------------------------------------
  // 第 3 步拆巨石的防线：接口名/顺序必须和拆之前一模一样（见 references/exports-hands.json）。
  const exportProblems = checkHandsExports();
  if (exportProblems.length) {
    console.log('\n  ✗ hands.js 导出快照对不上（外部模块的 require 会拿到 undefined）：');
    for (const p of exportProblems) console.log(`      ${p}`);
  } else {
    console.log('\n  [exports] hands.js 的 47 个导出名与顺序和快照一致');
  }

  // ---- instinct.js 导出快照 --------------------------------------------------
  // 同一条防线，对象是本能层（见 references/exports-instinct.json）。
  const instinctProblems = checkInstinctExports();
  if (instinctProblems.length) {
    console.log('\n  ✗ instinct.js 导出快照对不上（bridge/smoke 的 require 会拿到 undefined）：');
    for (const p of instinctProblems) console.log(`      ${p}`);
  } else {
    console.log('\n  [exports] instinct.js 的 56 个导出名与顺序和快照一致');
  }

  // ---- bridge-server 导出与路由键序快照 ---------------------------------------
  // 第 3 步拆巨石的防线（见 references/exports-bridge.json 与 handlers-order-bridge.json）。
  const bridgeProblems = checkBridgeExports();
  if (bridgeProblems.length) {
    console.log('\n  ✗ bridge-server 接口快照对不上（导出名/顺序 或 路由键序）：');
    for (const p of bridgeProblems) console.log(`      ${p}`);
  } else {
    console.log('\n  [exports] bridge-server 的 13 个导出名与顺序、58 个路由键的次序都和快照一致');
  }

  // ---- 总判定 ---------------------------------------------------------------
  const passed = rows.filter(r => r.kind === 'pass').length;
  console.log('');
  console.log(`  合计：${passed} 通过 · ${known.length} 已知失败 · ${newFails.length} 新失败 · 总用时 ${elapsed.toFixed(1)}s`);

  if (pathProblems.length || exportProblems.length || instinctProblems.length || bridgeProblems.length || newFails.length) {
    if (newFails.length) console.log('  ✗ 有非已知失败，退出码 1');
    else if (pathProblems.length) console.log('  ✗ paths.js 数据路径检查失败，退出码 1');
    else if (exportProblems.length) console.log('  ✗ hands.js 导出快照对不上，退出码 1');
    else if (instinctProblems.length) console.log('  ✗ instinct.js 导出快照对不上，退出码 1');
    else console.log('  ✗ bridge-server 接口快照对不上，退出码 1');
    process.exit(1);
  }
  console.log('  ✓ 全绿（已知失败未增加）');
  process.exit(0);
}

main();
