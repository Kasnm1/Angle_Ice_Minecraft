#!/usr/bin/env node
/**
 * equip-policy.js —— 「该把手里的东西换成什么」的判据。
 *
 * ## 这个文件从哪来（2026-09-28 重构第 1 步）
 *
 * 原来它住在 `decision.js`（旧脑干的决策后端）里。重构第 1 步删掉了整个旧脑干，
 * 但这部分判据**还在被用**：
 *
 *   · `bridge-server.js` 的 `POST /equip`（`auto: true` 时）调它；
 *   · `bridge-server.js` 把它作为依赖传给 `instinct.install()`，
 *     本能层打怪前用它挑武器（`instinct.js` 的 `deps.pickAutoEquip`）。
 *
 * 于是把它**原样**搬出来（函数体一字未改，见
 * `node scripts/refactor/check-moved.js` 的核对），而不是跟随旧脑干一起删。
 *
 * ## 为什么不放进 hands.js
 *
 * `hands.js` 是"身体动作"（手上做什么），而这份判据是**纯函数策略**：
 * 输入 `{held, inventory, want}`、输出换哪件，不看 bot、不发 HTTP。
 * 放进 `hands.js` 会让"策略"和"动作"混在一层，也不好离线穷举。
 * 单独一个小文件 + 自带 `--selftest` 更贴合项目一贯的"判据只有一个家"。
 *
 * 用法：`node equip-policy.js --selftest`
 */

'use strict';

// ------------------------------------------------------------------ 打分表

/**
 * 工具/武器的分级表。
 *
 * ⚠️ 顺序即优劣，**贵的在前**。不要按字母序排 —— 那会让钻石镐排在木镐后面。
 * 材质名用原版注册名，模组工具（比如整合包加的）不在表里 → 给基础分，
 * 而不是给 0：**不认识的工具也比空手强**。这一点和 HiyoriAI 一致
 * （它的 `equip` 只按 `item.name` 正则挑，没有材质表）。
 */
const TOOL_TIERS = [
  'netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden',
];

const TOOL_KINDS = {
  pickaxe: { role: 'tool', label: '镐' },
  axe: { role: 'weapon', label: '斧' },      // 斧既能砍也能打，两种角色都算
  shovel: { role: 'tool', label: '铲' },
  hoe: { role: 'tool', label: '锄' },
  sword: { role: 'weapon', label: '剑' },
};

/**
 * 给一件物品打分。
 *
 * @param {string} name  物品注册名，如 `diamond_pickaxe`
 * @returns {{ score: number, role: 'tool'|'weapon'|'none', label: string }}
 *
 * 评分规则（刻意简单，因为**判错的代价很小**，而复杂的规则没法离线穷举）：
 *   - 认得出种类：基准 10；每升一档材质 +5（原版 6 档 → 10..35）
 *   - 认不出种类但名字里带 pickaxe/axe/... 的结尾：给 8（近似命中）
 *   - 完全不认识：0（当它不是工具）
 * 斧同时算 tool 和 weapon；剑只算 weapon。
 */
function scoreEquipItem (name) {
  if (!name || typeof name !== 'string') {
    return { score: 0, role: 'none', label: '' };
  }
  const bare = name.replace(/^[a-z0-9_]+:/, '');   // 去掉模组命名空间
  let kind = null;
  let suffixHit = null;
  for (const k of Object.keys(TOOL_KINDS)) {
    if (bare === k) { kind = k; break; }                       // 极少数：物品就叫 pickaxe
    if (bare.endsWith(`_${k}`)) {
      // `_axe` 会同时命中 axe；`_pickaxe` 只命中 pickaxe（因为 endsWith('_axe')
      // 对 'pickaxe' 为 false —— 'pickaxe' 的结尾是 'ckaxe' 不是 '_axe'）
      if (!suffixHit || k.length > suffixHit.length) suffixHit = k;
    }
  }
  const matched = kind || suffixHit;
  if (!matched) return { score: 0, role: 'none', label: '' };

  const info = TOOL_KINDS[matched];
  // 材质档：找出名字里最靠前的那个材质词。`_` 边界匹配，避免 'iron' 命中 'ironwood'。
  let tierIdx = -1;
  for (let i = 0; i < TOOL_TIERS.length; i++) {
    const t = TOOL_TIERS[i];
    if (bare.includes(`${t}_`) || bare.startsWith(`${t}_`)) { tierIdx = i; break; }
  }
  let score = 10;
  if (tierIdx >= 0) score += 5 * (TOOL_TIERS.length - tierIdx);   // 木 10+5=15 … 下界 10+30=40
  return {
    score,
    role: info.role,
    label: `${info.label}${name}`,
  };
}

/**
 * 决定"该把手里的东西换成什么"。
 *
 * @param {object} p
 * @param {string|null} p.held         当前手持的注册名（没有则空手）
 * @param {string[]}    p.inventory     背包全部物品的注册名（**含手持**）
 * @param {'tool'|'weapon'|'any'} [p.want='any']  眼下想干什么
 * @returns {{ itemName: string|null, reason: string, upgraded: boolean }}
 *
 * 返回 `itemName: null` 表示"不用换"。三种情况会返回 null：
 *   ① 背包里没有比现在更好的东西
 *   ② 现在手上的已经是这一类里最好的
 *   ③ 想要 weapon 但背包里只有镐（同类不匹配 → 宁可空手也别拿镐去打）
 *
 * ⚠️ 刻意**不做**的一件事：不检查耐久。原因 —— mineflayer 的 `item.durabilityUsed`
 *    只在物品带 `durability` 组件时才有值，对模组物品常常是 null，
 *    拿 null 去比较会得出"这件几乎全新"的**错误**结论。宁可换错也不误判。
 */
function pickAutoEquip ({ held = null, inventory = [], want = 'any' } = {}) {
  const heldInfo = scoreEquipItem(held);
  const counts = new Map();
  for (const n of inventory) counts.set(n, (counts.get(n) || 0) + 1);

  // 是不是"真武器"？判据：角色是 weapon **且**名字里带 sword / _axe。
  // 为什么不用 role==='weapon' 就够：斧同时是 tool 和 weapon，但 `_axe$` 才算真武器的一半。
  // 这里定义一个独立概念是为了让下面两条规则能表达"有没有更好的替代品"。
  const isRealWeapon = (n) => {
    const s = scoreEquipItem(n);
    if (s.role !== 'weapon') return false;
    return /(^|_)sword$/.test(n.replace(/^[a-z0-9_]+:/, '').replace(/_.*$/, ''))
      || /_sword$|_axe$/.test(n.replace(/^[a-z0-9_]+:/, ''));
  };
  const hasRealWeapon = [...counts.keys()].some(isRealWeapon);
  const hasTool = [...counts.keys()].some(n => scoreEquipItem(n).role === 'tool');

  /**
   * 眼下的"想干什么"决定了哪些角色算合格。
   *
   * ⚠️ 关键设计（也是第一次写错的地方）：想要武器时，**只有在没有真武器的情况下**
   *    工具才算凑合。否则会出现荒谬结果 —— 背包里有木剑，却因为"钻石镐分数更高"
   *    而继续握着镐去打骷髅。分数只在同一角色内可比。
   */
  const accept = (role) => {
    if (want === 'weapon') {
      if (role === 'weapon') return true;
      return role === 'tool' && !hasRealWeapon;    // 没武器时镐也能凑合打
    }
    if (want === 'tool') {
      if (role === 'tool') return true;
      return role === 'weapon' && !hasTool;        // 没工具时剑也能凑合挖
    }
    return role !== 'none';
  };

  // 硬规则：想要武器，而手上是纯工具（镐/铲/锄）且背包里有真武器 → 一定换。
  // 这条比"分数更高"优先，因为角色不匹配时分数没有可比性
  // （钻石镐 40 分 > 木剑 15 分，但拿镐打骷髅显然不如拿剑）。
  if (want === 'weapon' && heldInfo.role === 'tool' && hasRealWeapon) {
    return pickBest({ counts, held, accept, reason: '手上是工具，背包里有武器' });
  }

  // 反向规则：想要工具，而手上是真武器，且背包里有真工具 → 换。理由对称。
  const hasRealTool = [...counts.keys()].some(n => scoreEquipItem(n).role === 'tool' && !isRealWeapon(n));
  if (want === 'tool' && isRealWeapon(held) && hasRealTool) {
    return pickBest({ counts, held, accept, reason: '手上是武器，背包里有工具' });
  }

  if (heldInfo.role !== 'none' && accept(heldInfo.role)) {
    // 手上已经有一件"角色对得上"的东西 —— 只有当背包里有**严格更好**的同类时才换。
    const better = [];
    for (const n of counts.keys()) {
      if (n === held) continue;
      const s = scoreEquipItem(n);
      if (!accept(s.role)) continue;
      if (s.score > heldInfo.score) better.push({ name: n, score: s.score });
    }
    if (better.length === 0) {
      return { itemName: null, reason: `手上的${heldInfo.label}已经是最好的了`, upgraded: false };
    }
    better.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return {
      itemName: better[0].name,
      reason: `背包里有更好的：${better[0].name}（${better[0].score} > ${heldInfo.score}）`,
      upgraded: true,
    };
  }

  return pickBest({ counts, held, accept, reason: held ? '手上的东西不对路' : '空着手' });
}

/** pickAutoEquip 的内部工具：从背包里挑分最高的可接受项。 */
function pickBest ({ counts, held, accept, reason }) {
  const cands = [];
  for (const n of counts.keys()) {
    const s = scoreEquipItem(n);
    if (!accept(s.role)) continue;
    cands.push({ name: n, score: s.score });
  }
  if (cands.length === 0) {
    return { itemName: null, reason: '背包里没有能用的东西', upgraded: false };
  }
  cands.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = cands[0];
  if (held && top.name === held) {
    return { itemName: null, reason: `手上的${held}已经是最好的了`, upgraded: false };
  }
  return { itemName: top.name, reason: `${reason} → ${top.name}`, upgraded: true };
}


// ------------------------------------------------------------------ 自测

// `node equip-policy.js --selftest`
//
// 这一段是从 `decision.js` 的自测里**原样**搬过来的（原来在 [6/7] 段）。
// 它锚定的是**判据**而不是实现 —— 将来换算法，只要判据还成立就该继续通过。
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };

  console.log('\n自动换手 —— 空手/拿错东西时该换成什么');
  // 背景（问题 3「不会使用自己物品栏东西」）：她原来根本没有 equip 这个动作，
  // 于是"背包里有钻石镐"和"背包里啥都没有"对她是同一件事。
  //
  // 这些用例锚定的是**判据**，不是实现：将来换算法，只要判据还成立就该继续通过。
  const eq = (p) => pickAutoEquip(p);

  // --- 打分表本身
  check('钻石镐比木镐分高', scoreEquipItem('diamond_pickaxe').score > scoreEquipItem('wooden_pickaxe').score, true);
  check('剑算武器', scoreEquipItem('iron_sword').role, 'weapon');
  check('斧既算工具也算武器', scoreEquipItem('iron_axe').role, 'weapon');
  check('镐算工具', scoreEquipItem('stone_pickaxe').role, 'tool');
  check('泥土不是工具', scoreEquipItem('dirt'), { score: 0, role: 'none', label: '' });
  // ⚠️ 关键陷阱：`_axe` 是 `_pickaxe` 的后缀，天真的 endsWith 会把镐判成斧。
  check('镐不会被误判成斧', scoreEquipItem('iron_pickaxe').label.includes('镐'), true);
  check('镐不会被误判成斧(2)', scoreEquipItem('netherite_pickaxe').role, 'tool');
  // 模组命名空间要去掉，否则 'iron' 匹配不到
  check('带命名空间的物品也能识别材质', scoreEquipItem('mod:iron_pickaxe').score > scoreEquipItem('mod:wooden_pickaxe').score, true);
  check('不认识的物品给 0 分', scoreEquipItem('mystery_orb').score, 0);

  // --- 空手
  check('空手 + 背包有镐 → 换上',
    eq({ held: null, inventory: ['stone_pickaxe'] }).itemName, 'stone_pickaxe');
  check('空手 + 背包只有泥土 → 不换',
    eq({ held: null, inventory: ['dirt', 'cobblestone'] }).itemName, null);

  // --- 升级（手上已有，但有更好的）
  check('手持木镐 + 背包有钻石镐 → 换钻石镐',
    eq({ held: 'wooden_pickaxe', inventory: ['wooden_pickaxe', 'diamond_pickaxe'] }).itemName,
    'diamond_pickaxe');
  check('手持钻石镐 + 背包只有木镐 → 不换（已经最好）',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_pickaxe'] }).itemName, null);
  check('手持钻石镐 → 明说"已经是最好的"',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_pickaxe'] }).reason.includes('最好'), true);

  // --- 角色不匹配（最容易被朴素分数搞错的一条）
  // 钻石镐 40 分 > 木剑 15 分，但想打人时拿镐不如拿剑。
  check('想打人 + 手持钻石镐 + 背包有木剑 → 换木剑（分数更低但角色对）',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_sword'], want: 'weapon' }).itemName,
    'wooden_sword');
  check('想打人 + 手持木剑 + 背包有钻石镐 → 不换',
    eq({ held: 'wooden_sword', inventory: ['wooden_sword', 'diamond_pickaxe'], want: 'weapon' }).itemName,
    null);
  // ⚠️ 这条用例一开始我自己写反了。最初的直觉是"想打人就不该拿镐"，
  //    但空手基础伤害 1，镐类 2~5 —— **拿镐明确优于空手**。
  //    规则的准确表述是："有真武器时工具不合格"，而不是"想打人就排斥工具"。
  check('想打人但背包只有镐、空着手 → 还是拿上镐（比空手强）',
    eq({ held: null, inventory: ['diamond_pickaxe'], want: 'weapon' }).itemName, 'diamond_pickaxe');
  check('想打人 + 手持镐 + 背包只有镐 → 不折腾',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe'], want: 'weapon' }).itemName, null);

  // --- 平手时的确定性（同一输入必须同一输出，否则无法回归）
  check('同材质多件 → 结果稳定（不随 Map 顺序变）',
    eq({ held: null, inventory: ['iron_sword', 'iron_pickaxe'] }).itemName,
    eq({ held: null, inventory: ['iron_pickaxe', 'iron_sword'] }).itemName);

  // --- 边界：不认识的模组工具不该被当成"没有工具"
  check('空手 + 只有不认识的模组物品 → 不换（宁可不换也不乱拿）',
    eq({ held: null, inventory: ['mystery_orb'] }).itemName, null);
  check('空手 + 无背包参数 → 不崩且不换', eq({}).itemName, null);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

module.exports = { pickAutoEquip, scoreEquipItem, TOOL_TIERS, TOOL_KINDS };
