'use strict';

/**
 * hands.js（第 3 步重构，2026-09-28）拆出来的「kit」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./hands')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：8 个文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等 index.js 加载完 8 个文件后用 bind(总表) 回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const { Vec3 } = require('vec3');   // 原 hands.js 顶层的那个导入，函数体里直接用了 Vec3

const __ns = {};
function K (...a) { return __ns.K.apply(null, a); }
function categoryOf (...a) { return __ns.categoryOf.apply(null, a); }
function foodScore (...a) { return __ns.foodScore.apply(null, a); }
function fullId (...a) { return __ns.fullId.apply(null, a); }
function matcher (...a) { return __ns.matcher.apply(null, a); }
function tierOf (...a) { return __ns.tierOf.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns);  }

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

function kitMatch (bot, L, it) {
  if (L.kind === 'best') return L.re.test(it.name);
  if (L.kind === 'food') return categoryOf(bot, it) === '食物' && foodScore(it) > 0;
  if (L.kind === 'id') return fullId(it.name) === L.id;
  if (L.kind === 'any') return L.ids.includes(fullId(it.name));
  return L.m(it);
}

/**
 * 这件东西是不是**随身装备**（不该被存进箱子 / 塞进背包的那几样）。
 *
 * 主人 2026-09-28 实机：`13:05:36 mind store_items(items=[…"铁斧","石镐"…])` ——
 * mind 明确点名要她把镐子/斧子存起来，她照做了；之后 `mine ore=iron_ore aborted=true mined=0` 连挂三次，
 * 因为**手上已经没有能挖铁的镐子**了。
 *
 * 判据**只有这一处**：直接复用 `kitMatch` + `defaultLoadout()`，
 * 所以装备单改了（加一件"盾"之类）这里自动跟着变，不会再出现"两处名单不一致"。
 * 覆盖：最好的镐 / 斧 / 剑（有一样就行）、吃的、火把、搭脚方块、水桶。
 * **注意**：`kind: 'best'` 的项是"身上最好的那一件"，所以这里必须按**具体那一件**去比，
 * 不能只说"某种类型" —— 否则会把备用的第二把镐也留下、永远清不出去。
 * 这正是我们要的：随身装备 = 装备单要她带的那几件，正好留下这几件。
 *
 * @param {object} bot
 * @param {{name:string, count?:number}} it  要判的物品（物品栏格或 `{name}` 形状就够了）
 * @returns {boolean} true = 随身装备，不能存/不能塞背包
 */
function isLoadoutItem (bot, it) {
  if (!it?.name) return false;
  const fake = { name: it.name, count: it.count ?? 1 };
  for (const L of [...defaultLoadout(), WEAPON_CHECK]) {
    // foodScore / categoryOf 只读 name，用 fake 就够；best 的 re 也只读 name。
    // categoryOf 会读 bot.registry（真 bot 一定有）；万一没有就当"不是吃的"，
    // 不让一个拿不准的食物判定把"不存工具"整个兜底判据搞崩（工具/火把/水桶这些不依赖 registry）。
    let hit = false;
    try { hit = kitMatch(bot, L, fake); } catch (_) { hit = L.kind === 'best' || L.kind === 'id' || L.kind === 'any' ? kitMatch({ registry: { blocksByName: {}, itemsByName: {} } }, L, fake) : false; }
    if (hit) return true;
  }
  return false;
}

/**
 * 从"要存的东西"里挑出随身装备，并把它们剔掉。
 * @returns {{kept: string[], reasons: string[]}} kept = 被留下的物品名；reasons = 给 mind 的话
 */
function protectLoadout (bot, items) {
  const kept = []; const keptSet = new Set();
  for (const x of [].concat(items || [])) {
    const name = typeof x === 'string' ? x : (x?.item || x?.name);
    if (!name) continue;
    // 分类 / 标签也能当 spec 传进来（store_items 支持）；只有"点名到具体物品"时才逐件判
    if (typeof x === 'object' && !x.name && !x.item) continue;
    if (isLoadoutItem(bot, { name })) { kept.push(name); keptSet.add(fullId(name)); }
  }
  // 分类项（"矿物"这种）也可能把工具卷进去 —— 用 matcher 反查一次
  const reasons = kept.length
    ? [`${kept.join('、')} 是随身装备，留在身上`]
    : [];
  return { kept, keptSet, reasons };
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

function kitAvailable (bot, items, labels, loadout = defaultLoadout()) {
  return labels.filter(label => {
    const L = [...loadout, WEAPON_CHECK].find(x => x.label === label);
    return L && items.some(it => kitMatch(bot, L, it));
  });
}

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

const STORAGE_RE = /(^|:)(chest|trapped_chest|barrel)$|chest|barrel|cabinet|crate|drawer|cupboard|locker|shelf_storage|storage|fridge|basket|shulker_box/;

const NOT_STORAGE_RE = /ender_chest|hopper|furnace|smoker|pot|kettle|board|table|stove|oven|jar|keg|chest_boat|minecart|display|pedestal/;

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

const SCAFFOLD_IDS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'netherrack', 'blackstone'].map(n => `minecraft:${n}`);
/**
 * 搭脚方块的完整名单：上面的原版底子 + 整合包标签里算泥土 / 石头 / 圆石的（草方块、模组的泥土石头都算）。
 * 以前只认写死的 11 种，背包里一组草方块或模组泥土她会说"没有搭脚方块"跑回家拿（2026-09-27 主人指出草方块不算泥土的同类问题）。
 * 会塌的（沙、砂砾、灰烬）、耕地小路、磨制/砖（值钱）、塞进标签的装饰（陶罐）不算。
 */

const NOT_SCAFFOLD_RE = /sand|gravel|(^|:|_)ash$|suspicious|farmland|_path$|vase|_pot$|_jar$|infested|polished|bricks?$|concrete_powder|quicksand/;

const SCAFFOLD_TAGS = ['minecraft:dirt', 'forge:cobblestone', 'forge:stone', 'minecraft:stone_crafting_materials'];

let scaffoldCache = null;

const WEAPON_CHECK = { kind: 'best', re: /(sword|(^|_)axe)$/, count: 1, label: '武器', essential: true };

module.exports = { NOT_SCAFFOLD_RE, NOT_STORAGE_RE, SCAFFOLD_IDS, SCAFFOLD_TAGS, STORAGE_RE, TIERS, WEAPON_CHECK, bind, defaultLoadout, isLoadoutItem, kitAvailable, kitMatch, kitShortfall, loadoutTargetShortfall, pickLoadout, protectLoadout, scaffoldCache, scaffoldIds };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 hands.js 的自测段里（同一个 (async () => {…})() 外套），
// 现在搬到这里 —— 断言一字未改，只是把原来「同一作用域里随手就能用」的 hands 函数
// 改成从 t.h（总表）取名（拆开后它们分在别的文件里）。
// 被汇总 require 时 register（登记不跑）；`node src/body/kit.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['[0c] 随身物品：身上有没有 + 没背/读不到要分开报', async (t) => {
    const { check, wait, rig, mkGoBot, TICK, goals, Vec3, handsSrc } = t;
    const { categoryOf, containerPut, countInBackpackSeen, decideCarry, defaultLoadout, deposit, ensureCarried, foodScore, isLoadoutItem, lookIntoBackpack, resolveCarryId, use, winInvCount } = t.h;
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

        // ---- ★ R-fix3-3：请求的 count 必须当回事（以前只看 carried>0）
        check('★ 身上 1 根、要 16 根 → 该去背包补（不能拿 1 根充数）', decideCarry({ carried: 1, backpack: 15, need: 16 }).action, 'fetch');
        check('★ 身上 16 根、要 16 根 → 够了，直接用', decideCarry({ carried: 16, backpack: 0, need: 16 }).action, 'use');
        check('★ 身上 1 根、要 16 根、背包也读不到 → unknown（不是 use）', decideCarry({ carried: 1, backpack: null, need: 16 }).action, 'unknown');
        check('要多少有多少（need=Infinity）：身上 ≥1 就行', decideCarry({ carried: 1, backpack: null, need: Infinity }).action, 'use');
        check('★ 身上不够、背包也空 → 按现状用（身上有多少用多少，不硬报没有）', decideCarry({ carried: 2, backpack: 0, need: 16 }), { action: 'use', reason: '背包里也没有，身上这 2 先用着' });

        // ---- countInBackpackSeen：读不到给 null，不是 0
        check('从没打开过背包 → null（读不到）', countInBackpackSeen({}, 'torch', null), null);
        check('背包记录里没这件 → 0（真的没有）', countInBackpackSeen({ backpackSeen: { items: { 'minecraft:coal': 4 } } }, 'torch', null), 0);
        check('背包记录里有火把 → 数出来', countInBackpackSeen({ backpackSeen: { items: { 'minecraft:torch': 12 } } }, 'torch', null), 12);
        check('带 minecraft: 前缀也能查到', countInBackpackSeen({ backpackSeen: { items: { 'minecraft:torch': 5 } } }, 'minecraft:torch', null), 5);
        check('predicate（垫脚方块这种任意一种）', countInBackpackSeen({ backpackSeen: { items: { 'minecraft:cobblestone': 64, 'minecraft:torch': 3 } } }, null, (it) => /cobblestone/.test(it.name)), 64);

        // ---- winInvCount：核对搬运要看**这个界面**的她自己的格，不是 bot.inventory（R-fix3-2）
        const Wt = (slots, start, end) => ({ slots, inventoryStart: start, inventoryEnd: end });
        const S = (name, count) => ({ name, count });
        check('winInvCount 只数 inventoryStart..inventoryEnd 段', winInvCount(Wt([S('torch', 3), S('torch', 5), S('coal', 9)], 1, 3), (it) => it.name === 'torch'), 5);
        check('背包自己的格（0..start）不算进去', winInvCount(Wt([S('torch', 99)], 1, 2), (it) => it.name === 'torch'), 0);
        check('没有界面时给 0，不抛', winInvCount(null, () => true), 0);

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

        // ★ R-fix3-4：没背背包时 lookIntoBackpack 不打开、也不声称看过
        check('★ 没背背包 → lookIntoBackpack 返回 false（不假装开过）', await lookIntoBackpack(mkBot([]), {}), false);

        // ---- ★ R-fix3-3 端到端：身上 1 根火把、背包记录里有 15 根、要 16 根
        //      决策必须走 fetch（而不是 use）；开不了界面 → unknown，绝不是 use
        const oneCarried = mkBot([{ name: 'torch', count: 1 }]);
        const r3 = await ensureCarried(oneCarried, { backpackSeen: { items: { 'minecraft:torch': 15 } } }, 'torch', 16);
        check('★ 要 16 根、身上只有 1、背包有记录 → 不能报 carried/use', r3.source !== 'carried', true);

        // ---- ★ R-fix3-7：中文名要解析成规范 ID 再比对（以前 `石镐` → `minecraft:石镐`）
        check('★ 中文名解析成规范 ID（石镐 → stone_pickaxe）', resolveCarryId('石镐'), 'minecraft:stone_pickaxe');
        check('★ 中文名解析成规范 ID（铁镐 → iron_pickaxe）', resolveCarryId('铁镐'), 'minecraft:iron_pickaxe');
        check('已是规范 ID 的不改变旧行为', resolveCarryId('minecraft:torch'), 'minecraft:torch');
        check('中文名也能在 ensureCarried 里对上（身上就有 → carried）',
          (await ensureCarried(mkBot([{ name: 'minecraft:stone_pickaxe', count: 1 }]), {}, '石镐', 1)).source, 'carried');

        // ---- ★ 第 8 批 第 2 条：随身装备一件都不许存（判据只有 isLoadoutItem 一处）
        //      假 bot 的 categoryOf 会走 registry（这里给一个空的），食物靠 foodScore 的 name 判
        const kb = { registry: { blocksByName: {}, itemsByName: {} } };
        const LO = (name) => isLoadoutItem(kb, { name });
        check('★ 最好的镐 → 随身装备', LO('minecraft:iron_pickaxe'), true);
        check('★ 木镐也是镐（工具一律不存）', LO('minecraft:wooden_pickaxe'), true);
        check('★ 模组镐也认（整合包）', LO('ltc2:steel_pickaxe'), true);
        check('★ 斧 → 随身装备', LO('minecraft:iron_axe'), true);
        check('★ 剑 → 随身装备', LO('minecraft:diamond_sword'), true);
        check('★ 火把 → 随身装备', LO('minecraft:torch'), true);
        check('★ 水桶 → 随身装备（落地水，保命的）', LO('minecraft:water_bucket'), true);
        check('★ 圆石 → 随身装备（搭脚方块）', LO('minecraft:cobblestone'), true);
        check('★ 铁锭 → 不是随身装备（该存起来）', LO('minecraft:iron_ingot'), false);
        // 吃的走 categoryOf → 需要真 registry；这里用 minecraft-data 造一个真 bot 验一遍
        {
          let realBot = null;
          try { const md = require('minecraft-data')('1.20.1'); realBot = { registry: { blocksByName: md.blocksByName, itemsByName: md.itemsByName } }; } catch (_) {}
          if (realBot) {
            check('★ 熟牛排 → 随身装备（吃的）', isLoadoutItem(realBot, { name: 'minecraft:cooked_beef' }), true);
            check('★ 面包 → 随身装备（吃的）', isLoadoutItem(realBot, { name: 'minecraft:bread' }), true);
            check('★ 钻石 → 不随身（该存）', isLoadoutItem(realBot, { name: 'minecraft:diamond' }), false);
            check('★ 木棍 → 不随身（该存）', isLoadoutItem(realBot, { name: 'minecraft:stick' }), false);
          } else {
            check('minecraft-data 不在 → 跳过食物判据（记一条）', true, true);
          }
        }
        check('★ 泥土里的石头？不 —— 石头算搭脚方块，随身', LO('minecraft:stone'), true);
        check('★ 钻石 → 不是随身装备', LO('minecraft:diamond'), false);
        check('★ 没名字的物品 → 不当随身装备（不误留）', isLoadoutItem(kb, {}), false);
        check('★ 判据是"复用 defaultLoadout"，不是另一份名单',
          /function isLoadoutItem[\s\S]{0,400}defaultLoadout\(\)/.test(handsSrc()), true);
        check('★ deposit 里对每件要存的东西都过一遍 isLoadoutItem',
          /isLoadoutItem\(bot, it\)[\s\S]{0,120}protectedItems\.push/.test(handsSrc()), true);
        check('★ containerPut（mind 点名塞某格）也拒绝随身装备',
          /isLoadoutItem\(bot, item\)\) throw/.test(handsSrc()), true);
      }
  }],
];
register('kit', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  // 单独跑本文件：先把总表接上（原来所有 hands 函数在同一作用域，小节随手就能取）。
  // 总表用汇总额外导出的 __ns（8 个文件的全部名字），不是那 47 个对外接口。
  require('./testkit').bindHands(require('./index').__ns);
  const { runSuite } = require('./testkit');
  runSuite('kit', __sections);
}
