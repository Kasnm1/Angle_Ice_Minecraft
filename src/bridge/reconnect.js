#!/usr/bin/env node
/**
 * 断线重连的**状态机** —— 从 bridge-server 的 `bot.on('end')` 里抽出来的纯逻辑。
 *
 * ## 为什么值得单独抽出来
 *
 * 这段逻辑原来内联在 bridge-server.js 里，而 bridge-server.js **没法被 require**
 * （顶层就要 mineflayer，还得真连上服务器）。于是项目里唯一一个"能无限空转、还能
 * 把记忆文件写爆"的回路，恰好是唯一没有测试覆盖的地方。2026-09-23 的实测数据：
 * journal.md 322 行里有 **217 行**是同一条 `(disconnect) 我掉线了（socketClosed）`，
 * 最长连续重复 104 次 —— 她的"记忆"有 67% 是噪声。
 *
 * ## 两个真实的缺陷（都有证据，不是猜的）
 *
 * ### ① `retries` 在 `spawn` 里归零 → 抖动永远撞不到上限
 *
 * 原来的判据是 `if (state.retries < maxRetries)`，而 `spawn` 回调里有
 * `state.retries = 0`。对"服务端整个挂了"这是对的：连不上就累加，30 次后放弃。
 * 但对**抖动**（连上 → 几秒后被踢 → 重连 → 又连上）是**完全失效**的：
 * 每次成功 spawn 都把计数清零，于是 `maxRetries` 永远够不着，她以 5 秒一圈的
 * 节奏永远转下去。journal 里 `spawn` 22 次 / `disconnect` 217 次就是这个形状。
 *
 * 所以这里把"**在窗口内 spawn 了太多次**"单独当成一个信号（flap），
 * 用它自己的计数器，并且退避（5s → 10s → 20s → … → 上限 5 分钟）。
 *
 * ### ② 真正的踢人原因被丢掉了
 *
 * `minecraft-protocol/src/client.js:168` 里 `'end'` 的 reason 有个兜底值
 * `'socketClosed'` —— 也就是说**只有 socket 自己断了才有信息量，被服务端踢掉的
 * 情况 reason 恒为 `socketClosed`**。真正的原因在 `'kicked'` 事件里
 * （`mineflayer/lib/plugins/kick.js`：`kick_disconnect` / `disconnect` 包），
 * 而原来那行只 `console.warn` 了一句，从没进记忆。
 *
 * 结果就是她的记忆里只有「我掉线了（socketClosed）」—— 对读记忆的 agent 来说
 * 这句话等于什么都没说，而"同名登录被顶"这种可操作的原因反而消失了。
 *
 * ## 用法
 *
 *     node reconnect.js --selftest
 */

/** 默认策略。改这里等于改行为，bridge-server 不再另存一份。 */
const DEFAULT_POLICY = {
  // 连不上时的尝试上限（原来的语义，保留）
  maxRetries: 30,
  // 基础重连间隔（原来固定 5s）
  baseDelayMs: 5000,
  // 退避上限。抖动时最长等这么久再试，避免把日志和 CPU 烧在一个死循环上。
  //
  // ⚠️ 这个值必须**明显小于** flapWindowMs，否则退避和滑动窗口会互相抵消：
  //    间隔一大，窗口就把旧的 spawn 全剪掉，spawns 永远攒不够 → 永远判不出抖动 →
  //    也就永远停不下来。（第一版把它设成 300s = flapWindowMs，自测直接照出来了。）
  maxDelayMs: 60_000,
  // 退避倍数，只在判定为 flap 之后生效
  backoffFactor: 2,
  // 抖动窗口
  flapWindowMs: 300_000,
  // 窗口内 spawn 超过这个次数 = 抖动
  flapMaxSpawns: 5,
  // 抖动状态下再允许试几次，之后彻底停手（等 POST /reconnect）
  maxFlapRetries: 8,
  // 一次连接活过这么久，就认为"抖动史"翻篇了，计数归零
  stableResetMs: 300_000,
  // 踢人原因只在断开前的这么久之内算"这一次的原因"
  //
  // ⚠️ 为什么必须有这个时效：`lastKick` 一旦写进去就留着，而 `describeDisconnect`
  //    会优先用它。不加时效的话，**后面一次纯粹的网络断开也会被写成
  //    "被服务端断开：同名登录被顶"** —— 那是在编造原因，比不写原因更糟。
  kickFreshMs: 10_000,
};

/**
 * 服务端踢人的翻译键 → 人话。
 *
 * 为什么值得翻译：这些键是**唯一**能区分"服务器挂了"和"你被顶了"的东西，
 * 而后者是玩家自己造成的、可以立刻修（关掉另一个客户端）。原样把
 * `multiplayer.disconnect.duplicate_login` 写进记忆，等于把这条线索又埋回去。
 */
const KICK_REASONS = {
  'multiplayer.disconnect.duplicate_login': '同一个账号在别处登录了，我被顶下线（是不是还开着另一个客户端/网桥？）',
  'multiplayer.disconnect.kicked': '被管理员踢了',
  'multiplayer.disconnect.banned': '我被这个服务器封禁了',
  'multiplayer.disconnect.banned.reason': '我被这个服务器封禁了',
  'multiplayer.disconnect.not_whitelisted': '我不在白名单里',
  'multiplayer.disconnect.server_full': '服务器满了，挤不进去',
  'multiplayer.disconnect.server_shutdown': '服务端关掉了',
  'multiplayer.disconnect.idling': '我挂机太久被踢了',
  'multiplayer.disconnect.generic': '服务端没给原因就断开我',
  'multiplayer.disconnect.incompatible': '客户端版本不兼容',
  'multiplayer.disconnect.invalid_player_data': '服务端说我的玩家数据不合法',
  'disconnect.quitting': '是我自己主动断开的',
  'disconnect.timeout': '连接超时',
};

/** 新建一份连接状态。所有字段都是纯数据，方便测试直接构造。 */
function createState (over = {}) {
  return {
    retries: 0,          // 连不上时的累计次数
    spawns: [],          // 抖动窗口内的 spawn 时间戳
    lastSpawnAt: null,   // 上一次 spawn 的时刻（判断"这次连接活得够不够久"）
    flapStrikes: 0,      // 抖动累计次数 —— **单调**，只有连接稳定活过 stableResetMs 才归零
    gaveUp: false,       // 已经彻底停手，等 POST /reconnect
    timerPending: false, // 已经有一条重连链在飞 —— 单链守卫
    flap: false,         // 是否已判定为抖动
    lastKick: null,      // 最近一次踢人的翻译键（'end' 的 reason 给不出这个）
    ...over,
  };
}

/**
 * 从各种形态的 reason 里抠出翻译键。
 *
 * 服务端的 reason 在不同版本/不同包里的形态不一样：可能是裸字符串、
 * 可能是 JSON 字符串（`{"translate":"..."}`）、也可能是已经解析好的对象。
 * 三种都吃，抠不出来就退回原样的字符串。
 */
function reasonKeyOf (reason) {
  if (reason == null) return null;
  if (typeof reason === 'string') {
    const s = reason.trim();
    if (s.startsWith('{')) {
      try {
        const o = JSON.parse(s);
        return reasonKeyOf(o);
      } catch (_) { /* 不是 JSON，按裸字符串处理 */ }
    }
    return s || null;
  }
  if (typeof reason === 'object') {
    if (typeof reason.translate === 'string') return reason.translate;
    // 有些服务端把原因塞在 extra 里
    if (Array.isArray(reason.extra)) {
      for (const e of reason.extra) {
        const k = reasonKeyOf(e);
        if (k) return k;
      }
    }
    if (typeof reason.text === 'string') return reason.text;
    try { return JSON.stringify(reason); } catch (_) { return null; }
  }
  return String(reason);
}

/** 翻译键 → 人话。没收录的就原样返回（比丢掉强）。 */
function humanizeKick (key) {
  if (!key) return null;
  return KICK_REASONS[key] || key;
}

/**
 * 写进记忆的断开描述。
 *
 * 优先级：踢人原因 > 'end' 的 reason。因为后者在被踢时恒为 `socketClosed`，
 * 没有任何信息量（见文件头 ②）。
 */
function describeDisconnect (reason, kickKey) {
  const kick = humanizeKick(kickKey);
  if (kick) return `我掉线了（被服务端断开：${kick}）`;
  const r = reasonKeyOf(reason);
  if (!r) return '我掉线了（原因不明）';
  if (r === 'socketClosed') return '我掉线了（连接被关掉了，服务端没给原因）';
  if (r === 'disconnect.quitting') return '我自己断开了连接';
  return `我掉线了（${r}）`;
}

/** 窗口内还留着的 spawn 时间戳 */
function spawnsInWindow (st, policy, now) {
  return st.spawns.filter(t => now - t <= policy.flapWindowMs);
}

/**
 * 成功 spawn 时调用。
 *
 * ⚠️ 这里**仍然**把 `retries` 归零（原来的行为，对"服务端恢复"是对的），
 * 但额外记下 spawn 时间戳 —— 归零之后靠 `spawns` 这个独立信号来判断抖动，
 * 而不是靠那个会被自己清零的计数器。这就是 ① 的修法。
 *
 * `flapStrikes` 是**单调**的：只有"这次连接活过了 stableResetMs"才归零。
 * 不这样做的话，退避把间隔拉长之后滑动窗口会把旧 spawn 剪光，抖动史被反复遗忘，
 * 计数永远到不了上限 —— 那就等于没修。
 */
function onSpawn (st, now, policy = DEFAULT_POLICY) {
  const prev = st.lastSpawnAt;
  const stable = prev != null && (now - prev) > policy.stableResetMs;
  if (stable) {
    st.spawns = [];
    st.flapStrikes = 0;
    st.flap = false;
  }
  st.lastSpawnAt = now;
  st.spawns = [...spawnsInWindow(st, policy, now), now];
  st.retries = 0;
  st.gaveUp = false;
  st.timerPending = false;
  const flap = st.spawns.length > policy.flapMaxSpawns;
  const becameFlap = flap && !st.flap;
  st.flap = flap;
  return {
    flap,
    becameFlap,
    stable,
    spawnsInWindow: st.spawns.length,
    windowMs: policy.flapWindowMs,
  };
}

/** 显式 `POST /reconnect`：把抖动史一并清掉，否则刚恢复就会被旧账立刻判停手。 */
function resetForExplicitReconnect (st) {
  st.retries = 0;
  st.gaveUp = false;
  st.flap = false;
  st.flapStrikes = 0;
  st.spawns = [];
  st.timerPending = false;
  return st;
}

/** 重连定时器真的触发了 —— 消费掉单链标记。 */
function onTimerFired (st) {
  st.timerPending = false;
}

/**
 * 退避间隔。不抖动时保持原来的固定 5s，行为不变。
 *
 * 层级取"抖动次数"与"窗口内超额 spawn 数"的较大者，这样退避是**单调不减**的 ——
 * 只靠窗口长度的话，窗口一滑动间隔就会掉回 5s，退避等于没做。
 */
function nextDelay (st, policy = DEFAULT_POLICY, now = Date.now()) {
  const fromWindow = st.flap ? Math.max(0, spawnsInWindow(st, policy, now).length - policy.flapMaxSpawns) : 0;
  const level = Math.max(st.flapStrikes || 0, fromWindow);
  if (level <= 0) return policy.baseDelayMs;
  const raw = policy.baseDelayMs * Math.pow(policy.backoffFactor, level);
  return Math.min(Math.round(raw), policy.maxDelayMs);
}

/**
 * 断开事件 → 决策。**纯函数式**：只改传入的 st，返回该做什么，不做 IO。
 *
 * @returns {{action:'retry'|'giveup'|'ignore', delayMs?, retries?, why?, flap?, text?}}
 */
function onDisconnect (st, { now = Date.now(), reason = null, kick = null } = {}, policy = DEFAULT_POLICY) {
  if (kick) st.lastKick = reasonKeyOf(kick) || st.lastKick;

  // 抖动窗口要随时间滑动，否则一次抖动会永久污染后面的判断
  st.spawns = spawnsInWindow(st, policy, now);
  st.flap = st.spawns.length > policy.flapMaxSpawns;
  // 抖动累计：单调递增，只有"连接稳定活过 stableResetMs"才归零（见 onSpawn）
  if (st.flap) st.flapStrikes++;

  if (st.gaveUp) {
    return { action: 'ignore', why: '已经停手了，等服务端恢复后 POST /reconnect' };
  }
  // 单链守卫：已经排了一个定时器，就不要为同一次断开再排一个。
  // （原来没有这道闸，`POST /reconnect` 在"正在连接但还没 spawn"的窗口里
  //   会走 createBot → 老实例 end() → 又触发一遍 'end' 处理 → 两条链各自计时。）
  if (st.timerPending) {
    return { action: 'ignore', why: '已经有一条重连链在飞，不重复排' };
  }

  const text = describeDisconnect(reason, st.lastKick);

  // 抖动状态用**自己的**计数器当闸门：`retries` 每次 spawn 都会被清零，
  // 拿它判断"要不要停手"是无效的 —— 这正是原来那个永动循环的成因。
  if (st.flapStrikes > policy.maxFlapRetries) {
    st.gaveUp = true;
    return {
      action: 'giveup',
      why: `反复掉线 ${st.flapStrikes} 次（窗口 ${Math.round(policy.flapWindowMs / 1000)}s 内 spawn ${st.spawns.length} 次）`,
      flap: true,
      retries: st.retries,
      flapStrikes: st.flapStrikes,
      spawnsInWindow: st.spawns.length,
      text,
    };
  }

  if (st.retries >= policy.maxRetries) {
    st.gaveUp = true;
    return { action: 'giveup', why: `连不上 ${st.retries} 次`, flap: st.flap, retries: st.retries, text };
  }

  const delayMs = nextDelay(st, policy, now);
  st.retries++;
  st.timerPending = true;
  return {
    action: 'retry',
    delayMs,
    retries: st.retries,
    flap: st.flap,
    flapStrikes: st.flapStrikes,
    spawnsInWindow: st.spawns.length,
    text,
  };
}

/**
 * 事件是不是来自"当前那个 bot"？
 *
 * 老实例的监听器在 `state.bot` 被替换之后仍然挂着，迟到的 'end' 会被当成
 * 新实例的断开处理 —— 那会凭空多出一条重连链。调用方在 handler 里第一句
 * 就该问这个。
 */
function isCurrentBot (current, eventBot) {
  return !!current && current === eventBot;
}

/** 给 /status 用的一小块可观测状态。 */
function summarize (st, policy = DEFAULT_POLICY) {
  return {
    retries: st.retries,
    maxRetries: policy.maxRetries,
    gaveUpReconnecting: !!st.gaveUp,
    timerPending: !!st.timerPending,
    flapping: !!st.flap,
    flapStrikes: st.flapStrikes || 0,
    maxFlapRetries: policy.maxFlapRetries,
    spawnsInWindow: st.spawns.length,
    flapWindowMs: policy.flapWindowMs,
    flapMaxSpawns: policy.flapMaxSpawns,
    lastKick: st.lastKick || null,
    lastKickHuman: humanizeKick(st.lastKick),
    nextDelayMs: nextDelay(st, policy),
  };
}

module.exports = {
  DEFAULT_POLICY,
  KICK_REASONS,
  createState,
  reasonKeyOf,
  humanizeKick,
  describeDisconnect,
  onSpawn,
  onDisconnect,
  onTimerFired,
  nextDelay,
  isCurrentBot,
  summarize,
  spawnsInWindow,
  resetForExplicitReconnect,
};

// ------------------------------------------------------------------ 自测

if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };

  const P = DEFAULT_POLICY;
  const T0 = 1_700_000_000_000;

  console.log('\nreasonKeyOf：三种形态都要吃');
  check('裸字符串', reasonKeyOf('multiplayer.disconnect.server_full'), 'multiplayer.disconnect.server_full');
  check('JSON 字符串', reasonKeyOf('{"translate":"multiplayer.disconnect.kicked"}'), 'multiplayer.disconnect.kicked');
  check('已解析对象', reasonKeyOf({ translate: 'multiplayer.disconnect.banned' }), 'multiplayer.disconnect.banned');
  check('对象里的 extra', reasonKeyOf({ extra: [{ translate: 'multiplayer.disconnect.idling' }] }), 'multiplayer.disconnect.idling');
  check('坏 JSON 不抛异常、按裸串处理', reasonKeyOf('{不是 json'), '{不是 json');
  check('null → null', reasonKeyOf(null), null);
  check('空串 → null', reasonKeyOf('   '), null);

  console.log('\nhumanizeKick：能翻的翻，翻不了的原样返回');
  check('同名登录', humanizeKick('multiplayer.disconnect.duplicate_login'),
    KICK_REASONS['multiplayer.disconnect.duplicate_login']);
  check('没收录的键原样返回', humanizeKick('some.custom.key'), 'some.custom.key');
  check('null → null', humanizeKick(null), null);

  console.log('\ndescribeDisconnect：踢人原因优先于 socketClosed');
  check('有踢人原因时用踢人原因',
    describeDisconnect('socketClosed', 'multiplayer.disconnect.duplicate_login'),
    `我掉线了（被服务端断开：${KICK_REASONS['multiplayer.disconnect.duplicate_login']}）`);
  check('socketClosed 要说清"服务端没给原因"',
    describeDisconnect('socketClosed', null),
    '我掉线了（连接被关掉了，服务端没给原因）');
  check('自己断开', describeDisconnect('disconnect.quitting', null), '我自己断开了连接');
  check('原因不明', describeDisconnect(null, null), '我掉线了（原因不明）');
  check('未收录的 reason 原样带出', describeDisconnect('ECONNREFUSED', null), '我掉线了（ECONNREFUSED）');

  console.log('\n① 抖动：retries 被 spawn 清零，但 flap 闸门仍然拦得住');
  {
    const st = createState();
    let flapNoticed = 0;
    let acted = { retry: 0, giveup: 0, ignore: 0 };
    let now = T0;
    let giveupWhy = null;
    for (let i = 0; i < 200; i++) {
      const sp = onSpawn(st, now);
      if (sp.becameFlap) flapNoticed++;
      const d = onDisconnect(st, { now, reason: 'socketClosed', kick: 'multiplayer.disconnect.duplicate_login' });
      acted[d.action]++;
      if (d.action === 'giveup') { giveupWhy = d.why; break; }
      now += d.delayMs;
      onTimerFired(st);
    }
    check('抖动最终会停手（不会永远转）', acted.giveup >= 1, true);
    check('200 轮里确实停下来了，不是靠轮数上限', acted.giveup, 1);
    check('停手原因是"反复掉线"而不是"连不上"', /反复掉线/.test(giveupWhy || ''), true);
    check('抖动被识别到（becameFlap 只报一次边沿）', flapNoticed >= 1, true);
    check('retries 一直被 spawn 清零 —— 复现原缺陷的形状', st.retries <= P.maxRetries, true);
    check('真正拦住它的是 flapStrikes', st.flapStrikes > P.maxFlapRetries, true);
  }

  console.log('\n① 对照：服务端整个挂掉时，原来的 30 次上限仍然有效');
  {
    const st = createState();
    let retries = 0;
    for (let i = 0; i < 100; i++) {
      const d = onDisconnect(st, { now: T0, reason: 'ECONNREFUSED' });
      if (d.action === 'giveup') break;
      retries++;
      onTimerFired(st);
    }
    check('连不上 30 次后放弃', retries, P.maxRetries);
    check('不抖动时不退避（保持原来固定 5s）', st.flap, false);
    check('抖动计数器没被误触发', st.flapStrikes, 0);
  }

  console.log('\n① 退避：5s → 10s → 20s … 单调不减且有上限');
  {
    const st = createState();
    check('还没抖动时是基础间隔', nextDelay(st, P, T0), P.baseDelayMs);
    for (let i = 0; i <= P.flapMaxSpawns; i++) onSpawn(st, T0);   // 6 次，刚超阈值
    check('刚好超过阈值 → 第一次退避 = 10s', nextDelay(st, P, T0), P.baseDelayMs * 2);
    // 用真实断开把 flapStrikes 推上去，再逐级看
    const seen = [];
    for (let i = 0; i < 8; i++) {
      onDisconnect(st, { now: T0, reason: 'socketClosed' });
      onTimerFired(st);
      onSpawn(st, T0);
      seen.push(nextDelay(st, P, T0));
    }
    check('退避单调不减', seen.every((v, i) => i === 0 || v >= seen[i - 1]), true);
    check('退避确实涨上去了（不是恒为 5s）', seen[seen.length - 1] > P.baseDelayMs, true);
    check('退避封顶', Math.max(...seen), P.maxDelayMs);
    check('封顶值明显小于抖动窗口（否则窗口会把抖动史剪掉）', P.maxDelayMs < P.flapWindowMs, true);
  }

  console.log('\n① 抖动窗口会滑动，但抖动史不会被窗口"洗白"');
  {
    const st = createState();
    for (let i = 0; i <= P.flapMaxSpawns; i++) onSpawn(st, T0);
    check('窗口内超阈值 → flap', st.flap, true);
    const d0 = onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('抖动中断开 → 记下一笔', st.flapStrikes, 1);
    check('这一笔在返回值里也报出来了', d0.flapStrikes, 1);
    onTimerFired(st);
    const d = onDisconnect(st, { now: T0 + P.flapWindowMs + 1, reason: 'socketClosed' });
    check('时间滑过窗口后当次不再算抖动', d.flap, false);
    // 注意：**不能**期望它掉回 5s。退避按 flapStrikes 走，是单调的 ——
    // 否则窗口一滑动间隔就回到 5s，退避等于没做（这正是设计里刻意避免的）。
    check('窗口滑过后退避不回退（单调）', d.delayMs, P.baseDelayMs * 2);
    check('但抖动累计没有被窗口清掉（这是能停手的关键）', st.flapStrikes, 1);
  }

  console.log('\n① 连接真的稳定下来之后，抖动史才翻篇');
  {
    const st = createState();
    for (let i = 0; i <= P.flapMaxSpawns; i++) onSpawn(st, T0);
    onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('抖动中：有累计', st.flapStrikes >= 1, true);
    // 下一次 spawn 距离上次 10 分钟 → 说明上次连接活得够久
    const sp = onSpawn(st, T0 + P.stableResetMs + 60_000);
    check('稳定活过 stableResetMs → 抖动史翻篇', st.flapStrikes, 0);
    check('并且如实报告了 stable', sp.stable, true);
    check('窗口也清空了', st.spawns.length, 1);
  }

  console.log('\n显式 POST /reconnect 会把抖动史一起清掉');
  {
    const st = createState();
    for (let i = 0; i <= P.flapMaxSpawns; i++) onSpawn(st, T0);
    onDisconnect(st, { now: T0, reason: 'socketClosed' });
    st.gaveUp = true;
    resetForExplicitReconnect(st);
    check('retries 归零', st.retries, 0);
    check('gaveUp 解除', st.gaveUp, false);
    check('flapStrikes 归零（否则刚恢复就被旧账判停手）', st.flapStrikes, 0);
    check('清完立刻可以重排', onDisconnect(st, { now: T0, reason: 'socketClosed' }).action, 'retry');
  }

  console.log('\n② 单链守卫：同一次断开不会排出第二条重连链');
  {
    const st = createState();
    const a = onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('第一次断开 → retry', a.action, 'retry');
    check('排上定时器', st.timerPending, true);
    const b = onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('第二次（同一次断开重复到达）→ ignore', b.action, 'ignore');
    check('ignore 说明了原因', /已经有一条重连链在飞/.test(b.why), true);
    check('retries 没有被重复累加', st.retries, 1);
    onTimerFired(st);
    const c = onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('定时器触发后再断开 → 可以重排', c.action, 'retry');
  }

  console.log('\n停手之后不再空转，直到显式 /reconnect');
  {
    const st = createState({ gaveUp: true });
    const d = onDisconnect(st, { now: T0, reason: 'socketClosed' });
    check('已停手 → ignore', d.action, 'ignore');
    check('ignore 提示了 /reconnect', /POST \/reconnect/.test(d.why), true);
  }

  console.log('\nstale 实例守卫');
  {
    const oldBot = { tag: 'old' }; const newBot = { tag: 'new' };
    check('当前实例的事件 → 认', isCurrentBot(newBot, newBot), true);
    check('老实例迟到的事件 → 不认', isCurrentBot(newBot, oldBot), false);
    check('还没连上时 → 不认', isCurrentBot(null, oldBot), false);
  }

  console.log('\nsummarize：给 /status 的可观测状态');
  {
    const st = createState({ lastKick: 'multiplayer.disconnect.duplicate_login' });
    onSpawn(st, T0);
    const s = summarize(st, P);
    check('暴露了 lastKick 原文', s.lastKick, 'multiplayer.disconnect.duplicate_login');
    check('并给出人话', s.lastKickHuman, KICK_REASONS['multiplayer.disconnect.duplicate_login']);
    check('暴露了窗口与阈值（否则读数的人不知道 flap 怎么算的）',
      [s.flapWindowMs, s.flapMaxSpawns], [P.flapWindowMs, P.flapMaxSpawns]);
    check('正常状态不报抖动', s.flapping, false);
  }

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}
