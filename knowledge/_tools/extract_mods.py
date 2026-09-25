#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描 mods 目录，提取每个模组的元信息。

对每个 .jar：
  - Forge: META-INF/mods.toml  (modLoader/modId/displayName/description/version)
  - Fabric/Quilt: fabric.mod.json
  - 中文名: assets/<modid>/lang/zh_cn.json 里的 "itemGroup.<modid>" / "mod.<modid>.name"
            / "itemGroup.<modid>.main" 等键，或 <modid>.name

输出 mods.json:
[{file, modId, name, nameZh, version, loader, description, jarSizeKB}]
"""

import io
import json
import os
import re
import sys
import zipfile

# ---- 极简 TOML 读取（只处理 mods.toml 里的 [[mods]] 块）--------------------

def strip_toml_comment(v):
    """去掉不在引号内的 # 行内注释。

    mods.toml 里很常见 `modId="x" #mandatory`，直接取值会把引号和注释一起带出来。
    """
    out = []
    quote = None
    for ch in v:
        if quote:
            if ch == quote:
                quote = None
            out.append(ch)
        elif ch in '"\'':
            quote = ch
            out.append(ch)
        elif ch == '#':
            break
        else:
            out.append(ch)
    return ''.join(out).strip()


def unquote(v):
    """去掉成对的引号（支持 ''' / \"\"\" 多行字符串）。"""
    for q in ('"""', "'''"):
        if len(v) >= 6 and v.startswith(q) and v.endswith(q):
            return v[3:-3]
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        return v[1:-1]
    return v


def parse_mods_toml(text):
    """返回 [[mods]] 块列表，每个是 dict。"""
    out = []
    cur = None
    in_mods = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('[['):
            # 段头常带行内注释：`[[mods]] #mandatory`。不剥掉就永远匹配不上，
            # 结果是整个 [[mods]] 块被跳过，modId / 版本 / 显示名全丢。
            header = strip_toml_comment(line).replace(' ', '')
            in_mods = header == '[[mods]]'
            if in_mods:
                cur = {}
                out.append(cur)
            continue
        if line.startswith('['):
            in_mods = False
            continue
        if not in_mods or cur is None:
            continue
        m = re.match(r'([A-Za-z0-9_.-]+)\s*=\s*(.+)$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        # 多行字符串 ''' 或 """
        if v.startswith("'''") or v.startswith('"""'):
            q = v[:3]
            if v.endswith(q) and len(v) > 3:
                v = v[3:-3]
            else:
                v = v[3:]
        else:
            # 先剥行内注释，再去引号。顺序反了就会留下 `"x" #mandatory` 这种残渣。
            v = unquote(strip_toml_comment(v))
        cur[k] = v
    return out


def parse_inline_mods(text):
    """解析 lowcodefml / Modrinth 风格的 `mods = [ { ... }, { ... } ]` 内联表数组。

    这种写法没有 `[[mods]]` 段头，所以 parse_mods_toml() 一个块都抓不到：
        mods = [
          { modId = 'farmersdelightcompat', version = '1.1.0', displayName = "..." },
        ]
    """
    m = re.search(r'^\s*mods\s*=\s*\[', text, re.M)
    if not m:
        return []

    # 手工找数组的收尾 ]，跳过字符串里的括号
    i = m.end()
    depth = 1
    quote = None
    while i < len(text) and depth:
        c = text[i]
        if quote:
            if c == quote:
                quote = None
        elif c in '"\'':
            quote = c
        elif c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
        i += 1
    body = text[m.end():i - 1]

    kv_re = re.compile(
        r'([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^,}]+)')
    out = []
    for tbl in re.findall(r'\{([^{}]*)\}', body):
        d = {}
        for km in kv_re.finditer(tbl):
            k = km.group(1)
            v = unquote(km.group(2).strip())
            if v:
                d[k] = v
        if d:
            out.append(d)
    return out


# Forge 在构建时会把 ${file.jarVersion} 这类占位符替换成真实版本号，
# 我们手上只有 jar，所以从文件名里回推一个近似版本（如 appleskin-forge-mc1.20.1-2.5.1.jar → 2.5.1）。
_VER_RE = re.compile(r'\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?')
_VERLIKE_RE = re.compile(r'^(mc)?(\d+)\.(\d+)(\.\d+)?$', re.I)


def is_mc_version(s):
    """判断某个片段是不是 Minecraft 版本号。

    只看「major.minor」是不够的：`2.5.1` 和 `1.20.1` 形状完全一样。
    但 MC 的版本号永远是 1.x（1.7 之后），所以用 major==1 且 minor 7..99 来界定，
    显式带 `mc` 前缀的也直接认。
    """
    m = _VERLIKE_RE.match(s)
    if not m:
        return False
    if m.group(1):
        return True
    return int(m.group(2)) == 1 and 7 <= int(m.group(3)) <= 99


def version_from_filename(fn):
    """从 jar 文件名猜版本号；猜不到返回 None。"""
    stem = re.sub(r'\.jar$', '', fn, flags=re.I)
    cands = []
    for part in re.split(r'[-_+ ]', stem):
        part = part.strip()
        if not part or is_mc_version(part):
            continue  # 跳过 MC 版本片段，如 mc1.20.1 / 1.20.1
        for m in _VER_RE.finditer(part):
            cands.append(m.group(0))
    return cands[-1] if cands else None


def is_placeholder_version(v):
    """判断版本号是不是没展开的构建占位符。"""
    if not v:
        return True
    return '${' in v or v.startswith('@') or v in ('${file.jarVersion}',)


def read_zip_text(zf, names):
    for n in names:
        try:
            return zf.read(n).decode('utf-8', errors='replace')
        except KeyError:
            continue
        except Exception:
            continue
    return None


# 用于从 lang 文件里找模组中文名
NAME_KEYS = [
    'itemGroup.{id}', 'itemGroup.{id}.main', 'itemGroup.{id}.tab',
    'itemGroup.tab{id}', 'mod.{id}.name', '{id}.name',
    'itemGroup.{id}.creative_tab', 'creativetab.{id}',
]


def zh_name_from_lang(zf, modid):
    raw = read_zip_text(zf, [f'assets/{modid}/lang/zh_cn.json'])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    for pat in NAME_KEYS:
        k = pat.format(id=modid)
        if k in data and isinstance(data[k], str):
            v = data[k].strip()
            if v and not v.startswith('%'):
                return v
    # 退一步：任何包含 modid 的 itemGroup 键
    for k, v in data.items():
        if k.startswith('itemGroup.') and modid in k and isinstance(v, str):
            v = v.strip()
            if v and not v.startswith('%'):
                return v
    return None


def scan_jar(path):
    fn = os.path.basename(path)
    try:
        size_kb = round(os.path.getsize(path) / 1024)
    except OSError:
        size_kb = None

    info = {
        'file': fn,
        'modId': None,
        'name': None,
        'nameZh': None,
        'version': None,
        'loader': None,
        'description': None,
        'jarSizeKB': size_kb,
    }

    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())

            # --- Forge / NeoForge ---
            toml = read_zip_text(zf, ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml'])
            if toml:
                # 先试标准 [[mods]] 段，再试 lowcodefml 的内联表数组
                blocks = parse_mods_toml(toml) or parse_inline_mods(toml)
                if blocks:
                    b = blocks[0]
                    info['loader'] = 'forge'
                    info['modId'] = b.get('modId')
                    info['name'] = b.get('displayName')
                    info['version'] = b.get('version')
                    desc = b.get('description') or ''
                    desc = re.sub(r'\s+', ' ', desc).strip()
                    info['description'] = desc[:400] or None

            # --- Fabric / Quilt ---
            if not info['modId']:
                fmj = read_zip_text(zf, ['fabric.mod.json', 'quilt.mod.json'])
                if fmj:
                    try:
                        d = json.loads(fmj)
                    except Exception:
                        d = None
                    if isinstance(d, dict):
                        q = d.get('quilt_loader') if 'quilt_loader' in d else None
                        if q:
                            info['loader'] = 'quilt'
                            info['modId'] = q.get('id')
                            meta = q.get('metadata') or {}
                            info['name'] = meta.get('name')
                            info['version'] = q.get('version')
                            info['description'] = (meta.get('description') or '')[:400] or None
                        else:
                            info['loader'] = 'fabric'
                            info['modId'] = d.get('id')
                            info['name'] = d.get('name')
                            info['version'] = d.get('version')
                            info['description'] = (d.get('description') or '')[:400] or None

            # --- 中文名 ---
            modid = info['modId']
            if modid:
                info['nameZh'] = zh_name_from_lang(zf, modid)

            # 有些包把 lang 放在别的 modid 下，用文件名兜底探测
            if not info['nameZh']:
                cands = [n for n in names
                         if n.startswith('assets/') and n.endswith('/lang/zh_cn.json')]
                for c in cands[:12]:
                    try:
                        d = json.loads(zf.read(c).decode('utf-8', errors='replace'))
                    except Exception:
                        continue
                    for k, v in d.items():
                        if k.startswith('itemGroup.') and isinstance(v, str):
                            v = v.strip()
                            if v and not v.startswith('%'):
                                info['nameZh'] = v
                                break
                    if info['nameZh']:
                        break

    except zipfile.BadZipFile:
        info['name'] = '(非 zip / 损坏)'
    except Exception as e:  # noqa: BLE001
        info['name'] = f'(读取失败: {type(e).__name__})'

    # modId 再兜底洗一遍（万一 toml 写法很脏）
    if info['modId']:
        info['modId'] = unquote(strip_toml_comment(str(info['modId']))).strip() or None

    # Forge 的 ${file.jarVersion} 占位符没有展开，从文件名回推一个近似版本
    if is_placeholder_version(info['version']):
        info['version'] = version_from_filename(fn) or ''

    if not info['name']:
        info['name'] = info['modId'] or fn
    return info


def main():
    mods_dir = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'mods.json'

    jars = sorted(f for f in os.listdir(mods_dir) if f.lower().endswith('.jar'))
    print(f'发现 {len(jars)} 个 jar，开始扫描…')

    mods = []
    for i, fn in enumerate(jars, 1):
        mods.append(scan_jar(os.path.join(mods_dir, fn)))
        if i % 50 == 0:
            print(f'  … {i}/{len(jars)}')

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(mods, f, ensure_ascii=False, indent=1)

    named = sum(1 for m in mods if m['nameZh'])
    print(f'完成：{len(mods)} 个模组，其中 {named} 个有中文名')
    print('前 15 个：')
    for m in mods[:15]:
        print(f"  {m['modId'] or '?':<28} {m['nameZh'] or m['name']}")


if __name__ == '__main__':
    main()
