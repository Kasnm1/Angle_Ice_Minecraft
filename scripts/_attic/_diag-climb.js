// 正对梯子再爬：先看清"是不是物理层还不认"，还是"朝向/输入不对"。
const http = require('http');
function req (method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 3001, path, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    resp => { let s = ''; resp.on('data', d => { s += d; }); resp.on('end', () => {
      let j = null; try { j = JSON.parse(s); } catch (_) { return rej(new Error(s.slice(0, 200))); }
      if (j && j.success === false) return rej(new Error(j.error)); res(j); }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const p0 = (await req('GET', '/position')).exact;
  console.log('起点', JSON.stringify(p0));

  // 梯子在 (34, y, -137)。她 z=-136.5，梯子在她正北 → 看向正北、pitch 0。
  await req('POST', '/look', { x: 34.5, y: +(p0.y + 1.62).toFixed(2), z: -147 });
  let p = await req('GET', '/position');
  console.log('转正后 yaw=' + p.yaw.toFixed(1) + '° pitch=' + p.pitch.toFixed(1) + '°  (180=正北)');

  console.log('\n按住 forward+jump，每次 1200ms：');
  for (let i = 1; i <= 4; i++) {
    const r = await req('POST', '/control', { forward: true, jump: true, durationMs: 1200 });
    console.log(`  ${i}: y ${r.from.y} → ${r.to.y}   Δy=${r.moved.y}   位置 (${r.to.x}, ${r.to.y}, ${r.to.z})`);
    if (r.moved.y > 0.5) { console.log('  → 爬上去了'); break; }
    await sleep(200);
  }

  // 只按 jump（梯子上 jump 也能上爬），排除 forward 顶墙的干扰
  console.log('\n只按住 jump，每次 1200ms：');
  for (let i = 1; i <= 3; i++) {
    const r = await req('POST', '/control', { jump: true, durationMs: 1200 });
    console.log(`  ${i}: y ${r.from.y} → ${r.to.y}   Δy=${r.moved.y}`);
    if (r.moved.y > 0.5) { console.log('  → 爬上去了'); break; }
    await sleep(200);
  }
  console.log('\n结束位置', JSON.stringify((await req('GET', '/position')).exact));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
