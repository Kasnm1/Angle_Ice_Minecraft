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
  groupsFromBody, pickSpecs, activateGroup, activeGroups, kindOf } = require('./tools');
const { startJob, runTool, fmtArgs, toolResultLine, celebrate, learnFromDoing,
  instinctEat, NAME_RE, FAST, matchFast, fastPath } = require('./actions');
const { historyChars, bodyNow, knownStations, shortName, homeStockItems, planFacts, planExtras,
  planLine, buildNow, repetitionHint, PARTICLES, particleHint, idleGate, compactLastNow, think,
  clipText, repairHistory, trimDangling, sleepAndSort, sortMemories, autopilot, holdBody,
  startControl } = require('./think');
const { isBareAffirmative, taskDoneAllowed, isOverAsking, lastProactiveUnanswered, claimState,
  liveFails, unbackedClaim, FACT_CLAIMS, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, HONEST_NUDGE, QUIET_MS,
  ASK_COOLDOWN_MS, DELEGATES, ASKS_BACK, DECIDE_NUDGE, ASKS_WHERE, LOOK_NUDGE, SAY_NUDGE,
  ACTION_NUDGE, RECENT_CLAIM_MS, PLAYER_MOVE_TOOLS, PLAYER_MOVE_RE, TASK_WINDOW_MS, TASK_ASK_RE,
  TASK_DONE_RE } = require('./gates');
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
      check('★ 他 2 分钟前交代过、"箱子理好了" → 放行（回他，不是播报）', taskDoneAllowed('箱子理好了', { now: t, lastTaskAskedAt: t - 120000 }) === true);
      check('同一次交代报过了、再说"好了" → 不放行', taskDoneAllowed('好了', { now: t, lastTaskAskedAt: t - 120000, lastTaskDoneSaidAt: t - 60000 }) === false);
      check('没交代过（只是聊过天）、自己理完箱子 → 不放行（自己的事不播报）', taskDoneAllowed('箱子理好了', { now: t, lastTaskAskedAt: 0 }) === false);
      check('交代是 20 分钟前 → 不放行', taskDoneAllowed('箱子理好了', { now: t, lastTaskAskedAt: t - 1200000 }) === false);
      check('"我去插火把"不是完成 → 不放行', taskDoneAllowed('我去插火把', { now: t, lastTaskAskedAt: t - 60000 }) === false);
      check('做不成也要说一声', taskDoneAllowed('做不了 缺铁', { now: t, lastTaskAskedAt: t - 60000 }) === true);
      check('交代的话认得出：「帮我把箱子理一下」「去砍点木头」「做个铁镐」', ['帮我把箱子理一下', '去砍点木头', '做个铁镐'].every(x => TASK_ASK_RE.test(x)));
      check('闲聊不算交代：「好累」「哈哈哈」「你在干嘛」', !['好累', '哈哈哈', '你在干嘛'].some(x => TASK_ASK_RE.test(x))); T(0); }
    // 2026-09-29 Claude 复核补：实机那句是**下一轮**、而且是在**回他的话**
    check('★ 上一轮 sleep ✗（跨轮记录里）→ 这轮"我睡了"照样拦', !!unbackedClaim('我睡了呀 剛起床', [], [{ tool: 'sleep_in_bed', failed: true, why: '现在不是晚上，睡不了', t: Date.now() - 41000 }]));
    check('放东西：store ✗ 就拦', !!unbackedClaim('东西放进去了', [{ tool: 'store_items', out: { ok: false, error: 'invalid operation' } }]));
    check('做到一半（只有开始）不算完成', unbackedClaim('我做完了', [{ tool: 'craft', out: { ok: true, note: '身体开始做了，做完会告诉你' } }]) === null);
    check('发现 / 危险 不碰（它们不是完成式）', unbackedClaim('看见一个没开过的箱子', []) === null && unbackedClaim('有怪！', []) === null);
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
    check('每个按需组都至少有一条自动激活的路（关键词或身体）', Object.keys(GROUPS).filter(g => g !== 'core').every(g => autoByCue.has(g) || autoByBody.has(g)), Object.keys(GROUPS).filter(g => g !== 'core' && !autoByCue.has(g) && !autoByBody.has(g)));
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

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

module.exports = { selftest, mockBridge };
