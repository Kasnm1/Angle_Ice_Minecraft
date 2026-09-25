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
LOG_FILE="$SKILL_DIR/logs/bridge.log"

# node：优先 $NODE，其次 PATH，最后退到 WorkBuddy 自带的（macOS 上 PATH 里常常没有 node）
NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  for c in "$HOME"/.workbuddy-ai/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && NODE="$c"
  done
fi
if [ -z "$NODE" ]; then
  echo "找不到 node。设 NODE=/path/to/node 再跑。"
  exit 1
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=npm

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Bridge already running (PID=$PID, port $BRIDGE_PORT)"
    echo "  Check status: curl http://localhost:${BRIDGE_PORT}/status"
    echo "  Stop it: bash $(dirname "$0")/stop.sh"
    exit 0
  fi
fi

# 在项目目录里检查（require 按 cwd 找 node_modules）；缺了就按 package.json 完整装，别只装三个
if ! (cd "$SKILL_DIR" && "$NODE" -e "require('mineflayer')") 2>/dev/null; then
  echo "Installing bridge dependencies..."
  (cd "$SKILL_DIR" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --silent)
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

mkdir -p "$SKILL_DIR/logs"
# ⚠️ 不要写成 `(cd … && nohup … &)`：`&` 会把整串放进子 shell，$! 记下的是子 shell 而不是 node，stop.sh 就杀不掉她
cd "$SKILL_DIR" || exit 1
nohup "$NODE" bridge-server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

for i in $(seq 1 10); do
  sleep 1
  # --noproxy：环境里的 HTTP 代理会劫持 localhost
  if curl -sf --noproxy '*' "http://127.0.0.1:${BRIDGE_PORT}/status" > /dev/null 2>&1; then
    echo "Bridge started successfully (PID=$(cat "$PID_FILE"))"
    echo "  Status: curl --noproxy '*' http://127.0.0.1:${BRIDGE_PORT}/status"
    echo "  Logs: tail -f $LOG_FILE"
    exit 0
  fi
done

echo "Bridge startup timed out. Check logs: cat $LOG_FILE"
exit 1
