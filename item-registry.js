/**
 * item-registry.js —— 把「服务端物品注册表快照」**真正注入** prismarine 的 item 注册表。
 *
 * ## 为什么必须做这一步
 *
 * `prismarine-item/index.js:36` 的名字解析是：
 *
 *     const itemEnum = registry.items[type]
 *     if (itemEnum) {
 *       this.name = itemEnum.name
 *       this.displayName = itemEnum.displayName
 *       this.stackSize = itemEnum.stackSize
 *       this.maxDurability = itemEnum.maxDurability
 *     } else {
 *       this.name = 'unknown'          // ← 模组物品全落这里
 *       this.displayName = 'unknown'
 *       this.stackSize = 1
 *     }
 *
 * 而 `minecraft-data('1.20.1')` 只有 **1255 个原版物品（id 0..1254）**，
 * 本整合包有 **30729 个**。于是模组物品的 `i.name` 恒为 `'unknown'`。
 *
 * 后果不是"名字难看"这么轻 —— **一切按名字找物品的原语全部失效**：
 *   · `POST /drop {itemName}` —— 丢不出东西
 *   · `POST /equip {itemName}` —— 装备不上
 *   · `POST /craft {itemName}` / `POST /place {itemName}` —— 查不到物品
 *   · `POST /collect {itemName}` —— `registry.items[meta.itemId]?.name === itemName`
 *     恒不成立，**永远匹配不到地上的掉落物**（上一轮摘柠檬就卡在这：只能靠走过去蹭拾取）
 *   · 她自己**说不出手里拿的是什么**（`saveState()` 只能退回 `item#1284`）
 *
 * ## 数据来源（服务端真值，不猜）
 *
 * `registry/minecraft-item.json`，来自 Forge FML 握手的 `S2CRegistry` 快照：
 * `bridge-server.js` 的 `onSnapshot` **每次登录都会覆盖写**。格式：
 *
 *     { source, capturedAt, registry:"minecraft:item", host, entryCount,
 *       entries: [ [ "bountifulfares:lemon", 1284 ], ... ] }
 *
 * ## 为什么这里比方块调色板简单得多（关键差异，别照抄方块的复杂度）
 *
 * 方块要 prefix-sum 算 state id、要用玩家 F3 锚点钉住模组段的**累计偏移** ——
 * 因为 `stateId ≠ blockRegistryId`，中间隔着"每个方块的 state 数之和"。
 *
 * **物品没有 state 维度**：协议槽位里发的就是物品注册表 id 本身，快照给的也是它。
 * 所以这里只需要一条判据就够硬：
 *
 *   **原版前缀必须逐条一致** —— 对本地注册表里的每个原版物品 id，
 *   快照在同 id 上的名字（去掉 `minecraft:` 前缀后）必须逐字相同。
 *
 * 实测（2026-09-25，<私有服务器>）：**1255/1255 零差异、零缺失**，
 * 与方块的 1003/1003 同源同结论 —— 原版区间零位移，模组段从 id 1255 起。
 * 前缀一旦对齐，模组段就是**服务端直接给定**的 id，没有可累积的误差。
 *
 * ⚠️ 所以这里**允许断点**（实测 2 处：16960 → 16962）。方块调色板把"严格连续"
 *    当硬判据是因为它的 first 靠前缀和推；物品的 id 是快照直接给的，
 *    少几个 id 只会让那几个 id 仍然解析不出来，**不会让别的物品错位**。
 *    断点只报告、不拒绝 —— 这条差异是刻意的，别"顺手统一"成拒绝。
 *
 * ## 刻意不做的事
 *
 * 快照**只带 `名字 → id`**，不带 `stackSize` / `maxDurability` / `displayName`。
 * 所以：
 *   · `stackSize` 填 64（唯一读它的是 `mineflayer/lib/plugins/inventory.js` 的
 *     分堆启发式和村民交易，**不参与身份判定**）；
 *   · `maxDurability` **不填**（保持 undefined，与注入前 `else` 分支的行为一致，
 *     不会凭空给模组物品加上"有耐久"的语义）；
 *   · `displayName` 直接用全名（和方块那条 `buildRecord` 的做法一致）——
 *     宁可显示 `bountifulfares:lemon` 也不**编**一个"Lemon"出来。
 *
 * 记录上带 `angelInjected: true`，只用于 `clearInjected` 认自己的东西 + 调试。
 */

const fs = require('fs');
const path = require('path');

/**
 * `minecraft-data` 1.20.1 的原版物品基线。**只作为兜底常量**：
 * 真正的分界由本地注册表现算（见 `localItemIds`），这样 minecraft-data 升级后不会静默错位。
 */
const VANILLA_ITEM_FALLBACK = 1255;

/** 快照不带 stackSize；见文件顶部"刻意不做的事"。 */
const ASSUMED_STACK_SIZE = 64;

const REGISTRY_DIR = path.join(__dirname, 'registry');
const DEFAULT_SNAPSHOT = path.join(REGISTRY_DIR, 'minecraft-item.json');

/** 注入时**保留**快照里的全名（模组物品只有全名才不歧义），只在校验时归一化。 */
function normName (n) {
  const s = String(n ?? '');
  return s.startsWith('minecraft:') ? s.slice('minecraft:'.length) : s;
}

/** 读快照。文件不存在/坏掉都返回 null，由调用方决定是"跳过"还是"报错"。 */
function loadSnapshot (file = DEFAULT_SNAPSHOT) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.entries)) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

/**
 * 本地注册表**当前**的原版物品 id 列表（升序）。
 *
 * ⚠️ 注入之后 `registry.items` 里就混进了模组物品，再调它拿到的不是基线 ——
 * 所以 `injectItems` 优先用 `lastInjection.baseVanillaIds`（首次注入前存下的那份）。
 */
function localItemIds (registry) {
  return Object.keys(registry?.items || {})
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
}

/**
 * 纯快照侧的整理：不碰注册表，只把 `entries` 变成可查的索引 + 结构报告。
 *
 * @param {object} snapshot `loadSnapshot()` 的产物
 * @returns {{ok:boolean, reason:string|null, byId:Map, byName:Map, sorted:Array,
 *            total:number, badEntries:number, duplicateIds:number, duplicateNames:number,
 *            gapCount:number, gapSamples:Array, missingIds:Array, minId:number|null,
 *            maxId:number|null}}
 */
function buildIndex (snapshot) {
  const report = {
    ok: false,
    reason: null,
    byId: new Map(),
    byName: new Map(),
    sorted: [],
    total: 0,
    badEntries: 0,
    duplicateIds: 0,
    duplicateNames: 0,
    gapCount: 0,
    gapSamples: [],
    missingIds: [],
    minId: null,
    maxId: null,
  };
  if (!snapshot || !Array.isArray(snapshot.entries)) {
    report.reason = '快照为空或缺少 entries 数组';
    return report;
  }

  for (const e of snapshot.entries) {
    if (!Array.isArray(e) || e.length < 2) { report.badEntries++; continue; }
    const [name, id] = e;
    if (typeof name !== 'string' || !name) { report.badEntries++; continue; }
    if (!Number.isInteger(id) || id < 0) { report.badEntries++; continue; }
    if (report.byId.has(id)) { report.duplicateIds++; continue; }
    if (report.byName.has(name)) { report.duplicateNames++; continue; }
    report.byId.set(id, name);
    report.byName.set(name, id);
  }
  report.total = report.byId.size;

  if (report.badEntries) {
    report.reason = `快照含 ${report.badEntries} 条格式错误的记录（期望 [名字, 整数id]）—— 拒绝注入`;
    return report;
  }
  if (report.duplicateIds) {
    report.reason = `快照含 ${report.duplicateIds} 个重复 id —— 拒绝注入`;
    return report;
  }
  if (report.duplicateNames) {
    report.reason = `快照含 ${report.duplicateNames} 个重复名字 —— 拒绝注入`;
    return report;
  }
  if (!report.total) {
    report.reason = '快照里没有一条有效记录';
    return report;
  }

  report.sorted = [...report.byId.keys()].sort((a, b) => a - b);
  report.minId = report.sorted[0];
  report.maxId = report.sorted[report.sorted.length - 1];
  for (let i = 1; i < report.sorted.length; i++) {
    const prev = report.sorted[i - 1];
    const cur = report.sorted[i];
    if (cur !== prev + 1) {
      report.gapCount++;
      if (report.gapSamples.length < 5) report.gapSamples.push([prev, cur]);
      // 把缺失的 id 记下来（封顶，别把报告撑爆）—— 它们只是"解析不出来"，不错位。
      for (let m = prev + 1; m < cur && report.missingIds.length < 32; m++) report.missingIds.push(m);
    }
  }
  report.ok = true;
  return report;
}

/** 由快照的一条记录造一个物品记录。 */
function buildItemRecord (name, id) {
  return {
    id,
    name,
    displayName: name,
    stackSize: ASSUMED_STACK_SIZE,
    angelInjected: true,
  };
}

/** 上一次注入写进注册表的东西，换快照时要先清干净，不留幽灵。 */
let lastInjection = null;

/**
 * 清掉上一次注入。会**恢复被覆盖的旧槽位**，而不是简单 delete ——
 * 否则换一份快照后会留下半张 shifted registry。
 * @returns {number} 清掉/恢复的槽位数
 */
function clearInjected (registry) {
  if (!registry || !lastInjection) return 0;
  const byId = registry.items;
  const byName = registry.itemsByName;
  const arr = registry.itemsArray;
  let n = 0;
  for (const rec of lastInjection.records || []) {
    const { id, name } = rec;
    if (byId && byId[id] === rec) {
      const previous = lastInjection.previousById.get(id);
      if (previous === undefined) delete byId[id];
      else byId[id] = previous;
      n++;
    }
    if (Array.isArray(arr) && arr[id] === rec) {
      const previous = lastInjection.previousArray.get(id);
      if (previous === undefined) {
        // 数组不能用 delete 留洞（`length` 会保持被撑大）—— 截回原长度。
        arr.length = Math.min(arr.length, id);
      } else {
        arr[id] = previous;
      }
    }
    if (byName && byName[name] === rec) {
      const previous = lastInjection.previousByName.get(name);
      if (previous === undefined) delete byName[name];
      else byName[name] = previous;
    }
  }
  lastInjection = null;
  return n;
}

/**
 * 把物品注册表快照注入注册表。
 *
 * @param {object} registry `prismarine-registry('1.20.1')` 或 `bot.registry`
 *   （两者是**同一个对象**，所以离线导入、重连后依然有效）
 * @param {object} index `buildIndex()` 的产物
 * @param {{commit?: boolean}} [opts]
 *   `commit:false` 只做完整校验、不修改注册表（离线预检用）。
 * @returns {{ok:boolean, reason:string|null, note:string|null, modded:number,
 *            vanillaChecked:number, vanillaMismatches:Array, vanillaMissing:Array,
 *            gaps:number, gapSamples:Array, missingIds:Array,
 *            duplicateIds:number, duplicateNames:number, badEntries:number,
 *            vanillaItemCount:number|null, total:number, cleared:number, samples:Array,
 *            validationOnly?:boolean}}
 */
function injectItems (registry, index, opts = {}) {
  const report = {
    ok: false,
    reason: null,
    note: null,
    modded: 0,
    vanillaChecked: 0,
    vanillaMismatches: [],
    vanillaMissing: [],
    gaps: index?.gapCount ?? 0,
    gapSamples: index?.gapSamples ?? [],
    missingIds: index?.missingIds ?? [],
    duplicateIds: index?.duplicateIds ?? 0,
    duplicateNames: index?.duplicateNames ?? 0,
    badEntries: index?.badEntries ?? 0,
    vanillaItemCount: null,
    total: index?.total ?? 0,
    cleared: 0,
    samples: [],
  };

  if (!registry || !registry.items || !registry.itemsByName) {
    report.reason = 'registry.items / registry.itemsByName 不可用';
    return report;
  }
  if (!index || !index.ok) {
    report.reason = index?.reason || '快照索引不可用';
    return report;
  }

  // ---- 1. 定出原版/模组分界，并确认本地基线是"从 0 开始连续"的 ----
  // ⚠️ 分界必须取**注入前**存下的那份基线，不能用 `registry.items` 现算 ——
  //    注入之后注册表里已经混进 29474 个模组物品，现算出来的分界会跑到 30731，
  //    于是模组物品被当成"原版"去核对，全表崩掉。
  const base = lastInjection?.baseVanillaIds || localItemIds(registry);
  report.vanillaItemCount = base.length;
  if (!base.length) {
    report.reason = '本地注册表里没有任何原版物品，无法确定分界';
    return report;
  }
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== i) {
      report.reason = `本地原版物品 id 不是从 0 连续（第 ${i} 项是 ${base[i]}）—— 分界不可信，拒绝注入`;
      return report;
    }
  }
  const VAN = base.length;

  // ---- 2. 原版前缀逐条核对：这是唯一能钉住分界的判据 ----
  // 分界连续（`base === 0..VAN-1`）之后，"快照在原版区间多出本地不认识的 id"
  // 这件事在数学上不可能发生 —— 所以这里不需要那条分支，只需要双向核对名字。
  for (const id of base) {
    const local = registry.items[id];
    const snapName = index.byId.get(id);
    if (snapName === undefined) {
      if (report.vanillaMissing.length < 20) report.vanillaMissing.push({ id, local: local?.name ?? null });
      continue;
    }
    report.vanillaChecked++;
    if (normName(snapName) !== local?.name) {
      if (report.vanillaMismatches.length < 20) {
        report.vanillaMismatches.push({ id, server: snapName, local: local?.name ?? null });
      }
    }
  }
  if (report.vanillaMissing.length) {
    report.reason = `快照缺 ${report.vanillaMissing.length} 个原版物品（核对 ${report.vanillaChecked}/${VAN}）` +
      ' —— 分界不可信，拒绝注入';
    return report;
  }
  if (report.vanillaMismatches.length) {
    report.reason = `原版物品前缀校验失败（${report.vanillaMismatches.length} 处名字对不上）` +
      ' —— 说明服务端物品 id 与本地不一致，注入会让**所有**模组物品错名，拒绝注入';
    return report;
  }

  // ---- 3. 模组段（断点允许，只报告） ----
  const modded = index.sorted.filter(id => id >= VAN);
  if (!modded.length) {
    report.ok = true;
    report.note = '快照里没有模组物品（可能是原版服务端），无需注入';
    return report;
  }

  // ---- 4. 离线预检只验证，不碰任何注册表槽位 ----
  if (opts.commit === false) {
    report.validationOnly = true;
    report.ok = true;
    report.modded = modded.length;
    return report;
  }

  // ---- 5. 清掉上一次注入，保存被覆盖的旧槽位，然后写回 ----
  report.cleared = clearInjected(registry);
  const byId = registry.items;
  const byName = registry.itemsByName;
  const arr = Array.isArray(registry.itemsArray) ? registry.itemsArray : null;
  const previousById = new Map();
  const previousByName = new Map();
  const previousArray = new Map();
  const records = [];

  for (const id of modded) {
    const name = index.byId.get(id);
    const rec = buildItemRecord(name, id);
    if (byId[id] !== undefined && !previousById.has(id)) previousById.set(id, byId[id]);
    byId[id] = rec;
    if (arr) {
      if (arr[id] !== undefined && !previousArray.has(id)) previousArray.set(id, arr[id]);
      arr[id] = rec;
    }
    if (byName[name] !== undefined && !previousByName.has(name)) previousByName.set(name, byName[name]);
    byName[name] = rec;
    records.push(rec);
    if (report.samples.length < 5) report.samples.push({ id, name });
  }

  lastInjection = { records, baseVanillaIds: base.slice(), previousById, previousByName, previousArray };
  report.ok = true;
  report.modded = records.length;
  return report;
}

/** 上一次注入的摘要（给 `/config`、`/item` 用）。没有就返回 null。 */
function lastInjectionSummary () {
  if (!lastInjection) return null;
  return { items: lastInjection.records.length, vanillaItemCount: lastInjection.baseVanillaIds.length };
}

// ---------------------------------------------------------------- 自测

function selftest () {
  let pass = 0; let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
  };
  const clone = snap => ({ ...snap, entries: snap.entries.map(e => e.slice()) });

  const registry = require('prismarine-registry')('1.20.1');
  const Item = require('prismarine-item')(registry);

  // ---- 0. 本地基线 ----
  const baseIds = localItemIds(registry);
  ok('本地原版物品 0..1254 连续', baseIds.length === VANILLA_ITEM_FALLBACK && baseIds[baseIds.length - 1] === VANILLA_ITEM_FALLBACK - 1,
    `${baseIds.length} 条，末尾 ${baseIds[baseIds.length - 1]}`);
  ok('本地 registry.itemsArray 是数组', Array.isArray(registry.itemsArray));
  ok('normName 去掉 minecraft: 前缀', normName('minecraft:stone') === 'stone' && normName('a:b') === 'a:b');

  // ---- 1. 真快照（真的读盘，不是造的假数据）----
  const real = loadSnapshot();
  ok('真快照能读出来', !!real, DEFAULT_SNAPSHOT);
  if (!real) { console.log(`\n${pass} passed, ${fail} failed`); return fail ? 1 : 0; }
  ok('真快照 registry === minecraft:item', real.registry === 'minecraft:item');
  ok('真快照 entryCount 与 entries 一致', real.entryCount === real.entries.length, `${real.entryCount} vs ${real.entries.length}`);

  const idx = buildIndex(real);
  ok('真快照 buildIndex ok', idx.ok, idx.reason);
  ok('真快照无重复 id', idx.duplicateIds === 0);
  ok('真快照无重复名字', idx.duplicateNames === 0);
  ok('真快照无坏条目', idx.badEntries === 0);
  ok('真快照断点 2 处且被报告', idx.gapCount === 2, `gapCount=${idx.gapCount}`);
  ok('断点样本是 [16960,16962]', JSON.stringify(idx.gapSamples[0]) === '[16960,16962]', JSON.stringify(idx.gapSamples[0]));
  ok('缺失 id 里含 16961', idx.missingIds.includes(16961));
  ok('真快照 byName 认得 bountifulfares:lemon', idx.byName.get('bountifulfares:lemon') === 1284,
    String(idx.byName.get('bountifulfares:lemon')));

  // ---- 2. 离线预检：不改注册表 ----
  const pre = injectItems(registry, idx, { commit: false });
  ok('预检通过', pre.ok, pre.reason);
  ok('预检 vanillaChecked === 1255', pre.vanillaChecked === VANILLA_ITEM_FALLBACK, String(pre.vanillaChecked));
  ok('预检 modded === 29474', pre.modded === 29474, String(pre.modded));
  ok('预检标记 validationOnly', pre.validationOnly === true);
  ok('预检没碰注册表', registry.items[1284] === undefined && registry.itemsByName['bountifulfares:lemon'] === undefined);
  ok('预检没撑大 itemsArray', registry.itemsArray.length === VANILLA_ITEM_FALLBACK, String(registry.itemsArray.length));

  // ---- 3. 真正注入 ----
  const rep = injectItems(registry, idx);
  ok('注入成功', rep.ok, rep.reason);
  ok('注入条数 29474', rep.modded === 29474, String(rep.modded));
  ok('注入记下了 cleared', rep.cleared === 0, String(rep.cleared));
  ok('registry.items[1284] 有值', !!registry.items[1284]);
  ok('registry.items[1284].name 正确', registry.items[1284].name === 'bountifulfares:lemon');
  ok('registry.itemsByName 反向可查', registry.itemsByName['bountifulfares:lemon'] === registry.items[1284]);
  ok('registry.itemsArray 同步', registry.itemsArray[1284] === registry.items[1284]);

  // 端到端：真的用 prismarine-item 构造一个槽位物品（这才是最终判据）
  // ⚠️ `Item` 的第一个参数是**数字 id**，不是注册表记录对象 —— 传记录对象会走到
  //    `registry.items[对象]` 查不到，照样得到 'unknown'（自测第一版就踩了这个坑）。
  const lemon = new Item(idx.byName.get('bountifulfares:lemon'), 1);
  ok('prismarine-item 解析出名字', lemon.name === 'bountifulfares:lemon', lemon.name);
  ok('prismarine-item displayName 不再是 unknown', lemon.displayName === 'bountifulfares:lemon', lemon.displayName);
  const cake = new Item(idx.byName.get('abnormals_delight:adzuki_cake_slice'), 1);
  ok('另一个模组物品也解析得出来', cake.name === 'abnormals_delight:adzuki_cake_slice', cake.name);
  const stone = new Item(1, 1);
  ok('原版物品不受影响', stone.name === 'stone' && stone.displayName === 'Stone', `${stone.name}/${stone.displayName}`);
  ok('模组段最小 id 就是 1255', idx.sorted.find(id => id >= VANILLA_ITEM_FALLBACK) === VANILLA_ITEM_FALLBACK);

  // ---- 4. 重复注入不留幽灵 ----
  const rep2 = injectItems(registry, idx);
  ok('重复注入仍成功', rep2.ok, rep2.reason);
  ok('重复注入清掉了上一轮 29474 条', rep2.cleared === 29474, String(rep2.cleared));
  ok('重复注入后仍是同一份记录', registry.items[1284].name === 'bountifulfares:lemon');
  ok('itemsByName 没有多出别名', Object.keys(registry.itemsByName).filter(n => n === 'bountifulfares:lemon').length === 1);

  // ---- 5. 清干净后回到注入前 ----
  const cleared = clearInjected(registry);
  ok('clearInjected 清掉 29474 条', cleared === 29474, String(cleared));
  ok('items[1284] 已删除', registry.items[1284] === undefined);
  ok('itemsByName 已删除', registry.itemsByName['bountifulfares:lemon'] === undefined);
  ok('itemsArray 长度回到 1255', registry.itemsArray.length === VANILLA_ITEM_FALLBACK, String(registry.itemsArray.length));
  ok('清完后 unknown 复现', new Item(1284, 1).name === 'unknown');
  ok('lastInjectionSummary 归零', lastInjectionSummary() === null);

  // ---- 6. 负例：每种坏快照都必须被拒 ----
  const badName = clone(real);
  for (const e of badName.entries) if (e[1] === 1) e[0] = 'minecraft:stnoe';
  const r1 = injectItems(registry, buildIndex(badName), { commit: false });
  ok('原版名字错 → 拒绝', !r1.ok && r1.vanillaMismatches.length === 1, r1.reason);

  const missing = clone(real);
  missing.entries = missing.entries.filter(e => e[1] !== 1);
  const r2 = injectItems(registry, buildIndex(missing), { commit: false });
  ok('原版缺一条 → 拒绝', !r2.ok && r2.vanillaMissing.length === 1, r2.reason);

  const shifted = clone(real);
  for (const e of shifted.entries) if (e[1] === 1250) e[1] = 1250.5;
  // 1250.5 不是整数 → 坏条目
  const r3 = buildIndex(shifted);
  ok('非整数 id → 坏条目拒绝', !r3.ok && r3.badEntries === 1, r3.reason);

  const dup = clone(real);
  dup.entries.push(['bountifulfares:lemon', 20000]);
  const r4 = buildIndex(dup);
  ok('重复 id → 拒绝', !r4.ok && r4.duplicateIds === 1, r4.reason);

  const dupName = clone(real);
  dupName.entries.push(['bountifulfares:lemon', 31000]);
  const r5 = buildIndex(dupName);
  ok('重复名字 → 拒绝', !r5.ok && r5.duplicateNames === 1, r5.reason);

  ok('空 entries → 拒绝', !buildIndex({ entries: [] }).ok);
  ok('没有 entries → 拒绝', !buildIndex({}).ok);
  ok('null 快照 → 拒绝', !buildIndex(null).ok);

  // 本地基线不连续 → 拒绝。用"把注册表里一个原版 id 挖掉"来造这个局面 ——
  // 这是**可达**的真实场景（minecraft-data 换了、或注册表被别处改坏），不靠测试后门。
  const savedItems5 = registry.items[5];
  const savedArray5 = registry.itemsArray[5];
  delete registry.items[5];
  const r7 = injectItems(registry, idx, { commit: false });
  ok('本地基线不连续 → 拒绝', !r7.ok && /不是从 0 连续/.test(r7.reason || ''), r7.reason);
  registry.items[5] = savedItems5;
  registry.itemsArray[5] = savedArray5;
  ok('恢复后重新通过校验', injectItems(registry, idx, { commit: false }).ok);

  // 没有模组物品的快照 → 不算失败，只是无需注入
  const pureVanilla = { registry: 'minecraft:item', entries: real.entries.filter(e => e[1] < VANILLA_ITEM_FALLBACK) };
  const r8 = injectItems(registry, buildIndex(pureVanilla), { commit: false });
  ok('纯原版快照 → ok 但 modded=0', r8.ok && r8.modded === 0 && /没有模组物品/.test(r8.note || ''), JSON.stringify(r8.note));

  // 注入被拒时不能留下半张表
  ok('被拒后注册表仍然干净', registry.items[1284] === undefined && lastInjectionSummary() === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = {
  VANILLA_ITEM_FALLBACK,
  ASSUMED_STACK_SIZE,
  DEFAULT_SNAPSHOT,
  normName,
  loadSnapshot,
  localItemIds,
  buildIndex,
  buildItemRecord,
  injectItems,
  clearInjected,
  lastInjectionSummary,
  selftest,
};

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
