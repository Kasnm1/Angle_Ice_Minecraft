// tasks.js —— 任务对象 + 队列 + 持久化 + 打断规则（设计文档 `docs/TASK-QUEUE-DESIGN-20260929.md` 阶段 1）。
//
// ## 为什么要有这个文件
//
// 审计（`modpack-study/_work/task-queue-audit-20260928.md` C1–C3）说清了：她原来没有队列 ——
// `startJob()` 是「递增 token + 对旧任务 `/stop` + 覆盖 `W.job`」，**最后写入者获胜**。
// 旧任务剩下的步骤只被拼进一句「⏹ 被打断了」的提示（`actions.js` 的 `preempted`），
// 没有任何结构让"没做完的"重新出现在她眼前。这个文件补的就是这一层。
//
// ## 设计立场（照设计文档第一节，别走回头路）
//
// 1. **大模型决定做什么，队列不替她做决定。** 这里不自动执行步骤、不生成子任务 ——
//    只负责"记住"（不丢事）和"摆到她眼前"（buildNow 里那两行）。
// 2. **不丢事。** 被打断的任务留在队列里，直到 做完 / 她放弃 / 过期。
// 3. **不乱顶。** 只有"动身体"的动作才打断；说话、看一眼、查背包永远并行。
// 4. **保命不受队列约束。** 本能照旧直接抢身体；队列只在它结束后把被打断的摆回来。
// 5. **身体层不排队**（`body-command-lock.js` 的既定设计）。身体忙 → 上层有限次重试，不算任务失败。
//
// ## 为什么是**独立模块**（纯函数 + 显式状态），而不是内联进 actions.js
//
// 这样它不 require 任何兄弟文件，能被自测直接驱动、也能被 `node src/mind/mind/tasks.js --selftest` 单独跑。
// 状态（队列 + 序号）由 `W.tasks` 持有（`state.js` 里放 `{ seq: 0, list: [] }`），
// 本文件只在函数被调用时才 `require('./state')` 取**同一份** —— 和别的 mind 文件一样，
// 绝不在这里再写一份 `W`（见 `../AGENTS.md` 铁律）。
//
// ⚠️ **本阶段（阶段 1）不做**：`task_*` 工具、"该接着做了"的提醒、过期提醒、诚实闸联动、
// 计划联动（阶段 2 / 3）。但字段都留好了位置（`parent` / `planStep` / `progress` / `ttlMs` /
// `interruptions`），阶段 2/3 直接用，不用再改结构。

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../paths');

// 用到时才取路径：自测 / 模拟会在 require 之后才设 `MC_TASKS_FILE`
// （写死在加载时会写进真的 `memory/tasks.json`，和 memory-store.js 的 FILE() 同一个道理）。
const FILE = () => process.env.MC_TASKS_FILE || path.join(paths.MEMORY, 'tasks.json');

/** 静默落盘：磁盘出问题不能把意识带走（照 memory-store.js 的立场）。 */
function warn (msg) { try { console.warn(msg); } catch (_) {} }

// ------------------------------------------------------------------ 常量（都写理由）

/**
 * 「不动身体」的工具名单 —— **只此一份**（设计文档第五节：名单只许一处）。
 *
 * 沿现有的 `look_at` 特例（审计 C3，原在 `think.js`：「长任务进行中，玩家只是聊天时，
 * 模型偶尔会顺手调 look_at，这类回应不应把正在执行的身体任务顶掉」）扩大成
 * 「**不动身体的工具一律不打断**」。
 *
 * 对齐 `src/instinct/instinct.js` 的 `PASSIVE_POSTS`（本能层"不抢身体"的名单）：
 *   `POST /chat`(=say) / `POST /instinct`(=见 look_around, see 下面) / `POST /knowledge/search`(=knowledge_search)
 *   / `POST /look`(=look_at) / `POST /memory`(=learn/judge，属 memory 类) / 其余注册表、重连等非 mind 工具
 * 再加上 mind 自己那些**纯查询**的：scan_blocks（扫方块）/ inventory（查背包）/ recipe / how_to_obtain /
 * home_stock / recall / my_dream / plan_view / tools（元工具）…
 *
 * 判据是"**这一趟会不会让身体动**"，不是"工具叫什么"：
 *   · `look_at` / `look_around` / `scan_blocks` 只是转头、扫一眼 —— 不动身体（P55 实机：它顶掉长任务正是痛点）
 *   · `inventory` / `home_stock` / `recipe` / `how_to_obtain` / `knowledge_search` / `item_info` /
 *     `item_uses` / `guide_search` / `material_plan` / `build_status` / `layout_status` 纯查表
 *   · `recall` / `my_dream` / `plan_view` 查自己的记忆 / 心愿 / 计划
 *   · `learn` / `judge` / `revise` / `report_issue` 写字条（memory 类，不动身体）
 *   · `wait` / `end` 结束这一轮
 *
 * ⚠️ `tools`（元工具）虽然只是"把一组工具拿出来用"，但它本身不动身体，所以在这里；
 *    它带来的那组工具**下一次调用**才算动作，到时照常按名字判。
 *
 * 不在这里、因此**会**打断的：`goto` `come_to` `follow` `craft` `mine` `place` `smelt` `make_item`
 * `pickup` `equip` `wear` `eat` `attack` `dive` `delve` `till` `farm` `light_up` … 以及 `use_skill`
 * （那是一串真动作）。**用排除法兜底**：不在名单里的就当"动身体"，因为错判成"会打断"最多多一次 paused，
 * 错判成"不打断"会让她以为在挖矿其实站原地 —— 宁可保守。
 */
const NO_BODY_TOOLS = new Set([
  // 说话 / 看 / 结束
  'say', 'wait', 'look_at', 'look_around', 'look_area',
  // 查（纯读）
  'scan_blocks', 'inventory', 'recipe', 'how_to_obtain', 'item_info', 'item_uses',
  'knowledge_search', 'guide_search', 'material_plan', 'build_status', 'layout_status',
  'recall', 'my_dream', 'plan_view', 'home_stock', 'tools',
  // 写字条（memory 类）
  'learn', 'judge', 'revise', 'report_issue',
  // ⚠️ 阶段 2 的 task_* 工具也属于"不动身体"（管队列不动身体）—— 名字先摆在这里，
  //    工具还没实现（见文件头"本阶段不做"）。
  'task_add', 'task_note', 'task_done', 'task_drop', 'task_resume',
]);

/**
 * 主人叫停 / 放弃的词（设计文档第五节：`stop` 之后，"都别做了 / 算了 / 不用了"→ player 任务全 dropped）。
 * 只认**明确**放弃的词：含"别做/停下/算了/不用了/不做了/取消"这类，避免把"做完再看"误判成放弃。
 */
const DROP_ALL_RE = /(都别做|都別做|别做了|別做了|不做了|算了|不用了|不用做|别弄了|別弄了|停下|停一下|不要了|取消|不弄了|先别做|先別做|都停下)/;

/**
 * 同一目的地来回走的阈值（附加小项）。写在这里、**只此一处**，因为判据要能被自测直接驱动。
 *
 * 实机（2026-09-29 03:36–03:38）：她砍的橡木原木掉在 15665,67,10020，那时捡东西坏了（已修），
 * 她连续 **8 次** `goto` 那个点，每次"到了"、东西还在，她一直没察觉。
 * 现有 `repetitionHint` 只看**回话条数**，盖不住这种"身体在原地打转"。
 *
 * | 参数 | 值 | 理由 |
 * |---|---|---|
 * | `SAME_SPOT_TURNS` | 3 | 2 次可能是"走错了、再走一次"；3 次才开始像打转 |
 * | `SAME_SPOT_RADIUS` | 3 格 | 目的地算"同一个点"的半径（和"到了"的判定同一量级） |
 * | `SAME_SPOT_WINDOW_MS` | 2 分钟 | 超过 2 分钟可能只是"换个时间又去了一趟"，不算死循环 |
 * | `SAME_SPOT_TOOLS`   | goto / come_to / follow | 走路类工具（"去某处"） |
 *
 * 判据：同一个目的地（3 格内）在 `SAME_SPOT_WINDOW_MS` 内 `goto` / `come_to` ≥ 3 次、
 * **期间背包没有变化** → 提醒她换办法。背包变化（拿到/丢掉东西）说明这一趟不是白跑。
 */
const SAME_SPOT_TURNS = 3;
const SAME_SPOT_RADIUS = 3;
const SAME_SPOT_WINDOW_MS = 2 * 60 * 1000;
const SAME_SPOT_TOOLS = new Set(['goto', 'come_to', 'follow']);

/**
 * 走路目的地（用于"同一目的地"判据）：
 *   · `goto` / `come_to` 给了 x/z → 那个点
 *   · `follow` / 只给 player → 玩家位置（从 `W.state.players` 找）
 *   · 都没有 → null（这一趟不参与"同一目的地"统计，宁可不提醒也不乱提醒）
 * 输出 { x, z }（整数格，水平面），拿不到就 null。
 */
function destOf (tool, args, state) {
  if (!SAME_SPOT_TOOLS.has(tool)) return null;
  const a = args || {};
  if (Number.isFinite(a.x) && Number.isFinite(a.z)) return { x: Math.round(a.x), z: Math.round(a.z) };
  const who = a.player || a.name;
  if (who) {
    const p = (state?.players || []).find(p => p.username === who);
    if (p?.position) return { x: Math.round(p.position.x), z: Math.round(p.position.z) };
  }
  return null;
}

/** 背包指纹：比较"这一趟有没有拿到/丢掉东西"（`{ id: count }` 排序后拼成一串）。 */
function invKey (items) {
  return (items || []).map(i => `${i.name}:${i.count}`).sort().join(',');
}

/** 背包变了没有（`W.lastInv` 是 Map；`W.state.items` 是数组 —— 两处都能进） */
function invChanged (prev, curr) {
  const a = prev instanceof Map ? [...prev.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',') : invKey(prev);
  const b = curr instanceof Map ? [...curr.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',') : invKey(curr);
  return a !== b;
}

function dd (n) { return String(n).padStart(2, '0'); }

// ------------------------------------------------------------------ 任务对象

/** 这是不是一件"主人交代的事"（`source=player`，永不过期 —— 主人 2026-09-29） */
const isPlayerTask = (t) => t && t.source === 'player';

/**
 * 键：同一件事合并（设计第七节）。`player` 用主人原话，其余用 title。
 * 只在**同一件事**上合并（同 source + 同 title 或同一句话），不同的事照建。
 */
function keyOf (t) {
  const a = String(t.said || '').replace(/\s+/g, '');
  const b = String(t.title || '').replace(/\s+/g, '');
  return a || b;
}

/** 标题：人话，给她自己看也给主人看（主人原话前 30 字 / 她自己的想法前 30 字） */
function titleOf ({ title, said }) {
  const s = String(title || said || '一件事').replace(/\s+/g, ' ').trim();
  return s.slice(0, 30) || '一件事';
}

/**
 * 建一个任务对象（设计文档第三节的字段，一个不少）。
 * 阶段 1 里 `titleOf` 会把 title 截到 30 字 —— 设计里 `title` 是"人话"，
 * `said` 才是主人原话全文（`title` 只给她看，短一点省上下文）。
 */
function makeTask ({ title, said = null, source = 'self', askedBy = null, pausedWhy = null,
  parent = null, steps = [], i = 0, progress = null, planStep = null, ttlMs = null } = {}) {
  return {
    id: 0,                                   // create() 里填
    title: titleOf({ title, said }),         // 人话
    source,                                  // 'player' | 'self' | 'plan'
    askedBy,                                 // 主人交代时是谁
    said,                                    // 主人原话（source=player）
    status: 'queued',
    pausedWhy,                               // null | 'player' | 'instinct' | 'self'（照设计第三节；另有 'restart'）
    parent,                                  // 为了哪件事而做
    steps: (steps || []).map(s => ({ tool: s.tool, args: s.args || {} })),
    i,                                       // 做到第几步（断点，只用于"告诉她做到哪了"）
    progress,                                // 她自己写的进度备注（阶段 2 的 task_note）
    planStep,                                // 属于长期计划第几步
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttlMs,                                   // 过期：player 不过期、self 20 分钟、plan 不过期
    interruptions: 0,                        // 被打断几次
  };
}

/** 按设计第三节给 source 配默认 ttlMs（主人 2026-09-29：玩家交代的事没有过期时间） */
function ttlFor (source, explicit) {
  if (explicit != null) return explicit;
  if (source === 'self') return 20 * 60 * 1000;   // 她自己想做的：20 分钟
  return null;                                     // player / plan：不过期
}

/** 过期时刻（null = 永不过期） */
function expiresAt (t) { return t.ttlMs == null ? null : (t.createdAt + t.ttlMs); }

/** 现在过期了没有。她自己想做的（self）超过 ttl → true；主人的事永远 false。 */
function isExpired (t, now = Date.now()) {
  if (isPlayerTask(t)) return false;              // 主人交代的永远不过期（设计第七节）
  const at = expiresAt(t);
  return at != null && now > at;
}

/** 显示成"做到第 3 步：……"（设计第六节那两行里的括号内容；i 是**已完成**步数） */
function stepNote (t) {
  const n = Math.min(t.i || 0, (t.steps || []).length);
  if (n > 0 && t.steps?.length) {
    const doneNames = t.steps.slice(0, n).map(s => s.tool).join('、');
    return `做到第 ${n} 步：${doneNames}${t.progress ? `，${t.progress}` : ''}`;
  }
  if (t.progress) return t.progress;
  if (t.steps?.length) return `还没开始（共 ${t.steps.length} 步）`;
  return t.progress || '';
}

/** 被打断的理由说人话（设计第六节那两行里"（被打断：…）"） */
function pausedText (t) {
  return { player: '主人插了别的事', instinct: '保命本能抢走了身体', self: '她自己换了别的事', restart: '重启了' }[t.pausedWhy] || `(${t.pausedWhy || '被中断'})`;
}

function capStatus (s) {
  return ({ queued: '排着', running: '在做', paused: '停下了', done: '做完了', failed: '没做成', dropped: '放下了', expired: '过期了' })[s] || s;
}

// ------------------------------------------------------------------ 状态（挂在 W.tasks）

/** 取 `W.tasks`（唯一一份）。`state.js` 没准备好时兜一个进程内的，免得自测前置顺序炸掉。 */
function store () {
  const W = require('./state').W;
  const S = (W.tasks ||= { seq: 0, list: [] });
  // 第一次用到就从文件读回来（2026-09-29 Claude 复核补）：原来只有自测会调 load()，正式运行从不读 ——
  // 重启后第一件新任务 save() 时会把整个文件覆盖成只剩它，上次没做完的事全丢。
  if (!S.loaded && !S.__loading) { S.__loading = true; try { load(); } finally { S.__loading = false; } }
  return S;
}

/** 自测用：清空（只动内存） */
function _reset () { const S = store(); S.seq = 0; S.list = []; }

function all () { return store().list; }

/** 一件事（含所有状态；阶段 1 不删除，这样"最近 10 件结束的"也拿得到 —— 见设计第十节） */
function get (id) { return all().find(t => t.id === +id) || null; }

/** 当前 running 的那件 */
function running () { return all().find(t => t.status === 'running') || null; }

/** 排着 / 停着、还没做完的（她该惦记的）—— 按设计第六节 3 的建议顺序 */
function open () {
  const S = store();
  const bad = (t) => isExpired(t);
  return S.list.filter(t => (t.status === 'queued' || t.status === 'paused') && !bad(t));
}

/** 已经收尾的（done / failed / dropped / expired），最近的在后面 */
function finished () { return all().filter(t => ['done', 'failed', 'dropped', 'expired'].includes(t.status)); }

// ------------------------------------------------------------------ 变更 + 落盘

/** 每种状态的第一次变化写一行 `📋 #id 标题 running→paused(x)`（设计第十节）。 */
const LOG_FROM = new Set(['queued', 'running', 'paused']);

function logLine (t, from, to) {
  const f = from === 'created' ? '' : from;
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 📋 #${t.id} ${t.title} ${f}→${to}${to === 'paused' && t.pausedWhy ? `(${t.pausedWhy})` : ''}`);
}

/** 状态真正变了才写一行（避免同一件事反复刷）。`to==='paused'` 时带 pausedWhy。 */
function setStatus (t, to, { at = Date.now() } = {}) {
  const from = t.status;
  if (from === to && !(to === 'paused')) return t;   // 从 paused 再 paused 不重复写
  // ⚠️ 从 finished 里"复活"（dropped → queued）也要写一行，但 from 是终态时不套 LOG_FROM 的格式
  t.status = to;
  t.updatedAt = at;
  if (LOG_FROM.has(from) || LOG_FROM.has(to)) logLine(t, from, to);
  return t;
}

/**
 * 新建一件。**同一件事合并**（设计第七节）：同 `source` + 同 title（主人的话就是同一句原话）
 * 且还没收尾 → 返回原来那件（不重复建）。
 */
function create (fields = {}) {
  const S = store();
  const src = fields.source || 'self';
  const key = keyOf({ title: fields.title, said: fields.said });
  // 去重只在"没做完的"里找（做完的同一件事她可能又要做一次，那是新任务）
  const live = all().find(t => t.source === src && keyOf(t) === key && !['done', 'failed', 'dropped', 'expired'].includes(t.status));
  if (live) return { task: live, created: false };
  const t = makeTask({ ...fields, source: src });
  t.ttlMs = ttlFor(src, fields.ttlMs);
  t.id = ++S.seq;
  S.list.push(t);
  const from = t.status;
  t.status = 'queued';
  t.updatedAt = Date.now();
  logLine(t, from === 'queued' ? 'created' : from, 'queued');
  save();
  return { task: t, created: true };
}

/** 变 running：先把别的 running 停下（一个身体只有一件事在做）。 */
function setRunning (id, { at = Date.now() } = {}) {
  const t = get(id);
  if (!t) return null;
  for (const o of all()) if (o.status === 'running' && o.id !== t.id) pause(o.id, o.pausedWhy || 'self', { at });
  setStatus(t, 'running', { at });
  save();
  return t;
}

/**
 * 停下（不丢 —— 设计第二节）。**从 running 再 paused 时 `interruptions++`**，
 * 这正是"被打断几次"的计数（设计第三节 `interruptions`）。
 */
function pause (id, why = 'self', { at = Date.now() } = {}) {
  const t = get(id);
  if (!t) return null;
  if (t.status === 'running') t.interruptions = (t.interruptions || 0) + 1;
  if (t.status === 'paused' && t.pausedWhy === why) return t;   // 没有新信息，不刷日志
  t.pausedWhy = why;
  setStatus(t, 'paused', { at });
  save();
  return t;
}

function done (id, { at = Date.now() } = {}) {
  const t = get(id); if (!t) return null;
  t.pausedWhy = null;
  setStatus(t, 'done', { at }); save(); return t;
}
function fail (id, { at = Date.now() } = {}) {
  const t = get(id); if (!t) return null;
  t.pausedWhy = null;
  setStatus(t, 'failed', { at }); save(); return t;
}
function drop (id, { why = null, at = Date.now() } = {}) {
  const t = get(id); if (!t) return null;
  t.pausedWhy = null;
  if (why) t.progress = `放下了：${String(why).slice(0, 60)}`;
  setStatus(t, 'dropped', { at }); save(); return t;
}
function expire (id, { at = Date.now() } = {}) {
  const t = get(id); if (!t) return null;
  setStatus(t, 'expired', { at }); save(); return t;
}

/** 主人说"都别做了 / 算了 / 不用了" → 队列里 player 的全部 dropped（self 不动，设计第五节） */
function dropPlayerTasks ({ why = null, at = Date.now() } = {}) {
  const out = [];
  for (const t of all()) {
    if (isPlayerTask(t) && (t.status === 'queued' || t.status === 'paused' || t.status === 'running')) {
      out.push(drop(t.id, { why, at }));
    }
  }
  return out;
}

/** 把"已经过期但还没标"的 self 任务标掉（重启 / 每次变动时扫一遍）。返回标掉的件数。 */
function sweepExpired (now = Date.now(), { persist = true } = {}) {
  let n = 0;
  for (const t of all()) {
    if (t.status === 'queued' || t.status === 'paused') {
      if (!isPlayerTask(t) && isExpired(t, now)) { setStatus(t, 'expired', { at: now }); n++; }
    }
  }
  if (n && persist) save();
  return n;
}

/** 跑得最久的那件（供排序"越久的越前"，设计第六节 3） */
const age = (t) => t.createdAt;

// ------------------------------------------------------------------ 打断（设计第五节）

/**
 * 这一轮她发出的动作**会不会动身体**（判据只有 `NO_BODY_TOOLS` 一份）。
 * 空数组 = 这一轮只动嘴 / 只看 → 不打断（并行）。
 */
function movesBody (actions) {
  return (actions || []).some(a => !NO_BODY_TOOLS.has(a?.tool));
}

/**
 * 这一轮的动作要不要打断当前 running 任务（设计第五节那张表）。
 * `kind` ∈ 'say' | 'stop' | 'follow' | 'action'（'say' 是这一轮只有不动身体的工具）。
 *
 * 判据（**只有这一份**，`actions.js` 的 `startJob` 只管照做，think 里不再自己判一遍）：
 *   · 只动嘴 / 只看（`movesBody` 为假）        → 不打断（`kind:'say'`）
 *   · 有 `stop`                               → `paused(player)`（`kind:'stop'`）
 *   · 有 `follow` / `come_to`                 → `paused(player)`（`kind:'follow'`）
 *   · 其余动身体的动作                         → `paused(self)`（`kind:'action'`）
 *
 * 「主人刚开口 = player」是**调用方**传进来的（`heardPlayer`）—— 判据不自己读上下文，
 * 好让自测能直接驱动它。
 */
function interruptKind (actions, { heardPlayer = false } = {}) {
  const acts = actions || [];
  if (!movesBody(acts)) return 'say';                                  // 不动身体的，不打断
  const tools = new Set(acts.map(a => a?.tool));
  if (tools.has('stop')) return 'stop';
  if (tools.has('follow') || tools.has('come_to')) return 'follow';
  return heardPlayer ? 'player' : 'self';
}

/** 这一轮该给 paused 填的理由（设计第五节：主人刚开口 = player） */
function pauseWhyFor (kind, { heardPlayer = false } = {}) {
  if (kind === 'player') return 'player';              // 调用方已判明"主人插了一件事"
  if (kind === 'action' || kind === 'self') return heardPlayer ? 'player' : 'self';
  return 'player';   // stop / follow：都是主人做的
}

/**
 * 本能抢了身体（收到本能的 reject / abort，或 `/instinct` 显示 urgent —— 设计第五节）。
 * 当前 running → `paused(instinct)`；没有 running 就返回 null（不用凭空造一件）。
 */
function onInstinct (reason = '') {
  const t = running();
  if (!t) return null;
  t.interruptions = (t.interruptions || 0) + 1;
  return pause(t.id, 'instinct');
}

// ------------------------------------------------------------------ 持久化（照 memory-store.js 的原子写）

function save (file = FILE()) {
  const S = store();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = JSON.stringify({ version: 1, seq: S.seq, tasks: S.list }, null, 1);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // Windows：目标文件被别的进程打开时 rename 会 EPERM/EBUSY —— 退回直接写（不原子，但总比这次不存强）
      warn(`[tasks] 原子替换失败（${e.code || e.message}），改为直接写入`);
      fs.writeFileSync(file, data);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return true;
  } catch (e) {
    warn(`[tasks] 存盘失败：${e.message}`);
    return false;
  }
}

/**
 * 读盘（照 memory-store.js 的 load：只加载一次，之后以内存为准）。
 * 文件不存在 = 从没有过任务（正常，不是错）。坏 JSON / 读不出来 = `unreadable`（**不静默**，
 * 也不把 seq 归零 —— "没有"和"读不到"必须分开报，见项目 AGENTS.md §5-1）。
 */
function load (file = FILE()) {
  const S = store();
  if (S.loaded) return { unreadable: S.unreadable || false };
  S.loaded = true;
  if (!fs.existsSync(file)) { S.seq = S.seq || 0; S.list = S.list || []; return { unreadable: false, empty: true }; }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
    S.list = list.map(t => ({ ...makeTask({ title: t.title, said: t.said, source: t.source }), ...t }));
    S.seq = Math.max(Number(raw?.seq) || 0, ...S.list.map(t => t.id || 0), 0);
    return { unreadable: false };
  } catch (e) {
    S.unreadable = true;
    warn(`[tasks] 读不出来（${e.message}）—— 当"没有任务"继续，但这次别覆盖旧文件`);
    return { unreadable: true };
  }
}

/**
 * 醒来时的接手（设计第三节：重启后 `running` 一律改成 `paused(restart)`，过期的直接标 `expired`）。
 * 返回醒来该告诉她的那些（现在只用来写日志 / 自测断言；阶段 2 会拿去拼提醒）。
 */
function restore (now = Date.now()) {
  const S = store();
  const out = { restarted: [], expired: [], unreadable: !!S.unreadable };

  // 醒来先把 running 放回 paused(restart) —— **必须在扫过期之前**：
  // 一件跑着的 self 任务如果正好到期，她醒来该看到的是"停下了（重启的）"而不是"过期了"
  // （跑着的东西不该因为进程重启就悄悄丢掉）。
  for (const t of all()) {
    if (t.status === 'running') {
      t.pausedWhy = 'restart';
      setStatus(t, 'paused', { at: now });
      out.restarted.push(t);
    }
  }

  // 再扫过期（不写盘；load 刚读过同一份，从这里 save 会盖掉"读不到"的旧文件，见 load 的注释）。
  // 这里**不能**直接调 sweepExpired()：它只返回件数，拿不到"是哪儿件" ——
  // 而醒来要告诉她的正是"哪几件过期了"（阶段 2 要拿去拼提醒），所以判据同一份、收集自己做一遍。
  for (const t of all()) {
    if ((t.status === 'queued' || t.status === 'paused') && !isPlayerTask(t) && isExpired(t, now)) {
      setStatus(t, 'expired', { at: now });
      out.expired.push(t);
    }
  }

  if (out.restarted.length || out.expired.length) save();
  return out;
}

// ------------------------------------------------------------------ 上下文那两行（设计第六节 1）

/** 排着的按**建议顺序**（她不一定要照 —— 只是建议）：player > plan > self；同类 paused 先于 queued；越久的越前 */
const SRC_RANK = { player: 0, plan: 1, self: 2 };
function sortOpen (list) {
  return list.slice().sort((a, b) => {
    const s = (SRC_RANK[a.source] ?? 9) - (SRC_RANK[b.source] ?? 9);
    if (s) return s;
    const p = (a.status === 'paused' ? 0 : 1) - (b.status === 'paused' ? 0 : 1);
    if (p) return p;
    return age(a) - age(b);
  });
}

/**
 * 【手上的事】/【排着的】两行（最多 5 行，**没有任务时整段不出现** —— 别占上下文）。
 *
 * ```
 * 【手上的事】#17 做一把铁镐（主人交代，做到第 3 步：已经做了木棍，还缺 3 个铁锭）
 * 【排着的】#18 去砍点木头（为了 #17）· #15 把家里暗处插亮（被打断：主人叫你过来）
 * ```
 *
 * `related` 是"为了 #id"的反向指针：一件任务的 `parent` 指向谁，那件就是"为了它"。
 * 返回 `''` 表示没有任务（buildNow 直接把它丢掉，不落地成空行）。
 */
function contextLines ({ max = 5 } = {}) {
  const cur = running();
  const rest = sortOpen(open()).filter(t => t.id !== cur?.id);
  const lines = [];
  const parentTag = (t) => (t.parent && get(t.parent) ? `（为了 #${t.parent} ${get(t.parent).title}）` : '');
  if (cur) {
    const who = cur.source === 'player' ? `主人交代${cur.askedBy ? `（${cur.askedBy}）` : ''}` : cur.source === 'plan' ? '计划里的一步' : '自己想做的';
    const note = stepNote(cur);
    lines.push(`【手上的事】#${cur.id} ${cur.title}（${who}${note ? `，${note}` : ''}）${parentTag(cur)}`);
  }
  const restLine = rest.slice(0, max - (cur ? 1 : 0)).map(t => {
    const why = t.status === 'paused' ? `（被打断：${pausedText(t)}）` : '';
    return `#${t.id} ${t.title}${parentTag(t)}${why}`;
  }).join(' · ');
  if (restLine) lines.push(`【排着的】${restLine}`);
  return lines.join('\n');
}

/**
 * `contextLines()` 里**报了几件任务**（手上的 + 排着的），供自测钉住"最多 5 条"这个上限。
 *
 * 为什么不数 `#\d+`：`（为了 #1 做一把铁镐）` 这种反向指针里也带 `#id`，
 * 用正则数会把"为了谁"当成第 6 件 —— 那是**数法**错，不是**渲染**错（设计第六节 1 的上限是 5 件）。
 * 所以按"实际被摆出来的任务"数，和 `contextLines` 走**同一份**判据，不另抄一遍。
 */
function contextCount ({ max = 5 } = {}) {
  const cur = running();
  const rest = sortOpen(open()).filter(t => t.id !== cur?.id);
  return (cur ? 1 : 0) + Math.min(rest.length, max - (cur ? 1 : 0));
}

// ------------------------------------------------------------------ 附加小项：同一目的地来回走

/**
 * 记一次"去某个地方"（`goto` / `come_to` / `follow`）。背包没变、且时间窗内同点 ≥ 3 次 → 提醒。
 *
 * 状态挂在 `W.spotTries = { key, x, z, at, invKey, n }`（**只有一处**：`state.js` 里声明，
 * 这里读写同一份 —— 见 ../AGENTS.md 铁律）。不落盘：这是"此刻在原地打转"的短时状态，
 * 重启后重来（和 `W.seenChat` 同类）。
 *
 * @returns {string} 非空 = 要提醒她的一句话（调用方拼进上下文 / 工具结果）
 */
function noteSpot (tool, args, state, { now = Date.now() } = {}) {
  const W = require('./state').W;
  const d = destOf(tool, args, state);
  if (!d) return '';
  const inv = invKey(state?.items);
  const key = `${d.x},${d.z}`;
  const p = W.spotTries;
  // 同一个点（3 格内）+ 时间窗内 + 背包没变 → 累加；否则重开
  if (p && p.key !== key && Math.hypot(p.x - d.x, p.z - d.z) <= SAME_SPOT_RADIUS && now - p.at <= SAME_SPOT_WINDOW_MS) {
    if (inv !== p.invKey) { W.spotTries = { key, x: d.x, z: d.z, at: now, invKey: inv, n: 1 }; return ''; }  // 背包变了：这一趟不是白跑，重新数
    p.n++; p.at = now; p.key = key; p.x = d.x; p.z = d.z;
  } else if (p && p.key === key && now - p.at <= SAME_SPOT_WINDOW_MS) {
    if (inv !== p.invKey) { W.spotTries = { key, x: d.x, z: d.z, at: now, invKey: inv, n: 1 }; return ''; }
    p.n++; p.at = now;
  } else {
    W.spotTries = { key, x: d.x, z: d.z, at: now, invKey: inv, n: 1 };
    return '';
  }
  if (W.spotTries.n >= SAME_SPOT_TURNS) return spotHint(W.spotTries.n, d);
  return '';
}

/**
 * 那句提醒（**只有一处文案**）。说清：去了几次、东西还是没拿到、让她换个办法。
 * 阈值（3 次 / 3 格 / 2 分钟 / 背包不变）写在文件头的常量里，理由也写在那儿。
 */
function spotHint (n, { x, z }) {
  return `你已经去 (${x},${z}) 这里 ${n} 次了，东西还是没拿到 —— 换个办法（捡 / 挖 / 看看是什么挡着），或者跟他说一声`;
}

/** 人话了没有：她拿到东西了 / 换了目的地 → 清掉重数（`look.js` 在背包变化时调） */
function clearSpot () { const W = require('./state').W; W.spotTries = null; }

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, cond, d) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${JSON.stringify(d)}`}`); };
  // 2026-09-29 Claude 复核补：正式运行时没人调 load() —— 重启后第一件新任务会把文件覆盖成只剩它
  {
    const fs0 = require('fs'); const p0 = require('path').join(require('os').tmpdir(), `tasks-lazy-${process.pid}.json`);
    fs0.writeFileSync(p0, JSON.stringify({ version: 1, seq: 5, tasks: [{ id: 5, title: '上次没做完', source: 'player', status: 'running', ttlMs: null, createdAt: 1, updatedAt: 1 }] }));
    const was = process.env.MC_TASKS_FILE; process.env.MC_TASKS_FILE = p0;
    const W0 = require('./state').W; const keep = W0.tasks; W0.tasks = undefined;
    create({ title: '新的一件', source: 'player', said: '新的一件' });
    const onDisk = JSON.parse(fs0.readFileSync(p0, 'utf8')).tasks.map(t => t.title);
    check('★ 重启后建第一件新任务 → 文件里上次没做完的还在（先读回再写）', onDisk.includes('上次没做完') && onDisk.includes('新的一件'), onDisk);
    W0.tasks = keep; if (was === undefined) delete process.env.MC_TASKS_FILE; else process.env.MC_TASKS_FILE = was;
    try { fs0.unlinkSync(p0); } catch (_) {}
  }
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `tasks-selftest-${process.pid}.json`);
  for (const p of [tmp, tmp + '.tmp']) { try { fs.unlinkSync(p); } catch (_) {} }
  process.env.MC_TASKS_FILE = tmp;
  _reset();

  console.log('\n任务对象：字段照设计第三节');
  {
    const { task } = create({ title: '做一把铁镐', source: 'player', said: '帮我做把铁镐', askedBy: 'Ka_sum1', steps: [{ tool: 'mine', args: {} }], planStep: 2 });
    const fields = ['id', 'title', 'source', 'askedBy', 'said', 'status', 'pausedWhy', 'parent', 'steps', 'i', 'progress', 'planStep', 'createdAt', 'updatedAt', 'ttlMs', 'interruptions'];
    check('字段一个不少', fields.every(f => f in task), Object.keys(task));
    check('新建是 queued', task.status === 'queued' && task.id === 1, task);
    check('player 不过期（ttlMs=null）', task.ttlMs === null && isExpired(task, Date.now() + 1e12) === false);
    const s = create({ title: '自己去砍树', source: 'self' });
    check('self 20 分钟过期', s.task.ttlMs === 20 * 60 * 1000 && isExpired(s.task, Date.now() + 20 * 60 * 1000 + 1) === true);
    const pl = create({ title: '计划第一步', source: 'plan' });
    check('plan 不过期', pl.task.ttlMs === null);
  }

  console.log('\n合并：同一句话 / 同一件事不重复建');
  _reset();
  {
    const a = create({ title: '帮我做把铁镐', source: 'player', said: '帮我做把铁镐' });
    const b = create({ title: '帮我做把铁镐', source: 'player', said: '帮我做把铁镐' });
    check('同一句原话 → 不重复建（返回同一个）', a.created === true && b.created === false && b.task.id === a.task.id, { a, b });
    check('队列只有一件', all().length === 1, all().length);
    const c = create({ title: '做一把铁镐', source: 'player', said: '帮我做把铁镐' });
    check('同一句原话（即使 title 写法不同）→ 还是同一件', c.created === false);
    const d = create({ title: '帮我做把铁镐', source: 'self' });
    check('不同 source → 不合并', d.created === true && all().length === 2);
  }

  console.log('\n打断：不动身体的不碰当前任务（设计第五节）');
  _reset();
  {
    check('只发 scan_blocks / say → 不动身体', movesBody([{ tool: 'scan_blocks' }, { tool: 'say' }]) === false);
    check('只发 look_at / inventory / recipe → 不动身体', movesBody([{ tool: 'look_at' }, { tool: 'inventory' }, { tool: 'recipe' }]) === false);
    check('空 actions → 不动身体', movesBody([]) === false);
    check('mine / goto / craft → 动身体', movesBody([{ tool: 'mine' }]) && movesBody([{ tool: 'goto' }]) && movesBody([{ tool: 'craft' }]));
    check('名单外的（delve）算动身体（保守兜底）', movesBody([{ tool: 'delve' }]) === true);
    check('use_skill 算动身体', movesBody([{ tool: 'use_skill' }]) === true);
    check('kind：只看一眼 → say', interruptKind([{ tool: 'scan_blocks' }, { tool: 'say' }], { heardPlayer: true }) === 'say');
    check('kind：mine、他没说话 → self', interruptKind([{ tool: 'mine' }], { heardPlayer: false }) === 'self');
    check('kind：mine、他刚开口 → player', interruptKind([{ tool: 'mine' }], { heardPlayer: true }) === 'player');
    check('kind：stop → stop', interruptKind([{ tool: 'stop' }]) === 'stop');
    check('kind：come_to / follow → follow', interruptKind([{ tool: 'come_to' }]) === 'follow' && interruptKind([{ tool: 'follow' }]) === 'follow');
    check('paused 理由：主人刚开口 = player', pauseWhyFor('self', { heardPlayer: true }) === 'player' && pauseWhyFor('self', { heardPlayer: false }) === 'self');
    check('paused 理由：stop / follow 都是 player', pauseWhyFor('stop') === 'player' && pauseWhyFor('follow') === 'player');
  }

  console.log('\n打断：做 A 时发动作（跑的就是 startJob 那份判据）');
  _reset();
  {
    const { task: A } = create({ title: 'A', source: 'self', steps: [{ tool: 'mine' }, { tool: 'craft' }] });
    setRunning(A.id);
    check('A 变 running', A.status === 'running');
    // 只发不动身体的 → 不碰 A
    const k1 = interruptKind([{ tool: 'scan_blocks' }, { tool: 'say' }], { heardPlayer: true });
    check('★ 只发 scan_blocks / say → A 仍 running', k1 === 'say' && A.status === 'running', { k1, status: A.status });
    // 发 mine → A paused(self)、新的 running
    const k2 = interruptKind([{ tool: 'mine' }]);
    pause(A.id, pauseWhyFor(k2, { heardPlayer: false }));
    const { task: B } = create({ title: 'B', source: 'self', steps: [{ tool: 'mine' }] });
    setRunning(B.id);
    check('★ 发 mine → A paused(self)', A.status === 'paused' && A.pausedWhy === 'self', A);
    check('★ 新的成为 running', B.status === 'running', B);
    check('★ A 还在队列里（不丢）', get(A.id) === A && all().some(t => t.id === A.id), all().map(t => t.id));
    check('A 记了一次被打断', A.interruptions === 1, A.interruptions);
  }

  console.log('\n打断：stop / 都别做了 / 本能抢身体');
  _reset();
  {
    const { task: A } = create({ title: 'A', source: 'player', said: '帮我做把铁镐', askedBy: 'Ka_sum1' });
    setRunning(A.id);
    onInstinct('combat');
    check('★ 本能抢身体 → A paused(instinct)', A.status === 'paused' && A.pausedWhy === 'instinct', A);
    setRunning(A.id);
    // "都别做了 / 算了 / 不用了" → player 任务全部 dropped
    const p1 = create({ title: '主人交代的一件', source: 'player', said: '帮我挖点铁' }).task;
    const p2 = create({ title: '主人交代的另一件', source: 'player', said: '帮我把箱子理一下' }).task;
    const s1 = create({ title: '自己想做的', source: 'self' }).task;
    const dropped = dropPlayerTasks({ why: '主人说都别做了' });
    check('★ 主人说"都别做了" → player 任务全部 dropped', [A, p1, p2].every(t => t.status === 'dropped'), [A.status, p1.status, p2.status]);
    check('★ self 任务不动', s1.status === 'queued', s1.status);
    check('放下时说了声（progress 记了原因）', /都别做了/.test(get(p1.id).progress || ''), get(p1.id).progress);
    check('dropPlayerTasks 返回被放下的那些', dropped.length === 3, dropped.map(t => t.id));
    check('认得出放弃的话', DROP_ALL_RE.test('都别做了') && DROP_ALL_RE.test('算了不用了') && !DROP_ALL_RE.test('做完再看'));
  }

  console.log('\n持久化：写盘 / 读回来 / 重启接手');
  {
    _reset();
    const a = create({ title: '做一把铁镐', source: 'player', said: '帮我做把铁镐', askedBy: 'Ka_sum1', steps: [{ tool: 'mine', args: {} }], i: 1 }).task;
    const b = create({ title: '自己去砍树', source: 'self', steps: [{ tool: 'goto', args: { x: 1, z: 2 } }] }).task;
    setRunning(a.id);
    save(tmp);
    check('写盘后文件在、没有半截 .tmp', fs.existsSync(tmp) && !fs.existsSync(tmp + '.tmp'));
    // 重开一份内存（不重启进程）验证"读回来一致"
    const before = JSON.stringify({ seq: store().seq, list: all() });
    _reset(); store().loaded = false;
    const r = load(tmp);
    check('读得回来（不是 unreadable）', r.unreadable === false, r);
    check('内容一致', JSON.stringify({ seq: store().seq, list: all() }) === before, { before, now: JSON.stringify({ seq: store().seq, list: all() }) });
    check('★ player 任务过很久仍在（不过期）', isExpired(get(a.id), Date.now() + 30 * 86400000) === false);
    check('self 任务 21 分钟后过期', isExpired(get(b.id), Date.now() + 21 * 60 * 1000) === true);
    // 重启接手（restore 就是进程醒来时做的那一步）：running → paused(restart)、过期的 self → expired。
    // 一次 restore 里两件事**都得发生**：先把 running 改成 paused(restart)，再扫过期。
    // ⚠️ 所以顺序很讲究 —— restore 必须**先**收 running、**后**扫过期，否则一件到期的 running
    //    self 任务会被直接标成 expired（丢事）。下面两个断言就是在钉这个顺序。
    get(b.id).createdAt = Date.now() - 21 * 60 * 1000;   // 假装它是 21 分钟前建的（已经过期）
    const rep1 = restore();
    check('★ running 重启后是 paused(restart)', get(a.id).status === 'paused' && get(a.id).pausedWhy === 'restart', get(a.id));
    check('restore 报出"重启的"那件', rep1.restarted.length === 1 && rep1.restarted[0].id === a.id, rep1.restarted.map(t => t.id));
    check('★ 同一次 restore 里"过期的"那件也说清了（不静默）', rep1.expired.length === 1 && rep1.expired[0].id === b.id, rep1.expired.map(t => t.id));
    check('★ restore 把过期的 self 标成 expired', get(b.id).status === 'expired', get(b.id));
    check('player 任务即使很久也不过期（restore 只把它标成 paused(restart)）', get(a.id).status === 'paused' && get(a.id).pausedWhy === 'restart', get(a.id));
    _reset();   // 上面这些结束态别漏进下一段
    // 坏文件 → unreadable，不静默
    fs.writeFileSync(tmp, '{ 这不是 JSON');
    _reset(); store().loaded = false;
    const bad = load(tmp);
    check('★ 坏 JSON → unreadable=true（"读不到"和"没有"分开）', bad.unreadable === true, bad);
    for (const p of [tmp, tmp + '.tmp']) { try { fs.unlinkSync(p); } catch (_) {} }
  }

  console.log('\n上下文那两行（设计第六节 1）');
  _reset();
  {
    check('没任务时整段不出现', contextLines() === '', contextLines());
    const a = create({ title: '做一把铁镐', source: 'player', said: '帮我做把铁镐', askedBy: 'Ka_sum1', steps: [{ tool: 'mine' }, { tool: 'craft' }, { tool: 'give' }], i: 2, progress: '已经做了木棍，还缺 3 个铁锭' }).task;
    setRunning(a.id);
    const b = create({ title: '去砍点木头', source: 'self', parent: a.id }).task;
    const c = create({ title: '把家里暗处插亮', source: 'self' }).task;
    pause(c.id, 'player');
    const txt = contextLines();
    check('★ 有任务时出现【手上的事】', /^【手上的事】#\d+ 做一把铁镐/.test(txt), txt);
    check('★ 手上的事带上"主人交代"和做到的步数', /做一把铁镐（主人交代（Ka_sum1），做到第 2 步/.test(txt), txt);
    check('★ 【排着的】带"为了 #id"和"被打断"', /【排着的】.*去砍点木头（为了 #\d+ 做一把铁镐）/.test(txt) && /把家里暗处插亮（被打断：主人插了别的事）/.test(txt), txt);
    check('★ 建议顺序：player 那件在手上前，self 排后面', txt.indexOf('做一把铁镐') < txt.indexOf('去砍点木头'), txt);
    check('最多两行（手上的事 + 排着的）', contextLines().split('\n').length <= 2, contextLines().split('\n').length);
    for (let i = 0; i < 8; i++) create({ title: `杂事${i}`, source: 'self' });
    // ⚠️ 数"被摆出来的任务"。**不能**数 `#\d+`：`（为了 #1 做一把铁镐）` 里也有 `#1`，
    //    那样会数出 6（把反向指针当成第 6 件）—— 那是数法错，不是渲染错。
    const many = contextCount();
    const manyTxt = contextLines();
    check('★ 排队很多时合计最多 5 条（不占上下文）', many === 5, { many, txt: manyTxt });
    check('排着的行里恰好 4 件（手上 1 + 铺开 4 = 5）', (manyTxt.split('【排着的】')[1] || '').split(' · ').length === 4, manyTxt);
  }

  console.log('\n附加小项：同一目的地来回走（阈值 3 次 / 3 格 / 2 分钟 / 背包不变）');
  _reset();
  {
    const W = require('./state').W;
    const st = { pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_log', count: 1 }], players: [] };
    W.spotTries = null;
    let hint = '';
    const go = (x, z, items = st.items, t = null) => noteSpot('goto', { x, z }, { ...st, items }, { now: t || Date.now() });
    check('第 1 次去 → 不提醒', go(15665, 10020) === '');
    check('第 2 次去同一点 → 不提醒', go(15666, 10021) === '');
    hint = go(15664, 10020);
    check('★ 第 3 次去同一点（3 格内）、背包没变 → 提醒', /你已经去 \(15664,10020\) 这里 3 次了/.test(hint) && /东西还是没拿到/.test(hint) && /换个办法/.test(hint), hint);
    check('★ 第 4 次还是提醒（次数对）', /这里 4 次了/.test(go(15665, 10021)), go(15665, 10021));
    // 背包变了 → 不提醒、重数
    W.spotTries = null;
    go(1, 1); go(1, 1);
    hint = go(1, 1, [{ name: 'oak_log', count: 2 }]);
    check('★ 背包变了 → 不提醒（这一趟不是白跑）', hint === '', hint);
    check('背包变了之后重新从 1 数', W.spotTries.n === 1 && W.spotTries.invKey === 'oak_log:2', W.spotTries);
    // 不同点 → 不提醒
    W.spotTries = null;
    go(100, 100); go(200, 200); hint = go(300, 300);
    check('★ 不同目的地 → 不提醒', hint === '', hint);
    check('换点后状态是新的那个点', W.spotTries.x === 300 && W.spotTries.n === 1, W.spotTries);
    // 时间窗外的两次不算
    W.spotTries = null;
    const t0 = Date.now();
    go(7, 7, st.items, t0);
    go(7, 7, st.items, t0 + SAME_SPOT_WINDOW_MS + 1000);
    hint = go(7, 7, st.items, t0 + SAME_SPOT_WINDOW_MS + 2000);
    check('★ 超过 2 分钟窗口 → 重新数（不提醒）', hint === '', hint);
    // come_to 按玩家位置算目的地
    W.spotTries = null;
    const withP = { ...st, players: [{ username: 'Ka_sum1', position: { x: 50, y: 64, z: 60 } }] };
    noteSpot('come_to', { player: 'Ka_sum1' }, withP); noteSpot('come_to', { player: 'Ka_sum1' }, withP);
    hint = noteSpot('come_to', { player: 'Ka_sum1' }, withP);
    check('★ come_to 按玩家位置算同一个点', /\(50,60\) 这里 3 次了/.test(hint), hint);
    check('没有坐标也不是玩家的（follow 无参数）→ 不参与统计', noteSpot('follow', {}, st) === '');
    clearSpot();
    check('clearSpot 清干净', W.spotTries === null);
  }

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = {
  // 常量（只此一份 / 只此一处）
  NO_BODY_TOOLS, SAME_SPOT_TURNS, SAME_SPOT_RADIUS, SAME_SPOT_WINDOW_MS, SAME_SPOT_TOOLS, DROP_ALL_RE,
  // 任务对象
  makeTask, create, get, all, open, finished, running, ttlFor, expiresAt, isExpired, stepNote, pausedText, capStatus, keyOf,
  // 变更
  setRunning, pause, done, fail, drop, expire, dropPlayerTasks, sweepExpired,
  // 打断（只此一份判据）
  movesBody, interruptKind, pauseWhyFor, onInstinct,
  // 持久化
  save, load, restore,
  // 上下文 + 同点提醒
  contextLines, contextCount, sortOpen, noteSpot, spotHint, clearSpot,
  // 自测
  _reset, FILE, selftest,
};
