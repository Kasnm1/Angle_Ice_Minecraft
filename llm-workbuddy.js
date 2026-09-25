'use strict';

/**
 * 最后一道兜底：本机 WorkBuddy AI 的命令行（codebuddy -p），当成一个"模型线路"用。
 *
 * ## 为什么
 *
 * 主线路和备用模型都在 susu 中转站上 —— 中转站整个挂了，两个模型一起没了，她就只会说"刚卡了"。
 * WorkBuddy AI 走的是另一家（腾讯）的后端，本机装好就能用，不用额外的 key。
 *
 * ## 怎么接
 *
 * 命令行不是 OpenAI 接口、也没有原生的工具调用，所以这里做翻译：
 *   · 系统提示词 → --system-prompt-file（替换掉它自带的编程助手人设）
 *   · 对话历史 + 工具清单 → 一段文字，从 stdin 喂进去（提示词可能几万字，走参数会撞长度上限）
 *   · 要它只输出 {"content": …, "tool_calls": [{"name", "arguments"}]}，再还原成 OpenAI 格式的 message
 * 它自己的工具全部关掉（--tools ""）：只让它"想"，手还是 bridge 的。
 * 一次 5–6 秒（实测），比中转站慢，所以只当最后一道兜底。
 *
 * 用法：node llm-workbuddy.js --selftest（离线，只测翻译）；--live 真调一次
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = process.env.WORKBUDDY_CLI || '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
const NODE_DIR = path.dirname(process.execPath);
const MODEL = process.env.WORKBUDDY_MODEL || 'deepseek-v4.1-flash';
// 在一个空目录里跑：它会按当前目录加载项目记忆和配置，别让它读到 angleice 的东西
const CWD = path.join(os.tmpdir(), 'angleice-workbuddy');

function available () { return fs.existsSync(CLI); }

function textOf (c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
  return String(c);
}

/** OpenAI 格式的 messages + tools → { system, prompt } */
function render (messages, tools) {
  const sys = messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n\n');
  const lines = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') lines.push(`【输入】\n${textOf(m.content)}`);
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map(t => `${t.function?.name}(${t.function?.arguments || '{}'})`);
      lines.push(`【你之前的回复】${textOf(m.content) ? `\n${textOf(m.content)}` : ''}${calls.length ? `\n调用了：${calls.join('；')}` : ''}`);
    } else if (m.role === 'tool') lines.push(`【工具结果 ${m.name || m.tool_call_id || ''}】\n${textOf(m.content)}`);
  }
  const toolText = (tools || []).map(t => {
    const f = t.function || t;
    return `- ${f.name}：${(f.description || '').replace(/\s+/g, ' ')}\n  参数：${JSON.stringify(f.parameters?.properties || {})}${f.parameters?.required?.length ? ` 必填：${f.parameters.required.join(',')}` : ''}`;
  }).join('\n');
  const prompt = `${lines.join('\n\n')}

────────
${toolText ? `你能调用的工具：\n${toolText}\n\n` : ''}现在轮到你。只输出一个 JSON 对象，不要任何别的文字、不要代码块：
{"content": "你要说/想的话，没有就 null", "tool_calls": [{"name": "工具名", "arguments": {参数}}]}
不调用工具就给空数组。一次可以调用多个。`;
  return { system: sys, prompt };
}

/** 从它的输出里抠出那个 JSON（它偶尔会包一层 ```json） */
function parseReply (out) {
  const s = String(out || '').trim();
  const cands = [s, (s.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of cands) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object') return j;
    } catch (_) {}
  }
  return null;
}

const FORMAT_RULE = `【输出格式（必须遵守）】你通过工具行动：要做事就调用工具，不要只说"我去做"。
只输出一个 JSON 对象：{"content": "要说/想的话或 null", "tool_calls": [{"name": "工具名", "arguments": {…}}]}。不要输出别的文字。`;
const SCHEMA = {
  type: 'object',
  properties: {
    content: { type: ['string', 'null'] },
    tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } },
  },
  required: ['content', 'tool_calls'],
};

let seq = 0;
/** 还原成 OpenAI 的 assistant message */
function toMessage (j, raw) {
  if (!j) return { role: 'assistant', content: String(raw || '').trim() || null };
  const calls = (Array.isArray(j.tool_calls) ? j.tool_calls : []).filter(t => t && t.name).map(t => ({
    id: `wb_${Date.now().toString(36)}_${seq++}`,
    type: 'function',
    function: { name: String(t.name), arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {}) },
  }));
  const msg = { role: 'assistant', content: j.content == null || j.content === 'null' ? null : String(j.content) };
  if (calls.length) msg.tool_calls = calls;
  return msg;
}

async function chat ({ messages, tools, timeoutMs = 40000, signal } = {}) {
  if (!available()) { const e = new Error(`没找到 WorkBuddy AI 命令行：${CLI}`); e.retryable = false; throw e; }
  fs.mkdirSync(CWD, { recursive: true });
  const { system, prompt } = render(messages, tools);
  const sysFile = path.join(CWD, `sys-${process.pid}-${seq++}.txt`);
  // 格式要求也放进系统提示词：只写在对话末尾时，它常常直接用大白话回（实测）
  fs.writeFileSync(sysFile, `${system || '你是一个 Minecraft 里的玩家。'}\n\n${FORMAT_RULE}`);
  const args = ['-p', '--model', MODEL, '--tools', '', '--no-session-persistence', '--system-prompt-file', sysFile, '--json-schema', JSON.stringify(SCHEMA)];
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { cwd: CWD, env: { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH || ''}` } });
    let out = ''; let err = '';
    const done = (fn) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fs.rm(sysFile, () => {}); fn(); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(() => { const e = new Error(`WorkBuddy 超时 ${timeoutMs}ms`); e.retryable = true; reject(e); }); }, timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); done(() => reject(new Error('aborted'))); };
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => done(() => { e.retryable = true; reject(e); }));
    child.on('close', code => done(() => {
      if (code !== 0 && !out.trim()) { const e = new Error(`WorkBuddy 退出码 ${code}：${err.slice(-200)}`); e.retryable = true; return reject(e); }
      const j = parseReply(out);
      if (!j && !out.trim()) { const e = new Error('WorkBuddy 什么都没回'); e.retryable = true; return reject(e); }
      resolve({ message: toMessage(j, out), raw: out.slice(0, 1500) });
    }));
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let total = 0;
  const check = (label, ok, got) => { total++; if (ok) pass++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        实际 ${JSON.stringify(got)}`}`); };
  const msgs = [
    { role: 'system', content: '你是 Angel_ICE' },
    { role: 'user', content: 'Ka_sum1：帮我拿面包' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'inventory', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', name: 'inventory', content: '面包×3' },
  ];
  const tools = [{ type: 'function', function: { name: 'give', description: '递东西', parameters: { properties: { itemName: { type: 'string' } }, required: ['itemName'] } } }];
  const r = render(msgs, tools);
  check('系统提示词单独拿出来', r.system === '你是 Angel_ICE', r.system);
  check('历史、工具结果、工具清单都在提示里', /帮我拿面包/.test(r.prompt) && /inventory\(\{\}\)/.test(r.prompt) && /面包×3/.test(r.prompt) && /give：递东西/.test(r.prompt), r.prompt);
  const m1 = toMessage(parseReply('{"content":"给你","tool_calls":[{"name":"give","arguments":{"itemName":"bread"}}]}'));
  check('还原成 OpenAI tool_calls', m1.content === '给你' && m1.tool_calls[0].function.name === 'give' && JSON.parse(m1.tool_calls[0].function.arguments).itemName === 'bread', m1);
  const m2 = toMessage(parseReply('```json\n{"content":"嗯","tool_calls":[]}\n```'));
  check('代码块包着也认', m2.content === '嗯' && !m2.tool_calls, m2);
  const m3 = toMessage(parseReply('好的我去拿'), '好的我去拿');
  check('不是 JSON：当成一句话', m3.content === '好的我去拿' && !m3.tool_calls, m3);
  const m4 = toMessage(parseReply('{"content":null,"tool_calls":[{"name":"stop"}]}'));
  check('只调工具不说话', m4.content === null && m4.tool_calls[0].function.arguments === '{}', m4);
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

module.exports = { chat, render, parseReply, toMessage, available, MODEL };
