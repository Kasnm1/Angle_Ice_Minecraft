#!/usr/bin/env node
'use strict';
/**
 * bridge-boot-test.js —— 真的把 bridge 起一遍（main() → loadDependencies → createBot），但连一个没人听的端口。
 *
 * 为什么要有（2026-09-29）：第 3 步拆完 bridge 后离线测试全绿，一上 Windows 就崩 ——
 * `main()` 的启动日志用了 `BRIDGE_VERSION`，而 http.js 没绑到它（ReferenceError）。
 * require / --check / 路由快照都走不到 main()，只有真起才看得见。
 *
 * 做法：子进程 `node bridge-server.js`，MC_HOST=127.0.0.1 MC_PORT=1（一定连不上，不会碰真服务器）、
 * MC_BRIDGE_PORT 用一个空闲端口；等启动横幅 + 第一次连接尝试，调 GET /status 和 GET /config，然后杀掉。
 * 输出里出现 ReferenceError / TypeError / "is not defined" / "is not a function"、或进程提前退出，都算失败。
 *
 * 副作用：连不上时 bridge 会往 memory/journal.md 追加"我掉线了"—— 这里先记下文件长度，结束后截回去。
 * 2026-09-30 补：bridge 还会把离线快照（server 127.0.0.1:1、connected:false）整份写进 memory/state.json
 * （断线时 GET /state 回的就是这份缓存）；原来没管。journal.md 原来不存在时也没删，测完留下一个只有"掉线了"的文件。
 * 现在两份都先存下原样，结束后还原（原来没有就删掉），并断言跑完和跑之前一样。
 */
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const JOURNAL = path.join(ROOT, 'memory', 'journal.md');
const STATE = path.join(ROOT, 'memory', 'state.json');
const snap = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);   // null = 原来没有这个文件

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const get = (port, p) => new Promise(res => {
  const req = http.get({ host: '127.0.0.1', port, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b })); });
  req.on('error', e => res({ code: 0, body: e.message }));
  req.setTimeout(5000, () => { req.destroy(); res({ code: 0, body: 'timeout' }); });
});

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? ` —— ${extra}` : ''}`); } };

  const journalLen = fs.existsSync(JOURNAL) ? fs.statSync(JOURNAL).size : null;
  const stateBefore = snap(STATE);
  const port = await freePort();
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'bridge-server.js')], {
    cwd: ROOT, env: { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: '1', MC_BRIDGE_PORT: String(port) },
  });
  let out = ''; let exited = null;
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  child.on('exit', c => { exited = c; });

  const until = Date.now() + 20000;
  while (Date.now() < until && exited === null && !/Connecting to 127\.0\.0\.1:1/.test(out)) await new Promise(r => setTimeout(r, 100));
  check('启动横幅打出来了（main() 的 listen 回调跑完）', /Minecraft Bridge v\d/.test(out));
  check('走到了 createBot（开始连接）', /Connecting to 127\.0\.0\.1:1/.test(out));
  await new Promise(r => setTimeout(r, 1500));   // 让第一次连接失败、断线处理跑一遍
  check('进程没有提前退出', exited === null, exited === null ? '' : `退出码 ${exited}`);

  const st = await get(port, '/status');
  check('GET /status 回 200', st.code === 200, `${st.code} ${st.body.slice(0, 120)}`);
  const cf = await get(port, '/config');
  check('GET /config 回 200', cf.code === 200, `${cf.code} ${cf.body.slice(0, 120)}`);

  child.kill();
  await new Promise(r => setTimeout(r, 300));
  const bad = out.split('\n').filter(l => /ReferenceError|TypeError|is not defined|is not a function/.test(l));
  check('输出里没有 ReferenceError / TypeError', !bad.length, bad.slice(0, 3).join(' | '));

  // 还原真的 memory/：journal.md 截回原长（原来没有就删掉）；state.json 写回原样（原来没有就删掉）
  if (journalLen !== null) { try { fs.truncateSync(JOURNAL, journalLen); } catch (_) {} } else { try { fs.unlinkSync(JOURNAL); } catch (_) {} }
  if (stateBefore !== null) { try { fs.writeFileSync(STATE, stateBefore); } catch (_) {} } else { try { fs.unlinkSync(STATE); } catch (_) {} }
  const stateAfter = snap(STATE);
  const journalAfter = fs.existsSync(JOURNAL) ? fs.statSync(JOURNAL).size : null;
  check('跑完 memory/state.json、journal.md 和跑之前一样（不留测试痕迹）',
    journalAfter === journalLen && (stateBefore === null ? stateAfter === null : !!stateAfter && stateAfter.equals(stateBefore)),
    `journal ${journalLen}→${journalAfter}，state ${stateBefore === null ? '无' : stateBefore.length}→${stateAfter === null ? '无' : stateAfter.length}`);
  if (fail) console.log('\n--- bridge 输出（末 30 行）---\n' + out.split('\n').slice(-30).join('\n'));
  console.log(`\n  ${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
