# 知识库 —— Minecraft 模组整合包

这是 Angel_ICE 的「游戏常识」。**回答任何游戏内问题之前，先来这里查。**

## 文件说明

| 文件 | 内容 | 什么时候看 |
|---|---|---|
| `pack-overview.md` | 整合包总览 + **核心机制**（键位、Boss 料理循环、经济、七咒之戒、次元之胃…） | **必读**，尤其是回答"这游戏怎么玩"时 |
| `main-quest.md` | 主线任务路线图（按依赖排序，含每个任务的说明） | 玩家问"我该干嘛"时 |
| `chapters.md` | 61 章全部任务标题（快速定位） | 玩家提到某个任务/章节时 |
| `tooltips.md` | 作者写在物品上的提示（怎么获得、怎么用） | 玩家问"这东西哪来的"时 |
| `mods.md` | 467 个模组清单 | 玩家问某个模组时 |
| `quests.json` | 全量结构化任务数据（3878 个任务） | 需要精确查任务需求/奖励时 |
| `item-names.json` | 33189 条物品中英对照 | 需要把 `modid:item` 翻成中文时 |
| `lookup.py` | 查询脚本 | 上面两个 json 用它查最方便 |

## 用 lookup.py 查

```bash
python knowledge/lookup.py quest 钻石          # 找含"钻石"的任务
python knowledge/lookup.py item 棱彩解药桶      # 物品名 → modid:item
python knowledge/lookup.py item terramity:     # 某模组的全部物品
python knowledge/lookup.py chapter 蜜蜂         # 找章节
python knowledge/lookup.py tip 大鳄龟           # 物品提示
python knowledge/lookup.py main                # 打印主线顺序
python knowledge/lookup.py stats               # 统计
```

或者走 HTTP（机器人离线也能用）：

```bash
# 关键词含中文时一定要让 curl 自己编码（-G --data-urlencode）
curl --noproxy '*' -G --data-urlencode "type=quest" --data-urlencode "q=末影龙" \
     "http://127.0.0.1:3001/knowledge/search"

# 也可以把关键词放进 JSON body，完全不用管编码
curl --noproxy '*' -X POST -H "Content-Type: application/json" \
     -d '{"type":"quest","q":"末影龙"}' "http://127.0.0.1:3001/knowledge/search"

# 读某个文件
curl --noproxy '*' "http://127.0.0.1:3001/knowledge/search?type=raw&file=pack-overview.md"
```

> ⚠️ **不要把中文直接拼进 URL**（`?q=末影龙`）。请求行里的非 ASCII 字节会被 Node 的
> HTTP 解析器直接判为 `400 Bad Request`，你只会收到一个**空响应**，看起来像"查不到"。

## 硬性规则

1. **回答游戏问题前先查这里。** 尤其是"怎么获得""有什么用""我该做什么"。
2. **不要问玩家基础问题。** 键位、Boss 料理循环、经济系统、七咒之戒、次元之胃
   这些在 `pack-overview.md` 里，是常识。
3. **查不到就说"我不太确定"**，不要编造。宁可说"我记不清了，你在 JEI 里按 R 看看？"
4. **不要按原版攻略回答。** 这个整合包魔改了太多东西（删了大量配方、作物来源统一、
   Alex 洞穴拆成六维度、Boss 线改成做菜），原版/原模组的攻略经常是错的。

---

## 重建知识库（整合包更新后）

数据全部从整合包本体提取，没有手工录入。整合包升级后重跑一遍即可。

```bash
cd knowledge/_tools

PACK="<整合包目录>"   # 改成实际路径
RAW="../_raw"        # 中间产物
OUT=".."             # 最终知识库

mkdir -p "$RAW"

# 1) 汉化词条（先跑，任务书翻译依赖它）
python extract_lang.py     "$PACK"                 "$RAW/item-names.json"

# 2) 任务书（用上一步的词条做翻译）
python extract_quests.py   "$PACK/config/ftbquests/quests" "$RAW/quests.json" "$RAW/item-names.json"

# 3) 模组清单与物品提示
python extract_mods.py     "$PACK/mods"            "$RAW/mods.json"
python extract_tooltips.py "$PACK/kubejs"          "$RAW/tooltips.json"

# 4) 组装（会同时重新生成这份 README）
python build_kb.py "$RAW" "$PACK/kubejs" "$OUT"
```

### 各脚本职责

| 脚本 | 作用 |
|---|---|
| `snbt.py` | SNBT 解析器（FTB Quests 的 `.snbt` 格式） |
| `extract_lang.py` | 收集汉化词条：模组 jar + kubejs 覆盖 + `vanilla_zh.json` |
| `extract_quests.py` | 解析 61 个章节文件 → 结构化任务 JSON（含翻译） |
| `extract_mods.py` | 扫 mods 目录 → 模组名/modid/版本/加载器 |
| `extract_tooltips.py` | 从 kubejs 客户端脚本抽物品提示 |
| `build_kb.py` | 组装成 `pack-overview.md` / `main-quest.md` / `chapters.md` 等 |
| `vanilla_zh.json` | 原版物品中文名（客户端 jar 只有 en_us，需手工补） |

### 已知限制

- **原版方块名**：`vanilla_zh.json` 只覆盖了约 330 个常用项。任务书里出现罕见原版
  物品时可能仍是英文 id。
- **结构名**（如 `terramity:prismatic_pond`）没有翻译来源，保持原样。
- **模组中文名**：467 个模组里约 105 个自带官方中文名，其余显示英文名。
- **`?` 物品**：少数任务的需求物品在 lang 里查不到，显示为 `?`。

---

_本目录由 `_tools/` 下的脚本从整合包本体生成，请勿手工编辑——改了会被下次重建覆盖。_
