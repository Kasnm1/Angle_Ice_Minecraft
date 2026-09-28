'use strict';

const storagePolicy = require('../body/storage-policy');
const paths = require('../paths');
// 事件循环延迟监控（2026-09-28）：5 分钟一次的 homeTimer 大扫描曾让整个进程冻 ~14 秒
// （实机 live-1214：12:20/12:25 的 scheduler.lagMs = 13511 / 14027，busyForMs 却是 0）。
// monitorEventLoopDelay 量的是**事件循环本身**的延迟，和"本能是不是在忙"无关，正好能抓这种堵。
const { monitorEventLoopDelay } = require('perf_hooks');
// 敌对判据只此一份（AGENTS.md §5）：战斗本能、hands.threatNear、bridge /nearby 都调它。
const { isHostileEntity } = require('../world/entity-registry.js');

/**
 * 本能层 —— 不过大脑、不过脑干，身体自己做的事（主人 2026-09-27）。
 *
 * ## 和 reflex.js / decision.js 的区别
 *
 *   reflex.js    脑干里的反射（吃、上浮）：1.5s 一拍，走 HTTP，mind 醒着时也跑
 *   decision.js  脑干的决策：mind 持有身体时整个关掉
 *   instinct.js  **bridge 进程里**，直接挂在 bot 上，不走 HTTP、不等任何人
 *
 * 为什么放在 bridge：mind 想一次要 8–20 秒，脑干一拍 450ms–1.5s。
 * 地上掉了东西、怪扑过来，这些事等不了。离 bot 最近的地方反应最快。
 *
 * ## 身体归属（最要紧的规矩）
 *
 *   · 本能只在**身体空着**时出手：没有命令在跑（inflight=0、currentAction 为空），
 *     或者只是在跟着玩家走（跟随被打断后本能负责接回去）。
 *   · **任何命令一到，本能立刻让出身体**：bridge 的路由在执行 POST 之前先 `await yieldBody()`
 *     —— 打断、等它收干净，再执行命令。所以本能永远不会和 mind / 脑干的命令抢同一只手。
 *   · `/stop {hold:true}` = "站着别动"：之后一段时间本能也不动（不能主人刚喊停，她转身就去捡东西）。
 *     不带 hold 的 /stop 只是"停下换件事"（mind 换任务、看门狗脱困都这么用），不静默。
 *
 * ## 拾取本能
 *
 * 地上有东西、身体空着 → 走过去捡。**走路和捡的全部细节交给现有的 `POST /pickup`**
 * （那里踩过 P25/P30/P32/P33/P38/P43 一长串坑），本能只决定"捡不捡、捡哪几堆"。
 *
 * 不捡的：
 *   · 刚落地的（< settleMs）—— 还在飞/滚，而且挖矿掉落有拾取延迟
 *   · **她自己扔出来的** —— 那是她自己丢掉 / 给出去的，捡回来就成了"丢了又捡"的死循环。
 *     判据：实体刷出时的位置就在她眼前（扔出的物品从眼睛高度 -0.3 处生成）。
 *     **别的玩家扔的要捡**（主人 2026-09-27：常常是扔给她的）—— 只是多等一会儿（thrownSettleMs：
 *     原版扔出的物品本来就有 2 秒拾取延迟，也给扔的人一点反悔的时间）。捡到时物品账记成"谁给的"。
 *   · 背包装不下的（没空格，且没有同名未满的堆）
 *   · 同一堆试了 2 次都没捡到的 —— 60 秒内不再试（够不着的坑底、岩浆边）
 *   · 身边有冲她来的怪、或者血 ≤ 6 —— 这时候不该弯腰捡东西
 *   · 跟随中：只捡离玩家不远的（不能为了一块圆石把人跟丢）
 *   · 夜里在露天：只捡 nightOutRadius 格内的（不为一块圆石往黑处跑）
 *
 * ## 收获本能（主人 2026-09-27）
 *
 * 看得见的成熟作物 → 收割并补种。走路、收、补种、捡掉落全交给现有的 `POST /farm`（hands.farm，加了 only/abort）。
 *   · 只收"打掉"类（小麦、胡萝卜…）；右键摘的（甜浆果丛这类）打掉就连丛没了 —— 作物表里标 use 的不碰
 *   · 耕地上的庄稼是有人种的：只收**家里**的（家由 mind 通过 POST /instinct {home} 告诉本能）；野生的随便收
 *   · 至少 minMature 棵成熟才去（别为一棵麦子来回跑）；plantEmpty=false —— 空地种什么是主人的事
 *
 * ## 采矿本能（主人 2026-09-27）
 *
 * 看得见的、有价值的矿 → 过去挖（整条矿脉）。挖交给现有的 `POST /mine`（加了 maxRadius/abort；
 * 它本来就只挖看得见的、沿矿脉挖、不碰人造方块旁边的）。本能只决定"挖不挖、挖哪条"：
 *   · 价值：high / mid 看见就挖；low（煤、铜…）只在缺的时候挖（煤不够做火把）
 *   · 镐子等级够：矿表的 tier（来自整合包 jar 的 needs_*_tool 标签）对身上最好的镐；
 *     等级不够不挖，但**告诉 mind**（"看见钻石矿，要铁镐"）—— 一个位置只说一次
 *   · 矿旁边（六面或上方）有岩浆 / 水：不挖（挖开会放出来）
 *   · 同一格挖失败过：10 分钟内不再试
 *
 * 收获、采矿都只在"真闲着"时做：跟着人走的时候不做（只捡东西），夜里在露天不做。
 *
 * ## 战斗本能（主人 2026-09-27）
 *
 * **只打对她或对玩家有仇恨的怪**（仇恨证据见 entity-registry.js：打过人 / 攻击位亮着且盯着人）。
 *   · 发现：10 格内（detect）；追击不超过锚点 leash 格 —— 锚点 = 跟着的玩家；自己干活时 = 开打那一刻她站的位置
 *   · 近战怪：换最好的武器，贴上去，**攻击冷却满了才打**（剑 0.625s、斧 ~1.1s；以前 /attack 每 350ms 点一下，伤害大打折扣）
 *   · 苦力怕：不近战，保持 creeperSafe 格以外
 *   · 远程怪（名字，或者手上拿着弓/弩/三叉戟 —— 模组怪也认得）：有盾就举盾贴上去打；没盾就拉开距离躲
 *   · 血 ≤ lowHp：跑（拉开距离），告诉 mind
 *   · 战斗、危险方块退开和上浮会**反过来打断命令**：正在挖矿时怪扑上来 → cancelCommands() 叫停命令，先打。
 *     打的时候除了 停/逃/跟随/走 这几类，其他命令直接回"在打架"（不然两边抢身体）。
 *   · 打完：跟着人的接着跟；自己干活的走回锚点；告诉 mind 打了什么、剩多少血
 *
 * ## 开宝箱本能（主人 2026-09-27）
 *
 * 看得见的没开过的箱子 / 木桶 / 运输矿车箱子 → 走过去开（家外的东西拿走，家里的只看看记住放了什么 —— hands.checkChests 的老规矩）。
 * 还没看见箱子、但**认出了自然生成的建筑**（刷怪笼、苔石、沙漠神殿的錾制砂岩 + 橙陶、废弃矿井的蜘蛛网 + 铁轨、
 * 要塞/神庙的苔石砖裂石砖、村庄的钟、下界要塞、堡垒、末地城）→ 知道里面有宝箱，走进去，建筑附近的箱子一间间看。
 * 一路上冲她来的怪由战斗本能打（"闯关"）；血 < minHp、背包没地方、夜里在露天就不去。每座建筑只进一次。
 *
 * ## 洞穴探险本能（主人 2026-09-27：挖矿时遇到天然洞穴应该去探险，而不是无视）
 *
 * 闲着、站在地下的天然洞穴里（hands.inCave：身边一大片空气、没有天光）→ 往洞里没去过的地方走一步（看得见、站得住、
 * 旁边没岩浆、落差不大），到了插个火把（light_up 自己会按间距插）。看见矿 → 采矿本能挖；看见箱子 → 开宝箱本能开；
 * 怪 → 战斗本能打 —— 几个本能接力，就是"逛矿洞"。每个洞（按入口所在的 32 格网格）最多走 maxSteps 步、不离入口 range 格，
 * 家的水平范围内（包括地下任意深度）不自动探洞；家范围未知也暂不启动。逛完告诉 mind。下礦（/delve）里的逛洞是 mind 叫的，那一套归 hands.delve 管，这里不碰。
 *
 * ## 搭路本能 / 落地水本能（主人 2026-09-27）
 *
 *   · 搭路：寻路走到断崖、沟、要往上的地方，用**她随身带的搭脚方块**（hands.SCAFFOLD_IDS）垫过去 / 垫高 ——
 *     每 2 秒按身上有没有这些方块更新 pathfinder（pathing.setScaffold）；家的范围里不许放（别在主人基地里乱垫）；
 *     放一块的代价 ≈ 走 12 格，能绕就绕。
 *   · 落地水：身上有水桶、不在下界 → 寻路允许往下跳到 24 格（pathing.setDropAllowance；代价照样很高，有路就绕）。
 *     反射（physicsTick，每 50ms）：在往下掉、算出来会摔伤（落差 > 3.5 格）→ 先把水桶换到手上；
 *     离落点 ≤ 3 格时低头倒水；落地（或落进水里）后低头用空桶把水收回来。不管是自己跳的还是被打下去的都管。
 *
 * ## 寻路挖掘 / 家的范围随基地长大（主人 2026-09-27）
 *
 *   · 寻路时挡路的方块：只挖**天然地形**（pathing.naturalDigNames 的白名单，从整合包方块标签来），
 *     家里不挖、紧挨着人造方块的不挖（多半是某个建筑的墙）。挖一格的代价仍很高，能绕就绕。
 *   · 家的范围：在家附近时每 5 分钟数一数家周围的人造方块（isPlayerBuilt + 耕地），基地往外连着长到哪，
 *     半径就扩到那 + 6 格（最多 128）；只扩不缩。扩了告诉 mind（她把新半径记进记忆）。
 *
 * ## 指令本能（主人 2026-09-27：死亡之后或者需要的时候自动用指令）
 *
 * 用哪些命令看**服务器实际给了什么**（命令树，GET /commands）—— 这个包可能根本没开放普通玩家的传送命令，没有就走路。
 * 管理员命令一律不碰（runCommand 本来就拦着）。自动用的命令之间至少隔 cmdGapMs。
 *   · 死了：记下死在哪。重生后告诉 mind，并回去捡东西（掉落物 5 分钟就没了）：
 *       有 /back 就用；没有但有 /tp（同一维度）就 /tp 回死的坐标（主人："也可以 /tp 回到之前坐标"）；
 *       都没有就在同一维度、recoverMax 格内走回去，到了把附近的掉落物都捡起来。
 *       死在岩浆里（东西烧没了）、太远、别的维度 → 不白跑，只告诉 mind。每次死只回去一次。
 *   · 家：mind 定了家、服务器有 /sethome → 她站在家里时顺手设一下（以后 /home 才回得去）
 *   · 天黑还在野外、离家太远走不回去、服务器有 /home → 用，并记下原来在哪；天亮了 /back 或 /tp 回去接着干
 *   · 血 ≤ 4 还在被打（战斗本能在跑开）、有 /home 或 /spawn → 传走保命
 *
 * ## 采矿按进度（主人 2026-09-27：前期煤、铁，后期钻石，也包括模组矿）
 *
 * 还没有铁镐时：铁矿当最高价值（它就是下一步）、煤少于 32 就挖；有了铁镐之后煤按少于 16 算。
 * 正在执行命令（赶路、干别的）时看见值钱的矿：不打断命令，只告诉 mind"路上看见了 X"（一个位置说一次），挖不挖她定。
 *
 * ## 随身物品本能（主人 2026-09-27：至少带武器、工具、食物、搭脚方块）
 *
 * 装备单在 hands.defaultLoadout()（和"回家整理"用的是同一张单子）：镐、武器（剑或斧）、吃的、搭脚方块是 essential，
 * 火把、斧、剑缺了只记着。
 *   · 缺了 essential 的：告诉 mind（缺的一变就说一次，带上"背包 / 家里箱子里有没有"）
 *   · **背着精妙背包时先用背包**（主人 2026-09-27）：身上快满、背包还有空 → 就地把杂物装进背包；
 *     缺的东西背包里有 → 从背包里拿。都不行（背包也满了 / 只有家里有）才回家。
 *   · 什么时候回家整理（POST /go 回家 → POST /storage/organize：杂物按类放回箱子、缺的从箱子里拿）：
 *       ① 背包快满（空格 ≤ fullAt）；或 ② 缺 essential、而且**记得家里箱子里有**（开过的箱子会记住里面有什么）
 *     只在：知道家在哪、离家不远（≤ maxHomeDist）、不是夜里在露天（除非家就在旁边）、上次整理过了 cooldown 之后
 *   · 缺的东西家里也没有：只告诉 mind（去做 / 去挖是她的事），不空跑
 *
 * ## 其他本能（主人 2026-09-27 让 WorkBuddy 补充核实后挑的，见 modpack-study/instincts/suggestions.md）
 *
 *   · 危险方块退开：站在岩浆块 / 营火 / 火上，或者陷在细雪、浆果丛、仙人掌边 → 挪到旁边安全的一格（最先，保命）
 *   · 转头看人：玩家 6 格内时隔几秒看一眼；有人说话就转过去看他（只转头，不打断任何动作；抄 mindcraft idle_staring 的节奏）
 *   · 夜里在家有床就睡：床被占了服务器会拒绝、sleepInBed 换下一张 —— 不会把人挤下床；睡不了（有怪/不是晚上）就歇几分钟再试
 *   · 换更好的护甲：按材质排（皮 < 金 < 锁链 < 铁/海龟 < 钻石 < 下界合金），只往上换；认不出材质的模组护甲不自动换（空着的槽除外）；鞘翅不碰
 *   · 工具快坏了告诉 mind：耐久剩 ≤ 10%（有附魔的 ≤ 20%）说一声，一件只说一次 —— 别不知不觉把附魔镐用断
 *
 * ## 本能事件（给 mind）
 *
 * 本能做成了什么、看见什么却没做成，记进 `I.events`（带 seq），mind 按 `GET /instinct/events?since=` 读，
 * 变成她经历的一件事 —— 她得知道自己"顺手"干了什么，不然会以为那是别人干的。
 */



// ------------------------------------------------------------------ 汇总（第 3 步重构，2026-09-28）
//
// 这个文件原来是 3561 行的巨石。按本能领域拆成 config / core / combat / survival / mining / pickup / social / home，
// 这里只做三件事：
//   1. 把子文件的导出拼回**和拆之前一模一样**的 module.exports（Object.keys 必须一字不差）；
//   2. isHostileEntity 的转导出（原来就在本文件顶部 import 再 export）；
//   3. --selftest 依次跑各子文件的自测（小节都搬到了各自文件里）。
// 外部模块的 `require('../instinct/instinct.js')` 不用改。
// ⚠️ 本文件是**普通文件**（任务书硬规矩：Windows 的 git 会把它签出成纯文本，符号链接会炸）。

const { ARMOR_RANK, CFG, COMBAT_YIELD, HURT_BELOW, HURT_FEET, PASSIVE_POSTS, STRUCTURE_SIGNS, TIER, TIER_NAME, fillCfg } = require('./config');
const { bodyBusy, breatheRefused, caveBoundary, createCheck, install, ownsBodyAtCleanup, scanColumnsGen, scanColumnsIn, scanColumnsSync, settleJob, syncSleepState, yieldBody } = require('./core');
const { armorRank, attackCooldownMs, combatPlan, hazardUnder, mobKind, pickArmor, pickStepOff, toolWorn } = require('./combat');
const { effectPlan, mlgStep, needBreath, pickEat, pickRecovery, pickShore, shoreRingOffsets } = require('./survival');
const { bareNameOf, darkReport, needTier, noteDelve, pickCaveStep, pickDelveResume, pickOre, pickTorchStep, pickaxeTier } = require('./mining');
const { carriedNames, carriedTally, hdist, pickHarvest, pickLoot, pickPickup, pickTidy, pickupFailIds, whoThrew } = require('./pickup');
const { followIdlePlan, gazeEngaged, pickCommand, pickGaze, weatherChange } = require('./social');
const { homeFootprint, recognizeStructures } = require('./home');

// ---- 把所有兄弟文件接起来（第 3 步重构）--------------------------------------
// 原 instinct.js 的顶层声明都在**一个作用域**里，谁先谁后都无所谓；拆开之后它们互相
// require 成环，模块顶层解构会拿到 undefined。所以：先把子文件都 require 进来，
// 拼成一张总表，再让每个文件 `bind(总表)` 回填自己的跨文件名字 —— 函数体里写的还是
// 原来那些名字，取到的始终是同一份真身。
const __files = { config: require('./config'), core: require('./core'), combat: require('./combat'), survival: require('./survival'), mining: require('./mining'), pickup: require('./pickup'), social: require('./social'), home: require('./home') };
const __ns = Object.assign({}, __files.config, __files.core, __files.combat, __files.survival, __files.mining, __files.pickup, __files.social, __files.home);
// isHostileEntity 是本文件顶部 import 再转导出的（不属于任何子文件），自测小节里会用到它 ——
// 一并放进总表，位置照旧（`ns` 只是自测用的取名表，不影响 module.exports 的 56 个名字）。
__ns.isHostileEntity = isHostileEntity;
__files.config.bind(__ns);
__files.core.bind(__ns);
__files.combat.bind(__ns);
__files.survival.bind(__ns);
__files.mining.bind(__ns);
__files.pickup.bind(__ns);
__files.social.bind(__ns);
__files.home.bind(__ns);

// isHostileEntity 不是本能层实现的：文件头（原文 1-153 行照搬）已经从
// ../world/entity-registry.js 导入并原样再导出。汇总自己再 `module.exports` 一次即可。
// `paths` 也是文件头 import 的（自测小节里有一处源码形状锁读 src/body/kit.js 要用它）——
// 和 isHostileEntity 一起塞进自测总表，module.exports 的 56 个名字不受影响。
__ns.paths = paths;

// ------------------------------------------------------------------ 导出（顺序 = 拆之前那 56 个，一字不差）

module.exports = { scanColumnsIn, scanColumnsSync, caveBoundary, settleJob, ownsBodyAtCleanup, breatheRefused, syncSleepState, createCheck, CFG, fillCfg, pickEat, pickShore, shoreRingOffsets, needBreath, effectPlan, weatherChange, pickRecovery, pickCommand, homeFootprint, darkReport, mlgStep, pickCaveStep, STRUCTURE_SIGNS, recognizeStructures, pickLoot, pickTidy, isHostileEntity, mobKind, attackCooldownMs, combatPlan, COMBAT_YIELD, TIER, pickaxeTier, carriedNames, carriedTally, needTier, pickOre, pickHarvest, hazardUnder, pickStepOff, armorRank, pickArmor, toolWorn, pickGaze, gazeEngaged, whoThrew, pickPickup, bodyBusy, followIdlePlan, pickTorchStep, noteDelve, pickDelveResume, install, yieldBody, PASSIVE_POSTS, selftest };

// 自测用：所有子文件的**全部**名字（原来自测段和所有函数同处一个作用域，随手就能取）。
// 不可枚举 —— Object.keys(module.exports) 必须还是那 56 个，一字不差。
Object.defineProperty(module.exports, '__ns', { value: __ns, enumerable: false });

// ------------------------------------------------------------------ 自测
// 第 3 步重构：小节都搬到了各自子文件里（断言一字未改）；汇总这里依次跑**全部**，
// 顺序与拆分前一致，断言总数一分不少。
// 各子文件也能单独 `node src/instinct/<file>.js --selftest`。
//
// selftest() 保留这个名字（导出表里有它）：跑全部小节，返回退出码。
function selftest () {
  // require 各子文件 = 把它们的小节 register 进 testkit（module 顶层就登记，不跑）
  require('./combat'); require('./core'); require('./home'); require('./mining'); require('./pickup'); require('./social'); require('./survival');
  require('./testkit').bindNs(__ns);   // 总表 = 所有子文件的全部导出（小节原来就在同一作用域）
  return require('./testkit').runSuite('instinct');
}

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
