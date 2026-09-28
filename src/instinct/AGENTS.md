# `src/instinct/` —— 本能层

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里本能那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `instinct.js` | 不过大脑、身体自己做的事：战斗、拾取、收庄稼、挖看得见的矿、开宝箱、逛洞、搭路、落地水、睡觉、换护甲、危险方块退开、转头看人、工具快坏提醒、饿了就吃、憋气上浮、中毒凋零、天气…。在 **bridge 进程内**，不走 HTTP；身体空着时自己干，任何会动身体的 POST 一到就让出（`yieldBody`）|

**唯一反过来的是战斗本能**：怪冲她或玩家来时叫停正在跑的命令（`cancelCommands`），
打的时候大部分命令回"在打架"。

`install(bot, state, deps)` 给 bot 挂 `bot.on(...)` 监听 + 起内部计时器，按 tick 决策。
战斗锚点：跟人时 = 人，自己干活时 = 开打位置，leash 12（主人 2026-09-27 确认）。
时间基准在 `util.now()`（测试可注入），**不要直接 `Date.now()`**。

## 本能的判据只许一份（AGENTS.md §5-4）

- 敌对判据：`../world/entity-registry.js` 的 `isHostileEntity`（战斗本能、`hands.threatNear`、
  bridge `/nearby` 都调它）。
- 站位/可替换判据：`../world/place.js` 的 `isStandable` / `exposedToOpen`（含草、藤、雪层，P50）。

## 自测

```bash
$NODE src/instinct/instinct.js --selftest        # 纯函数（pick* / *Plan / need*）
$NODE scripts/smoke/smoke-install.js             # 假 bot 驱动真实的 install()，跑 6 秒不崩
$NODE scripts/smoke/smoke-eat.js                 # 吃东西冒烟
$NODE scripts/smoke/smoke-surface.js             # 上岸冒烟
$NODE scripts/instinct-scheduling-test.js        # 调度/计时器
```

`--selftest` 测的是**纯函数**，真正上线跑的是 `install()` —— 冒烟脚本补的就是这条缝。

## 第 3 步会拆

`instinct.js`（3556 行）第 3 步按本能拆文件：纯函数与对应自测按本能分文件，
`install()` 里的计时器拆成 `installX(ctx)`，`core.js` 管 `I` / `runJob` / `bodyBusy` /
`yieldBody` / `tick` 顺序。现在只管放对区。
