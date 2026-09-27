'use strict';

/**
 * 读 FTB 任务书的队伍进度：哪些任务 / 章节 / 奖励已经完成（给长期计划判断"主线做到哪了"）。
 *
 * 通道 architectury:network，载荷 = ResourceLocation(消息名) + 消息体（和 hands.js 里发 submit_task 的是同一条通道）。
 * 格式是 2026-09-27 反编译 ftb-quests-forge-2001.4.22.jar 核对的（WorkBuddy 的调查把几个长度写成了定长 int/long，实际是变长）：
 *
 *   ftbquests:sync_team_data   (S2C)  bool self · UUID team(16 字节) · TeamData.read(buf, self)：
 *       readUtf name
 *       varint n × { long taskId,  varlong progress }     taskProgress
 *       varint n × { long questId, varlong time }         started
 *       varint n × { long questId, varlong time }         completed   ← 要的就是这张表（键 = 对象 id）
 *       …（后面的 questRepeatableTime / completionCount / 奖励 不读）
 *   ftbquests:object_completed (S2C)  UUID team · long objectId            （单个完成的增量通知）
 *   ftbquests:request_team_data (C2S) 空 —— 发了服务端就回一条 sync_team_data
 *
 * id 用和 quests.json 一样的 16 位大写十六进制表示。
 */

function readVarInt (buf, o) {
  let n = 0; let shift = 0; let b;
  do { if (o.i >= buf.length) throw new Error('varint 越界'); b = buf[o.i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && shift < 35);
  return n >>> 0;
}
function skipVarLong (buf, o) {
  let b; let k = 0;
  do { if (o.i >= buf.length) throw new Error('varlong 越界'); b = buf[o.i++]; k++; } while (b & 0x80 && k < 10);
}
const hex = (big) => (BigInt.asUintN(64, big)).toString(16).toUpperCase().padStart(16, '0');
function readLongHex (buf, o) {
  if (o.i + 8 > buf.length) throw new Error('long 越界');
  const v = buf.readBigInt64BE(o.i); o.i += 8;
  return hex(v);
}

/** 消息名 + 消息体的起点 */
function readName (buf) {
  const o = { i: 0 };
  const n = readVarInt(buf, o);
  const name = buf.subarray(o.i, o.i + n).toString('utf8');
  o.i += n;
  return { name, o };
}

/** sync_team_data 的消息体 → { self, team, teamName, completed:[hex], started:[hex] } */
function parseSyncTeamData (buf, o = { i: 0 }) {
  const self = buf[o.i++] !== 0;
  const team = buf.subarray(o.i, o.i + 16).toString('hex'); o.i += 16;
  const nameLen = readVarInt(buf, o);
  const teamName = buf.subarray(o.i, o.i + nameLen).toString('utf8'); o.i += nameLen;
  const nTask = readVarInt(buf, o);
  if (nTask > 200000) throw new Error(`任务进度条数不对劲：${nTask}`);
  for (let k = 0; k < nTask; k++) { o.i += 8; skipVarLong(buf, o); }
  const started = [];
  const nStart = readVarInt(buf, o);
  if (nStart > 200000) throw new Error(`started 条数不对劲：${nStart}`);
  for (let k = 0; k < nStart; k++) { started.push(readLongHex(buf, o)); skipVarLong(buf, o); }
  const completed = [];
  const nDone = readVarInt(buf, o);
  if (nDone > 200000) throw new Error(`completed 条数不对劲：${nDone}`);
  for (let k = 0; k < nDone; k++) { completed.push(readLongHex(buf, o)); skipVarLong(buf, o); }
  return { self, team, teamName, completed, started, taskProgress: nTask };
}

/** object_completed 的消息体 → { team, id } */
function parseObjectCompleted (buf, o = { i: 0 }) {
  const team = buf.subarray(o.i, o.i + 16).toString('hex'); o.i += 16;
  return { team, id: readLongHex(buf, o) };
}

/**
 * 挂到 bot 上：收到全量 → state.ftbq = { completed:Set, at, team }；收到增量 → 加进去。
 * 上线（spawn）后主动要一份全量。坏包只记错误、不抛（读不出来 ≠ 没完成：state.ftbq 为 null 时上层当"不知道"）。
 */
function install (bot, state) {
  const request = () => {
    try {
      const nm = Buffer.from('ftbquests:request_team_data', 'utf8');
      const len = Buffer.from([nm.length]);   // < 128，一个字节的 varint
      bot._client.write('custom_payload', { channel: 'architectury:network', data: Buffer.concat([len, nm]) });
      state.ftbqRequestedAt = Date.now();
    } catch (e) { state.ftbqError = `请求进度失败：${e.message}`; }
  };
  state.ftbqRequest = request;
  bot._client.on('custom_payload', (p) => {
    if (p.channel !== 'architectury:network') return;
    try {
      const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
      const { name, o } = readName(buf);
      if (name === 'ftbquests:sync_team_data') {
        const d = parseSyncTeamData(buf, o);
        if (!d.self) return;   // 别的队伍的（服务器也会同步）—— 只要自己的
        state.ftbq = { team: d.team, teamName: d.teamName, completed: new Set(d.completed), started: new Set(d.started), at: Date.now() };
      } else if (name === 'ftbquests:object_completed' && state.ftbq) {
        const d = parseObjectCompleted(buf, o);
        if (d.team === state.ftbq.team) { state.ftbq.completed.add(d.id); state.ftbq.at = Date.now(); }
      }
    } catch (e) { state.ftbqError = `解析任务进度失败：${e.message}`; }
  });
  bot.once('spawn', () => setTimeout(request, 5000));
}

// ------------------------------------------------------------------ 自测：按反编译的格式造包，再读回来

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`); } };
  const vi = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
  const vl = (n) => { let x = BigInt(n); const out = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); };
  const lg = (h) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(`0x${h}`))); return b; };
  const str = (s) => Buffer.concat([vi(Buffer.byteLength(s)), Buffer.from(s)]);
  const team = Buffer.alloc(16, 7);
  const done = ['0103E9ED6D505D07', 'FFEE000000000001'];   // 第二个是负数 long，测符号
  const body = Buffer.concat([
    Buffer.from([1]), team, str('Angle_ICE 的队伍'),
    vi(2), lg('0000000000000AAA'), vl(5), lg('0000000000000BBB'), vl(300),           // taskProgress（varlong 进度，300 要两个字节）
    vi(1), lg('095969F71941C652'), vl(1790000000000),                                // started（大的 varlong 时间）
    vi(2), lg(done[0]), vl(1790000000001), lg(done[1]), vl(1),                       // completed
    vi(0), vi(0), Buffer.from([0, 0]),                                               // 后面的不读
  ]);
  const pkt = Buffer.concat([str('ftbquests:sync_team_data'), body]);
  const { name, o } = readName(pkt);
  check('消息名', name, 'ftbquests:sync_team_data');
  const d = parseSyncTeamData(pkt, o);
  check('self', d.self, true);
  check('队名', d.teamName, 'Angle_ICE 的队伍');
  check('★ 已完成的第一个（和 quests.json 同样的十六进制）', d.completed[0], done[0]);
  check('★ 负数 long 也对得上', d.completed[1], done[1]);
  check('started 读得出', d.started[0], '095969F71941C652');
  check('跳过了任务进度（变长的进度值）', d.taskProgress, 2);
  const oc = Buffer.concat([str('ftbquests:object_completed'), team, lg('1234567890ABCDEF')]);
  const r = readName(oc); const c = parseObjectCompleted(oc, r.o);
  check('增量完成通知', c.id, '1234567890ABCDEF');
  check('队伍 id 一致', c.team, team.toString('hex'));
  let threw = false; try { parseSyncTeamData(Buffer.from([1, 2, 3]), { i: 0 }); } catch (_) { threw = true; }
  check('坏包 → 抛错（上层记下来，不当成"没完成"）', threw, true);
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { readName, parseSyncTeamData, parseObjectCompleted, install, selftest };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
