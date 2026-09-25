// ============================================================================
//  zz_angel_dump_block_palette.js   ——  一次性诊断脚本（v3，安全版）
//
//  目的：把客户端内存里的「方块 → state 个数 + 属性表」倒出来，交给
//        minecraft-bridge 的 /registry/import-palette 导入。
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
//  ⚠️ 前三版踩过的坑（都会让客户端弹「KubeJS startup script errors」窗口）
//
//    v1 的错：
//      `const BuiltInRegistries = Java.loadClass('...BuiltInRegistries')`
//      → 运行期抛 `InternalError: TypeError: redeclaration of var BuiltInRegistries`。
//
//    v2 的错（两个都是错的，而且更危险）：
//      a) 以为 `BuiltInRegistries` 是 KubeJS 预绑定的全局名，改成直接用它
//         → 它**根本不是**绑定。已用 `javap` 导出 `BuiltinKubeJSPlugin.registerBindings`
//         的完整绑定表核对过：53 个名字里没有 `BuiltInRegistries`。会 ReferenceError。
//      b) 把 `const OUT_NAME = ...` 写在 `try` **外面**
//         → 一旦抛异常就是未捕获的 startup script error，直接弹窗挡住客户端。
//
//  🔴 v3 遵守的铁律（都是字节码级核实过的）
//
//    1. **不用 `const`。** Rhino 的 `Interpreter.doSetConstVar` 会在运行期抛
//       `msg.var.redecl`（"redeclaration of var X"）。本整合包里所有**能正常跑**的
//       KubeJS 脚本（effect.js / vefcblocks.js / vefcfoods.js）**一个 `const` 都没有**，
//       只用 `let`。所以这里只用 `let`。
//    2. **不调 `Java.loadClass`。** 用 KubeJS 自己的绑定：
//       `Utils.getRegistry(Utils.id('minecraft','block'))` 直接拿到方块注册表。
//       （`JavaWrapper` 只有 `loadClass / tryLoadClass / createConsole`，**没有 `Java.from`**，
//        所以遍历一律用 Java 集合自带的 `iterator()/hasNext()/next()`。）
//    3. **整个函数体都在 `try` 里。** 任何异常最多只写一行 `console.info`。
//    4. **只用 `console.info`，绝不用 `console.error`。** KubeJS 把 error 级日志算作
//       脚本错误 → `common.properties` 里 `startupErrorGUI=true` → 弹阻断式窗口。
//
//  输出：不写文件，直接**逐行打进日志**，前缀 `ANGELPAL|`
//        每行：  <注册序号>|<state个数>|<注册表数字id>|<方块名>|<属性规格>
//        属性规格形如  facing:north,south,west,east;waterlogged:true,false
//        —— 属性按名字排序、取值按声明顺序，这正是全局 state id 的分配顺序。
//
//        为什么要有「注册序号」：它就是 state id 前缀和的展开位置。
//        `entrySet()` 的遍历顺序 = 注册顺序 = state id 分配顺序，所以
//          baseStateId(第 i 个) = 前面所有方块的 count 之和
//        导入端用前缀和算出 base，再用 F3 锚点校验。
//        **序号 0..1002 必须与原版 minecraft-data 的方块 id 一一对上** ——
//        这是一个极强的自校验（对不上说明遍历顺序不是注册顺序）。
//
//        「注册表数字id」这一列在拿不到时是 -1：它走
//        `RegistryInfo.getVanillaRegistry().getId(block)`，有 SRG 重映射风险，
//        所以只当**交叉校验**用，序号才是主数据。
//
//  怎么用：重启一次客户端就会自动跑。
//  跑完：把 `logs/latest.log` 交给 agent（或自己 grep `ANGELPAL`）。
//  怎么删：直接删掉这个文件。它**只读注册表、只写日志**，不碰任何游戏内容。
// ============================================================================

StartupEvents.postInit(event => {
  // 整个函数体都在 try 里：连 let 声明本身都被保护。
  try {
    let MARK = 'ANGELPAL|'

    // ---- 1. 拿方块注册表：纯 KubeJS 绑定，不调 Java.loadClass ----
    // Utils 绑定的是 UtilsWrapper，有 getRegistry(ResourceLocation) → RegistryInfo。
    // 用 Utils.id(a, b) 构造 ResourceLocation，避免依赖 String → ResourceLocation 的隐式转换。
    let reg = Utils.getRegistry(Utils.id('minecraft', 'block'))
    if (!reg) {
      console.info(MARK + 'ERROR|Utils.getRegistry 返回空，放弃导出')
      return
    }

    // 数字 id 的取法（可能失败）：RegistryInfo.getVanillaRegistry() → Registry.getId(block)
    let vanilla = null
    try { vanilla = reg.getVanillaRegistry() } catch (e0) { vanilla = null }

    // ---- 2. 遍历。entrySet() 的顺序就是 state id 的分配顺序 ----
    let it = reg.entrySet().iterator()
    let index = 0
    let zeroCount = 0
    let badName = 0
    let noRid = 0

    while (it.hasNext()) {
      let entry = it.next()
      let block = entry.getValue()

      // 方块名：ResourceKey.location() 是首选；退路是 ResourceKey.toString()
      let name = ''
      try {
        name = String(entry.getKey().location())
      } catch (e1) {
        try { name = String(entry.getKey()) } catch (e2) { name = '?unknown?' }
      }
      if (name.indexOf(':') < 0) badName++

      // 数字注册表 id（交叉校验用；拿不到就 -1）
      let rid = -1
      if (vanilla !== null) {
        try { rid = vanilla.getId(block) } catch (e4) { rid = -1 }
      }
      if (rid < 0) noRid++

      // state 个数 + 属性规格
      let count = 0
      let spec = '?'
      try {
        let def = block.getStateDefinition()
        count = def.getPossibleStates().size()
        if (count <= 0) zeroCount++

        let parts = []
        let pit = def.getProperties().iterator()
        while (pit.hasNext()) {
          let prop = pit.next()
          let vals = []
          let vit = prop.getPossibleValues().iterator()
          while (vit.hasNext()) vals.push(String(vit.next()))
          parts.push(String(prop.getName()) + ':' + vals.join(','))
        }
        spec = parts.join(';')
        // 属性规格理论上不会很长；超过 400 字符说明 API 返回了意外东西，截断保日志可读
        if (spec.length > 400) spec = spec.substring(0, 400) + '...'
      } catch (e3) {
        spec = '?'
      }

      console.info(MARK + index + '|' + count + '|' + rid + '|' + name + '|' + spec)
      index++
    }

    // ---- 3. 自检行：一眼看出成没成 ----
    // zeroCount 必须远小于 rows（大多数方块只有 1 个 state，0 本身正常；
    // 但如果 rows 正常而 count 全是 0，说明 getPossibleStates() 这条路没通）。
    // noRid 等于 rows 说明数字 id 那列没通 —— 不影响导入（序号是主数据）。
    console.info('ANGELPAL-HEADER|rows=' + index
      + '|zeroCount=' + zeroCount
      + '|noRid=' + noRid
      + '|badName=' + badName)
    console.info('ANGELPAL-DONE|rows=' + index)
  } catch (err) {
    // ⚠️ 只能 console.info：console.error 会让 KubeJS 弹 startup script errors 窗口
    console.info('ANGELPAL-ERROR|导出方块调色板失败（不影响游戏，请把这一行交给 agent）：' + err)
  }
})
