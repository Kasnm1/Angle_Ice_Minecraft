// runtime.js —— 日志、意识流事件、说话出口的节奏。
//
// - `log()`：带墙钟时间的一行，同时进 `W.log`（最多留 300 行，控制面 /mind 要读）
// - `hhmmss()`：短时间戳（emit 用）
// - `emit()`：世界里发生了一件事 → 进 `W.pending`；urgent / chat 立刻想
// - `chatWaitLeft()` / `typingMs()`：他还在打字就别开口（等他说完 + 假装打字）
// - `chatGate()`：上面那两件事的等待循环
// - `scheduleThink()`：debounce —— 攒一小会儿再想
//
// `bodyNow()` 在 think.js（它要拿 `W.state` / `W.job` 拼【此刻】），这里**延迟转发**：
// runtime ↔ think 是循环依赖，加载期解构会拿到 undefined（见 wiring.js）。
//
// `thinkTimer` / `thinkTimerAt` 是模块级的两个 `let`（防抖计时器的句柄）—— 拆成多份副本
// 就会各等各的，所以只在这里一份，外面通过 `setThinkTimer()` 改（见各区 AGENTS.md）。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const wiring = require('./wiring');
// 兄弟文件的正经家在 think.js；延迟转发是为了断开 runtime ↔ think 的循环依赖（见 wiring.js）
function bodyNow (...a) { return wiring.think().bodyNow.apply(null, a); }
function think (...a) { return wiring.think().think.apply(null, a); }

function log (msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  W.log.push(line);
  if (W.log.length > 300) W.log.shift();
}

const hhmmss = (t = Date.now()) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

/** 自我复盘的现场：程序亲眼看到的，不经过她的嘴（见 self-review.js） */
function scene (nRecent = 5) {
  const s = W.state;
  return { doing: bodyNow(), pos: s?.pos || null, hp: s?.health ?? null, food: s?.food ?? null, lastSaid: W.lastSaid, recent: W.recent.slice(-nRecent) };
}

// ------------------------------------------------------------------ 事件

/**
 * 世界里发生了一件事。text 是给她看的一句话；cue 用来"想起来"；names 是涉及的玩家。
 * urgent：挨打 / 危险 —— 马上想，正在"闲想"的话打断它。
 * chat：玩家说的话 —— 马上想，但开口前等他说完（chatGate）；还没开口的这一轮被新的一条作废重想。
 */
function emit (text, { cue = '', names = [], urgent = false, chat = false } = {}) {
  W.pending.push({ t: Date.now(), text, cue: `${text} ${cue}`, names, urgent, chat });
  W.recent.push(`[${hhmmss()}] ${text}`);
  if (W.recent.length > 8) W.recent.shift();
  // 自动记成经历（人不用刻意也记得今天发生了什么）
  const ids = [...`${text} ${cue}`.matchAll(/[a-z0-9_]+:[a-z0-9_/.-]+/g)].map(m => m[0]);
  mem.episode(text.replace(/^\S+\s/, ''), [...names, ...ids]);
  W.lastEventAt = Date.now();
  if (chat) {
    const now = Date.now();
    const first = W.chatWait?.first ?? now;
    W.chatWait = { first, until: Math.min(now + CFG.chatQuietMs, first + CFG.chatQuietMaxMs) };
    // 正在想、还没说出口也没动手 → 这一轮作废（think 的 catch 会把它的事放回去，和这句一起重想）
    if (W.thinking && !W.thinkCommitted) { W.thinkDiscard = true; W.thinkCtl?.abort(); }
    scheduleThink(0);
    return;
  }
  if (urgent && W.thinking && W.thinkWhy === 'idle') W.thinkCtl?.abort();
  scheduleThink(urgent ? 0 : CFG.debounceMs);
}

/**
 * 还要等他说完多久（毫秒）；0 = 不用等了。
 * 等的时候来了真正的急事（urgent 且不是聊天）就不等 —— 危险先处理，他没说完的下一刻再接。
 */
function chatWaitLeft (now = Date.now()) {
  if (!W.chatWait) return 0;
  if (W.pending.some(e => e.urgent && !e.chat)) return 0;
  return Math.max(0, W.chatWait.until - now);
}

/**
 * 开口 / 动手之前过这道门：他最后一条之后还没满 chatQuietMs，就先等着（想可以先想，查可以先查）。
 * 等的时候他又说了一句 → emit 会 abort 这一轮，这里抛 'aborted'，整轮作废。
 */
/** 她要说的这段话，像人打出来要多久（毫秒） */
function typingMs (text) {
  return Math.min(CFG.typeMaxMs, CFG.typeBaseMs + speech.len(String(text || '').replace(/⏎/g, '')) * CFG.typePerCharMs);
}

async function chatGate (signal, typeUntil = 0) {
  for (;;) {
    // 急事不等；否则等到"他说完"和"她打完"两者较晚的那个
    const urgentNow = W.pending.some(e => e.urgent && !e.chat);
    const left = urgentNow ? 0 : Math.max(chatWaitLeft(), typeUntil - Date.now());
    if (!left) { W.chatWait = null; return; }
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const t = setTimeout(resolve, left);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
  }
}


let thinkTimer = null; let thinkTimerAt = 0;
/** 安排一次"想"。已经安排了更早的就不动；新的更早就换成新的（急事不能被一个晚点的计时器挡住） */
function scheduleThink (ms) {
  // 线路歇着的时候，别安排比"歇完"更早的——但急事（他喊她）该把它叫醒
  if (Date.now() < W.failUntil) {
    const rest = W.failUntil - Date.now();
    // 已经排得比"歇完"还晚就不用动；否则一律顺延到歇完那一刻（别在歇息里偷偷早醒）
    if (!thinkTimer || thinkTimerAt <= Date.now() + rest) {
      if (thinkTimer) clearTimeout(thinkTimer);
      thinkTimerAt = Date.now() + rest + 100;
      thinkTimer = setTimeout(() => { thinkTimer = null; think('event'); }, rest + 100);
    }
    return;
  }
  const at = Date.now() + ms;
  if (thinkTimer && thinkTimerAt <= at) return;
  if (thinkTimer) clearTimeout(thinkTimer);
  thinkTimerAt = at;
  thinkTimer = setTimeout(() => { thinkTimer = null; think('event'); }, ms);
}

// ------------------------------------------------------------------ 看世界


module.exports = {
  log, hhmmss, scene, emit, chatWaitLeft, typingMs, chatGate, scheduleThink,
  // `thinkTimer` / `thinkTimerAt` 只此一份（模块级 let）。外面**读**用这几个访问器，
  // **不要**再各留一个 `let` 副本 —— 那样各等各的，离线看不出来（见 AGENTS.md）。
  readingThinkTimer: () => thinkTimer,
  readingThinkTimerAt: () => thinkTimerAt,
  clearThinkTimer: () => { if (thinkTimer) clearTimeout(thinkTimer); thinkTimer = null; thinkTimerAt = 0; },
};
