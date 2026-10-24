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
    [string]$Exe = 'D:\software\dsh\DeepSeek Harness.exe',
    [string]$Log = "$env:TEMP\dsh-restart.log"
)

function Write-Log([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Add-Content -Path $Log -Value $line -Encoding utf8
}

try {
    Write-Log "restart scheduled in ${WaitSeconds}s (debug port $DebugPort)"

    # 等这一轮 agent 回复写完，避免把正在进行的会话截断在半句上。
    Start-Sleep -Seconds $WaitSeconds

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
