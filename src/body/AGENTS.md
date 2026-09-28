# `src/body/` —— 手 / 常识 / 装备 / 仓库 / 物品账

> 从根 AGENTS.md「功能分区」的**① 桥 / 协议 / 注册表**里"手"那部分拆过来（第 2 步重构）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `hands.js` | 挂到 bridge 上的"手"：`/eat` `/use` `/wear` `/craft2`（整合包真实配方）`/smelt` `/container/*`。每个动作比对前后背包/装备/饥饿值，不信"调用成功" |
| `commonsense.js` | 常识动作：装水 / 倒水 / 锄地 / 钓鱼 / 动物 / 载具（`routes({ state })`） |
| `equip-policy.js` | `pickAutoEquip`（"该换成什么到手上来"）。原在 `decision.js`，旧脑干删除时**原样**搬出。被 `../bridge/server.js`（`POST /equip` auto 分支）和 `../instinct/instinct.js`（`deps.pickAutoEquip`）**两边**引用 —— 改它要两边都测 |
| `storage-policy.js` | 家中仓库的**安全边界**：`assign` / `only` / `skip` / `protected` 的统一规则。纯函数，家里（mind 进程）和搬东西（bridge 进程）共用一份 |
| `inventory-ledger.js` | 物品账：背包每次进出记下"变了什么、为什么"（捡的 / 放进哪个箱子 / 吃掉 / 用坏…），mind 读它 |
| `ftbq-sync.js` | FTB 任务书进度：哪些任务做完了（长期计划看主线做到哪了）。格式按反编译核对过 |

## 自测

```bash
$NODE src/body/hands.js --selftest                       # 假 bot 驱动真实的 startFollow / go
$NODE src/body/commonsense.js --selftest
$NODE src/body/equip-policy.js --selftest                # 该换什么到手上来（空手 / 拿错东西）
$NODE src/body/storage-policy.js --selftest
$NODE src/body/inventory-ledger.js --selftest
$NODE src/body/ftbq-sync.js --selftest
$NODE --check src/bridge/server.js                       # hands 的路由挂在 bridge 上，跨区改动要一起看
```

## 第 3 步会拆

`hands.js`（5594 行、75 条路由）在第 3 步按路由分组拆成 `src/body/*.js`，
每个导出 `routes(ctx)`，`hands.js` 变成汇总 index。现在只管放对区。
