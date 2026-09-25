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
| `zz_angel_dump_block_palette.js` | 放进客户端 `kubejs/startup_scripts/` 的 dump 脚本（v3） | ✅ |
| `_attic/` | 已证明有害的旧版脚本 | ✅ |

## 方块 vs 物品：规则**刻意不同**，别"顺手统一"

| | 方块（`palette-registry.js`） | 物品（`item-registry.js`） |
|---|---|---|
| id 来源 | 前缀和推算 | 快照直接给定 |
| 连续性 | **严格连续**（错一格全表平移） | 允许断点（只报告） |
| 校验 | 三道闸：连续 / 原版段交叉 / F3 锚点 | 原版前缀逐条核对 |
| 注入失败 | 拒绝导入 | **不踢线**（叫不出名 ≪ 掉线） |
| 故意不填 | `boundingBox`（`pathing.needsShapeFallback` 靠它判"无权威碰撞箱"—— 契约） | `maxDurability` |

## KubeJS 脚本四铁律

客户端 `startupErrorGUI=true`，任何 startup 脚本错误 = 阻断式弹窗、客户端进不去。

1. 只用 `let`，**绝不写 `const`**（Rhino `doSetConstVar` 运行期抛 `msg.var.redecl`）
2. 整个函数体包进 `try`
3. 只用 `console.info`
4. 不调 `Java.loadClass`

## 诊断

```bash
curl --noproxy '*' http://127.0.0.1:3001/debug/registries
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=glass_trapdoor'
curl --noproxy '*' http://127.0.0.1:3001/palette      # 注入状态（离线可读）
curl --noproxy '*' http://127.0.0.1:3001/item         # 物品注入报告 + liveRegistryProbe
```
