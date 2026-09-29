/**
 * connect.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const blockPalette = require('../world/block-palette.js');
const bodyCommandLock = require('./body-command-lock.js');
const entityRegistry = require('../world/entity-registry.js');
const fs = require('fs');
const ftbqSync = require('../body/ftbq-sync.js');
const hands = require('../body/hands.js');
const http = require('http');
const instinct = require('../instinct/instinct.js');
const inventoryLedger = require('../body/inventory-ledger.js');
const itemRegistry = require('../world/item-registry.js');
const night = require('../mind/night.js');
const paletteRegistry = require('../world/palette-registry.js');
const path = require('path');
const pathing = require('../world/pathing');
const paths = require('../paths');
const placeLogic = require('../world/place');
const { pickAutoEquip } = require('../body/equip-policy.js');   // 拆分时漏搬（原 server.js:48），2026-09-29 补
const storagePolicy = require('../body/storage-policy.js');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
// 第 4 步去重：原为转发壳（转发到兄弟文件的 sleep/sleepMs），现直接引用唯一一份
const { sleepMs } = require('../util/time');
const __ns = {};
function botPos (...a) { return __ns.botPos.apply(null, a); }   // 拆分时漏了转发壳，2026-09-29 补

let CFG;
let REGISTRY_DIR;
let handlers;
let state;

function cfg (...a) { return __ns.cfg.apply(null, a); }
function droppedItemOf (...a) { return __ns.droppedItemOf.apply(null, a); }
function guardPathfinderCrash (...a) { return __ns.guardPathfinderCrash.apply(null, a); }
function isDropEntity (...a) { return __ns.isDropEntity.apply(null, a); }
function isPlayerBuilt (...a) { return __ns.isPlayerBuilt.apply(null, a); }
function journal (...a) { return __ns.journal.apply(null, a); }
function pushChat (...a) { return __ns.pushChat.apply(null, a); }
function saveState (...a) { return __ns.saveState.apply(null, a); }

function installReplaceable () {
  try {
    const n = placeLogic.setReplaceable(require('../knowledge/knowledge').load().tags.get('block:minecraft:replaceable'));
    console.log(`[place] 可替换方块：从整合包标签补了 ${n} 个模组的`);
  } catch (e) { console.log(`[place] 读不到整合包标签，可替换方块只认原版的（${e.message}）`); }
}

function loadDependencies () {
  try {
    mineflayer = require('mineflayer');
    const doorPatch = require('../../scripts/patch-pathfinder-door').ensure();
    if (doorPatch.changed) console.log('[pathing] 已修复寻路库开门后空队列导致的崩溃');
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
}

function installForgeHandshake () {
if (cfg('MC_FORGE', '0') === '1') {
  const nmp = require('minecraft-protocol');
  const fml = require('../world/fml-handshake.js');
  // 诊断：确认服务端到底发不发「方块注册表」。默认关，设 MC_PROBE_PACKETS=1 打开。
  // 必须在 createClient **之前** patch 协议（protocol 在建客户端时就编成 serializer 了）。
  const probe = require('../world/registry-probe.js');
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
    // 命令树原始字节留一份：hands.js 从里面读她能用哪些命令（GET /commands）。它登录就到，身体层那时还没挂上
    client.on('declare_commands', (p) => { client.__cmdRaw = p.raw; });
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
          // 实体类型表：模组生物的名字全靠它（mineflayer 自己只认 124 个原版）。
          // 以前这份被丢掉了 —— 于是模组怪一律 name='unknown'、type='other'。
          if (name === 'minecraft:entity_type') {
            const snap = { capturedAt: new Date().toISOString(), registry: name, entryCount: entries.length, entries };
            state.entitySnapshot = snap;   // 就地换掉：下一只刷出来的怪就用新表（索引按快照对象懒重建）
            try {
              fs.mkdirSync(REGISTRY_DIR, { recursive: true });
              fs.writeFileSync(entityRegistry.DEFAULT_SNAPSHOT, JSON.stringify(snap, null, 1));
              console.log(`[registry] ${name}：${entries.length} 条 → ${entityRegistry.DEFAULT_SNAPSHOT}`);
            } catch (e) { console.warn(`[registry] ${name} 落盘失败：${e.message}`); }
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
}

function paletteCandidates () {
  const out = [];
  const names = ['angel_block_palette.json', 'angel_block_palette.txt'];
  if (CFG.packDir) for (const n of names) out.push(path.join(CFG.packDir, n));
  for (const n of names) out.push(path.join(REGISTRY_DIR, n));
  for (const n of names) out.push(path.join(paths.ROOT, n));
  return out;
}

function sharedRegistry () {
  try {
    return require('prismarine-registry')(CFG.mc.version);
  } catch (_) {
    return null;
  }
}

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
    shapeStats: shapeStatsOf(inject),
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

function shapeStatsOf (rep) {
  if (!rep) return null;
  return {
    blocks: rep.shapeBlocks ?? 0,          // 填上了真实形状的方块数
    states: rep.shapeStates ?? 0,          // 覆盖的 state 数
    absent: rep.shapeAbsent ?? 0,          // 旧 dump：没导这一列
    unusable: rep.shapeUnusable ?? 0,      // 导了但不可用（条数对不上 / 有 state 读不到）
    dynamic: rep.shapeDynamic ?? 0,        // 形状静态决定不了：原版、有权威依据
    dynamicGuessed: rep.shapeDynamicGuessed ?? 0,  // 模组名字撞上的，按名字猜
  };
}

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
      if (inj.shapeBlocks || inj.shapeAbsent || inj.shapeUnusable) {
        const s = shapeStatsOf(inj);
        console.log(`[palette]   碰撞形状：${s.blocks} 个方块带真实形状（${s.states} 个 state）`
          + `；没导这一列 ${s.absent} 个，导了但不可用 ${s.unusable} 个`
          + `；形状静态决定不了的：原版 ${s.dynamic} 个（有依据）、模组按名字撞上 ${s.dynamicGuessed} 个（只是猜的）`);
        if (!s.blocks) {
          console.log('[palette]   ⚠ 一个形状都没填上 —— 模组方块会继续按名字猜碰撞箱'
            + '（薄方块白名单 / `_bed` 9/16 / 其余整块实心）。用 registry/README 里的 v4 脚本重导一次。');
        }
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

function resolveBlockName (stateId) {
  if (!state.palette) return null;
  const hit = blockPalette.lookupState(state.palette, stateId);
  return hit ? hit.name : null;
}

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

let BLOCK_NAME_TO_ID = null;

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
  let beforeProps = null;
  try { beforeProps = block.getProperties?.() || null; } catch (_) {}
  const before = { stateId: block.stateId, name: block.name,
    open: beforeProps && 'open' in beforeProps ? String(beforeProps.open).toLowerCase() === 'true' : undefined };
  let activationResult = null;

  state.currentAction = `activate ${before.name || 'stateId ' + before.stateId} @ ${pos.x},${pos.y},${pos.z}`;
  try {
    activationResult = await state.bot.activateBlock(block, new Vec3(normal[0], normal[1], normal[2]), new Vec3(0.5, 0.5, 0.5));
    // 等服务端把新的 blockUpdate 推回来 —— 立刻读会读到旧状态，
    // 那样 stateChanged 恒为 false，调用方会以为"没生效"。
    await sleepMs(300);
  } finally {
    state.currentAction = null;
  }

  const after = state.bot.blockAt(pos);
  let afterProps = null;
  try { afterProps = after?.getProperties?.() || null; } catch (_) {}
  const afterInfo = after ? { stateId: after.stateId, name: after.name,
    open: afterProps && 'open' in afterProps ? String(afterProps.open).toLowerCase() === 'true' : undefined } : null;
  return {
    activated: { x: pos.x, y: pos.y, z: pos.z },
    face: face || `auto(${normal.join(',')})`,
    distance: +dist.toFixed(2),
    before,
    after: afterInfo,
    skipped: activationResult?.skipped === true,
    skipReason: activationResult?.reason,
    // 这是"到底开没开"的判据：stateId 变了 = 服务端真的改了方块状态。
    // 没变不一定失败（有些方块右键不改变 state），但变了就一定成功。
    stateChanged: !!afterInfo && afterInfo.stateId !== before.stateId,
  };
}

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

function entityIndex (bot) {
  const snap = state.entitySnapshot;
  if (!snap || !bot.registry) return null;
  if (state.entityIndex?.snap !== snap) {
    const idx = entityRegistry.buildIndex(snap, bot.registry);
    state.entityIndex = { snap, idx, named: 0 };
    if (idx.ok) console.log(`[entities] 实体表就绪：${idx.modded} 个模组实体（原版核对 ${idx.vanillaChecked}/${idx.vanillaCount}）`);
    else console.error(`[entities] 实体表不可用：${idx.reason}`);
  }
  return state.entityIndex.idx;
}

function installEntitySense (bot) {
  state.aggro = entityRegistry.createAggroTracker();
  state.aggroOf = aggroOf;   // hands.js 下矿、施工时认威胁用（同一判据）
  bot.on('entitySpawn', (e) => {
    try {
      if (e?.name !== 'unknown') return;
      if (entityRegistry.patchEntity(e, entityIndex(bot))) state.entityIndex.named++;
    } catch (_) {}
  });
  bot.on('entityHurt', (victim, source) => {
    try {
      const on = state.aggro.noteHurt(victim, source, bot.entity?.id);
      if (on) state.lastAggro = { t: Date.now(), on, by: source.name || 'unknown', id: source.id };
    } catch (_) {}
  });
  bot.on('entityGone', (e) => { try { state.aggro.forget(e); } catch (_) {} });
}

function installLedger (bot) {
  const L = state.ledger = state.ledger || inventoryLedger.createLedger();
  L.rebase();
  let timer = null;
  const flush = () => {
    timer = null;
    if (!bot.inventory || bot.currentWindow) return;   // 开着界面：等关窗那次再结
    try {
      // 跟着人走是长状态（没有命令在跑）：这期间搭路垫掉的方块算"跟随"的
      if (/^following /.test(state.currentAction || '')) L.note({ route: 'POST /follow' });
      L.commit(bot.inventory.items().map(i => ({ name: i.name, count: i.count })), { food: bot.food });
    } catch (_) {}
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 400); };
  state.ledgerKick = schedule;

  const describeWindow = (w) => {
    if (!w) return null;
    // windowId 会被服务端循环复用。只凭“和上次背包同号”会把后来打开的普通箱子
    // 当成精妙背包，甚至用箱子的占位格子把背包快照覆写成“空的 0/0 格”。
    // __sophisticated 只在收到精妙核心自己的格子同步后才会标上，才是真凭据。
    if (w.__sophisticated) return { kind: 'backpack', where: '精妙背包' };
    const menu = String(w.__menu || state.lastWindowInfo?.menu || w.type || '');
    if (/crafting/.test(menu)) return { kind: 'crafting' };
    if (/furnace|smoker|blast/.test(menu)) return { kind: 'furnace' };
    const p = state.openContainerPos;
    const b = p ? bot.blockAt(p) : null;
    return { kind: 'container', where: p ? `${b?.name || menu || '箱子'}@${p.x},${p.y},${p.z}` : (menu || '某个界面') };
  };

  // bot.inventory 是 inventory 插件在 inject_allowed 时才建的 —— 建 bot 时还没有
  bot.once('spawn', () => {
    bot.inventory.on('updateSlot', schedule);
    schedule();   // 定起点
  });
  bot.on('windowClose', (w) => { try { L.note({ window: describeWindow(w) }); } catch (_) {} schedule(); });
  bot.on('death', () => L.note({ route: 'death' }));
  bot._client.on('entity_status', (p) => {
    try {
      if (p.entityId !== bot.entity?.id || p.entityStatus < 47 || p.entityStatus > 52) return;
      // 包到的时候格子里还是那件（服务端先广播碎裂、tick 末尾才同步格子）
      const slot = { 47: bot.inventory.hotbarStart + bot.quickBarSlot, 48: 45, 49: 5, 50: 6, 51: 7, 52: 8 }[p.entityStatus];
      const it = bot.inventory.slots[slot];
      if (!it) return;
      if (p.entityStatus === 47) L.note({ broke: it.name });
      else L.record([{ sign: '-', verb: 'broke', items: { [it.name]: 1 } }]);
    } catch (_) {}
  });
}

function exposureOf (bot) {
  if (!bot?.entity) return null;
  const head = bot.entity.position.offset(0, 1.62, 0).floored();
  const b = bot.blockAt(head);
  let roofAt = null; let solidAbove = 0; let readable = 0;
  for (let dy = 1; dy <= 32; dy++) {
    const a = bot.blockAt(head.offset(0, dy, 0));
    if (!a) break;
    readable++;
    if (a.boundingBox === 'block') { solidAbove++; if (roofAt == null) roofAt = dy; }
  }
  const e = { skyLight: b?.skyLight ?? null, roofAt, solidAbove, noData: !b && !readable };
  return { ...e, kind: night.exposureKind(e) };
}

function cancelCommands (why) {
  state.cmdCancelledUpTo = state.cmdSeq || 0;
  state.lastCancel = { t: Date.now(), why };
  try { state.bot.pathfinder.setGoal(null); } catch (_) {}
  try { state.bot.stopDigging(); } catch (_) {}
  try { state.bot.clearControlStates(); } catch (_) {}
  state.currentAction = null;
}

function aggroOf (e) {
  const bot = state.bot;
  if (!state.aggro || !bot?.entity) return null;
  const players = Object.values(bot.players || {})
    .map(p => p.entity).filter(p => p && p !== bot.entity);
  return state.aggro.assess(e, { self: bot.entity, players });
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

  // ⚠️ 2026-09-28 审计（codex fix2 #4）：记下 `loadPlugin` **之前**的 physicsTick 监听，
  //    供下面的崩溃兜底按"引用身份"认出 pathfinder 新增的那条（见 guardPathfinderCrash）。
  try { state.pfListenersBeforeLoad = state.bot.rawListeners('physicsTick').slice(); } catch (_) { state.pfListenersBeforeLoad = []; }
  state.bot.loadPlugin(pathfinderPlugin);
  // 兜住寻路库在 physicsTick 里的崩溃（一条没 catch 的异常会杀掉整个进程，
  // 见 guardPathfinderCrash 的说明）。必须在 loadPlugin **之后** —— 那时
  // monitorMovement 才注册在 physicsTick 上，才拦得到它。
  {
    // ⚠️ 2026-09-28 审计（codex fix2 #4）：**用 before/after 快照认出 pathfinder 那条监听**。
    //    `loadPlugin` 会同步地把 `monitorMovement` 挂到 `physicsTick` 上
    //    （库 `index.js:166`），但它**不导出**那个函数、也没打标记 ——
    //    所以刚才在 `loadPlugin` **之前**已经把当时的监听列表存下来了
    //    （见下面 `pfListenersBeforeLoad`）。新增的那几条就是 pathfinder 的，
    //    按**引用身份**认定，比读 `toString()` 可靠得多。
    const g = guardPathfinderCrash(state.bot, state, state.pfListenersBeforeLoad || []);
    state.pfCrashGuard = g;
    console.log(g.installed
      ? `[pathfinder] 崩溃兜底已装（包住 ${g.wrapped} 条 physicsTick 监听）`
      : `[pathfinder] ⚠️ 崩溃兜底没装上：${g.reason}`);
  }
  // 模组界面补丁：必须在 mineflayer 的 open_window 处理之前装上（prependListener）
  hands.install(state.bot, state);
  installEntitySense(state.bot);
  installLedger(state.bot);
  ftbqSync.install(state.bot, state);
  // 感知那一支要的：`knowledge`（真实标签，分类用）+ `plan`/`ambition`（"她现在缺什么"，排序用）。
  // 都是**只读查询**，`install` 里对它们全部 `?.` 调用 —— 拿不到就退化成"没有 needs"（不猜）。
  instinct.install(state.bot, state, { handlers, hands, pathing, isPlayerBuilt, isDropEntity, droppedItemOf, aggroOf, exposureOf, night, cancelCommands, pickAutoEquip, knowledge: require('../knowledge/knowledge.js'), plan: require('../mind/plan.js'), ambition: require('../mind/ambition.js'), perception: require('../world/perception.js') });

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

    // 木门纳入路径：关着时右键，开着时按门洞方向通过；门口卡住就从当前位置换路。
    state.pfOpenDoors = pathing.applyOpenDoors(mv, state.bot);
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

    console.log(`[pathing] 门路径：${state.pfOpenDoors?.installed
      ? '开门、按门洞方向通行；门口停滞时从当前格换路'
      : `未启用（${JSON.stringify(state.pfOpenDoors)}）`}`
      + '；门板方向拒绝、缺少 facing、停滞后换路次数见 GET /config 的 pathing.openDoors');

    // 审计每一次挖方块。寻路器拆方块走的是 bot.dig，所以包一层就能抓到
    // "不是挖掘任务、却把方块拆了"的情况 —— 这正是玩家房子被拆那次没留痕的原因。
    //
    // ⚠️⚠️ 2026-09-29 问题 4：这里同时是 **`TimeoutNaNWarning: NaN is not a number`**
    // 的修复点（日志 `15:44:58.247 (node) TimeoutNaNWarning`，紧跟一次 `[dig] …` 之后）。
    //
    // 根因链（每一环都有源码行号，不是猜的）：
    //   1. `_ref/mineflayer/lib/plugins/digging.js:27` → `const waitTime = bot.digTime(block)`；
    //      `:136` → `waitTimeout = setTimeout(finishDigging, waitTime)`。
    //      `waitTime` 是 NaN 时，Node 的 setTimeout 会把时长钳成 1ms 并打这条警告 →
    //      挖方块的"完成"被提前 1ms 触发（她挥一下空气就以为挖掉了）。
    //   2. `bot.digTime`（`digging.js:231-259`）转调 `block.digTime(...)`。
    //   3. `node_modules/prismarine-block/index.js:306,355-379`：`const blockHardness = this.hardness`
    //      → `blockBreakingDelta = blockBreakingSpeed / blockHardness / matchingToolMultiplier`
    //      → 若 `hardness` 是 `undefined`：`x / undefined` = **NaN**；接着两个守卫
    //      `=== 0.0`（:366）和 `>= 1.0`（:371）对 NaN **都为 false**，直接落到
    //      `Math.ceil(1.0 / NaN) * 50` = **NaN**（只有 Infinity 那条会被 :28-30 拦下，NaN 不会）。
    //   4. `hardness` 从哪来：**模组方块没有**。`src/world/palette-registry.js:356-371` 的
    //      `buildRecord` 给注入方块只填了 id/name/states/形状 —— 文件头 :129-133 明说
    //      "**刻意不做**：不给注入的方块填 `hardness`/`diggable`"（调色板对这两件事不权威）。
    //      于是任何模组方块（那天是 `galosphere:allurite_cluster` / `natures_spirit:orange_maple_leaves`）
    //      的 `hardness` 都是 undefined。原版方块有 minecraft-data 的 hardness，所以只有模组方块会中招。
    //
    // 修法：在**真正调用**之前，给"没有 hardness"的方块补一个保守的默认值。
    // 选一个**具体的数**（而不是 Infinity/0）：Infinity 会被 `digging.js:28-30` 抛
    // "dig time is Infinity"（不挖了）；0 会被 `prismarine-block:307` 之外当成"瞬间挖掉"。
    // `1.0`（石头在空手时的量级）= "按普通硬方块挖"，宁慢不快 —— 挖得慢只是多挥几下，
    // 挖得"瞬间"会让服务器判定不同步（她这边以为挖掉了、世界还在）。
    // 只在**读不到** hardness 时补，读得到就一个字节都不动（不改变原版行为）。
    // 判据只在这一处（AGENTS.md §5-4），别的调用点（`/mine`、`hands.digBlock`）都经过 `bot.dig`，
    // 所以在这里补一次就全盖住了。
    const DEFAULT_HARDNESS = 1.0;
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
        // hardness 读不到（模组方块；见函数头 1-4 步）→ 补默认值，避免下游 digTime 算出 NaN
        // 而让 setTimeout 收到 NaN（TimeoutNaNWarning + 挖矿提前"完成"）。
        if (block && !Number.isFinite(block.hardness)) {
          try {
            Object.defineProperty(block, 'hardness', { value: DEFAULT_HARDNESS, writable: true, configurable: true, enumerable: true });
          } catch (_) { block.hardness = DEFAULT_HARDNESS; }
        }
      } catch (_) { /* 审计/补值失败不能影响正常挖掘 */ }
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
    // FML：这次连接收了多少个配置文件，在丢掉这具身体之前打一行汇总（默认逐行不打，见 fml-handshake.js）
    if (state.__fml) { try { state.__fml.finish(); } catch (_) {} }
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

let mineflayer, pathfinderPlugin, Movements, goals, Vec3;

let autoEatPlugin = null, toolPlugin = null, collectBlockPlugin = null;

let lastHealth = null;

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.CFG !== undefined) CFG = ns.CFG;
  if (ns.REGISTRY_DIR !== undefined) REGISTRY_DIR = ns.REGISTRY_DIR;
  if (ns.cfg !== undefined) cfg = ns.cfg;
  if (ns.droppedItemOf !== undefined) droppedItemOf = ns.droppedItemOf;
  if (ns.guardPathfinderCrash !== undefined) guardPathfinderCrash = ns.guardPathfinderCrash;
  if (ns.handlers !== undefined) handlers = ns.handlers;
  if (ns.isDropEntity !== undefined) isDropEntity = ns.isDropEntity;
  if (ns.isPlayerBuilt !== undefined) isPlayerBuilt = ns.isPlayerBuilt;
  if (ns.journal !== undefined) journal = ns.journal;
  if (ns.pushChat !== undefined) pushChat = ns.pushChat;
  if (ns.saveState !== undefined) saveState = ns.saveState;
  // 第 4 步去重：sleepMs 不再是本文件的模块级可重绑定变量（改成 require('../util/time') 的
  // const），bind 里这句 `sleepMs = ns.sleepMs` 会报 "Assignment to constant variable" —— 删掉。
  if (ns.state !== undefined) state = ns.state;
}

/** 把本文件里会**重新赋值**的模块级 let 暴露成活访问器（见 extract.js 顶部说明）。 */
// ⚠ 访问器要装在**调用方给的**符号表上（server.js 的那份，别的文件 rebind 时从它读）；
//   只装在本文件自己的 __ns 上的话，其余文件 rebind 拿到的永远是 undefined。
function exposeReloadable (target = __ns) {
  Object.defineProperty(target, 'mineflayer', { enumerable: true, configurable: true, get: () => mineflayer });
  Object.defineProperty(target, 'pathfinderPlugin', { enumerable: true, configurable: true, get: () => pathfinderPlugin });
  Object.defineProperty(target, 'Movements', { enumerable: true, configurable: true, get: () => Movements });
  Object.defineProperty(target, 'goals', { enumerable: true, configurable: true, get: () => goals });
  Object.defineProperty(target, 'Vec3', { enumerable: true, configurable: true, get: () => Vec3 });
  Object.defineProperty(target, 'autoEatPlugin', { enumerable: true, configurable: true, get: () => autoEatPlugin });
  Object.defineProperty(target, 'toolPlugin', { enumerable: true, configurable: true, get: () => toolPlugin });
  Object.defineProperty(target, 'collectBlockPlugin', { enumerable: true, configurable: true, get: () => collectBlockPlugin });
  Object.defineProperty(target, 'BLOCK_NAME_TO_ID', { enumerable: true, configurable: true, get: () => BLOCK_NAME_TO_ID });
}

module.exports = {
  "installReplaceable": installReplaceable,
  "loadDependencies": loadDependencies,
  "installForgeHandshake": installForgeHandshake,
  "paletteCandidates": paletteCandidates,
  "sharedRegistry": sharedRegistry,
  "importPalette": importPalette,
  "shapeStatsOf": shapeStatsOf,
  "autoImportPalette": autoImportPalette,
  "resolveBlockName": resolveBlockName,
  "blockNameToId": blockNameToId,
  "loadItemSnapshot": loadItemSnapshot,
  "fixLadderIdBeforeConnect": fixLadderIdBeforeConnect,
  "useBlockAt": useBlockAt,
  "installPalettePlugin": installPalettePlugin,
  "installItemPlugin": installItemPlugin,
  "entityIndex": entityIndex,
  "installEntitySense": installEntitySense,
  "installLedger": installLedger,
  "exposureOf": exposureOf,
  "cancelCommands": cancelCommands,
  "aggroOf": aggroOf,
  "createBot": createBot,
  "lastHealth": lastHealth,
  bind,
  exposeReloadable,
};
