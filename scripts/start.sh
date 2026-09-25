#!/bin/bash
# minecraft-bridge startup helper
#
# 配置优先读同目录的 config.json（环境变量可临时覆盖）。
# 默认身份固定为 Angel_ICE，Forge 服务端在 config.json 里设 "MC_FORGE": "1"。
#
# 临时覆盖示例（Forge 服务器）：
#   MC_FORGE=1 MC_HOST=127.0.0.1 MC_PORT=25565 MC_VERSION=1.20.1 bash scripts/start.sh
# 没有 MC_FORGE=1 时，Forge 服务端会以
# "This server has mods that require Forge to be installed on the client." 拒绝原版协议客户端。

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PORT="${MC_BRIDGE_PORT:-3001}"
PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/minecraft-bridge-$(id -u).pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Bridge already running (PID=$PID, port $BRIDGE_PORT)"
    echo "  Check status: curl http://localhost:${BRIDGE_PORT}/status"
    echo "  Stop it: bash $(dirname "$0")/stop.sh"
    exit 0
  fi
fi

if ! node -e "require('mineflayer')" 2>/dev/null; then
  echo "Installing bridge dependencies..."
  cd "$SKILL_DIR" && npm install mineflayer mineflayer-pathfinder vec3 --silent
fi

echo "Starting Minecraft Bridge..."
echo "  Minecraft target: ${MC_HOST:-localhost}:${MC_PORT:-25565}"
echo "  API port: $BRIDGE_PORT"
if [ "${MC_FORGE:-0}" = "1" ]; then
  echo "  Forge/FML handshake: ENABLED"
else
  echo "  Forge/FML handshake: disabled (set MC_FORGE=1 for modded servers)"
fi
echo ""

nohup node "$SKILL_DIR/bridge-server.js" > /tmp/minecraft-bridge.log 2>&1 &
echo $! > "$PID_FILE"

for i in $(seq 1 10); do
  sleep 1
  if curl -sf "http://localhost:${BRIDGE_PORT}/status" > /dev/null 2>&1; then
    echo "Bridge started successfully (PID=$(cat $PID_FILE))"
    echo "  Status: curl http://localhost:${BRIDGE_PORT}/status"
    echo "  Logs: tail -f /tmp/minecraft-bridge.log"
    exit 0
  fi
done

echo "Bridge startup timed out. Check logs: cat /tmp/minecraft-bridge.log"
exit 1
