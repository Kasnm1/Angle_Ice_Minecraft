#!/usr/bin/env node
/**
 * fml-snapshot-test.js —— `parseSnapshot` 的契约测试（离线，不需要服务器）
 *
 * 为什么值得单独测：
 *   `ForgeRegistry.Snapshot` 的**网络版本**和 **NBT 版本**布局不一样
 *   （网络版 id 用 `writeVarInt`，NBT 版用 `putInt`）。这两种写法只差在
 *   "计数和整数到底几个字节"，而字节流错了**不会报错**，只会安静地解析出
 *   一堆垃圾名字 —— 那比直接崩掉更难查。
 *
 *   所以这里按 Forge 1.20.x 源码的 `getPacketData()` 手工造一段字节：
 *     ids:       writeMap        → varint 计数 + N × (writeUtf, varint)
 *     aliases:   writeMap        → varint 计数 + N × (writeUtf, writeUtf)
 *     overrides: writeMap        → varint 计数 + N × (writeUtf, writeUtf)
 *     blocked:   writeCollection → varint 计数 + N × varint
 *   再让 parseSnapshot 解回来，比对。
 *
 * 用法：node scripts/fml-snapshot-test.js
 */
const { parseSnapshot, Reader: R } = require('../fml-handshake.js');

// ---- 造字节用的小工具（故意不复用被测代码里的写函数，避免"自证"）----
function wVarint (n) {
  const out = [];
  n = n >>> 0;
  for (;;) {
    let t = n & 0x7f;
    n >>>= 7;
    if (n !== 0) t |= 0x80;
    out.push(t);
    if (n === 0) break;
  }
  return Buffer.from(out);
}
function wUtf (s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([wVarint(b.length), b]);
}

function buildSnapshot ({ ids = [], aliases = [], overrides = [], blocked = [] }) {
  const parts = [];
  parts.push(wVarint(ids.length));
  for (const [k, v] of ids) parts.push(wUtf(k), wVarint(v));
  parts.push(wVarint(aliases.length));
  for (const [k, v] of aliases) parts.push(wUtf(k), wUtf(v));
  parts.push(wVarint(overrides.length));
  for (const [k, v] of overrides) parts.push(wUtf(k), wUtf(v));
  parts.push(wVarint(blocked.length));
  for (const v of blocked) parts.push(wVarint(v));
  return Buffer.concat(parts);
}

// ---- Reader 直接复用实现里的那个 ----
// 之前这里自建了一个简化版，结果它没有越界检查 —— "截断负载要抛错"这条断言
// 测的其实是替身的行为，不是实现的行为。替身比实现宽松 = 测试自证。
// 现在从模块里 import，测的就是跑的。

let pass = 0; let fail = 0;
function ok (name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
}

// ------------------------------------------------------------------ 用例
console.log('fml-snapshot-test');

// 1. 一个"像 minecraft:block"的小表：含模组方块名
{
  const raw = buildSnapshot({
    ids: [
      ['minecraft:air', 0],
      ['minecraft:stone', 1],
      ['upgrade_aquatic:glass_trapdoor', 4321],
      ['cluttered:ancient_codex', 6543],
      ['香草纪元:中文方块', 7000], // 故意加个非 ASCII，验 UTF-8 长度按字节算
    ],
    aliases: [['old:name', 'minecraft:stone']],
    overrides: [['minecraft:foo', '{"a":1}']],
    blocked: [2, 3, 4],
  });
  const r = new R(raw);
  const s = parseSnapshot(r);
  ok('ids 条数 = 5', s.ids.size === 5, s.ids.size);
  ok('minecraft:air → 0', s.ids.get('minecraft:air') === 0);
  ok('minecraft:stone → 1', s.ids.get('minecraft:stone') === 1);
  ok('模组方块名保留完整', s.ids.get('upgrade_aquatic:glass_trapdoor') === 4321);
  ok('cluttered 那个也在', s.ids.get('cluttered:ancient_codex') === 6543);
  ok('非 ASCII 名按字节长度读对', s.ids.get('香草纪元:中文方块') === 7000, s.ids.get('香草纪元:中文方块'));
  ok('aliasCount = 1', s.aliasCount === 1, s.aliasCount);
  ok('overrideCount = 1', s.overrideCount === 1, s.overrideCount);
  ok('blockedCount = 3', s.blockedCount === 3, s.blockedCount);
  ok('字节正好吃完（remaining = 0）', r.remaining() === 0, r.remaining());
}

// 2. 空快照（四个计数全是 0）—— 这是"注册表存在但没有内容"的真实形态
{
  const raw = buildSnapshot({});
  const r = new R(raw);
  const s = parseSnapshot(r);
  ok('空快照：ids 为空', s.ids.size === 0);
  ok('空快照：全零计数', s.aliasCount === 0 && s.overrideCount === 0 && s.blockedCount === 0);
  ok('空快照：字节吃完', r.remaining() === 0);
  ok('空快照：总共 4 个字节（4 个 varint 0）', raw.length === 4, raw.length);
}

// 3. 大 id（>127）必须走 varint 多字节 —— 正是"NBT 用 putInt"会搞错的地方
{
  const raw = buildSnapshot({ ids: [['minecraft:stone', 300], ['mod:x', 100000]] });
  const r = new R(raw);
  const s = parseSnapshot(r);
  ok('id 300 解对（多字节 varint）', s.ids.get('minecraft:stone') === 300, s.ids.get('minecraft:stone'));
  ok('id 100000 解对（三字节 varint）', s.ids.get('mod:x') === 100000, s.ids.get('mod:x'));
  ok('大 id 后字节仍吃完', r.remaining() === 0, r.remaining());
}

// 4. 只写 ids、后面三个计数缺省 —— 必须抛错，不能"猜着解"
{
  const raw = Buffer.concat([wVarint(1), wUtf('minecraft:air'), wVarint(0)]);
  const r = new R(raw);
  let threw = false;
  try { parseSnapshot(r); } catch (_) { threw = true; }
  ok('截断的负载会抛错（而不是安静地解出半张表）', threw);
}

// 5. 反例守卫：如果哪天真把 id 当成 4 字节 int 读，这里会挂
{
  // 手工造一段"如果按 putInt 写会是什么样"，确认我们的解析器**读不出**正确结果，
  // 以此证明"网络版是 varint"这条假设是被测到的、不是顺口说的。
  const fourByte = Buffer.concat([
    Buffer.from([1]), wUtf('minecraft:stone'), Buffer.from([0x2c, 0x01, 0x00, 0x00]), // 300 的 BE int
    Buffer.from([0]), Buffer.from([0]), Buffer.from([0]),
  ]);
  const r = new R(fourByte);
  const s = parseSnapshot(r);
  ok('按 putInt 写的负载会被解成错的 id（证明两种格式确实不同）',
    s.ids.get('minecraft:stone') !== 300, s.ids.get('minecraft:stone'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
