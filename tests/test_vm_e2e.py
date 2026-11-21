#!/usr/bin/env python3
"""Windows VM end-to-end test for bili-downloader 2.3.0 (HTTP API).

Covers the reported issues on the real Windows platform:
  - helper discovery: /health, /defaults
  - issue #6: picked download directory survives restart; tray opens it
  - issue #7: progress stage stays stable (no 视频/音频 flipping)
  - real download from Bilibili CDN -> muxed MP4 -> verified
  - single instance, autostart registry on/off

Usage (in the VM):
    python test_vm_e2e.py            # full suite
    python test_vm_e2e.py --skip-download
"""
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:47821"
OUTPUTS = pathlib.Path(r"C:\Users\win\Desktop\outputs")
STATE_DIR = OUTPUTS / "bili-state"
HOST_EXE = OUTPUTS / "bili-downloader-2.3.0-windows-x64" / "host" / "bili-host.exe"
PICKED_DIR = OUTPUTS / "picked-dir"
BV = "BV132436REqW"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def api(url, headers=None, timeout=30):
    request = urllib.request.Request(url, headers=headers or {})
    return json.loads(urllib.request.urlopen(request, timeout=timeout).read())


def host_api(path, headers=None):
    headers = dict(headers or {})
    headers.setdefault("X-Bili-Client", "extension")
    return api(BASE + path, headers)


def run_cmd(args, timeout=30):
    # Windows console tools emit GBK; never let a decode error kill the test.
    return subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def kill_helper():
    run_cmd(["taskkill", "/F", "/IM", "bili-host.exe"])
    time.sleep(0.8)


def helper_log_tail():
    """Read the helper's log (last 50 lines); missing file returns ''. """
    log = pathlib.Path(os.environ.get("TEMP", r"C:\Users\win\AppData\Local\Temp")) / "bili-downloader-host.log"
    try:
        return log.read_text(encoding="utf-8", errors="replace")[-20000:]
    except OSError:
        return ""


def start_helper_detached(state_dir=None):
    # WMI Create survives the SSH session (Start-Process under SSH dies with
    # it), but the new process does NOT inherit our environment, so a custom
    # state dir goes through a generated .cmd file — no quoting games.
    if state_dir:
        launcher = OUTPUTS / "start-helper.cmd"
        launcher.write_text(
            f"@echo off\r\nset BILI_DOWNLOADER_STATE={state_dir}\r\n"
            f'"{HOST_EXE}"\r\n', encoding="ascii")
        cmdline = f"'{launcher}'"
    else:
        cmdline = f"'{HOST_EXE}'"
    last_error = None
    for _attempt in range(3):
        r = run_cmd(
            ["powershell", "-NoProfile", "-Command",
             "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
             f"-Arguments @{{ CommandLine = {cmdline} }}).ReturnValue"],
            timeout=40)
        code = r.stdout.strip()
        if code != "0":
            last_error = f"rc={code} {r.stderr.strip()}"
            time.sleep(1.5)
            continue
        for _ in range(40):
            try:
                host_api("/health")
                return
            except Exception:
                time.sleep(0.3)
        last_error = "helper did not come up"
        time.sleep(1.5)
    raise SystemExit(f"WMI start failed: {last_error}")


def fetch_playinfo():
    headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
    view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}",
               headers)["data"]
    play = api("https://api.bilibili.com/x/player/playurl"
               f"?bvid={BV}&cid={view['cid']}&fnval=4048&fnver=0&fourk=1",
               headers)["data"]
    dash = play["dash"]
    video = next((v for v in dash["video"]
                  if v["codecs"].startswith("avc1")), dash["video"][0])
    audio = max(dash["audio"], key=lambda a: a["bandwidth"])
    return {
        "title": view["title"], "cid": view["cid"],
        "video": {"codecs": video["codecs"],
                  "urls": [video["baseUrl"], *video.get("backupUrl", [])]},
        "audio": {"codecs": audio["codecs"],
                  "urls": [audio["baseUrl"], *audio.get("backupUrl", [])]},
    }


def wait_done(job_id, timeout_s=300):
    """Poll GET /jobs until the job reports done/error; return last message."""
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        jobs = host_api("/jobs").get("jobs", [])
        last = next((j for j in jobs if j.get("jobId") == job_id), None)
        if last and last.get("type") in ("done", "error"):
            return last
        time.sleep(1.0)
    return last or {"type": "timeout"}


def main():
    skip_download = "--skip-download" in sys.argv
    print(f"host: {HOST_EXE}")
    print(f"state dir: {STATE_DIR}")
    print()

    # --- 0. clean slate -----------------------------------------------------
    kill_helper()
    shutil.rmtree(STATE_DIR, ignore_errors=True)
    PICKED_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    # --- 1. first run: defaults to Downloads, no state file -----------------
    start_helper_detached(state_dir=str(STATE_DIR))
    check("start helper with custom state dir", True)

    defaults = host_api("/defaults")["defaults"]
    check("first-run default dir is Downloads",
          os.path.normcase(defaults["downloadDir"]) == os.path.normcase(r"C:\Users\win\Downloads"),
          defaults["downloadDir"])
    check("no state file on first run",
          not (STATE_DIR / "state.json").exists())
    check("health identity", host_api("/health")["app"] == "bili-downloader")

    # --- 2. issue #6: job with explicit dir records memory ------------------
    if not skip_download:
        info = fetch_playinfo()
        print(f"video: {info['video']['codecs']}")
        job = {
            "id": "vm-e2e-1", "title": "VM E2E 测试", "bvid": BV, "page": 1,
            "keep": False, "directory": str(PICKED_DIR), "workers": 8,
            "video": info["video"], "audio": info["audio"],
        }
        post = urllib.request.Request(
            BASE + "/jobs", data=json.dumps(job).encode(),
            headers={"Content-Type": "application/json",
                     "X-Bili-Client": "extension"})
        urllib.request.urlopen(post, timeout=15)

        # Collect progress messages while downloading (for issue #7).
        stages = []
        deadline = time.time() + 300
        done = None
        while time.time() < deadline:
            jobs = host_api("/jobs").get("jobs", [])
            cur = next((j for j in jobs if j.get("jobId") == "vm-e2e-1"), None)
            if cur:
                stage = cur.get("stage", "")
                if not stages or stages[-1] != stage:
                    stages.append(stage)
                    print(f"    stage: {stage}  {cur.get('percent', 0)}%")
                if cur.get("type") in ("done", "error"):
                    done = cur
                    break
            time.sleep(0.6)
        check("download finished", done is not None and done["type"] == "done",
              json.dumps(done or {}, ensure_ascii=False)[:200])

        if done and done["type"] == "done":
            out = pathlib.Path(done["output"])
            size = out.stat().st_size
            check("output file exists and > 1 MiB", out.exists() and size > 1024 * 1024,
                  f"{size/1048576:.1f} MiB")
            check("output duration sane", (done.get("duration") or 0) > 60,
                  f"{done.get('duration')}s")
            check("codecs reported", done.get("videoCodec") and done.get("audioCodec"),
                  f"{done.get('videoCodec')} + {done.get('audioCodec')}")

        # issue #7: stages stable
        bad = [s for s in stages if "视频" in s or "音频" in s]
        check("issue #7: no per-stream stage labels", not bad, str(stages))
        check("issue #7: 下载中 stage present", "下载中" in stages, str(stages))
        check("issue #7: 合并中 stage present", "合并中" in stages, str(stages))

        # issue #6: memory recorded
        time.sleep(1.0)
        state_file = STATE_DIR / "state.json"
        check("issue #6: state.json written", state_file.exists(),
              str(state_file))
        if state_file.exists():
            saved = json.loads(state_file.read_text(encoding="utf-8"))
            check("issue #6: remembered dir == picked dir",
                  os.path.normcase(saved.get("downloadDir", "")) == os.path.normcase(str(PICKED_DIR)),
                  saved.get("downloadDir", ""))

        defaults = host_api("/defaults")["defaults"]
        check("issue #6: /defaults returns picked dir",
              os.path.normcase(defaults["downloadDir"]) == os.path.normcase(str(PICKED_DIR)),
              defaults["downloadDir"])

    # --- 3. restart helper: memory survives ---------------------------------
    kill_helper()
    start_helper_detached(state_dir=str(STATE_DIR))
    defaults = host_api("/defaults")["defaults"]
    if skip_download:
        check("restart ok", True)
    else:
        check("issue #6: memory survives restart",
              os.path.normcase(defaults["downloadDir"]) == os.path.normcase(str(PICKED_DIR)),
              defaults["downloadDir"])

    # --- 4. single instance --------------------------------------------------
    # Detection itself is instant (the log gets "another host already
    # listening" the moment the second copy starts). The second process then
    # shows a message box; under SSH that box lives in session 0 with nobody
    # to click it, so instead of asserting process exit we assert the
    # *behaviour*: the original instance keeps serving, and the log records
    # the duplicate being turned away.
    log_before = helper_log_tail()
    r = run_cmd(
        ["powershell", "-NoProfile", "-Command",
         f"Start-Process -FilePath '{HOST_EXE}' -WindowStyle Hidden;"
         "Start-Sleep 4;"
         "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
         f"-Arguments @{{ CommandLine = '{HOST_EXE}' }}).ReturnValue"],
        timeout=60)
    time.sleep(2)
    health = api(BASE + "/health")
    log_after = helper_log_tail()
    duplicates = log_after.count("another host already listening") - log_before.count(
        "another host already listening")
    check("single instance: original keeps serving", health.get("ok") is True,
          f"pid={health.get('pid')}")
    check("single instance: duplicate rejected", duplicates >= 1,
          f"{duplicates} rejection(s) in log")
    run_cmd(["taskkill", "/F", "/IM", "bili-host.exe"])
    time.sleep(0.8)
    start_helper_detached(state_dir=str(STATE_DIR))

    # --- 5. autostart registry ------------------------------------------------
    r_on = run_cmd([str(HOST_EXE), "autostart", "on"])
    check("autostart on command succeeds", "已设置" in r_on.stdout, r_on.stdout.strip())
    run = run_cmd(["reg", "query",
                   r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                   "/v", "BiliDownloader"])
    check("autostart on writes registry", "BiliDownloader" in run.stdout)
    r = run_cmd([str(HOST_EXE), "autostart", "off"])
    run = run_cmd(["reg", "query",
                   r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                   "/v", "BiliDownloader"])
    check("autostart off removes registry", "BiliDownloader" not in run.stdout)

    # --- 6. CORS guard ---------------------------------------------------------
    try:
        api(BASE + "/defaults")  # no origin, no client header
        check("CORS: /defaults needs client header", False, "accepted without header")
    except Exception:
        check("CORS: /defaults needs client header", True)

    health = api(BASE + "/health")
    check("CORS: /health open", health.get("ok") is True)

    # --- summary ---------------------------------------------------------------
    print()
    failed = [n for n, ok, _ in results if not ok]
    print(f"=== {len(results) - len(failed)}/{len(results)} passed ===")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
