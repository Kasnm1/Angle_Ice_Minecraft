# `src/body/` —— 手 / 常识 / 装备 / 仓库 / 物品账

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里"手"那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `hands.js` | **汇总**（第 3 步重构，2026-09-28）。只剩一行转发到 `index.js`（**不用符号链接**：Windows 的 git 默认签出成纯文本，require 会炸）—— `require('../body/hands')` 和 `--selftest` 都照旧，导出名与顺序一字不差。真正的内容在下面 8 个文件 + `index.js`。挂到 bridge 上的"手"：`/eat` `/use` `/wear` `/craft2`（整合包真实配方）`/smelt` `/container/*`。每个动作比对前后背包/装备/饥饿值，不信"调用成功" |
| `index.js` | `hands.js` 的目标：8 个子文件的 `require` + `__ns` 汇总 + `bind()` 回填 + `routes()`（75 条路由）+ 47 个导出。**改路由挂载只动这里** |
| `util.js` | 分出来 45 项：`Vec3`/注册表小工具、背包计数、可达性（`canUseFrom`/`canUseNow`）、门/梯子判定、NBT/Sophisticated 读写、`inHomeArea`。**共享状态 `knowledge`/`K()` 在这里** |
| `containers.js` | 53 项：箱子 / 背包 / 饰品栏（curios）/ FTBQ / 结构放置，及排序与身份比对（`stackIdentity`/`sameTotals`）。**`HSTATE` 的 getter 在这里**，`backpackChain` 串行队列。**整理仓库（`organizeStorage`）自己会把精妙背包里的倒出来归位**（2026-09-29 问题 1）：`drainBackpackOnePass` 按快照前后差核对真实变化，`backpack` 分项单独报 `unreadable`/`chestsFull`/`drained`/`empty` —— 读不到 ≠ 里面没有 |
| `craft.js` | 34 项：合成（手搓 / 配方书）、熔炉、吃 / 用 / 穿 / 给、厨锅。**`HSTATE` 的 getter 在这里**。合成/吃饭都先看精妙背包（`topUpFromBackpack`）；缺工作台/熔炉时**自己放下再用完挖回**（`withPlacedStation`，2026-09-29 问题 2b/3）。`wear`（2026-09-29 问题 3）：要穿的那件**已经在它该在的槽位上** → 直接回 `{worn, slot, alreadyWorn:true, via:'already-worn'}`，不报"背包里没有"（`findItem` 看不见身上穿着的，会误判缺货）。判据要**先于** `findItem` 的 null 抛出，用 `slotByName(wantId)` + `equipment()` 比对。**挑配方**（2026-09-29 问题 2）：`rankRecipesFor` 的排序档位、`pickSlotSample`、`altLine` 见下 |
| `movement.js` | 32 项：寻路（`go`/`pathTo`/`followRoute`）、爬梯、开门、跟随（`startFollow`）、`motor`/`nudge`、`/cmd` 白名单、睡觉、自救 |
| `mining.js` | 24 项：挖矿与下矿（`delve`）、矿脉/亮源注册表缓存、火把、填缝 |
| `farming.js` | 4 项：作物 / 种子 / 收成 / `farm` |
| `kit.js` | 9 项：装备清单（`defaultLoadout`/`isLoadoutItem`/`kitShortfall`）、脚手架判定。`scaffoldCache` 缓存。**镐斧铲剑都要有一把**（2026-09-29 问题 5 补上铲：`pickaxe$` 匹配不上 `iron_shovel`，`(^|_)axe$` 也匹配不上，于是挖黏土时工具在背包里也拿不出来）；铲/斧非 `essential`，不会刷 `kit_short`。**一桶水（落地水）也是非 `essential`**（2026-09-29 问题 3：主人"其实不一定需要"）—— 有就随身带（`isLoadoutItem` 不看 `essential`，整理仓库照旧不收走），没有不报缺、不催。`kit_short` 的发起方 `src/instinct/core.js:1679` 用 `.filter(x => x.essential)` 筛，所以只改这一个标记就够 |
| `tool-choice.js` | **挖方块前挑工具**（2026-09-29）。`toolKindFor`（该用铲/斧/镐：material → harvestTools → 名字兜底，**判据只此一处**）、`pickDigTool` / `fastestOfKind`（身上挑 digTime 最快的）、`equipDigTool` / `ensureDigTool`（换到手上，身上没有就去精妙背包拿；拿不到就照旧挖）。**不 require 兄弟文件**，名字直接进 `index.js` 的 `__ns` |
| `build.js` | 23 项：工程 / 家具布局（`project*`/`layout*`）、`placeAt`、`survey` |
| `commonsense.js` | 常识动作：装水 / 倒水 / 锄地 / 钓鱼 / 动物 / 载具（`routes({ state })`） |
| `equip-policy.js` | `pickAutoEquip`（"该换成什么到手上来"）。原在 `decision.js`，旧脑干删除时**原样**搬出。被 `../bridge/server.js`（`POST /equip` auto 分支）和 `../instinct/instinct.js`（`deps.pickAutoEquip`）**两边**引用 —— 改它要两边都测 |
| `storage-policy.js` | 家中仓库的**安全边界**：`assign` / `only` / `skip` / `protected` 的统一规则。纯函数，家里（mind 进程）和搬东西（bridge 进程）共用一份 |
| `inventory-ledger.js` | 物品账：背包每次进出记下"变了什么、为什么"（捡的 / 放进哪个箱子 / 吃掉 / 用坏…），mind 读它 |
| `ftbq-sync.js` | FTB 任务书进度：哪些任务做完了（长期计划看主线做到哪了）。格式按反编译核对过 |

## 自测

拆开后**每个文件能自己跑**，断言总数不变（242 = 21+39+65+31+54+32+21+…，2026-09-29 因问题 1/2/3/5 各自加了断言；问题 3 给 craft.js 加了 13 条）：

```bash
$NODE src/body/hands.js --selftest                       # 汇总：把 8 个子文件的自测依次跑一遍（242 条）
$NODE src/body/containers.js --selftest                  # 39 条（含"整理时把精妙背包倒进箱子"）
$NODE src/body/craft.js --selftest                       # 65 条（含"缺料看背包""缺工作台自己放"、[0f] wear 已穿→alreadyWorn）
$NODE src/body/movement.js --selftest                    # 31 条（假 bot 驱动真实的 startFollow / go）
$NODE src/body/kit.js --selftest                         # 54 条（含铲）
$NODE src/body/tool-choice.js --selftest                 # 32 条（挖之前挑工具，真 1.20.1 方块）
$NODE src/body/build.js --selftest                       # 21 条
$NODE src/body/commonsense.js --selftest                 # 21 条
$NODE src/body/equip-policy.js --selftest                # 21 条（该换什么到手上来：空手 / 拿错东西）
$NODE src/body/storage-policy.js --selftest              # 5 条
$NODE src/body/inventory-ledger.js --selftest            # 22 条
$NODE src/body/ftbq-sync.js --selftest                   # 10 条
$NODE --check src/bridge/server.js                       # hands 的路由挂在 bridge 上，跨区改动要一起看
$NODE scripts/test-all.js                                # 全绿：含 [exports] hands 47 个导出名/顺序快照
```

`testkit.js` 是自测用的共享脚手架（`register` / `runSuite` / `bindHands` / `handsSrc`），**没有 `--selftest` 分支**，`test-all` 对它只做 `--check`。

## 循环依赖（改之前先读这段）

8 个子文件**互相调用**（`containers ↔ craft`、`kit ↔ containers` …，跨文件调用共 585 处），
`require` 是环。所以**不能用** `const { x } = require('./sibling')` —— 反向那条边会拿到 `undefined`。

约定：

- 每个子文件顶部 `const __ns = {};`，跨文件的**常量**声明成 `let X;`，跨文件的**函数**写成转发壳
  `function X (...a) { return __ns.X.apply(null, a); }`；
- `function bind (ns) { Object.assign(__ns, ns); X = ns.X; ... }`，由 `index.js` 在 8 个文件都加载完之后统一调；
- 子文件之间**不要** `require` 兄弟文件（只有 `index.js` 汇总）。

## 共享状态只有一份

`HSTATE`（bridge 的 `state`）只存在 `index.js`：`install` 先写它再转调 `containers` 的 `installInner`，
`containers` / `craft` 各接一个 `setHandsState(handsState)` 的 getter 读同一份 —— **不要另存副本**。
`knowledge`/`K()` 只在 `util.js`；`scaffoldCache` 在 `kit.js`；`oreIdsCache`/`lightIdsCache` 在 `mining.js`。

## 合成挑配方（`craft.js` 的 `rankRecipesFor`，2026-09-29 问题 2）

实机 `craft(count=4 itemName=minecraft:stick)` 报了"还缺竹子 2"，其实木板就能做。旧排序
`[recipeRank, 缺的种类, 缺的个数, 缺的还得再合成]` 对"竹子"和"任意木板"**四列全平手**，
稳定排序保留了原始顺序 → 竹子胜出。现在的排序键（从强到弱，`score()` 里逐条可读、可单测）：

1. `recipeRank` —— 背包内 < 工作台/熔炉 < 原版类型 < 模组（挡"箱子 ← 橡木箱子"转换配方）；
2. **缺的种类数**（0 = 一样不缺；手上 / 背包（`backpackSeen`）/ 家里箱子（`seenContainers`）
   有的都算"不缺" —— 后两者由 `craft2` 合成一张 `{id: count}` 只读表当 `seen` 传进来，
   **只判 ok、不当身上数量展示**）；
3. **缺的总个数**；
4. **缺的基础度**（`slotEase`）：一格取最好弄的候选，**基础度占整数位、好不好弄占小数位** ——
   先比基础度（`#minecraft:planks`=0 最基础 > 原木/竹子等原版=1 > 木头/去皮=2 > 模组=3），
   同基础度再比好不好弄（手上间接能凑 0.1 > 能直接挖 0.25 > 还得再合成一步 0.35 > 都不是 1）。
   这条就是主人要的"原版基础材料 > 模组材料；能用手上东西再合成出来的 > 要出去找的"。
   ⚠️ 和 `knowledge.js` 的 `materialTree` 是**两处独立实现**，但基础度都只认 `#minecraft:planks`
   这一个数据标签，别只改一处。
5. `r.in.length` 原料格数。

报错只讲**选中的那一条**；另有更好懂的候选时补一句 `altLine`（"另外用 X 也能做"，**最多一条**）。
说给人听的名字走 `pickSlotSample`（独立纯函数），优先级：身上有的 > 能直接挖到的（圆石不说石头）
> 标签名里带这个基底名的 > 最"素"最短的原版 > 第一个。

## 挖方块前挑工具（2026-09-29）

`tool-choice.js` 是**唯一一份**"该用哪种工具"的判据（`material` → `harvestTools` → 名字兜底），
挖方块的四个调用点都从这里取：

- `bridge/routes/mine.js`（`POST /mine`）—— 直接用 `toolChoice.ensureDigTool`（走 `hands.ensureCarried` 去背包拿）；
- `mining.js` 的 `digBlock`、`build.js` 的施工挖格 —— 用 `__ns.equipDigTool` 转发壳；
- `farming.js` 的收庄稼 —— **没接**：那里挖的都是 age 作物（硬度≈0，工具不影响），
  而且换工具会和后面补种的 `bot.equip(seed)` 打架。

`ensureCarried` 身上够时不开界面（`source:'carried'`），所以"每块都调"不会拖慢 ——
只有身上真没有时才去开一次精妙背包。**任何一步失败都只是 `took:false`，不阻断挖掘**。

## 第 3 步已完成（2026-09-28）

原先 5598 行、75 条路由的 `hands.js` 已按上面表格拆开。**函数体一字未改**（唯一例外：
`containers.install` 第一行 `HSTATE = state` 改读 getter；`util.approach` 里两处 `HSTATE` 改成 `getHandsState()`（读同一份，行为不变；2026-09-28 用修好的 check-moved 复核时补登）。前者已在 `modpack-study/refactor-p3a/report.md` 登记）。
新增导出/改导出名会让 `scripts/test-all.js` 的 `[exports]` 快照拉红 —— 接口是契约，改它要有意为之。

