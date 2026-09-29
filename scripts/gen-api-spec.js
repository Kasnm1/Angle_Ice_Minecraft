#!/usr/bin/env node
'use strict';

/**
 * gen-api-spec.js —— 从**路由快照** + **各路由文件里的说明注释**生成 `references/api-spec.md`。
 *
 * ## 为什么要生成，不手抄（REFACTOR-PLAN 第 5 步）
 *
 * 手抄的 API 文档必然和代码漂移：加一条路由忘了补、删一条路由那条永远留着。
 * 这里把 `references/routes.json`（快照，由 `scripts/routes-test.js` 守着）当**唯一事实来源**，
 * 每条路由再回源码里找它的"说明注释"，拼成一张表。
 *
 * ## 不碰运行时代码
 *
 * ⚠️ **绝不** `require('src/bridge/server.js')` —— 那个文件一 require 就会装配 handlers，
 *    虽然本仓库第 0 步已经把它做成"只定义不执行"，但这里连这点依赖都不要：
 *    本脚本**只读文件 + 正则**，不 require 任何 bridge 模块（`bridge-boot-test` 才负责 require）。
 *    于是它对"3001 端口 / 连服务器"零风险。
 *
 * ## 数据来源
 *
 *   1. `references/routes.json` —— `[{ key: 'POST /mine', source: 'bridge' | 'hands' }, …]`
 *      （`routes-test.js` 生成与校验的快照，键序稳定）
 *   2. 各路由文件里的**路由清单注释**：
 *          /**
 *           * 本文件负责的路由（6 条）：
 *           *   GET /plugins
 *           *   POST /attack
 *          *<!-- -->
 *      bridge 的 `src/bridge/routes/*.js` 与 `src/body/commonsense.js` 都用了这个格式。
 *      `src/body/index.js`（hands 的 75 条）没有这种清单，但它的 `routes()` 里
 *      每个键上面几乎都有一行 `// …用途…` 注释 —— 那种也认。
 *   3. 兜底：找不到注释时写"（无说明）"，**绝不编造用途**。
 *
 * ## 用法
 *
 *   node scripts/gen-api-spec.js            # 写 references/api-spec.md
 *   node scripts/gen-api-spec.js --check    # 只校验当前文件是否与生成结果一致（test-all 用）
 *
 * `--check` 模式返回退出码：0 = 一致，1 = 过期（路由增减后忘了重新生成）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTES_FILE = path.join(ROOT, 'references', 'routes.json');
const OUT_FILE = path.join(ROOT, 'references', 'api-spec.md');

// 路由键 → 所在文件（相对仓库根）。
// 键名与 `references/routes.json` 的 `source` 一一对应；
// 同一 source 下按数组顺序找**第一个声明该键的文件**。
const SOURCE_FILES = {
  bridge: [
    'src/bridge/routes/inspect.js',
    'src/bridge/routes/scan.js',
    'src/bridge/routes/pickup.js',
    'src/bridge/routes/body.js',
    'src/bridge/routes/place.js',
    'src/bridge/routes/move.js',
    'src/bridge/routes/mine.js',
    'src/bridge/routes/gather.js',
    'src/bridge/routes/palette.js',
    'src/bridge/routes/diag.js',
  ],
  hands: [
    'src/body/index.js',          // hands 的 75 条（汇总 routes()）
  ],
  commonsense: [
    'src/body/commonsense.js',    // 常识动作：装水 / 倒水 / 锄地 / 钓鱼 / 动物 / 载具
  ],
};

const readText = (p) => fs.readFileSync(p, 'utf8');

// 表头那句"共 N 条（…）"里每个 source 的中文标签。
const SOURCE_LABEL = { bridge: 'bridge', hands: 'hands', commonsense: 'commonsense' };

/**
 * 从一份源码里抽出"这个文件负责哪些路由键（+ 文件头清单里自带的说明）"。
 *
 * 认三种写法：
 *   ① 文件头的清单注释（`*   GET /plugins`，可带 `—— 说明`）；
 *   ② 文件头 docblock 里的"路由表"（`*   POST /eat   {itemName?}   吃（...）`，
 *      `src/body/index.js` 用这种：路径后跟参数、再跟中文说明）；
 *   ③ `routes` 对象里的键（`'POST /attack': async …`）—— 键名才是契约，前两种是说明。
 * 取**并集**：注释可能漏项，键名不会。
 *
 * @returns {{keys: string[], listPurpose: Map<string,string>}}
 *          `listPurpose` 是清单行里自带的说明（有就用它，比回头找代码注释准）。
 */
function extractRouteKeys (src) {
  const keys = new Set();
  const listPurpose = new Map();

  // ① / ② 清单行：`*   GET /path` 后**可选**跟说明。两种分隔写法：
  //   `GET /resources —— 资源记忆原文（2026-09-29）：…`   （diag.js：破折号）
  //   `POST /eat   {itemName?}   吃（不给名字自己挑）`      （index.js：参数占位 + 中文说明）
  for (const m of src.matchAll(/^[^\S\n]*\*[^\S\n]+((?:GET|POST|PUT|DELETE|PATCH) +\/[^\s{—–]+)(?:[^\S\n]+(.*?))?[^\S\n]*$/gm)) {
    const key = normalizeKey(m[1]);
    keys.add(key);
    const rest = (m[2] || '').trim();
    if (!rest) continue;   // 只有键名 —— 说明回头去代码里找，别把这里当说明
    // 清单行的格式是「`{参数}` 说明」或「—— 说明」：
    //   先剥开头的 `—— `，再去掉 `{itemName?}` 这类参数占位，剩下的才是说明。
    //   ⚠️ 不能反过来先去参数再剥破折号 —— 破折号前面可能正好是参数占位。
    let cleaned = rest.replace(/^[—–-]{1,2}\s*/, '');
    // 去掉开头的 query 参数占位（`?radius` / `?since=<seq>`）和 `{}` 参数占位
    cleaned = cleaned.replace(/^\?[A-Za-z_$][\w$]*(=<?[^\s]*>?)?\s*/, '');
    cleaned = cleaned.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    // 只剩参数名/空 → 没有说明（纯参数行的说明回头去代码里找）
    // 同一个键可能有多行命中（文件头清单 + 代码里的同格式注释）——**先到先得**，
    // 文件头清单在前面，语义更准；后面的不覆盖。
    if (cleaned && !listPurpose.has(key) && !/^[A-Za-z_$][\w$?]*(\s+[A-Za-z_$][\w$?]*)*$/.test(cleaned)) listPurpose.set(key, cleaned);
  }

  // ③ routes 对象键
  for (const m of src.matchAll(/^\s*['"`]?((?:GET|POST|PUT|DELETE|PATCH)\s+\/\S+?)['"`]?\s*:\s*(?:async\s*)?\(/gm)) {
    keys.add(normalizeKey(m[1]));
  }
  return { keys: [...keys], listPurpose };
}

/** 统一键名：方法大写、路径去尾随空白。 */
const normalizeKey = (k) => k.trim().replace(/\s+/g, ' ');

/**
 * 给某个路由键找"一句话用途"。
 *
 * 优先级：
 *   ① 文件头清单里自带的说明（`extractRouteKeys` 抽出来的 `listPurpose`）—— 最准；
 *   ② 键那一行**紧邻上方**的注释块，取最后一行有信息量的；
 *   ③ 都没有 → `null`（输出"（无说明）"，**绝不编造**）。
 */
function findPurpose (src, key, listPurpose) {
  if (listPurpose && listPurpose.has(key)) return listPurpose.get(key);

  const lines = src.split('\n');
  const declRe = new RegExp(`^\\s*['"\`]?${escapeRe(key)}['"\`]?\\s*:`);
  let declAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) { declAt = i; break; }
  }
  if (declAt < 0) return null;

  // 往上收集紧邻的注释行（允许中间隔空行，但不越过代码行）
  const collected = [];
  for (let i = declAt - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') { if (collected.length) break; else continue; }
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
      collected.unshift(t);
      continue;
    }
    break;
  }
  if (!collected.length) return null;

  // ⚠️ 文件头的**路由清单**（`*   GET /knowledge/search`）不是说明，一律丢掉。
  //    不丢的话，紧跟在清单后面的第一条路由（例如 `GET /config`）会把
  //    清单最后一行（`* GET /knowledge/search`）当成自己的用途 —— 路由表里就会出现
  //    `* GET /memory` 这种垃圾。
  const isListLine = (t) => /^\*+\s*(GET|POST|PUT|DELETE|PATCH)\s+\//.test(t) || /^\*+\s*$/.test(t);
  const block = collected.filter(t => !isListLine(t));
  if (!block.length) return null;

  // 从后往前找第一行"有信息量"的：去掉注释标记后不是空的、不是分隔线、不是元信息。
  for (let i = block.length - 1; i >= 0; i--) {
    const text = block[i]
      .replace(/^\/\*+/, '').replace(/^\*+\/?/, '').replace(/^\/+/, '')
      .replace(/\*\/$/, '').trim();
    if (!text) continue;
    if (/^[-=*_]{3,}$/.test(text)) continue;                          // 分隔线
    if (/^(本文件负责的路由|参数|用法|用法：|注意|⚠|routes\b|routes 对象|上面的清单)/.test(text)) continue;   // 模板/警示行
    return text.replace(/^[—–-]{1,2}\s*/, '');
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 路由的主要参数：从源码里键的形参解构里抽（`async ({ radius = 4 }) => …`）。 */
function findParams (src, key) {
  const lines = src.split('\n');
  const declRe = new RegExp(`^\\s*['"\`]?${escapeRe(key)}['"\`]?\\s*:`);
  const at = lines.findIndex(l => declRe.test(l));
  if (at < 0) return '';
  // 形参可能跨行，取到 `=>` 之前
  let buf = lines.slice(at, at + 4).join('\n');
  buf = buf.slice(buf.indexOf(':') + 1);
  const arrow = buf.indexOf('=>');
  if (arrow >= 0) buf = buf.slice(0, arrow);
  const brace = buf.match(/\{([\s\S]*)\}/);
  if (!brace) return '';
  return brace[1]
    .split(',')
    .map(s => s.split(/[=:]/)[0].trim())
    .filter(s => /^[A-Za-z_$][\w$]*$/.test(s))
    .slice(0, 6)
    .join(', ');
}

function main () {
  const checkOnly = process.argv.includes('--check');
  const routes = JSON.parse(readText(ROUTES_FILE));

  // 预读各文件源码
  const fileSrc = new Map();
  for (const files of Object.values(SOURCE_FILES)) {
    for (const rel of files) fileSrc.set(rel, readText(path.join(ROOT, rel)));
  }

  // 每个文件：负责哪些键 + 文件头清单里自带的说明
  const fileKeys = new Map();
  const fileListPurpose = new Map();
  for (const rel of fileSrc.keys()) {
    const { keys, listPurpose } = extractRouteKeys(fileSrc.get(rel));
    fileKeys.set(rel, new Set(keys));
    fileListPurpose.set(rel, listPurpose);
  }

  // 路由键 → 文件：在 source 对应的一组文件里找**第一个声明它的**。
  const locate = (key, source) => {
    const candidates = SOURCE_FILES[source] || [];
    for (const rel of candidates) {
      if (fileKeys.get(rel).has(key)) return rel;
    }
    return null;
  };

  const rows = [];
  for (const r of routes) {
    const file = locate(r.key, r.source);
    const src = file ? fileSrc.get(file) : '';
    rows.push({
      key: r.key,
      source: r.source,
      file: file || `（未找到：${r.source}）`,
      purpose: (src && findPurpose(src, r.key, fileListPurpose.get(file))) || '（无说明）',
      params: (src && findParams(src, r.key)) || '',
    });
  }

  const md = render(rows);

  if (checkOnly) {
    let cur = '';
    try { cur = readText(OUT_FILE); } catch (_) { cur = ''; }
    if (cur === md) {
      console.log(`  [api-spec] references/api-spec.md 与路由快照（${routes.length} 条）一致`);
      return 0;
    }
    console.log('  ✗ references/api-spec.md 与路由快照不一致（路由有增减，或忘了重新生成）');
    console.log('      修法：node scripts/gen-api-spec.js');
    // 指出差异方向（多了 / 少了哪些路由标题）
    const curKeys = new Set([...cur.matchAll(/^\| `((?:GET|POST|PUT|DELETE|PATCH) \/[^`]*)`/gm)].map(m => m[1]));
    const wantKeys = new Set(rows.map(r => r.key));
    const missing = [...wantKeys].filter(k => !curKeys.has(k));
    const extra = [...curKeys].filter(k => !wantKeys.has(k));
    if (missing.length) console.log(`      文档里少了：${missing.join(', ')}`);
    if (extra.length) console.log(`      文档里多了：${extra.join(', ')}`);
    return 1;
  }

  fs.writeFileSync(OUT_FILE, md);
  console.log(`已生成 references/api-spec.md（${rows.length} 条路由）`);
  return 0;
}

/**
 * 渲染成 Markdown。
 *
 * ⚠️ 生成块用 `<!-- BEGIN GENERATED -->` / `<!-- END GENERATED -->` 圈起来，
 *    但**整份文件都是生成物**（第 5 步的要求：不要手抄）。
 *    文件头的"怎么用"部分是模板常量，改这里就够。
 */
function render (rows) {
  const bySource = { bridge: [], hands: [] };
  for (const r of rows) (bySource[r.source] || (bySource[r.source] = [])).push(r);

  const out = [];
  out.push('# Minecraft Bridge API 规格（自动生成）');
  out.push('');
  out.push('> ⚠️ **本文件由 `scripts/gen-api-spec.js` 生成，不要手改。**');
  out.push('> 事实来源是路由快照 [`routes.json`](routes.json)（由 `scripts/routes-test.js` 守着）');
  out.push('> + 各路由文件里的说明注释。路由有增减时跑 `node scripts/gen-api-spec.js` 重新生成；');
  out.push('> `scripts/test-all.js` 会检查本文件与快照一致（过期即报错）。');
  out.push('');
  out.push('Base URL：`http://127.0.0.1:${MC_BRIDGE_PORT:-3001}` · `Content-Type: application/json` · 无鉴权（只绑 `127.0.0.1`）');
  out.push('');
  out.push('> Windows / 有代理的环境一律 `curl --noproxy \'*\'` —— 代理会劫持 localhost。');
  out.push('');
  out.push('## 路由总表');
  out.push('');
  const breakdown = Object.entries(bySource)
    .map(([src, list]) => `${SOURCE_LABEL[src] || src} ${list.length}`)
    .join(' · ');
  out.push(`共 ${rows.length} 条（${breakdown}）。`);
  out.push('');
  out.push('| 方法 | 路径 | 文件 | 用途 | 主要参数 |');
  out.push('|---|---|---|---|---|');
  for (const r of rows) {
    const [method, p] = r.key.split(' ');
    out.push(`| \`${method}\` | \`${p}\` | \`${r.file}\` | ${mdCell(r.purpose)} | ${r.params ? `\`${r.params}\`` : '—'} |`);
  }
  out.push('');
  out.push('<!-- END GENERATED -->');
  return out.join('\n') + '\n';
}

/** Markdown 表格单元格：竖线要转义，换行抹平。 */
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

if (require.main === module) process.exit(main());

module.exports = { extractRouteKeys, findPurpose, findParams, normalizeKey };
