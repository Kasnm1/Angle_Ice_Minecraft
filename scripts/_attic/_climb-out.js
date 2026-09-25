// 只用 jump 上爬 —— 实测 forward+jump 反而 Δy=0（梯子上水平输入会被阻尼/顶墙）。
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
  const target = Number(process.argv[2] ?? 80);
  console.log('起点', JSON.stringify((await req('GET', '/position')).exact), '目标 y ≥', target);
  for (let i = 1; i <= 12; i++) {
    const r = await req('POST', '/control', { jump: true, durationMs: 1000 });
    console.log(`  ${i}: y ${r.from.y} → ${r.to.y}   Δy=${r.moved.y}   位置 (${r.to.x}, ${r.to.y}, ${r.to.z})`);
    if (r.to.y >= target) { console.log('  → 到顶了'); break; }
    if (r.moved.y <= 0) { console.log('  → 不动了，停'); break; }
    await sleep(150);
  }
  const st = await req('GET', '/status');
  console.log('\n结束位置', JSON.stringify((await req('GET', '/position')).exact), 'isDay=' + st.isDay);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
