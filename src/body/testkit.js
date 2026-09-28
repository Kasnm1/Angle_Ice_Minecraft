'use strict';

/**
 * 自测脚手架（第 3 步重构，2026-09-28）。
 *
 * hands.js 原来是一整个文件，自测段里有一段共用外套：check / wait / rig / mkGoBot /
 * goals / Vec3 / TICK。拆成 8 个文件后，外套放这里，各文件只登记自己的小节：
 *
 *   const { register, runSuite } = require('./testkit');
 *   const __sections = [ ['[label]', async (t) => { const { check, ... } = t; ... }] ];
 *   register('mine', __sections);                       // require 时登记，不跑
 *   // 直接运行本文件时（带那个 --selftest 开关）再 runSuite('mine', __sections)
 *
 * 汇总 index.js 把 8 个文件都 require 一遍（登记），再 runSuite('hands') 依次跑**全部** ——
 * 顺序与拆分前一致，断言总数一分不少。各子文件也能单独 `node src/body/<file>.js` 加那个开关跑。
 *
 * ⚠️ 本文件本身**不跑任何断言**（它只是外套），所以它没有那个开关分支 ——
 * test-all 的自动发现靠"代码里真有那个分支"来认，故意不写，别加回去。
 */

const SECTIONS = [];   // { file, label, fn }
let HANDS = {};        // 全部 hands 名字（index.js 装载完 8 个文件后塞进来）

/** 登记一批小节（模块加载时调用，不执行）；file 只为排查时知道是谁的 */
function register (file, list) {
  for (const [label, fn] of list) SECTIONS.push({ file, label, fn });
}

/** index.js 把「全部 hands 名字」的总表交给这里 —— 自测小节原来就在同一作用域，随手能取 */
function bindHands (ns) { HANDS = ns; }

/**
 * hands 的**全部源码**（拆分前就是 hands.js 一个文件）。
 *
 * 原来自测里有几处源码形状锁用 `readFileSync(__filename)` 读 hands.js 的原文，检查
 * 「某个判据只写了一处」。拆成 8 个文件后，那些判据分散在 kit/craft/containers 里，
 * __filename 已经指不到 —— 这里改成把 src/body 下的**全部** .js 拼起来读，
 * 判据的意思（"整个 hands 里只有这一处"）不变。
 */
function handsSrc () {
  const fs = require('fs');
  const path = require('path');
  const dir = __dirname;
  return fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'testkit.js' && f !== 'lazy.js')
    .sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

/** 跑一批小节：mine 传数组就跑那几节，不传就跑**全部**（汇总用） */
async function runSuite (title, mine) {
  let pass = 0, total = 0;
  const check = (label, got, expect) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(expect)}`}`);
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const { goals } = require('mineflayer-pathfinder');
  const Vec3 = require('vec3');

  /** 假 bot：startFollow 只用到 pathfinder.goal / setGoal、players、entity.position */
  const rig = () => {
    const players = {};
    const setGoalCalls = [];
    const pathfinder = { goal: null, setGoal (g) { setGoalCalls.push(g); this.goal = g; } };
    const bot = { players, pathfinder, entity: { position: { x: 0, y: 64, z: 0 } } };
    players.Ann = { entity: { position: { x: 1, y: 64, z: 0 } } };   // 同层
    players.Bob = { entity: { position: { x: 2, y: 64, z: 0 } } };
    return { bot, players, pathfinder, setGoalCalls };
  };
  // 跑真循环，但把节奏调小 —— 不用为了测"看不见人之后退出"真等 15 秒
  const TICK = { tickMs: 5, lostMs: 40 };

  /**
   * 假 bot，够 `go()` 跑到"同一层先直接走"那一步：
   * `blockAt` 一律给岩浆 → `wiggle` 会跳过所有试探方向（省掉几秒等待）；`goto` 立刻失败。
   */
  const mkGoBot = (goto) => ({
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    players: { Ann: { entity: { position: new Vec3(8, 64, 0) } } },
    registry: { blocksByName: {} },
    blockAt: () => ({ name: 'minecraft:lava', boundingBox: 'block' }),
    findBlocks: () => [],
    setControlState: () => {},
    clearControlStates: () => {},
    look: async () => {},
    pathfinder: { goal: null, setGoal () {}, goto },
  });

  const t = { check, wait, rig, mkGoBot, TICK, goals, Vec3, h: HANDS, handsSrc };
  const list = Array.isArray(mine) ? mine.map(([label, fn]) => ({ label, fn })) : SECTIONS;
  for (const s of list) await s.fn(t);
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);   // 原自测段就是这么收尾的：不留挂着的定时器/句柄
  return { pass, total };
}

module.exports = { register, runSuite, bindHands, handsSrc, SECTIONS };
