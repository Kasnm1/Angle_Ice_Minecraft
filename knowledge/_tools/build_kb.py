#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 raw/ 下的中间产物组装成 minecraft-bridge 技能的知识库。

输入（raw/）：
  quests.json     任务书（已翻译）
  lang_zh.json    物品中英对照
  mods.json       模组清单
  tooltips.json   物品提示
  kubejs 目录     自定义内容

输出（knowledge/）：
  README.md         怎么用这份知识库（给 agent 看）
  pack-overview.md  整合包总览 + 核心机制  ← 最重要
  main-quest.md     主线任务全表（按依赖排序）
  chapters.md       61 章索引 + 每章任务标题
  tooltips.md       物品提示
  mods.md           模组清单
  quests.json       全量结构化数据（供 lookup.py 查）
  item-names.json   物品中英对照（供 lookup.py 查）
"""

import io
import json
import os
import re
import sys
from collections import OrderedDict

FMT_RE = re.compile(r'&[0-9a-fk-orA-FK-OR]')


def strip_fmt(s):
    return FMT_RE.sub('', s or '').strip()


def load(path, default=None):
    try:
        with io.open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return len(text)


# ---------------------------------------------------------------- 主线排序

def topo_sort(quests):
    """按 dependencies 做拓扑排序，得到推荐的推进顺序。"""
    by_id = {q['id']: q for q in quests if q.get('id')}
    visited = {}
    order = []

    def visit(qid, stack):
        if qid in visited:
            return
        if qid in stack:      # 环，直接放过
            return
        stack.add(qid)
        q = by_id.get(qid)
        if q:
            for dep in q.get('dependencies') or []:
                visit(dep, stack)
            visited[qid] = True
            order.append(q)
        stack.discard(qid)

    for q in quests:
        if q.get('id'):
            visit(q['id'], set())
    return order


# ---------------------------------------------------------------- 渲染

def label(q):
    """任务的可读标识。没标题就用图标名，再不行用需求物品，最后用描述首行。"""
    t = (q.get('title') or '').strip()
    if t:
        return t
    for key in ('iconZh', 'icon'):
        v = q.get(key)
        if isinstance(v, dict):
            v = v.get('item') or v.get('id') or v.get('tag')
        if isinstance(v, str) and v.strip():
            return v.strip()
    for task in q.get('tasks', []):
        if task.get('itemZh'):
            return task['itemZh']
        if task.get('item'):
            return task['item']
    # 纯勾选任务：拿描述首行当名字
    for d in q.get('description', []):
        d = (d or '').strip()
        if not d or d.startswith('{image') or d.startswith('{'):
            continue
        first = d.split('\n')[0].strip()
        if first:
            return first[:24] + ('…' if len(first) > 24 else '')
    return '(无标题)'


def render_quest(q, idx=None, indent=''):
    """把一个任务渲染成 markdown 片段。"""
    out = []
    title = label(q)
    head = f'{indent}### {idx}. {title}' if idx else f'{indent}### {title}'
    out.append(head)
    if q.get('subtitle'):
        out.append(f'{indent}> {q["subtitle"]}')
    out.append('')
    for t in q.get('tasks', []):
        out.append(f'{indent}- 任务：{t["summary"]}')
    for r in q.get('rewards', []):
        out.append(f'{indent}- 奖励：{r["summary"]}')
    desc = [d for d in q.get('description', [])
            if d.strip() and not d.strip().startswith('{image')]
    if desc:
        out.append('')
        for d in desc:
            # 内嵌的 clickEvent JSON 提取成人话
            if d.strip().startswith('{') and 'clickEvent' in d:
                m = re.search(r'"text"\s*:\s*"([^"]+)"', d)
                if m:
                    out.append(f'{indent}  · {m.group(1)}')
                continue
            for line in d.split('\n'):
                if line.strip():
                    out.append(f'{indent}  {line.strip()}')
    out.append('')
    return '\n'.join(out)


# ---------------------------------------------------------------- 各文件

def build_overview(quests, mods, kubejs_dir, out_dir):
    """总览 + 核心机制。信息主要来自「新手礼包and游玩须知」与主线说明。"""
    L = []
    A = L.append

    A('# 香草纪元：食旅纪行 —— 整合包总览')
    A('')
    A('> 这份文件是 Angel_ICE 的「常识」。读懂了就不会问玩家基础问题。')
    A('')

    # 基础信息
    A('## 一、基本信息')
    A('')
    A('| 项目 | 值 |')
    A('|---|---|')
    A('| 整合包 | 香草纪元：食旅纪行 2.7.1（正式版，完全免费） |')
    A('| Minecraft | 1.20.1（Forge） |')
    A(f'| 模组数 | {len(mods)} 个 jar |')
    A(f'| 任务书规模 | {quests["stats"]["chapterCount"]} 章 / '
      f'{quests["stats"]["questCount"]} 个任务 / {quests["stats"]["groupCount"]} 个分组 |')
    A('| 主题 | 旅行、冒险、烹饪、休闲 |')
    A('')
    A('设计目标：保留原版 MC 的风格，在大量老面孔模组之外加入精致新模组，'
      '并做了大量魔改与定制。可以种田养老，也可以抽刀迎战强敌。')
    A('')

    # 核心机制
    A('## 二、作者原话：必看提示（最重要的 15 条）')
    A('')
    A('> 这段是整合包作者写在任务书【新手礼包and游玩须知 → 必看提示】里的原文。')
    A('> **这是"怎么玩这个包"的官方答案，她必须烂熟于心。**')
    A('')

    # 从任务书里动态取出「必看提示」的完整描述
    starter = None
    for c in quests['chapters']:
        if '新手礼包' in (c['title'] or ''):
            starter = c
            break
    tips_quest = None
    if starter:
        for q in starter['quests']:
            if '必看提示' in (q.get('title') or ''):
                tips_quest = q
                break
    if tips_quest:
        for d in tips_quest.get('description', []):
            d = (d or '').strip()
            if not d or d.startswith('{image'):
                continue
            if d.startswith('{') and 'clickEvent' in d:
                continue
            if d == '{@pagebreak}':
                A('')
                continue
            for line in d.split('\n'):
                line = line.strip()
                if line:
                    A(f'- {line}')
        A('')
    else:
        A('_（未在任务书中找到「必看提示」，请手动核对）_')
        A('')

    A('## 三、核心机制拆解（玩家最常问的东西）')
    A('')
    A('### 1. 操作键位')
    A('')
    A('| 键 | 作用 |')
    A('|---|---|')
    A('| `X + 右键` | **空手抱起生物或某些方块**（抱某些植物会出 bug，注意） |')
    A('| `~`（波浪键） | **连锁挖掘**（按住） |')
    A('| `R` | 物品栏对着物品按 R → **查看来源**（怎么获得） |')
    A('| `U` | 物品栏对着物品按 U → **查看用途**（能做什么） |')
    A('| `B` | 对着物品按 B → 打开 **MC 百科** 的物品介绍页（打不开就自动搜索） |')
    A('| `O` | 打开**商店**（也可点物品栏左上角商店图标） |')
    A('| `M` | 打开**大地图**（Xaero，可认领区块、设置强加载） |')
    A('| `Ctrl + 滚轮` | 缩放任务书界面 |')
    A('')
    A('> `R` / `U` / `B` 是玩家查资料的主要方式，任务书里也适用。她可以主动提醒。')
    A('')

    A('### 2. ⭐ Boss 线的推进循环（本包最核心的玩法）')
    A('')
    A('**本包推进 Boss 任务线的方式，不是传统的"击杀 Boss"，而是"做出 Boss 专属菜肴"。**')
    A('')
    A('```')
    A('击败 Boss → 制作料理 → 领取任务 → 解锁商店 → 再次购买 Boss 掉落物 → 制作其他物品')
    A('```')
    A('')
    A('所以：打 Boss 只是第一步，**把掉落物做成菜**才是推进。料理在这里既是食物也是武器。')
    A('')

    A('### 3. 经济系统（财产点数）')
    A('')
    A('- 把**可出售的作物**放进**出货箱**（`xiangcaomengjia:wood_selling_bin` 木出货箱），'
      '等待片刻即转化为**财产点数**')
    A('- 财产点数按 `O` 键进商店消费；财产点数与实体货币可互相转化')
    A('- 出货箱可升级，最高**下界合金等级**（容量与售卖速度提升）')
    A('- 出货箱支持**漏斗**输入，也可与**精致存储（Refined Storage）的输出面板**相连实现全自动')
    A('- 可出售的作物会在物品上显示价格')
    A('- **商店里包含绝大部分材料**，少部分需要推进任务解锁；通过 JEI 可直接跳转到商品页面')
    A('- 食材难获取时 → **去野猎商店看看**')
    A('')

    A('### 4. 七咒之戒（重要！）')
    A('')
    A('- 开局会获得**七咒之戒**（`enigmaticlegacy` 神秘遗物）')
    A('- **装备七咒之戒以解锁特殊强力物品的使用权限**；本包中它的负面效果**均被移除，只剩燃烧**')
    A('- ⚠ **不要摘下七咒之戒**')
    A('- ⚠ **不要走救赎路线**')
    A('- 原因：后期强力装备对七咒之戒的【佩戴时间】有硬性要求')
    A('- 多人模式下若开局没拿到，可在任务书【新手礼包and游玩须知】补领')
    A('')

    A('### 5. 次元之胃（整合包自制模组）')
    A('')
    A('- 把食物放进**次元之胃**，会按食物的**饱食度**给予对应的属性加成')
    A('- 胃里食物总饱食度越高，加成越多')
    A('- ⚠ **每种食物的饱食度只能被计算一次** —— 同一种食物摆满也只算一次')
    A('- 用**末影箱果 / 天体洋葱 / 虹彩香蕉**升级次元之胃')
    A('')

    A('### 6. 生命上限与农田')
    A('')
    A('- **饱食度满之后继续进食，可以获得生命上限提升**')
    A('- **农田不再会被踩坏**')
    A('')

    A('### 7. 食材获取的两个关键规则')
    A('')
    A('- **作物的获取方式部分经过魔改** —— 请以任务书【作物图鉴】为准，'
      '不要按原模组的攻略找')
    A('- **大部分可获得食材的生物，用小刀类工具击杀会产生特殊掉落** —— '
      '某种食材拿不到时，试着换小刀击杀对应生物')
    A('')

    A('### 8. 其它')
    A('')
    A('- **怪奇宝典**：把众多指南书编成一册。可将怪奇宝典与手中的指南书合成；'
      '手持怪奇宝典右键选择指南书，左键空气取消')
    A('- **战斗动作模组为 Better Combat**（更好的战斗），若影响游玩可自行删除')
    A('- **备份**：Simple Backups（简单备份），全量备份，'
      '位置 `.minecraft\\versions\\<版本名>\\simplebackups`')
    A('- **新手小屋蓝图**：任务书【新手礼包】领取。右键地面预览（**建议关闭光影**），'
      '`Alt + 滚轮` 调位置，右键空气切换水平/垂直，**潜行 + 右键地面**完成放置')
    A('')

    # 任务书结构
    A('## 四、任务书结构（10 个分组）')
    A('')
    A('| 分组 | 章节数 | 内容 |')
    A('|---|---|---|')
    groups = {}
    for c in quests['chapters']:
        g = c['groupTitle'] or '(未分组)'
        groups.setdefault(g, {'chapters': 0, 'quests': 0, 'titles': []})
        groups[g]['chapters'] += 1
        groups[g]['quests'] += c['questCount']
        if c['title']:
            groups[g]['titles'].append(c['title'])
    desc = {
        '冒险之旅': '主世界→下界→末地→各维度生态的探索线',
        'Boss料理师': '用料理做的武器打 Boss —— 整合包的核心战斗线',
        '纪念品长廊': '收集向：神器、厨神之证、永恒回忆',
        '财富宝典': '经济与生产自动化（厨艺、经营、钓鱼、农业、存储）',
        '作物图鉴': '各维度作物收集（数量最多的分组）',
        '食录逸闻': '食物图鉴，最大的一组（19 章）',
        '闲情雅致': '装饰、建筑、玩偶等休闲内容',
        '异界故事': '各模组独立维度（暮色森林、蜜蜂领域、梦域等）',
        '其它': '生物图鉴与难度调节',
        '特别鸣谢页': '致谢名单',
    }
    for g, info in groups.items():
        A(f"| **{g}** | {info['chapters']} | {desc.get(g, '')} |")
    A('')

    A('## 五、推进主线（最重要的引导）')
    A('')
    A('任务书里有两个**没有分组**的特殊章节，是全局入口：')
    A('')
    A('1. **新手礼包and游玩须知** —— 开局必看（上面那些机制都在这里）')
    A('2. **⭐指引-主线任务⭐** —— 64 个任务的推进路线图')
    A('')
    A('主线里每个关键节点完成时，**会在商店解锁新的可购买物品**。'
      '所以主线不只是"进度"，还决定了玩家能买到什么。')
    A('')
    A('详见 `main-quest.md`。')
    A('')

    A('## 六、这个整合包的"魔改"特点（避免给错建议）')
    A('')
    A('- **食物能当武器**：整合包有专门的 Boss 料理配方（`bossfoodrcp.js`），'
      '把料理做成强力武器是核心玩法')
    A('- **大量配方被移除**：为避免多个模组的同种作物重复，作者删掉了大量重复配方'
      '（`remove.js`）。所以「某个模组里明明有的配方」可能在本包中不存在')
    A('- **Alex 的洞穴已拆成六个独立维度**，不再是主世界的一个生物群系')
    A('- **作物有统一来源**：很多作物只能通过整合包指定的途径获得，不能按原模组的攻略找')
    A('- 有 **86 种自定义食物**（`vefc:` 命名空间）')
    A('')

    A('## 七、她该怎么用这些知识')
    A('')
    A('- 玩家问「XX 怎么获得」→ 先查 `tooltips.md`，再查 `item-names.json` + `quests.json`')
    A('- 玩家问「我该干嘛」→ 看 `main-quest.md`，结合玩家当前进度给下一步')
    A('- 玩家问「XX 是什么」→ 查 `item-names.json`（全量中英对照）')
    A('- 玩家问某个模组 → 查 `mods.md`')
    A('- **不知道就说不确定，不要编。** 但"基础问题"（上面第二章那些）必须知道')
    A('')

    return write(os.path.join(out_dir, 'pack-overview.md'), '\n'.join(L))


def build_main_quest(quests, out_dir):
    L = []
    A = L.append
    A('# 主线任务路线（⭐指引-主线任务⭐）')
    A('')
    A('按依赖关系排出的推进顺序。**这是给玩家导航的主干。**')
    A('')

    main = None
    starter = None
    for c in quests['chapters']:
        if '主线' in c['title']:
            main = c
        if '新手礼包' in c['title']:
            starter = c

    if starter:
        A('## 开场：新手礼包and游玩须知')
        A('')
        for i, q in enumerate(starter['quests'], 1):
            A(render_quest(q, i))
        A('')

    if main:
        ordered = topo_sort(main['quests'])
        A(f'## 主线：共 {len(ordered)} 个任务')
        A('')
        for i, q in enumerate(ordered, 1):
            A(render_quest(q, i))
            A('')

    return write(os.path.join(out_dir, 'main-quest.md'), '\n'.join(L))


def build_chapters(quests, out_dir):
    L = []
    A = L.append
    A('# 任务书全章节索引')
    A('')
    A(f"共 {quests['stats']['chapterCount']} 章 / "
      f"{quests['stats']['questCount']} 个任务。")
    A('')
    A('> 这里只列**任务标题**（快速定位用）。每个任务的需求、说明、奖励在 `quests.json` 里，'
      '用 `lookup.py` 查。')
    A('')

    cur_group = None
    for c in quests['chapters']:
        g = c['groupTitle'] or '(未分组)'
        if g != cur_group:
            A(f'## {g}')
            A('')
            cur_group = g
        title = c['title'] or '(无标题章节)'
        A(f'### {title}　（{c["questCount"]} 个任务）')
        A('')
        labels = [label(q) for q in c['quests']]
        if not labels:
            A('_（该章没有任务）_')
            A('')
            continue
        # 每行多个，节省篇幅
        A('、'.join(labels))
        A('')

    return write(os.path.join(out_dir, 'chapters.md'), '\n'.join(L))


def build_tooltips(tooltips, lang, out_dir):
    L = []
    A = L.append
    A('# 物品提示（整合包作者写的攻略）')
    A('')
    A('这些是作者直接写在物品上的提示，告诉玩家**怎么获得、怎么用**。'
      '玩家问"这玩意哪来的"时优先查这里。')
    A('')

    items = lang.get('item', {})
    blocks = lang.get('block', {})

    def name(ref):
        return items.get(ref) or blocks.get(ref) or ref

    for ref in sorted(tooltips):
        A(f'## {name(ref)}')
        A(f'`{ref}`')
        A('')
        for t in tooltips[ref]:
            A(f'- {t}')
        A('')

    return write(os.path.join(out_dir, 'tooltips.md'), '\n'.join(L))


def build_mods(mods, out_dir):
    L = []
    A = L.append
    A(f'# 模组清单（{len(mods)} 个）')
    A('')
    A('按 modid 排序。`中文名` 为模组自带的官方中文名（部分模组没有）。')
    A('')
    A('| modid | 名称 | 中文名 | 版本 | 加载器 |')
    A('|---|---|---|---|---|')
    for m in sorted(mods, key=lambda x: (x.get('modId') or 'zzz')):
        mid = m.get('modId') or '?'
        nm = (m.get('name') or '').replace('|', '/')[:60]
        zh = (m.get('nameZh') or '').replace('|', '/')
        ver = (m.get('version') or '')[:24] or '—'
        A(f'| `{mid}` | {nm} | {zh} | {ver} | {m.get("loader") or "?"} |')
    A('')
    return write(os.path.join(out_dir, 'mods.md'), '\n'.join(L))


def build_readme(out_dir, stats):
    text = f'''# 知识库 —— 香草纪元：食旅纪行

这是 Angel_ICE 的「游戏常识」。**回答任何游戏内问题之前，先来这里查。**

## 文件说明

| 文件 | 内容 | 什么时候看 |
|---|---|---|
| `pack-overview.md` | 整合包总览 + **核心机制**（键位、Boss 料理循环、经济、七咒之戒、次元之胃…） | **必读**，尤其是回答"这游戏怎么玩"时 |
| `main-quest.md` | 主线任务路线图（按依赖排序，含每个任务的说明） | 玩家问"我该干嘛"时 |
| `chapters.md` | {stats['chapters']} 章全部任务标题（快速定位） | 玩家提到某个任务/章节时 |
| `tooltips.md` | 作者写在物品上的提示（怎么获得、怎么用） | 玩家问"这东西哪来的"时 |
| `mods.md` | {stats['mods']} 个模组清单 | 玩家问某个模组时 |
| `quests.json` | 全量结构化任务数据（{stats['quests']} 个任务） | 需要精确查任务需求/奖励时 |
| `item-names.json` | {stats['items']} 条物品中英对照 | 需要把 `modid:item` 翻成中文时 |
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
curl --noproxy '*' -G --data-urlencode "type=quest" --data-urlencode "q=末影龙" \\
     "http://127.0.0.1:3001/knowledge/search"

# 也可以把关键词放进 JSON body，完全不用管编码
curl --noproxy '*' -X POST -H "Content-Type: application/json" \\
     -d '{{"type":"quest","q":"末影龙"}}' "http://127.0.0.1:3001/knowledge/search"

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
| `extract_quests.py` | 解析 {stats['chapters']} 个章节文件 → 结构化任务 JSON（含翻译） |
| `extract_mods.py` | 扫 mods 目录 → 模组名/modid/版本/加载器 |
| `extract_tooltips.py` | 从 kubejs 客户端脚本抽物品提示 |
| `build_kb.py` | 组装成 `pack-overview.md` / `main-quest.md` / `chapters.md` 等 |
| `vanilla_zh.json` | 原版物品中文名（客户端 jar 只有 en_us，需手工补） |

### 已知限制

- **原版方块名**：`vanilla_zh.json` 只覆盖了约 330 个常用项。任务书里出现罕见原版
  物品时可能仍是英文 id。
- **结构名**（如 `terramity:prismatic_pond`）没有翻译来源，保持原样。
- **模组中文名**：{stats['mods']} 个模组里约 {stats['mods_zh']} 个自带官方中文名，其余显示英文名。
- **`?` 物品**：少数任务的需求物品在 lang 里查不到，显示为 `?`。

---

_本目录由 `_tools/` 下的脚本从整合包本体生成，请勿手工编辑——改了会被下次重建覆盖。_
'''
    return write(os.path.join(out_dir, 'README.md'), text)


# ---------------------------------------------------------------- main

def load_any(raw_dir, names, default=None):
    """按顺序找第一个存在的文件并加载。"""
    for n in names:
        p = os.path.join(raw_dir, n)
        if os.path.exists(p):
            d = load(p, None)
            if d is not None:
                return d
    return default if default is not None else {}


def main():
    raw_dir = sys.argv[1]
    kubejs_dir = sys.argv[2]
    out_dir = sys.argv[3]

    quests = load_any(raw_dir, ['quests.json'])
    lang = load_any(raw_dir, ['item-names.json', 'lang_zh.json'])
    mods = load_any(raw_dir, ['mods.json'], [])
    tooltips = load_any(raw_dir, ['tooltips.json'])

    if not quests:
        print('!! 找不到 quests.json，先跑 extract_quests.py')
        return 1

    sizes = {}
    # README 里的数字全部现算，避免重建后统计过时
    qstats = quests.get('stats') or {}
    ch_list = quests.get('chapters') or []
    stats = {
        'chapters': qstats.get('chapterCount') or len(ch_list),
        'quests': qstats.get('questCount') or sum(len(c.get('quests') or []) for c in ch_list),
        'mods': len(mods),
        'mods_zh': sum(1 for m in mods if m.get('nameZh')),
        'items': sum(len(v) for v in lang.values() if isinstance(v, dict)),
    }
    sizes['README.md'] = build_readme(out_dir, stats)
    sizes['pack-overview.md'] = build_overview(quests, mods, kubejs_dir, out_dir)
    sizes['main-quest.md'] = build_main_quest(quests, out_dir)
    sizes['chapters.md'] = build_chapters(quests, out_dir)
    sizes['tooltips.md'] = build_tooltips(tooltips, lang, out_dir)
    sizes['mods.md'] = build_mods(mods, out_dir)

    # 直接拷贝 json 供 lookup 用
    for fn in ('quests.json',):
        src = os.path.join(raw_dir, fn)
        if os.path.exists(src):
            with io.open(src, encoding='utf-8') as f:
                data = f.read()
            sizes[fn] = write(os.path.join(out_dir, fn), data)
    sizes['item-names.json'] = write(
        os.path.join(out_dir, 'item-names.json'),
        json.dumps(lang, ensure_ascii=False, indent=1))

    # 把查询脚本一并放到知识库根目录，这样知识库是自包含的
    lookup_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lookup.py')
    if os.path.exists(lookup_src):
        with io.open(lookup_src, encoding='utf-8') as f:
            sizes['lookup.py'] = write(os.path.join(out_dir, 'lookup.py'), f.read())
    else:
        print('  !! 未找到 lookup.py（查询脚本），知识库将缺少查询入口')

    print(f'知识库输出到 {out_dir}')
    for k, v in sizes.items():
        print(f'  {k:<20} {v / 1024:>8.1f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
