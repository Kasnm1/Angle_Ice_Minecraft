// ============================================================================
//  zz_angel_dump_block_palette.js   ——  一次性诊断脚本（v4，**客户端脚本**版）
//
//  目的：把客户端内存里的「方块 → state 个数 + 属性表 + **逐 state 碰撞箱**」
//        倒出来，交给 minecraft-bridge 的 /registry/import-palette 导入。
//
//  为什么要它：
//    1.13 之后服务端在 chunk_data 里只发**全局调色板数字 ID**，方块名靠客户端
//    本地注册表翻译。机器人只有原版 minecraft-data，所以模组方块查不到 →
//    `b.type` 恒为 undefined、`b.name` 恒为空串。而梯子的两层判据都是
//    `block.type === ladderId`，所以**调色板是梯子问题的前置条件**。
//    从模组 jar 的 blockstates/*.json 反推 state 数**结构性地不可能**
//    （MC 允许 variants 的键省略属性当通配符，glass_trapdoor 真值 64 态只数得出
//    16 态），唯一精确来源就是**这个正在跑的客户端**。
//
//  ── v4 相对 v3 的两处改动 ──────────────────────────────────────────────────
//
//  （一）**从 startup script 搬到 client script。**
//      v3 只能拿到注册表（名字/属性），拿不到**碰撞形状** —— 形状必须有个
//      BlockGetter 才能问出来（`BlockState.getCollisionShape(BlockGetter, BlockPos)`），
//      而那个绑定 `Client` = `Minecraft.getInstance()` **只在客户端脚本里注册**
//      （反汇编 `BuiltinKubeJSClientPlugin.registerBindings`：`Client` / `Painter` /
//      `setTimeout` / `setInterval` 这四个名字只在客户端脚本类型下加进绑定表）。
//      ⇒ 本文件必须放在 `kubejs/client_scripts/src/`，**不能再放 startup_scripts**。
//
//  （二）**多导一列：每个 state 的碰撞箱。**
//      没有它，pathing.js 只能按方块名猜形状（薄方块白名单 → 可穿过；`_bed` → 9/16；
//      其余 → 整块实心），整合包里大量非整格方块（家具、模组台阶/楼梯/栅栏/地毯/
//      路径块…）全被猜错 —— 那才是"卡在门口出不去"的根，`lowBlockHeight` 只是补丁。
//
//  ── 采样位置为什么在**世界高度之外**（y=1000）──────────────────────────────
//
//  形状函数拿到的 `BlockGetter` 只有"问邻格是什么"这一个用途。我们要的是
//  **孤立形状**（isolated shape）—— 只由这个 state 自己决定的那个形状。
//  `Level.getBlockState` 对界外坐标走 `isOutsideBuildHeight` 分支**直接返回
//  VOID_AIR**（反汇编 `Level.m_8055_` 证实），于是：
//    · 邻格 ±1 也都在界外 → 全返回空气 → 等价 `CollisionContext.empty()` 的孤立形状；
//    · **完全不碰区块**（那个分支在取 chunk 之前就 return 了）→ 不加载、不阻塞、
//      结果与玩家站在哪、地形长什么样**无关**，可复现。
//  y=1000 对主世界(-64..319)、下界(0..127)、末地(0..255) 都越界。
//
//  ⚠️ 对"形状要看邻居"的方块，拿到的是**孤立变体**。这一条有两个后果：
//    · 栅栏 / 墙 / 铁栏 / 玻璃板**不受影响** —— 它们的连接状态本身就是 block state
//      属性（north/south/east/west/up），逐 state 导出是完整的。实测 `oak_fence`
//      32 state → 16 种形状、`cobblestone_wall` 324 state → 32 种（含一种空碰撞）。
//    · `bamboo` / `scaffolding` / `pointed_dripstone` 这类**真的要看邻居**的，
//      拿到的是"孤立"变体；原版自己用 `Properties.dynamicShape()` 标出它们，
//      1.20.1 一共 6 处（另加 `shulker_box` 系、`moving_piston`）。孤立变体是
//      **保守的那一侧**（碰撞不小于动态时的最小值），导入端会打上
//      `angelShapeDynamic` 标记并在 `/config` 里报个数。详见 registry/README.md。
//
//  ── 🔴 铁律（前几版踩过，字节码级核实过；client script 同样适用）──────────
//
//    1. **不用 `const`。** Rhino 的 `Interpreter.doSetConstVar` 在**运行期**抛
//       `msg.var.redecl`（"redeclaration of var X"）。本包里所有**能正常跑**的脚本
//       （effect.js / vefcblocks.js / vefcfoods.js）一个 `const` 都没有。
//       ⚠️ 本文件顶层的三个 `var` 是**故意的**，不是笔误：客户端脚本会被 F3+T
//       重载，而 `var` 重声明合法、顶层 `let` 重声明会抛。函数声明同理。
//    2. **整个函数体都放进 `try`。** 只要有一句在 `try` 外面抛出来就是未捕获的
//       脚本错误。
//    3. **只用 `console.info`，绝不用 `console.error`/`warn`。** KubeJS 把这两个
//       级别记成脚本错误。
//    4. **不调 `Java.loadClass`。** 只用绑定：`Client` / `Utils` / `BlockPos` /
//       `global`。遍历 Java 集合一律用 `iterator()/hasNext()/next()`。
//
//  ── 启动时机 ──────────────────────────────────────────────────────────────
//
//  客户端脚本在**主菜单**就加载了，那时 `Client.level` 还是 null。所以这里不是
//  "加载即跑"，而是"装上定时器 → 每片检查一次 → 进了世界才开始导"。
//  ⇒ 用法：放进 `kubejs/client_scripts/src/`，启动客户端，**进一次世界**（单机即可）。
//
//  ── 输出 ──────────────────────────────────────────────────────────────────
//
//  逐行打进日志，前缀 `ANGELPAL|`
//    数据行： <注册序号>|<state个数>|<注册表数字id>|<方块名>|<属性规格>|<形状列>
//    另有 4 种非数据行，导入端按前缀区分：
//      ANGELPAL-HEADER|rows=…|…      **先于所有数据行**，用来判断日志有没有被截断
//      ANGELPAL-PROGRESS|…           进度，可忽略
//      ANGELPAL-DONE|rows=…          收尾
//      ANGELPAL-ERROR|…              致命错误，**这一份 dump 不能用**
//
//  形状列的编码与 block-palette.js 的 `encodeShapes` **逐字节一致**：
//      `.` 整格 / `-` 无碰撞 / `?` 读不到 / `<def0>;<def1>;…~<索引>` 表 + 逐 state 索引
//      （索引字符 `0-9a-zA-Z`；def 里多个箱子用 `+` 连、6 个坐标用 `:` 连）
//    两边的自测各钉一份，改一边必须改另一边。
//
//  ⚠️ 输出大约几 MB。`latest.log` 会滚动（logs/ 里那些 `YYYY-MM-DD-N.log` 就是），
//    如果滚动发生在 dump 中途，需要把 `latest.log` 和对应的滚动文件拼起来再解析 ——
//    所以 HEADER 行**排在最前面**：rows= 与实际取到的行数对不上就说明被截断了。
//
//  ── 分帧 ──────────────────────────────────────────────────────────────────
//
//  `setInterval(fn, 50)`（客户端脚本专属绑定，由 `MinecraftClientMixin` 在客户端
//  线程上 `tickAll`）。每片最多跑 BUDGET_MS 毫秒就交还线程 —— 826k 个 state
//  一次算完会把客户端冻住几十秒。
//
//  怎么删：直接删掉这个文件。它**只读注册表、只算形状、只写日志**，不碰游戏内容。
// ============================================================================


/** 每片最多占客户端线程多少毫秒。太大 → 卡；太小 → 要跑很久。 */
var BUDGET_MS = 25

/** 数据行前缀（导入端只认这一种行是数据）。 */
var MARK = 'ANGELPAL|'

/** 每多少片报一次进度，方便看"还活着"。 */
var PROGRESS_EVERY = 20

/** 探针用的采样位置：世界高度之外。见文件头。 */
var PROBE_Y = 1000

// ---------------------------------------------------------------------------
//  纯函数：形状编码（必须与 block-palette.js 的 encodeShapes 一致）
// ---------------------------------------------------------------------------

/** 索引字母表：0-9a-zA-Z（62 个）。`?` 留给"这个 state 读不到"。 */
function angelAlpha () {
  return '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
}

/** 坐标 → 紧凑串。保留 6 位小数，并消掉 `-0`。与 block-palette.js 的 fmtCoord 一致。 */
function angelFmtCoord (v) {
  var r = Math.round(Number(v) * 1000000) / 1000000
  return String(r === 0 ? 0 : r)
}

/**
 * 一个 AABB → 6 个坐标字符串。
 * 可读字段名 minX/minY/minZ/maxX/maxY/maxZ 对应 SRG `f_82288_`..`f_82293_`
 * （用 Mojang mappings + TSRG 链式核对过，且这 6 个名字都在 `mm.jsmappings` 里）。
 */
function angelBoxOf (aabb) {
  return [
    angelFmtCoord(aabb.minX), angelFmtCoord(aabb.minY), angelFmtCoord(aabb.minZ),
    angelFmtCoord(aabb.maxX), angelFmtCoord(aabb.maxY), angelFmtCoord(aabb.maxZ)
  ]
}

/**
 * 一个 state 的碰撞箱数组 → def 串。
 * `boxes` 是"6 字符串数组"的数组；空数组 → `-`（**知道没有碰撞**，不是"不知道"）。
 */
function angelEncodeShape (boxes) {
  if (!boxes || boxes.length === 0) return '-'
  if (boxes.length === 1) {
    var b = boxes[0]
    if (b[0] === '0' && b[1] === '0' && b[2] === '0' &&
        b[3] === '1' && b[4] === '1' && b[5] === '1') return '.'
  }
  var parts = []
  for (var i = 0; i < boxes.length; i++) parts.push(boxes[i].join(':'))
  return parts.join('+')
}

/**
 * 逐 state 形状 → 一列。
 * `shapes` 的元素是"boxes 数组"（含空数组）或 `null`（读不到）。
 */
function angelEncodeShapes (shapes) {
  var alpha = angelAlpha()
  var defs = []
  var seen = {}
  var idx = []
  for (var i = 0; i < shapes.length; i++) {
    if (!shapes[i]) { idx.push('?'); continue }          // 读不到，不进表
    var k = angelEncodeShape(shapes[i])
    if (!Object.prototype.hasOwnProperty.call(seen, k)) {
      seen[k] = defs.length
      defs.push(k)
    }
    idx.push(alpha.charAt(seen[k]))
  }
  if (!defs.length) return '?'                           // 全是读不到
  if (defs.length === 1) {
    var allSame = true
    for (var j = 0; j < idx.length; j++) {
      if (idx[j] !== alpha.charAt(0)) { allSame = false; break }
    }
    if (allSame) return defs[0]                          // 所有 state 同形 → 只写 def
  }
  if (defs.length > alpha.length) {
    // 兜底：形状种类比索引字母表还多（原版只有 chorus_plant 一个），逐 state 直接列
    var parts = []
    for (var m = 0; m < shapes.length; m++) {
      parts.push(shapes[m] ? angelEncodeShape(shapes[m]) : '?')
    }
    return '!' + parts.join(',')
  }
  return defs.join(';') + '~' + idx.join('')
}

/** 一个 BlockState 的碰撞形状 → "boxes 数组"（空数组 = 没有碰撞）。读不到就抛。 */
function angelBoxesOf (state, level, pos) {
  var shape = state.getCollisionShape(level, pos)
  var aabbs = shape.toAabbs()
  var boxes = []
  var it = aabbs.iterator()
  while (it.hasNext()) boxes.push(angelBoxOf(it.next()))
  return boxes
}

/** 属性规格：`facing:north,south,…;open:false,true` —— 顺序就是 state id 的展开顺序。 */
function angelPropSpec (def) {
  var parts = []
  var pit = def.getProperties().iterator()
  while (pit.hasNext()) {
    var prop = pit.next()
    var vals = []
    var vit = prop.getPossibleValues().iterator()
    while (vit.hasNext()) vals.push(String(vit.next()))
    parts.push(String(prop.getName()) + ':' + vals.join(','))
  }
  return parts.join(';')
}

/**
 * 探针：用三个已知答案的方块试一下整条链
 * （`getCollisionShape` → `toAabbs` → AABB 字段名 → 编码）。
 *
 * 为什么要探针：这一串里任何一个可读名没被 `mm.jsmappings` 接上，都会在
 * **每个 state 上**抛异常 —— 结果是"导出了一份形状全是 `?` 的 dump"，
 * 看起来跑完了、其实白跑，还得多重启一次客户端。探针让这件事在**第一秒**就暴露。
 *
 * 期望值来自 minecraft-data 的原版数据（离线核对过）：
 *   stone  → `.`（整格）
 *   air    → `-`（无碰撞）
 *   ladder → `0:0:0:0.8125:1:1`（3/16 厚；**必须带 level** 才是这个值）
 */
function angelProbe (level, reg, pos) {
  var cases = [
    ['stone', '.'],
    ['air', '-'],
    ['ladder', '0:0:0:0.8125:1:1']
  ]
  var out = []
  var ok = true
  for (var i = 0; i < cases.length; i++) {
    var name = cases[i][0]
    var got = '(方块不存在)'
    try {
      var block = reg.getValue(Utils.id('minecraft', name))
      if (block) got = angelEncodeShape(angelBoxesOf(block.defaultBlockState(), level, pos))
    } catch (e) {
      got = '(抛错: ' + e + ')'
    }
    if (got !== cases[i][1]) ok = false
    out.push(name + '=' + got + (got === cases[i][1] ? '' : ' ✗期望' + cases[i][1]))
  }
  return { ok: ok, text: out.join(' ; ') }
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------

/** 停表 + 报一行错。`why` 要写清楚"停在哪一步、已经写了多少"。 */
function angelDie (S, why) {
  S.running = false
  if (S.intervalId !== null) {
    try { clearInterval(S.intervalId) } catch (e0) { /* 无所谓 */ }
    S.intervalId = null
  }
  console.info('ANGELPAL-ERROR|' + why)
}

/** 停表（正常收尾）。 */
function angelStop (S) {
  S.running = false
  if (S.intervalId !== null) {
    try { clearInterval(S.intervalId) } catch (e1) { /* 无所谓 */ }
    S.intervalId = null
  }
}

/** 进世界之后才做的初始化：数行数 → 探针 → HEADER。返回 true 表示可以开导。 */
function angelSetup (S) {
  var reg = S.reg
  var level = Client.level
  var vanilla = null
  try { vanilla = reg.getVanillaRegistry() } catch (e0) { vanilla = null }

  // 先数一遍行数 —— HEADER 要排在所有数据行**前面**，才能在日志被滚动/截断时发现
  var total = 0
  var cit = reg.entrySet().iterator()
  while (cit.hasNext()) { cit.next(); total++ }

  var probe = angelProbe(level, reg, S.pos)
  console.info('ANGELPAL-HEADER|rows=' + total + '|probeOk=' + probe.ok +
    '|probe=' + probe.text + '|budgetMs=' + BUDGET_MS)
  if (!probe.ok) {
    angelDie(S, '形状探针没过 → 这一份 dump 的形状列不可信，已放弃。' +
      '这不是"游戏出问题"，多半是某个可读方法名没被 jsmappings 接上；' +
      '上面那行 HEADER 里每个用例的实测值就是证据。')
    return false
  }

  S.level = level
  S.vanilla = vanilla
  S.it = reg.entrySet().iterator()
  S.total = total
  S.index = 0
  S.t0 = Utils.getSystemTime()
  console.info('ANGELPAL-PROGRESS|已开始导出：rows=' + total +
    '，每片最多 ' + BUDGET_MS + 'ms，每 50ms 一片。跑完会写 ANGELPAL-DONE。')
  return true
}

/** 跑一片：处理整块，直到本片的时间预算用完。 */
function angelTick (S) {
  if (!S.running) return

  // ① 还没进世界：每片看一眼，进了才开始
  if (S.it === null) {
    if (!Client.level) return
    if (!angelSetup(S)) return
  }

  // ② 玩家离开世界 / 换维度 → level 会变。拿着旧 level 继续问形状不安全，直接停。
  var levelNow = Client.level
  if (!levelNow || levelNow !== S.level) {
    angelDie(S, '客户端已离开世界（或换了维度），导出中断：' +
      '已写 ' + S.index + '/' + S.total + ' 行。这一份 dump 不完整，请重新进一次世界。')
    return
  }

  var t0 = Utils.getSystemTime()
  while (S.it.hasNext()) {
    if (Utils.getSystemTime() - t0 >= BUDGET_MS) break

    var entry = S.it.next()
    var block = entry.getValue()

    var name = ''
    try {
      name = String(entry.getKey().location())
    } catch (e1) {
      try { name = String(entry.getKey()) } catch (e2) { name = '?unknown?' }
    }
    if (name.indexOf(':') < 0) S.badName++

    var rid = -1
    if (S.vanilla !== null) {
      try { rid = S.vanilla.getId(block) } catch (e4) { rid = -1 }
    }
    if (rid < 0) S.noRid++

    // state 个数 + 属性规格 + **逐 state 形状**
    var count = 0
    var spec = '?'
    var shapeSpec = '?'
    try {
      var def = block.getStateDefinition()
      var states = def.getPossibleStates()
      count = states.size()
      spec = angelPropSpec(def)

      var boxes = []
      var sit = states.iterator()
      while (sit.hasNext()) {
        var st = sit.next()
        try {
          boxes.push(angelBoxesOf(st, S.level, S.pos))
          S.shapeStates++
        } catch (e5) {
          boxes.push(null)               // 这一个 state 读不到 → 写 `?`，并计数
          S.shapeFail++
        }
      }
      shapeSpec = angelEncodeShapes(boxes)
      S.shapeBlocks++
    } catch (e3) {
      spec = '?'
      shapeSpec = '?'
      S.blockFail++
    }

    console.info(MARK + S.index + '|' + count + '|' + rid + '|' + name + '|' +
      spec + '|' + shapeSpec)
    S.index++
  }

  S.slices++
  var finished = !S.it.hasNext()
  if (S.slices % PROGRESS_EVERY === 0 || finished) {
    console.info('ANGELPAL-PROGRESS|done=' + S.index + '/' + S.total +
      '|shapeStates=' + S.shapeStates + '|shapeFail=' + S.shapeFail +
      '|blockFail=' + S.blockFail + '|ms=' + (Utils.getSystemTime() - S.t0))
  }

  if (finished) {
    angelStop(S)
    console.info('ANGELPAL-DONE|rows=' + S.index +
      '|shapeStates=' + S.shapeStates + '|shapeFail=' + S.shapeFail +
      '|blockFail=' + S.blockFail + '|badName=' + S.badName +
      '|noRid=' + S.noRid + '|ms=' + (Utils.getSystemTime() - S.t0))
  }
}

// ---------------------------------------------------------------------------
//  注册（顶层：只有函数声明 + 这一段 try）
// ---------------------------------------------------------------------------

try {
  var prev = global.__angelDump
  if (prev && prev.running) {
    console.info('ANGELPAL-PROGRESS|上一次导出还在跑（脚本被重载了），本次不重复启动')
  } else {
    var reg = Utils.getRegistry(Utils.id('minecraft', 'block'))
    if (!reg) {
      console.info('ANGELPAL-ERROR|Utils.getRegistry 返回空，放弃导出')
    } else {
      var S = {
        running: true,
        intervalId: null,
        reg: reg,
        level: null,                 // 进世界后才填
        pos: new BlockPos(0, PROBE_Y, 0),
        it: null,                    // 进世界后才填
        vanilla: null,
        index: 0,
        total: 0,
        t0: 0,
        slices: 0,
        shapeBlocks: 0,
        shapeStates: 0,
        shapeFail: 0,
        blockFail: 0,
        badName: 0,
        noRid: 0
      }
      global.__angelDump = S
      // ⚠️ 不在加载时检查 Client.level —— 客户端脚本在主菜单就加载了，那时它一定是 null。
      //    检查放在 angelTick 的第一片里（见那里），进了世界才开始导。
      S.intervalId = setInterval(function () {
        try { angelTick(S) } catch (e) { angelDie(S, '分片里抛错：' + e) }
      }, 50)
      console.info('ANGELPAL-PROGRESS|已待命：进一次世界就开始导出（每 50ms 一片，每片最多 ' +
        BUDGET_MS + 'ms）。')
    }
  }
} catch (err) {
  // ⚠️ 只能 console.info：console.error 会让 KubeJS 把它记成脚本错误
  console.info('ANGELPAL-ERROR|导出方块调色板失败（不影响游戏，请把这一行交给 agent）：' + err)
}
