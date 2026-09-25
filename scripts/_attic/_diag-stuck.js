// 诊断二：她能跳吗？能换位吗？用来区分"身体冻住"和"控制层没生效"。
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
  const before = (await req('GET', '/position')).exact;
  console.log('起始 =', JSON.stringify(before));

  // 她脚下 / 身上 / 头顶三格的方块
  for (const dy of [-1, 0, 1]) {
    const b = await req('GET', '/block?x=' + Math.floor(before.x) + '&y=' + (before.y + dy) + '&z=' + Math.floor(before.z));
    console.log(`  dy=${dy}  stateId=${String(b.stateId).padStart(7)}  solid=${b.solid}  ${JSON.stringify(b.block)}`);
  }

  console.log('\n[1] 按住 jump 1000ms');
  let r = await req('POST', '/control', { jump: true, durationMs: 1000 });
  console.log('    moved =', JSON.stringify(r.moved), ' to =', JSON.stringify(r.to));

  console.log('\n[2] POST /stop（清控制位）后再试 forward 1500ms');
  await req('POST', '/stop');
  r = await req('POST', '/control', { forward: true, durationMs: 1500 });
  console.log('    moved =', JSON.stringify(r.moved), ' to =', JSON.stringify(r.to));

  console.log('\n[3] 交给寻路器：/move 到 5 格外 (35,74,-130)');
  try {
    const m = await req('POST', '/move', { x: 35, y: 74, z: -130 });
    console.log('    寻路结果 =', JSON.stringify(m.arrived));
  } catch (e) {
    console.log('    寻路失败 =', e.message);
    console.log('    现在位置 =', JSON.stringify((await req('GET', '/position')).exact));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
