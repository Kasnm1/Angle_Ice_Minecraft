'use strict';

/**
 * 本能层 —— 不过大脑、不过脑干，身体自己做的事（主人 2026-09-27）。
 *
 * ## 和 reflex.js / decision.js 的区别
 *
 *   reflex.js    脑干里的反射（吃、上浮）：1.5s 一拍，走 HTTP，mind 醒着时也跑
 *   decision.js  脑干的决策：mind 持有身体时整个关掉
 *   instinct.js  **bridge 进程里**，直接挂在 bot 上，不走 HTTP、不等任何人
 *
 * 为什么放在 bridge：mind 想一次要 8–20 秒，脑干一拍 450ms–1.5s。
 * 地上掉了东西、怪扑过来，这些事等不了。离 bot 最近的地方反应最快。
 *
 * ## 身体归属（最要紧的规矩）
 *
 *   · 本能只在**身体空着**时出手：没有命令在跑（inflight=0、currentAction 为空），
 *     或者只是在跟着玩家走（跟随被打断后本能负责接回去）。
 *   · **任何命令一到，本能立刻让出身体**：bridge 的路由在执行 POST 之前先 `await yieldBody()`
 *     —— 打断、等它收干净，再执行命令。所以本能永远不会和 mind / 脑干的命令抢同一只手。
 *   · `/stop {hold:true}` = "站着别动"：之后一段时间本能也不动（不能主人刚喊停，她转身就去捡东西）。
 *     不带 hold 的 /stop 只是"停下换件事"（mind 换任务、看门狗脱困都这么用），不静默。
 *
 * ## 拾取本能
 *
 * 地上有东西、身体空着 → 走过去捡。**走路和捡的全部细节交给现有的 `POST /pickup`**
 * （那里踩过 P25/P30/P32/P33/P38/P43 一长串坑），本能只决定"捡不捡、捡哪几堆"。
 *
 * 不捡的：
 *   · 刚落地的（< settleMs）—— 还在飞/滚，而且挖矿掉落有拾取延迟
 *   · **玩家（包括她自己）扔出来的** —— 那是别人的东西，或者是她自己丢掉/给人的。
 *     判据：实体刷出时的位置就在某个玩家的眼前（扔出的物品从眼睛高度 -0.3 处生成）。
 *     给她的东西扔到她脚边，走过去本来就会捡到；真要她去捡，mind 会调 /pickup。
 *   · 背包装不下的（没空格，且没有同名未满的堆）
 *   · 同一堆试了 2 次都没捡到的 —— 60 秒内不再试（够不着的坑底、岩浆边）
 *   · 身边有冲她来的怪、或者血 ≤ 6 —— 这时候不该弯腰捡东西
 *   · 跟随中：只捡离玩家不远的（不能为了一块圆石把人跟丢）
 *   · 夜里在露天：只捡 nightOutRadius 格内的（不为一块圆石往黑处跑）
 */

const CFG = {
  pickup: {
    enabled: process.env.MC_INSTINCT_PICKUP !== 'false',
    tickMs: 400,
    radius: 8,              // 水平几格内的掉落物才管
    maxDy: 3,               // 高低差超过这个不管（楼上楼下、悬崖底）
    followRadius: 6,        // 跟随中：离她几格内
    followLeash: 8,         // 跟随中：离玩家几格内（捡完还追得上）
    nightOutRadius: 4,      // 夜里在露天：只捡脚边的，不往黑处跑（night.js）
    settleMs: 1000,         // 落地多久后才捡
    batch: 4,               // 一次最多走几堆
    maxFails: 2,            // 同一堆失败几次就先放下
    failCooldownMs: 60000,
    quietAfterStopMs: 20000,   // /stop 之后多久不动
    minHealth: 7,
    threatRadius: 12,       // 这么近有冲她来的怪就不捡
    thrownRadius: 0.6,      // 刷出点离某个玩家的"出手点"这么近 = 被扔出来的
    timeoutMs: 6000,        // 每堆的寻路超时（/pickup 的 timeoutMs）
  },
  yieldWaitMs: 1500,        // 让出身体时最多等本能收拾多久
};

// ------------------------------------------------------------------ 纯判据（可自测）

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 物品刷出时是不是从某个玩家手里扔出来的。
 * 原版 `Player.drop()`：生成点 = 眼睛高度 - 0.3（站立时脚底 +1.32，潜行 +1.27-0.3），水平就在玩家身上。
 * 挖方块掉的在方块中心 ±0.25（离玩家至少 ~0.75），怪死掉的在怪脚下 —— 都不会落在这个小圈里。
 */
function isThrownBy (spawnPos, playerPositions, radius = CFG.pickup.thrownRadius) {
  if (!spawnPos) return false;
  for (const p of playerPositions) {
    if (!p) continue;
    const dy = spawnPos.y - (p.y + 1.32);
    if (hdist(spawnPos, p) <= radius && dy >= -0.5 && dy <= 0.3) return true;
  }
  return false;
}

/**
 * 捡不捡、捡哪几堆。
 *
 * @param ctx.self       { x, y, z }   她的脚底
 * @param ctx.drops      [{ id, pos, ageMs, thrown, item }]  item = 物品名或 null（读不到）
 * @param ctx.following  { pos } | null   正在跟的玩家
 * @param ctx.fails      Map id → { n, until }
 * @param ctx.canHold    (itemName|null) → boolean
 * @param ctx.now
 * @returns { ids: number[] } | { skip: string }   skip 写明为什么不捡（调试用，/instinct 看得到）
 */
function pickPickup (ctx, cfg = CFG.pickup) {
  const { self, drops = [], following = null, fails = new Map(), canHold = () => true, now = Date.now() } = ctx;
  if (!self) return { skip: '没有位置' };
  const radius = following ? cfg.followRadius : cfg.radius;
  const why = { young: 0, thrown: 0, far: 0, full: 0, failed: 0 };
  const ok = [];
  for (const d of drops) {
    if (!d?.pos) continue;
    if (d.ageMs < cfg.settleMs) { why.young++; continue; }
    if (d.thrown) { why.thrown++; continue; }
    const dist = hdist(d.pos, self);
    if (dist > radius || Math.abs(d.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (following && hdist(d.pos, following.pos) > cfg.followLeash) { why.far++; continue; }
    const f = fails.get(d.id);
    if (f && f.n >= cfg.maxFails && now < f.until) { why.failed++; continue; }
    if (!canHold(d.item)) { why.full++; continue; }
    ok.push({ id: d.id, dist });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: parts.length ? `有掉落物但都不捡（${parts.join(' ')}）` : '附近没有掉落物' };
  }
  ok.sort((a, b) => a.dist - b.dist);
  return { ids: ok.slice(0, cfg.batch).map(o => o.id) };
}

/**
 * 身体空不空。返回 null = 空着；否则是一句"为什么不空"。
 * following 的时候算空（本能会打断跟随，干完再接上）。
 */
function bodyBusy ({ inflight = 0, currentAction = null, windowOpen = false, quietUntil = 0, now = Date.now() }) {
  if (inflight > 0) return `有 ${inflight} 个命令在跑`;
  if (windowOpen) return '开着界面';
  if (now < quietUntil) return '刚被叫停，站着别动';
  if (currentAction && !/^following /.test(currentAction)) return `在忙：${currentAction}`;
  return null;
}

// ------------------------------------------------------------------ 挂到 bot 上

/**
 * @param deps.handlers      bridge 的路由表（调 'POST /pickup'）
 * @param deps.hands         hands.js（接回跟随）
 * @param deps.isDropEntity / droppedItemOf / aggroOf   bridge 里的那一份（同一判据只写一处）
 */
function install (bot, state, deps) {
  const I = state.instinct = state.instinct || {
    cfg: { pickup: { ...CFG.pickup } },
    inflight: 0,
    quietUntil: 0,
    running: null,      // { kind, abort(), done: Promise }
    last: null,         // 最近一次判断（为什么捡 / 为什么不捡）
    log: [],            // 最近做过的事
  };
  const spawned = new Map();   // 掉落物 id → { t, thrown }
  const fails = new Map();

  bot.on('entitySpawn', (e) => {
    try {
      if (!deps.isDropEntity(e)) return;
      const players = Object.values(bot.players || {}).map(p => p.entity?.position).filter(Boolean);
      spawned.set(e.id, { t: Date.now(), thrown: isThrownBy(e.position, players) });
    } catch (_) {}
  });
  bot.on('entityGone', (e) => { spawned.delete(e?.id); fails.delete(e?.id); });

  const note = (entry) => {
    I.log.push({ t: Date.now(), ...entry });
    if (I.log.length > 30) I.log.shift();
  };

  function canHold (itemName) {
    try {
      if (bot.inventory.emptySlotCount() > 0) return true;
      if (!itemName) return false;   // 读不出是什么，又没有空格 —— 保守：不去
      return bot.inventory.items().some(i => i.name === itemName && i.count < (i.stackSize || 64));
    } catch (_) { return false; }
  }

  function threatened () {
    const self = bot.entity;
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === self || e.type === 'player') continue;
      if (e.position.distanceTo(self.position) > I.cfg.pickup.threatRadius) continue;
      const a = deps.aggroOf(e);
      if (a && a.on === 'me') return `${e.name} 冲她来了`;
    }
    return null;
  }

  async function runPickup (ids, followName) {
    let aborted = false;
    const endLedger = state.ledger ? state.ledger.begin({ instinct: 'pickup' }) : null;   // 这期间多出来的记成"捡到"
    const done = (async () => {
      const before = ids.slice();
      let r = null;
      try {
        r = await deps.handlers['POST /pickup']({
          ids, count: ids.length, radius: I.cfg.pickup.radius + 2,
          timeoutMs: I.cfg.pickup.timeoutMs, abort: () => aborted,
        });
      } catch (e) {
        r = { error: e.message };
      }
      // 还在地上的 = 没捡到（被别人捡走/消失的会先触发 entityGone，不算她失败）
      for (const id of before) {
        if (!bot.entities[id]) continue;
        const f = fails.get(id) || { n: 0, until: 0 };
        f.n++; f.until = Date.now() + I.cfg.pickup.failCooldownMs;
        fails.set(id, f);
      }
      note({ kind: 'pickup', aborted: aborted || undefined, ids: before.length, picked: r?.picked ?? 0, error: r?.error });
      // 本来在跟人：接着跟（被命令打断的不接 —— 命令说了算）
      if (followName && !aborted && !state.currentAction && bot.players[followName]?.entity) {
        try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {}
      }
    })();
    I.running = { kind: 'pickup', abort: () => { aborted = true; try { bot.pathfinder.stop(); } catch (_) {} }, done };
    try { await done; } finally {
      I.running = null;
      if (endLedger) { endLedger(); state.ledgerKick?.(); }
    }
  }

  async function tick () {
    const P = I.cfg.pickup;
    if (!P.enabled || I.running || !bot.entity) return;
    const busy = bodyBusy({
      inflight: I.inflight, currentAction: state.currentAction,
      windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil,
    });
    if (busy) { I.last = { t: Date.now(), skip: busy }; return; }
    if ((bot.health ?? 20) < P.minHealth) { I.last = { t: Date.now(), skip: `血 ${bot.health}，不弯腰` }; return; }
    const danger = threatened();
    if (danger) { I.last = { t: Date.now(), skip: danger }; return; }

    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    const followEnt = followName ? bot.players[followName]?.entity : null;
    const now = Date.now();
    const drops = Object.values(bot.entities)
      .filter(e => e?.position && e.isValid !== false && deps.isDropEntity(e))
      .map(e => {
        const s = spawned.get(e.id);
        // 本能装上之前就在地上的：没有刷出记录，当作早就落地、不是扔的
        return {
          id: e.id, pos: e.position,
          ageMs: s ? now - s.t : Infinity,
          thrown: s ? s.thrown : false,
          item: deps.droppedItemOf(e)?.name ?? null,
        };
      });
    // 夜里在露天：半径收到脚边
    let cfg = P;
    try {
      const ph = deps.night?.phaseOf(bot.time?.timeOfDay);
      if ((ph === 'night' || ph === 'dusk') && deps.night.isOut(deps.exposureOf(bot)?.kind)) {
        cfg = { ...P, radius: Math.min(P.radius, P.nightOutRadius), followRadius: Math.min(P.followRadius, P.nightOutRadius) };
      }
    } catch (_) {}
    const pick = pickPickup({
      self: bot.entity.position, drops, fails, canHold, now,
      following: followEnt ? { pos: followEnt.position } : null,
    }, cfg);
    I.last = { t: now, ...pick };
    if (pick.ids) await runPickup(pick.ids, followName);
  }

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await tick(); } catch (e) { I.last = { t: Date.now(), error: e.message }; } finally { ticking = false; }
  }, CFG.pickup.tickMs);
  bot.once('end', () => clearInterval(timer));
}

/**
 * 命令来了：本能让出身体。bridge 路由在执行会动身体的 POST 之前调用。
 * 打断正在做的本能，并等它收拾干净（最多 yieldWaitMs）—— 不然它的 finally 会清掉新命令刚设的寻路目标。
 */
async function yieldBody (state, key, args = {}) {
  const I = state.instinct;
  if (!I) return;
  // 只有明说"站住"（hold）才静默。mind 换任务前、脑干看门狗脱困时也会调 /stop —— 那是"换件事"，不是"别动"。
  if (key === 'POST /stop' && args?.hold) I.quietUntil = Date.now() + I.cfg.pickup.quietAfterStopMs;
  const r = I.running;
  if (!r) return;
  r.abort();
  await Promise.race([r.done.catch(() => {}), new Promise(res => setTimeout(res, CFG.yieldWaitMs))]);
}

/** 不碰身体的 POST —— 不需要让本能停下 */
const PASSIVE_POSTS = new Set([
  'POST /chat', 'POST /instinct', 'POST /knowledge/search', 'POST /registry/import-palette', 'POST /reconnect',
  'POST /look', 'POST /memory', 'POST /project/save', 'POST /doors/forget-left-open',
]);

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  const P = CFG.pickup;
  const me = { x: 0.5, y: 64, z: 0.5 };
  const d = (id, x, z, extra = {}) => ({ id, pos: { x, y: 64, z }, ageMs: 5000, thrown: false, item: 'cobblestone', ...extra });

  // ---- 扔出来的判定 ----
  const owner = { x: 5.5, y: 64, z: 0.5 };
  check('★ 从玩家眼前生成 → 扔的', isThrownBy({ x: 5.6, y: 65.32, z: 0.5 }, [owner]), true);
  check('她自己丢的也算（自己在列表里）', isThrownBy({ x: 0.5, y: 65.3, z: 0.4 }, [me]), true);
  check('挖旁边的方块掉的（方块中心 ±0.25）→ 不是扔的', isThrownBy({ x: 6.75, y: 65.5, z: 0.5 }, [owner]), false);
  check('怪死在玩家脚边掉的（脚底高度）→ 不是扔的', isThrownBy({ x: 5.6, y: 64.1, z: 0.5 }, [owner]), false);

  // ---- 挑哪几堆 ----
  check('附近一堆 → 捡', pickPickup({ self: me, drops: [d(1, 3, 0)] }).ids?.[0], 1);
  check('刚落地 → 等等', pickPickup({ self: me, drops: [d(1, 3, 0, { ageMs: 200 })] }).ids, undefined);
  check('★ 玩家扔的 → 不捡', pickPickup({ self: me, drops: [d(1, 3, 0, { thrown: true })] }).ids, undefined);
  check('太远 → 不管', pickPickup({ self: me, drops: [d(1, 20, 0)] }).ids, undefined);
  check('楼下 5 格 → 不管', pickPickup({ self: me, drops: [{ ...d(1, 2, 0), pos: { x: 2, y: 59, z: 0 } }] }).ids, undefined);
  check('装不下 → 不去', pickPickup({ self: me, drops: [d(1, 3, 0)], canHold: () => false }).ids, undefined);
  const fails = new Map([[1, { n: 2, until: 1e12 }]]);
  check('★ 试了两次没捡到 → 先放着', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 0 }).ids, undefined);
  check('冷却过了 → 再试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 2e12 }).ids?.[0], 1);
  check('只失败一次 → 还试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails: new Map([[1, { n: 1, until: 1e12 }]]), now: 0 }).ids?.[0], 1);
  const many = [d(1, 7, 0), d(2, 1, 0), d(3, 4, 0), d(4, 2, 0), d(5, 3, 0), d(6, 5, 0)];
  const r = pickPickup({ self: me, drops: many });
  check('一次最多 batch 堆', r.ids.length, P.batch);
  check('从近到远', r.ids.join(','), '2,4,5,3');
  check('跳过的原因写得出来', /thrown=1/.test(pickPickup({ self: me, drops: [d(1, 3, 0, { thrown: true })] }).skip), true);
  check('没有掉落物 → 如实说没有', pickPickup({ self: me, drops: [] }).skip, '附近没有掉落物');

  // 跟随中：离她近、离玩家也近才捡
  const fol = { pos: { x: 3, y: 64, z: 0 } };
  check('跟随中：玩家身边的 → 捡', pickPickup({ self: me, drops: [d(1, 4, 0)], following: fol }).ids?.[0], 1);
  const folFar = { pos: { x: 6, y: 64, z: 0 } };   // 玩家已经往前走出 6 格
  check('★ 跟随中：离玩家太远的 → 不为它把人跟丢', pickPickup({ self: me, drops: [d(1, -4, 0)], following: folFar }).ids, undefined);

  // ---- 身体空不空 ----
  check('什么都没在做 → 空', bodyBusy({}), null);
  check('跟随中 → 算空（捡完接着跟）', bodyBusy({ currentAction: 'following starwish' }), null);
  check('★ 有命令在跑 → 不空', typeof bodyBusy({ inflight: 1 }), 'string');
  check('在挖矿 → 不空', typeof bodyBusy({ currentAction: 'mining 3x stone' }), 'string');
  check('开着箱子 → 不空', typeof bodyBusy({ windowOpen: true }), 'string');
  check('★ 刚被叫停 → 站着别动', typeof bodyBusy({ quietUntil: 100, now: 50 }), 'string');
  check('停的时间过了 → 空', bodyBusy({ quietUntil: 100, now: 150 }), null);

  // ---- 让出身体 ----
  const st = { instinct: { cfg: { pickup: { ...P } }, running: null, quietUntil: 0 } };
  let aborted = false;
  let finish;
  st.instinct.running = { abort: () => { aborted = true; finish(); }, done: new Promise(res => { finish = res; }) };
  return yieldBody(st, 'POST /move').then(() => {
    check('★ 命令来了 → 本能被打断', aborted, true);
    return yieldBody(st, 'POST /stop');
  }).then(() => {
    check('★ 不带 hold 的 /stop（mind 换任务）→ 不静默', st.instinct.quietUntil, 0);
    return yieldBody(st, 'POST /stop', { hold: true });
  }).then(() => {
    check('/stop {hold} → 一段时间站着别动', st.instinct.quietUntil > Date.now(), true);
    check('chat 不碰身体', PASSIVE_POSTS.has('POST /chat'), true);
    check('pickup 会动身体', PASSIVE_POSTS.has('POST /pickup'), false);
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
  });
}

module.exports = { CFG, isThrownBy, pickPickup, bodyBusy, install, yieldBody, PASSIVE_POSTS, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
