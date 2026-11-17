#!/usr/bin/env python3
"""Protocol-level integration test: native host -> real CDN -> FFmpeg -> ffprobe."""
import json
import os
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "native_host" / "native_host.py"
OUT = Path("/tmp/opencode/bili-test-output")
OUT.mkdir(parents=True, exist_ok=True)
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/video/BV132436REqW/"}


def api(url):
    request = urllib.request.Request(url, headers=HEADERS)
    return json.loads(urllib.request.urlopen(request, timeout=30).read())


view = api("https://api.bilibili.com/x/web-interface/view?bvid=BV132436REqW")["data"]
play = api(f"https://api.bilibili.com/x/player/playurl?bvid=BV132436REqW&cid={view['cid']}&fnval=4048&fnver=0&fourk=1")["data"]
video = next(v for v in play["dash"]["video"] if v["id"] == 16 and v["codecs"].startswith("avc1"))
audio = max(play["dash"]["audio"], key=lambda a: a["bandwidth"])


def stream(item):
    return {"codecs": item["codecs"], "urls": [item["baseUrl"], *item.get("backupUrl", [])]}


job = {
    "id": "integration-test", "title": "集成测试-BV132436REqW", "bvid": "BV132436REqW",
    "page": 1, "keep": False, "directory": str(OUT),
    "video": stream(video), "audio": stream(audio),
}

proc = subprocess.Popen([sys.executable, str(HOST)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode()
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()


def receive():
    header = proc.stdout.read(4)
    if not header:
        raise RuntimeError("native host closed stdout")
    size = struct.unpack("<I", header)[0]
    return json.loads(proc.stdout.read(size))


send({"type": "defaults"})
print("DEFAULTS:", receive())
send({"type": "start", "job": job})
last_percent = -10
while True:
    message = receive()
    if message["type"] == "progress":
        if message["percent"] - last_percent >= 10 or message["percent"] == 100:
            print(f"PROGRESS {message['percent']:6.1f}% {message['stage']}")
            last_percent = message["percent"]
    else:
        print("FINAL:", json.dumps(message, ensure_ascii=False))
        if message["type"] == "done":
            output = message["output"]
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,duration",
                                    "-show_entries", "format=duration,size", "-of", "json", output],
                                   capture_output=True, text=True, check=True)
            print("FFPROBE:", probe.stdout)
            if not all(s["codec_type"] in ("video", "audio") for s in json.loads(probe.stdout)["streams"]):
                raise SystemExit("missing stream")
            if len(json.loads(probe.stdout)["streams"]) < 2:
                raise SystemExit("expected two streams")
            streams = {s["codec_type"]: s for s in json.loads(probe.stdout)["streams"]}
            video_duration = float(streams["video"]["duration"])
            audio_duration = float(streams["audio"]["duration"])
            if abs(video_duration - audio_duration) > 2:
                raise SystemExit(f"stream duration mismatch: video={video_duration}, audio={audio_duration}")
            if video_duration < 790:
                raise SystemExit(f"video is truncated: {video_duration}s")
            print(f"PASS: merged MP4 contains video and audio, duration {video_duration:.1f}s")
        else:
            raise SystemExit(1)
        break
proc.stdin.close()
proc.terminate()
