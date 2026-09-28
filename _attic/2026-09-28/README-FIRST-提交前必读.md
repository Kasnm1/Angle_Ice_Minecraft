# 接手说明 —— 请先读这一份再动手

这份压缩包是 `angleice`（Minecraft-AIcompanion）项目的**干净快照**，供你完成**首次 git 提交**。

---

## 一、这个包是什么

- **来源**：`C:\Users\Kasumi\Desktop\angleice`
- **文件数**：82 个（**精确等于** `git ls-files -c -o --exclude-standard` 的输出）
- **性质**：**已经按 `.gitignore` 过滤过的干净工作树快照**
- **不含**：`.git/`、`node_modules/`、`config.json`、运行日志、`memory/events.jsonl`、`memory/state.json`、`memory/journal.md`、`.angleice-backup-*/`

也就是说：**直接把当前目录内容作为仓库初始内容提交即可**，不需要再挑三拣四。

---

## 二、要做的事（按顺序）

```bash
# 1. 解压后进入目录
cd angleice

# 2. 初始化仓库
git init

# 3. 设置身份（★ 用你自己的，别用占位）
git config user.name  "你的用户名"
git config user.email "你的邮箱"

# 4. 全部加入（.gitignore 已就位，不会误伤）
git add -A

# 5. 提交（提交信息见下节）
git commit -F COMMIT-MESSAGE.txt

# 6. 验证
git log --oneline -1
git show --stat --oneline HEAD | tail -5
```

如果要推到远端：

```bash
git remote add origin <你的仓库地址>
git branch -M main
git push -u origin main
```

---

## 三、几个**必须知道**的坑

### 1. `.gitignore` 不要改成 `*.json`
文件里已有一段**临时调试产物**规则（`/m[0-9]*.json`、`/sc*.json` 等）。
里面**有明确注释**：不要写成 `*.json` —— 那会吃掉这些**必需**文件：

| 文件 | 作用 |
|---|---|
| `package.json` | 依赖声明 |
| `package-lock.json` | 锁版本 |
| `config.example.json` | 配置模板（给用户复制的） |
| `_meta.json` | skill 元数据 |
| `registry/block-palette.json` | 2MB 方块调色板（**运行时必需**） |
| `knowledge/quests.json` / `item-names.json` | 整合包知识库 |

### 2. `config.json` 已被忽略 —— **这是故意的**
它含真实服务器地址与账号，**不要**从别处拷进来提交。

### 3. `package.json` 的版本号是 `1.11.0`
它**故意**与 `bridge-server.js` 里的 `BRIDGE_VERSION = '1.11.0'` 对齐。别再改回 `1.0.0`。

---

## 四、仓库当前状态（供你判断）

| 项 | 值 |
|---|---|
| 提交数 | **0**（这是首次提交） |
| 分支 | 未创建（`git init` 后为 `master`，建议 `git branch -M main`） |
| 远端 | **无** |
| 自测状态 | **774/774 全绿**（11 个测试文件） |
| 代码规模 | `bridge-server.js` 6050 行 / `autopilot.js` + `decision.js` 等 |

**自测跑法**（需先装依赖）：

```bash
npm install
node --check bridge-server.js      # 语法检查
node pathing.js --selftest
node autopilot.js --selftest
node decision.js --selftest
```

⚠️ **重要**：`bridge-server.js` **没有** `--selftest`（一 `require` 就会尝试连服务器）。对该文件只能用 `node --check`。

---

## 五、想了解项目现状 → 读这三份

| 文件 | 内容 |
|---|---|
| `STATUS.md` | **现状报告**：她能做什么 / 做不到什么 / 已知缺陷 / 我的失误 |
| `HANDOVER.md` | **交接报告**：三层架构、启动方式与环境坑、本轮 10 条修复明细、接手阅读顺序 |
| `memory/field-log.md` | **问题台账**：P1–P50，共 49 条，每条含证据 / 根因 / 修复 / 验证 |

建议顺序：`STATUS.md` → `HANDOVER.md` → `memory/field-log.md`（按需查）。

---

## 六、已知未完成（不是你的锅，列出来免得你困惑）

- **P48**：她不会「持续发育」——`needShelter` 只在夜间为真、`needMaterials` 只看背包堆数、没有工具链目标。方案已批准（徒手采木 → 木镐 → 采石 → 石镐/石剑 → 打猎），**未实现**。
- **P50**：`place.js` 的 `AIRY` 判据不含植物，导致她站在 `grass` 上被判为「不在地面」。建议拆成 `REPLACEABLE` + `STANDABLE`。**未修**。
- `SKILL.md` / `README.md` 内容**滞后于代码**，需同步。
- `package.json` 的 `name` 是 `minecraft-bridge-skill`，与项目名 `Minecraft-AIcompanion` 不一致。

---

## 七、依赖说明

`node_modules/` **不在包里**。`package.json` 已声明：

```json
"mineflayer": "^4.39.0",
"mineflayer-pathfinder": "^2.4.5",
"prismarine-registry": "^1.12.0",
"vec3": "^0.1.10"
```

跑 `npm install` 即可。当前开发环境实际使用 Node `22.22.2`。

---

**最后**：提交信息我写在同目录的 `COMMIT-MESSAGE.txt`，可直接 `git commit -F COMMIT-MESSAGE.txt` 使用，也可以自行修改。
