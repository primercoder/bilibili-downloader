#!/usr/bin/env python3
"""Remove the Bili Downloader native-messaging registration."""
import json
import platform
import shutil
from pathlib import Path

HOST_NAME = "com.opencode.bili_downloader"

if platform.system() == "Windows":
    import winreg
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}")
    except FileNotFoundError:
        pass
    shutil.rmtree(Path.home() / "AppData" / "Local" / "BiliDownloader", ignore_errors=True)
    print("已卸载 Windows 本地助手。")
else:
    for config in ("google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"):
        (Path.home() / ".config" / config / "NativeMessagingHosts" / f"{HOST_NAME}.json").unlink(missing_ok=True)
    shutil.rmtree(Path.home() / ".local" / "share" / "bili-downloader", ignore_errors=True)
    print("已卸载 Linux 本地助手。")
