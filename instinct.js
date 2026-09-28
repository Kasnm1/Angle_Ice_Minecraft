'use strict';

const storagePolicy = require('./storage-policy');
// 事件循环延迟监控（2026-09-28）：5 分钟一次的 homeTimer 大扫描曾让整个进程冻 ~14 秒
// （实机 live-1214：12:20/12:25 的 scheduler.lagMs = 13511 / 14027，busyForMs 却是 0）。
// monitorEventLoopDelay 量的是**事件循环本身**的延迟，和"本能是不是在忙"无关，正好能抓这种堵。
const { monitorEventLoopDelay } = require('perf_hooks');
// 敌对判据只此一份（AGENTS.md §5）：战斗本能、hands.threatNear、bridge /nearby 都调它。
const { isHostileEntity } = require('./entity-registry.js');

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

const CFG = {
  pickup: {
    enabled: process.env.MC_INSTINCT_PICKUP !== 'false',
    tickMs: 400,
    radius: 8,              // 水平几格内的掉落物才管
    farRadius: 24,          // 闲着时去捡"看得见的"远处掉落物（tick 最后一步；0 = 关掉）—— 2026-09-28 加
    maxDy: 3,               // 高低差超过这个不管（楼上楼下、悬崖底）
    followRadius: 6,        // 跟随中：离她几格内
    followLeash: 8,         // 跟随中：离玩家几格内（捡完还追得上）
    nightOutRadius: 4,      // 夜里在露天：只捡脚边的，不往黑处跑（night.js）
    settleMs: 1000,         // 落地多久后才捡
    thrownSettleMs: 2500,   // 别的玩家扔的：多等一会儿（原版拾取延迟 40 tick + 反悔时间）
    batch: 8,               // 一次最多走几堆（有 budgetMs 兜底，多给几堆不会卡太久）
    maxFails: 2,            // 同一堆失败几次就先放下
    failCooldownMs: 60000,
    quietAfterStopMs: 20000,   // /stop 之后多久不动
    minHealth: 7,
    threatRadius: 12,       // 这么近有冲她来的怪就不捡
    thrownRadius: 0.6,      // 刷出点离某个玩家的"出手点"这么近 = 被他扔出来的
    timeoutMs: 4000,        // 每堆的寻路超时（/pickup 的 timeoutMs）
    budgetMs: 8000,         // 一次 /pickup 总共最多花多久（超了剩下的下一拍再捡）
  },
  harvest: {
    enabled: process.env.MC_INSTINCT_HARVEST !== 'false',
    radius: 10,
    maxDy: 3,
    minMature: 3,           // 至少几棵成熟才去
    cooldownMs: 30000,      // 收完一轮歇多久再看
  },
  mine: {
    enabled: process.env.MC_INSTINCT_MINE !== 'false',
    // 2026-09-28 第 8 批 第 3 条：主人说"遇到矿石也不挖"。
    // 12 格只够"脚边顺手"，实机 `有矿但不挖（far=10~22）` 全是 12~22 格里看得见的矿，
    // 她够不着就当成没事 —— 视野里明明有铁矿，却去挖了同一个洞里价值更低的油矿。
    // 现在按"看得见就挖"算 16 格（配合 visible 判定，不会隔墙乱挖），跟 delve 的 16 格一致。
    radius: 16,             // 只挖这么近的（/mine 的 maxRadius）
    maxDy: 6,               // 高低差也放宽一点（16 格的球里 y 差 6 以内都算"眼前"）
    maxVein: 8,             // 一次最多挖几块（一条矿脉）
    lowWhenBelow: 16,       // low 价值的矿（煤…）：身上掉落物少于这个才挖
    failCooldownMs: 600000,
    cooldownMs: 5000,
    // 被战斗/命令打断的矿**不复用 failCooldown** —— 打断不是"挖不动"，
    // 下一拍身体空了就该接着挖（见 tryMine 的 aborted 分支）。
    resumeMs: 0,
  },
  sleep: { enabled: process.env.MC_INSTINCT_SLEEP !== 'false', retryMs: 180000 },
  armor: { enabled: process.env.MC_INSTINCT_ARMOR !== 'false', everyMs: 15000 },
  gaze: {
    enabled: process.env.MC_INSTINCT_GAZE !== 'false',
    radius: 6,
    minGapMs: 3000,
    maxGapMs: 6000,
    chatRadius: 16,
    // 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
    // 只在"互动窗口"里看人：刚跟她说话 / 刚有礼物往来 / 她自己刚开口。
    // 窗口外**不主动转头**（6 格内有近处玩家也不看）。
    talkMs: 20000,      // 这个玩家刚跟她说话（聊天）→ 之后 20 秒内可以看他
    giftMs: 15000,      // 他刚扔东西给她 / 她刚捡到他给的 → 15 秒
    selfTalkMs: 15000,  // 她自己开口说话 → 对 16 格内最近的玩家 15 秒
  },
  toolWarn: { ratio: 0.1, enchantedRatio: 0.2, everyMs: 10000 },
  combat: {
    enabled: process.env.MC_INSTINCT_COMBAT !== 'false',
    detect: 10,             // 多远发现（主人定的 10 格）
    leash: 12,              // 离锚点多远就不追了
    lowHp: 6,               // 血到这个就跑
    creeperSafe: 7,         // 离苦力怕至少这么远
    rangedKeep: 14,         // 没盾时离远程怪这么远
    reach: 3.0,             // 近战够得着
    loopMs: 150,
    scanMs: 250,
    loseMs: 2500,           // 这么久没有目标 = 打完了
    maxMs: 90000,
  },
  tidy: {
    enabled: process.env.MC_INSTINCT_TIDY !== 'false',
    fullAt: 3,              // 空格 ≤ 这个就算快满
    packMinFree: 4,         // 背包至少剩这么多格才往里装（不知道剩多少 = 试一次）
    packCooldownMs: 120000, // 倒腾一次背包后 2 分钟内不再倒腾
    maxHomeDist: 160,       // 离家超过这个不专程回去（mind 决定）
    nightHomeDist: 48,      // 夜里在露天：家在这么近才回
    cooldownMs: 600000,     // 整理一次后 10 分钟内不再专程回去
    checkMs: 20000,
  },
  loot: {
    enabled: process.env.MC_INSTINCT_LOOT !== 'false',
    radius: 24,             // 看得见的箱子多远去开
    structRadius: 40,       // 认出的建筑多远去
    structNear: 14,         // 进了建筑后，附近多少格的箱子一间间看
    minHp: 14,
    minFree: 3,
    cooldownMs: 15000,
  },
  cave: {
    // 自动探洞会把“人在洞里”误当成“主人让我探险”。默认关闭；明确下矿走 /delve，
    // 只有运维显式设置 MC_INSTINCT_CAVE=true 时才恢复这项自主行为。
    enabled: process.env.MC_INSTINCT_CAVE === 'true',
    scan: 16,               // 往多远找下一步
    minStep: 5,             // 每步至少走这么远（别原地挪）
    maxDrop: 4,             // 下一步比脚下低这么多以内
    maxSteps: 24,           // 一个洞最多走几步
    range: 64,              // 离入口多远就不往外走了
    minHp: 12,
    visitCell: 4,           // "去过"按几格一格子记
  },
  // 搭路会真实消耗并改变世界。普通赶路、拾取、追动物不应因此自动垫块；
  // 只有显式打开才交给 pathfinder 使用。
  bridge: { enabled: process.env.MC_INSTINCT_BRIDGE === 'true' },
  dig: { enabled: process.env.MC_INSTINCT_DIG !== 'false' },
  // 家的范围随基地长大（2026-09-28 第 8 批真修后重新打开）：
  // 以前默认关是因为同步大扫描单段 13 秒（`slow home.scanBuilt d=91 13049`），每 5 分钟整个进程冻住。
  // 现在扫描改成**逐 chunk 列**（列间 await setImmediate）+ section palette 预筛，
  // 而且只扫"当前半径外的环带"（生长前沿）不扫整个圆盘 —— 单次同步片段压在 50ms 内（基准见
  // modpack-study/fix8-20260928/bench-scanchunks.js）。everyMs 仍是 30 分钟一次。
  // MC_HOME_GROW=false 可以关掉。
  // 家的范围随基地长大：默认关，实机验证逐列扫描不卡之后再打开（MC_HOME_GROW=true）
  home: { grow: process.env.MC_HOME_GROW === 'true', everyMs: 1800000, gap: 8, margin: 6, cap: 128, near: 32 },
  // 暗处插火把（2026-09-28 第 8 批 第 4 条，新本能，无 LLM）。
  // 判据见 pickTorchStep：地下 + 脚下方块光 ≤ darkMax + 身上有火把 + 7 格内没光源。
  torch: {
    enabled: process.env.MC_INSTINCT_TORCH !== 'false',
    darkMax: 7,          // 脚下方块光 ≤ 这个就插（原版怪在方块光 0 刷，留余量）
    spacing: 7,          // 这么近有光源就不插（和 hands.lightUp 的 spacing 一致）
    everyBlocks: 6,      // 每走这么多格检查一次（别每拍都点）
    checkMs: 700,        // 检查最快多久一次
  },
  // 跟着的玩家站着不动时顺手做点事（第 6 条）：不动超过 idleMs 才允许
  follow: { idleMs: 8000, reach: 12 },
  // 接着把 mind 交待的下矿走完（第 5 条）。cave 本能仍默认关；这条只看"mind 明确下过 /delve"。
  delve: {
    enabled: process.env.MC_INSTINCT_DELVE !== 'false',
    resumeMs: 300000,   // 5 分钟内被打断的，本能自己接着挖
    reach: 96,          // 记录里那个地方在这么近才接着挖（不跨半个地图）
    seconds: 90,        // 每次续挖最多多久（和 mind 下矿的默认时长一致）
    minHp: 12,
  },
  mlg: { enabled: process.env.MC_INSTINCT_MLG !== 'false', minFall: 3.5, placeAt: 3.0 },
  cmd: {
    enabled: process.env.MC_INSTINCT_CMD !== 'false',
    cmdGapMs: 60000,
    recoverMax: 400,        // 死了走回去捡东西：同一维度这么远以内
    despawnMs: 300000,      // 掉落物 5 分钟消失
    nightFarHome: 160,      // 夜里离家超过这么远才用 /home（近的走回去）
    panicHp: 4,
  },
  // 吃（主人 2026-09-27：饥饿条掉 2 格就吃 = 饥饿值 ≤16）。身体空着才吃；饿到 urgentAt 以下有命令在跑也吃
  eat: { enabled: process.env.MC_INSTINCT_EAT !== 'false', at: 16, urgentAt: 6, checkMs: 2000, failCooldownMs: 60000 },
  // 憋气：头在水里、氧气 ≤ at（满 20）→ 叫停命令、一直跳上去换气
  breathe: { enabled: process.env.MC_INSTINCT_BREATHE !== 'false', at: 8, checkMs: 500, jumpMs: 6000 },
  // 中毒 / 凋零：告诉 mind；有牛奶且（凋零 或 血 ≤ milkHp）就喝；打架时按"少了几滴血"算，更早撤
  effects: { enabled: process.env.MC_INSTINCT_EFFECTS !== 'false', milkHp: 10, poisonHpCost: 4, witherHpCost: 6, checkMs: 1000 },
  // 上岸（主人 2026-09-27）：身体空着、泡在水里超过 afterMs（或刚上浮换完气）→ 走到最近能站的陆地
  shore: { enabled: process.env.MC_INSTINCT_SHORE !== 'false', afterMs: 3000, radius: 12, checkMs: 1000, retryMs: 8000 },
  // 天气：下雨 / 打雷 / 雨停告诉 mind；打雷在露天当夜里（白天也刷怪），打雷时在家可以睡
  weather: { enabled: process.env.MC_INSTINCT_WEATHER !== 'false' },
  // 玩家挨打：告诉 mind（同一个人 20 秒内只说一次）
  playerHurt: { enabled: process.env.MC_INSTINCT_PLAYER_HURT !== 'false', radius: 48, quietMs: 20000 },
  minFreeSlots: 2,          // 收获、采矿至少留几个空格
  yieldWaitMs: 1500,        // 让出身体时最多等本能收拾多久
};

// 镐子等级。原版按材质；模组镐认不出材质的按石镐算（宁可少挖，不白敲）
const TIER = { wood: 0, gold: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
function pickaxeTier (itemNames = []) {
  let best = -1;
  for (const n of itemNames) {
    const bare = String(n).replace(/^.*:/, '');
    if (!/pickaxe/.test(bare)) continue;
    const m = /^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/.exec(bare);
    const t = m ? { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }[m[1]]
      : /netherite/.test(bare) ? 4 : /diamond/.test(bare) ? 3 : /iron|steel/.test(bare) ? 2 : 1;
    if (t > best) best = t;
  }
  return best;   // -1 = 没有镐子
}
/** 矿要几级镐。表里 tier 为空 = 没查到 → 保守按铁镐（找不到证据时往安全那边靠） */
const needTier = (tier) => (tier && TIER[tier] != null ? TIER[tier] : TIER.iron);
const TIER_NAME = ['木镐', '石镐', '铁镐', '钻石镐', '下界合金镐'];

/**
 * 身上的 + 精妙背包里的物品名清单（主人 2026-09-28，codex 审计 P-4 / N-9）。
 *
 * 以前 `pickaxeTier(bot.inventory.items()…)` 只看普通物品栏 —— 镐子放在精妙背包（108 格）里时
 * 判"镐子不够"，看见矿也不挖。这里把 `state.backpackSeen` 里的也并进来。
 *
 * ⚠️ 只是**算上背包里的**，不真的把镐子拿出来 —— 判据用；真要取工具是 hands 的活。
 * 读不到背包时（没背 / 从没打开过）返回 `readable:false`，调用方要按原逻辑算，并且**不能说"没有"**。
 *
 * @returns {{ names:string[], source:'carried'|'carried+backpack', readable:boolean }}
 */
// instinct 里的裸名（去 minecraft: 前缀）—— 和 loadTables 的 bareName 同一规则
const bareNameOf = (n) => String(n).replace(/^minecraft:/, '');

function carriedNames (bot, state) {
  const names = bot.inventory.items().map(i => i.name);
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return { names, source: 'carried', readable: false };
  // 判据只关心"有没有这一种"，不需要真的按数量铺开（pickaxeTier / have 只看名字）
  for (const name of Object.keys(seen.items)) names.push(name);
  return { names, source: 'carried+backpack', readable: true };
}

/**
 * 名字 → 数量（身上的 + 背包记录里的）。背包读不到时 readable:false，只算身上的，
 * 调用方据此判断要不要在 skip 原因里写「背包读不到」。
 */
function carriedTally (bot, state) {
  const have = {};
  for (const it of bot.inventory.items()) have[bareNameOf(it.name)] = (have[bareNameOf(it.name)] || 0) + it.count;
  const seen = state?.backpackSeen;
  if (!seen || !seen.items) return { have, readable: false };
  for (const [name, count] of Object.entries(seen.items)) have[bareNameOf(name)] = (have[bareNameOf(name)] || 0) + count;
  return { have, readable: true };
}

// ------------------------------------------------------------------ 纯判据（可自测）

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 物品刷出时是不是从某个玩家手里扔出来的。
 * 原版 `Player.drop()`：生成点 = 眼睛高度 - 0.3（站立时脚底 +1.32，潜行 +1.27-0.3），水平就在玩家身上。
 * 挖方块掉的在方块中心 ±0.25（离玩家至少 ~0.75），怪死掉的在怪脚下 —— 都不会落在这个小圈里。
 */
function whoThrew (spawnPos, players, radius = CFG.pickup.thrownRadius) {
  if (!spawnPos) return null;
  for (const { name, pos: p } of players) {
    if (!p) continue;
    const dy = spawnPos.y - (p.y + 1.32);
    if (hdist(spawnPos, p) <= radius && dy >= -0.5 && dy <= 0.3) return name;
  }
  return null;
}

/**
 * 捡不捡、捡哪几堆。
 *
 * @param ctx.self       { x, y, z }   她的脚底
 * @param ctx.drops      [{ id, pos, ageMs, thrower, item, visible }]  thrower = 谁扔的（'self' = 她自己，玩家名，null = 不是扔的）；item = 物品名或 null（读不到）；visible = 看得见吗（远处拾取用）
 * @param ctx.following  { pos } | null   正在跟的玩家
 * @param ctx.fails      Map id → { n, until }
 * @param ctx.canHold    (itemName|null) → boolean
 * @param ctx.now
 * @param cfg.far        true 才走"远处拾取"模式：只挑 farRadius 以内**看得见**的（任务书第 4 条）。
 *                       默认 false = 老行为（只用 radius，8 格内）。远处拾取是**显式**的另一件事，
 *                       不能因为 cfg 里多了个数字就把普通拾取的半径悄悄放大。
 * @returns { ids: number[] } | { skip: string }   skip 写明为什么不捡（调试用，/instinct 看得到）
 */
function pickPickup (ctx, cfg = CFG.pickup) {
  const { self, drops = [], following = null, fails = new Map(), canHold = () => true, now = Date.now() } = ctx;
  if (!self) return { skip: '没有位置' };
  const radius = following ? cfg.followRadius : cfg.radius;
  // 远处拾取模式：任务是"闲着时去捡看得见的"，所以只认 visible !== false 的；半径放宽到 farRadius。
  const far = !!cfg.far && !following && cfg.farRadius > radius;
  const reach = far ? cfg.farRadius : radius;
  const why = { young: 0, mine: 0, far: 0, full: 0, failed: 0, hidden: 0 };
  const ok = [];
  for (const d of drops) {
    if (!d?.pos) continue;
    if (d.thrower === 'self') { why.mine++; continue; }
    if (d.ageMs < (d.thrower ? cfg.thrownSettleMs : cfg.settleMs)) { why.young++; continue; }
    const dist = hdist(d.pos, self);
    if (dist > reach || Math.abs(d.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (far && d.visible === false) { why.hidden++; continue; }   // 远处：看不见的不去（不往黑处/墙后跑）
    if (following && hdist(d.pos, following.pos) > cfg.followLeash) { why.far++; continue; }
    const f = fails.get(d.id);
    if (f && f.n >= cfg.maxFails && now < f.until) { why.failed++; continue; }
    if (!canHold(d.item)) { why.full++; continue; }
    ok.push({ id: d.id, dist });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    const tag = far ? `far=${reach} ` : '';
    return { skip: parts.length ? `有掉落物但都不捡（${tag}${parts.join(' ')}）` : '附近没有掉落物' };
  }
  ok.sort((a, b) => a.dist - b.dist);
  return { ids: ok.slice(0, cfg.batch).map(o => o.id) };
}

/**
 * 挖哪条矿。
 * @param ctx.ores   [{ name, pos, value, tier, drops?, visible, hazard }]  hazard = 旁边有岩浆/水
 * @param ctx.self   她的位置；ctx.pick = pickaxeTier()；ctx.have = 物品名 → 数量（判断 low 矿缺不缺）
 * @param ctx.fails  Map "x,y,z" → until
 * @param ctx.followIdle  跟着的玩家**原地不动**（>8s）时给她当前位置；null = 不在跟随模式
 *                        这时用的是 cfg.followRadius（跟着人时别跑太远，跟丢了她会追不上）
 * @returns { target, count } | { skip, lacking? }   lacking = [{ name, pos, need }] 看得见但镐子不够的（告诉 mind）
 */
function pickOre (ctx, cfg = CFG.mine) {
  const { ores = [], self, pick = -1, have = {}, fails = new Map(), now = Date.now(), followIdle = null } = ctx;
  const early = pick < TIER.iron;   // 还没有铁镐：前期，铁和煤就是最值钱的
  if (!self) return { skip: '没有位置' };
  const radius = followIdle ? Math.min(cfg.radius, cfg.followRadius ?? cfg.radius) : cfg.radius;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const lacking = [];
  const why = { far: 0, hidden: 0, hazard: 0, failed: 0, cheap: 0, tool: 0, shovel: 0, follow: 0 };
  const ok = [];
  for (const o of ores) {
    if (!o?.pos) continue;
    if (hdist(o.pos, self) > radius || Math.abs(o.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!o.visible) { why.hidden++; continue; }
    if (o.hazard) { why.hazard++; continue; }
    if (o.notPickaxe) { why.shovel++; continue; }   // 不是镐子挖的（化石矿要铲子）—— 矿表里标出来的
    const f = fails.get(key(o.pos));
    if (f && now < f) { why.failed++; continue; }
    // 跟着人时：矿不能离**他**太远（不然挖完她在远处，人走了就丢）
    if (followIdle && hdist(o.pos, followIdle.pos) > (cfg.followLeash ?? 16)) { why.follow++; continue; }
    const isIron = (o.drops || []).some(d => /(^|:)(raw_iron|iron_ingot|iron_nugget)$/.test(d));
    if (o.value === 'low') {
      const got = (o.drops || []).reduce((n, d) => n + (have[d] || 0), 0);
      if (got >= (early ? cfg.lowWhenBelow * 2 : cfg.lowWhenBelow)) { why.cheap++; continue; }
    }
    const need = needTier(o.tier);
    if (pick < need) { why.tool++; lacking.push({ name: o.name, pos: o.pos, need }); continue; }
    // 价值排序（第 3 条：按 knowledge/ores.json 的 value 排，没价值/很低价值的排最后）：
    //   0 = high（钻石、铁…，以及前期最缺的铁）
    //   1 = mid（铜、金、油矿…）
    //   2 = low（煤、青金石…，够用就不挖，上面已经筛过一遍）
    //   3 = 没有 value 字段 / value 不认识 —— **排最后但不永久排除**（可能是新模组矿、矿表还没补；
    //       排最后意味着"附近只有它时才挖"，不会为了它放弃铁矿，也不会因为表里没记就彻底看不见）
    const v = o.value === 'high' ? 0 : o.value === 'mid' ? 1 : o.value === 'low' ? 2 : 3;
    const rank = (early && isIron && v > 0) ? 0 : v;   // 前期：铁优先于一切（含钻石那档，因为挖不动）
    ok.push({ ...o, dist: hdist(o.pos, self), rank, unknownValue: v === 3 });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: parts.length ? `有矿但不挖（${parts.join(' ')}）` : '看不见矿', lacking };
  }
  ok.sort((a, b) => (a.rank - b.rank) || (a.dist - b.dist));
  const t = ok[0];
  const count = Math.min(cfg.maxVein, ok.filter(o => o.name === t.name).length);
  return { target: { name: t.name, pos: t.pos }, count, lacking };
}

/**
 * 收哪些庄稼。
 * @param ctx.crops [{ name, pos, age, maxAge, harvest, farmland, visible }]
 * @param ctx.inHome (pos) → boolean | null（null = 不知道家在哪）
 * @returns { only: [pos] } | { skip }
 */
function pickHarvest (ctx, cfg = CFG.harvest) {
  const { crops = [], self, inHome = () => null } = ctx;
  if (!self) return { skip: '没有位置' };
  const why = { far: 0, green: 0, useType: 0, notOurs: 0, hidden: 0 };
  const ok = [];
  for (const c of crops) {
    if (!c?.pos) continue;
    if (hdist(c.pos, self) > cfg.radius || Math.abs(c.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!(c.age >= c.maxAge)) { why.green++; continue; }
    if (c.harvest === 'use') { why.useType++; continue; }
    if (c.farmland && inHome(c.pos) !== true) { why.notOurs++; continue; }   // 耕地上的是有人种的：只收家里的
    if (c.visible === false) { why.hidden++; continue; }
    ok.push(c);
  }
  if (ok.length < cfg.minMature) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: ok.length ? `成熟的只有 ${ok.length} 棵，攒一攒再收` : (parts.length ? `有庄稼但不收（${parts.join(' ')}）` : '附近没有庄稼') };
  }
  return { only: ok.map(c => c.pos) };
}

// ---- 危险方块：脚下 / 脚所在那格
const HURT_FEET = /(^|:)(sweet_berry_bush|powder_snow|fire|soul_fire|campfire|soul_campfire|cactus|wither_rose|cobweb)$/;
const HURT_BELOW = /(^|:)(magma_block|campfire|soul_campfire)$/;
/** 站的地方伤人吗。返回原因或 null。feet / below 是方块名（读不到给 null） */
function hazardUnder ({ feet = null, below = null, fallingAbove = false } = {}) {
  // 头顶有沙子 / 砂砾正往下掉（mindcraft modes.js 的 self_preservation 有这条；砸到头会闷死）
  if (fallingAbove) return '头顶有沙子/砂砾掉下来';
  if (feet && HURT_FEET.test(feet)) return `陷在 ${feet} 里`;
  if (below && HURT_BELOW.test(below)) return `站在 ${below} 上`;
  return null;
}
/**
 * 往哪挪。cells：身边 8 格 [{ dx, dz, feet, head, below }]（方块名，null = 读不到）。
 * 要求：脚和头那格是空的（空气类）、脚下是实心且不伤人、不是岩浆/水。读不到的格子不去（不猜）。
 */
function pickStepOff (cells = []) {
  const open = (n) => n != null && require('./place').isStandable({ name: n });   // 判据只在 place.js 一处（P50：含草、藤、雪层）
  const ok = cells.filter(c => open(c.feet) && open(c.head) && c.below != null && !/air|lava|water|fire|magma|cactus|powder_snow|campfire/.test(c.below));
  ok.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz)));   // 先直的，再斜的
  return ok[0] || null;
}

// ---- 护甲：按材质排。认不出材质 = null（不自动换下已穿的）
const ARMOR_RANK = [[/leather/, 1], [/golden|gold_/, 2], [/chainmail/, 3], [/turtle/, 4], [/iron/, 4], [/diamond/, 5], [/netherite/, 6]];
function armorRank (name) {
  const bare = String(name || '').replace(/^.*:/, '');
  for (const [re, r] of ARMOR_RANK) if (re.test(bare)) return r;
  return null;
}
/**
 * 哪个槽换哪件。worn：{ head, torso, legs, feet } 现在穿的（名字或 null）；items：背包里的 [{ name, slot }]（slot 由 slotByName 算）。
 * 只往上换；空槽穿任何认得出槽位的；鞘翅不碰（胸甲和鞘翅是主人自己挑的）。
 */
function pickArmor (worn = {}, items = []) {
  const out = [];
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const cur = worn[slot];
    if (cur && /elytra/.test(cur)) continue;
    const curRank = cur ? armorRank(cur) : 0;
    const cands = items.filter(i => i.slot === slot && !/elytra/.test(i.name))
      .map(i => ({ ...i, rank: armorRank(i.name) }))
      .filter(i => (cur ? (i.rank != null && curRank != null && i.rank > curRank) : true))
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    if (cands.length) out.push({ slot, name: cands[0].name, from: cur || null });
  }
  return out;
}

/** 工具快坏了没有。item：{ name, durabilityUsed, maxDurability, enchanted } */
function toolWorn (it, cfg = CFG.toolWarn) {
  if (!it || !it.maxDurability || it.durabilityUsed == null) return null;
  const left = it.maxDurability - it.durabilityUsed;
  const ratio = left / it.maxDurability;
  return ratio <= (it.enchanted ? cfg.enchantedRatio : cfg.ratio) ? { left, max: it.maxDurability } : null;
}

/**
 * 这个玩家现在在不在"互动窗口"里 —— 判据**只写这一处**（AGENTS.md §5）。
 *
 * 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
 * 窗口来源（都由 install 里的钩子写入 engagedUntil）：
 *   · 他刚跟她说话（chat）→ 20 秒
 *   · 他刚扔东西给她 / 她刚捡到他给的（whoThrew / playerCollect 的 gift）→ 15 秒
 *   · 她自己开口说话（bridge 的 POST /chat）→ 对 16 格内最近的玩家 15 秒
 *
 * @param {{player:string, engagedUntil:Object|Map, now:number}} ctx
 *   engagedUntil：玩家名 → 到什么时候为止（毫秒时间戳）；玩家名按原样也不区分大小写地查一次
 * @returns {boolean}
 */
function gazeEngaged ({ player, engagedUntil, now = Date.now() } = {}) {
  if (!player || !engagedUntil) return false;
  const at = typeof engagedUntil.get === 'function' ? engagedUntil.get(player) : engagedUntil[player];
  if (at == null) return false;
  return now < +at;   // 严格小于：窗口到点就是到点，不再看他
}

/** 看谁：只在**互动窗口内**的玩家里挑最近的（窗户关了就不看，哪怕就站在跟前） */
function pickGaze ({ players = [], self, now = Date.now(), next = 0, engagedUntil = null }, cfg = CFG.gaze) {
  if (!self || now < next) return null;
  const d = (p) => Math.hypot(p.pos.x - self.x, p.pos.y - self.y, p.pos.z - self.z);
  const near = players
    .filter(p => p?.pos && d(p) <= cfg.radius)
    .filter(p => gazeEngaged({ player: p.name, engagedUntil, now }))
    .sort((a, b) => d(a) - d(b));
  return near[0] || null;
}

// ---- 战斗
/** 怪是哪一类。held = 它手上拿的物品名（mineflayer entity.equipment[0]），模组远程怪靠这个认 */
function mobKind (name, held = null) {
  const n = String(name || '').replace(/^.*:/, '');
  if (/creeper/.test(n)) return 'creeper';
  if (held && /(^|:|_)(bow|crossbow|trident)$/.test(String(held))) return 'ranged';
  if (/^(skeleton|stray|bogged|pillager|witch|blaze|ghast|evoker|illusioner)$/.test(n)) return 'ranged';
  return 'melee';
}
/** 这把武器多久打一下才是满伤害（1.9+ 攻击冷却 = 20 / 攻速 tick） */
function attackCooldownMs (item) {
  const n = String(item || '').replace(/^.*:/, '');
  if (/sword/.test(n)) return 625;
  if (/_axe$/.test(n)) return /wooden|stone/.test(n) ? 1250 : 1100;
  if (/trident/.test(n)) return 1100;
  if (/pickaxe/.test(n)) return 834;
  if (/shovel/.test(n)) return 1000;
  if (!n) return 250;   // 空手
  return 625;
}
/**
 * 这一拍怎么打。
 * @param ctx.targets [{ id, name, pos, dist, on, evidence, kind }]  已经过滤成"可见敌对目标"
 * @param ctx.hp / hasShield / anchor({x,y,z}|null)
 * @returns { mode: 'melee'|'shield'|'avoid'|'retreat', target } | null
 */
function combatPlan (ctx, cfg = CFG.combat) {
  const { targets = [], hp = 20, hasShield = false, anchor = null } = ctx;
  const inRange = targets.filter(t => t.dist <= cfg.detect && (!anchor || Math.hypot(t.pos.x - anchor.x, t.pos.z - anchor.z) <= cfg.leash));
  if (!inRange.length) return null;
  inRange.sort((a, b) => a.dist - b.dist);
  const nearest = inRange[0];
  if (hp <= cfg.lowHp) return { mode: 'retreat', target: nearest };
  const creeper = inRange.find(t => t.kind === 'creeper' && t.dist < cfg.creeperSafe);
  if (creeper) return { mode: 'avoid', target: creeper, keep: cfg.creeperSafe };
  // 打谁：打过人的优先（证据最硬），再挑最近的；苦力怕不在近战名单里
  const fightable = inRange.filter(t => t.kind !== 'creeper')
    .sort((a, b) => ((a.evidence === 'hurt') ? 0 : 1) - ((b.evidence === 'hurt') ? 0 : 1) || a.dist - b.dist);
  if (!fightable.length) return null;
  const t = fightable[0];
  // 远程怪没盾：以前是“保持距离躲”，结果站着挨箭（主人 2026-09-28：被骷髅打了好几下都不动）。
  // 骷髅本来就在远处射，躲只会一直挨 —— 冲上去近战；血少时上面的 retreat 会先接管。
  if (t.kind === 'ranged' && !hasShield) return { mode: 'melee', target: t, charge: true };
  if (t.kind === 'ranged' && hasShield) return { mode: 'shield', target: t };
  return { mode: 'melee', target: t };
}

// ---- 自然建筑：看见这些就知道里面有宝箱（min = 至少看见几块才算，防一块苔石就当地牢）
const STRUCTURE_SIGNS = [
  { label: '刷怪笼（地牢 / 矿井）', re: /(^|:)spawner$/, min: 1 },
  { label: '地牢', re: /(^|:)mossy_cobblestone$/, min: 6 },
  { label: '废弃矿井', re: /(^|:)cobweb$/, min: 3 },
  { label: '沙漠神殿', re: /(^|:)(chiseled_sandstone|orange_terracotta)$/, min: 4 },
  { label: '要塞 / 丛林神庙', re: /(^|:)(mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks)$/, min: 5 },
  { label: '村庄', re: /(^|:)bell$/, min: 1 },
  { label: '下界要塞', re: /(^|:)(nether_bricks|nether_brick_fence)$/, min: 12 },
  { label: '堡垒遗迹', re: /(^|:)(gilded_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks)$/, min: 8 },
  { label: '末地城', re: /(^|:)(purpur_block|purpur_pillar|end_stone_bricks)$/, min: 12 },
  // 模组建筑（WorkBuddy 2026-09-27 从 jar 里的建筑模板查：有带 LootTable 的箱子 + 标志方块是模组特有的；modpack-study/instincts/structures.md）
  // 没收的：染梦系 / 蜂巢维度蜜脾 / 枯萎黑石 —— 那是整片维度 / 群系的地形，不是建筑标志
  { label: '幽灵船', re: /^more_critters:(ghostly_planks|ghostly_log|ghostly_wood|stripped_ghostly_log)$/, min: 10 },
  { label: '灵魂板岩圣所', re: /^netherexp:(soul_slate_bricks|soul_slate_tiles|chiseled_soul_slate_tiles)$/, min: 8 },
  { label: '粉盐神殿', re: /^galosphere:(pink_salt_bricks|polished_pink_salt|pink_salt_straw)$/, min: 6 },
  { label: '深园地下墓穴', re: /^undergarden:(depthrock_bricks|depthrock_brick_stairs|depthrock_brick_slab|shiverstone_bricks)$/, min: 6 },
  { label: '野林兽巢', re: /^ars_nouveau:(stripped_green_archwood_log|archwood_chest)$/, min: 3 },
  // 灾变（Cataclysm）的遗迹里有 boss（伊格尼斯、下界合金巨兽…）：只认出来、告诉 mind，不自己闯（danger）
  { label: '灾变·冰霜监狱 / 深红废墟（有 boss）', re: /^cataclysm:(frosted_stone_bricks|stone_tiles|stone_pillar)$/, min: 5, danger: true },
  { label: '灾变·沉没之城（有 boss）', re: /^cataclysm:(azure_seastone|azure_seastone_bricks|chiseled_azure_seastone_pillar_wall)$/, min: 6, danger: true },
  { label: '灾变·诅咒金字塔（有 boss）', re: /^cataclysm:(polished_sandstone|sandstone_falling_trap|sandstone_ignite_trap)$/, min: 5, danger: true },
  { label: '灾变·黑曜石堡垒（有 boss）', re: /^cataclysm:(obsidian_bricks|obsidian_brick_slab|obsidian_brick_stairs)$/, min: 5, danger: true },
];
/** blocks：[{ name, pos }]（看得见的）→ 认出的建筑 [{ label, anchor, count, key }]（anchor = 这类方块的中心） */
function recognizeStructures (blocks = []) {
  const out = [];
  for (const S of STRUCTURE_SIGNS) {
    const hit = blocks.filter(b => S.re.test(b.name));
    if (hit.length < S.min) continue;
    const c = hit.reduce((a, b) => ({ x: a.x + b.pos.x / hit.length, y: a.y + b.pos.y / hit.length, z: a.z + b.pos.z / hit.length }), { x: 0, y: 0, z: 0 });
    const anchor = { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) };
    out.push({ label: S.label, danger: !!S.danger, anchor, count: hit.length, key: `${S.label}@${Math.floor(anchor.x / 16)},${Math.floor(anchor.y / 16)},${Math.floor(anchor.z / 16)}` });
  }
  return out;
}
/**
 * 开不开宝箱 / 进不进建筑。
 * @returns { mode: 'open' } | { mode: 'explore', structure } | { skip }
 */
function pickLoot (c, cfg = CFG.loot) {
  const { chests = 0, structures = [], hp = 20, free = 36, packFree = null, nightOut = false, visited = new Set(), self } = c;
  if (hp < cfg.minHp) return { skip: `血 ${hp}，先不闯` };
  if (free < cfg.minFree && !(packFree != null && packFree >= 4)) return { skip: '身上和背包都没地方装了' };
  if (nightOut) return { skip: '夜里在露天，不去闯' };
  if (chests > 0) return { mode: 'open' };
  const todo = structures.filter(s => !visited.has(s.key) && !s.danger)   // 有 boss 的不自己闯（tryLoot 告诉 mind）
    .map(s => ({ ...s, dist: self ? Math.hypot(s.anchor.x - self.x, s.anchor.z - self.z) : 0 }))
    .filter(s => s.dist <= cfg.structRadius)
    .sort((a, b) => a.dist - b.dist);
  if (todo.length) return { mode: 'explore', structure: todo[0] };
  return { skip: structures.length ? '看见的建筑都进过了' : '没看见箱子，也没认出建筑' };
}

/**
 * 洞里下一步去哪。cells：候选的落脚点 [{ pos, visible, lavaNear, dark }]（已经是"脚和头是空的、脚下实心"的格子）。
 * 只去看得见的、没去过的、旁边没岩浆的、不太低的、不出入口 range 的；先挑暗的（没点亮 = 没人来过），再挑远一点的。
 */
function pickCaveStep ({ cells = [], self, entry = null, visited = new Set() }, cfg = CFG.cave) {
  if (!self) return null;
  const cell = (p) => `${Math.floor(p.x / cfg.visitCell)},${Math.floor(p.y / cfg.visitCell)},${Math.floor(p.z / cfg.visitCell)}`;
  const ok = cells.filter(c => c.visible && !c.lavaNear
    && !visited.has(cell(c.pos))
    && self.y - c.pos.y <= cfg.maxDrop
    && Math.hypot(c.pos.x - self.x, c.pos.z - self.z) >= cfg.minStep
    && (!entry || Math.hypot(c.pos.x - entry.x, c.pos.y - entry.y, c.pos.z - entry.z) <= cfg.range));
  if (!ok.length) return null;
  ok.sort((a, b) => ((b.dark ? 1 : 0) - (a.dark ? 1 : 0))
    || (Math.hypot(b.pos.x - self.x, b.pos.z - self.z) - Math.hypot(a.pos.x - self.x, a.pos.z - self.z)));
  return { ...ok[0], cell: cell(ok[0].pos) };
}

/**
 * 死了之后怎么把东西拿回来。
 * @returns { how: 'back' | 'walk' } | { skip }
 */
function pickRecovery (c, cfg = CFG.cmd) {
  const { death, here, dim, hasBack = false, hasTp = false, sinceMs = 0 } = c;
  if (!death) return { skip: '没死过' };
  if (death.lava) return { skip: '死在岩浆里，东西烧没了' };
  if (sinceMs > cfg.despawnMs - 20000) return { skip: '掉的东西快消失了（或者已经没了）' };
  if (hasBack) return { how: 'back' };
  if (death.dim !== dim) return { skip: `死在${death.dim}，现在在${dim}，走不回去` };
  if (hasTp) return { how: 'tp' };
  const d = here ? Math.hypot(death.pos.x - here.x, death.pos.z - here.z) : Infinity;
  if (d > cfg.recoverMax) return { skip: `死的地方离这里 ${Math.round(d)} 格，太远了` };
  return { how: 'walk', dist: Math.round(d) };
}

/**
 * 需要的时候用哪条命令（死亡回收之外的）。cmds = 服务器给了的命令名 Set。
 * @returns { cmd, why } | null
 */
function pickCommand (c, cfg = CFG.cmd) {
  const { cmds = new Set(), hp = 20, fleeing = false, nightOut = false, homeDist = null, atHome = false, homeSynced = false, sinceLast = Infinity,
    day = false, returnTo = null, sameDim = true } = c;
  if (sinceLast < cfg.cmdGapMs) return null;
  if (hp <= cfg.panicHp && fleeing) {
    if (cmds.has('home')) return { cmd: 'home', why: `血只剩 ${hp}，跑不掉了，传回家` };
    if (cmds.has('spawn')) return { cmd: 'spawn', why: `血只剩 ${hp}，跑不掉了，传回出生点` };
  }
  if (atHome && !homeSynced && cmds.has('sethome')) return { cmd: 'sethome', why: '在家，把服务器的 /home 也设在这里' };
  if (nightOut && homeDist != null && homeDist > cfg.nightFarHome && homeSynced && cmds.has('home')) return { cmd: 'home', why: `天黑了还在野外、离家 ${Math.round(homeDist)} 格，传回家`, remember: true };
  // 天亮了：回昨晚传走之前的地方接着干（/back 回的就是上一次传送前的位置；没有就 /tp 坐标）
  if (day && returnTo && sameDim) {
    if (cmds.has('back')) return { cmd: 'back', why: '天亮了，回昨晚离开的地方', returned: true };
    if (cmds.has('tp')) return { cmd: `tp ${returnTo.x} ${returnTo.y} ${returnTo.z}`, why: '天亮了，回昨晚离开的地方', returned: true, selfTp: true };
  }
  return null;
}

/**
 * 家里的暗处（mindcraft modes.js 调研后建议的"只提醒、不动手"：插不插、插哪由 mind / 主人定，基地的布局归主人）。
 * 1.20.1 敌对怪要**方块光照 0** 才刷。亮度先要证明读得到：家里的光源（火把、灯…）自己那格读出来 ≥ 10 才信；
 * 有光源却都读成暗的 = 亮度数据读不到（mindcraft 就栽在这：block.light 是坏的），**不报暗**。
 * @param sourceLights  家里光源所在格读到的方块光照（数组；undefined/null = 读不到）
 * @param cells         家里可站的地面格 [{ pos, light }]（light = 脚那格的方块光照）
 * @returns null | { kind: 'unreadable' } | { kind: 'no_source' } | { kind: 'dark', count, sample:[pos] }
 */
function darkReport ({ sourceLights = [], cells = [] } = {}, minCount = 3) {
  const readable = sourceLights.some(l => typeof l === 'number' && l >= 10);
  if (sourceLights.length && !readable) return { kind: 'unreadable' };
  if (!sourceLights.length) return cells.length >= minCount ? { kind: 'no_source' } : null;
  const dark = cells.filter(c => c.light === 0);
  if (dark.length < minCount) return null;
  return { kind: 'dark', count: dark.length, sample: dark.slice(0, 3).map(c => c.pos) };
}

/**
 * 家该多大。dists：家周围人造方块到家中心的水平距离（任意顺序）。
 * 从中心往外走，相邻两个人造方块的距离差 ≤ gap 就算"还连着"；连着的最远那个 + margin 就是新半径。只扩不缩，封顶 cap。
 */
function homeFootprint (dists = [], radius = 24, cfg = CFG.home) {
  const d = dists.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  let reach = 0;
  for (const x of d) { if (x - reach > cfg.gap && x > radius) break; reach = Math.max(reach, x); }
  if (reach <= radius) return radius;   // 房子都还在范围里：不动（只有盖出去了才扩）
  return Math.min(cfg.cap, Math.ceil(reach + cfg.margin));
}

/**
 * 落地水：这一拍该做什么。
 * @param c.startY 这次离地后到过的最高点；c.y 现在的脚底高度；c.vy 竖直速度（格/tick，往下是负）
 * @param c.landY  下面第一块实心方块的顶面高度（null = 下面 40 格内没有 / 读不到）；c.landIsWater 落点本来就是水
 * @param c.hasBucket / c.holding（手上是不是水桶）/ c.nether / c.placed（这次已经倒过了）
 * @returns 'equip' | 'place' | null
 */
function mlgStep (c, cfg = CFG.mlg) {
  const { startY, y, vy, landY, landIsWater = false, hasBucket, holding, nether = false, placed = false } = c;
  if (placed || !hasBucket || nether || landY == null || landIsWater || vy > -0.3) return null;
  if (startY - landY <= cfg.minFall) return null;   // 摔不伤
  if (!holding) return 'equip';
  if (y - landY <= cfg.placeAt) return 'place';
  return null;
}

/**
 * 该不该回家整理。
 * @param c.free        背包空格数
 * @param c.short       缺的 essential 标签
 * @param c.atHomeHas   其中家里箱子里记得有的
 * @param c.homeDist    离家多远（null = 不知道家在哪）
 * @param c.nightOut / c.sinceLast（上次整理过去多久，ms）
 * @returns { go: true, why } | { skip }
 */
function pickTidy (c, cfg = CFG.tidy) {
  const { free = 36, short = [], atHomeHas = [], homeDist = null, nightOut = false, sinceLast = Infinity,
    pack = null, sincePack = Infinity } = c;   // pack = { free: 背包空格(null=没开过不知道), has: [背包里有的缺项] } | null（没背）
  const full = free <= cfg.fullAt;
  // 先用背包：满了还能装、缺的背包里有 —— 就地倒腾，不跑回家
  if (pack && sincePack >= cfg.packCooldownMs) {
    const packRoom = pack.free == null || pack.free >= cfg.packMinFree;
    if ((full && packRoom) || (pack.has || []).length) {
      return { go: true, where: 'backpack', why: [full && packRoom ? `身上只剩 ${free} 格，先装进背包` : null, (pack.has || []).length ? `从背包里拿 ${pack.has.join('、')}` : null].filter(Boolean).join('，') };
    }
  }
  const restock = atHomeHas.length > 0;
  if (!full && !restock) return { skip: short.length ? `缺 ${short.join('、')}，家里也没记得有` : '身上齐全，也没满' };
  if (homeDist == null) return { skip: '不知道家在哪' };
  if (sinceLast < cfg.cooldownMs) return { skip: '刚整理过' };
  if (homeDist > cfg.maxHomeDist) return { skip: `离家 ${Math.round(homeDist)} 格，太远了（mind 决定要不要回）` };
  if (nightOut && homeDist > cfg.nightHomeDist) return { skip: '夜里在露天，家不够近' };
  return { go: true, where: 'home', why: [full ? `身上快满了（只剩 ${free} 格${pack ? '，背包也快满了' : ''}）` : null, restock ? `回家拿 ${atHomeHas.join('、')}` : null].filter(Boolean).join('，') };
}

/**
 * 一次拾取之后，哪些掉落物算"她没捡到"（要记失败、累计到 maxFails 就先放下）。
 * 被打断（aborted / r.stopped）的一律不算；只算"试过"的、还在地上的。
 *
 * ⚠️ 2026-09-28 审计（codex fix0 #3）：`r.tried` **缺失**时不再"退回全部 ids"。
 *
 *    旧行为是：`Array.isArray(r?.tried) ? new Set(r.tried) : null`，
 *    `null` 在下面被当成"没这个字段 → 全部算试过"。这对**旧版 bridge**（真的
 *    不返回 `tried`）是兼容，但对**异常 / 不完整响应**（handler 抛了、连不上、
 *    返回 `{error}`）就是误伤：会把全部 id 记成失败 → 拉黑一分钟。
 *    两者在旧判据里长得一模一样，分不开。
 *
 *    现在按**响应来自哪一版 bridge** 区分，而不是"字段在不在"：
 *      · 有 `tried` 数组 → 就按它算（新 bridge 的正常路径）；
 *      · 响应**明确是本次调用的正常返回**（有 `found`/`walkedTo` 这些本端点
 *        自有的字段）却没有 `tried` → 视为"说不清，一条都不记"（保守，
 *        AGENTS §5：证据不足不累计失败）；
 *      · 其余（handler 异常 / `{error}` / `null`）→ 一条都不记。
 *    真正的旧版 bridge 兼容改由 `found` 字段做锚点 —— 旧版也有 `found`
 *    但没有 `tried`，那种情况**只有**在调用方显式声明 `legacyOk` 时才按全部算。
 *
 * @param r         `POST /pickup` 的返回（可能为 null / {error}）
 * @param legacyOk  调用方确认"对面是旧版 bridge"时才为 true（默认 false）
 */
function pickupFailIds ({ ids = [], r = null, aborted = false, exists = () => true, legacyOk = false } = {}) {
  if (aborted || r?.stopped === 'aborted') return [];
  if (!r || typeof r !== 'object' || r.error) return [];      // 异常 / 不完整响应：不记
  const tried = Array.isArray(r.tried) ? new Set(r.tried) : null;
  // 没有 tried、又不是旧版：说不清她试过哪些 → 一条都不记（不误伤、不误冷却）
  if (!tried && !legacyOk) return [];
  return ids.filter(id => (!tried || tried.has(id)) && exists(id));
}

/**
 * 该不该吃。主人 2026-09-27：饥饿条掉 2 格（饥饿值 ≤16）就吃。
 * 身体被命令占着时不抢（换到手上的东西会打断挖掘、放置），除非饿到 urgentAt 以下（再不吃就不回血、跑不动）。
 * @returns null（不饿）| { eat: true, urgent } | { skip }
 */
function pickEat ({ food = null, busy = null, fighting = false, windowOpen = false, eating = false, hasFood = true, now = Date.now(), failUntil = 0 } = {}, cfg = CFG.eat) {
  if (food == null) return { skip: '读不到饥饿值' };
  if (food > cfg.at) return null;
  if (eating) return { skip: '正在吃' };
  if (fighting) return { skip: '在打架' };
  if (windowOpen) return { skip: '开着界面' };
  if (!hasFood) return { skip: '身上没有吃的' };
  if (now < failUntil) return { skip: '刚才没吃成，等一会儿再试' };
  const urgent = food <= cfg.urgentAt;
  if (busy && !urgent) return { skip: `在忙（${busy}），还不太饿，忙完再吃` };
  return { eat: true, urgent };
}

/** 该不该上浮换气。oxygen：0–20（null = 读不到 → 不猜）；头不在水里或有水下呼吸就不用 */
function needBreath ({ oxygen = null, headInWater = false, waterBreathing = false } = {}, cfg = CFG.breathe) {
  if (oxygen == null || !Number.isFinite(oxygen)) return false;
  if (!headInWater || waterBreathing) return false;
  return oxygen <= cfg.at;
}

/**
 * 中毒 / 凋零怎么办。effects：身上的效果名（minecraft-data 的写法：'Poison' 'Wither'）；null = 读不到 → 不猜。
 * @returns null | { bad:[...], milk:boolean, hpCost }
 */
function effectPlan ({ effects = null, hp = 20, hasMilk = false } = {}, cfg = CFG.effects) {
  if (!Array.isArray(effects)) return null;
  const bad = ['Poison', 'Wither'].filter(n => effects.includes(n));
  if (!bad.length) return null;
  const wither = bad.includes('Wither');
  const hpCost = (bad.includes('Poison') ? cfg.poisonHpCost : 0) + (wither ? cfg.witherHpCost : 0);
  return { bad, milk: hasMilk && (wither || hp <= cfg.milkHp), hpCost };
}

/**
 * 第 k 圈（水平切比雪夫距离 = k）的所有偏移，每个 (dx,dz) 配 dyMin..dyMax 的竖直偏移。
 * k=0 是她脚下那一列。由近到远一圈一圈找 —— 找到第一圈有能站的岸就不再往外看
 * （以前 25×25×6 ≈ 3750 格一次扫完，1 秒一拍，白扫大半）。
 *
 * 纯函数，便于自测。返回：[{ dx, dy, dz }]，顺序：按圈内水平距离近的优先。
 */
function shoreRingOffsets (k, dyMin = -2, dyMax = 3) {
  const out = [];
  if (k < 0) return out;
  const hs = [];
  for (let dx = -k; dx <= k; dx++) for (let dz = -k; dz <= k; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== k) continue;   // 只要这一圈
    hs.push({ dx, dz, h: Math.abs(dx) + Math.abs(dz) });
  }
  hs.sort((a, b) => a.h - b.h);   // 圈内斜角最后（先看正前/正侧）
  for (const { dx, dz } of hs) for (let dy = dyMin; dy <= dyMax; dy++) out.push({ dx, dy, dz });
  return out;
}

/**
 * 上岸去哪。cells：候选的陆地格 [{ pos, below, feet, head }]（方块名；feet/head 已经按 isStandable 判过能站 → ok 字段）。
 * 要求：脚下实心且不是水/岩浆/会伤人的，脚和头能站、不是水；挑水平最近的，高差小的优先（爬不上去的岸没用）。
 */
function pickShore (cells = [], self) {
  const ok = cells.filter(c => c.ok && c.below && !/water|lava|magma|fire|cactus|powder_snow|campfire|air$/.test(c.below)
    && !/water|bubble_column/.test(c.feet || '') && !/water|bubble_column/.test(c.head || ''));
  if (!ok.length || !self) return null;
  const cost = (c) => Math.hypot(c.pos.x + 0.5 - self.x, c.pos.z + 0.5 - self.z) + Math.max(0, c.pos.y - self.y) * 2;
  return ok.sort((a, b) => cost(a) - cost(b))[0];
}

/** 天气变了说什么。prev / now：{ rain, thunder }（布尔）。没变 → null */
function weatherChange (prev, now) {
  if (!prev || !now) return null;
  if (now.thunder && !prev.thunder) return { kind: 'thunder', text: '打雷了：天暗下来，白天也会刷怪；别站在高处、水里' };
  if (now.rain && !prev.rain) return { kind: 'rain', text: '下雨了' };
  if (!now.rain && prev.rain) return { kind: 'clear', text: '雨停了' };
  if (!now.thunder && prev.thunder) return { kind: 'thunder_end', text: '雷停了（还在下雨）' };
  return null;
}

/**
 * 跟着的玩家**站着不动**时，她可以顺手干点什么（2026-09-28 第 8 批 第 6 条）。
 *
 * 实机证据：`follow(Ka_sum1)` 之后 tick 走到 `if (followName) { … '跟着 X，只捡东西'; return; }`，
 * 只要 mind 给的 currentAction 还是 `following Ka_sum1`，她就**整段时间只捡东西**；
 * 采样里大量 `skip: 有 1 个命令在跑`，人不动她也不动 —— 主人看到的就是"站着不动"。
 *
 * 判据：玩家这一帧和**上一帧**的位置几乎没变，且已经连续不动 > idleMs（默认 8 秒）。
 * 站着不动 = 他在挂机/在看背包/在交易 → 她可以就地做点有用的事；
 * **他一动就立刻停下**（下一帧 movedAt 归零，本函数返回 null，tick 回到"只捡东西"）。
 *
 * @param {{now:number, idleMs:number, lastPos:?{x,y,z}, pos:?{x,y,z}, movedAt:number}} c
 *        lastPos = 上一次记下的玩家位置；movedAt = 上一次"他动过"的时间戳（0 = 还没见过）
 * @returns {null|{idleMs:number, since:number}} null = 他还在动 / 数据不足 → 别自作主张
 */
function followIdlePlan ({ now = Date.now(), idleMs = 8000, lastPos = null, pos = null, movedAt = 0 } = {}) {
  if (!pos) return null;                      // 读不到他的位置：不猜
  if (lastPos) {
    const moved = Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y, pos.z - lastPos.z);
    if (moved > 0.35) return null;            // 他在走 / 在跳：跟上，别做别的
  }
  if (!movedAt) return null;                  // 还不知道他站了多久 → 下一帧再说
  const idle = now - movedAt;
  if (idle < idleMs) return null;
  return { idleMs: idle, since: movedAt };
}

/**
 * 该不该在这儿插个火把（2026-09-28 第 8 批 第 4 条，纯函数）。
 *
 * 主人："插火把很慢。" 实机：`light_up() ✗ 正在执行紧急本能：combat` ——
 * 火把只有 mind 想起来调 `light_up`、或 `delve` 每 8 格插一根时才插；
 * 本能层根本没有"暗了就点灯"这一条。这条顶上。
 *
 * 判据（全部满足才插）：
 *   ① 在地下 / 洞里：exposure.kind === 'underground' 或（sheltered 且头顶有顶 roofAt != null）
 *      —— 露天的黑（夜里）不算，那是该回家睡觉的事，不是点灯的事；
 *   ② 脚下那格的**方块光**读得到（block 是数字）且 ≤ darkMax（默认 7，原版怪物在方块光 0 刷，留余量）
 *      —— 读不到就不插（主人：区分"没有"和"读不到"，读不到不猜）；
 *   ③ 身上有火把（torches > 0）；
 *   ④ 最近的光源 > spacing 格（默认 7）—— 和 `lightUp` 的判据一致，不重复插。
 * **打架时不插**（由调用方保证，不在这个纯函数里）。
 *
 * @returns {{place:true, why:string}|{place:false, why:string}}
 */
function pickTorchStep (c = {}, cfg = CFG.torch) {
  const { exposure = null, light = null, torches = 0, nearestLight = null, movedSince = Infinity } = c;
  if (!(torches > 0)) return { place: false, why: '身上没火把' };
  // ① 地下？
  const kind = exposure?.kind;
  if (!(kind === 'underground' || (kind === 'sheltered' && exposure?.roofAt != null))) {
    return { place: false, why: kind ? `不在洞里（exposure=${kind}）` : '不知道头顶有没有遮挡' };
  }
  // ④ 移动够了才检查（每 ~6 格一次，别每拍都点）
  if (movedSince < cfg.everyBlocks) return { place: false, why: `才走了 ${movedSince.toFixed(1)} 格，还没到 ${cfg.everyBlocks}` };
  // ② 亮度读得到才算暗
  if (!Number.isFinite(light)) return { place: false, why: '脚下亮度读不到，不插' };
  if (light > cfg.darkMax) return { place: false, why: `脚下不暗（方块光 ${light}）` };
  // ③ 附近已经有光源就不插
  if (nearestLight && nearestLight.distance <= cfg.spacing) return { place: false, why: `${nearestLight.distance} 格内已经有光源` };
  return { place: true, why: `脚下暗（方块光 ${light}）且 ${cfg.spacing} 格内没光源` };
}

/**
 * 身体空不空。返回 null = 空着；否则是一句"为什么不空"。
 * following 的时候算空（本能会打断跟随，干完再接上）。
 */
function bodyBusy ({ inflight = 0, currentAction = null, windowOpen = false, quietUntil = 0, now = Date.now() }) {
  if (inflight > 0) return `有 ${inflight} 个命令在跑`;
  if (windowOpen) return '开着界面';
  if (now < quietUntil) return '刚被叫停，站着别动';
  if (currentAction && !/^following /.test(currentAction)) return `在忙：${currentAction}`;
  return null;
}

// ------------------------------------------------------------------ 挂到 bot 上

/**
 * @param deps.handlers      bridge 的路由表（调 'POST /pickup'）
 * @param deps.hands         hands.js（接回跟随）
 * @param deps.isDropEntity / droppedItemOf / aggroOf   bridge 里的那一份（同一判据只写一处）
 */
/**
 * 本能配置补默认值：CFG 里每一段（对象）都补上，老的 state.instinct 里没有的新本能也补。
 * 以前是手写名单，2026-09-27 加吃/憋气/中毒三段时漏写，实机一上线就崩（I.cfg.breathe 是 undefined）。
 */
function fillCfg (cfg) {
  for (const [k, v] of Object.entries(CFG)) if (v && typeof v === 'object' && !Array.isArray(v)) cfg[k] = { ...v, ...(cfg[k] || {}) };
  return cfg;
}

/** 自动探洞不能把住宅地下当成空闲任务；明确下矿命令不经过此入口。 */
function caveBoundary (self, home) {
  if (!home?.center || !Number.isFinite(home.radius)) return '家的范围未知，暂不自动探洞';
  if (Math.hypot(self.x - home.center.x, self.z - home.center.z) <= home.radius) return '家范围内不自动探洞，等明确下矿指令';
  return null;
}

/** 以实体姿态纠正 mineflayer 的睡眠缓存；缺失姿态时不猜。
 * 来源：mineflayer/lib/plugins/entities.js 只在姿态 2 时 emit entitySleep，
 * 恢复清醒却依赖另一个 animation 包；若未收到该包，会一直拦住本能。
 */
function syncSleepState (bot, sleepAnchor = null, { sleptAt = 0, staleMs = 480000, now = Date.now() } = {}) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys;
  const index = keys?.indexOf('pose') ?? -1;
  const pose = index >= 0 ? bot.entity?.metadata?.[index] : undefined;
  if (!Number.isInteger(pose) || pose < 0) {
    // 某些登录/重连包没有 pose，但身体已经走离当时睡觉的位置：这比旧缓存可靠。
    const moved = !!(bot.isSleeping && sleepAnchor && bot.entity?.position
      && bot.entity.position.distanceTo(sleepAnchor) > 1.5);
    // 2026-09-28 审计：卡住时恰恰不会动 → 永远"在睡" → 本能主循环永远早退。再加两条证据：
    //   天亮了（0–12000 是白天，床睡不了）、或者"睡着"已经超过 staleMs（原版一觉最多几秒就跳夜）
    const t = bot.time?.timeOfDay;
    const day = Number.isFinite(t) && t >= 0 && t < 12000 && !(bot.isRaining && (bot.thunderState ?? 0) > 0);
    const stale = !!(bot.isSleeping && sleptAt && now - sleptAt > staleMs);
    const wake = moved || (bot.isSleeping && (day || stale));
    if (wake) { bot.isSleeping = false; bot.emit('wake'); }
    return { pose: null, sleeping: !!bot.isSleeping, corrected: wake, reason: moved ? '已走离睡觉位置' : wake ? (day ? '天亮了' : '"睡着"太久了') : '姿态未读到' };
  }
  const sleeping = pose === 2;
  const corrected = !!bot.isSleeping !== sleeping;
  if (corrected) {
    bot.isSleeping = sleeping;
    bot.emit(sleeping ? 'sleep' : 'wake');
  }
  return { pose, sleeping, corrected };
}

/** 事件立即唤醒，定时器兜底；同一检查不重入，错误不会变成未处理 rejection。 */
function createCheck (name, fn, diagnostics, now = Date.now) {
  let active = false;
  return async (source = 'timer') => {
    if (active) return;
    active = true;
    const d = diagnostics[name] = { at: now(), source, active: true };
    try { await fn(d); } catch (e) { d.error = String(e.message || e); } finally {
      d.durationMs = now() - d.at;
      d.active = false;
      active = false;
    }
  };
}

/** 中止后的收尾设上限；超时保留旧任务占用，下次重试，绝不让两个动作重叠。 */
async function settleJob (job, ms = 800) {
  if (!job) return true;
  let timer;
  try {
    return await Promise.race([
      job.done.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * 一个 job 结束收尾时，**它还有没有资格动身体**（清寻路目标 / 清 `I.running` 标记）。
 *
 * ⚠️ 2026-09-28 审计（codex fix0 #4）：抽出来是因为原来的原地判据只保住了"标记"、
 *    保不住"寻路目标"。战斗的 `finally` 里无条件 `bot.pathfinder.setGoal(null)` ——
 *    战斗被叫停、等旧动作超时、新命令已经接管身体时，旧战斗的 `finally` 仍会跑，
 *    把**新命令的**寻路目标一起清掉（新命令刚 `setGoal` 完就发现自己没目标了）。
 *
 *    正确的判据是"**当前 owner 还是不是我**"：
 *      · `I.running === myJob` → 期间没人接管 → 还是我，可以清；
 *      · 否则（被打断 / 被 yieldBody 换成新 job）→ 不是我的了 → 别动。
 *
 *    这是**纯函数**，所以能离线自测（见 selftest 的"收尾资格"一节）。
 *
 * @param {object} I        state.instinct
 * @param {object} myJob    本次要收尾的 job（拿到时的引用）
 * @returns {boolean} 还有没有资格动身体
 */
function ownsBodyAtCleanup (I, myJob) {
  return !!I && I.running === myJob && myJob != null;
}

/**
 * 憋气这一跳"到底跳了没有"。
 *
 * ⚠️ 2026-09-28 二轮审计（wbR2 新发现，高）：`runJob` 会把**某些情况下**的上浮直接拒掉
 *    （`I.urgent` 被 yieldBody / 战斗 finally 改掉时走早退分支，返回
 *    `{ r: { error: '已让出身体给紧急本能' }, aborted: true }`）。
 *    早退发生在 `I.running = job` 之前 —— 这次上浮连 owner 都没拿到，一跳都没跳。
 *    保命动作**不能有条件不满足就静默放弃的路径**，所以调用方必须能看出
 *    "这一下根本没跳成、需要直接补跳"。判据抽到这里（纯函数，可离线自测）：
 *    当真跳了（handler 报 `jumped > 0`）才放行；被拒 / 报错 / 跳了 0 下，
 *    都算"没跳成"，调用方要**直接补一次**。
 *
 * @param {{aborted?:boolean, r?:{error?:string, jumped?:number}}} res runJob 的返回
 * @returns {boolean} true = 这一下没真跳成，必须补跳
 */
function breatheRefused (res) {
  if (!res) return true;
  if (!Number.isFinite(res.r?.jumped) || res.r.jumped <= 0) return true;
  return false;
}

/**
 * 按区块柱逐个扫方块（2026-09-28 Claude 重写：第 8 批的版本用错了 mineflayer 的接口 ——
 *   `bot.world.getColumn({x,z})` 传对象（真接口是 `getColumn(chunkX, chunkZ)`）、`sections[sy]` 没减 minY，
 *   实机永远拿不到区块 → **什么都扫不到、也不报错**；它的自测用的假世界照同一套错接口写，所以是绿的）。
 * 现在：`world.getColumn(cx, cz)`（WorldSync 同步版）→ `column.getBlockStateId({x:局部, y:绝对, z:局部})`；
 *   section 下标 `(y - column.minY) >> 4`，section 的调色板（`section.data.palette` / 单值 `section.data.value`）
 *   里一个目标状态都没有就整节跳过。每扫完一柱 `await yieldFn()` 让出事件循环。
 * 没加载的柱记进 `unloaded`（"读不到"和"没有"分开报）。
 * @returns {Promise<{pts, sections, cells, columns, unloaded, worstMs}>}
 */
function * scanColumnsGen ({ world, registry, c, ids, maxDist, cap = 0, opts = {} }) {
  const { Vec3 } = require('vec3');
  const dy = opts.dy ?? 16; const minDist = opts.minDist || 0;
  const states = new Set();
  for (const id of ids || []) {
    const b = registry?.blocks?.[id];
    if (b && Number.isFinite(b.minStateId) && Number.isFinite(b.maxStateId)) for (let st = b.minStateId; st <= b.maxStateId; st++) states.add(st);
  }
  const out = []; let sections = 0; let cells = 0; let columns = 0; let unloaded = 0; let worstMs = 0;
  const r2 = maxDist * maxDist; const rMin2 = minDist * minDist;
  const cx0 = Math.floor(c.x / 16); const cz0 = Math.floor(c.z / 16); const cCols = Math.ceil(maxDist / 16) + 1;
  const yLo = Math.floor(c.y - dy); const yHi = Math.floor(c.y + dy);
  for (let dx = -cCols; dx <= cCols; dx++) {
    for (let dz = -cCols; dz <= cCols; dz++) {
      const sx = cx0 + dx; const sz = cz0 + dz;
      const ddx = Math.max(0, Math.abs(sx * 16 + 8 - c.x) - 8); const ddz = Math.max(0, Math.abs(sz * 16 + 8 - c.z) - 8);
      if (ddx * ddx + ddz * ddz > r2) continue;
      const t0 = process.hrtime.bigint();
      const col = world?.getColumn?.(sx, sz);
      if (!col) { unloaded++; continue; }
      const minY = Number.isFinite(col.minY) ? col.minY : -64;
      for (let sy = Math.floor(yLo / 16); sy <= Math.floor(yHi / 16); sy++) {
        const sec = col.sections?.[(sy * 16 - minY) >> 4];
        if (!sec) continue;
        sections++;
        const pc = sec.data;
        const pal = Array.isArray(pc?.palette) ? pc.palette : (pc && Number.isFinite(pc.value) ? [pc.value] : null);
        if (pal && !pal.some(st => states.has(st))) continue;   // 调色板里没有目标 → 整节跳过
        for (let lx = 0; lx < 16; lx++) {
          for (let lz = 0; lz < 16; lz++) {
            const wx = sx * 16 + lx; const wz = sz * 16 + lz;
            const hx = wx + 0.5 - c.x; const hz = wz + 0.5 - c.z; const h2 = hx * hx + hz * hz;
            if (h2 > r2 || (minDist && h2 < rMin2)) continue;
            for (let y = Math.max(sy * 16, yLo); y <= Math.min(sy * 16 + 15, yHi); y++) {
              cells++;
              if (!states.has(col.getBlockStateId({ x: lx, y, z: lz }))) continue;
              out.push(new Vec3(wx, y, wz));
              if (cap && out.length >= cap) break;
            }
            if (cap && out.length >= cap) break;
          }
          if (cap && out.length >= cap) break;
        }
        if (cap && out.length >= cap) break;
      }
      worstMs = Math.max(worstMs, Number(process.hrtime.bigint() - t0) / 1e6);
      columns++;
      yield null;   // 一柱扫完：让调用方有机会让出事件循环
      if (cap && out.length >= cap) return { pts: out, sections, cells, columns, unloaded, worstMs };
    }
  }
  return { pts: out, sections, cells, columns, unloaded, worstMs };
}
/** 实机用：每扫完一柱 await 一次（让出事件循环） */
async function scanColumnsIn (args) {
  const yieldFn = args.yieldFn || (() => new Promise(res => setImmediate(res)));
  const g = scanColumnsGen(args);
  for (;;) { const { value, done } = g.next(); if (done) return value; await yieldFn(); }
}
/** 自测用：同一个生成器同步跑完（测的就是跑的那份） */
function scanColumnsSync (args) {
  const g = scanColumnsGen(args);
  for (;;) { const { value, done } = g.next(); if (done) return value; }
}


function install (bot, state, deps) {
  const I = state.instinct = state.instinct || {
    cfg: {},
    inflight: 0,
    quietUntil: 0,
    running: null,      // { kind, abort(), done: Promise }
    last: null,         // 最近一次判断（每个本能为什么做 / 为什么没做）
    log: [],            // 最近做过的事
    events: [], evSeq: 0,   // 给 mind 的事（GET /instinct/events?since=）
    told: new Set(),        // 已经告诉过 mind 的"镐子不够"的矿位
    home: null,             // { center:{x,y,z}, radius }，mind 通过 POST /instinct {home} 告诉
    gazeEngagedUntil: new Map(),   // 玩家名 → 到什么时候为止还可以看他（见 gazeEngaged）
  };
  // 跨重连保留状态；新加的本能补上默认配置（老的 state.instinct 里没有）
  fillCfg(I.cfg);
  I.gazeEngagedUntil ||= new Map();   // 老 state 里没有（见 gazeEngaged）；趁早建好，礼物钩子要用
  I.torchAnchor ||= null;             // 暗处插火把：上次检查时她在哪（走够 everyBlocks 才再检查）—— 第 8 批第 4 条
  I.followSeen ||= null;              // 跟随中：上一帧看到的玩家位置（判断他动不动）—— 第 8 批第 6 条
  I.followMovedAt ||= 0;              // 跟随中：他上一次"动过"的时间戳
  I.delve ||= null;                   // 正在进行的下矿记录（mind 发起 / 本能续探）—— 第 8 批第 5 条
  I.noteDelve = (a, r, now) => noteDelve(I, a, r, now);   // hands.js 的 /delve 路由回调（接线只此一处）
  I.diagnostics = {};
  I.urgent = null;

  // ---- 慢活计时 + 事件循环延迟（2026-09-28）
  //
  // 起因：实机每 5 分钟整个进程冻 ~14 秒。`scheduler.lagMs` 是"本能这一拍自己算的拍间隔"，
  // 它能看出"某一拍晚了"，但 `busyForMs:0`（本能没在忙）时它分不清是谁堵的。
  // 这里加两样：
  //   · `slow(name, ms)` —— 每个大活干完量一次，超 200ms 打一行 `[instinct HH:MM:SS] slow <名字> <ms>`；
  //   · `monitorEventLoopDelay` —— 量**事件循环本身**的延迟（和本能忙不忙无关）。
  //     抓的是"同步代码堵住了整个进程"这种，正是 homeTimer 大扫描干的事。
  if (!I.slowLog) I.slowLog = [];              // 最近几条慢活（GET /instinct 看）
  const SLOW_MS = 200;
  const slow = (name, ms) => {
    if (!(ms >= SLOW_MS)) return ms;
    const stamp = new Date().toTimeString().slice(0, 8);
    console.log(`[instinct ${stamp}] slow ${name} ${ms.toFixed(0)}`);
    I.slowLog.push({ at: Date.now(), name, ms: Math.round(ms) });
    if (I.slowLog.length > 20) I.slowLog.shift();
    return ms;
  };
  /** 量一段同步大活的耗时。fn 必须是同步的（这里就是要抓同步堵住事件循环的那段）。 */
  const timed = (name, fn) => { const t0 = process.hrtime.bigint(); const r = fn(); slow(name, Number(process.hrtime.bigint() - t0) / 1e6); return r; };

  let loopHist = null;
  try {
    loopHist = monitorEventLoopDelay({ resolution: 20 });
    loopHist.enable();
  } catch (_) { loopHist = null; }
  /** 事件循环延迟（毫秒）。p50/p99/max；max 是**自上次读以来**的最大值，读完就重置，别让它一直粘着历史峰值。 */
  const loopDelay = () => {
    if (!loopHist) return null;
    const ms = (ns) => Math.round(ns / 1e6);
    const out = { p50: ms(loopHist.percentile(50)), p99: ms(loopHist.percentile(99)), max: ms(loopHist.max) };
    loopHist.reset();
    return out;
  };

  let ended = false;
  let sleepAnchor = null; let sleptAt = 0;
  const sleeping = () => {
    if (bot.isSleeping && !sleepAnchor && bot.entity?.position) { sleepAnchor = bot.entity.position.clone(); sleptAt = Date.now(); }
    const result = syncSleepState(bot, sleepAnchor, { sleptAt });
    if (!result.sleeping) { sleepAnchor = null; sleptAt = 0; }
    const bedKey = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('sleeping_pos') ?? -1;
    I.sleepState = { ...result, bedPosition: bedKey >= 0 ? bot.entity?.metadata?.[bedKey] ?? null : null, at: Date.now() };
    if (result.corrected) I.sleepCorrections = (I.sleepCorrections || 0) + 1;
    return result.sleeping;
  };
  const spawned = new Map();   // 掉落物 id → { t, thrower }
  const fails = new Map();
  const mineFails = new Map();   // "x,y,z" → 到什么时候之前不再试

  bot.on('entitySpawn', (e) => {
    try {
      if (!deps.isDropEntity(e)) return;
      const players = Object.values(bot.players || {})
        .filter(p => p.entity?.position)
        .map(p => ({ name: p.entity === bot.entity ? 'self' : p.username, pos: p.entity.position }));
      spawned.set(e.id, { t: Date.now(), thrower: whoThrew(e.position, players) });
    } catch (_) {}
  });
  // 她捡起了别人扔的东西：告诉物品账"这是谁给的"（collect 包点名了是哪个实体，是确证）
  // 同时开一个"可以看他"的窗口（主人 2026-09-28：有人给她东西是互动）
  bot.on('playerCollect', (collector, collected) => {
    try {
      if (collector !== bot.entity) return;
      const s = spawned.get(collected?.id);
      if (!s?.thrower || s.thrower === 'self') return;
      I.gazeEngagedUntil.set(String(s.thrower), Date.now() + (I.cfg.gaze.giftMs || 15000));
      const item = deps.droppedItemOf(collected)?.name;
      if (item) state.ledger?.note({ gift: { from: s.thrower, item } });
    } catch (_) {}
  });
  bot.on('entityGone', (e) => { spawned.delete(e?.id); fails.delete(e?.id); });

  // 落盘工具（主人 2026-09-28）：光进内存环形 30 条，出了问题日志里查不到 ——
  // 审计里遍地"日志里没找到 X"就是这么来的。这里**同时** console.log 一行。
  // 高频调用者（每 400ms 的 skip 等）**不要**走这里，只走 note/event 本身。
  const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

  const note = (entry) => {
    const at = Date.now();
    I.log.push({ t: at, ...entry });
    if (I.log.length > 30) I.log.shift();
    try {
      const { kind, ...rest } = entry;
      // 一行 ≤200 字符：长的字符串截断，不换行（日志按行读）
      let body = '';
      for (const [k, v] of Object.entries(rest)) {
        if (v == null || v === false || v === '') continue;
        let s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s && s.length > 80) s = s.slice(0, 77) + '...';
        body += ` ${k}=${s}`;
      }
      console.log(`[instinct ${hhmmss(at)}] ${kind ?? '?'}${body}`.slice(0, 200));
    } catch (_) {}
  };

  function canHold (itemName) {
    try {
      if (bot.inventory.emptySlotCount() > 0) return true;
      if (!itemName) return false;   // 读不出是什么，又没有空格 —— 保守：不去
      return bot.inventory.items().some(i => i.name === itemName && i.count < (i.stackSize || 64));
    } catch (_) { return false; }
  }

  /**
   * 这堆掉落物她**看得见**吗（远处拾取用）。
   *
   * mineflayer 只有 `canSeeBlock`（blocks.js:229，用 `world.raycast` 打一条视线），没有 `canSeeEntity`。
   * 这里用同样的 `world.raycast` 从眼睛打到掉落物那格：中途撞到实心方块 = 被挡住。
   * 读不到（没有 world/raycast、或位置缺失）返回 null —— 上层按"未知不远去"处理（AGENTS.md §5）。
   */
  function readVisible (e) {
    try {
      const self = bot.entity;
      if (!e?.position || !self?.position) return null;
      const dist = e.position.distanceTo(self.position);
      if (dist <= 8) return true;            // 脚边的不必打光：8 格内不会被挡得看不见
      const world = bot.world;
      if (!world?.raycast) return null;      // 读不到视线就说不清 —— 返回 null，不当"看得见"
      const eye = (self.eyeHeight || 1.62);
      const headPos = self.position.offset(0, eye, 0);
      const target = e.position.offset(0, 0.25, 0);   // 掉落物很小，瞄它的下半身
      const dir = target.minus(headPos);
      const range = dir.norm();
      if (!(range > 0)) return null;
      const hit = world.raycast(headPos, dir.scale(1 / range), Math.max(0, range - 0.6),
        (block) => !!block && block.boundingBox === 'block');   // 撞到实心方块就算挡住
      return !hit;                            // 没撞到东西 = 一路通到掉落物跟前 = 看得见
    } catch (_) { return null; }
  }

  function threatened () {
    const self = bot.entity;
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === self || e.type === 'player') continue;
      if (e.position.distanceTo(self.position) > I.cfg.pickup.threatRadius) continue;
      const a = deps.aggroOf(e);
      if (a && a.on === 'me') return `${e.name} 冲她来了`;
    }
    return null;
  }

  const event = (kind, text, extra = {}) => {
    const at = Date.now();
    // ⚠️ 2026-09-28 审计（codex fix1 #3）：**先把换行拍平再截断**。
    //    原来只 `slice(0, 300)` —— 异常消息里带 `\r\n` 时会输出成多行，
    //    破坏"一条事件一行日志"的格式（mind 侧按行读，多行会被误当成多条）。
    //    先 `replace(/[\r\n]+/g, ' ')` 再截断，保证单行。
    const line = String(text ?? '').replace(/[\r\n]+/g, ' ');
    I.events.push({ seq: ++I.evSeq, t: at, kind, text: line, ...extra });
    if (I.events.length > 50) I.events.shift();
    try { console.log(`[instinct-event ${hhmmss(at)}] ${kind} ${line}`.slice(0, 300)); } catch (_) {}
  };

  /**
   * 跑一件本能的事。abort() 由 yieldBody 调：置标记 + 停寻路 + 停挖（手上的 goto/dig 立刻结束，循环在下一步检查标记）。
   * ledgerEv：这期间背包的进出算谁的（物品账）。
   */
  async function runJob (kind, ledgerEv, fn) {
    if (ended || (I.urgent && I.urgent !== kind)) return { r: { error: '已让出身体给紧急本能' }, aborted: true };
    let aborted = false;
    const endLedger = state.ledger && ledgerEv ? state.ledger.begin(ledgerEv) : null;
    const done = (async () => {
      try { return await fn(() => aborted); } catch (e) { return { error: e.message }; }
    })();
    const job = I.running = {
      kind,
      abort: () => {
        aborted = true;
        try { bot.pathfinder.stop(); } catch (_) {}
        try { bot.stopDigging(); } catch (_) {}
      },
      done,
    };
    try { return { r: await done, aborted }; } finally {
      if (I.running === job) I.running = null;
      if (endLedger) { endLedger(); state.ledgerKick?.(); }
    }
  }

  async function runPickup (ids, followName) {
    const { r, aborted } = await runJob('pickup', { instinct: 'pickup' }, (abort) => deps.handlers['POST /pickup']({
      ids, count: ids.length, radius: I.cfg.pickup.radius + 2, timeoutMs: I.cfg.pickup.timeoutMs, budgetMs: I.cfg.pickup.budgetMs, abort,
    }));
    // 只有"真的试过、还在地上"的才记失败；被打断、没轮到（预算用完）的不算（2026-09-28 审计：以前一律记，打怪时捡两次就拉黑一分钟）
    for (const id of pickupFailIds({ ids, r, aborted, exists: (i) => !!bot.entities[i] })) {
      const f = fails.get(id) || { n: 0, until: 0 };
      f.n++; f.until = Date.now() + I.cfg.pickup.failCooldownMs;
      fails.set(id, f);
    }
    note({ kind: 'pickup', aborted: aborted || undefined, ids: ids.length, picked: r?.picked ?? 0, ms: r?.ms, stopped: r?.stopped, error: r?.error });
    // 本来在跟人：接着跟（被命令打断的不接 —— 命令说了算）
    if (followName && !aborted && !state.currentAction && bot.players[followName]?.entity) {
      try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {}
    }
  }

  // ---- 矿表 / 作物表（整合包真值，knowledge/ores.json、crops.json）→ 本连接的方块 id
  let tables = null;
  function loadTables () {
    if (tables) return tables;
    const read = (f) => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'knowledge', f), 'utf8')); } catch (_) { return null; } };
    const ores = deps.tables?.ores || read('ores.json');
    const crops = deps.tables?.crops || read('crops.json');
    const reg = bot.registry;
    const idOf = (n) => (reg.blocksByName[n] || reg.blocksByName[String(n).replace(/^minecraft:/, '')])?.id;
    const index = (list) => {
      const byId = new Map();
      for (const x of Array.isArray(list) ? list : []) { const id = idOf(x.name); if (id != null) byId.set(id, x); }
      return byId;
    };
    tables = { ores: index(ores), crops: index(crops), oresLoaded: Array.isArray(ores), cropsLoaded: Array.isArray(crops) };
    return tables;
  }

  const bareName = (n) => String(n).replace(/^minecraft:/, '');
  // 矿看不看得见：视线打得到，或者有一面露在空气/水里（矿洞里露出来的）—— 判据在 place.exposedToOpen，只一处
  const oreVisible = (b) => {
    if (!b) return false;
    try { if (bot.canSeeBlock(b)) return true; } catch (_) {}
    return require('./place').exposedToOpen(b.position, (x, y, z) => bot.blockAt(new (require('vec3').Vec3)(x, y, z)));
  };
  const hazardAround = (p) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (b && /lava|water/.test(b.name)) return true;
    }
    return false;
  };
  const inHome = (p) => {
    const h = I.home;
    if (!h) return null;
    return Math.hypot(p.x - h.center.x, p.z - h.center.z) <= h.radius && Math.abs(p.y - h.center.y) <= 16;
  };

  async function tryHarvest () {
    const H = I.cfg.harvest;
    if (!H.enabled || Date.now() - (I.lastHarvestAt || 0) < H.cooldownMs) return null;
    const T = loadTables();
    if (!T.cropsLoaded || !T.crops.size) return { skip: '没有作物表（knowledge/crops.json）' };
    const pts = bot.findBlocks({ matching: [...T.crops.keys()], maxDistance: H.radius, count: 256 });
    const crops = pts.map(p => {
      const b = bot.blockAt(p); if (!b) return null;
      const row = T.crops.get(b.type);
      const props = b.getProperties?.() || {};
      const below = bot.blockAt(p.offset(0, -1, 0));
      return {
        name: b.name, pos: p, age: +props[row.ageProp || 'age'], maxAge: row.maxAge, harvest: row.harvest,
        farmland: !!below && /farmland/.test(below.name),
        visible: bot.canSeeBlock(b),
      };
    }).filter(Boolean);
    const pick = pickHarvest({ crops, self: bot.entity.position, inHome });
    if (!pick.only) return pick;
    I.lastHarvestAt = Date.now();
    const { r, aborted } = await runJob('harvest', { route: 'POST /farm' }, (abort) => deps.hands.farm(bot, state, {
      radius: H.radius + 2, replant: true, plantEmpty: false, only: pick.only, abort,
    }));
    note({ kind: 'harvest', aborted: aborted || undefined, harvested: r?.harvested ?? 0, replanted: r?.replanted ?? 0, error: r?.error });
    if (r?.harvested) event('harvest', `顺手收了 ${r.harvested} 棵成熟的庄稼${r.replanted ? `，补种了 ${r.replanted} 棵` : '（没种子补种）'}`);
    return { did: 'harvest' };
  }

  async function tryMine (followIdle = null) {
    const M = I.cfg.mine;
    if (!M.enabled || Date.now() - (I.lastMineAt || 0) < M.cooldownMs) return null;
    if (bot.inventory.emptySlotCount() < CFG.minFreeSlots) return { skip: '背包快满了，不挖' };
    const T = loadTables();
    if (!T.oresLoaded || !T.ores.size) return { skip: '没有矿表（knowledge/ores.json）' };
    const pts = bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: M.radius, count: 64 });
    const ores = pts.map(p => {
      const b = bot.blockAt(p); if (!b) return null;
      const row = T.ores.get(b.type);
      return { name: row.name, pos: p, value: row.value, tier: row.tier, notPickaxe: !!row.notPickaxe, drops: (row.drops || []).map(bareName), visible: oreVisible(b), hazard: hazardAround(p) };
    }).filter(Boolean);
    // 镐子和"缺不缺这种矿"都要算上精妙背包里的（N-9：镐子在背包里时以前判"镐子不够"不挖）。
    // 背包读不到就按老逻辑（只看身上），并在 skip 原因里写清"背包读不到"——不能说"没有"。
    const carry = carriedNames(bot, state);
    const tally = carriedTally(bot, state);
    const have = tally.have;
    const pick = pickOre({ ores, self: bot.entity.position, pick: pickaxeTier(carry.names), have, fails: mineFails, followIdle });
    // 看得见、值钱、但镐子不够：告诉 mind（一个位置只说一次）
    for (const l of pick.lacking || []) {
      const k = `${l.pos.x},${l.pos.y},${l.pos.z}`;
      if (I.told.has(k)) continue;
      I.told.add(k);
      event('ore_lacking_tool', `看见 ${l.name}（${k}），但要${TIER_NAME[l.need] || '更好的镐子'}才挖得出东西${carry.readable ? '' : '（背包读不到，只算了身上的）'}`, { ore: l.name, pos: l.pos, backpackReadable: carry.readable });
    }
    if (!pick.target) {
      // 背包读不到时补一句，免得把"读不到"当成"真的没有"
      if (!carry.readable && pick.skip) return { ...pick, skip: `${pick.skip}；背包读不到（只算了身上的）` };
      return pick;
    }
    // ★ 挖之前先把镐子拿在身上（2026-09-28 第 8 批 第 2 条的后半）：
    //   pickaxeTier 把背包里的镐子也算"有"，但真去挖时手里没镐子会白跑一趟。
    //   ensureCarried 按"随身装备"同一套判据（re /pickaxe$/）从背包拿出来。
    if (deps.hands.ensureCarried) {
      try { await deps.hands.ensureCarried(bot, state, (it) => /pickaxe$/.test(it.name), 1); } catch (_) {}
    }
    I.lastMineAt = Date.now();
    const { r, aborted } = await runJob('mine', { route: 'POST /mine' }, (abort) => deps.handlers['POST /mine']({
      blockName: pick.target.name, count: pick.count, maxRadius: M.radius, abort,
    }));
    const got = typeof r?.mined === 'number' ? r.mined : 0;   // /mine 回的是挖掉的块数
    const k = `${pick.target.pos.x},${pick.target.pos.y},${pick.target.pos.z}`;
    // 被打断（战斗/命令）**不记失败冷却** —— 打断不是"挖不动"，
    // 下一拍身体空了要接着挖同一个矿（这就是"遇到矿石也不挖"的另一半原因：
    // 以前战斗插进来一次，这个矿位就被 failCooldownMs=10 分钟封掉了）。
    if (!got && !aborted) mineFails.set(k, Date.now() + M.failCooldownMs);
    if (aborted) mineFails.delete(k);   // 清掉早先可能记下的失败，让它下一拍能接着来
    note({ kind: 'mine', ore: pick.target.name, aborted: aborted || undefined, mined: got, error: r?.error });
    if (got) event('mine', `看见 ${pick.target.name} 就顺手挖了 ${got} 块`, { ore: pick.target.name });
    return aborted ? { skip: '挖矿被战斗或命令打断，下一拍接着挖' } : { did: 'mine' };
  }

  // ---- 接着把 mind 交待的下矿走完（第 5 条）
  // cave 本能仍然默认关；这条只对"mind 明确下过 /delve 且 5 分钟内被打断"的情况生效。
  async function tryResumeDelve () {
    const D = I.cfg.delve;
    const plan = pickDelveResume({
      delve: I.delve, self: bot.entity.position, now: Date.now(),
      resumeMs: D.resumeMs, reach: D.reach, enabled: D.enabled,
    });
    if (!plan.resume) { if (!I.delve) return null; return { skip: plan.why }; }
    if ((bot.health ?? 20) < D.minHp) return { skip: `血 ${bot.health}，先不接着挖` };
    if (bot.inventory.emptySlotCount() < CFG.minFreeSlots) return { skip: '背包快满了，先不接着挖' };
    if (!I.caveDone) I.caveDone = new Set();
    // 从记录里的洞口接着走 —— delve 自己会读取 state 里的 mines.json / heading 接着挖
    I.lastDelveAt = Date.now();
    const { r, aborted } = await runJob('delve', { route: 'POST /delve' }, (abort) => deps.handlers['POST /delve']({
      target: plan.target, targetY: I.delve?.targetY ?? undefined, seconds: Math.round(D.seconds), abort,
    }));
    if (aborted) return { skip: '续挖被战斗或命令打断' };
    noteDelve(I, { target: plan.target, seconds: D.seconds, resumed: true }, r || {}, Date.now());   // 本能自己接着下的：计数，封顶见 pickDelveResume
    note({ kind: 'delve', resume: true, reason: r?.reason, gained: r?.gained, error: r?.error });
    event('delve_resume', `接着把上次没挖完的矿挖下去：${String(r?.reason || '').slice(0, 60)}${r?.gained ? `（进账 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}）` : ''}`, { gained: r?.gained });
    return { did: 'delve' };
  }

  // ---- 暗处插火把（第 4 条，新本能，无 LLM）
  // 不在战斗里插（调用方 tick 已经在 fighting 时早退；这里再兜一层），每 ~6 格检查一次。
  async function tryTorch () {
    const TC = I.cfg.torch;
    if (!TC.enabled) return null;
    if (Date.now() - (I.lastTorchCheck || 0) < TC.checkMs) return null;
    I.lastTorchCheck = Date.now();
    // ④ 走了多少格：按水平位移累计（原地不动不插）
    let ex = null; try { ex = deps.exposureOf?.(bot); } catch (_) { ex = null; }
    const here = bot.entity.position;
    const moved = I.torchAnchor ? Math.hypot(here.x - I.torchAnchor.x, here.z - I.torchAnchor.z) : Infinity;
    const li = (() => { try { return deps.hands.lightAt?.(bot); } catch (_) { return null; } })();
    const near = (() => { try { return deps.hands.nearestLight?.(bot, TC.spacing); } catch (_) { return null; } })();
    const torches = (() => { try { return deps.hands.torchCount?.(bot) ?? 0; } catch (_) { return 0; } })();
    const plan = pickTorchStep({
      exposure: ex, light: li?.block ?? null, torches, nearestLight: near, movedSince: moved,
    }, TC);
    if (!plan.place) {
      // 走了够远就把锚点挪过来，免得一直在"还没走够"里打转
      if (moved >= TC.everyBlocks) I.torchAnchor = { x: here.x, z: here.z };
      return { skip: plan.why };
    }
    // 火把可能在精妙背包里 → 先补到身上（和 hands.lightUp 的判据同一处）
    if (deps.hands.ensureCarried) { try { await deps.hands.ensureCarried(bot, state, (it) => /(^|:)torch$/.test(it.name), 1); } catch (_) {} }
    const { r, aborted } = await runJob('torch', null, (abort) => deps.handlers['POST /light_up']({ max: 1, abort }));
    I.torchAnchor = { x: here.x, z: here.z };
    if (aborted) return { skip: '插火把被战斗或命令打断' };
    const placed = typeof r?.placed === 'number' ? r.placed : 0;
    note({ kind: 'torch', placed, why: plan.why, error: r?.error });
    if (placed > 0) { event('torch', `这里暗，插了 ${placed} 根火把`, { placed }); return { did: 'torch' }; }
    return { skip: `想插火把没插成（${r?.error || r?.note || '没有合适的位置'}）` };
  }

  // ---- 危险方块退开（保命：连"刚被叫停"也不拦它）
  function stepOffPlan () {
    const f = bot.entity.position.floored();
    const nm = (p) => bot.blockAt(p)?.name ?? null;
    const me = bot.entity.position;
    const fallingAbove = Object.values(bot.entities).some(e => e?.name === 'falling_block' && e.position
      && Math.abs(e.position.x - me.x) < 1 && Math.abs(e.position.z - me.z) < 1 && e.position.y > me.y && e.position.y - me.y < 8);
    const why = hazardUnder({ feet: nm(f), below: nm(f.offset(0, -1, 0)), fallingAbove });
    if (!why) return null;
    const cells = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = f.offset(dx, 0, dz);
      cells.push({ dx, dz, feet: nm(c), head: nm(c.offset(0, 1, 0)), below: nm(c.offset(0, -1, 0)) });
    }
    const to = pickStepOff(cells);
    if (!to) return { why };
    return { why, f, to };
  }

  async function tryStepOff (plan = stepOffPlan()) {
    if (!plan) return null;
    const { why, f, to } = plan;
    if (!to) { event('hazard_stuck', `${why}，旁边也没有能站的地方`); return { skip: why }; }
    const { goals } = require('mineflayer-pathfinder');
    await runJob('stepoff', null, async (abort) => {
      await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(f.x + to.dx, f.y, f.z + to.dz)), new Promise(r => setTimeout(r, 2500))]);
      if (!abort()) { try { bot.pathfinder.setGoal(null); } catch (_) {} }
    });
    note({ kind: 'stepoff', why });
    return { did: 'stepoff' };
  }

  // ---- 夜里在家有床就睡
  async function trySleep () {
    const S = I.cfg.sleep;
    if (!S.enabled || bot.isSleeping || Date.now() < (I.sleepRetryAt || 0)) return null;
    if (deps.night?.phaseOf(bot.time?.timeOfDay) !== 'night' && !I.weather?.thunder) return null;   // 打雷时白天也能睡
    if (inHome(bot.entity.position) !== true) return { skip: '不在家（或不知道家在哪）' };
    const { r, aborted } = await runJob('sleep', null, (abort) => deps.handlers['POST /sleep']({ home: I.home, abort }));
    if (aborted || r?.aborted) return { skip: '睡觉被紧急动作或命令打断' };
    if (r?.sleeping || r?.already) event('sleep', '天黑了，在家上床睡了');
    else {
      I.sleepRetryAt = Date.now() + S.retryMs;
      if (!I.sleepToldNight || Date.now() - I.sleepToldNight > 600000) {
        I.sleepToldNight = Date.now();
        event('sleep_failed', `天黑了想睡，没睡成：${String(r?.error || '不知道为什么').slice(0, 80)}（过几分钟再试）`);
      }
    }
    return { did: 'sleep' };
  }

  // ---- 换更好的护甲
  async function tryArmor () {
    const A = I.cfg.armor;
    if (!A.enabled || Date.now() - (I.lastArmorAt || 0) < A.everyMs) return null;
    I.lastArmorAt = Date.now();
    const sl = bot.inventory.slots;
    const worn = { head: sl[5]?.name ?? null, torso: sl[6]?.name ?? null, legs: sl[7]?.name ?? null, feet: sl[8]?.name ?? null };
    const items = bot.inventory.items().map(i => ({ name: i.name, slot: deps.hands.slotByName(i.name) })).filter(i => ['head', 'torso', 'legs', 'feet'].includes(i.slot));
    const plan = pickArmor(worn, items);
    if (!plan.length) return null;
    const p0 = plan[0];
    const { r } = await runJob('armor', { route: 'POST /wear' }, async () => {
      const it = bot.inventory.items().find(i => i.name === p0.name);
      if (!it) return { error: '背包里没了' };
      await bot.equip(it, p0.slot);
      await new Promise(res => setTimeout(res, 300));
      const idx = { head: 5, torso: 6, legs: 7, feet: 8 }[p0.slot];
      return { worn: bot.inventory.slots[idx]?.name === p0.name };
    });
    note({ kind: 'armor', ...p0, ok: !!r?.worn });
    if (r?.worn) event('armor', `换上了 ${p0.name}${p0.from ? `（原来穿的是 ${p0.from}）` : ''}`);
    return { did: 'armor' };
  }

  // ---- 开宝箱 / 进建筑
  I.visitedStructures ||= new Set();
  let signIds = null;
  // structureBlocks 结果缓存：findBlocks 是全量扫（40 格 ×128），每拍都跑明显拖 tick。
  // 缓存 3 秒；她走动了 4 格以上就作废（换地方了，旧的扫描结果不作数）。
  let sbCache = null;
  const structureBlocks = (radius) => {
    const self = bot.entity?.position;
    if (sbCache && Date.now() - sbCache.at < 3000 && self && (!sbCache.from || self.distanceTo(sbCache.from) <= 4)) return sbCache.list;
    if (!signIds) signIds = Object.values(bot.registry.blocksByName).filter(b => STRUCTURE_SIGNS.some(S => S.re.test(b.name))).map(b => b.id);
    const list = bot.findBlocks({ matching: signIds, maxDistance: radius, count: 128 })
      .map(p => bot.blockAt(p)).filter(b => b && bot.canSeeBlock(b)).map(b => ({ name: b.name, pos: b.position }));
    sbCache = { at: Date.now(), from: self ? self.clone() : null, list };
    return list;
  };
  const summarizeLoot = (checked = []) => {
    const got = {};
    for (const c of checked) for (const [k, n] of Object.entries(c.looted || {})) got[k] = (got[k] || 0) + n;
    const top = Object.entries(got).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k.replace(/^minecraft:/, '')}×${n}`);
    const opened = checked.filter(c => !c.error).length;
    const failed = checked.filter(c => c.error).map(c => `${c.name}：${c.error}`).slice(0, 2);
    return { opened, top, failed };
  };
  async function tryLoot (nightOut) {
    const L = I.cfg.loot;
    if (!L.enabled || Date.now() - (I.lastLootAt || 0) < L.cooldownMs) return null;
    const self = bot.entity.position;
    const chests = deps.hands.unseenChests(bot, state, L.radius).length + deps.hands.unseenCarts(bot, state, 16).length;
    const bp = state.backpackSeen;
    // 同一拍里 recognizeStructures 只算一次（以前结构那一支算两遍，等于白扫两趟）
    const structs = chests ? [] : recognizeStructures(structureBlocks(L.structRadius));
    const pick = pickLoot({
      chests, structures: structs,
      hp: bot.health ?? 20, free: bot.inventory.emptySlotCount(),
      packFree: deps.hands.wearingBackpack?.(bot, state) && bp ? bp.slots - bp.used : null,
      nightOut, visited: I.visitedStructures, self,
    }, L);
    // 认出有 boss 的遗迹：只告诉 mind（一座一次），去不去她定
    if (!chests) {
      for (const S of structs.filter(x => x.danger)) {
        if (I.told.has(`danger:${S.key}`)) continue;
        I.told.add(`danger:${S.key}`);
        event('structure_danger', `认出附近是${S.label}（${S.anchor.x},${S.anchor.y},${S.anchor.z}），里面有好东西但很危险，没自己进去`, { structure: S.label, pos: S.anchor });
      }
    }
    if (!pick.mode) return pick;
    I.lastLootAt = Date.now();
    if (pick.mode === 'open') {
      const { r, aborted } = await runJob('loot', { route: 'POST /chests/check' }, (abort) => deps.handlers['POST /chests/check']({ radius: L.radius, home: I.home, max: 4, abort }));
      const sm = summarizeLoot(r?.checked);
      note({ kind: 'loot', opened: sm.opened, aborted: aborted || undefined, error: r?.error });
      if (sm.opened || sm.failed.length) event('loot', `开了 ${sm.opened} 个箱子${sm.top.length ? `，拿到：${sm.top.join('、')}` : ''}${sm.failed.length ? `；没开成：${sm.failed.join('；')}` : ''}`);
      return { did: 'loot' };
    }
    const S = pick.structure;
    I.visitedStructures.add(S.key);   // 先记下：进不去也别来回折腾
    event('structure', `认出附近有${S.label}（${S.anchor.x},${S.anchor.y},${S.anchor.z}，${Math.round(S.dist)} 格），里面应该有宝箱，进去看看`, { structure: S.label, pos: S.anchor });
    const { r, aborted } = await runJob('loot', { route: 'POST /chests/check' }, async (abort) => {
      const g = await deps.handlers['POST /go']({ x: S.anchor.x, y: S.anchor.y, z: S.anchor.z, range: 3, abort });
      if (abort()) return { checked: [] };
      const near = { ...S.anchor, r: L.structNear };
      const res = await deps.handlers['POST /chests/check']({ radius: L.structNear + 6, home: I.home, max: 6, near, abort });
      return { ...res, arrived: g?.arrived };
    });
    const sm = summarizeLoot(r?.checked);
    note({ kind: 'explore', structure: S.label, opened: sm.opened, aborted: aborted || undefined, error: r?.error });
    if (!aborted) {
      event('structure_done', sm.opened
        ? `${S.label}里开了 ${sm.opened} 个箱子${sm.top.length ? `，拿到：${sm.top.join('、')}` : ''}`
        : `${S.label}里没找到能开的箱子${r?.arrived === false ? '（没走进去）' : ''}${sm.failed.length ? `：${sm.failed.join('；')}` : ''}`);
    }
    return { did: 'explore' };
  }

  // ---- 洞穴探险
  async function tryCave () {
    const C = I.cfg.cave;
    I.caveDone ||= new Set();
    if (!C.enabled || !deps.hands.inCave?.(bot)) return null;
    const boundary = caveBoundary(bot.entity.position, I.home);
    if (boundary) return { skip: boundary };
    if ((bot.health ?? 20) < C.minHp) return { skip: `血 ${bot.health}，先不逛洞` };
    const here = bot.entity.position.floored();
    const caveKey = (p) => `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
    // 换了一个洞（离上一个洞的入口够远）：重新开始记
    if (!I.cave || Math.hypot(here.x - I.cave.entry.x, here.y - I.cave.entry.y, here.z - I.cave.entry.z) > C.range) {
      const key = caveKey(here);
      if (I.caveDone.has(key)) return { skip: '这个洞逛过了' };
      I.cave = { key, entry: { x: here.x, y: here.y, z: here.z }, steps: 0, visited: new Set() };
      event('cave', `当前位置像洞穴（${here.x},${here.y},${here.z}），自动探洞本能准备探索；未记录进入方式`, { pos: I.cave.entry, source: 'instinct', entryMethod: 'unknown' });
    }
    if (I.cave.steps >= C.maxSteps) {
      if (!I.caveDone.has(I.cave.key)) { I.caveDone.add(I.cave.key); event('cave_done', `这个洞逛了 ${I.cave.steps} 步，差不多了`); }
      return { skip: '这个洞逛完了' };
    }
    // 候选落脚点：附近的空气格里，脚下实心、头顶也空的
    const airIds = ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x != null);
    const isLava = (p) => /lava/.test(bot.blockAt(p)?.name || '');
    const cells = [];
    for (const p of bot.findBlocks({ matching: airIds, maxDistance: C.scan, count: 600 })) {
      const below = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
      if (!below || below.boundingBox !== 'block' || !head || head.boundingBox !== 'empty') continue;
      const feet = bot.blockAt(p);
      cells.push({
        pos: p,
        visible: bot.canSeeBlock(below),
        lavaNear: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([dx, dy, dz]) => isLava(p.offset(dx, dy, dz))),
        dark: (feet?.light ?? 0) < 4,
      });
    }
    const step = pickCaveStep({ cells, self: bot.entity.position, entry: I.cave.entry, visited: I.cave.visited }, C);
    if (!step) {
      // 同一洞之后每 400ms 仍会走到这里。只在第一次完成时记事件，避免 mind
      // 收到几十条相同“探完了”并误以为她反复执行过探险任务。
      if (!I.caveDone.has(I.cave.key)) {
        I.caveDone.add(I.cave.key);
        event('cave_done', `这个洞看得见的地方都走过了（${I.cave.steps} 步）`);
      }
      return { skip: '洞里没有新地方了' };
    }
    I.cave.visited.add(step.cell);
    I.cave.visited.add(`${Math.floor(here.x / C.visitCell)},${Math.floor(here.y / C.visitCell)},${Math.floor(here.z / C.visitCell)}`);
    I.cave.steps++;
    const from = { x: here.x, y: here.y, z: here.z };
    const { r, aborted } = await runJob('cave', null, async (abort) => {
      const g = await deps.handlers['POST /go']({ x: step.pos.x, y: step.pos.y, z: step.pos.z, range: 1.5, maxMs: 20000, abort });
      if (!abort()) { try { await deps.handlers['POST /light_up']({ max: 1 }); } catch (_) {} }
      return g;
    });
    note({ kind: 'cave', from, to: step.pos, step: I.cave.steps, aborted: aborted || undefined, arrived: r?.arrived, error: r?.error });
    if (!aborted && r?.arrived === true) event('cave_move', `自动探洞本能执行走路：从（${from.x},${from.y},${from.z}）走到（${step.pos.x},${step.pos.y},${step.pos.z}）；这是寻路到达记录，不是挖穿或坠落的证据`, { from, to: step.pos, action: 'go', arrived: true });
    return { did: 'cave' };
  }

  // ---- 寻路挖掘白名单：本连接的方块 id（按整合包方块标签算一次）
  let natIds = null;
  const naturalIds = () => {
    if (natIds) return natIds;
    let tagOf = () => undefined;
    try { const kb = require('./knowledge').load(); tagOf = (t) => kb.tags.get(`block:${t}`); } catch (_) {}
    const reg = bot.registry;
    natIds = new Set();
    for (const n of deps.pathing.naturalDigNames(tagOf)) {
      const b = reg.blocksByName[n] || reg.blocksByName[n.replace(/^minecraft:/, '')];
      if (b) natIds.add(b.id);
    }
    return natIds;
  };
  const builtNear = (p) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (b && deps.isPlayerBuilt?.(b.name)) return true;
    }
    return false;
  };

  // ---- 指令本能
  let cmdCache = { at: 0, set: new Set() };
  const serverCmds = async () => {
    if (Date.now() - cmdCache.at < 300000) return cmdCache.set;
    try { const r = await deps.handlers['GET /commands'](); cmdCache = { at: Date.now(), set: new Set(r?.all || []) }; } catch (_) {}
    return cmdCache.set;
  };
  const runCmd = async (cmd, why, { selfTp = false } = {}) => {
    I.lastCmdAt = Date.now();
    let r = null;
    // selfTp：把她自己 /tp 回去过的坐标 —— 管理员命令里唯一放给本能的（runCommand 只认 tp x y z + 这个函数）
    try { r = await deps.handlers['POST /cmd']({ command: cmd, ...(selfTp ? { selfTp: () => 'self-tp' } : {}) }); } catch (e) { r = { error: e.message }; }
    event('command', `${why}：用了 /${cmd}${r?.error ? `，没成：${r.error}` : (r?.serverSaid?.length ? `（服务器说：${r.serverSaid.join(' / ').slice(0, 80)}）` : '')}`, { cmd });
    return r;
  };
  const dimNow = () => String(bot.game?.dimension || '').replace(/^minecraft:/, '') || '?';
  bot.on('death', () => {
    try {
      const p = bot.entity.position.floored();
      // 身边 3×3×3 有岩浆就算"死在岩浆里"：掉的东西多半烧了，/back 回去也是站进岩浆边（以前只看脚、头、脚下 3 格会漏）
      let lava = false;
      for (let dx = -1; dx <= 1 && !lava; dx++) for (let dy = -1; dy <= 1 && !lava; dy++) for (let dz = -1; dz <= 1 && !lava; dz++) lava = /lava/.test(bot.blockAt(p.offset(dx, dy, dz))?.name || '');
      I.death = { pos: { x: p.x, y: p.y, z: p.z }, dim: dimNow(), at: Date.now(), lava, recovered: false };
      if (I.running) I.running.abort();
    } catch (_) {}
  });
  bot.on('spawn', () => {
    // 重生（spawn 在死后重生时也会发）：告诉 mind，再回去捡
    const d = I.death;
    if (!d || d.told) return;
    d.told = true;
    event('died', `死了一次（死在 ${d.pos.x},${d.pos.y},${d.pos.z}，${d.dim}${d.lava ? '，掉进了岩浆' : ''}），已经重生；身上的东西掉在那里，5 分钟内不捡就没了`, { pos: d.pos });
  });
  async function tryRecover () {
    const d = I.death;
    if (!I.cfg.cmd.enabled || !d || d.recovered || !d.told) return null;
    const cmds = await serverCmds();
    const pick = pickRecovery({ death: d, here: bot.entity.position, dim: dimNow(), hasBack: cmds.has('back'), hasTp: cmds.has('tp'), sinceMs: Date.now() - d.at }, I.cfg.cmd);
    // 先置位，别让同一次死在下一拍又发一遍。但**被打断不算回收过了** ——
    // 战斗本能打断 / 让出身体时这一趟白跑，允许下一拍再试一次（最多多试 1 次，不无限来回）。
    d.recovered = true;
    const tries = d.recoverTries = (d.recoverTries || 0) + 1;
    const allowRetry = tries < 2;   // 第 1 次被打断就再给一次；第 2 次之后不再试
    if (!pick.how) { event('recover_skip', `没回去捡东西：${pick.skip}`); return { skip: pick.skip }; }
    const { r, aborted } = await runJob('recover', { instinct: 'pickup' }, async (abort) => {
      if (pick.how === 'back') await runCmd('back', '回死的地方捡东西');
      else if (pick.how === 'tp') await runCmd(`tp ${d.pos.x} ${d.pos.y + 1} ${d.pos.z}`, '传回死的地方捡东西', { selfTp: true });
      else {
        event('recover', `走回死的地方捡东西（${pick.dist} 格）`);
        const g = await deps.handlers['POST /go']({ x: d.pos.x, y: d.pos.y, z: d.pos.z, range: 3, maxMs: 240000, abort });
        if (abort() || g?.arrived === false) return { error: `没走到${g?.error ? `：${g.error}` : ''}` };
      }
      if (abort()) return {};
      return deps.handlers['POST /pickup']({ radius: 10, count: 32, timeoutMs: 6000, abort });
    });
    if (!aborted) event('recover_done', r?.error ? `回去捡东西没成：${r.error}` : `回到死的地方，捡回来 ${r?.picked ?? 0} 件`);
    else if (allowRetry) d.recovered = false;   // 被打断 → 放开一次，下一拍再来（最多 1 次）
    return { did: 'recover' };
  }
  async function tryCommand (nightOut) {
    if (!I.cfg.cmd.enabled) return null;
    const cmds = await serverCmds();
    if (!cmds.size) return null;
    const h = I.home;
    const pick = pickCommand({
      cmds, hp: bot.health ?? 20, fleeing: I.running?.kind === 'combat' && I.combat?.retreating, nightOut,
      homeDist: h ? Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) : null,
      atHome: inHome(bot.entity.position) === true, homeSynced: !!(h && I.homeSyncedAt && I.homeSyncedFor === `${h.center.x},${h.center.z}`),
      sinceLast: Date.now() - (I.lastCmdAt || 0),
      day: deps.night?.phaseOf(bot.time?.timeOfDay) === 'day', returnTo: I.returnTo?.pos || null, sameDim: !I.returnTo || I.returnTo.dim === dimNow(),
    }, I.cfg.cmd);
    if (!pick) return null;
    const from = bot.entity.position.floored();
    const r = await runCmd(pick.cmd, pick.why, { selfTp: !!pick.selfTp });
    if (pick.cmd === 'sethome' && !r?.error) { I.homeSyncedAt = Date.now(); I.homeSyncedFor = `${h.center.x},${h.center.z}`; }
    if (pick.remember && !r?.error) I.returnTo = { pos: { x: from.x, y: from.y, z: from.z }, dim: dimNow(), at: Date.now() };
    if (pick.returned) I.returnTo = null;   // 成不成都只回一次，不来回传
    return { did: 'command' };
  }

  // ---- 家的范围随基地长大
  let builtIds = null;
  // ---- 家的范围随基地长大
  //
  // ⚠️ 这一段曾经是**同步**的一大坨（2026-09-28 修）：`findBlocks` 是同步函数，一次要逐格扫
  // 十几万到几百万格（基准见 modpack-study/fix6-20260928/bench-findblocks.js），
  // 4 次大扫描叠起来把整个事件循环堵住十几秒 —— 实机 `scheduler.lagMs` 每 5 分钟飙到 13.5~14 秒。
  // 现在：每个大扫描之间 `await yieldLoop()` 让出事件循环；扫描本身按**竖直分段**（小 maxDistance）
  // 拆成多轮，单轮同步占用控制在 50ms 以内。目标是"任何一个计时器回调单次同步 < 50ms"。
  const yieldLoop = () => new Promise(res => setImmediate(res));

  // 方块 id → 它在"人造方块名单"里。用 Set 而不是 Array.includes：逐格判定是热路径（几百万次）

  /**
   * 逐 **chunk 列**（16×16 的水平柱）扫人造方块 —— 2026-09-28 第 8 批真修。
   *
   * 为什么不是 `findBlocks`：它是**同步**函数，而且候选 section 是按八面体一层层往外扩的
   * （mineflayer/lib/plugins/blocks.js:164），maxDistance 越大层数越多、扫的 section 越多 ——
   * 批次 6 按距离拆成 32/64/91 三段，每段仍是**一次同步调用**，体积随半径三次方长，
   * 实机一条 `slow home.scanBuilt d=91 13049` = 单次同步 13 秒。
   *
   * 现在：把扫描拆成"一列一列"，列与列之间 `await yieldLoop()` 让出事件循环，
   * 单列的同步成本 = 列内 section 数 × 每 section 的逐格成本，和整圆半径无关。
   * 列内**先看 section.palette**：这节里一个目标 id 都没有就整节跳过（不逐格扫 4096 格）。
   *
   * @param {object} c        扫描中心（Vec3 形状即可：有 x/y/z）
   * @param {number[]} ids    目标方块 id 列表（人造方块名单）
   * @param {number} maxDist  水平半径（列的选择用圆柱，竖直范围另给）
   * @param {number} cap      最多返回几个（0 = 不限）
   * @param {object} [opts]
   * @param {number|null} [opts.minDist]  只扫这么远**之外**的列（家生长的前沿环带）；null/0 = 从中心开始
   * @param {number} [opts.dy]            竖直范围：|y - c.y| <= dy 才算（和原来的 filter 一致）
   * @param {string} [opts.label]         slow 日志里的名字
   * @returns {Promise<{pts: Array, sections: number, cells: number, columns: number, worstMs: number}>}
   */
  async function scanColumns (bot, c, ids, maxDist, cap = 0, opts = {}) {
    const r = await scanColumnsIn({ world: bot.world, registry: bot.registry, c, ids, maxDist, cap, opts, yieldFn: yieldLoop });
    if (r.worstMs > 200) slow(`${opts.label || 'home.scanColumns'} n=${r.pts.length}`, r.worstMs);
    return r;
  }
  let homeScanBusy = false;
  const homeTimer = setInterval(async () => {
    if (homeScanBusy) return;                             // 上一轮还没跑完（分列后可能跨多拍）：别叠
    try {
      const H = I.cfg.home; const h = I.home;
      // grow 只管“家的范围随基地长大”那一段；耕地干了 / 暗处提醒不受它影响（以前一起被挡掉）
      if (!h || !bot.entity) return;
      if (Date.now() - (I.lastHomeScan || 0) < H.everyMs) return;
      if (Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) > h.radius + H.near) return;   // 不在家附近：区块可能没加载，数不准
      homeScanBusy = true;
      I.lastHomeScan = Date.now();
      try {
        if (!builtIds) builtIds = Object.values(bot.registry.blocksByName).filter(b => deps.isPlayerBuilt?.(b.name) || /farmland/.test(b.name)).map(b => b.id);
        const { Vec3 } = require('vec3');
        const c = new Vec3(h.center.x, h.center.y, h.center.z);
        // ① 家的范围：每 30 分钟只扫**当前半径外的环带**（生长前沿），不再扫整个圆盘。
        //    理由：家里的方块上次已经数过，反复扫整个圆盘是 99% 的重复劳动（也是 13 秒冻结的来源）。
        //    环带 = 半径 (h.radius - 4) 之外、到 cap 为止；只要前沿还在长，半径就会继续涨，
        //    下一轮环带自然往外推（r-4 的重叠保证不会因为一格之差漏掉）。
        const geoR = Math.min(H.cap, h.radius + H.near);
        const band = { minDist: Math.max(0, Math.min(h.radius, geoR) - 4), dy: 16, label: 'home.scanRing' };
        const scan = H.grow ? await scanColumns(bot, c, builtIds, geoR, 4000, band) : { pts: [] };
        const pts = scan.pts;
        const r = H.grow ? homeFootprint(pts.map(p => Math.hypot(p.x - h.center.x, p.z - h.center.z)), h.radius, H) : h.radius;
        await yieldLoop();
        // ② 家里的耕地湿不湿（moisture=0 = 4 格内没水，会退化回泥土、庄稼长得慢）—— 只告诉 mind，不自己引水（会动主人的布局）
        //    半径封顶 32 + 分列扫描：以前用 findBlocks 一次同步扫 h.radius（最大 128）格半径的圆盘。
        const dryIds = ['farmland'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
        const dryScan = await scanColumns(bot, c, dryIds, Math.min(geoR, 32), 400, { dy: 16, label: 'home.scanFarmland' });
        const dryPts = dryScan.pts;
        // 每个点都要 blockAt 读 moisture：分段让出，别一次全读完
        const dry = [];
        for (let i = 0; i < dryPts.length; i++) {
          const b = bot.blockAt(dryPts[i]);
          if (b && +(b.getProperties?.().moisture ?? 7) === 0) dry.push(b);
          if ((i + 1) % 100 === 0) await yieldLoop();
        }
        const day = Math.floor(Date.now() / 86400000);
        if (dry.length && I.dryToldDay !== day) {
          I.dryToldDay = day;
          const p0 = dry[0].position;
          event('farmland_dry', `家里有 ${dry.length} 块耕地是干的（比如 ${p0.x},${p0.y},${p0.z}）：4 格内没有水，会退化回泥土、庄稼长得慢`, { count: dry.length });
        }
        await yieldLoop();
        // ③ 家里有没有暗处（光照 0 夜里会刷怪）—— 只告诉 mind，不自己插火把
        if (I.darkToldDay !== day) {
          const LIGHT_RE = /(^|:|_)(torch|lantern|glowstone|shroomlight|froglight|campfire|redstone_lamp|end_rod|candle|light)$/;
          const srcIds = Object.values(bot.registry.blocksByName).filter(b => LIGHT_RE.test(b.name) && !/redstone_torch|soul_torch_off/.test(b.name)).map(b => b.id);
          const srcScan = await scanColumns(bot, c, srcIds, Math.min(geoR, 32), 64, { dy: 8, label: 'home.scanLights' });
          const sourceLights = srcScan.pts.filter(p => Math.abs(p.y - h.center.y) <= 8).map(p => bot.blockAt(p)?.light);
          await yieldLoop();
          const airIds = ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
          const airScan = await scanColumns(bot, c, airIds, Math.min(h.radius, 32), 3000, { dy: 4, label: 'home.scanAir' });
          const airPts = airScan.pts;
          // cells 循环里每格要 3 次 blockAt：分段让出（原来一次性同步跑 3000 格）
          const cells = [];
          for (let i = 0; i < airPts.length; i++) {
            const p = airPts[i];
            if (Math.abs(p.y - h.center.y) <= 4) {
              const below = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
              if (below && below.boundingBox === 'block' && !/farmland|glass|leaves|slab|stairs|carpet|water|lava/.test(below.name)
                && head && head.boundingBox === 'empty') {
                cells.push({ pos: { x: p.x, y: p.y, z: p.z }, light: bot.blockAt(p)?.light });
              }
            }
            if ((i + 1) % 200 === 0) await yieldLoop();
          }
          const d = darkReport({ sourceLights, cells });
          if (d) {
            I.darkToldDay = day;
            if (d.kind === 'unreadable') I.lastDarkNote = '家里有光源，但亮度读出来都是暗的 —— 读不到亮度，不报暗处';
            else if (d.kind === 'no_source') event('dark_spot', '家里一个光源（火把、灯）都没看到，夜里整片都会刷怪', { count: cells.length });
            else event('dark_spot', `家里有 ${d.count} 格地面是全黑的（比如 ${d.sample.map(q => `${q.x},${q.y},${q.z}`).join(' / ')}），夜里会刷怪`, { count: d.count, sample: d.sample });
          }
        }
        if (r > h.radius + 2) {
          const old = h.radius;
          h.radius = r;
          event('home_grow', `家的范围跟着房子长大了：半径 ${old} → ${r} 格（环带扫到 ${pts.length} 块人造方块）`, { radius: r, center: h.center });
        }
      } finally { homeScanBusy = false; }
    } catch (_) { homeScanBusy = false; }
  }, 30000);

  // ---- 搭路 / 落地水：按身上的东西随时调寻路（有搭脚方块才搭路；有水桶才敢往下跳高）
  const policyTimer = setInterval(() => {
    try {
      const mv = bot.pathfinder?.movements;
      if (!mv || !bot.inventory || !deps.pathing) return;
      const names = new Set(bot.inventory.items().map(i => i.name));
      const nether = /nether/.test(String(bot.game?.dimension || ''));
      const drop = deps.pathing.setDropAllowance(mv, { water: I.cfg.mlg.enabled && names.has('water_bucket'), nether });
      let sc = { scaffolding: 0 };
      if (I.cfg.bridge.enabled && !state.noScaffoldDepth) {
        const ids = (deps.hands.scaffoldIds ? deps.hands.scaffoldIds() : deps.hands.SCAFFOLD_IDS).map(n => bot.registry.itemsByName[n.replace(/^minecraft:/, '')]?.id).filter(x => x != null);
        sc = deps.pathing.setScaffold(mv, { itemIds: ids, forbid: (p) => inHome(p) === true });
      } else deps.pathing.setScaffold(mv, {});
      // 寻路挖掘：只挖天然地形（白名单），家里不挖，紧挨人造方块不挖
      let dg = { mode: 'leavesOnly' };
      if (I.cfg.dig.enabled && deps.pathing.setDigPolicy) {
        dg = deps.pathing.setDigPolicy(mv, { naturalIds: naturalIds(), forbid: (p) => inHome(p) === true, builtNear });
      }
      I.movePolicy = { maxDrop: drop, scaffoldKinds: sc.scaffolding, scaffoldCount: mv.countScaffoldingItems?.() ?? null, homeGuard: !!I.home, dig: dg };
    } catch (_) {}
  }, 2000);

  // ---- 落地水反射（每个物理 tick）
  const M = { startY: null, placed: null, equipping: false, collecting: false };
  // "身上有没有水桶"缓存：physicsTick 每 50ms 跑一次，以前每次都遍历整个背包（物品多时白烧 CPU）。
  // 背包变化（mineflayer 的 window 插件在格子变动时发 updateSlot）才失效。读不到时就现算一次。
  let waterBucket = null;
  const hasWaterBucket = () => {
    if (waterBucket === null) waterBucket = bot.inventory.items().some(i => i.name === 'water_bucket');
    return waterBucket;
  };
  try { bot.inventory?.on?.('updateSlot', () => { waterBucket = null; }); } catch (_) {}
  const groundBelow = (p) => {
    const f = p.floored();
    for (let dy = 0; dy <= 40; dy++) {
      const b = bot.blockAt(f.offset(0, -dy, 0));
      if (!b) return null;
      if (/water/.test(b.name)) return { y: b.position.y + 1, water: true };
      if (b.boundingBox === 'block') return { y: b.position.y + 1, water: false, pos: b.position };
    }
    return null;
  };
  async function collectWater () {
    if (M.collecting || !M.placed) return;
    M.collecting = true;
    try {
      await sleepMs(250);
      const bucket = bot.inventory.items().find(i => i.name === 'bucket');
      if (bucket && bot.heldItem?.name !== 'bucket') await bot.equip(bucket, 'hand');
      const tgt = M.placed.pos;
      for (let k = 0; k < 3 && !bot.inventory.items().some(i => i.name === 'water_bucket'); k++) {
        await bot.lookAt(tgt.offset(0.5, 0.1, 0.5), true);
        bot.activateItem();
        await sleepMs(300);
      }
      const ok = bot.inventory.items().some(i => i.name === 'water_bucket');
      event('mlg', ok ? `从 ${Math.round(M.placed.fall)} 格高掉下来，落地前倒了水、又收回来了` : `从 ${Math.round(M.placed.fall)} 格高掉下来倒了水，但水没收回来（${tgt.x},${tgt.y},${tgt.z}）`);
    } catch (_) {} finally { M.placed = null; M.collecting = false; }
  }
  bot.on('physicsTick', () => {
    try {
      const e = bot.entity;
      if (!e || !I.cfg.mlg.enabled) return;
      if (e.onGround || e.isInWater || e.isInLava) {
        M.startY = null;
        if (M.placed && !M.collecting && (e.velocity?.y ?? 0) > -0.1) collectWater();
        return;
      }
      if (M.startY == null || e.position.y > M.startY) M.startY = e.position.y;
      const g = groundBelow(e.position);
      const act = mlgStep({
        startY: M.startY, y: e.position.y, vy: e.velocity?.y ?? 0, landY: g?.y ?? null, landIsWater: !!g?.water,
        hasBucket: hasWaterBucket(), holding: bot.heldItem?.name === 'water_bucket',
        nether: /nether/.test(String(bot.game?.dimension || '')), placed: !!M.placed,
      });
      if (act === 'equip' && !M.equipping) {
        M.equipping = true;
        const it = bot.inventory.items().find(i => i.name === 'water_bucket');
        bot.equip(it, 'hand').catch(() => {}).finally(() => { M.equipping = false; });
      } else if (act === 'place') {
        bot.look(e.yaw, -Math.PI / 2, true);   // 低头看正下方
        bot.activateItem();
        M.placed = { pos: g.pos.offset(0, 1, 0), fall: M.startY - g.y };
        state.ledger?.note({ route: 'mlg' });
      }
    } catch (_) {}
  });

  // ---- 赶路 / 干别的时候看见值钱的矿：不打断命令，告诉 mind（一个位置一次）
  const oreWatch = setInterval(() => {
    try {
      if (!bot.entity || !I.cfg.mine.enabled) return;
      if (!(I.inflight > 0 || (state.currentAction && !/^following /.test(state.currentAction)))) return;   // 闲着时采矿本能自己会去
      const T = loadTables();
      if (!T.ores.size) return;
      const pick = pickaxeTier(carriedNames(bot, state).names);   // 算上精妙背包里的镐子（N-9）
      for (const p of bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: 12, count: 16 })) {
        const b = bot.blockAt(p); if (!b || !oreVisible(b)) continue;   // 同一判据：露出一面也算看得见
        const row = T.ores.get(b.type);
        const isIron = (row.drops || []).some(d => /raw_iron|iron_ingot/.test(d));
        if (!(row.value === 'high' || (pick < TIER.iron && isIron))) continue;
        const k = `${p.x},${p.y},${p.z}`;
        if (I.told.has(`seen:${k}`)) continue;
        I.told.add(`seen:${k}`);
        event('ore_seen', `路上看见 ${row.name}（${k}）${pick >= needTier(row.tier) ? '' : `，不过要${TIER_NAME[needTier(row.tier)]}`}`, { ore: row.name, pos: { x: p.x, y: p.y, z: p.z } });
      }
    } catch (_) {}
  }, 2000);

  // ---- 随身物品：缺什么（告诉 mind）/ 回家整理
  const kitNow = () => {
    // 精妙背包里的也算"随身"（N-9）：镐子/吃的/火把在背包里时，不该报"身上没带够"。
    // 背包读不到就只算身上的（下面的 pack.free/has 本来就会说明"读不到"）。
    const tally = carriedTally(bot, state);
    const items = Object.entries(tally.have).map(([name, count]) => ({ name, count }));
    const short = deps.hands.kitShortfall(bot, items).filter(x => x.essential).map(x => x.label);
    // 家里箱子里记得有什么（开过的箱子，hands.noteSeen 记的）
    const homeItems = [];
    for (const c of state.seenContainers?.values?.() || []) {
      const [x, y, z] = String(c.key).split(',').map(Number);
      if (inHome({ x, y, z }) !== true) continue;
      for (const [name, count] of Object.entries(c.items || {})) homeItems.push({ name, count });
    }
    const atHomeHas = short.length ? deps.hands.kitAvailable(bot, homeItems, short) : [];
    // 精妙背包：背着就算一层"随身仓库"。里面有什么是上次打开时记的（不开看不到）
    let pack = null;
    if (deps.hands.wearingBackpack?.(bot, state)) {
      const bp = state.backpackSeen;
      const packItems = Object.entries(bp?.items || {}).map(([name, count]) => ({ name, count }));
      pack = { free: bp ? bp.slots - bp.used : null, readable: tally.readable, has: short.length ? deps.hands.kitAvailable(bot, packItems, short) : [] };
    }
    return { short, atHomeHas, homeKnown: homeItems.length > 0, pack };
  };
  const kitTimer = setInterval(() => {
    try {
      if (!bot.entity || !bot.inventory) return;
      const k = kitNow();
      const sig = k.short.join(',');
      if (sig === (I.kitSig ?? '')) return;
      I.kitSig = sig;
      if (!k.short.length) return;
      const have = [k.pack && !k.pack.readable ? '背包读不到（只算了身上的）' : null,
        k.pack?.has?.length ? `背包里有：${k.pack.has.join('、')}` : null,
        k.atHomeHas.length ? `家里箱子里有：${k.atHomeHas.join('、')}` : (k.homeKnown ? '家里的箱子里也没看到' : null)].filter(Boolean).join('；');
      event('kit_short', `身上没带够：${k.short.join('、')}${have ? `（${have}）` : ''}`, { short: k.short });
    } catch (_) {}
  }, CFG.tidy.checkMs);

  async function tryTidy (nightOut) {
    const TD = I.cfg.tidy;
    if (!TD.enabled || Date.now() - (I.lastTidyCheck || 0) < TD.checkMs) return null;
    I.lastTidyCheck = Date.now();
    const k = kitNow();
    const h = I.home;
    const pick = pickTidy({
      free: bot.inventory.emptySlotCount(), short: k.short, atHomeHas: k.atHomeHas,
      homeDist: h ? Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) : null,
      nightOut, sinceLast: Date.now() - (I.lastTidyAt || 0),
      pack: k.pack, sincePack: Date.now() - (I.lastPackAt || 0),
    }, TD);
    if (!pick.go) return pick;
    if (pick.where === 'backpack') {
      I.lastPackAt = Date.now();
      const { r, aborted } = await runJob('tidy', { route: 'POST /backpack/tidy' }, (abort) => deps.handlers['POST /backpack/tidy']({ abort }));
      note({ kind: 'backpack', why: pick.why, aborted: aborted || undefined, stashed: r?.stashed, took: r?.took, error: r?.error });
      if (!aborted && (r?.stashed || r?.took || r?.error)) {
        event('backpack', r?.error ? `想倒腾背包（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
          : `倒腾了一下背包：装进去 ${r.stashed} 组、拿出来 ${r.took} 组${r.backpackFree != null ? `（背包还剩 ${r.backpackFree} 格）` : ''}`);
      }
      return { did: 'backpack' };
    }
    I.lastTidyAt = Date.now();
    const { r, aborted } = await runJob('tidy', { route: 'POST /storage/organize' }, async (abort) => {
      if (inHome(bot.entity.position) !== true) {
        const g = await deps.handlers['POST /go']({ x: h.center.x, y: h.center.y, z: h.center.z, range: 3, abort });
        if (abort() || g?.arrived === false) return { error: `没走到家${g?.error ? `：${g.error}` : ''}` };
      }
      // 背着背包：先把背包里的倒出来一起整理（不然背包满了就永远满着，每次都白跑回家）。最多两轮
      let r = null; let unpacked = 0;
      const organizeArgs = storagePolicy.storageRequest(h, { abort, mode: 'daily' }, { discover: false });
      if (!organizeArgs.only?.length) return { error: '家里没有可自动整理的已登记箱子（还没登记，或都受保护）；不会猜哪些箱子能动' };
      for (let round = 0; round < 2 && !abort(); round++) {
        let u = null;
        if (deps.hands.wearingBackpack?.(bot, state)) {
          try { u = await deps.handlers['POST /backpack/tidy']({ stash: false, restock: false, unpack: true, abort }); } catch (_) {}
          unpacked += u?.unpacked || 0;
        }
        r = await deps.handlers['POST /storage/organize'](organizeArgs);
        if (!u?.unpacked) break;
      }
      return { ...r, unpacked };
    });
    const after = kitNow();
    note({ kind: 'tidy', why: pick.why, aborted: aborted || undefined, moved: r?.moved, error: r?.error });
    if (!aborted) {
      event('tidy', r?.error
        ? `想回家整理（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
        : `${r?.completed === false ? '回家整理了一部分' : '回家整理了'}（${pick.why}）：搬了 ${r?.moved ?? 0} 组${r?.unpacked ? `（其中从背包倒出来 ${r.unpacked} 组）` : ''}${after.short.length ? `；还缺 ${after.short.join('、')}` : '，该带的都带上了'}`,
      r?.boxes ? { storage: { completed: r.completed === true, boxes: r.boxes } } : {});
    }
    return { did: 'tidy' };
  }

  // ---- 转头看人（独立的小节拍：只转头，不占身体、不打断任何动作）
  //
  // 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
  // 所以这里**只对"刚和我互动过"的玩家**转头（窗口见 gazeEngaged）。窗口外 6 格内有人也不看。
  const engage = (player, ms) => {
    if (!player) return;
    try { I.gazeEngagedUntil.set(String(player), Date.now() + ms); } catch (_) {}
  };
  let nextGaze = 0;
  const lookAtPlayer = (ent) => {
    try { bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true); } catch (_) {}
  };
  const idleEyes = () => !I.running && !I.inflight && !bot.isSleeping && !bot.currentWindow && !bot.pathfinder?.isMoving?.() && !bot.targetDigBlock;
  const gazeTimer = setInterval(() => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity || !idleEyes()) return;
      // 过期窗口定期清掉，Map 不无限长
      const now = Date.now();
      for (const [k, at] of I.gazeEngagedUntil) if (now >= +at) I.gazeEngagedUntil.delete(k);
      const players = Object.values(bot.players || {}).filter(p => p.entity && p.entity !== bot.entity).map(p => ({ name: p.username, ent: p.entity, pos: p.entity.position }));
      const g = pickGaze({ players, self: bot.entity.position, now, next: nextGaze, engagedUntil: I.gazeEngagedUntil }, G);
      if (!g) return;
      lookAtPlayer(g.ent);
      nextGaze = now + G.minGapMs + Math.random() * (G.maxGapMs - G.minGapMs);
    } catch (_) {}
  }, 1000);
  // 他跟她说话 → 立刻看一眼，并在 G.talkMs 内保持"可以看他"
  bot.on('chat', (username) => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || username === bot.username) return;
      const ent = bot.players[username]?.entity;
      if (!ent || ent.position.distanceTo(bot.entity.position) > G.chatRadius) return;
      engage(username, G.talkMs);
      if (!idleEyes()) return;
      lookAtPlayer(ent);
      nextGaze = Date.now() + G.maxGapMs;
    } catch (_) {}
  });
  /**
   * 她自己开口说话（bridge 的 `POST /chat` 调）—— 对 16 格内**最近的玩家**开一个 selfTalkMs 的互动窗口。
   * 她刚说完话，看的是"在听她说话的人"，不一定是最近的谁；只有一个玩家时就是他。
   */
  I.noteSelfSpoke = () => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity) return null;
      const near = Object.values(bot.players || {})
        .filter(p => p.entity && p.entity !== bot.entity)
        .map(p => ({ name: p.username, ent: p.entity, d: p.entity.position.distanceTo(bot.entity.position) }))
        .filter(p => p.d <= G.chatRadius)
        .sort((a, b) => a.d - b.d);
      if (!near.length) return null;
      engage(near[0].name, G.selfTalkMs);
      return near[0].name;
    } catch (_) { return null; }
  };

  // ---- 工具快坏了：告诉 mind（一件只说一次；修好 / 换了新的再坏会再说）
  const toolTimer = setInterval(() => {
    try {
      for (const it of bot.inventory.items()) {
        const w = toolWorn({ name: it.name, durabilityUsed: it.durabilityUsed, maxDurability: it.maxDurability, enchanted: (it.enchants || []).length > 0 });
        const k = `${it.name}@${it.slot}`;
        if (!w) { I.toolWarned?.delete(k); continue; }
        I.toolWarned ||= new Set();
        if (I.toolWarned.has(k)) continue;
        I.toolWarned.add(k);
        event('tool_worn', `${it.name} 快坏了（还剩 ${w.left}/${w.max}）${(it.enchants || []).length ? '，有附魔，别用断了' : ''}`, { item: it.name });
      }
    } catch (_) {}
  }, CFG.toolWarn.everyMs);

  // ================================================================ 战斗
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  bot.on('entityDead', (e) => { try { if (I.combat?.engaged.has(e.id)) I.combat.killed.push(e.name); } catch (_) {} });

  /** 现在有哪些对她 / 对玩家有仇恨的目标（带类别、距离） */
  function hostileTargets () {
    const self = bot.entity;
    const out = [];
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === self || e.type === 'player' || deps.isDropEntity(e)) continue;
      const dist = e.position.distanceTo(self.position);
      if (dist > I.cfg.combat.detect + 4) continue;
      const a = deps.aggroOf(e);
      // 静态敌对实体（例如刚刷出的、还没挥拳的僵尸）没有 aggro 记录，
      // 但仍然应该进入战斗本能的视野；aggro 只负责补充“正在打谁”的证据。
      if (!a && !isHostileEntity(e)) continue;
      out.push({ id: e.id, ent: e, name: e.name, pos: e.position, dist, on: a?.on || null, evidence: a?.evidence || 'visible_hostile', kind: mobKind(e.name, e.equipment?.[0]?.name) });
    }
    return out;
  }

  async function equipForFight () {
    try {
      const inv = bot.inventory.items().map(i => i.name);
      const pick = deps.pickAutoEquip?.({ held: bot.heldItem?.name ?? null, inventory: inv, want: 'weapon' });
      if (pick?.itemName && pick.itemName !== bot.heldItem?.name) {
        const it = bot.inventory.items().find(i => i.name === pick.itemName);
        if (it) await bot.equip(it, 'hand');
      }
      // 盾：放到副手（有的话）
      if (!/shield/.test(bot.inventory.slots[45]?.name || '')) {
        const sh = bot.inventory.items().find(i => /shield/.test(i.name));
        if (sh) await bot.equip(sh, 'off-hand');
      }
    } catch (_) {}
    return /shield/.test(bot.inventory.slots[45]?.name || '');
  }

  async function fight (first) {
    const C = I.cfg.combat;
    const { goals } = require('mineflayer-pathfinder');
    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    // 手上有命令 / 在做别的本能：叫停，先打；先停止移动，再等旧动作清理
    if (I.running && I.running.kind !== 'combat') { const old = I.running; old.abort(); if (!await settleJob(old)) { I.last = { t: Date.now(), skip: '战斗等待旧本能收尾' }; return; } }
    if (ended || I.urgent !== 'combat') return;
    const interrupted = I.inflight > 0 || (state.currentAction && !followName) ? (state.currentAction || '一个命令') : null;
    if (I.inflight > 0 || state.currentAction) deps.cancelCommands?.(`战斗本能：${first.name} ${first.on ? (first.on === 'me' ? '冲她来了' : `在打 ${first.on}`) : '在附近'}`);
    const anchorAt = () => (followName ? bot.players[followName]?.entity?.position : null) || I.combat.anchor;
    I.combat = { anchor: bot.entity.position.clone(), engaged: new Set(), killed: [], started: Date.now(), followName, hp0: bot.health };
    const hasShield = await equipForFight();
    if (ended || I.urgent !== 'combat') return;
    let lastSeen = Date.now(); let lastHit = 0; let shieldUp = false; let lastMode = null; let lastTargetId = null;
    const shield = (up) => { if (up === shieldUp) return; shieldUp = up; try { up ? bot.activateItem(true) : bot.deactivateItem(); } catch (_) {} };
    let aborted = false;
    const job = (async () => {
      while (!aborted && Date.now() - I.combat.started < C.maxMs) {
        const targets = hostileTargets();
        const a = anchorAt();
        const plan = combatPlan({ targets, hp: (bot.health ?? 20) - (I.effectHpCost || 0), hasShield, anchor: a ? { x: a.x, y: a.y, z: a.z } : null }, C);
        if (!plan) {
          shield(false);
          if (Date.now() - lastSeen > C.loseMs) break;
          if (lastMode) { try { bot.pathfinder.setGoal(null); } catch (_) {} lastMode = null; }
          await sleepMs(C.loopMs); continue;
        }
        lastSeen = Date.now();
        const t = plan.target; const ent = targets.find(x => x.id === t.id)?.ent;
        if (!ent) { await sleepMs(C.loopMs); continue; }
        I.combat.engaged.add(ent.id);
        const modeKey = `${plan.mode}:${ent.id}`;
        if (plan.mode === 'retreat' || plan.mode === 'avoid') {
          shield(false);
          if (modeKey !== `${lastMode}:${lastTargetId}`) {
            bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(ent, plan.keep || 16)), true);
            if (plan.mode === 'retreat' && lastMode !== 'retreat') event('combat_retreat', `血只剩 ${bot.health}，先从 ${ent.name} 身边跑开`);
          }
          I.combat.retreating = plan.mode === 'retreat';
          // 跑着还在掉血、血到底了：服务器给了 /home 或 /spawn 就传走（指令本能）
          if (plan.mode === 'retreat' && typeof tryCommand === 'function') { const c = await tryCommand(false); if (c?.did) { aborted = true; break; } }
        } else {
          if (modeKey !== `${lastMode}:${lastTargetId}`) bot.pathfinder.setGoal(new goals.GoalFollow(ent, 2), true);
          const dist = ent.position.distanceTo(bot.entity.position);
          const cd = attackCooldownMs(bot.heldItem?.name);
          if (dist <= C.reach && Date.now() - lastHit >= cd) {
            shield(false);
            try { await bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.8, 0), true); } catch (_) {}
            try { bot.attack(ent); lastHit = Date.now(); } catch (_) {}
          } else if (plan.mode === 'shield' && dist <= 10) {
            shield(true);   // 举着盾贴过去；挥之前放下（上面那支）
          }
        }
        lastMode = plan.mode; lastTargetId = ent.id;
        await sleepMs(C.loopMs);
      }
    })();
    const mine = {
      kind: 'combat',
      abort: () => { aborted = true; try { bot.pathfinder.setGoal(null); } catch (_) {} },
      done: job,
    };
    I.running = mine;
    // ⚠️ 2026-09-28 审计（codex fix0 #4）：**路径目标清理也要认 owner**。
    //    原来 `finally` 里无条件 `bot.pathfinder.setGoal(null)` —— 战斗被叫停、
    //    等旧动作超时、新命令已经接管身体时，旧战斗的 `finally` 仍会跑，
    //    把**新命令的**寻路目标一起清掉（新命令刚 setGoal 完就发现自己没目标了）。
    //    `I.running === mine` 只保住了"标记"，保不住"寻路目标" —— 两者要同一个判据。
    //    判据抽成纯函数 `ownsBodyAtCleanup`（有独立自测），"标记清理"和"目标清理"
    //    走**同一句**判断，不会再分叉。
    try { await job; } catch (_) {} finally {
      shield(false);
      if (ownsBodyAtCleanup(I, mine)) {
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        I.running = null;   // 只清自己的（打断后新任务可能已经占上了）
      }
    }
    const cb = I.combat;
    const names = [...new Set(cb.killed)];
    event('combat', `${interrupted ? `（打断了：${interrupted}）` : ''}打完了${names.length ? `：打死 ${cb.killed.length} 只（${names.join('、')}）` : '（没打死，怪跑了或者够不着）'}，血 ${cb.hp0} → ${bot.health}${aborted ? '，被叫停' : ''}`, { killed: cb.killed });
    note({ kind: 'combat', killed: cb.killed.length, hp: bot.health, aborted: aborted || undefined });
    // 回位交给普通本能；战斗扫描立即恢复，不在回程的 15 秒里失明。
    if (aborted) return;
    if (followName && bot.players[followName]?.entity) { try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {} return; }
    if (cb.anchor && bot.entity.position.distanceTo(cb.anchor) > 3) I.returnAfterCombat = cb.anchor;
  }

  // 战斗的"眼睛"：比别的本能快（250ms），不等身体空闲 —— 紧急本能可抢身体
  let fighting = false;
  const checkCombat = createCheck('combat', async (d) => {
    if (ended || !state.connected || !bot.entity || !I.cfg.combat.enabled) { d.skip = '未就绪或已关闭'; return; }
    if (fighting || I.urgent) { d.skip = '紧急动作正在执行'; return; }
    if (sleeping()) { d.skip = '正在睡觉'; return; }
    if (I.running?.kind === 'combat') return;
    try {
      const targets = hostileTargets();
      d.targets = targets.length;
      if (!targets.length) { d.skip = '没有可见敌对目标'; return; }
      const plan = combatPlan({ targets, hp: (bot.health ?? 20) - (I.effectHpCost || 0), hasShield: /shield/.test(bot.inventory.slots[45]?.name || '') || bot.inventory.items().some(i => /shield/.test(i.name)), anchor: null }, I.cfg.combat);
      if (!plan) return;
      fighting = true;
      I.urgent = 'combat';
      // 有确证的敌人时先关闭容器，不能因为开着箱子一直挨打。
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      event('combat_start', `发现 ${plan.target.name}${plan.target.on ? `正在攻击${plan.target.on === 'me' ? '她' : plan.target.on}` : '在附近'}，立即接管`, { source: d.source });
      await fight(plan.target);
    } catch (e) { I.last = { t: Date.now(), error: `combat: ${e.message}` }; } finally { fighting = false; if (I.urgent === 'combat') I.urgent = null; }
  }, I.diagnostics);
  const combatTimer = setInterval(() => checkCombat(), CFG.combat.scanMs);

  // ---- 身上的效果（读不到 = null，不猜）：minecraft-data 的名字 'Poison' 'Wither' …
  const effectNames = () => {
    const eff = bot.entity?.effects;
    if (!eff || typeof eff !== 'object') return null;
    return Object.values(eff).map(e => bot.registry.effects?.[e.id]?.name).filter(Boolean);
  };
  I.effectNames = effectNames;

  // ---- 吃（主人 2026-09-27：饥饿条掉 2 格就吃）
  let eating = false;
  const checkEat = createCheck('eat', async (d) => {
    if (ended || !state.connected || !I.cfg.eat.enabled || eating || !bot.entity || sleeping() || I.urgent) return;
    const hasFood = bot.inventory.items().some(i => deps.hands.foodScore(i) > 0);
    const busy = bodyBusy({ inflight: I.inflight, currentAction: state.currentAction, windowOpen: false, quietUntil: 0 }) || (I.running && I.running.kind !== 'combat' ? `本能在做 ${I.running.kind}` : null);
    const pick = pickEat({ food: bot.food, busy, fighting, windowOpen: !!bot.currentWindow, eating, hasFood, failUntil: I.eatFailUntil || 0 }, I.cfg.eat);
    d.skip = pick?.skip || (pick?.eat ? null : '还不饿');
    if (!pick?.eat) {
      if (pick?.skip === '身上没有吃的' && bot.food <= I.cfg.eat.urgentAt && Date.now() - (I.hungryToldAt || 0) > 600000) {
        I.hungryToldAt = Date.now();
        event('hungry', `饿了（饥饿 ${bot.food}/20），身上没有吃的`);
      }
      return;
    }
    eating = true;
    try {
      const r = await deps.handlers['POST /eat']({});
      if (r?.ate) note({ kind: 'eat', item: r.item, from: r.foodBefore, to: r.foodAfter, urgent: pick.urgent || undefined });
      else I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
    } catch (e) {
      I.eatFailUntil = Date.now() + I.cfg.eat.failCooldownMs;
      event('eat_failed', `想吃东西没吃成：${String(e.message).slice(0, 80)}`);
    } finally { eating = false; }
  }, I.diagnostics);
  const eatTimer = setInterval(() => checkEat(), CFG.eat.checkMs);

  // ---- 憋气：头在水里、氧气快没了 → 叫停命令，一直跳上去（寻路算不出水下的路，跳最快）
  let breathing = false;
  const checkBreath = createCheck('breathe', async (d) => {
    if (ended || !state.connected || !I.cfg.breathe.enabled || breathing || !bot.entity) return;
    if (I.urgent && I.urgent !== 'combat') return;
    if (fighting && I.running?.kind !== 'combat') return; // 战斗装备/收尾期间先等它进入可取消阶段
    const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
    const headInWater = !!head && (/water|bubble_column/.test(head.name) || head.getProperties?.().waterlogged === true);
    const eff = effectNames();
    if (!needBreath({ oxygen: bot.oxygenLevel ?? null, headInWater, waterBreathing: !!eff?.includes('WaterBreathing') }, I.cfg.breathe)) return;
    breathing = true;
    I.urgent = 'breathe';
    try {
      if (I.running) I.running.abort();
      deps.cancelCommands?.('憋不住气了，先上去换气');
      if (Date.now() - (I.breathToldAt || 0) > 20000) { I.breathToldAt = Date.now(); event('breathe', `在水里憋不住气了（氧气 ${bot.oxygenLevel}/20），先游上去换气`); }
      const old = I.running;
      // 保命不能等：旧动作 800ms 内没收尾也照样往上跳（它已经被 abort、寻路目标也清了；以前这里 return，下一拍再等，会一直等到淹死）
      const settled = await settleJob(old);
      if (ended || I.urgent !== 'breathe') return;
      // ⚠️ 2026-09-28 审计（codex fix0 #5）：**强制上浮也要有自己的 owner**。
      //    原来旧动作没收尾时走 `{ r: await jump(() => ended) }` —— 直接调 handler，
      //    **绕过 runJob**：上浮期间 `I.running` 还挂在**旧** job 上（甚至一直是 null），
      //    于是没有 owner 管它，旧 job 的 finally 也可能在并行清理状态。
      //    现在统一经 `runJob('breathe', ...)`：上浮自己成为当前 `I.running` owner，
      //    旧 job 的 finally 里"只清自己"的判据（`I.running === mine`）就会放行、
      //    不再与新上浮抢状态。`settled` 只用来标记"这次是强制的"（诊断用），
      //    两种情形走同一条有 owner 的路径。
      //
      //    ⚠️⚠️ 2026-09-28 二轮审计（wbR2 新发现，高）：**runJob 自己会把这次上浮拒掉**。
      //      `runJob` 开头写着 `if (ended || (I.urgent && I.urgent !== kind)) return
      //      { r: { error: '已让出身体给紧急本能' }, aborted: true }` —— 它假设
      //      "`I.urgent` 有值但不是我自己 ⇒ 有别的事在急"。而憋气这条恰恰是
      //      **先 `I.urgent = 'breathe'`、再 `runJob('breathe')`**，看着能对上；
      //      但 `I.urgent` 是**共享字段**，`yieldBody`（命令来了）和战斗的 `finally`
      //      都会把它清成别的值/null：只要在 `settleJob(old)` 这 800ms 窗口里
      //      来过一条 `COMBAT_YIELD` 类命令，`I.urgent` 就被清成 `null`，
      //      再晚一点气泡/战斗把它设成别的值，`runJob` 就**直接早退、一跳都不跳**。
      //      早退分支在 `I.running = job` **之前**，所以这次上浮连 owner 都没拿到，
      //      旧 job 反而可能还占着 `I.running` —— 淹死的路径就回来了（只是从
      //      "绕过 runJob"换成了"被 runJob 拒绝"）。
      //      **保命动作不能有一条"条件不满足就静默不跳"的路径**：早退/出错都
      //      必须照样把这一下跳完。所以这里显式检查 `aborted`/`r.error`，
      //      被拒就**直接调 handler**（不带 owner 也比淹死强 —— 宁可有竞态也不要溺水）。
      if (!settled) d.forced = true;
      let { r, aborted: bAborted } = await runJob('breathe', null, (abort) =>
        deps.handlers['POST /jump']({ durationMs: I.cfg.breathe.jumpMs, stopAtOxygen: 18, abort }));
      if (breatheRefused({ r, aborted: bAborted })) {
        // 被 runJob 拒了（urgent 被别人占了 / ended）。保命优先：直接跳。
        d.refused = r?.error || 'aborted';
        try {
          r = await deps.handlers['POST /jump']({ durationMs: I.cfg.breathe.jumpMs, stopAtOxygen: 18 });
          bAborted = false;
        } catch (e2) { I.last = { t: Date.now(), error: `breathe 兜底也失败: ${e2.message}` }; }
      }
      note({ kind: 'breathe', forced: d.forced || undefined, refused: d.refused, oxygen: r?.oxygen, jumped: r?.jumped });
      I.breathedAt = Date.now();
    } catch (e) { I.last = { t: Date.now(), error: `breathe: ${e.message}` }; } finally { breathing = false; if (I.urgent === 'breathe') I.urgent = null; }
  }, I.diagnostics);
  const breathTimer = setInterval(() => checkBreath(), CFG.breathe.checkMs);

  // ---- 上岸：身体空着泡在水里 → 走到最近的陆地（刚上浮换完气也算）
  let inWaterSince = 0;
  const shoreTimer = setInterval(async () => {
    const S = I.cfg.shore;
    if (!S.enabled || !bot.entity || bot.vehicle || fighting || breathing || I.urgent || I.running) return;
    const feet = bot.blockAt(bot.entity.position.floored());
    const wet = !!bot.entity.isInWater || /water|bubble_column/.test(feet?.name || '');
    if (!wet) { inWaterSince = 0; return; }
    if (!inWaterSince) inWaterSince = Date.now();
    const justBreathed = Date.now() - (I.breathedAt || 0) < 10000;
    if (!justBreathed && Date.now() - inWaterSince < S.afterMs) return;
    if (Date.now() < (I.shoreRetryAt || 0)) return;
    if (bodyBusy({ inflight: I.inflight, currentAction: state.currentAction, windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil })) return;
    I.shoreRetryAt = Date.now() + S.retryMs;
    const me = bot.entity.position.floored();
    // 由近到远一圈一圈找（第 1 圈、第 2 圈…到 radius）：找到第一圈里有能站的格子就停，
    // 只把那一圈交给 pickShore 挑。判据不变（place.isStandable + pickShore），只是不再一口气扫 3750 格。
    let pick = null; let scanned = 0; let rings = 0;
    for (let k = 0; k <= S.radius && !pick; k++) {
      const cells = [];
      for (const o of shoreRingOffsets(k)) {
        scanned++;
        const p = me.offset(o.dx, o.dy, o.dz);
        const f = bot.blockAt(p); if (!f || /water/.test(f.name)) continue;
        const b = bot.blockAt(p.offset(0, -1, 0)); if (!b || b.boundingBox !== 'block') continue;
        const h = bot.blockAt(p.offset(0, 1, 0));
        cells.push({ pos: p, below: b.name, feet: f.name, head: h?.name, ok: require('./place').isStandable(f) && require('./place').isStandable(h) });
      }
      rings = k + 1;
      if (cells.length) pick = pickShore(cells, me);   // 这一圈里有可站的 → 就在这圈挑
    }
    if (!pick) { note({ kind: 'shore', skip: `${S.radius} 格内没找到能上的岸`, rings, scanned }); return; }
    const { r, aborted } = await runJob('shore', null, (abort) => deps.handlers['POST /go']({ x: pick.pos.x, y: pick.pos.y, z: pick.pos.z, range: 1, maxMs: 20000, abort }));
    const dry = !bot.entity.isInWater && !/water/.test(bot.blockAt(bot.entity.position.floored())?.name || '');
    note({ kind: 'shore', to: pick.pos, ok: dry, aborted: aborted || undefined, error: r?.error });
    if (dry) { inWaterSince = 0; event('shore', `从水里上岸了（${pick.pos.x},${pick.pos.y},${pick.pos.z}）`); }
  }, CFG.shore.checkMs);

  // ---- 中毒 / 凋零
  let drinking = false;
  const effectTimer = setInterval(async () => {
    if (!I.cfg.effects.enabled || drinking || !bot.entity) return;
    const eff = effectNames();
    const hasMilk = bot.inventory.items().some(i => i.name === 'milk_bucket');
    const plan = effectPlan({ effects: eff, hp: bot.health ?? 20, hasMilk }, I.cfg.effects);
    I.effectHpCost = plan?.hpCost || 0;
    const key = plan ? plan.bad.join('+') : '';
    if (key && key !== I.effectTold) event('effect', `中了${plan.bad.map(b => ({ Poison: '毒', Wither: '凋零' }[b])).join('和')}（血 ${Math.round(bot.health ?? 0)}）${hasMilk ? '' : '，身上没有牛奶'}`, { effects: plan.bad });
    I.effectTold = key;
    if (!plan?.milk || bot.currentWindow || fighting || I.urgent || eating || I.running || I.inflight) return;
    drinking = true;
    try {
      const milk = bot.inventory.items().find(i => i.name === 'milk_bucket');
      await bot.equip(milk, 'hand');
      await bot.consume();
      await new Promise(res => setTimeout(res, 300));
      const left = effectNames() || [];
      const cleared = !plan.bad.some(b => left.includes(b));
      event('effect_milk', cleared ? '喝了牛奶，毒解了' : '喝了牛奶，但效果还在（可能读不准）');
    } catch (e) { event('effect_milk', `想喝牛奶解毒没成：${String(e.message).slice(0, 60)}`); } finally { drinking = false; }
  }, CFG.effects.checkMs);

  // ---- 天气
  I.weather = { rain: !!bot.isRaining, thunder: !!bot.isRaining && (bot.thunderState ?? 0) > 0 };
  const onWeather = () => {
    if (!I.cfg.weather.enabled) return;
    const now = { rain: !!bot.isRaining, thunder: !!bot.isRaining && (bot.thunderState ?? 0) > 0 };
    const ch = weatherChange(I.weather, now);
    I.weather = now;
    if (ch) event('weather', ch.text, { weather: ch.kind });
  };
  bot.on('rain', onWeather);
  bot.on('weatherUpdate', onWeather);

  // ---- 玩家挨打：告诉 mind（打人的怪战斗本能本来就会打，这里只是让她"知道"）
  const hurtTold = new Map();
  bot.on('entityHurt', (victim, source) => {
    try {
      const H = I.cfg.playerHurt;
      if (!H.enabled || victim?.type !== 'player' || victim === bot.entity || !victim.username) return;
      if (source?.type === 'player') return;   // 玩家之间闹着玩不归本能管
      if (!bot.entity || victim.position.distanceTo(bot.entity.position) > H.radius) return;
      if (Date.now() - (hurtTold.get(victim.username) || 0) < H.quietMs) return;
      hurtTold.set(victim.username, Date.now());
      const dist = Math.round(victim.position.distanceTo(bot.entity.position));
      event('player_hurt', `${victim.username} 挨打了${source?.name ? `（${source.name}）` : '（摔的、烧的或者看不见的东西）'}，离她 ${dist} 格`, { player: victim.username, by: source?.name || null });
    } catch (_) {}
  });

  const checkHazard = createCheck('hazard', async (d) => {
    if (ended || !state.connected || !bot.entity || I.urgent || sleeping()) return;
    const plan = stepOffPlan();
    if (!plan) { d.skip = '脚下安全'; return; }
    if (!plan.to) { d.skip = `${plan.why}，没有安全落脚点`; return; }
    I.urgent = 'stepoff';
    try {
      const old = I.running;
      if (old) old.abort();
      deps.cancelCommands?.(`危险方块：${plan.why}，先退开`);
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      // 等旧动作真正收尾，避免旧 finally 清掉新的寻路。
      if (!await settleJob(old)) { d.skip = '等待旧本能收尾'; return; }
      if (ended || I.urgent !== 'stepoff') return;
      await tryStepOff();
    } finally { if (I.urgent === 'stepoff') I.urgent = null; }
  }, I.diagnostics);
  const hazardTimer = setInterval(() => checkHazard(), 250);

  async function tick () {
    const skip = ended || !state.connected ? '已断线或等待出生' : !bot.entity ? '等待实体' : sleeping() ? '正在睡觉'
      : I.urgent ? `紧急动作：${I.urgent}` : I.running ? `本能在做：${I.running.kind}` : fighting ? '正在战斗' : null;
    if (skip) { I.last = { t: Date.now(), skip }; return; }
    const P = I.cfg.pickup;
    const busy = bodyBusy({
      inflight: I.inflight, currentAction: state.currentAction,
      windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil,
    });
    if (eating || drinking || breathing) { I.last = { t: Date.now(), skip: '正在吃喝或换气' }; return; }
    if (busy) { I.last = { t: Date.now(), skip: busy }; return; }
    if (I.returnAfterCombat) {
      const pos = I.returnAfterCombat;
      I.returnAfterCombat = null;
      await runJob('combatReturn', null, (abort) => deps.handlers['POST /go']({ x: pos.x, y: pos.y, z: pos.z, range: 1, maxMs: 15000, abort }));
      return;
    }
    // 换护甲放在"有怪盯着"和"血少"之前：被盯上时正是该穿好的时候（WorkBuddy 建议 17，Claude 核实）
    const ar = await tryArmor();
    if (ar?.did) { I.last = { t: Date.now(), armor: '做了' }; return; }
    if ((bot.health ?? 20) < P.minHealth) { I.last = { t: Date.now(), skip: `血 ${bot.health}，不弯腰` }; return; }
    const danger = threatened();
    if (danger) { I.last = { t: Date.now(), skip: danger }; return; }

    // ⓪' 死后回去捡东西（掉落物 5 分钟就没了，比什么都急）
    const rc = await tryRecover();
    if (rc?.did) { I.last = { t: Date.now(), recover: '做了' }; return; }

    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    const followEnt = followName ? bot.players[followName]?.entity : null;
    let nightOut = false;
    try {
      const ph = deps.night?.phaseOf(bot.time?.timeOfDay);
      nightOut = (ph === 'night' || ph === 'dusk' || !!I.weather?.thunder) && deps.night.isOut(deps.exposureOf(bot)?.kind);   // 打雷时白天也刷怪
    } catch (_) {}
    const now = Date.now();
    const last = {};
    // 掉落物清单：① 的近距离拾取和末尾的远处拾取共用一份（都只是把地上的实体读出来）
    const dropList = () => Object.values(bot.entities)
      .filter(e => e?.position && e.isValid !== false && deps.isDropEntity(e))
      .map(e => {
        const sp = spawned.get(e.id);
        // 本能装上之前就在地上的：没有刷出记录，当作早就落地、不是扔的
        return {
          id: e.id, pos: e.position, ageMs: sp ? now - sp.t : Infinity, thrower: sp ? sp.thrower : null,
          item: deps.droppedItemOf(e)?.name ?? null,
          visible: readVisible(e),   // 远处拾取要看"看不看得见"；读不到给 null（当未知，不远去）
        };
      });

    // ① 拾取（掉落物 5 分钟就没了，最先）
    if (P.enabled) {
      const drops = dropList();
      // 夜里在露天：半径收到脚边
      const cfg = nightOut ? { ...P, radius: Math.min(P.radius, P.nightOutRadius), followRadius: Math.min(P.followRadius, P.nightOutRadius) } : P;
      const pick = pickPickup({ self: bot.entity.position, drops, fails, canHold, now, following: followEnt ? { pos: followEnt.position } : null }, cfg);
      last.pickup = pick.skip || `捡 ${pick.ids.length} 堆`;
      if (pick.ids) { I.last = { t: now, ...last }; await runPickup(pick.ids, followName); return; }
    }
    // 跟着人走。2026-09-28 第 8 批 第 6 条：以前这里无条件 `return`，
    // 于是"跟着 X"期间她只会捡东西 —— 人站着不动（挂机看背包）她也跟着干站着。
    // 现在：他**站着不动超过 idleMs（默认 8 秒）**时，允许就地做点"顺手的事"
    // （插火把 / 挖看得见的矿 / 开看得见的箱子）；他一动（followIdlePlan 返回 null）立刻回到"只捡东西"。
    if (followName) {
      let idle = null;
      if (followEnt) {
        const prev = I.followSeen?.name === followName ? I.followSeen.pos : null;
        const movedNow = prev ? Math.hypot(followEnt.position.x - prev.x, followEnt.position.y - prev.y, followEnt.position.z - prev.z) : 0;
        if (prev && movedNow > 0.35) I.followMovedAt = now;              // 他在动 → 刷新"动过"的时刻
        if (!I.followMovedAt) I.followMovedAt = now;                     // 第一次见到：先记下
        I.followSeen = { name: followName, pos: { x: followEnt.position.x, y: followEnt.position.y, z: followEnt.position.z } };
        idle = followIdlePlan({ now, idleMs: I.cfg.follow.idleMs, lastPos: prev, pos: followEnt.position, movedAt: I.followMovedAt });
      } else {
        I.followSeen = null; I.followMovedAt = 0;
      }
      if (!idle) { I.last = { t: now, ...last, other: `跟着 ${followName}，只捡东西` }; return; }
      // 他站着不动：顺手的事按"最急"排 —— 插火把（防刷怪）→ 挖看得见的矿 → 开看得见的箱子。
      // 都离她/他不远（follow.reach / 采集本能自己的半径）。做完一件就回 tick，下一拍再看他还动没动。
      last.follow = `${followName} 站着不动 ${(idle.idleMs / 1000).toFixed(0)}s，顺手做点事`;
      const tf = await tryTorch();
      if (tf?.did) { I.last = { t: now, ...last, torch: '做了' }; return; }
      const tm = await tryMine({ pos: followEnt.position });
      if (tm?.did) { I.last = { t: now, ...last, mine: '做了' }; return; }
      if (tm?.skip) last.mine = tm.skip;
      const tl = await tryLoot(nightOut);
      if (tl?.did) { I.last = { t: now, ...last, loot: '做了' }; return; }
      if (tl?.skip) last.loot = tl.skip;
      I.last = { t: now, ...last }; return;
    }
    I.followSeen = null; I.followMovedAt = 0;
    // ② 夜里在家就睡（在自家院子的露天处也算 —— 所以放在"夜里露天不做事"之前）
    const sl = await trySleep();
    if (sl?.did) { I.last = { t: now, ...last, sleep: '做了' }; return; }
    if (sl?.skip) last.sleep = sl.skip;
    // ②' 需要的时候用命令（设 /sethome、夜里离家太远 /home）
    const cm = await tryCommand(nightOut);
    if (cm?.did) { I.last = { t: now, ...last, command: '做了' }; return; }
    // ③ 回家整理（背包快满 / 缺吃的缺镐子而家里有）—— 夜里家近也回
    const td = await tryTidy(nightOut);
    if (td?.did) { I.last = { t: now, ...last, tidy: '做了' }; return; }
    if (td?.skip) last.tidy = td.skip;
    if (nightOut) { I.last = { t: now, ...last, other: '夜里在露天，不收不挖' }; return; }

    // ④ 收获  ⑤ 开宝箱 / 进建筑  ⑥ 采矿  ⑦ 换护甲
    // ⑧ 洞穴探险（最后：先把看得见的矿挖了、箱子开了，再往里走）
    // ★ 插火把放在最前：地下暗处会刷怪，比收获更该先做（第 8 批第 4 条）。身体空着才轮到它。
    // ★ delve 续挖排在采矿**之后**：先挖脚边看得见的矿（收获最快），再接着往洞里走。
    for (const [k, f] of [['torch', tryTorch], ['harvest', tryHarvest], ['loot', () => tryLoot(nightOut)], ['mine', tryMine], ['delve', tryResumeDelve], ['cave', tryCave]]) {
      const r = await f();
      if (!r) continue;
      if (r.did) { I.last = { t: now, ...last, [k]: '做了' }; return; }
      last[k] = r.skip;
    }
    // ⑨ 远处拾取（2026-09-28 加）：上面全都没事做、身体空着 = 真闲着了。
    // 实机 10 分钟里 `pickup` 一直是 `有掉落物但都不捡（far=6~17）` —— 掉落物在 8 格拾取半径外，
    // 她整整 10 分钟没去。这里在"真闲着"时去捡看得见的远处掉落物（farRadius，默认 24）。
    // 夜里在露天早就在上面 return 了；血不够、有怪、背包满都不会走到这里（或 pickPickup 自己会拒）。
    if (P.enabled && P.farRadius > P.radius) {
      const drops = dropList();
      const pick = pickPickup({ self: bot.entity.position, drops, fails, canHold, now, following: null }, { ...P, far: true });
      if (pick.ids) { last.pickup = `去捡远处 ${pick.ids.length} 堆（far）`; I.last = { t: now, ...last }; await runPickup(pick.ids, null); return; }
      if (pick.skip && /far=/.test(pick.skip)) last.pickup = pick.skip;
    }
    I.last = { t: now, ...last };
  }

  let ticking = false;
  let lastTickAt = Date.now();
  let tickStartedAt = 0;
  const timer = setInterval(async () => {
    const now = Date.now();
    // lagMs = 这一拍比"应该来的时刻"晚了多少（本能自己的拍子）。它只在**这一拍真的被叫到时**才算，
    // 所以事件循环被同步代码堵住时它也会偏大 —— 但分不清"堵"还是"本能在忙"。
    // loopMs 是 monitorEventLoopDelay 量的**事件循环本身**的延迟，和本能忙不忙无关：
    // 两者一起看就能分清（实机 12:20 那次：lagMs=13511 而 busyForMs=0 → 就是被堵了）。
    I.scheduler = {
      at: now,
      maxLagMs: Math.max(I.scheduler?.maxLagMs || 0, now - lastTickAt - CFG.pickup.tickMs),
      lagMs: Math.max(0, now - lastTickAt - CFG.pickup.tickMs),
      busyForMs: ticking ? now - tickStartedAt : 0,
      loopMs: loopDelay(),
      slow: I.slowLog.length ? I.slowLog[I.slowLog.length - 1] : null,
    };
    lastTickAt = now;
    if (ticking) return;
    tickStartedAt = now;
    ticking = true;
    try { await tick(); } catch (e) { I.last = { t: Date.now(), error: e.message }; } finally { ticking = false; }
  }, CFG.pickup.tickMs);
  let wakeQueued = false;
  const wakeChecks = () => {
    if (ended || wakeQueued) return;
    wakeQueued = true;
    setImmediate(() => {
      wakeQueued = false;
      if (ended) return;
      // 氧气优先；合并同一个包触发的多个事件，避免密集包重复扫描。
      checkBreath('event');
      checkCombat('event');
      checkEat('event');
    });
  };
  let lastUpdateWake = 0;
  const onUpdate = (e) => {
    if (Date.now() - lastUpdateWake < 100) return; // 高频姿态包合并；受伤/氧气事件不受此限制
    if (e === bot.entity || (e?.position && bot.entity?.position && e.position.distanceTo(bot.entity.position) <= I.cfg.combat.detect)) {
      lastUpdateWake = Date.now(); wakeChecks();
    }
  };
  bot.on('entityHurt', wakeChecks);
  bot.on('breath', wakeChecks);
  bot.on('health', wakeChecks);
  bot.on('entityUpdate', onUpdate);
  bot.once('end', () => { ended = true; bot.removeListener('entityHurt', wakeChecks); bot.removeListener('breath', wakeChecks); bot.removeListener('health', wakeChecks); bot.removeListener('entityUpdate', onUpdate); clearInterval(hazardTimer); clearInterval(timer); clearInterval(gazeTimer); clearInterval(toolTimer); clearInterval(combatTimer); clearInterval(kitTimer); clearInterval(oreWatch); clearInterval(policyTimer); clearInterval(homeTimer); clearInterval(eatTimer); clearInterval(breathTimer); clearInterval(shoreTimer); clearInterval(effectTimer); });
}

/**
 * mind 让下矿（`POST /delve`）之后，本能记下"正在下矿"（2026-09-28 第 8 批 第 5 条）。
 *
 * 实机证据：`delve(seconds=90 …) ✓ gained={raw_copper:5, cobblestone:21}` 只跑了 50 秒
 * 就因为战斗中断，然后她**站在原地等 mind 再想起来** —— 那段洞里看得见的矿就白瞎了。
 *
 * 这里只记"目标 / 方向 / 开始时刻 / 上次被打断的时刻"，不自己决定什么时候下矿。
 * 是否续探的判据在 `pickDelveResume`（纯函数，可离线自测）：
 *   · 5 分钟内（resumeMs）有 mind 发起的下矿记录；
 *   · 记录里的洞口离她现在不远（不跨维度、不跨半个世界）；
 *   · 体力/背包/mind 没有别的安排（由 tick 的顺序保证）；
 *   · 中途没有"她自己要走的事"（由调用点保证）。
 *
 * @param {object} I      state.instinct
 * @param {object} a      `POST /delve` 的参数（target / targetY / seconds）
 * @param {object} r      delve 的返回（reason / at / entry / deepest / heading）
 * @param {number} now
 */
function noteDelve (I, a = {}, r = {}, now = Date.now()) {
  if (!I) return null;
  const tgt = a.target || null; const ty = a.targetY != null ? +a.targetY : null;
  const rec = {
    target: tgt, targetY: ty, seconds: +a.seconds || +a.maxMs ? Math.round((+a.seconds || +a.maxMs / 1000)) : null,
    at: r.at ? { x: r.at.x, y: r.at.y, z: r.at.z } : null,
    entry: r.entry || null,
    heading: r.heading || null,
    startedAt: I.delve?.target === tgt ? (I.delve.startedAt || now) : now,
    resumes: a.resumed ? (I.delve?.target === tgt ? (I.delve.resumes || 0) + 1 : 1) : 0,   // mind 自己发起的下矿：计数归零
    lastAt: now,
    reason: r.reason || null,
    // 被战斗/怪打断：delve 的 reason 里会写"僵尸/骷髅 在 N 格外"这种
    interrupted: /在 \d+(\.\d+)? 格外/.test(String(r.reason || '')) ? String(r.reason) : null,
    // 这些原因停下的不自己接着下（Claude 复查）：血少回洞里危险；背包满 / 火把用完接着下会马上又停，来回抖
    noResume: /血只剩|背包快满|火把用完|没有火把|镐子不够/.test(String(r.reason || '')) ? String(r.reason) : null,
  };
  I.delve = rec;
  return rec;
}

/**
 * 该不该由**本能**把被打断的下矿接着走下去（第 5 条，纯函数）。
 *
 * cave 本能保持默认关（Codex 的理由成立：会把"人在洞里"误当成"主人让我探险"）。
 * 但**mind 明确发起过的下矿**不算"误当成" —— 有目标、有时间、有记录，接着走是照吩咐办事。
 *
 * @param {{delve:?object, self:?{x,y,z}, now:number, resumeMs:number, reach:number, enabled:boolean, caveEnabled:boolean}} c
 * @returns {null|{resume:true, why:string, target:?string, entry:?object}|{resume:false, why:string}}
 */
function pickDelveResume (c = {}) {
  const { delve = null, self = null, now = Date.now(), resumeMs = 300000, reach = 96 } = c;
  if (!c.enabled) return { resume: false, why: '续探本能关着' };
  if (!delve) return { resume: false, why: '最近没有下过矿' };
  if (delve.noResume) return { resume: false, why: `上次是因为「${delve.noResume}」停的，不自己接着下` };
  if ((delve.resumes || 0) >= (c.maxResumes ?? 3)) return { resume: false, why: `已经自己接着下了 ${delve.resumes} 次，等 mind 决定` };
  if (!self) return { resume: false, why: '没有位置' };
  const since = now - (delve.lastAt || delve.startedAt || 0);
  if (!(since < resumeMs)) return { resume: false, why: `上次下矿已是 ${Math.round(since / 1000)} 秒前（超过 ${Math.round(resumeMs / 1000)} 秒就不主动接着走了）` };
  // 离记录里的地方太远 → 不跨半张地图去"接着挖"
  const p = delve.at || delve.entry;
  if (p && Number.isFinite(p.x)) {
    const d = Math.hypot(self.x - p.x, self.z - p.z);
    if (d > reach) return { resume: false, why: `上次下矿的地方在 ${Math.round(d)} 格外（超过 ${reach} 格）` };
  }
  return { resume: true, why: delve.interrupted ? `上次因为「${delve.interrupted}」断了 ${Math.round(since / 1000)} 秒，接着把它挖完` : `上次下矿结束 ${Math.round(since / 1000)} 秒，还能接着挖`, target: delve.target, entry: delve.entry };
}

/**
 * 命令来了：本能让出身体。bridge 路由在执行会动身体的 POST 之前调用。
 * 打断正在做的本能，并等它收拾干净（最多 yieldWaitMs）—— 不然它的 finally 会清掉新命令刚设的寻路目标。
 */
async function yieldBody (state, key, args = {}) {
  const I = state.instinct;
  if (!I) return;
  // 只有明说"站住"（hold）才静默。mind 换任务前、脑干看门狗脱困时也会调 /stop —— 那是"换件事"，不是"别动"。
  if (key === 'POST /stop' && args?.hold) I.quietUntil = Date.now() + I.cfg.pickup.quietAfterStopMs;
  if (I.urgent && !COMBAT_YIELD.has(key)) return { reject: `正在执行紧急本能：${I.urgent}` };
  if (I.urgent && key === 'POST /stop' && !args?.hold) return { reject: `正在执行紧急本能：${I.urgent}` };
  const r = I.running;
  if (I.urgent && (!r || r.kind !== 'combat')) I.urgent = null;
  if (!r) return;
  // 打架的时候：只让 停 / 逃 / 跟随 / 走 / 关本能 这几类打断；别的命令等打完（不然两边抢身体）
  // /stop 只有明说"站住"（hold）才算：脑干看门狗一见怪就发不带 hold 的 /stop，不能让它把正在打的架叫停
  if (r.kind === 'combat' && (!COMBAT_YIELD.has(key) || (key === 'POST /stop' && !args?.hold))) return { reject: '在打架（战斗本能），打完再做' };
  r.abort();
  await Promise.race([r.done.catch(() => {}), new Promise(res => setTimeout(res, CFG.yieldWaitMs))]);
}

/** 打架时能叫停战斗的命令（其余的回"在打架"） */
const COMBAT_YIELD = new Set(['POST /stop', 'POST /flee', 'POST /follow', 'POST /go', 'POST /move', 'POST /self_rescue']);

/** 不碰身体的 POST —— 不需要让本能停下 */
const PASSIVE_POSTS = new Set([
  'POST /chat', 'POST /instinct', 'POST /knowledge/search', 'POST /registry/import-palette', 'POST /reconnect',
  'POST /look', 'POST /memory', 'POST /project/save', 'POST /doors/forget-left-open',
]);

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  const P = CFG.pickup;
  const me = { x: 0.5, y: 64, z: 0.5 };
  const d = (id, x, z, extra = {}) => ({ id, pos: { x, y: 64, z }, ageMs: 5000, thrower: null, item: 'cobblestone', ...extra });

  // ---- 扔出来的判定 ----
  const owner = { x: 5.5, y: 64, z: 0.5 };
  const P2 = [{ name: 'starwish', pos: owner }, { name: 'self', pos: me }];
  check('★ 从玩家眼前生成 → 他扔的', whoThrew({ x: 5.6, y: 65.32, z: 0.5 }, P2), 'starwish');
  check('从她自己眼前生成 → 她自己扔的', whoThrew({ x: 0.5, y: 65.3, z: 0.4 }, P2), 'self');
  check('挖旁边的方块掉的（方块中心 ±0.25）→ 不是扔的', whoThrew({ x: 6.75, y: 65.5, z: 0.5 }, P2), null);
  check('怪死在玩家脚边掉的（脚底高度）→ 不是扔的', whoThrew({ x: 5.6, y: 64.1, z: 0.5 }, P2), null);

  // ---- 挑哪几堆 ----
  check('附近一堆 → 捡', pickPickup({ self: me, drops: [d(1, 3, 0)] }).ids?.[0], 1);
  check('刚落地 → 等等', pickPickup({ self: me, drops: [d(1, 3, 0, { ageMs: 200 })] }).ids, undefined);
  check('★ 玩家扔的（常常是扔给她的）→ 捡', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'starwish' })] }).ids?.[0], 1);
  check('玩家刚扔出 1.5 秒 → 再等等（拾取延迟 + 给他反悔的时间）', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'starwish', ageMs: 1500 })] }).ids, undefined);
  check('★ 她自己扔的 → 不捡（不然丢了又捡）', pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'self' })] }).ids, undefined);
  check('太远 → 不管', pickPickup({ self: me, drops: [d(1, 20, 0)] }).ids, undefined);
  check('楼下 5 格 → 不管', pickPickup({ self: me, drops: [{ ...d(1, 2, 0), pos: { x: 2, y: 59, z: 0 } }] }).ids, undefined);
  check('装不下 → 不去', pickPickup({ self: me, drops: [d(1, 3, 0)], canHold: () => false }).ids, undefined);
  const fails = new Map([[1, { n: 2, until: 1e12 }]]);
  check('★ 试了两次没捡到 → 先放着', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 0 }).ids, undefined);
  check('冷却过了 → 再试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails, now: 2e12 }).ids?.[0], 1);
  check('只失败一次 → 还试', pickPickup({ self: me, drops: [d(1, 3, 0)], fails: new Map([[1, { n: 1, until: 1e12 }]]), now: 0 }).ids?.[0], 1);
  const many = [d(1, 7, 0), d(2, 1, 0), d(3, 4, 0), d(4, 2, 0), d(5, 3, 0), d(6, 5, 0)];
  const r = pickPickup({ self: me, drops: many }, { ...P, batch: 4 });   // 测"截到 batch"这件事，batch 固定成 4（默认值会调）
  check('一次最多 batch 堆', r.ids.length, 4);
  check('从近到远', r.ids.join(','), '2,4,5,3');
  check('跳过的原因写得出来', /mine=1/.test(pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'self' })] }).skip), true);
  check('没有掉落物 → 如实说没有', pickPickup({ self: me, drops: [] }).skip, '附近没有掉落物');

  // ---- 远处拾取（任务书第 4 条）：闲着时才去捡 farRadius 内看得见的
  {
    const farCfg = { ...P, far: true };
    // 实机现场：掉落物在 6~17 格（8 格半径外），她不去 → 远处模式要选中它
    check('★ 闲着 + 12 格外的 → 远处模式会去捡', pickPickup({ self: me, drops: [d(9, 12, 0)] }, farCfg).ids?.[0], 9);
    check('远处模式：15 格内也去（实机 far=15）', pickPickup({ self: me, drops: [d(9, 15, 0)] }, farCfg).ids?.[0], 9);
    check('远处模式：超出 farRadius(24) 的不去', pickPickup({ self: me, drops: [d(9, 30, 0)] }, farCfg).ids, undefined);
    check('远处模式：看不见的（墙后）不去', pickPickup({ self: me, drops: [d(9, 12, 0, { visible: false })] }, farCfg).ids, undefined);
    check('远处模式：看得见的才去', pickPickup({ self: me, drops: [d(9, 12, 0, { visible: true })] }, farCfg).ids?.[0], 9);
    check('★ 不开 far 时老行为不变：12 格外的仍然不管', pickPickup({ self: me, drops: [d(9, 12, 0)] }).ids, undefined);
    check('★ 跟随中不给远处模式（只捡 6 格内的）', pickPickup({ self: me, drops: [d(9, 12, 0)], following: { pos: me } }, farCfg).ids, undefined);
    check('远处模式也照样不捡自己扔的', pickPickup({ self: me, drops: [d(9, 12, 0, { thrower: 'self' })] }, farCfg).ids, undefined);
    check('远处模式也照样受"两次没捡到"冷却', pickPickup({ self: me, drops: [d(9, 12, 0)], fails: new Map([[9, { n: 2, until: 1e12 }]]), now: 0 }, farCfg).ids, undefined);
  }

  // 跟随中：离她近、离玩家也近才捡
  const fol = { pos: { x: 3, y: 64, z: 0 } };
  check('跟随中：玩家身边的 → 捡', pickPickup({ self: me, drops: [d(1, 4, 0)], following: fol }).ids?.[0], 1);
  const folFar = { pos: { x: 6, y: 64, z: 0 } };   // 玩家已经往前走出 6 格
  check('★ 跟随中：离玩家太远的 → 不为它把人跟丢', pickPickup({ self: me, drops: [d(1, -4, 0)], following: folFar }).ids, undefined);

  // ---- 镐子等级 ----
  check('没有镐子 → -1', pickaxeTier(['minecraft:stick']), -1);
  check('石镐 + 铁镐 → 取最好的（铁=2）', pickaxeTier(['stone_pickaxe', 'minecraft:iron_pickaxe']), 2);
  check('金镐只算木级', pickaxeTier(['golden_pickaxe']), 0);
  check('模组镐认得出材质的按材质', pickaxeTier(['somemod:diamond_pickaxe_plus']), 3);
  check('模组镐认不出材质 → 按石镐（宁可少挖）', pickaxeTier(['somemod:crystal_pickaxe']), 1);
  check('★ 矿表没查到等级 → 保守按铁镐', needTier(null), TIER.iron);

  // ---- 随身物品：精妙背包里的也要算（P-4 / N-9）
  const cbot = (carried) => ({ inventory: { items: () => carried.map(c => ({ name: c.name, count: c.count })) } });
  check('★ 镐子在精妙背包里 → 算得上（以前只看身上，判成"没镐子"）',
    pickaxeTier(carriedNames(cbot([]), { backpackSeen: { items: { 'minecraft:iron_pickaxe': 1 } } }).names), 2);
  check('背包读不到 → readable:false（调用方不能说"没有"）', carriedNames(cbot([{ name: 'torch', count: 1 }]), {}).readable, false);
  check('★ 背包读得到 → readable:true', carriedNames(cbot([]), { backpackSeen: { items: { 'minecraft:torch': 1 } } }).readable, true);
  check('身上 + 背包同名 → 合并计数', carriedTally(cbot([{ name: 'torch', count: 4 }]), { backpackSeen: { items: { 'minecraft:torch': 10 } } }).have.torch, 14);
  check('背包读不到时只算身上的', carriedTally(cbot([{ name: 'torch', count: 4 }]), {}).have.torch, 4);
  check('背包里的原铁算了（"缺不缺这种矿"用它判断）', carriedTally(cbot([]), { backpackSeen: { items: { 'minecraft:raw_iron': 9 } } }).have.raw_iron, 9);

  // ---- 挖哪条矿 ----
  const ore = (name, x, z, extra = {}) => ({ name, pos: { x, y: 64, z }, value: 'mid', tier: 'stone', drops: ['raw_iron'], visible: true, hazard: false, ...extra });
  const O = (ores, extra = {}) => pickOre({ ores, self: me, pick: 2, ...extra });
  check('看得见的铁矿 → 挖', O([ore('iron_ore', 3, 0)]).target?.name, 'iron_ore');
  check('★ 看不见的（透视）→ 不挖', O([ore('iron_ore', 3, 0, { visible: false })]).target, undefined);
  check('★ 旁边有岩浆 → 不挖', O([ore('iron_ore', 3, 0, { hazard: true })]).target, undefined);
  check('太远 → 不去', O([ore('iron_ore', 30, 0)]).target, undefined);
  check('★ 高价值优先，哪怕远一点', O([ore('iron_ore', 2, 0), ore('diamond_ore', 8, 0, { value: 'high', tier: 'iron' })]).target?.name, 'diamond_ore');
  const noTool = O([ore('diamond_ore', 3, 0, { value: 'high', tier: 'iron' })], { pick: 1 });
  check('★ 石镐遇钻石矿 → 不挖', noTool.target, undefined);
  check('★ …但告诉 mind 要铁镐', noTool.lacking?.[0]?.need, TIER.iron);
  check('没有镐子 → 什么都不挖', O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { pick: -1 }).target, undefined);
  const coal = (n) => O([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { have: { coal: n } });
  check('煤不够（缺火把）→ 挖', coal(3).target?.name, 'coal_ore');
  check('★ 煤够多了 → 不为煤停下', coal(40).target, undefined);
  check('一条矿脉一起挖（同名的数）', O([ore('iron_ore', 3, 0), ore('iron_ore', 3, 1), ore('iron_ore', 4, 1)]).count, 3);
  check('要铲子的矿（化石矿）→ 不用镐去敲', O([ore('fossil_ore', 3, 0, { notPickaxe: true })]).target, undefined);
  check('失败过的格子冷却中 → 不挖', O([ore('iron_ore', 3, 0)], { fails: new Map([['3,64,0', 9e9]]), now: 0 }).target, undefined);

  // ---- 按进度 ----
  const early = (ores, have = {}) => pickOre({ ores, self: me, pick: 1, have });   // 石镐：前期
  check('★ 前期（石镐）：铁矿排在最前，哪怕旁边有青金石', early([ore('lapis_ore', 2, 0, { drops: ['lapis_lazuli'] }), ore('iron_ore', 8, 0)]).target?.name, 'iron_ore');
  check('★ 前期：煤有 20 个还挖（前期门槛翻倍到 32）', early([ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], { coal: 20 }).target?.name, 'coal_ore');
  check('后期（铁镐）：煤有 20 个就不为它停', pickOre({ ores: [ore('coal_ore', 3, 0, { value: 'low', tier: 'wood', drops: ['coal'] })], self: me, pick: 2, have: { coal: 20 } }).target, undefined);
  check('后期：钻石排在铁前面', pickOre({ ores: [ore('iron_ore', 2, 0), ore('diamond_ore', 9, 0, { value: 'high', tier: 'iron' })], self: me, pick: 2 }).target?.name, 'diamond_ore');

  // ---- 认建筑 / 开宝箱 ----
  const blk = (name, x, n = 1) => Array.from({ length: n }, (_, i) => ({ name, pos: { x: x + i, y: 40, z: 0 } }));
  check('★ 看见刷怪笼 → 认出地牢', recognizeStructures(blk('spawner', 10))[0]?.label, '刷怪笼（地牢 / 矿井）');
  check('一两块苔石不算地牢', recognizeStructures(blk('mossy_cobblestone', 10, 2)).length, 0);
  check('一片苔石 → 地牢', recognizeStructures(blk('mossy_cobblestone', 10, 8)).length, 1);
  check('村庄的钟', recognizeStructures(blk('minecraft:bell', 5))[0]?.label, '村庄');
  const dung = recognizeStructures(blk('spawner', 10));
  check('★ 看得见没开过的箱子 → 去开', pickLoot({ chests: 2, self: me }).mode, 'open');
  check('★ 认出建筑、没进过 → 进去', pickLoot({ structures: dung, self: me }).mode, 'explore');
  check('进过的建筑不再进', pickLoot({ structures: dung, self: me, visited: new Set([dung[0].key]) }).mode, undefined);
  check('建筑太远 → 不去', pickLoot({ structures: recognizeStructures(blk('spawner', 90)), self: me }).mode, undefined);
  check('★ 血少 → 先不闯', pickLoot({ chests: 2, hp: 9, self: me }).mode, undefined);
  check('身上满了、背包也满 → 不去', pickLoot({ chests: 2, free: 1, packFree: 1, self: me }).mode, undefined);
  check('身上满了但背包还空 → 去', pickLoot({ chests: 2, free: 1, packFree: 20, self: me }).mode, 'open');
  check('夜里在露天 → 不去', pickLoot({ chests: 2, nightOut: true, self: me }).mode, undefined);
  check('模组建筑：幽灵船认得出', recognizeStructures(blk('more_critters:ghostly_planks', 5, 12))[0]?.label, '幽灵船');
  const boss = recognizeStructures(blk('cataclysm:obsidian_bricks', 5, 8));
  check('★ 灾变遗迹认得出、标了危险', boss[0]?.danger, true);
  check('★ 有 boss 的遗迹 → 不自己闯', pickLoot({ structures: boss, self: me }).mode, undefined);

  // ---- 指令本能 ----
  const P3 = (x, y, z) => ({ x, y, z });
  const death = { pos: { x: 100, y: 64, z: 0 }, dim: 'overworld', lava: false };
  check('★ 有 /back → 用 /back', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', hasBack: true }).how, 'back');
  check('★ 没有 /back、100 格 → 走回去', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld' }).how, 'walk');
  check('★ 死在岩浆里 → 不白跑', pickRecovery({ death: { ...death, lava: true }, here: P3(0, 64, 0), dim: 'overworld', hasBack: true }).how, undefined);
  check('太远 → 不走', pickRecovery({ death: { ...death, pos: { x: 2000, y: 64, z: 0 } }, here: P3(0, 64, 0), dim: 'overworld' }).how, undefined);
  check('死在下界、现在在主世界、没有 /back → 走不回去', pickRecovery({ death: { ...death, dim: 'the_nether' }, here: P3(0, 64, 0), dim: 'overworld' }).how, undefined);
  check('快 5 分钟了 → 东西多半没了', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', sinceMs: 290000 }).how, undefined);
  const C = (o) => pickCommand({ cmds: new Set(['home', 'sethome', 'spawn']), ...o });
  check('★ 在家、还没同步 → /sethome', C({ atHome: true })?.cmd, 'sethome');
  check('★ 夜里在野外、离家 500 格 → /home', C({ nightOut: true, homeDist: 500, homeSynced: true })?.cmd, 'home');
  check('夜里离家 80 格 → 走回去（不用命令）', C({ nightOut: true, homeDist: 80, homeSynced: true }), null);
  check('没设过 /sethome 就不 /home（会传到别处）', C({ nightOut: true, homeDist: 500, homeSynced: false }), null);
  check('★ 血 3、正在逃 → /home', C({ hp: 3, fleeing: true })?.cmd, 'home');
  check('服务器没给这些命令 → 什么都不用', pickCommand({ cmds: new Set(), hp: 3, fleeing: true, atHome: true }), null);
  check('刚用过命令 → 等等', C({ atHome: true, sinceLast: 1000 }), null);
  check('★ 没有 /back 但有 /tp → /tp 回死的坐标', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', hasTp: true }).how, 'tp');
  check('/tp 只在同一维度用', pickRecovery({ death: { ...death, dim: 'the_nether' }, here: P3(0, 64, 0), dim: 'overworld', hasTp: true }).how, undefined);
  check('★ 夜里 /home 回家 → 记下原来在哪', C({ nightOut: true, homeDist: 500, homeSynced: true })?.remember, true);
  const back = pickCommand({ cmds: new Set(['tp']), day: true, returnTo: P3(500, 70, 0) });
  check('★ 天亮了、没有 /back → /tp 回昨晚的地方', back?.cmd, 'tp 500 70 0');
  check('…而且是 selfTp（只传自己回坐标）', back?.selfTp, true);
  check('天亮了、有 /back → 用 /back', pickCommand({ cmds: new Set(['back', 'tp']), day: true, returnTo: P3(500, 70, 0) })?.cmd, 'back');
  check('还是晚上 → 不回去', pickCommand({ cmds: new Set(['tp']), day: false, returnTo: P3(500, 70, 0) }), null);

  // ---- 家的范围 ----
  check('房子都在半径里 → 不变', homeFootprint([3, 8, 15, 20], 24), 24);
  check('★ 房子往外盖到 35 格（连着的）→ 扩到 41', homeFootprint([5, 12, 20, 26, 31, 35], 24), 41);
  check('★ 远处孤零零一个（隔了一大段）→ 不算（不把邻居家当自己家）', homeFootprint([5, 12, 20, 60], 24), 24);
  check('只扩不缩', homeFootprint([2, 3], 40), 40);
  check('封顶 128', homeFootprint(Array.from({ length: 40 }, (_, i) => i * 5), 24), 128);
  { const c = fillCfg({ pickup: { radius: 3 } });
    check('★ 配置补全：每个本能段都有（实机崩过：I.cfg.breathe 缺）', ['eat', 'breathe', 'effects', 'weather', 'playerHurt', 'combat', 'home'].every(n => c[n] && typeof c[n] === 'object'), true);
    check('配置补全：已有的改动保留', c.pickup.radius, 3); }
  // ---- 吃 / 憋气 / 中毒 / 天气
  { const E = require('events');
    const mk = (t, extra = {}) => Object.assign(new E(), { isSleeping: true, time: { timeOfDay: t }, entity: { metadata: {}, position: { distanceTo: () => 0 } }, registry: { entitiesByName: { player: { metadataKeys: ['pose'] } } } }, extra);
    check('★ 睡眠：读不到姿态、天亮了 → 不再当成在睡', syncSleepState(mk(2000), null).sleeping, false);
    check('睡眠：读不到姿态、夜里、刚躺下 → 还在睡', syncSleepState(mk(15000), null, { sleptAt: 1000, now: 5000 }).sleeping, true);
    check('★ 睡眠：夜里"睡着"超过 8 分钟 → 醒', syncSleepState(mk(15000), null, { sleptAt: 1, now: 600000 }).sleeping, false);
    check('睡眠：打雷的白天能睡 → 不强醒', syncSleepState(mk(2000, { isRaining: true, thunderState: 1 }), null, { sleptAt: 1000, now: 5000 }).sleeping, true); }
  check('★ 拾取被打断 → 一个都不记失败', pickupFailIds({ ids: [1, 2], aborted: true }).length, 0);
  check('★ 预算用完没轮到的 → 不记', pickupFailIds({ ids: [1, 2, 3], r: { tried: [1], stopped: 'budget' } }).join(), '1');
  check('试过、还在地上 → 记', pickupFailIds({ ids: [1, 2], r: { tried: [1, 2] }, exists: (i) => i === 2 }).join(), '2');
  // ⚠️ 2026-09-28 审计（codex fix0 #3）：`r.tried` 缺失的三种情形要分开 ——
  //    旧版 bridge（调用方显式声明 legacyOk）才按全部算；异常/不完整响应一条都不记。
  check('★ handler 异常（{error}）→ 一条都不记（不误伤拉黑）', pickupFailIds({ ids: [1, 2], r: { error: 'boom' } }).length, 0);
  check('★ 响应是 null（连不上）→ 一条都不记', pickupFailIds({ ids: [1, 2], r: null }).length, 0);
  check('★ 新 bridge 正常返回但缺 tried → 也一条都不记（说不清就保守）', pickupFailIds({ ids: [1, 2], r: { found: 2, walkedTo: 0, picked: 0 } }).length, 0);
  check('旧版 bridge（显式 legacyOk）没有 tried → 才按全部', pickupFailIds({ ids: [1, 2], r: { found: 2, walkedTo: 1 }, legacyOk: true }).length, 2);
  check('★ 饥饿 16（掉了 2 格）、身体空着 → 吃', pickEat({ food: 16 })?.eat, true);
  check('饥饿 17 → 不饿', pickEat({ food: 17 }), null);
  check('饥饿 12、在忙 → 等忙完', typeof pickEat({ food: 12, busy: '在挖矿' })?.skip, 'string');
  check('★ 饥饿 5、在忙 → 也吃（急）', pickEat({ food: 5, busy: '在挖矿' })?.urgent, true);
  check('在打架不吃', typeof pickEat({ food: 3, fighting: true })?.skip, 'string');
  check('身上没吃的 → 如实说', pickEat({ food: 10, hasFood: false })?.skip, '身上没有吃的');
  check('读不到饥饿值 → 不猜', pickEat({ food: null })?.skip, '读不到饥饿值');
  check('★ 头在水里、氧气 6 → 上浮', needBreath({ oxygen: 6, headInWater: true }), true);
  check('氧气 6 但头在水外 → 不用', needBreath({ oxygen: 6, headInWater: false }), false);
  check('有水下呼吸 → 不用', needBreath({ oxygen: 2, headInWater: true, waterBreathing: true }), false);
  check('读不到氧气 → 不猜', needBreath({ oxygen: null, headInWater: true }), false);
  check('★ 凋零 + 有牛奶 → 喝', effectPlan({ effects: ['Wither'], hp: 18, hasMilk: true })?.milk, true);
  check('中毒、血还多 → 不喝（毒不致死）', effectPlan({ effects: ['Poison'], hp: 18, hasMilk: true })?.milk, false);
  check('中毒、血 8 → 喝', effectPlan({ effects: ['Poison'], hp: 8, hasMilk: true })?.milk, true);
  check('中毒打架按少 4 滴血算', effectPlan({ effects: ['Poison'], hp: 20 })?.hpCost, 4);
  check('没中毒 → 无事', effectPlan({ effects: ['Speed'] }), null);
  check('读不到效果 → 不猜', effectPlan({ effects: null }), null);
  { const L = (x, z, y = 64, extra = {}) => ({ pos: { x, y, z }, below: 'grass_block', feet: 'air', head: 'air', ok: true, ...extra });
    const me = { x: 0, y: 63, z: 0 };
    check('★ 上岸：挑最近的岸', pickShore([L(6, 0), L(3, 0), L(0, 9)], me)?.pos.x, 3);
    check('上岸：脚下是水的不算', pickShore([L(2, 0, 64, { below: 'water' })], me), null);
    check('上岸：高 3 格的崖比远 2 格的平岸差', pickShore([L(2, 0, 66), L(4, 0, 64)], me)?.pos.x, 4);
    check('上岸：站不进去的不算', pickShore([L(2, 0, 64, { ok: false })], me), null);
    check('上岸：旁边没有岸 → null', pickShore([], me), null); }
  // 上岸分圈扫：第 k 圈只含水平切比雪夫距离 = k 的格子，逐圈由近到远
  { const r0 = shoreRingOffsets(0), r1 = shoreRingOffsets(1), r2 = shoreRingOffsets(2);
    check('★ 第 0 圈只有中心一列（1 个水平位 ×6 个高度）', r0.length, 6);
    check('第 1 圈水平位 8 个（3×3 去掉中心）→ ×6', r1.length, 8 * 6);
    check('第 2 圈水平位 16 个（5×5 去掉 3×3）→ ×6', r2.length, 16 * 6);
    check('★ 第 1 圈的每个水平偏移切比雪夫距离都是 1',
      r1.every(o => Math.max(Math.abs(o.dx), Math.abs(o.dz)) === 1), true);
    check('★ 第 2 圈的每个水平偏移切比雪夫距离都是 2',
      r2.every(o => Math.max(Math.abs(o.dx), Math.abs(o.dz)) === 2), true);
    check('★ 第 0 圈就是脚下（dx=0,dz=0）', r0.every(o => o.dx === 0 && o.dz === 0), true);
    check('高度下限 -2 覆盖到', Math.min(...r1.map(o => o.dy)), -2);
    check('高度上限 3 覆盖到', Math.max(...r1.map(o => o.dy)), 3);
    check('k<0 → 空', shoreRingOffsets(-1).length, 0); }
  check('开始下雨', weatherChange({ rain: false, thunder: false }, { rain: true, thunder: false })?.kind, 'rain');
  check('★ 打雷', weatherChange({ rain: true, thunder: false }, { rain: true, thunder: true })?.kind, 'thunder');
  check('雨停', weatherChange({ rain: true, thunder: true }, { rain: false, thunder: false })?.kind, 'clear');
  check('没变 → 不说', weatherChange({ rain: true, thunder: false }, { rain: true, thunder: false }), null);
  check('★ 暗处：光源读得到、3 格全黑 → 报', darkReport({ sourceLights: [14], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }, { pos: 3, light: 0 }, { pos: 4, light: 9 }] }).count, 3);
  check('★ 暗处：有光源却都读成 0 → 读不到，不报暗', darkReport({ sourceLights: [0, undefined], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }, { pos: 3, light: 0 }] }).kind, 'unreadable');
  check('暗处：只有 2 格黑 → 不吵', darkReport({ sourceLights: [14], cells: [{ pos: 1, light: 0 }, { pos: 2, light: 0 }] }), null);
  check('暗处：家里一个光源都没有 → 报没有光源', darkReport({ sourceLights: [], cells: [{ pos: 1 }, { pos: 2 }, { pos: 3 }] }).kind, 'no_source');

  // ---- 落地水 ----
  const F = (o) => mlgStep({ startY: 90, y: 75, vy: -1.2, landY: 70, hasBucket: true, holding: true, ...o });
  check('还在半空（离地 5 格）→ 先不倒', F({}), null);
  check('★ 离地 3 格以内 → 倒水', F({ y: 72.5 }), 'place');
  check('★ 会摔伤、手上还没拿水桶 → 先换上', F({ holding: false }), 'equip');
  check('落差 3 格（摔不伤）→ 不管', F({ startY: 73, y: 72, landY: 70 }), null);
  check('★ 下界 → 不倒（水会蒸发）', F({ y: 72.5, nether: true }), null);
  check('落点本来就是水 → 不用倒', F({ y: 72.5, landIsWater: true }), null);
  check('没有水桶 → 什么都做不了', F({ y: 72.5, hasBucket: false }), null);
  check('这次已经倒过 → 不再倒', F({ y: 72.5, placed: true }), null);
  check('只是跳一下（速度小）→ 不管', F({ y: 72.5, vy: -0.1 }), null);

  // ---- 洞里下一步 ----
  const cv = (x, y, z, extra = {}) => ({ pos: { x, y, z }, visible: true, lavaNear: false, dark: true, ...extra });
  const here = { x: 0, y: 30, z: 0 };
  check('往看得见、够远的地方走', pickCaveStep({ cells: [cv(8, 30, 0)], self: here })?.pos.x, 8);
  check('★ 旁边有岩浆 → 不去', pickCaveStep({ cells: [cv(8, 30, 0, { lavaNear: true })], self: here }), null);
  check('看不见（隔着墙）→ 不去', pickCaveStep({ cells: [cv(8, 30, 0, { visible: false })], self: here }), null);
  check('★ 太低（落差 >4）→ 不跳', pickCaveStep({ cells: [cv(8, 20, 0)], self: here }), null);
  check('太近（原地挪）→ 不算一步', pickCaveStep({ cells: [cv(2, 30, 0)], self: here }), null);
  check('★ 去过的格子 → 不再去', pickCaveStep({ cells: [cv(8, 30, 0)], self: here, visited: new Set(['2,7,0']) }), null);
  check('★ 暗的优先（没点亮 = 没人来过）', pickCaveStep({ cells: [cv(14, 30, 0, { dark: false }), cv(7, 30, 0)], self: here })?.pos.x, 7);
  check('出了入口范围 → 不去', pickCaveStep({ cells: [cv(10, 30, 0)], self: here, entry: { x: -60, y: 30, z: 0 } }), null);

  // ---- 收哪些庄稼 ----
  const crop = (x, z, extra = {}) => ({ name: 'wheat', pos: { x, y: 64, z }, age: 7, maxAge: 7, harvest: 'break', farmland: true, visible: true, ...extra });
  const home = () => true; const away = () => false;
  check('家里三棵熟了 → 收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)], inHome: home }).only?.length, 3);
  check('只熟了两棵 → 攒一攒', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0, { age: 4 })], inHome: home }).only, undefined);
  check('★ 别人（家外）耕地上的 → 不收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)], inHome: away }).only, undefined);
  check('★ 不知道家在哪 → 耕地上的也不收', pickHarvest({ self: me, crops: [crop(1, 0), crop(2, 0), crop(3, 0)] }).only, undefined);
  check('野生的（不在耕地上）→ 收', pickHarvest({ self: me, crops: [crop(1, 0, { farmland: false }), crop(2, 0, { farmland: false }), crop(3, 0, { farmland: false })] }).only?.length, 3);
  check('★ 右键摘的（浆果丛）→ 不打掉', pickHarvest({ self: me, crops: [1, 2, 3].map(x => crop(x, 0, { harvest: 'use' })), inHome: home }).only, undefined);

  // ---- 回家整理 ----
  const TD = (o) => pickTidy({ free: 20, short: [], atHomeHas: [], homeDist: 30, ...o });
  check('身上齐全、没满 → 不回', TD({}).go, undefined);
  check('★ 背包快满 → 回家整理', TD({ free: 2 }).go, true);
  check('★ 没吃的、家里箱子里有 → 回家拿', TD({ short: ['吃的'], atHomeHas: ['吃的'] }).go, true);
  check('★ 没吃的、家里也没有 → 不空跑（告诉 mind 就行）', TD({ short: ['吃的'], atHomeHas: [] }).go, undefined);
  check('不知道家在哪 → 不回', TD({ free: 1, homeDist: null }).go, undefined);
  check('离家太远 → 不专程回（mind 决定）', TD({ free: 1, homeDist: 500 }).go, undefined);
  check('刚整理过 → 不回', TD({ free: 1, sinceLast: 1000 }).go, undefined);
  check('夜里在露天、家远 → 不回', TD({ free: 1, homeDist: 100, nightOut: true }).go, undefined);
  check('夜里在露天、家就在旁边 → 回', TD({ free: 1, homeDist: 20, nightOut: true }).go, true);
  check('★ 身上快满、背着背包还有空 → 先装背包，不回家', TD({ free: 2, pack: { free: 20, has: [] } }).where, 'backpack');
  check('★ 缺吃的、背包里有 → 从背包拿（哪怕家里也有）', TD({ short: ['吃的'], atHomeHas: ['吃的'], pack: { free: 10, has: ['吃的'] } }).where, 'backpack');
  check('★ 身上满、背包也满 → 回家', TD({ free: 2, pack: { free: 1, has: [] } }).where, 'home');
  check('背包没开过（不知道剩多少）→ 试一次', TD({ free: 2, pack: { free: null, has: [] } }).where, 'backpack');
  check('刚倒腾过背包 → 这次回家', TD({ free: 2, pack: { free: 20, has: [] }, sincePack: 1000 }).where, 'home');

  // ---- 战斗 ----
  check('苦力怕', mobKind('creeper'), 'creeper');
  check('模组苦力怕也认', mobKind('somemod:ice_creeper'), 'creeper');
  check('骷髅是远程', mobKind('skeleton'), 'ranged');
  check('★ 模组怪手上拿着弓 → 远程', mobKind('somemod:ghoul', 'bow'), 'ranged');
  check('拿三叉戟的溺尸 → 远程', mobKind('drowned', 'trident'), 'ranged');
  check('空手溺尸 → 近战', mobKind('drowned', null), 'melee');
  check('僵尸近战', mobKind('zombie'), 'melee');
  check('★ 可见但尚未攻击的僵尸也算敌对', isHostileEntity({ name: 'zombie', type: 'hostile' }), true);
  check('普通动物不算敌对', isHostileEntity({ name: 'cow', type: 'animal' }), false);
  check('★ 剑要等 0.625 秒（不是 350ms 连点）', attackCooldownMs('iron_sword'), 625);
  check('石斧更慢', attackCooldownMs('stone_axe') > attackCooldownMs('diamond_axe'), true);
  const T = (name, dist, extra = {}) => ({ id: dist * 10, name, pos: { x: dist, y: 64, z: 0 }, dist, on: 'me', evidence: 'aggressive', kind: mobKind(name), ...extra });
  check('僵尸冲她来 → 近战', combatPlan({ targets: [T('zombie', 4)] })?.mode, 'melee');
  check('★ 血只剩 5 → 跑', combatPlan({ targets: [T('zombie', 4)], hp: 5 })?.mode, 'retreat');
  check('★ 苦力怕 4 格 → 躲开，不近战', combatPlan({ targets: [T('creeper', 4)] })?.mode, 'avoid');
  check('苦力怕在 7 格外、只有它 → 不动（不追着打苦力怕）', combatPlan({ targets: [T('creeper', 9)] }), null);
  check('★ 骷髅、没盾 → 冲上去近战（躲只会站着挨箭）', combatPlan({ targets: [T('skeleton', 8)] })?.mode, 'melee');
  check('★ 骷髅、没盾、血少 → 跑', combatPlan({ targets: [T('skeleton', 8)], hp: 5 })?.mode, 'retreat');
  check('★ 骷髅、有盾 → 举盾贴上去', combatPlan({ targets: [T('skeleton', 8)], hasShield: true })?.mode, 'shield');
  check('骷髅已经贴脸（没盾）→ 直接打', combatPlan({ targets: [T('skeleton', 2)] })?.mode, 'melee');
  check('超出发现距离 → 不管', combatPlan({ targets: [T('zombie', 15)] }), null);
  check('★ 离锚点太远（追出 leash）→ 不追', combatPlan({ targets: [T('zombie', 5)], anchor: { x: -20, y: 64, z: 0 } }), null);
  check('打过人的优先（哪怕远一点）', combatPlan({ targets: [T('zombie', 3), T('husk', 6, { evidence: 'hurt' })] })?.target.name, 'husk');
  check('苦力怕贴近时先躲，哪怕旁边有僵尸', combatPlan({ targets: [T('zombie', 3), T('creeper', 3)] })?.mode, 'avoid');

  // ---- 危险方块 ----
  check('★ 站在岩浆块上 → 要挪', typeof hazardUnder({ feet: 'air', below: 'magma_block' }), 'string');
  check('陷在浆果丛里 → 要挪', typeof hazardUnder({ feet: 'sweet_berry_bush', below: 'grass_block' }), 'string');
  check('陷在细雪里 → 要挪', typeof hazardUnder({ feet: 'minecraft:powder_snow', below: 'stone' }), 'string');
  check('站在草地上 → 没事', hazardUnder({ feet: 'air', below: 'grass_block' }), null);
  check('★ 头顶有沙子掉下来 → 挪开', typeof hazardUnder({ feet: 'air', below: 'stone', fallingAbove: true }), 'string');
  check('读不到 → 不当危险（不猜）', hazardUnder({}), null);
  const cell = (dx, dz, below, feet = 'air', head = 'air') => ({ dx, dz, feet, head, below });
  check('★ 挪到旁边能站的格子', pickStepOff([cell(1, 0, 'lava'), cell(-1, 0, 'stone')])?.dx, -1);
  check('先直的再斜的', pickStepOff([cell(1, 1, 'stone'), cell(0, 1, 'stone')])?.dz, 1);
  check('★ 旁边全是岩浆块 / 空 → 不挪（别挪进更糟的地方）', pickStepOff([cell(1, 0, 'magma_block'), cell(0, 1, 'air')]), null);
  check('读不到的格子不去', pickStepOff([cell(1, 0, null)]), null);
  check('头顶被挡 → 不去', pickStepOff([cell(1, 0, 'stone', 'air', 'stone')]), null);

  // ---- 护甲 ----
  check('铁 > 皮', armorRank('iron_chestplate') > armorRank('leather_tunic'), true);
  check('模组护甲认不出材质 → null', armorRank('somemod:void_chestplate'), null);
  const up = pickArmor({ torso: 'leather_chestplate' }, [{ name: 'iron_chestplate', slot: 'torso' }]);
  check('★ 皮胸甲 → 换铁的', up[0]?.name, 'iron_chestplate');
  check('只往上换：穿着钻石的，背包里的铁不换', pickArmor({ torso: 'diamond_chestplate' }, [{ name: 'iron_chestplate', slot: 'torso' }]).length, 0);
  check('★ 穿着认不出的模组胸甲 → 不自动换（可能是主人给的）', pickArmor({ torso: 'somemod:void_chestplate' }, [{ name: 'netherite_chestplate', slot: 'torso' }]).length, 0);
  check('空槽 → 穿上（模组的也行）', pickArmor({}, [{ name: 'somemod:void_boots', slot: 'feet' }])[0]?.name, 'somemod:void_boots');
  check('鞘翅不碰', pickArmor({ torso: 'elytra' }, [{ name: 'netherite_chestplate', slot: 'torso' }]).length, 0);

  // ---- 工具耐久 ----
  check('★ 铁镐剩 5% → 提醒', !!toolWorn({ maxDurability: 250, durabilityUsed: 238 }), true);
  check('剩一半 → 不说', toolWorn({ maxDurability: 250, durabilityUsed: 125 }), null);
  check('★ 附魔的剩 15% 就提醒（更早）', !!toolWorn({ maxDurability: 1561, durabilityUsed: 1330, enchanted: true }), true);
  check('没有耐久数据（模组物品）→ 不说（不猜）', toolWorn({ durabilityUsed: 10 }), null);

  // ---- 转头看人（任务书 fix7：只在互动窗口里看，窗口外不看）
  const V = (x, y, z) => ({ x, y, z });
  const near3 = { name: 'Ann', pos: V(3, 64, 0) };
  // gazeEngaged：窗口内/外/没记录/到点
  check('没互动过的玩家 → 不在窗口里', gazeEngaged({ player: 'Ann', engagedUntil: new Map(), now: 1000 }), false);
  check('刚说过话（窗口未到点）→ 在窗口里', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 2000]]), now: 1000 }), true);
  check('★ 窗口过了（now == 到点）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 1000]]), now: 1000 }), false);
  check('★ 窗口过了（now 超过）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 999]]), now: 1000 }), false);
  check('读不到玩家名 → 不猜，不看', gazeEngaged({ player: null, engagedUntil: new Map([['Ann', 1e15]]), now: 0 }), false);
  check('没有窗口表（老 state）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: null, now: 0 }), false);
  check('普通对象也能当窗口表（不强制 Map）', gazeEngaged({ player: 'Ann', engagedUntil: { Ann: 2000 }, now: 1000 }), true);
  // pickGaze：只在窗口内的玩家里挑最近的
  check('★ 近处玩家没互动 → 不看（6 格内有也不看）', pickGaze({ players: [near3], self: V(0, 64, 0), engagedUntil: new Map() }), null);
  check('★ 刚说话的近处玩家 → 看他', pickGaze({ players: [near3], self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15]]) })?.pos.x, 3);
  check('★ 窗口过了 → 不看', pickGaze({ players: [near3], self: V(0, 64, 0), now: 1000, engagedUntil: new Map([['Ann', 999]]) }), null);
  check('两个都在窗口里 → 挑最近的', pickGaze({
    players: [{ name: 'Ann', pos: V(5, 64, 0) }, { name: 'Bob', pos: V(2, 64, 0) }],
    self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15], ['Bob', 1e15]]),
  })?.name, 'Bob');
  check('只有一个在窗口里 → 挑窗口里的那个（哪怕更远）', pickGaze({
    players: [{ name: 'Ann', pos: V(2, 64, 0) }, { name: 'Bob', pos: V(5, 64, 0) }],
    self: V(0, 64, 0), engagedUntil: new Map([['Bob', 1e15]]),
  })?.name, 'Bob');
  check('窗口里但太远（>radius）→ 不看', pickGaze({ players: [{ name: 'Ann', pos: V(20, 64, 0) }], self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15]]) }), null);
  check('刚看过（没到下次）→ 不看', pickGaze({ players: [near3], self: V(0, 64, 0), now: 0, next: 100, engagedUntil: new Map([['Ann', 1e15]]) }), null);

  // ---- 身体空不空 ----
  check('什么都没在做 → 空', bodyBusy({}), null);
  check('跟随中 → 算空（捡完接着跟）', bodyBusy({ currentAction: 'following starwish' }), null);
  check('★ 有命令在跑 → 不空', typeof bodyBusy({ inflight: 1 }), 'string');
  check('在挖矿 → 不空', typeof bodyBusy({ currentAction: 'mining 3x stone' }), 'string');
  check('开着箱子 → 不空', typeof bodyBusy({ windowOpen: true }), 'string');
  check('★ 刚被叫停 → 站着别动', typeof bodyBusy({ quietUntil: 100, now: 50 }), 'string');
  check('停的时间过了 → 空', bodyBusy({ quietUntil: 100, now: 150 }), null);

  // ---- 跟随的玩家站着不动（第 8 批 第 6 条）----
  {
    const P3 = { x: 10, y: 64, z: 10 };
    check('他还在走 → 不顺手做事', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: { x: 10, y: 64, z: 10 }, pos: { x: 14, y: 64, z: 10 }, movedAt: 0 }), null);
    check('他刚停下 3 秒 → 还不到 8 秒', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: P3, movedAt: 97000 }), null);
    check('★ 他站住 9 秒 → 可以顺手做事', !!followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: P3, movedAt: 91000 }), true);
    check('★ 读不到他的位置 → 不猜', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: null, movedAt: 0 }), null);
    check('只知道他站着但不知道站多久 → 先等一帧', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: null, pos: P3, movedAt: 0 }), null);
    check('小小抖动（<0.35 格，例如坐船/被推）→ 还算站着', !!followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: { x: 10.2, y: 64, z: 10 }, movedAt: 91000 }), true);
    check('★ 他一动就停（10 秒后又走了）→ 不顺手做事', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: { x: 12, y: 64, z: 10 }, movedAt: 91000 }), null);
  }

  // ---- 暗处插火把（第 8 批 第 4 条）----
  {
    const T = { ...CFG.torch };
    const under = { kind: 'underground', roofAt: 5, solidAbove: 9 };
    check('★ 地下 + 脚下黑 + 有火把 + 附近没光源 → 插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
    check('没火把 → 不插', pickTorchStep({ exposure: under, light: 0, torches: 0, nearestLight: null, movedSince: 10 }, T).place, false);
    check('★ 亮度读不到 → 不插（不猜）', pickTorchStep({ exposure: under, light: null, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
    check('★ 地面露天（kind=open）→ 不插（夜里黑该回家睡）', pickTorchStep({ exposure: { kind: 'open', skyLight: 15 }, light: 0, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
    check('露天但头顶有顶（sheltered + roofAt）→ 就当洞里，照插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: 3, skyLight: 5 }, light: 3, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
    check('sheltered 但读不出 roofAt → 不插', pickTorchStep({ exposure: { kind: 'sheltered', roofAt: null }, light: 3, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
    check('★ 脚下够亮（方块光 9）→ 不插', pickTorchStep({ exposure: under, light: 9, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
    check('★ 7 格内已经有光源 → 不插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: { distance: 5 }, movedSince: 10 }, T).place, false);
    check('最近光源在 9 格（>7）→ 插', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: { distance: 9 }, movedSince: 10 }, T).place, true);
    check('★ 才走了 2 格（没到 6）→ 先不检查', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: 2 }, T).place, false);
    check('★ 第一次（movedSince=Infinity）→ 也算走够了', pickTorchStep({ exposure: under, light: 0, torches: 5, nearestLight: null, movedSince: Infinity }, T).place, true);
    check('亮度刚好在阈值上（7）→ 插（判据是 ≥ 阈值才不插）', pickTorchStep({ exposure: under, light: 7, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
    check('亮度 8（阈值上一个）→ 不插', pickTorchStep({ exposure: under, light: 8, torches: 5, nearestLight: null, movedSince: 10 }, T).place, false);
    check('亮度 6 → 插', pickTorchStep({ exposure: under, light: 6, torches: 5, nearestLight: null, movedSince: 10 }, T).place, true);
    check('不插时说的理由里含"火把/光/暗"', /火把|光|暗|洞|走/.test(pickTorchStep({ exposure: under, light: 0, torches: 0, nearestLight: null, movedSince: 10 }, T).why), true);
  }

  // ---- 续挖下矿（第 8 批 第 5 条）----
  {
    const now = 2000000;
    const drec = { target: 'iron_ore', targetY: 16, at: { x: 100, y: 20, z: 100 }, entry: { x: 100, y: 64, z: 100 }, lastAt: now - 60000, interrupted: '僵尸 在 3 格外' };
    check('★ 3 分钟前被打断的下矿 → 接着挖', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
    check('★ 8 分钟前断的（超过 5 分钟）→ 不主动接着走', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now: now + 300000, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
    check('★ 记录的地方在 200 格外 → 不跨地图去接', pickDelveResume({ delve: drec, self: { x: 400, y: 20, z: 400 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
    check('从没下过矿 → 不续', pickDelveResume({ delve: null, self: { x: 0, y: 64, z: 0 }, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
    check('续挖本能关着 → 不续', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: false }).resume, false);
    check('没有位置 → 不续', pickDelveResume({ delve: drec, self: null, now, resumeMs: 300000, reach: 96, enabled: true }).resume, false);
    check('★ 续挖时带上原来的目标矿', pickDelveResume({ delve: drec, self: { x: 105, y: 20, z: 105 }, now, resumeMs: 300000, reach: 96, enabled: true }).target, 'iron_ore');
    // noteDelve：mind 下矿后被喂一条记录
    {
      const I2 = {};
      noteDelve(I2, { target: 'iron_ore', targetY: 16, seconds: 90 }, { reason: '时间到（90 秒），可以接着挖', at: { x: 1, y: 30, z: 2 }, entry: { x: 1, y: 64, z: 2 }, heading: [1, 0] }, now);
      check('★ noteDelve 记下目标', I2.delve.target, 'iron_ore');
      { const I3 = { cfg: {} }; const t = now;
        noteDelve(I3, { target: 'iron_ore' }, { reason: '血只剩 6', at: { x: 1, y: 30, z: 2 } }, t);
        check('★ 血少停下的 → 不自己接着下', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
        noteDelve(I3, { target: 'iron_ore' }, { reason: '背包快满了', at: { x: 1, y: 30, z: 2 } }, t);
        check('★ 背包满停下的 → 不自己接着下（会来回抖）', pickDelveResume({ enabled: true, delve: I3.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
        const I4 = { cfg: {} };
        noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
        for (let i = 0; i < 3; i++) noteDelve(I4, { target: 'coal_ore', resumed: true }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
        check('★ 自己接着下了 3 次 → 不再接', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, false);
        const I5 = { cfg: {} };
        noteDelve(I5, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
        noteDelve(I4, { target: 'coal_ore' }, { reason: '僵尸 在 4 格外', at: { x: 1, y: 30, z: 2 } }, t);
        check('★ mind 自己又下一次矿 → 计数归零，又能接着下', pickDelveResume({ enabled: true, delve: I4.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true);
        check('被怪打断一次 → 接着下', pickDelveResume({ enabled: true, delve: I5.delve, self: { x: 1, y: 30, z: 2 }, now: t + 1000 }).resume, true); }
      check('noteDelve 记下位置', I2.delve.at.x, 1);
      check('★ 正常结束（时间到）不算 interrupted', I2.delve.interrupted, null);
      noteDelve(I2, { target: 'iron_ore' }, { reason: '僵尸 在 4 格外', at: { x: 3, y: 20, z: 4 } }, now + 1000);
      check('★ 被怪打断 → 记 interrupted', /僵尸/.test(String(I2.delve.interrupted)), true);
      check('★ 被怪打断后 5 分钟内续挖的判据成立', pickDelveResume({ delve: I2.delve, self: { x: 3, y: 20, z: 4 }, now: now + 6000, resumeMs: 300000, reach: 96, enabled: true }).resume, true);
      const I3 = {};
      noteDelve(I3, { target: 'diamond' }, { reason: '没带火把，不下去（没有煤/木炭）' }, now);
      check('失败也记一笔（免得当成从没下过矿）', I3.delve.target, 'diamond');
    }
  }

  // ---- 遇到矿就挖：价值排序（第 8 批 第 3 条）----
  {
    const mkCfg = { radius: 16, maxDy: 6, maxVein: 8, lowWhenBelow: 16, followLeash: 16 };
    const self = { x: 0, y: 30, z: 0 };
    const O = (name, value, dist, extra = {}) => ({ name, value, tier: 'stone', pos: { x: dist, y: 30, z: 0 }, visible: true, drops: [name], ...extra });
    // 近处 mid（油矿）vs 远处 high（铁矿）→ 该选 high（第 3 条的现场：她挖了油矿没挖铁矿）
    const r1 = pickOre({ ores: [O('ltc2:underground_oil_ore', 'mid', 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
    check('★ 近处 mid 油矿 vs 远处 high 铁矿 → 挖 high（价值优先于距离）', r1.target.name, 'minecraft:iron_ore');
    // 同档才比距离
    const r2 = pickOre({ ores: [O('a:high1', 'high', 9), O('b:high2', 'high', 3)], self, pick: 2 }, mkCfg);
    check('同一档 → 近的先挖', r2.target.name, 'b:high2');
    // 没有 value 字段的 → 排最后
    const r3 = pickOre({ ores: [O('mystery:ore', undefined, 2), O('minecraft:iron_ore', 'high', 9)], self, pick: 2 }, mkCfg);
    check('★ 矿表里没有 value 的排在 high 后面', r3.target.name, 'minecraft:iron_ore');
    // 只有没价值的 → 还是挖（比什么都不做强，且能顺手补矿表）
    const r4 = pickOre({ ores: [O('mystery:ore', undefined, 3)], self, pick: 2 }, mkCfg);
    check('★ 附近只有"没价值的"矿 → 也挖（不挑三拣四）', r4.target.name, 'mystery:ore');
    // 半径从 12 放到 16：15 格外的矿现在算"眼前"
    const r5 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 15)], self, pick: 2 }, mkCfg);
    check('★ 15 格外的铁矿（>旧半径 12）→ 现在挖得到', r5.target.name, 'minecraft:iron_ore');
    const r6 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 18)], self, pick: 2 }, mkCfg);
    check('18 格外（>新半径 16）→ 还是太远', r6.target, undefined);
    // 跟随模式：矿不能离被跟的人太远
    const r7 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: 0, y: 30, z: 0 } } }, mkCfg);
    check('跟着人时：矿在她脚下（离人也近）→ 能挖', r7.target.name, 'minecraft:iron_ore');
    const r8 = pickOre({ ores: [O('minecraft:iron_ore', 'high', 14)], self, pick: 2, followIdle: { pos: { x: -14, y: 30, z: 0 } } }, mkCfg);
    check('★ 跟着人时：矿离他 28 格（>跟随半径）→ 不挖（挖完追不上）', r8.target, undefined);
  }

  // ---- 让出身体 ----
  const st = { instinct: { cfg: { pickup: { ...P } }, running: null, quietUntil: 0 } };
  let aborted = false;
  let finish;
  st.instinct.running = { abort: () => { aborted = true; finish(); }, done: new Promise(res => { finish = res; }) };
  const stC = { instinct: { cfg: { pickup: { ...P } }, running: { kind: 'combat', abort: () => {}, done: Promise.resolve() }, quietUntil: 0 } };
  return yieldBody(stC, 'POST /mine').then((y) => {
    check('★ 打架时来了挖矿命令 → 回"在打架"', typeof y?.reject, 'string');
    return yieldBody(stC, 'POST /flee');
  }).then((y) => {
    check('打架时说"逃" → 让', y?.reject, undefined);
    return yieldBody(stC, 'POST /stop');
  }).then((y) => {
    check('★ 看门狗的 /stop（不带 hold）→ 不叫停正在打的架', typeof y?.reject, 'string');
    return yieldBody(stC, 'POST /stop', { hold: true });
  }).then((y) => {
    check('主人喊"站住"（hold）→ 停', y?.reject, undefined);
    return yieldBody(st, 'POST /move');
  }).then(() => {
    check('★ 命令来了 → 本能被打断', aborted, true);
    return yieldBody(st, 'POST /stop');
  }).then(() => {
    check('★ 不带 hold 的 /stop（mind 换任务）→ 不静默', st.instinct.quietUntil, 0);
    return yieldBody(st, 'POST /stop', { hold: true });
  }).then(() => {
    check('/stop {hold} → 一段时间站着别动', st.instinct.quietUntil > Date.now(), true);
    check('chat 不碰身体', PASSIVE_POSTS.has('POST /chat'), true);
    check('pickup 会动身体', PASSIVE_POSTS.has('POST /pickup'), false);

    // ---- 收尾资格（codex fix0 #4：战斗 finally 不能清掉别人的寻路目标）----
    // ⚠️ 回归点：改前 `finally` 无条件 setGoal(null)，`ownsBodyAtCleanup` 这条判据
    //    不存在。现在"清标记"和"清目标"共用它 —— 不是当前 owner 就一个都不动。
    const myJob = { kind: 'combat' };
    const I1 = { running: myJob };
    check('★ 收尾时还是当前 owner → 有资格动身体', ownsBodyAtCleanup(I1, myJob), true);
    const otherJob = { kind: 'mine' };
    const I2 = { running: otherJob };            // 被新命令/新 job 接管了
    check('★ 已被别人接管 → 没资格（不清目标、不误清标记）', ownsBodyAtCleanup(I2, myJob), false);
    const I3 = { running: null };                // 标记已被别人提前清掉
    check('★ 标记为 null → 没资格', ownsBodyAtCleanup(I3, myJob), false);
    check('myJob 为空（没拿到 job）→ 没资格', ownsBodyAtCleanup({ running: null }, null), false);
    check('I 为空也不抛', ownsBodyAtCleanup(null, myJob), false);

    // ---- 源码形状锁：修好的两处"绕过 owner"不许改回去 ----
    const srcText = require('fs').readFileSync(__filename, 'utf8');
    // fix0 #4：战斗 finally 里的清目标必须在 ownsBodyAtCleanup 判断之内
    check('★ 战斗 finally 用 ownsBodyAtCleanup 判据（不再无条件 setGoal(null)）',
      /finally \{[\s\S]{0,200}ownsBodyAtCleanup\(I, mine\)[\s\S]{0,200}setGoal\(null\)/.test(srcText), true);
    // fix0 #5：强制上浮也必须经 runJob（有自己的 owner），不再裸调 handler
    check('★ 憋气强制上浮也走 runJob（不再裸调 POST /jump）',
      /settled[\s\S]{0,400}runJob\('breathe'/.test(srcText)
      && !/settled \? await runJob\('breathe'[^)]*\) : \{ r: await jump\(/.test(srcText), true);
    // fix1 #3：event() 先拍平换行
    check('★ event() 会拍平换行（一条事件一行）',
      /replace\(\/\[\\r\\n\]\+\/g, ' '\)/.test(srcText), true);

    // ---- wbR2 新发现（高）：憋气上浮被 runJob 拒绝时必须有补跳 ----
    // ⚠️ 回归点：改前 `const { r } = await runJob('breathe', …)` 直接吞掉早退结果，
    //    被拒 = 一跳都不跳；测试 `breatheRefused` 判据 + 源码里真的用了它。
    check('★ runJob 正常跳成 → 不算被拒', breatheRefused({ aborted: false, r: { jumped: 3 } }), false);
    check('★ runJob 早退（aborted + error，jumped 无）→ 必须补跳',
      breatheRefused({ aborted: true, r: { error: '已让出身体给紧急本能' } }), true);
    check('★ 没报错但一跳没跳（jumped 0）→ 也要补跳', breatheRefused({ aborted: false, r: { jumped: 0 } }), true);
    check('★ 被 abort 但 handler 真跳了（jumped>0）→ 不用补跳',
      breatheRefused({ aborted: true, r: { jumped: 2 } }), false);
    check('r 为空 → 保守算没跳成', breatheRefused({ aborted: true }), true);
    check('res 为空 → 保守算没跳成', breatheRefused(null), true);
    check('★ checkBreath 真的用了 breatheRefused 兜底（不是靠人记得）',
      /breatheRefused\(\{ r, aborted: bAborted \}\)/.test(srcText), true);
    check('★ 兜底里直接调 POST /jump（保命路径不能只有一条）',
      /breatheRefused[\s\S]{0,400}deps\.handlers\['POST \/jump'\]/.test(srcText), true);

    const scanRealOk = (() => {
      const mcd = require('minecraft-data')('1.20.1');
      const Chunk = require('prismarine-chunk')('1.20.1');
      const { Vec3 } = require('vec3');
      const cols = new Map();
      const colAt = (cx, cz) => { const k = `${cx},${cz}`; if (!cols.has(k)) cols.set(k, new Chunk({ minY: -64, worldHeight: 384 })); return cols.get(k); };
      const put = (x, y, z, name) => colAt(Math.floor(x / 16), Math.floor(z / 16)).setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), mcd.blocksByName[name].defaultState);
      put(3, 64, 3, 'oak_planks'); put(20, 70, -5, 'oak_planks'); put(-10, 60, 12, 'torch'); put(5, -20, 5, 'oak_planks'); put(90, 64, 0, 'oak_planks');
      colAt(-2, 0);   // 一个加载了但没东西的区块
      const world = { getColumn: (cx, cz) => cols.get(`${cx},${cz}`) || null };
      const ids = [mcd.blocksByName.oak_planks.id, mcd.blocksByName.torch.id];
      const r = scanColumnsSync({ world, registry: mcd, c: { x: 0, y: 64, z: 0 }, ids, maxDist: 40, opts: { dy: 16 } });
      const has = (x, y, z) => r.pts.some(p => p.x === x && p.y === y && p.z === z);
      const deep = scanColumnsSync({ world, registry: mcd, c: { x: 0, y: -20, z: 0 }, ids, maxDist: 40, opts: { dy: 4 } });
      return {
        found: has(3, 64, 3) && has(20, 70, -5) && has(-10, 60, 12),
        deep: deep.pts.some(p => p.x === 5 && p.y === -20 && p.z === 5),
        skipped: r.sections > 0 && r.cells < r.sections * 4096,
        unloaded: r.unloaded > 0,
        radius: !has(90, 64, 0),
      };
    })();

    // ---- 第 8 批的源码形状锁 ----
    check('★ 冻结真修：home 扫描用 scanColumns（逐 chunk 列），不再用 findBlocks 扫整圆',
      /scanColumns\(bot, c, builtIds/.test(srcText) && !/findBlocks\(\{ point: c, matching: builtIds/.test(srcText), true);
    check('★ 逐列之间让出事件循环（await yieldLoop 在列循环里）',
      /scanColumns[\s\S]{0,2600}await yieldLoop\(\)/.test(srcText), true);
    // 行为测试（用**真的** 1.20.1 区块数据，不是照着实现写的假世界 —— 第 8 批的假世界照错接口写，所以绿着上线也扫不到东西）
    check('★ 逐列扫描：真区块（prismarine-chunk 1.20.1）里放的方块都找得到', scanRealOk.found, true);
    check('★ 逐列扫描：y 为负（minY=-64）的层也找得到', scanRealOk.deep, true);
    check('★ 逐列扫描：没目标的区段整节跳过（只扫到有东西的那几节）', scanRealOk.skipped, true);
    check('★ 逐列扫描：没加载的区块记成 unloaded（读不到 ≠ 没有）', scanRealOk.unloaded, true);
    check('逐列扫描：半径外的不算', scanRealOk.radius, true);
    check('★ 家生长只扫环带（minDist 前沿），不再扫整个圆盘',
      /minDist: Math\.max\(0, Math\.min\(h\.radius, geoR\) - 4\)/.test(srcText), true);
    check('★ 暗处/耕地扫描半径封顶 32',
      /Math\.min\(geoR, 32\)/.test(srcText) && /Math\.min\(h\.radius, 32\)/.test(srcText), true);
    check('★ 家生长 30 分钟一次',
      /everyMs: 1800000/.test(srcText), true);
    check('★ 存东西时不存随身装备的判据在 hands.js（那里也有源码锁）',
      /isLoadoutItem/.test(require('fs').readFileSync(require('path').join(__dirname, 'hands.js'), 'utf8')), true);
    check('★ 挖之前先把镐子拿到身上（ensureCarried /pickaxe$/）',
      /ensureCarried\(bot, state, \(it\) => \/pickaxe\$\/\.test\(it\.name\)/.test(srcText), true);
    check('★ 挖矿被打断 → 清失败冷却、下一拍接着挖',
      /if \(aborted\) mineFails\.delete\(k\)/.test(srcText), true);
    check('★ pickTorchStep 在 tick 的本能循环里（torch 那一条）',
      /\['torch', tryTorch\]/.test(srcText), true);
    check('★ 跟随时"他站着不动才顺手做事"（followIdlePlan 在 tick 里）',
      /followIdlePlan\(\{ now, idleMs: I\.cfg\.follow\.idleMs/.test(srcText), true);
    check('★ delve 续挖在 tick 的本能循环里',
      /\['delve', tryResumeDelve\]/.test(srcText), true);

    console.log(`\n${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
  });
}

// isHostileEntity 是**转导出**（上面从 entity-registry 拿的），不是本能层自己实现的 ——
// 保留在导出里是为了不破坏既有引用（hands.js / 自测）。
module.exports = { scanColumnsIn, scanColumnsSync, caveBoundary, settleJob, ownsBodyAtCleanup, breatheRefused, syncSleepState, createCheck, CFG, fillCfg, pickEat, pickShore, shoreRingOffsets, needBreath, effectPlan, weatherChange, pickRecovery, pickCommand, homeFootprint, darkReport, mlgStep, pickCaveStep, STRUCTURE_SIGNS, recognizeStructures, pickLoot, pickTidy, isHostileEntity, mobKind, attackCooldownMs, combatPlan, COMBAT_YIELD, TIER, pickaxeTier, carriedNames, carriedTally, needTier, pickOre, pickHarvest, hazardUnder, pickStepOff, armorRank, pickArmor, toolWorn, pickGaze, gazeEngaged, whoThrew, pickPickup, bodyBusy, followIdlePlan, pickTorchStep, noteDelve, pickDelveResume, install, yieldBody, PASSIVE_POSTS, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
