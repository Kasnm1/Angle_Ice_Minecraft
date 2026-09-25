// 完整逃出流程：爬梯 → 自己开活板门 → 继续爬出屋顶。
// 只按 jump 爬（实测 forward+jump 无效）。
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
const pos = async () => (await req('GET', '/position')).exact;

async function climbTo (target, label) {
  console.log(`\n[${label}] 目标 y ≥ ${target}`);
  for (let i = 1; i <= 10; i++) {
    const r = await req('POST', '/control', { jump: true, durationMs: 1000 });
    console.log(`   ${i}: y ${r.from.y} → ${r.to.y}  Δy=${r.moved.y}`);
    if (r.to.y >= target) { console.log('   → 到'); return true; }
    if (r.moved.y <= 0.01) { console.log('   → 不动了'); return false; }
    await sleep(150);
  }
  return false;
}

(async () => {
  console.log('起点', JSON.stringify(await pos()));
  const TP = { x: 34, y: 78, z: -137 };
  const tpBefore = await req('GET', `/block?x=${TP.x}&y=${TP.y}&z=${TP.z}`);
  console.log(`活板门 (${TP.x},${TP.y},${TP.z}) 处理前 stateId=${tpBefore.stateId} solid=${tpBefore.solid}`);

  await climbTo(77.5, '第一段：爬到活板门下方');

  console.log('\n[开活板门] 自动选面');
  try {
    const a = await req('POST', '/activate', TP);
    console.log(`   face=${a.face}  距离=${a.distance}  stateId ${a.before.stateId} → ${a.after.stateId}  changed=${a.stateChanged}`);
  } catch (e) {
    console.log('   失败：' + e.message);
  }

  const ok = await climbTo(80, '第二段：穿过活板门出去');
  const tpAfter = await req('GET', `/block?x=${TP.x}&y=${TP.y}&z=${TP.z}`);
  console.log(`\n活板门处理后 stateId=${tpAfter.stateId} solid=${tpAfter.solid}`);
  console.log('结束位置', JSON.stringify(await pos()));
  console.log(ok ? '\n✅ 出来了' : '\n⚠️ 还没出去');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
