#!/usr/bin/env node
/**
 * 从 `minecraft-data` 生成**原版区间**的方块调色板 dump。
 *
 * ## 这东西解决什么、不解决什么
 *
 * ✅ **解决**：`stateId 0..24134` 这一段（1003 个原版方块）的精确映射 + 属性值。
 *    这一段的来源是 `minecraft-data` 自己的注册表，**不需要连服务端、不需要客户端 dump**。
 *    导入后 `GET /block` 会带上 `properties` / `propertiesText`（活板门的
 *    `open=true/false` 就靠它区分）。
 *
 * ❌ **不解决**：模组方块的 state 区间。那段是
 *    `24135 + Σ(前面每个模组方块的 state 数) + 局部序号`，而"每个模组方块的 state 数"
 *    只存在于模组代码的 `createBlockStateDefinition` 里 —— 数据文件里没有。
 *    从 jar 反推过，**结构性不可行**（见 registry/README.md 的"死路"一节）。
 *    所以本脚本产出的表在 `24135` 之后**就该查不到**，查不到是**诚实**的。
 *    模组段只能靠客户端 KubeJS dump（`zz_angel_dump_block_palette.js`）。
 *
 * ## 为什么值得生成
 *
 * * 它是**严格连续**的（本脚本会验证），所以能过 `POST /registry/import-palette`
 *   的安全阀 —— 而手写的部分 dump 一定过不了（安全阀要求全表连续，这是刻意的）。
 * * 它是个**可复现的 fixture**：换 MC 版本时重跑一次即可，不用靠记忆。
 *
 * ## 用法
 *
 *   node scripts/make-vanilla-palette.js              # 默认 1.20.1
 *   node scripts/make-vanilla-palette.js 1.21.1       # 换版本
 *   node scripts/make-vanilla-palette.js --stdout     # 只打印，不写文件
 *
 * 产物：`registry/vanilla-palette-<version>.txt`
 *
 * ⚠️ 产物**不会**被自动导入 —— `autoImportPalette()` 只认 `angel_block_palette.txt`。
 *    这是刻意的：原版段本来就靠 `prismarine-registry` 认得出来，自动导入它没有增益，
 *    却会让人误以为"调色板已经齐了"，从而错过模组段。要用就显式 POST 导入。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const toStdout = args.includes('--stdout');
const version = args.find(a => !a.startsWith('--')) || '1.20.1';

let mc;
try {
  mc = require('minecraft-data')(version);
} catch (e) {
  console.error(`✗ 拿不到 minecraft-data('${version}')：${e.message}`);
  process.exit(1);
}

const rows = [];
for (const name of Object.keys(mc.blocksByName)) {
  const b = mc.blocksByName[name];
  if (typeof b.minStateId !== 'number' || typeof b.maxStateId !== 'number') continue;
  const props = (b.states || []).map(s => {
    const vals = s.values || (s.type === 'bool' ? ['true', 'false'] : null);
    if (!vals || !vals.length) return null;
    return `${s.name}:${vals.join(',')}`;
  }).filter(Boolean).join(';');
  rows.push({
    id: b.id,
    first: b.minStateId,
    count: b.maxStateId - b.minStateId + 1,
    name: `minecraft:${name}`,
    props,
  });
}
rows.sort((a, b) => a.first - b.first);

// 连续性自检 —— 安全阀就是这个判据，先在这里过一遍，别让产物到运行时才被拒
let gaps = [];
let prev = null;
for (const r of rows) {
  if (prev !== null && prev.first + prev.count !== r.first) {
    gaps.push({ after: prev.name, expectFirst: prev.first + prev.count, actualFirst: r.first });
  }
  prev = r;
}
const totalStates = prev ? prev.first + prev.count : 0;

const text = rows.map(r => [r.id, r.first, r.count, r.name, r.props].join('|')).join('\n') + '\n';

console.log(`minecraft-data('${version}')`);
console.log(`  方块数        : ${rows.length}`);
console.log(`  覆盖 state    : 0..${totalStates - 1}（共 ${totalStates} 个）`);
console.log(`  连续性        : ${gaps.length ? `✗ ${gaps.length} 处断点` : '✓ 严格连续'}`);
if (gaps.length) {
  for (const g of gaps.slice(0, 5)) {
    console.log(`      after ${g.after}: 期望 ${g.expectFirst}，实际 ${g.actualFirst}`);
  }
  console.error('✗ 有断点，产物会被安全阀拒绝 —— 不写文件。');
  process.exit(1);
}
const lad = rows.find(r => r.name === 'minecraft:ladder');
if (lad) {
  console.log(`  ladder        : id ${lad.id} | state ${lad.first}..${lad.first + lad.count - 1} | ${lad.props}`);
}

if (toStdout) {
  process.stdout.write(text);
  process.exit(0);
}

const out = path.join(__dirname, '..', 'registry', `vanilla-palette-${version}.txt`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');
console.log(`\n✓ 已写 ${out}（${text.length} 字节）`);
console.log('  导入： curl --noproxy \'*\' -X POST -H "Content-Type: application/json" \\');
console.log(`           -d '{"file":"${out.replace(/\\/g, '\\\\')}"}' http://127.0.0.1:3001/registry/import-palette`);
