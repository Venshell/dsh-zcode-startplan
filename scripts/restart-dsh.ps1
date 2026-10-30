# 准备「带调试端口的 DSH 启动方式」，供用户在需要 captcha 时**自己**重启用。
#
# ── 设计原则（0.6.6 重写：安全优先） ────────────────────────────────────────
#
# 旧版做的是「替用户自动重启」，它同时具备「结束进程、注册计划任务、绕过执行策略、
# 写临时脚本再执行、隐藏窗口」这组动作 —— 与恶意软件的持久化/提权手法高度重合，
# 被火绒类 AV 拦截是**正确行为**（用户实际遇到了报毒）。
#
# 新版**不再做任何高危动作**：
#   · 不结束任何进程
#   · 不注册任何计划任务、不写临时脚本、不提权
#   · 不隐藏任何窗口
#   · 只做两件事：① 输出现成的启动命令；② 可选地把启动命令写到**插件自己的
#     dataDir 下**（用户可读可删），方便用户复制。
#
# 用户看到提示后自行退出并重新打开 DSH —— 重启本来就是用户的决定，
# 而且宿主侧的 `app.relaunch()` 语义（原样重放 argv）也由用户手动等效完成。
#
# 用法：
#   powershell -NoProfile -File restart-dsh.ps1 -DebugPort 9229
#   powershell -NoProfile -File restart-dsh.ps1 -DebugPort 9229 -WriteCommandFile

param(
    # 想要的调试端口；0 或不传 = 只给普通重启指引。
    [int]$DebugPort = 9229,
    # 把启动命令写一份到 dataDir（用户可读、可删）。默认不写。
    [switch]$WriteCommandFile,
    # 写入位置（默认插件数据目录）。
    [string]$OutDir = (Join-Path $env:USERPROFILE '.dsh\zcode-start-plan')
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "[zcode-start-plan] $Message"
}

<#
    定位宿主可执行文件。

    ⚠ 只做**只读**查询：从正在运行的进程读 ExecutablePath，或查常见安装位置。
      不结束、不修改任何进程。
#>
function Resolve-HostExe {
    $main = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = [string]$_.CommandLine
            $cmd -notmatch '--type=' -and
            $cmd -notmatch 'dsh-desktop-host' -and
            $cmd -notmatch 'runner\.js' -and
            $cmd -notmatch '--expose-internals'
        } | Select-Object -First 1
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
    $exe = Resolve-HostExe
    if (-not $exe) {
        Write-Step '找不到 DeepSeek Harness.exe，无法生成启动命令。'
        Write-Step '请在开始菜单里右键 DSH 图标 →「打开文件位置」找到它后手动重启。'
        exit 1
    }

    $exeDir = Split-Path $exe
    if ($DebugPort -gt 0) {
        # ⚠ 前缀 & ：带引号路径直接跟参数会被 PowerShell 当成输出语句（用户实测踩坑）。
        $command = '& "' + $exe + '" --remote-debugging-port=' + $DebugPort
        $why = "要让 captcha 可用，需要以调试端口 $DebugPort 启动一次。"
    } else {
        $command = '& "' + $exe + '"'
        $why = '要重载插件（普通重启，不带调试端口）。'
    }

    Write-Step '────────────────────────────────────────────────────────'
    Write-Step $why
    Write-Step '请**手动**完成重启（插件不会替你结束进程）：'
    Write-Step '  1. 在当前窗口菜单里退出 DSH（或右键托盘图标退出）'
    Write-Step '  2. 在「运行」(Win+R) 或 PowerShell 里执行下面这行：'
    Write-Step ''
    Write-Host   "     $command" -ForegroundColor Cyan
    Write-Step ''
    Write-Step "  工作目录：$exeDir"
    if ($DebugPort -gt 0) {
        Write-Step "  起来后访问 http://127.0.0.1:$DebugPort/json/version 可确认端口已开。"
    }
    Write-Step '────────────────────────────────────────────────────────'

    if ($WriteCommandFile) {
        try {
            if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
            $file = Join-Path $OutDir 'restart-command.txt'
            $body = @(
                '# 由 dsh-zcode-startplan 生成：需要重启 DSH 时手动执行下面这行。',
                '# 本文件只含一条命令，不含任何脚本；可随时删除。',
                $command
            ) -join "`r`n"
            [System.IO.File]::WriteAllText($file, $body, (New-Object System.Text.UTF8Encoding($false)))
            Write-Step "启动命令已写入：$file"
        } catch {
            Write-Step "写入命令文件失败（不影响使用）：$($_.Exception.Message)"
        }
    }

    exit 0
}
catch {
    Write-Step "失败：$($_.Exception.Message)"
    exit 1
}
