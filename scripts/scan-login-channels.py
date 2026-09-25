#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描 Forge 模组包，找出所有注册了「登录握手包」的 mod。
判定依据（来自 Forge 1.20.1 源码）：
  SimpleChannel.MessageBuilder:
    - markAsLoginPacket()      -> loginPacketGenerators = 无参构造单例
    - buildLoginPacketList(f)  -> loginPacketGenerators = 自定义生成器
    - noResponse()             -> needsResponse = false  (客户端不得回包，否则 unexpected_query_response)
  默认 needsResponse = true    -> 客户端必须回包
  HandshakeHandler.indexFirst  -> C2S 侧注册模式
  Zeta 自研: ZetaHandshakeMessage / registerLogin
"""
import os
import re
import sys
import zipfile
import io

MODDIR = sys.argv[1] if len(sys.argv) > 1 else r"<整合包目录>\mods"
OUT = sys.argv[2] if len(sys.argv) > 2 else "login-scan.txt"

MARKERS = [
    b"markAsLoginPacket",
    b"buildLoginPacketList",
    b"noResponse",
    b"indexFirst",
    b"ZetaHandshakeMessage",
    b"registerLogin",
    b"packetsNeedResponse",
    b"dispatchLoginPacket",
    b"LoginPayloadEvent",
]

# 资源位置候选： modid:path
RL_RE = re.compile(rb"^[a-z][a-z0-9_]{1,28}:[a-z0-9_/]{1,48}$")

def printable_strings(buf, minlen=4):
    out = []
    cur = bytearray()
    for b in buf:
        if 0x20 <= b < 0x7f:
            cur.append(b)
        else:
            if len(cur) >= minlen:
                out.append(bytes(cur))
            cur = bytearray()
    if len(cur) >= minlen:
        out.append(bytes(cur))
    return out

def scan_jar(path):
    hits = {}        # marker -> [class entries]
    channels = set()
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        return None, str(e)
    for info in zf.infolist():
        if not info.filename.endswith(".class"):
            continue
        try:
            data = zf.read(info)
        except Exception:
            continue
        found = [m.decode() for m in MARKERS if m in data]
        if not found:
            continue
        for m in found:
            hits.setdefault(m, []).append(info.filename)
        # 只对命中的 class 抽通道名，控制噪音
        for s in printable_strings(data, 4):
            if b" " in s or b"/" in s and b":" not in s:
                pass
            if RL_RE.match(s):
                channels.add(s.decode("ascii", "replace"))
    zf.close()
    return (hits, sorted(channels)), None

def main():
    jars = []
    for root, dirs, files in os.walk(MODDIR):
        for f in files:
            if f.lower().endswith(".jar"):
                jars.append(os.path.join(root, f))
    jars.sort()
    print("jar 总数: %d" % len(jars), flush=True)

    results = []
    errors = []
    for i, j in enumerate(jars, 1):
        r, err = scan_jar(j)
        if err:
            errors.append((os.path.basename(j), err))
            continue
        hits, channels = r
        if hits:
            results.append((os.path.basename(j), hits, channels))
        if i % 50 == 0:
            print("  ... %d/%d" % (i, len(jars)), flush=True)

    lines = []
    lines.append("=" * 78)
    lines.append("Forge 登录握手包 注册扫描报告")
    lines.append("目录: %s" % MODDIR)
    lines.append("jar 总数: %d   命中 jar: %d" % (len(jars), len(results)))
    lines.append("=" * 78)
    lines.append("")

    # 汇总 marker 频次
    freq = {}
    for _, hits, _ in results:
        for m in hits:
            freq[m] = freq.get(m, 0) + 1
    lines.append("--- marker 频次 ---")
    for m, c in sorted(freq.items(), key=lambda x: -x[1]):
        lines.append("  %-22s %d" % (m, c))
    lines.append("")

    # 逐个 jar
    lines.append("--- 明细 ---")
    for name, hits, channels in results:
        lines.append("")
        lines.append("[%s]" % name)
        for m, cls in sorted(hits.items()):
            lines.append("    %s  (%d 个 class)" % (m, len(cls)))
            for c in cls[:12]:
                lines.append("        %s" % c)
            if len(cls) > 12:
                lines.append("        ... 其余 %d 个" % (len(cls) - 12))
        if channels:
            lines.append("    候选通道名:")
            for c in channels:
                lines.append("        %s" % c)

    if errors:
        lines.append("")
        lines.append("--- 读取失败 ---")
        for n, e in errors:
            lines.append("  %s : %s" % (n, e))

    text = "\n".join(lines)
    with io.open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(text[:6000])
    print()
    print("完整报告 -> %s" % OUT)

main()
