#!/usr/bin/env python3
"""End-to-end test: real Bilibili CDN -> native host -> muxed MP4.

Talks to the compiled helper over the same stdin/stdout protocol Chrome uses,
so it exercises exactly the code path the extension triggers.

    python3 tests/e2e_native.py                     # uses ./dist/hosts/<platform>
    python3 tests/e2e_native.py --host /path/to/host
    python3 tests/e2e_native.py --keep              # keep the output file
"""
import argparse
import json
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
BV = "BV132436REqW"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def api(url):
    import urllib.request
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return json.loads(urllib.request.urlopen(request, timeout=30).read())


def pick_host(explicit):
    if explicit:
        return pathlib.Path(explicit)
    candidates = sorted((ROOT / "dist" / "hosts").glob("bili-host-*"))
    for candidate in candidates:
        if "linux" in candidate.name or candidate.name == "bili-host":
            return candidate
    local = pathlib.Path("/tmp/opencode/bilihost")
    if local.exists():
        return local
    raise SystemExit("找不到本地助手可执行文件；先运行 scripts/build.sh")


def stream(item):
    return {"codecs": item["codecs"], "urls": [item["baseUrl"], *item.get("backupUrl", [])]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--quality", type=int, default=32, help="video quality id")
    args = parser.parse_args()
    host = pick_host(args.host)

    view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}")["data"]
    play = api("https://api.bilibili.com/x/player/playurl"
               f"?bvid={BV}&cid={view['cid']}&fnval=4048&fnver=0&fourk=1")["data"]
    dash = play["dash"]
    video = next((v for v in dash["video"]
                  if v["id"] == args.quality and v["codecs"].startswith("avc1")),
                 dash["video"][0])
    audio = max(dash["audio"], key=lambda a: a["bandwidth"])
    print(f"video: {video['width']}x{video['height']} {video['codecs']} "
          f"{video['bandwidth'] // 1000} kbps")
    print(f"audio: {audio['codecs']} {audio['bandwidth'] // 1000} kbps")

    outdir = pathlib.Path(tempfile.mkdtemp(prefix="bili-e2e-"))
    job = {
        "id": "e2e-test", "title": f"E2E {BV}", "bvid": BV, "page": 1,
        "keep": False, "directory": str(outdir), "workers": 8,
        "video": stream(video), "audio": stream(audio),
    }

    proc = subprocess.Popen([str(host)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)

    def send(message):
        data = json.dumps(message, ensure_ascii=False).encode()
        proc.stdin.write(struct.pack("<I", len(data)) + data)
        proc.stdin.flush()

    def receive():
        header = proc.stdout.read(4)
        if not header:
            raise SystemExit("host closed stdout")
        size = struct.unpack("<I", header)[0]
        return json.loads(proc.stdout.read(size))

    send({"type": "defaults"})
    defaults = receive()
    print("defaults:", json.dumps(defaults, ensure_ascii=False))
    assert defaults["type"] == "defaults"
    assert defaults["muxer"] == "builtin"

    started = time.time()
    send({"type": "start", "job": job})
    last_percent = -10.0
    samples = []
    while True:
        message = receive()
        if message["type"] == "progress":
            percent = message["percent"]
            if percent - last_percent >= 10:
                print(f"  {percent:6.1f}%  {message['stage']:<12} "
                      f"{message.get('speed', 0) / 1e6:6.1f} MB/s  {message.get('detail', '')}")
                last_percent = percent
            samples.append((time.time() - started, message.get("downloaded") or 0,
                            message.get("speed") or 0))
        else:
            if message["type"] == "done":
                elapsed = time.time() - started
                print(f"done in {elapsed:.1f}s: {message['output']}")
                print(f"  duration {message['duration']:.1f}s, "
                      f"codecs {message['videoCodec']} + {message['audioCodec']}")
                size = pathlib.Path(message["output"]).stat().st_size
                print(f"  size {size / 1048576:.1f} MiB")
                if size < 1024 * 1024:
                    raise SystemExit("output too small")
                if message["duration"] < 60:
                    raise SystemExit("duration looks truncated")
                speeds = [s for _, _, s in samples if s]
                if speeds:
                    print(f"  peak speed {max(speeds) / 1e6:.1f} MB/s")
                # Verify with the system ffprobe when available: the strongest
                # possible proof that the built-in muxer is correct.
                if shutil.which("ffprobe"):
                    probe = subprocess.run(
                        ["ffprobe", "-v", "error", "-print_format", "json",
                         "-show_entries", "stream=codec_type,codec_name,duration,width,height",
                         "-show_entries", "format=duration", message["output"]],
                        capture_output=True, text=True)
                    if probe.returncode != 0:
                        raise SystemExit("ffprobe rejected the output: " + probe.stderr)
                    parsed = json.loads(probe.stdout)
                    kinds = [s["codec_type"] for s in parsed["streams"]]
                    if sorted(kinds) != ["audio", "video"]:
                        raise SystemExit(f"unexpected streams: {kinds}")
                    print(f"  ffprobe: {kinds} OK")
                print("PASS")
                if not args.keep:
                    shutil.rmtree(outdir, ignore_errors=True)
            else:
                print("FAILED:", json.dumps(message, ensure_ascii=False))
                proc.kill()
                sys.exit(1)
            break
    proc.stdin.close()
    proc.terminate()


if __name__ == "__main__":
    main()
