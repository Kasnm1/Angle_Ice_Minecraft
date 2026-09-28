/**
 * routes/scan.js —— 从 server.js 的 handlers 表拆出的 1 条路由。
 *
 * ⚠️ 本文件由 `modpack-study/refactor-p3c/tools/extract.js` 从旧 `src/bridge/server.js`
 *    **原样搬出**（只搬不改）。里面的函数体 / 注释一个字节都没动 ——
 *    跨文件引用靠 `__ns` 两阶段装配（见文件头部的 `__ns` 与末尾的 `bind`）。
 */

'use strict';

/** 跨文件符号表：由汇总文件 server.js 在两阶段装配时注入（见本文件末尾 bind）。 */
const __ns = {};

let MAX_SCAN_BLOCK_POSITIONS;
let state;
let Vec3;

function isPlayerBuilt (...a) { return __ns.isPlayerBuilt.apply(null, a); }

/**
 * 本文件负责的路由（1 条）：
 *   GET /scan
 *
 * ⚠️ 上面的清单只是**说明**；真正的键名在下面 routes 对象里，与原 server.js 逐字一致。
 */
const routes = {
'GET /scan': async (b, q) => {
    const radius = Math.min(Math.max(1, parseInt(q?.radius ?? '8', 10) || 8), 16);
    const verticalRadius = Math.min(Math.max(1, parseInt(q?.verticalRadius ?? '4', 10) || 4), 8);
    const limit = Math.min(Math.max(1, parseInt(q?.limit ?? '24', 10) || 24), 64);
    const filter = q?.filter ? String(q.filter).toLowerCase() : null;

    const origin = state.bot.entity.position.floored();
    const counts = new Map();   // bareName → { count, nearest, positions[] }

    // ⚠️⚠️⚠️ 2026-09-25 重写（field-log **P45**）：**删掉了"建数组 + 全排序"。**
    //
    // 【原来为什么错】旧代码为了做到"先遇到最近的那些格子"，
    //   把 `(2R+1)² × (2VR+1)` 个候选**全部**建成 `Vec3` 数组，
    //   再用 `a.distanceTo(origin) - b.distanceTo(origin)` 排序 —— 那是
    //   `O(n log n)` 次比较、**每次比较还带 sqrt**。实测：
    //     · `radius=16` 时 18513 个元素排序 = **11.8 ms**
    //     · 而 `/scan` 整体只要 8~11 ms  → **时间几乎全在这里**
    //     · 换成纯循环（不分配、不排序）= **0.82 ms**，**快 14 倍**
    //
    // 【现在怎么做】**按层（洋葱）向外扩**：从 `dy=0`（她脚下那一层）开始，
    //   `level = 0, 1, 2, …` 逐层加大水平半径。每层的遍历顺序本身就是
    //   "从近到远"，**不需要排序**。够上限就停 —— 停下来的位置一定是
    //   "第 N 近的那些格子"，语义与旧的"排序后取前 N"完全一致。
    //
    // 【为什么 `dy` 在**外层**（先扫完同层的所有水平距离，再扫上下层）】
    //   一开始我写在里层（`level` 外层、`dy` 内层），自测立刻红了 —— 那意味着
    //   `level=0` 就把 `dy=0,±1,±2…` 全走完，于是"脚下 1 格"排在"同层 20 格"之前。
    //   实际场景：她站在地面（y=87），20 格外的矿在 y=88 —— 如果脚底下的土
    //   先吃配额，那个矿要等预算用完才轮得到。**而"能走过去的地方"才是她
    //   该优先知道的**（走过去是免费的，上下挖不是）。
    //   → 所以 `dy` 放外层：先把 `dy=0` 这一层的**所有**水平距离扫完，再扫 ±1 层。
    const dyOrder = [0];
    for (let k = 1; k <= verticalRadius; k++) dyOrder.push(-k, k);

    let truncated = false;
    let visited = 0;               // 总共走过了多少个坐标（防死循环的兜底）
    let solids = 0;                // 其中**不是空气**的（= 新的配额口径）

    // 记录"最远看到多远" —— 这是判断"她到底能看多远"的唯一直接证据（P45）。
    let maxDist = 0;
    let maxDistBlock = null;

    // 新增常量（见文件顶部 `MAX_SCAN_BLOCK_POSITIONS` 的注释）：
    // 遍历兜底 —— 全空气区域里 `solids` 永远不涨，必须有第二个闸门。
    // 取 18513（= radius 16 的立方体全量），即"最多把整个请求范围走一遍"。
    const MAX_SCAN_VISITS = 18513;

    const consider = (px, py, pz) => {
      // ★★ P45 的核心：**配额只算"真的读到的非空气方块"。**
      //
      // 【旧语义的病】旧代码 `scanned++` 在**每一次坐标遍历**上，空气也吃配额。
      //   后果（实测）：她站在实心地层里时，最近的 1536 **格**全是包住她的土 ——
      //   `distinct: 6`、`radius=8` 与 `radius=16` 结果**完全相同**，
      //   20 格外的矿脉**永远看不见**。挖矿时这是致命的。
      //
      // 【新语义】空气不吃配额，只有"读到东西"才计数。于是同样是 6000 的预算，
      //   在空气多的地表能**看到更远**（空气便宜，直接跳过），
      //   在实心地层里则仍然是"最近的那一批土"
      //   —— 但**上限更高了（1536 → 6000），而且没有了排序开销**。
      //
      // ⚠️ 必须有一个"总遍历数"的兜底，否则在**全空气**区域会一路扫到 radius 边界
      //    之外。`MAX_SCAN_BLOCK_POSITIONS` 同时兼任这个兜底（见下）。
      if (visited >= MAX_SCAN_VISITS) { truncated = true; return false; }
      visited++;
      const p = new Vec3(px, py, pz);
      // 距离用**平方**比较/累加：免 sqrt。最终写进 `distance` 时才开方。
      const dx = px + 0.5 - state.bot.entity.position.x;
      const dyc = py + 0.5 - state.bot.entity.position.y;
      const dz = pz + 0.5 - state.bot.entity.position.z;
      const d2 = dx * dx + dyc * dyc + dz * dz;

      const block = state.bot.blockAt(p, false);
      if (!block || !block.name) return true;          // 未加载 / 认不出
      // 只有真空气跳过。以前"没有碰撞箱"的全当空气扔掉 —— 火把、花、庄稼、树苗、铁轨都看不见，
      // 她自己插的火把就在脚下还说"看不见火把"（2026-09-27）。这些照样记下来，只是不吃 solids 配额
      if (/(^|:)(air|cave_air|void_air)$/.test(block.name)) return true;
      const passable = block.boundingBox === 'empty' && !block.name.includes('water');
      if (!passable) {
        if (solids >= MAX_SCAN_BLOCK_POSITIONS) { truncated = true; return false; }
        solids++;
      }

      const full = block.name;
      const bare = full.includes(':') ? full.slice(full.indexOf(':') + 1) : full;

      if (d2 > maxDist) { maxDist = d2; maxDistBlock = full; }

      if (filter && !full.toLowerCase().includes(filter) && !bare.toLowerCase().includes(filter)) return true;

      const dist = Math.sqrt(d2);
      let rec = counts.get(full);
      if (!rec) {
        rec = { name: full, count: 0, nearest: { x: px, y: py, z: pz }, distance: +dist.toFixed(1), ...(passable ? { passable: true } : {}) };
        counts.set(full, rec);
      }
      rec.count++;
      if (dist < rec.distance) {
        rec.distance = +dist.toFixed(1);
        rec.nearest = { x: px, y: py, z: pz };
      }
      return true;
    };

    // 洋葱遍历：`dy` **外层**（先扫完同层所有水平距离），`level` 内层逐层外扩。
    // 每层内部：先走 `dy`（同层优先），再走该层的**边框**（不是整个方块 ——
    // 内部那些在上一个较小的 level 里已经走过了）。
    outer:
    for (const dy of dyOrder) {
      for (let level = 0; level <= radius; level++) {
        if (level === 0) {
          if (!consider(origin.x, origin.y + dy, origin.z)) break outer;
          continue;
        }
        // 该水平的"环"：x 取两端，z 走全程
        for (let dz = -level; dz <= level; dz++) {
          if (!consider(origin.x + level, origin.y + dy, origin.z + dz)) break outer;
          if (!consider(origin.x - level, origin.y + dy, origin.z + dz)) break outer;
        }
        // z 取两端（避开已走过的角），x 走内部
        for (let dx = -level + 1; dx <= level - 1; dx++) {
          if (!consider(origin.x + dx, origin.y + dy, origin.z + level)) break outer;
          if (!consider(origin.x + dx, origin.y + dy, origin.z - level)) break outer;
        }
      }
    }

    // 按"最近距离"排序 —— 她问"旁边有什么"时，最近的才是第一顺位要考虑的
    const blocks = [...counts.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    // ---- 面向采集的分类（用户要求：「提高对环境的感知速度，比如挖矿」）------------
    //
    // 原来的 `/scan` 只给"有哪些方块"，于是挖矿时上层还得自己判断
    // "哪个能挖 / 哪个该挖 / 我挖得动吗"。判断一次要查 drops 表、查硬度、
    // 查手上的工具 —— 这些**网桥本地就能算**，没必要让上层每次重算。
    //
    // 这不是"多加一个字段"，是**把判断搬到数据旁边**：
    //   · 上层拿到 `harvestable` 就能直接决策，不用再发一轮请求
    //   · 判断规则只写一遍，不会出现"两个模块各有一套"
    //
    // `worthMining` 的判据：这个方块**能挖动**，且**挖了真的有产出**。
    //
    // ⚠️⚠️⚠️ 2026-09-25 第六次实战抓出来的（field-log **P20**）：
    //   上面这段注释原来写的是"挖了有掉落物"，但代码只查了 `drops` ——
    //   **漏了"需要什么工具"这一整维**。原版规则是：
    //     石头/方解石/所有矿石 —— 徒手挖会**破坏方块但不掉落任何东西**。
    //   而 `minecraft-data` 的 `drops` 表只写"用什么工具挖会掉什么"，
    //   **不写"需要工具"** —— 于是 `drops:['cobblestone']` 被读成了
    //   "挖了就有鹅卵石"，真相是"**用镐子**挖才有"。
    //
    //   实战代价（决定性实验）：
    //     POST /mine {"blockName":"stone","count":3}
    //     → mined: 3      ← 世界真的变了，3 块石头消失
    //       invDelta: 0   ← 但背包**一件都没多**
    //   上层看到的全是"成功"，而进展是零 —— **我们让她在做没有产出的劳动**。
    //
    //   修法：把 `harvestTools` 接进判据（这个字段一直都在，从没用过）。
    //   实测数据（真实 minecraft-data）：
    //     stone      harvestTools={779,784,789,794,799,804}  ← 需要镐子
    //     iron_ore   harvestTools={784,794,799,804}          ← 需要更高级的镐子
    //     dirt/oak_log/sand/gravel/clay  harvestTools=undefined  ← 徒手就行
    //
    // 于是 `worthMining` 变成一个**三态**判断（与 P4 的"我查不到 ≠ 它不行"同构）：
    //   · true  —— 现在挖就有产出
    //   · false —— 挖了也没有（缺工具），**必须在输出里说出来**，不能默不作声
    //   · null  —— 我不知道（模组方块，原版表里没有）
    const harvestable = blocks.map(b => {
      const def = state.bot.registry.blocksByName[b.name];
      let drops = null;
      let needsTool = null;
      let hardness = null;
      try {
        hardness = def?.hardness ?? null;
        // `drops` 在 minecraft-data 里是裸数字数组（如 [769]）或空数组。
        // ⚠️ 它在模组方块上**通常是空/undefined** —— 空不代表"没掉落"，
        //    只代表"原版表里没有它"。这个区别见 field-log 的 P4。
        const raw = def?.drops;
        drops = Array.isArray(raw) && raw.length
          ? raw.map(id => state.bot.registry.items?.[id]?.name ?? `#${id}`)
          : null;
        // ⚠️ `harvestTools` 存在 **且非空** 才说明"需要特定工具"。
        //    注意区分 `undefined`（原版里就是徒手可挖）与 `{}`（数据缺失）。
        //    实测：dirt/oak_log/sand 都是 `undefined`，而 stone 是 6 个 id 的对象。
        needsTool = def?.harvestTools
          ? Object.keys(def.harvestTools).length > 0
          : null;
      } catch (_) {}
      // 三态合成：只有"确定掉东西"且"确定不需要工具（或手上已经有了）"才算 true。
      let worthMining;
      if (drops === null) worthMining = null;              // 模组方块：不知道
      else if (drops.length === 0) worthMining = false;     // 原版表明确说没有掉落
      else if (needsTool === true) worthMining = false;     // ★ P20：缺工具 → 挖了也白挖
      else worthMining = true;
      return {
        ...b,
        hardness,
        // `null` = **不知道**（原版表里没有这个方块），不是"挖不到"。
        // ⚠️ 这个区分至关重要 —— P4 的教训就是"我不知道"被写成了"它不行"。
        drops,
        dropsKnown: drops !== null,
        // ★ P20 新增：挖这个方块**需不需要特定工具**。
        //   true  = 需要（徒手挖会破坏方块但**不掉落**）
        //   false = 不需要
        //   null  = 不知道（模组方块）
        needsTool,
        // ★ P21 新增：这是不是**人造方块**（玩家合成并放置的）。
        //
        //   2026-09-25 实战：修好 P20 之后，`/scan` 的短名单里突然全是
        //   `oak_planks x53` / `acacia_stairs x67` / `lantern` —— 而她当时
        //   **正站在一个玩家的建筑里**，之前"一路向下挖 15 格"挖的是人家的地基。
        //
        //   ⚠️ 注意这个判定**只标注、不隐藏**：
        //     she 完全可能**需要**木板/台阶去建自己的房子（这些正是好建材）。
        //     要拦的不是"挖人造方块"，而是"**拆别人的建筑**"。
        //     所以信息给出去，让上层自己决定（比如只看自然方块，
        //     或者在别处找同样的材料）。
        built: isPlayerBuilt(b.name),
        // 唯一能给的可执行结论：现在挖有没有东西掉出来。不知道时给 null，不猜。
        worthMining,
        // 为什么不能挖 —— 让上层能**说出原因**，而不是只看到一个 false。
        worthMiningWhy: worthMining === false
          ? (needsTool === true
            ? '需要工具（徒手挖会破坏方块但不掉落物品）'
            : '原版掉落表里没有产出')
          : undefined,
      };
    });

    // 直接给一份"该挖哪些"的短名单 —— 上层不必再从 blocks 里自己过滤。
    // 排序：先按"确定有收获"（worthMining===true 优先，unknown 次之），再按距离。
    const mineable = harvestable
      .filter(b => b.worthMining !== false)
      .sort((a, b) => {
        const av = a.worthMining === true ? 0 : 1;
        const bv = b.worthMining === true ? 0 : 1;
        if (av !== bv) return av - bv;
        return a.distance - b.distance;
      })
      .slice(0, 8)
      .map(b => ({
        name: b.name, count: b.count, distance: b.distance, nearest: b.nearest,
        drops: b.drops, worthMining: b.worthMining,
        // ★ P20：把"缺工具"这件事**带出去**。只给一个 false，
        //   上层无从知道是"没产出"还是"缺工具" —— 而两者的下一步完全不同
        //   （前者换目标，后者去搞一把镐子）。
        needsTool: b.needsTool === true ? true : undefined,
        // ★ P21：人造方块标记。**只标不过滤** —— 见 isPlayerBuilt 的注释。
        built: b.built === true ? true : undefined,
        why: b.worthMiningWhy,
      }));

    // 脚下/腿部/头部三格。抄 Mindcraft 的 `getSurroundingBlocks` ——
    // 这三格是"她能不能走/会不会淹/头顶有没有东西"的最短答案。
    const at = (dx, dy, dz) => state.bot.blockAt(origin.offset(dx, dy, dz), false)?.name ?? 'unknown';
    // ★ P21：把"能挖但很可能是别人建筑"的方块单独列出来。
    //   这是本轮最重要的环境信息 —— 修 P20 之前它完全被掩盖着。
    const builtAround = harvestable
      .filter(b => b.built === true && b.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map(b => ({ name: b.name, count: b.count, distance: b.distance }));
    // ★ P20：把"因为有工具需求而被排除"的方块单独列出来。
    //   全丢成 `[]` 是 P4 那类错误的变体：**"我把它过滤掉了"必须看得出来**。
    const toolBlocked = harvestable
      .filter(b => b.needsTool === true && (b.drops?.length ?? 0) > 0)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6)
      .map(b => ({ name: b.name, count: b.count, distance: b.distance, drops: b.drops }));
    return {
      radius, verticalRadius,
      scanned: visited,              // 兼容旧字段名：走过多少个坐标
      // ★ P45 新增：把"她到底能看多远"直接写出来。
      //   旧返回体只有 `scanned/truncated`，而实测里 `radius=8` 与 `radius=16`
      //   返回**完全一样**的内容（都被截到 1536 格 = 球半径约 7.16）——
      //   调用方**无从知道**自己看到的只有 7 格。加这两个字段之后，
      //   "看见了多远"变成一个可核对的数字。
      reach: {
        solids,                       // 真正读到的非空气方块数（= 现在的配额口径）
        maxDistance: +Math.sqrt(maxDist).toFixed(1),
        farthest: maxDistBlock,
      },
      truncated,
      budget: { solids: MAX_SCAN_BLOCK_POSITIONS, visits: MAX_SCAN_VISITS },
      limit, distinct: counts.size,
      standing: {
        below: at(0, -1, 0),
        legs: at(0, 0, 0),
        head: at(0, 1, 0),
      },
      blocks: harvestable,
      // 「我要挖矿」时直接看这个 —— 不用上层再算一遍
      mineable,
      // ★ P20：这些**有产出但你现在挖不了**（缺工具）。
      //   单独列出来，而不是混进 mineable —— 让上层能说
      //   "那片石头先别挖，得先有把镐子"。
      toolBlocked: toolBlocked.length ? toolBlocked : undefined,
      // ★ P21：周围有大量**人造方块** —— 很可能是玩家的建筑。
      //   这不是"不能挖"，而是"**挖之前先想一下这是不是别人的东西**"。
      //   判据说明：p21 是靠 P20 修好之后才看得见的（见 field-log）。
      builtAround: builtAround.length ? builtAround : undefined,
      builtNote: builtAround.length >= 3
        ? `周围有 ${builtAround.length} 类人造方块（${builtAround.slice(0, 3).map(b => b.name).join('/')}…）`
          + '—— 她可能**正站在玩家的建筑里**；拆别人的房子不是发育，是破坏。'
        : undefined,
      mineableNote: mineable.some(b => b.worthMining === null)
        ? '部分方块的掉落物未知（不在原版表里），不代表挖不到 —— 可以用 POST /mine {blockName} 直接试'
        : undefined,
      hint: truncated
        ? `走过 ${visited} 格就停了（读到 ${solids} 个方块，上限 ${MAX_SCAN_BLOCK_POSITIONS}），`
          + `现在最远看到 ${Math.sqrt(maxDist).toFixed(1)} 格 —— 缩小 radius 会更细，加大 radius 会更远`
        : undefined,
    };
  }
};

function bind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  if (ns.MAX_SCAN_BLOCK_POSITIONS !== undefined) MAX_SCAN_BLOCK_POSITIONS = ns.MAX_SCAN_BLOCK_POSITIONS;
  if (ns.isPlayerBuilt !== undefined) isPlayerBuilt = ns.isPlayerBuilt;
  if (ns.state !== undefined) state = ns.state;
}

/** 见 extract.js：在 loadDependencies() 之后由 server.js 再调一次，补上最新值。 */
function rebind (ns) {
  for (const k of Object.keys(ns)) if (!(k in __ns)) __ns[k] = ns[k];
  Vec3 = ns.Vec3;
}

module.exports = {
  routes,
  keys: ["GET /scan"],
  bind,
  rebind,
 };
