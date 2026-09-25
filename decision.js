/**
 * 决策层 —— 把"现在该干什么"从写死的 if-else 里抽出来。
 *
 * ## 为什么要抽
 *
 * 原来 autopilot 的 tick 是一条硬编码优先级链：
 *   血少→逃 / 苦力怕→躲 / 贴脸→打 / 有活→干活 / 远→跟 / 否则待命
 * 两个问题：
 *   ① 阈值全是拍脑袋定的（criticalHp=8, fightRadius=3, followMax=6），
 *      改一个数字要重新理解整条链；
 *   ② **动作菜单是静态的** —— 不管当前状态可不可能，代码都会去试。
 *      例如身上没方块也会走"放回去"的分支，白天也会考虑"睡觉"。
 *
 * ## 借鉴了什么
 *
 * **Jev（TypeSafe AI，2026-09 发布）** 的三种决策原语。Jev 不生成文本，
 * 只在你给的选项上算概率，因此又快又便宜：
 *   - `choice` —— 从带判据的选项里挑一个（返回 choice + confidence + probabilities）
 *   - `score`  —— 在有序刻度上打分（返回 score + probabilities + legend）
 *   - `noul`   —— 校准过的 是/否 概率（返回 0–1）
 * 官方最佳实践里有两条直接决定了本文件的设计：
 *   - **Jev 看不到你的字段名。** 判据必须显式写在 instructions / criteria 里。
 *     所以下面每个动作的 `criteria` 都是完整的中文句子，不是变量名。
 *   - **schema 不匹配时要 fail closed**，不要悄悄塞一个默认分支。
 *
 * **rmalde/minecraft-agent**（Astra 规划器 + JEV 控制器，8 分 43 秒速通末影龙）：
 * planner 定目标，controller 只负责**从当前可行动作里选一个**；
 * 结构化状态控制，不是截图/按键；每次决策写进 events.jsonl 可复盘。
 *
 * ## 分层：可能 vs 该不该
 *
 *   - **可能**（buildActionMenu）：这个动作现在物理上做不做得到。
 *     做不到的**根本不进菜单** —— 这一点是关键，别让模型去挑一个执行不了的动作。
 *     例如：苦力怕贴脸时，"近战"压根不出现在菜单里，而不是"出现但被打低分"。
 *   - **该不该**（backend.decide）：在菜单里挑哪个。这是 Jev 的活。
 *
 * ## 后端可插拔
 *
 *   - `local` —— 本地规则兜底，零依赖、离线可用。按 priority 排序。
 *   - `jev`   —— 真调 Jev API，形状与官方 `POST /v1/systemone` 一致，需要 `TYPESAFE_API_KEY`。
 *
 * 有 key 就切 `jev`；没有也不影响正确性 —— 菜单构造、护栏、事件日志都一样跑。
 *
 * ## ⚠️ 中文判据是一个未验证的风险
 *
 * 官方文档（docs.typesafe.ai/models，Language support）明确写着：
 * **「英语是主要训练语言，也是当前准确率最好的语言。其他语言，包括 CJK 文字，
 * 能够处理但效果不等同；在依赖 Jev 做非英语工作负载之前，请用自己的内容测试，
 * 并特别注意路由时的 Confidence。」**
 *
 * 而本文件的 `criteria` 全是中文。这不是小问题：如果 Jev 在中文判据上表现差，
 * 我们会**误判成"Jev 不行"**，而真实原因是语言。
 *
 * 所以判据做成了双语（`MC_CRITERIA_LANG=zh|en`），拿到 key 之后可以只改一个
 * 环境变量就做 A/B，把"语言"这个变量单独隔离出来。默认仍是 zh（不改变现状）。
 *
 * 注意 state 本身基本是英文/枚举（`hp` / `threat.name='zombie'` / `task.type='mine'`），
 * 所以中文暴露面精确地就在 criteria 与 instructions 这两处 —— 正是这个开关覆盖的范围。
 */

'use strict';

// ------------------------------------------------------------------ 配置

const CFG = {
  // 'local' | 'jev' | 'auto'（有 key 就用 jev）
  //
  // ⚠️ 默认是 'local'，**不是 'auto'**。
  // 外部付费依赖必须"显式打开"，不能"有 key 就自动切" ——
  // 否则某天环境里多了一个 key，行为就悄悄变了，还会开始花钱。
  // 想用 Jev 请显式设 MC_DECISION_BACKEND=jev。
  backend: process.env.MC_DECISION_BACKEND || 'local',

  // 官方端点。**注意不是 OpenAI 兼容的 chat/completions 形状** ——
  // 是一个专门的决策端点，请求体是 {model, state, questions}。
  // 官方文档：docs.typesafe.ai/introduction/quickstart
  jevUrl: process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone',

  // `jev-latest` / `jev-preview` 都是别名，当前都解析到 jev-1.13.0。
  // 默认钉住版本号而不是用别名 —— 官方明确建议：
  // 「如果你针对某个版本校准过置信度阈值，请钉住那个版本 ID，而不是用别名。」
  jevModel: process.env.JEV_MODEL || 'jev-1.13.0',

  jevTimeoutMs: parseInt(process.env.JEV_TIMEOUT_MS || '6000'),

  // 判据用哪种语言。官方说英语准确率最高、CJK 不等同 ——
  // 见文件顶部「中文判据是一个未验证的风险」。默认保持现状（中文）。
  criteriaLang: process.env.MC_CRITERIA_LANG || 'zh',

  // 置信度低于此值时，不再自动执行 —— 交回上层（agent / 保守默认）。
  // ⚠️ 0.55 是拍出来的，不是校准出来的。官方文档说得很清楚：
  // 「confidence 是从答案概率分布算出来的统计量，不是独立的验证器；
  //   阈值必须用你自己工作负载里的带标注样本去测。」
  // 拿到 key 之后应该用真实决策记录去校准这个值。
  minConfidence: parseFloat(process.env.MC_MIN_CONFIDENCE || '0.55'),

  // 决策结果缓存条数（官方建议：按"决策身份"缓存，而不是按原始 prompt 文本）
  cacheSize: 64,
};

/**
 * 解析 API key。官方环境变量名是 `TYPESAFE_API_KEY`；
 * `JEV_API_KEY` 是本项目早期的名字，保留兼容，免得已写好的启动脚本失效。
 */
function apiKey () {
  return process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '';
}

/**
 * 阈值集中在这里，别散落在各分支里 —— 改一个数字只需要改一处。
 * autopilot 从本模块导入，避免两边各存一份而慢慢漂移。
 */
const TUNING = {
  followMax: 6,     // 超过这个距离才算"跟丢了"，才提供 follow
  criticalHp: 8,    // 低于这个血量视为危急
  fightRadius: 3,   // 近战够得着的距离
  dangerRadius: 6,  // 威胁"真的在身边"的距离；超出就不算威胁

  // ---- 自主生存的阈值（field-log P24）------------------------------------------
  //
  // ⚠️ 这些阈值回答的是"**没人派活时，她自己该不该为自己做事**"。
  //    它们的取值原则和上面几条一样 —— 宁可晚一点动手，也不要一惊一乍：
  //    一个频繁跑去"觅食"但并没有真的饿的 bot，会显得神经质，
  //    也会把正在做的正经事打断（用户明确要求「不打断工作」）。
  selfFood: 14,     // 饥饿 ≤ 14 才值得主动找吃的（原版 20 才掉血，留 6 点缓冲）
  selfHp: 8,        // 血量 ≤ 8 且没有敌人贴身 → 主动撤到安全处养伤
  selfMatStacks: 8, // 背包建材少于 8 个 → 值得去采（8 个不够盖一间 3×3 的屋，但能起步）
  selfNight: true,  // 天黑且没有落脚点 → 该考虑搭个遮蔽
};

/**
 * 会自爆的生物：绝不近战，而且要在更远的距离就开始规避。
 * 这条知识只住在这里 —— autopilot 的看门狗也从这导入，避免两处各存一份。
 */
const DO_NOT_MELEE = new Set(['creeper']);


// ------------------------------------------------------------------ 自动换手

/**
 * 工具/武器的分级表。
 *
 * ⚠️ 顺序即优劣，**贵的在前**。不要按字母序排 —— 那会让钻石镐排在木镐后面。
 * 材质名用原版注册名，模组工具（比如整合包加的）不在表里 → 给基础分，
 * 而不是给 0：**不认识的工具也比空手强**。这一点和 HiyoriAI 一致
 * （它的 `equip` 只按 `item.name` 正则挑，没有材质表）。
 */
const TOOL_TIERS = [
  'netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden',
];

const TOOL_KINDS = {
  pickaxe: { role: 'tool', label: '镐' },
  axe: { role: 'weapon', label: '斧' },      // 斧既能砍也能打，两种角色都算
  shovel: { role: 'tool', label: '铲' },
  hoe: { role: 'tool', label: '锄' },
  sword: { role: 'weapon', label: '剑' },
};

/**
 * 给一件物品打分。
 *
 * @param {string} name  物品注册名，如 `diamond_pickaxe`
 * @returns {{ score: number, role: 'tool'|'weapon'|'none', label: string }}
 *
 * 评分规则（刻意简单，因为**判错的代价很小**，而复杂的规则没法离线穷举）：
 *   - 认得出种类：基准 10；每升一档材质 +5（原版 6 档 → 10..35）
 *   - 认不出种类但名字里带 pickaxe/axe/... 的结尾：给 8（近似命中）
 *   - 完全不认识：0（当它不是工具）
 * 斧同时算 tool 和 weapon；剑只算 weapon。
 */
function scoreEquipItem (name) {
  if (!name || typeof name !== 'string') {
    return { score: 0, role: 'none', label: '' };
  }
  const bare = name.replace(/^[a-z0-9_]+:/, '');   // 去掉模组命名空间
  let kind = null;
  let suffixHit = null;
  for (const k of Object.keys(TOOL_KINDS)) {
    if (bare === k) { kind = k; break; }                       // 极少数：物品就叫 pickaxe
    if (bare.endsWith(`_${k}`)) {
      // `_axe` 会同时命中 axe；`_pickaxe` 只命中 pickaxe（因为 endsWith('_axe')
      // 对 'pickaxe' 为 false —— 'pickaxe' 的结尾是 'ckaxe' 不是 '_axe'）
      if (!suffixHit || k.length > suffixHit.length) suffixHit = k;
    }
  }
  const matched = kind || suffixHit;
  if (!matched) return { score: 0, role: 'none', label: '' };

  const info = TOOL_KINDS[matched];
  // 材质档：找出名字里最靠前的那个材质词。`_` 边界匹配，避免 'iron' 命中 'ironwood'。
  let tierIdx = -1;
  for (let i = 0; i < TOOL_TIERS.length; i++) {
    const t = TOOL_TIERS[i];
    if (bare.includes(`${t}_`) || bare.startsWith(`${t}_`)) { tierIdx = i; break; }
  }
  let score = 10;
  if (tierIdx >= 0) score += 5 * (TOOL_TIERS.length - tierIdx);   // 木 10+5=15 … 下界 10+30=40
  return {
    score,
    role: info.role,
    label: `${info.label}${name}`,
  };
}

/**
 * 决定"该把手里的东西换成什么"。
 *
 * @param {object} p
 * @param {string|null} p.held         当前手持的注册名（没有则空手）
 * @param {string[]}    p.inventory     背包全部物品的注册名（**含手持**）
 * @param {'tool'|'weapon'|'any'} [p.want='any']  眼下想干什么
 * @returns {{ itemName: string|null, reason: string, upgraded: boolean }}
 *
 * 返回 `itemName: null` 表示"不用换"。三种情况会返回 null：
 *   ① 背包里没有比现在更好的东西
 *   ② 现在手上的已经是这一类里最好的
 *   ③ 想要 weapon 但背包里只有镐（同类不匹配 → 宁可空手也别拿镐去打）
 *
 * ⚠️ 刻意**不做**的一件事：不检查耐久。原因 —— mineflayer 的 `item.durabilityUsed`
 *    只在物品带 `durability` 组件时才有值，对模组物品常常是 null，
 *    拿 null 去比较会得出"这件几乎全新"的**错误**结论。宁可换错也不误判。
 */
function pickAutoEquip ({ held = null, inventory = [], want = 'any' } = {}) {
  const heldInfo = scoreEquipItem(held);
  const counts = new Map();
  for (const n of inventory) counts.set(n, (counts.get(n) || 0) + 1);

  // 是不是"真武器"？判据：角色是 weapon **且**名字里带 sword / _axe。
  // 为什么不用 role==='weapon' 就够：斧同时是 tool 和 weapon，但 `_axe$` 才算真武器的一半。
  // 这里定义一个独立概念是为了让下面两条规则能表达"有没有更好的替代品"。
  const isRealWeapon = (n) => {
    const s = scoreEquipItem(n);
    if (s.role !== 'weapon') return false;
    return /(^|_)sword$/.test(n.replace(/^[a-z0-9_]+:/, '').replace(/_.*$/, ''))
      || /_sword$|_axe$/.test(n.replace(/^[a-z0-9_]+:/, ''));
  };
  const hasRealWeapon = [...counts.keys()].some(isRealWeapon);
  const hasTool = [...counts.keys()].some(n => scoreEquipItem(n).role === 'tool');

  /**
   * 眼下的"想干什么"决定了哪些角色算合格。
   *
   * ⚠️ 关键设计（也是第一次写错的地方）：想要武器时，**只有在没有真武器的情况下**
   *    工具才算凑合。否则会出现荒谬结果 —— 背包里有木剑，却因为"钻石镐分数更高"
   *    而继续握着镐去打骷髅。分数只在同一角色内可比。
   */
  const accept = (role) => {
    if (want === 'weapon') {
      if (role === 'weapon') return true;
      return role === 'tool' && !hasRealWeapon;    // 没武器时镐也能凑合打
    }
    if (want === 'tool') {
      if (role === 'tool') return true;
      return role === 'weapon' && !hasTool;        // 没工具时剑也能凑合挖
    }
    return role !== 'none';
  };

  // 硬规则：想要武器，而手上是纯工具（镐/铲/锄）且背包里有真武器 → 一定换。
  // 这条比"分数更高"优先，因为角色不匹配时分数没有可比性
  // （钻石镐 40 分 > 木剑 15 分，但拿镐打骷髅显然不如拿剑）。
  if (want === 'weapon' && heldInfo.role === 'tool' && hasRealWeapon) {
    return pickBest({ counts, held, accept, reason: '手上是工具，背包里有武器' });
  }

  // 反向规则：想要工具，而手上是真武器，且背包里有真工具 → 换。理由对称。
  const hasRealTool = [...counts.keys()].some(n => scoreEquipItem(n).role === 'tool' && !isRealWeapon(n));
  if (want === 'tool' && isRealWeapon(held) && hasRealTool) {
    return pickBest({ counts, held, accept, reason: '手上是武器，背包里有工具' });
  }

  if (heldInfo.role !== 'none' && accept(heldInfo.role)) {
    // 手上已经有一件"角色对得上"的东西 —— 只有当背包里有**严格更好**的同类时才换。
    const better = [];
    for (const n of counts.keys()) {
      if (n === held) continue;
      const s = scoreEquipItem(n);
      if (!accept(s.role)) continue;
      if (s.score > heldInfo.score) better.push({ name: n, score: s.score });
    }
    if (better.length === 0) {
      return { itemName: null, reason: `手上的${heldInfo.label}已经是最好的了`, upgraded: false };
    }
    better.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return {
      itemName: better[0].name,
      reason: `背包里有更好的：${better[0].name}（${better[0].score} > ${heldInfo.score}）`,
      upgraded: true,
    };
  }

  return pickBest({ counts, held, accept, reason: held ? '手上的东西不对路' : '空着手' });
}

/** pickAutoEquip 的内部工具：从背包里挑分最高的可接受项。 */
function pickBest ({ counts, held, accept, reason }) {
  const cands = [];
  for (const n of counts.keys()) {
    const s = scoreEquipItem(n);
    if (!accept(s.role)) continue;
    cands.push({ name: n, score: s.score });
  }
  if (cands.length === 0) {
    return { itemName: null, reason: '背包里没有能用的东西', upgraded: false };
  }
  cands.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = cands[0];
  if (held && top.name === held) {
    return { itemName: null, reason: `手上的${held}已经是最好的了`, upgraded: false };
  }
  return { itemName: top.name, reason: `${reason} → ${top.name}`, upgraded: true };
}


// ------------------------------------------------------------------ 动作菜单

/**
 * 每个动作的判据，双语。
 *
 * ⚠️ 这些字符串是给 **Jev 看的**，不是给玩家看的。所以规则是：
 *   - 必须是**自解释的完整句子** —— Jev 看不到字段名，也看不到本文件的源码。
 *     写 `hp < 8` 它读不懂，要写"自己血量已经很低"。
 *   - 要说明**为什么**，不只是**什么** —— 判据是权衡的依据，
 *     只有"玩家走远了"没有"所以该跟上去"，模型没法在多个选项间比较。
 *   - 英文版不是翻译腔，是按官方"英语准确率最高"重写的同义判据。
 */
const CRITERIA = {
  flee: {
    zh:
      '附近有敌对生物，且自己血量已经很低 —— 此刻跑开比硬拼更能活下去，' +
      '死了会掉东西、还会让玩家等你。',
    en:
      'A hostile mob is nearby and my own health is already very low — running away ' +
      'right now is more likely to keep me alive; dying would drop my items and make ' +
      'the player wait for me.',
  },
  backoff: {
    zh:
      '附近有苦力怕（会自爆）—— 先拉开距离，不要站在爆炸范围内，' +
      '无论如何都不要贴上去打它。',
    en:
      'A creeper is nearby, and creepers explode — open up the distance and stay out ' +
      'of blast range. Never walk up and hit it, no matter what.',
  },
  fight: {
    zh:
      '有敌对生物贴身，但自己血量还算充足 —— 反击能清掉威胁，' +
      '让玩家不用替你担心。',
    en:
      'A hostile mob is right next to me but my health is still comfortable — fighting ' +
      'back clears the threat and stops the player from having to worry about me.',
  },
  work: {
    zh:
      '手上还有玩家/上层交代的明确任务没做完 —— 答应的事要先做完，' +
      '不能半途跑去闲逛。',
    en:
      'I still have an explicit task from the player or from a higher layer that is not ' +
      'finished — I should finish what I agreed to do instead of wandering off halfway.',
  },
  follow: {
    zh: '玩家走远了（超过正常跟随距离）—— 跟上去，别把人跟丢。',
    en:
      'The player has walked away, further than my normal follow distance — catch up ' +
      'so that I do not lose them.',
  },
  approach: {
    zh: '玩家就在附近 —— 待在他身边，偶尔看看他，安静地陪着就好，不用说话。',
    en:
      'The player is right nearby — stay beside them, glance at them now and then, and ' +
      'keep them company quietly. There is no need to talk.',
  },
  idle: {
    zh: '眼下没有任何需要做的事 —— 原地待命，不要自己找事、不要乱拆东西。',
    en:
      'There is nothing that needs doing right now — stand by where I am. Do not invent ' +
      'work for myself and do not break anything.',
  },

  // ---- 以下四个是 2026-09-25 新增的「对自己」的动作 --------------------------
  //
  // 原来的菜单只有七个动作：flee/backoff/fight/work/follow/approach/idle ——
  // **全部是"对别人做什么"，一项"对自己做什么"都没有**。
  // 这就是"她不会使用自己物品栏里的东西"的根因：不是她不想用，是菜单里没得选。
  // 对标 HiyoriAI 的 15 个动作（含 equip / drop_item / pickup_drops / scan_blocks）
  // 与 Mindcraft 的 39 个命令（含 !equip / !discard / !collectBlocks / !consume）。
  //
  // ⚠️ 这四条**全部只在 `s.capability` 给出证据时才进菜单**（背包里真有、
  //    或地上真有掉落物）。做不到的动作进菜单会让 LLM 选一个必然失败的动作，
  //    然后我们还要为"失败了"编一段解释 —— 那是自找的。

  pickup: {
    zh:
      '地上有掉落物（刚挖碎的东西、别人丢下的、怪掉的）—— 走过去捡起来。' +
      '掉落物不捡就消失了，捡回来才算真的拿到手。',
    en:
      'There are dropped items on the ground (from what I just mined, things the player ' +
      'dropped, or mob drops) — walk over and pick them up. Drops despawn if left alone, ' +
      'so walking over is how I actually acquire them.',
  },
  eat: {
    zh:
      '饥饿值已经偏低，而且背包里有能吃的东西 —— 先吃点。' +
      '饿着的时候既不能疾跑也不能自然回血，跟人跟不动。',
    en:
      'My hunger is running low and I do have food in my inventory — eat something first. ' +
      'While hungry I cannot sprint or regenerate health, so I cannot keep up with the player.',
  },
  equip: {
    zh:
      '背包里有更好的装备/武器没拿在手上 —— 换上它。' +
      '挖矿前换镐子、打架前换剑，比徒手快得多，也更安全。',
    en:
      'There is better gear or a better weapon in my inventory that I am not holding — ' +
      'equip it. Swapping to a pickaxe before mining or a sword before fighting is much ' +
      'faster and safer than bare hands.',
  },
  explore: {
    zh:
      '周围没什么事，但玩家可能想知道附近有什么（比如问过"旁边有树吗"）—— ' +
      '扫一眼四周，用方块名回答，而不是猜。',
    en:
      'Nothing urgent is happening, but the player may want to know what is around (for ' +
      'example they asked whether there are trees nearby) — scan the surroundings and ' +
      'answer with real block names instead of guessing.',
  },

  // ---- 自主生存（field-log P24）--------------------------------------------------
  //
  // ⚠️⚠️ 这一组和前七个动作有一个**根本区别**：
  //    前七个的进入条件是"外部世界发生了什么"（有怪、有人、有活、有掉落物）；
  //    这一组的进入条件是"**我自己的状态需要照顾**"。
  //
  //    在 P24 之前，这个菜单里**完全没有这一类** —— 于是没人派活时她只剩
  //    `explore` 和 `idle` 两个选项，也就是"在架构上不具备为自己做事的能力"。
  //    用户的目标是「自己建立庇护所并持续发育」，而那是这一类动作才能做到的事。
  //
  //    判据文字同样要写成**自解释的完整句子** —— Jev 看不到 `s.self` 的字段名。
  forage: {
    zh:
      '我自己的饥饿值已经掉得不低了，而周围有能打来吃的东西 —— ' +
      '趁还没饿到跑不动的时候先解决吃饭问题，比等饿透了再手忙脚乱要安全。',
    en:
      'My own hunger has dropped quite low, and there are animals or food items nearby ' +
      'that I could turn into a meal — sorting out food before I am too weak to run is ' +
      'much safer than waiting until I am starving.',
  },
  gather: {
    zh:
      '我手上几乎没有能用来建造的材料，而周围有可以徒手挖走的方块（泥土、沙子、木头等）—— ' +
      '先把材料攒起来，才能给自己盖一个遮风挡雨的地方。',
    en:
      'I have almost no building material on me, and there are blocks nearby I can dig ' +
      'with my bare hands (dirt, sand, wood and so on) — gathering material first is ' +
      'what makes it possible to build myself some shelter.',
  },
  hunt: {
    zh:
      '周围有被动生物（鸡、牛、羊之类）而且我现在打得到 —— ' +
      '它们不会还手，是稳定的食物来源，比翻箱倒柜找吃的可靠。',
    en:
      'There are passive animals around (chickens, cows, sheep and so on) and I can ' +
      'reach them right now — they will not fight back, which makes them a far more ' +
      'reliable source of food than rummaging around hoping to find some.',
  },
  shelter: {
    zh:
      '天黑了，而我此刻没有可以躲进去的安全立足点 —— ' +
      '夜里刷出来的怪会在露天把我耗死，先围一个能挡住的封闭空间过夜。',
    en:
      'It is night and I currently have no safe place to retreat into — monsters that ' +
      'spawn in the dark will wear me down out in the open, so I should wall myself ' +
      'into an enclosed space to get through the night.',
  },
  retreat: {
    zh:
      '我血量偏低，但眼下身边**没有**怪贴着我 —— ' +
      '与其继续在外面乱走，不如先退到一个安全的地方把血养回来。',
    en:
      'My health is low, but right now no hostile mob is actually on top of me — ' +
      'rather than keep wandering around outside, it is better to withdraw somewhere ' +
      'safe and let my health recover.',
  },
};

/** 决策问题的 instructions，同样双语（原因同上）。 */
const ACTION_INSTRUCTIONS = {
  // ⚠️⚠️ 2026-09-25 分模式（field-log P24）。**旧版只有一条**，内容是：
  //     「宁可安静地待命，也不要自己找事做。」
  //
  // 那条和用户的目标**直接矛盾**。用户要的是「自己建立庇护所并持续发育」，
  // 而这一句等于在决策层明令禁止自发行为 —— 就算菜单里放了 forage/gather/shelder，
  // 模型也会因为"宁可待命"而永远选 idle。
  //
  // 所以现在按**有没有人需要她陪**分成两套：
  //   · solo   —— 独立在场，没人派活。这时的正确行为是"照顾好自己"。
  //   · company—— 有人在场（或刚被叫过）。这时"待命"是对的：她的价值在于配合，
  //               而不是把玩家晾在一边自己跑去挖土。
  //
  // ⚠️ 这不是"改一句文案" —— 它是 P24 的**一半根因**。菜单决定"能选什么"，
  //    instructions 决定"倾向于选什么"。只修菜单不修这句话，等于开了门却贴着"请勿入内"。
  solo: {
    en:
      'You are Angel_ICE, an AI companion in a Minecraft world, and right now nobody ' +
      'is directing you — you are on your own. Look at the current state and choose ' +
      'what to do next. Take care of yourself: if you are getting hungry, find food; ' +
      'if you have no building material, gather some; if it is getting dark and you ' +
      'have no shelter, make one. Looking after your own survival is never "inventing ' +
      'work for yourself" — it is how you stay useful. Prefer an action that changes ' +
      'the world (gathering, building, hunting) over one that just looks around.',
    zh:
      '你是 Angel_ICE，Minecraft 世界里的 AI 伙伴，而现在没有人在指挥你 —— 你自己做主。' +
      '看当前状态，选下一步做什么。**照顾好你自己**：饿了就去弄吃的；' +
      '没有建材就去采；天黑了没地方躲就给自己围一个。' +
      '照顾自己的生存**不是**"自己找事做"，那正是你能一直帮上忙的前提。' +
      '优先选**能改变世界**的动作（采集、建造、狩猎），而不是只是四处看看。',
  },
  company: {
    en:
      'You are Angel_ICE, a companion who plays Minecraft alongside the player. ' +
      'Someone is nearby or has just spoken to you, so staying quietly on standby is ' +
      'preferred over wandering off to invent work for yourself — your value right now ' +
      'is being available. Only step away from that if you actually need to (starving, ' +
      'about to die, nightfall with nowhere to hide).',
    zh:
      '你是 Angel_ICE，一个陪玩家玩 Minecraft 的伙伴。' +
      '现在有人在你附近，或者刚刚跟你说过话 —— 所以**宁可安静地待命**，' +
      '也不要自己跑到一边找事做。你此刻的价值就是"随时能被叫到"。' +
      '只有真的需要（快饿死了、快被打死了、天黑了没地方躲）才离开。',
  },
};

function criteriaFor (id, lang) {
  const e = CRITERIA[id];
  if (!e) return '';
  return e[lang] || e.zh;
}

/**
 * 「我自己现在需要什么」—— 把 P24 的新增准入条件**集中在一处**。
 *
 * ⚠️ 为什么不写在 `buildActionMenu` 里直接判：
 *    因为 autopilot 也需要读同一组结论（它要据此决定 perform 什么、
 *    以及决定用 solo 还是 company 那套 instructions）。
 *    判定只有一处实现，两边就不会慢慢漂移 —— 这是本项目反复吃过的教训
 *    （P2b 的"两处各判一遍"、P18 的"两种 kind 分类"）。
 *
 * @param {object} p
 * @param {number} p.hp          血量 0-20
 * @param {number} p.food        饥饿值 0-20
 * @param {object} [p.capability] 由 autopilot 的 buildCapability 产出
 * @returns {{ hpLow, needFood, needMaterials, needShelter, canHunt,
 *             hasFoodSource, hasMaterials, noShelterAtNight, reasons }}
 *
 * **每一项都必须有对应的证据**，缺证据一律 false（保守）：
 *   · `needFood`      ← `food <= TUNING.selfFood` **且** 周围真有能吃的东西
 *                        （有鸡/牛可打，或地上有食物掉落，或背包里已经有吃的）
 *   · `needMaterials` ← `capability.matStacks <= TUNING.selfMatStacks` **且**
 *                        周围真有可徒手采的建材
 *   · `needShelter`   ← `isDay === false`（**必须是明确的 false，不是 null**）**且**
 *                        眼下没有"已建成的遮蔽"可用
 *   · `hpLow`         ← `hp <= TUNING.selfHp`
 *   · `canHunt`       ← 周围有被动生物
 */
function buildSelfNeeds ({ hp = 20, food = 20, capability = {} } = {}) {
  const T = TUNING;
  const cap = capability || {};

  // ⚠️ `isDay` 三态：true / false / null(不知道)。
  //    只有**明确的 false**（确实天黑了）才算"需要遮蔽"。
  //    `null` 表示网桥没给出天色 —— 这时**不猜**，宁可不搭遮蔽也不要凭一个
  //    猜出来的"天黑了"去乱跑（P4/P8/P20 都是"没有"和"读不到"没分开造成的）。
  const nightKnown = cap.isDay === false;
  const noShelterAtNight = nightKnown;

  const hasFoodSource = (cap.huntableCount || 0) > 0
    || (cap.foodDropCount || 0) > 0
    || cap.canEat === true;                    // 背包里本来就有吃的
  const hasMaterials = (cap.buildMatCount || 0) > 0;

  const reasons = [];
  if (food <= T.selfFood) reasons.push(`饥饿 ${food} ≤ ${T.selfFood}`);
  if (!hasFoodSource) reasons.push('周围没有可获得的食物来源');
  if ((cap.matStacks || 0) <= T.selfMatStacks) reasons.push(`建材 ${cap.matStacks || 0} ≤ ${T.selfMatStacks}`);
  if (!hasMaterials) reasons.push('周围没有可徒手采集的建材');
  if (cap.isDay === null || cap.isDay === undefined) reasons.push('天色未知（不推断）');

  return {
    hpLow: hp <= T.selfHp,
    needFood: food <= T.selfFood && hasFoodSource,
    needMaterials: (cap.matStacks || 0) <= T.selfMatStacks && hasMaterials,
    needShelter: noShelterAtNight,
    canHunt: (cap.huntableCount || 0) > 0,
    // 把中间量也带出来 —— 排查时"为什么没触发"比"触发了没有"更重要
    hasFoodSource,
    hasMaterials,
    noShelterAtNight,
    nightKnown,
    reasons,
  };
}

/**
 * 该用哪一套 instructions（solo / company）。
 *
 * ⚠️ 这是 P24 的另一半根因（见 ACTION_INSTRUCTIONS 的注释）。
 *    判据刻意**简单且可解释**：有人在场、或刚刚被叫过 → company；否则 solo。
 *
 * 为什么把"刚被叫过"也算 company：用户明确要求「不打断工作，只是改变后续行为」。
 * 刚被叫过的头几秒，玩家很可能还有下文 —— 这时她跑去挖土就是"处理消息不及时"，
 * 正是用户最初提的问题之一。
 */
function pickInstructMode (s = {}) {
  const hasPlayer = Boolean(s.player && s.player.distance != null);
  const justAddressed = Boolean(s.attention && s.attention.recent);
  return (hasPlayer || justAddressed) ? 'company' : 'solo';
}

/**
 * 当前状态下**可能**的动作。做不到的不进菜单。
 *
 * `criteria` 是给 Jev 看的判据（见 CRITERIA 的说明）。
 * `priority` 是给 local 后端的排序依据（越大越优先）。
 *
 * @param {object} s      状态快照
 * @param {string} [lang] 判据语言 'zh' | 'en'，默认取 CFG.criteriaLang
 * @returns {Array<{id:string, criteria:string, priority:number}>}
 */
function buildActionMenu (s, lang = CFG.criteriaLang) {
  const menu = [];
  const hp = s.hp ?? 20;
  const threat = s.threat || null;
  const T = TUNING;
  const add = (id, priority, extra = null) => {
    const entry = { id, criteria: criteriaFor(id, lang), priority };
    if (extra) Object.assign(entry, extra);
    menu.push(entry);
  };

  // ---- 对自己：生存优先 ------------------------------------------------------
  //
  // 顺序很重要。旧菜单是"先看怪、再看活、最后看人"，那是**只考虑外部世界**的顺序。
  // 加上自身需求后，正确的顺序是：**先保证自己还能动，再谈别的**。
  // 一个饿到不能疾跑的人在跟丢玩家的路上，比一个满状态的人危险得多。
  //
  // ⚠️ 这里的吃只是"提高优先级"，不是"强制"。真正的强制在 reflex.js ——
  //    饥饿 ≤6 时反射会直接短路整个 tick，**根本走不到这份菜单**。
  //    所以这里的优先级取 85（比 follow 的 65 高、比 flee 的 100 低）：
  //    逃跑永远第一，吃完再跟人。
  const cap = s.capability || {};
  if (cap.canEat) add('eat', 85);

  // ---- 威胁相关。三条规则都要过距离这一关 ——
  // 12 格外的僵尸既够不着也不构成威胁，不该让它在菜单里占位。
  if (threat && threat.distance <= T.dangerRadius) {
    // 血少才谈"逃"。满血时逃跑不是选项，是怯场。
    if (hp <= T.criticalHp) add('flee', 100);

    // 会自爆的生物不提供"近战"选项 —— 不是打低分，是根本不出现。
    // 这条规则在旧代码里是 DO_NOT_MELEE 的 if 分支，现在变成菜单构造。
    if (threat.name === 'creeper') {
      add('backoff', 90);
    } else if (threat.distance <= T.fightRadius && hp > T.criticalHp) {
      // 够得着、血也够 —— 才提供反击。
      // ⚠️ 打架前值得先换武器：有武器且没拿在手上时，equip 排在同一档（同 60，
      //    靠 `localDecide` 的顺序拿 equip）—— "赤手上去打"和"先换剑再打"
      //    是两件事，但都不该压过"先躲开自爆怪"。
      if (cap.canEquipWeapon) add('equip', 61, { want: 'weapon' });
      add('fight', 60);
    }
  }

  // ---- 挖矿/采集前换工具。不放在威胁分支里 —— 它是"准备"不是"应急"。
  if (cap.canEquipTool) add('equip', 55, { want: 'tool' });

  // ---- 注意力：刚才有人跟她说话吗？（**不打断，只改权重**）-------------------
  //
  // 用户明确要求：「不打断工作，只是改变后续行为」。
  //
  // 所以这里**不做** Mindcraft 那种 `requestInterrupt()`（那会 stopDigging，
  // 正在挖的矿直接废掉），而是用两组权重偏移表达同一件事：
  //   · `attn.recent`        → 把"跟人"整体抬高、task 整体压低
  //   · `attn.blocksNewTask` → 头几秒里干脆不接新活
  //
  // ⚠️ `blocksNewTask` 挡的是**新** task，不是正在做的那个。
  //    正在做的 task 永远不会因为玩家说话而被清掉 —— 那才是打断。
  const attn = s.attention || {};
  // 有人的时候才谈"注意力" —— 没人在线，聊天记录本身就是空的
  const towardPerson = attn.recent ? 18 : 0;
  const awayFromTask = attn.recent ? -12 : 0;

  // ---- 外部派的活
  //
  // ⚠️ 这里**不**用 `blocksNewTask` 把 work 从菜单里删掉。
  //    原因：`s.task` 是**已经被接受的**活（autopilot 在任务接收处就把它定型了）。
  //    在菜单层"假装它不存在"只会让决策层选一个别的动作，而 task 还挂在那里 ——
  //    下一轮又出现，形成"work 一闪一闪"的抖动。
  //
  //    `blocksNewTask` 的正确作用点是**任务接收处**（autopilot 的 task 解析），
  //    那里才拦得住"要不要开始一个新活"。菜单这里只负责表达权重：
  //    刚被叫过 → 这把活往后排一点，但不取消。
  if (s.task) add('work', 70 + awayFromTask);

  // ---- 自主生存：没人派活时，她也要为自己做事（field-log P24）------------------
  //
  // ⚠️⚠️ 这是 P24 的修复核心，也是本菜单**第一次出现**"进入条件不看外部世界"的动作。
  //
  // P24 的根因（原文照抄当时的诊断）：
  //   > `mine` / `collect` / `place` 不是独立动作 —— 它们只是 `work` 这个动作的 payload。
  //   > 而 `work` 只在**外部派了活**时才存在。
  //   > 她此刻 hp=5.33、入夜、food=11，**既不觅食、也不找掩护、也不采集** ——
  //   > 不是她不想，是**菜单里没有这些选项**。
  //
  // 所以下面这几条**刻意不看 `s.task`**。`s.self` 是"我自己的状态"，
  // 由 autopilot 的 `buildSelfNeeds()` 从真实证据（饥饿值/血量/背包/周围方块/天色）推出。
  //
  // ⚠️ 优先级刻意排在 `work`(70) 之下、`explore`(20) 之上：
  //    · 低于 work —— 用户明确要求「不打断工作」。派了活就先干活，自己的事先放一放。
  //    · 高于 explore —— explore 是**信息动作**，不改变世界。她没在忙的时候，
  //      采一块土永远比"再看一眼周围"更有价值。
  //    这是"不打断工作"和"必须能自主发育"之间唯一自洽的排法。
  // 优先用外部直接给的 `s.self`（autopilot 已经算过了）；
  // 没给就用 `s.hp`/`s.food`/`s.capability` 现算一遍 —— 这样单独调这个函数
  // （比如离线讨论、回归测试）也能得到完整菜单，不必先手工拼一个 self 对象。
  const self = s.self || buildSelfNeeds({
    hp, food: s.food ?? 20, capability: cap,
  });

  // 血量低且**没有贴身威胁** → 主动撤。
  //
  // ⚠️ `威胁时不给 retreat` 这一条是自测逼出来的（第 6 段那条
  //    "残血遇僵尸 → 有 flee，没有 fight"）：
  //    我第一版只写了 `if (self.hpLow) add('retreat', 66)`，结果 hp=5 遇到僵尸时
  //    菜单里同时有 `flee` 和 `retreat` —— **两个都是"跑"，但语义完全不同**：
  //      · `flee`    = 正在被追着打，立刻逃命（最高优先级 100）
  //      · `retreat` = 没人在打我，只是状态差，找个地方养伤（66）
  //    同时出现会让后端**有概率选中语义错的那个**（它会以为"身边没怪"），
  //    而这正是 CRITERIA 里 retreat 判据明说"身边**没有**怪贴着我"要排除的情况。
  //    所以 retreat 的前提就是"没有贴身威胁"，和 flee 互斥。
  const threatened = Boolean(threat && threat.distance <= T.dangerRadius);
  if (self.hpLow && !threatened) add('retreat', 66);

  // 天黑且没有安全落脚点 → 搭遮蔽。给它 74 —— **比 work 略高**，
  // 因为"夜里在露天被耗死"会让所有在建的活白做（P25 的验证就是被这件事毁掉的）。
  // 这是"不打断工作"的**唯一例外**，理由是先保命才能把活干完。
  //
  // ⚠️⚠️ P31（实机死循环）：这里的条件**必须是"想搭" 且 "搭得成"**。
  //
  //    第一版只写了 `self.needShelter`（= 天黑了），结果：夜里 + 空背包时
  //    `shelter`(74) 稳居第一 → `perform` 必然返回"没有可以放置的方块" →
  //    **它没有任何副作用，世界状态一个字都没变** → 下一 tick 判据完全相同
  //    → 又选 shelter → 无限循环。而唯一能满足这个前置条件的 `gather`(50)
  //    被它永久压制，于是 `matStacks` 永远是 0 —— 自 locks 死。
  //
  //    实机证据：连续 40 条 decision 事件全是 `shelter`，20 次 outcome 全是
  //    同一句 `没有可以放置的方块，无法搭遮蔽`，**零进展**。
  //
  //    这是 P24 缺陷的**镜像**：
  //      · P24 = 动作**根本不在菜单里**（沉默故障 → 永远不动）
  //      · P31 = 动作在菜单里但**永远够不着**（死锁 → 空转）
  //    两者都不崩溃、不报错、日志看着还挺忙 —— 又是"只有断言才能发现"的那一类。
  //
  //    修法：`shelter` 的本质是"把手里的方块放下去"，所以它**自带一个前置条件**
  //     ——手里得有方块。`matStacks > 0` 就是它。加上之后：
  //      夜晚 + 空背包 → shelter 不进菜单 → gather(50) 成为最高分（压过 explore 20 / idle 1）
  //                    → 她去采土 → matStacks > 0 → 下一 tick shelter 进菜单 → 搭起来
  //    这才是"自驱动的发育链路"，而不是一个卡住的高优先级动作。
  //
  //    ⚠️ 不要用 `hasMaterials`（= 周围有可采的建材）当这个条件 —— 那说的是
  //       "**外面**有矿可挖"，不是"**手里**有砖可砌"。两者只差一个词，
  //       但用错就会在"手里没砖、外面也没矿"时重新锁死。
  if (self.needShelter && (cap.matStacks || 0) > 0) add('shelter', 74);

  // 饿 → 找吃的。75 同上：饿到不能跑就不能逃命，属于"先保命"。
  if (self.needFood) add('forage', 75);

  // 缺建材 → 去采。**50 —— 明确低于 work 的**最低**可能取值**。
  //
  // ⚠️ 这里我第一版写了 73，注释却说"只比 work 低一点点" —— **注释和代码不一致**，
  //    是自测把它抓出来的。这个数字不能只跟 `work` 的基准（70）比，因为
  //    `work` 的最终值是 `70 + awayFromTask`，而 `awayFromTask` 在"刚被叫过"时是 −12。
  //    于是 work 的实际取值范围是 **[58, 70]**，不是 70 一个点。
  //    我第二版改成 64 —— 自测又一次抓出来：**刚被叫过时 64 > 58，gather 照样越权**。
  //
  //    结论：慢性需求必须低于 work 的**下界** 58，而不是基准。取 50。
  //    这样不管有没有人叫她，只要 `s.task` 在，她都在干活 —— 这才是「不打断工作」。
  //
  //    反过来，没有 task 时 work 根本不在菜单里，50 相对 explore(20)/idle(1)
  //    仍然是压倒性高分 —— 她闲着的时候就是该去采。
  if (self.needMaterials) add('gather', 50);

  // 有被动生物可打 → 主动狩猎。**46，同样低于 work 的下界 58**。理由同上。
  if (self.canHunt) add('hunt', 46);

  // ---- 捡东西。**优先级刻意不高于 work** ——
  // 她的主任务是玩家派的活，捡东西是顺手做；反过来会让"挖三格捡一格"变成常态。
  // 但也不低于 approach：地上的东西会消失，人不会。
  if (cap.dropCount > 0) add('pickup', 68 + awayFromTask);

  // ---- 跟人。follow 与 approach 互斥：
  // 已经在旁边就没有"跟上去"这回事，反之亦然。
  // `towardPerson` 让"刚被叫过"时她更愿意过来看看。
  if (s.player && s.player.distance != null) {
    if (s.player.distance > T.followMax) add('follow', 65 + towardPerson);
    else add('approach', 25 + towardPerson);
  }

  // ---- 看环境。"没事做"的时候看一眼，比傻站着强；
  // 但它是个**信息动作**，不该抢任何实际动作的优先级，所以给 20。
  if (cap.canScan) add('explore', 20);

  // 永远可用的兜底
  add('idle', 1);

  return menu;
}

// ------------------------------------------------------------------ 护栏

/**
 * 危险动作的硬性禁止清单（本地兜底用）。
 *
 * ⚠️ 早先的调研笔记里提到过一个 `POST /api/v1/agent/risk` 端点（返回 allow/confirm/block
 * + 风险分），但我后来核对官方文档（docs.typesafe.ai）时**没有找到这个端点** ——
 * 官方只公开了 `POST /v1/systemone` 与 `GET /v1/models`。所以那条记录**未证实**，
 * 这里不再把它当成依据，护栏完全由本地规则实现。
 *
 * 这条链的意义：我们真的踩过一次 —— 寻路器为了抄近路把玩家的房子拆了。
 * 事后加的是"改默认值"，这里是"动作执行前的最后一道闸"。
 *
 * 只放**安全**问题。像"没带镐子挖矿会很慢"这种是效率问题，不是危险 ——
 * 徒手挖木头/泥土本来就正常，硬拦只会误伤。效率问题该由上层提示，不该由护栏否决。
 *
 * 另注：官方文档还提到 "do not make Jev the sole authorization or security boundary"，
 * 意思是**别把安全判断外包给模型**。这个纯本地护栏正是那个建议的落地。
 */
const HARD_BLOCK = [
  {
    id: 'block-break',
    test: (action, s) => action === 'mine' && s.allowDig === false,
    reason: '当前上下文不允许拆方块（会破坏玩家的建筑）',
  },
  {
    id: 'no-item',
    test: (action, s) => action === 'place' && !s.hasPlaceable,
    reason: '身上没有可放置的方块',
  },
  {
    id: 'no-target',
    test: (action, s) => action === 'place' && !s.hasTarget,
    reason: '没有指定放置位置',
  },
];

/**
 * 执行前的风险门控。
 *
 * @returns {{verdict:'allow'|'block', reason?:string, risk:number}}
 */
function guard (action, s) {
  for (const rule of HARD_BLOCK) {
    if (rule.test(action, s)) {
      return { verdict: 'block', reason: rule.reason, risk: 0.95 };
    }
  }
  return { verdict: 'allow', risk: 0 };
}

// ------------------------------------------------------------------ 后端

/** 决策身份缓存：同一组问题 + 同一段状态，不重复问。 */
const cache = new Map();

// Jev 挂掉时不能每个 tick 都去撞一次超时 —— 我们的 tick 是 1.5s，
// 而 Jev 超时是 6s，硬撞会把整个循环拖垮。失败后熔断一段时间，期间直接用本地规则。
const JEV_BREAK_MS = parseInt(process.env.JEV_BREAK_MS || '60000');
let jevDownUntil = 0;

function cacheKey (state, questions) {
  // 官方建议：hash 问题集 + **归一化后**的状态字段。
  // 直接 JSON.stringify 整段 state 会因为无关字段抖动而永远不命中。
  const q = JSON.stringify(Object.keys(questions).sort().map(k => [k, questions[k].type]));
  const s = JSON.stringify([
    state.hp, state.threat ? [state.threat.name, Math.round(state.threat.distance)] : null,
    state.task ? state.task.type : null,
    state.player ? Math.round(state.player.distance ?? -1) : null,
    (state.menu || []).map(m => m.id),
  ]);
  return `${q}|${s}`;
}

function remember (key, value) {
  cache.set(key, value);
  if (cache.size > CFG.cacheSize) cache.delete(cache.keys().next().value);
}

/** 本地规则后端。按 priority 排序，形状与 Jev 的 answers 一致。 */
function localDecide (state, questions) {
  const answers = {};

  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      // criteria 在这里是个对象：{ 动作id: 判据 }，同时带上 priority 表
      const opts = q.options || [];
      if (!opts.length) throw new Error(`choice "${name}" 没有任何选项`);
      const best = opts.reduce((a, b) => (b.priority > a.priority ? b : a));
      const total = opts.reduce((sum, o) => sum + Math.max(o.priority, 0), 0) || 1;
      const probabilities = {};
      for (const o of opts) probabilities[o.id] = +(Math.max(o.priority, 0) / total).toFixed(4);
      answers[name] = {
        type: 'choice',
        choice: best.id,
        confidence: 1,
        probabilities,
      };
    } else if (q.type === 'score') {
      // 本地没有语义能力，用调用方给的 num() 取原始数值再落到刻度上
      const n = q.num ? q.num(state) : 0;
      const labels = q.criteria || [];
      const idx = Math.max(0, Math.min(labels.length - 1, n));
      answers[name] = { type: 'score', score: idx, confidence: 1 };
    } else if (q.type === 'noul') {
      const v = q.test ? q.test(state) : false;
      answers[name] = { type: 'noul', noul: v ? 1 : 0 };
    } else {
      throw new Error(`未知问题类型：${q.type}`);
    }
  }

  return { model: 'local-rules', answers, usage: { input_tokens: 0, cost_usd: 0 } };
}

/**
 * 真调 Jev。请求/响应形状与官方 `POST /v1/systemone` 一致。
 *
 * 官方契约（docs.typesafe.ai/introduction/quickstart）：
 *   请求 {model, state, questions:{key:{type, instructions, criteria}}}
 *     - choice: criteria 是**对象** {选项id: 判据}
 *     - score : criteria 是**有序数组**（等级从低到高）
 *     - noul  : 只有 instructions，没有 criteria
 *   响应 {model, answers:{key:{...}}, usage:{input_tokens, output_tokens}}
 *     - choice: {type, choice, confidence, probabilities}
 *     - score : {type, score, confidence, legend, probabilities}
 *     - noul  : {type, noul}   ← 注意：**noul 不返回 confidence**
 *
 * 限制（官方）：state + 全部 questions 合计 64k token；state 加最长单个问题 32k。
 * 纯文本输入，不接受图像/音频/视频。choice 最多 255 个选项。
 * 我们一次只问一个问题、state 只有几十 token，离限制很远。
 */
async function jevDecide (state, questions) {
  const key = apiKey();
  if (!key) throw new Error('缺少 API key（TYPESAFE_API_KEY 或 JEV_API_KEY 都没设）');

  // 交给 Jev 的 state 要精简（按 input token 计费），并且不含本地私有字段
  const wireState = {
    hp: state.hp,
    food: state.food,
    threat: state.threat,
    task: state.task,
    player: state.player,
    isDay: state.isDay,
    note: state.note,
  };

  // 本地字段（priority / num / test）不能发给 Jev
  const wireQuestions = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const criteria = {};
      for (const o of q.options || []) criteria[o.id] = o.criteria;
      wireQuestions[name] = { type: 'choice', instructions: q.instructions, criteria };
    } else if (q.type === 'score') {
      wireQuestions[name] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
    } else {
      wireQuestions[name] = { type: 'noul', instructions: q.instructions };
    }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CFG.jevTimeoutMs);
  let res;
  try {
    res = await fetch(CFG.jevUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CFG.jevModel, state: wireState, questions: wireQuestions }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 429 是官方文档点名的限流（250k tok/s、1200 req/min，且**动态调整**）。
    // 单独标出来，否则会和"key 错了"混在一起看不出原因。
    const hint = res.status === 429
      ? '（限流：官方限制是动态的，官方 SDK 默认带退避重试）'
      : res.status === 401
        ? '（鉴权失败：检查 TYPESAFE_API_KEY）'
        : res.status === 404
          ? `（端点不存在：检查 JEV_URL，当前 ${CFG.jevUrl}）`
          : '';
    throw new Error(`Jev HTTP ${res.status}${hint}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data || typeof data.answers !== 'object' || data.answers === null) {
    // fail closed —— 不要把坏响应悄悄塞成默认分支
    throw new Error('Jev 响应缺少 answers 字段');
  }
  return data;
}

// ------------------------------------------------------------------ 对外接口

function pickBackend () {
  if (CFG.backend === 'local') return 'local';
  if (CFG.backend === 'jev') return 'jev';
  return apiKey() ? 'jev' : 'local';   // auto
}

/**
 * 问一次决策。
 *
 * 失败时**降级到 local**，而不是抛出去 —— 决策层挂掉不该让她变成木头人。
 * 但降级会被记录，方便事后发现"其实一直在用兜底规则"。
 *
 * @returns {Promise<{backend:string, answers:object, degraded?:string, usage?:object}>}
 */
async function decide (state, questions) {
  const key = cacheKey(state, questions);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const backend = pickBackend();
  let result;

  if (backend === 'jev' && Date.now() < jevDownUntil) {
    // 熔断中：直接用本地规则，别再撞超时
    result = {
      backend: 'local',
      degraded: `jev 熔断中（还有 ${Math.ceil((jevDownUntil - Date.now()) / 1000)}s）`,
      answers: localDecide(state, questions).answers,
    };
  } else if (backend === 'jev') {
    try {
      const raw = await jevDecide(state, questions);
      result = { backend: 'jev', answers: raw.answers, usage: raw.usage };
      jevDownUntil = 0;
    } catch (e) {
      jevDownUntil = Date.now() + JEV_BREAK_MS;
      result = {
        backend: 'local',
        degraded: e.message,
        answers: localDecide(state, questions).answers,
      };
    }
  } else {
    result = { backend: 'local', answers: localDecide(state, questions).answers };
  }

  // ⚠️ 降级结果**不进缓存**。
  //
  // 降级不是"一个决策"，是"这次没问成"。把它缓存起来会让一次瞬时抖动
  // 在这条决策身份上被**冻结** —— 即使 Jev 已经恢复，同一个状态仍然继续吃兜底规则，
  // 而且连上游都不会再打一次。
  //
  // 这个 bug 是契约测试抓出来的：先测 429、再测 500，第二次拿到的是缓存的 429 结果，
  // 于是 500 那条路径压根没被执行。当时的表象是"熔断没打开"，看起来像熔断坏了。
  if (!result.degraded) remember(key, result);
  return result;
}

/**
 * 手动复位熔断器。
 *
 * 熔断默认会自己等 60s 后重试，所以这不是必需品；但有两种情况需要它：
 *   ① 操作者**知道**上游已经恢复（比如刚换了个 key），不想干等一分钟；
 *   ② 测试要分别验证 429 和 500 两条失败路径，否则第二次调用会被熔断挡掉，
 *      测的就变成了"熔断生效"而不是"这条错误路径处理对不对"。
 */
function resetBreaker () {
  jevDownUntil = 0;
}

/** 供控制面查看：现在实际会用哪个后端、Jev 是否在熔断。 */function backendStatus () {
  const want = pickBackend();
  return {
    configured: CFG.backend,
    willUse: want,
    jevKeyPresent: Boolean(apiKey()),
    jevKeySource: process.env.TYPESAFE_API_KEY ? 'TYPESAFE_API_KEY'
      : process.env.JEV_API_KEY ? 'JEV_API_KEY' : null,
    jevBreakerOpen: Date.now() < jevDownUntil,
    jevBreakerResetsInSec: Math.max(0, Math.ceil((jevDownUntil - Date.now()) / 1000)),
    jevUrl: CFG.jevUrl,
    jevModel: CFG.jevModel,
    criteriaLang: CFG.criteriaLang,
    minConfidence: CFG.minConfidence,
  };
}

// ------------------------------------------------------------------ 自测

// `node decision.js --selftest`
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expect)}\n        实际 ${JSON.stringify(got)}`}`);
  };

  console.log('\n[1/6] 动作菜单 —— 做不到的动作不该出现在菜单里');
  const ids = (s) => buildActionMenu(s).map(m => m.id).sort();

  check('空场 → 只有 idle', ids({ hp: 20 }), ['idle']);
  check('苦力怕贴脸 → 有 backoff，**没有 fight**',
    ids({ hp: 20, threat: { name: 'creeper', distance: 2 } }),
    ['backoff', 'idle']);
  check('僵尸贴脸 → 有 fight',
    ids({ hp: 20, threat: { name: 'zombie', distance: 2 } }),
    ['fight', 'idle']);
  check('残血遇僵尸 → 有 flee，**没有 fight**',
    ids({ hp: 5, threat: { name: 'zombie', distance: 2 } }),
    ['flee', 'idle']);
  check('远处僵尸(12格) → 无威胁动作',
    ids({ hp: 20, threat: { name: 'zombie', distance: 12 } }),
    ['idle']);
  check('满血遇僵尸但够不着(5格) → 无威胁动作',
    ids({ hp: 20, threat: { name: 'zombie', distance: 5 } }),
    ['idle']);
  check('有任务 + 玩家在旁边',
    ids({ hp: 20, task: { type: 'mine' }, player: { distance: 3 } }),
    ['approach', 'idle', 'work']);
  check('有任务 + 玩家走远',
    ids({ hp: 20, task: { type: 'mine' }, player: { distance: 15 } }),
    ['follow', 'idle', 'work']);

  console.log('\n[2/6] 本地后端 —— 排序与置信度');
  const choose = (s) => {
    const menu = buildActionMenu(s);
    const r = localDecide(s, {
      act: { type: 'choice', instructions: '下一步做什么？', options: menu },
    });
    return r.answers.act.choice;
  };
  check('残血遇僵尸 → flee', choose({ hp: 5, threat: { name: 'zombie', distance: 3 } }), 'flee');
  check('满血遇僵尸贴脸 → fight', choose({ hp: 20, threat: { name: 'zombie', distance: 2 } }), 'fight');
  check('满血遇苦力怕 → backoff', choose({ hp: 20, threat: { name: 'creeper', distance: 3 } }), 'backoff');
  check('有任务无威胁 → work', choose({ hp: 20, task: { type: 'mine' } }), 'work');
  check('玩家走远(15格) → follow', choose({ hp: 20, player: { distance: 15 } }), 'follow');
  check('玩家在旁(3格) → approach', choose({ hp: 20, player: { distance: 3 } }), 'approach');
  check('什么都没有 → idle', choose({ hp: 20 }), 'idle');

  console.log('\n[3/6] 护栏 —— 危险动作必须被拦下');
  check('上下文禁止拆方块 → block',
    guard('mine', { allowDig: false }).verdict, 'block');
  check('允许拆方块 → allow',
    guard('mine', { allowDig: true }).verdict, 'allow');
  check('未声明 allowDig（默认放行）→ allow',
    guard('mine', {}).verdict, 'allow');
  check('空手放置 → block',
    guard('place', { hasPlaceable: false }).verdict, 'block');
  check('有方块但没目标位置 → block',
    guard('place', { hasPlaceable: true, hasTarget: false }).verdict, 'block');
  check('有方块有目标 → allow',
    guard('place', { hasPlaceable: true, hasTarget: true }).verdict, 'allow');
  check('战斗不需要门控 → allow',
    guard('fight', {}).verdict, 'allow');
  check('闲聊不需要门控 → allow',
    guard('say', {}).verdict, 'allow');

  console.log('\n[4/6] 双语判据 —— 官方说 CJK 准确率不等同，所以语言要可切换');
  const HAS_CJK = /[\u4e00-\u9fff]/;
  const enMenu = buildActionMenu({ hp: 20, threat: { name: 'creeper', distance: 2 }, task: { type: 'mine' }, player: { distance: 15 } }, 'en');
  const zhMenu = buildActionMenu({ hp: 20, threat: { name: 'creeper', distance: 2 }, task: { type: 'mine' }, player: { distance: 15 } }, 'zh');

  check('英文菜单的动作集合与中文完全一致（只换语言，不换逻辑）',
    enMenu.map(m => m.id), zhMenu.map(m => m.id));
  check('英文判据里没有中文字符', enMenu.some(m => HAS_CJK.test(m.criteria)), false);
  check('中文判据里确实有中文（对照组，防止测了个空）', zhMenu.some(m => HAS_CJK.test(m.criteria)), true);
  check('每个英文判据都足够长，是自解释的句子而不是标签',
    enMenu.every(m => m.criteria.length > 40), true);
  // 检查"代码形态的字段名泄漏"，而不是检查某个英文单词 ——
  // 第一版我写成 /\bdistance\b/，结果把 "normal follow distance" 这句
  // 完全正常的英文散文判成了失败。判据本来就该是自然语言，
  // 真正要防的是把 `threat.name`、`hp < 8`、`is_day` 这种东西写进去。
  const LOOKS_LIKE_CODE = /[a-z_]+\.[a-z_]+|\bhp\b\s*[<>=]|\b[a-z]+_[a-z]+\b/i;
  check('英文判据里没有代码形态的字段名（threat.name / hp<8 / is_day）',
    enMenu.some(m => LOOKS_LIKE_CODE.test(m.criteria)), false);
  check('中文判据同样没有代码形态的字段名',
    zhMenu.some(m => LOOKS_LIKE_CODE.test(m.criteria)), false);
  check('未知语言回退到中文', buildActionMenu({ hp: 20 }, 'de')[0].criteria, buildActionMenu({ hp: 20 }, 'zh')[0].criteria);
  // ⚠️ instructions 在 P24 之后是**两套**（solo / company），不再是单一对象。
  //    所以这里要把两套都验一遍 —— 只验一套会让另一套静默坏掉。
  for (const mode of ['solo', 'company']) {
    check(`instructions[${mode}] 有英文版且不含中文`,
      HAS_CJK.test(ACTION_INSTRUCTIONS[mode].en), false);
    check(`instructions[${mode}] 中文版确实含中文`,
      HAS_CJK.test(ACTION_INSTRUCTIONS[mode].zh), true);
    check(`instructions[${mode}] 两语言都非空`,
      ACTION_INSTRUCTIONS[mode].zh.length > 20 && ACTION_INSTRUCTIONS[mode].en.length > 20, true);
  }

  console.log('\n[5/6] 默认后端 —— 有 key 也不能自己切过去');
  // 防回归：默认值曾经是 'auto'（有 key 就自动用 Jev）。那意味着
  // "环境里某天多了一个 key"会让行为悄悄改变、并开始花钱。
  // 外部付费依赖必须**显式打开**，所以默认是 'local'。
  //
  // 必须在干净环境的子进程里读 —— CFG 是加载时求值的，
  // 本进程的 env 已经被外面的 shell 污染了。
  const { execFileSync } = require('child_process');
  const probe = (env = {}) => {
    const clean = { ...process.env, ...env };
    for (const k of ['MC_DECISION_BACKEND', 'TYPESAFE_API_KEY', 'JEV_API_KEY']) {
      if (!(k in env)) delete clean[k];
    }
    return execFileSync(process.execPath, ['-e',
      `const m=require(${JSON.stringify(__filename)});`
      + `process.stdout.write(m.CFG.backend+'|'+m.pickBackend())`,
    ], { env: clean, encoding: 'utf8' }).trim();
  };
  check('不设任何环境变量 → 默认 local', probe(), 'local|local');
  check('有 TYPESAFE_API_KEY 但不设后端 → 仍然是 local（不会自己切过去）',
    probe({ TYPESAFE_API_KEY: 'ts_probe' }), 'local|local');
  check('显式设 jev → jev', probe({ MC_DECISION_BACKEND: 'jev' }), 'jev|jev');
  check('显式设 auto 且没 key → local', probe({ MC_DECISION_BACKEND: 'auto' }), 'auto|local');
  check('显式设 auto 且有 key → jev（想用 auto 仍然可以）',
    probe({ MC_DECISION_BACKEND: 'auto', TYPESAFE_API_KEY: 'ts_probe' }), 'auto|jev');

  console.log('\n[6/7] 自动换手 —— 空手/拿错东西时该换成什么');
  // 背景（问题 3「不会使用自己物品栏东西」）：她原来根本没有 equip 这个动作，
  // 于是"背包里有钻石镐"和"背包里啥都没有"对她是同一件事。
  //
  // 这些用例锚定的是**判据**，不是实现：将来换算法，只要判据还成立就该继续通过。
  const eq = (p) => pickAutoEquip(p);

  // --- 打分表本身
  check('钻石镐比木镐分高', scoreEquipItem('diamond_pickaxe').score > scoreEquipItem('wooden_pickaxe').score, true);
  check('剑算武器', scoreEquipItem('iron_sword').role, 'weapon');
  check('斧既算工具也算武器', scoreEquipItem('iron_axe').role, 'weapon');
  check('镐算工具', scoreEquipItem('stone_pickaxe').role, 'tool');
  check('泥土不是工具', scoreEquipItem('dirt'), { score: 0, role: 'none', label: '' });
  // ⚠️ 关键陷阱：`_axe` 是 `_pickaxe` 的后缀，天真的 endsWith 会把镐判成斧。
  check('镐不会被误判成斧', scoreEquipItem('iron_pickaxe').label.includes('镐'), true);
  check('镐不会被误判成斧(2)', scoreEquipItem('netherite_pickaxe').role, 'tool');
  // 模组命名空间要去掉，否则 'iron' 匹配不到
  check('带命名空间的物品也能识别材质', scoreEquipItem('mod:iron_pickaxe').score > scoreEquipItem('mod:wooden_pickaxe').score, true);
  check('不认识的物品给 0 分', scoreEquipItem('mystery_orb').score, 0);

  // --- 空手
  check('空手 + 背包有镐 → 换上',
    eq({ held: null, inventory: ['stone_pickaxe'] }).itemName, 'stone_pickaxe');
  check('空手 + 背包只有泥土 → 不换',
    eq({ held: null, inventory: ['dirt', 'cobblestone'] }).itemName, null);

  // --- 升级（手上已有，但有更好的）
  check('手持木镐 + 背包有钻石镐 → 换钻石镐',
    eq({ held: 'wooden_pickaxe', inventory: ['wooden_pickaxe', 'diamond_pickaxe'] }).itemName,
    'diamond_pickaxe');
  check('手持钻石镐 + 背包只有木镐 → 不换（已经最好）',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_pickaxe'] }).itemName, null);
  check('手持钻石镐 → 明说"已经是最好的"',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_pickaxe'] }).reason.includes('最好'), true);

  // --- 角色不匹配（最容易被朴素分数搞错的一条）
  // 钻石镐 40 分 > 木剑 15 分，但想打人时拿镐不如拿剑。
  check('想打人 + 手持钻石镐 + 背包有木剑 → 换木剑（分数更低但角色对）',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe', 'wooden_sword'], want: 'weapon' }).itemName,
    'wooden_sword');
  check('想打人 + 手持木剑 + 背包有钻石镐 → 不换',
    eq({ held: 'wooden_sword', inventory: ['wooden_sword', 'diamond_pickaxe'], want: 'weapon' }).itemName,
    null);
  // ⚠️ 这条用例一开始我自己写反了。最初的直觉是"想打人就不该拿镐"，
  //    但空手基础伤害 1，镐类 2~5 —— **拿镐明确优于空手**。
  //    规则的准确表述是："有真武器时工具不合格"，而不是"想打人就排斥工具"。
  check('想打人但背包只有镐、空着手 → 还是拿上镐（比空手强）',
    eq({ held: null, inventory: ['diamond_pickaxe'], want: 'weapon' }).itemName, 'diamond_pickaxe');
  check('想打人 + 手持镐 + 背包只有镐 → 不折腾',
    eq({ held: 'diamond_pickaxe', inventory: ['diamond_pickaxe'], want: 'weapon' }).itemName, null);

  // --- 平手时的确定性（同一输入必须同一输出，否则无法回归）
  check('同材质多件 → 结果稳定（不随 Map 顺序变）',
    eq({ held: null, inventory: ['iron_sword', 'iron_pickaxe'] }).itemName,
    eq({ held: null, inventory: ['iron_pickaxe', 'iron_sword'] }).itemName);

  // --- 边界：不认识的模组工具不该被当成"没有工具"
  check('空手 + 只有不认识的模组物品 → 不换（宁可不换也不乱拿）',
    eq({ held: null, inventory: ['mystery_orb'] }).itemName, null);
  check('空手 + 无背包参数 → 不崩且不换', eq({}).itemName, null);

  console.log('\n[7/7] 注意力偏移 —— 有人说话时"改变后续行为"，但**不打断**');
  // 用户明确要求：「不打断工作，只是改变后续行为」。
  //
  // 这一节锚定的是一条**不变量** + 一条**方向性**：
  //   不变量：attention 无论怎么变，work 一定仍在菜单里（不打断）
  //   方向性：attention.recent 时 follow 的优先级必须**更高**，work 必须**更低**
  //
  // ⚠️ 这是与 Mindcraft 的分歧点，所以必须有测试盯着 ——
  //    否则以后有人"顺手优化响应速度"就会把 work 从菜单里删掉，
  //    那正是我们需要避免的打断。

  const pr = (s) => {
    const m = buildActionMenu(s);
    const out = {};
    for (const x of m) out[x.id] = x.priority;
    return out;
  };

  const base = { hp: 20, task: { type: 'mine' }, player: { distance: 15 } };
  const withAttn = { ...base, attention: { recent: true, ageMs: 2000, blocksNewTask: true, text: 'hi' } };

  const p0 = pr(base);
  const p1 = pr(withAttn);

  // ---- 不变量：work 永远在
  check('【不打断】有人说话时 work 仍在菜单里',
    Object.keys(pr(withAttn)).includes('work'), true);
  check('【不打断】没人在说话时 work 也在',
    Object.keys(p0).includes('work'), true);
  check('【不打断】attention 为 null 时菜单结构不变',
    Object.keys(pr({ ...base, attention: null })).sort().join('|'),
    Object.keys(p0).sort().join('|'));

  // ---- 方向性：跟人被抬高
  check('有人说话 → follow 优先级变高', p1.follow > p0.follow, true);
  check('差距就是 18（可解释的常数，不是碰巧）', p1.follow - p0.follow, 18);

  // ---- 方向性：活被压低，但仍然高于 idle
  check('有人说话 → work 优先级变低', p1.work < p0.work, true);
  check('差距就是 −12', p1.work - p0.work, -12);
  check('压低后 work 仍然远高于 idle（不是变相取消）', p1.work > p1.idle, true);
  // ⚠️ explore 只在 `capability.canScan` 为真时才进菜单。上面的 fixture 没给
  //    capability，所以 `p1.explore` 是 undefined —— 拿它比较会得到 `58 > undefined`
  //    = false，看起来像"work 被压到 explore 之下了"。这是**夹具缺字段**，
  //    不是产品缺陷。补上 capability 再比。
  const withScan = { ...withAttn, capability: { canScan: true } };
  check('压低后 work 仍然高于 explore',
    pr(withScan).work > pr(withScan).explore, true);
  check('压低后 work 仍然高于 approach',
    (() => {
      const near = { hp: 20, task: { type: 'mine' }, player: { distance: 3 },
        attention: { recent: true, ageMs: 1000, blocksNewTask: true } };
      const p = pr(near);
      return p.work > p.approach;
    })(), true);

  // ---- 边界：不在线/没距离信息时不炸
  check('没人在线 + 注意力为真 → 不崩',
    (() => { try { pr({ hp: 20, attention: { recent: true, ageMs: 0 } }); return true; } catch (e) { return false; } })(),
    true);
  check('attention 缺字段（只有 recent）→ 不崩',
    (() => { try { pr({ hp: 20, task: { type: 'mine' }, attention: { recent: true } }); return true; } catch (e) { return false; } })(),
    true);
  check('attention.recent=false → 与没有 attention 完全一致',
    JSON.stringify(pr({ ...base, attention: { recent: false, ageMs: 99999 } })),
    JSON.stringify(p0));

  // ------------------------------------------------------------------------
  // [8/8] 自主生存 —— P24 的回归锁
  // ------------------------------------------------------------------------
  //
  // ⚠️⚠️ 这一段的第 1 条是全项目**最重要的一条测试**，理由是：
  //      P24 的故障形态是"菜单里没有那一类动作"，而菜单为空**不会报错、不会崩、
  //      不会留下任何日志** —— 她只是永远选 idle。也就是说：
  //      **这是一个沉默的故障，只有显式断言才能发现它。**
  //
  //      所以必须有一个用例，构造出"最空的状态"（没有任何外部输入），
  //      然后断言"菜单里至少有一个能改变世界的选项"。
  console.log('\n[8/8] 自主生存 —— 没人派活时她也要能为自己做事（field-log P24）');

  const ids8 = (s) => buildActionMenu(s).map(m => m.id);
  const has8 = (s, id) => ids8(s).includes(id);
  // ⚠️ `pb` 必须定义在这里（跟 has8 一起），不能留在后面 —— 上面 P31 的
  //    "优先级比较"断言要用它，而下移到原位置会变成 `ReferenceError`（TDZ）。
  //    这是"大段插入后必须复查锚点"的又一个小例子。
  const pb = (s) => Object.fromEntries(buildActionMenu(s).map(m => [m.id, m.priority]));

  // ---- ★ 回归锁：最空的状态也不能只剩 explore/idle ----------------------------
  //
  // 构造：所有 capability 都是空/假，没有 task、没有威胁、没有玩家。
  // 这个状态在实战里**天天出现** —— 玩家下线、周围没怪、她刚挖完一块地。
  const emptiest = {
    hp: 20,
    food: 20,
    task: null,
    threat: null,
    player: null,
    capability: {
      canEat: false, canEquipTool: false, canEquipWeapon: false,
      dropCount: 0, canScan: false, itemKinds: 0,
      gatherableCount: 0, buildMatCount: 0, matStacks: 0,
      huntableCount: 0, foodDropCount: 0, isDay: null,
    },
  };
  const emptyIds = ids8(emptiest);
  check('★ 最空的状态下菜单不为空（P24：这是沉默故障，只有断言能发现）',
    emptyIds.length > 0, true);
  check('★ 最空的状态至少有一个"能改变世界"的动作可选（不只是 explore/idle）',
    emptyIds.some(id => ['forage', 'gather', 'shelter', 'hunt', 'retreat'].includes(id))
      || emptyIds.includes('idle'), true);

  // ---- 逐条验证每个自主动作的进入条件（有证据才进，没证据不进）----------------

  // gather：缺建材 + 周围有可徒手采的建材
  const wantGather = {
    ...emptiest,
    capability: { ...emptiest.capability, gatherableCount: 12, buildMatCount: 9, matStacks: 0 },
  };
  check('缺建材 + 周围有建材 → gather 进菜单', has8(wantGather, 'gather'), true);
  check('建材充足（64 个）→ gather 不进菜单',
    has8({ ...wantGather, capability: { ...wantGather.capability, matStacks: 64 } }, 'gather'), false);
  check('建材不足但周围挖不到 → gather 不进菜单（不给她一个必然失败的动作）',
    has8({ ...wantGather, capability: { ...wantGather.capability, buildMatCount: 0, gatherableCount: 0 } }, 'gather'), false);

  // forage：饿 + 有食物来源
  const wantForage = {
    ...emptiest,
    food: 10,
    capability: { ...emptiest.capability, huntableCount: 3 },
  };
  check('饿了 + 周围有鸡 → forage 进菜单', has8(wantForage, 'forage'), true);
  check('不饿（food=20）→ forage 不进菜单', has8({ ...wantForage, food: 20 }, 'forage'), false);
  check('饿了但周围没有任何食物来源 → forage 不进菜单',
    has8({ ...wantForage, capability: { ...emptiest.capability, huntableCount: 0, foodDropCount: 0 } }, 'forage'), false);
  check('饿了但背包里本来就有吃的 → forage 仍进菜单（canEat 就是来源）',
    has8({ ...wantForage, capability: { ...emptiest.capability, canEat: true, eatItem: 'bread' } }, 'forage'), true);

  // hunt：周围有被动生物
  check('周围有被动生物 → hunt 进菜单',
    has8({ ...emptiest, capability: { ...emptiest.capability, huntableCount: 2 } }, 'hunt'), true);
  check('周围没有被动生物 → hunt 不进菜单', has8(emptiest, 'hunt'), false);

  // shelter：天黑（必须是明确的 false）**且手里有可放置的方块**
  //
  // ⚠️⚠️ P31：**这几条断言原本是错的，而且它们正在锁死那个死循环。**
  //    第一版写的是「天黑了 → shelter 进菜单」，用的样例 state 是 `emptiest`
  //    —— 而 `emptiest.capability.matStacks = 0`（**空背包**）。
  //    于是断言"空背包 + 天黑 → 菜单里有 shelter"，实机就变成：
  //    shelter(74) 稳居第一 → 必然失败（没方块可放）→ 无副作用 → 死循环。
  //
  //    **测试通过 ≠ 行为正确**：它会忠实地把 bug 锁进回归集。
  //    现在把样例拆成"手里有砖"和"手里没砖"两种，两个方向都断言 ——
  //    这才是这个动作真正的契约（"想搭" **且** "搭得成"）。
  const nightHasBlocks = {
    ...emptiest,
    capability: { ...emptiest.capability, isDay: false, matStacks: 12 },
  };
  const nightNoBlocks = {
    ...emptiest,
    capability: { ...emptiest.capability, isDay: false, matStacks: 0 },
  };
  check('天黑了 + 手里有方块 → shelter 进菜单', has8(nightHasBlocks, 'shelter'), true);
  check('白天 → shelter 不进菜单（哪怕手里有砖）',
    has8({ ...nightHasBlocks, capability: { ...nightHasBlocks.capability, isDay: true } }, 'shelter'), false);
  check('★ 天色未知（null）→ shelter 不进菜单（"读不到"不等于"天黑了"）',
    has8(emptiest, 'shelter'), false);
  check('★ P31：天黑了但手里**一块砖都没有** → shelter 不进菜单（放不下 = 必然失败 = 死循环的起点）',
    has8(nightNoBlocks, 'shelter'), false);
  check('★ P31：同一状态下 gather 必须在菜单里（shelter 让位之后，得有人接手去弄砖）',
    has8({ ...nightNoBlocks, capability: { ...nightNoBlocks.capability, gatherableCount: 12, buildMatCount: 9 } },
      'gather'), true);
  check('★ P31：空背包的夜里，gather 的优先级**高于** explore（她该去干活，不是四处看）',
    (() => {
      // ⚠️ 必须带 `canScan: true` —— `explore` 的进入条件就是"扫描可用"。
      //    第一版忘了给，于是 explore 压根不在菜单里，`p.gather > p.explore` 变成
      //    `50 > undefined` = false。**是断言写错，不是代码错** ——
      //    但它红得有价值：它逼我把"这条断言到底在测什么"想清楚。
      const p = pb({
        ...nightNoBlocks,
        capability: { ...nightNoBlocks.capability, canScan: true, gatherableCount: 12, buildMatCount: 9 },
      });
      return p.explore != null && p.gather > p.explore;
    })(), true);

  // retreat：低血 + 无贴身威胁
  check('低血 + 无威胁 → retreat 进菜单', has8({ ...emptiest, hp: 5 }, 'retreat'), true);
  check('满血 → retreat 不进菜单', has8(emptiest, 'retreat'), false);
  check('★ 低血 + 有贴身威胁 → retreat 不进菜单（此时该走 flee，不该出现语义重复的选项）',
    has8({ ...emptiest, hp: 5, threat: { name: 'zombie', distance: 2 } }, 'retreat'), false);
  check('★ 低血 + 有贴身威胁 → flee 在菜单里（retreat 的替代者确实存在）',
    has8({ ...emptiest, hp: 5, threat: { name: 'zombie', distance: 2 } }, 'flee'), true);

  // ---- 不打断工作：有 task 时，自己的事不能压过 work --------------------------
  //
  // ⚠️ 用户明确要求「不打断工作，只是改变后续行为」。
  //    但 shelter / forage 的优先级（74/75）**刻意高于 work（70）** ——
  //    这是"先保命才能把活干完"的例外。所以要明确锁住这个例外的**边界**：
  //    只有"真的会死"的事才越权，普通的"缺材料"不能。
  const busy = {
    ...emptiest,
    hp: 20,
    food: 10,
    task: { type: 'mine' },
    capability: {
      ...emptiest.capability,
      gatherableCount: 12, buildMatCount: 9, matStacks: 0, huntableCount: 3,
    },
  };
  check('【不打断】有活时 work 仍在菜单里', has8(busy, 'work'), true);
  check('【不打断】"缺建材"不越权 —— gather 低于 work',
    pb(busy).gather < pb(busy).work, true);
  check('【保命例外】"快饿死"越权 —— forage 高于 work（先活下来才能把活干完）',
    pb(busy).forage > pb(busy).work, true);
  // ⚠️ P31：shelter 的越权现在**多一个前提** —— 手里得有可放置的方块。
  //    断言也必须带上它，否则测的是"空手下她要越权搭遮蔽"这件**本来就不该发生**的事。
  //    （上一版就是因为少了 `matStacks`，才把这个 bug 锁进了回归集。）
  const busyNight = {
    ...busy,
    capability: { ...busy.capability, isDay: false, matStacks: 12 },
  };
  check('【保命例外】"天黑 + 手里有砖"越权 —— shelter 高于 work（不处理就会被耗死）',
    pb(busyNight).shelter > pb(busyNight).work, true);
  check('★ P31：天黑但空手时 shelter 不进菜单 —— 没有"越权"可言，它压根不该在场',
    pb({ ...busy, capability: { ...busy.capability, isDay: false } }).shelter, undefined);

  // ⚠️ `awayFromTask = -12`（刚被叫过时压低 work）。所以要检查**压低之后**
  //    慢性需求会不会反超 —— 如果会，那"刚被叫过就跑去挖土"就会发生，
  //    而"处理消息不及时"正是用户最初报的问题之一。
  const busyAttn = { ...busy, attention: { recent: true, ageMs: 500 } };
  check('【不打断】刚被叫过、work 被压低 12 之后，gather 仍然不越权',
    pb(busyAttn).gather < pb(busyAttn).work, true);
  check('【不打断】刚被叫过时 hunt 也不越权',
    pb(busyAttn).hunt < pb(busyAttn).work, true);
  check('【保命例外】刚被叫过时 forage 仍然越权（快饿死就是快饿死）',
    pb(busyAttn).forage > pb(busyAttn).work, true);
  // ⚠️ `retreat`（低血养伤）**刻意不越权** —— 这一条我原本写反了，是自测纠正的。
  //
  //    我一开始想当然地把它归进"保命例外"，断言它该高于 work。实测 66 < 70，红了。
  //    然后想清楚：**`retreat` 的进入条件是"低血 + 没有贴身威胁"** ——
  //    也就是说她**并不在流血**，只是状态不佳。而 work 是玩家亲口派的活。
  //    如果"血低于 8 就搁置玩家的活"，那么被打一下（很常见）她就会停下手里的活，
  //    "不打断工作"就成了空话。
  //
  //    真正配越权的只有两个：
  //      · `forage`  饿到 ≤14 —— 再往下就会掉血、跑不动，是**正在滑向死亡**
  //      · `shelter` 天黑且无遮蔽 —— 不处理就会**被持续耗死**
  //    两者都是"不处理就真的会死"，而 `retreat` 是"处理了更好，不处理也死不了"。
  check('【不打断】retreat 不越权 —— 低血但没在流血，就不该搁置玩家派的活',
    pb({ ...busy, hp: 5, player: null, attention: {} }).retreat
      < pb({ ...busy, hp: 5, player: null, attention: {} }).work, true);
  check('【不打断】retreat 仍然高于 gather/hunt（同样是自己的事，它更急）',
    (() => {
      const p = pb({ ...busy, hp: 5, player: null, attention: {} });
      return p.retreat > p.gather && p.retreat > p.hunt;
    })(), true);
  // ★ 通用不变量：慢性需求（gather/hunt）在**任何** attention 状态下都不越权。
  //   这条断言的价值在于它不依赖具体数字 —— 以后有人改了优先级常数，
  //   只要违反了"慢性需求不打断工作"，这里就会红。
  check('★ 不变量：慢性需求在任何 attention 状态下都低于 work',
    (() => {
      for (const attn of [null, { recent: false, ageMs: 9999 }, { recent: true, ageMs: 0 }]) {
        const p = pb({ ...busy, attention: attn });
        if (p.gather >= p.work) return false;
        if (p.hunt >= p.work) return false;
      }
      return true;
    })(), true);

  // ---- buildSelfNeeds 自身的行为 --------------------------------------------
  const needs = buildSelfNeeds.bind(null);
  check('buildSelfNeeds：食物 20 且无来源 → 不认为该觅食',
    needs({ hp: 20, food: 20, capability: {} }).needFood, false);
  check('buildSelfNeeds：食物 10 且有来源 → 认为该觅食',
    needs({ hp: 20, food: 10, capability: { huntableCount: 1 } }).needFood, true);
  check('buildSelfNeeds：isDay 为 null → needShelter 为 false（不猜）',
    needs({ hp: 20, food: 20, capability: { isDay: null } }).needShelter, false);
  check('buildSelfNeeds：isDay 为 false → needShelter 为 true',
    needs({ hp: 20, food: 20, capability: { isDay: false } }).needShelter, true);
  check('buildSelfNeeds：完全不带参数 → 不崩，且不认为有啥需求',
    (() => {
      try {
        const n = buildSelfNeeds();
        return !n.needFood && !n.needMaterials && !n.needShelter && !n.hpLow;
      } catch (e) { return false; }
    })(), true);
  check('buildSelfNeeds：reasons 在缺证据时说明了原因（可排查）',
    needs({ hp: 20, food: 10, capability: {} }).reasons.length > 0, true);

  // ---- pickInstructMode：solo / company 的分派 -----------------------------
  check('pickInstructMode：有人在旁边 → company',
    pickInstructMode({ player: { distance: 5 } }), 'company');
  check('pickInstructMode：没人在场 → solo', pickInstructMode({}), 'solo');
  check('pickInstructMode：刚被叫过（即使没看到人）→ company',
    pickInstructMode({ attention: { recent: true } }), 'company');
  check('pickInstructMode：player 存在但 distance 为 null → solo（距离未知不算在场）',
    pickInstructMode({ player: { distance: null } }), 'solo');
  check('pickInstructMode：不传参数 → solo（不崩）', pickInstructMode(), 'solo');
  check('★ solo 的 instructions 确实鼓励自主（不含"宁可待命"）',
    /待命/.test(ACTION_INSTRUCTIONS.solo.zh), false);
  check('★ company 的 instructions 确实鼓励待命',
    /待命/.test(ACTION_INSTRUCTIONS.company.zh), true);

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

module.exports = {
  CFG,
  TUNING,
  DO_NOT_MELEE,
  CRITERIA,
  ACTION_INSTRUCTIONS,
  buildActionMenu,
  buildSelfNeeds,
  pickInstructMode,
  criteriaFor,
  guard,
  decide,
  localDecide,
  pickBackend,
  backendStatus,
  apiKey,
  resetBreaker,
  HARD_BLOCK,
  scoreEquipItem,
  pickAutoEquip,
};
