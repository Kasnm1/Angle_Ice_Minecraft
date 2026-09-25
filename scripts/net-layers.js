#!/usr/bin/env node
/**
 * 分层连通性探测 —— 用来区分「本地端口 OPEN」「网络可达」「服务真的应答」。
 *
 * ## ⚠️ 这个脚本**不能**单独定性隧道，读它的输出前先看这段
 *
 * 它只做「连上 + 等 2.5s 看有没有字节主动过来」。而**请求-响应型服务
 * （Minecraft、HTTP、数据库…）不问你就不说话**，所以「连上但 0 字节」是**正常的**，
 * 不是故障证据。
 *
 * 2026-09-23 真踩过：拿这个脚本对 `-L` 转发的三个端口各测一次，全是
 * 「连上、0 字节」，于是判成「SSH 会话僵尸」。**错。** 用真协议再测一次就翻案了：
 * 23333/24444 立刻回了 `HTTP/1.1 400 Bad Request`（47 字节）——
 * 隧道在正常转发、远端服务活着，反倒是"0 字节"那一步什么都没证明。
 *
 * 正确姿势：
 *   1. 本脚本 → 判断**网络层**（能不能连、有没有外网）
 *   2. `node scripts/mc-ping.js <host> <port>` → 发真握手，才是**服务层**的判据
 *   3. `netstat -ano | grep :25565` + 进程命令行 → 确认是谁在监听
 *
 * 用法：
 *   node scripts/net-layers.js                 # 默认探 MC 端口 + 常见公网锚点
 *   node scripts/net-layers.js 25565 23333     # 只探指定端口
 *   node scripts/net-layers.js --host 127.0.0.1
 */
const net = require('net');

const argv = process.argv.slice(2);
let host = '127.0.0.1';
const ports = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--host') { host = argv[++i]; continue; }
  const n = Number(argv[i]);
  if (Number.isInteger(n)) ports.push(n);
}
const localPorts = ports.length ? ports : [25565, 23333, 24444];

// 公网锚点：用来判断"到底有没有外网"
const publicAnchors = [
  { host: '223.5.5.5', port: 53, label: '阿里 DNS' },
  { host: '119.29.29.29', port: 53, label: 'DNSPod' },
];

const WAIT_MS = 2500;

function probeTcp (h, p, label) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let bytes = 0;
    let connectMs = null;
    const s = net.connect({ host: h, port: p });
    const done = (verdict, extra = '') => {
      try { s.destroy(); } catch (_) {}
      resolve({ label, target: `${h}:${p}`, verdict, connectMs, bytes, extra });
    };
    s.on('connect', () => {
      connectMs = Date.now() - t0;
      s.setTimeout(WAIT_MS);
    });
    s.on('data', d => { bytes += d.length; });
    s.on('timeout', () => done(bytes > 0 ? 'banner' : 'accept-no-data'));
    s.on('error', e => done('error', e.code || e.message));
    s.on('close', () => {
      if (connectMs !== null && bytes === 0) done('closed-empty');
    });
    setTimeout(() => { if (connectMs === null) done('timeout'); }, WAIT_MS + 500);
  });
}

(async () => {
  console.log(`本机 ${host} 的转发端口`);
  for (const p of localPorts) {
    const r = await probeTcp(host, p, `端口 ${p}`);
    const tag = r.verdict === 'error' ? `✗ ${r.extra}`
      : r.verdict === 'timeout' ? '✗ 连接超时（本地没人监听？）'
        : r.verdict === 'closed-empty' ? '⚠ 连上又被立刻关掉（0 字节）—— 隧道在转发，但目标端口没人听'
          : r.verdict === 'banner' ? `✓ 主动发了 ${r.bytes} 字节（有服务在，且会说话）`
            : `✓ TCP 连上（${WAIT_MS}ms 内无字节，**这是正常的**，请求-响应型服务不问你就不说话）`;
    console.log(`  ${r.target.padEnd(22)} ${String(r.connectMs).padStart(5)}ms  ${tag}`);
  }

  console.log('\n公网锚点（判断有没有真外网）');
  for (const a of publicAnchors) {
    const r = await probeTcp(a.host, a.port, a.label);
    console.log(`  ${r.target.padEnd(22)} ${String(r.connectMs).padStart(5)}ms  ${r.verdict === 'error' ? '✗ ' + r.extra : '✓ 可达'}`);
  }

  console.log('\n判读（⚠️ 本脚本只到网络层，别用它给服务定性）：');
  console.log('  · 本地端口「连上又被立刻关掉」→ 隧道在转发，但远端目标端口没人听');
  console.log('  · 本地端口 ECONNREFUSED       → 隧道进程没起（本地没人监听）');
  console.log('  · 本地端口「连上、无字节」     → **什么都说明不了**，继续下一步');
  console.log('  · 公网锚点不可达              → 网络层问题（代理挂了 / Captive Portal 劫持），先修网络');
  console.log('');
  console.log('  下一步（服务层判据，必须做）：');
  console.log('    node scripts/mc-ping.js <host> <port>');
  console.log('  它会发真正的 Minecraft 握手，并按「有应答 / 无响应 / 被关闭 / 不是 MC」分开报。');
  console.log('  对照：若另一个端口能回非 MC 的字节（比如 HTTP 400），说明隧道是好的，');
  console.log('        问题在那个端口后面的服务，不在隧道。');
})();
