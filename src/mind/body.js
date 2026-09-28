'use strict';

/**
 * 她的身体：连网桥的手脚 + 查书（知识层）的工具 + 调模型。
 *
 * 从 brain.js 抽出来，给 mind.js（持续的意识流）用。这里**没有**任何"该怎么做"的判断 ——
 * 只有"能做什么"。判断归她自己（mind.js + 她自己写的记忆）。
 */

const fs = require('fs');
const path = require('path');
const knowledge = require('../knowledge/knowledge');
const speech = require('./speech');
const mem = require('./memory-store');
const storagePolicy = require('../body/storage-policy');
const paths = require('../paths');
// 世界 = 连的是哪个服务器（config.json 的 MC_HOST:MC_PORT）；每个世界一个家
try {
  const conf = JSON.parse(fs.readFileSync(paths.CONFIG, 'utf8'));
  mem.setWorld(`${process.env.MC_HOST || conf.MC_HOST || 'localhost'}:${process.env.MC_PORT || conf.MC_PORT || 25565}`);
} catch (_) { mem.setWorld(`${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || 25565}`); }

// ------------------------------------------------------------------ .env

function loadDotEnv (file = paths.ENV) {
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

const CFG = {
  bridge: process.env.MC_BRIDGE_URL || 'http://127.0.0.1:3001',
  botName: process.env.MC_BOT_USERNAME || 'Angle_ICE',
  baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.MIND_MODEL || process.env.BRAIN_FAST_MODEL || 'gemini-3.8-flash',
  fallback: process.env.MIND_FALLBACK || 'deepseek-v4.1-flash',
  // 备用线路：主线路（比如 Gemini 免费额度）被限流/过载时，换到另一家（比如中转站）
  fallbackBaseUrl: (process.env.LLM_FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
  fallbackApiKey: process.env.LLM_FALLBACK_API_KEY || '',
  // 第三层兜底（主人 2026-09-27）：susu 整条线路不通（主、备都 502）时，按顺序试 teamorouter 上的模型。
  // ⚠️ teamorouter 国内直连不通（实测 ECONNRESET），要代理：Node 24 设 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 就行
  backupBaseUrl: (process.env.LLM_BACKUP_BASE_URL || '').replace(/\/+$/, ''),
  backupApiKey: process.env.LLM_BACKUP_API_KEY || '',
  backupModels: (process.env.LLM_BACKUP_MODELS || 'deepseek-flash-free,deepseek-flash,gemini-3.8-flash').split(',').map(s => s.trim()).filter(Boolean),
  llmRetries: 2,
  actionTimeoutMs: 60000,
};

// 中转站整条线路都不通时的本机兜底，按顺序试（LOCAL_FALLBACKS=codex,workbuddy）。
// 默认空 = 不兜底：只用 susu 上的 gemini + deepseek 两个模型
//   codex      本机 Codex 命令行，ChatGPT 账号跑 gpt-6-luna（默认 xhigh）—— 实测 13–21 秒，最稳
//   workbuddy  本机 WorkBuddy AI 命令行（deepseek-v4.1-flash）—— 实测 8–10 秒
const LOCAL = { codex: require('./llm-codex.js'), workbuddy: require('./llm-workbuddy.js') };
const LOCAL_TIMEOUT = { codex: 45000, workbuddy: 30000 };
const localFallbacks = () => (process.env.LOCAL_FALLBACKS ?? '').split(',').map(s => s.trim())
  .filter(n => LOCAL[n] && !(n === 'workbuddy' && process.env.WORKBUDDY_FALLBACK === '0'));   // 旧开关仍然有效

// FTB 任务书（knowledge/quests.json）：按任务 id 或名字找任务
let QUESTS = null;
function findQuest (key) {
  if (!QUESTS) {
    const q = JSON.parse(require('fs').readFileSync(require('path').join(paths.KNOWLEDGE, 'quests.json'), 'utf8'));
    QUESTS = q.chapters.flatMap(ch => (ch.quests || []).map(x => ({ ...x, chapter: ch.title, group: ch.groupTitle })));
  }
  const k = String(key || '').trim();
  return QUESTS.find(x => x.id === k.toUpperCase()) || QUESTS.find(x => x.title === k) || QUESTS.find(x => x.title && k && (x.title.includes(k) || k.includes(x.title))) || null;
}

const saidRecently = [];   // 她最近 3 分钟说过的话（say 去重用）

// beforeAttack：她（mind）想动手打怪之前的最后一道闸。返回非空字符串 = 这一下不打了，
// 字符串原样当结果回给她（战斗本能在打时用它挡掉抢手，见 mind.js）。
const hooks = { onSay: () => {}, beforeSay: async () => {}, beforeAttack: () => '' };

const fullItemId = (name) => String(name || '').includes(':') ? String(name) : `minecraft:${name}`;

/**
 * “我身上的东西”必须同时包含原版物品栏和穿戴的精妙背包。
 * 精妙背包不开界面时只有上次可信快照；查询“有没有”时把新鲜度和能否证明没有一并返回，
 * 避免模型把“普通物品栏没看到”说成“我没有/死时掉了”。
 */
async function personalInventory ({ query = '' } = {}) {
  const [main, eq] = await Promise.all([
    bridge.get('/inventory').catch(e => ({ error: e.message, items: [] })),
    bridge.get('/equipment').catch(e => ({ error: e.message })),
  ]);
  const q = String(query || '').trim().toLowerCase();
  const matches = (id, display = '') => !q || id.toLowerCase().includes(q) || String(display).toLowerCase().includes(q) || knowledge.label(id).toLowerCase().includes(q);
  const tally = (entries) => {
    const out = {};
    for (const x of entries) {
      const id = fullItemId(x.name);
      if (matches(id, x.displayName)) out[id] = (out[id] || 0) + (+x.count || 0);
    }
    return out;
  };
  const ordinary = tally(main.items || []);
  const worn = (eq.curios || []).some(x => /backpack/.test(x)) || /backpack/.test(eq.equipment?.torso || '');
  const bp = eq.backpack;
  const readable = !!(bp && Number.isFinite(bp.slots) && bp.slots > 0 && bp.items && typeof bp.items === 'object');
  const backpack = {};
  if (readable) for (const [name, count] of Object.entries(bp.items)) {
    const id = fullItemId(name);
    if (matches(id)) backpack[id] = +count || 0;
  }
  const ageSeconds = readable && Number.isFinite(bp.at) ? Math.max(0, Math.round((Date.now() - bp.at) / 1000)) : null;
  const combined = { ...ordinary };
  for (const [id, count] of Object.entries(backpack)) combined[id] = (combined[id] || 0) + count;
  // 要断言“现在没有”，精妙背包必须刚看过；旧快照只能证明“上次看时有/没有”。
  const absenceProven = !!q && !main.error && (!worn || (readable && ageSeconds <= 30));
  return {
    scope: '普通物品栏和穿戴的精妙背包都是我的随身物品',
    query: query || null,
    ordinaryInventory: { readable: !main.error, items: ordinary, ...(main.error ? { error: main.error } : {}) },
    sophisticatedBackpack: worn
      ? (readable
          ? { worn: true, readable: true, lastCheckedSecondsAgo: ageSeconds, slots: bp.slots, used: bp.used, items: backpack }
          : { worn: true, readable: false, note: '内容暂时读不到，不代表空；先 open_backpack 刷新' })
      : { worn: false, readable: true, items: {} },
    combined,
    absenceProven,
    note: q && !Object.keys(combined).length
      ? (absenceProven ? '两处都查过，当前没有匹配物品' : '还不能说没有或掉了；先 open_backpack 刷新，再用同一 query 查询')
      : 'combined 是我全部随身物品中本次匹配到的结果',
  };
}

// ------------------------------------------------------------------ HTTP

async function httpJson (method, url, body, timeoutMs = 5000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
    if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`超时 ${timeoutMs}ms：${method} ${url.replace(/\?.*/, '')}`);
    throw e;
  } finally { clearTimeout(timer); }
}

const bridge = {
  get: (p, t) => httpJson('GET', CFG.bridge + p, undefined, t),
  post: (p, b, t) => httpJson('POST', CFG.bridge + p, b || {}, t),
};

// ------------------------------------------------------------------ 模型（OpenAI 兼容，带重试和熔断）

/**
 * 有的线路不管要不要都用流式（SSE：一行行 "data: {...}"）回（实测 susu 上的 deepseek-v4.1-flash）。
 * 把增量拼回一条完整的 message，和非流式的返回长得一样。
 */
function parseSSE (text) {
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  let finish = null; let usageOut = null; let model = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === '[DONE]' || !m[1].trim()) continue;
    let d; try { d = JSON.parse(m[1]); } catch (_) { continue; }
    if (d.error) return { error: d.error };
    model = d.model || model;
    if (d.usage) usageOut = d.usage;
    const ch = d.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const delta = ch.delta || ch.message || {};
    if (delta.content) msg.content += delta.content;
    if (delta.reasoning_content) msg.reasoning_content = (msg.reasoning_content || '') + delta.reasoning_content;
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? msg.tool_calls.length;
      const cur = msg.tool_calls[i] ||= { id: tc.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (!msg.tool_calls.length) delete msg.tool_calls;
  if (!msg.content) msg.content = null;
  return { model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage: usageOut };
}

const breaker = new Map();
const BREAKER_MS = 5 * 60 * 1000;

const recent = [];
const noTemp = new Set();   // 不接受 temperature 参数的模型（报过 400 的记住，以后不发）
const usage = { calls: 0, inTok: 0, outTok: 0, inChars: 0, cachedTok: 0, cachedKnown: 0, since: Date.now(), byModel: {} };

/**
 * HTTP 状态 → { retryable, kind }。**先按状态判，再按响应体内容判**（codex R-fix4-1 / R-fix4-4）。
 *
 * 为什么要单独抽出来：以前"是不是 400/403/404"和"响应体像不像 HTML / JSON 解析失败"
 * 是两条互不相干的判断 —— HTML 分支和"不是 JSON"分支直接 `retryable = true`，
 * 把**请求格式错的 400** 也当成了一时的过载去重试。同一份错的请求重发几次都一样。
 *
 * @param status HTTP 状态码
 * @param text   响应体原文（用来认内容审计 / 过载提示词）
 * @returns {{retryable:boolean, kind:string}}
 *   kind ∈ 'content'（内容审计，掐内容还有救）| 'request'（请求本身错，重试无用）
 *          | 'transient'（限流/网关/过载，重试有用）| 'unknown'
 */
function classifyHttpStatus (status, text = '') {
  // ① 内容审计（403 content_policy_violation）：原样重试没用，只有掐掉那段内容才可能过。
  //    但它**不是**普通的 retryable —— mind 单独走压缩分支，所以标记成 content。
  if (status === 403 && /content_policy_violation|content[_ ]?filter|safety|审核/i.test(text)) {
    return { retryable: false, kind: 'content' };
  }
  // ② 中转站排队 / 高负载有时也回 400（"当前模型高负载队列排队中，请稍候重试"）——
  //    这种是**一时**的：重试 / 换备用有用，必须在"400 = 请求错"之前先认出来。
  if (/overload|负载|排队|稍候重试|busy|capacity/i.test(text)) return { retryable: true, kind: 'transient' };
  // ③ 权限 / 不存在 / 请求格式错：同一份请求发给谁都一样，重试和换线路都没用。
  if (status === 400 || status === 403 || status === 404) return { retryable: false, kind: 'request' };
  // ④ 限流 / 网关 / 过载：重试有用，换线路也可能过。
  if (status === 429 || status >= 500) return { retryable: true, kind: 'transient' };
  return { retryable: false, kind: 'unknown' };
}

/**
 * 统一记账（codex R-fix4-5）。
 *
 * 以前 `inChars` 只在"成功解析到正常 message"之后才累计 —— 失败的请求、走本机
 * 命令行兜底的请求**只加了 `calls`、没加字符数**，于是审计报告里"每次 prompt 发出多少字符"
 * 对失败那部分完全是空的。现在**请求真正发出去之前**就记一次 prompt 字符数，
 * 让每条线路（主 / 备用 / 本地）都走同一个函数。
 *
 * @param route    线路名（main / backup / fallback / 本机命令行名）
 * @param model    模型名
 * @param inChars  这一轮 prompt 的字符数（必填，失败也要记）
 * @param inTok    真实 prompt token（有就记，没有记 0 —— 失败请求通常没有 usage）
 * @param outTok   真实 completion token（同上）
 * @param cached   命中前缀缓存的 token（undefined = 这条线路不给，不计入 cachedKnown）
 */
function recordUsage ({ route, model, inChars = 0, inTok = 0, outTok = 0, cached } = {}) {
  usage.calls++;
  usage.inChars += inChars;
  // 无 usage 的失败/兜底请求只记字符数，token 记 0（**不要**把 undefined 加进去变 NaN）
  usage.inTok += Number.isFinite(inTok) ? inTok : 0;
  usage.outTok += Number.isFinite(outTok) ? outTok : 0;
  const bm = usage.byModel[`${route}:${model}`] ||= { calls: 0, inTok: 0, outTok: 0, inChars: 0, cachedTok: 0, cachedKnown: 0 };
  bm.calls++; bm.inChars += inChars;
  bm.inTok += Number.isFinite(inTok) ? inTok : 0; bm.outTok += Number.isFinite(outTok) ? outTok : 0;
  if (Number.isFinite(cached)) { usage.cachedTok += cached; usage.cachedKnown++; bm.cachedTok += cached; bm.cachedKnown++; }
}

/** 成功拿到 usage 时补记真实 token / 缓存（字符数已在 recordUsage 里记过，不重复） */
function recordTokens ({ route, model, inTok, outTok, cached } = {}) {
  usage.inTok += Number.isFinite(inTok) ? inTok : 0;
  usage.outTok += Number.isFinite(outTok) ? outTok : 0;
  const bm = usage.byModel[`${route}:${model}`] ||= { calls: 0, inTok: 0, outTok: 0, inChars: 0, cachedTok: 0, cachedKnown: 0 };
  bm.inTok += Number.isFinite(inTok) ? inTok : 0; bm.outTok += Number.isFinite(outTok) ? outTok : 0;
  if (Number.isFinite(cached)) { usage.cachedTok += cached; usage.cachedKnown++; bm.cachedTok += cached; bm.cachedKnown++; }
}

async function callLLM ({ model, messages, tools, timeoutMs, signal, maxTokens = 1200, route = 'main' }) {
  const baseUrl = route === 'backup' ? CFG.backupBaseUrl : route === 'fallback' ? CFG.fallbackBaseUrl : CFG.baseUrl;
  const apiKey = route === 'backup' ? CFG.backupApiKey : route === 'fallback' ? CFG.fallbackApiKey : CFG.apiKey;
  if (!baseUrl || !apiKey) throw new Error('没配 LLM_BASE_URL / LLM_API_KEY');
  // ⚠️ 先算好 prompt 字符数，并在**发出去之前**记账（失败也要算上 —— R-fix4-5）。
  //    成功分支不再重复累计，只补真实 token / 缓存字段。
  const promptChars = JSON.stringify(messages).length;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  recordUsage({ route, model, inChars: promptChars });
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, max_tokens: maxTokens, ...(noTemp.has(model) ? {} : { temperature: 0.7 }) }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data;
    if (/^\s*data:/.test(text)) data = parseSSE(text);
    else if (/^\s*</.test(text)) {
      // 网关 / 限流页（HTML）。⚠️ 但**不能一律当成过载**（codex R-fix4-4）：
      // 先按 HTTP 状态判 400/403/404 —— 那些是"这份请求本身就不对"，重试和换线路都没用；
      // 只有 429/5xx 这类才真的是限流/网关抖了。
      const st = classifyHttpStatus(res.status, text);
      const e = new Error(`模型线路返回了网页（HTTP ${res.status}，多半是限流或网关出错）`);
      e.retryable = st.retryable; e.kind = st.kind; e.status = res.status; throw e;
    } else {
      try { data = JSON.parse(text); } catch (_) {
        const st = classifyHttpStatus(res.status, text);
        const e = new Error(`模型返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
        e.retryable = st.retryable; e.kind = st.kind; e.status = res.status; throw e;
      }
    }
    if (!res.ok || data.error) {
      if (res.status === 400 && /temperature/i.test(text) && !noTemp.has(model)) {
        noTemp.add(model);   // 换个参数马上再来一次，不算失败
        return callLLM({ model, messages, tools, timeoutMs, signal, maxTokens, route });
      }
      const st = classifyHttpStatus(res.status, text);
      const e = new Error(`模型报错 ${res.status}：${JSON.stringify(data.error || data).slice(0, 200)}`);
      e.retryable = st.retryable; e.kind = st.kind; e.status = res.status;
      throw e;
    }
    const msg = data.choices?.[0]?.message;
    // 中转站上游失败时会回一个"成功"的空壳（一个字没生成：没正文、没工具调用）—— 当成失败，重试或换备用线路
    if (msg && !msg.content && !(msg.tool_calls || []).length && !msg.reasoning_content && !(data.usage?.completion_tokens > 0)) {
      const e = new Error('模型回了个空壳（一个字没生成，多半是中转站上游失败）'); e.retryable = true; e.kind = 'transient';
      recent.push({ t: Date.now(), route, model, empty: true, raw: text.slice(0, 400) }); if (recent.length > 8) recent.shift();
      throw e;
    }
    // 最近几次模型的原样回复（排查"想了却什么都没做"用）
    recent.push({ t: Date.now(), route, model, ms: 0, promptMsgs: messages.length, promptChars: JSON.stringify(messages).length, finish: data.choices?.[0]?.finish_reason, raw: text.slice(0, 1500) });
    if (recent.length > 8) recent.shift();
    if (!msg) { const e = new Error(`模型返回里没有 message：${text.slice(0, 120)}`); e.retryable = true; e.kind = 'transient'; throw e; }
    // 用量：心里有数才能控制花费
    // inChars：这一轮发出去多少字符（审计报告量 token 用的就是它）；
    // cachedTok / cachedKnown：命中前缀缓存的部分（以前只记 prompt/completion，看不出缓存有没有生效）。
    // 中转站有的给 cached_tokens、有的给 prompt_tokens_details.cached_tokens，都给不到就记 0 并标 cachedKnown=0。
    const cached = data.usage?.cached_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens;
    // 字符数已经在发出去之前记过了（recordUsage 上面那次）；这里只补真实 token / 缓存字段
    recordTokens({ route, model, inTok: data.usage?.prompt_tokens, outTok: data.usage?.completion_tokens, cached });
    return msg;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw new Error('aborted');
      const err = new Error(`模型超时 ${timeoutMs}ms`); err.retryable = true; err.kind = 'timeout'; throw err;
    }
    if (e.retryable === undefined && !String(e.message).startsWith('模型')) { e.retryable = true; e.kind ||= 'network'; }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

let llm = async function (opts) {
  const model = opts.model || CFG.model;
  const fallback = model === CFG.model ? CFG.fallback : null;
  const fbRoute = CFG.fallbackBaseUrl && CFG.fallbackApiKey ? 'fallback' : 'main';
  const open = fallback && (breaker.get(model) || 0) > Date.now();
  // 中转站的毛病（空壳、网关页、503、限流）大多是一时的 —— 多试几次、两个模型轮着来。
  // 以前熔断期间备用模型只试一次，一回空壳就放弃了，她就说"卡了一下"（实测一天 20 次）
  const M = [model, 'main']; const F = fallback ? [fallback, fbRoute] : null;
  // 主模型失败一次就轮到备用：以前是 [主,主,备…]，主模型超时 25s×2 就撞上 40s 上限，备用一次都没试过，
  // 她站着发呆 50 秒（2026-09-27 实测两分钟里两次）
  const tries = !F ? [M, M, M] : open ? [F, F, M] : [M, F, M, F];
  const t0 = Date.now();
  let last;
  for (let i = 0; i < tries.length; i++) {
    const [m, route] = tries[i];
    try { return await callLLM({ ...opts, model: m, route }); } catch (e) {
      last = e;
      if (e.message === 'aborted') throw e;
      if (/ 429|RESOURCE_EXHAUSTED|quota/i.test(e.message)) e.retryable = true;
      if (!e.retryable) throw e;
      if (m === model && F) breaker.set(model, Date.now() + BREAKER_MS);
      if (Date.now() - t0 > 40000) break;   // 别让她为一句话等太久
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  // susu 整条线路都不通：换 teamorouter，按顺序每个模型试一次（deepseek-flash-free → deepseek-flash → gemini-3.8-flash）
  // 内容审计（403）另说：换一家模型多半能过（审计规则不同），但这条线路本身不是"不通"，别把它记成线路故障
  if (last?.message !== 'aborted' && last?.retryable !== false && CFG.backupBaseUrl && CFG.backupApiKey) {
    for (const m of CFG.backupModels) {
      try { return await callLLM({ ...opts, model: m, route: 'backup' }); } catch (e) {
        if (e.message === 'aborted') throw e;
        // ⚠️ 保留**原始**的 retryable / kind（codex R-fix4-1）：
        //    以前无条件 `last.retryable = true`，把"请求本身错 / 内容审计"这类
        //    不可重试的错误在包装时又标回可重试，上层于是对着同一份发不出去的输入反复重试。
        //    审计（content）要保住 kind，mind 才会走压缩分支；request 类保持不可重试。
        const keepRetryable = last?.retryable === false;
        last = new Error(`${last.message}；teamorouter ${m} 也没成：${e.message}`);
        last.retryable = keepRetryable ? false : (e.retryable !== false);
        last.kind = (last.kind === 'content' || e.kind === 'content') ? 'content' : (e.kind || last.kind);
      }
    }
  }
  // susu 整条线路都不通（两个模型都在它上面）：按顺序找本机的命令行兜底（另一家后端，慢，10–20 秒）
  if (last?.message !== 'aborted' && last?.retryable !== false) {
    const localChars = JSON.stringify(opts.messages).length;
    for (const name of localFallbacks()) {
      const L = LOCAL[name];
      if (!L.available()) continue;
      try {
        const r = await L.chat({ messages: opts.messages, tools: opts.tools, timeoutMs: LOCAL_TIMEOUT[name], signal: opts.signal });
        recent.push({ t: Date.now(), route: name, model: L.MODEL, raw: r.raw }); if (recent.length > 8) recent.shift();
        // 本机兜底也是"发出去了一次 prompt"—— 走同一个记账函数（以前只加 calls，字符数没记，R-fix4-5）
        recordUsage({ route: name, model: L.MODEL, inChars: localChars });
        return r.message;
      } catch (e) {
        if (e.message === 'aborted') throw e;
        recordUsage({ route: name, model: L.MODEL, inChars: localChars });   // 失败的兜底也记（它确实发了）
        // ⚠️ 2026-09-28 二轮审计（wbR2 新发现，中）：**别再无条件 `retryable = true`**。
        //    上面 teamorouter 那段刚按 R-fix4-1 保住"不可重试的错误不因包装而变成可重试"，
        //    这一段却又把它翻回去了：一个 404 / 400（"这份请求本身不对"）走完本机兜底
        //    仍失败后，`retryable` 被写成 `true`，mind 于是对着同一份发不出去的输入
        //    继续重试 / 退避 / 空转（正是 R-fix4-1 要消掉的行为）。判据只有一处
        //    （AGENTS §5）：沿用 `keepRetryable`，语义与上面那段完全一致。
        //    `kind` 同理：content 类的 kind 必须保住，不能被 `e.kind || last.kind` 冲掉。
        const keepRetryable = last?.retryable === false;
        last = new Error(`${last.message}；${name} 兜底也没成：${e.message}`);
        last.retryable = keepRetryable ? false : (e.retryable !== false);
        last.kind = (last.kind === 'content' || e.kind === 'content') ? 'content' : (e.kind || last.kind);
      }
    }
  }
  throw last;
};

function parseArgs (s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return { _unparsed: String(s).slice(0, 200) }; }
}

// ------------------------------------------------------------------ 做出某样东西（整条链）

/**
 * 玩家说"把羊肉做好"：真人会想 熟羊肉 ← 生羊肉 ← 家里食物箱有 → 去拿 → 烤 → 递过去。
 * 这些零件她都有（查配方、查家里存货、烧、给），但靠模型一步步自己串，中间哪步想歪就卡住或乱问。
 * 这里把整条链交给身体跑完；模型只需要把话理解成"做熟羊肉，做好给 Ka_sum1"。
 */
const HOW = {   // 配方类型 → 用哪只手做
  'minecraft:crafting_shaped': 'craft', 'minecraft:crafting_shapeless': 'craft',
  'minecraft:smelting': 'smelt', 'minecraft:smoking': 'smelt', 'minecraft:blasting': 'smelt',
  'farmersdelight:cooking': 'pot',
};

async function makeItem (itemName, count = 1, deliverTo = null, depth = 0, log = []) {
  const K = knowledge.load();
  const id = knowledge.resolve(itemName, 1)[0];
  if (!id) return { ok: false, error: `不认识「${itemName}」` };
  const invNow = async () => {
    const r = await bridge.get('/inventory').catch(() => ({ items: [] }));
    const m = new Map(); for (const i of r.items || []) { const k = i.name.includes(':') ? i.name : `minecraft:${i.name}`; m.set(k, (m.get(k) || 0) + i.count); }
    return m;
  };
  const inTag = (tag, x) => K.tags.get(`item:${tag}`)?.has(x);
  let inv = await invNow();
  // 已经有了：直接给
  if ((inv.get(id) || 0) >= count) {
    log.push(`身上就有 ${knowledge.label(id)}`);
  } else {
    const rs = (K.byOutput.get(id) || []).map(i => K.recipes[i]).filter(r => HOW[r.type] && r.in.length)
      .sort((a, b) => knowledge.recipeRank(a) - knowledge.recipeRank(b));
    if (!rs.length) {
      const how = knowledge.obtain(id).split('\n').slice(1, 4).join('；');
      return { ok: false, error: `${knowledge.label(id)} 做不出来（没有我能用的配方）`, howToGet: how, log };
    }
    const home = mem.getHome();
    const stockOf = (x) => {
      if (!home?.stock) return [];
      return Object.entries(home.stock).filter(([, b]) => (b.items || {})[x] > 0).map(([box, b]) => ({ box, n: b.items[x] }));
    };
    // 背在身上的背包：比回家拿近（里面有什么是上次打开时记下的）
    const bp = (await bridge.get('/equipment').catch(() => null))?.backpack?.items || {};
    let chosen = null; const why = [];
    for (const r of rs) {
      const per = r.out.find(o => o.item === id)?.count || 1;
      const times = Math.ceil((count - (inv.get(id) || 0)) / per);
      const plan = []; let ok = true;
      for (const sl of r.in) {
        const need = sl.count * times;
        const cands = sl.alts.flatMap(a => (a.item ? [a.item] : [...(K.tags.get(`item:${a.tag}`) || [])].slice(0, 200)));
        // 身上 > 家里记得的 > 能再做出来的
        const onMe = cands.find(x => (inv.get(x) || 0) >= need);
        if (onMe) { plan.push({ item: onMe, need, from: 'inv' }); continue; }
        const inPack = cands.find(x => (bp[x] || 0) + (inv.get(x) || 0) >= need);
        if (inPack) { plan.push({ item: inPack, need, from: 'backpack' }); continue; }
        const atHome = cands.map(x => ({ x, where: stockOf(x) })).find(c => c.where.reduce((a, w) => a + w.n, 0) + (inv.get(c.x) || 0) >= need);
        if (atHome) { plan.push({ item: atHome.x, need, from: 'home', where: atHome.where }); continue; }
        const craftable = depth < 2 && cands.find(x => (K.byOutput.get(x) || []).some(i => HOW[K.recipes[i].type]));
        if (craftable) { plan.push({ item: craftable, need, from: 'make' }); continue; }
        ok = false; why.push(`缺 ${sl.alts.slice(0, 2).map(a => knowledge.label(a.item || '#' + a.tag)).join(' 或 ')}×${need}`); break;
      }
      if (ok) { chosen = { r, times, plan }; break; }
    }
    if (!chosen) return { ok: false, error: `凑不齐 ${knowledge.label(id)} 的材料：${[...new Set(why)].slice(0, 3).join('；')}`, log };
    log.push(`${knowledge.label(id)}：用 ${chosen.r.type.split(':')[1]} 做，要 ${chosen.plan.map(p => `${knowledge.label(p.item)}×${p.need}${p.from === 'home' ? '（家里拿）' : p.from === 'backpack' ? '（背包里拿）' : p.from === 'make' ? '（先做）' : ''}`).join(' + ')}`);
    // 凑材料
    for (const p of chosen.plan) {
      inv = await invNow();
      const lack = p.need - (inv.get(p.item) || 0);
      if (lack <= 0) continue;
      if (p.from === 'backpack') {
        await bridge.post('/backpack/open', {}, 20000);
        const r = await bridge.post('/container/withdraw', { items: [{ item: p.item, count: lack }] }, 30000).catch(e => ({ took: {}, error: e.message }));
        await bridge.post('/container/close').catch(() => {});
        const got = (r.took || {})[p.item] || 0;
        log.push(`从背包里拿了 ${knowledge.label(p.item)}×${got}`);
        if (got < lack) return { ok: false, error: `背包里的 ${knowledge.label(p.item)} 不够（还差 ${lack - got}）`, log };
      } else if (p.from === 'home') {
        let left = lack;
        for (const w of p.where.sort((a, b) => b.n - a.n)) {
          if (left <= 0) break;
          const [x, y, z] = w.box.split(',').map(Number);
          await bridge.post('/container/open', { x, y, z }, 120000);
          const r = await bridge.post('/container/withdraw', { items: [{ item: p.item, count: left }] }, 30000).catch(e => ({ took: {}, error: e.message }));
          await bridge.post('/container/close').catch(() => {});
          left -= (r.took || {})[p.item] || 0;
          log.push(`去 (${w.box}) 拿了 ${knowledge.label(p.item)}×${(r.took || {})[p.item] || 0}`);
        }
        if (left > 0) return { ok: false, error: `家里的 ${knowledge.label(p.item)} 不够（还差 ${left}，记得的可能过时了）`, log };
      } else if (p.from === 'make') {
        const sub = await makeItem(p.item, lack, null, depth + 1, log);
        if (!sub.ok) return { ...sub, error: `先做 ${knowledge.label(p.item)} 没成：${sub.error}`, log };
      }
    }
    // 做
    const how = HOW[chosen.r.type];
    const want = count - (inv.get(id) || 0);
    let res;
    try {
      if (how === 'craft') res = await bridge.post('/craft2', { itemName: id, count: want }, 120000);
      else if (how === 'smelt') res = await bridge.post('/smelt', { itemName: chosen.plan[0].item, count: chosen.times }, 180000);
      else res = await bridge.post('/cook_pot', { itemName: id, count: chosen.times }, 300000);
    } catch (e) { return { ok: false, error: `${how === 'craft' ? '合成' : how === 'smelt' ? '烧' : '下锅'}没成：${e.message}`, log }; }
    log.push(`做好了：${JSON.stringify(res.got || res.crafted || res.cooked || res).slice(0, 80)}`);
  }
  if (deliverTo && depth === 0) {
    inv = await invNow();
    // 同一个配方可能做出别的变种（本包配方冲突常见）—— 按实际拿到的给
    const give = (inv.get(id) || 0) > 0 ? id : null;
    if (!give) return { ok: false, error: `做完了但身上没有 ${knowledge.label(id)}（可能做出来的是别的东西）`, log };
    const g = await bridge.post('/give', { itemName: give, count, player: deliverTo }, 60000).catch(e => ({ success: false, error: e.message }));
    log.push(g.confirmed ? `递给 ${deliverTo}，他接到了` : `递了，${g.error || g.note || '没看到他接'}`);
  }
  return { ok: true, made: id, count, log };
}

// ------------------------------------------------------------------ 工具

/**
 * 要去的地方比她高 3 格以上：寻路器不会从梯子顶迈出去（实测会把她一路带回楼下），
 * 所以先用梯子爬到那一层。附近没有往上的梯子就算了，交给寻路器试。
 */
// ------------------------------------------------------------------ 有审美地放东西：先看、再挑、再放、再核对
//
// 主人 2026-09-27：「她应该有自己的审美思考，放置任何东西之前先选好位置」。
// 以前 place 只收一个坐标，她只能"哪儿空放哪儿"。这里先 /survey 看清这一片的布局，
// 让模型当一次"自己的眼光"：说出对这片的看法，想 2–3 个位置和理由，挑一个；放不上就试下一个。

const FURNISH_RE = /chest|barrel|shulker|_bed$|crafting_table|furnace|smoker|anvil|enchanting|brewing|lectern|loom|stonecutter|grindstone|smithing|cartography|fletching|composter|bookshelf|cauldron|jukebox|flower_pot|torch|lantern|campfire|candle|stove|cooking_pot|skillet|cutting_board|keg|fridge|freezer|cabinet|table|chair|sofa|crate|drawer|waystone|painting|item_frame|banner|sign/;
const AESTHETIC_SYS = `你是 Angle_ICE 在 Minecraft 里摆东西时自己的眼光。给你一片地方的逐层俯视图（每种材质一个字母，图例在后），和要放的东西、用途。
先读懂这片：房子轮廓、墙、地板、屋顶、门、窗、走道（门里外两格、梯子口、常走的路）、已有的灯和家具、配色。
然后挑位置，原则：
- 不挡路：给你的"必须留空的路"格子绝对不放（门前后、梯子口、走道）；窗户正前方也不放
- 家具靠墙、成组、对齐：工作台/熔炉/箱子排成一排、同高度；和已有同类挨着或对称
- 床靠墙，床头顶墙；箱子靠墙成排，别放门口
- 火把/灯：离已有光源（光源列表）6 格以内不要再放 —— 已经够亮就回 candidates 为空、view 里说明；优先挂墙（位置选墙边的空气格，旁边就是墙），门两侧、柱子两侧对称；间距 6–8 格均匀；地上的火把放墙角，不放路中间；照亮会刷怪的暗处（darkFloor）
- 室外：沿路边、围栏边、屋角，间隔均匀；别在别人的建筑上乱放
- 和周围材质、风格搭（木屋配木质家具、暖色灯）
坐标必须是图上 '.'（空气）的格子（'@' 是你自己站的格子，不能选），旁边或下面有能附着的实心块；放地上的东西下面必须是实心块。
只输出 JSON：{"view":"一句话说这片是什么样、缺什么","placements":[{"item":"注册名","x":0,"y":0,"z":0,"mount":"wall|floor|ceiling","why":"一句话"}]}
要放几个就给几个 placements（同一种东西多个时排整齐：同一面墙、同一高度、挨着或等距）；觉得不用放（比如已经够亮）就给空数组。`;

function parseJsonLoose (text) {
  const t = String(text || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (_) { return null; }
}

/**
 * 有审美地放一批东西。先看有没有布置规划里留好的空格子（有就直接摆，不用再想）；
 * 剩下的一次想好全部位置再挨个放（主人：不应该放一个箱子布局一次）。
 * items: [{ itemName, count, purpose }]，或者 itemName + count。
 */
async function placeNicely ({ itemName, count = 1, items, purpose = '', x, y, z, r = 7 }) {
  const list = (items && items.length ? items : [{ itemName, count, purpose }]).filter(i => i && i.itemName)
    .map(i => ({ itemName: i.itemName, bare: String(i.itemName).replace(/^minecraft:/, ''), count: Math.min(Math.max(1, +i.count || 1), 16), purpose: i.purpose || purpose }));
  if (!list.length) throw new Error('itemName 要写放什么（或 items 列一批）');
  const inv = async () => { const m = {}; for (const it of (await bridge.get('/inventory')).items || []) m[it.name.replace(/^minecraft:/, '')] = (m[it.name.replace(/^minecraft:/, '')] || 0) + it.count; return m; };
  let have = await inv();
  for (const it of list) {
    if (!have[it.bare] && /(^|:)torch$/.test(it.itemName)) { await bridge.post('/make_torches', { count: 8 }, 60000).catch(() => null); have = await inv(); }
    it.count = Math.min(it.count, have[it.bare] || 0);
  }
  const lacking = list.filter(i => !i.count).map(i => i.itemName);
  const todo = list.filter(i => i.count);
  if (!todo.length) throw new Error(`身上没有 ${lacking.join('、')}，先去拿/做`);

  const placed = []; const tried = []; const views = []; const staled = [];
  // ① 现用现定：布置规划里有对应分区的，就到那个区里当场看布局、挑位置（区只记"大概哪一块"，格子现在才定）
  //    区里一个都放不下 → 标成"要重新想"（被改建了 / 满了），剩下的按没规划处理
  if (x == null) {
    const st = await bridge.get('/layout/status', 8000).catch(() => null);
    const zones = (st?.layouts || []).flatMap(L => (L.zoneDetail || []).map(zd => ({ ...zd, layoutId: L.id }))).filter(zd => !zd.stale && zd.area);
    for (const zd of zones) {
      const mine = todo.filter(i => i.count > 0 && zd.stillWant?.[i.bare]);
      if (!mine.length) continue;
      const before = mine.reduce((a, i) => a + i.count, 0);
      const r1 = await pickAndPlace(mine.map(i => ({ ...i, count: Math.min(i.count, zd.stillWant[i.bare]) })), zd.area, `这些要放进「${zd.name}」（${zd.purpose}）这一块`).catch(e => ({ placed: [], tried: [e.message] }));
      for (const p of r1.placed) { placed.push({ ...p, zone: zd.name }); const it = todo.find(i => i.bare === p.item); if (it) it.count--; }
      tried.push(...r1.tried); if (r1.view) views.push(`${zd.name}：${r1.view}`);
      if (!r1.placed.length && before) {
        staled.push(zd.name);
        await bridge.post('/layout/zone', { id: zd.layoutId, zone: zd.name, stale: true, why: `放不下 ${mine.map(i => i.bare).join('、')}` }, 5000).catch(() => null);
      }
    }
  }
  const rest = todo.filter(i => i.count > 0);
  if (!rest.length) return { placed, note: '都摆进规划的区里了', view: views.join('；') || undefined, lacking: lacking.length ? lacking : undefined };

  // ② 没有对应分区的（或区里放不下的）：看一眼这片（给了 x/y/z 就看那片，否则看她身边），一次想好全部位置
  const r2 = await pickAndPlace(rest, x != null && y != null && z != null ? { x, y, z, r } : { r }, '');
  placed.push(...r2.placed); tried.push(...r2.tried);
  if (!placed.length) throw new Error(`挑的位置都没放上：${tried.join('；')}（这片的看法：${r2.view || '-'}）—— 换个地方（x/y/z）再试`);
  const left = rest.filter(i => i.count > 0).map(i => `${i.itemName}×${i.count}`);
  return { placed, view: [...views, r2.view].filter(Boolean).join('；'), notPlaced: left.length ? left : undefined, tried: tried.length ? tried : undefined, lacking: lacking.length ? lacking : undefined,
    staleZones: staled.length ? staled : undefined,
    hint: staled.length ? `这些区放不下了、标成要重新想：${staled.join('、')}（下次 plan_layout 重划）` : (r2.placed.length ? '想让东西各归各位，先 plan_layout 划一下分区' : undefined) };
}

/**
 * 看一眼一片地方（area：{x,y,z,r} 或只有 r = 她身边），一次想好这批东西的位置并放下。
 * note：额外的要求（"这些要放进仓库区"）。返回 { placed:[{item,at,why}], tried:[…], view }；list 里每项的 count 会被减掉放上的数。
 */
async function pickAndPlace (list, area, note) {
  const rest = list; const placed = []; const tried = [];
  const { x, y, z } = area; const r = area.r || 7;
  const q = x != null && y != null && z != null ? `x=${x}&y=${y}&z=${z}&r=${r}` : `r=${r}`;
  const sv = await bridge.get(`/survey?${q}`, 8000);
  const user = [
    `要放：${rest.map(i => `${i.itemName}×${i.count}${i.purpose ? `（${i.purpose}）` : ''}`).join('、')}`,
    note ? `${note}（位置挑在中心 ${x},${y},${z} 半径 ${r} 以内）` : '',
    `中心 ${sv.center.x},${sv.center.y},${sv.center.z}；${sv.orientation}`,
    `固定符号：${sv.fixed}`, `材质图例：${sv.legend}`,
    `门：${sv.doors.join(' ') || '无'}`, `光源：${sv.lights.join(' ') || '无'}`, `家具：${sv.furniture.join(' ') || '无'}`,
    `会刷怪的暗地面（${sv.darkCount} 格）：${sv.darkFloor.join(' ') || '无'}`,
    `必须留空的路（门前后、梯子口、走道，这些格子绝不能放东西）：${(sv.keepClear || []).join(' ') || '无'}`,
    '', sv.layers,
  ].join('\n');
  const msg = await llm({ messages: [{ role: 'system', content: AESTHETIC_SYS }, { role: 'user', content: user }], timeoutMs: 40000, maxTokens: 1200 });
  const plan = parseJsonLoose(msg?.content);
  if (!plan || !Array.isArray(plan.placements)) throw new Error(`没想出位置（模型回的不是 JSON：${String(msg?.content || '').slice(0, 120)}）`);
  if (!plan.placements.length) return { placed, tried: ['看了一圈觉得不用放（已经够亮 / 没合适的地方）'], view: plan.view };
  const meP = (await bridge.get('/position').catch(() => null)) || {};
  const clear = new Set(sv.keepClear || []);
  const key = (c) => `${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}`;
  for (const c of plan.placements) {
    const it = rest.find(i => i.count > 0 && (i.bare === String(c.item || '').replace(/^minecraft:/, '') || rest.length === 1));
    if (!it) continue;
    if (clear.has(key(c)) && !/torch|lantern/.test(it.bare)) { tried.push(`(${key(c)}) 在路上`); continue; }
    if (Math.floor(c.x) === meP.x && Math.floor(c.z) === meP.z && (Math.floor(c.y) === meP.y || Math.floor(c.y) === meP.y + 1)) { tried.push(`(${key(c)}) 是自己站的格子`); continue; }
    try {
      await bridge.post('/go', { x: c.x, y: c.y, z: c.z, range: 3 }, 60000).catch(() => null);
      let r2;
      try { r2 = await bridge.post('/place', { itemName: it.itemName, x: c.x, y: c.y, z: c.z, mount: c.mount }, 20000); } catch (e) {
        if (!/holding|Not carrying/i.test(e.message)) throw e;
        await new Promise(res => setTimeout(res, 800));
        r2 = await bridge.post('/place', { itemName: it.itemName, x: c.x, y: c.y, z: c.z, mount: c.mount }, 20000);
      }
      void r2; it.count--; placed.push({ item: it.bare, at: key(c), why: c.why });
    } catch (e) { tried.push(`(${key(c)})：${e.message.slice(0, 80)}`); }
  }
  return { placed, tried, view: plan.view };
}


// ------------------------------------------------------------------ 设计一个工程（蓝图），之后 build_work 一点点施工
//
// 主人 2026-09-27：先对周围环境概念建模，再逐步增量填充或者挖多余方块；不一定要材料够了才开始。
// 风格参考：knowledge/style-guide.md（WorkBuddy 整理的本包审美规则 + 配色方案，全是真实 id）

let STYLE = null;
function styleGuide () {
  if (STYLE == null) { try { STYLE = require('fs').readFileSync(path.join(paths.KNOWLEDGE, 'style-guide.md'), 'utf8').slice(0, 6000); } catch (_) { STYLE = ''; } }
  return STYLE;
}
const DESIGN_SYS = `你是 Angle_ICE 自己的建筑眼光。看懂给你的这片地方（逐层俯视图、材质图例），按用途设计一个工程，输出蓝图。
要求：
- 和周围协调：沿用附近已有的材质配色（图例里有的优先），或者从风格指南的配色方案里挑一套；主色/辅色/点缀 6:3:1
- 先想清楚放在哪：不挡已有的门和路，贴着地形，地基落在实心地面上；要挖掉的地方用 "air"
- 不要压到已有的人造方块上（木板、楼梯、台阶、门、玻璃、栅栏、家具…），那些格子用 "-"（不管）；除非用途就是改造自己的建筑，那时在 JSON 里加 "allowDemolish": true
- 规模现实：一般 5×5～11×11，高不超过 7 层；越小越容易做完
- 结构：原木或去皮原木做柱和框，木板填墙，楼梯/台阶做屋顶檐口，留门洞（两格高的 air）和窗（玻璃板）
蓝图格式（只输出 JSON）：
{"name":"短名字","purpose":"用途","view":"一句话说这片现在什么样、你打算怎么改","origin":{"x":西北角x,"y":最底层y,"z":西北角z},
 "legend":{"P":"minecraft:oak_planks","L":"minecraft:oak_log",".":"air"},
 "layers":[{"dy":0,"rows":["LPPPL","P...P","LPPPL"]},{"dy":1,"rows":[...]}]}
rows 从北到南（z 增大），每行字符从西到东（x 增大）；每层 rows 数量和每行长度要一致；图例里没有的字符（比如 "-"）= 这格不管、保持原样。
legend 的值必须是真实注册名（带命名空间），"air" 表示这格要挖空。不要画门、床、箱子这类会被放歪的东西（之后用 place_nicely 摆）。`;

async function designBuild ({ purpose, asked = false, x, y, z, r = 8 }) {
  if (!purpose) throw new Error('purpose 写要盖/改什么（比如：家门口一个 5×5 的小仓库、河边一段木栈道、围一圈农田）');
  const q = x != null && y != null && z != null ? `x=${x}&y=${y}&z=${z}&r=${r}` : `r=${r}`;
  const sv = await bridge.get(`/survey?${q}`, 8000);
  const user = [
    `用途：${purpose}`, `中心 ${sv.center.x},${sv.center.y},${sv.center.z}；${sv.orientation}`,
    `固定符号：${sv.fixed}`, `材质图例：${sv.legend}`, `门：${sv.doors.join(' ') || '无'}`, `家具：${sv.furniture.slice(0, 12).join(' ') || '无'}`,
    '', sv.layers, '', '——风格指南（节选）——', styleGuide(),
  ].join('\n');
  const messages = [{ role: 'system', content: DESIGN_SYS }, { role: 'user', content: user }];
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (lastErr) messages.push({ role: 'user', content: `上一版蓝图不行：${lastErr}。改好再给一次，只输出 JSON。` });
    const msg = await llm({ messages, timeoutMs: 60000, maxTokens: 3000 });
    const bp = parseJsonLoose(msg?.content);
    if (!bp) { lastErr = '不是 JSON'; messages.push({ role: 'assistant', content: String(msg?.content || '').slice(0, 2000) }); continue; }
    try {
      const saved = await bridge.post('/project/save', { ...bp, purpose: bp.purpose || purpose, asked: !!asked }, 10000);
      return { ...saved, view: bp.view, origin: bp.origin, layers: bp.layers.length, next: '用 build_work 开始施工；缺的材料边做边弄' };
    } catch (e) { lastErr = e.message; messages.push({ role: 'assistant', content: JSON.stringify(bp).slice(0, 2000) }); }
  }
  throw new Error(`设计没成：${lastErr}`);
}


// ------------------------------------------------------------------ 布置规划：想好家里哪儿放什么
// 主人 2026-09-27：「也可以自己规划长期布局，想放什么箱子 / 什么炉灶 / 什么冰箱等」
// 家具目录 knowledge/furnishings.json（WorkBuddy 整理）；没有就用下面这份基础的
const BASIC_FURNISH = {
  storage: ['minecraft:chest', 'minecraft:barrel', 'farmersdelight:oak_cabinet', 'cookingforblockheads:fridge'],
  kitchen: ['farmersdelight:stove', 'farmersdelight:cooking_pot', 'farmersdelight:skillet', 'farmersdelight:cutting_board', 'cookingforblockheads:fridge', 'cookingforblockheads:sink', 'cookingforblockheads:counter'],
  smelting: ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'],
  workstation: ['minecraft:crafting_table', 'minecraft:stonecutter', 'minecraft:anvil', 'minecraft:smithing_table', 'minecraft:enchanting_table', 'minecraft:brewing_stand', 'minecraft:loom', 'minecraft:grindstone'],
  lighting: ['minecraft:lantern', 'minecraft:torch'],
};
let FURN = null;
function furnishCatalog () {
  if (FURN) return FURN;
  try {
    const c = JSON.parse(require('fs').readFileSync(path.join(paths.KNOWLEDGE, 'furnishings.json'), 'utf8'));
    FURN = Object.entries(c).filter(([k, v]) => Array.isArray(v)).map(([k, v]) => `${k}：${v.slice(0, 25).map(x => `${x.id}=${x.zh || ''}${x.use ? `(${String(x.use).slice(0, 24)})` : ''}${x.size && x.size !== '1格' ? `[${x.size}]` : ''}`).join('；')}`).join('\n');
  } catch (_) { FURN = Object.entries(BASIC_FURNISH).map(([k, v]) => `${k}：${v.join('；')}`).join('\n'); }
  return FURN;
}

const LAYOUT_SYS = `你是 Angle_ICE 在给自己家做布置规划：想好**哪一块**做什么。
**现用现定**（主人 2026-09-27：规划太超前会赶不上变化 —— 后期还有机械动力、售货箱一大堆）：
- 只划**分区**，不定格子：每个区写用途、打算放什么（现在用得上、近期做得出来的）、大概在哪一片（中心 + 半径 2–6）
- 具体放哪一格，等东西真到手了再当场看布局挑（place_nicely 会在这个区里挑），所以这里不要写坐标格子
- 以后的东西（机器、自动化、大件）不划区，只在 view 里说一句"哪块空地留给以后"
- 有旧规划就在上面续写：同名的区会被这次的替换，没提到的区保留
先读懂这片（逐层俯视图、图例、门、已有家具、必须留空的路），再分区（这个阶段 2–5 个区）：
- 仓库（箱子/木桶靠墙成排）、厨房（炉灶+锅挨着，砧板、冰箱、水槽成一条操作台）、冶炼角（熔炉/高炉/烟熏炉并排）、
  工作区（工作台、切石机、铁砧、锻造台…）、照明（灯笼/火把）
- 区的范围要落在能站、能放东西的地面上，别压在"必须留空的路"上；已有的家具算进对应的区
只输出 JSON：{"name":"短名","view":"一句话说这个家现在什么样、打算怎么分区","area":{"x":中心x,"y":中心y,"z":中心z,"r":半径},
 "zones":[{"name":"冶炼角","purpose":"一句话","wants":{"minecraft:furnace":2,"minecraft:blast_furnace":1},"area":{"x":0,"y":0,"z":0,"r":3}}]}
wants 里的名字必须是给你的家具目录里的真实注册名，数量写这个阶段想要的。`;

async function planLayout ({ wishes = '', x, y, z, r = 10 }) {
  const q = x != null && y != null && z != null ? `x=${x}&y=${y}&z=${z}&r=${r}` : `r=${r}`;
  const sv = await bridge.get(`/survey?${q}`, 10000);
  const old = await bridge.get('/layout/status', 8000).catch(() => null);
  // 现在的进度：身上有什么、工具到了哪一级、家里存着什么（规划只管这个阶段）
  const items = ((await bridge.get('/inventory').catch(() => null))?.items || []).map(i => i.name.replace(/^minecraft:/, ''));
  const tier = ['netherite', 'diamond', 'iron', 'stone', 'wooden'].find(t => items.some(n => n.startsWith(`${t}_pickaxe`))) || '还没有镐子';
  const homeStock = (() => { try { return mem.renderHomeStock(null, (id) => id.replace(/^minecraft:/, ''), 30).slice(0, 800); } catch (_) { return ''; } })();
  const progress = `现在的进度：工具等级 ${tier}；身上有 ${[...new Set(items)].slice(0, 40).join('、') || '没什么'}${homeStock ? `；家里存着 ${homeStock.replace(/\n/g, ' ')}` : ''}`;
  const latest = old?.layouts?.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  const user = [
    progress,
    wishes ? `想要：${wishes}` : '按一个正常人的家来规划',
    `中心 ${sv.center.x},${sv.center.y},${sv.center.z}；${sv.orientation}`, `固定符号：${sv.fixed}`, `材质图例：${sv.legend}`,
    `门：${sv.doors.join(' ') || '无'}`, `光源：${sv.lights.join(' ') || '无'}`, `已有家具：${sv.furniture.join(' ') || '无'}`,
    `必须留空的路：${(sv.keepClear || []).join(' ') || '无'}`,
    old?.layouts?.length ? `已有的规划：${old.layouts.map(l => `${l.name}（${l.zones.join('；')}）`).join(' / ')}` : '',
    '', sv.layers, '', '——家具目录——', furnishCatalog(),
  ].join('\n');
  const messages = [{ role: 'system', content: LAYOUT_SYS }, { role: 'user', content: user }];
  const msg = await llm({ messages, timeoutMs: 60000, maxTokens: 3500 });
  const L = parseJsonLoose(msg?.content);
  if (!L || !Array.isArray(L.zones)) throw new Error(`没规划出来（模型回的不是 JSON：${String(msg?.content || '').slice(0, 120)}）`);
  L.area ||= { ...sv.center, r };
  for (const z of L.zones) delete z.slots;   // 现用现定：只要分区，模型多给的格子不要
  // 续写：同一个家已经有规划，同名的区用这次的替换（旧区里的格子就此作废），没提到的区保留
  if (latest) {
    const full = (await bridge.get(`/layout/status?id=${latest.id}&full=1`, 8000).catch(() => null))?.full;
    if (full) {
      const keep = (full.zones || []).filter(z0 => !L.zones.some(z => z.name === z0.name)).map(z0 => ({ name: z0.name, purpose: z0.purpose, wants: z0.wants, area: z0.area, slots: z0.slots }));
      L.zones = [...keep.map(z0 => (z0.slots && !z0.area ? { ...z0 } : z0)), ...L.zones];
    }
    L.id = latest.id;
  }
  // 旧区还带格子的：交给 hands 按格子推出范围和想要的东西（它能读两种格式），这里把格子转成 wants/area 统一成新格式
  for (const z of L.zones) {
    if (z.slots?.length && !z.area) {
      const sl = z.slots; const c = sl.reduce((a, q) => ({ x: a.x + q.x / sl.length, y: a.y + q.y / sl.length, z: a.z + q.z / sl.length }), { x: 0, y: 0, z: 0 });
      z.area = { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z), r: Math.min(8, Math.max(2, Math.ceil(Math.max(...sl.map(q => Math.hypot(q.x - c.x, q.z - c.z))) + 1))) };
      z.wants ||= sl.reduce((w, q) => ((w[q.item] = (w[q.item] || 0) + 1), w), {});
    }
    delete z.slots;
  }
  let saved = await bridge.post('/layout/save', L, 15000);
  // 有被退回的格子：把原因告诉她，让她换位置再补一轮
  if (saved.rejected?.length) {
    messages.push({ role: 'assistant', content: JSON.stringify(L).slice(0, 3000) },
      { role: 'user', content: `这些区不行：${saved.rejected.join('；')}。只给替换它们的区（换个范围 / 换真实的方块名），格式 {"zones":[{"name":"区名","purpose":"…","wants":{…},"area":{…}}]}，只输出 JSON。` });
    const fix = parseJsonLoose((await llm({ messages, timeoutMs: 40000, maxTokens: 1500 }).catch(() => null))?.content);
    if (fix?.zones) {
      for (const fz of fix.zones) { delete fz.slots; const i = L.zones.findIndex(z => z.name === fz.name); if (i >= 0) L.zones[i] = fz; else L.zones.push(fz); }
      saved = await bridge.post('/layout/save', { ...L, id: saved.id }, 15000);
    }
  }
  const st = await bridge.get(`/layout/status?id=${saved.id}`, 8000).catch(() => null);
  return { ...saved, view: L.view, zones: st?.layouts?.[0]?.zones, stillWant: st?.layouts?.[0]?.stillWant, next: '东西到手了再 place_nicely / furnish —— 那时在对应的区里当场挑位置' };
}

async function upstairsFirst (targetY) {
  const me = await bridge.get('/position').catch(() => null);
  const y = me?.exact?.y ?? me?.y;
  if (typeof y !== 'number' || typeof targetY !== 'number') return null;
  if (targetY - y >= 3) return bridge.post('/climb_up', { targetY }, 120000).catch(() => null);
  if (y - targetY >= 3) return bridge.post('/climb_down', { targetY }, 120000).catch(() => null);
  return null;
}

/**
 * 说出口之前把物品/方块的注册名换成中文（minecraft:iron_ingot → 铁锭，oak_log → 橡木原木）。
 * 工具结果里满是英文 id，她偶尔会照抄进聊天 —— 真人不会说 "iron_ingot"。
 * 认不出的原样留着（不猜）；玩家名（Ka_sum1 这种带数字/大写的）不会被当成 id。
 */
function humanizeIds (text) {
  const zh = (id) => { const l = knowledge.label(id); return l && l !== id ? l.replace(/\([^)]*\)$/, '') : null; };
  return String(text)
    .replace(/\b([a-z0-9_.-]+):([a-z0-9_/.-]+)\b/g, (m) => zh(m) || m)
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (m) => zh(`minecraft:${m}`) || m);
}

const TOOLS = {
  say: {
    kind: 'speech',
    desc: '在游戏聊天里说话。先写 inner（此刻的你，他看不见），再写 text（说出口的）。像打字那样：几条短消息，用换行分开，每条不超过 12 个字（会按这个样子一条条发出去）。urgent=true 是危险提示，一条说完不拆。',
    // inner 放第一个：模型按字段顺序写，先写此刻的自己，话再从里面长出来。
    // 思路借自 HDS Interlude（_ref/hds-interlude）"先写剧本、再写 interaction"的输出顺序。
    // 以前让她先在正文里写心里话，结果常常只写了心里话、不调 say（2026-09-27 跑分：12 题做了事一声不吭）；
    // 放进同一个调用里，想和说就分不开了。
    params: {
      inner: { type: 'string', description: '先写这个：此刻的你 —— 手上在忙什么、身上什么感觉、他这句话让你想到什么。一句，他看不见' },
      text: { type: 'string', description: '说出口的话' },
      urgent: { type: 'boolean' },
    },
    required: ['text'],
    run: async ({ text, urgent }) => {
      const t = humanizeIds(String(text || '').trim()).slice(0, 400);
      if (!t) return { ok: false, error: 'empty' };
      let parts = urgent ? [t.replace(/\n+/g, ' ').slice(0, 256)] : speech.segment(t, { maxSegments: 3 });
      // 同一句 3 分钟内不再说（实测：连着两轮"天亮了/早呀"、一轮里"好/来啦"说两遍）。危险提示不拦
      if (!urgent) {
        const now = Date.now();
        while (saidRecently.length && now - saidRecently[0].t > 3 * 60 * 1000) saidRecently.shift();
        const seen = new Set(saidRecently.map(r => r.k));
        // 只有标点的（一个「？」）也是一句话，用原文当去重的键；以前字为空就被当成空话丢掉了
        const keyOf = (x) => speech.wordsOnly(x) || String(x).trim();
        parts = parts.filter(x => { const k = keyOf(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
        if (!parts.length) return { ok: true, sent: [], note: '这些刚刚都说过了，没再发' };
        for (const x of parts) saidRecently.push({ k: keyOf(x), t: now });
      }
      await hooks.beforeSay(parts[0]);   // 像人一样要点时间打字（见 mind.js）
      if (parts.length === 1) await bridge.post('/chat', { message: parts[0] });
      else {
        // 条间停顿按下一条的字数算（打字要时间），再加点随机
        await bridge.post('/chat', { messages: parts, gapMs: [350 + speech.len(parts[1]) * 60, 700 + speech.len(parts[1]) * 80] }, 20000);
      }
      hooks.onSay(parts.join(' / '));
      return { ok: true, sent: parts };
    },
  },



  inventory: {
    kind: 'info',
    desc: '查看自己的全部随身物品：普通物品栏 + 穿戴的精妙背包。查某样东西时把名字写进 query；只有返回 absenceProven=true 才能说“我没有”，否则先 open_backpack 刷新，不能猜是掉了。',
    params: { query: { type: 'string', description: '要找的物品名，如 铁锭、粗铁；不填则列出全部随身物品' } }, required: [],
    run: personalInventory,
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


  stop: {
    kind: 'action',
    desc: '停下手上的一切动作，站着别动（之后 20 秒连地上的东西也不会自己去捡）。',
    params: {}, required: [],
    // hold：告诉身体这是"站住"，不是"换件事做"—— 本能也跟着歇一会儿（见 instinct.js）
    run: async () => bridge.post('/stop', { hold: true }),
  },
  instinct: {
    kind: 'action',
    desc: '开关身体的本能（闲着时身体自己做的事，默认都开）。pickup = 捡附近地上的东西；harvest = 收家里成熟的庄稼并补种；'
      + 'mine = 看见值钱的矿就去挖；sleep = 夜里在家有床就睡；armor = 捡到更好的护甲就换上；gaze = 有人在旁边就看看他；'
      + 'combat = 怪冲你或冲玩家来就打（苦力怕躲开、远程怪没盾就躲、血少就跑）；'
      + 'tidy = 身上满了先装精妙背包、缺吃的/镐子/武器/搭脚方块先从背包拿，都不行再回家整理；'
      + 'loot = 看见没开过的箱子就去开、认出地牢/神殿/矿井这类建筑就进去找宝箱；cave = 挖到天然洞穴就进去逛（边走边插火把）；'
      + 'bridge = 走不过去时用身上的搭脚方块垫路（家里不垫）；mlg = 带着水桶时敢往下跳、落地前倒水保命再收回；'
      + 'dig = 寻路时挖挡路的天然石头泥土（家里和建筑旁边不挖）；cmd = 死了回去捡东西（有 /back 就用）、在家顺手 /sethome、夜里离家太远或快死了用 /home。'
      + '别人说"别捡了""别动我的地""别乱挖""别盯着我"就关掉对应那个；只给要改的那几个。',
    params: Object.fromEntries(['pickup', 'harvest', 'mine', 'sleep', 'armor', 'gaze', 'combat', 'tidy', 'loot', 'cave', 'bridge', 'mlg', 'dig', 'cmd'].map(k => [k, { type: 'boolean' }])), required: [],
    run: async (a) => bridge.post('/instinct', Object.fromEntries(['pickup', 'harvest', 'mine', 'sleep', 'armor', 'gaze', 'combat', 'tidy', 'loot', 'cave', 'bridge', 'mlg', 'dig', 'cmd'].filter(k => typeof a[k] === 'boolean').map(k => [k, a[k]]))),
  },
  follow: {
    kind: 'action', continuous: true,
    desc: '一直跟着某个玩家，直到被叫停或有新的事。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => bridge.post('/follow', { playerName: player }),
  },
  come_to: {
    kind: 'action',
    desc: '走到某个玩家身边（上下楼、开挡路的门都会自己处理；到了就停，不会一直跟）。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => bridge.post('/go', { player, range: 2 }, 120000),
  },

  goto: {
    kind: 'action',
    desc: '走到某个坐标旁边（目标是箱子、炉子这种方块也行，会走到它旁边）。上下楼、开挡路的门都会自己处理；到不了会告诉你还差多远、试过什么。y 可省略。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'],
    run: async ({ x, y, z }) => bridge.post('/go', y == null ? { x, z } : { x, y, z }, 120000),
  },

  climb: {
    kind: 'action',
    desc: '上楼：自己找附近往上的梯子，爬到顶、推开活板门、迈到楼上的地板；给 targetY（想到的高度，比如玩家脚下的 y）就一段段一直爬上去。走不上楼的时候用这个。',
    params: { targetY: { type: 'number' } }, required: [],
    run: async ({ targetY }) => bridge.post('/climb_up', targetY == null ? {} : { targetY }, 120000),
  },

  climb_down: {
    kind: 'action',
    desc: '下楼：自己找地板上往下的梯子口（洞口/活板门），推开、顺着梯子滑下去；给 targetY 就一段段一直下到那个高度。',
    params: { targetY: { type: 'number' } }, required: [],
    run: async ({ targetY }) => bridge.post('/climb_down', targetY == null ? {} : { targetY }, 120000),
  },
  look_around: {
    kind: 'info',
    desc: '看清身边的立体地形：按高度一层层画出俯视图（墙、空气、梯子、门开关、水、岩浆…）。走不过去、上不去下不来、想弄清楚怎么过去时先看这个。r 是半径（默认 3）。',
    params: { r: { type: 'number' }, below: { type: 'number' }, above: { type: 'number' } }, required: [],
    run: async ({ r, below, above }) => bridge.get(`/look_around?r=${r || 3}&below=${below ?? 2}&above=${above ?? 3}`),
  },
  motor: {
    kind: 'action',
    desc: '自己编一套身体动作并执行（现成动作做不到的时候用：跳过缺口、钻洞、翻过去、爬/下梯子的特殊情况…）。steps 按顺序：{look:{x,y,z}} 看向某点；{hold:["forward","jump",…], ms, until:{yAtLeast|yAtMost|inCell:{x,z}|stopped:true}} 按住键直到条件成立或时间到；{activate:{x,y,z}} 右键方块；{nudge:{x,z}} 蹲着微调到精确位置；{wait:ms}。键：forward back left right jump sneak sprint。会回报每一步的位置和是否撞到东西 —— 看结果再调整；成功了用 save_skill 存下来。',
    params: { steps: { type: 'array', items: { type: 'object' } } }, required: ['steps'],
    run: async ({ steps }) => bridge.post('/motor', { steps }, 40000),
  },
  wiggle: {
    kind: 'action',
    desc: '卡住了就跳一跳、前后左右晃一晃（会避开岩浆和高的地方），挪开了就停。',
    params: { rounds: { type: 'number' } }, required: [],
    run: async (a) => bridge.post('/wiggle', a),
  },
  nudge: {
    kind: 'action',
    desc: '微调身位：蹲着小步挪到一格里的精确位置（x、z 可以带小数，比如 34.7, -135.3），每步核对，不会从边上掉下去。卡在边上、要对准梯子/洞口/门缝、要站到方块某一侧时用。',
    params: { x: { type: 'number' }, z: { type: 'number' }, tol: { type: 'number' } }, required: ['x', 'z'],
    run: async (a) => bridge.post('/nudge', a, 20000),
  },
  unequip: {
    kind: 'action',
    desc: '把身上穿着/拿着的东西脱下来放回背包（slot: head 头 / torso 身 / legs 腿 / feet 脚 / off-hand 副手 / hand 手上，或者直接给 itemName）。要把装备给别人，先脱下来再 give。',
    params: { slot: { type: 'string', enum: ['head', 'torso', 'legs', 'feet', 'off-hand', 'hand'] }, itemName: { type: 'string' } }, required: [],
    run: async (a) => bridge.post('/unequip', a),
  },
  door: {
    kind: 'action',
    desc: '开/关一扇门、栅栏门或活板门（open=true 开，false 关；已经是那样就不动）。你自己打开的门，走过去后身体会习惯性地关回去；要让它一直开着（比如赶动物进圈）就加 keepOpen=true。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, open: { type: 'boolean' }, keepOpen: { type: 'boolean' } },
    required: ['x', 'y', 'z', 'open'],
    run: async (a) => bridge.post('/door', a, 30000),
  },
  look_at: {
    kind: 'gesture',
    desc: '转头看向某个玩家。',
    params: { player: { type: 'string' } }, required: ['player'],
    run: async ({ player }) => bridge.post('/look', { playerName: player }),
  },
  mine: {
    kind: 'action',
    desc: '挖你看得见的某种方块若干个（如 oak_log、stone、sand）。只挖视线里的，挖完顺着相连的接着挖（树干、矿脉）。埋在地下的矿看不见 —— 找矿用 delve。用注册名（英文 id）。',
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
    desc: '按本整合包的真实配方合成（背包 2×2 或附近 4 格内的工作台）。先用普通背包；如果材料不在手上，自动转完整制作链检查精妙背包和家里库存，不要因为一次直接合成失败就自行回家。count 是要做的次数，默认 1，除非玩家明确说数量，不要把库存总数填进去。为避免误把原料耗光，批量合成会至少留一份材料。用注册名或中文名。',
    params: { itemName: { type: 'string' }, count: { type: 'number' } }, required: ['itemName'],
    run: async ({ itemName, count }) => {
      const n = count || 1;
      try { return await bridge.post('/craft2', { itemName, count: n }, CFG.actionTimeoutMs); }
      catch (e) {
        // 直接 craft 只看普通背包；材料可能在精妙背包或家里。交给 makeItem 重新规划，
        // 不把“缺材料”误翻译成“回家”。其它错误原样返回，避免掩盖真正的合成故障。
        if (/材料不够|缺\s|凑不齐|没有.*配方/.test(String(e.message || ''))) return makeItem(itemName, n);
        throw e;
      }
    },
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
    desc: '穿戴装备：盔甲、模组装备、饰品（戒指、项链；背包会背到背饰格上）。会自己判断该放哪个槽，放不进就试右键穿上。',
    params: { itemName: { type: 'string' } }, required: ['itemName'],
    run: async ({ itemName }) => bridge.post('/wear', { itemName }),
  },
  quest_submit: {
    kind: 'action',
    desc: 'FTB 任务书：交一个任务 —— 点对号（checkmark）的任务、交物品的任务都用它（相当于打开任务书点对号/点提交）。quest 写任务名或任务 id。交物品的要身上有那些东西。返回服务器回了什么（有回应才说明交上了）。',
    params: { quest: { type: 'string' } }, required: ['quest'],
    run: async ({ quest }) => {
      const q = findQuest(quest);
      if (!q) return { ok: false, error: `任务书里没找到「${quest}」` };
      const tasks = q.tasks.filter(t => t.id && (t.type === 'checkmark' || t.type === 'item'));
      if (!tasks.length) return { ok: false, error: `「${q.title}」没有能点对号或交物品的任务（${q.tasks.map(t => t.type).join('、')}，这些要在游戏里做到才算）` };
      const results = [];
      for (const t of tasks) results.push({ task: t.summary, ...(await bridge.post('/ftbq/submit', { taskId: t.id })) });
      return { ok: true, quest: q.title, chapter: q.chapter, results, note: q.group === '机械动力' ? '⚠️ 机械动力章节的任务 id 可能和服务器对不上（加载时重新生成过），没有服务器回应就是没交上' : undefined };
    },
  },
  quest_claim: {
    kind: 'action',
    desc: 'FTB 任务书：领奖励。给 quest（任务名或 id）就领那个任务的奖励；不给就一键领取所有能领的。多选一的奖励用 choice 选第几个（从 0 数；新手小屋 0 = 森林小屋，自带床和箱子）。',
    params: { quest: { type: 'string' }, choice: { type: 'number' } }, required: [],
    run: async ({ quest, choice } = {}) => {
      if (!quest) return bridge.post('/ftbq/claim_all', {});
      const q = findQuest(quest);
      if (!q) return { ok: false, error: `任务书里没找到「${quest}」` };
      const results = [];
      // 点对号的任务要先点对号（提交）才能领；以前直接领，服务器不给，她说"领了还是啥都没有"（新手礼包）
      for (const t of (q.tasks || []).filter(x => x.type === 'checkmark' && x.id)) {
        results.push({ task: '点对号', ...(await bridge.post('/ftbq/submit', { taskId: t.id }).catch(e => ({ error: e.message }))) });
      }
      if (results.length) await new Promise(res => setTimeout(res, 600));
      for (const r of q.rewards.filter(x => x.id)) {
        if (r.type === 'choice') results.push({ reward: r.summary, choice: choice || 0, ...(await bridge.post('/ftbq/claim_choice', { rewardId: r.id, index: choice || 0 })) });
        else results.push({ reward: r.summary, ...(await bridge.post('/ftbq/claim', { rewardId: r.id })) });
      }
      return { ok: true, quest: q.title, results };
    },
  },
  place_structure: {
    kind: 'action',
    desc: '放建筑蓝图（新手小屋的「结构生成器」）：站在平地上或给 x y z（地面方块），先出预览再潜行右键放下。放之前选好地方（平地、离水和资源近），这是一次性的。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: [],
    run: async (a) => bridge.post('/place_structure', a, 60000),
  },
  open_backpack: {
    kind: 'action',
    desc: '打开身上的背包（背在背饰上的或者背包栏里的，相当于按 B）。打开后用 store_items / take_items 存取，做完 container_close。身上满了、东西多了可以先装进去。',
    params: {}, required: [],
    run: async () => bridge.post('/backpack/open', {}),
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
  store_items: {
    kind: 'action',
    desc: '一次把背包里的东西存进当前打开的箱子（像按住 Shift 一路点，不用一格一格放）。items 写要存的：物品名、分类（食物 / 作物种子 / 矿物 / 木头 / 方块 / 工具装备 / 其他）或 #标签；all=true 全存，keep 写要留在身上的。',
    params: { items: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' }, keep: { type: 'array', items: { type: 'string' } } }, required: [],
    run: async (a) => bridge.post('/container/deposit', a, 30000),
  },
  take_items: {
    kind: 'action',
    desc: '一次从当前打开的箱子拿多样东西。items：物品名/分类，或 {item, count}；all=true 全拿。',
    params: { items: { type: 'array', items: {} }, all: { type: 'boolean' } }, required: [],
    run: async (a) => bridge.post('/container/withdraw', a, 30000),
  },
  organize_storage: {
    kind: 'action',
    desc: '整理仓库：周围所有箱子统一分类（每个箱子管一类：食物/作物种子/矿物/木头/方块/工具装备/其他），每个箱子里排好，身上只留该带的（默认：最好的镐斧剑、一组吃的、16 火把、32 建材），其余归位。一口气做完。在家里会按记住的分类放（第一次整理后就固定下来）。loadout 可以改随身带的，如 [{"item":"面包","count":16}]。',
    params: { radius: { type: 'number' }, assign: { type: 'object' }, loadout: { type: 'array', items: {} } }, required: [],
    run: async (a) => {
      const home = mem.getHome();
      const me = await bridge.get('/position').catch(() => null);
      const atHome = home && me && mem.inHome(me.exact || me);
      // 人工第一次整理可以发现附近箱子；一旦登记过，和自动整理共用同一份白名单/保护规则。
      // 以前这里只在意识层拼规则，bridge 内的自动整理会绕过去，仍可能动到主人厨房。
      const request = atHome ? storagePolicy.storageRequest(home, a, { discover: true }) : a;
      const registered = atHome ? Object.keys(home.storage || {}) : [];
      const r = await bridge.post('/storage/organize', request, 600000);
      if (atHome && r.boxes) {
        const { layout, empty } = storagePolicy.layoutFromBoxes(r.boxes);
        // 只在第一次登记（还没有仓库）时整份写入；之后只补充，不覆盖
        if (r.completed !== false) mem.setHomeStorage(layout, { replace: !registered.length, empty });
        r.rememberedAsHome = true;
      }
      return r;
    },
  },
  delve: {
    kind: 'action',
    desc: '像玩家一样下矿找矿：走出家门后，朝一个方向挖楼梯往下到矿石多的深度（铁 y=16、煤铜 48、金 -16、钻石红石 -58），到了深度用鱼骨挖法（1×2 主道每 3 格向左右各挖一条 8 格支道）；挖穿到矿洞就沿着洞逛。y=0 以下能感知附近的矿挖通道过去。回到老矿洞附近会先走回上次停处接着挖。路上看得见的矿都挖掉，看得见的箱子过去开。要带火把（没有会先用煤做，做不出来就不下去），暗了就插，火把用完就停；挖开会放岩浆/水就绕开。血少/怪来了/背包满/时间到就停下告诉你，接着挖就再调一次（会记得方向）。要石镐以上才挖得到铁。target 写想找的矿（iron_ore / coal_ore / diamond_ore…）。',
    params: { target: { type: 'string' }, targetY: { type: 'number' }, seconds: { type: 'number' } }, required: [],
    run: async ({ target, targetY, seconds }) => { const ms = Math.min(Math.max(20, seconds || 90), 240) * 1000; return bridge.post('/delve', { target, targetY, maxMs: ms, home: mem.getHome() }, ms + 60000); },
  },
  run_command: {
    kind: 'action',
    desc: '执行一条服务器命令（不带 /，如 home、back、tpa Ka_sum1、spawn）。传送、回家这类你自己判断什么时候用。管理员命令（give、tp、gamemode、time、weather、effect…）只有玩家明确要你用时才行：because 写他的原话，程序会核对聊天里真有这句；没人要就别用。',
    params: { command: { type: 'string' }, because: { type: 'string' } }, required: ['command'],
    run: async ({ command, because }) => bridge.post('/cmd', { command, because }, 20000),
  },
  bucket: {
    kind: 'action',
    desc: '水桶：mode=fill 拿空桶去最近的水源装水（流动的水装不了）；mode=pour 往 x,y,z 那一格倒水（灭火、让流动岩浆变黑曜石、给耕地引水）。'
      + '常识：无限水 = 挖 2×2、一格深的坑，对角两格各倒一桶，四格都变成水源，怎么舀都不少（一行三格倒两头也行，中间变水源）。下界倒不了水。',
    params: { mode: { type: 'string', enum: ['fill', 'pour'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['mode'],
    run: async (a) => bridge.post('/bucket', a, 60000),
  },
  till: {
    kind: 'action',
    desc: '拿锄头把泥土/草地锄成耕地（开新地）。默认只锄 4 格内有水的（没水的耕地会退化回泥土）；x,z 给地块中心，radius 半径，count 锄几块。'
      + '别锄主人的草坪/小路 —— 开在家里的田边或者他说的地方。',
    params: { x: { type: 'number' }, z: { type: 'number' }, radius: { type: 'number' }, count: { type: 'number' }, allowDry: { type: 'boolean' } }, required: [],
    run: async (a) => bridge.post('/till', a, 120000),
  },
  fish: {
    kind: 'action',
    desc: '钓鱼：走到附近露天的水边，甩竿等咬钩，钓 count 次（默认 5）。要有钓鱼竿（木棍×3 + 线×2）。水太小、头顶被挡会一直不咬钩，会如实说。下雨时咬得快。',
    params: { count: { type: 'number' }, seconds: { type: 'number' } }, required: [],
    run: async ({ count, seconds }) => { const ms = Math.min(Math.max(30, seconds || 120), 300) * 1000; return bridge.post('/fish', { count, maxMs: ms }, ms + 30000); },
  },
  animal: {
    kind: 'action',
    desc: '照顾动物：action=breed 拿它爱吃的喂两只让它们生小崽（牛羊山羊=小麦，猪=胡萝卜/土豆/甜菜根，鸡=种子，兔子=胡萝卜/蒲公英，马=金胡萝卜）；'
      + 'feed 只喂（让小崽快点长大）；shear 拿剪刀剪羊毛（羊毛掉地上要捡）；milk 拿空桶挤牛奶（牛奶能解中毒、凋零）。kind 写动物（cow / sheep / pig / chicken…）。'
      + '刚生过的要等 5 分钟才能再生。别人的动物别动 —— 家里的或者主人叫你弄的才弄。',
    params: { action: { type: 'string', enum: ['breed', 'feed', 'shear', 'milk'] }, kind: { type: 'string' }, count: { type: 'number' } }, required: ['action'],
    run: async (a) => bridge.post('/animal', a, 90000),
  },
  ride: {
    kind: 'action',
    desc: '载具：action=mount 坐上附近的船/矿车/马（kind 可指定）；dismount 下来；minecart 在矿车上往前推（铁轨上）；boat 坐船往 x,z 直线开过水面（实验性：靠岸、前面有东西、服务器不认都会停下告诉你）。马要先驯服、猪要鞍。',
    params: { action: { type: 'string', enum: ['mount', 'dismount', 'minecart', 'boat'] }, kind: { type: 'string' }, x: { type: 'number' }, z: { type: 'number' }, seconds: { type: 'number' } }, required: ['action'],
    run: async (a) => bridge.post('/ride', a, Math.min(Math.max(20, a.seconds || 30), 180) * 1000 + 20000),
  },
  light_up: {
    kind: 'action',
    desc: '在脚边插一个火把（身边 7 格内已经有光源就不插；火把不够会先用煤/木炭做）。进洞、下矿、家附近暗处用。按间距插，一次一个，不要连着插。',
    params: { max: { type: 'number' } }, required: [],
    run: async ({ max }) => bridge.post('/light_up', { max }, 60000),
  },
  make_torches: {
    kind: 'action',
    desc: '用身上的煤/木炭 + 木棍做火把（count = 想要几个，默认 16）。',
    params: { count: { type: 'number' } }, required: [],
    run: async ({ count }) => bridge.post('/make_torches', { count }, 60000),
  },
  self_rescue: {
    kind: 'action',
    desc: '家外遇险时垫方块自救。mode=pillar：原地往上垫 height 格（默认 3），甩开近战怪、从坑里爬出来；mode=enclose：四面两层+头顶全堵上，躲一夜/躲怪。要身上有圆石/泥土这类方块。在家里不用。',
    params: { mode: { type: 'string', enum: ['pillar', 'enclose'] }, height: { type: 'number' } }, required: ['mode'],
    run: async ({ mode, height }) => bridge.post('/self_rescue', { mode, height, home: mem.getHome() }, 60000),
  },
  check_chests: {
    kind: 'action',
    desc: '走过去打开视线里没打开过的箱子/木桶：家外的（矿洞、遗迹里的奖励箱）把东西拿走，家里的只看看放了什么。看见没开过的箱子就该先做这个。',
    params: { max: { type: 'number' } }, required: [],
    run: async ({ max }) => bridge.post('/chests/check', { max: Math.min(Math.max(1, max || 3), 6), home: mem.getHome() }, 240000),
  },
  loot_nearby: {
    kind: 'action',
    desc: '探险时用：把附近（家以外的）箱子里的东西尽量都装到身上带回家。装不下先拿值钱的（工具装备→矿物→食物→其他…）。家里的箱子不碰；exclude 写不能拿的箱子位置（比如别人家的）。',
    params: { radius: { type: 'number' }, exclude: { type: 'array', items: { type: 'string' } } }, required: [],
    run: async (a) => bridge.post('/storage/loot', { ...a, home: mem.getHome() }, 300000),
  },
  farm: {
    kind: 'action',
    desc: '种地：把附近（radius 格内）熟了的庄稼收了、捡起掉的东西、用背包里的种子补种；空着的耕地也播上种子（seed 可以指定用什么种）。',
    params: { radius: { type: 'number' }, seed: { type: 'string' }, replant: { type: 'boolean' }, plantEmpty: { type: 'boolean' } }, required: [],
    run: async (a) => bridge.post('/farm', a, 600000),
  },
  cook_pot: {
    kind: 'action',
    desc: '用农夫乐事的厨锅做菜：按本整合包的真实配方，从背包里挑凑得齐的材料放进锅（碗放碗的格子），等煮好拿出来。材料不够会告诉你缺什么。',
    params: { itemName: { type: 'string' }, count: { type: 'number' } }, required: ['itemName'],
    run: async (a) => bridge.post('/cook_pot', a, 300000),
  },
  make_item: {
    kind: 'action',
    desc: '做出某样东西，整条链自己跑完：看本整合包的配方 → 凑材料（背包里有就用；没有就去家里记得的箱子拿；能合成的先做出来）→ 合成/烧/下锅 → 给了 deliverTo 就递给那个人。玩家说"把羊肉做好""给我做把铁镐""来点面包"，就用这个（itemName 写做好之后的东西，比如 熟羊肉、铁镐）。做不到会说缺什么、去哪弄。',
    params: { itemName: { type: 'string' }, count: { type: 'number' }, deliverTo: { type: 'string' } }, required: ['itemName'],
    run: async ({ itemName, count = 1, deliverTo }) => makeItem(itemName, count, deliverTo),
  },
  sleep_in_bed: {
    kind: 'action',
    desc: '上床睡觉：找附近的床（优先家里的），走过去躺下。只有晚上（或雷雨天）能睡；附近有怪、床被占了会告诉你为什么睡不了。早上会自己醒。',
    params: {}, required: [],
    run: async () => bridge.post('/sleep', { home: mem.getHome() }, 120000),
  },
  go_home: {
    kind: 'action',
    desc: '回家（回到你认定的家的中心）。',
    params: {}, required: [],
    run: async () => {
      const h = mem.getHome();
      if (!h) return { ok: false, error: '还没有家（用 set_home 把现在的地方认定为家）' };
      return bridge.post('/go', { ...h.center, range: 3 }, 300000);
    },
  },

  sort_container: {
    kind: 'action',
    desc: '整理当前打开的箱子：零散的同种东西叠在一起，再按类别排好（食物→作物种子→矿物→木头→方块→工具装备→其他）。一次做完。',
    params: {}, required: [],
    run: async () => bridge.post('/container/sort', {}, 60000),
  },
  sort_inventory: {
    kind: 'action',
    desc: '整理自己的背包（同种叠起来、按类别排好，快捷栏不动）。',
    params: {}, required: [],
    run: async () => bridge.post('/inventory/sort', {}, 60000),
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
    desc: '近战攻击附近的怪：radius 只负责搜索目标；找到后会先走到 3 格内再挥击，走不过去就如实失败，不会隔空攻击。target 可指定实体名（如 zombie），不给就打最近的敌对生物。',
    params: { target: { type: 'string' }, radius: { type: 'number' } }, required: [],
    run: async ({ target, radius }) => {
      // 战斗本能在打同一只（或任何一只）时：身体不在她手上，这一下直接回给她，不发 HTTP
      const blocked = hooks.beforeAttack({ target, radius });
      if (blocked) return { ok: false, error: blocked, guarded: true };
      return bridge.post('/attack', { target, radius: radius || 6 }, CFG.actionTimeoutMs);
    },
  },
  give: {
    kind: 'action',
    desc: '把背包里的东西递给玩家：停在他 1～2 格外再对准丢过去，不和玩家重合；确认物品真的离开背包并尽量确认他接到（没扔出去或没接到都会如实说明）。',
    params: { itemName: { type: 'string' }, count: { type: 'number' }, player: { type: 'string' } }, required: ['itemName', 'player'],
    run: async ({ itemName, count, player }) => bridge.post('/give', { itemName, count, player }, 30000),
  },
  look_area: {
    kind: 'info',
    desc: '仔细看一片地方的布局（逐层俯视图、材质配色、门、灯、家具、会刷怪的暗处）。想布置、装修、盖东西之前先看。x/y/z 是中心（默认你脚下），r 半径（默认 7）。',
    params: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, r: { type: 'number' } }, required: [],
    run: async (a) => bridge.get(`/survey?${Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('&')}`, 8000),
  },
  plan_layout: {
    kind: 'action',
    desc: '给家划分区（仓库、厨房、冶炼角、工作区、照明…）：每个区写用途、打算放什么、大概在哪一片 —— 不定具体格子（现用现定：东西到手了再在区里挑位置）。'
      + '进度往前走了（有新工作站、新机器）或者某个区"要重新想"了，再调一次：同名的区会被替换，别的区保留。wishes 写你想要什么。',
    params: { wishes: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: [],
    run: async (a) => planLayout(a),
  },

  furnish: {
    kind: 'action',
    desc: '把手上有的、布置规划里想要的东西摆进对应的区（在区里当场看布局挑位置）；items 可以只摆某几样。区里放不下会标成"要重新想"。',
    params: { items: { type: 'array', items: { type: 'string' } } }, required: [],
    run: async ({ items }) => {
      const st = await bridge.get('/layout/status', 8000);
      const ready = [...new Set((st?.layouts || []).flatMap(L => L.canPlaceNow || []))].filter(k => !items || items.map(x => String(x).replace(/^minecraft:/, '')).includes(k));
      if (!ready.length) return { ok: false, error: (st?.layouts || []).length ? '手上没有规划里还想要的东西' : '还没有布置规划（先 plan_layout）' };
      return placeNicely({ items: ready.map(k => ({ itemName: k, count: 16 })) });
    },
  },

  layout_status: {
    kind: 'info',
    desc: '看布置规划：每个区想要什么、已经摆了几个、手上有哪些能马上摆、区里还剩几格空地、哪些区"要重新想"。',
    params: { id: { type: 'string' } }, required: [],
    run: async ({ id }) => bridge.get(`/layout/status${id ? `?id=${id}` : ''}`, 10000),
  },

  place_nicely: {
    kind: 'action',
    desc: '放任何东西都用这个（箱子、灯、床、工作台、熔炉、家具、装饰、方块）：有布置规划就到对应的区里当场看布局挑位置（区放不下会标成要重新想）；没有就看一眼布局，一次想好全部位置（不挡路、靠墙成组、对齐、跟周围搭）再放。一批一起放：items=[{itemName,count,purpose}]，或 itemName+count。x/y/z 写大概在哪一片（默认你身边）。',
    params: { itemName: { type: 'string' }, count: { type: 'number' }, items: { type: 'array', items: { type: 'object' } }, purpose: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: [],
    run: async (a) => placeNicely(a),
  },
  design_build: {
    kind: 'action',
    desc: '想盖点什么、改造一片地方（小仓库、围墙、农田围栏、路、扩建一间屋、挖平一块地）时先设计：看清这片、按你的审美出一张蓝图存下来。之后用 build_work 一点点施工（材料够七成才开工，不先挖坑等材料；主人要你盖的写 asked:true 就马上开工）。purpose 写用途和大概规模，x/y/z 写在哪一片（默认你身边）。',
    params: { purpose: { type: 'string' }, asked: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['purpose'],
    run: async (a) => designBuild(a),
  },
  build_work: {
    kind: 'action',
    desc: '照蓝图施工一段（默认约 90 秒）：多余的方块挖掉、缺的方块用手上有的材料补上。第一次开工要材料够七成（主人要的 asked 除外），开工之后不用等齐 —— 缺什么会告诉你（missing），去弄来再接着 build_work。天黑、有怪、有人叫你就先停，回头接着做。',
    params: { id: { type: 'string' }, seconds: { type: 'number' } }, required: [],
    run: async ({ id, seconds }) => { const ms = Math.min(Math.max(20, seconds || 90), 240) * 1000; return bridge.post('/project/work', { id, maxMs: ms }, ms + 60000); },
  },
  build_status: {
    kind: 'info',
    desc: '看进行中的工程：完成多少、还要挖/放几格、需要什么材料、缺什么。',
    params: { id: { type: 'string' } }, required: [],
    run: async ({ id }) => bridge.get(`/project/status${id ? `?id=${id}` : ''}`, 10000),
  },
  build_cancel: {
    kind: 'action',
    desc: '放弃一个工程（设计不好、不想要了）。',
    params: { id: { type: 'string' } }, required: ['id'],
    run: async ({ id }) => bridge.post('/project/cancel', { id }),
  },
  place: {
    kind: 'action',
    desc: '放东西：会先看布局、挑不挡路的位置（和 place_nicely 一样）。只有垫脚、堵洞这种必须放在确定格子的，才写 exact=true，按坐标原样放。',
    params: { itemName: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, exact: { type: 'boolean' } }, required: ['itemName'],
    // 有实体的东西一律先看布局（主人 2026-09-27：只要是有实体的都应该看布局）；exact=true（垫脚/堵洞）才按坐标原样放
    run: async (a) => (a.exact ? bridge.post('/place', a) : placeNicely({ itemName: a.itemName, count: a.count, purpose: a.purpose || '放在这附近', x: a.x, y: a.y, z: a.z, r: 5 })),
  },
};


// 模型常把参数名写走样。[写错的名字, 正确的名字]，只在目标工具真有那个参数时才改
const ARG_ALIASES = [
  ['item', 'itemName'], ['item_name', 'itemName'], ['name', 'itemName'], ['id', 'itemName'],
  ['block', 'blockName'], ['block_name', 'blockName'], ['name', 'blockName'], ['id', 'blockName'],
  ['playerName', 'player'], ['player_name', 'player'], ['target_player', 'player'], ['name', 'player'], ['target', 'player'], ['username', 'player'],
  ['message', 'text'], ['content', 'text'], ['msg', 'text'], ['line', 'text'],
  ['amount', 'count'], ['quantity', 'count'], ['n', 'count'],
  ['food', 'itemName'], ['input', 'itemName'],
];

function normalizeArgs (tool, args) {
  const t = TOOLS[tool];
  const a = { ...(args || {}) };
  if (!t) return a;
  for (const [from, to] of ARG_ALIASES) {
    if (a[from] !== undefined && a[to] === undefined && to in t.params && !(from in t.params)) { a[to] = a[from]; delete a[from]; }
  }
  return a;
}

function toolSpec (name, t) {
  return { type: 'function', function: { name, description: t.desc, parameters: { type: 'object', properties: t.params, required: t.required || [] } } };
}

function summarize (r) {
  if (!r || typeof r !== 'object') return String(r).slice(0, 120);
  if (r.error) return `失败：${String(r.error).slice(0, 160)}`;
  const skip = new Set(['success', 'ok']);
  const s = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !skip.has(k))));
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = {
  parseSSE,
  CFG, TOOLS, hooks, bridge, httpJson, parseArgs, normalizeArgs, toolSpec, summarize, humanizeIds,
  usage, recent, llm: (...a) => llm(...a), _setLLM: (f) => { llm = f; }, _setBridge: (b) => { Object.assign(bridge, b); }, _personalInventory: personalInventory,
  _callLLM: callLLM,   // 自测用：直接走一次真实请求解析（不动全局 llm）
  classifyHttpStatus, recordUsage, recordTokens,   // 自测用（R-fix4）
};

// --------------------------------------------------------------------------- 自测
// 只用纯函数 / 记账函数，**不发真实请求**（body.js 一进来就 install()，--selftest 也不连网）。
function selftest () {
  let pass = 0; let total = 0;
  const check = (name, got, want) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else console.log(`  FAIL  ${name}\n        实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  };

  console.log('\n[1] HTTP 状态分类：先按状态，再按响应体（R-fix4-1 / R-fix4-4）');
  {
    check('★ 403 内容审计 → kind=content，且**不可重试**（以前标 retryable:true）',
      classifyHttpStatus(403, '{"error":{"code":"content_policy_violation"}}'), { retryable: false, kind: 'content' });
    check('★ 403 权限型（不是审计）→ request / 不可重试',
      classifyHttpStatus(403, '{"error":"forbidden"}'), { retryable: false, kind: 'request' });
    check('★ 400 请求格式错 → request / 不可重试（HTML 也是）',
      classifyHttpStatus(400, '<html><body>Bad Request</body></html>'), { retryable: false, kind: 'request' });
    check('★ 400 但内容是"高负载排队" → transient（这一种真的要重试）',
      classifyHttpStatus(400, '{"error":"当前模型高负载队列排队中，请稍候重试"}'), { retryable: true, kind: 'transient' });
    check('404 → request / 不可重试', classifyHttpStatus(404, 'not found'), { retryable: false, kind: 'request' });
    check('429 → transient / 可重试', classifyHttpStatus(429, 'too many'), { retryable: true, kind: 'transient' });
    check('500 → transient / 可重试', classifyHttpStatus(500, 'boom'), { retryable: true, kind: 'transient' });
    check('HTML 网关页 502 → transient', classifyHttpStatus(502, '<html>bad gateway</html>'), { retryable: true, kind: 'transient' });
    check('200 但正文说 overload → transient（按内容兜住）', classifyHttpStatus(200, '{"error":"overload"}'), { retryable: true, kind: 'transient' });
  }

  console.log('\n[2] 记账：失败的请求也要算 prompt 字符数（R-fix4-5）');
  {
    const snap = () => JSON.parse(JSON.stringify(usage));
    const before = snap();
    recordUsage({ route: 'main', model: 'test-model-x', inChars: 1234 });
    const after1 = snap();
    check('calls +1', after1.calls - before.calls, 1);
    check('★ inChars 记上去了（以前失败请求不记）', after1.inChars - before.inChars, 1234);
    check('没有 usage 时不写 NaN', Number.isFinite(after1.inTok), true);
    const bm = (k) => (after1.byModel[k] || {});
    check('按线路:模型分开记', bm('main:test-model-x').inChars, 1234);
    // 成功的 usage 补记 token（char 不重复加）
    const c0 = usage.inChars;
    recordTokens({ route: 'main', model: 'test-model-x', inTok: 900, outTok: 40, cached: 100 });
    check('★ recordTokens 不重复累加字符数', usage.inChars - c0, 0);
    check('recordTokens 补上 token', usage.inTok >= 900, true);
    check('cached 只记有限的数', usage.cachedKnown >= 1, true);
    // 清掉这次测试留下的记录，免得影响别的
    delete usage.byModel['main:test-model-x'];
  }

  console.log('\n[3] 兜底包装不把"不可重试"翻回可重试（wbR2 新发现）');
  {
    // ⚠️ 回归点：改前本机兜底的 catch 里写死 `last.retryable = true`，
    //    404/400（"这份请求本身不对"）走完兜底仍失败后会被标回可重试，
    //    mind 于是对着同一份发不出去的输入反复重试 / 空转。
    //    判据必须和 teamorouter 那段同源（AGENTS §5：一处判据）—— 用源码形状锁死。
    const srcText = require('fs').readFileSync(__filename, 'utf8');
    const localSeg = srcText.slice(srcText.indexOf('本机兜底也是"发出去了一次 prompt"'));
    check('★ 本机兜底 catch 不再写死 retryable = true',
      /last\.retryable = true;/.test(localSeg) === false, true);
    check('★ 本机兜底 catch 沿用 keepRetryable 判据',
      /const keepRetryable = last\?\.retryable === false;/.test(localSeg), true);
    check('★ 本机兜底 catch 保 kind（content 不被冲掉）',
      /last\.kind = \(last\.kind === 'content' \|\| e\.kind === 'content'\)/.test(localSeg), true);

    // 行为验证：把那段语义等价跑一遍
    const fold = (last0, e) => {
      const keepRetryable = last0?.retryable === false;
      const last = new Error(`${last0.message}；codex 兜底也没成：${e.message}`);
      last.retryable = keepRetryable ? false : (e.retryable !== false);
      last.kind = (last0.kind === 'content' || e.kind === 'content') ? 'content' : (e.kind || last0.kind);
      return last;
    };
    const e400 = Object.assign(new Error('localhost 起不来'), { retryable: true });
    const r1 = fold(Object.assign(new Error('400'), { retryable: false, kind: 'request' }), e400);
    check('★ 400（不可重试）+ 本机兜底也失败 → 仍然不可重试', r1.retryable, false);
    check('   kind 保留 request', r1.kind, 'request');
    const r2 = fold(Object.assign(new Error('403'), { retryable: false, kind: 'content' }), e400);
    check('★ 内容审计 + 本机兜底也失败 → 仍然 content', r2.kind, 'content');
    const r3 = fold(Object.assign(new Error('429'), { retryable: true, kind: 'transient' }), e400);
    check('  可重试的错走完兜底仍可重试', r3.retryable, true);
  }

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();
