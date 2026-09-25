// 一次性侦察脚本：读一列方块，用来确认梯子竖井的真实几何。
// 用完可删。
const http = require('http');

function get (path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 3001, path, agent: false }, r => {
      let s = '';
      r.on('data', d => { s += d; });
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 200))); } });
    }).on('error', rej);
  });
}

(async () => {
  const pos = await get('/position');
  console.log('pos exact =', JSON.stringify(pos.exact));
  const x = Number(process.argv[2] ?? 34);
  const z = Number(process.argv[3] ?? -137);
  const y1 = Number(process.argv[4] ?? 60);
  const y2 = Number(process.argv[5] ?? 80);
  console.log('列扫描 x=' + x + ' z=' + z + '  y=' + y1 + '..' + y2);
  for (let y = y1; y <= y2; y++) {
    const b = await get('/block?x=' + x + '&y=' + y + '&z=' + z);
    const sid = String(b.stateId).padStart(7);
    console.log('  y=' + String(y).padStart(3) + '  stateId=' + sid + '  solid=' + b.solid + '  name=' + JSON.stringify(b.block));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
