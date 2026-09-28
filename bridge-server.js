#!/usr/bin/env node
'use strict';

/**
 * bridge-server.js —— 根目录入口（**只转发，不做事**）。
 *
 * ## 为什么根目录还留这两个文件
 *
 * `scripts/win/angel.ps1` 在 Windows 上 `cd` 到仓库根，起的就是 `node bridge-server.js`
 * 和 `node mind.js`（进程匹配、日志名、selftest 名单都写死了这两个名字）。
 * 重构第 2 步把代码挪进了 `src/`，但**这两个入口永远保留**，
 * 只是变成一行转发 —— Windows 那边一行都不用改。
 *
 * 真正的服务在 `src/bridge/server.js`（第 3 步会在那里继续拆路由）。
 *
 * 用法（与重构前完全一致）：
 *     node bridge-server.js            # 起 :3001，连服务器
 *     node --check bridge-server.js    # 只做语法检查（绝不能 --selftest）
 */

// 直接跑 bridge 会连游戏服务器、占 3001、用 Angle_ICE 登录（会把 Windows 上的她挤下线）。
// 它没有 --selftest：带这个参数一律拒绝（2026-09-28 重构时 Mac 上曾有一个 bridge 被意外起来连上了服务器）
if (require.main === module && process.argv.includes('--selftest')) {
  console.error('bridge-server.js 没有 --selftest（跑起来会连服务器）。测试用 npm test。');
  process.exit(2);
}
module.exports = require('./src/bridge/server.js');
if (require.main === module) module.exports.main();
