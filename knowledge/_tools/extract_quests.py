#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 FTB Quests 的 .snbt 任务书解析成结构化 JSON。

输入：<pack>/config/ftbquests/quests/
输出：quests.json

结构：
{
  "groups": {group_id: "组名"},
  "chapters": [
    {
      "id", "filename", "group", "groupTitle", "title", "icon", "orderIndex",
      "questCount",
      "quests": [
        {"id","title","subtitle","description":[...],"tasks":[...],
         "rewards":[...],"dependencies":[...],"x","y","shape","optional","hidden"}
      ]
    }
  ],
  "stats": {...}
}
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from snbt import parse  # noqa: E402

# ---- 中文名词典（由 extract_lang.py 生成）---------------------------------
LANG = {'item': {}, 'block': {}}


def load_lang(path):
    global LANG
    if path and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            LANG = json.load(f)
        return True
    return False


def zh(ref):
    """把 'minecraft:crafting_table' 翻成 '工作台'；查不到就返回原 id。"""
    if not isinstance(ref, str) or ':' not in ref:
        return ref
    for cat in ('item', 'block'):
        v = LANG.get(cat, {}).get(ref)
        if v:
            return v
    return ref


def zh_ref(ref):
    """带原 id 的展示形式：'工作台 (minecraft:crafting_table)'。"""
    if not isinstance(ref, str) or ':' not in ref:
        return ref
    n = zh(ref)
    return n if n == ref else f'{n}（{ref}）'


# 去掉 Minecraft 的颜色代码 & 格式代码
FMT_RE = re.compile(r'&[0-9a-fk-orA-FK-OR]')


def strip_fmt(s):
    if not isinstance(s, str):
        return s
    return FMT_RE.sub('', s)


def clean_item(s):
    """把 'mod:item' 变成可读的 'item'，保留 mod 前缀。"""
    if not isinstance(s, str):
        return s
    return s


def load(path):
    with open(path, encoding='utf-8') as f:
        return parse(f.read())


def task_summary(t):
    """把一个 task 压成一句人话。"""
    tt = t.get('type', '?')
    if tt == 'item':
        item = t.get('item', {})
        if isinstance(item, dict):
            item = item.get('item', '?')
        n = t.get('count', 1)
        name = zh(item)
        return f'提交 {name} x{n}' if name == item else f'提交 {name}（{item}）x{n}'
    if tt == 'checkmark':
        return '确认勾选'
    if tt == 'advancement':
        return f'达成进度 {t.get("advancement", "?")}'
    if tt == 'dimension':
        return f'前往维度 {t.get("dimension", "?")}'
    if tt == 'stat':
        return f'统计 {t.get("stat", "?")} >= {t.get("value", "?")}'
    if tt == 'observation':
        return f'观察 {t.get("observation", "?")}'
    if tt == 'biome':
        return f'到访生物群系 {t.get("biome", "?")}'
    if tt == 'kill':
        ent = t.get('entity', '?')
        return f'击杀 {zh(ent) if ":" in str(ent) else ent} x{t.get("value", 1)}'
    if tt == 'xp':
        return f'获得经验 {t.get("value", "?")}'
    if tt == 'xp_levels':
        return f'达到等级 {t.get("value", "?")}'
    if tt == 'stage':
        return f'阶段 {t.get("stage", "?")}'
    if tt == 'structure':
        return f'找到结构 {t.get("structure", "?")}'
    if tt == 'fluid':
        return f'流体 {zh(t.get("fluid", "?"))} x{t.get("amount", "?")}'
    if tt == 'energy':
        return f'能量 {t.get("value", "?")}'
    if tt == 'quests':
        return '完成前置任务'
    if tt == 'gamestage':
        return f'游戏阶段 {t.get("stage", "?")}'
    if tt == 'biome_tag':
        return f'到访生物群系标签 {t.get("tag", "?")}'
    if tt == 'entity_tag':
        return f'击杀实体标签 {t.get("tag", "?")}'
    # 未知类型：把非 id 字段都列出来
    keys = [k for k in t if k not in ('id', 'type')]
    return f'{tt} ' + ' '.join(f'{k}={t[k]}' for k in keys[:3])


def reward_summary(r):
    rt = r.get('type', '?')
    if rt == 'item':
        item = r.get('item', {})
        if isinstance(item, dict):
            item = item.get('item', '?')
        n = r.get('count', 1)
        name = zh(item)
        return f'{name} x{n}' if name == item else f'{name}（{item}）x{n}'
    if rt == 'xp':
        return f'经验 {r.get("xp", "?")}'
    if rt == 'xp_levels':
        return f'等级 {r.get("xp_levels", "?")}'
    if rt == 'loot':
        return f'战利品表 {r.get("table", "?")}'
    if rt == 'choice':
        return '多选一'
    if rt == 'random':
        return '随机奖励'
    if rt == 'command':
        return f'命令 {r.get("command", "?")}'
    if rt == 'stage':
        return f'阶段 {r.get("stage", "?")}'
    if rt == 'advancement':
        return f'进度 {r.get("advancement", "?")}'
    return rt


def extract_chapter(path):
    d = load(path)
    quests = []
    for q in d.get('quests', []) or []:
        desc = q.get('description') or []
        if isinstance(desc, str):
            desc = [desc]
        desc = [strip_fmt(x) for x in desc if isinstance(x, str)]

        tasks = []
        for t in q.get('tasks', []) or []:
            if isinstance(t, dict):
                raw_item = (t.get('item', {}).get('item')
                            if isinstance(t.get('item'), dict) else t.get('item'))
                tasks.append({
                    'id': t.get('id'),                       # 交任务 / 点对号要用（ftbquests:submit_task 的 taskId）
                    'type': t.get('type'),
                    'consume': bool(t.get('consume_items')), # 交物品任务：True = 要点提交才收走东西
                    'summary': task_summary(t),
                    'item': raw_item,
                    'itemZh': zh(raw_item) if raw_item else None,
                    'count': t.get('count'),
                })

        rewards = []
        for r in q.get('rewards', []) or []:
            if isinstance(r, dict):
                rewards.append({
                    'id': r.get('id'),                       # 领单个奖励（ftbquests:claim_reward）
                    'type': r.get('type'),
                    'summary': reward_summary(r),
                })

        quests.append({
            'id': q.get('id'),
            'title': strip_fmt(q.get('title') or ''),
            'subtitle': strip_fmt(q.get('subtitle') or ''),
            'icon': q.get('icon'),
            'iconZh': zh(q.get('icon')) if q.get('icon') else None,
            'description': desc,
            'tasks': tasks,
            'rewards': rewards,
            'dependencies': q.get('dependencies') or [],
            'x': q.get('x'),
            'y': q.get('y'),
            'shape': q.get('shape'),
            'optional': bool(q.get('optional')),
            'hidden': q.get('hidden'),
        })

    return {
        'id': d.get('id'),
        'filename': d.get('filename'),
        'group': d.get('group'),
        'title': strip_fmt(d.get('title') or ''),
        'icon': d.get('icon'),
        'orderIndex': d.get('order_index'),
        'defaultQuestShape': d.get('default_quest_shape'),
        'questCount': len(quests),
        'quests': quests,
    }


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else '.'
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'quests.json'
    lang_path = sys.argv[3] if len(sys.argv) > 3 else None

    if load_lang(lang_path):
        print(f'已加载中文词典: {lang_path} '
              f'(item {len(LANG.get("item", {}))} / block {len(LANG.get("block", {}))})')
    else:
        print('未提供中文词典，物品名将保持英文 id')

    groups = {}
    gp = os.path.join(base, 'chapter_groups.snbt')
    if os.path.exists(gp):
        for g in load(gp).get('chapter_groups', []) or []:
            groups[g['id']] = strip_fmt(g.get('title') or '')

    chapters = []
    cdir = os.path.join(base, 'chapters')
    for fn in sorted(os.listdir(cdir)):
        if not fn.endswith('.snbt'):
            continue
        try:
            ch = extract_chapter(os.path.join(cdir, fn))
        except Exception as e:  # noqa: BLE001
            print(f'  !! {fn} 解析失败: {e}', file=sys.stderr)
            continue
        ch['groupTitle'] = groups.get(ch['group'], '')
        chapters.append(ch)

    # 排序：先按组顺序（chapter_groups 里的顺序），再按 order_index
    group_order = {gid: i for i, gid in enumerate(groups.keys())}
    chapters.sort(key=lambda c: (group_order.get(c['group'], 999),
                                 c['orderIndex'] if c['orderIndex'] is not None else 999))

    total_quests = sum(c['questCount'] for c in chapters)
    result = {
        'groups': groups,
        'chapters': chapters,
        'stats': {
            'groupCount': len(groups),
            'chapterCount': len(chapters),
            'questCount': total_quests,
        },
    }

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    print(f'组 {len(groups)} · 章节 {len(chapters)} · 任务 {total_quests}')
    for c in chapters:
        print(f"  [{c['groupTitle'] or c['group']}] {c['title'] or '(无标题)'} "
              f"({c['questCount']} 任务) order={c['orderIndex']}")


if __name__ == '__main__':
    main()
