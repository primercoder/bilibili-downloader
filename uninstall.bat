@echo off
rem Bili 下载器 - Windows 卸载脚本（双击运行）
setlocal EnableDelayedExpansion
title Bili 下载器 - 卸载
chcp 65001 >nul 2>&1

set HOST_NAME=com.opencode.bili_downloader
if "%LOCALAPPDATA%"=="" set LOCALAPPDATA=%USERPROFILE%\AppData\Local
set HOST_DIR=%LOCALAPPDATA%\BiliDownloader

for %%V in (
  "Google\Chrome"
  "Microsoft\Edge"
  "BraveSoftware\Brave-Browser"
  "Chromium"
  "Vivaldi"
) do (
  reg delete "HKCU\Software\%%~V\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
)
echo 已移除注册表项。
if exist "%HOST_DIR%" rmdir /s /q "%HOST_DIR%" >nul 2>&1
echo 已删除本地助手目录: %HOST_DIR%

if exist "%TEMP%\bili-downloader" rmdir /s /q "%TEMP%\bili-downloader" >nul 2>&1
echo 已清理临时文件。
echo.
echo 别忘了在 chrome://extensions/ 里移除「Bili 下载器」扩展。
echo.
pause
exit /b 0
