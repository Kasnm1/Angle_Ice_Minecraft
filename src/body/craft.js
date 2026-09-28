'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「craft」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3

const __ns = {};

// HSTATE 的唯一一份在汇总 index.js；这里只接一个 getter，避免变成副本。
let getHandsState = () => null;
function setHandsState (get) { getHandsState = get; }
let backpackChain;   // 常量：load 完成后由 bind() 回填
function K (...a) { return __ns.K.apply(null, a); }
function auditSortedRange (...a) { return __ns.auditSortedRange.apply(null, a); }
function blockVisible (...a) { return __ns.blockVisible.apply(null, a); }
function botName (...a) { return __ns.botName.apply(null, a); }
function canUseFrom (...a) { return __ns.canUseFrom.apply(null, a); }
function canUseNow (...a) { return __ns.canUseNow.apply(null, a); }
function categoryOf (...a) { return __ns.categoryOf.apply(null, a); }
function compareSortedItems (...a) { return __ns.compareSortedItems.apply(null, a); }
// 合成缺料时去精妙背包补料（2026-09-29）：判据/入口都在 containers.js，这里只转发
function countInBackpackSeen (...a) { return __ns.countInBackpackSeen.apply(null, a); }
function resolveCarryId (...a) { return __ns.resolveCarryId.apply(null, a); }
function containerOpen (...a) { return __ns.containerOpen.apply(null, a); }
function curiosEquip (...a) { return __ns.curiosEquip.apply(null, a); }
function delta (...a) { return __ns.delta.apply(null, a); }
function ensureCarried (...a) { return __ns.ensureCarried.apply(null, a); }
function equipChanges (...a) { return __ns.equipChanges.apply(null, a); }
function equipment (...a) { return __ns.equipment.apply(null, a); }
function eyeDist (...a) { return __ns.eyeDist.apply(null, a); }
function findItem (...a) { return __ns.findItem.apply(null, a); }
function foodScore (...a) { return __ns.foodScore.apply(null, a); }
function fullId (...a) { return __ns.fullId.apply(null, a); }
function go (...a) { return __ns.go.apply(null, a); }
function invCounts (...a) { return __ns.invCounts.apply(null, a); }
function nearestBlock (...a) { return __ns.nearestBlock.apply(null, a); }
function noteSeen (...a) { return __ns.noteSeen.apply(null, a); }
function sleep (...a) { return __ns.sleep.apply(null, a); }
function slotByName (...a) { return __ns.slotByName.apply(null, a); }
function stackIdentity (...a) { return __ns.stackIdentity.apply(null, a); }
function summarizeWindow (...a) { return __ns.summarizeWindow.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); backpackChain = ns.backpackChain; }

/**
 * 走到方块旁边（够得着**而且看得见**为止）。真人要用熔炉会自己走过去 —— 不该让大脑先算好坐标再 goto。
 * 16 格内的才走；更远的交回给大脑（那是"去某处"的规划问题，不是"伸手"）。
 *
 * @returns {{walked:boolean, lineOfSight:boolean|null, dist:number, ms?:number, via?:string}}
 * walked=      真的移动过（原地能用是 false）
 * lineOfSight= 结束时眼睛到方块通不通（null = 读不到）
 * dist=        结束时的 eyeDist
 * 走不过去且原地也用不了（太远 / 中间挡着）→ 抛错，别硬点（服务器会拒，还会出幽灵结果）
 */
async function approach (bot, block) {
  // 先看"现在能不能直接用"：4 格内**且**视线通才原地用
  const start = canUseNow(bot, block);
  const p = block.position;
  const pack = (walked, ms, via) => ({ walked, lineOfSight: blockVisible(bot, block), dist: eyeDist(bot, block), ...(ms != null ? { ms } : {}), ...(via ? { via } : {}) });
  if (start.use) return pack(false);

  const { goals } = require('mineflayer-pathfinder');
  const t0 = Date.now();
  // 不在同一层（锅在一楼厨房、她在三楼仓库）：用会爬梯子、开门的路线走过去
  if (Math.abs(p.y - bot.entity.position.y) >= 2.5 && getHandsState()) {
    await go(bot, getHandsState(), { x: p.x, y: p.y, z: p.z, range: 2 });
    const r = canUseNow(bot, block);
    if (r.use) return pack(true, Date.now() - t0, 'route');
  }
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)),
      sleep(20000).then(() => { throw new Error('走了 20 秒还没到'); }),
    ]);
  } catch (e) {
    bot.pathfinder.setGoal(null);
    // 走不过去：原地能用（含视线通）就照样用；否则如实报"够不着 / 中间挡着"
    const r = canUseNow(bot, block);
    if (r.use) return pack(false, Date.now() - t0, 'goto-failed-but-in-reach');
    throw new Error(`走不到 ${block.name}(${p.x},${p.y},${p.z}) 旁边：${e.message}；${r.why}`);
  }
  const r = canUseNow(bot, block);
  if (!r.use) throw new Error(`走到了还是用不了 ${block.name}：${r.why}`);
  return pack(true, Date.now() - t0);
}

async function findAndApproach (bot, names) {
  const b = nearestBlock(bot, names, 4.4) || nearestBlock(bot, names, 16);
  if (!b) return null;
  await approach(bot, b);
  return b;
}

/**
 * 从知识库挑一条**现在背包就做得出来**的工作台/背包配方，翻成 mineflayer 的 Recipe 交给 bot.craft。
 * bot.craft 自己会把东西摆进合成格、取出成品 —— 我们只替换"配方从哪来"。
 */
/**
 * 合成没成时，材料会留在合成格里（背包的 2×2 是 0 号窗口的 1–4 格，工作台是开着的窗口的 1–9 格）。
 * 关掉窗口服务器会把格子里的东西还给她；背包窗口没法"关"，就发一次 close_window(0) —— 原版客户端按 E 关背包也是这么做的。
 * 2026-09-27 实测：合成超时后 3 个原木不见了（卡在合成格里）
 */
async function returnGrid (bot) {
  try {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    bot._client.write('close_window', { windowId: 0 });
  } catch (_) {}
  await sleep(400);
}

/**
 * 自己一格一格摆合成格（替代 mineflayer 的 bot.craft）。
 * 2026-09-27 实测 bot.craft 在这个服上：4 块花岗岩只进了 3 格、成品格一直空、20 秒超时，原料卡在合成格里（看着就是"被吃了"）；
 * 同时服务器说花岗岩在 14 号格、客户端以为在 16 号格 —— 它一口气连点不核对，一错位就全乱。
 * 这里每一下都等服务器回话：摆一格 → 把手上剩的放回去 → 等成品格真的出东西 → shift 点成品 → 核对。
 */
async function craftByHand (bot, recipe, times, table) {
  let win = bot.inventory; let w = 2;
  if (table) {
    if (!bot.currentWindow || !/crafting/.test(bot.currentWindow.type || '')) {
      await approach(bot, table);
      bot.activateBlock(table);
      const t0 = Date.now(); while (!(bot.currentWindow && /crafting/.test(bot.currentWindow.type || '')) && Date.now() - t0 < 4000) await sleep(50);
      if (!bot.currentWindow) throw new Error('工作台打不开');
    }
    win = bot.currentWindow; w = 3;
  }
  const cells = [];
  if (recipe.inShape) recipe.inShape.forEach((row, y) => row.forEach((id, x) => { if (id != null && id !== -1) cells.push({ slot: 1 + x + y * w, id: typeof id === 'object' ? id.id : id }); }));
  else recipe.ingredients.forEach((id, i) => cells.push({ slot: 1 + i, id: typeof id === 'object' ? id.id : id }));
  const pause = () => sleep(+process.env.CRAFT_PAUSE_MS || 150);
  const findSrc = (id) => { for (let i = win.inventoryStart; i < win.inventoryEnd; i++) { const it = win.slots[i]; if (it && it.type === id) return i; } return -1; };
  // 原料在哪格：开始时（服务器同步过的状态）找一次，之后一直从这格拿。
  // 不能每次重找：这个服上客户端对"拿起一叠"的预测是错的（拿起后以为格子空了、手上也空），一重找就说缺原料
  const srcOf = new Map();
  for (const c of cells) if (!srcOf.has(c.id)) { const i = findSrc(c.id); if (i < 0) throw new Error(`缺原料（物品 id ${c.id}）`); srcOf.set(c.id, i); }
  let made = 0;
  try {
    for (let t = 0; t < times; t++) {
      win.slots[0] = null;   // 成品格只认这一轮服务器发来的
      // 同一种原料：拿起一次 → 该放的格子挨个右键 → 放回原格。不看 win.selectedItem（这个服上它不跟踪）。
      // 实测这个顺序服务器马上出成品（/debug/seq：40 拿起、1-4 右键、40 放回 → 成品格 4 个磨制花岗岩）；
      // 每格都"拿起-放-放回"就会乱（第一格放不进）
      for (const [id, src] of srcOf) {
        await bot.clickWindow(src, 0, 0); await pause();
        for (const c of cells.filter(x => x.id === id)) { await bot.clickWindow(c.slot, 1, 0); await pause(); }
        await bot.clickWindow(src, 0, 0); await pause();
      }
      const t0 = Date.now(); while (!win.slots[0] && Date.now() - t0 < 3000) await sleep(50);
      if (!win.slots[0]) {
        const grid = cells.map(c => `${c.slot}:${win.slots[c.slot]?.name || '空'}`).join(' ');
        throw new Error(`摆好了但服务器没出成品（合成格 ${grid}）`);
      }
      await bot.clickWindow(0, 0, 1); await sleep(250);          // shift 点成品，进背包
      made++;
    }
  } finally {
    if (table && bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); } else if (!table) await returnGrid(bot);
  }
  return made;
}

/**
 * 用配方书做：只告诉服务器"我要做配方 X"（craft_recipe_request），服务器自己从背包拿料摆好、出成品，再 shift 点成品格。
 * 不靠客户端的格子号 —— 2026-09-27 实测这个服上客户端和服务器对背包格子号认识不一致（登录时服务器说花岗岩在合成格 4 号），
 * 自己点格子（bot.craft / 手摆）都会乱：原料卡进合成格、成品不出。原版玩家点配方书也是这条路。
 */
async function craftByRecipeBook (bot, recipeId, times, table) {
  let win = bot.inventory;
  if (table) {
    if (!bot.currentWindow || !/crafting/.test(bot.currentWindow.type || '')) {
      await approach(bot, table);
      bot.activateBlock(table);
      const t0 = Date.now(); while (!(bot.currentWindow && /crafting/.test(bot.currentWindow.type || '')) && Date.now() - t0 < 4000) await sleep(50);
      if (!bot.currentWindow) throw new Error('工作台打不开');
    }
    win = bot.currentWindow;
  }
  let made = 0;
  try {
    for (let t = 0; t < times; t++) {
      win.slots[0] = null;
      bot._client.write('craft_recipe_request', { windowId: win.id, recipe: recipeId, makeAll: false });
      const t0 = Date.now(); while (!win.slots[0] && Date.now() - t0 < 3000) await sleep(50);
      if (!win.slots[0]) throw new Error(made ? `做了 ${made} 次后服务器不给了（原料不够？）` : `服务器没按配方 ${recipeId} 摆出成品`);
      await bot.clickWindow(0, 0, 1); await sleep(300);          // shift 点成品，进背包
      made++;
    }
  } finally {
    if (table && bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); } else if (!table) await returnGrid(bot);
  }
  return made;
}

/**
 * 挑"最容易做的一条配方"，并说清缺什么。
 *
 * 起因（2026-09-28 实机）：`POST /craft2 {itemName:"stone_pickaxe"}` 的报错把**每条候选配方**的缺料
 * 混在一句里吐出来 —— `缺 任意「#forge:rods/wooden（如 木棍）」(#forge:rods/wooden)；缺 火成岩(terramity:igneostone)、
 * 木棍(minecraft:stick)`。她抓不住重点，而且"火成岩"这种模组石头本来就不该出现在首选建议里。
 *
 * 判据（复用 knowledge.js 已有的，不另写一份 —— AGENTS.md §5）：
 *   · **原版优先**是最强的信号（`recipeRank`）：背包内 < 工作台/熔炉 < 原版类型 < 模组。
 *     先按它排，能挡住"箱子 ← 橡木箱子"这类整合包加的**转换配方**被当成首选。
 *   · 同档次再看缺的东西**越少越好**（种类数 → 总个数）。
 *   · 缺的能**从自然方块直接挖到**（`naturalRaw`）优于还得再合成的。
 * 报错只讲选中的这一条；其余配方最多加一句"另外还有 N 种做法"。
 *
 * @returns { best, rest, needs }
 *   needs = [{ need, have, ok, sample }]  每种原料：要几个、有几个、够不够
 */
function rankRecipesFor (k, KB, have, id, R, times) {
  const raw = (x) => !!(x && k.naturalRaw?.(x));
  // 说给人听的名字：身上有的 > 原版里最"素"的那个 > 能直接挖到的 > 标签里第一个。
  // 为什么这么挑：`quark:stone_tool_materials` 里有 andesite / diorite / granite / polished_andesite /
  // infested_stone / stone / deepslate / tuff ……，主人能一眼认出来的是"石头"，不是"抛光安山岩"或"凝灰岩"
  // （2026-09-28 实测踩到）。判据：① 名字里没有加工前缀（polished/chiseled/…）
  // ② 名字最短（"stone" 比 "andesite"/"deepslate" 基础）③ 能用来做的东西最多（越基础的材料配方越多）。
  const VARIANT_RE = /(?:^|[:_])(polished|chiseled|smooth|cut|cracked|mossy|infested|carved|waxed|stripped)(?:_|$)/;
  /**
   * 说给人听的名字。
   * 优先级：身上有的 > **标签名里带这个基底名**的 > 最"素"的原版 > 能直接挖到的 > 第一个。
   *
   * `quark:stone_tool_materials` 里有 andesite / diorite / granite / polished_andesite / infested_stone /
   * stone / deepslate / tuff ……，主人能一眼认出来的是"石头"。光按名字长短会挑到"凝灰岩(tuff)"，
   * 但**标签名 `stone_tool_materials` 里就写着 stone** —— 这才是这个标签的本意（2026-09-28 实测踩到）。
   */
  const pickSample = (ids, alts) => {
    const held = ids.find(x => (have.get(x) || 0) > 0);
    if (held) return held;
    const tagIds = (alts || []).filter(a => a.tag).map(a => String(a.tag).split(':').pop());
    const vanilla = ids.filter(x => String(x).startsWith('minecraft:'));
    const plain = vanilla.filter(x => !VARIANT_RE.test(x));
    const pool = plain.length ? plain : vanilla;
    // 先看"标签名里写着它"的那个 —— 这是标签的本意，哪怕它自己不是 naturalRaw
    // （`minecraft:stone` 不是 naturalRaw，挖石头得到的是圆石，但"石头"才是主人认得的名字）。
    // 2026-09-28 Claude 复查：先挑"能直接从自然方块挖到"的（石镐的 stone_tool_materials 里有圆石 —— 挖石头掉的就是它），
    // 挑不到再按标签名（木板这类本来就要合成的）。以前名字优先，报成"石头 3"，她会去找石头，挖下来却是圆石。
    const rawNamed = pool.filter(raw);
    if (rawNamed.length) {
      const pick = rawNamed.find(x => /(^|:)cobblestone$/.test(x)) || rawNamed[0];
      return pick;
    }
    const named = pool.find(x => tagIds.some(t => t.split('_').includes((x.split(':')[1] || '').split('_')[0])));
    if (named) return named;
    const crafty = pool.filter(raw);
    const final = crafty.length ? crafty : pool;
    return final.slice().sort((a, b) => (a.split(':')[1] || '').length - (b.split(':')[1] || '').length
      || (KB.byOutput.get(b) || []).length - (KB.byOutput.get(a) || []).length)[0]
      || ids.find(raw) || ids[0] || null;
  };
  const slotIds = (alts) => [...new Set(alts.flatMap(a => (a.item ? [a.item] : [...(KB.tags.get(`item:${a.tag}`) || [])])))];
  const slotNeed = (alts, need) => {
    const ids = slotIds(alts);
    const got = ids.reduce((n, x) => n + (have.get(x) || 0), 0);
    return { need, have: got, ok: got >= need, sample: pickSample(ids, alts) };
  };
  const needs = (r) => {
    if (r.shape) {
      return Object.entries(r.shape.key).map(([ch, alts]) => {
        const n = r.shape.pattern.join('').split(ch).length - 1;
        return slotNeed(alts, n * times);
      });
    }
    return r.in.map(s => slotNeed(s.alts, s.count * times));
  };
  // 这条配方是不是"**拆回来**"而不是"做出来"。
  // 实机踩到：`chest` 的首选曾经是 `quark:.../chest_revert`（原料 = `#quark:revertable_chests`，
  // 里面是各种 *_chest），报错成了"还缺 橡木箱子"—— 箱子当然不该用箱子做。
  // 判据：**同一格**里每个候选原料的"基底名"都和目标一样（chest 那一格全是 *_chest）
  // —— 那就是把目标本身换个形态，不是获得它的途径。
  const baseName = (x) => String(x).split(':').pop().replace(/^.*_/, '');
  const targetBase = baseName(id);
  const isRevert = (r) => (r.shape
    ? Object.values(r.shape.key)
    : r.in.map(s => s.alts))
    .some(alts => {
      const ids = slotIds(alts);
      return ids.length > 0 && ids.every(x => baseName(x) === targetBase);
    });
  const score = (r) => {
    const ns = needs(r);
    const short = ns.filter(s => !s.ok);
    // 原版优先（recipeRank）是第一位的：整合包里的"转换配方"缺料同样少，但绝不该被推荐 —— 它只是
    // 换个形态。用 isRevert 把它整个踢出候选。
    return {
      ns, revert: isRevert(r),
      rank: [k.recipeRank(r), short.length, short.reduce((n, s) => n + (s.need - s.have), 0),
        short.filter(s => s.sample && !raw(s.sample)).length],
    };
  };
  const scored = R.map(r => ({ r, ...score(r) }));
  // 有"真做法"就只在真做法里排；全都是拆回来的（罕见）才退回全量。
  const real = scored.filter(s => !s.revert);
  const pool = real.length ? real : scored;
  const ranked = pool.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
    return 0;
  });
  const best = ranked[0];
  return { best, rest: ranked.slice(1), needs: best.ns, all: scored };
}

function shortfallText (k, KB, id, needs) {
  const short = needs.filter(s => !s.ok);
  if (!short.length) return null;
  const parts = short.map(s => {
    const name = s.sample ? k.label(s.sample) : '原料';
    const bare = name.includes('(') ? name.slice(0, name.indexOf('(')) : name;
    return `${bare} ${s.need}（有 ${s.have}）`;
  });
  return `做${k.label(id)}还缺：${parts.join('、')}`;
}

/**
 * 缺料时**先从精妙背包补料**再把料算全（2026-09-29 主人）。
 *
 * 实机：`做木棍还缺竹子 2（有 0）` —— 竹子其实在精妙背包里。以前 `craft2` 的 `have`
 * 只数 `invCounts(bot)`（身上 36 格），背包里的原料一律当"没有"。
 *
 * 判据全部复用现成的，不另写名单：
 *   · 要不要去拿：`countInBackpackSeen(state, id)` —— 快照里有就值得开一次背包；
 *     返回 `null` = **读不到**（从没开过 / 没背背包），这时不假装"没有"，也不硬开。
 *   · 怎么拿：`ensureCarried(bot, state, id, need)`（唯一入口，"有/没有/读不到"三分开）。
 *
 * 只对 `cands` 里**任何一条配方会用到的原料**去补（避免为一个不相干的配方白开背包）。
 * 有东西真被搬上来 → 返回 true，调用方重算 `have`。
 *
 * @returns {Promise<boolean>} 是否往身上补进了东西（没补/读不到都返回 false）
 */
async function topUpFromBackpack (bot, state, KB, cands, have, carry) {
  if (!state || typeof carry !== 'function') return false;
  // 候选配方的全部原料 id（含标签展开）
  const wanted = new Set();
  for (const r of cands) {
    const slotAlts = r.shape ? Object.values(r.shape.key) : r.in.map(s => s.alts);
    for (const alts of slotAlts) for (const a of alts) {
      if (a.item) wanted.add(a.item);
      else for (const x of KB.tags.get(`item:${a.tag}`) || []) wanted.add(x);
    }
  }
  let moved = false;
  for (const id of wanted) {
    if ((have.get(id) || 0) > 0) continue;                 // 身上已经有这种料，不用去背包拿
    if (countInBackpackSeen(state, id, null) == null) continue;   // 背包读不到 → 不猜、不硬开
    try {
      const got = await carry(bot, state, id, 1);
      if (got && got.got > 0) moved = true;
    } catch (_) { /* 拿不到就照旧按"身上没有"算，不阻断合成 */ }
  }
  return moved;
}

/**
 * 附近没有工作台 / 熔炉，但**身上或背包里有** → 自己放一个在旁边用，用完**挖回来**。
 *
 * 实机（2026-09-29）：`craft(iron_shovel) ✗ 材料是够的，但要工作台，但 16 格内没有（背包里有的话先 place 放下）`
 * —— 这句话是在让 mind 自己去放，mind 没做。项目原则是"身体能做的别推给意识层"，所以这里直接做完。
 *
 * 流程：① 身上没有就从精妙背包拿一件（`ensureCarried`，唯一入口）；
 *      ② 找一处**能站、能贴面**的空位放下（站位判据走 `place.js`，不另写）；③ 交给调用方用；
 *      ④ `finally` 里**挖回来**（`collectDrops` 捡），不给玩家留一地工作台。
 *
 * ⚠️ 放不下 / 收不回都**如实报**（返回值带 `placed` / `recovered` / `why`），不假装成功；
 *    但**不抛** —— 放不下就退回原来的行为（照旧报"要工作台"），别因为放不下把合成整个弄崩。
 *
 * @param {object} bot
 * @param {object} state
 * @param {string} itemName  要放的方块（`minecraft:crafting_table` / `minecraft:furnace`）
 * @param {Function} fn      `(block) => Promise<any>`：趁工作台还在时做的事
 * @returns {Promise<{ok:boolean, placed:boolean, recovered:boolean|null, result?:any, why?:string, block?:object}>}
 */
async function withPlacedStation (bot, state, itemName, fn, carry = null) {
  const carryFn = typeof carry === 'function' ? carry : ensureCarried;
  const want = fullId(itemName);
  // ① 先看身上有没有；没有就去背包拿（读不到/都没有都只影响"能不能放"，不抛）
  let have = bot.inventory.items().find(i => fullId(i.name) === want);
  if (!have && state) {
    try {
      await carryFn(bot, state, want, 1);
      have = bot.inventory.items().find(i => fullId(i.name) === want);
    } catch (_) {}
  }
  if (!have) return { ok: false, placed: false, recovered: null, why: `身上和背包里都没有 ${k_labelStation(want)}` };
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }

  // ② 找一处能放的空位：脚下同层、旁边有实心可贴面（判据来自 place.js 的 evaluateFace/planPlacement）
  const block = await placeNearbySelf(bot, want);
  if (!block) return { ok: false, placed: false, recovered: null, why: `附近没有能放下 ${k_labelStation(want)} 的空位` };

  let result = null; let recovered = null;
  try {
    result = await fn(block);
  } finally {
    // ④ 用完挖回来（挖掉 + 把掉落物捡起来）。收不回如实记，不假装
    recovered = await recoverPlaced(bot, block);
  }
  return { ok: true, placed: true, recovered, result, block };
}

const k_labelStation = (id) => (id === 'minecraft:crafting_table' ? '工作台' : id === 'minecraft:furnace' ? '熔炉' : id);

/**
 * 在**自己身边**放一个方块：脚下同层的 6 个方向各试一次，要"空格 + 有实心邻居可贴"。
 * 站位/可替换判据复用 `place.js`（`isStandable` 那条线），这里不重写几何。
 */
async function placeNearbySelf (bot, want) {
  const it = bot.inventory.items().find(i => fullId(i.name) === want);
  if (!it) return null;
  let placed = null;
  try {
    if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand');
    const f = bot.entity.position.floored();
    // 先试脚下往上、再试四周同一层（和 placeTorchHere 同一套候选顺序，够稳）
    const cands = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    for (const [dx, dy, dz] of cands) {
      const pos = f.offset(dx, dy, dz);
      const cur = bot.blockAt(pos);
      if (cur && cur.boundingBox === 'block') continue;       // 那格被占了
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below || below.boundingBox !== 'block') continue;  // 得有个实心底
      // 站在要放的那格里会把自己卡住：脚下那格跳过（第 0 个候选）—— 让人先站开
      const same = pos.x === f.x && pos.z === f.z && (pos.y === f.y || pos.y === f.y + 1);
      if (same) continue;
      try {
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(below, new Vec3(0, 1, 0));
      } catch (_) { continue; }
      await sleep(250);
      const now = bot.blockAt(pos);
      if (now && fullId(now.name) === want) { placed = now; break; }
    }
  } catch (_) {}
  return placed;
}

/** 把刚放下的工作台/熔炉挖回来并捡起。返回 null = 读不到；true/false = 收回了没有 */
async function recoverPlaced (bot, block) {
  try {
    if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }
    const at = block.position;
    const b = bot.blockAt(at);
    if (!b || fullId(b.name) !== fullId(block.name)) return null;   // 已经不在了（读不到 / 被拿走）
    await bot.dig(b, true);
    await sleep(300);
    if (bot.collectBlock?.collect) { try { await bot.collectBlock.collect(bot.blockAt(at) || b); } catch (_) {} }
    const gone = !bot.blockAt(at) || bot.blockAt(at)?.boundingBox === 'empty';
    const backInInv = bot.inventory.items().some(i => fullId(i.name) === fullId(block.name));
    return !!(gone && backInInv) || gone;
  } catch (_) { return false; }
}

async function craft2 (bot, { itemName, count = 1 } = {}, withTimeout, state = null, ensureCarriedFn = null) {
  const carry = typeof ensureCarriedFn === 'function' ? ensureCarriedFn : ensureCarried;
  const k = K(); const KB = k.load();
  const id = k.resolve(itemName, 1)[0];
  if (!id) throw new Error(`不认识 ${itemName}`);
  const reg = bot.registry;
  const outItem = reg.itemsByName[botName(id)];
  if (!outItem) throw new Error(`${id} 不在她的物品注册表里（模组物品注入失败？看 GET /item）`);

  const cands = (KB.byOutput.get(id) || []).map(i => KB.recipes[i])
    .filter(r => r.type === 'minecraft:crafting_shaped' || r.type === 'minecraft:crafting_shapeless')
    .sort((a, b) => k.recipeRank(a) - k.recipeRank(b));
  if (!cands.length) throw new Error(`${k.label(id)} 没有工作台/背包配方（${(KB.byOutput.get(id) || []).length ? '要用别的工作站做，查 recipe' : '不能合成'}）`);

  let table = nearestBlock(bot, ['crafting_table']);
  let have = invCounts(bot);
  // 原料可能在精妙背包里（实机"做木棍还缺竹子 2（有 0）"）—— 先补一次再算料
  const topped = await topUpFromBackpack(bot, state, KB, cands, have, carry);
  if (topped) have = invCounts(bot);
  const inTag = (tag, x) => KB.tags.get(`item:${tag}`)?.has(x);
  const tried = [];
  // 报告缺料时的"另两处"证据：背包快照里有没有、能不能读到（AGENTS.md §5-1 分开报）
  const packNoteFor = (list) => {
    if (!state) return '';
    const inPack = []; const unknown = [];
    for (const raw of list) {
      const pid = resolveCarryId ? resolveCarryId(raw) : fullId(raw);
      const n = countInBackpackSeen(state, pid, null);
      if (n == null) unknown.push(k.label(pid));
      else if (n > 0) inPack.push(`${k.label(pid)}×${n}`);
    }
    const parts = [];
    if (inPack.length) parts.push(`背包里有 ${inPack.join('、')}（没拿上来）`);
    if (unknown.length) parts.push(`${unknown.join('、')} 在背包里有没有读不到`);
    return parts.length ? `；${parts.join('；')}` : '';
  };

  for (const r of cands) {
    const per = r.out.find(o => o.item === id)?.count || 1;
    const requestedTimes = Math.ceil(count / per);
    // 默认给原料留一份。模型偶尔会把背包里查到的数量直接填进 count，
    // 这会把“做一点南瓜食物”误变成“把 11 个南瓜全切成种子”。
    // 玩家明确要做的数量仍尽量满足；只有会清空某种原料时才收敛到安全数量。
    let times = requestedTimes;
    if (requestedTimes > 1) {
      let safeTimes = requestedTimes;
      const ingredientNeeds = r.shape
        ? Object.entries(r.shape.key).map(([ch, alts]) => ({
          alts,
          perCraft: r.shape.pattern.join('').split(ch).length - 1,
        }))
        : r.in.map(s => ({ alts: s.alts, perCraft: s.count }));
      for (const ing of ingredientNeeds) {
        const ids = ing.alts.flatMap(a => a.item ? [a.item] : [...(KB.tags.get(`item:${a.tag}`) || [])]);
        const available = [...new Set(ids)].reduce((n, x) => n + (have.get(x) || 0), 0);
        const maxKeepingOne = available > ing.perCraft
          ? Math.floor((available - 1) / ing.perCraft)
          : Math.floor(available / ing.perCraft);
        safeTimes = Math.min(safeTimes, maxKeepingOne);
      }
      if (safeTimes > 0) times = safeTimes;
    }
    if (times < requestedTimes) console.log(`[craft2] 安全保留原料：${id} ${requestedTimes}→${times} 次，至少留一份材料`);
    // 每种原料挑一个背包里够数的具体物品
    const left = new Map(have);
    const pickFor = (alts, need) => {
      for (const a of alts) {
        const pool = a.item ? [a.item] : [...left.keys()].filter(x => inTag(a.tag, x));
        const got = pool.find(x => (left.get(x) || 0) >= need);
        if (got) { left.set(got, left.get(got) - need); return got; }
      }
      return null;
    };
    let enumItem = null; let missing = [];
    if (r.shape) {
      const chosen = {};
      for (const [ch, alts] of Object.entries(r.shape.key)) {
        const n = r.shape.pattern.join('').split(ch).length - 1;
        const pick = pickFor(alts, n * times);
        if (!pick) { missing.push(alts.map(a => a.item || `#${a.tag}`)[0]); continue; }
        chosen[ch] = pick;
      }
      if (!missing.length) {
        const width = Math.max(...r.shape.pattern.map(p => p.length));
        const inShape = r.shape.pattern.map(row => [...row.padEnd(width)].map(c => (c === ' ' ? null : reg.itemsByName[botName(chosen[c])]?.id ?? -1)));
        if (inShape.flat().includes(-1)) { tried.push(`${r.id}: 原料不在注册表里`); continue; }
        enumItem = { result: { id: outItem.id, count: per }, inShape };
      }
    } else {
      const ings = [];
      for (const s of r.in) {
        const pick = pickFor(s.alts, s.count * times);
        if (!pick) { missing.push(s.alts.map(a => a.item || `#${a.tag}`)[0]); continue; }
        for (let i = 0; i < s.count; i++) ings.push(reg.itemsByName[botName(pick)]?.id ?? -1);
      }
      if (!missing.length) {
        if (ings.includes(-1)) { tried.push(`${r.id}: 原料不在注册表里`); continue; }
        enumItem = { result: { id: outItem.id, count: per }, ingredients: ings };
      }
    }
    if (!enumItem) { tried.push(`缺 ${missing.map(m => k.label(m)).join('、')}`); continue; }

    const Recipe = require('prismarine-recipe')(reg).Recipe;
    const recipe = new Recipe(enumItem);
    if (recipe.requiresTable && !table) {
      table = await findAndApproach(bot, ['crafting_table']);
    }
    // 附近没有工作台、但身上/背包里有 → **自己放一个用完再收回**（2026-09-29 主人：
    // 以前这里只说"背包里有的话先 place 放下"，把这一步甩给 mind；mind 没做）。
    if (recipe.requiresTable && !table) {
      const st = await withPlacedStation(bot, state, 'minecraft:crafting_table', async (blk) => {
        const before2 = invCounts(bot);
        await withTimeout(craftByHand(bot, enumItem, times, blk), 15000 + times * 5000);
        await sleep(300);
        return delta(before2, invCounts(bot));
      }, carry);
      if (!st.ok) {
        tried.push(`要工作台，但 16 格内没有，也没放成（${st.why || '原因不明'}）`);
        continue;
      }
      const d2 = st.result || {};
      const made2 = d2.gained?.[id] || 0;
      if (made2 > 0) return { crafted: id, made: made2, recipe: r.id, consumed: d2.lost || {}, usedTable: true, tableRecovered: st.recovered };
      tried.push(`用自己放的工作台摆好了但没拿到`);
      continue;
    }
    const before = invCounts(bot);
    try {
      await withTimeout(craftByHand(bot, enumItem, times, recipe.requiresTable ? table : null), 15000 + times * 5000);
    } catch (e) { await returnGrid(bot); throw e; }
    await sleep(300);
    const d = delta(before, invCounts(bot));
    const made = d.gained[id] || 0;
    if (!made) {
      await returnGrid(bot);
      // 服务器没按这条配方给东西：记下实际发生了什么（多了/少了啥），换下一条配方试（2026-09-27 实测木棍这样失败过，原因待查）
      const what = `多了 ${JSON.stringify(d.gained)}，少了 ${JSON.stringify(d.lost)}`;
      tried.push(`按 ${r.id} 摆好了但没拿到（${what}）`);
      console.log(`[craft2] ${r.id} 没拿到 ${id}：${what}；窗口=${bot.currentWindow?.type || '背包'}`);
      if (Object.keys(d.lost).length) break;   // 原料已经被吃掉了还没拿到东西：别再接着试
      continue;
    }
    return { crafted: id, made, recipe: r.id, consumed: d.lost, usedTable: !!recipe.requiresTable };
  }
  // 全试完了还是没做成：不再把每条配方的缺料混在一句里（那样她抓不住重点）。
  // 挑**最容易做的一条**说清楚缺什么，其余最多提一句"还有 N 种做法"。
  const { best, rest, needs } = rankRecipesFor(k, KB, have, id, cands, Math.max(1, Math.ceil(count / ((cands[0].out.find(o => o.item === id)?.count) || 1))));
  const shortText = shortfallText(k, KB, id, needs);
  const extra = rest.length ? `（另外还有 ${rest.length} 种做法）` : '';
  if (shortText) {
    // 缺料说明里**分开写**"身上有 / 背包里有 / 都没有 / 背包读不到"（AGENTS.md §5-1）。
    // needs 里的 have 是身上的；背包那两份另查快照。
    const shortRaw = needs.filter(s => !s.ok).map(s => s.sample).filter(Boolean);
    throw new Error(`${shortText}${packNoteFor(shortRaw)}${extra}`);
  }
  // 原料都够却没做成 = 不是"缺料"，是尝试过程出错（要工作台没找到 / 摆好了服务器没给）
  const why = [...new Set(tried)].slice(0, 2).join('；');
  throw new Error(`现在做不了 ${k.label(id)}：材料是够的${why ? `，但${why}` : '，摆了没做成'}${extra}`);
}

function pickFuel (bot, avoid, need) {
  const items = bot.inventory.items().filter(i => fullId(i.name) !== avoid)
    .map(i => ({ i, v: fuelValue(bot, i) })).filter(x => x.v > 0);
  if (!items.length) return null;
  const enough = items.filter(x => x.v * x.i.count >= need).sort((a, b) => a.v - b.v)[0];
  return (enough || items.sort((a, b) => b.v * b.i.count - a.v * a.i.count)[0]);
}

/**
 * 一个燃料能烧几个东西（原版燃烧值 / 200 tick）。烟熏炉、高炉快一倍但燃料也烧快一倍，所以每件耗的燃料一样。
 * 上一轮的教训：放了 2 根木棍（总共只够烧 1 个）就去烧 6 个鸡蛋，5 个被丢在炉子里，还报了成功。
 */
function fuelValue (bot, item) {
  const n = item.name;
  const table = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100, dried_kelp_block: 20, stick: 0.5, bamboo: 0.25 };
  if (table[n] != null) return table[n];
  const t = K().load().itemTags.get(fullId(n));
  if (t && (t.has('minecraft:logs') || t.has('minecraft:planks') || t.has('minecraft:logs_that_burn'))) return 1.5;
  if (t && (t.has('minecraft:wooden_slabs'))) return 0.75;
  return 0;
}

async function smelt (bot, { itemName, count = 1, fuel } = {}, state = null) {
  const k = K(); const KB = k.load();
  const input = findItem(bot, itemName);
  if (!input) throw new Error(`背包里没有 ${itemName}`);
  // 按原料找配方，决定用哪种炉子
  const idx = new Set(KB.byInput.get(fullId(input.name)) || []);
  for (const t of KB.itemTags.get(fullId(input.name)) || []) for (const i of KB.byInput.get(`#${t}`) || []) idx.add(i);
  const types = new Set([...idx].map(i => KB.recipes[i].type));
  const order = [['minecraft:smelting', 'furnace'], ['minecraft:smoking', 'smoker'], ['minecraft:blasting', 'blast_furnace']];
  if (!types.size || ![...types].some(t => order.some(([ty]) => ty === t))) throw new Error(`${k.label(fullId(input.name))} 不能用熔炉类烧`);
  // 16 格内所有能烧它的炉子，按距离排；走不到就换下一台（楼上那台过不去，不代表楼下那台也不行）
  const usable = order.filter(([t]) => types.has(t));
  const cands = [];
  for (const [type, b] of usable) {
    const id = bot.registry.blocksByName[b]?.id;
    if (id == null) continue;
    for (const p of bot.findBlocks({ matching: id, maxDistance: 16, count: 4 })) {
      const blk = bot.blockAt(p);
      if (blk) cands.push({ blk, type, d: eyeDist(bot, blk) });
    }
  }
  // 炉体：不管是现成的还是自己放的，烧的动作只写一份。
  const doSmelt = async (furnaceBlock, usedType) => {
    let n = Math.min(count, input.count);
    const before = invCounts(bot);
    const furnace = await bot.openFurnace(furnaceBlock);
    let fuelNote = null;
    try {
      // 炉子里原本有燃料就算上它（按剩余火候估不准，保守当作只够 1 个）
      const existing = furnace.fuelItem() ? fuelValue(bot, furnace.fuelItem()) * furnace.fuelItem().count : 0;
      const need = Math.max(0, n - existing);
      if (need > 0) {
        // 燃料可能在精妙背包里（N-9：日志里 `没有燃料` ×5）—— 先把它当"随身物品"补齐再判"没有"。
        // 判据用 fuelValue（K() 的 itemTags：logs / planks / logs_that_burn …），
        // **不自己重写正则** —— 以前那条 `/(^|:)(...|_log|_planks|...)$/` 是完整匹配项，
        // `minecraft:oak_log` / `minecraft:oak_planks` 一律匹配不上，背包里的木头燃料被误判成"没有"。
        if (state) await ensureCarried(bot, state, (it) => fuelValue(bot, it) > 0, Math.max(1, Math.ceil(need / 8)));
        const f = fuel ? (() => { const it = findItem(bot, fuel); return it ? { i: it, v: fuelValue(bot, it) || 1 } : null; })()
          : pickFuel(bot, fullId(input.name), need);
        if (!f && !existing) throw new Error('没有燃料（煤、木炭、原木、木板、木棍都行）');
        if (f) {
          const k2 = Math.min(f.i.count, Math.ceil(need / f.v));
          await furnace.putFuel(f.i.type, null, k2);
          const canDo = Math.floor(existing + k2 * f.v);
          if (canDo < n) { fuelNote = `燃料只够烧 ${canDo} 个（${f.i.name}×${k2}）`; n = Math.max(1, canDo); }
        }
      }
      await furnace.putInput(input.type, null, n);
      // 一个 10 秒（烟熏炉/高炉 5 秒）。等够了或者超时就收
      const each = usedType === 'minecraft:smelting' ? 10000 : 5000;
      const deadline = Date.now() + n * each + 3000;
      while (Date.now() < deadline) {
        await sleep(1000);
        if ((furnace.outputItem()?.count || 0) >= n) break;
        if (!furnace.inputItem() && !furnace.outputItem()) break;
      }
      if (furnace.outputItem()) await furnace.takeOutput();
      // 没烧完的原料拿回来 —— 不能把玩家的东西丢在炉子里就走
      if (furnace.inputItem()) { try { await furnace.takeInput(); } catch (_) {} }
    } finally {
      furnace.close();
    }
    await sleep(600);
    const d = delta(before, invCounts(bot));
    // 同一原料可能有好几条互相冲突的配方（本包里鸡蛋能烤出三种"煎蛋"），服务器用哪条它说了算 ——
    // 所以按"实际多了什么"算，不按我们预测的产物算
    const got = Object.values(d.gained).reduce((a, v) => a + v, 0);
    const leftIn = (before.get(fullId(input.name)) || 0) - (invCounts(bot).get(fullId(input.name)) || 0) - got;
    const out = { smelted: fullId(input.name), in: furnaceBlock.name, got: d.gained, gotCount: got, asked: count, fuelNote };
    if (leftIn > 0) out.warning = `还有 ${leftIn} 个原料留在炉子里没拿回来（${furnaceBlock.position.x},${furnaceBlock.position.y},${furnaceBlock.position.z}）`;
    if (got < count) out.note = `要烧 ${count} 个，实际拿到 ${got} 个${fuelNote ? `：${fuelNote}` : ''}`;
    return out;
  };

  // 16 格内有现成的 → 走过去用它（原行为）。
  if (cands.length) {
    cands.sort((a, b2) => a.d - b2.d);
    const why = [];
    let near = null;
    for (const c of cands) {
      try { await approach(bot, c.blk); near = c; break; } catch (e) { why.push(e.message); }
    }
    if (near) return await doSmelt(near.blk, near.type);
    // 有炉子但都走不过去 → 别急着放弃：自己放一个（2026-09-29 问题 3）
    const placed = await withPlacedStation(bot, state, 'minecraft:furnace', (blk) => doSmelt(blk, 'minecraft:smelting'), ensureCarried);
    if (placed.ok) return placed.result;
    throw new Error(`附近的炉子都走不过去（${why.slice(0, 3).join('；')}），自己放一个也不行：${placed.why || '不知道怎么放'}`);
  }
  // 16 格内一个都没有 → 身上/背包里有熔炉就自己放一个用，用完挖回来（2026-09-29 问题 3）
  const placed = await withPlacedStation(bot, state, 'minecraft:furnace', (blk) => doSmelt(blk, 'minecraft:smelting'), ensureCarried);
  if (placed.ok) return placed.result;
  throw new Error(`16 格内没有能烧它的炉子（需要：${usable.map(([, b]) => b).join(' / ')}），自己放一个也不行：${placed.why || '不知道怎么放'}`);
}

/**
 * 以前的"给"= 朝玩家方向丢出去就算完。结果：玩家没接到，2 秒后她自己又捡回来，
 * 嘴上却说"给你尝尝"（实测）。现在：停在玩家 1～2 格外 → 对准胸口丢 → 盯着这个掉落物被谁捡走。
 */
async function give (bot, { itemName, count, player } = {}) {
  const it = findItem(bot, itemName);
  if (!it) throw new Error(`背包里没有 ${itemName}`);
  const target = bot.players[player]?.entity;
  if (!target) throw new Error(`看不见 ${player}（不在视野内）`);
  const { goals } = require('mineflayer-pathfinder');
  const safeRange = { min: 1.15, max: 2.15 };
  const moveToThrowRange = async () => {
    const t = target.position;
    const dx = bot.entity.position.x - t.x; const dz = bot.entity.position.z - t.z;
    const len = Math.hypot(dx, dz) || 1;
    // 目标点在玩家外侧约 1.6 格，避免 GoalNear 在玩家脚下直接判定“已到”。
    const anchor = { x: t.x + dx / len * 1.6, y: t.y, z: t.z + dz / len * 1.6 };
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(anchor.x, anchor.y, anchor.z, 0.35)),
      sleep(15000).then(() => { throw new Error('超时'); }),
    ]);
  };
  let distance = bot.entity.position.distanceTo(target.position);
  if (distance < safeRange.min || distance > safeRange.max) {
    try {
      await moveToThrowRange();
    } catch (e) {
      bot.pathfinder.setGoal(null);
      distance = bot.entity.position.distanceTo(target.position);
      if (distance < 1.0 || distance > 3.0) throw new Error(`走不到 ${player} 身边的投掷位置：${e.message}`);
    }
  }
  distance = bot.entity.position.distanceTo(target.position);
  if (distance < 1.0) throw new Error(`离 ${player} 太近（${distance.toFixed(1)} 格），不贴着人扔`);
  await bot.lookAt(target.position.offset(0, 1.1, 0), true);
  // 寻路期间背包可能变化，重新取栈，避免对过期 Item 调 toss。
  const fresh = findItem(bot, itemName);
  if (!fresh) throw new Error(`走到投掷位置后背包里没有 ${itemName}`);
  const n = count ? Math.min(count, fresh.count) : fresh.count;
  const wantId = fullId(fresh.name);
  const beforeCount = fresh.count;

  // 丢出去的掉落物是一个新实体；记下它，再看 playerCollect 是谁捡的
  let dropped = null; let collector = null;
  const onSpawn = (e) => {
    if (!dropped && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 3) dropped = e;
  };
  const onCollect = (who, what) => { if (dropped && what.id === dropped.id) collector = who; };
  bot.on('entitySpawn', onSpawn);
  bot.on('playerCollect', onCollect);
  try {
    if (n >= fresh.count) await bot.tossStack(fresh); else await bot.toss(fresh.type, null, n);
    for (let i = 0; i < 30 && !collector; i++) await sleep(200);   // 最多等 6 秒
  } finally {
    bot.removeListener('entitySpawn', onSpawn);
    bot.removeListener('playerCollect', onCollect);
  }
  const after = findItem(bot, itemName);
  if ((after?.count || 0) >= beforeCount) {
    const e = new Error(`已经站在 ${distance.toFixed(1)} 格处，但物品没有离开背包，投掷未生效`);
    e.data = { given: false, throwFailed: true }; throw e;
  }
  const by = collector === target ? 'player' : collector === bot.entity ? 'self' : collector ? 'other' : null;
  if (by === 'player') return { given: wantId, count: n, to: player, confirmed: true };
  if (by === 'self') {
    const e = new Error(`丢给 ${player} 了，但他没接住，她自己又捡回来了`); e.data = { given: false }; throw e;
  }
  if (by === 'other') {
    const e = new Error(`丢出去了，但被别人/别的东西捡走了`); e.data = { given: false }; throw e;
  }
  return { given: wantId, count: n, to: player, confirmed: false, note: `丢在 ${player} 脚边了，还没看到他捡起来（${dropped ? '东西在地上' : '没看到掉落物'}）` };
}

/**
 * 吃东西。不给 itemName 时自己挑最好的食物。
 *
 * 2026-09-29 主人："吃东西、合成、打架换装备时不看背包"。实机日志
 * `hungry 饿了（饥饿 6/20），身上没有吃的` —— 吃的其实塞在精妙背包里（她自己说"背包塞了 82 样"）。
 *
 * 所以：**身上没有吃的 → 先从背包拿一份到身上，再吃**。判据复用现成的两条，不另写：
 *   · 是不是吃的 = `foodScore(it) > 0`（`util.js`，全项目唯一一份）；
 *   · 从哪拿 = `ensureCarried(bot, state, predicate)`（`containers.js`，唯一入口，"有/没有/读不到"三分开）。
 *
 * `state` 可选：老调用点（bridge 的 `POST /eat` 现在会传）不传时退回旧行为（只看身上）。
 * 结果里带 `from`（`'carried'` / `'backpack'`），说清这份吃的从哪来 —— mind 要能分辨
 * "身上就有"和"刚从背包摸出来的"。
 *
 * `ensureCarriedFn` 是给自测用的注入点（照 `tool-choice.js` 的 `ensureDigTool` 那套，
 * 避免自测去改 8 个文件共享的 `__ns`）；生产调用不传，走模块内的转发壳（同一份真身）。
 */
async function eat (bot, { itemName } = {}, state = null, ensureCarriedFn = null) {
  const carry = typeof ensureCarriedFn === 'function' ? ensureCarriedFn : ensureCarried;
  let item;
  if (itemName) {
    item = findItem(bot, itemName);
    if (!item) {
      // 点名要吃的东西也可能在背包里（"背包里有面包、身上没有"）
      if (state) {
        const got = await carry(bot, state, itemName, 1);
        if (got.source === 'unknown') throw new Error(`身上没有 ${itemName}，${got.why || '背包也读不到'}`);
        item = findItem(bot, itemName);
      }
      if (!item) throw new Error(`背包里没有 ${itemName}`);
    }
  } else {
    // 身上有没有吃的：没有就去背包摸一份出来（背包里也没有就算了，如实报）
    let from = 'carried';
    item = bot.inventory.items().map(i => [i, foodScore(i)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!item && state) {
      // predicate 版本：任意一种吃的都行，拿一份，再按 foodScore 挑最好的那件
      const got = await carry(bot, state, (it) => foodScore(it) > 0, 1);
      if (got.source === 'backpack') from = 'backpack';
      // 读不到就说读不到（不说"没有"），且原因按 got.why 原样带给上层
      if (!got.got && got.source === 'unknown') return { ate: false, reason: `身上没有吃的；${got.why || '背包读不到'}`, backpackUnknown: true };
      item = bot.inventory.items().map(i => [i, foodScore(i)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    if (!item) return { ate: false, reason: '身上和背包里都没有能吃的东西' };
    item.__eatFrom = from;
  }
  const from = item.__eatFrom || 'carried';
  const foodBefore = bot.food;
  if (foodBefore >= 20) return { ate: false, reason: '已经吃饱了（饥饿值 20）', item: item.name };
  const before = invCounts(bot);
  await bot.equip(item, 'hand');
  let err = null;
  try {
    await bot.consume();
  } catch (e) {
    err = e.message;
  }
  await sleep(300);
  const d = delta(before, invCounts(bot));
  const ate = (d.lost[fullId(item.name)] || 0) > 0 || bot.food > foodBefore;
  if (!ate) {
    const e = new Error(`没吃下去：${item.name}${err ? `（${err}）` : ''}。可能它不是食物，或者要用别的方式吃（比如放下再右键）`);
    e.data = { item: item.name, foodBefore, foodAfter: bot.food };
    throw e;
  }
  return { ate: true, item: item.name, foodBefore, foodAfter: bot.food, consumed: d.lost, from };
}

async function use (bot, state, { itemName, target = 'air', x, y, z, entity, hand = 'hand', holdMs = 300 } = {}) {
  if (itemName) {
    const it = findItem(bot, itemName);
    if (!it) throw new Error(`背包里没有 ${itemName}`);
    await bot.equip(it, hand === 'off-hand' ? 'off-hand' : 'hand');
  }
  const inv0 = invCounts(bot); const eq0 = equipment(bot); const win0 = bot.currentWindow?.id ?? null;
  const offHand = hand === 'off-hand';

  if (target === 'block') {
    if ([x, y, z].some(v => v == null)) throw new Error('target=block 要给 x y z');
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) throw new Error(`(${x},${y},${z}) 那里的区块没加载`);
    // "先走到跟前、视线要通"是同一个判据（canUseFrom），不在这里另写一份距离判断
    await approach(bot, block);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(block);
  } else if (target === 'entity') {
    const want = String(entity || '').toLowerCase();
    const e = Object.values(bot.entities)
      .filter(en => en !== bot.entity && en.position.distanceTo(bot.entity.position) < 4.5)
      .filter(en => !want || [en.name, en.username, en.displayName].some(v => String(v || '').toLowerCase().includes(want)))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!e) throw new Error(`4.5 格内没有${want ? ` ${want}` : '可以右键的生物'}`);
    await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true);
    await bot.activateEntity(e);
  } else {
    bot.activateItem(offHand);
    await sleep(Math.min(Math.max(holdMs, 50), 5000));
    bot.deactivateItem();
  }
  await sleep(400);
  const out = {
    used: itemName || '(空手)', target,
    inventory: delta(inv0, invCounts(bot)),
    equipment: equipChanges(eq0, equipment(bot)),
  };
  if (bot.currentWindow && bot.currentWindow.id !== win0) out.windowOpened = summarizeWindow(bot, state);
  out.somethingHappened = Object.keys(out.inventory.gained).length + Object.keys(out.inventory.lost).length
    + Object.keys(out.equipment).length > 0 || !!out.windowOpened;
  return out;
}

async function wear (bot, state, { itemName } = {}) {
  const eq0 = equipment(bot); const inv0 = invCounts(bot);
  const it = findItem(bot, itemName);
  // ---- 已经穿在身上了：这是成功，不是"背包里没有"（2026-09-29 问题 3）----
  //
  // 实机证据：13:44:17 本能换上 `makit_better:resilient_nature_helmet`，
  // 13:44:25 mind `/wear` 同一件报"背包里没有" —— 因为**穿在头上就不在 `bot.inventory.items()` 里**，
  // `findItem` 只看背包，于是"穿上了"被读成"没有"。这违反项目原则 §5-1（"没有"和"读不到"要分开）。
  //
  // 判据：先算出"要穿的到底是哪个 id"（不依赖背包 —— 穿在身上时背包里本来就没有），
  // 再看它是不是已经在它该在的那个槽位上 → 直接返回成功 + `alreadyWorn: true`。
  // 这里**就返回**、不再往下走 equip/右键/Curios：重复穿同一件没有意义，还会和刚换上的本能打架
  // （主人 2026-09-29："本能刚换过的装备，mind 短时间内再换同一个槽位要有理由"）。
  // 谁负责护甲：**本能负责自动换护甲**（`armor.enabled`，判据在 equip-policy.js），
  // mind 只在玩家明确要求时才 /wear；这条 alreadyWorn 让 mind 不必重复动手。
  //
  // ⚠️ `wantId` 的取法必须和 `findItem`（util.js:27-37）一致：先按原样补全命名空间，
  //    认不出再交给知识库解析一次；两边都认不出才返回 null（那时连"该穿哪件"都不知道）。
  const wantId = (() => {
    const direct = fullId(itemName);
    if (it && fullId(it.name) === direct) return direct;
    if (it) return fullId(it.name);              // 背包里按模糊名找到的 → 用它的真名
    const resolved = K().resolve(itemName, 1)[0];
    return resolved ? fullId(resolved) : null;
  })();
  const dest = wantId ? slotByName(wantId) : null;
  if (dest && wantId && eq0[dest] === wantId) {
    return { worn: wantId, slot: dest, via: 'already-worn', alreadyWorn: true };
  }
  if (!it) throw new Error(`背包里没有 ${itemName}`);
  const tried = [];
  if (dest) {
    try {
      await bot.equip(it, dest);
      await sleep(300);
      if (equipment(bot)[dest] === fullId(it.name)) return { worn: it.name, slot: dest, via: 'equip' };
      tried.push(`equip→${dest} 服务器没认`);
    } catch (e) { tried.push(`equip→${dest}：${e.message}`); }
  }
  // 背包（精妙背包等）拿在手上右键是"打开它"，不是穿上 —— 直接放进饰品栏的背饰格
  const isPack = /backpack/.test(it.name);
  // 名字看不出槽位 / 直接放没成功：原版逻辑是"拿在手上右键就穿上"，模组盔甲和很多饰品（Curios）也支持
  const again = isPack ? null : findItem(bot, itemName);
  if (again) {
    await bot.equip(again, 'hand');
    bot.activateItem(false);
    await sleep(250);
    bot.deactivateItem();
    await sleep(400);
    const eq = equipChanges(eq0, equipment(bot));
    const d = delta(inv0, invCounts(bot));
    const moved = Object.entries(eq).find(([k, v]) => k !== 'hand' && v.to === fullId(it.name));
    if (moved) return { worn: it.name, slot: moved[0], via: 'right-click', tried };
    if ((d.lost[fullId(it.name)] || 0) > 0 && !Object.keys(d.gained).length) {
      return { worn: it.name, slot: '饰品栏（从背包消失了，多半进了 Curios 饰品栏）', via: 'right-click', tried };
    }
    tried.push('右键：没反应');
  }
  // 饰品（戒指、项链…）：打开 Curios 饰品栏放进去
  try {
    const r = await curiosEquip(bot, state, { itemName: it.name });
    return { worn: it.name, slot: `饰品栏第 ${r.slot} 格`, via: 'curios', tried };
  } catch (e) { tried.push(`饰品栏：${e.message}`); }
  const e = new Error(`穿不上 ${it.name}：${tried.join('；')}。可能要打开饰品栏（Curios）手动放`);
  e.data = { tried };
  throw e;
}

/**
 * 农夫乐事的厨锅：格子 0–5 放原料，6 是"正在做的菜"（不能放），7 放容器（碗），8 取成品。锅下面要有热源（炉灶/火）。
 * 按整合包里的真实配方挑一个背包里凑得齐的，一样一格放进去，等它煮好拿出来。
 */
async function cookInPot (bot, state, { itemName, count = 1 } = {}) {
  const k = K(); const KB = k.load();
  const id = k.resolve(itemName, 1)[0];
  if (!id) throw new Error(`不认识 ${itemName}`);
  const recs = (KB.byOutput.get(id) || []).map(i => KB.recipes[i]).filter(r => r.type === 'farmersdelight:cooking');
  if (!recs.length) throw new Error(`${k.label(id)} 不是厨锅做的（查 recipe 看它在哪做）`);
  const have = invCounts(bot);
  const inTag = (tag, x) => KB.tags.get(`item:${tag}`)?.has(x);
  let plan = null; const why = [];
  for (const r of recs) {
    const left = new Map(have); const picks = []; let container = null; let ok = true;
    for (const sl of r.in) {
      const cand = sl.alts.flatMap(a => (a.item ? [a.item] : [...left.keys()].filter(x => inTag(a.tag, x))));
      const got = cand.find(x => (left.get(x) || 0) >= count * sl.count);
      if (!got) { ok = false; why.push(`缺 ${sl.alts.map(a => k.label(a.item || '#' + a.tag)).slice(0, 2).join('或')}`); break; }
      left.set(got, left.get(got) - count * sl.count);
      if (sl.isContainer) container = got; else for (let n = 0; n < sl.count; n++) picks.push(got);
    }
    if (ok && picks.length <= 6) { plan = { r, picks, container }; break; }
  }
  if (!plan) throw new Error(`背包里凑不齐 ${k.label(id)} 的材料：${[...new Set(why)].slice(0, 3).join('；')}`);
  const pot = await findAndApproach(bot, ['farmersdelight:cooking_pot']);
  if (!pot) throw new Error('附近 16 格内没有厨锅');
  await containerOpen(bot, state, pot.position);
  const w = bot.currentWindow;
  try {
    // 锅里原来的原料先拿出来（别跟这道菜混了）
    for (let i = 0; i <= 5; i++) if (w.slots[i]) await click(bot, i, 0, 1);
    if (w.slots[8]) await click(bot, 8, 0, 1);
    const reg = bot.registry;
    const put = async (itemId, slot, n) => {
      const it = w.slots.slice(w.inventoryStart, w.inventoryEnd).find(x => x && fullId(x.name) === itemId);
      if (!it) throw new Error(`背包里没找到 ${itemId}`);
      await safeTransfer(bot, { window: w, itemType: it.type, metadata: null, count: n, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: slot, destEnd: slot + 1 });
    };
    for (let i = 0; i < plan.picks.length; i++) await put(plan.picks[i], i, count);
    if (plan.container) await put(plan.container, 7, count);
    void reg;
    const secs = ((plan.r.time || 200) / 20) * count + 10;
    let deadline = Date.now() + secs * 1000;
    let started = false; const t0 = Date.now();
    while (Date.now() < deadline) {
      await sleep(1000);
      if (w.slots[6] && !started) { started = true; deadline = Math.max(deadline, Date.now() + 60000); }   // 开始煮了：多给点时间
      if ((w.slots[8]?.count || 0) >= count) break;
      if (!started && Date.now() - t0 > 12000) break;   // 12 秒都没开始：多半没火
    }
    const out = w.slots[8];
    if (!out) {
      throw new Error(started ? '在煮了，但还没好（等等再来拿）' : '原料放进去了但没开始煮：锅下面可能没有热源（炉灶/火），或者少了碗');
    }
    const before = invCounts(bot);
    await click(bot, 8, 0, 1);
    await sleep(400);
    const d = delta(before, invCounts(bot));
    return { cooked: id, got: d.gained, recipe: plan.r.id, used: plan.picks, container: plan.container };
  } finally {
    noteSeen(bot, state, w, pot.position); bot.closeWindow(w);
  }
}

async function click (bot, slot, button = 0, mode = 0) {
  await bot.clickWindow(slot, button, mode);
  await sleep(40);
}

function withBackpackLock (fn) {
  const run = backpackChain.then(fn, fn);
  // 链尾吞掉异常，免得一次失败让后面全部 reject（真正的错误已由 run 的调用方拿到）
  backpackChain = run.then(() => {}, () => {});
  return run;
}

function clickIn (bot, w, slot, button = 0, mode = 0) {
  if (!w || bot.currentWindow?.id !== w.id) throw new Error('背包界面被别的动作换掉了，停止存取（避免点错窗口）');
  return click(bot, slot, button, mode);
}

async function settleCursor (bot, w) {
  if (!w?.selectedItem) return true;
  // 先找能合并的格，再找空格。刚拿起物品时原槽通常就是空的，因此不该需要丢到地上。
  const same = [];
  const empty = [];
  for (let i = 0; i < w.inventoryEnd; i++) {
    const it = w.slots[i];
    if (!it) empty.push(i);
    else if (stackIdentity(it) === stackIdentity(w.selectedItem) && it.count < (it.stackSize || 64)) same.push(i);
  }
  for (const i of [...same, ...empty]) {
    await click(bot, i);
    if (!w.selectedItem) return true;
  }
  return false;
}

async function safeTransfer (bot, options) {
  const w = options.window || bot.currentWindow || bot.inventory;
  try { return await bot.transfer(options); } catch (e) {
    let settled = false;
    try { settled = await settleCursor(bot, w); } catch (_) {}
    if (!settled && w?.selectedItem) e.message += '；而且鼠标游标仍有物品，窗口已保留供恢复';
    throw e;
  }
}

/**
 * 整理一段格子：先把同种的零散堆并起来，再按类别排好（食物 → 作物种子 → 矿物 → 木头 → 方块 → 工具装备 → 其他）。
 * 全靠点击交换，不用把东西拿出来。
 */
async function sortRange (bot, w, start, end) {
  let clicks = 0;
  // ① 合并：后面的零散堆往前面的同种堆上叠
  for (let i = start; i < end; i++) {
    const a = w.slots[i];
    if (!a || a.count >= a.stackSize) continue;
    for (let j = i + 1; j < end && w.slots[i] && w.slots[i].count < w.slots[i].stackSize; j++) {
      const b = w.slots[j];
      if (!b || stackIdentity(b) !== stackIdentity(a)) continue;
      await click(bot, j); await click(bot, i); clicks += 2;
      if (w.selectedItem) { await click(bot, j); clicks++; }
    }
  }
  // ② 排序：选择排序，每次把该在第 i 格的东西换过来
  const items = []; for (let i = start; i < end; i++) if (w.slots[i]) items.push(w.slots[i]);
  const order = items.map(it => ({ item: it, sig: stackIdentity(it), type: it.type, count: it.count })).sort((a, b) => compareSortedItems(bot, a.item, b.item));
  for (let n = 0; n < order.length; n++) {
    const i = start + n; const want = order[n];
    const cur = w.slots[i];
    if (cur && stackIdentity(cur) === want.sig && cur.count === want.count) continue;
    let j = -1;
    for (let k = i + 1; k < end; k++) { const x = w.slots[k]; if (x && stackIdentity(x) === want.sig && x.count === want.count) { j = k; break; } }
    if (j < 0) for (let k = i + 1; k < end; k++) { const x = w.slots[k]; if (x && stackIdentity(x) === want.sig) { j = k; break; } }
    if (j < 0) continue;
    await click(bot, j); await click(bot, i); clicks += 2;       // 拿起 j，放到 i（i 原来的东西到了手上）
    if (w.selectedItem) { await click(bot, j); clicks++; }       // 手上的放回 j
  }
  if (w.selectedItem && !(await settleCursor(bot, w))) throw new Error('整理后鼠标游标仍拿着物品；已停止，避免关窗时丢失');
  // ③ 往前压紧：中间有空格、后面还有东西的，搬到前面去
  for (let i = start; i < end; i++) {
    if (w.slots[i]) continue;
    let j = -1; for (let k = i + 1; k < end; k++) if (w.slots[k]) { j = k; break; }
    if (j < 0) break;
    await click(bot, j); await click(bot, i); clicks += 2;
    if (w.selectedItem) { await click(bot, j); clicks++; }
  }
  return { stacks: items.length, clicks };
}

async function sortContainer (bot) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的箱子（先 open_container）');
  const r = await sortRange(bot, w, 0, w.inventoryStart);
  await sleep(300);
  // 再过一遍：服务器同步慢的时候第一遍可能有几次交换没落实，第二遍已经排好的会直接跳过，很快
  const r2 = await sortRange(bot, w, 0, w.inventoryStart);
  r.clicks += r2.clicks;
  await sleep(200);
  const sum = {}; for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i]) { const c = categoryOf(bot, w.slots[i]); sum[c] = (sum[c] || 0) + 1; }
  const verification = auditSortedRange(bot, w, 0, w.inventoryStart);
  return { sorted: verification.sorted, ...r, byCategory: sum, verification };
}

async function sortInventory (bot) {
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }
  const w = bot.inventory;
  const r = await sortRange(bot, w, 9, 36);    // 主背包 27 格；快捷栏（36–44）不动
  await sleep(300);
  const verification = auditSortedRange(bot, w, 9, 36);
  return { sorted: verification.sorted, ...r, verification, note: '快捷栏没动' };
}

function snapshotContainer (bot, w) {
  const cats = {}; const items = []; const contents = [];
  for (let i = 0; i < w.inventoryStart; i++) {
    const it = w.slots[i];
    if (!it) continue;
    const c = categoryOf(bot, it);
    cats[c] = (cats[c] || 0) + 1; items.push(c);
    contents.push({ name: it.name, count: it.count, type: it.type, metadata: it.metadata, stackSize: it.stackSize || 64, identity: stackIdentity(it) });
  }
  return { cats, items, contents, used: items.length };
}

function applyBoxSnapshot (box, snap) {
  box.cats = snap.cats; box.items = snap.items; box.contents = snap.contents; box.used = snap.used;
}

const FOOD_RE = /(cooked|baked|roast|grilled|fried|_stew|_soup|salad|bread|pie|cake_slice|sandwich|burger|dumpling|rice|noodle|pasta|kebab|skewer|apple|carrot|potato|beetroot|melon_slice|berries|cookie|chicken|beef|porkchop|mutton|rabbit|cod|salmon|_meat|steak|bacon|ham|sausage|jerky|sushi|onigiri|pudding|jam|toast|pancake|waffle|donut|muffin|fruit|_juice)/;

const NOT_FOOD_RE = /(seeds|sapling|_block|crate|bag|_bucket$|spawn_egg|raw_|rotten|poisonous|spider_eye|pufferfish)/;

module.exports = { setHandsState, FOOD_RE, NOT_FOOD_RE, applyBoxSnapshot, approach, bind, click, clickIn, cookInPot, craft2, craftByHand, craftByRecipeBook, eat, findAndApproach, fuelValue, give, pickFuel, rankRecipesFor, returnGrid, safeTransfer, settleCursor, shortfallText, smelt, snapshotContainer, sortContainer, sortInventory, sortRange, topUpFromBackpack, use, wear, withBackpackLock, withPlacedStation };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 hands.js 的自测段里（同一个 (async () => {…})() 外套），
// 现在搬到这里 —— 断言一字未改，只是把原来「同一作用域里随手就能用」的 hands 函数
// 改成从 t.h（总表）取名（拆开后它们分在别的文件里）。
// 被汇总 require 时 register（登记不跑）；`node src/body/craft.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['[0d] 熔炼的燃料判据（R-fix3-1 未声明 state / R-fix3-5 燃料正则漏掉命名空间）', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { fuelValue, smelt } = t.h;
      console.log('\n[0d] 熔炼的燃料判据（R-fix3-1 未声明 state / R-fix3-5 燃料正则漏掉命名空间）');
      {
        // ---- ★ R-fix3-1：smelt 现在收 state 参数，缺燃料时读 state 不再 ReferenceError
        //      真跑一条 smelt，假 bot 没有背包原料 → 在开炉子之前就抛"没有"，但关键是**不抛 ReferenceError**
        const badBot = { inventory: { items: () => [], slots: [] }, registry: { blocksByName: {} } };
        let e1 = null;
        try { await smelt(badBot, { itemName: 'raw_iron', count: 1 }, null); } catch (e) { e1 = e; }
        check('★ smelt 收 state 参数，不会抛 ReferenceError: state is not defined',
          !/state is not defined/.test(e1 ? e1.message : ''), true);
        check('smelt 缺原料时给的是业务错（不是崩溃）', /背包里没有/.test(e1 ? e1.message : ''), true);

        // ---- ★ R-fix3-5：fuelValue 认带命名空间的原木/木板（以前 FUEL_RE 的 `_log`/`_planks` 是完整匹配项，匹配不上）
        const fb = { registry: { blocksByName: {} } };
        check('★ minecraft:oak_log 算燃料（以前不认）', fuelValue(fb, { name: 'minecraft:oak_log' }) > 0, true);
        check('★ minecraft:oak_planks 算燃料（以前不认）', fuelValue(fb, { name: 'minecraft:oak_planks' }) > 0, true);
        check('模组原木也算（regions_unexplored:dead_log）', fuelValue(fb, { name: 'regions_unexplored:dead_log' }) > 0, true);
        check('煤 / 木炭照旧', [fuelValue(fb, { name: 'coal' }) > 0, fuelValue(fb, { name: 'charcoal' }) > 0], [true, true]);
        check('石头不算燃料', fuelValue(fb, { name: 'minecraft:stone' }), 0);
      }
  }],
  ['[0e] 用方块前先走到跟前（任务书 fix7：4 格内 + 视线通 才原地用）', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { approach, canUseFrom } = t.h;
      console.log('\n[0e] 用方块前先走到跟前（任务书 fix7：4 格内 + 视线通 才原地用）');
      {
        // ---- 纯函数 canUseFrom（判据只这一份）：3 格远视线通 → 用；3 格远中间挡着 → 不用；5 格远 → 不用；读不到 → 保守不用
        check('3 格远、视线通 → 原地可用', canUseFrom(3, true).use, true);
        check('★ 3 格远、中间隔着一堵墙（los=false）→ 不可用', canUseFrom(3, false).use, false);
        check('★ 视线挡着时说"挡着"', /挡/.test(canUseFrom(3, false).why), true);
        check('★ 贴在身边（≤2 格，床在脚下）→ 直接用，不看视线', canUseFrom(1.2, null).use, true);
        check('★ 读不到视线（null）→ 保守当挡着（先走过去）', canUseFrom(3, null).use, false);
        check('读不到时说"读不到"（不说成挡住）', /读不到/.test(canUseFrom(3, null).why), true);
        check('★ 5 格远、视线通 → 不可用（超 4 格）', canUseFrom(5, true).use, false);
        check('超 4 格时说"太远"', /格/.test(canUseFrom(5, true).why), true);
        check('正好 4 格、视线通 → 可用（含边界）', canUseFrom(4, true).use, true);
        check('4.01 格、视线通 → 不可用', canUseFrom(4.01, true).use, false);

        // ---- 假 bot 驱动**真实的 approach**（不另抄一份实现）
        //     世界：方块在 (4,64,0)（中心 4.5,64.5,0.5），她站在 (sx,64,0)，眼睛 y=65.62
        const V = (x, y, z) => new Vec3(x, y, z);
        const mkApproachBot = ({ self, blockAtPos = V(4, 64, 0), visible, goto }) => {
          const block = { name: 'minecraft:furnace', position: blockAtPos.clone(), boundingBox: 'block' };
          const bot = {
            entity: { position: self.clone(), eyeHeight: 1.62 },
            canSeeBlock: () => visible,
            blockAt: () => block,
            lookAt: async () => {},
            pathfinder: { setGoal () {}, goto: goto || (async () => { throw new Error('走不到（假 bot）'); }) },
          };
          return { bot, block };
        };

        // ① 3 格远、视线通 → 不走（walked=false）
        {
          const { bot, block } = mkApproachBot({ self: V(1.5, 64, 0.5), visible: true });
          const r = await approach(bot, block);
          check('① 3 格远视线通 → 不寻路', r.walked, false);
          check('① 返回带 lineOfSight/dist', [r.lineOfSight, typeof r.dist], [true, 'number']);
        }
        // ② 3 格远但中间隔一堵墙 → 先走（goto 被调用）
        {
          let moved = false;
          const { bot, block } = mkApproachBot({
            self: V(1.5, 64, 0.5), visible: false,
            goto: async () => { moved = true; bot.entity.position = V(3.5, 64, 0.5); bot.canSeeBlock = () => true; },
          });
          const r = await approach(bot, block);
          check('② 3 格远中间挡着 → 真的寻路了', moved, true);
          check('② 走到了 → walked=true 且视线通了', [r.walked, r.lineOfSight], [true, true]);
        }
        // ③ 5 格远视线通 → 先走
        {
          let moved = false;
          const { bot, block } = mkApproachBot({
            self: V(-1, 64, 0.5), visible: true,
            goto: async () => { moved = true; bot.entity.position = V(3.5, 64, 0.5); },
          });
          const r = await approach(bot, block);
          check('③ 5 格远（超 4 格）→ 寻路', moved, true);
          check('③ 走一步后 3 格内视线通 → 可用', [r.walked, r.lineOfSight], [true, true]);
        }
        // ④ 射线上有读不到的格子（canSeeBlock 返回 null）→ 当挡着 → 先走
        {
          let moved = false;
          const { bot, block } = mkApproachBot({
            self: V(2.5, 64, 0.5), visible: null,
            goto: async () => { moved = true; bot.entity.position = V(3.5, 64, 0.5); bot.canSeeBlock = () => true; },
          });
          const r = await approach(bot, block);
          check('④ 读不到视线 → 当挡着，先走', moved, true);
          check('④ 走通了 → 可用', r.lineOfSight, true);
        }
        // ⑤ 走不过去，但 4 格内视线通 → 照样可用（不抛）
        //    起点视线读不到（先判"用不了"）→ 寻路失败 → 这时视线已能读到且距离仍在 4 格内 → 照样用
        {
          const { bot, block } = mkApproachBot({ self: V(1.5, 64, 0.5), visible: null, goto: async () => { bot.canSeeBlock = () => true; throw new Error('GoalChanged'); } });
          let err = null; let r = null;
          try { r = await approach(bot, block); } catch (e) { err = e; }
          check('⑤ 走不过去但原地 4 格内视线通 → 不抛错', err, null);
          check('⑤ 返回 walked=false 且 via 说清是寻路失败但够得着', [r?.walked, r?.via], [false, 'goto-failed-but-in-reach']);
        }
        // ⑥ 走不过去、中间又挡着 → 如实报"够不着 / 挡着"，绝不硬点
        {
          const { bot, block } = mkApproachBot({ self: V(1.5, 64, 0.5), visible: false, goto: async () => { throw new Error('GoalChanged'); } });
          let err = null;
          try { await approach(bot, block); } catch (e) { err = e; }
          check('⑥ 走不过去且挡着 → 抛错（不硬点）', !!err, true);
          check('⑥ 错误里说清走不到 + 为什么用不了', /走不到.*挡/.test(err?.message || ''), true);
        }
        // ⑦ 走到了还是够不着（goto 成功但人没动、仍 5 格 + 挡着）→ 抛错
        {
          const { bot, block } = mkApproachBot({ self: V(-1, 64, 0.5), visible: false, goto: async () => {} });
          let err = null;
          try { await approach(bot, block); } catch (e) { err = e; }
          check('⑦ 走到跟前仍用不了 → 抛错', /用不了/.test(err?.message || ''), true);
        }
      }
  }],
  ['[0f] 吃东西也看背包（2026-09-29：背包里有面包、身上没有 → 先拿出来再吃）', async (t) => {
    const { check } = t;
    const { eat, foodScore } = t.h;
      {
        // 假 bot：身上 items() 返回给定几件；equip / consume 记录调用
        const mkBot = (carried, { food = 6 } = {}) => {
          const slots = carried.map((c, i) => ({ name: c.name, count: c.count, type: 100 + i, metadata: 0, stackSize: 64, foodPoints: c.foodPoints || 0 }));
          return {
            food,
            inventory: { items: () => slots, slots, emptySlotCount: () => 20 },
            equipped: null,
            consumed: 0,
            equip: async function (it) { this.equipped = it.name; },
            // 真 consume：吃掉手上那件（从 slots 里扣 1），饥饿 +6 —— 让 eat 的"核对真实变化"能通过
            consume: async function () {
              this.consumed++;
              const it = this.inventory.slots.find(x => x.name === this.equipped);
              if (it) it.count -= 1;
              this.food = Math.min(20, this.food + 6);
            },
          };
        };
        // 自测通过 eat 的第 4 个参数注入假的"从背包拿"（生产走模块内转发壳，同一份真身）。
        // 不去改 8 个文件共享的 __ns —— craft.js 的 __ns 和 index.js 的 __ns 是两个对象
        // （bind 是「按值拷进各文件自己的 __ns」），改 index 的那个不影响这里的转发壳。
        const stub = (fn) => fn;

        {
          // ---- ① ★ 身上没有吃的、背包里有面包 → 先从背包拿出来，吃到嘴 ----
          {
            const bot = mkBot([]);
            let asked = null;
            const bread = { name: 'minecraft:bread', count: 1, type: 200, metadata: 0, stackSize: 64, foodPoints: 5 };
            const bag = stub(async (b, st, spec, count) => {
              asked = { isFn: typeof spec === 'function', count };
              b.inventory.slots.push(bread);   // 模拟"从背包拿到了身上"
              return { have: 1, got: 1, source: 'backpack' };
            });
            const r = await eat(bot, {}, { backpackSeen: { items: { 'minecraft:bread': 3 } } }, bag);
            check('★ 身上没有、背包里有面包 → 吃到了', r.ate, true);
            check('★ 报的是面包', r.item, 'minecraft:bread');
            check('★ from=backpack（说清是从背包摸出来的）', r.from, 'backpack');
            check('★ 去背包拿时用的是 predicate（任意一种吃的都行）', asked && asked.isFn, true);
          }
          // ---- ② 身上就有吃的 → from=carried，不去开背包 ----
          {
            const bot = mkBot([{ name: 'minecraft:cooked_beef', count: 2 }]);
            let called = false;
            const bag = stub(async () => { called = true; return { have: 0, got: 0, source: 'none' }; });
            const r = await eat(bot, {}, { backpackSeen: { items: { 'minecraft:bread': 3 } } }, bag);
            check('★ 身上有熟牛排 → 直接吃，不开背包', { ate: r.ate, from: r.from, opened: called }, { ate: true, from: 'carried', opened: false });
          }
          // ---- ③ ★ 点名要吃的东西只在背包里 → 也拿出来吃 ----
          {
            const bot = mkBot([]);
            const bread = { name: 'minecraft:bread', count: 1, type: 200, metadata: 0, stackSize: 64, foodPoints: 5 };
            let specType = null;
            const bag = stub(async (b, st, spec) => {
              specType = typeof spec;
              b.inventory.slots.push(bread);
              return { have: 1, got: 1, source: 'backpack' };
            });
            const r = await eat(bot, { itemName: '面包' }, { backpackSeen: { items: {} } }, bag);
            check('点名要的是具体物品名（不是 predicate）', specType, 'string');
            check('★ 点名"面包"、身上没有、背包里拿出来 → 吃到', { ate: r.ate, item: r.item }, { ate: true, item: 'minecraft:bread' });
          }
          // ---- ④ 背包读不到 → 如实报"读不到"，不混成"没有" ----
          {
            const bot = mkBot([]);
            const bag = stub(async () => ({ have: 0, got: 0, source: 'unknown', absenceProven: false, why: '身上没有，背包读不到' }));
            const r = await eat(bot, {}, {}, bag);
            check('★ 背包读不到 → ate=false 且说明读不到', { ate: r.ate, unk: r.backpackUnknown, why: r.reason }, { ate: false, unk: true, why: '身上没有吃的；身上没有，背包读不到' });
          }
          // ---- ⑤ 身上和背包都没有 → 如实报"都没有"（和 ④ 分开）----
          {
            const bot = mkBot([]);
            const bag = stub(async () => ({ have: 0, got: 0, source: 'none', absenceProven: true, why: '身上和背包里都没有' }));
            const r = await eat(bot, {}, { backpackSeen: { items: {} } }, bag);
            check('★ 都没有 → 报"都没有"（不是"读不到"）', { ate: r.ate, unk: !!r.backpackUnknown, reason: r.reason }, { ate: false, unk: false, reason: '身上和背包里都没有能吃的东西' });
          }
          // ---- ⑥ 不传 state（旧调用点）→ 退回旧行为，只看身上 ----
          {
            const bot = mkBot([]);
            const bag = stub(async () => { throw new Error('不该被调用'); });
            const r = await eat(bot, {}, null, bag);
            check('不传 state 时不碰背包（旧行为不变）', { ate: r.ate, reason: r.reason }, { ate: false, reason: '身上和背包里都没有能吃的东西' });
          }
          // ---- 判据只此一份：吃的判据用 foodScore，没另写食物名单 ----
          check('foodScore 是唯一一份吃的判据（eat 用它挑食物）',
            /foodScore\(i\) > 0|foodScore\(it\) > 0/.test(t.handsSrc()), true);
        }
      }
  }],
  ['[0g] 合成缺料看背包 / 缺工作台自己放了再收回（2026-09-29）', async (t) => {
    const { check } = t;
    const { topUpFromBackpack, withPlacedStation, craft2 } = t.h;
      {
        // ---- topUpFromBackpack：只在"快照里真有"时才去拿（读不到不硬开）----
        const KB = { tags: new Map([['item:planks', new Set(['minecraft:oak_planks', 'minecraft:birch_planks'])]]) };
        const cands = [{ shape: { key: { X: [{ tag: 'planks' }] } } }];
        const mkBotItems = (arr) => ({ inventory: { items: () => arr, slots: arr } });
        {
          // 背包快照里有木板 → 去拿一次（拿完身上多出来）
          // 注：标签 `planks` 展开成 oak+birch 两个 id，快照里只有 oak → 只对 oak 那一次真拿到
          const arr = [];
          const bot = mkBotItems(arr);
          const askedIds = [];
          const carry = async (b, st, spec) => {
            askedIds.push(spec);
            if (spec !== 'minecraft:oak_planks') return { have: 0, got: 0, source: 'none' };
            arr.push({ name: 'minecraft:oak_planks', count: 4, type: 5 }); return { have: 4, got: 4, source: 'backpack' };
          };
          const moved = await topUpFromBackpack(bot, { backpackSeen: { items: { 'minecraft:oak_planks': 4 } } }, KB, cands, new Map(), carry);
          check('★ 快照里有原料 → 去背包拿（moved=true）', { moved, askedOak: askedIds.includes('minecraft:oak_planks') }, { moved: true, askedOak: true });
        }
        {
          // 背包读不到（从没开过）→ 不去拿、也不假装没有
          const bot = mkBotItems([]);
          let calls = 0;
          const carry = async () => { calls++; return { have: 0, got: 0, source: 'unknown' }; };
          const moved = await topUpFromBackpack(bot, {}, KB, cands, new Map(), carry);
          check('★ 背包读不到 → 不去开背包（不猜）', { moved, calls }, { moved: false, calls: 0 });
        }
        {
          // 身上已经有这种料 → 不必去背包拿
          const bot = mkBotItems([{ name: 'minecraft:oak_planks', count: 8, type: 5 }]);
          let calls = 0;
          const carry = async () => { calls++; return { have: 0, got: 0, source: 'backpack' }; };
          const moved = await topUpFromBackpack(bot, { backpackSeen: { items: { 'minecraft:oak_planks': 4, 'minecraft:birch_planks': 4 } } }, KB, cands, new Map([['minecraft:oak_planks', 8], ['minecraft:birch_planks', 8]]), carry);
          check('身上已够（两种都够）→ 不开背包', { moved, calls }, { moved: false, calls: 0 });
        }

        // ---- withPlacedStation：放下 → 用 → 收回；放不下/没有都如实报 ----
        const V3 = t.Vec3;
        const mkPlaceBot = ({ invHas = [], placeOk = true } = {}) => {
          const world = new Map();
          const key = (p) => `${p.x},${p.y},${p.z}`;
          // 站的地方在 (0.5,64,0.5)：脚下 y=63 铺一圈实心底，其余全空
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            world.set(`${dx},63,${dz}`, { name: 'minecraft:stone', boundingBox: 'block', position: new V3(dx, 63, dz) });
          }
          const items = invHas.map((n, i) => ({ name: n, count: 1, type: 900 + i }));
          return {
            items, world,
            inventory: { items: () => items, slots: items },
            entity: { position: new V3(0.5, 64, 0.5) },
            heldItem: null,
            currentWindow: null,
            equip: async function (it) { this.heldItem = it; },
            lookAt: async () => {},
            blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) || null,
            placeBlock: async (ref, face) => {
              if (!placeOk) throw new Error('放不上');
              const p = ref.position;
              const at = new V3(p.x + (face?.x || 0), p.y + (face?.y || 0), p.z + (face?.z || 0));
              world.set(key(at), { name: 'minecraft:crafting_table', boundingBox: 'block', position: at });
            },
            dig: async (b) => { world.delete(key(b.position)); items.push({ name: b.name, count: 1, type: 950 }); },
            collectBlock: null, closeWindow: () => {},
          };
        };
        {
          // 身上就有工作台：放下 → fn 拿到方块 → 收回
          const bot = mkPlaceBot({ invHas: ['minecraft:crafting_table'] });
          let usedBlock = null;
          const st = await withPlacedStation(bot, {}, 'minecraft:crafting_table', async (blk) => { usedBlock = blk?.name; return 'done'; });
          check('★ 身上有工作台 → 放下并用上', { ok: st.ok, placed: st.placed, used: usedBlock }, { ok: true, placed: true, used: 'minecraft:crafting_table' });
          check('★ 用完挖回来了', { recovered: st.recovered, kept: bot.items.some(i => i.name === 'minecraft:crafting_table') }, { recovered: true, kept: true });
          check('fn 的返回值带出来了', st.result, 'done');
        }
        {
          // 身上没有、背包里有 → 先 ensureCarried 拿出来再放
          const bot = mkPlaceBot({ invHas: [] });
          let asked = null;
          const carry = async (b, st, spec) => { asked = spec; b.inventory.items().push({ name: 'minecraft:crafting_table', count: 1, type: 42 }); return { have: 1, got: 1, source: 'backpack' }; };
          const st = await withPlacedStation(bot, {}, 'minecraft:crafting_table', async () => 'ok', carry);
          check('★ 身上没有、背包里有 → 从背包拿出来放', { ok: st.ok, asked }, { ok: true, asked: 'minecraft:crafting_table' });
        }
        {
          // 都没有 → 不抛，如实报 why
          const bot = mkPlaceBot({ invHas: [] });
          const carry = async () => ({ have: 0, got: 0, source: 'none' });
          const st = await withPlacedStation(bot, {}, 'minecraft:crafting_table', async () => 'ok', carry);
          check('★ 都没有 → ok=false 且说清', { ok: st.ok, placed: st.placed, hasWhy: /都没有/.test(st.why || '') }, { ok: false, placed: false, hasWhy: true });
        }
        {
          // 放不下 → ok=false，不抛
          const bot = mkPlaceBot({ invHas: ['minecraft:crafting_table'], placeOk: false });
          const st = await withPlacedStation(bot, {}, 'minecraft:crafting_table', async () => 'ok');
          check('★ 放不下 → ok=false、不抛、说清', { ok: st.ok, hasWhy: /空位/.test(st.why || '') }, { ok: false, hasWhy: true });
        }

        // ---- craft2：缺工作台但背包里有 → 走"自己放"这条路（不报"让 mind 放"）----
        check('★ craft2 的"要工作台"分支已改成自己放（源码形状锁）',
          /withPlacedStation\(bot, state, 'minecraft:crafting_table'/.test(t.handsSrc()), true);
        check('★ 旧的"让 mind 去 place"提示语不再作为行为出现（只在注释里留了出处）',
          /tried\.push\([^)]*place 放下/.test(t.handsSrc()), false);
        // ---- smelt：缺熔炉也自己放（2026-09-29 问题 3 的熔炉半边）----
        check('★ smelt 缺炉子时走 withPlacedStation（源码形状锁）',
          /withPlacedStation\(bot, state, 'minecraft:furnace'/.test(t.handsSrc()), true);
        check('★ 烧的动作只写一份（doSmelt 内层函数）',
          /const doSmelt = async \(furnaceBlock, usedType\) =>/.test(t.handsSrc()), true);
        check('★ smelt 不再直接抛"16 格内没有能烧它的炉子"就完事',
          /if \(!cands\.length\) throw new Error\(`16 格内没有能烧它的炉子/.test(t.handsSrc()), false);
      }
  }],
  ['[0f] wear：已经穿在身上 → 成功 + alreadyWorn（2026-09-29 问题 3）', async (t) => {
    const { check, handsSrc } = t;
    const { wear } = t.h;
    const HELM = 'makit_better:resilient_nature_helmet';
    const item = (name, count = 1) => ({ name, count, type: 1 });
    // 假 bot：inventory.items() 只返回**背包里**的东西（穿在身上的不在里面，这正是旧 bug 的根因）；
    // inventory.slots 按 mineflayer 布局给（5=头 6=胸 7=腿 8=脚 45=副手）。
    // ⚠️ slots 里放的是**物品对象**（要有 .name），不是字符串 —— equipment() 读的是 `s[i].name`。
    const mkBot = ({ carried = [], worn = {} } = {}) => ({
      inventory: {
        slots: Object.assign([], { 5: worn.head || null, 6: worn.torso || null, 7: worn.legs || null, 8: worn.feet || null, 45: worn['off-hand'] || null }),
        items: () => carried,
      },
      heldItem: null,
      equip: async () => { throw new Error('不该走到 equip：已经穿在身上了'); },
    });

    // ---- 实机现场：本能刚把头盔换上，mind 又 /wear 同一件 ----
    {
      const bot = mkBot({ carried: [item(HELM)], worn: { head: item(HELM) } });
      const r = await wear(bot, {}, { itemName: HELM });
      check('★ 已经穿在头上 → 不报"背包里没有"', !!r, true);
      check('★ alreadyWorn=true', r.alreadyWorn, true);
      check('★ 报的是哪个槽（head）', r.slot, 'head');
      check('★ 说明是"本来就在身上"（via=already-worn）', r.via, 'already-worn');
    }
    // ---- 穿在身上、背包里**没有**同一件（旧代码直接抛"背包里没有"）----
    {
      const bot = mkBot({ carried: [], worn: { head: item(HELM) } });
      let e = null; let r = null;
      try { r = await wear(bot, {}, { itemName: HELM }); } catch (err) { e = err; }
      check('★ 身上穿着、背包里没有 → 不抛错', e, null);
      check('★ 而且报 alreadyWorn', r?.alreadyWorn, true);
    }
    // ---- 别把"没穿"也判成 alreadyWorn：背包里有、身上空 → 走正常穿戴路径 ----
    {
      const bot = mkBot({ carried: [item(HELM)], worn: {} });
      // equip 会抛（假 bot 故意抛），说明确实**没有**走 already-worn 分支
      let e = null;
      try { await wear(bot, {}, { itemName: HELM }); } catch (err) { e = err; }
      check('★ 身上没穿 → 不走 already-worn（会去真穿）', /不该走到 equip/.test(e?.message || ''), true);
    }
    // ---- 穿的是**别的**头盔、背包里有要换的那顶 → 也不能误判 alreadyWorn ----
    {
      const bot = mkBot({ carried: [item(HELM)], worn: { head: item('minecraft:iron_helmet') } });
      let e = null;
      try { await wear(bot, {}, { itemName: HELM }); } catch (err) { e = err; }
      check('★ 头上是别的头盔 → 不当 alreadyWorn（该换就换）', /不该走到 equip/.test(e?.message || ''), true);
    }
    // ---- 背包里也没有、身上也没有 → 照旧报"背包里没有"（"没有"和"读不到"分开）----
    {
      const bot = mkBot({ carried: [], worn: {} });
      let e = null;
      try { await wear(bot, {}, { itemName: HELM }); } catch (err) { e = err; }
      check('★ 哪都没有 → 照旧抛"背包里没有"', /背包里没有/.test(e?.message || ''), true);
    }
    // ---- 源码形状锁：already-worn 判据在 equip 之前 ----
    check('★ 判据用 slotByName + equipment 比对，且在 equip 之前',
      /const wantId = [\s\S]{0,400}if \(dest && wantId && eq0\[dest\] === wantId\) \{[\s\S]{0,120}alreadyWorn: true/.test(handsSrc()), true);
  }],
];
register('craft', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 单独跑本文件：先把总表接上（原来所有 hands 函数在同一作用域，小节随手就能取）。
  // 总表用汇总额外导出的 __ns（8 个文件的全部名字），不是那 47 个对外接口。
  require('./testkit').bindHands(require('./index').__ns);
  const { runSuite } = require('./testkit');
  runSuite('craft', __sections);
}
