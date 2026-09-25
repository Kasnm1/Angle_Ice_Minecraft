'use strict';

/**
 * 她的手 —— 用背包里的东西、穿装备、开界面、合成、烧东西。
 *
 * ## 为什么单独一个文件
 *
 * bridge-server.js 原来的"手"只有：走、挖、放方块、打、说话、原版合成。
 * **"使用物品 / 打开界面"这一整类动作从来没有过** —— 于是：
 *   · 吃不了东西（/eat 全靠一个没装的插件，失败 → 反射也跟着失效，她会饿死）
 *   · 穿不了装备（/equip 要调用方自己知道该放哪个槽，模组盔甲/饰品根本不知道）
 *   · 用不了熔炉、厨锅、箱子（没有"打开界面、放进格子、取出来"）
 *   · 合成只认 minecraft-data 的原版配方 —— 被整合包改过的、模组的，一概做不了
 *
 * ## 原则：每个动作都**核对结果**，不信"调用成功"
 *
 * 上一轮的教训：快脑决定了 `eat`，日志里写着"做[pickup,eat]"，
 * 于是所有人（包括我）都以为她吃了 —— 实际饥饿值从 5 掉到 3，鸡肉原封不动。
 * 所以这里每个动作都比对前后的背包 / 装备 / 饥饿值，返回**实际发生了什么**。
 *
 * ## 接口（挂到 bridge 的 handlers 上）
 *
 *   POST /eat        {itemName?}                          吃（不给名字自己挑）
 *   POST /use        {itemName?, target?, x,y,z, entity, hand, holdMs}   右键
 *   POST /wear       {itemName}                           穿戴（盔甲 / 模组装备 / 饰品）
 *   POST /craft2     {itemName, count}                    按**整合包真实配方**合成
 *   POST /smelt      {itemName, count, fuel?}             熔炉 / 烟熏炉 / 高炉
 *   POST /container/open   {x,y,z}                        右键打开任意方块的界面
 *   GET  /container                                       当前界面里有什么
 *   POST /container/put    {slot, itemName, count}        放进某一格
 *   POST /container/take   {slot, count?}                 从某一格拿出来
 *   POST /container/close
 */

const { Vec3 } = require('vec3');

let knowledge = null;
function K () {
  if (!knowledge) knowledge = require('./knowledge');
  return knowledge;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ 名字

/** bot 背包里：原版不带前缀（stone），模组带（farmersdelight:tomato）。知识库一律带前缀。 */
const botName = (id) => (String(id).startsWith('minecraft:') ? String(id).slice(10) : String(id));
const fullId = (name) => (String(name).includes(':') ? String(name) : `minecraft:${name}`);

function findItem (bot, name) {
  if (!name) return null;
  const want = fullId(name);
  const items = bot.inventory.items();
  return items.find(i => fullId(i.name) === want)
    // 中文名 / 模糊名：交给知识库解析一次
    || (() => {
      const id = K().resolve(name, 1)[0];
      return id ? items.find(i => fullId(i.name) === id) : null;
    })();
}

function invCounts (bot) {
  const m = new Map();
  for (const it of bot.inventory.slots) {
    if (it) m.set(fullId(it.name), (m.get(fullId(it.name)) || 0) + it.count);
  }
  return m;
}

function delta (before, after) {
  const gained = {}; const lost = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(k) || 0) - (before.get(k) || 0);
    if (d > 0) gained[k] = d;
    if (d < 0) lost[k] = -d;
  }
  return { gained, lost };
}

const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

function equipment (bot) {
  const s = bot.inventory.slots;
  const n = (i) => (s[i] ? fullId(s[i].name) : null);
  return { head: n(5), torso: n(6), legs: n(7), feet: n(8), 'off-hand': n(45), hand: bot.heldItem ? fullId(bot.heldItem.name) : null };
}

function equipChanges (a, b) {
  const out = {};
  for (const k of Object.keys(b)) if (a[k] !== b[k]) out[k] = { from: a[k], to: b[k] };
  return out;
}

// ------------------------------------------------------------------ 界面补丁（模组界面）

/**
 * mineflayer 打开**不认识类型**的界面（1.20 的 open_window 只给数字类型、不给格子数）时，
 * `createWindow` 返回 null，接着 `prepareWindow(null)` 读 `.id` 直接抛错 ——
 * 而这发生在收包回调里，轻则界面打不开，重则把 bridge 弄挂。
 * 模组工作站（厨锅、砧板…）全是这种。
 *
 * 修法：抢在 mineflayer 之前看一眼这个包。不认识的类型就先塞一个占位格子数，
 * 让它建出一个通用界面；等 `window_items` 到了（它带着全部格子），再把界面**原地**改成真实大小。
 * 原地改是关键：mineflayer 在 prepareWindow 的闭包里拿着同一个对象，换对象它就对不上了。
 */
let HSTATE = null;   // 给 approach 这类不带 state 的函数用（跨楼层要走路线规划）

function install (bot, state) {
  HSTATE = state;
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

// ------------------------------------------------------------------ 门（门 / 栅栏门 / 活板门）

/**
 * 门有"开 / 关"两种状态（方块属性 open）。模组的门也一样 —— 所以按属性认，不按名字列清单。
 *
 * 看牧场最怕的是：穿过栅栏门没关，动物全跑了。真人是**随手关门**的，这是习惯不是思考，
 * 所以放在身体层：她**自己打开的**门，走过去之后自动关回原样。
 * 本来就开着的门不碰 —— 那是主人的布置（比如梯子顶常开的活板门）。
 * 她所有开门的途径（右键、爬梯子推活板门、/activate）最后都走 bot.activateBlock，在这里包一层就全管住了。
 */
const isDoorLike = (b) => !!b && typeof b.getProperties === 'function' && 'open' in (b.getProperties() || {})
  && /door|gate|trapdoor|hatch/.test(b.name);
const isOpen = (b) => String(b.getProperties().open).toLowerCase() === 'true';
const doorKey = (p) => `${p.x},${p.y},${p.z}`;

function doorKind (b) {
  return /trapdoor|hatch/.test(b.name) ? '活板门' : /gate/.test(b.name) ? '栅栏门' : '门';
}

/** 门是上下两格的：以下半格为准（右键哪一半都行，但状态要读下半格） */
function doorBase (bot, pos) {
  const b = bot.blockAt(pos);
  if (b && /door/.test(b.name) && !/trapdoor/.test(b.name) && String(b.getProperties().half).toLowerCase() === 'upper') return bot.blockAt(pos.offset(0, -1, 0));
  return b;
}

function installDoorHabit (bot, state) {
  if (typeof bot.activateBlock !== 'function' || bot.__doorHabit) return;
  bot.__doorHabit = true;
  state.doorsIOpened = new Map();   // key → {pos, name, openedAt}
  state.doorsLeftOpen = state.doorsLeftOpen || [];   // 走远了没来得及关的
  const orig = bot.activateBlock.bind(bot);
  bot.activateBlock = async (block, ...rest) => {
    const base = block && doorBase(bot, block.position);
    const wasClosed = base && isDoorLike(base) && !isOpen(base);
    const r = await orig(block, ...rest);
    if (wasClosed && !state.__closingDoor) {
      await sleep(250);
      const now = bot.blockAt(base.position);
      if (now && isDoorLike(now) && isOpen(now)) state.doorsIOpened.set(doorKey(base.position), { pos: base.position.clone(), name: now.name, openedAt: Date.now(), wasAt: bot.entity.position.clone() });
    }
    return r;
  };

  // 每 300ms 看一眼：自己开的门，人已经过去了（离开门那格 1.5 格以上）就关上
  setInterval(async () => {
    if (!bot.entity || state.__closingDoor || !state.doorsIOpened.size) return;
    for (const [k, d] of state.doorsIOpened) {
      const b = bot.blockAt(d.pos);
      if (!b || !isDoorLike(b) || !isOpen(b)) { state.doorsIOpened.delete(k); continue; }   // 已经关了（别人关的也算）
      const center = d.pos.offset(0.5, 0.5, 0.5);
      const dist = bot.entity.position.offset(0, 1.62, 0).distanceTo(center);
      const inside = Math.floor(bot.entity.position.x) === d.pos.x && Math.floor(bot.entity.position.z) === d.pos.z
        && Math.abs(bot.entity.position.y - d.pos.y) < 2;
      const young = Date.now() - d.openedAt < 1500;
      if (inside || young) continue;
      // 还站在开门时的位置附近（开了门还没走过去）：别急着关
      if (bot.entity.position.distanceTo(d.wasAt) < 0.8 && Date.now() - d.openedAt < 20000) continue;
      if (dist > 4.4) {
        state.doorsIOpened.delete(k);
        state.doorsLeftOpen.push({ pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, name: d.name, at: Date.now() });
        continue;
      }
      if (dist < 1.3) continue;   // 还贴着门：再走一步
      state.__closingDoor = true;
      try {
        await bot.lookAt(center, true);
        await orig(b);
        await sleep(250);
        const after = bot.blockAt(d.pos);
        if (after && !isOpen(after)) { state.doorsIOpened.delete(k); state.lastDoorClosed = { pos: doorKey(d.pos), name: d.name, at: Date.now() }; }
      } catch (_) { /* 下一轮再试 */ } finally { state.__closingDoor = false; }
    }
  }, 300);
}

function doorsNear (bot, radius = 8) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => /door|gate|trapdoor|hatch/.test(b.name)).map(b => b.id);
  const out = [];
  for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })) {
    const b = doorBase(bot, p);
    if (!b || !isDoorLike(b)) continue;
    const k = doorKey(b.position);
    if (out.some(o => o.key === k)) continue;
    out.push({ key: k, x: b.position.x, y: b.position.y, z: b.position.z, name: b.name, kind: doorKind(b), open: isOpen(b), distance: +bot.entity.position.distanceTo(b.position.offset(0.5, 0, 0.5)).toFixed(1) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** 把一扇门设成想要的状态（已经是就不动），并核对 */
async function setDoor (bot, state, { x, y, z, open }) {
  if ([x, y, z].some(v => v == null) || typeof open !== 'boolean') throw new Error('要给 x y z 和 open(true/false)');
  let b = doorBase(bot, new Vec3(x, y, z));
  if (!b || !isDoorLike(b)) throw new Error(`(${x},${y},${z}) 不是门/栅栏门/活板门（是 ${b?.name || '空'}）`);
  if (isOpen(b) === open) return { already: true, open, name: b.name };
  await approach(bot, b);
  state.__closingDoor = !open;    // 主动关门：别让"随手关门"的习惯再记一笔
  try {
    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(b);
    await sleep(300);
  } finally { state.__closingDoor = false; }
  b = bot.blockAt(b.position);
  if (isOpen(b) !== open) throw new Error(`右键了，但${doorKind(b)}还是${isOpen(b) ? '开' : '关'}着（可能是铁门，要红石）`);
  if (!open) state.doorsIOpened?.delete(doorKey(b.position));
  // 主动打开的门：也按习惯，走过去会随手关（除非她明说要一直开着 —— 那就用 keepOpen）
  return { done: true, open, name: b.name };
}

// ------------------------------------------------------------------ 模组协议：精妙背包（sophisticatedcore）、Curios 饰品栏

/**
 * 精妙背包的格子内容不走原版同步（一格能堆超过 64，原版的 byte 装不下），走自己的通道
 * sophisticatedcore:channel（Forge SimpleChannel，首字节是消息序号）：
 *   2 = SyncContainerStacksMessage：byte 窗口号 | varint stateId | short 格数 | 每格 PacketHelper.writeItemStack | 手上拿的（原版格式）
 *   3 = SyncSlotStackMessage：      byte 窗口号 | varint stateId | short 格号 | PacketHelper.writeItemStack
 *   PacketHelper.writeItemStack：bool 有没有 | varint 物品 id | int 数量（4 字节）| NBT（可能是 0 = 没有）
 * 这些是从 sophisticatedcore-1.20.1-1.2.83 的 class 文件里反汇编出来的（javap）。
 */
function readVarInt (buf, o) {
  let n = 0; let shift = 0; let b;
  do { b = buf[o.i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return n;
}

function readNbt (buf, o) {
  if (buf[o.i] === 0) { o.i++; return null; }
  const nbt = require('prismarine-nbt');
  const r = nbt.protos.big.parsePacketBuffer('nbt', buf.subarray(o.i));
  o.i += r.metadata.size;
  return r.data;
}

function readSophItem (bot, buf, o) {
  if (!buf[o.i++]) return null;
  const id = readVarInt(buf, o);
  const count = buf.readInt32BE(o.i); o.i += 4;
  const tag = readNbt(buf, o);
  const Item = require('prismarine-item')(bot.registry);
  return new Item(id, count, 0, tag || undefined);
}

/** 背包界面里哪一段是她自己的 36 格：拿身上的东西去比对（背包界面还可能带升级格，不能简单按"最后 36 格"算） */
function locatePlayerInv (bot, items) {
  const mine = bot.inventory.slots.slice(9, 45).map(x => (x ? `${x.type}:${x.count}` : '-'));
  if (mine.every(x => x === '-')) return Math.max(0, items.length - 36);
  let best = -1; let bestScore = -1;
  for (let k = 0; k + 36 <= items.length; k++) {
    let sc = 0;
    for (let j = 0; j < 36; j++) { const x = items[k + j]; if ((x ? `${x.type}:${x.count}` : '-') === mine[j] && mine[j] !== '-') sc++; }
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  return best < 0 ? Math.max(0, items.length - 36) : best;
}

function installModProtocols (bot, state) {
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
        const start = locatePlayerInv(bot, items);
        w.inventoryStart = start; w.inventoryEnd = start + 36; w.hotbarStart = start + 27;
        w.__sophisticated = true;
        state.lastSophSync = { windowId, slots: n, playerInvAt: start, at: Date.now() };
      } else {
        const slot = buf.readInt16BE(o.i); o.i += 2;
        const it = readSophItem(bot, buf, o);
        if (slot >= 0 && slot < w.slots.length) w.slots[slot] = it;
      }
    } catch (e) { state.lastSophError = e.message; }
  });
}

/** 打开 Curios 饰品栏：curios:main 的 0 号消息（CPacketOpenCurios），内容 = 手上拿的物品（空 = 一个 0 字节） */
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

/** 饰品栏界面：0 合成结果、1–4 合成格、5–8 盔甲、9–44 背包、45 副手、46 起是饰品格 */
const CURIO_FIRST = 46;

/** 饰品栏不开界面看不到 —— 每次开过就记下戴着什么，给 /equipment 用（她得知道自己背着背包、戴着戒指） */
function noteCurios (state, w) {
  state.curiosWorn = w.slots.slice(CURIO_FIRST).filter(Boolean).map(x => fullId(x.name));
  state.curiosAt = Date.now();
}

/** 背包里有什么：开过就记下（背在背上的背包不开也看不到） */
function noteBackpack (state, w) {
  if (!w || state.backpackWindowId !== w.id) return;
  const items = {};
  for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
  state.backpackSeen = { items, slots: w.inventoryStart, used: w.slots.slice(0, w.inventoryStart).filter(Boolean).length, at: Date.now() };
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
  // 刚关完别的界面马上开，偶尔格子同步对不上（界面 0 格）：关掉等一下再开一次
  if (!(w.__sophisticated && w.inventoryStart > 0) && retry) { bot.closeWindow(w); await sleep(800); return backpackOpen(bot, state, false); }
  noteBackpack(state, w);
  return { backpack: true, synced: (state.lastSophSync?.at || 0) > syncBefore, ...summarizeWindow(bot, state) };
}

// ------------------------------------------------------------------ 吃

const FOOD_RE = /(cooked|baked|roast|grilled|fried|_stew|_soup|salad|bread|pie|cake_slice|sandwich|burger|dumpling|rice|noodle|pasta|kebab|skewer|apple|carrot|potato|beetroot|melon_slice|berries|cookie|chicken|beef|porkchop|mutton|rabbit|cod|salmon|_meat|steak|bacon|ham|sausage|jerky|sushi|onigiri|pudding|jam|toast|pancake|waffle|donut|muffin|fruit|_juice)/;
const NOT_FOOD_RE = /(seeds|sapling|_block|crate|bag|_bucket$|spawn_egg|raw_|rotten|poisonous|spider_eye|pufferfish)/;

function foodScore (it) {
  if (it.foodPoints > 0) return it.foodPoints * 2;
  const n = it.name;
  if (NOT_FOOD_RE.test(n)) return 0;
  if (/cooked|baked|roast|grilled|stew|soup|pie|bread|steak|burger|sandwich|meal|rice|noodle/.test(n)) return 8;
  return FOOD_RE.test(n) ? 3 : 0;
}

async function eat (bot, { itemName } = {}) {
  let item;
  if (itemName) {
    item = findItem(bot, itemName);
    if (!item) throw new Error(`背包里没有 ${itemName}`);
  } else {
    item = bot.inventory.items().map(i => [i, foodScore(i)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!item) return { ate: false, reason: '背包里没有能吃的东西' };
  }
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
  return { ate: true, item: item.name, foodBefore, foodAfter: bot.food, consumed: d.lost };
}

// ------------------------------------------------------------------ 右键

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
    const dist = bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
    if (dist > 4.5) throw new Error(`太远了（${dist.toFixed(1)} 格，要 4.5 以内）—— 先走过去`);
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

// ------------------------------------------------------------------ 穿戴

function slotByName (name) {
  const n = String(name).toLowerCase();
  if (/(helmet|_cap$|_hat$|crown|mask|goggles|_hood$|circlet|headband)/.test(n)) return 'head';
  if (/(chestplate|tunic|robe|jacket|_chest$|cuirass|_vest$|breastplate|elytra)/.test(n)) return 'torso';
  if (/(leggings|pants|trousers|greaves)/.test(n)) return 'legs';
  if (/(boots|shoes|sabatons|_feet$)/.test(n)) return 'feet';
  if (/shield/.test(n)) return 'off-hand';
  return null;
}

async function wear (bot, state, { itemName } = {}) {
  const it = findItem(bot, itemName);
  if (!it) throw new Error(`背包里没有 ${itemName}`);
  const eq0 = equipment(bot); const inv0 = invCounts(bot);
  const dest = slotByName(it.name);
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

// ------------------------------------------------------------------ 合成（整合包真实配方）

function nearestBlock (bot, names, maxDistance = 4.4) {
  const ids = names.map(n => bot.registry.blocksByName[botName(n)]?.id).filter(v => v != null);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance });
}

const REACH = 4.2;
function eyeDist (bot, block) {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
}

/**
 * 走到方块旁边（够得着为止）。真人要用熔炉会自己走过去 —— 不该让大脑先算好坐标再 goto。
 * 16 格内的才走；更远的交回给大脑（那是"去某处"的规划问题，不是"伸手"）。
 */
async function approach (bot, block) {
  if (eyeDist(bot, block) <= REACH) return { walked: false };
  const { goals } = require('mineflayer-pathfinder');
  const p = block.position;
  const t0 = Date.now();
  // 不在同一层（锅在一楼厨房、她在三楼仓库）：用会爬梯子、开门的路线走过去
  if (Math.abs(p.y - bot.entity.position.y) >= 2.5 && HSTATE) {
    await go(bot, HSTATE, { x: p.x, y: p.y, z: p.z, range: 2 });
    if (eyeDist(bot, block) <= REACH) return { walked: true, ms: Date.now() - t0, via: 'route' };
  }
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)),
      sleep(20000).then(() => { throw new Error('走了 20 秒还没到'); }),
    ]);
  } catch (e) {
    bot.pathfinder.setGoal(null);
    if (eyeDist(bot, block) > REACH) throw new Error(`走不到 ${block.name}(${p.x},${p.y},${p.z}) 旁边：${e.message}`);
  }
  if (eyeDist(bot, block) > REACH) throw new Error(`走到了但还是够不着 ${block.name}（${eyeDist(bot, block).toFixed(1)} 格）`);
  return { walked: true, ms: Date.now() - t0 };
}

/** 找最近的某种方块：先看伸手范围内，没有再看 16 格内（找到就走过去） */
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
async function craft2 (bot, { itemName, count = 1 } = {}, withTimeout) {
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
  const have = invCounts(bot);
  const inTag = (tag, x) => KB.tags.get(`item:${tag}`)?.has(x);
  const tried = [];

  for (const r of cands) {
    const per = r.out.find(o => o.item === id)?.count || 1;
    const times = Math.ceil(count / per);
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
      if (!table) { tried.push('要工作台，但 16 格内没有（背包里有的话先 place 放下）'); continue; }
    }
    const before = invCounts(bot);
    await withTimeout(bot.craft(recipe, times, recipe.requiresTable ? table : null), 20000);
    await sleep(300);
    const d = delta(before, invCounts(bot));
    const made = d.gained[id] || 0;
    if (!made) throw new Error(`按配方 ${r.id} 摆好了，但没拿到 ${k.label(id)}（服务器没认这个配方？）`);
    return { crafted: id, made, recipe: r.id, consumed: d.lost, usedTable: !!recipe.requiresTable };
  }
  throw new Error(`现在做不了 ${k.label(id)}：${[...new Set(tried)].slice(0, 4).join('；')}`);
}

// ------------------------------------------------------------------ 熔炉类

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

/** 挑燃料：优先一种就够用的，不够就挑最耐烧的 */
function pickFuel (bot, avoid, need) {
  const items = bot.inventory.items().filter(i => fullId(i.name) !== avoid)
    .map(i => ({ i, v: fuelValue(bot, i) })).filter(x => x.v > 0);
  if (!items.length) return null;
  const enough = items.filter(x => x.v * x.i.count >= need).sort((a, b) => a.v - b.v)[0];
  return (enough || items.sort((a, b) => b.v * b.i.count - a.v * a.i.count)[0]);
}

async function smelt (bot, { itemName, count = 1, fuel } = {}) {
  const k = K(); const KB = k.load();
  const input = findItem(bot, itemName);
  if (!input) throw new Error(`背包里没有 ${itemName}`);
  // 按原料找配方，决定用哪种炉子
  const idx = new Set(KB.byInput.get(fullId(input.name)) || []);
  for (const t of KB.itemTags.get(fullId(input.name)) || []) for (const i of KB.byInput.get(`#${t}`) || []) idx.add(i);
  const types = new Set([...idx].map(i => KB.recipes[i].type));
  const order = [['minecraft:smelting', 'furnace'], ['minecraft:smoking', 'smoker'], ['minecraft:blasting', 'blast_furnace']];
  let block = null; let used = null;
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
  if (!cands.length) throw new Error(`16 格内没有能烧它的炉子（需要：${usable.map(([, b]) => b).join(' / ')}）`);
  cands.sort((a, b2) => a.d - b2.d);
  const why = [];
  for (const c of cands) {
    try { await approach(bot, c.blk); block = c.blk; used = c.type; break; } catch (e) { why.push(e.message); }
  }
  if (!block) throw new Error(`附近的炉子都走不过去：${why.slice(0, 3).join('；')}`);
  const recipe = [...idx].map(i => KB.recipes[i]).find(r => r.type === used);
  const outId = recipe.out[0].item;

  let n = Math.min(count, input.count);
  const before = invCounts(bot);
  const furnace = await bot.openFurnace(block);
  let fuelNote = null;
  try {
    // 炉子里原本有燃料就算上它（按剩余火候估不准，保守当作只够 1 个）
    const existing = furnace.fuelItem() ? fuelValue(bot, furnace.fuelItem()) * furnace.fuelItem().count : 0;
    const need = Math.max(0, n - existing);
    if (need > 0) {
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
    const each = used === 'minecraft:smelting' ? 10000 : 5000;
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
  const out = { smelted: fullId(input.name), in: block.name, got: d.gained, gotCount: got, asked: count, fuelNote };
  if (leftIn > 0) out.warning = `还有 ${leftIn} 个原料留在炉子里没拿回来（${block.position.x},${block.position.y},${block.position.z}）`;
  if (got < count) out.note = `要烧 ${count} 个，实际拿到 ${got} 个${fuelNote ? `：${fuelNote}` : ''}`;
  return out;
}

// ------------------------------------------------------------------ 递东西给玩家

/**
 * 以前的"给"= 朝玩家方向丢出去就算完。结果：玩家没接到，2 秒后她自己又捡回来，
 * 嘴上却说"给你尝尝"（实测）。现在：走到 1.5 格内 → 对准胸口丢 → 盯着这个掉落物被谁捡走。
 */
async function give (bot, { itemName, count, player } = {}) {
  const it = findItem(bot, itemName);
  if (!it) throw new Error(`背包里没有 ${itemName}`);
  const target = bot.players[player]?.entity;
  if (!target) throw new Error(`看不见 ${player}（不在视野内）`);
  const { goals } = require('mineflayer-pathfinder');
  if (bot.entity.position.distanceTo(target.position) > 2) {
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1.5)),
        sleep(15000).then(() => { throw new Error('超时'); }),
      ]);
    } catch (e) {
      bot.pathfinder.setGoal(null);
      if (bot.entity.position.distanceTo(target.position) > 3.5) throw new Error(`走不到 ${player} 身边：${e.message}`);
    }
  }
  await bot.lookAt(target.position.offset(0, 1.1, 0), true);
  const n = count ? Math.min(count, it.count) : it.count;
  const wantId = fullId(it.name);

  // 丢出去的掉落物是一个新实体；记下它，再看 playerCollect 是谁捡的
  let dropped = null; let collector = null;
  const onSpawn = (e) => {
    if (!dropped && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 3) dropped = e;
  };
  const onCollect = (who, what) => { if (dropped && what.id === dropped.id) collector = who; };
  bot.on('entitySpawn', onSpawn);
  bot.on('playerCollect', onCollect);
  try {
    if (n >= it.count) await bot.tossStack(it); else await bot.toss(it.type, null, n);
    for (let i = 0; i < 30 && !collector; i++) await sleep(200);   // 最多等 6 秒
  } finally {
    bot.removeListener('entitySpawn', onSpawn);
    bot.removeListener('playerCollect', onCollect);
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

// ------------------------------------------------------------------ 上楼（梯子）

/**
 * 爬梯子上楼，一段接一段。
 *
 * 实测她**爬得上去**（/climb 能到梯子顶、会推开活板门），卡在的是**爬到顶之后跨出去**：
 * 寻路器不会"从梯子顶迈到旁边的地板"，于是 come_to 从梯子顶规划路线，一路把她带回了楼下。
 * 模型换了十几种说法重试都一样 —— 这是手缺一个动作，不是脑子学不会。
 *
 * 这里把整件事做完：找往上的梯子 → 站进梯子最下面那格 → 头顶活板门关着就推开 →
 * 按住跳往上爬 → 到顶后朝旁边能站的地板迈出去 → 还没到想去的高度就找下一段梯子。
 */
const isLadder = (b) => !!b && /ladder|vine|scaffolding/.test(b.name);
const passable = (b) => !b || b.boundingBox === 'empty' || /air|trapdoor|ladder|carpet|torch|button|sign|flower|grass$|snow_layer/.test(b.name) && !(/trapdoor/.test(b.name) && !isOpen(b));
const solidUnder = (b) => !!b && b.boundingBox === 'block' && !/ladder|trapdoor/.test(b.name);

function ladderColumns (bot, maxDistance = 16) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => /ladder|vine|scaffolding/.test(b.name)).map(b => b.id);
  const pts = bot.findBlocks({ matching: ids, maxDistance, count: 400 });
  const cols = new Map();
  for (const p of pts) {
    const k = `${p.x},${p.z}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(p.y);
  }
  const out = [];
  for (const [k, ys] of cols) {
    const [x, z] = k.split(',').map(Number);
    ys.sort((a, b) => a - b);
    // 连续的一段算一架梯子
    let start = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i === ys.length || ys[i] !== ys[i - 1] + 1) { out.push({ x, z, bottom: start, top: ys[i - 1] }); start = ys[i]; }
    }
  }
  return out;
}

async function holdControls (bot, controls, ms) {
  for (const c of controls) bot.setControlState(c, true);
  await sleep(ms);
  bot.clearControlStates();
  await sleep(60);
}

/** 走进 (x,y,z) 那一格（梯子格可以站进去）。先寻路到旁边，再用按键对准 */
async function stepInto (bot, x, y, z) {
  const { goals } = require('mineflayer-pathfinder');
  const inCell = () => { const p = bot.entity.position; return Math.floor(p.x) === x && Math.floor(p.z) === z && Math.abs(p.y - y) < 1.2; };
  if (!inCell()) {
    try {
      await Promise.race([bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)), sleep(20000).then(() => { throw new Error('超时'); })]);
    } catch (_) { bot.pathfinder.setGoal(null); }
  }
  for (let i = 0; i < 8 && !inCell(); i++) {
    await bot.lookAt(new Vec3(x + 0.5, bot.entity.position.y + 1.6, z + 0.5), true);
    await holdControls(bot, i % 3 === 2 ? ['forward', 'jump'] : ['forward'], 250);   // 隔几下跳一跳，别只是往墙上顶
    if (i === 4 && !inCell()) await wiggle(bot, { rounds: 1 }).catch(() => {});
  }
  return inCell();
}

async function climbColumn (bot, state, col) {
  const log = [];
  // 头顶（梯子顶上一格）是关着的活板门：先推开
  const hatchPos = new Vec3(col.x, col.top + 1, col.z);
  const hatch = bot.blockAt(hatchPos);
  if (hatch && /trapdoor/.test(hatch.name) && !isOpen(hatch)) {
    log.push(`梯子顶上的活板门关着`);
    // 站在梯子里、够得着的时候再开（先爬到接近顶）
  }
  const onThisLadder = () => { const p = bot.entity.position; return Math.floor(p.x) === col.x && Math.floor(p.z) === col.z && p.y >= col.bottom - 0.2 && p.y <= col.top + 1; };
  if (!onThisLadder()) {
    if (!await stepInto(bot, col.x, col.bottom, col.z)) throw new Error(`走不进梯子 (${col.x},${col.bottom},${col.z})`);
    log.push(`站进了梯子 (${col.x},${col.bottom},${col.z})`);
  } else log.push(`就在梯子上 (y=${bot.entity.position.y.toFixed(1)})，接着爬`);

  // 对准：人爬梯子是贴着梯子、面朝墙按住"前进"。梯子的 facing 是它背对墙的方向，墙在 -facing 那边
  const FACE = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
  const lad = bot.blockAt(new Vec3(col.x, Math.max(col.bottom, Math.min(col.top, Math.floor(bot.entity.position.y))), col.z));
  const [fx, fz] = FACE[String(lad?.getProperties?.().facing || '').toLowerCase()] || [0, 0];
  const spot = { x: col.x + 0.5 - fx * 0.18, z: col.z + 0.5 - fz * 0.18 };
  const wall = new Vec3(col.x + 0.5 - fx * 3, 0, col.z + 0.5 - fz * 3);
  const aligned = () => Math.hypot(bot.entity.position.x - spot.x, bot.entity.position.z - spot.z) <= 0.2;
  const align = async () => {
    if (aligned()) return;
    const r = await nudge(bot, { x: spot.x, z: spot.z, tol: 0.12, maxSteps: 12 });
    log.push(r.reached ? `对准了梯子（误差 ${r.error}）` : `对得不太准（差 ${r.error}）`);
  };
  await align();

  // 往上爬到梯子顶那一格的上面（出口层）
  const exitFeetY = col.top + 1;
  const deadline = Date.now() + 4000 + (col.top - col.bottom + 2) * 900;
  let stalled = 0; let lastY = bot.entity.position.y; let opened = false;
  while (Date.now() < deadline && bot.entity.position.y < exitFeetY - 0.25) {
    const h0 = bot.blockAt(hatchPos);
    if (!opened && h0 && /trapdoor/.test(h0.name) && !isOpen(h0) && eyeDist(bot, h0) <= REACH) {
      await bot.lookAt(hatchPos.offset(0.5, 0.2, 0.5), true);
      await bot.activateBlock(h0, new Vec3(0, -1, 0), new Vec3(0.5, 0, 0.5));
      await sleep(300);
      opened = true; log.push('推开了头顶的活板门');
    }
    // 面朝墙按住前进+跳（没有朝向信息的梯子就看向格子中间）
    await bot.lookAt(fx || fz ? wall.offset(0, bot.entity.position.y + 1.6, 0) : new Vec3(col.x + 0.5, bot.entity.position.y + 1.6, col.z + 0.5), true);
    await holdControls(bot, fx || fz ? ['forward', 'jump'] : ['jump'], 400);
    // 爬着爬着偏出梯子格了：停下重新对准（蹲着挪，挂在梯子上也不会掉）
    { const p = bot.entity.position; if (Math.floor(p.x) !== col.x || Math.floor(p.z) !== col.z) { await align(); } }
    const y = bot.entity.position.y;
    if (y - lastY < 0.05) stalled++; else stalled = 0;
    lastY = y;
    if (stalled === 3 && !state.__climbWiggled) {
      state.__climbWiggled = true;
      await holdControls(bot, ['jump'], 300); await align();          // 跳一下、重新贴好梯子再爬
      stalled = 0; continue;
    }
    if (stalled >= 3) {
      state.__climbWiggled = false;
      const h = bot.blockAt(hatchPos);
      if (!opened && h && /trapdoor/.test(h.name) && !isOpen(h)) {
        await bot.activateBlock(h, new Vec3(0, -1, 0), new Vec3(0.5, 0, 0.5));
        await sleep(300);
        opened = true; stalled = 0; log.push('推开了头顶的活板门');
        continue;
      }
      break;
    }
  }
  const topY = bot.entity.position.y;
  if (topY < exitFeetY - 0.6) throw new Error(`爬到 y=${topY.toFixed(1)} 就上不去了（梯子顶是 ${col.top}）`);
  log.push(`爬到了 y=${topY.toFixed(1)}`);

  // 迈出去：找梯子顶旁边能站的格子（脚下实心、身体两格空）
  const landY = col.top + 2;
  const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: col.x + dx, z: col.z + dz }))
    .filter(c => solidUnder(bot.blockAt(new Vec3(c.x, landY - 1, c.z))) && passable(bot.blockAt(new Vec3(c.x, landY, c.z))) && passable(bot.blockAt(new Vec3(c.x, landY + 1, c.z))));
  // 出口层就在梯子顶上一格（活板门那层地板）的情况：脚下是地板，站在 top+1
  const exits2 = exits.length ? [] : [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: col.x + dx, z: col.z + dz, y: col.top + 1 }))
    .filter(c => solidUnder(bot.blockAt(new Vec3(c.x, c.y - 1, c.z))) && passable(bot.blockAt(new Vec3(c.x, c.y, c.z))) && passable(bot.blockAt(new Vec3(c.x, c.y + 1, c.z))));
  const cands = exits.length ? exits.map(c => ({ ...c, y: landY })) : exits2;
  if (!cands.length) throw new Error(`爬到顶了，但梯子顶 (${col.x},${col.top},${col.z}) 旁边没有能站的地方`);
  for (const c of cands) {
    for (let i = 0; i < 6; i++) {
      await bot.lookAt(new Vec3(c.x + 0.5, c.y + 1.6, c.z + 0.5), true);
      await holdControls(bot, ['forward', 'jump'], 350);
      const p = bot.entity.position;
      if (Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y >= c.y - 0.3) {
        await holdControls(bot, ['forward'], 150);   // 再往里走一点，别站在边上又滑回梯子
        log.push(`迈到了 (${c.x},${c.y},${c.z})`);
        return { ok: true, at: { x: c.x, y: c.y, z: c.z }, log };
      }
    }
  }
  throw new Error(`爬到顶了，但迈不出去（试了 ${cands.length} 个方向）`);
}

async function climbUp (bot, state, { targetY, maxLadders = 4 } = {}) {
  const startY = bot.entity.position.y;
  const goal = targetY != null ? +targetY : null;
  const done = []; const used = new Set();
  for (let n = 0; n < maxLadders; n++) {
    const feet = bot.entity.position;
    if (goal != null && feet.y >= goal - 0.5) break;
    // 能从这层走过去的、往上的梯子：底部在脚下附近，顶部比现在高
    const cols = ladderColumns(bot, 16)
      .filter(c => !used.has(`${c.x},${c.z},${c.bottom}`) && c.top >= feet.y && Math.abs(c.bottom - Math.floor(feet.y)) <= 1.5)
      .sort((a, b) => Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z) - Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z));
    if (!cols.length) {
      if (!done.length) throw new Error('附近 16 格内没有从这层往上的梯子');
      break;
    }
    // 最近的那架走不进去（比如厨房里那架）：换下一架试，别直接放弃
    let r = null; let col = null; const errs = [];
    for (const c of cols.slice(0, 4)) {
      used.add(`${c.x},${c.z},${c.bottom}`);
      try { r = await climbColumn(bot, state, c); col = c; break; } catch (e) { errs.push(`(${c.x},${c.z})：${e.message}`); }
    }
    if (!r) { if (!done.length) throw new Error(`附近的梯子都上不去：${errs.join('；')}`); break; }
    done.push({ ladder: `(${col.x},${col.bottom}~${col.top},${col.z})`, landed: r.at, steps: r.log });
    if (goal == null) break;   // 没给目标高度：爬一段就停
  }
  const endY = bot.entity.position.y;
  return { fromY: +startY.toFixed(1), toY: +endY.toFixed(1), ladders: done, reachedTarget: goal == null ? null : endY >= goal - 0.5 };
}

// ------------------------------------------------------------------ 下楼（梯子）

/**
 * 从楼上顺着梯子下去：走到梯子口（地板上那个洞 / 活板门）→ 门关着就推开 →
 * 走进洞口正上方 → 松开所有键，顺着梯子滑下去 → 到底。还没到想去的高度就找下一段。
 * 她自己推开的活板门，走开后"随手关门"的习惯会关回去。
 */
async function climbColumnDown (bot, state, col) {
  const log = [];
  const holeY = col.top + 1;              // 梯子顶上一格：地板上的洞口 / 活板门
  const hatch = bot.blockAt(new Vec3(col.x, holeY, col.z));
  if (hatch && isDoorLike(hatch) && !isOpen(hatch)) {
    await approach(bot, hatch);
    await bot.lookAt(hatch.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(hatch);       // 走 activateBlock → 习惯会记住"这是她开的"
    await sleep(300);
    if (!isOpen(bot.blockAt(hatch.position))) throw new Error(`梯子口的活板门推不开 (${col.x},${holeY},${col.z})`);
    log.push('推开了梯子口的活板门');
  }
  // 先站到洞口旁边
  const { goals } = require('mineflayer-pathfinder');
  const feet = bot.entity.position;
  if (Math.hypot(feet.x - (col.x + 0.5), feet.z - (col.z + 0.5)) > 1.6) {
    try {
      await Promise.race([bot.pathfinder.goto(new goals.GoalNear(col.x, holeY + 1, col.z, 1)), sleep(20000).then(() => { throw new Error('超时'); })]);
    } catch (_) { bot.pathfinder.setGoal(null); }
  }
  // 梯子是贴在墙上的一片薄板（facing = 背对墙的方向）。站在洞口正中会踩在薄板上缘掉不下去（实测停在 y=73.0），
  // 人会自然地站到离墙远的那一侧 —— 往 facing 方向偏 0.3 格
  const FACE = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
  const topLadder = bot.blockAt(new Vec3(col.x, col.top, col.z));
  const [fx, fz] = FACE[String(topLadder?.getProperties?.().facing || '').toLowerCase()] || [0, 0];
  const aim = (y) => new Vec3(col.x + 0.5 + fx * 0.3, y, col.z + 0.5 + fz * 0.3);
  // 走进洞口上方，然后松手往下滑
  const startY = bot.entity.position.y;
  for (let i = 0; i < 10; i++) {
    const p = bot.entity.position;
    if (Math.floor(p.x) === col.x && Math.floor(p.z) === col.z && (fx === 0 || Math.sign(p.x - col.x - 0.5) === fx) && (fz === 0 || Math.sign(p.z - col.z - 0.5) === fz)) break;
    if (p.y < startY - 0.8) break;        // 已经掉进去了
    await bot.lookAt(aim(p.y + 1.2), true);
    await holdControls(bot, ['forward'], 150);
  }
  const p0 = bot.entity.position;
  if (!(Math.floor(p0.x) === col.x && Math.floor(p0.z) === col.z) && p0.y > startY - 0.8) throw new Error(`走不到梯子口上方 (${col.x},${holeY},${col.z})`);
  log.push(`到了梯子口 (${col.x},${holeY},${col.z})`);
  const deadline = Date.now() + 3000 + (col.top - col.bottom + 2) * 1200;
  let still = 0; let lastY = bot.entity.position.y; let nudges = 0;
  while (Date.now() < deadline) {
    await sleep(300);
    const y = bot.entity.position.y;
    if (y <= col.bottom + 0.1) break;
    if (Math.abs(y - lastY) < 0.02) {
      still++;
      // 还卡在上面（踩在梯子薄板或开着的活板门边上）：离墙那侧、正中、四个方向轮着试，直到身体掉进梯子格
      if (still >= 2 && nudges < 10 && y > col.top + 0.5) {
        const tries = [[fx * 0.3, fz * 0.3], [0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]];
        const [ox, oz] = tries[nudges % tries.length];
        nudges++; still = 0;
        await bot.lookAt(new Vec3(col.x + 0.5 + ox, y + 1.2, col.z + 0.5 + oz), true);
        await holdControls(bot, ['forward'], 110);
      } else if (still >= 4) break;
    } else still = 0;
    lastY = y;
  }
  const endY = bot.entity.position.y;
  if (endY > col.bottom + 1.2) throw new Error(`滑到 y=${endY.toFixed(1)} 就停住了（梯子底是 ${col.bottom}）`);
  log.push(`滑到了 y=${endY.toFixed(1)}`);
  // 到底了往旁边迈一步离开梯子格，免得挡路
  return { ok: true, at: { x: Math.floor(bot.entity.position.x), y: Math.round(endY), z: Math.floor(bot.entity.position.z) }, log };
}

async function climbDown (bot, state, { targetY, maxLadders = 4 } = {}) {
  const startY = bot.entity.position.y;
  const pre = await offLadder(bot, state, targetY ?? startY - 5).catch(() => null);
  const goal = targetY != null ? +targetY : null;
  const done = []; const used = new Set();
  for (let n = 0; n < maxLadders; n++) {
    const feet = bot.entity.position;
    if (goal != null && feet.y <= goal + 0.5) break;
    // 从这层能下去的梯子：梯子顶上一格（洞口）就在脚下这层地板里
    const cols = ladderColumns(bot, 16)
      .filter(c => !used.has(`${c.x},${c.z},${c.top}`) && Math.abs((c.top + 2) - Math.floor(feet.y + 0.01)) <= 1 && c.bottom < feet.y - 1)
      .sort((a, b) => Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z) - Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z));
    if (!cols.length) {
      if (!done.length && !pre) throw new Error('附近 16 格内没有从这层往下的梯子');
      break;
    }
    const col = cols[0];
    used.add(`${col.x},${col.z},${col.top}`);
    const r = await climbColumnDown(bot, state, col);
    done.push({ ladder: `(${col.x},${col.bottom}~${col.top},${col.z})`, landed: r.at, steps: r.log });
    if (goal == null) break;
  }
  const endY = bot.entity.position.y;
  return { fromY: +startY.toFixed(1), toY: +endY.toFixed(1), ladders: done, reachedTarget: goal == null ? null : endY <= goal + 0.5, ...(pre ? { firstly: pre } : {}) };
}

// ------------------------------------------------------------------ 走过去（聪明一点的寻路）

/**
 * 以前的 /move 要求"脚正好站进目标那一格"：目标是箱子（实心）、站不进去的格子 → 必定 No path；
 * 寻路器又不开门、不爬梯子，碰到就放弃。实测她找箱子连着 5 次 "No path found"。
 *
 * 这里按真人的办法一样样试：
 *   ① 目标在楼上/楼下（差 3 格以上）→ 先爬梯子
 *   ② 走到目标**旁边**（range 格以内），不是非要站在上面
 *   ③ 路被关着的门挡住 → 开往目标那边的门再走（走过去后"随手关门"的习惯会关回去）
 *   ④ 放宽"旁边"的范围，尽量靠近；再不行先朝目标走一段，换个位置重新找路
 *   ⑤ 到不了：如实报还差多远、试过什么，附上周围地形，让她自己想办法（motor）
 */
async function pathTo (bot, pos, range, ms, { retry = true } = {}) {
  const { goals } = require('mineflayer-pathfinder');
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)),
      sleep(ms).then(() => { throw new Error('走太久了'); }),
    ]);
    return null;
  } catch (e) {
    bot.pathfinder.setGoal(null);
    // 走不通：先跳一跳晃一晃，换个站位再试一次（很多"找不到路"只是被卡在方块边上）
    if (retry) {
      const w = await wiggle(bot, { rounds: 1 }).catch(() => null);
      if (w?.freed) return pathTo(bot, pos, range, ms, { retry: false });
    }
    return e.message || String(e);
  }
}

/**
 * 挂在梯子中间（实测停在 y=71，二楼和三楼之间）：寻路器、下楼、上楼都要求站在地板上，于是全部失败 → 看起来就是"莫名卡住"。
 * 目标在下面：松手滑下去；在上面：从这里接着爬到顶、迈出去。
 */
async function offLadder (bot, state, targetY) {
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  if (!here || !/ladder|vine|scaffolding/.test(here.name)) return null;
  const col = ladderColumns(bot, 3).find(c => c.x === feet.x && c.z === feet.z && feet.y >= c.bottom - 1 && feet.y <= c.top + 1);
  if (!col) return null;
  if (targetY != null && targetY < bot.entity.position.y - 1) {
    const deadline = Date.now() + 2000 + (feet.y - col.bottom + 1) * 800;
    let last = bot.entity.position.y; let still = 0;
    bot.clearControlStates();
    while (Date.now() < deadline && bot.entity.position.y > col.bottom + 0.1) {
      await sleep(250);
      if (Math.abs(bot.entity.position.y - last) < 0.02) { if (++still >= 4) break; } else still = 0;
      last = bot.entity.position.y;
    }
    return `从梯子上滑下来了（y=${bot.entity.position.y.toFixed(1)}）`;
  }
  const r = await climbColumn(bot, state, col);
  return `从梯子上爬上去、迈到了 (${r.at.x},${r.at.y},${r.at.z})`;
}

// ------------------------------------------------------------------ 晃一晃脱困

/**
 * 卡住的时候像真人一样：跳一跳，前后左右晃一晃 —— 很多时候就出来了，不用马上换办法或放弃。
 * 往哪个方向晃之前先看一眼：那边是岩浆、或者脚下是 3 格以上的空（会摔），就不往那边晃。
 */
function safeToward (bot, yaw) {
  const p = bot.entity.position;
  const dx = -Math.sin(yaw); const dz = -Math.cos(yaw);
  const nx = Math.floor(p.x + dx * 0.9); const nz = Math.floor(p.z + dz * 0.9); const y = Math.floor(p.y);
  for (let k = 0; k <= 1; k++) { const b = bot.blockAt(new Vec3(nx, y + k, nz)); if (b && /lava|fire/.test(b.name)) return false; }
  let drop = 0;
  for (let k = 1; k <= 4; k++) { const b = bot.blockAt(new Vec3(nx, y - k, nz)); if (!b || b.boundingBox === 'empty' || /water/.test(b.name)) drop++; else break; if (/lava/.test(b?.name)) return false; }
  return drop < 3;
}

async function wiggle (bot, { rounds = 2 } = {}) {
  const start = bot.entity.position.clone();
  const moved = () => bot.entity.position.distanceTo(start) > 0.6;
  const yaw0 = bot.entity.yaw;
  const dirs = [['forward', 0], ['back', Math.PI], ['left', Math.PI / 2], ['right', -Math.PI / 2]];
  const tried = [];
  try {
    for (let r = 0; r < rounds && !moved(); r++) {
      await holdControls(bot, ['jump'], 250);                      // 先原地跳一下
      if (moved()) break;
      for (const [key, off] of dirs) {
        if (!safeToward(bot, yaw0 + off)) { tried.push(`${key}(危险，跳过)`); continue; }
        await holdControls(bot, [key, 'jump'], 300);
        tried.push(key);
        if (moved()) break;
      }
      if (!moved()) { await bot.look(yaw0 + Math.PI / 4 * (r + 1), 0, true); }   // 转个角度再来一轮
    }
  } finally { bot.clearControlStates(); }
  return { freed: moved(), moved: +bot.entity.position.distanceTo(start).toFixed(2), tried };
}

// ------------------------------------------------------------------ 路线规划：梯子、门本来就是路

/**
 * 以前的走法是"先直接走，走不通再试梯子、再试开门"—— 都是撞了墙之后的补救，所以她老在撞墙。
 * 人脑子里有张图：门和梯子本来就是路的一部分。这里出发前先规划整条路线：
 *   节点 = 起点、终点、每架梯子的上下两头、每扇门
 *   边   = 同一层的点之间走路；梯子连上下两层；门连两边（关着的走到门口要先开）
 * 按路线一段段走：走路交给寻路器，梯子用爬/滑，门先开再过（过去后随手关门的习惯会关回去）。
 * 某一段真走不通：把这段标成不通，从现在的位置重新规划，而不是在原地撞。
 */
function buildGraph (bot, from, to, bad) {
  const nodes = [{ id: 'S', pos: from, kind: 'point' }, { id: 'G', pos: to, kind: 'point' }];
  for (const c of ladderColumns(bot, 32)) {
    if (c.top - c.bottom < 1) continue;
    const low = { id: `L${c.x},${c.z},${c.bottom}:low`, pos: new Vec3(c.x, c.bottom, c.z), kind: 'ladderLow', col: c };
    const high = { id: `L${c.x},${c.z},${c.bottom}:high`, pos: new Vec3(c.x, c.top + 2, c.z), kind: 'ladderHigh', col: c };
    nodes.push(low, high);
  }
  for (const d of doorsNear(bot, 24)) {
    if (/iron/.test(d.name) || /trapdoor|hatch/.test(d.name)) continue;   // 铁门要红石；活板门归梯子管
    nodes.push({ id: `D${d.key}`, pos: new Vec3(d.x, d.y, d.z), kind: 'door', door: d });
  }
  const edges = new Map(nodes.map(n => [n.id, []]));
  const add = (a, b, cost, kind) => { if (!bad.has(`${a.id}>${b.id}`)) edges.get(a.id).push({ to: b, cost, kind }); };
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      if (a.kind === 'ladderLow' && b.kind === 'ladderHigh' && a.col === b.col) { add(a, b, (a.col.top - a.col.bottom + 2) * 1.5 + 3, 'up'); continue; }
      if (a.kind === 'ladderHigh' && b.kind === 'ladderLow' && a.col === b.col) { add(a, b, (a.col.top - a.col.bottom + 2) * 1.2 + 3, 'down'); continue; }
      // 同一层（脚的高度差 ≤ 1.5）才能走过去
      if (Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
      if (d > 40) continue;
      add(a, b, d + (b.kind === 'door' && !b.door.open ? 2 : 0), 'walk');
    }
  }
  return { nodes, edges };
}

function shortest (graph) {
  const dist = new Map([['S', 0]]); const prev = new Map(); const done = new Set();
  for (;;) {
    let u = null; let best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id; }
    if (u == null) return null;
    if (u === 'G') break;
    done.add(u);
    for (const e of graph.edges.get(u) || []) {
      const nd = best + e.cost;
      if (nd < (dist.get(e.to.id) ?? Infinity)) { dist.set(e.to.id, nd); prev.set(e.to.id, { from: u, e }); }
    }
  }
  const path = []; let cur = 'G';
  while (cur !== 'S') { const p = prev.get(cur); path.unshift({ from: p.from, ...p.e }); cur = p.from; }
  return path;
}

function describeRoute (path) {
  return path.map(e => e.kind === 'up' ? `爬梯子上到 y=${e.to.pos.y}` : e.kind === 'down' ? `顺梯子下到 y=${e.to.pos.y}`
    : e.to.kind === 'door' ? `走到${e.to.door.kind}(${e.to.door.key})` : e.to.kind === 'ladderLow' ? `走到梯子下面(${e.to.pos.x},${e.to.pos.z})`
      : e.to.kind === 'ladderHigh' ? `走到梯子口(${e.to.pos.x},${e.to.pos.z})` : '走到目的地').join(' → ');
}

async function followRoute (bot, state, target, range, tried, t0, maxMs) {
  const bad = new Set();
  for (let plan = 0; plan < 5 && Date.now() - t0 < maxMs; plan++) {
    const from = bot.entity.position.floored();
    const g = buildGraph(bot, from, target(), bad);
    const path = shortest(g);
    if (!path) { tried.push('规划不出路线（附近的梯子和门连不到那里）'); return false; }
    tried.push(`路线：${describeRoute(path)}`);
    let failed = null;
    for (let i = 0; i < path.length; i++) {
      const e = path[i];
      const next = path[i + 1];
      try {
        if (e.kind === 'up') await climbColumn(bot, state, e.to.col);
        else if (e.kind === 'down') await climbColumnDown(bot, state, e.to.col);
        else if (e.to.kind === 'ladderLow' && next?.kind === 'up') continue;       // 爬梯子会自己走进梯子格
        else if (e.to.kind === 'ladderHigh' && next?.kind === 'down') continue;    // 下梯子会自己走到梯子口
        else if (e.to.kind === 'door') {
          if (!e.to.door.open) await setDoor(bot, state, { x: e.to.door.x, y: e.to.door.y, z: e.to.door.z, open: true });
          const err = await pathTo(bot, e.to.pos, 0.8, 20000);
          if (err) throw new Error(err);
        } else {
          const goal = e.to.id === 'G' ? target() : e.to.pos;
          const err = await pathTo(bot, goal, e.to.id === 'G' ? range : 1.2, Math.min(45000, 8000 + bot.entity.position.distanceTo(goal) * 1200));
          if (err && bot.entity.position.distanceTo(goal) > (e.to.id === 'G' ? range + 0.8 : 2)) throw new Error(err);
        }
      } catch (err) { failed = { e, err: err.message }; break; }
    }
    if (!failed) return true;
    bad.add(`${failed.e.from}>${failed.e.to.id}`);
    tried.push(`这段不通（${failed.err.slice(0, 60)}），换条路`);
  }
  return false;
}

async function go (bot, state, { x, y, z, player, range = 1.8, maxMs = 90000 } = {}) {
  const t0 = Date.now();
  const tried = [];
  const target = () => {
    if (player) {
      const e = bot.players[player]?.entity;
      if (!e) throw new Error(`看不见 ${player}（不在视野内或不在线）`);
      return e.position.floored();
    }
    if (x == null || z == null) throw new Error('要给 x z（y 可选）或 player');
    return new Vec3(+x, y != null ? +y : Math.floor(bot.entity.position.y), +z);
  };
  const dist = () => bot.entity.position.distanceTo(target().offset(0.5, 0, 0.5));
  const near = () => dist() <= range + 0.8;
  const eta = () => Math.min(45000, 8000 + dist() * 1200);
  const startDist = dist();
  if (near()) return { arrived: true, already: true, distance: +startDist.toFixed(1) };
  try { const o = await offLadder(bot, state, target().y); if (o) tried.push(o); } catch (e) { tried.push(`挂在梯子上，想下来没成：${e.message}`); }

  // 同一层：先直接走（最常见、最快）；跨层或者直接走不通：规划一条带梯子和门的路线
  const sameFloor = Math.abs(target().y - Math.floor(bot.entity.position.y + 0.01)) < 2;
  if (sameFloor) {
    const err0 = await pathTo(bot, target(), range, eta());
    if (!err0 || near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
    tried.push(`直接走：${err0}`);
  }
  if (await followRoute(bot, state, target, range, tried, t0, maxMs) && near()) {
    return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ① 楼上楼下
  const dy = target().y - Math.floor(bot.entity.position.y + 0.01);
  if (Math.abs(dy) >= 3) {
    try {
      const r = dy > 0 ? await climbUp(bot, state, { targetY: target().y }) : await climbDown(bot, state, { targetY: target().y });
      tried.push(`${dy > 0 ? '上楼' : '下楼'}：${r.fromY}→${r.toY}`);
    } catch (e) { tried.push(`${dy > 0 ? '上楼' : '下楼'}没成：${e.message}`); }
  }

  // ② 走到旁边
  let err = await pathTo(bot, target(), range, eta());
  if (!err || near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  tried.push(`寻路：${err}`);

  // ③ 开挡路的门（往目标那边的、关着的）
  for (let n = 0; n < 3 && Date.now() - t0 < maxMs; n++) {
    const me = bot.entity.position; const tg = target();
    const doors = doorsNear(bot, 10).filter(d => !d.open && !/iron/.test(d.name))
      .map(d => ({ ...d, toTarget: Math.hypot(d.x + 0.5 - tg.x, d.z + 0.5 - tg.z) }))
      .filter(d => d.toTarget < Math.hypot(me.x - tg.x, me.z - tg.z) + 2)
      .sort((a, b) => (a.distance + a.toTarget) - (b.distance + b.toTarget));
    if (!doors.length) break;
    const d = doors[0];
    try {
      await setDoor(bot, state, { x: d.x, y: d.y, z: d.z, open: true });
      tried.push(`开了挡路的${d.kind}(${d.x},${d.y},${d.z})`);
    } catch (e) { tried.push(`想开${d.kind}(${d.x},${d.y},${d.z})没开成：${e.message}`); break; }
    err = await pathTo(bot, target(), range, eta());
    if (!err || near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ④ 放宽范围 / 先走一段
  for (const r2 of [3, 5]) {
    if (Date.now() - t0 > maxMs) break;
    err = await pathTo(bot, target(), r2, eta());
    if (!err) { tried.push(`放宽到 ${r2} 格：走到了`); break; }
    tried.push(`放宽到 ${r2} 格：${err}`);
  }
  if (!near() && dist() > 6 && Date.now() - t0 < maxMs) {
    const me = bot.entity.position; const tg = target();
    const k = Math.min(1, 8 / dist());
    const mid = new Vec3(Math.floor(me.x + (tg.x - me.x) * k), Math.floor(me.y), Math.floor(me.z + (tg.z - me.z) * k));
    const e2 = await pathTo(bot, mid, 3, 20000);
    tried.push(e2 ? `先往目标走一段：${e2}` : `先往目标走了一段到 (${mid.x},${mid.z})`);
    if (!e2) {
      err = await pathTo(bot, target(), range, eta());
      if (!err || near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
    }
  }

  const left = dist();
  if (left <= Math.max(range, 5)) return { arrived: false, close: true, distance: +left.toFixed(1), from: +startDist.toFixed(1), tried, note: '到附近了，没到正旁边' };
  const e = new Error(`走不到（还差 ${left.toFixed(1)} 格，出发时 ${startDist.toFixed(1)} 格）。试过：${tried.join('；')}`);
  e.data = { distance: +left.toFixed(1), tried, around: lookAround(bot, { r: 3, below: 1, above: 2 }).map };
  throw e;
}

// ------------------------------------------------------------------ 看清地形 + 自己编动作（通用）

/**
 * 梯子这件事我是怎么解决的：一格格量出周围的立体地形 → 看出"两段梯子、中间迈一格"→
 * 用"按住跳 / 朝某处走"这些基本按键加位置反馈，拼出一套动作。
 * 她缺的就是这两样：**看清地形的眼睛**和**能自己拼的基本动作**。给了她，
 * 以后遇到新的地形难题（跳过缺口、钻半格洞、翻栅栏、下梯子…）她能自己看、自己试、做成了存成技能。
 */
function cellChar (b) {
  if (!b) return '?';
  const n = b.name;
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.';
  if (/lava/.test(n)) return '!';
  if (/water|bubble_column/.test(n)) return '~';
  if (/ladder|vine|scaffolding/.test(n)) return 'H';
  if (isDoorLike(b)) {
    const open = isOpen(b);
    if (/trapdoor|hatch/.test(n)) return open ? 't' : 'T';
    if (/gate/.test(n)) return open ? 'g' : 'G';
    return open ? 'd' : 'D';
  }
  if (/fence|wall(?!_)|_wall$|bars|pane/.test(n)) return '|';
  if (/slab/.test(n)) return '_';
  if (/stairs/.test(n)) return '/';
  if (/leaves/.test(n)) return '*';
  if (b.boundingBox === 'empty') return ',';
  return '#';
}

function lookAround (bot, { r = 3, below = 2, above = 3 } = {}) {
  r = Math.min(Math.max(1, +r || 3), 6);
  const p = bot.entity.position;
  const fx = Math.floor(p.x); const fy = Math.floor(p.y + 0.01); const fz = Math.floor(p.z);
  const layers = [];
  for (let y = fy + Math.min(above, 5); y >= fy - Math.min(below, 5); y--) {
    const rows = [];
    for (let z = fz - r; z <= fz + r; z++) {
      let row = '';
      for (let x = fx - r; x <= fx + r; x++) {
        row += (x === fx && z === fz && (y === fy || y === fy + 1)) ? '@' : cellChar(bot.blockAt(new Vec3(x, y, z)));
      }
      rows.push(row);
    }
    layers.push(`y=${y}${y === fy ? '（脚）' : y === fy + 1 ? '（头）' : y === fy - 1 ? '（脚下）' : ''}\n${rows.join('\n')}`);
  }
  return {
    center: { x: fx, y: fy, z: fz },
    legend: '@你 #实心 .空气 H梯子 T关着的活板门 t开着的 D关着的门 d开着的 G关着的栅栏门 g开着的 |栅栏/墙 _台阶 /楼梯 ~水 !岩浆 *树叶 ,能穿过的小东西',
    orientation: `每层是俯视图：从上到下是 z=${fz - r}..${fz + r}（北→南），从左到右是 x=${fx - r}..${fx + r}（西→东）`,
    map: layers.join('\n\n'),
  };
}

/**
 * 动作程式：一串基本动作，身体快速执行并回报每一步的结果。
 *   {look:{x,y,z}}                          看向某点（方块中心就 +0.5）
 *   {hold:['forward','jump',…], ms, until}  按住这些键，直到条件成立或 ms 到（≤5000）
 *        until: {yAtLeast} / {yAtMost} / {inCell:{x,z}} / {stopped:true}（不再移动）
 *   {activate:{x,y,z}}                      右键某个方块
 *   {wait: ms}
 * 键：forward back left right jump sneak sprint
 */
const KEYS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);

/**
 * 微调身位：挪到一格里的精确位置（x、z 可以带小数）。
 * 蹲着小步挪 —— 蹲着不会从边上掉下去，步子也小；每挪一下都核对位置，直到误差 ≤ tol。
 * 下梯子就是靠这个成的（站到离墙那侧，身体才落得进梯子格）。
 */
async function nudge (bot, { x, z, tol = 0.12, maxSteps = 25 } = {}) {
  if (x == null || z == null) throw new Error('要给 x z（可以带小数）');
  const target = { x: +x, z: +z };
  const d = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
  const from = d();
  if (from > 3) throw new Error(`离目标 ${from.toFixed(1)} 格，太远了 —— 微调只管最后一两格，先走过去`);
  let steps = 0;
  try {
    while (d() > tol && steps < maxSteps) {
      steps++;
      const p = bot.entity.position;
      await bot.lookAt(new Vec3(target.x, p.y + 1.62, target.z), true);
      bot.setControlState('sneak', true);
      bot.setControlState('forward', true);
      await sleep(Math.min(250, Math.max(60, d() * 400)));
      bot.setControlState('forward', false);
      await sleep(120);
    }
  } finally { bot.clearControlStates(); }
  const p = bot.entity.position;
  return { reached: d() <= tol, error: +d().toFixed(2), from: +from.toFixed(2), steps, at: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } };
}

async function motor (bot, state, { steps = [], maxMs = 20000 } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 要有动作');
  if (steps.length > 30) throw new Error('一次最多 30 个动作');
  const t0 = Date.now();
  const pos = () => { const p = bot.entity.position; return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }; };
  const trace = [];
  const cond = (u) => {
    if (!u) return false;
    const p = bot.entity.position;
    if (u.yAtLeast != null && p.y >= +u.yAtLeast) return true;
    if (u.yAtMost != null && p.y <= +u.yAtMost) return true;
    if (u.inCell && Math.floor(p.x) === +u.inCell.x && Math.floor(p.z) === +u.inCell.z) return true;
    return false;
  };
  try {
    for (let i = 0; i < steps.length; i++) {
      if (Date.now() - t0 > Math.min(maxMs, 30000)) { trace.push({ i, stop: '总时间到了' }); break; }
      const st = steps[i]; const before = pos(); let note = '';
      if (st.look) {
        await bot.lookAt(new Vec3(+st.look.x, +st.look.y, +st.look.z), true);
      } else if (st.hold) {
        const keys = [].concat(st.hold).filter(k => KEYS.has(k));
        const ms = Math.min(Math.max(+st.ms || 500, 50), 5000);
        for (const k of keys) bot.setControlState(k, true);
        const end = Date.now() + ms; let last = bot.entity.position.clone(); let still = 0;
        while (Date.now() < end) {
          await sleep(50);
          if (cond(st.until)) { note = '条件达成'; break; }
          if (st.until?.stopped) {
            if (bot.entity.position.distanceTo(last) < 0.01) { if (++still >= 4) { note = '停住了'; break; } } else still = 0;
            last = bot.entity.position.clone();
          }
        }
        bot.clearControlStates();
        await sleep(60);
        if (!note) note = st.until ? '时间到，条件没达成' : '时间到';
        if (bot.entity.isCollidedHorizontally) note += '，撞到东西了';
      } else if (st.activate) {
        const b = bot.blockAt(new Vec3(+st.activate.x, +st.activate.y, +st.activate.z));
        if (!b) note = '那里没加载';
        else { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); await sleep(250); note = `右键了 ${b.name}${isDoorLike(b) ? `（现在${isOpen(bot.blockAt(b.position)) ? '开' : '关'}着）` : ''}`; }
      } else if (st.nudge) {
        const r = await nudge(bot, st.nudge);
        note = r.reached ? `挪到了（误差 ${r.error}）` : `没挪准（还差 ${r.error}）`;
      } else if (st.wait) {
        await sleep(Math.min(+st.wait, 3000));
      } else { note = '看不懂这一步'; }
      trace.push({ i, step: st, from: before, to: pos(), note });
    }
  } finally {
    bot.clearControlStates();
  }
  return { steps: trace.length, end: pos(), onGround: bot.entity.onGround, trace };
}

// ------------------------------------------------------------------ 通用容器

function plainTitle (t) {
  if (!t) return '';
  try {
    const j = typeof t === 'string' ? JSON.parse(t) : t;
    if (j.translate) return j.translate;
    return [j.text, ...(j.extra || []).map(e => e.text || '')].join('') || JSON.stringify(j).slice(0, 60);
  } catch (_) { return String(t).slice(0, 60); }
}

function summarizeWindow (bot, state) {
  const w = bot.currentWindow;
  if (!w) return null;
  const containerSlots = w.inventoryStart;
  const slots = [];
  for (let i = 0; i < containerSlots; i++) {
    const it = w.slots[i];
    if (it) slots.push({ slot: i, item: fullId(it.name), count: it.count });
  }
  return {
    id: w.id,
    type: w.__menu || state.lastWindowInfo?.menu || w.type,
    title: plainTitle(w.title),
    generic: !!w.__generic,
    containerSlots,
    filled: slots,
    empty: [...Array(containerSlots).keys()].filter(i => !w.slots[i]).slice(0, 30),
    hint: `格子 0..${containerSlots - 1} 是这个界面的，${containerSlots}..${w.inventoryEnd - 1} 是她自己的背包`,
  };
}

/** 看到一个箱子里有什么：记一笔（给意识流取走，写进她对家的记忆） */
function noteSeen (bot, state, w, pos, name) {
  if (!w || !pos) return;
  const items = {};
  for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
  const b = bot.blockAt(pos);
  const key = b ? storageKey(bot, b) : doorKey(pos);
  state.seenContainers ||= new Map();
  state.seenContainers.set(key, { key, name: name || b?.name, items, slots: w.inventoryStart, used: Object.keys(items).length ? w.slots.slice(0, w.inventoryStart).filter(Boolean).length : 0, at: Date.now() });
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
    function on (w) { clearTimeout(t); resolve(w); }
    bot.once('windowOpen', on);
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
  const n = Math.min(count || item.count, src.reduce((a, i) => a + w.slots[i].count, 0));
  await bot.transfer({ window: w, itemType: item.type, metadata: null, count: n, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: slot, destEnd: slot + 1 });
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
    await bot.transfer({ window: w, itemType: it.type, metadata: null, count, sourceStart: slot, sourceEnd: slot + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
  }
  await sleep(700);   // 服务器同步背包要一会儿，太早核对会看成"什么都没拿到"
  return { took: fullId(it.name), gained: delta(before, invCounts(bot)).gained, slotNow: w.slots[slot] ? w.slots[slot].count : 0 };
}

// ------------------------------------------------------------------ 批量存取 / 整理（快）

/**
 * 她整理箱子是一格一格搬、每搬一格都要"想"一次（5–10 秒）—— 放 3 样东西要想 3 轮。
 * 真人是打开箱子、按住 Shift 一路点。这里就是那只手：她说一句"吃的都放进去"，
 * 身体一次性连续点完，中间不再经过大脑。
 */
const CAT_ORDER = ['食物', '作物种子', '矿物', '木头', '方块', '工具装备', '其他'];

function categoryOf (bot, item) {
  const id = fullId(item.name);
  const tags = K().load().itemTags.get(id) || new Set();
  const has = (re) => [...tags].some(t => re.test(t));
  // 《食录逸闻》清单里也有工作台这种"要交的东西"—— 能放下的方块不算吃的（蛋糕这类可放置的食物靠 foodScore/标签认）
  const isBlock = !!(bot.registry.blocksByName[item.name] || bot.registry.blocksByName[String(item.name).split(':').pop()]);
  let inCatalog = false;
  try { inCatalog = require('./ambition').isFood(id); } catch (_) {}
  // 矿物/宝石先认：《食录逸闻》清单里也有要交绿宝石的任务，不能因为在清单里就当成吃的
  if (has(/^(forge|c):(ores|ingots|gems|raw_materials|nuggets|dusts)/)) return '矿物';
  if ((inCatalog && !isBlock) || has(/^(forge|c):foods|meals|feasts|drinks$/) || foodScore(item) >= 3) return '食物';
  if (has(/^(forge|c):(seeds|crops)|saplings$/) || /seed|sapling/.test(item.name)) return '作物种子';
  if (has(/^(forge|c):(ores|ingots|gems|raw_materials|nuggets|dusts|storage_blocks)/) || /ingot|_ore$|raw_|nugget|gem$|diamond$|emerald$|coal$|redstone$|lapis/.test(item.name)) return '矿物';
  if (has(/^minecraft:(logs|planks)$/) || /_log$|_planks$|_wood$|stick$/.test(item.name)) return '木头';
  if (/pickaxe|_axe$|shovel|hoe$|sword|bow$|crossbow|helmet|chestplate|leggings|boots|shield|fishing_rod|shears|flint_and_steel|knife/.test(item.name) || has(/tools|weapons|armors/)) return '工具装备';
  if (bot.registry.blocksByName[item.name] || bot.registry.blocksByName[String(item.name).split(':').pop()]) return '方块';
  return '其他';
}

/** "吃的" "食物" "#forge:ingots" "oak_log" "橡木原木" —— 都能当条件 */
function matcher (bot, spec) {
  const sp = String(spec).trim();
  const cat = CAT_ORDER.find(c => sp.includes(c) || c.includes(sp) || (sp === '吃的' && c === '食物') || (/种子|作物|庄稼/.test(sp) && c === '作物种子') || (/矿|锭|宝石/.test(sp) && c === '矿物') || (/工具|武器|装备|盔甲|护甲/.test(sp) && c === '工具装备') || (/木/.test(sp) && c === '木头'));
  if (cat) return (it) => categoryOf(bot, it) === cat;
  if (sp.startsWith('#')) { const set = K().load().tags.get(`item:${sp.slice(1)}`) || new Set(); return (it) => set.has(fullId(it.name)); }
  const id = sp.includes(':') || /^[a-z0-9_]+$/.test(sp) ? fullId(sp) : K().resolve(sp, 1)[0];
  return (it) => fullId(it.name) === id;
}

const anyOf = (bot, specs) => { const ms = [].concat(specs || []).map(x => matcher(bot, x)); return (it) => ms.some(m => m(it)); };

async function click (bot, slot, button = 0, mode = 0) {
  await bot.clickWindow(slot, button, mode);
  await sleep(40);
}

function tally (list) {
  const m = {};
  for (const it of list) m[fullId(it.name)] = (m[fullId(it.name)] || 0) + it.count;
  return m;
}

/** 存进当前打开的箱子：items 指定要存的（物品/分类/标签）；all=true 全存，keep 里的留下 */
async function deposit (bot, state, { items, all = false, keep = [] } = {}) {
  const w = bot.currentWindow;
  if (!w) throw new Error('没有打开的箱子（先 open_container）');
  const want = all ? () => true : anyOf(bot, items);
  const keepM = anyOf(bot, keep);
  // 结果按"她自己那几格前后差多少"算，而且等同步回来再算 —— 模组箱子（精妙背包）的格子是自己的封包同步的，
  // 点完立刻看会以为没放进去（实测：其实放进去了，却报"放不进"）
  const mine = () => { const m = {}; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const x = w.slots[i]; if (x) m[fullId(x.name)] = (m[fullId(x.name)] || 0) + x.count; } return m; };
  const before = mine(); const tried = {};
  for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
    const it = w.slots[i];
    if (!it || !want(it) || (keep.length && keepM(it))) continue;
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
  return { stored, notStored: Object.keys(notStored).length ? { reason: '箱子满了或放不进', items: notStored } : null, stacks: Object.keys(stored).length };
}

/** 从当前箱子拿：items=[名字/分类] 或 [{item, count}]；all=true 全拿 */
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
        await bot.transfer({ window: w, itemType: it.type, metadata: null, count: need, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
        got.push({ name: it.name, count: need }); need = 0;
      }
      if (bot.inventory.emptySlotCount() === 0) break;
    }
  }
  await sleep(300);
  return { took: tally(got), backpackFull: bot.inventory.emptySlotCount() === 0 };
}

/**
 * 整理一段格子：先把同种的零散堆并起来，再按类别排好（食物 → 作物种子 → 矿物 → 木头 → 方块 → 工具装备 → 其他）。
 * 全靠点击交换，不用把东西拿出来。
 */
async function sortRange (bot, w, start, end) {
  const key = (it) => `${String(CAT_ORDER.indexOf(categoryOf(bot, it))).padStart(2, '0')}|${fullId(it.name)}`;
  let clicks = 0;
  // ① 合并：后面的零散堆往前面的同种堆上叠
  for (let i = start; i < end; i++) {
    const a = w.slots[i];
    if (!a || a.count >= a.stackSize) continue;
    for (let j = i + 1; j < end && w.slots[i] && w.slots[i].count < w.slots[i].stackSize; j++) {
      const b = w.slots[j];
      if (!b || b.type !== a.type || JSON.stringify(b.nbt || null) !== JSON.stringify(a.nbt || null)) continue;
      await click(bot, j); await click(bot, i); clicks += 2;
      if (w.selectedItem) { await click(bot, j); clicks++; }
    }
  }
  // ② 排序：选择排序，每次把该在第 i 格的东西换过来
  const items = []; for (let i = start; i < end; i++) if (w.slots[i]) items.push(w.slots[i]);
  const order = items.map(it => ({ k: key(it), type: it.type, count: it.count })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : b.count - a.count));
  for (let n = 0; n < order.length; n++) {
    const i = start + n; const want = order[n];
    const cur = w.slots[i];
    if (cur && cur.type === want.type && cur.count === want.count) continue;
    let j = -1;
    for (let k = i + 1; k < end; k++) { const x = w.slots[k]; if (x && x.type === want.type && x.count === want.count) { j = k; break; } }
    if (j < 0) for (let k = i + 1; k < end; k++) { const x = w.slots[k]; if (x && x.type === want.type) { j = k; break; } }
    if (j < 0) continue;
    await click(bot, j); await click(bot, i); clicks += 2;       // 拿起 j，放到 i（i 原来的东西到了手上）
    if (w.selectedItem) { await click(bot, j); clicks++; }       // 手上的放回 j
  }
  if (w.selectedItem) { for (let k = start; k < end; k++) if (!w.slots[k]) { await click(bot, k); break; } }
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
  return { sorted: true, ...r, byCategory: sum };
}

async function sortInventory (bot) {
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(200); }
  const w = bot.inventory;
  const r = await sortRange(bot, w, 9, 36);    // 主背包 27 格；快捷栏（36–44）不动
  await sleep(300);
  return { sorted: true, ...r, note: '快捷栏没动' };
}

// ------------------------------------------------------------------ 整理仓库（周围所有箱子一起分类 + 随身带什么）

/**
 * 不是一个箱子自己排好，而是像真人管仓库：每个箱子管一类（吃的一箱、矿物一箱、建材一箱…），
 * 身上只带该带的（好工具、一组吃的、火把、一组建材），其余都归位。
 * 身体一口气做完，中间不经过大脑。
 */
const STORAGE_RE = /(^|:)(chest|trapped_chest|barrel)$|chest|barrel|cabinet|crate|drawer|cupboard|locker|shelf_storage|storage|fridge|basket|shulker_box/;
const NOT_STORAGE_RE = /ender_chest|hopper|furnace|smoker|pot|kettle|board|table|stove|oven|jar|keg|chest_boat|minecart|display|pedestal/;

function findStorage (bot, radius) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => STORAGE_RE.test(b.name) && !NOT_STORAGE_RE.test(b.name)).map(b => b.id);
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }).map(p => bot.blockAt(p)).filter(Boolean);
}

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const tierOf = (name) => { const i = TIERS.findIndex(t => name.includes(t)); return i < 0 ? 3.5 : i; };

/** 默认随身装备：最好的镐/斧/剑、一组最顶饱的吃的、16 火把、32 建材 */
function defaultLoadout () {
  return [
    { kind: 'best', re: /pickaxe$/, count: 1, label: '最好的镐' },
    { kind: 'best', re: /(^|_)axe$/, count: 1, label: '最好的斧' },
    { kind: 'best', re: /sword$/, count: 1, label: '最好的剑' },
    { kind: 'food', count: 16, label: '吃的' },
    { kind: 'id', id: 'minecraft:torch', count: 16, label: '火把' },
    { kind: 'any', ids: ['minecraft:cobblestone', 'minecraft:dirt', 'minecraft:cobbled_deepslate'], count: 32, label: '建材' },
  ];
}

/** 从一堆物品里挑出装备单要留下的：返回 Map(slotIndex → 要留几个) */
function pickLoadout (bot, entries, loadout) {
  const keep = new Map();
  const add = (e, n) => keep.set(e.slot, (keep.get(e.slot) || 0) + n);
  for (const L of loadout) {
    let pool = entries.filter(e => !keep.has(e.slot));
    if (L.kind === 'best') pool = pool.filter(e => L.re.test(e.item.name)).sort((a, b) => tierOf(a.item.name) - tierOf(b.item.name));
    else if (L.kind === 'food') pool = pool.filter(e => categoryOf(bot, e.item) === '食物' && foodScore(e.item) > 0).sort((a, b) => foodScore(b.item) - foodScore(a.item));
    else if (L.kind === 'id') pool = pool.filter(e => fullId(e.item.name) === L.id);
    else if (L.kind === 'any') pool = pool.filter(e => L.ids.includes(fullId(e.item.name)));
    else if (L.kind === 'spec') pool = pool.filter(e => L.m(e.item));
    let need = L.count;
    for (const e of pool) { if (need <= 0) break; const n = Math.min(need, e.item.count); add(e, n); need -= n; }
  }
  return keep;
}

/** 大箱子是两格拼的：两格统一用坐标小的那一格当名字（不然同一个箱子会被记成两个） */
function storageKey (bot, block) {
  // 游戏自己的规则（ChestBlock#getConnectedDirection）：type=left → 另一半在 facing 顺时针方向，right → 逆时针。
  // 几个大箱子紧挨着排的时候，只看"旁边有同名箱子"会把隔壁那个大箱子的一格也算进来（实测坐标来回跳）
  const p = block.getProperties?.() || {};
  // ⚠️ 这个模组服报的属性值是大写（LEFT/RIGHT/SINGLE）—— 统一转小写再比，不然左半全被当成右半、配到隔壁的大箱子去
  const type = String(p.type || '').toLowerCase(); const facing = String(p.facing || '').toLowerCase();
  if (!/chest/.test(block.name) || !type || type === 'single') return doorKey(block.position);
  const CW = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] };     // 顺时针转 90° 后的方向
  const [dx, dz] = CW[facing] || [0, 0];
  const off = type === 'left' ? [dx, dz] : [-dx, -dz];
  const partner = block.position.offset(off[0], 0, off[1]);
  const pair = [block.position, partner].sort((a, b) => a.x - b.x || a.z - b.z);
  return doorKey(pair[0]);
}

async function organizeStorage (bot, state, { radius = 12, assign = {}, loadout = null, maxPasses = 4, dryRun = false, only = null, allFloors = false, skip = [] } = {}) {
  const t0 = Date.now();
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
    const k = storageKey(bot, b);
    if (covered.has(k) || covered.has(doorKey(b.position))) continue;
    if (skipSet.has(k)) { covered.add(k); boxes.push({ pos: b.position.clone(), key: k, name: b.name, slots: /chest/.test(b.name) && k !== doorKey(b.position) ? 54 : 27, cats: {}, used: 0, items: [], skipped: true }); continue; }
    let info;
    try { info = await containerOpen(bot, state, b.position); } catch (e) { log.push(`打不开 ${b.name}(${k})：${e.message}`); continue; }
    const w = bot.currentWindow;
    const n = w.inventoryStart;
    // 大箱子：把另一半那格也标成看过了（它的 storageKey 和这格一样）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nb = bot.blockAt(b.position.offset(dx, 0, dz)); if (nb && nb.name === b.name && storageKey(bot, nb) === k) covered.add(doorKey(nb.position)); }
    covered.add(k);
    const cats = {}; const items = [];
    for (let i = 0; i < n; i++) if (w.slots[i]) { const c = categoryOf(bot, w.slots[i]); cats[c] = (cats[c] || 0) + 1; items.push(c); }
    boxes.push({ pos: b.position.clone(), key: k, name: b.name, slots: n, cats, items, used: items.length });
    noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
  }
  if (!boxes.length) throw new Error('周围的箱子一个都打不开');

  // ② 分配：每类给"已经放这类最多"的箱子，装不下顺延；主人指定的优先
  const invCats = {};
  for (const it of bot.inventory.items()) { const c = categoryOf(bot, it); invCats[c] = (invCats[c] || 0) + 1; }
  const need = {};
  for (const c of CAT_ORDER) need[c] = boxes.reduce((a, b) => a + (b.cats[c] || 0), 0) + (invCats[c] || 0);
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
  for (const c of CAT_ORDER.filter(c => need[c] > 0 && !owner[c]).sort((a, b) => need[b] - need[a])) {
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
  const misplaced = (box) => cats0(box).filter(c => !(owner[c] || []).includes(box.key) && (owner[c] || []).length).length;
  const invWants = (box) => bot.inventory.items().some(it => home(it).includes(box.key));
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = 0;
    // 只去需要去的：里面有放错的，或者身上有东西该放进去的（空的、没分到类的箱子不去）
    const todo = boxes.filter(b => misplaced(b) > 0 || invWants(b))
      .sort((a, b) => bot.entity.position.distanceTo(a.pos) - bot.entity.position.distanceTo(b.pos));
    if (!todo.length) break;
    for (const box of todo) {
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
        if (keepN > 0) await bot.transfer({ window: w, itemType: e.item.type, metadata: null, count: before - keepN, sourceStart: e.slot, sourceEnd: e.slot + 1, destStart: 0, destEnd: w.inventoryStart });
        else await click(bot, e.slot, 0, 1);
        if ((w.slots[e.slot]?.count || 0) < before) { changed++; moved++; }
      }
      // 拿出不属于这里的（给背包留 2 格余量）
      for (let i = 0; i < w.inventoryStart; i++) {
        const it = w.slots[i];
        if (!it || home(it).includes(box.key) || !home(it).length) continue;
        if (bot.inventory.emptySlotCount() <= 2) break;
        await click(bot, i, 0, 1);
        if (!w.slots[i]) { changed++; moved++; }
      }
      // 更新心里的账：这个箱子现在装着什么
      box.items = []; for (let i = 0; i < w.inventoryStart; i++) if (w.slots[i]) box.items.push(categoryOf(bot, w.slots[i]));
      box.used = box.items.length;
      noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
    }
    log.push(`第 ${pass + 1} 轮去了 ${todo.length} 个箱子，搬了 ${changed} 组`);
    if (!changed) break;
  }

  // ④ 每个箱子里面再排好；⑤ 随身装备缺的从箱子里拿（空箱子不去）
  for (const box of boxes.filter(b => b.used > 0)) {
    try { await containerOpen(bot, state, box.pos); } catch (_) { continue; }
    const w = bot.currentWindow;
    await sortRange(bot, w, 0, w.inventoryStart);
    const have = []; for (let i = w.inventoryStart; i < w.inventoryEnd; i++) if (w.slots[i]) have.push({ slot: i, item: w.slots[i] });
    for (const L of kit) {
      const got = have.filter(e => (L.kind === 'best' ? L.re.test(e.item.name) : L.kind === 'food' ? categoryOf(bot, e.item) === '食物' && foodScore(e.item) > 0 : L.kind === 'id' ? fullId(e.item.name) === L.id : L.kind === 'any' ? L.ids.includes(fullId(e.item.name)) : L.m(e.item))).reduce((a, e) => a + e.item.count, 0);
      if (got >= (L.kind === 'best' ? 1 : L.count)) continue;
      for (let i = 0; i < w.inventoryStart; i++) {
        const it = w.slots[i];
        if (!it) continue;
        const ok = L.kind === 'best' ? L.re.test(it.name) : L.kind === 'food' ? categoryOf(bot, it) === '食物' && foodScore(it) > 0 : L.kind === 'id' ? fullId(it.name) === L.id : L.kind === 'any' ? L.ids.includes(fullId(it.name)) : L.m(it);
        if (!ok) continue;
        const n = Math.min(it.count, (L.kind === 'best' ? 1 : L.count) - got);
        if (n <= 0) break;
        await bot.transfer({ window: w, itemType: it.type, metadata: null, count: n, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
        break;
      }
    }
    noteSeen(bot, state, w, state.openContainerPos); bot.closeWindow(w); await sleep(150);
  }

  const layout = {};
  for (const [c, keys] of Object.entries(owner)) for (const k of keys) (layout[k] ||= []).push(c);
  const carry = {}; for (const it of bot.inventory.items()) carry[fullId(it.name)] = (carry[fullId(it.name)] || 0) + it.count;
  return {
    boxes: boxes.map(b => ({ at: b.key, name: b.name, slots: b.slots, holds: layout[b.key] || [], used: b.used, skipped: !!b.skipped })),
    moved, visits, carrying: carry, notes: log, seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// ------------------------------------------------------------------ 探险：把家以外的箱子打包带走

/**
 * 探险时找到的箱子：尽量都装到身上带回家。背包装不下时先拿值钱的
 * （工具装备 → 矿物 → 食物 → 其他 → 方块 → 木头 → 作物种子），拿不完的箱子记下来。
 * 家里的箱子（home 范围内）不碰；exclude 里的位置不碰（比如知道是别人家的）。
 */
const LOOT_ORDER = ['工具装备', '矿物', '食物', '其他', '方块', '木头', '作物种子'];

async function lootNearby (bot, state, { radius = 10, home = null, exclude = [] } = {}) {
  const inHomeArea = (p) => home && Math.hypot(p.x - home.center.x, p.z - home.center.z) <= home.radius && Math.abs(p.y - home.center.y) <= 16;
  const skip = new Set([].concat(exclude).map(x => String(x).replace(/[()\s]/g, '')));
  const targets = findStorage(bot, radius).filter(b => !inHomeArea(b.position) && !skip.has(doorKey(b.position)))
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

// ------------------------------------------------------------------ 睡觉

async function sleepInBed (bot, state, { home = null } = {}) {
  if (bot.isSleeping) return { already: true };
  // 床：名字以 bed 结尾的；女僕床、宠物床这种不是给人睡的
  const ids = Object.values(bot.registry.blocksByName)
    .filter(b => /(^|_|:)bed$/.test(b.name) && !/bedrock|flower_bed|seabed|riverbed|maid|pet_|dog_|cat_|kennel|nest/.test(b.name)).map(b => b.id);
  const beds = bot.findBlocks({ matching: ids, maxDistance: 48, count: 20 }).map(p => bot.blockAt(p)).filter(Boolean);
  if (!beds.length) throw new Error('附近 48 格内没有床');
  const inHome = (p) => home && Math.hypot(p.x - home.center.x, p.z - home.center.z) <= home.radius;
  beds.sort((a, b) => (inHome(b.position) - inHome(a.position)) || (bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)));
  const why = [];
  for (const bed of beds.slice(0, 4)) {
    // 睡不了的时候服务器会在动作栏说原因（只能晚上睡 / 附近有怪 / 床被占了）
    const said = [];
    const onMsg = (m, pos) => { if (pos === 'game_info' || pos === 'system') said.push(String(m.toString())); };
    bot.on('message', onMsg);
    try {
      if (bot.entity.position.distanceTo(bed.position) > 3) await go(bot, state, { x: bed.position.x, y: bed.position.y, z: bed.position.z, range: 2 });
      if (bot.isABed(bed)) {
        await bot.sleep(bed);
      } else {
        // 模组的床（比如 handcrafted 的）：mineflayer 只认原版 16 色床名，自己右键它
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        await bot.activateBlock(bed);
        for (let t = 0; t < 20 && !bot.isSleeping; t++) await sleep(100);
      }
      await sleep(300);
      if (bot.isSleeping) return { sleeping: true, bed: bed.name, at: doorKey(bed.position), inHome: !!inHome(bed.position) };
      why.push(`${bed.name}(${doorKey(bed.position)})：${said.join(' ') || '右键了但没躺下'}`);
    } catch (e) {
      const m = `${String(e.message || e)} ${said.join(' ')}`;
      why.push(`${bed.name}(${doorKey(bed.position)})：${/day|night|not possible|time/i.test(m) ? '现在不是晚上，睡不了' : /monster|mob|enem|safe/i.test(m) ? '附近有怪，睡不了' : /occupied/i.test(m) ? '床被占了' : m}`);
      if (/day|night|time|monster|mob|safe/i.test(m)) break;   // 时间/怪的问题换床也没用
    } finally {
      bot.removeListener('message', onMsg);
    }
  }
  throw new Error(`睡不了：${why.join('；')}`);
}

// ------------------------------------------------------------------ 种地：收成熟的、补种、给空耕地播种

/** 作物：有 age 属性、长在耕地（或灵魂沙）上的；熟没熟看 age 到没到最大值（模组作物的最大值从调色板的属性表里读） */
function cropInfo (bot, b) {
  if (!b) return null;
  const props = b.getProperties?.() || {};
  const ageKey = Object.keys(props).find(k => k.toLowerCase() === 'age');
  if (!ageKey) return null;
  const below = bot.blockAt(b.position.offset(0, -1, 0));
  const onSoil = below && /farmland|soul_sand|rich_soil/.test(below.name);
  if (!onSoil && !/berr/.test(b.name)) return null;      // 仙人掌、甘蔗、火这些也有 age，不算
  const st = (bot.registry.blocksByName[b.name]?.states || []).find(x => String(x.name).toLowerCase() === 'age');
  const max = st ? (st.num_values ?? st.values?.length ?? 8) - 1 : 7;
  const age = +props[ageKey];
  return { age, max, mature: age >= max, soil: below };
}

const SEED_OF = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', nether_wart: 'nether_wart', torchflower_crop: 'torchflower_seeds', pitcher_crop: 'pitcher_pod' };

/** 这个作物用背包里哪样东西种回去（原版查表；模组作物看掉落表：收它会掉的、名字像种子的那样） */
function seedFor (bot, cropName) {
  const items = bot.inventory.items();
  const bare = botName(cropName);
  if (SEED_OF[bare]) return items.find(i => botName(i.name) === SEED_OF[bare]) || null;
  const KB = K().load();
  const cropId = fullId(cropName);
  const cands = items.filter(i => (KB.drops.get(fullId(i.name)) || []).some(d => d.from === 'block' && d.id === cropId));
  return cands.sort((a, b) => /seed/.test(b.name) - /seed/.test(a.name))[0] || null;
}

async function collectDrops (bot, radius = 6) {
  let n = 0;
  for (let k = 0; k < 12; k++) {
    const drop = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    await pathTo(bot, drop.position.floored(), 0.6, 6000, { retry: false });
    await sleep(250); n++;
  }
  return n;
}

async function farm (bot, state, { radius = 12, replant = true, plantEmpty = true, seed = null } = {}) {
  const t0 = Date.now();
  const inv0 = invCounts(bot);
  // 只找"有生长阶段（age）属性"的方块种类 —— 以前是把周围所有非空气方块都拿来筛，上限 2000 个全是房子的墙
  const ageIds = Object.values(bot.registry.blocksByName)
    .filter(b => (b.states || []).some(x => String(x.name).toLowerCase() === 'age') && !/cactus|sugar_cane|fire|kelp|bamboo|vine|chorus|frosted_ice|twisting|weeping|cave_vines|sapling/.test(b.name))
    .map(b => b.id);
  const pts = bot.findBlocks({ matching: ageIds, maxDistance: radius, count: 1500 })
    .map(p => bot.blockAt(p)).filter(b => b && cropInfo(bot, b));
  const crops = pts.map(b => ({ b, info: cropInfo(bot, b) }));
  const mature = crops.filter(c => c.info.mature);
  let harvested = 0; let replanted = 0; let planted = 0; const notes = [];
  for (const { b } of mature.sort((a, c) => bot.entity.position.distanceTo(a.b.position) - bot.entity.position.distanceTo(c.b.position))) {
    const cur = bot.blockAt(b.position);
    if (!cur || cur.name !== b.name || !cropInfo(bot, cur)?.mature) continue;
    if (eyeDist(bot, cur) > REACH) { const err = await pathTo(bot, cur.position, 2, 15000); if (err && eyeDist(bot, cur) > REACH) { notes.push(`走不到 ${b.name}(${doorKey(b.position)})`); continue; } }
    try { await bot.dig(cur, true); harvested++; } catch (e) { notes.push(`收不了 ${b.name}：${e.message}`); continue; }
    await sleep(150);
    if (replant) {
      const sd = seedFor(bot, b.name);
      const soil = bot.blockAt(b.position.offset(0, -1, 0));
      if (sd && soil && /farmland|soul_sand|rich_soil/.test(soil.name)) {
        try { await bot.equip(sd, 'hand'); await bot.activateBlock(soil, new Vec3(0, 1, 0)); replanted++; } catch (e) { notes.push(`补种失败：${e.message}`); }
      }
    }
    if (harvested % 8 === 0) await collectDrops(bot, 5);
  }
  if (harvested) await collectDrops(bot, 8);
  // 空着的耕地：播种
  if (plantEmpty) {
    const lands = bot.findBlocks({ matching: (b) => !!b && /farmland/.test(b.name), maxDistance: radius, count: 400 })
      .filter(p => { const up = bot.blockAt(p.offset(0, 1, 0)); return up && up.name === 'air'; }).map(p => bot.blockAt(p));
    const sdItem = () => (seed ? bot.inventory.items().find(i => fullId(i.name) === fullId(seed)) : bot.inventory.items().find(i => /seed|^carrot$|^potato$/.test(botName(i.name))));
    for (const land of lands) {
      const sd = sdItem();
      if (!sd) { if (lands.length) notes.push(`还有 ${lands.length - planted} 块空地，背包里没种子了`); break; }
      if (eyeDist(bot, land) > REACH) { const err = await pathTo(bot, land.position, 2, 12000); if (err && eyeDist(bot, land) > REACH) continue; }
      try { await bot.equip(sd, 'hand'); await bot.activateBlock(land, new Vec3(0, 1, 0)); planted++; await sleep(100); } catch (_) {}
    }
  }
  const d = delta(inv0, invCounts(bot));
  return { crops: crops.length, mature: mature.length, harvested, replanted, plantedEmpty: planted, got: d.gained, used: d.lost, notes: notes.slice(0, 6), seconds: Math.round((Date.now() - t0) / 1000),
    note: crops.length ? null : `附近 ${radius} 格内没有庄稼` };
}

// ------------------------------------------------------------------ 厨锅做菜（农夫乐事）

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
      await bot.transfer({ window: w, itemType: it.type, metadata: null, count: n, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: slot, destEnd: slot + 1 });
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

// ------------------------------------------------------------------ 路由

function routes ({ state, withTimeout }) {
  const bot = () => state.bot;
  return {
    'POST /eat': async (b = {}) => eat(bot(), b),
    'POST /use': async (b = {}) => use(bot(), state, b),
    'POST /wear': async (b = {}) => wear(bot(), state, b),
    'POST /craft2': async (b = {}) => craft2(bot(), b, withTimeout),
    'POST /smelt': async (b = {}) => smelt(bot(), b),
    'POST /give': async (b = {}) => give(bot(), b),
    'POST /climb_up': async (b = {}) => climbUp(bot(), state, b),
    'POST /climb_down': async (b = {}) => climbDown(bot(), state, b),
    'POST /go': async (b = {}) => go(bot(), state, b),
    'GET /look_around': async (_, q) => lookAround(bot(), { r: q?.r, below: q?.below, above: q?.above }),
    'POST /motor': async (b = {}) => motor(bot(), state, b),
    'POST /nudge': async (b = {}) => nudge(bot(), b),
    'POST /wiggle': async (b = {}) => wiggle(bot(), b),
    'GET /doors': async (_, q) => ({ doors: doorsNear(bot(), Math.min(+(q?.radius || 8), 16)), iOpened: [...(state.doorsIOpened || new Map()).values()].map(d => ({ ...d, pos: doorKey(d.pos) })), leftOpen: (state.doorsLeftOpen || []).slice(-5), lastClosed: state.lastDoorClosed || null }),
    'POST /door': async (b = {}) => {
      const r = await setDoor(bot(), state, b);
      // keepOpen：她明确要让门一直开着（比如放动物进圈），就不按习惯关
      if (b.open && b.keepOpen) state.doorsIOpened?.delete(`${b.x},${b.y},${b.z}`);
      return r;
    },
    'POST /doors/forget-left-open': async () => { const n = state.doorsLeftOpen.length; state.doorsLeftOpen = []; return { cleared: n }; },
    'POST /container/open': async (b = {}) => containerOpen(bot(), state, b),
    'GET /container': async () => summarizeWindow(bot(), state) || { open: false, lastWindowInfo: state.lastWindowInfo || null },
    'POST /container/put': async (b = {}) => containerPut(bot(), state, b),
    'POST /container/take': async (b = {}) => containerTake(bot(), state, b),
    'POST /container/deposit': async (b = {}) => { const r = await deposit(bot(), state, b); noteBackpack(state, bot().currentWindow); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    'POST /container/withdraw': async (b = {}) => { const r = await withdraw(bot(), state, b); noteBackpack(state, bot().currentWindow); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    'POST /container/sort': async () => { const r = await sortContainer(bot()); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    // 最近看过的箱子里有什么（since：只要这之后看的）
    'GET /containers/seen': async (_, q) => ({ seen: [...(state.seenContainers || new Map()).values()].filter(c => c.at > (+q?.since || 0)) }),
    'POST /storage/organize': async (b = {}) => organizeStorage(bot(), state, b),
    'POST /storage/loot': async (b = {}) => lootNearby(bot(), state, b),
    'POST /sleep': async (b = {}) => sleepInBed(bot(), state, b),
    'POST /farm': async (b = {}) => farm(bot(), state, b),
    'POST /cook_pot': async (b = {}) => cookInPot(bot(), state, b),
    'POST /wake': async () => { if (bot().isSleeping) await bot().wake(); return { awake: true }; },
    'POST /inventory/sort': async () => sortInventory(bot()),
    'POST /container/close': async () => {
      const w = bot().currentWindow;
      if (w && state.openContainerPos) noteSeen(bot(), state, w, state.openContainerPos);
      noteBackpack(state, w);
      if (w) bot().closeWindow(w);
      return { closed: !!w };
    },
    'GET /debug/payloads': async () => ({ recent: state.recentPayloads || [], lastForgeOpen: state.lastForgeOpen || null, lastWindowInfo: state.lastWindowInfo || null }),
    'POST /unequip': async ({ slot, itemName } = {}) => {
      const b = bot();
      const eq0 = equipment(b);
      let dest = slot;
      if (!dest && itemName) dest = Object.keys(eq0).find(k => eq0[k] && (eq0[k] === fullId(itemName) || eq0[k].endsWith(`:${itemName}`)));
      if (!dest || !(dest in eq0)) throw new Error(`要给 slot（head/torso/legs/feet/off-hand/hand）或穿着的 itemName；现在穿着：${JSON.stringify(eq0)}`);
      if (!eq0[dest]) return { already: true, slot: dest };
      if (b.inventory.emptySlotCount() === 0) throw new Error('背包满了，脱不下来');
      await b.unequip(dest);
      await sleep(400);
      const eq1 = equipment(b);
      if (eq1[dest]) throw new Error(`没脱下来（${dest} 还是 ${eq1[dest]}）`);
      return { took_off: eq0[dest], slot: dest, nowInInventory: true };
    },
    'GET /debug/shape-fixes': async () => ({ fixes: state.shapeFixes || 0, blocks: [...(state.shapeFixNames || [])] }),
    'GET /curios': async () => curiosList(bot(), state),
    'POST /curios/equip': async (b = {}) => curiosEquip(bot(), state, b),
    'POST /curios/unequip': async (b = {}) => curiosUnequip(bot(), state, b),
    'POST /backpack/open': async () => backpackOpen(bot(), state),
    // 调试：原样发一个模组消息（逆向模组协议时用）{ channel, hex }
    'POST /debug/payload': async (b = {}) => { bot()._client.write('custom_payload', { channel: b.channel, data: Buffer.from(b.hex || '', 'hex') }); await sleep(b.waitMs || 1500); return { sent: b, window: summarizeWindow(bot(), state) }; },
    'GET /debug/soph': async () => ({ lastSync: state.lastSophSync || null, error: state.lastSophError || null }),
    'GET /equipment': async () => ({ equipment: equipment(bot()), food: bot().food, health: bot().health, curios: state.curiosWorn || null, backpack: state.backpackSeen || null }),
  };
}

module.exports = { install, routes, slotByName, foodScore, fullId, botName };
