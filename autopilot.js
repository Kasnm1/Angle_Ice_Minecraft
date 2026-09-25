#!/usr/bin/env node
/**
 * Angel_ICE 的自主行为循环 —— 她的"脑干"。
 *
 * ## 为什么需要这个文件
 *
 * `bridge-server.js` 只提供**手**（move / mine / craft / attack / follow / equip / look /
 * chat）和**眼**（status / nearby / block / inventory / players），但里面**没有任何自主
 * 循环** —— 唯一的定时器是每 30 秒存一次状态快照。也就是说：没人调 API 的时候，她就是
 * 一个站着不动的木头人。她不是在"玩"，是被遥控。
 *
 * 这个进程补上「感知 → 决策 → 动作」的循环，让她真的会自己动、自己反应、自己干活。
 *
 * ## 说话纪律（最重要）
 *
 * 她是**陪玩，不是老师**。默认闭嘴 —— 只在两种情况下开口：
 *   ① 玩家问了（或直接叫她的名字）
 *   ② 真实危险 / 她自己出事了
 *
 * 见 PERSONA.md 的「她是陪玩，不是老师」一节。所有发言都必须走 `speak()`，
 * 它带冷却、去重，以及一道 `looksLikeLecture()` 拦截网。
 *
 * ## 运行
 *
 *     node autopilot.js
 *
 * ## 控制面（默认 127.0.0.1:3002，仅本机）
 *
 *     GET  /autopilot          她在干什么 / 待答问题 / 配置
 *     GET  /autopilot/events   结构化决策留痕（?n=30）
 *     GET  /autopilot/stats    留痕聚合：各动作次数 / 失败率 / 卡死次数
 *     POST /autopilot/task     派活：{"type":"mine","blockName":"iron_ore","count":10}
 *     POST /autopilot/say      替她说话（agent 用）：{"message":"..."}
 *     POST /autopilot/config   运行期调参：{"followMax":8}
 *     POST /autopilot/forget   清掉任务失败计数（{"type":"mine"} 或全部）
 *     POST /autopilot/stop     停下
 *
 * ## 留痕（先能测量，再谈优化）
 *
 * 每个 tick 的决策身份与结果都写进 `memory/events.jsonl`（见 events.js）。
 * 没有它，"她这个决定对不对"永远只能靠感觉 —— 有了它，改动才有前后对比。
 */

const http = require('http');
const events = require('./events');
const reflex = require('./reflex');
const { decide, buildActionMenu, guard, TUNING, DO_NOT_MELEE, backendStatus, ACTION_INSTRUCTIONS, CFG: DCFG } = require('./decision');
// ⚠️ P24 新增的两个判定入口**必须从 decision.js 导入**，不能在 autopilot 里另写一份：
//    「我自己需要什么」和「该用哪套 instructions」都只有一处实现，
//    两边各判一遍正是 P2b（两处各判一遍）与 P18（两种 kind 分类）的教训。
const decision = require('./decision');

// --------------------------------------------------------------------- 配置

const CFG = {
  bridge: process.env.MC_BRIDGE_URL || 'http://127.0.0.1:3001',
  port: parseInt(process.env.MC_AUTOPILOT_PORT || '3002'),

  tickMs: 1500,          // 循环间隔
  actionTimeoutMs: 45000, // 单次动作请求的超时（网桥内部动作上限 30s）

  // 跟随
  // 阈值不在这里另存一份 —— 统一由 decision.js 的 TUNING 提供，
  // 否则菜单构造和 tick 各有一套数字，早晚会漂移成两个不一致的行为。
  followMax: TUNING.followMax,
  followMin: 3,          // 比这近就不动（别贴脸挤人）
  refollowEveryMs: 5000, // 重复下发 follow 的最小间隔（避免抖动）

  // 战斗与自保
  criticalHp: TUNING.criticalHp,
  fightRadius: TUNING.fightRadius,
  dangerRadius: TUNING.dangerRadius,
  fleeDistance: 8,       // 逃跑时拉开的目标距离

  // 安全总开关：false 时连显式的 mine 任务都会被护栏拦下。
  // 玩家说"别拆我东西"的时候用它，比去改代码快。
  allowDig: true,

  // 长动作期间的观察间隔。真人是持续在看的，但我们不必那么密 ——
  // 700ms 已经远快于"怪贴到脸上再反应"所需的时间。
  watchdogMs: 700,

  // ---- 自适应感知（用户要求：「提高对环境的感知速度，尤其挖矿和打怪时」）----------
  //
  // ## 为什么不能简单地把 tickMs 调小
  //
  // 一个 tick 里要打 5 个 HTTP 请求（/status /nearby /players /inventory /chatlog
  // + /scan）。把 tickMs 从 1500 砍到 300，请求量变成 5 倍，网桥的 CPU 会被
  // 感知本身吃掉 —— 结果反而更慢。这是"加感知"最典型的搞砸方式。
  //
  // ## 真正的慢在哪
  //
  // ① `/scan` 要遍历 1536 格（`MAX_SCAN_BLOCK_POSITIONS`），是**最重**的一个，
  //    而它算出来的"身边有哪些方块"在挖矿时**几乎不变**。每次都重算纯属浪费。
  // ② `/players`、`/inventory` 变化很慢，没必要跟危险感知同频。
  // ③ 真正需要**快**的只有两件事：**有没有怪靠近**、**有没有新掉落物**。
  //
  // ## 方案：把感知拆成「快环」和「慢环」
  //
  // · **快环**（`/status` + `/nearby`）：危险与掉落物，跟着 `tickMs` 走，可以很密。
  // · **慢环**（`/scan` `/players` `/inventory` `/chatlog`）：按各自的 TTL 缓存，
  //   到点才重取。挖矿时的方块分布、背包内容都不需要每 700ms 重新问一遍。
  //
  // 这样在**不增加网桥负载**的前提下，把危险感知的刷新率提高一个数量级。
  perceive: {
    // 快环的最小间隔。0 = 每个 tick 都刷（tickMs 已经足够小）。
    fastMs: parseInt(process.env.MC_PERCEIVE_FAST_MS || '0'),
    // 慢环各自的 TTL（毫秒）。挖矿时方块分布很稳，3 秒重扫一次足够。
    scanTtlMs: parseInt(process.env.MC_PERCEIVE_SCAN_TTL_MS || '3000'),
    playersTtlMs: parseInt(process.env.MC_PERCEIVE_PLAYERS_TTL_MS || '1000'),
    inventoryTtlMs: parseInt(process.env.MC_PERCEIVE_INV_TTL_MS || '800'),
    chatTtlMs: parseInt(process.env.MC_PERCEIVE_CHAT_TTL_MS || '0'), // 聊天不缓存：这就是"处理消息不及时"的病根
    // 高频模式的持续时长（被打断/有威胁后维持多久的紧密感知）
    alertMs: parseInt(process.env.MC_PERCEIVE_ALERT_MS || '15000'),
  },

  // ---- 分档心跳（stress-aware tick rate）-------------------------------------
  //
  // `tickMs` 从"一个固定值"变成"**基础值**"，实际间隔由当前处境决定：
  //
  //   safe   —— 没事干 / 只是待机          → base × idleFactor（可以更慢，省资源）
  //   normal —— 常规（走路、看着玩家）      → base
  //   work   —— 挖矿 / 采集 / 建造中        → base × workFactor（更快：要看掉落物）
  //   combat —— 附近有敌对生物 / 血量告急   → base × combatFactor（最快：这是保命）
  //
  // 为什么 work 也要快：P1 那个 bug（挖完就走没捡）本质上是**感知跟不上动作**——
  // 她挖得比看得快，于是"挖到了但不知道"。
  tickProfile: {
    idleFactor: 2.0,    // 待机时 1500 → 3000ms，把 CPU 让给真正需要的地方
    workFactor: 0.5,    // 挖矿时 1500 → 750ms
    combatFactor: 0.3,  // 战斗时 1500 → 450ms
    minMs: 250,         // 再快没有意义（网桥端一个 /nearby 往返就要几十毫秒）
    maxMs: 5000,        // 待机上限，别让它睡太久以致叫不醒
  },

  // 耳朵（独立听聊天）的轮询间隔。
  // 为什么需要它：chatlog 是在 tick 开头读的，而 tick 会被 `await perform()`
  // 阻塞最长 45 秒（挖矿/赶路都是长动作）—— 于是"她在干活"就等于"她听不见你说话"。
  // 玩家能直接感受到这个延迟，所以"听"必须挪出 tick。2s 是够用的：聊天不是实时对抗。
  earsMs: parseInt(process.env.MC_EARS_MS || '2000'),

  // 同一个任务连续失败多少次就不再重试。
  // 这是长程智能体最常见的死法之一：卡在一个永远做不到的目标上无限循环
  // （论文里叫 budget overrun / infinite loop）。有上限才有"承认做不到"的能力。
  // 注意：被看门狗打断**不计入**失败 —— 那是先保命，不是任务本身做不到。
  maxTaskFailures: parseInt(process.env.MC_MAX_TASK_FAILURES || '3'),
  // 所有非成功尝试的总上限（含被打断）。比 maxTaskFailures 宽得多 ——
  // 它只负责兜住"反复被打断"这种既不是失败、又确实在原地打转的情况。
  maxTaskAttempts: parseInt(process.env.MC_MAX_TASK_ATTEMPTS || '12'),

  // ⚠️ P31：自主动作的失败宽限次数。前 N 次失败**不触发退避**（当作瞬时故障），
  //    第 N+1 次起才开始退避，且时长指数增长、封顶 90 秒（见 noteSelfFailure）。
  //
  //    为什么"宽限"是必须的：地面上的方块会消失、网桥会偶发抖动、目标可能
  //    刚好被别的玩家挖走 —— 这些都不该改变她的行为倾向。只有**连续**失败
  //    才说明"这条路现在真的走不通"。
  selfFailGrace: parseInt(process.env.MC_SELF_FAIL_GRACE || '2'),

  // 卡死检测：她"想走"但位置几乎不动。以 tick 为单位。
  // 14 tick × 1.5s ≈ 21 秒没挪动 0.1 格 → 判定卡住，清掉寻路让它重新规划。
  // 真人被墙角卡住也会换个方向绕，而不是一直顶着墙走。
  stuckTicks: parseInt(process.env.MC_STUCK_TICKS || '14'),
  stuckMinDelta: 0.1,

  // 说话
  speakCooldownMs: 25000, // 两次主动发言的最小间隔
  answerChat: true,       // 被点名/被提问时是否应答
  allowTpa: false,        // 是否允许用 /tpa 找玩家（默认关：要对方 /tpaccept，容易刷屏）

  // 空闲
  idleBehavior: 'stay',   // stay | wander

  // ---- 反射层（reflex.js）----------------------------------------------------
  // 反射**不走大脑**：命中就短路本次 tick，不构造菜单、不问后端。
  // 上面 tickMs / actionTimeoutMs 那套延迟对它不适用 —— 这是它的全部意义。
  reflex: process.env.MC_REFLEX !== 'false',

  // ---- 聊天对行为的**影响方式**（不打断正在做的事）------------------------------
  // 用户明确要求：「不打断工作，只是改变后续行为」。
  //
  // 所以这里做的**不是** Mindcraft 那种 `requestInterrupt()`（那会 stopDigging +
  // stopPathfinding，正在挖的矿直接废掉），而是：
  //   1. 记下来（pendingQuestions 已经在做）
  //   2. 给"当前的活"设一个**收尾理由**，让它在下一次自然停顿点结束
  //   3. 下一个 tick 起，聊天相关的话题进入决策 —— 也就是"改变后续行为"
  //
  // 具体形式：玩家说话后的一段时间里，task 的优先级被压低、approach/follow 被抬高，
  // 也就是"她会倾向于先过来看看你，但手头这把矿先挖完"。
  chatInfluenceMs: parseInt(process.env.MC_CHAT_INFLUENCE_MS || '60000'),
  // 说话后在多少个 tick 内不再接新 task（让"人"优先于"活"）
  chatBlocksNewTaskTicks: parseInt(process.env.MC_CHAT_BLOCK_TASK_TICKS || '3'),
};

// 认得出的敌对生物。这个整合包模组怪很多，不在表里的会被当成中立 —— 宁可漏判不要误打。
const HOSTILE = new Set([
  'skeleton', 'zombie', 'spider', 'creeper', 'witch', 'enderman', 'husk', 'stray',
  'drowned', 'phantom', 'pillager', 'vindicator', 'ravager', 'slime', 'magma_cube',
  'blaze', 'ghast', 'wither_skeleton', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'shulker', 'vex', 'evoker',
  'illusioner', 'wither', 'ender_dragon', 'zombie_villager', 'cave_spider',
]);

// 会自爆的：不近战。这条知识现在住在 decision.js 的菜单构造里
// （苦力怕贴脸时"近战"根本不出现在菜单中，而不是出现在菜单里再被打低分）。

// 像"讲课"的措辞。没被问就发这些，一律拦下 —— 这是上一轮踩过的坑，用代码堵住。
// 注意：被问之后的回答走 speak(..., {force:true})，不受这里限制。
// 这里的判据偏保守（宁可误拦），因为"没人问的攻略"本身就是错的。
const LECTURE_PATTERNS = [
  /任务书先看/, /第一步是/, /你应该/, /建议你/, /流程是/,
  /这个包是.*版/, /整合包.*(介绍|特色)/, /推进\s*Boss\s*线/,
  // 键位讲解的各种写法：按 X 键 / 按 X+右键 / 按住 ~ / 右键可以…
  /按\s*(住)?\s*[A-Za-z0-9~]+\s*([+＋]\s*)?(右键|左键|键)/,
  /(右键|左键|滚轮)\s*(可以|就能|就能|能|即可)/,
  // 机制名词 —— 玩家没问就主动抛这些，基本就是在念设定
  /(连锁挖掘|查来源|查用途|开商店|打开商店|开地图|作物图鉴|次元之胃|七咒之戒)/,
];

// ----------------------------------------------------------------- 运行时状态

// 网桥的聊天环形缓冲区在重启后会整段重放。`seenChat` 是进程内状态，
// 重启即失效，于是几分钟前的旧消息会被当成"刚收到的提问"再记一遍 ——
// 真正的风险是重复回答一条早就答过的提问。
// 启动前超过这个宽限期的消息仍记录下来给 agent 看，但标记 stale 且不自动应答。
const STALE_GRACE_MS = 5000;

const S = {
  running: true,
  startedAt: Date.now(),
  action: 'starting',
  tick: 0,
  lastSpeak: 0,
  said: new Set(),
  lastSeenPlayer: null,   // { name, x, y, z, t }
  // ⚠️ P24：`retreat`（低血养伤）要回的地方。与 `lastSeenPlayer` 的区别是
  //    **它带"安全"语义** —— 只在没有贴身威胁时刷新（见 tick 里的更新处）。
  //    把两者分开而不是共用一个：它们的失效条件不同，
  //    "最后一次看到玩家"可能是在被僵尸追着跑的路上，那不是安全点。
  lastSafeSpot: null,     // { x, y, z, t }
  lastFollowAt: 0,
  task: null,
  taskResult: null,
  taskFailures: new Map(),  // 任务签名 → 连续失败次数（成功即清零）
  // ⚠️⚠️ P31：**自主动作**的失败退避表。与 `taskFailures` 是**两个独立的东西**，
  //    不能合并 —— `taskFailures` 管的是"玩家派的活"，失败到头会 `gaveUp` 并
  //    直接清掉 `S.task`；而自主动作没有"放弃"这个概念（需求还在，就得接着试）。
  //
  //    为什么必须有它（P31 的第二层锁死）：
  //      上面修了 `shelter` 的进入条件之后，"夜里 + 空背包" 时会去 `gather`。
  //      但如果 `gather` **也**失败（周围真没可采的 / 网桥报错 / 挖了但没进背包），
  //      `needMaterials` 依然为 true → 菜单依然只剩 `gather` → 依然无限空转。
  //      我只是把死循环从 shelter 搬到了 gather 上，**问题没解决，只是换了个人**。
  //
  //    所以需要一个"同一个动作连续失败 N 次后，暂时不让它进菜单"的机制。
  //    关键是它必须**自我衰减**（退避有时限），否则一次网络抖动就会让她
  //    永久不再尝试采集 —— 那是"死循环"的另一个极端，同样不是我们想要的。
  //
  //    结构：action id → { failures, until }
  selfFailures: new Map(),  // 动作名 → { failures:number, until:number }
  lastDecision: null,     // 最近一次决策（动作 / 后端 / 置信度），用于复盘
  lastReflex: null,       // 最近一次反射命中（{ id, name, reason }），证明反射层真的在跑
  lastScan: null,         // 最近一次主动扫描（{ at, standing, blocks }），供"旁边有什么"类提问取真材料
  lastStuck: null,        // 最近一次卡死（{ detail, at }），供 agent 判断要不要说话
  // ★ P42：最近一次自救尝试的**完整留痕**（试了哪几级、每级的结果）。
  //   为什么留：自救是"会动世界"的动作（可能临时放行 canDig 或挖方块），
  //   必须事后可核对"她到底做了什么"。**P40 的教训就是留痕救了那一轮。**
  lastSelfUnstick: null,
  pendingQuestions: [],   // 玩家问的问题（autopilot 不会答，留给 agent）
  // ---- 聊天对后续行为的影响（**不打断正在做的事**）----------------------------
  // 用户明确要求：「不打断工作，只是改变后续行为」。
  // 所以这里记的不是"要被打断"，而是一个**会自然衰减的注意力偏移**：
  // 玩家刚说过话的一段时间里，她倾向于把手头的活收尾、先过来看看人。
  //
  // ⚠️ 与 Mindcraft 的 `self_prompter.stopLoop()` 是**相反**的做法 ——
  //    那会在玩家一发言时直接停掉正在挖的矿（`stopDigging`），矿白挖。
  //    我们只改权重，让"跟人"在下一个决策点自然胜出。
  lastAddressedAt: null,  // 最近一次"在跟她说话"的时间戳（Date.now()）
  lastAddressedText: null,
  // ---- 自适应感知（见 CFG.perceive / CFG.tickProfile）--------------------------
  // 这三项**必须暴露**：不然"她到底跑多快"只能靠猜，
  // 而"感知慢"这类投诉最需要的就是一个能看到的数字。
  tickDelay: null,        // 最近一次分档结果 { ms, mode, factor }
  lastAlertAt: null,      // 最近一次处于危险中（用于威胁消退后保持警觉）
  perceiveHits: 0,        // 慢环缓存命中数（省下的请求量，可直接换算成"感知提速倍数"）
  perceiveMisses: 0,
  seenChat: new Set(),
  // 耳朵回路的可观测计数 —— 不记就没法验证"她真的在长动作期间也听得见"
  earsPolls: 0,           // 尝试次数（不管成没成）—— 证明回路活着
  earsLastPollAt: null,
  earsErrors: 0,          // 连续失败次数（成功即清零）—— 说明能不能真读到
  earsLastError: null,
  earsHeard: 0,           // 通过耳朵回路听到的**玩家**消息数（不含她自己说的）
  deaths: 0,
  lastHp: null,
  log: [],
};

function log (msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  S.log.push(line);
  if (S.log.length > 200) S.log.shift();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP 客户端

async function call (method, path, body, timeoutMs) {
  const res = await fetch(CFG.bridge + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 8000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // ⚠️⚠️⚠️ 2026-09-25（P44 架构修复）：这里原来是
  //     `if (!res.ok || data.success === false) throw new Error(...)`。
  //
  //   网桥以前**无条件**贴 `success: true`，所以 `success === false` 只有一个来源：
  //   `catch` 分支的 `{ success:false, error }` —— 那是**真的异常**，该抛。
  //   现在网桥多了一条合法路径：handler 显式 `ok: false` 时也返回 `success: false`
  //   （表示"动作没在世界里生效"）。**那不是异常**，是正常结果，必须交回给
  //   各个 case 自己判据（它们都读 `mined` / `placed` / `picked` / `escaped`）。
  //
  //   所以判据收紧成：**只有真的带 error 的 500 才算抛**。
  //   否则 `/mine` 挖不动时 autopilot 会抛异常 → 落到 `catch` → 当成"网桥挂了"
  //   去重连，而其实只是"这次没挖动"。那正是 P44 要根治的那类误读。
  if (!res.ok || (data.success === false && data.error)) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

const get = (p, ms) => call('GET', p, null, ms);
const post = (p, b, ms) => call('POST', p, b, ms);

// ------------------------------------------------------------------ 说话纪律

/** 这句话是不是在"讲课"？ */
function looksLikeLecture (text) {
  return LECTURE_PATTERNS.some(re => re.test(text));
}

// 需要挂看门狗的长动作。短动作（say / follow）是瞬时的，不需要。
const LONG_ACTIONS = new Set(['mine', 'collect', 'craft', 'goto', 'place', 'give']);

// 会让她"位移"的动作 —— 卡死检测只在这些动作上生效。
// 待命时站着不动是正常的，不该被误判成卡住。
const MOVING_ACTIONS = new Set(['follow', 'goto', 'mine', 'collect', 'place', 'give']);

// ⚠️⚠️ P31：**自主动作** —— 她为自己做的事（P24 引入的那五类）。
//    这些动作才参与 `selfFailures` 退避表：
//      · 它们有"需求驱动"的性质（饿了才 forage、缺砖才 gather），所以
//        "同一个需求下反复失败"是明确的自锁信号；
//      · 而 `explore`/`idle` 是**无状态**的瞬时动作，失败也没有副作用，
//        退避它们只会让她变呆（P31 教训：不要为了防循环而制造另一种停滞）。
//
//    `retreat`/`forage` 也在这里 —— 但它们的"失败"通常意味着"这一带真的没辙"，
//    退避掉比反复扑空好。它们各自的兜底路径（如 forage 里有吃的就直接吃）由
//    `perform` 内部处理，不依赖这里。
//
//    ⚠️ P32：**`pickup` 必须在这里。** 它是最容易死循环的动作之一 ——
//       掉落物够不着时，她会反复"成功地"走过去而一件拿不到。修好谎报之后
//       （`/pickup` 返回真的 `picked`、这里如实报失败），退避是唯一能让她
//       **放弃那件够不着的东西、去干别的**的机制。
const SELF_ACTIONS = new Set(['gather', 'hunt', 'forage', 'shelter', 'retreat', 'pickup']);

/**
 * 任务的"身份"。用来统计"同一个任务连续失败了几次"。
 * 故意把参数拼进去 —— 挖铁矿石失败 3 次，和挖木头失败 3 次，是两件事。
 */
function taskSig (task) {
  if (!task) return '';
  return JSON.stringify([
    task.type,
    task.blockName || task.itemName || '',
    task.count ?? '',
    task.x ?? '', task.y ?? '', task.z ?? '',
    task.playerName || '',
  ]);
}

/**
 * 卡死判定（纯函数，方便离线自测）。
 *
 * 判据来自执行层工程的通用做法：**有前进意图，但位移极小**。
 * 只看"没动"是不够的 —— 待命时本来就不动。所以必须配合"当前动作是想移动的"。
 *
 * @param {{x,y,z}} prev  上一采样点（null 表示刚开始采样）
 * @param {{x,y,z}} cur   当前点
 * @param {number} ticks  已经连续没动的 tick 数（不含本次）
 * @param {number} need   判定阈值
 * @param {number} minDelta 视为"动了"的最小位移
 * @returns {{stuck:boolean, ticks:number, moved:boolean}}
 */
function isStuck (prev, cur, ticks, need, minDelta) {
  if (!cur || cur.x == null) return { stuck: false, ticks: 0, moved: true };
  if (!prev) return { stuck: false, ticks: 0, moved: true };   // 第一次采样，先记基准
  const d = Math.hypot((cur.x ?? 0) - prev.x, (cur.z ?? 0) - prev.z);
  const moved = d >= minDelta;
  const next = moved ? 0 : ticks + 1;
  return { stuck: next >= need, ticks: next, moved };
}

// `node autopilot.js --selftest` —— 离线自测，不连网桥、不发请求。
// 覆盖两套最容易写错的规则：讲课拦截、威胁决策。改完正则或阈值应该跑一下。
if (process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = got === expect;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  };

  console.log('\n讲课拦截 —— 没人问就不许讲');
  const lectureCases = [
    ['这个包是 2.7.1 版的，任务书先看【新手礼包】', true],
    ['任务书先看【新手礼包】嘛～', true],
    ['记得按 ~ 可以连锁挖掘哦', true],
    ['建议你吃个金苹果', true],
    ['按 O 键可以打开商店', true],
    ['本包推进 Boss 线靠制作料理', true],
    ['按 X+右键可以抱起生物', true],
    ['第一步是领新手小屋', true],
    ['来啦～', false],
    ['诶？我在呀～', false],
    ['呜…我血不多了，先躲一下下', false],
    ['我也去我也去！', false],
    ['诶…这个我好像做不到（No path found）', false],
    ['等我一下，我这就过去～', false],
  ];
  for (const [text, expect] of lectureCases) {
    const got = looksLikeLecture(text);
    check(`期望${expect ? '拦下' : '放行'} / 实际${got ? '拦下' : '放行'}   ${text}`, got, expect);
  }

  console.log('\n看门狗 —— 长动作期间要不要打断（真人挖矿时余光一直在扫）');
  const at = (name, distance) => ({ name, distance });
  const irq = (hp, threat) => {
    const r = shouldInterrupt(hp, threat);
    return r ? r.kind : null;
  };
  check('满血、无怪 → 不打断', irq(20, null), null);
  check('满血、僵尸 12 格 → 不打断', irq(20, at('zombie', 12)), null);
  check('满血、僵尸 6 格 → 不打断（走路时旁边有怪是常态）', irq(20, at('zombie', 6)), null);
  check('满血、僵尸 3 格 → 打断（threat）', irq(20, at('zombie', 3)), 'threat');
  check('满血、苦力怕 6 格 → 打断（自爆生物进危险圈就停）', irq(20, at('creeper', 6)), 'threat');
  check('满血、苦力怕 2 格 → 打断（threat）', irq(20, at('creeper', 2)), 'threat');
  check('满血、苦力怕 9 格 → 不打断（还没进圈）', irq(20, at('creeper', 9)), null);
  check('残血 5、无怪 → 打断（hp）', irq(5, null), 'hp');
  check('残血 5、僵尸 12 格 → 打断（hp 优先）', irq(5, at('zombie', 12)), 'hp');
  check('血量未知 → 不因血量打断', irq(null, null), null);

  console.log('\n卡死检测 —— "想走但没动" 才算卡住');
  // 辅助：模拟连续采样，返回第一次判定卡住的 tick 序号（0 = 一直没卡）
  const simStuck = (path, need = 3, minDelta = 0.1) => {
    let prev = null; let ticks = 0;
    for (let i = 0; i < path.length; i++) {
      const r = isStuck(prev, path[i], ticks, need, minDelta);
      ticks = r.ticks;
      prev = path[i];
      if (r.stuck) return i;
    }
    return 0;
  };
  check('第一次采样不判卡（先记基准）', isStuck(null, { x: 1, z: 1 }, 0, 3, 0.1).stuck, false);
  check('原地不动 3 次 → 卡住', simStuck([{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }]), 3);
  check('每步都在走 → 永不卡', simStuck([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]), 0);
  check('轻微抖动 0.05 格不算"走了"', simStuck([{ x: 0, z: 0 }, { x: 0.05, z: 0 }, { x: 0.05, z: 0 }, { x: 0.05, z: 0 }]), 3);
  check('走了一下就重置计数', isStuck({ x: 0, z: 0 }, { x: 0.5, z: 0 }, 2, 3, 0.1).ticks, 0);
  check('坐标未知（掉线）不判卡', isStuck({ x: 0, z: 0 }, null, 5, 3, 0.1).stuck, false);

  console.log('\n任务身份 —— 用来数"同一个任务连续失败了几次"');
  check('同类型不同目标算两个任务',
    taskSig({ type: 'mine', blockName: 'iron_ore' }) === taskSig({ type: 'mine', blockName: 'oak_log' }), false);
  check('完全相同的任务签名一致',
    taskSig({ type: 'place', itemName: 'white_wool', x: 1, y: 2, z: 3 }) === taskSig({ type: 'place', itemName: 'white_wool', x: 1, y: 2, z: 3 }), true);
  check('坐标不同则不同',
    taskSig({ type: 'place', itemName: 'white_wool', x: 1, y: 2, z: 3 }) === taskSig({ type: 'place', itemName: 'white_wool', x: 1, y: 2, z: 4 }), false);
  check('空任务不炸', taskSig(null), '');

  console.log('\n重试上限 —— 防止在"做不到"的目标上无限循环');
  // 这是本轮新增逻辑里风险最高的一段（它决定她会不会卡死在一个永远做不到的目标上），
  // 而它在离线状态下根本跑不到（tick 会在决策之前就返回），所以必须在这里离线验证。
  const T1 = { type: 'mine', blockName: 'iron_ore', count: 3 };

  S.taskFailures.clear();
  check('还没试过 → 不拦', taskExhausted(T1), null);
  noteTaskAttempt(T1, { failed: true });
  check('失败 1 次 → 还不拦', taskExhausted(T1), null);
  noteTaskAttempt(T1, { failed: true });
  check('失败 2 次 → 还不拦', taskExhausted(T1), null);
  noteTaskAttempt(T1, { failed: true });
  check(`失败 ${CFG.maxTaskFailures} 次（达到上限）→ 拦下`, typeof taskExhausted(T1), 'string');
  check('拦下时说清了是"失败"', /失败/.test(taskExhausted(T1)), true);

  S.taskFailures.clear();
  noteTaskAttempt(T1, { failed: true });
  noteTaskAttempt(T1, { failed: true });
  noteTaskAttempt(T1, { failed: true });
  check('挖铁矿失败 3 次，不影响挖木头（各自计数）',
    taskExhausted({ type: 'mine', blockName: 'oak_log', count: 3 }), null);
  check('挖铁矿本身仍被拦', typeof taskExhausted(T1), 'string');

  S.taskFailures.clear();
  noteTaskAttempt(T1, { failed: true });
  noteTaskAttempt(T1, { failed: true });
  clearTaskRecord(T1);
  check('成功一次就把计数清零', taskExhausted(T1), null);

  S.taskFailures.clear();
  for (let i = 0; i < CFG.maxTaskAttempts - 1; i++) noteTaskAttempt(T1, { failed: false });
  check(`被打断 ${CFG.maxTaskAttempts - 1} 次 → 还没到 attempts 上限`, taskExhausted(T1), null);
  noteTaskAttempt(T1, { failed: false });
  check(`被打断 ${CFG.maxTaskAttempts} 次 → attempts 上限兜住`, /尝试/.test(taskExhausted(T1) || ''), true);
  check('被反复打断时报的是"尝试"而不是"失败"（性质不同）', /尝试/.test(taskExhausted(T1)), true);

  S.taskFailures.clear();
  check('计数是"连续"的：清空后立刻可再试', taskExhausted(T1), null);

  console.log('\n耳朵回路 —— "听"不能被"行动"堵住');
  // 背景：chatlog 是在 tick 开头读的，而 tick 会被 `await perform()` 阻塞最长
  // actionTimeoutMs（45s，挖矿/赶路都是长动作）。不把"听"挪出去，就等于
  // "她在干活时听不见你说话"。这里验证两件离线可验证的事：
  //   ① watchChat 是幂等的 —— tick 和耳朵都调它，靠 seenChat 去重，所以不会重复应答
  //   ② 耳朵间隔远小于最长动作时长 —— 否则挪出去也没用
  // 注意：耳朵回路本身是异步 I/O 循环，离线跑不起来，这里只锁它的**契约**。
  S.seenChat.clear();
  const chatMsg = (t, text) => ({ t, position: 'chat', text });
  const m1 = [chatMsg(1000, '<Ka_sum1> 你在干嘛')];
  check('第一次听到 → 记 1 条新消息', watchChat(m1), 1);
  check('同样的话再听一次 → 0 条（幂等：tick 和耳朵都调它才安全）', watchChat(m1), 0);
  check('追加的新消息仍会被听到', watchChat([...m1, chatMsg(2000, '<Ka_sum1> 来这边')]), 1);
  check('非 chat 位置的不算（系统消息不当作玩家说话）',
    watchChat([{ t: 3000, position: 'system', text: '<Ka_sum1> 你' }]), 0);
  check('她自己的话不计入 earsHeard（否则指标会把"她说话"当成"听到玩家说话"）',
    watchChat([chatMsg(4000, '<Angel_ICE> 诶？我在呀～')]), 0);
  check('耳朵回路存在且是可调用的异步函数', typeof earsLoop, 'function');
  check('耳朵间隔是正数', CFG.earsMs > 0, true);
  check('耳朵间隔远小于最长动作时长（否则挪出 tick 也没意义）',
    CFG.actionTimeoutMs / CFG.earsMs >= 10, true);

  console.log('\n自适应感知 —— "提高感知速度"必须可验证');
  // 背景（field-log P5 的教训）："她反应慢"这类投诉最难修的地方在于
  // **它没有可观测的数字**。这一段把"快了多少"锁成断言。
  const P0 = { st: { health: 20 }, threat: null, action: 'idle' };

  // ① 待机要**慢**：省下的资源才能还给挖矿和战斗
  const idle = pickTickDelay(P0);
  check('待机 → idle 档', idle.mode, 'idle');
  check('待机的心跳比基准慢（省资源）', idle.ms > CFG.tickMs, true);

  // ② 挖矿要**快** —— 这是 P1（挖完不知道捡到没）在感知层的对应修复
  const work = pickTickDelay({ st: { health: 20 }, threat: null, action: 'mine' });
  check('挖矿 → work 档', work.mode, 'work');
  check('挖矿的心跳比基准快', work.ms < CFG.tickMs, true);
  const collect = pickTickDelay({ st: { health: 20 }, threat: null, action: 'collect' });
  const pickup = pickTickDelay({ st: { health: 20 }, threat: null, action: 'pickup' });
  check('collect 也算 work', collect.mode, 'work');
  check('pickup 也算 work', pickup.mode, 'work');

  // ③ 战斗要**最快** —— 这是保命
  const combat = pickTickDelay({ st: { health: 20 }, threat: { name: 'zombie', distance: 4 }, action: 'mine' });
  check('有怪贴脸 → combat 档', combat.mode, 'combat');
  check('战斗的心跳比挖矿还快', combat.ms < work.ms, true);
  const lowHp = pickTickDelay({ st: { health: 5 }, threat: null, action: 'idle' });
  check('血量告急也进 combat 档（不只看有没有怪）', lowHp.mode, 'combat');

  // ④ 威胁刚走别立刻松懈：怪可能还在视野外，血也没回上来
  S.lastAlertAt = Date.now();
  const after = pickTickDelay({ st: { health: 20 }, threat: null, action: 'idle' });
  check('威胁刚消退 → alert 档（不立刻回到 idle）', after.mode, 'alert');
  S.lastAlertAt = Date.now() - CFG.perceive.alertMs - 1000;
  check('超过 alertMs 后才真正松懈', pickTickDelay(P0).mode, 'idle');
  S.lastAlertAt = null;

  // ⑤ 上下限：再快没意义（一个 /nearby 往返就要几十毫秒），再慢会叫不醒
  check('心跳有下限', pickTickDelay({ st: { health: 1 }, threat: { distance: 1 }, action: 'mine' }).ms
    >= CFG.tickProfile.minMs, true);
  check('心跳有上限', pickTickDelay(P0).ms <= CFG.tickProfile.maxMs, true);

  // ⑥ 慢环缓存：这是"不增加网桥负载的前提下提速"的关键
  //    聊天**不缓存** —— "处理消息不及时"就是聊天被拖住造成的，给它加缓存等于把病再治一遍
  check('聊天不缓存（ttl=0，这是"处理消息不及时"的病根）', CFG.perceive.chatTtlMs, 0);
  check('/scan 有缓存（它要遍历 1536 格，是最重的一个）', CFG.perceive.scanTtlMs > 0, true);
  check('背包缓存比 scan 短（背包变化比地形快）',
    CFG.perceive.inventoryTtlMs < CFG.perceive.scanTtlMs, true);
  check('缓存失效函数存在', typeof invalidatePerceiveCache, 'function');
  // ⚠️ 这里**故意不调用** `invalidatePerceiveCache`：
  //    `perceiveCache` 是 const，声明在自测块之后，TDZ 期间的 `typeof` 判定
  //    **也会抛**（不是返回 'undefined'）。硬要测它就得把缓存对象提到文件顶部，
  //    而那会把感知的状态和自测的短路逻辑搅在一起 —— 不值得。
  //    真正该离线锁死的是**配置自洽性**（下面几条），运行期行为交给实机验证。

  // ⑦ TTL 必须**自洽**：这些数字之间的关系错了，比单个数字错了更难发现
  //    （表现是"某些数据看起来正常，但总是慢半拍"）。
  check('scan TTL ≥ tickMs（否则缓存没有意义）',
    CFG.perceive.scanTtlMs >= CFG.tickMs, true);
  check('inventory TTL ≤ scan TTL（背包比地形变得快）',
    CFG.perceive.inventoryTtlMs <= CFG.perceive.scanTtlMs, true);
  check('entries 齐全（漏一个就会静默不同步）',
    ['fastMs', 'scanTtlMs', 'playersTtlMs', 'inventoryTtlMs', 'chatTtlMs', 'alertMs']
      .every(k => typeof CFG.perceive[k] === 'number'), true);
  check('分档系数齐全', ['idleFactor', 'workFactor', 'combatFactor', 'minMs', 'maxMs']
    .every(k => typeof CFG.tickProfile[k] === 'number'), true);
  check('战斗比工作快、工作比正常快、待机比正常慢',
    CFG.tickProfile.combatFactor < CFG.tickProfile.workFactor
    && CFG.tickProfile.workFactor < 1
    && CFG.tickProfile.idleFactor > 1, true);

  console.log('\n威胁识别 —— "打怪感知"不能只认原版名字（field-log P8 完整根因）');
  // 背景：实战里她被骷髅射到 1 点血，全程没躲。
  // 原因是 nearestHostile 只查 34 个**原版**名字的白名单，
  // 而网桥又把 `type === 'hostile'` 漏了、把骷髅分成了 'other'。
  // 这一段把"模组怪也必须认得出"锁成断言。

  // ① 网桥算好的 kind 优先
  check('kind=hostile 认得出',
    nearestHostile([{ name: 'skeleton', kind: 'hostile', distance: 5 }]) !== null, true);

  // ② ⚠️ 核心：**名字不在白名单里的模组怪**也必须认得出
  //    这是这一整个 bug 的关键 —— 单测只用原版名字是测不出它的
  const modMob = nearestHostile([
    { name: 'unknown', kind: 'hostile', entityType: 'hostile', distance: 6 },
  ]);
  check('★ 模组怪（name=unknown）也要认得出 —— 这是她被射到 1 血的那个 case',
    modMob !== null, true);
  check('★ 而且它确实是最近的那一个', modMob && modMob.name, 'unknown');

  // ③ 原始 type 也要能用（网桥老版本只给 type 不给 kind 时的兜底）
  check('type=hostile 也认得出',
    nearestHostile([{ name: 'unknown', type: 'hostile', distance: 3 }]) !== null, true);

  // ④ 名字白名单降级为兜底，但**没有失效**
  check('原版名字兜底仍在（name 白名单没被删掉）',
    nearestHostile([{ name: 'zombie', distance: 4 }]) !== null, true);

  // ⑤ 不能误伤：掉落物 / 被动生物 / 箭都不是威胁
  check('掉落物不是威胁',
    nearestHostile([{ name: 'item', kind: 'drop', isDrop: true, distance: 1 }]), null);
  check('牛不是威胁（怕误伤就不打，但也不能算威胁）',
    nearestHostile([{ name: 'cow', kind: 'mob', distance: 2 }]), null);
  // ⚠️ 箭（projectile）**不算威胁**：它已经离弦了，躲箭没有意义，
  //    要躲的是射箭的人。这条以前没测过，但正是实战里满屏 arrow 的场景。
  check('箭（projectile）不是威胁 —— 要躲的是射箭的，不是箭',
    nearestHostile([{ name: 'arrow', kind: 'other', distance: 0.7 }]), null);

  // ⑥ 多个威胁并存时挑最近的
  const pick = nearestHostile([
    { name: 'unknown', kind: 'hostile', distance: 8 },
    { name: 'skeleton', kind: 'hostile', distance: 3 },
  ]);
  check('多个威胁挑最近的', pick && pick.name, 'skeleton');

  // ------------------------------------------------------------------------
  // P24：自主生存 —— 猎物判据 + capability 的新字段
  // ------------------------------------------------------------------------
  console.log('\n[P24] 自主生存 —— 猎物判据（`hunt` / `forage` 的唯一准入）');

  // ⚠️ 这一段存在的理由：`pickPrey` 的 `kind` 判据在 P18 里被我用反过
  //    （把 20 只鸡算成了敌对）。这类判定必须穷举 case，不能靠"跑一次看看"。
  // ⚠️ 两个都在 5 格内 —— 否则会有一条被 maxDist 过滤掉，
  //    测试就变成"靠巧合通过"（原本用了 9 格，超限被滤，结果碰巧还是 3）。
  check('挑得出最近的鸡',
    (pickPrey([
      { name: 'chicken', kind: 'mob', distance: 4 },
      { name: 'chicken', kind: 'mob', distance: 2 },
    ]) || {}).distance, 2);
  check('牛/羊/猪都算猎物',
    ['cow', 'sheep', 'pig'].every(n => pickPrey([{ name: n, kind: 'mob', distance: 2 }])?.name === n), true);
  check('★ 敌对生物绝不是猎物（P18 的错不能再犯）',
    pickPrey([{ name: 'zombie', kind: 'hostile', distance: 1 }]), null);
  check('★ 苦力怕绝不是猎物', pickPrey([{ name: 'creeper', kind: 'hostile', distance: 1 }]), null);
  check('掉落物不是猎物（哪怕名字里有 chicken）',
    pickPrey([{ name: 'chicken', kind: 'mob', isDrop: true, distance: 1 }]), null);
  check('★ 幼年生物不是猎物（打了不掉肉）',
    pickPrey([{ name: 'baby_chicken', kind: 'mob', distance: 1 }]), null);
  check('认不出的被动生物跳过（宁可漏，不要错）',
    pickPrey([{ name: 'some_modded_thing', kind: 'mob', distance: 1 }]), null);
  check('玩家不是猎物', pickPrey([{ name: 'SomePlayer', kind: 'player', distance: 1 }]), null);
  check('空数组 → null（不崩）', pickPrey([]), null);
  check('不传参数 → null（不崩）', pickPrey(), null);
  check('全是敌对的场景 → null（她不会去送死）',
    pickPrey([
      { name: 'zombie', kind: 'hostile', distance: 2 },
      { name: 'skeleton', kind: 'hostile', distance: 3 },
    ]), null);

  // ---- P28：实机抓出来的错 —— 白名单里的每一项都要能被证据支持 ----------------
  //
  // ⚠️ 第一次实机跑到 `hunt` 时，她跑去打 `trader_llama`，`命中 0 次`。
  //    三层都错（中立生物 / 不掉肉 / 12.9 格够不着）。
  //    根因是我凭"看起来像被动生物"就往白名单里写了 `llama`，
  //    **没有对照它的实际掉落物**。
  check('★ 流浪商人的羊驼不是猎物（中立生物 + 不掉肉 + 实机打空过）',
    pickPrey([{ name: 'trader_llama', kind: 'mob', distance: 3 }]), null);
  check('★ 普通羊驼也不是猎物', pickPrey([{ name: 'llama', kind: 'mob', distance: 2 }]), null);
  check('★ 羊驼与鸡并存时，她挑鸡（不会被羊驼骗走）',
    (pickPrey([
      { name: 'trader_llama', kind: 'mob', distance: 1 },
      { name: 'chicken', kind: 'mob', distance: 4 },
    ]) || {}).name, 'chicken');
  check('★ 够不着的猎物不挑（避免"白跑一趟 + 暴露自己"）',
    pickPrey([{ name: 'chicken', kind: 'mob', distance: 12 }]), null);
  check('★ 距离未知（undefined）也不挑 —— "读不到"不等于"很近"',
    pickPrey([{ name: 'chicken', kind: 'mob' }]), null);
  check('距离就在上限内 → 挑得到',
    (pickPrey([{ name: 'chicken', kind: 'mob', distance: 5 }]) || {}).name, 'chicken');
  check('马/驴不在白名单（掉鞍不掉肉，骑的价值更高）',
    pickPrey([{ name: 'horse', kind: 'mob', distance: 2 }]), null);
  check('★ maxDist 可调，且确实生效',
    (pickPrey([{ name: 'chicken', kind: 'mob', distance: 8 }], 10) || {}).name, 'chicken');

  // ---- capability 的新字段（没有证据时必须保守）-----------------------------
  console.log('\n[P24] buildCapability —— 新字段的证据链');

  const capEmpty = buildCapability({ scan: null, drops: null, inventory: [], nearby: [], dayState: {} });
  check('★ 没有 scan → gatherableCount 为 0（"读不到"不等于"有东西"）', capEmpty.gatherableCount, 0);
  check('★ 没有 nearby → huntableCount 为 0', capEmpty.huntableCount, 0);
  check('★ dayState 缺 isDay → isDay 为 null（不猜天色）', capEmpty.isDay, null);
  check('dayState.isDay=false → isDay 为 false',
    buildCapability({ scan: null, drops: null, inventory: [], nearby: [], dayState: { isDay: false } }).isDay,
    false);

  const capRich = buildCapability({
    scan: {
      blocks: [{ name: 'dirt', count: 9 }],   // ⚠️ 裸 blocks **不该**被用来判定（P29）
      mineable: [
        { name: 'dirt', worthMining: true },
        { name: 'grass_block', worthMining: true },
        { name: 'oak_log', worthMining: true },
        { name: 'stone', worthMining: true, needsTool: true },   // 要镐 → 排除
        { name: 'calcite', worthMining: false },                 // 没产出 → 排除
        { name: 'dirt', worthMining: true, built: true },        // 玩家的建筑 → 不动
        { name: 'sand', worthMining: undefined },                // 模组方块（不知道）→ 算可用
      ],
    },
    drops: [{ name: 'beef' }, { name: 'dirt' }],
    inventory: [{ name: 'dirt', count: 3 }, { name: 'oak_log', count: 2 }],
    nearby: [{ name: 'chicken', kind: 'mob', distance: 3 }, { name: 'zombie', kind: 'hostile', distance: 4 }],
    dayState: { isDay: true },
  });
  check('可徒手采的：worthMining!==false 且 !needsTool 且 !built → 4',
    capRich.gatherableCount, 4);
  check('其中建材 4 个（dirt/grass_block/oak_log/sand 都算建材）', capRich.buildMatCount, 4);
  check('背包建材按**堆叠数**累加 → 3+2=5', capRich.matStacks, 5);
  check('★ 猎物只数被动生物（鸡算、僵尸不算）→ 1', capRich.huntableCount, 1);
  check('地上的食物掉落物只数吃的（beef 算、dirt 不算）→ 1', capRich.foodDropCount, 1);
  check('isDay 如实透传', capRich.isDay, true);

  // ---- ★ P29：字段名必须与 `/scan` 的**真实输出**一致 --------------------------
  //
  // ⚠️ 这一条是本轮最值得保护的回归锁。
  //    我第一版读的是 `worth` / `toolBlocked` / `isPlayerBuilt` —— 三个全错，
  //    真实字段是 `worthMining` / `needsTool` / `built`。
  //    后果：`gatherableCount` 恒为 0 → `needMaterials` 永远 false →
  //    `gather` 永远不进菜单。**而我修好的"自主采集"链路其实从来没接上。**
  //
  //    这类 bug 的可怕之处：**它不报错、不崩溃，只是"永远不触发"** ——
  //    和 P24 一样属于沉默故障，只有断言才能发现。
  // ⚠️ 这一条我第一版写错了，写成了"用 `worth` 而非 `worthMining` → 结果为 0"。
  //    实际不是 0，因为 `{name:'dirt', worth:true}` 里 **`worthMining` 是 undefined**，
  //    而过滤条件 `worthMining !== false` 让 undefined 通过
  //    —— 这是**刻意的**：`/scan` 对模组方块给不出 `worthMining`（不知道有没有产出），
  //    这种"不知道"应该算可用，而不是一票否决（P4/P20 的三态原则）。
  //
  //    所以 P29 真正的防线不是"字段名错就返回 0"（做不到，数据上分辨不出来），
  //    而是下面两条：
  //      ① **只认 `mineable`**，不认裸 `blocks` —— 因为 `mineable` 是网桥
  //         按正确字段名算好的短名单，我用错字段名的机会被消除了；
  //      ② `needsTool` / `built` / `worthMining:false` 三者确实被排除。
  check('★ 模组方块（worthMining 缺失）算可用 —— "不知道"不该被当成"不行"',
    buildCapability({
      scan: { mineable: [{ name: 'some_mod_block' }] },
      drops: null, inventory: [], nearby: [],
    }).gatherableCount, 1);
  check('★ worthMining === false 明确排除（原版表说没产出）',
    buildCapability({
      scan: { mineable: [{ name: 'calcite', worthMining: false }] },
      drops: null, inventory: [], nearby: [],
    }).gatherableCount, 0);
  check('★ needsTool === true 明确排除（缺工具，挖了白挖）',
    buildCapability({
      scan: { mineable: [{ name: 'stone', worthMining: true, needsTool: true }] },
      drops: null, inventory: [], nearby: [],
    }).gatherableCount, 0);
  check('★ built === true 明确排除（很可能是玩家的建筑，P21）',
    buildCapability({
      scan: { mineable: [{ name: 'oak_planks', worthMining: true, built: true }] },
      drops: null, inventory: [], nearby: [],
    }).gatherableCount, 0);
  check('★ 裸 blocks 不算数 —— 判定只认 mineable（避免又一次两处各判一遍）',
    buildCapability({
      scan: { blocks: [{ name: 'dirt', worthMining: true }], mineable: [] },
      drops: null, inventory: [], nearby: [],
    }).gatherableCount, 0);
  check('mineable 为空数组 → 0（不崩）',
    buildCapability({
      scan: { mineable: [] }, drops: null, inventory: [], nearby: [],
    }).gatherableCount, 0);


  console.log('\n[P31/P32] 自主动作的失败退避（死循环的第二道防线）');

  // ---- 记账：宽限期与指数退避 ------------------------------------------------
  const t0 = 1000000;
  const t1 = new Map();
  check('第 1 次失败 → 不设退避（当作瞬时故障）',
    noteSelfFailure(t1, 'gather', t0).until, 0);
  check('第 1 次失败后 → 不阻塞',
    selfActionBlocked(t1, 'gather', t0 + 1), false);
  check('第 2 次失败（= 宽限上限）→ 仍不设退避（口径：允许 2 次免费，第 3 次起罚）',
    noteSelfFailure(t1, 'gather', t0).until, 0);
  const r3 = noteSelfFailure(t1, 'gather', t0);
  check('第 3 次失败 → 开始退避（until > now）', r3.until > t0, true);
  check('第 3 次退避时长 = 4s', r3.until - t0, 4000);
  check('★ 退避期内 → 判定为阻塞', selfActionBlocked(t1, 'gather', t0 + 1000), true);
  check('★ 退避到期 → 不再阻塞（必须自我衰减，否则一次抖动就永久放弃）',
    selfActionBlocked(t1, 'gather', t0 + 4001), false);
  check('★ 指数增长：第 4 次失败退避 8s',
    noteSelfFailure(t1, 'gather', t0).until - t0, 8000);
  check('★ 第 5 次 = 16s', noteSelfFailure(t1, 'gather', t0).until - t0, 16000);
  // 封顶：失败很多次也不会无限拉长（否则等同于永久放弃）
  for (let i = 0; i < 10; i++) noteSelfFailure(t1, 'gather', t0);
  check('★ 退避封顶 90s（不论失败多少次）',
    t1.get('gather').until - t0 <= 90000, true);

  // ---- 清零：成功必须能清掉 ------------------------------------------------
  const t2 = new Map();
  noteSelfFailure(t2, 'gather', t0);
  noteSelfFailure(t2, 'gather', t0);
  noteSelfFailure(t2, 'gather', t0);
  check('清零前 → 阻塞中', selfActionBlocked(t2, 'gather', t0 + 100), true);
  clearSelfFailure(t2, 'gather');
  check('★ 清零后 → 立刻不再阻塞（成功一次就该重新信任它）',
    selfActionBlocked(t2, 'gather', t0 + 100), false);
  check('清零后失败计数也归零（下次从 1 开始，不是接着累加）',
    noteSelfFailure(t2, 'gather', t0).failures, 1);

  // ---- 隔离：不同动作互不影响 ------------------------------------------------
  const t3 = new Map();
  noteSelfFailure(t3, 'shelter', t0);
  noteSelfFailure(t3, 'shelter', t0);
  noteSelfFailure(t3, 'shelter', t0);
  check('★ 退避是**按动作**隔离的 —— shelter 阻塞不影响 gather',
    selfActionBlocked(t3, 'gather', t0 + 100), false);
  check('未知动作 → 不阻塞（表里没有 = 从没失败过）',
    selfActionBlocked(t3, 'explore', t0 + 100), false);

  // ---- 不变量：退避绝不能让菜单变空 ------------------------------------------
  //
  // ⚠️ 这是 P31 修复里**最容易引入的次生 bug**：如果过滤把菜单削成空数组，
  //    决策层就无从选起 —— 那还是卡死，只是从"空转"变成了"决策崩溃"。
  //    所以这个不变量必须锁住：**过滤后的菜单永不为空**。
  const onlyBlocked = new Map();
  noteSelfFailure(onlyBlocked, 'gather', t0);
  noteSelfFailure(onlyBlocked, 'gather', t0);
  noteSelfFailure(onlyBlocked, 'gather', t0);
  const raw = [{ id: 'gather', priority: 50 }, { id: 'explore', priority: 20 }];
  const filtered = raw.filter(m => !selfActionBlocked(onlyBlocked, m.id, t0 + 100));
  check('★ 退避过滤确实会移除被阻塞的动作', filtered.length, 1);
  check('★ 但剩下的菜单**不为空**（explore 顶上来了）', filtered.length > 0, true);
  // 极端情形：菜单里**只剩**一个被阻塞的动作 → 必须放弃过滤，保留原样
  const rawOnlyOne = [{ id: 'gather', priority: 50 }];
  const filtered2 = rawOnlyOne.filter(m => !selfActionBlocked(onlyBlocked, m.id, t0 + 100));
  const safeMenu = filtered2.length ? filtered2 : rawOnlyOne;
  check('★ 极端情形：唯一的动作被阻塞 → 放弃过滤，菜单仍有 1 项（宁可再试一次也不卡在决策层）',
    safeMenu.length, 1);

  // ---- SELF_ACTIONS 的边界 ---------------------------------------------------
  check('★ gather/hunt/forage/shelter/retreat 都在自主动作集里',
    ['gather', 'hunt', 'forage', 'shelter', 'retreat'].every(a => SELF_ACTIONS.has(a)), true);
  check('★ P32：pickup 也在 —— 它是"够不着的掉落物"造成的死循环的唯一出口',
    SELF_ACTIONS.has('pickup'), true);
  check('★ explore/idle 不在 —— 它们无状态，失败也没副作用，退避只会让她变呆',
    ['explore', 'idle'].some(a => SELF_ACTIONS.has(a)), false);
  check('★ work 不在 —— 那是玩家派的活，归 taskFailures 管，两套机制不能混',
    SELF_ACTIONS.has('work'), false);

  // ---- P32：`/pickup` 的返回契约（"走到了" ≠ "捡到了"）------------------------
  //
  // ⚠️ 这两端（bridge 的返回值 / autopilot 的判据）必须**同时**改，只改一头
  //    就还是谎报。这里锁住 autopilot 这一侧的判据：**只看 `picked`**。
  const pickupVerdict = r => {
    if (r?.found === 0) return { ok: true, note: '已经没有掉落物了' };
    const picked = r?.picked ?? 0;
    const walkedTo = r?.walkedTo ?? 0;
    if (picked === 0) return { ok: false, error: walkedTo > 0 ? 'walked-no-pick' : 'walked-none' };
    return { ok: true, note: `捡到 ${picked} 件` };
  };
  check('★ P32：真的没掉落物 → 成功收工（这不是失败）',
    pickupVerdict({ found: 0 }).ok, true);
  check('★ P32：走到了 3 件但一件没拿到 → **必须报失败**（旧代码在这里报 ok:true，就是那个谎）',
    pickupVerdict({ found: 3, walkedTo: 3, picked: 0 }).ok, false);
  check('★ P32：走到了但一件没走到 → 失败',
    pickupVerdict({ found: 3, walkedTo: 0, picked: 0 }).ok, false);
  check('★ P32：真的捡到 2 件 → 成功',
    pickupVerdict({ found: 3, walkedTo: 3, picked: 2 }).ok, true);
  check('★ P32：返回体里没有 picked 字段（旧版网桥）→ 按 0 处理 = 失败，不蒙混过关',
    pickupVerdict({ found: 3, walkedTo: 3 }).ok, false);
  // 有了这条，退避才能接力：谎报被消除 → 失败被记账 → 她转去做别的事
  const t4 = new Map();
  noteSelfFailure(t4, 'pickup', t0);
  noteSelfFailure(t4, 'pickup', t0);
  noteSelfFailure(t4, 'pickup', t0);
  check('★ P32：捡不到连续 3 次 → pickup 被退避（她终于会去干别的）',
    selfActionBlocked(t4, 'pickup', t0 + 100), true);

  // ---- P33：寻路球心的 y（"够得着的那一层"）---------------------------------
  //
  // ⚠️ 这是 bridge-server.js 里 `reachableStandY` 的**规则副本**。
  //    为什么在 autopilot 自测里再写一遍：`bridge-server.js` 有副作用，
  //    整体不能 `require`（一 require 就连服务器），所以它的纯函数没地方测。
  //    这里用同一组用例把**规则**锁住 —— 如果将来有人改了 bridge 那份实现而
  //    忘了改这里，两组断言会有一组红。**副本的唯一价值就是互相监督。**
  //
  //    规则（P30 + P33 两个相邻的错的合体）：
  //      · 物品在上方        → 用 selfY（不往天上爬）
  //      · 物品同层或下一层   → 用物品的 y（**跟着下去，这是能捡到的关键**）
  //      · 物品更深          → 用 selfY-1（最近的可站层，绝不要求挖穿地形）
  const reachableStandY = (dropY, selfY) => {
    const d = Math.floor(Number(dropY));
    const s = Math.floor(Number(selfY));
    if (!Number.isFinite(d) || !Number.isFinite(s)) return s;
    const dy = d - s;
    if (dy > 0) return s;
    if (dy >= -1) return d;
    return s - 1;
  };
  check('★ P33：物品在她脚下一格（87→86）→ 目标层 86，她**会**跟着下去',
    reachableStandY(86, 87), 86);
  check('★ P33：物品在同层（87→87）→ 目标层 87',
    reachableStandY(87, 87), 87);
  check('★ P33：物品在下方 2 格（87→85）→ 目标层 86（夹住，不要求挖穿）',
    reachableStandY(85, 87), 86);
  check('★ P33：物品在下方 5 格 → 仍然只夹到 selfY-1（不追着无底洞往下）',
    reachableStandY(82, 87), 86);
  check('★ P33：物品在她上方 2 格 → 用 selfY（不为了够东西往天上爬）',
    reachableStandY(89, 87), 87);
  check('★ P33：y 是小数 → 取 floor 后按同一规则',
    reachableStandY(85.7, 87.2), 86);
  check('★ P33：y 非法（NaN/undefined）→ 退回 selfY，不崩',
    reachableStandY(undefined, 87), 87);
  check('★ P33：★ 不变量 —— 返回值**永不**低于 selfY-1（低于就要挖穿地形了）',
    [82, 80, 60].every(dy => reachableStandY(dy, 87) >= 86), true);

  // ---- P35：`/mine` 的返回契约（"挖掉了" ≠ "拿到了"）--------------------------
  //
  // ⚠️ P32 的**同型**问题，出现在 `gather` 上。这是同一个 bug 的第三次出现：
  //      · P32  `/pickup`：`walkedTo`（走到了）≠ `picked`（拿到了）
  //      · P35  `gather` ：`mined`（挖掉了）  ≠ `dropsPicked`（拿到了）
  //    这里把 `gather` 的判据锁住 —— **只看 `dropsPicked`**。
  const gatherVerdict = r => {
    const mined = r?.mined?.length ?? 0;
    const picked = r?.dropsPicked ?? 0;
    if (picked === 0) {
      return { ok: false, error: mined > 0 ? 'mined-but-not-picked' : 'mined-nothing' };
    }
    return { ok: true, note: `${picked}` };
  };
  check('★ P35：挖掉 2 块但一件没拿到 → **必须报失败**（旧代码在这里报 ok:true）',
    gatherVerdict({ mined: [{}, {}], dropsPicked: 0 }).ok, false);
  check('★ P35：挖掉 2 块、拿到 2 件 → 成功',
    gatherVerdict({ mined: [{}, {}], dropsPicked: 2 }).ok, true);
  check('★ P35：一块没挖掉 → 失败（且错误信息要能区分"没挖到"和"够不着"）',
    gatherVerdict({ mined: [], dropsPicked: 0 }).error, 'mined-nothing');
  check('★ P35：挖到了但没拿到 → 错误信息明确指出"够不着"',
    gatherVerdict({ mined: [{}], dropsPicked: 0 }).error, 'mined-but-not-picked');
  check('★ P35：返回体缺 dropsPicked（旧版网桥）→ 按 0 处理 = 失败，不蒙混',
    gatherVerdict({ mined: [{}] }).ok, false);
  // 有了这条，gather 的谎报被消除 → 退避能接力 → 她换地方再试，而不是原地空挖
  const t5 = new Map();
  noteSelfFailure(t5, 'gather', t0);
  noteSelfFailure(t5, 'gather', t0);
  noteSelfFailure(t5, 'gather', t0);
  check('★ P35：采不到连续 3 次 → gather 被退避（她终于会去干别的）',
    selfActionBlocked(t5, 'gather', t0 + 100), true);

  // ---- P38：自适应半径（球内必须**存在**可站的点）----------------------------
  //
  // ⚠️ 这里要把话说清楚：**自适应半径修不了"她不肯往下走"这件事。**
  //
  //    `GoalNear` 判据是"欧氏距离 ≤ r"。落差 1 格、r = 2 时，
  //    **球内有可站的点**（就是她自己站的格）→ 她判定"已到达"→ 不动。
  //    所以 r 再大也没用：**球内有她当前的位置，它就没有动机移动。**
  //
  //    P38 的自适应半径**真正解决的问题**是"落差 ≥ r 时球内一个点都没有，
  //    goto 必然走满超时"——那是最坏的情况（纯浪费时间）。
  //    修完之后，最坏情况变成"她判定已到达但没拿到东西"→ 由 P32 的退避接管。
  //
  //    ⚠️ **"她真的会为了够东西而下行"这件事，`GoalNear` 做不到。**
  //       实测里她从 y=90 下到 y=88，那是**寻路器为了到达球内**自己走的路，
  //       不是"为了捡东西"。要真正实现"下到坑底"，需要点式目标（`GoalBlock`）
  //       或按键控制 —— 那是 P34 的待决项，**刻意没做**（风险与收益不成比例）。
  //
  //    所以下面这些断言**不是**在保证"能捡到"，只是在锁住
  //    "半径不会小于落差导致球内无点"这条**数值下限**。
  const reachRadius = (dropY, selfY) => {
    const s = Math.floor(Number(selfY));
    const d = Number.isFinite(Math.floor(Number(dropY))) ? Math.floor(Number(dropY)) : s;
    const dy = d - s;
    const goalY = dy > 0 ? s : (dy >= -1 ? d : s - 1);
    return Math.max(2, Math.abs(s - goalY) + 1);
  };
  check('★ P38：物品同层 → r=2（原行为）', reachRadius(87, 87), 2);
  check('★ P38：物品在下一格 → r=2（落差 1，球**内**已有点，不额外放大）',
    reachRadius(86, 87), 2);
  check('★ P38：物品在下方 2 格 → goalY=86、落差 1 → r=2', reachRadius(85, 87), 2);
  check('★ P38：物品在下方 4 格 → goalY=86（夹住）、落差 1 → r=2',
    reachRadius(83, 87), 2);
  check('★ P38：★ 不变量 —— 半径**永不小于**垂直落差+1（否则落差 ≥ r 时球内无点，goto 必然超时）',
    (() => {
      for (let dropY = 70; dropY <= 95; dropY++) {
        const s = 87;
        const dy = Math.floor(dropY) - s;
        const goalY = dy > 0 ? s : (dy >= -1 ? Math.floor(dropY) : s - 1);
        const gap = Math.abs(s - goalY);
        if (reachRadius(dropY, s) < gap + 1) return false;
      }
      return true;
    })(), true);
  check('★ P38：★ 半径永不为 0 或负数（`GoalNear` 收到 0 会退化成"必须精确站到球心"）',
    [70, 87, 95].every(dy => reachRadius(dy, 87) >= 2), true);

  // ---- P39：退避事件的字段必须是**非负时长** -------------------------------
  //
  // ⚠️ 实机抓出：事件里出现 `backoff=-1790289721s`。
  //    两个错叠加：① 记账阈值 `>= grace` 与 `noteSelfFailure` 的 `> grace` 不一致，
  //    于是 `failures === grace`（还没真正退避、`until` 仍为 0）时也进分支；
  //    ② 字段名 `untilMs` 听着像时间戳、装的却是时长 —— **名字骗了读的人**。
  //    修法：阈值统一 + 改名 `backoffMs` + clamp 到 ≥0（双保险）。
  const backoffLogOf = (rec, now) => {
    const grace = CFG.selfFailGrace ?? 2;
    // 与 noteSelfFailure 完全一致的口径
    const failures = rec.failures;
    if (failures <= grace) return null;              // 还没到退避 → 不该记事件
    return Math.max(0, rec.until - now);
  };
  const NOW = 1700000000000;
  check('★ P39：failures = grace（还没退避，until 为 0）→ **不记事件**（旧代码在这里记了个巨大负数）',
    backoffLogOf({ failures: 2, until: 0 }, NOW), null);
  check('★ P39：failures = grace+1 且 until 在未来 → 正时长',
    backoffLogOf({ failures: 3, until: NOW + 4000 }, NOW), 4000);
  check('★ P39：until 已过期（时钟漂移/晚记一笔）→ clamp 到 0，不出现负数',
    backoffLogOf({ failures: 5, until: NOW - 9999 }, NOW), 0);
  check('★ P39：★ 不变量 —— 任何输入下都不可能拿到负数',
    [[2, 0], [3, NOW + 1000], [9, 0], [9, NOW - 1e9]].every(([f, u]) => {
      const r = backoffLogOf({ failures: f, until: u }, NOW);
      return r === null || r >= 0;
    }), true);

  // ---- P40：格子归属必须在**负坐标 + 半格偏移**下也算对 -----------------------
  //
  // ⚠️ 实机抓出（**两轮，第一轮我的诊断是错的，如实记下来**）：
  //    她真实坐标 `exact = (-9.5006, 87.0, -6.5)`。
  //
  //    第一轮：我看到半格坐标就先入为主判定"`Math.floor` 算错格子归属"，
  //    据此写了"floor/round 双候选"。**逐格 `/block` 探测推翻了它**：
  //      · `Math.floor(-9.5006) = -10` → 她这格 `(-10,87,-7) = air` ✅ **归属是对的**
  //      · 她脚下 `(-10,86,-7) = andesite`（有地面）
  //      · 4 方向 × 2 层 **8 格全是实心**（dirt/andesite/grass_block）
  //    真相：**她站在一条天然形成的一格宽缝隙里** —— 四周本来就被封死，
  //    这地方**已经有遮蔽**。`/shelter` 那句"四周全是实心"说的是实话。
  //
  //    我第一轮错在拿**心算的** `Math.round(-6.5) = -7` 当实测证据
  //    （实际 = `-6`），**没跑逐格探测就下了结论**。
  //
  //    真问题是**选址假设**：sehlter 只会原地封四周，而她随机游走后常站在
  //    天然闭合的缝里 → 必然失败（12 次调用全零）。修法：先挪一格再搭；
  //    挪不动就如实判定"已有天然遮蔽"→ 返回成功（跳出 P31 形态的死循环）。
  //
  //    这里锁住的是**几何本身**（覆盖哪些整格），与实体位置无关。
  const HALF_WIDTH = 0.3;   // 与 place.js 的 HALF_WIDTH 同源
  // 格 n 覆盖 [n, n+1)；身体覆盖 [c-hw, c+hw]；有**正长度**交集即算覆盖。
  const spanOf = (c, hw) => {
    const out = [];
    for (let n = Math.floor(c - hw) - 1; n <= Math.ceil(c + hw) + 1; n++) {
      if (n < c + hw - 1e-9 && n + 1 > c - hw + 1e-9) out.push(n);
    }
    return out.length ? out : [Math.floor(c)];
  };
  check('★ P40：★ 实机复现 —— x=-9.5006 的身体盒是 [-9.80,-9.20]，**完整落在格 -10 内**（不跨格）',
    JSON.stringify(spanOf(-9.50062945059773, HALF_WIDTH)), JSON.stringify([-10]));
  check('★ P40：★ 实机复现 —— z=-6.5 的身体盒是 [-6.80,-6.20]，完整落在格 -7 内',
    JSON.stringify(spanOf(-6.5, HALF_WIDTH)), JSON.stringify([-7]));
  check('★ P40：格**正中央**（x=3，盒=[2.7,3.3]）→ **确实横跨格 2 与格 3**（几何如此，不许省一格）',
    JSON.stringify(spanOf(3, HALF_WIDTH)), JSON.stringify([2, 3]));
  check('★ P40：x=0.5（盒=[0.2,0.8]）→ 只占格 0',
    JSON.stringify(spanOf(0.5, HALF_WIDTH)), JSON.stringify([0]));
  check('★ P40：x=-0.5（盒=[-0.8,-0.2]）→ 只占格 -1（负坐标不许偏到 0）',
    JSON.stringify(spanOf(-0.5, HALF_WIDTH)), JSON.stringify([-1]));
  check('★ P40：x=-9（盒=[-9.3,-8.7]）→ 横跨格 -10 与 -9',
    JSON.stringify(spanOf(-9, HALF_WIDTH)), JSON.stringify([-10, -9]));
  check('★ P40：★ 不变量 —— 覆盖结果**永不为空**，且每格与 c 的距离不超过 1',
    (() => {
      for (const c of [-9.5006, -6.5, 3, 0.5, -0.5, -9, 0, 1e9, -1e9, 0.3]) {
        const cs = spanOf(c, HALF_WIDTH);
        if (!cs.length) return false;
        for (const n of cs) if (Math.abs(n - c) > 1.01) return false;
      }
      return true;
    })(), true);
  check('★ P40：★ 不变量 —— 覆盖格数**永不**超过 2（半宽 0.3 < 0.5，最多跨两格）',
    [[0.5, 0.5], [3.1, -2.2], [-9.5, -6.5], [0, 0], [-9, -6]].every(([x, z]) =>
      spanOf(x, HALF_WIDTH).length <= 2 && spanOf(z, HALF_WIDTH).length <= 2), true);
  check('★ P40：★ 去重之后，她占的格集合必须含 floor 那一格（脚下地面的归属格）',
    (() => {
      for (const [fx, fz] of [[-9.5006, -6.5], [3, 7], [0.5, -0.5]]) {
        const cells = [];
        for (const x of spanOf(fx, HALF_WIDTH)) for (const z of spanOf(fz, HALF_WIDTH)) cells.push({ x, z });
        if (!cells.some(c => c.x === Math.floor(fx) && c.z === Math.floor(fz))) return false;
      }
      return true;
    })(), true);

  // ---- P41：shelter 的判据必须与世界状态挂钩 ---------------------------------
  //
  // ⚠️ 同 P32（pickup 用 walkedTo 判成功）/ P35（gather 用 mined 判成功）：
  //    autopilot 的 shelter 旧代码无视返回值直接 `{ ok: true }`。
  //    判据要与网桥的 `sheltered = placed.length >= 2` 对齐 —— 1 格只算象征。
  const shelterVerdict = r => {
    const placed = r?.placed ?? 0;
    const sheltered = r?.sheltered === true || placed >= 2;
    return { ok: sheltered, placed };
  };
  check('★ P41：放了 0 个 → **必须报失败**（旧代码在这里报 ok:true，就是那个谎）',
    shelterVerdict({ placed: 0, sheltered: false }).ok, false);
  check('★ P41：只放成 1 个 → 仍算失败（1 格只是象征性的，不构成遮蔽）',
    shelterVerdict({ placed: 1, sheltered: false }).ok, false);
  check('★ P41：放成 2 个 → 成功', shelterVerdict({ placed: 2, sheltered: true }).ok, true);
  check('★ P41：网桥只给了 placed、没给 sheltered（旧版网桥）→ 按口径自己算，不蒙混过关',
    shelterVerdict({ placed: 3 }).ok, true);
  check('★ P41：返回体整个是 undefined（网桥崩了但没抛）→ 失败，不许当成功',
    shelterVerdict(undefined).ok, false);

  // ---- P34：够下方物品要用 `GoalBlock`（点式），不能用 `GoalNear`（球式）---------
  //
  // ⚠️ 实机抓出（2026-09-25）：`{"walkedTo":1,"picked":0,"ok":false}` 反复出现。
  //    掉落物在 `(-9, 86, -8)`（她脚下一格），她在 `y=87`。
  //    `GoalNear(x, selfY-1, z, r)` 的球心在 y=86，而**球内包含她自己站的格**
  //    （水平距离 0 ≤ r=2）→ 寻路器判"已到达" → **一步不动**。
  //
  //    实机反证：同一格，手动 `POST /move {"x":-9,"y":86,"z":-8}`（即 GoalBlock）
  //    → **她真的下去了**（`y: 87 → 86`），而且顺手把物品捡了（背包 20→21）。
  //    → **她能下，只是 `GoalNear` 表达不了"下到那一格去"。**
  //
  //    所以规则是：**物品在她下方 且 目标格站得进去**（脚+头两层非实心）
  //    → 用 `GoalBlock`；否则仍用 `GoalNear`（保留容错，不必精确站位）。
  const pickGoalKind = (dropY, selfY, standable) => {
    const d = Math.floor(Number(dropY));
    const s = Math.floor(Number(selfY));
    if (!Number.isFinite(d) || !Number.isFinite(s)) return 'near';
    return (d < s && standable) ? 'block' : 'near';
  };
  check('★ P34：物品在**下方一格**且那格站得进去 → 必须用 `GoalBlock`（否则球内有她自己 → 判定已到达 → 不动）',
    pickGoalKind(86, 87, true), 'block');
  check('★ P34：物品在下方但**那格站不进去**（头被堵）→ 退回 `GoalNear`（别去一个进不去的格子）',
    pickGoalKind(86, 87, false), 'near');
  check('★ P34：物品**同层** → `GoalNear`（同层没有"下去"的歧义，保留容错）',
    pickGoalKind(87, 87, true), 'near');
  check('★ P34：物品在**上方** → `GoalNear`（`reachableStandY` 本来就把 targetY 夹到 selfY）',
    pickGoalKind(89, 87, true), 'near');
  check('★ P34：物品在下方很深（-5 格）且站得进去 → 仍用 `GoalBlock`（让她一路下去）',
    pickGoalKind(82, 87, true), 'block');
  check('★ P34：y 非法（NaN）→ `GoalNear`，不崩',
    pickGoalKind(NaN, 87, true), 'near');

  // ---------------------------------------------------------------------------
  // P43（2026-09-25）：`findStandY` —— "物品报告的 y" ≠ "目标站位层"
  // ---------------------------------------------------------------------------
  //
  // 【症状】物品报告 y=85，而 (-7,85,-8) = grass_block（实心）——
  //   物品是**躺在方块顶面上**的，它的空间在 y=86。旧代码 `reachableStandY(85,86)`
  //   返回 85 → `standable` 拦掉 → 退回 `GoalNear(球心 85)` → 球内含她自己
  //   → **一步不动**。她距物品只有 0.97 格，就是拿不到（"看得见摸不着"）。
  //
  // 【修法】`findStandY` 把候选层逐个**问世界**（注入 `blockAt`），
  //   找出脚+头都站得进去的那一层。硬约束不变：不上天、不下潜超 1 格。
  //
  // ⚠️ 自测里用**假世界**（Map）喂 `blockAt`，所以纯逻辑、不连服务器。
  const findStandY = (dropY, selfY, blockAt, x, z) => {
    const AIRY = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava)$/;
    const DEADLY = /^(lava|flowing_lava|fire|soul_fire|magma_block|cactus|powder_snow)$/;
    const isStandable = b => !!b && AIRY.test(b.name || '') && !DEADLY.test(b.name || '');
    const d = Math.floor(Number(dropY));
    const s = Math.floor(Number(selfY));
    if (!Number.isFinite(d) || !Number.isFinite(s)) return s;
    const standableAt = (yy) => {
      if (typeof blockAt !== 'function') return false;
      try {
        return isStandable(blockAt(x, yy, z)) && isStandable(blockAt(x, yy + 1, z));
      } catch (_) { return false; }
    };
    const cand = [];
    let dropBlock = null;
    if (typeof blockAt === 'function') {
      try { dropBlock = blockAt(x, d, z); } catch (_) { dropBlock = null; }
    }
    if (dropBlock && !isStandable(dropBlock)) cand.push(d + 1);
    cand.push(d, d - 1, d + 1);
    for (const yy of cand) {
      if (yy > s) continue;
      if (s - yy > 1) continue;
      if (standableAt(yy)) return yy;
    }
    const reachableStandY = (dy0, sy0) => {
      const dd = Math.floor(Number(dy0)); const ss = Math.floor(Number(sy0));
      if (!Number.isFinite(dd) || !Number.isFinite(ss)) return ss;
      const gap = dd - ss;
      if (gap > 0) return ss;
      if (gap >= -1) return dd;
      return ss - 1;
    };
    return Math.min(reachableStandY(dropY, selfY), s);
  };
  const mkWorld = (spec) => (x, y, z) => {
    const n = spec[`${x},${y},${z}`];
    return n ? { name: n } : null;
  };

  // ★ 实机复现：物品报告 y=85 是实心，它的空间在 y=86
  //   ⚠️ 这个假世界必须让 **86 真的站得进去**：脚层 86 = air、头层 87 = **air**。
  //      我第一版把 87 写成 grass_block（那是"她头顶是草坪"的真地形），
  //      于是 86 被正确排除了 —— **是自测造错了世界，不是代码错**。
  const w1 = mkWorld({
    '-7,85,-8': 'grass_block', '-7,86,-8': 'air', '-7,87,-8': 'air',
  });
  check('★ P43：★ 实机复现 —— 物品报告 y=85 是**实心** → 目标层必须是 **86**（物品的空间），不是 85',
    findStandY(85, 86, w1, -7, -8), 86);
  check('★ P43：同一世界，她站在 y=87（在上一层）→ 仍应落在 86（不下潜超 1 格的边界内）',
    findStandY(85, 87, w1, -7, -8), 86);

  // ★ 目标格站不进去（头被堵）→ 不能选它
  //   ⚠️ 这正是**实机那片地形**：一条 1 格高的地道（y=87 整层实心）。
  const w2 = mkWorld({
    '-7,85,-8': 'grass_block', '-7,86,-8': 'air', '-7,87,-8': 'grass_block',
  });
  check('★ P43：★ 实机地形 —— 目标层 86 的**头层 87 是实心**（1 格高的地道）→ 站不进去，不许返回 86',
    findStandY(85, 86, w2, -7, -8) !== 86, true);

  // ★ 物品悬空在空气里（报告层本身可站）→ 就用那一层
  const w3 = mkWorld({
    '-3,60,-3': 'air', '-3,61,-3': 'air', '-3,59,-3': 'stone',
  });
  check('★ P43：物品**悬在空气格**里（报告层脚+头都可站）→ 直接用报告层',
    findStandY(60, 61, w3, -3, -3), 60);

  // ★ 硬约束：绝不上天
  const w4 = mkWorld({
    '-3,70,-3': 'air', '-3,71,-3': 'air',
  });
  check('★ P43：★ 硬约束 —— 物品在**上方**时**绝不上天**（返回她自己的层）',
    findStandY(70, 60, w4, -3, -3), 60);

  // ★ 硬约束：绝不下潜超过 1 格（canDig=false）
  const w5 = mkWorld({
    '-3,50,-3': 'air', '-3,51,-3': 'air',
    '-3,59,-3': 'air', '-3,60,-3': 'air',
  });
  check('★ P43：★ 硬约束 —— 物品在**很深**（9 格下）→ 最多下潜 1 格，绝不追下去',
    findStandY(50, 60, w5, -3, -3), 59);

  // ★ 找不到任何可站层 → 退回旧逻辑，且不破硬约束
  const w6 = mkWorld({ '-3,60,-3': 'stone', '-3,61,-3': 'stone' });
  check('★ P43：全是实心（一个可站层都没有）→ 退回旧逻辑，且**不破硬约束**',
    findStandY(59, 60, w6, -3, -3) <= 60, true);
  check('★ P43：`blockAt` 不是函数（离线/降级）→ 不崩，且不破硬约束',
    findStandY(85, 86, null, -7, -8) <= 86, true);
  check('★ P43：y 非法（NaN）→ 退回她自己那层，不崩',
    findStandY(NaN, 86, w1, -7, -8), 86);

  // ★ 不变量：返回值**永不高过** selfY（上天是 P30 的病）
  //   ⚠️ 每组的比较基准是**它自己的 selfY**，不能拿一个固定数比 ——
  //      我第一版写 `every(v => v <= 61)`，而第一组的 selfY 是 86，
  //      它返回 86 是**合法的**（不高过自己的 selfY），却把断言写红了。
  //      **这又是"心算一个固定阈值"的老毛病**（P42/P43 的教训同源）。
  const upCases = [
    [[findStandY(85, 86, w1, -7, -8)], 86],
    [[findStandY(70, 60, w4, -3, -3)], 60],   // 物品在上方 → 不上天
    [[findStandY(60, 61, w3, -3, -3)], 61],
  ];
  check('★ P43：★ 不变量 —— 返回值永不高过**自己的 selfY**（P30 的病就是"上天"）',
    upCases.every(([vs, s]) => vs.every(v => v <= s)), true);
  // ★ 不变量：返回值的下潜幅度**永不**超过 1 格
  const deepCases = [
    [findStandY(50, 60, w5, -3, -3), 60],
    [findStandY(85, 87, w1, -7, -8), 87],
    [findStandY(85, 86, w6, -7, -8), 86],
  ];
  check('★ P43：★ 不变量 —— 下潜幅度永不超过 1 格（`canDig=false`，下去就上不来）',
    deepCases.every(([v, s]) => s - v <= 1), true);

  // ---------------------------------------------------------------------------
  // P44（2026-09-25）：`/move` 的 `success: true` 不等于"她动了"
  // ---------------------------------------------------------------------------
  //
  // 【症状】`POST /move {"x":-8,"y":86,"z":-8}` → `success:true, arrived:(-8,86,-8)`
  //   而紧接着 `GET /position` → `exact = (-7.67, 86, -7.51)` **纹丝未动**。
  //
  // 【根因】**不是谎报，是语义歧义**：`GoalBlock.isEnd()` 只要求"她在这一格**内**"，
  //   不要求"到格中心"。她的格归属 `floor(-7.67) = -8`、`floor(-7.51) = -8`
  //   —— **她已经在了** → `goal_reached` 立刻触发 → `success: true`。
  //   这个 `success` **是对的**，但调用方会以为"她动过了" → 后续链路静默失效。
  //
  // 【修法】返回体补 `moved`（位移量）和 `wasInside`（出发时就在目标格里）。
  const moveEvidence = (origin, now, x, y, z) => {
    const destX = Math.floor(Number(x)), destZ = Math.floor(Number(z));
    const wasInside = !!origin
      && Math.floor(origin.x) === destX
      && Math.floor(origin.z) === destZ
      && (y === undefined || Math.floor(origin.y) === Math.floor(Number(y)));
    const moved = (origin && now)
      ? Math.round(Math.hypot(now.x - origin.x, now.y - origin.y, now.z - origin.z) * 1000) / 1000
      : null;
    return { moved, wasInside };
  };
  check('★ P44：★ 实机复现 —— 她 exact(-7.67,86,-7.51)，目标格(-8,86,-8)，**已在格内** → wasInside=true',
    moveEvidence({ x: -7.67, y: 86, z: -7.51 }, { x: -7.67, y: 86, z: -7.51 }, -8, 86, -8).wasInside, true);
  check('★ P44：★ 实机复现 —— 位移量必须是 **0**（她真的没动），不能被 success 掩盖',
    moveEvidence({ x: -7.67, y: 86, z: -7.51 }, { x: -7.67, y: 86, z: -7.51 }, -8, 86, -8).moved, 0);
  check('★ P44：真的走过去了（从 -1 走到 -8 那格）→ wasInside=false 且 moved > 0',
    (() => { const e = moveEvidence({ x: -1.5, y: 86, z: -8.5 }, { x: -7.6, y: 86, z: -8.4 }, -8, 86, -8);
      return e.wasInside === false && e.moved > 5; })(), true);
  check('★ P44：跨格移动（-7.5 → -8.4，格 -8 → -9）→ wasInside=false',
    moveEvidence({ x: -7.5, y: 86, z: -8 }, { x: -8.4, y: 86, z: -8 }, -9, 86, -8).wasInside, false);
  check('★ P44：只给了 x/z（GoalXZ，不管 y）→ wasInside 只看 xz',
    moveEvidence({ x: -7.67, y: 200, z: -7.51 }, { x: -7.67, y: 200, z: -7.51 }, -8, undefined, -8).wasInside, true);
  check('★ P44：origin 缺失（拿不到出发位置）→ moved=null，**不伪装成 0**',
    moveEvidence(null, { x: -7, y: 86, z: -8 }, -8, 86, -8).moved, null);
  check('★ P44：`moved` 必须保留 3 位小数（0.0001 的微动要和 0 区分开）',
    moveEvidence({ x: 0, y: 0, z: 0 }, { x: 0.0001, y: 0, z: 0 }, 0, 0, 0).moved, 0);

  // ------------------------------------------------------------------ P44 架构层
  //
  // 上面 7 条测的是**返回体字段**。这一组测的是**路由层的否决规则** ——
  // 那才是四次同型（P32/P35/P41/P44）的共同根因。
  //
  // 规则（bridge-server.js 路由层）：
  //   handler 显式 `ok === false` → 不贴 `success: true`，改 `success: false`。
  //   其余一切（含 `ok` 缺失 / `ok: 0` / `ok: null`）→ 保持 `success: true`。
  //
  // ⚠️ 判据必须是**严格 `=== false`**。写成 `!result.ok` 会让所有不返回 `ok` 的
  //    handler（绝大多数）集体翻车 —— 那比原 bug 更糟。
  const routeSuccess = (result) => {
    const vetoed = result && typeof result === 'object' && result.ok === false;
    return vetoed ? { success: false, ...result } : { success: true, ...result };
  };
  check('★ P44·架构：handler 否决（ok:false）→ success 变成 **false**',
    routeSuccess({ ok: false, mined: 0 }).success, false);
  check('★ P44·架构：★ 否决时 `ok:false` 本身**必须保留**（调用方还要读它）',
    routeSuccess({ ok: false }).ok, false);
  check('★ P44·架构：handler 认可（ok:true）→ success 仍是 true',
    routeSuccess({ ok: true, mined: 3 }).success, true);
  check('★ P44·架构：★ handler **没返回 ok** → 不许否决（绝大多数端点属于这种）',
    routeSuccess({ x: 1, y: 2, z: 3 }).success, true);
  check('★ P44·架构：★ `ok: 0`（假值但不是 false）→ **不许**否决（严格相等）',
    routeSuccess({ ok: 0 }).success, true);
  check('★ P44·架构：★ `ok: null` → **不许**否决',
    routeSuccess({ ok: null }).success, true);
  check('★ P44·架构：★ `ok: "false"`（字符串）→ **不许**否决（只认布尔 false）',
    routeSuccess({ ok: 'false' }).success, true);
  check('★ P44·架构：`result` 是 null/undefined → 不崩、照常 success:true',
    routeSuccess(null).success, true);
  check('★ P44·架构：★ 实机复现 —— `/mine` 挖不动时 `{mined:0, ok:false}` → success:false',
    routeSuccess({ mined: 0, minedBlocks: [], dropsPicked: 0, ok: false }).success, false);
  check('★ P44·架构：★ 实机复现 —— `/shelter` 一块没放下 `{placed:0, sheltered:false, ok:false}` → success:false',
    routeSuccess({ placed: 0, sheltered: false, failed: [], ok: false }).success, false);
  check('★ P44·架构：`/pickup` 走到但没捡到 `{walkedTo:1, picked:0, ok:false}` → success:false',
    routeSuccess({ walkedTo: 1, picked: 0, ok: false }).success, false);
  check('★ P44·架构：★ `/pickup` 捡到了 `{picked:2, ok:true}` → success:true（别误伤成功路径）',
    routeSuccess({ picked: 2, ok: true }).success, true);

  // 客户端侧：`call()` 的抛错判据。
  //   `success:false` **且带 error** → 真异常，抛。
  //   `success:false` 但**不带 error** → 业务否决，交回给 case 自己判。
  const callThrows = (resOk, data) => !resOk || (data.success === false && !!data.error);
  check('★ P44·架构：★ handler 否决（success:false 无 error）→ **不抛**，交回调用方',
    callThrows(true, { success: false, ok: false, mined: 0 }), false);
  check('★ P44·架构：★ 真异常（success:false 带 error）→ **抛**',
    callThrows(true, { success: false, error: 'pathfinder 没装' }), true);
  check('★ P44·架构：HTTP 500 → 抛（不管 body 长什么样）',
    callThrows(false, { success: false }), true);
  check('★ P44·架构：正常成功 → 不抛',
    callThrows(true, { success: true, mined: 1 }), false);

  // ---------------------------------------------------------------------------
  // P45（2026-09-25）：`/scan` 感知优化 —— 洋葱遍历替代"建数组+全排序"
  // ---------------------------------------------------------------------------
  //
  // 【实测基线】`/scan` 整体 8~11ms，而其中：
  //   · 排序 18513 个（比较器含 sqrt）... 11.80 ms   ← **时间几乎全在这里**
  //   · 纯三重循环，不分配不排序 ....... 0.82 ms   ← 快 14 倍
  //   所以"扫更多格子会卡住主线程"这个担心**被高估了一个数量级**。
  //
  // 【第二个病 —— 更严重】旧的配额口径是"走过多少**坐标格**"，空气也吃配额。
  //   实测：`radius=8` 与 `radius=16` 返回**完全一样**的内容
  //   （都截到 1536 格 ≈ 球半径 7.16），`distinct: 6` ——
  //   **她看不见 7 格以外的任何东西**，挖矿时看不到远处的矿。
  //   新口径：配额算"读到多少个**非空气方块**"，空气不吃配额。
  //
  // ⚠️ 这个自测**复制**了 bridge-server.js 里的遍历结构。**复制是刻意的**
  //    —— 但必须记下代价：**两处会漂移**（P39 的教训）。
  //    真正的一致性由"实机跑一次比对 `reach.maxDistance`"来保证，
  //    自测负责锁住**遍历的几何性质**（不漏、不重、近的优先）。
  const onionCells = (radius, verticalRadius) => {
    const seen = new Set(); const order = [];
    const dyOrder = [0];
    for (let k = 1; k <= verticalRadius; k++) dyOrder.push(-k, k);
    outer:
    for (const dy of dyOrder) {
      for (let level = 0; level <= radius; level++) {
        const push = (x, y, z) => {
          const k = `${x},${y},${z}`;
          if (seen.has(k)) return;
          seen.add(k); order.push({ x, y, z });
        };
        if (level === 0) { push(0, dy, 0); continue; }
        for (let dz = -level; dz <= level; dz++) { push(level, dy, dz); push(-level, dy, dz); }
        for (let dx = -level + 1; dx <= level - 1; dx++) { push(dx, dy, level); push(dx, dy, -level); }
      }
    }
    return order;
  };

  const on = onionCells(2, 1);
  check('★ P45：洋葱遍历 radius=2 vr=1 → 5*5*3 = 75 格（全覆盖）', on.length, 75);
  check('★ P45：洋葱遍历**无重复**', new Set(on.map(c => `${c.x},${c.y},${c.z}`)).size, 75);
  const cube = new Set();
  for (let x = -2; x <= 2; x++) for (let y = -1; y <= 1; y++) for (let z = -2; z <= 2; z++) cube.add(`${x},${y},${z}`);
  check('★ P45：覆盖集合恰好等于完整立方体（**不漏不越**）',
    [...new Set(on.map(c => `${c.x},${c.y},${c.z}`))].sort().join('|'),
    [...cube].sort().join('|'));
  check('★ P45：radius=16 vr=8 → 33*33*17 = 18513 格',
    onionCells(16, 8).length, 18513);

  // ★ 遍历语义：**同一 dy 层内部**水平半径单调不递减（近的真的先出现）
  //   ⚠️ 不能对全局序列断言单调 —— `dy` 在外层，换层时 `level` 从 0 重来。
  const lv = on.map(c => ({ L: Math.max(Math.abs(c.x), Math.abs(c.z)), y: c.y }));
  let mono = true;
  for (let i = 1; i < lv.length; i++) {
    if (lv[i].y !== lv[i - 1].y) continue;
    if (lv[i].L < lv[i - 1].L) { mono = false; break; }
  }
  check('★ P45：**同一 dy 层内部**水平半径单调不递减', mono, true);

  const lastZeroY = on.map(c => c.y === 0).lastIndexOf(true);
  const firstNegY = on.findIndex(c => c.y < 0);
  check('★ P45：dy=0 层**整体**先于 dy=-1 层（能走过去的地方优先知道）',
    lastZeroY < firstNegY, true);

  // ★ 每层的平均欧氏距离严格递增（"由近及远"真的成立）
  const byLevel = new Map();
  for (const c of on) {
    const L = Math.max(Math.abs(c.x), Math.abs(c.z));
    if (!byLevel.has(L)) byLevel.set(L, []);
    byLevel.get(L).push(Math.hypot(c.x, c.y, c.z));
  }
  const avgs = [...byLevel.entries()].sort((a, b) => a[0] - b[0])
    .map(([, ds]) => ds.reduce((s, v) => s + v, 0) / ds.length);
  let avgMono = true;
  for (let i = 1; i < avgs.length; i++) if (avgs[i] < avgs[i - 1] - 1e-9) { avgMono = false; break; }
  check('★ P45：每层的**平均欧氏距离**严格递增', avgMono, true);

  // ★ 配额口径：空气**不吃** solids 配额（这是 P45 最关键的那一条）
  //   ⚠️ `check` 是**严格相等**（`got === expect`），**不能比对象** ——
  //      我第一版直接传了对象，4 条全红，而逻辑其实是对的（`_dbg.js` 验证过）。
  //      这里统一**`JSON.stringify` 成字符串**再比，键顺序由返回值固定。
  const quotaVerdict = (blocks) => {
    const BUDGET = 3;
    let solids = 0, truncated = false;
    for (const b of blocks) {
      const isAir = b === 'air' || b === 'cave_air';
      if (isAir) continue;                       // 空气跳过，不计数
      if (solids >= BUDGET) { truncated = true; break; }
      solids++;
    }
    return JSON.stringify({ solids, truncated });
  };
  check('★ P45：★ 一连串空气**不消耗**配额（旧口径下这一串就把配额吃光了）',
    quotaVerdict(['air', 'air', 'air', 'air', 'air', 'air', 'stone']),
    JSON.stringify({ solids: 1, truncated: false }));
  check('★ P45：实心方块才消耗配额，超过上限才截断',
    quotaVerdict(['stone', 'dirt', 'gravel', 'sand']),
    JSON.stringify({ solids: 3, truncated: true }));
  check('★ P45：空气夹在中间也不占额度（`air,stone,air,dirt` → solids=2）',
    quotaVerdict(['air', 'stone', 'air', 'dirt']),
    JSON.stringify({ solids: 2, truncated: false }));

  // ★ `reach` 字段必须能回答"她到底看多远"（旧返回体答不了这个问题）
  const reachOf = (blocks) => {
    const origin = { x: 0, y: 0, z: 0 };
    let maxD2 = 0, farthest = null;
    for (const b of blocks) {
      const dx = b.x + 0.5 - origin.x, dy = b.y + 0.5 - origin.y, dz = b.z + 0.5 - origin.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxD2) { maxD2 = d2; farthest = b.name; }
    }
    return JSON.stringify({ maxDistance: +Math.sqrt(maxD2).toFixed(1), farthest });
  };
  check('★ P45：`reach` 如实给出最远距离（这是判定"看得多远"的直接证据）',
    reachOf([{ x: 0, y: 0, z: 0, name: 'stone' }, { x: 6, y: 0, z: 0, name: 'iron_ore' }]),
    JSON.stringify({ maxDistance: 6.5, farthest: 'iron_ore' }));
  check('★ P45：`reach` 在只有脚下 1 格时也给得出值（不是 null / 不崩）',
    reachOf([{ x: 0, y: 0, z: 0, name: 'dirt' }]),
    JSON.stringify({ maxDistance: 0.9, farthest: 'dirt' }));

  // ---------------------------------------------------------------------------
  // P42（2026-09-25）：自救逃逸 —— 判据必须问"世界真的变了吗"
  // ---------------------------------------------------------------------------
  //
  // 【现场】她被卡在"只有 1 格高"的天然缝隙里，四个方向全部 `No path found`。
  //   4 邻居泛洪 → 连通分量 = 1。真因：她身高 1.8 格，站位需要脚+头两层，
  //   唯一可站的邻格在对角（正交邻居全实心时不许走对角）。
  //   `canDig=false` 让寻路器只绕不拆 → **永久卡死，她自己出不来**。
  //
  // 【三级手段】① `/unstick`（临时放行 canDig，网桥 finally 恢复）
  //            ② `/mine` 挖脚边一格（不走寻路器，不受 canDig 影响）
  //            ③ 如实放弃（**不谎报**）
  //
  // ⚠️ 判据必须是"世界真的变了"，而不是"请求成功了" —— P32/P35/P41/P44 的教训。
  //    尤其 P44：`success: true` 可能是"她本来就在那一格里"，`moved: 0`。

  // ★ 逃逸判据（与网桥 `/unstick` 的 `escaped` 同源）
  const escapedByMove = (r) => {
    const moved = r?.moved;
    if (moved === null || moved === undefined) return false;   // 拿不到位移 → 不算
    return moved > 0.5;
  };
  check('★ P42：真的动了（moved=2.4）→ 逃出来了', escapedByMove({ moved: 2.4 }), true);
  check('★ P42：一动没动（moved=0）→ **不算**逃出来（这正是 P44 那种"看着成功"）',
    escapedByMove({ moved: 0 }), false);
  check('★ P42：微动 0.05 格（抖动）→ 不算逃出来', escapedByMove({ moved: 0.05 }), false);
  check('★ P42：位移拿不到（moved=null）→ 不算（不许把"不知道"当"成功"）',
    escapedByMove({ moved: null }), false);
  check('★ P42：返回体整个 undefined → 不算', escapedByMove(undefined), false);
  check('★ P42：刚好 0.5 格 → 不算（阈值是**严格大于**）', escapedByMove({ moved: 0.5 }), false);

  // ★ 挖开之后再走的判据：`success` **必须**配上"不在原地"
  const escapedAfterMine = (r) => {
    if (!r?.success) return false;
    if (r.wasInside === true) return false;               // 本来就在那一格 → 没动
    if (r.moved === null || r.moved === undefined) return false;
    return r.moved > 0.5;
  };
  check('★ P42：挖开后走通（success + moved=3.1）→ 逃出来了',
    escapedAfterMine({ success: true, moved: 3.1, wasInside: false }), true);
  check('★ P42：★ 挖开后 `success: true` 但 `wasInside: true` → **不算**（她本来就在那格里）',
    escapedAfterMine({ success: true, moved: 0, wasInside: true }), false);
  check('★ P42：★ `success: true` 但没给 moved（旧网桥）→ 不算（不许猜）',
    escapedAfterMine({ success: true, wasInside: false }), false);
  check('★ P42：`success: false`（Stuck）→ 不算',
    escapedAfterMine({ success: false, moved: 5 }), false);

  // ★ 可挖目标的白名单：基岩/屏障这类**绝对不能**挖
  const mineable4Rescue = (name) => {
    if (!name || name === 'unknown') return false;
    return !/^(bedrock|barrier|command_block|structure_void|obsidian|ancient_debris)$/.test(name);
  };
  check('★ P42：挖 grass_block 自救 → 允许', mineable4Rescue('grass_block'), true);
  check('★ P42：挖 dirt 自救 → 允许', mineable4Rescue('dirt'), true);
  check('★ P42：★ 挖 bedrock 自救 → **禁止**（挖了也没用，白费一次机会）',
    mineable4Rescue('bedrock'), false);
  check('★ P42：挖 barrier 自救 → 禁止', mineable4Rescue('barrier'), false);
  check('★ P42：挖 obsidian 自救 → 禁止（徒手挖不掉，浪费超时）',
    mineable4Rescue('obsidian'), false);
  check('★ P42：认不出的方块（unknown）→ 不挖', mineable4Rescue('unknown'), false);
  check('★ P42：名字为空 → 不挖', mineable4Rescue(''), false);

  // ★ 三级手段的**升级顺序**必须是"从便宜到侵入"（顺序错了会平白拆方块）
  const escalationOrder = ['unstick', 'mine', 'give-up'];
  check('★ P42：升级顺序是 unstick → mine → 放弃（**不能**一上来就挖）',
    escalationOrder[0], 'unstick');
  check('★ P42：兜底手段是 `/mine` —— 它不走寻路器，**不受 canDig 影响**',
    escalationOrder.includes('mine'), true);

  // ★★★ P42 最关键的一条：**逃逸目标必须是"真的能站的地方"**，不能用原任务坐标。
  //
  //   实机抓出来的（2026-09-25）：我原版拿 `S.task` 的目标当逃逸目标，
  //   而那次的 `(-14,87,-6)` 在**实心岩体内部**（`x=-13`、`x=-12` 两列整列实心）
  //   → `/unstick` 和 `/mine` 全部注定失败。**问题不在"被不被困"，在"目标不可达"。**
  //
  //   正确定义：**脱困 = 能走到任何一个新的地方**，不是"到达原任务坐标"。
  const pickEscape = (world, R = 6) => {
    const here = { x: 0, y: 0, z: 0 };
    const passable = (n) => n && n !== 'solid';
    const cands = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const dy of [0, -1, 1, -2, 2]) {
          if (dy !== 0) continue;                       // 自测里只看同层，简化
          const x = dx, y = dy, z = dz;
          const d = Math.hypot(dx, dy, dz);
          if (d <= 0.5) continue;
          cands.push({ x, y, z, dist: Math.round(d * 10) / 10, d });
        }
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 40)) {
      const feet = world[`${c.x},${c.y},${c.z}`];
      const head = world[`${c.x},${c.y + 1},${c.z}`];
      const ground = world[`${c.x},${c.y - 1},${c.z}`];
      if (passable(feet) && passable(head) && ground === 'solid') return { x: c.x, y: c.y, z: c.z, dist: c.dist };
    }
    return null;
  };
  // 世界：她 (-10,87,-8) 周围的真实地形（从实机逐格探测复制过来的）
  const realWorld = {
    // 可站：脚=air 头=air 脚下=实心
    '-1,0,-1': 'air', '-1,1,-1': 'air', '-1,-1,-1': 'solid',
    '-1,0,1': 'air', '-1,1,1': 'air', '-1,-1,1': 'solid',
    '0,0,-1': 'air', '0,1,-1': 'air', '0,-1,-1': 'solid',
    '0,0,1': 'air', '0,1,1': 'air', '0,-1,1': 'solid',
    '1,0,1': 'air', '1,1,1': 'air', '1,-1,1': 'solid',
    // 不可站：头被堵
    '1,0,-1': 'air', '1,1,-1': 'solid', '1,-1,-1': 'solid',
  };
  const esc = pickEscape(realWorld);
  check('★ P42：★ 在真实地形里选出了逃逸目标（不为 null）', esc !== null, true);
  check('★ P42：★ 选中的格子**脚层与头层都是空气**（她身高 1.8 格，站得进去）',
    esc && realWorld[`${esc.x},${esc.y},${esc.z}`] === 'air'
      && realWorld[`${esc.x},${esc.y + 1},${esc.z}`] === 'air', true);
  check('★ P42：★ 选中的格子**脚下是实心**（踩得住，不会掉下去）',
    esc && realWorld[`${esc.x},${esc.y - 1},${esc.z}`] === 'solid', true);
  check('★ P42：★ **不会**选中"头被堵"的那格（1,0,-1 的 head 是 solid）',
    esc && !(esc.x === 1 && esc.y === 0 && esc.z === -1), true);
  check('★ P42：★ 取的是**最近**的可站格（dist 最小的）',
    esc && esc.dist <= 1.5, true);
  // 全实心 → null（那才是真的被困）
  const solidWorld = {};
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    solidWorld[`${x},0,${z}`] = 'solid'; solidWorld[`${x},1,${z}`] = 'solid';
  }
  check('★ P42：★ 四周全是实心 → 返回 **null**（如实承认"真被困住了"，不许硬编一个假的）',
    pickEscape(solidWorld), null);

  console.log('\n（动作决策的自测在 decision.js：node decision.js --selftest）');
  console.log('（留痕模块的自测在 events.js：node events.js --selftest）');

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

/**
 * 唯一的发言出口。带冷却、去重、讲课拦截。
 * @param {string} reason  为什么说（chat/danger/fail/task/agent）
 * @param {string} text    内容
 * @param {object} opts    { force: true } 可绕过冷却（agent 显式指定时用）
 */
async function speak (reason, text, opts = {}) {
  if (!text) return { skipped: 'empty' };

  // 没被问就讲课 —— 直接拦。这是她最容易犯的错。
  if (!opts.force && looksLikeLecture(text)) {
    log(`✋ 拦下一条没人问的"讲课"发言（${reason}）：${text.slice(0, 40)}…`);
    return { skipped: 'lecture' };
  }

  if (!opts.force) {
    if (Date.now() - S.lastSpeak < CFG.speakCooldownMs) {
      return { skipped: 'cooldown' };
    }
  }

  if (S.said.has(text)) return { skipped: 'duplicate' };

  try {
    await post('/chat', { message: text });
    S.lastSpeak = Date.now();
    S.said.add(text);
    if (S.said.size > 100) S.said.clear();
    log(`💬 (${reason}) ${text}`);
    return { sent: text };
  } catch (e) {
    log(`发言失败：${e.message}`);
    return { error: e.message };
  }
}

// -------------------------------------------------------------------- 感知

/** 拉一份当前局势。任何一项失败都不该让整个 tick 崩掉。 */
// ---------------------------------------------------------- 感知缓存（慢环）
//
// 见 CFG.perceive 的注释。缓存的是**上一次成功的结果 + 取回时间**，
// 不是"最近一次尝试" —— 失败不能污染缓存，否则一次网络抖动会让
// 她拿着几秒前的空背包一直往下走。
//
// ⚠️ 缓存必须**如实报告年龄**（`ages`），否则"我看到的是 3 秒前的世界"
//    这种事会永远查不出来 —— 而它正是"反应慢"这类投诉最难定位的形态。
const perceiveCache = {
  scan: { value: null, at: 0, err: null },
  players: { value: null, at: 0, err: null },
  inventory: { value: null, at: 0, err: null },
  chat: { value: null, at: 0, err: null },
  hits: 0,
  misses: 0,
};

/**
 * 取一个慢环数据。命中缓存就直接给，否则发起请求。
 *
 * `force` 用于**必须**重取的场合（例如刚做完一个动作，想立刻确认背包变化）。
 */
async function cachedGet (slot, path, ttlMs) {
  const c = perceiveCache[slot];
  const age = Date.now() - c.at;
  if (c.value !== null && age < ttlMs) {
    perceiveCache.hits++;
    return { value: c.value, age, cached: true };
  }
  perceiveCache.misses++;
  try {
    const v = await get(path);
    c.value = v;
    c.at = Date.now();
    c.err = null;
    return { value: v, age: 0, cached: false };
  } catch (e) {
    c.err = e.message;
    // 有旧值就先用旧的（并如实标注年龄），比"这次什么都没有"有用得多
    if (c.value !== null) return { value: c.value, age, cached: true, staleError: e.message };
    return { value: null, age: null, cached: false, error: e.message };
  }
}

/** 让所有缓存立即失效（做完大动作后调用，确保下一拍看到的是新世界） */
function invalidatePerceiveCache (slots) {
  // `typeof` 守卫：`perceiveCache` 是 const，声明在文件靠后位置。
  // 虽然运行期（loop 启动后）它一定已初始化，但**自测块在文件顶部**，
  // 且未来可能有人在更早的地方调用 —— 一个"清缓存"函数把整个进程搞崩
  // 是完全没有必要的失败模式。
  if (typeof perceiveCache === 'undefined') return;
  const list = slots || Object.keys(perceiveCache).filter(k => k !== 'hits' && k !== 'misses');
  for (const k of list) {
    if (perceiveCache[k] && typeof perceiveCache[k] === 'object' && 'at' in perceiveCache[k]) {
      perceiveCache[k].at = 0;
    }
  }
}

async function perceive () {
  const out = {
    st: null, nearby: [], players: [], inventory: [], chat: [], scan: null,
    ages: {}, cached: {}, fresh: {},
  };

  // ---- 快环：每一拍都取。这两个决定了"会不会挨打、有没有东西捡" ---------------
  try {
    out.st = await get('/status');
    out.fresh.status = true;
  } catch (e) {
    out.stError = e.message;
  }
  if (!out.st?.connected) return out;

  const fast = await Promise.allSettled([get('/nearby?radius=24')]);
  if (fast[0].status === 'fulfilled') {
    out.nearby = fast[0].value.entities || [];
    out.fresh.nearby = true;
  }

  // ---- 慢环：带 TTL 缓存 ------------------------------------------------------
  //
  // 聊天**不缓存**（ttl=0）：用户报的"处理消息不及时"就是因为聊天被别的东西拖住了，
  // 给它加缓存等于把这个病再治一遍。
  const [players, inv, chat, scan] = await Promise.all([
    cachedGet('players', '/players', CFG.perceive.playersTtlMs),
    cachedGet('inventory', '/inventory', CFG.perceive.inventoryTtlMs),
    cachedGet('chat', '/chatlog', CFG.perceive.chatTtlMs),
    cachedGet('scan', '/scan?radius=8&verticalRadius=4&limit=24', CFG.perceive.scanTtlMs),
  ]);

  if (players.value) { out.players = players.value.players || []; out.ages.players = players.age; out.cached.players = players.cached; }
  if (inv.value) { out.inventory = inv.value.items || []; out.ages.inventory = inv.age; out.cached.inventory = inv.cached; }
  if (chat.value) { out.chat = chat.value.messages || []; out.ages.chat = chat.age; out.cached.chat = chat.cached; out.fresh.chat = !chat.cached; }
  if (scan.value) { out.scan = scan.value; out.ages.scan = scan.age; out.cached.scan = scan.cached; }
  S.perceiveHits = perceiveCache.hits;
  S.perceiveMisses = perceiveCache.misses;
  return out;
}

/**
 * 决定这一拍该用多快。**这是"提高感知速度"的执行点。**
 *
 * 输入是"她现在的处境"，输出是这一拍到下一拍之间该等多久。
 * 关键设计：**只在真正需要快的时候快** —— 待机时反而放慢，
 * 把省下的资源还给挖矿/战斗。这样"平均负载"不升，"关键时刻的刷新率"却上去了。
 *
 * 判据顺序（从高到低）：
 *   1. 附近有敌对生物 / 血量低于临界 → combat（最快）
 *   2. 正在做需要盯着掉落的活（mine/collect/place/pickup）→ work
 *   3. 有威胁刚过去（alertMs 内）→ 保持 work 级，别立刻松懈
 *   4. 什么都没干 → idle（最慢）
 */
function pickTickDelay ({ st, threat, action }) {
  const prof = CFG.tickProfile;
  const base = CFG.tickMs;
  let factor = 1;
  let mode = 'normal';

  const hp = st?.health ?? 20;
  const inDanger = Boolean(threat) || hp <= CFG.criticalHp;

  if (inDanger) {
    factor = prof.combatFactor;
    mode = 'combat';
    S.lastAlertAt = Date.now();
  } else if (S.lastAlertAt && Date.now() - S.lastAlertAt < CFG.perceive.alertMs) {
    // 威胁刚走 —— 别立刻松懈。怪可能还在视野外，或者血还没回上来。
    factor = prof.workFactor;
    mode = 'alert';
  } else {
    const a = String(action || '');
    const isWork = /^(mine|collect|place|pickup|equip|eat|build)/.test(a);
    if (isWork) {
      factor = prof.workFactor;
      mode = 'work';
    } else if (a === 'idle' || a === '') {
      factor = prof.idleFactor;
      mode = 'idle';
    }
  }

  const ms = Math.min(prof.maxMs, Math.max(prof.minMs, Math.round(base * factor)));
  return { ms, mode, factor };
}

/**
 * 掉落物。`GET /nearby` 里一直有它们，但**从来没有消费者** ——
 * `nearestHostile()` 只按 HOSTILE 白名单过滤，掉落物不是 hostile 所以被丢掉。
 * 这就是"对可拾取的东西视而不见"的另一半原因（前半是物品名解析，已修）。
 *
 * ⚠️ 判定**优先用网桥算好的 `isDrop`**（见 bridge-server.js 的 `isDropEntity`）。
 *    历史教训：这条判据曾在四个地方各写一遍，其中两处写成 `name === 'item'`
 *    而恒不成立 —— 于是"有返回、无消费者"。
 *    现在由网桥统一算，消费者不再自己猜。`objectType` 是废弃字段，
 *    读它会打 `console.trace` 堆栈（`/nearby` 是打怪时的高频端点，会把日志冲烂）。
 *
 * 后两个条件是**兼容旧版网桥**的兜底（如果网桥没升级，`isDrop` 会是 undefined）。
 */
function nearestDrop (nearby) {
  return nearby
    .filter(e => e.isDrop === true
      || e.kind === 'drop'
      || (e.objectType === 'Item')
      || (e.type === 'object' && e.name === 'item'))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

/**
 * 挑最近的敌对生物。
 *
 * ⚠️⚠️⚠️ 2026-09-25 第六次实战：这个函数曾经**只按名字白名单**过滤，
 *       而那是"打怪感知"整条链上最贵的一个 bug（field-log P8 完整根因）。
 *
 * 实战证据（她当时正在被射）：
 *     [21:05:05] 💔 掉血 15.33 → 9.33
 *     [21:05:22] 💔 掉血 18 → 12
 *     [21:05:33] 💔 掉血 14.83 → 1     ← 只剩 1 点血
 *     [21:05:42] 💬 (danger) 呜…我血不多了，先躲一下下
 *   ……但她**从头到尾没有真的躲**（S.task 一直是 null）。
 *
 * 而 `/nearby` 里明明白白有：
 *     name=skeleton  type=hostile  kind=other  d=7.7
 *
 * 两个叠加的 bug：
 *   ① 网桥侧把 `type === 'hostile'` 漏了，只认 `'mob'`，于是 kind 变成 'other'；
 *   ② 这里只查 `HOSTILE` 白名单 —— 那 34 个名字全是**原版**的，
 *      而这服有 516 个模组，模组怪物的名字（甚至常常是 `unknown`）
 *      永远进不了白名单。
 *
 * 所以判据改成**三级**，越靠前越可信：
 *   ① `kind === 'hostile'`     —— 网桥按协议 `type` 算的，最可信（已修网桥侧）
 *   ② `type === 'hostile'`     —— 网桥原样透出的 `entityType`
 *   ③ `HOSTILE.has(name)`      —— 名字白名单，**降级为兜底**
 *      · 它的价值只剩"网桥老版本没给 kind/type"这一种情况；
 *      · 以及可能把"hostile 但被误分类为 other"的捞回来。
 *
 * ⚠️ 但**绝不能只留名字白名单** —— 那正是她被打到 1 点血还不躲的原因。
 */
function nearestHostile (nearby) {
  return nearby
    .filter(e => e.kind === 'hostile'
      || e.type === 'hostile'
      || e.entityType === 'hostile'
      || HOSTILE.has(e.name))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

/**
 * 威胁决策现在由 decision.js 负责 —— 那边把"当前可能的动作"组成菜单
 * （苦力怕贴脸时"近战"根本不进菜单），再由后端挑一个。
 * 阈值在 decision.js 的 TUNING 里，本文件不再另存一份。
 */

// -------------------------------------------------------------------- 动作

/** 穿上背包里最好的某类工具（mine 之前必须做，不然挖得极慢甚至挖不动） */
async function equipBestTool (suffix) {
  try {
    const inv = await get('/inventory');
    const tool = (inv.items || [])
      .filter(i => typeof i.name === 'string' && i.name.endsWith(suffix))
      .sort((a, b) => (b.durability ?? 0) - (a.durability ?? 0))[0];
    if (!tool) return null;
    await post('/equip', { itemName: tool.name, destination: 'hand' });
    log(`🔧 换上 ${tool.name}`);
    return tool.name;
  } catch (e) {
    log(`换工具失败：${e.message}`);
    return null;
  }
}

/** 远离某个目标：朝反方向走一段 */
/**
 * 逃离威胁。
 *
 * ⚠️⚠️ 2026-09-25 第六次实战：这个函数原来在**自己算目标坐标**，
 *       然后调 `POST /move {x, z}` —— 结果实战里每次都失败：
 *
 *     [21:07:46] 💬 (danger) 呜…我血不多了，先躲一下下
 *     [21:07:56] 逃跑失败（The operation was aborted due to timeout）—— 退回原地
 *
 *       失败原因是"自己算坐标"这条路缺了**地形可达性**：
 *       · 拿 `threat.position + 反方向 × 8` 算出来的点，可能在她根本走不到的地方
 *         （实战现场四周是 `calcite×76` / `meadow:limestone×444`，她被围在中间）；
 *       · 没有多方向备选 —— 一条路走不通就整个失败；
 *       · 也没有把"已经走到的距离"当判据。
 *
 *       而**网桥侧的 `POST /flee` 早就把这些都做了**：8 个方向全部评分、
 *       按"离威胁最远"排序、前 3 个各试一遍、按距离给超时。
 *       autopilot 这边却绕开它另写了一套更差的 —— 典型的重复实现。
 *
 * 现在改成**直接调 `/flee`**，把"往哪逃、能不能逃到"整个交给网桥。
 * 这里只负责"决定要逃"和"报告结果"。
 *
 * `distance` 用 `CFG.fleeDistance`（8 格）：太短甩不掉骷髅（射程 ~15 格），
 * 太长则一步走不到、反而卡在路上挨打。
 */
async function fleeFrom (threat, self) {
  try {
    const r = await post('/flee', {
      distance: CFG.fleeDistance,
      // 从**威胁的位置**往外逃，而不是"从当前位置往外逃" ——
      // 两者在"威胁已经贴脸"时会给出完全相反的方向。
      fromX: threat?.position ? Math.round(threat.position.x) : undefined,
      fromZ: threat?.position ? Math.round(threat.position.z) : undefined,
    });
    return r;
  } catch (e) {
    log(`逃跑失败（${e.message}）—— 退回原地`);
    return null;
  }
}

// -------------------------------------------------------------------- 任务

/**
 * 纯判定：长动作期间要不要打断。抽出来是为了能离线自测。
 *
 * 这是"像不像真人"的关键一环。真人挖矿时余光一直在扫周围，
 * 怪一贴脸就停手；而我们原来的 runTask 会 await 整整 45 秒，
 * 这 45 秒里她对苦力怕完全无感 —— 决策再快也没用，
 * 因为决策循环本身被一个 await 堵死了。
 *
 * 打断要克制：僵尸在 6 格外走路是常态，每次都停手会造成
 * "停下→恢复→再停下"的空转。所以分两档：
 *   - 会自爆的生物：进危险圈就停（它一炸就没得商量）
 *   - 其它怪：真的贴脸（够得着的距离）才停
 *
 * @returns {{kind:'hp'|'threat', detail:string}|null} null 表示继续
 */
function shouldInterrupt (hp, threat) {
  if (hp != null && hp <= TUNING.criticalHp) {
    return { kind: 'hp', detail: `血量只剩 ${hp}` };
  }
  if (!threat) return null;

  if (DO_NOT_MELEE.has(threat.name) && threat.distance <= TUNING.dangerRadius) {
    return { kind: 'threat', detail: `${threat.name} 摸到 ${threat.distance} 格` };
  }
  if (threat.distance <= TUNING.fightRadius) {
    return { kind: 'threat', detail: `${threat.name} 贴到 ${threat.distance} 格` };
  }
  return null;
}

/**
 * ★ P42：为"脱困"选一个**真的能到达**的逃逸目标。
 *
 * ## 为什么不能用原任务的坐标
 *
 * 实机抓出来的（2026-09-25）：我原版直接拿 `S.task` 的目标当逃逸目标，
 * 而那次目标恰好是 `(-14, 87, -6)` —— 逐格探测发现 **`x=-13` 与 `x=-12`
 * 那两列整列都是实心岩体**，那个格子**根本不存在**（在岩石内部）。
 * 于是 `/unstick` 和 `/mine` 全部注定失败 —— **因为目标本身不可达**，
 * 跟"被不被困"没关系。白挖方块、白等超时。
 *
 * 想清楚之后，"脱困"的定义应该是：
 * **不是"到达原任务的坐标"，而是"能走到任何一个新的地方"。**
 *
 * ## 怎么选
 *
 * 半径 `R` 内逐格问"这里站得进去吗"（脚层 + 头层都非实心 —— 与她身高 1.8 格
 * 一致，`isStandable` 同源）。取**最近的**那个（近的成功率高、代价小）。
 * 全是实心 → 返回 `null` —— 那才是"真被围死了"，如实放弃。
 *
 * ⚠️ 刻意**不检查"能不能走到"**（那要跑寻路，正是当前坏掉的东西）。
 *    只检查"可站" —— 由 `/unstick` 或 `/mine` 去解决"怎么过去"。
 *
 * @param {{x:number,y:number,z:number}} p 她当前（取整后的）位置
 * @returns {Promise<{x:number,y:number,z:number,dist:number}|null>}
 */
async function pickEscapeTarget (p) {
  const R = 6;
  const here = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const cands = [];
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      if (dx === 0 && dz === 0) continue;
      // 垂直只在 ±2 内找 —— 脱困不需要往上爬/往下钻很深。
      for (const dy of [0, -1, 1, -2, 2]) {
        const x = here.x + dx, y = here.y + dy, z = here.z + dz;
        const d = Math.hypot(dx, dy, dz);
        if (d <= 0.5) continue;
        cands.push({ x, y, z, dist: Math.round(d * 10) / 10, d });
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);          // 先近后远（近的成功率高）
  const cap = Math.min(cands.length, 40);   // 最多问 40 格 —— 每次都是 HTTP 往返，要有界

  for (let i = 0; i < cap; i++) {
    const c = cands[i];
    try {
      // 脚层与头层都要能穿过 —— 这就是"她站得进去"的判据（身高 1.8 格）。
      const [feet, head] = await Promise.all([
        get(`/block?x=${c.x}&y=${c.y}&z=${c.z}`),
        get(`/block?x=${c.x}&y=${c.y + 1}&z=${c.z}`),
      ]);
      const passable = (b) => b && b.solid !== true && b.block !== 'unknown';
      const groundB = await get(`/block?x=${c.x}&y=${c.y - 1}&z=${c.z}`).catch(() => null);
      const groundOk = groundB && groundB.solid === true;   // 脚下得踩得住
      if (passable(feet) && passable(head) && groundOk) {
        return { x: c.x, y: c.y, z: c.z, dist: c.dist };
      }
    } catch (_) { /* 单格问不到就跳过 */ }
  }
  return null;
}

/**
 * ★ P42 自救逃逸（2026-09-25）：**确认被困之后，自己想办法出来。**
 *
 * ## 为什么必须有这个函数
 *
 * 2026-09-25 实测（field-log P42）：她被卡在一条**只有 1 格高**的天然缝隙里，
 * `/move` 四个方向**全部 `No path found``。决定性证据是从她所在格做 4 邻居泛洪
 * —— **连通分量 = 1**（整层 21 个 air 格只连通她自己那一格）。
 *
 * 真因不是 bug：**玩家身高 1.8 格，站位需要"脚层 + 头层"都非实心**，
 * 那条缝她站不进去；唯一能站的邻格在**对角**，而正交邻居全实心时 Minecraft
 * 不允许走对角。`canDig=false` 让寻路器**只绕不拆** → **永久卡死**。
 *
 * 后果：**她自己没有任何办法出来**。上一次是我从外面调 `/mine` 挖开方块救的。
 * 而用户的目标是「**自己**建立庇护所并持续发育」—— **"自己"要求能自救。**
 *
 * ## 三级手段（从便宜到侵入，逐级升级）
 *
 *   ① `POST /unstick` —— **临时**打开 `canDig`，让寻路器能拆挡路的方块。
 *      这是 `pathing.applyPolicy(..., { allowDig: true })` 那个"单次放行口子"
 *      的第一次真正使用。**政策由网桥恢复（finally 保证）**，不改变全局。
 *   ② `POST /mine` 挖**脚边一格** —— 兜底。这条路径 `bot.dig` 不经过寻路器，
 *      **完全不受 `canDig` 影响**（实测它是我上次救她出来的手段）。
 *      选"眼平高度或脚下那块"取决于哪个松——挖开 1 格就够她侧身出去。
 *   ③ 都失败 → 如实放弃，交回主循环按重试上限处理（**不谎报成功**）。
 *
 * ## 为什么"被围住"时挖一格有用
 *
 * 她卡住的原因是**通道高度不足**（1 格高 vs 身高 1.8 格）。
 * 挖掉任意一个"脚层或头层"的实心方块，就有机会把 1 格高的缝变成 2 格高 ——
 * 这正是上次脱困成功的操作：`/mine grass_block` 三次打开 2 格高通道后，
 * `POST /move` 立刻返回 `success: true` 且她真的走动了（`y 87→86`）。
 *
 * @param {{done:boolean, reason:object|null, moving:boolean}} flag
 * @returns {Promise<boolean>} 是否真的逃出来了
 */
async function trySelfUnstick (flag) {
  // 拿现场：位置 + 脚下三格 + 目标（任务里那个她想到达的地方）
  let st;
  try {
    st = await get('/status');
  } catch (_) { return false; }
  const p = st?.position;
  if (!p) return false;

  const task = S.task || {};
  const taskTarget = (task.x !== undefined && task.z !== undefined)
    ? { x: task.x, y: task.y, z: task.z }
    : null;

  log(`🆘 判定被困（清路 3 次仍无位移）—— 开始自救：位置 (${p.x},${p.y},${p.z})`
    + (taskTarget ? `，原目标 (${taskTarget.x},${taskTarget.y},${taskTarget.z})` : '，无原目标'));
  S.lastSelfUnstick = { at: Date.now(), from: { ...p }, taskTarget, steps: [] };

  // ---- ⓪ 先选一个**真的能到达**的"逃逸目标" ----
  //
  // ⚠️⚠️⚠️ 这一条是**实机抓出来的**，不是设计出来的（2026-09-25）：
  //
  //   我原版直接用 `S.task` 的目标当逃逸目标 —— 测试时目标恰好是
  //   `(-14, 87, -6)`，而逐格探测发现 **`x=-13` 与 `x=-12` 那两列整列都是实心岩体**，
  //   那个格子**根本不存在**（在岩石内部）。于是：
  //     · `/unstick` 失败（正确）
  //     · `/mine` 挖一格也失败（挖穿 2 列岩石？）
  //     · **三级手段全部注定失败 —— 因为目标本身就不可达。**
  //
  //   看穿这件事之后，"脱困"的正确定义浮出来了：
  //   **脱困不是"到达原任务的坐标"，而是"能走到任何一个新的地方"。**
  //   原任务的坐标可能本来就不可达（那是"做不到"，不是"被困"），
  //   用不可达的目标当逃逸目标 → 自救必然失败 → 白挖方块、白等超时。
  //
  //   所以：**在半径 6 内找一个"可站且不是她当前位置"的格子**当逃逸目标。
  //   找不到 → 那才是真的被困（四周真的没有可站格）。
  const escapeTarget = await pickEscapeTarget(p);
  S.lastSelfUnstick.escapeTarget = escapeTarget;
  if (!escapeTarget) {
    log('❌ 半径 6 内一个可站的格子都没有 —— 这才是真的被围死了');
    S.lastSelfUnstick.steps.push({ step: 'pick-target', error: '半径 6 内无可站格' });
    return false;
  }
  const target = escapeTarget;
  log(`🎯 逃逸目标选定 (${target.x},${target.y},${target.z})`
    + `（距离 ${target.dist}，与原目标${taskTarget ? '可能不同' : '无关'}）`);

  // ---- ① 临时放行 canDig，让寻路器自己拆出一条路 ----
  try {
    const r = await post('/unstick', {
      x: target.x, y: target.y, z: target.z,
      reason: 'watchdog: 清路 3 次仍无位移',
    }, CFG.actionTimeoutMs);
    S.lastSelfUnstick.steps.push({ step: 'unstick', escaped: !!r?.escaped, moved: r?.moved, why: r?.why });
    if (r?.escaped) {
      log(`✅ 自救成功（临时放行 canDig）：移动了 ${r.moved} 格 → (${r.to?.x},${r.to?.y},${r.to?.z})`);
      return true;
    }
    log(`⛔ 临时放行也没走通：${r?.why || '无位移'}`);
  } catch (e) {
    S.lastSelfUnstick.steps.push({ step: 'unstick', error: e.message });
    log(`⛔ /unstick 失败：${e.message}`);
  }

  // ---- ② 兜底：直接挖脚边一格（不经过寻路器，不受 canDig 影响）----
  //
  // 挖哪个？她要的是"把脚层或头层打开"，所以按**价值**排序：
  //   · 头层 (y+1) —— 挖开它通道立刻有 2 格高，最可能直接解决"身高不够"
  //   · 脚层 (y)   —— 同样能把通道变成 2 格高（她从上面那一格看下来）
  //   · 脚下一层 (y-1) —— 让她可以往下走一格
  // 用 `/block` 逐格问，**只挖实心的、且不是基岩/岩浆那一类**。
  const probes = [
    { x: p.x, y: p.y + 1, z: p.z, why: '头层（挖开它通道立刻有 2 格高）' },
    { x: p.x, y: p.y, z: p.z, why: '脚层' },
    { x: p.x, y: p.y - 1, z: p.z, why: '脚下（往下走一格）' },
  ];
  // ⚠️ 加四个正交邻居的**头层**：她被围住时，"自己这格的头层"可能是空气
  //    （否则她连站都站不进去），真正堵路的是**隔壁那格的头层**。
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    probes.push({ x: p.x + dx, y: p.y + 1, z: p.z + dz, why: `隔壁(${dx},${dz})的头层` });
  }

  for (const q of probes) {
    if (flag.done) return false;   // 危险先保命，别再挖了
    let b;
    try {
      b = await get(`/block?x=${Math.floor(q.x)}&y=${Math.floor(q.y)}&z=${Math.floor(q.z)}`);
    } catch (_) { continue; }
    const name = b?.block || b?.name;
    if (!name || name === 'unknown') continue;
    if (b?.solid !== true) continue;                    // 只挖实心的
    if (/^(bedrock|barrier|command_block|structure_void|obsidian|ancient_debris)$/.test(name)) continue;

    log(`⛏ 自救兜底：挖 (${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}) 的 ${name}（${q.why}）`);
    try {
      const r = await post('/mine', { blockName: name, count: 1 }, CFG.actionTimeoutMs);
      S.lastSelfUnstick.steps.push({ step: 'mine', at: { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) }, name, why: q.why, mined: r?.mined });
      if (!r?.mined) continue;                           // 没挖掉就换下一个目标
    } catch (e) {
      S.lastSelfUnstick.steps.push({ step: 'mine', name, error: e.message });
      continue;
    }

    // 挖完立刻试着走到目标 —— 目标可能只是"能站了"
    try {
      const r2 = await post('/move', { x: target.x, y: target.y, z: target.z }, CFG.actionTimeoutMs);
      S.lastSelfUnstick.steps.push({ step: 'move-after-mine', moved: r2?.moved, wasInside: r2?.wasInside });
      // ★ 用 P44 的 `moved` 判定 —— **"success: true 但 moved: 0"不算逃出来**
      //   （那正是 P44 那个"本来就在目标格里"的情形，她其实没动）。
      if (r2?.success && (r2.wasInside !== true) && (r2.moved == null || r2.moved > 0.5)) {
        log(`✅ 自救成功（挖开 ${name} 后走通）：moved=${r2.moved}`);
        return true;
      }
    } catch (e) {
      S.lastSelfUnstick.steps.push({ step: 'move-after-mine', error: e.message });
    }
  }

  // ---- ③ 如实放弃。**不谎报**（P32/P35/P41/P44 那个家族的教训）----
  log('❌ 自救失败 —— 三种手段都没能把她弄出来');
  return false;
}

/**
 * 长动作期间的看门狗：独立于主 tick，边等边观察，该打断就打断。
 * 打断手段是 POST /stop —— 网桥会清掉寻路和当前动作。
 *
 * 它同时负责**卡死检测**。为什么放在这里而不是主 tick 里：主 tick 在
 * `await runTask()` 上是阻塞的，等它回来时人早就顶在墙上 40 秒了。
 * 只有这个并发运行的循环才看得到"她正在原地空转"。
 *
 * @param {{done:boolean, reason:object|null, moving:boolean}} flag
 */
async function watchdog (flag) {
  // 卡死阈值以"游戏 tick"表达（可读），换算成看门狗采样次数（可实现）。
  // 例：14 tick × 1500ms ÷ 700ms ≈ 30 次采样 ≈ 21 秒。
  const needSamples = Math.max(3, Math.ceil((CFG.stuckTicks * CFG.tickMs) / CFG.watchdogMs));

  let prevPos = null;
  let stillCount = 0;
  let escapes = 0;

  while (!flag.done) {
    await sleep(CFG.watchdogMs);
    if (flag.done) return;
    try {
      const [st, near] = await Promise.all([get('/status'), get('/nearby')]);
      if (flag.done) return;

      // ① 危险优先：命都快没了就别管卡不卡了
      const reason = shouldInterrupt(st.health, nearestHostile(near.entities || []));
      if (reason) {
        flag.done = true;
        flag.reason = reason;
        await post('/stop');
        log(`🛑 看门狗打断正在做的活：${reason.detail}`);
        return;
      }

      // ② 卡死：只在"这个动作本来就要位移"时才判，否则待命会被误判成卡住
      if (flag.moving) {
        const cur = st.position;
        const r = isStuck(prevPos, cur, stillCount, needSamples, CFG.stuckMinDelta);
        stillCount = r.ticks;
        prevPos = cur || prevPos;

        if (r.stuck) {
          escapes++;
          // 清掉寻路 —— 这是脱困本身：让她放弃当前那条走不通的路线重新规划。
          // 主循环下一次 tick 会重新下发同一个任务（因为 S.task 被保留了）。
          try { await post('/stop'); } catch (_) {}
          log(`🧱 卡死检测：连续 ${stillCount} 次采样没位移，已清路等待重新规划（第 ${escapes} 次）`);

          if (escapes >= 3) {
            // ★★★ P42 自救逃逸（2026-09-25）：**清路 3 次仍无位移 = 确认被困。**
            //
            //   这是 P42 的现场：她被卡在"只有 1 格高"的天然缝隙里，
            //   四个方向全部 `No path found` —— 因为 `canDig=false` 让寻路器
            //   **只绕不拆**，而那条缝她身高（1.8 格）根本站不进去，
            //   唯一能站的邻格在对角（正交邻居全实心时不允许走对角）。
            //   **`No path` 是正确判定；但她自己出不来了。**
            //
            //   上一次是我从外面调 `/mine` 挖开方块才把她放出来的 ——
            //   而用户要的是「**自己**建立庇护所并持续发育」。**"自己"要求能自救。**
            //
            //   ⚠️ 为什么放在这里（"清路 3 次都没用"之后）而不是更早：
            //     前两次清路是**便宜的**（不动世界，只重新规划），很多时候就够了。
            //     而 `/unstick` 会**临时打开 canDig** —— 开了就可能顺手拆方块
            //     （实测过被拆掉玩家的装饰），所以必须**确认真的绕不过去**才放行。
            //     判据就是这里：清路 3 次 + 每次都是"连续采样无位移"。
            const freed = await trySelfUnstick(flag);
            if (freed) {
              // 自己出来了 —— 不算失败，让主循环接着做原来的事
              escapes = 0;
              stillCount = 0;
              prevPos = null;
              return;
            }
            // 自救也失败 —— 不再无限空转，交回主循环按"重试上限"处理
            flag.done = true;
            flag.reason = { kind: 'stuck', detail: `连续 ${escapes} 次清路仍无位移（自救也没成功）` };
            return;
          }
          stillCount = 0;   // 给它一个重新计数的窗口
          prevPos = null;
        }
      } else {
        stillCount = 0;
        prevPos = null;
      }
    } catch (_) {
      // 看门狗自己出错不该影响主流程，静默重试下一轮
    }
  }
}

/**
 * 记一次任务尝试，并在超过上限时告诉调用方"该放弃了"。
 *
 * 为什么需要这个：长程智能体最经典的死法就是**卡在一个永远做不到的目标上无限循环**。
 * 没有上限，她就会一直"重试 → 失败 → 重试"，看起来在干活，其实什么都没发生。
 *
 * 计数分两个维度，因为两种"没成功"的性质完全不同：
 *   failures —— 真的做不到（无路可走、没有物品、护栏拦下）
 *   attempts —— 所有非成功的尝试，包含"先保命"的中断
 * 中断不该算失败（苦力怕路过不是任务的问题），但如果她被同一件事反复打断
 * （例如血量一直没回、任务又一直重试），attempts 上限会把循环兜住。
 */
function noteTaskAttempt (task, { failed }) {
  const sig = taskSig(task);
  const rec = S.taskFailures.get(sig) || { failures: 0, attempts: 0 };
  rec.attempts++;
  if (failed) rec.failures++;
  S.taskFailures.set(sig, rec);
  return rec;
}

function clearTaskRecord (task) {
  S.taskFailures.delete(taskSig(task));
}

/** 这个任务是不是已经试到头了？返回原因字符串，或 null 表示还能试。 */
function taskExhausted (task) {
  const rec = S.taskFailures.get(taskSig(task));
  if (!rec) return null;
  if (rec.failures >= CFG.maxTaskFailures) {
    return `同一个任务已经失败 ${rec.failures} 次（上限 ${CFG.maxTaskFailures}）`;
  }
  if (rec.attempts >= CFG.maxTaskAttempts) {
    return `同一个任务已经尝试 ${rec.attempts} 次都没成（上限 ${CFG.maxTaskAttempts}）`;
  }
  return null;
}

// ---- P31：自主动作的失败退避 --------------------------------------------------
//
// 纯函数 + 显式时间参数，所以能直接自测（不依赖真实时钟）。
// 三个函数分别管：记账 / 查询 / 成功清零。

/**
 * 记一次自主动作失败。
 *
 * @param {Map} table      失败表（`S.selfFailures`）
 * @param {string} action  动作名（如 'gather'）
 * @param {number} now     当前时间戳（显式传入，便于自测）
 * @returns {{failures:number, until:number}} 更新后的记录
 */
function noteSelfFailure (table, action, now = Date.now()) {
  const rec = table.get(action) || { failures: 0, until: 0 };
  rec.failures += 1;
  // 退避时长：**前 `grace` 次不罚**（当作偶发），第 grace+1 次起按指数拉长，封顶 90 秒。
  //
  // ⚠️ 判据是 `>` 不是 `>=` —— 这里我第一版写成 `>=`，自测立刻红了：
  //    `grace = 2` 时 `failures = 2` 就触发退避，实际只有 **1 次**免费机会，
  //    和注释里写的"前两次不罚"**差一个**。
  //    这是典型的 off-by-one **语义歧义**：代码能跑、不报错，只是行为和文档不符。
  //    定死口径：`grace = N` ⇔ "允许 N 次免费失败，第 N+1 次开始罚"。
  //    所以用 `>`。`selfActionBlocked` 必须用同一个口径（也是 `>`）。
  const grace = CFG.selfFailGrace ?? 2;
  if (rec.failures > grace) {
    const over = rec.failures - grace;                            // 1, 2, 3...
    const ms = Math.min(90000, 4000 * Math.pow(2, over - 1));     // 4s, 8s, 16s... 封顶 90s
    rec.until = now + ms;
  }
  table.set(action, rec);
  return rec;
}

/**
 * 这个自主动作现在是不是在退避期里？
 * @returns {boolean} true = 暂时别选它
 */
function selfActionBlocked (table, action, now = Date.now()) {
  const rec = table.get(action);
  if (!rec) return false;
  // ⚠️ 口径必须与 noteSelfFailure 一致（`>`）—— 两处用同一句话定义"几次算够"。
  return rec.failures > (CFG.selfFailGrace ?? 2) && now < rec.until;
}

/** 成功了 → 清零。必须清，否则失败次数只增不减，迟早把所有动作都退避掉。 */
function clearSelfFailure (table, action) {
  table.delete(action);
}

async function runTask (task) {
  S.action = `task: ${task.type}`;
  const t0 = Date.now();

  // 先问一句"是不是已经试到头了"。放在最前面，连网桥都不碰 ——
  // 对一个已知做不到的目标反复发请求，只是在浪费她的时间和玩家的耐心。
  const exhausted = taskExhausted(task);
  if (exhausted) {
    S.taskResult = { task, error: exhausted, gaveUp: true, at: Date.now() };
    events.append({ kind: 'task', phase: 'gave_up', type: task.type, detail: exhausted });
    log(`🛑 放弃任务 ${task.type}：${exhausted}`);
    await speak('fail', '诶…这个我试了好几次都不行，先不弄了，等下换个法子');
    if (S.task === task) S.task = null;
    return { ok: false, gaveUp: true, error: exhausted };
  }

  events.append({ kind: 'task', phase: 'start', type: task.type, detail: JSON.stringify(task) });

  const flag = { done: false, reason: null, moving: MOVING_ACTIONS.has(task.type) };
  const wd = LONG_ACTIONS.has(task.type) ? watchdog(flag) : null;

  try {
    let result;
    switch (task.type) {
      case 'mine': {
        // 护栏：CFG.allowDig 是全局的"禁止挖方块"开关。
        // 默认放行（挖矿本来就要拆方块），但玩家说"别拆我东西"时可以一键关掉，
        // 关掉之后连显式的 mine 任务也会被拦 —— 这是最后一道闸，不是唯一一道。
        const g = guard('mine', { allowDig: CFG.allowDig });
        if (g.verdict === 'block') throw new Error(`护栏拦下：${g.reason}`);
        await equipBestTool('_pickaxe');
        result = await post('/mine', {
          blockName: task.blockName,
          count: task.count ?? 1,
        }, CFG.actionTimeoutMs);
        break;
      }
      case 'collect':
        result = await post('/collect', {
          itemName: task.itemName,
          count: task.count ?? 1,
        }, CFG.actionTimeoutMs);
        break;
      case 'craft':
        result = await post('/craft', { itemName: task.itemName, count: task.count ?? 1 });
        break;
      case 'place': {
        // 护栏：放置必须同时有"放什么"和"放哪里"，否则别去动世界
        const g = guard('place', {
          hasPlaceable: Boolean(task.itemName),
          hasTarget: task.x !== undefined && task.y !== undefined && task.z !== undefined,
        });
        if (g.verdict === 'block') throw new Error(`护栏拦下：${g.reason}`);
        // 她会先走到目标附近 —— 隔太远是放不到的
        result = await post('/place', {
          itemName: task.itemName,
          x: task.x, y: task.y, z: task.z,
        }, CFG.actionTimeoutMs);
        break;
      }
      case 'give':
        // 把物品递给玩家。先靠近，再朝他的方向丢。
        if (task.playerName) {
          await post('/follow', { playerName: task.playerName }).catch(() => {});
        }
        result = await post('/drop', {
          itemName: task.itemName,
          count: task.count,
          playerName: task.playerName,
        }, CFG.actionTimeoutMs);
        break;
      case 'goto':
        result = await post('/move', { x: task.x, y: task.y, z: task.z }, CFG.actionTimeoutMs);
        break;
      case 'follow':
        result = await post('/follow', { playerName: task.playerName });
        break;
      case 'say':
        result = await speak('task', task.message, { force: true });
        break;
      default:
        throw new Error(`未知任务类型：${task.type}`);
    }
    // 看门狗可能在动作返回前就把它打断了 —— 那种情况不算成功
    if (flag.done && flag.reason) throw new Error(`被打断（${flag.reason.detail}）`);

    S.taskResult = { task, result, at: Date.now() };
    events.append({ kind: 'task', phase: 'done', type: task.type, ms: Date.now() - t0 });
    clearTaskRecord(task);
    log(`✅ 任务完成 ${task.type}: ${JSON.stringify(result).slice(0, 120)}`);
    return { ok: true, result };
  } catch (e) {
    S.taskResult = { task, error: e.message, at: Date.now() };
    const kind = flag.done && flag.reason ? flag.reason.kind : null;

    if (kind === 'stuck') {
      // 卡住不是"做不到"，是"这条路走不通"。清掉寻路后值得再试一次 ——
      // 所以这里**保留** S.task，让主循环重新下发；重试上限负责兜底。
      noteTaskAttempt(task, { failed: true });
      S.lastStuck = { detail: flag.reason.detail, at: Date.now() };
      events.append({ kind: 'task', phase: 'stuck', type: task.type, detail: flag.reason.detail });
      log(`🧱 任务卡住 ${task.type}：${flag.reason.detail}（已清路，下次重试）`);
      // 不说话 —— 卡住既不是危险，也不是她做错了什么。
      // 记在案，由 agent 判断要不要告诉玩家。
      return { ok: false, stuck: true, error: flag.reason.detail };
    }

    if (kind) {
      // 被看门狗打断不是"做不到"，是"先保命" —— 别让她道错歉。
      // 任务**保留**：危险过去之后她会自己接着干（真人被打断一次不会忘掉整件事）。
      noteTaskAttempt(task, { failed: false });
      events.append({ kind: 'task', phase: 'interrupted', type: task.type, detail: flag.reason.detail });
      log(`⚠️ 任务中断 ${task.type}：${flag.reason.detail}（危险过去后接着做）`);
      const line = kind === 'hp'
        ? '呜…我血不多了，先停一下'
        : '诶…有东西过来了，先躲一下！';
      await speak('danger', line);
      return { ok: false, interrupted: true, error: flag.reason.detail };
    }

    // 真正的失败：结构上就做不到（无路、没物品、护栏拦下）。
    // 重试同一个"做不到"的目标没有意义，所以清掉任务；但失败计数留着，
    // 这样 agent 再派同样的活时会被直接拒绝，而不是让她再撞一次墙。
    const rec = noteTaskAttempt(task, { failed: true });
    events.append({ kind: 'task', phase: 'failed', type: task.type, detail: e.message });
    log(`❌ 任务失败 ${task.type}: ${e.message}（第 ${rec.failures} 次）`);
    // 做不到就说出来 —— 这是"她自己出事了"，允许开口
    await speak('fail', `诶…这个我好像做不到（${e.message}）`);
    if (S.task === task) S.task = null;
    return { ok: false, error: e.message };
  } finally {
    flag.done = true;
    if (wd) await wd.catch(() => {});
    // 注意：只有"成功"和"真失败"会清 S.task。被打断 / 卡住都保留任务，
    // 让她事后自己接着做 —— 真人被打断一次不会把整件事忘掉。
  }
}

// -------------------------------------------------------------- 聊天：只听不答

/**
 * 看玩家说了什么。autopilot 自己**不生成回答** —— 它没有语言能力，
 * 硬答只会变成"老师"。它只做两件事：
 *   ① 被点名/被提问时，短促地应一声（"诶？我在～"），表示她在听
 *   ② 把问题存进 pendingQuestions，等有脑子的 agent 来答
 */
function watchChat (messages) {
  let fresh = 0;   // 本次真正的新消息数（用于验证耳朵回路在工作）
  for (const m of messages) {
    if (m.position !== 'chat') continue;
    const key = `${m.t}|${m.text}`;
    if (S.seenChat.has(key)) continue;
    S.seenChat.add(key);
    if (S.seenChat.size > 300) S.seenChat.clear();

    // 她自己说的，跳过。
    // ⚠️ 这一步必须在 fresh++ **之前** —— 否则 earsHeard 会把
    // "她自己说的话"也统计成"听到玩家说话"，指标虚高，
    // 于是"耳朵到底有没有在工作"就再也看不出来了。
    if (/^<Angel_ICE>/.test(m.text)) continue;
    fresh++;

    // "在跟她说话"的判定。不能只认名字 —— 玩家经常直接说"你…"，
    // 例如 "<Ka_sum1> you are my cooker only belong to me i love u" 就是对她说的。
    const mentioned =
      /Angel_ICE|Angel|安琪|angel/i.test(m.text) ||
      /\b(you|your|yours|u|ur|you're|youre|your'e)\b/i.test(m.text) ||
      /你|妳|咱/.test(m.text);

    const isQuestion =
      /[?？]/.test(m.text) ||
      /怎么|为什么|哪|多少|能不能|可以吗|帮我|在哪|有没有/.test(m.text) ||
      /\b(how|what|where|why|which|can you|could you|help|do you)\b/i.test(m.text);

    if (mentioned || isQuestion) {
      // 重启后重放出来的旧消息：记录，但不当新提问处理
      const stale = typeof m.t === 'number' && m.t < S.startedAt - STALE_GRACE_MS;
      S.pendingQuestions.push({ at: Date.now(), text: m.text, mentioned, stale });
      if (S.pendingQuestions.length > 20) S.pendingQuestions.shift();
      log(`👂 收到${stale ? '（启动前的旧消息）' : ''}提问${mentioned ? '（在对她说）' : ''}：${m.text}`);

      // ---- 记下"她刚被人说话"，供后续决策加权（**不打断当前动作**）----------
      // 只记 `mentioned` 的：旁人之间的闲聊不该让她分心。
      // 旧消息（重启重放）不记 —— 否则一上线就会以为"刚有人在叫她"。
      if (!stale && mentioned) {
        S.lastAddressedAt = Date.now();
        S.lastAddressedText = m.text.slice(0, 120);
      }

      // 只在"被点名 + 真的是个问题 + 不是重放的旧消息"时短促应一声。
      // 纯陈述（比如 "<玩家> i love u"）不自动应答 —— 罐头回复在那种语境下会答错语气，
      // 记进 pendingQuestions 让有脑子的 agent 来答。
      if (!stale && CFG.answerChat && mentioned && isQuestion) {
        speak('chat', '诶？我在呀～');
      }
    }
  }
  return fresh;
}

/**
 * 耳朵：一条**独立于 tick** 的轻量回路，只做一件事 —— 听玩家说话。
 *
 * 为什么必须独立：`chatlog` 是在 tick 开头读的，而 tick 会被 `await perform()`
 * 阻塞最长 45 秒（挖矿、赶路都是长动作）。于是"她在干活"就等于"她听不见你说话"，
 * 你打完一句话得等她把矿挖完才可能有反应。玩家能直接感受到这个延迟。
 *
 * ⚠️ 这**不是**"拆出第三个子 agent"，两件事要分清：
 *   - 它不做决策、不碰身体、不改变任何状态，只做一件 **I/O 等待**的事（读聊天记录）。
 *   - 并行的正当理由只有一个：**把 I/O 等待从时间敏感的回路上挪走**。
 *     看门狗（危险时停手）用的是同一条原则 —— 它也必须独立，因为 tick 同样会被堵住。
 *
 * 身体始终只有 tick 一个主人在动。这就是为什么"行动"不能并行、"听/看"可以。
 *
 * 去重靠 `watchChat` 里的 `S.seenChat`：tick 和耳朵都调它，同一条消息只会被处理一次，
 * 所以两处都留着是安全的，不会重复应答。
 */
async function earsLoop () {
  while (S.running) {
    // 记"尝试"，不管成没成。
    // ⚠️ 一开始我把计数写在 get() 成功之后，结果离线时 polls 恒为 0 ——
    // 而"耳朵在跑但读不到"和"耳朵根本没在跑"看起来完全一样，等于没测。
    // 现在 polls 证明回路活着，errors 说明它能不能真读到。
    S.earsPolls++;
    S.earsLastPollAt = Date.now();
    try {
      const r = await get('/chatlog');
      const msgs = r?.messages || [];
      if (msgs.length) {
        const fresh = watchChat(msgs);
        // 只统计"通过耳朵听到的"——tick 自己也会读，两边加起来才是全部
        if (fresh) S.earsHeard += fresh;
      }
      S.earsErrors = 0;
      S.earsLastError = null;
    } catch (e) {
      // 网桥/服务器没连上时这里必然失败，是常态，不刷屏
      S.earsErrors++;
      S.earsLastError = e.message;
    }
    await sleep(CFG.earsMs);
  }
}

// -------------------------------------------------------------------- 主循环

/**
 * 问决策层：现在该干什么。
 *
 * 状态里只放决策真正需要的东西 —— Jev 按 input token 计费，
 * 而且无关字段一抖动，决策缓存就永远命中不了。
 *
 * @returns {Promise<{action:string, backend:string, confidence:number, degraded?:string}>}
 */
async function chooseAction ({ hp, threat, player, isDay, scan, drops, inventory, nearby, food }) {
  // ⚠️ `capability` 必须在 `self` **之前**算 —— `buildSelfNeeds` 要吃它的结论。
  const capability = buildCapability({ scan, drops, inventory, nearby, dayState: { isDay } });

  const state = {
    hp,
    // 饥饿值也要进来 —— P24 之前 `chooseAction` **根本不接收 food**，
    // 于是决策层无从知道她饿了。这是"她自己不会找吃的"的一个直接成因。
    food,
    // 距离取整：1.37 和 1.41 对决策没有区别，却会让缓存失效
    threat: threat ? { name: threat.name, distance: Math.round(threat.distance) } : null,
    task: S.task ? { type: S.task.type } : null,
    player: player ? { name: player.username, distance: player.distance ?? null } : null,
    isDay,
    // ⚠️ `capability` 是**菜单能不能出现某个动作**的判据（见 decision.js 的
    //    buildActionMenu）。必须由这里给，因为"背包里到底有没有能吃的东西"
    //    只有 autopilot 拿得到（它才调 /inventory）。
    //    把"做不到的动作"放进菜单会让后端选一个必然失败的动作 ——
    //    LLM 不知道她手上有什么，它只看得到判据文字。
    capability,
    // ---- 自主生存（field-log P24）-------------------------------------------
    // 「我自己现在需要什么」。判定的唯一实现在 decision.js 的 buildSelfNeeds，
    // 这里只负责把证据喂进去 —— 两处各判一遍正是 P2b/P18 的教训。
    self: decision.buildSelfNeeds({ hp, food, capability }),
    // ---- 注意力偏移（**不是**打断）------------------------------------------
    // 「刚才有人跟我说话」这件事会被表达成一个会自然衰减的开关，
    // 由 decision.js 用它调整 task 与 follow/approach 的权重。
    //
    // 为什么放在 state 里而不是直接改 task：state 是决策的**输入**，
    // 改 task 是改决策的**结果** —— 后者会让"她为什么没接着挖矿"这件事
    // 在复盘时看不出原因（task 看起来就像被谁偷偷清掉了）。
    attention: buildAttention(),
  };

  // 只有"当前做得到"的动作进菜单。
  // 语言跟着 decision.js 的 criteriaLang 走 —— 官方说英语准确率最高、CJK 不等同，
  // 所以这个开关必须一路透到菜单构造，否则改了环境变量却不生效。
  const lang = DCFG.criteriaLang;
  const rawMenu = buildActionMenu(state, lang);

  // ⚠️⚠️ P31：**退避过滤**。如果一个自主动作正在退避期里，就不让它进菜单。
  //
  //    这是死循环的第二道防线。第一道（`shelter` 的前置条件）只能保证
  //    "没砖时不去搭遮蔽"，但挡不住"没砖、去采、采也采不到"这种**下一层**的循环。
  //    有了这里，`gather` 连续失败 3 次后会被暂时移出菜单，让 `explore` 顶上
  //    —— 她去换个地方看看，而不是站在同一块空地上反复伸手。
  //
  //    ⚠️ 有个**必须避开的陷阱**：如果退避把菜单削成空数组，`decide` 就无从选起，
  //       那又是一种卡死（只不过卡在决策层）。所以过滤后若为空，**放弃过滤**，
  //       保留原菜单 —— 宁可让她再试一次，也不能让她没有可选项。
  const blocked = rawMenu.filter(m => selfActionBlocked(S.selfFailures, m.id));
  const menu = blocked.length && blocked.length < rawMenu.length
    ? rawMenu.filter(m => !selfActionBlocked(S.selfFailures, m.id))
    : rawMenu;
  if (blocked.length) {
    // 留痕：让 `GET /autopilot/events` 看得见"这一拍少了哪些动作、为什么"
    state.blocked = blocked.map(m => m.id);
    log(`⏸ 暂时跳过 ${blocked.map(m => m.id).join('/')}（连续失败，退避中）`);
  }
  state.menu = menu;   // 让缓存把"可选动作集"也算进决策身份

  // ---- 用哪一套 instructions（solo / company）--------------------------------
  //
  // ⚠️ 这是 P24 的另一半根因。旧版**只有一条** instructions，内容是
  //    「宁可安静地待命，也不要自己找事做」—— 和用户的目标直接矛盾。
  //    菜单决定"能选什么"，instructions 决定"倾向于选什么"：
  //    只修菜单不修这句话，等于开了门却贴着"请勿入内"。
  //
  //    分派判据在 decision.js（pickInstructMode），这里不重复实现。
  const mode = decision.pickInstructMode(state);
  state.instructMode = mode;

  // 留痕用的紧凑状态（不含 menu 数组本身，否则每条记录都要塞一遍完整菜单）
  const compact = {
    hp: state.hp, threat: state.threat, task: state.task,
    player: state.player, isDay: state.isDay,
    capability: state.capability,
    self: state.self,          // ← P24：让 `GET /autopilot/events` 能看出"她当时觉得需要什么"
    instructMode: mode,        // ← 以及"她用的是哪套人格指令"
  };
  const ids = menu.map(m => m.id);
  const criteriaOf = id => menu.find(m => m.id === id)?.criteria || null;

  try {
    const r = await decide(state, {
      act: {
        type: 'choice',
        instructions: ACTION_INSTRUCTIONS[mode]?.[lang] || ACTION_INSTRUCTIONS[mode]?.zh
          || ACTION_INSTRUCTIONS.company.zh,
        options: menu,
      },
    });

    const a = r.answers?.act;
    if (!a || typeof a.choice !== 'string') {
      throw new Error('决策层没有返回 choice');
    }

    const confidence = a.confidence ?? 1;

    // 置信度不够就不冒险 —— fail closed，退回待命，而不是硬挑一个
    if (confidence < DCFG.minConfidence) {
      log(`🤔 决策置信度 ${confidence} 低于 ${DCFG.minConfidence}，改为待命`);
      return {
        action: 'idle', backend: r.backend, confidence, lowConfidence: true,
        menu: ids, criteria: criteriaOf('idle'), state: compact,
      };
    }

    const out = { action: a.choice, backend: r.backend, confidence };
    // 菜单项可以带"参数"（目前只有 equip 的 want: 'tool'|'weapon'）。
    // 必须在这里合并进来 —— 决策层只回答"选哪个"，不回答"用什么参数"，
    // 而 perform() 需要这个参数才能把"换工具"和"换武器"区分开。
    const picked = menu.find(m => m.id === a.choice);
    if (picked) {
      for (const k of Object.keys(picked)) {
        if (k === 'id' || k === 'criteria' || k === 'priority') continue;
        out[k] = picked[k];
      }
    }
    if (r.degraded) out.degraded = r.degraded;
    if (r.cached) out.cached = true;
    // 留痕用：把"当时有哪些路可以走、她为什么走这条"一起带出去
    out.menu = ids;
    out.criteria = criteriaOf(a.choice);
    out.state = compact;
    return out;
  } catch (e) {
    log(`决策层异常，退回待命：${e.message}`);
    return {
      action: 'idle', backend: 'error', confidence: 0, error: e.message,
      menu: ids, criteria: criteriaOf('idle'), state: compact,
    };
  }
}

async function tick () {
  S.tick++;
  const P = await perceive();

  if (!P.st?.connected) {
    S.action = 'offline（网桥或服务器没连上）';
    return;
  }

  // 玩家说话 → 记录（也用于应答）
  if (P.chat.length) watchChat(P.chat);

  // 死亡/掉血跟踪
  if (S.lastHp != null && P.st.health != null && P.st.health < S.lastHp) {
    log(`💔 掉血 ${S.lastHp} → ${P.st.health}`);
  }
  if (S.lastHp != null && S.lastHp > 0 && P.st.health === 0) S.deaths++;
  S.lastHp = P.st.health;

  const self = P.st.position || {};
  const threat = nearestHostile(P.nearby);
  const hp = P.st.health ?? 20;
  const player = P.players.find(p => !p.isSelf) || null;

  // 记住最后看到玩家的位置 —— "人还在线但看不见"时要用
  if (player?.position) {
    S.lastSeenPlayer = { ...player.position, name: player.username, t: Date.now() };
    // ⚠️ P24：玩家身边通常就是**最安全的地方**（有建筑、有遮蔽、有灯）——
    //    所以把"看到玩家的位置"同时记成安全点，供 `retreat` 低血时回退。
    //    只在**没有贴身威胁**时记 —— 否则会把她正在逃命的位置当成"安全点"，
    //    下次低血还跑回去送死。
    if (!threat) {
      S.lastSafeSpot = { x: player.position.x, y: player.position.y, z: player.position.z, t: Date.now() };
    }
  }

  // ---- 反射：不走大脑，命中就短路本次 tick -----------------------------------
  //
  // 为什么放在决策**之前**：饿/憋气这两件事没有"该不该做"的讨论空间，
  // 而 decision.js 要么是一次网络往返（慢），要么至少是菜单构造 + 排序。
  // 反射命中时这些都省掉 —— 这就是"反应快"最直接的一刀。
  //
  // 对标：HiyoriAI 的 `reflexEngine`（`food<=6` 直接返回 eat 动作，零 LLM 调用）、
  //      Mindcraft 的 `modes.js`（`self_preservation` 等 mode 独立于主循环跑）。
  if (CFG.reflex) {
    const hit = reflex.evaluate(
      { food: P.st.food, health: P.st.health, oxygen: P.st.oxygen },
      P.inventory,
      P.scan?.standing,
    );
    if (hit) {
      S.action = `reflex:${hit.name}（${hit.reason}）`;
      S.lastReflex = hit;
      events.append({
        kind: 'reflex', tick: S.tick, id: hit.id, name: hit.name,
        args: hit.args || {}, reason: hit.reason,
      });
      let outcome;
      try {
        outcome = await performReflex(hit);
      } catch (e) {
        outcome = { ok: false, error: e.message };
      }
      events.append({
        kind: 'outcome', tick: S.tick, action: hit.id,
        ok: outcome.ok !== false, error: outcome.error || null, ms: 0, note: S.action,
      });
      // ⚠️ 反射命中时**本轮不再问后端**。这不是偷懒：一个 tick 里做两件事
      //    会争同一只手（吃要换手、浮要跳跃），而且"吃完接着干"本来就要等下一轮。
      //
      // 但**出口要快**：饿/憋气/着火都希望下一拍立刻复查，所以给最快档。
      invalidatePerceiveCache(['inventory']);   // 刚吃过，背包变了
      return { ms: Math.max(CFG.tickProfile.minMs, Math.round(CFG.tickMs * CFG.tickProfile.combatFactor)),
               mode: 'reflex', factor: CFG.tickProfile.combatFactor };
    }
  }

  // ---- 决策：交给 decision.js，不再走写死的优先级链
  //
  // ⚠️ P24 补的两个入参：`nearby`（能打出"周围有几只鸡"）与 `food`（能判"她饿不饿"）。
  //    在此之前 chooseAction 只拿到 `nearestDrop(P.nearby)` —— 一个**单个**实体，
  //    信息量不足以支撑自主决策（数不出可狩猎的数量）。所以这里改传原始 `P.nearby`，
  //    由 buildCapability 自己去统计。
  const chosen = await chooseAction({
    hp,
    threat,
    player,
    isDay: P.st.isDay,
    scan: P.scan,
    drops: nearestDrop(P.nearby),
    inventory: P.inventory,
    nearby: P.nearby,                              // ← P24：自主生存要用（数被动生物）
    food: P.st?.food ?? null,                      // ← P24：自主生存要用（判饿不饿）
  });

  S.lastDecision = chosen;   // 供 GET /autopilot 复盘"她为什么这么做"

  // 留痕 ①：决策身份。只记"选了什么"是没用的 —— 必须同时记下
  // "当时有哪些路可以走"，否则复盘时无法判断这个选择是对是错。
  events.append({
    kind: 'decision',
    tick: S.tick,
    action: chosen.action,
    backend: chosen.backend,
    confidence: chosen.confidence,
    menu: chosen.menu || [],
    criteria: chosen.criteria || null,
    state: chosen.state || null,
    cached: chosen.cached || false,
    degraded: chosen.degraded || null,
    lowConfidence: chosen.lowConfidence || false,
  });

  // ---- 执行
  const t0 = Date.now();
  let outcome;
  try {
    // ⚠️ P24：`nearby` 也要传进去 —— `hunt` / `forage` 需要"周围有几只被动生物"，
    //    而那个信息只有 `P.nearby`（原始实体数组）有。
    outcome = await perform(chosen, { threat, player, self, inventory: P.inventory, nearby: P.nearby }) || { ok: true };
  } catch (e) {
    outcome = { ok: false, error: e.message };
    log(`动作失败（${chosen.action}）：${e.message}`);
  }

  // ⚠️ P31：**记账**。自主动作的成功/失败要落进退避表 —— 这是死循环的第二道防线。
  //
  //    ⚠️ 只对**自主动作**记账，不管 `work`（那是玩家派的活，自己有 taskFailures）。
  //       纯粹的瞬时动作（explore/idle）不在 SELF_ACTIONS 里 —— 它们失败没有副作用，
  //       退避它们只会让她变呆。（`pickup` 在，理由见 SELF_ACTIONS 的定义。）
  if (SELF_ACTIONS.has(chosen.action)) {
    if (outcome.ok === false) {
      const rec = noteSelfFailure(S.selfFailures, chosen.action);
      // ⚠️ 阈值必须与 `noteSelfFailure` 的判据一致（`> grace`）。
      //
      //    P39（2026-09-25 实机抓出）：第一版写成 `>= grace`，
      //    于是 `failures === grace`（还没真正开始退避、`until` 仍是 0）时也会进这个分支，
      //    算出 `0 - Date.now()` = **一个巨大的负数**。实机事件里看到
      //    `backoff=-1790289721s` —— 那是 `until` 为 0 的直接后果。
      //
      //    两个错叠在一起：
      //      ① 阈值与 noteSelfFailure 不一致（一个 `>=` 一个 `>`）
      //      ② 字段名叫 `untilMs`（听着像**时间戳**），装的却是**时长**。
      //         名字骗了读的人，也骗了我 —— 我第一眼看以为是时钟不对。
      //
      //    修法：阈值统一 `> grace`；字段改名 `backoffMs`（明确是**时长**）；
      //    并且 clamp 到 ≥ 0 —— 即使将来逻辑再漂移，也不会出现负数。
      const grace = CFG.selfFailGrace ?? 2;
      if (rec.failures > grace) {
        const backoffMs = Math.max(0, rec.until - Date.now());
        events.append({
          kind: 'self_backoff', tick: S.tick, action: chosen.action,
          failures: rec.failures,
          backoffMs,                              // ← 时长（ms），不是时间戳
          backoffSec: Math.round(backoffMs / 1000),
          reason: outcome.error || null,
        });
        log(`⏸ ${chosen.action} 连续失败 ${rec.failures} 次，退避 ${Math.round(backoffMs / 1000)}s` +
            (outcome.error ? `（${outcome.error}）` : ''));
      }
    } else {
      // 成功 → 清零。**必须清**，否则失败次数只增不减，迟早把所有动作都退避掉。
      clearSelfFailure(S.selfFailures, chosen.action);
    }
  }

  // 留痕 ②：结果。决策 + 结果配对，才构成可回归的一条证据。
  events.append({
    kind: 'outcome',
    tick: S.tick,
    action: chosen.action,
    ok: outcome.ok !== false,
    error: outcome.error || null,
    interrupted: outcome.interrupted || false,
    stuck: outcome.stuck || false,
    gaveUp: outcome.gaveUp || false,
    ms: Date.now() - t0,
    note: S.action,
  });

  // 长动作**做完**之后，背包/地形大概率变了 —— 让慢环缓存立刻失效，
  // 否则下一拍她看到的是"做这件事之前的世界"，会把刚拿到的东西当成没有。
  // 这就是 P1（挖完不知道捡到没）在感知层的对应修复。
  const worked = /^(mine|collect|place|pickup|eat|equip)/.test(String(chosen.action || ''));
  if (worked && outcome?.ok !== false) invalidatePerceiveCache(['inventory', 'scan']);

  // 告诉主循环：下一拍该多快（见 pickTickDelay）
  return pickTickDelay({ st: P.st, threat, action: chosen.action });
}

/**
 * 「刚才有没有人在跟她说话」，以及这件事对**后续行为**的影响。
 *
 * ## 为什么是这个设计（而不是打断）
 *
 * 用户明确要求：「不打断工作，只是改变后续行为」。
 *
 * Mindcraft 的 `self_prompter.handleUserPromptedCmd()` 走的是另一条路：
 * 玩家一发言就 `stopLoop()`，正在挖的矿被 `stopDigging()` 掐掉。
 * 好处是响应快，代价是**半截的活全废了** —— 挖到一半的矿、走到一半的路。
 *
 * 我们的做法是只改**权重**：
 *   · 让"跟人"（follow/approach）在这段时间里更容易胜出
 *   · 让外部派的 task 稍微靠后
 * 结果是"她会先过来看看你，但手头这把矿先挖完"。这就是"改变后续行为"。
 *
 * ## 为什么不用"次数"而用"时间"
 *
 * 注意力是**会衰减**的东西。用 tick 计数的话，`tickMs` 一改，实际时长就漂了；
 * 而且 tick 会被长动作卡住（`perform` 里最长 45s），计数根本不准。
 * 时间戳在长动作期间照样推进，衰减才是真实的。
 *
 * @returns {{recent:boolean, ageMs:number|null, blocksNewTask:boolean, text:string|null}}
 */
function buildAttention () {
  const at = S.lastAddressedAt;
  if (!at) {
    return { recent: false, ageMs: null, blocksNewTask: false, text: null };
  }
  const ageMs = Date.now() - at;
  const recent = ageMs <= CFG.chatInfluenceMs;
  return {
    recent,
    ageMs,
    // "刚说过"的头几秒里不接新活 —— 让"人"优先于"活"。
    // 注意它**只挡新 task**，不影响正在进行的 task（那才叫打断）。
    blocksNewTask: recent && ageMs <= CFG.chatBlocksNewTaskTicks * CFG.tickMs,
    text: recent ? S.lastAddressedText : null,
  };
}

/**
 * 「她现在做得到什么」。这是菜单的准入条件，不是优先级。
 *
 * ⚠️ 每个字段都必须由**真实证据**推出，不能猜：
 *    · `canEat`  —— 背包里有一个 `foodPoints > 0` 的东西
 *    · `canEquipWeapon` / `canEquipTool` —— 背包里有武器 / 工具，且**没拿在手上**
 *    · `dropCount` —— 地上真的有掉落物实体
 *    · `canScan` —— 插件与端点都在（其实只要连着就成立）
 *
 * 之所以强调"不能猜"：这个对象直接决定菜单内容，猜错会让后端选一个必然失败的动作。
 * 宁可少给她一个选项，也不要给一个假的。
 *
 * 复用 `reflex.js` 的 `foodValue` —— 食物判定只有一处实现，
 * 否则"反射说能吃、菜单说不能"这种矛盾迟早出现。
 */
function buildCapability ({ scan, drops, inventory, nearby, dayState }) {
  const items = inventory || [];

  // 能吃：交给 reflex.js 判（它同时认 `foodPoints` 和名字白名单）
  const food = reflex.bestFood(items);

  // 手上拿的是什么。`GET /inventory` 的 items 只含背包**容器内**的物品，
  // 不含手上那格 —— 而"手上的东西"恰恰是判断"要不要换"的关键。
  // 网桥没暴露 heldItem，所以这里退一步：**只要背包里有更好的，就认为值得换**。
  // 代价是"已经拿着最好的镐子时还会重复 equip 一次"—— 无害（equip 是幂等的），
  // 比漏掉"该换没换"要好。
  const has = re => items.some(i => re.test(String(i.name || '')));
  const canEquipTool = has(/(pickaxe|axe|shovel|hoe)$/) || has(/(pickaxe|axe|shovel|hoe)/);
  const canEquipWeapon = has(/(sword)$/) || has(/(sword|_axe$|bow$)/);

  // ---- 自主生存的准入条件（field-log P24）--------------------------------------
  //
  // ⚠️⚠️ P24 的根因是：`mine`/`collect`/`place` **只是 `work` 的 payload**，
  //    而 `work` 只在 `if (s.task)`（外部派活）时进菜单。于是"没人叫她"= 菜单只剩
  //    `["explore","idle"]`，她**在架构上就没有"为自己做事"的能力**。
  //
  // 修这个的前提是：菜单需要"我自己的需求"这类判据，而它们**必须由真实证据推出** ——
  // 沿用这个函数一贯的铁律（见上方注释）：宁可少给一个选项，也不给一个假的。
  //
  // 所以下面每一项都注明"证据是什么"，并且**证据缺失时一律判 false**（保守）。
  const ents = Array.isArray(nearby) ? nearby : [];

  // ① 可徒手采集的方块 —— **必须用 `/scan` 的 `mineable` 短名单**。
  //
  // ⚠️⚠️ P29（2026-09-25 实机抓出）：我第一版读的是 `scan.blocks` 并筛
  //     `b.worth === true && b.toolBlocked === false && b.isPlayerBuilt !== true` ——
  //     **三个字段名全是错的**，实际字段是 `worthMining` / `needsTool` / `built`。
  //     后果：条件永远不成立 → `gatherableCount` 恒为 0 →
  //     `needMaterials` 永远 false → `gather` 永远不进菜单。
  //     **也就是说"自主采集"这条我刚修好的链路，其实从来没接上。**
  //
  //     更根本的错误是：`/scan` **已经**给出了 `mineable`（"值得挖"的短名单），
  //     我不该在 autopilot 里再过滤一遍 —— 那正是 P2b/P18 的"两处各判一遍"。
  //     现在直接读它，判定只有一处（在网桥）。
  //
  // ⚠️ `mineable` 里 `worthMining === true` 是"确定有收获"，
  //    而 `undefined`/缺省表示模组方块（不知道）。两者都算可用，
  //    但**`needsTool === true` 的必须排除**（挖了白挖，比如没镐子挖石头）。
  //    `built === true` 也排除 —— 那很可能是玩家的建筑（P21），
  //    她不该为了自己盖房去拆别人的房子。
  const mineable = Array.isArray(scan?.mineable) ? scan.mineable : [];
  const gatherable = mineable.filter(b =>
    b && b.worthMining !== false && b.needsTool !== true && b.built !== true);

  // 只要建材类（木头/土/沙/石）。为什么要分类：她"需要建材"和"需要食物"
  // 是两种不同的需求，混在一起会让 `gather` 在只想吃的时候也冒出来。
  const isBuildMat = n => /(_log$|_wood$|_planks$|^dirt$|^grass_block$|^sand$|^gravel$|^clay$|^stone$|^cobblestone$|_stone$)/.test(String(n || ''));
  const buildMats = gatherable.filter(b => isBuildMat(b.name));

  // ② 可狩猎/可采集的食物来源：
  //    · 被动生物（鸡/牛/猪/羊…）—— 打得到的
  //    · 掉在地上的食物掉落物（比如别人丢的、或者她打剩的）
  //    ⚠️ `kind === 'mob'`（被动）与 `kind === 'hostile'`（敌对）必须分开 ——
  //       P18 就是在这里把 20 只鸡算成了敌对。
  const huntable = ents.filter(e => e && !e.isDrop && (e.kind === 'mob' || e.kind === 'animal'));
  const foodDrops = Array.isArray(drops) ? drops.filter(d => {
    const n = String(d?.name || '');
    return /(beef|porkchop|chicken|mutton|rabbit|fish|cod|salmon|apple|carrot|potato|beetroot|bread|wheat|melon|sweet_berries)/.test(n);
  }) : [];

  // ③ 背包里还有多少建材（决定"要不要去采"）
  //    ⚠️ 这里用**堆叠数**而不是物品种类数：`dirt x64` 和 `dirt x1` 对"够不够盖房"
  //       是完全不同的答案，只看种类会把两种情况混为一谈。
  const matStacks = items
    .filter(i => isBuildMat(i.name))
    .reduce((n, i) => n + (i.count || i.countInStack || 1), 0);

  // ④ 天黑了吗。`dayState.isDay` 由 perceive 的 `/status` 给出（真实游戏时间）。
  //    缺失时**不猜** —— 判 null，让菜单那条规则直接不成立。
  const isDay = dayState && typeof dayState.isDay === 'boolean' ? dayState.isDay : null;

  return {
    canEat: !!food,
    eatItem: food?.name ?? null,
    canEquipTool,
    canEquipWeapon,
    // 掉落物：`perceive()` 已经从 `/nearby` 的 `drops` 里取回来了。
    // 这里报**数量**而不只是布尔 —— 留着以后"掉了一地要不要专门跑一趟"用得上。
    dropCount: Array.isArray(drops) ? drops.length : (drops ? 1 : 0),
    canScan: !!scan,
    // 背包里有多少种东西（摸清"她到底有什么"的最小指标）
    itemKinds: items.length,

    // ---- P24 新增：自主生存的准入（每一项都有证据，缺证据就是 false/null）--------
    gatherableCount: gatherable.length,   // 周围能徒手采的方块总数
    buildMatCount: buildMats.length,      // 其中是建材的
    matStacks,                            // 背包里已有的建材总量
    huntableCount: huntable.length,       // 周围能打的被动生物
    foodDropCount: foodDrops.length,      // 周围地上的食物掉落物
    isDay,                                // true/false/null（null = 不知道，不猜）
  };
}

/**
 * 执行一个反射。与 `perform()` 的区别：**只做一件事，不做权衡，不发言**。
 */
async function performReflex (hit) {
  switch (hit.name) {
    case 'eat':
      S.action = `吃东西（${hit.args.itemName}）`;
      return await post('/eat', { itemName: hit.args.itemName });

    case 'breathe': {
      // 溺水：直接 setControlState 向上 —— **不走寻路**。
      // 理由：寻路要先算路（可能几百毫秒），而憋气是以秒计的；
      // 而且找"最近的气穴"这件事在三维水下经常算不出来。
      // 原版行为就是"一直按跳跃键会往上浮"，照做即可。
      S.action = '上浮换气';
      try {
        await post('/jump', { durationMs: 1200 });
        return { ok: true };
      } catch (e) {
        // `/jump` 不存在或失败时退回直接控制。网桥没有这个端点也不该让反射崩掉。
        return { ok: false, error: e.message };
      }
    }

    case 'fleeFire':
      S.action = '离开火源';
      // 反射级的"跑"不挑方向 —— 挑方向需要地形信息，那就不是反射了。
      // `/flee` 会自己找反方向（网桥侧实现），这里只要"立刻动"。
      return await post('/flee', { distance: 4 });

    default:
      return { ok: false, error: `未知反射 ${hit.name}` };
  }
}

/**
 * 从实体列表里挑出"可以打的猎物"。**纯函数**，所以能离线穷举测试。
 *
 * ⚠️ 为什么要把这一段单独抽成纯函数：它是 `hunt` / `forage` 的**唯一判据**，
 *    而它依赖的 `kind` 字段曾经在 P18 里被我用反过（把 20 只鸡算成敌对）。
 *    这种判定必须在自测里穷举所有 case，而不是靠"跑一次看看对不对"。
 *
 * 判据四重（缺一不可）：
 *   ① `!isDrop`   —— `/nearby` 把掉落物和生物混在一个数组里
 *   ② kind 是被动 —— `mob` / `animal`（**不是** hostile）
 *   ③ 不是幼年     —— 打死了不掉肉，白费力气
 *   ④ **在够得着的距离内** —— 见下方 P28 的说明
 *
 * 再加一层名字白名单：516 个模组里被动生物名不可穷举，
 * 认不出就跳过（**宁可漏，不要错** —— 打错东西比不打更糟）。
 *
 * ⚠️⚠️ **2026-09-25 实机抓出的 P28：`llama` 必须从白名单里剔除。**
 *
 *    第一次实机跑到 `hunt` 时，她跑去了打 `trader_llama` —— 而且
 *    `命中 0 次`。三层都错：
 *      ① **羊驼是中立生物**，不是"不会还手的食物来源"。打它会激怒它，
 *         而且它身边的 `wandering_trader` 是玩家可能需要的交易对象 ——
 *         为了"找吃的"去得罪一个商人，是纯粹的负收益。
 *      ② **羊驼不掉肉**（原版只掉皮革），打它根本解决不了饥饿问题。
 *      ③ 距离 12.9 格，**超出 `radius: 6`**，所以她一次都没打中 ——
 *         白跑一趟，还暴露了自己。
 *
 *    `llama` 是我从"看起来像被动生物"这个模糊印象里写进白名单的，
 *    **没有对照它的实际掉落物**。这条教训和 P20/P21 一致：
 *    **白名单里的每一项都要能被证据支持，不能靠"感觉它应该算"。**
 *
 * @param {Array}   nearby    `/nearby` 的实体数组
 * @param {number}  [maxDist] 够得着的最大距离（默认与 `/attack` 的 radius 对齐）
 * @returns {object|null} 最近的可打猎物
 */
function pickPrey (nearby, maxDist = 5) {
  // ⚠️ 只放**确定掉肉/可食用**的和平生物。
  //    每一项都要能回答"打死它我能得到什么吃的"：
  //      chicken→鸡肉  cow→牛肉  pig→猪排  sheep→羊肉  rabbit→兔肉
  //      goat→山羊角（奶可喝）  duck/turkey→模组家禽，通常掉肉
  //    **不放** llama/donkey/horse（掉皮革/鞍，不掉肉，且骑马的价值更高）、
  //    **不放** 任何中立生物（羊驼、熊猫、北极熊、蜜蜂、铁傀儡…）。
  const PASSIVE = ['chicken', 'cow', 'pig', 'sheep', 'rabbit', 'duck', 'turkey'];
  return (nearby || [])
    .filter(e => e && !e.isDrop)
    .filter(e => e.kind === 'mob' || e.kind === 'animal')
    .filter(e => !/baby/i.test(String(e.name || '')))
    // ⚠️ `trader_llama` / `llama` 显式排除 —— 见上方 P28 的说明。
    //    即使名字里恰好含白名单词（比如某种模组的 `chicken_llama` 之类），
    //    也一律不碰：带 llama 的一律是中立/商队生物。
    .filter(e => !/llama|alpaca/i.test(String(e.name || '')))
    .filter(e => PASSIVE.some(p => String(e.name || '').toLowerCase().includes(p)))
    // ④ 够得着才去。**距离未知（undefined）时保守跳过** ——
    //    "读不到距离"不等于"它很近"（P4/P8/P20 同一条原则）。
    .filter(e => typeof e.distance === 'number' && e.distance <= maxDist)
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

/**
 * 去打一只被动生物。`hunt` 与 `forage`(第二步) 共用这一份实现。
 *
 * ⚠️ 为什么抽出来而不是在两处各写一遍：
 *    P2b/P18 的教训 —— 同一个判定写两遍，迟早两处说得不一样。
 *    这里"什么算可打的猎物"就是一条判定，只该有一处（`pickPrey`）。
 */
async function doHunt ({ nearby, inventory }) {
  // ⚠️ `maxDist` 与 `/attack` 的 `radius` **必须一致**（都是 5）——
  //    否则会出现"挑中了 8 格外的猎物、但网桥说 6 格内没有"这种自相矛盾，
  //    实机表现就是 P28 的 `命中 0 次`：白跑一趟。
  const ATTACK_RADIUS = 5;
  const prey = pickPrey(nearby, ATTACK_RADIUS);
  if (!prey) {
    return { ok: false, error: `附近 ${ATTACK_RADIUS} 格内没有能打的猎物` };
  }
  S.action = `去打 ${prey.name}`;
  try {
    const r = await post('/attack', { target: prey.name, radius: ATTACK_RADIUS }, CFG.actionTimeoutMs);
    S.action = `打了 ${prey.name}（命中 ${r?.attacked ?? 0} 次）`;
    // 打猎会掉肉 → 掉落物列表与背包都可能变
    invalidatePerceiveCache(['inventory']);
    return { ok: true, note: `${prey.name} hits=${r?.attacked ?? 0}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 执行一个决策。从 tick 里抽出来，是为了让 tick 只剩
 * "感知 → 决策 → 留痕 → 执行 → 留痕" 这条清晰的骨架。
 *
 * @returns {Promise<{ok:boolean, error?:string, interrupted?:boolean, stuck?:boolean}>}
 */
async function perform (chosen, { threat, player, self, inventory, nearby }) {
  switch (chosen.action) {
    case 'flee':
      S.action = `fleeing ${threat.name}`;
      await fleeFrom(threat, self);
      await speak('danger', '呜…我血不多了，先躲一下下');
      return { ok: true };

    case 'backoff':
      S.action = `backing off ${threat.name}`;
      await fleeFrom(threat, self);
      return { ok: true };

    case 'fight':
      S.action = `fighting ${threat.name}`;
      try {
        await post('/attack', { target: threat.name, radius: CFG.fightRadius + 2 });
      } catch (e) {
        log(`攻击失败：${e.message}`);
        return { ok: false, error: e.message };
      }
      return { ok: true };

    case 'work':
      // runTask 自己知道成败，直接把它的话转述出去（它的返回值是统一契约）
      return await runTask(S.task);

    case 'follow':
      S.action = `following ${player.username}`;
      if (Date.now() - S.lastFollowAt > CFG.refollowEveryMs) {
        S.lastFollowAt = Date.now();
        try {
          await post('/follow', { playerName: player.username });
        } catch (e) {
          log(`跟随失败：${e.message}`);
          return { ok: false, error: e.message };
        }
      }
      return { ok: true };

    case 'approach':
      // 就在旁边 → 用身体表达（转头看他），不用嘴
      S.action = `near ${player.username}`;
      if (Math.random() < 0.2) {
        try { await post('/look', { playerName: player.username }); } catch (_) {}
      }
      return { ok: true };

    // ---- 「对自己」的四个动作（2026-09-25 新增）----------------------------
    //
    // 这四个的存在本身就是修复：原来的菜单只有七个"对别人"的动作，
    // 于是"用背包里的东西"永远排不进决策 —— 不是她不想用，是没得选。
    // 对标 HiyoriAI 的 equip/drop_item/pickup_drops/scan_blocks
    // 与 Mindcraft 的 !equip/!discard/!collectBlocks/!consume。

    case 'eat': {
      // ⚠️ 到这一步说明**反射没拦下它**（饥饿 > `reflex.CFG.eatAt`）。
      //    也就是"不是快饿死了，但确实该吃点"。reflex.js 挑的是"回复量最大"（保命），
      //    这里同样走 bestFood —— 食物判定只有一处实现，否则两边迟早说不一样的话。
      const food = reflex.bestFood(inventory || []);
      if (!food) {
        S.action = '想吃但背包里没有食物';
        return { ok: false, error: 'no food in inventory' };
      }
      S.action = `eating ${food.name}`;
      try {
        const r = await post('/eat', { itemName: food.name });
        // 饥饿值涨了才值得说一句。没涨（已经吃饱）时说了会显得莫名其妙。
        if (r?.foodAfter != null && r?.foodBefore != null && r.foodAfter > r.foodBefore) {
          await speak('chat', `吃了点${food.name}，好一点了`);
        }
        return { ok: true, note: `${r?.foodBefore} → ${r?.foodAfter}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'pickup': {
      // 走 `/pickup` 而不是自己去 goto —— 网桥那边有"掉落物会移动"的超时保护，
      // 这边重复实现一遍只会多一处不一致。
      //
      // ⚠️⚠️⚠️ P32（2026-09-25 实机抓出）：**这里原来是谎言的另一半。**
      //
      //    旧代码无论结果如何都 `return { ok: true }`：
      //      if (r?.found === 0) return { ok: true, note: '已经没有掉落物了' };
      //      return { ok: true, note: `走到 ${r?.walkedTo}/${r?.found} 件` };
      //                                                      ↑ 走到 ≠ 捡到
      //
      //    而 `/pickup` 那边（同样是 P32 之前）只返回 `walkedTo`，没有 `picked`。
      //    两端合起来的效果：**她可以永远"成功地"捡不到东西。**
      //    实机证据：40/40 事件全是 `pickup`，`outcome` 里一条错误都没有，
      //              而她脚下 3 件掉落物（y=85）纹丝不动，背包恒为 0。
      //
      //    这就是 P26 的原话在**动作层**的复现 ——
      //    「我以为它跑完了」和「它真的跑完了」是两件事。
      //    一个动作谎报成功，上层的失败退避/重试上限**全部失效**（因为它们只看 `ok`）。
      S.action = '走过去捡东西';
      try {
        const r = await post('/pickup', { radius: 8, count: 4 });
        // 真的没有掉落物 → 这不是失败，是"已经没有可捡的了"，正常收工。
        if (r?.found === 0) return { ok: true, note: '已经没有掉落物了' };

        // ★ 判据换成"真的进背包几件"（P32）。
        const picked = r?.picked ?? 0;
        const walkedTo = r?.walkedTo ?? 0;
        S.action = picked > 0
          ? `捡到 ${picked} 件`
          : `走到了 ${walkedTo} 件掉落物旁边，但一件都没拿到`;
        invalidatePerceiveCache(['inventory']);

        // 走到了却没拿到 → **如实报失败**，好让退避机制接管。
        // 不报失败的话，下一拍她会再走一遍同样的路，永远走不完。
        if (picked === 0) {
          return {
            ok: false,
            error: walkedTo > 0
              ? `走到了 ${walkedTo} 件掉落物旁但没拿到（可能掉在脚下/被地形挡住）`
              : '一件都没走到',
          };
        }
        return { ok: true, note: `捡到 ${picked} 件` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'equip': {
      // 换什么由**网桥**按"当前该拿什么"决定（只有它看得到 heldItem）。
      // 这边只表达"想换"，外加一个意图（要工具还是要武器）——
      // 判据与材质分级只有一处（decision.js 的 pickAutoEquip），不会两处漂移。
      const want = chosen.want || 'any';
      S.action = want === 'weapon' ? '换武器' : want === 'tool' ? '换工具' : '换手上的东西';
      try {
        const r = await post('/equip', { auto: true, want });
        if (r?.changed === false) {
          // 没换不代表出错：可能手上的已经是最好的一件。
          return { ok: true, note: r.reason || '没什么可换的' };
        }
        if (r?.itemName) S.action = `换上 ${r.itemName}`;
        return { ok: true, note: r?.itemName ? `换上 ${r.itemName}` : '没什么可换的' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // ---- 自主生存：没人派活时，她为自己做的五件事（field-log P24）----------------
    //
    // ⚠️⚠️ 这五个动作的存在本身就是修复。在 P24 之前，
    //    `mine`/`collect`/`place` **只是 `work` 的 payload**，而 `work` 只在
    //    `if (s.task)`（外部派活）时进菜单 —— 于是"没人叫她"就等于"她什么都不能做"。
    //    这正是用户「自己建立庇护所并持续发育」这个目标无法达成的**架构性原因**：
    //    不是她不想，是菜单里没有这一整类选项。
    //
    // 与 `work` 的关键区别：
    //    · `work` 是被派活 → 服从 task 的参数（挖什么、挖几个）
    //    · 这一类是自发的 → 参数由**她自己的状态**决定（采什么最划算、打哪只鸡）
    //
    // ⚠️ 每一个都必须**失败得诚实**：做不到就返回 ok:false + 原因，
    //    让 tick 的留痕能看出"她试过了但没成"，而不是静默地什么都不做。

    case 'gather': {
      // 采集建材。目标方块由**网桥的 scan 结果**决定，而不是这边猜 ——
      // 只有网桥看得到真实的方块名与 `harvestTools` 判定（P20 的三态判据住在那里）。
      //
      // 优先序：木头 > 泥土/沙 > 石头。
      // 理由：木头能合成工作台（虽然 P15 说配方现在还不可用），
      // 而泥土是**徒手必定能拿到**的保底建材 —— 盖第一间土屋只需要泥土。
      S.action = '给自己采点建材';
      const wanted = ['_log', 'dirt', 'grass_block', 'sand', 'gravel', 'clay',
        'cobblestone', 'stone', '_planks'];
      try {
        // ⚠️ 用 `/scan` 的 `mineable` 短名单，**不要**自己从 `blocks` 里过滤 ——
        //    字段名与判据都在网桥那一侧（P29 的教训：我在这里写错过三个字段名，
        //    导致 gather 永远挑不出东西，而表面上一切正常）。
        //
        // `S.lastScan` 是 explore 动作留下的最近一次扫描；过期或没有就现扫一次。
        let scan = (S.lastScan && Date.now() - S.lastScan.at < 20000) ? S.lastScan : null;
        if (!scan || !Array.isArray(scan.mineable)) {
          const r = await get('/scan?radius=8&verticalRadius=4&limit=24');
          S.lastScan = { at: Date.now(), standing: r?.standing, blocks: r?.blocks || [], mineable: r?.mineable || [] };
          scan = S.lastScan;
        }

        // 按"建材优先级"挑（wanted 里靠前的优先），同档取最近的。
        const cand = (scan.mineable || [])
          .filter(b => b && b.worthMining !== false && b.needsTool !== true && b.built !== true)
          .filter(b => wanted.some(w => String(b.name || '').endsWith(w) || String(b.name || '') === w))
          .sort((a, b) => {
            const rank = x => wanted.findIndex(w =>
              String(x.name || '').endsWith(w) || String(x.name || '') === w);
            const d = rank(a) - rank(b);
            return d !== 0 ? d : (a.distance ?? 99) - (b.distance ?? 99);
          })[0];

        if (!cand) {
          // 周围没有可徒手采的建材 → 如实报告"这一片没有"，
          // 让下一轮（可能换位置后）再判断。**不要**假装做成了什么。
          return { ok: false, error: '附近没有可徒手采集的建材' };
        }

        const r = await post('/mine', { blockName: cand.name, count: 4 }, CFG.actionTimeoutMs);

        // ⚠️⚠️⚠️ P35（2026-09-25 实机抓出）：**判据是 `dropsPicked`，不是 `mined.length`。**
        //
        //    `mined`  = **拆掉了几块方块**（世界变了吗？变了 —— 方块没了）
        //    `dropsPicked` = **真的进背包了几件**（我拿到了吗？）
        //
        //    这两件事在"掉落物够不着"时会**完全分岔**。实机证据：
        //      · `gather` 连续报 `ok: true`，而 `inventoryCount` 恒为 0
        //      · `POST /mine` 返回 `"mined": 2, "dropsPicked": 0`
        //      · 她在真挖（位置从 (-1,87,-4) 移到 (-6,88,-6)），但一件没拿
        //
        //    这与 P32（`/pickup` 用 `walkedTo` 判成功）是**同一个 bug 的第三次出现**：
        //      · P32：`walkedTo`（走到了）≠ `picked`（拿到了）
        //      · P35：`mined`（挖掉了）  ≠ `dropsPicked`（拿到了）
        //    **而我在修 P32 时没有 grep 全仓找同类** —— P14 的教训第四次违反。
        //
        //    为什么这个谎报比"捡不到"更严重：`ok: true` → 退避永远不触发 →
        //    `needMaterials` 永远是 true → 她**永远在采、永远采不到、永远觉得缺砖**
        //    → 又是一种"表面上很忙"的沉默死循环（P31/P32 的同族）。
        const mined = r?.mined?.length ?? 0;
        const picked = r?.dropsPicked ?? 0;
        S.action = picked > 0
          ? `采了 ${picked} 个 ${cand.name}`
          : `挖掉了 ${mined} 个 ${cand.name}，但一件都没拿到`;
        // 采集改变了背包与地形 → 这两类缓存立刻失效，别让下一拍读到旧值
        invalidatePerceiveCache(['inventory', 'scan']);

        // 挖到了却拿不到 → **如实报失败**，让退避机制接管（她会换个地方再试）。
        //
        // ⚠️ 边界：`mined > 0 && picked === 0` 才是"够不着"这种要退避的情况。
        //    `mined === 0` 说明她根本没挖到（目标方块被别人挖走了等），
        //    那也报失败，但错误信息不同 —— 排查时要能区分这两件事。
        if (picked === 0) {
          return {
            ok: false,
            error: mined > 0
              ? `挖掉了 ${mined} 个 ${cand.name} 但一件没拿到（掉落物够不着）`
              : `没能挖到 ${cand.name}（目标可能已消失）`,
          };
        }
        return { ok: true, note: `${cand.name} ×${picked}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'hunt': {
      // 狩猎。目标是**最近的被动生物**（鸡/牛/猪/羊），不是 hostile。
      //
      // ⚠️ 为什么不用 `POST /attack` 的默认行为：它的默认筛的是 HOSTILE 白名单，
      //    而我们这里要打的是"不会还手的"。`/attack` 支持 `target` 指定名字，
      //    所以直接传具体生物名。
      return await doHunt({ nearby, inventory });
    }

    case 'forage': {
      // 觅食。两条路，按"确定性"排序：
      //   ① 背包里已经有吃的 → 直接吃（最确定，走 /eat）
      //   ② 没有 → 去打被动生物拿肉（复用 doHunt，避免两处实现漂移）
      //
      // ⚠️ 刻意**不去野外找果子/作物**：那需要识别具体的作物方块并逐个采，
      //    而作物方块在 516 模组的环境里名字不可穷举。打猎是更可靠的路径，
      //    因为它判据简单（被动生物的存在性是确定的）。
      const food = reflex.bestFood(inventory || []);
      if (food) {
        S.action = `吃点东西（${food.name}）`;
        try {
          const r = await post('/eat', { itemName: food.name });
          invalidatePerceiveCache(['inventory']);
          return { ok: true, note: `${r?.foodBefore} → ${r?.foodAfter}` };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      return await doHunt({ nearby, inventory });
    }

    case 'retreat': {
      // 低血且**无贴身威胁** → 退到安全处养伤。
      //
      // ⚠️ 与 `flee` 的区别（这区别是自测逼出来的，见 decision.js 的注释）：
      //    · `flee`    正在被打，立刻朝反方向跑（/flee，最短路径，不管去哪）
      //    · `retreat` 没人在打我，只是状态差 → **回到有遮蔽的地方**，而不是乱跑
      //
      // 实现：优先回她记忆里的"最后一个安全点"（比如玩家建筑附近），
      // 没有记忆就往远离当前暴露方向走一小段，然后停下别动 ——
      // **静止比乱走安全**，因为移动会把她带进新的刷怪点。
      S.action = '退到安全的地方养伤';
      const home = S.lastSafeSpot;
      if (home && Date.now() - home.t < 10 * 60 * 1000) {
        try {
          await post('/move', { x: home.x, y: home.y, z: home.z }, CFG.actionTimeoutMs);
          S.action = `回到上次的安全点（${home.x},${home.z}）`;
          return { ok: true, note: 'back to last safe spot' };
        } catch (e) {
          // 回不去就退而求其次，走下面的"原地小退"
        }
      }
      try {
        // 没有安全点记忆 → 用 /flee 的"反向小步"（距离刻意短：3 格，
        // 目的是离开当前暴露位置，不是逃跑）
        await post('/flee', { distance: 3 });
        S.action = '挪到旁边躲一下';
        return { ok: true, note: 'short sidestep' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'shelter': {
      // 天黑且无遮蔽 → 搭一个能挡住的封闭空间。
      //
      // ⚠️⚠️ 这是五个动作里**最难做对**的一个，所以我刻意从最小的可验证版本起步：
      //    不做"3×3 土屋"（那需要空间规划、要确认头顶没洞、要留门），
      //    只做 **"把自己脚下垫起来 + 四周堵上"** 的原地封闭 —— 也就是
      //    Minecraft 里最经典的"紧急避难柱"（pillar up / 堵三面）。
      //
      //    理由和 P1c 教训一致：**先要一个世界状态真的改变了的动作**，
      //    而不是一个听起来完整但必然中途失败的复杂计划。
      //    等这条跑通并留下成功证据，再谈"盖一间正经的屋子"。
      //
      // 判据（缺一不可，缺就诚实失败）：
      //   ① 背包里有可放置的方块（泥土/圆石等）
      //   ② 周围有空位可以放
      S.action = '天黑前给自己围个遮蔽';
      const placeable = (inventory || [])
        .filter(i => /(dirt|grass_block|sand|gravel|cobblestone|stone|_planks|_log|_wood)/.test(String(i.name || '')))
        .sort((a, b) => (b.count || 1) - (a.count || 1))[0];

      if (!placeable) {
        // 没有材料 → 如实失败。**不要**退化成"随便走走"假装做了什么。
        // 下一轮决策会看到 `self.needMaterials` 仍然是 true，于是选 gather 去弄材料。
        return { ok: false, error: '没有可以放置的方块，无法搭遮蔽（需要先去采集）' };
      }

      try {
        // ⚠️ 走 `/shelter` 而不是 `/place` —— 理由见下方"判据属于看得见真相的那一侧"。
        //    `/place` 要求调用方给出精确坐标，而"该把方块放在哪一格"这个问题
        //    只有网桥答得了（它看得到地形、朝向、脚下是否悬空）。
        //    autopilot 这边只有 `/scan` 的方块列表，猜坐标必然打偏。
        const r = await post('/shelter', {
          itemName: placeable.name,
          blocks: 3,          // 最少围几格（网桥会按实际地形决定最终数量）
        }, CFG.actionTimeoutMs);

        // ⚠️⚠️⚠️ P41（2026-09-25 实机抓出）：**这里原来是谎言的又一个成员。**
        //    旧代码无视返回值，直接 `return { ok: true }`：
        //      return { ok: true, note: `${placeable.name} ×${r?.placed ?? 0}` };
        //    于是 `placed: 0` 时它照样报成功 —— P32（pickup 用 walkedTo 判）、
        //    P35（gather 用 mined 判）之外的**同型第三次**。
        //    后果完全一样：`ok: true` → 退避永不触发 → `needShelter` 永远 true
        //    → 她每 tick 都去搭、每次都搭不成、下一 tick 还去搭 ——
        //    **这正是 P31 想修掉的那个死循环，只是换了一层伪装**（12 次调用全零）。
        //
        //    判据用 `placed`，而且**要与网桥的 `sheltered` 口径对齐**：
        //    `sheltered = placed.length >= 2` —— 1 格只是象征性的，不算"有遮蔽"。
        const placed = r?.placed ?? 0;
        const sheltered = r?.sheltered === true || placed >= 2;
        S.action = sheltered
          ? `用 ${placeable.name} 围了个遮蔽（放了 ${placed} 个，留门 ${r?.keptOpen}）`
          : `只放成 ${placed} 个 ${placeable.name}，没围出遮蔽（留门 ${r?.keptOpen}）`;
        invalidatePerceiveCache(['inventory', 'scan']);

        if (!sheltered) {
          // 如实失败 —— 让 `selfFailures` 退避接管，别让她原地空转。
          // 附带把失败原因带出来，好让台账/日志能定位（P40 那次就是"错误信息
          // 指向白名单，真相在格子归属"）。
          const why = (r?.failed || []).slice(0, 2)
            .map(f => `${f.at?.x},${f.at?.y},${f.at?.z}:${f.reason}`).join(' | ');
          return { ok: false, error: `遮蔽没搭成（只放成 ${placed} 格${why ? `；${why}` : ''}）` };
        }
        return { ok: true, note: `${placeable.name} ×${placed}（留门 ${r?.keptOpen}）` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'explore': {
      // 扫一眼四周。**这是唯一一个"只为了知道"的动作** ——
      // 对标 Mindcraft 的 `!nearbyBlocks` 与 HiyoriAI 的 `scan_blocks`。
      // 她的感知里原来只有实体（`/nearby`），从来没有方块。
      //
      // ⚠️ 结果要**真的用起来**才有意义：塞进 S.lastScan，之后有人问
      //    "旁边有什么"时能拿真材料答，而不是靠编。
      //    刻意**不主动念出来** —— 没人问的时候念方块名是纯噪音。
      S.action = '看看四周有什么';
      try {
        const r = await get('/scan?radius=8&verticalRadius=4&limit=12');
        // ⚠️ `mineable` 必须一起存 —— `gather` 要用它（P29：
        //    之前只存了 `blocks`，导致 gather 只能退而求其次去读一堆没有
        //    `worthMining` 字段的裸方块，永远挑不出东西）。
        S.lastScan = {
          at: Date.now(), standing: r?.standing,
          blocks: r?.blocks || [], mineable: r?.mineable || [],
        };
        const top = (r?.blocks || []).slice(0, 3).map(b => `${b.name}×${b.count}`).join('、');
        S.action = top ? `四周有 ${top}` : '四周没什么东西';
        return { ok: true, note: top };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  }

  // ---- 默认：待命
  if (player) {
    // 人还在线但看不见（超出视距）→ 走去最后看到他的地方
    if (!player.position) {
      const ls = S.lastSeenPlayer;
      if (ls && Date.now() - ls.t < 120000) {
        S.action = `heading to last seen ${player.username}`;
        try {
          await post('/move', { x: ls.x, y: ls.y, z: ls.z }, CFG.actionTimeoutMs);
          S.lastSeenPlayer = null; // 到过了，别反复走
          return { ok: true };
        } catch (e) {
          S.action = `lost ${player.username}（${e.message}）`;
          S.lastSeenPlayer = null;
          return { ok: false, error: e.message };
        }
      }
      S.action = `waiting for ${player.username}`;
      return { ok: true };
    }
    S.action = `idle near ${player.username}`;
    return { ok: true };
  }

  // ---- 没人在线
  S.action = 'idle（没人在线）';
  return { ok: true };
}

async function loop () {
  log('Angel_ICE 自主循环启动');
  log(`  网桥   ${CFG.bridge}`);
  log(`  控制面 http://127.0.0.1:${CFG.port}/autopilot`);
  log(`  说话纪律：只在被问 / 危险时开口（冷却 ${CFG.speakCooldownMs / 1000}s）`);
  log(`  耳朵   每 ${CFG.earsMs}ms 听一次聊天（独立回路，长动作期间也听得见）`);
  log(`  感知   分档心跳 base=${CFG.tickMs}ms`
    + `｜挖矿×${CFG.tickProfile.workFactor} 战斗×${CFG.tickProfile.combatFactor} 待机×${CFG.tickProfile.idleFactor}`
    + `｜慢环 TTL scan=${CFG.perceive.scanTtlMs}ms inv=${CFG.perceive.inventoryTtlMs}ms`
    + `（有效刷新率最多 ${Math.round(CFG.tickMs * CFG.tickProfile.combatFactor)}ms）`);

  while (S.running) {
    const t0 = Date.now();
    let delay = { ms: CFG.tickMs, mode: 'normal', factor: 1 };
    try {
      delay = await tick();
      if (!delay || typeof delay.ms !== 'number') delay = { ms: CFG.tickMs, mode: 'normal', factor: 1 };
    } catch (e) {
      log(`tick 异常：${e.message}`);
    }
    S.tickDelay = delay;
    const wait = Math.max(60, delay.ms - (Date.now() - t0));
    await sleep(wait);
  }
  log('自主循环已停止');
}

// ------------------------------------------------------------------ 控制面

function json (res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const control = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const parsed = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};

    if (req.method === 'GET' && url === '/autopilot') {
      return json(res, 200, {
        running: S.running,
        action: S.action,
        tick: S.tick,
        uptimeSec: Math.round((Date.now() - S.startedAt) / 1000),
        lastSeenPlayer: S.lastSeenPlayer,
        task: S.task,
        taskResult: S.taskResult,
        lastDecision: S.lastDecision,   // 她为什么这么做：动作 / 后端 / 置信度
        lastStuck: S.lastStuck,         // 最近一次卡死（agent 可据此决定要不要告诉玩家）
        lastSelfUnstick: S.lastSelfUnstick,   // ★ P42：最近一次自救（试了哪几级、成败）
        taskFailures: [...S.taskFailures.entries()].map(([sig, rec]) => ({ sig, ...rec })),
        decision: backendStatus(),      // 决策层现在实际用哪个后端、Jev 是否熔断
        pendingQuestions: S.pendingQuestions.slice(-5),
        // 自适应感知的观测面。
        // `tickDelay` 是**当前**这一拍的心跳档位 —— 挖矿时会看到 mode:"work" 且 ms 减半，
        // 有怪时是 "combat"。没有这个字段，"提高感知速度"就只是一句无法验证的话。
        perceive: {
          tickDelay: S.tickDelay,
          lastAlertAt: S.lastAlertAt,
          config: CFG.perceive,
          profile: CFG.tickProfile,
          hits: perceiveCache.hits,
          misses: perceiveCache.misses,
          // 命中率 = 省下的请求比例。直接对应"感知变快了多少倍"。
          hitRate: (perceiveCache.hits + perceiveCache.misses) > 0
            ? Math.round((perceiveCache.hits / (perceiveCache.hits + perceiveCache.misses)) * 1000) / 1000
            : null,
          // 各慢环数据的**年龄**（毫秒）—— 用来抓"她拿着过期数据做决定"的 bug
          ages: {
            scan: perceiveCache.scan.at ? Date.now() - perceiveCache.scan.at : null,
            players: perceiveCache.players.at ? Date.now() - perceiveCache.players.at : null,
            inventory: perceiveCache.inventory.at ? Date.now() - perceiveCache.inventory.at : null,
            chat: perceiveCache.chat.at ? Date.now() - perceiveCache.chat.at : null,
          },
          errors: {
            scan: perceiveCache.scan.err,
            players: perceiveCache.players.err,
            inventory: perceiveCache.inventory.err,
            chat: perceiveCache.chat.err,
          },
        },
        // 耳朵回路的健康度：polls 应该在稳定增长（离线时也该增长），
        // errors 为 0 才说明它真读到了。不暴露这两个就没法区分
        // "在跑但读不到" 和 "根本没在跑"。
        ears: {
          polls: S.earsPolls, heard: S.earsHeard, errors: S.earsErrors,
          lastError: S.earsLastError, lastPollAt: S.earsLastPollAt, intervalMs: CFG.earsMs,
        },
        config: CFG,
        log: S.log.slice(-12),
      });
    }

    // 结构化留痕：agent 复盘"她最近做了什么决定、结果如何"用这个，不要靠翻日志
    if (req.method === 'GET' && url === '/autopilot/events') {
      const n = parseInt(new URL(req.url, 'http://x').searchParams.get('n') || '30');
      return json(res, 200, { count: n, events: events.read(Math.min(Math.max(1, n), 500)) });
    }

    if (req.method === 'GET' && url === '/autopilot/stats') {
      return json(res, 200, events.stats());
    }

    if (req.method === 'POST' && url === '/autopilot/task') {
      if (!parsed.type) return json(res, 400, { error: 'type 必填（mine|collect|craft|goto|follow|place|give|say）' });

      // 「刚有人在跟她说话」的头几秒里不接**新活**（让"人"优先于"活"）。
      //
      // ⚠️ 这不是打断，也没打断任何东西 —— 正在做的 task 依然在做，
      //    `/autopilot/status` 里看得到它还在。这里只是**拒绝派新的**，
      //    并且明确告诉调用方"过几秒再来"，而不是静默排队。
      //
      // 为什么要有它：用户要求「不打断工作，只是改变后续行为」。
      // 玩家刚说完"过来一下"，紧接着一个 agent 派了挖矿任务 ——
      // 她就会走到矿边而不是走向玩家。挡这几秒正是"改变后续行为"。
      const attn = buildAttention();
      if (attn.blocksNewTask) {
        const waitMs = Math.max(0, CFG.chatBlocksNewTaskTicks * CFG.tickMs - (attn.ageMs || 0));
        events.append({ kind: 'task', phase: 'deferred', type: parsed.type, detail: `刚被叫过，${Math.ceil(waitMs / 1000)}s 后再派` });
        return json(res, 429, {
          deferred: true,
          reason: `玩家 ${(attn.ageMs / 1000).toFixed(1)}s 前刚跟她说话，这几秒里她优先看人`,
          retryAfterMs: waitMs,
          pendingTask: S.task ? S.task.type : null,
        });
      }

      // 派活前先查"这活是不是已经试到头了"。当场拒绝，比让她再撞一次墙有用得多 ——
      // agent 立刻就知道该换个办法，而不是等 40 秒后从日志里发现又失败了。
      const exhausted = taskExhausted(parsed);
      if (exhausted) {
        events.append({ kind: 'task', phase: 'refused', type: parsed.type, detail: exhausted });
        log(`🚫 拒绝派活 ${parsed.type}：${exhausted}`);
        return json(res, 409, {
          refused: true, reason: exhausted,
          hint: '换个目标/参数，或先 POST /autopilot/config {"maxTaskFailures":N} 放宽上限',
        });
      }
      S.task = parsed;
      log(`📥 接到任务：${JSON.stringify(parsed)}`);
      return json(res, 200, { accepted: parsed });
    }

    if (req.method === 'POST' && url === '/autopilot/say') {
      if (!parsed.message) return json(res, 400, { error: 'message 必填' });
      // agent 显式要求说的，绕过冷却与讲课拦截 —— 但仍然是"被问才说"的场景
      const r = await speak('agent', parsed.message, { force: true });
      return json(res, 200, r);
    }

    if (req.method === 'POST' && url === '/autopilot/config') {
      // 阈值要同时写进 TUNING —— 菜单构造读的是 TUNING，只改 CFG 会造成
      // "参数调了但行为没变"这种最难查的 bug。
      const MIRROR = ['followMax', 'criticalHp', 'fightRadius', 'dangerRadius'];
      for (const [k, v] of Object.entries(parsed)) {
        if (k in CFG) CFG[k] = v;
        if (MIRROR.includes(k)) TUNING[k] = v;
      }
      log(`⚙️ 配置更新：${JSON.stringify(parsed)}`);
      return json(res, 200, { config: CFG, tuning: TUNING });
    }

    // 清掉失败计数。这个接口是必需的，不是锦上添花 ——
    // 否则"挖铁矿失败 3 次"会在这个进程的生命周期内被永久拒绝，
    // 哪怕玩家后来给了她镐子、或者她自己换了工具，也再也试不了。
    if (req.method === 'POST' && url === '/autopilot/forget') {
      if (parsed.type) {
        let n = 0;
        for (const sig of [...S.taskFailures.keys()]) {
          if (sig.includes(`"${parsed.type}"`)) { S.taskFailures.delete(sig); n++; }
        }
        log(`🧹 清掉 ${n} 条失败记录（type=${parsed.type}）`);
        return json(res, 200, { cleared: n, type: parsed.type });
      }
      const n = S.taskFailures.size;
      S.taskFailures.clear();
      log(`🧹 清掉全部 ${n} 条失败记录`);
      return json(res, 200, { cleared: n });
    }

    if (req.method === 'POST' && url === '/autopilot/stop') {
      S.running = false;
      json(res, 200, { stopping: true });
      setTimeout(() => process.exit(0), 300);
      return;
    }

    json(res, 404, {
      error: 'unknown route',
      routes: [
        'GET /autopilot', 'GET /autopilot/events?n=30', 'GET /autopilot/stats',
        'POST /autopilot/task', 'POST /autopilot/say', 'POST /autopilot/config',
        'POST /autopilot/forget', 'POST /autopilot/stop',
      ],
    });
  });
});

control.listen(CFG.port, '127.0.0.1', () => {
  // 耳朵和主循环**并行**起 —— 这正是它的意义：tick 被长动作堵住时它还在听。
  // 它不是第二个决策者，只是一个 I/O 轮询器，所以不需要和 tick 同步任何东西。
  earsLoop().catch(e => log(`耳朵回路退出：${e.message}`));
  loop().catch(e => { log(`致命错误：${e.message}`); process.exit(1); });
});
