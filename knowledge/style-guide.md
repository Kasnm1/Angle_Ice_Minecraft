# Angel_ICE 建筑与摆块审美指南

面向「陪伴型 AI 在 Minecraft 整合包里自己盖房子 / 摆方块」的场景。
规则分两类来源，每条末尾标注：

- `惯例` —— 通用 MC 建筑常识，不依赖本整合包
- `路径` —— 依据本整合包真实文件得出（可复核）

所有方块 id 均取自 `angleice/knowledge/item-names.json`，无臆造。

---

## 一、总体原则

1. **一个建筑只用 1 种主木 + 1 种主石。** 木材决定气质（暖/冷），石材做地基与承重。
   想加第二种木，只允许用在「屋顶」或「门窗框」上，且必须比主木深 2 个色阶以上。`惯例`
2. **同一面墙不混木种。** 本包 wood 族共 202 族（`aesthetics/palettes.json` 的 `wood`），
   同族内的 `planks/stairs/slab/fence/door` 等必定同色，跨族混用会花。`路径: aesthetics/palettes.json`
3. **配色遵循 60/30/10**：主色 60%（墙面）、辅色 30%（地基/屋顶/框架）、点缀色 10%（门窗/灯饰/植被）。`惯例`
4. **地面、墙、屋顶三者的明度必须拉开。** 常见错误是墙和屋顶同色导致建筑「糊成一坨」。`惯例`
5. **先定色卡再动工。** 建之前在 `palettes.json` 里选好一个 `wood` 族 + 一个 `stone` 族，
   中途不换。`路径: TASK-aesthetics-palettes.md 第 3 条`

## 二、墙体与结构

6. **原木做柱、木板做墙。** 转角与门框两边立 `<wood>_log` 或 `<wood>_wood`（竖放），
   中间用 `<wood>_planks` 填。这是最省料也最像人盖的搭法。`惯例`
7. **去皮原木比原木干净。** 室内墙面、窗框优先 `stripped_<wood>_log`；
   室外保留带皮原木做柱子，更有质感。本包 20 个命名空间提供去皮变体。`路径: aesthetics/palettes.json → wood.*.members.stripped_log`
8. **地基要比墙深。** 地基用 `cobblestone` / `stone_bricks` / `deepslate` 系，
   比上方木墙深 2 阶以上，建筑才「站得住」。`惯例`
9. **石族自带配套的 stairs/slab/wall，做转角不要用木板替代。** 例如
   `minecraft:stone_bricks` 配 `minecraft:stone_brick_stairs` / `_slab` / `_wall`。`路径: aesthetics/palettes.json → stone`
10. **屋顶用深色系石材或深色木。** 本包**没有** `mcwroofs`（屋顶专用模组），
    屋顶用 `stairs` + `slab` 自己搭，或用 `<wood>_stairs` 做坡。`路径: mods 目录无 mcwroofs jar`

## 三、门窗与开口

11. **门窗必须与墙同族。** 木头房子就用同木种的 `<wood>_door`，
    改造型门可用 `mcwdoors:<wood>_barn_door`、`mcwdoors:<wood>_japanese_door`。`路径: mcwdoors（249 项）`
12. **门上方留 1 格过梁。** 用同族 `<wood>_stairs` 倒扣或 `<stone>_stairs`，避免门窗顶到天花板。`惯例`
13. **窗用同族：** `mcwwindows:<wood>_window`（可调窗）、`mcwwindows:<wood>_plank_window`（木板窗）、
    `mcwwindows:<wood>_four_window`（四格大窗）。玻璃统一用 `minecraft:glass` 或同色 `stained_glass`。`路径: mcwwindows（315 项）`
14. **窗不要贴地。** 窗台离地至少 1 格，用 `<wood>_trapdoor` 或 `<wood>_slab` 当窗台。`惯例`
15. **栅栏与门同族。** `mcwfences:<wood>_picket_fence`（篱栅）、`<wood>_stockade_fence`（实心栅栏）、
    `<wood>_horse_fence`（马栏）。`路径: mcwfences（150 项）`

## 四、火把与照明

16. **火把间距 5–7 格，沿墙对称放。** 不对称的照明是「看起来不像人盖的」最大特征。`惯例`
17. **室外用挂灯，室内用落地灯。** 本包 light 类共 449 项，`mount` 字段标注了挂载方式，
    其中 `any` 119 项、`floor` 114 项、`ceiling` 110 项、`wall` 21 项、未判定 85 项（标 `推测`）。`路径: aesthetics/palettes.json → lights`
18. **不要在承重柱上挂火把。** 用 `minecraft:lantern` 从天花板垂吊，
    或 `decorative_blocks:<wood>_support` 做灯架。`惯例`
19. **主光源不超过 2 种。** 例如室内只用 `minecraft:lantern` + `minecraft:torch`，
    不要同时混 5 种模组灯。`惯例`

## 五、家具与植被

20. **家具成组靠墙放，不要摆在房间正中。** 桌子配椅子（`handcrafted:<wood>_table` +
    `handcrafted:<wood>_chair`），柜子贴墙（`handcrafted:<wood>_cupboard`）。`路径: handcrafted（285 项）`
21. **同一房间家具同族。** 本包家具模组都按原版 11 木 + 部分模组木成套：
    `handcrafted`、`cozy_home`、`candlelight`、`decorative_blocks`、`beautify`。`路径: aesthetics/palettes.json → wood.*.extras`
22. **床边必须有床头柜 + 灯。** `handcrafted:<wood>_nightstand` + 蜡烛/灯笼。`惯例`
23. **架子别放空。** `handcrafted:<wood>_shelf` / `candlelight:<wood>_shelf` 至少摆 2–3 件杂物。`惯例`
24. **室内放绿植能立刻提升「有人住」的感觉。** `minecraft:flowering_azalea`、
    `minecraft:azalea_leaves`、`beautify:<wood>_trellis`（花爬架）配 `minecraft:vine`。`惯例`
25. **室外沿墙种树篱。** `mcwfences:<wood>_hedge` 或 `quark:<wood>_hedge`。`路径: mcwfences / quark`

## 六、避免的坑

26. **不要用 mod 的「染色变体」当独立木种。** 如 `regions_unexplored:black_painted_planks`
    属于橡木染色版，不是新树种。`路径: aesthetics/palettes.json 已排除伪族`
27. **挖矿风格的方块不要出现在居住区。** `deepslate_tiles`、`basalt` 之类适合地窖/矿道。`惯例`
28. **不要大面积用同一种方块。** 超过 5×5 的纯色平面必须插入 `stairs`/`slab` 或换色做纹理。`惯例`

---

## 七、推荐配色方案（8 套，全部真实 id）

> 格式：主色（60%）/ 辅色（30%）/ 点缀色（10%）

### 1. 白桦晨雾（明亮北欧风）
- 主：`minecraft:birch_planks`、`minecraft:stripped_birch_log`
- 辅：`minecraft:quartz_block`、`minecraft:calcite`、`minecraft:polished_diorite`
- 点：`minecraft:white_terracotta`、`minecraft:lantern`
- 适合：雪原、山地、海边小屋。`惯例`

### 2. 云杉深林（经典木屋）
- 主：`minecraft:spruce_planks`、`minecraft:spruce_log`
- 辅：`minecraft:cobblestone`、`minecraft:stone_bricks`、`minecraft:mossy_stone_bricks`
- 点：`minecraft:spruce_trapdoor`、`minecraft:campfire`、`minecraft:oak_leaves`
- 适合：针叶林。最不容易翻车的一套。`惯例`

### 3. 深板岩冷调（现代极简）
- 主：`minecraft:deepslate_tiles`、`minecraft:polished_deepslate`
- 辅：`minecraft:dark_oak_planks`、`minecraft:stripped_dark_oak_log`
- 点：`minecraft:white_concrete`、`minecraft:end_rod`（作灯）
- 适合：主城、现代建筑。`惯例`

### 4. 樱花春晓（柔和粉调）
- 主：`minecraft:cherry_planks`、`minecraft:cherry_log`
- 辅：`minecraft:smooth_quartz`、`minecraft:white_terracotta`
- 点：`minecraft:pink_terracotta`、`minecraft:pink_wool`、`minecraft:flowering_azalea_leaves`
- 适合：庭院、茶馆。粉色用量务必控制在 10%。`惯例`

### 5. 橡木田园（温暖日式）
- 主：`minecraft:oak_planks`、`minecraft:stripped_oak_log`
- 辅：`minecraft:cobblestone`、`minecraft:mossy_cobblestone`、`minecraft:mud_bricks`
- 点：`minecraft:torch`、`minecraft:azalea_leaves`、`minecraft:flowering_azalea`
- 适合：平原农舍。搭配 `mcwdoors:oak_japanese_door` 效果最好。`路径: mcwdoors`

### 6. 下界绯红（暗红金属感）
- 主：`minecraft:crimson_planks`、`minecraft:crimson_stem`
- 辅：`minecraft:blackstone`、`minecraft:polished_blackstone_bricks`
- 点：`minecraft:gilded_blackstone`、`minecraft:soul_lantern`、`minecraft:shroomlight`
- 适合：下界据点。灵魂火把/灵魂灯笼是唯一点缀光源。`惯例`

### 7. 苍穹幻森（奇幻紫青）
- 主：`twilightforest:canopy_planks`、`twilightforest:canopy_log`
- 辅：`regions_unexplored:cobalt_log`、`natures_spirit:white_kaolin_bricks`
- 点：`regions_unexplored:chalk_bricks`、`minecraft:vine`、`minecraft:lantern`
- 适合：暮色森林主题建筑。`路径: twilightforest / regions_unexplored / natures_spirit`

### 8. 白杨寒林（冷灰白）
- 主：`biomeswevegone:aspen_planks`、`biomeswevegone:aspen_log`
- 辅：`natures_spirit:cedar_planks`、`minecraft:stone_bricks`、`minecraft:calcite`
- 点：`minecraft:moss_block`、`atmospheric:grimwood_log`、`minecraft:lantern`
- 适合：高山、寒带。深色 `grimwood` 只作柱/框，压住整体不至于全白。`路径: biomeswevegone / natures_spirit / atmospheric`

### 备用：暖橙秋叶
- 主：`minecraft:acacia_planks`、`minecraft:acacia_log`、`minecraft:terracotta`
- 辅：`minecraft:bricks`、`minecraft:red_sandstone`
- 点：`minecraft:mangrove_planks`、`minecraft:mangrove_roots`、`minecraft:campfire`
- 适合：热带、草原。`惯例`

---

## 八、不确定与已知缺口

- 光源挂载方式：449 项中 85 项无法从 id 判定，已在 `palettes.json` 标为 `推测`。`路径: aesthetics/palettes.json → lights`
- 本包**不存在** `mcwroofs`（Macaw 屋顶模组）。屋顶需用 `stairs`/`slab` 自搭。`路径: mods 目录`
- 部分模组木族无去皮变体，`members` 中相应字段缺失即代表「本包不存在」。`路径: aesthetics/palettes.json → wood.*.members`
- `stone` 族收录门槛为「至少 2 个配套方块」，单块孤例（如某些模组只加了一种 `_bricks`）未收录。`路径: 生成脚本 _work/gen_palettes.py`
