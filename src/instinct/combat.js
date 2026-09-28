'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「combat」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const __ns = {};
let CFG, ARMOR_RANK, HURT_FEET, HURT_BELOW;   // 跨文件常量：load 完成后由 bind() 回填
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; ARMOR_RANK = ns.ARMOR_RANK; HURT_FEET = ns.HURT_FEET; HURT_BELOW = ns.HURT_BELOW; }

function mobKind (name, held = null) {
  const n = String(name || '').replace(/^.*:/, '');
  if (/creeper/.test(n)) return 'creeper';
  if (held && /(^|:|_)(bow|crossbow|trident)$/.test(String(held))) return 'ranged';
  if (/^(skeleton|stray|bogged|pillager|witch|blaze|ghast|evoker|illusioner)$/.test(n)) return 'ranged';
  return 'melee';
}

function attackCooldownMs (item) {
  const n = String(item || '').replace(/^.*:/, '');
  if (/sword/.test(n)) return 625;
  if (/_axe$/.test(n)) return /wooden|stone/.test(n) ? 1250 : 1100;
  if (/trident/.test(n)) return 1100;
  if (/pickaxe/.test(n)) return 834;
  if (/shovel/.test(n)) return 1000;
  if (!n) return 250;   // 空手
  return 625;
}

function combatPlan (ctx, cfg = CFG.combat) {
  const { targets = [], hp = 20, hasShield = false, anchor = null } = ctx;
  const inRange = targets.filter(t => t.dist <= cfg.detect && (!anchor || Math.hypot(t.pos.x - anchor.x, t.pos.z - anchor.z) <= cfg.leash));
  if (!inRange.length) return null;
  inRange.sort((a, b) => a.dist - b.dist);
  const nearest = inRange[0];
  if (hp <= cfg.lowHp) return { mode: 'retreat', target: nearest };
  const creeper = inRange.find(t => t.kind === 'creeper' && t.dist < cfg.creeperSafe);
  if (creeper) return { mode: 'avoid', target: creeper, keep: cfg.creeperSafe };
  // 打谁：打过人的优先（证据最硬），再挑最近的；苦力怕不在近战名单里
  const fightable = inRange.filter(t => t.kind !== 'creeper')
    .sort((a, b) => ((a.evidence === 'hurt') ? 0 : 1) - ((b.evidence === 'hurt') ? 0 : 1) || a.dist - b.dist);
  if (!fightable.length) return null;
  const t = fightable[0];
  // 远程怪没盾：以前是“保持距离躲”，结果站着挨箭（主人 2026-09-28：被骷髅打了好几下都不动）。
  // 骷髅本来就在远处射，躲只会一直挨 —— 冲上去近战；血少时上面的 retreat 会先接管。
  if (t.kind === 'ranged' && !hasShield) return { mode: 'melee', target: t, charge: true };
  if (t.kind === 'ranged' && hasShield) return { mode: 'shield', target: t };
  return { mode: 'melee', target: t };
}

function armorRank (name) {
  const bare = String(name || '').replace(/^.*:/, '');
  for (const [re, r] of ARMOR_RANK) if (re.test(bare)) return r;
  return null;
}

function pickArmor (worn = {}, items = []) {
  const out = [];
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const cur = worn[slot];
    if (cur && /elytra/.test(cur)) continue;
    const curRank = cur ? armorRank(cur) : 0;
    const cands = items.filter(i => i.slot === slot && !/elytra/.test(i.name))
      .map(i => ({ ...i, rank: armorRank(i.name) }))
      .filter(i => (cur ? (i.rank != null && curRank != null && i.rank > curRank) : true))
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    if (cands.length) out.push({ slot, name: cands[0].name, from: cur || null });
  }
  return out;
}

function toolWorn (it, cfg = CFG.toolWarn) {
  if (!it || !it.maxDurability || it.durabilityUsed == null) return null;
  const left = it.maxDurability - it.durabilityUsed;
  const ratio = left / it.maxDurability;
  return ratio <= (it.enchanted ? cfg.enchantedRatio : cfg.ratio) ? { left, max: it.maxDurability } : null;
}

function hazardUnder ({ feet = null, below = null, fallingAbove = false } = {}) {
  // 头顶有沙子 / 砂砾正往下掉（mindcraft modes.js 的 self_preservation 有这条；砸到头会闷死）
  if (fallingAbove) return '头顶有沙子/砂砾掉下来';
  if (feet && HURT_FEET.test(feet)) return `陷在 ${feet} 里`;
  if (below && HURT_BELOW.test(below)) return `站在 ${below} 上`;
  return null;
}

function pickStepOff (cells = []) {
  const open = (n) => n != null && require('../world/place').isStandable({ name: n });   // 判据只在 place.js 一处（P50：含草、藤、雪层）
  const ok = cells.filter(c => open(c.feet) && open(c.head) && c.below != null && !/air|lava|water|fire|magma|cactus|powder_snow|campfire/.test(c.below));
  ok.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz)));   // 先直的，再斜的
  return ok[0] || null;
}

module.exports = { armorRank, attackCooldownMs, bind, combatPlan, hazardUnder, mobKind, pickArmor, pickStepOff, toolWorn };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/combat.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['战斗', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { attackCooldownMs, combatPlan, isHostileEntity, mobKind } = ns;
    // ---- 战斗 ----
    check('苦力怕', mobKind('creeper'), 'creeper');
    check('模组苦力怕也认', mobKind('somemod:ice_creeper'), 'creeper');
    check('骷髅是远程', mobKind('skeleton'), 'ranged');
    check('★ 模组怪手上拿着弓 → 远程', mobKind('somemod:ghoul', 'bow'), 'ranged');
    check('拿三叉戟的溺尸 → 远程', mobKind('drowned', 'trident'), 'ranged');
    check('空手溺尸 → 近战', mobKind('drowned', null), 'melee');
    check('僵尸近战', mobKind('zombie'), 'melee');
    check('★ 可见但尚未攻击的僵尸也算敌对', isHostileEntity({ name: 'zombie', type: 'hostile' }), true);
    check('普通动物不算敌对', isHostileEntity({ name: 'cow', type: 'animal' }), false);
    check('★ 剑要等 0.625 秒（不是 350ms 连点）', attackCooldownMs('iron_sword'), 625);
    check('石斧更慢', attackCooldownMs('stone_axe') > attackCooldownMs('diamond_axe'), true);
    const T = (name, dist, extra = {}) => ({ id: dist * 10, name, pos: { x: dist, y: 64, z: 0 }, dist, on: 'me', evidence: 'aggressive', kind: mobKind(name), ...extra });
    check('僵尸冲她来 → 近战', combatPlan({ targets: [T('zombie', 4)] })?.mode, 'melee');
    check('★ 血只剩 5 → 跑', combatPlan({ targets: [T('zombie', 4)], hp: 5 })?.mode, 'retreat');
    check('★ 苦力怕 4 格 → 躲开，不近战', combatPlan({ targets: [T('creeper', 4)] })?.mode, 'avoid');
    check('苦力怕在 7 格外、只有它 → 不动（不追着打苦力怕）', combatPlan({ targets: [T('creeper', 9)] }), null);
    check('★ 骷髅、没盾 → 冲上去近战（躲只会站着挨箭）', combatPlan({ targets: [T('skeleton', 8)] })?.mode, 'melee');
    check('★ 骷髅、没盾、血少 → 跑', combatPlan({ targets: [T('skeleton', 8)], hp: 5 })?.mode, 'retreat');
    check('★ 骷髅、有盾 → 举盾贴上去', combatPlan({ targets: [T('skeleton', 8)], hasShield: true })?.mode, 'shield');
    check('骷髅已经贴脸（没盾）→ 直接打', combatPlan({ targets: [T('skeleton', 2)] })?.mode, 'melee');
    check('超出发现距离 → 不管', combatPlan({ targets: [T('zombie', 15)] }), null);
    check('★ 离锚点太远（追出 leash）→ 不追', combatPlan({ targets: [T('zombie', 5)], anchor: { x: -20, y: 64, z: 0 } }), null);
    check('打过人的优先（哪怕远一点）', combatPlan({ targets: [T('zombie', 3), T('husk', 6, { evidence: 'hurt' })] })?.target.name, 'husk');
    check('苦力怕贴近时先躲，哪怕旁边有僵尸', combatPlan({ targets: [T('zombie', 3), T('creeper', 3)] })?.mode, 'avoid');
  }],
  ['危险方块', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { hazardUnder, pickStepOff } = ns;
    // ---- 危险方块 ----
    check('★ 站在岩浆块上 → 要挪', typeof hazardUnder({ feet: 'air', below: 'magma_block' }), 'string');
    check('陷在浆果丛里 → 要挪', typeof hazardUnder({ feet: 'sweet_berry_bush', below: 'grass_block' }), 'string');
    check('陷在细雪里 → 要挪', typeof hazardUnder({ feet: 'minecraft:powder_snow', below: 'stone' }), 'string');
    check('站在草地上 → 没事', hazardUnder({ feet: 'air', below: 'grass_block' }), null);
    check('★ 头顶有沙子掉下来 → 挪开', typeof hazardUnder({ feet: 'air', below: 'stone', fallingAbove: true }), 'string');
    check('读不到 → 不当危险（不猜）', hazardUnder({}), null);
    const cell = (dx, dz, below, feet = 'air', head = 'air') => ({ dx, dz, feet, head, below });
    check('★ 挪到旁边能站的格子', pickStepOff([cell(1, 0, 'lava'), cell(-1, 0, 'stone')])?.dx, -1);
    check('先直的再斜的', pickStepOff([cell(1, 1, 'stone'), cell(0, 1, 'stone')])?.dz, 1);
    check('★ 旁边全是岩浆块 / 空 → 不挪（别挪进更糟的地方）', pickStepOff([cell(1, 0, 'magma_block'), cell(0, 1, 'air')]), null);
    check('读不到的格子不去', pickStepOff([cell(1, 0, null)]), null);
    check('头顶被挡 → 不去', pickStepOff([cell(1, 0, 'stone', 'air', 'stone')]), null);
  }],
  ['护甲', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { armorRank, pickArmor } = ns;
    // ---- 护甲 ----
    check('铁 > 皮', armorRank('iron_chestplate') > armorRank('leather_tunic'), true);
    check('模组护甲认不出材质 → null', armorRank('somemod:void_chestplate'), null);
    const up = pickArmor({ torso: 'leather_chestplate' }, [{ name: 'iron_chestplate', slot: 'torso' }]);
    check('★ 皮胸甲 → 换铁的', up[0]?.name, 'iron_chestplate');
    check('只往上换：穿着钻石的，背包里的铁不换', pickArmor({ torso: 'diamond_chestplate' }, [{ name: 'iron_chestplate', slot: 'torso' }]).length, 0);
    check('★ 穿着认不出的模组胸甲 → 不自动换（可能是主人给的）', pickArmor({ torso: 'somemod:void_chestplate' }, [{ name: 'netherite_chestplate', slot: 'torso' }]).length, 0);
    check('空槽 → 穿上（模组的也行）', pickArmor({}, [{ name: 'somemod:void_boots', slot: 'feet' }])[0]?.name, 'somemod:void_boots');
    check('鞘翅不碰', pickArmor({ torso: 'elytra' }, [{ name: 'netherite_chestplate', slot: 'torso' }]).length, 0);
  }],
  ['工具耐久', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { toolWorn } = ns;
    // ---- 工具耐久 ----
    check('★ 铁镐剩 5% → 提醒', !!toolWorn({ maxDurability: 250, durabilityUsed: 238 }), true);
    check('剩一半 → 不说', toolWorn({ maxDurability: 250, durabilityUsed: 125 }), null);
    check('★ 附魔的剩 15% 就提醒（更早）', !!toolWorn({ maxDurability: 1561, durabilityUsed: 1330, enchanted: true }), true);
    check('没有耐久数据（模组物品）→ 不说（不猜）', toolWorn({ durabilityUsed: 10 }), null);
  }],
];
register('combat', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('combat', __sections);
}
