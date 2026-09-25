# 交接报告 · minecraft-bridge / Angel_ICE

| 项目 | 内容 |
|---|---|
| 交接时间 | 2026-09-25 14:07 (GMT+8) |
| 项目路径 | `C:\Users\Kasumi\Desktop\angleice` |
| 版本 | `bridge-server.js` → `BRIDGE_VERSION = '1.11.0'`；`package.json` → `1.0.0`（**不一致，待统一**） |
| 当前状态 | ⏸ **所有进程已停止**（用户要求停止本地迭代） |
| 自测 | **774/774 全绿**（详见 §4） |
| 台账 | `memory/field-log.md`，**48 条问题**，177 029 字节 |
| Git | ⚠️ **`main` 分支零提交** —— 所有文件在暂存区，从未 commit |

---

## 1. 交接对象是什么

一个 Minecraft 陪伴型 AI bot 的三层实现。名字 `Angel_ICE`（bot 身份，固定），
项目名 `minecraft-bridge`，外部仓库名 `Minecraft-AIcompanion`（2026-09-25 起改名 `Angle_Ice_Minecraft`）。

```
┌─────────────────────────────────────────────────────────────┐
│  autopilot.js      脑干 —— 自主循环、决策、看门狗、记忆      │
│  控制面 127.0.0.1:3002/autopilot（只读快照 + 少量控制）      │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP 127.0.0.1:3001
┌────────────────────────┴────────────────────────────────────┐
│  bridge-server.js  手 + 眼 —— 52 个 REST 端点，包住 mineflayer│
│  把"mineflayer 的能力"翻译成"有语义、可诊断的动作"           │
└────────────────────────┬────────────────────────────────────┘
                         │ mineflayer 4.39.0 / minecraft-data 3.115.0
┌────────────────────────┴────────────────────────────────────┐
│  Forge 1.20.1 服务器 139.196.98.255:25565（离线认证，516 模组）│
└─────────────────────────────────────────────────────────────┘

旁路模块（被上面两层共用，各自带自测）：
  pathing.js           寻路策略（canDig 策略、超时预算、停滞监控、可攀爬）
  place.js             放置几何（AIRY 判据、REACH、bodyOccupies）
  decision.js          动作评分表（菜单 + TUNING 阈值 + 护栏）
  reflex.js            反射层（饿/危险时抢在决策前出手）
  events.js            事件留痕
  journal.js           日记
  reconnect.js         断线重连
  block-palette.js     方块调色板（让模组方块叫得出名字）
  item-registry.js     物品注册表注入
  palette-registry.js  调色板注入 registry
  fml-handshake.js     Forge/FML 握手
```

**设计哲学（贯穿全部代码注释）**：
- **"没有"和"读不到"必须分开报** —— 这是全项目出现频率最高的教训
- **返回值要能回答"你做得有多好"，而不只是"我做了"**
- **同一判据不许写两处**（`AIRY` 只有一份，`bestFood` 只有一份）
- **找不到证据时保守为 false，不猜**

---

## 2. 环境与启动方式（**最容易踩的三件事**）

### 2.1 依赖不在项目目录

依赖装在 skill 目录下，**必须用 Windows 反斜杠**设置 `NODE_PATH`：

```bash
export NODE_PATH="C:\\Users\\Kasumi\\.workbuddy-ai\\skills\\minecraft-bridge\\node_modules"
```

Node 二进制（managed，优先用）：
```
C:/Users/Kasumi/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe
```

### 2.2 启动命令

```bash
cd "/c/Users/Kasumi/Desktop/angleice"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export NODE_PATH="C:\\Users\\Kasumi\\.workbuddy-ai\\skills\\minecraft-bridge\\node_modules"
exec "C:/Users/Kasumi/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" bridge-server.js > bridge-run.log 2>&1
```

⚠️ **必须用 `run_in_background: true`**（长驻进程）。**不能用 `cmd &`**。

autopilot 同理，日志写 `autopilot-run.log`。

### 2.3 三个真实踩过的坑

1. **HTTP 代理劫持 localhost**
   环境里设了 `HTTP_PROXY`，会让 `curl 127.0.0.1` 走代理。
   必须 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`，
   或 `curl --noproxy '*'`（**引号必需**）。
   ⚠️ Python `urllib` **即使 `os.environ.pop` 仍走代理** → 用
   `subprocess.run(['curl','-s','--noproxy','*',...])`，或 `curl | python -c`。

2. **重启进程**
   找 PID：`netstat -ano | grep ":3001"` → `Stop-Process -Id <PID> -Force`（PowerShell）。
   ⚠️ `taskkill //PID` 在 MSYS 下报"无效参数"，**不要用**。
   ⚠️ 杀掉后 `task-notification: ... failed` 是**预期结果**（不是崩溃）。

3. **`bridge-server.js` 没有 `--selftest`**
   它一 `require` 就连服务器（还会报 "Port already in use"）。
   语法检查用 `node --check bridge-server.js`。

---

## 3. 本轮（2026-09-25）做了什么

### 3.1 完成的修复（P40 → P49）

| 编号 | 问题 | 严重度 | 状态 |
|---|---|---|---|
| **P40** | `/shelter` 12 次全失败 —— 选址假设错（只会"原地封四周"，而她常站在天然缝隙里） | 🔴 | ✅ 已修 + 实机验证 |
| **P41** | `shelter` 判据 `success` 而非 `placed` → 一块没放也当成功 | 🔴 | ✅ 已修 |
| **P42** | 她被"关"在 1 格高缝隙里 → `canDig=false` 只绕不拆 → 永久困死 | 🔴🔴 | ✅ 三级自救已实现 |
| **P43** | 掉落物"报告 y" ≠ "可站层"（物品躺在方块顶面，报告 y 是方块不是空间） | 🔴 | ✅ 已修 + 13 条自测 |
| **P44** | `/move` 报 `success:true` 但她纹丝未动（`GoalBlock.isEnd()` 只要求"在格内"） | 🔴 | ✅ 已修 + 实机验证 |
| **P45** | `/scan` 真瓶颈是"看不见远处"不是"慢"；radius 8 与 16 返回完全相同 | 🔴 | ✅ 已修 + A/B 实测 |
| **P46** | `/unstick` 拿"原任务坐标"当逃逸目标，而那坐标在实心岩体内部 → 三级手段注定全败 | 🔴 | ✅ 已修 |
| **P47** | **路由层无条件贴 `success: true`** —— P32/P35/P41/P44 **四次同型的共同根因** | 🔴🔴 | ✅ 已修 + 双向实机验证 |
| **P48** | 她不会"持续发育"：缺少"进步"这个维度（**用户主线目标未达成**） | 🟡 | 📋 **已定位，未修** |
| **P49** | `/craft` 报错把"没配方"与"缺材料"混成一句 → **我自己被它带着误判了三次** | 🟡 | ✅ 诊断端点已加，报错已改 |

### 3.2 P47 是本轮最重要的修复（架构级）

**根因**：`bridge-server.js` 路由层只有一行

```js
const result = await handler(args, qs);
json(res, 200, { success: true, ...result });   // ← 无条件
```

它的语义**只有**「handler 没抛异常」，但**所有调用方都读成**「动作在世界里生效了」。
handler 内部其实**早就诚实算了** `ok: false`（`/pickup` 写在 3675 行：
`ok: picked > 0`），是路由层把它洗成了"成功"。

于是同一个 bug 长了四次，我前三次都只改判据字段（P32 加 `picked`、P35 加 `mined`、
P41 改 `placed`），**四次都没问"为什么调用方会信 success"**。

**修法三处**：

1. **路由层加否决**（严格 `=== false`，不是 `!result.ok`）：
```js
const vetoed = result && typeof result === 'object' && result.ok === false;
if (vetoed) {
  json(res, 200, { success: false, ...result, _successNote: '…' });
} else {
  json(res, 200, { success: true, ...result });
}
```

2. **补缺失的 `ok` 判据**：
   - `/mine` → `ok: mined.length > 0`
   - `/shelter` → `ok: placed.length >= 2`

3. **客户端判据同步收紧**（`autopilot.js` `call()`）—— **不做这步就会立刻回归**：
```js
// 旧：if (!res.ok || data.success === false) throw ...
// 新：
if (!res.ok || (data.success === false && data.error)) throw ...
```
不收紧的话，"业务否决"会被当异常抛出 → 她以为网桥挂了去重连 ——
**"这次没挖动"被报成"服务器掉了"，比原 bug 更糟**。

**实机双向验证**：

| 场景 | 结果 |
|---|---|
| 挖 bedrock（挖不动） | `{"success":false,"mined":0,"ok":false,"note":"搜到 128 格仍未拿够"}` ✅ |
| 挖 andesite（挖到了） | `{"success":true,"ok":true,"mined":1}` ✅ 不误伤 |

**自测新增 16 条**，含关键反向断言：
- `ok` **缺失** → **不许否决**（绝大多数 handler 属于这种，写成 `!result.ok` 会集体翻车）
- `ok: 0` / `ok: null` / `ok: "false"` → 不许否决（只认布尔 false）

### 3.3 P45 的价值：把"看不见"从"慢"里分出来

我第一轮**方向错了** —— 以为是"算法太慢"，实测 8~12 ms 直接否掉。

真症状：`radius=8` 与 `radius=16` 返回**完全一样**（`scanned:1536, distinct:6`）。
`1536 格 ≈ 球半径 7.16` —— **她永远只能看见约 7 格、6 种方块，一个矿都没有**。

两处根因：
1. **旧注释算术错**："1536 格在半径 8 下刚好扫完" —— 实际 `17×17×9 = 2601`
2. **真开销是排序不是 `blockAt`**（`_bench_blockat.js` 实测）：

| 操作 | 成本 |
|---|---|
| 分配 18513 个 `Vec3` | 0.10 ms |
| **排序 18513 个（含 sqrt）** | **11.80 ms** ← 就是它 |
| **纯三重循环，不分配不排序** | **0.82 ms** ← 快 14 倍 |

**三重修法**：删排序改**洋葱遍历** + **`dy` 放外层** + **配额口径从"走过多少格"改成"读到多少个非空气方块"**。

**A/B 实测**：

| 指标 | 旧 | 新 |
|---|---|---|
| `radius=16` `maxDistance` | **7.16（永远）** | **22.9** |
| `radius=16` `distinct` | **6（永远）** | **14** |
| 看见矿吗 | **0 个** | **`emerald_ore`(14.2格) / `alpine_coal_ore`×17 / `salt_ore`** |
| 耗时 | 8~12 ms | 8~15 ms |

### 3.4 P42 三级自救（"自己"二字的兑现）

```
① /unstick  临时放行 canDig（单次调用级，finally 强制恢复）→ 走通就结束
② /mine     挖脚边一格（不走寻路器，不受 canDig 影响）→ 再试 /move
③ 如实放弃  flag.done = true，reason = 'stuck'
```

关键设计：**脱困 ≠ 到达原任务坐标；脱困 = 能走到任何一个新的地方**（P46 的教训）。
所以 `pickEscapeTarget(p)` 在半径 6 内找"脚+头都 air 且脚下实心"的**最近**格。

⚠️ **`canDig` 不是万能钥匙** —— 它只解决"方块挡路"，**不解决"重力"**。
实测负例：`(-9,87,-8)` 脚下是 air，走进去会掉 1 格，`canDig` 打开也没用。

---

## 4. 自测现状（774/774 全绿）

| 模块 | 自测 | 结果 |
|---|---|---|
| `pathing.js` | 351 | ✅ 351/351 |
| `autopilot.js` | 263 | ✅ 263/263 |
| `decision.js` | 120 | ✅ 120/120 |
| `reconnect.js` | 59 | ✅ 59/59 |
| `item-registry.js` | 54 | ✅ 54 passed |
| `block-palette.js` | 51 | ✅ 51 passed |
| `journal.js` | 41 | ✅ 41/41 |
| `palette-registry.js` | 39 | ✅ 39 passed |
| `place.js` | 23 | ✅ 23/23 |
| `reflex.js` | 20 | ✅ 20/20 |
| `events.js` | 17 | ✅ 17/17 |
| `bridge-server.js` | — | 无自测（`node --check` 通过） |

**跑法**：
```bash
export NODE_PATH="C:\\Users\\Kasumi\\.workbuddy-ai\\skills\\minecraft-bridge\\node_modules"
NODE="C:/Users/Kasumi/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"
$NODE autopilot.js --selftest
$NODE decision.js --selftest
$NODE pathing.js --selftest
# …其余同理
```

---

## 5. ⚠️ 未完成 / 已知风险（**交接重点**）

### 5.1 🔴 用户主线目标**未达成**

用户原话：**「目标是自己建立庇护所并持续发育」**。实机观察 656 秒后：

| 用户要的 | 系统实际做的 | 差在哪 |
|---|---|---|
| **自己**建立庇护所 | `needShelter` 只在**天黑**时 true | 白天永不主动规划 |
| **持续**发育 | `matStacks 21 > 阈值 8` → 停止采集 | 而 21 个是**土**，`itemKinds: 1` |
| 发育 | `canEquipTool: false` | **没有工具链目标** |

**三条缺口（P48，全部是"设计缺维度"，不是代码 bug）**：

1. **`needShelter` = "天黑了"**（`decision.js:574`）
   ```js
   const nightKnown = cap.isDay === false;
   needShelter: noShelterAtNight,   // 语义是"应急"，不是"建立"
   ```

2. **`needMaterials` 只看堆数不看种类**（`decision.js:127, 592`）
   ```js
   selfMatStacks: 8,   // 她是 21 个 dirt → 达标 → 停采
   ```
   ⚠️ **"21 个土"和"21 个能用的材料"完全不是一回事。**

3. **没有工具链** —— `capability` 观测了 `canEquipTool` / `canEquipWeapon`，
   但**决策层没有任何动作消费它们**。观测了却不用于决策 = 没观测。
   且 `forage` 与 `hasFoodSource` 存在**循环依赖**：
   没食物源 → 不觉得饿 → 不去找食物 → 永远没食物源。

**实机日志证据**（她真的在试，只是全失败）：
```
⏸ 暂时跳过 shelter/hunt（连续失败，退避中）
⏸ forage 连续失败 9 次，退避 90s（附近 5 格内没有能打的猎物）
```

**用户已选定方案 C**（工具链）：`徒手采木 → 木镐 → 采石 → 石镐/石剑 → 打猎 → 食物 → 升级庇护所`，
每步只做"下一个能做的"。**已批准但尚未实现**。

### 5.2 🔴 P50（本轮最后发现，**未修**）

`place.js` 的 `AIRY` 判据**不含任何植物**：

```js
const AIRY = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava)$/;
```

实机证据：她站在 `(1, 67, 24) = grass`（`solid: false`、`diggable: true`，是可穿过的草），
但 `isAiryForPlace()` 返回 **false** → `selfAir = false` →
`/shelter` 报"脚边没有可放置的空位（selfAir=false）"。

**判定确实错了** —— 草她当然能站进去。但**改动有风险**：
`AIRY` 被**两处**使用，口径不同：
- **放置目标**：需要"能被方块替换" → 草**可以**被替换 ✅ 该加
- **她站位**：需要"她能站进去" → 草**完全能站** ✅ 该加

⚠️ 但加之前必须核对：`grass` 是模组方块名（可能是 `short_grass` 的别名），
且 `lava` **已经在 AIRY 里**（这是 P40 遗留的设计疑问 —— 岩浆不能站，为什么在"可站立"判据里？）。
**建议先查清 `grass` 的真实身份与 `DEADLY` 的配合关系，再动手。**

### 5.3 🟡 Git 仓库**零提交**

```
fatal: your current branch 'main' does not have any commits yet
```
所有文件都在暂存区（`A` 状态），`autopilot.js` / `bridge-server.js` / `decision.js`
是 `AM`（暂存后又有修改）。**必须首次 commit 才能保住本轮工作。**

### 5.4 🟡 其余待办

| 项 | 说明 |
|---|---|
| **版本号不一致** | `bridge-server.js` = `1.11.0`，`package.json` = `1.0.0` |
| `SKILL.md` / `README.md` 未同步 | 仍是 1.11.0 之前的内容 |
| P15（配方不可用） | **已查明不是 bug** —— 是"缺材料"，但报错文案已改进（P49） |
| P17（血量趋势） | 未修 |
| P19（深挖掉落物） | 未修 |
| `bulkSweep.picked` 与 `dropsPicked` 口径一致性 | 未核对 |
| 负数 `gainedAtBulk: -2` | 未查 |
| 三个 `/debug` 端点去留 | `shelter-probe` / `pathfinder` / `__goalTrace`，**倾向保留**（P40/P46 都靠它翻案） |
| `radius=16` 时 `solids: 6000` 触顶 | 是否提高 `MAX_SCAN_BLOCK_POSITIONS` 待决 |

### 5.5 她的状态（停止时刻）

```
位置   (1.36, 67, 24.5)     ← 比本轮开始时的 (-10.5, 87, -7.5) 低了 20 格
背包   dirt × 13            ← 从 22 降到 13（她真的用掉了 9 个土去建庇护所）
血量   18
天色   白天（isDay: true）
物品种类 1（只有土 —— 无工具、无食物）
行动   陪伴模式（玩家 Ka_sum1 在 4 格内）
```

⚠️ **注意**：她**背包里没有土以外的任何东西**，且**没有任何工具** ——
这意味着**工具链（方案 C）是唯一能让她继续发育的路径**，
而它必须从"徒手采木"开始，而**附近 24 格内没有木头**（实测扫描确认）。

**这是一个必须先解决的现实约束**：
1. 她是被 `Ka_sum1` 带到当前位置的（历史上有玩家介入）
2. 当前位置周围只有 `grass_block / dirt / andesite / limestone / 煤矿 / 盐矿`
3. **没有任何树木** → 徒手采木这条路在当前地点走不通
4. → 工具链的第一步必须是"**先找到树**"，即需要**探索（explore/远距离寻路）**

---

## 6. 建议的下一步（按优先级）

1. **立刻 `git commit`** —— 本轮所有工作尚未落盘到任何 commit
2. **实现方案 C（工具链）** —— 用户已批准，是主线目标的唯一达成路径
   - ⚠️ 第一步要处理"附近没树"：需要探索逻辑，或让玩家带她到有树的地方
3. **修 P50**（`AIRY` 不含植物）—— 小改动，但**先查清 `grass` 身份与 `LAVA` 疑点**
4. **统一版本号** + 同步 `SKILL.md` / `README.md`
5. 清理待办：P17 / P19 / `bulkSweep` 口径

---

## 7. 交接清单（按顺序读）

| 顺序 | 文件 | 为什么读 |
|---|---|---|
| 1 | `memory/field-log.md` | **48 条问题台账**，每条含症状/定位/修法/教训 —— 这是项目最有价值的资产 |
| 2 | 本报告 | 全局状态与风险 |
| 3 | `SKILL.md` | 设计哲学与操作约定（⚠️ 内容滞后于代码） |
| 4 | `decision.js` 的 `TUNING` 与 `buildMenu` | 决策层全貌；P48 要改的就是这里 |
| 5 | `pathing.js` 的 `ALLOW_DIG` / `applyPolicy` | `canDig` 策略的边界 |
| 6 | `place.js` 的 `AIRY` | P50 要改的就是这里 |
| 7 | `PERSONA.md` | 她的人格设定（影响说话纪律） |

**最重要的三句话**：
1. **"没有"和"读不到"必须分开** —— 项目里一半的 bug 都是这两个被混成了一句报错
2. **返回值要能回答"你做得有多好"** —— `reach.maxDistance` 一加，P45 立刻现形
3. **红的时候先怀疑断言** —— 我有多次差点去改正确的代码
