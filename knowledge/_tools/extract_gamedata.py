#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从整合包本体抽取「游戏数据」—— 配方 / 标签 / 掉落表 / 说明书 —— 给 knowledge.js 用。

和 extract_lang.py 等是一套：那几个抽「名字、任务、提示」，这个抽「东西怎么来、怎么用」。

数据层叠顺序（后者覆盖前者，与游戏里 datapack 的加载顺序一致）：
  1. versions/1.20.1/1.20.1.jar          原版
     libraries/…/forge-*-universal.jar    Forge 本体（forge:* 标签在这里）
  2. mods/*.jar                          模组（覆盖原版同 id）
  3. kubejs/data/                        整合包自己的数据包（优先级最高）

KubeJS 脚本（server_scripts）对配方/标签/掉落的修改**不在这里处理** ——
那是 JS，交给 kubejs_emulate.js 在模拟环境里跑。

Forge/Fabric 的加载条件（mod_loaded 等）按本包实际装了哪些模组求值，
条件不满足的配方直接丢掉 —— 否则会出现「配方存在，但原料的模组没装」的假配方。

输出：knowledge/generated/gamedata.json

用法：
  python3 extract_gamedata.py [整合包目录]
  默认目录：~/Library/Application Support/minecraft
"""

import json
import os
import re
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), 'generated')
PACK = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Library/Application Support/minecraft')

RECIPE_RE = re.compile(r'^data/([^/]+)/recipes/(.+)\.json$')
TAG_RE = re.compile(r'^data/([^/]+)/tags/(items|blocks|entity_types)/(.+)\.json$')
LOOT_RE = re.compile(r'^data/([^/]+)/loot_tables/(blocks|entities|chests|gameplay)/(.+)\.json$')
LANG_RE = re.compile(r'^assets/([^/]+)/lang/(zh_cn|en_us)\.json$')
# assets/<ns>/patchouli_books/<book>/<lang>/(entries|categories)/...json   （新式，1.20 主流）
# data/<ns>/patchouli_books/<book>/<lang>/...                              （老式）
PATCH_RE = re.compile(r'^(?:assets|data)/([^/]+)/patchouli_books/([^/]+)/(zh_cn|en_us)/(entries|categories)/(.+)\.json$')


def jload(raw):
    try:
        return json.loads(raw.decode('utf-8-sig'))
    except Exception:
        try:
            # 有些模组的 json 带注释 / 尾逗号
            txt = raw.decode('utf-8-sig', 'replace')
            txt = re.sub(r'^\s*//.*$', '', txt, flags=re.M)
            txt = re.sub(r',(\s*[}\]])', r'\1', txt)
            return json.loads(txt)
        except Exception:
            return None


# ------------------------------------------------------------------ 数据源

def sources():
    """按优先级从低到高产出 (名字, 读取器)。读取器产出 (相对路径, 读字节的函数)。"""
    vanilla = os.path.join(PACK, 'versions', '1.20.1', '1.20.1.jar')
    if os.path.exists(vanilla):
        yield 'minecraft', zip_reader(vanilla)
    # Forge 本体：forge:* 标签（forge:rods/wooden、forge:cobblestone…）只在这里，不在 mods/
    import glob
    for fj in sorted(glob.glob(os.path.join(PACK, 'libraries', 'net', 'minecraftforge', 'forge', '*', 'forge-*-universal.jar'))):
        yield 'forge', zip_reader(fj)
    mods = os.path.join(PACK, 'mods')
    for f in sorted(os.listdir(mods)):
        if f.endswith('.jar'):
            yield f, zip_reader(os.path.join(mods, f))
    kdata = os.path.join(PACK, 'kubejs', 'data')
    if os.path.isdir(kdata):
        yield 'kubejs/data', dir_reader(os.path.join(PACK, 'kubejs'), 'data')
    kassets = os.path.join(PACK, 'kubejs', 'assets')
    if os.path.isdir(kassets):
        yield 'kubejs/assets', dir_reader(os.path.join(PACK, 'kubejs'), 'assets')


def zip_reader(path):
    def gen():
        try:
            z = zipfile.ZipFile(path)
        except Exception as e:
            print(f'  ⚠ 打不开 {os.path.basename(path)}：{e}', file=sys.stderr)
            return
        with z:
            for name in z.namelist():
                if name.endswith('.json') or name.endswith('.toml'):
                    yield name, (lambda n=name: z.read(n))
                elif name.endswith('.jar') and name.startswith('META-INF/jarjar/'):
                    # jar-in-jar：Forge 模组把依赖打包在里面，里面也可能有数据
                    try:
                        import io
                        inner = zipfile.ZipFile(io.BytesIO(z.read(name)))
                        for n2 in inner.namelist():
                            if n2.endswith('.json') or n2.endswith('.toml'):
                                yield n2, (lambda n=n2, zz=inner: zz.read(n))
                    except Exception:
                        pass
    return gen


def dir_reader(root, sub):
    def gen():
        base = os.path.join(root, sub)
        for dp, _, fs in os.walk(base):
            for f in fs:
                if f.endswith('.json'):
                    full = os.path.join(dp, f)
                    rel = os.path.relpath(full, root).replace(os.sep, '/')
                    yield rel, (lambda p=full: open(p, 'rb').read())
    return gen


# ------------------------------------------------------------------ 加载条件

def mod_ids():
    """本包实际装了哪些模组（modId）。用来求值 forge:mod_loaded。"""
    ids = {'minecraft', 'forge', 'c', 'kubejs'}
    for _, reader in sources():
        for name, read in reader():
            if name == 'META-INF/mods.toml':
                for m in re.finditer(r'modId\s*=\s*"([^"]+)"', read().decode('utf-8', 'replace')):
                    ids.add(m.group(1))
            elif name == 'fabric.mod.json':
                d = jload(read())
                if isinstance(d, dict) and d.get('id'):
                    ids.add(d['id'])
    return ids


def cond_ok(c, mods):
    if not isinstance(c, dict):
        return True
    t = c.get('type') or c.get('condition') or ''
    t = t.split(':')[-1]
    if t == 'mod_loaded':
        return c.get('modid') in mods
    if t in ('all_mods_loaded',):
        return all(v in mods for v in c.get('values', []))
    if t in ('any_mod_loaded',):
        return any(v in mods for v in c.get('values', []))
    if t == 'not':
        return not cond_ok(c.get('value') or (c.get('values') or [{}])[0], mods)
    if t == 'and':
        return all(cond_ok(v, mods) for v in c.get('values', []))
    if t == 'or':
        return any(cond_ok(v, mods) for v in c.get('values', []))
    if t == 'item_exists':
        return str(c.get('item', '')).split(':')[0] in mods
    if t == 'false':
        return False
    return True   # tag_empty / config 类：无从判断，保守地当成立


def conditions_ok(obj, mods):
    for key in ('conditions', 'forge:conditions', 'fabric:load_conditions'):
        cs = obj.get(key)
        if cs and not all(cond_ok(c, mods) for c in cs):
            return False
    return True


def unwrap_conditional(d, mods):
    """forge:conditional / meadow:conditional 是"外面包一层条件"的配方：拆出第一个条件成立的内层。"""
    t = d.get('type')
    if t == 'forge:conditional':
        for alt in d.get('recipes', []) or []:
            if isinstance(alt, dict) and all(cond_ok(c, mods) for c in alt.get('conditions', []) or []):
                inner = alt.get('recipe')
                return unwrap_conditional(inner, mods) if isinstance(inner, dict) else None
        return None
    if t == 'meadow:conditional':
        inner = d.get('recipe')
        return unwrap_conditional(inner, mods) if isinstance(inner, dict) else None
    return d


# ------------------------------------------------------------------ 掉落表 → 摘要

def loot_summary(table):
    """把一张掉落表压成 [{item|tag, count, when:[...]}]。
    只保留"会掉什么、在什么条件下"—— 精确概率对她没用，条件（精准采集/剪刀/玩家击杀）才有用。"""
    out = []

    def conds_of(obj):
        tags = []
        for c in obj.get('conditions', []) or []:
            ct = str(c.get('condition', '')).split(':')[-1]
            if ct == 'match_tool':
                pred = c.get('predicate', {})
                if 'enchantments' in pred:
                    ens = [str(e.get('enchantment', '')).split(':')[-1] for e in pred['enchantments']]
                    tags.append('需要' + '/'.join(ens))
                elif pred.get('items'):
                    tags.append('需要工具 ' + ','.join(pred['items']))
                elif pred.get('tag'):
                    tags.append('需要工具 #' + pred['tag'])
                else:
                    tags.append('需要特定工具')
            elif ct == 'killed_by_player':
                tags.append('玩家击杀')
            elif ct in ('random_chance', 'random_chance_with_looting', 'table_bonus'):
                tags.append('概率')
            elif ct == 'inverted':
                inner = conds_of({'conditions': [c.get('term', {})]})
                tags.extend('不' + x for x in inner)
            elif ct == 'block_state_property':
                tags.append('特定状态（如成熟）')
            elif ct == 'survives_explosion':
                pass
            elif ct:
                tags.append(ct)
        return tags

    def count_of(e):
        for f in e.get('functions', []) or []:
            if str(f.get('function', '')).endswith('set_count'):
                n = f.get('count')
                if isinstance(n, (int, float)):
                    return n
                if isinstance(n, dict) and 'min' in n:
                    return f"{n.get('min')}-{n.get('max')}"
        return 1

    def walk(e, inherited):
        if not isinstance(e, dict):
            return
        t = str(e.get('type', '')).split(':')[-1]
        when = inherited + conds_of(e)
        if t == 'item' and e.get('name'):
            out.append({'item': e['name'], 'count': count_of(e), 'when': when})
        elif t == 'tag' and e.get('name'):
            out.append({'tag': e['name'], 'count': count_of(e), 'when': when})
        elif t == 'loot_table' and e.get('name'):
            out.append({'table': e['name'], 'when': when})
        for ch in e.get('children', []) or []:
            walk(ch, when)

    for pool in table.get('pools', []) or []:
        pw = conds_of(pool)
        for e in pool.get('entries', []) or []:
            walk(e, pw)
    # 去重
    seen, uniq = set(), []
    for x in out:
        k = json.dumps(x, sort_keys=True, ensure_ascii=False)
        if k not in seen:
            seen.add(k)
            uniq.append(x)
    return uniq


# ------------------------------------------------------------------ 说明书文本

FMT_RE = re.compile(r'\$\(([^)]*)\)')


def patch_text(s, lang):
    if not isinstance(s, str):
        return ''
    if s in lang:           # 有的书把文字写成翻译键
        s = lang[s]
    s = s.replace('$(br2)', '\n').replace('$(br)', '\n')
    s = FMT_RE.sub('', s)
    return s.strip()


# ------------------------------------------------------------------ 主流程

def main():
    t0 = time.time()
    mods = mod_ids()
    print(f'已装模组 {len(mods)} 个')

    recipes, rec_src = {}, {}
    tags = {'items': {}, 'blocks': {}, 'entity_types': {}}
    loot = {}
    lang = {'zh_cn': {}, 'en_us': {}}
    patch_raw = {}   # (ns, book, kind, path) → {lang: obj}
    dropped_by_cond = 0

    for src, reader in sources():
        for name, read in reader():
            m = RECIPE_RE.match(name)
            if m:
                d = jload(read())
                if not isinstance(d, dict):
                    continue
                rid = f'{m.group(1)}:{m.group(2)}'
                if not conditions_ok(d, mods):
                    recipes.pop(rid, None)   # 高优先级的数据包可以用"条件不满足"来删配方
                    dropped_by_cond += 1
                    continue
                d = unwrap_conditional(d, mods)
                if d is None:
                    recipes.pop(rid, None)
                    dropped_by_cond += 1
                    continue
                recipes[rid] = d
                rec_src[rid] = src
                continue
            m = TAG_RE.match(name)
            if m:
                d = jload(read())
                if not isinstance(d, dict):
                    continue
                tid = f'{m.group(1)}:{m.group(3)}'
                vals = []
                for v in d.get('values', []):
                    if isinstance(v, dict):
                        v = v.get('id')
                    if isinstance(v, str):
                        vals.append(v)
                bucket = tags[m.group(2)]
                if d.get('replace') or tid not in bucket:
                    bucket[tid] = vals
                else:
                    bucket[tid] = bucket[tid] + [v for v in vals if v not in bucket[tid]]
                continue
            m = LOOT_RE.match(name)
            if m:
                d = jload(read())
                if isinstance(d, dict):
                    loot[f'{m.group(1)}:{m.group(2)}/{m.group(3)}'] = loot_summary(d)
                continue
            m = LANG_RE.match(name)
            if m:
                d = jload(read())
                if isinstance(d, dict):
                    lang[m.group(2)].update({k: v for k, v in d.items() if isinstance(v, str)})
                continue
            m = PATCH_RE.match(name)
            if m:
                d = jload(read())
                if isinstance(d, dict):
                    key = (m.group(1), m.group(2), m.group(4), m.group(5))
                    patch_raw.setdefault(key, {})[m.group(3)] = d
                continue

    # 说明书：优先中文，没有就英文
    guide = []
    for (ns, book, kind, p), by_lang in patch_raw.items():
        if kind != 'entries':
            continue
        lg = 'zh_cn' if 'zh_cn' in by_lang else 'en_us'
        e = by_lang[lg]
        L = lang['zh_cn'] if lg == 'zh_cn' else lang['en_us']
        pages = []
        items = set()
        for pg in e.get('pages', []) or []:
            if not isinstance(pg, dict):
                continue
            for k in ('title', 'text'):
                t = patch_text(pg.get(k), L)
                if t:
                    pages.append(t)
            for k in ('recipe', 'recipe2', 'item', 'entity'):
                v = pg.get(k)
                if isinstance(v, str):
                    items.add(v.split('{')[0])
        icon = e.get('icon') if isinstance(e.get('icon'), str) else None
        guide.append({
            'book': f'{ns}:{book}', 'entry': p, 'lang': lg,
            'name': patch_text(e.get('name'), L),
            'icon': icon.split('{')[0] if icon else None,
            'items': sorted(items),
            'text': '\n'.join(pages)[:4000],
        })

    # 只留"物品/方块/实体名"的翻译，给名字解析用（全量 lang 太大）
    names = {}
    for lg in ('zh_cn', 'en_us'):
        for k, v in lang[lg].items():
            mm = re.match(r'^(item|block|entity)\.([a-z0-9_.-]+)\.([a-z0-9_/.-]+)$', k)
            if mm:
                rid = f'{mm.group(2)}:{mm.group(3)}'
                names.setdefault(rid, {})[lg] = v

    os.makedirs(OUT_DIR, exist_ok=True)
    out = {
        'meta': {
            'pack': PACK, 'builtAt': time.strftime('%Y-%m-%d %H:%M:%S'),
            'mods': sorted(mods),
            'counts': {
                'recipes': len(recipes), 'droppedByCondition': dropped_by_cond,
                'itemTags': len(tags['items']), 'blockTags': len(tags['blocks']),
                'lootTables': len(loot), 'guideEntries': len(guide), 'names': len(names),
            },
        },
        'recipes': recipes,
        'recipeSource': rec_src,
        'tags': tags,
        'loot': loot,
        'guide': guide,
        'names': names,
    }
    path = os.path.join(OUT_DIR, 'gamedata.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(out['meta']['counts'], ensure_ascii=False))
    print(f'→ {path}（{os.path.getsize(path) / 1e6:.1f} MB，{time.time() - t0:.0f}s）')


if __name__ == '__main__':
    main()
