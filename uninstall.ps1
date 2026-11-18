# Bili 下载器 - Windows 本地助手交互式卸载脚本
#
# 由 uninstall.bat 启动，一般不需要手动运行。
#
# 脚本会：
#   1. 检测本机有哪些 Chromium 系浏览器；
#   2. 标出哪些浏览器已注册、哪些目录里还有本地助手文件；
#   3. 让你多选要卸载的浏览器；
#   4. 确认后删除注册表项、清单和助手文件；
#   5. 提醒你到浏览器里移除扩展。
#
# 不会删除你下载的视频，也不会触碰浏览器书签、密码或其它扩展。

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    $OutputEncoding = [Console]::OutputEncoding
} catch {
}

$HostName = 'com.opencode.bili_downloader'
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$HostDir = Join-Path $LocalAppData 'BiliDownloader'
$HostExe = Join-Path $HostDir 'bili-host.exe'
$ManifestPath = Join-Path $HostDir "$HostName.json"

function Pause-Exit {
    Write-Host ''
    try { Read-Host '按回车键退出' | Out-Null } catch { }
}

function Ask-YesNo {
    param(
        [string]$Prompt,
        [bool]$DefaultYes = $false
    )
    while ($true) {
        $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
        try {
            $answer = Read-Host "$Prompt $suffix"
        } catch {
            return $DefaultYes
        }
        if ([string]::IsNullOrWhiteSpace($answer)) { return $DefaultYes }
        $answer = $answer.Trim()
        if ($answer -match '^(y|yes|是)$') { return $true }
        if ($answer -match '^(n|no|否)$') { return $false }
        Write-Host '请输入 y 或 n。'
    }
}

function Read-Selection {
    param([int]$Count)
    while ($true) {
        try {
            $raw = Read-Host "请输入要卸载的浏览器编号（可多选，如 1 3 或 1,3）；all=全部，q=退出"
        } catch {
            return @()
        }
        if ($null -eq $raw) { return @() }
        $raw = $raw.Trim()
        if ($raw -match '^(q|quit|退出)$') { return @() }
        if ($raw -match '^(all|a|全部)$') { return @(1..$Count) }

        $tokens = @($raw -split '[,，、\s]+' | Where-Object { $_ -ne '' })
        $nums = @()
        $valid = $true
        foreach ($token in $tokens) {
            if ($token -notmatch '^\d+$') {
                Write-Host "「$token」不是有效编号。"
                $valid = $false
                break
            }
            $n = [int]$token
            if ($n -lt 1 -or $n -gt $Count) {
                Write-Host "编号 $token 不存在，请输入 1 到 $Count。"
                $valid = $false
                break
            }
            if ($nums -notcontains $n) { $nums += $n }
        }
        if ($valid -and $nums.Count -gt 0) { return $nums }
    }
}

$Browsers = @(
    [pscustomobject]@{ Id = 'chrome'; Label = 'Google Chrome'; Vendor = 'Google\Chrome'; ExtUrl = 'chrome://extensions/'; ExePaths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"); UninstallPattern = '^Google Chrome$' },
    [pscustomobject]@{ Id = 'chrome-beta'; Label = 'Google Chrome Beta'; Vendor = 'Google\Chrome Beta'; ExtUrl = 'chrome://extensions/'; ExePaths = @("$env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome Beta\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome Beta\Application\chrome.exe"); UninstallPattern = '^Google Chrome Beta$' },
    [pscustomobject]@{ Id = 'chrome-dev'; Label = 'Google Chrome Dev'; Vendor = 'Google\Chrome Dev'; ExtUrl = 'chrome://extensions/'; ExePaths = @("$env:ProgramFiles\Google\Chrome Dev\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome Dev\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome Dev\Application\chrome.exe"); UninstallPattern = '^Google Chrome Dev$' },
    [pscustomobject]@{ Id = 'chromium'; Label = 'Chromium'; Vendor = 'Chromium'; ExtUrl = 'chrome://extensions/'; ExePaths = @("$env:LOCALAPPDATA\Chromium\Application\chrome.exe", "$env:ProgramFiles\Chromium\Application\chrome.exe"); UninstallPattern = '^Chromium$' },
    [pscustomobject]@{ Id = 'brave'; Label = 'Brave'; Vendor = 'BraveSoftware\Brave-Browser'; ExtUrl = 'brave://extensions/'; ExePaths = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"); UninstallPattern = '^Brave($| Browser)' },
    [pscustomobject]@{ Id = 'edge'; Label = 'Microsoft Edge'; Vendor = 'Microsoft\Edge'; ExtUrl = 'edge://extensions/'; ExePaths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"); UninstallPattern = '^Microsoft Edge$' },
    [pscustomobject]@{ Id = 'vivaldi'; Label = 'Vivaldi'; Vendor = 'Vivaldi'; ExtUrl = 'vivaldi://extensions/'; ExePaths = @("$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe", "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe"); UninstallPattern = '^Vivaldi' },
    [pscustomobject]@{ Id = 'opera'; Label = 'Opera'; Vendor = 'Opera Software'; ExtUrl = 'opera://extensions/'; ExePaths = @("$env:LOCALAPPDATA\Programs\Opera\opera.exe", "$env:ProgramFiles\Opera\opera.exe", "${env:ProgramFiles(x86)}\Opera\opera.exe"); UninstallPattern = '^Opera' },
    [pscustomobject]@{ Id = 'yandex'; Label = 'Yandex Browser'; Vendor = 'Yandex\YandexBrowser'; ExtUrl = 'browser://extensions/'; ExePaths = @("$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe", "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe"); UninstallPattern = '^Yandex' }
)

$UninstallNames = @()
$UninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($root in $UninstallRoots) {
    try {
        $entries = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
        foreach ($entry in $entries) {
            if ($entry.DisplayName) { $UninstallNames += [string]$entry.DisplayName }
        }
    } catch {
    }
}
$UninstallNames = @($UninstallNames | Select-Object -Unique)

function Test-BrowserInstalled {
    param($Browser)
    foreach ($path in $Browser.ExePaths) {
        if ($path -and (Test-Path -LiteralPath $path)) { return $true }
    }
    foreach ($root in @("HKCU:\Software\$($Browser.Vendor)", "HKLM:\SOFTWARE\$($Browser.Vendor)", "HKLM:\SOFTWARE\WOW6432Node\$($Browser.Vendor)")) {
        if (Test-Path -LiteralPath $root) { return $true }
    }
    foreach ($name in $UninstallNames) {
        if ($name -match $Browser.UninstallPattern) { return $true }
    }
    return $false
}

function Get-RegistryKey {
    param($Browser)
    return "HKCU:\Software\$($Browser.Vendor)\NativeMessagingHosts\$HostName"
}

# 只列出“已注册”或“还有残留文件”的项。普通浏览器共用一份助手，
# 没有注册表项的浏览器不该因为共用目录里有文件就被当成已安装。
$Active = @()
$Unregistered = @()
foreach ($browser in $Browsers) {
    $regKey = Get-RegistryKey $browser
    $hasReg = Test-Path -LiteralPath $regKey
    $hasManifest = Test-Path -LiteralPath $ManifestPath
    $hasBinary = Test-Path -LiteralPath $HostExe
    if (-not $hasReg) {
        if (Test-BrowserInstalled $browser) { $Unregistered += $browser.Label }
        continue
    }

    $parts = @('已注册')
    if ($hasManifest) { $parts += '有清单' }
    if ($hasBinary) { $parts += '有助手' }
    if (-not (Test-BrowserInstalled $browser)) { $parts += '浏览器缺失' }
    $browser | Add-Member -NotePropertyName Status -NotePropertyValue ($parts -join ' + ') -Force
    $Active += $browser
}

if ($Active.Count -eq 0 -and ((Test-Path -LiteralPath $HostExe) -or (Test-Path -LiteralPath $ManifestPath))) {
    $orphanEntry = [pscustomobject]@{
        Id = 'residual'
        Label = '本地助手文件（未注册）'
        Vendor = ''
        ExtUrl = ''
        Status = '残留，未注册'
    }
    $Active += $orphanEntry
}

Write-Host 'Bili 下载器 - 卸载本地助手' -ForegroundColor Magenta
if ($Active.Count -eq 0) {
    if ($Unregistered.Count -gt 0) {
        Write-Host "未注册的浏览器：$($Unregistered -join '、')" -ForegroundColor DarkGray
    }
    Write-Host '没有可卸载的本地助手。'
    Pause-Exit
    exit 0
}

Write-Host "检测到 $($Active.Count) 项："
for ($n = 0; $n -lt $Active.Count; $n++) {
    Write-Host ("  {0,2}) {1} [{2}]" -f ($n + 1), $Active[$n].Label, $Active[$n].Status)
}
Write-Host '将删除所选注册表项和清单；助手目录在无其它浏览器使用时删除。'

# ---------------------------------------------------------------------------
# 多选与确认
# ---------------------------------------------------------------------------

$picked = @(Read-Selection -Count $Active.Count)
if ($picked.Count -eq 0) {
    Write-Host '已取消。'
    Pause-Exit
    exit 0
}

$Selected = @()
foreach ($n in $picked) { $Selected += $Active[$n - 1] }

Write-Host ''
$SelectedLabels = @($Selected | ForEach-Object { $_.Label })
Write-Host "即将卸载：$($SelectedLabels -join '、')"
Write-Host '不会删除已下载视频、书签或其它扩展。'
if (-not (Ask-YesNo -Prompt '确认卸载？' -DefaultYes $false)) {
    Write-Host '已取消，没有删除任何文件。'
    Pause-Exit
    exit 0
}

# ---------------------------------------------------------------------------
# 执行删除
# ---------------------------------------------------------------------------

$RemovedKeys = 0
foreach ($browser in $Selected) {
    if (-not $browser.Vendor) { continue }
    $regKey = Get-RegistryKey $browser
    if (Test-Path -LiteralPath $regKey) {
        try {
            & reg.exe delete "HKCU\Software\$($browser.Vendor)\NativeMessagingHosts\$HostName" /f | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "reg.exe 返回 $LASTEXITCODE" }
            $RemovedKeys++
        } catch {
            Write-Host "错误：无法删除注册表项 $regKey" -ForegroundColor Red
            Write-Host "      $($_.Exception.Message)"
        }
    }
}

# 检查是否还有任意一个浏览器注册着。清单和助手是共用的，只有全部卸载完才删除。
$Remaining = @()
foreach ($browser in $Browsers) {
    if (Test-Path -LiteralPath (Get-RegistryKey $browser)) { $Remaining += $browser.Label }
}

$RemovedManifest = $false
$RemovedHost = $false
if ($Remaining.Count -eq 0) {
    if (Test-Path -LiteralPath $ManifestPath) {
        try {
            Remove-Item -LiteralPath $ManifestPath -Force
            $RemovedManifest = $true
        } catch {
            Write-Host "错误：无法删除清单 $ManifestPath" -ForegroundColor Red
        }
    }
    if (Test-Path -LiteralPath $HostDir) {
        try {
            Remove-Item -LiteralPath $HostDir -Recurse -Force
            $RemovedHost = $true
        } catch {
            Write-Host "错误：无法删除助手目录 $HostDir" -ForegroundColor Red
            Write-Host "      请确认没有浏览器正在使用它，然后再试一次。"
        }
    }
    if (-not (Test-Path -LiteralPath $HostDir)) {
        $tempDir = Join-Path $env:TEMP 'bili-downloader'
        $tempLog = Join-Path $env:TEMP 'bili-downloader-host.log'
        $cacheDir = Join-Path $LocalAppData 'bili-downloader'
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempLog -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "仍在使用：$($Remaining -join '、')，清单和助手文件已保留。"
}

$RemovedParts = @()
if ($RemovedKeys -gt 0) { $RemovedParts += "$RemovedKeys 个注册表项" }
if ($RemovedManifest) { $RemovedParts += '清单' }
if ($RemovedHost) { $RemovedParts += '助手目录' }
if ($RemovedParts.Count -gt 0) {
    Write-Host "OK 已删除 $($RemovedParts -join '、')。" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 浏览器里移除扩展
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '卸载完成。' -ForegroundColor Green

$BrowserReminder = 0
foreach ($browser in $Selected) {
    if (-not $browser.ExtUrl) { continue }
    if ($BrowserReminder -eq 0) {
        Write-Host '最后到扩展页移除「Bili 下载器」：'
        $BrowserReminder = 1
    }
    Write-Host "  • $($browser.Label)：$($browser.ExtUrl)"
}
if ($BrowserReminder -eq 0) {
    Write-Host '本次只清理了残留助手文件。'
}
Write-Host '若浏览器正开着，完全退出再打开。'

Pause-Exit
exit 0
