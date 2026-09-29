'use strict';

/**
 * 她说话的"形态"：把一段话拆成几条短消息，像真人打字那样一条条发。
 *
 * ## 为什么
 *
 * 数据（memory/journal.md 真实聊天）：玩家平均 12.6 字/条、79% 不到 20 字；
 * 她平均 43.8 字/条、只有 16% 不到 20 字。**她说的是"一段话"，真玩家说的是"几条短句"。**
 * 这是"AI 感"最大的来源 —— 用词本身挺好。
 *
 * ## 分段放在发送层（AstrBot 的做法）
 *
 * 人设里已经要求她说短、分条（示范也改成了分条形态），但模型不一定每次都照做。
 * 这里在发出去之前再兜一次底：按标点把长的拆成 2–4 条。
 *
 *   · **只拆不改字**：拆完后比对去掉标点和空白的文字，必须和原文一字不差，否则原样发（保真校验）
 *   · 句号、逗号去掉；情绪标点（！？…）留着；`～` 一轮最多留一个（在最后一条）
 *   · 括号里的小动作单独一条；坐标 (128, 64, -47) 不会被逗号拆开
 *   · 已经够短的不硬拆；最多 4 条
 *   · 危险提示（urgent）不拆 —— 拆开发会延迟关键信息
 *
 * 思路参考 saberlights/smart_segmentation_plugin（只借鉴思路，没有拷代码）。
 */

const PUNCT = /[，,。.!！?？…~～;；、：:\s—\-]/g;
const EMOTION_END = /[！!？?…]+$/;
const MAX_LEN = 12;
const MAX_SEGMENTS = 4;

/** 去掉标点和空白，只留字 —— 保真校验用 */
function wordsOnly (s) {
  return String(s).replace(/[（(][^）)]*[）)]/g, m => m.replace(PUNCT, '')).replace(PUNCT, '').replace(/[（）()「」"'“”]/g, '');
}

const punctCount = (s) => (String(s).match(/[，,。.!！?？…~～;；]/g) || []).length;
const len = (s) => [...String(s).replace(/\s/g, '')].length;

/**
 * 一段话 → 几条短消息。
 * 换行是她自己分好的条（优先尊重）；每条再按标点细分。
 */
// 括号里的小动作（不是坐标）：不发。用户要的是从语气里体会她，不是看她表演动作
const ACTION_RE = /[（(](?![\s\d-]*\d+\s*,)[^）)]*[）)]/g;

// 口头禅：偶尔冒出来才像真的。同一个口头禅 10 分钟内只让它出现一次
const CATCH = [/^诶[？?]*$/, /^我去[，,]?$/];
const lastCatch = new Map();
function limitCatchphrases (segs, now = Date.now()) {
  return segs.filter((s, i) => {
    const k = CATCH.findIndex(re => re.test(s.trim()));
    if (k < 0 || segs.length === 1) return true;
    if (now - (lastCatch.get(k) || 0) < 10 * 60 * 1000) return false;
    lastCatch.set(k, now);
    return true;
  });
}

function segment (text, { maxLen = MAX_LEN, maxSegments = MAX_SEGMENTS } = {}) {
  // 示范里用 ⏎ 表示"另起一条"，模型有时会照抄这个符号 —— 当换行处理
  const raw = String(text || '').replace(/\s*[⏎↵]\s*/g, '\n').replace(ACTION_RE, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!raw) return [];
  const pieces = [];
  for (const line of raw.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
    const hasAction = /[（(][^）)0-9-][^）)]*[）)]/.test(line);   // 括号小动作（不是坐标）总要单独一条
    if (!hasAction && len(line) <= maxLen && punctCount(line) <= 1) { pieces.push(line); continue; }
    // 保护：括号（小动作 / 坐标）整体不拆
    const tokens = [];
    const re = /[（(][^）)]*[）)]|[^（(]+/g;
    let m;
    while ((m = re.exec(line))) tokens.push(m[0]);
    for (const tk of tokens) {
      if (/^[（(]/.test(tk)) {
        // 坐标（全是数字）跟着前一条；小动作单独一条
        if (/^[（(]\s*-?\d+\s*,\s*-?\d+/.test(tk) && pieces.length) pieces[pieces.length - 1] += tk;
        else pieces.push(tk);
        continue;
      }
      // 按标点切，情绪标点留在前一段末尾
      const parts = tk.match(/[^，,。.!！?？…~～;；]+[!！?？…~～]*[，,。.;；]?/g) || [tk];
      for (let p of parts) {
        p = p.trim();
        if (!p) continue;
        pieces.push(p);
      }
    }
  }
  // 清理每段的结尾：句号逗号去掉，情绪标点留下
  let segs = pieces.map(p => p.replace(/[，,。.;；、：:]+$/, '').trim()).filter(p => wordsOnly(p) || /[！？!?]/.test(p));
  // 太碎的并回去：1 个字、又没有情绪的（"嗯"单独一条可以，"的"单独一条不行）
  const keepAlone = /^(诶|嗯|哦|啊|呜|嘿|哇|好|欸|唔|嘻|哼|我去)[！？!?…～,，]*$|[！？!?]$|^[（(]/;
  for (let i = segs.length - 1; i > 0; i--) {
    if (len(segs[i]) <= 1 && !keepAlone.test(segs[i])) { segs[i - 1] += segs[i]; segs.splice(i, 1); }
  }
  // 条数上限：把最短的相邻两条并起来
  while (segs.length > maxSegments) {
    let best = 0; let bestLen = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^[（(]/.test(segs[i + 1])) continue;
      const l = len(segs[i]) + len(segs[i + 1]);
      if (l < bestLen) { bestLen = l; best = i; }
    }
    segs.splice(best, 2, `${segs[best]} ${segs[best + 1]}`.replace(/(\S)\s(\S)/, (a, x, y) => (/[a-z0-9]/i.test(x) && /[a-z0-9]/i.test(y) ? `${x} ${y}` : `${x}${y}`)));
  }
  // `～` 不用（语气在话本身里，不靠符号堆）
  segs = segs.map(s => s.replace(/[~～]+/g, '').trim()).filter(Boolean);
  // 保真校验：只比字，字被改了就原样发（先校验，再按频率去掉重复的口头禅 —— 那是有意删的）
  if (wordsOnly(segs.join('')) !== wordsOnly(raw)) return [raw.replace(/[~～]+/g, '').slice(0, 256)];
  return limitCatchphrases(segs).map(s => s.slice(0, 256));
}

/** 条间停顿：按下一条的字数算打字时间，再加点随机（真人不会每次一样快） */
function gapFor (next) {
  return Math.round(350 + len(next) * 70 + Math.random() * 300);
}

// ------------------------------------------------------------------ 内容分类（判据只此一处）

/**
 * 她这一句话在干什么。别的判断（情绪、危险、发现）都归 other —— 那三类不是要说她少说。
 *
 *   report    汇报自己的动作 / 进度（"箱子理好了""我去插火把""挖了 3 个铁矿"）
 *   ask       问玩家（"要回去嗎""你還在底下嗎"）
 *   asksback  把决定推回给他的反问（"你想去哪呀""要不要一起去""你决定吧"）——
 *             和 ask 分开：他自己开的口、她在回答里夹的这种反问才拦（见下 `asksBack` 的说明）
 *   other     其他：感受、发现、危险、闲聊、跟他要东西
 *
 * ⚠️ 这是**统计用**的粗判，也是出口拦截（mind.js 的 REPORT_GATE / ASK_GATE / ASK_BACK_GATE）的判据。
 *    「发现」（看见没开过的箱子）和「危险」（有怪！）必须**不算**汇报 —— 那正是她该开口的事。
 *    两处共用这一份，改判据只改这里。
 */

// 她自己的动作：动词 + 完成/进行的样子
const REP_VERB = /(挖|採|采|砍|種|种|鋤|锄|澆|浇|烤|煮|燉|炖|燒|烧|做|合|合成|造|蓋|盖|建|搭|圍|围|修|整理|收拾|理好|歸位|归位|放好|放入|收進|收进|塞|搬|撿|捡|拾|插|鋪|铺|拆|換|换|穿|戴|裝備|装备|拿|帶|带|到家|回家|出門|出门|出發|出发|走|跑|過去|过去|過來|过来|跟上|睡|起床|醒|釣|钓|餵|喂|裝|装|備|备|準備|准备|正在|先|去)/;
// 完成式 / 进度式的收尾（"…好了""…完了""…了""…中"）
const REP_DONE = /(好了|好啦|完了|完畢|完毕|了|啦|中|呢|完|好|成|到位|歸位|归位|搞定|結束|结束)$/;
// 播报"我又做了 X"的第一人称动作句
const REP_SELF = /^(我|咱)(这就|就|马上|立刻|先|去|來|来|在|正|剛|刚|已經|已经|要|把|給|给|又|再)/;
// 明显不是汇报：发现、危险、情绪、对话/邀请（`我去` 单独成条才是被吓到，"我去插火把"是汇报）
const NOT_REPORT = /(看見|看见|發現|发现|瞅見|瞅见|瞧見|瞧见|聽到|听到|聞|好像|可能|感覺|感觉|覺得|觉得|怕|嚇|吓|危險|危险|救命|苦力怕|僵屍|僵尸|骷髏|骷髅|蜘蛛|怪物|有怪|死了|掉血|血不|疼|痛|嗚|呜|糟糕|完了呀|天哪|^我去[，,]?$|诶|欸|咦|走吧|走嗎|走吗|带我去|帶我去|带上我|帶上我|带我|帶我|陪你|一起[去走])/;

const ASK_MARK = /[？?]/;
// 疑问词。只认真的在问：他自己的打算 / 意愿 / 一样他的东西
// （`哪有` 不算 —— 被夸时的"哪有"是害羞，不是问东西在哪；真正问位置是"哪里/在哪/哪儿的"）
const ASK_WORD = /(嗎|吗)\s*$|哪[里兒儿]|在哪|洗哪|放哪|放哪层|放哪層|啥|什麼|什么|怎麼|怎么|要不要|行不行|好不好|對不對|对不对|可以不|能幫我|帮我|要不|多久|幾點|几点/;
const ASK_ONLY_KNOWER = /(你想|你要|你打算|你準備|你准备|你呢|你不|你要不要|你回來|你回来|你睡了|你在幹嘛|你在干嘛|你幹嘛|你干嘛|你去哪|你去過|你去过)/;

// ------------------------------------------------------------------ 把决定推回去的反问（问题 A，2026-09-29）

/**
 * 他刚开口 → 她回答他**不受限**；但回答里夹带的反问会把决定推回给他
 * （实机 19:10:16：他问"今天干嘛"，她答"先在家插点火把 / 省得老刷怪 / 你想去哪呀"）。
 * 主人 2026-09-29："尽量少询问玩家问题" —— 能自己定的自己定。
 *
 * **只有"反问决定"这一种反问拦**，两种情形照旧放行：
 *   · 他明确在问她的意见 / 要她给选项（"你说呢""你觉得哪个好""有什么建议""要我陪你吗"）
 *     → 她反问澄清是正常的（`ASK_ADVICE`）
 *   · 她问的是**只有他知道的事**（他要的东西具体是哪个、他人在哪、他刚才那句什么意思）
 *     → 那是该问的（`ASK_ONLY_KNOWER`，和 ask 类别共用同一份词表）
 *
 * 判据**只此一处**：gates.js 的 `askBackNudge` 和审计都调这里，不另抄一份正则。
 */
// 她把决定推回去时问的那些话（他自己刚被问过打算，她又拿同样的问题问他）
const ASK_BACK_RE = /(你想|你看呢|你觉得|你以为|你要不要|你想不想|你愿不愿意|你打算|你准备|你準備|你决定|你決定|你定|你选|你選|你说呢|你說呢|你来说|你來說|听你的|聽你的)/;
// 她在问"只有他知道的事"——**只**这几样，别把"你想去哪/你想做什么"也放进来（那正是要拦的）：
//   · 他要的那样东西具体是哪个 / 什么（"你要哪个""你要什么"）
//   · 看不见他时他在哪（"你在哪"；看得见的时候【此刻】里写着，问了就是废话）
//   · 他刚才那句话是什么意思（"你刚才说的是…？"）
//   · 带上我 / 我陪你（她在说自己，不是把决定丢回去）
const ASK_HIS_OWN = /(你想要什么|你想要什麼|你想要哪个|你想要哪個|你想要哪样|你想要哪樣|你要哪个|你要哪個|你要哪样|你要哪樣|你要什么|你要什麼|你打算要|你刚才说|你剛才說|你刚说的|你剛說的|你在哪|你在哪兒|你的人|陪你|带你|帶你)/;
// 他要她给个选项 / 出个主意（"你说呢""你觉得哪个好""有什么建议"）—— 这时候她反问澄清是正常的。
// ⚠️ 只挑"整句都在问她的意见"的那几种；"你觉得先挖矿还是先砍树"这种才是他在问她的意见。
const ASK_ADVICE = /(你说呢|你說呢|你觉得|你覺得|你看呢|你说说|你說說|哪个好|哪個好|哪样好|哪樣好|怎么办|怎麼辦|怎么样|怎麼樣|好不好|要不要我|要我陪|要一起|有什么建议|有什麼建議|给个建议|給個建議|听你的|聽你的|随便|隨便|都行|看你)/;
// 真在等一个回答的问句形态。她打字很口语，"你想去哪呀"常常不带问号 —— 语气词也算；
// "你想什么 / 你想做什么"这种**以疑问词开头**的整句本身就是问句，也认。
// 纯粹的陈述 / 邀请 / 她自己的动作（"我们走吧""带上我嘛""我去插火把"）不算。
const ASK_BACK_SHAPE = /^[^你]{0,2}(你想|你看|你觉得|你打算|你准备|你準備|你要不要|你想不想|你以为|你愿不愿意|你选|你選)|[？?]|吗|嗎|吧|呢|呀|啊|嘛|哦|要不要|行不行|好不好/;

/**
 * 这句话是不是"把决定推回给他"的反问。
 * @param {string} text   她说的话（单条）
 * @param {string} [playerSaid]  他刚说的那一句 —— 用来看他是不是在问她的意见 / 要选项
 */
// 不带"你"的邀请式反问："要不要一起去挖矿""去不去""一起吗" —— 他刚问她打算，她把"去不去"丢回给他
// （2026-09-29 Claude 复核补：原来要求句里有"你"，这种一句都拦不到）。只在他刚开口时算（审计不传 playerSaid 不算）。
const INVITE_BACK_RE = /(要不要一起|要不要跟我|要不要来|要不要去|一起吗|一起嗎|一起去吗|一起去嗎|去不去|来不来|來不來|一块儿吗|一塊兒嗎|要一起吗|要一起嗎)/;

function asksBack (text, playerSaid = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (playerSaid && INVITE_BACK_RE.test(t) && !ASK_ADVICE.test(String(playerSaid))) return true;
  if (!/你|您/.test(t)) return false;                                // 没提到他 → 不是在把决定推给他
  if (!ASK_BACK_RE.test(t)) return false;
  if (!ASK_BACK_SHAPE.test(t)) return false;
  // 只有他知道的事 → 该问。只认那几种（他具体想要哪个 / 看不见他时他在哪 / 他刚才那句）；
  // "你想去哪""你想做什么"这类**不在这里** —— 那是把决定推回给他（实机那句就是）。
  if (ASK_HIS_OWN.test(t)) return false;
  // ⚠️ `ASK_ADVICE` 只对着**他那一句**判，不看她自己这句。
  //    她自己这句写着"你觉得呢"正是要拦的（把决定丢回去）；他这句写着"你觉得哪个好"
  //    才是"他在问她的意见"（那时她反问澄清没关系）。两边共用一份词表，别各自再抄一份。
  if (ASK_ADVICE.test(String(playerSaid || ''))) return false;
  return true;
}

/**
 * 归类：report / ask / asksback / other。判据从上到下，先命中先算。
 * `playerSaid` 可选（只有出口拦截传；审计不传 → 只按话本身判）。
 */
function classify (text, playerSaid = '') {
  const t = String(text || '').trim();
  if (!t) return 'other';
  // 把决定推回给他的反问排在最前：它有确定的形态（提到他 + 问句），不会跟"我去插火把"这种撞。
  if (asksBack(t, playerSaid)) return 'asksback';
  // 汇报自己的动作优先于"问"：`我这就去放？` 这种形态极少，而"我去插火把"必须先算汇报
  if (REP_SELF.test(t) && REP_VERB.test(t)) return 'report';
  // 问玩家：有问号，或带疑问词，或问"只有他知道"的事
  if (ASK_MARK.test(t) || ASK_WORD.test(t) || ASK_ONLY_KNOWER.test(t)) return 'ask';
  if (NOT_REPORT.test(t)) return 'other';
  if (REP_VERB.test(t)) return 'report';
  return 'other';
}

// ------------------------------------------------------------------ 审计

/**
 * 她的发言形态：条数 / 平均字数 / <20 字占比 / 单条标点 >1 占比 / ～ 频率 / 口头禅次数。
 * 验收目标（SPEECH-REFORM.md 第六章）：平均 < 15 字、<20 字 > 80%、标点>1 < 20%、～ 0.2–0.3/条。
 */
function audit (lines) {
  const n = lines.length || 1;
  const lens = lines.map(len);
  return {
    count: lines.length,
    avgLen: +(lens.reduce((a, b) => a + b, 0) / n).toFixed(1),
    under20: +((lens.filter(l => l < 20).length / n) * 100).toFixed(0),
    punctOver1: +((lines.filter(l => punctCount(l) > 1).length / n) * 100).toFixed(0),
    tildePerMsg: +((lines.join('').match(/[~～]/g) || []).length / n).toFixed(2),
    catchphraseEh: lines.filter(l => /^诶[？?]/.test(l)).length,
    catchphraseWoqu: lines.filter(l => /^我去/.test(l)).length,
  };
}

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = typeof expect === 'function' ? expect(got) : JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实际 ${JSON.stringify(got)}`}`);
  };
  console.log('\n分段');
  check('长句拆成几条', segment('诶诶——有人在吗？我是 Angle_ICE，刚刚才醒过来…你在哪儿呀，我去找你～'), s => s.length >= 3 && s.length <= 4 && s.every(x => len(x) <= 14));
  check('已经够短的不拆', segment('你来啦'), ['你来啦']);
  check('她自己用换行分好的条原样保留', segment('好\n我去拿'), ['好', '我去拿']);
  check('口头禅 10 分钟内只出现一次', [segment('诶？\n你来啦'), segment('诶？\n又来啦')].map(x => x[0]), ['诶？', '又来啦']);
  check('句号逗号去掉，感叹号问号留着', segment('挖到3个铁矿啦！嘿嘿，要不要一起去？'), s => s.includes('挖到3个铁矿啦！') && s.some(x => x.endsWith('？')) && !s.some(x => /[，。]$/.test(x)));
  check('坐标不会被逗号拆开', segment('呜…血不多了，剩 5 格，我在 (128, 64, -47)'), s => s.some(x => x.includes('(128, 64, -47)')));
  check('括号小动作不发', segment('好呀这就来（小跑过去）'), ['好呀这就来']);
  check('～ 不发', segment('好～我来啦～马上到～'), s => !/[~～]/.test(s.join('')));
  check('最多 4 条', segment('一，二二，三三，四四，五五，六六，七七，八八'), s => s.length <= 4);
  check('只拆不改字（保真）', wordsOnly(segment('我在挖铁矿，已经3个了，再挖2个我们就够做镐子啦').join('')), wordsOnly('我在挖铁矿，已经3个了，再挖2个我们就够做镐子啦'));
  check('"我去，"单独成条', segment('我去，苦力怕，快跑！'), s => s[0] === '我去' && s.length >= 2);
  check('空的不发', segment('  '), []);
  check('照抄示范里的 ⏎ 也当换行', segment('早呀⏎醒了'), ['早呀', '醒了']);
  console.log('\n审计');
  const a = audit(['诶？', '你来啦', '挖到3个铁矿啦！嘿嘿～']);
  check('平均字数（2+3+11）/3', a.avgLen, 5.3);
  check('口头禅计数', a.catchphraseEh, 1);
  console.log('\n内容分类');
  check('完成式动作 → 汇报', ['箱子理好了', '我去插火把', '挖了3个铁矿', '我到家了'].map(classify), ['report', 'report', 'report', 'report']);
  check('疑问 → 问玩家', ['要回去嗎', '你還在底下嗎', '你在干嘛', '黏土在哪里'].map(classify), ['ask', 'ask', 'ask', 'ask']);
  check('发现和危险不是汇报', ['看见一个没开过的箱子', '有怪！', '那边有个箱子'].map(classify), ['other', 'other', 'other']);
  check('被夸的"哪有"是害羞，不是问', ['哪有'].map(classify), ['other']);
  check('感受 / 闲聊 → 其他', ['呜 摔疼了', '嘿嘿', '才没有'].map(classify), ['other', 'other', 'other']);
  check('空话归其他', [''].map(classify), ['other']);
  console.log('\n反问决定（问题 A，2026-09-29）');
  // 实机 19:10:16：他问"今天干嘛" → 她答完又反问
  check('★ 他问"今天干嘛"、她夹一句"你想去哪呀" → 反问决定', classify('你想去哪呀', '今天干嘛'), 'asksback');
  check('★ 他问"今天干嘛"、她回"要不要一起去挖矿" → 反问决定（不带"你"也算）', classify('要不要一起去挖矿', '今天干嘛'), 'asksback');
  check('他问"要我陪你吗"、她回"要一起吗" → 放行（他在问她意见）', classify('要一起吗', '要我陪你吗') !== 'asksback', true);
  check('没人刚开口时"要不要一起去"不归 asksback（走普通提问节流）', classify('要不要一起去挖矿') !== 'asksback', true);
  check('★ 同一轮里"先在家里插点火把"是回答 → 汇报（不拦）', classify('先在家里插点火把', '今天干嘛'), 'report');
  check('★ 他问她的意见 → 她反问澄清放行', classify('你想要哪个多点？', '你觉得先挖矿还是先砍树'), 'ask');
  check('★ 他刚开口、她只是回答"好呀" → 放行', classify('好呀', '今天干嘛'), 'other');
  check('"你决定吧""你觉得呢""你要不要一起去"都是反问决定', ['你决定吧', '你觉得呢', '你要不要一起去'].map(x => classify(x, '你想干嘛')), ['asksback', 'asksback', 'asksback']);
  check('问"只有他知道的事"放行：「你想要什么」「你在哪」', ['你想要什么', '你在哪'].map(x => classify(x, '你去挖矿吧')), ['ask', 'ask']);
  check('她自己的动作 / 邀请不算反问：「我们走吧」「带上我嘛」', ['我们走吧', '带上我嘛'].map(x => classify(x, '今天干嘛')), ['other', 'other']);
  check('直接问位置（不在只有他知道的名单里）仍是问玩家', classify('南瓜放哪层好'), 'ask');
  check('审计不传他的话时，"你觉得呢"仍认得出是反问决定', classify('你觉得呢'), 'asksback');
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { segment, gapFor, audit, classify, asksBack, wordsOnly, len, punctCount };
