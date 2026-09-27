#!/usr/bin/env node
'use strict';

/**
 * log-stamp.js —— 给每一行控制台输出打上**墙钟时间**。
 *
 * ## 为什么需要它
 *
 * Windows 上 bridge / mind 是这么跑的（`scripts/win/angel.ps1`）：
 *
 *     node bridge-server.js >> logs\bridge.log 2>&1
 *
 * 输出被**追加**进文件，而 `console.log` 本身不带时间。于是那份 3.7 万行、
 * 2.2 MB 的 `bridge.log` 里**没有一行带时间** —— 审计时想问"这次重连卡了多久"
 * "这条报错和那条掉线差几秒"，从日志里一个都答不出来。日志存了，等于白存。
 *
 * 这个文件只做一件事：`require` 之后，把 console 的四个输出口包一层，
 * 每行前面加 `HH:MM:SS.mmm `。
 *
 * ## 三条规矩
 *
 * 1. `console.log / info / warn / error` 全覆盖（`console.debug` 不动，它默认
 *    不输出，包了也没用）。
 * 2. **多行消息只给第一行加前缀**。这不是偷懒 —— 有些地方一次性打印一段
 *    多行文本（比如她给自己的提示、表格），逐行加会把那整块冲散。要的是
 *    "这条日志是什么时候写的"，不是"每一行是什么时候写的"。
 * 3. **已经带 `[HH:MM:SS...]` 的行不再加**（`mind.js` 的 `log()` 已经自带
 *    `[01:18:27] xxx`）。同一行印两遍时间，读起来更累。
 *
 * ## 幂等
 *
 * 重复 `require` 只会包一层（借 `require.cache`，模块本身天然只跑一次）；
 * 但 `--selftest` / 有人手工 `install()` 两次时，靠旗标挡住第二层包装，
 * 免得出现 `01:02:03 [01:02:03] …`。
 *
 * 用法：
 *     require('./log-stamp');           // 打过时间了，之后随便 console.log
 *     node log-stamp.js --selftest
 */

// 已经带时间前缀的行：`[01:02:03]` / `[01:02:03.123]` / `[2026-09-28 01:02:03]`
// 行首允许空白（缩进的日志也算）。判据只认**行首**的方括号时间，不认正文里的。
const ALREADY_STAMPED = /^\s*\[\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?\]|^\s*\[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/;

let installed = false;

function pad (n, w = 2) { return String(n).padStart(w, '0'); }

/** 当前墙钟时间，形如 `01:18:27.042`（本地时区，与 `toLocaleTimeString` 的 `zh-CN` 一致） */
function stamp (d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 给一段输出文本加时间前缀。只动第一行。
 * @param {*} args console 的原始参数
 * @returns {*} 新的参数数组（第一行加了前缀）
 */
function stampArgs (args) {
  if (!args.length) return args;
  const first = args[0];
  // 第一个参数不是字符串（对象、数字、Error…）→ 由 console 自己格式化，
  // 我们只在前面**插**一个前缀参数，输出仍是 `01:02:03.123 {…}`
  if (typeof first !== 'string') return [`${stamp()}`, ...args];
  if (!first) return args;
  if (ALREADY_STAMPED.test(first)) return args;
  // ⚠️ 这里是**替换**第一个参数，不能再插一个 —— 插的话 args 变成
  //    ['01:02:03.123 hello', 'hello']，console 会把两个都打出来（"hello hello"）。
  //    只有"首参不是字符串"那种情况才需要插（因为没得替换）。
  return [`${stamp()} ${first}`, ...args.slice(1)];
}

/** 把 console 的四个输出口包一层。可以重复调用，第二次起什么都不做。 */
function install (target = console) {
  if (installed) return false;
  for (const method of ['log', 'info', 'warn', 'error']) {
    if (typeof target[method] !== 'function') continue;
    const orig = target[method].bind(target);
    target[method] = (...args) => orig(...stampArgs(args));
  }
  installed = true;
  return true;
}

/** 自测用：撤销包装（生产里永远不调） */
function _uninstall () { installed = false; }

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, cond, detail) => {
    total++;
    if (cond) { pass++; console.log(`  PASS  ${label}`); } else { console.log(`  FAIL  ${label}  ${JSON.stringify(detail)}`); }
  };

  console.log('\n时间戳');
  const s = stamp(new Date(2026, 8, 28, 1, 18, 27, 42));
  check('stamp() 形如 HH:MM:SS.mmm', s === '01:18:27.042', s);
  check('个位数也补零', stamp(new Date(2026, 8, 28, 3, 4, 5, 6)) === '03:04:05.006', stamp(new Date(2026, 8, 28, 3, 4, 5, 6)));

  console.log('\n加前缀');
  {
    const out = stampArgs(['hello']);
    check('普通行加前缀', /^\d{2}:\d{2}:\d{2}\.\d{3} hello$/.test(out[0]), out[0]);
    check('字符串首参被替换而不是追加（否则会打两遍）', out.length === 1 && out[0].endsWith(' hello'), out);
    const out2 = stampArgs(['hello', 'world']);
    check('多参只动第一个，后面的原样保留', out2.length === 2 && out2[1] === 'world' && /^\d{2}:\d{2}:\d{2}\.\d{3} hello$/.test(out2[0]), out2);
  }
  {
    const out = stampArgs(['多行第一行\n第二行\n第三行']);
    check('多行消息只给第一行加（第二行原样）', /^\d{2}:\d{2}:\d{2}\.\d{3} 多行第一行\n第二行\n第三行$/.test(out[0]), out[0]);
    check('正文里只有一个时间戳', (out[0].match(/\d{2}:\d{2}:\d{2}\.\d{3}/g) || []).length === 1);
  }
  {
    const out = stampArgs(['[01:18:27] 已经自带时间的行']);
    check('自带的 [HH:MM:SS] 不重复加', out[0] === '[01:18:27] 已经自带时间的行', out[0]);
  }
  {
    const out = stampArgs(['[2026-09-28 01:18:27] 完整日期也认']);
    check('自带的 [YYYY-MM-DD HH:MM:SS] 不重复加', out[0] === '[2026-09-28 01:18:27] 完整日期也认', out[0]);
  }
  {
    const out = stampArgs(['[fml] S2CModList: 3 mods']);
    check('正文里有方括号但不是时间 → 照加', /^\d{2}:\d{2}:\d{2}\.\d{3} \[fml\]/.test(out[0]), out[0]);
  }
  {
    const out = stampArgs([{ a: 1 }, 'tail']);
    check('首参不是字符串 → 插一个前缀参数', out.length === 3 && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(out[0]) && out[1].a === 1, out[0]);
  }
  {
    const out = stampArgs([]);
    check('空参数不动', out.length === 0);
  }

  console.log('\n装到 console');
  {
    _uninstall();
    const seen = [];
    const fake = {
      log: (...a) => seen.push(['log', a]),
      info: (...a) => seen.push(['info', a]),
      warn: (...a) => seen.push(['warn', a]),
      error: (...a) => seen.push(['error', a]),
    };
    const first = install(fake);
    const second = install(fake);   // 再包一次应该被挡住
    fake.log('hello');
    fake.info('world');
    fake.warn('小心');
    fake.error('坏了');
    fake.log('[01:18:27] 这行别动');
    fake.log('多参数', 42);
    check('install() 第一次返回 true', first === true);
    check('install() 第二次返回 false（幂等）', second === false);
    check('log 被打了时间', /^\d{2}:\d{2}:\d{2}\.\d{3} hello$/.test(seen[0][1][0]), seen[0][1][0]);
    check('log 只打一遍（没有 "hello hello"）', seen[0][1].length === 1, seen[0][1]);
    check('info 被打了时间', /^\d{2}:\d{2}:\d{2}\.\d{3} world$/.test(seen[1][1][0]), seen[1][1][0]);
    check('warn 被打了时间', /^\d{2}:\d{2}:\d{2}\.\d{3} 小心$/.test(seen[2][1][0]), seen[2][1][0]);
    check('error 被打了时间', /^\d{2}:\d{2}:\d{2}\.\d{3} 坏了$/.test(seen[3][1][0]), seen[3][1][0]);
    check('自带的行原样穿过', seen[4][1][0] === '[01:18:27] 这行别动', seen[4][1][0]);
    check('多参数：第一个带时间，第二个仍是 42', seen[5][1].length === 2 && seen[5][1][1] === 42, seen[5][1]);
    _uninstall();
  }

  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(total === pass ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else install();
} else {
  install();
}

module.exports = { install, stamp, stampArgs, _uninstall };
