'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「containers」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3
const { isHostileEntity } = require('../world/entity-registry.js');

const __ns = {};
let REACH;   // 常量：load 完成后由 bind() 回填
function K (...a) { return __ns.K.apply(null, a); }
function applyBoxSnapshot (...a) { return __ns.applyBoxSnapshot.apply(null, a); }
function approach (...a) { return __ns.approach.apply(null, a); }
function botName (...a) { return __ns.botName.apply(null, a); }
function cartKey (...a) { return __ns.cartKey.apply(null, a); }
function click (...a) { return __ns.click.apply(null, a); }
function clickIn (...a) { return __ns.clickIn.apply(null, a); }
function defaultLoadout (...a) { return __ns.defaultLoadout.apply(null, a); }
function delta (...a) { return __ns.delta.apply(null, a); }
function doorKey (...a) { return __ns.doorKey.apply(null, a); }
function eyeDist (...a) { return __ns.eyeDist.apply(null, a); }
function findItem (...a) { return __ns.findItem.apply(null, a); }
function findStorage (...a) { return __ns.findStorage.apply(null, a); }
function foodScore (...a) { return __ns.foodScore.apply(null, a); }
function fullId (...a) { return __ns.fullId.apply(null, a); }
function go (...a) { return __ns.go.apply(null, a); }
function inHomeArea (...a) { return __ns.inHomeArea.apply(null, a); }
function installDoorHabit (...a) { return __ns.installDoorHabit.apply(null, a); }
function invCounts (...a) { return __ns.invCounts.apply(null, a); }
function isDark (...a) { return __ns.isDark.apply(null, a); }
function isLoadoutItem (...a) { return __ns.isLoadoutItem.apply(null, a); }
function summarizeWindow (...a) { return __ns.summarizeWindow.apply(null, a); }   // 拆分时漏了（用在 ...展开里，扫描没看出来），2026-09-29 补
function kitMatch (...a) { return __ns.kitMatch.apply(null, a); }
function knownTierOf (...a) { return __ns.knownTierOf.apply(null, a); }
function lightAt (...a) { return __ns.lightAt.apply(null, a); }
function loadoutTargetShortfall (...a) { return __ns.loadoutTargetShortfall.apply(null, a); }
function locatePlayerInv (...a) { return __ns.locatePlayerInv.apply(null, a); }
function markSeen (...a) { return __ns.markSeen.apply(null, a); }
function mcString (...a) { return __ns.mcString.apply(null, a); }
function pathTo (...a) { return __ns.pathTo.apply(null, a); }
function pickLoadout (...a) { return __ns.pickLoadout.apply(null, a); }
function readSophItem (...a) { return __ns.readSophItem.apply(null, a); }
function readVarInt (...a) { return __ns.readVarInt.apply(null, a); }
function safeToward (...a) { return __ns.safeToward.apply(null, a); }
function safeTransfer (...a) { return __ns.safeTransfer.apply(null, a); }
function seenKeys (...a) { return __ns.seenKeys.apply(null, a); }
function sleep (...a) { return __ns.sleep.apply(null, a); }
function snapshotContainer (...a) { return __ns.snapshotContainer.apply(null, a); }
function sortRange (...a) { return __ns.sortRange.apply(null, a); }
function storageKey (...a) { return __ns.storageKey.apply(null, a); }
function tierOf (...a) { return __ns.tierOf.apply(null, a); }
function use (...a) { return __ns.use.apply(null, a); }
function winInvCount (...a) { return __ns.winInvCount.apply(null, a); }
function withBackpackLock (...a) { return __ns.withBackpackLock.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); REACH = ns.REACH; }

// HSTATE 的唯一一份在汇总 index.js（install(bot,state) 往里写）；
// 这里只接一个 getter，读到的始终是同一份，不会变成副本。
let getHandsState = () => null;
function setHandsState (get) { getHandsState = get; }

function install (bot, state) {
  getHandsState();                       // 只为读一次、确保汇总那份已就位（真正写入在汇总 index.js）
  // 记住"上次站在亮处"的位置：走进暗处又没火把时，知道往哪退
  const brightTimer = setInterval(() => {
    try { if (bot.entity && bot.entity.onGround) { const l = lightAt(bot); if (l && !isDark(l)) state.lastBright = bot.entity.position.floored(); } } catch (_) {}
  }, 2000);
  bot.once('end', () => clearInterval(brightTimer));
  // 合成排错：记下服务器最近发来的背包窗口（0 号）格子更新，看成品格有没有出东西
  state.slotLog = [];

  bot._client.on('window_items', (p) => { if (p.windowId === 0) state.invItems = { t: Date.now(), n: p.items.length, stateId: p.stateId, filled: p.items.map((it, i) => (it && (it.present !== false) && it.itemId != null && it.itemId !== -1 ? `${i}:${it.itemId}x${it.itemCount}` : null)).filter(Boolean) }; });
  bot._client.on('set_slot', (p) => { if (p.windowId === 0 || p.windowId === -2) { state.slotLog.push({ t: Date.now(), slot: p.slot, stateId: p.stateId, item: p.item?.itemId ?? p.item?.present ?? null, count: p.item?.itemCount ?? null }); if (state.slotLog.length > 40) state.slotLog.shift(); } });
  const pw = require('prismarine-windows')(bot.registry);
  const lastItems = new Map();   // windowId → 最近一次 window_items 的格子数（有的界面先发格子后开窗）

  bot._client.prependListener('window_items', (packet) => {
    if (packet.windowId !== 0) lastItems.set(packet.windowId, packet.items.length);
    const w = bot.currentWindow;
    // 是不是我们刚建的通用界面：看 open_window 时留的记号（windowOpen 要等格子同步完才触发，那时就晚了）
    const generic = w && (w.__generic || state.__pendingGeneric?.id === packet.windowId);
    // 精妙背包的格子已经由它自己的通道同步过（带真实格数和"自己的 36 格在哪"）：原版包晚到时不能再按"最后 36 格"改回去（实测：背包界面变成 0 格）
    if (generic && w.id === packet.windowId && !w.__sophisticated && w.slots.length !== packet.items.length) {
      resize(w, packet.items.length);
    }
  });

  bot._client.prependListener('open_window', (packet) => {
    const t = packet.inventoryType;
    let known = null;
    try { known = pw.createWindow(packet.windowId, t, packet.windowTitle, packet.slotCount); } catch (_) {}
    const menuName = typeof t === 'number' ? state.menuById?.get(t) : String(t);
    state.lastWindowInfo = { id: packet.windowId, type: t, menu: menuName || null, known: !!known, at: Date.now() };
    if (known) return;
    // 不认识：给个格子数让 mineflayer 建出通用界面。已知格子数就用真的，否则先占位、等 window_items 再改。
    const total = lastItems.get(packet.windowId);
    packet.slotCount = total ? Math.max(0, total - 36) : 0;
    state.__pendingGeneric = { id: packet.windowId, menu: menuName };
  });

  // ---- Forge 的模组界面不走原版 open_window ------------------------------------
  //
  // 原版方块（箱子、熔炉）用原版的 open_window 开界面，mineflayer 认得。
  // 模组方块几乎都用 Forge 的 NetworkHooks.openScreen —— 走自定义通道 `fml:play`，
  // 发一条 PlayMessages.OpenContainer（带额外数据）。mineflayer 不认识这个通道，
  // 于是**服务器其实已经开了界面，她却以为什么都没发生**（实测：茶壶、绞肉机右键都"没反应"）。
  //
  // 格式（Forge 1.20.1 PlayMessages.OpenContainer#encode，前面一个字节是 SimpleChannel 的消息序号）：
  //   byte 1(OpenContainer) | varint 界面类型 id | varint windowId | string 标题(JSON) | byte[] 额外数据
  // 翻译成一次原版 open_window 事件，后面的格子同步（window_items）本来就走原版包。
  state.recentPayloads = [];
  bot._client.on('custom_payload', (p) => {
    const data = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
    state.recentPayloads.push({ t: Date.now(), channel: p.channel, len: data.length, head: data.subarray(0, 8).toString('hex') });
    if (state.recentPayloads.length > 30) state.recentPayloads.shift();
    if (p.channel !== 'fml:play' || data[0] !== 1) return;
    try {
      let off = 1;
      const varint = () => {
        let n = 0; let shift = 0; let b;
        do { b = data[off++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        return n;
      };
      const menuId = varint();
      const windowId = varint();
      const len = varint();
      const title = data.subarray(off, off + len).toString('utf8');
      state.lastForgeOpen = { t: Date.now(), menuId, menu: state.menuById?.get(menuId) || null, windowId };
      bot._client.emit('open_window', { windowId, inventoryType: menuId, windowTitle: title });
    } catch (e) {
      state.lastForgeOpen = { t: Date.now(), error: e.message, head: data.subarray(0, 16).toString('hex') };
    }
  });

  // activateBlock 是 inventory 插件在 inject_allowed 之后才挂上的 —— 建 bot 时还不存在，进了游戏再包
  bot.once('spawn', () => installDoorHabit(bot, state));

  // ⚠️ 物理引擎遇到"没有碰撞形状数据"的方块会直接抛错（block.shapes is not iterable），
  //    整个 bridge 进程跟着挂掉 —— 她瞬间掉线，看起来就是"莫名卡住"。实测在厨房附近发生过。
  //    物理每 tick 都经 bot.blockAt 取方块（调用时才查），包一层：缺形状的按实心/非实心补一个。
  const guardShapes = () => {
    if (typeof bot.blockAt !== 'function' || bot.__shapeGuard) return;
    bot.__shapeGuard = true;
    const orig = bot.blockAt.bind(bot);
    bot.blockAt = (pos, extra) => {
      const b = orig(pos, extra);
      if (b && !Array.isArray(b.shapes)) {
        b.shapes = b.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]];
        state.shapeFixes = (state.shapeFixes || 0) + 1;
        if (!state.shapeFixNames) state.shapeFixNames = new Set();
        if (state.shapeFixNames.size < 50) state.shapeFixNames.add(b.name || `type ${b.type}`);
      }
      return b;
    };
  };
  bot.once('login', guardShapes);
  bot.once('spawn', guardShapes);
  // 醒来先摸一下自己身上：戴着什么饰品、背包里装了什么（像人起床会知道自己背着包）
  bot.once('spawn', () => setTimeout(async () => {
    try {
      if (bot.currentWindow) return;
      const c = await curiosList(bot, state);
      if (!c.worn.some(x => /backpack/.test(x.item)) || bot.currentWindow) return;
      await sleep(500);
      const r = await backpackOpen(bot, state);
      if (bot.currentWindow?.id === r.id) bot.closeWindow(bot.currentWindow);
    } catch (_) {}
  }, 6000));

  // 走路时卡住（寻路器在带她走，但 2.5 秒几乎没挪动）：跳一下、左右晃一下，再让寻路器接着走
  bot.once('spawn', () => {
    let last = null; let lastAt = Date.now(); let busy = false;
    setInterval(async () => {
      if (!bot.entity || busy || !bot.pathfinder?.isMoving?.()) { last = bot.entity?.position.clone(); lastAt = Date.now(); return; }
      if (last && bot.entity.position.distanceTo(last) > 0.3) { last = bot.entity.position.clone(); lastAt = Date.now(); return; }
      if (Date.now() - lastAt < 2500) return;
      busy = true;
      try {
        state.stuckWiggles = (state.stuckWiggles || 0) + 1;
        bot.setControlState('jump', true); await sleep(250); bot.setControlState('jump', false);
        const side = Math.random() < 0.5 ? 'left' : 'right';
        if (safeToward(bot, bot.entity.yaw + (side === 'left' ? Math.PI / 2 : -Math.PI / 2))) { bot.setControlState(side, true); await sleep(200); bot.setControlState(side, false); }
      } finally { busy = false; last = bot.entity.position.clone(); lastAt = Date.now(); }
    }, 500);
  });

  installModProtocols(bot, state);

  bot.on('windowOpen', (w) => {
    if (state.__pendingGeneric?.id === w.id) {
      w.__generic = true;
      w.__menu = state.__pendingGeneric.menu;
      state.__pendingGeneric = null;
    }
  });

  function resize (w, total) {
    const old = w.slots;
    w.slots = new Array(total).fill(null);
    for (let i = 0; i < Math.min(old.length, total); i++) w.slots[i] = old[i];
    w.inventoryStart = total - 36;
    w.inventoryEnd = total;
    w.hotbarStart = total - 9;
  }
}

function noteSeen (bot, state, w, pos, name) {
  if (!w || !pos) return;
  const items = {};
  for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
  const b = bot.blockAt(pos);
  const key = b ? storageKey(bot, b) : doorKey(pos);
  state.seenContainers ||= new Map();
  markSeen(state, key);
  state.seenContainers.set(key, { key, name: name || b?.name, items, slots: w.inventoryStart, used: Object.keys(items).length ? w.slots.slice(0, w.inventoryStart).filter(Boolean).length : 0, at: Date.now() });
}

function noteBackpack (state, w) {
  // 不能拿旧 windowId 当身份：服务端会把编号复用给普通箱子/模组界面。
  // 同步标记、格子边界都有效才更新；读不到时保留上一次可信快照，绝不写成“空”。
  if (!w?.__sophisticated || !Number.isInteger(w.inventoryStart) || w.inventoryStart <= 0 || !Array.isArray(w.slots) || w.inventoryStart > w.slots.length) return false;
  const items = {};
  for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
  state.backpackSeen = { items, slots: w.inventoryStart, used: w.slots.slice(0, w.inventoryStart).filter(Boolean).length, at: Date.now() };
  return true;
}

function noteCurios (state, w) {
  state.curiosWorn = w.slots.slice(CURIO_FIRST).filter(Boolean).map(x => fullId(x.name));
  state.curiosAt = Date.now();
}

async function curiosOpen (bot, state) {
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }
  const opened = new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', on); resolve(null); }, 4000);
    function on (w) { clearTimeout(t); resolve(w); }
    bot.once('windowOpen', on);
  });
  bot._client.write('custom_payload', { channel: 'curios:main', data: Buffer.from([0, 0]) });
  const w = await opened;
  if (!w) throw new Error('饰品栏没打开（服务器没回应 curios:main）');
  await sleep(300);
  return w;
}

async function curiosEquip (bot, state, { itemName } = {}) {
  const want = itemName ? fullId(itemName) : null;
  const w = await curiosOpen(bot, state);
  try {
    const src = [...Array(36).keys()].map(k => 9 + k).find(i => w.slots[i] && fullId(w.slots[i].name) === want);
    if (src == null) throw new Error(`背包里没有 ${itemName}`);
    const before = w.slots.slice(CURIO_FIRST).filter(Boolean).map(x => fullId(x.name));
    await bot.clickWindow(src, 0, 1);   // Shift+点：服务器按 Curios 的规则放进合适的饰品格
    await sleep(600);
    const after = w.slots.slice(CURIO_FIRST).map((x, k) => (x ? { slot: CURIO_FIRST + k, item: fullId(x.name) } : null)).filter(Boolean);
    const worn = after.find(x => x.item === want) && before.filter(x => x === want).length < after.filter(x => x.item === want).length;
    if (!worn) throw new Error(`${itemName} 放不进饰品栏（可能没有合适的饰品格，或者已经戴满了）`);
    return { worn: want, slot: after.find(x => x.item === want).slot, curios: after.map(x => x.item) };
  } finally { noteCurios(state, w); bot.closeWindow(w); }
}

async function curiosList (bot, state) {
  const w = await curiosOpen(bot, state);
  try {
    const worn = w.slots.slice(CURIO_FIRST).map((x, k) => (x ? { slot: CURIO_FIRST + k, item: fullId(x.name), count: x.count } : null)).filter(Boolean);
    return { slots: Math.max(0, w.slots.length - CURIO_FIRST), worn };
  } finally { noteCurios(state, w); bot.closeWindow(w); }
}

async function curiosUnequip (bot, state, { itemName } = {}) {
  const want = fullId(itemName);
  const w = await curiosOpen(bot, state);
  try {
    const i = w.slots.findIndex((x, k) => k >= CURIO_FIRST && x && fullId(x.name) === want);
    if (i < 0) throw new Error(`饰品栏里没有 ${itemName}`);
    await bot.clickWindow(i, 0, 1);
    await sleep(500);
    if (w.slots[i] && fullId(w.slots[i].name) === want) throw new Error('拿不下来（背包满了？）');
    return { removed: want };
  } finally { noteCurios(state, w); bot.closeWindow(w); }
}

/**
 * 打开身上的背包 = 按 B（精妙背包的快捷键）：
 * sophisticatedbackpacks:channel 的 0 号消息 BackpackOpenMessage：int 格号 | string 标识 | string 处理器名。
 * 客户端按 B 时发的是默认值（-1, "", ""）—— 服务器自己按顺序找第一个背包（手上/背包栏/饰品栏背饰）打开。
 * 所以背包戴在背饰上也能打开，打开后就是普通的界面，存取用 /container/deposit、/container/withdraw。
 * （从 sophisticatedbackpacks-1.20.1-3.23.5 的 SBPPacketHandler / BackpackOpenMessage 反汇编得到）
 */
async function backpackOpen (bot, state, retry = true) {
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(400); }
  const syncBefore = state.lastSophSync?.at || 0;
  bot._client.write('custom_payload', { channel: 'sophisticatedbackpacks:channel', data: Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0, 0]) });
  // 不等 windowOpen 事件：mineflayer 要等原版 window_items 才发它，精妙背包的格子走自己的通道，事件可能永远不来（实测）
  let w = null;
  for (let k = 0; k < 40 && !w; k++) { await sleep(100); w = bot.currentWindow; }
  if (!w) throw new Error('背包没打开（身上、背饰上都没有背包？）');
  // 格子内容走精妙背包自己的同步，等它到了再读
  for (let k = 0; k < 20 && !((state.lastSophSync?.at || 0) > syncBefore && w.__sophisticated); k++) await sleep(100);
  await sleep(200);
  state.openContainerPos = null;   // 不是家里的箱子，不记进"家里有什么"
  state.backpackWindowId = w.id;
  // 刚关完别的界面马上开，偶尔格子同步对不上：关掉等一下再开一次。
  // 第二次仍认不出边界就必须失败；若把 0 当成功，后续 take_items 会在错误格段搬东西。
  const valid = w.__sophisticated && w.__sophBoundaryValid && w.inventoryStart > 0;
  if (!valid && retry) { bot.closeWindow(w); await sleep(800); return backpackOpen(bot, state, false); }
  if (!valid) {
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
    throw new Error(`精妙背包同步到了 ${w.slots?.length || 0} 格，但无法识别玩家物品栏边界；已停止存取，避免搬错东西`);
  }
  noteBackpack(state, w);
  return { backpack: true, synced: (state.lastSophSync?.at || 0) > syncBefore, ...summarizeWindow(bot, state) };
}

async function containerOpen (bot, state, { x, y, z }) {
  if ([x, y, z].some(v => v == null)) throw new Error('要给 x y z');
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) throw new Error('那里的区块没加载');
  if (eyeDist(bot, block) > 32) throw new Error(`太远了（${eyeDist(bot, block).toFixed(1)} 格）—— 先 goto 过去`);
  // 不在同一层（比如整理时掉到楼下了）：用会爬梯子、开门的走法回去
  if (eyeDist(bot, block) > REACH && Math.abs(block.position.y - bot.entity.position.y) >= 2.5) {
    await go(bot, state, { x: block.position.x, y: block.position.y, z: block.position.z, range: 2 });
  }
  await approach(bot, block);
  const opened = new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', on); resolve(null); }, 4000);
    function on (w) {
      const type = String(w?.__menu || w?.type || state.lastWindowInfo?.menu || '');
      // 上一次 open_backpack 的迟到事件不能冒充这次方块开箱成功。现场曾右键 minecraft:chest，
      // 却返回 sophisticatedbackpacks:backpack 0 格，意识层随后继续对错误窗口存取。
      if (!/sophisticatedbackpacks:/.test(block.name) && /sophisticatedbackpacks:backpack/.test(type)) {
        state.lastRejectedWindow = { expected: block.name, got: type, id: w?.id, at: Date.now() };
        return;
      }
      clearTimeout(t); bot.removeListener('windowOpen', on); resolve(w);
    }
    bot.on('windowOpen', on);
  });
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await bot.activateBlock(block);
  const w = await opened;
  if (!w) {
    throw new Error(`右键了 ${block.name}，但没有打开界面${state.lastWindowInfo && Date.now() - state.lastWindowInfo.at < 5000 ? `（服务器发来了界面 ${JSON.stringify(state.lastWindowInfo)}，但没建起来）` : '（它可能不是有界面的方块）'}`);
  }
  await sleep(250);
  state.openContainerPos = block.position.clone();
  noteSeen(bot, state, bot.currentWindow, block.position, block.name);
  return { block: block.name, ...summarizeWindow(bot, state) };
}

async function containerPut (bot, state, { slot, itemName, count }) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的界面（先 /container/open）');
  if (slot == null || slot < 0 || slot >= w.inventoryStart) throw new Error(`slot 要在 0..${w.inventoryStart - 1}`);
  const want = fullId(itemName);
  const src = [];
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i] && fullId(w.slots[i].name) === want) src.push(i);
  if (!src.length) throw new Error(`背包里没有 ${itemName}`);
  const item = w.slots[src[0]];
  if (isLoadoutItem(bot, item)) throw new Error(`${fullId(item.name)} 是随身装备，留在身上（工具/武器/火把/吃的/水桶不存进箱子）`);
  const n = Math.min(count || item.count, src.reduce((a, i) => a + w.slots[i].count, 0));
  await safeTransfer(bot, { window: w, itemType: item.type, metadata: null, count: n, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: slot, destEnd: slot + 1 });
  await sleep(200);
  return { put: want, count: n, slot, now: w.slots[slot] ? { item: fullId(w.slots[slot].name), count: w.slots[slot].count } : null };
}

async function containerTake (bot, state, { slot, count }) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的界面（先 /container/open）');
  const it = w.slots[slot];
  if (!it) throw new Error(`第 ${slot} 格是空的`);
  const before = invCounts(bot);
  if (!count || count >= it.count) {
    await bot.clickWindow(slot, 0, 1);   // shift+左键：整格收进背包
  } else {
    await safeTransfer(bot, { window: w, itemType: it.type, metadata: null, count, sourceStart: slot, sourceEnd: slot + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
  }
  await sleep(700);   // 服务器同步背包要一会儿，太早核对会看成"什么都没拿到"
  return { took: fullId(it.name), gained: delta(before, invCounts(bot)).gained, slotNow: w.slots[slot] ? w.slots[slot].count : 0 };
}

async function deposit (bot, state, { items, all = false, keep = [] } = {}) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的箱子（先 open_container）');
  const want = all ? () => true : anyOf(bot, items);
  const keepM = anyOf(bot, keep);
  // 结果按"她自己那几格前后差多少"算，而且等同步回来再算 —— 模组箱子（精妙背包）的格子是自己的封包同步的，
  // 点完立刻看会以为没放进去（实测：其实放进去了，却报"放不进"）
  const mine = () => { const m = {}; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const x = w.slots[i]; if (x) m[fullId(x.name)] = (m[fullId(x.name)] || 0) + x.count; } return m; };
  const before = mine(); const tried = {};
  // ★ 随身装备一件都不存（2026-09-28 第 8 批 第 2 条）。
  //   mind 明确点名 `store_items(["铁斧","石镐"])` 也要拒绝：手上留着能挖铁的镐子，
  //   比"把背包腾空"重要得多（实机 13:05:36 存完镐子，13:05 之后 mine ore=iron_ore 连挂三次）。
  //   这里不放行"mind 显式要求"这条口子 —— 判据只有 isLoadoutItem 一处。
  const protectedItems = [];
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
    const it = w.slots[i];
    if (!it || !want(it) || (keep.length && keepM(it))) continue;
    if (isLoadoutItem(bot, it)) { protectedItems.push(fullId(it.name)); continue; }
    tried[fullId(it.name)] = true;
    await click(bot, i, 0, 1);   // shift+左键：整组送进箱子
  }
  await sleep(w.__sophisticated ? 700 : 300);
  const after = mine();
  const stored = {}; const notStored = {};
  for (const k of Object.keys(tried)) {
    const d = (before[k] || 0) - (after[k] || 0);
    if (d > 0) stored[k] = d;
    if (after[k] > 0) notStored[k] = after[k];
  }
  return {
    stored,
    notStored: Object.keys(notStored).length ? { reason: '箱子满了或放不进', items: notStored } : null,
    stacks: Object.keys(stored).length,
    // 被留下的随身装备：如实告诉她（免得她以为"我说了她没照做"）
    ...(protectedItems.length ? { protected: [...new Set(protectedItems)], protectedNote: `${[...new Set(protectedItems)].join('、')} 是随身装备，留在身上` } : {}),
  };
}

async function withdraw (bot, state, { items = [], all = false } = {}) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的箱子（先 open_container）');
  const reqs = all ? [{ m: () => true, count: Infinity }] : [].concat(items).map(x => (typeof x === 'object' ? { m: matcher(bot, x.item || x.name), count: +x.count || Infinity } : { m: matcher(bot, x), count: Infinity }));
  const got = [];
  for (const r of reqs) {
    let need = r.count;
    for (let i = 0; i < w.inventoryStart && need > 0; i++) {
      const it = w.slots[i];
      if (!it || !r.m(it)) continue;
      if (it.count <= need) { await click(bot, i, 0, 1); got.push({ name: it.name, count: it.count }); need -= it.count; }
      else {
        await safeTransfer(bot, { window: w, itemType: it.type, metadata: null, count: need, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
        got.push({ name: it.name, count: need }); need = 0;
      }
      if (bot.inventory.emptySlotCount() === 0) break;
    }
  }
  await sleep(300);
  return { took: tally(got), backpackFull: bot.inventory.emptySlotCount() === 0 };
}

function wearingBackpack (bot, state) {
  return (state?.curiosWorn || []).some(x => /backpack/.test(x)) || /backpack/.test(bot.inventory.slots[6]?.name || '');
}

/**
 * 用背着的精妙背包倒腾（主人 2026-09-27：她有精妙背包 —— 身上满了先装背包，缺的先从背包里找，不用每次跑回家）。
 *   ① 身上不在装备单里的整组 → 塞进背包（装备单里的一件不动；部分要留的整组留着，不拆）
 *   ② 装备单缺的 → 背包里有就拿出来
 * 用的是 shift+左键整组搬（精妙背包的格子走自己的通道同步，transfer 拆组不可靠，见 deposit 的注释）。
 */
// unpack：反过来，把背包里的东西倒到身上（在家整理时用：倒出来再由 organizeStorage 放进箱子；身上留 2 格余量）
async function backpackTidy (bot, state, { abort = null, stash = true, restock = true, unpack = false } = {}) {
  const stop = () => typeof abort === 'function' && abort();
  await backpackOpen(bot, state);
  const w = bot.currentWindow;
  if (!w || !w.__sophisticated) throw new Error('背包没打开');
  let stashed = 0; let took = 0; let unpacked = 0;
  const myFree = () => { let n = 0; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (!w.slots[i]) n++; return n; };
  try {
    if (unpack) {
      for (let i = 0; i < w.inventoryStart; i++) {
        if (stop() || myFree() <= 2) break;
        if (!w.slots[i]) continue;
        await click(bot, i, 0, 1); unpacked++;
      }
      await sleep(700);
    }
    if (stash && !unpack) {
      const inv = []; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i]) inv.push({ slot: i, item: w.slots[i] });
      const keep = pickLoadout(bot, inv, defaultLoadout());
      for (const e of inv) {
        if (stop()) break;
        if (keep.has(e.slot)) continue;
        if (!w.slots.slice(0, w.inventoryStart).some(x => !x)) break;   // 背包满了
        await click(bot, e.slot, 0, 1); stashed++;
      }
      await sleep(700);
    }
    if (restock && !stop()) {
      const kit = defaultLoadout();
      const haveCount = (L) => {
        let n = 0; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i] && kitMatch(bot, L, w.slots[i])) n += w.slots[i].count;
        return n;
      };
      for (const L of kit) {
        const target = L.kind === 'best' ? 1 : L.count;
        if (haveCount(L) >= target) continue;
        const sources = [];
        for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i] && kitMatch(bot, L, w.slots[i])) sources.push(i);
        if (L.kind === 'best') sources.sort((a, b) => tierOf(w.slots[a].name) - tierOf(w.slots[b].name));
        else if (L.kind === 'food') sources.sort((a, b) => foodScore(w.slots[b]) - foodScore(w.slots[a]));
        // 精妙背包的自定义同步不可靠地支持拆组，仍用 shift 整组拿；但一堆不够时继续下一堆。
        for (const i of sources) {
          if (stop() || haveCount(L) >= target || !w.slots[i]) break;
          const before = haveCount(L);
          await click(bot, i, 0, 1);
          if (haveCount(L) > before) took++;
        }
      }
      await sleep(700);
    }
  } finally {
    noteBackpack(state, w);
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
  }
  const bp = state.backpackSeen;
  return { stashed, took, unpacked, backpackFree: bp ? bp.slots - bp.used : null };
}

/**
 * 从背着的精妙背包里拿 name 这件东西 count 个到身上，**核对身上真的多了才算拿到**。
 *
 * 依赖的界面协议（全部来自 `installModProtocols` 与 `backpackOpen` 的注释，不另造一份）：
 *   · 打开背包 = 按 B：`sophisticatedbackpacks:channel` 的 0 号消息（int 格号 | string 标识 | string 处理器名），
 *     客户端发默认值 `-1, "", ""`（原始字节 `00 ff ff ff ff 00 00`）让服务器自己找第一个背包。见 `backpackOpen`。
 *   · 格子内容走**精妙背包自己的同步通道**（`sophisticatedcore:channel` 的 2 号消息），mineflayer 的
 *     `window_items` / `windowOpen` 对它不一定触发 —— 所以 `backpackOpen` 是轮询 `bot.currentWindow` + 等 `state.lastSophSync`，
 *     不是等事件。
 *   · **槽位号来源**：`w.inventoryStart` 是"玩家的 36 格物品栏"在**这个合成界面里的起始槽号**，
 *     由 `locatePlayerInv`（拿玩家的真实 36 格内容去比对 149/其它长度的格子表）算出来，
 *     合法性由 `w.__sophBoundaryValid` 担保（`start > 0 && start + 36 <= n`）。
 *     **背包自己的格子 = `0 .. w.inventoryStart - 1`；玩家自己的格子 = `w.inventoryStart .. w.inventoryEnd - 1`。**
 *     所以"把背包第 i 格的东西拿到身上" = `clickWindow(i, 0, 1)`（shift+左键整组收进玩家物品栏）。
 *     绝不可以用 `i >= inventoryStart` 当背包格 —— 那正好是玩家格。
 *   · 精妙背包的自定义同步**不可靠地支持拆组**（见 `deposit` 的注释），所以一次只能整组拿；
 *     需要多于一堆时继续拿下一堆。
 *
 * @returns {Promise<{fetched:object, took:object, note?:string}>} fetched = 名字→数量（真实到手的）
 * @throws 没背背包 / 背包打不开 / 打不开界面时明确报错（和"背包里没有"分开）
 */
async function fetchFromBackpack (bot, state, name, count = 1) {
  if (!name) throw new Error('fetchFromBackpack：要给物品名');
  const want = fullId(name);
  const match = (it) => fullId(it.name) === want;
  // ⚠️ 核对"有没有搬过来"要读**这个界面**的她自己的那几格（`winInvCount`），
  //    不能读 `bot.inventory` —— 精妙背包不更新它，成功会被判成没搬过来（codex R-fix3-2）。
  const before = invCounts(bot);
  const had = before.get(want) || 0;
  // count = Infinity 表示"能拿多少拿多少"（垫脚方块这类不挑数量的场景）
  const reqNeed = count === Infinity ? Infinity : Math.max(1, +count || 1);
  // 整段界面操作（开 → 点 → 等同步 → 关）串行，别和别的背包动作抢同一个界面（codex R-fix3-8）
  return withBackpackLock(async () => {
    let need = reqNeed;
    await backpackOpen(bot, state);          // 打开 + 校验边界；失败会抛（背包没开 / 边界认不出）
    const w = bot.currentWindow;
    if (!w || !w.__sophisticated || !w.__sophBoundaryValid || !(w.inventoryStart > 0)) {
      throw new Error('背包界面认不出玩家物品栏边界，不敢从里面拿东西（避免搬错格）');
    }
    const winHad = winInvCount(w, match);    // 打开那一刻她自己那几格里已经有几件
    let moved = 0;
    try {
      // 背包自己的格子在前段 0..inventoryStart-1；同种的整堆从左到右拿，直到够
      for (let i = 0; i < w.inventoryStart && need > 0; i++) {
        const it = w.slots[i];
        if (!it || !match(it)) continue;
        const n0 = winInvCount(w, match);
        clickIn(bot, w, i, 0, 1);             // shift+左键：服务器把整组塞进玩家物品栏（点前核对窗口）
        await sleep(w.__sophisticated ? 700 : 300);   // 精妙背包的格子走自己的封包，点完立刻读会看漏（同 deposit 注释）
        const n1 = winInvCount(w, match);
        if (n1 > n0) { moved += n1 - n0; need -= n1 - n0; } else if (!w.slots[i]) { break; }   // 格子空了还是没变多：异常，停
      }
    } finally {
      noteBackpack(state, w);                // 记下背包现在还有多少（这次打开后的真实状态）
    }
    // 关窗前再读一次界面里的真实增量（≥ 0）；关窗后同步进 bot.inventory，才信"到手"
    const gainedNow = Math.max(0, winInvCount(w, match) - winHad);
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
    // 尽量把界面的增量同步进普通库存：mineflayer 关窗后会做，但模组界面的同步不保证，
    // 所以这里以**界面增量**为准（gainedNow），而不是拿 `bot.inventory` 反推。
    const gained = gainedNow > 0 ? gainedNow : Math.max(0, (invCounts(bot).get(want) || 0) - had);
    // 不信"点成功了"：真多了才算拿到
    if (gained <= 0) {
      return { fetched: {}, took: {}, note: `背包里没找到 ${name}（或者没搬过来）` };
    }
    return { fetched: { [want]: gained }, took: tally([{ name: want, count: gained }]), moved };
  });
}

/**
 * 「身上有没有 + 没有就从背包拿」——**唯一的入口**（不再各写一份 `bot.inventory.items().find(...)`）。
 *
 * 三种情况必须分开报（AGENTS.md §5.1）：
 *   · 身上有/拿到        → `{ have: n, got: n, source: 'carried'|'backpack' }`
 *   · 背包里也没有        → `{ have: 0, source: 'none', absenceProven: true }`
 *   · 背包读不到 / 没背包 → `{ have: 0, source: 'unknown', absenceProven: false, why }` ← **不能说"没有"**
 *
 * `spec` 可以是：
 *   · 物品名（`'torch'` / `'minecraft:crafting_table'` / 中文名，走 `K().resolve`）
 *   · 纯函数 `(item) => boolean`（垫脚方块、燃料这类"任意一种都行"的）
 *
 * 决策部分抽成 `decideCarry()` 纯函数，好离线穷举（自测测的就是真跑的那份）。
 */
/**
 * 该不该"直接用身上的"。
 *
 * ⚠️ 判据是 `carried >= need`，**不是 `carried > 0`**（2026-09-28 codex 审计 R-fix3-3）：
 *   以前身上有 1 根火把、请求 16 根也直接返回 `source:'carried'`，
 *   永远不去背包补剩下的 15 根 —— "要 16 根"被她当成"有就行"。
 *   `need = Infinity`（垫脚方块"能拿多少拿多少"）时，身上 ≥ 1 就算够（没有上限可追）。
 *
 * @param carried  身上有几件（null = 读不到）
 * @param backpack 背包记录里有几件（null = 读不到）
 * @param need     要几件（默认 1）
 */
function decideCarry ({ carried, backpack, need = 1 }) {
  // carried / backpack 都是 null = 读不到
  const had = carried == null ? 0 : carried;
  const want = need === Infinity ? 1 : Math.max(1, +need || 1);
  if (had >= want) return { action: 'use', reason: '身上就够了' };
  if (backpack == null) return { action: 'unknown', reason: had > 0 ? `身上只有 ${had}，背包读不到` : '身上没有，背包读不到' };
  if (backpack > 0) return { action: 'fetch', reason: had > 0 ? `身上只有 ${had}，背包里有` : '身上没有，背包里有' };
  // 背包读得到、但一件都没有：身上有多少算多少（够不着就如实说）
  return had > 0
    ? { action: 'use', reason: `背包里也没有，身上这 ${had} 先用着` }
    : { action: 'none', reason: '身上和背包里都没有' };
}

function countInBackpackSeen (state, spec, predicate) {
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return null;                 // 从没打开过/没记录 → 读不到
  const items = Object.entries(seen.items).map(([name, count]) => ({ name, count }));
  if (predicate) return items.filter(predicate).reduce((a, it) => a + it.count, 0);
  const want = fullId(typeof spec === 'function' ? '' : spec);
  return items.filter(it => fullId(it.name) === want).reduce((a, it) => a + it.count, 0);
}

/**
 * 把物品名解析成规范 ID（`'石镐'` → `'minecraft:iron_pickaxe'`，`'torch'` → `'minecraft:torch'`）。
 * 先原样 `fullId`（已经是规范 ID 的走这条，不动）；再交给知识库解析一次 ——
 * 以前 ensureCarried 只做 `fullId(spec)`，`石镐` 被拼成 `minecraft:石镐`，
 * 永远匹配不上 `iron_pickaxe`，`/equip`、`/place` 照样报 `Not carrying 石镐`（codex R-fix3-7）。
 */
function resolveCarryId (name) {
  if (!name || typeof name !== 'string') return null;
  const direct = fullId(name);
  const items = K().load()?.items;
  if (items && (items.has(direct) || items.has(name))) return direct;
  const id = K().resolve(name, 1)[0];
  return id || direct;   // 解析不出来就退回原样，至少不改变旧行为
}

async function ensureCarried (bot, state, spec, count = 1) {
  const predicate = typeof spec === 'function' ? spec : null;
  const want = predicate ? null : resolveCarryId(spec);
  const carriedNow = () => predicate
    ? bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0)
    : (invCounts(bot).get(want) || 0);
  const need = count === Infinity ? Infinity : Math.max(1, +count || 1);
  const had = carriedNow();
  let inPack = countInBackpackSeen(state, want, predicate);
  let d = decideCarry({ carried: had, backpack: inPack, need });
  // 背包记录读不到 → 按任务要求"背着背包就打开看一眼"（codex R-fix3-4）：
  // 以前直接返回 unknown，新会话即使身上确实背着背包，也永远发现不了里面的东西。
  if (d.action === 'unknown') {
    const opened = await lookIntoBackpack(bot, state);
    if (opened) {
      inPack = countInBackpackSeen(state, want, predicate);
      d = decideCarry({ carried: carriedNow(), backpack: inPack, need });
    }
  }
  if (d.action === 'use') { const n = carriedNow(); return { have: n, got: n, source: 'carried', needed: need }; }
  if (d.action === 'unknown') {
    return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: d.reason, needed: need };
  }
  if (d.action === 'none') {
    return { have: 0, got: 0, source: 'none', absenceProven: true, why: d.reason, needed: need };
  }
  // 背包里有：真去拿（没背背包的会在这里明确抛）。
  // 只补差额 —— 身上已经有几件时不必再搬 count 件（decideCarry 已保证 had < need）。
  const short = need === Infinity ? Infinity : Math.max(1, need - carriedNow());
  let r;
  try {
    r = predicate
      ? await fetchAnyFromBackpack(bot, state, predicate, short)
      : await fetchFromBackpack(bot, state, want, short);
  } catch (e) {
    return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: `背包里有记录，但没拿出来：${e.message}`, needed: need };
  }
  const now = carriedNow();
  if (now <= 0) return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: r?.note || '背包里有记录，但没拿到身上', needed: need };
  // 拿到了但不一定够（背包里就那么多）——如实报现状，不假装够
  return { have: now, got: now, source: 'backpack', fetched: r?.fetched || null, needed: need, short: now < need ? need - now : undefined };
}

/**
 * 打开背包看一眼、把快照写进 `state.backpackSeen`，然后马上关掉。
 * 只在"从没记录过 / 记录读不到"时用（拿东西时不要走这里，免得开了又关）。
 * 没背背包（或打不开）返回 false —— **不声称"没有"**，让上层如实报 unknown。
 */
async function lookIntoBackpack (bot, state) {
  if (!state || !wearingBackpack(bot)) return false;      // 没背着背包：不打开，也不假装看过
  try {
    const w = await backpackOpen(bot, state);             // 打开 + 校验边界 + noteBackpack 写快照
    void w;
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    return !!state.backpackSeen;
  } catch (_) { return false; }
}

async function fetchAnyFromBackpack (bot, state, predicate, count = 1) {
  const carried = () => bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0);
  const before = carried();
  const reqNeed = count === Infinity ? Infinity : Math.max(1, +count || 1);
  return withBackpackLock(async () => {
    let need = reqNeed;
    await backpackOpen(bot, state);
    const w = bot.currentWindow;
    if (!w || !w.__sophisticated || !w.__sophBoundaryValid || !(w.inventoryStart > 0)) {
      throw new Error('背包界面认不出玩家物品栏边界，不敢从里面拿东西（避免搬错格）');
    }
    // 和 fetchFromBackpack 同理：核对读**这个界面**的她自己的格，不读 bot.inventory
    const winHad = winInvCount(w, predicate);
    let moved = 0;
    try {
      for (let i = 0; i < w.inventoryStart && need > 0; i++) {
        const it = w.slots[i];
        if (!it || !predicate(it)) continue;
        const n0 = winInvCount(w, predicate);
        clickIn(bot, w, i, 0, 1);
        await sleep(w.__sophisticated ? 700 : 300);
      const n1 = winInvCount(w, predicate);
      if (n1 > n0) { moved += n1 - n0; need -= n1 - n0; } else if (!w.slots[i]) break;
    }
    } finally {
      noteBackpack(state, w);
    }
    const gainedNow = Math.max(0, winInvCount(w, predicate) - winHad);
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
    const gained = gainedNow > 0 ? gainedNow : Math.max(0, carried() - before);
    if (gained <= 0) return { fetched: {}, took: {}, note: '背包里没有符合条件的东西' };
    return { fetched: { predicate: gained }, took: {}, moved };
  });
}

// abort：进程内调用才能传（随身物品本能被命令打断时用），每开一个箱子之前问一次
async function organizeStorage (bot, state, { radius = 12, assign = {}, loadout = null, maxPasses = 4, dryRun = false, only = null, allFloors = false, skip = [], abort = null, mode = 'rebalance' } = {}) {
  const t0 = Date.now();
  const stop = () => typeof abort === 'function' && abort();
  const daily = mode === 'daily';
  const log = [];
  const kit = loadout ? [].concat(loadout).map(x => (typeof x === 'object' ? { kind: 'spec', m: matcher(bot, x.item || x.name), count: +x.count || 1, label: x.item || x.name } : { kind: 'spec', m: matcher(bot, x), count: 64, label: x })) : defaultLoadout();

  // ① 盘点：打开每个箱子看看（大箱子两格算一个）
  // only：只动这几个箱子（"x,y,z" 列表）—— 厨房柜子这类主人自己摆的可以不碰
  // 默认只管她这一层（楼上楼下的柜子多半是主人另外摆的，比如厨房；而且走过去很费时间）
  const myY = Math.floor(bot.entity.position.y + 0.01);
  const blocks = findStorage(bot, radius)
    .filter(b => allFloors || (b.position.y >= myY - 1 && b.position.y <= myY + 2))
    .filter(b => !only || [].concat(only).map(x => String(x).replace(/[()\s]/g, '')).includes(doorKey(b.position)));
  if (!blocks.length) throw new Error(`周围 ${radius} 格内没有箱子`);
  const boxes = []; const covered = new Set();
  const skipSet = new Set([].concat(skip).map(x => String(x).replace(/[()\s]/g, '')));   // 上次是空的、又没分到类的：这次不去看
  for (const b of blocks) {
    if (stop()) throw new Error('被新的命令打断（还没开始搬）');
    const k = storageKey(bot, b);
    if (covered.has(k) || covered.has(doorKey(b.position))) continue;
    if (skipSet.has(k)) { covered.add(k); boxes.push({ pos: b.position.clone(), key: k, name: b.name, slots: /chest/.test(b.name) && k !== doorKey(b.position) ? 54 : 27, cats: {}, used: 0, items: [], contents: [], skipped: true }); continue; }
    let info;
    try { info = await containerOpen(bot, state, b.position); } catch (e) { log.push(`打不开 ${b.name}(${k})：${e.message}`); continue; }
    const w = bot.currentWindow;
    const n = w.inventoryStart;
    // 大箱子：把另一半那格也标成看过了（它的 storageKey 和这格一样）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nb = bot.blockAt(b.position.offset(dx, 0, dz)); if (nb && nb.name === b.name && storageKey(bot, nb) === k) covered.add(doorKey(nb.position)); }
    covered.add(k);
    const snap = snapshotContainer(bot, w);
    boxes.push({ pos: b.position.clone(), key: k, name: b.name, slots: n, ...snap });
    noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
  }
  if (!boxes.length) throw new Error('周围的箱子一个都打不开');

  // ② 分配：每类给"已经放这类最多"的箱子，装不下顺延；主人指定的优先
  const inventoryItems = bot.inventory.items();
  const allItems = [...boxes.flatMap(b => b.contents || []), ...inventoryItems];
  const beforeTotals = identityTotals(allItems);
  const need = {};
  for (const c of CAT_ORDER) need[c] = packedSlots(allItems.filter(it => categoryOf(bot, it) === c));
  const free = new Map(boxes.map(b => [b.key, b.slots]));
  const owner = {};   // 类别 → [箱子 key…]
  for (const [cat, where] of Object.entries(assign)) {
    const c = CAT_ORDER.find(x => x === cat || cat.includes(x));
    if (!c) continue;
    const keys = [].concat(where).map(x => String(x).replace(/[()\s]/g, '')).filter(k => boxes.some(b => b.key === k));
    if (!keys.length) continue;
    owner[c] = keys;
    let left = need[c];
    for (const k of keys) { const room = free.get(k); const put = Math.min(room, left); free.set(k, room - put); left -= put; }
  }
  const claimed = new Set(Object.values(owner).flat());
  const center = boxes.reduce((a, b) => a.offset(b.pos.x / boxes.length, b.pos.y / boxes.length, b.pos.z / boxes.length), new Vec3(0, 0, 0));
  for (const c of (daily ? [] : CAT_ORDER.filter(c => need[c] > 0 && !owner[c]).sort((a, b) => need[b] - need[a]))) {
    owner[c] = [];
    let left = need[c];
    // 一类一个箱子：先挑还没被别的类占用的（已经放这类最多的优先，其次是靠近仓库中间的大箱子），都占完了才合住
    const unclaimed = boxes.filter(b => !claimed.has(b.key));
    const pool = unclaimed.length ? unclaimed : boxes;
    const prefs = [...pool].sort((a, b) => (b.cats[c] || 0) - (a.cats[c] || 0) || b.slots - a.slots || a.pos.distanceTo(center) - b.pos.distanceTo(center));
    for (const b of prefs) {
      if (left <= 0) break;
      const room = free.get(b.key);
      if (room <= 0) continue;
      owner[c].push(b.key); claimed.add(b.key);
      const put = Math.min(room, left);
      free.set(b.key, room - put); left -= put;
    }
    if (left > 0) log.push(`${c} 放不下了（还差 ${left} 格）`);
  }
  const home = (it) => owner[categoryOf(bot, it)] || [];
  if (dryRun) {
    const plan = {}; for (const [c, keys] of Object.entries(owner)) for (const k of keys) (plan[k] ||= []).push(c);
    return { dryRun: true, boxes: boxes.map(b => ({ at: b.key, name: b.name, slots: b.slots, used: b.used, now: b.cats, willHold: plan[b.key] || [] })), notes: log };
  }

  // ③ 搬：一个个箱子走过去，拿出不属于这的，放进属于这的；背包满了就分几轮
  let moved = 0; let visits = 0;
  const cats0 = (box) => box.items || [];
  // 日常归位只把身上的东西送回已登记箱子，不从箱子里抽出“错类”去重排整个仓库。
  const misplaced = (box) => daily ? 0 : cats0(box).filter(c => !(owner[c] || []).includes(box.key) && (owner[c] || []).length).length;
  const invWants = (box) => bot.inventory.items().some(it => home(it).includes(box.key));
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = 0;
    // 只去需要去的：里面有放错的，或者身上有东西该放进去的（空的、没分到类的箱子不去）
    const todo = boxes.filter(b => misplaced(b) > 0 || invWants(b))
      .sort((a, b) => bot.entity.position.distanceTo(a.pos) - bot.entity.position.distanceTo(b.pos));
    if (!todo.length) break;
    for (const box of todo) {
      if (stop()) { log.push('被新的命令打断'); break; }
      if (!(misplaced(box) > 0 || invWants(box))) continue;
      visits++;
      try { await containerOpen(bot, state, box.pos); } catch (e) { log.push(`第 ${pass + 1} 轮打不开 ${box.key}：${e.message}`); continue; }
      const w = bot.currentWindow;
      // 放进属于这里的（随身装备单里的先不放，最后再算）
      const invEntries = []; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i]) invEntries.push({ slot: i, item: w.slots[i] });
      const keepHere = pickLoadout(bot, invEntries, kit);
      for (const e of invEntries) {
        if (!home(e.item).includes(box.key)) continue;
        const keepN = keepHere.get(e.slot) || 0;
        const before = w.slots[e.slot]?.count || 0;
        if (keepN >= before) continue;
        if (keepN > 0) await safeTransfer(bot, { window: w, itemType: e.item.type, metadata: null, count: before - keepN, sourceStart: e.slot, sourceEnd: e.slot + 1, destStart: 0, destEnd: w.inventoryStart });
        else await click(bot, e.slot, 0, 1);
        if ((w.slots[e.slot]?.count || 0) < before) { changed++; moved++; }
      }
      // 完整重整才把错类抽出来；日常归位尊重主人当前箱内摆法，不跨箱洗牌。
      if (!daily) {
        for (let i = 0; i < w.inventoryStart; i++) {
          const it = w.slots[i];
          if (!it || home(it).includes(box.key) || !home(it).length) continue;
          if (bot.inventory.emptySlotCount() <= 2) break;
          await click(bot, i, 0, 1);
          if (!w.slots[i]) { changed++; moved++; }
        }
      }
      // 更新心里的账：这个箱子现在装着什么
      applyBoxSnapshot(box, snapshotContainer(bot, w));
      noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
    }
    log.push(`第 ${pass + 1} 轮去了 ${todo.length} 个箱子，搬了 ${changed} 组`);
    if (!changed) break;
  }

  // ④ 完整重整才把每个箱子内部重排；日常归位只补随身装备，不制造无意义搬动。
  // ⑤ 随身装备缺的从箱子里拿（空箱子不去）。
  // 已知材质的高级工具箱先看，避免先拿木镐后就把“有一把镐”误当成已经满足。
  const boxTier = (box) => Math.min(...(box.contents || []).map(x => knownTierOf(x.name)).filter(x => x != null), 99);
  const carriedNow = bot.inventory.items();
  const dailyNeeds = kit.filter(L => L.kind === 'best' || carriedNow.filter(it => kitMatch(bot, L, it)).reduce((n, it) => n + it.count, 0) < L.count);
  const finishBoxes = boxes.filter(b => b.used > 0 && (!daily || (b.contents || []).some(it => dailyNeeds.some(L => kitMatch(bot, L, it)))));
  for (const box of finishBoxes.sort((a, b) => boxTier(a) - boxTier(b))) {
    if (stop()) break;
    try { await containerOpen(bot, state, box.pos); } catch (_) { continue; }
    const w = bot.currentWindow;
    if (!daily) await sortRange(bot, w, 0, w.inventoryStart);
    for (const L of kit) {
      const haveEntries = () => {
        const out = []; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i]) out.push({ slot: i, item: w.slots[i] });
        return out;
      };
      let have = haveEntries();
      let got = have.filter(e => kitMatch(bot, L, e.item)).reduce((a, e) => a + e.item.count, 0);
      const target = L.kind === 'best' ? 1 : L.count;
      let sources = [];
      for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i] && kitMatch(bot, L, w.slots[i])) sources.push(i);
      if (L.kind === 'best') sources.sort((a, b) => tierOf(w.slots[a].name) - tierOf(w.slots[b].name));

      // 只在两边材质等级都认得时升级，认不出的模组工具不猜强弱、也不自动换掉。
      if (L.kind === 'best' && got > 0 && sources.length) {
        const carried = have.filter(e => kitMatch(bot, L, e.item));
        const currentRank = Math.min(...carried.map(e => knownTierOf(e.item.name)).filter(x => x != null), 99);
        const candidateRank = knownTierOf(w.slots[sources[0]].name);
        if (candidateRank != null && currentRank !== 99 && candidateRank < currentRank) {
          for (const e of carried.filter(e => knownTierOf(e.item.name) === currentRank)) await click(bot, e.slot, 0, 1);
          have = haveEntries(); got = have.filter(e => kitMatch(bot, L, e.item)).reduce((a, e) => a + e.item.count, 0);
        }
      }
      if (got >= target) continue;
      // 一堆不够就继续下一堆；每次按窗口里的真实变化重算，不能只相信 transfer 没抛错。
      for (const i of sources) {
        const it = w.slots[i];
        if (!it || !kitMatch(bot, L, it) || got >= target) continue;
        const n = Math.min(it.count, target - got);
        const before = got;
        await safeTransfer(bot, { window: w, itemType: it.type, metadata: it.metadata, nbt: it.nbt, count: n, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
        have = haveEntries(); got = have.filter(e => kitMatch(bot, L, e.item)).reduce((a, e) => a + e.item.count, 0);
        if (got <= before) log.push(`${L.label} 从 ${box.key} 拿取后数量没有增加`);
      }
    }
    applyBoxSnapshot(box, snapshotContainer(bot, w));
    noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
  }

  const layout = {};
  for (const [c, keys] of Object.entries(owner)) for (const k of keys) (layout[k] ||= []).push(c);
  const carry = {}; for (const it of bot.inventory.items()) carry[fullId(it.name)] = (carry[fullId(it.name)] || 0) + it.count;
  const misplacedStacks = boxes.reduce((n, b) => n + misplaced(b), 0);
  const shortfall = loadoutTargetShortfall(bot, bot.inventory.items(), kit);
  const blocked = log.some(x => /打不开|放不下|被新的命令打断|数量没有增加/.test(x));
  const cursorEmpty = !bot.currentWindow?.selectedItem;
  const afterTotals = identityTotals([...boxes.flatMap(b => b.contents || []), ...bot.inventory.items()]);
  const conserved = sameTotals(beforeTotals, afterTotals);
  if (!conserved) log.push('整理前后物品总数不一致；结果不记为完成');
  const blockingShortfall = daily ? shortfall.filter(x => x.essential) : shortfall;
  const completed = !stop() && !blocked && (daily || misplacedStacks === 0) && cursorEmpty && conserved && blockingShortfall.length === 0;
  return {
    boxes: boxes.map(b => ({ at: b.key, name: b.name, slots: b.slots, holds: layout[b.key] || [], used: b.used, skipped: !!b.skipped })),
    mode: daily ? 'daily' : 'rebalance', completed, status: completed ? 'completed' : (stop() ? 'aborted' : 'partial'),
    verification: { misplacedStacks, cursorEmpty, conserved, loadoutShortfall: shortfall },
    moved, visits, carrying: carry, notes: log, seconds: Math.round((Date.now() - t0) / 1000),
  };
}

async function lootNearby (bot, state, { radius = 10, home = null, exclude = [], only = null } = {}) {
  const inHomeArea = (p) => home && Math.hypot(p.x - home.center.x, p.z - home.center.z) <= home.radius && Math.abs(p.y - home.center.y) <= 16;
  const skip = new Set([].concat(exclude).map(x => String(x).replace(/[()\s]/g, '')));
  const targets = findStorage(bot, radius).filter(b => !inHomeArea(b.position) && !skip.has(doorKey(b.position)))
    .filter(b => !only || only.includes(storageKey(bot, b)) || only.includes(doorKey(b.position)))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  if (!targets.length) return { looted: [], note: home && findStorage(bot, radius).some(b => inHomeArea(b.position)) ? '附近的箱子都是家里的，不拿' : `附近 ${radius} 格没有箱子` };
  const report = []; const covered = new Set(); let full = false;
  for (const b of targets) {
    const k = doorKey(b.position);
    if (covered.has(k)) continue;
    if (bot.inventory.emptySlotCount() === 0) { full = true; report.push({ at: k, skipped: '背包满了' }); continue; }
    try { await containerOpen(bot, state, b.position); } catch (e) { report.push({ at: k, error: e.message }); continue; }
    const w = bot.currentWindow;
    if (w.inventoryStart >= 54) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nb = bot.blockAt(b.position.offset(dx, 0, dz)); if (nb && nb.name === b.name) covered.add(doorKey(nb.position)); }
    covered.add(k);
    const slots = [];
    for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i]) slots.push(i);
    slots.sort((a, c) => LOOT_ORDER.indexOf(categoryOf(bot, w.slots[a])) - LOOT_ORDER.indexOf(categoryOf(bot, w.slots[c])));
    const took = [];
    for (const i of slots) {
      if (bot.inventory.emptySlotCount() === 0) { full = true; break; }
      const it = w.slots[i];
      await click(bot, i, 0, 1);
      if (!w.slots[i] || w.slots[i].count < it.count) took.push({ name: it.name, count: it.count - (w.slots[i]?.count || 0) });
    }
    let left = 0; for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i]) left++;
    report.push({ at: k, name: b.name, took: tally(took), leftStacks: left });
    noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
  }
  return { looted: report, backpackFull: full || bot.inventory.emptySlotCount() === 0, freeSlots: bot.inventory.emptySlotCount() };
}

/**
 * 视野里没打开过的箱子/木桶（radius 内、眼睛看得见的），最近的在前。
 * near：{x,y,z,r} —— 已经走进一座建筑（开宝箱本能认出来的）时，它附近 r 格内的也算，看不看得见都算
 *       （像玩家进了地牢/神殿会一间间屋子看；只在"认出是自然建筑"之后才放宽，平时不透视）。
 */
function unseenChests (bot, state, radius = 24, near = null) {
  const seen = seenKeys(state);
  const inNear = (p) => near && Math.hypot(p.x - near.x, p.y - near.y, p.z - near.z) <= near.r;
  return findStorage(bot, radius)
    .filter(b => /chest|barrel/.test(b.name) && !/ender_chest/.test(b.name))
    .filter(b => !seen.has(storageKey(bot, b)) && !state.seenContainers?.has(storageKey(bot, b)))
    .filter(b => inNear(b.position) || bot.canSeeBlock(b))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
}

function unseenCarts (bot, state, radius = 16) {
  const seen = seenKeys(state);
  return Object.values(bot.entities)
    .filter(e => e?.position && /chest_minecart/.test(e.name || '') && e.position.distanceTo(bot.entity.position) <= radius)
    .filter(e => !seen.has(cartKey(e)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

async function lootCart (bot, state, e) {
  const key = cartKey(e);
  markSeen(state, key);
  if (e.position.distanceTo(bot.entity.position) > 3) {
    const err = await pathTo(bot, e.position.floored(), 2, 30000);
    if (err && e.position.distanceTo(bot.entity.position) > 4) return { at: key, name: 'chest_minecart', error: `走不过去：${err}` };
  }
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(300); }
  await bot.lookAt(e.position.offset(0, 0.5, 0), true);
  bot.activateEntity(e);
  let w = null;
  for (let k = 0; k < 30 && !w; k++) { await sleep(100); w = bot.currentWindow; }
  if (!w) return { at: key, name: 'chest_minecart', error: '右键了矿车，没打开' };
  const took = {};
  try {
    for (let i = 0; i < w.inventoryStart; i++) {
      const it = w.slots[i];
      if (!it) continue;
      if (bot.inventory.emptySlotCount() <= 1) break;
      took[fullId(it.name)] = (took[fullId(it.name)] || 0) + it.count;
      await click(bot, i, 0, 1);
    }
    await sleep(300);
  } finally { if (bot.currentWindow?.id === w.id) bot.closeWindow(w); }
  return { at: key, name: 'chest_minecart', looted: took };
}

/**
 * 走过去打开视野里没看过的箱子：家外的把东西拿走（奖励箱），家里的只看看记住放了什么。
 * 也开运输矿车箱子（废弃矿井）。near / abort 给开宝箱本能用（见 instinct.js）。
 */
async function checkChests (bot, state, { radius = 24, home = null, max = 4, near = null, abort = null } = {}) {
  const out = [];
  const stop = () => typeof abort === 'function' && abort();
  for (const b of unseenChests(bot, state, radius, near).slice(0, max)) {
    if (stop()) break;
    const key = storageKey(bot, b);
    markSeen(state, key);                     // 先记下：打不开/走不到也别来回折腾
    if (eyeDist(bot, b) > REACH) {
      const err = await pathTo(bot, b.position, 2, 30000);
      if (err && eyeDist(bot, b) > REACH) { out.push({ at: key, name: b.name, error: `走不过去：${err}` }); continue; }
    }
    if (inHomeArea(home, b.position)) {
      try {
        const r = await containerOpen(bot, state, b.position);
        const w = bot.currentWindow;
        const items = {}; if (w) for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
        if (w) bot.closeWindow(w);
        out.push({ at: key, name: b.name, home: true, holds: items, slots: r?.containerSlots });
      } catch (e) { out.push({ at: key, name: b.name, error: e.message }); }
    } else {
      try {
        const r = await lootNearby(bot, state, { radius: 6, only: [key] });
        out.push({ at: key, name: b.name, looted: r.looted?.[0]?.took || {}, left: r.looted?.[0]?.leftStacks, backpackFull: r.backpackFull });
        if (r.backpackFull) break;
      } catch (e) { out.push({ at: key, name: b.name, error: e.message }); }
    }
  }
  for (const e of unseenCarts(bot, state, Math.min(radius, 16)).slice(0, Math.max(0, max - out.length))) {
    if (stop() || bot.inventory.emptySlotCount() <= 1) break;
    try { out.push(await lootCart(bot, state, e)); } catch (err) { out.push({ at: cartKey(e), name: 'chest_minecart', error: err.message }); }
  }
  return out;
}

function installModProtocols (bot, state) {
  // FTB 任务书的服务端回包：记下消息名（载荷开头的 ResourceLocation）
  bot._client.on('custom_payload', (p) => {
    if (p.channel !== 'architectury:network') return;
    try {
      const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
      const o = { i: 0 }; const n = readVarInt(buf, o); const name = buf.subarray(o.i, o.i + n).toString('utf8');
      if (!name.startsWith('ftbquests:')) return;
      (state.ftbqRecent ||= []).push({ t: Date.now(), name });
      if (state.ftbqRecent.length > 50) state.ftbqRecent.shift();
    } catch (_) {}
  });
  bot._client.on('custom_payload', (p) => {
    if (p.channel !== 'sophisticatedcore:channel') return;
    const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
    const kind = buf[0];
    if (kind !== 2 && kind !== 3) return;
    try {
      const o = { i: 1 };
      const windowId = buf[o.i++];
      readVarInt(buf, o);   // stateId
      const w = bot.currentWindow;
      if (!w || w.id !== windowId) return;
      if (kind === 2) {
        const n = buf.readInt16BE(o.i); o.i += 2;
        const items = [];
        for (let k = 0; k < n; k++) items.push(readSophItem(bot, buf, o));
        if (w.slots.length !== n) { const old = w.slots; w.slots = new Array(n).fill(null); for (let k = 0; k < Math.min(old.length, n); k++) w.slots[k] = old[k]; }
        for (let k = 0; k < n; k++) w.slots[k] = items[k];
        const preferred = state.backpackSeen?.slots || state.lastSophGoodStart || null;
        const start = locatePlayerInv(bot, items, preferred);
        w.inventoryStart = start; w.inventoryEnd = start + 36; w.hotbarStart = start + 27;
        w.__sophisticated = true;
        w.__sophBoundaryValid = start > 0 && start + 36 <= n;
        if (w.__sophBoundaryValid) state.lastSophGoodStart = start;
        state.lastSophSync = { windowId, slots: n, playerInvAt: start, boundaryValid: w.__sophBoundaryValid, at: Date.now() };
      } else {
        const slot = buf.readInt16BE(o.i); o.i += 2;
        const it = readSophItem(bot, buf, o);
        if (slot >= 0 && slot < w.slots.length) w.slots[slot] = it;
      }
    } catch (e) { state.lastSophError = e.message; }
  });
}

async function ftbqSend (bot, state, name, body = Buffer.alloc(0), waitMs = 1500) {
  const since = Date.now();
  bot._client.write('custom_payload', { channel: 'architectury:network', data: Buffer.concat([mcString(`ftbquests:${name}`), body]) });
  await sleep(waitMs);
  // 服务器回了什么（任务进度更新 / 完成 / 奖励到账…）—— 用来核对"真的交上了"，不是"发出去了"
  const replies = (state.ftbqRecent || []).filter(r => r.t >= since).map(r => r.name);
  return { sent: `ftbquests:${name}`, serverReplies: [...new Set(replies)] };
}

/**
 * 放建筑蓝图（nsprefab 结构生成器，FTB「新手小屋」送的）：手持 → 右键地面出预览 → 潜行 + 右键地面确认放下。
 * 核对：生成器少了一个、附近出现了床或箱子（新手小屋自带），才算放下了。
 */
async function placeStructure (bot, state, { x, y, z, itemName = 'nsprefab:structure_spawner' } = {}) {
  const it = findItem(bot, itemName);
  if (!it) throw new Error(`身上没有 ${itemName}（先 quest_claim 领新手小屋）`);
  const ground = x != null ? bot.blockAt(new Vec3(+x, +y, +z)) : bot.blockAt(bot.entity.position.offset(0, -1, 0).floored());
  if (!ground || ground.boundingBox !== 'block') throw new Error('要对着实心的地面放（给 x y z 或站在平地上）');
  if (eyeDist(bot, ground) > REACH) await approach(bot, ground);
  const before = invCounts(bot).get(fullId(it.name)) || 0;
  await bot.equip(it, 'hand');
  await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(ground, new Vec3(0, 1, 0));          // 第一次右键：出预览
  await sleep(900);
  bot.setControlState('sneak', true); await sleep(300);
  await bot.activateBlock(ground, new Vec3(0, 1, 0));          // 潜行右键：确认放下
  await sleep(400); bot.setControlState('sneak', false);
  await sleep(2500);                                           // 结构是分几 tick 生成的
  const after = invCounts(bot).get(fullId(it.name)) || 0;
  const bed = bot.findBlock({ matching: (b) => b && /(^|_)bed$/.test(b.name), maxDistance: 24 });
  const chest = bot.findBlock({ matching: (b) => b && /chest$/.test(b.name), maxDistance: 24 });
  const placed = after < before;
  return {
    placed, usedItem: placed, at: ground.position,
    bed: bed ? bed.position : null, chest: chest ? chest.position : null,
    note: placed ? (bed ? '放下了，附近有床（可以 set_home、上床睡）' : '生成器用掉了，但 24 格内没看到床 —— 看看周围') : '生成器还在手上：没放下（可能地面不平/空间不够，换块平地再试）',
  };
}

function categoryOf (bot, item) {
  const id = fullId(item.name);
  const tags = K().load().itemTags.get(id) || new Set();
  const has = (re) => [...tags].some(t => re.test(t));
  // 《食录逸闻》清单里也有工作台这种"要交的东西"—— 能放下的方块不算吃的（蛋糕这类可放置的食物靠 foodScore/标签认）
  const isBlock = !!(bot.registry.blocksByName[item.name] || bot.registry.blocksByName[String(item.name).split(':').pop()]);
  let inCatalog = false;
  try { inCatalog = require('../mind/ambition').isFood(id); } catch (_) {}
  // 矿物/宝石先认：《食录逸闻》清单里也有要交绿宝石的任务，不能因为在清单里就当成吃的
  if (has(/^(forge|c):(ores|ingots|gems|raw_materials|nuggets|dusts)/)) return '矿物';
  // minecraft:fishes：很多模组的鱼（starcatcher…）只打了这个标签，没打 forge:foods（WorkBuddy 2026-09-27 统计：109 个）
  if ((inCatalog && !isBlock) || has(/^(forge|c):foods|meals|feasts|drinks$/) || has(/^minecraft:fishes$/) || foodScore(item) >= 3) return '食物';
  if (has(/^(forge|c):(seeds|crops)|saplings$/) || /seed|sapling/.test(item.name)) return '作物种子';
  if (has(/^(forge|c):(ores|ingots|gems|raw_materials|nuggets|dusts|storage_blocks)/) || /ingot|_ore$|raw_|nugget|gem$|diamond$|emerald$|coal$|redstone$|lapis/.test(item.name)) return '矿物';
  if (has(/^minecraft:(logs|planks)$/) || /_log$|_planks$|_wood$|stick$/.test(item.name)) return '木头';
  // 饰品（curios:* 标签，589 个）、帽子（simplehats 这类零标签的只能靠名字，341 个，名单核对过全是帽子）、枪（只认 forge:guns 标签 —— 名字里的 gun 会误中 gunpowder）
  if (has(/^curios:/) || has(/^forge:guns/) || /(^|_)hat$|_hat_/.test(botName(item.name)) || /^simplehats:/.test(id)) return '工具装备';
  if (/pickaxe|_axe$|shovel|hoe$|sword|bow$|crossbow|helmet|chestplate|leggings|boots|shield|fishing_rod|shears|flint_and_steel|knife/.test(item.name) || has(/tools|weapons|armors/)) return '工具装备';
  if (bot.registry.blocksByName[item.name] || bot.registry.blocksByName[String(item.name).split(':').pop()]) return '方块';
  return '其他';
}

function matcher (bot, spec) {
  const sp = String(spec).trim();
  const cat = CAT_ORDER.find(c => sp.includes(c) || c.includes(sp) || (sp === '吃的' && c === '食物') || (/种子|作物|庄稼/.test(sp) && c === '作物种子') || (/矿|锭|宝石/.test(sp) && c === '矿物') || (/工具|武器|装备|盔甲|护甲/.test(sp) && c === '工具装备') || (/木/.test(sp) && c === '木头'));
  if (cat) return (it) => categoryOf(bot, it) === cat;
  if (sp.startsWith('#')) { const set = K().load().tags.get(`item:${sp.slice(1)}`) || new Set(); return (it) => set.has(fullId(it.name)); }
  const id = sp.includes(':') || /^[a-z0-9_]+$/.test(sp) ? fullId(sp) : K().resolve(sp, 1)[0];
  return (it) => fullId(it.name) === id;
}

const anyOf = (bot, specs) => { const ms = [].concat(specs || []).map(x => matcher(bot, x)); return (it) => ms.some(m => m(it)); };

function tally (list) {
  const m = {};
  for (const it of list) m[fullId(it.name)] = (m[fullId(it.name)] || 0) + it.count;
  return m;
}

function stableValue (v) {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, stableValue(v[k])]));
  }
  return v;
}

function stackIdentity (it) {
  return `${it?.type ?? '?'}|${it?.metadata ?? 0}|${JSON.stringify(stableValue(it?.nbt || null))}`;
}

function compareSortedItems (bot, a, b) {
  const ca = CAT_ORDER.indexOf(categoryOf(bot, a)); const cb = CAT_ORDER.indexOf(categoryOf(bot, b));
  if (ca !== cb) return ca - cb;
  const ia = fullId(a.name); const ib = fullId(b.name);
  if (ia !== ib) return ia < ib ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  const sa = stackIdentity(a); const sb = stackIdentity(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function auditSortedRange (bot, w, start, end) {
  const items = []; let compact = true; let seenEmpty = false;
  for (let i = start; i < end; i++) {
    const it = w.slots[i];
    if (!it) { seenEmpty = true; continue; }
    if (seenEmpty) compact = false;
    items.push(it);
  }
  let ordered = true;
  for (let i = 1; i < items.length; i++) if (compareSortedItems(bot, items[i - 1], items[i]) > 0) { ordered = false; break; }
  const groups = new Map();
  for (const it of items) {
    const k = stackIdentity(it); const g = groups.get(k) || { count: 0, stacks: 0, size: it.stackSize || 64 };
    g.count += it.count; g.stacks++; groups.set(k, g);
  }
  let mergeableStacks = 0;
  for (const g of groups.values()) mergeableStacks += Math.max(0, g.stacks - Math.ceil(g.count / g.size));
  const cursorEmpty = !w.selectedItem;
  return { sorted: ordered && compact && mergeableStacks === 0 && cursorEmpty, ordered, compact, mergeableStacks, cursorEmpty, occupied: items.length };
}

function packedSlots (items) {
  const groups = new Map();
  for (const it of items || []) {
    const k = it.identity || stackIdentity(it); const g = groups.get(k) || { count: 0, size: it.stackSize || 64 };
    g.count += it.count || 0; groups.set(k, g);
  }
  let n = 0; for (const g of groups.values()) n += Math.ceil(g.count / g.size);
  return n;
}

function identityTotals (items) {
  const out = {};
  for (const it of items || []) {
    const k = it.identity || stackIdentity(it);
    out[k] = (out[k] || 0) + (it.count || 0);
  }
  return out;
}

function sameTotals (a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
}

/**
 * 8 格内有没有威胁：**原版怪按名字、模组怪按仇恨证据** —— 判据只在 entity-registry.js 一处
 * （AGENTS.md §5；以前这里有一份 `HOSTILE_RE`，比战斗本能那份短，模组怪漏了一半）。
 * 传 `state.aggroOf`（bridge 的，战斗本能同一份）：补名后 `type` 仍是 'other' 的模组怪只能靠行为证据认。
 */
function threatNear (bot, state, pos, r = 8) {
  return Object.values(bot.entities).find(e => e !== bot.entity && e.type !== 'player' && e.position && e.position.distanceTo(pos) < r
    && isHostileEntity(e, state?.aggroOf)) || null;
}

const CURIO_FIRST = 46;

const CAT_ORDER = ['食物', '作物种子', '矿物', '木头', '方块', '工具装备', '其他'];

let backpackChain = Promise.resolve();

const LOOT_ORDER = ['工具装备', '矿物', '食物', '其他', '方块', '木头', '作物种子'];

module.exports = { CAT_ORDER, CURIO_FIRST, LOOT_ORDER, anyOf, auditSortedRange, backpackChain, backpackOpen, backpackTidy, bind, categoryOf, checkChests, compareSortedItems, containerOpen, containerPut, containerTake, countInBackpackSeen, curiosEquip, curiosList, curiosOpen, curiosUnequip, decideCarry, deposit, ensureCarried, fetchAnyFromBackpack, fetchFromBackpack, ftbqSend, identityTotals, install, installModProtocols, lookIntoBackpack, lootCart, lootNearby, matcher, noteBackpack, noteCurios, noteSeen, organizeStorage, packedSlots, placeStructure, resolveCarryId, sameTotals, setHandsState, stableValue, stackIdentity, tally, threatNear, unseenCarts, unseenChests, wearingBackpack, withdraw };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 hands.js 的自测段里（同一个 (async () => {…})() 外套），
// 现在搬到这里 —— 断言一字未改，只是把原来「同一作用域里随手就能用」的 hands 函数
// 改成从 t.h（总表）取名（拆开后它们分在别的文件里）。
// 被汇总 require 时 register（登记不跑）；`node src/body/containers.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['[0] 精妙背包快照：窗口编号复用不能伪造空背包', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { locatePlayerInv, noteBackpack } = t.h;
      console.log('\n[0] 精妙背包快照：窗口编号复用不能伪造空背包');
      {
        const old = { items: { 'minecraft:iron_ingot': 58 }, slots: 108, used: 1, at: 1 };
        const state = { backpackWindowId: 7, backpackSeen: old };
        const ordinary = { id: 7, inventoryStart: 0, slots: [] }; // 普通窗口碰巧复用了旧编号
        check('旧编号相同但没有精妙同步标记 → 不覆写', noteBackpack(state, ordinary), false);
        check('原来的可信快照保留', state.backpackSeen, old);
        const soph = { id: 8, __sophisticated: true, inventoryStart: 2, slots: [{ name: 'iron_ingot', count: 58 }, null, null, null] };
        check('真实精妙窗口会更新', noteBackpack(state, soph), true);
        check('记录真实容量与铁锭', { slots: state.backpackSeen.slots, used: state.backpackSeen.used, iron: state.backpackSeen.items['minecraft:iron_ingot'] }, { slots: 2, used: 1, iron: 58 });
        const bad = { id: 9, __sophisticated: true, inventoryStart: 0, slots: [] };
        check('同步不完整的 0 格窗口也不覆写', noteBackpack(state, bad), false);

        const inv = [...Array(36)].map((_, i) => ({ type: 1000 + i, count: i + 1 }));
        const bot = { inventory: { slots: [...Array(9).fill(null), ...inv] } };
        const packet = Array(149).fill(null);
        for (let i = 0; i < 36; i++) { packet[i] = { ...inv[i] }; packet[108 + i] = { ...inv[i] }; }
        check('背包开头与玩家段内容相同 → 按界面结构选 108，不选 0', locatePlayerInv(bot, packet), 108);
        const emptyBot = { inventory: { slots: Array(45).fill(null) } };
        check('普通物品栏全空也能从 149 格结构认出 108', locatePlayerInv(emptyBot, Array(149).fill(null)), 108);
      }
  }],
  ['[0b] 整理终态：顺序、压紧、NBT 合堆和游标都要验', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3 } = t;
    const { auditSortedRange, identityTotals, knownTierOf, loadoutTargetShortfall, packedSlots, safeTransfer, sameTotals, stackIdentity } = t.h;
      console.log('\n[0b] 整理终态：顺序、压紧、NBT 合堆和游标都要验');
      {
        const fbot = { registry: { blocksByName: { cobblestone: {} } } };
        const item = (name, count, type, nbt = null, stackSize = 64) => ({ name, count, type, metadata: 0, nbt, stackSize });
        const iron = item('iron_ingot', 32, 1); const stone = item('cobblestone', 64, 2);
        check('矿物在方块前、末尾空格 → 已排序', auditSortedRange(fbot, { slots: [iron, stone, null], selectedItem: null }, 0, 3).sorted, true);
        check('中间空格后还有物品 → 未压紧', auditSortedRange(fbot, { slots: [iron, null, stone], selectedItem: null }, 0, 3).compact, false);
        check('两个同 NBT 的残堆还能合并 → 不算完成', auditSortedRange(fbot, { slots: [item('iron_ingot', 20, 1), item('iron_ingot', 10, 1)], selectedItem: null }, 0, 2).mergeableStacks, 1);
        check('同 ID 不同 NBT 不误判成可合并', auditSortedRange(fbot, { slots: [item('iron_ingot', 20, 1, { a: 1 }), item('iron_ingot', 10, 1, { a: 2 })], selectedItem: null }, 0, 2).mergeableStacks, 0);
        check('NBT 只有键顺序不同仍是同一签名', stackIdentity(item('book', 1, 5, { b: 2, a: 1 })) === stackIdentity(item('book', 1, 5, { a: 1, b: 2 })), true);
        check('鼠标还拿着东西 → 不算完成', auditSortedRange(fbot, { slots: [iron], selectedItem: stone }, 0, 1).cursorEmpty, false);
        check('已知材质等级：下界合金优于木头；模组未知不猜', [knownTierOf('netherite_pickaxe'), knownTierOf('wooden_pickaxe'), knownTierOf('mod:star_pickaxe')], [0, 5, null]);
        check('容量按合并后的真实格数算（32+40 铁锭占 2 格）', packedSlots([item('iron_ingot', 32, 1), item('iron_ingot', 40, 1)]), 2);
        check('不同 NBT 分开占格', packedSlots([item('enchanted_book', 1, 3, { a: 1 }, 1), item('enchanted_book', 1, 3, { a: 2 }, 1)]), 2);
        check('16 上限物品不按 64 错算', packedSlots([item('bucket', 17, 4, null, 16)]), 2);
        check('物品守恒不受槽位/顺序影响', sameTotals(identityTotals([item('iron_ingot', 20, 1), item('cobblestone', 3, 2)]), identityTotals([item('cobblestone', 3, 2), item('iron_ingot', 7, 1), item('iron_ingot', 13, 1)])), true);
        check('少一个也能发现', sameTotals(identityTotals([item('iron_ingot', 20, 1)]), identityTotals([item('iron_ingot', 19, 1)])), false);
        check('终态按目标数报缺，不把“超过最低生存线”误当补齐', loadoutTargetShortfall(fbot, [item('torch', 5, 6)], [{ kind: 'id', id: 'minecraft:torch', count: 16, label: '火把', essential: true }]), [{ label: '火把', have: 5, target: 16, essential: true }]);
        const fw = { slots: [null, null], inventoryEnd: 2, selectedItem: null };
        const transferBot = {
          currentWindow: fw,
          transfer: async () => { fw.selectedItem = item('iron_ingot', 8, 1); throw new Error('destination full'); },
          clickWindow: async (slot) => { fw.slots[slot] = fw.selectedItem; fw.selectedItem = null; },
        };
        let transferError = null; try { await safeTransfer(transferBot, { window: fw }); } catch (e) { transferError = e.message; }
        check('transfer 失败会先把游标物品放回窗口，不丢到地上', { error: transferError, cursor: fw.selectedItem, restored: fw.slots[0]?.count }, { error: 'destination full', cursor: null, restored: 8 });
      }
  }],
];
register('containers', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 单独跑本文件：先把总表接上（原来所有 hands 函数在同一作用域，小节随手就能取）。
  // 总表用汇总额外导出的 __ns（8 个文件的全部名字），不是那 47 个对外接口。
  require('./testkit').bindHands(require('./index').__ns);
  const { runSuite } = require('./testkit');
  runSuite('containers', __sections);
}
