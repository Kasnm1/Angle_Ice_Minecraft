#!/usr/bin/env node
/**
 * 闭环走位（原始控制层）。
 *
 * 为什么需要这个脚本：`POST /control` 只负责"按住某个键一小段"，它**不会自己横向对齐** ——
 * 按住 W 是笔直往前，偏了就一直偏。穿一格宽的缝（本包：`warped_door` + 梯子 + `warped_door`）
 * 必须靠"看一眼差多少 → 转过去 → 走一小步 → 再看"的外层循环。
 *
 * 两条铁律：
 *   1. **必须读 `/position` 的 `exact`**。原 `x/y/z` 是取整的，走半格会被读成 0，
 *      于是"没动"和"动了半格"分不开，循环永远不收敛。
 *   2. **必须能如实承认走不到**。连续 `--stall` 次位移小于 `--eps` 就退出并报 `stalledAt`，
 *      而不是无限按下去。
 *
 * 用法：
 *   node scripts/walk-to.js --x 34 --z -137 [--tol 0.35] [--max 25] [--stall 4] [--port 3001]
 *
 * 退出码：0 = 到位；1 = 走不到（stalled）或出错。
 */
const http = require('http');

function arg (name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const PORT = Number(arg('port', 3001));
const TX = Number(arg('x'));
const TZ = Number(arg('z'));
const TOL = Number(arg('tol', 0.35));
const MAX_ITER = Number(arg('max', 25));
const STALL_LIMIT = Number(arg('stall', 4));
const EPS = Number(arg('eps', 0.08));
// 实测速度：按住 W 两秒走 6.4 格 ≈ 3.2 格/秒。用它把"还差多远"换算成"按多久"。
const BLOCKS_PER_SEC = Number(arg('speed', 3.2));
const MAX_PRESS_MS = Number(arg('pressMax', 700));

if (!Number.isFinite(TX) || !Number.isFinite(TZ)) {
  console.error('需要 --x 和 --z');
  process.exit(1);
}

function req (method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, resp => {
      let s = '';
      resp.on('data', d => { s += d; });
      resp.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (_) { return rej(new Error('bad json: ' + s.slice(0, 200))); }
        if (j && j.success === false) return rej(new Error(j.error || 'unknown error'));
        res(j);
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

(async () => {
  const start = (await req('GET', '/position')).exact;
  console.log(`起点 (${start.x}, ${start.y}, ${start.z}) → 目标 (${TX}, ${TZ})  容差 ${TOL}`);

  let prev = start;
  let stalls = 0;
  let last = start;

  for (let i = 1; i <= MAX_ITER; i++) {
    const p = (await req('GET', '/position')).exact;
    last = p;
    const d = dist(p, { x: TX, z: TZ });

    if (d <= TOL) {
      console.log(`第 ${i - 1} 步到位：(${p.x}, ${p.y}, ${p.z})，离目标 ${d.toFixed(2)} 格`);
      process.exit(0);
    }

    // 站着别动也会"没位移" —— 先判是不是真的卡住了
    const movedSince = dist(p, prev);
    if (movedSince < EPS) {
      stalls++;
      if (stalls >= STALL_LIMIT) {
        console.log(`走不到：连续 ${stalls} 次位移 < ${EPS}，停在 (${p.x}, ${p.y}, ${p.z})，还差 ${d.toFixed(2)} 格`);
        process.exit(1);
      }
    } else {
      stalls = 0;
    }
    prev = p;

    // 视线水平朝向目标：y 取眼睛高度，这样 pitch≈0。
    // ⚠️ pitch 不是移动轴，但仰着/俯着走会被地形吃掉位移（踩过一次：pitch +36° 时按 W 零位移）。
    await req('POST', '/look', { x: TX, y: +(p.y + 1.6).toFixed(2), z: TZ });

    const ms = Math.min(Math.max(Math.round((d / BLOCKS_PER_SEC) * 1000), 120), MAX_PRESS_MS);
    const r = await req('POST', '/control', { forward: true, durationMs: ms });
    console.log(`第 ${i} 步：离目标 ${d.toFixed(2)} 格，按住 W ${ms}ms → 位移 `
      + `(${r.moved.x}, ${r.moved.y}, ${r.moved.z})，现在 (${r.to.x}, ${r.to.y}, ${r.to.z})`);
  }

  console.log(`用完 ${MAX_ITER} 步仍未到位，停在 (${last.x}, ${last.y}, ${last.z})，还差 ${dist(last, { x: TX, z: TZ }).toFixed(2)} 格`);
  process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
