/**
 * util.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const { execFile } = require('child_process');   // 拆分时漏搬（原 server.js:2714），2026-09-29 补
const cfg = require('./config.js').cfg;
const pathing = require('../world/pathing');
const placeLogic = require('../world/place');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let CFG;
let state;
let goals;

function reachableStandY (...a) { return __ns.reachableStandY.apply(null, a); }

function botPos() {
  const p = state.bot?.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

function botPosExact() {
  const p = state.bot?.entity?.position;
  if (!p) return null;
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
}

function requireConnected(res) {
  if (!state.connected || !state.bot) {
    json(res, 503, {
      error: 'Bot not connected',
      hint: 'Open Minecraft and check MC_HOST/MC_PORT',
      // 离线时能读的：全都是本地文件/内存表，不需要游戏在跑
      offlineOk: [
        'GET /status', 'GET /config', 'GET /memory', 'GET /state',
        'GET /knowledge', 'GET /knowledge/search', 'POST /knowledge/search',
        'GET /palette', 'GET /palette/state', 'GET /palette/block', 'GET /palette/climbable',
        'POST /registry/import-palette', 'GET /debug/registries', 'GET /debug/registry',
        'GET /debug/pathfinder',
        // 物品注册表：本地快照 + 内存里的注入报告
        'GET /item',
      ],
    });
    return false;
  }
  return true;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms));
}

const DBG_PATH = cfg('MC_PATH_DEBUG', 'true') !== 'false';

function DBG (msg) {
  if (DBG_PATH) console.log(msg);
}

function withTimeout(promise, ms = CFG.bridge.actionTimeout) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Action timed out')), ms)),
  ]);
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function guardPathfinderCrash (bot, state, before = []) {
  const beforeSet = new Set(Array.isArray(before) ? before : []);
  return pathing.installPhysicsTickGuard(bot, {
    // 快照比对：不在 before 里的 → 本次 loadPlugin 新增的 → pathfinder 的
    isPathfinderListener: (fn) => !beforeSet.has(fn),
    onError: (err) => {
      state.pfCrashCount = (state.pfCrashCount || 0) + 1;
      state.lastPfCrash = { t: Date.now(), message: err?.message || String(err), at: 'monitorMovement' };
      console.error(`[pathfinder] monitorMovement 抛错，已兜住（不会退出进程）：${err?.message || err}`);
    },
  });
}

function isAiryForPlace (block) {
  return !!block && placeLogic.isReplaceable(block.name);
}

function droppedItemOf (e) {
  try {
    const it = e.getDroppedItem && e.getDroppedItem();
    if (it && it.name) return { name: it.name, count: it.count };
  } catch (_) {}
  const slot = (e.metadata || []).find(m => m && typeof m === 'object' && m.itemId != null);
  if (!slot || slot.present === false) return null;
  const def = state.bot?.registry?.items?.[slot.itemId];
  return { name: def ? def.name : `#${slot.itemId}`, count: slot.itemCount ?? slot.count ?? 1 };
}

function isDropEntity (e) {
  if (!e || !e.position) return false;
  const byDisplay = e.displayName === 'Item' || e.displayName === 'item';
  const byName = e.name === 'item' || e.name === 'Item' || e.name === 'item_stack';
  return byDisplay || byName;
}

function inventoryFingerprint () {
  const items = {};
  let total = 0;
  try {
    for (const it of state.bot?.inventory?.items() || []) {
      const n = it.count || 1;
      items[it.name] = (items[it.name] || 0) + n;
      total += n;
    }
  } catch (_) { /* 没连上或背包不可读 → 返回空指纹，调用方按 0 处理 */ }
  return { items, total };
}

function fingerprintDelta (before, after) {
  let added = 0;
  for (const [name, n] of Object.entries(after?.items || {})) {
    const prev = before?.items?.[name] || 0;
    if (n > prev) added += n - prev;
  }
  return added;
}

async function sweepUpDrops (bot, around, opts = {}) {
  const radius = opts.radius ?? 3;
  const budgetMs = opts.budgetMs ?? 4000;
  // 等掉落物出现的上限。**与捡取的预算分开算** ——
  // 两者是不同性质的时间：前者等"世界的反应"，后者花在"走过去"上。
  const waitMs = opts.waitMs ?? 2500;
  const pollMs = opts.pollMs ?? 200;
  const out = { seen: 0, picked: 0, skipped: 0, waitedMs: 0, polls: 0 };
  if (!bot?.entity?.position || !around) return out;

  const isDrop = (e) => e && e !== bot.entity && e.position && e.isValid !== false
    && isDropEntity(e);

  const findDrops = () => Object.values(bot.entities)
    .filter(isDrop)
    .filter(e => e.position.distanceTo(around) <= radius)
    // 近的优先：近的那件最可能是刚挖下来的，也最不容易在路上被水冲走
    .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
    .slice(0, 8);

  // ---- ① 等它出现（P10 的修复）------------------------------------------------
  //
  // 注意这里是"**轮询直到看见**"，不是"睡固定时长再看一眼"：
  // 掉落物通常几十毫秒就同步过来了，睡满 2.5 秒纯属浪费时间。
  // 而如果真的没有（挖的是玻璃/树叶这种不掉落的方块），就在 waitMs 后放弃。
  const waitDeadline = Date.now() + waitMs;
  let drops = findDrops();
  while (!drops.length && Date.now() < waitDeadline) {
    out.polls++;
    await sleep(pollMs);
    drops = findDrops();
  }
  out.waitedMs = out.polls * pollMs;

  // ---- 诊断留痕（P1b 的产物）-------------------------------------------------
  // 实机上 `seen: 0` 但确实挖掉了方块 —— 这种情况下最需要的不是"再猜一次"，
  // 而是**亲眼看到 bot 眼里的实体长什么样**。
  // 所以这里把"候选集"和"每个为什么被排除"都记下来，返回给调用方。
  // 成本极低（就是几个字段读），但它决定了下次出问题要查 5 分钟还是 1 小时。
  const all = Object.values(bot.entities);
  const inRange = all.filter(e => e && e !== bot.entity && e.position
    && e.position.distanceTo(around) <= radius);
  out.totalEntities = all.length;
  out.inRange = inRange.length;
  out.candidates = inRange.slice(0, 6).map(e => ({
    name: e.name ?? null,
    displayName: e.displayName ?? null,
    type: e.type ?? null,
    isDrop: isDropEntity(e),
    valid: e.isValid !== false,
    dist: Math.round(e.position.distanceTo(around) * 10) / 10,
  }));
  if (!out.candidates.length && all.length) {
    // 附近一件实体都没有，但世界里明明有 —— 把最近的那个也报上来，
    // 这样能区分"确实没有掉落物"和"我的实体表是空的/我读错了字段"
    const near = all
      .filter(e => e && e !== bot.entity && e.position)
      .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
      .slice(0, 3)
      .map(e => ({
        name: e.name ?? null, displayName: e.displayName ?? null, type: e.type ?? null,
        isDrop: isDropEntity(e),
        dist: Math.round(e.position.distanceTo(around) * 10) / 10,
      }));
    out.nearestAny = near;
  }

  out.seen = drops.length;
  if (!drops.length) return out;

  // ---- ② 捡。成功的判据是**背包真的变了**，不是"我走到了" ----------------------
  //
  // `/pickup` 的注释里写过"走到即会拾取"，但那是**期望**，不是**保证**：
  // 掉落物可能被水冲走、被别的玩家抢先、或者卡在够不到的地方。
  // 唯一可信的判据是背包件数。
  //
  // ⚠️ 而且背包变化**也是延迟的**（P10 的第二层）：走过去之后，
  //    服务端要几十到几百毫秒才把物品塞进背包。
  //    实测：`walked: 1` 但 `picked: 0`，而**几秒后**背包确实多了一件。
  //    所以核对也要"等一下再读"，不能走完立刻读。
  const invBefore = inventoryCount(bot);
  const deadline = Date.now() + budgetMs;
  let walkedTo = 0;
  // ⚠️ 她当前站的高度，整个循环里算一次就够（掉落物距离都很近，她不会在这期间上下大落差）。
  const selfY = Math.floor(bot.entity?.position?.y ?? 0);
  for (const d of drops) {
    if (Date.now() >= deadline) { out.skipped++; continue; }
    if (!d.isValid) { out.skipped++; continue; }
    try {
      // ⚠️ 用 GoalNear(d, 2) 而不是 GoalBlock(d.position)：
      //    掉落物浮在方块高度上，精确命中那个格子往往会"站在旁边却够不到"。
      //
      // ⚠️⚠️ 2026-09-25 实机（P30 → P33）：**球心的 y 最讲究，用错两次。**
      //
      //    ① 第一版用掉落物的 y（P30）：
      //       她站在 y=87 的坎上，掉落物在 y=85。要求她**走到 y≈85 那一层**
      //       才算到达；而 y=87→85 是两格落差，寻路器（`canDig=false`，只绕不拆）
      //       找不到下去的路 → 原地打转 → 背包始终为空。日志上一切正常。
      //       这和 P11（`/mine` 的寻路球心）是**同一个错误**。
      //
      //    ② 第二版一律用她自己的 y（P30 的修法）→ 又错了（P33）：
      //       球心锁在她**当前**层 → 她永远不下坑 → 站在坑沿上够不着坑底。
      //       实机证据：`/pickup` 返回 `walkedTo: 3, picked: 0`，
      //       坑底（y=85/86 的空气格）离她 2 格，而拾取是 **3D 判定**。
      //
      //    ③ 正确的语义：**站到她"够得着这堆东西"的那一层** —— 见 `reachableStandY`。
      //       · 物品在她脚下一格内 → 就跟着下去（1 格落差可以直接走，不用挖）
      //       · 更深 → 站在最近的可站层，靠拾取半径够（**绝不要求她挖穿地形**）
      //       · 在她上方 → 不往天上爬
      //       半径放 2 —— 掉落物会散落，1 格太紧。
      //
      // ⚠️ 另外：**清理必须在 goto 之前，不能在之后**（P25）。
      //    `setGoal(null)` 会 emit `goal_updated(null)`，如果那时下一个 goto
      //    已经注册好 listener 在等，它会收到 null 并立刻报 GoalChanged。
      //    实测：地上 6 个掉落物、距离 1.4 格，goto 全部在 0ms 内失败。
      //    见 `withTimeout` 顶部的完整时序推导。
      pathing.clearPathfinderGoal(bot.pathfinder);
      const goalY = reachableStandY(d.position.y, selfY);
      // ⚠️ P38：半径随垂直落差自适应 —— 否则球内没有可站的点，她永远"到不了"。
      //    三处（sweepUpDrops / `/pickup` / `/mine` 残余）必须用同一条规则。
      const sweepRadius = Math.max(2, Math.abs(selfY - goalY) + 1);
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(d.position.x, goalY, d.position.z, sweepRadius)),
        sleep(Math.max(300, deadline - Date.now())),
      ]);
      walkedTo++;
    } catch (_) {
      out.skipped++;
    }
    // 只 stop() 不清 goal —— clearGoal 会打到下一个已经在等的 goto。
    // ⚠️ 但 `stop()` 之后**必须让出一个 tick**：`goto.js` 的 listener 清理
    //    是 `setTimeout(..., 0)`，不让出的话下一个 goto 会撞上残留 listener
    //    并收到 `goal_updated`（绑的是旧 goal）→ 报 GoalChanged。见 P25 第 ③ 层。
    try { bot.pathfinder.stop(); } catch (_) {}
    await sleep(0);
  }
  // 整批结束，此时无人等待 —— 唯一安全的清理点。
  pathing.clearPathfinderGoal(bot.pathfinder);

  // 走完之后**等背包更新**（最多 settleMs），并用"背包增量"当判据。
  // 为什么不直接报 `walkedTo`：走过去不等于拿到手。
  // 为什么不立刻读：**服务端塞进背包是延迟的**（见上）。
  //
  // ⚠️⚠️⚠️ 2026-09-25 第三轮实战：**条件写错了**（P10 第三层）。
  //
  //   实测（m8.json）：`bulkSweep.walked: 0, picked: 0`，而且 `invDelta: 2`
  //   远小于**实际到手 3 个**（背包 2 → 5）。
  //   也就是"东西其实早就进包了，只是我们三个判据全读早了/读漏了"。
  //
  //   原条件的两个 bug：
  //     ① `walkedTo > 0` 作为前置 —— 她**站着不动**也可能捡到
  //        （掉落物可能正好落到她脚下，或上一轮已经进了碰撞箱）。
  //        加了这个前置就等于"只要我没走路，我就拒绝承认捡到了"。
  //     ② `gained <= 0` 作为唯一继续条件 —— 一旦某一拍读到了 >0 就立刻退出，
  //        但**背包可能是分几拍陆续到的**（3 个物品分 2 批同步），
  //        于是"第一批到手就收工"，后两批永远没被等到。
  //
  //   修法：
  //     · 去掉 `walkedTo > 0` 前置 —— 只要**有候选掉落物**就该等一等；
  //     · 不满足于"第一次 >0"，而是**一直等到不再增长**（稳定了才算齐），
  //       上限仍是 settleMs。
  //   这样报出来的 `picked` 才接近真实到手件数。
  const settleMs = opts.settleMs ?? 1200;
  const settleDeadline = Date.now() + settleMs;
  const hadCandidates = drops.length > 0;
  let gained = inventoryCount(bot) - invBefore;
  let lastGained = gained;
  while (hadCandidates && Date.now() < settleDeadline) {
    await sleep(150);
    gained = inventoryCount(bot) - invBefore;
    if (gained > 0 && gained === lastGained) break;   // 已经稳定：拿完了
    lastGained = gained;
  }

  out.picked = Math.max(0, gained);
  // `walked` 与 `picked` **分开报**：差值有信息量 ——
  // walked > picked 就是"走过去了但没进包"（被抢/够不到/掉落物已消失）。
  // 只报一个 `picked` 的话，这种摩擦永远看不出来。
  out.walked = walkedTo;
  return out;
}

function inventoryCount (bot) {
  try {
    const items = bot?.inventory?.items() || [];
    return items.reduce((sum, it) => sum + (Number(it?.count) || 0), 0);
  } catch (_) { return 0; }
}

function resolveBlocksForItem (bot, itemName) {
  const reg = bot?.registry;
  const empty = { blocks: [], resolveSource: 'none', viaDrops: 0, viaName: 0 };
  if (!reg?.blocksByName) return empty;

  const target = stripNamespace(itemName);
  const viaDrops = [];
  const viaName = [];

  for (const name of Object.keys(reg.blocksByName)) {
    const def = reg.blocksByName[name];
    if (!def || typeof def.id !== 'number') continue;
    if (dropsMatch(reg, def, target)) {
      viaDrops.push({ id: def.id, name, how: 'drops' });
      continue;                       // 已经命中，不必再猜名字
    }
    if (nameMatchesItem(name, target)) {
      viaName.push({ id: def.id, name, how: 'name' });
    }
  }

  const blocks = [...viaDrops, ...viaName];
  // 原版方块优先（没有命名空间前缀的），然后按名字稳定排序。
  // 模组方块重名/覆盖的情况不少，让原版排前面能让"我要铁"在这些包里也选对。
  blocks.sort((a, b) => {
    const am = a.name.includes(':') ? 1 : 0;
    const bm = b.name.includes(':') ? 1 : 0;
    if (am !== bm) return am - bm;
    // 同一档里 drops 命中的排在名字推断之前（更可信）
    if (a.how !== b.how) return a.how === 'drops' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    blocks,
    resolveSource: viaDrops.length && viaName.length ? 'mixed'
      : viaDrops.length ? 'drops'
        : viaName.length ? 'name' : 'none',
    viaDrops: viaDrops.length,
    viaName: viaName.length,
  };
}

function dropsMatch (reg, def, target) {
  const drops = Array.isArray(def.drops) ? def.drops : null;
  if (!drops || drops.length === 0) return false;
  return drops.some(d => {
    const v = d?.drop ?? d;
    if (typeof v === 'string') return stripNamespace(v) === target;
    if (typeof v === 'number') return stripNamespace(reg.items?.[v]?.name || '') === target;
    if (v && typeof v === 'object' && typeof v.id === 'number') {
      return stripNamespace(reg.items?.[v.id]?.name || '') === target;
    }
    return false;
  });
}

const ITEM_BLOCK_SUFFIXES = [
  '_log', '_wood', '_stem', '_hyphae', '_ore', '_planks', '_sapling',
];

function nameMatchesItem (blockName, target) {
  const bare = stripNamespace(blockName);
  if (bare === target) return true;                       // 同名（石头掉石头）
  const ns = String(blockName).includes(':')
    ? String(blockName).split(':')[0] : null;
  for (const suf of ITEM_BLOCK_SUFFIXES) {
    if (!bare.endsWith(suf)) continue;
    const head = bare.slice(0, -suf.length);
    if (head !== target) continue;
    // 带命名空间的方块必须**同命名空间**才算命中：`other_mod:lemon_log`
    // 不该被当成 `bountifulfares:lemon` 的来源。
    if (ns && !String(blockName).startsWith(`${ns}:`)) continue;
    return true;
  }
  return false;
}

function stripNamespace (name) {
  return String(name || '').replace(/^[a-z0-9_.-]+:/i, '');
}

function sameItem (have, want) { return have === want || have === String(want || '').replace(/^minecraft:/, ''); }

function isPlayerBuilt (blockName) {
  if (!blockName) return null;
  const n = stripNamespace(blockName);

  // 合成件后缀 —— 这些在自然界里**不会生成**（自然树只有 _log 和 _leaves）。
  // 注意顺序无关，用 some 匹配。
  const CRAFTED_SUFFIXES = [
    '_planks', '_stairs', '_slab', '_fence', '_fence_gate', '_wall',
    '_door', '_trapdoor', '_pressure_plate', '_button', '_sign',
    '_bricks', '_brick', '_glass', '_glass_pane', '_pane',
    '_bars', '_ladder', '_scaffolding', '_carpet', '_bed',
    '_torch', '_lantern', '_campfire', '_chain', '_flower_pot',
    '_chest', '_barrel', '_crafting_table', '_furnace', '_anvil',
    '_cauldron', '_composter', '_lectern', '_loom', '_smoker',
    '_bookshelf', '_painting', '_item_frame', '_flower_pot',
  ];
  if (CRAFTED_SUFFIXES.some(suf => n.endsWith(suf))) return true;

  // 几个不带后缀但明确是人造的
  const CRAFTED_EXACT = new Set([
    'lantern', 'soul_lantern', 'glass', 'tinted_glass', 'bricks',
    'stone_bricks', 'chiseled_stone_bricks', 'mossy_stone_bricks',
    'bookshelf', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
    'chest', 'trapped_chest', 'barrel', 'anvil', 'chipyed_anvil',
    'torch', 'soul_torch', 'redstone_torch', 'campfire', 'soul_campfire',
    'scaffolding', 'ladder', 'iron_bars', 'chain', 'flower_pot',
    'white_wool', 'glass_pane', 'glowstone', 'sea_lantern', 'shroomlight',
  ]);
  if (CRAFTED_EXACT.has(n)) return true;

  // 染色变体（16 色 × 各种构件）—— 也都是合成的
  // `white_wool` / `red_carpet` / `blue_stained_glass` …
  if (/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/.test(n)) {
    // 但要排除自然方块（比如 black_sand? 不存在；obsidian 也不是这个前缀）
    if (/(_wool|_carpet|_concrete|_terracotta|_stained_glass|_bed|_banner|_shulker_box|_candle|_dye)/.test(n)) return true;
  }

  // `_brick(s)` 家族（red_nether_bricks / mud_bricks / deepslate_bricks…）
  if (/_bricks?$/.test(n)) return true;

  // 石砖/石英/紫珀这类"加工过的石头"
  if (/(_polished|_chiseled|_cut|_smooth)_/.test(n)) return true;

  return false;
}

function waitForBlock(bot, pos, ms = 1500) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bot.removeListener('blockUpdate', onUpdate);
      resolve(v);
    };
    const onUpdate = (_oldBlock, newBlock) => {
      try {
        const p = newBlock?.position;
        if (p && p.x === pos.x && p.y === pos.y && p.z === pos.z) {
          if (typeof newBlock.name !== 'string' || !placeLogic.isReplaceable(newBlock.name)) finish(true);
        }
      } catch (_) { /* 事件里出错不该影响判定 */ }
    };
    const timer = setTimeout(() => finish(false), ms);
    bot.on('blockUpdate', onUpdate);

    // 更新可能在我们挂监听之前就到了 —— 主动查一次
    try {
      const cur = bot.blockAt(pos);
      if (cur && typeof cur.name === 'string' && !placeLogic.isReplaceable(cur.name)) finish(true);
    } catch (_) {}
  });
}

function runLookup(script, type, kw, limit) {
  const MAX_CHARS = Math.min(Math.max(1, parseInt(limit ?? '6000') || 6000), 20000);
  const py = cfg('MC_PYTHON', '');
  const candidates = py ? [py] : ['python', 'python3'];

  const attempt = (idx) => new Promise((resolve, reject) => {
    if (idx >= candidates.length) {
      reject(new Error(
        '找不到 python 解释器。请设置 MC_PYTHON 环境变量指向 python.exe，' +
        '或直接在 skills/minecraft-bridge/knowledge 下手动运行 lookup.py'));
      return;
    }
    execFile(candidates[idx], [script, type, kw],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || /not found|不是内部或外部命令/i.test(err.message))) {
          attempt(idx + 1).then(resolve, reject);
          return;
        }
        if (err && !stdout) {
          reject(new Error(`${candidates[idx]} 执行失败: ${(stderr || err.message).slice(0, 400)}`));
          return;
        }
        resolve(String(stdout));
      });
  });

  return attempt(0).then(text => {
    const trimmed = text.length > MAX_CHARS;
    return {
      output: trimmed ? text.slice(0, MAX_CHARS) : text,
      truncated: trimmed,
      hint: trimmed ? '结果被截断，请用更具体的关键词' : undefined,
    };
  });
}

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.reachableStandY !== undefined) reachableStandY = ns.reachableStandY;
  if (ns.state !== undefined) state = ns.state;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  goals = ns.goals;
}

module.exports = {
  "botPos": botPos,
  "botPosExact": botPosExact,
  "requireConnected": requireConnected,
  "json": json,
  "sleep": sleep,
  "DBG_PATH": DBG_PATH,
  "DBG": DBG,
  "withTimeout": withTimeout,
  "sleepMs": sleepMs,
  "guardPathfinderCrash": guardPathfinderCrash,
  "isAiryForPlace": isAiryForPlace,
  "droppedItemOf": droppedItemOf,
  "isDropEntity": isDropEntity,
  "inventoryFingerprint": inventoryFingerprint,
  "fingerprintDelta": fingerprintDelta,
  "sweepUpDrops": sweepUpDrops,
  "inventoryCount": inventoryCount,
  "resolveBlocksForItem": resolveBlocksForItem,
  "dropsMatch": dropsMatch,
  "ITEM_BLOCK_SUFFIXES": ITEM_BLOCK_SUFFIXES,
  "nameMatchesItem": nameMatchesItem,
  "stripNamespace": stripNamespace,
  "sameItem": sameItem,
  "isPlayerBuilt": isPlayerBuilt,
  "waitForBlock": waitForBlock,
  "runLookup": runLookup,
  bind,
  rebind,
};
