#!/usr/bin/env node
'use strict';

/**
 * wiring.js —— 兄弟文件之间"**运行时才读**"的那几个转发壳。
 *
 * ## 为什么要有这个文件
 *
 * 只搬移的拆分里，转发壳本来都在**加载期**取值：
 *
 *     const { buildNow } = require('./think');          // 加载期解构
 *
 * 这会踩到循环依赖：think.js 要调 runtime.js 的 emit()，runtime.js 又要调 think.js 的
 * bodyNow()；两边都在文件顶部 require 对方，先被加载的那个拿到的是**半成品**
 * （另一个模块的 module.exports 这时还是 {}），解构出来就是 undefined，一直不报错，
 * 直到运行到那一行才 xxx is not a function。
 * （拆 src/body/、src/instinct/、src/bridge/ 时踩过这个坑，见各区 AGENTS.md。）
 *
 * 这里的做法：**不在加载期解构**，只把模块名记下来，等第一次真被调用时才 require ——
 * 那时 require.cache 已经填满，拿到的就是完整导出。
 *
 * 第 3 步（e）拆 src/mind/mind.js（2026-09-29，只搬移不改逻辑）。
 */

const cache = {};

/** 第一次调用时才真加载 —— 避开"对方还没执行完 module.exports = {}"的窗口期 */
function lazy (name) {
  return () => (cache[name] ||= require('./' + name));
}

module.exports = {
  runtime: lazy('runtime'),
  scene: lazy('scene'),
  look: lazy('look'),
  gates: lazy('gates'),
  tools: lazy('tools'),
  actions: lazy('actions'),
  think: lazy('think'),
  // 任务队列（阶段 1）：think / look / actions 都要用它；它自己不回头 require 这些，
  // 摆在这里是为了"取法"统一（别处也可以直接 `require('./tasks')`，效果一样）。
  tasks: lazy('tasks'),
  selftest: lazy('selftest'),
};
