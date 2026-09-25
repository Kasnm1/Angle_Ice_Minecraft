'use strict';

/**
 * 反射层 —— 不需要过大脑就能活下来的那部分。
 *
 * ## 为什么要有这一层
 *
 * 原来的结构是：`tick()` 每 1.5 秒跑一次「感知 → decision.js 问后端 → 执行」。
 * 所有行为**都必须过一遍后端**，包括"饿了要吃饭"这种根本不需要思考的事。
 *
 * 对标的两个项目都有一层不走 LLM 的反射：
 *
 *   · **HiyoriAI** `reflexEngine.ts`：`food <= 6 && hasFood` → 直接返回
 *     `[{id:'reflex:eat', name:'eat', args:{}}]`，**一次 LLM 调用都没有**。
 *     它用一个 `hungerActive` 闩锁保证"进入 ≤6 触发一次、涨回 >12 才复位"。
 *   · **Mindcraft** `modes.js`：`self_preservation` / `unstuck` / `cowardice` /
 *     `self_defense` / `item_collecting` 五个 mode，每个 tick 独立判断，
 *     命中就 `execute()`，**不等主循环**。注释写得很清楚：
 *     「update 函数虽然 async，但**不应 await 超过 100ms**，否则会阻塞更新循环」。
 *
 * ## 这一层与 decision.js 的关系（关键设计）
 *
 * 反射**先跑**，命中就**短路**本次 tick —— 不构造菜单、不问后端。
 * 理由：饿着肚子问"我该不该吃饭"这件事本身就不合理，而且后端是网络往返（最慢的那环）。
 *
 * ⚠️ 反射**不做**这些事（留给 decision.js）：
 *   · 不逃跑（"逃跑 vs 反击"是需要权衡的，不是反射）
 *   · 不打架（同上）
 *   · 不合成分东西（多步骤，要走目标控制）
 * 反射只做**无争议、无代价、不需要权衡**的事。
 *
 * ## 为什么用闩锁而不是"每个 tick 都触发"
 *
 * 没有闩锁的话，"饿"这个条件在吃饱之前一直成立 → 每个 tick 都发起一次吃 →
 * 一个 tick 内多次 `eat()` 并发打在同一个 bot 上。HiyoriAI 用 `hungerActive`
 * 解决，我们也用。**这是很多人会写错的地方**：条件判断看起来对，但没有状态记忆。
 */

// --------------------------------------------------------------------- 配置

const CFG = {
  // 饥饿值低于这个就开始吃。
  // 抄 HiyoriAI 的 `reflexEngine` 用的是 6（"快饿死了"），
  // 但 auto-eat 插件的阈值是 16（"提前吃"）。两个数字**不冲突**：
  //   · 插件 16：后台常驻，机会主义地吃，玩家不会察觉
  //   · 反射 6：插件没装 / 被关掉时的**兜底**，这是要出人命的阈值
  // 反射阈值必须**低于**插件阈值，否则两者会抢同一件事（插件刚要吃、反射又发起一次）。
  eatAt: parseInt(process.env.MC_REFLEX_EAT_AT || '6', 10),
  // 饥饿值回到这个以上才复位闩锁。留出滞回区间避免在阈值上反复抖动。
  eatRearmAt: parseInt(process.env.MC_REFLEX_REARM_AT || '12', 10),

  // 氧气低于这个就往上浮。原版氧气上限 300 tick（≈15 秒），
  // 10 是"还剩一半多就要动"，因为上浮本身要时间。
  breatheAt: parseInt(process.env.MC_REFLEX_BREATHE_AT || '10', 10),

  // 着火时如果身上没水，至少别站着烧 —— 跑开。
  // 只在"脚下方块也是火/岩浆"时才跑；单纯着火（被火焰弹打中）跑没用。
  fireFleeMs: 3000,

  // 反射被禁用的总开关（调试用）。`MC_REFLEX=false` 时本模块全部空转。
  enabled: process.env.MC_REFLEX !== 'false',
};

/** 认得出的食物名。**只是"能不能吃"的粗筛**，真正的判断走 `foodPoints`。
 *  列在这里是为了在 `foodPoints` 缺失时（老版本 mineflayer）还能有个兜底。 */
const FOOD_FALLBACK = new Set([
  'apple', 'baked_potato', 'bread', 'cooked_beef', 'cooked_chicken',
  'cooked_mutton', 'cooked_porkchop', 'cooked_salmon', 'cooked_cod',
  'carrot', 'golden_apple', 'golden_carrot', 'melon_slice', 'sweet_berries',
  'cooked_rabbit', 'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'cookie',
  'dried_kelp', 'pumpkin_pie', 'beetroot', 'potato', 'poisonous_potato',
]);

// --------------------------------------------------------------- 闩锁状态

/**
 * 每个反射一个闩锁。
 *
 * ⚠️ 为什么闩锁放在**模块级**而不是每次调用新建：
 *    它的语义就是"跨 tick 记住状态"。放在函数里等于没有。
 *    这也意味着这个模块是**有状态**的，`reset()` 在重连时要调。
 */
const latches = {
  hunger: false,      // true = 已经触发过吃，等饥饿值回涨才复位
  breathe: false,     // true = 已经触发过上浮
  fire: false,        // true = 已经触发过躲火
};

/**
 * 统计。和 `autopilot.js` 的 ears 统计同一个理由：
 * "反射层在跑但没触发"和"反射层根本没跑"从外部看起来一样，
 * 必须有计数器才能分辨。`GET /autopilot` 会读它。
 */
const stats = {
  evaluations: 0,     // 评估过多少次
  fired: 0,           // 触发过多少次
  lastFired: null,    // { id, at, reason }
  lastSkip: null,     // { id, reason } —— 为什么没触发（排查"她为什么不吃"）
  byKind: {},         // { eat: 3, breathe: 1 }
};

/** 重连 / 状态重置时调。闩锁不清会让"她憋着气浮上来后永远不再浮"。 */
function reset () {
  latches.hunger = false;
  latches.breathe = false;
  latches.fire = false;
}

function snapshot () {
  return {
    enabled: CFG.enabled,
    eatAt: CFG.eatAt,
    eatRearmAt: CFG.eatRearmAt,
    breatheAt: CFG.breatheAt,
    latches: { ...latches },
    stats: { ...stats, byKind: { ...stats.byKind } },
  };
}

// ----------------------------------------------------------------- 工具

/** 从某个物品里读出食物值。`foodPoints` 是官方字段；缺失时退回名字白名单。 */
function foodValue (item) {
  if (!item) return 0;
  if (typeof item.foodPoints === 'number' && item.foodPoints > 0) return item.foodPoints;
  const bare = String(item.name || '').replace(/^[^:]*:/, '');
  return FOOD_FALLBACK.has(bare) ? 1 : 0;   // 白名单命中给个 1（够用即可，只用于排序）
}

/** 背包里最好吃的东西。按"总回复量"排（食物值 × 数量），吃得少、回得多优先。 */
function bestFood (inventory) {
  const items = (inventory || []).filter(i => foodValue(i) > 0);
  if (!items.length) return null;
  return items.sort((a, b) => (foodValue(b) * b.count) - (foodValue(a) * a.count))[0];
}

// ------------------------------------------------------------------ 反射

/**
 * 每个反射的形状：
 *   {
 *     id:      唯一名（写进 events.jsonl 和 /autopilot）
 *     name:    bridge 动作名（autopilot 会把它当作一次动作执行）
 *     args:    动作参数
 *     reason:  人话，用来解释"她为什么突然吃东西"
 *   }
 *
 * 返回 null 表示"这个反射没触发"。
 */

/**
 * ① 饥饿 → 吃。
 *
 * 有意做得比插件保守（6 vs 16）：这条是**兜底**，正常情况下 auto-eat 插件的
 * 16 会先把它截胡，所以它几乎不该触发。**如果它频繁触发，说明插件没工作** ——
 * 那正是我们想通过统计看见的事。
 */
function reflexEat (st, inventory) {
  const food = st.food;

  // 先处理复位：涨到 rearm 以上就把闩锁放开，允许下一次触发
  if (latches.hunger && food != null && food > CFG.eatRearmAt) {
    latches.hunger = false;
  }

  if (food == null) return null;
  if (food > CFG.eatAt) return null;

  if (latches.hunger) {
    stats.lastSkip = { id: 'reflex:eat', reason: `还在闩锁里（food=${food}，要涨到 ${CFG.eatRearmAt} 以上才复位）` };
    return null;
  }

  const food_item = bestFood(inventory);
  if (!food_item) {
    stats.lastSkip = { id: 'reflex:eat', reason: `food=${food} 但背包里没有能吃的东西` };
    return null;
  }

  latches.hunger = true;
  return {
    id: 'reflex:eat',
    name: 'eat',
    args: { itemName: food_item.name },
    reason: `饥饿值 ${food}，背包里有 ${food_item.name}`,
  };
}

/**
 * ② 溺水 → 上浮。
 *
 * ⚠️ 这个反射**必须**存在，因为 `tickMs=1500` 意味着"憋气"最多 1.5 秒才被发现一次，
 *    而后端往返还要再加时间 —— 原版氧气 15 秒能撑住，但整合包里有降低氧气的模组。
 *    上次摘柠檬溺水就是这个场景。
 *
 * 上浮的实现不走 bridge（那是 `POST /jump`，需要她自己会游泳），
 * 直接在 autopilot 里 setControlState —— 所以这里只**发信号**，由 autopilot 执行。
 * 用 `name: 'breathe'` 这个伪动作名标识。
 */
function reflexBreathe (st, _inventory, world) {
  const oxygen = st.oxygen;
  if (oxygen == null) return null;

  if (latches.breathe && oxygen > CFG.breatheAt + 5) latches.breathe = false;
  if (oxygen > CFG.breatheAt) return null;

  if (latches.breathe) {
    stats.lastSkip = { id: 'reflex:breathe', reason: `还在闩锁里（oxygen=${oxygen}）` };
    return null;
  }

  // 头上一格是水才需要浮；站在岸上氧气低是别的模组效果，浮没用
  const head = world?.head;
  if (head && !String(head).includes('water')) {
    stats.lastSkip = { id: 'reflex:breathe', reason: `oxygen=${oxygen} 但头不在水里（head=${head}）` };
    return null;
  }

  latches.breathe = true;
  return {
    id: 'reflex:breathe',
    name: 'breathe',
    args: {},
    reason: `氧气 ${oxygen}，头顶是水`,
  };
}

/**
 * ③ 着火 → 跑开。
 *
 * 只在"她真的站在火/岩浆上"时触发。单纯被火焰弹点燃时逃跑没用
 * （火跟着人走），该做的是找水 —— 那是需要权衡的，留给 decision.js。
 *
 * ⚠️ 这个反射**默认关闭**。理由：判定"站在火上"需要看脚下方块，
 *    而我们没有稳定的方块名（模组服上名字可能整体偏移）。
 *    误判的代价是"她莫名其妙开始乱跑"，比不触发更糟。
 *    要开：`MC_REFLEX_FIRE=true`。
 */
function reflexFire (st, _inventory, world) {
  if (process.env.MC_REFLEX_FIRE !== 'true') return null;

  const below = String(world?.below || '');
  const standing = String(world?.legs || '');
  const onFire = standing.includes('fire') || standing.includes('lava')
    || below.includes('lava');
  if (!onFire) {
    if (latches.fire) latches.fire = false;
    return null;
  }

  if (latches.fire) {
    stats.lastSkip = { id: 'reflex:fire', reason: `还在闩锁里（standing=${standing}）` };
    return null;
  }

  latches.fire = true;
  return {
    id: 'reflex:fire',
    name: 'fleeFire',
    args: {},
    reason: `脚下是 ${standing || below}`,
  };
}

/** 反射表。**顺序即优先级** —— 溺水比饿更急，因为饿能撑几十秒、憋气只能撑十几秒。 */
const REFLEXES = [
  { id: 'reflex:breathe', fn: reflexBreathe },
  { id: 'reflex:fire', fn: reflexFire },
  { id: 'reflex:eat', fn: reflexEat },
];

// --------------------------------------------------------------------- 入口

/**
 * 评估所有反射，返回**第一个**命中的（或 null）。
 *
 * 为什么只返回一个：两个反射同时触发意味着"一边憋气一边饿"，
 * 同时执行会争同一只手（`bot.equip` / `setControlState` 互相打断）。
 * 优先级由 REFLEXES 的顺序决定，一次只做一件事。
 *
 * @param {object} st        状态快照：{ food, health, oxygen }
 * @param {Array}  inventory 背包（`GET /inventory` 的 items 数组）
 * @param {object} world     三格环境：{ below, legs, head }（`GET /scan` 的 standing）
 * @returns {object|null}
 */
function evaluate (st, inventory, world) {
  stats.evaluations++;

  if (!CFG.enabled) {
    stats.lastSkip = { id: null, reason: '反射层已关闭（MC_REFLEX=false）' };
    return null;
  }

  for (const { fn } of REFLEXES) {
    const hit = fn(st || {}, inventory, world);
    if (hit) {
      stats.fired++;
      stats.byKind[hit.id] = (stats.byKind[hit.id] || 0) + 1;
      stats.lastFired = { id: hit.id, at: Date.now(), reason: hit.reason };
      return hit;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 自检

function selftest () {
  let pass = 0, total = 0;
  const check = (name, got, want) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++;
    else console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
    return ok;
  };

  console.log('reflex.js 自检');

  // ---- 吃
  reset(); stats.evaluations = 0; stats.fired = 0; stats.byKind = {}; stats.lastFired = null; stats.lastSkip = null;
  check('满饥饿不触发', evaluate({ food: 20 }, [{ name: 'bread', count: 3, foodPoints: 5 }]), null);
  check('评估计数在涨', stats.evaluations > 0, true);
  check('饿到阈值触发', evaluate({ food: 5 }, [{ name: 'bread', count: 3, foodPoints: 5 }])?.name, 'eat');
  check('触发次数记上了', stats.fired, 1);
  check('闩锁已立', latches.hunger, true);
  check('闩锁期不再重复触发', evaluate({ food: 4 }, [{ name: 'bread', count: 3, foodPoints: 5 }]), null);
  check('没复位时仍在闩锁里', latches.hunger, true);
  evaluate({ food: 13 }, [{ name: 'bread', count: 3, foodPoints: 5 }]);
  check('饥饿涨过复位线才松开', latches.hunger, false);
  check('关节食被拒', evaluate({ food: 3 }, [{ name: 'stone', count: 64 }]), null);
  check('没食物时的原因可查', stats.lastSkip.id, 'reflex:eat');
  check('挑回复量最大的',
    evaluate({ food: 2 }, [
      { name: 'carrot', count: 1, foodPoints: 3 },
      { name: 'cooked_beef', count: 4, foodPoints: 8 },
    ])?.args?.itemName, 'cooked_beef');

  // ---- 水
  reset();
  check('氧气够不触发', evaluate({ food: 20, oxygen: 200 }, [], { head: 'water' }), null);
  check('头在水里 + 缺氧触发',
    evaluate({ food: 20, oxygen: 5 }, [], { head: 'water' })?.name, 'breathe');
  check('水闩锁已立', latches.breathe, true);
  check('闩锁期不重复', evaluate({ food: 20, oxygen: 4 }, [], { head: 'water' }), null);
  reset();
  check('缺氧但头不在水里不触发',
    evaluate({ food: 20, oxygen: 4 }, [], { head: 'air' }), null);

  // ---- 顺序
  reset();
  check('溺水优先于饿', evaluate({ food: 3, oxygen: 5 }, [{ name: 'bread', count: 1, foodPoints: 5 }], { head: 'water' })?.id, 'reflex:breathe');

  // ---- 总开关
  reset();
  const savedEnabled = CFG.enabled;
  CFG.enabled = false;
  check('总开关关掉后全部空转', evaluate({ food: 1, oxygen: 1 }, [{ name: 'bread', count: 1, foodPoints: 5 }], { head: 'water' }), null);
  CFG.enabled = savedEnabled;

  // ---- 火（默认关）
  reset();
  check('火反射默认关闭', evaluate({ food: 20 }, [], { legs: 'fire' }), null);

  // ---- 复位的边界
  reset();
  latches.hunger = true;
  evaluate({ food: 12 }, []);
  check('恰好等于复位线时**不**松开（要严格大于）', latches.hunger, true);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else console.log('用法：node reflex.js --selftest');
}

module.exports = {
  CFG,
  REFLEXES,
  FOOD_FALLBACK,
  evaluate,
  reset,
  snapshot,
  foodValue,
  bestFood,
  _latches: latches,
  _stats: stats,
};
