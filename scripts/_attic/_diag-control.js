// 诊断：单独按住每个方向，看位移。用来区分"按键没生效"和"被地形挡住"。
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
(async () => {
  const st = await req('GET', '/status');
  console.log('health=' + st.health + ' food=' + st.food + ' pos=' + JSON.stringify(st.position));

  const cases = [
    ['正北 (-z)', 180], ['正南 (+z)', 0], ['正西 (-x)', 90], ['正东 (+x)', -90],
  ];
  for (const [label, yaw] of cases) {
    const p0 = (await req('GET', '/position')).exact;
    // 用 /look 朝一个水平方向的远点，保证 pitch≈0
    const rad = (yaw * Math.PI) / 180;
    const dx = -Math.sin(rad), dz = Math.cos(rad);
    await req('POST', '/look', { x: +(p0.x + dx * 10).toFixed(2), y: +(p0.y + 1.62).toFixed(2), z: +(p0.z + dz * 10).toFixed(2) });
    const r = await req('POST', '/control', { forward: true, durationMs: 1500 });
    console.log(label.padEnd(10) + ' yaw=' + String(yaw).padStart(4)
      + '  位移=(' + String(r.moved.x).padStart(6) + ',' + String(r.moved.y).padStart(5) + ',' + String(r.moved.z).padStart(6) + ')'
      + '  到=(' + r.to.x + ',' + r.to.y + ',' + r.to.z + ')');
  }

  const st2 = await req('GET', '/status');
  console.log('health=' + st2.health + ' food=' + st2.food);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
