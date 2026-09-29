// scene.js —— 感知的"人话"层：把状态翻译成她看得懂的一行行。
//
// - `humanState()` / `tonight()`：血量 / 饥饿 / 天色怎么写
// - `combatInstinct()` / `combatGuard()` / `attackGuardReason()`：认怪、该不该打
// - `survivalFocus()`：眼下最要紧的一件事（保命 / 跟着主人 / 心愿）
// - `dayKey()` / `dropsNear()` / `dropLine()` / `invText()`：按天节流、地上掉落、背包
// - `surroundNeeds()` / `surroundLine()`：余光（32 格内看得见的）
// - `pickJoinMood()` / `JOIN_MOODS`：他上线那一刻她的心情（只是提示）
//
// `W.history` / `W.job` 换来的 `bodyNow`（think.js）和 `shortName` 用 wiring 延迟取；
// `W` 是 `require('./state')` 来的**同一个对象**。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const wiring = require('./wiring');
function bodyNow (...a) { return wiring.think().bodyNow.apply(null, a); }
const shortName = (id) => knowledge.label(id).replace(/\([^)]*\)$/, '');

function humanState (s) {
  if (!s) return '（看不到自己的状态）';
  const hp = s.health; const food = s.food;
  const hpWord = hp == null ? '?' : hp >= 18 ? '很好' : hp >= 12 ? '还行' : hp >= 6 ? '受伤了' : '快不行了';
  const foodWord = food == null ? '?' : food >= 17 ? '饱' : food >= 11 ? '不饿' : food >= 7 ? '有点饿' : '很饿';
  const when = s.phase ? { day: '白天', dusk: '黄昏（快天黑了）', night: '夜晚', dawn: '快天亮了' }[s.phase] : (s.isDay ? '白天' : '夜晚');
  const where = { open: '露天', partial: '露天', sheltered: '有顶的地方', underground: '地下' }[s.exposure] || '';
  return `血 ${hp}/20（${hpWord}）、饥饿 ${food}/20（${foodWord}）、${when}${s.time != null ? `（时刻 ${s.time}）` : ''}、在 (${s.pos?.x},${s.pos?.y},${s.pos?.z})${where ? `，${where}` : ''}`;
}

/**
 * 眼下最该操心的（生存优先级）：每一刻按局面算一两件，写进【此刻】。只是提醒她看清局面，怎么做还是她自己定。
 * 主人 2026-09-26 定的方向：没家先安家（FTB 新手小屋）、夜里躲危险/睡觉/在家干活、家附近插火把、背包快满先进精妙背包再回家整理。
 * 依据：modpack-study/survival/report.md（本包没有普通玩家的传送命令；火把地面每 12 格一个；背包剩 ≤8 格就回家整理）。
 */
/** 今晚怎么安排（白天为 null）。天色事件和"眼下最该操心的"共用这一处。 */
function tonight (s) {
  if (!s || !s.pos) return null;
  const home = mem.getHome();
  const sf = W.sleepFail && Date.now() - W.sleepFail.t < 3 * 60 * 1000 ? W.sleepFail : null;
  return night.nightPlan({
    phase: s.phase || (s.isDay === false ? 'night' : null),   // 老 bridge 只有 isDay
    exposure: s.exposure || 'unknown',
    atHome: !!(home && mem.inHome(s.pos)),
    hasHome: !!home,
    homeDist: home ? Math.hypot(s.pos.x - home.center.x, s.pos.z - home.center.z) : null,
    following: s.following || null,
    sleepFail: sf ? sf.why : null,
  });
}

/** 战斗本能在打吗？在打就返回它打的是谁（mind 用这个把身体让开）。
 *  bridge 的 GET /instinct 给 combatNow（只在战斗时非 null）和 urgent；名字从她看到的怪里挑离得最近的。 */
function combatInstinct (s) {
  const I = s?.instinct;
  const now = I?.combatNow || (I?.urgent === 'combat' ? {} : null);
  if (!now) return null;
  const hostile = (s.nearby || []).filter(e => e.kind === 'hostile').sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
  const name = hostile ? knowledge.label(hostile.name.includes(':') ? hostile.name : `minecraft:${hostile.name}`) : '怪';
  return { name, since: now.since || null, killed: now.killed || 0, engaged: now.engaged || 0 };
}

/**
 * 战斗状态是不是"新的、可信的"（codex R-fix4-7）。
 *
 * 问题：`beforeAttack` 以前只看 `combatInstinct(W.state)`。而 `/instinct` 是慢轮询 ——
 *   · 读失败时 `W.state.instinct === null`，看起来就像"没在打架"；
 *   · 战斗刚开始、还没轮到下一次轮询时，也还是 null。
 *   这两种情况她都会照样把 `/attack` 发出去，只能靠 bridge 后端再拒一次。
 *
 * 判据（AGENTS §5：证据不足时保守）：
 *   · 本能层根本没**成功读到过**（`instinct === null` 且从来没读到过）→ 视为"未知"；
 *   · 状态太旧（超过 freshnessMs）→ 视为"未知"；
 *   · 只要"未知"且**附近有敌对目标**（战斗迹象）→ 保守认为可能在打架，先别 attack。
 *
 * @param s              W.state
 * @param o.freshnessMs  状态多久算旧（默认 6 秒；/instinct 大约这一量级轮询一次）
 * @returns {unknown:boolean, stale:boolean, hostile:boolean, ci:object|null}
 */
function combatGuard (s, { freshnessMs = 6000 } = {}) {
  const hostile = (s?.nearby || []).some(e => e.kind === 'hostile');
  const at = s?.instinct?.readAt || 0;
  const stale = !at || (Date.now() - at > freshnessMs);
  const ci = combatInstinct(s);
  return { unknown: !s?.instinct || stale, stale, hostile, ci };
}

/**
 * `beforeAttack` 的判据本体（抽出来好离线测 —— 自测里也是它，不另抄一份）。
 * 返回''=放行；返回非空字符串=拦下并说明原因（body 会把它当错误回给模型）。
 */
function attackGuardReason (s) {
  const g = combatGuard(s);
  if (g.ci) return `本能在打${g.ci.name}，不用插手`;
  if (g.unknown && g.hostile) return '战斗状态还没读准、身边又有怪，这一下先别挥（等本能/下一拍状态）';
  return '';
}

function survivalFocus (s) {
  if (!s || !s.pos) return [];
  const out = [];
  const home = mem.getHome();
  const atHome = home && mem.inHome(s.pos);
  const hostiles = (s.nearby || []).filter(e => e.kind === 'hostile' && e.distance <= 12);
  const free = 36 - (s.items || []).length;
  const names = (s.items || []).map(i => (i.name.includes(':') ? i.name : `minecraft:${i.name}`));
  const has = (re) => names.some(n => re.test(n));
  if ((s.health != null && s.health <= 8) || hostiles.length) {
    out.push(`保命：${s.health <= 8 ? `血只有 ${s.health}` : ''}${hostiles.length ? `${s.health <= 8 ? '，' : ''}身边 ${hostiles.length} 只怪（最近 ${hostiles[0].distance} 格）` : ''} —— 打得过就打，打不过就躲进屋/挖个洞堵上，血少先吃东西`);
  }
  // 天黑（主人 2026-09-27）：保命之后第一件，不能被别的挤出前两条
  const plan = tonight(s);
  if (plan) out.push(plan);
  // 暗处（主人：像玩家一样别往暗处去；真要去就带火把点亮）
  const fuel = has(/(^|:)(coal|charcoal)$/);
  if (s.dark && !atHome) {
    out.push(s.torches ? `脚下很暗（亮度 ${s.light?.block}）：插火把点亮（light_up）再往前` : `这里很暗又没带火把：别往里走，退回亮的地方${s.lastBright ? `（上次亮的地方 goto ${s.lastBright.x},${s.lastBright.y},${s.lastBright.z}）` : ''}${fuel ? '，或者先用煤做火把（make_torches）' : ''}；有人陪着也一样，边说边走`);
  }
  if (s.torches === 0) out.push(fuel ? '身上没火把：有煤/木炭，先做一组（make_torches）' : '身上没火把：看得见的煤矿先挖，或者原木进熔炉烧木炭 → 做火把（下矿、过夜都要用）');
  // 家外打不过、跑不掉：垫方块自救
  if (!atHome && hostiles.length && ((s.health != null && s.health <= 10) || hostiles.length >= 3)) {
    out.push(`打不过就垫方块自救：原地往上垫 3 格（self_rescue mode=pillar），或者把自己四面围住（self_rescue mode=enclose）`);
  }
  const boxes = s.unseenChests || [];
  if (boxes.length && !hostiles.length) {
    const b = boxes[0];
    const wild = boxes.filter(c => c.outdoor).length;
    // 野外箱子/木桶（任务书第 4 条，主人点名）：**手不忙就先开**——野外没开过的箱子是奖励箱，
    // 一次性的，别人（这个服只有主人和她）不会替你留着。所以排在别的活前面，
    // 但**不是压倒一切**：主人在叫你做事、在打架、夜里露天、血少 —— 这些先（和 pickLoot 的跳过条件一致）。
    const busy = s.following || /follow|guard|attack|fight|escape|mine|delve|self_rescue/i.test(s.currentAction || '');
    const risky = hostiles.length > 0 || (s.health != null && s.health <= 10);
    if (wild && !busy && !risky) {
      out.unshift(`野外有 ${wild} 个没打开过的箱子/木桶（最近的在 ${b.x},${b.y},${b.z}，${b.distance} 格）：手不忙就先过去开（check_chests），里面的东西拿走`);
    }
    out.push(`视线里有 ${boxes.length} 个没打开过的箱子/木桶（最近的在 ${b.x},${b.y},${b.z}，${b.distance} 格）：先过去看（check_chests）—— 家外的是奖励箱，东西拿走；家里的看看放了什么`);
  }
  if (!home) {
    out.push(has(/structure_spawner/)
      ? '还没有家，身上有结构生成器（新手小屋）：挑块平地 place_structure 放下，进屋后 set_home'
      : '还没有家：先安家 —— FTB 任务书「新手小屋」点对号就送（quest_submit 新手小屋 → quest_claim 新手小屋 choice=0 森林小屋 → place_structure → set_home）；拿不到就挖进山里 1×2×2、堵住身后、插火把过夜');
  }
  // 夜里的安排（回家 / 睡觉 / 在矿洞接着挖 / 就地躲）在上面 tonight() 里 —— 按她在野外、屋里还是地下分开说。
  // "刚睡不了别反复上床"也搬过去了（实测：睡不了就一直 上床→失败→转身→再上床，看着像原地转圈）。
  if (free <= 8) {
    const packWorn = (s.curios || []).some(x => /backpack/.test(x));
    out.push(packWorn && (s.backpack ? s.backpack.used < s.backpack.slots - 4 : true)
      ? `身上只剩 ${free} 格：先把杂物装进背包（open_backpack → store_items）`
      : `身上只剩 ${free} 格${packWorn ? '、背包也快满了' : ''}：回家整理（go_home → organize_storage）`);
  }
  const drops = dropsNear(s, 8);
  if (drops.length && !hostiles.length && free > 0) {
    out.push(`地上有掉落物（${drops.slice(0, 3).map(x => (x.id ? knowledge.label(x.id).replace(/\([^)]*\)$/, '') : '东西') + '×' + x.count).join('、')}）：砍树挖矿打怪掉的东西顺手捡起来（pickup）`);
  }
  if (home && atHome && s.isDay && has(/(^|:)torch$/) && W.torchDay !== dayKey()) {
    W.torchDay = dayKey();   // 一天提醒一次
    out.push('家附近暗的地方插火把防刷怪（地面大约每 12 格一个）');
  }
  return out.slice(0, 2);
}
const dayKey = () => new Date().toDateString();

/** 地上的掉落物（她砍树、挖矿、打怪掉的，别人扔的）—— 按物品合并，最近的在前 */
function dropsNear (s, maxDist = 12) {
  const m = new Map();
  for (const e of s?.nearby || []) {
    if (!e.isDrop || e.distance > maxDist) continue;
    const id = e.item?.name ? (e.item.name.includes(':') ? e.item.name : `minecraft:${e.item.name}`) : null;
    const k = id || '?';
    const cur = m.get(k) || { id, count: 0, distance: e.distance };
    cur.count += e.item?.count || 1; cur.distance = Math.min(cur.distance, e.distance);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => a.distance - b.distance);
}
function dropLine (s) {
  const d = dropsNear(s);
  return d.length ? `地上的掉落物：${d.slice(0, 6).map(x => `${x.id ? knowledge.label(x.id).replace(/\([^)]*\)$/, '') : '某样东西'}×${x.count}（${x.distance}格）`).join('、')}` : '';
}

function invText (items) {
  return (items || []).map(i => `${knowledge.label(i.name.includes(':') ? i.name : `minecraft:${i.name}`)}×${i.count}`).join('、') || '空的';
}

/**
 * 她"现在缺什么" —— 喂给 `GET /surroundings` 的 needs，让桥接把她在意的东西排前面。
 *
 * 主人 2026-09-27："程序给事实、她自己排" —— 所以这里只是**排序线索**，不是命令：
 * 计划当前步 / 心愿（正在研究的菜）/ 刚合成缺的料（技能报"失败：缺 XX"）。
 * 拿不到就空着（桥接那边有自己的兜底排法：没开过的野外箱子永远在头两位）。
 */
function surroundNeeds () {
  try {
    const step = plan.current()?.text || '';
    const A = ambition.state();
    const focus = A.focus ? shortName(A.focus) : '';
    // 刚失败缺的料：技能报回来的（见 liveFails 函数和 W.recentLive），只挑"缺 XX"那半句
    const missing = (W.recentLive || []).map(x => String(x?.why || x?.text || '')).filter(x => /缺/.test(x)).slice(0, 4);
    return [step, focus, ...missing].filter(Boolean).join(' ').slice(0, 200);
  } catch (_) { return ''; }
}

/**
 * 提示词里的【附近看得见的】—— 就一行（任务书第 3 条：只能加这一行）。
 *
 * 主人："對野外資源不敏感" —— 她以前只有"身边 16 格实体"，看不见树/矿/黏土/箱子。
 * 现在桥接把 32 格内**看得见**的（露一面的就算）聚成几条，按"她缺什么 + 没开过的野外箱子"排好。
 * 三种情形**分开说**（任务书：绝不能只有一个"附近没有"）：
 *   ① 扫到了东西 → 照实念
 *   ② 扫过了、附近确实没有 → "这块看过了没有"（不是"全世界没有"）
 *   ③ 压根没读到（bridge 没起 / 端点旧） → "没看清"（不是"没有"）
 */
function surroundLine (s) {
  const su = s?.surroundings;
  if (su == null) return '';
  if (su.line) return `【附近看得见的】${su.line}`;
  // 记忆里有、只是这一刻 32 格里没看见 —— 那是"我记得在那边"，不是"没有"（分开说）
  return '【附近看得见的】这一片 32 格没扫到东西（看过了，不是"没有"—— 更远的在你记得的地方，问你在哪记得就行）';
}


/** 他上线那一刻她的心情（只是提示，怎么说还是她自己定） */
const JOIN_MOODS = [
  [0.45, '（你这会儿懒得开口，看他一眼就好，不用说话）'],
  [0.25, '（想扣个「？」给他，就一个问号）'],
  [0.30, '（随口招呼一下就行，一两个字，别每次都一样）'],
];
function pickJoinMood (r = Math.random()) {
  for (const [p, t] of JOIN_MOODS) { if (r < p) return t; r -= p; }
  return JOIN_MOODS[0][1];
}


module.exports = { humanState, tonight, combatInstinct, combatGuard, attackGuardReason, survivalFocus,
  dayKey, dropsNear, dropLine, invText, surroundNeeds, surroundLine, pickJoinMood, JOIN_MOODS };
