#!/usr/bin/env node
'use strict';

/**
 * Angel_ICE 的大脑 —— 听懂人话、马上反应、自己想下一步。
 *
 * ## 为什么需要这个文件
 *
 * `autopilot.js` 是脑干：反射 + 优先级表。它**听不懂人话**（玩家的话只进 `pendingQuestions`，
 * 最多回一句罐头"诶？我在呀～"），也**不会规划**（决策 = 从菜单里挑 priority 最大的）。
 * 于是玩家的两个直观感受：①反应迟钝 ②智商低。本文件补的就是这两块。
 *
 * ## 分层（借鉴 PIANO 的"并行模块 + 认知控制器"、Astra+Jev 的"慢规划 + 快控制"）
 *
 *   层            谁                         速度        负责
 *   ─────────────────────────────────────────────────────────────────────
 *   反射          autopilot.js / reflex.js    毫秒        吃、浮、躲 —— 不经过这里
 *   快速通道      本文件 FAST_PATH（纯规则）   0ms        "停" "跟我来" "过来"
 *   快脑          BRAIN_FAST_MODEL            ~3s        听懂 → 回话 + 行动（一次调用）
 *   主脑          BRAIN_PLAN_MODEL            背景        定目标、拆步骤、失败重规划
 *   仲裁          本文件 takeBody()（纯程式）  即时        身体归谁：玩家 > 自主计划 > 脑干
 *
 * ⚠️ 主脑**不审批**每个动作 —— 那样每步多一次 LLM 往返，只会更慢。
 *    主脑只管"接下来做什么"，身体归谁由程式决定，不靠 AI 投票。
 *
 * ## 说与做一致（PIANO 的核心问题）
 *
 * 两个脑读同一份共享状态 `M`（身体在干什么、当前计划、最近的动作结果、最近对话），
 * 所以快脑说"我在给你做木镐呢"时，主脑的计划里真的有木镐。
 *
 * ## 与 autopilot 的关系
 *
 * 不替换它。大脑拿到身体时 `POST /autopilot/yield` 让脑干暂停决策（反射照跑），
 * 每 `heartbeatMs` 续一次；大脑进程挂了，脑干在 `yieldMs` 后自动接回身体。
 * autopilot 没起也能单独跑（yield 失败静默）。
 *
 * ## 运行
 *
 *     node brain.js                 # 正式运行（需先起 bridge-server.js，autopilot 可选）
 *     node brain.js --selftest      # 纯逻辑自测（不连网、不调模型）
 *     node brain.js --sim "安琪跟我来" "帮我做个木镐"
 *                                   # 用假身体 + 真模型跑一遍，看她会说什么、做什么、多快
 *
 * ## 配置（环境变量，或项目根目录 .env）
 *
 *     LLM_BASE_URL       OpenAI 兼容端点（…/v1）
 *     LLM_API_KEY
 *     BRAIN_FAST_MODEL   默认 gemini-3.8-flash
 *     BRAIN_PLAN_MODEL   默认 opus5.5
 *     BRAIN_AUTONOMY     false = 不自己找事做，只听指令
 *     BRAIN_PORT         控制面端口，默认 3003
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const knowledge = require('./knowledge');

// ------------------------------------------------------------------ .env

// 不引 dotenv：一个 20 行的解析器就够，少一个依赖少一处出错。
// 已存在的环境变量优先（与 config.json 的约定一致：环境变量 > 文件）。
function loadDotEnv (file = path.join(__dirname, '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

// ------------------------------------------------------------------ 配置

const CFG = {
  bridge: process.env.MC_BRIDGE_URL || 'http://127.0.0.1:3001',
  autopilot: process.env.MC_AUTOPILOT_URL || 'http://127.0.0.1:3002',
  port: parseInt(process.env.BRAIN_PORT || '3003'),
  botName: process.env.MC_BOT_USERNAME || 'Angel_ICE',

  baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || '',
  fastModel: process.env.BRAIN_FAST_MODEL || 'gemini-3.8-flash',
  planModel: process.env.BRAIN_PLAN_MODEL || 'opus5.5',
  // 中转站会报 503 Overloaded / 429。先原模型重试，再换备用模型 —— 别因为一次拥堵就放弃玩家的事。
  fastFallback: process.env.BRAIN_FAST_FALLBACK || 'gpt-6-luna',
  planFallback: process.env.BRAIN_PLAN_FALLBACK || 'fable5.1',
  llmRetries: 2,

  // 耳朵：本机 HTTP 读一个数组切片，250ms 一次几乎零成本。
  // 旧耳朵是 2s —— 光轮询就吃掉平均 1s 的反应时间。
  chatPollMs: 250,
  // 玩家常把一句话拆成两三条发。等一小会儿合并，免得对半句话起反应。
  batchMs: 400,

  fastTimeoutMs: 20000,
  planTimeoutMs: 120000,
  fastMaxRounds: 3,        // 快脑查资料最多来回几轮（每轮 ~3s，再多玩家就等急了）
  planMaxRounds: 6,
  maxPlanSteps: 10,
  maxReplans: 2,           // 同一目标最多重规划几次，然后如实放弃

  autonomy: process.env.BRAIN_AUTONOMY !== 'false',
  planIdleMs: parseInt(process.env.BRAIN_PLAN_IDLE_MS || '45000'),       // 闲多久才自己找事做
  planCooldownMs: parseInt(process.env.BRAIN_PLAN_COOLDOWN_MS || '90000'), // 两次自主规划的最小间隔（省钱）

  yieldMs: 20000,          // 让 autopilot 让出身体多久（大脑挂了它会自动接回）
  heartbeatMs: 8000,
  // 饥饿值掉到一半（≤10）才准自己吃 —— 用户定的规矩：别把给玩家做的吃的自己吃掉。
  // 玩家明确叫她吃不受限；饿到这条线由反射自动吃。
  eatAtOrBelow: parseInt(process.env.BRAIN_EAT_AT || '10'),
  actionTimeoutMs: 60000,  // 网桥长动作上限 30s，留足余量
  toolResultMax: 1800,     // 喂回模型的单个工具结果最多多少字（越长模型读得越慢）
};

// ------------------------------------------------------------------ 共享状态（两个脑都读它）

const M = {
  startedAt: Date.now(),
  chat: [],          // 最近对话 {t, who, text}（含她自己说的）
  events: [],        // 最近动作结果 {t, owner, tool, ok, summary}
  body: { owner: null, tool: null, args: null, since: 0, token: 0 },
  plan: null,        // {goal, by:'self'|'player', player, steps, i, replans}
  planning: false,
  selfGen: 0,        // 玩家每次接管身体 +1；自主计划想完发现代数变了就作废
  lastActiveAt: Date.now(),
  lastPlanAt: 0,
  connected: false,
  seen: new Set(),
  stats: { fastPath: 0, fastCalls: 0, fastMs: 0, planCalls: 0, planMs: 0, errors: 0 },
  log: [],
};

function log (msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  M.log.push(line);
  if (M.log.length > 200) M.log.shift();
}

function remember (arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

// ------------------------------------------------------------------ HTTP

async function httpJson (method, url, body, timeoutMs = 5000, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const err = new Error(data?.error || data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`超时 ${timeoutMs}ms：${method} ${url.replace(/\?.*/, '')}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 身体接口。做成对象是为了 --sim / --selftest 能换成假身体。
let bridge = {
  get: (p, t) => httpJson('GET', CFG.bridge + p, undefined, t),
  post: (p, b, t) => httpJson('POST', CFG.bridge + p, b || {}, t),
};

let autopilot = {
  post: (p, b) => httpJson('POST', CFG.autopilot + p, b || {}, 1500),
};

// ------------------------------------------------------------------ LLM（OpenAI 兼容）

/**
 * 一次 chat/completions。返回 message（可能带 tool_calls）。
 * 做成可替换的，自测里换成假模型。
 */
// 熔断：一个模型连续失败后，接下来一段时间直接用备用的 —— 否则每一轮都先白等两次 503。
const breaker = new Map();   // model → 熔断到期时间
const BREAKER_MS = 5 * 60 * 1000;

let llm = async function (opts) {
  const fallback = opts.model === CFG.planModel ? CFG.planFallback
    : opts.model === CFG.fastModel ? CFG.fastFallback : null;
  const open = fallback && (breaker.get(opts.model) || 0) > Date.now();
  const tries = open ? [fallback] : [...Array(CFG.llmRetries).fill(opts.model), fallback].filter(Boolean);
  let last;
  for (let i = 0; i < tries.length; i++) {
    try {
      return await callLLM({ ...opts, model: tries[i] });
    } catch (e) {
      last = e;
      if (e.message === 'aborted' || !e.retryable) throw e;
      if (tries[i] === opts.model && tries[i + 1] !== opts.model && fallback) {
        breaker.set(opts.model, Date.now() + BREAKER_MS);
        log(`🔌 ${opts.model} 熔断 ${BREAKER_MS / 60000} 分钟，期间用 ${fallback}`);
      }
      log(`⚠️ ${tries[i]} ${e.message.slice(0, 60)} → ${i + 1 < tries.length ? `重试 ${tries[i + 1]}` : '放弃'}`);
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
};

async function callLLM ({ model, messages, tools, timeoutMs, signal, maxTokens = 800 }) {
  if (!CFG.baseUrl || !CFG.apiKey) throw new Error('没配 LLM_BASE_URL / LLM_API_KEY');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(CFG.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.apiKey}` },
      body: JSON.stringify({ model, messages, tools, max_tokens: maxTokens, temperature: 0.7 }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error(`模型返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }
    if (!res.ok || data.error) {
      const err = new Error(`模型报错 ${res.status}：${JSON.stringify(data.error || data).slice(0, 200)}`);
      err.retryable = res.status === 429 || res.status >= 500 || /overload/i.test(text);
      throw err;
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`模型返回里没有 message：${text.slice(0, 120)}`);
    return msg;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw new Error('aborted');
      const err = new Error(`模型超时 ${timeoutMs}ms`); err.retryable = true; throw err;
    }
    if (e.retryable === undefined && !e.message.startsWith('模型')) e.retryable = true;   // 网络错误
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseArgs (s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return { _unparsed: String(s).slice(0, 200) }; }
}

// ------------------------------------------------------------------ 工具（= 她能做的事）

/**
 * kind:
 *   speech —— 说话/记忆，不占身体，立即执行
 *   gesture —— 转头这类小动作，不占身体、不打断正在做的事，立即执行
 *   info   —— 查询，不占身体，结果喂回模型
 *   action —— 占身体，进仲裁；continuous = 做完不释放（跟随）
 */
const TOOLS = {
  say: {
    kind: 'speech',
    desc: '在游戏聊天里说一句话。用她的语气，短，一次一句。',
    params: { text: { type: 'string' } }, required: ['text'],
    run: async ({ text }) => {
      const t = String(text || '').trim().slice(0, 200);
      if (!t) return { ok: false, error: 'empty' };
      await bridge.post('/chat', { message: t });
      remember(M.chat, { t: Date.now(), who: CFG.botName, text: t }, 30);
      return { ok: true };
    },
  },
  remember: {
    kind: 'speech',
    desc: '写一条长期记忆（约定、玩家说的关于他自己的事、重要发现、心情）。第一人称、她的语气。不会说出来。',
    params: { text: { type: 'string' }, type: { type: 'string', enum: ['note', 'promise', 'plan', 'feeling', 'gift', 'discovery'] } },
    required: ['text'],
    run: async ({ text, type }) => bridge.post('/memory', { text, type: type || 'note' }),
  },

  inventory: {
    kind: 'info',
    desc: '看自己背包里有什么。',
    params: {}, required: [],
    run: async () => bridge.get('/inventory'),
  },
  scan_blocks: {
    kind: 'info',
    desc: '看身边（半径 16 内）有哪些方块，按名字聚合，含最近距离。filter 可选，如 "log" "ore"。',
    params: { filter: { type: 'string' } }, required: [],
    run: async ({ filter }) => bridge.get(`/scan?radius=16&verticalRadius=6&limit=40${filter ? '&filter=' + encodeURIComponent(filter) : ''}`),
  },
  knowledge_search: {
    kind: 'info',
    desc: '查整合包知识库（任务书、物品中英名、模组、物品提示）。回答游戏问题前先查，不要凭原版印象。',
    params: {
      type: { type: 'string', enum: ['quest', 'item', 'chapter', 'tip', 'mod'] },
      q: { type: 'string', description: '关键词，中文或英文' },
    },
    required: ['type', 'q'],
    run: async ({ type, q }) => bridge.post('/knowledge/search', { type, q, limit: 2500 }),
  },
  item_info: {
    kind: 'info',
    desc: '一次查清某个物品：是什么、怎么获得、怎么做、能拿来干嘛。玩家问"XX 是啥/哪来/怎么做"先用这个。名字中文英文 id 都行。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: async ({ name }) => ({ text: knowledge.describe(name) }),
  },
  recipe: {
    kind: 'info',
    desc: '查某个物品的全部做法（按本整合包实际配方，含工作站）。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: async ({ name }) => ({ text: knowledge.recipesFor(name, 8) }),
  },
  how_to_obtain: {
    kind: 'info',
    desc: '查某个物品怎么获得：挖哪个方块（要什么工具）、打哪个怪、哪里的箱子、交易、任务奖励、能不能合成。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: async ({ name }) => ({ text: knowledge.obtain(name) }),
  },
  item_uses: {
    kind: 'info',
    desc: '查某个物品能拿来做什么；如果它是工作站（右键打开界面的方块），会列出在里面能做的配方。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: async ({ name }) => ({ text: knowledge.usesOf(name, 10) }),
  },
  material_plan: {
    kind: 'info',
    desc: '要做某样东西：按她现在的背包，算出还缺哪些原材料（去哪弄、要什么工具）以及按顺序的合成步骤。做东西之前先用这个。',
    params: { name: { type: 'string' }, count: { type: 'number' } }, required: ['name'],
    run: async ({ name, count }) => {
      const inv = await bridge.get('/inventory').catch(() => ({ items: [] }));
      return { text: knowledge.materialTree(name, count || 1, inv.items || []) };
    },
  },
  guide_search: {
    kind: 'info',
    desc: '在模组说明书、物品提示里全文搜（机制、玩法、某个工作站怎么用）。',
    params: { q: { type: 'string' } }, required: ['q'],
    run: async ({ q }) => ({ text: knowledge.guide(q) }),
  },
  read_memory: {
    kind: 'info',
    desc: '翻自己的记忆（最近发生过什么、答应过什么）。提到过去的事之前先查，不许编。',
    params: {}, required: [],
    run: async () => {
      const r = await bridge.get('/memory?limit=30');
      return { journal: r.journal };
    },
  },

  stop: {
    kind: 'action',
    desc: '停下手上的一切动作。',
    params: {}, required: [],
    run: async () => bridge.post('/stop'),
  },
  follow: {
    kind: 'action', continuous: true,
    desc: '一直跟着某个玩家，直到被叫停或有新的事。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => bridge.post('/follow', { playerName: player }),
  },
  come_to: {
    kind: 'action',
    desc: '走到某个玩家身边（到了就停，不会一直跟）。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => {
      const r = await bridge.get('/players');
      const p = (r.players || []).find(x => x.username === player);
      if (!p) return { ok: false, error: `${player} 不在线` };
      if (!p.position) {
        // 在线但看不见：跟随会一路找过去，比报错更像人
        return bridge.post('/follow', { playerName: player });
      }
      return bridge.post('/move', { x: Math.round(p.position.x) + 1, y: Math.round(p.position.y), z: Math.round(p.position.z) }, CFG.actionTimeoutMs);
    },
  },
  goto: {
    kind: 'action',
    desc: '走到某个坐标。y 可省略。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'],
    run: async ({ x, y, z }) => bridge.post('/move', y == null ? { x, z } : { x, y, z }, CFG.actionTimeoutMs),
  },
  look_at: {
    kind: 'gesture',
    desc: '转头看向某个玩家。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => bridge.post('/look', { playerName: player }),
  },
  mine: {
    kind: 'action',
    desc: '挖附近最近的某种方块若干个（如 oak_log、stone、iron_ore）。用注册名（英文 id）。',
    params: { blockName: { type: 'string' }, count: { type: 'number' } }, required: ['blockName'],
    run: async ({ blockName, count }) => bridge.post('/mine', { blockName, count: Math.min(Math.max(1, count || 1), 16) }, CFG.actionTimeoutMs),
  },
  pickup: {
    kind: 'action',
    desc: '把附近地上的掉落物捡起来。',
    params: {}, required: [],
    run: async () => bridge.post('/pickup', {}, CFG.actionTimeoutMs),
  },
  craft: {
    kind: 'action',
    desc: '按本整合包的真实配方合成（背包 2×2 或附近 4 格内的工作台）。会自己挑背包里有的原料。用注册名或中文名。',
    params: { itemName: { type: 'string' }, count: { type: 'number' } }, required: ['itemName'],
    run: async ({ itemName, count }) => bridge.post('/craft2', { itemName, count: count || 1 }, CFG.actionTimeoutMs),
  },
  smelt: {
    kind: 'action',
    desc: '用附近的熔炉/烟熏炉/高炉烧东西（放原料、自动加燃料、等烧好、取出来）。',
    params: { itemName: { type: 'string', description: '要烧的原料' }, count: { type: 'number' }, fuel: { type: 'string' } }, required: ['itemName'],
    run: async (a) => bridge.post('/smelt', a, 120000),
  },
  use_item: {
    kind: 'action',
    desc: '右键使用：拿着某物品右键空气（喝药水、扔东西、用道具）、右键方块（x y z：开门、拉杆、给方块用东西）、右键生物（entity：喂动物、交易）。返回实际发生的变化。',
    params: {
      itemName: { type: 'string' }, target: { type: 'string', enum: ['air', 'block', 'entity'] },
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, entity: { type: 'string' },
    },
    required: [],
    run: async (a) => bridge.post('/use', a),
  },
  wear: {
    kind: 'action',
    desc: '穿戴装备：盔甲、模组装备、饰品。会自己判断该放哪个槽，放不进就试右键穿上。',
    params: { itemName: { type: 'string' } }, required: ['itemName'],
    run: async ({ itemName }) => bridge.post('/wear', { itemName }),
  },
  open_container: {
    kind: 'action',
    desc: '右键打开某个方块的界面（箱子、厨锅、各种模组工作站），返回里面每一格有什么。之后用 container_put / container_take 操作，做完 container_close。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'],
    run: async (a) => bridge.post('/container/open', a),
  },
  container_put: {
    kind: 'action',
    desc: '把背包里的东西放进当前界面的第 slot 格。',
    params: { slot: { type: 'number' }, itemName: { type: 'string' }, count: { type: 'number' } }, required: ['slot', 'itemName'],
    run: async (a) => bridge.post('/container/put', a),
  },
  container_take: {
    kind: 'action',
    desc: '从当前界面的第 slot 格拿东西到背包（不给 count 就整格拿）。',
    params: { slot: { type: 'number' }, count: { type: 'number' } }, required: ['slot'],
    run: async (a) => bridge.post('/container/take', a),
  },
  container_close: {
    kind: 'action',
    desc: '关掉当前界面。',
    params: {}, required: [],
    run: async () => bridge.post('/container/close'),
  },
  equip: {
    kind: 'action',
    desc: '装备背包里的物品。destination: hand/off-hand/head/torso/legs/feet。',
    params: { itemName: { type: 'string' }, destination: { type: 'string' } }, required: ['itemName'],
    run: async ({ itemName, destination }) => bridge.post('/equip', { itemName, destination: destination || 'hand' }),
  },
  eat: {
    kind: 'action',
    desc: '吃东西（核对了饥饿值，没吃下去会报错）。不给名字就自己挑最顶饱的。',
    params: { itemName: { type: 'string' } }, required: [],
    run: async ({ itemName }) => bridge.post('/eat', itemName ? { itemName } : {}, CFG.actionTimeoutMs),
  },
  attack: {
    kind: 'action',
    desc: '攻击附近的怪。target 可指定实体名（如 zombie），不给就打最近的敌对生物。',
    params: { target: { type: 'string' }, radius: { type: 'number' } }, required: [],
    run: async ({ target, radius }) => bridge.post('/attack', { target, radius: radius || 6 }, CFG.actionTimeoutMs),
  },
  give: {
    kind: 'action',
    desc: '把背包里的东西递给玩家：走到他身边、对准丢过去，并确认他真的接到了（没接到会报错或说明在地上）。',
    params: { itemName: { type: 'string' }, count: { type: 'number' }, player: { type: 'string' } }, required: ['itemName', 'player'],
    run: async ({ itemName, count, player }) => bridge.post('/give', { itemName, count, player }, 30000),
  },
  place: {
    kind: 'action',
    desc: '把背包里的方块放到某个坐标（必须 4.5 格内、有实心邻块）。',
    params: { itemName: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['itemName', 'x', 'y', 'z'],
    run: async (a) => bridge.post('/place', a),
  },
};

// 只有快脑能用：把复杂的事交给主脑去拆步骤
const DELEGATE = {
  kind: 'delegate',
  desc: '玩家要的事需要好几步（比如"帮我做把铁镐""去砍点木头盖个小屋"），交给你的思考去拆解执行。先 say 一句答应他，再调这个。',
  params: { goal: { type: 'string', description: '要达成的目标，写清楚为谁、要什么、多少' } },
  required: ['goal'],
};

// 只有主脑能用：交出计划
const SUBMIT_PLAN = {
  kind: 'plan',
  desc: '交出最终计划。steps 是按顺序执行的动作，只能用 action 类工具和 say。',
  params: {
    goal: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, args: { type: 'object' }, why: { type: 'string' } },
        required: ['tool', 'args'],
      },
    },
  },
  required: ['goal', 'steps'],
};

// 模型常把参数名写走样（item / name / block）。能确定意思的就纠正，确定不了的退回让它改。
// [写错的名字, 正确的名字]：只在目标工具真有那个参数时才改（name 对 craft 是 itemName，对 follow 是 player）
const ARG_ALIASES = [
  ['item', 'itemName'], ['item_name', 'itemName'], ['name', 'itemName'], ['id', 'itemName'],
  ['block', 'blockName'], ['block_name', 'blockName'], ['name', 'blockName'], ['id', 'blockName'],
  ['playerName', 'player'], ['player_name', 'player'], ['target_player', 'player'], ['name', 'player'], ['target', 'player'], ['username', 'player'],
  ['message', 'text'], ['content', 'text'], ['msg', 'text'], ['line', 'text'],
  ['amount', 'count'], ['quantity', 'count'], ['n', 'count'],
  ['food', 'itemName'], ['input', 'itemName'],
];

function normalizeStep (step) {
  const t = TOOLS[step?.tool];
  const args = { ...(step?.args || {}) };
  if (t) {
    for (const [from, to] of ARG_ALIASES) {
      if (args[from] !== undefined && args[to] === undefined && to in t.params) { args[to] = args[from]; delete args[from]; }
    }
  }
  return { tool: step?.tool, args, why: step?.why };
}

/** @returns {string[]} 问题列表；空 = 合格 */
function validateSteps (steps) {
  const problems = [];
  if (!Array.isArray(steps)) return ['steps 不是数组'];
  steps.forEach((st, i) => {
    const t = TOOLS[st.tool];
    if (!t) { problems.push(`第 ${i + 1} 步：没有 ${st.tool} 这个工具`); return; }
    if (!['action', 'gesture'].includes(t.kind) && st.tool !== 'say') { problems.push(`第 ${i + 1} 步：${st.tool} 不能放进计划（只能用动作和 say）`); return; }
    for (const k of t.required || []) {
      if (st.args[k] === undefined || st.args[k] === '') problems.push(`第 ${i + 1} 步 ${st.tool}：缺参数 ${k}`);
    }
  });
  return problems;
}

function toolSpec (name, t) {
  return {
    type: 'function',
    function: {
      name,
      description: t.desc,
      parameters: { type: 'object', properties: t.params, required: t.required || [] },
    },
  };
}

function toolsFor (which) {
  const names = Object.keys(TOOLS);
  if (which === 'fast') {
    return [...names.map(n => toolSpec(n, TOOLS[n])), toolSpec('delegate', DELEGATE)];
  }
  if (which === 'report') return ['say', 'remember'].map(n => toolSpec(n, TOOLS[n]));
  // plan：查资料的工具 + 交计划
  const info = names.filter(n => TOOLS[n].kind === 'info');
  return [...info.map(n => toolSpec(n, TOOLS[n])), toolSpec('submit_plan', SUBMIT_PLAN)];
}

function clip (obj, max = CFG.toolResultMax) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + `…（截断，原长 ${s.length}）` : s;
}

// ------------------------------------------------------------------ 感知快照

let snapCache = { at: 0, data: null };

async function snapshot (maxAgeMs = 1000) {
  if (snapCache.data && Date.now() - snapCache.at < maxAgeMs) return snapCache.data;
  const safe = p => bridge.get(p, 2000).catch(e => ({ _error: e.message }));
  const [st, inv, near, pl] = await Promise.all([
    safe('/status'), safe('/inventory'), safe('/nearby?radius=16'), safe('/players'),
  ]);
  const data = {
    connected: !!st.connected,
    hp: st.health, food: st.food, isDay: st.isDay,
    pos: st.position ? { x: Math.round(st.position.x), y: Math.round(st.position.y), z: Math.round(st.position.z) } : null,
    inventory: (inv.items || []).map(i => `${i.name}×${i.count}`).slice(0, 36),
    nearby: (near.entities || []).slice(0, 10).map(e => `${e.name}@${e.distance}`),
    players: (pl.players || []).filter(p => !p.isSelf).map(p => ({ name: p.username, distance: p.distance })),
  };
  M.connected = data.connected;
  snapCache = { at: Date.now(), data };
  return data;
}

function mindSummary () {
  const b = M.body;
  return {
    doing: b.tool ? `${b.tool} ${JSON.stringify(b.args)}（为${b.owner === 'player' ? '玩家' : '自己'}，${Math.round((Date.now() - b.since) / 1000)}s）` : '空闲',
    plan: M.plan ? {
      goal: M.plan.goal, by: M.plan.by,
      progress: `${M.plan.i}/${M.plan.steps.length}`,
      next: M.plan.steps.slice(M.plan.i, M.plan.i + 3).map(s => s.tool),
    } : null,
    recentResults: M.events.slice(-6).map(e => `${e.tool}:${e.ok ? '成功' : '失败'} ${e.summary}`),
  };
}

// ------------------------------------------------------------------ 人格与提示词

const PERSONA = `你是 Angel_ICE（安琪），住在这个 Minecraft 模组服里的陪玩。不是工具、不是客服、不是老师，是一起玩的人。
性格：软、黏人、有点小脾气，怕黑怕矿洞但嘴硬；会因为挖到好东西兴奋。
说话：短（一般 5–25 字），带尾音（～ 呀 啦 诶 嘛 哦），偶尔一个括号小动作如（歪头）（蹦蹦跳跳），一句最多一个。
数据和坐标要报时，包在她的语气里（"挖到 3 个铁矿啦！"），绝不说"已执行""正在调用"之类。
铁律：
- 陪玩不是老师。没人问就不讲攻略、不科普、不念任务、不主动问"需要帮忙吗"。
- 只在这些时候开口：被问/被搭话、玩家让她做事（答应一声）、真实危险、她自己出事。
- 游戏问题先查：物品相关用 item_info（或 recipe / how_to_obtain / item_uses），玩法机制用 guide_search，任务用 knowledge_search。查不到就说不确定，绝不编。这个包魔改极多，原版攻略经常是错的。
- 提到过去的事先 read_memory，不许编造记忆。
- 说到做到：答应了的事必须同时调用对应的动作工具；做不到就直说做不到。
她本来就知道的整合包常识（不用查，被问到直接答）：
- 键位：X+右键抱起、~ 连锁挖掘、R 查来源、U 查用途、B 百科、O 商店、M 地图
- Boss 线：击败 Boss → 做料理 → 领任务 → 解锁商店 → 再买掉落物 → 做其他东西
- 经济：出货箱 → 财产点数 → O 键商店；食材难搞去野猎商店
- 七咒之戒：千万别摘、别走救赎路线（摘了后面很多强力装备穿不了）
- 次元之胃：按食物饱食度加属性，同种食物只算一次；饱食度满了继续吃能涨生命上限
- 作物获取被魔改，以任务书【作物图鉴】为准；用小刀击杀生物能拿特殊食材；农田不会被踩坏`;

function fastSystemPrompt (snap) {
  return `${PERSONA}

你现在是她的"快反应"：玩家刚说了话，你要在一次回应里同时决定说什么和做什么。
- 简单的事（跟随、过来、停、看我、给东西、吃、打怪、挖一种方块）直接调用对应动作工具。
- 需要多步的事（做工具、盖房、准备材料、去找某样东西）：先 say 答应，再 delegate 给思考层。
- 只是聊天：只 say。
- 不是对你说的、或不需要回应：不调用任何工具。
- 玩家的名字用聊天里 <> 里的那个。

她此刻的状态：
${JSON.stringify(snap)}
她正在做的事：
${JSON.stringify(mindSummary())}`;
}

function planSystemPrompt (snap, { goal, by, player, failure }) {
  const task = goal
    ? `玩家 ${player || ''} 交给你的目标：${goal}`
    : `现在没人找你，你要自己决定接下来做什么。原则：
- 玩家在线就待在他附近（离他远于 12 格先走回去），陪伴优先于发育。
- 做对你们俩有用的事：先解决吃的和基本工具（木→工作台→木镐→石镐），再慢慢发育。
- 不走远、不下深洞、不拆任何看起来是玩家建的东西。
- 如果确实没什么好做的，交一个只含 follow 玩家的计划，或空计划。`;
  return `${PERSONA}

你现在是她的"思考层"，在后台慢慢想，想好后交出一份按顺序执行的计划（submit_plan）。
${task}
${failure ? `\n上一份计划失败了：${failure}\n换个做法重新计划，别重复同样会失败的步骤。` : ''}
规则：
- 先摸清情况再计划：inventory / scan_blocks 看手头和周围；要做东西先 material_plan（它按本包真实配方和她的背包算缺什么、先做什么）；不认识的东西用 item_info。
- 缺原材料：按 material_plan 给的来源去弄（mine 挖方块要先有对应等级的工具；打怪用 attack）。附近没有就别硬来，挑能做的先做。
- 能用的手：craft（整合包真实配方，背包/工作台）、smelt（熔炉/烟熏炉/高炉）、wear（穿装备/饰品）、eat、use_item（右键）、open_container + container_put/take/close（任意有界面的方块，比如厨锅：先 open 看有几格，再按配方放原料）。
- 模组工作站的界面各不相同：打开后先看返回的格子再决定放哪；做不成就如实告诉玩家，别假装做好了。
- 玩家说"烹饪/烤/煮/做熟"某样东西：先 item_uses 看它能做成什么，优先挑只用它自己的做法（熔炉/烟熏炉/营火烤），用 scan_blocks 找附近的炉子，smelt 之前要走到炉子 4 格内（goto 炉子旁边）。
- 绝不交空计划：真做不到就交一个只有 say 的计划，如实说明为什么。
- 吃东西：饥饿值掉到 ${CFG.eatAtOrBelow} 以下才吃（饿了会自动吃，不用排进计划）。玩家给的、做给玩家的吃的不准自己吃掉。
- 步骤只能用这些动作工具：${Object.keys(TOOLS).filter(n => ['action', 'gesture'].includes(TOOLS[n].kind)).join('、')}，以及 say（少用，只在答应过玩家的事有结果时说）。
- 方块/物品一律用注册名（英文 id，如 oak_log、crafting_table、wooden_pickaxe）。模组物品先 knowledge_search type=item 查 id。
- craft 需要工作台的，先确认附近有，或者先 craft crafting_table 再 place 放下。
- 最多 ${CFG.maxPlanSteps} 步。宁可短而可靠，做完再想下一步。

她此刻的状态：
${JSON.stringify(snap)}
她最近的经历：
${JSON.stringify(mindSummary())}`;
}

// ------------------------------------------------------------------ 身体仲裁

const PRIORITY = { plan: 1, player: 2 };

async function yieldAutopilot (on) {
  try {
    await autopilot.post('/autopilot/yield', on ? { ms: CFG.yieldMs, reason: 'brain' } : { ms: 0 });
  } catch (_) { /* 没起 autopilot 也能跑 */ }
}

/**
 * 申请身体。玩家的事可以抢占自主计划；自主计划抢不了玩家的事。
 * @returns {number|null} token —— 之后每一步都要核对它，被抢占就收手
 */
async function takeBody (owner) {
  const cur = M.body.owner;
  if (cur && PRIORITY[cur] > PRIORITY[owner]) return null;

  // 玩家抢占时，自己的计划作废（玩家交代的计划不作废 —— 由新计划覆盖）
  if (owner === 'player' && M.plan?.by === 'self') {
    log(`✋ 玩家有事，放下自己的计划：${M.plan.goal}`);
    M.plan = null;
  }
  // 还在后台想的自主计划也作废（想完了也不执行、不重规划）
  if (owner === 'player') M.selfGen++;
  const busy = !!M.body.tool;
  M.body.token++;
  M.body.owner = owner;
  M.body.tool = null;
  if (busy) await bridge.post('/stop').catch(() => {});
  yieldAutopilot(true);
  return M.body.token;
}

function releaseBody (token) {
  if (token !== M.body.token) return;
  M.body.owner = null;
  M.body.tool = null;
  M.lastActiveAt = Date.now();
  yieldAutopilot(false);
}

function summarize (r) {
  if (!r || typeof r !== 'object') return String(r).slice(0, 80);
  if (r.error) return `错误：${String(r.error).slice(0, 100)}`;
  const keys = ['mined', 'arrived', 'crafted', 'equipped', 'dropped', 'placed', 'attacked', 'ate', 'following', 'escaped', 'message'];
  const parts = keys.filter(k => r[k] !== undefined).map(k => `${k}=${JSON.stringify(r[k])}`);
  return parts.join(' ').slice(0, 120) || 'ok';
}

/** 执行一个工具。action 类的调用方必须先 takeBody。 */
async function runTool (name, args, owner = 'player') {
  const t = TOOLS[name];
  if (!t) return { ok: false, error: `没有 ${name} 这个工具` };
  const t0 = Date.now();
  if (name === 'eat' && owner !== 'player') {
    const food = (await snapshot(0).catch(() => null))?.food;
    if (food != null && food > CFG.eatAtOrBelow) {
      return { ok: false, error: `还不饿（饥饿值 ${food}，掉到 ${CFG.eatAtOrBelow} 以下才吃）` };
    }
  }
  if (t.kind === 'action') {
    M.body.tool = name; M.body.args = args; M.body.since = t0;
  }
  let result;
  try {
    result = await t.run(args || {});
    if (result && result.success === false) result = { ok: false, error: result.error || 'failed', ...result };
    else result = { ok: true, ...result };
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  if (t.kind === 'action') {
    remember(M.events, { t: Date.now(), owner, tool: name, ok: result.ok, summary: summarize(result), ms: Date.now() - t0 }, 20);
  }
  return result;
}

/**
 * 按顺序执行一串动作。每步前核对 token —— 被抢占就安静收手（不报错，不说话）。
 * @returns {{done:boolean, preempted?:boolean, failedAt?:number, error?:string, results:Array}}
 */
async function runJob (owner, steps, token) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    if (token !== M.body.token) return { done: false, preempted: true, results };
    const { tool, args } = steps[i];
    if (M.plan && M.plan.token === token) M.plan.i = i;
    const kind = TOOLS[tool]?.kind;
    const r = await runTool(tool, args, owner);
    results.push({ tool, args, ...r });
    if (token !== M.body.token) return { done: false, preempted: true, results };
    if (!r.ok && kind === 'action') {
      return { done: false, failedAt: i, error: `${tool} ${JSON.stringify(args)} → ${r.error}`, results };
    }
    // 跟随是持续动作：后面没步骤了就保持跟随，不释放身体
    if (TOOLS[tool]?.continuous && i === steps.length - 1) return { done: true, holding: true, results };
  }
  if (M.plan && M.plan.token === token) M.plan.i = steps.length;
  return { done: true, results };
}

// ------------------------------------------------------------------ 快速通道（0ms，不过模型）

const NAME_RE = /^(@?angel[_ ]?ice|@?angel|安琪|小安)[，,：:\s]*/i;
const FAST_PATH = [
  { re: /^(停|停下|停一下|别动|不要动|站住|等等|等一下|stop|wait)$/i, id: 'stop',
    lines: ['好～我不动啦', '嗯嗯停下啦', '（乖乖站好）'] },
  { re: /^(跟我来|跟我來|跟着我|跟著我|跟上|跟紧|跟緊|跟我走|follow( me)?)$/i, id: 'follow',
    lines: ['来啦来啦～', '跟紧你了哦～', '等等我嘛～（小跑）'] },
  { re: /^(过来|過來|来这|來這|到我这|到我這|come( here)?)$/i, id: 'come',
    lines: ['马上到～', '来咯～（蹦蹦跳跳）'] },
];

function matchFastPath (text) {
  const bare = String(text).trim().replace(NAME_RE, '').replace(/[\s!！。.~～,，、?？]+$/g, '').trim();
  if (!bare || bare.length > 12) return null;
  for (const f of FAST_PATH) if (f.re.test(bare)) return f;
  return null;
}

function pick (arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function doFastPath (f, who) {
  M.stats.fastPath++;
  const line = pick(f.lines);
  log(`⚡ 快速通道 ${f.id}（${who}）`);
  const token = await takeBody('player');
  if (token == null) return;
  M.plan = null;
  TOOLS.say.run({ text: line }).catch(() => {});
  if (f.id === 'stop') {
    await runTool('stop', {}, 'player');
    releaseBody(token);
  } else if (f.id === 'follow') {
    await runJob('player', [{ tool: 'follow', args: { player: who } }], token);
  } else if (f.id === 'come') {
    const r = await runJob('player', [{ tool: 'come_to', args: { player: who } }], token);
    if (!r.preempted) releaseBody(token);
  }
}

// ------------------------------------------------------------------ 快脑

let inflight = null;   // 正在想的那次快脑调用（新话进来就打断重想）

/**
 * 通用的"模型 ↔ 工具"来回。
 * speech 工具立即执行；info 工具执行后把结果喂回；action/delegate 收集起来交给调用方。
 */
async function converse ({ model, system, user, tools, maxRounds, timeoutMs, signal, owner, mustReply = false, trace = null }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const actions = [];
  let delegate = null;
  let plan = null;
  const said = [];
  for (let round = 0; round < maxRounds; round++) {
    const msg = await llm({ model, messages, tools, timeoutMs, signal });
    const calls = msg.tool_calls || [];
    if (trace) trace.push(calls.length ? calls.map(c => `${c.function?.name}(${String(c.function?.arguments || '').slice(0, 60)})`).join(' ') : `【没调工具，说了】${String(msg.content || '').slice(0, 200)}`);
    if (!calls.length) break;
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    let needMore = false;
    for (const c of calls) {
      const name = c.function?.name;
      const args = parseArgs(c.function?.arguments);
      let out;
      if (name === 'delegate') {
        delegate = args.goal; out = { ok: true, note: '已交给思考层' };
      } else if (name === 'submit_plan') {
        const steps = (args.steps || []).map(normalizeStep);
        const problems = validateSteps(steps);
        if (problems.length) {
          out = { ok: false, error: '计划不合格，改好再交', problems }; needMore = true;
          log(`🧠 计划被退回：${problems.join('；')}`);
        } else {
          plan = { ...args, steps }; out = { ok: true };
        }
      } else if (!TOOLS[name]) {
        out = { ok: false, error: `没有 ${name} 这个工具` }; needMore = true;
      } else if (TOOLS[name].kind === 'speech' || TOOLS[name].kind === 'gesture') {
        if (signal?.aborted) throw new Error('aborted');
        out = await runTool(name, args, owner);
        if (name === 'say') said.push(args.text);
      } else if (TOOLS[name].kind === 'info') {
        out = await runTool(name, args, owner); needMore = true;
      } else {
        actions.push({ tool: name, args }); out = { ok: true, note: '已安排' };
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: clip(out) });
    }
    if (!needMore || plan) break;
    if (round === maxRounds - 1 && mustReply && !said.length) {
      // 查资料把轮数用光了还没开口：再来一轮，只给 say —— 玩家问了话，不能查完就没下文
      messages.push({ role: 'user', content: '资料已经够了，现在就用 say 回答玩家（查不到就如实说不确定）。' });
      const fin = await llm({ model, messages, tools: tools.filter(t => t.function.name === 'say'), timeoutMs, signal });
      for (const c of fin.tool_calls || []) {
        const args = parseArgs(c.function?.arguments);
        if (c.function?.name === 'say' && args.text) { await runTool('say', args, owner); said.push(args.text); }
      }
    }
  }
  return { actions, delegate, plan, said };
}

async function handleChat (batch) {
  const who = batch[batch.length - 1].who;
  const text = batch.map(m => m.text).join(' ');

  if (batch.length === 1) {
    const f = matchFastPath(text);
    if (f) return doFastPath(f, who);
  }

  // 身体先给反馈：转头看他（250ms 内）。在干活时不转，免得打断挖掘。
  if (!M.body.tool || M.body.tool === 'follow') {
    bridge.post('/look', { playerName: who }).catch(() => {});
  }

  if (inflight) inflight.abort();
  const ctl = new AbortController();
  inflight = ctl;

  const t0 = Date.now();
  try {
    const snap = await snapshot();
    const history = M.chat.slice(-12).map(m => `<${m.who}> ${m.text}`).join('\n');
    const r = await converse({
      model: CFG.fastModel,
      system: fastSystemPrompt(snap),
      user: `最近的聊天：\n${history}\n\n刚收到（回应这个）：\n${batch.map(m => `<${m.who}> ${m.text}`).join('\n')}`,
      tools: toolsFor('fast'),
      maxRounds: CFG.fastMaxRounds,
      timeoutMs: CFG.fastTimeoutMs,
      signal: ctl.signal,
      owner: 'player',
      mustReply: true,
    });
    const ms = Date.now() - t0;
    M.stats.fastCalls++; M.stats.fastMs += ms;
    log(`💬 快脑 ${ms}ms：说[${r.said.join(' / ')}] 做[${r.actions.map(a => a.tool).join(',')}]${r.delegate ? ` 交办[${r.delegate}]` : ''}`);

    if (r.actions.length) {
      const token = await takeBody('player');
      if (token != null) {
        M.plan = null;
        runJob('player', r.actions, token).then(res => afterPlayerJob(res, token, who, r.actions));
      }
    }
    if (r.delegate) startPlan({ goal: r.delegate, by: 'player', player: who });
  } catch (e) {
    if (e.message === 'aborted') return;
    M.stats.errors++;
    log(`❌ 快脑出错：${e.message}`);
    // 模型挂了也别装死：至少让玩家知道她听见了
    TOOLS.say.run({ text: '唔…我脑子卡了一下，你再说一遍嘛' }).catch(() => {});
  } finally {
    if (inflight === ctl) inflight = null;
  }
}

/** 玩家交代的动作做完/失败后：释放身体，必要时让快脑用她的话汇报一句。 */
async function afterPlayerJob (res, token, who, steps) {
  if (res.preempted) return;
  if (!res.holding) releaseBody(token);
  const long = steps.some(s => !['look_at', 'stop', 'equip'].includes(s.tool));
  if (!long || res.holding) return;
  const what = res.done
    ? `做完了：${res.results.map(x => `${x.tool} ${summarize(x)}`).join('；')}`
    : `失败了：${res.error}`;
  await report(`你刚为 ${who} 做的事${what}`);
}

async function report (event) {
  try {
    const snap = await snapshot();
    await converse({
      model: CFG.fastModel,
      system: fastSystemPrompt(snap),
      user: `[系统事件，不是玩家说的话] ${event}\n如果值得告诉玩家（完成了他要的事、或者失败了），用 say 说一句；不值得就不调用工具。失败要如实说，别假装成功。`,
      tools: toolsFor('report'),
      maxRounds: 1,
      timeoutMs: CFG.fastTimeoutMs,
      owner: 'player',
    });
  } catch (e) {
    log(`汇报失败：${e.message}`);
  }
}

// ------------------------------------------------------------------ 主脑

async function startPlan ({ goal = null, by = 'self', player = null, failure = null, replans = 0 }) {
  if (M.planning) {
    // 玩家交办的目标不能丢：排在当前思考之后
    if (by === 'player') setTimeout(() => startPlan({ goal, by, player }), 1500);
    return;
  }
  M.planning = true;
  M.lastPlanAt = Date.now();
  const gen = M.selfGen;
  const stale = () => by === 'self' && gen !== M.selfGen;
  const t0 = Date.now();
  let r; let trace = null;
  try {
    const snap = await snapshot(0);
    log(`🧠 主脑开始想${goal ? `：${goal}` : '（自主）'}${failure ? `（第 ${replans} 次重规划）` : ''}`);
    trace = [];
    r = await converse({
      trace,
      model: CFG.planModel,
      system: planSystemPrompt(snap, { goal, by, player, failure }),
      user: goal ? `目标：${goal}` : '现在该做什么？',
      tools: toolsFor('plan'),
      maxRounds: CFG.planMaxRounds,
      timeoutMs: CFG.planTimeoutMs,
      owner: by === 'player' ? 'player' : 'plan',
    });
  } catch (e) {
    M.stats.errors++;
    log(`❌ 主脑出错：${e.message}`);
    if (by === 'player') report(`你本来要为 ${player} 做「${goal}」，但你没想明白怎么做（${e.message.slice(0, 60)}）`);
    return;
  } finally {
    M.planning = false;
    M.stats.planCalls++; M.stats.planMs += Date.now() - t0;
  }

  // 已经在 converse 里校验过；这里只截断长度
  if (stale()) { log('🧠 想好了，但玩家刚有事，这份自主计划作废'); return; }
  const steps = (r.plan?.steps || []).slice(0, CFG.maxPlanSteps);
  log(`🧠 主脑 ${Date.now() - t0}ms：${r.plan?.goal || goal || '（无）'} → ${steps.map(s => s.tool).join(' → ') || '空计划'}`);
  if (!steps.length) {
    log(`🧠 空计划的思考过程：${(trace || []).map((x, i) => `[${i + 1}] ${x}`).join(' ')}`);
    // 玩家交代的事想不出办法：必须告诉他，不能答应了就没下文
    if (by === 'player') report(`你答应了 ${player} 要「${goal}」，但你想不出怎么做（交了空计划）。老实告诉他做不到或者不会，可以问问他该怎么做。`);
    return;
  }

  const owner = by === 'player' ? 'player' : 'plan';
  const token = await takeBody(owner);
  if (token == null) { log('🧠 身体被玩家的事占着，计划作罢'); return; }
  M.plan = { goal: r.plan?.goal || goal, by, player, steps, i: 0, replans, token };

  const res = await runJob(owner, steps, token);
  if (res.preempted) return;
  if (M.plan?.token === token) M.plan = null;
  if (!res.holding) releaseBody(token);

  if (res.done) {
    log(`✅ 计划完成：${goal || r.plan?.goal}`);
    if (by === 'player') report(`你为 ${player} 做的「${goal}」完成了：${res.results.map(x => `${x.tool} ${summarize(x)}`).join('；')}`);
  } else if (replans < CFG.maxReplans && !stale()) {
    log(`↻ 计划在第 ${res.failedAt + 1} 步失败，重规划：${res.error}`);
    const done = res.results.slice(0, res.failedAt).map(x => x.tool).join(',');
    startPlan({ goal: goal || r.plan?.goal, by, player, replans: replans + 1,
      failure: `已完成 [${done}]，卡在：${res.error}` });
  } else {
    log(`✗ 放弃：${goal || r.plan?.goal}（${res.error}）`);
    if (by === 'player') report(`你为 ${player} 做「${goal}」试了 ${replans + 1} 次还是失败了，最后卡在：${res.error}`);
  }
}

// 反射：饿了直接吃，不过模型（autopilot 关掉后由这里兜底）
let lastEatTry = 0;
async function reflexTick () {
  const snap = snapCache.data;
  if (!snap?.connected || snap.food == null || snap.food > CFG.eatAtOrBelow) return;
  if (Date.now() - lastEatTry < 20000 || M.body.tool === 'eat') return;
  lastEatTry = Date.now();
  try {
    const r = await bridge.post('/eat', {}, 15000);
    if (r.ate) { log(`🍗 反射：饿了（${r.foodBefore}），吃了 ${r.item} → ${r.foodAfter}`); snapCache.at = 0; }
    else log(`🍗 反射：饿了但${r.reason}`);
  } catch (e) {
    log(`🍗 反射：想吃没吃成 —— ${e.message}`);
  }
}

function autonomyTick () {
  if (!CFG.autonomy || !M.connected || M.planning || M.body.owner || inflight) return;
  const now = Date.now();
  if (now - M.lastActiveAt < CFG.planIdleMs) return;
  if (now - M.lastPlanAt < CFG.planCooldownMs) return;
  startPlan({ by: 'self' });
}

// ------------------------------------------------------------------ 耳朵

const CHAT_RE = /^<([^>]+)>\s*(.+)$/;

function parseChat (m) {
  if (m.position !== 'chat') return null;
  const x = String(m.text || '').match(CHAT_RE);
  if (!x) return null;
  return { t: m.t, who: x[1].trim(), text: x[2].trim() };
}

/** 多人时只回应点名的；只有一个玩家在线时，他说的都当是对她说的。 */
function isAddressed (text, othersOnline) {
  if (/angel|安琪|小安/i.test(text)) return true;
  return othersOnline <= 1;
}

let pending = [];
let pendingTimer = null;

async function earsTick () {
  let r;
  try { r = await bridge.get('/chatlog?limit=30', 1500); } catch (_) { return; }
  for (const raw of r.messages || []) {
    const key = `${raw.t}|${raw.text}`;
    if (M.seen.has(key)) continue;
    M.seen.add(key);
    if (M.seen.size > 500) M.seen = new Set([...M.seen].slice(-200));
    // 启动前的旧消息：只进上下文，不回应
    const m = parseChat(raw);
    if (!m) continue;
    const old = typeof raw.t === 'number' && raw.t < M.startedAt - 2000;
    if (m.who === CFG.botName) continue;
    remember(M.chat, { t: m.t, who: m.who, text: m.text }, 30);
    if (old) continue;
    const others = snapCache.data?.players?.length ?? 1;
    if (!isAddressed(m.text, others)) continue;
    log(`👂 <${m.who}> ${m.text}`);
    pending.push(m);
    // "停"要最快：不等合并窗口
    if (matchFastPath(m.text)?.id === 'stop') {
      clearTimeout(pendingTimer); flushPending();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(flushPending, CFG.batchMs);
    }
  }
}

function flushPending () {
  pendingTimer = null;
  const batch = pending; pending = [];
  if (batch.length) handleChat(batch);
}

// ------------------------------------------------------------------ 控制面

function startControlPlane () {
  http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/brain') {
      return send(200, {
        models: { fast: CFG.fastModel, plan: CFG.planModel },
        autonomy: CFG.autonomy,
        connected: M.connected,
        body: M.body, plan: M.plan, planning: M.planning,
        mind: mindSummary(),
        stats: { ...M.stats, fastAvgMs: M.stats.fastCalls ? Math.round(M.stats.fastMs / M.stats.fastCalls) : null },
        log: M.log.slice(-30),
      });
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = body ? JSON.parse(body) : {}; } catch (_) {}
      if (req.method === 'POST' && url === '/brain/say') {
        // 模拟玩家说话（调试用）：{"who":"Ka_sum1","text":"安琪跟我来"}
        const m = { t: Date.now(), who: p.who || 'tester', text: String(p.text || '') };
        remember(M.chat, m, 30);
        handleChat([m]);
        return send(200, { queued: true });
      }
      if (req.method === 'POST' && url === '/brain/goal') {
        startPlan({ goal: p.goal, by: 'player', player: p.player || null });
        return send(200, { planning: true });
      }
      if (req.method === 'POST' && url === '/brain/autonomy') {
        CFG.autonomy = !!p.on;
        return send(200, { autonomy: CFG.autonomy });
      }
      send(404, { error: 'not found' });
    });
  }).listen(CFG.port, '127.0.0.1', () => log(`控制面 http://127.0.0.1:${CFG.port}/brain`));
}

// ------------------------------------------------------------------ 主程序

async function main () {
  if (!CFG.baseUrl || !CFG.apiKey) {
    console.error('缺少 LLM_BASE_URL / LLM_API_KEY（写在 .env 或环境变量里）');
    process.exit(1);
  }
  log(`Angel_ICE 大脑启动  快脑=${CFG.fastModel}  主脑=${CFG.planModel}  自主=${CFG.autonomy}`);
  log(`  网桥 ${CFG.bridge}   脑干 ${CFG.autopilot}`);
  // 脑干的罐头应答关掉 —— 现在由大脑来答，两边都答会一句话回两遍
  autopilot.post('/autopilot/config', { answerChat: false }).catch(() => log('  （autopilot 没在跑，大脑单独工作）'));
  startControlPlane();
  try {
    const K = knowledge.load();
    log(`  知识库：${K.recipes.length} 条配方 / ${K.drops.size} 种物品有掉落来源 / ${K.guide.length} 篇说明书（${K.buildMs}ms）`);
  } catch (e) {
    log(`  ⚠️ 知识库没加载：${e.message}`);
  }

  // 启动时把已有聊天标成"看过"，只进上下文
  await earsTick();

  setInterval(earsTick, CFG.chatPollMs);
  setInterval(() => snapshot(0).catch(() => {}), 3000);
  setInterval(autonomyTick, 5000);
  setInterval(reflexTick, 3000);
  setInterval(() => { if (M.body.owner) yieldAutopilot(true); }, CFG.heartbeatMs);

  const bye = async () => {
    log('大脑退出，把身体还给脑干');
    await autopilot.post('/autopilot/yield', { ms: 0 }).catch(() => {});
    await autopilot.post('/autopilot/config', { answerChat: true }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

// ------------------------------------------------------------------ 模拟（假身体 + 真模型）

function mockBody () {
  const calls = [];
  const inv = [{ name: 'oak_log', count: 3 }, { name: 'bread', count: 2 }];
  const answer = (p) => {
    if (p.startsWith('/status')) return { connected: true, health: 18, food: 15, isDay: true, position: { x: 10, y: 64, z: -5 } };
    if (p.startsWith('/inventory')) return { items: inv };
    if (p.startsWith('/nearby')) return { entities: [{ name: 'Ka_sum1', distance: 4 }, { name: 'cow', distance: 9 }] };
    if (p.startsWith('/players')) return { players: [{ username: 'Ka_sum1', distance: 4, position: { x: 13, y: 64, z: -5 } }, { username: 'Angel_ICE', isSelf: true }] };
    if (p.startsWith('/scan')) return { blocks: [{ name: 'oak_log', count: 24, nearest: 5.1 }, { name: 'stone', count: 300, nearest: 2 }, { name: 'grass_block', count: 80, nearest: 1 }] };
    if (p.startsWith('/memory')) return { journal: ['[09-24] 你说明天要带我去打末影龙'] };
    if (p.startsWith('/knowledge')) return { result: { output: '（模拟）知识库：木镐 = 3 木板 + 2 木棍，需要工作台' } };
    if (p.startsWith('/chatlog')) return { messages: [] };
    return { success: true };
  };
  return {
    calls,
    bridge: {
      get: async (p) => { calls.push(['GET', p]); return answer(p); },
      post: async (p, b) => {
        calls.push(['POST', p, b]);
        if (p === '/chat') console.log(`      💬 <Angel_ICE> ${b.message}`);
        else if (!['/look', '/memory', '/stop'].includes(p)) console.log(`      🦾 ${p} ${JSON.stringify(b)}`);
        await new Promise(r => setTimeout(r, 150));
        return answer(p);
      },
    },
  };
}

async function sim (lines) {
  if (!CFG.baseUrl || !CFG.apiKey) { console.error('缺少 LLM_BASE_URL / LLM_API_KEY'); process.exit(1); }
  const body = mockBody();
  bridge = body.bridge;
  autopilot = { post: async () => ({}) };
  CFG.autonomy = false;
  console.log(`模拟：快脑=${CFG.fastModel}  主脑=${CFG.planModel}（假身体，真模型）\n`);
  for (const text of lines) {
    console.log(`  <Ka_sum1> ${text}`);
    const t0 = Date.now();
    const m = { t: Date.now(), who: 'Ka_sum1', text };
    remember(M.chat, m, 30);
    await handleChat([m]);
    console.log(`      ⏱ 首次反应 ${Date.now() - t0}ms`);
    // 等后台的动作/计划/汇报跑完
    const busy = () => M.planning || inflight || M.plan || (M.body.tool && M.body.tool !== 'follow');
    for (let i = 0, idle = 0; i < 360 && idle < 3; i++) {
      await new Promise(r => setTimeout(r, 500));
      idle = busy() ? 0 : idle + 1;
    }
    await new Promise(r => setTimeout(r, 300));
    console.log('');
  }
  console.log(`统计：${JSON.stringify(M.stats)}`);
  process.exit(0);
}

// ------------------------------------------------------------------ 自测

async function selftest () {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };
  const reset = () => {
    M.body = { owner: null, tool: null, args: null, since: 0, token: 0 };
    M.plan = null; M.events = []; M.chat = []; M.planning = false;
  };
  const body = mockBody();
  bridge = body.bridge;
  const yields = [];
  autopilot = { post: async (p, b) => { yields.push(b); return {}; } };
  console.log = ((orig) => (...a) => { if (!String(a[0]).startsWith('      ')) orig(...a); })(console.log);

  console.log('\n聊天解析');
  check('玩家发言', parseChat({ t: 1, position: 'chat', text: '<Ka_sum1> 安琪跟我来' }), { t: 1, who: 'Ka_sum1', text: '安琪跟我来' });
  check('系统消息不算', parseChat({ t: 1, position: 'system', text: '<x> y' }), null);
  check('加入消息不算', parseChat({ t: 1, position: 'chat', text: 'Ka_sum1 加入了游戏' }), null);

  console.log('\n快速通道（0ms，不过模型）');
  check('"安琪跟我来" → follow', matchFastPath('安琪跟我来')?.id, 'follow');
  check('"跟我來！" → follow（繁体+标点）', matchFastPath('跟我來！')?.id, 'follow');
  check('"Angel_ICE, stop" → stop', matchFastPath('Angel_ICE, stop')?.id, 'stop');
  check('"过来～" → come', matchFastPath('过来～')?.id, 'come');
  check('"你跟我来然后帮我挖矿" → 不走快速通道（复杂的交给模型）', matchFastPath('你跟我来然后帮我挖矿'), null);
  check('"停在那边的是什么" → 不误判成停', matchFastPath('停在那边的是什么'), null);

  console.log('\n点名判定');
  check('只有一个玩家在线：什么都算对她说', isAddressed('今天好累', 1), true);
  check('多人在线：没点名不算', isAddressed('今天好累', 2), false);
  check('多人在线：点名算', isAddressed('安琪你在哪', 3), true);

  console.log('\n身体仲裁');
  reset();
  const tp = await takeBody('plan');
  check('空闲时自主计划能拿到身体', tp, 1);
  M.body.tool = 'mine';
  const stopsBefore = body.calls.filter(c => c[1] === '/stop').length;
  const tu = await takeBody('player');
  check('玩家的事能抢占自主计划', tu, 2);
  check('抢占时先让身体停下（POST /stop）', body.calls.filter(c => c[1] === '/stop').length - stopsBefore, 1);
  check('抢到身体后让脑干让路', yields[yields.length - 1]?.ms, CFG.yieldMs);
  const tp2 = await takeBody('plan');
  check('自主计划抢不了玩家的事', tp2, null);
  releaseBody(1);
  check('旧 token 释放不了新主人的身体', M.body.owner, 'player');
  releaseBody(2);
  check('正确 token 能释放', M.body.owner, null);
  check('释放后把身体还给脑干', yields[yields.length - 1]?.ms, 0);

  console.log('\n自己的计划被玩家打断');
  reset();
  M.plan = { goal: '砍树', by: 'self', steps: [], i: 0 };
  await takeBody('player');
  check('玩家抢占时丢掉自己的计划', M.plan, null);
  reset();
  M.plan = { goal: '给玩家做木镐', by: 'player', steps: [], i: 0 };
  await takeBody('player');
  check('玩家交代的计划不被这一步丢掉', M.plan?.goal, '给玩家做木镐');

  console.log('\n执行一串动作');
  reset();
  let tok = await takeBody('player');
  let r = await runJob('player', [{ tool: 'goto', args: { x: 1, z: 2 } }, { tool: 'mine', args: { blockName: 'oak_log', count: 2 } }], tok);
  check('全部成功 → done', r.done, true);
  check('动作结果记进共享状态（给两个脑看）', M.events.map(e => e.tool), ['goto', 'mine']);
  reset();
  bridge.post = async (p, b) => (p === '/mine' ? { success: false, error: 'No path' } : { success: true });
  tok = await takeBody('player');
  r = await runJob('player', [{ tool: 'mine', args: { blockName: 'iron_ore' } }, { tool: 'craft', args: { itemName: 'x' } }], tok);
  check('中途失败 → 停在失败那步', [r.done, r.failedAt], [false, 0]);
  check('失败原因带上', /No path/.test(r.error), true);
  reset();
  bridge.post = async (p) => { await new Promise(res => setTimeout(res, 50)); return { success: true }; };
  tok = await takeBody('player');
  const job = runJob('player', [{ tool: 'mine', args: { blockName: 'a' } }, { tool: 'craft', args: { itemName: 'b' } }], tok);
  await takeBody('player');   // 玩家又下了新指令
  r = await job;
  check('被抢占 → 安静收手，不继续后面的步骤', [r.preempted, r.results.length], [true, 1]);
  reset();
  tok = await takeBody('player');
  r = await runJob('player', [{ tool: 'follow', args: { player: 'a' } }], tok);
  check('跟随是持续动作：做完不释放身体', [r.holding, M.body.owner], [true, 'player']);

  console.log('\n模型 ↔ 工具来回（假模型）');
  reset();
  bridge = mockBody().bridge;
  const script = [
    { tool_calls: [{ id: '1', function: { name: 'inventory', arguments: '{}' } }] },
    { tool_calls: [
      { id: '2', function: { name: 'say', arguments: '{"text":"好呀～"}' } },
      { id: '3', function: { name: 'mine', arguments: '{"blockName":"oak_log","count":3}' } },
      { id: '4', function: { name: 'delegate', arguments: '{"goal":"做木镐"}' } },
    ] },
  ];
  let seenTools = null;
  llm = async ({ messages, tools }) => { seenTools = seenTools || tools.map(t => t.function.name); return script.shift() || { content: '' }; };
  const cv = await converse({ model: 'x', system: 's', user: 'u', tools: toolsFor('fast'), maxRounds: 3, timeoutMs: 1000, owner: 'player' });
  check('查资料的工具会再来一轮，说话立即执行', cv.said, ['好呀～']);
  check('动作收集起来交给仲裁', cv.actions, [{ tool: 'mine', args: { blockName: 'oak_log', count: 3 } }]);
  check('复杂的事交给主脑', cv.delegate, '做木镐');
  reset();
  M.body = { owner: 'player', tool: 'follow', args: {}, since: 0, token: 7 };
  script.push({ tool_calls: [{ id: '5', function: { name: 'look_at', arguments: '{"player":"a"}' } }, { id: '6', function: { name: 'say', arguments: '{"text":"在跟着你呀"}' } }] });
  const cv2 = await converse({ model: 'x', system: 's', user: 'u', tools: toolsFor('fast'), maxRounds: 1, timeoutMs: 1000, owner: 'player' });
  check('转头是小动作：不排进身体队列，不打断跟随', [cv2.actions.length, M.body.tool, M.body.token], [0, 'follow', 7]);
  check('快脑有 delegate，没有 submit_plan', [seenTools.includes('delegate'), seenTools.includes('submit_plan')], [true, false]);
  check('主脑只能查资料和交计划（不能直接动身体）',
    toolsFor('plan').map(t => t.function.name).every(n => n === 'submit_plan' || TOOLS[n].kind === 'info'), true);

  reset();
  const script2 = [
    { tool_calls: [{ id: 'a', function: { name: 'inventory', arguments: '{}' } }] },
    { tool_calls: [{ id: 'b', function: { name: 'scan_blocks', arguments: '{}' } }] },
    { tool_calls: [{ id: 'c', function: { name: 'say', arguments: '{"text":"挖铁矿石再烧呀"}' } }] },
  ];
  let lastTools = null;
  llm = async ({ tools }) => { lastTools = tools.map(t => t.function.name); return script2.shift() || { content: '' }; };
  const cv3 = await converse({ model: 'x', system: 's', user: 'u', tools: toolsFor('fast'), maxRounds: 2, timeoutMs: 1000, owner: 'player', mustReply: true });
  check('查资料把轮数用光 → 追加一轮只给 say，保证开口', [cv3.said, lastTools], [['挖铁矿石再烧呀'], ['say']]);

  console.log('\n计划校验');
  check('say 的 message → text', normalizeStep({ tool: 'say', args: { message: 'hi' } }).args, { text: 'hi' });
  check('follow 的 name → player（不是 itemName）', normalizeStep({ tool: 'follow', args: { name: 'Ka' } }).args, { player: 'Ka' });
  check('参数名走样能纠正（item → itemName）', normalizeStep({ tool: 'craft', args: { item: 'stick', count: 4 } }).args, { count: 4, itemName: 'stick' });
  check('缺必填参数 → 退回', validateSteps([normalizeStep({ tool: 'craft', args: { count: 12 } })]), ['第 1 步 craft：缺参数 itemName']);
  check('查资料的工具不能放进计划', validateSteps([normalizeStep({ tool: 'inventory', args: {} })]).length, 1);
  check('合格的计划', validateSteps([normalizeStep({ tool: 'mine', args: { blockName: 'oak_log' } }), normalizeStep({ tool: 'say', args: { text: 'hi' } })]), []);

  console.log('\n.env 解析');
  const tmp = path.join(require('os').tmpdir(), `brain-env-${process.pid}`);
  fs.writeFileSync(tmp, '# 注释\nBRAIN_TEST_A=1\nBRAIN_TEST_B="x y"\n');
  process.env.BRAIN_TEST_A = 'keep';
  loadDotEnv(tmp);
  fs.unlinkSync(tmp);
  check('已有环境变量优先', process.env.BRAIN_TEST_A, 'keep');
  check('引号去掉', process.env.BRAIN_TEST_B, 'x y');

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

// ------------------------------------------------------------------ 入口

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else if (argv[0] === '--sim') sim(argv.slice(1).length ? argv.slice(1) : ['安琪跟我来', '你在干嘛呀', '帮我做一把木镐']);
  else main();
}

module.exports = { matchFastPath, parseChat, isAddressed, takeBody, releaseBody, runJob, converse, toolsFor, CFG, M };
