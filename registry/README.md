# registry/ —— 服务端注册表：方块调色板与物品表

这个目录放的是**服务端真值**，不是我们从模组 jar 猜出来的东西。

## 一句话背景

1.13 之后，服务端在 `chunk_data` 里**只发全局调色板的数字 ID**，方块名靠**客户端本地
注册表**翻译。原版客户端装了模组所以认识 `upgrade_aquatic:glass_trapdoor`；机器人只有
原版 `minecraft-data`，于是任何模组方块都查成空名字 —— 而 `prismarine-block` 对查不到的
state 会给 `shapes=[] / boundingBox='empty'`，客户端以为能穿过去，服务端照自己的碰撞把人
推回来。表现是**原地抖动、位移≈0**。

## 文件

| 文件 | 是什么 | 怎么来的 |
|---|---|---|
| `minecraft-block.json` | 服务端**全部 20217 个方块**的 `名字 → 注册表id`。⚠️ **本地生成、不入库** —— 每次登录都会覆盖写，且会把服务器地址写进 `host` | Forge FML 握手 `S2CRegistry` 快照，自动落盘 |
| `minecraft-item.json` | 服务端**全部 30729 个物品**的 `名字 → 注册表id`；启动时由 `item-registry.js` 注入 `bot.registry`（见下文「物品」一节）。⚠️ **本地生成、不入库** | 同上 |
| `angel_block_palette.txt` | `blockId\|firstStateId\|count\|名字\|属性规格\|形状列` 的**完整** dump（含整合包实际原版扩展和模组段）。v4 起带第 6 列**逐 state 碰撞箱** | **需要手动导一次**：客户端进一次世界 → `node scripts/angelpal-to-palette.js`（见下） |
| `vanilla-palette-1.20.1.txt` | 只覆盖 `minecraft-data` 的原版基线 `0..24134`，不是当前整合包的最终布局 | `node scripts/make-vanilla-palette.js` |
| `_vanilla-blocks-1.20.1.json` | 1003 个原版方块的 `id/minStateId/maxStateId` | 从 `minecraft-data` 导出，供脚本参考 |
| `block-palette.json` | （历史）从模组 jar 反推的调色板，**已证明不可靠**：连续 + 原版正确，但模组段偏 27~28 万位 | 见文末"死路"；导入会被 F3 锚点拒绝 |

前两个是桥接进程自动抓的 —— 只要 `MC_FORGE=1` 且连上了服务端，每次登录握手都会覆盖写。
查它们用：

```bash
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registries'
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=glass_trapdoor'
```

## 为什么 `stateId` 还得单独导一次

方块**注册表 id** 不等于 **state id**。两者的关系是：

```
stateId = 本地整合包中前面所有方块的 state 数之和
        + 方块内部局部序号

本包的 minecraft-data 基线是 24135 个原版 state；整合包又扩展了 31 个原版方块，
实际原版尾界为 25019，之后才进入模组区间。
```

已实测确认（2026-09-23）：

* 服务端 1003 个原版方块的注册表 id 与原版**逐个一致（1003/1003，零差异）**；
  但整合包把 31 个原版方块的属性范围扩展了，原版尾界从 `24135` 变成 **`25019`**。
* `stateId` 按 Forge 服务端 block registry id 的顺序**连续**分配；不能用 KubeJS
  `entrySet()` 的遍历序号代替服务端 id（本包实测两套顺序会出现 +3 等偏移）。
* 方块内部按「属性名排序 → 取值按声明顺序 → 嵌套展开（最后一个属性变化最快）」；
  `upgrade_aquatic:glass_trapdoor` 的 F3 state `522768` 落在其真实区间 `522765..522828`。

因此必须把 KubeJS 行里的**名字**映射回本地 Forge `minecraft-block.json` 的服务端 id，
按服务端 id 排序后做前缀和，再用原版基线 + 累计扩容 + F3 锚点三层校验。

## 怎么导出（一次就够）

把 `zz_angel_dump_block_palette.js`（就在本目录里，**v4**）复制到整合包的
`kubejs/client_scripts/src/`，然后启动客户端并**进一次世界**。

> ⚠️ **v4 必须是 client script，不能再放 `startup_scripts/`。**
> 逐 state 的碰撞形状只能问 `BlockState.getCollisionShape(BlockGetter, BlockPos)`，
> 那需要一个 `BlockGetter`；唯一能拿到的绑定是 `Client`（= `Minecraft.getInstance()`），
> 而 `Client` 这个绑定**只在客户端脚本里注册**（反汇编
> `BuiltinKubeJSClientPlugin.registerBindings` 实测）。放回 startup_scripts 只会得到
> 一个 `ReferenceError`。
>
> 为什么是"进一次世界"而不是"加载即跑"：客户端脚本在**主菜单**就加载了，那时
> `Client.level` 还是 `null`。v4 装上定时器后每 50ms 看一次，进了世界才开始导。

输出**只走日志**：每行前缀 `ANGELPAL|`，格式

```
<注册序号>|<state个数>|<注册表数字id>|<方块名>|<属性规格>|<形状列>
```

外加四种非数据行：`ANGELPAL-HEADER|rows=…|probeOk=…|probe=…`（**排在所有数据行前面**）、
`ANGELPAL-PROGRESS|…`、`ANGELPAL-DONE|rows=…|shapeFail=…|blockFail=…`、
失败时 `ANGELPAL-ERROR|…`。**先 grep 这几行**就知道成没成。

> **故意不输出 base state id。** 客户端那边取 state id 只有
> `Block.BLOCK_STATE_REGISTRY`（private）或 `Block.getId`（会被 KubeJS 的
> `BlockWrapper` 抢成"返回 ResourceLocation"），两条都有风险。
> base 必须在本地由 Forge S2C 快照的服务端 block id 排序后算：`first[i] = Σ count[0..i-1]`。
> **不能**按 ANGELPAL 的 entrySet 序号排序；转换脚本会读取 `registry/minecraft-block.json`
> 做名字→服务端 id 映射，缺任何名字就拒绝猜测。

```bash
node scripts/angelpal-to-palette.js --selftest      # 48 条断言
node scripts/angelpal-to-palette.js                 # 读日志 + minecraft-block.json → angel_block_palette.txt
```

它会做这些检查，任一不过就拒绝出表：

| 检查 | 抓什么 |
|---|---|
| HEADER 的 `rows=` 与实际抽到的行数一致 | 日志被轮转截断（前缀和会整体偏移） |
| HEADER 的 `probeOk=true` | 形状探针没过 ⇒ 整列形状不可信 |
| 日志序号连续 `0..n-1` | dump 行缺失 |
| 名字映射到 Forge S2C id 且 id 完整连续 | 防止把 KubeJS entrySet 序号误当服务端 registry id |
| 原版 1003 个方块按 id 对齐 | 名字错、first 未按累计扩容漂移、count 小于基线 |
| 形状列能解回 `count` 项（`block-palette.decodeShapes`） | 形状列被截断 / 两端编码不一致 |
| F3 锚点预演 | 模组段累计偏移错了 |

> `shapeFail` / `blockFail` 大于 0 **不拒绝**，只打警告：那些方块退回按名字猜
> （= 改造前的行为，没有回归），其余方块不受影响。结构性失败由探针负责拦。
> 把脚本放到 `<整合包目录>/kubejs/client_scripts/src/`，删掉那个文件即可撤销。

### 形状这一列（v4 新增）

**为什么必须多导这一列。** 名字和属性只能告诉 `pathing.js`「这是什么方块」，
**告诉不了它「这一格挡不挡人」**。没有形状时只能按名字猜：

```
薄方块白名单（`THIN_BLOCK_SUFFIXES`）→ 可穿过
`_bed` 结尾 → 9/16 格高
其余 → 整块实心
```

整合包里大量非整格方块（家具、模组台阶/楼梯/栅栏/地毯、路径块…）全被猜错 ——
**这才是"卡在门口出不去"那类问题的根**，`pathing.lowBlockHeight` 只是补丁。

**形状不可能从模组 jar 反推**（同 state 数那件事：blockstates 的 variants 允许省属性
当通配符，`glass_trapdoor` 真值 64 态只数得出 16 态）。唯一精确来源还是那个跑着的客户端。

**采样位置在世界高度之外**（`y = 1000`）。形状函数拿到的 `BlockGetter` 只有"问邻格是什么"
这一个用途；我们要的是**孤立形状**。`Level.getBlockState` 对界外坐标走
`isOutsideBuildHeight` 分支**直接返回 `VOID_AIR`**（反汇编 `Level.m_8055_` 证实），于是
邻格 ±1 也都在界外 → 全返回空气 → 等价 `CollisionContext.empty()`；而且**完全不碰区块**
（那个分支在取 chunk 之前就 return），结果与玩家站在哪、地形长什么样无关，可复现。

**编码**（与 `block-palette.js` 的 `encodeShapes` **逐字节一致**，两边各钉一份自测，
改一边必须改另一边）：

| 串 | 含义 |
|---|---|
| `<def0>;<def1>;…~<索引>` | **表形态**：def 表 + 逐 state 索引（索引字符 `0-9a-zA-Z`，62 个） |
| 单个 def（如 `.`） | 压缩形态：**所有 state 同形**（绝大多数方块） |
| `.` | 整格 `[[0,0,0,1,1,1]]` |
| `-` | **没有碰撞**（空气、草、火把…）—— 与"读不到"是两回事 |
| `?` | 这个 state **读不到**（索引里的 `?` 也是这个意思） |
| `x1:x2:…:z2` | 6 个数字，单位是**格**（1.20.1 高度用 24 = 1.5 格） |
| `a+b` | 多个箱子（栅栏/楼梯那种）用 `+` 连 |
| `!…` | 兜底：形状种类比索引字母表还多（原版只有 `chorus_plant`），逐 state 直接列 |

分隔符选 `,`/`;`/`+`/`:`/`~`/`!` 而**不含 `|`**：整行本来就是 `|` 分列，用 `|` 会撑坏列数。
数字按二进制小数存（1/16、13/32 都是精确二进制小数，`String()` 能原样写回）。

**体积**：实测原版 24135 个 state 编码后 **167 KB**（平均 7.08 字符/state）。
全表 826504 个 state 约 5–6 MB 的日志。

**向后兼容**：旧 5 列 dump 照旧工作 —— `entry.shapes === null` → 一个形状字段都不填
→ `needsShapeFallback` 命中 → 走原来的按名字猜。

#### 形状"不能由单个 state 静态决定"的方块

逐 state 导出对**绝大多数**方块是完整的，包括看起来最像"要看邻居"的那几类：
栅栏 / 墙 / 铁栏 / 玻璃板的连接状态**本身就是 block state 属性**
（`north`/`south`/`east`/`west`/`up`）。实测 `oak_fence` 32 state → 16 种形状、
`cobblestone_wall` 324 state → 32 种（含一种空碰撞）。**这几类不存在"邻居读不到"的问题。**

真正静态决定不了的，原版用 `BlockBehaviour.Properties.dynamicShape()` 标出来。
反汇编客户端 srg jar 的 `Blocks.<clinit>`（`dynamicShape()` 的 SRG 名是 `m_60988_`），
1.20.1 **全表只有 6 个调用点**，共 22 个方块：

| 方块 | 为什么静态决定不了 |
|---|---|
| `shulker_box`（含 16 色，共 17 个） | 开合由**方块实体**驱动，开着时碰撞会缩 |
| `moving_piston` | 只在活塞推动的**那一瞬**存在，形状跟着方块实体走 |
| `bamboo` | 形状要看**下面那格**（是不是竹子） |
| `scaffolding` | `bottom` 属性由**下面那格**推导 |
| `powder_snow` | 碰撞取决于**踩上去的实体**（人会陷进去） |
| `pointed_dripstone` | 形状要看**上方/下方**的滴水石 |

处理办法：**照导不误，并标记出来**（原版记录带 `angelShapeDynamic: true`）。理由是静态
采样得到的是**保守的那一侧**：关着的潜影盒 / 未伸出的活塞 / 单根竹子 / 未连接的脚手架 /
没被踩入的细雪 / 孤立的滴水石，碰撞都不小于动态时的最小值。宁可多绕一步，也不要穿模。

> ⚠️ `potted_bamboo` 名字以 `_bamboo` 结尾，但它的形状来自 `FlowerPotBlock`（**静态**），
> **不在**那 6 个调用点里。判据里用 `(?!potted_)` 显式排除 —— 端到端演练实测被误标过一次。

> ⚠️ **模组方块拿不到权威依据**：模组不会把 `dynamicShape()` 导出来。名字后缀撞上的
> （`kaleidoscope_cookery:chair_bamboo`、`sophisticatedstorage:iron_shulker_box`…）只记进
> `angelShapeDynamicGuessed`。实测整合包里撞上 **21 个**，全是普通家具/箱子，形状其实是静态的。
> **这两个数必须分开报**（`/config` 的 `shapes.dynamic` / `shapes.dynamicGuessed`）——
> 混成一个就没法解释：猜的（21）跟真的（22）几乎一样多。

#### 兜底还留不留

`pathing.lowBlockHeight`（`_bed` → 9/16）**保留，但降级为兜底**：它只在
`needsShapeFallback` 命中时才可能生效，也就是"旧 5 列 dump"或"形状列读不到"的情况。
有了真实形状以后，模组床走的是 dump 里的真实形状，不再走名字规则。

判据的**顺序**（`applyUnknownBlockPolicy` 里，一处）：
`运行时白名单` → `已有权威形状（needsShapeFallback 不命中）→ 一个字都不改` →
`薄方块白名单` → `矮方块（床）` → `整块实心`。

### 🔴 KubeJS 脚本的四条铁律（前三版全踩了，客户端直接被弹窗挡住）

`common.properties` 里 `startupErrorGUI=true` ⇒ **任何 startup script 错误都会弹一个
阻断式窗口**。（v4 已搬到 `client_scripts/`，那里的错误不阻断进游戏，但同样会让脚本
整段不跑，一样要遵守。）每条都有字节码证据（`javap`）：

| 铁律 | 为什么 |
|---|---|
| **绝不写 `const`，用 `let`** | Rhino 的 `Interpreter.doSetConstVar` 在**运行期**抛 `msg.var.redecl`（`redeclaration of var X`）。本包里所有**能正常跑**的脚本（`effect.js` / `vefcblocks.js` / `vefcfoods.js`）**一个 `const` 都没有**，全用 `let`。出问题的那版就是写了 `const` |
| **整个函数体都放进 `try`** | 只要有一句在 `try` 外面（比如 `const OUT_NAME = …`），抛出来就是未捕获的错误 → 弹窗 |
| **只用 `console.info`，不用 `console.error`/`warn`** | KubeJS 把这两个级别记成脚本错误 → 同样弹窗。坏掉的诊断脚本最多只该留一行 INFO |
| **不调 `Java.loadClass`** | `JavaWrapper` 只有 `loadClass / tryLoadClass / createConsole`，**没有 `Java.from`**；而且 `const X = Java.loadClass('…X')` 正好踩第一条。改用 KubeJS 绑定：`Utils.getRegistry(Utils.id('minecraft','block'))` → `RegistryInfo.entrySet()` |

> ⚠️ **client script 里 v4 顶层的三个 `var` 是故意的，不是笔误。** 客户端脚本会被
> F3+T 重载，而 `var` 重声明合法、顶层 `let` 重声明会抛。函数声明同理。

**实际存在的绑定**（`BuiltinKubeJSPlugin.registerBindings` 全表）：
`global, Platform, console, JavaMath, ResourceLocation, Duration, settings, onEvent, java,
setTimeout, clearTimeout, setInterval, clearInterval, KMath, Utils, Java, Text, Component,
UUID, JsonIO, Block, Blocks, Item, Items, Ingredient, IngredientHelper, NBT, NBTIO,
Direction, Facing, AABB, Stats, FluidAmounts, Notification, InputItem, OutputItem, Fluid,
SECOND, MINUTE, HOUR, Color, BlockStatePredicate, Vec3d, Vec3i, Vec3f, Vec4f, Matrix3f,
Matrix4f, Quaternionf, RotationAxis, BlockPos, DamageSource, SoundType, BlockProperties`
+ 所有事件组。

**客户端脚本**额外注册（`BuiltinKubeJSClientPlugin.registerBindings`）：
`Client`（= `Minecraft.getInstance()`）、`Painter`、`setTimeout`、`clearTimeout`、
`setInterval`、`clearInterval`。**`Client` 只在这里有** —— 这就是 v4 必须放
`client_scripts/` 的原因。`setInterval` 由 `MinecraftClientMixin` 在客户端线程上 tick。

> ⚠️ **`BuiltInRegistries` 不在任何绑定表里。** 有一版以为它是预绑定的全局名而直接引用
> —— 那是 `ReferenceError`，结果是"脚本没报错但一行数据都没出"。

**可读方法名是安全的**：KubeJS 的 Rhino 通过 `mm.jsmappings`（gzip，781 KB，
在 `rhino-forge-*.jar` 里）做成员重映射。已核对存在：`getStateDefinition`(`m_49958_`)、
`getPossibleStates`(`m_61092_`)、`getProperties`、`getPossibleValues`(`m_6908_`)、
`getName`(`m_6940_`)、`entrySet`(`m_6579_`)、`location`(`m_135782_`)，
以及 v4 新用到的 `getCollisionShape`、`toAabbs`、`iterator`、`hasNext`、`next`、
`getVanillaRegistry`、`getId`、`minX`…`maxZ`。

**`Utils` 绑定的是 `UtilsWrapper`，它没有 `getPath`**（`getPath` 在未绑定的 `UtilsJS` 上）。

**`getCollisionShape` 选的是两参重载** `(BlockGetter, BlockPos)` —— 它的字节码就是
`CollisionContext.empty()` 再转发到三参版，正好是我们要的"孤立形状"，而且绕开了
拿不到的 `CollisionContext`。

### 探针：让"形状列整列不可信"在第一秒暴露

`HEADER` 里的 `probe=` 会用三个已知答案的方块试一遍整条链
（`getCollisionShape` → `toAabbs` → AABB 字段名 → 编码）：

| 方块 | 期望 |
|---|---|
| `stone` | `.`（整格） |
| `air` | `-`（无碰撞） |
| `ladder` | `0:0:0:0.8125:1:1`（3/16 厚） |

这一串里任何一个可读名没被 `jsmappings` 接上，都会在**每个 state 上**抛异常 ——
结果是"导出了一份形状全是 `?` 的 dump"，看起来跑完了、其实白跑，还得多重启一次客户端。
探针让这件事在第一秒就暴露：`probeOk=false` → 脚本自己停下并报 `ANGELPAL-ERROR`。

导入：

```bash
curl --noproxy '*' -X POST -H "Content-Type: application/json" \
  -d '{"file":"<技能目录绝对路径>/registry/angel_block_palette.txt"}' \
  http://127.0.0.1:3001/registry/import-palette
```

或者在 `config.json` 里配好 `MC_PACK_DIR`，桥接启动时会自动找、自动导入。

导完就能用了：

```bash
curl --noproxy '*' 'http://127.0.0.1:3001/palette'
curl --noproxy '*' 'http://127.0.0.1:3001/palette/state?id=522768'
curl --noproxy '*' 'http://127.0.0.1:3001/palette/block?name=minecraft:ladder'
curl --noproxy '*' 'http://127.0.0.1:3001/block?x=34&y=78&z=-137'
```

### 安全阀：三道判据，任一不过就整份拒绝

`POST /registry/import-palette` 会依次跑三道，**只要有一道不过就整份拒绝** ——
因为错位之后给出的是"看起来很像但完全错"的方块名，比"认不出"危险得多。

| # | 判据 | 拦什么 |
|---|---|---|
| 1 | **严格连续**（`gaps === 0`） | 被截断/被改过的 dump |
| 2 | **服务端 id 映射 + 原版累计 drift** | entrySet 序号误用、名字错、first 错位、state count 缩小 |
| 3 | **F3 锚点**（`MC_PALETTE_ANCHORS`） | 模组区间的累计偏移错了 |
| 4 | **完整 overlay 注入** | 防止校验通过但运行时仍使用旧的 24135-state 原版表 |

⚠️ **只靠 1+2 是不够的，本仓就有一份反例**：`block-palette.json` 连续、全覆盖、
原版那一半还是抄 `minecraft-data` 的 —— 所以它**能过前两道**。但模组段的 state 数
是错的，跑到第 14000 个方块就偏了 **27 万位**。第 3 道才拦得住它：

```bash
node scripts/palette-guard-test.js   # 12 条断言：演示前两道放行、第三道拒绝并报出偏移
```

判据 2 有个不显然的细节：**客户端 dump 写 `minecraft:air`，而 `minecraft-data` 里是裸名 `air`**。
不归一化 `minecraft:` 前缀，一份**完全正确**的 dump 会被 1003 条全部"对不上"而误拒。
（这个 bug 就是被上面那个守门测试抓出来的。）

判据 3 的锚点来自玩家 F3，是唯一能钉住**模组段**的证据，且互相独立 ——
一个锚点只能证明它前面那一段的和对了。加锚点：`MC_PALETTE_ANCHORS=14286=506805,15061=522768`。

### 导入之后必须**写回注册表**，否则等于白导

见 `palette-registry.js` 顶部：`prismarine-block` 查不到 state 时 `b.type` 恒为
`undefined`、`b.name` 恒为空串 —— 而梯子的两层判据都是 `block.type === ladderId`。
所以**调色板是梯子问题的前置条件**，光配 `MC_CLIMBABLE_BLOCK_NAME` 不会生效。
`POST /registry/import-palette` 现在必须注入成功才算导入成功；
`GET /palette` 的 `injectedIntoRegistry` 才是该看的指标（不是 `loaded`）。

注入成功之后，**模组方块的碰撞形状也是真的了** —— `palette-registry.js` 会把 dump 第 6 列
填进记录的 `shapes` / `stateShapes` / `boundingBox`，于是 `pathing.needsShapeFallback`
不再命中，`applyUnknownBlockPolicy` 一个字都不改地放行。想确认这件事真的发生了，看
`GET /config` → `palette.injectedIntoRegistry.shapes`（字段含义见 `AGENTS.md`）。

> ⚠️ **这是一次契约反转。** 老契约是"注入的记录**故意不填** `boundingBox`，让兜底策略
> 按名字猜"。现在填了，因为 dump 里有**真实**形状。兜底的判据本身没变
> （仍然只看 `boundingBox === undefined`），只是现在只有"旧 5 列 dump"和"形状列读不到"
> 两种情况才会命中。`palette-registry.js` 与 `pathing.js` 两边都有断言钉住新契约。

## 物品：同一个根因，但规则**刻意不同**（别"统一"它）

`prismarine-item/index.js:36` 与方块那处一模一样：

```js
const itemEnum = registry.items[type]
if (itemEnum) { this.name = itemEnum.name; /* … */ }
else          { this.name = 'unknown'; this.displayName = 'unknown'; this.stackSize = 1 }
```

模组物品查不到 → **`i.name === 'unknown'`**。`GET /inventory` 报得出槽位和数量，
但名字就是字面量 `unknown` —— 她和调用方都分不清手里是柠檬还是剑。

**伤害远不止"叫不出名字"**：所有按名字找物品的原语都走 `registry.itemsByName`，
名字解析不出来就一起失效 —— `/drop`、`/collect`、`/equip`、`/craft`、`/place`。

暴露它的具体场景：摘 `hanging_lemon` 后背包槽是 `type: 1284`、`name: "unknown"`，
`POST /collect` **永远**回 `No lemon on the ground nearby` —— 不是地上没有，
是 `registry.items[itemId].name === itemName` 这个比较式永远不成立，只能走过去手动拾取。

### 修法：`item-registry.js` 把快照写回注册表

`registry/minecraft-item.json` 是服务端自己的 `名字 → 注册表id` 快照（**30729 条**），
和方块表来自同一次 FML 握手、每次登录覆盖写。`item-registry.js` 在 `inject_allowed`
阶段写进 `bot.registry`：

```js
itemRegistry.injectItems(bot.registry, itemRegistry.buildIndex(snapshot))
//  · registry.items[id] = rec   registry.itemsByName[name] = rec
//  · registry.itemsArray[id] = rec
```

自测：`node item-registry.js --selftest`（54 条断言）。查询：

```bash
curl --noproxy '*' 'http://127.0.0.1:3001/item?id=1284'                     # -> bountifulfares:lemon
curl --noproxy '*' 'http://127.0.0.1:3001/item?name=bountifulfares:lemon'   # -> id 1284
curl --noproxy '*' 'http://127.0.0.1:3001/item?name=stone'                  # 裸名 -> minecraft:stone
curl --noproxy '*' 'http://127.0.0.1:3001/item'                             # 总览 + liveRegistryProbe
```

`GET /inventory` 每项也新增了原始数字 **`type`** —— 模组物品唯一可靠的标识。

### ⚠️ 物品**故意**比方块简单 —— 五处差异都是有理由的

两个注入器长得很像，但**五条规则刻意不同**。把它"顺手统一"成方块那套就会坏：

| 方面 | 方块（`palette-registry.js`） | 物品（`item-registry.js`） |
|---|---|---|
| 键 | `stateId`，带属性维度 | 注册表 id，**无属性维度** |
| id 来源 | **要算** —— 按 state 数做前缀和 | 快照**直接给** |
| 锚点 | 需要 F3 锚点钉住模组段 | **不需要** |
| 连续性 | **硬判据**，`gaps === 0` 否则整份拒绝 | **允许断点**，只报告不拒绝 |
| 注入失败 | 踢线 | **绝不踢线** |

* **物品为什么容忍断点**：方块的 `first` 是前缀和**推**出来的，少一个 state 会让后面
  全部平移 —— 得到"看着很像但全错"的表，这是最坏的结果。而物品 id 是快照**直接给**的，
  缺一个 id 不会让别的物品错位。实测快照正好有 **2 处断点**（缺 `16961`、`28651`），无害。
* **物品为什么不踢线**：名字错了的代价是"她说不出手里是什么"；掉线的代价是整场会话。
  **错但在，好过不在。**

刻意保留的诚实标记（防止以后被"补全"）：

* **`maxDurability` 不填** —— 快照里没有，编一个数字会让耐久逻辑悄悄算错。
* **`stackSize` 一律 64** —— 是猜的，但猜得显式；这个字段只用于合并/拆分判断。
* **`displayName` 用完整 `modid:item`**，不美化 —— 绝不编造友好名。
* 注入的记录打 **`angelInjected: true`**，和真·原版条目分得开。

### 🔴 分界必须取**注入前**存下的基线

```js
const base = lastInjection?.baseVanillaIds || localItemIds(registry)
```

**不要**在第二次注入时用 `registry.items` 现算分界。第一次注入后注册表里已经混进
29474 个模组物品，现算出来的分界会跑到 30731 —— 模组物品被当成"原版"去核对，全表崩。
基线就是为了这个在第一写入前快照下来的。

### 验证结果

原版前缀逐条核对 **1255/1255，零差异**（`minecraft-data` 的 1255 个原版物品
id `0..1254` 与服务端快照完全一致）→ 分界可信；模组段从 id `1255` 起，29474 条。

```
[items] 物品快照已载入：30729 条；id 0..30730，断点 2 处
[items] bot.registry 注入成功：29474 个模组物品（原版前缀核对 1255/1255，断点 2 处）
```

**写出表 ≠ 跑着的 bot 看得到**，所以端点会拿快照里第一个模组物品去问**活注册表**：

```json
"liveRegistryProbe": {
  "id": 1255,
  "snapshotName": "ordertocook:order_machine",
  "resolvedInLiveRegistry": "ordertocook:order_machine",
  "byNameIndexed": true
}
```

> ⚠️ `new Item(id, count)` 第一个参数必须是**数字 id**。传注册表记录对象会让它去查
> `registry.items[对象]`、查不到、回 `unknown` —— 等于在测试里把你正在修的那个 bug
> 又引入一遍。（自测里踩过一次。）

---

## 死路：为什么不能从模组 jar 反推

试过。`extract_blockstates.py`（在 `minecraft-modpack-knowledge/scripts/`）能把 467 个 jar
里的 17757 个 `blockstates/*.json` 全解出来，**但结果不能用**：

* MC 允许 `variants` 的键**省略属性当通配符**，所以"键的个数"只是 state 数的**下界**。
  `glass_trapdoor` 真值 64 态（同原版活板门），从 JSON 只数得出 16 态。
* 单个方块少算一点，累计到第 14000 个方块就偏了 **27 万位** —— 两个锚点全部越界。
* 而且 13226 个模组方块在 jar 里**根本没有** blockstate 文件（模组只发了服务端）。

结论：这条路**结构性地不可能精确**。脚本留着（`--verify` 能当场判定），但别指望它。
`block-palette.json` 就是它的产物（`verified: false`），**别拿它当数据源**。

---

## 原版区间：不需要客户端 dump

`stateId 0..24134` 是 `minecraft-data` 的**基线**（不是当前整合包的最终布局），
可以不等客户端重启先生成；要让 bridge 认识整合包的完整地图，仍需导入
`angel_block_palette.txt` 并执行原版 overlay：

```bash
node scripts/make-vanilla-palette.js            # → registry/vanilla-palette-1.20.1.txt
```

产物**严格连续**（脚本自己验证，0 断点），所以能过导入安全阀。导入后 `GET /block`
会带上 `properties` / `propertiesText`（活板门的 `open=true/false` 就靠它区分）。

⚠️ 仅导入 `vanilla-palette-1.20.1.txt` 不能覆盖当前整合包的扩展原版区间；
当前完整识别必须使用客户端 dump。真实 dump 导入成功后，`GET /palette` 应显示
`loaded=true`、`injectedIntoRegistry.ok=true`、`vanillaStateEnd=25019`。

## 攀爬方块：别急着配 `MC_CLIMBABLE_STATE_IDS`

两层（`prismarine-physics` 的 `isOnLadder` / pathfinder 的 `climbables`）判的都是
**`block.type`（方块注册表 id）**，不是 stateId。原版梯子就是 196，而原版 id 零位移
（1003/1003）—— 所以**原版梯子本来就爬得上去，两个配置项留空才是正确状态**。

本包有 **32 种**名字含 `ladder` 的方块（Quark 一家 14 种木材变体）：

```bash
curl --noproxy '*' 'http://127.0.0.1:3001/debug/registry?name=minecraft:block&q=ladder&limit=40'
```

房子里的梯子很可能是模组加的，那 `block.type ≠ 196`，两层都认不出 —— 这才是真因。
修法是**按名字**（不经过 state，模组方块也精确）：

```json
"MC_CLIMBABLE_BLOCK_NAME": "quark:spruce_ladder"
```

`GET /palette/climbable?name=<方块名>` 会直接告诉你该不该配、配哪个。

⚠️ **物理层只有一个槽位**（`blocksByName.ladder.id` 是一个数字）。多给的名字只有寻路层收得下。

