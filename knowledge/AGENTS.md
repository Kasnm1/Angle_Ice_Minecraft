# knowledge/ —— 整合包知识库（真值来源）

她懂这个整合包，靠的是这里。**这个包魔改极多（KubeJS 删 370 条配方、换原料 150 处、新增 390 条），只信这里，不信原版常识。**
使用说明（给玩家问答用）见同目录 [`README.md`](README.md)；这份是给**改代码 / 重建数据**的人看的。

## 两套消费者

| 消费者 | 读什么 | 用途 |
|---|---|---|
| `knowledge.js`（④ 区 mind/body/hands/ambition 都经它） | `generated/gamedata.json` + `generated/kubejs.json` + `item-names.json` + `quests.json` + `tooltips.md` | 配方 / 用途 / 获取途径 / 材料树 / 工作站 —— 返回**给模型读的中文纯文本** |
| `lookup.py` + bridge 的 `/knowledge/search` | 顶层 `*.md` / `quests.json` / `item-names.json` | 任务、物品名、提示的关键词检索 |

## 文件来源（哪些是生成物，别手改）

| 文件 | 生成方式 | 入库 |
|---|---|---|
| `generated/gamedata.json`（~20MB） | `python3 _tools/extract_gamedata.py [整合包目录]`：原版 jar → Forge → `mods/*.jar` → `kubejs/data`，按 datapack 顺序叠加，按实际装的模组求值加载条件 | ❌ 忽略 |
| `generated/kubejs.json` | `$NODE _tools/kubejs_emulate.js [整合包目录]`：模拟环境里跑 `server_scripts`，记下删 / 换 / 加 | ❌ 忽略 |
| `quests.json` `item-names.json` `chapters.md` `main-quest.md` `mods.md` `tooltips.md` `pack-overview.md` | `_tools/extract_{quests,lang,mods,tooltips}.py` → `_raw/` → `_tools/build_kb.py` 组装 | ✅ |
| `_raw/` | 中间产物，与顶层重复 | ❌ 忽略 |

整合包目录默认 `~/Library/Application Support/minecraft`。整合包更新后按 `README.md` 末尾「重建知识库」执行。

## 改 `knowledge.js` 时

- 工作站推断里标 `guess` 的是"同模组名字最像的方块"猜的 —— 输出给模型时**必须带上"猜的"标记**，不许洗成确定。
- 查不到就返回"不知道"，不要回落到原版配方（这是 `PERSONA.md`「别按原版攻略答」的底气）。
- 手查：`$NODE knowledge.js obtain 铁锭` / `recipe 木镐` / `uses 煤炭` / `tree 铁镐` / `guide 七咒之戒`
- 自测：`$NODE knowledge.js --selftest`（依赖 `generated/`，没生成会失败 —— 那是"读不到"，不是代码坏了）
- `ambition.js` 从 `quests.json` 里 `groupTitle === '食录逸闻'` 取食物清单 —— 重建 `quests.json` 后跑 `$NODE ambition.js --selftest`。
