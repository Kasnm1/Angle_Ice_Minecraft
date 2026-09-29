// gates.js —— 说话出口的几道闸 + 事实核对。
//
// 主人 2026-09-29 定的"少汇报、少问、不说没发生的事"（拦下后不静默吞掉，
// 往历史里塞一条 ok:false + 提示，让她自己重想）：
//
// - `REPORT_NUDGE` / `ASK_TOO_MUCH_NUDGE` / `ASK_BACK_NUDGE` / `HONEST_NUDGE` / `DECIDE_NUDGE` / `LOOK_NUDGE`
// - `isOverAsking()` / `lastProactiveUnanswered()` / `taskDoneAllowed()`：该不该问
// - `claimState()` / `liveFails()` / `unbackedClaim()` + `FACT_CLAIMS` / `OK_RE` / `FAIL_RE`：
//   说的完成式在最近工具结果里找不到成功的记录就拦
// - `DELEGATES` / `ASKS_BACK` / `ASKS_WHERE`：他让你自己定、你却问回去
// - `isBareAffirmative()` / `QUIET_MS` / `RECENT_CLAIM_MS` / `PLAYER_MOVE_*` / `TASK_*`
//
// **加一类完成式只改这里的 `FACT_CLAIMS` 表**；加一类说话内容改 `speech.js` 的 `classify()`
// （只此一处，`scripts/speech-audit.js` 也用那一份）。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');

const DELEGATES = /你(来|來|去|自己|先)?(规划|規劃|定|决定|決定|安排|看着办|看著辦|设计|設計|挑|选|選|负责|負責|弄|做|搞|整理|布置|佈置)/;
const ASKS_BACK = /[？?]|吗|嗎|哪|什么|什麼|怎么|怎麼|要不要|行不行/;
const DECIDE_NUDGE = '没发出去：他让你自己来定、来做，你却又问回他。自己拿主意（想想哪样合适），直接说你的决定然后去做，比如"放地下室了"；错了他会说。把问题去掉再说一次。';
const ASKS_WHERE = /(在哪|放哪|哪里有|哪儿有|哪有)/;
const LOOK_NUDGE = '没发出去：你还没自己看一眼就问他东西在哪。先 scan_blocks / look_around / inventory / home_stock 看看，真找不到再问。';
const SAY_NUDGE = '（你刚才写的只是心里想的，他看不见。要回他就调 say 说出来；觉得不用回也行。）';

/**
 * 她已经答应了却只做资料查询时的补问。
 * 只触发一次，避免把正常的“我先查一下”变成连环催促；补问后仍做不到，
 * 由模型自己调用 report_issue 或说清楚原因，不能再用一句“好”假装完成。
 */
const ACTION_NUDGE = '（你刚才只查了资料，还没有执行答应的事。现在根据查到的结果立即调用一个实际行动工具（例如 make_item、craft、cook_pot、goto、pickup 等）；如果当前确实做不到，就明确说出原因并调用 report_issue，不能只说“好”。）';
function isBareAffirmative (text) {
  return /^(好|好的|好嘞|行|可以|没问题|收到|好呀|好哦)[！!。．.、，,\s]*$/u.test(String(text || '').trim());
}

// ------------------------------------------------------------------ 说话出口的三道闸（2026-09-29 主人："尽量少汇报自己的动作状态，尽量少询问玩家问题"）

/**
 * 判据在 `speech.js` 的 `classify()`（**只此一处**，审计脚本也用这一份）。
 * 这里只管"什么时候拦、拦下来给她什么提示"。
 *
 * ⚠️ "汇报""提问"两道以 `heJustSpoke` 为准：他这一刻跟她说话了 → 这两道不拦
 *    （回答他不受限 —— 接他的话、答他的问，本来就不算汇报，也不该被当成"爱问"）。
 *    **"诚实"这道任何时候都拦**，而且看 RECENT_CLAIM_MS 内跨轮的结果（2026-09-29 Claude 复核：
 *    实机"我睡了呀 剛起床"正是回他的话、且睡觉 ✗ 在上一轮）。
 *    拦下不是静默吞掉：往历史里塞一条 ok:false + 提示，让她自己重想（照 LOOK_NUDGE 的老办法）。
 */

/** 他最近这么久没跟她说话 = "没人问她"，汇报才拦 */
const QUIET_MS = 30 * 1000;
/** "不说没发生的事"看多久以内的工具结果（跨轮）：实机睡觉失败到她说"睡了"隔了 41 秒、一轮 */
const RECENT_CLAIM_MS = 3 * 60 * 1000;
/** 走路类工具：打架时要玩家标记才能打断战斗 */
const PLAYER_MOVE_TOOLS = new Set(['goto', 'come_to', 'follow']);
/** 他在叫她动：过来 / 跟上 / 快跑 / 回来 / 别打了 / 走了 */
const PLAYER_MOVE_RE = /(过来|過來|来这|來這|到我这|到我這|跟[我上着著]|快[来來跑走]|跑|回来|回來|别打|別打|走了|走吧|撤|救我|帮我|幫我)/;

/** 他交代事情之后多久以内，"做完了"算回他（不是播报） */
const TASK_WINDOW_MS = 10 * 60 * 1000;
/** 他的话像在交代事：帮我 / 你去 / 把… / 给我 / 去… / 整理 / 做个… */
const TASK_ASK_RE = /(帮我|幫我|你去|去把|把.{1,12}(放|理|整理|做|拿|收|挖|砍|烤|煮|种|種|搬)|给我|給我|整理|收拾|做[个個一把]|拿[个個一些点點]|挖[些点點一]|砍[些点點一]|去[拿挖砍找采採种種收]|来一|來一)/;
const TASK_DONE_RE = /(好了|好啦|做好|弄好|理好|放好|收好|搞定|完成|做完|挖完|收完|到了|拿到了|没做成|做不了|弄不了|找不到)/;
/**
 * 他交代的事做完 / 做不成，说一声 —— 放行（主人 2026-09-29）。条件：是"完成 / 失败"的话，
 * 他 TASK_WINDOW_MS 内**交代过事**（他的话匹配 TASK_ASK_RE —— 光是说过话不算），而且这次交代之后还没报过（一次交代只报一次）。
 * 她自己决定去做的事，做完照旧不播报（REPORT_NUDGE）。
 */
function taskDoneAllowed (text, { now = Date.now(), lastTaskAskedAt = 0, lastTaskDoneSaidAt = 0 } = {}) {
  if (!TASK_DONE_RE.test(String(text || ''))) return false;
  if (!lastTaskAskedAt || now - lastTaskAskedAt > TASK_WINDOW_MS) return false;
  return !(lastTaskDoneSaidAt && lastTaskDoneSaidAt >= lastTaskAskedAt);
}

/** 问他的节流：这么久之内第 2 次问就拦（同一个问题他没回、又问一次，也拦） */
const ASK_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * "家里挺暗的，要插火把吗" —— **唯一**被允许反问的那句话（主人 2026-09-29 要的火把开关）。
 *
 * 为什么单开一道口：那道"少问 / 别反问"的闸按 `speech.asksBack()` 拦一切反问，
 * 而"要插火把吗"本来就是**该问的问题**（家里插不插火把是主人的事，基地布局归他，
 * 本能不敢自作主张 —— 见 instinct/mining.js 的 torchSituation）。所以放行它。
 *
 * ⚠️ **不是"所有问句都放行"**（TASK 硬要求）。只有同时满足这四条才放行：
 *   ① 这一句是**带着标记**发的：`say` 的 `askPlayer === 'torch'`
 *      （事件带 `askPlayer:'torch'`，她在调 say 时说这句话时填上；不填就是个普通问句，照拦）；
 *   ② 本体就是"要插火把吗"这类的（`TORCH_ASK_RE`）—— 防止"填个标记混别的问句过去"；
 *   ③ **同一个问题**的冷却还管着（`TORCH_ASK_COOLDOWN_MS` 内说过一次就不再放行）——
 *      放行不等于可以追着问；
 *   ④ 主人最近没有刚跟她说话（`heJustSpoke` 时回答他本来不受限，走的是另一条路，不用这道）。
 *
 * **错填标记不讨好**：不带 ② 的话她随便说个"你想去哪呀"再填 `torch` 就绕过了闸；
 * 带上 ② 之后，标记只是"确认这是本能请她问的那件事"，问法还是得对得上。
 */
const TORCH_ASK_RE = /(要|要不要|需要|需不需要|要不要我|用不用)[^。！？!?]{0,8}(插|點|点|放)[^。！？!?]{0,4}(火把|燈|灯|亮)/;
/** 同一个火把问题的冷却：这么久之内说过一次，就不再放行第二遍（和 ASK_COOLDOWN_MS 一致） */
const TORCH_ASK_COOLDOWN_MS = ASK_COOLDOWN_MS;

/**
 * @param {string} text                 要说的话
 * @param {string|null} askPlayer        `say` 带的标记（'torch' = 本能请她问的火把）
 * @param {object} [o]
 * @param {number} [o.now]
 * @param {number} [o.lastTorchAskSaidAt] 上一次放行说出去的时刻（同一个问题别追着问）
 * @returns {boolean} true = 放行这句话（不拦"反问 / 少问"）
 */
function torchAskAllowed (text, askPlayer = null, { now = Date.now(), lastTorchAskSaidAt = 0 } = {}) {
  if (askPlayer !== 'torch') return false;                       // ① 没标记：不是这件事
  if (!TORCH_ASK_RE.test(String(text || ''))) return false;      // ② 说的不是"要插火把吗"
  if (lastTorchAskSaidAt && now - lastTorchAskSaidAt < TORCH_ASK_COOLDOWN_MS) return false;   // ③ 同一个问题冷却
  return true;
}

const REPORT_NUDGE = '没发出去：这是播报你自己的动作 / 进度，他就在旁边看得见，不用你说。做完了就是做完了 —— 除非他问你，或者这里面有他非知道不可的事（出事了、缺东西要他要、要他定）。要开口就说点别的（接他的话、说你的感觉），或者干脆把这条撤了。';
const ASK_TOO_MUCH_NUDGE = '没发出去：你刚问过他，他没回，又问一次了。能自己判断的自己定（去不去、要不要、先做哪个），做完他自然会说对不对；真只有他知道的（他想要什么、他打算去哪），那也等这次问完再说，别追问。';
/**
 * 他在问你打算干嘛，你答完又把问题丢回给他（"你想去哪呀""你要不要…""你决定吧"）。
 * 判据在 `speech.js` 的 `asksBack()`（**只此一处**）—— 他刚开口时回答他本来不受限，
 * 但答案里夹带的这种反问要拦（2026-09-29 实机 19:10:16）。拦下不静默吞掉，让她自己重想。
 */
const ASK_BACK_NUDGE = '没发出去：他问你打算干嘛，你就说你打算干嘛，别把问题丢回去。能自己定的自己定（去哪、先做哪个、要不要带上他），直接说你的决定然后去做 —— 错了他会说。把这句话改成你要做的事再说一次。';
const HONEST_NUDGE = (why) => `没发出去：这句话说的是已经做完的事，但最近的工具结果里没有它成功的记录 —— ${why}。照实说（比如"没做成""还没好"），或者干脆别提这件事。`;

/** 她刚问过他 / 上一个问题还没回 —— 再问就拦 */
function isOverAsking (text, now = Date.now()) {
  if (speech.classify(text) !== 'ask') return false;
  const last = W.lastAskedAt || 0;
  if (!last) return false;
  return now - last < ASK_COOLDOWN_MS;
}

/** 上一次主动开口他没回（见 W.lastProactive）—— 他还没回就又问，算追问 */
function lastProactiveUnanswered (now = Date.now()) {
  const p = W.lastProactive;
  return !!(p && p.answered === false && now - p.t < ASK_COOLDOWN_MS);
}

/**
 * 说完成式的时候，"这件事真成了没有"。
 *
 * 每类只认一种常见说法 + 一种工具；本轮（或身体刚回报的）工具结果里必须有它 ✅ 的记录，
 * 否则算"说了没发生的事"。找不到对应工具记录的**不算**（宁可不拦，也不冤枉她）——
 * 只有工具**明确报了 ✗**、或者本轮同类工具**只报失败**时才拦。
 *
 * 判据和 `speech.js` 的 classify 一样**只写一处**：加一类只改这张表。
 */
const FACT_CLAIMS = [
  { id: 'sleep', re: /(我?睡(了|著|着)|睡(好|醒)了|起床了|刚醒|醒来了|睡一觉)/, tool: /^sleep_in_bed$/, what: '睡觉' },
  { id: 'put', re: /(放(好|进|入)(了|去|箱)|收(好|进|起)(了|去)|塞(进|好)(了|去)|整理(好|完)了|理好了|歸位|归位|放回去了)/, tool: /^(store_items|organize_storage|sort_container|place|place_nicely)$/, what: '放进去 / 整理好' },
  { id: 'make', re: /(做(好|成)(了|啦)?|烤(好|上)(了|啦)?|煮(好|上)(了|啦)?|合(好|成)(了)?|(做|烤|烧|燒|煮|合)(出|了)来|完成了|搞定了|弄好了)/, tool: /^(craft|make_item|cook_pot|smelt|furnace)$/, what: '做好 / 烤上' },
  { id: 'arrive', re: /(我?(到家|到了)|到地方了|到家了|到了地方|已经(到|回)|回来了|我回来了)/, tool: /^(goto|go_home|come_to|run_command|climb|climb_down)$/, what: '到了某处' },
];
const OK_RE = /"ok"\s*:\s*true|✓|成功|arrived=true|made=|crafted=|mined=|got=/;
const FAIL_RE = /"ok"\s*:\s*false|error|failed|睡不了|走不到|还缺|做不了|没有我能用的配方|被叫停|没启动/;

/** 本轮结果里这件事的真假：'ok' | 'fail' | null（没相关记录，不判） */
function claimState (claim, results) {
  const mine = results.filter(r => claim.tool.test(String(r.tool || '')));
  if (!mine.length) return null;
  const ok = mine.some(r => typeof r.out === 'object' && r.out && (r.out.ok === true || OK_RE.test(JSON.stringify(r.out))));
  if (ok) return 'ok';
  const failed = mine.some(r => typeof r.out === 'object' && r.out && (r.out.ok === false || FAIL_RE.test(JSON.stringify(r.out))));
  return failed ? 'fail' : null;
}

/**
 * 这一轮身体刚回报的失败。两种形态都认（实机日志里都有）：
 *   `❌ sleep_in_bed() 没做成：睡不了…`      ← startJob 的失败（进 pending 的那一条）
 *   `↳ sleep_in_bed() ✗ 睡不了…`             ← bridge 的原始结果行（有的会原样进 pending）
 * 身体动作的 ✅/✗ 不进 `toolResults`（那是 LLM 调工具的结果），但它同样是"有没有发生"的证据。
 */
function liveFails (ev) {
  const out = [];
  for (const e of ev || []) {
    const t = String(e.text || '');
    let m = t.match(/❌\s*([a-zA-Z_]+)\([^)]*\)\s*没做成：(.+)$/);
    if (!m) m = t.match(/↳\s*([a-zA-Z_]+)\([^)]*\)\s*✗\s*(.+)$/);
    if (m) out.push({ tool: m[1], failed: true, why: m[2].trim().slice(0, 140) });
  }
  return out;
}

/**
 * 这句话有没有本轮的工具结果撑着。有 → null；没有 → 返回失败原因（串进提示里）。
 * `live` 是身体刚回报的结果（`now.ev` 里的 ↳ 行）—— 那些不在 `results` 里，单独看。
 */
function unbackedClaim (text, results, live = []) {
  const t = String(text || '');
  for (const c of FACT_CLAIMS) {
    if (!c.re.test(t)) continue;
    const st = claimState(c, results);
    if (st === 'fail') {
      const why = results.filter(r => c.tool.test(String(r.tool || '')))
        .map(r => (r.out && (r.out.error || r.out.note)) || JSON.stringify(r.out)).join('；').slice(0, 120);
      return `${c.what}的工具结果是失败的：${why}`;
    }
    if (st === null && live.some(x => c.tool.test(String(x.tool || '')) && x.failed)) {
      const why = live.filter(x => c.tool.test(String(x.tool || '')) && x.failed).map(x => x.why).join('；').slice(0, 120);
      return `${c.what}的身体动作报错了：${why}`;
    }
  }
  return null;
}


module.exports = { isBareAffirmative, taskDoneAllowed, isOverAsking, lastProactiveUnanswered,
  claimState, liveFails, unbackedClaim, FACT_CLAIMS, REPORT_NUDGE, ASK_TOO_MUCH_NUDGE, ASK_BACK_NUDGE, HONEST_NUDGE,
  QUIET_MS, ASK_COOLDOWN_MS, DELEGATES, ASKS_BACK, DECIDE_NUDGE, ASKS_WHERE, LOOK_NUDGE, SAY_NUDGE,
  ACTION_NUDGE, RECENT_CLAIM_MS, PLAYER_MOVE_TOOLS, PLAYER_MOVE_RE, TASK_WINDOW_MS, TASK_ASK_RE, TASK_DONE_RE,
  torchAskAllowed, TORCH_ASK_RE, TORCH_ASK_COOLDOWN_MS };
