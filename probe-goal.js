// 独立探针：直连服务器，复现 /pickup 的 goto 序列，并在 goal_updated 上打点
'use strict';
module.paths.unshift('C:\\Users\\Kasumi\\.workbuddy-ai\\skills\\minecraft-bridge\\node_modules');
const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');

const bot = mineflayer.createBot({
  host: '139.196.98.255', port: 25565,
  username: 'Angel_ICE_probe', version: '1.20.1', auth: 'offline',
});

const goalEvents = [];
bot.on('goal_updated', (g, dyn) => {
  goalEvents.push({ goal: g ? g.constructor.name : null, dyn });
  console.log('[goal_updated] ' + (g ? g.constructor.name : 'null') + ' dynamic=' + dyn);
});
bot.on('path_stop', () => console.log('[path_stop]'));
bot.on('path_update', r => console.log('[path_update] ' + r.status + ' len=' + (r.path ? r.path.length : '?')));

bot.once('spawn', async () => {
  bot.loadPlugin(pathfinder);
  await new Promise(r => setTimeout(r, 4000));
  console.log('pos: ' + JSON.stringify(bot.entity.position));

  const drops = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position);
  console.log('drops found: ' + drops.length);
  const d = drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!d) { console.log('no drop'); bot.quit(); return; }

  console.log('target drop @ ' + JSON.stringify(d.position));
  console.log('--- 模拟 /pickup 单目标序列 ---');
  const t0 = Date.now();
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 1)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sleep-race-timeout')), 8000)),
    ]);
    console.log('GOTO OK after ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    console.log('GOTO FAIL after ' + (Date.now() - t0) + ' ms: ' + e.name + ' | ' + e.message);
  }
  console.log('--- goal 事件序列 ---');
  goalEvents.forEach((g, i) => console.log('  ' + i + '. ' + g.goal + ' dyn=' + g.dyn));
  console.log('final pos: ' + JSON.stringify(bot.entity.position));
  console.log('inv: ' + (bot.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || '(empty)'));
  bot.quit();
});

bot.on('error', e => console.log('ERR ' + e.message));
bot.on('end', () => process.exit(0));
setTimeout(() => { console.log('probe timeout'); process.exit(1); }, 60000);
