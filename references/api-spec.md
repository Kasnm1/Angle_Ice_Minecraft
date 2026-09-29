# Minecraft Bridge API 规格（自动生成）

> ⚠️ **本文件由 `scripts/gen-api-spec.js` 生成，不要手改。**
> 事实来源是路由快照 [`routes.json`](routes.json)（由 `scripts/routes-test.js` 守着）
> + 各路由文件里的说明注释。路由有增减时跑 `node scripts/gen-api-spec.js` 重新生成；
> `scripts/test-all.js` 会检查本文件与快照一致（过期即报错）。

Base URL：`http://127.0.0.1:${MC_BRIDGE_PORT:-3001}` · `Content-Type: application/json` · 无鉴权（只绑 `127.0.0.1`）

> Windows / 有代理的环境一律 `curl --noproxy '*'` —— 代理会劫持 localhost。

## 路由总表

共 140 条（bridge 60 · hands 75 · commonsense 5）。

| 方法 | 路径 | 文件 | 用途 | 主要参数 |
|---|---|---|---|---|
| `GET` | `/block` | `src/bridge/routes/inspect.js` | 读一个方块（单格或整列） | — |
| `GET` | `/chatlog` | `src/bridge/routes/inspect.js` | 最近收到的聊天 / 系统消息 | — |
| `GET` | `/chests/unseen` | `src/body/index.js` | 附近没开过的箱子 | — |
| `GET` | `/commands` | `src/body/index.js` | 服务端认得的命令（含可用的传送类） | — |
| `GET` | `/config` | `src/bridge/routes/inspect.js` | 生效的配置（不含密钥），离线也可读 | — |
| `GET` | `/container` | `src/body/index.js` | 当前界面里有什么 | — |
| `GET` | `/containers/seen` | `src/body/index.js` | 最近看过的箱子里有什么 | — |
| `GET` | `/curios` | `src/body/index.js` | 饰品栏里有什么 | — |
| `GET` | `/debug/craftgrid` | `src/body/index.js` | 合成台 / 背包格子的原始快照 | — |
| `GET` | `/debug/follow` | `src/body/index.js` | 跟随循环的状态与上次为什么停 | — |
| `GET` | `/debug/mvblock` | `src/body/index.js` | &y&z 寻路器眼里这一格是什么 | — |
| `GET` | `/debug/packets` | `src/bridge/routes/diag.js` | 最近的原始包类型统计 | — |
| `GET` | `/debug/pathfinder` | `src/bridge/routes/inspect.js` | 寻路器当前的 goal / movements / 状态 | — |
| `GET` | `/debug/payloads` | `src/body/index.js` | 最近收到的模组原始包 | — |
| `GET` | `/debug/registries` | `src/bridge/routes/diag.js` | 已落盘的注册表清单 | — |
| `GET` | `/debug/registry` | `src/bridge/routes/diag.js` | 查一张已落盘的注册表 | — |
| `GET` | `/debug/route` | `src/bridge/routes/inspect.js` | 上一次寻路算出来的路线 | — |
| `GET` | `/debug/shape-fixes` | `src/body/index.js` | 碰撞箱兜底修了几次 | — |
| `GET` | `/debug/shelter-probe` | `src/bridge/routes/inspect.js` | 避难所探测的中间数组 | — |
| `GET` | `/debug/soph` | `src/body/index.js` | 精妙背包最后一次同步 | — |
| `GET` | `/doors` | `src/body/index.js` | 附近的门与"我开过还开着的" | — |
| `GET` | `/entities` | `src/bridge/routes/body.js` | 附近实体原始列表 | `limit` |
| `GET` | `/equipment` | `src/body/index.js` | 装备 / 饥饿 / 饰品 / 背包 | — |
| `GET` | `/ftbq/completed` | `src/bridge/routes/diag.js` | 任务书哪些做完了 | — |
| `GET` | `/ftbq/recent` | `src/body/index.js` | 最近的任务书进度包 | — |
| `GET` | `/health` | `src/bridge/routes/inspect.js` | 血量 / 饥饿 / 氧气 | — |
| `GET` | `/instinct` | `src/bridge/routes/diag.js` | 本能层状态与诊断 | — |
| `GET` | `/instinct/events` | `src/bridge/routes/diag.js` | 本能最近的事件流 | `since` |
| `GET` | `/inventory` | `src/bridge/routes/inspect.js` | 背包里有什么 | — |
| `GET` | `/inventory/ledger` | `src/bridge/routes/diag.js` | 物品账（背包每次进出记了什么） | `since` |
| `GET` | `/item` | `src/bridge/routes/inspect.js` | 物品注册表注入报告 / 查询 | — |
| `GET` | `/knowledge` | `src/bridge/routes/inspect.js` | 整合包知识库概览 | — |
| `GET` | `/knowledge/search` | `src/bridge/routes/inspect.js` | 查知识库（关键词） | — |
| `GET` | `/landmarks` | `src/body/index.js` | 看得见的地标：传送石碑 / 村庄 | — |
| `GET` | `/layout/status` | `src/body/index.js` | 布局摆到哪了 | — |
| `GET` | `/light` | `src/body/index.js` | 这里多亮 / 要不要插火把 | — |
| `GET` | `/look_around` | `src/body/index.js` | &below&above 转一圈看看（把看得见的方块报回来） | — |
| `GET` | `/memory` | `src/bridge/routes/inspect.js` | 读她的记忆（journal + 状态快照） | — |
| `GET` | `/nearby` | `src/bridge/routes/inspect.js` | 附近实体与掉落物（按敌对分类） | — |
| `GET` | `/palette` | `src/bridge/routes/palette.js` | 当前调色板加载情况 | — |
| `GET` | `/palette/block` | `src/bridge/routes/palette.js` | 查一个方块名对应的 state id | — |
| `GET` | `/palette/climbable` | `src/bridge/routes/palette.js` | 可攀爬方块名单（梯子 / 藤蔓…） | — |
| `GET` | `/palette/state` | `src/bridge/routes/palette.js` | 查一个 state id 对应的方块 | — |
| `GET` | `/players` | `src/bridge/routes/inspect.js` | 在线玩家与距离 | — |
| `GET` | `/plugins` | `src/bridge/routes/body.js` | 装了哪些 mineflayer 插件 | — |
| `GET` | `/position` | `src/bridge/routes/inspect.js` | 她的坐标与朝向 | — |
| `GET` | `/project/status` | `src/body/index.js` | 工程施工进度 | — |
| `GET` | `/recipes` | `src/bridge/routes/inspect.js` | 查一条配方在整合包里怎么做 | — |
| `GET` | `/resources` | `src/bridge/routes/diag.js` | 资源记忆原文（2026-09-29）：她"看过的"野外资源 | — |
| `GET` | `/scan` | `src/bridge/routes/scan.js` | 扫附近方块 / 实体，按名字汇总数量 | — |
| `GET` | `/state` | `src/bridge/routes/inspect.js` | 上一次缓存的状态快照 | — |
| `GET` | `/status` | `src/bridge/routes/inspect.js` | 连接状态 + 天色 / 遮挡 | — |
| `GET` | `/surroundings` | `src/bridge/routes/scan.js` | 她的"余光"：周围约 32 格看得见的资源，分类 + 聚片 + 按"她现在缺什么"排好序 | — |
| `GET` | `/survey` | `src/body/index.js` | 地形普查（脚下这一圈是什么） | — |
| `POST` | `/activate` | `src/bridge/routes/gather.js` | 右键一个方块（按钮 / 拉杆…） | `x, y, z, face, passableAfter` |
| `POST` | `/animal` | `src/body/commonsense.js` | 喂 / 繁殖 / 剪羊毛 / 挤奶：右键动物，核对（小崽多了、羊毛多了、奶桶多了） | — |
| `POST` | `/attack` | `src/bridge/routes/body.js` | 近战攻击（不带目标时自动挑敌对怪，排除 Boss） | `target, radius` |
| `POST` | `/backpack/open` | `src/body/index.js` | 打开精妙背包 | — |
| `POST` | `/backpack/tidy` | `src/body/index.js` | 整理精妙背包 | — |
| `POST` | `/bucket` | `src/body/commonsense.js` | 空桶去装水：找最近的**水源**（流动的水装不了），右键装满（cs-32） | — |
| `POST` | `/chat` | `src/bridge/routes/body.js` | 在游戏里说一句话 | `message, messages, gapMs` |
| `POST` | `/chests/check` | `src/body/index.js` | 去把没开过的箱子开一遍 | — |
| `POST` | `/climb` | `src/bridge/routes/gather.js` | 攀爬（上 / 下） | `x, y, z, maxMs, stepMs, autoOpen` |
| `POST` | `/climb_down` | `src/body/index.js` | 爬梯子 / 藤蔓往下 | — |
| `POST` | `/climb_up` | `src/body/index.js` | 爬梯子 / 藤蔓往上 | — |
| `POST` | `/cmd` | `src/body/index.js` | 跑一条斜杠命令（管理员命令要玩家原话） | — |
| `POST` | `/collect` | `src/bridge/routes/gather.js` | 去捡地上的某种掉落物 | `itemName, count` |
| `POST` | `/command` | `src/bridge/routes/move.js` | 转发一条斜杠命令（注意权限） | `command` |
| `POST` | `/container/close` | `src/body/index.js` | 关上当前打开的界面 | — |
| `POST` | `/container/deposit` | `src/body/index.js` | 往打开的容器里存东西 | — |
| `POST` | `/container/open` | `src/body/index.js` | 右键打开任意方块的界面 | — |
| `POST` | `/container/put` | `src/body/index.js` | 放进某一格 | — |
| `POST` | `/container/sort` | `src/body/index.js` | 整理打开的容器 | — |
| `POST` | `/container/take` | `src/body/index.js` | 从某一格拿出来 | — |
| `POST` | `/container/withdraw` | `src/body/index.js` | 从打开的容器里取东西 | — |
| `POST` | `/control` | `src/bridge/routes/gather.js` | 直接给移动马达（前后左右） | `durationMs` |
| `POST` | `/cook_pot` | `src/body/index.js` | 用厨锅做菜 | — |
| `POST` | `/craft` | `src/bridge/routes/gather.js` | 原版配方合成 | `itemName, count` |
| `POST` | `/craft2` | `src/body/index.js` | 按**整合包真实配方**合成 | — |
| `POST` | `/curios/equip` | `src/body/index.js` | 戴上饰品 | — |
| `POST` | `/curios/unequip` | `src/body/index.js` | 摘下饰品 | — |
| `POST` | `/debug/click` | `src/body/index.js` | 原样点一个窗口格子（逆向用） | — |
| `POST` | `/debug/payload` | `src/body/index.js` | 原样发一个模组消息（逆向用） | — |
| `POST` | `/debug/returngrid` | `src/body/index.js` | 把合成格里的东西放回背包 | — |
| `POST` | `/debug/seq` | `src/body/index.js` | 连续点一串格子并记录服务端回包 | — |
| `POST` | `/delve` | `src/body/index.js` | 往下挖矿道（带火把、记"下过矿"） | — |
| `POST` | `/door` | `src/body/index.js` | 开 / 关门（她会随手关回自己开的门） | — |
| `POST` | `/doors/forget-left-open` | `src/body/index.js` | 忘掉"我开过还开着的门"清单 | — |
| `POST` | `/drop` | `src/bridge/routes/move.js` | 丢出手上的东西（可丢给某个玩家） | `itemName, count, playerName` |
| `POST` | `/eat` | `src/body/index.js` | 吃（不给名字自己挑） | — |
| `POST` | `/equip` | `src/bridge/routes/body.js` | 穿装备（auto 时按判据自己挑） | `itemName, destination, auto, want` |
| `POST` | `/farm` | `src/body/index.js` | 收成熟作物并补种 | — |
| `POST` | `/fish` | `src/body/commonsense.js` | 钓鱼：找露天的水面，甩竿等咬钩（mineflayer bot.fish 听"钓鱼粒子"），核对背包真的多了东西 | — |
| `POST` | `/flee` | `src/bridge/routes/diag.js` | 血量低时撤退 | `distance, fromX, fromY` |
| `POST` | `/follow` | `src/bridge/routes/gather.js` | 跟着某个玩家走 | `playerName` |
| `POST` | `/ftbq/claim` | `src/body/index.js` | 领任务奖励 | — |
| `POST` | `/ftbq/claim_all` | `src/body/index.js` | 一键全领 | — |
| `POST` | `/ftbq/claim_choice` | `src/body/index.js` | 多选一奖励 | — |
| `POST` | `/ftbq/submit` | `src/body/index.js` | 交任务书任务 | — |
| `POST` | `/give` | `src/body/index.js` | 给她东西（服务端 /give，走管理员命令白名单） | — |
| `POST` | `/go` | `src/body/index.js` | 走过去（寻路；返回 arrived 与走了多远） | — |
| `POST` | `/instinct` | `src/bridge/routes/diag.js` | 配置本能（告诉它“家在哪”等） | — |
| `POST` | `/inventory/sort` | `src/body/index.js` | 整理自己的背包 | — |
| `POST` | `/jump` | `src/bridge/routes/diag.js` | 跳一下（浮上水面 / 越过一格） | `durationMs, stopAtOxygen` |
| `POST` | `/knowledge/search` | `src/bridge/routes/inspect.js` | 查知识库（POST 形式，关键词可含非 ASCII） | — |
| `POST` | `/layout/cancel` | `src/body/index.js` | 取消一份布局 | — |
| `POST` | `/layout/furnish` | `src/body/index.js` | 按布局摆家具 | — |
| `POST` | `/layout/save` | `src/body/index.js` | 存一份家具布局 | — |
| `POST` | `/layout/zone` | `src/body/index.js` | 标一个区"要重新想" | — |
| `POST` | `/light_up` | `src/body/index.js` | 插火把（手上没有就先补 16 根） | — |
| `POST` | `/look` | `src/bridge/routes/body.js` | 转头看玩家或坐标 | `playerName, x, y, z` |
| `POST` | `/make_torches` | `src/body/index.js` | 做火把 | — |
| `POST` | `/memory` | `src/bridge/routes/inspect.js` | 往记忆里写一条（note / chat / plan…） | `text, type` |
| `POST` | `/mine` | `src/bridge/routes/mine.js` | 挖指定方块（可只挖看得见的 / 不挖水下） | `blockName, byItem, count, maxRadius, allowUnderwater, abort` |
| `POST` | `/motor` | `src/body/index.js` | 直接给移动马达（左右键按住） | — |
| `POST` | `/move` | `src/bridge/routes/move.js` | 走到指定坐标 | `x, y, z` |
| `POST` | `/nudge` | `src/body/index.js` | 朝某个方向小挪一下（卡住时脱困） | — |
| `POST` | `/pickup` | `src/bridge/routes/pickup.js` | 捡附近掉落物（走得到才捡，预算内） | `radius, count, timeoutMs, budgetMs, ids` |
| `POST` | `/place` | `src/bridge/routes/place.js` | 在指定位置放一个方块 | `itemName, x, y, z, confirmMs, mount` |
| `POST` | `/place_structure` | `src/body/index.js` | 放一个结构（建筑） | — |
| `POST` | `/project/cancel` | `src/body/index.js` | 取消工程 | — |
| `POST` | `/project/save` | `src/body/index.js` | 存一份工程 | — |
| `POST` | `/project/work` | `src/body/index.js` | 推进工程（放方块） | — |
| `POST` | `/reconnect` | `src/bridge/routes/inspect.js` | 手动重连（自动重试放弃后用） | — |
| `POST` | `/registry/import-palette` | `src/bridge/routes/palette.js` | 导入服务端方块调色板 | — |
| `POST` | `/ride` | `src/body/commonsense.js` | 上下载具；矿车往前推；坐船直线开过水面（实验：见 boatTo） | — |
| `POST` | `/self_rescue` | `src/body/index.js` | 自救（卡住 / 掉坑时脱困） | — |
| `POST` | `/shelter` | `src/bridge/routes/place.js` | 逐格套用 `/place` 已有的几何判定去放。 | `itemName, blocks` |
| `POST` | `/sleep` | `src/body/index.js` | 去睡觉（就近找床） | — |
| `POST` | `/smelt` | `src/body/index.js` | 熔炉 / 烟熏炉 / 高炉 | — |
| `POST` | `/stop` | `src/bridge/routes/diag.js` | 停下当前动作（hold=true 是“站着别动”） | — |
| `POST` | `/storage/loot` | `src/body/index.js` | 去开没开过的野外箱子并拿走 | — |
| `POST` | `/storage/organize` | `src/body/index.js` | 整理家里的仓库（含精妙背包倒出来归位） | — |
| `POST` | `/till` | `src/body/commonsense.js` | 锄地开新地：泥土/草方块 → 耕地（cs-31）。默认只锄 4 格内有水的（没水会退化回泥土，cs-04） | — |
| `POST` | `/unequip` | `src/body/index.js` | 脱下装备 | `slot` |
| `POST` | `/unstick` | `src/bridge/routes/move.js` | 卡住时脱困 | `x, y, z, reason, timeoutMs` |
| `POST` | `/use` | `src/body/index.js` | 右键 | — |
| `POST` | `/wake` | `src/body/index.js` | 醒来 | — |
| `POST` | `/wear` | `src/body/index.js` | 穿戴（盔甲 / 模组装备 / 饰品） | — |
| `POST` | `/wiggle` | `src/body/index.js` | 原地小幅抖动（挣脱碰撞箱 / 卡角） | — |

<!-- END GENERATED -->
