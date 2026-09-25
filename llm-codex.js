'use strict';

/**
 * 兜底线路：本机 Codex 命令行（`codex exec`），用 ChatGPT 账号的额度跑 gpt-6-luna。
 *
 * ## 为什么
 *
 * 主线路和备用模型都在 susu 中转站上，中转站整个挂了两个一起没。原来最后一道是 WorkBuddy（llm-workbuddy.js），
 * 这里换成 Codex：另一家后端（OpenAI），本机已登录，不用额外的 key。
 *
 * ## 怎么接
 *
 * 和 WorkBuddy 一样不是 OpenAI 接口、没有原生工具调用 —— 对话翻译（render / parseReply / toMessage）
 * **直接复用 llm-workbuddy.js 的**，不另抄一份。只有两处不同：
 *   · 系统提示词走 `-c model_instructions_file=…`（替换掉 Codex 自带的编程助手指令）
 *   · Codex 的结构化输出是严格模式：对象必须 additionalProperties:false、字段全部 required，
 *     所以"任意参数对象"没法直接描述 → 让它输出 `arguments_json`（参数的 JSON 字符串），这里再还原
 * 沙箱只读、不读仓库规则、不留会话（--ephemeral）、不读用户配置（避免加载插件和通知钩子）：只让它"想"，手还是 bridge 的。
 *
 * 配置（环境变量）：CODEX_CLI / CODEX_MODEL（默认 gpt-6-luna）/ CODEX_EFFORT（默认 xhigh）
 *
 * 用法：node llm-codex.js --selftest（离线）；--live 真调一次
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render, parseReply, toMessage } = require('./llm-workbuddy.js');

const CLI = process.env.CODEX_CLI || '/Applications/ChatGPT.app/Contents/Resources/codex';
const MODEL = process.env.CODEX_MODEL || 'gpt-6-luna';
const EFFORT = process.env.CODEX_EFFORT || 'xhigh';
// 空目录里跑：别让它读到 angleice 的 AGENTS.md 当成编程任务
const CWD = path.join(os.tmpdir(), 'angleice-codex');

function available () { return fs.existsSync(CLI); }

const FORMAT_RULE = `【输出格式（必须遵守）】你通过工具行动：要做事就调用工具，不要只说"我去做"。
只输出一个 JSON 对象：{"content": "要说/想的话或 null", "tool_calls": [{"name": "工具名", "arguments_json": "参数对象的 JSON 字符串"}]}。不要输出别的文字。
你不是编程助手，不要读写文件、不要执行命令。`;
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: ['string', 'null'] },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, arguments_json: { type: 'string' } },
        required: ['name', 'arguments_json'],
      },
    },
  },
  required: ['content', 'tool_calls'],
};

/** arguments_json（字符串）→ arguments，交给 toMessage 还原 */
function fromCodex (j) {
  if (!j || !Array.isArray(j.tool_calls)) return j;
  return {
    ...j,
    tool_calls: j.tool_calls.map(t => {
      if (!t || t.arguments !== undefined) return t;
      let a = {};
      try { a = t.arguments_json ? JSON.parse(t.arguments_json) : {}; } catch (_) { a = { _unparsed: String(t.arguments_json).slice(0, 200) }; }
      return { name: t.name, arguments: a };
    }),
  };
}

let seq = 0;
async function chat ({ messages, tools, timeoutMs = 60000, signal } = {}) {
  if (!available()) { const e = new Error(`没找到 Codex 命令行：${CLI}`); e.retryable = false; throw e; }
  fs.mkdirSync(CWD, { recursive: true });
  const { system, prompt } = render(messages, tools);
  const id = `${process.pid}-${seq++}`;
  const sysFile = path.join(CWD, `sys-${id}.txt`);
  const schemaFile = path.join(CWD, `schema-${id}.json`);
  const outFile = path.join(CWD, `out-${id}.txt`);
  fs.writeFileSync(sysFile, `${system || '你是一个 Minecraft 里的玩家。'}\n\n${FORMAT_RULE}`);
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  const args = ['exec', '-', '-m', MODEL, '-c', `model_reasoning_effort=${EFFORT}`, '-c', `model_instructions_file=${sysFile}`,
    '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '-s', 'read-only', '-C', CWD,
    '--output-schema', schemaFile, '-o', outFile];
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { cwd: CWD });
    let err = '';
    const cleanup = () => { for (const f of [sysFile, schemaFile, outFile]) fs.rm(f, () => {}); };
    const done = (fn) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); cleanup(); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(() => { const e = new Error(`Codex 超时 ${timeoutMs}ms`); e.retryable = true; reject(e); }); }, timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); done(() => reject(new Error('aborted'))); };
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', () => {});   // 过程日志不要；结果在 -o 文件里
    child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-4000); });
    child.on('error', e => done(() => { e.retryable = true; reject(e); }));
    child.on('close', code => {
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch (_) {}
      done(() => {
        if (!out.trim()) { const e = new Error(`Codex 什么都没回（退出码 ${code}）：${err.slice(-200)}`); e.retryable = true; return reject(e); }
        resolve({ message: toMessage(fromCodex(parseReply(out)), out), raw: out.slice(0, 1500) });
      });
    });
    child.stdin.end(`${prompt}\n（工具参数写进 arguments_json：参数对象的 JSON 字符串。）`);
  });
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, ok, got) => { total++; if (ok) pass++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实际 ${JSON.stringify(got)}`}`); };
  const m1 = toMessage(fromCodex(parseReply('{"content":"给你～","tool_calls":[{"name":"give","arguments_json":"{\\"itemName\\":\\"bread\\",\\"player\\":\\"Ka_sum1\\"}"}]}')));
  check('arguments_json 还原成 OpenAI tool_calls', m1.content === '给你～' && m1.tool_calls[0].function.name === 'give' && JSON.parse(m1.tool_calls[0].function.arguments).player === 'Ka_sum1', m1);
  const m2 = toMessage(fromCodex(parseReply('{"content":null,"tool_calls":[{"name":"stop","arguments_json":""}]}')));
  check('空参数 → {}', m2.content === null && m2.tool_calls[0].function.arguments === '{}', m2);
  const m3 = toMessage(fromCodex(parseReply('{"content":"嗯","tool_calls":[{"name":"give","arguments_json":"{坏的"}]}')));
  check('参数不是合法 JSON → 不崩，原样带上交给工具层报错', /_unparsed/.test(m3.tool_calls[0].function.arguments), m3);
  const m4 = toMessage(fromCodex(parseReply('{"content":"嗯","tool_calls":[]}')));
  check('不调工具 → 没有 tool_calls', m4.content === '嗯' && !m4.tool_calls, m4);
  check('严格结构化输出：每层对象都 additionalProperties:false 且字段全 required',
    SCHEMA.additionalProperties === false && SCHEMA.properties.tool_calls.items.additionalProperties === false &&
    SCHEMA.required.length === Object.keys(SCHEMA.properties).length &&
    SCHEMA.properties.tool_calls.items.required.length === Object.keys(SCHEMA.properties.tool_calls.items.properties).length);
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else if (process.argv.includes('--live')) {
    const t0 = Date.now();
    chat({
      messages: [{ role: 'system', content: '你是 Minecraft 里的玩家 Angel_ICE，说话简短自然。' }, { role: 'user', content: 'Ka_sum1 说：给我一个面包' }],
      tools: [{ type: 'function', function: { name: 'give', description: '把东西递给玩家', parameters: { properties: { itemName: { type: 'string' }, player: { type: 'string' } }, required: ['itemName'] } } }],
    }).then(r => console.log(Date.now() - t0, 'ms', JSON.stringify(r.message))).catch(e => console.log('ERR', e.message));
  }
}

module.exports = { chat, available, fromCodex, MODEL, EFFORT };
