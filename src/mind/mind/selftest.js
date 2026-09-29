#!/usr/bin/env node
'use strict';

/**
 * selftest.js —— `--selftest` 的那约 1000 行断言（从 `src/mind/mind.js` **原样搬来**）。
 *
 * ⚠️ 正确的自测入口是根目录的 `node mind.js --selftest`（`src/mind/mind.js --selftest`
 * 是空跑，见 AGENTS.md）—— 根入口一行转发到汇总，汇总再调这里的 `selftest()`。
 *
 * 搬进这里时断言**一条都没改**（条数拆前 243，拆后必须一样）。它用到的名字全部从兄弟
 * 文件取；防抖计时器的句柄 `thinkTimer` / `thinkTimerAt` 的唯一一份在 runtime.js，
 * 这里用 `thinkTimerValue()` / `thinkTimerAtValue()` / `clearThinkTimer()` **读写同一份**。
 *
 * 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。
 */

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const rt = require('./runtime');
const { log, hhmmss, emit, chatWaitLeft, typingMs, chatGate, scheduleThink } = rt;
const { humanState, tonight, combatInstinct, combatGuard, attackGuardReason, survivalFocus,
  dayKey, dropsNear, dropLine, invText, surroundNeeds, surroundLine, pickJoinMood, JOIN_MOODS } = require('./scene');
const { look } = require('./look');
const { MIND_TOOLS, ALL, SPECS, GROUPS, TOOL_GROUPS, UNGROUPED, GROUP_ROUNDS, GROUP_CUES,
  groupsFromBody, pickSpecs, activateGroup, activeGroups, kindOf, groupsFromTasks } = require('./tools');
const { startJob, runTool, fmtArgs, toolResultLine, celebrate, learnFromDoing,
  instinctEat, NAME_RE, FAST, matchFast, fastPath } = require('./actions');
const { historyChars, bodyNow, knownStations, shortName, homeStockItems, planFacts, planExtras,
  planLine, questLabel, buildNow, repetitionHint, PARTICLES, particleHint, idleGate, compactLastNow, think,
  clipText, repairHistory, trimDangling, sleepAndSort, sortMemories, autopilot, holdBody,
  startControl } = require('./think');
const { isBareAffirmative, taskDoneAllowed, isOverAsking, lastProactiveUnanswered, claimState,
  liveFails, unbackedClaim, FACT_CLAIMS, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, HONEST_NUDGE, QUIET_MS,
  ASK_COOLDOWN_MS, DELEGATES, ASKS_BACK, DECIDE_NUDGE, ASKS_WHERE, LOOK_NUDGE, SAY_NUDGE,
  ACTION_NUDGE, RECENT_CLAIM_MS, PLAYER_MOVE_TOOLS, PLAYER_MOVE_RE, TASK_WINDOW_MS, TASK_ASK_RE,
  TASK_DONE_RE, torchAskAllowed, TORCH_ASK_COOLDOWN_MS, dropTellAllowed } = require('./gates');
const { SYSTEM } = require('./prompt');

// 防抖计时器只此一份（runtime.js 里那两个模块级 let）：读 / 清走这三个。
function thinkTimerValue () { return rt.readingThinkTimer(); }
function thinkTimerAtValue () { return rt.readingThinkTimerAt(); }
function clearThinkTimer () { rt.clearThinkTimer(); }

function mockBridge () {
  const inv = [{ name: 'egg', count: 7 }, { name: 'stick', count: 4 }];
  const ans = (p) => {
    if (p.startsWith('/status')) return { connected: true, health: 18, food: 15, isDay: true, position: { x: 35, y: 64, z: -138 } };
    if (p.startsWith('/inventory')) return { items: inv };
    if (p.startsWith('/nearby')) return { entities: [{ name: 'Ka_sum1', distance: 3, type: 'player' }] };
    if (p.startsWith('/players')) return { players: [{ username: 'Ka_sum1', distance: 3, position: { x: 37, y: 64, z: -138 } }] };
    if (p.startsWith('/chatlog')) return { messages: [] };
    if (p.startsWith('/scan')) return { blocks: [{ name: 'smoker', count: 1, nearest: { x: 38, y: 64, z: -139 }, distance: 3.2 }] };
    // 本能层现在什么样（战斗本能在打时 combatNow 非 null）
    if (p.startsWith('/instinct/events')) return { seq: 0, events: [] };
    if (p.startsWith('/instinct')) return { installed: true, combatNow: null, urgent: null, running: null };
    // 她的余光（野外资源感知）：桥接聚好的一条 + 结构化条目
    if (p.startsWith('/surroundings')) return { ok: true, radius: 32, at: Date.now(), line: '没开过的箱子 2 个（东北 20 格）、橡树 9 棵（东 6 格）', items: [{ kind: 'container', outdoor: true }, { kind: 'log' }], perf: { ms: 3, worstMs: 0.2 } };
    if (p.startsWith('/chests/unseen')) return { chests: [] };
    return { success: true };
  };
  return {
    get: async (p) => ans(p),
    post: async (p, b) => {
      if (p === '/chat') for (const m of b.messages || [b.message]) console.log(`      💬 <Angle_ICE> ${m}`);
      else if (!['/stop', '/look', '/memory'].includes(p)) console.log(`      🦾 ${p} ${JSON.stringify(b)}`);
      await new Promise(r => setTimeout(r, 200));
      if (p === '/smelt') return { success: true, smelted: 'minecraft:egg', in: 'smoker', got: { 'farmersdelight:fried_egg': 7 }, gotCount: 7 };
      if (p === '/give') return { success: true, given: 'farmersdelight:fried_egg', count: 7, to: b.player, confirmed: true };
      return ans(p);
    },
  };
}


async function selftest () {
  // 整个自测期间任务队列都写临时文件：前面的对话自测也会触发「主人交代 → 自动建任务」，
  // 以前只在任务那一节才切到临时文件，前面几节已经把「去把南瓜砍了」写进了真的 memory/tasks.json（2026-09-29 Claude 复核补）
  if (!process.env.MC_TASKS_FILE) process.env.MC_TASKS_FILE = require('path').join(require('os').tmpdir(), `tasks-selftest-${process.pid}.json`);
  let pass = 0; let total = 0;
  const check = (label, cond, d) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${JSON.stringify(d)}`}`); };
  process.env.MC_MIND_FILE = require('path').join(require('os').tmpdir(), `mind-test-${process.pid}.json`);
  process.env.MC_REVIEW_FILE = require('path').join(require('os').tmpdir(), `review-test-${process.pid}.jsonl`);
  mem._reset();
  body._setBridge(mockBridge());
  console.log = ((o) => (...a) => { if (!String(a[0]).startsWith('      ')) o(...a); })(console.log);
  W.sim = true;
  W.state = { connected: true, health: 18, food: 15, isDay: true, pos: { x: 0, y: 64, z: 0 }, items: [], nearby: [], players: [] };

  console.log('\n全部随身物品：普通物品栏 + 精妙背包');
  {
    const now = Date.now();
    body._setBridge({ get: async (p) => p === '/inventory'
      ? { items: [{ name: 'iron_ingot', count: 3 }] }
      : { curios: ['sophisticatedbackpacks:diamond_backpack'], equipment: {}, backpack: { items: { 'minecraft:raw_iron': 13 }, slots: 108, used: 1, at: now } } });
    const found = await body._personalInventory({ query: '铁' });
    check('查询同时合并普通物品栏和精妙背包', found.combined['minecraft:iron_ingot'] === 3 && found.combined['minecraft:raw_iron'] === 13, found);
    check('刚刷新过两处，可以判断有没有', found.absenceProven === true, found);
    body._setBridge({ get: async (p) => p === '/inventory'
      ? { items: [] }
      : { curios: ['sophisticatedbackpacks:diamond_backpack'], equipment: {}, backpack: { items: {}, slots: 0, used: 0, at: now } } });
    const unreadable = await body._personalInventory({ query: '铁锭' });
    check('0/0 是读不到，不是假装空背包', unreadable.sophisticatedBackpack.readable === false && unreadable.absenceProven === false, unreadable);
    check('读不到时不说"没有"', /读不到|不能说没有/.test(unreadable.note), unreadable.note);

    // 2026-09-29 问题 4：快照太旧 / 从没看过 → **身体层自己开背包刷新**，不再推给 LLM
    const old = now - 600000;   // 10 分钟前的旧快照
    let opened = 0;
    const withBackpack = (at) => ({
      get: async (p) => {
        if (p === '/inventory') return { items: [] };
        // 刷新后（opened>0）返回新鲜快照；刷新前返回旧的
        return { curios: ['sophisticatedbackpacks:diamond_backpack'], equipment: {}, backpack: opened ? { items: { 'minecraft:raw_iron': 5 }, slots: 108, used: 1, at: Date.now() } : { items: { 'minecraft:raw_iron': 5 }, slots: 108, used: 1, at } };
      },
      post: async (p) => { if (p === '/backpack/open') opened++; return { success: true }; },
    });
    body._setBridge(withBackpack(old));
    const stale = await body._personalInventory({ query: '粗铁' });
    check('★ 旧快照 → 自己开了背包刷新（不用 LLM 先 open）', opened === 1, opened);
    check('★ 刷新后拿到新鲜内容、resortedOnQuery=true', stale.sophisticatedBackpack.refreshedOnQuery === true && stale.combined['minecraft:raw_iron'] === 5, stale.sophisticatedBackpack);
    check('刷新后可以判断有没有', stale.absenceProven === true, stale);
    opened = 0;
    body._setBridge(withBackpack(Date.now()));   // 新鲜快照：不该再开
    const fresh = await body._personalInventory({ query: '粗铁' });
    check('★ 快照还新鲜 → 不重复开背包（省一次界面）', opened === 0, opened);
    // 刷新失败 → 如实说"读不到"，不说"没有"
    opened = 0;
    body._setBridge({
      get: async (p) => (p === '/inventory' ? { items: [] } : { curios: ['sophisticatedbackpacks:diamond_backpack'], equipment: {}, backpack: { items: {}, slots: 0, used: 0, at: old } }),
      post: async () => { throw new Error('背包没打开（身上、背饰上都没有背包？）'); },
    });
    const failed = await body._personalInventory({ query: '粗铁' });
    check('★ 刷新失败 → readable=false 且带上失败原因', failed.sophisticatedBackpack.readable === false && /没开成/.test(failed.sophisticatedBackpack.note || ''), failed.sophisticatedBackpack);
    check('★ 刷新失败也不说"没有"', failed.absenceProven === false, failed);
    body._setBridge(mockBridge());
  }

  console.log('\n快速通道');
  check('"安琪跟我来" → follow', matchFast('安琪跟我来')?.id === 'follow');
  check('复杂的话不走快速通道', matchFast('跟我来然后帮我挖矿') === null);

  console.log('\n回话条数别定型（repetitionHint）');
  check('连着 2 次都 2 条 → 提醒', /2 次.*2 条/.test(repetitionHint([1, 2, 2])), repetitionHint([1, 2, 2]));
  check('连着 3 次都 3 条 → 数对', /3 次.*3 条/.test(repetitionHint([3, 3, 3])), repetitionHint([3, 3, 3]));
  check('一条一条的不管', repetitionHint([1, 1, 1, 1]) === '');
  check('只有一次 2 条不提醒', repetitionHint([1, 2]) === '' && repetitionHint([2]) === '' && repetitionHint([]) === '');
  check('条数变了就不提醒', repetitionHint([2, 2, 3]) === '');

  console.log('\n等他说完再回（chatQuietMs）');
  {
    const t = Date.now();
    const clean = () => { clearThinkTimer(); W.pending = []; W.chatWait = null; };
    clean();
    emit('💬 Ka_sum1 说：那个', { names: ['Ka_sum1'], chat: true });
    check('第一条来了：开口前要等 4 秒', CFG.chatQuietMs === 4000 && Math.abs(W.chatWait.until - Date.now() - CFG.chatQuietMs) < 50 && chatWaitLeft() > CFG.chatQuietMs - 50, W.chatWait);
    check('但马上开始想（不是干等完才想）', thinkTimerValue() && thinkTimerAtValue() - Date.now() < 50);
    W.chatWait.first = t - 10000;
    emit('💬 Ka_sum1 说：箱子里', { names: ['Ka_sum1'], chat: true });
    check('他一直在打：最多等 12 秒（从第一条算）', W.chatWait.until === W.chatWait.first + CFG.chatQuietMaxMs, W.chatWait);
    emit('💔 掉血 18 → 6', { urgent: true });
    check('等的时候来了急事：不等了，马上想', chatWaitLeft() === 0 && thinkTimerAtValue() - Date.now() < 50);
    clean();
    W.chatWait = { first: t - 6000, until: t - 1000 }; W.pending = [{ chat: true }];
    check('过了 4 秒没新的：不用等了', chatWaitLeft() === 0);
    clean();
    // 想到一半他又说一句：没开口 → 作废；开了口 → 不动
    const ctlA = new AbortController(); W.thinking = true; W.thinkCommitted = false; W.thinkCtl = ctlA;
    emit('💬 Ka_sum1 说：有铁吗', { names: ['Ka_sum1'], chat: true });
    check('没说出口时又来一句：这一轮作废', ctlA.signal.aborted && W.thinkDiscard === true);
    clean();
    const ctlB = new AbortController(); W.thinkCommitted = true; W.thinkDiscard = false; W.thinkCtl = ctlB;
    emit('💬 Ka_sum1 说：算了', { names: ['Ka_sum1'], chat: true });
    check('已经说出口 / 动手了：不作废，下一轮再接', !ctlB.signal.aborted && !W.thinkDiscard);
    W.thinking = false; W.thinkCtl = null; W.thinkCommitted = false; clean();
  }
  console.log('\n开口前的门（chatGate）');
  {
    W.pending = []; W.chatWait = { first: Date.now(), until: Date.now() + 150 };
    const t0 = Date.now(); await chatGate(new AbortController().signal);
    check('等到他说完才放行', Date.now() - t0 >= 140 && W.chatWait === null, Date.now() - t0);
    W.chatWait = { first: Date.now(), until: Date.now() + 5000 };
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 30);
    const r = await chatGate(ctl.signal).then(() => 'passed', e => e.message);
    check('等的时候被作废：抛 aborted', r === 'aborted', r);
    W.chatWait = null;
    check('打字时间：短的 ≈2 秒（被 4 秒盖住）', typingMs('好') === 2150, typingMs('好'));
    check('打字时间：27 字 ≈6 秒', typingMs('一二三四五六七八九十一二三四五六七八九十一二三四五六七') === 6050, typingMs('一二三四五六七八九十一二三四五六七八九十一二三四五六七'));
    check('打字时间：再长也最多 8 秒', typingMs('字'.repeat(200)) === 8000);
    const t1 = Date.now(); await chatGate(new AbortController().signal, Date.now() + 120);
    check('他早说完了，但她的话长：等打完才发', Date.now() - t1 >= 110, Date.now() - t1);
  }

  console.log('\n说出口不带英文 id（body.humanizeIds）');
  check('minecraft:iron_ingot → 铁锭', body.humanizeIds('拿了 minecraft:iron_ingot 3 个') === '拿了 铁锭 3 个', body.humanizeIds('拿了 minecraft:iron_ingot 3 个'));
  check('光秃秃的 oak_log 也换', body.humanizeIds('还有oak_log') === '还有橡木原木', body.humanizeIds('还有oak_log'));
  check('认不出的不猜、玩家名不动', body.humanizeIds('foo:bar_baz 给 Ka_sum1') === 'foo:bar_baz 给 Ka_sum1', body.humanizeIds('foo:bar_baz 给 Ka_sum1'));

  console.log('\n语气词别变口头禅（particleHint）');
  check('最近两条都带"呀" → 提醒', /"呀"/.test(particleHint(['好呀', '挖着', '在呀'])), particleHint(['好呀', '挖着', '在呀']));
  check('一半以上带语气词 → 提醒', particleHint(['好呀', '是嘛', '挖着', '哦']) !== '');
  check('偶尔一个 → 不管', particleHint(['好呀', '挖着', '来了', '在这', '嗯', '走吧']) === '');
  check('太少不判', particleHint(['好呀']) === '');

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

  {
    mem.episode('在海边捡到一只鹦鹉螺壳', ['minecraft:nautilus_shell']);
    mem.load().episodes[mem.load().episodes.length - 1].t = Date.now() - 3600000;
    W.topic = null;
    W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：海边捡的鹦鹉螺壳还在吗', cue: 'Ka_sum1 海边捡的鹦鹉螺壳还在吗', names: ['Ka_sum1'] });
    const a = buildNow('event');
    W.pending.push({ t: Date.now(), text: '✅ 做完了：goto{"x":1,"y":64,"z":2} → {"arrived":true}', cue: '{"x":1,"y":64,"z":2}', names: [] });
    const b = buildNow('event');
    check('别人交代的事，做下一步时还会顺着它想起来', /捡到一只鹦鹉螺壳/.test(a.text) && /捡到一只鹦鹉螺壳/.test(b.text), [a.text, b.text]);
    W.topic.t = Date.now() - CFG.topicMs - 1;
    W.pending.push({ t: Date.now(), text: '✅ 做完了：goto{"x":1,"y":64,"z":2} → {"arrived":true}', cue: '{"x":1,"y":64,"z":2}', names: [] });
    check('过了一阵就不再惦记', !/鹦鹉螺壳/.test(buildNow('event').text));
    W.topic = null;
  }

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

  console.log('\n问"X在哪"之前先自己看；说和做：先动再打字');
  {
    const order = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (!['/look', '/memory', '/stop'].includes(p)) order.push(p === '/chat' ? `chat:${(b.messages || [b.message]).join('/')}` : p); return mb.post(p, b); } });
    const script3 = [
      { content: '', tool_calls: [{ id: 'a1', function: { name: 'say', arguments: '{"text":"南瓜在哪"}' } }] },
      { content: '', tool_calls: [{ id: 'a2', function: { name: 'scan_blocks', arguments: '{"filter":"pumpkin"}' } }] },
      { content: '', tool_calls: [{ id: 'a3', function: { name: 'say', arguments: '{"text":"看到了 我去砍"}' } }, { id: 'a4', function: { name: 'come_to', arguments: '{"player":"Ka_sum1"}' } }] },
    ];
    body._setLLM(async () => script3.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = 0;
    emit('💬 Ka_sum1 说：去把南瓜砍了', { names: ['Ka_sum1'], urgent: true });
    for (let i = 0; i < 40 && (W.thinking || thinkTimerValue() || !order.some(x => x.startsWith('chat:'))); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    check('没看就问"南瓜在哪"：没发出去', !order.some(x => /南瓜在哪/.test(x)), order);
    check('提醒她先看', W.history.some(m => m.role === 'tool' && m.content.includes('还没自己看一眼')));
    const iChat = order.findIndex(x => x.startsWith('chat:看到了')); const iAct = order.findIndex(x => !x.startsWith('chat:') && !x.startsWith('/scan'));
    check('看过之后才说；动作先开始、话后发出', iChat >= 0 && iAct >= 0 && iAct < iChat, order);
    check('让她定：认得出"你規劃一下"', DELEGATES.test('先搞幾個鐵箱子出來用。你規劃一下儲藏室') && DELEGATES.test('你自己定吧') && !DELEGATES.test('我来规划'));
    check('反问认得出，决定不算反问', ASKS_BACK.test('储藏室放哪层好？') && !ASKS_BACK.test('好 放地下室'));
    body._setBridge(mockBridge());
  }
  {
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    const script4 = [
      { content: '', tool_calls: [{ id: 'd1', function: { name: 'say', arguments: '{"text":"储藏室放哪层好？"}' } }] },
      { content: '', tool_calls: [{ id: 'd2', function: { name: 'say', arguments: '{"text":"好 放地下室"}' } }] },
    ];
    body._setLLM(async () => script4.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = 0;
    emit('💬 Ka_sum1 说：你規劃一下儲藏室', { names: ['Ka_sum1'], urgent: true });
    for (let i = 0; i < 40 && (W.thinking || thinkTimerValue() || !said.length); i++) await new Promise(r => setTimeout(r, 100));
    check('他让她定：反问没发出去，改说决定', said.length === 1 && said[0] === '好/放地下室' || said.join('|') === '好 放地下室' || (said.length && !said.some(x => /哪层/.test(x)) && said.some(x => /地下室/.test(x))), said);
    body._setBridge(mockBridge());
  }

  // 说话出口的三道闸（2026-09-29）：跑的就是 think 里那份拦截，不在这里另抄一份实现
  console.log('\n少汇报：播报自己的动作，他最近没问就不发');
  {
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    // 他 5 分钟没说话（lastHeardAt 拨回去）—— 两句汇报都不该发出去
    const scriptQ = [
      { content: '', tool_calls: [{ id: 'q1', function: { name: 'say', arguments: '{"text":"箱子理好了"}' } }] },
      { content: '', tool_calls: [{ id: 'q2', function: { name: 'say', arguments: '{"text":"我去插火把"}' } }] },
      { content: '', tool_calls: [{ id: 'q3', function: { name: 'say', arguments: '{"text":"好"}' } }] },
    ];
    body._setLLM(async () => scriptQ.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000; W.lastAskedAt = 0; W.lastProactive = null;
    emit('✅ 身体：organize_storage 做完了', { names: [] });
    for (let i = 0; i < 40 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    check('"箱子理好了" 他没问 → 拦下（没发出去）', !said.some(x => /箱子理好了/.test(x)), said);
    check('"我去插火把" 也没发出去', !said.some(x => /插火把/.test(x)), said);
    check('拦下时给了提示（不是静默吞掉）', W.history.some(m => m.role === 'tool' && m.content.includes('播报你自己的动作')),
      W.history.filter(m => m.role === 'tool').map(m => m.content.slice(0, 60)));

    // 他刚问"你在干嘛" → 同一句话放行
    const said2 = []; const mb2 = mockBridge();
    body._setBridge({ get: mb2.get, post: async (p, b) => { if (p === '/chat') said2.push((b.messages || [b.message]).join('/')); return mb2.post(p, b); } });
    const scriptP = [
      { content: '', tool_calls: [{ id: 'p1', function: { name: 'say', arguments: '{"text":"在插火把"}' } }, { id: 'p2', function: { name: 'make_torches', arguments: '{}' } }] },
    ];
    body._setLLM(async () => scriptP.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastAskedAt = 0;
    emit('💬 Ka_sum1 说：你在干嘛', { names: ['Ka_sum1'], chat: true });
    for (let i = 0; i < 50 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    check('他刚问"你在干嘛" → 回答不受限，放行', said2.some(x => /在插火把/.test(x)), said2);
    body._setBridge(mockBridge());
  }

  console.log('\n少问：5 分钟内第二次问他 → 拦');
  {
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    const scriptA = [
      { content: '', tool_calls: [{ id: 'a1', function: { name: 'say', arguments: '{"text":"你要回去吗"}' } }] },
      { content: '', tool_calls: [{ id: 'a2', function: { name: 'say', arguments: '{"text":"要回去嗎"}' } }] },
    ];
    body._setLLM(async () => scriptA.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000;
    W.lastAskedAt = Date.now() - 60 * 1000; W.lastProactive = null;   // 一分钟前刚问过一次
    emit('✅ 身体：scan_blocks 做完了', { names: [] });
    for (let i = 0; i < 40 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    check('5 分钟内第二次提问 → 拦下', !said.some(x => /要回去嗎/.test(x)) && !said.some(x => /你要回去吗/.test(x)), said);
    check('给了"能自己决定的自己决定"的提示', W.history.some(m => m.role === 'tool' && /你刚问过他/.test(m.content)),
      W.history.filter(m => m.role === 'tool').map(m => m.content.slice(0, 60)));

    // 他刚问她问题 → 她回答（反问式的回答）放行
    const said2 = []; const mb2 = mockBridge();
    body._setBridge({ get: mb2.get, post: async (p, b) => { if (p === '/chat') said2.push((b.messages || [b.message]).join('/')); return mb2.post(p, b); } });
    const scriptB = [
      { content: '', tool_calls: [{ id: 'b1', function: { name: 'say', arguments: '{"text":"你不是刚挖过吗"}' } }] },
    ];
    body._setLLM(async () => scriptB.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null;
    W.lastAskedAt = Date.now() - 60 * 1000; W.lastProactive = null;
    emit('💬 Ka_sum1 说：我去挖矿了', { names: ['Ka_sum1'], chat: true });
    for (let i = 0; i < 50 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    check('他刚问她、她在回 → 不受限，放行', said2.length > 0, said2);
    body._setBridge(mockBridge());
  }

  console.log('\n回答他时别把问题反问回去（问题 A，2026-09-29 实机 19:10:16）');
  {
    // 实机那一轮的原样：他问"今天干嘛"，她答完夹一句"你想去哪呀"
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    const scriptR = [
      { content: '', tool_calls: [
        { id: 'r1', function: { name: 'say', arguments: '{"text":"先在家里插点火把"}' } },
        { id: 'r2', function: { name: 'say', arguments: '{"text":"你想去哪呀"}' } },
      ] },
    ];
    body._setLLM(async () => scriptR.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastAskedAt = 0; W.lastProactive = null;
    emit('💬 Ka_sum1 说：今天干嘛', { names: ['Ka_sum1'], chat: true });
    for (let i = 0; i < 50 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    check('★ 他刚开口、她回答 → 放行（"先在家里插点火把"发得出去）', said.some(x => /先在家里插点火把/.test(x)), said);
    check('★ 回答里夹的"你想去哪呀" → 拦下（没发出去）', !said.some(x => /你想去哪/.test(x)), said);
    check('拦下时给了提示（不是静默吞掉）', W.history.some(m => m.role === 'tool' && /别把问题丢回去/.test(m.content)),
      W.history.filter(m => m.role === 'tool').map(m => m.content.slice(0, 80)));

    // 他明确在问她的意见（"你觉得先挖矿还是先砍树"）→ 她反问澄清放行
    const said2 = []; const mb2 = mockBridge();
    body._setBridge({ get: mb2.get, post: async (p, b) => { if (p === '/chat') said2.push((b.messages || [b.message]).join('/')); return mb2.post(p, b); } });
    const scriptV = [
      { content: '', tool_calls: [{ id: 'v1', function: { name: 'say', arguments: '{"text":"你想要哪个多点？"}' } }] },
    ];
    body._setLLM(async () => scriptV.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastAskedAt = 0; W.lastProactive = null;
    emit('💬 Ka_sum1 说：你觉得先挖矿还是先砍树', { names: ['Ka_sum1'], chat: true });
    for (let i = 0; i < 50 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    check('★ 他问她的意见 → 她反问澄清放行', said2.some(x => /你想要哪个/.test(x)), said2);

    // 他刚开口、她只是回答"好呀" → 放行
    const said3 = []; const mb3 = mockBridge();
    body._setBridge({ get: mb3.get, post: async (p, b) => { if (p === '/chat') said3.push((b.messages || [b.message]).join('/')); return mb3.post(p, b); } });
    const scriptY = [
      { content: '', tool_calls: [{ id: 'y1', function: { name: 'say', arguments: '{"text":"好呀"}' } }] },
    ];
    body._setLLM(async () => scriptY.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastAskedAt = 0; W.lastProactive = null;
    emit('💬 Ka_sum1 说：今天干嘛', { names: ['Ka_sum1'], chat: true });
    for (let i = 0; i < 50 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    check('★ 只是回答"好呀" → 放行', said3.some(x => /好呀/.test(x)), said3);
    // 判据本身也测一遍（跑的是导出的那份 speech.asksBack，不手抄）
    check('判据：他问"今天干嘛"、她说"你想去哪呀" → 是反问决定', speech.asksBack('你想去哪呀', '今天干嘛') === true);
    check('判据：他问她的意见、"你想要哪个多点？" → 不是', speech.asksBack('你想要哪个多点？', '你觉得先挖矿还是先砍树') === false);
    check('判据：只有他知道的事（"你想要什么"）→ 不是', speech.asksBack('你想要什么', '你去挖矿吧') === false);
    check('判据：她自己的邀请（"带上我嘛"）→ 不是', speech.asksBack('带上我嘛', '今天干嘛') === false);
    body._setBridge(mockBridge());
  }

  console.log('\n不说没发生的事：完成式要有工具结果撑着');
  {
    // 睡觉失败（工具已经报了 ✗ 现在不是晚上）→ 拦，提示里带上工具的原因。
    // 实机路径：sleep_in_bed 是"身体动作"，快照是 few 秒后才回来的 —— 那一刻（03:51:27 ✗）
    // 她在下一轮（03:52:08）才说"我睡了呀 剛起床"。所以这里按实机的样子：失败先进 now.ev。
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    const scriptS = [
      { content: '', tool_calls: [{ id: 's1', function: { name: 'say', arguments: '{"text":"我睡了呀 剛起床"}' } }] },
      { content: '', tool_calls: [{ id: 's2', function: { name: 'say', arguments: '{"text":"我刚睡醒"}' } }] },
      { content: '', tool_calls: [{ id: 's3', function: { name: 'wait', arguments: '{}' } }] },
    ];
    body._setLLM(async () => scriptS.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000; W.lastAskedAt = 0; W.lastProactive = null;
    W.state = { connected: true, health: 18, food: 15, isDay: false, pos: { x: 23, y: 128, z: 9 }, items: [], nearby: [], players: [] };
    // 身体刚回报的那一行（实机日志原样）：sleep_in_bed ✗ 现在不是晚上
    W.pending.push({ t: Date.now(), text: '❌ sleep_in_bed() 没做成：睡不了：black_bed(23,128,9)：现在不是晚上，睡不了', cue: 'sleep', names: [] });
    await think('event');
    const hist = W.history.map(m => m.content || '');   // 下面那个测试块会清空 history，先自己留一份
    check('sleep_in_bed ✗ 还说"我睡了" → 拦下', !said.some(x => /我睡了/.test(x)), said);
    check('提示里带着工具的失败原因', hist.some(c => /现在不是晚上/.test(c)),
      hist.filter(c => /现在不是晚上|睡/.test(c)).map(c => c.slice(0, 140)));

    // 睡觉成功 → 放行（判据端测，见下：unbackedClaim('我睡了呀', okSleep) === null）
    body._setBridge(mockBridge());
  }
  // 判据本身也测一遍（跑的是导出的那份 unbackedClaim，不手抄）
  {
    const okSleep = [{ tool: 'sleep_in_bed', out: { ok: true } }];
    const badSleep = [{ tool: 'sleep_in_bed', out: { ok: false, error: '睡不了：现在不是晚上，睡不了' } }];
    check('sleep ✓ → "我睡了"不算说谎', unbackedClaim('我睡了呀', okSleep) === null);
    const why = unbackedClaim('我睡了呀 剛起床', badSleep);
    check('sleep ✗ → 拦，并说明原因', !!why && /现在不是晚上/.test(why), why);
    check('身体刚回报失败也算证据', !!unbackedClaim('我睡了', [], liveFails([{ text: '03:51:27.503    ↳ sleep_in_bed() ✗ 睡不了：black_bed(23,128,9)：现在不是晚上，睡不了' }])) , 'live');
    check('工具没记录 → 不冤枉她（不拦）', unbackedClaim('我睡了呀', []) === null);
    check('★ 打架时他喊"快过来" → 走路工具自动带玩家标记（不靠 LLM 填 fromPlayer）', PLAYER_MOVE_RE.test('快过来') && PLAYER_MOVE_RE.test('跟我走') && PLAYER_MOVE_RE.test('别打了 回来') && PLAYER_MOVE_TOOLS.has('come_to'));
    check('闲聊不带标记：「好累」「哈哈」', !PLAYER_MOVE_RE.test('好累') && !PLAYER_MOVE_RE.test('哈哈'));
    { const t = Date.now(); const T = (x) => x;
      // 任务队列阶段 3 起看任务状态（设计第九节）：taskEnded = 最近收尾的那件主人交代的事（tasks.lastEndedPlayer）
      check('★ 他交代的那件 2 分钟前做完了、"箱子理好了" → 放行（回他，不是播报）', taskDoneAllowed('箱子理好了', { now: t, taskEnded: { at: t - 120000 } }) === true);
      check('同一次收尾报过了、再说"好了" → 不放行', taskDoneAllowed('好了', { now: t, taskEnded: { at: t - 120000 }, lastTaskDoneSaidAt: t - 60000 }) === false);
      check('★ 他交代的没有一件收尾（没交代过 / 还在做）→ 不放行', taskDoneAllowed('箱子理好了', { now: t, taskEnded: null }) === false);
      check('收尾是 20 分钟前 → 不放行', taskDoneAllowed('箱子理好了', { now: t, taskEnded: { at: t - 1200000 } }) === false);
      check('"我去插火把"不是完成 → 不放行', taskDoneAllowed('我去插火把', { now: t, taskEnded: { at: t - 60000 } }) === false);
      check('做不成（那件 failed / dropped）也要说一声', taskDoneAllowed('做不了 缺铁', { now: t, taskEnded: { at: t - 60000 } }) === true);
      check('交代的话认得出：「帮我把箱子理一下」「去砍点木头」「做个铁镐」', ['帮我把箱子理一下', '去砍点木头', '做个铁镐'].every(x => TASK_ASK_RE.test(x)));
      check('闲聊不算交代：「好累」「哈哈哈」「你在干嘛」', !['好累', '哈哈哈', '你在干嘛'].some(x => TASK_ASK_RE.test(x))); T(0); }
    // 2026-09-29 Claude 复核补：实机那句是**下一轮**、而且是在**回他的话**
    check('★ 上一轮 sleep ✗（跨轮记录里）→ 这轮"我睡了"照样拦', !!unbackedClaim('我睡了呀 剛起床', [], [{ tool: 'sleep_in_bed', failed: true, why: '现在不是晚上，睡不了', t: Date.now() - 41000 }]));
    check('放东西：store ✗ 就拦', !!unbackedClaim('东西放进去了', [{ tool: 'store_items', out: { ok: false, error: 'invalid operation' } }]));
    check('做到一半（只有开始）不算完成', unbackedClaim('我做完了', [{ tool: 'craft', out: { ok: true, note: '身体开始做了，做完会告诉你' } }]) === null);
    check('发现 / 危险 不碰（它们不是完成式）', unbackedClaim('看见一个没开过的箱子', []) === null && unbackedClaim('有怪！', []) === null);
  }

  console.log('\n火把开关：唯一的放行反问（"要插火把吗"）—— 判据');
  {
    const t = Date.now();
    // ★ 放行：带标记 + 本体就是"要插火把吗"
    check('★ 带 askPlayer:torch、说"家里挺暗的，要插火把吗" → 放行',
      torchAskAllowed('家里挺暗的，要插火把吗？', 'torch', { now: t }) === true);
    check('★ 换种问法也对得上（"要不要我插点火把"）',
      torchAskAllowed('要不要我插点火把', 'torch', { now: t }) === true);
    check('"需要点灯吗"也算（"点灯"和"插火把"是同一件事）',
      torchAskAllowed('这里需要点灯吗', 'torch', { now: t }) === true);
    // ① 没标记 → 不放行（普通问句照拦，不做成"所有问句都放行"）
    check('★ 同一个问句、没带标记 → 不放行（普通反问照拦）',
      torchAskAllowed('家里挺暗的，要插火把吗？', null, { now: t }) === false);
    check('★ 带别的标记 → 不放行', torchAskAllowed('要插火把吗', 'other', { now: t }) === false);
    // ② 带了标记、但说的不是这件事 → 不放行（防止"填个标记混别的问句过去"）
    check('★ 带标记却问别的（"你想去哪呀"）→ 不放行（错填标记不讨好）',
      torchAskAllowed('你想去哪呀', 'torch', { now: t }) === false);
    check('★ 带标记却问别的（"储藏室放哪层好"）→ 不放行',
      torchAskAllowed('储藏室放哪层好？', 'torch', { now: t }) === false);
    check('★ 带标记、只说"要插"没有火把（"你要不要"）→ 不放行',
      torchAskAllowed('你要不要', 'torch', { now: t }) === false);
    // ③ 同一个问题的冷却：说过一次就不再放行（放行 ≠ 可以追着问）
    check('★ 刚说过一次（1 分钟内）→ 不放行（同一问题冷却）',
      torchAskAllowed('要插火把吗', 'torch', { now: t, lastTorchAskSaidAt: t - 60000 }) === false);
    check('★ 过了冷却（6 分钟前说过）→ 又能放行',
      torchAskAllowed('要插火把吗', 'torch', { now: t, lastTorchAskSaidAt: t - 6 * 60 * 1000 }) === true);
    check('判据常量：火把问题冷却 = 常规问他冷却', TORCH_ASK_COOLDOWN_MS === ASK_COOLDOWN_MS);
  }

  console.log('\n火把开关：整轮跑一遍（放行 / 冷却 / 别的不放行）');
  {
    const mb = mockBridge();
    const said = [];
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    // 三条脚本：① 放行 ② 同一问题（该被冷却拦）③ 别的反问（该被反问闸拦）
    const scriptT = [
      { content: '', tool_calls: [{ id: 't1', function: { name: 'say', arguments: '{"text":"家里挺暗的，要插火把吗","askPlayer":"torch"}' } }] },
      { content: '', tool_calls: [{ id: 't2', function: { name: 'say', arguments: '{"text":"要插火把吗","askPlayer":"torch"}' } }] },
      { content: '', tool_calls: [{ id: 't3', function: { name: 'say', arguments: '{"text":"储藏室放哪层好？"}' } }] },
      { content: '', tool_calls: [{ id: 't4', function: { name: 'wait', arguments: '{}' } }] },
    ];
    body._setLLM(async () => scriptT.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null;
    W.lastHeardAt = Date.now() - 5 * 60 * 1000; W.lastAskedAt = 0; W.lastProactive = null; W.lastTorchAskSaidAt = 0;
    W.state = { connected: true, health: 18, food: 15, isDay: true, pos: { x: 23, y: 64, z: 9 }, items: [], nearby: [], players: [] };
    W.pending.push({ t: Date.now(), text: '🕯 本能：家里有 3 格地面是全黑的（比如 21,64,8 / 22,64,9 / 23,64,9），夜里会刷怪', cue: 'torch_ask', names: [] });
    await think('event');
    check('★ 本能请她问的火把 → 说出去了（放行）', said.some(x => /要插火把吗/.test(x)), said);
    check('★ 同一问题第二次（冷却内）→ 拦下（放行不等于追着问）',
      said.filter(x => /要插火把吗/.test(x)).length, 1);
    check('★ 别的反问（"储藏室放哪层好？"）→ 照旧拦（不放行）', !said.some(x => /储藏室放哪层/.test(x)), said);
    check('★ 真问出去时才记时刻（W.lastTorchAskSaidAt 被更新）', W.lastTorchAskSaidAt > 0);
    body._setBridge(mockBridge());
  }

  console.log('\n发现 / 危险 / 感受 不算汇报，不拦');
  {
    const said = []; const mb = mockBridge();
    body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
    const scriptO = [
      { content: '', tool_calls: [{ id: 'o1', function: { name: 'say', arguments: '{"text":"看见一个没开过的箱子"}' } }] },
      { content: '', tool_calls: [{ id: 'o2', function: { name: 'say', arguments: '{"text":"有怪！"}' } }] },
    ];
    body._setLLM(async () => scriptO.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000; W.lastAskedAt = 0; W.lastProactive = null;
    emit('✅ 身体：scan_blocks 做完了', { names: [] });
    for (let i = 0; i < 40 && (W.thinking || thinkTimerValue()); i++) await new Promise(r => setTimeout(r, 100));
    check('"看见一个没开过的箱子" 放行', said.some(x => /没开过的箱子/.test(x)), said);
    check('"有怪！" 放行', said.some(x => /有怪/.test(x)), said);
    body._setBridge(mockBridge());
  }

  console.log('\n亲手做成的事自动记成经验');
  learnFromDoing('smelt', { itemName: 'egg' }, { smelted: 'minecraft:egg', in: 'smoker', got: { 'farmersdelight:fried_egg': 3 } });
  const rel = mem.load().memories.find(m => m.kind === 'relation' && m.o === 'farmersdelight:fried_egg');
  check('烤成功 → 记下"鸡蛋在烟熏炉里烤成煎蛋"（亲身经历）', rel && rel.source === 'experience', rel);

  console.log('\n状态快照不在意识流里重复');
  {
    body._setLLM(async () => ({ content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] }));
    W.history = []; W.lastNow = null; W.pending = [];
    W.state.items = [{ name: 'egg', count: 7 }];
    W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：第一句', cue: 'Ka_sum1', names: ['Ka_sum1'] });
    await think('event');
    W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：第二句', cue: 'Ka_sum1', names: ['Ka_sum1'] });
    await think('event');
    const us = W.history.filter(m => m.role === 'user');
    check('只有最新一刻带普通物品栏等状态', us.filter(m => /普通物品栏/.test(m.content)).length === 1 && /普通物品栏/.test(us[us.length - 1].content), us.map(m => m.content.slice(0, 40)));
    check('旧的一刻还留着发生了什么', /第一句/.test(us[0].content) && /【此刻/.test(us[0].content), us[0].content);
    check('旧的一刻去掉了想起来的记忆', !/给我鸡蛋的好人/.test(us[0].content), us[0].content);
  }
  {
    let calls = 0;
    body._setLLM(async () => { calls++; await new Promise(r => setTimeout(r, 50)); return { content: '日记', tool_calls: [] }; });
    const p1 = sleepAndSort(); const p2 = sleepAndSort();
    W.pending.push({ t: Date.now(), text: '💬 Ka_sum1 说：在吗', cue: 'Ka_sum1', names: ['Ka_sum1'] });
    await think('event');
    await Promise.all([p1, p2]);
    check('睡着时不会再睡一次，也不会插进来想', calls === 1 && !W.sleeping, calls);
    clearThinkTimer();
    W.pending = [];
  }

  console.log('\n眼下最该操心的（生存优先级）');
  {
    const night = survivalFocus({ pos: { x: 99999, y: 64, z: 99999 }, health: 20, isDay: false, items: [], nearby: [] });
    check('没家时先安家（提到新手小屋）', night.some(x => /新手小屋/.test(x)), night);
    const hurt = survivalFocus({ pos: { x: 99999, y: 64, z: 99999 }, health: 5, isDay: true, items: [], nearby: [{ kind: 'hostile', distance: 4 }] });
    check('血少有怪：保命排第一', /保命/.test(hurt[0] || ''), hurt);
    const full = survivalFocus({ pos: { x: 99999, y: 64, z: 99999 }, health: 20, isDay: true, items: Array.from({ length: 30 }, (_, i) => ({ name: `x:${i}`, count: 1 })), nearby: [], curios: ['sophisticatedbackpacks:iron_backpack'] });
    check('身上快满、背着背包：先装背包', full.some(x => /装进背包/.test(x)), full);
    const logs = survivalFocus({ pos: { x: 99999, y: 64, z: 99999 }, health: 20, isDay: true, items: [], nearby: [{ isDrop: true, distance: 3, item: { name: 'oak_log', count: 3 } }] });
    W.sleepFail = { t: Date.now(), why: '附近有怪，睡不了' };
    const home0 = mem.getHome; mem.getHome = () => ({ center: { x: 0, y: 64, z: 0 }, radius: 24 }); const inH = mem.inHome; mem.inHome = () => true;
    const nightHome = survivalFocus({ pos: { x: 0, y: 64, z: 0 }, health: 20, isDay: false, items: [], nearby: [] });
    mem.getHome = home0; mem.inHome = inH; W.sleepFail = null;
    check('刚睡失败过：别反复上床', nightHome.some(x => /别反复上床/.test(x)), nightHome);
    check('地上有掉落物：提醒捡', logs.some(x => /掉落物/.test(x) && /pickup/.test(x)), logs);
    // 天黑：野外 / 矿洞分开；排在前两条里
    mem.getHome = () => ({ center: { x: 0, y: 64, z: 0 }, radius: 24 }); mem.inHome = () => false;
    const out = survivalFocus({ pos: { x: 40, y: 64, z: 0 }, health: 20, phase: 'night', exposure: 'open', items: [], nearby: [{ isDrop: true, distance: 3, item: { name: 'oak_log', count: 3 } }] });
    const cave = survivalFocus({ pos: { x: 40, y: 12, z: 0 }, health: 20, phase: 'night', exposure: 'underground', items: [], nearby: [] });
    const dusk = survivalFocus({ pos: { x: 40, y: 64, z: 0 }, health: 20, phase: 'dusk', exposure: 'open', items: [], nearby: [] });
    mem.getHome = home0; mem.inHome = inH;
    check('★ 夜里在野外、家不远：回家排在前面', /go_home/.test(out[0] || ''), out);
    check('★ 夜里在矿洞：接着挖，不叫回家', cave.some(x => /接着挖/.test(x)) && !cave.some(x => /go_home/.test(x)), cave);
    check('★ 黄昏：提前收尾往家走', dusk.some(x => /收个尾/.test(x)), dusk);
  }

  console.log('\n他说了话、她只在正文里回：提醒一次（不替她说）');
  {
    const seen = [];
    body._setLLM(async ({ messages }) => { seen.push(messages[messages.length - 1].content); return { content: '嗯⏎明天来吗', tool_calls: [] }; });
    W.history = []; W.lastNow = null;
    W.pending = [{ t: Date.now(), text: '💬 Ka_sum1 说：我下线了', cue: 'Ka_sum1', names: ['Ka_sum1'] }];
    await think('event');
    check('提醒了一次，只提醒一次', seen.filter(x => x === SAY_NUDGE).length === 1 && seen.length === 2, seen.length);
    clearThinkTimer();
    W.pending = [];
  }

  console.log('\n整理记忆时 thinking 一直挂着（新的一刻插不进来抢 history）');
  {
    // 这条钉住的是 think 的 finally 里那个顺序：整理必须在放下 W.thinking **之前**做。
    // 原来两者之间靠"恰好没有 await"保持互斥 —— 隐式的，改坏了不会有任何报错。
    const prevMax = CFG.maxHistoryChars;
    CFG.maxHistoryChars = 0;                       // 强制"上下文满了"→ think 会在 finally 里整理
    let calls = 0; let atSort = null; let callsAfterReentry = null;
    body._setLLM(async () => {
      calls++;
      if (calls === 2) {                           // 第 2 次 = sortMemories 的那次调用
        atSort = { thinking: W.thinking, sleeping: W.sleeping };
        await think('event');                      // 新的一刻想插进来
        callsAfterReentry = calls;
      }
      return { content: '日记', tool_calls: [] };
    });
    W.history = []; W.lastNow = null;
    // 事件用"没人说话"的：有人说话、模拟模型又只回正文时，会先触发"提醒她说出来"那一轮，第 2 次调用就不是整理了
    W.pending = [{ t: Date.now(), text: '🌙 天黑了', cue: '天黑', names: [] }];
    await think('event');
    check('整理期间 thinking 还挂着', atSort?.thinking === true, atSort);
    check('整理期间 sleeping 也挂着', atSort?.sleeping === true, atSort);
    check('插进来的那次没真的调模型（被挡在外面）', callsAfterReentry === 2, callsAfterReentry);
    check('整理完才放下 thinking', W.thinking === false, W.thinking);
    check('整理完 sleeping 也归位', W.sleeping === false, W.sleeping);
    CFG.maxHistoryChars = prevMax;
    clearThinkTimer();
    W.pending = [];
  }

  console.log('\n出错时不留下半截消息');
  {
    const h = repairHistory([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a', content: '1' },
      { role: 'user', content: 'y' },
      { role: 'tool', tool_call_id: 'zz', content: '孤立' },
    ]);
    check('被打断的一轮：缺的结果补上、顺序对', h.map(m => m.role + (m.tool_call_id || '')).join(',') === 'user,assistant,toola,toolb,user');
    check('孤立的工具结果去掉', !h.some(m => m.tool_call_id === 'zz'));
  }
  W.history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }];
  W.pending = [{ t: 1 }];
  trimDangling();
  check('去掉没有结果的 tool_calls', !W.history.some(m => m.tool_calls));

  console.log('\n线路坏了别死循环（403 / 502 退避、压缩、停 5 分钟）');
  {
    const realBodyLlm = body.llm;
    const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);
    const runThink = async (failKind, times = 1) => {
      let n = 0;
      body._setLLM(async () => {
        n++;
        if (n <= times) {
          if (failKind === 'content') throw err('模型报错 403：content_policy_violation', { retryable: false, kind: 'content', status: 403 });
          throw err('模型报错 502：上游挂了', { retryable: true, kind: 'transient', status: 502 });
        }
        return { content: '好了', tool_calls: [] };
      });
      return n;
    };
    const reset = () => { W.history = []; W.pending = []; W.job = null; W.lastNow = null; W.failStreak = 0; W.auditStreak = 0; W.failUntil = 0; W.blockedFrom = 0; };
    const evt = () => ({ t: Date.now(), text: 'Ka_sum1 说：安琪', names: ['Ka_sum1'] });
    const realSetTimeout = global.setTimeout;

    // 一、可重试的错：退避 2s、4s、8s …（不是以前固定 3 秒，也不是 1 秒一次）
    reset();
    const seen = [];
    global.setTimeout = (fn, ms) => { if (ms >= 2000 && ms <= 60000) seen.push(ms); return realSetTimeout(fn, ms); };
    try {
      await runThink('transient', 3);
      for (let i = 0; i < 3; i++) { W.pending = [evt()]; await think('event'); }
    } finally { global.setTimeout = realSetTimeout; }
    check('第一轮失败 → 2 秒后再想', seen[0] === 2000, seen.slice(0, 5));
    check('第二轮失败 → 4 秒（指数退避，不是固定值）', seen[1] === 4000, seen.slice(0, 5));
    check('第三轮失败 → 8 秒', seen[2] === 8000, seen.slice(0, 5));
    check('连着失败计数在涨', W.failStreak >= 2, W.failStreak);

    // 二、成功一次就把退避清零
    reset();
    W.pending = [evt()];
    await runThink('transient', 1); await think('event');
    check('失败一次后记着', W.failStreak === 1, W.failStreak);
    W.pending = [evt()];
    await runThink('transient', 0); await think('event');
    check('成功一次 → 退避计数清零（下次再坏还是从 2 秒起）', W.failStreak === 0, W.failStreak);

    // 三、403 内容审计：连着 2 次就把"上次成功之后新进意识流的内容"压成一行再重试
    reset();
    // 模拟"上一次成功时意识流里有这两条"（blokedFrom 记在成功那一刻）
    W.history = [{ role: 'user', content: '早上他给我鸡蛋' }, { role: 'assistant', content: '收下了' }];
    W.blockedFrom = W.history.length;
    let peak = 0;
    body._setLLM(async () => { peak = Math.max(peak, W.history.length + 1); throw err('模型报错 403：content_policy_violation', { retryable: false, kind: 'content', status: 403 }); });
    W.pending = [evt()];
    await think('event');
    check('第一次 403：不掐内容，先原样再试一次', W.history.some(m => /早上他给我鸡蛋/.test(m.content)) && W.auditStreak === 1, W.auditStreak);
    W.pending = [evt()];
    await think('event');
    check('第二次 403：新进的那段被压成一行"发不出去，已略过"', W.history.some(m => /有一段内容发不出去，已略过/.test(m.content)), W.history.map(m => String(m.content).slice(0, 24)));
    check('压缩后只留"上次成功前"的 + 那一行', W.history.length === 3 && W.history[0].content === '早上他给我鸡蛋', W.history.map(m => String(m.content).slice(0, 16)));
    check('确实掐掉了这一轮新进的（压缩前更长）', peak > 3, peak);
    check('最早的经历不会被连累丢掉', W.history.some(m => /早上他给我鸡蛋/.test(m.content)));

    // ---- ★ R-fix4-2：第一次 403 不能从 0 开始掐（那会删掉启动日记和全部历史）
    reset();
    // 模拟"她已经有一段很长的既有历史（启动日记 + 之前多轮）"，blockedFrom 还是初始 0
    W.history = [
      { role: 'user', content: '【启动】她醒了，记下了今天的打算' },
      { role: 'assistant', content: '早上好' },
      { role: 'user', content: '昨天我们一起种了小麦' },
      { role: 'assistant', content: '记得，长势不错' },
    ];
    W.blockedFrom = 0;   // ← 关键：初始值 0（正是出问题的状态）
    let h0len = 0;
    body._setLLM(async () => { h0len = W.history.length; throw err('模型报错 403：content_policy_violation', { retryable: false, kind: 'content', status: 403 }); });
    W.pending = [evt()];
    await think('event');
    check('★ 第一轮就是 403：既有历史（启动日记）**不能**被删光',
      W.history.some(m => /启动.*她醒了/.test(String(m.content))) && W.history.some(m => /昨天我们一起种了小麦/.test(String(m.content))),
      W.history.map(m => String(m.content).slice(0, 18)));
    W.pending = [evt()];
    await think('event');
    check('★ 第二次 403 压缩后，既有历史仍然在（只掐这一轮新进的）',
      W.history.some(m => /启动.*她醒了/.test(String(m.content))) && W.history.some(m => /有一段内容发不出去，已略过/.test(String(m.content))),
      W.history.map(m => String(m.content).slice(0, 18)));
    check('★ 压缩不会把历史清成 0（至少留既有那几条 + 一行略过）', W.history.length >= 5, W.history.length);

    // ---- ★ R-fix4-3：非 content 错误要打断"连续 403"计数（403 → 502 → 403 不该压缩）
    reset();
    W.history = [{ role: 'user', content: '既有' }];
    W.blockedFrom = 1; W.auditStreak = 0;
    body._setLLM(async () => { throw err('模型报错 403：content_policy_violation', { retryable: false, kind: 'content', status: 403 }); });
    W.pending = [evt()]; await think('event');
    check('第一次 403 → auditStreak=1', W.auditStreak === 1, W.auditStreak);
    body._setLLM(async () => { throw err('模型报错 502：上游挂了', { retryable: true, kind: 'transient', status: 502 }); });
    W.pending = [evt()]; await think('event');
    check('★ 中间夹一次 502 → auditStreak 清零（不再算连续 403）', W.auditStreak === 0, W.auditStreak);
    body._setLLM(async () => { throw err('模型报错 403：content_policy_violation', { retryable: false, kind: 'content', status: 403 }); });
    W.pending = [evt()]; await think('event');
    check('★ 再来一次 403 只是第 1 次，**不压缩**（以前会当成连续第 2 次误压）',
      W.auditStreak === 1 && !W.history.some(m => /有一段内容发不出去，已略过/.test(String(m.content))),
      { streak: W.auditStreak, hist: W.history.map(m => String(m.content).slice(0, 14)) });

    // 四、不可重试：400 请求格式错不安排重试，别空转
    reset();
    W.pending = [evt()];
    body._setLLM(async () => { throw err('模型报错 400：请求格式错', { retryable: false, kind: 'request', status: 400 }); });
    await think('event');
    check('不可重试的错（400）：不安排重试（pending 不为空、等着下次想起来）', W.pending.length > 0, W.pending.length);

    // 五、连着失败 5 次 → 停 5 分钟，并留一句她自己的话（不透技术细节）
    reset();
    W.failStreak = 4;   // 这一次就是第 5 次
    W.pending = [evt()];
    const oldPost = bridge.post;
    const captured = [];
    bridge.post = async (p, b) => { captured.push([p, b]); return { ok: true }; };
    body._setLLM(async () => { throw err('模型报错 502：上游挂了', { retryable: true, kind: 'transient', status: 502 }); });
    try { await think('event'); } finally { bridge.post = oldPost; }
    check('连着失败 5 次 → 歇 5 分钟（failUntil 设上了）', W.failUntil > Date.now() + 4.5 * 60 * 1000, Math.round((W.failUntil - Date.now()) / 1000));
    check('歇着的时候 think 直接返回，不空转', await (async () => { const h = W.history.length; const n0 = W.stats.errors; W.pending = [evt()]; await think('event'); return W.history.length === h && W.stats.errors === n0; })());
    check('歇着的时候他喊她：scheduleThink 会排到歇完那一刻', (() => { const ok = thinkTimerAtValue() > Date.now() + 4.5 * 60 * 1000; return ok; })());
    // 叫醒：清掉歇息，下一次想能正常走
    W.failUntil = 0; W.failStreak = 0;
    clearThinkTimer();
    body._setLLM(async () => ({ content: '好了', tool_calls: [] }));
    W.pending = [evt()];
    await think('event');
    check('歇完了他再喊：正常答应（不是一直哑着）', W.failUntil === 0 && W.failStreak === 0);

    body._setLLM(realBodyLlm);
    body._setBridge(mockBridge());
  }

  console.log('\n不和战斗本能抢怪（N-3）');
  {
    const savedState = W.state;
    const savedHook = body.hooks.beforeAttack;
    // 一只骷髅在身边，战斗本能在打它
    const withSkeleton = () => ({
      connected: true, health: 18, food: 15, isDay: false, pos: { x: 0, y: 64, z: 0 },
      items: [], players: [], nearby: [
        { name: 'minecraft:skeleton', kind: 'hostile', distance: 3, type: 'hostile' },
        { name: 'Ka_sum1', kind: 'player', distance: 5, type: 'player' },
      ],
      instinct: { combatNow: { since: Date.now() - 5000, engaged: 1, killed: 2 }, urgent: 'combat', running: 'combat' },
    });

    W.state = withSkeleton();
    const ci = combatInstinct(W.state);
    check('读出战斗本能正在打', !!ci && ci.killed === 2, ci);
    check('知道打的是骷髅（从身边的怪里挑）', /骷髅/.test(ci.name), ci.name);
    const nowText = buildNow('event').text;
    check('【此刻】写明"身体正在自己打…（战斗本能），不用你动手"', /身体正在自己打.*（战斗本能），不用你动手/.test(nowText), nowText.match(/身体正在自己打[^\n]*/)?.[0]);
    check('【此刻】写明"要逃就说逃"', /要逃就说逃/.test(nowText));
    check('说了已经打死几只', /已经打死 2 只/.test(nowText), nowText.match(/身体正在自己打[^\n]*/)?.[0]);

    // 没在打：不该出现这句
    W.state = { ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null } };
    check('本能没在打：不出现这句（免得她以为被挡）', !/身体正在自己打/.test(buildNow('event').text));
    check('combatInstinct 没有战斗时返回 null', combatInstinct(W.state) === null);

    // attack 工具：本能在打 → 直接回话，不发 HTTP
    body.hooks.beforeAttack = () => attackGuardReason(W.state);
    W.state = withSkeleton();
    const posted = [];
    const oldBridge = body.bridge;
    body._setBridge({ get: async () => ({ success: true }), post: async (p, b) => { posted.push([p, b]); return { success: true }; } });
    const blocked = await body.TOOLS.attack.run({ target: 'skeleton', radius: 6 });
    check('本能在打时调 attack：返回"本能在打…不用插手"', /本能在打/.test(blocked.error || '') && /不用插手/.test(blocked.error || ''), blocked);
    check('这一下没有发 HTTP 到 /attack', !posted.some(([p]) => p === '/attack'), posted);
    check('如实标成没打成（不是假装成功）', blocked.ok === false && blocked.guarded === true, blocked);

    // 本能没在打：照常发 HTTP
    W.state = { ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null, readAt: Date.now() } };
    posted.length = 0;
    await body.TOOLS.attack.run({ target: 'zombie', radius: 6 });
    check('本能没在打：attack 照常发出去', posted.some(([p]) => p === '/attack'), posted);

    // ---- ★ R-fix4-7：状态未知/过期时，身边有怪要保守拦下
    W.state = { ...withSkeleton(), instinct: null };
    check('★ /instinct 读不到（null）→ 判成"未知"', combatGuard(W.state).unknown === true, combatGuard(W.state));
    check('★ 未知 + 身边有怪 → 保守拦下 attack', /先别挥/.test(attackGuardReason(W.state)), attackGuardReason(W.state));
    W.state = { ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null, readAt: Date.now() - 60000 } };
    check('★ 状态过期（60s 前读的）→ 也算未知', combatGuard(W.state).stale === true, combatGuard(W.state));
    W.state = { ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null, readAt: Date.now() } };
    check('状态新鲜 → 不拦', !combatGuard(W.state).unknown, combatGuard(W.state));
    check('状态新鲜 + 没在打 + 身边有怪 → 不拦（轮询结果可信，交给她决定）',
      attackGuardReason({ ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null, readAt: Date.now() } }) === '',
      attackGuardReason({ ...withSkeleton(), instinct: { combatNow: null, urgent: null, running: null, readAt: Date.now() } }));
    W.state = { ...withSkeleton(), nearby: [], instinct: null };
    check('状态未知但身边没怪 → 不拦（没有战斗迹象，别误伤）', attackGuardReason(W.state) === '', attackGuardReason(W.state));

    body._setBridge(mockBridge());

    body.hooks.beforeAttack = savedHook;
    W.state = savedState;
  }

  console.log('\n用量记账（这一轮发了多少字符 / 缓存命中）');
  {
    const realFetch = global.fetch;
    const realCfg = { baseUrl: body.CFG.baseUrl, apiKey: body.CFG.apiKey, model: body.CFG.model };
    const before = { calls: body.usage.calls, inChars: body.usage.inChars, cachedTok: body.usage.cachedTok, cachedKnown: body.usage.cachedKnown };
    const reply = (bodyObj) => ({ ok: true, status: 200, text: async () => JSON.stringify(bodyObj) });
    body.CFG.baseUrl = 'http://fake'; body.CFG.apiKey = 'k'; body.CFG.model = 'm';
    let sent = null;

    // 一、有 cached_tokens（顶层）时累加
    global.fetch = async (url, opt) => { sent = JSON.parse(opt.body); return reply({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 80 } }); };
    const msgs = [{ role: 'system', content: 'S'.repeat(500) }, { role: 'user', content: '你好' }];
    await body._callLLM({ model: 'm', messages: msgs, tools: [], timeoutMs: 5000 });
    check('按字符记账：这一轮发的字符数记下了', body.usage.inChars - before.inChars === JSON.stringify(msgs).length, body.usage.inChars - before.inChars);
    check('命中缓存：cached_tokens 累加', body.usage.cachedTok - before.cachedTok === 80, body.usage.cachedTok - before.cachedTok);
    check('知道这次是有缓存数字的', body.usage.cachedKnown > before.cachedKnown);

    // 二、prompt_tokens_details.cached_tokens（另一种写法）也认
    const b2 = body.usage.cachedTok;
    global.fetch = async () => reply({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } } });
    await body._callLLM({ model: 'm', messages: msgs, tools: [], timeoutMs: 5000 });
    check('两种缓存写法都认（prompt_tokens_details.cached_tokens）', body.usage.cachedTok - b2 === 64, body.usage.cachedTok - b2);

    // 三、没有缓存字段：不瞎猜，记 0
    const b3 = { tok: body.usage.cachedTok, known: body.usage.cachedKnown };
    global.fetch = async () => reply({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    await body._callLLM({ model: 'm', messages: msgs, tools: [], timeoutMs: 5000 });
    check('没有缓存字段：不瞎猜成命中，cachedTok 不动、cachedKnown 不涨', body.usage.cachedTok === b3.tok && body.usage.cachedKnown === b3.known, [body.usage.cachedTok, body.usage.cachedKnown]);
    check('但字符数照样记（缓存有没有不影响她发了多少）', body.usage.inChars - before.inChars === 3 * JSON.stringify(msgs).length, body.usage.inChars - before.inChars);

    global.fetch = realFetch;
    Object.assign(body.CFG, realCfg);
  }

  console.log('\n工具按场景分组（一个都不丢，随场景带出来）');
  {
    const allNames = Object.keys(ALL);
    const coreNames = pickSpecs({}, new Set()).map(x => x.function.name);
    const fullNames = pickSpecs({}, new Set(Object.keys(GROUPS))).map(x => x.function.name);
    // 一、覆盖：一个工具都不能丢
    check('带上所有组 = 原来的全部工具（一个没丢）', fullNames.length === allNames.length && allNames.every(n => fullNames.includes(n)), [fullNames.length, allNames.length]);
    check('没写进组的工具兜底进 core（不会没人管）', allNames.every(n => (TOOL_GROUPS[n] || []).length > 0), allNames.filter(n => !(TOOL_GROUPS[n] || []).length));
    // 二、常驻组大小受控（审计要 ~25，这里含"看/问/身上活"的都要常在，落在 40 上下可接受）
    check('常驻组没把全部工具都塞进去（确实分出去了）', coreNames.length < allNames.length && coreNames.length <= 62, coreNames.length);
    check('★ 做饭 / 烧东西 / 制作链常驻（实测：说"烤羊肉"她手上没 smelt）', ['smelt', 'cook_pot', 'make_item'].every(n => coreNames.includes(n)), coreNames.filter(n => /smelt|cook|make/.test(n)));
    check('★ 背包 / 拿东西 / 服务器命令 / 水桶 / 计划更新常驻', ['open_backpack', 'take_items', 'run_command', 'bucket', 'plan_set', 'plan_step', 'home_stock'].every(n => coreNames.includes(n)), true);
    check('动作结果一行：失败带原因', /✗ 16 格内没有炉子/.test(toolResultLine('smelt', { itemName: 'mutton' }, { ok: false, error: '16 格内没有炉子' })), toolResultLine('smelt', { itemName: 'mutton' }, { ok: false, error: '16 格内没有炉子' }));
    check('动作结果一行：成功带关键字段、不带心里话', (() => { const l = toolResultLine('smelt', { itemName: 'mutton', inner: '好香' }, { ok: true, got: { cooked_mutton: 3 } }); return /✓ got=/.test(l) && !/好香/.test(l); })(), true);
    check('冷门工具（fish/animal/ride）不在常驻组，但一个都没删', !['fish', 'animal', 'ride'].some(n => coreNames.includes(n)) && ['fish', 'animal', 'ride'].every(n => allNames.includes(n)), coreNames.filter(n => /fish|animal|ride/.test(n)));
    check('常驻里有 tools 这个元工具（她想不起来还能这么干时能查）', coreNames.includes('tools'));
    // 三、SYSTEM 里点名的工具：要么在常驻组，要么"保证拿得到"（属于某个能激活的按需组）。
    // 这里把两类都列出来核对 —— 任务书要求"SYSTEM 点名的工具必须常驻或保证可激活"。
    const named = allNames.filter(n => new RegExp(`\\b${n}\\b`).test(SYSTEM));
    const notResident = named.filter(n => !coreNames.includes(n));
    const unreachable = notResident.filter(n => !(TOOL_GROUPS[n] || []).some(g => g !== 'core'));
    console.log(`      SYSTEM 点名 ${named.length} 个；其中 ${named.length - notResident.length} 个常驻、${notResident.length} 个按需（${[...new Set(notResident.map(n => (TOOL_GROUPS[n] || []).join('/')))].join('、')}）`);
    check('SYSTEM 点名的工具都在常驻组或某个按需组里（没有够不着的）', unreachable.length === 0, unreachable);
    // 每个按需组都得能"激活"（有 tools(group) 这条路；关键词/身体至少一条自动路径）
    const autoByCue = new Set(GROUP_CUES.flatMap(c => c.groups));
    const autoByBody = new Set([...groupsFromBody({ dark: true }), ...groupsFromBody({ nearby: [{ name: 'cow', kind: 'animal', distance: 3 }] }), ...groupsFromBody({ unseenChests: [{ name: 'chest', at: 1 }] })]);
    // 第三条自动路径（阶段 2）：队列里有事 → task 组（跑的是 think 里用的那份 groupsFromTasks）
    const autoByTasks = (() => {
      const T = require('./tasks'); const keep = W.tasks;
      W.tasks = { seq: 0, list: [], loaded: true };
      try { T.create({ title: '自测：排着一件', source: 'self' }); return groupsFromTasks(); } finally { W.tasks = keep; }
    })();
    const auto = (g) => autoByCue.has(g) || autoByBody.has(g) || autoByTasks.has(g);
    check('每个按需组都至少有一条自动激活的路（关键词 / 身体 / 任务队列）', Object.keys(GROUPS).filter(g => g !== 'core').every(auto), Object.keys(GROUPS).filter(g => g !== 'core' && !auto(g)));
    check('暗处 / 要火把：建造组带出来（不然 light_up、make_torches 使不上）', groupsFromBody({ dark: true, nearby: [], items: [], equipment: {} }).has('build'));
    check('身上有煤木棍但没火把：建造组也带出来（能做火把）', groupsFromBody({ dark: false, torches: 0, nearby: [], items: [{ name: 'coal', count: 3 }], equipment: {} }).has('build'));
    // ---- ★ R-fix4-6：手持字段是 equipment.hand（不是 mainhand）
    check('★ 手持 oak_planks（equipment.hand）→ 建造组带出来', groupsFromBody({ nearby: [], items: [], equipment: { hand: 'minecraft:oak_planks' } }).has('build'));
    check('★ 手持火把（equipment.hand）→ 建造组带出来', groupsFromBody({ nearby: [], items: [], equipment: { hand: 'minecraft:torch' } }).has('build'));
    check('手持石头照旧不误触发 farm', groupsFromBody({ nearby: [], items: [], equipment: { hand: 'minecraft:stone' } }).has('farm') === false, [...groupsFromBody({ nearby: [], items: [], equipment: { hand: 'minecraft:stone' } })]);
    check('★ 骑着船（vehicle）→ 农牧组带出来', groupsFromBody({ nearby: [], items: [], equipment: {}, vehicle: 'oak_boat' }).has('farm'));
    check('★ 开着箱子界面（windowOpen）→ 仓储组带出来', groupsFromBody({ nearby: [], items: [], equipment: {}, windowOpen: true }).has('store'));
    check('★ 正在挖矿（currentAction）→ 远行组带出来', groupsFromBody({ nearby: [], items: [], equipment: {}, currentAction: 'delve: 挖矿中' }).has('travel'));
    check('什么都没干：不乱带', groupsFromBody({ nearby: [], items: [], equipment: {}, currentAction: 'idle' }).size === 0, [...groupsFromBody({ nearby: [], items: [], equipment: {}, currentAction: 'idle' })]);
    // 四、激活 / 过期
    W.groupActive = {}; W.groupRound = 0;
    check('一开始没有按需组是激活的', activeGroups().size === 0);
    const r = activateGroup('farm');
    check('叫 farm：带上了', r.ok === true && r.带上 > 0, r);
    check('叫了之后 farm 就在生效列表里', activeGroups().has('farm'));
    W.groupRound += GROUP_ROUNDS - 1;   // 管 8 轮：第 8 轮结束时还在（叫它时是第 1 轮）
    check('管 8 轮：第 8 轮结束时还在', activeGroups().has('farm'), W.groupRound);
    W.groupRound += 1;   // 第 9 轮
    check('第 9 轮到期，自己收回去（不用手动清）', !activeGroups().has('farm'));
    check('叫一个不存在的组：如实说没有，不假装成功', activateGroup('nope').ok === false && /没有这个组/.test(activateGroup('nope').error));
    // 五、场景自动带出来
    W.groupActive = {}; W.groupRound = 0;
    const farmSpecs = pickSpecs({ nearby: [{ name: 'cow', kind: 'animal', distance: 4 }] }, groupsFromBody({ nearby: [{ name: 'cow', kind: 'animal', distance: 4 }] }));
    check('身边有牛：农活组自动带出来（animal/ride 能用）', farmSpecs.map(x => x.function.name).includes('animal'), farmSpecs.map(x => x.function.name).filter(n => ['animal', 'ride', 'fish'].includes(n)));
    const storeS = groupsFromBody({ unseenChests: [{ name: 'chest', at: 1 }] });
    check('看见没开过的箱子：仓储组自动带出来', storeS.has('store'), [...storeS]);
    check('脚边没东西、手是空的：不乱带按需组', groupsFromBody({ nearby: [], items: [], equipment: {} }).size === 0, [...groupsFromBody({ nearby: [], items: [], equipment: {} })]);
    // 关键词认场景
    const hit = (t) => GROUP_CUES.filter(c => c.re.test(t)).flatMap(c => c.groups);
    check('他说"去钓鱼/拿船" → 农活组', hit('带我去钓鱼').includes('farm'));
    check('他说"把东西放进箱子" → 仓储组', hit('把这些放进箱子里').includes('store'));
    check('他说"帮我把这面墙盖起来" → 建造组', hit('帮我把这面墙盖起来').includes('build'));
    check('他说"任务书交一下" → 任务组', hit('任务书那个交一下').includes('quest'));
    check('他说"我们下矿吧" → 远行组', hit('我们下矿吧').includes('travel'));
    // ---- ★ R-fix4-8：关键词要够具体，普通闲聊不能乱开枪
    check('★ 普通闲聊"我在远处的地里存了点东西" → 不再全开',
      [...new Set(hit('我在远处的地里存了点东西'))].filter(g => ['farm', 'travel', 'store', 'build'].includes(g)).length === 0, [...new Set(hit('我在远处的地里存了点东西'))]);
    check('★ 单个"地"不再触发农活组', hit('这地方不错').includes('farm') === false, hit('这地方不错'));
    check('★ 单个"存"不再触发仓储组', hit('我存在这里吧').includes('store') === false, hit('我存在这里吧'));
    check('★ 单个"远"不再触发远行组', hit('太远了').includes('travel') === false, hit('太远了'));
    check('"种地"仍然是农活组（具体词该命中）', hit('我们去种地').includes('farm'));
    check('"建造"仍然是建造组', hit('开始建造房子').includes('build'));
    check('纯闲聊不乱带组', hit('你在干嘛呀').length === 0, hit('你在干嘛呀'));
    // 六、省了多少
    W.groupActive = {}; W.groupRound = 0;
    const coreS = JSON.stringify(pickSpecs(W.state || {}, new Set()));
    check('只带常驻：比全带省下三成以上', coreS.length < JSON.stringify(SPECS).length * 0.7, [coreS.length, JSON.stringify(SPECS).length]);
    // 七、她这一轮里叫的组，同一轮的下一趟就得生效
    W.groupActive = {}; W.groupRound = 5;
    const seenTools = [];
    const realLlm = body.llm;
    let n = 0;
    body._setLLM(async (o) => {
      seenTools.push(o.tools.map(x => x.function.name));
      n++;
      if (n === 1) return { content: '', tool_calls: [{ id: 'g', function: { name: 'tools', arguments: JSON.stringify({ group: 'farm' }) } }] };
      return { content: '', tool_calls: [{ id: 'w', function: { name: 'wait', arguments: '{}' } }] };
    });
    W.pending = [{ t: Date.now(), text: '（测试）', names: [] }];
    W.lastNowEv = []; W.lastRoundResult = null; W.job = null;
    await think('event');
    check('★ 第一趟没带 farm（她还没叫）', !seenTools[0].includes('animal'), seenTools[0].length);
    check('★ 她叫了 farm 之后，同一轮的下一趟就带上了 animal', seenTools[1] && seenTools[1].includes('animal'), [seenTools[0]?.length, seenTools[1]?.length]);
    body._setLLM(realLlm);
    W.groupActive = {}; W.groupRound = 0;
    W.pending = [];
  }

  console.log('\n她自己的工具也能被调用（runTool 只看 TOOLS 的老毛病）');
  {
    check('recall（在 MIND_TOOLS 里）能被调用，不再回"没有这个动作"', (await runTool('recall', { query: '铁' })).ok === true);
    check('tools（元工具）能被调用', (await runTool('tools', {})).ok === true);
    check('my_dream 能被调用', (await runTool('my_dream', {})).ok === true);
    W.groupActive = {}; W.groupRound = 0;
  }

  console.log('\n本能报的暗处坐标 → 她一调 light_up 就带过去（问题 B，2026-09-29）');
  {
    const save = { darkSpots: W.darkSpots, instinctSeq: W.instinctSeq };
    const seen = [];
    const mb = mockBridge();
    const ctrl = {
      get: async (p) => (p.startsWith('/instinct/events')
        ? { seq: 7, events: [{ seq: 7, kind: 'dark_spot', text: '家里有 3 格地面是全黑的', count: 3, sample: [{ x: -7, y: 126, z: -1 }, { x: -8, y: 126, z: -1 }, { x: -9, y: 126, z: -1 }] }] }
        : mb.get(p)),
      post: async (p, b) => { if (p === '/light_up') seen.push(b); return mb.post(p, b); },
    };
    body._setBridge(ctrl);
    W.instinctSeq = 6;                       // 假装已经读到 6，让第 7 条事件算"新的"
    await look();
    check('★ dark_spot 的 sample 记进了 W.darkSpots', W.darkSpots, [{ x: -7, y: 126, z: -1 }, { x: -8, y: 126, z: -1 }, { x: -9, y: 126, z: -1 }]);
    body._setBridge(ctrl);
    await runTool('light_up', {});
    check('★ 调 light_up 时不带坐标，也自动带上本能报的暗处', Array.isArray(seen[0]?.spots) && seen[0].spots.length === 3, true);
    check('★ 带的就是本能报的那几格', seen[0].spots[0], { x: -7, y: 126, z: -1 });
    seen.length = 0;
    body._setBridge(ctrl);
    await runTool('light_up', { spots: [{ x: 1, y: 2, z: 3 }] });
    check('★ 她自己指定了 spots 就听她的（不覆盖）', seen[0].spots, [{ x: 1, y: 2, z: 3 }]);
    body._setBridge(mb);
    Object.assign(W, save);
  }

  console.log('\n空闲闸门（她闲着、身体在忙、也没人找她 → 不问模型）');
  {
    const save = { job: W.job, lastNowEv: W.lastNowEv, lastRoundResult: W.lastRoundResult, pending: W.pending };
    const busyJob = { steps: [{ tool: 'goto' }, { tool: 'mine' }], i: 0, why: '挖矿' };
    const idleLast = { said: [], did: [], rounds: ['wait'], at: Date.now() };
    const actLast = { said: [], did: ['mine'], rounds: ['mine'], at: Date.now() };
    const sayLast = { said: ['好'], did: [], rounds: ['say'], at: Date.now() };
    const set = (o) => { W.pending = []; W.job = busyJob; W.lastNowEv = [{ t: Date.now(), text: '身体：闲着', names: [] }]; W.lastRoundResult = idleLast; Object.assign(W, o); };

    set({});
    check('★ 没新事 + 身体在忙 + 上轮纯等 → 跳过（不问模型）', idleGate() === true);
    set({ pending: [{ t: Date.now(), text: '他：安琪' }] });
    check('有新事：不跳（放她去想）', idleGate() === false);
    set({ lastNowEv: [{ t: Date.now(), text: 'Ka_sum1 说：安琪', names: ['Ka_sum1'] }] });
    check('有人跟她说话：不跳', idleGate() === false);
    set({ lastNowEv: [{ t: Date.now(), text: '😖 被打了一下', names: [], urgent: true }] });
    check('有紧急事（挨打）：不跳', idleGate() === false);
    set({ job: null });
    check('身体闲着：不跳（她该自己想想干嘛）', idleGate() === false);
    set({ lastRoundResult: actLast });
    check('上一轮她动过手：不跳', idleGate() === false);
    set({ lastRoundResult: sayLast });
    check('上一轮她说过话：不跳', idleGate() === false);
    set({ lastRoundResult: null });
    check('没有上一轮的记录（刚起来）：不跳，宁可想一次', idleGate() === false);

    // 真走一遍 think：验证跳过时根本不调模型
    const realBodyLlm = body.llm;
    let called = 0;
    body._setLLM(async () => { called++; return { content: '', tool_calls: [{ id: 'w', function: { name: 'wait', arguments: '{}' } }] }; });
    set({ lastNowEv: [], lastRoundResult: idleLast });
    W.stats.idleSkipped = 0;
    await think('idle');
    check('★ 闸门开着时：think 直接返回，一次模型都没调', called === 0, called);
    check('跳过记了数（:3003/mind 的 stats 里看得见）', W.stats.idleSkipped === 1, W.stats.idleSkipped);
    // 有人说话时照样调
    called = 0;
    set({ pending: [{ t: Date.now(), text: 'Ka_sum1 说：来', names: ['Ka_sum1'] }] });
    await think('event');
    check('有人喊她：正常调模型（闸门不误伤）', called > 0, called);
    body._setLLM(realBodyLlm);
    W.job = save.job; W.lastNowEv = save.lastNowEv; W.lastRoundResult = save.lastRoundResult; W.pending = save.pending;
  }

  console.log('\n自我复盘（不对劲的地方留证据）');
  {
    const since = Date.now() - 1;
    W.pending = []; W.job = null;
    await startJob([{ tool: 'no_such_move', args: { x: 1 } }], '测试：他叫我过去');
    const fail = review.read({ since }).find(r => r.kind === 'action_failed');
    check('动作没做成 → 自动记一条，带工具、报错、为了什么', fail?.tool === 'no_such_move' && /没有/.test(fail.error) && /他叫我过去/.test(fail.why), fail);
    check('现场里有她当时在做什么', /no_such_move/.test(fail?.doing || ''), fail?.doing);
    MIND_TOOLS.report_issue.run({ category: '做不到', what: '明明能走却走不过去', guess: '可能是草' });
    const note = review.read({ since }).find(r => r.source === 'self');
    check('她自己的纸条：程序附上最近没做成的动作当证据', note?.category === '做不到' && note.recentFails.some(x => /no_such_move/.test(x)), note);
    const script2 = [{ content: '', tool_calls: [{ id: 's1', function: { name: 'say', arguments: '{"text":"好 这就来"}' } }] }];
    body._setLLM(async () => script2.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
    W.history = []; W.lastNow = null;
    W.pending = [{ t: Date.now(), text: '💬 Ka_sum1 说：过来', cue: 'Ka_sum1', names: ['Ka_sum1'] }];
    await think('event');
    const lazy = review.read({ since }).find(r => r.kind === 'said_no_action');
    check('说了"这就来"却一个动作都没有 → 记下', /这就来/.test(lazy?.said || ''), lazy);
    const md = review.render(review.read({ since }));
    check('报告里两种来源分开', /## 她自己察觉的/.test(md) && /## 程序记下的/.test(md), md);
    clearThinkTimer();
    W.pending = [];
    try { require('fs').unlinkSync(process.env.MC_REVIEW_FILE); } catch (_) {}
  }

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

  console.log('\n物品账：她知道东西是怎么进出的');
  {
    let ledger = { seq: 5, entries: [] };
    const base = mockBridge();
    body._setBridge({ ...base, get: async (p) => (p.startsWith('/inventory/ledger') ? ledger : base.get(p)) });
    const job0 = W.job; W.job = null; W.ledgerSeq = null;
    await look();
    check('刚醒：旧账不翻（只记住读到哪）', W.ledgerSeq === 5, W.ledgerSeq);
    ledger = { seq: 6, entries: [{ seq: 6, t: Date.now(), parts: [{ sign: '-', verb: 'stored', where: '箱子@1,64,2', items: { iron_ingot: 8 } }] }] };
    const n0 = W.pending.length;
    await look();
    const said = W.pending.slice(n0).map(x => x.text).join('\n');
    check('★ 闲着时：说得出放进了哪个箱子', /放进 箱子@1,64,2：.*×8/.test(said), said);
    W.job = { token: -1, steps: [], inv: [] };
    ledger = { seq: 7, entries: [{ seq: 7, t: Date.now(), parts: [{ sign: '+', verb: 'picked', items: { cobblestone: 3 } }] }] };
    const n1 = W.pending.length;
    await look();
    check('★ 干活时：攒进这件事的结果里，不单独刷', W.job.inv.length === 1 && W.pending.length === n1, { inv: W.job.inv, pending: W.pending.slice(n1) });
    ledger = { seq: 2, entries: [] };
    await look();
    check('bridge 重启（seq 倒回）→ 下一眼从 0 读', W.ledgerSeq === 0, W.ledgerSeq);
    W.job = job0;
    body._setBridge(base);
  }

  console.log('\n长期计划：做到了就自动打勾、告诉她下一步');
  {
    process.env.MC_PLAN_FILE = require('path').join(require('os').tmpdir(), `plan-mindtest-${process.pid}.json`);
    plan._reset();
    plan.setPlan({ goal: '做铁镐', steps: [{ text: '做石镐', done: { have: { stone_pickaxe: 1 } } }, '挖铁'] });
    const base = mockBridge();
    body._setBridge({ ...base, get: async (p) => (p.startsWith('/inventory') ? { items: [{ name: 'stone_pickaxe', count: 1 }] } : base.get(p)) });
    const n0 = W.pending.length;
    await look();
    const said = W.pending.slice(n0).map(x => x.text);
    check('★ 背包里有了石镐 → "做到了，下一步：挖铁"', said.some(t => /「做石镐」做到了，下一步：挖铁/.test(t)), said);
    check('闲着的时候【长期计划】里有现状和下一步', /接着做「挖铁」/.test(planLine('idle')) && /现状：镐：石镐/.test(planLine('idle')), planLine('idle'));
    check('平时只一行', /^\n【长期计划】做铁镐 —— 正在做：挖铁（通关主线 \d+\/64/.test(planLine('event')), planLine('event'));
    W.ftbq = new Set(['362E2399F791D149']);   // 做完了"致富之路"
    check('★ 读到任务书进度 → 主线下一个出现在候选里（白手起家）', /主线：白手起家/.test(planLine('idle')), planLine('idle'));
    W.ftbq = null;
    // 游玩路线：任务书编号带出来、why 末尾补「（任务书：章名·任务名）」、路线那两条不被截掉
    {
      plan._reset();
      plan.setPlan({ goal: 'x', steps: ['一步'] });
      const baseState = W.state;
      W.state = { ...W.state, items: [] };
      // 读不到任务书：路线里会出现「打开任务书…看完」（g2-open-quest，无 done，靠任务书判）
      W.ftbq = null;
      const idleNo = planLine('idle');
      const routeBefore = (idleNo.match(/· 路线：[^\n]*/g) || []);
      check('★ 读不到任务书 → 无 done 的路线目标不挡路（冒得出来）', routeBefore.length === 2, routeBefore);
      // 读到任务书且「新手小屋」做完 → g2-open-quest 算做完，不再出现在路线里
      W.ftbq = new Set(['7FAC7B71B61AFF81']);
      const idleQ = planLine('idle');
      check('★ 任务书进度接进路线：做完的任务不再冒出来', !/打开任务书，把【新手礼包and游玩须知】看完/.test(idleQ), (idleQ.match(/· 路线：[^\n]*/g) || []));
      check('★ 任务书编号 → 「章名·任务名」查得出来', questLabel('7FAC7B71B61AFF81') === '新手礼包and游玩须知·新手小屋', questLabel('7FAC7B71B61AFF81'));
      check('…查不到的 id 返回 null（不硬编）', questLabel('FFFFFFFFFFFFFFFF') === null, questLabel('FFFFFFFFFFFFFFFF'));
      // 把无 quests 的生存开场目标用背包判掉 → 剩下的 start 候选全带任务书编号，
      // 这样无论 30 分钟窗口轮到哪个，路线那两条的 why 末尾都该有「（任务书：…）」
      W.state = { ...W.state, items: [{ name: 'minecraft:oak_log', count: 8 }, { name: 'minecraft:dirt', count: 8 }, { name: 'minecraft:oak_planks', count: 16 }] };
      const idleLab = planLine('idle');
      const routeLab = (idleLab.match(/· 路线：[^\n]*/g) || []);
      check('★ 带任务书编号的路线候选，why 末尾带「（任务书：章名·任务名）」', routeLab.length === 2 && routeLab.every(l => /（任务书：[^）]+·[^）]+）/.test(l)), routeLab);
      W.state = baseState;
      W.ftbq = null;
    }
    // 工程 / 布置 / 心愿很多时，路线那 2 条不被 slice 截掉
    {
      plan._reset();
      plan.setPlan({ goal: 'x', steps: ['一步'] });
      W.projects = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, name: '工程' + i, done: '10%', missing: {} }));
      W.layouts = [{ id: 'L1', name: '家', done: 3, total: 6, canPlaceNow: ['furnace', 'chest'], stale: ['仓库'] }];
      const idleMany = planLine('idle');
      check('★ 前面候选很多时，路线那两条仍在（不被截掉）', (idleMany.match(/· 路线：/g) || []).length === 2, (idleMany.match(/· 路线：[^\n]*/g) || []));
      W.projects = []; W.layouts = [];
    }
    // 工程、布置、心愿都进计划的候选（只有计划一个声音在说"接下来做什么"）
    W.projects = [{ id: 'p1', name: '门口小仓库', done: '40%', toDig: 3, toPlace: 12, missing: { cobblestone: 9 } }];
    W.layouts = [{ id: 'L1', name: '家', done: 3, total: 6, stillWant: { furnace: 1 }, canPlaceNow: ['furnace'], stale: ['仓库'] }];
    const idle = planLine('idle');
    check('★ 未完工的工程是候选（带缺什么）', /接着盖「门口小仓库」.*还缺/.test(idle), idle);
    check('★ 手上能摆的家具是候选', /把手上的 .* 摆进家里规划的区/.test(idle), idle);
    check('★ 要重新想的区是候选', /重新想想家里的「仓库」/.test(idle), idle);
    const now = buildNow('event').text;
    check('★ 工程/布置那两段只剩状态，不再各自催（没有"没别的事就 build_work""→ furnish"）', !/没别的事就 build_work/.test(now) && !/→ furnish/.test(now), now.slice(-600));
    W.projects = []; W.layouts = [];
    body._setBridge(base);
    try { require('fs').unlinkSync(process.env.MC_PLAN_FILE); } catch (_) {}
  }

  console.log('\n天黑本能：天色一变就知道');
  {
    let phase = 'day'; let time = 11000;
    const base = mockBridge();
    body._setBridge({ ...base, get: async (p) => (p.startsWith('/status') ? { ...(await base.get(p)), isDay: phase === 'day', phase, gameTime: time, exposure: { kind: 'open' } } : base.get(p)) });
    W.phase = null;
    await look();
    const n0 = W.pending.length;
    phase = 'night'; time = 14000;
    await look();
    const said = W.pending.slice(n0);
    check('★ 白天→夜里：马上有一件"天黑了"的事（要紧）', said.some(x => /🌙 天黑了（时刻 14000）/.test(x.text)), said.map(x => x.text));
    check('★ 不再和老的"该回家睡觉了"重复说', said.filter(x => /天黑了/.test(x.text)).length === 1, said.map(x => x.text));
    const n1 = W.pending.length;
    await look();
    check('同一个晚上不重复说', W.pending.slice(n1).every(x => !/天黑了/.test(x.text)), W.pending.slice(n1).map(x => x.text));
    body._setBridge(base);
    W.phase = null;
  }

  console.log('\n她的余光（野外资源感知）：提示词里的那一行');
  {
    // 直接测真正跑的那个函数（surroundLine 由 buildNow 的 parts 调用）
    check('★ 扫到东西：照实念（含"没开过的箱子"排在前面）', /【附近看得见的】没开过的箱子 2 个（东北 20 格）、橡树 9 棵（东 6 格）/.test(surroundLine({ surroundings: { line: '没开过的箱子 2 个（东北 20 格）、橡树 9 棵（东 6 格）' } })), surroundLine({ surroundings: { line: '没开过的箱子 2 个（东北 20 格）、橡树 9 棵（东 6 格）' } }));
    // 扫过了没有 ≠ 没有：说"这块看过了没有"，不是"没有"
    const none = surroundLine({ surroundings: { line: '', items: [] } });
    check('★ 扫过了、附近没有：说"看过了没有"（不是"没有"）', /看过了/.test(none) && !/^【附近看得见的】没有/.test(none), none);
    // 读不到 ≠ 没有：桥接没起 / 端点旧 → 整行不出现（不说"没有"）
    check('★ 读不到（surroundings 为 null）：不冒出一行假"没有"', surroundLine({ surroundings: null }) === '', surroundLine({ surroundings: null }));
    // 缺什么就排前面：桥接那边已经排好序，这里核对"她缺黏土时黏土在前"
    check('★ 缺黏土：那一行里黏土在树前面', (() => { const l = '黏土一片（北 18 格，水下）、橡树 9 棵（东 6 格）'; const i = surroundLine({ surroundings: { line: l } }); return i.indexOf('黏土') < i.indexOf('橡树'); })(), true);
    // 野外没开过的箱子：提示词里点名"手不忙就先过去开"，且排在第一条
    const boxes = [{ name: 'chest', x: 20, y: 64, z: -12, distance: 23, outdoor: true }];
    // survivalFocus 没有 pos 就整段不返回（见函数开头）—— 测试要带上 pos/items/nearby
    const s2 = { health: 18, isDay: true, currentAction: null, pos: { x: 35, y: 64, z: -138 }, items: [], nearby: [], players: [], unseenChests: boxes, surroundings: { line: '没开过的箱子 1 个（东北 23 格）' } };
    check('★ 野外箱子：那一行里有它（没开过的箱子）', /没开过的箱子/.test(surroundLine(s2)), surroundLine(s2));
    // 手不忙 + 不危险：buildNow 会点名"先过去开"
    {
      const W0 = W.state;
      W.state = { ...s2 };
      const txt = buildNow('event').text;
      check('★ 野外有没开过的箱子、手不忙：点名"先过去开"', /野外有 1 个没打开过的箱子.*先过去开/.test(txt), txt.match(/野外有[^\n]*/)?.[0]);
      W.state = W0;
    }
    // 忙 / 危险时不催：跟着主人 / 打架 / 血少 → 让位给保命和主人
    for (const [why, st] of [['跟着主人', { following: 'Ka_sum1' }], ['在打架', { currentAction: 'attack' }], ['血少', { health: 8 }]]) {
      const W0 = W.state;
      W.state = { ...s2, ...st };
      const txt = buildNow('event').text;
      check(`★ ${why}：不冒"野外有…先过去开"（让位给保命/主人）`, !/野外有 .*没打开过的箱子.*先过去开/.test(txt), txt.match(/野外有[^\n]*/)?.[0]);
      W.state = W0;
    }
  }

  console.log('\n任务队列（阶段 1）：不丢事、不乱顶、摆到她眼前');
  {
    // 这一段跑的就是真跑的那份（tasks.js 的判据 + buildNow 拼出来的那两行 + startJob 照做），
    // 不另抄一份实现 —— 任务书 §5-1 的老规矩。
    const T = require('./tasks');
    const W0 = W.state;
    const tmpT = require('path').join(require('os').tmpdir(), `tasks-test-${process.pid}.json`);
    // loaded:true = 干净的空队列（store() 第一次用到会从文件读回，测持久化的那几条自己把 loaded 设回 false 再 load）
    const resetT = () => { W.tasks = { seq: 0, list: [] }; W.tasks.loaded = true; W.tasks.unreadable = false; };
    try { require('fs').unlinkSync(tmpT); } catch (_) {}
    process.env.MC_TASKS_FILE = tmpT;
    resetT();
    W.state = { connected: true, health: 18, food: 15, isDay: true, pos: { x: 0, y: 64, z: 0 }, items: [], nearby: [], players: [] };

    // ── 1) 她做 A 时，发"不动身体"的工具 → A 还在做（不被打断）
    const { task: A } = T.create({ title: '做一把铁镐', source: 'self', steps: [{ tool: 'mine' }, { tool: 'craft' }], i: 1 });
    T.setRunning(A.id);
    await startJob([{ tool: 'say', args: { text: '好' } }], '回他一句', { heardPlayer: true });
    check('★ 做 A 时只说句话 → A 仍在做（没被打断）', T.get(A.id).status === 'running', T.get(A.id).status);
    await startJob([{ tool: 'scan_blocks', args: {} }], '扫一眼', { heardPlayer: true });
    check('★ 做 A 时只看一眼（scan_blocks）→ A 仍在做', T.get(A.id).status === 'running', T.get(A.id).status);

    // ── 2) 发"动身体"的动作 → A 停下，且不丢
    // （这里先把 B 立成 running，模拟"她决定改做另一件"——不然 startJob 会当她还在做 A、
    //   做完就把 A 收尾了，那是"接着做同一件"的正常路径，不是"被打断"）
    const { task: B } = T.create({ title: '去砍点木头', source: 'self' });
    T.setRunning(B.id);
    check('B 成为 running 时 A 已停下（一个身体只有一件事）', T.get(A.id).status === 'paused', T.get(A.id).status);
    await startJob([{ tool: 'mine', args: {} }], '去挖矿', { heardPlayer: false, taskId: B.id });
    check('★ 做 A 时发 mine → A 停下了', T.get(A.id).status === 'paused', T.get(A.id).status);
    check('★ A 停下的理由 = self（不是因为主人插事）', T.get(A.id).pausedWhy === 'self', T.get(A.id).pausedWhy);
    check('★ A 还在（不丢事）', T.get(A.id) !== null && T.open().some(t => t.id === A.id), T.open().map(t => t.id));
    check('A 记了一次被打断', T.get(A.id).interruptions === 1, T.get(A.id).interruptions);

    // ── 2b) 身体被本能占着（busy）→ 有限次重试，不标任务 failed
    {
      resetT();
      const { task: E } = T.create({ title: '去挖点铁', source: 'self', steps: [{ tool: 'mine' }] });
      T.setRunning(E.id);
      const prevBridge = { get: bridge.get, post: bridge.post };
      let tries = 0;
      // 头两次回"身体忙着"（bridge 的这把锁），第三次才成功 —— 走的正是 startJob 里那条重试路
      body._setBridge({
        post: async (p, b) => (p === '/mine'
          ? (++tries < 3 ? { success: false, error: '身体忙（busy），先等前面那条做完' } : { success: true, mined: 1 })
          : prevBridge.post(p, b)),
      });
      await startJob([{ tool: 'mine', args: {} }], '去挖铁', { taskId: E.id });
      check('★ 身体忙 → 重试到成功（一共试了 3 次）', tries === 3, tries);
      // 阶段 2 起：明确的任务一串做完**不自动算做完**（要 task_done + 证据），做成的那步记进证据
      check('★ 重试期间任务没被标 failed（还在手上，做成的那步记进了证据）', T.get(E.id).status === 'running' && (T.get(E.id).evidence || []).length === 1, T.get(E.id));
      body._setBridge(prevBridge);   // 装回真的那份桥
    }

    // ── 2c) 重试也没用 → 才当失败（真失败才标 failed）
    {
      resetT();
      // 阶段 2：自动包的那件（她没有手上的事时直接发的动作）真失败才标 failed；明确的那件不标，记下卡在哪
      const { task: F } = T.create({ title: '挖不动的矿', source: 'self', steps: [{ tool: 'mine' }], auto: true });
      T.setRunning(F.id);
      const prevBridge = { get: bridge.get, post: bridge.post };
      let tries = 0;
      body._setBridge({ post: async (p, b) => (p === '/mine' ? (++tries, { success: false, error: '身体忙（busy）' }) : prevBridge.post(p, b)) });
      await startJob([{ tool: 'mine', args: {} }], '挖矿', { taskId: F.id });
      check('★ 一直忙 → 试满 4 次（1 次 + 3 次重试）就当失败', tries === 4, tries);
      check('★ 自动包的那件：真失败才标 failed（不静默）', T.get(F.id).status === 'failed', T.get(F.id).status);
      const { task: G } = T.create({ title: '帮我挖点铁', said: '帮我挖点铁', source: 'player' });
      T.setRunning(G.id);
      await startJob([{ tool: 'mine', args: {} }], '挖铁', { taskId: G.id });
      check('★ 主人交代的：一串没做成 → 不标 failed（不从队列里消失），记下卡在哪', T.get(G.id).status === 'running' && /身体忙/.test(T.get(G.id).lastFail || ''), T.get(G.id));
      const failEv = W.pending.map(e => e.text).reverse().find(e => /❌ mine/.test(e)) || '';
      check('★ "❌ 没做成"那条事件后面带着"还没标做完（卡在…）"的提醒', /#\d+ 帮我挖点铁 还没标做完（卡在：mine → 身体忙/.test(failEv), failEv);
      body._setBridge(prevBridge);
    }

    // ── 3) 主人的话自动进队列（走真正跑的那条路：TASK_ASK_RE 命中 → create）
    resetT();
    const n0 = W.pending.length;
    emit('💬 Ka_sum1 说：帮我做把铁镐', { cue: 'Ka_sum1 帮我做把铁镐', names: ['Ka_sum1'], urgent: true });
    await think('event');
    const made = T.all().filter(t => t.source === 'player');
    check('★ 他交代的事自动进队列（source=player）', made.length >= 1, T.all().map(t => ({ id: t.id, src: t.source, said: t.said })));
    if (made.length) {
      check('★ 记的是他的原话（前 30 字）', String(made[0].said || '').includes('帮我做把铁镐'), made[0].said);
      check('★ 记了是谁交代的', made[0].askedBy === 'Ka_sum1', made[0].askedBy);
      check('★ player 任务不过期（ttlMs 为空）', made[0].ttlMs == null, made[0].ttlMs);
      const idBefore = made[0].id;
      // 同一句话再说一遍 → 不重复堆
      W.pending.length = 0;
      emit('💬 Ka_sum1 说：帮我做把铁镐', { cue: 'Ka_sum1 帮我做把铁镐', names: ['Ka_sum1'], urgent: true });
      await think('event');
      const again = T.all().filter(t => t.source === 'player' && t.id === idBefore);
      check('★ 同一件事再说一遍 → 还是那一件（不重复堆）', again.length === 1 && T.all().filter(t => t.source === 'player').length === made.length, T.all().filter(t => t.source === 'player').map(t => t.id));
    }

    // ── 4) 本能抢身体 → paused(instinct)
    resetT();
    const { task: C } = T.create({ title: '盖房子', source: 'self' });
    T.setRunning(C.id);
    T.onInstinct('combat');
    check('★ 本能抢身体 → running 那件 paused(instinct)', T.get(C.id).status === 'paused' && T.get(C.id).pausedWhy === 'instinct', { s: T.get(C.id).status, w: T.get(C.id).pausedWhy });

    // ── 5) "都别做了" → player 全放下，self 不动（判据 DROP_ALL_RE）
    resetT();
    const { task: P1 } = T.create({ title: '帮我做把铁镐', said: '帮我做把铁镐', source: 'player', askedBy: 'Ka_sum1' });
    const { task: P2 } = T.create({ title: '帮我把箱子理一下', said: '帮我把箱子理一下', source: 'player', askedBy: 'Ka_sum1' });
    const { task: S1 } = T.create({ title: '自己想做的', source: 'self' });
    T.setRunning(P1.id);
    const dropped = T.dropPlayerTasks({ why: '主人说都别做了' });
    check('★ "都别做了" → player 任务全放下', [P1, P2].every(t => T.get(t.id).status === 'dropped'), [T.get(P1.id).status, T.get(P2.id).status]);
    check('★ self 任务不动', T.get(S1.id).status === 'queued', T.get(S1.id).status);
    check('放下时写了原因', /都别做了/.test(T.get(P2.id).progress || ''), T.get(P2.id).progress);

    // ── 6) 上下文那两行（走真正的 buildNow，不是只调 tasks）
    resetT();
    {
      const { task: R } = T.create({ title: '做一把铁镐', source: 'player', said: '帮我做把铁镐', askedBy: 'Ka_sum1', steps: [{ tool: 'mine' }, { tool: 'craft' }, { tool: 'give' }], i: 2, progress: '已经做了木棍，还缺 3 个铁锭' });
      T.setRunning(R.id);
      const { task: Q } = T.create({ title: '去砍点木头', source: 'self', parent: R.id });
      const { task: Z } = T.create({ title: '把家里暗处插亮', source: 'self' });
      T.pause(Z.id, 'player');
      const txt = buildNow('event').text;
      check('★ 【此刻】里有【手上的事】', /【手上的事】#\d+ 做一把铁镐/.test(txt), txt.match(/【手上的事】[^\n]*/)?.[0]);
      check('★ 写着是"主人交代"的、做到第几步', /做一把铁镐（主人交代（Ka_sum1），做到第 2 步/.test(txt), txt.match(/【手上的事】[^\n]*/)?.[0]);
      check('★ 【排着的】里带着"为了 #id"和"被打断"', /【排着的】[\s\S]*去砍点木头（为了 #\d+ 做一把铁镐）/.test(txt) && /把家里暗处插亮（被打断：主人插了别的事）/.test(txt), txt.match(/【排着的】[^\n]*/)?.[0]);
      check('★ 建议顺序：主人交代的在手上，自己排后面', txt.indexOf('做一把铁镐') < txt.indexOf('去砍点木头'), true);
      // 没有任务时整段不出现（别占上下文）
      resetT();
      const txt2 = buildNow('event').text;
      check('★ 没有任务时那两行整段不出现', !/【手上的事】|【排着的】/.test(txt2), txt2.match(/【(手上的事|排着的)】[^\n]*/)?.[0]);
    }

    // ── 7) 持久化 + 重启接手（跑真盘）
    resetT();
    {
      const { task: PA } = T.create({ title: '帮我做把铁镐', said: '帮我做把铁镐', source: 'player', askedBy: 'Ka_sum1', steps: [{ tool: 'mine' }], i: 1 });
      const { task: SB } = T.create({ title: '自己去砍树', source: 'self', steps: [{ tool: 'goto', args: { x: 1, z: 2 } }] });
      T.setRunning(PA.id);
      T.save(tmpT);
      check('★ 写盘后文件在、没有半截 .tmp', require('fs').existsSync(tmpT) && !require('fs').existsSync(tmpT + '.tmp'));
      const before = JSON.stringify({ seq: W.tasks.seq, list: T.all() });
      resetT(); W.tasks.loaded = false;
      const r = T.load(tmpT);
      check('★ 读得回来（不是 unreadable）', r.unreadable === false, r);
      check('★ 读回来内容一致', JSON.stringify({ seq: W.tasks.seq, list: T.all() }) === before, true);
      // running 那件重启后 → paused(restart)；到期的 self → expired
      T.get(SB.id).createdAt = Date.now() - 21 * 60 * 1000;   // 假装 21 分钟前建的（ttl 20 分钟）
      const rep = T.restore();
      check('★ 重启后 running → paused(restart)', T.get(PA.id).status === 'paused' && T.get(PA.id).pausedWhy === 'restart', { s: T.get(PA.id).status, w: T.get(PA.id).pausedWhy });
      check('★ 到期的 self → expired（说清了哪件）', T.get(SB.id).status === 'expired' && rep.expired.some(t => t.id === SB.id), rep.expired.map(t => t.id));
      check('★ player 任务放多久都不过期', T.get(PA.id).status === 'paused' && T.get(PA.id).pausedWhy === 'restart', T.get(PA.id).status);
      // 坏文件 → unreadable，不静默（"读不到"和"没有"分开报）
      require('fs').writeFileSync(tmpT, '{ 这不是 JSON');
      resetT(); W.tasks.loaded = false;
      const bad = T.load(tmpT);
      check('★ 坏 JSON → unreadable=true（不静默）', bad.unreadable === true, bad);
      try { if (bad.backup) require('fs').unlinkSync(bad.backup); } catch (_) {}   // 坏文件会先备份一份（2026-09-30）
      try { require('fs').unlinkSync(tmpT); } catch (_) {}
    }

    // ── 8) 附加小项：同一目的地来回走（判据在 tasks.js，runTool 是唯一落点）
    resetT();
    {
      const st = { pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_log', count: 1 }], players: [] };
      const go = (x, z, items = st.items, t = null) => T.noteSpot('goto', { x, z }, { ...st, items }, { now: t || Date.now() });
      const h1 = go(15665, 10020);
      const h2 = go(15666, 10021);
      const h3 = go(15664, 10020);
      check('★ 同一点去第 3 次、背包没变 → 提醒换办法', h1 === '' && h2 === '' && /你已经去 \(15664,10020\) 这里 3 次了/.test(h3) && /换个办法/.test(h3), h3);
      T.clearSpot();
      go(1, 1); go(1, 1);
      const h4 = go(1, 1, [{ name: 'oak_log', count: 2 }]);
      check('★ 背包变了 → 不提醒（这一趟不是白跑）', h4 === '', h4);
      T.clearSpot();
      go(100, 100); go(200, 200);
      check('★ 不同目的地 → 不提醒', go(300, 300) === '', T.spotTries);
    }

    // ── 9) 阶段 2：真跑的那份 startJob + task_* 工具（不只调 tasks.js）
    resetT();
    {
      const prevBridge = { get: bridge.get, post: bridge.post };
      body._setBridge({ get: prevBridge.get, post: async (p, b) => (p === '/craft' ? { success: true, crafted: 'minecraft:stick' } : prevBridge.post(p, b)) });
      // 他交代 → 自动进队列；她这一轮动手（playerTaskId）→ 这串算在他交代的那件上
      const { task: P } = T.create({ title: '帮我做把铁镐', said: '帮我做把铁镐', source: 'player', askedBy: 'Ka_sum1' });
      await startJob([{ tool: 'craft', args: { itemName: 'stick' } }], '先做木棍', { heardPlayer: true, playerTaskId: P.id });
      check('★ 他刚交代、她动手 → 这串算在他那件上（running、有证据）', T.get(P.id).status === 'running' && (T.get(P.id).evidence || []).length === 1, T.get(P.id));
      const i0 = T.get(P.id).interruptions;
      await startJob([{ tool: 'craft', args: { itemName: 'stick' } }], '再做一次', { heardPlayer: false });
      check('★ 接着做同一件（没说换）→ 不算被打断', T.get(P.id).interruptions === i0 && T.get(P.id).status === 'running', T.get(P.id));
      const okEv = W.pending.map(e => e.text).reverse().find(e => /✅ 做完了/.test(e)) || '';
      check('★ "✅ 做完了"后面带着"还没标做完 —— 真做完了用 task_done"', /#\d+ 帮我做把铁镐 还没标做完.*task_done/.test(okEv), okEv);
      // 工具走 ALL（和模型调的是同一份）
      const names = (groups) => pickSpecs(W.state, groups).map(s => s.function?.name || s.name);
      check('★ task_add 常驻（队列空着也能记事）', names(new Set()).includes('task_add'), true);
      check('★ 队列里有事 → 自动带 task 组（note / done / drop / resume 都在手上）', groupsFromTasks().has('task') && ['task_note', 'task_done', 'task_drop', 'task_resume'].every(n => names(groupsFromTasks()).includes(n)), [...groupsFromTasks()]);
      const r1 = await runTool('task_done', { result: '做好了木棍' });
      check('★ task_done 有证据 → 做完', r1.ok === true && T.get(P.id).status === 'done', r1);
      // 没有手上的事、直接发动作 → 自动包一件 self，做完自动收尾
      await startJob([{ tool: 'craft', args: { itemName: 'stick' } }], '顺手做点木棍', {});
      const au = T.all().find(t => t.auto);
      check('★ 没有手上的事直接动手 → 自动包一件（self, auto），做完自动 done', au && au.source === 'self' && au.status === 'done', au);
      const r2 = await runTool('task_done', {});
      check('手上没事时 task_done → 拒绝并说清楚', r2.ok === false && /手上没有在做的事/.test(r2.error), r2);
      resetT();
      check('★ 队列空了 → 不带 task 组（省工具说明的篇幅）', groupsFromTasks().size === 0, [...groupsFromTasks()]);
      body._setBridge(prevBridge);
    }

    // ── 10) 阶段 2：放下主人交代的事 → 允许跟他说一声（走真的 think + 说话闸，假模型）
    {
      const line = '铁镐先不做了 附近没铁';
      check('前提：这句话本来会被当成"播报"（不然下面的对照没意义）', speech.classify(line) === 'report', speech.classify(line));
      const runRound = async (steps) => {
        const said = []; const mb = mockBridge();
        body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
        body._setLLM(async () => steps.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
        // 他 5 分钟没开口（"少汇报"那道闸管着）
        W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000;
        W.lastAskedAt = 0; W.lastProactive = null;
        emit('❌ mine 没做成：附近没有铁矿', { names: [] });
        for (let i = 0; i < 40 && (W.thinking || thinkTimerValue() || W.pending.length); i++) await new Promise(r => setTimeout(r, 100));
        await new Promise(r => setTimeout(r, 200));
        return said;
      };
      // 对照组：没放下，同一句 → 被当播报拦下
      resetT(); W.dropTell = null;
      const T0 = T.create({ title: '帮我做把铁镐', said: '帮我做把铁镐', source: 'player', askedBy: 'Ka_sum1' }).task;
      const s0 = await runRound([{ content: '', tool_calls: [{ id: 'y1', function: { name: 'say', arguments: JSON.stringify({ text: line }) } }] }]);
      check('对照：没 task_drop，这句"不做了"被当播报拦下', !s0.some(x => /不做了/.test(x)), s0);
      // 放下（主人交代的，写了原因）→ 这一句说得出去
      const s1 = await runRound([
        { content: '', tool_calls: [{ id: 'z1', function: { name: 'task_drop', arguments: JSON.stringify({ id: T0.id, why: '附近找不到铁' }) } }] },
        { content: '', tool_calls: [{ id: 'z2', function: { name: 'say', arguments: JSON.stringify({ text: line }) } }] },
      ]);
      check('★ task_drop 放下主人交代的 → 那一句"不做了"发出去了', s1.some(x => /不做了/.test(x)), s1);
      check('★ 任务确实放下了（dropped，原因记着）', T.get(T0.id).status === 'dropped' && /附近找不到铁/.test(T.get(T0.id).progress || ''), T.get(T0.id));
      check('★ 说过一次口子就关上（一次放下只放行一句）', W.dropTell === null, W.dropTell);
      const s2 = await runRound([{ content: '', tool_calls: [{ id: 'y2', function: { name: 'say', arguments: JSON.stringify({ text: line }) } }] }]);
      check('再说一遍同样的 → 照拦（口子已关）', !s2.some(x => /不做了/.test(x)), s2);
      check('借口子说别的播报 → 照拦（判据只认"不做了 / 做不成 / 找不到"）', dropTellAllowed('我去插火把', { at: Date.now() }) === false && dropTellAllowed(line, { at: Date.now() }) === true && dropTellAllowed(line, { at: Date.now() - 11 * 60 * 1000 }) === false);
      body._setBridge(mockBridge());
      W.lastHeardAt = 0;
    }

    // ── 11) 阶段 3：说"做好了"联动任务状态 / 计划联动（走真的 think + 工具，假模型）
    {
      const runRound = async (steps) => {
        const said = []; const mb = mockBridge();
        body._setBridge({ get: mb.get, post: async (p, b) => { if (p === '/chat') said.push((b.messages || [b.message]).join('/')); return mb.post(p, b); } });
        body._setLLM(async () => steps.shift() || { content: '', tool_calls: [{ id: `w${Math.random()}`, function: { name: 'wait', arguments: '{}' } }] });
        W.history = []; W.lastNow = null; W.pending = []; W.chatWait = null; W.lastHeardAt = Date.now() - 5 * 60 * 1000;
        W.lastAskedAt = 0; W.lastProactive = null; W.recentResults = []; W.recentLive = []; W.lastTaskDoneSaidAt = 0;
        emit('✅ 做完了：craft{"itemName":"iron_pickaxe"} → {"crafted":"minecraft:iron_pickaxe"}', { names: [] });
        for (let i = 0; i < 40 && (W.thinking || thinkTimerValue() || W.pending.length); i++) await new Promise(r => setTimeout(r, 100));
        await new Promise(r => setTimeout(r, 200));
        return said;
      };
      resetT();
      const P = T.create({ title: '帮我做把铁镐', said: '帮我做把铁镐', source: 'player', askedBy: 'Ka_sum1' }).task;
      T.setRunning(P.id);
      T.noteEvidence(P.id, 'craft{"itemName":"iron_pickaxe"} → crafted minecraft:iron_pickaxe');
      const s1 = await runRound([
        { content: '', tool_calls: [{ id: 'h1', function: { name: 'say', arguments: '{"text":"铁镐做好了"}' } }] },
        { content: '', tool_calls: [{ id: 'h2', function: { name: 'task_done', arguments: '{"result":"做了一把铁镐"}' } }] },
        { content: '', tool_calls: [{ id: 'h3', function: { name: 'say', arguments: '{"text":"铁镐做好了"}' } }] },
      ]);
      const nudged = W.history.some(m => m.role === 'tool' && /#\d+ 帮我做把铁镐」在你的任务里还没标做完/.test(m.content));
      check('★ 任务还没标做完就说"铁镐做好了" → 拦下，提示先 task_done', nudged, W.history.filter(m => m.role === 'tool').map(m => m.content.slice(0, 80)));
      check('★ task_done（有证据）之后再说 → 发出去了（而且只发了一次）', s1.filter(x => /铁镐做好了/.test(x.replace(/\//g, ''))).length === 1 && T.get(P.id).status === 'done', { s1, st: T.get(P.id).status });
      check('★ 发出去靠的是任务状态：他 5 分钟没开口，"做完说一声"按刚收尾的那件放行', !!T.lastEndedPlayer() && T.lastEndedPlayer().id === P.id && W.lastTaskDoneSaidAt >= T.lastEndedPlayer().at, T.lastEndedPlayer());
      // 计划联动：task_add(plan_step) → task_done → 计划那一步打勾；计划改过（原文对不上）→ 不打
      plan._reset();
      plan.setPlan({ goal: '做铁镐', steps: ['做石镐', '挖铁'] });
      resetT();
      const a1 = await runTool('task_add', { title: '做石镐', when: 'now', plan_step: 0 });
      check('task_add(plan_step) → source=plan、记着那一步的原文', a1.ok && T.get(a1.id).source === 'plan' && T.get(a1.id).planText === '做石镐', { a1, t: T.get(a1.id) });
      T.noteEvidence(a1.id, 'craft → crafted stone_pickaxe');
      const d1 = await runTool('task_done', { result: '石镐做好了' });
      check('★ 计划任务做完 → 计划第 0 步打勾了', d1.ok && /计划第 0 步打勾了/.test(d1.plan || '') && plan.get().steps[0].ok === true, { d1, steps: plan.get().steps });
      const a2 = await runTool('task_add', { title: '挖铁', when: 'now', plan_step: 1 });
      plan.updateStep({ index: 1, text: '挖金子' });   // 她后来把计划改了
      T.noteEvidence(a2.id, 'mine → got raw_iron');
      const d2 = await runTool('task_done', {});
      check('★ 计划那一步被改过（原文对不上）→ 任务照样做完，但计划不乱打勾、说清为什么', d2.ok && /计划没打勾：计划第 1 步已经改成「挖金子」了/.test(d2.plan || '') && plan.get().steps[1].ok === false, { d2, steps: plan.get().steps });
      const bad = await runTool('task_add', { title: '不存在的一步', plan_step: 9 });
      check('plan_step 越界 → 拒绝（不建一件指向空处的计划任务）', bad.ok === false && /没有第 9 步/.test(bad.error), bad);
      // 闲着推计划：手上没事、idle 这一轮动手 → 建 source=plan 的任务（不是 auto，一串做完不算做完）
      resetT(); plan._reset(); plan.setPlan({ goal: '过日子', steps: ['去砍点木头'] });
      const prevB = { get: bridge.get, post: bridge.post };
      body._setBridge({ get: prevB.get, post: async (p, b) => (p === '/mine' ? { success: true, mined: 1 } : prevB.post(p, b)) });
      await startJob([{ tool: 'mine', args: { blockName: 'oak_log' } }], '砍木头', { planStep: plan.current() });
      const pt = T.all().find(t => t.source === 'plan');
      check('★ 闲着推计划动手 → 建一件 source=plan 的任务（指回计划那一步），一串做完不自动算做完', pt && pt.planStep === 0 && pt.planText === '去砍点木头' && !pt.auto && pt.status === 'running' && pt.evidence.length === 1, pt);
      body._setBridge(prevB);
      // 标志达成（plan.autoCheck 新打勾）→ 对应的计划任务收尾
      const closed = T.closePlanTasks(['去砍点木头']);
      check('★ 计划的标志自己达成 → 对应的计划任务一起收尾（按原文对）', closed.length === 1 && T.get(pt.id).status === 'done', T.get(pt.id));
      // /mind 观测（设计第十节）：当前 + 队列 + 最近 10 件结束的 + 统计
      const stats = T.taskStats();
      check('★ 复盘统计：主人交代的数、完成率', stats && typeof stats.interrupted === 'number' && stats.player && 'rate' in stats.player, stats);
      plan._reset();
      try { require('fs').unlinkSync(process.env.MC_PLAN_FILE); } catch (_) {}
      body._setBridge(mockBridge());
      W.lastHeardAt = 0;
    }

    try { require('fs').unlinkSync(tmpT); } catch (_) {}
    process.env.MC_TASKS_FILE = require('path').join(require('os').tmpdir(), `tasks-selftest-${process.pid}.json`);   // 还原成整个自测用的临时文件（删掉 env 会写回真的 memory）
    resetT();
    W.state = W0;
    void n0;
  }

  // 收尾：整个自测用的临时任务文件删掉（原来每跑一次在临时目录留一个 tasks-selftest-<pid>.json）
  { const f = require('path').join(require('os').tmpdir(), `tasks-selftest-${process.pid}.json`); for (const p of [f, f + '.tmp']) { try { require('fs').unlinkSync(p); } catch (_) {} } }
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

module.exports = { selftest, mockBridge };
