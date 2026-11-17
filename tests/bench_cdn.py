#!/usr/bin/env python3
"""Measure sustained Bilibili CDN throughput per connection count.

The point of multi-connection downloading is not the first second (a single
connection is fast there) but sustained transfer: Bilibili's CDN throttles each
TCP connection once it has been busy for a while. This benchmark keeps every
connection busy for a fixed window on a large file and reports the sustained
rate, which is what the downloader actually has to beat.

    python3 tests/bench_cdn.py --seconds 20 --connections 1 4 8
"""
import argparse
import json
import threading
import time
import urllib.request

BV = "BV1i4411L7br"  # 4.4 h stream: ~1.5 GB, big enough for a sustained test
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CHUNK = 1 << 20


def api(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return json.loads(urllib.request.urlopen(request, timeout=30).read())


def resolve_stream():
    view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}")["data"]
    play = api("https://api.bilibili.com/x/player/playurl"
               f"?bvid={BV}&cid={view['cid']}&fnval=4048&fnver=0&fourk=1")["data"]
    best = max(play["dash"]["video"], key=lambda v: v["bandwidth"])
    urls = [best["baseUrl"], *best.get("backupUrl", [])]
    return urls, best, view


def measure(url, referer, size, connections, seconds):
    stop = time.time() + seconds
    per_connection = size // connections
    totals = [0] * connections
    lock = threading.Lock()

    def worker(index):
        # Give each connection its own contiguous slice so the CDN sees normal
        # sequential reads, like the downloader does per segment.
        base = index * per_connection
        position = base
        end_of_slice = base + per_connection - 1
        headers = {"User-Agent": UA, "Referer": referer}
        while time.time() < stop and position < end_of_slice:
            end = min(position + 8 * 1024 * 1024 - 1, end_of_slice)
            request = urllib.request.Request(
                url, headers={**headers, "Range": f"bytes={position}-{end}"})
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    while time.time() < stop:
                        chunk = response.read(CHUNK)
                        if not chunk:
                            break
                        with lock:
                            totals[index] += len(chunk)
            except Exception:
                time.sleep(0.2)
            position = end + 1

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(connections)]
    started = time.time()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.time() - started
    return sum(totals) / elapsed, elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--connections", type=int, nargs="+", default=[1, 4, 8])
    args = parser.parse_args()

    urls, stream, view = resolve_stream()
    print(f"stream: {stream['width']}x{stream['height']} {stream['codecs']} "
          f"{stream['bandwidth'] // 1000} kbps, {view['duration']}s")
    print(f"measuring {args.seconds:.0f}s per configuration\n")

    results = {}
    for connections in args.connections:
        rate, elapsed = measure(urls[0], f"https://www.bilibili.com/video/{BV}/",
                                stream["bandwidth"] // 8 * view["duration"],
                                connections, args.seconds)
        results[connections] = rate
        print(f"  {connections:2d} connection(s): {rate / 1e6:5.1f} MB/s sustained "
              f"({rate / 1e6 * elapsed:6.0f} MB in {elapsed:.1f}s)")

    single = results.get(1)
    if single:
        print("\nrelative sustained throughput:")
        for connections, rate in results.items():
            print(f"  {connections:2d} connection(s): {rate / single:4.2f}x")


if __name__ == "__main__":
    main()
