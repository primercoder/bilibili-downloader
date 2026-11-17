#!/usr/bin/env python3
"""Build small muxer test fixtures from one real Bilibili DASH stream.

Bilibili's .m4s files are fragmented MP4: ftyp + moov + (sidx) + (moof + mdat)*.
A prefix that ends on a fragment boundary is still a perfectly valid file, so we
keep only the fragments that belong to the first N seconds of the video. Both
the video and audio fixtures are cut at the same point in time, which matters:
the muxer must be tested with two streams of equal length.

    python3 tests/fetch_fixtures.py            # download + trim to ~60s
    python3 tests/fetch_fixtures.py --full     # keep complete files
    python3 tests/fetch_fixtures.py --seconds 120
"""
import argparse
import json
import pathlib
import struct
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BV = "BV132436REqW"
OUT = pathlib.Path(__file__).resolve().parent / "fixtures"


def api(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return json.loads(urllib.request.urlopen(request, timeout=30).read())


def fetch(url, wanted_bytes):
    """Download at least wanted_bytes; we cannot know the exact cut up front."""
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{BV}/",
        "Range": f"bytes=0-{max(wanted_bytes, 1) - 1}"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except Exception:
        request = urllib.request.Request(url, headers={
            "User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{BV}/"})
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read(wanted_bytes)


def top_level_boxes(data):
    pos = 0
    end = len(data)
    while pos + 8 <= end:
        size = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8].decode("latin1")
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[pos + 8:pos + 16])[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return  # partial trailing box: stop, it is not usable
        yield typ, pos, size
        pos += size


def fragment_start_seconds(data, moof_start, moof_size):
    """Read tfdt from a moof to know the presentation time of the fragment."""
    search_end = moof_start + min(moof_size, 800)
    index = data.find(b"tfdt", moof_start, search_end)
    if index < 0:
        return None
    body = index + 4
    version = data[body]
    if version == 1:
        return struct.unpack(">Q", data[body + 4:body + 12])[0]
    return struct.unpack(">I", data[body + 4:body + 8])[0]


def timescale_of(data):
    index = data.find(b"mdhd")
    if index < 0:
        return 1000
    body = index + 4
    version = data[body]
    if version == 1:
        return struct.unpack(">I", data[body + 20:body + 24])[0]
    return struct.unpack(">I", data[body + 12:body + 16])[0]


def trim_to_seconds(data, seconds):
    """Return a prefix that ends on a fragment boundary at or after `seconds`."""
    scale = timescale_of(data) or 1000
    limit = int(seconds * scale)
    last_good = 0
    seen_moov = False
    saw_mdat_at_limit = False
    for typ, pos, size in top_level_boxes(data):
        if typ == "moov":
            seen_moov = True
        if typ == "moof" and seen_moov:
            timestamp = fragment_start_seconds(data, pos, size)
            # Break *before* the fragment that starts at or after the limit, so
            # both streams end at the same timestamp instead of a whole
            # fragment later.
            if timestamp is not None and timestamp >= limit:
                break
        if typ == "mdat" and seen_moov:
            last_good = pos + size
            saw_mdat_at_limit = True
    return data[:last_good] if saw_mdat_at_limit else data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--seconds", type=int, default=60)
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)

    view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={BV}")["data"]
    play = api("https://api.bilibili.com/x/player/playurl"
               f"?bvid={BV}&cid={view['cid']}&fnval=4048&fnver=0&fourk=1")["data"]
    dash = play["dash"]
    video = min((v for v in dash["video"] if v["codecs"].startswith("avc1")),
                key=lambda v: v["bandwidth"])
    audio = min(dash["audio"], key=lambda a: a["bandwidth"])

    # Generous first request: 60s of 1080p is ~6 MB, 360p ~2 MB. Trim afterwards.
    guess = 24 * 1024 * 1024
    for name, item in (("video.m4s", video), ("audio.m4s", audio)):
        data = fetch(item["baseUrl"], guess)
        if not args.full:
            data = trim_to_seconds(data, args.seconds)
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data):,} bytes")
    print("fixture span:", args.seconds, "seconds (same for both streams)")


if __name__ == "__main__":
    main()
