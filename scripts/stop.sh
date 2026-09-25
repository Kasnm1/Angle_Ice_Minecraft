#!/bin/bash
PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/minecraft-bridge-$(id -u).pid"

if [ ! -f "$PID_FILE" ]; then
  echo "Bridge was not started via start.sh (PID file missing)."
  echo "Trying to stop by process match..."
  if command -v pkill > /dev/null 2>&1; then
    pkill -f "bridge-server.js" && echo "Bridge stopped" || echo "No running bridge process found"
  elif command -v powershell.exe > /dev/null 2>&1; then
    # Git Bash on Windows has no pkill; fall back to WMI + Stop-Process
    powershell.exe -NoProfile -Command \
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*bridge-server*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
      && echo "Bridge stopped" || echo "No running bridge process found"
  else
    echo "Neither pkill nor powershell.exe available — kill the node bridge-server.js process manually."
    exit 1
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm "$PID_FILE"
  echo "Minecraft Bridge stopped (PID=$PID)"
else
  echo "Bridge process no longer exists (PID=$PID)"
  rm "$PID_FILE"
fi
