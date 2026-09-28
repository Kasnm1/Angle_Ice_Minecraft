# `src/knowledge/` —— 整合包知识库（代码侧）

> 从根 AGENTS.md「功能分区」的**④ 知识库**拆过来（第 2 步重构）。
> 数据来源与重建流程看 [`knowledge/AGENTS.md`](../../knowledge/AGENTS.md)（数据目录，**不在 `src/` 下**）。
> 跨区规则、环境、`$NODE`、全局原则看仓库根的 [`AGENTS.md`](../../AGENTS.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `knowledge.js` | `resolve` / `recipesFor` / `usesOf` / `obtain` / `materialTree` / `guide` / `describe` —— 返回**给模型读的中文纯文本**。数据目录是 `paths.KNOWLEDGE`（= 仓库根 `knowledge/`） |

数据目录（原地不动，在仓库根）：
`knowledge/generated/`（`gamedata.json` ~20MB、`kubejs.json`，生成物不入库）、
`knowledge/*.md` `quests.json` `item-names.json`（`build_kb.py` 组装的产物，入库）、
`knowledge/_tools/*.py`。

下游：`../mind/mind.js` `../mind/body.js` `../body/hands.js`（`/craft2` 按整合包真实配方合成）
`../mind/ambition.js` 都经 `knowledge.js`。改输出格式要考虑它们。

## 铁律

- **只信整合包数据，不信原版常识**（KubeJS 删 370 条配方、换原料 150 处、新增 390 条）。
  查不到就说查不到，**不回落原版**。
- 推断出来的东西（如工作站"同模组名字最像的方块"）必须带 `guess` 标记输出，不许洗成确定。
- "没有这个配方"与"数据没加载 / 没生成"是两回事，报错要分开。

## 自测

```bash
$NODE src/knowledge/knowledge.js --selftest
$NODE src/knowledge/knowledge.js obtain 铁锭 | recipe 木镐 | uses 煤炭 | tree 铁镐 | guide 七咒之戒
python3 knowledge/lookup.py quest 钻石 | item terramity: | tip 大鳄龟 | main
```

自测依赖 `knowledge/generated/`；若缺失，先按 `knowledge/AGENTS.md` 重建，
而不是改代码让它"通过"。
