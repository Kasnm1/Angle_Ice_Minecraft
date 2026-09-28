#!/usr/bin/env node
'use strict';

/**
 * smoke-eat.js —— 饥饿 10 时，本能必须真的调 `POST /eat`。
 *
 * ## 这条覆盖的是什么
 *
 * `instinct.js` 的"饿了就吃"逻辑写的是：food ≤ 阈值时调用 `deps.handlers['POST /eat']`。
 * 这是**跨模块的一条约定**（本能用哪个键名调身体层），而键名写错、handler 没传进来
 * 这类错误，纯函数自测一个都抓不到 —— 它只会在实机上表现为"她饿着不动"。
 *
 * 这个脚本给一个"只有 pickup 段"的老 state（模拟从旧版本升上来的状态），
 * 把 food 设成 10、塞一个记录调用的假 `POST /eat`，跑几秒，断言 eat 被调过。
 *
 * 用法：node scripts/smoke/smoke-eat.js
 */

const EventEmitter = require('events');
const path = require('path');
const os = require('os');

// ★ 冒烟测试**绝不能碰真实记忆**：install() 会起 her 的余光计时器（`perceptionTimer`），
//   它每几秒把野外资源写进 `memory/resources.json`。这里指到临时文件（同 smoke-install.js）。
if (!process.env.MC_RESOURCES_FILE) {
  process.env.MC_RESOURCES_FILE = path.join(os.tmpdir(), `smoke-resources-${process.pid}.json`);
}

const ROOT = path.join(__dirname, '..', '..');
const { Vec3 } = require(path.join(ROOT, 'node_modules', 'vec3'));
const instinct = require(path.join(ROOT, 'src', 'instinct', 'instinct.js'));
const night = require(path.join(ROOT, 'src', 'mind', 'night.js'));

let pass = 0; let fail = 0;
function ok (name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` —— ${extra}` : ''}`);
}

console.log('smoke-eat：饥饿时本能真的调 /eat');

const bot = new EventEmitter();
bot.entity = { position: new Vec3(0, 64, 0), effects: {}, id: 1 };
bot.registry = require(path.join(ROOT, 'node_modules', 'minecraft-data'))('1.20.1');
bot.inventory = { items: () => [{ name: 'bread', count: 2 }], slots: [], emptySlotCount: () => 30 };
bot.blockAt = () => ({ name: 'air', boundingBox: 'empty', getProperties: () => ({}) });
bot.findBlocks = () => [];
bot.entities = {}; bot.players = {};
bot.health = 20;
bot.food = 10;                    // ← 低于吃阈值，应触发吃
bot.oxygenLevel = 20;
bot.time = { timeOfDay: 1000 };
bot.game = { dimension: 'overworld' };
bot._client = new EventEmitter();
bot.pathfinder = { setGoal () {}, movements: null };
bot.isRaining = false;
bot.thunderState = 0;

// 老版本 state：**只有 pickup 段**，没有别的本能段 —— 考的是 install 能不能把它补全。
// ⚠️ `connected: true` 是必须的：checkEat 第一行就判 `!state.connected` 直接 return
//    （本能在"没连上"时什么都不做是**对的**）。原来临时目录里的 smoke2 少了这一条，
//    于是它从来没真的调过 /eat —— 它当时打印的 "smoke ok" 是假绿。
const state = {
  connected: true,
  instinct: { cfg: { pickup: {} }, inflight: 0, quietUntil: 0, running: null, events: [], evSeq: 0, log: [], told: new Set() },
};

let eatCalls = 0;
let eatArg = null;
const deps = {
  handlers: {
    'POST /eat': async (a) => {
      eatCalls++;
      eatArg = a;
      bot.food = 15;
      return { ate: true, item: 'bread', foodBefore: 10, foodAfter: 15 };
    },
  },
  hands: { foodScore: () => 1, SCAFFOLD_IDS: [], scaffoldIds: () => [], slotByName: () => null },
  pathing: null,
  isPlayerBuilt: () => false,
  isDropEntity: () => false,
  droppedItemOf: () => null,
  aggroOf: () => null,
  exposureOf: () => ({ kind: 'open' }),
  night,
  cancelCommands () {},
  pickAutoEquip: () => null,
};

let crashed = null;
process.on('uncaughtException', (e) => {
  crashed = e;
  console.log('CRASH', e.stack.split('\n').slice(0, 4).join(' | '));
});

let installThrew = null;
try {
  instinct.install(bot, state, deps);
} catch (e) { installThrew = e; }
ok('老 state（只有 pickup 段）也能 install 不抛', !installThrew, installThrew && installThrew.message);
ok('install 后本能段被补全（eating / 其它段就位）',
  Object.keys(state.instinct).length > 3, Object.keys(state.instinct).join(','));

try {
  bot.isRaining = true;
  bot.emit('rain');
  bot.emit('physicsTick');
} catch (e) { crashed = crashed || e; }

setTimeout(() => {
  ok('饥饿 10 时调用了 /eat', eatCalls > 0, `eatCalls=${eatCalls}`);
  ok('调用时身体层确认吃了（food 回到 15）', bot.food === 15, bot.food);
  ok('没有未捕获异常', !crashed, crashed && crashed.message);

  bot.emit('end');   // 关掉本能计时器，让进程能退出
  console.log(`\n  ${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
}, 6000);
