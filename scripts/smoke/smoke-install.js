#!/usr/bin/env node
'use strict';

/**
 * smoke-install.js —— 假 bot 驱动 **真实的** `instinct.install()`，跑 6 秒不崩。
 *
 * ## 为什么值得单列一条冒烟
 *
 * `instinct.js` 的自测（`--selftest`）测的是**纯函数**（`pick*` / `*Plan` / `need*`）。
 * 但真正上线跑的是 `install(bot, state, deps)` —— 它给 bot 挂一堆 `bot.on(...)`
 * 监听、起内部计时器、按 tick 做决策。**这一段没有离线测试覆盖**，而它崩起来
 * 只有上了实机才看得见（今天的几个 bug 都出在这条缝里）。
 *
 * 这个脚本用 EventEmitter 假装一个 bot，把 install 挂上去、触发几个事件、
 * 跑几秒，断言：① 没抛异常；② 内部状态按预期长出来（`state.instinct`）。
 *
 * 用法：node scripts/smoke/smoke-install.js
 */

const EventEmitter = require('events');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');   // scripts/smoke/ → 项目根
const { Vec3 } = require(path.join(ROOT, 'node_modules', 'vec3'));
const instinct = require(path.join(ROOT, 'src', 'instinct', 'instinct.js'));
const night = require(path.join(ROOT, 'src', 'mind', 'night.js'));

// ---- 假 bot：只提供 instinct 会碰到的字段 -----------------------------------
function makeBot () {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0), effects: {}, id: 1 };
  bot.registry = require(path.join(ROOT, 'node_modules', 'minecraft-data'))('1.20.1');
  bot.inventory = { items: () => [], slots: [], emptySlotCount: () => 30 };
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty', getProperties: () => ({}) });
  bot.findBlocks = () => [];
  bot.entities = {}; bot.players = {};
  bot.health = 20; bot.food = 20; bot.oxygenLevel = 20;
  bot.time = { timeOfDay: 1000 };
  bot.game = { dimension: 'overworld' };
  bot._client = new EventEmitter();
  bot.pathfinder = { setGoal () {}, movements: null };
  bot.isRaining = false;
  bot.thunderState = 0;
  return bot;
}

function makeDeps (overrides = {}) {
  return {
    handlers: {},
    hands: { foodScore: () => 0, SCAFFOLD_IDS: [], scaffoldIds: () => [], slotByName: () => null },
    pathing: null,
    isPlayerBuilt: () => false,
    isDropEntity: () => false,
    droppedItemOf: () => null,
    aggroOf: () => null,
    exposureOf: () => ({ kind: 'open' }),
    night,
    cancelCommands () {},
    pickAutoEquip: () => null,
    ...overrides,
  };
}

// ---- 断言小工具 ------------------------------------------------------------
let pass = 0; let fail = 0;
function ok (name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
}

console.log('smoke-install：假 bot 跑真实 instinct.install');

const bot = makeBot();
const state = {};
const deps = makeDeps();

let crashed = null;
process.on('uncaughtException', (e) => {
  crashed = e;
  console.log('CRASH', e.stack.split('\n').slice(0, 4).join(' | '));
});

// install 本身不能抛
let installThrew = null;
try {
  instinct.install(bot, state, deps);
} catch (e) {
  installThrew = e;
}
ok('instinct.install() 不抛异常', !installThrew, installThrew && installThrew.message);

// install 之后该长出来的状态
ok('state.instinct 被建立', !!state.instinct, Object.keys(state).join(','));
ok('state.instinct.cfg 存在（本能配置就位）', !!state.instinct && !!state.instinct.cfg);
ok('state.instinct.events 是数组（事件流就位）', Array.isArray(state.instinct && state.instinct.events));
ok('install 给 bot 挂了监听器', bot.eventNames().length > 0, bot.eventNames().length);

// 触发几个天气 / 时间事件 —— 这些路径原来没测过，崩在这里就是实机会崩的
try {
  bot.isRaining = true;
  bot.emit('rain');
  bot.emit('time');
  bot.emit('physicsTick');
} catch (e) {
  crashed = crashed || e;
  console.log('EVENT CRASH', e.stack.split('\n').slice(0, 4).join(' | '));
}
ok('触发 rain / time / physicsTick 不抛异常', !crashed, crashed && crashed.message);

// 跑满 6 秒，让内部计时器转几圈（本能是 tick 驱动的）
const RUN_MS = 6000;
setTimeout(() => {
  const events = state.instinct && state.instinct.events;
  ok('6 秒内无未捕获异常', !crashed, crashed && crashed.message);
  ok('事件流有结构（即便为空也是数组）', Array.isArray(events), typeof events);
  console.log(`  事件流：${events && events.length ? events.map(e => e.kind).join(',') : '(空)'}`);

  // 收尾：关掉本能计时器（bot.emit('end') 是 install 里注册的清理入口），
  // 否则进程会因为残留句柄不退出。这一步本身就是"跑完能退出"的验收。
  bot.emit('end');

  console.log(`\n  ${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
}, RUN_MS);
