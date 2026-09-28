'use strict';
const { Vec3 } = require('vec3');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补

/**
 * 她的手 —— 用背包里的东西、穿装备、开界面、合成、烧东西。
 *
 * ## 为什么单独一个文件
 *
 * bridge-server.js 原来的"手"只有：走、挖、放方块、打、说话、原版合成。
 * **"使用物品 / 打开界面"这一整类动作从来没有过** —— 于是：
 *   · 吃不了东西（/eat 全靠一个没装的插件，失败 → 反射也跟着失效，她会饿死）
 *   · 穿不了装备（/equip 要调用方自己知道该放哪个槽，模组盔甲/饰品根本不知道）
 *   · 用不了熔炉、厨锅、箱子（没有"打开界面、放进格子、取出来"）
 *   · 合成只认 minecraft-data 的原版配方 —— 被整合包改过的、模组的，一概做不了
 *
 * ## 原则：每个动作都**核对结果**，不信"调用成功"
 *
 * 上一轮的教训：快脑决定了 `eat`，日志里写着"做[pickup,eat]"，
 * 于是所有人（包括我）都以为她吃了 —— 实际饥饿值从 5 掉到 3，鸡肉原封不动。
 * 所以这里每个动作都比对前后的背包 / 装备 / 饥饿值，返回**实际发生了什么**。
 *
 * ## 接口（挂到 bridge 的 handlers 上）
 *
 *   POST /eat        {itemName?}                          吃（不给名字自己挑）
 *   POST /use        {itemName?, target?, x,y,z, entity, hand, holdMs}   右键
 *   POST /wear       {itemName}                           穿戴（盔甲 / 模组装备 / 饰品）
 *   POST /craft2     {itemName, count}                    按**整合包真实配方**合成
 *   POST /smelt      {itemName, count, fuel?}             熔炉 / 烟熏炉 / 高炉
 *   POST /container/open   {x,y,z}                        右键打开任意方块的界面
 *   GET  /container                                       当前界面里有什么
 *   POST /container/put    {slot, itemName, count}        放进某一格
 *   POST /container/take   {slot, count?}                 从某一格拿出来
 *   POST /container/close
 */

// ------------------------------------------------------------------ 汇总（第 3 步重构，2026-09-28）
//
// 这个文件原来是 5598 行的巨石。按领域拆成 util / containers / craft / movement / mining / farming / kit / build，
// 这里只做三件事：
//   1. 把子文件的导出拼回**和拆之前一模一样**的 module.exports（Object.keys 必须一字不差）；
//   2. routes(ctx) 原样保留（路由表仍由它一张表给出，桥那边不用动）；
//   3. --selftest 依次跑各子文件的自测（小节都搬到了各自文件里）。
// 外部模块的 `require('../body/hands')` 不用改；本文件被 src/instinct/instinct.js 的
// 源码形状锁按路径读取，所以 **hands.js 这个名字不能变**（它在磁盘上是指向本文件的符号链接）。

const { ARMOR_SLOTS, FIXED_CH, K, N6, REACH, airish, bareId, blockVisible, botName, canUseFrom, canUseNow, cartKey, commandWords, delta, doorBase, doorKey, doorKind, equipChanges, equipment, eyeDist, findItem, findStorage, foodScore, fullId, hexLong, inHomeArea, invCounts, isDoorLike, isLadder, isLiquid, isOpen, knowledge, knownTierOf, locatePlayerInv, markSeen, mcString, nearestBlock, passable, plainTitle, readNbt, readSophItem, readVarInt, seenKeys, sleep, slotByName, solidUnder, storageKey, summarizeWindow, surveyChar, tierOf, winInvCount } = require('./util');
const { CAT_ORDER, CURIO_FIRST, LOOT_ORDER, anyOf, auditSortedRange, backpackChain, backpackOpen, backpackTidy, categoryOf, checkChests, compareSortedItems, containerOpen, containerPut, containerTake, countInBackpackSeen, curiosEquip, curiosList, curiosOpen, curiosUnequip, decideCarry, deposit, ensureCarried, fetchAnyFromBackpack, fetchFromBackpack, ftbqSend, identityTotals, install: installInner, installModProtocols, lookIntoBackpack, lootCart, lootNearby, matcher, noteBackpack, noteCurios, noteSeen, organizeStorage, packedSlots, placeStructure, resolveCarryId, sameTotals, stableValue, stackIdentity, tally, threatNear, unseenCarts, unseenChests, wearingBackpack, withdraw } = require('./containers');
const { FOOD_RE, NOT_FOOD_RE, applyBoxSnapshot, approach, click, clickIn, cookInPot, craft2, craftByHand, craftByRecipeBook, eat, findAndApproach, fuelValue, give, pickFuel, rankRecipesFor, returnGrid, safeTransfer, settleCursor, shortfallText, smelt, snapshotContainer, sortContainer, sortInventory, sortRange, use, wear, withBackpackLock } = require('./craft');
const { ADMIN_CMDS, FOLLOW_LOST_MS, FOLLOW_TICK_MS, FURNITURE_RE, KEYS, NEVER_CMDS, SELF_TP_RE, abortError, buildGraph, cellChar, climbColumn, climbColumnDown, climbDown, climbUp, describeRoute, doorsNear, followRoute, go, holdControls, installDoorHabit, ladderBottomReachable, ladderColumns, ladderExitTargets, lookAround, motor, nudge, offLadder, pathTo, pathToKeepingFloor, plainTimeout, runCommand, safeToward, selfRescue, setDoor, shortest, sleepInBed, startFollow, stepInto, wiggle } = require('./movement');
const { BRANCH, BUILT_RE, FILLER_RE, LIGHT_RE, ORE_RE, ORE_Y, TORCH_RE, TORCH_SPEC, caveStep, clearCell, delve, digBlock, ensureFiller, fillerItem, inCave, isDark, isFiller, lightAt, lightIdsCache, lightIdsRegistry, lightUp, makeTorches, mines, nearestLight, oreIdsCache, oreIdsRegistry, placeFiller, placeTorchHere, saveMines, sensedOres, stepTo, torchCount, torchItem, tunnelTo, visibleOres } = require('./mining');
const { SEED_OF, collectDrops, cropInfo, farm, seedFor } = require('./farming');
const { NOT_SCAFFOLD_RE, NOT_STORAGE_RE, SCAFFOLD_IDS, SCAFFOLD_TAGS, STORAGE_RE, TIERS, WEAPON_CHECK, defaultLoadout, isLoadoutItem, kitAvailable, kitMatch, kitShortfall, loadoutTargetShortfall, pickLoadout, protectLoadout, scaffoldCache, scaffoldIds } = require('./kit');
const { START_COVER, allSlots, furnish, invCount, layoutSave, layoutStatus, layoutStatusSlots, layouts, placeAt, projectCells, projectDiff, projectSave, projectStatus, projectWork, projects, saveLayouts, saveProjects, slotState, survey, zoneArea, zoneFreeFloor, zoneMark, zonePresent, zoneWants } = require('./build');

// ---- 把 8 个兄弟文件接起来（第 3 步重构）--------------------------------------
// hands.js 原来所有顶层声明都在**一个作用域**里，谁先谁后都无所谓；拆开之后它们互相
// require 成环，模块顶层解构会拿到 undefined。所以：先把 8 个文件都 require 进来，
// 拼成一张总表，再让每个文件 `bind(总表)` 回填自己的跨文件名字 —— 函数体里写的还是
// 原来那些名字，取到的始终是同一份真身。
const __files = { util: require('./util'), containers: require('./containers'), craft: require('./craft'), movement: require('./movement'), mining: require('./mining'), farming: require('./farming'), kit: require('./kit'), build: require('./build') };
const __ns = Object.assign({}, __files.util, __files.containers, __files.craft, __files.movement, __files.mining, __files.farming, __files.kit, __files.build);
__files.util.bind(__ns);
__files.containers.bind(__ns);
__files.craft.bind(__ns);
__files.movement.bind(__ns);
__files.mining.bind(__ns);
__files.farming.bind(__ns);
__files.kit.bind(__ns);
__files.build.bind(__ns);

// ---- 共享的可变状态 ------------------------------------------------------------
// HSTATE 是模块级的**唯一一份**：install(bot, state) 把 bridge 的 state 存进来，
// 给 approach 这类不带 state 的旧函数用（跨楼层要走路线规划）。
// 拆分后它留在汇总 index.js，别的文件经 handsState() 读同一份 —— 不能各存一份副本。
let HSTATE = null;
const handsState = () => HSTATE;

// 装路由 / 模组界面补丁的那段（原 install 的其余部分）在 containers.js；
// 它原来第一行就是写 HSTATE，现在改由汇总先写好再叫它。
const install = (bot, state) => { HSTATE = state; return installInner(bot, state); };

// approach / 模组界面补丁要读 HSTATE，由汇总把同一份递给它们。
__files.containers.setHandsState(handsState);
__files.craft.setHandsState(handsState);

// ------------------------------------------------------------------ 路由

function routes ({ state, withTimeout }) {
  const bot = () => state.bot;
  return {
    'POST /eat': async (b = {}) => eat(bot(), b),
    'POST /use': async (b = {}) => use(bot(), state, b),
    'POST /wear': async (b = {}) => wear(bot(), state, b),
    'POST /craft2': async (b = {}) => craft2(bot(), b, withTimeout),
    'POST /smelt': async (b = {}) => smelt(bot(), b, state),
    'POST /give': async (b = {}) => give(bot(), b),
    'POST /climb_up': async (b = {}) => climbUp(bot(), state, b),
    'POST /climb_down': async (b = {}) => climbDown(bot(), state, b),
    'POST /go': async (b = {}) => go(bot(), state, b),
    'GET /look_around': async (_, q) => lookAround(bot(), { r: q?.r, below: q?.below, above: q?.above }),
    'POST /motor': async (b = {}) => motor(bot(), state, b),
    'POST /nudge': async (b = {}) => nudge(bot(), b),
    'POST /wiggle': async (b = {}) => wiggle(bot(), b),
    'GET /doors': async (_, q) => ({ doors: doorsNear(bot(), Math.min(+(q?.radius || 8), 16)), iOpened: [...(state.doorsIOpened || new Map()).values()].map(d => ({ ...d, pos: doorKey(d.pos) })), leftOpen: (state.doorsLeftOpen || []).slice(-5), lastClosed: state.lastDoorClosed || null, stateSkips: state.doorStateSkips || 0, lastSkipped: state.lastDoorSkipped || null }),
    'POST /door': async (b = {}) => {
      const r = await setDoor(bot(), state, b);
      // keepOpen：她明确要让门一直开着（比如放动物进圈），就不按习惯关
      if (b.open && b.keepOpen) state.doorsIOpened?.delete(`${b.x},${b.y},${b.z}`);
      return r;
    },
    'POST /doors/forget-left-open': async () => { const n = state.doorsLeftOpen.length; state.doorsLeftOpen = []; return { cleared: n }; },
    'POST /container/open': async (b = {}) => containerOpen(bot(), state, b),
    'GET /container': async () => summarizeWindow(bot(), state) || { open: false, lastWindowInfo: state.lastWindowInfo || null },
    'POST /container/put': async (b = {}) => containerPut(bot(), state, b),
    'POST /container/take': async (b = {}) => containerTake(bot(), state, b),
    'POST /container/deposit': async (b = {}) => { const r = await deposit(bot(), state, b); noteBackpack(state, bot().currentWindow); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    'POST /container/withdraw': async (b = {}) => { const r = await withdraw(bot(), state, b); noteBackpack(state, bot().currentWindow); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    'POST /container/sort': async () => { const r = await sortContainer(bot()); noteSeen(bot(), state, bot().currentWindow, state.openContainerPos); return r; },
    // 最近看过的箱子里有什么（since：只要这之后看的）
    'GET /containers/seen': async (_, q) => ({ seen: [...(state.seenContainers || new Map()).values()].filter(c => c.at > (+q?.since || 0)) }),
    'POST /storage/organize': async (b = {}) => organizeStorage(bot(), state, b),
    'POST /backpack/tidy': async (b = {}) => backpackTidy(bot(), state, b),
    'POST /storage/loot': async (b = {}) => lootNearby(bot(), state, b),
    // 2026-09-28 第 8 批 第 5 条：mind 明确下矿之后，本能要知道"刚才在下矿"，
    // 被战斗打断才能在 5 分钟内自己接着挖（判据见 instinct.js 的 noteDelve / pickDelveResume）。
    // 接线只此一处 —— 本能不自己发起下矿，只在这里被喂一条"下过矿"的记录。
    'POST /delve': async (b = {}) => {
      const before = state.delve?.entry || null;
      try {
        const r = await delve(bot(), state, b);
        try { state.instinct?.noteDelve?.(b, r || {}); } catch (_) {}
        return r;
      } catch (e) {
        // 失败也记一笔（比如"没带火把，不下去"）—— 免得下次又当成"从没下过矿"。
        // 记的是"想在哪儿下"，入口位置从 state.delve 里读（delve 走之前会建好）。
        try { state.instinct?.noteDelve?.(b, { reason: e.message, entry: state.delve?.entry || before }); } catch (_) {}
        throw e;
      }
    },
    'GET /debug/craftgrid': async () => ({ serverInv: state.invItems || null, clientSlots: bot().inventory.slots.length, clientFilled: bot().inventory.slots.map((it, i) => it && `${i}:${it.type}x${it.count}`).filter(Boolean), grid: bot().inventory.slots.slice(0, 5).map((it, i) => it ? { slot: i, name: it.name, count: it.count } : null), window: bot().currentWindow?.type || null, stateId: bot().inventory.stateId, slotLog: (state.slotLog || []).slice(-20) }),
    'POST /debug/click': async (b = {}) => { const w = bot().currentWindow || bot().inventory; await bot().clickWindow(+b.slot, +b.button || 0, +b.mode || 0); await sleep(300); return { cursor: w.selectedItem && `${w.selectedItem.name}×${w.selectedItem.count}`, grid: w.slots.slice(0, 5).map(it => it && `${it.name}×${it.count}`), slot: w.slots[+b.slot] && `${w.slots[+b.slot].name}×${w.slots[+b.slot].count}`, log: (state.slotLog || []).slice(-4) }; },
    'POST /debug/seq': async (b = {}) => {
      const out = []; const gap = +b.gap || 450;
      for (const [slot, button, mode] of b.clicks || []) {
        const n0 = (state.slotLog || []).length; const t0 = Date.now();
        let err = null; try { await Promise.race([bot().clickWindow(slot, button, mode), sleep(3000).then(() => { throw new Error('click 3s 没返回'); })]); } catch (e) { err = e.message; }
        const ms = Date.now() - t0; await sleep(gap);
        out.push({ click: [slot, button, mode], ms, err, server: (state.slotLog || []).slice(n0).map(x => `${x.slot}:${x.item === false ? '空' : x.item + 'x' + x.count}`) });
      }
      return { out };
    },
    'POST /debug/returngrid': async () => { await returnGrid(bot()); return { grid: bot().inventory.slots.slice(0, 5).map(it => it && `${it.name}×${it.count}`) }; },
    'GET /commands': async () => {
      const w = commandWords(bot()) || new Set();
      const TP = ['home', 'sethome', 'delhome', 'homes', 'back', 'spawn', 'tpa', 'tpahere', 'tpaccept', 'tpdeny', 'rtp', 'warp', 'warps', 'tpx', 'tp', 'kit', 'near', 'trashcan', 'leaderboard'];
      return { known: !!bot()._client.__cmdRaw, total: w.size, teleport: TP.filter(x => w.has(x)), all: [...w].sort() };
    },
    'POST /cmd': async (b = {}) => runCommand(bot(), state, b),
    'GET /survey': async (b = {}) => survey(bot(), b),
    // 看得见的地标：传送石碑、村庄（钟或村民）—— mind 记进"记得的地方"
    'GET /landmarks': async () => {
      const b = bot(); const out = [];
      const ids = (re) => Object.values(b.registry.blocksByName).filter(x => re.test(x.name)).map(x => x.id);
      for (const [kind, re] of [['waystone', /waystone/], ['village', /(^|:)bell$/]]) {
        for (const p of b.findBlocks({ matching: ids(re), maxDistance: 32, count: 8 })) {
          const blk = b.blockAt(p); if (blk && b.canSeeBlock(blk)) out.push({ kind, name: blk.name, x: p.x, y: p.y, z: p.z });
        }
      }
      const vill = Object.values(b.entities).find(e => /villager/.test(e.name || '') && e.position.distanceTo(b.entity.position) < 32);
      if (vill && !out.some(o => o.kind === 'village')) out.push({ kind: 'village', name: 'villager', x: Math.floor(vill.position.x), y: Math.floor(vill.position.y), z: Math.floor(vill.position.z) });
      return { landmarks: out };
    },
    'POST /layout/save': async (b = {}) => layoutSave(bot(), state, b),
    'GET /layout/status': async (b = {}) => layoutStatus(bot(), state, b),
    'POST /layout/furnish': async (b = {}) => furnish(bot(), state, b),
    'POST /layout/zone': async (b = {}) => zoneMark(state, b),   // 标一个区"要重新想"（place_nicely 放不下时）/ 取消
    'POST /layout/cancel': async (b = {}) => { const LS = layouts(state); if (!LS[b.id]) throw new Error(`没有规划 ${b.id}`); delete LS[b.id]; saveLayouts(state); return { removed: b.id }; },
    'POST /project/save': async (b = {}) => projectSave(bot(), state, b),
    'GET /project/status': async (b = {}) => projectStatus(bot(), state, b),
    'POST /project/work': async (b = {}) => projectWork(bot(), state, b),
    'POST /project/cancel': async (b = {}) => { const P = projects(state); if (!P[b.id]) throw new Error(`没有工程 ${b.id}`); P[b.id].status = 'cancelled'; saveProjects(state); return { cancelled: b.id }; },
    'GET /light': async () => ({ light: lightAt(bot()), dark: isDark(lightAt(bot())) && !nearestLight(bot(), 7), nearestLight: nearestLight(bot(), 7), torches: torchCount(bot()), lastBright: state.lastBright ? { x: state.lastBright.x, y: state.lastBright.y, z: state.lastBright.z } : null }),
    // 手上有火把就直接插；真的用完时一次补够 16 根，避免每隔一根就重新打开合成流程。
    'POST /light_up': async (b = {}) => { const have = torchCount(bot()); const m = have > 0 ? { torches: have } : await makeTorches(bot(), 16, state); const r = await lightUp(bot(), { max: Math.min(+b.max || 3, 8), force: !!b.force, state }); return { ...r, made: m.made || 0, ...(m.note ? { makeNote: m.note } : {}) }; },
    'POST /make_torches': async (b = {}) => makeTorches(bot(), Math.min(+b.count || 16, 64), state),
    'POST /self_rescue': async (b = {}) => selfRescue(bot(), state, b),
    'GET /chests/unseen': async (_, q) => ({ chests: unseenChests(bot(), state, +q?.radius || 24).slice(0, 6).map(b => ({ at: storageKey(bot(), b), name: b.name, x: b.position.x, y: b.position.y, z: b.position.z, distance: +bot().entity.position.distanceTo(b.position).toFixed(1) })) }),
    'POST /chests/check': async (b = {}) => ({ checked: await checkChests(bot(), state, b) }),
    'POST /sleep': async (b = {}) => sleepInBed(bot(), state, b),
    'POST /farm': async (b = {}) => farm(bot(), state, b),
    'POST /cook_pot': async (b = {}) => cookInPot(bot(), state, b),
    'POST /wake': async () => { if (bot().isSleeping) await bot().wake(); return { awake: true }; },
    'POST /inventory/sort': async () => sortInventory(bot()),
    'POST /container/close': async () => {
      const w = bot().currentWindow;
      if (w && state.openContainerPos) noteSeen(bot(), state, w, state.openContainerPos);
      noteBackpack(state, w);
      if (w) bot().closeWindow(w);
      return { closed: !!w };
    },
    'GET /debug/payloads': async () => ({ recent: state.recentPayloads || [], lastForgeOpen: state.lastForgeOpen || null, lastWindowInfo: state.lastWindowInfo || null }),
    'POST /unequip': async ({ slot, itemName } = {}) => {
      const b = bot();
      const eq0 = equipment(b);
      let dest = slot;
      if (!dest && itemName) dest = Object.keys(eq0).find(k => eq0[k] && (eq0[k] === fullId(itemName) || eq0[k].endsWith(`:${itemName}`)));
      if (!dest || !(dest in eq0)) throw new Error(`要给 slot（head/torso/legs/feet/off-hand/hand）或穿着的 itemName；现在穿着：${JSON.stringify(eq0)}`);
      if (!eq0[dest]) return { already: true, slot: dest };
      if (b.inventory.emptySlotCount() === 0) throw new Error('背包满了，脱不下来');
      await b.unequip(dest);
      await sleep(400);
      const eq1 = equipment(b);
      if (eq1[dest]) throw new Error(`没脱下来（${dest} 还是 ${eq1[dest]}）`);
      return { took_off: eq0[dest], slot: dest, nowInInventory: true };
    },
    'GET /debug/shape-fixes': async () => ({ fixes: state.shapeFixes || 0, blocks: [...(state.shapeFixNames || [])] }),
    'GET /curios': async () => curiosList(bot(), state),
    'POST /curios/equip': async (b = {}) => curiosEquip(bot(), state, b),
    'POST /curios/unequip': async (b = {}) => curiosUnequip(bot(), state, b),
    'POST /backpack/open': async () => backpackOpen(bot(), state),
    // FTB 任务书：交任务（点对号 / 交物品）、领奖励、一键全领
    'POST /ftbq/submit': async (b = {}) => { if (!b.taskId) throw new Error('要给 taskId（任务书里的 16 位十六进制）'); return ftbqSend(bot(), state, 'submit_task', hexLong(b.taskId)); },
    'POST /ftbq/claim': async (b = {}) => { if (!b.rewardId) throw new Error('要给 rewardId'); return ftbqSend(bot(), state, 'claim_reward', Buffer.concat([hexLong(b.rewardId), Buffer.from([b.notify === false ? 0 : 1])])); },
    'POST /ftbq/claim_all': async () => ftbqSend(bot(), state, 'claim_all_rewards'),
    'POST /ftbq/claim_choice': async (b = {}) => {   // 多选一奖励（新手小屋 14 选 1）：long rewardId + varint 选第几个
      if (!b.rewardId) throw new Error('要给 rewardId');
      const i = Math.max(0, +b.index || 0); const v = []; let n = i; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; v.push(x); } while (n);
      return ftbqSend(bot(), state, 'claim_choice_reward', Buffer.concat([hexLong(b.rewardId), Buffer.from(v)]));
    },
    'POST /place_structure': async (b = {}) => placeStructure(bot(), state, b),
    'GET /ftbq/recent': async () => ({ recent: (state.ftbqRecent || []).slice(-20) }),
    // 调试：原样发一个模组消息（逆向模组协议时用）{ channel, hex }
    'POST /debug/payload': async (b = {}) => { bot()._client.write('custom_payload', { channel: b.channel, data: Buffer.from(b.hex || '', 'hex') }); await sleep(b.waitMs || 1500); return { sent: b, window: summarizeWindow(bot(), state) }; },
    // 调试：寻路器眼里这一格是什么（safe=能站进去、physical=实心）
    'GET /debug/mvblock': async (_, q = {}) => {
      const mv = bot().pathfinder.movements;
      const out = [];
      for (const dy of [-1, 0, 1]) {
        const b = mv.getBlock(new Vec3(+q.x, +q.y, +q.z), 0, dy, 0);
        let props = null; try { props = b?.getProperties?.(); } catch (e) { props = 'ERR ' + e.message; }
        out.push({ y: +q.y + dy, name: b?.name, props, hasGP: typeof b?.getProperties, stateId: b?.stateId, safe: b?.safe, physical: b?.physical, height: b?.height, bbox: b?.boundingBox, shapes: b?.shapes?.length,
          doorShapes: /(^|_)(trap)?door$/.test(b?.name || '') ? b?.shapes : undefined });
      }
      return { patched: !!mv.__openDoorsPatched, blocks: out };
    },
    'GET /debug/follow': async () => ({
      currentAction: state.currentAction,
      followSeq: state.followSeq || 0,
      lastFollowRoute: state.lastFollowRoute || null,
      // 跟随循环退出的原因（看不见人 / 循环体抛错）—— 不记下来就只能看到"她不动了"
      lastFollowStop: state.lastFollowStop || null,
    }),
    'GET /debug/soph': async () => ({ lastSync: state.lastSophSync || null, error: state.lastSophError || null }),
    'GET /equipment': async () => ({ equipment: equipment(bot()), food: bot().food, health: bot().health, curios: state.curiosWorn || null, backpack: state.backpackSeen || null }),
  };
}

// ------------------------------------------------------------------ 导出（顺序 = 拆之前那 47 个，一字不差）

module.exports = { rankRecipesFor, shortfallText, zoneArea, zoneWants, install, installDoorHabit, routes, slotByName, foodScore, fullId, botName, startFollow, farm, kitShortfall, kitAvailable, defaultLoadout, isLoadoutItem, protectLoadout, wearingBackpack, backpackTidy, fetchFromBackpack, ensureCarried, decideCarry, countInBackpackSeen, resolveCarryId, winInvCount, lookIntoBackpack, fuelValue, smelt, unseenChests, unseenCarts, inHomeArea, inCave, SCAFFOLD_IDS, scaffoldIds, isFiller, canUseFrom, canUseNow, approach, blockVisible, eyeDist, lightAt, nearestLight, torchCount, torchItem, lightUp, delve };

// 自测用：8 个文件的**全部**名字（原来自测段和所有函数同处一个作用域，随手就能取）。
// 不可枚举 —— Object.keys(module.exports) 必须还是那 47 个，一字不差。
Object.defineProperty(module.exports, '__ns', { value: __ns, enumerable: false });

// ------------------------------------------------------------------ 自测
// 第 3 步重构：小节都搬到了各自子文件里（函数体一字未改）；这里依次跑**全部**，
// 顺序与拆分前一致，断言总数一分不少。
// 各子文件也能单独 `node src/body/<file>.js --selftest`。

if (require.main === module && process.argv.includes('--selftest')) {
  // require 各子文件 = 把它们的小节 register 进 testkit（module 顶层就登记，不跑）
  require('./containers'); require('./craft'); require('./movement'); require('./kit'); require('./build');
  require('./testkit').bindHands(__ns);   // 总表 = 8 个文件的全部导出（小节原来就在同一作用域）
  require('./testkit').runSuite('hands');
}
