// think.js —— 想：看她此刻在哪、拼消息、一轮轮调模型、处理工具调用。
//
// - `buildNow()`：`【此刻】` 那一大段（状态 + 记忆 + 计划 + 复盘的钩子）
// - `historyChars()` / `bodyNow()` / `knownStations()`? / `homeStockItems()`? / `shortName()`? /
//   `planFacts()` / `planExtras()` / `planLine()`：拼消息用的零件（带 ? 的正文在 tools.js，这里转发）
// - `repetitionHint()` / `particleHint()`：别把条数 / 语气词说成口头禅
// - `idleGate()` / `compactLastNow()`：没事发生时空转、历史太长时压一压
// - `think()`：主循环（退避、说话出口的几道闸、查完再说、上下文快满就睡眠整理）
// - `clipText()` / `repairHistory()` / `trimDangling()` / `sleepAndSort()` / `sortMemories()`：
//   历史坏掉 / 太长时收拾，以及睡觉整理记忆
// - `autopilot` / `holdBody()` / `startControl()`：让脑干让出身体、控制面 `:3003/mind`
//
// 工具表在 tools.js、闸在 gates.js、动作在 actions.js —— 都是用 `wiring` 延迟取的。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const http = require('http');
const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const { log, hhmmss, scene, emit, chatWaitLeft, typingMs, chatGate, scheduleThink } = require('./runtime');
const { humanState, combatInstinct, survivalFocus, dropLine, invText, surroundLine } = require('./scene');
const { startJob, fmtArgs, runTool, toolResultLine, learnFromDoing } = require('./actions');
const { ALL, kindOf, GROUP_CUES, groupsFromBody, pickSpecs, activeGroups } = require('./tools');
const { SYSTEM } = require('./prompt');
const { DELEGATES, ASKS_BACK, DECIDE_NUDGE, ASKS_WHERE, LOOK_NUDGE, SAY_NUDGE, ACTION_NUDGE, isBareAffirmative, QUIET_MS, RECENT_CLAIM_MS, PLAYER_MOVE_TOOLS, PLAYER_MOVE_RE, TASK_ASK_RE, taskDoneAllowed, HONEST_NUDGE, isOverAsking, lastProactiveUnanswered, liveFails, unbackedClaim, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, ASK_BACK_NUDGE, torchAskAllowed } = require('./gates');
const wiring = require('./wiring');
const paths = require('../../paths');   // knowledge/ 路径（查任务书章名·任务名用，见 questLabel）
// 工具表在 tools.js —— 延迟取同一份（tools 也会回头用本文件的 buildNow，见 wiring.js）
const MIND_TOOLS = new Proxy({}, { get: (_, k) => wiring.tools().MIND_TOOLS[k], has: (_, k) => k in wiring.tools().MIND_TOOLS, ownKeys: () => Reflect.ownKeys(wiring.tools().MIND_TOOLS), getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(wiring.tools().MIND_TOOLS, k) });
// 任务队列（阶段 1）：纯函数 + 显式状态，状态挂在 `W.tasks`，用到时才 require（同 wiring 的道理）。
const tasks = () => require('./tasks');

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

/** 家里箱子记得的存货 [{name,count}]（做过的东西收进箱子，目标不该退回"没做"） */
function homeStockItems () {
  const h = mem.getHome();
  return Object.values(h?.stock || {}).flatMap(b => Object.entries(b.items || {}).map(([name, count]) => ({ name, count })));
}

/** 给 plan.js 的现状（背包 + 穿着的 + 家里记得的） */
function planFacts () {
  const s = W.state || {};
  const h = mem.getHome();
  const homeItems = homeStockItems();
  const food = (s.items || []).filter(i => { try { return /食物/.test(knowledge.label(i.name.includes(':') ? i.name : `minecraft:${i.name}`)) || /bread|cooked|apple|carrot|potato|beef|pork|chicken|mutton|salmon|cod|stew|soup|pie|cookie|berries|melon_slice/.test(i.name); } catch (_) { return false; } })
    .reduce((a, i) => a + i.count, 0);
  return plan.facts({ items: s.items || [], worn: Object.values(s.equipment || {}), homeItems, hasHome: !!h, foodCount: food });
}
/**
 * "接下来做什么"只有长期计划这一个声音（主人 2026-09-27：工程、布置、心愿各说各的，她会东一下西一下）。
 * 工程、布置、心愿都变成计划的候选项，她自己挑、自己排进计划。
 */
function planExtras () {
  const out = [];
  // 通关主线（香草纪元）排最前：前置都做完、自己还没做的
  try {
    const ms = plan.mainlineStatus({ completed: W.ftbq || null, items: W.state?.items || [] });
    if (ms.prereq) out.push({ text: `准备：${ms.prereq.title}`, why: ms.prereq.hint || ms.prereq.why || '进主线之前的准备' });
    for (const q of ms.next.filter(x => !x.optional).slice(0, 3)) out.push({ text: `主线：${q.title}`, why: q.hint || (q.needs[0] ? `要 ${q.needs[0]}` : '') });
  } catch (_) {}
  const lab = (k) => knowledge.label(k.includes(':') ? k : `minecraft:${k}`).replace(/\(.*\)$/, '');
  for (const p of W.projects || []) {
    const miss = Object.entries(p.missing || {}).slice(0, 3).map(([k, n]) => `${lab(k)}×${n}`).join('、');
    out.push({ text: `接着盖「${p.name}」（完成 ${p.done}）`, why: miss ? `还缺 ${miss}` : '材料够，能接着做' });
  }
  for (const l of W.layouts || []) {
    if (l.canPlaceNow?.length) out.push({ text: `把手上的 ${l.canPlaceNow.slice(0, 4).map(lab).join('、')} 摆进家里规划的区`, why: '东西到手了，现在挑位置' });
    for (const z of l.stale || []) out.push({ text: `重新想想家里的「${z}」放哪`, why: '那一块放不下了 / 被改建了' });
  }
  try {
    const c = ambition.candidates({ inventory: W.state?.items || [], knownStations: knownStations(), limit: 2 });
    if (c?.length) out.push({ text: `心愿：做一道没做过的菜（比如 ${c.map(x => knowledge.label(x.id).replace(/\(.*\)$/, '')).join('、')}）`, why: `做遍食物的心愿 ${ambition.progress().made}/${ambition.progress().total}` });
  } catch (_) {}
  // 游玩路线（knowledge/campaign.json）：跟着这个整合包的节奏玩，前置都做完的头几个。
  // 传任务书进度（W.ftbq）：没有 done 物品标志的目标也能按"任务书里做完了没"判，不再永远"不知道"。
  // 带任务书编号的目标：why 后面补「（任务书：章名·任务名）」，让她知道去任务书哪儿点（查不到就不补）。
  const route = [];
  try {
    for (const g of plan.campaignStatus({ items: [...(W.state?.items || []), ...homeStockItems()], completed: W.ftbq || null }).next.slice(0, 2)) {
      const label = g.quests?.length ? questLabel(g.quests[0]) : null;
      route.push({ text: `路线：${g.title}`, why: (g.hint || '') + (label ? `（任务书：${label}）` : '') });
    }
  } catch (_) {}
  // 路线那 2 条不被前面截掉：前面的先截到 7 条，再把路线接上
  return [...out.slice(0, 7), ...route].slice(0, 9);
}

/** 任务书里的「章名·任务名」（查不到返回 null，不硬编） */
function questLabel (qid) {
  try {
    if (!QL) {
      const q = JSON.parse(require('fs').readFileSync(require('path').join(paths.KNOWLEDGE, 'quests.json'), 'utf8'));
      QL = new Map(q.chapters.flatMap(ch => (ch.quests || []).map(x => [x.id, { title: x.title, chapter: ch.title }])));
    }
    const e = QL.get(qid);
    return e ? `${e.chapter}·${e.title}` : null;
  } catch (_) { return null; }
}
let QL = null;

/**
 * 【长期计划】：平时一行（目标 + 正在做的一步）；闲着的时候完整给（现状 + 可以做的），让她接着做 / 改计划。
 * 主人 2026-09-27：没人找她时自己根据状况推进游戏；顺序她自己定；思考时自动更新计划；闲着接着做当前任务。
 */
function planLine (why) {
  const cur = plan.current();
  const has = !!plan.get();
  let mlLine = '';
  try { const ms = plan.mainlineStatus({ completed: W.ftbq || null, items: W.state?.items || [] }); mlLine = `（通关主线 ${ms.done}/${ms.total}${ms.known ? '' : '，任务书进度没读到，按背包估的'}）`; } catch (_) {}
  if (why !== 'idle') return has ? `\n【长期计划】${plan.get().goal}${cur ? ` —— 正在做：${cur.text}` : '（都做完了）'}${mlLine}` : '';
  const f = planFacts();
  const ideas = [...plan.ideas(f).slice(0, 6), ...planExtras()].map(x => `· ${x.text}（${x.why}）`).join('\n');
  return `\n【长期计划】${mlLine}${has ? `\n${plan.render()}` : '还没有 —— 按这个整合包的通关主线，想好目标，用 plan_set 定下来（每步写上做成的标志）'}`
    + `\n现状：${plan.renderFacts(f)}`
    + (ideas ? `\n接下来可以做的（你自己挑、自己排）：\n${ideas}` : '')
    + `\n没人找你的时候：${cur ? `接着做「${cur.text}」` : '定下一步'}；做完了 / 情况变了就改计划（plan_step / plan_set）。有人找你就先陪人。`;
}

/**
 * 【手上的事】/【排着的】那两行（设计第六节 1）。任务对象、排序、文案**全在 `tasks.js`**，
 * 这里只负责"每轮拼一次、没有就整段不出现"。
 *
 * 为什么放在 `bodyNow()` 后面：bodyNow 说的是"身体此刻在动什么"（这一秒），
 * 这两行说的是"她心里记着的活儿"（能跨很多轮）。先说身体、再说记着的，读起来是顺的：
 * 身体正在做的那件 = 【手上的事】；排在后面还没轮到 / 被打断的 = 【排着的】。
 *
 * 阈值和文案（含"主人交代"、"做到第 N 步"、"被打断：…"）都不在这里 —— 见 `tasks.contextLines`，
 * 免得一个文案两处写、改了一处漏一处。
 */
function tasksBlock () {
  try { return tasks().contextLines(); } catch (_) { return ''; }
}

function buildNow (why) {
  const ev = W.pending.splice(0);
  const names = [...new Set([...ev.flatMap(e => e.names), ...W.players])];
  // 手上的事还跟着刚才那句话：他说"做面包"，走到箱子前、打开、合成的每一步都还该想起面包相关的事。
  // 以前靠旧的【此刻】里那份想起来的东西还留在意识流里；现在旧的会被精简（compactLastNow），所以把话题带着走
  const said = ev.filter(e => /说：/.test(e.text));
  if (said.length) W.topic = { cue: said.map(e => e.cue).join(' '), t: Date.now() };
  const topic = W.topic && Date.now() - W.topic.t < CFG.topicMs ? W.topic.cue : '';
  const cue = [...ev.map(e => e.cue), ...names, topic].join(' ');
  const hits = mem.recall(cue, { limit: 8 });
  const remembered = mem.renderRecall(hits, names);
  const eps = mem.recallEpisodes(cue, { limit: 6, before: W.contextSince });
  // 聊到某样东西：想起家里有没有、大概多少
  // 不只是有人说话的时候：她自己在找东西、做事（事件、心里惦记的菜）也会想起来
  // 还有她心里惦记着的：答应的事、打算（"答应做铁斧铁镐" → 想起家里的铁锭在哪）
  const minded = hits.filter(m => m.kind === 'promise' || m.kind === 'intention').map(m => m.text);
  const talk = [...ev.map(e => e.text.replace(/^\S+\s*/, '').replace(/^[^：]*说：/, '')), topic, ...minded, ambition.state().focus ? shortName(ambition.state().focus) : ''].join(' ');
  const stockHits = talk.trim() ? mem.homeHas(talk, shortName).filter(h => h.score >= 1).slice(0, 4) : [];
  const placesText = mem.renderPlaces(k => knowledge.label(k.includes(':') ? k : `minecraft:${k}`).replace(/\(.*\)$/, ''));
  const placesLine = placesText ? `\n【你记得的地方】\n${placesText}` : '';
  const stockLine = stockHits.length ? `\n家里（你记得的）：\n${mem.renderHomeStock(stockHits.map(h => h.id).join(' '), shortName, 4)}` : '';
  const earlier = eps.length ? mem.renderEpisodes(eps) : '';
  const A = ambition.state();
  const skills = mem.recallSkills(`${cue} ${A.focus || ''}`, { limit: 3 });
  // 闲着的时候想想自己的心愿；平时只惦记着正在研究的那道菜
  // 心愿不再单独占一段催她（闲着时它是【长期计划】里的一条候选，见 planExtras）；平时只惦记着正在研究的那道菜
  const dream = A.focus ? `（心里惦记着：${knowledge.label(A.focus)}）` : '';
  const s = W.state;
  const me = s?.pos;
  const playerNames = new Set((s?.players || []).map(p => p.username));
  const near = (s?.nearby || []).filter(e => !e.isDrop && e.name !== CFG.botName && !playerNames.has(e.name)).slice(0, 8).map(e => `${e.name}${e.distance != null ? `(${e.distance}格)` : ''}`).join('、');
  // 玩家：标出在上面还是下面（"来二楼"要知道二楼在自己上面还是下面 —— 实测她在三楼听到"来二楼"，往上爬去了四楼）
  const people = (s?.players || []).map(p => {
    if (!p.position || !me) return `${p.username}（在线，看不见）`;
    const dy = Math.round(p.position.y - me.y);
    const dh = Math.round(Math.hypot(p.position.x - me.x, p.position.z - me.z));
    const v = dy >= 2 ? `在你上方 ${dy} 格` : dy <= -2 ? `在你下方 ${-dy} 格` : '和你同一层';
    return `${p.username}：${v}、水平 ${dh} 格（${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}）`;
  }).join('；');
  const head = `【此刻 ${hhmmss()}】`;
  // 他刚说的最后一句：单独拎出来，先回这句（实测答非所问占晚期 20.8%：事件一多，她回的是更早那句，或者只回自己的进度）
  const lastSaid = [...ev].reverse().find(e => /说：/.test(e.text) && e.names?.length);
  const pro = W.lastProactive && !W.lastProactive.answered && Date.now() - W.lastProactive.t < 10 * 60 * 1000 ? W.lastProactive : null;
  const proLine = pro ? `\n（你 ${Math.max(1, Math.round((Date.now() - pro.t) / 60000))} 分钟前主动找他说过「${pro.text}」，他还没回 —— 没急事就先别再开口）` : '';
  const saidLine = lastSaid ? `\n【他刚说的】${lastSaid.text.replace(/^\S+\s*/, '')}（先接这一句）` : '';
  const happened = ev.length ? `\n刚才发生的：\n${ev.map(e => `[${hhmmss(e.t)}] ${e.text}`).join('\n')}` : `\n（${why === 'idle' ? `已经 ${Math.round((Date.now() - W.lastEventAt) / 1000)} 秒没发生什么了` : '没有新的事'}）`;
  const parts = [
    head,
    humanState(s) + (() => { const h = mem.getHome(); return h ? (mem.inHome(s?.pos) ? '、在家' : `、离家 ${Math.round(Math.hypot((s?.pos?.x ?? 0) - h.center.x, (s?.pos?.z ?? 0) - h.center.z))} 格`) : ''; })(),
    `普通物品栏（也是你的随身物品）：${invText(s?.items)}`,
    (() => {
      const e = s?.equipment; if (!e) return '';
      const zh = { head: '头', torso: '身上', legs: '腿', feet: '脚', 'off-hand': '副手', hand: '手里拿着' };
      const on = Object.entries(zh).filter(([k]) => e[k]).map(([k, v]) => `${v} ${knowledge.label(e[k])}`);
      return `穿戴：${on.length ? on.join('、') : '什么都没穿'}（装备栏里的不算在背包里）`;
    })(),
    (() => {
      // 饰品栏（背饰、戒指…）和背在背上的精妙背包 —— 两者都属于她自己的随身物品。
      // 不开界面只能用上次可信快照；0 格是“读不到”，绝不能渲染成“空”。
      const c = s?.curios; if (!c?.length) return '';
      const bp = s?.backpack;
      const valid = bp && Number.isFinite(bp.slots) && bp.slots > 0 && bp.items && typeof bp.items === 'object';
      const age = valid && Number.isFinite(bp.at) ? Math.max(0, Math.round((Date.now() - bp.at) / 1000)) : null;
      const when = age == null ? '' : age < 60 ? `${age} 秒前` : `${Math.round(age / 60)} 分钟前`;
      const inside = valid
        ? `（我的精妙背包，${when}打开时看到：${Object.entries(bp.items).map(([k, n]) => `${knowledge.label(k)}×${n}`).join('、') || '确实是空的'}，${bp.used}/${bp.slots} 格；查东西用 inventory(query)，需要确认现在没有就先 open_backpack 刷新）`
        : '（我的精妙背包；内容暂时读不到，不代表空，先 open_backpack 刷新）';
      return `饰品：${c.map(x => knowledge.label(x)).join('、')}${c.some(x => /backpack/.test(x)) ? inside : ''}`;
    })(),
    people ? `玩家：${people}` : '',
    near ? `身边：${near}` : '',
    dropLine(s),
    (() => { const open = (s?.doors || []).filter(d => d.open); return open.length ? `身边开着的门：${open.slice(0, 5).map(d => `${d.kind}(${d.x},${d.y},${d.z})`).join('、')}` : ''; })(),
    bodyNow(),
    (() => { const ci = combatInstinct(s); return ci ? `身体正在自己打${ci.name}${ci.killed ? `（已经打死 ${ci.killed} 只）` : ''}（战斗本能），不用你动手；要逃就说逃` : ''; })(),
    tasksBlock(),
    (() => { const f = survivalFocus(s); return f.length ? `\n【眼下最该操心的】\n${f.map(x => `· ${x}`).join('\n')}` : ''; })(),
    surroundLine(s),
    W.projects?.length ? `\n【进行中的工程】${W.projects.map(p => `${p.name}(${p.id}) 完成 ${p.done}，还要挖 ${p.toDig}、放 ${p.toPlace}${Object.keys(p.missing || {}).length ? `，缺 ${Object.entries(p.missing).slice(0, 4).map(([k, n]) => `${knowledge.label(k.includes(':') ? k : 'minecraft:' + k).replace(/\(.*\)$/, '')}×${n}`).join('、')}` : ''}`).join('；')}` : '',
    W.layouts?.length ? `\n【家里的布置规划】${W.layouts.map(l => `${l.name}：摆好 ${l.done}/${l.total}${Object.keys(l.stillWant || {}).length ? `，还想要 ${Object.entries(l.stillWant).slice(0, 5).map(([k, n]) => `${knowledge.label(k.includes(':') ? k : 'minecraft:' + k).replace(/\(.*\)$/, '')}×${n}`).join('、')}` : ''}${l.canPlaceNow?.length ? `（手上已有 ${l.canPlaceNow.join('、')}）` : ''}${l.stale?.length ? `；要重新想的区：${l.stale.join('、')}` : ''}`).join('；')}` : '',
    W.commands?.known ? `\n【你能用的命令】传送/回家类：${W.commands.teleport.length ? W.commands.teleport.map(c => '/' + c).join(' ') : '没有'}${W.commands.admin?.length ? `；管理员（玩家明确要求才用）：${W.commands.admin.map(c => '/' + c).join(' ')}` : ''}` : '',
    happened,
    saidLine,
    proLine,
    remembered ? `\n你想起来：\n${remembered}` : '',
    earlier ? `\n以前发生过的相关的事：\n${earlier}` : '',
    stockLine,
    placesLine,
    skills.length ? `\n你会的做法：\n${mem.renderSkills(skills)}` : '',
    planLine(why),
    dream ? `\n${dream}` : '',
    ev.some(e => /说：/.test(e.text)) ? '\n（打字：几条短的，一条 ≤12 字，换行分条；不用括号动作和～）' : '',
    ev.some(e => /说：/.test(e.text)) ? repetitionHint(W.replyShapes) : '',
    ev.some(e => /说：/.test(e.text)) ? particleHint(W.recentLines) : '',
  ];
  // brief：这一刻过去以后，意识流里只留"发生了什么"（见 think 里的 compactLastNow）
  return { text: parts.filter(Boolean).join('\n'), brief: head + happened, ev, names };
}

/**
 * 上一刻的【此刻】只留"发生了什么"，状态和想起来的东西去掉。
 *
 * 每一刻都会重新附上完整的状态、背包、想起来的笔记、家里存货、会的做法、心愿（约 2–2.5k 字），
 * 而且全部留在意识流里 —— 实测 12 次想之后历史 2.8 万字，真正新发生的事只有 1.7 千字，
 * 其余都是同一份快照抄了 12 遍（对 Ka_sum1 的印象、同一批打算…），每次调模型都整段重发。
 * 旧的背包/血量已经过时，还在的记忆这一刻会再想起来 —— 所以只有最新的一刻需要完整版。
 * 只改上一条（更早的已经改过），前面的历史不动，模型线路的前缀缓存照样能命中。
 */
/**
 * 最近几次回话都正好分成同样的条数（≥2 条、连着 ≥2 次）→ 提醒她这次换个样子。
 *
 * 真人打字不会一直是"两条两条"，条数定型本身就是 AI 感（她的每句话都挑不出毛病，但节奏像机器）。
 * 借自 HDS Interlude 的 repetition guard（src/narrator.ts detectMessageRepetition /
 * repetitionGuardInstruction，只借思路）：只看条数，1 条不管（一条是我们鼓励的默认形态）。
 */
function repetitionHint (shapes) {
  const b = shapes[shapes.length - 1];
  if (!(b >= 2)) return '';
  let n = 1;
  while (n < shapes.length && shapes[shapes.length - 1 - n] === b) n++;
  return n >= 2 ? `（你最近 ${n} 次回他都正好分成 ${b} 条 —— 真人打字不会一直一个样。这次别再是 ${b} 条：一句就够，或者换个条数；拿不准就一条。）` : '';
}

/**
 * 语气词别变口头禅：最近 6 条里同一个语气词出现 ≥2 次，或一半以上都带语气词 → 提醒这次不用。
 * 可爱靠偶尔软一句（2026-09-28 实测：改成可爱款后"呀"占了 30% 的消息，听多了像复读）。
 */
const PARTICLES = ['呀', '嘛', '哦', '诶', '呢', '啦', '呜'];
function particleHint (lines) {
  const last = lines.slice(-6);
  if (last.length < 3) return '';
  const hot = PARTICLES.filter(w => last.filter(x => x.includes(w)).length >= 2);
  const many = last.filter(x => PARTICLES.some(w => x.includes(w))).length * 2 >= last.length;
  if (!hot.length && !many) return '';
  return `（你最近老带${hot.length ? `"${hot.join('""')}"` : '语气词'} —— 这次不带${hot.length ? '这个' : ''}，平平地说就行）`;
}

/**
 * 空闲闸门：这一轮该不该跳过、不调模型。
 * 条件（**全中才跳**，任何一条不满足都放她去想）：
 *   1. 没有新事（W.pending 空）—— 有新事就必须想
 *   2. 没有人在跟她说话（这一刻的事里没有"说："）
 *   3. 没有紧急事（这一刻没有 urgent 标记）
 *   4. 身体正忙着自己的活（W.job 在跑，还没做完）
 *   5. 上一轮她什么也没说、什么也没做（只在等）
 * 满足 = "她闲着、身体在忙、也没人找她" —— 再问一遍模型只会得到又一个 wait。
 */
function idleGate () {
  if (W.pending.length) return false;                                   // 1 有新事
  const ev = W.lastNowEv || [];
  if (ev.some(e => /说：/.test(e.text))) return false;                   // 2 有人说话
  if (ev.some(e => e.urgent)) return false;                             // 3 有紧急事
  if (!W.job) return false;                                             // 4 身体没在忙（job 做完就置 null）
  if (W.job.holding) return false;                                      //    只是"一直跟着"不算在干活
  const lr = W.lastRoundResult;
  if (!lr || (lr.said && lr.said.length) || (lr.did && lr.did.length)) return false;   // 5 上一轮没在纯等
  return true;
}

function compactLastNow () {
  if (W.lastNow) { W.lastNow.msg.content = W.lastNow.brief; W.lastNow = null; }
}

async function think (why) {
  if (W.thinking || W.sleeping) { scheduleThink(CFG.debounceMs); return; }
  // 线路连着坏了 5 次：歇着，别空转（时间到了自然会被下一次 scheduleThink 唤醒）
  if (Date.now() < W.failUntil) { scheduleThink(W.failUntil - Date.now() + 100); return; }
  if (!W.pending.length && why !== 'idle') return;
  if (!W.state?.connected && !W.sim) return;
  // 空闲闸门（2026-09-28 审计方案 6A）：上一轮她啥也没干、只是在等，这一轮又没有新事、
  // 身体还自己忙着自己的活 —— 那就没必要再问模型一遍。省下的是"她闲着、身体在忙"这类
  // 最没信息量、却占了 15% 调用（日志里 232 次 `轮次：wait`）的往返。
  // ⚠️ 宁可放她过去（真的有事就让她想），也不要把有事的一轮挡掉 —— 所以条件卡得很死。
  if (idleGate()) { W.stats.idleSkipped = (W.stats.idleSkipped || 0) + 1; return; }
  W.thinking = true; W.thinkWhy = why; W.thinkCommitted = false; W.thinkDiscard = false;
  const histLen = W.history.length;   // 这一轮作废时退回到这里
  const heardAt = W.lastHeardAt || 0;  // 他最后一条的时间：回话的"打字"从这里算
  const ctl = new AbortController(); W.thinkCtl = ctl;
  const t0 = Date.now();
  const now = buildNow(why);
  W.lastNowEv = now.ev;   // 空闲闸门看"这一刻有没有人说话/急事"（见 idleGate）
  compactLastNow();
  const nowMsg = { role: 'user', content: now.text };
  W.history.push(nowMsg);
  W.lastNow = { msg: nowMsg, brief: now.brief };
  const didSay = []; const didDo = []; const noted = []; const rounds = []; let sentN = 0;
  let looked = false; let nudgedToLook = false; let nudgedToDecide = false;
  // 说话出口的三道闸：**每一句 say 都过一遍** —— 一轮里她说两条汇报，两条都该拦。
  // 但同一类提示一轮只塞一条（不然历史里堆满一样的话），所以用计数：拦了就 +1，
  // 只有当这一类"这一轮已经拦过"时才不再塞提示（话照样不发）。
  let quietNudged = 0; let askNudged = 0; let honestNudged = 0; let backNudged = 0;
  const nudgedOnce = (n) => n === 1;
  // 这一轮的工具结果（含身体动作的回报）——不说没发生的事，判据就用它（见 FACT_CLAIMS）
  const toolResults = [];
  // 身体刚回报的失败（now.ev 里的 ❌ / ↳ ✗ 行）**每一轮都记下来**，不只在她开口那轮 —— 失败那轮她可能没说话
  { const tNow = Date.now(); W.recentLive = [...(W.recentLive || []).filter(r => tNow - r.t < RECENT_CLAIM_MS), ...liveFails(now.ev).map(r => ({ ...r, t: tNow }))]; }
  const playerSaid = now.ev.filter(e => /说：/.test(e.text)).map(e => e.text.replace(/^[^：]*说：/, '')).join(' ');   // 他这一刻说的话   // 这一轮自己看过周围 / 背包没有（问"X在哪"之前要先看）
  // 他这句是在交代事情 → 记下时间：之后"做好了 / 做不成"算回他（taskDoneAllowed）
  if (playerSaid && TASK_ASK_RE.test(playerSaid)) W.lastTaskAskedAt = Date.now();
  // ── 任务队列（阶段 1，设计第四节）───────────────────────────────────────────
  // 他交代的事情**自动进队列**：他这一句命中了说话闸的 `TASK_ASK_RE`（判据只有那一条，这里不重写），
  // 就替他建一件 `source='player'` 的任务 —— 这样"被打断 / 他没再说"都不会丢事。
  // 同一句话、同一件事重复说 → `tasks.create` 认出 key 一样且没收尾，返回原来那件，不重复堆。
  // ⚠️ 只在他**真的说了**（`ev` 里带名字的"说："）时建 —— 她自己在心里想的、身体回报的不算。
  {
    const saidEvs = now.ev.filter(e => /说：/.test(e.text) && e.names?.length);
    for (const e of saidEvs) {
      const txt = e.text.replace(/^[^：]*说：/, '').trim();
      if (!txt || !TASK_ASK_RE.test(txt)) continue;
      const who = e.names[0];
      tasks().create({ title: txt.slice(0, 30), said: txt, source: 'player', askedBy: who, heardAt: e.t });
    }
    // "都别做了 / 算了 / 不用了"（判据 `tasks.DROP_ALL_RE`，只此一份）→ player 任务全部放下；self 不动。
    // 她自己会照队列回答"不做了"，这里只把记录改对，不替她说话。
    if (playerSaid && tasks().DROP_ALL_RE.test(playerSaid)) {
      const dropped = tasks().dropPlayerTasks({ why: `主人说：${playerSaid.slice(0, 40)}` });
      if (dropped.length) log(`📋 主人叫停 → 放下 ${dropped.length} 件他交代的事（${dropped.map(t => `#${t.id}`).join(' ')}）`);
    }
  }
  const heardPlayer = now.ev.some(e => /说：/.test(e.text) && e.names?.length); let nudgedToSay = false;
  // 他这一刻跟她说话了（【此刻】里"他说："）——说话出口的三个拦截都以它为准：
  // 他刚开口，她要回什么都不拦（任务书："他刚跟她说话时，回答他不受限"）
  const heJustSpoke = heardPlayer || /说：/.test(now.ev.map(e => e.text).join(' '));
  // 这一轮带哪些工具：常驻组 + 她叫过的组 + 场景认出来的组（见 GROUPS）。
  // 认场景只看"他刚说的 + 这一刻发生的事 + 身体的处境"——不多看历史，免得组一旦带出来就再也收不回去。
  W.groupRound = (W.groupRound || 0) + 1;
  const groupsOn = activeGroups();
  {
    const talk = [playerSaid, now.ev.map(e => e.text).join(' ')].join(' ');
    for (const c of GROUP_CUES) if (c.re.test(talk)) for (const g of c.groups) groupsOn.add(g);
    for (const g of groupsFromBody(W.state)) groupsOn.add(g);
  }
  // 这一轮真正要发的工具：每次调模型前重算 —— 她这一轮里刚用 tools(group) 叫进来的组要立刻生效
  const specsForRound = () => pickSpecs(W.state, new Set([...groupsOn, ...activeGroups()]));
  // 有时模型先查配方/用途，顺手说一句“好”，然后把这一刻当成做完了。
  // 这不是“只查资料就停”的合理结束：答应过的事要么开始做，要么说明做不到。
  let nudgedToAct = false;
  // ⚠️ 403 压缩的历史边界（codex R-fix4-2）：压缩"发不出去的那段"要保留**上一轮已经成功
  //    写入 history 的全部内容**（含 assistant 的 tool_calls 与配对的 tool 结果）。
  //    · historyStart = 本事件（这一轮 user 事件）开始前的位置 —— 这是**稳定**的边界，
  //      第一轮就被 403 挡住时从这里掐，不会像以前那样从 0 开始把启动日记和全部历史删光。
  //    · 一次"成功写完的轮次"结束后才把 blockedFrom 推进到那一刻的 history 长度，
  //      保证 tool_call / tool_result 成对保留，不会把上一轮成功的记录误删。
  const historyStart = Math.max(0, W.history.length - (nowMsg ? 1 : 0));   // nowMsg 刚 push 进去
  if (!(W.blockedFrom > 0) || W.blockedFrom > historyStart) W.blockedFrom = historyStart;
  try {
    for (let round = 0; round < CFG.maxRounds; round++) {
      W.history = repairHistory(W.history);
      // 每一轮都重算：她这一轮里新叫的组（tools）要立刻生效
      const msg = await body.llm({ messages: [{ role: 'system', content: SYSTEM }, ...W.history], tools: specsForRound(), timeoutMs: CFG.llmTimeoutMs, signal: ctl.signal });
      // 线路通了：把失败计数清零。
      // ⚠️ `blockedFrom` **不在这里**更新（codex R-fix4-2）：这里还只是"模型回了话"，
      //    本轮的 assistant / tool 消息**还没写进 history**。以前在这里取 `W.history.length`，
      //    后续 403 压缩就会把上一轮成功写下的 assistant/tool 记录一起删掉。
      //    正确的边界是"本事件开始前"的位置（historyStart），压缩完一个完整轮次后再推进它。
      W.failStreak = 0; W.auditStreak = 0; W.failUntil = 0;
      const calls = msg.tool_calls || [];
      rounds.push(calls.length ? calls.map(c => c.function?.name).join('+') : (msg.content ? '只写了正文' : '空回复'));
      W.history.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (msg.content) log(`💭 ${String(msg.content).slice(0, 200)}`);
      if (!calls.length) {
        // 他跟她说了话，她却只在正文里"回"了（没调 say）—— 正文是心里话，他看不见。提醒一次，让她自己决定说不说（不替她说）
        if (heardPlayer && !didSay.length && !nudgedToSay && round < CFG.maxRounds - 1 && msg.content) {
          nudgedToSay = true;
          W.history.push({ role: 'user', content: SAY_NUDGE });
          continue;
        }
        break;
      }
      let needMore = false; let end = false; const actions = [];
      // 要开口 / 动手 / 记东西了：先等他说完（只查资料的轮次不用等）
      if (calls.some(c => !['info', 'end'].includes(kindOf(c.function?.name)))) {
        const sayText = calls.filter(c => c.function?.name === 'say').map(c => parseArgs(c.function?.arguments).text || '').join('');
        await chatGate(ctl.signal, heardPlayer && heardAt && sayText ? heardAt + typingMs(sayText) : 0);
        W.thinkCommitted = true;
      }
      const saying = [];   // 这一轮的 say：等动作先开始再慢慢打字（见下面 startJob 之后）
      for (const c of calls) {
        const name = c.function?.name; const args = parseArgs(c.function?.arguments);
        // 打架时"玩家叫她过来 / 跟上"要能打断战斗（instinct 的 isPlayerUrgent 认 urgent:'player'）。
        // 不靠 LLM 记得填 fromPlayer（2026-09-29 Claude 复核：漏填就是"他喊了她不理"）——
        // 他这一轮刚开口、而且话里在叫她动，走路类工具自动带上。
        if (PLAYER_MOVE_TOOLS.has(name) && heJustSpoke && PLAYER_MOVE_RE.test(playerSaid) && args && typeof args === 'object') args.fromPlayer = true;
        const k = kindOf(name);
        if (k === 'info') looked = true;
        let out;
        if (name === 'say' && !looked && !nudgedToLook && ASKS_WHERE.test(String(args.text || ''))) {
          // "南瓜在哪"：自己还没看一眼就问他（2026-09-28 实测：南瓜就在他脚下，她下一轮 scan_blocks 才看见）
          nudgedToLook = true; needMore = true;
          W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: LOOK_NUDGE }) });
          continue;
        }
        if (name === 'say' && !nudgedToDecide && DELEGATES.test(playerSaid) && ASKS_BACK.test(String(args.text || ''))) {
          // "你规划一下储藏室" → "储藏室放哪层好？"：他把决定交给她，她又推回去（2026-09-28 实测）
          nudgedToDecide = true; needMore = true;
          W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: DECIDE_NUDGE }) });
          continue;
        }
        // ⚠️ 顺序：先查"有没有这回事"（honest），再看"该不该说"（report / ask）。
        //    "我睡了呀"既是完成式、又是汇报 —— 得先让她知道那件事根本没成功，
        //    不然会被当成"别播报"拦下，她收到的是错的提示。
        // ⚠️ 诚实这道**不看 heJustSpoke**（2026-09-29 Claude 复核）：实机那句"我睡了呀 剛起床"
        //    恰恰是在回他的话（他问是不是卡住了）。"少汇报 / 少问"在他刚说话时放行是对的，"别说没发生的事"任何时候都要管。
        //    证据也**跨轮**看（RECENT_CLAIM_MS 内）：实机睡觉 ✗ 在 03:51:27，那句话在 03:52:08 的下一轮。
        // ⚠️ "反问决定"这道也不看 heJustSpoke（见下面 ASK_BACK_NUDGE 那段）。
        if (name === 'say') {
          // 说了没发生的事：完成式发言，但最近的工具结果里没有对应的成功记录（2026-09-29 主人：不说没发生的事）
          const tNow = Date.now();
          const recent = (W.recentResults || []).filter(r => tNow - r.t < RECENT_CLAIM_MS);
          const lie = unbackedClaim(String(args.text || ''), [...recent, ...toolResults], W.recentLive);
          if (lie) {
            honestNudged++;
            needMore = true;
            W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: nudgedOnce(honestNudged) ? HONEST_NUDGE(lie) : `（这一条也没发出去：那个没成功 —— ${lie}。照实说，或者别提。）` }) });
            continue;
          }
        }
        // 他交代的事做完了（或做不成）→ 说一声是回他，不是旁白（主人 2026-09-29："箱子理好了这种完成玩家任务的话是可以的"）。
        // 一次交代只放行一次（见 taskDoneAllowed）。
        const doneOk = name === 'say' && taskDoneAllowed(String(args.text || ''), { lastTaskAskedAt: W.lastTaskAskedAt, lastTaskDoneSaidAt: W.lastTaskDoneSaidAt });
        if (doneOk) W.lastTaskDoneSaidAt = Date.now();
        // 火把开关（2026-09-29）：本能请她问的"家里挺暗的，要插火把吗"—— **唯一**放行的反问。
        // 判据在 gates.torchAskAllowed（带 askPlayer:'torch' 标记 + 本体对得上 + 同一问题冷却）。
        // 放行只免掉"反问 / 少问"那道闸；这句话是本能请她问的（家里插不插火把归主人定），
        // 不是她自己在追着问。**不放行任何别的问句**（没标记、或说的不是插火把，照拦）。
        const torchAskOk = name === 'say' && !doneOk &&
          torchAskAllowed(String(args.text || ''), args.askPlayer, { lastTorchAskSaidAt: W.lastTorchAskSaidAt });
        // ⚠️ 他刚开口时"回答他不受限"是给**回答**的，不是给"反问"的（2026-09-29 实机 19:10:16）：
        //    他问"今天干嘛"，她答"先在家插点火把 / 省得老刷怪 / 你想去哪呀" —— 最后一句把决定
        //    又丢回给他。判据在 `speech.asksBack()`（只此一处），**不看 heJustSpoke**（正相反，
        //    这道闸只在他在场/刚开口时最有意义：他自己问的"你想去哪"是另一回事，由判据里的
        //    "他在问你的意见"那条例外放行）。拦下不静默吞掉，给她提示重想。
        if (name === 'say' && !doneOk && !torchAskOk && speech.asksBack(String(args.text || ''), playerSaid)) {
          backNudged++;
          needMore = true;
          W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: nudgedOnce(backNudged) ? ASK_BACK_NUDGE : '（这一条也没发出去：你还是把问题丢回给他了。自己定一个说出来。）' }) });
          continue;
        }
        if (name === 'say' && !heJustSpoke && !doneOk && speech.classify(String(args.text || '')) === 'report' &&
            Date.now() - (W.lastHeardAt || 0) > QUIET_MS) {
          // 播报自己的动作 / 进度，他最近没问她 → 不发（他看得见）。2026-09-29 主人："尽量少汇报自己的动作状态"
          quietNudged++;
          needMore = true;
          W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: nudgedOnce(quietNudged) ? REPORT_NUDGE : '（这一条也没发出去：还是在播报你自己在干嘛。他没问，就别说。）' }) });
          continue;
        }
        if (name === 'say' && !heJustSpoke && !doneOk && !torchAskOk &&
            (isOverAsking(String(args.text || '')) || lastProactiveUnanswered())) {
          // 连着问他 / 上一个问题还没回又问 → 不发。2026-09-29 主人："尽量少询问玩家问题"
          askNudged++;
          needMore = true;
          W.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: nudgedOnce(askNudged) ? ASK_TOO_MUCH_NUDGE : '（这一条也没发出去：你还在问他。能自己决定的自己决定；真只有他知道的下次再说。）' }) });
          continue;
        }
        if (name === 'say') { saying.push({ c, args, p: runTool(name, args) }); continue; }
        if (!k) { out = { ok: false, error: `没有 ${name} 这个工具` }; needMore = true; review.record({ kind: 'unknown_tool', tool: name, args, ...scene(3) }); }
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
        }
        // 全随身物品可能超过普通工具结果的 1800 字；inventory 已支持 query，完整结果仍要留够
        // 空间让矿物等靠后的条目不会被截掉，避免“其实在精妙背包里却没看到”。
        W.history.push({ role: 'tool', tool_call_id: c.id, content: clipText(JSON.stringify(out), name === 'inventory' ? 6000 : 1800) });
        // 记一份给"不说没发生的事"用：这一轮（和身体刚回报的）每件动作的结果都在这儿
        toolResults.push({ tool: name, out });
        W.recentResults = [...(W.recentResults || []).filter(r => Date.now() - r.t < RECENT_CLAIM_MS), { tool: name, out, t: Date.now() }];
      }
      // 长任务（下矿、施工、整理）进行中，玩家只是聊天时，模型偶尔会顺手调 look_at。
      // 这类回应不应把正在执行的身体任务顶掉；真正的"过来/停下/换一件事"仍保留为可打断动作。
      // （阶段 1 起这只是"提前筛一遍"—— 真正的判据已挪进 `tasks.NO_BODY_TOOLS`，
      //   `startJob` 里对**所有**"不动身体"的工具一视同仁，不只 look_at。这里留着是给
      //   `didDo` 一个干净的名字，避免把 look_at 也写进"做了这些"。）
      if (W.job && heardPlayer && actions.length && actions.every(a => a.tool === 'look_at')) actions.length = 0;
      const roundSaid = calls.filter(c => c.function?.name === 'say').map(c => parseArgs(c.function?.arguments).text || '');
      const affirmative = [...roundSaid, msg.content || ''].some(isBareAffirmative);
      const infoOnly = !actions.length && !end && calls.some(c => kindOf(c.function?.name) === 'info');
      if (affirmative && infoOnly && !nudgedToAct && round < CFG.maxRounds - 1) {
        nudgedToAct = true;
        W.history.push({ role: 'user', content: ACTION_NUDGE });
        needMore = true;
      }
      const spokeOnly = !actions.length && !end && calls.every(c => ['speech', 'memory'].includes(kindOf(c.function?.name)));
      if (spokeOnly && round < CFG.maxRounds - 1) needMore = true;
      if (actions.length) {
        didDo.push(...actions.map(a => a.tool));
        // "为了什么"：她自己当时的想法最好；没有就用触发这件事的那句话
        const talk = now.ev.filter(e => /说：/.test(e.text)).map(e => e.text.replace(/^\S+\s/, '')).pop();
        const why = String(msg.content || talk || now.ev.map(e => e.text.replace(/^\S+\s/, '')).join(' ')).replace(/\s+/g, ' ').slice(0, 60);
        // `heardPlayer` 传下去 → 她动手时若把手上那件打断了，理由是"主人插了别的事"（player）
        // 而不是"自己想换"（self）。判据用在哪、怎么用都在 tasks.interruptKind / pauseWhyFor（只此一份）。
        startJob(actions, why, { heardPlayer });
      }
      // 动作已经开始了，再等话打完发出去（以前先打字、打完才动 —— 说了"来啦"要好几秒才迈腿）
      for (const { c, args, p } of saying) {
        const out = await p;
        if (args.inner) log(`💭 ${String(args.inner).slice(0, 120)}`);
        if (out.ok) {
          didSay.push(args.text || args.message); sentN += (out.sent || []).length;
          // 真的问出去了才记时间（见 isOverAsking）：拦下的不算，追问才拦得住
          if (speech.classify(String(args.text || '')) === 'ask') W.lastAskedAt = Date.now();
          // 火把问题真说出去了 → 记这一问的时刻（见 gates.torchAskAllowed）：
          // 同一个问题冷却期内不再放行第二遍（免掉"反问"闸 ≠ 可以追着问）。
          if (out.askPlayer === 'torch') W.lastTorchAskSaidAt = Date.now();
        }
        W.history.push({ role: 'tool', tool_call_id: c.id, content: clipText(JSON.stringify(out)) });
      }
      // 这一轮的 assistant / tool 消息**全部写完**了 —— 现在才推进压缩边界。
      // 下一次 403 掐历史时，这一轮（含配对的 tool_calls / tool_result）会被完整保留（codex R-fix4-2）。
      W.blockedFrom = W.history.length;
      if (end || !needMore) break;
    }
  } catch (e) {
    // 内容审计（403）也是"不可重试"的一种 —— 但它是唯一一种掐掉内容后还有救的，
    // 所以单独走上面的 audit 分支（压缩 → 再试），不算致命错。
    const isAudit = e.kind === 'content' || (e.status === 403 && e.message !== 'aborted');
    if (e.message !== 'aborted' && (isAudit || e.retryable !== false)) {
      W.stats.errors++;
      log(`❌ 想的时候出错：${e.message}`);
      review.record({ kind: 'llm_error', error: e.message, errKind: e.kind, retry: now.ev.some(x => x.retried), ...scene(3) });
      const talked = now.ev.some(x => x.names.length && /说：/.test(x.text));
      // ⚠️ 不是内容审计就把 auditStreak 清零（codex R-fix4-3）：
      //    以前只在成功时清零，"403 → 502 → 403"会被当成"连续两次 403"而误触发压缩，
      //    把一段本来没问题的历史掐掉。任何非 content 错误都打断"连续审计"这个计数。
      if (!isAudit) W.auditStreak = 0;
      if (isAudit) {
        W.auditStreak++;
        if (W.auditStreak >= 2) {
          // 从本事件开始前的稳定边界往后掐（W.blockedFrom 见 think 开头）。
          // 绝不从 0 掐 —— 那会把启动日记和全部既有历史删光（codex R-fix4-2）。
          const from = Math.max(0, Math.min(W.blockedFrom || 0, W.history.length));
          if (W.history.length > from) {
            const dropped = W.history.length - from;
            // 保留整段：从 from 往后整片切掉，避免只留半个 tool_call/tool_result 对
            W.history = W.history.slice(0, from);
            W.history.push({ role: 'user', content: '（有一段内容发不出去，已略过）', keep: true });
            W.lastNow = null;
            log(`🚫 内容发不出去，掐掉意识流后段 ${dropped} 条，重试`);
          }
        }
      }
      W.failStreak++;
      // 连着失败太多次（线路真坏了 / 内容一直发不出去）：别一秒一次空转 —— 停 5 分钟。
      // 玩家那边不提技术细节，只说一句她自己的话。
      if (W.failStreak >= 5) {
        W.failUntil = Date.now() + 5 * 60 * 1000;
        W.failStreak = 0; W.auditStreak = 0;
        log('⏸ 线路连着失败 5 次，歇 5 分钟');
        for (const x of now.ev) x.retried = true;
        W.pending.unshift(...now.ev);
        emit(talked ? '我先缓一下，等会儿再说' : '脑子有点转不动，歇一会儿', {});
      } else if (!now.ev.some(x => x.retried)) {
        // 先别说"卡了"：把这些事放回去，过一会儿再想一次（线路的毛病多半一会儿就好）
        for (const x of now.ev) x.retried = true;
        W.pending.unshift(...now.ev);
        const backoff = Math.min(2000 * 2 ** (W.failStreak - 1), 60000);   // 2s → 4s → 8s … 最多 60s
        log(`⏳ ${backoff / 1000}s 后再想（连续失败 ${W.failStreak} 次）`);
        setTimeout(() => scheduleThink(0), backoff);
      } else if (talked) {
        // 第二次还是不行：有人在跟她说话，至少让他知道她听见了
        // 5 分钟内只说一次：以前线路一坏，这句被连着发了 12 遍，成了她的"台词"
        if (Date.now() - (W.lastStuckLineAt || 0) > 5 * 60 * 1000) {
          W.lastStuckLineAt = Date.now();
          bridge.post('/chat', { messages: ['刚卡了', '你再说一遍'], gapMs: [400, 700] }).catch(() => {});
        }
      }
    } else if (e.message !== 'aborted') {
      // 不可重试的错（400 请求格式、404 之类）：重试也是一样的结果，留着现场别空转
      W.stats.errors++;
      log(`❌ 这一轮发不出去（${e.kind || 'request'}）：${e.message}`);
      review.record({ kind: 'llm_error', error: e.message, errKind: e.kind || 'request', fatal: true, ...scene(3) });
      W.pending.unshift(...now.ev);
    } else if (W.thinkDiscard && !W.thinkCommitted) {
      // 他又说了一句、这一轮还没说出口：整轮作废 —— 意识流退回想之前，事放回去和新的一起重想
      W.history.length = histLen; W.lastNow = null;
      W.pending.unshift(...now.ev);
      log('🔁 他又说了一句，刚才没说出口的作废，重想');
    } else {
      // 被打断：把这一轮没想完的事放回去，和新事一起想
      W.pending.unshift(...now.ev);
    }
    if (!(W.thinkDiscard && !W.thinkCommitted)) trimDangling();
  } finally {
    // ⚠️ 这里的三件事**顺序不能动**，而且都得在 `W.thinking` 放下来之前做完。
    //
    // `sortMemories` 会往 `W.history` 里 push、最后还会**整体替换**它；`think` 也在改同一个
    // `W.history`。两者的互斥原来靠"先 W.thinking=false、紧接着 sleepAndSort 里 W.sleeping=true
    // 中间恰好没有 await"—— 那是**隐式**的：中间只要多一个 await（哪怕只是把某个 log 换成
    // 异步的），新的一刻就会插进来跟整理抢同一个 history（实测 01:25 把日记当回复写了、连睡两次）。
    // 所以整理挪进 finally、放在放下 thinking 之前，让互斥变成**显式**的：
    //   · 整理期间 W.thinking 还是 true → 任何 think 都被挡在外面
    //   · sleepAndSort 用 internal:true 跳过"thinking 还挂着"这道自我拦截
    //   · W.thinkCtl 先置空 —— 不然这时候有人喊她，emit 会去 abort 一个早就结束的请求（无害但没意义）
    W.thinkCtl = null;
    // 说了"我去 / 这就来"，这一轮却一个动作都没有（身体也闲着）—— 玩家会以为她在敷衍
    if (didSay.length && !didDo.length && !W.job && review.looksLikePromise(didSay.join(' '))) {
      review.record({ kind: 'said_no_action', said: didSay.join(' / '), rounds: rounds.join(' → '), ...scene(3) });
    }
    // 没人跟她说话、她自己开的口 = 主动找他。记下来，下一刻提醒她（他没回就别追着问）
  if (sentN && heardPlayer) { W.replyShapes.push(sentN); if (W.replyShapes.length > 8) W.replyShapes.shift(); }
  for (const t of didSay) for (const x of String(t).split(/[\n⏎]/).map(y => y.trim()).filter(Boolean)) { W.recentLines.push(x); if (W.recentLines.length > 8) W.recentLines.shift(); }
  if (didSay.length && !now.ev.some(e => /说：/.test(e.text))) W.lastProactive = { t: Date.now(), text: didSay.join(' / '), answered: false };
  log(`🧠 ${why} ${Date.now() - t0}ms｜说[${didSay.join(' / ')}] 做[${didDo.join(',')}]${noted.length ? ` 记[${noted.join(',')}]` : ''}｜轮次：${rounds.join(' → ') || '无'}`);
    mem.save();
    if (historyChars() > CFG.maxHistoryChars) {
      try { await sleepAndSort({ internal: true }); } catch (e2) { log(`😴 整理记忆失败：${e2.message}`); }
    }
    // 记下这一轮的结果：空闲闸门看"上一轮是不是纯等"（见 idleGate）
    W.lastRoundResult = { said: didSay.slice(), did: didDo.slice(), rounds: rounds.slice(), at: Date.now() };
    W.thinking = false; W.thinkWhy = null; W.lastThinkAt = Date.now();
    W.stats.thinks++; W.stats.llmMs += Date.now() - t0;
  }
  if (W.pending.length) scheduleThink(CFG.debounceMs);
}

/** 她只在正文里"回话"时的提醒（实测：gemini 常把回话写成正文不调 say，游戏里他就看不到 —— 2026-09-26 跑分发现 52 题） */
/** 问"X 在哪"之前没看过周围时的提醒（不替她说，只让她先看） */
/** 他明确让"你"来定 / 来做（简繁都认）；她回的却是反问 */

function clipText (s, max = 1800) { return s.length > max ? s.slice(0, max) + '…' : s; }

/**
 * 让历史里的工具调用和结果一一对上（模型只要对不上就整段拒收）。
 *
 * 实测（2026-09-26 00:38–00:46）：想到一半被新事打断，某一轮 tool_calls 只记下了部分结果 →
 * 中转站报 "tool calls and tool results do not match" / Gemini 报 "functionCall appears before
 * pending functionResponse"，之后**每一次**想都失败，她连续 8 分钟多没反应。trimDangling 只看最后一条，漏了这种。
 * 修法：缺结果的补一条"被打断了"，没有对应调用的孤立结果删掉。每次调模型前都过一遍。
 */
function repairHistory (h) {
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const m = h[i];
    if (m.role === 'tool') continue;   // 结果只跟在它的调用后面收；落单的丢掉
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map(c => c.id);
    const got = new Map();
    let j = i + 1;
    for (; j < h.length && h[j].role === 'tool'; j++) if (ids.includes(h[j].tool_call_id) && !got.has(h[j].tool_call_id)) got.set(h[j].tool_call_id, h[j]);
    for (const id of ids) out.push(got.get(id) || { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: false, error: '被打断了，没做完' }) });
    i = j - 1;
  }
  return out;
}

/** 出错时最后一条可能是带 tool_calls 却没有对应 tool 结果的 assistant —— 模型会拒收，去掉 */
function trimDangling () {
  while (W.history.length) {
    const last = W.history[W.history.length - 1];
    if (last.role === 'assistant' && last.tool_calls) { W.history.pop(); continue; }
    // 内容发不出去时留下的那一行要留着 —— 它是那段被掐掉内容的唯一交代
    // （普通的 user 消息后面会由 pending 重新补上，这一行没有地方补）
    if (last.role === 'user' && W.pending.length && !last.keep) { W.history.pop(); continue; }
    break;
  }
}

// ------------------------------------------------------------------ 睡觉整理

/**
 * 上下文快满了：让她自己整理 —— 挑要记住的写下来、检查旧教训、写一段日记。
 * 然后只留日记和最近几条原话继续活下去（Astra 在 Codex 里就是这样跨上下文的）。
 *
 * `internal`：这次整理是 `think` 自己在 finally 里叫的。那时 `W.thinking` **还挂着**
 * （故意的 —— 见 think 里那段注释，整理和想必须互斥），所以不能拿 `W.thinking` 把自己挡在外面。
 * 外部调用（`POST /mind/sleep`）不传，照旧被 `W.thinking` 挡住。
 */
async function sleepAndSort ({ internal = false } = {}) {
  // 睡着时不能同时"想"：实测（01:25）新的一刻插进来接了睡前整理的话，把日记当成回复写了，接着又连睡两次
  if (W.sleeping || (!internal && W.thinking)) return;
  W.sleeping = true;
  try { await sortMemories(); } finally { W.sleeping = false; }
}

async function sortMemories () {
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
      W.history = repairHistory(W.history);
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
    if (url === '/mind/review') {
      // 自我复盘报告（markdown）。?since=2h / 3d / all，默认本次醒来以后
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      let since;
      try { since = q.has('since') ? review.parseSince(q.get('since')) : W.startedAt; } catch (e) { return send(400, { error: e.message }); }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return res.end(review.render(review.read({ since }), { since }));
    }
    if (url === '/mind/debug') return send(200, { recentLLM: body.recent, historyTail: W.history.slice(-6) });
    if (url === '/mind' || url === '/brain') {
      const S = mem.load();
      return send(200, {
        model: CFG.model, thinking: W.thinking, sleeping: W.sleeping, pending: W.pending.length,
        body: bodyNow(), historyChars: historyChars(), historyMessages: W.history.length,
        stats: { ...W.stats, avgThinkMs: W.stats.thinks ? Math.round(W.stats.llmMs / W.stats.thinks) : null },
        memory: mem.stats(),
        llmUsage: { ...body.usage, perHour: (() => { const h = (Date.now() - body.usage.since) / 3600000; return h > 0.01 ? { calls: Math.round(body.usage.calls / h), inTok: Math.round(body.usage.inTok / h), outTok: Math.round(body.usage.outTok / h), inChars: Math.round(body.usage.inChars / h) } : null; })(), avgInChars: body.usage.calls ? Math.round(body.usage.inChars / body.usage.calls) : null },
        people: S.people,
        recentMemories: S.memories.slice(-15),
        // 任务队列（阶段 1，任务书观测项）：她手上 / 排着的都是什么、都到哪一步了。
        // `context` 是此刻拼进上下文的那两行原文 —— 一眼就能看出"她看到的"和"实际有的"对不对得上。
        tasks: { lines: tasks().contextLines(), open: tasks().open().map(t => ({ id: t.id, title: t.title, source: t.source, status: t.status, pausedWhy: t.pausedWhy })) },
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

module.exports = { historyChars, bodyNow, knownStations, shortName, homeStockItems, planFacts, planExtras, questLabel,
  planLine, buildNow, repetitionHint, PARTICLES, particleHint, idleGate, compactLastNow, think,
  clipText, repairHistory, trimDangling, sleepAndSort, sortMemories, autopilot, holdBody, startControl };
