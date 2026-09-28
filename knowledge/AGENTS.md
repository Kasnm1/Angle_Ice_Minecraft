# knowledge/ —— 整合包知识库（真值来源）

她懂这个整合包，靠的是这里。**这个包魔改极多（KubeJS 删 370 条配方、换原料 150 处、新增 390 条），只信这里，不信原版常识。**
使用说明（给玩家问答用）见同目录 [`README.md`](README.md)；这份是给**改代码 / 重建数据**的人看的。

## 两套消费者

| 消费者 | 读什么 | 用途 |
|---|---|---|
| `src/knowledge/knowledge.js`（④ 区 mind/body/hands/ambition 都经它） | `generated/gamedata.json` + `generated/kubejs.json` + `item-names.json` + `quests.json` + `tooltips.md` | 配方 / 用途 / 获取途径 / 材料树 / 工作站 —— 返回**给模型读的中文纯文本** |
| `lookup.py` + bridge 的 `/knowledge/search` | 顶层 `*.md` / `quests.json` / `item-names.json` | 任务、物品名、提示的关键词检索 |

## 文件来源（哪些是生成物，别手改）

| 文件 | 生成方式 | 入库 |
|---|---|---|
| `generated/gamedata.json`（~20MB） | `python3 _tools/extract_gamedata.py [整合包目录]`：原版 jar → Forge → `mods/*.jar` → `kubejs/data`，按 datapack 顺序叠加，按实际装的模组求值加载条件 | ❌ 忽略 |
| `generated/kubejs.json` | `$NODE _tools/kubejs_emulate.js [整合包目录]`：模拟环境里跑 `server_scripts`，记下删 / 换 / 加 | ❌ 忽略 |
| `quests.json` `item-names.json` `chapters.md` `main-quest.md` `mods.md` `tooltips.md` `pack-overview.md` | `_tools/extract_{quests,lang,mods,tooltips}.py` → `_raw/` → `_tools/build_kb.py` 组装 | ✅ |
| `_raw/` | 中间产物，与顶层重复 | ❌ 忽略 |
| `ores.json` `crops.json` | `$NODE _tools/import_instinct_tables.js`：从 `modpack-study/instincts/`（WorkBuddy 查 jar 里的 needs_*_tool 标签 / loot table，2026-09-27）精简；字段不全就拒绝写 | ✅ |

整合包目录默认 `~/Library/Application Support/minecraft`。整合包更新后按 `README.md` 末尾「重建知识库」执行。

## 矿表 / 作物表（本能用，`src/instinct/instinct.js` 直接读）

- `ores.json`：`{ name, tier, value, drops, notPickaxe? }`。`tier` = 最低镐等级（wood…netherite），`null` = 没查到 → 采矿本能**按铁镐**处理（保守）；
  `notPickaxe` = 不是镐子挖的（化石矿要铲子），采矿本能跳过。`value` high/mid 看见就挖，low 只在缺的时候挖。
- `crops.json`：只收 **loot table 证明"age 到最大值时打掉 = 标准收获"** 的作物（`{ name, ageProp, maxAge, harvest:'break', seed, soil }`）。
  瓜茎、竹子、甘蔗、仙人掌、浆果丛、藤蔓这类打掉就毁了 / age 不是成熟度的，导入脚本会拒绝。

## 改 `src/knowledge/knowledge.js` 时

- 工作站推断里标 `guess` 的是"同模组名字最像的方块"猜的 —— 输出给模型时**必须带上"猜的"标记**，不许洗成确定。
- 查不到就返回"不知道"，不要回落到原版配方（这是 `PERSONA.md`「别按原版攻略答」的底气）。
- 手查：`$NODE src/knowledge/knowledge.js obtain 铁锭` / `recipe 木镐` / `uses 煤炭` / `tree 铁镐` / `guide 七咒之戒`
- 自测：`$NODE src/knowledge/knowledge.js --selftest`（依赖 `generated/`，没生成会失败 —— 那是"读不到"，不是代码坏了）
- `src/mind/ambition.js` 从 `quests.json` 里 `groupTitle === '食录逸闻'` 取食物清单 —— 重建 `quests.json` 后跑 `$NODE src/mind/ambition.js --selftest`。
