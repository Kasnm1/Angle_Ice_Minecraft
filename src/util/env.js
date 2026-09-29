'use strict';

/**
 * env.js —— 环境变量读布尔（第 4 步去重，2026-09-29）。
 *
 * ## 为什么要抽出来（`docs/REFACTOR-PLAN-20260928.md` 第 4 步）
 *
 * 同一个「`env` 字符串 → 布尔」的判断，项目里写了三派写法，散在 ~40 处：
 *
 *   A 派 `X !== 'false'`   —— 默认**开**，只有字面 `"false"` 才关（空串、`0`、`no` 都是开）
 *       `src/instinct/config.js` 22 处、`src/world/pathing/unknown-blocks.js:44,99`
 *   B 派 `X === 'true'`    —— 默认**关**，只有字面 `"true"` 才开
 *       `src/instinct/config.js:199,210,219`、`src/world/pathing/movements.js:154`
 *   C 派 `X === '1'`       —— 默认**关**，只有字面 `"1"` 才开
 *       `src/world/fml-handshake.js:274`
 *
 * ## 为什么不统一成一种语义（**这是本模块的关键约束**）
 *
 * 三派的**真值表不一样**，直接统一会**改行为**：
 *
 *   | 原始值       | A `!== 'false'` (默认开) | B `=== 'true'` (默认关) | C `=== '1'` (默认关) |
 *   |--------------|--------------------------|-------------------------|----------------------|
 *   | 未设         | **true**                 | false                   | false                |
 *   | `''`         | **true**                 | false                   | false                |
 *   | `'false'`    | false                    | false                   | false                |
 *   | `'true'`     | true                     | **true**                | false                |
 *   | `'0'`        | **true**                 | false                   | false                |
 *   | `'no'`       | **true**                 | false                   | false                |
 *
 * 所以本模块只做"**把原写法原样因子化**"：下面的 `envBool` 的语义 = 「先取 `env[key]`，
 * 没设就用调用方给的 default 字符串，再按调用方给的 kind 比较」——**逐字等价**于原来那句。
 * 默认值 / 比较方式一律由调用方原样传入，本模块**不改**任何默认。
 *
 * ## 用法（三派各一行，行为与改写前逐字一致）
 *
 *     envBool('MC_INSTINCT_PICKUP', 'true', 'not-false')   // 等价 `process.env.X !== 'false'`，但"没设"时按 default 'true' 算
 *     envBool('MC_INSTINCT_CAVE',   'false', 'is-true')    // 等价 `process.env.X === 'true'`
 *     envBool('MC_FML_VERBOSE',     '0',     'is-one')     // 等价 `process.env.X === '1'`
 *
 * 也提供三个薄封装（可读性更好，推荐直接用）：
 *     envOn(key)        // A 派：默认开（等价 `X !== 'false'`）
 *     envTrue(key)      // B 派：默认关（等价 `X === 'true'`）
 *     envOne(key)       // C 派：默认关（等价 `X === '1'`）
 */

/**
 * 读一个环境变量当布尔。
 *
 * @param {string} key         环境变量名
 * @param {string} def         没设时用的默认字符串（与调用方原来的 `?? '默认'` 一致）
 * @param {'not-false'|'is-true'|'is-one'} kind  怎么比（与调用方原来的运算符一致）
 * @returns {boolean}
 */
function envBool (key, def, kind) {
  const raw = process.env[key] ?? def;
  if (kind === 'is-true') return raw === 'true';
  if (kind === 'is-one') return raw === '1';
  // 默认按 A 派（`!== 'false'`）—— 与散落各处最多的那种写法一致
  return raw !== 'false';
}

/** A 派：`process.env[key] !== 'false'`（默认开；只有字面 "false" 关） */
const envOn = (key) => envBool(key, 'true', 'not-false');
/** B 派：`process.env[key] === 'true'`（默认关；只有字面 "true" 开） */
const envTrue = (key) => envBool(key, 'false', 'is-true');
/** C 派：`process.env[key] === '1'`（默认关；只有字面 "1" 开） */
const envOne = (key) => envBool(key, '0', 'is-one');

module.exports = { envBool, envOn, envTrue, envOne };

// ------------------------------------------------------------------ 自测
//
// 第 4 步要求："两项合并都要'两份实现对比'的自测，测的是跑的那份"。
// 这里把三派**原写法**（from-falsy / is-true / is-one）抄下来，和本文件跑的那份
// 对**同一组输入**逐个比 —— 输入覆盖真值表全部边界（含 `''`、`0/1`、`no`、大小写）。
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}`); } };

  const KEY = 'P4_ENV_SELFTEST';

  // ---- 原写法（三派，逐字抄）------------------------------------------------
  // A 派：unknown-blocks.js:44 / instinct/config.js 多数
  const oldNotFalse = () => (process.env[KEY] ?? 'true') !== 'false';
  // B 派：movements.js:154 / instinct/config.js:199
  const oldIsTrue = () => (process.env[KEY] ?? 'false') === 'true';
  // C 派：fml-handshake.js:274
  const oldIsOne = () => (process.env[KEY] ?? '0') === '1';

  // ---- 待测输入（真值表边界）------------------------------------------------
  // undefined 用 delete 表达
  const CASES = [undefined, '', 'false', 'true', '0', '1', 'no', 'FALSE', 'True', ' random '];

  for (const v of CASES) {
    if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v;
    const label = v === undefined ? '(未设)' : JSON.stringify(v);

    ok(`A 派 ${label}: envOn/... === 原 !== 'false'`,
      envBool(KEY, 'true', 'not-false') === oldNotFalse() && envOn(KEY) === oldNotFalse());
    ok(`B 派 ${label}: envTrue === 原 === 'true'`,
      envBool(KEY, 'false', 'is-true') === oldIsTrue() && envTrue(KEY) === oldIsTrue());
    ok(`C 派 ${label}: envOne === 原 === '1'`,
      envBool(KEY, '0', 'is-one') === oldIsOne() && envOne(KEY) === oldIsOne());
  }

  // ---- 缺省值语义再钉一遍：证明"没设"和"空串"在三派下分别怎么算（防回归）----
  delete process.env[KEY];
  ok('未设 → A 派 true（默认开）', envOn(KEY) === true);
  ok('未设 → B 派 false（默认关）', envTrue(KEY) === false);
  ok('未设 → C 派 false（默认关）', envOne(KEY) === false);
  process.env[KEY] = '';
  ok("空串 → A 派 true（'' !== 'false'）", envOn(KEY) === true);
  ok("空串 → B 派 false（'' !== 'true'）", envTrue(KEY) === false);
  process.env[KEY] = 'false';
  ok("'false' → A 派 false", envOn(KEY) === false);
  ok("'false' → B 派 false（不是 'true'）", envTrue(KEY) === false);
  ok("'false' → C 派 false", envOne(KEY) === false);

  // ---- envBool 的默认 kind 是 A 派（不传第三参时）--------------------------
  process.env[KEY] = 'no';
  ok('envBool 省 kind → 按 A 派（"no" 视为开 = 原写法）', envBool(KEY, 'true') === oldNotFalse());

  delete process.env[KEY];
  console.log(`  env.js：${pass} 通过 · ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
