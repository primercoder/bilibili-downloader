# Bili 下载器 - Windows 本地助手卸载脚本
$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    $OutputEncoding = [Console]::OutputEncoding
} catch {
}

$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$HostDir = Join-Path $LocalAppData 'BiliDownloader'
$HostExe = Join-Path $HostDir 'bili-host.exe'
$Launcher = Join-Path $HostDir 'start-helper.vbs'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'BiliDownloader'

function Pause-Exit {
    Write-Host ''
    try { Read-Host '按回车键退出' | Out-Null } catch { }
}

Write-Host ''
Write-Host 'Bili 下载器 - 卸载本地助手' -ForegroundColor Magenta
Write-Host ''

try {
    Get-CimInstance Win32_Process -Filter "Name='bili-host.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $HostExe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {
}

try {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Host 'OK 已移除开机启动项' -ForegroundColor Green
} catch {
    Write-Host "提示：移除开机启动项失败：$($_.Exception.Message)" -ForegroundColor Yellow
}

# 清理 2.0.x 使用的 Native Messaging 注册，方便从旧版本升级。
$OldVendors = @(
    'Google\Chrome', 'Google\Chrome Beta', 'Google\Chrome Dev', 'Chromium',
    'BraveSoftware\Brave-Browser', 'Microsoft\Edge', 'Vivaldi',
    'Opera Software', 'Yandex\YandexBrowser'
)
foreach ($vendor in $OldVendors) {
    $oldKey = "HKCU:\Software\$vendor\NativeMessagingHosts\com.opencode.bili_downloader"
    if (Test-Path -LiteralPath $oldKey) {
        Remove-Item -LiteralPath $oldKey -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path -LiteralPath $HostDir) {
    try {
        Remove-Item -LiteralPath $HostDir -Recurse -Force
        Write-Host "OK 已删除助手目录：$HostDir" -ForegroundColor Green
    } catch {
        Write-Host "错误：无法删除 $HostDir（可能仍被占用）" -ForegroundColor Red
        Write-Host "      请关闭浏览器或结束 bili-host.exe 后重试。"
    }
} else {
    Write-Host '助手目录不存在，跳过。'
}

$tempDir = Join-Path $env:TEMP 'bili-downloader'
$tempLog = Join-Path $env:TEMP 'bili-downloader-host.log'
$cacheDir = Join-Path $LocalAppData 'bili-downloader'
Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tempLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'OK 已清理临时文件与状态缓存' -ForegroundColor Green

Write-Host ''
Write-Host '最后到浏览器扩展页移除「Bili 下载器」：'
Write-Host '  chrome://extensions/（或 edge://extensions/ 等）'
Write-Host ''

Pause-Exit
exit 0
