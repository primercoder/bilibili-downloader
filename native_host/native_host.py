#!/usr/bin/env python3
"""Chrome native-messaging host for Bili Downloader. Standard library + FFmpeg."""
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

APP_NAME = "bili-downloader"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
LOG_PATH = Path(os.environ.get("OPENCODE_TMP", tempfile.gettempdir())) / "bili-downloader-host.log"
send_lock = threading.Lock()
active_lock = threading.Lock()
active_job = None


def log(message):
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    with send_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def default_download_dir():
    home = Path.home()
    if platform.system() == "Windows":
        # Known Folder defaults to %USERPROFILE%\Downloads. Respect the common
        # redirected-folder registry value when it exists.
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
            value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            winreg.CloseKey(key)
            return str(Path(os.path.expandvars(value)))
        except (OSError, ImportError):
            return str(home / "Downloads")
    config = home / ".config" / "user-dirs.dirs"
    try:
        for line in config.read_text(encoding="utf-8").splitlines():
            match = re.match(r'\s*XDG_DOWNLOAD_DIR="([^"]+)"', line)
            if match:
                return os.path.expandvars(match.group(1).replace("$HOME", str(home)))
    except OSError:
        pass
    return str(home / "Downloads")


def safe_name(value, limit=150):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value or "bilibili-video")
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value or value.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        value = "_" + value
    return value[:limit].rstrip(" .") or "bilibili-video"


def unique_path(path):
    if not path.exists():
        return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem} ({number}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("无法生成不重复的输出文件名")


def validate_stream(stream, kind):
    urls = stream.get("urls") or []
    if not urls:
        raise ValueError(f"{kind}没有下载地址")
    for url in urls:
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ValueError("下载地址必须使用 HTTPS")


def choose_directory():
    system = platform.system()
    initial = default_download_dir()
    if system == "Windows":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d=New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description='选择 Bili 下载器保存位置'; "
            "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){"
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath)}"
        )
        result = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        return result.stdout.strip()
    if system == "Linux" and shutil.which("zenity"):
        result = subprocess.run(["zenity", "--file-selection", "--directory", "--title=选择 Bili 下载器保存位置", f"--filename={initial}{os.sep}"], capture_output=True, text=True, timeout=120)
        return result.stdout.strip() if result.returncode == 0 else ""
    raise RuntimeError("未找到图形目录选择器；请直接在保存位置输入框中填写目录")


class DownloadJob:
    def __init__(self, data):
        self.data = data
        self.id = data.get("id") or uuid.uuid4().hex
        self.cancelled = threading.Event()
        self.process = None

    def progress(self, stage, percent, downloaded=None, total=None, detail=""):
        send({"type": "progress", "state": "progress", "jobId": self.id, "stage": stage,
              "percent": round(percent, 1), "downloaded": downloaded, "total": total,
              "speed": getattr(self, "speed", 0), "detail": detail})

    def check_cancel(self):
        if self.cancelled.is_set():
            raise InterruptedError("下载已取消")
        process = self.process
        if process and process.poll() is not None:
            self.process = None

    def download(self, stream, target, referer, start_percent, end_percent):
        target = Path(target)
        urls = stream["urls"]
        errors = []
        expected_size = 0
        last_size = -1
        stalled = 0
        attempt = 0
        max_failures = max(8, len(urls) * 4)
        while True:
            self.check_cancel()
            offset = target.stat().st_size if target.exists() else 0
            if expected_size and offset >= expected_size:
                return
            if offset == last_size:
                stalled += 1
            else:
                stalled = 0
            if stalled >= 4:
                raise RuntimeError("下载连续多次没有进展，已停止：" + "；".join(errors[-3:]))
            last_size = offset
            url = urls[attempt % len(urls)]
            headers = {"User-Agent": USER_AGENT, "Referer": referer, "Origin": "https://www.bilibili.com", "Accept": "*/*"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            request = urllib.request.Request(url, headers=headers)
            started = time.monotonic()
            session_bytes = 0
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    if offset and response.status != 206:
                        # Server ignored Range: restart cleanly rather than duplicate bytes.
                        offset = 0
                        target.unlink(missing_ok=True)
                        mode = "wb"
                    else:
                        mode = "ab" if offset else "wb"
                    range_header = response.headers.get("Content-Range")
                    if range_header and "/" in range_header:
                        try:
                            expected_size = max(expected_size, int(range_header.rsplit("/", 1)[1]))
                        except ValueError:
                            pass
                    length = int(response.headers.get("Content-Length") or 0)
                    if length:
                        expected_size = max(expected_size, offset + length)
                    with target.open(mode) as output:
                        while True:
                            self.check_cancel()
                            chunk = response.read(256 * 1024)
                            if not chunk:
                                break
                            output.write(chunk)
                            session_bytes += len(chunk)
                            elapsed = max(time.monotonic() - started, 0.01)
                            self.speed = session_bytes / elapsed
                            current = offset + session_bytes
                            fraction = min(current / expected_size, 1) if expected_size else 0
                            self.progress("下载视频流" if start_percent == 5 else "下载音频流",
                                          start_percent + (end_percent - start_percent) * fraction,
                                          current, expected_size or None, f"CDN {attempt % len(urls) + 1}")
                actual = target.stat().st_size if target.exists() else 0
                if actual == 0:
                    raise OSError("下载结果为空")
                if expected_size and actual < expected_size:
                    raise OSError(f"连接提前结束（{actual}/{expected_size} 字节），将断点续传")
                if expected_size and actual > expected_size:
                    raise OSError("下载文件大于预期长度，已放弃该响应")
                return
            except InterruptedError:
                raise
            except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
                errors.append(f"{error}")
                attempt += 1
                log(f"Download attempt {attempt} failed: {error}")
                if isinstance(error, urllib.error.HTTPError) and error.code in (400, 416):
                    target.unlink(missing_ok=True)
                    expected_size = 0
                elif isinstance(error, urllib.error.HTTPError) and error.code in (401, 403, 404, 410):
                    # Rotate immediately for an expired or unavailable mirror.
                    stalled = 0
                    last_size = -1
                if attempt >= max_failures:
                    raise RuntimeError("所有 CDN 均下载失败：" + "；".join(errors[-3:]))
                time.sleep(min(0.5 + attempt * 0.5, 3))

    def run(self):
        global active_job
        data = self.data
        validate_stream(data.get("video") or {}, "视频")
        validate_stream(data.get("audio") or {}, "音频")
        directory = Path(data.get("directory") or default_download_dir()).expanduser()
        directory.mkdir(parents=True, exist_ok=True)
        if not directory.is_dir():
            raise ValueError("保存位置不是目录")
        if not os.access(directory, os.W_OK):
            raise PermissionError("保存目录不可写")
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            raise RuntimeError("未找到 FFmpeg。请安装 ffmpeg 和 ffprobe，并确保它们位于 PATH。")
        base = safe_name(data.get("title") or data.get("bvid"))
        if data.get("partTitle"):
            page = data.get("page") or 1
            base = safe_name(f"{base} - P{page} {data['partTitle']}")
        output = unique_path(directory / f"{base}.mp4")
        stem = output.stem
        keep = bool(data.get("keep"))
        work = directory if keep else Path(tempfile.mkdtemp(prefix=".bili-downloader-", dir=directory))
        video_path = unique_path(work / f"{stem}.video.m4s")
        audio_path = unique_path(work / f"{stem}.audio.m4s")
        partial = work / f".{uuid.uuid4().hex}.partial.mp4"
        referer = f"https://www.bilibili.com/video/{data.get('bvid', '')}/"
        kept = []
        try:
            self.progress("准备下载", 2, detail=str(directory))
            self.download(data["video"], video_path, referer, 5, 70)
            self.download(data["audio"], audio_path, referer, 70, 90)
            self.check_cancel()
            self.progress("FFmpeg 无损合成", 93, detail="复制音视频流，不重新编码")
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                       "-i", str(video_path), "-i", str(audio_path),
                       "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                       "-movflags", "+faststart", "-metadata", f"title={data.get('title', '')}", str(partial)]
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            self.process = process
            _, stderr = process.communicate()
            self.process = None
            self.check_cancel()
            if process.returncode != 0:
                raise RuntimeError("FFmpeg 合成失败：" + stderr.decode("utf-8", errors="replace").strip())
            if not partial.exists() or partial.stat().st_size == 0:
                raise RuntimeError("FFmpeg 未生成有效输出文件")
            self.progress("验证音视频流", 97)
            probe = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                                    "stream=index,codec_type,codec_name,width,height,duration",
                                    "-of", "json", str(partial)], capture_output=True, timeout=60)
            if probe.returncode != 0:
                raise RuntimeError("ffprobe 无法验证合成文件")
            streams = json.loads(probe.stdout).get("streams", [])
            video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
            audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
            if not video_stream or not audio_stream:
                raise RuntimeError("合成验证失败：最终文件必须同时包含视频流和音频流")
            os.replace(partial, output)
            if keep:
                kept = [str(video_path), str(audio_path)]
            else:
                video_path.unlink(missing_ok=True)
                audio_path.unlink(missing_ok=True)
                work.rmdir()
            self.progress("完成", 100)
            send({"type": "done", "state": "done", "jobId": self.id, "output": str(output),
                  "kept": kept, "videoCodec": video_stream.get("codec_name"),
                  "audioCodec": audio_stream.get("codec_name")})
        finally:
            if self.process:
                self.process.terminate()
            partial.unlink(missing_ok=True)
            if not keep:
                for item in (video_path, audio_path):
                    item.unlink(missing_ok=True)
                try:
                    work.rmdir()
                except OSError:
                    pass
            with active_lock:
                if active_job is self:
                    active_job = None


def worker(data):
    global active_job
    job = DownloadJob(data)
    with active_lock:
        if active_job:
            send({"type": "error", "state": "error", "error": "已有下载任务正在进行"})
            return
        active_job = job
    try:
        job.run()
    except Exception as error:
        log(f"Job error: {error}")
        send({"type": "error", "state": "error", "jobId": job.id, "error": str(error)})


def main():
    while True:
        header = sys.stdin.buffer.read(4)
        if not header:
            return
        length = struct.unpack("<I", header)[0]
        if length > 1024 * 1024:
            raise ValueError("Native message too large")
        raw = sys.stdin.buffer.read(length)
        if len(raw) != length:
            return
        message = json.loads(raw)
        kind = message.get("type")
        if kind == "defaults":
            send({"type": "defaults", "state": "defaults", "platform": platform.system().lower(),
                  "downloadDir": default_download_dir(), "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))})
        elif kind == "choose_directory":
            try:
                send({"type": "directory", "state": "directory", "path": choose_directory()})
            except Exception as error:
                send({"type": "error", "state": "error", "error": str(error)})
        elif kind == "start":
            threading.Thread(target=worker, args=(message.get("job") or {},), daemon=True).start()
        elif kind == "cancel":
            with active_lock:
                if active_job and active_job.id == message.get("jobId"):
                    active_job.cancelled.set()
                    if active_job.process:
                        active_job.process.terminate()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"Fatal: {error}")
        try:
            send({"type": "error", "state": "error", "error": str(error)})
        except Exception:
            pass
