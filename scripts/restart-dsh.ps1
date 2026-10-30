# 重启 DSH 桌面端（可带 CDP 端口），让新装的 dsh-zcode-startplan 被加载。
#
# ── 为什么是这个写法（对照 DSH 官方重启实现） ─────────────────────────────
#
# DSH 自己的「重启」是 Electron 的 `app.relaunch(); app.quit();`
# （见 app.asar：`restart: () => { app.relaunch(); quitWithoutConfirmation(); }`
#  与菜单项 `app.relaunch(); quitWithoutConfirmation();`）。
# 关键点：`app.relaunch()` 会**原样重放当前进程的 argv**，而 `app.quit()` 是
# **优雅退出**（走 before-quit，Flush 会话）。我们没法在插件里调 app.relaunch
# （宿主未把该能力暴露给插件），只能在进程外用等效语义实现：
#
#   1. 找**真正的 Electron 主进程**（见 Resolve-MainProcess 的排除规则）
#   2. 用 CloseMainWindow + 温和终止让它**优雅退出**（不是 -Force 秒杀）
#   3. **等它真的消失**（活着就还有单实例锁）
#   4. 用 **原 argv + 追加 --remote-debugging-port** 重新拉起
#
# ── 旧版本为什么必然失败（三个真实缺陷） ───────────────────────────────────
#
# ① 主进程判定过宽：`CommandLine -notmatch '--type='` 会把
#    `DeepSeek Harness.exe --expose-internals … dsh-desktop-host\lib\index.js`
#    这个 **host 子进程**当成主进程一起杀掉 → 杀掉后主进程仍在，单实例锁没释放；
# ② 新实例被单实例锁吞掉：宿主用 `requestSingleInstanceLock()`，第二个实例
#    只会触发 `second-instance`（聚焦已有窗口）后自己 `quit()`，
#    **命令行参数完全不生效** → `--remote-debugging-port` 永远带不上；
# ③ 没等端口真正释放就拉起，连 `-Force` 秒杀都可能让锁残留。
#
# 用法（由插件以 Start-Process 分离启动）：
#   powershell -NoProfile -File restart-dsh.ps1 -WaitSeconds 3 -DebugPort 9229

param(
    [int]$WaitSeconds = 3,
    [int]$DebugPort = 9229,
    # 留空 = 自动定位宿主可执行文件（见 Resolve-ExePath）。
    [string]$Exe = '',
    # 优雅退出的等待上限（秒）；超时才降级为强制终止。
    [int]$GracefulTimeoutSec = 12,
    [string]$Log = "$env:TEMP\dsh-restart.log"
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}

<#
    自动定位宿主 exe。
    ⚠ 不能用「当前进程 = powershell 的父进程」推：本脚本是**分离启动**的，
      父进程链已经断了。第一个命中即用。
#>
function Resolve-ExePath([string]$Explicit) {
    if ($Explicit -and (Test-Path $Explicit)) { return (Resolve-Path $Explicit).Path }

    $main = Get-MainProcess
    if ($main -and $main.ExecutablePath -and (Test-Path $main.ExecutablePath)) {
        return $main.ExecutablePath
    }

    foreach ($candidate in @(
        'D:\software\dsh\DeepSeek Harness.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
        (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\DeepSeek Harness.exe')
    )) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return ''
}

<#
    找**真正的 Electron 主进程**。

    判据（全部必须满足）：
      · 命令行不含 `--type=`（排除 renderer/gpu/utility 等 Chromium 子进程）
      · 命令行不含 `dsh-desktop-host`（排除 host 进程：它是 `--expose-internals … index.js`）
      · 命令行不含 `runner.js`（排除 subprocess-local 的 runner）
      · 命令行不含 `--expose-internals`（同上，host 进程特征）
      · 有可见主窗口 或 没有父进程指向另一个同名 exe（主进程通常是会话的根）

    ⚠ 这条规则来自实测进程树：主进程 = 唯一没有 --type= 且不是
      host/runner 的那个；含糊时**优先取 ParentProcessId 最小的那个**。
#>
function Test-IsMainProcess($proc) {
    $cmd = [string]$proc.CommandLine
    if ($cmd -match '--type=') { return $false }
    if ($cmd -match 'dsh-desktop-host') { return $false }
    if ($cmd -match 'runner\.js') { return $false }
    if ($cmd -match '--expose-internals') { return $false }
    return $true
}

function Get-MainProcess {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return $null }
    $candidates = @($all | Where-Object { Test-IsMainProcess $_ })
    if ($candidates.Count -eq 0) { return $null }
    # 多个候选时取「不是任何候选的子进程」的那个（真正的根）。
    $ids = @($candidates | ForEach-Object { $_.ProcessId })
    $roots = @($candidates | Where-Object { $ids -notcontains $_.ParentProcessId })
    $pool = if ($roots.Count -gt 0) { $roots } else { $candidates }
    return ($pool | Sort-Object ProcessId | Select-Object -First 1)
}

<#
    让它优雅退出并**确认消失**。

    ⚠ 顺序很重要：
      ① CloseMainWindow()（发 WM_CLOSE，等同用户点 X，走 before-quit）
      ② 轮询等待；超时才 Stop-Process（先不带 -Force 不行，Windows 无此语义，
         直接用 -Force，但**必须继续等它真的消失**）
      ③ 返回是否确认退出 —— 没退出就别拉起新实例（拉起也是被单实例锁吞掉）。
#>
function Stop-MainProcessGracefully($proc, [int]$TimeoutSec) {
    $pid = $proc.ProcessId
    Write-Log "stopping main pid $pid (graceful)"

    $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($p) {
        try { $null = $p.CloseMainWindow() } catch { Write-Log "CloseMainWindow failed: $($_.Exception.Message)" }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
            Write-Log "pid $pid exited gracefully"
            return $true
        }
        Start-Sleep -Milliseconds 300
    }

    Write-Log "graceful exit timed out after ${TimeoutSec}s, forcing pid $pid"
    try { Stop-Process -Id $pid -Force -ErrorAction Stop } catch { Write-Log "force stop failed: $($_.Exception.Message)" }

    # ⚠ 强制杀之后也必须**等它从进程表消失**，否则单实例锁可能仍未释放。
    $hardDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $hardDeadline) {
        if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
            Write-Log "pid $pid exited after force"
            return $true
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Log "pid $pid STILL alive —— 放弃拉起新实例（拉起也会被单实例锁吞掉）"
    return $false
}

<#
    等端口真正空出来（旧实例彻底释放）。
#>
function Wait-PortFree([int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $busy) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

<#
    拉起新实例：**原 argv + 追加 CDP 端口**（等效 app.relaunch 的重放语义）。

    ⚠ 只取主进程的 argv。Chromium 子进程的 argv 里有 `--user-data-dir` 等内部参数，
      照抄会造出一个畸形的实例。
#>
function Start-Host($Exe, $OriginalCommandLine, [int]$Port) {
    $args = @("--remote-debugging-port=$Port")
    if ($OriginalCommandLine) {
        # 去掉可执行文件本身（首段带引号），其余原样保留。
        $rest = $OriginalCommandLine -replace '^\s*"[^"]*"\s*', ''
        if ($rest.Trim().Length -gt 0) {
            # 已有同名参数就不重复加。
            if ($rest -notmatch '--remote-debugging-port') {
                $args = @("--remote-debugging-port=$Port") + @($rest.Trim())
            } else {
                $args = @($rest.Trim())
            }
        }
    }
    Write-Log "starting: `"$Exe`" $($args -join ' ')"
    Start-Process -FilePath $Exe -ArgumentList $args -WorkingDirectory (Split-Path $Exe)
}

<#
    验证 CDP 是否真的可达。
#>
function Test-Cdp([int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

try {
    Write-Log "===== restart requested (debug port $DebugPort, wait ${WaitSeconds}s) ====="

    # 等调用方的 HTTP 响应 / agent 回复写完，避免把正在进行的会话截断在半句上。
    if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

    $main = Get-MainProcess
    if (-not $main) {
        Write-Log 'no main process found (already closed)'
        $Exe = Resolve-ExePath $Exe
        if (-not $Exe) { Write-Log 'fatal: 找不到 DeepSeek Harness.exe（请用 -Exe 显式指定）'; exit 1 }
        Start-Host $Exe '' $DebugPort
        if (Test-Cdp $DebugPort 40) { Write-Log 'cdp ready (fresh launch)'; exit 0 }
        Write-Log 'cdp NOT ready after fresh launch'; exit 1
    }

    # ⚠ 必须在**杀进程之前**解析 exe 与 argv：进程一没就查不到了。
    $Exe = if ($Exe -and (Test-Path $Exe)) { (Resolve-Path $Exe).Path } else { $main.ExecutablePath }
    if (-not $Exe) { Write-Log 'fatal: 无法解析宿主 exe 路径'; exit 1 }
    $originalCmd = [string]$main.CommandLine
    Write-Log "main pid=$($main.ProcessId) exe=$Exe"
    Write-Log "original argv: $originalCmd"

    if (-not (Stop-MainProcessGracefully $main $GracefulTimeoutSec)) { exit 1 }

    # 残留的子进程（host/runner/renderer）可能还占着端口，一并清掉。
    Start-Sleep -Milliseconds 500
    $leftover = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
    if ($leftover.Count -gt 0) {
        Write-Log "cleaning up $($leftover.Count) leftover child process(es)"
        foreach ($proc in $leftover) {
            try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { }
        }
        Start-Sleep -Milliseconds 800
    }

    if (-not (Wait-PortFree $DebugPort 15)) {
        Write-Log "port $DebugPort still in use after stop; aborting to avoid a silent no-op relaunch"
        exit 1
    }

    Start-Host $Exe $originalCmd $DebugPort

    $ready = Test-Cdp $DebugPort 45
    Write-Log "cdp ready=$ready"
    if ($ready) { Write-Log 'done'; exit 0 }

    # 兜底：带 CDP 起不来就别让用户卡在「应用没了」的状态。
    Write-Log 'CDP not reachable; relaunching WITHOUT the flag so the app stays usable'
    $still = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue | Where-Object { Test-IsMainProcess $_ })
    foreach ($proc in $still) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Seconds 3
    Start-Host $Exe $originalCmd 0
    Write-Log 'relaunched without debug port'
    exit 2
}
catch {
    Write-Log "fatal: $($_.Exception.Message)"
    exit 1
}
