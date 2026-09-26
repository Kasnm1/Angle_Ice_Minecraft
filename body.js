'use strict';

/**
 * 她的身体：连网桥的手脚 + 查书（知识层）的工具 + 调模型。
 *
 * 从 brain.js 抽出来，给 mind.js（持续的意识流）用。这里**没有**任何"该怎么做"的判断 ——
 * 只有"能做什么"。判断归她自己（mind.js + 她自己写的记忆）。
 */

const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge');
const speech = require('./speech');
const mem = require('./memory-store');
// 世界 = 连的是哪个服务器（config.json 的 MC_HOST:MC_PORT）；每个世界一个家
try {
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  mem.setWorld(`${process.env.MC_HOST || conf.MC_HOST || 'localhost'}:${process.env.MC_PORT || conf.MC_PORT || 25565}`);
} catch (_) { mem.setWorld(`${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || 25565}`); }

// ------------------------------------------------------------------ .env

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

const CFG = {
  bridge: process.env.MC_BRIDGE_URL || 'http://127.0.0.1:3001',
  botName: process.env.MC_BOT_USERNAME || 'Angel_ICE',
  baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.MIND_MODEL || process.env.BRAIN_FAST_MODEL || 'gemini-3.8-flash',
  fallback: process.env.MIND_FALLBACK || 'deepseek-v4.1-flash',
  // 备用线路：主线路（比如 Gemini 免费额度）被限流/过载时，换到另一家（比如中转站）
  fallbackBaseUrl: (process.env.LLM_FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
  fallbackApiKey: process.env.LLM_FALLBACK_API_KEY || '',
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

const saidRecently = [];   // 她最近 3 分钟说过的话（say 去重用）

const hooks = { onSay: () => {}, beforeSay: async () => {} };

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
const usage = { calls: 0, inTok: 0, outTok: 0, since: Date.now(), byModel: {} };

async function callLLM ({ model, messages, tools, timeoutMs, signal, maxTokens = 1200, route = 'main' }) {
  const baseUrl = route === 'fallback' ? CFG.fallbackBaseUrl : CFG.baseUrl;
  const apiKey = route === 'fallback' ? CFG.fallbackApiKey : CFG.apiKey;
  if (!baseUrl || !apiKey) throw new Error('没配 LLM_BASE_URL / LLM_API_KEY');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
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
      // 网关 / 限流页（HTML）：当成过载，走重试和备用线路
      const e = new Error(`模型线路返回了网页（HTTP ${res.status}，多半是限流或网关出错）`); e.retryable = true; throw e;
    } else {
      try { data = JSON.parse(text); } catch (_) {
        const e = new Error(`模型返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`); e.retryable = true; throw e;
      }
    }
    if (!res.ok || data.error) {
      if (res.status === 400 && /temperature/i.test(text) && !noTemp.has(model)) {
        noTemp.add(model);   // 换个参数马上再来一次，不算失败
        return callLLM({ model, messages, tools, timeoutMs, signal, maxTokens, route });
      }
      const e = new Error(`模型报错 ${res.status}：${JSON.stringify(data.error || data).slice(0, 200)}`);
      // 中转站排队 / 高负载有时回 400（"当前模型高负载队列排队中，请稍候重试"）—— 是一时的，要重试、换备用
      e.retryable = res.status === 429 || res.status >= 500 || /overload|负载|排队|稍候重试|busy|capacity/i.test(text);
      throw e;
    }
    const msg = data.choices?.[0]?.message;
    // 中转站上游失败时会回一个"成功"的空壳（一个字没生成：没正文、没工具调用）—— 当成失败，重试或换备用线路
    if (msg && !msg.content && !(msg.tool_calls || []).length && !msg.reasoning_content && !(data.usage?.completion_tokens > 0)) {
      const e = new Error('模型回了个空壳（一个字没生成，多半是中转站上游失败）'); e.retryable = true;
      recent.push({ t: Date.now(), route, model, empty: true, raw: text.slice(0, 400) }); if (recent.length > 8) recent.shift();
      throw e;
    }
    // 最近几次模型的原样回复（排查"想了却什么都没做"用）
    recent.push({ t: Date.now(), route, model, ms: 0, promptMsgs: messages.length, promptChars: JSON.stringify(messages).length, finish: data.choices?.[0]?.finish_reason, raw: text.slice(0, 1500) });
    if (recent.length > 8) recent.shift();
    if (!msg) { const e = new Error(`模型返回里没有 message：${text.slice(0, 120)}`); e.retryable = true; throw e; }
    // 用量：心里有数才能控制花费
    usage.calls++;
    usage.inTok += data.usage?.prompt_tokens || 0;
    usage.outTok += data.usage?.completion_tokens || 0;
    const bm = usage.byModel[`${route}:${model}`] ||= { calls: 0, inTok: 0, outTok: 0 };
    bm.calls++; bm.inTok += data.usage?.prompt_tokens || 0; bm.outTok += data.usage?.completion_tokens || 0;
    return msg;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw new Error('aborted');
      const err = new Error(`模型超时 ${timeoutMs}ms`); err.retryable = true; throw err;
    }
    if (e.retryable === undefined && !String(e.message).startsWith('模型')) e.retryable = true;
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
  const tries = !F ? [M, M, M] : open ? [F, F, M] : [M, M, F, F, M];
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
  // susu 整条线路都不通（两个模型都在它上面）：按顺序找本机的命令行兜底（另一家后端，慢，10–20 秒）
  if (last?.message !== 'aborted' && last?.retryable !== false) {
    for (const name of localFallbacks()) {
      const L = LOCAL[name];
      if (!L.available()) continue;
      try {
        const r = await L.chat({ messages: opts.messages, tools: opts.tools, timeoutMs: LOCAL_TIMEOUT[name], signal: opts.signal });
        recent.push({ t: Date.now(), route: name, model: L.MODEL, raw: r.raw }); if (recent.length > 8) recent.shift();
        usage.calls++;
        const bm = usage.byModel[`${name}:${L.MODEL}`] ||= { calls: 0, inTok: 0, outTok: 0 };
        bm.calls++;
        return r.message;
      } catch (e) {
        if (e.message === 'aborted') throw e;
        last = new Error(`${last.message}；${name} 兜底也没成：${e.message}`); last.retryable = true;
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
async function upstairsFirst (targetY) {
  const me = await bridge.get('/position').catch(() => null);
  const y = me?.exact?.y ?? me?.y;
  if (typeof y !== 'number' || typeof targetY !== 'number') return null;
  if (targetY - y >= 3) return bridge.post('/climb_up', { targetY }, 120000).catch(() => null);
  if (y - targetY >= 3) return bridge.post('/climb_down', { targetY }, 120000).catch(() => null);
  return null;
}

const TOOLS = {
  say: {
    kind: 'speech',
    desc: '在游戏聊天里说话。像打字那样：几条短消息，用换行分开，每条不超过 12 个字（会按这个样子一条条发出去）。urgent=true 是危险提示，一条说完不拆。',
    params: { text: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['text'],
    run: async ({ text, urgent }) => {
      const t = String(text || '').trim().slice(0, 400);
      if (!t) return { ok: false, error: 'empty' };
      let parts = urgent ? [t.replace(/\n+/g, ' ').slice(0, 256)] : speech.segment(t, { maxSegments: 3 });
      // 同一句 3 分钟内不再说（实测：连着两轮"天亮了/早呀"、一轮里"好/来啦"说两遍）。危险提示不拦
      if (!urgent) {
        const now = Date.now();
        while (saidRecently.length && now - saidRecently[0].t > 3 * 60 * 1000) saidRecently.shift();
        const seen = new Set(saidRecently.map(r => r.k));
        parts = parts.filter(x => { const k = speech.wordsOnly(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
        if (!parts.length) return { ok: true, sent: [], note: '这些刚刚都说过了，没再发' };
        for (const x of parts) saidRecently.push({ k: speech.wordsOnly(x), t: now });
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
    desc: '穿戴装备：盔甲、模组装备、饰品（戒指、项链；背包会背到背饰格上）。会自己判断该放哪个槽，放不进就试右键穿上。',
    params: { itemName: { type: 'string' } }, required: ['itemName'],
    run: async ({ itemName }) => bridge.post('/wear', { itemName }),
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
      // 在家：按记住的分类（她自己或主人改过的 assign 优先）；只动家里这一层的箱子
      // 一类可以占好几个箱子：{ 类别: [箱子…] }（以前 fromEntries 只留了最后一个 → 另一个箱子的东西全被当成放错，白搬一趟）
      const remembered = {};
      if (atHome) for (const [k, cats] of Object.entries(home.storage)) for (const c of cats) (remembered[c] ||= []).push(k);
      const assign = { ...remembered, ...(a.assign || {}) };
      const skip = atHome ? (home.emptyBoxes || []).filter(k => !home.storage[k]) : [];
      // ⚠️ 家里已经登记过仓库：只动登记过的箱子（+ 主人明确点名的）。
      //    以前"只管她这一层"—— 她站在一楼厨房时就把主人的橱柜、冰箱整个重新分类了（实测），还把仓库的分类覆盖掉了
      const registered = atHome ? Object.keys(home.storage || {}) : [];
      const only = a.only || (registered.length ? [...registered, ...(home.emptyBoxes || [])] : null);
      const exclude = atHome ? (home.protected || []) : [];
      const r = await bridge.post('/storage/organize', { ...a, assign, skip, only: only && only.filter(k => !exclude.includes(k)), allFloors: !!only }, 600000);
      if (atHome && r.boxes) {
        const layout = Object.fromEntries(r.boxes.filter(b => b.holds.length).map(b => [b.at, b.holds]));
        // 只在第一次登记（还没有仓库）时整份写入；之后只补充，不覆盖
        mem.setHomeStorage(layout, { replace: !registered.length, empty: r.boxes.filter(b => !b.holds.length && !b.used).map(b => b.at) });
        r.rememberedAsHome = true;
      }
      return r;
    },
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
  CFG, TOOLS, hooks, bridge, httpJson, parseArgs, normalizeArgs, toolSpec, summarize,
  usage, recent, llm: (...a) => llm(...a), _setLLM: (f) => { llm = f; }, _setBridge: (b) => { Object.assign(bridge, b); },
};
