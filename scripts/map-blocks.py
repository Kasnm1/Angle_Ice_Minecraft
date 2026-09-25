#!/usr/bin/env python3
"""把一个 y 高度上的方块打成俯视 ASCII 图 —— 用来判断"她能不能过去"。

为什么需要它：`GET /block` 的**名字不可信**（模组服上 `white_wool` 会读成 `fire`），
但**"实心 / 不是实心"这个信息是可用的** —— 它来自客户端碰撞箱，不依赖名字。
所以判断"哪里是墙、哪里有门、哪条路是通的"，看实心分布比看名字可靠得多。

用法：
    python map-blocks.py                       # 以机器人脚下为中心
    python map-blocks.py --y 74 --radius 12
    python map-blocks.py --x1 28 --x2 55 --z1 -145 --z2 -120 --y 74
    python map-blocks.py --y 74 --names        # 顺便标注出现最多的方块名（仅供参考）

图例：
    @  机器人所在格
    P  玩家所在格（需要 --players 提供，或用 --px/--pz 指定）
    #  实心（挡住去路）
    o  不是实心但**有方块**（可穿过，例如草、告示牌、活板门打开态）
    .  空气
    ?  读不到名字（block 为空串）—— **有方块**，别当空气
"""
import argparse
import http.client
import json
import sys
from collections import Counter

AIRISH = {"air", "cave_air", "void_air"}


def call(host, port, path, timeout=8):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    conn.request("GET", path)
    res = conn.getresponse()
    body = res.read().decode("utf-8", "replace")
    conn.close()
    try:
        return json.loads(body)
    except Exception:
        return {"raw": body}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3001)
    ap.add_argument("--y", type=int, default=None, help="要画的高度，默认取机器人脚下那层")
    ap.add_argument("--x1", type=int, default=None)
    ap.add_argument("--x2", type=int, default=None)
    ap.add_argument("--z1", type=int, default=None)
    ap.add_argument("--z2", type=int, default=None)
    ap.add_argument("--radius", type=int, default=10)
    ap.add_argument("--names", action="store_true", help="额外统计出现的方块名（仅供参考）")
    ap.add_argument("--px", type=int, default=None)
    ap.add_argument("--pz", type=int, default=None)
    args = ap.parse_args()

    pos = call(args.host, args.port, "/position")
    if not pos.get("success"):
        print("读不到位置：", pos, file=sys.stderr)
        return 1
    bx, by, bz = int(pos["x"]), int(pos["y"]), int(pos["z"])
    y = args.y if args.y is not None else by

    if args.x1 is None:
        args.x1, args.x2 = bx - args.radius, bx + args.radius
    if args.z1 is None:
        args.z1, args.z2 = bz - args.radius, bz + args.radius

    # 玩家位置（可选，只用于标记）
    px, pz = args.px, args.pz
    if px is None:
        pl = call(args.host, args.port, "/players")
        for p in (pl.get("players") or []):
            if not p.get("isSelf") and p.get("position"):
                px, pz = int(p["position"]["x"]), int(p["position"]["z"])

    print(f"机器人 ({bx}, {by}, {bz})   画 y={y}   范围 x[{args.x1},{args.x2}] z[{args.z1},{args.z2}]")
    if px is not None:
        print(f"玩家   ({px}, ?, {pz})")
    print()

    conn = http.client.HTTPConnection(args.host, args.port, timeout=15)
    names = Counter()
    rows = []
    for z in range(args.z1, args.z2 + 1):
        row = []
        for x in range(args.x1, args.x2 + 1):
            try:
                conn.request("GET", f"/block?x={x}&y={y}&z={z}")
                data = json.loads(conn.getresponse().read().decode("utf-8", "replace"))
                block = (data.get("block") or "")
                solid = data.get("solid")
            except Exception:
                conn = http.client.HTTPConnection(args.host, args.port, timeout=15)
                row.append("!")
                continue

            # ⚠️ 顺序很重要：**先判实心，再判名字**。
            # 反过来写的话，"有方块但名字读不出来"的格子会一律显示成 `?`，
            # 而其中实心的那些其实是墙 —— 于是整面模组墙在图里看起来像空地。
            # 这个 bug 真的误导过我一次：`?` 被当成"可能是墙"，实际探下去
            # 好几格是 solid:false 的装饰方块（挂旗、火）。
            if solid:
                row.append("#")
                names[block or "<无名>"] += 1
            elif block == "":
                # 有方块、不是实心、名字读不出来 —— 可穿过，但**不是空气**。
                # 注意：模组方块在 mineflayer 里 boundingBox 常给 'empty'，
                # 所以这里也可能是"实心但注册表不认识"，只能当"可疑"看待。
                row.append("?")
                names["<无名>"] += 1
            elif block in AIRISH:
                row.append(".")
            else:
                row.append("o")
                names[block] += 1
        rows.append(row)
    conn.close()

    # 标注机器人与玩家
    for (cx, cz, ch) in ((bx, bz, "@"), (px, pz, "P")):
        if cx is None or cz is None:
            continue
        ix, iz = cx - args.x1, cz - args.z1
        if 0 <= iz < len(rows) and 0 <= ix < len(rows[iz]):
            rows[iz][ix] = ch

    # 表头（每 10 格标一次 x）
    header = "     " + "".join(
        str((args.x1 + i) // 10 % 10) if (args.x1 + i) % 10 == 0 else " "
        for i in range(len(rows[0]))
    )
    print(header)
    for iz, row in enumerate(rows):
        print(f"{args.z1 + iz:>5}" + "".join(row))

    print()
    print("图例：@ 机器人  P 玩家  # 实心（挡路）  o 有名字但可穿过  . 空气  ? 无名且非实心（可疑）")
    if args.names:
        print()
        print("出现的方块名（**仅供参考** —— 模组服上名字可能整片错位）：")
        for name, n in names.most_common(20):
            print(f"  {name:<32} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
