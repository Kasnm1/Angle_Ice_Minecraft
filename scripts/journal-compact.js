#!/usr/bin/env node
/**
 * 一次性修复 `memory/journal.md` —— 把**连续重复**的条目折叠成 `×N`。
 *
 * 为什么需要单独的脚本：`journal.js` 的折叠只管**新写入**。既有文件里已经躺着
 * 217 行掉线刷屏（最长连续 104 次），不修的话下一个读记忆的 agent 还是得先刨噪声。
 *
 * 安全措施：
 * - 默认**先备份**成 `journal.md.bak-<时间戳>`，除非显式 `--no-backup`
 * - 默认 dry-run，只报数不改文件；要真改必须显式 `--write`
 * - 折叠规则与 journal.js 完全一致（同一份 `compactLines`），不另写一套
 *
 * 用法：
 *     node scripts/journal-compact.js                 # 预演，只报数
 *     node scripts/journal-compact.js --write         # 落盘（自动备份）
 *     node scripts/journal-compact.js --write --no-backup
 */

const fs = require('fs');
const path = require('path');
const { compactLines, formatEntry } = require('../journal.js');

const ROOT = path.resolve(__dirname, '..');
const JOURNAL = path.join(ROOT, 'memory', 'journal.md');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const NO_BACKUP = argv.includes('--no-backup');

function stamp () {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main () {
  if (!fs.existsSync(JOURNAL)) {
    console.error(`找不到记忆文件：${JOURNAL}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(JOURNAL, 'utf8');
  const lines = raw.split('\n');
  const result = compactLines(lines);

  const bytesBefore = Buffer.byteLength(raw, 'utf8');
  const after = result.lines.join('\n') + '\n';
  const bytesAfter = Buffer.byteLength(after, 'utf8');

  console.log(`记忆文件：${JOURNAL}`);
  console.log(`  行数  ${result.before} → ${result.after}   （折叠 ${result.folded} 次，减少 ${result.before - result.after} 行）`);
  console.log(`  体积  ${bytesBefore} → ${bytesAfter} 字节`);

  // 把折叠结果里带 ×N 的行列出来 —— 这就是被合并掉的重复事件
  const collapsed = result.lines.filter(l => /×\d+$/.test(l));
  if (collapsed.length) {
    console.log('\n被折叠的重复事件：');
    for (const l of collapsed) console.log(`  ${l}`);
  }

  if (!WRITE) {
    console.log('\n（预演模式，未改动文件。要落盘请加 --write）');
    return;
  }

  if (result.folded === 0) {
    console.log('\n没有可折叠的内容，文件未改动。');
    return;
  }

  if (!NO_BACKUP) {
    const bak = `${JOURNAL}.bak-${stamp()}`;
    fs.writeFileSync(bak, raw, 'utf8');
    console.log(`\n已备份 → ${bak}`);
  }

  fs.writeFileSync(JOURNAL, after, 'utf8');
  console.log('已写回。');
}

main();
