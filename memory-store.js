'use strict';

/**
 * 她自己的记忆 —— 对人的看法、从经历里长出来的知识图谱、教训和打算。
 *
 * ## 为什么不是一份规则表
 *
 * 上一版的"聪明"全是我替她写的规则（"饥饿 > 10 不准吃""说烹饪就先查用途"）。
 * 规则越堆越多，她并没有更懂事 —— 只是被绑得更紧（旧 autopilot 就死在这条路上）。
 *
 * Astra 在 Minecraft 里活了 141 小时，让玩家觉得"像人"的是：它记得自己经历过什么，
 * 规则是**它自己**从遭遇里写下来的（被苦力怕炸了 → "重要东西永远随身带"）。
 * 这个文件就是给她的那本笔记。**里面每一条都是她自己写的**，程序只负责存、找、强化、遗忘。
 *
 * ## 三种东西
 *
 *   people    每个玩家一份：她的印象（她自己的话）、好感、信任、知道的事
 *   memories  一条一条的记忆：
 *               lesson     教训（"给玩家做的吃的别自己吃"）
 *               promise    答应过的事（做完了要 done）
 *               intention  打算做的事 / 没做完的事
 *               fact       事实 / 发现（"家门口有个煙燻爐"）
 *               relation   知识图谱的一条边：主语 —关系→ 宾语（"egg —烤成→ fried_egg @smoker"）
 *               feeling    心情
 *   journal   只追加的日记（每次"睡觉整理"写一段）
 *
 * ## 像人一样记忆
 *
 *   · 想起来（recall）：按此刻涉及的人/物/地点，挑最相关、最牢的几条
 *   · 强化：同一件事再学一次 → 更牢；被想起来并用上 → 更牢；亲身经历 > 听说 > 书上看的
 *   · 遗忘：很久不用的会淡（不删，只是不容易想起来）
 *   · 修正：她发现错了可以改、可以划掉（stale）—— 避免 Astra 那种"教训钉死了再也不改"
 *
 * 存盘：memory/mind.json（整份重写，带 .bak）
 */

const fs = require('fs');
const path = require('path');

// 用到时才取路径：自测 / 模拟会在 require 之后才设 MC_MIND_FILE（写死在加载时会写进真的记忆）
const FILE = () => process.env.MC_MIND_FILE || path.join(__dirname, 'memory', 'mind.json');

const KINDS = ['lesson', 'promise', 'intention', 'fact', 'relation', 'feeling'];
const SOURCE_WEIGHT = { experience: 1.0, told: 0.8, read: 0.6, guess: 0.4 };
const HALF_LIFE_DAYS = 14;   // 不用的记忆，两周后"想起来的概率"减半

let S = null;
let dirty = false;

function empty () {
  return { version: 1, people: {}, memories: [], episodes: [], skills: [], journal: [], nextId: 1 };
}

function load (file = FILE()) {
  if (S) return S;
  try { S = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { S = empty(); }
  S.people ||= {}; S.memories ||= []; S.episodes ||= []; S.skills ||= []; S.journal ||= []; S.nextId ||= S.memories.length + 1;
  return S;
}

function save (file = FILE()) {
  if (!S || !dirty) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (_) {}
  fs.writeFileSync(file, JSON.stringify(S, null, 1));
  dirty = false;
}

function touch () { dirty = true; }

// ------------------------------------------------------------------ 关键词

/** 把一段话 / 一个 id 拆成可以对上号的关键词（中文按 2 字切，英文按词，id 保留整体和后半段） */
function keys (text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[a-z0-9_]+:[a-z0-9_/.-]+/g)) { out.add(m[0]); out.add(m[0].split(':')[1]); }
  for (const m of s.matchAll(/[a-z][a-z0-9_]{2,}/g)) out.add(m[0]);
  for (const m of s.matchAll(/[一-鿿]+/g)) {
    const w = m[0];
    if (w.length <= 4) out.add(w);
    for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

// ------------------------------------------------------------------ 写

/**
 * 记一条。同样的事（同主语-关系-宾语，或文字几乎一样）不重复记，而是**强化**它 ——
 * 人也是这样：第二次被烫到，记得比第一次牢。
 */
function learn ({ kind = 'fact', text, about = [], s, r, o, source = 'experience', due } = {}) {
  load();
  if (!KINDS.includes(kind)) kind = 'fact';
  if (kind === 'relation' && s && r && o && !text) text = `${s} —${r}→ ${o}`;
  if (!text) throw new Error('要写点什么');
  const aboutSet = [...new Set([...(about || []), ...(s ? [s] : []), ...(o ? [o] : [])].map(String))];
  const now = Date.now();

  const same = S.memories.find(m => m.status !== 'stale' && (
    (kind === 'relation' && m.kind === 'relation' && m.s === s && m.r === r && m.o === o)
    || (m.kind === kind && similar(m.text, text) > 0.8)));
  if (same) {
    same.strength = +(Math.min(10, same.strength + SOURCE_WEIGHT[source] || 0.5)).toFixed(2);
    same.reinforced = (same.reinforced || 0) + 1;
    same.lastUsed = now;
    if (SOURCE_WEIGHT[source] > SOURCE_WEIGHT[same.source]) same.source = source;   // 亲身验证过就升级
    same.about = [...new Set([...same.about, ...aboutSet])];
    touch();
    return { reinforced: true, id: same.id, strength: same.strength };
  }
  // 心情只留最近 3 条（人记得"最近的心情"，不会把每一次开心都存成一条）
  if (kind === 'feeling') {
    const fs2 = S.memories.filter(x => x.kind === 'feeling' && x.status === 'active');
    for (const old of fs2.slice(0, Math.max(0, fs2.length - 2))) old.status = 'stale';
  }
  const m = {
    id: S.nextId++, kind, text: String(text).slice(0, 300), about: aboutSet,
    s, r, o, source, strength: SOURCE_WEIGHT[source] ?? 0.5, reinforced: 0,
    created: now, lastUsed: now, uses: 0, status: kind === 'promise' || kind === 'intention' ? 'open' : 'active',
  };
  if (due) m.due = due;
  S.memories.push(m);
  touch();
  return { learned: true, id: m.id };
}

/** 改一条 / 划掉 / 标完成。她发现自己记错了、过时了、做完了 */
function revise (id, { text, status, strengthDelta } = {}) {
  load();
  const m = S.memories.find(x => x.id === +id);
  if (!m) throw new Error(`没有第 ${id} 条记忆`);
  if (text) m.text = String(text).slice(0, 300);
  if (status) m.status = status;              // active / stale / open / done
  if (strengthDelta) m.strength = +Math.max(0, Math.min(10, m.strength + strengthDelta)).toFixed(2);
  m.lastUsed = Date.now();
  touch();
  return { revised: m.id, status: m.status, strength: m.strength };
}

/** 对一个玩家的看法。impression 是她自己的话；affinity/trust 是 -100..100 的变化量 */
function judge (name, { impression, affinity = 0, trust = 0, fact, trait } = {}) {
  load();
  const p = S.people[name] ||= { name, impression: '', affinity: 0, trust: 0, facts: [], traits: [], firstMet: Date.now(), lastSeen: Date.now(), events: 0 };
  if (impression) p.impression = String(impression).slice(0, 200);
  p.affinity = Math.max(-100, Math.min(100, p.affinity + (+affinity || 0)));
  p.trust = Math.max(-100, Math.min(100, p.trust + (+trust || 0)));
  if (fact && !p.facts.some(f => similar(f, fact) > 0.8)) p.facts.push(String(fact).slice(0, 150));
  if (p.facts.length > 30) p.facts.shift();
  if (trait && !p.traits.includes(trait)) p.traits.push(String(trait).slice(0, 30));
  p.lastSeen = Date.now(); p.events++;
  touch();
  return { name, impression: p.impression, affinity: p.affinity, trust: p.trust };
}

// ------------------------------------------------------------------ 自动的经历记忆

/**
 * 人不用刻意也记得"今天发生了什么"：谁说了什么、收到了什么、做成了什么。
 * 这一层是**自动**的（她刻意写下的评价和教训建立在它上面）。存原话、带时间、按人/物能想起来，
 * 比刻意的记忆淡得快（半衰期 3 天）。以前只有对话上下文，一睡觉整理就没了。
 */
const EPISODE_HALF_LIFE_DAYS = 3;
const MAX_EPISODES = 4000;

function episode (text, about = []) {
  load();
  S.episodes.push({ t: Date.now(), text: String(text).slice(0, 240), about: [...new Set(about.map(String))] });
  if (S.episodes.length > MAX_EPISODES) S.episodes.splice(0, S.episodes.length - MAX_EPISODES);
  touch();
}

function recallEpisodes (cue, { limit = 6, before = Infinity } = {}) {
  load();
  const now = Date.now();
  const cueKeys = keys(Array.isArray(cue) ? cue.join(' ') : cue);
  const out = [];
  // before：比这个时间新的经历还在对话上下文里，不用"想起来"
  const pool = S.episodes.filter(e => e.t < before);
  for (const e of pool) {
    let overlap = 0;
    for (const a of e.about) if (cueKeys.has(String(a).toLowerCase())) overlap += 2;
    for (const k of keys(e.text)) if (cueKeys.has(k)) overlap += 0.3;
    if (overlap < 1) continue;
    const days = (now - e.t) / 86400000;
    out.push({ e, score: overlap * Math.pow(0.5, days / EPISODE_HALF_LIFE_DAYS) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.e).sort((a, b) => a.t - b.t);
}

function when (t, now = Date.now()) {
  const d = new Date(t); const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
  const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return days <= 0 ? `今天 ${hm}` : days === 1 ? `昨天 ${hm}` : `${days} 天前`;
}

/** 见到 / 听到一个玩家：自动建档（第一次见面、上次见、聊过几次）。印象和好感仍由她自己写 */
function meet (name, { chatted = false } = {}) {
  load();
  const p = S.people[name] ||= { name, impression: '', affinity: 0, trust: 0, facts: [], traits: [], firstMet: Date.now(), lastSeen: Date.now(), events: 0, chats: 0 };
  p.lastSeen = Date.now();
  if (chatted) p.chats = (p.chats || 0) + 1;
  touch();
  return p;
}

function sawPlayer (name) { meet(name); }

function diary (text) {
  load();
  S.journal.push({ t: Date.now(), text: String(text).slice(0, 1000) });
  if (S.journal.length > 500) S.journal.shift();
  touch();
}

// ------------------------------------------------------------------ 想起来

function similar (a, b) {
  const A = keys(a); const B = keys(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}

/** 此刻有多"牢"：强度 × 来源 × 遗忘曲线（越久没用越淡） */
function vividness (m, now = Date.now()) {
  const days = (now - (m.lastUsed || m.created)) / 86400000;
  return m.strength * Math.pow(0.5, days / HALF_LIFE_DAYS) * (1 + Math.log1p(m.uses || 0) * 0.2);
}

/**
 * 按线索想起最相关的几条。线索 = 此刻的聊天、涉及的人/物品/地点。
 * 没过期的承诺和打算**总是**会想起来（人不会忘了自己答应过的事 —— 至少不该忘）。
 */
function recall (cue, { limit = 8, markUsed = true } = {}) {
  load();
  const now = Date.now();
  const cueKeys = keys(Array.isArray(cue) ? cue.join(' ') : cue);
  const scored = [];
  for (const m of S.memories) {
    if (m.status === 'stale' || m.status === 'done') continue;
    let overlap = 0;
    for (const a of m.about) if (cueKeys.has(String(a).toLowerCase()) || cueKeys.has(String(a).toLowerCase().split(':')[1])) overlap += 2;
    for (const k of keys(m.text)) if (cueKeys.has(k)) overlap += 0.5;
    const always = m.status === 'open';
    if (!overlap && !always) continue;
    scored.push({ m, score: (overlap + (always ? 3 : 0)) * (0.5 + vividness(m, now)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit).map(x => x.m);
  if (markUsed) { for (const m of hits) { m.uses = (m.uses || 0) + 1; m.lastUsed = now; } if (hits.length) touch(); }
  return hits;
}

function person (name) {
  load();
  return S.people[name] || null;
}

/** 给意识流看的一段"想起来的东西"（她自己的笔记原样给她） */
function renderRecall (hits, names = []) {
  const lines = [];
  for (const n of names) {
    const p = person(n);
    if (!p) { lines.push(`· ${n}：还不认识`); continue; }
    lines.push(`· 对 ${n} 的印象：${p.impression || '（还没写过对他的印象）'}（好感 ${p.affinity}，信任 ${p.trust}；${p.firstMet ? `第一次见是${when(p.firstMet)}` : ''}${p.chats ? `，聊过 ${p.chats} 次` : ''}）${p.facts.length ? `；记得：${p.facts.slice(-5).join('；')}` : ''}`);
  }
  for (const m of hits) {
    const tag = { lesson: '教训', promise: '答应过', intention: '打算', fact: '记得', relation: '知道', feeling: '心情' }[m.kind];
    const src = m.source === 'experience' ? '' : m.source === 'told' ? '（听说的）' : m.source === 'read' ? '（书上看的）' : '（猜的）';
    lines.push(`· #${m.id} ${tag}：${m.text}${src}${m.reinforced ? `（第 ${m.reinforced + 1} 次记起）` : ''}`);
  }
  return lines.join('\n');
}

/** 睡觉整理时给她看：最近常用 / 最牢的教训和关系，让她检查有没有过时的 */
function forReview (limit = 20) {
  load();
  return S.memories.filter(m => m.status === 'active' && (m.kind === 'lesson' || m.kind === 'relation' || m.kind === 'fact'))
    .sort((a, b) => vividness(b) - vividness(a)).slice(0, limit);
}

function stats () {
  load();
  const by = {};
  for (const m of S.memories) by[`${m.kind}/${m.status}`] = (by[`${m.kind}/${m.status}`] || 0) + 1;
  return { people: Object.keys(S.people).length, memories: S.memories.length, episodes: S.episodes.length, skills: S.skills.length, byKind: by, journal: S.journal.length };
}

function _reset () { S = empty(); dirty = false; }

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, cond, detail) => { total++; if (cond) pass++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${JSON.stringify(detail)}`}`); };
  _reset();

  console.log('\n记与强化');
  const a = learn({ kind: 'lesson', text: '给 Ka_sum1 做的吃的不能自己吃掉', about: ['Ka_sum1', 'food'] });
  check('新记一条', a.learned === true);
  const b = learn({ kind: 'lesson', text: '给 Ka_sum1 做的吃的不能自己吃掉！', about: ['Ka_sum1'] });
  check('同样的事再记一次 → 强化，不重复', b.reinforced === true && S.memories.length === 1, b);
  const r1 = learn({ kind: 'relation', s: 'minecraft:egg', r: '烤成', o: 'farmersdelight:fried_egg', source: 'read' });
  const r2 = learn({ kind: 'relation', s: 'minecraft:egg', r: '烤成', o: 'farmersdelight:fried_egg', source: 'experience' });
  check('书上看的，亲手做过一次 → 来源升级为亲身经历', r2.reinforced && S.memories.find(m => m.id === r1.id).source === 'experience');

  console.log('\n想起来');
  learn({ kind: 'fact', text: '家门口 (38,64,-139) 有个烟熏炉', about: ['smoker', 'home'] });
  learn({ kind: 'promise', text: '答应给 Ka_sum1 烤鸡蛋', about: ['Ka_sum1', 'minecraft:egg'] });
  learn({ kind: 'fact', text: '下界很热', about: ['nether'] });
  const hits = recall('Ka_sum1: 鸡蛋烤好了吗 minecraft:egg');
  check('按线索想起相关的（鸡蛋的关系、承诺）', hits.some(m => m.kind === 'relation') && hits.some(m => m.kind === 'promise'), hits.map(m => m.text));
  check('无关的不想起（下界很热）', !hits.some(m => m.text.includes('下界')));
  const hits2 = recall('今天天气不错');
  check('没做完的承诺总会想起来', hits2.some(m => m.kind === 'promise'));
  revise(hits2.find(m => m.kind === 'promise').id, { status: 'done' });
  check('做完的承诺不再想起', !recall('今天天气不错').some(m => m.kind === 'promise'));

  console.log('\n修正与遗忘');
  const bad = learn({ kind: 'lesson', text: '绿色的高东西都是苦力怕', about: ['creeper'] });
  revise(bad.id, { status: 'stale' });
  check('划掉的教训不再想起（防矫枉过正）', !recall('creeper 绿色').some(m => m.id === bad.id));
  const old = S.memories.find(m => m.text.includes('下界'));
  old.lastUsed = Date.now() - 60 * 86400000;
  const fresh = S.memories.find(m => m.text.includes('烟熏炉'));
  check('很久不用的更淡', vividness(old) < vividness(fresh));

  console.log('\n对人的看法');
  judge('Ka_sum1', { impression: '会给我好吃的，有点凶但对我很好', affinity: 10, trust: 5, fact: '喜欢煎蛋' });
  judge('Ka_sum1', { affinity: -3, fact: '喜欢煎蛋' });
  const p = person('Ka_sum1');
  check('好感累积', p.affinity === 7);
  check('同样的事实不重复记', p.facts.length === 1);
  check('渲染里有印象和事实', /会给我好吃的/.test(renderRecall([], ['Ka_sum1'])) && /喜欢煎蛋/.test(renderRecall([], ['Ka_sum1'])));
  check('不认识的人', /还不认识/.test(renderRecall([], ['Steve'])));

  console.log('\n自动的经历记忆');
  meet('Steve', { chatted: true });
  check('第一次见面自动建档', person('Steve') && person('Steve').chats === 1 && !person('Steve').impression);
  episode('Ka_sum1 给了我 鸡蛋×7', ['Ka_sum1', 'minecraft:egg']);
  episode('下雨了', []);
  episode('我把 煎蛋×7 递给了 Ka_sum1（他接到了）', ['Ka_sum1', 'farmersdelight:fried_egg']);
  const eps = recallEpisodes('Ka_sum1 你还记得我给过你什么');
  check('按人想起经历（按时间顺序）', eps.length === 2 && /鸡蛋/.test(eps[0].text), eps);
  check('无关的经历不想起', !eps.some(e => e.text === '下雨了'));
  S.episodes[0].t = Date.now() - 30 * 86400000;
  S.episodes.push({ t: Date.now(), text: 'Ka_sum1 说：今天好累', about: ['Ka_sum1'] });
  check('一个月前的经历比今天的淡（排不上就想不起）', !recallEpisodes('Ka_sum1', { limit: 2 }).some(e => /鸡蛋×7/.test(e.text)));
  check('时间说人话', /今天/.test(when(Date.now())) && /天前/.test(when(Date.now() - 5 * 86400000)));

  console.log('\n技能');
  const st = [{ tool: 'goto', args: { x: 38, z: -139 } }, { tool: 'smelt', args: { itemName: 'minecraft:egg' } }];
  const s1 = learnSkill({ name: '烤鸡蛋', steps: st, about: ['minecraft:egg', 'smoker'] });
  const s2 = learnSkill({ name: '在烟熏炉烤蛋', steps: st, about: ['farmersdelight:fried_egg'] });
  check('同样的步骤再做成 → 更熟练，不重复存', s2.reinforced && getSkill(s1.skill).successes === 2);
  check('按物品想起技能', recallSkills('帮我烤 minecraft:egg')[0]?.id === s1.skill);
  skillResult(s1.skill, false, 'smelt → 附近没有炉子');
  check('失败记下卡在哪', /没有炉子/.test(renderSkills([getSkill(s1.skill)])));

  console.log('\n家里有什么');
  setWorld('test'); setHome({ x: 0, y: 64, z: 0 });
  setHomeStorage({ '1,64,1': ['食物'] });
  noteHomeBox({ key: '1,64,1', name: 'chest', items: { 'minecraft:cooked_chicken': 23, 'minecraft:bread': 4 }, at: Date.now() - 2 * 3600000 });
  const zh = (id) => ({ 'minecraft:cooked_chicken': '熟鸡肉', 'minecraft:bread': '面包' })[id] || id;
  check('按中文名想起：鸡肉在食物箱，二十来个，两小时前看的', /熟鸡肉：二十来个，在食物箱\(1,64,1\)（2 小时前看的）/.test(renderHomeStock('鸡肉', zh)), renderHomeStock('鸡肉', zh));
  check('没有的东西', /没有/.test(renderHomeStock('钻石', zh)));
  check('单字也能想起："鸡在哪" → 熟鸡肉', homeHas('鸡在哪', zh).some(x => x.id === 'minecraft:cooked_chicken'));
  check('虚字不乱配："在哪呢" → 什么都不算', homeHas('在哪呢', zh).length === 0);
  check('总览', /食物箱\(1,64,1\)：熟鸡肉二十来个、面包几个/.test(renderHomeStock(null, zh)), renderHomeStock(null, zh));
  check('数量说成人话', [roughly(1), roughly(70), roughly(200)].join('|') === '一个|一组多|3 组多', [roughly(1), roughly(70), roughly(200)]);

  console.log('\n关键词');
  check('中文切词能对上', similar('烤鸡蛋', '鸡蛋烤好了') > 0);
  check('id 的后半段能对上', keys('minecraft:egg').has('egg'));

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}


// ------------------------------------------------------------------ 技能（会做的事）

/**
 * 做成过的一串动作。下次遇到相关的事，她会想起"我会这个"，可以直接照做（use_skill），
 * 不用每步重新想 —— Voyager 越玩越强靠的就是这个。
 * 同样的步骤再做成一次 = 更熟练；照做失败了记下卡在哪，她自己决定要不要改。
 */
function stepSig (steps) {
  return JSON.stringify((steps || []).map(s => [s.tool, s.args?.itemName || s.args?.blockName || s.args?.player || '', s.args?.x ?? '', s.args?.z ?? '']));
}

function learnSkill ({ name, steps, about = [] } = {}) {
  load();
  if (!name || !Array.isArray(steps) || !steps.length) throw new Error('技能要有名字和步骤');
  const sig = stepSig(steps);
  const same = S.skills.find(k => k.sig === sig) || S.skills.find(k => k.name === name && k.status !== 'stale');
  const now = Date.now();
  if (same) {
    same.successes++; same.lastUsed = now;
    if (same.sig !== sig) { same.steps = steps; same.sig = sig; same.revised = (same.revised || 0) + 1; }
    same.about = [...new Set([...same.about, ...about.map(String)])];
    touch();
    return { skill: same.id, reinforced: true, successes: same.successes };
  }
  const k = { id: `s${S.skills.length + 1}`, name: String(name).slice(0, 80), steps, sig, about: [...new Set(about.map(String))], successes: 1, failures: 0, created: now, lastUsed: now, status: 'active' };
  S.skills.push(k);
  touch();
  return { skill: k.id, learned: true };
}

function skillResult (id, ok, why) {
  load();
  const k = S.skills.find(x => x.id === id);
  if (!k) return null;
  if (ok) k.successes++; else { k.failures++; k.lastFail = String(why || '').slice(0, 160); }
  k.lastUsed = Date.now();
  touch();
  return k;
}

function getSkill (id) { load(); return S.skills.find(x => x.id === id) || null; }

function recallSkills (cue, { limit = 3 } = {}) {
  load();
  const cueKeys = keys(Array.isArray(cue) ? cue.join(' ') : cue);
  const out = [];
  for (const k of S.skills) {
    if (k.status === 'stale') continue;
    let overlap = 0;
    for (const a of k.about) if (cueKeys.has(String(a).toLowerCase()) || cueKeys.has(String(a).toLowerCase().split(':')[1])) overlap += 2;
    for (const w of keys(k.name)) if (cueKeys.has(w)) overlap += 1;
    if (overlap < 1) continue;
    out.push({ k, score: overlap * (k.successes + 1) / (k.failures + 1) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.k);
}

function renderSkills (ks) {
  return ks.map(k => `· ${k.id} ${k.name}（成功 ${k.successes} 次${k.failures ? `，失败 ${k.failures} 次${k.lastFail ? `，上次卡在：${k.lastFail}` : ''}` : ''}）：${k.steps.map(s => `${s.tool}${s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : ''}`).join(' → ').slice(0, 300)}`).join('\n');
}

// ------------------------------------------------------------------ 家

/**
 * 她的家：一个中心 + 半径（庇护所所在的范围），以及家里每个箱子放什么（整理过一次就记住，以后固定）。
 * 家里的箱子是自己的仓库；家以外的箱子是探险时找到的。
 */
// 每个世界（服务器 / 存档）一个家：换了新存档，在那边告诉她"这是家"就行，旧的家不会混进来
let worldKey = 'default';
function setWorld (key) { worldKey = String(key || 'default'); }

function setHome ({ x, y, z, radius = 24, name = '家' } = {}) {
  load();
  S.homes ||= {};
  const old = S.homes[worldKey];
  S.homes[worldKey] = { name, world: worldKey, center: { x: Math.round(x), y: Math.round(y), z: Math.round(z) }, radius, setAt: Date.now(), storage: (old && old.storage) || {} };
  touch();
  return S.homes[worldKey];
}

function getHome () { load(); return (S.homes || {})[worldKey] || null; }

function inHome (pos) {
  const h = getHome();
  if (!h || !pos) return false;
  return Math.hypot(pos.x - h.center.x, pos.z - h.center.z) <= h.radius && Math.abs(pos.y - h.center.y) <= 16;
}

/** 记住家里箱子的分类：{ "x,y,z": ["食物"], … }（合并，不整个覆盖） */
function setHomeStorage (layout, { replace = false, empty = null } = {}) {
  const h = getHome();
  if (!h) return null;
  if (replace) h.storage = {};
  for (const [k, cats] of Object.entries(layout)) if (cats && cats.length) h.storage[k] = cats;
  if (empty) h.emptyBoxes = empty;   // 上次整理时是空的、又没分到类的箱子（下次整理不用去看）
  touch();
  return h.storage;
}

// ------------------------------------------------------------------ 家里有什么（像人一样记个大概）

/** 看过一个家里的箱子：记下里面有什么、各有几个、什么时候看的 */
function noteHomeBox ({ key, name, items, slots, at }) {
  const h = getHome();
  if (!h) return;
  h.stock ||= {};
  h.stock[key] = { name, items, slots, at: at || Date.now() };
  touch();
}

/** 数量说成人话：人记不住精确数字 */
function roughly (n) {
  if (n <= 1) return '一个';
  if (n <= 4) return '几个';
  if (n < 10) return `${n} 个左右`;
  if (n < 20) return '十来个';
  if (n < 32) return '二十来个';
  if (n < 48) return '大半组';
  if (n < 64) return '快一组';
  if (n < 96) return '一组多';
  const g = Math.round(n / 64);
  return `${g} 组${n % 64 >= 8 ? '多' : ''}`;
}

function since (t, now = Date.now()) {
  const m = (now - t) / 60000;
  if (m < 10) return '刚看过';
  if (m < 90) return `${Math.round(m / 10) * 10} 分钟前看的`;
  if (m < 60 * 20) return `${Math.round(m / 60)} 小时前看的`;
  if (m < 60 * 24 * 3) return `${Math.round(m / 1440) || 1} 天前看的`;
  return '很久以前看的，印象里';
}

/** 家里有没有某样东西（按 id / 关键词），返回 [{id, count, box, at}] */
// 单独一个字没意义的（"铁在哪"里的 在/哪）不拿来比
const STOP_CHARS = new Set('在哪有吗的了呢吧啊呀你我他她它是个把给要去来还都也就和跟说里下上个些点么什么怎样找拿放做家箱子'.split(''));

/** 从一句话里挑出可能是东西名字的片段：中文连续字的 1–4 字子串（单字排除虚字）+ 英文词 */
function nameFragments (text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[\u4e00-\u9fff]+/g)) {
    const w = m[0];
    for (let L = Math.min(4, w.length); L >= 1; L--) {
      for (let i = 0; i + L <= w.length; i++) {
        const f = w.slice(i, i + L);
        if (L === 1 && STOP_CHARS.has(f)) continue;
        if (L > 1 && [...f].every(c => STOP_CHARS.has(c))) continue;
        out.add(f);
      }
    }
  }
  for (const m of String(text || '').toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) out.add(m[0]);
  return [...out];
}

function homeHas (query, labelOf = (x) => x) {
  const h = getHome();
  if (!h || !h.stock) return [];
  // 以前按"两个字一组"比，单独一个"铁"对不上"铁锭"—— 她想不起来，就把箱子挨个翻了一遍（实测）
  // 现在按"名字里包含这个词"比：铁 → 铁锭 / 粗铁 / 铁块
  const frags = nameFragments(query);
  const qk = keys(query);
  const out = [];
  for (const [box, b] of Object.entries(h.stock)) {
    for (const [id, n] of Object.entries(b.items || {})) {
      const name = String(labelOf(id));
      const path = id.split(':')[1] || id;
      let score = 0;
      if (qk.has(id.toLowerCase()) || qk.has(path)) score = 10;
      for (const f of frags) if (name.includes(f) || path.includes(f)) score = Math.max(score, f.length);
      if (score) out.push({ id, count: n, box, cats: (h.storage || {})[box] || [], at: b.at, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
}

/** 家里的存货：总览（每类大概有什么）或某样东西在哪、多少 */
function renderHomeStock (query = null, labelOf = (x) => x, limit = 8) {
  const h = getHome();
  if (!h || !h.stock || !Object.keys(h.stock).length) return '（还没仔细看过家里的箱子）';
  if (query) {
    const hits = homeHas(query, labelOf).slice(0, limit);
    if (!hits.length) return `印象里家里没有${query}（看过的箱子里没见到）`;
    return hits.map(x => `· ${labelOf(x.id)}：${roughly(x.count)}，在${x.cats.length ? x.cats.join('/') + '箱' : '箱子'}(${x.box})（${since(x.at)}）`).join('\n');
  }
  const lines = [];
  for (const [box, b] of Object.entries(h.stock)) {
    const top = Object.entries(b.items || {}).sort((a, c) => c[1] - a[1]);
    if (!top.length) continue;
    const cats = (h.storage || {})[box];
    lines.push(`· ${cats ? cats.join('/') + '箱' : b.name}(${box})：${top.slice(0, 5).map(([id, n]) => `${labelOf(id)}${roughly(n)}`).join('、')}${top.length > 5 ? ` 等 ${top.length} 样` : ''}（${since(b.at)}）`);
  }
  return lines.join('\n') || '（家里的箱子都是空的）';
}

function renderEpisodes (eps) {
  return eps.map(e => `· ${when(e.t)}：${e.text}`).join('\n');
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { noteHomeBox, homeHas, renderHomeStock, roughly, setWorld, setHome, getHome, inHome, setHomeStorage, learnSkill, skillResult, getSkill, recallSkills, renderSkills, load, save, touch, learn, revise, judge, sawPlayer, meet, episode, recallEpisodes, renderEpisodes, when, diary, recall, person, renderRecall, forReview, stats, keys, _reset, KINDS };
