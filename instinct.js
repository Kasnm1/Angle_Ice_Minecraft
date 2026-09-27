'use strict';

const storagePolicy = require('./storage-policy');

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
    maxDy: 3,               // 高低差超过这个不管（楼上楼下、悬崖底）
    followRadius: 6,        // 跟随中：离她几格内
    followLeash: 8,         // 跟随中：离玩家几格内（捡完还追得上）
    nightOutRadius: 4,      // 夜里在露天：只捡脚边的，不往黑处跑（night.js）
    settleMs: 1000,         // 落地多久后才捡
    thrownSettleMs: 2500,   // 别的玩家扔的：多等一会儿（原版拾取延迟 40 tick + 反悔时间）
    batch: 4,               // 一次最多走几堆
    maxFails: 2,            // 同一堆失败几次就先放下
    failCooldownMs: 60000,
    quietAfterStopMs: 20000,   // /stop 之后多久不动
    minHealth: 7,
    threatRadius: 12,       // 这么近有冲她来的怪就不捡
    thrownRadius: 0.6,      // 刷出点离某个玩家的"出手点"这么近 = 被他扔出来的
    timeoutMs: 6000,        // 每堆的寻路超时（/pickup 的 timeoutMs）
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
    radius: 12,             // 只挖这么近的（/mine 的 maxRadius）
    maxDy: 4,
    maxVein: 8,             // 一次最多挖几块（一条矿脉）
    lowWhenBelow: 16,       // low 价值的矿（煤…）：身上掉落物少于这个才挖
    failCooldownMs: 600000,
    cooldownMs: 5000,
  },
  sleep: { enabled: process.env.MC_INSTINCT_SLEEP !== 'false', retryMs: 180000 },
  armor: { enabled: process.env.MC_INSTINCT_ARMOR !== 'false', everyMs: 15000 },
  gaze: { enabled: process.env.MC_INSTINCT_GAZE !== 'false', radius: 6, minGapMs: 3000, maxGapMs: 6000, chatRadius: 16 },
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
  home: { grow: process.env.MC_HOME_GROW !== 'false', everyMs: 300000, gap: 8, margin: 6, cap: 128, near: 32 },
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
 * @param ctx.drops      [{ id, pos, ageMs, thrower, item }]  thrower = 谁扔的（'self' = 她自己，玩家名，null = 不是扔的）；item = 物品名或 null（读不到）
 * @param ctx.following  { pos } | null   正在跟的玩家
 * @param ctx.fails      Map id → { n, until }
 * @param ctx.canHold    (itemName|null) → boolean
 * @param ctx.now
 * @returns { ids: number[] } | { skip: string }   skip 写明为什么不捡（调试用，/instinct 看得到）
 */
function pickPickup (ctx, cfg = CFG.pickup) {
  const { self, drops = [], following = null, fails = new Map(), canHold = () => true, now = Date.now() } = ctx;
  if (!self) return { skip: '没有位置' };
  const radius = following ? cfg.followRadius : cfg.radius;
  const why = { young: 0, mine: 0, far: 0, full: 0, failed: 0 };
  const ok = [];
  for (const d of drops) {
    if (!d?.pos) continue;
    if (d.thrower === 'self') { why.mine++; continue; }
    if (d.ageMs < (d.thrower ? cfg.thrownSettleMs : cfg.settleMs)) { why.young++; continue; }
    const dist = hdist(d.pos, self);
    if (dist > radius || Math.abs(d.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (following && hdist(d.pos, following.pos) > cfg.followLeash) { why.far++; continue; }
    const f = fails.get(d.id);
    if (f && f.n >= cfg.maxFails && now < f.until) { why.failed++; continue; }
    if (!canHold(d.item)) { why.full++; continue; }
    ok.push({ id: d.id, dist });
  }
  if (!ok.length) {
    const parts = Object.entries(why).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`);
    return { skip: parts.length ? `有掉落物但都不捡（${parts.join(' ')}）` : '附近没有掉落物' };
  }
  ok.sort((a, b) => a.dist - b.dist);
  return { ids: ok.slice(0, cfg.batch).map(o => o.id) };
}

/**
 * 挖哪条矿。
 * @param ctx.ores   [{ name, pos, value, tier, drops?, visible, hazard }]  hazard = 旁边有岩浆/水
 * @param ctx.self   她的位置；ctx.pick = pickaxeTier()；ctx.have = 物品名 → 数量（判断 low 矿缺不缺）
 * @param ctx.fails  Map "x,y,z" → until
 * @returns { target, count } | { skip, lacking? }   lacking = [{ name, pos, need }] 看得见但镐子不够的（告诉 mind）
 */
function pickOre (ctx, cfg = CFG.mine) {
  const { ores = [], self, pick = -1, have = {}, fails = new Map(), now = Date.now() } = ctx;
  const early = pick < TIER.iron;   // 还没有铁镐：前期，铁和煤就是最值钱的
  if (!self) return { skip: '没有位置' };
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const lacking = [];
  const why = { far: 0, hidden: 0, hazard: 0, failed: 0, cheap: 0, tool: 0, shovel: 0 };
  const ok = [];
  for (const o of ores) {
    if (!o?.pos) continue;
    if (hdist(o.pos, self) > cfg.radius || Math.abs(o.pos.y - self.y) > cfg.maxDy) { why.far++; continue; }
    if (!o.visible) { why.hidden++; continue; }
    if (o.hazard) { why.hazard++; continue; }
    if (o.notPickaxe) { why.shovel++; continue; }   // 不是镐子挖的（化石矿要铲子）—— 矿表里标出来的
    const f = fails.get(key(o.pos));
    if (f && now < f) { why.failed++; continue; }
    const isIron = (o.drops || []).some(d => /(^|:)(raw_iron|iron_ingot|iron_nugget)$/.test(d));
    if (o.value === 'low') {
      const got = (o.drops || []).reduce((n, d) => n + (have[d] || 0), 0);
      if (got >= (early ? cfg.lowWhenBelow * 2 : cfg.lowWhenBelow)) { why.cheap++; continue; }
    }
    const need = needTier(o.tier);
    if (pick < need) { why.tool++; lacking.push({ name: o.name, pos: o.pos, need }); continue; }
    ok.push({ ...o, dist: hdist(o.pos, self), rank: (o.value === 'high' || (early && isIron)) ? 0 : o.value === 'mid' ? 1 : (early ? 1 : 2) });
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

/** 看谁：6 格内最近的玩家；没到下次看的时间就不看 */
function pickGaze ({ players = [], self, now = Date.now(), next = 0 }, cfg = CFG.gaze) {
  if (!self || now < next) return null;
  const d = (p) => Math.hypot(p.pos.x - self.x, p.pos.y - self.y, p.pos.z - self.z);
  const near = players.filter(p => p?.pos && d(p) <= cfg.radius).sort((a, b) => d(a) - d(b));
  return near[0] || null;
}

// ---- 战斗
/** 怪是哪一类。held = 它手上拿的物品名（mineflayer entity.equipment[0]），模组远程怪靠这个认 */
const HOSTILE_NAME_RE = /^(blaze|bogged|breeze|creeper|drowned|elder_guardian|endermite|enderman|evoker|ghast|giant|guardian|husk|magma_cube|phantom|piglin|piglin_brute|pillager|ravager|shulker|silverfish|skeleton|slime|spider|stray|vex|vindicator|warden|witch|wither|wither_skeleton|zoglin|zombie|zombie_villager|zombified_piglin)$/;
function isHostileEntity (entity) {
  if (!entity || entity.type === 'player') return false;
  if (entity.type === 'hostile') return true;
  const n = String(entity.name || '').replace(/^.*:/, '').toLowerCase();
  return HOSTILE_NAME_RE.test(n);
}
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
 * @param ctx.targets [{ id, name, pos, dist, on, evidence, kind }]  已经过滤成"有仇恨的"
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
  if (t.kind === 'ranged' && !hasShield && t.dist > cfg.reach) return { mode: 'avoid', target: t, keep: cfg.rangedKeep };
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
function syncSleepState (bot, sleepAnchor = null) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys;
  const index = keys?.indexOf('pose') ?? -1;
  const pose = index >= 0 ? bot.entity?.metadata?.[index] : undefined;
  if (!Number.isInteger(pose) || pose < 0) {
    // 某些登录/重连包没有 pose，但身体已经走离当时睡觉的位置：这比旧缓存可靠。
    const moved = !!(bot.isSleeping && sleepAnchor && bot.entity?.position
      && bot.entity.position.distanceTo(sleepAnchor) > 1.5);
    if (moved) { bot.isSleeping = false; bot.emit('wake'); }
    return { pose: null, sleeping: !!bot.isSleeping, corrected: moved, reason: moved ? '已走离睡觉位置' : '姿态未读到' };
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
  };
  // 跨重连保留状态；新加的本能补上默认配置（老的 state.instinct 里没有）
  fillCfg(I.cfg);
  I.diagnostics = {};
  I.urgent = null;
  let ended = false;
  let sleepAnchor = null;
  const sleeping = () => {
    if (bot.isSleeping && !sleepAnchor && bot.entity?.position) sleepAnchor = bot.entity.position.clone();
    const result = syncSleepState(bot, sleepAnchor);
    if (!result.sleeping) sleepAnchor = null;
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
  bot.on('playerCollect', (collector, collected) => {
    try {
      if (collector !== bot.entity) return;
      const s = spawned.get(collected?.id);
      if (!s?.thrower || s.thrower === 'self') return;
      const item = deps.droppedItemOf(collected)?.name;
      if (item) state.ledger?.note({ gift: { from: s.thrower, item } });
    } catch (_) {}
  });
  bot.on('entityGone', (e) => { spawned.delete(e?.id); fails.delete(e?.id); });

  const note = (entry) => {
    I.log.push({ t: Date.now(), ...entry });
    if (I.log.length > 30) I.log.shift();
  };

  function canHold (itemName) {
    try {
      if (bot.inventory.emptySlotCount() > 0) return true;
      if (!itemName) return false;   // 读不出是什么，又没有空格 —— 保守：不去
      return bot.inventory.items().some(i => i.name === itemName && i.count < (i.stackSize || 64));
    } catch (_) { return false; }
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
    I.events.push({ seq: ++I.evSeq, t: Date.now(), kind, text, ...extra });
    if (I.events.length > 50) I.events.shift();
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
      ids, count: ids.length, radius: I.cfg.pickup.radius + 2, timeoutMs: I.cfg.pickup.timeoutMs, abort,
    }));
    // 还在地上的 = 没捡到（被别人捡走/消失的会先触发 entityGone，不算她失败）
    for (const id of ids) {
      if (!bot.entities[id]) continue;
      const f = fails.get(id) || { n: 0, until: 0 };
      f.n++; f.until = Date.now() + I.cfg.pickup.failCooldownMs;
      fails.set(id, f);
    }
    note({ kind: 'pickup', aborted: aborted || undefined, ids: ids.length, picked: r?.picked ?? 0, error: r?.error });
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

  async function tryMine () {
    const M = I.cfg.mine;
    if (!M.enabled || Date.now() - (I.lastMineAt || 0) < M.cooldownMs) return null;
    if (bot.inventory.emptySlotCount() < CFG.minFreeSlots) return { skip: '背包快满了，不挖' };
    const T = loadTables();
    if (!T.oresLoaded || !T.ores.size) return { skip: '没有矿表（knowledge/ores.json）' };
    const pts = bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: M.radius, count: 64 });
    const ores = pts.map(p => {
      const b = bot.blockAt(p); if (!b) return null;
      const row = T.ores.get(b.type);
      return { name: row.name, pos: p, value: row.value, tier: row.tier, notPickaxe: !!row.notPickaxe, drops: (row.drops || []).map(bareName), visible: bot.canSeeBlock(b), hazard: hazardAround(p) };
    }).filter(Boolean);
    const have = {};
    for (const it of bot.inventory.items()) have[bareName(it.name)] = (have[bareName(it.name)] || 0) + it.count;
    const pick = pickOre({ ores, self: bot.entity.position, pick: pickaxeTier(bot.inventory.items().map(i => i.name)), have, fails: mineFails });
    // 看得见、值钱、但镐子不够：告诉 mind（一个位置只说一次）
    for (const l of pick.lacking || []) {
      const k = `${l.pos.x},${l.pos.y},${l.pos.z}`;
      if (I.told.has(k)) continue;
      I.told.add(k);
      event('ore_lacking_tool', `看见 ${l.name}（${k}），但要${TIER_NAME[l.need] || '更好的镐子'}才挖得出东西`, { ore: l.name, pos: l.pos });
    }
    if (!pick.target) return pick;
    I.lastMineAt = Date.now();
    const { r, aborted } = await runJob('mine', { route: 'POST /mine' }, (abort) => deps.handlers['POST /mine']({
      blockName: pick.target.name, count: pick.count, maxRadius: M.radius, abort,
    }));
    const got = typeof r?.mined === 'number' ? r.mined : 0;   // /mine 回的是挖掉的块数
    const k = `${pick.target.pos.x},${pick.target.pos.y},${pick.target.pos.z}`;
    if (!got && !aborted) mineFails.set(k, Date.now() + M.failCooldownMs);
    note({ kind: 'mine', ore: pick.target.name, aborted: aborted || undefined, mined: got, error: r?.error });
    if (got) event('mine', `看见 ${pick.target.name} 就顺手挖了 ${got} 块`, { ore: pick.target.name });
    return { did: 'mine' };
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
  const structureBlocks = (radius) => {
    if (!signIds) signIds = Object.values(bot.registry.blocksByName).filter(b => STRUCTURE_SIGNS.some(S => S.re.test(b.name))).map(b => b.id);
    return bot.findBlocks({ matching: signIds, maxDistance: radius, count: 128 })
      .map(p => bot.blockAt(p)).filter(b => b && bot.canSeeBlock(b)).map(b => ({ name: b.name, pos: b.position }));
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
    const pick = pickLoot({
      chests, structures: chests ? [] : recognizeStructures(structureBlocks(L.structRadius)),
      hp: bot.health ?? 20, free: bot.inventory.emptySlotCount(),
      packFree: deps.hands.wearingBackpack?.(bot, state) && bp ? bp.slots - bp.used : null,
      nightOut, visited: I.visitedStructures, self,
    }, L);
    // 认出有 boss 的遗迹：只告诉 mind（一座一次），去不去她定
    if (!chests) {
      for (const S of recognizeStructures(structureBlocks(L.structRadius)).filter(x => x.danger)) {
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
    d.recovered = true;   // 每次死只回去一次（成不成都不来回折腾）
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
  const homeTimer = setInterval(() => {
    try {
      const H = I.cfg.home; const h = I.home;
      if (!H.grow || !h || !bot.entity) return;
      if (Date.now() - (I.lastHomeScan || 0) < H.everyMs) return;
      if (Math.hypot(bot.entity.position.x - h.center.x, bot.entity.position.z - h.center.z) > h.radius + H.near) return;   // 不在家附近：区块可能没加载，数不准
      I.lastHomeScan = Date.now();
      if (!builtIds) builtIds = Object.values(bot.registry.blocksByName).filter(b => deps.isPlayerBuilt?.(b.name) || /farmland/.test(b.name)).map(b => b.id);
      const { Vec3 } = require('vec3');
      const c = new Vec3(h.center.x, h.center.y, h.center.z);
      const pts = bot.findBlocks({ point: c, matching: builtIds, maxDistance: Math.min(H.cap, h.radius + H.near), count: 4000 })
        .filter(p => Math.abs(p.y - h.center.y) <= 16);
      const r = homeFootprint(pts.map(p => Math.hypot(p.x - h.center.x, p.z - h.center.z)), h.radius, H);
      // 顺便看看家里的耕地湿不湿（moisture=0 = 4 格内没水，会退化回泥土、庄稼长得慢）—— 只告诉 mind，不自己引水（会动主人的布局）
      const dryIds = ['farmland'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
      const dry = bot.findBlocks({ point: c, matching: dryIds, maxDistance: h.radius, count: 400 })
        .map(p => bot.blockAt(p)).filter(b => b && +(b.getProperties?.().moisture ?? 7) === 0);
      const day = Math.floor(Date.now() / 86400000);
      if (dry.length && I.dryToldDay !== day) {
        I.dryToldDay = day;
        const p0 = dry[0].position;
        event('farmland_dry', `家里有 ${dry.length} 块耕地是干的（比如 ${p0.x},${p0.y},${p0.z}）：4 格内没有水，会退化回泥土、庄稼长得慢`, { count: dry.length });
      }
      // 顺便看看家里有没有暗处（光照 0 夜里会刷怪）—— 只告诉 mind，不自己插火把
      if (I.darkToldDay !== day) {
        const LIGHT_RE = /(^|:|_)(torch|lantern|glowstone|shroomlight|froglight|campfire|redstone_lamp|end_rod|candle|light)$/;
        const srcIds = Object.values(bot.registry.blocksByName).filter(b => LIGHT_RE.test(b.name) && !/redstone_torch|soul_torch_off/.test(b.name)).map(b => b.id);
        const sourceLights = bot.findBlocks({ point: c, matching: srcIds, maxDistance: h.radius, count: 64 })
          .filter(p => Math.abs(p.y - h.center.y) <= 8).map(p => bot.blockAt(p)?.light);
        const airIds = ['air', 'cave_air'].map(n => bot.registry.blocksByName[n]?.id).filter(v => v != null);
        const cells = [];
        for (const p of bot.findBlocks({ point: c, matching: airIds, maxDistance: Math.min(h.radius, 32), count: 3000 })) {
          if (Math.abs(p.y - h.center.y) > 4) continue;
          const below = bot.blockAt(p.offset(0, -1, 0)); const head = bot.blockAt(p.offset(0, 1, 0));
          if (!below || below.boundingBox !== 'block' || /farmland|glass|leaves|slab|stairs|carpet|water|lava/.test(below.name)) continue;
          if (!head || head.boundingBox !== 'empty') continue;
          cells.push({ pos: { x: p.x, y: p.y, z: p.z }, light: bot.blockAt(p)?.light });
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
        event('home_grow', `家的范围跟着房子长大了：半径 ${old} → ${r} 格（数到 ${pts.length} 块人造方块）`, { radius: r, center: h.center });
      }
    } catch (_) {}
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
        hasBucket: bot.inventory.items().some(i => i.name === 'water_bucket'), holding: bot.heldItem?.name === 'water_bucket',
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
      const pick = pickaxeTier(bot.inventory.items().map(i => i.name));
      for (const p of bot.findBlocks({ matching: [...T.ores.keys()], maxDistance: 12, count: 16 })) {
        const b = bot.blockAt(p); if (!b || !bot.canSeeBlock(b)) continue;
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
    const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
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
      pack = { free: bp ? bp.slots - bp.used : null, has: short.length ? deps.hands.kitAvailable(bot, packItems, short) : [] };
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
      const have = [k.pack?.has?.length ? `背包里有：${k.pack.has.join('、')}` : null,
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
  let nextGaze = 0;
  const lookAtPlayer = (ent) => {
    try { bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true); } catch (_) {}
  };
  const idleEyes = () => !I.running && !I.inflight && !bot.isSleeping && !bot.currentWindow && !bot.pathfinder?.isMoving?.() && !bot.targetDigBlock;
  const gazeTimer = setInterval(() => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || !bot.entity || !idleEyes()) return;
      const players = Object.values(bot.players || {}).filter(p => p.entity && p.entity !== bot.entity).map(p => ({ ent: p.entity, pos: p.entity.position }));
      const g = pickGaze({ players, self: bot.entity.position, now: Date.now(), next: nextGaze }, G);
      if (!g) return;
      lookAtPlayer(g.ent);
      nextGaze = Date.now() + G.minGapMs + Math.random() * (G.maxGapMs - G.minGapMs);
    } catch (_) {}
  }, 1000);
  bot.on('chat', (username) => {
    try {
      const G = I.cfg.gaze;
      if (!G.enabled || username === bot.username || !idleEyes()) return;
      const ent = bot.players[username]?.entity;
      if (!ent || ent.position.distanceTo(bot.entity.position) > G.chatRadius) return;
      lookAtPlayer(ent);
      nextGaze = Date.now() + G.maxGapMs;
    } catch (_) {}
  });

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
    if (I.inflight > 0 || state.currentAction) deps.cancelCommands?.(`战斗本能：${first.name} ${first.on === 'me' ? '冲她来了' : `在打 ${first.on}`}`);
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
    I.running = { kind: 'combat', abort: () => { aborted = true; try { bot.pathfinder.setGoal(null); } catch (_) {} }, done: job };
    try { await job; } catch (_) {} finally {
      shield(false);
      try { bot.pathfinder.setGoal(null); } catch (_) {}
      I.running = null;
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
      if (!targets.length) { d.skip = '没有仇恨证据'; return; }
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
      event('breathe', `在水里憋不住气了（氧气 ${bot.oxygenLevel}/20），先游上去换气`);
      const old = I.running;
      if (!await settleJob(old)) { d.skip = '等待旧本能收尾'; return; }
      if (ended || I.urgent !== 'breathe') return;
      const { r } = await runJob('breathe', null, (abort) => deps.handlers['POST /jump']({ durationMs: I.cfg.breathe.jumpMs, stopAtOxygen: 18, abort }));
      note({ kind: 'breathe', oxygen: r?.oxygen, jumped: r?.jumped });
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
    const cells = [];
    for (let dx = -S.radius; dx <= S.radius; dx++) for (let dz = -S.radius; dz <= S.radius; dz++) for (let dy = -2; dy <= 3; dy++) {
      const p = me.offset(dx, dy, dz);
      const f = bot.blockAt(p); if (!f || /water/.test(f.name)) continue;
      const b = bot.blockAt(p.offset(0, -1, 0)); if (!b || b.boundingBox !== 'block') continue;
      const h = bot.blockAt(p.offset(0, 1, 0));
      cells.push({ pos: p, below: b.name, feet: f.name, head: h?.name, ok: require('./place').isStandable(f) && require('./place').isStandable(h) });
    }
    const pick = pickShore(cells, me);
    if (!pick) { note({ kind: 'shore', skip: `${S.radius} 格内没找到能上的岸` }); return; }
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

    // ① 拾取（掉落物 5 分钟就没了，最先）
    if (P.enabled) {
      const drops = Object.values(bot.entities)
        .filter(e => e?.position && e.isValid !== false && deps.isDropEntity(e))
        .map(e => {
          const sp = spawned.get(e.id);
          // 本能装上之前就在地上的：没有刷出记录，当作早就落地、不是扔的
          return { id: e.id, pos: e.position, ageMs: sp ? now - sp.t : Infinity, thrower: sp ? sp.thrower : null, item: deps.droppedItemOf(e)?.name ?? null };
        });
      // 夜里在露天：半径收到脚边
      const cfg = nightOut ? { ...P, radius: Math.min(P.radius, P.nightOutRadius), followRadius: Math.min(P.followRadius, P.nightOutRadius) } : P;
      const pick = pickPickup({ self: bot.entity.position, drops, fails, canHold, now, following: followEnt ? { pos: followEnt.position } : null }, cfg);
      last.pickup = pick.skip || `捡 ${pick.ids.length} 堆`;
      if (pick.ids) { I.last = { t: now, ...last }; await runPickup(pick.ids, followName); return; }
    }
    // 跟着人走：只捡东西
    if (followName) { I.last = { t: now, ...last, other: `跟着 ${followName}，只捡东西` }; return; }
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
    for (const [k, f] of [['harvest', tryHarvest], ['loot', () => tryLoot(nightOut)], ['mine', tryMine], ['cave', tryCave]]) {
      const r = await f();
      if (!r) continue;
      if (r.did) { I.last = { t: now, ...last, [k]: '做了' }; return; }
      last[k] = r.skip;
    }
    I.last = { t: now, ...last };
  }

  let ticking = false;
  let lastTickAt = Date.now();
  let tickStartedAt = 0;
  const timer = setInterval(async () => {
    const now = Date.now();
    I.scheduler = { at: now, maxLagMs: Math.max(I.scheduler?.maxLagMs || 0, now - lastTickAt - CFG.pickup.tickMs), lagMs: Math.max(0, now - lastTickAt - CFG.pickup.tickMs), busyForMs: ticking ? now - tickStartedAt : 0 };
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
  const r = pickPickup({ self: me, drops: many });
  check('一次最多 batch 堆', r.ids.length, P.batch);
  check('从近到远', r.ids.join(','), '2,4,5,3');
  check('跳过的原因写得出来', /mine=1/.test(pickPickup({ self: me, drops: [d(1, 3, 0, { thrower: 'self' })] }).skip), true);
  check('没有掉落物 → 如实说没有', pickPickup({ self: me, drops: [] }).skip, '附近没有掉落物');

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
  check('失败过的格子冷却中 → 不挖', O([ore('iron_ore', 3, 0)], { fails: new Map([['3,64,0', 1e15]]), now: 0 }).target, undefined);

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
  check('★ 骷髅、没盾 → 躲', combatPlan({ targets: [T('skeleton', 8)] })?.mode, 'avoid');
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

  // ---- 转头看人 ----
  const V = (x, y, z) => ({ x, y, z });
  check('6 格内有人 → 看他', pickGaze({ players: [{ pos: V(3, 64, 0) }], self: V(0, 64, 0) })?.pos.x, 3);
  check('太远 → 不看', pickGaze({ players: [{ pos: V(20, 64, 0) }], self: V(0, 64, 0) }), null);
  check('刚看过（没到下次）→ 不看', pickGaze({ players: [{ pos: V(3, 64, 0) }], self: V(0, 64, 0), now: 0, next: 100 }), null);

  // ---- 身体空不空 ----
  check('什么都没在做 → 空', bodyBusy({}), null);
  check('跟随中 → 算空（捡完接着跟）', bodyBusy({ currentAction: 'following starwish' }), null);
  check('★ 有命令在跑 → 不空', typeof bodyBusy({ inflight: 1 }), 'string');
  check('在挖矿 → 不空', typeof bodyBusy({ currentAction: 'mining 3x stone' }), 'string');
  check('开着箱子 → 不空', typeof bodyBusy({ windowOpen: true }), 'string');
  check('★ 刚被叫停 → 站着别动', typeof bodyBusy({ quietUntil: 100, now: 50 }), 'string');
  check('停的时间过了 → 空', bodyBusy({ quietUntil: 100, now: 150 }), null);

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
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
  });
}

module.exports = { caveBoundary, settleJob, syncSleepState, createCheck, CFG, fillCfg, pickEat, pickShore, needBreath, effectPlan, weatherChange, pickRecovery, pickCommand, homeFootprint, darkReport, mlgStep, pickCaveStep, STRUCTURE_SIGNS, recognizeStructures, pickLoot, pickTidy, isHostileEntity, mobKind, attackCooldownMs, combatPlan, COMBAT_YIELD, TIER, pickaxeTier, needTier, pickOre, pickHarvest, hazardUnder, pickStepOff, armorRank, pickArmor, toolWorn, pickGaze, whoThrew, pickPickup, bodyBusy, install, yieldBody, PASSIVE_POSTS, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
