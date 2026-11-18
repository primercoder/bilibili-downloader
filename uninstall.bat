@echo off
rem Bili 下载器 - Windows 交互式卸载入口
rem
rem 双击运行即可。真正的交互流程在 uninstall.ps1 里：
rem 检测浏览器 -> 多选 -> 确认 -> 删除注册表项和助手文件 -> 提示移除扩展。
setlocal
title Bili 下载器 - 卸载
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到 Windows PowerShell。
  echo        请确认系统是 Windows 10 / 11，或手动运行 uninstall.ps1。
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0uninstall.ps1" (
  echo [错误] 找不到 uninstall.ps1。
  echo        请先把下载的压缩包完整解压，再运行 uninstall.bat。
  echo        不要在压缩软件窗口里直接双击运行。
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo 卸载未完成，退出代码 %RC%。
  pause
)
exit /b %RC%
