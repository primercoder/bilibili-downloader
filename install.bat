@echo off
rem Bili 下载器 - Windows 一键安装脚本
rem
rem 双击运行即可，不需要管理员权限，不需要安装 Python 或 FFmpeg。
rem
rem 它做三件事：
rem   1. 把本地助手 bili-host.exe 复制到 %LOCALAPPDATA%\BiliDownloader
rem   2. 生成 Chrome 需要的 native messaging 清单文件
rem   3. 在注册表里为 Chrome / Edge / Brave / Chromium / Vivaldi 注册该助手
setlocal EnableDelayedExpansion
title Bili 下载器 - 安装
chcp 65001 >nul 2>&1

set HOST_NAME=com.opencode.bili_downloader
rem 扩展 ID 由 manifest.json 里的 key 固定推导，是常量；这里先写好，
rem 下面的 PowerShell 只在需要时重新计算一次做校验。
set EXT_ID=khkbfeoekeinbdgbicojpgfidfihfffc
set EXT_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1utkFp6OccsDY+CMfFeuRuvNfBpcJxWEI1eavopPIif5vqMJV5eM/gC9RjSukEImbXKKURGdN/J3cKX2E8ljnf6DtoOQZyFifP4ZmeRHlUXC/HQ8fa5ZRZ9+SwtOv1DzauJRB0QAmA8VWF7f0FcW186e78bmfzE7htCM6wtIqu4dEQu5vENhEsksShu0P1zCwhCEJWun/MHAeJ3kW08pTVSjMoJJmlA1myShMpeQO6dsjQyVxMdZueWxU/IK/HeIhmn/C0iSgCnT14ECicrCGeCay7WIrNR4dmA59HnNrJTQ3T19k++kRMsvyxDj/vp2VxjAx2zq7SPBlpcmiktAKwIDAQAB

cd /d "%~dp0"

rem ---------- 1. 找到并复制本地助手 ----------
set HOST_SRC=%~dp0host\bili-host.exe
if not exist "%HOST_SRC%" set HOST_SRC=%~dp0dist\hosts\bili-host-windows-amd64.exe
if not exist "%HOST_SRC%" (
  echo [错误] 找不到 host\bili-host.exe
  echo        请先把下载的压缩包完整解压，再运行 install.bat。
  echo        不要在压缩软件里直接双击运行。
  echo.
  pause
  exit /b 1
)

if "%LOCALAPPDATA%"=="" set LOCALAPPDATA=%USERPROFILE%\AppData\Local
set HOST_DIR=%LOCALAPPDATA%\BiliDownloader
if not exist "%HOST_DIR%" mkdir "%HOST_DIR%" >nul 2>&1
copy /Y "%HOST_SRC%" "%HOST_DIR%\bili-host.exe" >nul
if errorlevel 1 (
  echo [错误] 无法写入 %HOST_DIR%
  echo        请确认磁盘空间充足，或检查杀毒软件是否拦截。
  pause
  exit /b 1
)
echo [1/3] 本地助手已就绪: %HOST_DIR%\bili-host.exe

rem ---------- 2. 生成 native messaging 清单 ----------
rem Chrome 从扩展的 key 推导 ID：取 SHA-256(key) 前 32 个十六进制位，
rem 每位 0-f 映射到字母 a-p。key 不变，所以 ID 是常量；
rem 这里仍用 PowerShell 复算一次，万一将来换了 key 也不用改脚本。
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$k='%EXT_KEY%'; $h=[Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($k)); $s=-join ($h | %% { $_.ToString('x2') }); -join ($s.Substring(0,32).ToCharArray() | %% { [char](97 + [Convert]::ToInt32([string]$_,16)) })" 2^>nul`) do (
  set "COMPUTED=%%I"
)
if defined COMPUTED (
  if not "!COMPUTED!"=="%EXT_ID%" (
    echo [提示] 检测到扩展 ID 变化，使用新值: !COMPUTED!
    set "EXT_ID=!COMPUTED!"
  )
)

set MANIFEST=%HOST_DIR%\%HOST_NAME%.json
> "%MANIFEST%" echo {
>> "%MANIFEST%" echo   "name": "%HOST_NAME%",
>> "%MANIFEST%" echo   "description": "Bili Downloader native host",
>> "%MANIFEST%" echo   "path": "%HOST_DIR:\=\\%\\bili-host.exe",
>> "%MANIFEST%" echo   "type": "stdio",
>> "%MANIFEST%" echo   "allowed_origins": ["chrome-extension://!EXT_ID!/"]
>> "%MANIFEST%" echo }
if not exist "%MANIFEST%" (
  echo [错误] 无法生成清单文件 %MANIFEST%
  pause
  exit /b 1
)
echo [2/3] 已生成清单: %MANIFEST%
echo       扩展 ID: !EXT_ID!

rem ---------- 3. 注册到各个浏览器 ----------
rem Chrome / Edge / Brave / Chromium / Vivaldi 都用同一套注册表结构，
rem 只是厂商标识不同，所以逐个写入即可。
call :register "Google\Chrome" "Chrome"
call :register "Microsoft\Edge" "Edge"
call :register "BraveSoftware\Brave-Browser" "Brave"
call :register "Chromium" "Chromium"
call :register "Vivaldi" "Vivaldi"
echo [3/3] 本地助手注册完成。
echo.

echo ============================================================
echo  安装完成！接下来只剩两步：
echo.
echo    1. 在 Chrome 地址栏打开  chrome://extensions/
echo       打开右上角「开发者模式」开关
echo    2. 点「加载已解压的扩展程序」，选择本目录下的 extension 文件夹
echo.
echo  然后打开任意 B 站视频页，点工具栏里的粉色 B 图标即可下载。
echo  视频默认保存到「下载」文件夹，不需要 FFmpeg，也不需要 Python。
echo.
echo  如果浏览器当前是开着的，请完全退出后重新打开一次，
echo  让新注册的本地助手生效。
echo ============================================================
echo.
pause
exit /b 0

:register
set "VENDOR=%~1"
set "LABEL=%~2"
reg add "HKCU\Software\%VENDOR%\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul 2>&1
if errorlevel 1 (
  echo       - %LABEL%: 跳过（未安装或注册表不可写）
) else (
  echo       - %LABEL%: 已注册
)
exit /b 0
