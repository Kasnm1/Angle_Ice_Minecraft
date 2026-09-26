#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收集整合包的中文词条，生成 item/block 名称字典。

来源与优先级（后者覆盖前者）：
  0. tools/vanilla_zh.json  ← 手工补的原版物品名（客户端 jar 只有 en_us）
  1. mods/*.jar  →  assets/<ns>/lang/zh_cn.json
  2. kubejs/assets/<ns>/lang/zh_cn.json   ← 整合包自己的汉化/改名，优先级最高

输出 lang_zh.json:
{
  "item": {"terramity:prism_solution_bucket": "棱光溶液桶", ...},
  "block": {"...": "..."},
  "entity": {...},
  "effect": {...},
  "other": {...}
}

键会被归一化成 "<namespace>:<path>"（去掉 item./block. 前缀）。
"""

import io
import json
import os
import re
import sys
import zipfile

# 我们关心的键前缀 -> 分类
CATS = {
    'item': 'item',
    'block': 'block',
    'entity': 'entity',
    'effect': 'effect',
    'fluid': 'fluid',
    'itemGroup': 'itemGroup',
    'biome': 'biome',
}


# 这些后缀不是独立物品，是说明/提示文本，要剔除
NOISE_SUFFIX = re.compile(
    r'\.(description|tooltip|tooltips|desc|info|comment|author|credit|'
    r'subtitle|hint|usage|lore|pack\.description)(_?\d+)?(\.|$)',   # 中间段也算：xxx.tooltip.summary、xxx.tooltip2（Create 大量这种）
    re.I,
)


def add(dst, key, val):
    """key 形如 'item.terramity.xxx' 或 'item.terramity:xxx'，归一化成 'ns:path'。"""
    if not isinstance(val, str) or not val.strip():
        return
    val = val.strip()
    # 跳过未翻译的占位
    if val.startswith('%') or val.startswith('{'):
        return
    if '.' not in key:
        return
    head, rest = key.split('.', 1)
    cat = CATS.get(head)
    if not cat:
        return
    if cat in ('itemGroup', 'biome'):
        return
    if ':' in rest:
        ns, path = rest.split(':', 1)
    else:
        ns, _, path = rest.partition('.')
    if not ns or not path:
        return
    if NOISE_SUFFIX.search(path):
        return
    dst.setdefault(cat, {})[f'{ns}:{path}'] = val


def harvest_json(text, dst):
    try:
        data = json.loads(text)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    n = 0
    for k, v in data.items():
        add(dst, k, v)
        n += 1
    return n


def main():
    pack = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'lang_zh.json'

    dst = {}
    jars_ok = 0
    entries = 0

    # ---- 0. 手工原版词典（优先级最低）----
    vanilla = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vanilla_zh.json')
    if os.path.isfile(vanilla):
        with io.open(vanilla, encoding='utf-8') as f:
            vd = json.load(f)
        for k, v in vd.items():
            if k.startswith('_'):
                continue
            dst.setdefault('item', {})[f'minecraft:{k}'] = v
            dst.setdefault('block', {})[f'minecraft:{k}'] = v
        print(f'[0/3] 原版手工词典: {len([k for k in vd if not k.startswith("_")])} 条')

    # ---- 1. mods/*.jar ----
    mods_dir = os.path.join(pack, 'mods')
    if os.path.isdir(mods_dir):
        for fn in sorted(os.listdir(mods_dir)):
            if not fn.lower().endswith('.jar'):
                continue
            try:
                with zipfile.ZipFile(os.path.join(mods_dir, fn)) as z:
                    for n in z.namelist():
                        if n.endswith('/lang/zh_cn.json'):
                            try:
                                txt = z.read(n).decode('utf-8', errors='replace')
                            except Exception:
                                continue
                            entries += harvest_json(txt, dst)
                    jars_ok += 1
            except Exception:
                continue

    print(f'[1/3] mods/*.jar: 扫描 {jars_ok} 个，累计处理 {entries} 条键')

    # ---- 2. kubejs 覆盖（优先级更高）----
    kb = os.path.join(pack, 'kubejs', 'assets')
    kb_entries = 0
    kb_files = 0
    if os.path.isdir(kb):
        for ns in sorted(os.listdir(kb)):
            p = os.path.join(kb, ns, 'lang', 'zh_cn.json')
            if not os.path.isfile(p):
                continue
            try:
                with io.open(p, encoding='utf-8') as f:
                    kb_entries += harvest_json(f.read(), dst)
                kb_files += 1
            except Exception:
                continue
    print(f'[2/3] kubejs/assets 覆盖: {kb_files} 个文件，{kb_entries} 条键')

    with io.open(out_path, 'w', encoding='utf-8') as f:
        json.dump(dst, f, ensure_ascii=False, indent=1)

    print('--- 结果 ---')
    total = 0
    for cat in sorted(dst):
        n = len(dst[cat])
        total += n
        print(f'  {cat:<8} {n}')
    print(f'  合计     {total} 个唯一键')

    # 抽样
    for probe in ['terramity:prism_solution_bucket', 'minecraft:crafting_table',
                  'xiangcaomengjia:wood_selling_bin']:
        for cat in ('item', 'block'):
            if probe in dst.get(cat, {}):
                print(f'  样例 {probe} -> {dst[cat][probe]}')
                break


if __name__ == '__main__':
    main()
