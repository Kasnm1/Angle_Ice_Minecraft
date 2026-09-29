// tools.js —— 她"能做什么"的分组。
//
// `MIND_TOOLS`（只有意识层有的工具：记忆、心愿、计划、复盘、说、等待…）叠加在
// `body.TOOLS`（bridge 动作 + 查书）之上 → `ALL`；再按"什么时候才用得上"分组：
//
// - `SPECS`：每个工具给模型的说明
// - `GROUPS` / `TOOL_GROUPS` / `UNGROUPED`：常驻组 + 按需组
// - `GROUP_ROUNDS` / `GROUP_CUES`：按需组管几轮、什么话触发
// - `groupsFromBody()` / `pickSpecs()` / `activateGroup()` / `activeGroups()`：这一轮带哪些
// - `kindOf()`：工具的类型（info / memory / skill / end / 动作）
//
// `MIND_TOOLS` 里的工具实现会用 `startJob` / `runTool`（在 actions.js），所以这里用
// **延迟**转发壳取它们（见 wiring.js）；`knownStations` / `homeStockItems` / `shortName` /
// `planFacts` 是 MIND_TOOLS 要用的零件，跟着一起留在本文件。
//
// 第 3 步（e）拆 `src/mind/mind.js`（2026-09-29，只搬移不改逻辑）。

const { W, CFG, body, speech, mem, knowledge, ambition, review, ledgerLib, night, plan, storagePolicy, TOOLS, bridge, parseArgs, normalizeArgs, toolSpec, summarize } = require('./state');
const wiring = require('./wiring');
function bodyNow (...a) { return wiring.think().bodyNow.apply(null, a); }
function startJob (...a) { return wiring.actions().startJob.apply(null, a); }
function runTool (...a) { return wiring.actions().runTool.apply(null, a); }
const { log, scene } = require('./runtime');
/** 她记得在哪的方块（工作站）：从她的记忆里找 */
function knownStations () {
  const set = new Set();
  for (const m of mem.load().memories) if (m.status !== 'stale') for (const a of m.about || []) if (String(a).includes(':') || /^[a-z_]+$/.test(a)) set.add(String(a).includes(':') ? a : `minecraft:${a}`);
  return set;
}
/** 家里箱子记得的存货 [{name,count}]（做过的东西收进箱子，目标不该退回"没做"） */
function homeStockItems () {
  const h = mem.getHome();
  return Object.values(h?.stock || {}).flatMap(b => Object.entries(b.items || {}).map(([name, count]) => ({ name, count })));
}
const shortName = (id) => knowledge.label(id).replace(/\([^)]*\)$/, '');
const planFacts = (...a) => wiring.think().planFacts.apply(null, a);

const MIND_TOOLS = {
  learn: {
    kind: 'memory',
    desc: '记下一件事（你自己的笔记，以后会在相关的时候想起来）。kind: lesson 教训 / promise 答应别人的事 / intention 自己打算做的事 / fact 事实发现 / relation 知识（主语 s —关系 r→ 宾语 o）/ feeling 心情。about 写相关的人名、物品 id、地点，方便以后想起。同一件事再记会变得更牢。',
    params: {
      kind: { type: 'string', enum: mem.KINDS }, text: { type: 'string' },
      about: { type: 'array', items: { type: 'string' } },
      s: { type: 'string' }, r: { type: 'string' }, o: { type: 'string' },
      source: { type: 'string', enum: ['experience', 'told', 'read', 'guess'], description: '亲身经历 / 别人告诉的 / 书上看的 / 猜的' },
    },
    required: ['kind'],
    run: (a) => mem.learn(a),
  },
  revise: {
    kind: 'memory',
    desc: '改一条记忆：发现记错了就改 text；过时了/不对了 status=stale；答应的事做完了 status=done。',
    params: { id: { type: 'number' }, text: { type: 'string' }, status: { type: 'string', enum: ['active', 'stale', 'open', 'done'] } },
    required: ['id'],
    run: ({ id, ...rest }) => mem.revise(id, rest),
  },
  judge: {
    kind: 'memory',
    desc: '更新你对某个玩家的看法：impression 用你自己的话写对他的印象（会覆盖旧的，所以要写完整）；affinity/trust 是好感/信任的变化量（-20..20）；fact 记一件关于他的事；trait 一个性格标签。',
    params: {
      player: { type: 'string' }, impression: { type: 'string' },
      affinity: { type: 'number' }, trust: { type: 'number' }, fact: { type: 'string' }, trait: { type: 'string' },
    },
    required: ['player'],
    run: ({ player, ...rest }) => mem.judge(player, rest),
  },
  recall: {
    kind: 'info',
    desc: '主动回想：按关键词翻你的记忆（人、物品、地点、事情都行）。',
    params: { query: { type: 'string' } }, required: ['query'],
    run: ({ query }) => ({ text: mem.renderRecall(mem.recall(query, { limit: 10 }), []) || '想不起相关的事' }),
  },
  use_skill: {
    kind: 'skill',
    desc: '照着你会的做法（【你会的做法】里的技能 id）直接做，不用一步步想。',
    params: { id: { type: 'string' } }, required: ['id'],
  },
  save_skill: {
    kind: 'memory',
    desc: '把一套做法存成技能（名字 + 按顺序的动作步骤）。一串动作做成了会自动存；分几次才做成的、或者你想改进旧做法时用这个。',
    params: {
      name: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } },
      about: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'steps'],
    run: (a) => mem.learnSkill({ ...a, steps: (a.steps || []).map(st => ({ tool: st.tool, args: normalizeArgs(st.tool, st.args || {}) })) }),
  },
  my_dream: {
    kind: 'info',
    desc: '看看你的心愿（做遍《食录逸闻》的食物）进度，和现在最有希望做成的几道菜。chapter 可以只看某一章（如 海鲜大餐）。',
    params: { chapter: { type: 'string' } }, required: [],
    run: ({ chapter }) => {
      const p = ambition.progress();
      const c = ambition.candidates({ inventory: W.state?.items || [], knownStations: knownStations(), limit: 8, chapter: chapter || null });
      return { text: `${ambition.summary({ inventory: W.state?.items || [], knownStations: knownStations() }).split('\n')[0]}\n各章：${p.byChapter.map(x => `${x.title} ${x.made}/${x.total}`).join('，')}\n${chapter ? `《${chapter}》里` : ''}最有希望的：\n${ambition.renderCandidates(c)}` };
    },
  },
  plan_view: {
    kind: 'info',
    desc: '看你的长期计划（目标、每一步、做到哪了），以及现在的进展（工具/护甲/家…）和接下来可以做的事。',
    params: {}, required: [],
    run: () => ({ text: `${plan.render({ full: true })}
现状：${plan.renderFacts(planFacts())}
可以做的：${plan.ideas(planFacts()).map(x => `${x.text}（${x.why}）`).join('；') || '（想不出来了）'}
最近：${plan.history().map(h => h.text).join('；')}` }),
  },
  plan_set: {
    kind: 'memory',
    desc: '定一个长期计划：目标 + 几步（按你想的顺序）。每一步可以写"做成的标志"（done: {have: {物品名: 数量}}，背包里有了就自动打勾）。'
      + '没人找你的时候你会照着它推进；情况变了（做完了、发现更要紧的、缺的东西变了）就重新定。',
    params: {
      goal: { type: 'string' }, why: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'object' } }, required: ['text'] } },
    },
    required: ['goal', 'steps'],
    run: (a) => { const p = plan.setPlan(a); return { text: `定好了：${p.goal}，${p.steps.length} 步` }; },
  },
  plan_step: {
    kind: 'memory',
    desc: '改计划里的一步：index（从 0 数）+ ok:true 标做完 / text 改写 / drop:true 去掉；add 在最后加一步。',
    params: { index: { type: 'number' }, ok: { type: 'boolean' }, text: { type: 'string' }, drop: { type: 'boolean' }, add: { type: 'string' } },
    required: [],
    run: (a) => { plan.updateStep(a); return { text: plan.render() }; },
  },
  focus_on: {
    kind: 'memory',
    desc: '决定接下来专心研究哪道菜（做成之前会一直惦记着它）。',
    params: { name: { type: 'string' } }, required: ['name'],
    run: ({ name }) => ambition.setFocus(name),
  },
  home_stock: {
    kind: 'info',
    desc: '想想家里的箱子里有什么（你打开看过的都记得个大概）。不给 query 就是总览；给物品名/类别就是它在哪、大概多少、多久前看的。',
    params: { query: { type: 'string' } }, required: [],
    run: ({ query }) => ({ text: mem.renderHomeStock(query || null, shortName) }),
  },
  set_home: {
    kind: 'memory',
    desc: '把现在所在的地方认定为家（庇护所）。radius 是家的范围（默认 24 格，整栋房子上下几层都算）。家里的箱子是自己的仓库，整理过一次分类就记住。',
    params: { radius: { type: 'number' }, name: { type: 'string' } }, required: [],
    run: ({ radius, name }) => {
      if (!W.state?.pos) throw new Error('看不到自己在哪');
      const h = mem.setHome({ ...W.state.pos, radius: radius || 24, name });
      return { home: h.center, radius: h.radius };
    },
  },
  report_issue: {
    kind: 'memory',
    desc: '给照顾你身体的人留张纸条（他们会看、会修）：你发现自己不对劲 —— 身体不听使唤（明明能走却走不过去、动作回报和实际不一样）、书上查到的和实际对不上、你理解错了别人的意思、说错了话、不知道该怎么办。只写真的不对劲的，一件事一张；不是日记，也不是 learn（那是你自己下次注意）。what 写发生了什么（具体：哪个动作、什么东西、报了什么），expected 写你本来想要的结果，guess 写你猜为什么（猜不到就不写）。',
    params: {
      category: { type: 'string', enum: review.CATEGORIES },
      what: { type: 'string' }, expected: { type: 'string' }, guess: { type: 'string' },
    },
    required: ['category', 'what'],
    run: ({ category, what, expected, guess }) => {
      if (!what) throw new Error('what 要写发生了什么');
      review.record({ source: 'self', category: review.CATEGORIES.includes(category) ? category : '其他', what, expected, guess, recentFails: W.recentFails.slice(-3), ...scene() });
      return { note: '纸条留好了' };
    },
  },
  wait: {
    kind: 'end',
    desc: '这一刻没什么要说要做的了，等下一件事发生。（安静陪着也是陪伴）',
    params: { reason: { type: 'string' } }, required: [],
  },
  tools: {
    kind: 'info',
    desc: '把一组工具拿出来用（平时只带着常用的那些，别的先收着）。要用到没带在身上的工具时，先把它叫出来：build 建造/布置、farm 农活/动物/做饭、store 箱子/仓库、quest 任务书/交易、travel 远行/下矿、skill 存技能。叫过之后接下来几轮都在。不给 group 就列出每组装了什么。',
    params: { group: { type: 'string', enum: ['core', 'build', 'farm', 'store', 'quest', 'travel', 'skill'] } }, required: [],
    run: ({ group }) => {
      if (!group) {
        return { groups: Object.fromEntries(Object.entries(GROUPS).map(([g, l]) => [g, l.filter(n => ALL[n])])), 现在带着的: [...activeGroups()] };
      }
      return activateGroup(group);
    },
  },
};

const ALL = { ...TOOLS, ...MIND_TOOLS };
function kindOf (name) {
  const t = ALL[name];
  if (!t) return null;
  if (t.kind === 'action' || t.kind === 'gesture') return 'action';
  if (t.kind === 'skill') return 'skill';
  return t.kind;   // speech / info / memory / end
}
const SPECS = Object.entries(ALL).map(([n, t]) => toolSpec(n, t));

// --------------------------------------------------------------- 工具按场景分组
//
// 为什么（2026-09-28 输入审计）：89 个工具 26,059 字符，占一次输入 ~49%，而 19 个从没被调过、
// 30 个全程 ≤2 次。冷门工具合计 5,672 字符 = 工具定义的 39.7%。所以每轮只带"常驻组 + 当前用得上的按需组"。
// **一个工具都没删**（fish/animal/ride 这些新加的也照留）—— 她需要时会自己用 tools(group) 或关键词自动带出来。
//
// 分组原则：
//   · core 常驻 —— 说话 / 看 / 走 / 拿 / 最基本的手上活。日志里最高频的都在这里（say 396、wait 365、
//     look_at 112、pickup 105、craft 95、goto 88、scan_blocks 76、come_to 70、attack 65、knowledge_search 60…）
//   · 其余按"什么时候才用得上"分：站在工地上才用得上 build、蹲在箱子前才用得上 store…
const GROUPS = {
  // 常驻：任何时刻都可能要用的
  core: ['say', 'wait', 'stop', 'look_at', 'look_around', 'look_area', 'scan_blocks', 'inventory', 'item_info', 'recipe',
    'knowledge_search', 'guide_search', 'item_uses', 'how_to_obtain', 'recall', 'learn', 'revise', 'judge', 'use_skill',
    'my_dream', 'report_issue', 'tools', 'goto', 'come_to', 'follow', 'climb', 'climb_down', 'pickup', 'mine', 'craft',
    'use_item', 'wear', 'equip', 'unequip', 'eat', 'attack', 'give', 'nudge', 'motor', 'door', 'sleep_in_bed', 'go_home',
    'self_rescue', 'focus_on', 'plan_view',
    // 2026-09-28 实测回归：主人说"烤羊肉"，smelt 在按需组、关键词里又没有"烤"，她手上没有烧东西的工具，
    // 只好拿生羊肉右键炉灶试了三次放弃。做饭 / 烧东西 / 完整制作链 / 火把 / 放方块是日常动作，常驻。
    'smelt', 'cook_pot', 'make_item', 'make_torches', 'light_up', 'place',
    // 火把开关（2026-09-29）：主人随时可能改口（"家里别插了"），常驻 —— 不然她手上没这工具，
    // 听见了也改不了设置（和 make_torches / light_up 同一类日常动作）。
    'set_torch_mode',
    // 同一次复查：背包 / 拿东西（在矿洞里身边没箱子时 store 组不会被带上）、服务器命令（/home /tpa）、
    // 水桶（灭火、落地水）、长期计划的更新（闲着接着做要用）、查家里库存（只读）—— 都是日常的，常驻
    'open_backpack', 'take_items', 'home_stock', 'run_command', 'bucket', 'plan_set', 'plan_step'],

  // 按需：建造 / 布置家里
  build: ['place', 'place_nicely', 'place_structure', 'design_build', 'build_work', 'build_status', 'build_cancel',
    'plan_layout', 'furnish', 'layout_status', 'plan_set', 'plan_step', 'light_up', 'make_torches', 'wiggle'],

  // 按需：农活 / 养动物 / 做饭
  farm: ['till', 'farm', 'animal', 'ride', 'fish', 'bucket', 'cook_pot', 'make_item', 'smelt'],

  // 按需：箱子 / 仓库整理
  store: ['open_container', 'container_put', 'container_take', 'container_close', 'store_items', 'take_items',
    'organize_storage', 'sort_container', 'sort_inventory', 'check_chests', 'loot_nearby', 'open_backpack', 'home_stock', 'set_home'],

  // 按需：任务书 / 交易
  quest: ['quest_submit', 'quest_claim'],

  // 按需：出远门 / 探险 / 下矿
  travel: ['delve', 'material_plan', 'run_command'],

  // 按需：把做成功的做法沉淀成技能（低频，平常不用占位置）
  skill: ['save_skill'],
};
// 每个工具归到哪些组（一个工具可以属于多组；core 里的工具照样可以再出现，去重时以 core 优先）
const TOOL_GROUPS = {};
for (const [g, list] of Object.entries(GROUPS)) {
  for (const n of list) { if (!ALL[n]) continue; (TOOL_GROUPS[n] ||= []).push(g); }
}
// 没写进任何组的工具：兜底进 core（宁可多带一个，也不能让她"想不起来还有这工具"）
const UNGROUPED = Object.keys(ALL).filter(n => !TOOL_GROUPS[n]);
for (const n of UNGROUPED) (TOOL_GROUPS[n] ||= []).push('core');

// 这一轮带出来的按需组还有几轮有效（tools(group) 叫进来的组管 N 轮；自动激活的只这一轮）
const GROUP_ROUNDS = 8;
W.groupActive = {};   // { [组名]: 到期轮次序号 }

/** 场景关键词 → 该带哪些按需组（从聊天/事件的原话里认） */
// ⚠️ 关键词要够具体（codex R-fix4-8）：以前有单字"地""远""存""挖"，
//    普通一句闲聊就能把 farm / travel / store 全激活，分组省位置的意义就没了
//    （实测：说"我在远处的地里存了点东西"→ 三组全开）。改成多字的具体词。
const GROUP_CUES = [
  { re: /钓鱼|釣魚|渔船|漁船|划船|坐船/u, groups: ['farm'] },
  { re: /做饭|做飯|烤|煮|炒|炖|燉|熔炉|熔爐|烟熏炉|煙熏爐|高炉|高爐|厨锅|廚鍋|炉灶|爐灶|烧成|燒成|冶炼|冶煉|做菜|做吃的/u, groups: ['farm'] },
  { re: /种地|種地|耕地|庄稼|莊稼|农田|農田|小麦|小麥|胡萝卜|胡蘿蔔|马铃薯|馬鈴薯|南瓜|西瓜|甘蔗|养牛|養牛|畜牧|驯服|馴服|喂食|餵食|收割|播种|播種|浇水|澆水|剪羊毛|剪毛|挤奶|擠奶|牛奶|繁殖|配种|配種|生小|喂动物|餵動物|喂牛|喂羊|喂猪|喂鸡|餵牛|餵羊|餵豬|餵雞/u, groups: ['farm'] },
  { re: /箱子|箱子里|柜子|櫃子|骨粉盒|仓库|倉庫|储藏|儲藏|整理背包|装进背包|裝進背包|放进去|拿出来的/u, groups: ['store'] },
  { re: /建造|盖房|蓋房|盖房子|蓋房子|建房子|造房子|盖起来|蓋起來|盖个|蓋個|盖一面|蓋一面|砌墙|砌牆|搭墙|搭牆|面墙|面牆|铺地板|鋪地板|盖屋顶|蓋屋頂|装修|裝修|布置|佈置|家具|图纸|圖紙|施工|动工|動工/u, groups: ['build', 'store'] },
  { re: /任务|任務|任务书|任務書|任务奖励|FTBQ|提交任务|交任务|章节奖励|章節獎勵/u, groups: ['quest'] },
  { re: /下矿|下礦|挖矿|挖礦|矿洞|礦洞|洞穴|探险|探險|遗迹|遺跡|远门|遠門|出门远行|出門遠行|钻石|鑽石|附魔|古代残骸/u, groups: ['travel'] },
  { re: /技能|记下做法|記下做法|存成技能|下次照做/u, groups: ['skill'] },
];
/** 身体状态 → 该带哪些按需组 */
function groupsFromBody (s) {
  const g = new Set();
  if (!s) return g;
  // 脚边有箱子/桶（或开着 GUI）：仓储那组带上
  if ((s.unseenChests || []).length || (s.nearby || []).some(e => /chest|barrel|shulker|hopper|drawer/i.test(e.name || ''))) g.add('store');
  // ⚠️ 手持字段是 `equipment.hand`（hands.js 的 equipment() 返回 hand），
  //    不是 `mainhand` —— 以前读 mainhand 恒为 undefined，
  //    "拿着木板/火把的时候就该带建造组"这条从来没生效过（codex R-fix4-6）。
  const holding = String(s.equipment?.hand || s.equipment?.mainhand || s.items?.[0]?.name || '');
  if (holding && /torch|lantern|planks|brick|stone|glass|slab|stairs|fence|door|bed|chest|carpet|wool|sign|flower|pot|frame|candle|lamp/i.test(holding)) { g.add('build'); }
  // 骑着东西 / 在身上有船（水里）：载具钓鱼那组
  // ⚠️ 骑乘要看 body 给的载具状态（以前只从手里/附近的名字猜，识别不到"真的骑着"）
  if (s.vehicle || /boat|minecart/i.test(holding) || (s.nearby || []).some(e => /boat|minecart/i.test(e.name || ''))) g.add('farm');
  // 身边有动物：农牧那组
  if ((s.nearby || []).some(e => e.kind === 'animal' || /cow|sheep|chicken|pig|horse|rabbit|bee|villager/i.test(e.name || ''))) g.add('farm');
  // 开着界面（箱子/工作站/熔炉…）：仓储 + 建造都可能用得上
  if (s.windowOpen || s.containerOpen) { g.add('store'); g.add('build'); }
  // 真的在挖矿/下矿（本能或当前动作）：探险那组
  if (/dig|mine|delve/i.test(String(s.currentAction || ''))) g.add('travel');
  // 很暗 / 身上没火把 —— 点亮（light_up / make_torches）就在建造组里，不带出来她这时候就使不上
  const hasTorch = (s.items || []).some(i => /torch|lantern/i.test(i.name || '')) || /torch|lantern/i.test(holding);
  if (s.dark || s.torches === 0 || (!hasTorch && (s.items || []).some(i => /coal|charcoal|stick|planks|log/i.test(i.name || '')))) g.add('build');
  return g;
}
/** 这一轮该发哪些工具的 spec：常驻组 + 当前激活的按需组。always 里的工具一定带上（她刚叫过的组）。 */
function pickSpecs (s, activeGroups = new Set()) {
  const want = new Set(['core', ...activeGroups]);
  const out = [];
  for (const [n, t] of Object.entries(ALL)) {
    const gs = TOOL_GROUPS[n] || ['core'];
    if (gs.some(g => want.has(g))) out.push(toolSpec(n, t));
  }
  return out;
}
/** 她调 tools(group) 时用的：把组叫进来，管 GROUP_ROUNDS 轮（含叫它的这一轮） */
function activateGroup (name) {
  if (!GROUPS[name]) return { ok: false, error: `没有这个组：${name}`, groups: Object.keys(GROUPS) };
  const from = W.groupRound || 0;
  W.groupActive[name] = from + GROUP_ROUNDS;   // 第 from+GROUP_ROUNDS 轮结束时到期
  return { ok: true, group: name, 带上: GROUPS[name].length, 管到第几轮: W.groupActive[name] };
}
/** 当前生效的按需组（过期的清掉） */
function activeGroups () {
  const r = W.groupRound || 0;
  const out = new Set();
  for (const [g, until] of Object.entries(W.groupActive || {})) {
    if (until > r) out.add(g); else delete W.groupActive[g];   // until = 到期的那一轮，那一轮开始就不带了
  }
  return out;
}

// ------------------------------------------------------------------ 她是谁
//
// 可爱（2026-09-28 主人定）："可爱、温柔、萌"，但不要"来啦来啦～我这就跑过去！"—— 玩游戏不打很多标点；叠字、呜呜可以。
// 依据：modpack-study/cute/（data.md 真实聊天统计、toolkit.md 手法、web.md 网上资料 35 个链接）：
//   玩家 7.3 字/条、0.31 个标点、从不用～！啦；"呀"最安全、"呢"像客服、满屏语气词/好滴好哒显得做作 → 可爱靠用词和态度。
//
// 「开口之前，先活在这一刻」一节借的是 HDS Interlude（_ref/hds-interlude，AGPL，只借思路没拷代码）的写法：
// 先写角色此刻的生活/心境，消息只是从里面长出来的一个动作（src/script/lived-writing.ts）；
// 按消息本身 + 两人之间刚才的线来读（src/narrator.ts:1600）；以及按模型族的文风补丁
// （src/specialization.ts：GLM 的"不无故温暖"、Kimi 的"可以犹豫/只回一部分"、Gemini/DeepSeek 的"白、具体、不堆成语"、
// Claude 的"不收尾"）。我们的主力正好是 gemini-flash ⇄ deepseek。


module.exports = { MIND_TOOLS, ALL, SPECS, GROUPS, TOOL_GROUPS, UNGROUPED, GROUP_ROUNDS, GROUP_CUES,
  groupsFromBody, pickSpecs, activateGroup, activeGroups, kindOf };
