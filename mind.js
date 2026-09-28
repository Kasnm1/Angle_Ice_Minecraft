#!/usr/bin/env node
'use strict';

/**
 * mind.js —— 根目录入口（**只转发，不做事**）。
 *
 * 和 `bridge-server.js` 同一对：`scripts/win/angel.ps1` 在 Windows 上
 * `cd` 到仓库根起的就是这两个文件。代码在第 2 步挪进了 `src/mind/mind.js`，
 * 这里保留一行转发，Windows 那边不改。
 *
 * 用法（与重构前完全一致）：
 *     node mind.js               # 起 :3003（需先起 bridge-server.js）
 *     node mind.js --selftest
 *     node mind.js --sim "安琪你好" "给你7个鸡蛋"
 */

const mind = require('./src/mind/mind.js');
module.exports = mind;

// `cli()` 是 async（三种模式内部自己 `process.exit`，退出码由它定）。
// 这里只吞掉 Promise，不能再套一层 process.exit —— 那会把 Promise 当退出码传进去。
if (require.main === module) mind.cli(process.argv.slice(2));
