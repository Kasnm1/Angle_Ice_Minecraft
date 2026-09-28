# `src/instinct/` —— 本能层

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里本能那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `instinct.js` | **汇总**（普通文件，不是符号链接）：把下面 8 个子文件的导出拼回原来那份 `module.exports`（56 个名字、顺序一字不差）。外部 `require('../instinct/instinct.js')` 不用改；`--selftest` 在这里跑**全部**小节 |
| `config.js` | `CFG` / `fillCfg` / `TIER` / `TIER_NAME` / `ARMOR_RANK` / `HURT_FEET` / `HURT_BELOW` / `STRUCTURE_SIGNS` / `COMBAT_YIELD` / `PASSIVE_POSTS` |
| `core.js` | `install()`（1630 行闭包，整体搬来，内部计时器没拆）、`bodyBusy` / `createCheck` / `settleJob` / `ownsBodyAtCleanup` / `breatheRefused` / `syncSleepState` / `caveBoundary` / `scanColumns*` / `yieldBody` |
| `combat.js` | `mobKind` / `attackCooldownMs` / `combatPlan` / `armorRank` / `pickArmor` / `toolWorn` / `hazardUnder` / `pickStepOff` |
| `survival.js` | `pickEat` / `needBreath` / `effectPlan` / `shoreRingOffsets` / `pickShore` / `mlgStep` / `pickRecovery` |
| `mining.js` | `pickaxeTier` / `needTier` / `bareNameOf` / `pickOre` / `pickCaveStep` / `pickTorchStep` / `darkReport` / `noteDelve` / `pickDelveResume` |
| `pickup.js` | `hdist` / `whoThrew` / `pickPickup` / `pickHarvest` / `pickLoot` / `pickTidy` / `carriedNames` / `carriedTally` / `pickupFailIds` |
| `social.js` | `gazeEngaged` / `pickGaze` / `pickCommand` / `weatherChange` / `followIdlePlan` |
| `home.js` | `recognizeStructures` / `homeFootprint` |
| `testkit.js` | 自测脚手架：`register` / `runSuite` / `bindNs` / `instinctSrc`。**故意不写 `--selftest` 分支**（写了会被 test-all 当成"跑了却零断言"） |

**唯一反过来的是战斗本能**：怪冲她或玩家来时叫停正在跑的命令（`cancelCommands`），
打的时候大部分命令回"在打架"。

`install(bot, state, deps)` 给 bot 挂 `bot.on(...)` 监听 + 起内部计时器，按 tick 决策。
战斗锚点：跟人时 = 人，自己干活时 = 开打位置，leash 12（主人 2026-09-27 确认）。
时间基准在 `util.now()`（测试可注入），**不要直接 `Date.now()`**。

## 循环依赖与共享状态（第 3 步拆分，2026-09-28）

8 个子文件**互相成环**（`core.js` 的 `install()` 要调 `pickOre` / `pickEat` / …，
那些文件又要 `CFG`）。做法照 `src/body/` 的约定：

- 每个子文件 `require` 只引**外部模块**，**绝不** `require` 兄弟文件；
- 自己想要别人提供的名字：常量写 `let X;`，函数写转发壳
  `function X (...a) { return __ns.X.apply(null, a); }`；
- 导出 `function bind (ns) { Object.assign(__ns, ns); X = ns.X; … }`；
- 汇总 `instinct.js` 先 `require` 全部子文件拿到 `__ns = Object.assign({}, …)`，
  再逐个 `bind(__ns)` 回填 —— 所以函数体里写的名字始终指向**同一份真身**。

**共享可变状态只有一份**：`state.instinct`（那个 `I`）由 `install()` 建，只有 `install()` 的闭包读写；
`__ns` 挂在 `module.exports` 上但 `enumerable: false` —— `Object.keys()` 仍是原来那 56 个。

## 本能的判据只许一份（AGENTS.md §5-4）

- 敌对判据：`../world/entity-registry.js` 的 `isHostileEntity`（战斗本能、`hands.threatNear`、
  bridge `/nearby` 都调它）。
- 站位/可替换判据：`../world/place.js` 的 `isStandable` / `exposedToOpen`（含草、藤、雪层，P50）。

## 自测

```bash
$NODE src/instinct/instinct.js --selftest        # 全部小节 —— 345 条（= 拆前条数，一条不少）
$NODE src/instinct/core.js --selftest            # 单个子文件也能跑（config/testkit 没有小节，不写开关分支）
$NODE scripts/smoke/smoke-install.js             # 假 bot 驱动真实的 install()，跑 6 秒不崩
$NODE scripts/smoke/smoke-eat.js                 # 吃东西冒烟
$NODE scripts/smoke/smoke-surface.js             # 上岸冒烟
$NODE scripts/instinct-scheduling-test.js        # 调度/计时器
```

`--selftest` 测的是**纯函数**，真正上线跑的是 `install()` —— 冒烟脚本补的就是这条缝。

## 已知遗留（第 3 步搬移时发现，**没改**，详见 `modpack-study/refactor-p3b/report.md`）

- `scripts/instinct-scheduling-test.js` 在 `vm.runInNewContext` 里把 `instinct.js` 当**单文件**
  加载，靠沙箱注入受控 `setInterval`/`setImmediate`。拆开后 `install()` 是从 `core.js`
  **跨文件 require** 来的，用的是**宿主**计时器，沙箱桩接不到 → 该脚本报红并卡到超时。
  函数内容没问题（`install` 逐字节相同）。修法是把这个脚本也改成「读整个 `src/instinct/` 目录拼起来」，
  但那个文件不在第 3 步 b 的改动白名单里，留待授权。

