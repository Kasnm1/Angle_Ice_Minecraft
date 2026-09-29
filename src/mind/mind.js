#!/usr/bin/env node
'use strict';

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
 *
 * ## 这个文件现在是什么（第 3 步 e，2026-09-29）
 *
 * 只搬移、不改逻辑地拆成 `src/mind/mind/`（见 `src/mind/mind/AGENTS.md`）：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `state.js` | **全进程唯一一份** `W`（可变状态）、`CFG`、全部外部 require |
 * | `prompt.js` | `SYSTEM` 系统提示词（一字不改） |
 * | `runtime.js` | `log` / `emit` / `chatGate` / `scheduleThink`（节奏与事件） |
 * | `scene.js` | 感知的"人话"层（血量 / 天色 / 认怪 / 余光 / 掉落） |
 * | `look.js` | `look()` 看世界 |
 * | `tools.js` | `MIND_TOOLS` / `ALL` / `SPECS` / 工具分组 |
 * | `actions.js` | `startJob` / `runTool` / `fastPath`（把"想"变成"做"） |
 * | `think.js` | `buildNow` / `think` / 睡眠整理 / 控制面 |
 * | `gates.js` | 说话出口的闸 + 事实核对 |
 * | `wiring.js` | 兄弟文件之间**运行时才读**的转发壳（断循环依赖） |
 * | `selftest.js` | 约 1000 行自测（从本文件原样搬来） |
 *
 * 这里只剩：`module.exports`（**逐字照抄拆前那一行**）、`main` / `mockBridge` /
 * `sim` / `cli`（入口逻辑）。**普通文件，不是符号链接**（Windows 的 git 会把它签出成纯文本）。
 */

// ============================================================ 拆分后的接线
// 汇总按原路径被外部 require（根目录 `mind.js` 一行转发、`scripts/dialogue-eval.js` 取
// SYSTEM/SPECS/SAY_NUDGE），所以这里的 `module.exports` 名字与**顺序**必须和拆前一模一样
// （`scripts/test-all.js` 的导出快照 + `references/exports-mind.json` 钉着）。
const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./mind/state');
const rt = require('./mind/runtime');
const { log, hhmmss, emit, chatWaitLeft, typingMs, chatGate, scheduleThink } = rt;
const sc = require('./mind/scene');
const { humanState, tonight, combatInstinct, combatGuard, attackGuardReason, survivalFocus, dayKey, dropsNear, dropLine, invText, surroundNeeds, surroundLine, pickJoinMood, JOIN_MOODS } = sc;
const { look } = require('./mind/look');
const { MIND_TOOLS, ALL, SPECS, GROUPS, TOOL_GROUPS, UNGROUPED, GROUP_ROUNDS, GROUP_CUES, groupsFromBody, pickSpecs, activateGroup, activeGroups, kindOf } = require('./mind/tools');
const { startJob, runTool, fmtArgs, toolResultLine, celebrate, learnFromDoing, instinctEat, NAME_RE, FAST, matchFast, fastPath } = require('./mind/actions');
const { historyChars, bodyNow, knownStations, shortName, homeStockItems, planFacts, planExtras, planLine, buildNow, repetitionHint, PARTICLES, particleHint, idleGate, compactLastNow, think, clipText, repairHistory, trimDangling, sleepAndSort, sortMemories, autopilot, holdBody, startControl } = require('./mind/think');
const { isBareAffirmative, taskDoneAllowed, isOverAsking, lastProactiveUnanswered, claimState, liveFails, unbackedClaim, FACT_CLAIMS, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, HONEST_NUDGE, QUIET_MS, ASK_COOLDOWN_MS, DELEGATES, ASKS_BACK, DECIDE_NUDGE, ASKS_WHERE, LOOK_NUDGE, SAY_NUDGE, ACTION_NUDGE, RECENT_CLAIM_MS, PLAYER_MOVE_TOOLS, PLAYER_MOVE_RE, TASK_WINDOW_MS, TASK_ASK_RE, TASK_DONE_RE } = require('./mind/gates');
const { SYSTEM } = require('./mind/prompt');
const { selftest, mockBridge } = require('./mind/selftest');

async function main () {
  if (!CFG.baseUrl || !CFG.apiKey) { console.error('缺少 LLM_BASE_URL / LLM_API_KEY'); process.exit(1); }
  body.hooks.onSay = (t) => { W.lastSaid = String(t); mem.episode(`我说：${t}`, [...W.players]); };
  // 像人一样：看完你的话、打完字才发出去（按字数，1.5～4 秒，从听到那句话开始算；想得久的就不用再等）
  body.hooks.beforeSay = async (t) => {
    const want = Math.min(4000, 1200 + String(t).length * 90);
    const since = Date.now() - (W.lastHeardAt || 0);
    if (since < want) await new Promise(r => setTimeout(r, want - since));
    W.lastHeardAt = 0;   // 同一轮里第二句不用再等那么久
  };
  // 战斗本能在打：身体不在她手上，attack 这一下直接回给她，不发 HTTP（2026-09-28 审计：她连打 22 次同一只骷髅，
  // 全是在跟本能抢手；本能自己会打完）。要她逃就说逃 —— 逃是 stop / goto，不是 attack。
  body.hooks.beforeAttack = () => attackGuardReason(W.state);
  // 2026-09-27 用户现场纠错：旧版探洞事件把“人在洞里”写成“挖到了洞”。
  // 修正由程序写入的那条假经历；“我说过什么”保留为真实对话记录。
  const loadedMemory = mem.load();
  let correctedCaveEpisode = false;
  for (const e of loadedMemory.episodes || []) {
    if (e.text === '挖到了一个天然洞穴（32,94,11），进去看看') {
      e.text = '更正：当时已在住宅下方的洞里；进入方式没有动作记录。玩家说明是走下来的，不能说挖穿或掉下来。';
      correctedCaveEpisode = true;
    }
  }
  if (correctedCaveEpisode) mem.touch();
  const K = knowledge.load();
  log(`Angle_ICE 醒了  模型=${CFG.model}  记忆=${JSON.stringify(mem.stats())}  书=${K.recipes.length} 条配方`);
  startControl();
  const S = mem.load();
  const lastDiary = S.journal[S.journal.length - 1];
  if (lastDiary) W.history.push({ role: 'user', content: `【醒来】你上次写的日记：\n${lastDiary.text}` }, { role: 'assistant', content: '嗯，我记得。' });

  await look();   // 第一眼：把已有聊天标成看过、记下背包
  W.pending.length = 0;
  emit('🌅 你上线了（刚醒过来）');
  // 任务队列：上次没做完的事读回来（running → paused(restart)，她自己想做、已过期的标 expired），醒来第一轮就告诉她。
  // 2026-09-29 Claude 复核补：restore() 原来只有自测调，正式运行从没读回过 —— "重启保留"（主人确认过的）没生效。
  try {
    const tq = require('./mind/tasks');
    const rep = tq.restore();
    const left = tq.open();
    if (rep.unreadable) emit('📋 任务记录读不出来（memory/tasks.json 坏了？）—— 上次没做完的事不知道还有哪些');
    else if (left.length || rep.expired.length) {
      const parts = [];
      if (left.length) parts.push(`上次没做完的：${left.slice(0, 5).map(t => `#${t.id} ${t.title}${t.source === 'player' ? '（主人交代的）' : ''}`).join('、')}`);
      if (rep.expired.length) parts.push(`你自己想做、放太久过期了的：${rep.expired.map(t => `#${t.id} ${t.title}`).join('、')}`);
      emit(`📋 ${parts.join('；')}`);
    }
  } catch (e) { console.warn(`[tasks] 读回任务失败：${e.message}`); }

  setInterval(() => look().catch(() => {}), CFG.pollMs);
  setInterval(() => {
    // 有正在做的计划步骤、3 分钟没人跟她说话 → 30 秒就接着做（主人："闲着的时候也可以继续当前任务"）
    const idleMs = plan.current() && Date.now() - (W.lastHeardAt || 0) > 180000 ? Math.min(CFG.idleThinkMs, 30000) : CFG.idleThinkMs;
    if (!W.thinking && !W.pending.length && Date.now() - Math.max(W.lastEventAt, W.lastThinkAt) > idleMs && !(W.job && !W.job.holding)) think('idle');
  }, 5000);
  // 记忆落盘：60 秒一次。原来 10 秒 —— 有改动时每 10 秒整份重写 966KB 的 mind.json，
  // 而她的经历/回想本来就是一分钟级的变化，10 秒省不下任何东西。
  // 进程退出、睡觉整理等**显式**的 mem.save() 另算，不受这里影响。
  setInterval(() => { try { mem.save(); } catch (e) { console.warn(`[memory] 存盘失败：${e.message}`); } }, 60000);   // 存盘出错不能把 mind 带走
  await holdBody(true);
  setInterval(() => holdBody(true), CFG.heartbeatMs);
  const bye = async () => { log('睡着了（进程退出）'); mem.save(); await holdBody(false); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

// ------------------------------------------------------------------ 模拟 / 自测


async function sim (lines) {
  // 模拟不碰真的任务队列（2026-09-29 Claude 复核补）
  if (!process.env.MC_TASKS_FILE) process.env.MC_TASKS_FILE = require('path').join(require('os').tmpdir(), `tasks-sim-${process.pid}.json`);
  process.env.MC_MIND_FILE = process.env.MC_MIND_FILE || require('path').join(require('os').tmpdir(), `mind-sim-${process.pid}.json`);
  body._setBridge(mockBridge());
  W.sim = true;
  W.state = { connected: true, health: 18, food: 15, isDay: true, pos: { x: 35, y: 64, z: -138 }, items: [{ name: 'egg', count: 7 }], nearby: [], players: [] };
  console.log(`模拟：模型=${CFG.model}（假身体，真模型，记忆写到临时文件）\n`);
  for (const line of lines) {
    const t0 = Date.now();
    if (line === '(闲着)') {
      console.log('  （一段时间没人理她）');
      W.lastEventAt = Date.now() - CFG.idleThinkMs;
      think('idle');
    } else {
      console.log(`  <Ka_sum1> ${line}`);
      emit(`💬 Ka_sum1 说：${line}`, { cue: `Ka_sum1 ${line}`, names: ['Ka_sum1'], chat: true });
    }
    await new Promise(r => setTimeout(r, 50));
    for (let i = 0, idle = 0; i < 240 && idle < 4; i++) {
      await new Promise(r => setTimeout(r, 500));
      idle = (W.thinking || W.pending.length || rt.readingThinkTimer() || (W.job && !W.job.holding)) ? 0 : idle + 1;
    }
    console.log(`      ⏱ ${Date.now() - t0}ms\n`);
  }
  console.log('她记下的：');
  console.log(`  心愿：${JSON.stringify(ambition.progress().made)} 种；在研究 ${ambition.state().focus || '（无）'}`);
  for (const k of mem.load().skills) console.log(`  技能 ${k.id} ${k.name}（成功 ${k.successes}）`);
  const S = mem.load();
  for (const m of S.memories) console.log(`  #${m.id} [${m.kind}/${m.status}] ${m.text}`);
  for (const p of Object.values(S.people)) console.log(`  对 ${p.name}：${p.impression}（好感 ${p.affinity}）${p.facts.join('；')}`);
  process.exit(0);
}


function cli (argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv[0] === '--sim') return sim(argv.slice(1).length ? argv.slice(1) : ['安琪你好呀', '给你7个鸡蛋，帮我烤一下', '烤好了吗']);
  return main();
}

module.exports = { W, emit, think, buildNow, matchFast, humanState, learnFromDoing, repetitionHint, SYSTEM, SPECS, SAY_NUDGE, ALL, MIND_TOOLS, GROUPS, pickSpecs, groupsFromBody, activeGroups, activateGroup, TOOL_GROUPS, GROUP_CUES, combatInstinct, combatGuard, attackGuardReason, isOverAsking, lastProactiveUnanswered, unbackedClaim, taskDoneAllowed, claimState, liveFails, FACT_CLAIMS, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, HONEST_NUDGE, QUIET_MS, ASK_COOLDOWN_MS, cli };   // SYSTEM/SPECS 给 scripts/dialogue-eval.js 离线跑分用
