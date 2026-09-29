/**
 * routes/inspect.js —— 从 server.js 的 handlers 表拆出的 21 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const blockPalette = require('../../world/block-palette.js');
const entityRegistry = require('../../world/entity-registry.js');
const fs = require('fs');
const hands = require('../../body/hands.js');
const instinct = require('../../instinct/instinct.js');
const itemRegistry = require('../../world/item-registry.js');
const night = require('../../mind/night.js');
const path = require('path');
const pathing = require('../../world/pathing');
const paths = require('../../paths');
const { countById } = require('../../util/inventory');   // 第 4 步去重：原为本文件里的 countOf 闭包

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let BOT_IDENTITY;
let BRIDGE_VERSION;
let CFG;
let CHATLOG_MAX;
let JOURNAL_FILE;
let KB_DIR;
let MAX_SCAN_BLOCK_POSITIONS;
let STATE_FILE;
let chatlog;
let handlers;
let state;
let BLOCK_NAME_TO_ID;
let Vec3;
let goals;

function aggroOf (...a) { return __ns.aggroOf.apply(null, a); }
function botPos (...a) { return __ns.botPos.apply(null, a); }
function botPosExact (...a) { return __ns.botPosExact.apply(null, a); }
function cfg (...a) { return __ns.cfg.apply(null, a); }
function createBot (...a) { return __ns.createBot.apply(null, a); }
function droppedItemOf (...a) { return __ns.droppedItemOf.apply(null, a); }
function exposureOf (...a) { return __ns.exposureOf.apply(null, a); }
function inventoryCount (...a) { return __ns.inventoryCount.apply(null, a); }
function isDropEntity (...a) { return __ns.isDropEntity.apply(null, a); }
function journal (...a) { return __ns.journal.apply(null, a); }
function paletteCandidates (...a) { return __ns.paletteCandidates.apply(null, a); }
function readJournal (...a) { return __ns.readJournal.apply(null, a); }
function runLookup (...a) { return __ns.runLookup.apply(null, a); }
function saveState (...a) { return __ns.saveState.apply(null, a); }
function shapeStatsOf (...a) { return __ns.shapeStatsOf.apply(null, a); }

/**
 * 本文件负责的路由（21 条）：
 *   GET /config                    —— 生效的配置（不含密钥），离线也可读
 *   GET /debug/shelter-probe       —— 避难所探测的中间数组
 *   GET /debug/pathfinder          —— 寻路器当前的 goal / movements / 状态
 *   GET /debug/route               —— 上一次寻路算出来的路线
 *   GET /status                    —— 连接状态 + 天色 / 遮挡
 *   POST /reconnect                —— 手动重连（自动重试放弃后用）
 *   GET /inventory                 —— 背包里有什么
 *   GET /recipes                   —— 查一条配方在整合包里怎么做
 *   GET /item                      —— 物品注册表注入报告 / 查询
 *   GET /position                  —— 她的坐标与朝向
 *   GET /health                    —— 血量 / 饥饿 / 氧气
 *   GET /nearby                    —— 附近实体与掉落物（按敌对分类）
 *   GET /players                   —— 在线玩家与距离
 *   GET /block                     —— 读一个方块（单格或整列）
 *   GET /chatlog                   —— 最近收到的聊天 / 系统消息
 *   GET /memory                    —— 读她的记忆（journal + 状态快照）
 *   GET /state                     —— 上一次缓存的状态快照
 *   POST /memory                   —— 往记忆里写一条（note / chat / plan…）
 *   GET /knowledge                 —— 整合包知识库概览
 *   GET /knowledge/search          —— 查知识库（关键词）
 *   POST /knowledge/search         —— 查知识库（POST 形式，关键词可含非 ASCII）
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
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
                shapes: shapeStatsOf(state.paletteInject),
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
                  shapes: shapeStatsOf(state.paletteMeta.inject),
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
    skillDir: paths.ROOT,
    configFile: fs.existsSync(paths.CONFIG)
      ? paths.CONFIG
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
          //   stats.thinExempt  按名字豁免成可穿过的次数
          //   stats.whitelisted 白名单**盖过**已知形状的次数（调色板导了真实碰撞箱之后，
          //                     她自己打开的那扇门仍然要能穿过 —— 这条以前会失效）
          //   ⚠️ 形状已知的方块**不进**这个补丁的改形状分支：dump 里的真实碰撞箱
          //      就是权威，一个字都不改。只有 needsShapeFallback 命中才按名字猜。
          unknownBlockPolicy: state.pfUnknown ?? null,
          // 开着的门：installed=true 表示补丁装上了。stats 是**活计数**（寻路器每问一次记一笔）：
          //   passed   放行了多少格（开着的门被当成能走）
          //   refused  "门板两侧都是通路"→ 保守当墙、她会绕（说明这种独立门不少）
          //   noFacing 读不到 facing（模组门属性名不同）→ 保持放行，但记一笔
          openDoors: state.pfOpenDoors ? { ...state.pfOpenDoors, stats: { ...(state.pfOpenDoors.stats || {}) } } : null,
          // 运行时"可穿过"白名单：她自己打开、并且**实测穿得过去**的 state。
          // 只有验证通过的才会留在这里 —— 猜错的会被 /climb 撤回。
          passableStateIdsRuntime: [...state.passableStateIdsRuntime],
          // physicsTick 崩溃兜底：`installed=true` 表示已经包住 pathfinder 那条监听。
          // `crashes` 是**活计数** —— 大于 0 说明库确实崩过、但被兜住了（进程没死）。
          // 见 `guardPathfinderCrash`。
          crashGuard: state.pfCrashGuard
            ? { ...state.pfCrashGuard, crashes: state.pfCrashCount || 0, last: state.lastPfCrash || null }
            : null,
          // 目标所有权登记簿的活计数（N-1）：selfChanges 是我们自己收手，
          // externalChanges 是别人抢目标。见 `pathing.createGoalOwner`。
          goalOwner: state.__goalOwner ? state.__goalOwner.stats() : null,
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
  'GET /debug/route': async (_, q = {}) => {
    if (![q.x, q.y, q.z].every(v => v !== undefined && Number.isFinite(+v))) throw new Error('x y z required');
    const goal = new goals.GoalBlock(+q.x, +q.y, +q.z);
    const generator = state.bot.pathfinder.getPathFromTo(
      state.bot.pathfinder.movements, state.bot.entity.position, goal,
      { timeout: 1500, optimizePath: false },
    );
    const result = generator.next().value?.result;
    return {
      status: result?.status || 'unavailable',
      visitedNodes: result?.visitedNodes ?? null,
      path: (result?.path || []).slice(0, 80).map(p => ({
        x: p.x, y: p.y, z: p.z,
        open: p.toPlace?.some(v => v.useOne) || false,
        dig: p.toBreak?.length || 0,
      })),
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
    // 身上的效果（中毒/凋零等；null = 读不到，不是"没有"）与天气 —— 本能层 instinct.js 在用，这里给 mind 和实机核对
    effects: state.instinct?.effectNames?.() ?? null,
    weather: state.bot ? { rain: !!state.bot.isRaining, thunder: !!state.bot.isRaining && (state.bot.thunderState ?? 0) > 0 } : null,
    gameTime: state.bot?.time?.timeOfDay ?? null,
    isDay: (state.bot?.time?.timeOfDay ?? 0) < 13000,
    // 天色（day / dusk 12000 / night 13000 / dawn 23000）与头顶遮挡 —— 夜里在野外、在屋里、在矿洞是三回事（见 night.js）
    phase: night.phaseOf(state.bot?.time?.timeOfDay),
    exposure: (() => { try { return exposureOf(state.bot); } catch (_) { return null; } })(),
    isSleeping: !!state.bot?.isSleeping,
    // 背包**占用格数**（不是件数）。第 5 步修 bug（2026-09-29）：`?? 0` 会把"读不到"报成 0
    // （AGENTS §5-1）—— 改用 `inventoryCount` 的读数判可读：它返回 null 就是读不到，字段也报 null。
    inventoryCount: (() => {
      const n = inventoryCount(state.bot);
      if (n === null) return null;
      try { return state.bot.inventory.items().length; } catch (_) { return null; }
    })(),
    currentAction: state.currentAction,
    // 载具 / 是否开着界面：mind 的"场景自动激活"（groupsFromBody）要能看见这两个身体状态，
    // 否则"骑着船"和"开着箱子"她认不出来（codex R-fix4-6）。
    vehicle: state.bot?.vehicle ? (state.bot.vehicle.name || state.bot.vehicle.displayName || 'vehicle') : null,
    windowOpen: !!state.bot?.currentWindow,
    containerOpen: !!(state.bot?.currentWindow && state.bot.currentWindow.type !== 'minecraft:inventory'),
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
    // 第 4 步去重：原为本文件内的闭包，与 gather.js:103 一字不差 —— 唯一一份在 src/util/inventory.js
    const countOf = (id) => countById(inv, id);
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
      // ⚠️ 先按距离排再截 20 个：原来是先截后排 —— 挖完矿身边十几件掉落物时，
      //    贴脸的僵尸可能根本进不了这 20 个（实体表的遍历顺序与距离无关）。
      .sort((a, b) => a.position.distanceTo(self.position) - b.position.distanceTo(self.position))
      .slice(0, 20)
      .map(e => {
        const drop = isDropEntity(e);
        // 仇恨：它打过她/玩家，或者正举着手盯着她/玩家（见 entity-registry.js ②）。
        const aggro = drop ? null : aggroOf(e);
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
          // 掉的是什么：她得知道地上躺着的是橡木原木还是圆石，才会有意识地去捡（主人 2026-09-26）
          item: drop ? droppedItemOf(e) : undefined,
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
          //
          //   2026-09-27：**有仇恨证据的也算 hostile**。模组怪补上名字后 type 仍是 'other'
          //   （快照不带类别），不这样的话一只模组怪追着她打，上层照样数出 0 个威胁。
          //   `aggro` 字段单独透出证据：kind 说"是不是威胁"，aggro 说"凭什么、冲谁来的"。
          //
          //   2026-09-28：判据收到 entity-registry.isHostileEntity 一处（AGENTS.md §5）——
          //   以前这里的 `e.type === 'hostile' || aggro` 与 instinct / hands 各写各的、
          //   名单还不一致（模组怪漏一半）。现在三处同一份实现。
          // ⚠️ 2026-09-28 审计（codex fix1 #2）：**复用已经算好的 `aggro`**。
          //    原来这里传 `aggroOf` **函数**进去，`isHostileEntity` 内部又调一次 ——
          //    同一实体每轮 `aggroOf()` 跑两遍：白算一次仇恨（读 metadata），
          //    而且两次之间实体状态可能变（读到不同瞬间 → `aggro` 字段与 `kind`
          //    之间自相矛盾）。现在把上面那次的**结果**用闭包传进去。
          kind: drop
            ? 'drop'
            : (e.type === 'player'
              ? 'player'
              : (entityRegistry.isHostileEntity(e, () => aggro)
                ? 'hostile'
                : (e.type === 'mob' || e.type === 'animal' || e.type === 'water_creature'
                  ? 'mob'
                  : 'other'))),
          // `type` **原样透出** —— 让消费者能自己判（而不是只能依赖我们分的 kind），
          // 也方便下次再遇到"分类漏了哪一类"时一眼看出来。
          entityType: e.type ?? null,
          // { on: 'me' | 玩家名, evidence: 'hurt' | 'aggressive' } 或 null（没有证据 ≠ 友好，只是没看到它找麻烦）
          aggro,
          // 名字是不是我们按服务端实体表补的（模组生物）
          named: e.angelNamed || undefined,
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
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.BOT_IDENTITY !== undefined) BOT_IDENTITY = ns.BOT_IDENTITY;
  if (ns.BRIDGE_VERSION !== undefined) BRIDGE_VERSION = ns.BRIDGE_VERSION;
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.CHATLOG_MAX !== undefined) CHATLOG_MAX = ns.CHATLOG_MAX;
  if (ns.JOURNAL_FILE !== undefined) JOURNAL_FILE = ns.JOURNAL_FILE;
  if (ns.KB_DIR !== undefined) KB_DIR = ns.KB_DIR;
  if (ns.MAX_SCAN_BLOCK_POSITIONS !== undefined) MAX_SCAN_BLOCK_POSITIONS = ns.MAX_SCAN_BLOCK_POSITIONS;
  if (ns.STATE_FILE !== undefined) STATE_FILE = ns.STATE_FILE;
  if (ns.aggroOf !== undefined) aggroOf = ns.aggroOf;
  if (ns.botPos !== undefined) botPos = ns.botPos;
  if (ns.botPosExact !== undefined) botPosExact = ns.botPosExact;
  if (ns.cfg !== undefined) cfg = ns.cfg;
  if (ns.chatlog !== undefined) chatlog = ns.chatlog;
  if (ns.createBot !== undefined) createBot = ns.createBot;
  if (ns.droppedItemOf !== undefined) droppedItemOf = ns.droppedItemOf;
  if (ns.exposureOf !== undefined) exposureOf = ns.exposureOf;
  if (ns.handlers !== undefined) handlers = ns.handlers;
  if (ns.inventoryCount !== undefined) inventoryCount = ns.inventoryCount;
  if (ns.isDropEntity !== undefined) isDropEntity = ns.isDropEntity;
  if (ns.journal !== undefined) journal = ns.journal;
  if (ns.paletteCandidates !== undefined) paletteCandidates = ns.paletteCandidates;
  if (ns.readJournal !== undefined) readJournal = ns.readJournal;
  if (ns.runLookup !== undefined) runLookup = ns.runLookup;
  if (ns.saveState !== undefined) saveState = ns.saveState;
  if (ns.shapeStatsOf !== undefined) shapeStatsOf = ns.shapeStatsOf;
  if (ns.state !== undefined) state = ns.state;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  BLOCK_NAME_TO_ID = ns.BLOCK_NAME_TO_ID;
  Vec3 = ns.Vec3;
  goals = ns.goals;
}

module.exports = {
  routes,
  keys: ["GET /config","GET /debug/shelter-probe","GET /debug/pathfinder","GET /debug/route","GET /status","POST /reconnect","GET /inventory","GET /recipes","GET /item","GET /position","GET /health","GET /nearby","GET /players","GET /block","GET /chatlog","GET /memory","GET /state","POST /memory","GET /knowledge","GET /knowledge/search","POST /knowledge/search"],
  bind,
  rebind,
 };
