#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 kubejs 客户端脚本里抽取物品提示（tooltip）与本地化改名。

tooltips.js 结构：
  event.addAdvanced("mod:item", (item, advanced, text) => {
      text.add(1, "§d• §d击杀大鳄龟概率掉落");
      ...
  });

输出 tooltips.json:
{ "mod:item": ["击杀大鳄龟概率掉落", ...] }
"""

import io
import json
import os
import re
import sys

FMT_RE = re.compile(r'§[0-9a-fk-orA-FK-OR]')


def strip_fmt(s):
    return FMT_RE.sub('', s).strip()


def parse_tooltips(path):
    if not os.path.isfile(path):
        return {}
    with io.open(path, encoding='utf-8') as f:
        src = f.read()

    out = {}
    # 定位 event.addAdvanced("id", (…)=>{ … })
    pat = re.compile(
        r'event\.addAdvanced\(\s*["\']([^"\']+)["\']\s*,\s*\([^)]*\)\s*=>\s*\{(.*?)\n\s*\}\)',
        re.S,
    )
    for m in pat.finditer(src):
        item = m.group(1)
        body = m.group(2)
        lines = re.findall(r'text\.add\(\s*\d+\s*,\s*["\'](.*?)["\']\s*\)', body, re.S)
        tips = [strip_fmt(x) for x in lines]
        tips = [t for t in tips if t]
        if tips:
            out.setdefault(item, []).extend(tips)
    return out


def parse_lang_override(path):
    """xiaoyu.js 之类里可能有 Lang.add 改名，尽力抽取。"""
    out = {}
    if not os.path.isfile(path):
        return out
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for m in re.finditer(
            r'(?:event\.add|add)\(\s*["\']([\w.]+)["\']\s*,\s*["\'](.*?)["\']\s*\)', src):
        k, v = m.group(1), m.group(2)
        if k.startswith(('item.', 'block.', 'entity.', 'effect.')):
            out[k] = strip_fmt(v)
    return out


def main():
    kubejs = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'tooltips.json'

    merged = {}
    for rel in [
        'client_scripts/src/tips/tooltips.js',
        'client_scripts/src/tips/tagtooltips.js',
    ]:
        p = os.path.join(kubejs, rel)
        d = parse_tooltips(p)
        print(f'  {rel}: {len(d)} 个物品有提示')
        for k, v in d.items():
            merged.setdefault(k, []).extend(v)

    with io.open(out_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)

    print(f'合计 {len(merged)} 个物品有提示，共 {sum(len(v) for v in merged.values())} 条')


if __name__ == '__main__':
    main()
