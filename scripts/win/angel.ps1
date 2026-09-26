# Angel_ICE 在 Windows 上的启停 / 状态 / 自测。
#
# 为什么用计划任务启动：Windows OpenSSH 会在 SSH 会话结束时把会话里起的子进程一起结束（作业对象），
# 所以 bridge / mind 交给计划任务跑 —— 它们在 Kasumi 的登录会话里独立运行，SSH 断开不受影响。
#
# 用法（在仓库根目录，或从 Mac 用 angel-win.sh 远程调）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win\angel.ps1 install      注册计划任务（只要一次）
#   ... angel.ps1 start [bridge|mind|all]     启动（all = 先 bridge，等它连上再起 mind）
#   ... angel.ps1 stop  [bridge|mind|all]
#   ... angel.ps1 status                      进程、端口、她在不在线
#   ... angel.ps1 selftest                    跑全部纯逻辑自测
#   ... angel.ps1 logs [bridge|mind] [行数]

param([string]$cmd = 'status', [string]$what = 'all', [int]$n = 40)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# 本文件存成带 BOM 的 UTF-8：Windows 自带的 PowerShell 5.1 读无 BOM 的脚本按 GBK 解，中文会乱、甚至解析失败
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $Logs | Out-Null
$Node = (Get-Command node).Source

function TaskName($w) { "AngelICE-$w" }
function Procs($w) {
  $script = if ($w -eq 'bridge') { 'bridge-server.js' } else { 'mind.js' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($script) -and $_.CommandLine -notmatch 'selftest' }
}
function Api($port, $path) {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$port$path" -TimeoutSec 3 } catch { $null }
}

switch ($cmd) {
  'install' {
    # 用 schtasks.exe：ScheduledTasks 那套 CIM cmdlet 在 SSH 会话里报"无效命名空间"（2026-09-26 实测）
    foreach ($w in 'bridge', 'mind') {
      $js = if ($w -eq 'bridge') { 'bridge-server.js' } else { 'mind.js' }
      $log = Join-Path $Logs "$w.log"
      $bat = Join-Path $Logs "run-$w.cmd"
      # 启动脚本：UTF-8 代码页、进仓库根、输出追加进日志
      Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`nchcp 65001 >nul`r`ncd /d `"$Root`"`r`n`"$Node`" $js >> `"$log`" 2>&1`r`n"
      $user = "$env:USERDOMAIN\$env:USERNAME"
      # 用 XML 定义一个**没有触发器**的任务：只在 /Run 时启动（/SC ONCE 要日期，格式随系统区域变，还会在当天到点自己跑一次）
      # InteractiveToken = 在 Kasumi 的登录会话里跑，不要密码；SSH 断开不受影响
      $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>$user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>$bat</Command><WorkingDirectory>$Root</WorkingDirectory></Exec></Actions>
</Task>
"@
      $xf = Join-Path $Logs "task-$w.xml"
      [IO.File]::WriteAllText($xf, $xml, [Text.Encoding]::Unicode)
      schtasks /Create /TN (TaskName $w) /XML $xf /F | Out-Null
      if ($LASTEXITCODE -eq 0) { "已注册计划任务 $(TaskName $w)" } else { "注册 $(TaskName $w) 失败（退出码 $LASTEXITCODE）" }
    }
  }
  'start' {
    $list = if ($what -eq 'all') { @('bridge', 'mind') } else { @($what) }
    foreach ($w in $list) {
      if (Procs $w) { "$w 已经在跑"; continue }
      schtasks /Run /TN (TaskName $w) | Out-Null
      if ($w -eq 'bridge') {
        # 等 bridge 连上服务器再起 mind（mind 醒来第一件事就要看世界）
        for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; $s = Api 3001 '/status'; if ($s -and $s.connected) { break } }
        if ($s -and $s.connected) { "bridge 已连上服务器：$($s.username) @ $($s.position.x),$($s.position.y),$($s.position.z)" } else { "bridge 60 秒内没连上，看 logs\bridge.log" }
      } else { Start-Sleep 5; "mind 已启动" }
    }
  }
  'stop' {
    $list = if ($what -eq 'all') { @('mind', 'bridge') } else { @($what) }
    foreach ($w in $list) {
      $p = Procs $w
      if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; "$w 已停（$(@($p).Count) 个进程）" } else { "$w 没在跑" }
      schtasks /End /TN (TaskName $w) 2>&1 | Out-Null
    }
  }
  'status' {
    foreach ($w in 'bridge', 'mind') { $p = Procs $w; "{0,-7} {1}" -f $w, $(if ($p) { "在跑 PID $(@($p).ProcessId -join ',')，内存 $([math]::Round((@($p) | ForEach-Object { (Get-Process -Id $_.ProcessId).WorkingSet64 } | Measure-Object -Sum).Sum / 1MB)) MB" } else { '没在跑' }) }
    $s = Api 3001 '/status'
    if ($s) { "服务器：$(if ($s.connected) { '在线' } else { '离线' })  $($s.username) 血 $($s.health) 饱食 $($s.food) @ $($s.position.x),$($s.position.y),$($s.position.z)" }
    $m = Api 3003 '/mind'
    if ($m) { "意识：模型 $($m.model)  想过 $($m.stats.thinks) 次  身体 $($m.body)" }
  }
  'selftest' {
    Set-Location $Root
    foreach ($f in 'knowledge.js', 'ambition.js', 'memory-store.js', 'speech.js', 'pathing.js', 'place.js', 'hands.js', 'mind.js', 'palette-registry.js', 'block-palette.js', 'item-registry.js', 'llm-workbuddy.js') {
      $out = (& $Node $f --selftest 2>&1 | Out-String)
      $sum = [regex]::Matches($out, '\d+ */ *\d+ *通过|\d+ passed, \d+ failed') | Select-Object -Last 1
      $fails = ([regex]::Matches($out, '(?m)^\s*FAIL.*$') | ForEach-Object { $_.Value.Trim() }) -join ' | '
      "{0,-20} {1} {2}" -f $f, $sum, $fails
    }
    foreach ($f in 'bridge-server.js', 'body.js') { & $Node --check $f; "{0,-20} --check ok" -f $f }
  }
  'logs' {
    $w = if ($what -eq 'all') { 'mind' } else { $what }
    Get-Content (Join-Path $Logs "$w.log") -Tail $n -Encoding UTF8
  }
  default { "未知命令 $cmd（install / start / stop / status / selftest / logs）" }
}
