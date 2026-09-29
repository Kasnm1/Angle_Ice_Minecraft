#!/usr/bin/env node
// state.js —— 全进程唯一的一份可变状态 `W`（顺带 CFG / 全部外部 require）。
//
// ## 为什么单独一个文件
//
// `W`（`W.history` / `W.state` / `W.pending` / `W.recentResults`…）是意识流的**唯一**载体：
// 拆出来的每个文件都从这里 require 同一个对象引用，**绝不复制** —— 复制一份就会出现
// "think 写的 W 和 look 读的 W 不是同一个"这种离线全绿、上线静默失效的 bug。
//
// 同样的道理，`CFG`（全部配置常量）和所有外部模块（body / speech / mem / knowledge /
// ambition / review / ledgerLib / night / plan / storagePolicy）也在这里统一 require，
// 兄弟文件要用就从这里取（`require('./state')`）。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。
// 汇总在上一层的 `src/mind/mind.js`（普通文件，不是符号链接）。


/**
 * Angle_ICE 的意识 —— 一条不断线的经历流。
 *
 * ## 和上一版（brain.js）的根本区别
 *
 * brain.js 每次调模型都是**失忆的**：一张状态快照 + 最近几句聊天，想完就忘。
 * 于是她不知道煎蛋是做给玩家的（任务一结束"给谁"就没了），我只能不停加规则打补丁。
 *
 * 这里她是**一个持续活着的人**（参照 Astra 在 Minecraft 里连续 141 小时的 agent 形态）：
 *   · 经历是连续的：发生的事按时间流进同一段对话，她在这条流里想、说、做
 *   · 记忆是她自己写的（memory-store.js）：对每个玩家的看法、知识图谱、教训、答应过的事
 *   · 每想一步前，按此刻涉及的人/物"想起来"相关的记忆
 *   · 上下文快满了就"睡觉整理"：她自己挑要记住的写下来、写日记、检查旧教训有没有过时
 *   · 亲手做成的事自动记成经验（最牢的一种记忆）
 *
 * 程序里只留**本能**（饿到发慌就吃、"停/跟我来"瞬间反应）—— 其他判断都是她的。
 *
 * ## 运行
 *
 *     node mind.js               # 需先起 bridge-server.js
 *     node mind.js --selftest
 *     node mind.js --sim "安琪你好" "给你7个鸡蛋" …   # 假身体 + 真模型
 *
 * 控制面：GET http://127.0.0.1:3003/mind   （她此刻在想什么、记得什么）
 */

const http = require('http');
// 每行输出带墙钟时间。她的 log() 已经自带 `[HH:MM:SS]`（下面那个），
// log-stamp 认得这种行、不会重复加；装它是为了让 body / plan 等直接 console 的输出也有时间。
require('../../log-stamp');
const body = require('../body');
const speech = require('../speech');
const mem = require('../memory-store');
const knowledge = require('../../knowledge/knowledge');
const ambition = require('../ambition');
const review = require('../self-review');
const ledgerLib = require('../../body/inventory-ledger');   // 只用它的 render（账在 bridge 记，见 inventory-ledger.js）
const night = require('../night');   // 天黑本能：天色变化的事件 + 今晚怎么安排（见 night.js）
const plan = require('../plan');     // 长期计划：没人找她时自己推进游戏（见 plan.js）
const storagePolicy = require('../../body/storage-policy');
const { TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = body;

const CFG = {
  ...body.CFG,
  port: parseInt(process.env.MIND_PORT || process.env.BRAIN_PORT || '3003'),
  pollMs: 1000,              // 看一眼世界（本机 HTTP，便宜）
  debounceMs: 400,           // 事件攒一小会儿再想
  slowLookMs: parseInt(process.env.MIND_SLOW_LOOK_MS || '5000'),   // 门、装备、没开过的箱子、亮度：多久看一次
  // 玩家说话：马上开始想，但**先别开口**，等他说完。真人常把一句话拆成几条发（"那个" / "箱子里" / "有铁吗"）。
  // 他最后一条之后 4 秒内又来一条 → 还没说出口的这一轮作废，带上新的一起重想（见 chatGate / emit）；
  // 说出口或动了手之后就不作废了，新来的下一轮再接。一直在打也最多压 12 秒。
  // 等的时候身体照常干活（动作在 bridge 里跑，不靠"想"）；危险、挨打这类 urgent 事件不等。
  // （2026-09-27 主人定：4 秒；是"想着等"，不是"干等完才想"）
  chatQuietMs: parseInt(process.env.MIND_CHAT_QUIET_MS || '4000'),
  // 回他之前还要"打字"：按她要说的字数算，从他最后一条算起（想的时间也算在打字里）。
  // 短的（"好"）被上面的 4 秒盖住；长的 6–8 秒（主人 2026-09-27："长文本可以 6-8 秒"）
  typeBaseMs: 2000, typePerCharMs: 150, typeMaxMs: 8000,
  chatQuietMaxMs: parseInt(process.env.MIND_CHAT_QUIET_MAX_MS || '12000'),
  idleThinkMs: parseInt(process.env.MIND_IDLE_MS || '90000'),   // 多久没事发生就自己想想要干嘛
  maxRounds: 6,              // 一次"想"最多来回几轮（查资料要轮次）
  llmTimeoutMs: 25000,
  // 超过就睡觉整理。每次思考都会把这段经历整个发给模型 —— 越长越贵越慢；更早的交给记忆"想起来"
  maxHistoryChars: parseInt(process.env.MIND_MAX_CHARS || '40000'),
  keepAfterSleep: 8,         // 整理后保留最近几条原话
  topicMs: 5 * 60000,        // 别人交代的事，多久之内做每一步都还会顺着它去想起来
  hungerInstinct: 6,         // 本能：饿到这个程度不经过思考直接吃
  autopilot: process.env.MC_AUTOPILOT_URL || 'http://127.0.0.1:3002',
  yieldMs: 20000,            // 让脑干让出身体多久（她挂了，脑干到点自动接回）
  heartbeatMs: 8000,         // 多久续一次（必须明显短于 yieldMs）
};

// ------------------------------------------------------------------ 状态

// ---------------------------------------------------------- W（只此一份）
const W = {
  startedAt: Date.now(),
  history: [],               // 意识流：user(发生的事) / assistant(她的想法和动作) / tool(结果)
  contextSince: Date.now(),  // 意识流里最早那件事的时间；更早的经历要靠"想起来"
  pending: [],               // 还没被她"注意到"的事
  thinking: false,
  thinkCtl: null,
  thinkWhy: null,
  lastEventAt: Date.now(),
  lastThinkAt: 0,
  job: null,                 // 身体正在做的一串动作 {token, steps, i, why}
  token: 0,
  state: null,               // 最近一次看到的世界
  seenChat: new Set(),
  lastInv: null,
  ledgerSeq: null,    // 物品账读到哪了（bridge 的 /inventory/ledger）；null = 还没读过（第一次不翻旧账）
  ledgerNew: null,    // 这一眼新看到的账
  instinctSeq: null,  // 本能事件读到哪了（/instinct/events）
  darkSpots: null,    // 本能报过的家里暗处坐标（dark_spot 事件的 sample）—— 她调 light_up 时带上它
  lastTorchAskSaidAt: 0,   // 上次把"要插火把吗"说出去的时刻（2026-09-29）—— 同一个问题冷却内不再放行（见 gates.torchAskAllowed）
  homeToldAt: 0,      // 上次把家告诉本能层的时间
  lastHp: null,
  players: new Set(),
  log: [],
  recent: [],                // 最近发生的几件事（自我复盘的现场证据）
  recentFails: [],           // 最近没做成的动作（她 report_issue 时附上）
  lastSaid: null,            // 她最近说的一句
  replyShapes: [],           // 最近几次回他各分成了几条（最新在后）—— 防止条数定型，见 repetitionHint
  recentLines: [],           // 她最近发出去的几条（最新在后）—— 防止语气词变口头禅，见 particleHint
  stats: { thinks: 0, llmMs: 0, sleeps: 0, fastPath: 0, instinct: 0, errors: 0, idleSkipped: 0 },
  // ── 线路出毛病时的自我节制（见 think 的 catch）─────────────────────────────
  // 以前一坏就 1 秒一次死循环：2026-09-28 审计实测 53 次 403 一秒一发，10 秒里烧掉 53 次请求。
  failStreak: 0,            // 连续失败了几次（成功一次清零）
  failUntil: 0,             // 歇到什么时候（连续 5 次失败 → 停 5 分钟）
  blockedFrom: 0,           // 上一次成功时意识流有多长 —— 403 压缩时从这里往后掐
  auditStreak: 0,           // 连续 403 内容审计几次（到 2 次就压缩那段发不出去的内容）
  groupRound: 0,            // "想"到第几轮了（按需组的有效期按它算）
  groupActive: {},          // { 组名: 到期轮次 }
};


// ---------------------- 导出（别的文件从这里取；W 是同一个对象，别复制）

module.exports = {
  http, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy,
  TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize,
  CFG, W,
};
