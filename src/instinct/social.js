'use strict';

/**
 * instinct.js（第 3 步重构，2026-09-28）拆出来的「social」——**函数体一字未改**，只是换了文件。
 * 外部模块照旧只能 `require('./instinct')`（它是汇总）；这里的导出是给兄弟文件/汇总用的。
 *
 * 互相调用：子文件彼此 require 成环，所以不能在模块顶层「解构取值」（那时对面还没加载完）。
 * 这里把跨文件名字先占位，等汇总加载完所有子文件后用 bind(总表) 一次回填 ——
 * 函数体里写的就是原来的函数名，取到的始终是同一份真身。
 */

const __ns = {};
let CFG;   // 跨文件常量：load 完成后由 bind() 回填
function bind (ns) { Object.assign(__ns, ns); CFG = ns.CFG; }

/**
 * 这个玩家现在在不在"互动窗口"里 —— 判据**只写这一处**（AGENTS.md §5）。
 *
 * 主人 2026-09-28："不要总突然看着玩家，只有说话或者互动的时候需要。"
 * 窗口来源（都由 install 里的钩子写入 engagedUntil）：
 *   · 他刚跟她说话（chat）→ 20 秒
 *   · 他刚扔东西给她 / 她刚捡到他给的（whoThrew / playerCollect 的 gift）→ 15 秒
 *   · 她自己开口说话（bridge 的 POST /chat）→ 对 16 格内最近的玩家 15 秒
 *
 * @param {{player:string, engagedUntil:Object|Map, now:number}} ctx
 *   engagedUntil：玩家名 → 到什么时候为止（毫秒时间戳）；玩家名按原样也不区分大小写地查一次
 * @returns {boolean}
 */
function gazeEngaged ({ player, engagedUntil, now = Date.now() } = {}) {
  if (!player || !engagedUntil) return false;
  const at = typeof engagedUntil.get === 'function' ? engagedUntil.get(player) : engagedUntil[player];
  if (at == null) return false;
  return now < +at;   // 严格小于：窗口到点就是到点，不再看他
}

function pickGaze ({ players = [], self, now = Date.now(), next = 0, engagedUntil = null }, cfg = CFG.gaze) {
  if (!self || now < next) return null;
  const d = (p) => Math.hypot(p.pos.x - self.x, p.pos.y - self.y, p.pos.z - self.z);
  const near = players
    .filter(p => p?.pos && d(p) <= cfg.radius)
    .filter(p => gazeEngaged({ player: p.name, engagedUntil, now }))
    .sort((a, b) => d(a) - d(b));
  return near[0] || null;
}

/**
 * 需要的时候用哪条命令（死亡回收之外的）。cmds = 服务器给了的命令名 Set。
 * @returns { cmd, why } | null
 */
function pickCommand (c, cfg = CFG.cmd) {
  const { cmds = new Set(), hp = 20, fleeing = false, nightOut = false, homeDist = null, atHome = false, homeSynced = false, sinceLast = Infinity,
    day = false, returnTo = null, sameDim = true } = c;
  if (sinceLast < cfg.cmdGapMs) return null;
  if (hp <= cfg.panicHp && fleeing) {
    if (cmds.has('home')) return { cmd: 'home', why: `血只剩 ${hp}，跑不掉了，传回家` };
    if (cmds.has('spawn')) return { cmd: 'spawn', why: `血只剩 ${hp}，跑不掉了，传回出生点` };
  }
  if (atHome && !homeSynced && cmds.has('sethome')) return { cmd: 'sethome', why: '在家，把服务器的 /home 也设在这里' };
  if (nightOut && homeDist != null && homeDist > cfg.nightFarHome && homeSynced && cmds.has('home')) return { cmd: 'home', why: `天黑了还在野外、离家 ${Math.round(homeDist)} 格，传回家`, remember: true };
  // 天亮了：回昨晚传走之前的地方接着干（/back 回的就是上一次传送前的位置；没有就 /tp 坐标）
  if (day && returnTo && sameDim) {
    if (cmds.has('back')) return { cmd: 'back', why: '天亮了，回昨晚离开的地方', returned: true };
    if (cmds.has('tp')) return { cmd: `tp ${returnTo.x} ${returnTo.y} ${returnTo.z}`, why: '天亮了，回昨晚离开的地方', returned: true, selfTp: true };
  }
  return null;
}

function weatherChange (prev, now) {
  if (!prev || !now) return null;
  if (now.thunder && !prev.thunder) return { kind: 'thunder', text: '打雷了：天暗下来，白天也会刷怪；别站在高处、水里' };
  if (now.rain && !prev.rain) return { kind: 'rain', text: '下雨了' };
  if (!now.rain && prev.rain) return { kind: 'clear', text: '雨停了' };
  if (!now.thunder && prev.thunder) return { kind: 'thunder_end', text: '雷停了（还在下雨）' };
  return null;
}

/**
 * 跟着的玩家**站着不动**时，她可以顺手干点什么（2026-09-28 第 8 批 第 6 条）。
 *
 * 实机证据：`follow(Ka_sum1)` 之后 tick 走到 `if (followName) { … '跟着 X，只捡东西'; return; }`，
 * 只要 mind 给的 currentAction 还是 `following Ka_sum1`，她就**整段时间只捡东西**；
 * 采样里大量 `skip: 有 1 个命令在跑`，人不动她也不动 —— 主人看到的就是"站着不动"。
 *
 * 判据：玩家这一帧和**上一帧**的位置几乎没变，且已经连续不动 > idleMs（默认 8 秒）。
 * 站着不动 = 他在挂机/在看背包/在交易 → 她可以就地做点有用的事；
 * **他一动就立刻停下**（下一帧 movedAt 归零，本函数返回 null，tick 回到"只捡东西"）。
 *
 * @param {{now:number, idleMs:number, lastPos:?{x,y,z}, pos:?{x,y,z}, movedAt:number}} c
 *        lastPos = 上一次记下的玩家位置；movedAt = 上一次"他动过"的时间戳（0 = 还没见过）
 * @returns {null|{idleMs:number, since:number}} null = 他还在动 / 数据不足 → 别自作主张
 */
function followIdlePlan ({ now = Date.now(), idleMs = 8000, lastPos = null, pos = null, movedAt = 0 } = {}) {
  if (!pos) return null;                      // 读不到他的位置：不猜
  if (lastPos) {
    const moved = Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y, pos.z - lastPos.z);
    if (moved > 0.35) return null;            // 他在走 / 在跳：跟上，别做别的
  }
  if (!movedAt) return null;                  // 还不知道他站了多久 → 下一帧再说
  const idle = now - movedAt;
  if (idle < idleMs) return null;
  return { idleMs: idle, since: movedAt };
}

module.exports = { bind, followIdlePlan, gazeEngaged, pickCommand, pickGaze, weatherChange };

// ------------------------------------------------------------------ 自测
// 第 3 步重构：这几节原本挤在 instinct.js 的自测段里（同一个 function selftest 外套）。
// 现在搬到这里 —— 断言一字未改，只把原来「同一作用域里随手就能用」的本能函数
// 改成从 t.ns（总表）取名（拆开后它们分在别的文件里），
// 以及源码形状锁的 readFileSync(__filename) 改成 instinctSrc()。
// 被汇总 require 时 register（登记不跑）；`node src/instinct/social.js --selftest` 时只跑这几节。

const { register, runSuite } = require('./testkit');
const __sections = [
  ['指令本能', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { pickCommand, pickRecovery } = ns;
    // ---- 指令本能 ----
    const P3 = (x, y, z) => ({ x, y, z });
    const death = { pos: { x: 100, y: 64, z: 0 }, dim: 'overworld', lava: false };
    check('★ 有 /back → 用 /back', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', hasBack: true }).how, 'back');
    check('★ 没有 /back、100 格 → 走回去', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld' }).how, 'walk');
    check('★ 死在岩浆里 → 不白跑', pickRecovery({ death: { ...death, lava: true }, here: P3(0, 64, 0), dim: 'overworld', hasBack: true }).how, undefined);
    check('太远 → 不走', pickRecovery({ death: { ...death, pos: { x: 2000, y: 64, z: 0 } }, here: P3(0, 64, 0), dim: 'overworld' }).how, undefined);
    check('死在下界、现在在主世界、没有 /back → 走不回去', pickRecovery({ death: { ...death, dim: 'the_nether' }, here: P3(0, 64, 0), dim: 'overworld' }).how, undefined);
    check('快 5 分钟了 → 东西多半没了', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', sinceMs: 290000 }).how, undefined);
    const C = (o) => pickCommand({ cmds: new Set(['home', 'sethome', 'spawn']), ...o });
    check('★ 在家、还没同步 → /sethome', C({ atHome: true })?.cmd, 'sethome');
    check('★ 夜里在野外、离家 500 格 → /home', C({ nightOut: true, homeDist: 500, homeSynced: true })?.cmd, 'home');
    check('夜里离家 80 格 → 走回去（不用命令）', C({ nightOut: true, homeDist: 80, homeSynced: true }), null);
    check('没设过 /sethome 就不 /home（会传到别处）', C({ nightOut: true, homeDist: 500, homeSynced: false }), null);
    check('★ 血 3、正在逃 → /home', C({ hp: 3, fleeing: true })?.cmd, 'home');
    check('服务器没给这些命令 → 什么都不用', pickCommand({ cmds: new Set(), hp: 3, fleeing: true, atHome: true }), null);
    check('刚用过命令 → 等等', C({ atHome: true, sinceLast: 1000 }), null);
    check('★ 没有 /back 但有 /tp → /tp 回死的坐标', pickRecovery({ death, here: P3(0, 64, 0), dim: 'overworld', hasTp: true }).how, 'tp');
    check('/tp 只在同一维度用', pickRecovery({ death: { ...death, dim: 'the_nether' }, here: P3(0, 64, 0), dim: 'overworld', hasTp: true }).how, undefined);
    check('★ 夜里 /home 回家 → 记下原来在哪', C({ nightOut: true, homeDist: 500, homeSynced: true })?.remember, true);
    const back = pickCommand({ cmds: new Set(['tp']), day: true, returnTo: P3(500, 70, 0) });
    check('★ 天亮了、没有 /back → /tp 回昨晚的地方', back?.cmd, 'tp 500 70 0');
    check('…而且是 selfTp（只传自己回坐标）', back?.selfTp, true);
    check('天亮了、有 /back → 用 /back', pickCommand({ cmds: new Set(['back', 'tp']), day: true, returnTo: P3(500, 70, 0) })?.cmd, 'back');
    check('还是晚上 → 不回去', pickCommand({ cmds: new Set(['tp']), day: false, returnTo: P3(500, 70, 0) }), null);
  }],
  ['转头看人（任务书 fix7：只在互动窗口里看，窗口外不看）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { gazeEngaged, pickGaze } = ns;
    // ---- 转头看人（任务书 fix7：只在互动窗口里看，窗口外不看）
    const V = (x, y, z) => ({ x, y, z });
    const near3 = { name: 'Ann', pos: V(3, 64, 0) };
    // gazeEngaged：窗口内/外/没记录/到点
    check('没互动过的玩家 → 不在窗口里', gazeEngaged({ player: 'Ann', engagedUntil: new Map(), now: 1000 }), false);
    check('刚说过话（窗口未到点）→ 在窗口里', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 2000]]), now: 1000 }), true);
    check('★ 窗口过了（now == 到点）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 1000]]), now: 1000 }), false);
    check('★ 窗口过了（now 超过）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: new Map([['Ann', 999]]), now: 1000 }), false);
    check('读不到玩家名 → 不猜，不看', gazeEngaged({ player: null, engagedUntil: new Map([['Ann', 1e15]]), now: 0 }), false);
    check('没有窗口表（老 state）→ 不看', gazeEngaged({ player: 'Ann', engagedUntil: null, now: 0 }), false);
    check('普通对象也能当窗口表（不强制 Map）', gazeEngaged({ player: 'Ann', engagedUntil: { Ann: 2000 }, now: 1000 }), true);
    // pickGaze：只在窗口内的玩家里挑最近的
    check('★ 近处玩家没互动 → 不看（6 格内有也不看）', pickGaze({ players: [near3], self: V(0, 64, 0), engagedUntil: new Map() }), null);
    check('★ 刚说话的近处玩家 → 看他', pickGaze({ players: [near3], self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15]]) })?.pos.x, 3);
    check('★ 窗口过了 → 不看', pickGaze({ players: [near3], self: V(0, 64, 0), now: 1000, engagedUntil: new Map([['Ann', 999]]) }), null);
    check('两个都在窗口里 → 挑最近的', pickGaze({
      players: [{ name: 'Ann', pos: V(5, 64, 0) }, { name: 'Bob', pos: V(2, 64, 0) }],
      self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15], ['Bob', 1e15]]),
    })?.name, 'Bob');
    check('只有一个在窗口里 → 挑窗口里的那个（哪怕更远）', pickGaze({
      players: [{ name: 'Ann', pos: V(2, 64, 0) }, { name: 'Bob', pos: V(5, 64, 0) }],
      self: V(0, 64, 0), engagedUntil: new Map([['Bob', 1e15]]),
    })?.name, 'Bob');
    check('窗口里但太远（>radius）→ 不看', pickGaze({ players: [{ name: 'Ann', pos: V(20, 64, 0) }], self: V(0, 64, 0), engagedUntil: new Map([['Ann', 1e15]]) }), null);
    check('刚看过（没到下次）→ 不看', pickGaze({ players: [near3], self: V(0, 64, 0), now: 0, next: 100, engagedUntil: new Map([['Ann', 1e15]]) }), null);
  }],
  ['跟随的玩家站着不动（第 8 批 第 6 条）', async (t) => {
    const { check, instinctSrc, ns } = t;
    const { followIdlePlan } = ns;
    // ---- 跟随的玩家站着不动（第 8 批 第 6 条）----
    const P3 = (x, y, z) => ({ x, y, z });
    {
      const P3 = { x: 10, y: 64, z: 10 };
      check('他还在走 → 不顺手做事', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: { x: 10, y: 64, z: 10 }, pos: { x: 14, y: 64, z: 10 }, movedAt: 0 }), null);
      check('他刚停下 3 秒 → 还不到 8 秒', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: P3, movedAt: 97000 }), null);
      check('★ 他站住 9 秒 → 可以顺手做事', !!followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: P3, movedAt: 91000 }), true);
      check('★ 读不到他的位置 → 不猜', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: null, movedAt: 0 }), null);
      check('只知道他站着但不知道站多久 → 先等一帧', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: null, pos: P3, movedAt: 0 }), null);
      check('小小抖动（<0.35 格，例如坐船/被推）→ 还算站着', !!followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: { x: 10.2, y: 64, z: 10 }, movedAt: 91000 }), true);
      check('★ 他一动就停（10 秒后又走了）→ 不顺手做事', followIdlePlan({ now: 100000, idleMs: 8000, lastPos: P3, pos: { x: 12, y: 64, z: 10 }, movedAt: 91000 }), null);
    }
  }],
];
register('social', __sections);

if (require.main === module && process.argv.includes('--selftest')) {
  require('./instinct').__ns && require('./testkit').bindNs(require('./instinct').__ns);
  runSuite('social', __sections);
}
