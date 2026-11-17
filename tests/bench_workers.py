#!/usr/bin/env python3
"""Compare single-connection vs multi-connection download speed through the host.

This measures the exact code path the extension uses, with different worker
counts, so the README can quote real numbers instead of guesses.

    python3 tests/bench_workers.py
    python3 tests/bench_workers.py --workers 1 2 4 8 16 --output /tmp/opencode
"""
import argparse
import json
import pathlib
import struct
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BV = "BV132436REqW"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def api(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return json.loads(urllib.request.urlopen(request, timeout=30).read())


def pick_host():
    for candidate in sorted((ROOT / "dist" / "hosts").glob("bili-host-*")):
        if "linux" in candidate.name or candidate.name == "bili-host":
            return candidate
    local = pathlib.Path("/tmp/opencode/bilihost")
    if local.exists():
        return local
    raise SystemExit("先运行 scripts/build.sh 或 go build")


def stream(item):
    return {"codecs": item["codecs"],
            "urls": [item["baseUrl"], *item.get("backupUrl", [])]}


class Host:
    def __init__(self, binary):
        self.proc = subprocess.Popen([str(binary)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def send(self, message):
        data = json.dumps(message, ensure_ascii=False).encode()
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()

    def receive(self):
        header = self.proc.stdout.read(4)
        if not header:
            raise SystemExit("host closed stdout")
        size = struct.unpack("<I", header)[0]
        return json.loads(self.proc.stdout.read(size))

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.terminate()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, nargs="+", default=[1, 2, 4, 8, 16])
    parser.add_argument("--quality", type=int, default=80, help="video quality id")
    parser.add_argument("--output", default="/tmp/opencode/bench")
    args = parser.parse_args()

    outdir = pathlib.Path(args.output)
    outdir.mkdir(parents=True, exist_ok=True)

    host = pick_host()
    view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}")["data"]
    play = api("https://api.bilibili.com/x/player/playurl"
               f"?bvid={BV}&cid={view['cid']}&fnval=4048&fnver=0&fourk=1")["data"]
    dash = play["dash"]
    video = next((v for v in dash["video"]
                  if v["id"] == args.quality and v["codecs"].startswith("avc1")),
                 max((v for v in dash["video"] if v["codecs"].startswith("avc1")),
                     key=lambda v: v["bandwidth"]))
    audio = max(dash["audio"], key=lambda a: a["bandwidth"])
    print(f"stream: {video['width']}x{video['height']} {video['codecs']} "
          f"{video['bandwidth'] // 1000} kbps")

    results = []
    for workers in args.workers:
        client = Host(host)
        target = outdir / f"bench-{workers}.mp4"
        for stale in outdir.glob(f"bench-{workers}*"):
            stale.unlink()
        job = {
            "id": f"bench-{workers}", "title": f"bench-{workers}", "bvid": BV,
            "page": 1, "keep": False, "directory": str(outdir), "workers": workers,
            "video": stream(video), "audio": stream(audio),
        }
        client.send({"type": "defaults"})
        client.receive()
        started = time.time()
        client.send({"type": "start", "job": job})
        peak = 0.0
        while True:
            message = client.receive()
            if message["type"] == "progress":
                peak = max(peak, message.get("speed") or 0)
            elif message["type"] == "done":
                elapsed = time.time() - started
                size = pathlib.Path(message["output"]).stat().st_size
                results.append((workers, elapsed, size, peak))
                print(f"  workers={workers:2d}  {elapsed:5.1f}s  "
                      f"{size / 1048576 / elapsed:5.1f} MB/s avg  "
                      f"{peak / 1048576:5.1f} MB/s peak")
                pathlib.Path(message["output"]).unlink(missing_ok=True)
                break
            elif message["type"] == "error":
                print(f"  workers={workers:2d}  FAILED: {message['error']}")
                break
        client.close()

    if len(results) >= 2:
        baseline = next((r for r in results if r[0] == 1), results[0])
        print("\nspeed-up vs 1 connection:")
        for workers, elapsed, size, peak in results:
            print(f"  {workers:2d} workers: {baseline[1] / elapsed:4.2f}x")


if __name__ == "__main__":
    main()
