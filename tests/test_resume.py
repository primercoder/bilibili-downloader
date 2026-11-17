#!/usr/bin/env python3
"""Unit test: a prematurely closed CDN response must resume with HTTP Range."""
import importlib.util
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("native_host", ROOT / "native_host" / "native_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
host.send = lambda _message: None

PAYLOAD = bytes(range(256)) * 4096
request_count = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        global request_count
        request_count += 1
        start = 0
        range_header = self.headers.get("Range")
        if range_header:
            start = int(range_header.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD) - start))
        self.end_headers()
        chunk = PAYLOAD[start:]
        if request_count == 1:
            # Simulate a dropped CDN connection: advertise the full size, then
            # close after a small part of the body.
            self.wfile.write(chunk[:70000])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(chunk)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as directory:
    target = Path(directory) / "video.m4s"
    job = host.DownloadJob({"id": "unit"})
    job.download({"urls": [f"http://127.0.0.1:{server.server_port}/video.m4s"]},
                 target, "https://www.bilibili.com/", 5, 70)
    assert target.read_bytes() == PAYLOAD, (target.stat().st_size, len(PAYLOAD))
    assert request_count >= 2, request_count
    print(f"PASS: resumed after truncated response ({request_count} requests, {target.stat().st_size} bytes)")
server.shutdown()
