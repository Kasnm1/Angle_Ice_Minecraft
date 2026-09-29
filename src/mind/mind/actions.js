// actions.js —— 把"想"变成"做"：被她选中的工具怎么落到身体上。
//
// - `startJob()`：一串动作交给 bridge 排队；**不再无条件顶掉**（阶段 1 起先问任务层该不该打断，
//   见 `tasks.interruptKind` / `pauseWhyFor`）
// - `runTool()`：`MIND_TOOLS` 里的工具直接跑，其余转发给 `body.TOOLS`
// - `toolResultLine()` / `fmtArgs()`：回执怎么写进意识流
// - `celebrate()` / `learnFromDoing()`：亲手做成的事自动记成经验 / 心愿进度
// - `instinctEat` / `NAME_RE` / `FAST` / `matchFast` / `fastPath`：仅有的几个程序本能
//   （饿到发慌就吃、"停 / 跟我来"瞬间反应；`look()` 也会调后两个）
//
// 工具表在 tools.js，但 tools.js 的 `MIND_TOOLS` 会回头用 `startJob` / `runTool`（本文件）——
// 所以这里只能**延迟**取（`wiring.tools()`，见 wiring.js）。任务层同理：延迟 require，
// 免得 actions.js 和 tasks.js 互相咬住（tasks.js 是纯函数 + 显式状态，不回头 require 本文件）。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。
// 阶段 1 任务队列接入（2026-09-29）：打断判据挪进 tasks.js，本文件只负责"照做"。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const { emit, log, scene, hhmmss, scheduleThink } = require('./runtime');
const wiring = require('./wiring');
function bodyNow (...a) { return wiring.think().bodyNow.apply(null, a); }
// 工具表在 tools.js；`typeof` 守卫在原件里是防"加载顺序"的，拆开后用延迟转发取同一份。
const MIND_TOOLS = new Proxy({}, { get: (_, k) => wiring.tools().MIND_TOOLS[k], has: (_, k) => k in wiring.tools().MIND_TOOLS, ownKeys: () => Reflect.ownKeys(wiring.tools().MIND_TOOLS), getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(wiring.tools().MIND_TOOLS, k) });
// 任务层：纯函数 + 显式状态（状态挂在 W.tasks），延迟 require 避免加载顺序问题。
const tasks = () => require('./tasks');

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

const NAME_RE = /^(@?ang(?:el|le)[_ ]?ice|@?ang(?:el|le)|安琪|小安)[，,：:\s]*/i;
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
 * 身体忙的时候重试几次（阶段 1；设计文档第五节 5："身体层不排队 → 上层有限次重试，不算失败"）。
 * BODY_BUSY_RE 认 bridge 在锁上的那句话；重试 3 次、间隔 300ms —— 锁是毫秒级抢的，
 * 300ms × 3 足够跨过前面那条命令的尾巴，再长就是真卡住了（该报失败而不是傻等）。
 */
const BODY_RETRY = 3;
const BODY_RETRY_MS = 300;
// bridge 身体锁的真实报错（src/bridge/http.js）：「身体正在执行 POST /go（30.7 秒），当前 POST /cmd 没有启动；等前一个动作完成后重试」
// 原来的正则认「忙 / busy / 锁」，那句一个都没有 → 重试从没生效（2026-09-29 Claude 复核改）。也认返回里的 busy 字段（见调用处）。
const BODY_BUSY_RE = /身体正在执行|没有启动；等前一个动作完成后重试|(身体|body).*(忙|busy|占用|locked|锁)|(忙|busy|locked).*(身体|body)|409/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 开始做一串动作。
 *
 * **阶段 1 起不再"新动作一律顶掉旧的"**（审计 C1：那是 last-writer-wins，旧任务剩下的步骤会丢）。
 * 现在先问任务层该不该打断（判据**只有一份**，在 `tasks.interruptKind`）：
 *   · 这一串全是"不动身体"的动作（说话/看一眼/查背包）→ 不打断，和手上的事**并行**（`kind:'say'`）
 *   · 动了身体 → 把当前 running 任务 `paused`，理由照 `tasks.pauseWhyFor`（主人插事 = player，自己想换 = self）
 * 旧的 `preempted()` 提示保留：哪怕队列留住了任务，她也该知道"刚才做到哪了"。
 *
 * `busy`（身体被本能占着）→ 有限次重试；重试用完才当失败，**不标任务 failed**。
 */
async function startJob (steps, why, { skillId = null, taskId = null, heardPlayer = false, playerTaskId = null, planStep = null } = {}) {
  const T = tasks();
  // ① 打断谁、这串算哪件任务 —— 判据只在 tasks.jobPlan（阶段 2），这里只照做。
  //    阶段 1 在这里"动身体就 pause 手上那件、再把同一件 setRunning 回来"，连着做同一件事也一轮记一次被打断。
  //    planStep（阶段 3）：闲着推长期计划时 think 传 plan.current() 进来，手上没事就建 source=plan 的任务
  let tid = null;
  try {
    const p = T.jobPlan(steps, { taskId, heardPlayer, playerTaskId, why, planStep });
    if (p.pause) T.pause(p.pause, p.pauseWhy);
    tid = p.auto ? T.create(p.auto).task.id : p.taskId;
    if (tid) T.setRunning(tid);
  } catch (e) { log(`   [tasks] 记任务失败（不影响干活）：${e.message}`); }
  // 跟着他走（follow 一直跟着）被叫停 = 跟随结束 → 把因为他停下的那件摆回来（设计第六节 2）
  const followEnded = !!(W.job?.holding && W.job.steps.some(s => s.tool === 'follow') && steps.some(s => s.tool === 'stop'));
  const token = ++W.token;
  if (W.job) { await bridge.post('/stop').catch(() => {}); }
  const started = Date.now();
  W.job = { token, steps, i: 0, why, started, skillId, inv: [], taskId: tid };
  const job = W.job;
  // 收尾提醒拼在事件后面（她读"✅ 做完了 / ❌ 没做成"那条时一起看到）；失败不影响干活
  // 不算在任务上的那串（stop / come_to / 只看一眼）不拼：come_to 走到了另有 resumeHint，别说两遍
  const hintAfter = (ok, error) => { if (tid == null) return ''; try { const h = T.afterJob(tid, { ok, error }); return h ? `\n${h}` : ''; } catch (_) { return ''; } };
  if (followEnded) { try { const h = T.resumeHint('player'); if (h) emit(h); } catch (_) {} }
  // 这件事做的过程中背包的进出（物品账），结果出来时一起说："放进箱子@… 铁锭×8；捡到 圆石×3"
  const invNote = () => (job.inv.length ? `（这期间背包：${job.inv.splice(0).join('；')}）` : '');
  const results = [];
  // 被新的动作顶掉：告诉她做到哪了（不然她不知道东西到底给出去没有，只能瞎编 —— 实测她把护甲递出去了，
  // 被"放回箱子"打断后，以为护甲还在、说"我把它们放回去"）
  const preempted = () => {
    const done = results.filter(x => x.r.ok).map(x => `${x.tool}${fmtArgs(x.args)} → ${summarize(x.r)}`);
    const left = steps.slice(results.length).map(s => s.tool);
    // 刚开始没几秒就被顶掉：多半是改主意改得太勤（来回拉扯），值得复盘；做了一阵才换的是正常改主意
    const ranMs = Date.now() - started;
    if (ranMs < 3000 && !steps.every(s => ['look_at', 'stop'].includes(s.tool))) {
      review.record({ kind: 'preempted', tool: steps[results.length]?.tool || steps[steps.length - 1]?.tool, why, at: results.length + 1, of: steps.length, ranMs, ...scene(3) });
    }
    W.pending.push({ t: Date.now(), text: `⏹ 刚才在做的事（${why || steps.map(s => s.tool).join('→')}）被新的动作打断了。${done.length ? `已经做完：${done.join('；')}。` : '一步都还没做完。'}${left.length ? `没做的：${left.join('、')}` : ''}${invNote()}`, cue: steps.map(s => JSON.stringify(s.args)).join(' '), names: [] });
  };
  for (let i = 0; i < steps.length; i++) {
    if (token !== W.token) { preempted(); return; }   // 被新的动作顶掉了
    W.job.i = i;
    const { tool, args } = steps[i];
    // 身体被本能占着 → 有限次重试，不算任务失败（设计第五节 5）
    let r = await runTool(tool, args);
    for (let k = 0; k < BODY_RETRY && !r.ok && (r.busy || BODY_BUSY_RE.test(String(r.error || ''))); k++) {
      if (token !== W.token) { preempted(); return; }
      await sleep(BODY_RETRY_MS);
      log(`   ↻ ${tool} 身体忙着，等一下再试（第 ${k + 1}/${BODY_RETRY} 次）`);
      r = await runTool(tool, args);
    }
    results.push({ tool, args, r });
    if (token !== W.token) { preempted(); return; }
    if (!r.ok) {
      review.record({ kind: 'action_failed', tool, args, error: r.error, why, skillId, doneBefore: results.slice(0, -1).map(x => x.tool), ...scene() });
      W.recentFails.push(`[${hhmmss()}] ${tool}${fmtArgs(args)} → ${r.error}`);
      if (tool === 'sleep_in_bed') W.sleepFail = { t: Date.now(), why: String(r.error || '').slice(0, 60) };
      if (W.recentFails.length > 5) W.recentFails.shift();
      W.job = null;
      // 真失败（重试也没用）：自动包的那件标 failed；她 / 主人明确的那件**不标 failed**，记下卡在哪、提醒她（tasks.afterJob）
      const hint = hintAfter(false, `${tool} → ${r.error}`);
      if (skillId) mem.skillResult(skillId, false, `${tool} → ${r.error}`);
      const focus = ambition.state().focus;
      if (focus && ['craft', 'smelt', 'container_put', 'container_take'].includes(tool)) ambition.noteTry(focus, false, `${tool} → ${r.error}`);
      emit(`❌ ${skillId ? `照着技能 ${skillId} 做，` : ''}${tool}${fmtArgs(args)} 没做成：${r.error}${results.length > 1 ? `（前面做完了：${results.slice(0, -1).map(x => x.tool).join('、')}）` : ''}${invNote()}${hint}`, { cue: `${tool} ${JSON.stringify(args)}` });
      return;
    }
    // 做成的这一步记进任务的证据（task_done 要看它 —— 设计第四节"必须有工具成功的证据"）。
    // 只记**动身体**的步骤：说话 / 看一眼做成了不算"这件事做成过什么"。
    if (tid && !T.NO_BODY_TOOLS.has(tool)) { try { T.noteEvidence(tid, `${tool}${fmtArgs(args)} → ${summarize(r)}`); } catch (_) {} }
    learnFromDoing(tool, args, r);
    if (TOOLS[tool]?.continuous && i === steps.length - 1) {
      W.job = { ...W.job, holding: true };
      emit(`✅ ${results.map(x => `${x.tool}${fmtArgs(x.args)}`).join(' → ')}（${why || ''}，一直在跟着）${invNote()}`);
      return;
    }
  }
  if (token !== W.token) return;
  W.job = null;
  // 这一串做完了：自动包的那件收尾；明确的那件**不自动算做完**（要她 task_done + 证据），只提醒（tasks.afterJob）
  const hint = hintAfter(true);
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
  if (!quiet) emit(`✅ 做完了：${results.map(x => `${x.tool}${fmtArgs(x.args)} → ${summarize(x.r)}`).join('；')}${invNote()}${hint}`, { cue: steps.map(s => JSON.stringify(s.args)).join(' ') });
  else if (job.inv.length) emit(`🎒 ${job.inv.splice(0).join('；')}`);
  // come_to 走到了 = "过来"结束（设计第六节 2）：因为他停下的那件摆回来
  if (steps.some(s => s.tool === 'come_to')) { try { const h = T.resumeHint('player'); if (h) emit(h); } catch (_) {} }
}

function fmtArgs (a) {
  const s = JSON.stringify(a || {});
  return s === '{}' ? '' : s.length > 80 ? s.slice(0, 80) + '…}' : s;
}

async function runTool (name, args) {
  // 她自己的工具（recall / my_dream / home_stock / tools…）住在 MIND_TOOLS 里，不在 body 的 TOOLS 里。
  // 以前这里只看 TOOLS，于是这些 info 类工具一被调用就回"没有 X 这个动作"（recall 从没被调过，所以一直没被发现）。
  const t = TOOLS[name] || (typeof MIND_TOOLS !== 'undefined' ? MIND_TOOLS[name] : null);
  if (!t || !t.run) return { ok: false, error: `没有 ${name} 这个动作` };
  const out = await (async () => {
    try {
      let a = normalizeArgs(name, args) || {};
      // `light_up` 默认照本能报过的家里暗处插（暗处坐标来自 `dark_spot` 事件，见 look.js）——
      // 本能已经数过是哪几格了，她不用再自己找一遍。她要自己挑地方时传 spots 覆盖。
      if (name === 'light_up' && a.spots == null) {
        const spots = Array.isArray(W.darkSpots) ? W.darkSpots : null;
        if (spots && spots.length) a = { ...a, spots: spots.slice(0, 3) };
      }
      const r = await t.run(a);
      if (r && (r.success === false || r.ok === false)) return { ok: false, error: r.error || 'failed', ...r };
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })();
  // 每个动作的结果记一行（以前 mind.log 只记"做了什么"，失败原因查不到 —— 2026-09-28 烤羊肉那次就是这样）
  try { console.log(`   ↳ ${toolResultLine(name, args, out)}`); } catch (_) {}
  // 同一目的地来回走（附加小项）：`runTool` 是**每个**动作的唯一出入口，判据挂在这里就只写一处。
  // 走路类（goto / come_to / follow）走一次记一次；同一个点（3 格内）2 分钟内 ≥3 次、背包没变 → 提醒她换办法。
  // 提醒拼在结果里（`out.hint`），她会像读普通回执一样读到 —— 不走"另发一条消息"那条路。
  try {
    if (out?.ok && tasks().SAME_SPOT_TOOLS.has(name)) {
      const h = tasks().noteSpot(name, args, W.state);
      if (h) out.hint = out.hint ? `${out.hint}；${h}` : h;
    }
  } catch (_) { /* 提醒失败不影响干活 */ }
  return out;
}

/** 一个动作的结果压成一行（≤180 字）：成败 + 错误 / 关键字段 */
function toolResultLine (name, args, out) {
  const a = args && typeof args === 'object' ? Object.entries(args).filter(([k]) => !/^(inner|text|because)$/.test(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ').slice(0, 60) : '';
  if (!out?.ok) return `${name}(${a}) ✗ ${String(out?.error || '失败').replace(/\s+/g, ' ').slice(0, 110)}`;
  const keys = ['got', 'gained', 'crafted', 'made', 'placed', 'mined', 'picked', 'moved', 'arrived', 'ate', 'caught', 'born', 'tilled', 'note', 'message'];
  const brief = keys.filter(k => out[k] != null && out[k] !== '').map(k => `${k}=${typeof out[k] === 'object' ? JSON.stringify(out[k]) : out[k]}`).join(' ');
  return `${name}(${a}) ✓ ${brief}`.replace(/\s+/g, ' ').slice(0, 180);
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
    // 下矿：把这个矿洞记成一个地方（入口、上次停在哪、最深、挖到什么、开过几个箱子），下次问起、想挖矿都想得起来
    if (tool === 'delve' && r && r.entry) {
      const ores = {}; for (const [k, n] of Object.entries(r.gained || {})) if (/raw_|coal|diamond|emerald|lapis|redstone|quartz|_ore|ancient_debris|nugget|amethyst/.test(k)) ores[k] = n;
      mem.notePlace({ kind: 'mine', entry: r.entry, last: r.at, deepest: r.deepest, ores, chests: (r.chests || []).length });
    }
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


module.exports = { startJob, runTool, fmtArgs, toolResultLine, celebrate, learnFromDoing,
  instinctEat, NAME_RE, FAST, matchFast, fastPath };
