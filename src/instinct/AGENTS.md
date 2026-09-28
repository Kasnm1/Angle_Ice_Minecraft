# `src/instinct/` —— 本能层

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里本能那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `instinct.js` | **汇总**（普通文件，不是符号链接）：把下面 8 个子文件的导出拼回原来那份 `module.exports`（56 个名字、顺序一字不差）。外部 `require('../instinct/instinct.js')` 不用改；`--selftest` 在这里跑**全部**小节 |
| `config.js` | `CFG` / `fillCfg` / `TIER` / `TIER_NAME` / `ARMOR_RANK` / `HURT_FEET` / `HURT_BELOW` / `STRUCTURE_SIGNS` / `COMBAT_YIELD` / `PASSIVE_POSTS` |
| `core.js` | `install()`（1630 行闭包，整体搬来，内部计时器没拆）、`bodyBusy` / `createCheck` / `settleJob` / `ownsBodyAtCleanup` / `breatheRefused` / `playerHurtPlan` / `victimHealth` / `syncSleepState` / `caveBoundary` / `scanColumns*` / `yieldBody` |
| `combat.js` | `mobKind` / `attackCooldownMs` / `combatPlan` / `armorRank` / `pickArmor` / `toolWorn` / `hazardUnder` / `pickStepOff` |
| `survival.js` | `pickEat` / `needBreath` / `effectPlan` / `shoreRingOffsets` / `pickShore` / `mlgStep` / `pickRecovery`；**水下判据只此一份**（2026-09-29）：`blocksWater` / `headInWater` / `waterBreathing` / `oxygenNum` / `mineShouldStop` / `underwaterKeep` / `columnClear` / `breathPlan` |
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

## 玩家受伤：只有真危险才告诉 mind（2026-09-29）

主人实机："她掉一点血每次都问'你没事吧'"。原判据是"48 格内玩家挨打就发 + 20 秒冷却"，
摔一下、擦一下都触发。现在按**严重度**判 —— 判据在 `core.js` 的 `playerHurtPlan()`（纯函数），
阈值在 `CFG.playerHurt`（阈值与理由都写在那里的注释里）：

- ① 血量 ≤ `lowHp`(8) → 危险；
- ② `windowMs`(10s) 内累计掉血 ≥ `burstHp`(6) → 掉得多；
- ③ `windowMs` 内挨打 ≥ `burstHits`(3) → 被连着打。
- 都不满足 = 小伤，**不报**。冷却 `quietMs` 拉到 3 分钟，且**只按"真发出去的那次"算**
  （小伤不占冷却，免得真危险那一下被压掉）。

**玩家血量从哪读**（`core.js` 的 `victimHealth()`）：mineflayer 的 `bot.health` **只对自己**
（`lib/plugins/health.js` 只有 `update_health` 包写它）。别人的血量在**实体 metadata** 里：
`lib/plugins/entities.js:461` 收到 `entity_metadata` 时按
`bot.registry.entitiesByName[entity.name].metadataKeys` 映射，但只挂进局部变量、**不写回 entity**。
所以按同一份 `metadataKeys` 找 `health` 的槽位，再读 `entity.metadata[槽位]`。
**读不到就返回 null**（不是 20、不是 0），`playerHurtPlan` 此时只按 ③ 的挨打次数判 ——
既不猜满血（会漏报）也不猜危险（会误报）。

`playerHurt` 事件的文字写的是"XX 有危险：<理由>"，并带 `reason` 字段（`low_hp`/`burst`/`hits`）。
mind 侧提示词对应的一小段也已改成"小伤不用每次都问，真危险才关心"。

## 水下的东西（2026-09-29 实机：在水底挖沙子差点淹死）

`/mine` 挖的那片沙子在**水底**（水面 y≈63、沙在 y=58–62）。一会儿的经过：
逐块往下挖 → 氧气 8/20 触发憋气 → 上浮换气 → 03:42:37 又潜回去挖同一片 →
03:44 那次跳了 **38 下**没浮上去，氧气掉到 -1 开始掉血（头顶被沙子盖住了）。

判据**只写一份**，在 `survival.js`（`src/bridge/routes/mine.js` 与 `core.js` 共用）：

- `blocksWater(name, props)` —— 「这是水」。以前 `core.js` / `mine.js` 各有手写正则，现在只此一处
  （`waterlogged` 的半砖/楼梯也算）；
- `headInWater(bot)` —— 头（脚底 +1.62）在不在水里；
- `oxygenNum(raw)` —— 氧气归一。**288 这种读数按"读不到"处理**（见下），`clean` 才可信；
- `mineShouldStop(...)` —— `/mine` 还要不要挖；阈值 `CFG.bridgeMine.dryOxygenAt`（**14**，理由写在配置里）；
- `underwaterKeep(...)` —— 水下的目标该不该挖：**附近有干的就先挖干的**（哪怕水下那块值钱），
  只有"只有水下才有" / "值钱且没有干的" / "调用方明确要"才允许。值钱与否查**现成的矿表**
  `knowledge/ores.json` 的 `value`/`tier`（不另编名单）；
- `columnClear(cells, maxUp)` + `breathPlan(...)` —— 憋气往哪走：`up`（照旧跳）/ `swim`（游到旁边
  通到水面的列或最近的岸）/ `dig`（四周全封死才挖头顶，只挖软的、`place.js` 的 `DEADLY` 不挖）。

⚠️ `columnClear` 遇到"一路看到底全是水"判**通**（= 水面还在更上面），不是"被盖住" ——
反了就会让她不去跳、转而去挖。这条被 `scripts/instinct-scheduling-test.js` 抓到过。

`/mine` 的返回里必须带 `stopped: 'need_air' | 'just_breathed'` + `stoppedWhy` + `underwater`：
让她/mind 知道"是我为了保命停的"和"水下有几块、按规则没挖"（AGENTS.md §5-1）。

## 憋气时氧气读数是 288（E）

`bot.oxygenLevel` 来自 mineflayer 的 `entities.js:499`
`Math.round(metas.air_supply / 15)` —— 1.20.1 走的就是这条分支
（`supportFeature('mcDataHasEntityMetadata') === true`，实测），而 `air_supply` 的**原始值**
是 air ticks（满 300）。模组/握手一旦挪了这个槽位，就会读到 288 这种量级。
**不替模组猜槽位、不做 288/15 的换算**（猜错会得出"看起来正常"的假氧气，比读不到更糟），
统一经 `oxygenNum` 判不可信 → 按"读不到"处理。
那个"0.3 秒一拍"是同一个根因：`288 ≥ stopAtOxygen:18` 让 `POST /jump` 第一跳就 "提前成功"退出，
下一拍头还在水里又触发。

## 自测

```bash
$NODE src/instinct/instinct.js --selftest        # 全部小节 —— 条数以实际输出为准
$NODE src/instinct/core.js --selftest            # 单个子文件也能跑（config/testkit 没有小节，不写开关分支）
$NODE src/instinct/survival.js --selftest        # 水下判据（憋气/氧气归一/水下方块/头顶）
$NODE scripts/smoke/smoke-install.js             # 假 bot 驱动真实的 install()，跑 6 秒不崩
$NODE scripts/smoke/smoke-eat.js                 # 吃东西冒烟
$NODE scripts/smoke/smoke-surface.js             # 上岸冒烟
$NODE scripts/instinct-scheduling-test.js        # 调度/计时器（含"氧气事件立即上浮"）
```

`--selftest` 测的是**纯函数**，真正上线跑的是 `install()` —— 冒烟脚本补的就是这条缝。

## 已知遗留（第 3 步搬移时发现，**没改**，详见 `modpack-study/refactor-p3b/report.md`）

- ~~`scripts/instinct-scheduling-test.js` 拆开后卡到超时~~ —— 已修（2026-09-28）：脚本改成把 `src/instinct/` 的子文件也载进**同一个 vm 沙箱**，
  `core.js` 的 `setInterval` 用的就是桩。37/37。

