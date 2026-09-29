'use strict';

/**
 * `src/world/pathing.js` 的自测 —— 第 3 步重构（2026-09-29）从原文件**原样搬出**，
 * 断言一条没改、一条没少（拆前拆后都是 475 条）。
 *
 * 为什么单独一个文件：自测用的是**子文件之间的公共接口 + 子文件的模块级常量**
 * （`isProtected` / `COSTS` / `applyOpenDoors` / `ALLOW_DIG` …），放进任何子文件都会
 * 变成"兄弟文件互相 require"（那正是 `src/body/AGENTS.md` 里写的环）。
 * 汇总 `index.js` 加载完所有子文件后调 `run(api)`，把一张**名字 → 值**的表递进来。
 *
 * ⚠️ **`require.main === module` 守卫在 `run()` 外面**（文件最末尾那个 `if`）。
 *    原来那段自测是裸的 `if (process.argv.includes('--selftest'))` —— 任何**被 require
 *    进来**的进程只要命令行里有 `--selftest` 就会连带触发 pathing 的自测。实测：
 *    `node palette-registry.js --selftest` 打出来的是 pathing 的用例，自己的用例一条
 *    没跑（而且退出码是 pathing 的）。这就是"加载时求值"那类坑。
 *    **这个守卫不能挪进 `run()` 里**：那样 `run()` 只有在"自己是被直接跑的那个文件"
 *    时才会干活，而直接跑 `pathing.js` / `pathing/index.js` 时 `require.main` 是它们
 *    （不是本文件）—— `node src/world/pathing.js --selftest` 会变成**静默什么都不跑**
 *    还返回 0。所以由汇总把 `__ns` 递进 `run(api)`，跑不跑的判断留在本文件末尾。
 *
 * ⚠️ 全仓只有 bridge-server.js require `../world/pathing`，且从不带 `--selftest`，
 *    所以"被 require 时不跑"这条约束靠上面那个守卫守住。
 */
module.exports = function run (api) {
  // 只有汇总在自己被直接跑（`node src/world/pathing.js --selftest`）时才置位，见文件末尾。
  if (!__requested) return;
  const { naturalDigNames, setDigPolicy, setDropAllowance, setScaffold, MLG_DROP, bareName,
    isProtected, PROTECTED_PATTERNS, COSTS, ALLOW_DIG, buildProtectedIds, applyPolicy,
    probeRegistry, summarizeProbe, CLIMBABLE_STATE_IDS, parseIdList, parseNameList,
    resolveClimbableIds, resolveClimbableBlockIds, applyClimbables, applyOpenDoors,
    lowBlockHeight, probeClimbables, installLadderFix, UNKNOWN_BLOCK_SOLID,
    PASSABLE_STATE_IDS, FULL_CUBE, EMPTY_SHAPES, isUnknownBlock, needsShapeFallback,
    THIN_BLOCK_PASSABLE, THIN_BLOCK_SUFFIXES, THIN_BLOCK_DENY, isThinBlockName,
    applyUnknownBlockPolicy, faceTowardBlock, LIQUID_NAMES, MAX_VERTICAL_FLOW_LOOKAHEAD,
    assessExcavationFluidRisk, isFlowPassable, injectFluidBreakGuard, PATH_STEP_MS,
    SPRINT_SPEED, PATH_MIN_TIMEOUT_MS, PATH_MAX_TIMEOUT_MS, PATH_PROGRESS_INTERVAL_MS,
    PATH_STAGNATION_THRESHOLD, MAX_STAGNANT_CHECKS, clearPathfinderGoal, createGoalOwner,
    classifyGotoOutcome, installPhysicsTickGuard, stepKind, stepCostMs, estimatePathTimeMs,
    computeTimeoutFromEta, computeHardCap, createStagnationMonitor, COLLECT_SEARCH,
    buildRadiusLadder, isProductiveSweep, nextCollectStep,
    // 原来是模块内私有、不在对外 module.exports 里的（汇总经 movements.__selftest 递过来）：
    dropPenalty, MAX_DROP, NATURAL_EXTRA, NOT_NATURAL_RE, paths } = api;
// ------------------------------------------------------------------ 自测

// ⚠️ 必须带 `require.main === module`。
//    这里原来是裸的 `if (process.argv.includes('--selftest'))` —— 任何**被 require 进来**
//    的进程只要命令行里有 `--selftest` 就会连带触发本文件的自测。
//    实测：`node palette-registry.js --selftest` 打出来的是 pathing 的用例，
//    自己的用例一条没跑（而且退出码是 pathing 的）。这就是"加载时求值"那类坑。
//    全仓只有 bridge-server.js require 本模块，且从不带 `--selftest`，
//    所以收紧成 require.main 守卫不影响任何现有调用方（decision.js / place.js /
//    block-palette.js 本来就是这么写的）。
  {   // 原来是 `if (require.main === module && process.argv.includes('--selftest')) {`；
      // 判断挪到了文件末尾（见那里注释：不能放 run() 里面，否则直接跑 pathing.js 会静默不跑）。
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = got === expect;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  };

  console.log('\n[1/7] 受保护判定 —— 建筑材料一格都不许动');
  const SHOULD_PROTECT = [
    'white_wool', 'red_wool', 'oak_planks', 'spruce_planks', 'glass',
    'glass_pane', 'white_stained_glass_pane', 'oak_door', 'oak_trapdoor',
    'oak_stairs', 'oak_slab', 'oak_fence', 'oak_fence_gate', 'cobblestone_wall',
    'stone_bricks', 'white_concrete', 'terracotta', 'oak_log', 'stripped_oak_log',
    'chest', 'barrel', 'furnace', 'bookshelf', 'oak_sign', 'torch', 'lantern',
    'red_bed', 'crafting_table', 'diamond_ore', 'deepslate_iron_ore',
    'ancient_debris', 'white_carpet', 'oak_button', 'rail', 'white_banner',
  ];
  for (const n of SHOULD_PROTECT) check(`保护 ${n}`, isProtected(n), true);

  console.log('\n[2/7] 不该保护 —— 自然地形必须留作最后手段');
  const SHOULD_NOT = [
    'dirt', 'stone', 'grass_block', 'sand', 'gravel', 'deepslate',
    'netherrack', 'oak_leaves', 'cobblestone', 'coal_block', 'andesite',
    'tuff', 'clay', 'snow_block', 'moss_block', 'soul_sand',
  ];
  for (const n of SHOULD_NOT) check(`不保护 ${n}`, isProtected(n), false);

  console.log('\n[3/7] 名字归一与边界');
  check('剥命名空间：quark:oak_planks 仍受保护', isProtected('quark:oak_planks'), true);
  check('剥命名空间：create:dirt 仍不受保护', isProtected('create:dirt'), false);
  check('null 不炸且不保护', isProtected(null), false);
  check('undefined 不炸且不保护', isProtected(undefined), false);
  check('空串不保护', isProtected(''), false);
  check('数字不炸且不保护', isProtected(42), false);
  check('裸名归一：quark:oak_planks → oak_planks', bareName('quark:oak_planks'), 'oak_planks');
  check('无命名空间原样返回', bareName('oak_planks'), 'oak_planks');

  console.log('\n[4/7] 代价与装配 —— 核心不变量');
  // 这是整个修复的核心：走一格 = 1，所以 digCost 必须远大于 1，
  // 否则"拆墙"比"绕路"便宜，她就会拆房子（这就是原来那个 bug）。
  check('digCost 远大于"走一格"的 1（否则拆墙比绕路便宜）', COSTS.digCost >= 10, true);
  check('digCost 是有限值（无限大会让最后手段消失，退回 canDig=false 的毛病）',
    Number.isFinite(COSTS.digCost) && COSTS.digCost < 100, true);
  check('placeCost 为正', COSTS.placeCost > 0, true);
  check('liquidCost 为正（走水路要更贵，免得她一路涉水）', COSTS.liquidCost > 0, true);

  // 假注册表：验证 ID 装配与"只增不减"
  const fakeReg = {
    blocksByName: {
      white_wool: { id: 101 }, oak_planks: { id: 102 }, oak_log: { id: 103 },
      diamond_ore: { id: 104 }, dirt: { id: 105 }, stone: { id: 106 },
    },
  };
  const built = buildProtectedIds(fakeReg.blocksByName);
  check('保护集合只装该保护的（4 个）', built.ids.size, 4);
  check('dirt 不在保护集合里', built.ids.has(105), false);
  check('stone 不在保护集合里', built.ids.has(106), false);
  check('white_wool 在保护集合里', built.ids.has(101), true);
  check('diamond_ore 在保护集合里', built.ids.has(104), true);
  check('matched 里没有 dirt', built.matched.includes('dirt'), false);

  const fakeMv = { blocksCantBreak: new Set([999]), blocksToAvoid: new Set() };
  const summary = applyPolicy(fakeMv, fakeReg.blocksByName);
  check('默认只拆树叶：canDig 开、leavesOnly', fakeMv.canDig === true && summary.leavesOnly === true, true);
  check('默认 allowDig 关', summary.allowDig, false);
  const brk = (name) => fakeMv.exclusionAreasBreak.reduce((a, f) => a + f({ name }), 0);
  check('树叶能拆（代价 0）', brk('oak_leaves'), 0);
  fakeMv.bot = { entity: { position: { y: 70.0 } } };
  const brkAt = (name, y) => fakeMv.exclusionAreasBreak.reduce((a, f) => a + f({ name, position: { y } }), 0);
  check('脚下的树叶不拆', brkAt('oak_leaves', 69) >= 100, true);
  check('身体高度的树叶能拆', brkAt('oak_leaves', 70), 0);
  check('不跑酷、最多往下跳 8 格', fakeMv.allowParkour === false && fakeMv.maxDropDown === 8, true);
  check('跳 3 格不加代价、5 格加 80、8 格加 200', [dropPenalty(3), dropPenalty(5), dropPenalty(8)].join(','), '0,80,200');
  {
    const mv2 = { blocksCantBreak: new Set(), blocksToAvoid: new Set(),
      getMoveDropDown (node, dir, nb) { nb.push({ y: node.y - 2, cost: 1 }, { y: node.y - 6, cost: 1 }); },
      getMoveDown (node, nb) { nb.push({ y: node.y - 5, cost: 1 }); } };
    applyPolicy(mv2, fakeReg.blocksByName); applyPolicy(mv2, fakeReg.blocksByName);
    const nb = []; mv2.getMoveDropDown({ y: 70 }, {}, nb); mv2.getMoveDown({ y: 70 }, nb);
    check('跳落代价真的加上了（且重复 apply 不叠加）', nb.map(m => m.cost).join(','), '1,121,81');
  }
  check('石头、原木不能拆（≥100）', brk('stone') >= 100 && brk('oak_log') >= 100, true);
  applyPolicy(fakeMv, fakeReg.blocksByName);
  check('重复 apply 不叠加', fakeMv.exclusionAreasBreak.filter(f => f.__leavesOnly).length, 1);
  check('digCost 已写入', fakeMv.digCost, COSTS.digCost);
  check('placeCost 已写入', fakeMv.placeCost, COSTS.placeCost);
  check('liquidCost 已写入', fakeMv.liquidCost, COSTS.liquidCost);
  check('allow1by1towers 关闭（不垫方块爬高）', fakeMv.allow1by1towers, false);
  check('scafoldingBlocks 清空（不消耗玩家材料）', fakeMv.scafoldingBlocks.length, 0);
  // 搭路 / 落地水（instinct.js 按身上的东西随时调）
  check('★ 有水桶 → 允许跳到 MLG_DROP', setDropAllowance(fakeMv, { water: true }), MLG_DROP);
  check('★ 下界有水桶也不放宽（水会蒸发）', setDropAllowance(fakeMv, { water: true, nether: true }), MAX_DROP);
  check('没水桶 → 回到 8 格', setDropAllowance(fakeMv, {}), MAX_DROP);
  const sc = setScaffold(fakeMv, { itemIds: [1, 2], forbid: (p) => p.x === 0 });
  check('★ 带着搭脚方块 → 能搭路、能垫高', sc.scaffolding === 2 && fakeMv.allow1by1towers === true, true);
  const guard = fakeMv.exclusionAreasPlace.find(f => f.__noPlaceGuard);
  check('★ 家里不许放（代价 ≥100）', guard({ position: { x: 0, y: 64, z: 0 } }) >= 100 && guard({ position: { x: 5, y: 64, z: 0 } }) === 0, true);
  setScaffold(fakeMv, { itemIds: [3] });
  check('再设一次不会叠两道闸', fakeMv.exclusionAreasPlace.filter(f => f.__noPlaceGuard).length, 0);
  setScaffold(fakeMv, {});
  check('没带搭脚方块 → 不搭（回到老行为）', fakeMv.scafoldingBlocks.length === 0 && fakeMv.allow1by1towers === false, true);
  // 寻路挖掘白名单
  const tags = { 'forge:stone': new Set(['minecraft:stone', 'somemod:limestone', 'somemod:polished_limestone']), 'minecraft:dirt': new Set(['minecraft:dirt']) };
  const nat = naturalDigNames(t => tags[t]);
  check('★ 模组天然石头（打了 forge:stone）→ 能挖', nat.has('somemod:limestone'), true);
  check('★ 加工过的（polished）哪怕在标签里 → 不挖', nat.has('somemod:polished_limestone'), false);
  check('★ 圆石不挖（常被拿来盖房子）', nat.has('minecraft:cobblestone'), false);
  check('原版砂砾在里面', nat.has('minecraft:gravel'), true);
  check('★ 原版泥土在里面（标签里缺，靠补充名单）', nat.has('minecraft:dirt'), true);
  check('★ 查不到天然生成证据的（WorkBuddy 复查）不挖', naturalDigNames(t => (t === 'minecraft:dirt' ? new Set(['biomeswevegone:lush_dirt', 'quark:limestone']) : undefined)).has('biomeswevegone:lush_dirt'), false);
  check('★ 陶罐（etcetera 塞进 dirt 标签）不挖', naturalDigNames(t => (t === 'minecraft:dirt' ? new Set(['etcetera:terracotta_vase']) : undefined)).has('etcetera:terracotta_vase'), false);
  check('★ 可疑的沙（考古）不挖', naturalDigNames(t => (t === 'minecraft:sand' ? new Set(['minecraft:suspicious_sand']) : undefined)).has('minecraft:suspicious_sand'), false);
  check('★ 耕地 / 土壤不挖（多半是主人的地）', naturalDigNames(t => (t === 'minecraft:dirt' ? new Set(['somemod:rich_soil_farmland']) : undefined)).size === NATURAL_EXTRA.length - [...NATURAL_EXTRA].filter(n => NOT_NATURAL_RE.test(n)).length, true);
  const dm = { exclusionAreasBreak: [], bot: { entity: { position: { y: 64 } } } };
  if (!ALLOW_DIG) {
    setDigPolicy(dm, { naturalIds: new Set([1]), forbid: (p) => p.x === 0, builtNear: (p) => p.x === 9 });
    const g = dm.exclusionAreasBreak.find(f => f.__digGuard);
    const B = (type, x, name = 'stone', y = 64) => ({ type, name, position: { x, y, z: 0 } });
    check('★ 天然石头、家外、旁边没建筑 → 能挖', g(B(1, 5)), 0);
    check('★ 认不出的方块（模组装饰）→ 不挖', g(B(2, 5, 'somemod:vase')), 100);
    check('★ 家里 → 不挖', g(B(1, 0)), 100);
    check('★ 紧挨着人造方块 → 不挖（可能是墙）', g(B(1, 9)), 100);
    check('树叶照旧能打（不在脚下）', g(B(3, 5, 'oak_leaves', 64)), 0);
    check('脚下的树叶不打', g(B(3, 5, 'oak_leaves', 60)), 100);
    setDigPolicy(dm, { naturalIds: new Set([1]) });
    check('再设一次不会叠两道闸', dm.exclusionAreasBreak.filter(f => f.__digGuard).length, 1);
  }
  check('blocksCantBreak 是"只增不减"：原有 999 还在', fakeMv.blocksCantBreak.has(999), true);
  check('blocksCantBreak 装上了 4 个受保护 ID', fakeMv.blocksCantBreak.size, 5);
  check('摘要里的 protectedCount 与实际一致', summary.protectedCount, 4);
  check('摘要里 leavesOnly 为 true（供控制面核对）', summary.leavesOnly, true);

  // opts.allowDig 是单次调用级的放行口子 —— 将来由 JEV 判定"这一趟该不该挖"时走这条。
  // 默认关闭必须靠这里钉住：一旦有人把默认改回 true，上面两条会立刻红。
  const digMv = { blocksCantBreak: new Set(), blocksToAvoid: new Set() };
  const digSummary = applyPolicy(digMv, fakeReg.blocksByName, { allowDig: true });
  check('opts.allowDig=true 时 canDig 才打开', digMv.canDig, true);
  check('opts.allowDig=true 时摘要同步', digSummary.allowDig, true);
  check('放行时 digCost 仍是"很贵"那一档（绕路仍优先）', digMv.digCost, COSTS.digCost);

  // 空注册表不该炸（网桥还没连上服务器时就是这样）
  const emptyMv = { blocksCantBreak: new Set(), blocksToAvoid: new Set() };
  const emptySummary = applyPolicy(emptyMv, null);
  check('注册表为 null 时不炸，只是保护集合为空', emptySummary.protectedCount, 0);
  check('注册表为 null 时代价仍然写入了（软的一层不依赖名字）', emptyMv.digCost, COSTS.digCost);

  console.log('\n[5/7] 注册表往返自检 —— 名字到底可不可信');
  const goodReg = {
    blocksByName: { white_wool: { id: 1 }, dirt: { id: 2 } },
    blocks: { 1: { name: 'white_wool' }, 2: { name: 'dirt' } },
  };
  const goodProbe = probeRegistry(goodReg, ['white_wool', 'dirt']);
  check('往返对得上时 ok=2', summarizeProbe(goodProbe).ok, 2);
  check('往返对得上时 mismatched 为空', summarizeProbe(goodProbe).mismatched.length, 0);

  const badReg = {
    blocksByName: { white_wool: { id: 1 }, dirt: { id: 2 } },
    blocks: { 1: { name: 'fire' }, 2: { name: 'dirt' } },   // 这就是实测到的偏移现象
  };
  const badSummary = summarizeProbe(probeRegistry(badReg, ['white_wool', 'dirt']));
  check('往返对不上时能被抓到（white_wool→fire）', badSummary.mismatched.length, 1);
  check('对不上的那条报告了实际读到的名字', /white_wool→fire/.test(badSummary.mismatched[0]), true);
  check('查不到的名字标 not-in-registry', probeRegistry({ blocksByName: {}, blocks: {} }, ['x'])[0].reason, 'not-in-registry');
  check('注册表为 null 时返回空数组不炸', probeRegistry(null).length, 0);

  console.log('\n[6/7] 可攀爬方块 —— 梯子在模组服上会被静默漏掉');
  // ⚠️ 撤回（2026-09-23）：这里原本写着「服务器上真实梯子 = stateId 5337」。
  //    **那是错的。** 服务端 1003 个原版方块的 id 与原版零差异 → 原版 state 区间
  //    0..24134 没被挤开 → 5337 只可能是**原版**方块，也就是 crimson_hanging_sign。
  //    真相见 installLadderFix 的注释。
  //
  //    这个 fixture 现在只用来测**机制**：`5337` 代表"一个在原版表里查得到的 state"，
  //    `522772` 代表"一个查不到的模组 state"。数字是什么不重要，名字别再当线索读。
  const climbReg = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: {
      5337: { id: 215, name: 'crimson_hanging_sign' },   // 在原版表里**查得到**的 state
      4654: { id: 196, name: 'ladder' },                 // 原版梯子真正的 state
    },
  };

  check('parseIdList 解析逗号串', parseIdList('5337, 1234').join('|'), '5337|1234');
  check('parseIdList 空串 → 空数组', parseIdList('').length, 0);
  check('parseIdList 非数字被丢掉', parseIdList('a, 12, ').join('|'), '12');
  check('parseIdList 接受数组', parseIdList([1, 2]).join('|'), '1|2');
  check('parseIdList 不炸 null', parseIdList(null).length, 0);
  // 这一条是自测真的抓出来的 bug：Number('') === 0，而 0 是空气的 id。
  // 漏了剔空串的话 "5337,,1234" 会解析出 0，把空气当成可攀爬方块。
  check('parseIdList 丢掉空 token（Number(\'\') === 0 陷阱）',
    parseIdList('5337,,1234').join('|'), '5337|1234');
  check('parseIdList 丢掉纯空格 token', parseIdList('5337, ,1234').join('|'), '5337|1234');
  check('parseIdList 拒绝 0（0 是空气，绝不能进 climbables）', parseIdList('0').length, 0);
  check('parseIdList 拒绝负数与非整数', parseIdList('-1, 2.5, 7').join('|'), '7');

  const rc = resolveClimbableIds(climbReg.blocksByStateId, [5337]);
  check('stateId 5337 解析成方块 id 215', rc.byBlockId.has(215), true);
  check('查得到的 stateId 不进 unmapped', rc.unmapped.length, 0);
  const rcUn = resolveClimbableIds(climbReg.blocksByStateId, [522772]);
  check('原版表里查不到的模组 state 进 unmapped', rcUn.unmapped.join('|'), '522772');
  check('查不到的 state 不会塞进 byBlockId', rcUn.byBlockId.size, 0);
  check('blocksByStateId 为 null 时不炸，全进 unmapped', resolveClimbableIds(null, [1, 2]).unmapped.length, 2);

  // 假 Movements：getBlock 按 stateId 返回方块。
  // ⚠️ 替身必须**忠实模仿库的写法**：真库里 `climbable` 一定是被显式赋值的布尔
  //    （`b.climbable = this.climbables.has(b.type)`），不是"没这个字段"。
  //    第一版替身漏了这句，于是"没配置的 state 不该可攀爬"这条断言拿到的是
  //    `undefined` 而不是 `false` —— 是替身不够真，不是实现有错。
  //    注意 `type: undefined` —— 这就是模组方块在真实运行时的样子。
  const mkMv = (stateId) => {
    const mv = {
      climbables: new Set([196]),
      getBlock: () => {
        const b = { stateId, type: undefined };
        b.climbable = mv.climbables.has(b.type);
        return b;
      },
    };
    return mv;
  };

  const climbMv = mkMv(5337);
  const cl = applyClimbables(climbMv, climbReg, [5337, 522772]);
  check('查得到的梯子 id 215 装进了 climbables（走①）', climbMv.climbables.has(215), true);
  check('只增不减：库里原有的原版梯子 id 196 还在', climbMv.climbables.has(196), true);
  check('摘要报告走①的方块 id', cl.addedBlockIds.join('|'), '215');
  check('摘要报告走②的模组 state', cl.unmappedStateIds.join('|'), '522772');
  check('摘要说明 state 补丁已装', cl.stateIdPatchInstalled, true);

  // ①' 名字路线：从服务端快照解析出的方块 id 直接灌进来，**可以多个**。
  //     本包有 32 种梯子（Quark 一家 14 种木材变体），寻路器该全认。
  const mvNamed = mkMv(99999);
  const clNamed = applyClimbables(mvNamed, climbReg, [], { blockIds: [18811, 18812, 18813] });
  check('名字路线：多个方块 id 全部装进 climbables',
    [18811, 18812, 18813].every(id => mvNamed.climbables.has(id)), true);
  check('名字路线：如实报出装了哪些', clNamed.addedExtraBlockIds.join('|'), '18811|18812|18813');
  check('名字路线：只增不减，原版 196 仍在', mvNamed.climbables.has(196), true);
  check('名字路线：不产生"查不到的 state"', clNamed.unmappedStateIds.length, 0);
  // 非正整数必须挡掉 —— 0 是空气，塞进 climbables 就是"空气可攀爬"
  const mvBad = mkMv(99999);
  applyClimbables(mvBad, climbReg, [], { blockIds: [0, -1, 2.5, 18811] });
  check('名字路线：拒绝 0 / 负数 / 非整数（0 是空气）', mvBad.climbables.has(0), false);
  check('名字路线：合法的那一个仍然装上', mvBad.climbables.has(18811), true);
  check('名字路线：不给 opts 时不炸', (() => {
    try { applyClimbables(mkMv(1), climbReg, []); return true; } catch (e) { return false; }
  })(), true);

  // ② 的核心：模组方块的 type 恒为 undefined，climbables 永远命中不了，
  //    所以必须按 stateId 判 —— 否则"加个数字"等于把所有模组方块都说成可攀爬。
  const mvMod = mkMv(522772);
  applyClimbables(mvMod, climbReg, [522772]);
  check('模组方块：按 stateId 命中，climbable 被置 true',
    mvMod.getBlock(null, 0, 0, 0).climbable, true);

  const mvOther = mkMv(123456);
  applyClimbables(mvOther, climbReg, [522772]);
  check('没配置的 stateId 不会被误判成可攀爬',
    mvOther.getBlock(null, 0, 0, 0).climbable, false);

  // 重连会再装配一次，不能把 getBlock 套娃包多层
  const mvTwice = mkMv(522772);
  applyClimbables(mvTwice, climbReg, [522772]);
  const wrappedOnce = mvTwice.getBlock;
  applyClimbables(mvTwice, climbReg, [522772]);
  check('重复装配不会把 getBlock 套娃包多层', mvTwice.getBlock === wrappedOnce, true);
  check('重复装配后依然能命中', mvTwice.getBlock(null, 0, 0, 0).climbable, true);

  // 这一组断言就是"她为什么不会爬梯子"的可观测化
  const pc = probeClimbables(climbReg, [5337]);
  check('自检发现：原版那套认不出这包里的梯子', pc.vanillaPathWouldWork, false);
  check('自检报出库里写死的原版梯子 id', pc.vanillaLadderId, 196);
  check('自检报出 5337 实际解析成了什么名字', pc.observed[0].resolvedName, 'crimson_hanging_sign');
  check('自检里 5337 解析出的 id 不是原版梯子 id', pc.observed[0].isVanillaLadder, false);
  check('自检标出 5337 在原版表里有映射', pc.observed[0].mappedInVanilla, true);

  const pcUn = probeClimbables(climbReg, [522772]);
  check('自检标出模组方块在原版表里没有映射', pcUn.observed[0].mappedInVanilla, false);

  const pcOk = probeClimbables(climbReg, [4654]);
  check('若 state 恰好就是原版梯子，则判定原版路径可用', pcOk.vanillaPathWouldWork, true);
  check('注册表缺失时自检返回 null 而不是撒谎', probeClimbables(null).vanillaPathWouldWork, null);

  // ---- installLadderFix ----
  // ⚠️ 撤回（2026-09-23）：这一节原本把 `5337` 当成"本包真实梯子的 state"、把 `215`
  //    当成"修好之后该有的 id"，断言**全部通过** —— 因为它忠实复现了一个虚构前提。
  //    现在改成拿**真实 minecraft-data** 当基准：前提一旦漂移，测试自己会红。
  let realMc = null;
  try { realMc = require('minecraft-data')('1.20.1'); } catch (e) { /* 没装就跳过真值断言 */ }
  if (realMc && realMc.blocksByName.ladder) {
    const ld = realMc.blocksByName.ladder;
    check('真值：原版 ladder 的方块 id 是 196', ld.id, 196);
    check('真值：原版 ladder 的 state 区间是 4654..4661',
      `${ld.minStateId}..${ld.maxStateId}`, '4654..4661');
    check('真值：原版表里 4654 就属于 ladder 这个方块',
      realMc.blocksByStateId[ld.minStateId].name, 'ladder');
    // 撤回的**正面证据**，直接打在库上 —— 不是我们自己编的 fixture：
    // 5337 在原版表里是 crimson_hanging_sign(id 215)，跟梯子毫无关系。
    check('撤回：原版表里 5337 是 crimson_hanging_sign',
      realMc.blocksByStateId[5337].name, 'crimson_hanging_sign');
    check('撤回：原版表里 5337 的方块 id 是 215（不是 196）',
      realMc.blocksByStateId[5337].id, 215);
    check('撤回：5337 落在原版 ladder 的 state 区间之外',
      ld.minStateId <= 5337 && 5337 <= ld.maxStateId, false);
  }

  // 忠实模仿 `new Movements()`：climbables 里装的是**当时**从注册表读到的 id
  // （`movements.js:64`）。所以"修完之后新建的 Movements 认不认得出"才是真问题 ——
  // 只断言"注册表里的数字变了"是不够的。
  //
  // ⚠️ `typeOverride` 是必需的，不是方便：**模组方块的 `b.type` 来自服务端注册表，
  //    不来自原版 state 表**。第一版替身只会查原版表，于是模组场景里 `type` 恒为
  //    undefined，把"名字路线修好了"这条断言测成了假的。（自测第 5 次抓到
  //    "替身比实现更不真" —— 这类替身一旦简化过头，测的就是替身自己。）
  const mkMvFromRegistry = (reg, stateId, typeOverride) => {
    const mv = {
      climbables: new Set([reg.blocksByName.ladder.id]),
      getBlock: () => {
        const def = reg.blocksByStateId[stateId];
        const type = typeOverride !== undefined ? typeOverride : (def ? def.id : undefined);
        const b = { stateId, type };
        b.climbable = mv.climbables.has(b.type);
        return b;
      },
    };
    return mv;
  };

  // ① 默认状态：两条路都没配 → 一个字都不改。
  //    ⚠️ 这是**正确的状态**，不是"没配置所以凑合" —— 原版 id 零位移，梯子本来就该是 196。
  const regDefault = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 4654: { id: 196, name: 'ladder' } },
  };
  const fixDefault = installLadderFix(regDefault, [], {});
  check('默认（两条路都没配）不动注册表', fixDefault.applied, false);
  check('默认状态下 id 保持原版 196', regDefault.blocksByName.ladder.id, 196);
  check('默认状态下给出理由', /不动注册表/.test(fixDefault.reason), true);
  // "不用修"的实质：原版梯子在两层里**本来就认得出来**
  check('原版梯子在库自带那套里本来就 climbable',
    mkMvFromRegistry(regDefault, 4654).getBlock(null, 0, 0, 0).climbable, true);

  // ② 名字路线：模组梯子。名字来自玩家 F3，id 来自服务端 FML 快照 —— 不经过 state。
  const regMod = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: {},   // 模组 state 在原版表里查不到，正是要绕开的场景
  };
  const snap = { 'minecraft:ladder': 196, 'create:ladder': 12345, 'quark:iron_ladder': 6789 };
  const fixName = installLadderFix(regMod, [], { blockNames: ['create:ladder'], nameToId: snap });
  check('名字路线：从快照解析出 id', fixName.resolvedFromNames.join('|'), '12345');
  check('名字路线：真的改了注册表', regMod.blocksByName.ladder.id, 12345);
  check('名字路线：报告 applied', fixName.applied, true);
  check('名字路线：不经过 state，所以没有"查不到"的 state', fixName.unmappedStateIds.length, 0);
  check('名字路线：修完之后库自带那套认得出',
    mkMvFromRegistry(regMod, 12345, 12345).getBlock(null, 0, 0, 0).climbable, true);
  check('名字路线：非梯子方块仍不会被误判',
    mkMvFromRegistry(regMod, 99999, 99999).getBlock(null, 0, 0, 0).climbable, false);

  // ③ 快照还没抓到 → 如实报出名字查不到，不静默、不谎报
  const regNoSnap = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixNoSnap = installLadderFix(regNoSnap, [], { blockNames: ['create:ladder'], nameToId: null });
  check('快照缺失时不谎报成功', fixNoSnap.applied, false);
  check('快照缺失时如实报出查不到的名字', fixNoSnap.unknownBlockNames.join('|'), 'create:ladder');
  check('快照缺失时说明要先连一次服务端', /先连一次/.test(fixNoSnap.reason), true);
  check('快照缺失时 id 一点没动', regNoSnap.blocksByName.ladder.id, 196);

  // ④ 名字解析成原版 196 → 不改。
  //    把"本来就是对的"当成需要修，正是上一轮那个 bug 的形状。
  const regVanillaName = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixVanillaName = installLadderFix(regVanillaName, [], { blockNames: ['minecraft:ladder'], nameToId: snap });
  check('名字解析成原版 196 时不改', fixVanillaName.applied, false);
  check('并且说明"与当前值一致"', /一致/.test(fixVanillaName.reason), true);

  // ⑤ baseline：连改两次，baseline 必须仍是**首次调用前**的值。
  //    `prismarine-registry` 是版本单例，改了会粘住；不单独记 baseline 就会把
  //    "改后"当成"改前"报出去 —— 证据被自己的副作用抹掉。
  const regTwice = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const f1 = installLadderFix(regTwice, [], { blockNames: ['create:ladder'], nameToId: snap });
  const f2 = installLadderFix(regTwice, [], { blockNames: ['quark:iron_ladder'], nameToId: snap });
  check('第一次改：196 → 12345', `${f1.before}→${f1.after}`, '196→12345');
  check('第二次改：12345 → 6789', `${f2.before}→${f2.after}`, '12345→6789');
  check('baseline 两次都报原版 196，没被自己的副作用抹掉',
    `${f1.baseline}|${f2.baseline}`, '196|196');

  // ⑥ state 路线（只在原版方块上可信）
  const regAlready = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 4654: { id: 196, name: 'ladder' } },
  };
  const fixAlready = installLadderFix(regAlready, [4654]);
  check('state 路线解析成原版 id 时不改', fixAlready.applied, false);
  check('并且说明"与当前值一致"', /一致/.test(fixAlready.reason), true);

  const regUn = { blocksByName: { ladder: { id: 196 } }, blocksByStateId: {} };
  const fixUn = installLadderFix(regUn, [522772]);
  check('模组 state 在原版表查不到时不改注册表', fixUn.applied, false);
  check('但如实报出是哪个 state 查不到', fixUn.unmappedStateIds.join('|'), '522772');
  check('并说明改用 stateId 补丁那一层', /applyClimbables/.test(fixUn.reason), true);

  // ⑦ 两条路同时给：名字优先（它不经过 state），多余的如实报出
  const regMulti = {
    blocksByName: { ladder: { id: 196 } },
    blocksByStateId: { 5337: { id: 215 }, 6000: { id: 777 } },
  };
  const fixMulti = installLadderFix(regMulti, [5337, 6000], { blockNames: ['create:ladder'], nameToId: snap });
  check('名字优先于 state', fixMulti.after, 12345);
  check('state 路线解析出的 id 也如实报出', fixMulti.resolvedFromStates.join('|'), '215|777');
  check('多余的 id 如实报出而不是悄悄丢', fixMulti.ignoredExtraBlockIds.join('|'), '215|777');

  const fixNull = installLadderFix(null, [5337]);
  check('注册表缺失时不炸、也不谎报成功', fixNull.applied, false);

  // ⑧ probeClimbables 的 baseline 语义：修过注册表之后，仍要说得清"库原本写死的是几"
  const regProbe = {
    blocksByName: { ladder: { id: 215 } },   // 已被改过
    blocksByStateId: { 5337: { id: 215, name: 'crimson_hanging_sign' } },
  };
  const pcAfter = probeClimbables(regProbe, [5337], { baselineLadderId: 196 });
  check('修过之后自检仍报出库原本写死的 id', pcAfter.vanillaLadderId, 196);
  check('修过之后自检报出库此刻在用的 id', pcAfter.libraryLadderId, 215);
  const pcBefore = probeClimbables(
    { blocksByName: { ladder: { id: 196 } }, blocksByStateId: { 5337: { id: 215, name: 'x' } } },
    [5337]
  );
  check('未修时 libraryPathWouldWork 为 false（默认基准取当前值）', pcBefore.libraryPathWouldWork, false);

  // ---- applyUnknownBlockPolicy：未映射方块不能再被当成空气 ----
  // 忠实模仿 prismarine-block 的 else 分支（`index.js:156-164`）。
  // ⚠️ 替身必须把"已映射 / 未映射"和"实心 / 可穿过"当成**两件独立的事** ——
  //    第一版替身把它们揉在一起（mapped ⇒ boundingBox:'block'），于是
  //    "已映射的梯子应保持 empty"这条断言拿到的是 'block'。
  //    是替身不忠实，不是实现有错。（这已经是自测第二次抓到"替身比实现更不真"。）
  const mkMapped = (stateId, boundingBox) => ({
    stateId, type: 42, name: 'stone', boundingBox,
    shapes: boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
  });
  const mkUnknown = (stateId) => ({
    stateId, type: undefined, name: '', boundingBox: 'empty', shapes: [],
  });

  const mkWorld = (map) => ({
    getBlock: (pos) => {
      const k = pos.x + ',' + pos.y + ',' + pos.z;
      return map[k] ? { ...map[k], position: pos } : null;
    },
  });

  const w1 = mkWorld({
    '35,74,-136': mkUnknown(506813),         // cluttered:ancient_codex（模组装饰，实心）
    // ⚠️ 这个坐标曾经被注释成"梯子"。**它其实不是。**
    //    5337 在原版表里是 crimson_hanging_sign（悬挂牌），原版 ladder 的 state 区间是
    //    4654..4661。之前把 5337 当梯子喂给物理层，她"爬上去"是自我实现的预言。
    //    保留这个坐标是为了让这条注释留在代码里，别再犯第二次。
    '34,74,-137': mkMapped(5337, 'block'),
    '33,74,-137': mkMapped(0, 'empty'),      // 空气
  });

  // 先记下"补丁之前"的样子，补丁后比对 —— 比猜一个期望值可靠
  const beforeLadder = JSON.stringify(w1.getBlock({ x: 34, y: 74, z: -137 }));
  const beforeAir = JSON.stringify(w1.getBlock({ x: 33, y: 74, z: -137 }));

  const unkRep = applyUnknownBlockPolicy(w1, { passableStateIds: [] });
  check('未映射策略默认装上补丁', unkRep.patched, true);
  check('未映射策略报告已启用', unkRep.enabled, true);

  const codex = w1.getBlock({ x: 35, y: 74, z: -136 });
  check('未映射方块：boundingBox 从 empty 改成 block', codex.boundingBox, 'block');
  check('未映射方块：拿到完整碰撞箱（物理层才会挡）',
    JSON.stringify(codex.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));

  check('已映射方块一个字节都不动（梯子原样）',
    JSON.stringify(w1.getBlock({ x: 34, y: 74, z: -137 })), beforeLadder);
  check('空气原样（type 是数字 0，不会被误判成未映射）',
    JSON.stringify(w1.getBlock({ x: 33, y: 74, z: -137 })), beforeAir);

  check('isUnknownBlock 认得出未映射方块', isUnknownBlock(codex), true);
  check('isUnknownBlock 不认已映射方块', isUnknownBlock(w1.getBlock({ x: 34, y: 74, z: -137 })), false);
  check('isUnknownBlock 不认空气', isUnknownBlock(w1.getBlock({ x: 33, y: 74, z: -137 })), false);
  check('isUnknownBlock 不炸 null', isUnknownBlock(null), false);
  // ⚠️ 关键回归：补丁给未映射方块填了真名之后，**判据不能失效**。
  //    因为 `world.getBlock` 返回的是缓存里的同一个对象，填过名字之后再读，
  //    `name === ''` 就不成立了 —— 如果 isUnknownBlock 还带着那个条件，
  //    "未映射按实心处理"会在第二次读同一格时静默失效，她又开始穿墙。
  check('填过名字的未映射方块仍被判为未映射（type 才是判据）',
    isUnknownBlock({ type: undefined, name: 'upgrade_aquatic:glass_trapdoor' }), true);

  // ---- needsShapeFallback：调色板注入过的方块也要继续走兜底 ----
  //     注入之后 `b.type` 有值了，`isUnknownBlock` 不再命中；但补丁还兼着
  //     可穿过白名单，不能停。判据是"我们没有它的权威碰撞箱"。
  check('needsShapeFallback 认未映射方块', needsShapeFallback({ type: undefined }), true);
  check('needsShapeFallback 认调色板注入过的方块（有 type、没 boundingBox）',
    needsShapeFallback({ type: 18811, name: 'quark:spruce_ladder', angelInjected: true }), true);
  check('needsShapeFallback 不认原版已映射方块（梯子）',
    needsShapeFallback(w1.getBlock({ x: 34, y: 74, z: -137 })), false);
  check('needsShapeFallback 不认空气', needsShapeFallback(w1.getBlock({ x: 33, y: 74, z: -137 })), false);
  check('needsShapeFallback 不炸 null', needsShapeFallback(null), false);

  // 端到端：注入过的方块照样被补成实心，且白名单照样能放行
  // ⚠️ 本文件的 `check` 是 (label, got, expect) 三参数形式，不是布尔断言。
  const mkInjected = (stateId) => ({
    stateId, type: 18811, name: 'quark:spruce_ladder',
    angelInjected: true, boundingBox: undefined, shapes: undefined,
  });
  {
    const w7 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w7, { passableStateIds: [] });
    const b = w7.getBlock({ x: 1, y: 1, z: 1 });
    check('注入过的方块被补成实心', b.boundingBox, 'block');
    check('注入过的方块拿到完整碰撞箱',
      JSON.stringify(b.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));

    const w8 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w8, { passableStateIds: [24135] });
    check('注入过的方块若在白名单里则保持可穿过',
      w8.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);

    const w9 = mkWorld({ '1,1,1': mkInjected(24135) });
    const rt = new Set([24135]);
    applyUnknownBlockPolicy(w9, { passableStateIds: [], runtimePassable: rt });
    check('运行时白名单（她自己开的门）对注入过的方块也生效',
      w9.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);
    rt.delete(24135);
    check('运行时白名单是**按引用**读的：移出后立刻恢复实心',
      w9.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
  }

  // ---- 形状**已知**（调色板导出了真实碰撞箱）之后的三种走法 ----
  //     这是 2026-09-26 契约反转带来的新分支：以前"注入过 ⇒ 一定没 boundingBox"，
  //     现在"导了形状列 ⇒ 一定有 boundingBox"。白名单必须两条路都能用。
  {
    // 真实形状：3/16 厚的模组梯子（从 dump 里解出来的那种）
    const mkShaped = (stateId) => ({
      stateId, type: 18811, name: 'quark:spruce_ladder', angelInjected: true,
      angelShape: 'static', boundingBox: 'block', shapes: [[0, 0, 0, 0.8125, 1, 1]],
    });

    // ① 形状已知 + 不在白名单 → 一个字都不改（真实形状生效，不再被补成整块）
    const ws1 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rep1 = applyUnknownBlockPolicy(ws1, { passableStateIds: [] });
    const s1 = ws1.getBlock({ x: 1, y: 1, z: 1 });
    check('形状已知：不再被补成整块实心（兜底让位）',
      JSON.stringify(s1.shapes), JSON.stringify([[0, 0, 0, 0.8125, 1, 1]]));
    check('形状已知：没有被标成 thinBlock / lowBlock',
      `${s1.thinBlock || false}/${s1.lowBlock || false}`, 'false/false');
    check('形状已知：白名单放行计数保持 0', rep1.stats.whitelisted, 0);

    // ② 形状已知 + 在白名单里 → **主动**写成空碰撞（不是"什么都不做"）
    const ws2 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rep2 = applyUnknownBlockPolicy(ws2, { passableStateIds: [24135] });
    const s2 = ws2.getBlock({ x: 1, y: 1, z: 1 });
    check('形状已知但在白名单里：被放行', s2.boundingBox, 'empty');
    check('形状已知但在白名单里：碰撞箱被清空（主动写的，不是靠默认值）',
      JSON.stringify(s2.shapes), '[]');
    check('形状已知但在白名单里：留了 whitelisted 痕迹', s2.whitelisted, true);
    check('形状已知但在白名单里：计数上报', rep2.stats.whitelisted, 1);

    // ③ 形状已知 + 运行时白名单（她自己开的门）→ 同样放行，且按引用读
    const ws3 = mkWorld({ '1,1,1': mkShaped(24135) });
    const rt3 = new Set([24135]);
    applyUnknownBlockPolicy(ws3, { passableStateIds: [], runtimePassable: rt3 });
    check('形状已知 + 运行时白名单：放行', ws3.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
    rt3.delete(24135);
    check('形状已知 + 运行时白名单：移出后立刻恢复真实形状',
      JSON.stringify(ws3.getBlock({ x: 1, y: 1, z: 1 }).shapes), JSON.stringify([[0, 0, 0, 0.8125, 1, 1]]));

    // ④ 形状已知 + 名字像薄方块 → **不**因为名字再动一次（形状比名字权威）
    const ws4 = mkWorld({
      '1,1,1': {
        stateId: 24135, type: 18811, name: 'autumnity:maple_pressure_plate',
        angelInjected: true, angelShape: 'static', boundingBox: 'block',
        shapes: [[0, 0, 0, 1, 0.0625, 1]],
      },
    });
    const rep4 = applyUnknownBlockPolicy(ws4, { passableStateIds: [] });
    check('形状已知时不再按名字猜薄方块（真实形状更权威）',
      JSON.stringify(ws4.getBlock({ x: 1, y: 1, z: 1 }).shapes), JSON.stringify([[0, 0, 0, 1, 0.0625, 1]]));
    check('形状已知时不记薄方块豁免', rep4.stats.thinExempt, 0);
  }

  // 名字只补空缺：注册表已经有名字（调色板注入）时，旁路解析器不许覆盖
  {
    const w10 = mkWorld({ '1,1,1': mkInjected(24135) });
    applyUnknownBlockPolicy(w10, { passableStateIds: [], nameOf: () => 'WRONG:should_not_win' });
    check('注册表已有名字时，旁路 nameOf 不覆盖它',
      w10.getBlock({ x: 1, y: 1, z: 1 }).name, 'quark:spruce_ladder');
    const w11 = mkWorld({ '1,1,1': mkUnknown(522772) });
    applyUnknownBlockPolicy(w11, { passableStateIds: [], nameOf: () => 'upgrade_aquatic:glass_trapdoor' });
    check('没有名字时才用旁路 nameOf 补',
      w11.getBlock({ x: 1, y: 1, z: 1 }).name, 'upgrade_aquatic:glass_trapdoor');
  }

  // ---- nameOf：用调色板给未映射方块填真名 ----
  const w6 = mkWorld({ '1,1,1': mkUnknown(522772) });
  const nameRep = applyUnknownBlockPolicy(w6, {
    passableStateIds: [],
    nameOf: (sid) => (sid === 522772 ? 'upgrade_aquatic:glass_trapdoor' : null),
  });
  check('nameOf 装上时如实报告', nameRep.nameResolver, true);
  const namedBlock = w6.getBlock({ x: 1, y: 1, z: 1 });
  check('未映射方块被填上真名', namedBlock.name, 'upgrade_aquatic:glass_trapdoor');
  check('填名之后**仍然是实心**（两件事互不干扰）', namedBlock.boundingBox, 'block');
  check('填名之后碰撞箱还在', JSON.stringify(namedBlock.shapes), JSON.stringify([[0, 0, 0, 1, 1, 1]]));
  check('留了 resolvedName 痕迹，可与"注册表本来就有名字"区分', namedBlock.resolvedName, 'upgrade_aquatic:glass_trapdoor');
  check('再次读同一格依然是实心（缓存对象被改过也不失效）',
    w6.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  // nameOf 返回 null（调色板查不到）时不能把名字写成 null
  const w7 = mkWorld({ '2,2,2': mkUnknown(777) });
  applyUnknownBlockPolicy(w7, { passableStateIds: [], nameOf: () => null });
  check('调色板查不到时名字保持空串，不写 null', w7.getBlock({ x: 2, y: 2, z: 2 }).name, '');
  check('调色板查不到时仍按实心处理', w7.getBlock({ x: 2, y: 2, z: 2 }).boundingBox, 'block');

  // nameOf 自己抛异常也不能连累实心策略
  const w8 = mkWorld({ '3,3,3': mkUnknown(888) });
  applyUnknownBlockPolicy(w8, { passableStateIds: [], nameOf: () => { throw new Error('boom') } });
  check('nameOf 抛异常时实心策略仍然生效', w8.getBlock({ x: 3, y: 3, z: 3 }).boundingBox, 'block');
  check('nameOf 抛异常时名字保持空串', w8.getBlock({ x: 3, y: 3, z: 3 }).name, '');
  check('nameOf 抛异常时不炸出补丁外', applyUnknownBlockPolicy(mkWorld({}), { nameOf: 'not a function' }).patched, true);

  // 白名单：确实可穿过的模组方块可以豁免
  const w2 = mkWorld({ '1,1,1': mkUnknown(900001) });
  applyUnknownBlockPolicy(w2, { passableStateIds: [900001] });
  check('白名单里的 state 保持可穿过',
    w2.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');

  // 关掉开关就一个字都不改
  const w3 = mkWorld({ '1,1,1': mkUnknown(900001) });
  const offRep = applyUnknownBlockPolicy(w3, { enabled: false });
  check('关掉时不上补丁', offRep.patched, false);
  check('关掉时说明理由', /MC_UNKNOWN_BLOCK_SOLID/.test(offRep.skipped), true);
  check('关掉时方块保持原样', w3.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');

  // 重连会再装一次，不能套娃
  const w4 = mkWorld({ '1,1,1': mkUnknown(900001) });
  applyUnknownBlockPolicy(w4, { passableStateIds: [] });
  const wrappedOnceUnknown = w4.getBlock;
  const againRep = applyUnknownBlockPolicy(w4, { passableStateIds: [] });
  check('重复安装不会套娃包多层', w4.getBlock === wrappedOnceUnknown, true);
  check('重复安装如实报出已装过', againRep.alreadyPatched, true);
  check('重复安装后依然生效', w4.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  check('world 缺失时不炸', applyUnknownBlockPolicy(null).patched, false);
  check('world.getBlock 缺失时不炸', applyUnknownBlockPolicy({}).patched, false);

  // 运行时白名单：她**自己打开**的那扇活板门，实测穿得过去之后才记进来。
  // 关键：补丁必须**按引用**读这个 Set，不能在安装时拷一份 —— 否则后加的不生效。
  const runtime = new Set();
  const w5 = mkWorld({ '1,1,1': mkUnknown(522772) });
  applyUnknownBlockPolicy(w5, { passableStateIds: [], runtimePassable: runtime });
  check('运行时白名单为空时，未映射方块仍是实心',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
  runtime.add(522772);   // ← 安装**之后**才加进去
  check('安装之后加进运行时白名单，立刻生效（按引用读，不是快照）',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
  runtime.delete(522772);
  check('从运行时白名单移除后立刻恢复实心（所以"猜错了能撤"）',
    w5.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');

  // ---- 薄方块豁免：名字像薄方块的，不再补成立方体（2026-09-25）----
  // 现场：厨房唯一的出口前那一格是 `autumnity:maple_pressure_plate`，被补成立方体之后
  // 她纯走 2000ms 只前进 0.2 格就撞停（= 撞在整块立方体上）。玩家：「踏板为什么要跳，直接走」。
  check('薄方块：模组踏板命中', isThinBlockName('autumnity:maple_pressure_plate'), true);
  check('薄方块：模组地毯命中', isThinBlockName('natures_spirit:light_gray_rug'), true);
  check('薄方块：模组按钮命中', isThinBlockName('quark:oak_button'), true);
  check('薄方块：模组花命中', isThinBlockName('biomeswevegone:white_flower'), true);
  check('薄方块：模组告示牌命中', isThinBlockName('quark:spruce_hanging_sign'), true);
  check('薄方块：裸名（无命名空间）也命中', isThinBlockName('torch'), true);
  check('薄方块：不命中模组墙（cluttered:ancient_codex）',
    isThinBlockName('cluttered:ancient_codex'), false);
  // ⚠️ 下面这四条是**故意**不豁免的，谁把它们加进名单都会把这里打红：
  check('薄方块：不命中模组梯子（必须当墙，否则寻路器永远不爬）',
    isThinBlockName('quark:spruce_ladder'), false);
  check('薄方块：不命中模组活板门（要 /activate 打开 + 实测放行）',
    isThinBlockName('upgrade_aquatic:glass_trapdoor'), false);
  check('薄方块：不命中模组台阶（半高，靠 step-up，当可穿过会橡皮筋）',
    isThinBlockName('quark:spruce_slab'), false);
  check('薄方块：不命中模组楼梯（半高，同上）',
    isThinBlockName('quark:spruce_stairs'), false);
  check('薄方块：名字里含 torch 但结尾不是（torchflower）不命中',
    isThinBlockName('minecraft:torchflower'), false);
  check('薄方块：黑名单挡住 chorus_flower（名字像花，其实实心）',
    isThinBlockName('minecraft:chorus_flower'), false);
  check('薄方块：黑名单挡住 mangrove_roots（名字像根，其实实心）',
    isThinBlockName('minecraft:mangrove_roots'), false);
  check('薄方块：空名字 → 保守不豁免', isThinBlockName(''), false);
  check('薄方块：null → 保守不豁免', isThinBlockName(null), false);
  check('薄方块：undefined → 保守不豁免', isThinBlockName(undefined), false);

  // 忠实替身：调色板注入过的模组方块（有 type/name、没有 boundingBox/shapes）
  const mkInjectedNamed = (stateId, name) => ({
    stateId, type: 14989, name, angelInjected: true,
    boundingBox: undefined, shapes: undefined,
  });

  // 端到端：同一批里，认识名字的薄方块放行，不认识名字的仍然实心
  {
    const wt = mkWorld({
      '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate'),
      '2,2,2': mkInjectedNamed(506813, 'cluttered:ancient_codex'),
    });
    const thinRep = applyUnknownBlockPolicy(wt, { passableStateIds: [] });
    check('薄方块豁免默认打开', thinRep.thinPassable, true);
    const plate = wt.getBlock({ x: 1, y: 1, z: 1 });
    check('模组踏板：不再补成立方体', plate.boundingBox, 'empty');
    check('模组踏板：碰撞箱清空（物理层才走得过去）',
      JSON.stringify(plate.shapes), JSON.stringify([]));
    check('模组踏板：留了 thinBlock 痕迹', plate.thinBlock, true);
    check('同一批里的模组墙（不认识的名字）仍然实心',
      wt.getBlock({ x: 2, y: 2, z: 2 }).boundingBox, 'block');
    check('薄方块豁免计数累加', thinRep.stats.thinExempt, 1);
    check('薄方块豁免记下了名字',
      thinRep.stats.thinNames.join(','), 'autumnity:maple_pressure_plate');
    // 补丁改的是缓存里那个对象，再读一次必须还是可穿过
    check('再读同一格仍可穿过（缓存对象也被改了）',
      wt.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'empty');
  }

  // 白名单优先于薄方块豁免：白名单是"实测确认过"，薄方块是"按名字猜的"
  {
    const w12 = mkWorld({ '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate') });
    applyUnknownBlockPolicy(w12, { passableStateIds: [520973] });
    check('白名单命中时一个字都不改（保持 undefined，不被改写成 empty）',
      w12.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, undefined);
  }

  // 关掉豁免 → 退回老行为（所有模组方块一律实心）
  {
    const w13 = mkWorld({ '1,1,1': mkInjectedNamed(520973, 'autumnity:maple_pressure_plate') });
    const offThin = applyUnknownBlockPolicy(w13, { passableStateIds: [], thinPassable: false });
    check('thinPassable:false 时如实报告', offThin.thinPassable, false);
    check('thinPassable:false 时踏板退回实心',
      w13.getBlock({ x: 1, y: 1, z: 1 }).boundingBox, 'block');
    check('thinPassable:false 时不记豁免计数', offThin.stats.thinExempt, 0);
  }

  // 名字解析必须发生在**判形状之前** —— 否则薄方块豁免永远看不到名字。
  // 这条钉的是"顺序"，不是"结果"：nameOf 是唯一的名字来源时也要能豁免。
  {
    const w14 = mkWorld({ '3,3,3': mkUnknown(520973) });   // name 是空串
    applyUnknownBlockPolicy(w14, {
      passableStateIds: [],
      nameOf: (sid) => (sid === 520973 ? 'autumnity:maple_pressure_plate' : null),
    });
    const b14 = w14.getBlock({ x: 3, y: 3, z: 3 });
    check('只有旁路 nameOf 提供名字时，薄方块照样被豁免', b14.boundingBox, 'empty');
    check('旁路补的名字同时留下 resolvedName 痕迹',
      b14.resolvedName, 'autumnity:maple_pressure_plate');
  }

  // ---- faceTowardBlock：右键"用"方块时点哪一面 ----
  // 真实场景：活板门在 (34,78,-137)，她在下面（眼睛 y≈77.8）→ 必须点**底面**，
  // 因为顶面朝着屋顶里面，够不着。默认的 (0,1,0) 在这里是错的。
  const tp = { x: 34, y: 78, z: -137 };
  check('从下方够方块 → 点底面',
    faceTowardBlock(tp, { x: 34.5, y: 77.8, z: -136.5 }).join(','), '0,-1,0');
  check('从上方够方块 → 点顶面',
    faceTowardBlock(tp, { x: 34.5, y: 79.6, z: -137.5 }).join(','), '0,1,0');
  check('从西边够方块 → 点西面',
    faceTowardBlock(tp, { x: 33.0, y: 78.5, z: -136.5 }).join(','), '-1,0,0');
  check('从东边够方块 → 点东面',
    faceTowardBlock(tp, { x: 36.0, y: 78.5, z: -137.5 }).join(','), '1,0,0');
  check('从北边够方块 → 点北面',
    faceTowardBlock(tp, { x: 34.5, y: 78.5, z: -139.0 }).join(','), '0,0,-1');
  check('从南边够方块 → 点南面',
    faceTowardBlock(tp, { x: 34.5, y: 78.5, z: -135.0 }).join(','), '0,0,1');
  check('返回的一定是单位法线（三个分量都是 -1/0/1）',
    faceTowardBlock(tp, { x: 40, y: 90, z: -120 }).every(v => v === -1 || v === 0 || v === 1), true);
  // 平手时优先级 Y > X > Z，必须是**可预测**的，不能靠运气
  check('三轴等距时优先 Y 轴',
    faceTowardBlock({ x: 0, y: 0, z: 0 }, { x: 1.5, y: 1.5, z: 1.5 }).join(','), '0,1,0');

  let threw = false;
  try { applyClimbables({ climbables: new Set() }, climbReg, [5337]); } catch (e) { threw = true; }
  check('没给 Movements 实例时明确报错（而不是静默什么都不做）', threw, true);

  console.log('\n[7/8] 单次寻路超时与停滞检测 —— 走 3 格和走 60 格不该用同一个数字');
  // 这一节替代了原来"给整个 HTTP 请求套固定 45s"的做法。要验证三件事：
  //   ① 步长归类的边界是**确定**的（cost 刚好卡在阈值上不能飘）
  //   ② ETA → 超时 的钳制范围正确（再短的路径也不会秒超时，再长的也不会无限等）
  //   ③ 停滞检测分得清"绕路"和"卡住"—— 这是最难也最要紧的一条

  // --- ① 归类
  check('cost=1 判直走', stepKind(1), 'walk');
  check('cost=√2 判直走（对角）', stepKind(Math.SQRT2), 'walk');
  check('cost=1.6 判跳（边界含等于）', stepKind(1.6), 'jump');
  check('cost=1.599 判直走', stepKind(1.599), 'walk');
  check('cost=2.2 判跳空隙', stepKind(2.2), 'parkour');
  check('cost=2.5 判放置', stepKind(2.5), 'place');
  check('cost=4 判挖掘', stepKind(4), 'dig');
  check('cost 无效 → 直走兜底', stepKind(NaN), 'walk');
  check('cost 负数 → 直走兜底', stepKind(-3), 'walk');

  // --- 单步耗时
  check('挖一步按 1800ms（比 HiyoriAI 的 1500 保守）', stepCostMs({ cost: 4 }), 1800);
  check('直走一步 1/5.6 s ≈ 179ms', stepCostMs({ cost: 1 }), Math.round(1000 / 5.6));
  check('跳一步 700ms', stepCostMs({ cost: 1.6 }), 700);

  // --- ② ETA
  check('空路径 → null', estimatePathTimeMs([]), null);
  check('非数组 → null', estimatePathTimeMs(null), null);
  const est10 = estimatePathTimeMs(Array.from({ length: 10 }, () => ({ cost: 1 })));
  check('10 格直走：step 数正确', est10.steps, 10);
  check('10 格直走：breakdown 全记在 walk 上', est10.breakdown.walk === est10.etaMs, true);
  check('10 格直走：jump/place/dig 都是 0',
    est10.breakdown.jump + est10.breakdown.place + est10.breakdown.dig, 0);
  const estMix = estimatePathTimeMs([{ cost: 1 }, { cost: 4 }, { cost: 2.5 }]);
  check('混合路径：合计 = 各段之和',
    estMix.etaMs, estMix.breakdown.walk + estMix.breakdown.dig + estMix.breakdown.place);

  // --- 超时钳制
  check('无路径 → 给最小值（多半会立刻报无路，不必等满）',
    computeTimeoutFromEta(null).timeoutMs, PATH_MIN_TIMEOUT_MS);
  check('无路径 → 标记来源', computeTimeoutFromEta(null).source, 'no-path');
  check('极短路径 → 钳到下界，不会秒超时',
    computeTimeoutFromEta({ etaMs: 1 }).timeoutMs, PATH_MIN_TIMEOUT_MS);
  check('极长路径 → 钳到上界，不会无限等',
    computeTimeoutFromEta({ etaMs: 10 ** 9 }).timeoutMs, PATH_MAX_TIMEOUT_MS);
  check('中等路径 → 按 eta*2+10s 推导',
    computeTimeoutFromEta({ etaMs: 60000 }).timeoutMs, 60000 * 2 + 10000);
  check('推导结果始终是整数', Number.isInteger(computeTimeoutFromEta({ etaMs: 12345.67 }).timeoutMs), true);
  check('可覆盖参数（为将来调参留口）',
    computeTimeoutFromEta({ etaMs: 1 }, { minMs: 5, maxMs: 10, baseMs: 0, grace: 1 }).timeoutMs, 5);
  check('该长就长：60 格远路给的超时明显大于 3 格近路',
    computeTimeoutFromEta(estimatePathTimeMs(Array.from({ length: 60 }, () => ({ cost: 1 })))).timeoutMs
    > computeTimeoutFromEta(estimatePathTimeMs(Array.from({ length: 3 }, () => ({ cost: 1 })))).timeoutMs,
    true);

  // --- 续期的绝对上限（P9 的回归锁）-------------------------------------------
  //
  // 实机 bug：`POST /mine {count:1}` 跑 150 秒不返回，而配置超时是 30 秒。
  // 根因是 watchdog 的续期**没有上限**，而 `path_update` 恰好在卡住时高频触发
  // → 每次重规划都续一次期 → 永远不到期。
  //
  // 这一段的全部意义是：**保证任何一次 goto 一定有尽头**。
  const capShort = computeHardCap(PATH_MIN_TIMEOUT_MS);        // 近路：初始 30s
  const capLong = computeHardCap(PATH_MAX_TIMEOUT_MS);         // 远路：初始 300s

  check('任何初始预算都有有限上限', Number.isFinite(capShort.hardCapMs), true);
  check('上限是正数', capShort.hardCapMs > 0, true);
  check('短预算也有足够余量（≥ 库上限 300s）',
    capShort.hardCapMs >= PATH_MAX_TIMEOUT_MS, true);
  check('长预算的上限不低于短预算（单调）',
    capLong.hardCapMs >= capShort.hardCapMs, true);

  // ⚠️ 最关键的一条：**续期不能把时限无限推远**。
  //    旧代码没有这一层，于是 30 秒的预算能靠续期活到 150 秒以上。
  check('★ 初始 30s 的路径，硬上限**不等于**无穷大（旧代码这里挂了）',
    capShort.hardCapMs !== Infinity && Number.isFinite(capShort.hardCapMs), true);
  check('★ 硬上限是有限的：30s 路径最坏也就 ~300s 结束',
    capShort.hardCapMs <= PATH_MAX_TIMEOUT_MS * 2, true);
  check('硬上限的取值理由可读（便于运维）', /max\(/.test(capShort.reason), true);

  // 边界：非法输入不该算出 NaN/负数（NaN 会让 `Date.now() >= NaN` 恒 false → 又回到"永不超时"）
  check('初始值为 0 → 退回最小值，不产生 NaN',
    Number.isFinite(computeHardCap(0).hardCapMs), true);
  check('初始值为 NaN → 退回最小值，不产生 NaN',
    Number.isFinite(computeHardCap(NaN).hardCapMs), true);
  check('负数 → 退回最小值，不产生负上限',
    computeHardCap(-5000).hardCapMs > 0, true);
  check('可覆盖（供将来调参）',
    computeHardCap(1000, { maxMs: 500, factor: 1 }).hardCapMs, 1000);

  // --- ③ 停滞检测
  const t0 = 1_000_000;
  const O = { x: 0, y: 64, z: 0 };

  // 正常前进：每 5 秒走 3 格 → 永远不判卡
  const mGood = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rGood;
  for (let i = 1; i <= 10; i++) rGood = mGood.sample({ x: i * 3, y: 64, z: 0 }, t0 + i * 5000);
  check('稳步前进 → 多次检查后仍未耗尽', rGood.exhausted, false);
  check('稳步前进 → stagnant 始终为 0', rGood.stagnant, 0);
  check('稳步前进 → 检查次数记满（10 次采样 − 1 次初始化 = 9）', rGood.checks, 9);
  // ⚠️ 注意：上一条用的是**第 10 次**采样的返回值，而第一次采样只做初始化、
  //    不计入 checks。所以 10 次采样 → 9 次检查。这个差一曾让我自己写错期望值。
  check('第一次采样只做初始化，不计检查', (() => {
    const m = createStagnationMonitor(O, { intervalMs: 5000 });
    return m.sample({ x: 0, y: 64, z: 0 }, t0 + 5000).checks;
  })(), 0);

  // 完全不动：连续 3 次检查没动 → 耗尽
  const mStuck = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rStuck;
  for (let i = 1; i <= 4; i++) rStuck = mStuck.sample({ x: 0, y: 64, z: 0 }, t0 + i * 5000);
  check('完全不动 → 第 3 次检查时耗尽', rStuck.exhausted, true);
  check('完全不动 → stagnant 累加', rStuck.stagnant, 3);
  check('完全不动 → 但第 2 次检查还没耗尽（给足 3 次机会）', (() => {
    const m = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
    let r;
    for (let i = 1; i <= 2; i++) r = m.sample({ x: 0, y: 64, z: 0 }, t0 + i * 5000);
    return r.exhausted;
  })(), false);

  // ⚠️ 最要紧的一条：**绕路不算卡住**。
  //    寻路器为了避开障碍绕一大圈是正常行为。如果拿"离起点多远"当判据，
  //    绕路时前进方向改变会被误判成卡死 —— 那就把好的寻路给杀了。
  //    这是 HiyoriAI 用"和上一次采样点比"的原因，我们照抄。
  const mDetour = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  const detour = [
    { x: 3, y: 64, z: 0 },    // 前进
    { x: 3, y: 64, z: 3 },    // 拐弯（离起点更远了，但仍在动）
    { x: 0, y: 64, z: 6 },    // 绕回来（离起点距离没变，但这一步走了 3 格）
    { x: -3, y: 64, z: 6 },   // 继续绕
  ];
  let rDetour;
  detour.forEach((p, i) => { rDetour = mDetour.sample(p, t0 + (i + 1) * 5000); });
  check('绕路（位置回退但每步都在动）→ 不判卡死', rDetour.exhausted, false);
  check('绕路 → stagnant 保持 0', rDetour.stagnant, 0);

  // 没到采样间隔时不检查、不累加 —— 否则高频 sample 会瞬间把计数器打满
  const mFast = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rFast;
  for (let i = 0; i < 50; i++) rFast = mFast.sample({ x: 0, y: 64, z: 0 }, t0 + i * 10);
  check('间隔没到就不检查（高频采样不会打满计数）', rFast.checks, 0);
  check('间隔没到 → 不判耗尽', rFast.exhausted, false);
  check('间隔没到 → due 为 false', rFast.due, false);

  // 抖动：每次只动 0.5 格（< 1.5 阈值）。这是"顶着墙角蹭"的典型形状。
  // 需要 4 次采样：第 1 次只初始化，之后 3 次各累加 1。
  const mJitter = createStagnationMonitor(O, { intervalMs: 5000, threshold: 1.5, maxStagnant: 3 });
  let rJitter;
  for (let i = 1; i <= 4; i++) rJitter = mJitter.sample({ x: i * 0.5, y: 64, z: 0 }, t0 + i * 5000);
  check('微小抖动（每步 0.5 格 < 1.5）→ 判卡死', rJitter.exhausted, true);
  check('微小抖动 → 位置确实在变（不是"没动"，是"动得不够"）', rJitter.travelled, 2);

  // 耗尽之后再真的动起来 → 视为恢复。
  //
  // ⚠️ 这里**刻意不是**一次性闩锁。HiyoriAI 的 `stuckDetector` 有个 `emitted`
  //    闩锁（"只播报一次"），那是为事件流设计的；我们的场景不同：
  //    调用方在 `exhausted` 为真时就会 `stop()`，本来就不会再采样。
  //    万一没停成（比如 stop 抛了）而她又自己挣出来了，继续报"卡死"是错的 ——
  //    那会让她永远放弃一个其实能做成的事。
  const recovered = mJitter.sample({ x: 99, y: 64, z: 0 }, t0 + 5 * 5000);
  check('耗尽后真的大幅移动 → 视为恢复（不是永久闩锁）', recovered.exhausted, false);
  check('恢复后 stagnant 归零', recovered.stagnant, 0);

  check('snapshot 报出来源与阈值，便于事后复盘',
    mJitter.snapshot().maxStagnant, 3);
  check('snapshot 的 bestDistance 是全程最远距离',
    mGood.snapshot().bestDistance, 30);

  console.log('\n[8/8] 自适应采集 —— "附近没有"和"我找不到"必须能区分开');
  // 背景：原来的 /mine 是"64 格内找一次，找不到就报没有"。
  // 于是"矿在 70 格外"和"这里真没矿"对外是同一句话。
  //
  // ⚠️ 最容易写错的一条：终止判据必须用**真正到手的东西数**，
  //    而不是"挖了几格"。挖了石头却没捡到（背包满/被抢/掉岩浆）时，
  //    按挖掉数判会认为有进展 → 她在一个拿不到东西的地方反复挖。

  // --- 半径序列
  check('默认序列从 16 翻倍到 128', buildRadiusLadder().join('|'), '16|32|64|128');
  check('序列长度受 maxSweeps 限制', buildRadiusLadder({ maxSweeps: 2 }).join('|'), '16|32');
  check('初始半径已经等于上限 → 序列只有一个', buildRadiusLadder({ initialRadius: 128, maxRadius: 128 }).join('|'), '128');
  check('初始大于上限 → 也被钳住（不会出现比上限还大的半径）',
    buildRadiusLadder({ initialRadius: 200, maxRadius: 64 }).join('|'), '200');
  check('初始 5、上限 20、最多 6 轮 → 5|10|20（到顶就停，不会重复 20）',
    buildRadiusLadder({ initialRadius: 5, maxRadius: 20, maxSweeps: 6 }).join('|'), '5|10|20');
  check('maxSweeps=1 → 只有初始半径', buildRadiusLadder({ maxSweeps: 1 }).join('|'), '16');
  check('非法输入不产生空序列', buildRadiusLadder({ initialRadius: 0, maxRadius: 0, maxSweeps: 0 }).length >= 1, true);

  // --- 收获判据
  check('真正到手 → 有收获', isProductiveSweep({ gainedItems: 3, brokenBlocks: 3 }).productive, true);
  check('挖了但没到手 → **不算**有收获（这一条是核心）',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).productive, false);
  check('挖了但没到手 → 理由里说得出可能的原因',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).reason.includes('没回头捡'), true);
  // 2026-09-25 补：背包满必须与"没回头捡"分开说 —— 两者处置方式完全不同
  check('背包满 → 理由直指"满"',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5, inventoryFull: true }).reason.includes('满'), true);
  check('背包满 → 与"没回头捡"不是同一句话',
    isProductiveSweep({ gainedItems: 0, brokenBlocks: 5, inventoryFull: true }).reason
    !== isProductiveSweep({ gainedItems: 0, brokenBlocks: 5 }).reason, true);
  check('背包满但真到手了 → 仍然算有收获',
    isProductiveSweep({ gainedItems: 2, brokenBlocks: 5, inventoryFull: true }).productive, true);
  check('什么都没挖 → 不算有收获', isProductiveSweep({ gainedItems: 0, brokenBlocks: 0 }).productive, false);
  check('空参数不炸', isProductiveSweep({}).productive, false);
  check('undefined 不炸', isProductiveSweep().productive, false);

  // --- 循环决策
  const ladder = buildRadiusLadder();   // [16,32,64,128]
  check('够了就收工',
    nextCollectStep({ got: 3, wanted: 3, ladder }).action, 'done');
  check('有收获就继续（不扩半径）',
    nextCollectStep({ sweep: 1, hit: true, productive: true, got: 1, wanted: 3, ladder }).action, 'continue');
  check('有收获时给出**当前**半径而不是更大的',
    nextCollectStep({ sweep: 2, hit: true, productive: true, got: 1, wanted: 3, ladder }).radius, 32);
  check('没找到目标 → 扩半径',
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).action, 'widen');
  check('扩到的是序列里的下一个', 
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).radius, 32);
  check('最后一轮还没找到 → 放弃，而不是无限扩',
    nextCollectStep({ sweep: 4, hit: false, productive: false, ladder }).action, 'give-up');
  check('放弃时说明搜到多大',
    nextCollectStep({ sweep: 4, hit: false, productive: false, ladder }).reason.includes('128'), true);
  // ⚠️ 这条区分度最细：**找到了但拿不到** != **没找到**。
  //    前者扩半径没用（问题不是"太远"），后者才有用。
  check('找到了但拿不到 → 不扩半径（扩了也没用）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).action, 'continue');
  // ⚠️⚠️ 这一段是 P2b 的回归锁（实机抓出来的）。
  //    原来这条断言写的是 `reason.includes('拿不到')` —— 它**恰好锁住了那个 bug**：
  //    nextCollectStep 自己写死一句"目标在但拿不到"，把上游分的三类原因全盖掉，
  //    而断言只检查"说了拿不到"，于是**测试替 bug 站岗**，一直绿到实机才暴露。
  //    现在改成验证**原因能透传**：上游说什么，这里就必须说什么。
  const whyFull = isProductiveSweep({ gainedItems: 0, brokenBlocks: 1, inventoryFull: true }).reason;
  const whyNotPicked = isProductiveSweep({ gainedItems: 0, brokenBlocks: 1 }).reason;
  check('上游说"背包满" → 原样透出（不被覆盖）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder, why: whyFull }).reason, whyFull);
  check('上游说"没回头捡" → 原样透出',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder, why: whyNotPicked }).reason, whyNotPicked);
  check('两种原因**不共用**一句文案（P2 的全部意义）', whyFull !== whyNotPicked, true);
  check('透出的理由能看出是"满"还是"没捡"',
    /满/.test(nextCollectStep({ hit: true, ladder, why: whyFull }).reason), true);
  check('没传 why 时不假装知道原因（给出显式的"未上报"）',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).reason.includes('未上报'), true);
  check('没传 why 也**绝不会**再写死那句旧的"拿不到"',
    nextCollectStep({ sweep: 1, hit: true, productive: false, ladder }).reason.includes('拿不到'), false);
  check('没找到才扩半径（对比上一条）',
    nextCollectStep({ sweep: 1, hit: false, productive: false, ladder }).action, 'widen');

  console.log('\n[7/7] 寻路目标的清理契约 —— "超时后必须清干净"（field-log P25）');
  //
  // 为什么要有这一节：这是**唯一一个"代码全对、自测全绿、实机全废"的 bug**。
  // `/pickup` 和 `sweepUpDrops` 都用了 `Promise.race([goto(...), sleep(...)])`，
  // 逻辑上完全正确 —— 问题出在 race 输掉后的**收尾**没人做。
  // 这类 bug 没法靠"给函数喂不同输入看返回值"抓到，只能把**契约**本身做成断言。
  const fakePf = () => {
    const calls = { stop: 0, setGoal: [] };
    return {
      calls,
      stop () { calls.stop++; },
      setGoal (g) { calls.setGoal.push(g); },
    };
  };

  const pf1 = fakePf();
  check('清理会调 stop()', (() => { clearPathfinderGoal(pf1); return pf1.calls.stop; })(), 1);
  check('清理也会调 setGoal(null)', pf1.calls.setGoal.length, 1);
  check('setGoal 的参数确实是 null（不是 undefined）', pf1.calls.setGoal[0], null);
  check('返回 true 表示确实清理了', clearPathfinderGoal(fakePf()), true);

  // ⚠️ 两个都要调，缺一个都不够 —— 只 stop 会让下轮 goto 继续抛
  //    "goal was changed"，只 setGoal(null) 会留下正在跑的路径。
  const pfOnlyStop = { stop () {}, setGoal () { throw new Error('boom'); } };
  check('setGoal 抛错也不影响 —— 清理失败不能升级成任务失败', clearPathfinderGoal(pfOnlyStop), true);
  const pfDead = { get stop () { throw new Error('no pf'); }, get setGoal () { throw new Error('no pf'); } };
  check('pathfinder 整个不可用时不抛异常', clearPathfinderGoal(pfDead), false);
  check('传 null 也不抛（bot 未连接时会出现）', clearPathfinderGoal(null), false);
  check('传 undefined 也不抛', clearPathfinderGoal(undefined), false);

  // 反例锁 ①：不能再退回去用"不会结束的目标 + 超时"这个组合。
  // `GoalFollow` 的 `isEnd()` 要求"进入 range 且视线可达"，
  // 掉落物被自己挖的坑挡住视野时永不成立 —— 配上超时就是必然走满超时。
  //
  // 反例锁 ②（更重要的那条）：**清理不能发生在 goto 之后。**
  // `setGoal(null)` 会 emit `goal_updated(null)`，如果下一个 goto 已经
  // 注册好 listener 在等，它收到 null 就报 GoalChanged —— 实测 0ms 内失败，
  // 地上 1.4 格的掉落物一个都捡不到。清理只允许出现在"无人等待"的时刻。
  // ⚠️ 形状锁要读**整个拆出来的目录**（第 3 步重构，2026-09-29）：
  //    原来是 `readFileSync(__filename)`（那时整个 pathing 就一个文件）；
  //    现在 `clearPathfinderGoal` 在 `budget.js`、别的修复点可能在各子文件里，
  //    只读 selftest.js 自己会把锁**读空**（正则全不匹配 → 断言或静默失效）。
  //    bridge 那边（下面那段）早就是这么做的：整目录拼起来读，锁的意思不变。
  const __srcFiles = (() => {
    const fs = require('fs'); const p = require('path');
    try { return fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).sort().map(f => p.join(__dirname, f)); }
    catch (_) { return [__filename]; }
  })();
  const src = __srcFiles.map(f => require('fs').readFileSync(f, 'utf8')).join('\n');
  check('P25 反例锁：catch 块里不会再出现裸的 goto 重试',
    /catch \(_\) \{[^}]*goto\(/.test(src), false);
  check('clearPathfinderGoal 有独立实现（不是散落的 stop+setGoal）',
    /function clearPathfinderGoal/.test(src), true);
  check('clearPathfinderGoal 确实同时做了 stop 与 setGoal(null)',
    /pf\.stop\(\);[\s\S]{0,120}pf\.setGoal\(null\)/.test(src), true);

  // ---- 跨文件源码形状锁（bridge-server 不能 --selftest，只能靠这里锁住）--------
  //
  // ⚠️ 为什么放这里：任务硬规矩规定 `bridge-server.js` **绝不能** `--selftest`
  //    （一跑就真起服务器、连游戏）。但 fix0/fix2 的修复点就在 bridge 里，
  //    没有测试就等于没护栏。pathing.js 是 bridge 的依赖、且能离线自测，
  //    把"这两个修复点还在不在"锁在这里 —— 属于**形状锁**（grep 级），
  //    它不能证明逻辑对（逻辑由纯函数自测证明），只防"改回去"。
  {
    let bsrc = '';
    // 第 3 步拆巨石后 bridge 分成 src/bridge/ 下多个文件：整目录（含 routes/）拼起来读，锁的意思不变
    try {
      const fs = require('fs'); const p = require('path'); const dir = p.join(paths.ROOT, 'src', 'bridge');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => p.join(dir, f))
        .concat(fs.readdirSync(p.join(dir, 'routes')).filter(f => f.endsWith('.js')).map(f => p.join(dir, 'routes', f)));
      bsrc = files.sort().map(f => fs.readFileSync(f, 'utf8')).join('\n');
    } catch (_) {}
    if (bsrc) {
      // fix0 #1：严格预算 —— 必须有 `budgetLeftMs`，且不再出现旧的 `budgetMs - (Date.now() - t0)` 形式
      check('★ bridge /pickup 有严格预算 budgetLeftMs（fix0 #1）', /budgetLeftMs/.test(bsrc), true);
      check('★ bridge /pickup 不再用旧的「剩余预算」写法（fix0 #1）',
        /Math\.min\(timeoutMs, Math\.max\(1000, budgetMs - \(Date\.now\(\) - t0\)\)\)/.test(bsrc), false);
      // fix0 #2：空掉落物返回完整结构 + stopped 明写 null
      check('★ bridge /pickup 空掉落物也回 tried/reached/stopped/ms（fix0 #2）',
        /if \(!drops\.length\) \{[\s\S]{0,300}tried: \[\], reached: \[\], stopped: null, ms: 0/.test(bsrc), true);
      check('★ bridge /pickup 正常返回 stopped 明写 null（不靠 undefined 被丢）',
        /tried, reached, stopped: stopped \|\| null, ms: Date\.now\(\) - t0/.test(bsrc), true);
      // fix0 #3：tried.push 在 isValid 检查之后
      check('★ bridge /pickup 先确认实体有效再记 tried（fix0 #3）',
        /if \(!d\.isValid \|\| !d\.position\) continue;\s*\n\s*tried\.push\(d\.id\);/.test(bsrc), true);
      // wbR2：预算补判的"还有没轮到的"不能用索引上界（无效实体也占索引），要按有效目标数
      check('★ bridge /pickup 预算补判按「还有有效目标」而不是 i < drops.length-1（wbR2）',
        /drops\.slice\(i \+ 1\)\.some\(x => x\.isValid !== false && x\.position\)/.test(bsrc), true);
      check('★ bridge /pickup 不再用索引上界判"还有没轮到的"（wbR2）',
        /if \(i < drops\.length - 1 && budgetLeftMs\(\) <= 1000 && stopped === null\)/.test(bsrc), false);
      // fix2 #2：否决响应先展开 result，再贴 success/ok
      check('★ bridge 否决响应顺序：...result 在前、success/ok 在后（fix2 #2）',
        /\.\.\.result,\s*\n\s*success: false,\s*\n\s*ok: false,/.test(bsrc), true);
      check('★ bridge 否决响应不再是有缺陷的 success/ok 在前（fix2 #2）',
        /success: false,\s*\n\s*ok: false,\s*\n\s*\.\.\.result,/.test(bsrc), false);
      // fix2 #3：gotoWithBudget 处理 begin() 返回 null
      check('★ bridge gotoWithBudget 处理 begin() 被拒（fix2 #3）',
        /const token = owner\.begin\(\);\s*\n\s*if \(!token\)/.test(bsrc), true);
      // fix1 #2：/nearby 复用 aggro（不再把 aggroOf 函数传进去算第二遍）
      check('★ bridge /nearby 复用 aggro 结果（fix1 #2）',
        /isHostileEntity\(e, \(\) => aggro\)/.test(bsrc), true);
      // fix2 #4：崩溃兜底按 loadPlugin 前后快照认定监听身份
      check('★ bridge 崩溃兜底按 before 快照认定 pathfinder 监听（fix2 #4）',
        /isPathfinderListener: \(fn\) => !beforeSet\.has\(fn\)/.test(bsrc), true);
    }
  }

  // ---- 目标所有权登记簿 + 失败分类（N-1：mine goto 80/81 次 GoalChanged）------
  //
  // 这一节测的是**判据本身**：一次"目标被换掉"到底是"我们自己收手"还是"真的失败"。
  // 上层（/mine 循环、go() 重试链）据此决定要不要重试整条链 —— 判错就会
  // 把"让出身体"当成"没走成"，于是拿已经作废的任务一遍遍重跑（正是 80/81 的成因）。
  console.log('\n[9/9] 目标所有权与失败分类 —— "自己换的目标"不能算失败（N-1）');
  {
    const owner = createGoalOwner();
    const t1 = owner.begin();
    check('begin() 之后确实有人持有', owner.hasOwner(), true);
    check('没出错 → ok', classifyGotoOutcome(null, false), 'ok');
    // 我们自己发起的变更（cancelCommands / abort / 让出身体）
    owner.noteSelfChange();
    const c1 = owner.classify(t1, 'GoalChanged');
    check('自己发起的目标变更 → selfAbort', c1.reason, 'selfAbort');
    check('selfAbort 标记 selfInitiated', c1.selfInitiated, true);
    check('★ 自己取消不算失败（这是 80/81 的判据）',
      classifyGotoOutcome('GoalChanged', true), 'aborted');
    check('PathStopped + 自己发起，同样算中止',
      classifyGotoOutcome('PathStopped', true), 'aborted');
    check('★ 外部抢走目标 → failed（该如实报错）',
      classifyGotoOutcome('GoalChanged', false), 'failed');
    check('超时永远是失败，与谁发起无关',
      classifyGotoOutcome('Timeout', true), 'failed');
    check('卡住永远是失败', classifyGotoOutcome('Stuck', true), 'failed');
    // ⚠️ 2026-09-28 回归（codex fix2 #1）：`null`（明确没出错）才是 ok；
    //    `undefined`（读不到，catch 里 e.name 缺失）必须保守按 failed —— 改前是 ok。
    check('★ 明确没出错（null）→ ok', classifyGotoOutcome(null, false), 'ok');
    check('★ 读不到错误名（undefined）→ 保守 failed（改前误判 ok）',
      classifyGotoOutcome(undefined, true), 'failed');
    check('★ 空字符串错误名 → 同样保守 failed', classifyGotoOutcome('', true), 'failed');

    // ⚠️ 2026-09-28 回归（codex fix2 #3）：begin() 必须是**真互斥锁** ——
    //    已有 owner 时拒绝（返回 null），不再覆盖 token。改前第二次 begin 会拿到新 token。
    const ownerMx = createGoalOwner();
    const tA = ownerMx.begin();
    check('★ 第一次 begin 拿到 token', tA !== null, true);
    check('★ 已有 owner 时再 begin 被拒（返回 null）', ownerMx.begin(), null);
    check('★ 被拒也计入 stats.refused', ownerMx.stats().refused, 1);
    check('★ 被拒不改当前持有者（还是 A）', ownerMx.owner().id, tA.id);
    ownerMx.classify(tA, null);
    check('★ 释放后可以再 begin', ownerMx.begin() !== null, true);

    // 外部变更：先 begin 再 noteExternalChange
    const owner2 = createGoalOwner();
    const t2 = owner2.begin();
    owner2.noteExternalChange();
    check('外部变更 → external', owner2.classify(t2, 'GoalChanged').reason, 'external');

    // 过期的 token（已经不是当前持有者）不能误判成"自己人"
    const owner3 = createGoalOwner();
    const stale = owner3.begin();
    owner3.classify(stale, null);            // 先正常释放（begin 现在是互斥锁，不能再抢一次）
    const fresh = owner3.begin();
    owner3.noteSelfChange();
    check('过期 token → stale（不冒领）', owner3.classify(stale, 'GoalChanged').reason, 'stale');
    check('过期 token 不把当前持有者一起释放', owner3.hasOwner(), true);
    owner3.classify(fresh, null);
    check('当前持有者正常释放', owner3.hasOwner(), false);
    check('登记簿统计有记录', owner3.stats().begins, 2);

    // 源码形状锁：gotoWithBudget 必须真的用上这套判据，而不是只 import。
    check('gotoWithBudget 用了 createGoalOwner',
      /createGoalOwner\(\)/.test(src), true);
    check('gotoWithBudget 区分 abort 与 failed（有 aborted 语义）',
      /aborted/.test(src) && /classifyGotoOutcome/.test(src), true);
  }

  console.log('\n[10/10] physicsTick 崩溃兜底 —— 一次开门不能杀掉整个进程');
  {
    // 假 bot：一条会像 mineflayer-pathfinder 的 monitorMovement 那样抛的 physicsTick 监听。
    // ⚠️ 用 `rawListeners` 拿到真实函数，和实装路径一致（见 installPhysicsTickGuard）。
    const EventEmitter = require('events');
    const mkFakeBot = () => {
      const bot = new EventEmitter();
      bot.pathfinder = { stop () { bot.stopped = (bot.stopped || 0) + 1; }, setGoal (g) { bot.goal = g; } };
      bot.clearControlStates = () => { bot.cleared = (bot.cleared || 0) + 1; };
      return bot;
    };
    // 模拟库 index.js:538 —— `placingBlock.y`，而 placingBlock 是 undefined。
    // ⚠️ 2026-09-28（codex fix2 #4）：源码判据现在是"`monitorMovement` **且**
    //    `pathfinder`（大小写不敏感）**都**出现"。真实函数体里本来就有
    //    `mineflayer-pathfinder` 这条 require 痕迹（下面用变量名带出来），
    //    所以**不需要**伪造 toString —— 造假的 toString 对
    //    `Function.prototype.toString.call(fn)` 根本不起作用，原来的自测是假覆盖。
    const makePfMovement = () => function monitorMovement () {
      // eslint-disable-next-line no-unused-vars
      const mineflayerPathfinderPlacingBlock = undefined;   // 源码含 'pathfinder'，函数名含 'monitorMovement'
      return mineflayerPathfinderPlacingBlock.y;   // 抛：Cannot read properties of undefined (reading 'y')
    };
    // 只用"调用方登记的身份"（最可靠的一层）来识别 —— 模拟 bridge 用 before/after 快照。
    const mkIsPf = (...fns) => (fn) => fns.includes(fn);

    // ① 正常情况下：没兜底时，抛出的异常会从 emit 冒出来
    {
      const bot = mkFakeBot();
      bot.on('physicsTick', makePfMovement());
      let threw = false;
      try { bot.emit('physicsTick'); } catch (_) { threw = true; }
      check('★ 复现：没兜底时 physicsTick 抛出（会杀掉 setInterval 驱动的进程）', threw, true);
    }
    // ② 装上兜底之后：不再抛，且寻路状态被清干净
    {
      const bot = mkFakeBot();
      const errs = [];
      const pf = makePfMovement();
      bot.on('physicsTick', pf);
      const r = installPhysicsTickGuard(bot, { onError: e => errs.push(e), isPathfinderListener: mkIsPf(pf) });
      check('兜底装上了（wrapped=1）', `${r.installed}/${r.wrapped}`, 'true/1');
      let threw = false;
      try { bot.emit('physicsTick'); } catch (_) { threw = true; }
      check('★ 兜底后不再抛（进程不会被带走）', threw, false);
      check('崩溃被上报（记了一行）', errs.length, 1);
      check('崩溃后清了 pathfinder 目标', bot.goal, null);
      check('崩溃后停过 pathfinder', bot.stopped, 1);
      check('崩溃后松了按键', bot.cleared, 1);
    }
    // ③ 非 pathfinder 的监听不能被误吞（别人的异常照旧抛）
    //    ⚠️ 而且这里**故意**让别人的函数体里出现 monitorMovement 字样 ——
    //       证明"收紧了源码判据"之后，不会因为同名就误包它。
    {
      const bot = mkFakeBot();
      const pf = makePfMovement();
      // 别人的监听：函数名恰好也叫 monitorMovement（模拟"别的插件同名"），而且会抛
      function monitorMovement () { throw new Error('别人的 bug'); }
      bot.on('physicsTick', pf);
      bot.on('physicsTick', monitorMovement);
      installPhysicsTickGuard(bot, { isPathfinderListener: mkIsPf(pf) });
      let msg = null;
      try { bot.emit('physicsTick'); } catch (e) { msg = e.message; }
      check('★ 只兜 pathfinder 那条：同名监听（monitorMovement）的异常照旧抛', msg, '别人的 bug');
    }
    // ③b 没有 ① 登记时，收紧的源码判据仍能认出真 pathfinder（函数名 monitorMovement + 源码含 pathfinder）
    {
      const bot = mkFakeBot();
      const pf = makePfMovement();
      bot.on('physicsTick', pf);
      const r = installPhysicsTickGuard(bot, {});   // 不给 isPathfinderListener
      check('★ 没登记时靠收紧源码判据也能装上（monitorMovement + pathfinder）', `${r.installed}/${r.wrapped}`, 'true/1');
    }
    // ③c 源码判据"收紧"的反例：函数名/源码里只有 monitorMovement、没有 pathfinder → 不误包
    {
      const bot = mkFakeBot();
      function monitorMovement () { throw new Error('只有 monitorMovement，别的插件的监听'); }
      bot.on('physicsTick', monitorMovement);
      const r = installPhysicsTickGuard(bot, {});
      check('★ 只含 monitorMovement、不含 pathfinder → 不误包（installed:false）', r.installed, false);
    }
    // ④ 读不到 pathfinder 监听时不假装装上（保守，AGENTS §5）
    {
      const bot = mkFakeBot();
      bot.on('physicsTick', () => {});
      const r = installPhysicsTickGuard(bot, {});
      check('没找到 pathfinder 监听 → installed:false', r.installed, false);
      check('并且给出原因（不静默）', typeof r.reason, 'string');
    }
    // ⑤ 重复装不套娃
    {
      const bot = mkFakeBot();
      const pf = makePfMovement();
      bot.on('physicsTick', pf);
      installPhysicsTickGuard(bot, { isPathfinderListener: mkIsPf(pf) });
      const r2 = installPhysicsTickGuard(bot, { isPathfinderListener: mkIsPf(pf) });
      check('重复装不套娃', `${r2.installed}/${r2.wrapped}`, 'true/1');
    }
    // ⑥ 不是 EventEmitter 也不抛
    {
      check('传 null 不抛', installPhysicsTickGuard(null, {}).installed, false);
      check('传普通对象不抛', installPhysicsTickGuard({}, {}).installed, false);
    }
  }

  // ---- P25 的**行为**回归：用假的 bot 复现"清理时机"的两种写法 --------------
  //
  // 上面那些是源码形状锁（`grep` 级），只能防"改回去"，
  // 不能证明"现在这个写法是对的"。这一段把 `goto.js` 的判定逻辑**照搬**过来，
  // 让两种时序真跑一遍，看结果差在哪。
  //
  // 为什么要照搬而不是 import：`goto.js` 需要一个真的 mineflayer bot 实例。
  // 而这里要验的是**时序**，不是寻路 —— 一个 EventEmitter 就够。
  const EventEmitter = require('events');

  // ⚠️ 这一段是**异步**的（要跑真的事件时序），而自测主体是同步的。
  //    不能直接在顶层 `await`（CommonJS 里没有 top-level await），
  //    所以把场景串成 promise 链，最后在 `.then()` 里收尾退出。
  //
  // 模型要点（第一版模型错了，记下来）：
  //   · 清理必须是**异步触发**的（`setTimeout`）才能复现 —— 因为真实的
  //     `withTimeout` 就是定时器到点才清。同步清的话，下一个 goto 的
  //     listener 还没注册，打不到它，现象反而是"两边都挂着"。
  //   · 一旦改成异步，`setGoal(null)` 就会精准落在"某个 goto 已注册 listener
  //     并在等"的窗口里 → 那个 goto 立刻报 GoalChanged。
  //     实测抛错栈：`at Object.setGoal → at Timeout._onTimeout` ——
  //     罪魁就是这个**定时器里的 setGoal**。

  /** 极简版 goto()：判定逻辑与 mineflayer-pathfinder/lib/goto.js 一致 */
  function fakeGoto (bot, goal) {
    return new Promise((resolve, reject) => {
      function cleanup (err) {
        bot.removeListener('goal_reached', onReached);
        bot.removeListener('goal_updated', onChanged);
        setTimeout(() => (err ? reject(err) : resolve()), 0);
      }
      function onReached () { cleanup(); }
      function onChanged (newGoal) {
        // ★ P25 的核心：newGoal 为 null 时不等于 goal → 立刻报错
        if (newGoal !== goal) {
          const e = new Error('The goal was changed before it could be completed!');
          e.name = 'GoalChanged';
          cleanup(e);
        }
      }
      bot.on('goal_reached', onReached);
      bot.on('goal_updated', onChanged);
      bot.emit('goal_updated', goal, false);   // 等价于 setGoal(goal) 的 emit
    });
  }

  const mkBot = () => {
    const b = new EventEmitter();
    b.pathfinder = {
      goal: null,
      stop () {},
      setGoal (g) { b.pathfinder.goal = g; b.emit('goal_updated', g, false); },
    };
    return b;
  };
  const mkGoal = () => ({ constructor: { name: 'GoalNear' } });
  const settle = (p, ms) => Promise.race([
    p.then(() => 'resolved', e => 'rejected:' + e.name),
    new Promise(r => setTimeout(() => r('STILL-WAITING'), ms)),
  ]);

  // 场景 A（**错的**写法）：`withTimeout` 到点自己清
  //   → `setGoal(null)` 落在"goalA 还在等"的窗口里 → 打死它
  const scenarioWrong = () => {
    const bot = mkBot();
    const pA = fakeGoto(bot, mkGoal());
    return new Promise(resolve => {
      setTimeout(() => {
        bot.pathfinder.setGoal(null);   // ← 我第一版的 cleanup()
        resolve();
      }, 15);
    }).then(() => settle(pA, 30)).then(outcome => {
      check('★ 复现：定时器里清 goal → 正在等的 goto 报 GoalChanged（这就是 0ms 失败）',
        outcome, 'rejected:GoalChanged');
    });
  };

  // 场景 B（**对的**写法）：只在发起 goto **之前**清
  //   → 清的时候无人等待，安全
  const scenarioRight = () => {
    const bot = mkBot();
    const run = async () => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        bot.pathfinder.setGoal(null);           // ← 开始之前清（安全）
        const p = fakeGoto(bot, mkGoal());
        setImmediate(() => bot.emit('goal_reached'));
        out.push(await settle(p, 40));
      }
      return out;
    };
    return run().then(out => {
      check('★ 正确写法：连续 3 个目标全部正常完成',
        out.every(r => r === 'resolved'), true);
    });
  };

  // 场景 C（N-1 的行为回归）：把 `gotoWithBudget` 的**判据**照搬，
  // 让"自己取消"与"被人抢"两种时序真跑一遍，看结果分不分得开。
  //
  // 为什么是行为测试而不是只测纯函数：纯函数能证明 `classifyGotoOutcome` 对，
  // **不能**证明它在真实事件流里被喂对了输入。这里把
  // `begin → 事件 → classify` 的接线也跑一遍：
  //   · 自己取消（cancelCommands）→ GoalChanged 但 classified=aborted → **不抛**；
  //   · 被人抢（另一个命令 setGoal）→ GoalChanged 且 classified=failed → **抛**。
  const scenarioOwnership = () => {
    const run = async () => {
      // —— C1：自己取消（这就是 mine stone 80/81 次里的那一类）
      {
        const bot = mkBot();
        const owner = createGoalOwner();
        const token = owner.begin();
        let cancelIssued = false;
        bot.on('goal_updated', () => { if (cancelIssued) owner.noteSelfChange(); });
        const p = fakeGoto(bot, mkGoal());
        setImmediate(() => { cancelIssued = true; bot.pathfinder.setGoal(null); });  // cancelCommands()
        const outcome = await settle(p, 40);
        const errName = outcome === 'resolved' ? null : outcome.replace('rejected:', '');
        const self = owner.classify(token, errName).selfInitiated || cancelIssued;
        const verdict = classifyGotoOutcome(errName, self);
        check('★ C1 自己取消：goto 结束时看到 GoalChanged', errName, 'GoalChanged');
        check('★ C1 自己取消：判据是 aborted（不算失败）', verdict, 'aborted');
      }
      // —— C2：被别人抢走目标（真的失败，必须如实抛）
      {
        const bot = mkBot();
        const owner = createGoalOwner();
        const token = owner.begin();
        let cancelIssued = false;   // 没人取消
        bot.on('goal_updated', () => { if (cancelIssued) owner.noteSelfChange(); });
        const p = fakeGoto(bot, mkGoal());
        setImmediate(() => { bot.pathfinder.setGoal(mkGoal()); });   // 另一个命令抢
        const outcome = await settle(p, 40);
        const errName = outcome === 'resolved' ? null : outcome.replace('rejected:', '');
        const self = owner.classify(token, errName).selfInitiated || cancelIssued;
        check('★ C2 被抢目标：判据是 failed（如实报错）',
          classifyGotoOutcome(errName, self), 'failed');
      }
      // —— C3：续期**不**打断自己（续期只改 budget，不 setGoal）
      {
        const bot = mkBot();
        const p = fakeGoto(bot, mkGoal());
        // 模拟 onPathUpdate 续期：只动 budget，不碰 goal
        const budget = { timeoutMs: 30000 };
        const renewals = [1, 2, 3].map(n => { budget.timeoutMs = 30000 * n; return n; });
        setTimeout(() => bot.emit('goal_reached'), 20);
        const outcome = await settle(p, 60);
        check('★ C3 续期（不 setGoal）→ goto 正常完成，不被自己打断', outcome, 'resolved');
        check('★ C3 续期计数确实发生过', renewals.length, 3);
      }
      check('★ C4 外部 setGoal(不同对象) → 即使没人取消也是 failed', (() => {
        const owner = createGoalOwner();
        const token = owner.begin();
        const external = true;   // 不是自己发起
        return classifyGotoOutcome('GoalChanged', !external);
      })(), 'failed');
    };
    return run();
  };

  check('模组床是矮方块（9/16 高）', lowBlockHeight('handcrafted:oak_fancy_bed'), 0.5625);
  check('床头柜之类不是', lowBlockHeight('handcrafted:oak_nightstand'), 0);
  // ---- 开门路径：开门格可走，但不能横穿门板；关门格触发 useOne ----
  // ⚠️ 用一个**按坐标取方块**的假世界。上一版把 `dx` 当字典键用，所以"读邻格"那条判据
  //    根本走不到（邻格恒为 undefined）—— 自测测不到真代码，等于没测。
  {
    const key = (x, y, z) => `${x},${y},${z}`;
    const makeMv = (cells) => {
      const map = new Map(cells);
      return {
        map,
        getBlock (pos, dx, dy, dz) {
          const d = map.get(key(pos.x + dx, pos.y + dy, pos.z + dz));
          const name = d ? d.name : 'minecraft:air';
          const solid = d ? d.solid !== false : false;
          const props = { open: d && d.open ? 'TRUE' : 'false' };
          if (d && d.facing !== undefined) props.facing = d.facing;
          if (d && d.half !== undefined) props.half = d.half;
          const b = {
            name,
            position: { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz },
            getProperties: () => props,
            boundingBox: solid ? 'block' : 'empty',
            safe: !solid,
            physical: solid,
            shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [],
            height: pos.y + dy,
          };
          return b;
        },
        getNeighbors (node) {
          return [
            { x: node.x + 1, y: node.y, z: node.z },
            { x: node.x, y: node.y, z: node.z + 1 },
            { x: node.x - 1, y: node.y, z: node.z },
          ];
        },
      };
    };
    const door = (facing, open = true) => ({ name: 'minecraft:dark_oak_door', open, facing, solid: true });
    const wall = { name: 'minecraft:stone', solid: true };
    const air = { name: 'minecraft:air', solid: false };
    const at = (mv) => mv.getBlock({ x: 0, y: 64, z: 0 }, 0, 0, 0);

    // ⚠️ `stats` 只在 `getBlock` **真的被调用**时才累加（寻路器问一次才记一笔）。
    //    所以凡是断言计数的用例，都必须先自己调一次 `at(mv)` 触发，且**只调一次** ——
    //    写成 `${at(mv).safe}/${at(mv).physical}` 会把同一条断言算成两次，计数对不上。
    {
      // 门嵌在墙里（facing=south → 门板法线是 X → 看 (0,64,±1)）：常态，必须放行
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', wall], ['-1,64,0', wall]]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('门嵌在墙里：开着的门放行（safe/physical）', `${b.safe}/${b.physical}`, 'true/false');
      check('门嵌在墙里：放行计数 1、拒绝 0', `${rep.stats.passed}/${rep.stats.refused}`, '1/0');
    }
    {
      // 两侧都通时门格仍须可走；禁的是横穿门板的有向边。
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', air], ['-1,64,0', air]]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('门板两侧都通：门格可走', `${b.safe}/${b.physical}`, 'true/false');
      const edges = mv.getNeighbors({ x: 0, y: 64, z: 0 });
      check('门板方向横穿被拦，门洞方向可走', edges.map(p => `${p.x},${p.z}`).join(' | '), '0,1');
      check('横穿拒绝记下位置与轴', `${rep.stats.refused}/${rep.stats.refusedAt[0]?.axis}`, '2/x');
    }
    {
      const mv = makeMv([['-1,64,0', door('north')], ['0,64,1', { name: 'dark_oak_trapdoor', open: true, solid: true }]]);
      mv.getNeighbors = () => [{ x: -1, y: 64, z: 1 }];
      applyOpenDoors(mv);
      check('门与活板门夹角不能斜切', mv.getNeighbors({ x: 0, y: 64, z: 0 }).length, 0);
    }
    {
      const { EventEmitter } = require('events');
      const { Vec3 } = require('vec3');
      const mv = makeMv([['1,64,0', door('east', false)]]);
      const bot = new EventEmitter();
      bot.entity = { position: new Vec3(0.5, 64, 0.5) };
      bot.blockAt = p => mv.getBlock(p, 0, 0, 0);
      const rep = applyOpenDoors(mv, bot);
      const path = [{ x: 1, y: 64, z: 0 }];
      bot.emit('path_update', { path });
      bot.emit('path_reset', 'stuck');
      check('门口卡住：原边暂时禁行，试别的边', mv.getNeighbors(new Vec3(0, 64, 0)).map(p => `${p.x},${p.z}`).join('|'), '0,1|-1,0');
      check('门口卡住：换路计数留证据', rep.stats.reroutes, 1);
    }
    {
      // 只有一侧是墙 → 横穿不可能 → 放行
      const mv = makeMv([['0,64,0', door('south')], ['1,64,0', air], ['-1,64,0', wall]]);
      applyOpenDoors(mv);
      check('只有一侧是墙：放行（横穿不可能）', at(mv).safe, true);
    }
    {
      // facing=east → 门板法线是 Z：X 两侧通也不该拦
      const mv = makeMv([
        ['0,64,0', door('east')], ['1,64,0', air], ['-1,64,0', air],
        ['0,64,1', wall], ['0,64,-1', wall],
      ]);
      applyOpenDoors(mv);
      check('facing=east：看法线轴 Z，X 两侧通不拦', at(mv).safe, true);
    }
    {
      // 同一个门把 Z 两侧也打通，仍可沿 X 穿过门洞。
      const mv = makeMv([
        ['0,64,0', door('east')], ['1,64,0', air], ['-1,64,0', air],
        ['0,64,1', air], ['0,64,-1', air],
      ]);
      const rep = applyOpenDoors(mv);
      const b = at(mv);
      check('facing=east：门格可走，Z 向边被拦', `${b.safe}/${b.physical}/${mv.getNeighbors({ x: 0, y: 64, z: 0 }).length}/${rep.stats.refused}`, 'true/false/2/1');
    }
    {
      const mv = makeMv([
        ['0,64,0', door('south', false)],                                                     // 关着的门
        ['2,64,0', { name: 'minecraft:oak_trapdoor', open: true, facing: 'south', solid: true }],
        ['4,64,0', { name: 'mcwdoors:garage_door', open: true, facing: 'south', solid: true }],
        ['5,64,0', wall], ['3,64,0', wall],
      ]);
      applyOpenDoors(mv);
      check('关着的门：还是墙', `${at(mv).safe}/${at(mv).physical}`, 'false/true');
      check('关着的木门纳入路径开门动作', `${mv.canOpenDoors}/${at(mv).openable}`, 'true/true');
      check('活板门不归它管',
        mv.getBlock({ x: 2, y: 64, z: 0 }, 0, 0, 0).physical, true);
      check('模组的门（名字以 _door 结尾）也认',
        mv.getBlock({ x: 4, y: 64, z: 0 }, 0, 0, 0).safe, true);
      const g1 = mv.getBlock;
      const again = applyOpenDoors(mv);
      check('重复装不会套娃', mv.getBlock === g1, true);
      check('重复装时把原来的 stats 一起报回来', again.stats === mv.__openDoorsStats, true);
    }
    {
      const mv = makeMv([
        ['0,64,0', { ...door('south', false), half: 'lower' }],
        ['0,65,0', { ...door('south', false), half: 'upper' }],
      ]);
      applyOpenDoors(mv);
      check('关门上半格不阻断开门路径', mv.getBlock({ x: 0, y: 64, z: 0 }, 0, 1, 0).safe, true);
      check('关门下半格仍需先开', `${at(mv).safe}/${at(mv).openable}`, 'false/true');
    }
    {
      // 用真正的 mineflayer-pathfinder getMoveForward 验证 useOne，不手抄它的判据。
      const { Movements } = require('mineflayer-pathfinder');
      const mv = makeMv([
        ['0,64,0', { ...door('south', false), half: 'lower' }],
        ['0,65,0', { ...door('south', false), half: 'upper' }],
        ['0,63,0', wall],
      ]);
      mv.exclusionStep = () => 0;
      mv.getNumEntitiesAt = () => 0;
      mv.safeOrBreak = b => b.safe ? 0 : 100;
      applyOpenDoors(mv);
      const next = [];
      Movements.prototype.getMoveForward.call(mv, { x: 0, y: 64, z: -1, remainingBlocks: 0 }, { x: 0, z: 1 }, next);
      check('真正的寻路器把关门算成可走的一步', next.length, 1);
      check('真正的寻路器在这一步安排右键开门', next[0]?.toPlace[0]?.useOne, true);
    }
    {
      // 读不到 facing（模组门可能用别的属性名）：保持放行 —— 不能退回"门里出不去"
      const mv = makeMv([['0,64,0', { name: 'mod:odd_door', open: true, solid: true }], ['1,64,0', air], ['-1,64,0', air]]);
      const rep = applyOpenDoors(mv);
      check('读不到 facing：保持放行', at(mv).safe, true);
      check('读不到 facing：单独计数（"读不到"不混进"没有"）', rep.stats.noFacing, 1);
    }
  }

  scenarioWrong()
    .then(scenarioRight)
    .then(scenarioOwnership)
    .then(() => {
      console.log(`\n  ${pass}/${total} 通过`);
      process.exit(pass === total ? 0 : 1);
    })
    .catch(e => {
      console.log(`\n  自测自身出错：${e.message}`);
      process.exit(1);
    });
}
}

// ⚠️ 谁来判断"该不该跑"：**只有汇总 `index.js` 知道**（2026-09-29 拆分新增）。
//   本文件里 `require.main` 恒等于"最先被执行的那个 js"（`bridge-server.js` 也一样），
//   根本分不出"有人想跑 pathing 自测"和"有人只是 require 了 pathing 顺带带上 --selftest"。
//   所以汇总在**它自己被直接跑**时（`require.main === module`，即 `node src/world/pathing.js`）
//   会调 `markSelftestRequested()` 把开关打开；本文件
//     · 开关 TRUE  → 跑自测，退出码 0/1（正常路径）；
//     · 开关 FALSE → 什么也不做、退出 0。这样"谁带 --selftest 都不该连累别人"这条原意保住了：
//         `node bridge-server.js --selftest` / `node palette-registry.js --selftest` 都不再打 pathing 的用例；
//         test-all 单独扫到本文件时也是安静绿（它的 475 条在 `src/world/pathing.js --selftest` 那项里）。
//   绝不能改成无条件 return：那就永久静默，`node src/world/pathing.js --selftest` 也会变成
//   "什么都没跑还返回 0"（汇总那侧也靠这个开关决定调不调 run()）。
let __requested = false;
function markSelftestRequested () { __requested = true; }
module.exports.markSelftestRequested = markSelftestRequested;
