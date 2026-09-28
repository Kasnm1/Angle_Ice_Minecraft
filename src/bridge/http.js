/**
 * http.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const bodyCommandLock = require('./body-command-lock.js');
const entityRegistry = require('../world/entity-registry.js');
const fs = require('fs');
const hands = require('../body/hands.js');
const http = require('http');
const instinct = require('../instinct/instinct.js');
const paths = require('../paths');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let CFG;
let MAX_BODY_BYTES;
let BRIDGE_VERSION, BOT_IDENTITY, MEM_DIR, KB_DIR;   // main() 启动日志用；拆分时漏绑，2026-09-29 上线崩溃后补
let handlers;
let state;

function autoImportPalette (...a) { return __ns.autoImportPalette.apply(null, a); }
function cfg (...a) { return __ns.cfg.apply(null, a); }
function createBot (...a) { return __ns.createBot.apply(null, a); }
function installForgeHandshake (...a) { return __ns.installForgeHandshake.apply(null, a); }
function installReplaceable (...a) { return __ns.installReplaceable.apply(null, a); }
function json (...a) { return __ns.json.apply(null, a); }
function loadDependencies (...a) { return __ns.loadDependencies.apply(null, a); }
function loadItemSnapshot (...a) { return __ns.loadItemSnapshot.apply(null, a); }
function requireConnected (...a) { return __ns.requireConnected.apply(null, a); }
function saveState (...a) { return __ns.saveState.apply(null, a); }
function withTimeout (...a) { return __ns.withTimeout.apply(null, a); }

function fixMojibake (s) {
  if (typeof s !== 'string' || !s) return s;
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? s : fixed;
  } catch {
    return s;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let body = '';
  let bodyBytes = 0;
  req.on('data', c => {
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      json(res, 413, { success: false, error: 'Request body too large' });
      req.destroy();
      return;
    }
    body += c;
  });

  req.on('end', async () => {
    const url = req.url.split('?')[0];
    const rawQs = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
    const qs = {};
    for (const [k, v] of Object.entries(rawQs)) qs[k] = fixMojibake(v);
    const key = `${req.method} ${url}`;
    const handler = handlers[key];

    if (!handler) {
      json(res, 404, { error: 'Unknown route', available: Object.keys(handlers) });
      return;
    }

    // /status、/config、/memory、/state、/knowledge 在机器人离线时也应可读
    // （离线时恰恰最需要看配置、记忆和游戏资料：为什么连不上、上次到哪了、这东西哪来的）
    // 这些路由**不碰游戏**，只读磁盘/内存，所以机器人离线时也必须可读。
    // 离线时恰恰最需要它们：调色板导入完了没有、快照抓到几条、为什么名字还是空的
    // —— 全是在"还没连上"的时候要查的。以前它们被连接前置检查挡在门外，
    // 想看诊断信息得先连上，而连不上正是要看诊断的原因（循环依赖）。
    const OFFLINE_OK = new Set([
      'GET /status', 'GET /config', 'GET /memory', 'GET /state',
      'GET /knowledge', 'GET /knowledge/search', 'POST /knowledge/search',
      // 调色板：本地文件 + 内存表
      'GET /palette', 'GET /palette/state', 'GET /palette/block', 'GET /palette/climbable',
      'POST /registry/import-palette',
      // FML 注册表快照：同样是本地文件 + 内存表
      'GET /debug/registries', 'GET /debug/registry',
      // 物品注册表：本地快照 + 内存里的注入报告
      'GET /item',
      // 插件装配状态：`GET /scan` 离线时也能看（会明确报"没连"），
      // `/eat` `/pickup` 不在此列 —— 那两个真的需要一张身体。
      'GET /plugins',
      // 实体诊断：**离线时也要能看**。它存在的场合正是"她好像什么都看不见"，
      // 而"没连上"和"连上了但认不出东西"必须能区分开 —— 这就是 P8 的教训。
      'GET /entities',
      // 重连：它存在的意义就是"当前没连上"
      'POST /reconnect',
      // ★ 配方表诊断（P49）：同样**离线也要能看** —— 它存在的场合正是
      //   "她做不出东西"，而"没连上"和"连上了但配方表是空的"必须能区分开。
      'GET /recipes',
    ]);
    if (!OFFLINE_OK.has(key) && !requireConnected(res)) return;

    try {
      const parsed = body ? JSON.parse(body) : {};
      // ⚠️ GET 的参数在 **query string** 里，POST 的在 body 里。以前这里只把 body 传给
      //    第一个参数，于是任何写成 `'GET /x': async ({ id }) => …` 的端点都**永远拿到
      //    默认值**（body 空 → 解构全落默认），不报错、只是静默失效。
      //    这个坑上一轮真踩了：`/palette/state?id=`、`/palette/block?name=`、
      //    `/debug/registry?q=` 全部形同虚设，而 `name` 恰好有默认值把症状掩盖了。
      //    治标是改那 4 个端点，治本是这里合并 —— 两种写法都对，以后不会再有人踩。
      //    第二个参数仍然是 query 对象（老写法 `(_, q)` 不受影响）。
      const args = req.method === 'GET' ? { ...qs, ...parsed } : parsed;
      // 会动身体的命令：先让本能让出身体（打断 + 等它收拾干净），执行期间本能不出手。
      // 见 instinct.js 顶部「身体归属」。GET 只看不动，不拦。
      const bodyCmd = req.method === 'POST' && !instinct.PASSIVE_POSTS.has(key) && state.instinct;
      // /stop 是急停，必须能越过锁；其余会动身体的 HTTP 请求严格互斥。
      // 这里选择“明确拒绝重叠”而不是排队：调用方可能已经超时或改了主意，排队会让
      // 一个被放弃的旧请求稍后突然执行。busy 是诚实、可重试、不会改变世界的结果。
      let bodyToken = null;
      if (bodyCmd && key !== 'POST /stop') {
        const got = bodyCommandLock.claim(state, key);
        if (!got.ok) {
          json(res, 200, {
            success: false,
            ok: false,
            error: `身体正在执行 ${got.active}（${(got.activeForMs / 1000).toFixed(1)} 秒），当前 ${key} 没有启动；等前一个动作完成后重试`,
            busy: bodyCommandLock.status(state),
          });
          return;
        }
        bodyToken = got.token;
      }
      let result;
      try {
        if (bodyCmd) {
          const y = await instinct.yieldBody(state, key, args);
          if (y?.reject) { json(res, 200, { success: false, ok: false, error: y.reject }); return; }
          // 反过来的打断：战斗本能要能叫停正在跑的命令（挖矿时僵尸扑上来，不能等挖完）。
          // 给每个命令一个序号，注入 abort()：cancelCommands() 之后，序号 ≤ 被取消线的命令都该收手。
          // 支持 abort 的 handler（/go /mine /pickup /farm…）在每一步之间问一次；其余的靠停寻路/停挖兜底。
          const mySeq = state.cmdSeq = (state.cmdSeq || 0) + 1;
          if (args && typeof args === 'object' && !Array.isArray(args) && args.abort === undefined) {
            args.abort = () => (state.cmdCancelledUpTo || 0) >= mySeq;
          }
          state.instinct.inflight++;
          // 物品账：这个命令执行期间（+ 结束后一小会儿）背包的进出都算它的
          const endLedger = state.ledger ? state.ledger.begin({ route: key }) : null;
          try { result = await handler(args, qs); } finally {
            state.instinct.inflight--;
            if (endLedger) { endLedger(); state.ledgerKick?.(); }
          }
        } else {
          result = await handler(args, qs);
        }
      } finally {
        if (bodyToken) bodyCommandLock.release(state, bodyToken);
      }

      // ⚠️⚠️⚠️ 2026-09-25 修复（P44 的**架构级根因**，见 field-log）：
      //
      // 这一行以前是**无条件**的 `json(res, 200, { success: true, ...result })`。
      // 它的语义只是「handler 没抛异常」—— 但**所有调用方都把它读成「动作在世界里生效了」**。
      // 于是同一个 bug 长出了四次（P32 pickup / P35 gather / P41 shelter / P44 move）：
      //   · handler 老老实实算了 `ok: false`（她知道没做成），
      //   · 路由层把 `success: true` 贴在最前面，
      //   · 调用方看见 `success: true` 就以为成了。
      // 每次都只在**单点**修（改判据 / 加字段），根因一直没动 —— 所以还会长第五次。
      //
      // 现在的规则：
      //   · `result.ok === false` **或** `result.success === false`（handler 显式否决）
      //     → **不贴** `success: true`，而是 `success: false` + 带 `_successNote`。
      //   · 其余情况保持原样（`success: true` + 展开 result，向后兼容全部旧调用方）。
      //
      // ⚠️ 判据只看 `=== false` 严格相等：`ok: undefined` / `ok: 0` / `ok: null`
      //    **都不否决** —— 绝大多数 handler 根本不返回 `ok`，不能让它们集体翻车。
      //
      // ⚠️ 为什么要认 `success === false`（2026-09-28，codex 审计 P-5）：
      //    有些 handler（`/reconnect`、`/registry/import-palette` …）只回
      //    `{ success: false, reason }`，**没有 `ok` 字段**。旧判据只看 `ok`，
      //    于是这些"她明确说了没做成"的返回值**走不进否决分支** ——
      //    虽然 `...result` 展开时 `success:false` 侥幸盖住了 `success:true`，
      //    但语义上路由层**没有把它们当失败**（没有 `_successNote`、没有统一口径），
      //    换成任何别的字段名就会翻车。判据收敛成一条：**handler 说了 false 就是 false**。
      const vetoed = result && typeof result === 'object'
        && (result.ok === false || result.success === false);
      if (vetoed) {
        const why = result.ok === false
          ? 'handler 的 ok:false'
          : 'handler 的 success:false';
        // ⚠️⚠️ 2026-09-28 审计（codex fix2 #2）：**先展开 result，再把否决字段放最后**。
        //
        //    原来写的是 `{ success:false, ok:false, ...result }` —— `...result` 在后面，
        //    **会把否决字段覆盖回去**。反例：handler 返回
        //    `{ ok: false, success: true }`（只显式否了 ok）→ 最终响应变成
        //    `{ success: true, ok: false }` —— `success:true` 又冒出来了，
        //    违反"任一 false 都算失败"。
        //
        //    顺序必须是：结果打底 → 判据字段收口。这样无论 handler 自己写了什么
        //    `ok/success`，最终**一定**是 `success:false, ok:false`。
        //    handler 的其它字段（`reason`/`error`/业务数据）仍完整保留。
        json(res, 200, {
          ...result,
          success: false,
          ok: false,
          _successNote:
            `success 由 ${why} 否决 —— 它明确表示这个动作**没有在世界里生效**。`
            + '（以前这里只看 ok，只回 success:false 的 handler 走不进否决分支；'
            + '更早则无条件贴 success:true，语义只是"handler 没抛异常"，'
            + '被调用方误读成"做成了"，见 field-log P44 / codex P-5；'
            + 'codex fix2 #2：字段顺序改为 result 在前，防 ...result 覆盖否决）',
        });
      } else {
        json(res, 200, { success: true, ...result });
      }
    } catch (err) {
      console.error(`[bridge] ${key} error:`, err.message);
      json(res, 500, { success: false, error: err.message });
    }
  });
});

function main () {
  installReplaceable();
  loadDependencies();
  installForgeHandshake();

  server.listen(CFG.bridge.port, '127.0.0.1', () => {
    const forgeOn = cfg('MC_FORGE', '0') === '1';
    const cfgFile = paths.CONFIG;
    console.log(`Minecraft Bridge v${BRIDGE_VERSION}`);
    console.log(`  身份 (bot identity) : ${CFG.mc.username}${CFG.mc.username === BOT_IDENTITY ? ' (固定)' : ' (被覆盖)'}`);
    console.log(`  HTTP API            : http://127.0.0.1:${CFG.bridge.port}`);
    console.log(`  Minecraft           : ${CFG.mc.host}:${CFG.mc.port}  version=${CFG.mc.version} auth=${CFG.mc.auth}`);
    console.log(`  Forge/FML 握手      : ${forgeOn ? 'ENABLED' : 'disabled'}`);
    console.log(`  config.json         : ${fs.existsSync(cfgFile) ? cfgFile : '(不存在，使用环境变量/默认值)'}`);
    console.log('  Bound to 127.0.0.1 only — do not expose this service publicly.');
    console.log('  Note: CORS headers are not sent — only same-origin or non-browser clients can access this API.');
    console.log(`  记忆 (memory)       : ${MEM_DIR}`);
    console.log(`  知识库 (knowledge)  : ${fs.existsSync(KB_DIR) ? KB_DIR : '(未安装)'}`);
    // 方块调色板：有就导入（让模组方块能叫出名字），没有就如实说没有。
    // 放在 createBot 之前只是为了让日志顺序好看 —— 名字解析器是**按引用**读
    // state.palette 的，所以之后用 POST /registry/import-palette 补上一样立刻生效。
    autoImportPalette();
    // 物品注册表快照：同样是"有就载入、没有就如实说没有"。
    // 必须在 createBot 之前读，因为注入要发生在本次连接的 inject_allowed 阶段。
    loadItemSnapshot();
    state.entitySnapshot = entityRegistry.loadSnapshot();
    console.log(state.entitySnapshot
      ? `[entities] 实体快照已载入：${state.entitySnapshot.entryCount} 条（抓取于 ${state.entitySnapshot.capturedAt}）`
      : '[entities] 还没有实体快照 —— 这次登录握手时会收到并落盘，之后刷出的模组生物就有名字了');
    createBot();

    // 每 30 秒把"当前状态"落盘一次，这样即使进程被强杀，state.json 也是新的。
    setInterval(() => {
      if (state.connected) saveState();
    }, 30_000).unref();
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[bridge] Port ${CFG.bridge.port} already in use — bridge may already be running.`);
      console.error(`  Check: curl http://localhost:${CFG.bridge.port}/status`);
    } else {
      console.error('[bridge] Server error:', err);
    }
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n[bridge] Shutting down...');
    try { state.bot?.end(); } catch (_) {}
    server.close(() => process.exit(0));
  });
}

const handRoutes = hands.routes({ state, withTimeout });

const csRoutes = require('../body/commonsense.js').routes({ state });

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.BRIDGE_VERSION !== undefined) BRIDGE_VERSION = ns.BRIDGE_VERSION;
  if (ns.BOT_IDENTITY !== undefined) BOT_IDENTITY = ns.BOT_IDENTITY;
  if (ns.MEM_DIR !== undefined) MEM_DIR = ns.MEM_DIR;
  if (ns.KB_DIR !== undefined) KB_DIR = ns.KB_DIR;
  if (ns.MAX_BODY_BYTES !== undefined) MAX_BODY_BYTES = ns.MAX_BODY_BYTES;
  if (ns.autoImportPalette !== undefined) autoImportPalette = ns.autoImportPalette;
  if (ns.cfg !== undefined) cfg = ns.cfg;
  if (ns.createBot !== undefined) createBot = ns.createBot;
  if (ns.fixMojibake !== undefined) fixMojibake = ns.fixMojibake;
  if (ns.handlers !== undefined) handlers = ns.handlers;
  if (ns.installForgeHandshake !== undefined) installForgeHandshake = ns.installForgeHandshake;
  if (ns.installReplaceable !== undefined) installReplaceable = ns.installReplaceable;
  if (ns.json !== undefined) json = ns.json;
  if (ns.loadDependencies !== undefined) loadDependencies = ns.loadDependencies;
  if (ns.loadItemSnapshot !== undefined) loadItemSnapshot = ns.loadItemSnapshot;
  if (ns.requireConnected !== undefined) requireConnected = ns.requireConnected;
  if (ns.saveState !== undefined) saveState = ns.saveState;
  if (ns.state !== undefined) state = ns.state;
  if (ns.withTimeout !== undefined) withTimeout = ns.withTimeout;
}

module.exports = {
  "fixMojibake": fixMojibake,
  "server": server,
  "main": main,
  "handRoutes": handRoutes,
  "csRoutes": csRoutes,
  bind,
};
