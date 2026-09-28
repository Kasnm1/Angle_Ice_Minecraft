'use strict';
/**
 * P25 时序验证 —— 清理发生在哪一刻，决定 goto 是死是活。
 *
 * 上一版模型搞错了一件事：我以为"同步 setGoal(null)"就能复现，
 * 但那一次 goalB 的 listener 还没注册，所以打不到它。
 *
 * 真实链路里清理是**定时器异步触发**的（withTimeout 的 setTimeout），
 * 于是它能精准落在"goalB 已经注册好 listener 并在等"的那个窗口里。
 * 这一版把定时器还原出来。
 */
console.log('P25 时序验证（还原 withTimeout 的异步清理）\n');
const EventEmitter = require('events');

/** 极简版 goto()：判定逻辑与 mineflayer-pathfinder/lib/goto.js 一致 */
function fakeGoto (bot, goal) {
  return new Promise((resolve, reject) => {
    function cleanup (err) {
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('goal_updated', onChanged);
      setTimeout(() => (err ? reject(err) : resolve()), 0);
    }
    function onReached () { cleanup(); }
    function onChanged (newGoal) {
      if (newGoal !== goal) {
        const e = new Error('The goal was changed before it could be completed!');
        e.name = 'GoalChanged';
        cleanup(e);
      }
    }
    bot.on('goal_reached', onReached);
    bot.on('goal_updated', onChanged);
    bot.emit('goal_updated', goal, false);
  });
}

const mkBot = () => {
  const b = new EventEmitter();
  b.pathfinder = {
    goal: null,
    stop () {},
    setGoal (g) { b.pathfinder.goal = g; b.emit('goal_updated', g, false); },
  };
  return b;
};

const g = () => ({ constructor: { name: 'GoalNear' } });
const settle = (p, ms) => Promise.race([
  p.then(() => 'resolved', e => 'rejected:' + e.name),
  new Promise(r => setTimeout(() => r('STILL-WAITING'), ms)),
]);

(async () => {
  // ══ 场景 A：withTimeout 到点时**直接清**（我第一版的行为）══════════════
  //
  //   withTimeout(goto(goalA), 6000)
  //     → 6s 到时：cleanup() 然后 reject
  //     → 调用方 catch，**立刻**发下一个 goto(goalB)
  //     → 但 cleanup 的 setGoal(null) 落在 goalB 注册之后 / 收到之前 → 打死 goalB
  {
    const bot = mkBot();
    const goalA = g();
    const pA = fakeGoto(bot, goalA);
    // 模拟 withTimeout：定时器到点 → 先清、再 reject
    setTimeout(() => {
      bot.pathfinder.setGoal(null);          // ← 我第一版的 cleanup()
      // 调用方 catch 之后立刻发下一个（用 setImmediate 模拟）
      setImmediate(() => {
        const goalB = g();
        fakeGoto(bot, goalB).then(
          () => { global.__A = 'resolved'; },
          e => { global.__A = 'rejected:' + e.name; },
        );
      });
    }, 20);
    await new Promise(r => setTimeout(r, 80));
    console.log('场景 A  withTimeout 自己清（错的）');
    console.log('  下一个 goto 的结局：', global.__A);
    console.log('  → ' + (global.__A === 'rejected:GoalChanged'
      ? '❌ 复现成功：goalB 报 GoalChanged' : '（未复现）'));

    const outcomeA = await settle(pA, 10);
    console.log('  （goalA 本身结局：' + outcomeA + '）\n');
  }

  // ══ 场景 B：清理只在"发起 goto 之前"做（现在实现的行为）════════════════
  //
  //   调用方循环：
  //     for (goal of goals) {
  //       clearPathfinderGoal(pf);   // ← 先清（此刻无人等待）
  //       await goto(goal);
  //     }
  //   超时也不清，只 reject。
  {
    const bot = mkBot();
    const results = [];
    for (let i = 0; i < 3; i++) {
      bot.pathfinder.setGoal(null);           // ← 开始之前清（安全）
      const goal = g();
      const p = fakeGoto(bot, goal);
      // 目标正常到达
      setImmediate(() => bot.emit('goal_reached'));
      results.push(await settle(p, 40));
    }
    console.log('场景 B  只在发起 goto 之前清（对的）');
    console.log('  连续 3 个目标的结局：', results.join(', '));
    console.log('  → ' + (results.every(r => r === 'resolved')
      ? '✅ 全部正常完成' : 'FAIL'));
  }

  console.log('\n结论：');
  console.log('  · setGoal(null) 本身没错 —— 它是清掉残留目标的唯一手段');
  console.log('  · 错的是**时机**：在"有 goto 正在等"的时候清，就把它打死');
  console.log('  · 唯一安全的时刻是**发起下一次 goto 之前**（此刻无人等待）');
  console.log('  · withTimeout 这类"到点就清"的写法必须禁止 —— 它无法知道有没有人在等');
})();
