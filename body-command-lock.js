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
  const token = { key, since: now };
  state.bodyCommand = token;
  return { ok: true, token };
}

function release (state, token) {
  if (state.bodyCommand !== token) return false;
  state.bodyCommand = null;
  return true;
}

function status (state, now = Date.now()) {
  const x = state.bodyCommand;
  return x ? { key: x.key, since: x.since, activeForMs: Math.max(0, now - x.since) } : null;
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
  console.log(`\n  ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { claim, release, status, selftest };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
