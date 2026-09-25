#!/usr/bin/env node
/**
 * mc-ping.js —— 直接对 Minecraft 服务器做一次「服务器列表 ping」。
 *
 * 为什么需要它：`netstat` 显示 25565 在 LISTENING、TCP 也能连上，**但这只证明
 * SSH 客户端在本地接受了连接**，完全不证明转发到了远端。真正要回答的是
 * "远端服务器还活着吗" —— 那就必须说 Minecraft 协议，看有没有 Status Response。
 *
 * 用法：
 *   node scripts/mc-ping.js                       # 默认 127.0.0.1:25565
 *   node scripts/mc-ping.js <host> <port> <ms>
 *
 * 退出码：0 = 有应答，1 = 超时/出错/被关闭（并说明卡在哪一步）。
 *
 * ## 四种结局，含义完全不同（对着 `-L` 转发读）
 *
 * | 输出 | 含义 |
 * |---|---|
 * | `✓ 远端有应答！` | 隧道 + 服务端都正常 |
 * | `✗ 卡在「发送握手…」无响应` | 本地接受了连接，但**远端没有应答** —— 隧道僵尸，或服务端进程活着却不处理协议 |
 * | `✗ 连上后被对端关闭，全程 0 字节` | **隧道健康、在正常转发**，但目标端口没人听（或协议不匹配） |
 * | `✗ ECONNREFUSED` | 本地根本没人监听 —— 隧道进程没起 |
 *
 * ⚠️ 中间两行是最容易读反的：「被关闭」比「无响应」**更接近正常**。
 *    以前本脚本没有 close 处理，被关闭时会静默退出（退出码 0、无输出），
 *    把"远端没人听"伪装成"什么都没发生" —— 2026-09-23 诊断时真被误导过。
 */
const net = require('net');

function wVarint (n) {
  n >>>= 0;
  const o = [];
  for (;;) {
    let t = n & 0x7f;
    n >>>= 7;
    if (n) t |= 0x80;
    o.push(t);
    if (!n) break;
  }
  return Buffer.from(o);
}
function wStr (s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([wVarint(b.length), b]);
}
function rVarint (buf, off) {
  let v = 0; let sh = 0; let b;
  do {
    if (off + sh >= buf.length) return null;
    b = buf[off + sh];
    v |= (b & 0x7f) << sh;
    sh++;
    if (sh > 5) return null;
  } while (b & 0x80);
  return { v: v >>> 0, size: sh };
}

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 25565);
const ms = Number(process.argv[4] || 8000);

const sock = net.connect({ host, port });
let phase = 'TCP 连接';
let done = false;
let connected = false;
let gotBytes = 0;
const t0 = Date.now();

function finish (code, msg) {
  if (done) return;
  done = true;
  console.log(msg);
  try { sock.destroy(); } catch (_) {}
  process.exit(code);
}

sock.setTimeout(ms);
sock.on('timeout', () => finish(1, `✗ 卡在「${phase}」，${ms}ms 无响应 —— 本地接受了连接，但远端没有应答`));
sock.on('error', (e) => finish(1, `✗ 「${phase}」出错：${e.code || e.message}（${Date.now() - t0}ms）`));

// ⚠️ 必须有 close 处理。
//    没有它的话，对端**主动关闭**连接时事件循环空掉、进程静默退出、退出码 0 ——
//    调用方拿到"成功且无输出"，会把"远端没人听这个端口"误读成"什么都没发生"。
//    这正是 2026-09-23 诊断隧道时踩到的坑：23333/24444 静默退出，
//    差点被当成"隧道也坏了"，而真相恰恰相反 —— **对端关闭说明隧道在正常转发**。
//    对 `-L` 转发来说，「连上又被立刻关掉」= 隧道健康、远端目标端口没人听。
sock.on('close', () => {
  const ms2 = Date.now() - t0;
  if (!connected) {
    finish(1, `✗ TCP 未能建立就被关闭（${ms2}ms）`);
  } else if (gotBytes === 0) {
    finish(1, `✗ 连上后被对端关闭，全程 0 字节（${ms2}ms）`
      + ' —— 隧道在转发，但目标端口没人应答（服务没起 / 协议不匹配）');
  } else {
    // 有字节但不是完整的 Minecraft 包 —— 最可能是"这个端口根本不是 MC"
    finish(1, `✗ 连上后收到 ${gotBytes} 字节，但不是 Minecraft 响应（${ms2}ms）\n`
      + `   ${describeRaw(buf)}`);
  }
});

/**
 * 把"不是 Minecraft 包的那堆字节"翻译成人看得懂的一句话。
 *
 * 为什么值得写：这条隧道后面挂了不止一个服务。2026-09-23 实测 23333/24444 返回的是
 * `HTTP/1.1 400 Bad Request`（因为我们发的是 MC 握手、不是 HTTP 请求）——
 * 这恰好是**隧道健康、远端服务活着**的证据。旧版只会说"响应不完整"，
 * 把一条能定性整条链路的线索浪费掉了。
 */
function describeRaw (b) {
  const head = b.subarray(0, 120).toString('latin1');
  if (/^HTTP\/\d/.test(head)) {
    const first = head.split('\r\n')[0];
    return `看起来是个 HTTP 服务（"${first}"）—— 端口转发正常，但这个端口不是 Minecraft。`
      + '这其实说明**隧道是好的**。';
  }
  const printable = [...b.subarray(0, 40)].every(c => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
  return printable
    ? `原始字节(ascii): ${JSON.stringify(head)}`
    : `原始字节(hex): ${b.subarray(0, 40).toString('hex')}`;
}

sock.on('connect', () => {
  connected = true;
  phase = '发送握手 + 状态请求';
  // 握手：packetId=0, protocolVersion=763(1.20.1), address, port, nextState=1(status)
  const hs = Buffer.concat([
    wVarint(0), wVarint(763), wStr(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]), wVarint(1),
  ]);
  const req = Buffer.concat([wVarint(0), wVarint(1), wVarint(0)]);
  sock.write(Buffer.concat([
    Buffer.concat([wVarint(hs.length), hs]),
    Buffer.concat([wVarint(req.length), req]),
  ]));
});

let buf = Buffer.alloc(0);
sock.on('data', (d) => {
  gotBytes += d.length;
  buf = Buffer.concat([buf, d]);
  const len = rVarint(buf, 0);
  if (!len || buf.length < len.size + len.v) return;
  const body = buf.subarray(len.size, len.size + len.v);
  const pid = rVarint(body, 0);
  if (!pid) return;
  let off = pid.size;
  if (body[off] === 0xff) {
    // Disconnect/Kick：JSON 字符串
    const l = rVarint(body, off + 1);
    if (l) finish(0, '服务器主动断开：' + body.toString('utf8', off + 1 + l.size, off + 1 + l.size + l.v));
    return;
  }
  const sl = rVarint(body, off);
  if (!sl) return;
  const json = body.toString('utf8', off + sl.size, off + sl.size + sl.v);
  const lines = [`✓ 远端有应答！耗时 ${Date.now() - t0}ms`];
  try {
    const j = JSON.parse(json);
    if (j.version) lines.push(`  version: ${j.version.name} (protocol ${j.version.protocol})`);
    if (j.players) lines.push(`  players: ${j.players.online}/${j.players.max}`);
    lines.push('  motd: ' + JSON.stringify(j.description).slice(0, 300));
  } catch (_) {
    lines.push('  原始响应: ' + json.slice(0, 400));
  }
  finish(0, lines.join('\n'));
});
