/**
 * routes/body.js —— 从 server.js 的 handlers 表拆出的 6 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const hands = require('../../body/hands.js');
const instinct = require('../../instinct/instinct.js');
const pathing = require('../../world/pathing');
const { pickAutoEquip } = require('../../body/equip-policy.js');   // 拆分时漏搬（原 server.js:48），2026-09-29 补

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleepMs } = require('../../util/time');
const __ns = {};

let MAX_SCAN_BLOCK_POSITIONS;
let handlers;
let state;
let Vec3;
let autoEatPlugin;
let collectBlockPlugin;
let pathfinderPlugin;
let toolPlugin;

function cfg (...a) { return __ns.cfg.apply(null, a); }
function sameItem (...a) { return __ns.sameItem.apply(null, a); }

/**
 * 本文件负责的路由（6 条）：
 *   GET /plugins
 *   GET /entities
 *   POST /look
 *   POST /attack
 *   POST /equip
 *   POST /chat
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'GET /plugins': async () => ({
    loaded: {
      pathfinder: !!pathfinderPlugin,
      tool: !!toolPlugin,
      collectblock: !!collectBlockPlugin,
      autoEat: !!autoEatPlugin,
    },
    // 这三个是**可选**的，缺失只影响对应能力，不影响网桥启动
    optional: ['tool', 'collectblock', 'autoEat'],
    installHint: (toolPlugin && collectBlockPlugin && autoEatPlugin)
      ? null
      : 'cd ~/.workbuddy-ai/skills/minecraft-bridge && '
        + 'npm install mineflayer-auto-eat mineflayer-tool mineflayer-collectblock',
    // 运行时状态（连上才有）
    runtime: {
      autoEat: state.pfAutoEat ?? null,
      // collectblock 自己那份 movements 有没有套上"只绕不拆"与流体防护
      collectBlockPolicy: state.pfCollectFluid ?? null,
    },
    // 物品/方块能力开关，方便一眼看出"为什么她不挖"
    capabilities: {
      allowDig: cfg('MC_ALLOW_DIG', 'false') === 'true',
      autoEatEnabled: cfg('MC_AUTO_EAT', 'true') === 'true',
      autoEatMinHunger: parseInt(cfg('MC_AUTO_EAT_MIN_HUNGER', '16'), 10),
      scanMaxPositions: MAX_SCAN_BLOCK_POSITIONS,
      // ★ P45：口径改了 —— 现在是"读到多少个**非空气方块**"（空气不吃配额）。
      //   旧口径是"走过多少个坐标"，导致她被实心土围着时配额全被空气/土吃光。
      scanBudgetNote: `solids=${MAX_SCAN_BLOCK_POSITIONS}（空气不吃配额），visits=${18513}`,
      scanUsesSort: false,        // ★ P45：已删除"建数组+全排序"，改洋葱遍历
    },
  }),

  // ---- 实体诊断（P8 专用）-----------------------------------------------------
  //
  // 为什么需要它：`/nearby` 报的是**我们加工后的**结论（`isDrop`/`kind`），
  // 而 P8 的症状正是"加工出来的结论全错、且错得一致"（65 个实体全叫 unknown）。
  // 这时候再看加工结果没有意义 —— 必须能看到**原始字段**。
  //
  // 这个端点是只读的、无副作用的，代价是一次 map 遍历。
  // 我宁可在生产代码里留一个诊断口，也不愿意下次再花一小时去猜。
  'GET /entities': async ({ limit = 20 } = {}) => {
    const self = state.bot.entity;
    const all = Object.values(state.bot.entities);
    const rows = all
      .filter(e => e && e !== self)
      .map(e => {
        const pos = e.position;
        return {
          // ---- 身份：这三个字段是我们所有判据的基础 ----
          name: e.name ?? null,
          displayName: e.displayName ?? null,
          type: e.type ?? null,
          // `entityType` 是**服务端下发的原始数字 id**（不经过名字解析）。
          // P8 的关键就在这里：如果它是个正常数字，说明是"名字解析"坏了；
          // 如果它是 undefined/0，说明"类型同步"本身就坏了。
          entityType: e.entityType ?? null,
          // mineflayer 按 id 反查出来的注册表条目（名字解析的结果）
          registryName: (() => {
            try {
              const t = e.entityType;
              if (t == null) return null;
              return state.bot.registry.entities?.[t]?.name ?? null;
            } catch (_) { return null; }
          })(),
          // ---- 位置与存活 ----
          distance: pos && self?.position ? Math.round(pos.distanceTo(self.position) * 10) / 10 : null,
          position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
          isValid: e.isValid !== false,
          // ---- 我们当前用的判据的**原材料** ----
          // 掉落物的物品 id 藏在 metadata 里。`/collect` 一直就是这么解析的，
          // 这条路**不依赖 name**  —— 见 field-log P8。
          metadataItemId: e.metadata?.[8]?.itemId ?? null,
          metadataItemName: (() => {
            const id = e.metadata?.[8]?.itemId;
            if (id == null) return null;
            try { return state.bot.registry.items?.[id]?.name ?? null; } catch (_) { return null; }
          })(),
          // 生物会带生命值（metadata index 9 通常是 health，随版本/实体有差异）
          metadataHealth: e.metadata?.[9] ?? null,
          health: e.health ?? null,
          // 实体有没有"打过我们"这类信息（用于判断敌意）
          objectData: e.objectData ?? null,
          metadataKeys: e.metadata ? Object.keys(e.metadata).length : 0,
        };
      })
      .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
      .slice(0, Math.min(Math.max(1, +limit), 100));

    const named = rows.filter(r => r.name && r.name !== 'unknown').length;
    return {
      total: all.length,
      sampled: rows.length,
      // ⚠️ 这两个数字放在最显眼处：P8 的教训是"全是 unknown"这件事
      //    在单个字段里看不出来（每个字段单独看都很正常），
      //    只有把它**聚合成比例**才刺眼。
      namedCount: named,
      unknownCount: rows.length - named,
      namedRatio: rows.length ? Math.round((named / rows.length) * 1000) / 1000 : null,
      registryEntityCount: (() => {
        try { return Object.keys(state.bot.registry.entities || {}).length; } catch (_) { return null; }
      })(),
      // 实体表（模组生物补名）与仇恨：实机核对用。snapshot=null 是"没收到表"，named=0 是"收到了但还没刷出模组怪"
      entitySense: {
        snapshot: state.entitySnapshot ? { entries: state.entitySnapshot.entryCount, capturedAt: state.entitySnapshot.capturedAt } : null,
        index: state.entityIndex ? { ok: state.entityIndex.idx.ok, reason: state.entityIndex.idx.reason, modded: state.entityIndex.idx.modded } : null,
        named: state.entityIndex?.named ?? 0,
        lastAggro: state.lastAggro || null,
      },
      rows,
    };
  },

  // 转头看向某个玩家或坐标
  'POST /look': async ({ playerName, x, y, z }) => {    if (playerName) {
      const t = state.bot.players[playerName]?.entity;
      if (!t) throw new Error(`Player ${playerName} not found or too far away`);
      await state.bot.lookAt(t.position.offset(0, t.height ? t.height * 0.9 : 1.6, 0), true);
      return { lookingAt: playerName };
    }
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('either playerName, or all of x/y/z, required');
    }
    await state.bot.lookAt(new Vec3(+x, +y, +z), true);
    return { lookingAt: { x: +x, y: +y, z: +z } };
  },

  // 近战攻击：搜索半径只用来找目标；真正挥击前必须走到近战距离。
  // 旧实现把 radius（最多 16 格）同时当成攻击距离，导致她站在原地隔空杀动物，
  // 语言却说“追过去”——动作记录与事实不一致，也会被服务器的宽松校验掩盖。
  'POST /attack': async ({ target, radius = 4 }) => {
    radius = Math.min(Math.max(1, +radius), 16);
    const HOSTILE = new Set([
      'skeleton', 'zombie', 'spider', 'creeper', 'witch', 'enderman', 'husk', 'stray',
      'drowned', 'phantom', 'pillager', 'vindicator', 'ravager', 'slime', 'magma_cube',
      'blaze', 'ghast', 'wither_skeleton', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin',
    ]);
    const self = state.bot.entity;
    const candidates = Object.values(state.bot.entities)
      .filter(e => e !== self && e.position && e.isValid !== false)
      .filter(e => e.position.distanceTo(self.position) <= radius)
      .filter(e => (target ? e.name === target : HOSTILE.has(e.name)))
      .sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position));

    if (!candidates.length) {
      return { ok: false, attacked: 0, message: target ? `no ${target} within ${radius}` : `no hostile mob within ${radius}` };
    }

    const victim = candidates[0];
    const reach = 3.0;
    const distance = () => victim?.position && state.bot.entity?.position
      ? victim.position.distanceTo(state.bot.entity.position)
      : Infinity;
    const startDistance = distance();
    const approaches = [];
    const failures = [];

    state.currentAction = `attacking ${target || 'hostile mob'}`;
    // 追逐动物属于普通走路，绝不能为了贴近目标垫方块或原地起柱。
    state.noScaffoldDepth = (state.noScaffoldDepth || 0) + 1;
    try { pathing.setScaffold(state.bot.pathfinder?.movements, {}); } catch (_) {}
    let hits = 0;
    let lastHitDistance = null;
    try {
      for (let i = 0; i < 6; i++) {
        if (victim.isValid === false || !victim.position) break;

        // 动物会走动，所以每次挥击前重新量距离；最多从当前位置重算三次路线。
        for (let attempt = 0; distance() > reach && attempt < 3; attempt++) {
          const before = distance();
          const p = victim.position.floored();
          try {
            const moved = await handlers['POST /go']({ x: p.x, y: p.y, z: p.z, range: 1.7, maxMs: 15000 });
            approaches.push({ before: +before.toFixed(1), after: +distance().toFixed(1), arrived: moved?.arrived === true });
          } catch (e) {
            failures.push(`走近目标失败：${e.message}`);
            break;
          }
        }

        const atHit = distance();
        if (atHit > reach) {
          failures.push(`仍离目标 ${Number.isFinite(atHit) ? atHit.toFixed(1) : '?'} 格，未发送远距攻击`);
          break;
        }
        try {
          await state.bot.lookAt(victim.position.offset(0, victim.height ? victim.height * 0.6 : 0.9, 0), true);
        } catch (_) {}
        state.bot.attack(victim);
        hits++;
        lastHitDistance = atHit;
        await new Promise(r => setTimeout(r, instinct.attackCooldownMs(state.bot.heldItem?.name)));
      }
    } finally {
      state.noScaffoldDepth = Math.max(0, (state.noScaffoldDepth || 1) - 1);
      state.currentAction = null;
    }
    return {
      attacked: hits,
      targets: [victim.name],
      approached: approaches.length > 0,
      startDistance: +startDistance.toFixed(1),
      hitDistance: lastHitDistance == null ? null : +lastHitDistance.toFixed(1),
      targetGone: victim.isValid === false,
      approaches,
      failures,
      ok: hits > 0,
    };
  },

  // 从背包装备物品：destination = hand | off-hand | head | torso | legs | feet
  //
  // 两种用法：
  //   ① `{ itemName: 'diamond_pickaxe' }` —— 明确指定换哪件（原行为，未变）
  //   ② `{ auto: true, want: 'tool'|'weapon'|'any' }` —— 让服务端**按当下情境**决定
  //
  // 为什么要有 ②：判据只能住在看得见 `heldItem` 的那一侧。本能在决策时
  // 只表达"我想换"（它没有"换哪件"这个维度），
  // 真正的挑选在 equip-policy.js 的 `pickAutoEquip` 里，可离线穷举。
  'POST /equip': async ({ itemName, destination = 'hand', auto = false, want = 'any' }) => {
    if (auto) {
      const held = state.bot.heldItem?.name ?? null;
      const inventory = state.bot.inventory.items().map(i => i.name);
      const pick = pickAutoEquip({ held, inventory, want });
      if (!pick.itemName) {
        return { equipped: null, held, reason: pick.reason, changed: false };
      }
      const item = state.bot.inventory.items().find(i => i.name === pick.itemName);
      if (!item) {
        // 理论上到不了这里（名字刚从这个列表里取出）。留着是为了不静默。
        return { equipped: null, held, reason: `背包里找不到 ${pick.itemName}`, changed: false };
      }
      await state.bot.equip(item, destination);
      return {
        equipped: pick.itemName,
        itemName: pick.itemName,
        from: held,
        destination,
        reason: pick.reason,
        changed: true,
      };
    }
    if (!itemName) throw new Error('itemName required（或传 auto: true）');
    // 精妙背包里的东西也算"随身"（N-9）：手上没有先从背包拿上来，再判"没有"。
    // 拿不到时 hands.ensureCarried 会区分「背包里也没有」与「背包读不到」—— 后者不能说成 Not carrying。
    if (!state.bot.inventory.items().some(i => sameItem(i.name, itemName))) {
      const got = await hands.ensureCarried(state.bot, state, itemName, 1);
      if (got.source === 'unknown') throw new Error(`拿不到 ${itemName}：${got.why}`);
    }
    const item = state.bot.inventory.items().find(i => sameItem(i.name, itemName));
    if (!item) throw new Error(`Not carrying ${itemName}`);
    await state.bot.equip(item, destination);
    return { equipped: itemName, itemName, destination, changed: true };
  },

  // 发聊天。两种用法（向后兼容）：
  //   {message}               一条（旧调用方、危险提示都走这个 —— 不拆）
  //   {messages:[..], gapMs}  几条短消息连发，条间有停顿（真人打字是"几条短句"，不是"一段话"，见 speech.js）
  //   gapMs 可以是数字，也可以是 [最小,最大] 区间（每次随机 —— 固定间隔反而机械）
  //
  // 她开口说话也算一次互动（主人 2026-09-28："只有说话或者互动的时候需要看他"）——
  // 通知本能，对 16 格内最近的玩家开一个短暂的"可以看他"窗口；窗口外本能不主动转头。
  'POST /chat': async ({ message, messages, gapMs }) => {
    if (message) {
      state.bot.chat(String(message).slice(0, 256));
      try { state.instinct?.noteSelfSpoke?.(); } catch (_) {}
      return { sent: 1, messages: [String(message).slice(0, 256)] };
    }
    if (!Array.isArray(messages) || !messages.length) throw new Error('需要 message 或 messages[]');
    const pick = () => {
      if (Array.isArray(gapMs)) { const [a, b] = gapMs.map(Number); return a + Math.random() * Math.max(0, b - a); }
      return +gapMs || 450;
    };
    const sent = [];
    for (const m of messages) {
      const t = String(m || '').slice(0, 256);
      if (!t.trim()) continue;                      // 空段跳过，不发空消息
      if (sent.length) await sleepMs(Math.max(0, Math.min(2000, pick())));
      state.bot.chat(t);
      sent.push(t);
    }
    if (sent.length) { try { state.instinct?.noteSelfSpoke?.(); } catch (_) {} }
    return { sent: sent.length, messages: sent };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.MAX_SCAN_BLOCK_POSITIONS !== undefined) MAX_SCAN_BLOCK_POSITIONS = ns.MAX_SCAN_BLOCK_POSITIONS;
  if (ns.cfg !== undefined) cfg = ns.cfg;
  if (ns.handlers !== undefined) handlers = ns.handlers;
  if (ns.sameItem !== undefined) sameItem = ns.sameItem;
  // 第 4 步去重：sleep/sleepMs 已改为 require 的 const，这句 bind 重赋值会报常量赋值错误 —— 删掉。
  if (ns.state !== undefined) state = ns.state;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  Vec3 = ns.Vec3;
  autoEatPlugin = ns.autoEatPlugin;
  collectBlockPlugin = ns.collectBlockPlugin;
  pathfinderPlugin = ns.pathfinderPlugin;
  toolPlugin = ns.toolPlugin;
}

module.exports = {
  routes,
  keys: ["GET /plugins","GET /entities","POST /look","POST /attack","POST /equip","POST /chat"],
  bind,
  rebind,
 };
