# registry/ —— 服务端注册表真值（方块调色板 / 物品表）

完整原理与导出流程见同目录 [`README.md`](README.md)。这里只放**动手前必须知道的**。

## 为什么这个目录决定生死

1.13+ 服务端只发数字 id，名字靠客户端注册表翻译。模组服上 `prismarine-block/index.js:125` 与
`prismarine-item/index.js:36` 查不到就把 `type` 留成 `undefined` / 名字写成 `'unknown'` →
叫不出方块名、梯子爬不上（两层判据都是 `block.type === ladderId`）、`/drop` `/equip` `/craft` 全失效。
**所以调色板和物品表必须写回 `bot.registry`，光当旁路查表等于没导。**

## 文件

| 文件 | 性质 | 入库 |
|---|---|---|
| `minecraft-block.json` / `minecraft-item.json` | 每次 FML 登录握手自动覆盖写（含服务器地址） | ❌ |
| `minecraft-menu.json` | 界面类型表，`hands.js` 开模组界面时把数字 id 翻成名字 | ✅ |
| `angel_block_palette.txt` | **完整**方块调色板 dump（客户端 KubeJS → `scripts/angelpal-to-palette.js`） | ✅ |
| `vanilla-palette-1.20.1.txt` / `_vanilla-blocks-1.20.1.json` | 原版基线（`scripts/make-vanilla-palette.js`） | ✅ |
| `block-palette.json` | **历史死路**：从 jar 反推，模组段偏 27 万位；留作 `palette-guard-test.js` 的坏样本 —— **别删、别拿来用** | ✅ |
| `zz_angel_dump_block_palette.js` | 放进客户端 `kubejs/client_scripts/src/` 的 dump 脚本（**v4**，含逐 state 碰撞形状） | ✅ |
| `_attic/` | 已证明有害的旧版脚本 | ✅ |

## 方块 vs 物品：规则**刻意不同**，别"顺手统一"

| | 方块（`palette-registry.js`） | 物品（`item-registry.js`） |
|---|---|---|
| id 来源 | 前缀和推算 | 快照直接给定 |
| 连续性 | **严格连续**（错一格全表平移） | 允许断点（只报告） |
| 校验 | 三道闸：连续 / 原版段交叉 / F3 锚点 | 原版前缀逐条核对 |
| 注入失败 | 拒绝导入 | **不踢线**（叫不出名 ≪ 掉线） |
| 碰撞形状 | **填**（v4 dump 的第 6 列）→ `pathing.needsShapeFallback` 不再命中 | — |
| 故意不填 | `hardness` / `diggable`（填了就是改变"能不能挖"） | `maxDurability` |

⚠️ **碰撞形状这条契约在 v4 反转了**。老契约是"注入的记录故意不填 `boundingBox`，让
`pathing.needsShapeFallback` 命中、走按名字猜"；现在 dump 直接导出**逐 state 碰撞箱**，
注入时填 `shapes` / `stateShapes` / `boundingBox`，模组方块不再靠猜。
兜底的判据本身**没变**（仍然只看 `boundingBox === undefined`），只是现在只有"旧 5 列 dump"
和"形状列读不到"两种情况才会命中。详见 `README.md` 的「形状这一列」。

## KubeJS 脚本四铁律

客户端 `startupErrorGUI=true`，任何 **startup** 脚本错误 = 阻断式弹窗、客户端进不去。
（v4 dump 脚本已搬到 **client_scripts**：那里的错误不阻断进游戏，但同样会让脚本整段不跑，
一样要遵守这四条。`var` 在 client_scripts 里是**故意**的 —— 客户端脚本会被 F3+T 重载，
`var` 重声明合法、顶层 `let` 重声明会抛。）

1. 只用 `let` / `var`，**绝不写 `const`**（Rhino `doSetConstVar` 运行期抛 `msg.var.redecl`）
2. 整个函数体包进 `try`
3. 只用 `console.info`
4. 不调 `Java.loadClass`

⚠️ 形状导出必须用 `Client.level`，而 **`Client` 绑定只在客户端脚本里注册**
（反汇编 `BuiltinKubeJSClientPlugin.registerBindings` 实测）—— 所以 v4 脚本
**不能**放回 `startup_scripts/`，放回去只会报"`Client` is not defined"。

## 诊断

```bash
curl --noproxy '*' http://127.0.0.1:3001/debug/registries
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=glass_trapdoor'
curl --noproxy '*' http://127.0.0.1:3001/palette      # 注入状态（离线可读）
curl --noproxy '*' http://127.0.0.1:3001/item         # 物品注入报告 + liveRegistryProbe
curl --noproxy '*' http://127.0.0.1:3001/config       # palette.injectedIntoRegistry.shapes
```

`/config` 的 `shapes` 字段就是"形状这一列到底起没起作用"的正面证据：

| 字段 | 含义 |
|---|---|
| `blocks` / `states` | 填上了真实碰撞箱的方块数 / state 数。**`blocks: 0` 就是没起作用** |
| `absent` | 旧 5 列 dump：根本没导这一列 → 照旧按名字猜 |
| `unusable` | 导了但解不回来（条数对不上 / 有 state 读不到）→ 也按名字猜 |
| `dynamic` | 形状静态决定不了的，**原版、有权威依据**（反汇编出的 6 类 = 22 个方块） |
| `dynamicGuessed` | 模组方块里名字后缀撞上那几个词的 —— **按名字猜的，无依据** |

⚠️ 后两个**必须分开看**：实测整合包里"猜的"（21 个，都是 bamboo 材质的家具和
储存模组的潜影盒）比"真的"（22 个）差不多，混成一个数就没法解释了。
