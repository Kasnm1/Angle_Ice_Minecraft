'use strict';
// 真实 install + 受控定时器，复现长任务占用、事件触发与睡眠缓存；不连游戏。
// 用法：node scripts/instinct-scheduling-test.js
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const file = path.join(__dirname, '..', 'src', 'instinct', 'instinct.js');
let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup () {
  const timers = new Map(); const immediates = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: createRequire(file), module, exports: module.exports, __dirname: path.dirname(file),
    process, console, Date, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.set(t, t); return t; },
    clearInterval: t => timers.delete(t), setImmediate: fn => immediates.push(fn),
  }, { filename: file });
  const api = module.exports;
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: { entitiesByName: { player: { metadataKeys: ['pose'] } }, blocksByName: {}, itemsByName: {} },
    entity: { id: 1, name: 'player', position: new Vec3(0, 64, 0), metadata: [0], effects: {} },
    entities: {}, players: {}, inventory: { items: () => [], slots: [], emptySlotCount: () => 10 },
    health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: 1000 }, game: {},
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air' }),
    pathfinder: { goto: async () => {}, setGoal: () => {}, stop: () => {} },
    stopDigging: () => {}, clearControlStates: () => {}, closeWindow: () => { bot.currentWindow = null; },
    lookAt: async () => {}, attack: () => {},
  });
  const state = { connected: true, currentAction: null };
  const deps = { handlers: {}, hands: { foodScore: () => 1 }, isDropEntity: () => false,
    aggroOf: () => null, cancelCommands: () => { state.currentAction = null; }, tables: { ores: {}, crops: {} } };
  api.install(bot, state, deps);
  const fire = async (ms) => { const jobs = [...timers.values()].filter(t => t.ms === ms).map(t => t.fn()); await Promise.all(jobs); await flush(); };
  const events = async () => { while (immediates.length) immediates.shift()(); await flush(); };
  return { api, bot, state, deps, timers, fire, events };
}
async function main () {
  const t = setup(); const { api, bot, state } = t;
  bot.isSleeping = true;
  ok(api.syncSleepState(bot).corrected && !bot.isSleeping, '明确站立姿态纠正错误睡眠缓存');
  bot.entity.metadata[0] = 2;
  ok(api.syncSleepState(bot).sleeping, '真正睡觉仍保持睡眠');
  bot.entity.metadata = [];
  bot.time.timeOfDay = 15000;   // 夜里：姿态读不到就不擅自唤醒
  ok(!api.syncSleepState(bot).corrected && bot.isSleeping, '姿态未知（夜里）不擅自唤醒');
  bot.time.timeOfDay = 1000;    // 白天床睡不了：缓存里的"在睡"一定是旧的（d3633db 的设计）
  ok(api.syncSleepState(bot).corrected && !bot.isSleeping, '姿态未知但天亮了 → 纠正成醒');
  bot.isSleeping = true;
  bot.entity.position = new Vec3(3,64,0);
  ok(api.syncSleepState(bot, new Vec3(0,64,0)).corrected && !bot.isSleeping, '姿态缺失但已走离床位时纠正睡眠缓存');
  bot.entity.position = new Vec3(0,64,0);
  bot.entity.metadata = [3];
  ok(!api.syncSleepState(bot).sleeping, '游泳姿态不会被当成睡觉');
  bot.isSleeping = true; bot.entity.metadata = [0];
  bot.emit('entityHurt', bot.entity);
  await t.events();
  ok(!bot.isSleeping && state.instinct.sleepCorrections === 1, '事件检查实际修正睡眠缓存');
  ok(state.instinct.diagnostics.combat.source === 'event', '受伤不用等待250ms定时器');
  ok(state.instinct.diagnostics.combat.targets === 0, '没有仇恨证据不攻击');
  bot.entity.metadata = [2];
  await t.fire(400);
  ok(state.instinct.last.skip === '正在睡觉', '普通本能不再静默跳过睡眠阻塞');
  bot.emit('end');
  ok(t.timers.size === 0, '断线清理所有定时器');
  bot.emit('health'); await t.events();
  ok(bot.listenerCount('health') === 0, '断线移除即时健康检查');

  const home = { center: { x: 24, y: 128, z: 9 }, radius: 24 };
  ok(!!api.caveBoundary({ x: 31, y: 96, z: 9 }, home), '住宅下32格仍在自动探洞禁区');
  ok(!!api.caveBoundary({ x: 24, y: -60, z: 9 }, home), '住宅地下保护不受旧16格高度差限制');
  ok(api.caveBoundary({ x: 60, y: 96, z: 9 }, home) === null, '家外洞穴仍可正常自主探索');
  ok(!!api.caveBoundary({ x: 31, y: 96, z: 9 }, null), '刚重连尚未收到家范围时不贸然探洞');
  const d = {}; let release; let calls = 0;
  const check = api.createCheck('test', async () => { calls++; await new Promise(r => { release = r; }); }, d);
  const first = check(); await check('event');
  ok(calls === 1 && d.test.active, '检查运行中不重入');
  release(); await first;
  ok(!d.test.active && typeof d.test.durationMs === 'number', '结束后记录检查耗时');
  await api.createCheck('error', async () => { throw Error('故障'); }, d)();
  ok(d.error.error === '故障' && !d.error.active, '检查错误可观测且不泄漏rejection');

  const keepAlive = setTimeout(() => {}, 30);
  ok(!await api.settleJob({ done: new Promise(() => {}) }, 5), '不响应取消的旧任务不会永久卡死检查');
  clearTimeout(keepAlive);
  ok(await api.settleJob({ done: Promise.reject(Error('取消')) }, 5), '旧任务拒绝也算收尾完成');

  const h = setup();
  let aborted = false; let moved = 0; let finish;
  const old = { kind: 'mine', abort: () => { aborted = true; finish(); }, done: new Promise(r => { finish = r; }) };
  h.state.instinct.running = old;
  old.done.then(() => { if (h.state.instinct.running === old) h.state.instinct.running = null; });
  h.bot.blockAt = p => ({ name: p.y < 64 ? 'stone' : p.x === 0 && p.z === 0 && p.y === 64 ? 'fire' : 'air' });
  h.bot.pathfinder.goto = async () => { moved++; };
  await h.fire(250);
  ok(aborted && moved === 1, '采矿占用时危险方块独立检查并接管');
  ok(h.state.instinct.urgent === null && h.state.instinct.running === null, '退开完成释放身体');
  h.bot.emit('end');

  const b = setup(); let jumped = 0;
  b.bot.oxygenLevel = 6; b.bot.blockAt = () => ({ name: 'water' });
  b.deps.handlers['POST /jump'] = async args => { ok(typeof args.abort === 'function', '上浮动作可以取消'); jumped++; b.bot.oxygenLevel = 20; return { oxygen: 20, jumped: 1 }; };
  b.bot.emit('breath'); await b.events();
  ok(jumped === 1 && b.state.instinct.diagnostics.breathe.source === 'event', '氧气事件立即上浮');
  ok(b.state.instinct.urgent === null, '上浮结束释放紧急占用');
  b.bot.emit('end');

  const c = setup(); let hits = 0;
  const mob = { id: 2, name: 'zombie', position: new Vec3(1,64,0) };
  c.bot.entities[2] = mob; c.bot.currentWindow = {};
  c.deps.aggroOf = () => ({ on: 'me', evidence: 'hurt' });
  c.bot.attack = () => { hits++; };
  c.bot.emit('entityHurt', c.bot.entity, mob); await c.events();
  ok(c.bot.currentWindow === null && hits === 1, '开箱时有敌人仍关窗并立即攻击');
  ok(c.state.instinct.events.some(e => e.kind === 'combat_start'), '保留开战证据');
  const reject = await c.api.yieldBody(c.state, 'POST /mine');
  ok(!!reject?.reject, '紧急接管时普通命令不能抢回身体');
  const stop = c.api.yieldBody(c.state, 'POST /stop', { hold: true });
  await new Promise(r => setTimeout(r, 180)); await stop;
  ok(c.state.instinct.running === null && c.state.instinct.urgent === null, '明确叫停仍能终止战斗');
  c.bot.emit('end');

  const pre = setup(); let finishOld;
  pre.bot.entities[2] = mob; pre.deps.aggroOf = () => ({ on: 'me', evidence: 'hurt' });
  pre.state.instinct.running = { kind: 'mine', abort: () => {}, done: new Promise(r => { finishOld = r; }) };
  pre.bot.emit('entityHurt', pre.bot.entity, mob); await pre.events();
  ok(pre.state.instinct.urgent === 'combat', '战斗尚在等旧任务时已经预留身体');
  const stopPre = pre.api.yieldBody(pre.state, 'POST /stop', { hold: true });
  finishOld(); await stopPre; await flush();
  ok(!pre.state.instinct.combat, '准备阶段被叫停后不会迟到开战');
  pre.bot.emit('end');

  const cb = setup(); let floated = 0;
  cb.bot.entities[2] = mob;
  cb.deps.aggroOf = () => ({ on: 'me', evidence: 'hurt' });
  cb.bot.emit('entityHurt', cb.bot.entity, mob); await cb.events();
  ok(cb.state.instinct.running?.kind === 'combat', '先进入战斗');
  cb.bot.oxygenLevel = 5; cb.bot.blockAt = () => ({ name: 'water' });
  cb.deps.handlers['POST /jump'] = async () => { floated++; cb.bot.oxygenLevel = 20; return { oxygen: 20 }; };
  cb.bot.emit('breath'); await cb.events();
  await new Promise(r => setTimeout(r, 180)); await flush();
  ok(floated === 1 && cb.state.instinct.urgent === null, '憋气可以取消战斗，上浮不与攻击重叠');
  cb.bot.emit('end');
  const hands = require('../src/body/hands.js');
  const sb = new EventEmitter(); sb.isSleeping = false;
  const route = hands.routes({ state: { bot: sb } })['POST /sleep'];
  ok((await route({ abort: () => true })).aborted, '睡觉开始前已取消时不扫描世界');
  let cancelSleep = false; let activated = false;
  const bed = { name: 'mod:bed', id: 1, position: new Vec3(0,64,0) };
  sb.registry = { blocksByName: { bed } }; sb.entity = { position: new Vec3(0,64,0) };
  sb.findBlocks = () => [bed.position]; sb.blockAt = () => bed; sb.isABed = () => false;
  sb.lookAt = async () => { cancelSleep = true; };
  sb.activateBlock = async () => { activated = true; };
  ok((await route({ abort: () => cancelSleep })).aborted && !activated, '准备点床时被打断不能继续躺下');
  ok(sb.listenerCount('message') === 0, '取消睡觉清理临时监听器');
  console.log(`${passed} passed, 0 failed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
