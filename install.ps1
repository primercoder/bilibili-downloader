# Bili 下载器 - Windows 本地助手安装脚本
#
# 助手是独立的本地 HTTP 服务，不再注册 Chrome Native Messaging。
# 安装脚本复制助手，并在当前用户登录时隐藏启动它。
$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    $OutputEncoding = [Console]::OutputEncoding
} catch {
}

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ExtDir = Join-Path $ScriptDir 'extension'
$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$HostDir = Join-Path $LocalAppData 'BiliDownloader'
$HostExe = Join-Path $HostDir 'bili-host.exe'
$Launcher = Join-Path $HostDir 'start-helper.vbs'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'BiliDownloader'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $WScript)) { $WScript = 'wscript.exe' }

function Pause-Exit {
    Write-Host ''
    try { Read-Host '按回车键退出' | Out-Null } catch { }
}

$Source = Join-Path $ScriptDir 'host\bili-host.exe'
if (-not (Test-Path -LiteralPath $Source)) {
    $Source = Join-Path $ScriptDir 'dist\hosts\bili-host-windows-amd64.exe'
}
if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host '错误：找不到 bili-host.exe。请先把压缩包完整解压，再运行 install.bat。' -ForegroundColor Red
    Pause-Exit
    exit 1
}

Write-Host ''
Write-Host 'Bili 下载器 - 安装本地助手' -ForegroundColor Magenta
Write-Host ''

# 升级时先停掉旧实例。
try {
    Get-CimInstance Win32_Process -Filter "Name='bili-host.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $HostExe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {
}

try {
    New-Item -ItemType Directory -Path $HostDir -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $HostExe -Force
    Write-Host "OK 本地助手：$HostExe" -ForegroundColor Green
} catch {
    Write-Host "错误：无法复制本地助手到 $HostExe" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)"
    Pause-Exit
    exit 1
}

try {
    $vbs = 'Set sh = CreateObject("WScript.Shell")' + "`r`n" +
        'sh.Run Chr(34) & "' + ($HostExe -replace '"', '""') + '" & Chr(34) & " serve", 0, False'
    $utf16 = New-Object -TypeName System.Text.UnicodeEncoding -ArgumentList $false, $true
    [System.IO.File]::WriteAllText($Launcher, $vbs, $utf16)

    New-Item -Path $RunKey -Force | Out-Null
    $runValue = '"' + $WScript + '" //B //Nologo "' + $Launcher + '"'
    New-ItemProperty -Path $RunKey -Name $RunName -Value $runValue -PropertyType String -Force | Out-Null
    Write-Host 'OK 已设置为当前用户登录时启动' -ForegroundColor Green
} catch {
    Write-Host '错误：无法创建开机启动项' -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)"
    Pause-Exit
    exit 1
}

try {
    Start-Process -FilePath $WScript -ArgumentList @('//B', '//Nologo', $Launcher) -WindowStyle Hidden
    Write-Host 'OK 本地助手已启动' -ForegroundColor Green
} catch {
    Write-Host '提示：启动助手失败，可手动双击 start-helper.vbs。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '安装完成。接下来在浏览器中加载扩展：'
Write-Host '  1. 打开 chrome://extensions/（Edge 为 edge://extensions/）'
Write-Host '  2. 打开右上角「开发者模式」'
Write-Host '  3. 点「加载已解压的扩展程序」'
Write-Host "  4. 选择：$ExtDir"
Write-Host ''
Write-Host '助手会在 127.0.0.1 的本地端口监听，不需要浏览器注册或额外配置。'
Write-Host '如果提示助手未运行，可双击：' -NoNewline
Write-Host " $Launcher" -ForegroundColor Yellow
Write-Host ''

Pause-Exit
exit 0
