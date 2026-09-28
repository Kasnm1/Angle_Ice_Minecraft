/**
 * config.js —— 从 server.js 拆出的一部分。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('../paths');

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

const REGISTRY_DIR = paths.REGISTRY;

const BOT_IDENTITY = 'Angle_ICE';

const MAX_SCAN_BLOCK_POSITIONS = 6000;

const BRIDGE_VERSION = '1.12.0';

function loadFileConfig () {
  const cfgPath = paths.CONFIG;
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

function cfg (key, fallback) {
  const env = process.env[key];
  if (env !== undefined && env !== '') return env;
  const file = FILE_CFG[key];
  if (file !== undefined && file !== null && file !== '') return String(file);
  return fallback;
}

const CFG = {
  mc: {
    host: cfg('MC_HOST', 'localhost'),
    port: parseInt(cfg('MC_PORT', '25565')),
    // 固定身份：Angle_ICE（见文件顶部 BOT_IDENTITY）
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

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
}

module.exports = {
  "REGISTRY_DIR": REGISTRY_DIR,
  "BOT_IDENTITY": BOT_IDENTITY,
  "MAX_SCAN_BLOCK_POSITIONS": MAX_SCAN_BLOCK_POSITIONS,
  "BRIDGE_VERSION": BRIDGE_VERSION,
  "loadFileConfig": loadFileConfig,
  "FILE_CFG": FILE_CFG,
  "cfg": cfg,
  "CFG": CFG,
  bind,
};
