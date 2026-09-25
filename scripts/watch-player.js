#!/usr/bin/env node
/**
 * watch-player.js —— 守着玩家上线，可选打招呼 / 跟随。
 *
 * ⚠️ 这个脚本已经被 `autopilot.js` 覆盖（autopilot 有跟随、战斗、自保、任务队列
 *    和完整的说话纪律）。除非你只想要"玩家一上线就跑起来"这一个最小动作，
 *    否则请用 `node autopilot.js`。
 *
 * 用法：
 *   node scripts/watch-player.js                    # 任意玩家上线 → 默默跟过去（不说话）
 *   node scripts/watch-player.js Ka_sum1            # 只盯 Ka_sum1
 *   node scripts/watch-player.js Ka_sum1 --greet    # 上线时打一声招呼（默认不说）
 *   node scripts/watch-player.js --interval=10      # 每 10 秒检查一次（默认 15）
 *
 * 环境变量：
 *   MC_BRIDGE_PORT   bridge 端口（默认 3001）
 *   GREETING         招呼语；设了就自动开启打招呼，不用再加 --greet
 *
 * ⚠️ 默认**不打招呼**。玩家上线时她只用身体表达（转头看他、跟过去）。
 *    理由见 PERSONA.md 的「她是陪玩，不是老师」—— 没人问的时候少开口。
 *    确实想要问候语，就显式加 --greet。
 *
 * 只依赖 Node 内置 http，不需要装任何包。Ctrl-C 退出。
 *
 * 注意：mineflayer 只有在玩家实体进入客户端视野后才知道其坐标，
 * 所以"跟随"在玩家离得远时会先失败，等靠近后会自动重试。
 */

'use strict';

const http = require('http');

const argv = process.argv.slice(2);
const wantFollow = !argv.includes('--no-follow'); // 跟随默认开
const intervalArg = argv.find(a => a.startsWith('--interval='));
const INTERVAL = Math.max(5, intervalArg ? parseInt(intervalArg.split('=')[1]) || 15 : 15) * 1000;
const target = argv.find(a => !a.startsWith('--')) || null;

const PORT = parseInt(process.env.MC_BRIDGE_PORT || '3001');
// 默认不打招呼。给了 GREETING 或 --greet 才开口。
const GREETING = process.env.GREETING || null;
const wantGreet = Boolean(GREETING) || argv.includes('--greet');
const GREETING_TEXT = GREETING || '诶诶你来啦～我等你好久了啦！';

function api (method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf));
        } catch (_) {
          reject(new Error(`bad response: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function stamp () {
  return new Date().toTimeString().slice(0, 8);
}

async function main () {
  let st;
  try {
    st = await api('GET', '/status');
  } catch (e) {
    console.error(`[watch] bridge 不可达 (127.0.0.1:${PORT}): ${e.message}`);
    console.error('[watch] 先启动 bridge-server.js');
    process.exit(1);
  }
  if (!st.connected) {
    console.error('[watch] bridge 在线，但机器人还没进服务器（connected=false）');
    process.exit(1);
  }

  console.log(`[watch] ${stamp()} bridge OK · 机器人=${st.username} · 目标=${target || '任意玩家'} · 每 ${INTERVAL / 1000}s 检查`);
  console.log(`[watch] 跟随 ${wantFollow ? '开' : '关'} · 打招呼 ${wantGreet ? '开' : '关（默认：只用身体表达）'}`);

  let greeted = null;   // 当前已打过招呼的玩家名
  let followOk = false;

  for (;;) {
    try {
      const { players } = await api('GET', '/players');
      const others = players.filter(p => !p.isSelf && (!target || p.username === target));

      if (others.length) {
        const p = others[0];

        if (greeted !== p.username) {
          greeted = p.username;
          followOk = false;
          const where = p.position ? `距离 ${p.distance}` : '不在视野内';
          console.log(`[watch] ${stamp()} ${p.username} 上线了（${where}）`);

          if (wantGreet) {
            await api('POST', '/chat', { message: `${p.username} ${GREETING_TEXT}` });
            console.log(`[watch] ${stamp()} 已打招呼`);
          } else {
            // 不说话也要表示"我注意到你了" —— 转头看他
            await api('POST', '/look', { playerName: p.username }).catch(() => {});
            console.log(`[watch] ${stamp()} 看到他啦（不说话，转个头）`);
          }

          await api('POST', '/memory', {
            text: wantGreet
              ? `${p.username} 上线了，我跟他说"${GREETING_TEXT}"（${where}）`
              : `${p.username} 上线了（${where}），我没出声，就是转过去看了看他`,
            type: 'greeting',
          }).catch(() => {});
        }

        if (wantFollow && !followOk && p.position) {
          const r = await api('POST', '/follow', { playerName: p.username });
          if (r.success) {
            followOk = true;
            console.log(`[watch] ${stamp()} 开始跟随 ${p.username}`);
          } else {
            console.log(`[watch] ${stamp()} 跟随失败: ${r.error}`);
          }
        }
      } else if (greeted) {
        console.log(`[watch] ${stamp()} ${greeted} 离线了，继续等待`);
        greeted = null;
        followOk = false;
        if (wantFollow) await api('POST', '/stop').catch(() => {});
      }
    } catch (e) {
      console.error(`[watch] ${stamp()} 轮询出错: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

main();
