#!/usr/bin/env node
'use strict';

/**
 * smoke-surface.js —— 站在水里、东边有岸时，本能必须调 `POST /go` 上岸。
 *
 * ## 这条覆盖的是什么
 *
 * "憋气上浮 / 上岸"是本能里少有的**读世界几何再决定去哪个坐标**的逻辑：
 * 它扫描周围找一块能站的地面（`isStandable` 那条判据），算出落脚点，
 * 再调 `deps.handlers['POST /go']`。判据错、坐标算错、键名错，纯函数自测
 * 都看不见 —— 实机表现是"她泡在水里不上来"。
 *
 * 这个脚本造一个"西边全是水、东边有草地"的假世界，断言：
 *   ① 本能真的调了 /go；② 目标在**东边**（x > 当前位置 x），不是原地打转。
 *
 * 用法：node scripts/smoke/smoke-surface.js
 */

const EventEmitter = require('events');
const path = require('path');

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

console.log('smoke-surface：在水里时本能往干燥的岸上走');

const bot = new EventEmitter();
bot.entity = { position: new Vec3(0.5, 64, 0.5), effects: {}, id: 1, isInWater: true };
bot.registry = require(path.join(ROOT, 'node_modules', 'minecraft-data'))('1.20.1');
bot.inventory = { items: () => [], slots: [], emptySlotCount: () => 30 };

// 假世界：x < 4 是水（y ≤ 64）或石头（y < 60），x ≥ 4 是草地（y ≤ 64）
const W = (p) => {
  if (p.x < 4) {
    return p.y <= 64
      ? { name: p.y < 60 ? 'stone' : 'water', boundingBox: p.y < 60 ? 'block' : 'empty', getProperties: () => ({}) }
      : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) };
  }
  return p.y <= 64
    ? { name: 'grass_block', boundingBox: 'block', getProperties: () => ({}) }
    : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) };
};
bot.blockAt = (p) => W({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
bot.findBlocks = () => [];
bot.entities = {}; bot.players = {};
bot.health = 20; bot.food = 20; bot.oxygenLevel = 20;
bot.time = { timeOfDay: 1000 };
bot.game = { dimension: 'overworld' };
bot._client = new EventEmitter();
bot.pathfinder = { setGoal () {}, movements: null };
bot.isRaining = false;
bot.thunderState = 0;

const state = {};

let goCalls = 0;
let lastTarget = null;
const deps = {
  handlers: {
    'POST /go': async (a) => {
      goCalls++;
      lastTarget = a;
      console.log(`  → /go 目标 (${a.x}, ${a.y}, ${a.z})`);
      bot.entity.position = new Vec3(a.x + 0.5, a.y, a.z + 0.5);
      bot.entity.isInWater = false;
      return { arrived: true };
    },
  },
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
ok('install 不抛异常', !installThrew, installThrew && installThrew.message);

try {
  bot.isRaining = true;
  bot.emit('rain');
  bot.emit('physicsTick');
} catch (e) { crashed = crashed || e; }

setTimeout(() => {
  ok('在水里时调用了 /go', goCalls > 0, `goCalls=${goCalls}`);
  if (lastTarget) {
    ok('落脚点在东边（x > 当前位置 0.5）', lastTarget.x > 0.5,
      `target.x=${lastTarget.x}`);
    ok('落脚点是有地面的一层（y ≈ 64）', lastTarget.y >= 63 && lastTarget.y <= 66,
      `target.y=${lastTarget.y}`);
  } else {
    ok('落脚点在东边（x > 当前位置 0.5）', false, '没有 /go 调用，无从判断');
    ok('落脚点是有地面的一层（y ≈ 64）', false, '没有 /go 调用，无从判断');
  }
  ok('没有未捕获异常', !crashed, crashed && crashed.message);

  bot.emit('end');
  console.log(`\n  ${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
}, 6000);
