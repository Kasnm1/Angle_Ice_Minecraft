'use strict';

/**
 * 家中仓库的安全边界。
 *
 * memory-store 住在 mind 进程，真正搬东西的 hands/instinct 住在 bridge 进程。
 * 两条调用链以前各自拼 assign/only/skip，自动整理因此绕过了主人保护的箱子。
 * 这里保持为纯函数，让两边使用同一份规则。
 */

const cleanKey = (x) => String(x ?? '').replace(/[()\s]/g, '');
const uniqueKeys = (xs) => [...new Set([].concat(xs || []).map(cleanKey).filter(Boolean))];

function normalizeStorage (home) {
  const storage = {};
  for (const [rawKey, rawCats] of Object.entries(home?.storage || {})) {
    const key = cleanKey(rawKey);
    const cats = [...new Set([].concat(rawCats || []).map(String).map(x => x.trim()).filter(Boolean))];
    if (key && cats.length) storage[key] = cats;
  }
  return {
    storage,
    registered: Object.keys(storage),
    empty: uniqueKeys(home?.emptyBoxes),
    protected: uniqueKeys(home?.protected),
  };
}

/**
 * @param home memory-store 的 home 对象（同步到 bridge 时字段相同）
 * @param request 调用者显式参数；assign/only 仍可覆盖默认值，但 protected 永远排除
 * @param discover true = 第一次人工整理允许发现附近箱子；false = 自动整理只碰已登记箱子
 */
function storageRequest (home, request = {}, { discover = false } = {}) {
  const n = normalizeStorage(home);
  const protectedSet = new Set(n.protected);
  const remembered = {};
  for (const [key, cats] of Object.entries(n.storage)) {
    if (protectedSet.has(key)) continue;
    for (const cat of cats) (remembered[cat] ||= []).push(key);
  }

  const explicitAssign = {};
  for (const [cat, rawKeys] of Object.entries(request.assign || {})) {
    const keys = uniqueKeys(rawKeys).filter(k => !protectedSet.has(k));
    if (keys.length) explicitAssign[cat] = keys;
  }
  const assign = { ...remembered, ...explicitAssign };
  const allowedKnown = uniqueKeys([...n.registered, ...n.empty]).filter(k => !protectedSet.has(k));
  const explicitOnly = request.only === undefined ? undefined : uniqueKeys(request.only).filter(k => !protectedSet.has(k));
  const only = explicitOnly !== undefined
    ? explicitOnly
    : (n.registered.length ? allowedKnown : (discover ? null : []));
  const allowed = only ? new Set(only) : null;
  for (const [cat, keys] of Object.entries(assign)) {
    assign[cat] = keys.filter(k => !allowed || allowed.has(k));
    if (!assign[cat].length) delete assign[cat];
  }

  const skip = uniqueKeys([...(request.skip || []), ...n.empty])
    .filter(k => !protectedSet.has(k) && !n.storage[k] && (!allowed || allowed.has(k)));
  return {
    ...request,
    assign,
    skip,
    only,
    // 登记箱子可能跨楼层；only 已经给出精确白名单，不再套当前楼层过滤。
    allFloors: Array.isArray(only) ? only.length > 0 : !!request.allFloors,
  };
}

function layoutFromBoxes (boxes) {
  const layout = {};
  const empty = [];
  for (const b of boxes || []) {
    const key = cleanKey(b?.at);
    if (!key) continue;
    if (Array.isArray(b.holds) && b.holds.length) layout[key] = [...new Set(b.holds.map(String))];
    else if (!b.used) empty.push(key);
  }
  return { layout, empty: uniqueKeys(empty) };
}

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`);
    if (ok) pass++; else fail++;
  };
  const home = {
    storage: { '1,64,1': ['食物'], '2,64,1': ['矿物'], '9,64,9': ['其他'] },
    emptyBoxes: ['3,64,1'], protected: ['9,64,9'],
  };
  check('自动整理只动登记箱和已知空箱，并排除 protected', storageRequest(home), {
    assign: { 食物: ['1,64,1'], 矿物: ['2,64,1'] }, skip: ['3,64,1'],
    only: ['1,64,1', '2,64,1', '3,64,1'], allFloors: true,
  });
  check('第一次自动整理没有登记箱 → 空白名单，不扫描旁边柜子', storageRequest({ storage: {} }).only, []);
  check('第一次人工整理允许发现附近箱子', storageRequest({ storage: {} }, {}, { discover: true }).only, null);
  check('显式 only/assign 也不能越过 protected', storageRequest(home, { only: ['9,64,9', '2,64,1'], assign: { 其他: ['9,64,9'], 矿物: ['2,64,1'] } }), {
    only: ['2,64,1'], assign: { 矿物: ['2,64,1'] }, skip: [], allFloors: true,
  });
  check('结果布局和空箱分开', layoutFromBoxes([
    { at: '1,64,1', holds: ['食物'], used: 2 }, { at: '3,64,1', holds: [], used: 0 },
  ]), { layout: { '1,64,1': ['食物'] }, empty: ['3,64,1'] });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { cleanKey, normalizeStorage, storageRequest, layoutFromBoxes };
