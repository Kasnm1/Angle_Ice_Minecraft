#!/usr/bin/env node
'use strict';
/**
 * angelpal-to-palette.js —— 把客户端 KubeJS 脚本打出的 `ANGELPAL|` 日志行
 * 转成 /registry/import-palette 能吃的 dump 文本。
 *
 * 为什么需要它：
 *   `registry/zz_angel_dump_block_palette.js`（v3）只输出
 *     <注册序号>|<state个数>|<注册表数字id>|<方块名>|<属性规格>
 *   —— **故意不输出 base state id**，因为客户端那边取 state id 只有
 *   `Block.BLOCK_STATE_REGISTRY`（private）或 `Block.getId`（会被 KubeJS 的
 *   `BlockWrapper` 抢成"返回 ResourceLocation"），都有风险。
 *
 *   base 是可以**算**出来的：state id 按注册顺序连续分配，所以
 *     first[i] = Σ count[0..i-1]
 *   前缀和即可。再用 F3 锚点校验。
 *
 * 用法：
 *   node scripts/angelpal-to-palette.js                        # 默认读整合包 latest.log
 *   node scripts/angelpal-to-palette.js --in <日志路径> --out <输出路径>
 *   node scripts/angelpal-to-palette.js --selftest
 *
 * 输出格式（与 block-palette.js 的 parseDump 一致）：
 *   blockId|firstStateId|count|name|propSpec
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG = '<整合包目录>/logs/latest.log';   // 占位默认值：实际请用 --in 指定
// 文件名故意与 bridge-server.js 的 paletteCandidates() 里的一致 —— 配好 MC_PACK_DIR
// 之后桥接启动时就会自动找到并导入，不用手动 POST。
const DEFAULT_OUT = path.join(__dirname, '..', 'registry', 'angel_block_palette.txt');
const DEFAULT_REGISTRY = path.join(__dirname, '..', 'registry', 'minecraft-block.json');
const MARK = 'ANGELPAL|';

/**
 * 读取 Forge S2C 的服务端 block registry。ANGELPAL 自带的数字列来自客户端
 * entrySet 顺序（本包实测与 S2C id 相差 +3 等），不能直接拿来排 state；必须按
 * 同一方块名字映射回服务端快照 id。
 */
function loadRegistryMap (file = DEFAULT_REGISTRY) {
  if (!fs.existsSync(file)) return { ok: false, reason: `注册表文件不存在: ${file}` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, reason: `注册表 JSON 无法解析: ${e.message}` };
  }
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const map = new Map();
  const duplicateNames = [];
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [name, id] = pair;
    if (typeof name !== 'string' || !Number.isInteger(id) || id < 0) continue;
    if (map.has(name)) duplicateNames.push(name);
    else map.set(name, id);
  }
  return { ok: true, file, entries, map, duplicateNames };
}

// 原版方块总数（state 区间 0..24134 对应的方块个数）。
// 来源：Forge FML 握手快照，minecraft:block 共 20217 个，其中前 1003 个是原版。
const VANILLA_BLOCK_COUNT = 1003;

/** 从整段日志文本里抽出 ANGELPAL 行。纯函数，便于自测。 */
function extractRows (logText) {
  const rows = [];
  const bad = [];
  const lines = String(logText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(MARK);
    if (at < 0) continue;
    const payload = lines[i].slice(at + MARK.length).trim();
    // HEADER / DONE / ERROR 是自检行，不是数据行
    if (/^(HEADER|DONE|ERROR)\b/.test(payload)) continue;
    const p = payload.split('|');
    if (p.length < 4) { bad.push({ line: i + 1, why: '字段不足 4 个', payload }); continue; }
    const index = Number(p[0]);
    const count = Number(p[1]);
    const rid = Number(p[2]);
    const name = p[3];
    if (!Number.isInteger(index) || index < 0) { bad.push({ line: i + 1, why: `序号非法: ${p[0]}`, payload }); continue; }
    if (!Number.isInteger(count) || count <= 0) { bad.push({ line: i + 1, why: `state 个数非法: ${p[1]}`, payload }); continue; }
    if (!name) { bad.push({ line: i + 1, why: '方块名为空', payload }); continue; }
    rows.push({ index, count, rid: Number.isInteger(rid) ? rid : -1, name, spec: p[4] || '' });
  }
  return { rows, bad };
}

/** 读自检行里的统计（rows / zeroCount / noRid / badName）。 */
function extractHeader (logText) {
  const m = String(logText).match(/ANGELPAL-HEADER\|rows=(\d+)\|zeroCount=(\d+)\|noRid=(\d+)\|badName=(\d+)/);
  if (!m) return null;
  return { rows: +m[1], zeroCount: +m[2], noRid: +m[3], badName: +m[4] };
}

/**
 * 序号必须严格是 0..n-1。缺号说明日志被截断（例如 latest.log 轮转过），
 * 那样前缀和会整体偏移 —— 必须拒绝，宁可让用户重跑一次。
 */
function checkContinuity (rows) {
  const sorted = rows.slice().sort((a, b) => a.index - b.index);
  const missing = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].index !== i) { missing.push({ at: i, got: sorted[i].index }); if (missing.length >= 20) break; }
  }
  return { sorted, missing };
}

/**
 * Forge 的 block registry id 才是 state 分配顺序。ANGELPAL 的 index 是 entrySet
 * 遍历序号，模组服上两者已经被实测证明不相同；没有真实 rid 就不能安全生成表。
 */
function sortForState (rows) {
  return rows.slice().sort((a, b) => {
    const ai = Number.isInteger(a.blockId) ? a.blockId : a.rid;
    const bi = Number.isInteger(b.blockId) ? b.blockId : b.rid;
    return ai - bi;
  });
}

/** 前缀和：first[i] = Σ count[0..i-1]，调用方必须先按 blockId 排序。 */
function withPrefixSum (sorted) {
  let acc = 0;
  return sorted.map((r) => {
    const first = acc;
    acc += r.count;
    return { ...r, first };
  });
}

/** block registry id 必须完整、唯一、从 0 连续；否则 state 前缀和没有锚点。 */
function checkRegistryIds (rows) {
  const sorted = sortForState(rows);
  const missing = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].blockId !== i) {
      missing.push({ at: i, got: sorted[i].blockId });
      if (missing.length >= 20) break;
    }
  }
  return { sorted, missing };
}

/**
 * 原版段自校验：按真实 blockId 对齐 minecraft-data，允许整合包增加 state 数量，
 * 但不允许减少；每条 first 必须等于「本地 first + 前面已允许的累计扩容」。
 */
function checkVanilla (rows, mcData) {
  const refs = Object.values(mcData?.blocks || {})
    .filter(Boolean)
    .filter(b => Number.isInteger(b.id) && b.id >= 0 && b.id < VANILLA_BLOCK_COUNT)
    .sort((a, b) => a.id - b.id);
  const byId = new Map(rows.map(r => [r.blockId, r]));
  let checked = 0;
  let drift = 0;
  let expanded = 0;
  const missing = [];
  const mismatches = [];
  for (const ref of refs) {
    const r = byId.get(ref.id);
    if (!r) {
      if (missing.length < 8) missing.push({ blockId: ref.id, name: ref.name });
      continue;
    }
    checked++;
    const refName = String(ref.name).startsWith('minecraft:') ? ref.name : 'minecraft:' + ref.name;
    const refStates = (ref.minStateId != null && ref.maxStateId != null)
      ? ref.maxStateId - ref.minStateId + 1 : null;
    const expectedFirst = ref.minStateId + drift;
    const nameOk = refName === r.name || refName.replace(/^minecraft:/, '') === String(r.name).replace(/^minecraft:/, '');
    const firstOk = r.first === expectedFirst;
    const countOk = refStates != null && r.count >= refStates;
    if (!nameOk || !firstOk || !countOk) {
      if (mismatches.length < 20) {
        mismatches.push({
          blockId: ref.id,
          expect: { name: refName, first: expectedFirst, countAtLeast: refStates },
          got: { name: r.name, first: r.first, count: r.count },
          why: [nameOk ? null : '名字', firstOk ? null : '起始 state', countOk ? null : 'state 个数不足']
            .filter(Boolean).join('+'),
        });
      }
    }
    if (countOk) {
      if (r.count > refStates) expanded++;
      drift += r.count - refStates;
    }
  }
  return {
    checked,
    expected: refs.length,
    expanded,
    drift,
    vanillaStateEnd: refs.length ? Math.max(...refs.map(ref => {
      const r = byId.get(ref.id);
      return r ? r.first + r.count : 0;
    })) : 0,
    missing,
    mismatches,
  };
}

/** 与 palette-registry.js 的内置锚点对齐，做一次"导入前预演"。 */
function checkAnchors (rows) {
  const anchors = [
    { blockId: 14286, stateId: 506805, name: 'cluttered:ancient_codex' },
    { blockId: 15061, stateId: 522768, name: 'upgrade_aquatic:glass_trapdoor' },
  ];
  const byBlockId = new Map(rows.map((r) => [r.blockId, r]));
  const out = [];
  for (const a of anchors) {
    const r = byBlockId.get(a.blockId);
    if (!r) { out.push({ ...a, found: false }); continue; }
    const inRange = a.stateId >= r.first && a.stateId < r.first + r.count;
    out.push({
      ...a,
      found: true,
      gotStateId: r.first,
      gotName: r.name,
      dumpRange: [r.first, r.first + r.count - 1],
      inRange,
      delta: a.stateId - r.first,
    });
  }
  return out;
}

function toDumpText (rows) {
  return rows.map((r) => [r.blockId, r.first, r.count, r.name, r.spec].join('|')).join('\n') + '\n';
}

function run (opts) {
  const logPath = opts.in || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) {
    console.error(`日志不存在：${logPath}`);
    console.error('请先重启一次客户端，让 kubejs/startup_scripts/src/zz_angel_dump_block_palette.js 跑一遍。');
    return 2;
  }
  const logText = fs.readFileSync(logPath, 'utf8');
  const header = extractHeader(logText);
  const { rows, bad } = extractRows(logText);

  console.log(`日志：${logPath}`);
  if (header) console.log(`自检行：rows=${header.rows} zeroCount=${header.zeroCount} noRid=${header.noRid} badName=${header.badName}`);
  else console.log('⚠️ 没找到 ANGELPAL-HEADER 行 —— 脚本可能没跑，或跑失败了（去日志里 grep ANGELPAL-ERROR）');
  console.log(`抽到数据行：${rows.length}，坏行：${bad.length}`);
  for (const b of bad.slice(0, 5)) console.log(`   坏行 ${b.line}：${b.why}`);

  if (!rows.length) {
    console.error('没有可用数据行。');
    return 3;
  }

  const { sorted: entryOrder, missing } = checkContinuity(rows);
  if (missing.length) {
    console.error(`❌ 日志序号不连续（缺号 ${missing.length}+ 处，例如第 ${missing[0].at} 位期望 ${missing[0].at} 实得 ${missing[0].got}）`);
    console.error('   多半是日志轮转把中间截掉了。重跑一次客户端，或改用完整 debug.log。');
    return 4;
  }
  if (bad.length) {
    console.error(`❌ 日志含 ${bad.length} 条坏 ANGELPAL 行，拒绝生成可能错位的调色板`);
    return 4;
  }
  console.log(`日志序号连续：0..${entryOrder.length - 1} ✅`);

  // 绝不再把 ANGELPAL 自带的 entrySet 数字列当服务端 blockId。这个整合包
  // 已实测出现 dump 数字 id 与 Forge S2C id 不同的情况；正确身份来自名字→S2C 快照。
  const registryFile = opts.registry || DEFAULT_REGISTRY;
  const serverRegistry = loadRegistryMap(registryFile);
  if (!serverRegistry.ok) {
    console.error(`❌ ${serverRegistry.reason}`);
    return 4;
  }
  if (serverRegistry.duplicateNames.length) {
    console.error(`❌ 服务端注册表含 ${serverRegistry.duplicateNames.length} 个重复名字，拒绝生成`);
    return 4;
  }
  const unresolved = [];
  const rowsWithServerId = entryOrder.map((r) => {
    const blockId = serverRegistry.map.get(r.name);
    if (!Number.isInteger(blockId)) unresolved.push({ name: r.name, dumpRid: r.rid });
    return { ...r, blockId };
  });
  if (unresolved.length) {
    console.error(`❌ 有 ${unresolved.length} 个 ANGELPAL 方块名不在本地 Forge S2C 注册表中，拒绝猜测`);
    for (const x of unresolved.slice(0, 8)) console.error('   ', JSON.stringify(x));
    return 4;
  }
  const rowsByState = sortForState(rowsWithServerId);
  const idCheck = checkRegistryIds(rowsByState);
  if (idCheck.missing.length) {
    console.error(`❌ Forge S2C block registry id 不连续（例如位置 ${idCheck.missing[0].at} 得到 ${idCheck.missing[0].got}），拒绝生成`);
    return 4;
  }
  const rows2 = withPrefixSum(rowsByState);
  console.log(`已用本地 Forge S2C 注册表映射名字→blockId：${serverRegistry.map.size} 条`);
  console.log(`blockId 完整且按服务端 state 顺序排序：0..${rows2.length - 1} ✅`);

  const dupes = rows2.length - new Set(rows2.map((r) => r.blockId)).size;
  if (dupes) {
    console.error(`❌ blockId 有 ${dupes} 个重复，拒绝生成调色板`);
    return 4;
  }

  let mcData = null;
  try { mcData = require('minecraft-data')('1.20.1'); } catch (e) { /* handled below */ }
  if (!mcData || !mcData.blocks) {
    console.error('❌ 缺少 minecraft-data 1.20.1，不能安全校验原版布局');
    return 5;
  }
  const v = checkVanilla(rows2, mcData);
  if (v.missing.length || v.mismatches.length || v.checked !== v.expected) {
    console.error(`❌ 原版布局不通过（检查 ${v.checked}/${v.expected}，缺少 ${v.missing.length}，不符 ${v.mismatches.length}+）：`);
    for (const m of v.mismatches.slice(0, 8)) console.error('   ', JSON.stringify(m));
    return 5;
  }
  console.log(`原版布局自校验：${v.checked}/${v.expected} 个方块，允许扩容 ${v.expanded} 个，累计 drift=${v.drift}，尾界=${v.vanillaStateEnd} ✅`);

  console.log('\nF3 锚点预演：');
  const anchorResults = checkAnchors(rows2);
  for (const a of anchorResults) {
    if (!a.found) console.log(`   ⚠️ blockId ${a.blockId}（${a.name}）不在表里`);
    else console.log(`   ${a.name}: 区间 [${a.dumpRange.join(', ')}] / F3 state ${a.stateId} → `
      + `${a.inRange ? '命中 ✅' : `偏移 ${a.delta} ❌`}（表里名字是 ${a.gotName}）`);
  }
  if (anchorResults.some(a => !a.found || !a.inRange)) {
    console.error('❌ 至少一个 F3 锚点没有落在对应方块区间，拒绝生成调色板');
    return 6;
  }

  const outPath = opts.out || DEFAULT_OUT;
  fs.writeFileSync(outPath, toDumpText(rows2), 'utf8');
  console.log(`\n已写出 ${rows2.length} 行 → ${outPath}`);
  console.log(`总 state 数：${rows2[rows2.length - 1].first + rows2[rows2.length - 1].count}`);
  console.log('\n下一步：');
  console.log(`  curl --noproxy '*' -X POST -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"file":"${outPath.replace(/\\/g, '/')}"}' http://127.0.0.1:3001/registry/import-palette`);
  return 0;
}

// ------------------------------- 自测 -------------------------------
function selftest () {
  let pass = 0; let fail = 0;
  const ok = (label, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${label}`); } };

  // 1) 抽行：数据行 + 自检行混在一起
  const log = [
    '[18:07:07] [Worker/INFO] [KubeJS Startup/]: ANGELPAL|0|1|0|minecraft:air|',
    '[18:07:07] [Worker/INFO] [KubeJS Startup/]: ANGELPAL|1|8|196|minecraft:ladder|facing:north,south,west,east;waterlogged:true,false',
    '[18:07:07] [Worker/INFO] [KubeJS Startup/]: ANGELPAL-HEADER|rows=2|zeroCount=0|noRid=0|badName=0',
    '[18:07:07] [Worker/INFO] [KubeJS Startup/]: ANGELPAL-DONE|rows=2',
    '[18:07:07] [Worker/INFO] [KubeJS Startup/]: ANGELPAL-ERROR|boom',
    'random noise line',
  ].join('\n');
  const ex = extractRows(log);
  ok('抽到 2 条数据行（跳过 HEADER/DONE/ERROR）', ex.rows.length === 2);
  ok('解析出 ladder 的 count=8', ex.rows[1].count === 8 && ex.rows[1].name === 'minecraft:ladder');
  ok('解析出 rid', ex.rows[1].rid === 196);
  ok('保留属性规格', ex.rows[1].spec === 'facing:north,south,west,east;waterlogged:true,false');
  const hd = extractHeader(log);
  ok('解析 HEADER', hd && hd.rows === 2 && hd.noRid === 0);

  // 2) 坏行
  const ex2 = extractRows('ANGELPAL|0|0|0|minecraft:air|\nANGELPAL|x|1|0|n|\nANGELPAL|3|2|9\nANGELPAL|4|2|9|');
  ok('count<=0 判为坏行', ex2.bad.some((b) => /state 个数非法/.test(b.why)));
  ok('序号非法判为坏行', ex2.bad.some((b) => /序号非法/.test(b.why)));
  ok('字段不足判为坏行', ex2.bad.some((b) => /字段不足/.test(b.why)));
  ok('方块名为空判为坏行', ex2.bad.some((b) => /方块名为空/.test(b.why)));

  // 3) 连续性
  const cont = checkContinuity([{ index: 0 }, { index: 2 }]);
  ok('缺号能查出来', cont.missing.length > 0);
  ok('连续时无缺号', checkContinuity([{ index: 0 }, { index: 1 }]).missing.length === 0);

  // 4) 前缀和
  const ps = withPrefixSum([{ index: 0, count: 1 }, { index: 1, count: 8 }, { index: 2, count: 4 }]);
  ok('前缀和 first[0]=0', ps[0].first === 0);
  ok('前缀和 first[1]=1', ps[1].first === 1);
  ok('前缀和 first[2]=9', ps[2].first === 9);

  // 5) 原版自校验：按 blockId 对齐，允许扩容但拒绝错名/缩容
  const mcData = require('minecraft-data')('1.20.1');
  const vanillaRefs = Object.values(mcData.blocks).filter(Boolean)
    .filter(b => b.id >= 0 && b.id < VANILLA_BLOCK_COUNT).sort((a, b) => a.id - b.id);
  const goodRows = vanillaRefs.map(b => ({
    blockId: b.id,
    first: b.minStateId,
    count: b.maxStateId - b.minStateId + 1,
    name: `minecraft:${b.name}`,
  }));
  const goodCheck = checkVanilla(goodRows, mcData);
  ok('原版段一致时无 mismatch', goodCheck.mismatches.length === 0 && goodCheck.missing.length === 0);
  const expandedRows = goodRows.map(r => ({ ...r }));
  const expanded = expandedRows.find(r => r.blockId === 82);
  expanded.count += 28;
  for (const r of expandedRows) if (r.first > expanded.first) r.first += 28;
  const expandedCheck = checkVanilla(expandedRows, mcData);
  ok('原版 state 扩容时通过累计 drift', expandedCheck.mismatches.length === 0 && expandedCheck.drift === 28);
  const badRows = goodRows.map(r => ({ ...r }));
  badRows[0].name = 'minecraft:not_air';
  ok('原版名字错位时能抓到', checkVanilla(badRows, mcData).mismatches.some(m => m.blockId === 0));
  const badCount = goodRows.map(r => ({ ...r }));
  const badOak = badCount.find(r => r.blockId === 82);
  const oldCount = badOak.count;
  badOak.count = oldCount - 1;
  for (const r of badCount) if (r.first > badOak.first) r.first -= 1;
  ok('state 个数缩小时能抓到', checkVanilla(badCount, mcData).mismatches.some(m => m.blockId === 82 && /state 个数不足/.test(m.why)));

  // 6) state 顺序必须按 blockId，不按 entrySet index
  const order = sortForState([{ rid: 2, count: 1 }, { rid: 0, count: 1 }, { rid: 1, count: 1 }]);
  ok('按服务端 blockId 排序', order.map(r => r.rid).join(',') === '0,1,2');
  ok('blockId 连续性检查能抓缺号', checkRegistryIds([{ blockId: 0 }, { blockId: 2 }]).missing.length > 0);

  // 7) dump 文本格式能被 parseDump 吃（端到端形状）
  const txt = toDumpText([{ blockId: 196, first: 4654, count: 8, name: 'minecraft:ladder', spec: 'facing:north' }]);
  ok('dump 文本 5 字段', txt.trim().split('|').length === 5);
  ok('dump 文本以换行结尾', txt.endsWith('\n'));

  // 8) 锚点预演：state 落在区间内即可，不要求等于 first
  const an = checkAnchors([{ blockId: 14286, first: 506805, count: 8, name: 'cluttered:ancient_codex' }]);
  ok('锚点命中区间', an[0].found && an[0].inRange && an[0].delta === 0);
  const an2 = checkAnchors([{ blockId: 14286, first: 506800, count: 2, name: 'x' }]);
  ok('锚点落在区间外能报偏移', an2[0].inRange === false && an2[0].delta === 5);

  console.log(`\nangelpal-to-palette 自测：${pass} 通过 / ${fail} 失败`);
  return fail === 0 ? 0 : 1;
}

function main () {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') opts.in = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--registry') opts.registry = argv[++i];
  }
  process.exit(run(opts));
}

if (require.main === module) main();

module.exports = {
  extractRows,
  extractHeader,
  loadRegistryMap,
  checkContinuity,
  sortForState,
  withPrefixSum,
  checkRegistryIds,
  checkVanilla,
  checkAnchors,
  toDumpText,
};
