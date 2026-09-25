#!/usr/bin/env python3
"""扫描一个立方体区域内的非空气方块。

为什么需要这个：在模组服上 `GET /block` 返回的**方块名可能整片错位**
（实测 1.20.1 Forge 包：放下的 `white_wool` 读回来是 `fire`），
所以"我放的东西到底落哪了"不能靠单个坐标的名字判断 ——
要么看**变化集**（放之前扫一遍、放之后扫一遍，比对差异），
要么只信 `GET /inventory` 的数量变化。

用法：
    python scan-blocks.py                      # 默认以机器人脚下为中心扫一小块
    python scan-blocks.py --center 34 74 -135 --radius 4
    python scan-blocks.py --box 31 72 -139 39 78 -131

用持久 HTTP 连接，所以几百次查询也很快。
"""
import argparse
import http.client
import json
import sys

# 这些名字都表示"这里没有方块"。
# 注意 "" —— 它**不是**空气，而是"有方块但这个 block state 没有名字"
# （模组服常见）。默认把它归到这里只是为了让输出干净，需要时用 --show-unnamed 看。
AIRISH = {"air", "cave_air", "void_air"}


def fetch_block(conn, host, port, x, y, z):
    """读一个坐标。返回 (block_name, note)。

    注意桥接的两种失败形态不一样：
      - 断线：{"error": "Bot not connected", "hint": ...}  ← 没有 success 字段
      - 坐标越界：可能带 success: false
    只看 success 会把断线误判成"读到了一个 None 名字的方块"。
    """
    for attempt in (1, 2):
        try:
            conn.request("GET", f"/block?x={x}&y={y}&z={z}")
            resp = conn.getresponse()
            data = json.loads(resp.read().decode("utf-8"))
            if "error" in data:
                return None, data["error"]
            if data.get("success") is False:
                return None, data.get("error") or "request failed"
            return data.get("block"), data.get("note")
        except Exception as e:
            if attempt == 2:
                return None, str(e)
            conn.close()
            conn = http.client.HTTPConnection(host, port, timeout=10)
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3001)
    ap.add_argument("--center", nargs=3, type=int, metavar=("X", "Y", "Z"),
                    help="扫描中心；默认取机器人的当前位置")
    ap.add_argument("--radius", type=int, default=4, help="中心周围各方向扩展的格数")
    ap.add_argument("--box", nargs=6, type=int, metavar=("X0", "Y0", "Z0", "X1", "Y1", "Z1"))
    ap.add_argument("--show-unnamed", action="store_true",
                    help="把无名方块（block 为空串）也列出来")
    args = ap.parse_args()

    conn = http.client.HTTPConnection(args.host, args.port, timeout=10)

    if args.box:
        x0, y0, z0, x1, y1, z1 = args.box
    else:
        center = args.center
        if center is None:
            conn.request("GET", "/position")
            pos = json.loads(conn.getresponse().read().decode("utf-8"))
            p = pos.get("position") or {}
            if "x" not in p:
                print(f"拿不到机器人位置：{pos}", file=sys.stderr)
                return 1
            center = [p["x"], p["y"], p["z"]]
            print(f"以机器人当前位置为中心：{tuple(center)}")
        cx, cy, cz = center
        r = args.radius
        x0, x1 = cx - r, cx + r
        y0, y1 = cy - r, cy + r
        z0, z1 = cz - r, cz + r

    found = {}
    unnamed = []
    errors = 0
    total = 0

    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                total += 1
                name, note = fetch_block(conn, args.host, args.port, x, y, z)
                if name is None:
                    errors += 1
                    if errors <= 3:
                        print(f"  ! ({x},{y},{z}) {note}", file=sys.stderr)
                    continue
                if name == "":
                    unnamed.append((x, y, z))
                    continue
                if name not in AIRISH:
                    found.setdefault(name, []).append((x, y, z))

    conn.close()

    print(f"\n扫描 {total} 格，错误 {errors}")
    print(f"非空气方块种类 {len(found)}：")
    for name, positions in sorted(found.items(), key=lambda kv: -len(kv[1])):
        sample = positions[:6]
        more = "" if len(positions) <= 6 else f" …共 {len(positions)} 处"
        print(f"  {name:26s} {sample}{more}")

    if unnamed:
        print(f"\n⚠️ 无名方块（block 为空串）{len(unnamed)} 处 —— "
              f"这些位置**有方块**，只是名字取不到。别当成空气。")
        if args.show_unnamed:
            print(f"  {unnamed[:12]}{' …' if len(unnamed) > 12 else ''}")

    print("\n提示：要确认某次放置的落点，请在放置**前后各扫一遍**并比对差异 —— "
          "不要相信任何单个坐标的名字。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
