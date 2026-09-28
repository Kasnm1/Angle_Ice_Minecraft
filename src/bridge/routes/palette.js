/**
 * routes/palette.js —— 从 server.js 的 handlers 表拆出的 5 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const blockPalette = require('../../world/block-palette.js');
const fs = require('fs');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let state;

function importPalette (...a) { return __ns.importPalette.apply(null, a); }
function paletteCandidates (...a) { return __ns.paletteCandidates.apply(null, a); }

/**
 * 本文件负责的路由（5 条）：
 *   GET /palette
 *   POST /registry/import-palette
 *   GET /palette/state
 *   GET /palette/block
 *   GET /palette/climbable
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
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
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.importPalette !== undefined) importPalette = ns.importPalette;
  if (ns.paletteCandidates !== undefined) paletteCandidates = ns.paletteCandidates;
  if (ns.state !== undefined) state = ns.state;
}

module.exports = {
  routes,
  keys: ["GET /palette","POST /registry/import-palette","GET /palette/state","GET /palette/block","GET /palette/climbable"],
  bind,
 };
