# 新家的家具清单（早期玩家版）

给 Angle_ICE 规划房间用。**所有 id 都在本包真实存在**（已回查 `item-names.json`）。全表见 `catalog.json`。

## 1. 仓库区
- 主箱子 `minecraft:chest` —— 27 格，两个并排成大箱子 54 格，最省材料
- 分类箱 `minecraft:barrel` —— 同 27 格，上方不挡，**可叠成一面墙**，分类仓首选
- 单种大堆 `quark:crate` —— 只放 1 种物品但上限很大，装圆石/泥土/木头
- 随身箱 `minecraft:ender_chest` —— 放工具/备用装备（要下界之眼，早期可跳过）
- 升级箱（后期）`expandedstorage:iron_chest` —— 容量远大于原版，仓库升级主力

## 2. 厨房区（本包重点）

**农民乐事（主力）**：`farmersdelight:cutting_board` 砧板切菜 → `farmersdelight:cooking_pot` 厨锅炖菜 →
`farmersdelight:stove` 炉灶给锅加热（也能当熔炉烧东西，要燃料）；`farmersdelight:skillet` 煎锅烤肉；
`farmersdelight:oak_cabinet` 27 格矮柜（换木种用 `spruce_/birch_/cherry_`）。

**傻瓜厨房（cookingforblockheads）**——这几个连成一片才算一个厨房（可铺 `white_kitchen_floor` 拉长距离）：
`cookingforblockheads:cooking_table` 核心（显示现有食材能做什么菜）、`oven` 烤箱、`sink` 无限水槽、
`fridge` 存原料、`counter` 台面柜、`cabinet` 挂墙柜、`toaster` 吐司。

**烘焙坊**：`bakery:brick_stove` 烤炉（换材质有 `cobblestone_/deepslate_/granite_`）、
`bakery:baker_station` 备料台、`bakery:drawer` 18 格抽屉（配方=木桶+木板，很便宜）。

## 3. 冶炼区
- `minecraft:furnace` —— 万用，矿石食物木炭都能烧
- `minecraft:blast_furnace` —— 只烧矿/金属，**速度翻倍**，矿石多必备
- `minecraft:smoker` —— 只烧食物，**速度翻倍**，放厨房旁
- 后期 `ironfurnaces:iron_furnace`（更高档：金/钻石/下界合金/彩虹），`ironfurnaces:heater` 免燃料无线供热

## 4. 工作区
`minecraft:crafting_table` 工作台、`stonecutter` 切石机（建筑党省料）、`smithing_table` 锻造台、
`anvil` 铁砧（修装备/合附魔，会摔坏）、`enchanting_table` 附魔台（要书架环绕）、`brewing_stand` 酿造台、
`grindstone` 砂轮（洗附魔返还经验）、`lectern` 讲台、`composter` 堆肥桶、`loom` 织布机、`cartography_table` 制图台。
布局：工作台+切石机+锻造台一组；铁砧+砂轮+附魔台一组。

## 5. 「冰箱」到底能不能存东西（逐条给依据）

本包 4 类冰箱行为不一样：

| id | 能存？ | 保鲜？ | 依据 |
|---|---|---|---|
| `cookingforblockheads:fridge` | ✅ 能，烹饪原料单元。**上下叠两个=竖直 2 格高大冰箱** | 未知 | jar 内 `zh_cn.json`：`fridge.description = 存储烹饪所需原料。`；类含 `SMALL / LARGE_LOWER / LARGE_UPPER` 三种模型状态；配方=箱子+铁门 |
| `smc:fridge` | ✅ 能，**2 格高**（`upper=true/false`），普通容器 | 未知 | blockstate 有上下两半；类继承 `RandomizableContainerBlockEntity` 且用 `ChestMenu` |
| `cluttered:retro_fridge_white`（共 8 色） | ✅ 能，**54 格** | 未知 | 注册代码 `retro_fridge_be = registerFridge(..., 6, ...)`，6 行×9=54 |
| `brewinandchewin:ice_crate` 冷冻箱 | ✅ 能（是箱子） | 未知 | 用途是酿酒降温；**没找到保鲜机制的任何依据** |

**结论**：要「能装东西的冰箱」，早期最省事是 `cookingforblockheads:fridge`（顺带进傻瓜厨房）；
纯当好看储物柜用 `cluttered:retro_fridge_*`（54 格）。
**本包所有冰箱是否减慢食物腐烂，我没有任何依据，一律按「未知」，别向玩家保证能保鲜。**
另：`beachparty:mini_fridge` 在方块表里存在，但没查到能当容器，标未知。

## 6. 卧室
- `minecraft:red_bed` —— 任意颜色，2 格长，睡醒设重生点（早期最重要的保险）
- `handcrafted:oak_fancy_bed` —— 带木框架的床，好看（推测也是 2 格）
- `handcrafted:oak_nightstand` 床头柜、`tanukidecor:antique_wardrobe` 衣柜

## 7. 照明（早期就铺满防刷怪）
- `minecraft:torch` 最便宜先插满；`minecraft:lantern` 更亮，挂天花板或摆地上
- `minecraft:candle` 可叠着点，卧室氛围
- 模组：`supplementaries:sconce` 墙上火把座、`cluttered:colosseo_wall_lantern` 挂墙灯、`cozy_home:white_lamp` 圆球吊灯

## 8. 建造顺序
1. 床+火把（保命）→ 2. 箱子墙（`chest` + `barrel` 叠高）→ 3. 工作台+熔炉+高炉+烟熏炉 →
4. 砧板+厨锅+炉灶（能开始做正经料理）→ 5. 附魔台/铁砧/砂轮 → 6. 傻瓜厨房+冰箱 → 7. 储物升级与 RS 自动化仓库

---
*来源：`item-names.json`（名称）、`generated/gamedata.json`（配方）、游戏目录 `mods/*.jar` 的 lang/blockstate/类文件（只读）。标「未知」= 没找到依据，不等于「没有」。*
