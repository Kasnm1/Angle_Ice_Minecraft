'use strict';

/**
 * night.js —— 天黑本能：知道天快黑了、天黑了，按她在哪给出今晚的安排（主人 2026-09-27）。
 *
 * "时间进到 14000 附近，她应该知道天黑了，该休息 / 进屋 / 下矿干活，而不是继续在野外。"
 *
 * ## 以前缺的三样
 *
 *   ① 只有 `isDay`（< 13000），塞在"眼下最该操心的"里、只留前两条，可能被别的挤掉；天黑那一刻没有任何事件。
 *   ② 分不清野外和矿洞：不在家就一律叫她回家 —— 在地下挖矿也被叫回去。
 *   ③ 没有"快黑了"的预警，天全黑了才反应。
 *
 * ## 时刻（原版刻度，一天 24000）
 *
 *   12000 日落开始          → dusk：收尾、往回走（还亮着，来得及）
 *   12542 床可以睡了
 *   13000 天黑（13188 起露天开始刷怪）→ night：该在屋里 / 地下了
 *   23000 天快亮            → dawn
 *   主人说的"14000 附近"那时已经全黑、怪已经在刷了，所以这里提前到 12000 预警、13000 就算天黑。
 *
 * ## 她在哪：只看证据
 *
 * bridge 在 `/status` 里给 `exposure`：
 *   skyLight    头部那格的天空光（0–15；15 = 头顶直通天空）
 *   roofAt      头顶往上第几格有实心方块（null = 32 格内没有，露天）
 *   solidAbove  头顶 32 格内实心方块的数量（房顶 1–2 层；地下是一整柱）
 *
 *   open        露天：roofAt 为 null，或天空光 ≥ 12（树荫、悬崖下也算露天 —— 怪照样刷在身边）
 *   underground 地下：头顶压着 ≥ 4 层实心、天空光 ≤ 2
 *   sheltered   有顶：其余有顶且天空光 ≤ 7 的（房子、洞口）
 *   partial     介于两者之间（半遮挡），按露天算
 *   unknown     读不到（没有光照数据也没有方块）—— 不猜，按露天处理（更安全的一边）
 */

const T = { duskAt: 12000, nightAt: 13000, dawnAt: 23000 };

function phaseOf (timeOfDay, t = T) {
  if (typeof timeOfDay !== 'number') return null;
  const x = ((timeOfDay % 24000) + 24000) % 24000;
  if (x < t.duskAt) return 'day';
  if (x < t.nightAt) return 'dusk';
  if (x < t.dawnAt) return 'night';
  return 'dawn';
}

function exposureKind (e) {
  if (!e) return 'unknown';
  const { skyLight = null, roofAt = null, solidAbove = 0 } = e;
  if (roofAt == null) return skyLight == null && solidAbove === 0 && e.noData ? 'unknown' : 'open';
  if (skyLight != null && skyLight >= 12) return 'open';
  if (solidAbove >= 4 && (skyLight == null || skyLight <= 2)) return 'underground';
  if (skyLight == null || skyLight <= 7) return 'sheltered';
  return 'partial';
}

const isOut = (kind) => kind === 'open' || kind === 'partial' || kind === 'unknown';

/**
 * 今晚怎么安排。白天返回 null。
 * @param c.phase       phaseOf 的结果
 * @param c.exposure    exposureKind 的结果
 * @param c.atHome      在不在家里
 * @param c.hasHome     有没有家
 * @param c.homeDist    离家多远（格，没家为 null）
 * @param c.following   正在跟的玩家名（没有为 null）
 * @param c.sleepFail   刚才睡不着的原因（3 分钟内），没有为 null
 */
function nightPlan (c) {
  const { phase, exposure = 'unknown', atHome = false, hasHome = false, homeDist = null, following = null, sleepFail = null } = c;
  if (phase !== 'dusk' && phase !== 'night') return null;
  const dist = homeDist != null ? `约 ${Math.round(homeDist)} 格` : '';
  if (phase === 'dusk') {
    if (atHome) return '太阳下山了，今晚就在家：天一黑有床就睡（sleep_in_bed），睡前关好门、屋里暗处插火把';
    if (following) return `太阳下山了，你跟着 ${following}：跟紧，别自己走开；可以提醒一句"天要黑了，要回去吗"`;
    if (exposure === 'underground') return '外面太阳下山了（你在地下，不受影响）：可以接着挖；天黑后别从洞口出去';
    if (hasHome && homeDist != null && homeDist <= 150) return `太阳下山了：野外的活收个尾，现在往家走（go_home，${dist}），天黑前到`;
    return `太阳下山了${hasHome ? `，离家太远（${dist}）` : '，还没有家'}：趁还亮找地方过夜 —— 挖进山里 / 钻进附近矿洞，或者垫方块把自己围起来（self_rescue mode=enclose），插上火把`;
  }
  // night
  if (atHome) {
    return sleepFail
      ? `夜里在家，刚才睡不了（${sleepFail}）：别反复上床。关好门、屋里暗处插火把，在屋里干活（整理箱子、做菜），过几分钟再试`
      : '夜里在家：有床就睡（sleep_in_bed）；睡不了就在家里干活 —— 整理箱子、做菜、挖家里的矿';
  }
  if (following) return `天黑了，你跟着 ${following}：紧跟，别自己乱跑；可以问一句要不要回家`;
  if (exposure === 'underground') return '天黑了，你在地下：接着挖矿、干地下的活，别出洞口；暗处插火把防刷怪';
  if (exposure === 'sheltered') return '天黑了，你在有顶的地方：待在里面干活，别出去；门口堵上、暗处插火把';
  if (hasHome && homeDist != null && homeDist <= 64) return `天黑了还在野外：马上回家（go_home，${dist}），路上别停`;
  return `天黑了还在野外${hasHome ? `、离家远（${dist}）` : ''}：别赶夜路 —— 就地挖进地下，或者垫方块把自己围起来（self_rescue mode=enclose）躲一夜`;
}

/** 天色变了要不要说一声（边沿触发）。第一次看（prev 为 null）不说 —— 刚醒时"此刻"里本来就有。 */
function phaseEvent (prev, cur) {
  if (!prev || !cur || prev === cur) return null;
  if (cur === 'dusk') return { icon: '🌇', text: '太阳下山了', urgent: true };
  if (cur === 'night') return { icon: '🌙', text: '天黑了', urgent: true };
  if (cur === 'day' && (prev === 'night' || prev === 'dawn')) return { icon: '🌅', text: '天亮了', urgent: false };
  return null;
}

// ------------------------------------------------------------------ 自测

function selftest () {
  let pass = 0; let fail = 0;
  const check = (name, got, want) => {
    if (got === want) { pass++; return; }
    fail++;
    console.log(`  ✗ ${name} —— 得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  };
  check('6000 白天', phaseOf(6000), 'day');
  check('12500 黄昏', phaseOf(12500), 'dusk');
  check('★ 14000 天黑（主人说的时刻）', phaseOf(14000), 'night');
  check('13000 起就算天黑（13188 露天刷怪）', phaseOf(13000), 'night');
  check('23500 天快亮', phaseOf(23500), 'dawn');
  check('跨天的刻度也对（time 可能累计）', phaseOf(24000 * 3 + 14000), 'night');
  check('读不到时间 → null（不猜）', phaseOf(undefined), null);

  check('头顶直通天空 → 露天', exposureKind({ skyLight: 15, roofAt: null, solidAbove: 0 }), 'open');
  check('★ 树荫下（有叶子但天空光 13）→ 还是露天', exposureKind({ skyLight: 13, roofAt: 3, solidAbove: 1 }), 'open');
  check('房子里（1 层顶，天空光 0）→ 有顶', exposureKind({ skyLight: 0, roofAt: 2, solidAbove: 1 }), 'sheltered');
  check('★ 矿洞里（头顶压着一整柱）→ 地下', exposureKind({ skyLight: 0, roofAt: 1, solidAbove: 20 }), 'underground');
  check('读不到任何东西 → unknown（按露天处理）', exposureKind({ skyLight: null, roofAt: null, solidAbove: 0, noData: true }), 'unknown');
  check('unknown 当露天', isOut('unknown'), true);

  const at = (o) => nightPlan({ phase: 'night', exposure: 'open', hasHome: true, homeDist: 30, ...o }) || '';
  check('白天没安排', nightPlan({ phase: 'day' }), null);
  check('★ 夜里野外、离家近 → 回家', /回家（go_home/.test(at({})), true);
  check('★ 夜里野外、离家远 → 不赶夜路，就地躲', /别赶夜路/.test(at({ homeDist: 500 })), true);
  check('★ 夜里在矿洞 → 接着挖，不叫她回家', /接着挖/.test(at({ exposure: 'underground' })) && !/go_home/.test(at({ exposure: 'underground' })), true);
  check('夜里在别人的房子里 → 待着别出去', /待在里面/.test(at({ exposure: 'sheltered' })), true);
  check('夜里在家 → 睡觉', /sleep_in_bed/.test(at({ atHome: true })), true);
  check('刚睡不着 → 别反复上床', /别反复上床/.test(at({ atHome: true, sleepFail: '附近有怪' })), true);
  check('★ 跟着主人 → 跟紧、问一句，不自己跑回家', /紧跟/.test(at({ following: 'starwish' })) && !/go_home/.test(at({ following: 'starwish' })), true);
  check('没有家 → 就地躲', /围起来/.test(at({ hasHome: false, homeDist: null })), true);
  const dusk = (o) => nightPlan({ phase: 'dusk', exposure: 'open', hasHome: true, homeDist: 100, ...o }) || '';
  check('★ 黄昏在野外、家不远 → 收尾往家走', /收个尾/.test(dusk({})), true);
  check('黄昏离家太远 → 趁亮找地方过夜', /趁还亮/.test(dusk({ homeDist: 900 })), true);
  check('黄昏在地下 → 不受影响', /不受影响/.test(dusk({ exposure: 'underground' })), true);

  check('白天→黄昏：说一声（要紧）', phaseEvent('day', 'dusk')?.urgent, true);
  check('黄昏→夜里：说一声', phaseEvent('dusk', 'night')?.text, '天黑了');
  check('刚醒第一眼不说', phaseEvent(null, 'night'), null);
  check('没变不说', phaseEvent('night', 'night'), null);
  check('天亮了', phaseEvent('dawn', 'day')?.text, '天亮了');

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { T, phaseOf, exposureKind, isOut, nightPlan, phaseEvent, selftest };

if (require.main === module && process.argv.includes('--selftest')) {
  process.exit(selftest());
}
