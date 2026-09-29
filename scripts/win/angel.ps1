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
# 日志轮替：启动前，日志超过 20MB 就 bridge.log.1（已有 .1 就挪成 .2，最多留 3 份）再开新的。
# 为什么是"启动时轮替"而不是"跑到一半"：这个脚本管的就是启动，日志由 `>> $w.log` 追加
# （句柄在跑着的 node 手里），运行中改名/删除会让 Windows 上的追加句柄指向文件已消失 —— 日志丢。
# 启动前动手，此刻没有任何进程持有它，改名最安全。
# 为什么 20MB：bridge.log 实测 2.2MB / 几天，20MB 约等于两周到一个月一份，够回溯又不占盘。
$LogRotateBytes = 20MB
$LogKeep = 3   # 留 bridge.log.1 .2 .3，加上当前的 bridge.log 共 4 份；超过 3 份的最老的先删
function Rotate-Log($path) {
  if (-not (Test-Path $path)) { return }
  $len = (Get-Item $path).Length
  # 只在**超过** 20MB 时轮替。
  # ⚠️ 2026-09-28 codex R-fix5-低：这里写 `-le`（小于等于就 return）**才是对的** ——
  #    等价于"只有 $len > $LogRotateBytes 才往下走"。原来写的是 `-lt`：
  #    恰好等于 20MB 时 `-lt` 为假 → 不 return → 也会轮替，与"超过 20MB"不符。
  #    改成 `-le` 后，等于 20MB 不再轮替（严格大于才轮）。
  if ($len -le $LogRotateBytes) { return }
  # 从最老的一份开始往回挪：先删掉 .3（滚出去的那份），再把 .2 → .3、.1 → .2，最后当前 → .1
  $oldest = "$path.$LogKeep"
  if (Test-Path $oldest) { Remove-Item $oldest -Force }
  for ($i = $LogKeep - 1; $i -ge 1; $i--) {
    $src = "$path.$i"
    if (Test-Path $src) { Move-Item $src "$path.$($i + 1)" -Force }
  }
  Move-Item $path "$path.1" -Force
  "日志轮替：$([math]::Round($len / 1MB, 1)) MB 超 $([math]::Round($LogRotateBytes / 1MB, 0)) MB，已挪成 $(Split-Path $path -Leaf).1（最多留 $LogKeep 份）"
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
      # mind 要连 teamorouter（第三层模型兜底，国内直连不通）：.env 里有 LLM_PROXY 就让 Node 按环境变量走代理，
      # 本机端口和 susu 主线路不走代理（NO_PROXY）
      $proxyLines = ''
      if ($w -eq 'mind') {
        $envFile = Join-Path $Root '.env'
        $px = if (Test-Path $envFile) { (Select-String -Path $envFile -Pattern '^LLM_PROXY=(.+)$' | Select-Object -First 1).Matches.Groups[1].Value } else { $null }
        if ($px) { $proxyLines = "set NODE_USE_ENV_PROXY=1`r`nset HTTPS_PROXY=$($px.Trim())`r`nset NO_PROXY=127.0.0.1,localhost,susu.wiki`r`n" }
      }
      Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`nchcp 65001 >nul`r`n$($proxyLines)cd /d `"$Root`"`r`n`"$Node`" $js >> `"$log`" 2>&1`r`n"
      # 当前账户的完整名（机器名\用户）。别用 USERDOMAIN：SSH 会话里它是 WORKGROUP，拼出来的账户不存在
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
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
      # 启动前轮替（见上面 Rotate-Log 的注释：运行中不能动日志文件）
      Rotate-Log (Join-Path $Logs "$w.log")
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
    # 第 2 步重构后代码在 src/ 下；这里只是**诊断名单**（完整全套跑 npm test / scripts\test-all.js）。
    # 启动的仍是根目录 bridge-server.js / mind.js（上面 install / start 里，不动）。
    foreach ($f in 'src\knowledge\knowledge.js', 'src\mind\ambition.js', 'src\mind\memory-store.js', 'src\mind\speech.js', 'src\world\pathing.js', 'src\world\place.js', 'src\body\hands.js', 'src\mind\mind.js', 'src\world\palette-registry.js', 'src\world\block-palette.js', 'src\world\item-registry.js', 'src\body\equip-policy.js', 'src\mind\llm-workbuddy.js') {
      $out = (& $Node $f --selftest 2>&1 | Out-String)
      $sum = [regex]::Matches($out, '\d+ */ *\d+ *通过|\d+ passed, \d+ failed') | Select-Object -Last 1
      $fails = ([regex]::Matches($out, '(?m)^\s*FAIL.*$') | ForEach-Object { $_.Value.Trim() }) -join ' | '
      "{0,-34} {1} {2}" -f $f, $sum, $fails
    }
    # 第 3 步把 src\bridge\server.js 拆成子文件后，这里只加不减：
    # 子文件都没有 --selftest（bridge 的规矩：一跑就连服务器），只做 --check。
    foreach ($f in 'src\bridge\server.js', 'src\bridge\config.js', 'src\bridge\state.js', 'src\bridge\util.js', 'src\bridge\goto.js', 'src\bridge\connect.js', 'src\bridge\http.js', 'src\bridge\routes\inspect.js', 'src\bridge\routes\scan.js', 'src\bridge\routes\pickup.js', 'src\bridge\routes\body.js', 'src\bridge\routes\place.js', 'src\bridge\routes\move.js', 'src\bridge\routes\mine.js', 'src\bridge\routes\gather.js', 'src\bridge\routes\palette.js', 'src\bridge\routes\diag.js', 'src\mind\body.js', 'src\mind\mind\state.js', 'src\mind\mind\prompt.js', 'src\mind\mind\runtime.js', 'src\mind\mind\scene.js', 'src\mind\mind\look.js', 'src\mind\mind\gates.js', 'src\mind\mind\tools.js', 'src\mind\mind\actions.js', 'src\mind\mind\think.js', 'src\mind\mind\selftest.js', 'src\mind\mind\wiring.js') { & $Node --check $f; "{0,-34} --check ok" -f $f }
  }
  'logs' {
    $w = if ($what -eq 'all') { 'mind' } else { $what }
    Get-Content (Join-Path $Logs "$w.log") -Tail $n -Encoding UTF8
  }
  default { "未知命令 $cmd（install / start / stop / status / selftest / logs）" }
}
