'use strict';

/**
 * 寻路策略 —— **汇总入口**（第 3 步重构，2026-09-29）。
 *
 * 原来这里是 3798 行的巨石；现在只剩一行转发到同目录的 `pathing/index.js`
 * （**普通文件，不是符号链接** —— Windows 的 git 默认把符号链接签出成纯文本，
 * `require` 会炸，见 `docs/REFACTOR-PLAN-20260928.md` 第 3 步）。
 *
 * 为什么保留这个路径：`src/bridge/{connect,goto,state,util}.js`、
 * `src/bridge/routes/{body,diag,inspect,mine,move,pickup}.js`、
 * `src/instinct/core.js`（经 `deps.pathing`）都 `require('../world/pathing')` ——
 * 外部 `require` 路径**一个都不许变**。
 *
 * 拆出来的东西在 `src/world/pathing/`：movements（寻路策略 / 代价 / 受保护方块 /
 * 挖掘白名单 / 搭路 / 落地水）/ doors（开门）/ ladders（梯子识别）/ unknown-blocks
 * （未映射方块与薄方块）/ fluid（流体安全）/ probe（注册表往返自检）/
 * collect（自适应采集搜索）/ budget（goto 预算与停滞）/ selftest（475 条断言）。
 *
 * 自测不变：`node src/world/pathing.js --selftest`（475 条）。
 */

// ⚠️ 顺序很重要：**先投票、再 require 汇总**（2026-09-29 踩过）：
//    `node src/world/pathing.js --selftest` 时 `require.main.filename` 是**本文件**
//    （实测确认；Node 用解析后的真实路径，所以转发到 ./pathing/index.js 后，
//    index.js 里那句 `require.main === module` 永远为假 —— 放那里会静默不跑）。
//    `pathing/index.js` 是**同步** require 子文件并在末尾转调 run() 的，所以票必须
//    在它加载**之前**投出去（先 `require('.../index.js')` 再投票 = run() 早就跑完了）。
//      · 带 `--selftest` 直接跑本文件 → 置位，index.js 转调 run() 跑 475 条；
//      · `node bridge-server.js`（不带 --selftest）→ 不置位，一行用例都不打
//        （bridge-boot-test 靠输出判过，多打 475 行会把 GET /status 那步顶掉）；
//      · test-all 单独扫到 `pathing/selftest.js --selftest` → 也没人投票，安静绿。
if (require.main === module && process.argv.includes('--selftest')) {
  require('./pathing/selftest.js').markSelftestRequested();
}

module.exports = require('./pathing/index.js');
