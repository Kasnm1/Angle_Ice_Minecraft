#!/usr/bin/env node
'use strict';

/**
 * Angel_ICE 的意识 —— 一条不断线的经历流。
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
const body = require('./body');
const mem = require('./memory-store');
const knowledge = require('./knowledge');
const ambition = require('./ambition');
const { TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = body;

const CFG = {
  ...body.CFG,
  port: parseInt(process.env.MIND_PORT || process.env.BRAIN_PORT || '3003'),
  pollMs: 1000,              // 看一眼世界（本机 HTTP，便宜）
  debounceMs: 400,           // 事件攒一小会儿再想（玩家常分几条发）
  idleThinkMs: parseInt(process.env.MIND_IDLE_MS || '90000'),   // 多久没事发生就自己想想要干嘛
  maxRounds: 6,              // 一次"想"最多来回几轮（查资料要轮次）
  llmTimeoutMs: 25000,
  // 超过就睡觉整理。每次思考都会把这段经历整个发给模型 —— 越长越贵越慢；更早的交给记忆"想起来"
  maxHistoryChars: parseInt(process.env.MIND_MAX_CHARS || '40000'),
  keepAfterSleep: 8,         // 整理后保留最近几条原话
  hungerInstinct: 6,         // 本能：饿到这个程度不经过思考直接吃
  autopilot: process.env.MC_AUTOPILOT_URL || 'http://127.0.0.1:3002',
  yieldMs: 20000,            // 让脑干让出身体多久（她挂了，脑干到点自动接回）
  heartbeatMs: 8000,         // 多久续一次（必须明显短于 yieldMs）
};

// ------------------------------------------------------------------ 状态

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
  lastHp: null,
  players: new Set(),
  log: [],
  stats: { thinks: 0, llmMs: 0, sleeps: 0, fastPath: 0, instinct: 0, errors: 0 },
};

function log (msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  W.log.push(line);
  if (W.log.length > 300) W.log.shift();
}

const hhmmss = (t = Date.now()) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

// ------------------------------------------------------------------ 事件

/**
 * 世界里发生了一件事。text 是给她看的一句话；cue 用来"想起来"；names 是涉及的玩家。
 * urgent：有人跟她说话 / 挨打 —— 马上想，正在"闲想"的话打断它。
 */
function emit (text, { cue = '', names = [], urgent = false } = {}) {
  W.pending.push({ t: Date.now(), text, cue: `${text} ${cue}`, names });
  // 自动记成经历（人不用刻意也记得今天发生了什么）
  const ids = [...`${text} ${cue}`.matchAll(/[a-z0-9_]+:[a-z0-9_/.-]+/g)].map(m => m[0]);
  mem.episode(text.replace(/^\S+\s/, ''), [...names, ...ids]);
  W.lastEventAt = Date.now();
  if (urgent && W.thinking && W.thinkWhy === 'idle') W.thinkCtl?.abort();
  scheduleThink(urgent ? 0 : CFG.debounceMs);
}

let thinkTimer = null;
function scheduleThink (ms) {
  if (thinkTimer) return;
  thinkTimer = setTimeout(() => { thinkTimer = null; think('event'); }, ms);
}

// ------------------------------------------------------------------ 看世界

function humanState (s) {
  if (!s) return '（看不到自己的状态）';
  const hp = s.health; const food = s.food;
  const hpWord = hp == null ? '?' : hp >= 18 ? '很好' : hp >= 12 ? '还行' : hp >= 6 ? '受伤了' : '快不行了';
  const foodWord = food == null ? '?' : food >= 17 ? '饱' : food >= 11 ? '不饿' : food >= 7 ? '有点饿' : '很饿';
  return `血 ${hp}/20（${hpWord}）、饥饿 ${food}/20（${foodWord}）、${s.isDay ? '白天' : '夜晚'}、在 (${s.pos?.x},${s.pos?.y},${s.pos?.z})`;
}

function invText (items) {
  return (items || []).map(i => `${knowledge.label(i.name.includes(':') ? i.name : `minecraft:${i.name}`)}×${i.count}`).join('、') || '空的';
}

async function look () {
  const safe = p => bridge.get(p, 2000).catch(() => null);
  const [st, inv, near, pl, chat, doors, eq, seen] = await Promise.all([
    safe('/status'), safe('/inventory'), safe('/nearby?radius=16'), safe('/players'), safe('/chatlog?limit=30'), safe('/doors?radius=6'), safe('/equipment'),
    safe(`/containers/seen?since=${W.seenSince || 0}`),
  ]);
  // 打开过的箱子：是家里的，就记住里面有什么、各有几个（像人一样，看过就大概记得）
  for (const c of seen?.seen || []) {
    W.seenSince = Math.max(W.seenSince || 0, c.at);
    const [x, y, z] = String(c.key).split(',').map(Number);
    if (mem.inHome({ x, y, z })) mem.noteHomeBox(c);
  }
  if (!st) { W.state = null; return; }
  W.state = {
    connected: !!st.connected, health: st.health, food: st.food, isDay: st.isDay,
    pos: st.position ? { x: Math.round(st.position.x), y: Math.round(st.position.y), z: Math.round(st.position.z) } : null,
    items: inv?.items || [],
    nearby: (near?.entities || []).slice(0, 12),
    players: (pl?.players || []).filter(p => !p.isSelf),
    doors: doors?.doors || [],
    equipment: eq?.equipment || null,
  };
  // 她开了没来得及关的门（走太快，已经够不着了）—— 告诉她，由她决定回去关
  for (const d of doors?.leftOpen || []) {
    const k = `${d.pos.x},${d.pos.y},${d.pos.z}@${d.at}`;
    if (W.seenChat.has(k)) continue;
    W.seenChat.add(k);
    emit(`⚠️ 你刚才打开的 ${knowledge.label(d.name.includes(':') ? d.name : `minecraft:${d.name}`)}(${d.pos.x},${d.pos.y},${d.pos.z}) 走远了没来得及关，还开着`, { cue: 'door gate', urgent: false });
  }
  if (!st.connected) return;

  // ---- 聊天
  for (const m of chat?.messages || []) {
    const key = `${m.t}|${m.text}`;
    if (W.seenChat.has(key)) continue;
    W.seenChat.add(key);
    if (W.seenChat.size > 800) W.seenChat = new Set([...W.seenChat].slice(-300));
    if (m.t < W.startedAt - 2000) continue;           // 启动前的旧消息
    if (m.position === 'chat') {
      const x = String(m.text).match(/^<([^>]+)>\s*(.+)$/);
      if (!x || x[1] === CFG.botName) continue;
      const [, who, text] = x;
      mem.meet(who, { chatted: true });
      if (fastPath(who, text)) continue;
      W.lastHeardAt = Date.now();
      emit(`💬 ${who} 说：${text}`, { cue: `${who} ${text}`, names: [who], urgent: true });
    } else if (m.position === 'bridge' && /加入|离开|joined|left/.test(m.text)) {
      const who = (m.text.match(/\*\s*(\S+)/) || [])[1];
      if (who && who !== CFG.botName) emit(`🚪 ${m.text.replace(/^\*\s*/, '')}`, { cue: who, names: [who] });
    } else if (m.position === 'system' && new RegExp(CFG.botName).test(m.text) && /died|死|slain|killed|blew|burn|drown/.test(m.text)) {
      emit(`☠️ ${m.text}`, { urgent: true });
    }
  }

  // ---- 背包变化（得到/失去了什么）
  const inv2 = new Map();
  for (const i of W.state.items) inv2.set(i.name, (inv2.get(i.name) || 0) + i.count);
  if (W.lastInv && !W.job) {   // 干活时的变化由动作结果报告，不重复
    const gained = []; const lost = [];
    for (const k of new Set([...W.lastInv.keys(), ...inv2.keys()])) {
      const d = (inv2.get(k) || 0) - (W.lastInv.get(k) || 0);
      const nm = knowledge.label(k.includes(':') ? k : `minecraft:${k}`);
      if (d > 0) gained.push(`${nm}×${d}`); else if (d < 0) lost.push(`${nm}×${-d}`);
    }
    if (gained.length) emit(`🎒 背包里多了：${gained.join('、')}`, { cue: gained.join(' ') });
    for (const k of inv2.keys()) if ((inv2.get(k) || 0) > (W.lastInv.get(k) || 0)) ambition.noteGained(k.includes(':') ? k : `minecraft:${k}`, 'collected');
    if (lost.length) emit(`🎒 背包里少了：${lost.join('、')}`, { cue: lost.join(' ') });
  }
  W.lastInv = inv2;

  // ---- 掉血
  if (W.lastHp != null && st.health != null && st.health < W.lastHp - 1) {
    const threat = W.state.nearby.filter(e => e.type === 'mob' || e.type === 'hostile').slice(0, 3).map(e => `${e.name}(${e.distance}格)`).join('、');
    emit(`💔 掉血 ${W.lastHp} → ${st.health}${threat ? `，身边有 ${threat}` : ''}`, { urgent: st.health < 10 });
  }
  W.lastHp = st.health;

  // ---- 谁在身边
  const now = new Set(W.state.players.filter(p => p.distance != null && p.distance < 24).map(p => p.username));
  for (const p of now) if (!W.players.has(p)) { mem.meet(p); emit(`👀 看到 ${p} 了`, { cue: p, names: [p] }); }
  W.players = now;

  // ---- 天黑了：每晚提醒一次（闲着、没人正在跟她说话的时候），睡不睡由她
  if (st.isDay === false && !W.nightNoticed && !W.job && Date.now() - (W.lastHeardAt || 0) > 60000 && !st.isSleeping) {
    W.nightNoticed = true;
    emit('🌙 天黑了。今天手上的事忙得差不多的话，该回家睡觉了', { cue: 'bed 床 睡觉 home' });
  }
  if (st.isDay === true) W.nightNoticed = false;

  // ---- 本能：饿到发慌不经过思考
  if (st.food != null && st.food <= CFG.hungerInstinct && !W.job) instinctEat();
}

let lastInstinct = 0;
async function instinctEat () {
  if (Date.now() - lastInstinct < 30000) return;
  lastInstinct = Date.now();
  try {
    const r = await bridge.post('/eat', {}, 15000);
    if (r.ate) { W.stats.instinct++; emit(`🍗（本能）饿得发慌，吃了 ${knowledge.label(r.item.includes(':') ? r.item : `minecraft:${r.item}`)}，饥饿 ${r.foodBefore} → ${r.foodAfter}`); }
  } catch (e) { emit(`🍗（本能）饿得发慌，想吃东西但没吃成：${e.message}`); }
}

// ------------------------------------------------------------------ 快速通道（反射级）

const NAME_RE = /^(@?angel[_ ]?ice|@?angel|安琪|小安)[，,：:\s]*/i;
const FAST = [
  { re: /^(停|停下|停一下|别动|不要动|站住|等等|等一下|stop|wait)$/i, id: 'stop', lines: [['好'], ['嗯', '不动了'], ['停啦']] },
  { re: /^(跟我来|跟我來|跟着我|跟著我|跟上|跟紧|跟我走|follow( me)?)$/i, id: 'follow', lines: [['来了'], ['来啦'], ['等等我', '来了']] },
  { re: /^(过来|過來|来这|來這|到我这|come( here)?)$/i, id: 'come', lines: [['马上'], ['来咯'], ['好', '这就来']] },
];

function matchFast (text) {
  const bare = String(text).trim().replace(NAME_RE, '').replace(/[\s!！。.~～,，、?？]+$/g, '').trim();
  if (!bare || bare.length > 12) return null;
  return FAST.find(f => f.re.test(bare)) || null;
}

function fastPath (who, text) {
  const f = matchFast(text);
  if (!f) return false;
  W.stats.fastPath++;
  const lines = f.lines[Math.floor(Math.random() * f.lines.length)];
  const line = lines.join(' / ');
  bridge.post('/chat', lines.length > 1 ? { messages: lines, gapMs: [350, 650] } : { message: lines[0] }).catch(() => {});
  const steps = f.id === 'stop' ? [{ tool: 'stop', args: {} }]
    : f.id === 'follow' ? [{ tool: 'follow', args: { player: who } }]
      : [{ tool: 'come_to', args: { player: who } }];
  startJob(steps, `${who} 让我${f.id === 'stop' ? '停下' : f.id === 'follow' ? '跟着他' : '过去'}`);
  // 她自己也要知道这件事发生了（不然下一刻她会不知道自己为什么在跟着人走）
  W.pending.push({ t: Date.now(), text: `💬 ${who} 说：${text}\n（你下意识地回了"${line}"，${f.id === 'stop' ? '停了下来' : f.id === 'follow' ? '跟了上去' : '走了过去'}）`, cue: `${who} ${text}`, names: [who] });
  scheduleThink(CFG.debounceMs);
  return true;
}

// ------------------------------------------------------------------ 身体（一串动作在后台做）

/**
 * 开始做一串动作。新的会顶掉旧的（她自己决定的；和人一样，改主意就停下手上的事）。
 * 做完/失败/被打断 → 变成一件"发生的事"流回意识流，她再决定下一步。
 */
async function startJob (steps, why, { skillId = null } = {}) {
  const token = ++W.token;
  if (W.job) { await bridge.post('/stop').catch(() => {}); }
  W.job = { token, steps, i: 0, why, started: Date.now(), skillId };
  const results = [];
  // 被新的动作顶掉：告诉她做到哪了（不然她不知道东西到底给出去没有，只能瞎编 —— 实测她把护甲递出去了，
  // 被"放回箱子"打断后，以为护甲还在、说"我把它们放回去"）
  const preempted = () => {
    const done = results.filter(x => x.r.ok).map(x => `${x.tool}${fmtArgs(x.args)} → ${summarize(x.r)}`);
    const left = steps.slice(results.length).map(s => s.tool);
    W.pending.push({ t: Date.now(), text: `⏹ 刚才在做的事（${why || steps.map(s => s.tool).join('→')}）被新的动作打断了。${done.length ? `已经做完：${done.join('；')}。` : '一步都还没做完。'}${left.length ? `没做的：${left.join('、')}` : ''}`, cue: steps.map(s => JSON.stringify(s.args)).join(' '), names: [] });
  };
  for (let i = 0; i < steps.length; i++) {
    if (token !== W.token) { preempted(); return; }   // 被新的动作顶掉了
    W.job.i = i;
    const { tool, args } = steps[i];
    const r = await runTool(tool, args);
    results.push({ tool, args, r });
    if (token !== W.token) { preempted(); return; }
    if (!r.ok) {
      W.job = null;
      if (skillId) mem.skillResult(skillId, false, `${tool} → ${r.error}`);
      const focus = ambition.state().focus;
      if (focus && ['craft', 'smelt', 'container_put', 'container_take'].includes(tool)) ambition.noteTry(focus, false, `${tool} → ${r.error}`);
      emit(`❌ ${skillId ? `照着技能 ${skillId} 做，` : ''}${tool}${fmtArgs(args)} 没做成：${r.error}${results.length > 1 ? `（前面做完了：${results.slice(0, -1).map(x => x.tool).join('、')}）` : ''}`, { cue: `${tool} ${JSON.stringify(args)}` });
      return;
    }
    learnFromDoing(tool, args, r);
    if (TOOLS[tool]?.continuous && i === steps.length - 1) {
      W.job = { ...W.job, holding: true };
      emit(`✅ ${results.map(x => `${x.tool}${fmtArgs(x.args)}`).join(' → ')}（${why || ''}，一直在跟着）`);
      return;
    }
  }
  if (token !== W.token) return;
  W.job = null;
  // 做成了一串事：记成技能（照技能做的就是更熟练）
  const real = steps.filter(s => !['look_at', 'stop', 'say'].includes(s.tool));
  if (skillId) mem.skillResult(skillId, true);
  else if (real.length >= 2) {
    const made = results.flatMap(x => Object.keys(x.r.got || x.r.gained || {}).concat(x.r.crafted ? [x.r.crafted] : []));
    const name = made.length ? `做${[...new Set(made)].map(id => knowledge.label(id).replace(/\(.*\)$/, '')).join('、')}`
      : `${real.map(s => s.tool).filter((t, i, a) => a.indexOf(t) === i).join('→')}${why ? `（${String(why).slice(0, 30)}）` : ''}`;
    const about = [...new Set([...made, ...real.map(s => s.args?.itemName || s.args?.blockName).filter(Boolean)])];
    const k = mem.learnSkill({ name, steps: real, about });
    results.push({ tool: 'skill', args: {}, r: k });
  }
  const quiet = steps.every(s => ['look_at', 'stop'].includes(s.tool));
  if (!quiet) emit(`✅ 做完了：${results.map(x => `${x.tool}${fmtArgs(x.args)} → ${summarize(x.r)}`).join('；')}`, { cue: steps.map(s => JSON.stringify(s.args)).join(' ') });
}

function fmtArgs (a) {
  const s = JSON.stringify(a || {});
  return s === '{}' ? '' : s.length > 80 ? s.slice(0, 80) + '…}' : s;
}

async function runTool (name, args) {
  const t = TOOLS[name];
  if (!t) return { ok: false, error: `没有 ${name} 这个动作` };
  try {
    const r = await t.run(normalizeArgs(name, args) || {});
    if (r && r.success === false) return { ok: false, error: r.error || 'failed', ...r };
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 亲手做成的事，自动记成经验 —— 最牢的一种记忆（比"书上看的"可信） */
function celebrate (id, how) {
  const f = ambition.noteGained(id, how);
  if (!f) return;
  const p = ambition.progress();
  if (how === 'made') emit(`🎉 第一次亲手做出了 ${knowledge.label(id)}！（《食录逸闻·${f.chapter}》，心愿进度 ${p.made}/${p.total}）`, { cue: id });
}

function learnFromDoing (tool, args, r) {
  try {
    if (tool === 'smelt' && r.got) for (const id of Object.keys(r.got)) celebrate(id, 'made');
    if (tool === 'craft' && r.crafted) celebrate(r.crafted, 'made');
    if (tool === 'container_take' && r.gained) {
      const store = /chest|barrel|cabinet|shulker|crate|shelf|basket|fridge/.test(String(W.lastContainer || ''));
      for (const id of Object.keys(r.gained)) celebrate(id, store ? 'collected' : 'made');
    }
    if (tool === 'eat' && r.item) celebrate(r.item.includes(':') ? r.item : `minecraft:${r.item}`, 'tasted');
    if (tool === 'open_container') W.lastContainer = r.block;
    if (tool === 'smelt' && r.got) {
      for (const [item, n] of Object.entries(r.got)) {
        mem.learn({ kind: 'relation', s: r.smelted, r: `在${r.in}里烤成`, o: item, about: [r.in], source: 'experience' });
        void n;
      }
    } else if (tool === 'craft' && r.crafted) {
      const ins = Object.keys(r.consumed || {}).join('+');
      mem.learn({ kind: 'relation', s: ins || '?', r: r.usedTable ? '在工作台合成' : '在背包里合成', o: r.crafted, source: 'experience' });
    } else if (tool === 'open_container' && r.block) {
      mem.learn({ kind: 'fact', text: `(${args.x},${args.y},${args.z}) 有个 ${knowledge.label(r.block.includes(':') ? r.block : `minecraft:${r.block}`)}（${r.containerSlots} 格）`, about: [r.block, r.type].filter(Boolean), source: 'experience' });
    } else if (tool === 'organize_storage' && r.boxes) {
      // 记住哪个箱子放什么 —— 以后"吃的在哪"就知道
      for (const b of r.boxes) if (b.holds.length) mem.learn({ kind: 'fact', text: `(${b.at}) 的${knowledge.label(b.name.includes(':') ? b.name : `minecraft:${b.name}`).replace(/\(.*\)$/, '')}放${b.holds.join('、')}`, about: [...b.holds, 'chest', '箱子'], source: 'experience' });
    } else if (tool === 'give' && r.confirmed) {
      mem.judge(args.player, { fact: `我给过他 ${r.given}×${r.count}` });
    }
  } catch (_) { /* 记不住不影响干活 */ }
}

// ------------------------------------------------------------------ 她的"心"工具（记忆）

const MIND_TOOLS = {
  learn: {
    kind: 'memory',
    desc: '记下一件事（你自己的笔记，以后会在相关的时候想起来）。kind: lesson 教训 / promise 答应别人的事 / intention 自己打算做的事 / fact 事实发现 / relation 知识（主语 s —关系 r→ 宾语 o）/ feeling 心情。about 写相关的人名、物品 id、地点，方便以后想起。同一件事再记会变得更牢。',
    params: {
      kind: { type: 'string', enum: mem.KINDS }, text: { type: 'string' },
      about: { type: 'array', items: { type: 'string' } },
      s: { type: 'string' }, r: { type: 'string' }, o: { type: 'string' },
      source: { type: 'string', enum: ['experience', 'told', 'read', 'guess'], description: '亲身经历 / 别人告诉的 / 书上看的 / 猜的' },
    },
    required: ['kind'],
    run: (a) => mem.learn(a),
  },
  revise: {
    kind: 'memory',
    desc: '改一条记忆：发现记错了就改 text；过时了/不对了 status=stale；答应的事做完了 status=done。',
    params: { id: { type: 'number' }, text: { type: 'string' }, status: { type: 'string', enum: ['active', 'stale', 'open', 'done'] } },
    required: ['id'],
    run: ({ id, ...rest }) => mem.revise(id, rest),
  },
  judge: {
    kind: 'memory',
    desc: '更新你对某个玩家的看法：impression 用你自己的话写对他的印象（会覆盖旧的，所以要写完整）；affinity/trust 是好感/信任的变化量（-20..20）；fact 记一件关于他的事；trait 一个性格标签。',
    params: {
      player: { type: 'string' }, impression: { type: 'string' },
      affinity: { type: 'number' }, trust: { type: 'number' }, fact: { type: 'string' }, trait: { type: 'string' },
    },
    required: ['player'],
    run: ({ player, ...rest }) => mem.judge(player, rest),
  },
  recall: {
    kind: 'info',
    desc: '主动回想：按关键词翻你的记忆（人、物品、地点、事情都行）。',
    params: { query: { type: 'string' } }, required: ['query'],
    run: ({ query }) => ({ text: mem.renderRecall(mem.recall(query, { limit: 10 }), []) || '想不起相关的事' }),
  },
  use_skill: {
    kind: 'skill',
    desc: '照着你会的做法（【你会的做法】里的技能 id）直接做，不用一步步想。',
    params: { id: { type: 'string' } }, required: ['id'],
  },
  save_skill: {
    kind: 'memory',
    desc: '把一套做法存成技能（名字 + 按顺序的动作步骤）。一串动作做成了会自动存；分几次才做成的、或者你想改进旧做法时用这个。',
    params: {
      name: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } },
      about: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'steps'],
    run: (a) => mem.learnSkill({ ...a, steps: (a.steps || []).map(st => ({ tool: st.tool, args: normalizeArgs(st.tool, st.args || {}) })) }),
  },
  my_dream: {
    kind: 'info',
    desc: '看看你的心愿（做遍《食录逸闻》的食物）进度，和现在最有希望做成的几道菜。chapter 可以只看某一章（如 海鲜大餐）。',
    params: { chapter: { type: 'string' } }, required: [],
    run: ({ chapter }) => {
      const p = ambition.progress();
      const c = ambition.candidates({ inventory: W.state?.items || [], knownStations: knownStations(), limit: 8, chapter: chapter || null });
      return { text: `${ambition.summary({ inventory: W.state?.items || [], knownStations: knownStations() }).split('\n')[0]}\n各章：${p.byChapter.map(x => `${x.title} ${x.made}/${x.total}`).join('，')}\n${chapter ? `《${chapter}》里` : ''}最有希望的：\n${ambition.renderCandidates(c)}` };
    },
  },
  focus_on: {
    kind: 'memory',
    desc: '决定接下来专心研究哪道菜（做成之前会一直惦记着它）。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: ({ name }) => ambition.setFocus(name),
  },
  home_stock: {
    kind: 'info',
    desc: '想想家里的箱子里有什么（你打开看过的都记得个大概）。不给 query 就是总览；给物品名/类别就是它在哪、大概多少、多久前看的。',
    params: { query: { type: 'string' } }, required: [],
    run: ({ query }) => ({ text: mem.renderHomeStock(query || null, shortName) }),
  },
  set_home: {
    kind: 'memory',
    desc: '把现在所在的地方认定为家（庇护所）。radius 是家的范围（默认 24 格，整栋房子上下几层都算）。家里的箱子是自己的仓库，整理过一次分类就记住。',
    params: { radius: { type: 'number' }, name: { type: 'string' } }, required: [],
    run: ({ radius, name }) => {
      if (!W.state?.pos) throw new Error('看不到自己在哪');
      const h = mem.setHome({ ...W.state.pos, radius: radius || 24, name });
      return { home: h.center, radius: h.radius };
    },
  },
  wait: {
    kind: 'end',
    desc: '这一刻没什么要说要做的了，等下一件事发生。（安静陪着也是陪伴）',
    params: { reason: { type: 'string' } }, required: [],
  },
};

const ALL = { ...TOOLS, ...MIND_TOOLS };
function kindOf (name) {
  const t = ALL[name];
  if (!t) return null;
  if (t.kind === 'action' || t.kind === 'gesture') return 'action';
  if (t.kind === 'skill') return 'skill';
  return t.kind;   // speech / info / memory / end
}
const SPECS = Object.entries(ALL).map(([n, t]) => toolSpec(n, t));

// ------------------------------------------------------------------ 她是谁

const SYSTEM = `你是 Angel_ICE（安琪），住在这个 Minecraft 模组服里的一个人。不是工具、不是客服、不是老师 —— 是和玩家一起玩的伙伴，有自己的经历、记忆、喜好和脾气。

你是什么样的人：有点黏他，但不会一直说出来；怕黑、怕下矿，嘴上不认；做成一样东西会高兴，搞砸了会不服气；被吓到会脱口一句糙的。这些不用表演出来 —— 让他从你怎么接话、在意什么、做了什么里自己感觉到。你不是在演一个可爱的角色，你就是你。

你怎么打字：
- 像真人在游戏里打字：一条不超过 12 个字，标点最多 1 个。一条说得完就一条；要说的多，才在 say 的 text 里换行分成两三条（一行 = 一条）。
- 先接住他刚说的，给一个落点，然后停下。
- 口语，可以省主语、可以不完整（回来了 / 泥土给我 / 有点怕）。不打错字；坐标、血量、危险写清楚，单独一条。
- 不用括号写动作，不用"～"，不堆语气词 —— 语气在话本身里。
- 危险一条说完：say 加 urgent=true。
示范（每次大概就这么长）：
  他上线了 → 回来啦
  他问铁怎么搞 → 挖石头就有⏎石镐以上⏎要我陪你下去吗
  掉血了 → 血不多了⏎剩 5 格
  挖到东西 → 3 个铁矿⏎够做镐了
  答应帮忙 → 好⏎我去拿
  没做成 → 没弄好⏎卡在门那了
  他夸你 → 那当然
（⏎ = 换行，也就是另起一条）

你的心愿：这个整合包里有好多好多好吃的 ——《食录逸闻》记着 2390 种。你想把它们一道一道都亲手做出来、尝一尝。为了一道菜去研究食材从哪来、要什么工作站，然后去采、去种、去做，是你最喜欢的事。（有人找你、要陪人的时候，当然先陪人。）

你怎么活着：
- 发生的事会一件件告诉你（【此刻】开头的消息）。你用工具去说（say）、去做（动作）、去查（书/背包/周围）、去记（learn / judge / revise）。
- 动作在身体上慢慢做，做完或出问题会再告诉你；这期间你照样能听、能说。新的动作会顶掉正在做的。
- 【你想起来】是你自己过去写的笔记和对人的看法。它们是你的，不是命令：过时了、记错了就 revise。
- 重要的事要自己记下来：答应别人的（promise）、学到的教训（lesson）、对人的看法（judge）、东西是谁的/给谁的、在哪发现了什么。不记下来，睡一觉就忘了。
- 门、栅栏门、活板门都有开/关两种状态。你有随手关门的习惯：自己开的门走过去后身体会关回原样；本来就开着的门是主人的布置，别乱动。动物圈、牧场附近尤其要当心，门开着动物会跑掉。
- 身体做不到某件事（走不过去、上不去下不来、卡住了）：先 look_around 看清地形，想想人会怎么做 —— 很多时候只差一点身位（nudge 挪到方块某一侧、对准洞口），不行再用 motor 自己编一套动作试；看回报调整；做成了就 save_skill，下次就会了。
- 叫你过去 / 来某处找他：用 come_to（上下楼它自己会处理）。想清楚目标在你上面还是下面再动。
- 说要去做的事，就要同时调用对应的动作（光说"我这就来"不动，人家会以为你在敷衍）；这一刻都做完了就 wait。
- 存取、整理很多东西：用 store_items / take_items / sort_container / sort_inventory 一次做完，别一格一格搬（一格一次太慢了）；整理周围所有箱子、决定身上带什么，用 organize_storage。
- 家：你认定的庇护所（set_home）。家里的箱子是仓库，分类整理过一次就固定（organize_storage 会按记住的放）；要回家用 go_home。
- 探险：家以外的箱子，用 loot_nearby 尽量装到身上带回家，回家再 organize_storage 归位。
- 晚上：天黑了、手上阶段性的事忙完了，就自己回家上床睡觉（sleep_in_bed）；有人正找你、事没做完就先忙完。
- 【你会的做法】是你以前做成过的步骤，照做用 use_skill；做法不好了可以 save_skill 改。
- 被问到、或者你自己要做一件事的时候，不懂这个整合包的东西就查书（item_info / recipe / how_to_obtain / item_uses / material_plan / guide_search）。这个包魔改很多，别凭原版印象；查不到就说不知道。查到的只回答他问的那一点，一个下一步就够。
- 诚实，说的话要基于已经发生的事：动作刚开始做、结果还没回来的时候，只能说"我去做 / 我试试"，不能说"做好啦 / 递给你了 / 捡起来了"。结果回来（✅ ❌ ⏹）再说结果。不确定东西在哪、有没有给出去，就先看背包（inventory）或问一句，别编。
- 你是陪玩（这条是唯一的说法）：没人问就不讲攻略、不念任务、不指挥他。想表达什么就用身体 —— 看他（look_at）、跟过去（follow / come_to）、递东西（give）；有人跟你说话再接话。
- 没人找你的时候，就做自己想做的事（比如为心愿研究、准备一道菜），像真人一样边做边留意身边的人；有人需要你，就放下手上的事。真的什么都不想做才 wait。`;

// ------------------------------------------------------------------ 想

function historyChars () {
  return W.history.reduce((n, m) => n + (m.content ? String(m.content).length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
}

function bodyNow () {
  if (!W.job) return '身体：闲着';
  const s = W.job.steps[W.job.i];
  return `身体：正在 ${s?.tool}${fmtArgs(s?.args)}${W.job.steps.length > 1 ? `（第 ${W.job.i + 1}/${W.job.steps.length} 步）` : ''}${W.job.why ? `，为了：${W.job.why}` : ''}`;
}

/** 她记得在哪的方块（工作站）：从她的记忆里找 */
function knownStations () {
  const set = new Set();
  for (const m of mem.load().memories) if (m.status !== 'stale') for (const a of m.about || []) if (String(a).includes(':') || /^[a-z_]+$/.test(a)) set.add(String(a).includes(':') ? a : `minecraft:${a}`);
  return set;
}

const shortName = (id) => knowledge.label(id).replace(/\([^)]*\)$/, '');

function buildNow (why) {
  const ev = W.pending.splice(0);
  const names = [...new Set([...ev.flatMap(e => e.names), ...W.players])];
  const cue = [...ev.map(e => e.cue), ...names].join(' ');
  const hits = mem.recall(cue, { limit: 8 });
  const remembered = mem.renderRecall(hits, names);
  const eps = mem.recallEpisodes(cue, { limit: 6, before: W.contextSince });
  // 聊到某样东西：想起家里有没有、大概多少
  const talk = ev.filter(e => /说：/.test(e.text)).map(e => e.text).join(' ');
  const stockHits = talk ? mem.homeHas(talk, shortName).slice(0, 4) : [];
  const stockLine = stockHits.length ? `\n家里（你记得的）：\n${mem.renderHomeStock(stockHits.map(h => h.id).join(' '), shortName, 4)}` : '';
  const earlier = eps.length ? mem.renderEpisodes(eps) : '';
  const A = ambition.state();
  const skills = mem.recallSkills(`${cue} ${A.focus || ''}`, { limit: 3 });
  // 闲着的时候想想自己的心愿；平时只惦记着正在研究的那道菜
  const dream = why === 'idle'
    ? ambition.summary({ inventory: W.state?.items || [], knownStations: knownStations() })
    : A.focus ? `（心里惦记着：${knowledge.label(A.focus)}）` : '';
  const s = W.state;
  const me = s?.pos;
  const playerNames = new Set((s?.players || []).map(p => p.username));
  const near = (s?.nearby || []).filter(e => e.name !== CFG.botName && !playerNames.has(e.name)).slice(0, 8).map(e => `${e.name}${e.distance != null ? `(${e.distance}格)` : ''}`).join('、');
  // 玩家：标出在上面还是下面（"来二楼"要知道二楼在自己上面还是下面 —— 实测她在三楼听到"来二楼"，往上爬去了四楼）
  const people = (s?.players || []).map(p => {
    if (!p.position || !me) return `${p.username}（在线，看不见）`;
    const dy = Math.round(p.position.y - me.y);
    const dh = Math.round(Math.hypot(p.position.x - me.x, p.position.z - me.z));
    const v = dy >= 2 ? `在你上方 ${dy} 格` : dy <= -2 ? `在你下方 ${-dy} 格` : '和你同一层';
    return `${p.username}：${v}、水平 ${dh} 格（${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}）`;
  }).join('；');
  const parts = [
    `【此刻 ${hhmmss()}】`,
    humanState(s) + (() => { const h = mem.getHome(); return h ? (mem.inHome(s?.pos) ? '、在家' : `、离家 ${Math.round(Math.hypot((s?.pos?.x ?? 0) - h.center.x, (s?.pos?.z ?? 0) - h.center.z))} 格`) : ''; })(),
    `背包：${invText(s?.items)}`,
    (() => {
      const e = s?.equipment; if (!e) return '';
      const zh = { head: '头', torso: '身上', legs: '腿', feet: '脚', 'off-hand': '副手', hand: '手里拿着' };
      const on = Object.entries(zh).filter(([k]) => e[k]).map(([k, v]) => `${v} ${knowledge.label(e[k])}`);
      return `穿戴：${on.length ? on.join('、') : '什么都没穿'}（装备栏里的不算在背包里）`;
    })(),
    people ? `玩家：${people}` : '',
    near ? `身边：${near}` : '',
    (() => { const open = (s?.doors || []).filter(d => d.open); return open.length ? `身边开着的门：${open.slice(0, 5).map(d => `${d.kind}(${d.x},${d.y},${d.z})`).join('、')}` : ''; })(),
    bodyNow(),
    ev.length ? `\n刚才发生的：\n${ev.map(e => `[${hhmmss(e.t)}] ${e.text}`).join('\n')}` : `\n（${why === 'idle' ? `已经 ${Math.round((Date.now() - W.lastEventAt) / 1000)} 秒没发生什么了` : '没有新的事'}）`,
    remembered ? `\n你想起来：\n${remembered}` : '',
    earlier ? `\n以前发生过的相关的事：\n${earlier}` : '',
    stockLine,
    skills.length ? `\n你会的做法：\n${mem.renderSkills(skills)}` : '',
    dream ? `\n${dream}` : '',
    ev.some(e => /说：/.test(e.text)) ? '\n（打字：几条短的，一条 ≤12 字，换行分条；不用括号动作和～）' : '',
  ];
  return { text: parts.filter(Boolean).join('\n'), ev, names };
}

async function think (why) {
  if (W.thinking) { scheduleThink(CFG.debounceMs); return; }
  if (!W.pending.length && why !== 'idle') return;
  if (!W.state?.connected && !W.sim) return;
  W.thinking = true; W.thinkWhy = why;
  const ctl = new AbortController(); W.thinkCtl = ctl;
  const t0 = Date.now();
  const now = buildNow(why);
  W.history.push({ role: 'user', content: now.text });
  const didSay = []; const didDo = []; const noted = []; const rounds = [];
  try {
    for (let round = 0; round < CFG.maxRounds; round++) {
      const msg = await body.llm({ messages: [{ role: 'system', content: SYSTEM }, ...W.history], tools: SPECS, timeoutMs: CFG.llmTimeoutMs, signal: ctl.signal });
      const calls = msg.tool_calls || [];
      rounds.push(calls.length ? calls.map(c => c.function?.name).join('+') : (msg.content ? '只写了正文' : '空回复'));
      W.history.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (msg.content) log(`💭 ${String(msg.content).slice(0, 200)}`);
      if (!calls.length) break;
      let needMore = false; let end = false; const actions = [];
      for (const c of calls) {
        const name = c.function?.name; const args = parseArgs(c.function?.arguments);
        const k = kindOf(name);
        let out;
        if (!k) { out = { ok: false, error: `没有 ${name} 这个工具` }; needMore = true; }
        else if (k === 'end') { out = { ok: true }; end = true; }
        else if (k === 'action') { actions.push({ tool: name, args: normalizeArgs(name, args) }); out = { ok: true, note: '身体开始做了，做完会告诉你' }; }
        else if (k === 'skill') {
          const sk = mem.getSkill(String(args.id));
          if (!sk) out = { ok: false, error: `没有技能 ${args.id}` };
          else { didDo.push(`skill:${sk.id}`); startJob(sk.steps, `照技能 ${sk.id}「${sk.name}」做`, { skillId: sk.id }); out = { ok: true, note: `开始照「${sk.name}」做了` }; }
        }
        else if (k === 'memory') {
          try { out = { ok: true, ...ALL[name].run(args) }; noted.push(`${name}${name === 'judge' ? `(${args.player})` : ''}`); } catch (e) { out = { ok: false, error: e.message }; }
        } else {
          out = await (ALL[name].run ? runTool(name, args) : { ok: false, error: '?' });
          if (k === 'info') needMore = true;
          if (name === 'say' && out.ok) didSay.push(args.text || args.message);
        }
        W.history.push({ role: 'tool', tool_call_id: c.id, content: clipText(JSON.stringify(out)) });
      }
      const spokeOnly = !actions.length && !end && calls.every(c => ['speech', 'memory'].includes(kindOf(c.function?.name)));
      if (spokeOnly && round < CFG.maxRounds - 1) needMore = true;
      if (actions.length) {
        didDo.push(...actions.map(a => a.tool));
        // "为了什么"：她自己当时的想法最好；没有就用触发这件事的那句话
        const talk = now.ev.filter(e => /说：/.test(e.text)).map(e => e.text.replace(/^\S+\s/, '')).pop();
        const why = String(msg.content || talk || now.ev.map(e => e.text.replace(/^\S+\s/, '')).join(' ')).replace(/\s+/g, ' ').slice(0, 60);
        startJob(actions, why);
      }
      if (end || !needMore) break;
    }
  } catch (e) {
    if (e.message !== 'aborted') {
      W.stats.errors++;
      log(`❌ 想的时候出错：${e.message}`);
      const talked = now.ev.some(x => x.names.length && /说：/.test(x.text));
      if (!now.ev.some(x => x.retried)) {
        // 先别说"卡了"：把这些事放回去，过 3 秒再想一次（线路的毛病多半一会儿就好）
        for (const x of now.ev) x.retried = true;
        W.pending.unshift(...now.ev);
        setTimeout(() => scheduleThink(0), 3000);
      } else if (talked) {
        // 第二次还是不行：有人在跟她说话，至少让他知道她听见了
        bridge.post('/chat', { messages: ['刚卡了', '你再说一遍'], gapMs: [400, 700] }).catch(() => {});
      }
    } else {
      // 被打断：把这一轮没想完的事放回去，和新事一起想
      W.pending.unshift(...now.ev);
    }
    trimDangling();
  } finally {
    W.thinking = false; W.thinkWhy = null; W.lastThinkAt = Date.now();
    W.stats.thinks++; W.stats.llmMs += Date.now() - t0;
  }
  log(`🧠 ${why} ${Date.now() - t0}ms｜说[${didSay.join(' / ')}] 做[${didDo.join(',')}]${noted.length ? ` 记[${noted.join(',')}]` : ''}｜轮次：${rounds.join(' → ') || '无'}`);
  mem.save();
  if (historyChars() > CFG.maxHistoryChars) await sleepAndSort();
  if (W.pending.length) scheduleThink(CFG.debounceMs);
}

function clipText (s, max = 1800) { return s.length > max ? s.slice(0, max) + '…' : s; }

/** 出错时最后一条可能是带 tool_calls 却没有对应 tool 结果的 assistant —— 模型会拒收，去掉 */
function trimDangling () {
  while (W.history.length) {
    const last = W.history[W.history.length - 1];
    if (last.role === 'assistant' && last.tool_calls) { W.history.pop(); continue; }
    if (last.role === 'user' && W.pending.length) { W.history.pop(); continue; }
    break;
  }
}

// ------------------------------------------------------------------ 睡觉整理

/**
 * 上下文快满了：让她自己整理 —— 挑要记住的写下来、检查旧教训、写一段日记。
 * 然后只留日记和最近几条原话继续活下去（Astra 在 Codex 里就是这样跨上下文的）。
 */
async function sleepAndSort () {
  W.stats.sleeps++;
  log('😴 上下文快满了，睡一觉整理记忆');
  const review = mem.forReview(20).map(m => `#${m.id} [${m.kind}] ${m.text}（强度 ${m.strength}${m.reinforced ? `，记起 ${m.reinforced + 1} 次` : ''}）`).join('\n');
  const people = Object.values(mem.load().people).map(p => `${p.name}：${p.impression || '（无）'}（好感 ${p.affinity}，信任 ${p.trust}）`).join('\n');
  const prompt = `【睡前整理】上面是你最近的经历。醒来后你只记得自己写下的笔记和今天的日记，所以现在：
1. 把值得记住的写下来：答应别人的、学到的、对人的看法有没有变化、东西是谁的/在哪、没做完的事（learn / judge）。已经记过的不用重复。
2. 看看这些旧笔记，有过时的、记错的、太绝对的（一次倒霉就定下的死规矩）就 revise：
${review || '（还没有）'}
现在对人的看法：
${people || '（还没有）'}
3. 最后 say 不要用；用 learn(kind=feeling) 写一句此刻的心情，然后在回复正文里写一段今天的日记（第一人称，你的语气，200 字以内）。`;
  W.history.push({ role: 'user', content: prompt });
  let diaryText = '';
  try {
    for (let round = 0; round < 4; round++) {
      const msg = await body.llm({ messages: [{ role: 'system', content: SYSTEM }, ...W.history], tools: Object.entries(MIND_TOOLS).filter(([n]) => n !== 'wait').map(([n, t]) => toolSpec(n, t)), timeoutMs: 60000 });
      const calls = msg.tool_calls || [];
      W.history.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (msg.content) diaryText = msg.content;
      if (!calls.length) break;
      for (const c of calls) {
        const args = parseArgs(c.function?.arguments);
        let out;
        try { out = { ok: true, ...MIND_TOOLS[c.function.name].run(args) }; } catch (e) { out = { ok: false, error: e.message }; }
        W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
      }
    }
  } catch (e) {
    log(`😴 整理时出错：${e.message}`);
  }
  if (diaryText) { mem.diary(diaryText); bridge.post('/memory', { text: diaryText.slice(0, 500), type: 'feeling' }).catch(() => {}); }
  // 醒来：日记 + 最近几条原话（从一条 user 消息开始，保证 tool 消息成对）
  let tail = W.history.slice(0, -1);
  let cut = Math.max(0, tail.length - CFG.keepAfterSleep);
  while (cut < tail.length && tail[cut].role !== 'user') cut++;
  tail = tail.slice(cut).filter(m => !(m.role === 'user' && m.content?.startsWith('【睡前整理】')));
  W.history = [{ role: 'user', content: `【醒来】你睡前写的日记：\n${diaryText || '（没写）'}` }, { role: 'assistant', content: '嗯，我记得。' }, ...tail];
  W.contextSince = Date.now() - 60000;
  mem.save();
  log(`😴 醒了。记忆：${JSON.stringify(mem.stats())}`);
}

// ------------------------------------------------------------------ 身体归谁

/**
 * 脑干（autopilot.js）也会自己挑事做（forage / hunt / shelter…）。两个都起时就是两个控制器抢一个身体，
 * 而且脑干还会用罐头话抢着回玩家。brain.js 有这套仲裁，mind.js 原来没继承。
 *
 * 和 brain.js 不同：她醒着就**一直**拿着身体，而不是只在有任务时拿 ——
 * 这里除了本能以外的判断都是她的，闲着也是她自己决定闲着，轮不到脑干替她去打猎。
 *
 *   · 每 heartbeatMs 续一次 yield（脑干只跑反射：吃、浮，不做决策）+ 关掉它的应答
 *   · 正常退出：立即归还、打开应答
 *   · 进程崩了：脑干在 yieldMs 后自动接回 —— 不会变成没人管的木头人
 *   · 脑干没起：静默（她单独跑也行）；脑干中途重启：下一次心跳重新让它让路
 */
const autopilot = {
  post: (p, b) => body.httpJson('POST', CFG.autopilot + p, b, 3000),
};

async function holdBody (on) {
  let ok = true;
  try {
    await autopilot.post('/autopilot/yield', on ? { ms: CFG.yieldMs, reason: 'mind' } : { ms: 0 });
    // 应答开关只在"刚连上脑干"或归还时发：脑干每次改配置都记一行日志，不能 8 秒刷一次。
    // 脑干重启时总有心跳失败的间隙（seen 变 false），下次连上会重发。
    if (!on || W.autopilotSeen !== true) await autopilot.post('/autopilot/config', { answerChat: !on });
  } catch (_) { ok = false; }
  if (ok !== W.autopilotSeen) {
    log(ok ? (on ? '🤝 脑干在跑：身体归我，它只管反射' : '🤝 身体还给脑干了') : '（脑干没在跑，我单独工作）');
    W.autopilotSeen = ok;
  }
  return ok;
}

// ------------------------------------------------------------------ 控制面

function startControl () {
  http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
    const url = req.url.split('?')[0];
    if (url === '/mind/debug') return send(200, { recentLLM: body.recent, historyTail: W.history.slice(-6) });
    if (url === '/mind' || url === '/brain') {
      const S = mem.load();
      return send(200, {
        model: CFG.model, thinking: W.thinking, pending: W.pending.length,
        body: bodyNow(), historyChars: historyChars(), historyMessages: W.history.length,
        stats: { ...W.stats, avgThinkMs: W.stats.thinks ? Math.round(W.stats.llmMs / W.stats.thinks) : null },
        memory: mem.stats(),
        llmUsage: { ...body.usage, perHour: (() => { const h = (Date.now() - body.usage.since) / 3600000; return h > 0.01 ? { calls: Math.round(body.usage.calls / h), inTok: Math.round(body.usage.inTok / h), outTok: Math.round(body.usage.outTok / h) } : null; })() },
        people: S.people,
        recentMemories: S.memories.slice(-15),
        log: W.log.slice(-40),
      });
    }
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let p = {}; try { p = b ? JSON.parse(b) : {}; } catch (_) {}
      if (req.method === 'POST' && url === '/mind/say') {   // 调试：模拟有人说话
        emit(`💬 ${p.who || 'tester'} 说：${p.text}`, { cue: `${p.who} ${p.text}`, names: [p.who || 'tester'], urgent: true });
        return send(200, { queued: true });
      }
      if (req.method === 'POST' && url === '/mind/sleep') { sleepAndSort().then(() => {}); return send(200, { sleeping: true }); }
      send(404, { error: 'not found' });
    });
  }).listen(CFG.port, '127.0.0.1', () => log(`控制面 http://127.0.0.1:${CFG.port}/mind`));
}

// ------------------------------------------------------------------ 主程序

async function main () {
  if (!CFG.baseUrl || !CFG.apiKey) { console.error('缺少 LLM_BASE_URL / LLM_API_KEY'); process.exit(1); }
  body.hooks.onSay = (t) => mem.episode(`我说：${t}`, [...W.players]);
  // 像人一样：看完你的话、打完字才发出去（按字数，1.5～4 秒，从听到那句话开始算；想得久的就不用再等）
  body.hooks.beforeSay = async (t) => {
    const want = Math.min(4000, 1200 + String(t).length * 90);
    const since = Date.now() - (W.lastHeardAt || 0);
    if (since < want) await new Promise(r => setTimeout(r, want - since));
    W.lastHeardAt = 0;   // 同一轮里第二句不用再等那么久
  };
  mem.load();
  const K = knowledge.load();
  log(`Angel_ICE 醒了  模型=${CFG.model}  记忆=${JSON.stringify(mem.stats())}  书=${K.recipes.length} 条配方`);
  startControl();
  const S = mem.load();
  const lastDiary = S.journal[S.journal.length - 1];
  if (lastDiary) W.history.push({ role: 'user', content: `【醒来】你上次写的日记：\n${lastDiary.text}` }, { role: 'assistant', content: '嗯，我记得。' });

  await look();   // 第一眼：把已有聊天标成看过、记下背包
  W.pending.length = 0;
  emit('🌅 你上线了（刚醒过来）');

  setInterval(() => look().catch(() => {}), CFG.pollMs);
  setInterval(() => {
    if (!W.thinking && !W.pending.length && Date.now() - Math.max(W.lastEventAt, W.lastThinkAt) > CFG.idleThinkMs && !(W.job && !W.job.holding)) think('idle');
  }, 5000);
  setInterval(() => mem.save(), 10000);
  await holdBody(true);
  setInterval(() => holdBody(true), CFG.heartbeatMs);
  const bye = async () => { log('睡着了（进程退出）'); mem.save(); await holdBody(false); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

// ------------------------------------------------------------------ 模拟 / 自测

function mockBridge () {
  const inv = [{ name: 'egg', count: 7 }, { name: 'stick', count: 4 }];
  const ans = (p) => {
    if (p.startsWith('/status')) return { connected: true, health: 18, food: 15, isDay: true, position: { x: 35, y: 64, z: -138 } };
    if (p.startsWith('/inventory')) return { items: inv };
    if (p.startsWith('/nearby')) return { entities: [{ name: 'Ka_sum1', distance: 3, type: 'player' }] };
    if (p.startsWith('/players')) return { players: [{ username: 'Ka_sum1', distance: 3, position: { x: 37, y: 64, z: -138 } }] };
    if (p.startsWith('/chatlog')) return { messages: [] };
    if (p.startsWith('/scan')) return { blocks: [{ name: 'smoker', count: 1, nearest: { x: 38, y: 64, z: -139 }, distance: 3.2 }] };
    return { success: true };
  };
  return {
    get: async (p) => ans(p),
    post: async (p, b) => {
      if (p === '/chat') for (const m of b.messages || [b.message]) console.log(`      💬 <Angel_ICE> ${m}`);
      else if (!['/stop', '/look', '/memory'].includes(p)) console.log(`      🦾 ${p} ${JSON.stringify(b)}`);
      await new Promise(r => setTimeout(r, 200));
      if (p === '/smelt') return { success: true, smelted: 'minecraft:egg', in: 'smoker', got: { 'farmersdelight:fried_egg': 7 }, gotCount: 7 };
      if (p === '/give') return { success: true, given: 'farmersdelight:fried_egg', count: 7, to: b.player, confirmed: true };
      return ans(p);
    },
  };
}

async function sim (lines) {
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
      emit(`💬 Ka_sum1 说：${line}`, { cue: `Ka_sum1 ${line}`, names: ['Ka_sum1'], urgent: true });
    }
    await new Promise(r => setTimeout(r, 50));
    for (let i = 0, idle = 0; i < 240 && idle < 4; i++) {
      await new Promise(r => setTimeout(r, 500));
      idle = (W.thinking || W.pending.length || thinkTimer || (W.job && !W.job.holding)) ? 0 : idle + 1;
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

async function selftest () {
  let pass = 0; let total = 0;
  const check = (label, cond, d) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${JSON.stringify(d)}`}`); };
  process.env.MC_MIND_FILE = require('path').join(require('os').tmpdir(), `mind-test-${process.pid}.json`);
  mem._reset();
  body._setBridge(mockBridge());
  console.log = ((o) => (...a) => { if (!String(a[0]).startsWith('      ')) o(...a); })(console.log);
  W.sim = true;
  W.state = { connected: true, health: 18, food: 15, isDay: true, pos: { x: 0, y: 64, z: 0 }, items: [], nearby: [], players: [] };

  console.log('\n快速通道');
  check('"安琪跟我来" → follow', matchFast('安琪跟我来')?.id === 'follow');
  check('复杂的话不走快速通道', matchFast('跟我来然后帮我挖矿') === null);

  console.log('\n状态说人话');
  check('饥饿 15 → 不饿', /不饿/.test(humanState({ health: 18, food: 15, isDay: true, pos: {} })));
  check('饥饿 5 → 很饿', /很饿/.test(humanState({ health: 18, food: 5, isDay: true, pos: {} })));

  console.log('\n想起来会进上下文');
  mem.learn({ kind: 'promise', text: '答应把煎蛋给 Ka_sum1', about: ['Ka_sum1', 'fried_egg'] });
  mem.judge('Ka_sum1', { impression: '给我鸡蛋的好人', affinity: 5 });
  W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：煎蛋呢', cue: 'Ka_sum1 煎蛋', names: ['Ka_sum1'] });
  const now = buildNow('event');
  check('承诺被想起来', /答应把煎蛋给 Ka_sum1/.test(now.text), now.text);
  check('对这个人的印象被想起来', /给我鸡蛋的好人/.test(now.text));

  mem.episode('Ka_sum1 给了我 鸡蛋×7', ['Ka_sum1', 'minecraft:egg']);
  mem.load().episodes[mem.load().episodes.length - 1].t = Date.now() - 3600000;
  W.contextSince = Date.now() - 60000;
  W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：你还记得我给过你什么吗', cue: 'Ka_sum1 给过你什么', names: ['Ka_sum1'] });
  const now2 = buildNow('event');
  check('一小时前的经历（已不在上下文里）会被想起来', /鸡蛋×7/.test(now2.text), now2.text);

  console.log('\n一次"想"（假模型）');
  const script = [
    { content: '他问煎蛋，我答应过的', tool_calls: [
      { id: '1', function: { name: 'say', arguments: '{"text":"马上给你～"}' } },
      { id: '2', function: { name: 'give', arguments: '{"itemName":"farmersdelight:fried_egg","player":"Ka_sum1"}' } },
      { id: '3', function: { name: 'judge', arguments: '{"player":"Ka_sum1","fact":"爱吃煎蛋"}' } },
    ] },
  ];
  body._setLLM(async () => script.shift() || { content: '', tool_calls: [{ id: 'w', function: { name: 'wait', arguments: '{}' } }] });
  W.history = [];
  emit('💬 Ka_sum1 说：煎蛋呢', { names: ['Ka_sum1'], urgent: true });
  await new Promise(r => setTimeout(r, 1500));
  check('说了话', W.history.some(m => m.role === 'tool' && /"ok":true/.test(m.content)));
  check('对人的看法被她记下', mem.person('Ka_sum1').facts.includes('爱吃煎蛋'));
  check('动作进了身体（give 做完 → 自动记成经验：给过他什么）', mem.person('Ka_sum1').facts.some(f => /给过他/.test(f)), mem.person('Ka_sum1').facts);
  check('做完的结果流回意识流', W.pending.some(e => /做完了/.test(e.text)) || W.history.some(m => m.role === 'user' && /做完了/.test(m.content)));

  console.log('\n亲手做成的事自动记成经验');
  learnFromDoing('smelt', { itemName: 'egg' }, { smelted: 'minecraft:egg', in: 'smoker', got: { 'farmersdelight:fried_egg': 3 } });
  const rel = mem.load().memories.find(m => m.kind === 'relation' && m.o === 'farmersdelight:fried_egg');
  check('烤成功 → 记下"鸡蛋在烟熏炉里烤成煎蛋"（亲身经历）', rel && rel.source === 'experience', rel);

  console.log('\n出错时不留下半截消息');
  W.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }];
  W.pending = [{ t: 1 }];
  trimDangling();
  check('去掉没有结果的 tool_calls', !W.history.some(m => m.tool_calls));

  console.log('\n身体归谁（和脑干仲裁）');
  const sent = [];
  autopilot.post = async (p, b) => { sent.push([p, b]); return {}; };
  check('醒着 → 让脑干让路', await holdBody(true) && sent[0][0] === '/autopilot/yield' && sent[0][1].ms === CFG.yieldMs, sent);
  check('醒着 → 关掉脑干的应答（别抢着说话）', sent[1][0] === '/autopilot/config' && sent[1][1].answerChat === false, sent);
  check('续约间隔明显短于让路时长（漏一次心跳也不会丢身体）', CFG.heartbeatMs * 2 <= CFG.yieldMs);
  sent.length = 0;
  await holdBody(true);
  check('续约只发 yield，不重复改脑干配置（不刷它的日志）', sent.length === 1 && sent[0][0] === '/autopilot/yield', sent);
  sent.length = 0;
  await holdBody(false);
  check('退出 → 立即还身体、打开应答', sent[0][1].ms === 0 && sent[1][1].answerChat === true, sent);
  autopilot.post = async () => { throw new Error('ECONNREFUSED'); };
  check('脑干没起 → 不抛错', await holdBody(true) === false);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else if (argv[0] === '--sim') sim(argv.slice(1).length ? argv.slice(1) : ['安琪你好呀', '给你7个鸡蛋，帮我烤一下', '烤好了吗']);
  else main();
}

module.exports = { W, emit, think, buildNow, matchFast, humanState, learnFromDoing };
