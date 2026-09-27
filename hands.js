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
  state.doorActivations = new Map(); // 同一扇门的右键串行化，避免两条路线同时切换两次
  state.doorsLeftOpen = state.doorsLeftOpen || [];   // 走远了没来得及关的
  const orig = bot.activateBlock.bind(bot);
  bot.activateBlock = async (block, ...rest) => {
    let base = block && doorBase(bot, block.position);
    if (!base || !isDoorLike(base)) return orig(block, ...rest);

    const pos = base.position.clone();
    const key = doorKey(pos);
    const wantsOpen = !state.__closingDoor;
    const pending = state.doorActivations.get(key);
    if (pending) await pending.catch(() => {});

    // 规划时可能还是关着的，走到门前时已经被上一条路线打开了。
    // 必须以右键前这一刻的世界状态为准；否则右键会把开门变成关门，下一轮又打开。
    base = doorBase(bot, pos);
    if (!base || !isDoorLike(base)) return orig(block, ...rest);
    const openNow = isOpen(base);
    if (openNow === wantsOpen) {
      state.doorStateSkips = (state.doorStateSkips || 0) + 1;
      state.lastDoorSkipped = { pos: key, name: base.name, open: openNow, wanted: wantsOpen, at: Date.now() };
      return { skipped: true, reason: openNow ? '门已经开着' : '门已经关着' };
    }

    let release;
    const lock = new Promise(resolve => { release = resolve; });
    state.doorActivations.set(key, lock);
    const wasAt = bot.entity?.position?.clone?.();
    try {
      const r = await orig(base, ...rest);
      if (wantsOpen) {
        await sleep(250);
        const now = doorBase(bot, pos);
        if (now && isDoorLike(now) && isOpen(now)) {
          state.doorsIOpened.set(key, { pos, name: now.name, openedAt: Date.now(), wasAt: wasAt || bot.entity.position.clone() });
        }
      }
      return r;
    } finally {
      release();
      if (state.doorActivations.get(key) === lock) state.doorActivations.delete(key);
    }
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
  const pos0 = b.position;
  b = doorBase(bot, pos0);
  if (!b || !isDoorLike(b)) throw new Error(`右键之后 (${pos0.x},${pos0.y},${pos0.z}) 读不到门了（是 ${b?.name || '读不到'}）`);
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

/**
 * 背包界面里哪一段是她自己的 36 格。
 *
 * 精妙背包还会在玩家物品栏后面附加升级格，不能简单取最后 36 格。旧实现只数
 * “相同的非空格”，普通物品栏装满了刚从背包搬出的东西时，背包开头和真正的玩家段
 * 会同分，并错误选择第 0 格。这里同时比较空格，平分时优先上次可信边界，再按
 * “容量是 9 的倍数、尾部升级格不超过 16 格”的界面结构选择。
 */
function locatePlayerInv (bot, items, preferred = null) {
  const mine = bot.inventory.slots.slice(9, 45).map(x => (x ? `${x.type}:${x.count}` : '-'));
  let bestScore = -1; const best = [];
  for (let k = 0; k + 36 <= items.length; k++) {
    let sc = 0;
    for (let j = 0; j < 36; j++) { const x = items[k + j]; if ((x ? `${x.type}:${x.count}` : '-') === mine[j]) sc++; }
    if (sc > bestScore) { bestScore = sc; best.length = 0; best.push(k); }
    else if (sc === bestScore) best.push(k);
  }
  if (Number.isInteger(preferred) && preferred > 0 && best.includes(preferred)) return preferred;
  const structural = best.filter(k => k > 0 && k % 9 === 0 && items.length - (k + 36) >= 0 && items.length - (k + 36) <= 16);
  if (structural.length) return structural[structural.length - 1];
  return best.filter(k => k > 0).pop() ?? -1;
}

// ------------------------------------------------------------------ FTB 任务书（Architectury 网络）

/**
 * FTB Quests 不用 Forge SimpleChannel，用 Architectury：所有消息走同一条 Forge **事件通道** `architectury:network`，
 * 载荷 = writeResourceLocation(消息名) + 消息体，**没有数字序号前缀**（architectury-9.2.14 NetworkManagerImpl.toPacket 反汇编）。
 *   ftbquests:submit_task   long taskId            —— 点对号、交物品都是它（任务书里点"提交"/对号时客户端发的就是这条）
 *   ftbquests:claim_reward  long rewardId, bool notify
 *   ftbquests:claim_all_rewards （空）
 * 任务/奖励 id 是任务书里的 16 位十六进制，按有符号 long 写。
 */
function mcString (str) {
  const b = Buffer.from(str, 'utf8'); const len = [];
  let n = b.length; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; len.push(x); } while (n);
  return Buffer.concat([Buffer.from(len), b]);
}
function hexLong (hex) {
  const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt('0x' + String(hex).replace(/^0x/i, '')))); return b;
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
  // 不能拿旧 windowId 当身份：服务端会把编号复用给普通箱子/模组界面。
  // 同步标记、格子边界都有效才更新；读不到时保留上一次可信快照，绝不写成“空”。
  if (!w?.__sophisticated || !Number.isInteger(w.inventoryStart) || w.inventoryStart <= 0 || !Array.isArray(w.slots) || w.inventoryStart > w.slots.length) return false;
  const items = {};
  for (let i = 0; i < w.inventoryStart; i++) { const it = w.slots[i]; if (it) items[fullId(it.name)] = (items[fullId(it.name)] || 0) + it.count; }
  state.backpackSeen = { items, slots: w.inventoryStart, used: w.slots.slice(0, w.inventoryStart).filter(Boolean).length, at: Date.now() };
  return true;
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
      if (!table) { tried.push('要工作台，但 16 格内没有（背包里有的话先 place 放下）'); continue; }
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
      // 燃料可能在精妙背包里（N-9：日志里 `没有燃料` ×5）—— 先把它当"随身物品"补齐再判"没有"
      const FUEL_RE = /(^|:)(coal|charcoal|_log|_planks|stick|coal_block|blaze_rod|lava_bucket|dried_kelp_block|bamboo)$/;
      if (state) await ensureCarried(bot, state, (it) => FUEL_RE.test(fullId(it.name)), Math.max(1, Math.ceil(need / 8)));
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

/** 梯子底端离当前脚高不超过 2 格时，交给 stepInto 实际尝试；再高才是真的够不到。 */
function ladderBottomReachable (col, feetY) {
  return Math.abs(col.bottom - Math.floor(feetY)) <= 2.5;
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

  // 往上爬到梯子顶那一格的上面（出口层）。
  // 梯子顶上头顶空间不够时（2026-09-27 她家：梯子顶 128、129 空、130 是屋顶楼梯块）人最高只能到 128.2，
  // 从侧面迈到阁楼上 —— 以前硬要爬到 129，每次都报"上不去"，她在梯子上来回跳
  let ceil = null;
  for (let y = col.top + 1; y <= col.top + 3 && ceil == null; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && !passable(b) && !/trapdoor/.test(b.name)) ceil = y; }
  const exitFeetY = ceil != null ? Math.min(col.top + 1, ceil - 1.8) : col.top + 1;
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
  // 头顶被挡：只能在梯子顶那一层（脚在 top）往旁边迈
  const exits3 = exits.length || exits2.length ? [] : [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: col.x + dx, z: col.z + dz, y: col.top }))
    .filter(c => solidUnder(bot.blockAt(new Vec3(c.x, c.y - 1, c.z))) && passable(bot.blockAt(new Vec3(c.x, c.y, c.z))) && passable(bot.blockAt(new Vec3(c.x, c.y + 1, c.z))));
  const cands = exits.length ? exits.map(c => ({ ...c, y: landY })) : exits2.length ? exits2 : exits3;
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
      // 梯子最低一格可能装在腰/头顶高度（现场：脚 y=121、梯子 bottom=123）。
      // stepInto 会用寻路 + 跳跃核对是否真能进去；这里先给它尝试机会，别在候选阶段误删。
      .filter(c => !used.has(`${c.x},${c.z},${c.bottom}`) && c.top >= feet.y && ladderBottomReachable(c, feet.y))
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
    // 门口失败时别原地蹦跳：门应由寻路器的开门动作处理，跳跃只会撞门框。
    const nearDoor = bot.registry?.blocksByName && doorsNear(bot, 3).some(d =>
      Math.abs(d.y - Math.floor(bot.entity.position.y)) <= 1);
    if (retry && !nearDoor) {
      const w = await wiggle(bot, { rounds: 1 }).catch(() => null);
      if (w?.freed) return pathTo(bot, pos, range, ms, { retry: false });
    }
    return e.message || String(e);
  }
}

/** 跨层后横向靠近目标：临时禁止寻路跌回下面楼层。 */
async function pathToKeepingFloor (bot, pos, range, ms, minFeetY) {
  const mv = bot.pathfinder?.movements;
  if (!mv?.exclusionAreasStep || !Number.isFinite(minFeetY)) return pathTo(bot, pos, range, ms, { retry: false });
  const floorGuard = block => block?.position?.y < minFeetY ? 100 : 0;
  mv.exclusionAreasStep.push(floorGuard);
  try {
    return await pathTo(bot, pos, range, ms, { retry: false });
  } finally {
    const i = mv.exclusionAreasStep.indexOf(floorGuard);
    if (i !== -1) mv.exclusionAreasStep.splice(i, 1);
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

// ------------------------------------------------------------------ 跟随（先对齐楼层）

/** 跟随循环的节奏：每秒看一眼 */
const FOLLOW_TICK_MS = 1000;
/** 看不见玩家多久之后放弃（下线 / 走出视野）—— 够久到"他只是跑远了"，又不至于永远挂着 */
const FOLLOW_LOST_MS = 15000;

/**
 * 跟着一个玩家。
 *
 * 原来只是 GoalFollow（按直线距离追）：玩家上了楼，她就跑到玩家**正下方**站着 ——
 * 水平距离对上了，高度差 5 格，寻路器不会从梯子上楼，于是一直在一楼（玩家指出）。
 * 真人跟人是先上同一层楼，再往他身边走。所以：
 *   · 高度差 ≥ 2.5 格（不在同一层）：走带梯子和门的路线（go()）到他那一层
 *   · 同一层：交给 GoalFollow 贴着走
 * 每秒看一次；停止（/stop 清掉 currentAction）或换了跟随对象就退出。
 *
 * ⚠️ 退出这件事有三条路，缺一条就会"看起来还在跟，其实早就跟丢了"：
 *   ① `/stop` / 别的动作改了 `currentAction` → `alive()` 变 false
 *   ② 换了跟随对象 → `followSeq` 变了 → 旧循环退出（新旧两个循环同时驱动寻路器会打架）
 *   ③ 玩家下线 / 走出视野 → `bot.players[name]` 会被 mineflayer **整个删掉**，
 *      `?.entity` 恒为 undefined → 旧写法只会每秒空转、永远不退（`/status` 一直显示在跟随）。
 * 另外：**循环体抛错不能被最外层 `.catch(() => {})` 静默吞掉** —— 吞掉之后循环直接结束，
 * 外面完全看不出来（只有 /debug/follow 里的 lastFollowRoute 停在旧时间戳）。所以内层要 try。
 */
function startFollow (bot, state, playerName, dist = 2, opts = {}) {
  const tag = `following ${playerName}`;
  const id = (state.followSeq = (state.followSeq || 0) + 1);
  state.currentAction = tag;
  // 两个节奏值集中在这里（"同一判据只写一处"）。自测会把它们调小，跑真代码但不用等 15 秒。
  const tickMs = opts.tickMs || FOLLOW_TICK_MS;
  const lostMs = opts.lostMs || FOLLOW_LOST_MS;
  const { goals } = require('mineflayer-pathfinder');
  const alive = () => state.followSeq === id && state.currentAction === tag;
  const setFollow = (e) => { if (!(bot.pathfinder.goal instanceof goals.GoalFollow) || bot.pathfinder.goal.entity !== e) bot.pathfinder.setGoal(new goals.GoalFollow(e, dist), true); };
  // 退出时清掉**我们这一轮**留下的 GoalFollow。
  // 两道闸：① `followSeq` 变了说明换了跟随对象 —— 新循环的 goal 不归我们管；
  //        ② 只清 GoalFollow —— 别的动作（`/move` 的 GoalNear…）刚设的 goal 不能动，
  //           否则跟随循环晚一秒醒来会把那条路线清掉，看起来就是"/move 没反应"。
  const dropGoal = () => {
    if (state.followSeq !== id) return;
    try {
      if (bot.pathfinder.goal instanceof goals.GoalFollow) bot.pathfinder.setGoal(null);
    } catch (_) { /* 断线时 pathfinder 可能整个没了 */ }
  };
  (async () => {
    let routing = false;
    let lostSince = 0;
    try {
      while (alive()) {
        const e = bot.players[playerName]?.entity;
        if (!e) {
          // 看不见人：可能只是走远了，也可能下线了（后者 mineflayer 会删掉 bot.players[name]）。
          // 给一段缓冲，还看不见就退出并如实记下原因 —— 不能每秒空转到天荒地老。
          if (!lostSince) lostSince = Date.now();
          if (Date.now() - lostSince >= lostMs) {
            state.lastFollowStop = { at: Date.now(), reason: `看不见 ${playerName}（下线或走远了）` };
            break;
          }
        } else {
          lostSince = 0;
          if (!routing) {
            const dy = e.position.y - bot.entity.position.y;
            if (Math.abs(dy) >= 2.5) {
              routing = true;
              bot.pathfinder.setGoal(null);
              try {
                const r = await go(bot, state, { player: playerName, range: dist, maxMs: 45000, abort: () => !alive() });
                state.lastFollowRoute = { at: Date.now(), dy: +dy.toFixed(1), arrived: r.arrived, tried: (r.tried || []).slice(-4) };
              } catch (err) {
                // 被叫停不算错：`/stop`、换跟随对象都会走到这里
                state.lastFollowRoute = { at: Date.now(), dy: +dy.toFixed(1), ...(err.aborted ? { aborted: true } : { error: err.message }) };
              }
              routing = false;
              if (!alive()) break;   // 路上被叫停了（/stop 清掉了 currentAction）或换了跟随对象
            } else setFollow(e);
          }
        }
        await sleep(tickMs);
      }
    } catch (err) {
      // 循环体抛错：记下来（/debug/follow 看得见），别让它静默结束
      state.lastFollowStop = { at: Date.now(), reason: `跟随循环出错：${err.message}` };
    } finally {
      routing = false;
      dropGoal();
    }
  })().catch(err => {
    // 兜底：内层 try 没拦住的（比如 finally 里的 dropGoal 又抛了）也不能静默消失。
    // 旧写法是 `.catch(() => {})` —— 循环一死外面完全看不出来。
    state.lastFollowStop = { at: Date.now(), reason: `跟随循环兜底捕获：${err.message}` };
  });
  return { following: playerName };
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

/** 被叫停（`/stop`、换了跟随对象）时抛这个：`aborted` 让调用方能和"走不通"分开处理 */
function abortError () {
  const e = new Error('被叫停了');
  e.aborted = true;
  return e;
}

async function go (bot, state, { x, y, z, player, range = 1.8, maxMs = 90000, abort } = {}) {
  const t0 = Date.now();
  const tried = [];
  // `abort` 是"还要不要继续"的谓词（见 startFollow）。没有它的时候 `/stop` 停不住一条在途路线：
  // pathTo 里的 goto 会被 setGoal(null) 打断，但 go 会接着走下一步、**重新把 goal 设回去** ——
  // 于是"急停"之后她还在走。所以每个 await 之后都要问一次。
  const stopped = () => { try { return typeof abort === 'function' && !!abort(); } catch (_) { return false; } };
  const checkStop = () => { if (stopped()) throw abortError(); };
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
  checkStop();

  // 同一层：先直接走（最常见、最快）；跨层或者直接走不通：规划一条带梯子和门的路线
  const sameFloor = Math.abs(target().y - Math.floor(bot.entity.position.y + 0.01)) < 2;
  if (sameFloor) {
    const err0 = await pathTo(bot, target(), range, eta());
    checkStop();
    // 只信实际距离：寻路器有时一步没走就"完成"了（实测 45ms 返回、还差 3 格，却报了到达）
    if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
    tried.push(`直接走：${err0 || '寻路器说走完了，其实还差 ' + dist().toFixed(1) + ' 格'}`);
  }
  const routed = await followRoute(bot, state, target, range, tried, t0, maxMs);
  checkStop();
  if (routed && near()) {
    return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ① 楼上楼下
  const dy = target().y - Math.floor(bot.entity.position.y + 0.01);
  let keepFloorAt = null;
  if (Math.abs(dy) >= 3) {
    try {
      const r = dy > 0 ? await climbUp(bot, state, { targetY: target().y }) : await climbDown(bot, state, { targetY: target().y });
      tried.push(`${dy > 0 ? '上楼' : '下楼'}：${r.fromY}→${r.toY}`);
      // 已爬到目标所在楼层后，后续横向靠近不能把跳下楼当捷径。
      if (dy > 0 && r.toY >= target().y - 1.5) keepFloorAt = Math.floor(r.toY) - 1;
    } catch (e) { tried.push(`${dy > 0 ? '上楼' : '下楼'}没成：${e.message}`); }
    checkStop();
  }

  // ② 走到旁边
  let err = keepFloorAt == null
    ? await pathTo(bot, target(), range, eta())
    : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
  checkStop();
  if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  err ||= `寻路器说走完了，其实还差 ${dist().toFixed(1)} 格`;
  tried.push(`寻路：${err}`);

  // 跨层路线常会先走到一个更高的平台，再因为当前 A* 搜索边界结束而返回失败。
  // 只要实际距离明显缩短，就以**此刻位置**为新起点继续算；不重复旧起点，也不在没进展时死循环。
  let bestDist = Math.min(startDist, dist());
  for (let retry = 1; retry <= 3 && Date.now() - t0 < maxMs; retry++) {
    checkStop();
    const before = dist();
    if (before > bestDist + 0.75 || before <= range + 0.8) break;
    const leftMs = Math.max(5000, maxMs - (Date.now() - t0));
    const nextErr = keepFloorAt == null
      ? await pathTo(bot, target(), range, Math.min(eta(), leftMs))
      : await pathToKeepingFloor(bot, target(), range, Math.min(eta(), leftMs), keepFloorAt);
    checkStop();
    const after = dist();
    if (near()) return { arrived: true, distance: +after.toFixed(1), tried: [...tried, `从当前位置续算第 ${retry} 次：到达`], ms: Date.now() - t0 };
    if (after < before - 0.75) {
      bestDist = Math.min(bestDist, after);
      tried.push(`从当前位置续算第 ${retry} 次：${before.toFixed(1)}→${after.toFixed(1)} 格`);
      err = nextErr || `还差 ${after.toFixed(1)} 格`;
      continue;
    }
    tried.push(`从当前位置续算第 ${retry} 次没有进展（${after.toFixed(1)} 格），停止重复`);
    break;
  }

  // ③ 开挡路的门（往目标那边的、关着的）
  for (let n = 0; n < 3 && Date.now() - t0 < maxMs; n++) {
    checkStop();
    const me = bot.entity.position; const tg = target();
    const doors = doorsNear(bot, 10).filter(d => !d.open && !/iron|trapdoor|hatch/.test(d.name))
      .map(d => ({ ...d, toTarget: Math.hypot(d.x + 0.5 - tg.x, d.z + 0.5 - tg.z) }))
      .filter(d => d.toTarget < Math.hypot(me.x - tg.x, me.z - tg.z) + 2)
      .sort((a, b) => (a.distance + a.toTarget) - (b.distance + b.toTarget));
    if (!doors.length) break;
    const d = doors[0];
    try {
      await setDoor(bot, state, { x: d.x, y: d.y, z: d.z, open: true });
      tried.push(`开了挡路的${d.kind}(${d.x},${d.y},${d.z})`);
    } catch (e) { tried.push(`想开${d.kind}(${d.x},${d.y},${d.z})没开成：${e.message}`); break; }
    err = keepFloorAt == null
      ? await pathTo(bot, target(), range, eta())
      : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
    checkStop();
    if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
  }

  // ④ 放宽范围 / 先走一段
  for (const r2 of [3, 5]) {
    if (Date.now() - t0 > maxMs) break;
    checkStop();
    err = keepFloorAt == null
      ? await pathTo(bot, target(), r2, eta())
      : await pathToKeepingFloor(bot, target(), r2, eta(), keepFloorAt);
    checkStop();
    if (!err) { tried.push(`放宽到 ${r2} 格：走到了`); break; }
    tried.push(`放宽到 ${r2} 格：${err}`);
  }
  if (!near() && dist() > 6 && Date.now() - t0 < maxMs) {
    const me = bot.entity.position; const tg = target();
    const k = Math.min(1, 8 / dist());
    const mid = new Vec3(Math.floor(me.x + (tg.x - me.x) * k), Math.floor(me.y), Math.floor(me.z + (tg.z - me.z) * k));
    const e2 = keepFloorAt == null
      ? await pathTo(bot, mid, 3, 20000)
      : await pathToKeepingFloor(bot, mid, 3, 20000, keepFloorAt);
    checkStop();
    tried.push(e2 ? `先往目标走一段：${e2}` : `先往目标走了一段到 (${mid.x},${mid.z})`);
    if (!e2) {
      err = keepFloorAt == null
        ? await pathTo(bot, target(), range, eta())
        : await pathToKeepingFloor(bot, target(), range, eta(), keepFloorAt);
      checkStop();
      // 只信实际距离（第四处，和上面三处同一个判据）
      if (near()) return { arrived: true, distance: +dist().toFixed(1), tried, ms: Date.now() - t0 };
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
  if (/torch|lantern|campfire|candle/.test(n)) return 'i';   // 光源单独标出来（以前和草花一样是 , 她认不出自己插的火把）
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
    legend: '@你 #实心 .空气 H梯子 T关着的活板门 t开着的 D关着的门 d开着的 G关着的栅栏门 g开着的 |栅栏/墙 _台阶 /楼梯 ~水 !岩浆 *树叶 i火把/灯 ,能穿过的小东西',
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
  markSeen(state, key);
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

/** 同 ID 但附魔、耐久、NBT 不同的物品不能当成同一堆。 */
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

/** 排完后验收：顺序、空格压紧、可合并残堆和鼠标游标都必须正确。 */
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
        await safeTransfer(bot, { window: w, itemType: it.type, metadata: null, count: need, sourceStart: i, sourceEnd: i + 1, destStart: w.inventoryStart, destEnd: w.inventoryEnd });
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
const knownTierOf = (name) => { const i = TIERS.findIndex(t => String(name).includes(t)); return i < 0 ? null : i; };

/**
 * 默认随身装备：最好的镐/斧/剑、一组最顶饱的吃的、16 火把、32 搭脚方块（主人 2026-09-27：至少带武器、工具、食物、搭脚方块）。
 * essential = 缺了值得专程回家拿（随身物品本能用，见 instinct.js）；其余缺了只记着，顺路整理时补。
 */
const SCAFFOLD_IDS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'netherrack', 'blackstone'].map(n => `minecraft:${n}`);
/**
 * 搭脚方块的完整名单：上面的原版底子 + 整合包标签里算泥土 / 石头 / 圆石的（草方块、模组的泥土石头都算）。
 * 以前只认写死的 11 种，背包里一组草方块或模组泥土她会说"没有搭脚方块"跑回家拿（2026-09-27 主人指出草方块不算泥土的同类问题）。
 * 会塌的（沙、砂砾、灰烬）、耕地小路、磨制/砖（值钱）、塞进标签的装饰（陶罐）不算。
 */
const SCAFFOLD_TAGS = ['minecraft:dirt', 'forge:cobblestone', 'forge:stone', 'minecraft:stone_crafting_materials'];
const NOT_SCAFFOLD_RE = /sand|gravel|(^|:|_)ash$|suspicious|farmland|_path$|vase|_pot$|_jar$|infested|polished|bricks?$|concrete_powder|quicksand/;
let scaffoldCache = null;
function scaffoldIds () {
  if (scaffoldCache) return scaffoldCache;
  const set = new Set(SCAFFOLD_IDS);
  let fromTags = false;
  try {
    const kb = K().load();
    for (const t of SCAFFOLD_TAGS) for (const id of kb.tags.get(`item:${t}`) || []) if (!NOT_SCAFFOLD_RE.test(id)) { set.add(id); fromTags = true; }
  } catch (_) { /* 读不到知识库：只用原版底子，下次再试 */ }
  const list = [...set];
  if (fromTags) scaffoldCache = list;
  return list;
}
function defaultLoadout () {
  return [
    { kind: 'best', re: /pickaxe$/, count: 1, label: '最好的镐', essential: true },
    { kind: 'best', re: /(^|_)axe$/, count: 1, label: '最好的斧' },
    { kind: 'best', re: /sword$/, count: 1, label: '最好的剑' },
    { kind: 'food', count: 16, min: 4, label: '吃的', essential: true },
    { kind: 'id', id: 'minecraft:torch', count: 16, label: '火把' },
    { kind: 'any', ids: scaffoldIds(), count: 32, min: 8, label: '搭脚方块', essential: true },
    // 落地水（主人 2026-09-27）：搭不了路要往下跳时，落地前倒水保命、落地后收回（instinct.js 的反射）
    { kind: 'id', id: 'minecraft:water_bucket', count: 1, label: '一桶水', essential: true },
  ];
}
// 只用来查缺不缺，不参与整理时"留哪几件"：剑和斧有一样就算有武器
const WEAPON_CHECK = { kind: 'best', re: /(sword|(^|_)axe)$/, count: 1, label: '武器', essential: true };

/** 这件东西算不算装备单里的这一项（整理、补齐、查缺三处共用这一个判据） */
function kitMatch (bot, L, it) {
  if (L.kind === 'best') return L.re.test(it.name);
  if (L.kind === 'food') return categoryOf(bot, it) === '食物' && foodScore(it) > 0;
  if (L.kind === 'id') return fullId(it.name) === L.id;
  if (L.kind === 'any') return L.ids.includes(fullId(it.name));
  return L.m(it);
}

/**
 * 装备单缺什么。items：[{ name, count }]（背包的，或者箱子里记着的）。
 * 缺 = 少于 min（没给 min 就是 count；best 类就是一件没有）。返回 [{ label, have, need, essential }]。
 */
function kitShortfall (bot, items, loadout = defaultLoadout()) {
  const out = [];
  for (const L of [...loadout, WEAPON_CHECK]) {
    const have = items.filter(it => kitMatch(bot, L, it)).reduce((a, it) => a + (it.count || 1), 0);
    const need = L.kind === 'best' ? 1 : (L.min ?? L.count);
    if (have < need) out.push({ label: L.label, have, need, essential: !!L.essential });
  }
  // 有武器（剑或斧）就不单说"缺剑""缺斧"是急事 —— 本来它俩也不是 essential
  return out;
}

function loadoutTargetShortfall (bot, items, loadout = defaultLoadout()) {
  const out = [];
  for (const L of loadout) {
    const have = items.filter(it => kitMatch(bot, L, it)).reduce((a, it) => a + (it.count || 1), 0);
    const target = L.kind === 'best' ? 1 : L.count;
    if (have < target) out.push({ label: L.label, have, target, essential: !!L.essential });
  }
  return out;
}
/** 背没背着精妙背包（饰品栏 / 胸甲槽）。饰品栏是上线时摸过一次记下的（install 里 curiosList） */
function wearingBackpack (bot, state) {
  return (state.curiosWorn || []).some(x => /backpack/.test(x)) || /backpack/.test(bot.inventory.slots[6]?.name || '');
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

// ------------------------------------------------------------------ 随身物品：身上没有就从背包拿
//
// 主人 2026-09-28（codex 审计 P-4 / N-9）：`Not carrying minecraft:crafting_table` ×4、
// `Not carrying 石镐` ×3、`Not carrying torch` ×1、`没有燃料` ×5 —— 东西都在精妙背包（108 格）里，
// 但 bridge 这侧查"有没有"的地方一律只看 `bot.inventory`。mind 的 inventory 工具已经合并了背包
// （`f7dded3`），bridge / 本能没跟上。这里补的是**同一件事在 bridge 侧的入口**。

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
  const before = invCounts(bot);
  const had = before.get(want) || 0;
  // count = Infinity 表示"能拿多少拿多少"（垫脚方块这类不挑数量的场景）
  let need = count === Infinity ? Infinity : Math.max(1, +count || 1);
  await backpackOpen(bot, state);          // 打开 + 校验边界；失败会抛（背包没开 / 边界认不出）
  const w = bot.currentWindow;
  if (!w || !w.__sophisticated || !w.__sophBoundaryValid || !(w.inventoryStart > 0)) {
    throw new Error('背包界面认不出玩家物品栏边界，不敢从里面拿东西（避免搬错格）');
  }
  let moved = 0;
  try {
    // 背包自己的格子在前段 0..inventoryStart-1；同种的整堆从左到右拿，直到够
    for (let i = 0; i < w.inventoryStart && need > 0; i++) {
      const it = w.slots[i];
      if (!it || fullId(it.name) !== want) continue;
      const n0 = invCounts(bot).get(want) || 0;
      await click(bot, i, 0, 1);           // shift+左键：服务器把整组塞进玩家物品栏
      await sleep(180);                    // 精妙背包的格子走自己的封包，点完立刻读会看漏（同 deposit 注释）
      const n1 = invCounts(bot).get(want) || 0;
      if (n1 > n0) { moved += n1 - n0; need -= n1 - n0; } else if (!w.slots[i]) { break; }   // 格子空了还是没变多：异常，停
    }
  } finally {
    noteBackpack(state, w);                // 记下背包现在还有多少（这次打开后的真实状态）
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
  }
  const gained = (invCounts(bot).get(want) || 0) - had;
  // 不信"点成功了"：身上真多了才算拿到
  if (gained <= 0) {
    return { fetched: {}, took: {}, note: `背包里没找到 ${name}（或者没搬过来）` };
  }
  return { fetched: { [want]: gained }, took: tally([{ name: want, count: gained }]), moved };
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
function decideCarry ({ carried, backpack, specKind = 'item' }) {
  // carried / backpack 都是 null = 读不到
  const had = carried == null ? 0 : carried;
  if (had > 0) return { action: 'use', reason: '身上就有' };
  if (backpack == null) return { action: 'unknown', reason: '身上没有，背包读不到' };
  if (backpack > 0) return { action: 'fetch', reason: '身上没有，背包里有' };
  return { action: 'none', reason: '身上和背包里都没有' };
}

/** 从 state.backpackSeen 里数出 spec 能在背包里找到几个；读不到给 null（不是 0） */
function countInBackpackSeen (bot, state, spec, predicate) {
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return null;                 // 从没打开过/没记录 → 读不到
  const items = Object.entries(seen.items).map(([name, count]) => ({ name, count }));
  if (predicate) return items.filter(predicate).reduce((a, it) => a + it.count, 0);
  const want = fullId(typeof spec === 'function' ? '' : spec);
  return items.filter(it => fullId(it.name) === want).reduce((a, it) => a + it.count, 0);
}

async function ensureCarried (bot, state, spec, count = 1) {
  const predicate = typeof spec === 'function' ? spec : null;
  const want = predicate ? null : fullId(spec);
  const carriedNow = () => predicate
    ? bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0)
    : (invCounts(bot).get(want) || 0);
  const had = carriedNow();
  const inPack = countInBackpackSeen(bot, state, spec, predicate);
  const d = decideCarry({ carried: had, backpack: inPack });
  if (d.action === 'use') return { have: had, got: had, source: 'carried', needed: count };
  if (d.action === 'unknown') {
    return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: d.reason, needed: count };
  }
  if (d.action === 'none') {
    return { have: 0, got: 0, source: 'none', absenceProven: true, why: d.reason, needed: count };
  }
  // 背包里有：真去拿（没背背包的会在这里明确抛）
  let r;
  try {
    r = predicate
      ? await fetchAnyFromBackpack(bot, state, predicate, count)
      : await fetchFromBackpack(bot, state, want, count);
  } catch (e) {
    return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: `背包里有记录，但没拿出来：${e.message}`, needed: count };
  }
  const now = carriedNow();
  if (now <= 0) return { have: 0, got: 0, source: 'unknown', absenceProven: false, why: r?.note || '背包里有记录，但没拿到身上', needed: count };
  return { have: now, got: now, source: 'backpack', fetched: r?.fetched || null, needed: count };
}

/** 按 predicate 从背包里找任意一种拿（燃料、垫脚方块这种"随便哪种都行"的） */
async function fetchAnyFromBackpack (bot, state, predicate, count = 1) {
  const before = bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0);
  await backpackOpen(bot, state);
  const w = bot.currentWindow;
  if (!w || !w.__sophisticated || !w.__sophBoundaryValid || !(w.inventoryStart > 0)) {
    throw new Error('背包界面认不出玩家物品栏边界，不敢从里面拿东西（避免搬错格）');
  }
  let need = count === Infinity ? Infinity : Math.max(1, +count || 1);
  let moved = 0;
  try {
    for (let i = 0; i < w.inventoryStart && need > 0; i++) {
      const it = w.slots[i];
      if (!it || !predicate(it)) continue;
      const n0 = bot.inventory.items().filter(predicate).reduce((a, x) => a + x.count, 0);
      await click(bot, i, 0, 1);
      await sleep(180);
      const n1 = bot.inventory.items().filter(predicate).reduce((a, x) => a + x.count, 0);
      if (n1 > n0) { moved += n1 - n0; need -= n1 - n0; } else if (!w.slots[i]) break;
    }
  } finally {
    noteBackpack(state, w);
    if (bot.currentWindow?.id === w.id) bot.closeWindow(w);
  }
  const gained = bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0) - before;
  if (gained <= 0) return { fetched: {}, took: {}, note: '背包里没有符合条件的东西' };
  return { fetched: { predicate: gained }, took: {}, moved };
}

/** 箱子里有没有能补上这几项的（items 同上） */
function kitAvailable (bot, items, labels, loadout = defaultLoadout()) {
  return labels.filter(label => {
    const L = [...loadout, WEAPON_CHECK].find(x => x.label === label);
    return L && items.some(it => kitMatch(bot, L, it));
  });
}

/** 从一堆物品里挑出装备单要留下的：返回 Map(slotIndex → 要留几个) */
function pickLoadout (bot, entries, loadout) {
  const keep = new Map();
  const add = (e, n) => keep.set(e.slot, (keep.get(e.slot) || 0) + n);
  for (const L of loadout) {
    let pool = entries.filter(e => !keep.has(e.slot));
    pool = pool.filter(e => kitMatch(bot, L, e.item));
    if (L.kind === 'best') pool.sort((a, b) => tierOf(a.item.name) - tierOf(b.item.name));
    else if (L.kind === 'food') pool.sort((a, b) => foodScore(b.item) - foodScore(a.item));
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

/** 同类物品合并到最紧凑状态后真正需要几格；NBT/耐久不同的签名分别计算。 */
function packedSlots (items) {
  const groups = new Map();
  for (const it of items || []) {
    const k = it.identity || stackIdentity(it); const g = groups.get(k) || { count: 0, size: it.stackSize || 64 };
    g.count += it.count || 0; groups.set(k, g);
  }
  let n = 0; for (const g of groups.values()) n += Math.ceil(g.count / g.size);
  return n;
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

// ------------------------------------------------------------------ 探险：把家以外的箱子打包带走

/**
 * 探险时找到的箱子：尽量都装到身上带回家。背包装不下时先拿值钱的
 * （工具装备 → 矿物 → 食物 → 其他 → 方块 → 木头 → 作物种子），拿不完的箱子记下来。
 * 家里的箱子（home 范围内）不碰；exclude 里的位置不碰（比如知道是别人家的）。
 */
const LOOT_ORDER = ['工具装备', '矿物', '食物', '其他', '方块', '木头', '作物种子'];

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

// ------------------------------------------------------------------ 没看过的箱子 / 像玩家一样找矿（不透视）
//
// 主人 2026-09-27：「挖矿不要扫描区域挖，这不是很像矿物透视吗？让她像玩家一样挖矿或者探索矿洞，顺便打开遇到的所有奖励箱子」
//                  「任何时候遇到没见过的箱子、木桶都要看，优先级比较高，视野内出现了箱子就应该寻路过去」
// 所以这里的一切"发现"都只认**视线**（bot.canSeeBlock：眼睛到方块中心的射线第一个碰到的就是它）。

// 看过的箱子存盘：bridge 重启后 seenContainers 就空了，不存的话每次重启她都要把家里的箱子全翻一遍
const SEEN_FILE = require('path').join(__dirname, 'memory', 'containers-seen.json');
function seenKeys (state) {
  if (!state.__seenKeys) {
    try { state.__seenKeys = new Set(JSON.parse(require('fs').readFileSync(SEEN_FILE, 'utf8'))); } catch (_) { state.__seenKeys = new Set(); }
  }
  return state.__seenKeys;
}
function markSeen (state, key) {
  const s = seenKeys(state);
  if (s.has(key)) return;
  s.add(key);
  try { const tmp = SEEN_FILE + '.tmp'; require('fs').writeFileSync(tmp, JSON.stringify([...s])); require('fs').renameSync(tmp, SEEN_FILE); } catch (_) {}
}
const inHomeArea = (home, p) => !!home && Math.hypot(p.x - home.center.x, p.z - home.center.z) <= home.radius && Math.abs(p.y - home.center.y) <= 16;

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

/** 附近没开过的运输矿车箱子（废弃矿井的宝箱在矿车里）。按取整坐标记"开过" */
const cartKey = (e) => `cart@${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`;
function unseenCarts (bot, state, radius = 16) {
  const seen = seenKeys(state);
  return Object.values(bot.entities)
    .filter(e => e?.position && /chest_minecart/.test(e.name || '') && e.position.distanceTo(bot.entity.position) <= radius)
    .filter(e => !seen.has(cartKey(e)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

/** 打开矿车箱子，能拿的都拿（身上留 1 格余量） */
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

const ORE_RE = /(_ore|ancient_debris)$/;
let oreIdsCache = null; let oreIdsRegistry = null;
// 1.20 原版矿石数量最多的高度（分布峰值）；模组矿、没写目标就按铁
const ORE_Y = { coal: 48, copper: 48, iron: 16, lapis: 0, gold: -16, redstone: -58, diamond: -58, emerald: 100 };
const { isHostileEntity } = require('./entity-registry.js');
/**
 * 8 格内有没有威胁：**原版怪按名字、模组怪按仇恨证据** —— 判据只在 entity-registry.js 一处
 * （AGENTS.md §5；以前这里有一份 `HOSTILE_RE`，比战斗本能那份短，模组怪漏了一半）。
 * 传 `state.aggroOf`（bridge 的，战斗本能同一份）：补名后 `type` 仍是 'other' 的模组怪只能靠行为证据认。
 */
function threatNear (bot, state, pos, r = 8) {
  return Object.values(bot.entities).find(e => e !== bot.entity && e.type !== 'player' && e.position && e.position.distanceTo(pos) < r
    && isHostileEntity(e, state?.aggroOf)) || null;
}
const isLiquid = (b) => !!b && /water|lava|bubble_column/.test(b.name);
const airish = (b) => !b || (b.boundingBox === 'empty' && !isLiquid(b));
// 人造方块：挖到这些说明走到别人/自己的建筑里了，不挖（和 bridge 的 isPlayerBuilt 同义的粗判）
const BUILT_RE = /planks|_stairs|_slab|door|glass|brick|wool|carpet|chest|barrel|torch|lantern|ladder|fence|_bed$|crafting_table|furnace/;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

async function digBlock (bot, block) {
  if (airish(block)) return { ok: true };
  if (BUILT_RE.test(block.name)) return { ok: false, why: `前面是 ${block.name}（人造的，不拆）` };
  if (!block.diggable || block.hardness == null || block.hardness < 0) return { ok: false, why: `${block.name} 挖不动` };
  const tool = bot.pathfinder?.bestHarvestTool?.(block);
  if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {});
  const need = block.harvestTools && Object.keys(block.harvestTools).length;
  if (need && !(bot.heldItem && block.harvestTools[bot.heldItem.type])) return { ok: false, needTool: true, why: `${block.name} 要更好的镐子才掉东西` };
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await Promise.race([bot.dig(block, true), sleep(15000).then(() => { throw new Error('挖了 15 秒还没挖掉'); })]);
  await sleep(80);
  const after = bot.blockAt(block.position);
  return after && after.name === block.name ? { ok: false, why: `挖了但 ${block.name} 还在` } : { ok: true, name: block.name };
}

/** 把一格挖空（沙砾会接着往下掉，多挖几次）；挖开会放出岩浆/水就不挖 */
async function clearCell (bot, pos) {
  for (let i = 0; i < 6; i++) {
    const b = bot.blockAt(pos);
    if (airish(b)) return null;
    if (isLiquid(b)) return `(${pos.x},${pos.y},${pos.z}) 是${/lava/.test(b.name) ? '岩浆' : '水'}`;
    const wet = N6.map(([dx, dy, dz]) => bot.blockAt(pos.offset(dx, dy, dz))).find(isLiquid);
    if (wet) return `挖开 (${pos.x},${pos.y},${pos.z}) 会放出${/lava/.test(wet.name) ? '岩浆' : '水'}`;
    const r = await digBlock(bot, b);
    if (!r.ok) return r.why;
  }
  return `(${pos.x},${pos.y},${pos.z}) 挖了好几次还是满的（上面一直掉沙砾？）`;
}

async function stepTo (bot, dest) {
  const { goals } = require('mineflayer-pathfinder');
  try {
    await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(dest.x, dest.y, dest.z)), sleep(6000).then(() => { throw new Error('走不进去'); })]);
  } catch (_) {
    bot.pathfinder.setGoal(null);
    await bot.lookAt(dest.offset(0.5, 1.6, 0.5), true);
    await holdControls(bot, ['forward'], 400);
  }
  const p = bot.entity.position;
  return Math.floor(p.x) === dest.x && Math.floor(p.z) === dest.z && Math.abs(p.y - dest.y) < 1;
}

/** 视野里的矿（想要的在前，其次近的） */
function visibleOres (bot, want, radius, skip) {
  if (oreIdsRegistry !== bot.registry) {
    oreIdsRegistry = bot.registry;
    oreIdsCache = Object.values(bot.registry.blocksByName).filter(b => ORE_RE.test(b.name)).map(b => b.id);
  }
  const ids = oreIdsCache;
  const me = bot.entity.position;
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 })
    .filter(p => !skip.has(doorKey(p)))
    .map(p => bot.blockAt(p)).filter(b => b && bot.canSeeBlock(b))
    .sort((a, b) => ((want && b.name.includes(want)) - (want && a.name.includes(want))) || me.distanceTo(a.position) - me.distanceTo(b.position));
}

const BRANCH = 8;   // 鱼骨支道长度（主道每 3 格一对，支道间隔 2 格实心：1×2 通道两侧各露一格，正好不漏）
const MINES_FILE = require('path').join(__dirname, 'memory', 'mines.json');
function mines (state) {
  if (!state.__mines) { try { state.__mines = JSON.parse(require('fs').readFileSync(MINES_FILE, 'utf8')); } catch (_) { state.__mines = {}; } }
  return state.__mines;
}
function saveMines (state) {
  try { const fs = require('fs'); const tmp = MINES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__mines || {}, null, 1)); fs.renameSync(tmp, MINES_FILE); } catch (_) {}
}

/** y<0 感知：附近的矿（不要求看得见），想要的在前、近的在前 */
function sensedOres (bot, want, radius, skip) {
  if (oreIdsRegistry !== bot.registry) {
    oreIdsRegistry = bot.registry;
    oreIdsCache = Object.values(bot.registry.blocksByName).filter(b => ORE_RE.test(b.name)).map(b => b.id);
  }
  const ids = oreIdsCache;
  const me = bot.entity.position;
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 })
    .filter(p => !skip.has(doorKey(p))).map(p => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => ((want && b.name.includes(want)) - (want && a.name.includes(want))) || me.distanceTo(a.position) - me.distanceTo(b.position));
}

/** 朝一个方块挖 1×2 通道过去（高度差一步一格地上下），直到够得着；不直着往脚下挖，遇水/岩浆就停 */
async function tunnelTo (bot, target, maxSteps = 24) {
  for (let i = 0; i < maxSteps; i++) {
    const t0 = bot.blockAt(target);
    if (eyeDist(bot, t0 || { position: target }) <= REACH) return { ok: true, steps: i };
    const f = bot.entity.position.floored();
    const dx = target.x - f.x; const dz = target.z - f.z; const dy = target.y - f.y;
    const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    if (!sx && !sz) return { ok: false, why: '就在正上/正下方，不直着挖', steps: i };
    const up = dy > 1 ? 1 : dy < -1 ? -1 : 0;
    const dest = f.offset(sx, up, sz);
    const cells = up > 0 ? [f.offset(0, 2, 0), dest.offset(0, 1, 0), dest] : up < 0 ? [f.offset(sx, 1, sz), dest.offset(0, 1, 0), dest] : [dest.offset(0, 1, 0), dest];
    const floor = bot.blockAt(dest.offset(0, -1, 0));
    if (isLiquid(floor)) return { ok: false, why: '前面脚下是液体', steps: i, stop: /lava/.test(floor.name) };
    for (const c of cells) { const why = await clearCell(bot, c); if (why) return { ok: false, why, steps: i, stop: /岩浆/.test(why) }; }
    if (airish(floor)) { const it = fillerItem(bot); if (it) { try { await placeFiller(bot, dest.offset(0, -1, 0)); } catch (_) {} } }
    if (!await stepTo(bot, dest)) return { ok: false, why: `挖开了走不进 (${dest.x},${dest.y},${dest.z})`, steps: i };
  }
  return { ok: false, why: `挖了 ${maxSteps} 步还没到`, steps: maxSteps };
}

/** 在矿洞里：视线里挑一个没去过的落脚点走过去（还没到目标深度就往下走） */
async function caveStep (bot, D, targetY) {
  const me = bot.entity.position.floored();
  const cands = [];
  // 上下只看 3 格以内：以前能挑低 8 格的落脚点，寻路过去就是跳下去（2026-09-27 挖矿时"哎哟 磕到了"）
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let dy = -3; dy <= 3; dy++) {
    if (Math.abs(dx) + Math.abs(dz) < 5) continue;
    const p = me.offset(dx, dy, dz);
    const vk = `${p.x >> 2},${p.y >> 2},${p.z >> 2}`;
    if (D.visited.has(vk)) continue;
    const floor = bot.blockAt(p.offset(0, -1, 0));
    if (!floor || floor.boundingBox !== 'block' || isLiquid(floor)) continue;
    if (!airish(bot.blockAt(p)) || !airish(bot.blockAt(p.offset(0, 1, 0)))) continue;
    const down = me.y > targetY ? -dy : Math.abs(dy) * -0.5;     // 没到深度：越往下越好
    cands.push({ p, floor, score: down * 2 + Math.hypot(dx, dz) * 0.3 + Math.random() });
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 12)) {
    if (!bot.canSeeBlock(c.floor)) continue;
    D.visited.add(`${c.p.x >> 2},${c.p.y >> 2},${c.p.z >> 2}`);
    const err = await pathTo(bot, c.p, 1, 20000, { retry: false });
    if (!err) return { to: { x: c.p.x, y: c.p.y, z: c.p.z } };
  }
  return null;
}

/** 脚边是不是一片开阔的地下空间（矿洞） */
function inCave (bot) {
  const f = bot.entity.position.floored();
  let air = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = 0; dy <= 2; dy++) if (airish(bot.blockAt(f.offset(dx, dy, dz)))) air++;
  const sky = bot.blockAt(f)?.skyLight;
  return air > 60 && !(sky > 0);
}

/**
 * 像玩家一样找矿：
 *   还没到目标深度 → 朝一个方向挖楼梯往下（每步挖前方 3 格高，走下去；从不直着往脚下挖）
 *   到了深度 → 挖 1×2 的矿道往前
 *   挖穿了洞、或本来就在矿洞里 → 沿视线里没去过的地方逛，往下找
 *   一路上：看得见的矿挖掉，看得见的没开过的箱子走过去开（家外的拿走）
 *   每 8 步插一个火把；挖开会放出岩浆/水就换方向；血少、怪近、背包满就停下交还给她
 */
async function delve (bot, state, { target = null, targetY = null, maxMs = 120000, home = null, torchEvery = 8 } = {}) {
  const t0 = Date.now();
  const want = target ? String(target).replace(/^.*:/, '').replace(/^deepslate_/, '').replace(/_ore$/, '') : null;
  const ty = targetY != null ? +targetY : (ORE_Y[Object.keys(ORE_Y).find(k => want?.includes(k))] ?? 16);
  // 矿洞存盘（memory/mines.json）：以前方向、进度只在内存里，重启就忘，下次在原地另挖一条楼梯。
  // 现在在一个老矿洞附近（入口或上次停下的地方 48 格内）就接着它：先走回上次停下的地方，按原方向接着挖
  const here = bot.entity.position;
  const near = (a, r) => a && Math.hypot(a.x - here.x, a.z - here.z) <= r;
  let D = state.delve && state.delve.last && here.distanceTo(state.delve.last) < 32 ? state.delve : null;
  let resumed = false;
  if (!D) {
    const old = Object.values(mines(state)).filter(m => near(m.last, 48) || near(m.entry, 48))
      .sort((a, b) => Math.hypot(a.last.x - here.x, a.last.z - here.z) - Math.hypot(b.last.x - here.x, b.last.z - here.z))[0];
    if (old) { D = state.delve = { ...old, visited: new Set(), last: new Vec3(old.last.x, old.last.y, old.last.z) }; resumed = true; }
    else D = state.delve = { heading: null, visited: new Set(), steps: 0, last: null, entry: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, deepest: Math.floor(here.y) };
  }
  if (!resumed && inHomeArea(home, bot.entity.position)) throw new Error(`在家附近（离家中心 ${home.radius} 格内）不往下挖 —— 先走远一点再挖`);
  if (resumed && here.distanceTo(D.last) > 4) {
    const err = await pathTo(bot, D.last, 1, 90000);
    if (err && bot.entity.position.distanceTo(D.last) > 6) throw new Error(`想回上次挖到的地方 (${D.last.x},${D.last.y},${D.last.z}) 没走到：${err}`);
  }
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  if (!D.heading) { const yaw = bot.entity.yaw; const vx = -Math.sin(yaw); const vz = -Math.cos(yaw); D.heading = Math.abs(vx) > Math.abs(vz) ? [Math.sign(vx), 0] : [0, Math.sign(vz)]; }
  // 下矿先备火把（主人：真要去暗处，就带着火把把那里点亮）
  const prep = await makeTorches(bot, 16);
  if (!prep.torches) throw new Error(`没带火把，不下去（${prep.note || '做不出来'}）—— 先弄点煤/木炭做火把（煤/木炭 + 木棍 → 4 个火把）`);
  const invBefore = invCounts(bot);
  const oreSkip = new Set(); const oreAttempts = new Map(); const chests = []; const log = []; let reason = null; let turns = 0; let caveMoves = 0; let dug = 0;
  const y0 = bot.entity.position.y;

  while (Date.now() - t0 < maxMs) {
    D.last = bot.entity.position.clone(); D.deepest = Math.min(D.deepest ?? 999, Math.floor(D.last.y));
    if (bot.health < 8) { reason = `血只剩 ${Math.round(bot.health)}`; break; }
    const mob = threatNear(bot, state, bot.entity.position);
    if (mob) { reason = `${mob.name} 在 ${mob.position.distanceTo(bot.entity.position).toFixed(0)} 格外`; break; }
    if (bot.inventory.emptySlotCount() <= 1) { reason = '背包快满了'; break; }

    // 1. 视野里没开过的箱子（主人说优先级高）
    if (unseenChests(bot, state, 24).length) { chests.push(...await checkChests(bot, state, { home, max: 2 })); continue; }

    // 2. 视野里的矿；y<0 的深层还能感知附近 12 格内看不见的矿（主人 2026-09-27 允许），挖通道过去
    const deep = bot.entity.position.y < 0;
    const ore = visibleOres(bot, want, 16, oreSkip)[0] || (deep ? sensedOres(bot, want, 16, oreSkip)[0] : null);
    if (ore) {
      const oreKey = doorKey(ore.position);
      if (eyeDist(bot, ore) > REACH) await pathTo(bot, ore.position, 3, 15000, { retry: false });
      if (eyeDist(bot, ore) > REACH && deep) { const t = await tunnelTo(bot, ore.position, 24, state); log.push(t.ok ? `挖了 ${t.steps} 步通道到 ${ore.name}` : `挖不到 ${ore.name}：${t.why}`); if (t.stop) { reason = t.why; break; } }
      if (eyeDist(bot, ore) <= REACH + 0.3) {
        const wet = N6.map(([dx, dy, dz]) => bot.blockAt(ore.position.offset(dx, dy, dz))).find(isLiquid);
        if (wet) { log.push(`${ore.name} 旁边有${/lava/.test(wet.name) ? '岩浆' : '水'}，没挖`); oreSkip.add(oreKey); continue; }
        const r = await digBlock(bot, ore).catch(e => ({ ok: false, why: e.message }));
        if (r.ok) { dug++; oreAttempts.delete(oreKey); await collectDrops(bot, 5); if (/coal/.test(ore.name) && torchCount(bot) < 16) await makeTorches(bot, 16, state); }
        else { log.push(r.why); const tries = (oreAttempts.get(oreKey) || 0) + 1; oreAttempts.set(oreKey, tries); if (tries >= 2) oreSkip.add(oreKey); if (r.needTool) { reason = r.why; break; } }
      } else {
        const tries = (oreAttempts.get(oreKey) || 0) + 1;
        oreAttempts.set(oreKey, tries);
        if (tries >= 2) oreSkip.add(oreKey);
      }
      continue;
    }

    // 3. 在矿洞里：逛
    if (inCave(bot) && caveMoves < 12) {
      const m = await caveStep(bot, D, ty);
      if (m) { caveMoves++; log.push(`矿洞里走到 (${m.to.x},${m.to.y},${m.to.z})`); const lu = await lightUp(bot); if (lu.placed) log.push('矿洞里插了个火把'); continue; }
    }

    // 4. 挖楼梯往下 / 挖矿道往前（到了深度用鱼骨：主道每 3 格向左、向右各挖一条 BRANCH 格的支道，再回主道）
    //    主人 2026-09-27 问"挖矿方法是什么"：以前到深度后只一条直道，两侧各只露一格墙，效率低
    const f = bot.entity.position.floored();
    const goingDown = f.y > ty;
    const idxOf = (h) => DIRS.findIndex(d => d[0] === h[0] && d[1] === h[1]);
    if (!goingDown) {
      D.fb ||= { main: D.heading, phase: 'main', since: 0, len: 0, anchor: null, branches: 0 };
      const mi = idxOf(D.fb.main);
      D.heading = D.fb.phase === 'L' ? DIRS[(mi + 3) % 4] : D.fb.phase === 'R' ? DIRS[(mi + 1) % 4] : D.fb.main;
    }
    const endBranch = async () => {   // 支道挖完/挖不动：回到主道分叉处，换另一侧或接着挖主道
      const a = D.fb.anchor;
      if (a) await pathTo(bot, new Vec3(a.x, a.y, a.z), 0.6, 20000, { retry: false });
      if (D.fb.phase === 'L') { D.fb.phase = 'R'; D.fb.len = 0; } else { D.fb.phase = 'main'; D.fb.branches++; }
    };
    const [dx, dz] = D.heading;
    const cells = goingDown ? [f.offset(dx, 1, dz), f.offset(dx, 0, dz), f.offset(dx, -1, dz)] : [f.offset(dx, 1, dz), f.offset(dx, 0, dz)];
    const dest = goingDown ? f.offset(dx, -1, dz) : f.offset(dx, 0, dz);
    const floor = bot.blockAt(dest.offset(0, -1, 0));
    let why = null;
    if (isLiquid(floor)) why = `前面脚下是${/lava/.test(floor.name) ? '岩浆' : '水'}`;
    else if (airish(floor)) {
      // 前面脚下是空的：挖穿到洞里了。身上有圆石/泥土就垫一块接着走（像玩家搭路），不往下掉；
      // 以前坑不到 4 格就直接走下去 = 掉 1–3 格
      let depth = 1; while (depth < 6 && airish(bot.blockAt(dest.offset(0, -1 - depth, 0)))) depth++;
      let bridged = false;
      if (await ensureFiller(bot, state)) { try { bridged = await placeFiller(bot, dest.offset(0, -1, 0), state); } catch (_) {} }
      if (!bridged) depth = Math.max(depth, 4);   // 垫不上：当成坑，不走下去
      if (depth >= 4 && !bridged) {
        for (const c of cells) { why = await clearCell(bot, c); if (why) break; }   // 开个口看看下面
        const m = !why && await caveStep(bot, D, ty);
        if (m) { caveMoves++; log.push(`挖穿到矿洞，走到 (${m.to.x},${m.to.y},${m.to.z})`); continue; }
        why = why || `前面是 ${depth}+ 格深的坑，下不去`;
      }
    }
    if (!why) for (const c of cells) { why = await clearCell(bot, c); if (why) break; }
    if (!why && !await stepTo(bot, dest)) why = `挖开了但走不进 (${dest.x},${dest.y},${dest.z})`;
    if (why) {
      log.push(why);
      if (/镐子/.test(why)) { reason = why; break; }
      if (!goingDown && D.fb && D.fb.phase !== 'main') { await endBranch(); continue; }   // 支道挖不动：提前收这条
      D.heading = DIRS[(DIRS.findIndex(d => d[0] === dx && d[1] === dz) + 1 + (turns % 2) * 2) % 4];   // 右转，再不行掉头
      if (!goingDown && D.fb) D.fb.main = D.heading;
      if (++turns >= 4) { reason = `四个方向都挖不下去：${why}`; break; }
      continue;
    }
    turns = 0; D.steps++;
    D.visited.add(`${dest.x >> 2},${dest.y >> 2},${dest.z >> 2}`);
    if (!goingDown && D.fb) {
      if (D.fb.phase === 'main') {
        if (++D.fb.since >= 3) { D.fb.since = 0; D.fb.phase = 'L'; D.fb.len = 0; D.fb.anchor = { x: dest.x, y: dest.y, z: dest.z }; }
      } else if (++D.fb.len >= BRANCH) { await endBranch(); }
    }
    // 脚下暗了就插（读不到亮度时每 torchEvery 步插一个）
    if (!nearestLight(bot, torchEvery)) { if (await placeTorchHere(bot)) log.push('插了个火把'); }   // 身边 8 格没光源才插
    // 火把也可能在精妙背包里：先补到身上再判"用完了"（否则会误报、白跑一趟回去拿）
    if (!torchItem(bot) && state) await ensureCarried(bot, state, TORCH_SPEC, 1);
    if (!torchItem(bot)) { reason = '火把用完了，别再往暗处挖 —— 回去补火把'; break; }
  }
  if (!reason) reason = `时间到（${Math.round((Date.now() - t0) / 1000)} 秒），可以接着挖`;
  {
    const f = bot.entity.position.floored();
    D.last = bot.entity.position.clone(); D.deepest = Math.min(D.deepest ?? f.y, f.y);
    if (D.entry) { mines(state)[`${D.entry.x},${D.entry.y},${D.entry.z}`] = { entry: D.entry, last: { x: f.x, y: f.y, z: f.z }, heading: D.fb ? D.fb.main : D.heading, fb: D.fb || null, steps: D.steps, deepest: D.deepest, updated: Date.now() }; saveMines(state); }
  }
  const d = delta(invBefore, invCounts(bot));
  const p = bot.entity.position;
  return {
    ok: true, reason, at: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, fromY: Math.floor(y0), targetY: ty,
    entry: D.entry, deepest: D.deepest, resumed,
    method: D.fb ? `鱼骨：主道朝 ${['北', '东', '南', '西'][DIRS.findIndex(d => d[0] === D.fb.main[0] && d[1] === D.fb.main[1])]}，已挖 ${D.fb.branches} 对支道，现在在${D.fb.phase === 'main' ? '主道' : D.fb.phase === 'L' ? '左支道' : '右支道'}` : '挖楼梯往下',
    heading: D.heading, steps: D.steps, oresDug: dug, torchesLeft: torchCount(bot), gained: d.gained, chests: chests.length ? chests : undefined, log: log.slice(-8),
  };
}

// ------------------------------------------------------------------ 亮度 / 火把 / 垫方块自救
//
// 主人 2026-09-27：「应该像玩家一样避免前往暗处，如果真要去，就应该带着火把点亮那里。然后应该会搭方块自救（家里以外的地方）」

/** 脚下那格的亮度：block = 方块光（火把等），sky = 天空光（露天白天 15）；读不到给 null */
function lightAt (bot, pos = bot.entity.position.floored()) {
  const b = bot.blockAt(pos);
  if (!b || b.light == null) return null;
  return { block: b.light, sky: b.skyLight ?? null };
}
// 怪物在方块光 0 的地方刷；地下没天空光，方块光 < 8 就算暗（留余量）
const isDark = (l) => !!l && l.block < 8 && !(l.sky > 7);

// 火把的判据只有这一处（fullId 后精确比 `torch`）—— 身上的和背包里的都算（见 ensureCarried）
const TORCH_RE = /(^|:)torch$/;
const TORCH_SPEC = (it) => TORCH_RE.test(fullId(it.name));

const torchItem = (bot) => bot.inventory.items().find(i => TORCH_RE.test(i.name));
const torchCount = (bot) => bot.inventory.items().filter(i => TORCH_RE.test(i.name)).reduce((a, i) => a + i.count, 0);
const plainTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`超时 ${ms}ms`); })]);

/**
 * 火把不够就用身上的煤/木炭 + 木棍做（背包 2×2 就能做）。
 * 主人 2026-09-28：火把/煤/木板都可能躺在精妙背包里 —— 先按"随身物品"补齐（身上没有就从背包拿），
 * 不能因为"手里没有"就判"没有燃料"（N-9 日志里的 `没有燃料` ×5）。
 */
async function makeTorches (bot, want = 8, state = null) {
  if (state) await ensureCarried(bot, state, TORCH_SPEC, want);   // 背包里有火把就先拿出来
  const have = torchCount(bot);
  if (have >= want) return { torches: have };
  const count = (re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((a, i) => a + i.count, 0);
  const COAL_RE = /(^|:)(coal|charcoal)$/;
  // 煤/木炭不够 → 从背包拿（燃料可能在背包里）
  if (state && !count(COAL_RE)) await ensureCarried(bot, state, (it) => COAL_RE.test(fullId(it.name)), 1);
  const fuel = count(COAL_RE);
  if (!fuel) return { torches: have, note: '没有煤/木炭' };
  const times = Math.min(fuel, Math.ceil((want - have) / 4));
  // 木棍不够：木板做木棍（木板也不够就先把原木劈成木板）—— 玩家也是顺手这么做的
  // 木板 / 原木也可能在背包里：做之前先把它们拿到身上
  if (count(/(^|:)stick$/) < times) {
    if (state && count(/_planks$/) < 2) await ensureCarried(bot, state, (it) => /_planks$/.test(fullId(it.name)), 2);
    if (state && !count(/_log$/)) await ensureCarried(bot, state, (it) => /_log$/.test(fullId(it.name)) && !/stripped/.test(it.name), 1);
    try {
      if (count(/_planks$/) < 2) await craft2(bot, { itemName: bot.inventory.items().find(i => /_log$/.test(i.name) && !/stripped/.test(i.name))?.name.replace(/_log$/, '_planks') || 'minecraft:oak_planks', count: 4 }, plainTimeout);
      await craft2(bot, { itemName: 'minecraft:stick', count: Math.max(4, times) }, plainTimeout);
    } catch (e) { return { torches: have, note: `缺木棍，做木棍没成：${e.message}` }; }
  }
  try { await craft2(bot, { itemName: 'minecraft:torch', count: times * 4 }, plainTimeout); } catch (e) { return { torches: torchCount(bot), note: `做火把没成：${e.message}` }; }
  return { torches: torchCount(bot), made: torchCount(bot) - have };
}

/** 在脚边插一个火把（地上，或者旁边的墙上） */
async function placeTorchHere (bot) {
  const t = torchItem(bot);
  if (!t) return false;
  const f = bot.entity.position.floored();
  try {
    await bot.equip(t, 'hand');
    const under = bot.blockAt(f.offset(0, -1, 0));
    if (under && under.boundingBox === 'block') { await plainTimeout(bot.placeBlock(under, new Vec3(0, 1, 0)), 5000); return true; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wall = bot.blockAt(f.offset(dx, 1, dz));
      if (wall && wall.boundingBox === 'block') { await plainTimeout(bot.placeBlock(wall, new Vec3(-dx, 0, -dz)), 5000); return true; }
    }
  } catch (_) {}
  return false;
}

/** 身边 r 格内最近的光源（火把、灯…），没有给 null */
const LIGHT_RE = /torch|lantern|campfire|glowstone|sea_lantern|shroomlight|froglight|jack_o_lantern|redstone_lamp|end_rod|candle/;
let lightIdsCache = null; let lightIdsRegistry = null;
function nearestLight (bot, r = 7) {
  if (lightIdsRegistry !== bot.registry) {
    lightIdsRegistry = bot.registry;
    lightIdsCache = Object.values(bot.registry.blocksByName).filter(b => LIGHT_RE.test(b.name) && !/redstone_torch/.test(b.name)).map(b => b.id);
  }
  const ids = lightIdsCache;
  const p = bot.findBlock({ matching: ids, maxDistance: r });
  return p ? { name: p.name, at: doorKey(p.position), distance: +p.position.distanceTo(bot.entity.position).toFixed(1) } : null;
}

/**
 * 点亮身边：像玩家一样按间距插 —— 身边 7 格内已经有光源就不插；没有就插一个，插完就停。
 * 以前按亮度判断：矿道口照得到天光（天空光 11）就判"够亮"一根不插；她觉得不对就换着工具反复插，
 * 主人说"也不用一直插吧"（2026-09-27）。亮度读数还有延迟，插完马上读仍是暗，一次会连插好几个。
 */
async function lightUp (bot, { max = 1, force = false, spacing = 7, state = null } = {}) {
  let placed = 0;
  const near = nearestLight(bot, spacing);
  if (near && !force) return { placed: 0, alreadyLit: near, torchesLeft: torchCount(bot), note: `${spacing} 格内已经有光源，不用再插` };
  if (state && !torchItem(bot)) await ensureCarried(bot, state, TORCH_SPEC, Math.max(1, max));   // 火把在背包里就先拿出来
  for (let i = 0; i < Math.min(max, 3); i++) {
    if (!torchItem(bot)) break;
    if (!await placeTorchHere(bot)) break;
    placed++;
    if (i + 1 < max) { const moved = nearestLight(bot, spacing); if (moved) break; }   // 插一个就够照这片
  }
  return { placed, torchesLeft: torchCount(bot) };
}

// 垫脚/堵洞用的方块：不值钱、不会掉（沙子砂砾会塌，不用）
const FILLER_RE = /(^|:)(cobblestone|cobbled_deepslate|dirt|coarse_dirt|granite|diorite|andesite|netherrack|tuff|calcite|stone|deepslate|blackstone|basalt|end_stone|mossy_cobblestone|cobbled_\w+)$/;
const isFiller = (name) => FILLER_RE.test(fullId(name)) || scaffoldIds().includes(fullId(name));   // 和搭脚方块同一份名单（含草方块、模组泥土石头）
const fillerItem = (bot) => bot.inventory.items().filter(i => isFiller(i.name)).sort((a, b) => b.count - a.count)[0]
  || bot.inventory.items().find(i => /_planks$/.test(i.name));

/**
 * 垫脚方块也可能在精妙背包里（N-9）—— 身上没有就从背包拿一把。
 * 拿的是 `isFiller` 认可的任意一种（含模组泥土石头、草方块）。
 */
async function ensureFiller (bot, state, want = Infinity) {
  if (!state || fillerItem(bot)) return fillerItem(bot);
  await ensureCarried(bot, state, (it) => isFiller(it.name), want);
  // 木板也算能垫（placeFiller 的兜底名单）：上面拿不到时再试木板
  if (!fillerItem(bot)) await ensureCarried(bot, state, (it) => /_planks$/.test(fullId(it.name)), want === Infinity ? 16 : want);
  return fillerItem(bot);
}

/** 在 pos 放一个垫的方块（找旁边任意一个实心面贴上去） */
async function placeFiller (bot, pos, state = null) {
  if (!airish(bot.blockAt(pos))) return true;
  const it = state ? await ensureFiller(bot, state) : fillerItem(bot);
  if (!it) throw new Error('身上没有能垫的方块（圆石/泥土/花岗岩…）');
  await bot.equip(it, 'hand');
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (ref && ref.boundingBox === 'block') {
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true; } catch (_) {}
    }
  }
  return false;
}

/**
 * 垫方块自救（家外）：
 *   mode=pillar  原地往上垫 height 格（跳起来往脚下放）—— 甩开僵尸/蜘蛛以外的近战怪、从坑里爬出来
 *   mode=enclose 把自己四面两层 + 头顶都堵上（夜里在野外、打不过又跑不掉时）
 */
async function selfRescue (bot, state, { mode = 'pillar', height = 3, home = null } = {}) {
  if (inHomeArea(home, bot.entity.position)) throw new Error('在家里，不往家里乱垫方块 —— 回屋关门就好');
  if (!await ensureFiller(bot, state)) throw new Error('身上没有能垫的方块（圆石/泥土/花岗岩…），先挖点');
  const log = []; const y0 = bot.entity.position.y;
  bot.pathfinder?.setGoal(null); bot.clearControlStates();
  if (mode === 'enclose') {
    const f = bot.entity.position.floored();
    let n = 0;
    const cells = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push(f.offset(dx, 0, dz), f.offset(dx, 1, dz));
    cells.push(f.offset(0, 2, 0));
    for (const c of cells) { try { if (airish(bot.blockAt(c)) && await placeFiller(bot, c, state)) n++; } catch (e) { log.push(e.message); break; } }
    const open = cells.filter(c => airish(bot.blockAt(c))).length;
    if (open === 0) await lightUp(bot, { max: 1, state });
    return { ok: open === 0, mode, placed: n, stillOpen: open, log };
  }
  let up = 0;
  for (let i = 0; i < Math.min(Math.max(1, height), 8); i++) {
    const f = bot.entity.position.floored();
    if (!airish(bot.blockAt(f.offset(0, 2, 0)))) { log.push('头顶被挡住了'); break; }
    const it = await ensureFiller(bot, state);
    if (!it) { log.push('垫的方块用完了'); break; }
    await bot.equip(it, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.setControlState('jump', true);
    const t = Date.now();
    while (bot.entity.position.y < f.y + 1.05 && Date.now() - t < 900) await sleep(20);
    bot.setControlState('jump', false);
    const under = bot.blockAt(f.offset(0, -1, 0));
    try { await bot.placeBlock(under, new Vec3(0, 1, 0)); up++; } catch (e) { log.push(`没垫上：${e.message}`); break; }
    await sleep(300);
  }
  return { ok: up > 0, mode, raised: +(bot.entity.position.y - y0).toFixed(1), blocks: up, log };
}


/** 从命令树原始字节里挖"字面量节点"的名字（flags 低两位=1 → 子节点数 → 子节点号 → (重定向) → 名字）。
 *  协议层改成了原样收字节（模组参数类型解析不了），所以不做完整解析，只认字面量 */
function commandWords (bot) {
  const b = bot._client.__cmdRaw; if (!b) return null;
  const words = new Set();
  const rv = (o) => { let n = 0, sh = 0, x; do { if (o.i >= b.length || sh > 28) throw 0; x = b[o.i++]; n |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80); return n; };
  for (let i = 0; i < b.length - 3; i++) {
    const f = b[i]; if ((f & 3) !== 1 || f > 0x1f) continue;
    try {
      const o = { i: i + 1 }; const nc = rv(o); if (nc > 300) continue;
      for (let k = 0; k < nc; k++) rv(o);
      if (f & 8) rv(o);
      const len = rv(o); if (len < 2 || len > 32 || o.i + len > b.length) continue;
      const name = b.subarray(o.i, o.i + len).toString('latin1');
      if (/^[a-z][a-z0-9_-]*$/.test(name)) words.add(name);
    } catch (_) {}
  }
  return words;
}

// 管理员命令：只有玩家明确要求时才用（主人 2026-09-27）。其余（回家、传送请求…）她自己判断
const ADMIN_CMDS = new Set(['give', 'tp', 'teleport', 'gamemode', 'time', 'weather', 'effect', 'kill', 'summon', 'setblock', 'fill', 'clear', 'enchant', 'xp', 'experience', 'difficulty', 'gamerule', 'op', 'deop', 'ban', 'kick', 'whitelist', 'stop', 'item', 'attribute', 'spreadplayers', 'setworldspawn', 'spawnpoint', 'worldborder', 'data', 'execute', 'function', 'reload', 'forge', 'kubejs', 'ftbquests', 'tpx', 'invsee', 'heal', 'feed', 'fly', 'god']);
const NEVER_CMDS = new Set(['stop', 'op', 'deop', 'ban', 'ban-ip', 'pardon', 'kick', 'whitelist', 'reload', 'save-off', 'debug', 'forceload']);

/**
 * 执行一条命令。管理员命令要带 because = 玩家的原话，而且最近聊天里真有玩家说过这句。
 * 例外只有一个（主人 2026-09-27："也可以 /tp 回到之前坐标"）：**本能**把她自己传回她去过的坐标 ——
 * 只认 `tp <x> <y> <z>`（传自己、纯坐标），而且要带 selfTp（一个函数：只有进程内调用传得进来，HTTP 的 JSON 传不了）。
 */
const SELF_TP_RE = /^tp\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/i;
async function runCommand (bot, state, { command, because, selfTp } = {}) {
  const cmd = String(command || '').trim().replace(/^\/+/, '');
  if (!cmd) throw new Error('command 要写命令，比如 home、tpa Ka_sum1');
  const head = cmd.split(/\s+/)[0].toLowerCase().replace(/^minecraft:/, '');
  if (NEVER_CMDS.has(head)) throw new Error(`/${head} 不归你用`);
  const words = commandWords(bot);
  if (words && !words.has(head)) throw new Error(`服务器没给你 /${head} 这个命令（你能用的：${[...words].filter(w => w.length < 12).slice(0, 40).join(' ')}…）`);
  const trustedSelfTp = typeof selfTp === 'function' && selfTp() === 'self-tp' && SELF_TP_RE.test(cmd);
  if (ADMIN_CMDS.has(head) && !trustedSelfTp) {
    const said = String(because || '').trim();
    const me = bot.username;
    // 聊天缓冲（bridge 的 chatlog：{t, position, text}）里 10 分钟内、不是她自己说的那条要包含这句原话
    const recent = (state.chatlog || []).filter(m => Date.now() - m.t < 10 * 60 * 1000);
    const heard = said.length >= 2 && recent.some(m => { const t = String(m.text || ''); return m.position !== 'bridge' && !t.includes(`<${me}>`) && !t.startsWith(me) && t.includes(said); });
    if (!heard) throw new Error(`/${head} 是管理员命令：只有玩家明确要你用才行 —— because 写他的原话（最近聊天里要真有这句）`);
  }
  const t0 = Date.now();
  bot.chat('/' + cmd);
  await sleep(1200);
  const replies = (state.chatlog || []).filter(m => m.t >= t0).map(m => String(m.text || '')).filter(Boolean).slice(-4);
  return { ran: '/' + cmd, serverSaid: replies };
}

// ------------------------------------------------------------------ 看清一片地方的布局（审美用）
//
// 主人 2026-09-27：「她应该有自己的审美思考，放置任何东西之前先选好位置」。
// 以前她只有"附近有哪些方块"的清单和 7×7 的小地图，看不出房子轮廓、墙面、走道、灯的分布。
// 这里给一片区域（默认 15×15、脚下 2 层到头上 5 层）逐层俯视图：每种材质一个字母（看得出配色），
// 门/梯子/光源/水固定符号；再列出家具、光源、暗处（会刷怪的地面）、空着能站的地面。

const FIXED_CH = [
  [/(^|:)(air|cave_air|void_air)$/, '.'], [/lava/, '!'], [/water|bubble_column/, '~'],
  [/torch|lantern|campfire|candle|glowstone|sea_lantern|shroomlight|froglight/, 'i'],
  [/ladder|scaffolding/, 'H'],
];
function surveyChar (b, dyn) {
  if (!b) return '?';
  for (const [re, ch] of FIXED_CH) if (re.test(b.name)) return ch;
  if (isDoorLike(b)) {
    const open = isOpen(b);
    if (/trapdoor|hatch/.test(b.name)) return open ? 't' : 'T';
    if (/gate/.test(b.name)) return open ? 'g' : 'G';
    return open ? 'd' : 'D';
  }
  if (!dyn.has(b.name)) {
    const pool = 'ABCEFIJKLMNOPQRSUVWXYZabcefhjklmnopqrsuvwxyz0123456789#$%&*+=^';
    dyn.set(b.name, pool[dyn.size] || '?');
  }
  return dyn.get(b.name);
}
const FURNITURE_RE = /chest|barrel|shulker|_bed$|crafting_table|furnace|smoker|anvil|enchanting|brewing|lectern|loom|stonecutter|grindstone|smithing|cartography|fletching|composter|bookshelf|cauldron|jukebox|note_block|flower_pot|painting|item_frame|stove|cooking_pot|skillet|cutting_board|keg|fridge|freezer|cabinet|counter|table|chair|sofa|shelf|crate|drawer|waystone/;

function survey (bot, { x, y, z, r = 7, below = 2, above = 5 } = {}) {
  const c = x != null ? new Vec3(Math.floor(+x), Math.floor(+y), Math.floor(+z)) : bot.entity.position.floored();
  r = Math.min(Math.max(3, +r || 7), 12);
  const me = bot.entity.position.floored();
  const dyn = new Map(); const layers = []; const furniture = []; const lights = []; const dark = []; const freeFloor = []; const doors = [];
  for (let dy = +above; dy >= -below; dy--) {
    const yy = c.y + dy; const rows = [];
    for (let dz = -r; dz <= r; dz++) {
      let row = '';
      for (let dx = -r; dx <= r; dx++) {
        const p = new Vec3(c.x + dx, yy, c.z + dz);
        const b = bot.blockAt(p);
        if (me.x === p.x && me.z === p.z && (me.y === yy || me.y + 1 === yy)) { row += '@'; continue; }
        const ch = surveyChar(b, dyn); row += ch;
        if (!b) continue;
        const at = `${p.x},${p.y},${p.z}`;
        if (ch === 'i') lights.push(`${b.name.replace(/^minecraft:/, '')}(${at})`);
        else if (FURNITURE_RE.test(b.name)) furniture.push(`${b.name.replace(/^minecraft:/, '')}(${at})`);
        if (isDoorLike(b) && !/trapdoor/.test(b.name)) doors.push(`${b.name.replace(/^.*:/, '')}(${at})`);
        // 地面格：脚下实心、这格和头上是空的
        if (ch === '.' && dy <= 1) {
          const under = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
          if (under && under.boundingBox === 'block' && head && head.boundingBox === 'empty') {
            freeFloor.push(at);
            if (b.light != null && b.light < 1 && !(b.skyLight > 7)) dark.push(at);
          }
        }
      }
      rows.push(row);
    }
    // 整层都是空气就不列
    if (rows.every(rw => /^[.@]*$/.test(rw))) continue;
    layers.push(`y=${yy}${yy === c.y ? '（中心层）' : ''}\n${rows.join('\n')}`);
  }
  const legend = [...dyn.entries()].map(([n, ch]) => `${ch}=${n.replace(/^minecraft:/, '')}`).join(' ');
  const uniq = (a) => [...new Set(a)];
  // 要留空的格子（路）：门前后、梯子上下口、1 格宽的走道。放东西绝不能占（实测箱子堵了路，2026-09-27）
  const free = new Set(freeFloor);
  const keepClear = new Set();
  const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -below; dy <= above; dy++) {
    const p = new Vec3(c.x + dx, c.y + dy, c.z + dz); const b = bot.blockAt(p); if (!b) continue;
    if ((isDoorLike(b) && !/trapdoor/.test(b.name)) || /ladder/.test(b.name)) {
      for (const [ax, az] of H4) for (const k of [1, 2]) for (const yy of [0, 1, -1]) { const q = `${p.x + ax * k},${p.y + yy},${p.z + az * k}`; if (free.has(q)) keepClear.add(q); }
      for (const yy of [1, -1]) { const q = `${p.x},${p.y + yy},${p.z}`; if (free.has(q)) keepClear.add(q); }
    }
  }
  for (const at of freeFloor) {
    const [x0, y0, z0] = at.split(',').map(Number);
    const n = H4.map(([ax, az]) => free.has(`${x0 + ax},${y0},${z0 + az}`));
    const cnt = n.filter(Boolean).length;
    if (cnt === 2 && ((n[0] && n[1]) || (n[2] && n[3]))) keepClear.add(at);   // 两边是墙、前后通：走道
  }
  return {
    center: { x: c.x, y: c.y, z: c.z }, r,
    orientation: `每层俯视：从上到下是 z=${c.z - r}..${c.z + r}（北→南），从左到右是 x=${c.x - r}..${c.x + r}（西→东）`,
    fixed: '. 空气  @ 你  i 光源  H 梯子  D/d 门(关/开)  T/t 活板门  G/g 栅栏门  ~ 水  ! 岩浆  ? 没加载',
    legend,
    layers: layers.join('\n\n'),
    doors: uniq(doors).slice(0, 12), lights: uniq(lights).slice(0, 20), furniture: uniq(furniture).slice(0, 30),
    darkFloor: dark.slice(0, 20), darkCount: dark.length, freeFloorCount: freeFloor.length,
    keepClear: [...keepClear].slice(0, 60), keepClearCount: keepClear.size,
  };
}

// ------------------------------------------------------------------ 工程：按蓝图一点点盖 / 挖（不必等材料齐）
//
// 主人 2026-09-27：「自己对周围环境概念建模之后，慢慢逐步增量填充或者挖多余方块。并且不一定要材料够了才开始行动」
// 蓝图（她自己设计的）存盘；每次 work：对照蓝图和世界 → 多余的从上往下挖、缺的从下往上补（有支撑的先放），
// 手上有什么先放什么，缺的报回去让她去弄；一次只干一小段，随时能被打断，下次接着来。
//
// 蓝图格式：{ id, name, purpose, origin:{x,y,z}, legend:{ 字符: 方块id | "air" }, layers:[{ dy, rows:[ "..." ] }] }
//   rows 从北到南（z 增），每行从西到东（x 增）；图例里没有的字符（空格、-）= 这格不管。
// 限制：楼梯/门这类有朝向的方块，放下来的朝向由她当时的站位决定，不一定和设计一致。

const PROJ_FILE = require('path').join(__dirname, 'memory', 'projects.json');
function projects (state) {
  if (!state.__projects) { try { state.__projects = JSON.parse(require('fs').readFileSync(PROJ_FILE, 'utf8')); } catch (_) { state.__projects = {}; } }
  return state.__projects;
}
function saveProjects (state) {
  try { const fs = require('fs'); const tmp = PROJ_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__projects || {}, null, 1)); fs.renameSync(tmp, PROJ_FILE); } catch (_) {}
}
const bareId = (id) => String(id || '').replace(/^minecraft:/, '');

/** 检查蓝图、存下来。返回格数和材料清单；图例里的方块不存在就报错（让她改） */
function projectSave (bot, state, bp = {}) {
  if (!bp.name || !bp.origin || !bp.legend || !Array.isArray(bp.layers)) throw new Error('蓝图要有 name、origin{x,y,z}、legend、layers[{dy,rows}]');
  const bad = Object.entries(bp.legend).filter(([, id]) => id !== 'air' && !bot.registry.blocksByName[bareId(id)] && !bot.registry.blocksByName[id]).map(([ch, id]) => `${ch}=${id}`);
  if (bad.length) throw new Error(`图例里这些方块不存在：${bad.join(' ')}（用真实注册名）`);
  let cells = 0; const mats = {};
  for (const L of bp.layers) {
    if (!Array.isArray(L.rows)) throw new Error('每层要有 rows');
    if (L.rows.length > 24 || L.rows.some(r => String(r).length > 24)) throw new Error('太大了：一层最多 24×24');
    for (const row of L.rows) for (const ch of String(row)) { const id = bp.legend[ch]; if (!id) continue; cells++; if (id !== 'air') mats[bareId(id)] = (mats[bareId(id)] || 0) + 1; }
  }
  if (bp.layers.length > 16) throw new Error('太高了：最多 16 层');
  const id = bp.id || `p${Date.now().toString(36)}`;
  const P = projects(state);
  P[id] = { ...bp, id, asked: !!bp.asked, origin: { x: Math.floor(bp.origin.x), y: Math.floor(bp.origin.y), z: Math.floor(bp.origin.z) }, created: P[id]?.created || Date.now(), updated: Date.now(), status: 'active' };
  saveProjects(state);
  return { id, name: bp.name, cells, materials: mats };
}

function projectCells (p) {
  const out = [];
  for (const L of p.layers) {
    L.rows.forEach((row, dz) => [...String(row)].forEach((ch, dx) => {
      const want = p.legend[ch]; if (!want) return;
      out.push({ pos: new Vec3(p.origin.x + dx, p.origin.y + (+L.dy || 0), p.origin.z + dz), want: want === 'air' ? 'air' : bareId(want) });
    }));
  }
  return out;
}

/** 对照蓝图和世界：要挖的、要放的、已经对的、没加载的 */
function projectDiff (bot, p) {
  const dig = []; const place = []; let ok = 0; let unknown = 0;
  for (const c of projectCells(p)) {
    const b = bot.blockAt(c.pos);
    if (!b) { unknown++; continue; }
    const here = bareId(b.name);
    if (c.want === 'air') {
      if (b.boundingBox === 'empty' && !isLiquid(b)) ok++; else dig.push(c);
    } else if (here === c.want) ok++;
    else if (airish(b) || /^(short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|vine)$/.test(here)) place.push(c);
    else { dig.push({ ...c, thenPlace: true }); }
  }
  const total = ok + dig.length + place.length;
  return { dig, place, ok, unknown, total, pct: total ? Math.round(ok * 100 / total) : 0 };
}

function invCount (bot, id) { return bot.inventory.items().filter(i => bareId(i.name) === id).reduce((a, i) => a + i.count, 0); }

function projectStatus (bot, state, { id } = {}) {
  const P = projects(state);
  const list = id ? [P[id]].filter(Boolean) : Object.values(P).filter(p => p.status === 'active');
  if (id && !list.length) throw new Error(`没有工程 ${id}`);
  return {
    projects: list.map(p => {
      const d = projectDiff(bot, p);
      const need = {}; for (const c of [...d.place, ...d.dig.filter(x => x.thenPlace)]) need[c.want] = (need[c.want] || 0) + 1;
      const missing = {}; for (const [k, n] of Object.entries(need)) { const h = invCount(bot, k); if (h < n) missing[k] = n - h; }
      const digWhat = {}; for (const c of d.dig) { const n = bareId(bot.blockAt(c.pos)?.name); digWhat[n] = (digWhat[n] || 0) + 1; }
      return { id: p.id, name: p.name, purpose: p.purpose, origin: p.origin, done: `${d.pct}%`, toDig: d.dig.length, digWhat, toPlace: d.place.length + d.dig.filter(x => x.thenPlace).length, notLoaded: d.unknown, need, missing };
    }),
  };
}

/** 把手上的某种方块放到 pos（找一个实心邻面贴上去），核对放上了 */
async function placeAt (bot, pos, id, mount) {
  const it = bot.inventory.items().find(i => bareId(i.name) === id);
  if (!it) return { ok: false, missing: true };
  if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand');
  const faces = mount === 'wall' ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]
    : mount === 'ceiling' ? [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
    : [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const [dx, dy, dz] of faces) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try { await plainTimeout(bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)), 5000); } catch (_) { await sleep(150); }
    const b = bot.blockAt(pos);
    if (b && bareId(b.name) === id) return { ok: true };
  }
  return { ok: false, why: '找不到能贴的面或放不上' };
}

const START_COVER = 0.7;   // 材料够七成才开工（主人 2026-09-27：工程也要现用现定，不先挖坑等材料）
async function projectWork (bot, state, { id, maxMs = 90000, maxOps = 60 } = {}) {
  const P = projects(state); const p = id ? P[id] : Object.values(P).find(x => x.status === 'active');
  if (!p) throw new Error(id ? `没有工程 ${id}` : '没有进行中的工程（先 design_build）');
  // 还没动过工：不是主人要的、材料又不到七成 → 先不开工（开了只会留一排坑等材料）。已经开工的照常接着做
  if (!p.started && !p.asked) {
    const d0 = projectDiff(bot, p);
    const need = {}; for (const c of [...d0.place, ...d0.dig.filter(x => x.thenPlace)]) need[c.want] = (need[c.want] || 0) + 1;
    const total = Object.values(need).reduce((a, n) => a + n, 0);
    const have = Object.entries(need).reduce((a, [k, n]) => a + Math.min(n, invCount(bot, k)), 0);
    if (total && have / total < START_COVER) {
      const miss = Object.entries(need).filter(([k, n]) => invCount(bot, k) < n).map(([k, n]) => `${k}×${n - invCount(bot, k)}`);
      return { ok: false, notStarted: true, cover: Math.round(have * 100 / total), error: `材料只够 ${Math.round(have * 100 / total)}%（要七成才开工，不先挖坑等材料）；还缺 ${miss.slice(0, 6).join('、')}。主人要你马上盖的话，design_build 时写 asked:true` };
    }
  }
  p.started ||= Date.now();
  const t0 = Date.now(); const skip = new Set(); const placed = {}; let dug = 0; let ops = 0; const missing = {}; let reason = null; const protectedCells = [];
  const key = (v) => `${v.x},${v.y},${v.z}`;
  const me = () => bot.entity.position;
  const reachOK = (pos) => me().offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.3;
  const onMe = (pos) => { const f = me().floored(); return pos.x === f.x && pos.z === f.z && (pos.y === f.y || pos.y === f.y + 1); };
  const goNear = async (pos) => { if (reachOK(pos) && !onMe(pos)) return true; await pathTo(bot, pos, 3, 15000, { retry: false }); return reachOK(pos) && !onMe(pos); };
  while (Date.now() - t0 < maxMs && ops < maxOps) {
    if (bot.health < 8) { reason = `血只剩 ${Math.round(bot.health)}`; break; }
    const mob = threatNear(bot, state, me());
    if (mob) { reason = `${mob.name} 靠近了`; break; }
    const d = projectDiff(bot, p);
    if (!d.dig.length && !d.place.length) { if (!d.unknown) { p.status = 'done'; p.doneAt = Date.now(); saveProjects(state); reason = '完工了'; } else reason = `还有 ${d.unknown} 格没加载，走近点再看`; break; }
    // ① 先挖（从上往下，近的先）
    // 人造方块（木板、楼梯、门、玻璃…）默认不拆：设计没看清压到了房子上，照做就会拆家（实测南门石径要拆 3 块云杉木板）。
    // 工程写了 allowDemolish（明确要改造自己的建筑）才拆
    for (const c of d.dig) { const b = bot.blockAt(c.pos); if (!p.allowDemolish && b && BUILT_RE.test(b.name) && !skip.has(key(c.pos))) { skip.add(key(c.pos)); protectedCells.push(`${bareId(b.name)}(${key(c.pos)})`); } }
    // 要"挖掉换成别的"的格子：手上有替换材料才挖，不然挖出一个坑就走了（实测门口留了 4 个坑）
    for (const c of d.dig) if (c.thenPlace && !invCount(bot, c.want)) missing[c.want] = (missing[c.want] || 0) + 1;
    const dig = d.dig.filter(c => !skip.has(key(c.pos)) && !(c.thenPlace && !invCount(bot, c.want))).sort((a, b) => (b.pos.y - a.pos.y) || (a.pos.distanceTo(me()) - b.pos.distanceTo(me())))[0];
    if (dig) {
      if (!await goNear(dig.pos)) { skip.add(key(dig.pos)); continue; }
      const b = bot.blockAt(dig.pos);
      const wet = N6.map(([dx, dy, dz]) => bot.blockAt(dig.pos.offset(dx, dy, dz))).find(isLiquid);
      if (wet) { skip.add(key(dig.pos)); continue; }
      if (b && !b.diggable) { skip.add(key(dig.pos)); continue; }
      const tool = bot.pathfinder?.bestHarvestTool?.(b); if (tool) await bot.equip(tool, 'hand').catch(() => {});
      try { await bot.lookAt(dig.pos.offset(0.5, 0.5, 0.5), true); await plainTimeout(bot.dig(b, true), 15000); dug++; ops++; } catch (_) { skip.add(key(dig.pos)); }
      continue;
    }
    // ② 再放（从下往上，有支撑的先，近的先；身上没有的记进 missing）
    const cand = d.place.filter(c => !skip.has(key(c.pos)))
      .filter(c => N6.some(([dx, dy, dz]) => { const n = bot.blockAt(c.pos.offset(dx, dy, dz)); return n && n.boundingBox === 'block'; }))
      .sort((a, b) => (a.pos.y - b.pos.y) || (a.pos.distanceTo(me()) - b.pos.distanceTo(me())));
    const next = cand.find(c => invCount(bot, c.want) > 0);
    for (const c of cand) if (!invCount(bot, c.want)) missing[c.want] = (missing[c.want] || 0) + 1;
    if (!next) { reason = Object.keys(missing).length ? '手上的材料用完了（缺的见 missing）' : '剩下的格子暂时够不着/没支撑'; break; }
    if (!await goNear(next.pos)) { skip.add(key(next.pos)); continue; }
    const r = await placeAt(bot, next.pos, next.want);
    if (r.ok) { placed[next.want] = (placed[next.want] || 0) + 1; ops++; } else skip.add(key(next.pos));
  }
  if (!reason) reason = ops >= maxOps ? '这一段干完了，接着调就继续' : '时间到，接着调就继续';
  p.updated = Date.now(); saveProjects(state);
  const after = projectDiff(bot, p);
  return { id: p.id, name: p.name, done: `${after.pct}%`, placed, dug, missing: Object.keys(missing).length ? missing : undefined, skipped: skip.size || undefined,
    keptBuilt: protectedCells.length ? { cells: protectedCells.slice(0, 10), note: '这几格是人造的，没拆（要改造自己的建筑，设计时写 allowDemolish:true）' } : undefined, reason };
}

// ------------------------------------------------------------------ 布置规划：先想好家里哪儿放什么，拿到东西就摆到位
//
// 主人 2026-09-27：「只要是有实体的都应该看布局；应该一次多布局几个，不应该放一个箱子布局一次；
//                  也可以自己规划长期布局，想放什么箱子 / 什么炉灶 / 什么冰箱等」。
// 规划（分区 + 格子：放什么、在哪、挂墙/放地、为什么）存盘；status 对照世界看哪些摆好了、还缺什么；
// furnish 把手上有的东西摆到它规划好的格子（不用再想一次）。

const LAYOUT_FILE = process.env.MC_LAYOUT_FILE || require('path').join(__dirname, 'memory', 'layouts.json');   // MC_LAYOUT_FILE：测试用，别写进真的规划
function layouts (state) {
  if (!state.__layouts) { try { state.__layouts = JSON.parse(require('fs').readFileSync(LAYOUT_FILE, 'utf8')); } catch (_) { state.__layouts = {}; } }
  return state.__layouts;
}
function saveLayouts (state) {
  try { const fs = require('fs'); const tmp = LAYOUT_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state.__layouts || {}, null, 1)); fs.renameSync(tmp, LAYOUT_FILE); } catch (_) {}
}
const allSlots = (L) => (L.zones || []).flatMap(z => (z.slots || []).map(sl => ({ ...sl, zone: z.name })));

// ------------------------------------------------------------------ 分区（现用现定，主人 2026-09-27）
//
// 以前的规划给"以后才会有的东西"先定好精确到格子的位置 —— 赶不上变化：主人改了墙、她想法变了，格子还占着。
// 现在规划只记**分区**：{ name, purpose, wants:{物品:数量}, area:{x,y,z,r} }。东西真到手了，
// place_nicely 才在这个区里看布局、当场挑格子（body.js）。区里放不下了 / 被改建了 → stale（"要重新想"），下次需要时再划。
// 旧的带格子的规划照样能读：格子只用来推出分区的范围和想要的东西，不再按格子摆。
function zoneArea (z) {
  if (z.area && Number.isFinite(+z.area.x)) return { x: +z.area.x, y: +z.area.y, z: +z.area.z, r: Math.min(8, Math.max(2, +z.area.r || 3)) };
  const sl = z.slots || [];
  if (!sl.length) return null;
  const c = sl.reduce((a, q) => ({ x: a.x + q.x / sl.length, y: a.y + q.y / sl.length, z: a.z + q.z / sl.length }), { x: 0, y: 0, z: 0 });
  const r = Math.max(...sl.map(q => Math.hypot(q.x - c.x, q.z - c.z))) + 1;
  return { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z), r: Math.min(8, Math.max(2, Math.ceil(r))) };
}
function zoneWants (z) {
  if (z.wants && typeof z.wants === 'object') return Object.fromEntries(Object.entries(z.wants).map(([k, n]) => [bareId(k), Math.max(1, +n || 1)]));
  const w = {}; for (const sl of z.slots || []) w[bareId(sl.item)] = (w[bareId(sl.item)] || 0) + 1;
  return w;
}
/** 区里现在已经有了多少（按方块名数，area 圆柱内上下 2 格） */
function zonePresent (bot, z, wants = zoneWants(z)) {
  const a = zoneArea(z); const out = {};
  if (!a) return out;
  const ids = Object.keys(wants).map(k => bot.registry.blocksByName[k]?.id).filter(v => v != null);
  if (!ids.length) return out;
  for (const p of bot.findBlocks({ point: new Vec3(a.x, a.y, a.z), matching: ids, maxDistance: a.r + 2, count: 200 })) {
    if (Math.abs(p.y - a.y) > 2 || Math.hypot(p.x - a.x, p.z - a.z) > a.r + 0.5) continue;
    const n = bareId(bot.blockAt(p)?.name); out[n] = (out[n] || 0) + 1;
  }
  return out;
}
/** 区里还有几格能放东西的地面（下面实心、脚和头是空的） */
function zoneFreeFloor (bot, z) {
  const a = zoneArea(z); if (!a) return 0;
  let n = 0;
  for (let dx = -a.r; dx <= a.r; dx++) for (let dz = -a.r; dz <= a.r; dz++) {
    if (Math.hypot(dx, dz) > a.r) continue;
    for (const dy of [0, -1, 1]) {
      const p = new Vec3(a.x + dx, a.y + dy, a.z + dz);
      const b = bot.blockAt(p); const up = bot.blockAt(p.offset(0, 1, 0)); const dn = bot.blockAt(p.offset(0, -1, 0));
      if (b && up && dn && airish(b) && airish(up) && dn.boundingBox === 'block') { n++; break; }
    }
  }
  return n;
}
function zoneMark (state, { id, zone, stale = true, why = '' } = {}) {
  const LS = layouts(state); const L = id ? LS[id] : Object.values(LS).sort((a, b) => b.updated - a.updated)[0];
  if (!L) throw new Error('没有布置规划');
  const z = (L.zones || []).find(q => q.name === zone);
  if (!z) throw new Error(`规划里没有「${zone}」这个区`);
  if (stale) z.stale = { why: String(why).slice(0, 80), at: Date.now() }; else delete z.stale;
  L.updated = Date.now(); saveLayouts(state);
  return { id: L.id, zone: z.name, stale: !!z.stale };
}

/** 格子现在什么样：done 摆好了 / empty 空着能放 / taken 被别的东西占了 / unknown 没加载 */
function slotState (bot, sl) {
  const b = bot.blockAt(new Vec3(sl.x, sl.y, sl.z));
  if (!b) return 'unknown';
  if (bareId(b.name) === bareId(sl.item)) return 'done';
  if (airish(b) || /^(short_grass|grass|tall_grass|fern|snow|carpet)$/.test(bareId(b.name))) return 'empty';
  return 'taken';
}

/** 存规划：逐格核对 —— 方块存在、格子空着、不在路上、下面/旁边有能附着的；不合格的格子退回并说明原因 */
function layoutSave (bot, state, L = {}) {
  if (!L.name || !Array.isArray(L.zones) || !L.zones.length) throw new Error('规划要有 name 和 zones[{name,purpose,wants:{物品:数量},area:{x,y,z,r}}]');
  // 新格式（现用现定）：只有分区、没有格子 —— 核对：想要的东西是真方块、范围里有能放东西的地面
  if (L.zones.every(z => !Array.isArray(z.slots) || !z.slots.length)) {
    const rejected = [];
    L.zones = L.zones.filter(z => {
      const bad = Object.keys(zoneWants(z)).filter(k => !bot.registry.blocksByName[k]);
      if (bad.length) { rejected.push(`${z.name}：没有这些方块 ${bad.join(' ')}`); return false; }
      if (!zoneArea(z)) { rejected.push(`${z.name}：没写范围 area`); return false; }
      if (!zoneFreeFloor(bot, z)) { rejected.push(`${z.name}：范围里没有能放东西的空地`); return false; }
      delete z.stale;
      return true;
    });
    if (!L.zones.length) throw new Error(`一个区都不合格：${rejected.join('；')}`);
    const id = L.id || `L${Date.now().toString(36)}`;
    const LS = layouts(state);
    LS[id] = { ...L, id, created: LS[id]?.created || Date.now(), updated: Date.now() };
    saveLayouts(state);
    return { id, name: L.name, zones: L.zones.length, rejected: rejected.length ? rejected : undefined };
  }
  const cx = L.area || allSlots(L)[0];
  const sv = survey(bot, { x: cx.x, y: cx.y, z: cx.z, r: Math.min(12, L.area?.r || 10) });
  const clear = new Set(sv.keepClear || []);
  const rejected = []; let kept = 0; const used = new Set();
  for (const z of L.zones) {
    z.slots = (z.slots || []).filter(sl => {
      const why = (m) => { rejected.push(`${bareId(sl.item)}@(${sl.x},${sl.y},${sl.z})：${m}`); return false; };
      sl.x = Math.floor(sl.x); sl.y = Math.floor(sl.y); sl.z = Math.floor(sl.z);
      const k = `${sl.x},${sl.y},${sl.z}`;
      if (!bot.registry.blocksByName[bareId(sl.item)] && !bot.registry.blocksByName[sl.item]) return why('没有这个方块');
      if (used.has(k)) return why('和别的格子重了'); used.add(k);
      const st = slotState(bot, sl);
      if (st === 'taken') return why(`那里已经有 ${bareId(bot.blockAt(new Vec3(sl.x, sl.y, sl.z)).name)}`);
      if (clear.has(k) && !/torch|lantern/.test(sl.item)) return why('在路上（门口/梯子口/走道）');
      const p = new Vec3(sl.x, sl.y, sl.z);
      const under = bot.blockAt(p.offset(0, -1, 0));
      const anySolid = N6.some(([dx, dy, dz]) => { const n = bot.blockAt(p.offset(dx, dy, dz)); return n && n.boundingBox === 'block'; });
      if (st !== 'done' && !anySolid) return why('悬空，旁边没东西能贴');
      if (st !== 'done' && (sl.mount || 'floor') === 'floor' && !(under && under.boundingBox === 'block')) return why('下面不是实心的');
      kept++; return true;
    });
  }
  if (!kept) throw new Error(`一个格子都不合格：${rejected.slice(0, 8).join('；')}`);
  const id = L.id || `L${Date.now().toString(36)}`;
  const LS = layouts(state);
  LS[id] = { ...L, id, created: LS[id]?.created || Date.now(), updated: Date.now() };
  saveLayouts(state);
  return { id, name: L.name, slots: kept, rejected: rejected.length ? rejected.slice(0, 12) : undefined };
}

function layoutStatus (bot, state, { id, full } = {}) {
  const LS = layouts(state);
  if (id && full && LS[id]) return { full: LS[id] };
  const list = id ? [LS[id]].filter(Boolean) : Object.values(LS);
  return {
    layouts: list.map(L => {
      // 按分区算（现用现定）：想要什么、已经有了多少、手上能摆什么、还剩几格空地、要不要重新想
      const zones = (L.zones || []).map(z => {
        const wants = zoneWants(z); const present = zonePresent(bot, z, wants);
        const still = {}; for (const [k, n] of Object.entries(wants)) if ((present[k] || 0) < n) still[k] = n - (present[k] || 0);
        const free = zoneFreeFloor(bot, z);
        const stale = z.stale ? z.stale.why || '标过要重新想' : (Object.keys(still).length && !free ? '区里没地方了' : null);
        return { name: z.name, purpose: z.purpose || '', area: zoneArea(z), wants, present, stillWant: still, canPlaceNow: Object.keys(still).filter(k => invCount(bot, k) > 0), freeFloor: free, stale };
      });
      const tot = (o) => Object.values(o).reduce((a, n) => a + n, 0);
      const stillAll = {}; for (const z of zones) for (const [k, n] of Object.entries(z.stillWant)) stillAll[k] = (stillAll[k] || 0) + n;
      return {
        id: L.id, name: L.name,
        zones: zones.map(z => `${z.name}（${z.purpose}）：${tot(z.wants) - tot(z.stillWant)}/${tot(z.wants)}${z.stale ? `，要重新想：${z.stale}` : ''}`),
        zoneDetail: zones,
        done: zones.reduce((a, z) => a + tot(z.wants) - tot(z.stillWant), 0), total: zones.reduce((a, z) => a + tot(z.wants), 0),
        stillWant: stillAll, canPlaceNow: [...new Set(zones.flatMap(z => z.canPlaceNow))], stale: zones.filter(z => z.stale).map(z => z.name),
      };
    }),
  };
}

/** 旧的按格子算（格子规划时代，2026-09-27 改成现用现定后不再被调用；留着给翻老规划时对照） */
function layoutStatusSlots (bot, state, list) {
  return {
    layouts: list.map(L => {
      const slots = allSlots(L).map(sl => ({ ...sl, state: slotState(bot, sl) }));
      const pend = slots.filter(s => s.state === 'empty');
      const want = {}; for (const s of pend) want[bareId(s.item)] = (want[bareId(s.item)] || 0) + 1;
      const ready = Object.keys(want).filter(k => invCount(bot, k) > 0);
      return {
        id: L.id, name: L.name,
        zones: (L.zones || []).map(z => { const zs = slots.filter(s => s.zone === z.name); return `${z.name}（${z.purpose || ''}）：${zs.filter(s => s.state === 'done').length}/${zs.length}`; }),
        done: slots.filter(s => s.state === 'done').length, total: slots.length,
        stillWant: want, canPlaceNow: ready, blocked: slots.filter(s => s.state === 'taken').length || undefined,
      };
    }),
  };
}

/** 把手上有的东西摆到规划好的格子（items 限定只摆哪些） */
async function furnish (bot, state, { id, items, maxMs = 90000 } = {}) {
  const LS = layouts(state); const L = id ? LS[id] : Object.values(LS).sort((a, b) => b.updated - a.updated)[0];
  if (!L) throw new Error('还没有布置规划（先 plan_layout）');
  const only = items ? new Set([].concat(items).map(bareId)) : null;
  const t0 = Date.now(); const placed = []; const failed = [];
  const me = () => bot.entity.position;
  for (const sl of allSlots(L)) {
    if (Date.now() - t0 > maxMs) break;
    const item = bareId(sl.item);
    if (only && !only.has(item)) continue;
    if (slotState(bot, sl) !== 'empty' || !invCount(bot, item)) continue;
    const pos = new Vec3(sl.x, sl.y, sl.z);
    const onMe = () => { const f = me().floored(); return pos.x === f.x && pos.z === f.z && (pos.y === f.y || pos.y === f.y + 1); };
    if (me().offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2 || onMe()) await pathTo(bot, pos, 3, 20000, { retry: false });
    if (onMe()) { failed.push(`${item}@(${sl.x},${sl.y},${sl.z})：站在格子上`); continue; }
    const r = await placeAt(bot, pos, item, sl.mount);
    if (r.ok) placed.push(`${item}→${sl.zone}(${sl.x},${sl.y},${sl.z})`); else failed.push(`${item}@(${sl.x},${sl.y},${sl.z})：${r.why || '没放上'}`);
  }
  L.updated = Date.now(); saveLayouts(state);
  const st = layoutStatus(bot, state, { id: L.id }).layouts[0];
  return { layout: L.name, placed, failed: failed.length ? failed : undefined, done: `${st.done}/${st.total}`, stillWant: st.stillWant };
}

// ------------------------------------------------------------------ 睡觉

async function sleepInBed (bot, state, { home = null, abort } = {}) {
  if (abort?.()) return { ok: false, aborted: true };
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
    if (abort?.()) return { ok: false, aborted: true };
    // 睡不了的时候服务器会在动作栏说原因（只能晚上睡 / 附近有怪 / 床被占了）
    const said = [];
    const onMsg = (m, pos) => { if (pos === 'game_info' || pos === 'system') said.push(String(m.toString())); };
    bot.on('message', onMsg);
    try {
      if (bot.entity.position.distanceTo(bed.position) > 3) await go(bot, state, { x: bed.position.x, y: bed.position.y, z: bed.position.z, range: 2, abort });
      if (abort?.()) return { ok: false, aborted: true };
      if (bot.isABed(bed)) {
        await bot.sleep(bed);
      } else {
        // 模组的床（比如 handcrafted 的）：mineflayer 只认原版 16 色床名，自己右键它
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        if (abort?.()) return { ok: false, aborted: true };
        await bot.activateBlock(bed);
        for (let t = 0; t < 20 && !bot.isSleeping && !abort?.(); t++) await sleep(100);
      }
      if (abort?.()) return { ok: false, aborted: true };
      await sleep(300);
      if (abort?.()) return { ok: false, aborted: true };
      if (bot.isSleeping) return { sleeping: true, bed: bed.name, at: doorKey(bed.position), inHome: !!inHome(bed.position) };
      why.push(`${bed.name}(${doorKey(bed.position)})：${said.join(' ') || '右键了但没躺下'}`);
    } catch (e) {
      if (abort?.()) return { ok: false, aborted: true };
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

// abort：进程内调用才能传（收获本能被命令打断时用），每收一棵 / 种一块之前问一次
// only：只收这些格子（收获本能先挑好：右键摘的、别人不让收的已经排除）
async function farm (bot, state, { radius = 12, replant = true, plantEmpty = true, seed = null, abort = null, only = null } = {}) {
  const stop = () => typeof abort === 'function' && abort();
  const t0 = Date.now();
  const inv0 = invCounts(bot);
  // 只找"有生长阶段（age）属性"的方块种类 —— 以前是把周围所有非空气方块都拿来筛，上限 2000 个全是房子的墙
  const ageIds = Object.values(bot.registry.blocksByName)
    .filter(b => (b.states || []).some(x => String(x.name).toLowerCase() === 'age') && !/cactus|sugar_cane|fire|kelp|bamboo|vine|chorus|frosted_ice|twisting|weeping|cave_vines|sapling/.test(b.name))
    .map(b => b.id);
  const pts = bot.findBlocks({ matching: ageIds, maxDistance: radius, count: 1500 })
    .map(p => bot.blockAt(p)).filter(b => b && cropInfo(bot, b));
  const onlySet = Array.isArray(only) ? new Set(only.map(p => `${p.x},${p.y},${p.z}`)) : null;
  const crops = pts.filter(b => !onlySet || onlySet.has(`${b.position.x},${b.position.y},${b.position.z}`)).map(b => ({ b, info: cropInfo(bot, b) }));
  const mature = crops.filter(c => c.info.mature);
  let harvested = 0; let replanted = 0; let planted = 0; const notes = [];
  for (const { b } of mature.sort((a, c) => bot.entity.position.distanceTo(a.b.position) - bot.entity.position.distanceTo(c.b.position))) {
    if (stop()) { notes.push('被新的命令打断'); break; }
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
  if (harvested && !stop()) await collectDrops(bot, 8);
  // 空着的耕地：播种
  if (plantEmpty && !stop()) {
    const lands = bot.findBlocks({ matching: (b) => !!b && /farmland/.test(b.name), maxDistance: radius, count: 400 })
      .filter(p => { const up = bot.blockAt(p.offset(0, 1, 0)); return up && up.name === 'air'; }).map(p => bot.blockAt(p));
    const sdItem = () => (seed ? bot.inventory.items().find(i => fullId(i.name) === fullId(seed)) : bot.inventory.items().find(i => /seed|^carrot$|^potato$/.test(botName(i.name))));
    for (const land of lands) {
      if (stop()) break;
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

// ------------------------------------------------------------------ 路由

function routes ({ state, withTimeout }) {
  const bot = () => state.bot;
  return {
    'POST /eat': async (b = {}) => eat(bot(), b),
    'POST /use': async (b = {}) => use(bot(), state, b),
    'POST /wear': async (b = {}) => wear(bot(), state, b),
    'POST /craft2': async (b = {}) => craft2(bot(), b, withTimeout),
    'POST /smelt': async (b = {}) => smelt(bot(), b, state),
    'POST /give': async (b = {}) => give(bot(), b),
    'POST /climb_up': async (b = {}) => climbUp(bot(), state, b),
    'POST /climb_down': async (b = {}) => climbDown(bot(), state, b),
    'POST /go': async (b = {}) => go(bot(), state, b),
    'GET /look_around': async (_, q) => lookAround(bot(), { r: q?.r, below: q?.below, above: q?.above }),
    'POST /motor': async (b = {}) => motor(bot(), state, b),
    'POST /nudge': async (b = {}) => nudge(bot(), b),
    'POST /wiggle': async (b = {}) => wiggle(bot(), b),
    'GET /doors': async (_, q) => ({ doors: doorsNear(bot(), Math.min(+(q?.radius || 8), 16)), iOpened: [...(state.doorsIOpened || new Map()).values()].map(d => ({ ...d, pos: doorKey(d.pos) })), leftOpen: (state.doorsLeftOpen || []).slice(-5), lastClosed: state.lastDoorClosed || null, stateSkips: state.doorStateSkips || 0, lastSkipped: state.lastDoorSkipped || null }),
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
    'POST /backpack/tidy': async (b = {}) => backpackTidy(bot(), state, b),
    'POST /storage/loot': async (b = {}) => lootNearby(bot(), state, b),
    'POST /delve': async (b = {}) => delve(bot(), state, b),
    'GET /debug/craftgrid': async () => ({ serverInv: state.invItems || null, clientSlots: bot().inventory.slots.length, clientFilled: bot().inventory.slots.map((it, i) => it && `${i}:${it.type}x${it.count}`).filter(Boolean), grid: bot().inventory.slots.slice(0, 5).map((it, i) => it ? { slot: i, name: it.name, count: it.count } : null), window: bot().currentWindow?.type || null, stateId: bot().inventory.stateId, slotLog: (state.slotLog || []).slice(-20) }),
    'POST /debug/click': async (b = {}) => { const w = bot().currentWindow || bot().inventory; await bot().clickWindow(+b.slot, +b.button || 0, +b.mode || 0); await sleep(300); return { cursor: w.selectedItem && `${w.selectedItem.name}×${w.selectedItem.count}`, grid: w.slots.slice(0, 5).map(it => it && `${it.name}×${it.count}`), slot: w.slots[+b.slot] && `${w.slots[+b.slot].name}×${w.slots[+b.slot].count}`, log: (state.slotLog || []).slice(-4) }; },
    'POST /debug/seq': async (b = {}) => {
      const out = []; const gap = +b.gap || 450;
      for (const [slot, button, mode] of b.clicks || []) {
        const n0 = (state.slotLog || []).length; const t0 = Date.now();
        let err = null; try { await Promise.race([bot().clickWindow(slot, button, mode), sleep(3000).then(() => { throw new Error('click 3s 没返回'); })]); } catch (e) { err = e.message; }
        const ms = Date.now() - t0; await sleep(gap);
        out.push({ click: [slot, button, mode], ms, err, server: (state.slotLog || []).slice(n0).map(x => `${x.slot}:${x.item === false ? '空' : x.item + 'x' + x.count}`) });
      }
      return { out };
    },
    'POST /debug/returngrid': async () => { await returnGrid(bot()); return { grid: bot().inventory.slots.slice(0, 5).map(it => it && `${it.name}×${it.count}`) }; },
    'GET /commands': async () => {
      const w = commandWords(bot()) || new Set();
      const TP = ['home', 'sethome', 'delhome', 'homes', 'back', 'spawn', 'tpa', 'tpahere', 'tpaccept', 'tpdeny', 'rtp', 'warp', 'warps', 'tpx', 'tp', 'kit', 'near', 'trashcan', 'leaderboard'];
      return { known: !!bot()._client.__cmdRaw, total: w.size, teleport: TP.filter(x => w.has(x)), all: [...w].sort() };
    },
    'POST /cmd': async (b = {}) => runCommand(bot(), state, b),
    'GET /survey': async (b = {}) => survey(bot(), b),
    // 看得见的地标：传送石碑、村庄（钟或村民）—— mind 记进"记得的地方"
    'GET /landmarks': async () => {
      const b = bot(); const out = [];
      const ids = (re) => Object.values(b.registry.blocksByName).filter(x => re.test(x.name)).map(x => x.id);
      for (const [kind, re] of [['waystone', /waystone/], ['village', /(^|:)bell$/]]) {
        for (const p of b.findBlocks({ matching: ids(re), maxDistance: 32, count: 8 })) {
          const blk = b.blockAt(p); if (blk && b.canSeeBlock(blk)) out.push({ kind, name: blk.name, x: p.x, y: p.y, z: p.z });
        }
      }
      const vill = Object.values(b.entities).find(e => /villager/.test(e.name || '') && e.position.distanceTo(b.entity.position) < 32);
      if (vill && !out.some(o => o.kind === 'village')) out.push({ kind: 'village', name: 'villager', x: Math.floor(vill.position.x), y: Math.floor(vill.position.y), z: Math.floor(vill.position.z) });
      return { landmarks: out };
    },
    'POST /layout/save': async (b = {}) => layoutSave(bot(), state, b),
    'GET /layout/status': async (b = {}) => layoutStatus(bot(), state, b),
    'POST /layout/furnish': async (b = {}) => furnish(bot(), state, b),
    'POST /layout/zone': async (b = {}) => zoneMark(state, b),   // 标一个区"要重新想"（place_nicely 放不下时）/ 取消
    'POST /layout/cancel': async (b = {}) => { const LS = layouts(state); if (!LS[b.id]) throw new Error(`没有规划 ${b.id}`); delete LS[b.id]; saveLayouts(state); return { removed: b.id }; },
    'POST /project/save': async (b = {}) => projectSave(bot(), state, b),
    'GET /project/status': async (b = {}) => projectStatus(bot(), state, b),
    'POST /project/work': async (b = {}) => projectWork(bot(), state, b),
    'POST /project/cancel': async (b = {}) => { const P = projects(state); if (!P[b.id]) throw new Error(`没有工程 ${b.id}`); P[b.id].status = 'cancelled'; saveProjects(state); return { cancelled: b.id }; },
    'GET /light': async () => ({ light: lightAt(bot()), dark: isDark(lightAt(bot())) && !nearestLight(bot(), 7), nearestLight: nearestLight(bot(), 7), torches: torchCount(bot()), lastBright: state.lastBright ? { x: state.lastBright.x, y: state.lastBright.y, z: state.lastBright.z } : null }),
    // 手上有火把就直接插；真的用完时一次补够 16 根，避免每隔一根就重新打开合成流程。
    'POST /light_up': async (b = {}) => { const have = torchCount(bot()); const m = have > 0 ? { torches: have } : await makeTorches(bot(), 16, state); const r = await lightUp(bot(), { max: Math.min(+b.max || 3, 8), force: !!b.force, state }); return { ...r, made: m.made || 0, ...(m.note ? { makeNote: m.note } : {}) }; },
    'POST /make_torches': async (b = {}) => makeTorches(bot(), Math.min(+b.count || 16, 64), state),
    'POST /self_rescue': async (b = {}) => selfRescue(bot(), state, b),
    'GET /chests/unseen': async (_, q) => ({ chests: unseenChests(bot(), state, +q?.radius || 24).slice(0, 6).map(b => ({ at: storageKey(bot(), b), name: b.name, x: b.position.x, y: b.position.y, z: b.position.z, distance: +bot().entity.position.distanceTo(b.position).toFixed(1) })) }),
    'POST /chests/check': async (b = {}) => ({ checked: await checkChests(bot(), state, b) }),
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
    // FTB 任务书：交任务（点对号 / 交物品）、领奖励、一键全领
    'POST /ftbq/submit': async (b = {}) => { if (!b.taskId) throw new Error('要给 taskId（任务书里的 16 位十六进制）'); return ftbqSend(bot(), state, 'submit_task', hexLong(b.taskId)); },
    'POST /ftbq/claim': async (b = {}) => { if (!b.rewardId) throw new Error('要给 rewardId'); return ftbqSend(bot(), state, 'claim_reward', Buffer.concat([hexLong(b.rewardId), Buffer.from([b.notify === false ? 0 : 1])])); },
    'POST /ftbq/claim_all': async () => ftbqSend(bot(), state, 'claim_all_rewards'),
    'POST /ftbq/claim_choice': async (b = {}) => {   // 多选一奖励（新手小屋 14 选 1）：long rewardId + varint 选第几个
      if (!b.rewardId) throw new Error('要给 rewardId');
      const i = Math.max(0, +b.index || 0); const v = []; let n = i; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; v.push(x); } while (n);
      return ftbqSend(bot(), state, 'claim_choice_reward', Buffer.concat([hexLong(b.rewardId), Buffer.from(v)]));
    },
    'POST /place_structure': async (b = {}) => placeStructure(bot(), state, b),
    'GET /ftbq/recent': async () => ({ recent: (state.ftbqRecent || []).slice(-20) }),
    // 调试：原样发一个模组消息（逆向模组协议时用）{ channel, hex }
    'POST /debug/payload': async (b = {}) => { bot()._client.write('custom_payload', { channel: b.channel, data: Buffer.from(b.hex || '', 'hex') }); await sleep(b.waitMs || 1500); return { sent: b, window: summarizeWindow(bot(), state) }; },
    // 调试：寻路器眼里这一格是什么（safe=能站进去、physical=实心）
    'GET /debug/mvblock': async (_, q = {}) => {
      const mv = bot().pathfinder.movements;
      const out = [];
      for (const dy of [-1, 0, 1]) {
        const b = mv.getBlock(new Vec3(+q.x, +q.y, +q.z), 0, dy, 0);
        let props = null; try { props = b?.getProperties?.(); } catch (e) { props = 'ERR ' + e.message; }
        out.push({ y: +q.y + dy, name: b?.name, props, hasGP: typeof b?.getProperties, stateId: b?.stateId, safe: b?.safe, physical: b?.physical, height: b?.height, bbox: b?.boundingBox, shapes: b?.shapes?.length,
          doorShapes: /(^|_)(trap)?door$/.test(b?.name || '') ? b?.shapes : undefined });
      }
      return { patched: !!mv.__openDoorsPatched, blocks: out };
    },
    'GET /debug/follow': async () => ({
      currentAction: state.currentAction,
      followSeq: state.followSeq || 0,
      lastFollowRoute: state.lastFollowRoute || null,
      // 跟随循环退出的原因（看不见人 / 循环体抛错）—— 不记下来就只能看到"她不动了"
      lastFollowStop: state.lastFollowStop || null,
    }),
    'GET /debug/soph': async () => ({ lastSync: state.lastSophSync || null, error: state.lastSophError || null }),
    'GET /equipment': async () => ({ equipment: equipment(bot()), food: bot().food, health: bot().health, curios: state.curiosWorn || null, backpack: state.backpackSeen || null }),
  };
}

// ------------------------------------------------------------------ 自测

/**
 * ⚠️ 这个文件以前**没有** `--selftest`（AGENTS.md 第 4 节写着"这两个没有 --selftest"）。
 * 顶层只 `require('vec3')`，其余全是函数内 require —— 所以 require 本文件**没有副作用**
 * （不连服务器、不装 bridge 路由），可以安全地直接跑。
 *
 * 驱动的是**真实的 startFollow**（不是复制一份逻辑），用假 bot / 假 state。
 * 覆盖它退出的几条路：`/stop`、换跟随对象、玩家下线、循环体抛错。
 */
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(expect)}`}`);
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const { goals } = require('mineflayer-pathfinder');

  /** 假 bot：startFollow 只用到 pathfinder.goal / setGoal、players、entity.position */
  const rig = () => {
    const players = {};
    const setGoalCalls = [];
    const pathfinder = { goal: null, setGoal (g) { setGoalCalls.push(g); this.goal = g; } };
    const bot = { players, pathfinder, entity: { position: { x: 0, y: 64, z: 0 } } };
    players.Ann = { entity: { position: { x: 1, y: 64, z: 0 } } };   // 同层
    players.Bob = { entity: { position: { x: 2, y: 64, z: 0 } } };
    return { bot, players, pathfinder, setGoalCalls };
  };
  // 跑真循环，但把节奏调小 —— 不用为了测"看不见人之后退出"真等 15 秒
  const TICK = { tickMs: 5, lostMs: 40 };

  /**
   * 假 bot，够 `go()` 跑到"同一层先直接走"那一步：
   * `blockAt` 一律给岩浆 → `wiggle` 会跳过所有试探方向（省掉几秒等待）；`goto` 立刻失败。
   */
  const mkGoBot = (goto) => ({
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    players: { Ann: { entity: { position: new Vec3(8, 64, 0) } } },
    registry: { blocksByName: {} },
    blockAt: () => ({ name: 'minecraft:lava', boundingBox: 'block' }),
    findBlocks: () => [],
    setControlState: () => {},
    clearControlStates: () => {},
    look: async () => {},
    pathfinder: { goal: null, setGoal () {}, goto },
  });

  (async () => {
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

    console.log('\n[1/8] 同层 → 交给 GoalFollow 贴着走');
    {
      const { bot, pathfinder, setGoalCalls } = rig();
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      check('设的是 GoalFollow', pathfinder.goal instanceof goals.GoalFollow, true);
      check('追的是 Ann 的实体', pathfinder.goal?.entity === bot.players.Ann.entity, true);
      check('currentAction 标着在跟随', state.currentAction, 'following Ann');
      check('同层只设了一次 goal（没在反复重设）', setGoalCalls.length, 1);
      state.currentAction = null;                                   // 模拟 /stop，别让它一直跑
    }

    console.log('\n[2/8] /stop（清掉 currentAction）→ 循环退出并清掉 GoalFollow');
    {
      const { bot, pathfinder, setGoalCalls } = rig();
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      state.currentAction = null;                                   // /stop 就是这么做的
      const n = setGoalCalls.length;
      await wait(40);
      // 注意：退出时会**主动** setGoal(null) 收尾，所以 setGoal 的调用数会 +1。
      // 真正要钉住的是"不再设 GoalFollow"—— 否则就是循环没停。
      const refollows = setGoalCalls.slice(n).filter(g => g instanceof goals.GoalFollow).length;
      check('退出后不再设 GoalFollow（循环真的停了）', refollows, 0);
      check('把残留的 GoalFollow 清掉了', pathfinder.goal, null);
    }

    console.log('\n[3/8] 玩家下线（mineflayer 会删掉 bot.players[name]）→ 退出并记下原因');
    {
      const { bot, players, pathfinder } = rig();
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      delete players.Ann;
      await wait(120);
      check('记下"看不见 Ann"', /看不见 Ann/.test(state.lastFollowStop?.reason || ''), true);
      check('清掉追鬼的 GoalFollow', pathfinder.goal, null);
    }

    console.log('\n[4/8] 换跟随对象 → 旧循环退出，但不清新的 goal');
    {
      const { bot, pathfinder } = rig();
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      startFollow(bot, state, 'Bob', 2, TICK);                      // 换人
      await wait(40);
      check('goal 追的是新对象 Bob', pathfinder.goal?.entity === bot.players.Bob.entity, true);
      check('旧循环没有把新的 goal 清掉', pathfinder.goal instanceof goals.GoalFollow, true);
      check('followSeq 递增（旧循环据此退出）', state.followSeq, 2);
    }

    console.log('\n[5/8] 循环体抛错 → 记下来，不静默死掉');
    {
      const { bot } = rig();
      // 读 goal 就抛 —— setFollow 第一步就是读它
      bot.pathfinder = { get goal () { throw new Error('boom'); }, setGoal () {} };
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      check('记下循环体出错', /跟随循环出错：boom/.test(state.lastFollowStop?.reason || ''), true);
    }

    console.log('\n[6/8] 别的动作的 goal 不能被我清掉');
    {
      const { bot, pathfinder } = rig();
      const state = {};
      startFollow(bot, state, 'Ann', 2, TICK);
      await wait(30);
      // 模拟 /move：先改 currentAction，再把 goal 换成 GoalNear
      state.currentAction = 'moving to 1,64,1';
      const near = new goals.GoalNear(1, 64, 1, 1);
      pathfinder.goal = near;
      await wait(40);
      check('跟随退出时没有动 /move 的 GoalNear', pathfinder.goal === near, true);
    }

    console.log('\n[7/9] 门：右键前读实时状态，已开不再切成关');
    {
      const makeDoorBot = (initialOpen, delay = 0) => {
        let open = initialOpen; let calls = 0;
        const pos = new Vec3(3, 64, 4);
        const block = () => ({
          name: 'minecraft:oak_door', position: pos.clone(),
          getProperties: () => ({ open, half: 'lower', facing: 'north' }),
        });
        const bot = {
          __get: () => ({ open, calls }),
          entity: { position: new Vec3(3.5, 64, 5.5) },
          blockAt: () => block(),
          lookAt: async () => {},
          activateBlock: async () => { calls++; if (delay) await sleep(delay); open = !open; },
        };
        return { bot, block };
      };

      const a = makeDoorBot(true);
      const sa = {};
      installDoorHabit(a.bot, sa);
      const skipped = await a.bot.activateBlock(a.block());
      check('门已经 open=true → 不右键', `${a.bot.__get().open}/${a.bot.__get().calls}/${skipped.skipped}`, 'true/0/true');
      check('跳过操作会留下状态证据', `${sa.doorStateSkips}/${sa.lastDoorSkipped.open}`, '1/true');

      const b = makeDoorBot(false, 20);
      const sb = {};
      installDoorHabit(b.bot, sb);
      await Promise.all([b.bot.activateBlock(b.block()), b.bot.activateBlock(b.block())]);
      check('同一扇关门并发要求打开 → 只右键一次', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'true/1');
      check('第二次在等待后看到已开并跳过', sb.doorStateSkips, 1);
      sb.doorsIOpened.clear();

      sb.__closingDoor = true;
      await b.bot.activateBlock(b.block());
      check('明确要求关门时，open=true 才右键', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'false/2');
      await b.bot.activateBlock(b.block());
      check('明确要求关门时，已经 closed 就不再右键', `${b.bot.__get().open}/${b.bot.__get().calls}`, 'false/2');
      sb.doorsIOpened.clear();
    }

    console.log('\n跨层入口：高两格的梯子仍应实际尝试');
    check('脚 y=121、梯子底 y=123 → 候选保留', ladderBottomReachable({ bottom: 123 }, 121.02), true);
    check('脚 y=121、梯子底 y=124 → 确实够不到', ladderBottomReachable({ bottom: 124 }, 121.02), false);
    {
      const mv = { exclusionAreasStep: [] };
      let costs = null;
      const bot = {
        pathfinder: {
          movements: mv,
          goto: async () => { const guard = mv.exclusionAreasStep[0]; costs = [guard({ position: { y: 127 } }), guard({ position: { y: 128 } })]; },
          setGoal: () => {},
        },
      };
      await pathToKeepingFloor(bot, new Vec3(0, 129, 0), 2, 100, 128);
      check('爬上楼后：低于守住楼层的路径被禁', costs, [100, 0]);
      check('楼层保护只在本次寻路期间安装', mv.exclusionAreasStep.length, 0);
    }

    console.log('\n[8/9] go：被叫停时立刻抛 aborted（`/stop` 要停得住在途路线）');
    {
      let aborted = false;
      const bot = mkGoBot(async () => { aborted = true; throw new Error('GoalChanged'); });
      let err = null;
      try { await go(bot, {}, { player: 'Ann', range: 1.8, abort: () => aborted }); } catch (e) { err = e; }
      check('goto 失败后 abort 变真 → 抛 aborted', err?.aborted, true);
      check('错误信息是"被叫停了"', err?.message, '被叫停了');
    }

    console.log('\n[9/9] go：abort 一直为假 → 不误报"被叫停"');
    {
      const bot = mkGoBot(async () => { throw new Error('GoalChanged'); });
      let err = null;
      // maxMs: 1 → 跳过"规划路线"和"放宽范围"两段，让这条用例跑得快
      try { await go(bot, {}, { player: 'Ann', range: 1.8, maxMs: 1, abort: () => false }); } catch (e) { err = e; }
      check('走不通就如实报走不通（不是 aborted）',
        !!(err && !err.aborted && /走不到/.test(err.message)), true);
    }

    console.log('\n[9] 工程：蓝图校验、对照差异（假世界）');
    {
      const world = new Map([['0,0,0', 'stone'], ['1,0,0', 'oak_planks'], ['0,1,0', 'dirt']]);
      const mkB = (name, pos) => ({ name, position: pos, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true });
      const fbot = { registry: { blocksByName: { stone: {}, oak_planks: {}, dirt: {}, air: {} } }, blockAt: (p) => mkB(world.get(`${p.x},${p.y},${p.z}`) || 'air', p) };
      const st = { __projects: {} };
      let err = null; try { projectSave(fbot, st, { name: 'x', origin: { x: 0, y: 0, z: 0 }, legend: { Q: 'nope:block' }, layers: [{ dy: 0, rows: ['Q'] }] }); } catch (e) { err = e.message; }
      check('图例里不存在的方块会被拒', /不存在/.test(err || ''), true);
      const saved = projectSave(fbot, st, { id: 't1', name: '小墙', origin: { x: 0, y: 0, z: 0 }, legend: { P: 'minecraft:oak_planks', '.': 'air' }, layers: [{ dy: 0, rows: ['PPP'] }, { dy: 1, rows: ['.-P'] }] });
      check('存下来、材料清单对', JSON.stringify(saved.materials), JSON.stringify({ oak_planks: 4 }));
      const d = projectDiff(fbot, st.__projects.t1);
      // (0,0,0) stone→要先挖再放；(1,0,0) 已对；(2,0,0) 空→放；(0,1,0) dirt 要挖成空；(1,1,0) '-' 不管；(2,1,0) 空→放
      check('要挖 2 格（石头要换、泥土要清）', d.dig.length, 2);
      check('其中石头那格挖完还要放', d.dig.filter(c => c.thenPlace).length, 1);
      check('要放 2 格', d.place.length, 2);
      check('已经对 1 格，完成 20%', `${d.ok}/${d.pct}`, '1/20');
    }

    console.log('\n搭脚方块名单（整合包标签）');
    {
      const sc = scaffoldIds();
      check('★ 草方块算搭脚方块（以前不认）', sc.includes('minecraft:grass_block'), true);
      check('★ 模组泥土算（RU 泥炭土）', sc.includes('regions_unexplored:peat_dirt'), true);
      check('原版底子还在', sc.includes('minecraft:cobblestone'), true);
      check('沙子不算（会塌）', sc.includes('minecraft:sand'), false);
      check('耕地、小路不算', [sc.includes('regions_unexplored:peat_farmland'), sc.includes('regions_unexplored:peat_dirt_path')], [false, false]);
      check('磨制石头不算（值钱）', sc.includes('minecraft:polished_andesite'), false);
      check('垫脚也认草方块', isFiller('grass_block'), true);
    }
    console.log('\n下矿 / 施工认威胁');
    {
      const V = (x) => ({ distanceTo: (p) => Math.abs(p.x - x) , x });
      const me = { position: V(0) };
      const mk = (name, x, extra = {}) => ({ name, position: V(x), type: 'mob', ...extra });
      const fb = (ents) => ({ entity: me, entities: Object.fromEntries(ents.map((e, i) => [i, e])) });
      const st = { aggroOf: (e) => (e.hate ? { on: 'me' } : null) };
      check('原版僵尸 → 威胁', !!threatNear(fb([mk('zombie', 3)]), st, { x: 0 }), true);
      check('★ 模组怪有仇恨证据 → 威胁（以前名单里没有）', !!threatNear(fb([mk('cataclysm:ignis', 3, { hate: true })]), st, { x: 0 }), true);
      check('模组怪没仇恨 → 不算', !!threatNear(fb([mk('cataclysm:ignis', 3)]), st, { x: 0 }), false);
      check('太远 → 不算', !!threatNear(fb([mk('zombie', 20)]), st, { x: 0 }), false);
      check('没有 aggroOf（旧状态）→ 照旧按名字', !!threatNear(fb([mk('skeleton', 2)]), {}, { x: 0 }), true);
    }

    console.log('\n[0c] 随身物品：身上有没有 + 没背/读不到要分开报');
    {
      // ---- 决策纯函数（真跑的那份，不另抄一份实现）
      // 五种情形：身上够 / 背包有 / 背包没有 / 背包读不到 / 没背背包
      check('身上就有 → 直接用，不看背包', decideCarry({ carried: 3, backpack: 0 }).action, 'use');
      check('身上没有、背包里有 → 去拿', decideCarry({ carried: 0, backpack: 8 }).action, 'fetch');
      check('身上和背包都没有 → 如实报没有', decideCarry({ carried: 0, backpack: 0 }).action, 'none');
      check('★ 背包读不到（null）→ 不能说没有', decideCarry({ carried: 0, backpack: null }).action, 'unknown');
      check('读不到和没有的 reason 不同', [decideCarry({ carried: 0, backpack: null }).reason, decideCarry({ carried: 0, backpack: 0 }).reason], ['身上没有，背包读不到', '身上和背包里都没有']);
      check('身上有但背包读不到 → 仍然 use（读不到不影响已有的）', decideCarry({ carried: 1, backpack: null }).action, 'use');

      // ---- countInBackpackSeen：读不到给 null，不是 0
      const bot = { inventory: { items: () => [] } };
      check('从没打开过背包 → null（读不到）', countInBackpackSeen(bot, {}, 'torch', null), null);
      check('背包记录里没这件 → 0（真的没有）', countInBackpackSeen(bot, { backpackSeen: { items: { 'minecraft:coal': 4 } } }, 'torch', null), 0);
      check('背包记录里有火把 → 数出来', countInBackpackSeen(bot, { backpackSeen: { items: { 'minecraft:torch': 12 } } }, 'torch', null), 12);
      check('带 minecraft: 前缀也能查到', countInBackpackSeen(bot, { backpackSeen: { items: { 'minecraft:torch': 5 } } }, 'minecraft:torch', null), 5);
      check('predicate（垫脚方块这种任意一种）', countInBackpackSeen(bot, { backpackSeen: { items: { 'minecraft:cobblestone': 64, 'minecraft:torch': 3 } } }, null, (it) => /cobblestone/.test(it.name)), 64);

      // ---- ensureCarried 本体（用假 bot，背包读得到时不必真去点界面）
      const mkBot = (carried) => {
        const slots = carried.map((c, i) => ({ name: c.name, count: c.count, type: 100 + i, metadata: 0, stackSize: 64 }));
        return { inventory: { items: () => slots, slots } };
      };
      const torch1 = mkBot([{ name: 'torch', count: 4 }]);
      check('身上有火把 → source=carried，不去开背包', await ensureCarried(torch1, {}, 'torch', 1), { have: 4, got: 4, source: 'carried', needed: 1 });
      const empty = mkBot([]);
      check('身上没有、背包也没有 → source=none + absenceProven', await ensureCarried(empty, { backpackSeen: { items: { 'minecraft:coal': 1 } } }, 'torch', 1), { have: 0, got: 0, source: 'none', absenceProven: true, why: '身上和背包里都没有', needed: 1 });
      const noSeen = await ensureCarried(empty, {}, 'torch', 1);
      check('★ 没背背包/从没打开 → source=unknown，absenceProven=false', { source: noSeen.source, absenceProven: noSeen.absenceProven }, { source: 'unknown', absenceProven: false });
      check('unknown 会给出 why（不是空话）', noSeen.why.includes('读不到'), true);
      // 背包有记录但开不了界面（假 bot 没有 currentWindow）→ 要报 unknown 而不是"没有"
      const cantOpen = await ensureCarried(empty, { backpackSeen: { items: { 'minecraft:torch': 9 } } }, 'torch', 1);
      check('背包有记录但没拿出来 → unknown（不许说没有）', { source: cantOpen.source, absenceProven: cantOpen.absenceProven }, { source: 'unknown', absenceProven: false });
      check('拿不到时把原因带上', cantOpen.why.includes('没拿出来'), true);
    }

    console.log(`\n  ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  })();
}

module.exports = { zoneArea, zoneWants, install, installDoorHabit, routes, slotByName, foodScore, fullId, botName, startFollow, farm, kitShortfall, kitAvailable, defaultLoadout, wearingBackpack, backpackTidy, fetchFromBackpack, ensureCarried, decideCarry, countInBackpackSeen, unseenChests, unseenCarts, inHomeArea, inCave, SCAFFOLD_IDS, scaffoldIds, isFiller };   // farm：收获本能直接调（instinct.js）
