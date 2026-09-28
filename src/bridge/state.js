/**
 * state.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const pathing = require('../world/pathing');
const paths = require('../paths');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let CFG;

function botPos (...a) { return __ns.botPos.apply(null, a); }

const state = {
  bot: null,
  connected: false,
  retries: 0,
  currentAction: null,
  // HTTP 身体命令互斥。mind 的旧请求不会因新一轮思考自动消失；不加锁时两个
  // pathfinder.goto 会互相替换 goal，外观就是“正常箱子突然打不开”。
  bodyCommand: null,
  movements: null, // Movements 实例，供 /config 自检寻路器安全开关
  pfPolicy: null,  // pathing.applyPolicy 的摘要（代价 + 受保护方块数）
  pfProbe: null,   // 注册表往返自检结果（名字可不可信）
  pfClimb: null,   // 可攀爬方块装配摘要（梯子在模组服上会被静默漏掉）
  pfClimbProbe: null, // 原版那套认不认得出这包里的梯子
  pfLadderFix: null,  // 物理层梯子 ID 修正摘要（必须在 createBot 之前做）
  pfUnknown: null,    // 未映射方块策略摘要（当实心，避免"客户端看不见的墙"）
  // 方块调色板索引（stateId → 真实方块名 + 属性值）。null = 还没导入。
  // 有了它，`GET /block` 才能把 `upgrade_aquatic:glass_trapdoor` 这种模组方块
  // 叫出名字来，而不是空字符串。数据来自客户端 KubeJS 导出的 dump。
  palette: null,
  paletteMeta: null,  // { file, loadedAt, entries, gaps, totalStates, source, inject }
  paletteInject: null, // 最近一次"写回注册表"的结果（连接后重注入会更新它）
  // 物品注册表快照（`registry/minecraft-item.json`，FML 握手 `S2CRegistry` 的
  // `minecraft:item` 那一份，30729 条 `[名字, 数字id]`）。启动时从磁盘读，
  // 抓到新快照时就地更新 —— 与方块那条 `blockNameToId()` 完全同一个理由：
  // 快照**连接时才到**，而注入发生在 inject_allowed 阶段，所以只能先用上一份。
  itemSnapshot: null,
  itemInject: null,    // 最近一次物品注入的结果
  gaveUpReconnecting: false, // 自动重试耗尽后置 true；POST /reconnect 会清掉它
  // ---- 寻路目标的变更轨迹（P25 排查用）--------------------------------------
  //
  // 为什么需要它：`mineflayer-pathfinder` 的 `goto()` 会在收到 `goal_updated`
  // 且 `newGoal !== goal` 时报 "The goal was changed before it could be completed!"。
  // 这条错误**只说了"目标变了"，没说是谁改的、改成了什么** ——
  // 实测中它导致「地上 4 个掉落物、距离 1.4 格、一个都捡不到」，
  // 而单看错误信息完全推不出成因。
  //
  // 这个环形缓冲把每一次 `goal_updated` 记下来（谁触发的 + 新目标是什么），
  // 通过 `GET /debug/pathfinder` 暴露。**只读、无副作用**。
  __goalTrace: [],
  __goalTraceMax: 40,
  // 运行时"可穿过"的 state 白名单。她**自己打开**的门/活板门在实测穿得过去之后记进来。
  // ⚠️ 这个 Set 必须**只增删、绝不替换** —— world.getBlock 的补丁是按引用读它的。
  passableStateIdsRuntime: new Set(),
};

const MAX_BODY_BYTES = 64 * 1024;

const CHATLOG_MAX = 200;

const chatlog = [];

function pushChat (text, position) {
  chatlog.push({ t: Date.now(), position: position ?? null, text });
  while (chatlog.length > CHATLOG_MAX) chatlog.shift();
}

const MEM_DIR = paths.MEMORY;

const JOURNAL_FILE = path.join(MEM_DIR, 'journal.md');

const STATE_FILE = path.join(MEM_DIR, 'state.json');

const KB_DIR = paths.KNOWLEDGE;

function ensureMemDir () {
  try { fs.mkdirSync(MEM_DIR, { recursive: true }); } catch (_) {}
}

function localStamp () {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function journal (type, text) {
  ensureMemDir();
  const clean = String(text).replace(/\r?\n/g, ' ').trim();
  const line = `- [${localStamp()}] (${type}) ${clean}`;
  try {
    fs.appendFileSync(JOURNAL_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('[bridge] 记忆写入失败:', e.message);
  }
  return line;
}

function readJournal (limit = 40) {
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
    return { total: lines.length, lines: lines.slice(-limit) };
  } catch (_) {
    return { total: 0, lines: [] };
  }
}

function saveState () {
  ensureMemDir();
  const snap = {
    savedAt: localStamp(),
    identity: CFG.mc.username,
    server: `${CFG.mc.host}:${CFG.mc.port}`,
    connected: state.connected,
    position: botPos(),
    dimension: state.bot?.game?.dimension ?? null,
    health: state.bot?.health ?? null,
    food: state.bot?.food ?? null,
    gameTime: state.bot?.time?.timeOfDay ?? null,
    isDay: (state.bot?.time?.timeOfDay ?? 0) < 13000,
    isSleeping: !!state.bot?.isSleeping,
    // 模组服务器上 minecraft-data 可能不认识某些物品，name 会是 'unknown'；退回数字 id
    inventory: (state.bot?.inventory?.items() || []).map(i =>
      `${(!i.name || i.name === 'unknown') ? `item#${i.type}` : i.name}x${i.count}`),
    playersOnline: Object.values(state.bot?.players || {}).map(p => p.username),
    currentAction: state.currentAction,
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2), 'utf8');
  } catch (e) {
    console.error('[bridge] 状态写入失败:', e.message);
  }
  return snap;
}

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.botPos !== undefined) botPos = ns.botPos;
}

module.exports = {
  "state": state,
  "MAX_BODY_BYTES": MAX_BODY_BYTES,
  "CHATLOG_MAX": CHATLOG_MAX,
  "chatlog": chatlog,
  "pushChat": pushChat,
  "MEM_DIR": MEM_DIR,
  "JOURNAL_FILE": JOURNAL_FILE,
  "STATE_FILE": STATE_FILE,
  "KB_DIR": KB_DIR,
  "ensureMemDir": ensureMemDir,
  "localStamp": localStamp,
  "journal": journal,
  "readJournal": readJournal,
  "saveState": saveState,
  bind,
};
