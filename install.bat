@echo off
rem Bili 下载器 - Windows 交互式安装入口
rem
rem 双击运行即可。真正的交互流程在 install.ps1 里：
rem 检测浏览器 -> 多选 -> 检查旧文件 -> 二次确认 -> 安装 -> 浏览器操作说明。
rem 不需要管理员权限，也不需要任何命令行参数。
setlocal
title Bili 下载器 - 安装
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到 Windows PowerShell。
  echo        请确认系统是 Windows 10 / 11，或手动运行 install.ps1。
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0install.ps1" (
  echo [错误] 找不到 install.ps1。
  echo        请先把下载的压缩包完整解压，再运行 install.bat。
  echo        不要在压缩软件窗口里直接双击运行。
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo 安装未完成，退出代码 %RC%。
  pause
)
exit /b %RC%
