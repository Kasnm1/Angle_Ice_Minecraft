// ============================================================================
//  zz_angel_dump_block_palette.js   ——  一次性诊断脚本（v2，安全版）
//
//  目的：把客户端内存里的「方块 state 调色板」倒出来，交给 minecraft-bridge 导入。
//
//  为什么要它：
//    1.13 之后服务端在 chunk_data 里只发**全局调色板数字 ID**，方块名靠客户端本地
//    注册表翻译。机器人只有原版 minecraft-data，所以模组方块查不到 →
//    `b.type` 恒为 undefined、`b.name` 恒为空串。而且梯子的两层判据都是
//    `block.type === ladderId`，所以**调色板是梯子问题的前置条件**。
//
//    从模组 jar 的 blockstates/*.json 反推 state 数**结构性地不可能**（MC 允许
//    variants 的键省略属性当通配符，glass_trapdoor 真值 64 态只数得出 16 态），
//    唯一精确来源就是**这个正在跑的客户端**。
//
//  ⚠️ v2 修掉的三个真 bug（v1 会让客户端弹「KubeJS startup script errors」窗口）
//
//    1. `const BuiltInRegistries = Java.loadClass('...BuiltInRegistries')` 会报
//       `redeclaration of var BuiltInRegistries`。
//       原因：`Java.loadClass` **自己就会把类的简单名声明进脚本作用域**，
//       而 `BuiltInRegistries` 更是 KubeJS 预绑定好的全局名（见
//       `ScriptManager.registerBindings`）。⇒ **永远不要写 `const X = Java.loadClass('...X')`**。
//       v2 直接使用预绑定的全局，**一次 `Java.loadClass` 都不调**。
//    2. `Java.from(...)` **不存在**。`JavaWrapper` 只有 `loadClass / loadJavaClass /
//       tryLoadClass / getLogger / createConsole`。v2 用 Java 集合自带的
//       `iterator()/hasNext()/next()` 遍历。
//    3. `console.error(...)` 会被 KubeJS 记成脚本错误 → 弹出那个阻断式窗口。
//       v2 **只用 `console.info`**，并且整体包在 try/catch 里，
//       任何异常都只写一行 info，**绝不让客户端启动被挡住**。
//
//  输出（两选一，按可靠性排序；两条路都不会抛出去）：
//    A. 文件：`<游戏目录>/angel_block_palette.json`（用预绑定的 JsonIO + Utils，不调 loadClass）
//       { "generatedBy": "...", "stateIdRoute": "...", "rows": ["196|4654|8|minecraft:ladder|facing:...", ...] }
//    B. 兜底：如果写文件失败，就把每一行打到日志，前缀 `ANGELPAL|`
//       （用 `logs/latest.log` 里的行来还原，效果一样，只是日志会大 ~2 MB）
//
//  怎么用：重启一次客户端就会自动跑。
//  跑完：把 `angel_block_palette.json`（或 latest.log）交给 agent。
//  怎么删：直接删掉这个文件。它**只读注册表**，除了那一个输出文件不碰任何东西。
// ============================================================================

StartupEvents.postInit(event => {
  const OUT_NAME = 'angel_block_palette.json'
  const MARK = 'ANGELPAL|'

  // 收集一行数据：blockRegistryId | 第一个state的全局id | state个数 | 方块名 | 属性规格
  // 属性规格形如  facing:north,south,west,east;waterlogged:true,false
  // —— 属性按名字排序、取值按声明顺序，这正是全局 state id 的分配顺序。
  try {
    // ---- 1. 拿 state 的全局 id ----
    // 1.20.1 里这个 API 的名字有版本差异，三条路线依次试，第一条能用的就固定下来。
    // 全部用 typeof 探测 + try 包住：**探测本身不许抛**。
    let route = null
    const stateIdOf = (st) => {
      if (route === null || route === 'BlockState.getId') {
        try { if (typeof st.getId === 'function') { const v = st.getId(); route = 'BlockState.getId'; return v } } catch (e) {}
      }
      if (route === null || route === 'Block.getId') {
        try { if (typeof Block.getId === 'function') { const v = Block.getId(st); route = 'Block.getId'; return v } } catch (e) {}
      }
      if (route === null || route === 'Block.BLOCK_STATE_REGISTRY') {
        try {
          if (Block.BLOCK_STATE_REGISTRY) {
            const v = Block.BLOCK_STATE_REGISTRY.getId(st); route = 'Block.BLOCK_STATE_REGISTRY'; return v
          }
        } catch (e) {}
      }
      return -1
    }

    // ---- 2. 遍历方块注册表 ----
    // 用 entrySet().iterator()，不用 Java.from（它不存在）。
    const reg = BuiltInRegistries.BLOCK
    const rows = []
    let noId = 0
    let it = reg.entrySet().iterator()
    while (it.hasNext()) {
      const entry = it.next()
      const rl = String(entry.getKey().location())
      const block = entry.getValue()
      const blockId = reg.getId(block)

      const def = block.getStateDefinition()
      const states = def.getPossibleStates()
      const count = states.size()

      // StateDefinition 内部按创建顺序排列，而创建顺序就是全局 state id 的分配顺序，
      // 所以第一个 state 的 id 就是该方块的 base。
      let first = -1
      if (count > 0) first = stateIdOf(states.get(0))
      if (first < 0) noId++

      // 属性规格：getProperties() 是按名字排序的集合，取值按声明顺序
      let spec = ''
      try {
        const props = def.getProperties()
        const parts = []
        const pit = props.iterator()
        while (pit.hasNext()) {
          const prop = pit.next()
          const vals = []
          const vit = prop.getPossibleValues().iterator()
          while (vit.hasNext()) vals.push(String(vit.next()))
          parts.push(String(prop.getName()) + ':' + vals.join(','))
        }
        spec = parts.join(';')
      } catch (pe) {
        spec = '?'
      }

      rows.push(blockId + '|' + first + '|' + count + '|' + rl + '|' + spec)
    }

    // ---- 3. 先报一行头，方便一眼看出成没成、用的哪条 API ----
    console.info('ANGELPAL-HEADER|blocks=' + rows.length
      + '|stateIdRoute=' + (route === null ? 'none' : route)
      + '|noStateId=' + noId)

    // ---- 4. 首选：写成文件 ----
    // JsonIO 是 KubeJS 预绑定的全局（`BuiltinKubeJSPlugin` 的绑定表里有），
    // 它的签名是 `write(java.nio.file.Path, JsonObject)`。
    // 两种拿 Path 的写法依次试 —— 都在 try 里，都不行就走第 5 步的日志兜底：
    //   ① 直接传字符串：KubeJS 注册过 String → Path 的类型转换器（`registerTypeWrappers`）；
    //   ② `Utils.getPath(...)`：⚠️ 注意 `Utils` 绑定的是 `UtilsWrapper`，**它没有 getPath**
    //      （`getPath` 在 `UtilsJS` 上，而 `UtilsJS` 没被绑定）。所以这条基本会失败，
    //      留着只是为了"万一这版 KubeJS 换了绑定"。
    const payload = {
      generatedBy: 'zz_angel_dump_block_palette.js v2',
      stateIdRoute: route === null ? 'none' : route,
      rowFormat: 'blockRegistryId|firstStateId|count|name|propSpec',
      rows: rows
    }
    let wrote = false
    let where = ''
    try {
      JsonIO.write(OUT_NAME, payload)
      wrote = true
      where = OUT_NAME + '（相对游戏目录）'
    } catch (fe1) {
      try {
        const target = Utils.getPath(OUT_NAME)
        JsonIO.write(target, payload)
        wrote = true
        try { where = String(target.toAbsolutePath()) } catch (e) { where = OUT_NAME }
      } catch (fe2) {
        wrote = false
      }
    }

    if (wrote) {
      console.info('ANGELPAL-DONE|file=' + where + '|rows=' + rows.length)
      return
    }

    // ---- 5. 兜底：文件写不了就把每行打进日志（前缀 ANGELPAL|）----
    console.info('ANGELPAL-FALLBACK|写文件失败，改为逐行打日志（日志会大 ~2MB，不影响游戏）')
    for (let i = 0; i < rows.length; i++) {
      console.info(MARK + rows[i])
    }
    console.info('ANGELPAL-DONE|file=(log)|rows=' + rows.length)
  } catch (e) {
    // ⚠️ 只能用 console.info：console.error 会让 KubeJS 弹「startup script errors」
    //    窗口挡住客户端启动。这个脚本坏掉不该影响玩家玩游戏。
    console.info('ANGELPAL-ERROR|导出方块调色板失败（不影响游戏）：' + e)
  }
})
