'use strict';

/**
 * bridge 的身体命令互斥锁。
 *
 * HTTP 请求可以重叠：mind 被玩家新消息打断后，旧动作的请求仍可能在 Windows
 * bridge 中寻路；新动作若再调用 pathfinder.goto，会直接替换旧 goal。结果是两个
 * 请求都可能报 GoalChanged，箱子明明正常却被说成“打不开”。
 *
 * 这里不排队。排队会让已经被上层放弃的请求稍后突然执行，还可能超过调用方超时。
 * 后来的命令明确收到 busy，等当前动作完成后重试。/stop 在 bridge 入口绕过此锁，
 * 所以急停仍然立即生效。
 */

function claim (state, key, now = Date.now()) {
  const active = state.bodyCommand;
  if (active) {
    return {
      ok: false,
      active: active.key,
      activeForMs: Math.max(0, now - active.since),
    };
  }
  const token = { key, since: now, abort: null };
  state.bodyCommand = token;
  return { ok: true, token };
}

/**
 * 给正在跑的身体命令挂一个"立刻收手"的回调。
 *
 * 为什么需要（2026-09-29 实机）：`POST /stop` 原来只做 `setGoal(null)` +
 * `clearControlStates()` + `currentAction = null` —— 那三样都拦不住一条**在途的 `/go`**：
 * `go()` 走的每一步之后会问一次自己的 `abort` 谓词、**重新把 goal 设回去**
 * （见 `body/movement.js` 的 `go` 与 `hands.startFollow` 的注释），而 `abort` 是
 * `http.js` 按"取消线"（`state.cmdCancelledUpTo`）注进来的 —— `POST /stop` 从来没碰过那条线。
 * 于是 `/stop` 之后 `/go` 还在跑、锁还占着，下一条 `/cmd` 收到
 * "身体正在执行 POST /go（77.9 秒）"，她以为"有人在跟她抢身体"。
 *
 * 现在：命令进入 `http.js` 时把自己的 abort 谓词经这里挂到**锁 token** 上，
 * `/stop` 调 `abortCurrent()` 就能同时"让命令收手"和"放锁"。
 * token 归属不变（`release` 仍按引用身份释放），只是多带一个回调字段。
 */
function setAbort (state, token, fn) {
  if (!token || state.bodyCommand !== token) return false;
  token.abort = typeof fn === 'function' ? fn : null;
  return true;
}

/**
 * 叫停当前的身体命令。返回被停掉的那条命令的键名（没有则 null）。
 *
 * ⚠️ **不释放锁**：释放交给 `release(state, token)`，由持有者自己的 `finally` 做
 * （`http.js` 里是 `finally { if (bodyToken) release(state, bodyToken) }`）。
 * 这里若也去清 `state.bodyCommand`，持有者释放时会因为"token 已经不是自己"而失败，
 * 变成两份状态打架。`/stop` 里两步都调（先 abort、再 release），顺序无所谓。
 */
function abortCurrent (state, why = '被 /stop 叫停') {
  const t = state.bodyCommand;
  if (!t) return null;
  try { t.abort?.(why); } catch (_) { /* 命令自己的收手回调抛错不该拦住 /stop */ }
  return t.key;
}

function release (state, token) {
  if (state.bodyCommand !== token) return false;
  state.bodyCommand = null;
  return true;
}

function status (state, now = Date.now()) {
  const x = state.bodyCommand;
  return x ? { key: x.key, since: x.since, activeForMs: Math.max(0, now - x.since), abortable: !!x.abort } : null;
}

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++; else { fail++; console.log('    got ', got, 'want', want); }
  };
  const s = {};
  const a = claim(s, 'POST /container/open', 100);
  check('第一个身体命令取得锁', a.ok, true);
  check('重叠命令被拒并指出当前动作', claim(s, 'POST /go', 350), { ok: false, active: 'POST /container/open', activeForMs: 250 });
  check('错误 token 不能释放别人的锁', release(s, {}), false);
  check('原 token 能释放', release(s, a.token), true);
  check('释放后可执行下一条', claim(s, 'POST /go', 500).ok, true);

  // ---- 2026-09-29 实机：/stop 停不住在途的 /go ------------------------------
  // `/stop` 要能**让命令自己收手**（abort 谓词）+ **释放锁**（release），
  // 这样下一条命令立刻能进，而不是收到"身体正在执行 POST /go（77.9 秒）"。
  {
    const s2 = {};
    const c = claim(s2, 'POST /go', 1000);
    let aborted = null;
    check('给在途命令挂 abort 回调 → 成功', setAbort(s2, c.token, (why) => { aborted = why; }), true);
    check('status 标出这条命令可被叫停', status(s2, 2000).abortable, true);
    check('★ abortCurrent 叫停并报出是哪个命令', abortCurrent(s2, 'test'), 'POST /go');
    check('★ 命令的 abort 回调真的被触发', typeof aborted, 'string');
    check('★ abortCurrent 不抢持有者的释放（锁还在）', status(s2, 2000)?.key, 'POST /go');
    check('持有者释放 → 锁空', release(s2, c.token), true);
    check('★ 释放后下一条立刻能进（不再"身体正在执行"）', claim(s2, 'POST /cmd', 3000).ok, true);
    // 锁 token 不是自己时挂 abort 要被拒（不许外人改别人的命令）
    const s3 = {}; claim(s3, 'POST /mine', 1000);
    check('给别人的锁挂 abort → 拒绝', setAbort(s3, { key: 'fake' }, () => {}), false);
    check('没有在跑的命令 → abortCurrent 返回 null', abortCurrent({}), null);
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

/**
 * `/stop` 真的停得住在途命令 + 释放锁 —— 跑**真的那个 handler**（`routes/diag.js` 的
 * `POST /stop`），不手抄一份实现（AGENTS.md §5-4）。
 *
 * 这一条是 2026-09-29 实机抓出来的：
 * ```
 * 03:49:11  stop() ✓
 * 03:49:52  run_command(home) ✗ 身体正在执行 POST /go（77.9 秒）   ← stop 之后 /go 还在跑、锁还占着
 * ```
 * 她以为"刚才身体自己在走路 不让我传"。
 */
async function stopIntegrationTest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++; else { fail++; console.log('    got ', got, 'want', want); }
  };
  // 假的 bot / state：只要 /stop 会碰到的那些字段
  const setGoalCalls = [];
  const state = {
    connected: true,
    cmdSeq: 7,
    cmdCancelledUpTo: 0,
    currentAction: 'going to 18000,64,18000',
    bot: {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { setGoal: (g) => setGoalCalls.push(g) },
      clearControlStates: () => {},
      stopDigging: () => {},
    },
  };
  const diag = require('./routes/diag.js');
  diag.bind({ state, goals: {}, sleep: () => Promise.resolve(), withTimeout: (p) => p, REGISTRY_DIR: '/tmp' });
  const stop = diag.routes['POST /stop'];

  // 模拟一条在途的 /go 占着锁，并挂了"立刻收手"的回调（http.js 的 setAbort 干的就是这件事）
  const claimRes = claim(state, 'POST /go', Date.now() - 77900);
  let goAborted = null;
  setAbort(state, claimRes.token, () => { goAborted = 'aborted'; });
  check('前提：/go 占着锁', status(state).key, 'POST /go');

  const r = await stop();
  check('★ /stop 报出停掉了哪条命令', r.stoppedCommand, 'POST /go');
  check('★ /go 的 abort 真的被触发', goAborted, 'aborted');
  check('★ 锁被释放（下一条命令不再"身体正在执行"）', status(state), null);
  check('★ 返回里写明锁已释放', r.bodyCommandReleased, true);
  check('清掉了寻路目标', setGoalCalls.includes(null), true);
  check('取消了 currentAction（跟随循环的退出条件）', state.currentAction, null);
  check('★ 取消线推到当前序号（handler 问 args.abort 也会拿到 true）', state.cmdCancelledUpTo, 7);

  // 重新 claim 下一命令：**不再**回 "身体正在执行"
  check('★ 紧接着的 /cmd 能进（这就是她原来被挡住的那一步）', claim(state, 'POST /cmd').ok, true);
  // 没有身体命令时 /stop 也要能跑（如实说没停到东西，不许报"停掉了 POST /go"）
  const state2 = { connected: true, bot: { pathfinder: { setGoal: () => {} }, clearControlStates: () => {}, stopDigging: () => {} } };
  diag.bind({ state: state2 });
  const r2 = await diag.routes['POST /stop']();
  check('没有命令在跑时 /stop：stoppedCommand = null', r2.stoppedCommand, null);
  check('没有命令在跑时 /stop：不谎报释放了锁', r2.bodyCommandReleased, false);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { abortCurrent, claim, release, setAbort, status, selftest, stopIntegrationTest };

if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    let code = selftest();
    console.log('\n  /stop 真停住 + 释放锁（跑真的 POST /stop handler）:');
    code = (await stopIntegrationTest()) || code;
    process.exit(code);
  })();
}
