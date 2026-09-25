// 扫一个长方体区域，按 **stateId** 汇总（不是按名字）。
//
// 为什么按 stateId 汇总：名字是我们自己用原版表翻译的，模组方块一律翻成空字符串，
// 所以"按名字看结构"对模组方块完全无效。stateId 是服务端真值，永远可信。
//
// 用法：node scripts/_scan-box.js x1 x2 y1 y2 z1 z2
const http = require('http');
const mcData = require('minecraft-data')('1.20.1');

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
  const [x1, x2, y1, y2, z1, z2] = process.argv.slice(2).map(Number);
  const byState = new Map();
  let n = 0;
  for (let y = y1; y <= y2; y++) {
    for (let z = z1; z <= z2; z++) {
      for (let x = x1; x <= x2; x++) {
        const b = await get(`/block?x=${x}&y=${y}&z=${z}`);
        n++;
        const sid = b.stateId;
        const air = sid === 0;
        if (air) continue;
        if (!byState.has(sid)) byState.set(sid, { sid, vanilla: b.block || null, solid: b.solid, hits: [] });
        const e = byState.get(sid);
        if (e.hits.length < 6) e.hits.push(`${x},${y},${z}`);
      }
    }
  }
  console.log(`扫了 ${n} 格，非空气的 stateId 共 ${byState.size} 种\n`);
  const rows = [...byState.values()].sort((a, b) => a.sid - b.sid);
  console.log('stateId   原版解释(不可信)              实心  出现位置');
  for (const r of rows) {
    const v = mcData.blocksByStateId[r.sid];
    const tag = r.vanilla || (v ? `(原版表: ${v.name})` : '（模组方块，名字未知）');
    console.log(String(r.sid).padStart(8), String(tag).padEnd(30), String(r.solid).padEnd(6), r.hits.join(' '));
  }

  // 特别标注：原版 ladder 的 state 区间是 4654..4661
  const lad = mcData.blocksByName['ladder'];
  const ladderHits = rows.filter(r => r.sid >= lad.minStateId && r.sid <= lad.maxStateId);
  console.log('\n▶ 原版 ladder 区间 ' + lad.minStateId + '..' + lad.maxStateId + '：'
    + (ladderHits.length ? `命中 ${ladderHits.length} 种 stateId → ${ladderHits.map(r => r.hits[0]).join(' ')}` : '没有命中'));
})();
