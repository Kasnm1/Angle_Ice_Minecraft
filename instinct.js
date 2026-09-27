'use strict';

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
 *   · 这是唯一会**反过来打断命令**的本能：正在挖矿时怪扑上来 → cancelCommands() 叫停命令，先打。
 *     打的时候除了 停/逃/跟随/走 这几类，其他命令直接回"在打架"（不然两边抢身体）。
 *   · 打完：跟着人的接着跟；自己干活的走回锚点；告诉 mind 打了什么、剩多少血
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
    if (o.value === 'low') {
      const got = (o.drops || []).reduce((n, d) => n + (have[d] || 0), 0);
      if (got >= cfg.lowWhenBelow) { why.cheap++; continue; }
    }
    const need = needTier(o.tier);
    if (pick < need) { why.tool++; lacking.push({ name: o.name, pos: o.pos, need }); continue; }
    ok.push({ ...o, dist: hdist(o.pos, self), rank: o.value === 'high' ? 0 : o.value === 'mid' ? 1 : 2 });
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
function hazardUnder ({ feet = null, below = null } = {}) {
  if (feet && HURT_FEET.test(feet)) return `陷在 ${feet} 里`;
  if (below && HURT_BELOW.test(below)) return `站在 ${below} 上`;
  return null;
}
/**
 * 往哪挪。cells：身边 8 格 [{ dx, dz, feet, head, below }]（方块名，null = 读不到）。
 * 要求：脚和头那格是空的（空气类）、脚下是实心且不伤人、不是岩浆/水。读不到的格子不去（不猜）。
 */
function pickStepOff (cells = []) {
  const open = (n) => n != null && /(^|:)(air|cave_air|void_air|short_grass|grass|tall_grass|fern|snow)$/.test(n);
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
  for (const k of ['pickup', 'harvest', 'mine', 'sleep', 'armor', 'gaze', 'combat', 'tidy']) I.cfg[k] = { ...CFG[k], ...(I.cfg[k] || {}) };
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
    let aborted = false;
    const endLedger = state.ledger && ledgerEv ? state.ledger.begin(ledgerEv) : null;
    const done = (async () => {
      try { return await fn(() => aborted); } catch (e) { return { error: e.message }; }
    })();
    I.running = {
      kind,
      abort: () => {
        aborted = true;
        try { bot.pathfinder.stop(); } catch (_) {}
        try { bot.stopDigging(); } catch (_) {}
      },
      done,
    };
    try { return { r: await done, aborted }; } finally {
      I.running = null;
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
  async function tryStepOff () {
    const f = bot.entity.position.floored();
    const nm = (p) => bot.blockAt(p)?.name ?? null;
    const why = hazardUnder({ feet: nm(f), below: nm(f.offset(0, -1, 0)) });
    if (!why) return null;
    const cells = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = f.offset(dx, 0, dz);
      cells.push({ dx, dz, feet: nm(c), head: nm(c.offset(0, 1, 0)), below: nm(c.offset(0, -1, 0)) });
    }
    const to = pickStepOff(cells);
    if (!to) { event('hazard_stuck', `${why}，旁边也没有能站的地方`); return { skip: why }; }
    const { goals } = require('mineflayer-pathfinder');
    await runJob('stepoff', null, async () => {
      await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(f.x + to.dx, f.y, f.z + to.dz)), new Promise(r => setTimeout(r, 2500))]);
      try { bot.pathfinder.setGoal(null); } catch (_) {}
    });
    note({ kind: 'stepoff', why });
    return { did: 'stepoff' };
  }

  // ---- 夜里在家有床就睡
  async function trySleep () {
    const S = I.cfg.sleep;
    if (!S.enabled || bot.isSleeping || Date.now() < (I.sleepRetryAt || 0)) return null;
    if (deps.night?.phaseOf(bot.time?.timeOfDay) !== 'night') return null;
    if (inHome(bot.entity.position) !== true) return { skip: '不在家（或不知道家在哪）' };
    const { r } = await runJob('sleep', null, () => deps.handlers['POST /sleep']({ home: I.home }));
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
      for (let round = 0; round < 2 && !abort(); round++) {
        let u = null;
        if (deps.hands.wearingBackpack?.(bot, state)) {
          try { u = await deps.handlers['POST /backpack/tidy']({ stash: false, restock: false, unpack: true, abort }); } catch (_) {}
          unpacked += u?.unpacked || 0;
        }
        r = await deps.handlers['POST /storage/organize']({ abort });
        if (!u?.unpacked) break;
      }
      return { ...r, unpacked };
    });
    const after = kitNow();
    note({ kind: 'tidy', why: pick.why, aborted: aborted || undefined, moved: r?.moved, error: r?.error });
    if (!aborted) {
      event('tidy', r?.error
        ? `想回家整理（${pick.why}），没做成：${String(r.error).slice(0, 80)}`
        : `回家整理了（${pick.why}）：搬了 ${r?.moved ?? 0} 组${r?.unpacked ? `（其中从背包倒出来 ${r.unpacked} 组）` : ''}${after.short.length ? `；还缺 ${after.short.join('、')}` : '，该带的都带上了'}`);
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
      if (!a) continue;
      out.push({ id: e.id, ent: e, name: e.name, pos: e.position, dist, on: a.on, evidence: a.evidence, kind: mobKind(e.name, e.equipment?.[0]?.name) });
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
    // 手上有命令 / 在做别的本能：叫停，先打（这是唯一反过来打断命令的本能）
    if (I.running && I.running.kind !== 'combat') { I.running.abort(); await Promise.race([I.running?.done, sleepMs(800)]).catch(() => {}); }
    const interrupted = I.inflight > 0 || (state.currentAction && !followName) ? (state.currentAction || '一个命令') : null;
    if (I.inflight > 0 || state.currentAction) deps.cancelCommands?.(`战斗本能：${first.name} ${first.on === 'me' ? '冲她来了' : `在打 ${first.on}`}`);
    const anchorAt = () => (followName ? bot.players[followName]?.entity?.position : null) || I.combat.anchor;
    I.combat = { anchor: bot.entity.position.clone(), engaged: new Set(), killed: [], started: Date.now(), followName, hp0: bot.health };
    const hasShield = await equipForFight();
    let lastSeen = Date.now(); let lastHit = 0; let shieldUp = false; let lastMode = null; let lastTargetId = null;
    const shield = (up) => { if (up === shieldUp) return; shieldUp = up; try { up ? bot.activateItem(true) : bot.deactivateItem(); } catch (_) {} };
    let aborted = false;
    const job = (async () => {
      while (!aborted && Date.now() - I.combat.started < C.maxMs) {
        const targets = hostileTargets();
        const a = anchorAt();
        const plan = combatPlan({ targets, hp: bot.health ?? 20, hasShield, anchor: a ? { x: a.x, y: a.y, z: a.z } : null }, C);
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
    // 收尾：跟着人的接着跟；自己干活的走回锚点（叫停的不动）
    if (aborted) return;
    if (followName && bot.players[followName]?.entity) { try { deps.hands.startFollow(bot, state, followName, 2); } catch (_) {} return; }
    if (cb.anchor && bot.entity.position.distanceTo(cb.anchor) > 3) {
      try { await Promise.race([bot.pathfinder.goto(new goals.GoalNear(cb.anchor.x, cb.anchor.y, cb.anchor.z, 1)), sleepMs(15000)]); } catch (_) {}
      try { bot.pathfinder.setGoal(null); } catch (_) {}
    }
  }

  // 战斗的"眼睛"：比别的本能快（250ms），不等身体空闲 —— 这是唯一抢身体的本能
  let fighting = false;
  const combatTimer = setInterval(async () => {
    if (fighting || !bot.entity || bot.isSleeping || !I.cfg.combat.enabled) return;
    if (I.running?.kind === 'combat' || bot.currentWindow) return;
    try {
      const targets = hostileTargets();
      if (!targets.length) return;
      const plan = combatPlan({ targets, hp: bot.health ?? 20, hasShield: /shield/.test(bot.inventory.slots[45]?.name || '') || bot.inventory.items().some(i => /shield/.test(i.name)), anchor: null }, I.cfg.combat);
      if (!plan) return;
      fighting = true;
      await fight(plan.target);
    } catch (e) { I.last = { t: Date.now(), error: `combat: ${e.message}` }; } finally { fighting = false; }
  }, CFG.combat.scanMs);

  async function tick () {
    if (I.running || !bot.entity || bot.isSleeping || fighting) return;
    // ⓪ 危险方块：身体没被命令占着就挪开（不看"刚被叫停"—— 站在岩浆块上不能听"别动"）
    if (!I.inflight && !bot.currentWindow && (!state.currentAction || /^following /.test(state.currentAction))) {
      const h = await tryStepOff();
      if (h?.did) { I.last = { t: Date.now(), hazard: '挪开了' }; return; }
    }
    const P = I.cfg.pickup;
    const busy = bodyBusy({
      inflight: I.inflight, currentAction: state.currentAction,
      windowOpen: !!bot.currentWindow, quietUntil: I.quietUntil,
    });
    if (busy) { I.last = { t: Date.now(), skip: busy }; return; }
    if ((bot.health ?? 20) < P.minHealth) { I.last = { t: Date.now(), skip: `血 ${bot.health}，不弯腰` }; return; }
    const danger = threatened();
    if (danger) { I.last = { t: Date.now(), skip: danger }; return; }

    const followName = /^following (.+)$/.exec(state.currentAction || '')?.[1] || null;
    const followEnt = followName ? bot.players[followName]?.entity : null;
    let nightOut = false;
    try {
      const ph = deps.night?.phaseOf(bot.time?.timeOfDay);
      nightOut = (ph === 'night' || ph === 'dusk') && deps.night.isOut(deps.exposureOf(bot)?.kind);
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
    // ③ 回家整理（背包快满 / 缺吃的缺镐子而家里有）—— 夜里家近也回
    const td = await tryTidy(nightOut);
    if (td?.did) { I.last = { t: now, ...last, tidy: '做了' }; return; }
    if (td?.skip) last.tidy = td.skip;
    if (nightOut) { I.last = { t: now, ...last, other: '夜里在露天，不收不挖' }; return; }

    // ③ 收获  ④ 采矿  ⑤ 换护甲
    for (const [k, f] of [['harvest', tryHarvest], ['mine', tryMine], ['armor', tryArmor]]) {
      const r = await f();
      if (!r) continue;
      if (r.did) { I.last = { t: now, ...last, [k]: '做了' }; return; }
      last[k] = r.skip;
    }
    I.last = { t: now, ...last };
  }

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await tick(); } catch (e) { I.last = { t: Date.now(), error: e.message }; } finally { ticking = false; }
  }, CFG.pickup.tickMs);
  bot.once('end', () => { clearInterval(timer); clearInterval(gazeTimer); clearInterval(toolTimer); clearInterval(combatTimer); clearInterval(kitTimer); });
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
  const r = I.running;
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

module.exports = { CFG, pickTidy, mobKind, attackCooldownMs, combatPlan, COMBAT_YIELD, TIER, pickaxeTier, needTier, pickOre, pickHarvest, hazardUnder, pickStepOff, armorRank, pickArmor, toolWorn, pickGaze, whoThrew, pickPickup, bodyBusy, install, yieldBody, PASSIVE_POSTS, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  selftest().then(code => process.exit(code));
}
