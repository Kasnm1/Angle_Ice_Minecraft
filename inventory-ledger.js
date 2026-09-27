'use strict';

/**
 * inventory-ledger.js —— 物品账：背包里每一次进出，记下"变了什么"和"为什么变"。
 *
 * ## 为什么要有（主人 2026-09-27）
 *
 * "她应该知道自己捡了什么、放到箱子里了什么、用了什么，对自己身上的物品有良好的认知。"
 *
 * 以前 mind 每次看一眼背包，只做前后对比：「背包里多了 圆石×3」「少了 铁锭×8」。
 * 捡的、放进箱子的、吃掉的、合成用掉的、工具用坏的 —— 在她看来**全是同一句"少了"**。
 * 于是她说不出铁锭去哪了，只能猜（PERSONA 里最忌讳的就是编）。
 *
 * ## 怎么知道"为什么"：只认证据，对不上就说不知道
 *
 * 每一笔账对应一段时间（上一笔之后 → 背包安静下来），这段时间里看到过的证据：
 *
 *   route    正在执行的命令（bridge 路由在执行前后登记；长命令期间一直有效）
 *   window   开过的界面：箱子（带坐标）/ 背包 / 工作台 / 炉子
 *   instinct 本能在做什么（拾取）
 *   broke    服务端的"物品碎了"动画（entity_status 47–52：主手/副手/头/胸/腿/脚）
 *   food     这段时间饥饿值涨了 —— 自动吃（auto-eat 插件，没有命令）也认得出，模组食物也一样
 *
 * 哪条都对不上的"少了"记成 `lost`（不知道怎么没的），**不猜**。
 * 哪条都对不上的"多了"记成 `got`：没在做任何事时背包多东西，几乎只可能是走过去蹭到的掉落物，
 * 但也可能是别人扔给她的 —— 所以用"得到"而不是"捡到"。
 *
 * ## 开着界面时不记
 *
 * mineflayer 开着窗口时背包格子在窗口里更新，`bot.inventory` 要到**关窗时**才同步
 * （mineflayer/lib/plugins/inventory.js:446）。所以窗口开着的时候不结账，
 * 关上、安静下来再结 —— 一次开箱正好是一笔账："在 箱子@12,64,-3：放进 A，拿出 B"。
 *
 * 本文件是纯逻辑（可自测）。挂钩在 bridge-server.js 的 installLedger。
 */

// 命令 → 这段时间里"多了/少了"是什么意思。先匹配先得。
// gain / lose 为 null 表示这个命令不解释那一侧（交给下一条 / 默认）。
const ROUTE_RULES = [
  { re: /^POST \/(craft2?|make_torches|cook_pot)$/, gain: 'crafted', lose: 'used' },
  { re: /^POST \/smelt$/, gain: 'smelted', lose: 'furnace' },
  { re: /^POST \/eat$/, gain: null, lose: 'ate' },
  { re: /^POST \/(mine|collect|delve)$/, gain: 'mined', lose: 'placed' },   // delve 会垫脚、插火把
  { re: /^POST \/farm$/, gain: 'harvested', lose: 'planted' },
  { re: /^POST \/(pickup|storage\/loot)$/, gain: 'picked', lose: null },
  { re: /^POST \/(place|place_structure|light_up|shelter|project\/work|self_rescue|climb|climb_up|climb_down|unstick)$/, gain: null, lose: 'placed' },
  { re: /^POST \/give$/, gain: null, lose: 'gave' },
  { re: /^POST \/drop$/, gain: null, lose: 'dropped' },
  { re: /^POST \/(wear|equip|curios\/equip)$/, gain: 'took_off', lose: 'wore' },   // 换装：新的穿上、旧的回到背包
  { re: /^POST \/(unequip|curios\/unequip)$/, gain: 'took_off', lose: null },
  { re: /^POST \/use$/, gain: 'got', lose: 'used' },
  { re: /^POST \/ftbq\/submit$/, gain: null, lose: 'submitted' },
  { re: /^POST \/ftbq\/claim/, gain: 'reward', lose: null },
  { re: /^POST \/(command|cmd)$/, gain: 'received', lose: 'lost' },
  { re: /^POST \/attack$/, gain: 'got', lose: null },
  { re: /^death$/, gain: null, lose: 'died' },   // bridge 在 bot 'death' 时登记
];

// 界面种类 → 多了/少了的意思。container / backpack 带 where（放进哪 / 从哪拿）。
const WINDOW_RULES = {
  container: { gain: 'took', lose: 'stored' },
  backpack: { gain: 'took', lose: 'stored' },
  crafting: { gain: 'crafted', lose: 'used' },
  furnace: { gain: 'smelted', lose: 'furnace' },
};

// 说出来的样子（mind 那边渲染；名字由调用方给 label 函数翻成中文）
const VERB_TEXT = {
  picked: '捡到', got: '得到', mined: '挖到', harvested: '收获', crafted: '做出', smelted: '烧出',
  took: '拿出', took_off: '脱下/换下', reward: '任务奖励', received: '指令给了',
  stored: '放进', used: '合成用掉', furnace: '放进炉子', ate: '吃掉', placed: '放下/用掉', planted: '种下',
  gave: '给了人', dropped: '丢掉', died: '死的时候掉了', wore: '穿上', submitted: '交任务交掉', broke: '用坏了', lost: '不知道怎么没的',
};

const GAIN_DEFAULT = 'got';
const LOSE_DEFAULT = 'lost';

// ------------------------------------------------------------------ 纯函数

/** [{name,count}] → Map name→count */
function fingerprint (items) {
  const m = new Map();
  for (const i of items || []) if (i && i.name) m.set(i.name, (m.get(i.name) || 0) + (i.count || 1));
  return m;
}

function diff (before, after) {
  const gained = {}; const lost = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(k) || 0) - (before.get(k) || 0);
    if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d;
  }
  return { gained, lost };
}

/**
 * 给一段时间的变化找原因。
 * @param change  { gained:{name:n}, lost:{name:n} }
 * @param ev      { routes:[key], windows:[{kind, where?}], instinct:[kind], broke:[name], fedUp:boolean }
 * @returns parts: [{ sign:'+'|'-', verb, items:{name:n}, where? }]
 */
function classify (change, ev = {}) {
  const routes = ev.routes || [];
  const windows = ev.windows || [];
  const broke = [...(ev.broke || [])];
  const parts = [];
  const add = (sign, verb, name, n, where) => {
    let p = parts.find(x => x.sign === sign && x.verb === verb && x.where === where);
    if (!p) { p = { sign, verb, items: {}, ...(where ? { where } : {}) }; parts.push(p); }
    p.items[name] = (p.items[name] || 0) + n;
  };
  // 界面优先：开着箱子时的进出就是存取，不管是哪个命令触发的。取最后开的那个（一次整理可能开好几个，按顺序记最后一个）
  const win = windows.length ? windows[windows.length - 1] : null;
  const wRule = win ? WINDOW_RULES[win.kind] : null;
  const pick = (side) => {
    if (wRule && wRule[side]) return { verb: wRule[side], where: win.where };
    for (const k of routes) {
      const r = ROUTE_RULES.find(x => x.re.test(k));
      if (r && r[side]) return { verb: r[side] };
    }
    if (side === 'gain' && (ev.instinct || []).includes('pickup')) return { verb: 'picked' };
    return null;
  };

  const g = pick('gain') || { verb: GAIN_DEFAULT };
  for (const [name, n] of Object.entries(change.gained || {})) add('+', g.verb, name, n, g.where);

  const l = pick('lose');
  for (const [name, n0] of Object.entries(change.lost || {})) {
    let n = n0;
    // 碎了的那一件单独记（它是真的没了，不是放进箱子）
    const bi = broke.indexOf(name);
    if (bi >= 0) { broke.splice(bi, 1); add('-', 'broke', name, 1); n -= 1; if (!n) continue; }
    if (l) add('-', l.verb, name, n, l.where);
    else if (ev.fedUp) add('-', 'ate', name, n);   // 没有命令、饥饿值涨了 —— 自动吃的
    else add('-', LOSE_DEFAULT, name, n);
  }
  return parts;
}

/** 一笔账 → 一句话。label：物品 id → 中文名（mind 用 knowledge.label）。 */
function render (entry, label = (x) => x) {
  return (entry.parts || []).map(p => {
    const items = Object.entries(p.items).map(([k, n]) => `${label(k)}×${n}`).join('、');
    const v = VERB_TEXT[p.verb] || p.verb;
    if (p.where && (p.verb === 'stored')) return `${v} ${p.where}：${items}`;
    if (p.where && (p.verb === 'took')) return `从 ${p.where} ${v}：${items}`;
    return `${v}：${items}`;
  }).join('；');
}

/**
 * 账本状态机。bridge 负责：什么时候结账（背包安静、没开窗），证据什么时候登记。
 *
 *   begin(ev) → end()   长证据（命令、本能动作）：生效期间每一笔账都算上它
 *   note(ev)            短证据（开过窗、碎了）：算进下一笔账
 *   commit(items, { food, now })  结账：和上一笔比，有变化就出一笔，返回它（没变化返回 null）
 *   record(parts)       直接记一笔（盔甲碎了：盔甲不在 items() 里，比对看不到）
 */
function createLedger ({ max = 200, graceMs = 3000 } = {}) {
  let base = null;
  let baseFood = null;
  let seq = 0;
  const entries = [];
  let pending = { routes: [], windows: [], instinct: [], broke: [] };
  const active = new Map();   // token → ev
  let ended = [];             // [{ ev, at }] 上一笔之后结束的长证据
  let tok = 0;

  const merge = (into, ev) => {
    if (ev.route) into.routes.push(ev.route);
    if (ev.window) into.windows.push(ev.window);
    if (ev.instinct) into.instinct.push(ev.instinct);
    if (ev.broke) into.broke.push(ev.broke);
  };
  const push = (e) => { entries.push(e); if (entries.length > max) entries.shift(); return e; };

  return {
    // 长证据只算进它**生效期间**（加结束后 graceMs 的尾巴）结的账：
    //   · 进行中的在 active 里，结账时现取；
    //   · 结束了的进 ended，带结束时间 —— 挖矿最后几块的掉落物有拾取延迟，命令返回后才进背包，那还是"挖到"；
    //     但过了 graceMs 才变的，就和它没关系了（闲着捡到的不能记成"挖到"）。
    begin (ev) {
      const t = ++tok; active.set(t, ev);
      return (at = Date.now()) => { if (active.delete(t)) ended.push({ ev, at }); };
    },
    note (ev) { merge(pending, ev); },
    commit (items, { food = null, now = Date.now() } = {}) {
      const fp = fingerprint(items);
      if (!base) { base = fp; baseFood = food; return null; }
      const change = diff(base, fp);
      const fedUp = food != null && baseFood != null && food > baseFood;
      base = fp; baseFood = food;
      const ev = pending;
      for (const a of active.values()) merge(ev, a);
      for (const x of ended) if (now - x.at <= graceMs) merge(ev, x.ev);
      pending = { routes: [], windows: [], instinct: [], broke: [] };
      ended = [];
      if (!Object.keys(change.gained).length && !Object.keys(change.lost).length) return null;
      return push({ seq: ++seq, t: now, parts: classify(change, { ...ev, fedUp }) });
    },
    record (parts, now = Date.now()) { return push({ seq: ++seq, t: now, parts }); },
    /** 换了一条连接：下线期间的变化说不清，从新连接的背包重新起算 */
    rebase () { base = null; baseFood = null; pending = { routes: [], windows: [], instinct: [], broke: [] }; ended = []; },
    since (s = 0) { return { seq, entries: entries.filter(e => e.seq > s) }; },
    get seq () { return seq; },
  };
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  const inv = (o) => Object.entries(o).map(([name, count]) => ({ name, count }));
  const say = (e) => (e ? render(e) : null);

  const L = createLedger();
  check('第一次只定起点，不出账', L.commit(inv({ cobblestone: 3 })), null);
  check('没变化 → 不出账', L.commit(inv({ cobblestone: 3 })), null);

  // 本能捡东西
  let end = L.begin({ instinct: 'pickup' });
  check('★ 本能拾取期间多了 → 捡到', say(L.commit(inv({ cobblestone: 3, oak_log: 2 }))), '捡到：oak_log×2');
  end();
  const later = () => ({ now: Date.now() + 10000 });   // 过了宽限期
  check('什么都没在做时多了 → 得到（不冒认"捡"）', say(L.commit(inv({ cobblestone: 3, oak_log: 2, apple: 1 }), later())), '得到：apple×1');

  // 开箱子存东西
  L.note({ window: { kind: 'container', where: '箱子@12,64,-3' } });
  check('★ 开着箱子少了 → 放进哪个箱子', say(L.commit(inv({ apple: 1 }))), '放进 箱子@12,64,-3：cobblestone×3、oak_log×2');
  L.note({ window: { kind: 'container', where: '箱子@12,64,-3' } });
  check('一次开箱又拿又放 → 一笔账两句', say(L.commit(inv({ iron_ingot: 8 }))), '从 箱子@12,64,-3 拿出：iron_ingot×8；放进 箱子@12,64,-3：apple×1');

  // 合成（命令）
  end = L.begin({ route: 'POST /craft2' });
  check('★ 合成：用掉什么、做出什么', say(L.commit(inv({ iron_ingot: 5, bucket: 1 }))), '做出：bucket×1；合成用掉：iron_ingot×3');
  end();

  // 工具碎了
  L.commit(inv({ iron_ingot: 5, iron_pickaxe: 1 }));
  end = L.begin({ route: 'POST /mine' });
  L.note({ broke: 'iron_pickaxe' });
  check('★ 挖矿时镐碎了 → 用坏了（不是"放下"）', say(L.commit(inv({ iron_ingot: 5, raw_iron: 4 }))), '挖到：raw_iron×4；用坏了：iron_pickaxe×1');
  end();

  // 自动吃（没有命令，饥饿值涨了）
  L.commit(inv({ bread: 3 }), { food: 10 });
  check('★ 没命令、饥饿值涨了、少了面包 → 吃掉', say(L.commit(inv({ bread: 2 }), { food: 15 })), '吃掉：bread×1');
  check('★ 没命令、没吃、少了东西 → 如实说不知道', say(L.commit(inv({ bread: 1 }), { food: 15 })), '不知道怎么没的：bread×1');

  // 长命令跨好几笔账：每笔都算它的
  end = L.begin({ route: 'POST /mine' });
  L.commit(inv({ bread: 1, cobblestone: 5 }));
  check('长命令期间第二笔账仍然是"挖到"', say(L.commit(inv({ bread: 1, cobblestone: 9 }))), '挖到：cobblestone×4');
  end();
  check('命令结束过了宽限期 → 不再算它的', say(L.commit(inv({ bread: 1, cobblestone: 10 }), later())), '得到：cobblestone×1');
  end = L.begin({ route: 'POST /mine' });
  end();
  check('★ 命令刚结束、掉落物晚到（宽限期内）→ 还是"挖到"', say(L.commit(inv({ bread: 1, cobblestone: 12 }))), '挖到：cobblestone×2');

  // 界面优先于命令：mind 的 store_items 走的是 /container/deposit，但开着箱子
  end = L.begin({ route: 'POST /container/deposit' });
  L.note({ window: { kind: 'backpack', where: '背包' } });
  check('装进背包', say(L.commit(inv({ bread: 1 }))), '放进 背包：cobblestone×12');
  end();

  // 给人
  L.commit(inv({ diamond: 2 }));
  end = L.begin({ route: 'POST /give' });
  check('给了人', say(L.commit(inv({ diamond: 1 }))), '给了人：diamond×1');
  end();

  // 死了
  L.commit(inv({ diamond: 1, bread: 1 }));
  L.note({ route: 'death' });
  check('死亡掉落', say(L.commit(inv({}))), '死的时候掉了：diamond×1、bread×1');
  L.rebase();
  check('换连接后重新起算（不出账）', L.commit(inv({ stone: 64 })), null);

  // 记录与查询
  const armor = L.record([{ sign: '-', verb: 'broke', items: { iron_boots: 1 } }]);
  check('直接记一笔（盔甲碎了）', say(armor), '用坏了：iron_boots×1');
  check('since 只给新的', L.since(armor.seq - 1).entries.length, 1);
  check('seq 递增', L.since(0).seq, armor.seq);

  check('每个动词都说得出来', [...ROUTE_RULES.flatMap(r => [r.gain, r.lose]), ...Object.values(WINDOW_RULES).flatMap(r => [r.gain, r.lose]), GAIN_DEFAULT, LOSE_DEFAULT, 'broke', 'ate', 'picked']
    .filter(Boolean).every(v => VERB_TEXT[v]), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { ROUTE_RULES, WINDOW_RULES, VERB_TEXT, fingerprint, diff, classify, render, createLedger, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
