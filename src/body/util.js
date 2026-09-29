'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「util」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3
const paths = require('../paths');
const SEEN_FILE = require('path').join(paths.MEMORY, 'containers-seen.json');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补

const __ns = {};
let FOOD_RE, NOT_FOOD_RE, NOT_STORAGE_RE, STORAGE_RE, TIERS;   // 常量：load 完成后由 bind() 回填
function use (...a) { return __ns.use.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns); FOOD_RE = ns.FOOD_RE; NOT_FOOD_RE = ns.NOT_FOOD_RE; NOT_STORAGE_RE = ns.NOT_STORAGE_RE; STORAGE_RE = ns.STORAGE_RE; TIERS = ns.TIERS; }

// 第 4 步去重：原来是本地定义，现在全项目唯一一份在 src/util/time.js
const { sleep } = require('../util/time');
// 第 4 步去重：`fullId` / `bareId` / `botName` 三份本地定义都搬进 src/util/ids.js
// （body 内 92 处 fullId 等调用不变，仍经本文件的导出 / __ns 拿到同一个函数）。
// `botName` 与 ids.js 的 `bareMinecraft` 在所有输入下输出相同（见 ids.js 自测）。
const { fullId, bareId, bareMinecraft: botName } = require('../util/ids');

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

/**
 * 从**这个界面**里数她自己的物品栏（`inventoryStart..inventoryEnd`）有几件、按 predicate 计。
 *
 * ⚠️ 为什么不能拿 `bot.inventory` 当依据（2026-09-28 codex 审计 R-fix3-2）：
 *   光打开模组界面时 mineflayer 把 `bot.inventory` **整体替换成当前窗口**，
 *   但精妙背包的格子走它自己的同步通道，`bot.inventory` **不会**被那些 `window_items`
 *   更新到 —— 于是"shift+左键把背包格子收进物品栏"这件事在 `bot.inventory` 上**看不见**，
 *   搬运成功却被判成"没搬过来"、返回 `unknown`。
 *   这个界面的 `w.slots[inventoryStart..inventoryEnd)` 才是这次点击真正落到的地方。
 *   （和 `deposit` 里那段 `mine()` 是同一个判据 —— `w.__sophisticated ? 700 : 300` 等同步也是。）
 */
function winInvCount (w, predicate) {
  let n = 0;
  if (!w || !Array.isArray(w.slots)) return n;
  const end = Math.min(Number.isInteger(w.inventoryEnd) ? w.inventoryEnd : w.slots.length, w.slots.length);
  for (let i = w.inventoryStart; i < end; i++) { const it = w.slots[i]; if (it && predicate(it)) n += it.count; }
  return n;
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

function nearestBlock (bot, names, maxDistance = 4.4) {
  const ids = names.map(n => bot.registry.blocksByName[botName(n)]?.id).filter(v => v != null);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance });
}

/**
 * "能不能站在原地直接用这个方块"的判据 —— **只写这一处**（AGENTS.md §5）。
 *
 * 主人 2026-09-28 实机：用熔炉这类方块时她没走过去，隔着几格就操作了（旧代码只要
 * `eyeDist <= REACH(4.2)` 就原地开）。要求是"4 格内可以，但需要中间没有阻挡"。
 *
 * @param {number} dist    眼睛到方块那一面的距离
 * @param {null|boolean} los 视线通不通（true 通 / false 被挡 / **null 读不到**）
 * @returns {{use:boolean, why:string}}
 *   use=true  → 原地就能用
 *   use=false → 必须走过去 / 走不过去就用不了，why 说清是"太远"还是"挡着"还是"读不到"
 */
function canUseFrom (dist, los) {
  if (!(dist <= 4)) return { use: false, why: `离着 ${dist.toFixed(1)} 格（要 4 格内）` };
  // 贴在身边（眼睛到方块中心 ≤ 2 格：脚下、身旁一格）：不用再看视线 —— 走也没处可走（2026-09-28 排程测试：床就在脚下还非要寻路）
  if (dist <= 2) return { use: true, why: '' };
  // 读不到视线（没有 raycast / canSeeBlock）→ 保守当成"挡着"，先走过去（§5：找不到证据保守为 false）
  if (los !== true) return { use: false, why: `4 格内但视线${los === null ? '读不到' : '被挡住'}` };
  return { use: true, why: '' };
}

function eyeDist (bot, block) {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
}

/**
 * 眼睛到方块那一面中间有没有东西挡着。
 * 优先用 mineflayer 的 `bot.canSeeBlock`（blocks.js:229，world.raycast 打的视线）；
 * 没有它 / 它抛错 → 返回 **null（读不到）**，绝不猜成"通"。
 */
function blockVisible (bot, block) {
  if (typeof bot.canSeeBlock !== 'function') return null;
  try { return !!bot.canSeeBlock(block); } catch (_) { return null; }
}

function canUseNow (bot, block) {
  return canUseFrom(eyeDist(bot, block), blockVisible(bot, block));
}

function foodScore (it) {
  if (it.foodPoints > 0) return it.foodPoints * 2;
  const n = it.name;
  if (NOT_FOOD_RE.test(n)) return 0;
  if (/cooked|baked|roast|grilled|stew|soup|pie|bread|steak|burger|sandwich|meal|rice|noodle/.test(n)) return 8;
  return FOOD_RE.test(n) ? 3 : 0;
}

function slotByName (name) {
  const n = String(name).toLowerCase();
  if (/(helmet|_cap$|_hat$|crown|mask|goggles|_hood$|circlet|headband)/.test(n)) return 'head';
  if (/(chestplate|tunic|robe|jacket|_chest$|cuirass|_vest$|breastplate|elytra)/.test(n)) return 'torso';
  if (/(leggings|pants|trousers|greaves)/.test(n)) return 'legs';
  if (/(boots|shoes|sabatons|_feet$)/.test(n)) return 'feet';
  if (/shield/.test(n)) return 'off-hand';
  return null;
}

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

const tierOf = (name) => { const i = TIERS.findIndex(t => name.includes(t)); return i < 0 ? 3.5 : i; };

const knownTierOf = (name) => { const i = TIERS.findIndex(t => String(name).includes(t)); return i < 0 ? null : i; };

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

const cartKey = (e) => `cart@${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`;

const isLiquid = (b) => !!b && /water|lava|bubble_column/.test(b.name);

const airish = (b) => !b || (b.boundingBox === 'empty' && !isLiquid(b));
// 人造方块：挖到这些说明走到别人/自己的建筑里了，不挖（和 bridge 的 isPlayerBuilt 同义的粗判）

/**
 * 门有"开 / 关"两种状态（方块属性 open）。模组的门也一样 —— 所以按属性认，不按名字列清单。
 *
 * 看牧场最怕的是：穿过栅栏门没关，动物全跑了。真人是**随手关门**的，这是习惯不是思考，
 * 所以放在身体层：她**自己打开的**门，走过去之后自动关回原样。
 * 本来就开着的门不碰 —— 那是主人的布置（比如梯子顶常开的活板门）。
 * 她所有开门的途径（右键、爬梯子推活板门、/activate）最后都走 bot.activateBlock，在这里包一层就全管住了。
 */
const isDoorLike = (b) => !!b && typeof b.getProperties === 'function' && 'open' in (b.getProperties() || {})

const isOpen = (b) => String(b.getProperties().open).toLowerCase() === 'true';

const doorKey = (p) => `${p.x},${p.y},${p.z}`;

function doorKind (b) {
  return /trapdoor|hatch/.test(b.name) ? '活板门' : /gate/.test(b.name) ? '栅栏门' : '门';
}

function doorBase (bot, pos) {
  const b = bot.blockAt(pos);
  if (b && /door/.test(b.name) && !/trapdoor/.test(b.name) && String(b.getProperties().half).toLowerCase() === 'upper') return bot.blockAt(pos.offset(0, -1, 0));
  return b;
}

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

function findStorage (bot, radius) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => STORAGE_RE.test(b.name) && !NOT_STORAGE_RE.test(b.name)).map(b => b.id);
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }).map(p => bot.blockAt(p)).filter(Boolean);
}

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

const REACH = 4.2;

const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

const FIXED_CH = [
  [/(^|:)(air|cave_air|void_air)$/, '.'], [/lava/, '!'], [/water|bubble_column/, '~'],
  [/torch|lantern|campfire|candle|glowstone|sea_lantern|shroomlight|froglight/, 'i'],
  [/ladder|scaffolding/, 'H'],
];

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

let knowledge = null;

function K () {
  if (!knowledge) knowledge = require('../knowledge/knowledge');
  return knowledge;
}

module.exports = { ARMOR_SLOTS, FIXED_CH, K, N6, REACH, airish, bareId, bind, blockVisible, botName, canUseFrom, canUseNow, cartKey, commandWords, delta, doorBase, doorKey, doorKind, equipChanges, equipment, eyeDist, findItem, findStorage, foodScore, fullId, hexLong, inHomeArea, invCounts, isDoorLike, isLadder, isLiquid, isOpen, knowledge, knownTierOf, locatePlayerInv, markSeen, mcString, nearestBlock, passable, plainTitle, readNbt, readSophItem, readVarInt, seenKeys, sleep, slotByName, solidUnder, storageKey, summarizeWindow, surveyChar, tierOf, winInvCount };
