'use strict';

// 汇总入口（第 3 步重构，2026-09-28）：原来 5598 行的 hands.js 已拆到 index.js + 8 个子文件，
// 这里只转发，让 require('../body/hands') 和 angel.ps1 的自测名单照旧能用。
// 不用符号链接：Windows 上 git 默认 core.symlinks=false，会签出成一行文本 "index.js"，require 直接炸。
module.exports = require('./index');

// `node src/body/hands.js --selftest`：index.js 的自测只认 require.main === 它自己，这里照它的顺序转跑一遍
if (require.main === module && process.argv.includes('--selftest')) {
  require('./containers'); require('./craft'); require('./movement'); require('./kit'); require('./build');
  require('./testkit').bindHands(module.exports.__ns);
  require('./testkit').runSuite('hands');
}
