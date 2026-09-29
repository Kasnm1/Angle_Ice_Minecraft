// actions.js —— 把"想"变成"做"：被她选中的工具怎么落到身体上。
//
// - `startJob()`：一串动作交给 bridge 排队（新动作顶掉正在做的）
// - `runTool()`：`MIND_TOOLS` 里的工具直接跑，其余转发给 `body.TOOLS`
// - `toolResultLine()` / `fmtArgs()`：回执怎么写进意识流
// - `celebrate()` / `learnFromDoing()`：亲手做成的事自动记成经验 / 心愿进度
// - `instinctEat` / `NAME_RE` / `FAST` / `matchFast` / `fastPath`：仅有的几个程序本能
//   （饿到发慌就吃、"停 / 跟我来"瞬间反应；`look()` 也会调后两个）
//
// 工具表在 tools.js，但 tools.js 的 `MIND_TOOLS` 会回头用 `startJob` / `runTool`（本文件）——
// 所以这里只能**延迟**取（`wiring.tools()`，见 wiring.js）。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const { emit, log, scene, hhmmss, scheduleThink } = require('./runtime');
const wiring = require('./wiring');
function bodyNow (...a) { return wiring.think().bodyNow.apply(null, a); }
// 工具表在 tools.js；`typeof` 守卫在原件里是防"加载顺序"的，拆开后用延迟转发取同一份。
const MIND_TOOLS = new Proxy({}, { get: (_, k) => wiring.tools().MIND_TOOLS[k], has: (_, k) => k in wiring.tools().MIND_TOOLS, ownKeys: () => Reflect.ownKeys(wiring.tools().MIND_TOOLS), getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(wiring.tools().MIND_TOOLS, k) });

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
 * 开始做一串动作。新的会顶掉旧的（她自己决定的；和人一样，改主意就停下手上的事）。
 * 做完/失败/被打断 → 变成一件"发生的事"流回意识流，她再决定下一步。
 */
async function startJob (steps, why, { skillId = null } = {}) {
  const token = ++W.token;
  if (W.job) { await bridge.post('/stop').catch(() => {}); }
  const started = Date.now();
  W.job = { token, steps, i: 0, why, started, skillId, inv: [] };
  const job = W.job;
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
    const r = await runTool(tool, args);
    results.push({ tool, args, r });
    if (token !== W.token) { preempted(); return; }
    if (!r.ok) {
      review.record({ kind: 'action_failed', tool, args, error: r.error, why, skillId, doneBefore: results.slice(0, -1).map(x => x.tool), ...scene() });
      W.recentFails.push(`[${hhmmss()}] ${tool}${fmtArgs(args)} → ${r.error}`);
      if (tool === 'sleep_in_bed') W.sleepFail = { t: Date.now(), why: String(r.error || '').slice(0, 60) };
      if (W.recentFails.length > 5) W.recentFails.shift();
      W.job = null;
      if (skillId) mem.skillResult(skillId, false, `${tool} → ${r.error}`);
      const focus = ambition.state().focus;
      if (focus && ['craft', 'smelt', 'container_put', 'container_take'].includes(tool)) ambition.noteTry(focus, false, `${tool} → ${r.error}`);
      emit(`❌ ${skillId ? `照着技能 ${skillId} 做，` : ''}${tool}${fmtArgs(args)} 没做成：${r.error}${results.length > 1 ? `（前面做完了：${results.slice(0, -1).map(x => x.tool).join('、')}）` : ''}${invNote()}`, { cue: `${tool} ${JSON.stringify(args)}` });
      return;
    }
    learnFromDoing(tool, args, r);
    if (TOOLS[tool]?.continuous && i === steps.length - 1) {
      W.job = { ...W.job, holding: true };
      emit(`✅ ${results.map(x => `${x.tool}${fmtArgs(x.args)}`).join(' → ')}（${why || ''}，一直在跟着）${invNote()}`);
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
  if (!quiet) emit(`✅ 做完了：${results.map(x => `${x.tool}${fmtArgs(x.args)} → ${summarize(x.r)}`).join('；')}${invNote()}`, { cue: steps.map(s => JSON.stringify(s.args)).join(' ') });
  else if (job.inv.length) emit(`🎒 ${job.inv.splice(0).join('；')}`);
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
      const r = await t.run(normalizeArgs(name, args) || {});
      if (r && (r.success === false || r.ok === false)) return { ok: false, error: r.error || 'failed', ...r };
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })();
  // 每个动作的结果记一行（以前 mind.log 只记"做了什么"，失败原因查不到 —— 2026-09-28 烤羊肉那次就是这样）
  try { console.log(`   ↳ ${toolResultLine(name, args, out)}`); } catch (_) {}
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
