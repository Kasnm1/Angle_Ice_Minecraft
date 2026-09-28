'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「config」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const __ns = {};
function pickTorchStep (...a) { return __ns.pickTorchStep.apply(null, a); }
function bind (ns) { Object.assign(__ns, ns);  }

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
  // 玩家挨打：**只有真的危险才**告诉 mind（主人 2026-09-29 实机：掉一点血她每次都问"你没事吧"）。
  //
  // 原判据是"48 格内玩家挨打就发" + 同一人 20 秒冷却 —— 摔一下、被怪擦一下都算，
  // 于是她一天问候十几遍。现在改成按**严重度**判：小伤不吭声，只有下面任一条成立才发：
  //   ① 血量低：victim health ≤ lowHp（8 = 4 颗心）。原版玩家 20 血，8 血已是"再不治要出事"的量，
  //      而且这时她该做的是去帮忙/给吃的，不是寒暄。
  //   ② 短时间内掉血很多：windowMs（10 秒）内累计 ≥ burstHp（6 = 3 颗心）。
  //      连续被怪打、摔了一跤、火烧，都是这种"一下子掉了不少"的形态。
  //   ③ 被怪连续打：windowMs 内挨打次数 ≥ burstHits（3）。有些怪单次伤害低（小僵尸 2 点），
  //      单看一次掉血不够，但连挨三下就是"被围攻"了。
  // 判定依据见 core.js 的 playerHurtPlan()：**"没有"和"读不到"分开** ——
  // 读不到血量时不许当成满血（漏报）也不许当成危险（误报），只按 ③ 的挨打次数判。
  playerHurt: {
    enabled: process.env.MC_INSTINCT_PLAYER_HURT !== 'false',
    radius: 48,
    quietMs: 180000,   // 同一玩家：发过之后 3 分钟内不再发（原来是 20 秒，实机太吵）
    lowHp: 8,          // 血量 ≤ 这个 = 真的危险（4 颗心）
    burstHp: 6,        // 窗口内累计掉这么多血 = 掉得很多（3 颗心）
    burstHits: 3,      // 窗口内挨打这么多次 = 被怪连着打（读不到血量时的唯一判据）
    windowMs: 10000,   // 上面两个"短时间"有多短
    maxHp: 20,         // 血量上限；读到的值比它大 = 读到的不是玩家血量（当读不到处理）
  },
  minFreeSlots: 2,          // 收获、采矿至少留几个空格
  yieldWaitMs: 1500,        // 让出身体时最多等本能收拾多久
};

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

// 镐子等级。原版按材质；模组镐认不出材质的按石镐算（宁可少挖，不白敲）
const TIER = { wood: 0, gold: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };

const TIER_NAME = ['木镐', '石镐', '铁镐', '钻石镐', '下界合金镐'];

// ---- 护甲：按材质排。认不出材质 = null（不自动换下已穿的）
const ARMOR_RANK = [[/leather/, 1], [/golden|gold_/, 2], [/chainmail/, 3], [/turtle/, 4], [/iron/, 4], [/diamond/, 5], [/netherite/, 6]];

// ---- 危险方块：脚下 / 脚所在那格
const HURT_FEET = /(^|:)(sweet_berry_bush|powder_snow|fire|soul_fire|campfire|soul_campfire|cactus|wither_rose|cobweb)$/;

const HURT_BELOW = /(^|:)(magma_block|campfire|soul_campfire)$/;
/** 站的地方伤人吗。返回原因或 null。feet / below 是方块名（读不到给 null） */

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

const COMBAT_YIELD = new Set(['POST /stop', 'POST /flee', 'POST /follow', 'POST /go', 'POST /move', 'POST /self_rescue']);

const PASSIVE_POSTS = new Set([
  'POST /chat', 'POST /instinct', 'POST /knowledge/search', 'POST /registry/import-palette', 'POST /reconnect',
  'POST /look', 'POST /memory', 'POST /project/save', 'POST /doors/forget-left-open',
]);

module.exports = { ARMOR_RANK, CFG, COMBAT_YIELD, HURT_BELOW, HURT_FEET, PASSIVE_POSTS, STRUCTURE_SIGNS, TIER, TIER_NAME, bind, fillCfg };
