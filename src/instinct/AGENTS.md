# `src/instinct/` —— 本能层

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里本能那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `instinct.js` | **汇总**（普通文件，不是符号链接）：把下面 8 个子文件的导出拼回原来那份 `module.exports`（56 个名字、顺序一字不差）。外部 `require('../instinct/instinct.js')` 不用改；`--selftest` 在这里跑**全部**小节 |
| `config.js` | `CFG` / `fillCfg` / `TIER` / `TIER_NAME` / `ARMOR_RANK` / `HURT_FEET` / `HURT_BELOW` / `STRUCTURE_SIGNS` / `COMBAT_YIELD` / `PASSIVE_POSTS` / `URGENT_PLAYER` / `isPlayerUrgent`（2026-09-29 问题 2：`args.urgent === 'player'` = "玩家在聊天里明确叫她"的**唯一判据**，`yieldBody` 用它区分"顺手走路"和"玩家叫的"；默认不放行）。`CFG.loot.radius` 2026-09-29 提到 **32**（跟扫描一致）；`CFG.perception`（2026-09-29 修"走路很乱"扩了一轮：`enabled / radius / everyMs / batchColumns / dy / mergeDist / gap / decayAfterMs / decayRate / goneRadius / tellCooldownMs`(5 分钟) `tellPerMinute`(4) `tellRegionGrid`(16) `idBuildBatch`(500) `clusterSliceMs`(12) `minMoveBlocks`(8) `minRescanMs`(60s) `busyEveryMs`(20s) `phaseWarnMs`(30) `saveMinIntervalMs`(30s)，每条都写了理由）；`CFG.mlg`（2026-09-29 实机修"倒水"：`hurtAt`(6) `hpRatio`(0.5) `homeLethalOnly` `minFall`(4.5) `placeAt`(3.0) `retrieveRetries`(3) `retrieveWalkNear`(3) `pendingMax`(8)，阈值与理由写在注释里） |
| `core.js` | `install()`（1630 行闭包，整体搬来，内部计时器没拆）、`bodyBusy` / `createCheck` / `settleJob` / `ownsBodyAtCleanup` / `breatheRefused` / `playerHurtPlan` / `victimHealth` / `syncSleepState` / `caveBoundary` / `scanColumns*` / `yieldBody`。2026-09-29 加了 `perceptionTimer`（她的余光，见下「野外资源感知」）；同日实机修落地水：`collectWater` 改成"走过去 → 对准 → 右键 + 重试 + 失败如实报坐标原因"，新增 `tryCollectPendingWater`（闲时回去收留下的水，位置只来自 `I.pendingWater`，**不写死坐标**） |
| `combat.js` | `mobKind` / `attackCooldownMs` / `combatPlan` / `fightGearFetchPlan` / `armorRank` / `pickArmor` / `toolWorn` / `hazardUnder` / `pickStepOff`。`fightGearFetchPlan`（2026-09-29 问题 2c）：打架前**要不要为武器/盾去翻精妙背包**的纯判据 —— 怪 ≥ `CFG.combat.fightFromBackpackDist`（默认 5 格）才翻，贴脸不翻（开界面会挨打） |
| `survival.js` | `pickEat` / `needBreath` / `effectPlan` / `shoreRingOffsets` / `pickShore` / `mlgStep` / `mlgFallDamage` / `mlgShouldPlace` / `waterRetrievePlan` / `pickRecovery`；**水下判据只此一份**（2026-09-29）：`blocksWater` / `headInWater` / `waterBreathing` / `oxygenNum` / `mineShouldStop` / `underwaterKeep` / `columnClear` / `breathPlan`；**落地水"该不该倒"与"收到哪一步"的判据只此一份**（2026-09-29 实机修，见下「落地水」） |
| `mining.js` | `pickaxeTier` / `needTier` / `bareNameOf` / `pickOre` / `pickCaveStep` / `pickTorchStep` / `darkReport` / `noteDelve` / `pickDelveResume` |
| `pickup.js` | `hdist` / `whoThrew` / `pickPickup` / `pickHarvest` / `pickLoot` / `pickTidy` / `carriedNames` / `carriedTally` / `pickupFailIds` |
| `social.js` | `gazeEngaged` / `gazeQuotaLeft` / `pickGaze` / `pickCommand` / `weatherChange` / `followIdlePlan`。`gazeQuotaLeft`（2026-09-29 问题 1）：**一个互动窗口里只看一眼**的额度判据 —— `pickGaze` 靠它把"他一直在说话 → 每句都看"收成"每次开窗看一眼" |
| `home.js` | `recognizeStructures` / `homeFootprint` |
| `testkit.js` | 自测脚手架：`register` / `runSuite` / `bindNs` / `instinctSrc`。**故意不写 `--selftest` 分支**（写了会被 test-all 当成"跑了却零断言"） |

**唯一反过来的是战斗本能**：怪冲她或玩家来时叫停正在跑的命令（`cancelCommands`），
打的时候大部分命令回"在打架"。

**走路类命令在战斗中要"玩家标记"（2026-09-29 问题 2）**：`/go` `/move` `/follow` `/wear`
（`/stop` 不带 `hold`）在 `yieldBody` 里除了要进 `COMBAT_YIELD`，还要 `isPlayerUrgent(args)`
（`args.urgent === 'player'`）才放行 —— 否则回"在打架（战斗本能），这条是顺手发的，打完再去"。
因为 mind 自己顺手发的 goto/come_to 也会走到这条路上，会把正在打的架叫停（2026-09-28 13:44
她就是这么被停手打死在 `species:cliff_hanger` 手里的）。
**保命类不吃这个标记**：`/flee`（血低撤退）、`/self_rescue`、`/stop {hold:true}` 照旧放行
（`hold` 本身就是显式信号）。低血自动撤退逻辑不受影响。

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

## 野外资源感知（她的"余光"，2026-09-29）

主人："對野外資源不敏感這個，我實在不知道該怎麼修了"。她以前只有"身边 16 格实体"，
看不见树/矿/黏土/箱子 —— 结果是走出家门就像瞎了。

**三件事，各有各的负责人**：

1. **扫描**（`core.js` 的 `perceptionTimer`，`setInterval` 每 2 秒叫一次，**扫不扫由判据说了算**）：
   调 `world/perception.js` 的 `scanAround`，**复用 `scanColumnsIn`**（按区块柱分段、每柱之间
   `yieldFn()` 让出）。**绝不同步扫一大片** —— 2026-09-28 那次 14 秒卡死就是旧的 `homeTimer`
   同步扫 `home.scanBuilt d=91 13049` 块。每次的单柱最长耗时写进 `I.diagnostics.perception.worstMs`
   （`GET /instinct` 能看）；自测里断言 **< 200ms**。
   `perceptionBusy` 防止上一批没跑完又开一批。
   **2026-09-29 实机"走路很乱"又修了一轮**（`slow perception.scanAround 1020/1308/5154…`、
   `scheduler.maxLagMs 908`）：① 建扫描 ID 名单（整个整合包 registry 2 万多个方块过 `classifyBlock`，
   实测 30ms）改成**每 `idBuildBatch`(500) 个让出一次**并缓存（`registry.__perceptionIds`，
   第二轮 0ms）；② 聚片改走 `clusterAsync`（**和 `cluster` 共用同一个内核 `clusterSteps`**），
   每切完一片或每 `clusterSliceMs`(12ms) 让出；③ 写盘改**异步** `saveAsync` 且**不是每轮写**
   （`shouldSave`：没变化不写、有变化也攒够 30 秒）；④ **少扫**：`perception.shouldRescan` ——
   没怎么动（< `minMoveBlocks` 8 格）且距上次不到 `minRescanMs`(60s) → 不扫；走路/打架/开界面
   放慢到 `busyEveryMs`(20s)；⑤ `slow` 日志报**最慢的那一段**（`r.perf.phases`），不再只报总时长。
2. **判据**（`world/perception.js`，纯函数）：分类用**真实整合包标签**（`knowledge.js` 的
   `load().tags`），不是硬编码名单。实的标签名（2026-09-29 从 `knowledge/generated/gamedata.json`
   1699 个方块标签里查的）：`minecraft:logs` / `minecraft:planks` / `minecraft:leaves` /
   `minecraft:crops` / `minecraft:flowers` / `minecraft:small_flowers` / `minecraft:sand` /
   `minecraft:terracotta` / `minecraft:shulker_boxes` / `forge:ores` / `forge:sand` /
   `forge:gravel` / `forge:chests`（+`forge:chests/wooden|trapped`）/ `forge:barrels` /
   `c:chests` / `lootr:chests`。**不存在的**：`clay`（0 个）、`pumpkin`、`melon`、
   `sugar_cane`（只有 `forge:storage_blocks/sugar_cane`，是物品不是作物）、`lava`（没有"这是岩浆"的标签）。
   → 这几样只能**名字兜底**，兜底规则**只写在 `perception.js` 的 `SPECS` 一处**。
   末影箱：在 `forge:chests` 里但**不算野外容器**（开了也带不走，专门排除，有断言守）。
3. **去开**（`core.js` 的 `tryLoot`）：判据在 `perception.containerTargets`（家里 / 开过 / 太远，
   一份判据不抄第二遍）。**不要求"此刻看得见"** —— 记忆里有、走得到就值得去（人走过箱子、
   转身看不见了还会回去开）。空闲队列里 `loot` 排在最前（`['loot', 'torch', 'harvest', 'mine', 'delve', 'cave']`）：
   火把是长期活，箱子是**一次性**的（这个服只有主人和她，没人替你留着）。**保命的活
   —— 憋气 / 战斗 / 危险 —— 从来不进这个队列**，插队不影响它们。
   `body/containers.js` 的 `storagePlaces` 把记忆里的位置转成"和 `findStorage` 同形"的候选塞进 `checkChests`。

**"没有"和"读不到"必须分开报**（任务书硬性要求）：记忆文件读不出来 → `containerTargets`
返回 `[]`、`tryLoot` 只按看得见的算，`GET /surroundings` 返回 `unloaded` 字段说明哪几柱没读到；
**绝不把"没读到"渲染成"附近没有"**。

### 只说用得上的（2026-09-29 实机修"事件刷屏"）

实机症状：`resource_seen 余光扫到：花 / 砂砾 / 树…` 几秒一条，花、砂砾这种她不缺的也在发。

- **判据**：`perception.worthTelling` —— 只发三类：① 她现在**缺的**（名字命中 needs）；
  ② **值钱的矿**（矿表 `value === 'high'`）；③ **没开过的野外容器**。花 / 砂砾 / 普通树 /
  石头 / 沙 / 黏土（没被点名缺时）→ **不发事件**，但**照样进**【附近看得见的】那一行和资源记忆。
- **"缺什么"的匹配**（`needKeysOf` / `nameHitsNeed`）：方块名是英文 id，主人计划是中文 ——
  加了一层**中文名**（`knowledge/item-names.json`，15535 条整合包真值）才能对上"缺铁"↔"铁矿石"。
  **裸类别名不算具体命中**：计划只说"挖点矿"时**不发**任何矿（"不是所有矿都缺"）；
  说了"去挖点铁矿"才发。事件里的"（你现在正缺XX）"写的是**具体名字**（"铁矿石"/"黏土"），
  不是整句计划。
- **冷却**：按"类别 + 区域网格"（`tellRegionGrid` 16 格），同区同类 `tellCooldownMs`(5 分钟) 只说一次；
  再加**全局每分钟上限** `tellPerMinute`(4)。
- **方向不再 `undefined`**：根因是 `merge()` 新建记录时**只拷了 8 个字段、把 `direction` 丢了**，
  而 `core.js` 又去插值 `it.direction` → 字面量 "undefined"。修在 `merge()`（新记录分支和刷新
  分支都补上 `direction` / `distance`），`core.js` 再兜一道 `it.direction || '附近'`。

## 落地水：只在该倒时倒，倒了必须收回来（2026-09-29 实机）

主人："為什麼他在把家裡放了水？" 实机证据：`mlg 从 5 格高掉下来倒了水，但水没收回来（17,123,6）`。
两个独立问题：

**① 不该倒（5 格摔伤只有 1 颗心）**。原判据只有"落差 ≥ `minFall`"，不看伤害、不看血。
现在判据只此一处，在 `survival.js`：

- `mlgFallDamage({ startY, landY, landName, landSafe, effects })` —— 原版摔伤模型：
  `落差 − 3`，再按 `fall_damage_resetting` 标签（水/干草/黏液/蜂蜜/细雪/蛛网…）归零、
  缓降 = 0、摔落保护每级减 12% 落差。返回 `{ dmg, fall, why }`。
- `mlgShouldPlace(c, cfg)`：
  **家外** —— `预估伤害 ≥ 血量一半` **或** `≥ CFG.mlg.hurtAt`(6) 才倒；
  **家里**（`inHomeArea`）—— 只在**会摔死**（`dmg ≥ 当前血量`）时倒（`homeLethalOnly`）。
  理由：5 格 = 2 点伤害，喝水/收水的麻烦远超收益；家里倒水还会把地板泡了。

**② 倒了一定要收回来**（真根因）：旧的 `collectWater` **没有"走到水边"这一步** ——
落地后她站在水的上面/旁边，`lookAt` 射线够不到水面，右键当然装不上；而且整段 `catch (_) {}`
把异常吞了，事件只能说"没收回来"。现在照 `body/commonsense.js` 的 `fillBucket`
（现成判据，不抄第二遍）：

- 走过去（`CFG.mlg.retrieveWalkNear` 3 格内）→ 对准 `offset(0.5, 0.8, 0.5)` → 右键 →
  失败重试 `retrieveRetries`(3) 次；判据在 `survival.waterRetrievePlan`（返回
  `walk` / `aim` / `give_up` + 原因）。
- 仍失败 → 事件**如实报坐标与原因**（"找不到水源方块" / "身上没有空桶" / "桶没装上水"），
  写进 `state.ledger.note({ route:'mlg', retrieved:false, why })`，并**记进 `I.pendingWater`**。
- `tryCollectPendingWater()`（在 tick 的"真闲着"那一步 ⑩）：身体空着、手上有空桶、目标在
  20 格内时才去收 —— **位置只来自 `I.pendingWater`，绝不写死坐标**。

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
$NODE src/instinct/instinct.js --selftest        # 全部小节（571 条）
$NODE src/instinct/core.js --selftest            # 单个子文件也能跑（160 条；config/testkit 没有小节，不写开关分支）
$NODE src/instinct/survival.js --selftest        # 水下判据（憋气/氧气归一/水下方块/头顶）+ **落地水**（该不该倒 / 收到哪一步）（165 条）
$NODE src/world/perception.js --selftest         # 分类/聚片（含事件过滤 worthTelling、少扫 shouldRescan、写盘 shouldSave）；带**性能断言**（124 条）
$NODE scripts/smoke/smoke-install.js             # 假 bot 驱动真实的 install()，跑 6 秒不崩（8 条）
$NODE scripts/smoke/smoke-eat.js                 # 吃东西冒烟（5 条）
$NODE scripts/smoke/smoke-surface.js             # 上岸冒烟（5 条）
$NODE scripts/instinct-scheduling-test.js        # 调度/计时器（含"氧气事件立即上浮"）（38 条）
```

`--selftest` 测的是**纯函数**，真正上线跑的是 `install()` —— 冒烟脚本补的就是这条缝。

## 已知遗留（第 3 步搬移时发现，**没改**，详见 `modpack-study/refactor-p3b/report.md`）

- ~~`scripts/instinct-scheduling-test.js` 拆开后卡到超时~~ —— 已修（2026-09-28）：脚本改成把 `src/instinct/` 的子文件也载进**同一个 vm 沙箱**，
  `core.js` 的 `setInterval` 用的就是桩。37/37。

