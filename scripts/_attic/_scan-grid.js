// 按显式坐标打印一层网格 —— 不依赖 map-blocks.py 的列对齐，用来交叉验证。
// 用法：node scripts/_scan-grid.js <y> <x1> <x2> <z1> <z2>
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
  const [y, x1, x2, z1, z2] = process.argv.slice(2).map(Number);
  const cells = {};
  const names = {};
  for (let z = z1; z <= z2; z++) {
    for (let x = x1; x <= x2; x++) {
      const b = await get('/block?x=' + x + '&y=' + y + '&z=' + z);
      const key = x + ',' + z;
      cells[key] = b;
      const n = b.block === '' ? '<无名>' : b.block;
      names[n] = (names[n] || 0) + 1;
    }
  }
  // 表头：每列一个 x 的个位数
  let hdr = '     ';
  for (let x = x1; x <= x2; x++) hdr += String(Math.abs(x) % 10);
  console.log('y=' + y + '   范围 x[' + x1 + ',' + x2 + '] z[' + z1 + ',' + z2 + ']');
  console.log(hdr);
  for (let z = z1; z <= z2; z++) {
    let row = String(z).padStart(5);
    for (let x = x1; x <= x2; x++) {
      const b = cells[x + ',' + z];
      // 图例： # 实心 / o 有名字且可穿过 / ? 无名且非实心 / . 空气
      let ch;
      if (b.solid) ch = '#';
      else if (b.block === '') ch = '?';
      else if (b.block === 'air' || b.block === 'cave_air' || b.block === 'void_air') ch = '.';
      else ch = 'o';
      row += ch;
    }
    console.log(row);
  }
  console.log('\nstateId 明细（非空气的）：');
  for (let z = z1; z <= z2; z++) {
    for (let x = x1; x <= x2; x++) {
      const b = cells[x + ',' + z];
      if (b.block === 'air') continue;
      console.log('  (' + x + ',' + y + ',' + z + ')  stateId=' + String(b.stateId).padStart(7)
        + '  solid=' + String(b.solid).padEnd(5) + '  ' + JSON.stringify(b.block));
    }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
