# 重启 DSH 桌面端（带 CDP 端口），让新装的 dsh-zcode-startplan 被加载。
#
# 为什么不直接在当前 shell 里 kill：本脚本由**独立的 powershell 进程**执行，
# 不随 DSH 的子进程树一起死；DSH 主进程退出后它仍在跑，负责拉起新实例。
#
# 用法（由 agent 以 Start-Process 分离启动）：
#   powershell -NoProfile -File restart-dsh.ps1 -WaitSeconds 25 -DebugPort 9229

param(
    [int]$WaitSeconds = 25,
    [int]$DebugPort = 9229,
    # 留空 = 自动定位宿主可执行文件（见下方 Resolve-ExePath）。
    [string]$Exe = '',
    [string]$Log = "$env:TEMP\dsh-restart.log"
)

function Write-Log([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Add-Content -Path $Log -Value $line -Encoding utf8
}

<#
    自动定位宿主 exe。

    ⚠ 不能用「当前进程 = powershell 的父进程」推：本脚本是**分离启动**的，
    父进程链已经断了。按下面的次序找，第一个命中即用：

    1. 显式 -Exe（调用方知道确切路径时最可靠）；
    2. 正在运行的 `DeepSeek Harness.exe` 主进程的 ExecutablePath
       （最准确：就是用户现在跑的那一份）；
    3. 常见安装位置。
#>
function Resolve-ExePath([string]$Explicit) {
    if ($Explicit -and (Test-Path $Explicit)) { return (Resolve-Path $Explicit).Path }

    $main = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1
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

try {
    Write-Log "restart scheduled in ${WaitSeconds}s (debug port $DebugPort)"

    # 等这一轮 agent 回复写完，避免把正在进行的会话截断在半句上。
    Start-Sleep -Seconds $WaitSeconds

    # ⚠ 必须在**杀进程之前**解析 exe：进程一没，ExecutablePath 就查不到了。
    $Exe = Resolve-ExePath $Exe
    if (-not $Exe) {
        Write-Log 'fatal: 找不到 DeepSeek Harness.exe（请用 -Exe 显式指定）'
        exit 1
    }
    Write-Log "using exe: $Exe"

    $main = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
        Where-Object { $_.CommandLine -notmatch '--type=' }

    if ($main) {
        foreach ($proc in $main) {
            Write-Log "stopping pid $($proc.ProcessId)"
            try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { Write-Log "stop failed: $($_.Exception.Message)" }
        }
        # 给 Electron 一点收尾时间（它自己会清理子进程）。
        Start-Sleep -Seconds 6
    } else {
        Write-Log 'no main process found (already closed)'
    }

    # 确认端口空出来。
    for ($i = 0; $i -lt 20; $i++) {
        $busy = Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue
        if (-not $busy) { break }
        Start-Sleep -Milliseconds 500
    }

    Write-Log "starting $Exe --remote-debugging-port=$DebugPort"
    Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$DebugPort" -WorkingDirectory (Split-Path $Exe)

    # 等 CDP 端口就绪，验证带上来了。
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    Write-Log "cdp ready=$ready"

    if (-not $ready) {
        Write-Log 'CDP not reachable; relaunching WITHOUT the flag so the app stays usable'
        $still = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
            Where-Object { $_.CommandLine -notmatch '--type=' }
        foreach ($proc in $still) { try { Stop-Process -Id $proc.ProcessId -Force } catch { } }
        Start-Sleep -Seconds 4
        Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe)
        Write-Log 'relaunched without debug port'
    }

    Write-Log 'done'
}
catch {
    Write-Log "fatal: $($_.Exception.Message)"
}
