'use strict';

/**
 * entity-registry.js —— 认出模组生物 + 看出"谁在找她 / 找主人的麻烦"。
 *
 * 战斗本能的第一步（主人 2026-09-27）：先认得出，再谈打。
 *
 * ## ① 为什么模组怪认不出来
 *
 * `mineflayer/lib/plugins/entities.js:160 setEntityData`：
 *
 *     entityData ??= entityDataByInternalId[type]
 *     if (entityData) { entity.type = entityData.type; entity.name = entityData.name; ... }
 *     else { entity.type = 'other'; entity.name = 'unknown'; entity.kind = 'unknown' }
 *
 * `entityDataByInternalId` 是插件注入时从 minecraft-data 抄出来的**闭包常量**，只有 124 个原版实体。
 * 这服有上千个模组实体 —— 全部落进 else：`name='unknown'`、`type='other'`。
 * autopilot 自测里"模组怪 name=unknown **kind=hostile**"那条用的是实机不会出现的输入：
 * 实机上模组怪连 hostile 都不是，就是一个 other。
 *
 * 而服务端**每次登录都把 `minecraft:entity_type` 注册表发过来了**（FML S2CRegistry，
 * 实测 1960 条），只是 bridge 的 onSnapshot 以前只留方块和物品，这份被扔了。
 *
 * ## 为什么是"事后补名"，不是像物品那样注入 registry
 *
 * 物品的名字是**用的时候**才查 `registry.items[id]`，改 registry 就生效。
 * 实体不是：查表那张 `entityDataByInternalId` 是闭包，内置插件比我们的外部插件先注入，
 * 改 `registry.entitiesArray` 已经晚了。所以在 `entitySpawn`（setEntityData 之后才发）里补：
 * 只动 `name === 'unknown'` 且 `entityType` 是数字的那些（else 分支会把原始 type id 放进 entityType）。
 *
 * 快照只有「名字 → id」，**没有 MobCategory**：所以模组怪补上名字后 `type` 仍是 `'other'`，
 * 不编一个 hostile 出来（找不到证据时保守，不猜）。敌意交给下面的 ②，看行为判。
 *
 * ## ② 敌意：只认证据，不认名单
 *
 * 主人定的规矩：**只打对她或对玩家有仇恨的怪**。仇恨的证据按硬度排：
 *
 *   1. `hurt`       —— 它打了她 / 打了玩家。1.20 的 `damage_event` 带攻击者 id
 *                      （`sourceCauseId`，箭算到射手头上），mineflayer 转成 `entityHurt(victim, source)`。
 *                      服务端对**所有在视距内的客户端**广播这个包，所以玩家挨打她也看得见。
 *   2. `aggressive` —— 它的 `mob_flags`（metadata 15）第 0x04 位亮着，并且脸朝着她 / 某个玩家。
 *                      原版 `Mob.setAggressive(true)` 由 MeleeAttackGoal / RangedBowAttackGoal /
 *                      弩的攻击 goal 在**有目标开始攻击时**设置：僵尸举手、骷髅拉弓都是这一位。
 *                      模组怪只要继承 Mob 并用这些 goal，同样亮。
 *                      这一位只说"它在打某个东西"，不说打谁 —— 所以再看它的头朝谁（生物会盯着目标）。
 *
 * 没有证据 = 不是仇恨（僵尸在远处闲逛、苦力怕背对着她走 —— 都不算）。
 *
 * 本文件**只判断**，不动身体。动身体的是战斗本能层（下一步）。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SNAPSHOT = path.join(__dirname, 'registry', 'minecraft-entity_type.json');

const CFG = {
  // "它打过谁"记多久。打一下就跑的骷髅，几秒后还在射程里，仍然是仇人。
  hurtMemoryMs: 30000,
  // 脸朝向判据：目标方向与它的头朝向夹角在这个范围内算"盯着"。
  // 生物看目标用的是 LookControl（每 tick 转头），实际偏差很小；35° 留给网络抖动和我们取的是脚底坐标。
  facingToleranceDeg: 35,
  // 超过这个距离，"盯着"不算数 —— 太远了，看它朝哪都说明不了什么。
  facingMaxDist: 24,
};

// Mob 的 metadata：Entity 0..7，LivingEntity 8..14，Mob 15（mob_flags）。
// minecraft-data 1.20.1 zombie 的 metadataKeys 第 15 个就是 'mob_flags'（已核对）。
const META_HEALTH = 9;
const META_MOB_FLAGS = 15;
const FLAG_AGGRESSIVE = 0x04;

const normName = (n) => (String(n).startsWith('minecraft:') ? String(n).slice(10) : String(n));

// ------------------------------------------------------------------ ① 名字

function loadSnapshot (file = DEFAULT_SNAPSHOT) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(s?.entries) ? s : null;
  } catch (_) {
    return null;   // 没抓到过 —— 与"表里没有"分开：调用方看 null 就知道是没表
  }
}

/**
 * 快照 → id 表，并核对原版前缀：本地每个原版实体的 id，在快照同 id 上必须是同一个名字。
 * 对不上说明 id 整体错位了 —— 那连原版怪的名字 mineflayer 都认错了，补名反而帮倒忙，直接拒绝。
 *
 * @param snapshot  loadSnapshot 的结果（entries: [[name, id], ...]）
 * @param registry  bot.registry（取 entitiesArray 做原版核对）
 */
function buildIndex (snapshot, registry) {
  if (!snapshot || !Array.isArray(snapshot.entries)) return { ok: false, reason: '没有实体注册表快照', byId: new Map() };
  const byId = new Map();
  for (const [name, id] of snapshot.entries) if (typeof id === 'number' && typeof name === 'string') byId.set(id, name);

  const vanilla = registry?.entitiesArray || [];
  const mismatch = [];
  let checked = 0;
  for (const e of vanilla) {
    const id = e.internalId ?? e.id;
    const got = byId.get(id);
    if (got === undefined) continue;   // 快照里没有这个 id：少一个不算错位
    checked++;
    if (normName(got) !== e.name) mismatch.push({ id, local: e.name, server: got });
  }
  if (mismatch.length) {
    return { ok: false, reason: `原版实体 id 对不上 ${mismatch.length}/${checked}（例：${JSON.stringify(mismatch[0])}）`, byId: new Map(), mismatch };
  }
  const vanillaIds = new Set(vanilla.map(e => e.internalId ?? e.id));
  const modded = [...byId.keys()].filter(id => !vanillaIds.has(id)).length;
  return { ok: true, byId, vanillaChecked: checked, vanillaCount: vanilla.length, modded, total: byId.size };
}

/**
 * 给 mineflayer 认不出的实体补上服务端的真名。只碰 else 分支留下的那种（name='unknown' + 数字 entityType）。
 * 模组名保留命名空间（`twilightforest:naga`），和物品一致 —— 原版名本来就不带前缀。
 * @returns {boolean} 补了没有
 */
function patchEntity (entity, index) {
  if (!entity || !index?.ok) return false;
  if (entity.name !== 'unknown' || typeof entity.entityType !== 'number') return false;
  const name = index.byId.get(entity.entityType);
  if (!name) return false;
  entity.name = normName(name);
  entity.displayName = entity.name;
  entity.angelNamed = true;   // 名字是我们补的；type 仍是 'other'（快照不带类别，不编）
  return true;
}

// ------------------------------------------------------------------ ② 敌意

/** 它身上"正在攻击"那一位亮没亮。只看活物（有血量）—— 非生物实体的第 15 号 metadata 是别的东西。 */
function isAggressive (entity) {
  const m = entity?.metadata;
  if (!m || typeof m[META_HEALTH] !== 'number') return false;
  const f = m[META_MOB_FLAGS];
  return typeof f === 'number' && (f & FLAG_AGGRESSIVE) !== 0;
}

// ------------------------------------------------------------------ ②b 敌对判据（只此一份）

/**
 * 原版敌对生物的名字（不含命名空间，比对时先剥前缀）。
 *
 * ⚠️ 这份名单只有一份 —— `instinct.js` 的战斗本能、`hands.js` 的 `threatNear`、
 *    `bridge-server.js` 的 `/nearby` 分类都调 `isHostileEntity`，不许再各写各的
 *    （AGENTS.md §5「同一判据只写一处」）。
 *
 * 名单来源：三处历史名单（`instinct.js` 的 `HOSTILE_NAME_RE`、`hands.js` 的 `HOSTILE_RE`、
 * bridge 的 `type === 'hostile'`）取**并集**；`3db1774` 补的那些（bogged/breeze/elder_guardian/
 * endermite/evoker/giant/guardian/phantom/ravager/shulker/stray/vex/warden/wither/zoglin/
 * zombified_piglin）全都在。
 *
 * 这只是**兜底**：整合包有 1851 个模组实体，名字认不全。模组怪靠两样东西补：
 *   1. `e.type === 'hostile'` —— 名字认得出的原版/部分模组怪
 *   2. `aggroOf(e)` 有仇恨证据 —— 补名后 `type` 仍是 `'other'` 的模组怪，靠行为证据（③ ②）
 */
const HOSTILE_NAMES = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian', 'endermite',
  'enderman', 'evoker', 'ghast', 'giant', 'guardian', 'hoglin', 'husk', 'illusioner',
  'magma_cube', 'phantom', 'piglin', 'piglin_brute', 'pillager', 'ravager', 'shulker',
  'silverfish', 'skeleton', 'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden',
  'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
  'zombified_piglin',
]);

/**
 * 这是不是"敌对怪"——该打 / 该躲 / 该算威胁。
 *
 * @param entity   实体（mineflayer entity 或已补名的模组实体）
 * @param aggroOf  可选：`bridge` 的仇恨查询（见 ②）。有证据也升成敌对
 *                 —— 模组怪补名后 `type` 仍是 `'other'`，只能靠行为证据认。
 * @returns {boolean} 名字/类别认出 或 有仇恨证据
 *
 * 找不到证据时保守为 false：**"不是敌对" ≠ "友好"**，只是没证据。
 * 玩家永远不算（PVP 不归本能管）。
 */
function isHostileEntity (entity, aggroOf = null) {
  if (!entity || entity.type === 'player') return false;
  if (entity.type === 'hostile') return true;
  const n = normName(entity.name || '').toLowerCase();
  if (HOSTILE_NAMES.has(n)) return true;
  if (typeof aggroOf === 'function' && aggroOf(entity)) return true;
  return false;
}

/**
 * 它的头朝向与"它 → 目标"方向的夹角（度）。
 * mineflayer 的 yaw 约定（conv.fromNotchianYaw = 180° - notch）：朝向向量 = (-sin yaw, -cos yaw)，yaw=0 朝北(-z)。
 * 用 headYaw（生物转头盯目标，身体未必跟着转）；没有就退回 yaw。
 */
function facingAngleDeg (entity, targetPos) {
  const yaw = typeof entity.headYaw === 'number' ? entity.headYaw : entity.yaw;
  if (typeof yaw !== 'number' || !entity.position || !targetPos) return null;
  const dx = targetPos.x - entity.position.x;
  const dz = targetPos.z - entity.position.z;
  if (Math.hypot(dx, dz) < 1e-6) return 0;
  const want = Math.atan2(-dx, -dz);
  let d = Math.abs(want - yaw) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d * 180 / Math.PI;
}

/**
 * 仇恨追踪。状态只有"谁打过谁"（带时间），其余每次现看。
 *
 *   noteHurt(victim, source, now)      —— 接 bot 的 entityHurt
 *   assess(entity, { self, players, now }) → { on, evidence, angle? } | null
 *       self    : 她自己的 entity
 *       players : 其他玩家的 entity 数组（她要护着的人）
 *       on      : 'me' 或玩家名
 */
function createAggroTracker (opts = {}) {
  const cfg = { ...CFG, ...opts };
  const hurtBy = new Map();   // 攻击者 entity id → { on, at }

  function noteHurt (victim, source, selfId, now = Date.now()) {
    if (!victim || !source || source.id === victim.id) return null;
    let on = null;
    if (victim.id === selfId) on = 'me';
    else if (victim.type === 'player' && victim.username) on = victim.username;
    if (!on) return null;   // 怪打怪、怪打村民：不是她的仇
    if (source.type === 'player') return null;   // 玩家之间的事不归本能管
    hurtBy.set(source.id, { on, at: now });
    return on;
  }

  function assess (entity, { self, players = [], now = Date.now() } = {}) {
    if (!entity || entity === self || entity.type === 'player') return null;
    const h = hurtBy.get(entity.id);
    if (h && now - h.at <= cfg.hurtMemoryMs) return { on: h.on, evidence: 'hurt', ageMs: now - h.at };
    if (h) hurtBy.delete(entity.id);

    if (!isAggressive(entity)) return null;
    // 在打东西 —— 看它盯着谁。视线锥里有好几个人时挑**离它最近**的：
    // 三点一线时夹角都是 0，而它不可能隔着前面那个人去打后面那个。都不在视线里就不是冲我们来的。
    const cands = [];
    if (self?.position) cands.push({ on: 'me', pos: self.position });
    for (const p of players) if (p?.position && p.username) cands.push({ on: p.username, pos: p.position });
    let best = null;
    for (const c of cands) {
      const d = entity.position.distanceTo(c.pos);
      if (d > cfg.facingMaxDist) continue;
      const a = facingAngleDeg(entity, c.pos);
      if (a === null || a > cfg.facingToleranceDeg) continue;
      if (!best || d < best.d) best = { on: c.on, angle: a, d };
    }
    return best ? { on: best.on, evidence: 'aggressive', angle: Math.round(best.angle) } : null;
  }

  /** 实体消失时清掉（bot 的 entityGone） */
  function forget (entity) { if (entity) hurtBy.delete(entity.id); }

  return { noteHurt, assess, forget, _hurtBy: hurtBy };
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  const { Vec3 } = require('vec3');
  const registry = require('prismarine-registry')('1.20.1');

  // ---- ① 名字 ----
  const vanilla = registry.entitiesArray.map(e => [`minecraft:${e.name}`, e.internalId ?? e.id]);
  const maxV = Math.max(...vanilla.map(e => e[1]));
  const fake = { entries: [...vanilla, ['twilightforest:naga', maxV + 1], ['alexsmobs:grizzly_bear', maxV + 7]] };
  const idx = buildIndex(fake, registry);
  check('原版 + 模组快照 → ok', idx.ok, true);
  check('原版逐条核对', idx.vanillaChecked, registry.entitiesArray.length);
  check('模组条数', idx.modded, 2);

  const shifted = { entries: vanilla.map(([n, id]) => [n, id + 1]) };
  check('★ 原版 id 整体错一位 → 拒绝（不然连僵尸都认错）', buildIndex(shifted, registry).ok, false);
  check('没有快照 → 不 ok', buildIndex(null, registry).ok, false);

  const unk = { name: 'unknown', type: 'other', entityType: maxV + 1 };
  check('★ mineflayer 认不出的 → 补上真名', patchEntity(unk, idx), true);
  check('补上的是服务端的名字（带命名空间）', unk.name, 'twilightforest:naga');
  check('类别不编：type 仍是 other', unk.type, 'other');
  const zombie = { name: 'zombie', type: 'hostile', entityType: 118 };
  check('原版认得出的不碰', patchEntity(zombie, idx), false);
  check('快照里也没有的 id → 不补、保持 unknown',
    (() => { const e = { name: 'unknown', entityType: 99999 }; patchEntity(e, idx); return e.name; })(), 'unknown');
  check('index 不 ok 时一律不补', patchEntity({ name: 'unknown', entityType: maxV + 1 }, { ok: false }), false);

  const real = loadSnapshot();
  if (real) {
    const r = buildIndex(real, registry);
    check('真快照（registry/minecraft-entity_type.json）原版前缀一致', r.ok, true);
    if (!r.ok) console.log('    ', r.reason);
  } else {
    console.log('  （还没有真快照 registry/minecraft-entity_type.json —— 连一次服务器就会落盘）');
  }

  // ---- ② 敌意 ----
  // 造实体：yaw 朝向用 facingAngleDeg 同一个约定反算，不手抄公式
  const mob = (id, x, z, { aggressive = false, lookAt = null, living = true } = {}) => {
    const e = { id, type: 'other', name: 'x', position: new Vec3(x, 64, z), metadata: [] };
    if (living) e.metadata[META_HEALTH] = 20;
    e.metadata[META_MOB_FLAGS] = aggressive ? FLAG_AGGRESSIVE : 0;
    if (lookAt) e.headYaw = Math.atan2(-(lookAt.x - x), -(lookAt.z - z));
    return e;
  };
  const me = { id: 1, type: 'player', username: 'Angle_ICE', position: new Vec3(0, 64, 0) };
  const owner = { id: 2, type: 'player', username: 'starwish', position: new Vec3(10, 64, 0) };
  const ctx = (now) => ({ self: me, players: [owner], now });

  check('朝向：正对着 → 0°', Math.round(facingAngleDeg(mob(9, 0, 5, { lookAt: me.position }), me.position)), 0);
  check('朝向：背对着 → 180°', Math.round(facingAngleDeg(mob(9, 0, 5, { lookAt: new Vec3(0, 64, 10) }), me.position)), 180);

  const t = createAggroTracker();
  check('闲逛的僵尸（没举手）→ 不是仇', t.assess(mob(10, 3, 0, { lookAt: me.position }), ctx(0)), null);
  const a1 = t.assess(mob(11, 3, 0, { aggressive: true, lookAt: me.position }), ctx(0));
  check('★ 举手 + 盯着她 → 对她有仇', a1 && a1.on, 'me');
  check('证据是 aggressive', a1 && a1.evidence, 'aggressive');
  const a2 = t.assess(mob(12, 10, 4, { aggressive: true, lookAt: owner.position }), ctx(0));
  check('★ 举手 + 盯着主人 → 对主人有仇', a2 && a2.on, 'starwish');
  check('三点一线（怪→主人→她）→ 算主人的（离它近）',
    t.assess(mob(15, 20, 0, { aggressive: true, lookAt: owner.position }), ctx(0))?.on, 'starwish');
  check('举手但盯着别处（打村民）→ 不是我们的仇',
    t.assess(mob(13, 3, 3, { aggressive: true, lookAt: new Vec3(3, 64, 20) }), ctx(0)), null);
  check('非活物（没有血量）第 15 位亮着也不算',
    t.assess(mob(14, 3, 0, { aggressive: true, lookAt: me.position, living: false }), ctx(0)), null);

  const archer = mob(20, 12, 0);   // 骷髅：打完人没举手、背过身
  check('打她 → 记下', t.noteHurt(me, archer, me.id, 1000), 'me');
  const a3 = t.assess(archer, ctx(2000));
  check('★ 打过她的（哪怕现在没举手）→ 仇', a3 && a3.evidence, 'hurt');
  check('30 秒后淡忘', t.assess(archer, ctx(1000 + CFG.hurtMemoryMs + 1)), null);
  check('打主人 → 记在主人名下', t.noteHurt(owner, mob(21, 5, 5), me.id, 0), 'starwish');
  check('怪打村民 → 不记', t.noteHurt({ id: 50, type: 'mob' }, mob(22, 5, 5), me.id, 0), null);
  check('玩家打她（PVP / 闹着玩）→ 不记', t.noteHurt(me, owner, me.id, 0), null);
  check('没有攻击者（摔伤、岩浆）→ 不记', t.noteHurt(me, undefined, me.id, 0), null);
  const gone = mob(23, 2, 2); t.noteHurt(me, gone, me.id, 0); t.forget(gone);
  check('实体消失后忘掉', t.assess(gone, ctx(1)), null);
  check('玩家本身不做评估', t.assess(owner, ctx(0)), null);

  // ---- ②b 敌对判据（只此一份）----
  check('★ 原版僵尸 → 敌对', isHostileEntity({ name: 'zombie', type: 'hostile' }), true);
  check('带命名空间也认', isHostileEntity({ name: 'minecraft:skeleton', type: 'other' }), true);
  check('★ type=hostile 的模组怪（名字认不出）→ 敌对', isHostileEntity({ name: 'unknown', type: 'hostile' }), true);
  const aggro = (e) => (e.hate ? { on: 'me', evidence: 'hurt' } : null);
  check('★ 模组怪（type=other、名字不在名单）有仇恨证据 → 敌对',
    isHostileEntity({ name: 'cataclysm:ignis', type: 'other', hate: true }, aggro), true);
  check('模组怪没仇恨证据 → 不算敌对（保守为 false）',
    isHostileEntity({ name: 'cataclysm:ignis', type: 'other' }, aggro), false);
  check('被动动物（牛）→ 不敌对', isHostileEntity({ name: 'cow', type: 'animal' }, aggro), false);
  check('★ 玩家 → 永远不敌对', isHostileEntity({ name: 'starwish', type: 'player', hate: true }, aggro), false);
  check('null → 不敌对', isHostileEntity(null), false);
  check('空对象（name/type 都缺）→ 不敌对', isHostileEntity({}), false);
  check('掉落物（名字=物品名）→ 不敌对', isHostileEntity({ name: 'oak_log', type: 'object' }), false);
  check('三处旧名单并集都在：bogged/breeze/warden/endermite',
    ['bogged', 'breeze', 'warden', 'endermite'].every(n => isHostileEntity({ name: n, type: 'other' })), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = {
  CFG,
  DEFAULT_SNAPSHOT,
  loadSnapshot,
  buildIndex,
  patchEntity,
  isAggressive,
  HOSTILE_NAMES,
  isHostileEntity,
  facingAngleDeg,
  createAggroTracker,
  selftest,
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
