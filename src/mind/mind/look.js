// look.js —— 看世界（每轮"想"之前的一眼）。
//
// 一堆 `bridge.get()` 拼成"此刻"：状态、背包、物品账、本能事件、聊天、余光、门、箱子、亮度…
// 看到新东西就 `emit()` 成事件；第一次见到某个人还会 `mem.meet()`。
//
// ⚠️ 拼"长期计划"那一小段（`plan.current()` / 计划做到了 / 摆东西）在这里**整块**保留，
// 方便之后和另一个分支（`feat/campaign-quests`，也在改 mind.js 的长期计划部分）合并。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const { emit, scene } = require('./runtime');
const { tonight, surroundNeeds, pickJoinMood } = require('./scene');
const wiring = require('./wiring');
// 本能：饿到发慌就吃 / "停""跟我来"瞬间反应（正文在 actions.js）
function instinctEat (...a) { return wiring.actions().instinctEat.apply(null, a); }
function fastPath (...a) { return wiring.actions().fastPath.apply(null, a); }

async function look () {
  const safe = p => bridge.get(p, 2000).catch(() => null);
  // 分两档（WorkBuddy 建议 32，Claude 核实：原来每秒 12 个请求打到 bridge，和本能、物理抢同一个事件循环）：
  // 快的每一眼都看（状态、背包、附近、玩家、聊天、增量的箱子记录）；慢的（门、装备、没开过的箱子、亮度）slowLookMs 看一次，中间用上次的
  const slowDue = Date.now() - (W.slowLook?.at || 0) >= CFG.slowLookMs;
  const [st, inv, near, pl, chat, seen, slow, insNow] = await Promise.all([
    safe('/status'), safe('/inventory'), safe('/nearby?radius=16'), safe('/players'), safe('/chatlog?limit=30'),
    safe(`/containers/seen?since=${W.seenSince || 0}`),
    // 「附近看得见的」（她的余光，任务书第 3 条）：跟着慢档一起取 —— 本能层每 5 秒已经在扫了
    // （见 instinct/core.js 的 perceptionTimer），mind 这边看一眼就行，不必每眼都问。
    // 半径 32 和本能层扫描、tryLoot 一致（原来是 24，改了就对不上记忆里的野外箱子）。
    slowDue ? Promise.all([safe('/doors?radius=6'), safe('/equipment'), safe('/chests/unseen?radius=32'), safe('/light'), safe(`/surroundings?radius=32&top=6&needs=${encodeURIComponent(surroundNeeds())}`)]) : null,
    // 本能现在的样子：战斗本能在打的时候，她不该抢着手（见 buildNow 的"【本能】"与 attack 工具）
    safe('/instinct'),
  ]);
  if (slow) W.slowLook = { at: Date.now(), v: slow };
  const [doors, eq, boxes, lit, sur] = W.slowLook?.v || [null, null, null, null, null];
  // 本能（身体闲着时自己做的事）：做成了什么、看见什么没做成 —— 她得知道是自己干的
  const ins = await safe(`/instinct/events?since=${W.instinctSeq ?? 0}`);
  if (ins && Array.isArray(ins.events)) {
    if (W.instinctSeq == null || ins.seq < W.instinctSeq) W.instinctSeq = ins.seq;   // 刚醒 / bridge 重启：不翻旧的
    else {
      for (const e of ins.events) {
        // 房子长大了：家的半径记进记忆（只改半径，家里箱子的记忆不动）
        if (e.kind === 'home_grow' && e.radius) { const hh = mem.getHome(); if (hh && e.radius > hh.radius) { hh.radius = e.radius; mem.touch(); } }
        // 自动整理也会改变箱内存货；只有 bridge 完整验收过，才把布局/空箱写回长期记忆。
        if (e.kind === 'tidy' && e.storage?.completed && Array.isArray(e.storage.boxes)) {
          const { layout, empty } = storagePolicy.layoutFromBoxes(e.storage.boxes);
          mem.setHomeStorage(layout, { empty });
        }
        // 房子的暗处：本能报的坐标记下来，她一调 light_up 就带过去（判据在同一天的 fix-askback-lightup）
        // —— 不然她只知道"家里有暗处"，得自己再找一遍；本能已经数过是哪几格了。
        // torch_ask（家里先问主人要不要插）也带着同样的坐标：他说「要」之后 light_up 才知道照哪插（2026-09-29 Claude 复核补）
        if ((e.kind === 'dark_spot' || e.kind === 'torch_ask') && Array.isArray(e.sample) && e.sample.length) {
          const pts = e.sample.filter(p => p && typeof p.x === 'number').map(p => ({ x: p.x, y: p.y, z: p.z }));
          if (pts.length) W.darkSpots = pts;
        }
        emit(`🫳 ${e.text}`, { cue: `${e.kind} ${e.ore || ''}` });
      }
      W.instinctSeq = ins.seq;
    }
  }
  // 家在哪告诉本能层（收获本能只收家里的地）。一分钟一次，bridge 重启后也能补上
  if (Date.now() - W.homeToldAt > 60000) {
    const h = mem.getHome();
    // 本能层数出来的半径比记忆里大（mind 没醒着时长大的）：跟上
    if (h) {
      W.homeToldAt = Date.now();
      bridge.post('/instinct', { home: {
        center: h.center, radius: h.radius,
        storage: h.storage || {}, emptyBoxes: h.emptyBoxes || [], protected: h.protected || [],
      } })
        .then(r => { if (r?.home?.radius > h.radius) { h.radius = r.home.radius; mem.touch(); } })
        .catch(() => { W.homeToldAt = 0; });
    }
  }
  // 物品账：背包每次进出的原因（捡的 / 放进哪个箱子 / 吃掉 / 用坏…）。bridge 旧版本没有这个端点 → null，走老的前后对比
  const led = await safe(`/inventory/ledger?since=${W.ledgerSeq ?? 0}`);
  if (led && Array.isArray(led.entries)) {
    if (W.ledgerSeq == null) W.ledgerSeq = led.seq;              // 刚醒：之前的账不翻
    else if (led.seq < W.ledgerSeq) W.ledgerSeq = 0;             // bridge 重启过，账从头记了：下一眼从 0 读
    else { W.ledgerNew = led.entries; W.ledgerSeq = led.seq; }
    W.ledgerOk = true;
  } else W.ledgerOk = false;
  // 打开过的箱子：是家里的，就记住里面有什么、各有几个（像人一样，看过就大概记得）
  for (const c of seen?.seen || []) {
    W.seenSince = Math.max(W.seenSince || 0, c.at);
    const [x, y, z] = String(c.key).split(',').map(Number);
    if (mem.inHome({ x, y, z })) mem.noteHomeBox(c);
  }
  if (!W.commands?.known || Date.now() - (W.commands.at || 0) > 30 * 60 * 1000) {
    const c = await safe('/commands');
    if (c) W.commands = { ...c, at: Date.now(), admin: (c.all || []).filter(x => ['give', 'tp', 'teleport', 'gamemode', 'time', 'weather', 'effect', 'summon', 'kill', 'clear', 'enchant', 'xp'].includes(x)) };
  }
  // 地标：看见传送石碑、村庄就记进"记得的地方"（半分钟看一次）
  if (!W.landAt || Date.now() - W.landAt > 30000) {
    W.landAt = Date.now();
    const lm = await safe('/landmarks');
    for (const l of lm?.landmarks || []) {
      const before = mem.places().length;
      mem.notePlace({ kind: l.kind, entry: { x: l.x, y: l.y, z: l.z } });
      if (mem.places().length > before) emit(`📍 记下了一个地方：${l.kind === 'waystone' ? '传送石碑' : '村庄'}（${l.x},${l.y},${l.z}）`, { urgent: false });
    }
  }
  if (!W.projAt || Date.now() - W.projAt > 60000) {
    W.projAt = Date.now(); const pj = await safe('/project/status'); W.projects = pj?.projects || [];
    const ly = await safe('/layout/status'); W.layouts = ly?.layouts || [];
    // 任务书进度（主线做到哪了）：读不到就是 null（不知道），不是"一个都没做"
    const fq = await safe('/ftbq/completed'); W.ftbq = fq?.known ? new Set(fq.completed || []) : null;
  }
  if (!st) { W.state = null; return; }
  W.state = {
    connected: !!st.connected, health: st.health, food: st.food, isDay: st.isDay,
    phase: st.phase || null, time: st.gameTime ?? null, exposure: st.exposure?.kind || null,
    following: /^following (.+)$/.exec(st.currentAction || '')?.[1] || null,
    // ⚠️ currentAction / 载具 / 是否开着界面要显式带出来（codex R-fix4-6）：
    //   groupsFromBody 的"场景自动激活"要能看见"在挖矿""骑着船""开着箱子"这些身体状态，
    //   不能只靠猜关键词。
    currentAction: st.currentAction || null,
    vehicle: st.vehicle ?? null,
    windowOpen: !!st.windowOpen,
    containerOpen: !!st.containerOpen,
    pos: st.position ? { x: Math.round(st.position.x), y: Math.round(st.position.y), z: Math.round(st.position.z) } : null,
    items: inv?.items || [],
    nearby: (near?.entities || []).slice(0, 12),
    players: (pl?.players || []).filter(p => !p.isSelf),
    doors: doors?.doors || [],
    equipment: eq?.equipment || null,
    curios: eq?.curios || null,
    backpack: eq?.backpack || null,
    unseenChests: boxes?.chests || [],
    // 附近看得见的（余光）：桥接已经把同类聚成一条、按"她缺什么 + 没开过的野外箱子"排好了。
    // 读不到就是 null（不是"附近什么都没有"）—— 提示词那边要分开说（任务书：不能只有一个"附近没有"）。
    surroundings: sur?.ok ? { line: sur.line || '', items: sur.items || [], perf: sur.perf || null, at: sur.at || null } : null,
    light: lit?.light || null, dark: !!lit?.dark, torches: lit?.torches ?? null, lastBright: lit?.lastBright || null,
    // 本能层此刻在做什么：战斗本能在打的时候，她不该再伸手（见 combatInstinct / attack 工具）。
    // `readAt` 是这次成功读到的时刻 —— combatGuard 用它判"状态新不新鲜"（codex R-fix4-7）。
    instinct: insNow && insNow.installed !== false ? { combatNow: insNow.combatNow || null, urgent: insNow.urgent || null, running: insNow.running || null, readAt: Date.now() } : null,
  };
  // 天色变了（太阳下山 / 天黑 / 天亮）：说一声，连同今晚的安排。边沿触发，一晚只说一次
  const pev = night.phaseEvent(W.phase, W.state.phase);
  if (pev) {
    const plan = tonight(W.state);
    emit(`${pev.icon} ${pev.text}（时刻 ${W.state.time}）${plan ? `：${plan}` : ''}`, { cue: 'night 天黑 夜里 回家 睡觉', urgent: pev.urgent });
  }
  if (W.state.phase) W.phase = W.state.phase;
  // 长期计划：背包里有了"做成的标志"就自动打勾 → 告诉她，让她想下一步（主人："思考自动更新计划"）
  try {
    const worn = Object.values(W.state.equipment || {}).filter(Boolean).map(name => ({ name, count: 1 }));
    const pc = plan.autoCheck([...(W.state.items || []), ...worn]);
    for (const t of pc.newly) emit(`📋 计划里的「${t}」做到了${plan.current() ? `，下一步：${plan.current().text}` : ''}`, { cue: 'plan 计划', urgent: true });
    if (pc.finished) emit('📋 长期计划全部做完了 —— 想想下一个目标（plan_view 看现在能做什么，plan_set 定新的）', { cue: 'plan 计划', urgent: true });
  } catch (_) {}
  // 视线里冒出没开过的箱子/木桶：马上告诉她（主人：优先级高，看见就过去）
  for (const c of W.state.unseenChests) {
    const k = `chest@${c.at}`;
    if (W.seenChat.has(k)) continue;
    W.seenChat.add(k);
    emit(`👀 看见一个没打开过的${knowledge.label(c.name.includes(':') ? c.name : `minecraft:${c.name}`).replace(/\(.*\)$/, '')}（${c.x},${c.y},${c.z}，${c.distance} 格）`, { cue: 'chest', urgent: false });
  }
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
      // 在记这句话进意识流之前记：现场里的"之前发生的"就是惹他不满的那几件事
      if (review.looksLikeComplaint(text)) review.record({ kind: 'player_complaint', who, text, ...scene() });
      if (fastPath(who, text)) continue;
      W.lastHeardAt = Date.now();
      if (W.lastProactive) W.lastProactive.answered = true;
      emit(`💬 ${who} 说：${text}`, { cue: `${who} ${text}`, names: [who], chat: true });
    } else if (m.position === 'bridge' && /加入|离开|joined|left/.test(m.text)) {
      const who = (m.text.match(/\*\s*(\S+)/) || [])[1];
      // 他上线时她打不打招呼：真的掷一次骰子（主人要的是"像朋友一样随性" —— 多数时候看一眼，有时扣个问号，有时随口一句）
      const mood = /加入|joined/.test(m.text) ? pickJoinMood() : '';
      if (who && who !== CFG.botName) emit(`🚪 ${m.text.replace(/^\*\s*/, '')}${mood}`, { cue: who, names: [who] });
    } else if (m.position === 'system' && new RegExp(CFG.botName).test(m.text) && /died|死|slain|killed|blew|burn|drown/.test(m.text)) {
      review.record({ kind: 'died', text: m.text, ...scene() });
      emit(`☠️ ${m.text}`, { urgent: true });
    }
  }

  // ---- 背包变化（得到/失去了什么）
  const inv2 = new Map();
  for (const i of W.state.items) inv2.set(i.name, (inv2.get(i.name) || 0) + i.count);
  const lab = (k) => knowledge.label(k.includes(':') ? k : `minecraft:${k}`);
  if (W.ledgerOk) {
    // 带原因的账：闲着时直接说；干活时攒到这件事的结果里一起说（不刷屏，也不丢）
    for (const e of W.ledgerNew || []) {
      const line = ledgerLib.render(e, lab);
      if (!line) continue;
      if (W.job) (W.job.inv ||= []).push(line);
      else emit(`🎒 ${line}`, { cue: e.parts.flatMap(p => Object.keys(p.items)).join(' ') });
    }
    W.ledgerNew = null;
  } else if (W.lastInv && !W.job) {   // 老 bridge：只能前后对比。干活时的变化由动作结果报告，不重复
    const gained = []; const lost = [];
    for (const k of new Set([...W.lastInv.keys(), ...inv2.keys()])) {
      const d = (inv2.get(k) || 0) - (W.lastInv.get(k) || 0);
      const nm = knowledge.label(k.includes(':') ? k : `minecraft:${k}`);
      if (d > 0) gained.push(`${nm}×${d}`); else if (d < 0) lost.push(`${nm}×${-d}`);
    }
    if (gained.length) emit(`🎒 背包里多了：${gained.join('、')}`, { cue: gained.join(' ') });
    if (lost.length) emit(`🎒 背包里少了：${lost.join('、')}`, { cue: lost.join(' ') });
  }
  if (W.lastInv && !W.job) {
    for (const k of inv2.keys()) if ((inv2.get(k) || 0) > (W.lastInv.get(k) || 0)) ambition.noteGained(k.includes(':') ? k : `minecraft:${k}`, 'collected');
  }
  W.lastInv = inv2;

  // ---- 掉血
  if (W.lastHp != null && st.health != null && st.health < W.lastHp - 1) {
    const threat = W.state.nearby.filter(e => e.type === 'mob' || e.type === 'hostile').slice(0, 3).map(e => `${e.name}(${e.distance}格)`).join('、');
    emit(`💔 掉血 ${W.lastHp} → ${st.health}${threat ? `，身边有 ${threat}` : ''}`, { urgent: st.health < 10 });
    // 刚跌破 6 才记一次（一直残血不重复记）
    if (st.health <= 6 && W.lastHp > 6) review.record({ kind: 'low_hp', text: `血 ${W.lastHp} → ${st.health}${threat ? `，身边有 ${threat}` : ''}`, ...scene() });
  }
  W.lastHp = st.health;

  // ---- 谁在身边
  const now = new Set(W.state.players.filter(p => p.distance != null && p.distance < 24).map(p => p.username));
  for (const p of now) if (!W.players.has(p)) { mem.meet(p); emit(`👀 看到 ${p} 了`, { cue: p, names: [p] }); }
  W.players = now;

  // ---- 天黑了：每晚提醒一次（闲着、没人正在跟她说话的时候），睡不睡由她
  // 只给老 bridge（没有 phase）兜底 —— 新的走上面的天色事件（night.js，分野外/屋里/矿洞，不等闲着）
  if (st.phase == null && st.isDay === false && !W.nightNoticed && !W.job && Date.now() - (W.lastHeardAt || 0) > 60000 && !st.isSleeping) {
    W.nightNoticed = true;
    emit('🌙 天黑了。今天手上的事忙得差不多的话，该回家睡觉了', { cue: 'bed 床 睡觉 home' });
  }
  if (st.isDay === true) W.nightNoticed = false;

  // ---- 本能：饿到发慌不经过思考
  if (st.food != null && st.food <= CFG.hungerInstinct && !W.job) instinctEat();
}


module.exports = { look };
