#!/usr/bin/env python3
"""Install the Bili Downloader native-messaging host for Chrome/Chromium."""
import base64
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
from pathlib import Path

HOST_NAME = "com.opencode.bili_downloader"
ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "native_host" / "native_host.py"


def extension_id():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    key = manifest.get("key")
    if not key:
        raise SystemExit("extension/manifest.json 缺少 key，无法固定扩展 ID")
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def install_linux(host_dir, manifest):
    host_dir.mkdir(parents=True, exist_ok=True)
    target = host_dir / "native_host.py"
    shutil.copy2(SCRIPT, target)
    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    manifest["path"] = str(target)
    for config in ("google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"):
        base = Path.home() / ".config" / config
        if not base.exists():
            continue
        destination = base / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已安装 Chrome 主机清单: {destination}")


def find_python():
    for name in ("python", "python3", "py"):
        path = shutil.which(name)
        if path:
            return path
    raise SystemExit("未找到 Python，请先安装 Python 3.9+")


def install_windows(host_dir, manifest):
    host_dir.mkdir(parents=True, exist_ok=True)
    target = host_dir / "native_host.py"
    shutil.copy2(SCRIPT, target)
    python = find_python()
    launcher = host_dir / "launcher.exe"
    source = r'''
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public class Launcher {
  public static int Main(string[] args) {
    var psi = new ProcessStartInfo();
    psi.FileName = PYTHON;
    psi.Arguments = "\"" + SCRIPT + "\"";
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    var p = Process.Start(psi);
    var copyIn = new Thread(() => {
      try { Console.OpenStandardInput().CopyTo(p.StandardInput.BaseStream); p.StandardInput.Close(); } catch {}
    });
    copyIn.IsBackground = true; copyIn.Start();
    var errors = new Thread(() => { try { p.StandardError.ReadToEnd(); } catch {} });
    errors.IsBackground = true; errors.Start();
    try { p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); } catch {}
    p.WaitForExit();
    return p.ExitCode;
  }
}
'''.replace('PYTHON', json.dumps(python)).replace('SCRIPT', json.dumps(str(target)))
    source_file = host_dir / "launcher.cs"
    source_file.write_text(source, encoding="utf-8")
    launcher.unlink(missing_ok=True)
    compile_cmd = (
        f"Add-Type -TypeDefinition (Get-Content -Raw '{source_file}') "
        f"-OutputAssembly '{launcher}' -OutputType ConsoleApplication"
    )
    result = subprocess.run(["powershell", "-NoProfile", "-Command", compile_cmd], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit("生成 Windows 启动器失败:\n" + result.stderr)
    manifest["path"] = str(launcher)
    manifest_path = host_dir / f"{HOST_NAME}.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    import winreg
    key_path = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    print(f"已注册 Chrome 主机: HKCU\\{key_path}")


def main():
    ext_id = extension_id()
    system = platform.system()
    if system == "Linux":
        host_dir = Path.home() / ".local" / "share" / "bili-downloader"
    elif system == "Windows":
        host_dir = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "BiliDownloader"
    else:
        raise SystemExit("当前安装器支持 Linux 和 Windows；其他系统可参考 README 手工注册。")
    manifest = {
        "name": HOST_NAME,
        "description": "Bili Downloader native host",
        "path": "",
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }
    if system == "Windows":
        install_windows(host_dir, manifest)
    else:
        install_linux(host_dir, manifest)
    print(f"扩展 ID: {ext_id}")
    print("安装完成。请重新加载/启动 Chrome，然后在扩展管理页加载 extension 文件夹。")


if __name__ == "__main__":
    main()
