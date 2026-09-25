#!/usr/bin/env node
/**
 * Jev 集成契约测试 —— 不需要真 API key。
 *
 * ## 为什么值得写
 *
 * 等真拿到 key 才发现请求体拼错了（或者端点写错了），是纯浪费。
 * 契约在本地就能验完，真 key 只用来验最后一件事：**模型答得好不好**。
 *
 * ## 契约来源（不是猜的）
 *
 * 全部对齐官方文档 docs.typesafe.ai/introduction/quickstart 的原文示例：
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   请求 {model, state, questions:{key:{type, instructions, criteria}}}
 *     - choice: criteria 是**对象** {选项id: 判据}
 *     - score : criteria 是**有序数组**
 *     - noul  : 只有 instructions
 *   响应 {model, answers:{key:{...}}, usage:{input_tokens, output_tokens}}
 *     - choice: {type, choice, confidence, probabilities}
 *     - score : {type, score, confidence, legend, probabilities}
 *     - noul  : {type, noul}      ← 官方明确：**noul 不返回 confidence**
 *
 * ## 覆盖
 *
 *   [1] 默认端点必须指向官方地址（防回归 —— 这个值曾经是错的）
 *   [2] 后端选择与鉴权 header
 *   [3] 三种问题类型的请求体形状
 *   [4] 响应解析（含 noul 没有 confidence 这种情况）
 *   [5] 失败降级：429 限流 / 500 / 200 但结构不对 / 熔断
 *
 *   node scripts/jev-contract-test.js
 */

'use strict';

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, total = 0;
const check = (label, ok, detail) => {
  total++;
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

// ---------------------------------------------------------------- 假 Jev 服务

let lastRequest = null;
let lastAuth = null;
let lastPath = null;
let mode = 'ok';   // ok | http500 | http429 | badshape

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastAuth = req.headers.authorization || null;
    lastPath = req.url;
    try { lastRequest = JSON.parse(body); } catch { lastRequest = { parseError: body.slice(0, 200) }; }

    if (mode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream boom' }));
    }
    if (mode === 'http429') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '3' });
      return res.end(JSON.stringify({ error: 'rate limited' }));
    }
    if (mode === 'badshape') {
      // 200 但结构不对 —— 客户端必须 fail closed，不能悄悄当默认分支
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ model: 'jev-1.13.0', oops: true }));
    }

    // 按官方示例的形状回答，并且**按请求里问了什么**来答 ——
    // 这样三种问题类型的解析都能真的走到
    const asked = Object.keys(lastRequest?.questions || {});
    const answers = {};
    for (const name of asked) {
      const q = lastRequest.questions[name];
      if (q.type === 'choice') {
        answers[name] = {
          type: 'choice',
          choice: 'idle',
          confidence: 0.93,
          probabilities: { idle: 0.93, follow: 0.05, fight: 0.02 },
        };
      } else if (q.type === 'score') {
        answers[name] = {
          type: 'score', score: 1.0, confidence: 1.0,
          legend: { 0: 'calm', 1: 'frustrated', 2: 'angry' },
          probabilities: { 0: 0.0, 1: 1.0, 2: 0.0 },
        };
      } else {
        // ⚠️ 官方：noul 只有 noul 字段，**没有 confidence**
        answers[name] = { type: 'noul', noul: 1.0 };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers,
      usage: { input_tokens: 392, output_tokens: 65 },
    }));
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const DECISION = path.join(__dirname, '..', 'decision.js');

  // ---------------------------------------------------------------- [1]
  console.log('\n[1/5] 默认端点 —— 这个值曾经写错过，必须防回归');
  // 在干净环境里起一个子进程读默认值：不能在这个进程里读，
  // 因为下面马上就要覆盖 JEV_URL 了（而 decision.js 是加载时求值）。
  const cleanEnv = { ...process.env };
  delete cleanEnv.JEV_URL;
  let defaultUrl = '';
  try {
    defaultUrl = execFileSync(process.execPath,
      ['-e', `process.stdout.write(require(${JSON.stringify(DECISION)}).CFG.jevUrl)`],
      { env: cleanEnv, encoding: 'utf8' }).trim();
  } catch (e) {
    defaultUrl = `读取失败: ${e.message}`;
  }
  check('默认端点是官方地址 https://api.typesafe.ai/v1/systemone',
    defaultUrl === 'https://api.typesafe.ai/v1/systemone', `实际 ${defaultUrl}`);
  check('默认端点不是那个错的域名 jevtypesafeai.com',
    !defaultUrl.includes('jevtypesafeai'), `实际 ${defaultUrl}`);

  // ⚠️ 必须**先**设环境变量再 require —— decision.js 在模块加载时就读 env
  process.env.TYPESAFE_API_KEY = 'ts_live_contract_test';
  process.env.JEV_URL = `http://127.0.0.1:${port}/v1/systemone`;
  process.env.MC_DECISION_BACKEND = 'jev';

  const { decide, buildActionMenu, backendStatus, resetBreaker } = require(DECISION);

  // ---------------------------------------------------------------- [2]
  console.log('\n[2/5] 后端选择与鉴权');
  const st = backendStatus();
  check('配了 key + backend=jev → 实际用 jev', st.willUse === 'jev', JSON.stringify(st));
  check('识别出 key 来自官方变量名 TYPESAFE_API_KEY',
    st.jevKeySource === 'TYPESAFE_API_KEY', st.jevKeySource);
  check('status 里带上了判据语言', st.criteriaLang === 'zh', st.criteriaLang);

  // ---------------------------------------------------------------- [3]
  console.log('\n[3/5] 请求体契约 —— 三种问题类型');
  const state = { hp: 18, threat: null, task: null, player: { name: 'Ka_sum1', distance: 3 }, isDay: true };
  state.menu = buildActionMenu(state);

  const r1 = await decide(state, {
    act: { type: 'choice', instructions: '下一步做什么？', options: state.menu },
  });

  const req1 = lastRequest || {};
  check('请求打到 /v1/systemone 这个路径', lastPath === '/v1/systemone', lastPath);
  check('鉴权 header 是 Bearer <key>',
    lastAuth === 'Bearer ts_live_contract_test', lastAuth);
  check('请求带上了 model', req1.model === 'jev-1.13.0', `实际 ${req1.model}`);
  check('请求带上了 state', req1.state && req1.state.hp === 18, JSON.stringify(req1.state));
  check('state 里不含本地私有字段 menu',
    req1.state && !('menu' in req1.state), JSON.stringify(req1.state));
  check('questions.act.type 是 choice', req1.questions?.act?.type === 'choice',
    JSON.stringify(req1.questions));
  check('criteria 被转成 {选项名: 判据} 对象，而不是内部数组',
    req1.questions?.act?.criteria
      && !Array.isArray(req1.questions.act.criteria)
      && typeof req1.questions.act.criteria.idle === 'string',
    JSON.stringify(req1.questions?.act?.criteria));
  check('criteria 里不含 priority（那是本地后端用的）',
    !JSON.stringify(req1.questions?.act?.criteria || {}).includes('priority'),
    JSON.stringify(req1.questions?.act?.criteria));
  check('判据是自解释的完整句子（Jev 看不到字段名）',
    (req1.questions?.act?.criteria?.idle || '').length > 10,
    req1.questions?.act?.criteria?.idle);

  // noul：只发 instructions，不带 criteria
  resetBreaker();
  await decide({ hp: 20, isDay: true, menu: [{ id: 'idle', criteria: 'x', priority: 1 }] }, {
    safe: { type: 'noul', instructions: '现在有危险吗？' },
  });
  check('noul 只带 instructions，不带 criteria',
    lastRequest?.questions?.safe?.type === 'noul' && !('criteria' in lastRequest.questions.safe),
    JSON.stringify(lastRequest?.questions?.safe));

  // score：criteria 必须是有序数组
  resetBreaker();
  await decide({ hp: 20, isDay: true, menu: [{ id: 'idle', criteria: 'x', priority: 1 }] }, {
    risk: { type: 'score', instructions: '危险程度？', criteria: ['safe', 'uneasy', 'dangerous'] },
  });
  check('score 的 criteria 是有序数组',
    Array.isArray(lastRequest?.questions?.risk?.criteria)
      && lastRequest.questions.risk.criteria.length === 3,
    JSON.stringify(lastRequest?.questions?.risk?.criteria));

  // ---------------------------------------------------------------- [4]
  console.log('\n[4/5] 响应解析');
  check('choice 解析出 choice = idle', r1.answers?.act?.choice === 'idle', JSON.stringify(r1.answers));
  check('choice 解析出 confidence = 0.93', r1.answers?.act?.confidence === 0.93);
  check('choice 解析出 probabilities',
    r1.answers?.act?.probabilities?.idle === 0.93, JSON.stringify(r1.answers?.act?.probabilities));
  check('后端标记为 jev', r1.backend === 'jev', r1.backend);
  check('带回了 usage', r1.usage?.input_tokens === 392, JSON.stringify(r1.usage));

  // noul 没有 confidence —— 这是官方行为，不是我们的 bug。
  // 上层读 confidence 时必须能容忍它缺席（用 ?? 兜底），否则会静默变成 undefined。
  resetBreaker();
  const rNoul = await decide({ hp: 20, isDay: true, menu: [{ id: 'idle', criteria: 'x', priority: 1 }] }, {
    safe: { type: 'noul', instructions: '现在有危险吗？' },
  });
  check('noul 解析出 0–1 的概率值', rNoul.answers?.safe?.noul === 1.0, JSON.stringify(rNoul.answers));
  check('noul 确实不返回 confidence（官方行为，上层需自己兜底）',
    rNoul.answers?.safe?.confidence === undefined, JSON.stringify(rNoul.answers?.safe));

  // ---------------------------------------------------------------- [5]
  console.log('\n[5/5] 失败必须降级，而不是把循环打挂');

  const tiny = { hp: 7, isDay: false, menu: [{ id: 'idle', criteria: '待命', priority: 1 }] };
  const tinyQ = { act: { type: 'choice', instructions: '下一步？', options: [{ id: 'idle', criteria: '待命', priority: 1 }] } };

  // 先验一条容易被忽略的策略：**降级结果不能进缓存**。
  // 否则一次瞬时抖动会被冻结在这条决策身份上，Jev 恢复了也继续吃兜底规则，
  // 而且连上游都不再打。判据就是"同样的问题问两次，上游应该被打了两次"。
  mode = 'http500';
  resetBreaker();
  let upstreamHits = 0;
  const origEnd = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => { upstreamHits++; origEnd(req, res); });

  const a1 = await decide(tiny, tinyQ);
  resetBreaker();
  const a2 = await decide(tiny, tinyQ);
  check('降级结果不进缓存：同样的状态问两次，上游确实被打了两次',
    upstreamHits === 2, `实际命中上游 ${upstreamHits} 次`);
  check('两次都降级了（说明没有吃缓存）',
    a1.backend === 'local' && a2.backend === 'local', `${a1.backend}/${a2.backend}`);

  server.removeAllListeners('request');
  server.on('request', origEnd);

  mode = 'http429';
  resetBreaker();
  const r429 = await decide({ hp: 9, isDay: false, menu: [{ id: 'idle', criteria: '待命', priority: 1 }] }, tinyQ);
  check('429 限流 → 降级到 local', r429.backend === 'local', r429.backend);
  check('429 的降级原因里点明了是限流，而不是笼统的 HTTP 错误',
    typeof r429.degraded === 'string' && r429.degraded.includes('限流'), r429.degraded);

  mode = 'http500';
  resetBreaker();
  const r500 = await decide({ hp: 11, isDay: false, menu: [{ id: 'idle', criteria: '待命', priority: 1 }] }, tinyQ);
  check('500 → 降级到 local', r500.backend === 'local', r500.backend);
  check('降级时带上了原因', typeof r500.degraded === 'string' && r500.degraded.includes('500'), r500.degraded);
  check('降级后仍然给出可用答案', r500.answers?.act?.choice === 'idle', JSON.stringify(r500.answers));

  const st2 = backendStatus();
  check('熔断已打开（避免每个 tick 都撞超时）', st2.jevBreakerOpen === true, JSON.stringify(st2));

  mode = 'badshape';
  // 熔断中不会真的发请求，先手动确认 badshape 的路径
  const rBad = await decide({ hp: 3, isDay: false, menu: [{ id: 'idle', criteria: '待命', priority: 1 }] }, tinyQ);
  check('熔断期间不再打上游，直接用 local', rBad.backend === 'local', rBad.backend);
  check('熔断期间的降级原因里写明了还在熔断',
    typeof rBad.degraded === 'string' && rBad.degraded.includes('熔断'), rBad.degraded);

  resetBreaker();
  const rBad2 = await decide({ hp: 4, isDay: false, menu: [{ id: 'idle', criteria: '待命', priority: 1 }] }, tinyQ);
  check('复位熔断后 200-但结构不对 → fail closed 降级',
    rBad2.backend === 'local' && /answers/.test(rBad2.degraded || ''), rBad2.degraded);

  server.close();
  console.log(`\n  ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
});
