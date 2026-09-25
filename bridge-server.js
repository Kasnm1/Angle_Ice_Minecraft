#!/usr/bin/env node
/**
 * minecraft-bridge: agent ↔ Minecraft Java Edition bridge service
 *
 * 启动：
 *   node bridge-server.js
 *
 * 配置来源（优先级：环境变量 > config.json > 内置默认值）：
 *   config.json（与本文件同目录，可从 config.example.json 复制）
 *
 *   MC_HOST          服务器地址            (默认 localhost)
 *   MC_PORT          游戏端口              (默认 25565)
 *   MC_BOT_USERNAME  机器人游戏内名字       (默认 Angel_ICE —— 固定身份)
 *   MC_BRIDGE_PORT   本地 HTTP 服务端口     (默认 3001)
 *   MC_VERSION       游戏版本              (默认 1.21.1)
 *   MC_AUTH          认证方式 offline|microsoft (默认 offline)
 *   MC_FORGE         置 1 启用 Forge/FML 登录握手 (默认 0)
 *
 * 只监听 127.0.0.1，不要对外暴露。
 */

'use strict';

const http = require('http');
// 放置的几何判定（四个硬条件）住在 place.js 里 —— 它是纯函数、可离线穷举，
// 见 `node place.js --selftest`。这里只负责"选好面 → 看过去 → 放 → 等确认"。
const placeLogic = require('./place');
const { DEADLY, isStandable, reachableStandY, findStandY } = placeLogic;
// 寻路策略（"绕路优先、拆方块是最后手段"）住在 pathing.js 里 —— 同样是纯函数、
// 可离线穷举，见 `node pathing.js --selftest`。这里只负责把它装到 Movements 上。
const pathing = require('./pathing');
// 「该换什么到手上来」的判据住在 decision.js 里 —— 纯函数、可离线穷举，
// 见 `node decision.js --selftest`（第 6 段）。放那边而不是这里，是因为
// autopilot 也要用同一份判据来表达"我想换手"，两边各写一遍必然漂移。
const { pickAutoEquip } = require('./decision.js');
// 「全局 state id → 真实方块名 + 属性值」。数据来自客户端导出的调色板 dump，
// 见 block-palette.js 顶部对"为什么方块名拿不到、为什么只能这么拿"的完整说明。
const blockPalette = require('./block-palette.js');
// 把调色板**写回** prismarine 注册表。**这一步才是"读不到方块信息"的真正修复**：
// 不注入的话 `b.type` 恒为 undefined，`b.name` 恒为空串，连梯子配置都无从生效。
// 见 palette-registry.js 顶部（含"为什么不能只当旁路查表"的机制推导）。
const paletteRegistry = require('./palette-registry.js');
// 把**物品注册表快照**写回 prismarine 的 item 注册表。和上面那条是同一类修复的另一半：
// 方块缺身份 → 碰撞/名字全错；物品缺身份 → `i.name` 恒为 'unknown'，
// 于是 /drop /equip /craft /place /collect 这些**按名字找物品**的原语全部失效。
// 见 item-registry.js 顶部（含"为什么它比方块那条简单得多"的机制推导）。
const itemRegistry = require('./item-registry.js');
// 她的手：吃 / 右键 / 穿戴 / 按整合包配方合成 / 熔炉 / 任意界面（见 hands.js 开头）
const hands = require('./hands.js');
let mineflayer, pathfinderPlugin, Movements, goals, Vec3;
// 三个「身体反射」插件。它们把"吃 / 换工具 / 采整片矿脉"从"要过一遍大脑"
// 降级成"库自己会做"—— 这是本轮对标 HiyoriAI 与 Mindcraft 后最重要的一条：
// 两边**都装了**这几个插件，社区里"bot 不捡东西"没有讨论度也是这个原因
// （掉落物拾取是服务端判定，bot 走过就自动捡，不需要客户端逻辑）。
//
// ⚠️ 三个都是**可选**依赖：装了就用，没装就退回原来的行为。
//    理由：依赖在 skill 目录（`~/.workbuddy-ai/skills/minecraft-bridge/node_modules`）
//    而不在项目目录，别人 clone 这个仓库时不会有它们；直接 `require` 会让整个
//    网桥起不来，而这只影响"能不能自动吃"这种次要能力。降级要可控。
let autoEatPlugin = null, toolPlugin = null, collectBlockPlugin = null;
try {
  mineflayer = require('mineflayer');
  const pf = require('mineflayer-pathfinder');
  pathfinderPlugin = pf.pathfinder;
  Movements = pf.Movements;
  goals = pf.goals;
  Vec3 = require('vec3').Vec3;
} catch (e) {
  console.error('[bridge] Missing dependencies. Install them first:');
  console.error('  npm install mineflayer mineflayer-pathfinder vec3');
  process.exit(1);
}
try { autoEatPlugin = require('mineflayer-auto-eat').loader; } catch (_) {}
try { toolPlugin = require('mineflayer-tool').plugin; } catch (_) {}
try { collectBlockPlugin = require('mineflayer-collectblock').plugin; } catch (_) {}

// ---- 配置：config.json + 环境变量 -------------------------------------------
// 优先级：环境变量 > config.json > 内置默认值
// config.json 让任何 agent 不必拼一长串 env 就能启动，直接改文件即可。
const fs = require('fs');
const path = require('path');

// 服务端注册表原始快照（Forge FML 握手推来的）。
// 这是"她能不能认出方块"的原始证据，**必须落盘**：
// 它只在登录握手那一刻到一次，掉线就没了，而且 470 个模组的方块表重建一次代价很高。
const REGISTRY_DIR = path.join(__dirname, 'registry');

// 机器人在游戏内的固定身份。改这里 = 改全局默认；环境变量/配置仍可临时覆盖。
const BOT_IDENTITY = 'Angel_ICE';

// `GET /scan` 单次最多检查多少个方块坐标。
//
// ⚠️⚠️⚠️ 2026-09-25 重写（**这里原来是错的**，见 field-log P45）：
//
// 旧注释写的是"半径 16 / 垂直 8 的立方体是 33 × 17 × 33 = 18513 格…
//   1536 格在半径 8（默认）下刚好扫完"。
//
// **两处都错：**
//   ① **算术错**：`radius=8` 是 `17 × 17 × 9 = 2601` 格，不是"刚好扫完 1536"。
//      实测 `scanned: 1536, truncated: true` —— **连默认半径都扫不完**。
//   ② **成本判断错**：真正的开销不是 `blockAt`，而是**为了"按距离取最近的 N 格"
//      而先把全部候选取出来排序**。实测（`_bench_blockat.js`，本机）：
//        · 分配 18513 个 Vec3 .............. 0.10 ms   （6 ns/个，可忽略）
//        · 排序 18513 个（比较器含 sqrt）... 11.80 ms  ← **就是它**
//        · 排序，改用距离**平方** .......... 7.96 ms
//        · **纯三重循环，不分配不排序** .... 0.82 ms  ← 快 14 倍
//
// 而 `/scan` 整体实测只要 8~11 ms —— **也就是说这个端点的时间几乎全花在排序上**，
// 不是在读世界上。**"扫更多格子会卡住主线程"这个担心，代价被高估了一个数量级。**
//
// 所以现在：
//   · 排序**删掉**，改成"按层（洋葱）向外扩"—— 从脚下那一层开始，逐层加大水平半径，
//     够数就停。**"近的优先"这个语义不变，但不需要排序**。
//   · 上限**提高**（免掉排序之后，多扫格子的边际成本只有几微秒）。
//   · 语义从"扫了多少**格**"改成"读了多少个**方块**" —— 空气不吃配额。
//     这一点最重要：旧语义下她站在实心地层里时，配额**全被脚边的土吃光**
//     （实测 `distinct: 6`，`radius=8` 与 `radius=16` 拿到**完全相同的结果**），
//     远处有什么**永远看不见** —— 挖矿时看不到 20 格外的矿脉。
const MAX_SCAN_BLOCK_POSITIONS = 6000;


// 网桥版本号。单一来源：banner 与 GET /status 都读这里。
// 1.2.0: spawn 时覆盖 pathfinder 的破坏性默认值（canDig/allow1by1towers/scafoldingBlocks），
//        并给 bot.dig 加审计钩子；新增 POST /knowledge/search 与 GET /config 的 pathfinder 自检块。
// 1.3.0: 新增 POST /place、POST /drop；GET /block 对无名 block state 显式标注并暴露原始 stateId。
// 1.4.0: POST /place 补齐放置的四个硬条件（参照面 / 可及性 / <4.5 格 / 自身碰撞箱），
//        放置前先站定，并以服务端 blockUpdate 确认（不再只信客户端预测）。
// 1.5.0: 寻路策略改由 pathing.js 负责 —— canDig 从 false 改回 true 并抬高 digCost
//        （原来的 false 是钝器，把"最后手段"也砍了，导致 No path 反而变多），
//        同时用 blocksCantBreak 硬禁建筑材质；新增注册表往返自检以判定方块名是否可信。
// 1.6.0: 可攀爬方块层 —— 模组服上梯子的 state 在原版表里落到别的方块（本包 5337→215），
//        而 pathfinder 写死原版 ladder.id=196，导致 climbable 恒 false。
//        新增 pathing.applyClimbables/probeClimbables，配置项 MC_CLIMBABLE_STATE_IDS。
// 1.7.0: 原始控制层 + 物理层梯子修正 ——
//        · POST /control（7 个控制位 = WASD+空格+Shift，单次按住封顶、try/finally 松手、
//          返回精确位移）、POST /climb（闭环原语，卡住报 stalledAtY）；
//        · POST /stop 现在也清控制位（停不住按住的 W 就不算急停）；
//        · GET /position 新增 exact（原 x/y/z 取整，闭环无法收敛）；
//        · 新增 pathing.installLadderFix：在 createBot **之前**改共享注册表的
//          blocksByName.ladder.id —— 一处改动同时修好 prismarine-physics 的 isOnLadder
//          与 pathfinder 的 climbables（两个库各自写死了同一个原版 ID）；
//        · 修 POST /move 的**目标泄漏**：超时/无路时原来不调 setGoal(null)，
//          目标一直挂着，寻路器每个 tick 覆盖 /control 设的控制位 —— 现象是
//          "按住 W 位移≈0、连 jump 都不动"，极易误诊为物理层坏了。改为 try/finally，
//          并让 /control 显式接管（返回 clearedGoal）；
//        · 新增 pathing.applyUnknownBlockPolicy：**未映射方块一律按实心处理**。
//          模组方块在原版注册表里查不到 → `prismarine-block` 给出 shapes=[] /
//          boundingBox='empty' → 客户端以为能穿过去，服务端照自己的碰撞把人推回来，
//          表现是原地抖动、位移≈0。补一处 `world.getBlock` 同时纠正物理层（shapes）、
//          寻路层（bot.blockAt → world.getBlock）与 GET /block 的读数。
//          可用 MC_UNKNOWN_BLOCK_SOLID=false 关闭，MC_PASSABLE_STATE_IDS 加白名单。
//        · 新增 POST /activate（右键"用"方块）：**寻路器不会开活板门** ——
//          `movements.js:97` 的 openable 只收名字带 "gate" 的方块，且 canOpenDoors
//          默认 false。闭着的活板门在它眼里就是一堵墙，所以这只手得我们自己做。
//          face 可显式指定，不给就自动选"朝向她的那一面"（玩家指出的那个活板门在她
//          头顶，顶面够不着，必须点底面 —— 而 activateBlock 的默认值是顶面）。
//        · /climb 改成**只按 jump**：实测 jump 单独按 Δy=+2.2，forward+jump Δy=0
//          （梯子嵌在一格宽的门缝里，按 forward 只会顶墙）。
//        · /climb 新增 autoOpen（默认开）：爬不动时**抬头右键头顶那格**，自己开门/活板门
//          （玩家原话：「他应该会自己开这种类型的」）。关键在**只把实测穿得过去的那个
//          state 记为可通行** —— 右键既能开也能关，所以是"乐观放行 → 实测 → 失败就撤回"，
//          撤回后等于什么都没做。白名单在 GET /config 的 passableStateIdsRuntime 可见。
// 1.8.0: **方块认知**（这一版回答的是"我们到底能不能拿到方块信息"）——
//        · 查清了：**能，而且数据一直在手上，是我们把它扔了。** Forge 在 FML 登录握手的
//          `S2CRegistry` 里把 `minecraft:block` 整张快照推过来（本包实测 **20217 个方块**），
//          而 fml-handshake.js 原来只读个名字、把快照字节原样跳过。现在真解析并落盘到
//          registry/minecraft-block.json（另有 minecraft:item 30729 条）。
//          新增 GET /debug/registries 看清单、GET /debug/registry?name=&q= 查条目。
//        · 新增 fml-handshake.parseSnapshot + scripts/fml-snapshot-test.js（19 项）：
//          Forge 的 `ForgeRegistry.Snapshot` 网络版 id 用 **varint**（NBT 版用 putInt，
//          两者只差字节宽度，写错不会报错、只会安静地解出垃圾名字），所以必须测。
//        · 新增 block-palette.js（自测 41 项）：stateId → 真实方块名 + 属性值。
//          新增 GET /palette、POST /registry/import-palette、GET /palette/state、
//          GET /palette/block、GET /palette/climbable；GET /block 现在会报真名
//          （nameSource 区分"注册表认识"和"我们查表填的"）与 properties。
//        · ⚠️ **纠错**：1.6.0 那个"梯子 state 5337"是**错的**。实测服务端 1003 个原版
//          方块的注册表 id 与原版**逐个一致（1003/1003，零差异）**，原版 state 区间
//          0..24134 没被模组挤开 —— 所以 5337 就是 `crimson_hanging_sign`（悬挂牌），
//          原版 ladder 是 4654..4661。之前把 5337 喂给物理层，她"爬上去"是自我实现的
//          预言。MC_CLIMBABLE_STATE_IDS 已清空，config.json 里留了说明。
//        · `isUnknownBlock` 的判据从 `type===undefined && name===''` 收紧为只看
//          `type===undefined`：因为新的名字解析会把 `b.name` 填上，而 world.getBlock
//          返回的是**缓存里的同一个对象** —— 留着 `name===''` 会让"未映射按实心处理"
//          在第二次读同一格时静默失效，她又开始穿墙。
//        · `registry-probe.patchProtocol` 从"诊断开关"升格为**常开修复**：
//          原版 `packet_declare_commands` 用写死的原版参数类型表解析命令树，本包有
//          模组自定义参数类型 → 解析错位 → `PartialReadError` → **整个包流错位** →
//          表现为 `client timed out after 30000 ms`（看着像网络问题，其实是解析器崩了）。
//          改成 restBuffer 后不再解析命令树（我们本来也不用）。
//        · 修 registry-probe 自己埋的坑：第一版把"已 patch"标记写成
//          `types.__declareCommandsAsRaw = true`，而 protodef 会遍历 `types` 的每个键
//          当类型定义去编译 → `compileType(true)` 返回 undefined → 在
//          `functions[type].startsWith` 上崩。现象是握手全对、注册表全收到、
//          **切到 PLAY 那一刻整个进程死掉**，堆栈还全在 protodef 内部。
// 1.8.1: **梯子修复的前提被推翻 + 名字路线**（离线可做完的那部分）——
//        · 把物理层事实钉死：`prismarine-physics:35/:442` 与
//          `pathfinder/movements.js:64/:232` **两层判的都是 `block.type`（方块注册表 id）**，
//          不是 stateId。原版梯子就是 196 → **本来就爬得上去，零配置才对**。
//          所以 installLadderFix 的**默认行为是"什么都不做"**，而且这是正确状态。
//        · 新增**名字路线** `MC_CLIMBABLE_BLOCK_NAME=create:ladder`：名字来自玩家 F3
//          实测，id 来自服务端 FML 快照（`registry/minecraft-block.json`）。
//          这条**不经过 state**，所以模组方块也精确 —— 而 state 路线在模组方块上会
//          撞到"恰好占着那个数字的原版方块"，正是 1.6.0 那次误判的机制。
//          快照**连接时才到**，但修正必须在 createBot **之前**跑，所以名字表会先从
//          磁盘载入（`blockNameToId()`），并在抓到新快照时就地更新。
//        · 修 `report.before` 被自己副作用污染：`prismarine-registry` 是**版本单例**，
//          改一次会粘住，第二次调用会把"改后"当"改前"报。新增 `report.baseline`
//          （模块级记**首次调用前**的值），`/config` 的 probeClimbables 基准改用它。
//        · `/palette*`、`POST /registry/import-palette`、`/debug/registr*` 移出连接前置检查
//          —— 它们只读本地文件/内存表，以前"想查诊断得先连上，而连不上正是要查诊断的原因"。
//          503 响应体新增 `offlineOk` 列出离线可用的路由。
//        · 自测 184 → **198**：新增真值断言（直接打在 `minecraft-data` 上证明
//          `blocksByStateId[5337]` 是 crimson_hanging_sign / id 215、原版 ladder 是
//          4654..4661），以及名字路线、快照缺失、baseline 不被污染、多路优先级。
//          ⚠️ 旧的梯子断言**全部通过却在测一个虚构前提** —— 这是"测试忠实复现错误假设"
//          的标本，所以新断言一律锚在库的真值上，前提漂移就会红。
// v1.9.0 —— **把调色板真正写回注册表**（"为什么读不到方块信息"的根修复）
//        · 新增 palette-registry.js（自测 47 项）：`injectPalette(registry, index)`
//          把 dump 里的模组方块写进 `registry.blocksByStateId` / `blocks` / `blocksByName`。
//          **不注入 = 白导**：`prismarine-block` 的构造函数里 `blockEnum` 查不到时
//          `this.type` 保持 `fromStateId` 传来的 `undefined`、`name` 是空串，
//          所以模组方块的 `b.type` 永远是 undefined —— 而梯子的两层判据
//          （prismarine-physics 与 mineflayer-pathfinder）都是 `block.type === ladderId`。
//          **结论：光配 `MC_CLIMBABLE_BLOCK_NAME` 不可能修好模组梯子，必须先有调色板。**
//        · 注入会拿**原版区间**当尺子交叉校验 dump（名字/起始 state/state 个数逐条比），
//          一处对不上就整份拒绝 —— 专门拦 `registry/block-palette.json` 那类
//          "连续但完全错位"的表（jar 反推产物，glass_trapdoor 报 base 239686，真值 522768）。
//        · 属性解码**免费**：注入 `states` 后 `Block` 自己会做混合进制展开；
//          纯布尔属性还原成真布尔（否则字符串 'false' 是真值，`isWaterlogged` 会误判）。
//        · `pathing.needsShapeFallback` 取代补丁里的 `isUnknownBlock`：
//          判据放宽到 `boundingBox === undefined`（= "我们没有它的权威碰撞箱"），
//          否则注入后 `type` 有值 → 补丁不跑 → **可穿过白名单静默失效**。
//          注入的记录**故意不填 boundingBox**，这是一条契约，自测里有断言钉住。
//        · 修 `pathing.js` 自测入口缺 `require.main === module` 守卫：任何被 require
//          进来的进程只要带 `--selftest` 就会连带跑 pathing 的用例
//          （实测 `node palette-registry.js --selftest` 打出的是 pathing 的用例）。
//        · `importPalette` 现在必须注入成功才算导入成功；`/palette` 与 `/config`
//          新增 `injectedIntoRegistry` / `registryIsSharedSingleton`；
//          连接后重注入一次并**断言** `bot.registry === 共享单例`（把"粘住"变成显式动作）。
//        · 新增 `scripts/palette-guard-test.js`（12 项）：拿 `registry/block-palette.json`
//          这份**真实坏样本**演示整条守门链 —— 它连续、全覆盖、原版那半正确（过前两道），
//          却被第三道锚点判据拒绝并报出精确偏移（273729 / 283082 位）。
//        · 自测：pathing 205 → **217**，新增 palette-registry **67**、palette-guard **12**。
//        · 顺带新增 `POST /reconnect`：`maxRetries`（30 × 5s ≈ 2.5 分钟）用完之后
//          自动重试就停了（不无限空转），服务端几小时后才起来时她不会自己回去 ——
//          以前只能手动重启整个网桥。现在有个显式开关，`GET /status` 也报
//          `retries` / `gaveUpReconnecting`。
// 1.9.3: **整合包完整方块认知** —— 原版基线不再被当作最终 state 布局；按服务端
//        block registry id 对齐 dump，累计 drift 验证整合包扩展的原版属性，原版
//        state 区间 overlay 到共享注册表，再注入 19214 个模组方块。`/palette` 和
//        `/config` 暴露 `vanillaStateEnd` / overlay 计数；重复注入可恢复旧注册表。
// 1.9.4: mineflayer 每次连接都会创建独立 bot.registry；调色板改为 inject_allowed
//        阶段注入本次连接的 registry，避免 spawn 后 physics 读取缺少 shapes 的半成品。
// 1.10.0: **物品身份**（"她到底拿着什么"的根修复）——
//        · 新增 item-registry.js（自测 54 项）：把 FML 快照 `registry/minecraft-item.json`
//          （30729 条）注入 `registry.items` / `itemsByName` / `itemsArray`。
//          `prismarine-item/index.js:36` 查不到 `itemEnum` 就把 `name`/`displayName`
//          写成 `'unknown'`（`stackSize` 写成 1），于是**一切按名字找物品的原语全部失效**：
//          /drop、/equip、/craft、/place 全查不到物品，`/collect` 的
//          `registry.items[itemId]?.name === itemName` 恒不成立（**永远匹配不到地上的掉落物**
//          —— 上一轮摘柠檬就卡在这，只能靠走过去蹭拾取），她自己也说不出手里是什么
//          （`saveState()` 只能退回 `item#1284`）。
//        · 与方块调色板的**关键差异（别照抄它的复杂度）**：物品**没有 state 维度**，
//          协议槽位里发的就是物品注册表 id，快照给的也是它 → 不需要 prefix-sum、
//          不需要 F3 锚点。唯一需要的判据是**原版前缀逐条一致**：实测
//          **1255/1255 零差异、零缺失**（与方块的 1003/1003 同源同结论）。
//          前缀一旦对齐，模组段就是服务端直接给定的 id，**没有可累积的误差**。
//          ⚠️ 所以这里**允许断点**（实测 2 处：16960→16962）—— 只报告、不拒绝。
//          方块那边把"严格连续"当硬判据是因为它的 first 靠前缀和推；这条差异是**刻意的**，
//          别"顺手统一"成拒绝。
//        · 分界必须取**注入前**存下的基线：注入之后 `registry.items` 里已经混进 29474 条，
//          现算分界会跑到 30731，于是模组物品被当"原版"去核对 → 全表崩。自测有断言钉住。
//        · 快照**只带 `名字 → id`**，不带 stackSize/maxDurability/displayName。所以
//          `stackSize` 填 64（全仓只有 `inventory.js` 的分堆启发式和村民交易读它，
//          不参与身份判定）、`maxDurability` **不填**（保持 undefined，与注入前 `else`
//          分支行为一致，不凭空给模组物品加"有耐久"语义）、`displayName` 直接用全名
//          （宁可显示 `bountifulfares:lemon` 也不**编**一个 "Lemon" 出来）。
//        · 新增 `GET /item`（按名字或数字 id 查 + 注入报告）；`GET /inventory` 每项
//          新增 `type`（原始数字 id）—— 这是"手里那个 unknown 到底是哪个 id"的唯一证据；
//          `GET /config` 新增 `itemInject`。
// 1.11.0: **身体反射层与方块感知**（对标 Mindcraft 与 HiyoriAI 的取长补短）——
//        · 装配三个插件（**可选依赖**，缺了就降级不报错）：mineflayer-tool /
//          mineflayer-collectblock / mineflayer-auto-eat。装法与状态见 `GET /plugins`。
//        · 新增 `GET /scan`：按名字聚合的**方块感知**（脚下/腿部/头部三格 + 附近方块表）。
//          这是"她看不见环境"的正面修复 —— 原来 autopilot 的 perceive() 只读 4 个端点，
//          零方块感知。扫描量上限 1536 格（与 HiyoriAI 的 MAX_SCAN_BLOCK_POSITIONS 同值同因）。
//        · 新增 `POST /eat`（主动吃）、`POST /pickup`（走过去拾取）、`POST /jump`（上浮换气）、
//          `POST /flee`（远离某点）。后两个是给反射层用的**闭环原语**。
//        · `GET /nearby` 补齐 `objectType` + 单独一份 `drops` + `counts` ——
//          掉落物的 `name` 是物品显示名而非 `'item'`，消费者原来判不出来，
//          这是"对可拾取的东西视而不见"的直接原因。
//        · `GET /status` 新增 `oxygen`（反射层判断上浮，抄 HiyoriAI 的 OXYGEN_EMERGENCY_LEVEL）。
//        · `pathing.injectFluidBreakGuard`：把"挖这一格会不会引水过来"编码进 A* 破坏代价。
//          判据是六邻域**加正上方 32 格**（后者覆盖"水柱下面是空气、还没变成流动水"的
//          服务端更新窗口）。抄 HiyoriAI 的 assessExcavationFluidRisk，是溺水事故的正面防御。
//          同时给 collectblock 自己那份 movements 套上同一套策略 ——
//          它**不复用** pathfinder 的 setMovements，是个独立的口子。
const BRIDGE_VERSION = '1.11.0';

function loadFileConfig () {
  const cfgPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // 允许 _comment / _note 之类的注释键
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      out[k] = v;
    }
    return out;
  } catch (e) {
    console.error(`[bridge] config.json 解析失败（已忽略）: ${e.message}`);
    return {};
  }
}

const FILE_CFG = loadFileConfig();

/** 取配置：环境变量 > config.json > 默认值 */
function cfg (key, fallback) {
  const env = process.env[key];
  if (env !== undefined && env !== '') return env;
  const file = FILE_CFG[key];
  if (file !== undefined && file !== null && file !== '') return String(file);
  return fallback;
}

// ---- Forge / FML 支持（MC_FORGE=1 开启）------------------------------------
// 原版协议客户端进 Forge 服务端会被 FML 登录握手挡在门外，报
//   "This server has mods that require Forge to be installed on the client."
// 这里在 mineflayer 创建底层客户端之前，替换 minecraft-protocol 的 createClient，
// 给每个新客户端挂上 FML 握手实现（见 ./fml-handshake.js）。
if (cfg('MC_FORGE', '0') === '1') {
  const nmp = require('minecraft-protocol');
  const fml = require('./fml-handshake.js');
  // 诊断：确认服务端到底发不发「方块注册表」。默认关，设 MC_PROBE_PACKETS=1 打开。
  // 必须在 createClient **之前** patch 协议（protocol 在建客户端时就编成 serializer 了）。
  const probe = require('./registry-probe.js');
  // ⚠️ `patchProtocol` 是**修复**不是诊断，必须常开。
  //    原版 `packet_declare_commands` 用一张写死的原版参数类型表去解析命令树，
  //    本包有模组自定义参数类型 → 解析错位 → `PartialReadError: Unexpected buffer end
  //    while reading VarInt` → **整个包流从此错位** → 表现为 `client timed out after 30000 ms`，
  //    看起来像网络问题，其实是解析器崩了。改成 restBuffer 后不再解析命令树，问题消失。
  //    （命令树我们本来也不用。）
  probe.patchProtocol(cfg('MC_VERSION', '1.21.1'), (...a) => console.log(...a));
  const probeStats = cfg('MC_PROBE_PACKETS', '0') === '1';
  const origCreateClient = nmp.createClient;
  nmp.createClient = function (options) {
    const client = origCreateClient.call(nmp, options);
    // 3) 拦下 minecraft-protocol **自带 chat 插件**的 `declare_commands` 校验器。
    //
    // 上面 `patchProtocol` 把那个包改成了「原样收字节」（`{raw: Buffer}`），
    // 而 `minecraft-protocol/src/client/chat.js:335` 还挂着这样一个校验：
    //     const nodes = packet?.nodes
    //     if (!Array.isArray(nodes) || ...) { rejectCommandTree() }      // chat.js:339
    // → `packet.nodes` 恒为 undefined → 判「不可能的指令树」→ `client.emit('error')`
    //   + `client.end('impossibleCommandTree')`。
    //
    // 实测症状（2026-09-24）：能 spawn，但 2 秒后被踢，`Bot disconnected
    // (impossibleCommandTree)` 无限循环 —— 补丁治好了 protodef 在模组指令树上崩，
    // 却换来 chat 插件主动掐线。
    //
    // ⚠️ 为什么必须在 `on` 这一层拦，而不是"挂上之后再摘掉"：
    //    chat 插件不是建客户端时挂的 —— 它由 `client/play.js:94` 的 `onReady()` 在
    //    **`success` 包处理过程中**才挂（1.20.2+ 还要等 `finish_configuration`）。
    //    也就是说挂载时机在连接建立之后，而 `declare_commands` 紧跟着就来，
    //    很可能落在同一个 TCP 段、同一次解析里 —— 任何"稍后摘掉"的写法都是赌运气。
    //    在 `on` 上拦是**时机无关**的：它根本没机会挂上。
    //
    // 安全性：全依赖树里只有 chat.js 一个地方监听这个包（mineflayer 和
    // mineflayer-pathfinder 都不监听），丢掉的是聊天栏指令自动补全 —— 她不需要。
    //
    // `allowDeclare` 只在挂我们自己的诊断探针时短暂打开，否则探针会静默失效
    // （静默失效比报错更难查）。
    const origOn = client.on;
    let allowDeclare = false;
    let warned = false;
    client.on = function (name, fn) {
      if (name === 'declare_commands' && !allowDeclare) {
        if (!warned) {
          warned = true;
          console.log('[bridge] 已拦下 minecraft-protocol chat 插件的 declare_commands 校验器'
            + '（它会把"原样收字节"的包判成不可能的指令树并掐线，见 bridge-server.js 注释）');
        }
        return this;
      }
      return origOn.call(this, name, fn);
    };
    try {
      // 1) 身份标记：Forge 服务端靠握手包里服务器地址的 "\0FML3" 后缀判断客户端是不是 Forge。
      //    没有这个后缀 → NetworkHooks.getConnectionType() 返回 VANILLA → 服务端根本
      //    不启动 FML 握手，登录时直接踢掉（"This server has mods that require Forge..."）。
      //    nmp 的 setProtocol 会把 client.tagHost 追加到握手地址后面。
      client.tagHost = '\u0000FML3';
      // 2) FML 登录握手。
      //    onSnapshot：服务端推来的注册表快照**当场落盘**，不等 HTTP 查询 ——
      //    这是"她能不能认出方块"的原始证据，掉一次连接就没了，必须即时保下来。
      state.__fml = fml.attach(client, {
        log: (...a) => console.log(...a),
        onSnapshot: (name, entries, info) => {
          // 界面类型表：打开模组界面（厨锅、砧板…）时靠它把数字 id 翻成名字，见 hands.js
          if (name === 'minecraft:menu') {
            state.menuById = new Map(entries.filter(([, id]) => typeof id === 'number').map(([n, id]) => [id, n]));
            try {
              fs.mkdirSync(REGISTRY_DIR, { recursive: true });
              fs.writeFileSync(path.join(REGISTRY_DIR, 'minecraft-menu.json'),
                JSON.stringify({ capturedAt: new Date().toISOString(), registry: name, entries }, null, 1));
            } catch (_) {}
            return;
          }
          if (name !== 'minecraft:block' && name !== 'minecraft:item') return;
          // 顺手更新内存里的名字表 —— 这样**同一次运行内**重连时，梯子 ID 修正
          // 立刻就能用上刚抓到的快照，不必等下一次启动。
          if (name === 'minecraft:block') {
            const m = blockNameToId();
            for (const [n, id] of entries) if (typeof id === 'number') m.set(n, id);
          }
          const file = path.join(REGISTRY_DIR, name.replace(':', '-') + '.json');
          fs.mkdirSync(REGISTRY_DIR, { recursive: true });
          const snapshot = {
            source: 'forge S2CRegistry snapshot (ForgeRegistry.Snapshot#getPacketData)',
            capturedAt: new Date().toISOString(),
            registry: name,
            host: `${CFG.mc.host}:${CFG.mc.port}`,
            entryCount: entries.length,
            entries
          };
          fs.writeFileSync(file, JSON.stringify(snapshot, null, 1));
          // 物品这份还要**就地更新内存**：注入发生在 inject_allowed 阶段，
          // 若那次跑在快照到达之前，用的是上一轮落盘的旧表。更新之后下次重连
          // 立刻用上新的，不必重启进程（和上面方块名字表同一个理由）。
          if (name === 'minecraft:item') state.itemSnapshot = snapshot;
          console.log(`[registry] ${name}：${entries.length} 条 → ${file}`);
        }
      });
      // 4) 诊断探针（默认不挂，MC_PROBE_PACKETS=1 才有）
      //    必须在 allowDeclare 窗口里挂 —— 否则上面那道拦截会把探针的
      //    `declare_commands` 监听器一起吃掉，诊断静默失效。
      if (probeStats) {
        allowDeclare = true;
        try {
          state.__probe = probe.attach(client, { log: (...a) => console.log(...a) });
        } finally {
          allowDeclare = false;
        }
      }
    } catch (e) {
      console.error('[bridge] FML 握手挂载失败:', e.message);
    }
    return client;
  };
  console.log('[bridge] Forge/FML 握手已启用（declare_commands 已改为原样收字节）' + (probeStats ? '（含包统计探针）' : ''));
}
// --------------------------------------------------------------------------

const CFG = {
  mc: {
    host: cfg('MC_HOST', 'localhost'),
    port: parseInt(cfg('MC_PORT', '25565')),
    // 固定身份：Angel_ICE（见文件顶部 BOT_IDENTITY）
    username: cfg('MC_BOT_USERNAME', BOT_IDENTITY),
    version: cfg('MC_VERSION', '1.21.1'),
    auth: cfg('MC_AUTH', 'offline'),
  },
  // 整合包版本目录。用来找客户端导出的方块调色板 dump
  // （`<packdir>/angel_block_palette.txt`，由 kubejs 启动脚本生成）。
  // 不给也不影响启动 —— 只是"认不出模组方块名"而已，实心策略照常生效。
  packDir: cfg('MC_PACK_DIR', ''),
  bridge: {
    port: parseInt(cfg('MC_BRIDGE_PORT', '3001')),
    reconnectMs: 5000,
    actionTimeout: 30_000,
    maxRetries: 30,
    // 原始控制层（POST /control、POST /climb）单次按住按键的上限。
    // 为什么必须封顶：按住 W 是没有"自然结束"的 —— 她可以一路走进岩浆。
    // 有上限才谈得上"闭环"：按一小段 → 看结果 → 再决定要不要继续。
    controlMaxMs: parseInt(cfg('MC_CONTROL_MAX_MS', '5000')),
  },
};

const state = {
  bot: null,
  connected: false,
  retries: 0,
  currentAction: null,
  movements: null, // Movements 实例，供 /config 自检寻路器安全开关
  pfPolicy: null,  // pathing.applyPolicy 的摘要（代价 + 受保护方块数）
  pfProbe: null,   // 注册表往返自检结果（名字可不可信）
  pfClimb: null,   // 可攀爬方块装配摘要（梯子在模组服上会被静默漏掉）
  pfClimbProbe: null, // 原版那套认不认得出这包里的梯子
  pfLadderFix: null,  // 物理层梯子 ID 修正摘要（必须在 createBot 之前做）
  pfUnknown: null,    // 未映射方块策略摘要（当实心，避免"客户端看不见的墙"）
  // 方块调色板索引（stateId → 真实方块名 + 属性值）。null = 还没导入。
  // 有了它，`GET /block` 才能把 `upgrade_aquatic:glass_trapdoor` 这种模组方块
  // 叫出名字来，而不是空字符串。数据来自客户端 KubeJS 导出的 dump。
  palette: null,
  paletteMeta: null,  // { file, loadedAt, entries, gaps, totalStates, source, inject }
  paletteInject: null, // 最近一次"写回注册表"的结果（连接后重注入会更新它）
  // 物品注册表快照（`registry/minecraft-item.json`，FML 握手 `S2CRegistry` 的
  // `minecraft:item` 那一份，30729 条 `[名字, 数字id]`）。启动时从磁盘读，
  // 抓到新快照时就地更新 —— 与方块那条 `blockNameToId()` 完全同一个理由：
  // 快照**连接时才到**，而注入发生在 inject_allowed 阶段，所以只能先用上一份。
  itemSnapshot: null,
  itemInject: null,    // 最近一次物品注入的结果
  gaveUpReconnecting: false, // 自动重试耗尽后置 true；POST /reconnect 会清掉它
  // ---- 寻路目标的变更轨迹（P25 排查用）--------------------------------------
  //
  // 为什么需要它：`mineflayer-pathfinder` 的 `goto()` 会在收到 `goal_updated`
  // 且 `newGoal !== goal` 时报 "The goal was changed before it could be completed!"。
  // 这条错误**只说了"目标变了"，没说是谁改的、改成了什么** ——
  // 实测中它导致「地上 4 个掉落物、距离 1.4 格、一个都捡不到」，
  // 而单看错误信息完全推不出成因。
  //
  // 这个环形缓冲把每一次 `goal_updated` 记下来（谁触发的 + 新目标是什么），
  // 通过 `GET /debug/pathfinder` 暴露。**只读、无副作用**。
  __goalTrace: [],
  __goalTraceMax: 40,
  // 运行时"可穿过"的 state 白名单。她**自己打开**的门/活板门在实测穿得过去之后记进来。
  // ⚠️ 这个 Set 必须**只增删、绝不替换** —— world.getBlock 的补丁是按引用读它的。
  passableStateIdsRuntime: new Set(),
};

// ---- 方块调色板：加载 / 查询 ------------------------------------------------

/**
 * 调色板 dump 的候选路径（按优先级）。
 *
 * ⚠️ 两种后缀都要找：客户端脚本的**首选**输出是 `.json`
 *    （KubeJS 的 `JsonIO.write` 只能写 JSON），**兜底**才是把行打进日志、
 *    由人抽成 `.txt`。两种都由 `blockPalette.normalizeDumpText` 归一化。
 */
function paletteCandidates () {
  const out = [];
  const names = ['angel_block_palette.json', 'angel_block_palette.txt'];
  if (CFG.packDir) for (const n of names) out.push(path.join(CFG.packDir, n));
  for (const n of names) out.push(path.join(REGISTRY_DIR, n));
  for (const n of names) out.push(path.join(__dirname, n));
  return out;
}

/**
 * 拿到那份**共享的** prismarine 注册表。
 *
 * 为什么能离线拿：`prismarine-registry` 按版本缓存**单例**，而 `minecraft-data`
 * 返回的是**同一个对象**（`minecraft-data('1.20.1').blocksByName ===
 * prismarine-registry('1.20.1').blocksByName` 为 true，见 SKILL.md）。
 * 所以：
 *   · 调色板可以在**没连服务器时**就注入，重连之后照样在；
 *   · 梯子 ID 修正（`fixLadderIdBeforeConnect`）也正是靠这个"改一次就粘住"的特性，
 *     才能赶在 `createBot()` **之前**生效。
 * 拿不到就返回 null（调用方自己决定是报错还是跳过）。
 */
function sharedRegistry () {
  try {
    return require('prismarine-registry')(CFG.mc.version);
  } catch (_) {
    return null;
  }
}

/**
 * 导入一份调色板 dump。
 *
 * ⚠️ **不连续就拒绝使用。** 相邻方块的 `[first, first+count)` 必须严丝合缝；
 *    只要有一处对不上，就说明 dump 不完整或被改过 —— 那时整张表都会错位，
 *    给出的是**看起来很像但完全错的**方块名。宁可继续报"认不出"。
 */
function importPalette (file) {
  if (!fs.existsSync(file)) return { ok: false, reason: `文件不存在: ${file}` };
  const raw = fs.readFileSync(file, 'utf8');
  // 三种输入形态统一成 dump 文本：纯文本 / JSON{rows} / JSON 数组。
  // 见 block-palette.js 的 normalizeDumpText（纯函数，有自测）。
  const text = blockPalette.normalizeDumpText(raw);
  const parsed = blockPalette.parseDump(text);
  const index = blockPalette.buildIndex(parsed.entries);
  const meta = {
    file,
    loadedAt: new Date().toISOString(),
    entries: parsed.entries.length,
    badLines: parsed.badLines.length,
    dupes: parsed.dupes,
    gaps: index.gaps,
    gapSamples: index.gapList,
    firstState: index.firstState,
    totalStates: index.totalStates,
  };
  if (!parsed.entries.length) {
    return { ok: false, reason: 'dump 里没有一条有效记录', meta };
  }
  if (parsed.dupes > 0) {
    return { ok: false, reason: `dump 里有 ${parsed.dupes} 个重复 blockId，拒绝使用`, meta };
  }
  if (index.gaps > 0) {
    // 不连续 → 拒绝。附上前几个断点方便定位是哪一段丢了。
    return { ok: false, reason: `调色板不连续（${index.gaps} 处断点）—— 整张表会错位，拒绝使用`, meta };
  }

  // ---- 写回注册表（这一步才是真正让 `b.type` / `b.name` 存在的关键）----
  // 按服务端 block registry id 对齐原版；名字必须一致，first 必须跟随前面合法扩容
  // 累计漂移，count 只能增加不能减少。通过后会 overlay 整个真实 vanilla 区间，
  // 再注入模组段；`registry/block-palette.json` 那种连续但错位的表仍由 F3 锚点挡住。
  // bot.registry 是 mineflayer 在 connect_allowed 阶段新建的对象，不能假设
  // prismarine-registry() 返回单例。启动时先做 validation-only，真正注入延后到
  // mineflayer 的 inject_allowed 插件阶段，确保 physics/blocks 看到的是完整注册表。
  const targetRegistry = state.bot?.registry || sharedRegistry();
  const commit = !!state.bot?.registry;
  const inject = paletteRegistry.injectPalette(targetRegistry, index, {
    commit,
    // 空串 → undefined → 用内置的 F3 实测锚点（**不要**把空串解析成"没有锚点"，
    // 那等于把唯一能钉住模组区间累计偏移的判据关掉）。
    anchors: String(cfg('MC_PALETTE_ANCHORS', '')).trim()
      ? paletteRegistry.parseAnchors(cfg('MC_PALETTE_ANCHORS', ''))
      : undefined,
  });
  meta.inject = {
    ok: inject.ok,
    committed: commit && inject.ok,
    validationOnly: inject.validationOnly === true,
    blocks: inject.blocks,
    states: inject.states,
    overlayBlocks: inject.overlayBlocks,
    overlayStates: inject.overlayStates,
    totalBlocks: inject.totalBlocks,
    totalStates: inject.totalStates,
    vanillaChecked: inject.vanillaChecked,
    vanillaExpanded: inject.vanillaExpanded,
    vanillaStateEnd: inject.vanillaStateEnd,
    vanillaMismatches: inject.vanillaMismatches,
    vanillaMissing: inject.vanillaMissing,
    duplicateBlockIds: inject.duplicateBlockIds,
    anchorsChecked: inject.anchorsChecked,
    anchorViolations: inject.anchorViolations,
    anchorMissing: inject.anchorMissing,
    cleared: inject.cleared,
    samples: inject.samples,
    reason: inject.reason,
  };
  if (!inject.ok) {
    return { ok: false, reason: `注册表注入失败：${inject.reason}`, meta };
  }

  state.palette = index;
  state.paletteMeta = meta;
  if (commit && state.bot?.registry === targetRegistry) {
    state.paletteInject = { ...inject, committed: true, botRegistry: true };
  }
  return { ok: true, meta };
}

/** 启动时自动找一份 dump 导入（找不到就安静地跳过）。 */
function autoImportPalette () {
  for (const f of paletteCandidates()) {
    if (!fs.existsSync(f)) continue;
    const r = importPalette(f);
    if (r.ok) {
      const inj = r.meta.inject || {};
      console.log(`[palette] 已导入方块调色板：${r.meta.entries} 个方块 / `
        + `${r.meta.totalStates} 个 state（连续，无断点）← ${f}`);
      if (inj.validationOnly) {
        console.log(`[palette] 离线校验通过：原版扩容 ${inj.vanillaExpanded ?? 0} 个，`
          + `原版尾界 ${inj.vanillaStateEnd ?? '?'}；F3 锚点 ${inj.anchorsChecked} 个，违规 ${inj.anchorViolations?.length ?? 0} 个`
          + ' —— 等待 bot.registry 在 inject_allowed 阶段实际注入');
      } else {
        console.log(`[palette] 已写回注册表：${inj.overlayBlocks ?? 0} 个原版 overlay / `
          + `${inj.blocks} 个模组方块 / ${inj.states} 个模组 state`
          + `（原版扩容 ${inj.vanillaExpanded ?? 0} 个，原版尾界 ${inj.vanillaStateEnd ?? '?'}；`
          + `原版校验 ${inj.vanillaChecked} 条，对不上 ${inj.vanillaMismatches?.length ?? 0} 条；`
          + `F3 锚点校验 ${inj.anchorsChecked} 个，违规 ${inj.anchorViolations?.length ?? 0} 个）`
          + ' —— 现在 b.type / b.name / 属性都是真的了，地图识别已接入');
      }
      if (inj.anchorMissing?.length) {
        console.log(`[palette]   ⚠ 有 ${inj.anchorMissing.length} 个锚点在这次 dump 里没找到对应方块`
          + '（不算违规，但等于那个锚点没起作用）：'
          + inj.anchorMissing.map(a => `${a.name ?? ''}#${a.blockId}`).join(', '));
      }
      return r;
    }
    console.log(`[palette] ⚠ 找到 ${f} 但拒绝使用：${r.reason}`);
    if (r.meta?.inject?.vanillaMismatches?.length) {
      console.log(`[palette]   原版区间对不上的前几条：${JSON.stringify(r.meta.inject.vanillaMismatches.slice(0, 3))}`);
    }
    if (r.meta?.inject?.anchorViolations?.length) {
      console.log(`[palette]   锚点对不上的前几条：${JSON.stringify(r.meta.inject.anchorViolations.slice(0, 3))}`);
    }
    return r;
  }
  console.log('[palette] 没有方块调色板 dump —— 模组方块会显示为空名字（实心策略照常生效）。'
    + '想要名字就按 registry/README 里的说明导出一次。');
  return { ok: false, reason: '没有找到 dump 文件' };
}

/**
 * 把 stateId 解析成方块名（没有调色板就返回 null）。
 *
 * ⚠️ 现在这只是**兜底**。调色板一旦写回注册表（`palette-registry.js`），
 *    `b.name` 就是注册表给的权威名字，实心策略补丁里只在 `!b.name` 时才调它。
 *    保留它的意义：注册表注入失败、或某个 state 恰好在注入范围之外时，
 *    还能靠它把名字填上（名字是锦上添花，实心是不出错）。
 */
function resolveBlockName (stateId) {
  if (!state.palette) return null;
  const hit = blockPalette.lookupState(state.palette, stateId);
  return hit ? hit.name : null;
}

const MAX_BODY_BYTES = 64 * 1024;

// 游戏内聊天环形缓冲：mineflayer 收到的每条 chat/system 消息都记一份，
// 供 GET /chatlog 读取。没有这个，`POST /command`（如 /list）的执行结果会被直接丢掉。
const CHATLOG_MAX = 200;
const chatlog = [];

/** 往聊天环形缓冲里塞一条。position: 'chat' | 'system' | 'game_info' | 'bridge' */
function pushChat (text, position) {
  chatlog.push({ t: Date.now(), position: position ?? null, text });
  while (chatlog.length > CHATLOG_MAX) chatlog.shift();
}

// 上一次的血量，用来判断"是不是刚被打了一下"。null = 还没收到过 health 事件。
let lastHealth = null;

// ---- 持久记忆 --------------------------------------------------------------
// Angel_ICE 的记忆，跨会话 / 跨 agent 保留在技能目录下：
//   memory/journal.md  —— 追加式事件日志（人和 agent 都能直接读）
//   memory/state.json  —— 当前状态快照（覆盖写，随时反映"我现在在哪、还剩多少血"）
// 设计意图：机器人重启、agent 换人，都还能读到"之前发生过什么"。
const MEM_DIR = path.join(__dirname, 'memory');
const JOURNAL_FILE = path.join(MEM_DIR, 'journal.md');
const STATE_FILE = path.join(MEM_DIR, 'state.json');

// 游戏知识库：整合包任务书 / 物品名 / 模组 / 提示，离线也能查。
const KB_DIR = path.join(__dirname, 'knowledge');

function ensureMemDir () {
  try { fs.mkdirSync(MEM_DIR, { recursive: true }); } catch (_) {}
}

function localStamp () {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 往记忆里追加一件事。返回写入的那一行。 */
function journal (type, text) {
  ensureMemDir();
  const clean = String(text).replace(/\r?\n/g, ' ').trim();
  const line = `- [${localStamp()}] (${type}) ${clean}`;
  try {
    fs.appendFileSync(JOURNAL_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('[bridge] 记忆写入失败:', e.message);
  }
  return line;
}

function readJournal (limit = 40) {
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
    return { total: lines.length, lines: lines.slice(-limit) };
  } catch (_) {
    return { total: 0, lines: [] };
  }
}

/** 把"当前状态"落盘。agent 读它就知道机器人此刻在哪、什么情况。 */
function saveState () {
  ensureMemDir();
  const snap = {
    savedAt: localStamp(),
    identity: CFG.mc.username,
    server: `${CFG.mc.host}:${CFG.mc.port}`,
    connected: state.connected,
    position: botPos(),
    dimension: state.bot?.game?.dimension ?? null,
    health: state.bot?.health ?? null,
    food: state.bot?.food ?? null,
    gameTime: state.bot?.time?.timeOfDay ?? null,
    isDay: (state.bot?.time?.timeOfDay ?? 0) < 13000,
    isSleeping: !!state.bot?.isSleeping,
    // 模组服务器上 minecraft-data 可能不认识某些物品，name 会是 'unknown'；退回数字 id
    inventory: (state.bot?.inventory?.items() || []).map(i =>
      `${(!i.name || i.name === 'unknown') ? `item#${i.type}` : i.name}x${i.count}`),
    playersOnline: Object.values(state.bot?.players || {}).map(p => p.username),
    currentAction: state.currentAction,
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2), 'utf8');
  } catch (e) {
    console.error('[bridge] 状态写入失败:', e.message);
  }
  return snap;
}

// -------------------------------------------------- 服务端方块注册表（名字 → id）
/**
 * `名字 → 方块注册表 id`，来自 Forge FML 握手的 `S2CRegistry` 快照。
 *
 * 为什么要走**磁盘**这条路：`fixLadderIdBeforeConnect` **必须在 `createBot` 之前**
 * 跑，而快照是**连接过程中**才收到的。只靠内存的话第一次连接永远拿不到名字表；
 * 落盘之后第二次启动就能在连接前用上。表本身是服务端真值，不经过 state。
 */
let BLOCK_NAME_TO_ID = null;

function blockNameToId () {
  if (BLOCK_NAME_TO_ID) return BLOCK_NAME_TO_ID;
  BLOCK_NAME_TO_ID = new Map();
  const file = path.join(REGISTRY_DIR, 'minecraft-block.json');
  try {
    if (!fs.existsSync(file)) return BLOCK_NAME_TO_ID;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [n, id] of (raw.entries || [])) {
      if (typeof id === 'number') BLOCK_NAME_TO_ID.set(n, id);
    }
    console.log(`[registry] 名字→id 表已载入：${BLOCK_NAME_TO_ID.size} 条（${file}）`);
  } catch (e) {
    console.error(`[registry] 名字→id 表载入失败：${e.message}`);
  }
  return BLOCK_NAME_TO_ID;
}

// -------------------------------------------------- 服务端物品注册表（名字 → id）

/**
 * 读入 `registry/minecraft-item.json`（FML 握手 `S2CRegistry` 的 `minecraft:item` 快照）。
 *
 * 和方块那条**同一个理由**走磁盘：快照是**连接过程中**才到的，而注入发生在
 * `inject_allowed`（也在连接过程中，但早于快照处理）—— 所以第一次连接只能先用
 * 上一轮落盘的那份。表本身是服务端真值，且**同一套整合包不会变**。
 *
 * 与方块那条的区别：这里**不缓存成 Map**，而是把整份快照留在 `state.itemSnapshot`。
 * 因为注入要做的原版前缀校验需要 `entryCount` / 断点 / 重复名这些**结构性信息**，
 * 光一张 Map 不够；而快照本身才 1.7 MB，留在内存里无所谓。
 */
function loadItemSnapshot () {
  const file = itemRegistry.DEFAULT_SNAPSHOT;
  const snap = itemRegistry.loadSnapshot(file);
  if (!snap) {
    console.warn(`[items] 没找到物品注册表快照（${file}）—— `
      + '本次连接的物品名仍会是 unknown。连上一次服务端就会自动落盘，重连即生效。');
    return null;
  }
  state.itemSnapshot = snap;
  const idx = itemRegistry.buildIndex(snap);
  console.log(`[items] 物品快照已载入：${snap.entryCount} 条`
    + `（${file}，抓取于 ${snap.capturedAt}，host ${snap.host}）`
    + (idx.ok ? `；id ${idx.minId}..${idx.maxId}，断点 ${idx.gapCount} 处` : `；⚠️ ${idx.reason}`));
  return snap;
}

/**
 * 在 `createBot` **之前**修掉写死的原版梯子 ID。
 *
 * 为什么时序这么讲究：`prismarine-physics` 在**构造 Physics 实例时**就把
 * `blocksByName.ladder.id` 读进了闭包（`index.js:35`），而 Physics 是 mineflayer
 * 在建 bot 的过程中造的。晚一步改，**这次连接就白改**（要等下一次重连才生效）。
 *
 * 为什么改一处就够：`prismarine-registry` 与 `minecraft-data` 返回的是**同一个**
 * `blocksByName` 对象（实测 `===` 为 true），而 pathfinder 的 `Movements` 也在
 * 构造时从同一个对象读 `ladder.id`。两个互不依赖的库，共用一个被写死的数字。
 *
 * ⚠️ **默认什么都不做，而且这是对的。** 2026-09-23 实测：服务端 1003 个原版方块的
 * 注册表 id 与原版**逐个一致（1003/1003，零差异）**，原版 state 区间没被模组挤开，
 * `minecraft-data('1.20.1')` 里 `ladder.id` 就是 **196** —— 两层判定都基于 `block.type`，
 * 所以原版梯子**本来就爬得上去**。上一轮把 id 改成 215 是在治一个不存在的病，
 * 副作用是把本来正确的 196 改坏。详见 `pathing.installLadderFix` 的注释。
 *
 * 只有当**确实**存在一个非原版梯子时才配：
 *   * `MC_CLIMBABLE_BLOCK_NAME`（推荐）：玩家 F3 读到的方块名，如 `create:ladder`。
 *     走服务端快照解析，**模组方块也精确**。
 *   * `MC_CLIMBABLE_STATE_IDS`：按 state 记。**只在原版方块上可信**。
 */
function fixLadderIdBeforeConnect () {
  const stateIds = pathing.parseIdList(cfg('MC_CLIMBABLE_STATE_IDS', ''));
  const blockNames = pathing.parseNameList(cfg('MC_CLIMBABLE_BLOCK_NAME', ''));
  if (!stateIds.length && !blockNames.length) {
    state.pfLadderFix = {
      applied: false,
      reason: 'MC_CLIMBABLE_STATE_IDS / MC_CLIMBABLE_BLOCK_NAME 都未配置 —— 不动注册表（默认且正确）',
    };
    return;
  }

  let registry = null;
  try {
    registry = require('prismarine-registry')(CFG.mc.version);
  } catch (e) {
    console.error(`[pathing] 梯子 ID 修正跳过：拿不到注册表（${e.message}）`);
    state.pfLadderFix = { applied: false, reason: `registry unavailable: ${e.message}` };
    return;
  }

  const r = pathing.installLadderFix(registry, stateIds, {
    blockNames,
    nameToId: blockNameToId(),
  });
  state.pfLadderFix = r;
  if (r.applied) {
    console.log(`[pathing] 梯子 ID 修正：${r.reason}`
      + '（在 createBot 之前改，prismarine-physics 与 pathfinder 同时生效）');
  } else {
    console.log(`[pathing] 梯子 ID 未改动：${r.reason}`);
  }
  if (r.unknownBlockNames && r.unknownBlockNames.length) {
    console.warn(`[pathing] 这些方块名在服务端快照里查不到：${r.unknownBlockNames.join(', ')}`
      + '（快照要连过一次服务端才有；也可能是名字拼错）');
  }
}

/**
 * 右键"用"一个方块。`POST /activate` 与 `POST /climb` 的自动开门共用这一只手 ——
 * 抽出来就是为了**测的就是跑的**：两处不会各写一份、各漏一个边界。
 *
 * @param {Vec3} pos 目标方块坐标（整数格）
 * @param {{face?: string}} [opts] face: top|bottom|north|south|east|west，不给就自动选朝向她的那面
 * @returns {Promise<{activated:object, face:string, distance:number,
 *                    before:object, after:object|null, stateChanged:boolean}>}
 */
async function useBlockAt (pos, opts = {}) {
  const FACES = {
    top: [0, 1, 0], bottom: [0, -1, 0],
    north: [0, 0, -1], south: [0, 0, 1],
    west: [-1, 0, 0], east: [1, 0, 0],
  };
  const { face } = opts;
  if (face !== undefined && !FACES[face]) {
    throw new Error(`unknown face "${face}"; allowed: ${Object.keys(FACES).join(', ')}`);
  }

  const block = state.bot.blockAt(pos);
  if (!block) throw new Error('chunk not loaded at that position');
  if (block.name === 'air') throw new Error('target is air — nothing to activate');

  const eye = state.bot.entity.position.offset(0, state.bot.entity.eyeHeight ?? 1.62, 0);
  const dist = eye.distanceTo(pos.offset(0.5, 0.5, 0.5));
  // 原版服务端对"使用方块"有距离限制，太远会静默失败（看起来像"点了没反应"）。
  if (dist > 6) throw new Error(`too far to activate: ${dist.toFixed(2)} blocks (max 6)`);

  const normal = face ? FACES[face] : pathing.faceTowardBlock(pos, eye);
  const before = { stateId: block.stateId, name: block.name };

  state.currentAction = `activate ${before.name || 'stateId ' + before.stateId} @ ${pos.x},${pos.y},${pos.z}`;
  try {
    await state.bot.activateBlock(block, new Vec3(normal[0], normal[1], normal[2]), new Vec3(0.5, 0.5, 0.5));
    // 等服务端把新的 blockUpdate 推回来 —— 立刻读会读到旧状态，
    // 那样 stateChanged 恒为 false，调用方会以为"没生效"。
    await sleepMs(300);
  } finally {
    state.currentAction = null;
  }

  const after = state.bot.blockAt(pos);
  const afterInfo = after ? { stateId: after.stateId, name: after.name } : null;
  return {
    activated: { x: pos.x, y: pos.y, z: pos.z },
    face: face || `auto(${normal.join(',')})`,
    distance: +dist.toFixed(2),
    before,
    after: afterInfo,
    // 这是"到底开没开"的判据：stateId 变了 = 服务端真的改了方块状态。
    // 没变不一定失败（有些方块右键不改变 state），但变了就一定成功。
    stateChanged: !!afterInfo && afterInfo.stateId !== before.stateId,
  };
}

/**
 * mineflayer 每次连接都会创建一个新的 bot.registry（不是全局 singleton）。
 * 必须把完整 palette 注入 inject_allowed 阶段，早于 world/physics 收到首个 chunk；
 * 在 spawn 才补会导致 prismarine-physics 先读到缺少 shapes 的半成品记录并崩溃。
 */
function installPalettePlugin (bot) {
  if (!state.palette) return;
  const anchors = String(cfg('MC_PALETTE_ANCHORS', '')).trim()
    ? paletteRegistry.parseAnchors(cfg('MC_PALETTE_ANCHORS', ''))
    : undefined;
  const report = paletteRegistry.injectPalette(bot.registry, state.palette, { anchors });
  state.paletteInject = { ...report, committed: report.ok, botRegistry: true };
  if (!report.ok) {
    console.error(`[palette] bot.registry 注入失败：${report.reason}`);
    // 不让一个缺失注册表的 bot 带着错误碰撞信息继续进游戏。
    try { bot.end('paletteInjectionFailed'); } catch (_) {}
    return;
  }
  console.log(`[palette] bot.registry 注入成功：${report.overlayBlocks} 个原版 overlay / `
    + `${report.blocks} 个模组方块 / ${report.states} 个模组 state；`
    + `原版尾界 ${report.vanillaStateEnd}，扩容 ${report.vanillaExpanded} 个`);
}

/**
 * 物品注册表注入。和调色板同一个阶段、同一个理由：mineflayer 每次连接都会新建
 * `bot.registry`，所以**必须**注入本次连接的那个对象，注入早了会落在上一个 bot 上。
 *
 * 物品比方块宽松的地方在于**没有时序压力** —— 物品 id 只出现在 play 阶段的槽位包
 * （`window_items` / `set_slot`）里，不像方块的 shapes 会被 physics 在构造时就读走。
 * 但仍然挂在 inject_allowed：一次连接只注入一次，语义最干净。
 *
 * 快照从 `state.itemSnapshot` 来（启动时读盘，抓到新的就地更新）。第一次跑还没有
 * 快照文件时**只警告、不踢线** —— 与调色板不同，物品缺失不会让物理层读到错误碰撞，
 * 顶多是名字仍为 'unknown'（也就是修之前的状态），没必要因此拒绝进游戏。
 */
function installItemPlugin (bot) {
  if (!state.itemSnapshot) {
    console.warn('[items] 没有物品注册表快照（registry/minecraft-item.json）—— '
      + '本次连接的物品名仍会是 unknown；连上一次服务端后快照会自动落盘，重连即生效。');
    return;
  }
  const index = itemRegistry.buildIndex(state.itemSnapshot);
  const report = itemRegistry.injectItems(bot.registry, index);
  state.itemInject = { ...report, committed: report.ok, botRegistry: true };
  if (!report.ok) {
    // 与调色板相反：**不踢线**。物品名错了只是"说不出手里是什么"，
    // 不会像方块那样让 physics 读到错的碰撞把人推来推去 —— 带病继续比掉线好。
    console.error(`[items] bot.registry 注入失败：${report.reason}`);
    return;
  }
  console.log(`[items] bot.registry 注入成功：${report.modded} 个模组物品`
    + `（原版前缀核对 ${report.vanillaChecked}/${report.vanillaItemCount}，`
    + `断点 ${report.gaps} 处）`);
}

function createBot() {
  if (state.bot) {
    try { state.bot.end(); } catch (_) {}
  }

  // ⚠️ 必须在 mineflayer.createBot 之前 —— 物理层在构造时求值，晚了这次连接就不生效。
  fixLadderIdBeforeConnect();

  console.log(`[bridge] Connecting to ${CFG.mc.host}:${CFG.mc.port} as ${CFG.mc.username}...`);

  state.bot = mineflayer.createBot({
    host: CFG.mc.host,
    port: CFG.mc.port,
    username: CFG.mc.username,
    version: CFG.mc.version,
    auth: CFG.mc.auth,
    // 作为 mineflayer 外部插件在 inject_allowed 阶段运行：此时 bot.registry
    // 已创建，且仍早于首个世界区块/physics tick。
    // ⚠️ 两个插件各自独立，**不要**把物品注入塞进 installPalettePlugin —— 那个函数
    // 开头就 `if (!state.palette) return`，没有方块 dump 的机器上物品也会被一起跳过。
    plugins: {
      angleicePalette: installPalettePlugin,
      angleiceItems: installItemPlugin,
    },
  });

  state.bot.loadPlugin(pathfinderPlugin);
  // 模组界面补丁：必须在 mineflayer 的 open_window 处理之前装上（prependListener）
  hands.install(state.bot, state);

  // ---- 身体反射插件 ----------------------------------------------------------
  // 加载顺序有讲究（两边项目都是 pathfinder 打头）：
  //   pathfinder 先 → tool / collectblock 都依赖它的 Movements，
  //   collectblock 装上后会**自己建一份 movements**（见 spawn 里那段注释）。
  if (toolPlugin) {
    state.bot.loadPlugin(toolPlugin);
    console.log('[plugins] mineflayer-tool 已装配：挖方块前会自动换上正手的工具');
  }
  if (collectBlockPlugin) {
    state.bot.loadPlugin(collectBlockPlugin);
    console.log('[plugins] mineflayer-collectblock 已装配：/mine 可按矿脉批量采集');
  }
  if (autoEatPlugin) {
    state.bot.loadPlugin(autoEatPlugin);
    console.log('[plugins] mineflayer-auto-eat 已装配');
  }
  if (!toolPlugin && !collectBlockPlugin && !autoEatPlugin) {
    console.warn('[plugins] 三个反射插件都没装 —— 她不会自动吃、不会自动换工具。'
      + '装法：在 skill 目录 npm install mineflayer-auto-eat mineflayer-tool mineflayer-collectblock');
  }

  state.bot.once('spawn', () => {
    state.connected = true;
    state.retries = 0;
    lastHealth = state.bot.health ?? null;
    const mv = new Movements(state.bot);

    // ⚠️ mineflayer-pathfinder 的默认值对"陪玩"来说是灾难性的：
    //   canDig = true          → 寻路时会**拆掉挡路的方块**抄近路
    //   allow1by1towers = true → 会自己垫方块往上爬
    //   scafoldingBlocks       → 还会消耗玩家的泥土/圆石
    // 表现就是：她跟着玩家走，一路把玩家的房子拆了。
    //
    // ⚠️ 2026-09-25 起 **canDig 默认关闭**（`pathing.js` 的 `ALLOW_DIG`，
    //    由 config.json 的 `MC_ALLOW_DIG` 控制）。用户明确要求：
    //    「寻路器暂时不要挖东西，这个以后我们要通过 jev 去判断行动」。
    //
    //    上一版是"抬高 digCost 让它很贵但可行"，理由是"一刀切禁挖会把最后手段也砍掉、
    //    No path 变多"。但那条设计在**模组服上有实测破口**：blocksCantBreak 那一层按
    //    **名字模式**匹配，而模组装饰方块名（`cluttered:antique_mini_table`、
    //    `ultramarine:medium_white_porcelain_vase_bonsai`）一个模式都不中 ——
    //    于是"最后手段"变成了"顺手拆掉玩家的装饰"。实测被拆过两格。
    //    名字是开集，穷举必漏；所以默认收紧成**只绕不拆**。
    //
    //    绕不过去时直接 `No path`，这是**预期行为**，不是退化。
    //    要恢复旧行为：`MC_ALLOW_DIG=true`。将来由 JEV 判定"这一趟该不该挖"时，
    //    走 `applyPolicy(mv, names, { allowDig: true })` 单次放行。
    // 想砍树/挖矿请走 POST /mine —— 那条路径不经过寻路器，**不受本开关影响**。
    const pfSummary = pathing.applyPolicy(mv, state.bot.registry?.blocksByName, {
      // ⚠️ 必须**显式传**，不能指望 pathing.js 自己去读 config.json：
      //    `pathing.js` 读的是 `process.env.MC_ALLOW_DIG`，而本文件的 `loadFileConfig()`
      //    只是把 config.json 解析成 `FILE_CFG`，**从不写 process.env** ——
      //    不传的话 config.json 里那一行会被静默忽略（默认值恰好也是 false，
      //    所以现象上"看不出错"，只有哪天把它改成 true 才会发现没生效）。
      //    走 `cfg()` 拿值，优先级就是文档写的那条：环境变量 > config.json > 默认。
      allowDig: cfg('MC_ALLOW_DIG', 'false') === 'true',
    });
    state.pfPolicy = pfSummary;
    // 名字到底可不可信？模组服上名字可能整体偏移，那时硬禁那一层就形同虚设。
    // 把这个变成可观测事实，而不是一个假设。
    state.pfProbe = pathing.summarizeProbe(pathing.probeRegistry(state.bot.registry));

    // 梯子：两层（`prismarine-physics` 的 isOnLadder / pathfinder 的 climbables）判的都是
    // **`block.type`（方块注册表 id）**，不是 stateId。
    // ⚠️ **原版梯子就是 196，本来就爬得上去** —— 2026-09-23 实测服务端 1003 个原版方块
    //    id 与原版零差异，所以这里默认**不该做任何事**。之前那版注释说"真实梯子是 215、
    //    于是恒为 false"是**错的**（详见 fixLadderIdBeforeConnect 的注释）。
    // 只有当确实存在一个**非原版**梯子时才配，二选一：
    //    MC_CLIMBABLE_BLOCK_NAME=create:ladder   ← 推荐，走服务端快照，模组方块也精确
    //    MC_CLIMBABLE_STATE_IDS=522772           ← 按 state 记，只在原版方块上可信
    // 两个都空时这里什么都不做，那是**正确的默认**。
    // 注意要传**整个 registry** —— 模组方块在原版表里查不到，得走 state ID 补丁那一层。
    const climbStateIds = pathing.parseIdList(cfg('MC_CLIMBABLE_STATE_IDS', ''));
    // 名字路线解析出的方块 id —— **可能多个**（本包有 32 种梯子，Quark 一家就 14 种
    // 木材变体）。寻路层全认；⚠️ 物理层只有 `installLadderFix` 选中的那一个能真爬，
    // 因为 `prismarine-physics` 读的是 `blocksByName.ladder.id` 这**一个数字**。
    const climbBlockIds = state.pfLadderFix?.resolvedFromNames ?? [];
    state.pfClimb = pathing.applyClimbables(mv, state.bot.registry, climbStateIds, {
      blockIds: climbBlockIds,
    });
    // 基准 id 用**首次修正前**那个（`state.pfLadderFix.baseline`）—— 注册表已经被改过了
    // 而且是版本单例、改动会粘住；若按"当前值"当基准，`vanillaPathWouldWork` 会翻成 true，
    // 把"库原本写死的是几"这个事实抹掉。
    state.pfClimbProbe = pathing.probeClimbables(state.bot.registry, climbStateIds, {
      baselineLadderId: state.pfLadderFix?.baseline ?? state.pfLadderFix?.before ?? undefined,
    });

    // ⚠️ 未映射方块必须当实心 —— 否则她会撞上"客户端看不见的墙"。
    //    模组方块在原版注册表里查不到，`prismarine-block` 走 else 分支给出
    //    `shapes=[]` / `boundingBox='empty'`，于是客户端以为能走进去，
    //    服务端照自己的碰撞把她推回来 → 原地抖动、位移≈0、连 jump 都不动。
    //    实测踩过一次：玩家 F3 显示她面前是 `cluttered:ancient_codex`（stateId 506813），
    //    我们这边读 `solid:false`，卡了很久。
    //    一处补丁（`world.getBlock`）同时纠正物理层、寻路层与 `GET /block`。
    //    第三个参数是**运行时白名单**：她自己打开的门/活板门，实测穿得过去之后记进来。
    //    这个 Set 在 `state` 里创建，只增删不替换（补丁按引用读它）。
    //
    // ⚠️ 但"一律当实心"会误伤**薄方块**（2026-09-25 实测）：调色板只给名字和属性、
    //    不给碰撞形状，所以"踏板"和"墙"在数据上长得一模一样 —— 厨房唯一出口前那格
    //    `autumnity:maple_pressure_plate` 被补成立方体，她纯走 2000ms 只前进 0.2 格
    //    就撞停（玩家当场指出：「踏板为什么要跳，直接走」）。
    //    现在补丁多一条分支：名字像薄方块的（踏板/地毯/按钮/花/铁轨/告示牌…，
    //    见 `pathing.isThinBlockName`）**不再补立方体**，保持 `shapes=[]`。
    //    ⚠️ 梯子/活板门/台阶/楼梯**故意不在**薄方块名单里（理由见 pathing.js 那段注释）。
    state.pfUnknown = pathing.applyUnknownBlockPolicy(state.bot.world, {
      runtimePassable: state.passableStateIdsRuntime,
      // 名字解析器。它**按引用读 state.palette**，所以之后才导入的调色板也立刻生效，
      // 不必重连、也不必重装补丁。查不到就返回 null，实心策略不受影响。
      // ⚠️ 它只是**兜底**：调色板一旦注入注册表，`b.name` 就是注册表给的权威名字，
      //    补丁里只在 `!b.name` 时才用这个旁路解析器（别用次一级来源覆盖权威值）。
      nameOf: resolveBlockName,
    });

    // 调色板已经在 inject_allowed 阶段写入**本次连接自己的** bot.registry；
    // 这里仅核对结果，绝不在 spawn 才首次注入。spawn 后再写会让 physics 先看到
    // 缺少 shapes 的记录，正是之前导致进程崩溃的时序错误。
    if (state.palette) {
      if (!state.paletteInject?.ok || !state.paletteInject?.botRegistry) {
        console.error('[palette] spawn 时发现本次 bot.registry 没有完成调色板注入；'
          + '已拒绝把半成品交给 physics');
      } else {
        console.log(`[palette] 本次 bot.registry 已就绪：${state.paletteInject.overlayBlocks} 个原版 overlay / `
          + `${state.paletteInject.blocks} 个模组方块 / ${state.paletteInject.states} 个模组 state`);
      }
    } else {
      console.log('[palette] 没有调色板 —— 模组方块的 b.type 会是 undefined、名字是空串；'
        + '梯子配置因此也不会生效（碰撞已由实心策略兜住）。'
        + '导入办法见 GET /palette 的 hint。');
    }

    state.bot.pathfinder.setMovements(mv);

    // ---- collectblock / auto-eat 的运行时配置 ------------------------------------
    // ⚠️ `mineflayer-collectblock` 装上后会**自己 new 一份 Movements**，
    //    不复用我们 setMovements 传进去的那份。所以 applyPolicy 那套（canDig=false、
    //    blocksCantBreak 白名单）对它**完全不生效** —— 它是独立的一只脚。
    //    这里显式把我们的策略灌进它那份，否则 /mine 会绕过"只绕不拆"的护栏。
    //
    //    抄的是 HiyoriAI 的 protectMovementsFromFluid 思路：把流体风险编码进 A* 代价，
    //    而不是"要么全禁挖、要么全放开"。
    if (state.bot.collectBlock?.movements) {
      const cbMv = state.bot.collectBlock.movements;
      try {
        pathing.applyPolicy(cbMv, state.bot.registry?.blocksByName, {
          allowDig: cfg('MC_ALLOW_DIG', 'false') === 'true',
        });
        // 流体安全：评估"挖掉这一格会不会把水/岩浆引过来"，会的话给 100 的代价。
        // 判据是"六邻域有液体"或"正上方 32 格内有一列液体、中间全是可流通的方块"
        // —— 后者覆盖了"水柱下面是空气、还没变成流动水"的服务端更新窗口。
        // 这正是上次摘柠檬溺水那类事故的正面防御。
        state.pfCollectFluid = pathing.injectFluidBreakGuard(state.bot, cbMv);
        console.log(`[pathing] collectblock 已套用同一套策略：canDig=${cbMv.canDig}`
          + `，流体防护=${state.pfCollectFluid.applied ? '已启用' : `未启用（${state.pfCollectFluid.reason}）`}`);
      } catch (e) {
        state.pfCollectFluid = { applied: false, reason: e.message };
        console.warn(`[pathing] collectblock 策略套用失败（不影响主寻路）：${e.message}`);
      }
    }

    // ---- auto-eat -------------------------------------------------------------
    // 阈值取自 HiyoriAI（`minHunger: 16`）—— 比"快饿死了才吃"提前得多，
    // 因为饥饿值低于 6 就不能疾跑、也不能自然回血，陪玩时这两件事都要保证。
    //
    // ⚠️ `offhand` 保持默认 false：她只有主手，自动吃**会**换掉手上的镐子，
    //    但 auto-eat 自己会在吃完后换回来（5.x 的行为）。
    //    真正的问题是"正在挖矿时被换走工具导致挖得更慢"—— 那个用 eating 开关控制，
    //    见 autopilot 的 MC_EAT_ENABLE 与 /eat 端点。
    if (state.bot.autoEat) {
      try {
        const wantMinHunger = parseInt(cfg('MC_AUTO_EAT_MIN_HUNGER', '16'), 10);
        state.bot.autoEat.setOpts({
          minHunger: wantMinHunger,
          strictErrors: false,
        });
        const enabled = cfg('MC_AUTO_EAT', 'true') === 'true';
        if (enabled) state.bot.autoEat.enableAuto();

        // ⚠️ 字段名是 `opts`，**不是** `options`（这个坑记录在 field-log 的 P6）。
        //    5.0.3 的实现是 `class EatUtil { opts; setOpts(o){ Object.assign(this.opts, o) } }`，
        //    读 `options` 恒为 undefined → JSON 里成 `null` → 看起来像"阈值没设上"，
        //    实际是"我读错了地方"。区分"读不到"与"没设置"是 P4 的同一条教训。
        const opts = state.bot.autoEat.opts ?? {};
        state.pfAutoEat = {
          available: true,
          enabled,
          // 真实读回的值 + 我们下发的目标值，两者都报，不一致就能一眼看出
          minHunger: opts.minHunger ?? null,
          minHungerWanted: wantMinHunger,
          // 这两个是 5.0.3 的默认值，对"持续发育"有实际影响，一并暴露：
          //   minHealth=14 —— 血量低于 14 也会触发吃（不是只看饥饿）
          //   bannedFood  —— 腐肉/河豚/蜘蛛眼等一律不吃
          minHealth: opts.minHealth ?? null,
          returnToLastItem: opts.returnToLastItem ?? null,
          bannedFood: Array.isArray(opts.bannedFood) ? opts.bannedFood : null,
        };
        console.log(`[plugins] auto-eat：${enabled ? '已开启' : '已装但关闭（MC_AUTO_EAT=false）'}`
          + `，阈值 minHunger=${state.pfAutoEat.minHunger}（目标 ${wantMinHunger}）`
          + `，minHealth=${state.pfAutoEat.minHealth}`);
      } catch (e) {
        state.pfAutoEat = { available: true, enabled: false, error: e.message };
        console.warn(`[plugins] auto-eat 配置失败：${e.message}`);
      }
    } else {
      state.pfAutoEat = { available: false, enabled: false };
    }
    state.movements = mv; // 供 GET /config 自检"她到底会不会拆方块"
    console.log(`[pathing] canDig=${pfSummary.canDig}（allowDig=${pfSummary.allowDig}）`
      + ` digCost=${pfSummary.digCost} `
      + `placeCost=${pfSummary.placeCost} liquidCost=${pfSummary.liquidCost} `
      + `受保护方块=${pfSummary.protectedCount} 个；注册表往返自检 `
      + `${state.pfProbe.ok}/${state.pfProbe.checked} 对上`
      + (pfSummary.canDig ? '；⚠️ 允许挖掘' : '；只绕不拆（POST /mine 不受影响）')
      + (state.pfProbe.mismatched.length ? `（对不上：${state.pfProbe.mismatched.join(', ')}）` : ''));
    console.log(`[pathing] 可攀爬方块：配置 stateId=[${climbStateIds.join(', ')}] `
      + `→ 新增方块 ID [${state.pfClimb.addedBlockIds.join(', ')}]；`
      + `库里写死的原版梯子 ID=${state.pfClimbProbe.vanillaLadderId}，`
      + `原版那套认得出这包里的梯子吗=${state.pfClimbProbe.vanillaPathWouldWork}`
      + (state.pfClimbProbe.libraryLadderId !== state.pfClimbProbe.vanillaLadderId
        ? `；修正后库里在用的 ID=${state.pfClimbProbe.libraryLadderId}，现在认得出吗=${state.pfClimbProbe.libraryPathWouldWork}`
        : '')
      + (state.pfClimb.unmappedStateIds.length ? `（原版表里查不到、走 state ID 补丁：${state.pfClimb.unmappedStateIds.join(', ')}）` : ''));
    console.log(`[pathing] 未映射方块策略：${state.pfUnknown.patched
      ? '按实心处理（boundingBox=block + 完整碰撞箱）'
      : `未启用（${state.pfUnknown.skipped}）`}`
      + (state.pfUnknown.patched
        ? (state.pfUnknown.thinPassable
            ? '；薄方块（踏板/地毯/按钮/花…）按名字豁免，不补立方体'
            : '；⚠️ 薄方块豁免已关闭（MC_THIN_BLOCK_PASSABLE=false）')
        : '')
      + (state.pfUnknown.passableStateIds.length ? `；可穿过白名单 stateId=[${state.pfUnknown.passableStateIds.join(', ')}]` : '')
      + (state.pfUnknown.nameResolver ? `；名字解析器已接（调色板${state.palette ? `已加载，${state.paletteMeta.entries} 个方块` : '未加载'}）` : '；没有名字解析器'));

    // 审计每一次挖方块。寻路器拆方块走的是 bot.dig，所以包一层就能抓到
    // "不是挖掘任务、却把方块拆了"的情况 —— 这正是玩家房子被拆那次没留痕的原因。
    const _dig = state.bot.dig.bind(state.bot);
    state.bot.dig = async function (block, ...rest) {
      try {
        const name = block?.name;
        const pos = block?.position;
        if (name) {
          const posStr = pos ? `${pos.x},${pos.y},${pos.z}` : '?';
          console.log(`[dig] ${name} @ ${posStr}`);
          if (!/^mining\b/.test(state.currentAction || '')) {
            journal('dig', `⚠️ 非挖掘动作中拆掉了 ${name} @ ${posStr}（当前动作：${state.currentAction || '无'}）`);
          }
        }
      } catch (_) { /* 审计失败不能影响正常挖掘 */ }
      return _dig(block, ...rest);
    };

    console.log(`[bridge] Bot online @ ${JSON.stringify(botPos())}`);
    journal('spawn', `我上线了，位置 ${JSON.stringify(botPos())}，血量 ${state.bot.health ?? '?'}`);
    saveState();

    // ---- 寻路目标的变更轨迹（P25 排查用，见 state.__goalTrace 的说明）--------
    //
    // ⚠️ 这里**必须**在 pathfinder 插件装配之后注册，且**早于**任何 goto 调用 ——
    //    否则会漏掉最开始那几次（而那几次往往正是出问题的时候）。
    //    注册在 spawn 回调里刚好：插件在 createBot 期间就已 loadPlugin，
    //    而所有业务动作都发生在 spawn 之后。
    state.bot.on('goal_updated', (goal, dynamic) => {
      // ⚠️⚠️ 2026-09-25 二次修正（P26）：**第一版的 who 字段是废的。**
      // 第一版写的是"取栈里第一帧不含 node_modules 的行"，实测输出恒为
      // `EventEmitter.<anonymous>` —— 也就是说**它从来没有定位到过真正的调用者**。
      // 两个错都在这一行里：
      //   ① `EventEmitter.<anonymous>` 这一帧确实不含字符串 node_modules（它在 emitter
      //      内部却顶着业务层的文件名），于是被当成"我们自己的代码"选中了；
      //   ② `.replace(/\(.*\)$/, '')` 会把 `(file:line:col)` **整段删掉** —— 包括行号。
      //      也就是说：即使选中了对的帧，行号也已经被我亲手扔了。
      // 观测面本身在骗人时，**先修观测面**，不要基于它下结论（P25 的教训）。
      // 现在改成：跳过 EventEmitter 帧，保留完整 `file:line:col`。
      let who = 'unknown';
      let whoFrame = null;
      try {
        const stack = new Error().stack.split('\n').slice(1);
        const frames = stack.map(l => l.trim().replace(/^at\s+/, ''));
        // 优先：第一帧既不含 node_modules、也不含 EventEmitter —— 那才是"我们自己"。
        const own = frames.find(
          l => !l.includes('node_modules') && !l.includes('EventEmitter') && !l.includes('emit'),
        );
        whoFrame = own || frames.find(l => !l.includes('node_modules')) || frames[0] || null;
        // 保留完整帧（含行号），只把绝对路径前缀裁短，便于肉眼读。
        who = whoFrame
          ? whoFrame.replace(/^.*[\\/]([^\\/]+:\d+:\d+\)?)$/s, '$1')
          : 'no frame';
      } catch (_) {}
      state.__goalTrace.push({
        at: Date.now(),
        goal: goal ? (goal.constructor?.name || 'Goal?') : null,
        dynamic: !!dynamic,
        who,
        // 保留最多 4 帧原始信息 —— 定位"谁改的"时常常需要看整条链，单帧不够。
        stack: (() => {
          try {
            return new Error().stack.split('\n').slice(2, 7).map(l => l.trim()).join(' | ');
          } catch (_) { return null; }
        })(),
      });
      if (state.__goalTrace.length > state.__goalTraceMax) state.__goalTrace.shift();
    });
  });

  state.bot.on('error', err => {
    console.error('[bridge] Bot error:', err.message);
  });

  // 记录所有进入聊天框的文本（玩家发言、系统消息、命令回显）
  state.bot.on('message', (jsonMsg, position) => {
    let text;
    try {
      text = jsonMsg.toString();
    } catch (_) {
      return;
    }
    if (!text) return;
    // 1.20.1 起 position 可能是字符串（'chat' | 'system' | 'game_info'）
    const pos = typeof position === 'string' ? position : (position ?? null);
    pushChat(text, pos);

    // 记忆：玩家发言和我自己说过的话全记；系统消息只挑值得记的，避免灌噪声
    if (pos === 'chat') {
      journal('chat', text);
    } else if (/(joined the game|left the game|completed the challenge|was slain|was shot|drowned|blew up|fell from|burned to death|tried to swim in lava|withered away|starved to death|hit the ground too hard)/i.test(text)) {
      journal('event', text);
    }
  });

  // 玩家进出：既进聊天流，也进记忆
  state.bot.on('playerJoined', p => {
    pushChat(`* ${p.username} 加入了游戏`, 'bridge');
    journal('player-join', `${p.username} 上线了`);
  });
  state.bot.on('playerLeft', p => {
    pushChat(`* ${p.username} 离开了游戏`, 'bridge');
    journal('player-leave', `${p.username} 下线了`);
  });

  // 死亡 / 重生 / 受伤：这些是"发生过什么"里最该记住的
  state.bot.on('death', () => {
    journal('death', `我死掉了…死在 ${JSON.stringify(botPos())}`);
  });
  state.bot.on('respawn', () => {
    journal('respawn', `我重生了，位置 ${JSON.stringify(botPos())}`);
  });
  state.bot.on('health', () => {
    const h = state.bot.health;
    if (h === null || h === undefined) return;
    if (lastHealth !== null && h < lastHealth - 2) {
      journal('hurt', `掉血了 ${lastHealth} → ${h}（位置 ${JSON.stringify(botPos())}）`);
    }
    lastHealth = h;
  });

  state.bot.on('end', reason => {
    state.connected = false;
    state.currentAction = null;
    lastHealth = null;
    journal('disconnect', `我掉线了（${reason}）`);
    saveState();
    console.log(`[bridge] Bot disconnected (${reason}), retrying in ${CFG.bridge.reconnectMs / 1000}s...`);
    if (state.retries < CFG.bridge.maxRetries) {
      state.retries++;
      setTimeout(createBot, CFG.bridge.reconnectMs);
    } else {
      // ⚠️ 这里**不再自动重试**了（30 次 × 5s ≈ 2.5 分钟），但进程和 HTTP API 都还活着 ——
      //    服务端要是几小时后才起来，她不会自己回去。所以记下"放弃了"，并留 `POST /reconnect`
      //    这个显式开关：既不无限空转烧 CPU，也不用去手动重启整个网桥。
      state.gaveUpReconnecting = true;
      console.error(`[bridge] Too many reconnect attempts (${CFG.bridge.maxRetries}). `
        + '服务端恢复后调 POST /reconnect 即可（不用重启网桥）。');
    }
  });

  state.bot.on('kicked', reason => {
    console.warn('[bridge] Bot kicked:', reason);
  });
}

function botPos() {
  const p = state.bot?.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

/**
 * 精确位置（保留两位小数）。
 *
 * 为什么不能复用 `botPos()`：那个是**取整**的，因为多数端点只关心"她在哪个格子"。
 * 但原始控制层要回答的是"按了这一下，她到底动没动" —— 走半格会被取整成 0，
 * 于是"没动"和"动了半格"分不开，闭环就白做了。
 */
function botPosExact() {
  const p = state.bot?.entity?.position;
  if (!p) return null;
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
}

function requireConnected(res) {
  if (!state.connected || !state.bot) {
    json(res, 503, {
      error: 'Bot not connected',
      hint: 'Open Minecraft and check MC_HOST/MC_PORT',
      // 离线时能读的：全都是本地文件/内存表，不需要游戏在跑
      offlineOk: [
        'GET /status', 'GET /config', 'GET /memory', 'GET /state',
        'GET /knowledge', 'GET /knowledge/search', 'POST /knowledge/search',
        'GET /palette', 'GET /palette/state', 'GET /palette/block', 'GET /palette/climbable',
        'POST /registry/import-palette', 'GET /debug/registries', 'GET /debug/registry',
        'GET /debug/pathfinder',
        // 物品注册表：本地快照 + 内存里的注入报告
        'GET /item',
      ],
    });
    return false;
  }
  return true;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 极简延时。`/jump` 要分段按跳跃键，需要它。 */
function sleep (ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 寻路过程日志。**默认开**，用 `MC_PATH_DEBUG=false` 关掉。
 *
 * 为什么默认开：P9（超时被无限续期）实机卡了 340 秒，而日志里
 * **一个字都没有** —— 因为我当时只在"出错时"打日志，而"卡住"不是错误，
 * 它是一个**没有事件发生的状态**。这类问题的可观测性必须靠**心跳式打点**，
 * 不能靠"出事了再打"。
 *
 * 代价：每次 goto 会多几行（每 5 秒一次采样 + 开始/结束各一行）。
 * 对"她到底在干什么"这个问题的价值，远大于这点日志量。
 */
const DBG_PATH = cfg('MC_PATH_DEBUG', 'true') !== 'false';
function DBG (msg) {
  if (DBG_PATH) console.log(msg);
}

/**
 * 给一个 promise 套超时。
 *
 * ⚠️⚠️⚠️ 2026-09-25 实战（P25）：**这个函数绝对不能碰 `setGoal`。**
 *
 * 我第一版在这里加了个"超时时顺手清 pathfinder"的清理：
 *
 * ```js
 * new Promise((_, rej) => setTimeout(() => {
 *   cleanup();                                // stop() + setGoal(null)
 *   rej(new Error('Action timed out'));
 * }, ms)),
 * ```
 *
 * 看起来是在解决"残留 goal 让下一个 goto 抛 GoalChanged"，
 * **实际上它自己制造了这个错误**，而且是更严重的一版：
 *
 * ```
 * goto(goalA) 的 promise 还在等
 *   ↓ withTimeout 的定时器到点
 *   ↓ cleanup() → setGoal(null) → emit goal_updated(null)
 *   ↓ goto(goalA) 的 goalChangedListener 收到 null
 *   ↓ null !== goalA → 立刻 cleanup(error('GoalChanged', ...))
 *   ↓ 下一个 goto(goalB) 刚注册好 listener，可能又接到遗留的 null → 又抛
 * ```
 *
 * 实测症状：地上 4 个掉落物、距离 **1.4 格**（走一步就能捡），
 * `goto` 在 **0ms 内**失败，报 "The goal was changed before it could be completed!"。
 * `POST /mine` 挖了 5 块泥土，**一块都没进背包**。
 *
 * 根因是**时机**，不是"该不该清"：
 *   · ❌ 在一次 goto **结束之后**清 → 那一下会打到"下一个已经在等的 goto"
 *   · ✅ 在发起一次 goto **之前**清 → 此时没有任何 listener 在等，安全
 *
 * 所以清理的职责被移交给调用方（`pathing.clearPathfinderGoal`），
 * 它应该在循环的**开头**调，本函数只负责"到点就报错"，不做任何副作用。
 *
 * 这条约束有回归锁：`pathing.js` 自测第 7 段断言 `withTimeout` 不持有 pathfinder。
 *
 * @param {Promise} promise
 * @param {number} [ms]
 */
function withTimeout(promise, ms = CFG.bridge.actionTimeout) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Action timed out')), ms)),
  ]);
}

/**
 * 带"按路径推导的超时 + 停滞检测"的 goto。
 *
 * 为什么需要统一入口：`/move`、`/mine`、`/collect`、`/follow` 全都要走到"把她挪到
 * 某个地方"这件事。每个端点各写一遍超时逻辑，早晚会有三份不一样的数字。
 *
 * 这一层解决的是**一次 goto 内部**的两个问题（对标 HiyoriAI 的 `patchedGoto.ts`）：
 *   ① `bot.pathfinder.goto()` 自己不设超时，可能永远挂着
 *   ② 固定超时看不出她"还在动"还是"已经卡住"
 *
 * ⚠️ 与 autopilot 的 `stuckTicks` 是**两层**，不是重复：
 *    那一层看跨动作的位置不动（"整段行为卡死"），这一层看单次路径的进展。
 *    反例：goto 每次都在超时被砍然后重发，位置有抖动 → `stuckTicks` 永不触发，
 *    但这件事永远做不成。这一层能抓住（路径没在缩短）。
 *
 * @param {object} state  桥的内部状态（要 `bot`）
 * @param {object} goal   pathfinder 的 Goal 实例
 * @param {object} [opts] { label, onStop }
 * @returns {Promise<{etaMs:number|null, timeoutMs:number, replans:number, checks:number}>}
 */
async function gotoWithBudget (state, goal, opts = {}) {
  const budget = { timeoutMs: pathing.PATH_MIN_TIMEOUT_MS, etaMs: null };
  let replans = 0;

  const onPathUpdate = (e) => {
    try {
      const est = pathing.estimatePathTimeMs(e?.path);
      const t = pathing.computeTimeoutFromEta(est);
      if (t.etaMs !== null) {
        budget.timeoutMs = t.timeoutMs;
        budget.etaMs = t.etaMs;
        replans++;
      }
    } catch (_) { /* 估时失败不该影响移动本身 */ }
  };

  const origin = state.bot.entity?.position;
  const monitor = origin
    ? pathing.createStagnationMonitor({ x: origin.x, y: origin.y, z: origin.z })
    : null;

  let stagnationTimer = null;
  let watchdog = null;
  let lastBudget = budget.timeoutMs;
  let limit = Date.now() + budget.timeoutMs;
  let settled = false;
  let rejectOuter = null;

  // ⚠️⚠️⚠️ 绝对上限 —— 这是 P9 的修复（2026-09-25 实战抓出来的）。
  //
  // 症状：`POST /mine {count:1}` 跑了 **150 秒**不返回，
  //       而 `PATH_MIN_TIMEOUT_MS = 30000`（30 秒）本该早就放弃。
  //
  // 根因：watchdog 的续期判据是"`budget.timeoutMs` 比上次大就续期"。
  //       而 `onPathUpdate` 在每次 `path_update` 事件里都会**重新估算**路径耗时 ——
  //       `estimatePathTimeMs` 对"看起来更长"的路径给更大的值。
  //       于是每来一次事件，预算就涨一点，watchdog 就续一次期 → **永远不到期**。
  //
  //       `path_update` 在"路径反复重规划"时触发得很频繁（正是我们卡住的时候），
  //       所以这个 bug 只在**真的卡住时**发作 —— 平时完全看不出来。
  //
  // 修法：续期可以有，但**不得超过一个绝对上限**。
  // 为什么还要保留续期：远距离路径的合理等待确实该随距离增长，
  // 一刀切成固定值会误砍正常的长途移动。
  // 为什么上限要存在：**任何"等待"都必须有尽头**。
  // 一个能无限续期的超时，等于没有超时 —— 这正是它在实机上表现出的样子。
  //
  // 上限的算法放在 `pathing.computeHardCap` —— 它不是"一个数字"，
  // 而是"初始预算 + 库上限"的组合规则，值得被自测锁住（见 pathing 的自测）。
  const cap = pathing.computeHardCap(budget.timeoutMs);
  const ABSOLUTE_MAX_MS = cap.hardCapMs;
  const absoluteDeadline = Date.now() + ABSOLUTE_MAX_MS;
  let renewals = 0;

  const trip = (err) => {
    if (settled) return;
    settled = true;
    try { state.bot.pathfinder.stop(); } catch (_) {}
    if (rejectOuter) rejectOuter(err);
  };

  state.bot.on('path_update', onPathUpdate);
  try {
    if (monitor) {
      stagnationTimer = setInterval(() => {
        const v = monitor.sample(state.bot.entity?.position);
        // ⚠️ 打点：P9 的复盘里最缺的就是"停滞检测到底跑了没有"。
        //    没有这行日志，我只能看到"卡了 340 秒"，看不到"检测器在不在工作"。
        DBG(`[goto] ${opts.label || ''} sample #${v.checks} moved=${v.moved} stagnant=${v.stagnant} exhausted=${v.exhausted}`);
        if (v.exhausted) {
          clearInterval(stagnationTimer);
          stagnationTimer = null;
          DBG(`[goto] ${opts.label || ''} → 停滞判定，放弃（moved=${v.moved}）`);
          trip(new Error(
            `Stuck${opts.label ? ` (${opts.label})` : ''}: no meaningful progress for `
            + `${v.stagnant} checks (~${(v.stagnant * pathing.PATH_PROGRESS_INTERVAL_MS) / 1000}s, `
            + `${v.moved} blocks since last check)`,
          ));
        }
      }, pathing.PATH_PROGRESS_INTERVAL_MS);
    } else {
      DBG(`[goto] ${opts.label || ''} ⚠️ 没有 monitor（拿不到起点位置）→ 停滞检测不生效`);
    }

    watchdog = setInterval(() => {
      // ① **绝对上限优先**：无论预算怎么涨，到这里就必须结束。
      //    这一条是 P9 的核心 —— 它保证"卡住"一定有尽头。
      if (Date.now() >= absoluteDeadline) {
        clearInterval(watchdog);
        watchdog = null;
        DBG(`[goto] ${opts.label || ''} → 硬上限 ${ABSOLUTE_MAX_MS}ms 到，放弃（续期 ${renewals} 次）`);
        trip(new Error(
          `Timeout${opts.label ? ` (${opts.label})` : ''}: hit hard cap ${ABSOLUTE_MAX_MS}ms `
          + `(budget renewed ${renewals} times, last budget ${budget.timeoutMs}ms, eta ${budget.etaMs ?? '?'}ms)`,
        ));
        return;
      }
      // ② 续期：预算涨了就延长，但受 ① 约束。
      if (budget.timeoutMs > lastBudget) {
        lastBudget = budget.timeoutMs;
        renewals++;
        limit = Math.min(Date.now() + budget.timeoutMs, absoluteDeadline);
        DBG(`[goto] ${opts.label || ''} 续期 #${renewals} → budget=${budget.timeoutMs}ms eta=${budget.etaMs}ms`);
        return;
      }
      if (Date.now() >= limit) {
        clearInterval(watchdog);
        watchdog = null;
        DBG(`[goto] ${opts.label || ''} → 预算超时 ${budget.timeoutMs}ms，放弃`);
        trip(new Error(
          `Timeout${opts.label ? ` (${opts.label})` : ''}: exceeded ${budget.timeoutMs}ms `
          + `(eta ${budget.etaMs ?? '?'}ms, renewals ${renewals})`,
        ));
      }
    }, Math.max(1000, Math.floor(pathing.PATH_PROGRESS_INTERVAL_MS / 2)));

    DBG(`[goto] ${opts.label || ''} 开始：budget=${budget.timeoutMs}ms hardCap=${ABSOLUTE_MAX_MS}ms`);
    await new Promise((resolve, reject) => {
      rejectOuter = reject;
      Promise.resolve(state.bot.pathfinder.goto(goal)).then(resolve, reject);
    });
    DBG(`[goto] ${opts.label || ''} 成功到达（续期 ${renewals} 次）`);
  } catch (e) {
    DBG(`[goto] ${opts.label || ''} 结束：${e.message}`);
    throw e;
  } finally {
    settled = true;
    if (stagnationTimer) clearInterval(stagnationTimer);
    if (watchdog) clearInterval(watchdog);
    state.bot.removeListener('path_update', onPathUpdate);
  }

  return {
    etaMs: budget.etaMs,
    timeoutMs: budget.timeoutMs,
    replans,
    renewals,          // 续期了几次 —— 这个数字大就说明"她在原地反复重规划"
    hardCapMs: ABSOLUTE_MAX_MS,
    checks: monitor ? monitor.snapshot().checks : 0,
  };
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

/**
 * 判断一个实体是不是**掉落物**。
 *
 * ## 为什么不用 `entity.objectType`
 *
 * `prismarine-entity` 里 `objectType` 是个 **getter，实现就是 `return this.displayName`**，
 * 而且每次读取都会 `console.trace()` 打一坨废弃警告（见该库 index.js 的 `printObjectTypeWarning`）。
 *
 * 这不只是噪音问题：`/nearby` 和 `/pickup` 是**打怪/采集时高频调用**的端点，
 * 每次调用打一次堆栈会把日志冲烂、拖慢 I/O —— 而"提高感知速度"正是这一轮的硬要求。
 *
 * 所以直接用 `displayName`，并保留 `name` 作为兜底 ——
 * 因为 `prismarine-entity` 自己的 `getDroppedItem()` 认的是
 * `name ∈ {item, Item, item_stack}`，两个字段在不同路径下会有一个是空的。
 */
// 站位判据（`reachableStandY` / `findStandY` / `isStandable` / `DEADLY`）在 `place.js` —— 唯一一份，
// 自测也在那里（原来 autopilot.js 的自测测的是这里的一份手抄副本，不是跑的这份）。

/**
 * "这一格算不算空的/可穿过的" —— **不再另写一份，直接用 `place.js` 的 `AIRY`。**
 *
 * ⚠️⚠️ P40/P41 的教训（**同型第四次**）：我一开始在这里新建了一个 `AIRY_NAMES`，
 *    因为看到 `/shelter` 里硬编码的 `airy` 数组"看着不对"。但 `place.js` 顶部
 *    早就有 `const AIRY = /^(air|cave_air|void_air|water|flowing_water|lava|...)$/`
 *    —— **再加一份就是同一判据的第四处副本**，正是 P39 说的"写两处一定漂移"。
 *    README 里那句 P14（"修一个反模式先 grep 全仓"）在这里**又**差点被违反。
 *
 * 注意 `place.js` 的 `AIRY` 用的是**正则**，而且它把 `lava` 也算"空气"
 * （那是"能不能当参照物"的语义，不是"能不能站"的语义）。
 * 两个语义**不同**，所以这里明确区分：
 *   · `isAiryForPlace` = 能不能往里放方块（= 参照物判定，`place.js` 的语义）
 *   · `isStandable`   = 她能不能站进去 / 能不能从这格走出去（**不含岩浆**）
 */
function isAiryForPlace (block) {
  return !!block && placeLogic.AIRY.test(block.name || '');
}

function isDropEntity (e) {
  if (!e || !e.position) return false;
  const byDisplay = e.displayName === 'Item' || e.displayName === 'item';
  const byName = e.name === 'item' || e.name === 'Item' || e.name === 'item_stack';
  return byDisplay || byName;
}

/**
 * 背包快照 —— 用来回答"这件事做完之后，**世界真的变了吗**"。
 *
 * ## 为什么需要（P32，2026-09-25 实机抓出）
 *
 * 客户端**没有"拾取成功"事件**，所以"捡到了几个"只能靠自己前后对比背包。
 * 这个道理 `/pickup` 的注释里早就写了，但**从来没实现** —— 于是那个端点
 * 只能返回 `walkedTo`（走到了几个），而"走到了"和"捡到了"是两件事。
 *
 * `walkedTo: 3` + 背包为空 → autopilot 看到 `ok: true` → 不退避 → 无限循环。
 * 一个动作谎报成功，会让**所有**基于它返回值的上层机制失效（退避、重试上限、
 * 任务放弃计数）。所以证据必须在**看得见真相的那一侧**产生（P20/P21/P29 的同一条原则）。
 *
 * ## 口径
 *
 * 按 `(name, count)` 记，`total` 是**总件数**（不是物品种类数）——
 * "多了 1 件泥土"和"多了一格泥土（64 件）"是两件事。
 *
 * @returns {{items: Object<string,number>, total:number}}
 */
function inventoryFingerprint () {
  const items = {};
  let total = 0;
  try {
    for (const it of state.bot?.inventory?.items() || []) {
      const n = it.count || 1;
      items[it.name] = (items[it.name] || 0) + n;
      total += n;
    }
  } catch (_) { /* 没连上或背包不可读 → 返回空指纹，调用方按 0 处理 */ }
  return { items, total };
}

/**
 * 两个背包快照之间，**真的多了几件**。
 *
 * ⚠️ 只数"变多的"，不数净变化 —— 因为拾取过程中她可能同时吃掉了东西、
 *    用掉了方块。净变化会把"捡了 3 个、吃了 1 个"算成 2，那是错的答案。
 *    `gained`（净变化）由调用方另外算，两者用途不同。
 *
 * @returns {number} 新增件数（≥0）
 */
function fingerprintDelta (before, after) {
  let added = 0;
  for (const [name, n] of Object.entries(after?.items || {})) {
    const prev = before?.items?.[name] || 0;
    if (n > prev) added += n - prev;
  }
  return added;
}

/**
 * 把刚挖下来的东西捡起来。
 *
 * ## 为什么需要它（这是实机跑出来的，不是推演）
 *
 * 2026-09-25 第一次实战：`POST /mine {"blockName":"bountifulfares:lemon_log","count":8}`
 * 返回 `mined: 8`，但查背包**只有 1 个**。掉了 7 个。
 *
 * 根因：`bot.dig()` 只负责把方块**拆掉**，拆下来的物品变成 `Object` 实体落在地上。
 * 服务端在客户端**走过去**之后才判定拾取。`/mine` 的循环是
 * 「找方块 → 走到旁边 → dig → 立刻找下一个」，从头到尾没有回头捡这一步。
 *
 * 木头是一柱一柱的，挖断最下面那格时上面的还在往下掉 —— 她已经在走去挖下一柱了。
 * 木质越高的方块丢得越多。
 *
 * ## 为什么不抛异常
 *
 * 捡不到**不是错误**，是"那件东西拿不到"（掉进岩浆、被水冲走、别的玩家抢了）。
 * 把捡不到当失败会让 `/mine` 整体失败率虚高，进而触发 autopilot 的任务放弃计数 ——
 * 于是"挖到了但没捡全"会被误报成"这活做不成"。
 *
 * ## 为什么要"等"（P10，2026-09-25 第二次实战）
 *
 * 第一次修好 P1c（dig 校验）之后，实机仍然 `dropsPicked: 0`，
 * 而挖完**几秒后**再查 `/nearby`，掉落物明明就在旁边（`item @ 4,89,7 距离 2`）。
 *
 * 根因：**掉落物实体的生成与同步有延迟**。`dig()` 返回时，
 * 客户端只是"把方块改成了空气"；服务端要生成掉落物实体、
 * 打包、发过来、客户端再解出实体 —— 这几步加起来是**几百毫秒量级**。
 * 而原来的代码是：dig 一返回就**立刻查一次**实体表，查不到就走人。
 *
 * > 这是"事件驱动的世界"和"轮询式读取"之间的经典错配：
 * > **动作完成的时刻 ≠ 结果可观测的时刻。**
 *
 * 修法：先**等**（轮询等到掉落物出现，或超时），再捡。
 * 等待期间一旦看到掉落物就立刻行动 —— 不傻等固定时长。
 *
 * @param {object} bot
 * @param {object} around  刚挖掉的那个方块的坐标 {x,y,z}
 * @param {object} [opts]  { radius, budgetMs, waitMs, pollMs }
 * @returns {Promise<{seen:number, picked:number, skipped:number}>}
 */
async function sweepUpDrops (bot, around, opts = {}) {
  const radius = opts.radius ?? 3;
  const budgetMs = opts.budgetMs ?? 4000;
  // 等掉落物出现的上限。**与捡取的预算分开算** ——
  // 两者是不同性质的时间：前者等"世界的反应"，后者花在"走过去"上。
  const waitMs = opts.waitMs ?? 2500;
  const pollMs = opts.pollMs ?? 200;
  const out = { seen: 0, picked: 0, skipped: 0, waitedMs: 0, polls: 0 };
  if (!bot?.entity?.position || !around) return out;

  const isDrop = (e) => e && e !== bot.entity && e.position && e.isValid !== false
    && isDropEntity(e);

  const findDrops = () => Object.values(bot.entities)
    .filter(isDrop)
    .filter(e => e.position.distanceTo(around) <= radius)
    // 近的优先：近的那件最可能是刚挖下来的，也最不容易在路上被水冲走
    .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
    .slice(0, 8);

  // ---- ① 等它出现（P10 的修复）------------------------------------------------
  //
  // 注意这里是"**轮询直到看见**"，不是"睡固定时长再看一眼"：
  // 掉落物通常几十毫秒就同步过来了，睡满 2.5 秒纯属浪费时间。
  // 而如果真的没有（挖的是玻璃/树叶这种不掉落的方块），就在 waitMs 后放弃。
  const waitDeadline = Date.now() + waitMs;
  let drops = findDrops();
  while (!drops.length && Date.now() < waitDeadline) {
    out.polls++;
    await sleep(pollMs);
    drops = findDrops();
  }
  out.waitedMs = out.polls * pollMs;

  // ---- 诊断留痕（P1b 的产物）-------------------------------------------------
  // 实机上 `seen: 0` 但确实挖掉了方块 —— 这种情况下最需要的不是"再猜一次"，
  // 而是**亲眼看到 bot 眼里的实体长什么样**。
  // 所以这里把"候选集"和"每个为什么被排除"都记下来，返回给调用方。
  // 成本极低（就是几个字段读），但它决定了下次出问题要查 5 分钟还是 1 小时。
  const all = Object.values(bot.entities);
  const inRange = all.filter(e => e && e !== bot.entity && e.position
    && e.position.distanceTo(around) <= radius);
  out.totalEntities = all.length;
  out.inRange = inRange.length;
  out.candidates = inRange.slice(0, 6).map(e => ({
    name: e.name ?? null,
    displayName: e.displayName ?? null,
    type: e.type ?? null,
    isDrop: isDropEntity(e),
    valid: e.isValid !== false,
    dist: Math.round(e.position.distanceTo(around) * 10) / 10,
  }));
  if (!out.candidates.length && all.length) {
    // 附近一件实体都没有，但世界里明明有 —— 把最近的那个也报上来，
    // 这样能区分"确实没有掉落物"和"我的实体表是空的/我读错了字段"
    const near = all
      .filter(e => e && e !== bot.entity && e.position)
      .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
      .slice(0, 3)
      .map(e => ({
        name: e.name ?? null, displayName: e.displayName ?? null, type: e.type ?? null,
        isDrop: isDropEntity(e),
        dist: Math.round(e.position.distanceTo(around) * 10) / 10,
      }));
    out.nearestAny = near;
  }

  out.seen = drops.length;
  if (!drops.length) return out;

  // ---- ② 捡。成功的判据是**背包真的变了**，不是"我走到了" ----------------------
  //
  // `/pickup` 的注释里写过"走到即会拾取"，但那是**期望**，不是**保证**：
  // 掉落物可能被水冲走、被别的玩家抢先、或者卡在够不到的地方。
  // 唯一可信的判据是背包件数。
  //
  // ⚠️ 而且背包变化**也是延迟的**（P10 的第二层）：走过去之后，
  //    服务端要几十到几百毫秒才把物品塞进背包。
  //    实测：`walked: 1` 但 `picked: 0`，而**几秒后**背包确实多了一件。
  //    所以核对也要"等一下再读"，不能走完立刻读。
  const invBefore = inventoryCount(bot);
  const deadline = Date.now() + budgetMs;
  let walkedTo = 0;
  // ⚠️ 她当前站的高度，整个循环里算一次就够（掉落物距离都很近，她不会在这期间上下大落差）。
  const selfY = Math.floor(bot.entity?.position?.y ?? 0);
  for (const d of drops) {
    if (Date.now() >= deadline) { out.skipped++; continue; }
    if (!d.isValid) { out.skipped++; continue; }
    try {
      // ⚠️ 用 GoalNear(d, 2) 而不是 GoalBlock(d.position)：
      //    掉落物浮在方块高度上，精确命中那个格子往往会"站在旁边却够不到"。
      //
      // ⚠️⚠️ 2026-09-25 实机（P30 → P33）：**球心的 y 最讲究，用错两次。**
      //
      //    ① 第一版用掉落物的 y（P30）：
      //       她站在 y=87 的坎上，掉落物在 y=85。要求她**走到 y≈85 那一层**
      //       才算到达；而 y=87→85 是两格落差，寻路器（`canDig=false`，只绕不拆）
      //       找不到下去的路 → 原地打转 → 背包始终为空。日志上一切正常。
      //       这和 P11（`/mine` 的寻路球心）是**同一个错误**。
      //
      //    ② 第二版一律用她自己的 y（P30 的修法）→ 又错了（P33）：
      //       球心锁在她**当前**层 → 她永远不下坑 → 站在坑沿上够不着坑底。
      //       实机证据：`/pickup` 返回 `walkedTo: 3, picked: 0`，
      //       坑底（y=85/86 的空气格）离她 2 格，而拾取是 **3D 判定**。
      //
      //    ③ 正确的语义：**站到她"够得着这堆东西"的那一层** —— 见 `reachableStandY`。
      //       · 物品在她脚下一格内 → 就跟着下去（1 格落差可以直接走，不用挖）
      //       · 更深 → 站在最近的可站层，靠拾取半径够（**绝不要求她挖穿地形**）
      //       · 在她上方 → 不往天上爬
      //       半径放 2 —— 掉落物会散落，1 格太紧。
      //
      // ⚠️ 另外：**清理必须在 goto 之前，不能在之后**（P25）。
      //    `setGoal(null)` 会 emit `goal_updated(null)`，如果那时下一个 goto
      //    已经注册好 listener 在等，它会收到 null 并立刻报 GoalChanged。
      //    实测：地上 6 个掉落物、距离 1.4 格，goto 全部在 0ms 内失败。
      //    见 `withTimeout` 顶部的完整时序推导。
      pathing.clearPathfinderGoal(bot.pathfinder);
      const goalY = reachableStandY(d.position.y, selfY);
      // ⚠️ P38：半径随垂直落差自适应 —— 否则球内没有可站的点，她永远"到不了"。
      //    三处（sweepUpDrops / `/pickup` / `/mine` 残余）必须用同一条规则。
      const sweepRadius = Math.max(2, Math.abs(selfY - goalY) + 1);
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(d.position.x, goalY, d.position.z, sweepRadius)),
        sleep(Math.max(300, deadline - Date.now())),
      ]);
      walkedTo++;
    } catch (_) {
      out.skipped++;
    }
    // 只 stop() 不清 goal —— clearGoal 会打到下一个已经在等的 goto。
    // ⚠️ 但 `stop()` 之后**必须让出一个 tick**：`goto.js` 的 listener 清理
    //    是 `setTimeout(..., 0)`，不让出的话下一个 goto 会撞上残留 listener
    //    并收到 `goal_updated`（绑的是旧 goal）→ 报 GoalChanged。见 P25 第 ③ 层。
    try { bot.pathfinder.stop(); } catch (_) {}
    await sleep(0);
  }
  // 整批结束，此时无人等待 —— 唯一安全的清理点。
  pathing.clearPathfinderGoal(bot.pathfinder);

  // 走完之后**等背包更新**（最多 settleMs），并用"背包增量"当判据。
  // 为什么不直接报 `walkedTo`：走过去不等于拿到手。
  // 为什么不立刻读：**服务端塞进背包是延迟的**（见上）。
  //
  // ⚠️⚠️⚠️ 2026-09-25 第三轮实战：**条件写错了**（P10 第三层）。
  //
  //   实测（m8.json）：`bulkSweep.walked: 0, picked: 0`，而且 `invDelta: 2`
  //   远小于**实际到手 3 个**（背包 2 → 5）。
  //   也就是"东西其实早就进包了，只是我们三个判据全读早了/读漏了"。
  //
  //   原条件的两个 bug：
  //     ① `walkedTo > 0` 作为前置 —— 她**站着不动**也可能捡到
  //        （掉落物可能正好落到她脚下，或上一轮已经进了碰撞箱）。
  //        加了这个前置就等于"只要我没走路，我就拒绝承认捡到了"。
  //     ② `gained <= 0` 作为唯一继续条件 —— 一旦某一拍读到了 >0 就立刻退出，
  //        但**背包可能是分几拍陆续到的**（3 个物品分 2 批同步），
  //        于是"第一批到手就收工"，后两批永远没被等到。
  //
  //   修法：
  //     · 去掉 `walkedTo > 0` 前置 —— 只要**有候选掉落物**就该等一等；
  //     · 不满足于"第一次 >0"，而是**一直等到不再增长**（稳定了才算齐），
  //       上限仍是 settleMs。
  //   这样报出来的 `picked` 才接近真实到手件数。
  const settleMs = opts.settleMs ?? 1200;
  const settleDeadline = Date.now() + settleMs;
  const hadCandidates = drops.length > 0;
  let gained = inventoryCount(bot) - invBefore;
  let lastGained = gained;
  while (hadCandidates && Date.now() < settleDeadline) {
    await sleep(150);
    gained = inventoryCount(bot) - invBefore;
    if (gained > 0 && gained === lastGained) break;   // 已经稳定：拿完了
    lastGained = gained;
  }

  out.picked = Math.max(0, gained);
  // `walked` 与 `picked` **分开报**：差值有信息量 ——
  // walked > picked 就是"走过去了但没进包"（被抢/够不到/掉落物已消失）。
  // 只报一个 `picked` 的话，这种摩擦永远看不出来。
  out.walked = walkedTo;
  return out;
}

/**
 * 背包里的**物品总件数**（不是占用的格子数）。
 *
 * 为什么要按件而不是按格：一格里可能堆了 64 个。挖铁矿这个场景里
 * "背包多了几件"才是进展，而"占了几格"在堆叠时根本不动 —— 用格子数会让
 * "挖了一整组铁"看起来像零进展，进而误触"没收获 → 扩半径"。
 */
function inventoryCount (bot) {
  try {
    const items = bot?.inventory?.items() || [];
    return items.reduce((sum, it) => sum + (Number(it?.count) || 0), 0);
  } catch (_) { return 0; }
}

/**
 * 「哪些方块会掉落这个物品」。
 *
 * 为什么需要它（问题 4「对可收获的东西视而不见」的一半原因）：
 * 一个真玩家想的是"我要铁"。而 `iron_ore` 掉 `raw_iron`、`coal_ore` 掉 `coal`、
 * 红石矿掉 4 个 `redstone` —— 方块名和掉落物名对不上，于是调用方必须先自己
 * 背一张映射表。
 *
 * ## ⚠️ 两条路，第二条才是主力（2026-09-25 实机纠正）
 *
 * **① 查 `block.drops`** —— 精确，但**只覆盖原版**。
 *    `drops` 数据来自 `minecraft-data`，而它只有 1.20.1 的 1003 个原版方块。
 *    实测：`minecraft-data` 里查 `bountifulfares:lemon_log` → `false`。
 *    这个服有 **516 个模组、19214 个模组方块**，全都不在里面。
 *    所以这条路在真实环境里只对 `iron_ore`/`coal_ore` 那几种原版矿有用。
 *
 * **② 按名字推断** —— 粗糙，但**覆盖模组**。
 *    `bountifulfares:lemon_log` 去掉 `_log` 后缀就是 `bountifulfares:lemon`，
 *    正是它的掉落物。原木/矿石/木材/大量方块都遵守这个命名规律。
 *
 * ## 代价与免责
 *
 * 名字推断**会猜错**（比如 `oak_planks` 不掉 `oak`）。所以返回值里带
 * `resolveSource`（`drops` | `name` | `mixed`），让调用方知道这个结论有多硬。
 * 上层要做精确判断时应优先用 `drops` 的结果，名字推断只用来**兜底**。
 *
 * ⚠️ 我第一版只写了 ①，然后在离线环境用原版表验证"通过"了 ——
 *    测试数据里本来就有 `iron_ore`，所以看不出问题。这也是一条教训：
 *    **离线的绿灯要问一句"我的测试数据里是不是本来就有它"。**
 *
 * @param {object} bot
 * @param {string} itemName  掉落物注册名，如 `raw_iron`
 * @returns {{blocks: Array, resolveSource: string, viaDrops: number, viaName: number}}
 */
function resolveBlocksForItem (bot, itemName) {
  const reg = bot?.registry;
  const empty = { blocks: [], resolveSource: 'none', viaDrops: 0, viaName: 0 };
  if (!reg?.blocksByName) return empty;

  const target = stripNamespace(itemName);
  const viaDrops = [];
  const viaName = [];

  for (const name of Object.keys(reg.blocksByName)) {
    const def = reg.blocksByName[name];
    if (!def || typeof def.id !== 'number') continue;
    if (dropsMatch(reg, def, target)) {
      viaDrops.push({ id: def.id, name, how: 'drops' });
      continue;                       // 已经命中，不必再猜名字
    }
    if (nameMatchesItem(name, target)) {
      viaName.push({ id: def.id, name, how: 'name' });
    }
  }

  const blocks = [...viaDrops, ...viaName];
  // 原版方块优先（没有命名空间前缀的），然后按名字稳定排序。
  // 模组方块重名/覆盖的情况不少，让原版排前面能让"我要铁"在这些包里也选对。
  blocks.sort((a, b) => {
    const am = a.name.includes(':') ? 1 : 0;
    const bm = b.name.includes(':') ? 1 : 0;
    if (am !== bm) return am - bm;
    // 同一档里 drops 命中的排在名字推断之前（更可信）
    if (a.how !== b.how) return a.how === 'drops' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    blocks,
    resolveSource: viaDrops.length && viaName.length ? 'mixed'
      : viaDrops.length ? 'drops'
        : viaName.length ? 'name' : 'none',
    viaDrops: viaDrops.length,
    viaName: viaName.length,
  };
}

/**
 * `block.drops` 里有没有 `target`（已去命名空间）。
 *
 * minecraft-data 里 `drops` 的形状（已实测 1.20.1，1003 个方块）：
 *   **裸数字数组** —— 839 个方块是这样，如 `iron_ore.drops = [769]`（769 = raw_iron）
 *   空数组 —— 164 个（不会被长度判断放过）
 *   其余形状（`{drop: ...}` 对象）本版本一个都没有。仍然兼容它们，
 *   因为 minecraft-data 在其他版本/未来可能变 —— 但**不能只写兼容形状**：
 *   我第一版就是这么写的，结果在实测数据上一条都匹配不到。
 */
function dropsMatch (reg, def, target) {
  const drops = Array.isArray(def.drops) ? def.drops : null;
  if (!drops || drops.length === 0) return false;
  return drops.some(d => {
    const v = d?.drop ?? d;
    if (typeof v === 'string') return stripNamespace(v) === target;
    if (typeof v === 'number') return stripNamespace(reg.items?.[v]?.name || '') === target;
    if (v && typeof v === 'object' && typeof v.id === 'number') {
      return stripNamespace(reg.items?.[v.id]?.name || '') === target;
    }
    return false;
  });
}

/**
 * 按命名规律猜"这个方块掉不掉 `target`"。
 *
 * 规则只有一条，刻意保守：**方块名 == 物品名 + 后缀**，
 * 后缀取原木/矿石/木材类常见的那几个。
 *
 * 为什么不做更花哨的模糊匹配：猜错的代价是"她跑去挖一堆没用的东西"，
 * 比"漏掉一个能挖的方块"严重得多。宁可少推几个。
 *
 * 实测有效的例子：
 *   `bountifulfares:lemon_log`  → `lemon`      （_log）
 *   `upgrade_aquatic:river_log` → `river`      （_log）
 *   `oak_log`                   → `oak`        （_log）
 *
 * ⚠️ **刻意不含 `_block`**。我第一版把它放进来了，结果用真实注册表验证时
 *    `raw_iron` 命中的是 `minecraft:raw_iron_block`（粗铁块）而不是 `iron_ore`（铁矿）——
 *    两者都能挖到 raw_iron，但"挖一个铁块"和"挖一片铁矿"是完全不同的行为，
 *    而且铁块是玩家压好的，属于**别人家的财产**。
 *    `_block` 类（`iron_block`/`raw_iron_block`/`coal_block`）是压缩/装饰用途，
 *    名字对得上但语义完全不同 —— 宁可漏，不可乱推。
 *
 *    那原版矿石怎么办？交给 `drops` 表 —— 它精确知道 `iron_ore` 掉 `raw_iron`。
 *    所以两条路是**互补**的：drops 管原版的"名字对不上"，名字管模组的"名字对得上"。
 */
const ITEM_BLOCK_SUFFIXES = [
  '_log', '_wood', '_stem', '_hyphae', '_ore', '_planks', '_sapling',
];

function nameMatchesItem (blockName, target) {
  const bare = stripNamespace(blockName);
  if (bare === target) return true;                       // 同名（石头掉石头）
  const ns = String(blockName).includes(':')
    ? String(blockName).split(':')[0] : null;
  for (const suf of ITEM_BLOCK_SUFFIXES) {
    if (!bare.endsWith(suf)) continue;
    const head = bare.slice(0, -suf.length);
    if (head !== target) continue;
    // 带命名空间的方块必须**同命名空间**才算命中：`other_mod:lemon_log`
    // 不该被当成 `bountifulfares:lemon` 的来源。
    if (ns && !String(blockName).startsWith(`${ns}:`)) continue;
    return true;
  }
  return false;
}


/** 去掉命名空间前缀，用于物品/方块名比较。 */
function stripNamespace (name) {
  return String(name || '').replace(/^[a-z0-9_.-]+:/i, '');
}

/**
 * 这是不是**人造方块**（玩家合成并放置的）。
 *
 * ⚠️ 为什么需要它（field-log P21，本轮最重要的环境发现）：
 *
 * 2026-09-25 修好 P20（把 `harvestTools` 接进判据）之后，`/scan` 的
 * "现在挖就有产出"短名单**突然变了脸**：
 *
 *     acacia_stairs x67 / oak_planks x53 / acacia_fence_gate x14
 *     stripped_oak_log x26 / acacia_slab x8 / oak_fence x5 / lantern
 *
 * 这些**都只能由玩家合成并放置** —— 自然界不生成 planks/stairs/slab/fence/gate，
 * 更不会把三种木材（acacia/oak/mangrove）和灯笼、石砖混在一处。
 *
 * 也就是说：**她正站在一个玩家的建筑里，之前"一路向下挖 15 格"挖的是人家的地基。**
 *
 * 判据是"**名字规律**"而不是"白名单"：
 *   · 白名单永远会漏（这服 20217 个方块、516 个模组）；
 *   · 而"合成件"这个词在命名上有很稳定的后缀特征。
 *
 * ⚠️⚠️ 这个函数**只用于标注，不用于过滤**。
 *   she 完全可能**需要**木板/台阶来建自己的房子（这些正是好建材）。
 *   要拦的不是"挖人造方块"，而是"**拆别人的建筑**"。
 *   信息给出去，让上层自己决定。
 */
function isPlayerBuilt (blockName) {
  if (!blockName) return null;
  const n = stripNamespace(blockName);

  // 合成件后缀 —— 这些在自然界里**不会生成**（自然树只有 _log 和 _leaves）。
  // 注意顺序无关，用 some 匹配。
  const CRAFTED_SUFFIXES = [
    '_planks', '_stairs', '_slab', '_fence', '_fence_gate', '_wall',
    '_door', '_trapdoor', '_pressure_plate', '_button', '_sign',
    '_bricks', '_brick', '_glass', '_glass_pane', '_pane',
    '_bars', '_ladder', '_scaffolding', '_carpet', '_bed',
    '_torch', '_lantern', '_campfire', '_chain', '_flower_pot',
    '_chest', '_barrel', '_crafting_table', '_furnace', '_anvil',
    '_cauldron', '_composter', '_lectern', '_loom', '_smoker',
    '_bookshelf', '_painting', '_item_frame', '_flower_pot',
  ];
  if (CRAFTED_SUFFIXES.some(suf => n.endsWith(suf))) return true;

  // 几个不带后缀但明确是人造的
  const CRAFTED_EXACT = new Set([
    'lantern', 'soul_lantern', 'glass', 'tinted_glass', 'bricks',
    'stone_bricks', 'chiseled_stone_bricks', 'mossy_stone_bricks',
    'bookshelf', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
    'chest', 'trapped_chest', 'barrel', 'anvil', 'chipyed_anvil',
    'torch', 'soul_torch', 'redstone_torch', 'campfire', 'soul_campfire',
    'scaffolding', 'ladder', 'iron_bars', 'chain', 'flower_pot',
    'white_wool', 'glass_pane', 'glowstone', 'sea_lantern', 'shroomlight',
  ]);
  if (CRAFTED_EXACT.has(n)) return true;

  // 染色变体（16 色 × 各种构件）—— 也都是合成的
  // `white_wool` / `red_carpet` / `blue_stained_glass` …
  if (/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/.test(n)) {
    // 但要排除自然方块（比如 black_sand? 不存在；obsidian 也不是这个前缀）
    if (/(_wool|_carpet|_concrete|_terracotta|_stained_glass|_bed|_banner|_shulker_box|_candle|_dye)/.test(n)) return true;
  }

  // `_brick(s)` 家族（red_nether_bricks / mud_bricks / deepslate_bricks…）
  if (/_bricks?$/.test(n)) return true;

  // 石砖/石英/紫珀这类"加工过的石头"
  if (/(_polished|_chiseled|_cut|_smooth)_/.test(n)) return true;

  return false;
}

// 注：面名（below/above/west/…）与四个放置条件的判定都在 place.js 里。
// 这里不要再复制一份 —— 两份实现早晚会漂移，而其中一份没人测。

/**
 * 等世界真的把某个坐标更新成"有方块"。
 *
 * 为什么需要：`placeBlock` 返回 ≠ 服务端接受了。客户端有预测，于是会出现
 * **幽灵方块**（本地看着有、服务端其实没有）。只看 placeBlock 不抛异常就报成功，
 * 是在骗调用方。这里以服务端推来的 blockUpdate 为准。
 *
 * ⚠️ 只能确认"出现了一个非空气方块"，**不能确认是哪个方块** ——
 * 这个模组服上 mineflayer 的方块名整片错位（实测 white_wool 读成 fire），
 * 所以别在这里比对名字。
 *
 * @returns {Promise<boolean>} true = 看到更新；false = 超时（可能是延迟，不一定是失败）
 */
function waitForBlock(bot, pos, ms = 1500) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bot.removeListener('blockUpdate', onUpdate);
      resolve(v);
    };
    const onUpdate = (_oldBlock, newBlock) => {
      try {
        const p = newBlock?.position;
        if (p && p.x === pos.x && p.y === pos.y && p.z === pos.z) {
          if (typeof newBlock.name !== 'string' || !placeLogic.AIRY.test(newBlock.name)) finish(true);
        }
      } catch (_) { /* 事件里出错不该影响判定 */ }
    };
    const timer = setTimeout(() => finish(false), ms);
    bot.on('blockUpdate', onUpdate);

    // 更新可能在我们挂监听之前就到了 —— 主动查一次
    try {
      const cur = bot.blockAt(pos);
      if (cur && typeof cur.name === 'string' && !placeLogic.AIRY.test(cur.name)) finish(true);
    } catch (_) {}
  });
}

// ---- 知识库查询（调用 knowledge/lookup.py）--------------------------------
// 用子进程跑 python，避免在 node 里重写一遍查询逻辑。
// python 路径可用 MC_PYTHON 指定；默认依次尝试 python / python3。
const { execFile } = require('child_process');

function runLookup(script, type, kw, limit) {
  const MAX_CHARS = Math.min(Math.max(1, parseInt(limit ?? '6000') || 6000), 20000);
  const py = cfg('MC_PYTHON', '');
  const candidates = py ? [py] : ['python', 'python3'];

  const attempt = (idx) => new Promise((resolve, reject) => {
    if (idx >= candidates.length) {
      reject(new Error(
        '找不到 python 解释器。请设置 MC_PYTHON 环境变量指向 python.exe，' +
        '或直接在 skills/minecraft-bridge/knowledge 下手动运行 lookup.py'));
      return;
    }
    execFile(candidates[idx], [script, type, kw],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || /not found|不是内部或外部命令/i.test(err.message))) {
          attempt(idx + 1).then(resolve, reject);
          return;
        }
        if (err && !stdout) {
          reject(new Error(`${candidates[idx]} 执行失败: ${(stderr || err.message).slice(0, 400)}`));
          return;
        }
        resolve(String(stdout));
      });
  });

  return attempt(0).then(text => {
    const trimmed = text.length > MAX_CHARS;
    return {
      output: trimmed ? text.slice(0, MAX_CHARS) : text,
      truncated: trimmed,
      hint: trimmed ? '结果被截断，请用更具体的关键词' : undefined,
    };
  });
}

const handlers = {
  // 生效配置。任何 agent 都可以先读这个，确认目标服务器与机器人身份，不必猜环境变量。
  'GET /config': async () => ({
    identity: CFG.mc.username,
    identityIsDefault: CFG.mc.username === BOT_IDENTITY,
    host: CFG.mc.host,
    port: CFG.mc.port,
    version: CFG.mc.version,
    auth: CFG.mc.auth,
    forge: cfg('MC_FORGE', '0') === '1',
    // 攀爬方块配置：默认两个都空 → 不动注册表（正确默认，理由见 fixLadderIdBeforeConnect）
    climbable: {
      blockNames: pathing.parseNameList(cfg('MC_CLIMBABLE_BLOCK_NAME', '')),
      stateIds: pathing.parseIdList(cfg('MC_CLIMBABLE_STATE_IDS', '')),
    },
    // 方块调色板：模组方块能不能叫出名字、`b.type` 到底有没有值，全看它。
    // ⚠️ 放在**顶层**而不是 `state` 里 —— 调色板是**离线**就能导入的（注册表是版本单例），
    //    放进 `state` 会让"没连服务器时看不到自己导没导成功"。
    // ⚠️ 关键指标不是 `loaded` 而是 `injectedIntoRegistry` —— 只 loaded 不注入等于白导。
    // 物品注册表：模组物品能不能叫出名字（`i.name` 是 'unknown' 还是真名），全看它。
    // 和调色板同一个道理放顶层：快照是本地文件，离线也该能查。
    // ⚠️ 判据同样是"有没有真的写回注册表"——`modded > 0` 且 `ok` 才算数。
    itemRegistry: {
      snapshotLoaded: !!state.itemSnapshot,
      snapshotFile: itemRegistry.DEFAULT_SNAPSHOT,
      snapshotCapturedAt: state.itemSnapshot?.capturedAt ?? null,
      snapshotEntries: state.itemSnapshot?.entryCount ?? 0,
      injectedIntoRegistry: state.itemInject
        ? {
            ok: state.itemInject.ok,
            reason: state.itemInject.reason,
            modded: state.itemInject.modded,
            vanillaChecked: state.itemInject.vanillaChecked,
            vanillaItemCount: state.itemInject.vanillaItemCount,
            gaps: state.itemInject.gaps,
            vanillaMismatches: state.itemInject.vanillaMismatches,
            vanillaMissing: state.itemInject.vanillaMissing,
          }
        : null,
    },
    palette: state.palette
      ? {
          loaded: true,
          entries: state.paletteMeta.entries,
          totalStates: state.paletteMeta.totalStates,
          gaps: state.paletteMeta.gaps,
          file: state.paletteMeta.file,
          injectedIntoRegistry: state.paletteInject
            ? {
                ok: state.paletteInject.ok,
                overlayBlocks: state.paletteInject.overlayBlocks,
                overlayStates: state.paletteInject.overlayStates,
                blocks: state.paletteInject.blocks,
                states: state.paletteInject.states,
                vanillaExpanded: state.paletteInject.vanillaExpanded,
                vanillaStateEnd: state.paletteInject.vanillaStateEnd,
              }
            : (state.paletteMeta.inject
              ? {
                  ok: state.paletteMeta.inject.ok,
                  overlayBlocks: state.paletteMeta.inject.overlayBlocks,
                  overlayStates: state.paletteMeta.inject.overlayStates,
                  blocks: state.paletteMeta.inject.blocks,
                  states: state.paletteMeta.inject.states,
                  vanillaExpanded: state.paletteMeta.inject.vanillaExpanded,
                  vanillaStateEnd: state.paletteMeta.inject.vanillaStateEnd,
                }
              : null),
          anchors: {
            configured: String(cfg('MC_PALETTE_ANCHORS', '')).trim() || '(内置默认)',
            checked: state.paletteMeta.inject?.anchorsChecked ?? null,
            violations: state.paletteMeta.inject?.anchorViolations?.length ?? null,
          },
          // mineflayer 每次连接使用独立 registry；真正的判据是本次 bot 是否完成注入。
          registryIsSharedSingleton: false,
          registryIsPerConnection: !!state.bot?.registry,
          registryInjectedOnBot: !!state.paletteInject?.botRegistry && !!state.paletteInject?.ok,
        }
      : { loaded: false, candidates: paletteCandidates() },
    bridgePort: CFG.bridge.port,
    skillDir: __dirname,
    configFile: fs.existsSync(path.join(__dirname, 'config.json'))
      ? path.join(__dirname, 'config.json')
      : null,
    // 寻路策略自检。**`canDig` 现在是 `false`**（2026-09-25 起默认只绕不拆，
    // 见 pathing.js 的 ALLOW_DIG / config.json 的 MC_ALLOW_DIG）。
    // 之前那版是 true + digCost=16，靠"很贵"来保护房子；那层在模组服上被实测突破过
    // （blocksCantBreak 按名字模式匹配，模组装饰名一个都不中），所以收紧了。
    // 现在看 `canDig` 就能判断"她会不会自己挖"；`policy.allowDig` 是这次调用实际用的开关值，
    // `protectedCount` 只在将来重新放行挖掘（MC_ALLOW_DIG=true / JEV 单次放行）时才有意义。
    pathfinder: state.movements
      ? {
          canDig: state.movements.canDig,
          digCost: state.movements.digCost,
          placeCost: state.movements.placeCost,
          liquidCost: state.movements.liquidCost,
          allow1by1towers: state.movements.allow1by1towers,
          allowParkour: state.movements.allowParkour,
          allowSprinting: state.movements.allowSprinting,
          scafoldingBlocks: state.movements.scafoldingBlocks.length,
          policy: state.pfPolicy,
          // 名字可不可信 —— 硬禁那一层是否真的在起作用，全看这个
          registryProbe: state.pfProbe,
          // 梯子能不能爬。两层（prismarine-physics 的 isOnLadder / pathfinder 的
          // climbables）判的都是 **`block.type`（方块注册表 id）**，不是 stateId。
          // ⚠️ 原版梯子就是 196，本来就爬得上去 —— 所以别只看 applied 判断"修好没有"。
          //    真判据是 `libraryPathWouldWork`（当前这套认不认得出）。
          climbables: state.pfClimb
            ? {
                ...state.pfClimb,
                size: state.movements.climbables ? state.movements.climbables.size : null,
                vanillaLadderId: state.pfClimbProbe?.vanillaLadderId ?? null,
                libraryLadderId: state.pfClimbProbe?.libraryLadderId ?? null,
                vanillaPathWouldWork: state.pfClimbProbe?.vanillaPathWouldWork ?? null,
                libraryPathWouldWork: state.pfClimbProbe?.libraryPathWouldWork ?? null,
                observed: state.pfClimbProbe?.observed ?? [],
              }
            : null,
          // 物理层修正：改的是共享注册表的 blocksByName.ladder.id，必须在 createBot 之前。
          // 默认什么都不改（applied=false），**这是正确的默认**：服务端原版 id 零位移。
          // 只有配了 MC_CLIMBABLE_BLOCK_NAME / MC_CLIMBABLE_STATE_IDS 才会动。
          ladderFix: state.pfLadderFix ?? null,
          // 名字→id 表（来自服务端 FML 快照，可从磁盘载入）。梯子的"名字路线"靠它。
          registryNameTable: { loaded: BLOCK_NAME_TO_ID ? BLOCK_NAME_TO_ID.size : 0 },
          // 未映射方块（模组方块）的认知策略。patched=false 时 skipped 说明原因。
          // 这条修的是"客户端把模组方块当空气 ⇒ 走进去被服务端推回来 ⇒ 原地抖动"。
          unknownBlockPolicy: state.pfUnknown ?? null,
          // 运行时"可穿过"白名单：她自己打开、并且**实测穿得过去**的 state。
          // 只有验证通过的才会留在这里 —— 猜错的会被 /climb 撤回。
          passableStateIdsRuntime: [...state.passableStateIdsRuntime],
          // 方块调色板的状态见**顶层** `palette`（离线也要能看，所以不放这里）。
          // 这里只留"连接后重注入"的结果，用来和顶层的离线注入对照。
          paletteInjectAfterConnect: state.paletteInject
            ? { ok: state.paletteInject.ok, blocks: state.paletteInject.blocks, states: state.paletteInject.states, cleared: state.paletteInject.cleared }
            : null,
        }
      : null,
  }),

  // 临时诊断端点（P25 排查用）：把 pathfinder 的**内部状态**和事件监听器数量
  // 暴露出来。"goal was changed" 这类错误的成因在**监听器注册时序**上，
  // 光看调用栈看不出来 —— 必须能正面回答"现在有几个 path_stop listener"。
  // ⚠️ P40：`/shelter` 的**空位探测留痕**。那个端点失败时只说
  //    "四周全是实心"，但真相可能是"白名单没匹配上某个方块名"。
  //    这类"过滤器把集合清空"的 bug 必须能**看见中间数组**才能排查。
  'GET /debug/shelter-probe': async () => ({
    lastProbe: state.__lastShelterProbe || null,
    hint: 'probe[].block = bot.blockAt 读到的方块名；ok = 是否通过空气白名单',
  }),

  'GET /debug/pathfinder': async () => {
    const pf = state.bot?.pathfinder;
    const evts = ['goal_updated', 'goal_reached', 'path_stop', 'path_update', 'path_reset'];
    const listeners = {};
    for (const e of evts) {
      const l = state.bot?.listeners?.(e) || [];
      listeners[e] = l.length;
    }
    let goalDesc = null;
    try {
      // ⚠️ `bot.pathfinder.goal` 是 defineProperties 定义的 **getter**（读 `stateGoal`），
      //    所以能直接读出当前目标 —— 不用靠行为探。这是排查
      //    "goal was changed" 的关键观测面（P25）。
      const g = pf?.goal;
      goalDesc = {
        goal: g ? g.constructor.name : null,
        goalCtor: g ? g.constructor.name : null,
        // GoalNear/GoalFollow 之类会把目标点存在字段上，能读出来最好
        goalDetail: g ? Object.keys(g).reduce((a, k) => {
          const v = g[k];
          if (v == null || typeof v === 'function') return a;
          a[k] = typeof v === 'object' ? (v.constructor?.name || String(v)) : v;
          return a;
        }, {}) : null,
        isMoving: pf?.isMoving?.() ?? null,
        isMining: pf?.isMining?.() ?? null,
        isBuilding: pf?.isBuilding?.() ?? null,
      };
    } catch (e) { goalDesc = { error: e.message }; }
    return {
      listeners,
      internal: goalDesc,
      currentAction: state.currentAction,
      // 最近 12 次 goal 变化。没有它，"goal was changed" 就只是一句错误文案，
      // 看不出**是谁**改的、改成了什么（见 field-log P25）。
      recentGoalEvents: state.__goalTrace.slice(-20),
    };
  },

  'GET /status': async () => ({
    connected: state.connected,
    username: CFG.mc.username,
    position: botPos(),
    health: state.bot?.health ?? null,
    food: state.bot?.food ?? null,
    saturation: state.bot?.foodSaturation ?? null,
    // 氧气。反射层要读它判断"该不该上浮"（`reflex.js` 的 `reflex:breathe`）。
    // ⚠️ mineflayer 只在**头部泡在水里**时才给这个值，其余时候是 undefined。
    //    这不是 bug —— "不在水里就没有氧气概念"，反射层也按这个语义处理
    //    （`oxygen == null` 时直接不触发）。
    oxygen: state.bot?.oxygenLevel ?? null,
    gameTime: state.bot?.time?.timeOfDay ?? null,
    isDay: (state.bot?.time?.timeOfDay ?? 0) < 13000,
    isSleeping: !!state.bot?.isSleeping,
    inventoryCount: state.bot?.inventory?.items()?.length ?? 0,
    currentAction: state.currentAction,
    bridgeVersion: BRIDGE_VERSION,
    // 重连状态：`gaveUpReconnecting` 为 true 说明自动重试已经放弃（30 次 × 5s ≈ 2.5 分钟），
    // 此时她**不会**自己回去 —— 服务端恢复后要调 POST /reconnect。
    retries: state.retries,
    maxRetries: CFG.bridge.maxRetries,
    gaveUpReconnecting: !!state.gaveUpReconnecting,
  }),

  // 显式重连。存在的理由：`maxRetries` 用完之后自动重试就停了（不无限空转），
  // 而服务端可能几小时后才起来 —— 那时需要一个"叫她回来"的开关，
  // 而不是去手动重启整个网桥（那会丢掉已导入的调色板之外的所有运行时状态）。
  'POST /reconnect': async () => {
    if (state.connected) {
      return { success: true, alreadyConnected: true, retries: state.retries };
    }
    const before = { retries: state.retries, gaveUp: !!state.gaveUpReconnecting };
    state.retries = 0;
    state.gaveUpReconnecting = false;
    try {
      createBot();
    } catch (e) {
      return { success: false, reason: `createBot 抛错：${e.message}`, before };
    }
    return { success: true, before, note: '已重新发起连接；用 GET /status 看 connected 变没变' };
  },

  'GET /inventory': async () => {
    const items = (state.bot.inventory.items() || []).map(i => ({
      name: i.name,
      displayName: i.displayName,
      count: i.count,
      slot: i.slot,
      // ⚠️ 原始**数字** item id。名字解析不出来时（`name === 'unknown'`）这是唯一能
      //    判断"手里到底是哪件东西"的证据 —— 拿它去 `GET /item?id=` 就能反查真名。
      //    也是排查"注入到底生效了没有"的锚点：注入成功的话这个 id 必定查得到名字。
      type: i.type,
      durability: i.durabilityUsed ?? null,
    }));
    return { items, totalStacks: items.length };
  },

  // 物品身份查询。这是"物品注入到底生效了没有"的正面回答。
  //
  // 为什么要这个端点：物品名解析不出来时 `GET /inventory` 只报 `name:"unknown"` +
  // 一个数字 `type`，而**只有这里能把它翻译成名字**。`name=` 那条则验证反向索引
  // （`/drop`、`/equip`、`/craft`、`/place`、`/collect` 走的全是 `itemsByName`）。
  // ---------------------------------------------------------------- 配方表诊断
  //
  // ⚠️ 为什么必须有这个端点（P49）：
  //
  //   `POST /craft` 失败时**只有一句** `No recipe for X (or missing crafting table)`。
  //   这句话把三种**完全不同**的情况混成了一种：
  //     ① 配方数据没加载（注册表里没有该版本的 recipes）
  //     ② 配方在，但**缺材料** —— `recipesFor` 内部会检查背包，缺料同样返回空数组
  //     ③ 真没这个配方
  //
  //   ⚠️⚠️ 这个区分不是学术问题：**我自己就在同一次排查里连续误判了三次**
  //   （见 field-log P49）——
  //     · 先以为"配方表没加载"（因为我读了 `bot.recipes`，**那个属性在 mineflayer 4.x 根本不存在**）
  //     · 再以为"minecraft-data 缺 1.20.1 的 recipes.json"（其实数据有 **729 条**，好好的）
  //     · 最后才发现真相：`coarse_dirt` 的配方是 **dirt×2 + cobblestone×2**，
  //       她手里只有土、没有圆石 → `No recipe` **完全正确**。
  //
  //   **"没有"和"读不到"必须分开 —— 这次连我自己都栽在这上面。**
  //
  //   所以这个端点用 **`recipesAll`**（它**只查配方、不查背包**）把两者分开：
  //     · `all`     —— 这个 item 有几条配方（0 = 真的没有 ①/③）
  //     · `craftable` —— 其中几条现在就能做（0 且 all>0 = **缺材料** ②）
  //     · `missing` —— 缺哪些材料、各缺多少（**这才是有行动价值的那一行**）
  'GET /recipes': async (_, q) => {
    const bot = state.bot;
    const reg = bot.registry || {};
    // ⚠️ 判据是 `reg.recipes`（prismarine-registry 的属性），**不是 `bot.recipes`**。
    //    mineflayer 不暴露 `bot.recipes` —— 写错会永远得到 0，然后误报"表没加载"。
    const recipeIndex = reg.recipes || {};
    const recipeKeys = Object.keys(recipeIndex);
    const totalRecipes = recipeKeys.reduce(
      (n, k) => n + (Array.isArray(recipeIndex[k]) ? recipeIndex[k].length : 0), 0);

    const tableBlock = bot.findBlock({
      matching: reg.blocksByName?.['crafting_table']?.id,
      maxDistance: 5,
    });

    const base = {
      // ① 数据本身：0 才是"表没加载"（正常情况下 1.20.1 应有数百条）
      loaded: recipeKeys.length > 0,
      itemWithRecipes: recipeKeys.length,
      totalRecipes,
      tableNearby: tableBlock
        ? { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z }
        : null,
      inventorySummary: (() => {
        const items = bot.inventory?.items?.() || [];
        return { kinds: items.length, total: items.reduce((n, i) => n + i.count, 0) };
      })(),
    };

    // ② 探针：默认 `coarse_dirt`（原版 2×2 配方：dirt×2 + cobblestone×2）
    const probeItem = q?.item || 'coarse_dirt';
    const it = reg.itemsByName?.[probeItem];
    if (!it) {
      return { ...base, probe: { item: probeItem, error: `注册表里没有 ${probeItem} 这个物品（名字拼错？）` } };
    }

    // ★ 关键：`recipesAll` **只查配方、不查背包**；`recipesFor` **会查背包**。
    //   两者配对就能把"没配方"和"缺材料"一刀切开。
    const allRecipes = (() => {
      try { return bot.recipesAll(it.id, null, tableBlock) || []; } catch (_) { return []; }
    })();

    // 逐条算"还差什么"：delta 里 count<0 的是消耗项
    const inv = bot.inventory?.items?.() || [];
    const countOf = (id) => inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const missing = [];
    for (const r of allRecipes) {
      const need = [];
      let feasible = true;
      for (const d of (r.delta || [])) {
        if (d.count >= 0) continue;
        const want = -d.count;
        const have = countOf(d.id);
        const nm = reg.items?.[d.id]?.name || `id:${d.id}`;
        if (have < want) feasible = false;
        need.push({ name: nm, need: want, have });
      }
      // 只报"最接近能做"的那条的缺口 —— 全报出来反而淹没重点
      if (!feasible) {
        const gap = need.filter(n => n.have < n.need).sort((a, b) => (b.need - b.have) - (a.need - a.have));
        if (gap.length) missing.push({ requiresTable: r.requiresTable, gap });
      }
    }
    // 按"缺得最少"排序：最接近可做的那条排最前
    missing.sort((a, b) => a.gap.length - b.gap.length
      || (a.gap[0].need - a.gap[0].have) - (b.gap[0].need - b.gap[0].have));

    const craftableNow = (() => {
      try { return bot.recipesFor(it.id, null, 1, tableBlock).length; } catch (_) { return 0; }
    })();

    // 结论：三种情况**明确分开**
    let verdict;
    if (!recipeKeys.length) {
      verdict = 'RECIPES_NOT_LOADED —— 注册表里一条配方都没有。'
        + '这**不是**"缺材料"，也不是"没这个配方" —— 是数据/加载层的问题。';
    } else if (!allRecipes.length) {
      verdict = `RECIPE_MISSING —— 配方表有 ${totalRecipes} 条，但没有 ${probeItem} 的配方。`;
    } else if (craftableNow === 0) {
      const m = missing[0];
      verdict = 'MISSING_MATERIALS —— 配方在（' + allRecipes.length + ' 条），但材料不够：'
        + (m ? m.gap.map(g => `${g.name} 还差 ${g.need - g.have}（有 ${g.have}/需 ${g.need}）`).join('，')
             : '（算不出缺什么）');
    } else {
      verdict = `OK —— ${probeItem} 现在就能做（${craftableNow} 条候选）`;
    }

    return {
      ...base,
      probe: {
        item: probeItem,
        recipesForItem: allRecipes.length,   // 不管材料，有几条配方
        craftableNow,                        // 材料够的几条
        needsTable: allRecipes.length > 0 && allRecipes.every(r => r.requiresTable),
        missing: missing.length ? missing.slice(0, 4) : [],
      },
      verdict,
      hint: recipeKeys.length
        ? undefined
        : '注册表 `recipes` 为空 —— 采集/合成链路会整条失效（做不出任何工具）。'
          + '检查 `minecraft-data` 是否带该版本的 recipes（数据缺失 ≠ 缺材料）。',
    };
  },

  // ---------------------------------------------------------------- 配方表诊断（结束）

  'GET /item': async (_, q) => {
    const snap = state.itemSnapshot;
    const inject = state.itemInject;
    const base = {
      snapshot: snap
        ? {
            file: itemRegistry.DEFAULT_SNAPSHOT,
            capturedAt: snap.capturedAt,
            host: snap.host,
            entryCount: snap.entryCount,
          }
        : null,
      inject: inject
        ? {
            ok: inject.ok,
            reason: inject.reason,
            note: inject.note,
            modded: inject.modded,
            vanillaChecked: inject.vanillaChecked,
            vanillaItemCount: inject.vanillaItemCount,
            gaps: inject.gaps,
            gapSamples: inject.gapSamples,
            vanillaMismatches: inject.vanillaMismatches,
            vanillaMissing: inject.vanillaMissing,
            committed: inject.committed === true,
            botRegistry: inject.botRegistry === true,
          }
        : null,
    };
    if (!snap) {
      return {
        ...base,
        hint: '还没有物品快照（registry/minecraft-item.json）。连上一次服务端就会自动落盘，重连即生效。',
      };
    }
    const index = itemRegistry.buildIndex(snap);
    const boundary = inject?.vanillaItemCount ?? itemRegistry.VANILLA_ITEM_FALLBACK;

    if (q?.id !== undefined && q.id !== '') {
      const id = Number(q.id);
      return {
        ...base,
        query: { id },
        name: index.byId.get(id) ?? null,
        isVanilla: Number.isInteger(id) && id < boundary,
      };
    }
    if (q?.name !== undefined && q.name !== '') {
      const name = String(q.name);
      // 全名优先；再退回 `minecraft:` 前缀补齐（调色板那边用裸名，快照用全名）。
      const hit = index.byName.has(name) ? name : `minecraft:${name}`;
      return {
        ...base,
        query: { name },
        id: index.byName.get(hit) ?? null,
        resolvedName: index.byName.has(hit) ? hit : null,
      };
    }

    // 不给参数：总览 + 一条**活的**判据（拿快照里第一个模组物品去问当前 bot.registry）
    const probeId = index.sorted.find(id => id >= boundary);
    return {
      ...base,
      total: index.total,
      minId: index.minId,
      maxId: index.maxId,
      gapCount: index.gapCount,
      gapSamples: index.gapSamples,
      missingIds: index.missingIds,
      sample: [...index.byName.entries()].slice(0, 5).map(([name, id]) => ({ name, id })),
      liveRegistryProbe: probeId === undefined
        ? null
        : {
            id: probeId,
            snapshotName: index.byId.get(probeId),
            // 非 null 就说明注入**真的写进了正在跑的那个 registry**（而不是只读了文件）
            resolvedInLiveRegistry: state.bot?.registry?.items?.[probeId]?.name ?? null,
            byNameIndexed: !!state.bot?.registry?.itemsByName?.[index.byId.get(probeId)],
          },
    };
  },

  // `x/y/z` 是**取整**的（多数场景只关心"在哪个格子"）；`exact` 是原始浮点。
  // ⚠️ 闭环控制必须用 `exact`：`POST /control` 是按毫秒按键的，走半格会被取整成 0，
  //    于是"横向对准 1 格宽的缝"这种活儿在取整坐标上永远判不出来（会来回按个不停）。
  'GET /position': async () => ({
    ...botPos(),
    exact: botPosExact(),
    yaw: state.bot.entity.yaw,
    pitch: state.bot.entity.pitch,
  }),

  'GET /health': async () => ({
    health: state.bot.health,
    food: state.bot.food,
    saturation: state.bot.foodSaturation,
    isDead: state.bot.health <= 0,
  }),

  'GET /nearby': async (_, q) => {
    const radius = Math.min(Math.max(1, parseInt(q?.radius ?? '16') || 16), 64);
    const self = state.bot.entity;
    const entities = Object.values(state.bot.entities)
      .filter(e => e !== self && e.position)
      .filter(e => e.position.distanceTo(self.position) <= radius)
      .slice(0, 20)
      .map(e => {
        const drop = isDropEntity(e);
        return {
          name: e.name || e.username || 'unknown',
          type: e.type,
          // ⚠️ 掉落物的 `name` 是从 metadata 解析出的**物品显示名**
          //    （`oak_log` / `apple`…），不是字面量 `'item'`。
          //    消费者原来只能靠 `name === 'item'` 判掉落物，恒不成立，
          //    于是"她对可拾取的东西视而不见"（有返回、无消费者）。
          //
          //    这里我们自己算好 `isDrop` 再暴露，不让消费者各自去猜 ——
          //    历史上 `objectType` 被三个地方各猜了一遍，每处都踩过坑。
          isDrop: drop,
          // ⚠️⚠️ 这里的分类是 2026-09-25 第六次实战抓出来的（field-log P8 完整根因）。
          //
          //   原来只写了 `e.type === 'mob' ? 'mob' : 'other'`，
          //   而 prismarine-entity 对**敌对生物**给的 \`type\` 是 \`'hostile'\`
          //   （实测：\`skeleton\` → \`type=hostile\`, \`entityType=86\`）。
          //   于是骷髅被打进 \`'other'\` —— \`counts.hostile\` **恒为 0**。
          //
          //   后果是致命的：autopilot 的 \`nearestHostile()\` 拿不到威胁，
          //   \`flee\` 分支永远进不去。实战里她被骷髅射到 **1 点血**，全程没有躲避 ——
          //   不是"感知慢"，是**感知的分类表漏了一整类**。
          //
          //   现在按 prismarine-entity 的完整 \`type\` 取值分类：
          //     'hostile' → 敌对生物   'animal'/'water_creature' → 被动生物
          //     'mob' → 兜底的生物类（部分版本用这个）
          kind: drop
            ? 'drop'
            : (e.type === 'player'
              ? 'player'
              : (e.type === 'hostile'
                ? 'hostile'
                : (e.type === 'mob' || e.type === 'animal' || e.type === 'water_creature'
                  ? 'mob'
                  : 'other'))),
          // `type` **原样透出** —— 让消费者能自己判（而不是只能依赖我们分的 kind），
          // 也方便下次再遇到"分类漏了哪一类"时一眼看出来。
          entityType: e.type ?? null,
          distance: Math.round(e.position.distanceTo(self.position) * 10) / 10,
          position: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) },
        };
      })
      // 掉落物实体数可能很多（一次挖矿掉十几件），排在前面方便消费者直接取最近的
      .sort((a, b) => a.distance - b.distance);
    return {
      entities,
      radius,
      // 掉落物单独给一份，省得每个消费者都自己再过滤一遍（也就不会各写各的、各踩各的坑）
      drops: entities.filter(e => e.isDrop),
      counts: {
        total: entities.length,
        drops: entities.filter(e => e.isDrop).length,
        // ⚠️⚠️ 这里只算**敌对**生物。2026-09-25 修 P8 时我先把
        //     `kind === 'hostile' || kind === 'mob'` 写进来 —— 那是**错的**：
        //     实战立刻抓到它把 **20 只鸡**报成了 `hostile: 20`。
        //     `kind === 'mob'` 是**被动生物**（鸡/牛/羊），不是威胁。
        //
        //     这正好是 P8 的镜像错误：上次是"有怪但没认出来"，
        //     这次差点变成"没怪但报成有怪" —— 两个方向都会让上层做错决策。
        //     判据必须和 `kind` 的定义严格对齐：
        //       hostile → 只有 kind === 'hostile'
        //       mobs    → 只有 kind === 'mob'（被动生物）
        hostile: entities.filter(e => e.kind === 'hostile').length,
        mobs: entities.filter(e => e.kind === 'mob').length,
        players: entities.filter(e => e.kind === 'player').length,
      },
    };
  },

  // 在线玩家列表。mineflayer 的 players 表包含所有已知玩家，但 position 只有在
  // 实体进入客户端视野时才有值（distance 为 null 即"知道他在线但看不到"）。
  'GET /players': async () => {
    const self = state.bot.entity?.position ?? null;
    const players = Object.values(state.bot.players)
      .map(p => {
        const pos = p.entity?.position ?? null;
        return {
          username: p.username,
          uuid: p.uuid ?? null,
          ping: p.ping ?? null,
          gamemode: p.gamemode ?? null,
          isSelf: p.username === CFG.mc.username,
          position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
          distance: (pos && self) ? Math.round(pos.distanceTo(self)) : null,
        };
      })
      .sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1;
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });
    return { players, count: players.length };
  },

  // 查方块。给 x/y/z 就查那一格；不给就返回机器人脚下的一段垂直剖面，
  // 用来判断"移动会不会掉下去"——否则在屋顶/树冠上乱走会直接摔死。
  'GET /block': async (_, q) => {
    const { x, y, z } = q || {};
    if (x !== undefined && y !== undefined && z !== undefined) {
      const pos = new Vec3(+x, +y, +z);
      const b = state.bot.blockAt(pos);
      if (!b) return { position: { x: +x, y: +y, z: +z }, block: null, note: 'chunk not loaded' };
      const named = typeof b.name === 'string' && b.name.length > 0;
      // 有调色板时，即使 prismarine-registry 认不出这个 state，我们也能把名字和
      // 属性值还原出来。属性值很重要：`open=false` 和 `open=true` 是同一格方块、
      // 两种完全不同的通行性（活板门就是这么坑的）。
      const hit = state.palette ? blockPalette.lookupState(state.palette, b.stateId) : null;
      const effectiveName = named ? b.name : (hit ? hit.name : '');
      return {
        position: { x: b.position.x, y: b.position.y, z: b.position.z },
        block: effectiveName,
        // 名字是从哪来的，分清楚 —— 免得把"我们查表填的"误当成"注册表本来就认识"
        nameSource: named ? 'registry' : (hit ? 'palette' : null),
        solid: b.boundingBox === 'block',
        diggable: b.diggable,
        // 原始状态 ID。模组服上名字可能整片错位，但 stateId 是服务端给的原始值，
        // 至少能在同一会话内做"是不是同一块"的判断。
        stateId: b.stateId,
        ...(hit ? {
          blockRegistryId: hit.blockId,
          properties: hit.properties,
          propertiesText: blockPalette.formatProps(hit.properties),
          localStateIndex: hit.local,
        } : {}),
        // 空名字 = 既不在注册表里、调色板也查不到。显式标出来，免得调用方把 "" 当空气。
        ...(effectiveName ? {} : {
          note: 'unmapped block state — name unavailable, do not treat as air',
          hint: '导出一份方块调色板（见 registry/README）就能叫出它的名字',
        }),
      };
    }
    const feet = state.bot.entity.position.floored();
    const column = [];
    for (let dy = 2; dy >= -4; dy--) {
      const p = feet.offset(0, dy, 0);
      const b = state.bot.blockAt(p);
      column.push({ dy, block: b ? b.name : null, solid: b ? b.boundingBox === 'block' : false });
    }
    return { at: { x: feet.x, y: feet.y, z: feet.z }, onGround: state.bot.entity.onGround, column };
  },

  // 最近收到的聊天/系统消息。/list、/msg 之类命令的输出也在这里。
  'GET /chatlog': async (_, q) => {
    const limit = Math.min(Math.max(1, parseInt(q?.limit ?? '30') || 30), CHATLOG_MAX);
    return { messages: chatlog.slice(-limit), buffered: chatlog.length };
  },

  // ---- 记忆 -----------------------------------------------------------------
  // 读记忆：journal（发生过什么）+ state（现在什么样）。任何 agent 都可以先读这个
  // 再决定说什么，这样"她"就不会忘记之前的事。
  'GET /memory': async (_, q) => {
    const limit = Math.min(Math.max(1, parseInt(q?.limit ?? '40') || 40), 500);
    const j = readJournal(limit);
    return {
      journalFile: JOURNAL_FILE,
      stateFile: STATE_FILE,
      journalTotal: j.total,
      journal: j.lines,
      state: saveState(),
    };
  },

  // 只读状态快照，不刷新（不触发写盘）
  'GET /state': async () => {
    try {
      return { cached: true, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    } catch (_) {
      return { cached: false, ...saveState() };
    }
  },

  // 写记忆：agent 在关键节点主动记一笔（比如"玩家说要带我去打末影龙"）。
  // type 默认 'note'，可给 chat/plan/promise 等自定义分类。
  'POST /memory': async ({ text, type = 'note' }) => {
    if (!text) throw new Error('text field required');
    const line = journal(type, text);
    saveState();
    return { written: line, journalFile: JOURNAL_FILE };
  },

  // ---- 游戏知识库 ------------------------------------------------------------
  // 整合包任务书 / 物品名 / 模组 / 提示的查询入口。
  // 让任何 agent 不必知道文件在哪、也不必会跑 python 就能查资料。
  'GET /knowledge': async () => ({
    dir: KB_DIR,
    available: fs.existsSync(KB_DIR)
      ? fs.readdirSync(KB_DIR).filter(f => !f.startsWith('.'))
      : [],
    hint: 'GET /knowledge/search?type=quest|item|chapter|tip|mod&q=<关键词>；中文关键词必须百分号编码（curl -G --data-urlencode），或改用 POST /knowledge/search + JSON body',
    files: {
      'pack-overview.md': '整合包总览 + 核心机制（必读）',
      'main-quest.md': '主线任务路线图',
      'chapters.md': '61 章全部任务标题',
      'tooltips.md': '物品提示（怎么获得/怎么用）',
      'mods.md': '467 个模组清单',
      'quests.json': '全量任务数据',
      'item-names.json': '33189 条物品/方块/实体中英对照',
    },
  }),

  // 查询知识库。type=raw&file=<name> 可直接读某个文件（仅限知识库目录内的 .md）
  'GET /knowledge/search': async (_, q) => {
    const type = (q?.type || 'quest').trim();
    const kw = (q?.q || '').trim();

    if (type === 'raw') {
      const name = (q?.file || '').trim();
      if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) {
        throw new Error('file 必须是知识库目录下的 .md 文件名');
      }
      const p = path.join(KB_DIR, name);
      if (!fs.existsSync(p)) throw new Error(`知识库没有 ${name}`);
      const text = fs.readFileSync(p, 'utf8');
      const limit = Math.min(Math.max(1, parseInt(q?.limit ?? '400') || 400), 4000);
      return {
        file: name,
        bytes: Buffer.byteLength(text),
        truncated: text.split('\n').length > limit,
        content: text.split('\n').slice(0, limit).join('\n'),
      };
    }

    if (!kw) throw new Error('q (关键词) 必填');
    if (!/^[A-Za-z0-9_-]+$/.test(type)) throw new Error('type 不合法');

    const script = path.join(KB_DIR, 'lookup.py');
    if (!fs.existsSync(script)) {
      throw new Error(`知识库查询脚本不存在: ${script}`);
    }
    const out = await runLookup(script, type, kw, q?.limit);
    return { type, q: kw, result: out };
  },

  // POST 版：中文关键词放进 JSON body，完全不用操心 URL 编码。
  // （Node 会以 400 拒绝请求行里的非 ASCII 字节，所以裸中文只能走这个入口或百分号编码。）
  'POST /knowledge/search': async (b, q) => {
    const merged = { ...(q || {}), ...(b || {}) };
    return handlers['GET /knowledge/search'](null, merged);
  },

  // ---------------------------------------------------------------- 方块感知
  //
  // 新增理由：`autopilot.js` 的 `perceive()` 原来只读 4 个端点，**完全没有方块感知**
  // —— 她"对可收获可拾取的东西视而不见"有一半是这里的原因（另一半是掉落物没有消费者）。
  // 玩家问"你看见旁边那棵树了吗"时她其实真的看不见。
  //
  // ⚠️ 与 HiyoriAI 的 `scan_blocks` 有两个刻意的差异：
  //   1. 它按**名字**返回（人话，能直接讲给玩家 / 喂给 LLM），
  //      HiyoriAI 返回的是结构化对象数组（它给 LLM 用，形态不同）。
  //   2. 它**按名字聚合计数**，不是一格一条 —— 24 格内的橡木原木有 37 格，
  //      返回 37 条没有意义；"oak_log ×37，最近 2.4 格"才是她需要的。
  //
  // 上限 1536 格扫查量取自 HiyoriAI 的 `MAX_SCAN_BLOCK_POSITIONS`
  // （(2r+1) × (2v+1) × (2r+1) 的体积会爆，必须设上限）。
  'GET /scan': async (b, q) => {
    const radius = Math.min(Math.max(1, parseInt(q?.radius ?? '8', 10) || 8), 16);
    const verticalRadius = Math.min(Math.max(1, parseInt(q?.verticalRadius ?? '4', 10) || 4), 8);
    const limit = Math.min(Math.max(1, parseInt(q?.limit ?? '24', 10) || 24), 64);
    const filter = q?.filter ? String(q.filter).toLowerCase() : null;

    const origin = state.bot.entity.position.floored();
    const counts = new Map();   // bareName → { count, nearest, positions[] }

    // ⚠️⚠️⚠️ 2026-09-25 重写（field-log **P45**）：**删掉了"建数组 + 全排序"。**
    //
    // 【原来为什么错】旧代码为了做到"先遇到最近的那些格子"，
    //   把 `(2R+1)² × (2VR+1)` 个候选**全部**建成 `Vec3` 数组，
    //   再用 `a.distanceTo(origin) - b.distanceTo(origin)` 排序 —— 那是
    //   `O(n log n)` 次比较、**每次比较还带 sqrt**。实测：
    //     · `radius=16` 时 18513 个元素排序 = **11.8 ms**
    //     · 而 `/scan` 整体只要 8~11 ms  → **时间几乎全在这里**
    //     · 换成纯循环（不分配、不排序）= **0.82 ms**，**快 14 倍**
    //
    // 【现在怎么做】**按层（洋葱）向外扩**：从 `dy=0`（她脚下那一层）开始，
    //   `level = 0, 1, 2, …` 逐层加大水平半径。每层的遍历顺序本身就是
    //   "从近到远"，**不需要排序**。够上限就停 —— 停下来的位置一定是
    //   "第 N 近的那些格子"，语义与旧的"排序后取前 N"完全一致。
    //
    // 【为什么 `dy` 在**外层**（先扫完同层的所有水平距离，再扫上下层）】
    //   一开始我写在里层（`level` 外层、`dy` 内层），自测立刻红了 —— 那意味着
    //   `level=0` 就把 `dy=0,±1,±2…` 全走完，于是"脚下 1 格"排在"同层 20 格"之前。
    //   实际场景：她站在地面（y=87），20 格外的矿在 y=88 —— 如果脚底下的土
    //   先吃配额，那个矿要等预算用完才轮得到。**而"能走过去的地方"才是她
    //   该优先知道的**（走过去是免费的，上下挖不是）。
    //   → 所以 `dy` 放外层：先把 `dy=0` 这一层的**所有**水平距离扫完，再扫 ±1 层。
    const dyOrder = [0];
    for (let k = 1; k <= verticalRadius; k++) dyOrder.push(-k, k);

    let truncated = false;
    let visited = 0;               // 总共走过了多少个坐标（防死循环的兜底）
    let solids = 0;                // 其中**不是空气**的（= 新的配额口径）

    // 记录"最远看到多远" —— 这是判断"她到底能看多远"的唯一直接证据（P45）。
    let maxDist = 0;
    let maxDistBlock = null;

    // 新增常量（见文件顶部 `MAX_SCAN_BLOCK_POSITIONS` 的注释）：
    // 遍历兜底 —— 全空气区域里 `solids` 永远不涨，必须有第二个闸门。
    // 取 18513（= radius 16 的立方体全量），即"最多把整个请求范围走一遍"。
    const MAX_SCAN_VISITS = 18513;

    const consider = (px, py, pz) => {
      // ★★ P45 的核心：**配额只算"真的读到的非空气方块"。**
      //
      // 【旧语义的病】旧代码 `scanned++` 在**每一次坐标遍历**上，空气也吃配额。
      //   后果（实测）：她站在实心地层里时，最近的 1536 **格**全是包住她的土 ——
      //   `distinct: 6`、`radius=8` 与 `radius=16` 结果**完全相同**，
      //   20 格外的矿脉**永远看不见**。挖矿时这是致命的。
      //
      // 【新语义】空气不吃配额，只有"读到东西"才计数。于是同样是 6000 的预算，
      //   在空气多的地表能**看到更远**（空气便宜，直接跳过），
      //   在实心地层里则仍然是"最近的那一批土"
      //   —— 但**上限更高了（1536 → 6000），而且没有了排序开销**。
      //
      // ⚠️ 必须有一个"总遍历数"的兜底，否则在**全空气**区域会一路扫到 radius 边界
      //    之外。`MAX_SCAN_BLOCK_POSITIONS` 同时兼任这个兜底（见下）。
      if (visited >= MAX_SCAN_VISITS) { truncated = true; return false; }
      visited++;
      const p = new Vec3(px, py, pz);
      // 距离用**平方**比较/累加：免 sqrt。最终写进 `distance` 时才开方。
      const dx = px + 0.5 - state.bot.entity.position.x;
      const dyc = py + 0.5 - state.bot.entity.position.y;
      const dz = pz + 0.5 - state.bot.entity.position.z;
      const d2 = dx * dx + dyc * dyc + dz * dz;

      const block = state.bot.blockAt(p, false);
      if (!block || !block.name) return true;          // 未加载 / 认不出
      if (block.boundingBox === 'empty' && !block.name.includes('water')) {
        return true;                                    // 空气：**不吃 solids 配额**
      }
      if (solids >= MAX_SCAN_BLOCK_POSITIONS) { truncated = true; return false; }
      solids++;

      const full = block.name;
      const bare = full.includes(':') ? full.slice(full.indexOf(':') + 1) : full;

      if (d2 > maxDist) { maxDist = d2; maxDistBlock = full; }

      if (filter && !full.toLowerCase().includes(filter) && !bare.toLowerCase().includes(filter)) return true;

      const dist = Math.sqrt(d2);
      let rec = counts.get(full);
      if (!rec) {
        rec = { name: full, count: 0, nearest: { x: px, y: py, z: pz }, distance: +dist.toFixed(1) };
        counts.set(full, rec);
      }
      rec.count++;
      if (dist < rec.distance) {
        rec.distance = +dist.toFixed(1);
        rec.nearest = { x: px, y: py, z: pz };
      }
      return true;
    };

    // 洋葱遍历：`dy` **外层**（先扫完同层所有水平距离），`level` 内层逐层外扩。
    // 每层内部：先走 `dy`（同层优先），再走该层的**边框**（不是整个方块 ——
    // 内部那些在上一个较小的 level 里已经走过了）。
    outer:
    for (const dy of dyOrder) {
      for (let level = 0; level <= radius; level++) {
        if (level === 0) {
          if (!consider(origin.x, origin.y + dy, origin.z)) break outer;
          continue;
        }
        // 该水平的"环"：x 取两端，z 走全程
        for (let dz = -level; dz <= level; dz++) {
          if (!consider(origin.x + level, origin.y + dy, origin.z + dz)) break outer;
          if (!consider(origin.x - level, origin.y + dy, origin.z + dz)) break outer;
        }
        // z 取两端（避开已走过的角），x 走内部
        for (let dx = -level + 1; dx <= level - 1; dx++) {
          if (!consider(origin.x + dx, origin.y + dy, origin.z + level)) break outer;
          if (!consider(origin.x + dx, origin.y + dy, origin.z - level)) break outer;
        }
      }
    }

    // 按"最近距离"排序 —— 她问"旁边有什么"时，最近的才是第一顺位要考虑的
    const blocks = [...counts.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    // ---- 面向采集的分类（用户要求：「提高对环境的感知速度，比如挖矿」）------------
    //
    // 原来的 `/scan` 只给"有哪些方块"，于是挖矿时上层还得自己判断
    // "哪个能挖 / 哪个该挖 / 我挖得动吗"。判断一次要查 drops 表、查硬度、
    // 查手上的工具 —— 这些**网桥本地就能算**，没必要让上层每次重算。
    //
    // 这不是"多加一个字段"，是**把判断搬到数据旁边**：
    //   · 上层拿到 `harvestable` 就能直接决策，不用再发一轮请求
    //   · 判断规则只写一遍，不会出现"decision.js 和 autopilot.js 各有一套"
    //
    // `worthMining` 的判据：这个方块**能挖动**，且**挖了真的有产出**。
    //
    // ⚠️⚠️⚠️ 2026-09-25 第六次实战抓出来的（field-log **P20**）：
    //   上面这段注释原来写的是"挖了有掉落物"，但代码只查了 `drops` ——
    //   **漏了"需要什么工具"这一整维**。原版规则是：
    //     石头/方解石/所有矿石 —— 徒手挖会**破坏方块但不掉落任何东西**。
    //   而 `minecraft-data` 的 `drops` 表只写"用什么工具挖会掉什么"，
    //   **不写"需要工具"** —— 于是 `drops:['cobblestone']` 被读成了
    //   "挖了就有鹅卵石"，真相是"**用镐子**挖才有"。
    //
    //   实战代价（决定性实验）：
    //     POST /mine {"blockName":"stone","count":3}
    //     → mined: 3      ← 世界真的变了，3 块石头消失
    //       invDelta: 0   ← 但背包**一件都没多**
    //   上层看到的全是"成功"，而进展是零 —— **我们让她在做没有产出的劳动**。
    //
    //   修法：把 `harvestTools` 接进判据（这个字段一直都在，从没用过）。
    //   实测数据（真实 minecraft-data）：
    //     stone      harvestTools={779,784,789,794,799,804}  ← 需要镐子
    //     iron_ore   harvestTools={784,794,799,804}          ← 需要更高级的镐子
    //     dirt/oak_log/sand/gravel/clay  harvestTools=undefined  ← 徒手就行
    //
    // 于是 `worthMining` 变成一个**三态**判断（与 P4 的"我查不到 ≠ 它不行"同构）：
    //   · true  —— 现在挖就有产出
    //   · false —— 挖了也没有（缺工具），**必须在输出里说出来**，不能默不作声
    //   · null  —— 我不知道（模组方块，原版表里没有）
    const harvestable = blocks.map(b => {
      const def = state.bot.registry.blocksByName[b.name];
      let drops = null;
      let needsTool = null;
      let hardness = null;
      try {
        hardness = def?.hardness ?? null;
        // `drops` 在 minecraft-data 里是裸数字数组（如 [769]）或空数组。
        // ⚠️ 它在模组方块上**通常是空/undefined** —— 空不代表"没掉落"，
        //    只代表"原版表里没有它"。这个区别见 field-log 的 P4。
        const raw = def?.drops;
        drops = Array.isArray(raw) && raw.length
          ? raw.map(id => state.bot.registry.items?.[id]?.name ?? `#${id}`)
          : null;
        // ⚠️ `harvestTools` 存在 **且非空** 才说明"需要特定工具"。
        //    注意区分 `undefined`（原版里就是徒手可挖）与 `{}`（数据缺失）。
        //    实测：dirt/oak_log/sand 都是 `undefined`，而 stone 是 6 个 id 的对象。
        needsTool = def?.harvestTools
          ? Object.keys(def.harvestTools).length > 0
          : null;
      } catch (_) {}
      // 三态合成：只有"确定掉东西"且"确定不需要工具（或手上已经有了）"才算 true。
      let worthMining;
      if (drops === null) worthMining = null;              // 模组方块：不知道
      else if (drops.length === 0) worthMining = false;     // 原版表明确说没有掉落
      else if (needsTool === true) worthMining = false;     // ★ P20：缺工具 → 挖了也白挖
      else worthMining = true;
      return {
        ...b,
        hardness,
        // `null` = **不知道**（原版表里没有这个方块），不是"挖不到"。
        // ⚠️ 这个区分至关重要 —— P4 的教训就是"我不知道"被写成了"它不行"。
        drops,
        dropsKnown: drops !== null,
        // ★ P20 新增：挖这个方块**需不需要特定工具**。
        //   true  = 需要（徒手挖会破坏方块但**不掉落**）
        //   false = 不需要
        //   null  = 不知道（模组方块）
        needsTool,
        // ★ P21 新增：这是不是**人造方块**（玩家合成并放置的）。
        //
        //   2026-09-25 实战：修好 P20 之后，`/scan` 的短名单里突然全是
        //   `oak_planks x53` / `acacia_stairs x67` / `lantern` —— 而她当时
        //   **正站在一个玩家的建筑里**，之前"一路向下挖 15 格"挖的是人家的地基。
        //
        //   ⚠️ 注意这个判定**只标注、不隐藏**：
        //     she 完全可能**需要**木板/台阶去建自己的房子（这些正是好建材）。
        //     要拦的不是"挖人造方块"，而是"**拆别人的建筑**"。
        //     所以信息给出去，让上层自己决定（比如只看自然方块，
        //     或者在别处找同样的材料）。
        built: isPlayerBuilt(b.name),
        // 唯一能给的可执行结论：现在挖有没有东西掉出来。不知道时给 null，不猜。
        worthMining,
        // 为什么不能挖 —— 让上层能**说出原因**，而不是只看到一个 false。
        worthMiningWhy: worthMining === false
          ? (needsTool === true
            ? '需要工具（徒手挖会破坏方块但不掉落物品）'
            : '原版掉落表里没有产出')
          : undefined,
      };
    });

    // 直接给一份"该挖哪些"的短名单 —— 上层不必再从 blocks 里自己过滤。
    // 排序：先按"确定有收获"（worthMining===true 优先，unknown 次之），再按距离。
    const mineable = harvestable
      .filter(b => b.worthMining !== false)
      .sort((a, b) => {
        const av = a.worthMining === true ? 0 : 1;
        const bv = b.worthMining === true ? 0 : 1;
        if (av !== bv) return av - bv;
        return a.distance - b.distance;
      })
      .slice(0, 8)
      .map(b => ({
        name: b.name, count: b.count, distance: b.distance, nearest: b.nearest,
        drops: b.drops, worthMining: b.worthMining,
        // ★ P20：把"缺工具"这件事**带出去**。只给一个 false，
        //   上层无从知道是"没产出"还是"缺工具" —— 而两者的下一步完全不同
        //   （前者换目标，后者去搞一把镐子）。
        needsTool: b.needsTool === true ? true : undefined,
        // ★ P21：人造方块标记。**只标不过滤** —— 见 isPlayerBuilt 的注释。
        built: b.built === true ? true : undefined,
        why: b.worthMiningWhy,
      }));

    // 脚下/腿部/头部三格。抄 Mindcraft 的 `getSurroundingBlocks` ——
    // 这三格是"她能不能走/会不会淹/头顶有没有东西"的最短答案。
    const at = (dx, dy, dz) => state.bot.blockAt(origin.offset(dx, dy, dz), false)?.name ?? 'unknown';
    // ★ P21：把"能挖但很可能是别人建筑"的方块单独列出来。
    //   这是本轮最重要的环境信息 —— 修 P20 之前它完全被掩盖着。
    const builtAround = harvestable
      .filter(b => b.built === true && b.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map(b => ({ name: b.name, count: b.count, distance: b.distance }));
    // ★ P20：把"因为有工具需求而被排除"的方块单独列出来。
    //   全丢成 `[]` 是 P4 那类错误的变体：**"我把它过滤掉了"必须看得出来**。
    const toolBlocked = harvestable
      .filter(b => b.needsTool === true && (b.drops?.length ?? 0) > 0)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6)
      .map(b => ({ name: b.name, count: b.count, distance: b.distance, drops: b.drops }));
    return {
      radius, verticalRadius,
      scanned: visited,              // 兼容旧字段名：走过多少个坐标
      // ★ P45 新增：把"她到底能看多远"直接写出来。
      //   旧返回体只有 `scanned/truncated`，而实测里 `radius=8` 与 `radius=16`
      //   返回**完全一样**的内容（都被截到 1536 格 = 球半径约 7.16）——
      //   调用方**无从知道**自己看到的只有 7 格。加这两个字段之后，
      //   "看见了多远"变成一个可核对的数字。
      reach: {
        solids,                       // 真正读到的非空气方块数（= 现在的配额口径）
        maxDistance: +Math.sqrt(maxDist).toFixed(1),
        farthest: maxDistBlock,
      },
      truncated,
      budget: { solids: MAX_SCAN_BLOCK_POSITIONS, visits: MAX_SCAN_VISITS },
      limit, distinct: counts.size,
      standing: {
        below: at(0, -1, 0),
        legs: at(0, 0, 0),
        head: at(0, 1, 0),
      },
      blocks: harvestable,
      // 「我要挖矿」时直接看这个 —— 不用上层再算一遍
      mineable,
      // ★ P20：这些**有产出但你现在挖不了**（缺工具）。
      //   单独列出来，而不是混进 mineable —— 让上层能说
      //   "那片石头先别挖，得先有把镐子"。
      toolBlocked: toolBlocked.length ? toolBlocked : undefined,
      // ★ P21：周围有大量**人造方块** —— 很可能是玩家的建筑。
      //   这不是"不能挖"，而是"**挖之前先想一下这是不是别人的东西**"。
      //   判据说明：p21 是靠 P20 修好之后才看得见的（见 field-log）。
      builtAround: builtAround.length ? builtAround : undefined,
      builtNote: builtAround.length >= 3
        ? `周围有 ${builtAround.length} 类人造方块（${builtAround.slice(0, 3).map(b => b.name).join('/')}…）`
          + '—— 她可能**正站在玩家的建筑里**；拆别人的房子不是发育，是破坏。'
        : undefined,
      mineableNote: mineable.some(b => b.worthMining === null)
        ? '部分方块的掉落物未知（不在原版表里），不代表挖不到 —— 可以用 POST /mine {blockName} 直接试'
        : undefined,
      hint: truncated
        ? `走过 ${visited} 格就停了（读到 ${solids} 个方块，上限 ${MAX_SCAN_BLOCK_POSITIONS}），`
          + `现在最远看到 ${Math.sqrt(maxDist).toFixed(1)} 格 —— 缩小 radius 会更细，加大 radius 会更远`
        : undefined,
    };
  },

// POST /eat 在 hands.js（按背包前后变化核对到底吃没吃；原来这里依赖没装的 auto-eat 插件，调用必失败）

  // ---------------------------------------------------------------- 主动拾取
  //
  // ⚠️ 掉落物的拾取**是服务端判定的** —— bot 走到掉落物附近就会自动捡起来，
  //    客户端不需要做任何事。所以这个端点的语义是"**走过去**"，不是"捡起来"。
  //    社区里搜不到"bot 不捡东西"的抱怨正是这个原因（生态默认让 bot 一直在走动）。
  //
  // HiyoriAI 有独立的 `pickup_drops` 动作（默认 radius 8）；
  // Mindcraft 的 `item_collecting` 模式有**防抖 bug**（`entity !== prev_item`
  // 比对的是每 tick 重建的实体对象，恒真，`wait:2` 形同虚设），**我们没有抄它**。
  'POST /pickup': async ({ radius = 8, count = 4, timeoutMs = 8000 } = {}) => {
    radius = Math.min(Math.max(1, +radius), 32);
    count = Math.min(Math.max(1, +count), 32);

    const self = state.bot.entity;
    // ⚠️⚠️ 这里原来用 `e.objectType === 'Item'` 判掉落物 —— 而 `objectType`
    //   在 prismarine-entity 里是**废弃 getter**，实现是 `return this.displayName`，
    //   每次读取都会 `console.trace()` 打一整坨堆栈（见 field-log P7）。
    //   上次修 P7 时只改了 `/nearby` 和 `/collect`，**漏了这个 `/pickup`** ——
    //   于是堆栈又从这里冒出来。现在统一走 `isDropEntity`。
    //
    //   顺带纠正上面那条旧注释的错误：`name === 'item'` 其实**是**能匹配到的
    //   （实战里掉落物的 `name` 就正好是 'item'，`displayName` 才是 'Item'）。
    //   真正不能用的是 `objectType`（废弃）和 `e.name === 物品显示名`（会一条不中）。
    const drops = Object.values(state.bot.entities)
      .filter(e => e && e !== self && e.position && e.isValid !== false)
      .filter(isDropEntity)
      .filter(e => e.position.distanceTo(self.position) <= radius)
      .sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position))
      .slice(0, count);

    if (!drops.length) return { found: 0, walkedTo: 0, picked: 0, message: `${radius} 格内没有掉落物` };

    // ⚠️⚠️⚠️ P32（2026-09-25 实机抓出）：**必须自己统计"捡到了几个"。**
    //
    //    上面那段注释早就写对了 —— "`walkedTo` 是走到了不是捡到了；捡了几个
    //    得看背包，客户端没有拾取事件，只能靠前后对比"。**但它只说了，没做。**
    //    返回体里从来就没有 `picked` 这个字段。
    //
    //    后果是真的会卡死（实机证据）：
    //      · 她站在 y=87，掉落物在 y=85（掉进自己挖的坑里）
    //      · `goto` 到"水平 2 格内"就返回成功（球心已按 P30 修成 selfY）
    //      · 但她够不着 y=85 的东西 → 背包一件没多
    //      · `/pickup` 照样报 `walkedTo: 3`（走到了！）→ autopilot 看到
    //        `ok: true` → 不退避 → 下一拍又去捡 → **无限循环**
    //
    //    这是 P26 的同类问题（"我以为它做完了" vs "它真的做完了"），
    //    只是从**观测层**下沉到了**动作层**：动作自己谎报成功，
    //    于是上层所有基于 `ok` 的机制（失败退避、重试上限）**全部失效**。
    //
    //    教训：**一个动作的返回值里，必须有"世界真的变了"的证据**，
    //    不能只有"我发了请求 / 我走到了"。所以这里记背包快照，循环后对比。
    const snapBefore = inventoryFingerprint();

    state.currentAction = `picking up ${drops.length} drops`;
    let walkedTo = 0;
    const failed = [];
    try {
      for (const d of drops) {
        if (!d.isValid || !d.position) continue;
        // ⚠️⚠️⚠️ 2026-09-25 实战（P25）：这个循环里踩了**三层**坑，
        //     全部围绕"`goto()` 的 promise 什么时候算结束"。写清楚，别再犯：
        //
        //   ① **目标类型**：原来用 `GoalFollow(d, 1)`。它在 `isEnd()` 里要求
        //      "进入 range 且视线可达"，掉落物掉进自己挖的坑里（视野被挡）
        //      就**永不完成** —— 配上超时 = 每次必然走满超时。
        //      → 换成 `GoalNear`（"到达"型目标，到了就结束）
        //
        //   ② **不能在结束之后清 goal**：`setGoal(null)` 会 emit
        //      `goal_updated(null)`，而下一个 goto 的 listener 已经注册好在等，
        //      收到 null 就报 `GoalChanged`。
        //      → 清理只放在**发起 goto 之前**（此刻无人等待）
        //
        //   ③ **超时会让 goto 的 promise 永远挂着**（这一层最隐蔽）。
        //      `withTimeout` 只是 `Promise.race([goto, timer])` —— timer 赢了
        //      只是**我们不等了**，`goto` 自己的 promise 还在 pump，
        //      它的 `goal_updated` / `goal_reached` / `path_stop` listener
        //      **全部挂着不摘**。下一个 goto 一 `setGoal(goalB)` 就撞上
        //      上一个残留的 listener（它绑的是 `goalA`）→ `goalB !== goalA`
        //      → 报 `GoalChanged`。
        //      实测证据：`GET /debug/pathfinder` 的 `goal_updated` listener
        //      数**稳定停在 2**（正常应该是 1 或 0），而 `walkedTo` 恒为 1
        //      —— 也就是"只有第一个目标真的跑过"。
        //
        //      → 修法：**超时时把那个 promise 收干净**。`stop()` 会让它收到
        //        `path_stop` 并 settle，listener 随之摘掉。所以 `stop()` 必须调，
        //        而且**要给它一个 tick 去完成清理**（`goto.js` 的 `cleanup()`
        //        里是 `setTimeout(..., 0)`）。
        //
        //   ④ **球心的 y 不能直接用掉落物的，也不能死锁在她自己的高度**（P30 + P33）。
        //
        //      P30 修的是"用 `p.y` → 她下不去坑 → 原地打转"；
        //      但 P30 的修法（球心一律用 `selfY`）**引入了反向的错**：
        //      球心锁在她**当前**高度 → 她永远不下坑 → 站在坑沿上够不着坑底。
        //
        //      ⚠️ 实机证据（P33，2026-09-25）：
        //        `POST /pickup` 返回 `walkedTo: 3, picked: 0, ok: false`
        //        她 (-1,87,-3) 站在坑沿，掉落物在 y=85/86 的坑底空气格里，
        //        中间 (-1,86,-4) 是实心 —— 那是个 1 格宽的竖井，她在井口外。
        //        走到"水平 2 格内"就停，而**拾取是 3D 判定**，垂直差 2 格拿不到。
        //
        //      正确的语义：**"站到她能够着这堆东西的那一层"**。
        //        · 物品在她脚下 1 格内（y ∈ [selfY-1, selfY]）→ 就用物品的 y
        //          （那里她下得去：1 格落差可以直接走下去，不需要挖）
        //        · 物品更深（y < selfY-1）→ 夹到 `selfY-1`，即"站在最近的
        //          可站层，靠拾取半径够到"。**绝不要求她挖穿地形**（canDig=false）。
        //        · 物品在她头顶之上 → 夹到 `selfY`（不要为了够着而往天上爬）
        //
        //      这样 P30（不下坑打转）和 P33（永不落坑）同时被满足。
        const selfY = Math.floor(state.bot.entity?.position?.y ?? 0);
        const selfFeetY = selfY;
        // ⚠️⚠️⚠️ P43（2026-09-25）：**改了这里**。原来只有
        //    `const targetY = reachableStandY(d.position.y, selfFeetY);`
        //    —— 那是"只看两个 y 就算出答案"的纯函数，**它不知道物品压在方块上**。
        //
        //    实测反例：物品报告 `y=85`，而 `(-7,85,-8) = grass_block`（实心），
        //    物品真正的空间在 `y=86`。旧函数返回 85 → `standable` 拦掉 →
        //    退回 `GoalNear(球心 85)` → 球内含她自己 → **一步不动**，
        //    而她其实距物品只有 0.97 格。**"看得见摸不着"就是这个。**
        //
        //    新函数会把候选层逐个拿去问世界（脚+头都要可站），
        //    找出**真的站得进去**的那一层。硬约束（不上天 / 不下潜超 1 格）保留。
        const targetY = findStandY(
          d.position.y, selfFeetY,
          (bx, by, bz) => state.bot.blockAt(new Vec3(bx, by, bz)),
          Math.floor(d.position.x), Math.floor(d.position.z),
        );

        // ⚠️⚠️ P38：**半径随垂直落差自适应** —— 但要说清楚它修了什么、没修什么。
        //
        //    【修了什么】`GoalNear` 判据是"欧氏距离 ≤ r"。落差 3 格时，
        //      r=2 的球内**在 xz 平面上一个点都没有**（√(h²+9) ≥ 3 > 2 恒成立）
        //      → `goto` **必然走满超时**，纯浪费时间。半径 ≥ 落差+1 保证球内有点。
        //
        //    【没修什么】落差 1 格、r=2 时球内**有**点 —— **就是她自己站的格**
        //      → 她判定"已到达" → 不动 → 还是拿不到。
        //      **所以自适应半径治不了"她不肯往下走"。**
        //      实测里她从 y=90 下到 y=88，那是寻路器**为了进入球内**自己走的路，
        //      不是"为了捡东西而下行"。
        //
        //    【真正的限制】`GoalNear` 在原理上无法表达"下到那一格去"。
        //      要做到那个，需要点式目标（`GoalBlock`）或按键控制 ——
        //      那是 P34 的待决项，**刻意没做**（"主动带她下坑"是新行为面，
        //      掉进岩浆/水里的风险与捡回几块泥土的收益不成比例）。
        //
        //    ⚠️ 所以这里的定位是：**把最坏情况从"必然超时"降到"有界失败"**，
        //       失败后由 P32 的退避机制接管，链路不会卡死。
        const vertGap = Math.abs(selfFeetY - targetY);
        const reachRadius = Math.max(2, vertGap + 1);

        pathing.clearPathfinderGoal(state.bot.pathfinder);
        try {
          const p = d.position;
          // ⚠️⚠️⚠️ P34 修复（2026-09-25 实机验证）：
          //    物品**在她下方**时改用 `GoalBlock`，不再用 `GoalNear`。
          //
          //    【为什么】`GoalNear(p.x, selfY-1, p.z, r)` 的球心在 `selfY-1`，
          //      而**球内包含她自己当前站的格**（水平距离 0 ≤ r）→
          //      寻路器判定"已经到达" → **一步不动**。
          //      实机：`{"walkedTo":1,"picked":0,"ok":false}` 反复出现。
          //
          //    【实机反证】同一个人、同一格物品，我手动 POST /move 到
          //      `{"x":-9,"y":86,"z":-8}`（即 `GoalBlock`）→ **她真的下去了**：
          //        `{"success":true,"arrived":{"x":-8,"y":87,"z":-8}}`
          //        位置 `y: 87 → 86` ✓，而且**顺手把物品捡了**（背包 20→21）。
          //      结论：**她能下这一格，只是 `GoalNear` 表达不了"下到那一格去"。**
          //
          //    【所以】落差 ≥ 1 且**目标格站得进去**（脚+头两层都可站）时，
          //      用 `GoalBlock(targetY 那一格)` —— 那是"点式目标"，没有"already
          //      there"的歧义。落差 0 时仍用 `GoalNear`（保留原来的容错，
          //      不必精确踩到某一格）。
          //
          //    ⚠️ 为什么**只在她下方**时才换：物品在她**上方**时 `targetY = selfY`
          //      （见 `findStandY` 的"绝不上天"约束），本来就是同一层，
          //      用 `GoalNear` 更稳（不会因为要求精确站位而失败）。
          //
          //    ⚠️⚠️ P43 修正：`wantY` 从 `floor(物品的 y)` 改成 **`targetY`**。
          //      理由就是 P43 的根因 —— 物品报告的 y **可能是实心方块**
          //      （物品躺在方块顶面上），直接拿它当目标层必然站不进去。
          //      `targetY` 是 `findStandY` 已经**逐层问过世界**选出来的可站层，
          //      所以 `standable` 这一步现在是**校验**（防竞态：选完之后世界变了），
          //      而不是"原来那样用错误的层去试"。
          const wantY = targetY;
          const descends = Number.isFinite(wantY) && wantY < selfFeetY;
          // 目标格站得进去吗？（脚层与头层都不是实心）
          // 复用 `isStandable` —— 与 `/shelter` 的 `selfIsAiry` **同一个判据**
          //（P42 的教训：写完判定函数就该拿它解释眼前的失败）。
          const standable = (() => {
            if (!descends) return false;
            const feet = state.bot.blockAt(new Vec3(p.x, wantY, p.z));
            const head = state.bot.blockAt(new Vec3(p.x, wantY + 1, p.z));
            return isStandable(feet) && isStandable(head);
          })();

          // ⚠️ P43 第二处：落差为 0 时也**值得**用 `GoalBlock` —— 只要目标格
          //    真的站得进去、且她**不在那一格**（在隔壁）。否则 `GoalNear` 的
          //    球内会包含她自己站的格 → 判"已到达" → 一步不动（这就是 0.97 格
          //    那个"看得见摸不着"）。但**不能无脑换**：物品就在她自己那格时
          //    `GoalBlock` 只会立刻 success（P44 的语义歧义），没有收益。
          const selfCellX = Math.floor(state.bot.entity?.position?.x ?? 0);
          const selfCellZ = Math.floor(state.bot.entity?.position?.z ?? 0);
          const adjacent = (Math.floor(p.x) !== selfCellX || Math.floor(p.z) !== selfCellZ);
          const useBlock = standable && (descends || adjacent);

          const goal = useBlock
            ? new goals.GoalBlock(p.x, wantY, p.z)     // ★ "走到/下到那一格去"
            : new goals.GoalNear(p.x, targetY, p.z, reachRadius);

          const r = await withTimeout(state.bot.pathfinder.goto(goal), timeoutMs);
          walkedTo++;
          // 挖到/走到之后**立刻试着真正拾取一次**：有些情况下服务端要等到
          // 下一次实体 tick 才结算，`goto` 返回时她其实已经在范围内了。
          // 这一步是"顺手一捞"，失败不影响主流程（真正的判据在循环末尾的背包对比）。
          try { await sleep(120); } catch (_) {}
          void r;
        } catch (e) {
          failed.push({ name: d.name || 'unknown', reason: e.message });
        }
        // ★ 让上一个 goto 彻底 settle：`stop()` 会 emit `path_stop`，
        //   触发 `goto.js` 的 `pathStopped` → 摘掉全部 listener。
        //   后面再等一个 tick 是必须的 —— `goto.js` 的 cleanup 自己就是
        //   `setTimeout(..., 0)`，不等的话下一个 goto 会撞上尚未摘掉的 listener。
        try { state.bot.pathfinder.stop(); } catch (_) {}
        await sleep(0);
      }
    } finally {
      // 循环彻底结束，**此时没有任何 goto 在等** —— 这是唯一安全的清理位置。
      pathing.clearPathfinderGoal(state.bot.pathfinder);
      state.currentAction = null;
    }

    // ⚠️ P32：用**背包前后差**给出"真的捡到了几个"。这是这个端点的**唯一可信答案**。
    //    `walkedTo` 保留（它对排查仍有价值 —— 能区分"没走到"和"走到了但拿不着"），
    //    但它**不再是成功判据**。
    const snapAfter = inventoryFingerprint();
    const picked = fingerprintDelta(snapBefore, snapAfter);
    const gained = snapAfter.total - snapBefore.total;

    return {
      found: drops.length,
      walkedTo,
      picked,                       // ★ 真的进背包的件数（P32）
      gained,                       // 件数净变化（可能因消耗为负）
      // 判据：走到了、但背包没变 → **明确报失败**，让上层能退避。
      // 只"走到"不算数 —— 这正是 P32 要修的那个谎。
      ok: picked > 0,
      failed: failed.length ? failed : undefined,
      note: picked > 0
        ? undefined
        : (walkedTo > 0
          ? '走到了掉落地，但有几件没进背包（可能被地形挡住或在脚下够不着）'
          : '一件都没走到'),
    };
  },

  // ---------------------------------------------------------------- 插件自检
  //
  // 为什么需要：三个插件都是**可选**加载（装了就用、没装降级），
  // 于是"到底装上没有"变成了一个必须能正面回答的问题 —— 否则
  // "她不吃东西"和"插件没装"这两种情况在外部看起来完全一样。
  'GET /plugins': async () => ({
    loaded: {
      pathfinder: !!pathfinderPlugin,
      tool: !!toolPlugin,
      collectblock: !!collectBlockPlugin,
      autoEat: !!autoEatPlugin,
    },
    // 这三个是**可选**的，缺失只影响对应能力，不影响网桥启动
    optional: ['tool', 'collectblock', 'autoEat'],
    installHint: (toolPlugin && collectBlockPlugin && autoEatPlugin)
      ? null
      : 'cd ~/.workbuddy-ai/skills/minecraft-bridge && '
        + 'npm install mineflayer-auto-eat mineflayer-tool mineflayer-collectblock',
    // 运行时状态（连上才有）
    runtime: {
      autoEat: state.pfAutoEat ?? null,
      // collectblock 自己那份 movements 有没有套上"只绕不拆"与流体防护
      collectBlockPolicy: state.pfCollectFluid ?? null,
    },
    // 物品/方块能力开关，方便一眼看出"为什么她不挖"
    capabilities: {
      allowDig: cfg('MC_ALLOW_DIG', 'false') === 'true',
      autoEatEnabled: cfg('MC_AUTO_EAT', 'true') === 'true',
      autoEatMinHunger: parseInt(cfg('MC_AUTO_EAT_MIN_HUNGER', '16'), 10),
      scanMaxPositions: MAX_SCAN_BLOCK_POSITIONS,
      // ★ P45：口径改了 —— 现在是"读到多少个**非空气方块**"（空气不吃配额）。
      //   旧口径是"走过多少个坐标"，导致她被实心土围着时配额全被空气/土吃光。
      scanBudgetNote: `solids=${MAX_SCAN_BLOCK_POSITIONS}（空气不吃配额），visits=${18513}`,
      scanUsesSort: false,        // ★ P45：已删除"建数组+全排序"，改洋葱遍历
    },
  }),

  // ---- 实体诊断（P8 专用）-----------------------------------------------------
  //
  // 为什么需要它：`/nearby` 报的是**我们加工后的**结论（`isDrop`/`kind`），
  // 而 P8 的症状正是"加工出来的结论全错、且错得一致"（65 个实体全叫 unknown）。
  // 这时候再看加工结果没有意义 —— 必须能看到**原始字段**。
  //
  // 这个端点是只读的、无副作用的，代价是一次 map 遍历。
  // 我宁可在生产代码里留一个诊断口，也不愿意下次再花一小时去猜。
  'GET /entities': async ({ limit = 20 } = {}) => {
    const self = state.bot.entity;
    const all = Object.values(state.bot.entities);
    const rows = all
      .filter(e => e && e !== self)
      .map(e => {
        const pos = e.position;
        return {
          // ---- 身份：这三个字段是我们所有判据的基础 ----
          name: e.name ?? null,
          displayName: e.displayName ?? null,
          type: e.type ?? null,
          // `entityType` 是**服务端下发的原始数字 id**（不经过名字解析）。
          // P8 的关键就在这里：如果它是个正常数字，说明是"名字解析"坏了；
          // 如果它是 undefined/0，说明"类型同步"本身就坏了。
          entityType: e.entityType ?? null,
          // mineflayer 按 id 反查出来的注册表条目（名字解析的结果）
          registryName: (() => {
            try {
              const t = e.entityType;
              if (t == null) return null;
              return state.bot.registry.entities?.[t]?.name ?? null;
            } catch (_) { return null; }
          })(),
          // ---- 位置与存活 ----
          distance: pos && self?.position ? Math.round(pos.distanceTo(self.position) * 10) / 10 : null,
          position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
          isValid: e.isValid !== false,
          // ---- 我们当前用的判据的**原材料** ----
          // 掉落物的物品 id 藏在 metadata 里。`/collect` 一直就是这么解析的，
          // 这条路**不依赖 name**  —— 见 field-log P8。
          metadataItemId: e.metadata?.[8]?.itemId ?? null,
          metadataItemName: (() => {
            const id = e.metadata?.[8]?.itemId;
            if (id == null) return null;
            try { return state.bot.registry.items?.[id]?.name ?? null; } catch (_) { return null; }
          })(),
          // 生物会带生命值（metadata index 9 通常是 health，随版本/实体有差异）
          metadataHealth: e.metadata?.[9] ?? null,
          health: e.health ?? null,
          // 实体有没有"打过我们"这类信息（用于判断敌意）
          objectData: e.objectData ?? null,
          metadataKeys: e.metadata ? Object.keys(e.metadata).length : 0,
        };
      })
      .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
      .slice(0, Math.min(Math.max(1, +limit), 100));

    const named = rows.filter(r => r.name && r.name !== 'unknown').length;
    return {
      total: all.length,
      sampled: rows.length,
      // ⚠️ 这两个数字放在最显眼处：P8 的教训是"全是 unknown"这件事
      //    在单个字段里看不出来（每个字段单独看都很正常），
      //    只有把它**聚合成比例**才刺眼。
      namedCount: named,
      unknownCount: rows.length - named,
      namedRatio: rows.length ? Math.round((named / rows.length) * 1000) / 1000 : null,
      registryEntityCount: (() => {
        try { return Object.keys(state.bot.registry.entities || {}).length; } catch (_) { return null; }
      })(),
      rows,
    };
  },

  // 转头看向某个玩家或坐标
  'POST /look': async ({ playerName, x, y, z }) => {    if (playerName) {
      const t = state.bot.players[playerName]?.entity;
      if (!t) throw new Error(`Player ${playerName} not found or too far away`);
      await state.bot.lookAt(t.position.offset(0, t.height ? t.height * 0.9 : 1.6, 0), true);
      return { lookingAt: playerName };
    }
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('either playerName, or all of x/y/z, required');
    }
    await state.bot.lookAt(new Vec3(+x, +y, +z), true);
    return { lookingAt: { x: +x, y: +y, z: +z } };
  },

  // 近战攻击：默认打最近的敌对生物，也可以指定 target=<实体名>
  'POST /attack': async ({ target, radius = 4 }) => {
    radius = Math.min(Math.max(1, +radius), 16);
    const HOSTILE = new Set([
      'skeleton', 'zombie', 'spider', 'creeper', 'witch', 'enderman', 'husk', 'stray',
      'drowned', 'phantom', 'pillager', 'vindicator', 'ravager', 'slime', 'magma_cube',
      'blaze', 'ghast', 'wither_skeleton', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin',
    ]);
    const self = state.bot.entity;
    const candidates = Object.values(state.bot.entities)
      .filter(e => e !== self && e.position && e.isValid !== false)
      .filter(e => e.position.distanceTo(self.position) <= radius)
      .filter(e => (target ? e.name === target : HOSTILE.has(e.name)))
      .sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position));

    if (!candidates.length) {
      return { attacked: 0, message: target ? `no ${target} within ${radius}` : `no hostile mob within ${radius}` };
    }

    state.currentAction = `attacking ${target || 'hostile mob'}`;
    let hits = 0;
    try {
      for (const e of candidates.slice(0, 3)) {
        for (let i = 0; i < 6; i++) {
          if (!e.isValid || !e.position) break;
          if (e.position.distanceTo(state.bot.entity.position) > radius + 2) break;
          try {
            await state.bot.lookAt(e.position.offset(0, e.height ? e.height * 0.6 : 0.9, 0), true);
          } catch (_) {}
          state.bot.attack(e);
          hits++;
          await new Promise(r => setTimeout(r, 350));
        }
      }
    } finally {
      state.currentAction = null;
    }
    return { attacked: hits, targets: candidates.slice(0, 3).map(e => e.name) };
  },

  // 从背包装备物品：destination = hand | off-hand | head | torso | legs | feet
  //
  // 两种用法：
  //   ① `{ itemName: 'diamond_pickaxe' }` —— 明确指定换哪件（原行为，未变）
  //   ② `{ auto: true, want: 'tool'|'weapon'|'any' }` —— 让服务端**按当下情境**决定
  //
  // 为什么要有 ②：判据只能住在看得见 `heldItem` 的那一侧。autopilot 那边
  // 只表达"我想换"（它在决策菜单里没有"换哪件"这个维度），
  // 真正的挑选在 decision.js 的 `pickAutoEquip` 里，可离线穷举。
  'POST /equip': async ({ itemName, destination = 'hand', auto = false, want = 'any' }) => {
    if (auto) {
      const held = state.bot.heldItem?.name ?? null;
      const inventory = state.bot.inventory.items().map(i => i.name);
      const pick = pickAutoEquip({ held, inventory, want });
      if (!pick.itemName) {
        return { equipped: null, held, reason: pick.reason, changed: false };
      }
      const item = state.bot.inventory.items().find(i => i.name === pick.itemName);
      if (!item) {
        // 理论上到不了这里（名字刚从这个列表里取出）。留着是为了不静默。
        return { equipped: null, held, reason: `背包里找不到 ${pick.itemName}`, changed: false };
      }
      await state.bot.equip(item, destination);
      return {
        equipped: pick.itemName,
        itemName: pick.itemName,
        from: held,
        destination,
        reason: pick.reason,
        changed: true,
      };
    }
    if (!itemName) throw new Error('itemName required（或传 auto: true）');
    const item = state.bot.inventory.items().find(i => i.name === itemName);
    if (!item) throw new Error(`Not carrying ${itemName}`);
    await state.bot.equip(item, destination);
    return { equipped: itemName, itemName, destination, changed: true };
  },

  // 发聊天。两种用法（向后兼容）：
  //   {message}               一条（旧调用方、危险提示都走这个 —— 不拆）
  //   {messages:[..], gapMs}  几条短消息连发，条间有停顿（真人打字是"几条短句"，不是"一段话"，见 speech.js）
  //   gapMs 可以是数字，也可以是 [最小,最大] 区间（每次随机 —— 固定间隔反而机械）
  'POST /chat': async ({ message, messages, gapMs }) => {
    if (message) {
      state.bot.chat(String(message).slice(0, 256));
      return { sent: 1, messages: [String(message).slice(0, 256)] };
    }
    if (!Array.isArray(messages) || !messages.length) throw new Error('需要 message 或 messages[]');
    const pick = () => {
      if (Array.isArray(gapMs)) { const [a, b] = gapMs.map(Number); return a + Math.random() * Math.max(0, b - a); }
      return +gapMs || 450;
    };
    const sent = [];
    for (const m of messages) {
      const t = String(m || '').slice(0, 256);
      if (!t.trim()) continue;                      // 空段跳过，不发空消息
      if (sent.length) await sleepMs(Math.max(0, Math.min(2000, pick())));
      state.bot.chat(t);
      sent.push(t);
    }
    return { sent: sent.length, messages: sent };
  },

  // 放置方块。真玩家能把东西放回去 —— 在这之前接口只能挖不能放，
  // 于是"把羊毛放回房子"这件事她根本做不到，只能一直道歉。
  // 用法：给目标坐标 (x,y,z)，自动挑一个相邻的实心方块当参照面。
  //
  // 放置有四个硬条件（少一个就会失败，而且是**静默**失败）：
  //   ① 相邻必须有一个实心方块当参照 —— 空气里放不了
  //   ② 那个面必须看得见 / 没被挡
  //   ③ 眼睛到接触点的距离 < 4.5 格 —— 够不着就是够不着，硬调只会拿到超时
  //   ④ 自己的身体不能占着目标格 —— 否则会把自己卡进方块里
  // ①③④ 是纯几何，住在 place.js 里并已离线穷举（node place.js --selftest）；
  // ② 需要射线检测，只能在这里用 lookAt 的结果兜底。
  // 满足之后还要**等世界真的更新**才算成功（客户端预测会造假）。
  'POST /place': async ({ itemName, x, y, z, confirmMs }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x, y and z required');
    }
    const bot = state.bot;
    const target = new Vec3(Math.round(+x), Math.round(+y), Math.round(+z));

    const at = bot.blockAt(target);
    if (!at) throw new Error(`Position out of range: ${target.x},${target.y},${target.z}`);

    // 目标位置必须是可替换的（空气/水/草之类），否则会覆盖掉玩家的东西
    const REPLACEABLE = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava|grass|tall_grass|short_grass|fern|large_fern|snow|vine|dead_bush|seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/;
    if (!REPLACEABLE.test(at.name)) {
      throw new Error(`Refusing to overwrite ${at.name} at ${target.x},${target.y},${target.z}`);
    }

    // ---- 先站定。身体还在漂的时候放置会打偏到隔壁格去。
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    await sleepMs(150);   // 给服务端一两个 tick 收下"我停下来了"

    // 手里要放的方块：指定 itemName，或默认用当前手持
    const item = itemName
      ? bot.inventory.items().find(i => i.name === itemName)
      : bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');

    // ---- 条件 ①③④：交给 place.js 的纯几何判定
    const ep = bot.entity?.position;
    const feet = ep ? { x: ep.x, y: ep.y, z: ep.z } : null;
    const verdict = placeLogic.planPlacement({
      target: { x: target.x, y: target.y, z: target.z },
      getBlock: pos => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)),
      feet,
      height: bot.entity?.height,
    });

    if (!verdict.ok) {
      const faces = verdict.tried.join(', ');
      if (verdict.kind === 'self-occupied') {
        throw new Error(
          `Target cell is occupied by my own body (${target.x},${target.y},${target.z}) — step aside first`);
      }
      if (verdict.kind === 'too-far') {
        throw new Error(
          `Target out of reach (need < ${placeLogic.REACH} blocks from eyes) — walk closer first. Faces: ${faces}`);
      }
      if (verdict.kind === 'no-solid-neighbour') {
        throw new Error(
          `No solid neighbour to place against at ${target.x},${target.y},${target.z}. Faces: ${faces}`);
      }
      throw new Error(
        `Could not place ${item.name} at ${target.x},${target.y},${target.z}. Faces: ${faces}`);
    }

    // ---- 逐个试候选面。几何可行 ≠ 实际放得下：面可能被挡（②），
    //      也可能服务端在这一瞬间拒绝。第一个失败不该整体失败。
    let lastErr = null;
    let attempted = 0;
    for (const p of verdict.plans) {
      const ref = bot.blockAt(new Vec3(p.refPos.x, p.refPos.y, p.refPos.z));
      if (!ref) { lastErr = new Error(`reference block vanished at ${p.refPos.x},${p.refPos.y},${p.refPos.z}`); continue; }

      const contact = new Vec3(p.contact.x, p.contact.y, p.contact.z);
      const faceVec = new Vec3(p.face.x, p.face.y, p.face.z);

      // 条件②：先看过去。看得见才放得下（也顺手把视角摆正，避免打偏）
      try {
        await withTimeout(bot.lookAt(contact, true), 3000);
      } catch (e) {
        lastErr = new Error(`${p.label} face not lookable (${e.message})`);
        continue;
      }

      state.currentAction = `placing ${item.name} @ ${target.x},${target.y},${target.z}`;
      try {
        attempted++;
        await withTimeout(bot.placeBlock(ref, faceVec));
        // 等世界真的更新 —— placeBlock 返回 ≠ 服务端接受了
        const confirmed = await waitForBlock(bot, target, Math.min(Math.max(+confirmMs || 1500, 200), 5000));
        return {
          placed: item.name,
          at: { x: target.x, y: target.y, z: target.z },
          via: p.label,
          distance: p.distance,
          // confirmed=false 不代表失败，只代表"没在超时内看到更新"。
          // 可能是服务端延迟，也可能是幽灵方块 —— 调用方可用 GET /inventory 复核。
          confirmed,
          facesTried: attempted,
        };
      } catch (e) {
        lastErr = e;
      } finally {
        state.currentAction = null;
      }
    }

    throw new Error(
      `All ${verdict.plans.length} geometrically valid faces failed at ` +
      `${target.x},${target.y},${target.z}${lastErr ? ` (last: ${lastErr.message})` : ''}`);
  },

  // 给自己围一个紧急遮蔽（field-log P24 的 `shelter` 动作）。
  //
  // ⚠️⚠️ **为什么这个端点必须在网桥而不是 autopilot：**
  //    `/place` 要求调用方给出精确的 `x,y,z`，而"该把方块放在哪一格"这个问题
  //    只有网桥答得了 —— 它看得到真实地形、朝向、脚下是否悬空、哪一面能靠着放。
  //    autopilot 那边只有 `/scan` 的方块列表，**猜坐标必然打偏**。
  //    这和 P20/P21 是同一条原则：**判据住在看得见真相的那一侧。**
  //
  // ⚠️ **刻意不做的事（很重要）：**
  //    ① 不盖"3×3 土屋"。空间规划需要判断头顶有没有洞、门开在哪、
  //       而她站的位置可能本来就是玩家建筑的一部分 —— 盖错了会破坏玩家的东西。
  //    ② **不封死所有方向。** 最少留一面不封 —— 这是原版的"留门"。
  //       封死会让她卡在里面出不来，**后续所有动作全部失效**（比不搭还糟）。
  //    ③ 不动 `isPlayerBuilt` 的方块（见 P21）—— 只往**空气格**里放。
  //
  // 做法：以她脚下为中心，取水平 4 个相邻格里"最该封"的几格（排除她自己要走的出路），
  //    逐格套用 `/place` 已有的几何判定去放。
  'POST /shelter': async ({ itemName, blocks = 3, keepOpen } = {}) => {
    const bot = state.bot;
    const ep = bot.entity?.position;
    if (!ep) throw new Error('bot 没有位置（未连接？）');

    // 要放的方块
    const item = itemName
      ? bot.inventory.items().find(i => i.name === itemName)
      : bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');

    // ⚠️⚠️⚠️ P40（2026-09-25 实机抓出）：**"她站在哪一格"不能用 `Math.floor` 算。**
    //
    //    她的真实坐标是 `x=-9.5006, z=-6.5` —— **半格偏移**，她跨在格子边界上。
    //      · `Math.floor(-9.5006)` = **-10**，`Math.floor(-6.5)` = **-7**
    //      · 于是桥去探测 `(cx=-10, cz=-7)` 的四个方向
    //      · 逐格实测那四个方向：`dirt / andesite / dirt / dirt` —— **全是实心**
    //      · 而她真正占据的格子 `(-9, 87, -6)` 和 `(-10, 87, -7)` 都是 **air**
    //    结果：8 个候选格全被"只往空气格放"的过滤器滤掉 → 集合清空 →
    //    抛"脚边没有可放置的空位（四周全是实心）" —— **而她在开阔地里**。
    //
    //    实机证据：12 次调用**全部**失败，同一句错误，`placed` 永远是 0。
    //
    //    为什么 `floor` 在这里是错的：Minecraft 的格子归属是 `floor`，
    //    但**玩家碰撞箱宽 0.6 格**，站在 `x=-9.5006` 时她的身体横跨
    //    `x∈[-9.801, -9.201]`，**完全落在 -10 那一格之外**；
    //    她的**脚底方块**其实在 `-10` 格（因为 `floor(-9.5006) = -10` 是脚下方块），
    //    但"她人所在的位置"（该往哪几个方向堵）取决于**哪一格是空气、她站得进去**。
    //
    //    正确做法（与 `reachableStandY` 同一思路：**先看她实际能站的地方**）：
    //    ① 先试"她认为自己在的格"（`floor`，Minecraft 的官方语义）；
    //    ② 再试"四舍五入到最近的格"（`Math.round`）—— 半格偏移时它给出另半个格；
    // ⚠️⚠️⚠️ P40（2026-09-25 实机抓出，**两轮才定位对**）：
    //
    // 【第一轮我诊断错了 —— 记在这里当反面教材】
    //   我看到 `exact = {x:-9.5006, z:-6.5}`（半格），就先入为主地判定
    //   "`Math.floor` 在负坐标 + 半格偏移时算错格子归属"，并据此写了
    //   "floor/round 双候选"的代码。**这个结论是错的，而且我没跑逐格探测就下了定论。**
    //   我用 `Math.round(-6.5) = -7` 心算推出"floor 和 round 一样"，然后拿这个
    //   自相矛盾的现象当证据 —— 实际 `Math.round(-6.5) = -6`（向 +∞ 取整）。
    //   **错误的心算被当成了实测数据。**
    //
    // 【第二轮：逐格探测，真相】
    //   用 `/block` 把周围全部探一遍，`exact = (-9.5006, 87.0, -6.5)`：
    //     · 她这格     `(-10,87,-7)` = **air**  ← `Math.floor` 归属**是对的**
    //     · 她脚下     `(-10,86,-7)` = andesite（有地面，不是悬空）
    //     · 4 方向 × 2 层（feetY 与 feetY+1）：
    //         x+ (-9, 87,-7)=dirt        x+ (-9, 88,-7)=grass_block
    //         x- (-11,87,-7)=andesite    x- (-11,88,-7)=grass_block
    //         z+ (-10,87,-6)=dirt        z+ (-10,88,-6)=dirt
    //         z- (-10,87,-8)=dirt        z- (-10,88,-8)=grass_block
    //       → **8 个候选格全是实心，一个 air 都没有**
    //
    //   **所以 `/shelter` 抛"四周全是实心"说的是实话** —— 她正站在一条
    //   **天然形成的一格宽缝隙**里（头顶 `(-10,88,-7)=air`，说明缝只有一格高、
    //   四面被 dirt/andesite/grass_block 封死）。这地方**本来就有遮蔽**，
    //   既不需要、也不允许再封。
    //
    // 【真正的错在哪】不是取整，也不是白名单，而是**选址假设**：
    //   `shelter` 只会"原地封四周"，而她随机游走后经常正好站在这种
    //   天然闭合的缝里 → 必然失败。12 次调用全零，`placed` 永远是 0。
    //
    // 【修法（两件都做）】
    //   ① **先尝试挪一格**：如果四周全实心，就找附近一个"至少有 2 个空邻居"
    //      的位置走过去再封（`tryRelocate`）—— 这才是"建立庇护所"该有的行为。
    //   ② **挪不成，就如实判定"已有天然遮蔽"并返回成功**：因为遮蔽**确实存在**，
    //      报失败会让她陷入"needShelter 永远 true → 每 tick 都来试 → 永远失败"
    //      的死循环（P31 的形态）。**"这里不需要搭"不是错误。**
    //
    // 【保留的设计（第一轮写对的部分）】
    //   · 多格参与探测 + 去重（比"只挑一个 cx/cz"更稳，居中/跨格都对）
    //   · 自己身体占的格由 `place.js` 的 `bodyOccupies` 排除（不另写判定）
    //   · 白名单复用 `place.js` 的 `AIRY`（**不新建副本** —— 我第一轮新建了一个
    //     `AIRY_NAMES`，那正是 P39 说的"同一判据写两处"，已删除）
    const feetY = Math.floor(ep.y);

    // 身体（宽 0.6，半宽 0.3）覆盖到哪些**整格**。
    // 格 n 覆盖区间 [n, n+1)；身体覆盖 [c-hw, c+hw]；两者有**正长度**交集即算覆盖。
    // ⚠️ 必须用严格重叠判定，不能写成 `floor(c-hw)`/`floor(c+hw)` ——
    //    实测 `c=3` 时身体盒是 `[2.7, 3.3]`，**确实横跨格 2 和格 3**；
    //    而 `c=-9.5006` 时盒是 `[-9.8006, -9.2006]`，**完整落在格 -10 内**（不跨格）。
    //    这两种情形的区别就是"要不要多探一格"，得让几何自己说话。
    const spanOf = (c, halfWidth) => {
      const out = [];
      const lo = Math.floor(c - halfWidth) - 1;
      const hi = Math.ceil(c + halfWidth) + 1;
      for (let n = lo; n <= hi; n++) {
        if (n < c + halfWidth - 1e-9 && n + 1 > c - halfWidth + 1e-9) out.push(n);
      }
      return out.length ? out : [Math.floor(c)];
    };
    const selfCells = [];
    for (const x of spanOf(ep.x, placeLogic.HALF_WIDTH)) {
      for (const z of spanOf(ep.z, placeLogic.HALF_WIDTH)) selfCells.push({ x, z });
    }
    // 兜底：`floor` 是她**脚下地面**的归属格（Minecraft 官方语义），永远不该漏
    if (!selfCells.some(s => s.x === Math.floor(ep.x) && s.z === Math.floor(ep.z))) {
      selfCells.push({ x: Math.floor(ep.x), z: Math.floor(ep.z) });
    }
    // "她自己站得进去" —— 脚与头两层都可站立（含岩浆/仙人掌则不算）
    const selfIsAiry = (x, z) => {
      const feet = bot.blockAt(new Vec3(x, feetY, z));
      const head = bot.blockAt(new Vec3(x, feetY + 1, z));
      return isStandable(feet) && isStandable(head);
    };
    const pick = selfCells.find(c => selfIsAiry(c.x, c.z)) || selfCells[0];
    const cx = pick.x;
    const cz = pick.z;

    // 4 个水平方向 × 她覆盖的每一格（去重）
    //
    // ⚠️ `y` 取 feet 与 feet+1 **两层**：单层封不住 —— 僵尸高 1.95 格，
    //    只堵脚那层它能从上面越过来（还能从缝里看到/攻击她）。
    // ⚠️ 但**不封她自己站的那一格**，也不封头顶（否则窒息）—— 由下面的
    //    `bodyOccupies` 负责排除（它用的就是身体跨格的真判定）。
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const wantSeen = new Set();
    let want = [];
    for (const cell of selfCells) {
      for (const [dx, dz] of dirs) {
        for (const dy of [0, 1]) {
          const x = cell.x + dx, y = feetY + dy, z = cell.z + dz;
          // 不能是她自己身体占着的格（`place.js` 的判定，不在客户端也不在服务端"猜"）
          if (placeLogic.bodyOccupies({ x, y, z }, { x: ep.x, y: ep.y, z: ep.z }, bot.entity?.height)) continue;
          const k = `${x},${y},${z}`;
          if (wantSeen.has(k)) continue;
          wantSeen.add(k);
          want.push({ x, y, z });
        }
      }
    }

    // 只往**空气**格放。已经实心的（墙、地形）不用管，也别去覆盖。
    //
    // ⚠️ P40：这里曾经**悄悄把所有格子都滤掉**，然后抛"没有可放置的空位"。
    //    这类"过滤器把集合清空"的 bug 极难从错误信息反推 —— 错误文案说的是
    //    "四周全是实心"，而真相可能是"白名单没匹配上"**或"格子算错了"**。
    //    所以现在**留痕**：把探测到的原始结果记进 `state.__lastShelterProbe`。
    //    实机证据：正是靠这个留痕才看出 `cx/cz` 是错的（见上方 P40 长注释）。
    const probe = want.map(p => {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
      return { ...p, block: b ? b.name : null, ok: isAiryForPlace(b) };
    });
    state.__lastShelterProbe = {
      at: Date.now(), feetY, cx, cz, probe,
      feetRaw: { x: ep.x, y: ep.y, z: ep.z },
      // ⚠️ P40：把"归属是怎么选出来的"也记下来 —— 否则下次还是只能看到结果、看不到理由。
      attribution: {
        selfCells,
        selfAir: selfCells.map(c => ({ ...c, ok: selfIsAiry(c.x, c.z) })),
        chosen: { cx, cz },
        halfWidth: placeLogic.HALF_WIDTH,
      },
    };
    want = probe.filter(p => p.ok).map(({ x, y, z }) => ({ x, y, z }));

    // ---- 留门：最少保留一面完全空的 -------------------------------------------
    //
    // 如果按四面全封，她会出不来。做法是**按方向分组**，最少放过一个方向。
    // 优先放过哪一个：**朝向开阔地的那个**（而不是她自己当前 facing）——
    // 因为"敌人从哪来"和"她朝哪看"没关系，但"外面是不是开阔地"决定了
    // 堵住这一面是不是真的有用。判定方式：该方向 4 格内有没有实心方块可依靠
    // （没有依靠就放不成，等于天然留门）。
    // `keepOpen` 可以让调用方显式指定放过哪个方向（'x+' | 'x-' | 'z+' | 'z-'）。
    //
    // ⚠️ P40：**方向只能相对于"她身体真正占的格"来算。** 半格偏移时她占 4 格，
    //    同一个世界方向（比如 `x+`）对其中某些格来说是"往外堵"，对另一些格
    //    则根本不是邻居。原来的写法只对一个 `cx/cz` 取邻居，于是
    //    "留门方向"可能落在她身体内部 —— 那等于**没留门**，她会把自己砌在里面。
    //    现在改成：**按世界方向给 `want` 分组**（一格相对于最近的 selfCell 往哪边），
    //    并且明确排除掉"她身体会占到的那些格"。
    const dirKey = (dx, dz) => (dx === 1 ? 'x+' : dx === -1 ? 'x-' : dz === 1 ? 'z+' : 'z-');
    const grouped = new Map(dirs.map(([dx, dz]) => [dirKey(dx, dz), []]));
    for (const p of want) {
      // 这一格相对她身体的哪一个 selfCell 是邻居？取那个方向做归属。
      let best = null;
      for (const cell of selfCells) {
        const dx = p.x - cell.x, dz = p.z - cell.z;
        if (Math.abs(dx) + Math.abs(dz) === 1 && (dx === 0 || dz === 0)) { best = dirKey(dx, dz); break; }
      }
      if (best) grouped.get(best).push(p);
    }
    // 默认放过"可放格子最少"的那个方向（它本来就封不严，放过它代价最小）
    const openDir = keepOpen && grouped.has(keepOpen)
      ? keepOpen
      : [...grouped.entries()].sort((a, b) => a[1].length - b[1].length)[0][0];
    const plan = want.filter(p => !grouped.get(openDir).includes(p));

    // 最多放 `blocks` 格 —— 调用方可以要更少（比如只堵一格应急）
    const targets = plan.slice(0, Math.max(1, Math.min(+blocks, 8)));

    if (!targets.length) {
      // ⚠️⚠️ P40【第二轮，正确的根因】：**"没有可放置的空位"有两种完全不同的含义，
      //    而这一段原来把它们混成了一句错误信息：**
      //
      //    ① **她站在天然闭合的缝里**（实机就是这种）：四周本来就是实心，
      //       这地方**已经有遮蔽**了。→ 这**不是错误**。报失败会让她陷进
      //       "needShelter 永远 true → 每 tick 都来试 → 永远失败"的死循环（P31 的形态）。
      //    ② 真的没地方放（比如她悬在半空 / 四周是可替换的植被但探测失败）。
      //
      //    所以先做两件事，都失败才抛错：
      //      a. **挪一格再搭**（`relocate`）—— 这才是"建立庇护所"该有的行为：
      //         站到附近一个"至少 2 个空邻居"的位置去。
      //      b. 挪不成 → **如实判定"已有天然遮蔽"并返回成功**（`naturalShelter: true`）。
      const sample = probe.slice(0, 6)
        .map(p => `(${p.x},${p.y},${p.z})=${p.block || '?'}`).join(' ');

      // ---- a. 找一个"至少有 2 个可放空位"的落脚点 --------------------------
      //
      // 搜索范围刻意很小（半径 3，同一 y 层，不挖不跳）—— 理由与 P34 一致：
      // "带她大范围移动"是新的行为面，掉进岩浆/水里的风险与"多封一格"的收益不成比例。
      // 只在她**能直接走到**的近处找。
      const R = 3;
      let best = null;
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx, nz = cz + dz;
          // 落脚点本身要能站（脚+头两层），且脚下有地面
          if (!selfIsAiry(nx, nz)) continue;
          const below = bot.blockAt(new Vec3(nx, feetY - 1, nz));
          if (!below || isAiryForPlace(below) || DEADLY.test(below.name || '')) continue;
          // 数一数它有几个"可放"的邻居（4 方向 × 2 层）
          let open = 0;
          for (const [ox, oz] of dirs) {
            for (const oy of [0, 1]) {
              const b = bot.blockAt(new Vec3(nx + ox, feetY + oy, nz + oz));
              if (isAiryForPlace(b)) open++;
            }
          }
          if (open < 2) continue;   // 太挤，挪过去也一样放不成
          const dist = Math.abs(dx) + Math.abs(dz);
          if (!best || open > best.open || (open === best.open && dist < best.dist)) {
            best = { x: nx, z: nz, open, dist };
          }
        }
      }

      if (best) {
        try {
          // 清掉上一次的 goal（P25：清理必须在发起下一次 goto **之前**）
          try { bot.pathfinder.setGoal(null); } catch (_) {}
          const goalY = feetY;
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(best.x, goalY, best.z, Math.max(2, best.dist + 1))),
            8000,
          );
          const now = bot.entity?.position;
          if (now && (Math.floor(now.x) !== cx || Math.floor(now.z) !== cz)) {
            // 走动了 → **递归重试一次**（这次在新位置上重新探测、留门、放置）
            state.__lastShelterProbe = {
              ...(state.__lastShelterProbe || {}),
              relocatedTo: { x: best.x, z: best.z, open: best.open, dist: best.dist },
              relocatedFrom: { cx, cz, probe, sample },
            };
            return await handlers['POST /shelter']({ itemName, blocks, keepOpen });
          }
        } catch (e) {
          // 走不过去（被挡住/超时）→ 落到下面的"天然遮蔽"判定
          state.__lastShelterProbe = {
            ...(state.__lastShelterProbe || {}),
            relocateFailed: { to: best, error: e.message },
          };
        }
      }

      // ---- b. 挪不动 → "这地方已经有遮蔽了" ---------------------------------
      //
      // ⚠️ 这**不是**在粉饰失败：她这格是 air、脚下是实心地面、四周（含头顶那层）
      //    全被实心方块包围 —— 从"躲怪"的角度看，她**已经在一个天然的掩体里**。
      //    返回 `ok/sheltered: true` + `naturalShelter: true` 让上层知道
      //    "需求已满足，不用再试"，从而跳出死循环。
      //
      //    ⚠️ 但要**如实报告**这个判定，绝不能默默当成"我搭好了"。所以：
      //      · `placed: 0`（诚实：我一块砖都没放）
      //      · `naturalShelter: true`（说明为什么仍算成功）
      //      · `reason` 带上探测到的方块，供事后核对
      const selfAir = selfIsAiry(cx, cz);
      const groundSolid = (() => {
        const b = bot.blockAt(new Vec3(cx, feetY - 1, cz));
        return !!b && !isAiryForPlace(b) && !DEADLY.test(b.name || '');
      })();
      if (selfAir && groundSolid) {
        return {
          placed: 0,
          naturalShelter: true,   // ★ 诚实标记：没放方块，是靠天然地形
          sheltered: true,        // 需求已满足 → 上层不再重试（跳出 P31 形态的死循环）
          keptOpen: null,
          message: `已经在一个天然掩体里（四周 ${probe.length} 格全是实心，无需再封）`,
          details: [],
          failed: [],
          probe: { at: { cx, feetY, cz }, sample },
        };
      }

      // ---- c. 真的没辙了 → 如实抛错（带上证据，别再指向错的层） -------------
      throw new Error('脚边没有可放置的空位，附近也没有能挪过去的位置'
        + `（归到她站 (${cx},${feetY},${cz})，selfAir=${selfAir} groundSolid=${groundSolid}`
        + `，探测到 ${probe.length} 格：${sample || '无'}）`);
    }

    // 站定再放 —— 身体漂着的时候会打偏（与 `/place` 一致）
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    await sleepMs(150);
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');

    const placed = [];
    const failed = [];
    for (const t of targets) {
      // 每一格都重新确认还是空气 —— 上一格放下去可能改变了地形
      const now = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (!isAiryForPlace(now)) {   // ⚠️ P39：用**同一份**判据（`place.js` 的 AIRY），别再抄一遍
        failed.push({ at: t, reason: `已经不是空格了（${now?.name || '读不到'}）` });
        continue;
      }
      // 手里还有没有这个方块
      const still = bot.inventory.items().find(i => i.name === item.name);
      if (!still) { failed.push({ at: t, reason: '方块用完了' }); break; }
      if (bot.heldItem?.name !== item.name) { try { await bot.equip(still, 'hand'); } catch (_) {} }

      state.currentAction = `sheltering ${t.x},${t.y},${t.z}`;
      try {
        // 复用 `/place` 的几何判定 —— **不另写一份**（P2b/P18 教训）。
        const verdict = placeLogic.planPlacement({
          target: t,
          getBlock: pos => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)),
          feet: { x: ep.x, y: ep.y, z: ep.z },
          height: bot.entity?.height,
        });
        if (!verdict.ok) { failed.push({ at: t, reason: `几何不可行（${verdict.kind}）` }); continue; }

        let done = false;
        for (const p of verdict.plans) {
          const ref = bot.blockAt(new Vec3(p.refPos.x, p.refPos.y, p.refPos.z));
          if (!ref) continue;
          try { await withTimeout(bot.lookAt(new Vec3(p.contact.x, p.contact.y, p.contact.z), true), 3000); } catch (_) { continue; }
          try {
            await withTimeout(bot.placeBlock(ref, new Vec3(p.face.x, p.face.y, p.face.z)));
            const ok = await waitForBlock(bot, new Vec3(t.x, t.y, t.z), 1500);
            placed.push({ at: t, via: p.label, confirmed: ok });
            done = true;
            break;
          } catch (_) { /* 换个面试 */ }
        }
        if (!done) failed.push({ at: t, reason: '所有面都放不下' });
      } catch (e) {
        failed.push({ at: t, reason: e.message });
      } finally {
        state.currentAction = null;
      }
      await sleepMs(120);   // 每格之间让出一点时间，别把服务端刷爆
    }

    return {
      placed: placed.length,
      keptOpen: openDir,     // 如实汇报"哪个方向留了门"——调用方要能知道她出得来
      details: placed,
      failed,
      // 至少要封住 2 格才算"有个遮蔽的样子"；1 格只是象征性的
      sheltered: placed.length >= 2,
      // ★ 2026-09-25（P44 架构修复）：`ok` —— 让 `sheltered: false` 也能**否决**
      //   路由层的 `success: true`。
      //
      //   ⚠️ 注意与上面那个 `naturalShelter` 分支的区别：那里 return 的是
      //      `sheltered: true`（"已有天然掩体"，需求已满足），**不走这里**。
      //      这里只覆盖"真的要搭、但一块都没搭上"的情况 —— 那是真失败。
      //
      //   P41 的教训就在这里：autopilot 当年只看 `success`，于是
      //   `placed: 0` 也被当成"搭好了"，她会站在空地上以为自己有庇护所。
      ok: placed.length >= 2,
    };
  },

  // 丢出 / 递给玩家。给了坐标就能"把东西还给你"。
  'POST /drop': async ({ itemName, count, playerName }) => {
    const item = itemName
      ? state.bot.inventory.items().find(i => i.name === itemName)
      : state.bot.heldItem;
    if (!item) throw new Error(itemName ? `Not carrying ${itemName}` : 'Nothing in hand (pass itemName)');

    // 先看向玩家，丢出去的东西才会落在他那边
    if (playerName) {
      const ent = state.bot.players[playerName]?.entity;
      if (!ent) throw new Error(`Player not visible: ${playerName}`);
      await state.bot.lookAt(ent.position.offset(0, 1.5, 0), true);
    }

    const n = count === undefined ? item.count : Math.min(Math.max(1, +count), item.count);
    if (n >= item.count) await withTimeout(state.bot.tossStack(item));
    else await withTimeout(state.bot.toss(item.type, null, n));

    return { dropped: item.name, count: n, to: playerName || null };
  },

  // ---------------------------------------------------------------- 自救逃逸（P42）
  //
  // ## 为什么需要这个端点
  //
  // 2026-09-25 实测（field-log **P42**）：她被卡在一条**只有 1 格高**的天然缝隙里，
  // `/move` 四个方向**全部 `No path found`**。决定性证据：从她所在格做 4 邻居
  // 泛洪 → **连通分量 = 1**（整层 21 个 air 格只连通她自己那一格）。
  //
  // 真因：**通道只有 1 格高，而她身高 1.8 格**。站位需要"脚层 + 头层"都非实心 ——
  // 唯一可站的邻格与她**对角**相邻，而正交邻居全实心时 Minecraft 不允许走对角。
  // → **`No path found` 是正确判定，不是 bug。**
  //
  // 但后果是致命的：`canDig = false`（`pathing.js` 的 `ALLOW_DIG`，默认关）
  // 让寻路器**只绕不拆**，绕不过去就永久卡死。她**自己没有任何办法出来** ——
  // 上一次是我从外面调 `/mine` 挖开 `grass_block` 才把她放出来。
  //
  // ⚠️ 而用户的目标是「**自己**建立庇护所并持续发育」。**"自己"这两个字
  //    要求她在被困时能自救**，否则一次意外地形就能让主线永久停滞。
  //
  // ## 这个端点做什么
  //
  // **不改变全局政策**（`canDig` 仍是 false）。它做的是：**临时**打开
  // `canDig`，尝试走到目标；**无论成败都恢复**。这就是
  // `pathing.applyPolicy(mv, names, { allowDig: true })` 那个"单次放行口子"
  // 的第一次真正使用（那句话在 `pathing.js` 里躺了很久，注释写着"留给将来"）。
  //
  // ## 为什么是"临时打开"而不是"永久打开"
  //
  // 永久打开 = `MC_ALLOW_DIG=true`，代价是**她会顺手拆掉玩家的建筑**
  // （实测过：`cluttered:antique_mini_table` 这类模组装饰方块名一个模式都不中，
  //   `blocksCantBreak` 那层形同虚设，被拆过两格）。
  // 而"被困"是一个**可判定的状态**（`No path` / `Stuck` + 原地不动），
  // 所以放行可以是**窄口径**的：只在确认被困时，只放行这一趟。
  //
  // ## 参数
  //   · `x` `y` `z` —— 目标（必填，与 `/move` 同样的语义）
  //   · `reason` —— 可选，调用方为什么认为她被卡住了（**写进返回值，便于审计**）
  //   · `timeoutMs` —— 可选
  //
  // ## 返回
  //   · `escaped: true` —— 她**真的移动了**（用前后位置差判定，与 P44 同源）
  //   · `escaped: false` + `why` —— 打开 canDig 也没用（比如真被基岩围着）
  //   · `restored: true` —— **政策一定恢复**（`finally` 保证）
  'POST /unstick': async ({ x, y, z, reason, timeoutMs = 20000 } = {}) => {
    if (x === undefined || z === undefined) throw new Error('x and z required');
    const mv = state.bot.pathfinder?.movements;
    if (!mv) throw new Error('pathfinder 没装 —— 没有寻路器可自救');

    const origin = state.bot.entity?.position;
    const before = origin ? { x: origin.x, y: origin.y, z: origin.z } : null;
    // 记下**放行前**的 canDig —— 恢复时要用原值，不能硬写 false
    //（万一将来全局政策改成 true，这里硬写 false 就把它悄悄改窄了）。
    const canDigBefore = mv.canDig;

    let escaped = false;
    let why = null;
    let arr = null;
    try {
      // ★ 单次放行。`applyPolicy` 会把 canDig 之外的一整套防护也重新套一遍
      //   （fluidCost / blocksCantBreak / allow1by1towers=false 等），
      //   所以走它比自己写 `mv.canDig = true` 安全得多 —— 后者会把
      //   "不许垫方块上塔"也一起改掉。
      pathing.applyPolicy(mv, state.bot.registry?.blocksByName, { allowDig: true });
      const goal = y !== undefined ? new goals.GoalBlock(+x, +y, +z) : new goals.GoalXZ(+x, +z);
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
      arr = await withTimeout(state.bot.pathfinder.goto(goal), Math.min(Math.max(3000, +timeoutMs), 120000));
      void arr;
    } catch (e) {
      why = e.message;
    } finally {
      // ★★ **恢复是强制的，而且必须在 finally 里** —— 中途 return / 抛错都不能漏。
      //    漏掉的后果很严重：一整套"只绕不拆"的防护静默失效，之后她会开始拆建筑，
      //    而现场**看不出任何异常**（没有任何日志说政策变了）。
      pathing.applyPolicy(mv, state.bot.registry?.blocksByName, { allowDig: canDigBefore });
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
    }

    const now = state.bot.entity?.position;
    const moved = (before && now)
      ? Math.hypot(now.x - before.x, now.y - before.y, now.z - before.z)
      : null;
    // 判据与 P44 同源：**世界真的变了才算逃出来**。
    // ⚠️ 用 0.5 格作阈值 —— `GoalBlock` 只要求"在格内"，站到格边缘也算动了；
    //    但 0.5 格以下的变化在实战里就是"抖动"，不能算脱困。
    escaped = moved !== null && moved > 0.5;

    return {
      escaped,
      moved: moved === null ? null : Math.round(moved * 1000) / 1000,
      from: before && { x: +before.x.toFixed(2), y: +before.y.toFixed(2), z: +before.z.toFixed(2) },
      to: now && { x: +now.x.toFixed(2), y: +now.y.toFixed(2), z: +now.z.toFixed(2) },
      canDigRestored: mv.canDig === canDigBefore,
      reason: reason || null,
      why: escaped ? undefined : (why || '打开了 canDig 也走不动 —— 可能真被封死了'),
      hint: escaped
        ? undefined
        : '考虑 POST /mine 直接挖脚边一格（那条路径不经过寻路器，不受 canDig 影响）',
    };
  },

  'POST /command': async ({ command }) => {
    if (!command) throw new Error('command field required');
    const BLOCKED_COMMANDS = /^\/?(?:op|deop|stop|ban|ban-ip|pardon|kick|whitelist|save-off|save-all|save-on|reload|restart)\b/i;
    if (BLOCKED_COMMANDS.test(command.trim())) {
      throw new Error(`Command blocked for safety: "${command}". Use minecraft-server-admin / RCON for server administration.`);
    }
    const cmd = command.startsWith('/') ? command : `/${command}`;
    state.bot.chat(cmd);
    return { executed: cmd };
  },

  'POST /move': async ({ x, y, z }) => {
    if (x === undefined || z === undefined) throw new Error('x and z required');
    const COORD_LIMIT = 30_000_000;
    if (Math.abs(+x) > COORD_LIMIT || Math.abs(+z) > COORD_LIMIT || (y !== undefined && Math.abs(+y) > 320)) {
      throw new Error(`Coordinates out of range (max ±${COORD_LIMIT} XZ, ±320 Y)`);
    }
    state.currentAction = `moving to ${x},${y ?? '?'},${z}`;
    // ⚠️⚠️⚠️ P44（2026-09-25 实机抓出）：**记下出发位置** —— 这是这个端点的
    //    "世界真的变了"的证据，和 `/pickup` 的背包差（P32）同理。
    //
    //    【症状】`POST /move {"x":-8,"y":86,"z":-8}` 返回
    //      `{"success":true,"arrived":{"x":-8,"y":86,"z":-8},"route":{"source":"pending"}}`
    //      而紧接着 `GET /position` → `exact = (-7.67, 86, -7.51)` **纹丝未动**。
    //
    //    【根因 —— 不是谎报，是**语义歧义**，但对调用方同样是致命的】
    //      目标 `GoalBlock(-8,86,-8)` 的 `isEnd()` 只要求"她在这一格**内**"，
    //      不要求"到格中心"。而她 `exact = (-7.67, 86, -7.51)` 的格归属
    //      `floor(-7.67) = -8`、`floor(-7.51) = -8` —— **她已经在了**。
    //      于是 `goal_reached` **立刻**触发 → `res()` → 返回 `success: true`。
    //
    //      严格说这个 `success` 是**对的**（她的确在 (-8,86,-8)），
    //      但调用方（autopilot）拿到 `success: true` 会以为"她动过了" ——
    //      于是任何"先 /move 靠近、再做事"的链路**全部静默失效**。
    //      这正是 P32/P35/P41 那个家族的症状（上层基于 ok 的机制失效），
    //      只是成因从"谎报"变成了"契约没写清"。
    //
    //    【修法】**把位移量写进返回体**，让调用方能区分两种"到了"：
    //      · `moved ≈ 0` → "本来就在这一格，我没动"（调用方要自己决定够不够）
    //      · `moved > 0` → "真的走过去/下去/爬上去了"
    //      再加上 `wasInside`（出发时就已经在目标格里）—— 一眼看清是哪种。
    //      **不改变 `success` 的语义**（它仍是"到达了"），只补充证据。
    //      这样既不破坏现有调用方，又给了新调用方区分的能力。
    const originForMove = state.bot.entity?.position;
    const originSnap = originForMove
      ? { x: originForMove.x, y: originForMove.y, z: originForMove.z }
      : null;
    const goal = y !== undefined ? new goals.GoalBlock(+x, +y, +z) : new goals.GoalXZ(+x, +z);
    const onGoal = () => { state.bot.removeListener('path_update', onPath); res(); };
    const onPath = (e) => { if (e.status === 'noPath') { state.bot.removeListener('goal_reached', onGoal); rej(new Error('No path found')); } };
    let res, rej;
    const done = new Promise((a, b) => { res = a; rej = b; });

    // ⚠️ 这一段必须 try/finally。原来的写法在**超时/无路**时三样东西全漏：
    //   1. `pathfinder.setGoal(null)` 没被调用 → 目标一直挂着，寻路器**继续驱动她的身体**；
    //   2. `state.currentAction` 停在 "moving to …" → 看门狗与审计看到的是错的状态；
    //   3. 两个事件监听器留着 → 下一次 /move 会叠加监听。
    //
    // 第 1 条最要命：它会和 `POST /control` **抢同一个身体**。现象极具误导性 ——
    // 按住 W 位移≈0、连 jump 都不动，看起来像"她卡住了/物理层坏了"，
    // 其实是两个写入者每个 tick 互相覆盖。实测过一次，排查了很久。
    // 身体的唯一性见设计规则 8：行动不能并行。
    //
    // ---- 超时：从"固定 30s"改成"按路径预估"（2026-09-25）------------------------
    //
    // 旧写法是 `withTimeout(done)` 用全局固定值。问题见 pathing.js「单次寻路的超时
    // 与停滞检测」一节的完整说明，一句话：走 3 格和走 60 格用同一个数字，
    // 近距离白等、远距离被砍。
    //
    // 现在：路径算出来后按节点类型估时 → `eta*2 + 10s`，钳在 30s~300s。
    // 路径还没出来时先给下界 30s —— 正常服务器上 `path_update` 在几十毫秒内就有，
    // 30 秒还没路径基本就是没路，不该等更久。
    //
    // ⚠️ 停滞检测是**并联**的第二个退出条件，不能只有超时：
    //    顶着墙角站位时"总时长"一直没到，但她其实一步没往前走。
    //    每 5s 看一眼有没有实质进展，连续 3 次没有就放弃。
    const budget = { timeoutMs: pathing.PATH_MIN_TIMEOUT_MS, etaMs: null, source: 'pending' };
    let stagnation = null;
    let stagnationTimer = null;
    let replans = 0;

    const onPathUpdate = (e) => {
      // 路径每次重算都重新估时。寻路器会在遇到障碍时重规划，
      // 用第一次的 ETA 会低估（第一条路径往往更乐观）。
      try {
        const est = pathing.estimatePathTimeMs(e?.path);
        const t = pathing.computeTimeoutFromEta(est);
        if (t.etaMs !== null) {
          budget.timeoutMs = t.timeoutMs;
          budget.etaMs = t.etaMs;
          budget.source = t.source;
          replans++;
        }
      } catch (_) { /* 估时失败不该影响移动本身 */ }
    };

    try {
      state.bot.pathfinder.setGoal(goal);
      state.bot.once('goal_reached', onGoal);
      state.bot.on('path_update', onPath);
      state.bot.on('path_update', onPathUpdate);

      // 停滞检测：拿到起点才能算"有没有真的在动"。拿不到就退化成纯超时。
      const origin = state.bot.entity?.position;
      if (origin) {
        stagnation = pathing.createStagnationMonitor(
          { x: origin.x, y: origin.y, z: origin.z },
        );
        stagnationTimer = setInterval(() => {
          const v = stagnation.sample(state.bot.entity?.position);
          if (v.exhausted) {
            clearInterval(stagnationTimer);
            stagnationTimer = null;
            try { state.bot.pathfinder.stop(); } catch (_) {}
            rej(new Error(
              `Stuck: no meaningful progress for ${v.stagnant} checks `
              + `(~${(v.stagnant * pathing.PATH_PROGRESS_INTERVAL_MS) / 1000}s, `
              + `${v.moved} blocks since last check)`,
            ));
          }
        }, pathing.PATH_PROGRESS_INTERVAL_MS);
      }

      // 超时随预算走。`withTimeout` 只接受一个固定值，而预算会随重规划上调，
      // 所以这里自己起一个看门狗：每隔一段检查一次，**预算变大了就续期**。
      // 比"直接传最大上界"更省时间 —— 近路仍然会在短预算内就认输。
      //
      // ⚠️ 续期判据用"预算数值有没有变"，不要用 "deadline 是否相等" ——
      //    我第一版就是后者，而 `deadline()` 每次都返回新的时间戳，
      //    那个比较**恒为 false**，等于永远不会续期（远路会被误砍）。
      let limit = Date.now() + budget.timeoutMs;
      let lastBudget = budget.timeoutMs;
      const watchdog = setInterval(() => {
        if (budget.timeoutMs > lastBudget) {
          lastBudget = budget.timeoutMs;
          limit = Date.now() + budget.timeoutMs;   // 重规划给出更长的预估 → 续期
          return;
        }
        if (Date.now() >= limit) {
          clearInterval(watchdog);
          rej(new Error(`Timeout: exceeded ${budget.timeoutMs}ms (eta ${budget.etaMs ?? '?'}ms)`));
        }
      }, Math.max(1000, Math.floor(pathing.PATH_PROGRESS_INTERVAL_MS / 2)));

      try {
        await done;
      } finally {
        clearInterval(watchdog);
      }
      const now = state.bot.entity?.position;
      // ---- P44：把"她到底动了没有"如实写出来 ----
      // 每格中心在 `n + 0.5`，所以她落在格 (x,z) 内 ⟺ `floor(px) === x`。
      // 出发时如果就已经在目标格内，那 `goal_reached` 是**立刻**触发的，
      // 本次调用**没有产生任何位移** —— 这正是 P44 那个"success 却纹丝未动"。
      const destX = Math.floor(+x), destZ = Math.floor(+z);
      const wasInside = !!originSnap
        && Math.floor(originSnap.x) === destX
        && Math.floor(originSnap.z) === destZ
        && (y === undefined || Math.floor(originSnap.y) === Math.floor(+y));
      const moved = (originSnap && now)
        ? Math.hypot(now.x - originSnap.x, now.y - originSnap.y, now.z - originSnap.z)
        : null;
      return {
        arrived: botPos(),
        // ★ 新增（P44）：调用方区分"本来就在"和"真的走过去了"的唯一依据。
        moved: moved === null ? null : Math.round(moved * 1000) / 1000,
        wasInside,
        note: wasInside
          ? '出发时就已在目标格内 —— 本次没有产生位移（目标已满足）'
          : undefined,
        route: { etaMs: budget.etaMs, timeoutMs: budget.timeoutMs, replans, source: budget.source },
      };
    } finally {
      if (stagnationTimer) clearInterval(stagnationTimer);
      state.bot.removeListener('goal_reached', onGoal);
      state.bot.removeListener('path_update', onPath);
      state.bot.removeListener('path_update', onPathUpdate);
      // 到达时清掉是无害的（目标已完成）；失败时清掉才是关键 —— 把身体交还给调用方。
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
      state.currentAction = null;
    }
  },

  // 挖方块。
  //
  // 两种找法：
  //   ① `{ blockName: 'iron_ore' }` —— 按方块名找（原行为）
  //   ② `{ byItem: 'raw_iron' }`     —— 按**掉落物名**找
  //
  // ② 存在的理由就是问题 4「对可收获的东西视而不见」的一半：
  // 一个真玩家想的是"我要铁"，不是"我要挖 iron_ore 这个方块"。
  // 而 iron_ore 的掉落物是 raw_iron、coal_ore 掉 coal、diamond_ore 掉 diamond ——
  // 名字对不上，于是调用方必须先自己知道"方块名 ↔ 掉落物名"的映射表。
  // 那张表**已经在数据里**（`block.drops` / `block.harvestTools`），没必要让上层背。
  //
  // 顺带把"搜不到"这件事说清楚：原来的实现是"64 格内找一次，找不到就报没有"，
  // 于是"矿在 70 格外"和"这里真没矿"对外是同一句话。
  // 现在按 pathing 的自适应搜索逐级扩半径，并在放弃时**如实报告搜了多大**。
  'POST /mine': async ({ blockName, byItem, count = 1 }) => {
    if (!blockName && !byItem) throw new Error('blockName 或 byItem 至少给一个');
    count = Math.min(Math.max(1, +count), 64);

    // ---- 解析目标方块 id
    let blockId = null;
    let resolvedVia = null;
    let resolveSource = 'blockName';
    let resolveCandidates = 0;
    if (byItem) {
      const found = resolveBlocksForItem(state.bot, byItem);
      if (!found.blocks.length) {
        // ⚠️ 这里**绝不能说"它不能挖"**。
        //
        // 2026-09-25 的教训（见 memory/field-log.md P4）：第一版把这种情况报成
        // "不是靠挖掘获取的（作物类没有 drops）"，而当时的目标是 `lemon_log` ——
        // 一个明明刚用 blockName 挖成功的方块。原因是我只在原版 `drops` 表里查，
        // 而模组方块一个都不在那张表里。
        //
        // **"我查不到"被写成了"它不行"** —— 这是最坏的错误提示，
        // 因为它会让上层放弃一个完全可行的方法（改回 blockName 就行了）。
        // 所以现在只说"我查不到"，并给出可操作的下一步。
        const known = Object.keys(state.bot.registry.itemsByName || {})
          .some(n => stripNamespace(n) === stripNamespace(byItem));
        throw new Error(known
          ? `找不到会掉落 ${byItem} 的方块（已查原版 drops 表 + 名字规律，都没命中）。`
            + `这不代表它挖不到 —— 直接用 blockName 试，比如 /mine {"blockName":"<方块名>"}`
          : `注册表里没有 ${byItem} 这个物品（名字拼错？）`);
      }
      blockId = found.blocks[0].id;
      resolveSource = found.resolveSource;
      resolveCandidates = found.blocks.length;
      resolvedVia = `byItem:${byItem}[${found.resolveSource}] → ${found.blocks.slice(0, 4).map(f => f.name).join('/')}`;
    } else {
      const def = state.bot.registry.blocksByName[blockName];
      if (!def) throw new Error(`Unknown block: ${blockName}`);
      blockId = def.id;
      resolvedVia = `blockName:${blockName}`;
    }
    const label = byItem || blockName;

    state.currentAction = `mining ${count}x ${label}`;
    const mined = [];
    const sweeps = [];
    // 发生过几次"dig 声称成功但方块还在"（见 P1c）。
    // **必须暴露** —— 它和"真的挖不动"是两种完全不同的故障，
    // 混在一起会让运维去查错方向（去查工具/硬度，而不是查动作没生效）。
    const digStalls = [];
    const ladder = pathing.buildRadiusLadder();
    let sweep = 1;
    let radius = ladder[0];
    let dropsPicked = 0;   // 真正进背包的件数（由背包增量判定，不是"走过去过"）
    // 掉落物"最后落在哪儿"的坐标集合 —— 用于挖完之后**统一清扫一次**。
    // 见下方 "批量清扫" 段：逐块等待既慢又会互相错位（P10 第二轮）。
    const dropAnchors = [];
    const invBefore = inventoryCount(state.bot);

    try {
      for (;;) {
        if (mined.length >= +count) {
          sweeps.push({ sweep, radius, action: 'done', reason: `够了（${mined.length}/${+count}）` });
          break;
        }
        const before = inventoryCount(state.bot);
        const block = state.bot.findBlock({ matching: blockId, maxDistance: radius });
        const hit = Boolean(block);

        if (hit) {
          const where = { x: block.position.x, y: block.position.y, z: block.position.z };
          try {
            // ⚠️ 这里原来用 `GoalLookAtBlock` —— 它要求**能"看到"**那个方块，
            //    也就是必须在同高度或更高处且视线不被挡。而实战里最常挖的木头
            //    长在她**头顶上方 4~5 格**（`(77,68,-128)` vs 她站在 y=64），
            //    于是寻路永远不满足、反复重规划 —— P9 的 150 秒就是这么来的。
            //
            // 挖矿真正需要的只是"**站得够近**"（原版挖掘距离约 4.5 格），
            // 不需要那种严格的视线条件。
            //
            // ⚠️⚠️ 但 `GoalNear(x, y, z, 3)` **仍然不对** —— 这是
            //    2026-09-25 第三次实战抓出来的（field-log P11）。
            //
            //    症状：`[goto] mine autumnity:maple_log → 停滞判定，放弃（moved=0.14）`
            //          连试 3 次、每次 ~15s 全部停滞，`currentAction` 永远卡在 mining。
            //
            //    根因：`GoalNear` 的球心是**方块自己的坐标**。木头在 `(4,94,7)`，
            //    而她在 `y=91` —— 要满足"距 (4,94,7) ≤ 3"，她得**爬高 3 格**。
            //    树干下方那几格是树叶与悬空，寻路器爬不上去（`canDig=false`，
            //    它不能为了爬高而拆方块），于是越走越远 → 停滞 → 放弃。
            //
            //    正确的语义是：**在"她已经站得住的高度"上，水平靠近到够得着**。
            //    · Y 用她自己的 y —— 不去要求她改变高度；
            //    · 只约束水平距离；
            //    · 高度差交给后面的 dig 判断（原版从下往上挖 3~4 格完全够得到）。
            //    下面的实现就是把 y 换成她的 y，并把球心向上抬 1 格，
            //    因为那样"水平距离 ≤3 且脚下有路"的站位通常就在树根边上。
            const eyeY = Math.floor(state.bot.entity.position.y);
            await gotoWithBudget(
              state,
              new goals.GoalNear(block.position.x, eyeY, block.position.z, 3),
              { label: `mine ${label}` },
            );

            // ---- 挖，并且**验证真的挖掉了** --------------------------------------
            //
            // ⚠️⚠️⚠️ 这一段是 2026-09-25 第二次实战抓出来的（field-log 的 P1c）。
            //
            // 症状：`POST /mine` 返 `HTTP 200 / 0.14s / mined:1`，
            //       但**那格木头纹丝不动**，`/scan` 里还在原位。
            //
            // 0.14 秒挖一格木头在物理上不可能（徒手也要好几秒）。
            // 真相是：`bot.dig()` **直接 resolve 了，没干活** ——
            // 不抛错、不超时，于是 `withTimeout` 和 `catch` 全都拦不住。
            // 于是 `mined` 是个**假数字**，上层（autopilot）据此以为"挖到了"。
            //
            // 这是最难查的一类 bug：**动作声称成功、世界没有变化**。
            // 唯一可靠的防法是**去世界里核对**，而不是相信返回值。
            const beforeBlock = state.bot.blockAt(block.position);
            const beforeName = beforeBlock?.name ?? null;

            await withTimeout(state.bot.dig(block));

            // 核对：那格现在还是不是原来那个方块？
            // · 变成 air（或别的方块）→ 真的挖掉了
            // · 还是原方块 → **dig 没生效**
            const afterBlock = state.bot.blockAt(block.position);
            const afterName = afterBlock?.name ?? null;
            const reallyBroken = afterName !== beforeName;

            if (!reallyBroken) {
              // ⚠️ 这里**不 push 进 mined**。宁可如实报 0，也不要一个漂亮但假的数字。
              sweeps.push({
                sweep, radius, action: 'error',
                reason: `dig 声称成功但方块还在（${beforeName} @ ${where.x},${where.y},${where.z}）—— 世界没有变化`,
              });
              // 短暂让路再试：这类"dig 空转"有时是因为动作被上一个动作占用，
              // 或服务端在该 tick 拒了。立刻重试同一个目标往往就成功了。
              digStalls.push({ at: where, name: beforeName });
              await sleep(250);
              continue;
            }

            // ⚠️⚠️ 掉落物回收：**先"轻触"一下，挖完再统一清扫**。
            //
            // 这是 2026-09-25 实战抓出来的（见 memory/field-log.md P1 / P10）。
            //    · P1：`dig()` 只把方块拆掉，物品落在地上要**走过去**才被服务端判定拾取。
            //    · P10（第一层）：掉落物**不是立刻就出现**的 —— 服务端生成 + 网络同步
            //      要几百毫秒。挖完立刻查实体表必然查不到，于是 `seen: 0`。
            //      所以 `sweepUpDrops` 会先**轮询等它出现**，再捡。
            //    · P10（第二层，本轮）：**给每块都等满 2.5 秒是纯浪费**。
            //      实测：连挖 3 格同一棵树，第 1 格 `waitedMs:2600` 什么都没等到
            //      （它的掉落物和后面两块落在同一片区域，直到第 2 轮才被看到），
            //      第 3 格反而 `waitedMs:0` 直接命中。
            //
            //      因为**掉落物堆在一起**，不存在"这一块的掉落物必须在这一轮捡完"。
            //      所以改成：
            //        · 每挖一格后只做一次**极短的**探手（waitMs 小），顺手就捡；
            //        · 把落点记进 `dropAnchors`；
            //        · 挖够 count 之后，对整片区域做**一次**统一清扫（半径大、预算足）。
            //      这样既不会漏，也不会为每块各等一次。
            const swept = await sweepUpDrops(state.bot, where, {
              radius: 3, waitMs: 450, budgetMs: 2000, settleMs: 600,
            });
            dropsPicked += swept.picked;
            if (swept.seen > swept.picked || swept.seen === 0) dropAnchors.push(where);

            mined.push({ at: where, name: beforeName, nowIs: afterName, drops: swept });
          } catch (e) {
            sweeps.push({ sweep, radius, action: 'error', reason: `挖 ${block.name} 失败：${e.message}` });
            // 单块失败不直接放弃：可能是被卡住，换个目标还有机会。
            // 但**不扩半径** —— 问题不是"太远"。
            sweeps.push({ sweep, radius, action: 'continue', reason: '单块失败，本轮继续' });
            continue;
          }
        }

        const gained = inventoryCount(state.bot) - before;
        // ⚠️ 判据用"真正到手几件"，不是"挖了几格"。见 pathing.isProductiveSweep 的说明。
        //    `inventoryFull` 是 2026-09-25 补的：P1 那次 8 轮 reason 全是同一句话，
        //    而"背包满"和"没回头捡"的处理方式完全不同，不该共用一句文案。
        const prod = pathing.isProductiveSweep({
          gainedItems: gained,
          brokenBlocks: hit ? 1 : 0,
          inventoryFull: (() => {
            try { return state.bot.inventory.emptySlotCount() === 0; } catch (_) { return false; }
          })(),
        });
        const step = pathing.nextCollectStep({
          sweep, hit, productive: prod.productive,
          wanted: +count, got: mined.length, ladder,
          // ⚠️ 把 `prod.reason`（"背包满" / "没回头捡" / …）**透传**给下一步。
          //    不传的话，P2 在 isProductiveSweep 里分好的三类原因会被
          //    nextCollectStep 自己那句写死的文案盖掉 —— 这正是 P2b 的 bug：
          //    分层诊断做了，最后一跳丢了。见 field-log。
          why: prod.reason,
        });
        // `gained`/`prod.reason` 都要进留痕 —— 光看 action 分不出"背包满"和"没捡"
        sweeps.push({ sweep, radius, hit, gained, action: step.action, why: prod.reason, reason: step.reason });

        if (step.action === 'done' || step.action === 'give-up') break;
        if (step.action === 'widen') { sweep++; radius = step.radius; continue; }
        // 同一半径反复无收获的上限。**加 dig 空转的容忍度** ——
        // 一次 dig 空转后我们 `continue`（不让路重试），这会消耗这个计数；
        // 但如果她真的连试几次都挖不动，就该停，而不是刷满整个 count。
        const continues = sweeps.filter(s => s.action === 'continue' && s.radius === radius).length;
        // dig 空转单独一个更紧的上限：连试 2 次都没生效，说明不是"偶发被占用"
        const stallsHere = digStalls.length;
        if (stallsHere >= 2) {
          sweeps.push({
            sweep, radius, action: 'give-up',
            reason: `连续 ${stallsHere} 次 dig 都没有改变世界，停止（不是"挖不动"，是"动作没生效"）`,
          });
          break;
        }
        if (continues > +count) {
          sweeps.push({ sweep, radius, action: 'give-up', reason: '同一半径反复无收获，停止' });
          break;
        }
        if (!hit) { sweep++; radius = step.radius ?? ladder[Math.min(sweep - 1, ladder.length - 1)]; }
      }
    } finally {
      state.currentAction = null;
    }

    // ---- 批量清扫（P10 第二轮 + P13）--------------------------------------
    //
    // 挖够之后，对整片区域做统一清扫。为什么值得单独一步：
    //   · 掉落物会堆在同一片落点，逐块等待时"等到了谁的掉落物"是错位的；
    //   · 逐块各等一次的总耗时 = 块数 × 单块等待，而它们的掉落物其实同时出现；
    //   · 上面每块的探手只给 450ms（顺手捞），真正的兜底放在这里。
    // 判据仍然是**背包增量**，不是"走过去过"。
    //
    // ⚠️⚠️ P13（2026-09-25 第五次实战）：**锚点用"中间那块"是错的**。
    //
    //   实测（m9.json）：挖 4 块，`invDelta: 2`，但紧接着 `/nearby` 报
    //   `drops: 7` 散在 **8 格宽的一片区域**（最近的 6.6 格，最远的 14.1 格）。
    //   树被砍倒后，掉落物会**顺着树干散落到周围**，不是聚在一个点。
    //   拿"中间那块方块"当球心 + 半径 6，自然够不着外圈那几个。
    //
    //   修法是两层：
    //     ① 球心改成**所有落点的质心**，半径覆盖散落范围（而不是固定 6）；
    //     ② 清扫完**再看一眼世界**，对残余掉落物逐个再捡一轮（上限 2 轮，
    //        守住 P9 的"不引入无限循环"纪律）。
    //   这两层都不依赖"我猜掉落物在哪"，而是"去看世界现在有什么"。
    let bulkSweep = null;
    if (dropAnchors.length && mined.length) {
      const centroidThat = dropAnchors.reduce(
        (a, p) => ({ x: a.x + p.x / dropAnchors.length, y: a.y + p.y / dropAnchors.length, z: a.z + p.z / dropAnchors.length }),
        { x: 0, y: 0, z: 0 },
      );
      // 半径 = 最远落点到质心的距离 + 余量，至少 6（原来写死的值），最多 12
      const spread = Math.max(
        ...dropAnchors.map(p => Math.hypot(p.x - centroidThat.x, p.y - centroidThat.y, p.z - centroidThat.z)),
      );
      const bulkRadius = Math.min(12, Math.max(6, Math.ceil(spread) + 4));
      try {
        const beforeBulk = inventoryCount(state.bot);
        bulkSweep = await sweepUpDrops(state.bot, centroidThat, {
          radius: bulkRadius, waitMs: 3000, budgetMs: 10000, settleMs: 1500,
        });
        bulkSweep.centroid = { x: +centroidThat.x.toFixed(1), y: +centroidThat.y.toFixed(1), z: +centroidThat.z.toFixed(1) };
        bulkSweep.spread = +spread.toFixed(1);
        // ⚠️ 把**实际用到的半径**也写回去 —— 上一轮漏了这一步，
        //    于是 `bulkSweep.radius` 是 undefined，我无法判断
        //    "清扫半径没生效"和"清扫半径生效了但没扫到"是两种完全不同的故障。
        bulkSweep.radius = bulkRadius;
        bulkSweep.anchors = dropAnchors.length;

        // ---- ② 残余清扫：再去看世界里还有没有掉落物 --------------------------
        // 不看"我猜该在哪"，而是**直接枚举剩余掉落物**逐个靠近。
        // 上限 2 轮，避免"掉落物被地形卡住 → 反复尝试"变成新一个 P9。
        const residueRounds = [];
        for (let round = 1; round <= 2; round++) {
          const left = Object.values(state.bot.entities)
            .filter(isDropEntity)
            .filter(d => d.position.distanceTo(centroidThat) <= bulkRadius + 6)
            .sort((a, b) => a.position.distanceTo(centroidThat) - b.position.distanceTo(centroidThat))
            .slice(0, 8);
          if (!left.length) break;
          const beforeRound = inventoryCount(state.bot);
          let got = 0;
          for (const d of left) {
            // ⚠️ 这里**不走 gotoWithBudget**：它的预算是给"正经寻路任务"用的
            //    （默认 30s 起，还有续期与硬上限那套）。残余清扫只需要
            //    "朝那个方向走一小段，能捡就捡，不行就算了"，
            //    用固定的短赛跑更直接，也不会因为一个够不到的掉落物
            //    把整轮清扫拖长。
            //
            // ⚠️⚠️⚠️ 2026-09-25 实战（P25）：清理**必须在 goto 之前**。
            //     我一开始写成 `finally { stop(); setGoal(null); }` —— 看起来对，
            //     实际是把下一个 goto 打死：`setGoal(null)` 会 emit
            //     `goal_updated(null)`，而下一个 goto 的 listener 已经注册好在等，
            //     收到 null 就报 `GoalChanged`（0ms 内失败）。
            //     实测：地上 6 个掉落物、距离 1.4 格，一个都捡不到。
            //     见 `withTimeout` 顶部的完整时序推导。
            //
            // ⚠️ 球心的 y 走 `reachableStandY`（P30 → P33）—— 理由与 sweepUpDrops
            //    / `/pickup` 完全相同，**三处必须用同一个函数**，
            //    否则就是"修一个反模式只修了一处"（P14）的第四次犯。
            //    简言之：用 `d.position.y` 会让她下不去（P30）；
            //    一律用 `selfY` 会让她永不落坑（P33）。夹到"够得着的那一层"才对。
            const mineSelfY = Math.floor(state.bot.entity?.position?.y ?? 0);
            const mineGoalY = reachableStandY(d.position.y, mineSelfY);
            // ⚠️ P38：半径随垂直落差自适应（同 sweepUpDrops / `/pickup`）。
            const mineRadius = Math.max(2, Math.abs(mineSelfY - mineGoalY) + 1);
            pathing.clearPathfinderGoal(state.bot.pathfinder);
            try {
              await Promise.race([
                state.bot.pathfinder.goto(
                  new goals.GoalNear(d.position.x, mineGoalY, d.position.z, mineRadius),
                ),
                sleep(6000),
              ]);
            } catch (_) { /* 捡不到就下一个，不阻断 */ }
            // 只 stop() 不清 goal（理由见上）。
            // ⚠️ stop() 之后让出一个 tick，给 `goto.js` 的 listener 清理机会
            //    （它是 `setTimeout(..., 0)`）—— 否则下一个 goto 撞残留 listener。
            try { state.bot.pathfinder.stop(); } catch (_) {}
            await sleep(0);
          }
          // 这一轮结束，此时无人等待 —— 安全清理点。
          pathing.clearPathfinderGoal(state.bot.pathfinder);
          // 等背包稳定（与 sweepUpDrops 同款判据）
          await sleep(600);
          got = inventoryCount(state.bot) - beforeRound;
          residueRounds.push({ round, targets: left.length, got });
          if (got > 0) dropsPicked += got;
          else break;   // 这轮一个都没拿到 → 再试也是白试
        }
        if (residueRounds.length) bulkSweep.residueRounds = residueRounds;

        bulkSweep.gainedAtBulk = inventoryCount(state.bot) - beforeBulk;
      } catch (e) {
        bulkSweep = { error: e.message };
      }
    }

    const last = sweeps[sweeps.length - 1];
    return {
      [byItem ? 'itemName' : 'blockName']: label,
      resolvedVia,
      // `resolveSource` 是给调用方的**可信度提示**：
      //   'drops'     —— 从原版 drops 表精确命中，可信
      //   'name'      —— 按命名规律推断，可能猜错
      //   'mixed'     —— 两者都有
      //   'blockName' —— 调用方直接给了方块名，不涉及推断
      resolveSource,
      resolveCandidates,
      requested: +count,
      // ⚠️ `mined` **现在只统计"世界真的发生了变化"的方块**。
      //    这是 P1c 的教训：以前 `dig()` 一返回就计数，于是它空转时
      //    `mined` 是个漂亮但假的数字，上层据此以为挖到了。
      //    宁可报 0，也不要一个骗人的成功。
      mined: mined.length,
      minedBlocks: mined.slice(0, 16),
      dropsPicked,
      // ★ 2026-09-25（P44 架构修复）：`ok` —— 让这个 handler 也能**否决**路由层的
      //   `success: true`。语义："这次挖掘在世界里有没有真的发生"。
      //   `mined` 已经在 P1c 修成"世界真的变了才算"，所以它 > 0 就是可信判据。
      //   ⚠️ 只在**真正一块都没挖动**时才 false —— 挖到了但没捡起来仍是 ok:true
      //      （"挖"这个动作生效了；"捡"是另一回事，由 `/pickup` 自己负责）。
      ok: mined.length > 0,
      // 挖完之后对整片区域的**一次**统一清扫（P10 第二轮）。
      // 与每块的 `drops` 分开报：后者是"顺手捞到的"，这里才是"兜底捞到的"。
      bulkSweep: bulkSweep || undefined,
      // ⚠️ `mined` 与 `dropsPicked` 都**不等于**"进背包几件"。
      //    拾取是服务端判定的，客户端只能"走过去"。要确认真正到手，查 /inventory。
      inventoryDelta: inventoryCount(state.bot) - invBefore,
      // dig 空转了几次（动作声称成功、世界没变）。
      // 与"挖不动"是两回事：前者是**我们的动作没生效**，后者是工具/硬度不够。
      // 分开报，运维才不会去查错方向。
      digStalls: digStalls.length ? digStalls.slice(0, 8) : undefined,
      searchedUpTo: radius,
      // "搜了多大"必须如实报 —— 这是"附近没有"与"我找不到"的区别所在
      note: last?.action === 'give-up'
        ? `搜到 ${radius} 格仍未拿够：${last.reason}`
        : undefined,
      sweeps,
    };
  },

  'POST /collect': async ({ itemName, count = 1 }) => {
    if (!itemName) throw new Error('itemName field required');
    count = Math.min(Math.max(1, +count), 64);
    const targets = Object.values(state.bot.entities)
      .filter(e => isDropEntity(e) && e.metadata?.[8]?.itemId)
      .filter(e => {
        const meta = e.metadata[8];
        const id = state.bot.registry.items[meta.itemId]?.name;
        return id === itemName;
      })
      .slice(0, +count);

    if (!targets.length) return { collected: 0, message: `No ${itemName} on the ground nearby` };

    state.currentAction = `collecting ${itemName}`;
    let collected = 0;
    const failures = [];
    for (const entity of targets) {
      try {
        // 掉落物会移动（被水冲、被别的玩家带走），按理该用短超时。但 `gotoWithBudget`
        // 的 ETA 是按**静态路径**算的，对会跑的目标偏保守 —— 于是这里只把标签传进去，
        // 让"卡住"时的报错能看出来是捡东西卡住，不额外压超时：
        // 压太紧会让"她还在追"被误判成"追不上"。
        await gotoWithBudget(state, new goals.GoalFollow(entity, 1), { label: `collect ${itemName}` });
        collected++;
      } catch (e) {
        failures.push(e.message);
      }
    }
    state.currentAction = null;
    // ⚠️ 掉落物拾取是**服务端判定**的：客户端走到附近，服务端把物品塞进背包。
    //    所以这里的 `collected` 是"走到了几件旁边"，不等于"真的进了背包"。
    //    要确认真进了，得看 /inventory。接口名保持 `collected` 是为了兼容，
    //    但 note 里把这件事说清楚，免得调用方把它当成"拾取了 N 件"。
    return {
      itemName, collected, attempted: targets.length, failures: failures.slice(0, 3),
      note: 'collected = 走到并停留的件数；是否真进背包由服务端判定，请查 /inventory',
    };
  },

  'POST /craft': async ({ itemName, count = 1 }) => {
    if (!itemName) throw new Error('itemName required');
    const item = state.bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item: ${itemName}`);

    const tableBlock = state.bot.findBlock({
      matching: state.bot.registry.blocksByName['crafting_table']?.id,
      maxDistance: 5,
    });

    const recipes = state.bot.recipesFor(item.id, null, 1, tableBlock);
    if (!recipes.length) {
      // ⚠️⚠️ 2026-09-25（P49）：这句报错以前是
      //   `No recipe for X (or missing crafting table)` —— 把三种情况混成一句，
      //   我**自己**就在排查时被它带着误判了三次（先怪配方表、再怪 minecraft-data）。
      //   现在用 `recipesAll`（**只查配方、不查背包**）把它切开：
      //     · 一条配方都没有         → 真没这个配方（或数据缺失）
      //     · 有配方但材料不够       → **缺材料**，并列出还差什么（可行动）
      const all = (() => { try { return state.bot.recipesAll(item.id, null, tableBlock) || []; } catch (_) { return []; } })();
      if (!all.length) {
        throw new Error(`No recipe for ${itemName}`
          + (tableBlock ? '' : '（附近 5 格内也没有工作台，3×3 配方需要它）'));
      }
      const inv = state.bot.inventory?.items?.() || [];
      const countOf = (id) => inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
      const needLines = [];
      for (const r of all) {
        const gap = (r.delta || []).filter(d => d.count < 0)
          .map(d => ({ name: state.bot.registry.items?.[d.id]?.name || `id:${d.id}`, need: -d.count, have: countOf(d.id) }))
          .filter(g => g.have < g.need);
        if (gap.length) {
          needLines.push((r.requiresTable ? '[需工作台] ' : '')
            + gap.map(g => `${g.name} ${g.have}/${g.need}`).join(' + '));
        }
        if (needLines.length >= 3) break;
      }
      throw new Error(`材料不够（配方有 ${all.length} 条，但一条都做不了）：`
        + (needLines.join(' ｜ ') || '（算不出缺什么）')
        + '　—— 用 `GET /recipes?item=' + itemName + '` 看完整缺口');
    }

    state.currentAction = `crafting ${count}x ${itemName}`;
    await withTimeout(state.bot.craft(recipes[0], +count, tableBlock));
    state.currentAction = null;
    return { crafted: itemName, count: +count };
  },

  'POST /follow': async ({ playerName }) => {
    if (!playerName) throw new Error('playerName required');
    const target = state.bot.players[playerName]?.entity;
    if (!target) throw new Error(`Player ${playerName} not found or too far away`);
    state.currentAction = `following ${playerName}`;
    state.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    return { following: playerName };
  },

  // ================== 原始控制层：直接按键，不经过寻路器 ==================
  //
  // 为什么需要它：`POST /move` 走的是 mineflayer-pathfinder，那是个**高层 API**，
  // 自带一整套世界模型（哪里能走、哪块能拆、哪个能爬）。而它的世界模型在模组服上是
  // **错的** —— 方块名整体偏移、梯子认不出来（climbables 写死原版 ID）、
  // 未映射的模组方块被当成空气。我们前几轮一直在给这个错误的世界模型打补丁。
  //
  // 而"按键"这条路**绕开世界模型**：按 W 就是往前走，梯子、台阶、水、门
  // 全由游戏自己处理。真人爬梯子就是"看着梯子按住 W"，他不需要知道梯子的方块 ID。
  // mineflayer 暴露的这 7 个控制位正好是 WASD + 空格 + Shift：
  //   forward / back / left / right / jump / sprint / sneak
  // 配上 `POST /look` 就是完整的键鼠 —— 也就是说**输入模拟的一半我们早就有了**
  // （lookAt 用了 6 处），缺的只是键盘这一半。
  //
  // ⚠️ 但原始控制**没有闭环**：按住 W 之后，撞墙和前进在"按下去了"这个层面长得一样。
  //    所以这个端点一定返回位移 delta，让调用方（或上层原语）能判断"到底动没动"。
  //    这不是可选项 —— 没有反馈的按键等于把"卡住"变成静默失败。
  'POST /control': async ({ durationMs = 800, ...bits }) => {
    const ALLOWED = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    const wanted = {};
    for (const k of ALLOWED) if (bits[k] !== undefined) wanted[k] = !!bits[k];
    if (!Object.keys(wanted).length) {
      throw new Error(`no control bit given; allowed: ${ALLOWED.join(', ')}`);
    }
    const ms = Math.min(Math.max(+durationMs || 800, 50), CFG.bridge.controlMaxMs);
    const from = botPosExact();
    const held = Object.keys(wanted).filter(k => wanted[k]);

    // ⚠️ 身体只有一个。如果寻路器还有活着的目标，它会**每个 tick 覆盖**我们设的控制位 ——
    //    现象是"按了没反应"（位移≈0、连 jump 都不动），极易误诊成"物理层坏了/她卡住了"。
    //    所以这里显式接管，并如实上报，而不是默默打架。
    let clearedGoal = false;
    if (state.bot.pathfinder.goal) {
      try { state.bot.pathfinder.setGoal(null); clearedGoal = true; } catch (_) {}
      console.log('[control] 寻路器目标还活着，已清除 —— 原始控制接管身体');
    }

    // 先全清：上一次的残留如果叠加进来，"按住 forward"会变成"forward+sprint+..."
    state.bot.clearControlStates();
    for (const k of held) state.bot.setControlState(k, true);
    state.currentAction = `control ${held.join('+')} ${ms}ms`;
    try {
      await sleepMs(ms);
    } finally {
      // ⚠️ 无论正常还是异常都必须松手。异常路径下按键卡住 = 她会一直往前走，
      //    这比"这一步没走成"严重得多。用 finally 而不是顺序执行，就是为了这个。
      state.bot.clearControlStates();
      state.currentAction = null;
    }

    const to = botPosExact();
    return {
      held,
      durationMs: ms,
      clearedGoal,
      from,
      to,
      moved: {
        x: +(to.x - from.x).toFixed(2),
        y: +(to.y - from.y).toFixed(2),
        z: +(to.z - from.z).toFixed(2),
      },
    };
  },

  // 爬梯子：**闭环原语**，不是一次按键。
  //
  // 背景（2026-09-23）：这个端点一开始在模组服上爬不上去，当时的诊断是"物理层写死的
  //    ladder.id 与服务器不符" ——
  //        const ladderId = blocksByName.ladder.id        // 原版 196
  //        function isOnLadder (world, pos) { if (block.type === ladderId) return true }
  //    ⚠️ **那个诊断已被推翻**：服务端 1003 个原版方块 id 与原版**零差异**，
  //       原版梯子就是 196 —— 物理层那套**本来就是对的**。当时看到的"改成 215 就会爬了"
  //       是自我实现：我们把 215 号方块**告诉**物理层是梯子，它当然照做。
  //       真正的失败原因**尚未定论**，下一步是拿服务端实读的 `block.type` 来判
  //       （`GET /block` 的 `stateId` + 调色板/快照）。
  //
  //    仍然成立的那半句：**`setControlState` 并不把按键发给真客户端** —— 它交给
  //    `prismarine-physics` 自己算。所以"模拟输入"和"高层寻路"共用同一个物理模拟。
  //    实测：横向对准成功、走进梯子格、按住 W 多个 700ms，Δy 始终为 0。
  //
  //    所以本端点现在的立场是：**先如实测量，再谈结论**。
  //    修没修上、认不认得出，看 `GET /config` 的 `pathfinder.ladderFix` 与
  //    `pathfinder.climbables.libraryPathWouldWork` —— 不要靠猜。
  //
  // 这个端点把"闭环"做对了：它的 `stalledAtY` 是**如实承认做不到**的出口，
  // 不会无限空转。
  //   看向梯子 → 按住 jump 一小段 → 松开 → 看 y 涨没涨
  //   涨了继续，连着几次不涨就报 stalledAtY，而不是无限按下去。
  //
  // `autoOpen`（默认开）：爬不动时**抬头看头顶那格**。如果是个方块，就右键它一次
  //    （真人这时就是这么做的 —— 玩家原话：「他应该会自己开这种类型的」）。
  //    ⚠️ 关键在**只把实测穿得过去的那个 state 记为可通行**：
  //      右键既能开也能关，猜错方向就会让她穿模（服务端会把她推回来）。
  //      所以流程是"乐观放行 → 实测 → 爬不上去就撤回"，撤回后等于什么都没做。
  'POST /climb': async ({ x, y, z, maxMs = 8000, stepMs = 500, autoOpen = true }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x/y/z required (the ladder block to climb)');
    }
    const targetY = +y;
    const startY = state.bot.entity.position.y;
    const step = Math.min(Math.max(+stepMs, 100), 1500);
    const budget = Math.min(Math.max(+maxMs, 500), CFG.bridge.controlMaxMs * 4);
    const deadline = Date.now() + budget;

    // 视角必须对准梯子 —— 没看着它，按 W 只会往前走
    await state.bot.lookAt(new Vec3(+x, +y, +z), true);

    let attempts = 0;
    let stalled = 0;
    let lastY = startY;
    let opened = null;    // 记录"她抬头处理头顶那格"的经过与验证结果
    let openPhase = 0;    // 0 未试 / 1 已假设"本来就是开的" / 2 已切换过一次 / 3 放弃
    state.currentAction = `climbing to y=${targetY}`;
    try {
      while (Date.now() < deadline && state.bot.entity.position.y < targetY - 0.2) {
        attempts++;
        // ⚠️ **只按 jump，不要同时按 forward。**（2026-09-23 实测，本包）
        //      jump 单独按      → Δy = +2.2 格（有效）
        //      forward + jump   → Δy = 0     （无效）
        //    物理层的攀爬条件（prismarine-physics/index.js:592）是
        //        isOnLadder && (isCollidedHorizontally || (climbUsingJump && control.jump))
        //    —— 两条路都以 `isOnLadder` 为前提。既然 jump 这条实测能走通，
        //    就不该再按 forward：这包里的梯子嵌在**一格宽**的门缝里（33/35 都是门），
        //    按 forward 只会让她顶住墙，白耗掉这次按压。
        state.bot.setControlState('jump', true);
        await sleepMs(step);
        state.bot.clearControlStates();
        await sleepMs(80); // 留一帧让物理结算，否则读到的还是旧 y
        const nowY = state.bot.entity.position.y;
        if (nowY - lastY < 0.05) stalled++; else stalled = 0;
        lastY = nowY;

        if (stalled < 4) continue;

        // 连着四次不动 —— 头顶大概率撞着一扇闭着的门/活板门。真人这时会抬头把它打开。
        // 只试一次：原状态已被实测证明挡人，切换一次若还挡，切回去只会回到已知的挡。
        const headPos = state.bot.entity.position.offset(0, 2, 0).floored();
        const above = state.bot.blockAt(headPos);
        if (!opened && autoOpen && above && above.name !== 'air') {
          let r = null;
          try {
            r = await useBlockAt(headPos);
          } catch (e) {
            console.log(`[climb] 头顶 ${headPos.x},${headPos.y},${headPos.z} 用不了：${e.message}`);
          }
          if (r && r.stateChanged) {
            // 乐观放行 + 立刻实测验证。验证失败会在循环外撤回 ——
            // **绝不能留着猜错的白名单**，留着就是穿模，服务端会把她推回来。
            state.passableStateIdsRuntime.add(r.after.stateId);
            opened = {
              pos: { x: headPos.x, y: headPos.y, z: headPos.z },
              face: r.face,
              fromStateId: r.before.stateId,
              toStateId: r.after.stateId,
              atY: +state.bot.entity.position.y.toFixed(2),
              verified: false,
              rolledBack: false,
            };
            console.log(`[climb] 头顶撞到方块，已右键打开：stateId ${r.before.stateId} → ${r.after.stateId}`
              + `（face=${r.face}，先放行，爬上去才算数）`);
            stalled = 0;
            lastY = state.bot.entity.position.y;
            continue;
          }
          // 点了但 state 没变 → 那不是门，别在这儿耗
          if (r) console.log(`[climb] 头顶方块右键后 state 没变（stateId ${r.before.stateId}），不是门`);
        }
        break; // 承认做不到，别空转
      }
    } finally {
      state.bot.clearControlStates();
      state.currentAction = null;
    }

    const endY = state.bot.entity.position.y;

    // 验证：开了门之后真的爬上去了吗？没上去就把白名单撤回，等于什么都没做。
    if (opened) {
      opened.verified = endY > opened.atY + 0.5;
      if (!opened.verified) {
        state.passableStateIdsRuntime.delete(opened.toStateId);
        opened.rolledBack = true;
        console.log(`[climb] 开了门仍然上不去，已撤回 stateId ${opened.toStateId} 的放行（不猜）`);
      }
    }

    return {
      targetY,
      fromY: +startY.toFixed(2),
      toY: +endY.toFixed(2),
      climbed: +(endY - startY).toFixed(2),
      reached: endY >= targetY - 0.2,
      attempts,
      autoOpen: opened,
      // 非 null 表示"她卡在这个高度上不去了" —— 这是要报给玩家的，不是静默失败
      stalledAtY: endY < targetY - 0.2 ? +endY.toFixed(2) : null,
    };
  },

  // 右键"用"一个方块：开活板门 / 门 / 拉杆 / 按钮 / 栅栏门。
  //
  // 为什么必须有这个端点：**寻路器不会开活板门**。
  //   `mineflayer-pathfinder/lib/movements.js:97` 的 `openable` 只收名字里带 "gate"
  //   的方块，而且 `canOpenDoors` 默认是 `false`（作者注释：Causes issues）。
  //   所以在寻路器眼里，一扇闭着的活板门就是一堵墙。
  //
  //   真人遇到闭着的活板门会怎么做？**右键打开**。这个端点就是那只手。
  //   （别用 MC_PASSABLE_STATE_IDS 把它放行 —— 那是穿模，服务端会拒。）
  //
  // `face` 可以显式给（top/bottom/north/south/east/west），不给就自动选
  // **朝向她的那一面**。自动选很重要：玩家指出的那个活板门在她头顶上方，
  // 顶面朝屋顶里面够不着，必须点底面 —— 而 `activateBlock` 的默认值是顶面。
  'POST /activate': async ({ x, y, z, face, passableAfter = false }) => {
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('x/y/z required (the block to activate)');
    }
    const r = await useBlockAt(new Vec3(+x, +y, +z), { face });
    // `passableAfter` 要显式打开才记白名单 —— 默认不猜。
    // 因为"右键"既能开也能关：默认放行的话，一次误关就会让她穿模（服务端会把她推回来，
    // 那正是我们刚修掉的那个 bug）。由调用方声明意图，比我们替它猜要诚实。
    if (passableAfter && r.stateChanged) {
      state.passableStateIdsRuntime.add(r.after.stateId);
      r.markedPassable = r.after.stateId;
    }
    return r;
  },

  // ---- 方块调色板 ----------------------------------------------------------
  //
  // 这一组接口是"她能不能认出方块"这件事的正面回答。
  // 背景一句话：1.13 之后方块名不在网络流里，靠客户端本地注册表翻译；
  // 我们只有原版数据，所以模组方块全是空名字。唯一的精确来源是**跑着的那个客户端**。

  // 状态：调色板导入了没有、覆盖多少个方块、有没有断点。
  'GET /palette': async () => {
    if (!state.palette) {
      return {
        loaded: false,
        // 没调色板时模组方块是什么样 —— 说清楚，免得以为"名字空了就是没读方块"
        withoutPalette: {
          blockTypeIsUndefined: true,
          note: '模组方块的 b.type 恒为 undefined、b.name 恒为空串。'
            + '所以**梯子配置也不会生效**（两层判据都是 block.type === ladderId）。'
            + '碰撞已由"未映射一律实心"兜住，缺的是身份。',
        },
        candidates: paletteCandidates(),
        hint: '把 kubejs/startup_scripts/src/zz_angel_dump_block_palette.js 放进整合包，'
          + '重启一次客户端（或 /kubejs reload startup_scripts），再把 angel_block_palette.txt 导入。',
        importWith: 'POST /registry/import-palette  {"file":"<绝对路径>"}',
      };
    }
    return {
      loaded: true,
      ...state.paletteMeta,
      // 顺带把她真正该用的可攀爬 stateId 列出来（这才是 MC_CLIMBABLE_STATE_IDS 的正确填法）
      ladderStateIds: blockPalette.climbableStateIds(state.palette).slice(0, 16),
      // 注入进**本次 bot 注册表**的摘要（这才是"能不能读到方块名/类型"的关键指标）。
      // offlineValidation 保留启动时的全量校验结果，避免把 validation-only 误报成实际注入。
      injectedIntoRegistry: state.paletteInject
        ? {
            ok: state.paletteInject.ok,
            committed: state.paletteInject.committed === true,
            botRegistry: state.paletteInject.botRegistry === true,
            overlayBlocks: state.paletteInject.overlayBlocks,
            overlayStates: state.paletteInject.overlayStates,
            blocks: state.paletteInject.blocks,
            states: state.paletteInject.states,
            vanillaExpanded: state.paletteInject.vanillaExpanded,
            vanillaStateEnd: state.paletteInject.vanillaStateEnd,
          }
        : null,
      offlineValidation: state.paletteMeta?.inject ?? null,
      // mineflayer 每次连接使用独立 registry；真正的判据是本次 bot 是否完成注入。
      registryIsSharedSingleton: false,
      registryIsPerConnection: !!state.bot?.registry,
      registryInjectedOnBot: !!state.paletteInject?.botRegistry && !!state.paletteInject?.ok,
    };
  },

  // 导入一份 dump。不给 file 就按 MC_PACK_DIR 自动找。
  'POST /registry/import-palette': async ({ file } = {}) => {
    if (file) {
      const r = importPalette(file);
      return r.ok ? { success: true, ...r.meta } : { success: false, reason: r.reason, ...(r.meta || {}) };
    }
    for (const f of paletteCandidates()) {
      if (!fs.existsSync(f)) continue;
      const r = importPalette(f);
      return r.ok ? { success: true, ...r.meta } : { success: false, reason: r.reason, ...(r.meta || {}) };
    }
    return { success: false, reason: '没找到 dump 文件', candidates: paletteCandidates() };
  },

  // 查一个 stateId 到底是什么方块、什么状态。
  // GET 的参数一律从 query 取（第二参数 q）。分发器会把 query 并进第一参数，
  // 但显式写成 (_, q) 才是本文件的约定 —— 别让后来人照抄错的那版。
  'GET /palette/state': async (_, q) => {
    const { id } = q || {};
    if (id === undefined) throw new Error('id required（全局 state id）');
    const stateId = +id;
    const hit = blockPalette.lookupState(state.palette, stateId);
    if (!hit) {
      return {
        stateId,
        found: false,
        reason: state.palette ? '这个 stateId 不在调色板覆盖范围内' : '还没导入调色板',
      };
    }
    return {
      stateId,
      found: true,
      block: hit.name,
      blockRegistryId: hit.blockId,
      localStateIndex: hit.local,
      stateCount: hit.count,
      properties: hit.properties,
      propertiesText: blockPalette.formatProps(hit.properties),
    };
  },

  // 反查：方块名 → 它的 state 区间。回答"我该把哪个 stateId 当梯子"。
  'GET /palette/block': async (_, q) => {
    const { name } = q || {};
    if (!name) throw new Error('name required（如 minecraft:ladder）');
    const b = blockPalette.findBlock(state.palette, name);
    if (!b) return { name, found: false, reason: state.palette ? '调色板里没有这个方块' : '还没导入调色板' };
    return { name, found: true, ...b, stateIds: [] };
  },

  // 直接给出"她该用哪些 stateId 认梯子"。给 MC_CLIMBABLE_STATE_IDS 用。
  'GET /palette/climbable': async (_, q) => {
    const name = (q && q.name) || 'minecraft:ladder';
    const ids = blockPalette.climbableStateIds(state.palette, name);
    // ⚠️ 别急着叫人去配 `MC_CLIMBABLE_STATE_IDS`。2026-09-23 实测：原版方块 id 零位移，
    //    原版梯子解析出来就是 196 → 配了也是"与当前值一致、无需改动"的**空操作**。
    //    真正需要配的是**非原版**梯子（本包 32 种梯子里 31 种是模组加的）。
    //    所以这里按"解析出的方块 id 是不是原版梯子"分开给建议，而不是一律叫去配。
    const hit = ids.length ? blockPalette.lookupState(state.palette, ids[0]) : null;
    const vanillaLadderId = state.bot?.registry?.blocksByName?.ladder?.id ?? 196;
    const isVanilla = !!hit && hit.blockId === vanillaLadderId;
    return {
      block: name,
      found: ids.length > 0,
      stateIds: ids,
      blockRegistryId: hit ? hit.blockId : null,
      configValue: ids.join(','),
      note: !ids.length
        ? (state.palette ? '调色板里没有这个方块' : '还没导入调色板')
        : isVanilla
          ? `这是原版梯子（方块 id ${hit.blockId}）—— 两层本来就认得出来，**不需要**配任何东西`
          : `非原版梯子（方块 id ${hit.blockId}）。优先配 MC_CLIMBABLE_BLOCK_NAME=${name}`
            + `（走服务端快照，不经过 state，更可靠）；state 路线才填 MC_CLIMBABLE_STATE_IDS=${ids.join(',')}`,
    };
  },

  // 诊断：Forge FML 握手推来的注册表清单 + 快照摘要。
  //
  // 这是回答"为什么她认不出方块"的关键证据。1.13 之后 `chunk_data` 里只有
  // **全局调色板数字 ID**，方块名靠客户端本地注册表翻译。原版客户端装了模组
  // 所以认识，我们只有原版 minecraft-data 所以全是空名字。
  // 而 Forge 会通过 `S2CRegistry` 把注册表推给客户端 —— 这个端点就是看
  // 服务端到底推了哪些、里面有没有 `minecraft:block`。
  'GET /debug/registries': async () => {
    const fmlState = state.__fml && state.__fml.state;
    if (!fmlState) {
      return { enabled: false, hint: '需要 MC_FORGE=1 且已连上服务端' };
    }
    const snaps = fmlState.registrySnapshots || [];
    const withSnap = snaps.filter(s => s.hasSnapshot);
    return {
      enabled: true,
      handshakeDone: fmlState.done,
      acked: fmlState.acked,
      declaredRegistries: fmlState.registries || [],
      declaredCount: (fmlState.registries || []).length,
      declaredHasBlock: (fmlState.registries || []).includes('minecraft:block'),
      receivedCount: snaps.length,
      receivedWithSnapshot: withSnap.length,
      // 全部明细：名字 / 有没有快照 / 字节数 / 解析出多少条 / 是否正好吃完
      snapshots: snaps,
      // 真正拿到手的两张表
      blockRegistry: fmlState.blockRegistry
        ? { entryCount: fmlState.blockRegistry.entries.length, sample: fmlState.blockRegistry.entries.slice(0, 8) }
        : null,
      itemRegistry: fmlState.itemRegistry
        ? { entryCount: fmlState.itemRegistry.entries.length }
        : null,
      files: fs.existsSync(REGISTRY_DIR) ? fs.readdirSync(REGISTRY_DIR) : [],
    };
  },

  // 查一张已落盘的注册表：`?name=minecraft:block&q=glass_trapdoor&limit=20`
  'GET /debug/registry': async (_, qs) => {
    const name = (qs && qs.name) || 'minecraft:block';
    const q = (qs && qs.q) || '';
    const limit = (qs && qs.limit) || 20;
    const file = path.join(REGISTRY_DIR, String(name).replace(':', '-') + '.json');
    if (!fs.existsSync(file)) {
      return { found: false, file, hint: '还没落盘。确认 MC_FORGE=1 且握手已完成。' };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const needle = String(q).toLowerCase();
    const hits = data.entries.filter(([n]) => !needle || n.toLowerCase().includes(needle));
    return {
      found: true, registry: data.registry, capturedAt: data.capturedAt,
      total: data.entryCount, matched: hits.length,
      entries: hits.slice(0, Math.min(+limit || 20, 200)),
    };
  },

  // 诊断：服务端发来的包统计 + 注册表探针结果（MC_PROBE_PACKETS=1 才有内容）。
  // 用途：确认"方块名到底有没有可能从网络流里拿到" —— 不要再靠猜。
  'GET /debug/packets': async () => {
    if (!state.__probe) {
      return { enabled: false, hint: '用 MC_PROBE_PACKETS=1 启动才会挂探针' };
    }
    const s = state.__probe;
    return {
      enabled: true,
      totalPackets: s.packets,
      // 只回传出现次数最多的前 30 个包名，避免响应过大
      topPackets: Object.entries(s.byName).sort((a, b) => b[1] - a[1]).slice(0, 30),
      declareCommands: s.declareCommands,
      tags: s.tags,
      notes: s.notes,
    };
  },

  // 上浮换气。给反射层用（`reflex.js` 的 `reflex:breathe`）。
  //
  // 为什么不用寻路：憋气是以**秒**计的，而 `pathfinder.goto` 先要 A* 算路（几百毫秒起），
  // 三维水下还经常算不出路。原版的解法最简单 —— 一直按跳跃键，人自己就浮上去了。
  //
  // ⚠️ `durationMs` 是**最长**时间，不是保证时间。到水面就提前停：
  //    氧气在回涨就说明已经能呼吸了，继续按着跳会让"站在岸边"变成"一直跳"。
  'POST /jump': async ({ durationMs = 1200, stopAtOxygen = 60 } = {}) => {
    durationMs = Math.min(Math.max(100, +durationMs || 1200), 10000);

    state.currentAction = 'jumping（上浮 / 越过障碍）';
    const t0 = Date.now();
    let jumped = 0;
    let stoppedEarly = null;
    try {
      // 每 100ms 一跳而不是"按住不放"：
      // mineflayer 的 setControlState('jump', true) 在服务端只保证**当前 tick** 生效，
      // 按住需要客户端持续发包。分段跳既完成上浮，又给了中断的机会。
      while (Date.now() - t0 < durationMs) {
        state.bot.setControlState('jump', true);
        await sleep(100);
        state.bot.setControlState('jump', false);
        jumped++;

        // 已经能呼吸了 → 提前收工
        const oxy = state.bot.oxygenLevel;
        if (Number.isFinite(oxy) && oxy >= stopAtOxygen) {
          stoppedEarly = `氧气已回到 ${oxy}，提前停止`;
          break;
        }
        // 掉线/死亡时立刻退出，别空转满 durationMs
        if (!state.connected || state.bot.health === 0) break;
        await sleep(50);
      }
    } finally {
      try { state.bot.setControlState('jump', false); } catch (_) {}
      state.currentAction = null;
    }

    return {
      jumped,
      durationMs: Date.now() - t0,
      oxygen: state.bot.oxygenLevel ?? null,
      onGround: state.bot.entity?.onGround ?? null,
      stoppedEarly: stoppedEarly || undefined,
    };
  },

  // 朝远离某点的方向走一段。给反射层用（`reflex.js` 的 `reflex:fleeFire`）。
  //
  // ⚠️ 与 `POST /stop` 的关系：这个是"动"，那个是"停"。
  //    实现上**必须先 setGoal(null)** —— 否则寻路器还挂着旧目标，
  //    `goto` 会被它自己覆盖掉（实测过：不 clear 的情况下 goto 不动）。
  'POST /flee': async ({ distance = 8, fromX, fromY, fromZ } = {}) => {
    distance = Math.min(Math.max(1, +distance), 32);
    const self = state.bot.entity;
    if (!self?.position) throw new Error('bot 没有位置（未连接？）');

    // 从哪逃：默认是**当前位置**（也就是"离开这里"）。
    // 调用方给了坐标就用它（比如"远离火源那块方块"）。
    const ox = fromX !== undefined ? +fromX : Math.floor(self.position.x);
    const oz = fromZ !== undefined ? +fromZ : Math.floor(self.position.z);

    // 8 个方向各试一遍，选"目标点最远离原点"的那个。
    // ⚠️ 只看水平方向：往垂直方向逃（跳下悬崖/爬上墙）都需要地形信息，
    //    而反射层的全部意义就是**不需要**地形信息。
    const dirs = [
      [1, 0], [1, 1], [0, 1], [-1, 1],
      [-1, 0], [-1, -1], [0, -1], [1, -1],
    ];
    const scored = dirs
      .map(([dx, dz]) => {
        const len = Math.hypot(dx, dz) || 1;
        const tx = Math.floor(self.position.x) + Math.round((dx / len) * distance);
        const tz = Math.floor(self.position.z) + Math.round((dz / len) * distance);
        return { tx, tz, score: Math.hypot(tx - ox, tz - oz) };
      })
      .sort((a, b) => b.score - a.score);

    // 先清掉旧目标，否则 goto 会被 pathfinder 自己的旧 goal 顶掉
    try { state.bot.pathfinder.setGoal(null); } catch (_) {}
    state.bot.clearControlStates();

    state.currentAction = `fleeing to ${scored[0].tx},${scored[0].tz}`;
    const attempted = [];
    try {
      for (const cand of scored.slice(0, 3)) {
        try {
          await withTimeout(
            state.bot.pathfinder.goto(
              new goals.GoalNear(cand.tx, Math.floor(self.position.y), cand.tz, 2),
            ),
            Math.max(2000, distance * 500),
          );
          return {
            fled: true,
            to: { x: cand.tx, z: cand.tz },
            from: { x: ox, z: oz },
            distance: +Math.hypot(cand.tx - ox, cand.tz - oz).toFixed(1),
            alternativesTried: attempted.length,
          };
        } catch (e) {
          attempted.push(`(${cand.tx},${cand.tz}): ${e.message}`);
        }
      }
    } finally {
      state.currentAction = null;
    }

    return {
      fled: false,
      from: { x: ox, z: oz },
      // 三个方向都走不了，很可能是被围住了 —— 如实报告，让上层决定
      reason: `8 个方向里最近的 3 个都走不通：${attempted.join('；')}`,
    };
  },

  'POST /stop': async () => {
    state.bot.pathfinder.setGoal(null);
    // ⚠️ 控制位也必须清 —— 否则"急停"停不住一个按住的 W。
    // 这是原始控制层引入后必须补的一环：看门狗的危险急停走的就是这个端点。
    state.bot.clearControlStates();
    state.currentAction = null;
    return { stopped: true, controlsCleared: true };
  },
};

// hands.js 的路由挂到同一张表上。同名会**静默覆盖** —— /eat 就这样在上面留过一份永远不会被调用的死代码，
// 所以重名一律在启动时喊出来。
const handRoutes = hands.routes({ state, withTimeout });
for (const k of Object.keys(handRoutes)) {
  if (k in handlers) console.warn(`[bridge] ⚠️ 路由重名：${k} —— hands.js 的会覆盖 bridge-server.js 的，删掉其中一份`);
}
Object.assign(handlers, handRoutes);

// 有些客户端（curl、部分 agent 的 HTTP 封装）会把中文以原始 UTF-8 字节直接塞进 URL，
// 而 Node 的 HTTP 解析器按 latin1 解码，于是「出货箱」变成「å‡ºè´§ç®±」，查询永远匹配不到。
// 这里做一次检测式还原：只有出现 0x80–0xFF 区间的字符时才尝试 latin1→utf8 重解码，
// 且还原后若出现替换字符（\ufffd）就判定原本是合法文本，保持原样。percent-encoded
// 的 URL 本来就正确，不会被这段逻辑影响。
// 注意：Node 会直接以 400 拒绝请求行里的非 ASCII 字节，所以真正稳妥的写法是
// 百分号编码的 GET，或者把关键词放进 JSON body 的 POST /knowledge/search。
function fixMojibake (s) {
  if (typeof s !== 'string' || !s) return s;
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? s : fixed;
  } catch {
    return s;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let body = '';
  let bodyBytes = 0;
  req.on('data', c => {
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      json(res, 413, { success: false, error: 'Request body too large' });
      req.destroy();
      return;
    }
    body += c;
  });

  req.on('end', async () => {
    const url = req.url.split('?')[0];
    const rawQs = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
    const qs = {};
    for (const [k, v] of Object.entries(rawQs)) qs[k] = fixMojibake(v);
    const key = `${req.method} ${url}`;
    const handler = handlers[key];

    if (!handler) {
      json(res, 404, { error: 'Unknown route', available: Object.keys(handlers) });
      return;
    }

    // /status、/config、/memory、/state、/knowledge 在机器人离线时也应可读
    // （离线时恰恰最需要看配置、记忆和游戏资料：为什么连不上、上次到哪了、这东西哪来的）
    // 这些路由**不碰游戏**，只读磁盘/内存，所以机器人离线时也必须可读。
    // 离线时恰恰最需要它们：调色板导入完了没有、快照抓到几条、为什么名字还是空的
    // —— 全是在"还没连上"的时候要查的。以前它们被连接前置检查挡在门外，
    // 想看诊断信息得先连上，而连不上正是要看诊断的原因（循环依赖）。
    const OFFLINE_OK = new Set([
      'GET /status', 'GET /config', 'GET /memory', 'GET /state',
      'GET /knowledge', 'GET /knowledge/search', 'POST /knowledge/search',
      // 调色板：本地文件 + 内存表
      'GET /palette', 'GET /palette/state', 'GET /palette/block', 'GET /palette/climbable',
      'POST /registry/import-palette',
      // FML 注册表快照：同样是本地文件 + 内存表
      'GET /debug/registries', 'GET /debug/registry',
      // 物品注册表：本地快照 + 内存里的注入报告
      'GET /item',
      // 插件装配状态：`GET /scan` 离线时也能看（会明确报"没连"），
      // `/eat` `/pickup` 不在此列 —— 那两个真的需要一张身体。
      'GET /plugins',
      // 实体诊断：**离线时也要能看**。它存在的场合正是"她好像什么都看不见"，
      // 而"没连上"和"连上了但认不出东西"必须能区分开 —— 这就是 P8 的教训。
      'GET /entities',
      // 重连：它存在的意义就是"当前没连上"
      'POST /reconnect',
      // ★ 配方表诊断（P49）：同样**离线也要能看** —— 它存在的场合正是
      //   "她做不出东西"，而"没连上"和"连上了但配方表是空的"必须能区分开。
      'GET /recipes',
    ]);
    if (!OFFLINE_OK.has(key) && !requireConnected(res)) return;

    try {
      const parsed = body ? JSON.parse(body) : {};
      // ⚠️ GET 的参数在 **query string** 里，POST 的在 body 里。以前这里只把 body 传给
      //    第一个参数，于是任何写成 `'GET /x': async ({ id }) => …` 的端点都**永远拿到
      //    默认值**（body 空 → 解构全落默认），不报错、只是静默失效。
      //    这个坑上一轮真踩了：`/palette/state?id=`、`/palette/block?name=`、
      //    `/debug/registry?q=` 全部形同虚设，而 `name` 恰好有默认值把症状掩盖了。
      //    治标是改那 4 个端点，治本是这里合并 —— 两种写法都对，以后不会再有人踩。
      //    第二个参数仍然是 query 对象（老写法 `(_, q)` 不受影响）。
      const args = req.method === 'GET' ? { ...qs, ...parsed } : parsed;
      const result = await handler(args, qs);

      // ⚠️⚠️⚠️ 2026-09-25 修复（P44 的**架构级根因**，见 field-log）：
      //
      // 这一行以前是**无条件**的 `json(res, 200, { success: true, ...result })`。
      // 它的语义只是「handler 没抛异常」—— 但**所有调用方都把它读成「动作在世界里生效了」**。
      // 于是同一个 bug 长出了四次（P32 pickup / P35 gather / P41 shelter / P44 move）：
      //   · handler 老老实实算了 `ok: false`（她知道没做成），
      //   · 路由层把 `success: true` 贴在最前面，
      //   · 调用方看见 `success: true` 就以为成了。
      // 每次都只在**单点**修（改判据 / 加字段），根因一直没动 —— 所以还会长第五次。
      //
      // 现在的规则：
      //   · `result.ok === false`（handler 显式否决）→ **不贴** `success: true`，
      //     而是 `success: false` + `ok: false`，并带上 `_successNote` 说明为什么被否决。
      //   · 其余情况保持原样（`success: true` + 展开 result，向后兼容全部旧调用方）。
      // ⚠️ 判据只看 `=== false` 严格相等：`ok: undefined` / `ok: 0` / `ok: null`
      //    **都不否决** —— 绝大多数 handler 根本不返回 `ok`，不能让它们集体翻车。
      const vetoed = result && typeof result === 'object' && result.ok === false;
      if (vetoed) {
        json(res, 200, {
          success: false,
          ...result,                       // result 自己的字段优先（含它自己的 ok: false）
          _successNote:
            'success 由 handler 的 ok:false 否决 —— 它明确表示这个动作**没有在世界里生效**。'
            + '（以前这里无条件贴 success:true，语义只是"handler 没抛异常"，'
            + '被调用方误读成"做成了"，见 field-log P44）',
        });
      } else {
        json(res, 200, { success: true, ...result });
      }
    } catch (err) {
      console.error(`[bridge] ${key} error:`, err.message);
      json(res, 500, { success: false, error: err.message });
    }
  });
});

server.listen(CFG.bridge.port, '127.0.0.1', () => {
  const forgeOn = cfg('MC_FORGE', '0') === '1';
  const cfgFile = path.join(__dirname, 'config.json');
  console.log(`Minecraft Bridge v${BRIDGE_VERSION}`);
  console.log(`  身份 (bot identity) : ${CFG.mc.username}${CFG.mc.username === BOT_IDENTITY ? ' (固定)' : ' (被覆盖)'}`);
  console.log(`  HTTP API            : http://127.0.0.1:${CFG.bridge.port}`);
  console.log(`  Minecraft           : ${CFG.mc.host}:${CFG.mc.port}  version=${CFG.mc.version} auth=${CFG.mc.auth}`);
  console.log(`  Forge/FML 握手      : ${forgeOn ? 'ENABLED' : 'disabled'}`);
  console.log(`  config.json         : ${fs.existsSync(cfgFile) ? cfgFile : '(不存在，使用环境变量/默认值)'}`);
  console.log('  Bound to 127.0.0.1 only — do not expose this service publicly.');
  console.log('  Note: CORS headers are not sent — only same-origin or non-browser clients can access this API.');
  console.log(`  记忆 (memory)       : ${MEM_DIR}`);
  console.log(`  知识库 (knowledge)  : ${fs.existsSync(KB_DIR) ? KB_DIR : '(未安装)'}`);
  // 方块调色板：有就导入（让模组方块能叫出名字），没有就如实说没有。
  // 放在 createBot 之前只是为了让日志顺序好看 —— 名字解析器是**按引用**读
  // state.palette 的，所以之后用 POST /registry/import-palette 补上一样立刻生效。
  autoImportPalette();
  // 物品注册表快照：同样是"有就载入、没有就如实说没有"。
  // 必须在 createBot 之前读，因为注入要发生在本次连接的 inject_allowed 阶段。
  loadItemSnapshot();
  createBot();

  // 每 30 秒把"当前状态"落盘一次，这样即使进程被强杀，state.json 也是新的。
  setInterval(() => {
    if (state.connected) saveState();
  }, 30_000).unref();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bridge] Port ${CFG.bridge.port} already in use — bridge may already be running.`);
    console.error(`  Check: curl http://localhost:${CFG.bridge.port}/status`);
  } else {
    console.error('[bridge] Server error:', err);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down...');
  try { state.bot?.end(); } catch (_) {}
  server.close(() => process.exit(0));
});
