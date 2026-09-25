#!/usr/bin/env node
/**
 * palette-guard-test.js —— 用**真实的坏样本**验证调色板的守门判据。
 *
 * ## 为什么需要它
 *
 * `registry/block-palette.json` 是 `extract_blockstates.py` 从模组 jar 反推出来的表
 * （`verified: false`）。它有个极危险的性质：**看起来完美**。
 *
 *   · 20217 条，一个方块一条，全覆盖；
 *   · **严格连续**，0 断点（`buildIndex` 的 gaps = 0）；
 *   · **原版区间完全正确**（那一部分是直接抄 minecraft-data 的）。
 *
 * 但模组部分的 state 数是数错的（MC 允许 `variants` 的键省略属性当通配符，
 * `glass_trapdoor` 真值 64 态只数得出 16 态），累计偏移从某处开始就崩了：
 *
 *     glass_trapdoor  表里 base = 239686   F3 实测 = 522768   差 283082 位
 *
 * 也就是说「连续性 + 原版交叉校验」这两道关**拦不住它** —— 必须有第三个判据。
 * 那个判据就是**玩家 F3 的锚点**（`palette-registry.js` 的 `DEFAULT_ANCHORS`）。
 *
 * 本脚本证明：
 *   1. 这份表确实是连续的、原版部分确实是对的；
 *   2. 只靠前两道关它会被**放行**（所以那两道关单独用是不够的）；
 *   3. 加上锚点之后它被**拒绝**，并且报出准确的偏移量。
 *
 * 跑法：`node scripts/palette-guard-test.js`
 * 退出码 0 = 守门判据都按预期工作。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const palette = require('../block-palette.js')
const paletteRegistry = require('../palette-registry.js')

const BAD = path.join(__dirname, '..', 'registry', 'block-palette.json')
const REAL = path.join(__dirname, '..', 'registry', 'angel_block_palette.txt')

let pass = 0; let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return }
  fail++
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`)
}

function main () {
  if (!fs.existsSync(BAD)) {
    console.log(`跳过：找不到坏样本 ${BAD}`)
    return 0
  }

  console.log(`坏样本：${BAD}`)
  const raw = JSON.parse(fs.readFileSync(BAD, 'utf8'))
  console.log(`  generatedBy=${raw.generatedBy}  verified=${raw.verified}  `
    + `条数=${raw.palette.length}  totalStates=${raw.totalStates}`)

  // 转成 dump 文本格式（blockId|firstStateId|count|name|propSpec）
  // ⚠️ 这份表里没有属性规格（它只有 state 个数），所以第 5 段留空。
  const dumpText = raw.palette.map(e => `${e.id}|${e.base}|${e.count}|${e.name}|`).join('\n')
  const parsed = palette.parseDump(dumpText)
  const index = palette.buildIndex(parsed.entries)

  console.log('\n[1] 结构检查 —— 这份表"看起来"是好的')
  ok('解析出 20217 条', parsed.entries.length === 20217, parsed.entries.length)
  ok('坏行 0 条', parsed.badLines.length === 0, parsed.badLines.length)
  ok('严格连续，0 断点（所以连续性判据拦不住它）', index.gaps === 0, index.gaps)

  const registry = require('prismarine-registry')('1.20.1')

  console.log('\n[2] 原版区间交叉校验 —— 也拦不住它')
  // 只用原版交叉校验跑一遍：不注入，只看 report
  const vanillaOnly = paletteRegistry.injectPalette(registry, index, { anchors: [] })
  ok('原版区间校验了 1003 条', vanillaOnly.vanillaChecked === 1003, vanillaOnly.vanillaChecked)
  ok('原版区间 0 处对不上（它是抄 minecraft-data 的，当然对）',
    vanillaOnly.vanillaMismatches.length === 0, JSON.stringify(vanillaOnly.vanillaMismatches.slice(0, 2)))
  ok('→ 只靠"连续性 + 原版校验"它会被放行（这就是危险所在）',
    vanillaOnly.ok === true, vanillaOnly.reason)

  // 这一步确实把错表注进去了，立刻清掉，别污染本进程的后续断言
  paletteRegistry.clearInjected(registry)

  console.log('\n[3] 锚点判据 —— 拦住了')
  const guarded = paletteRegistry.injectPalette(registry, index) // 用默认锚点
  ok('被拒绝', guarded.ok === false, guarded.reason)
  ok('拒绝原因指向锚点', /锚点校验失败/.test(guarded.reason || ''), guarded.reason)
  ok('锚点确实被检查了（不是"一个锚点都没匹配上"就放过）',
    guarded.anchorsChecked > 0, `${guarded.anchorsChecked} / missing ${guarded.anchorMissing.length}`)
  ok('报出了对不上的锚点', guarded.anchorViolations.length > 0,
    JSON.stringify(guarded.anchorViolations))

  for (const v of guarded.anchorViolations) {
    const off = v.offBy
    console.log(`     · ${v.name}（blockId ${v.blockId}）：表里区间 [${v.dumpRange.join(', ')}]，`
      + `F3 实测 stateId ${v.anchorStateId} → 差 ${off} 位`)
  }

  console.log('\n[4] 拒绝之后注册表必须是干净的')
  ok('没有注入任何 state', registry.blocksByStateId[24135] === undefined)
  ok('没有把错名字塞进 blocksByName', registry.blocksByName['quark:spruce_ladder'] === undefined)

  console.log('\n[5] 当前整合包真实 dump —— 全量认识原版扩容 + 模组区间')
  if (!fs.existsSync(REAL)) {
    ok('真实 dump 存在', false, REAL)
  } else {
    const realText = fs.readFileSync(REAL, 'utf8')
    const realParsed = palette.parseDump(realText)
    const realIndex = palette.buildIndex(realParsed.entries)
    const realRegistry = require('prismarine-registry')('1.20.1')
    const real = paletteRegistry.injectPalette(realRegistry, realIndex)
    ok('真实 dump 20217 条', realParsed.entries.length === 20217, realParsed.entries.length)
    ok('真实 dump 无坏行/重复', realParsed.badLines.length === 0 && realParsed.dupes === 0,
      `${realParsed.badLines.length}/${realParsed.dupes}`)
    ok('真实 dump 严格连续', realIndex.gaps === 0, realIndex.gaps)
    ok('真实 dump 总 state=826504', realIndex.totalStates === 826504, realIndex.totalStates)
    ok('真实 dump 注入成功', real.ok === true, real.reason)
    ok('真实 dump 原版校验 1003 条', real.vanillaChecked === 1003, real.vanillaChecked)
    ok('真实 dump 识别 31 个原版扩容', real.vanillaExpanded === 31, real.vanillaExpanded)
    ok('真实 dump 原版尾界=25019', real.vanillaStateEnd === 25019, real.vanillaStateEnd)
    ok('真实 dump overlay 原版 1003 个方块', real.overlayBlocks === 1003, real.overlayBlocks)
    ok('真实 dump 注入 19214 个模组方块', real.blocks === 19214, real.blocks)
    ok('真实 state 506805 是 cluttered:ancient_codex',
      realRegistry.blocksByStateId[506805]?.name === 'cluttered:ancient_codex',
      realRegistry.blocksByStateId[506805]?.name)
    ok('真实 state 522765 是 upgrade_aquatic:glass_trapdoor',
      realRegistry.blocksByStateId[522765]?.name === 'upgrade_aquatic:glass_trapdoor',
      realRegistry.blocksByStateId[522765]?.name)
    ok('扩容后 state 293 是 spruce_leaves',
      realRegistry.blocksByStateId[293]?.name === 'spruce_leaves', realRegistry.blocksByStateId[293]?.name)
    const Block = require('prismarine-block')(realRegistry)
    const realMod = Block.fromStateId(506805, 0)
    ok('真实模组方块 block.type 有服务端 id', realMod.type === 14286, realMod.type)
    ok('真实模组方块属性可读', realMod._properties.facing === 'north', JSON.stringify(realMod._properties))
    paletteRegistry.clearInjected(realRegistry)
    ok('真实 dump 清理后模组 state 不留幽灵', realRegistry.blocksByStateId[506805] === undefined)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  return fail ? 1 : 0
}

process.exit(main())
