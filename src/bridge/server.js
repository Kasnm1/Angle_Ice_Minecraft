#!/usr/bin/env node
/**
 * minecraft-bridge: agent ↔ Minecraft Java Edition bridge service
 *
 * ⚠️ **本文件现在是汇总入口**（2026-09-28 第 3 步拆巨石，见
 *    docs/REFACTOR-PLAN-20260928.md）。原来的 6872 行被**原样搬**进同目录的
 *    若干文件（config / state / util / goto / connect / http / routes/*），
 *    这里只负责：
 *
 *      ① require 全部子文件；
 *      ② 建 \`__ns\` 符号表并两阶段 \`bind\`（环里也能拿到真值）；
 *      ③ 把各 \`routes/*.js\` 的路由**按原顺序**拼回 \`handlers\`；
 *      ④ 保持 \`module.exports\` 的名字与顺序**逐字不变**；
 *      ⑤ \`if (require.main === module) main();\` —— 直接跑才起服务。
 *
 *    启动方式不变：
 *      node bridge-server.js          （根目录那个一行转发器）
 *      node src/bridge/server.js      （等价；只用于 \`--check\`，**不要真跑**）
 *
 *    配置来源（优先级：环境变量 > config.json > 内置默认值）：
 *      MC_HOST / MC_PORT / MC_BOT_USERNAME / MC_BRIDGE_PORT / MC_VERSION /
 *      MC_AUTH / MC_FORGE —— 详见 config.js。
 *
 *    只监听 127.0.0.1，不要对外暴露。
 */

'use strict';
require('../log-stamp');   // 拆分时漏搬的顶层语句，2026-09-29 上线崩溃后补

// ---- 子模块（拆自原 server.js；都是"只定义不执行"）--------------------------
const config = require('./config.js');
const stateMod = require('./state.js');
const util = require('./util.js');
const goto = require('./goto.js');
const connect = require('./connect.js');
const http = require('./http.js');
const routeFiles = [
  require('./routes/inspect.js'),
  require('./routes/scan.js'),
  require('./routes/pickup.js'),
  require('./routes/body.js'),
  require('./routes/place.js'),
  require('./routes/move.js'),
  require('./routes/mine.js'),
  require('./routes/gather.js'),
  require('./routes/palette.js'),
  require('./routes/diag.js'),
];

// ---- handlers：**先建空对象**，再让所有人都拿到这同一个引用 -------------------
//
// ⚠️⚠️ 这是本轮唯一的"真环"：
//   · `createBot()`（connect.js）要把 `handlers` 交给 `instinct.install`；
//   · `GET /knowledge/search`（routes/inspect.js）要回调 `handlers['GET /knowledge/search']`；
//   · `POST /place` / `POST /shelter` 内部要调 `handlers['POST /go']` 等。
//   而 `handlers` 本身是由这些文件的路由**拼出来**的。
//
// 解法：把空对象**先建出来**、放进 `__ns`，再 bind —— 于是每个读取方
// 拿到的都是**同一个对象**（引用恒定），后面 `Object.assign` 填键，
// 读取方**立刻看得到**（对象内部变了，引用没变）。
const handlers = {};

// ---- 两阶段装配 ------------------------------------------------------------
//
// ⚠️ 顺序：先 require（上面已完成，无调用）→ 建表 → 全体 bind。
//    任何一处提前「解构」都会在环里拿到 undefined 并永久保持 —— 见 extract.js。

/** 子模块之间共享的符号表。 */
const __ns = { handlers };

/** 把某个子模块的导出并进 __ns（跳过装配用的那几个私有名）。
 *
 *  ⚠️ 两个「必须跳过」：
 *    ① 装配私有名（bind / rebind / exposeReloadable / routes / keys）；
 *    ② **可重新赋值的模块级 let**（goals / Vec3 / lastHealth …）——
 *       它们已由 owner 的 `exposeReloadable()` 定义成访问器，
 *       子模块导出的是**当时的值**（undefined），写进去会把访问器换成死值。
 */
const REASSIGNABLE = ["mineflayer", "pathfinderPlugin", "Movements", "goals", "Vec3", "autoEatPlugin", "toolPlugin", "collectBlockPlugin", "BLOCK_NAME_TO_ID"];

function merge (mod) {
  for (const [k, v] of Object.entries(mod)) {
    if (k === 'bind' || k === 'rebind' || k === 'exposeReloadable'
      || k === 'routes' || k === 'keys') continue;
    if (REASSIGNABLE.includes(k)) continue;
    if (k in __ns) continue;
    __ns[k] = v;
  }
}

// owner 侧把「可重新赋值的模块级 let」挂成 __ns 上的访问器。
// ⚠️ 必须在 merge **之前** —— 否则 merge 会先把 connect 导出的 `goals`（此刻还是
//    undefined）当成普通键写进 __ns，之后 defineProperty 会撞上已存在的可写属性
//    （`configurable: true` 下能覆盖，但顺序清楚更好读），也不知道哪个是权威值。
//
// ⚠️ **不要写死文件名**：owner 只可能是 connect.js，但写死会让"谁拥有这些变量"
//    这件事散落在两个工具里（本轮就因此漏了一处）。改成"谁有这个方法就调谁"。
for (const mod of [config, stateMod, util, goto, connect, http]) {
  if (typeof mod.exposeReloadable === 'function') mod.exposeReloadable(__ns);
}

for (const mod of [config, stateMod, util, goto, connect, http]) merge(mod);
// 路由文件只提供 routes，稍后单独拼（不进 __ns —— 它们没有需要互相引用的名字）
//
// 两个**路由也要用**的模块（2026-09-29）：`GET /surroundings` 要真实的 knowledge 标签
// 和 `world/perception.js`。它们不是拆分产物、原本在别的分区，所以在这里补进 __ns，
// 由 routes/scan.js 的 bind/rebind 抄走（不这样做，路由里 require 也能跑，
// 但会和"谁能注入测试替身"这条约定打架）。
merge({ perception: require('../world/perception.js'), knowledge: require('../knowledge/knowledge.js') });

// ---- 补绑包装：让 `loadDependencies()` 之后所有人拿到最新值 ------------------
//
// 背景（本轮唯一需要额外处理的地方，见 extract.js 顶部完整推导）：
//   `goals` / `Vec3` / `autoEatPlugin` 等模块级 `let` 只在
//   `loadDependencies()` 里被赋值，而两阶段 `bind()` 发生在 **require 期**
//   （更早）。读取方若按普通 `let` 拷贝，拿到的永远是 `undefined`
//   —— 离线全套自测看不见，实机上第一次寻路才炸。
//
// 修法：**在汇总层包一层同名函数**（不改 `loadDependencies` 一个字节；
//   与 p3a 把 `install` 包一层的手法一致）。`main()` 在 http.js 里，
//   它读的是 http.js 作用域里的 `loadDependencies`，而那个由 http.js 的
//   `bind` 从 `__ns` 赋值 —— 所以只要在 **bind 之前** 把
//   `__ns.loadDependencies` 换成包装版，http.js 就会拿到包装版。
const loadDependenciesInner = __ns.loadDependencies;
__ns.loadDependencies = function loadDependencies () {
  const r = loadDependenciesInner.apply(this, arguments);
  rebindAll();          // 真值刚写进 connect.js 的模块级 let，抄给所有读取方
  return r;
};

// owner 侧把「可重新赋值的模块级 let」挂成 __ns 上的访问器（已在上面 merge 之前做过）。

// ---- 全体 bind（此刻 __ns 已备好，包括包装过的 loadDependencies）-----------
for (const mod of [config, stateMod, util, goto, connect, http]) mod.bind(__ns);
for (const rf of routeFiles) { rf.bind(__ns); }

// ---- 汇总层自己要用的几个名字（原本直接来自本文件顶层，现在来自 __ns）------
//
// ⚠️ `hands` **不在** __ns 里：它是各文件自己的局部 require（见 extract.js 的
//    LOCAL_REQUIRES），谁也不导出它。原来这行是 `const hands = require('../body/hands.js')`，
//    现在照旧在汇总层直接 require 一份（Node 只有一份实例，引用相同）。
const { state, CFG, server, createBot, json, withTimeout, fixMojibake, saveState,
  botPos, requireConnected, BRIDGE_VERSION, main } = __ns;
const hands = require('../body/hands.js');

// ---- 拼回 handlers（顺序 = 原 server.js 的书写顺序）-------------------------
//
// ⚠️ 这里**不能**用 `{ ...a, ...b }` 或先把对象合并再展开：键序按插入序，
//    分组一旦乱序，`Object.keys(handlers)` 就变了（routes-test 快照会拦）。
//    所以严格按 routeFiles 的数组顺序逐个 assign —— 数组顺序 = 源码顺序。
for (const rf of routeFiles) Object.assign(handlers, rf.routes);

// BLOCK_NAME_TO_ID 不是 loadDependencies() 里赋的，而是第一次 blockNameToId() 时才建（connect.js 内部调用，
// 绕过 __ns），上面那次 rebindAll 时它还是 null。读它的只有 GET /config —— 每次调用前补一次绑定，路由本体不动。
{
  const cfgRoute = handlers['GET /config'];
  handlers['GET /config'] = function (...a) { rebindAll(); return cfgRoute.apply(this, a); };
}

// hands.js 的路由挂到同一张表上。同名会**静默覆盖** —— /eat 就这样在上面留过一份永远不会被调用的死代码，
// 所以重名一律在启动时喊出来。
const handRoutes = hands.routes({ state, withTimeout });
for (const k of Object.keys(handRoutes)) {
  if (k in handlers) console.warn(`[bridge] ⚠️ 路由重名：${k} —— hands.js 的会覆盖 bridge-server.js 的，删掉其中一份`);
}
Object.assign(handlers, handRoutes);
// 常识动作（装水 / 倒水 / 锄地）：见 commonsense.js。同名同样喊出来
const csRoutes = require('../body/commonsense.js').routes({ state });
for (const k of Object.keys(csRoutes)) if (k in handlers) console.warn(`[bridge] ⚠️ 路由重名：${k}（commonsense.js）`);
Object.assign(handlers, csRoutes);

// ---- 补绑（被上面包装过的 loadDependencies 调用）---------------------------
//
// 把 owner 侧"可重新赋值的模块级 let"的最新值抄给每个读取方。
// 读取方的 `rebind` 是普通赋值；owner 的 `__ns` 访问器保证读到的是当前绑定。
function rebindAll () {
  for (const mod of [config, stateMod, util, goto, connect, http]) {
    if (typeof mod.rebind === 'function') mod.rebind(__ns);
  }
  for (const rf of routeFiles) if (typeof rf.rebind === 'function') rf.rebind(__ns);
}

// —— 导出：给测试（routes-test）与后续拆文件用。state / handlers 是**活引用**，
//    测试枚举 handlers 的键时不连服务器、不开端口。
module.exports = {
  handlers,
  state,
  main,
  CFG,
  server,
  createBot,
  // 下面这些是拆文件/测试可能用到的工具与常量，一并导出便于复用（不改行为）
  json,
  withTimeout,
  fixMojibake,
  saveState,
  botPos,
  requireConnected,
  BRIDGE_VERSION,
};

// 只有直接 `node bridge-server.js` 才起服务；被 require 时什么都不做（无副作用）。
if (require.main === module) main();
