# Bili 下载器 - Windows 本地助手交互式安装脚本
#
# 由 install.bat 启动，一般不需要手动运行。
#
# 脚本会：
#   1. 检测本机安装的 Chromium 系浏览器；
#   2. 列出每个浏览器安装后会被改动的文件与注册表项，供你多选；
#   3. 检查目标位置是否已有旧版本文件，并再次确认是否覆盖；
#   4. 复制本地助手、写入 native messaging 清单、注册到 HKCU；
#   5. 逐步说明浏览器里还要做哪些操作。
#
# 只写当前用户目录和 HKCU，不需要管理员权限。

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    $OutputEncoding = [Console]::OutputEncoding
} catch {
}

$HostName = 'com.opencode.bili_downloader'
$ExtKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1utkFp6OccsDY+CMfFeuRuvNfBpcJxWEI1eavopPIif5vqMJV5eM/gC9RjSukEImbXKKURGdN/J3cKX2E8ljnf6DtoOQZyFifP4ZmeRHlUXC/HQ8fa5ZRZ9+SwtOv1DzauJRB0QAmA8VWF7f0FcW186e78bmfzE7htCM6wtIqu4dEQu5vENhEsksShu0P1zCwhCEJWun/MHAeJ3kW08pTVSjMoJJmlA1myShMpeQO6dsjQyVxMdZueWxU/IK/HeIhmn/C0iSgCnT14ECicrCGeCay7WIrNR4dmA59HnNrJTQ3T19k++kRMsvyxDj/vp2VxjAx2zq7SPBlpcmiktAKwIDAQAB'
$ExtId = 'khkbfeoekeinbdgbicojpgfidfihfffc'
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

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
            $raw = Read-Host "请输入要安装的浏览器编号（可多选，如 1 3 或 1,3）；all=全部，q=退出"
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

function Get-ExtensionId {
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash([Convert]::FromBase64String($ExtKey))
        $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
        $builder = New-Object System.Text.StringBuilder
        for ($i = 0; $i -lt 32; $i++) {
            $value = [Convert]::ToInt32($hex.Substring($i, 1), 16)
            [void]$builder.Append([char](97 + $value))
        }
        $computed = $builder.ToString()
        if ($computed) { return $computed }
    } catch {
    }
    return $ExtId
}

$ExtId = Get-ExtensionId
$ExtDir = Join-Path $ScriptDir 'extension'

# 找到本地助手
$HostSource = Join-Path $ScriptDir 'host\bili-host.exe'
if (-not (Test-Path -LiteralPath $HostSource)) {
    $HostSource = Join-Path $ScriptDir 'dist\hosts\bili-host-windows-amd64.exe'
}
if (-not (Test-Path -LiteralPath $HostSource)) {
    Write-Host '错误：找不到本地助手 bili-host.exe。' -ForegroundColor Red
    Write-Host '      请先把下载的压缩包完整解压，再运行 install.bat。'
    Write-Host '      不要在压缩软件窗口里直接双击运行。'
    Pause-Exit
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $ExtDir 'manifest.json'))) {
    Write-Host '提示：当前目录下没有找到 extension\manifest.json。' -ForegroundColor Yellow
    Write-Host '      安装仍会继续，但加载扩展的步骤可能无法完成。'
}

$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$HostDir = Join-Path $LocalAppData 'BiliDownloader'
$HostExe = Join-Path $HostDir 'bili-host.exe'
$ManifestPath = Join-Path $HostDir "$HostName.json"

# ---------------------------------------------------------------------------
# 浏览器清单
# ---------------------------------------------------------------------------

$Browsers = @(
    [pscustomobject]@{
        Id = 'chrome'
        Label = 'Google Chrome'
        Vendor = 'Google\Chrome'
        ExtUrl = 'chrome://extensions/'
        ExePaths = @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )
        UninstallPattern = '^Google Chrome$'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'chrome-beta'
        Label = 'Google Chrome Beta'
        Vendor = 'Google\Chrome Beta'
        ExtUrl = 'chrome://extensions/'
        ExePaths = @(
            "$env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome Beta\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome Beta\Application\chrome.exe"
        )
        UninstallPattern = '^Google Chrome Beta$'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'chrome-dev'
        Label = 'Google Chrome Dev'
        Vendor = 'Google\Chrome Dev'
        ExtUrl = 'chrome://extensions/'
        ExePaths = @(
            "$env:ProgramFiles\Google\Chrome Dev\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome Dev\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome Dev\Application\chrome.exe"
        )
        UninstallPattern = '^Google Chrome Dev$'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'chromium'
        Label = 'Chromium'
        Vendor = 'Chromium'
        ExtUrl = 'chrome://extensions/'
        ExePaths = @(
            "$env:LOCALAPPDATA\Chromium\Application\chrome.exe",
            "$env:ProgramFiles\Chromium\Application\chrome.exe"
        )
        UninstallPattern = '^Chromium$'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'brave'
        Label = 'Brave'
        Vendor = 'BraveSoftware\Brave-Browser'
        ExtUrl = 'brave://extensions/'
        ExePaths = @(
            "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
            "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
            "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
        )
        UninstallPattern = '^Brave($| Browser)'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'edge'
        Label = 'Microsoft Edge'
        Vendor = 'Microsoft\Edge'
        ExtUrl = 'edge://extensions/'
        ExePaths = @(
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
        )
        UninstallPattern = '^Microsoft Edge$'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'vivaldi'
        Label = 'Vivaldi'
        Vendor = 'Vivaldi'
        ExtUrl = 'vivaldi://extensions/'
        ExePaths = @(
            "$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe",
            "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe"
        )
        UninstallPattern = '^Vivaldi'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'opera'
        Label = 'Opera'
        Vendor = 'Opera Software'
        ExtUrl = 'opera://extensions/'
        ExePaths = @(
            "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
            "$env:ProgramFiles\Opera\opera.exe",
            "${env:ProgramFiles(x86)}\Opera\opera.exe"
        )
        UninstallPattern = '^Opera'
        Status = ''
    },
    [pscustomobject]@{
        Id = 'yandex'
        Label = 'Yandex Browser'
        Vendor = 'Yandex\YandexBrowser'
        ExtUrl = 'browser://extensions/'
        ExePaths = @(
            "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
            "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe"
        )
        UninstallPattern = '^Yandex'
        Status = ''
    }
)

# 从“程序和功能”读取已安装程序名，作为命令/路径检测的补充。
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

$Active = @()
foreach ($browser in $Browsers) {
    if (Test-BrowserInstalled $browser) {
        $browser.Status = '已安装'
        $Active += $browser
    }
}

if ($Active.Count -eq 0) {
    Write-Host '没有检测到已安装的 Chromium 系浏览器。' -ForegroundColor Yellow
    Write-Host '你仍然可以预先注册 Chrome 或 Chromium；等浏览器安装并启动后即可生效。'
    foreach ($id in @('chrome', 'chromium')) {
        $browser = $Browsers | Where-Object { $_.Id -eq $id } | Select-Object -First 1
        if ($browser) {
            $browser.Status = '未检测到'
            $Active += $browser
        }
    }
}

# ---------------------------------------------------------------------------
# 展示列表与改动
# ---------------------------------------------------------------------------

Write-Host 'Bili 下载器 - 安装本地助手' -ForegroundColor Magenta
Write-Host "检测到 $($Active.Count) 个浏览器："
for ($n = 0; $n -lt $Active.Count; $n++) {
    Write-Host ("  {0,2}) {1} [{2}] · 清单 + 注册表" -f ($n + 1), $Active[$n].Label, $Active[$n].Status)
}
Write-Host ''
Write-Host "  助手：$HostExe"
Write-Host "  清单：$ManifestPath"
Write-Host "  注册表：HKCU\Software\<浏览器>\NativeMessagingHosts\$HostName"
Write-Host '  只写当前用户目录和 HKCU，不需要管理员权限。'

# ---------------------------------------------------------------------------
# 多选与第一次确认
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
Write-Host "即将安装：$($SelectedLabels -join '、')"
if (-not (Ask-YesNo -Prompt '确认安装？' -DefaultYes $true)) {
    Write-Host '已取消，没有做任何修改。'
    Pause-Exit
    exit 0
}

# ---------------------------------------------------------------------------
# 检查旧文件（第二次确认）
# ---------------------------------------------------------------------------

$ConflictPaths = @()
$ConflictIds = @()
foreach ($browser in $Selected) {
    $hasConflict = $false
    foreach ($path in @($HostExe, $ManifestPath)) {
        if (Test-Path -LiteralPath $path) {
            $hasConflict = $true
            if ($ConflictPaths -notcontains $path) { $ConflictPaths += $path }
        }
    }
    $regKey = "HKCU:\Software\$($browser.Vendor)\NativeMessagingHosts\$HostName"
    if (Test-Path -LiteralPath $regKey) {
        $hasConflict = $true
        if ($ConflictPaths -notcontains $regKey) { $ConflictPaths += $regKey }
    }
    if ($hasConflict) { $ConflictIds += $browser.Id }
}

if ($ConflictPaths.Count -gt 0) {
    Write-Host ''
    Write-Host '发现旧文件（可能是之前版本遗留）：' -ForegroundColor Yellow
    foreach ($path in $ConflictPaths) { Write-Host "  - $path" }
    Write-Host '  1) 覆盖并继续   2) 跳过有旧文件的浏览器   3) 取消（默认）'
    while ($true) {
        try {
            $choice = Read-Host '请选择 [1/2/3]'
        } catch {
            $choice = '3'
        }
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '3' }
        $choice = $choice.Trim()
        if ($choice -eq '1') {
            break
        } elseif ($choice -eq '2') {
            $kept = @()
            $skipped = @()
            foreach ($browser in $Selected) {
                if ($ConflictIds -notcontains $browser.Id) {
                    $kept += $browser
                } else {
                    $skipped += $browser.Label
                }
            }
            if ($kept.Count -eq 0) {
                Write-Host '所有选中的浏览器都有旧文件，已取消。'
                Pause-Exit
                exit 0
            }
            Write-Host "跳过：$($skipped -join '、')"
            $Selected = $kept
            break
        } elseif ($choice -eq '3' -or $choice -match '^(q|Q)$') {
            Write-Host '已取消，没有做任何修改。'
            Pause-Exit
            exit 0
        } else {
            Write-Host '请输入 1、2 或 3。'
        }
    }
}

# ---------------------------------------------------------------------------
# 安装
# ---------------------------------------------------------------------------

Write-Host ''
try {
    New-Item -ItemType Directory -Path $HostDir -Force | Out-Null
    Copy-Item -LiteralPath $HostSource -Destination $HostExe -Force
    Write-Host "OK 本地助手：$HostExe" -ForegroundColor Green
} catch {
    Write-Host "错误：无法复制本地助手到 $HostExe" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)"
    Pause-Exit
    exit 1
}

try {
    $manifest = [ordered]@{
        name = $HostName
        description = 'Bili Downloader native host'
        path = $HostExe
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtId/")
    } | ConvertTo-Json -Depth 4
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($ManifestPath, $manifest, $utf8)
} catch {
    Write-Host "错误：无法写入清单 $ManifestPath" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)"
    Pause-Exit
    exit 1
}

$Installed = @()
$InstalledLabels = @()
$Failed = 0
foreach ($browser in $Selected) {
    $regKey = "HKCU\Software\$($browser.Vendor)\NativeMessagingHosts\$HostName"
    try {
        & reg.exe add $regKey /ve /t REG_SZ /d $ManifestPath /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "reg.exe 返回 $LASTEXITCODE" }
        $Installed += $browser
        $InstalledLabels += $browser.Label
    } catch {
        Write-Host "错误：无法注册 $($browser.Label)" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)"
        $Failed++
    }
}

if ($Installed.Count -eq 0) {
    Write-Host ''
    Write-Host '没有安装成功任何浏览器。请检查上面的错误信息。' -ForegroundColor Red
    Pause-Exit
    exit 1
}
if ($InstalledLabels.Count -gt 0) {
    Write-Host "OK 已注册：$($InstalledLabels -join '、')" -ForegroundColor Green
}
if ($Failed -gt 0) {
    Write-Host "有 $Failed 个浏览器注册失败，详见上面的错误信息。" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 安装后的浏览器操作说明
# ---------------------------------------------------------------------------

$Downloads = Join-Path $env:USERPROFILE 'Downloads'
try {
    $shellFolders = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    $downloadValue = $shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($downloadValue) { $Downloads = [Environment]::ExpandEnvironmentVariables([string]$downloadValue) }
} catch {
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host '接下来在浏览器中操作（每个已安装的浏览器各做一次）：'
Write-Host '  1. 打开扩展管理页：'
foreach ($browser in $Installed) {
    Write-Host "     • $($browser.Label)：$($browser.ExtUrl)"
}
Write-Host '  2. 打开右上角「开发者模式」。'
Write-Host "  3. 点「加载已解压的扩展程序」，选择：$ExtDir"
Write-Host '  4. 完全退出浏览器再重新打开，让本地助手注册生效。'
Write-Host ''
Write-Host "扩展 ID：$ExtId · 默认下载：$Downloads"
Write-Host '工具栏没有 B 图标时，点右上角拼图图标固定即可。'
Write-Host '请保留 extension 目录；移动或删除后扩展会失效。' -ForegroundColor Yellow
Write-Host '仍提示助手未注册：到扩展页点「重新加载」，或重新运行本脚本。'

Pause-Exit
exit 0
