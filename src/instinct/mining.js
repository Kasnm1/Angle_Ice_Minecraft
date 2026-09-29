'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「mining」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const paths = require('../paths');
const __ns = {};
let TIER, CFG;   // 跨文件常量：load 完成后由 bind() 回填
function hdist (...a) { return __ns.hdist.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); TIER = ns.TIER; CFG = ns.CFG; }

function pickaxeTier (itemNames = []) {
  let best = -1;
  for (const n of itemNames) {
    const bare = String(n).replace(/^.*:/, '');
    if (!/pickaxe/.test(bare)) continue;
    const m = /^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/.exec(bare);
    const t = m ? { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }[m[1]]
      : /netherite/.test(bare) ? 4 : /diamond/.test(bare) ? 3 : /iron|steel/.test(bare) ? 2 : 1;
    if (t > best) best = t;
  }
  return best;   // -1 = 没有镐子
}

const needTier = (tier) => (tier && TIER[tier] != null ? TIER[tier] : TIER.iron);

/**
 * 身上的 + 精妙背包里的物品名清单（主人 2026-09-28，codex 审计 P-4 / N-9）。
 *
 * 以前 `pickaxeTier(bot.inventory.items()…)` 只看普通物品栏 —— 镐子放在精妙背包（108 格）里时
 * 判"镐子不够"，看见矿也不挖。这里把 `state.backpackSeen` 里的也并进来。
 *
 * ⚠️ 只是**算上背包里的**，不真的把镐子拿出来 —— 判据用；真要取工具是 hands 的活。
 * 读不到背包时（没背 / 从没打开过）返回 `readable:false`，调用方要按原逻辑算，并且**不能说"没有"**。
 *
 * @returns {{ names:string[], source:'carried'|'carried+backpack', readable:boolean }}
 */
// instinct 里的裸名（去 minecraft: 前缀）—— 和 loadTables 的 bareName 同一规则
// 第 4 步去重：原为本文件本地定义，与 instinct/core.js:676 的 `bareName` 逐字重复 ——
// 唯一一份在 src/util/ids.js（`String(n)` 版）。保留本地名 `bareNameOf` 不动调用点。
const { bareMinecraft: bareNameOf } = require('../util/ids');

/**
 * 挖哪条矿。
 * @param ctx.ores   [{ name, pos, value, tier, drops?, visible, hazard }]  hazard = 旁边有岩浆/水
 * @param ctx.self   她的位置；ctx.pick = pickaxeTier()；ctx.have = 物品名 → 数量（判断 low 矿缺不缺）
 * @param ctx.fails  Map "x,y,z" → until
 * @param ctx.followIdle  跟着的玩家**原地不动**（>8s）时给她当前位置；null = 不在跟随模式
 *                        这时用的是 cfg.followRadius（跟着人时别跑太远，跟丢了她会追不上）
 * @returns { target, count } | { skip, lacking? }   lacking = [{ name, pos, need }] 看得见但镐子不够的（告诉 mind）
 */
function pickOre (ctx, cfg = CFG.mine) {
  const { ores = [], self, pick = -1, have = {}, fails = new Map(), now = Date.now(), followIdle = null } = ctx;
  const early = pick < TIER.iron;   // 还没有铁镐：前期，铁和煤就是最值钱的
  if (!self) return { skip: '没有位置' };
  const radius = followIdle ? Math.min(cfg.radius, cfg.followRadius ?? cfg.radius) : cfg.radius;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const lacking = [];
  const why = { far: 0, hidden: 0, hazard: 0, failed: 0, cheap: 0, tool: 0, shovel: 0, follow: 0 };
  const ok = [];
  for (const o of ores) {
    if (!o?.pos) continue;
    if (hdist(o.pos, self) > radius || Math.abs(o.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!o.visible) { why.hidden++; continue; }
    if (o.hazard) { why.hazard++; continue; }
    if (o.notPickaxe) { why.shovel++; continue; }   // 不是镐子挖的（化石矿要铲子）—— 矿表里标出来的
    const f = fails.get(key(o.pos));
    if (f && now < f) { why.failed++; continue; }
    // 跟着人时：矿不能离**他**太远（不然挖完她在远处，人走了就丢）
    if (followIdle && hdist(o.pos, followIdle.pos) > (cfg.followLeash ?? 16)) { why.follow++; continue; }
    const isIron = (o.drops || []).some(d => /(^|:)(raw_iron|iron_ingot|iron_nugget)$/.test(d));
    if (o.value === 'low') {
      const got = (o.drops || []).reduce((n, d) => n + (have[d] || 0), 0);
      if (got >= (early ? cfg.lowWhenBelow * 2 : cfg.lowWhenBelow)) { why.cheap++; continue; }
    }
    const need = needTier(o.tier);
    if (pick < need) { why.tool++; lacking.push({ name: o.name, pos: o.pos, need }); continue; }
    // 价值排序（第 3 条：按 knowledge/ores.json 的 value 排，没价值/很低价值的排最后）：
    //   0 = high（钻石、铁…，以及前期最缺的铁）
    //   1 = mid（铜、金、油矿…）
    //   2 = low（煤、青金石…，够用就不挖，上面已经筛过一遍）
    //   3 = 没有 value 字段 / value 不认识 —— **排最后但不永久排除**（可能是新模组矿、矿表还没补；
    //       排最后意味着"附近只有它时才挖"，不会为了它放弃铁矿，也不会因为表里没记就彻底看不见）
    const v = o.value === 'high' ? 0 : o.value === 'mid' ? 1 : o.value === 'low' ? 2 : 3;
    const rank = (early && isIron && v > 0) ? 0 : v;   // 前期：铁优先于一切（含钻石那档，因为挖不动）
    ok.push({ ...o, dist: hdist(o.pos, self), rank, unknownValue: v === 3 });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: parts.length ? `有矿但不挖（${parts.join(' ')}）` : '看不见矿', lacking };
  }
  ok.sort((a, b) => (a.rank - b.rank) || (a.dist - b.dist));
  const t = ok[0];
  const count = Math.min(cfg.maxVein, ok.filter(o => o.name === t.name).length);
  return { target: { name: t.name, pos: t.pos }, count, lacking };
}

/**
 * 洞里下一步去哪。cells：候选的落脚点 [{ pos, visible, lavaNear, dark }]（已经是"脚和头是空的、脚下实心"的格子）。
 * 只去看得见的、没去过的、旁边没岩浆的、不太低的、不出入口 range 的；先挑暗的（没点亮 = 没人来过），再挑远一点的。
 */
function pickCaveStep ({ cells = [], self, entry = null, visited = new Set() }, cfg = CFG.cave) {
  if (!self) return null;
  const cell = (p) => `${Math.floor(p.x / cfg.visitCell)},${Math.floor(p.y / cfg.visitCell)},${Math.floor(p.z / cfg.visitCell)}`;
  const ok = cells.filter(c => c.visible && !c.lavaNear
    && !visited.has(cell(c.pos))
    && self.y - c.pos.y <= cfg.maxDrop
    && Math.hypot(c.pos.x - self.x, c.pos.z - self.z) >= cfg.minStep
    && (!entry || Math.hypot(c.pos.x - entry.x, c.pos.y - entry.y, c.pos.z - entry.z) <= cfg.range));
  if (!ok.length) return null;
  ok.sort((a, b) => ((b.dark ? 1 : 0) - (a.dark ? 1 : 0))
    || (Math.hypot(b.pos.x - self.x, b.pos.z - self.z) - Math.hypot(a.pos.x - self.x, a.pos.z - self.z)));
  return { ...ok[0], cell: cell(ok[0].pos) };
}

// ---------------------------------------------------------------- 火把开关（主人 2026-09-29）
//
// 主人原话："插火把这个本能，作为一个开关吧，它可以询问玩家现在是否需要插火把，
// 以及下矿，探险的时候自动插。"
//
// 一个开关 `torchMode`，按"她在哪 / 在干嘛"分三种场合（判据**只此一处**，就是下面这两个函数：
// `instinct/core.js` 的 `tryTorch` / `dark_spot` 和 bridge 的 `POST /torch_mode` / `GET /instinct`
// 都从这里取，不各写一份）：
//
//   | 场合 | 默认 | 说明 |
//   |---|---|---|
//   | **下矿 / 探洞 / 在地下**（在洞里的判据与 pickTorchStep 的 ① 同款） | `auto` | 不问，保命优先 |
//   | **野外探险**（不在家范围、露天） | `auto` | 不问（暗处会刷怪） |
//   | **家里** | `ask` | 不自动插；发现暗处时经 mind **问主人一次** |
//
// 开关取值（两处独立）：`home`：`'ask'`(默认) | `'auto'` | `'off'`；`away`：`'auto'`(默认) | `'off'`。
//
// **下矿时 `away:'off'` 也照插**（主人 2026-09-29 拍板："下礦時仍插？—— 你定，写理由；
// 建议下矿永远插，保命"）。理由：洞里的黑是**当场**的危险（怪贴脸、找不到路、摔进坑），
// `away` 关的是"野外顺手点灯"这种可省的事，不是"在洞里的安全线"。真要一支都不插，
// 把整个火把本能关掉（`MC_INSTINCT_TORCH=false`）。

/** 开关的合法取值与默认值 —— 校验、补默认、`set_torch_mode` 的 enum 共用这一份 */
const TORCH_MODES = {
  home: { values: ['ask', 'auto', 'off'], def: 'ask' },
  away: { values: ['auto', 'off'], def: 'auto' },
};

/** 冷却（ms）—— 任务书定的两个数，理由见 memory/AGENTS.md 的「火把开关」一节 */
const TORCH_COOLDOWN = {
  // 主人说"不用" → 至少 24 小时（真实时间）不再问、也不再为家里的暗处催她。
  // 理由（任务书）：他白天说了不用，晚上回来又问一次 = 没记住他的话。
  offMs: 24 * 60 * 60 * 1000,
  // 上一句他没回 → 6 小时内不再提。理由：和"少问"的规矩一致（没回答不是"不问"，
  // 但绝不追着问）。6 小时 = 一次游戏时段内只提一次。
  noAnswerMs: 6 * 60 * 60 * 1000,
};

/**
 * 场合判定（纯函数）。**判据只此一处。**
 *
 * 「在家里」用调用方传进来的 `atHome`（`instinct/core.js` 的 `inHome()`，
 * 和 `body/util.js` 的 `inHomeArea` 同一套范围：水平 ≤ radius 且 |Δy| ≤ 16）。
 *
 * ⚠️ 顺序：**先判下矿 / 地下（①），再判家（②），最后才是家外（③）**。
 *   自家地下（自己挖的矿道）算「下矿」不算「家里」—— 主人那句"下矿、探险的时候自动插"
 *   说的是**在洞里**这件事，不是"这片地在家的范围内"。反过来先判家的话，`home=ask` 会让
 *   她在自家矿道里停下来问一句才敢点灯（保命的事不该等回答）。
 *
 * ⚠️ `atHome` 读不到（`null`，家还没同步给本能层 / 刚上线）**按"不在家"算** ——
 *   家里那条要开一次口（问主人），证据不足时保守为不问（AGENTS.md §5-5），
 *   宁可顺手插一支（点灯是安全方向），也不平白开一次口。
 *
 * @param {object} c
 * @param {object} c.exposure  `exposureOf(bot)` 的结果（读不到给 null）
 * @param {boolean|null} c.atHome  在不在家范围里（null = 不知道家在哪）
 * @param {boolean} c.delving  最近一次下矿还在进行 / 刚结束不久（`I.delve` 有效）
 * @returns {{where:'mine'|'home'|'away', mode:'auto'|'ask'|'off', ask:boolean, why:string}}
 */
function torchSituation (c = {}) {
  const { exposure = null, atHome = null, delving = false } = c;
  const modes = c.modes || TORCH_MODES;
  const kind = exposure?.kind;
  // ① 在地 下 / 洞里（判据与 pickTorchStep 的 ① 一字不差：underground，或 sheltered 且头顶有顶）
  const under = kind === 'underground' || (kind === 'sheltered' && exposure?.roofAt != null);
  if (delving) {
    // `I.delve` 只在"mind 明确下过矿、且这次还在 5 分钟内"时才有效（见 pickDelveResume）——
    // 它是"主人让我下矿"的直接证据，哪怕此刻她已经走到地面上（洞口）也算下矿中。
    return { where: 'mine', mode: 'auto', ask: false, why: '正在下矿（保命优先，不问）' };
  }
  // ② 家里 —— **排在"在地下 / 有顶"之前**（2026-09-29 Claude 复核改）：屋里本来就有屋顶（sheltered + roofAt），
  //    原来的顺序会把"家里室内 / 地下室"全当成洞里、自动插，主人要的"家里先问"就落空了。
  //    只有明确在下矿（上面的 delving）、或真的在地下（自家矿道，exposure=underground）才在家范围里也自动插；
  //    "有顶但在地面上"（sheltered，屋里）照家里的开关。
  if (atHome === true && kind === 'underground') return { where: 'mine', mode: 'auto', ask: false, why: '家里的地下（自家矿道）：保命优先，不问' };
  if (atHome === true) {
    const mode = normTorchMode('home', modes.home ?? TORCH_MODES.home.def);
    return { where: 'home', mode, ask: mode === 'ask', why: mode === 'ask' ? '在家里：先问主人一次' : `在家里（home=${mode}）` };
  }
  // ③ 家外的地下 / 洞里：保命优先，不问
  if (under) return { where: 'mine', mode: 'auto', ask: false, why: '在地下 / 洞里（保命优先，不问）' };
  // ④ 家外
  const mode = normTorchMode('away', modes.away ?? TORCH_MODES.away.def);
  return { where: 'away', mode, ask: false, why: atHome === null ? `不知道家在哪，按家外算（away=${mode}）` : `在家外（away=${mode}）` };
}

// ------------------------------------------------------------------ 开关的存盘（`memory/torch-mode.json`）
//
// ⚠️ **谁读谁写**：bridge 进程（本能在里面）是**唯一**的写者；mind 只经 HTTP
// （`POST /torch_mode` / `GET /instinct`）读写，**不自己碰这个文件** —— 两个进程各写一份
// 必然互相覆盖（和 `memory/mind.json` 只由 mind 进程整份重写同一个道理）。
//
// 位置：`src/paths.js` 的 `MEMORY`（数据目录的唯一来源，别自己 path.join(__dirname, ...)）。
// `$MC_TORCH_MODE_FILE` 可以改（自测一律指到临时文件，**绝不写真的 memory/torch-mode.json**）。
const TORCH_MODE_FILE = process.env.MC_TORCH_MODE_FILE || require('path').join(paths.MEMORY, 'torch-mode.json');

/**
 * 读开关。**读不到和"没设置"必须分开报**（AGENTS.md §5-1）：
 * 文件不存在 = 从没设置过（用默认值，正常）；文件在但读不出来 / 是坏 JSON =
 * `unreadable:true` —— 这时也用默认值，但调用方（`GET /instinct`）要能把它说出来。
 * @returns {{state:object, unreadable:boolean, why:?string}}
 */
function loadTorchMode (file = TORCH_MODE_FILE) {
  const fs = require('fs');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { state: normTorchState(null), unreadable: false, why: null };
    return { state: normTorchState(null), unreadable: true, why: String(e && e.message || e).slice(0, 120) };
  }
  try { return { state: normTorchState(JSON.parse(raw)), unreadable: false, why: null }; } catch (e) {
    return { state: normTorchState(null), unreadable: true, why: `torch-mode.json 不是合法 JSON：${String(e && e.message || e).slice(0, 100)}` };
  }
}

/**
 * 写开关（原子写：`.tmp` + `renameSync`，和 memory 里别的文件同一个做法）。
 * 返回写成功的状态；写失败**照实报**（不静默吞）—— 调用方要能回"没存上"。
 */
function saveTorchMode (state, file = TORCH_MODE_FILE) {
  const fs = require('fs');
  const s = normTorchState(state);
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, file);
    return { ok: true, state: s };
  } catch (e) {
    return { ok: false, state: s, error: String(e && e.message || e).slice(0, 160) };
  }
}

/**
 * 改开关（只给要改的键；`null` / `undefined` 表示"这个键不动"）。
 * `home` / `away` 只认白名单值，写错的值**不回退成默认**、而是拒绝（`bad` 里报出来）——
 * 主人说"家里别插了"要是被写成 `away`，他会以为没生效。
 *
 * @returns {{ok:boolean, state:object, changed:object, bad:Array, error:?string}}
 */
function applyTorchMode (state, patch = {}, file = TORCH_MODE_FILE) {
  const s = normTorchState(state);
  const bad = [];
  const changed = {};
  for (const k of ['home', 'away']) {
    if (patch[k] == null) continue;
    if (!torchModeOk(k, patch[k])) { bad.push({ key: k, value: String(patch[k]), allowed: TORCH_MODES[k].values }); continue; }
    if (String(patch[k]) !== s[k]) { changed[k] = String(patch[k]); s[k] = String(patch[k]); }
  }
  if (bad.length) return { ok: false, state: s, changed, bad, error: `开关值不合法：${bad.map(b => `${b.key}=${b.value}（只能是 ${b.allowed.join(' / ')}）`).join('；')}` };
  const w = saveTorchMode(s, file);
  return { ok: w.ok, state: s, changed, bad: [], error: w.error || null };
}

/**
 * 记下"这一轮问过主人了"（在他回答之前）。**问的时刻要落盘** ——
 * 没回答的 6 小时冷却按它算，进程重启也不能丢（不然一重启就又问一遍）。
 */
function markTorchAsked (state, now = Date.now(), file = TORCH_MODE_FILE) {
  const s = normTorchState(state);
  s.askedAt = now;
  s.answer = null;          // 新的一问：上一次的回答作废（"不用"的 24 小时另有 quietUntil 管着，不会丢）
  s.answeredAt = null;
  const w = saveTorchMode(s, file);
  return { ok: w.ok, state: s, error: w.error || null };
}

/**
 * 记下主人的回答。`yes` → 这次去插（可以同时把 `home` 改成 `auto`，如果他这么说了）；
 * `no` → 写 `quietUntil = 现在 + 24 小时`，期间不再问、`dark_spot` 也不再催。
 */
function noteTorchAnswer (state, answer, { now = Date.now(), alsoAuto = false, home = null } = {}, file = TORCH_MODE_FILE) {
  const s = normTorchState(state);
  const a = answer === 'yes' || answer === 'no' ? answer : null;
  if (!a) return { ok: false, state: s, error: `回答只能是 yes / no（收到 ${JSON.stringify(answer)}）` };
  s.answer = a;
  s.answeredAt = now;
  s.askedAt = s.askedAt || now;
  s.quietUntil = a === 'no' ? now + TORCH_COOLDOWN.offMs : null;
  // 他说"以后都自动插" → 顺手把 home 设成 auto（同一个回答里能带两件事）
  if (alsoAuto && a === 'yes') s.home = 'auto';
  if (home != null && torchModeOk('home', home)) s.home = String(home);
  const w = saveTorchMode(s, file);
  return { ok: w.ok, state: s, error: w.error || null };
}
function torchModeOk (key, value) {
  const spec = TORCH_MODES[key];
  return !!spec && spec.values.includes(String(value));
}

/** 归一：非法 / 缺省 → 该键的默认值。**只认白名单**，不猜（写错的值不会静默变成"自动插"） */
function normTorchMode (key, value) {
  return torchModeOk(key, value) ? String(value) : TORCH_MODES[key].def;
}

/** 存盘形状（`memory/torch-mode.json`）—— 读回来的东西一律先过这一道，脏数据不采信 */
function normTorchState (raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = {
    home: normTorchMode('home', r.home),
    away: normTorchMode('away', r.away),
    // 最近一次对主人的邀请（不管他答没答，都要留着 —— 冷却按它算）
    askedAt: Number.isFinite(+r.askedAt) && +r.askedAt > 0 ? +r.askedAt : null,
    // 他上一次的回答：'yes'（要插）/ 'no'（不用）/ null（还没回答过）
    answer: r.answer === 'yes' || r.answer === 'no' ? r.answer : null,
    answeredAt: Number.isFinite(+r.answeredAt) && +r.answeredAt > 0 ? +r.answeredAt : null,
  };
  // 他说"不用"的那次起算 24 小时（`no_until`）；上面的 answeredAt 是他什么时候说的，两回事：
  // 冷却是**从那次回答起算**的，不是从"上次问"起算（问完他没回、第二天才说不算）。
  s.quietUntil = Number.isFinite(+r.quietUntil) && +r.quietUntil > 0 ? +r.quietUntil : null;
  // 兼容人工/旧版本写进来的 ISO 字符串（README 里给人看的是可读时间）
  if (r.quietUntil && !Number.isFinite(+r.quietUntil)) { const t = Date.parse(String(r.quietUntil)); s.quietUntil = Number.isFinite(t) ? t : null; }
  if (r.askedAt && !Number.isFinite(+r.askedAt)) { const t = Date.parse(String(r.askedAt)); s.askedAt = Number.isFinite(t) ? t : null; }
  return s;
}

/**
 * 家里发现暗处之后：**要不要经 mind 问主人一次**（纯函数）。
 *
 * 三种"不问"：
 *   · 开关不是 `ask`（`off` 就是明说别插，`auto` 本能自己插上了，都不用开口）；
 *   · 主人说过"不用"、24 小时还没到（`quietUntil`）—— 期间 `dark_spot` 也别再催她去插；
 *   · 上一句他没回、6 小时还没到（`askedAt + noAnswerMs`）—— 不追问（和"少问"一致）。
 *
 * `answer === 'yes'` 单独一条：他说了要插，**"没回答"的 6 小时冷却不该套在他头上**
 * （他明明答了）。这时她去插；暗处还在就是没插成，可以再说一次，走的是"上次没插成"那条路。
 * 但**他也没再被问第二遍** —— 去插是本能/她的事，不是又一次开口。
 *
 * @param {object} c
 * @param {'ask'|'auto'|'off'} c.mode   场合判定的结果（家里那格的 mode）
 * @param {object} [c.state]           `normTorchState()` 的形状
 * @param {number} [c.now]
 * @param {object} [c.cooldown]        `TORCH_COOLDOWN`
 * @param {number} [c.darkCount]       这一轮数出多少格暗（0 = 没暗处，不发）
 * @returns {{ask:boolean, why:string, leftMs:number}}
 */
function pickTorchAsk (c = {}) {
  const { mode = 'ask', state = null, now = Date.now(), cooldown = TORCH_COOLDOWN, darkCount = 1 } = c;
  if (!(darkCount > 0)) return { ask: false, why: '家里没有暗处', leftMs: 0 };
  if (mode !== 'ask') return { ask: false, why: mode === 'off' ? '开关关着（home=off），不问也不插' : '开关是 home=auto：本能自己插，不用问', leftMs: 0 };
  const s = normTorchState(state);
  // 冷却一律用 `<=`（"刚好到点"不算过）—— 边界上宁可少问一次，也不追着问。
  if (s.quietUntil && now <= s.quietUntil) {
    return { ask: false, why: `主人说过不用，还有 ${Math.round((s.quietUntil - now) / 60000)} 分钟才到 24 小时`, leftMs: s.quietUntil - now };
  }
  if (s.answer === 'no' && s.quietUntil == null) {
    // 老数据：只说"不用"没写 quietUntil（人工改过 / 更早的版本）—— 按"回答时刻 + 24 小时"补算
    const until = (s.answeredAt || s.askedAt || 0) + cooldown.offMs;
    if (until && now <= until) return { ask: false, why: '主人说过不用（还没到 24 小时）', leftMs: until - now };
  }
  // 他说了"要插" —— 不按"他没回答"算（他答了），也还没有说"不用"，可以直接去插。
  if (s.answer === 'yes') return { ask: true, why: '主人说要插的（去插；没插成还可以说一声）', leftMs: 0 };
  if (s.askedAt && now - s.askedAt <= cooldown.noAnswerMs) {
    return { ask: false, why: `上次问过他还没回（${Math.round((now - s.askedAt) / 60000)} 分钟前），别追问`, leftMs: cooldown.noAnswerMs - (now - s.askedAt) };
  }
  return { ask: true, why: '家里有暗处、开关是 home=ask、这一轮还没问过', leftMs: 0 };
}

/**
 * 该不该在这儿插个火把（2026-09-28 第 8 批 第 4 条，纯函数）。
 *
 * 主人："插火把很慢。" 实机：`light_up() ✗ 正在执行紧急本能：combat` ——
 * 火把只有 mind 想起来调 `light_up`、或 `delve` 每 8 格插一根时才插；
 * 本能层根本没有"暗了就点灯"这一条。这条顶上。
 *
 * 判据（全部满足才插）：
 *   ① 场合是"自己插"：`torchSituation()` 判出来的 `mode` 按下去是 `auto`
 *      （下矿 / 地下永远 auto；家在 `home=ask`/`home=off` 时不自作主张；家外看 `away`）
 *      —— 露天的黑（夜里）不算，那是该回家睡觉的事，不是点灯的事；
 *   ② 脚下那格按**共享亮度判据**（`body/util.js` 的 `lightVerdict`：方块光 ≤ 7 且天光 ≤ 7）
 *      判出来是"暗" —— 读不到就不插（主人：区分"没有"和"读不到"，读不到不猜）；
 *   ③ 身上有火把（torches > 0）。
 * **打架时不插**（由调用方保证，不在这个纯函数里）。
 *
 * ⚠️ 2026-09-29（问题 B）：原来这里还有第 ④ 条"最近的光源 > spacing 格才插"，
 * 已**删掉** —— 那正是"附近有火把 ≠ 这一格亮"的错判（被墙挡住 / 隔了一层照样中招），
 * 和 `body/mining.js` 的 `lightUp` 犯的是同一个错。要不要插只认**这一格的实测亮度**。
 *
 * @param {object} c
 * @param {object} c.exposure  头顶遮挡（`exposureOf(bot)` 的结果）
 * @param {(number|null)} c.light 脚下那格的方块光（读不到给 null）
 * @param {number} c.torches   身上火把数
 * @param {number} c.movedSince 从上次检查点走了多少格（行为节流，与"亮不亮"无关）
 * @param {boolean|null} [c.atHome] 在不在家范围里（`inHome()`；null = 不知道家在哪）
 * @param {boolean} [c.delving] 正在下矿（`I.delve` 有效）
 * @param {object} [c.modes]   `{home, away}` 开关（缺省用默认值）
 * @param {object} [c.lightVerdict] 共享亮度判据（`body/util.js`）；调用方注入，缺省按阈值就地算
 * @returns {{place:true, why:string, where:string, mode:string}|{place:false, why:string, where?:string, mode?:string}}
 */
function pickTorchStep (c = {}, cfg = CFG.torch) {
  const { exposure = null, light = null, torches = 0, movedSince = Infinity, lightVerdict = defaultLightVerdict } = c;
  // ① 场合：家里（ask/off）不自作主张；下矿 / 地下永远 auto（away=off 也照插，理由见上面 TORCH_MODES 上面那段）
  const sit = torchSituation({ exposure, atHome: c.atHome ?? null, delving: !!c.delving, modes: c.modes });
  if (sit.mode !== 'auto') {
    return { place: false, why: sit.where === 'home' ? `在家里（home=${sit.mode}）：${sit.mode === 'ask' ? '先问主人，不自己插' : '开关关着，不插'}` : sit.why, where: sit.where, mode: sit.mode };
  }
  if (!(torches > 0)) return { place: false, why: '身上没火把', where: sit.where, mode: sit.mode };
  // ④ 移动够了才检查（每 ~6 格一次，别每拍都点）
  if (movedSince < cfg.everyBlocks) return { place: false, why: `才走了 ${movedSince.toFixed(1)} 格，还没到 ${cfg.everyBlocks}`, where: sit.where, mode: sit.mode };
  // ② 判"暗不暗"用共享那份判据（`body/util.js` 的 `lightVerdict`）；读不到就不插（不猜）
  const v = lightVerdict(Number.isFinite(light) ? { block: light, sky: 0 } : null);
  if (v.unreadable) return { place: false, why: '脚下亮度读不到，不插', where: sit.where, mode: sit.mode };
  if (!v.dark) return { place: false, why: `脚下不暗（方块光 ${light}）`, where: sit.where, mode: sit.mode };
  return { place: true, why: `${sit.why}，脚下暗（方块光 ${light}）`, where: sit.where, mode: sit.mode };
}

/**
 * 共享亮度判据的兜底副本 —— **只为离线自测**。
 *
 * 名字和 `body/util.js` 导出的 `lightVerdict` 一样（`pickTorchStep` 里叫的也是它）——
 * 这个壳先看 `__ns` 里有没有真身（真机由 `instinct/core.js` 的 `tryTorch()` 通过
 * `deps.hands.lightVerdict` 注入 `pickTorchStep`，不走这里）；没有才用下面的兜底阈值。
 *
 * 为什么不顶层 require `body/util.js`：`body/` 和本文件**互不 require**（原来靠 bridge 那边
 * 传 `deps.hands` 才接得上），加一条 require 会多一条隐式耦合。阈值和 `body/util.js` 的
 * `DARK_BLOCK_MAX` / `SKY_BRIGHT` 相同 —— 形状锁在自测里钉住两者一致。
 */
const defaultLightVerdict = (l) => {
  if (!l || typeof l.block !== 'number') return { dark: false, unreadable: true };
  const sky = typeof l.sky === 'number' ? l.sky : 0;
  return { dark: l.block <= 7 && sky <= 7, unreadable: false };
};
function lightVerdict (...a) {
  if (__ns && typeof __ns.lightVerdict === 'function') return __ns.lightVerdict.apply(null, a);
  return defaultLightVerdict(...a);
}

/**
 * 家里的暗处（mindcraft modes.js 调研后建议的"只提醒、不动手"：插不插、插哪由 mind / 主人定，基地的布局归主人）。
 * 1.20.1 敌对怪要**方块光照 0** 才刷。亮度先要证明读得到：家里的光源（火把、灯…）自己那格读出来 ≥ 10 才信；
 * 有光源却都读成暗的 = 亮度数据读不到（mindcraft 就栽在这：block.light 是坏的），**不报暗**。
 * @param sourceLights  家里光源所在格读到的方块光照（数组；undefined/null = 读不到）
 * @param cells         家里可站的地面格 [{ pos, light }]（light = 脚那格的方块光照）
 * @returns null | { kind: 'unreadable' } | { kind: 'no_source' } | { kind: 'dark', count, sample:[pos] }
 */
function darkReport ({ sourceLights = [], cells = [] } = {}, minCount = 3) {
  const readable = sourceLights.some(l => typeof l === 'number' && l >= 10);
  if (sourceLights.length && !readable) return { kind: 'unreadable' };
  if (!sourceLights.length) return cells.length >= minCount ? { kind: 'no_source' } : null;
  const dark = cells.filter(c => c.light === 0);
  if (dark.length < minCount) return null;
  return { kind: 'dark', count: dark.length, sample: dark.slice(0, 3).map(c => c.pos) };
}

/**
 * mind 让下矿（`POST /delve`）之后，本能记下"正在下矿"（2026-09-28 第 8 批 第 5 条）。
 *
 * 实机证据：`delve(seconds=90 …) ✓ gained={raw_copper:5, cobblestone:21}` 只跑了 50 秒
 * 就因为战斗中断，然后她**站在原地等 mind 再想起来** —— 那段洞里看得见的矿就白瞎了。
 *
 * 这里只记"目标 / 方向 / 开始时刻 / 上次被打断的时刻"，不自己决定什么时候下矿。
 * 是否续探的判据在 `pickDelveResume`（纯函数，可离线自测）：
 *   · 5 分钟内（resumeMs）有 mind 发起的下矿记录；
 *   · 记录里的洞口离她现在不远（不跨维度、不跨半个世界）；
 *   · 体力/背包/mind 没有别的安排（由 tick 的顺序保证）；
 *   · 中途没有"她自己要走的事"（由调用点保证）。
 *
 * @param {object} I      state.instinct
 * @param {object} a      `POST /delve` 的参数（target / targetY / seconds）
 * @param {object} r      delve 的返回（reason / at / entry / deepest / heading）
 * @param {number} now
 */
function noteDelve (I, a = {}, r = {}, now = Date.now()) {
  if (!I) return null;
  const tgt = a.target || null; const ty = a.targetY != null ? +a.targetY : null;
  const rec = {
    target: tgt, targetY: ty, seconds: +a.seconds || +a.maxMs ? Math.round((+a.seconds || +a.maxMs / 1000)) : null,
    at: r.at ? { x: r.at.x, y: r.at.y, z: r.at.z } : null,
    entry: r.entry || null,
    heading: r.heading || null,
    startedAt: I.delve?.target === tgt ? (I.delve.startedAt || now) : now,
    resumes: a.resumed ? (I.delve?.target === tgt ? (I.delve.resumes || 0) + 1 : 1) : 0,   // mind 自己发起的下矿：计数归零
    lastAt: now,
    reason: r.reason || null,
    // 被战斗/怪打断：delve 的 reason 里会写"僵尸/骷髅 在 N 格外"这种
    interrupted: /在 \d+(\.\d+)? 格外/.test(String(r.reason || '')) ? String(r.reason) : null,
    // 这些原因停下的不自己接着下（Claude 复查）：血少回洞里危险；背包满 / 火把用完接着下会马上又停，来回抖
    noResume: /血只剩|背包快满|火把用完|没有火把|镐子不够/.test(String(r.reason || '')) ? String(r.reason) : null,
  };
  I.delve = rec;
  return rec;
}

/**
 * 该不该由**本能**把被打断的下矿接着走下去（第 5 条，纯函数）。
 *
 * cave 本能保持默认关（Codex 的理由成立：会把"人在洞里"误当成"主人让我探险"）。
 * 但**mind 明确发起过的下矿**不算"误当成" —— 有目标、有时间、有记录，接着走是照吩咐办事。
 *
 * @param {{delve:?object, self:?{x,y,z}, now:number, resumeMs:number, reach:number, enabled:boolean, caveEnabled:boolean}} c
 * @returns {null|{resume:true, why:string, target:?string, entry:?object}|{resume:false, why:string}}
 */
function pickDelveResume (c = {}) {
  const { delve = null, self = null, now = Date.now(), resumeMs = 300000, reach = 96 } = c;
  if (!c.enabled) return { resume: false, why: '续探本能关着' };
  if (!delve) return { resume: false, why: '最近没有下过矿' };
  if (delve.noResume) return { resume: false, why: `上次是因为「${delve.noResume}」停的，不自己接着下` };
  if ((delve.resumes || 0) >= (c.maxResumes ?? 3)) return { resume: false, why: `已经自己接着下了 ${delve.resumes} 次，等 mind 决定` };
  if (!self) return { resume: false, why: '没有位置' };
  const since = now - (delve.lastAt || delve.startedAt || 0);
  if (!(since < resumeMs)) return { resume: false, why: `上次下矿已是 ${Math.round(since / 1000)} 秒前（超过 ${Math.round(resumeMs / 1000)} 秒就不主动接着走了）` };
  // 离记录里的地方太远 → 不跨半张地图去"接着挖"
  const p = delve.at || delve.entry;
  if (p && Number.isFinite(p.x)) {
    const d = Math.hypot(self.x - p.x, self.z - p.z);
    if (d > reach) return { resume: false, why: `上次下矿的地方在 ${Math.round(d)} 格外（超过 ${reach} 格）` };
  }
  return { resume: true, why: delve.interrupted ? `上次因为「${delve.interrupted}」断了 ${Math.round(since / 1000)} 秒，接着把它挖完` : `上次下矿结束 ${Math.round(since / 1000)} 秒，还能接着挖`, target: delve.target, entry: delve.entry };
}

module.exports = { TORCH_COOLDOWN, TORCH_MODE_FILE, TORCH_MODES, applyTorchMode, bareNameOf, bind, darkReport, loadTorchMode, markTorchAsked, needTier, normTorchMode, normTorchState, noteDelve, noteTorchAnswer, pickCaveStep, pickDelveResume, pickOre, pickTorchAsk, pickTorchStep, pickaxeTier, saveTorchMode, torchModeOk, torchSituation };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/mining.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['镐子等级', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { TIER, needTier, pickaxeTier } = ns;
    // ---- 镐子等级 ----
    check('没有镐子 → -1', pickaxeTier(['minecraft:stick']), -1);
    check('石镐 + 铁镐 → 取最好的（铁=2）', pickaxeTier(['stone_pickaxe', 'minecraft:iron_pickaxe']), 2);
    check('金镐只算木级', pickaxeTier(['golden_pickaxe']), 0);
    check('模组镐认得出材质的按材质', pickaxeTier(['somemod:diamond_pickaxe_plus']), 3);
    check('模组镐认不出材质 → 按石镐（宁可少挖）', pickaxeTier(['somemod:crystal_pickaxe']), 1);
    check('★ 矿表没查到等级 → 保守按铁镐', needTier(null), TIER.iron);
  }],
  ['挖哪条矿', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { TIER, pickOre } = ns;
    // ---- 挖哪条矿 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const fails = new Map([[1, { n: 2, until: 1e12 }]]);
    const ore = (name, x, z, extra = {}) => ({ name, pos: { x, y: 64, z }, value: 'mid', tier: 'stone', drops: ['raw_iron'], visible: true, hazard: false, ...extra });
    const O = (ores, extra = {}) => pickOre({ ores, self: me, pick: 2, ...extra });
    check('看得见的铁矿 → 挖', O([ore('iron_ore', 3, 0)]).target?.name, 'iron_ore');
    check('★ 看不见的（透视）→ 不挖', O([ore('iron_ore', 3, 0, { visible: false })]).target, undefined);
    check('★ 旁边有岩浆 → 不挖', O([ore('iron_ore', 3, 0, { hazard: true })]).target, undefined);
    check('太远 → 不去', O([ore('iron_ore', 30, 0)]).target, undefined);
    check('★ 高价值优先，哪怕远一点', O([ore('iron_ore', 2, 0), ore('diamond_ore', 8, 0, { value: 'high', tier: 'iron' })]).target?.name, 'diamond_ore');
    const noTool = O([ore('diamond_ore', 3, 0, { value: 'high', tier: 'iron' })], { pick: 1 });
    check('★ 石镐遇钻石矿 → 不挖', noTool.target, undefined);
    check('★ …但告诉 mind 要铁镐', noTool.lacking?.[0]?.need, TIER.iron);
    check('没有镐子 → 什么都不挖', O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { pick: -1 }).target, undefined);
    const coal = (n) => O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { have: { coal: n } });
    check('煤不够（缺火把）→ 挖', coal(3).target?.name, 'coal_ore');
    check('★ 煤够多了 → 不为煤停下', coal(40).target, undefined);
    check('一条矿脉一起挖（同名的数）', O([ore('iron_ore', 3, 0), ore('iron_ore', 3, 1), ore('iron_ore', 4, 1)]).count, 3);
    check('要铲子的矿（化石矿）→ 不用镐去敲', O([ore('fossil_ore', 3, 0, { notPickaxe: true })]).target, undefined);
    check('失败过的格子冷却中 → 不挖', O([ore('iron_ore', 3, 0)], { fails: new Map([['3,64,0', 9e9]]), now: 0 }).target, undefined);
  }],
  ['按进度', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickOre } = ns;
    // ---- 按进度 ----
    const me = { x: 0.5, y: 64, z: 0.5 };
    const ore = (name, x, z, extra = {}) => ({ name, pos: { x, y: 64, z }, value: 'mid', tier: 'stone', drops: ['raw_iron'], visible: true, hazard: false, ...extra });
    const early = (ores, have = {}) => pickOre({ ores, self: me, pick: 1, have });   // 石镐：前期
    check('★ 前期（石镐）：铁矿排在最前，哪怕旁边有青金石', early([ore('lapis_ore', 2, 0, { drops: ['lapis_lazuli'] }), ore('iron_ore', 8, 0)]).target?.name, 'iron_ore');
    check('★ 前期：煤有 20 个还挖（前期门槛翻倍到 32）', early([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { coal: 20 }).target?.name, 'coal_ore');
    check('后期（铁镐）：煤有 20 个就不为它停', pickOre({ ores: [ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], self: me, pick: 2, have: { coal: 20 } }).target, undefined);
    check('后期：钻石排在铁前面', pickOre({ ores: [ore('iron_ore', 2, 0), ore('diamond_ore', 9, 0, { value: 'high', tier: 'iron' })], self: me, pick: 2 }).target?.name, 'diamond_ore');
  }],
  ['洞里下一步', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickCaveStep } = ns;
    // ---- 洞里下一步 ----
    const cv = (x, y, z, extra = {}) => ({ pos: { x, y, z }, visible: true, lavaNear: false, dark: true, ...extra });
    const here = { x: 0, y: 30, z: 0 };
    check('往看得见、够远的地方走', pickCaveStep({ cells: [cv(8, 30, 0)], self: here })?.pos.x, 8);
    check('★ 旁边有岩浆 → 不去', pickCaveStep({ cells: [cv(8, 30, 0, { lavaNear: true })], self: here }), null);
    check('看不见（隔着墙）→ 不去', pickCaveStep({ cells: [cv(8, 30, 0, { visible: false })], self: here }), null);
    check('★ 太低（落差 >4）→ 不跳', pickCaveStep({ cells: [cv(8, 20, 0)], self: here }), null);
    check('太近（原地挪）→ 不算一步', pickCaveStep({ cells: [cv(2, 30, 0)], self: here }), null);
    check('★ 去过的格子 → 不再去', pickCaveStep({ cells: [cv(8, 30, 0)], self: here, visited: new Set(['2,7,0']) }), null);
    check('★ 暗的优先（没点亮 = 没人来过）', pickCaveStep({ cells: [cv(14, 30, 0, { dark: false }), cv(7, 30, 0)], self: here })?.pos.x, 7);
    check('出了入口范围 → 不去', pickCaveStep({ cells: [cv(10, 30, 0)], self: here, entry: { x: -60, y: 30, z: 0 } }), null);
  }],
  ['暗处插火把（第 8 批 第 4 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { CFG, mobKind, pickTorchStep } = ns;
    // ---- 暗处插火把（第 8 批 第 4 条）----
    const T = (name, dist, extra = {}) => ({ id: dist * 10, name, pos: { x: dist, y: 64, z: 0 }, dist, on: 'me', evidence: 'aggressive', kind: mobKind(name), ...extra });
    {
      const T = { ...CFG.torch };
      const under = { kind: 'underground', roofAt: 5, solidAbove: 9 };
      check('★ 地下 + 脚下黑 + 有火把 → 插', pickTorchStep({ exposure: under, light: 0, torches: 5, movedSince: 10 }, T).place, true);
      check('没火把 → 不插', pickTorchStep({ exposure: under, light: 0, torches: 0, movedSince: 10 }, T).place, false);
      check('★ 亮度读不到 → 不插（不猜）', pickTorchStep({ exposure: under, light: null, torches: 5, movedSince: 10 }, T).place, false);
      // ⚠️ 2026-09-29 加火把开关后，这几条要带上 `atHome: false`：
      //    "露天不插"原来的意思是"野外露天不用点灯（夜里该回家睡）"。现在**家外**默认
      //    `away: 'auto'`（主人要的"探险时自动插"），所以露天 + 家外 + 脚下黑 → 插。
      //    地上露天的黑要不要点灯，判据已经从"是不是洞里"换成"在哪种场合"（torchSituation）。
      check('★ 地面露天、家外（kind=open + atHome=false）→ 还是插（away 默认 auto；主人 2026-09-29 要的）', pickTorchStep({ exposure: { kind: 'open', skyLight: 15 }, atHome: false, light: 0, torches: 5, movedSince: 10 }, T).place, true);
      check('★ 地面露天、家里（atHome=true）→ 不自己插（要问主人）', pickTorchStep({ exposure: { kind: 'open', skyLight: 15 }, atHome: true, light: 0, torches: 5, movedSince: 10 }, T).place, false);
      check('★ 地面露天、away=off（atHome=false）→ 不插', pickTorchStep({ exposure: { kind: 'open', skyLight: 15 }, atHome: false, modes: { away: 'off' }, light: 0, torches: 5, movedSince: 10 }, T).place, false);
      check('露天但头顶有顶（sheltered + roofAt）→ 就当洞里，照插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: 3, skyLight: 5 }, atHome: false, light: 3, torches: 5, movedSince: 10 }, T).place, true);
      check('露天、头顶有顶但读不出高度（roofAt=null）→ 不算洞里；家里要问、家外照插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: null }, atHome: true, light: 3, torches: 5, movedSince: 10 }, T).place, false);
      check('★ 脚下够亮（方块光 9）→ 不插', pickTorchStep({ exposure: under, light: 9, torches: 5, movedSince: 10 }, T).place, false);
      check('★ 才走了 2 格（没到 6）→ 先不检查', pickTorchStep({ exposure: under, light: 0, torches: 5, movedSince: 2 }, T).place, false);
      check('★ 第一次（movedSince=Infinity）→ 也算走够了', pickTorchStep({ exposure: under, light: 0, torches: 5, movedSince: Infinity }, T).place, true);
      check('亮度刚好在阈值上（7）→ 插（判据是 ≥ 阈值才不插）', pickTorchStep({ exposure: under, light: 7, torches: 5, movedSince: 10 }, T).place, true);
      check('亮度 8（阈值上一个）→ 不插', pickTorchStep({ exposure: under, light: 8, torches: 5, movedSince: 10 }, T).place, false);
      check('亮度 6 → 插', pickTorchStep({ exposure: under, light: 6, torches: 5, movedSince: 10 }, T).place, true);
      check('不插时说的理由里含"火把/光/暗"', /火把|光|暗|洞|走/.test(pickTorchStep({ exposure: under, light: 0, torches: 0, movedSince: 10 }, T).why), true);
      // ---- 问题 B（2026-09-29）：判据不再看"附近有没有光源" ----
      // 判"暗不暗"只走共享的 lightVerdict（注入真身，见 core.js 的 tryTorch）
      const fnSrc = instinctSrc().slice(instinctSrc().indexOf('function pickTorchStep'), instinctSrc().indexOf('const defaultLightVerdict'));
      check('★ 判据形状：pickTorchStep 走共享的 lightVerdict', /lightVerdict\(/.test(fnSrc), true);
      check('★ 判据形状：pickTorchStep 不再拿附近光源当判据（只认这一格的亮度）',
        /light > cfg\.darkMax|"附近有光源"|内已经有光源/.test(fnSrc), false);
      check('★ 注入判据时按它判（注入的判据说"亮" → 不插）',
        pickTorchStep({ exposure: under, light: 0, torches: 5, movedSince: 10, lightVerdict: () => ({ dark: false, unreadable: false }) }, T).place, false);
      check('★ 注入判据时按它判（注入的判据说"读不到" → 不插）',
        pickTorchStep({ exposure: under, light: 0, torches: 5, movedSince: 10, lightVerdict: () => ({ dark: false, unreadable: true }) }, T).place, false);
      check('★ 兜底判据的阈值和 body/util.js 一致（方块光 7 算暗、8 不算）',
        JSON.stringify([pickTorchStep({ exposure: under, light: 7, torches: 5, movedSince: 10 }, T).place, pickTorchStep({ exposure: under, light: 8, torches: 5, movedSince: 10 }, T).place]), JSON.stringify([true, false]));
      // 改之前"7 格内有光源就不插"是一条独立判据；删掉后所有输入都不带 nearestLight 也照样对
      check('★ 判据形状：config 里不再留 spacing（那是"看附近光源"的遗留参数）',
        /^\s*spacing:/m.test(require('fs').readFileSync(require('path').join(__dirname, 'config.js'), 'utf8')), false);
    }
  }],
  ['火把开关：场合判定（主人 2026-09-29）', async (t) => {
    const { check, ns } = t;
    const { TORCH_MODES, torchSituation, torchModeOk, normTorchMode } = ns;
    const under = { kind: 'underground', roofAt: 5 };
    const open = { kind: 'open', skyLight: 15 };
    const shelter = { kind: 'sheltered', roofAt: 3 };
    // 数组断言一律用「逐项相等」的判据 —— 本套件的 check 是严格 JSON 相等，
    // 只在字符串上才可靠（AGENTS.md：自测红了先怀疑断言，不能比对象/数组）。
    const eq = (a) => (b) => JSON.stringify(a) === JSON.stringify(b);
    // ---- 三种场合：下矿 / 地下 → auto（不问）；家里 → ask；家外露天 → auto ----
    check('★ 地下（underground）→ 自动插、不问', [torchSituation({ exposure: under, atHome: false }).where, torchSituation({ exposure: under, atHome: false }).mode], eq(['mine', 'auto']));
    check('★ 露天但头顶有顶（sheltered+roofAt）→ 算地下，自动插', torchSituation({ exposure: shelter, atHome: false }).mode, 'auto');
    check('★ 下矿中（delving）→ 自动插（哪怕站到地面上）', [torchSituation({ exposure: open, atHome: false, delving: true }).where, torchSituation({ exposure: open, atHome: false, delving: true }).mode], eq(['mine', 'auto']));
    check('★ 家里露天 → 问（home 默认 ask）', [torchSituation({ exposure: open, atHome: true }).where, torchSituation({ exposure: open, atHome: true }).mode, torchSituation({ exposure: open, atHome: true }).ask], eq(['home', 'ask', true]));
    check('★ 家里地下（自家矿道）→ 还是自动插（保命优先于"先问"）', torchSituation({ exposure: under, atHome: true }).where, 'mine');
    // 2026-09-29 Claude 复核：屋里有屋顶（sheltered + roofAt），原来被当成洞里、自动插 —— 家里"先问"就落空了
    check('★ 家里室内（有屋顶、在地面上）→ 先问，不自动插', torchSituation({ exposure: { kind: 'sheltered', roofAt: 3 }, atHome: true }).where, 'home');
    check('★ 家外有顶的地方（洞口 / 悬崖下）→ 仍算洞里、自动插', torchSituation({ exposure: { kind: 'sheltered', roofAt: 3 }, atHome: false }).where, 'mine');
    check('★ 家外露天 → 自动插、不问', [torchSituation({ exposure: open, atHome: false }).where, torchSituation({ exposure: open, atHome: false }).mode], eq(['away', 'auto']));
    check('不在家范围、也不知道家在哪（atHome=null）→ 按家外算', torchSituation({ exposure: open, atHome: null }).where, 'away');
    check('头顶遮挡读不到（exposure=null）也没在家 → 按家外', torchSituation({ exposure: null, atHome: false }).where, 'away');
    // ---- home 的三档 ----
    check('home=off → 家里不问（也不插）', [torchSituation({ exposure: open, atHome: true, modes: { home: 'off' } }).mode, torchSituation({ exposure: open, atHome: true, modes: { home: 'off' } }).ask], eq(['off', false]));
    check('home=auto → 家里自动插、不问', [torchSituation({ exposure: open, atHome: true, modes: { home: 'auto' } }).mode, torchSituation({ exposure: open, atHome: true, modes: { home: 'auto' } }).ask], eq(['auto', false]));
    // ---- away 的两档 ----
    check('away=off → 家外不插（场合判出来是 off）', torchSituation({ exposure: open, atHome: false, modes: { away: 'off' } }).mode, 'off');
    check('★ away=off 时下矿**仍然**自动插（保命优先，主人 2026-09-29 拍板）', torchSituation({ exposure: under, atHome: false, modes: { away: 'off' } }).mode, 'auto');
    check('★ away=off 且 delving → 还是自动插', torchSituation({ exposure: open, atHome: false, delving: true, modes: { away: 'off' } }).mode, 'auto');
    // ---- 开关值的合法性：只认白名单，写错不会静默变成"自动插" ----
    check('合法的值', [torchModeOk('home', 'ask'), torchModeOk('home', 'auto'), torchModeOk('home', 'off'), torchModeOk('away', 'auto'), torchModeOk('away', 'off')], eq([true, true, true, true, true]));
    check('不合法的值 → false（away 不许写 ask）', [torchModeOk('away', 'ask'), torchModeOk('home', 'yes'), torchModeOk('nope', 'auto')], eq([false, false, false]));
    check('归一：非法值回到默认（home→ask、away→auto）', [normTorchMode('home', 'yes'), normTorchMode('away', 'ask'), normTorchMode('home', undefined)], eq(['ask', 'auto', 'ask']));
    check('默认值就是任务书要的：家里先问、家外自动', [TORCH_MODES.home.def, TORCH_MODES.away.def], eq(['ask', 'auto']));
    // ---- pickTorchStep 接上开关 ----
    const T = { ...ns.CFG.torch };
    const P = (c) => ns.pickTorchStep(c, T);
    check('★ home=ask + 在家 + 脚下黑 → 不自己插（要问）', P({ exposure: open, atHome: true, light: 0, torches: 5, movedSince: 10 }).place, false);
    check('★ home=off + 在家 + 脚下黑 → 不插，理由说"开关关着"', /开关关着/.test(P({ exposure: open, atHome: true, light: 0, torches: 5, movedSince: 10, modes: { home: 'off' } }).why), true);
    check('★ home=auto + 在家 + 脚下黑 → 插', P({ exposure: open, atHome: true, light: 0, torches: 5, movedSince: 10, modes: { home: 'auto' } }).place, true);
    check('★ away=off + 家外露天 + 脚下黑 → 不插', P({ exposure: open, atHome: false, light: 0, torches: 5, movedSince: 10, modes: { away: 'off' } }).place, false);
    check('★ 地下 + home 的开关 → 还是插（地下不看 home）', P({ exposure: under, atHome: true, light: 0, torches: 5, movedSince: 10, modes: { home: 'off' } }).place, true);
    check('★ 场合写进了返回值（where/mode），便于诊断', P({ exposure: open, atHome: true, light: 0, torches: 5, movedSince: 10 }).where, 'home');
    check('★ 家里（ask）不插时理由写得清"先问主人"', /先问主人/.test(P({ exposure: open, atHome: true, light: 0, torches: 5, movedSince: 10 }).why), true);
  }],
  ['火把开关：家里问一次 / 冷却（主人 2026-09-29）', async (t) => {
    const { check, ns } = t;
    const { pickTorchAsk, TORCH_COOLDOWN, normTorchState } = ns;
    const H = 3600000; const now = 2000000000000;
    // 数组断言用逐项相等（本套件的 check 是严格 `===`，见 testkit.js）
    const eq = (a) => (b) => JSON.stringify(a) === JSON.stringify(b);
    // ---- 该问 ----
    check('★ 家里有暗处、home=ask、没问过 → 问', pickTorchAsk({ mode: 'ask', state: null, now }).ask, true);
    check('没有暗处 → 不问', pickTorchAsk({ mode: 'ask', state: null, now, darkCount: 0 }).ask, false);
    check('home=off → 不问', pickTorchAsk({ mode: 'off', state: null, now }).ask, false);
    check('home=auto → 不问（本能自己插）', pickTorchAsk({ mode: 'auto', state: null, now }).ask, false);
    // ---- 主人说"不用" → 24 小时内不再问、不再催 ----
    const saidNo = { home: 'ask', away: 'auto', askedAt: now - 2 * H, answer: 'no', answeredAt: now - 2 * H, quietUntil: now - 2 * H + TORCH_COOLDOWN.offMs };
    check('★ 主人说不用、才过 2 小时 → 不问', pickTorchAsk({ mode: 'ask', state: saidNo, now }).ask, false);
    check('★ 理由里写清"还有多久到 24 小时"', /24 小时/.test(pickTorchAsk({ mode: 'ask', state: saidNo, now }).why), true);
    check('★ 冷却是 24 小时（配置里写死）', TORCH_COOLDOWN.offMs, 24 * 60 * 60 * 1000);
    check('★ 主人说不用、过了 24 小时 → 可以再问一次', pickTorchAsk({ mode: 'ask', state: saidNo, now: saidNo.quietUntil + 1000 }).ask, true);
    check('刚好卡在 24 小时那一刻 → 还不到（保守为不问）', pickTorchAsk({ mode: 'ask', state: saidNo, now: saidNo.quietUntil }).ask, false);
    check('他说不用是 30 小时前、中间没再问 → 能再问', pickTorchAsk({ mode: 'ask', state: { home: 'ask', answer: 'no', answeredAt: now - 30 * H, askedAt: now - 30 * H, quietUntil: now - 30 * H + TORCH_COOLDOWN.offMs }, now }).ask, true);
    check('老数据（说不用但没写 quietUntil）→ 按回答时刻 + 24 小时兜底', pickTorchAsk({ mode: 'ask', state: { home: 'ask', answer: 'no', answeredAt: now - 3 * H, askedAt: now - 3 * H }, now }).ask, false);
    // ---- 他没回答 → 6 小时内不追问 ----
    const noAnswer = { home: 'ask', away: 'auto', askedAt: now - H, answer: null, answeredAt: null, quietUntil: null };
    check('★ 问过、他没回、才 1 小时 → 不追问', pickTorchAsk({ mode: 'ask', state: noAnswer, now }).ask, false);
    check('★ 没回答的冷却写的就是 6 小时', TORCH_COOLDOWN.noAnswerMs, 6 * 60 * 60 * 1000);
    check('★ 过了 6 小时他还是没回 → 才能再提一次', pickTorchAsk({ mode: 'ask', state: noAnswer, now: noAnswer.askedAt + TORCH_COOLDOWN.noAnswerMs + 1000 }).ask, true);
    check('刚好 6 小时 → 还不到', pickTorchAsk({ mode: 'ask', state: noAnswer, now: noAnswer.askedAt + TORCH_COOLDOWN.noAnswerMs }).ask, false);
    // ---- 他说"要插" → 不拦（去插；没插成可以再说） ----
    check('★ 主人说要 → 不拦（去插；暗处还在就是没插成，可以再说）', pickTorchAsk({ mode: 'ask', state: { home: 'ask', askedAt: now - 60 * 60 * 1000, answer: 'yes', answeredAt: now - 3600 * 1000 }, now }).ask, true);
    // ---- 存盘形状：脏数据不采信 ----
    const clean = normTorchState({ home: 'YES', away: 'ask', askedAt: 'x', answer: 'maybe', quietUntil: 'y' });
    check('★ 读回来的乱值全部归一到白名单', [clean.home, clean.away, clean.askedAt, clean.answer, clean.answeredAt, clean.quietUntil], eq(['ask', 'auto', null, null, null, null]));
    check('★ ISO 字符串时间能读回来（给人看的可读时间）', typeof normTorchState({ quietUntil: '2026-09-30T12:00:00Z' }).quietUntil, 'number');
    const empty = normTorchState(null);
    check('空 / null → 默认值', [empty.home, empty.away, empty.askedAt, empty.answer, empty.quietUntil], eq(['ask', 'auto', null, null, null]));
  }],
  ['火把开关：持久化（写入 → 重新加载 → 设置一致）', async (t) => {
    const { check, ns } = t;
    const { loadTorchMode, saveTorchMode, applyTorchMode, markTorchAsked, noteTorchAnswer, TORCH_COOLDOWN, pickTorchAsk } = ns;
    const fs = require('fs'); const os = require('os'); const p = require('path');
    const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'torch-mode-'));
    const file = p.join(dir, 'torch-mode.json');
    const eq = (a) => (b) => JSON.stringify(a) === JSON.stringify(b);
    try {
      // ---- 文件不存在 = 从没设置过（不是"读不到"） ----
      const fresh = loadTorchMode(file);
      check('★ 文件不存在 → 用默认值、且不报"读不到"', [fresh.unreadable, fresh.why, fresh.state.home, fresh.state.away], eq([false, null, 'ask', 'auto']));
      // ---- 写入 → 重新加载 → 设置一致 ----
      const w = applyTorchMode(fresh.state, { home: 'off', away: 'off' }, file);
      check('★ 写入成功', [w.ok, w.changed.home, w.changed.away], eq([true, 'off', 'off']));
      const back = loadTorchMode(file);
      check('★ 重新加载 → 设置和写进去的一致', [back.state.home, back.state.away], eq(['off', 'off']));
      check('★ 文件真的是 JSON（人能看懂 / 能手改）', JSON.parse(fs.readFileSync(file, 'utf8')).home, 'off');
      // ---- 只改一个键，另一个不动 ----
      const w2 = applyTorchMode(back.state, { home: 'auto' }, file);
      check('★ 只给 home → away 保持原样', [w2.state.home, w2.state.away], eq(['auto', 'off']));
      // ---- 非法值：拒绝，不是静默回退 ----
      const w3 = applyTorchMode(loadTorchMode(file).state, { away: 'ask' }, file);
      check('★ away=ask 不合法 → 拒绝并说清允许哪些', [w3.ok, /auto \/ off/.test(w3.error)], eq([false, true]));
      check('★ 被拒绝时文件没被改动（还是 auto/off）', (() => { const s = loadTorchMode(file).state; return [s.home, s.away]; })(), eq(['auto', 'off']));
      // ---- 问过的时刻要落盘（没回答的 6 小时冷却靠它） ----
      const nowA = 2000000000000;
      const asked = markTorchAsked(loadTorchMode(file).state, nowA, file);
      check('★ "问过了"落盘', loadTorchMode(file).state.askedAt, nowA);
      check('★ 落盘后 1 小时：不再问（重启也记得）', pickTorchAsk({ mode: 'ask', state: loadTorchMode(file).state, now: nowA + 3600000 }).ask, false);
      check('★ 落盘后 6 小时零 1 秒：可以再问', pickTorchAsk({ mode: 'ask', state: loadTorchMode(file).state, now: nowA + TORCH_COOLDOWN.noAnswerMs + 1000 }).ask, true);
      // ---- 主人的回答落盘 ----
      const sayNo = noteTorchAnswer(loadTorchMode(file).state, 'no', { now: nowA + 7000000 }, file);
      check('★ 说"不用" → quietUntil = 回答时刻 + 24 小时', sayNo.state.quietUntil, nowA + 7000000 + TORCH_COOLDOWN.offMs);
      const reload = loadTorchMode(file).state;
      check('★ 重启后还记得"不用"（24 小时内不问）', pickTorchAsk({ mode: 'ask', state: reload, now: nowA + 7000000 + 3600000 }).ask, false);
      check('★ 重启后过了 24 小时 → 能再问', pickTorchAsk({ mode: 'ask', state: reload, now: reload.quietUntil + 1 }).ask, true);
      // ---- 他说"要插 + 以后都自动" ----
      const sayYes = noteTorchAnswer(reload, 'yes', { now: nowA + 90000000, alsoAuto: true }, file);
      const reload2 = loadTorchMode(file).state;
      check('★ 说"要" + 以后都自动 → answer=yes 且 home 变成 auto', [reload2.answer, reload2.home], eq(['yes', 'auto']));
      check('★ 说"要"之后不按"他没回答"算（能去插）', pickTorchAsk({ mode: 'ask', state: reload2, now: nowA + 90000000 + 1000 }).ask, true);
      check('非法回答 → 拒绝', noteTorchAnswer(reload, 'maybe', {}, file).ok, false);
      // ---- 坏文件：读不出来要报"读不到"，不是"没设置" ----
      fs.writeFileSync(file, '{ this is not json');
      const broken = loadTorchMode(file);
      check('★ 坏 JSON → unreadable=true 且说明原因（不静默当默认）', [broken.unreadable, /不是合法 JSON/.test(broken.why)], eq([true, true]));
      check('★ 坏文件也回默认值（不至于让她彻底不能插）', [broken.state.home, broken.state.away], eq(['ask', 'auto']));
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }],
  ['续挖下矿（第 8 批 第 5 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { noteDelve, pickDelveResume } = ns;
    // ---- 续挖下矿（第 8 批 第 5 条）----
    {
      const now = 2000000;
      const drec = { target: 'iron_ore', targetY: 16, at: { x: 100, y: 20, z: 100 }, entry: { x: 100, y: 64, z: 100 }, lastAt: now - 60000, interrupted: '僵尸 在 3 格外' };
      check('★ 3 分钟前被打断的下矿 → 接着挖', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
      check('★ 8 分钟前断的（超过 5 分钟）→ 不主动接着走', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now: now + 300000, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('★ 记录的地方在 200 格外 → 不跨地图去接', pickDelveResume({ delve: drec, self: { x: 400, y: 20, z: 400 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('从没下过矿 → 不续', pickDelveResume({ delve: null, self: { x: 0, y: 64, z: 0 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('续挖本能关着 → 不续', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: false }).resume, false);
      check('没有位置 → 不续', pickDelveResume({ delve: drec, self: null, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
      check('★ 续挖时带上原来的目标矿', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).target, 'iron_ore');
      // noteDelve：mind 下矿后被喂一条记录
      {
        const I2 = {};
        noteDelve(I2, { target: 'iron_ore', targetY: 16, seconds: 90 }, { reason: '时间到（90 秒），可以接着挖', at: { x: 1, y: 30, z: 2 }, entry: { x: 1, y: 64, z: 2 }, heading: [1, 0] }, now);
        check('★ noteDelve 记下目标', I2.delve.target, 'iron_ore');
        { const I3 = { cfg: {} }; const t = now;
          noteDelve(I3, { target: 'iron_ore' }, { reason: '血只剩 6', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 血少停下的 → 不自己接着下', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          noteDelve(I3, { target: 'iron_ore' }, { reason: '背包快满了', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 背包满停下的 → 不自己接着下（会来回抖）', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          const I4 = { cfg: {} };
          noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          for (let i = 0; i < 3; i++) noteDelve(I4, { target: 'coal_ore', resumed: true }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ 自己接着下了 3 次 → 不再接', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
          const I5 = { cfg: {} };
          noteDelve(I5, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
          check('★ mind 自己又下一次矿 → 计数归零，又能接着下', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true);
          check('被怪打断一次 → 接着下', pickDelveResume({ enabled: true, delve: I5.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true); }
        check('noteDelve 记下位置', I2.delve.at.x, 1);
        check('★ 正常结束（时间到）不算 interrupted', I2.delve.interrupted, null);
        noteDelve(I2, { target: 'iron_ore' }, { reason: '僵尸 在 4 格外', at: { x: 3, y: 20, z: 4 } }, now + 1000);
        check('★ 被怪打断 → 记 interrupted', /僵尸/.test(String(I2.delve.interrupted)), true);
        check('★ 被怪打断后 5 分钟内续挖的判据成立', pickDelveResume({ delve: I2.delve, self: { x: 3, y: 20, z: 4 }, now: now + 6000, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
        const I3 = {};
        noteDelve(I3, { target: 'diamond' }, { reason: '没带火把，不下去（没有煤/木炭）' }, now);
        check('失败也记一笔（免得当成从没下过矿）', I3.delve.target, 'diamond');
      }
    }
  }],
  ['遇到矿就挖：价值排序（第 8 批 第 3 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickOre } = ns;
    // ---- 遇到矿就挖：价值排序（第 8 批 第 3 条）----
    const O = (ores, extra = {}) => pickOre({ ores, self: me, pick: 2, ...extra });
    const me = { x: 0.5, y: 64, z: 0.5 };
    {
      const mkCfg = { radius: 16, maxDy: 6, maxVein: 8, lowWhenBelow: 16, followLeash: 16 };
      const self = { x: 0, y: 30, z: 0 };
      const O = (name, value, dist, extra = {}) => ({ name, value, tier: 'stone', pos: { x: dist, y: 30, z: 0 }, visible: true, drops: [name], ...extra });
      // 近处 mid（油矿）vs 远处 high（铁矿）→ 该选 high（第 3 条的现场：她挖了油矿没挖铁矿）
      const r1 = pickOre({ ores: [O('ltc2:underground_oil_ore', 'mid', 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
      check('★ 近处 mid 油矿 vs 远处 high 铁矿 → 挖 high（价值优先于距离）', r1.target.name, 'minecraft:iron_ore');
      // 同档才比距离
      const r2 = pickOre({ ores: [O('a:high1', 'high', 9), O('b:high2', 'high', 3)], self, pick: 2 }, mkCfg);
      check('同一档 → 近的先挖', r2.target.name, 'b:high2');
      // 没有 value 字段的 → 排最后
      const r3 = pickOre({ ores: [O('mystery:ore', undefined, 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
      check('★ 矿表里没有 value 的排在 high 后面', r3.target.name, 'minecraft:iron_ore');
      // 只有没价值的 → 还是挖（比什么都不做强，且能顺手补矿表）
      const r4 = pickOre({ ores: [O('mystery:ore', undefined, 3)], self, pick: 2 }, mkCfg);
      check('★ 附近只有"没价值的"矿 → 也挖（不挑三拣四）', r4.target.name, 'mystery:ore');
      // 半径从 12 放到 16：15 格外的矿现在算"眼前"
      const r5 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 15)], self, pick: 2 }, mkCfg);
      check('★ 15 格外的铁矿（>旧半径 12）→ 现在挖得到', r5.target.name, 'minecraft:iron_ore');
      const r6 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 18)], self, pick: 2 }, mkCfg);
      check('18 格外（>新半径 16）→ 还是太远', r6.target, undefined);
      // 跟随模式：矿不能离被跟的人太远
      const r7 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: 0, y: 30, z: 0 } } }, mkCfg);
      check('跟着人时：矿在她脚下（离人也近）→ 能挖', r7.target.name, 'minecraft:iron_ore');
      const r8 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: -14, y: 30, z: 0 } } }, mkCfg);
      check('★ 跟着人时：矿离他 28 格（>跟随半径）→ 不挖（挖完追不上）', r8.target, undefined);
    }
  }],
];
register('mining', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('mining', __sections);
}
