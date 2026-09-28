# `src/body/` —— 手 / 常识 / 装备 / 仓库 / 物品账

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里"手"那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `hands.js` | **汇总**（第 3 步重构，2026-09-28）。只剩一行转发到 `index.js`（**不用符号链接**：Windows 的 git 默认签出成纯文本，require 会炸）—— `require('../body/hands')` 和 `--selftest` 都照旧，导出名与顺序一字不差。真正的内容在下面 8 个文件 + `index.js`。挂到 bridge 上的"手"：`/eat` `/use` `/wear` `/craft2`（整合包真实配方）`/smelt` `/container/*`。每个动作比对前后背包/装备/饥饿值，不信"调用成功" |
| `index.js` | `hands.js` 的目标：8 个子文件的 `require` + `__ns` 汇总 + `bind()` 回填 + `routes()`（75 条路由）+ 47 个导出。**改路由挂载只动这里** |
| `util.js` | 分出来 45 项：`Vec3`/注册表小工具、背包计数、可达性（`canUseFrom`/`canUseNow`）、门/梯子判定、NBT/Sophisticated 读写、`inHomeArea`。**共享状态 `knowledge`/`K()` 在这里** |
| `containers.js` | 44 项：箱子 / 背包 / 饰品栏（curios）/ FTBQ / 结构放置，及排序与身份比对（`stackIdentity`/`sameTotals`）。**`HSTATE` 的 getter 在这里**，`backpackChain` 串行队列 |
| `craft.js` | 26 项：合成（手搓 / 配方书）、熔炉、吃 / 用 / 穿 / 给、厨锅。**`HSTATE` 的 getter 在这里** |
| `movement.js` | 32 项：寻路（`go`/`pathTo`/`followRoute`）、爬梯、开门、跟随（`startFollow`）、`motor`/`nudge`、`/cmd` 白名单、睡觉、自救 |
| `mining.js` | 24 项：挖矿与下矿（`delve`）、矿脉/亮源注册表缓存、火把、填缝 |
| `farming.js` | 4 项：作物 / 种子 / 收成 / `farm` |
| `kit.js` | 9 项：装备清单（`defaultLoadout`/`isLoadoutItem`/`kitShortfall`）、脚手架判定。`scaffoldCache` 缓存 |
| `build.js` | 23 项：工程 / 家具布局（`project*`/`layout*`）、`placeAt`、`survey` |
| `commonsense.js` | 常识动作：装水 / 倒水 / 锄地 / 钓鱼 / 动物 / 载具（`routes({ state })`） |
| `equip-policy.js` | `pickAutoEquip`（"该换成什么到手上来"）。原在 `decision.js`，旧脑干删除时**原样**搬出。被 `../bridge/server.js`（`POST /equip` auto 分支）和 `../instinct/instinct.js`（`deps.pickAutoEquip`）**两边**引用 —— 改它要两边都测 |
| `storage-policy.js` | 家中仓库的**安全边界**：`assign` / `only` / `skip` / `protected` 的统一规则。纯函数，家里（mind 进程）和搬东西（bridge 进程）共用一份 |
| `inventory-ledger.js` | 物品账：背包每次进出记下"变了什么、为什么"（捡的 / 放进哪个箱子 / 吃掉 / 用坏…），mind 读它 |
| `ftbq-sync.js` | FTB 任务书进度：哪些任务做完了（长期计划看主线做到哪了）。格式按反编译核对过 |

## 自测

拆开后**每个文件能自己跑**，断言总数不变（153 = 21+30+31+50+21）：

```bash
$NODE src/body/hands.js --selftest                       # 汇总：把 8 个子文件的自测依次跑一遍（153 条）
$NODE src/body/containers.js --selftest                  # 21 条
$NODE src/body/craft.js --selftest                       # 30 条
$NODE src/body/movement.js --selftest                    # 31 条（假 bot 驱动真实的 startFollow / go）
$NODE src/body/kit.js --selftest                         # 50 条
$NODE src/body/build.js --selftest                       # 21 条
$NODE src/body/commonsense.js --selftest
$NODE src/body/equip-policy.js --selftest                # 该换什么到手上来（空手 / 拿错东西）
$NODE src/body/storage-policy.js --selftest
$NODE src/body/inventory-ledger.js --selftest
$NODE src/body/ftbq-sync.js --selftest
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

## 第 3 步已完成（2026-09-28）

原先 5598 行、75 条路由的 `hands.js` 已按上面表格拆开。**函数体一字未改**（唯一例外：
`containers.install` 第一行 `HSTATE = state` 改读 getter；`util.approach` 里两处 `HSTATE` 改成 `getHandsState()`（读同一份，行为不变；2026-09-28 用修好的 check-moved 复核时补登）。前者已在 `modpack-study/refactor-p3a/report.md` 登记）。
新增导出/改导出名会让 `scripts/test-all.js` 的 `[exports]` 快照拉红 —— 接口是契约，改它要有意为之。

