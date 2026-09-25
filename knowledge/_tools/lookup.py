#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
知识库查询工具 —— Angel_ICE 查游戏资料用。

用法：
  python lookup.py quest <关键词>     在任务里搜（标题/说明/需求物品）
  python lookup.py item  <关键词>     物品名查询（中文→id，或 id→中文）
  python lookup.py chapter <关键词>   找章节
  python lookup.py tip   <关键词>     物品提示
  python lookup.py mod   <关键词>     模组查询
  python lookup.py main               打印主线任务顺序
  python lookup.py stats              知识库统计

例：
  python lookup.py quest 末影龙
  python lookup.py item 棱彩解药桶
  python lookup.py item terramity:      # 某模组的物品
  python lookup.py chapter 蜜蜂
"""

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, default=None):
    p = os.path.join(HERE, name)
    try:
        with io.open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def read_text(name):
    p = os.path.join(HERE, name)
    try:
        with io.open(p, encoding='utf-8') as f:
            return f.read()
    except Exception:
        return ''


# ---------------------------------------------------------------- quest

def _s(v):
    """把任意值安全转成字符串（icon 可能是 dict）。"""
    if isinstance(v, dict):
        return ' '.join(str(x) for x in v.values())
    return str(v or '')


def cmd_quest(kw):
    d = load('quests.json')
    kw_l = kw.lower()
    hits = []
    for c in d.get('chapters', []):
        for q in c.get('quests', []):
            blob = ' '.join([
                _s(q.get('title')), _s(q.get('subtitle')),
                ' '.join(q.get('description') or []),
                ' '.join(t.get('summary') or '' for t in q.get('tasks', [])),
                _s(q.get('icon')), _s(q.get('iconZh')),
            ]).lower()
            if kw_l in blob:
                hits.append((c, q))

    print(f'找到 {len(hits)} 个任务包含「{kw}」\n')
    for c, q in hits[:40]:
        print(f"[{c.get('groupTitle') or '未分组'} › {c.get('title') or '?'}]")
        print(f"  任务：{q.get('title') or q.get('iconZh') or _s(q.get('icon')) or '(无标题)'}")
        if q.get('subtitle'):
            print(f"  副标题：{q['subtitle']}")
        for t in q.get('tasks', [])[:4]:
            print(f"    需求：{t['summary']}")
        for r in q.get('rewards', [])[:3]:
            print(f"    奖励：{r['summary']}")
        for dd in (q.get('description') or [])[:3]:
            dd = dd.strip()
            if dd and not dd.startswith('{'):
                print(f"    说明：{dd[:200]}")
        print()
    if len(hits) > 40:
        print(f'… 还有 {len(hits) - 40} 条，请用更具体的关键词')


# ---------------------------------------------------------------- item

def cmd_item(kw):
    lang = load('item-names.json')
    items = lang.get('item', {})
    blocks = lang.get('block', {})
    kw_l = kw.lower()

    # 中文名搜索
    zh_hits = []
    for ref, name in list(items.items()) + list(blocks.items()):
        if kw_l in name.lower() or kw_l in ref.lower():
            zh_hits.append((ref, name))

    print(f'找到 {len(zh_hits)} 个匹配「{kw}」的物品\n')
    for ref, name in zh_hits[:60]:
        print(f'  {name}　→　{ref}')
    if len(zh_hits) > 60:
        print(f'… 还有 {len(zh_hits) - 60} 条')


# ---------------------------------------------------------------- chapter

def cmd_chapter(kw):
    d = load('quests.json')
    kw_l = kw.lower()
    print(f'匹配「{kw}」的章节：\n')
    for c in d.get('chapters', []):
        if kw_l in (c.get('title') or '').lower() or \
           kw_l in (c.get('groupTitle') or '').lower():
            print(f"[{c.get('groupTitle') or '未分组'}] {c.get('title') or '(无标题)'} "
                  f"—— {c['questCount']} 个任务")
            names = [q.get('title') for q in c['quests'] if q.get('title')]
            if names:
                print(f"   任务：{'、'.join(names[:30])}")
            print()


# ---------------------------------------------------------------- tip

def cmd_tip(kw):
    text = read_text('tooltips.md')
    if not text:
        print('没有 tooltips.md')
        return
    blocks = text.split('\n## ')
    kw_l = kw.lower()
    n = 0
    for b in blocks[1:]:
        if kw_l in b.lower():
            print('## ' + b.strip() + '\n')
            n += 1
    print(f'（{n} 条）' if n else '没找到相关提示')


# ---------------------------------------------------------------- mod

def cmd_mod(kw):
    text = read_text('mods.md')
    kw_l = kw.lower()
    lines = [l for l in text.splitlines() if kw_l in l.lower() and l.startswith('|')]
    print(f'匹配「{kw}」的模组（{len(lines)}）：\n')
    for l in lines[:40]:
        print(' ', l)
    if len(lines) > 40:
        print(f'… 还有 {len(lines) - 40} 条')


# ---------------------------------------------------------------- main

def cmd_main():
    text = read_text('main-quest.md')
    print(text[:12000] if text else '没有 main-quest.md')


def cmd_stats():
    d = load('quests.json')
    lang = load('item-names.json')
    print('知识库统计')
    print(f"  章节   {d.get('stats', {}).get('chapterCount', '?')}")
    print(f"  任务   {d.get('stats', {}).get('questCount', '?')}")
    print(f"  物品词条 {len(lang.get('item', {}))}")
    print(f"  方块词条 {len(lang.get('block', {}))}")
    for f in ['pack-overview.md', 'main-quest.md', 'chapters.md',
              'tooltips.md', 'mods.md']:
        p = os.path.join(HERE, f)
        if os.path.exists(p):
            print(f'  {f:<18} {os.path.getsize(p) / 1024:>7.1f} KB')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    arg = ' '.join(sys.argv[2:])

    table = {
        'quest': cmd_quest,
        'item': cmd_item,
        'chapter': cmd_chapter,
        'tip': cmd_tip,
        'mod': cmd_mod,
        'main': lambda: cmd_main(),
        'stats': lambda: cmd_stats(),
    }
    fn = table.get(cmd)
    if not fn:
        print(__doc__)
        return 1
    if cmd in ('main', 'stats'):
        fn()
    else:
        if not arg:
            print(f'请给个关键词，例如：python lookup.py {cmd} 末影龙')
            return 1
        fn(arg)
    return 0


if __name__ == '__main__':
    sys.exit(main())
