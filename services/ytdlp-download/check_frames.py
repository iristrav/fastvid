"""Run with the service requirements installed:  python check_frames.py

VIDEO 659 (step 3) — `/frames` reads one sharp frame per asked second straight from the stream and
tiles them; a second past the end is left off, and `X-Frame-Seconds` says which seconds are on the
sheet. yt-dlp is replaced by a stand-in whose "stream" is a local file; nothing touches YouTube.
"""
import os, sys, subprocess, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
from pathlib import Path
import main
from fastapi.testclient import TestClient

SRC = Path(tempfile.mkdtemp(prefix="frames-src-")) / "v.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=20",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(SRC)], check=True)
mode = {"raise": False, "info": {"url": str(SRC), "vcodec": "avc1", "protocol": "https"}}
seen_opts = {}
class FakeYDL:
    def __init__(self, opts): seen_opts.update(opts)
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def extract_info(self, url, download=True):
        assert download is False
        if mode["raise"]: raise Exception("Sign in to confirm you're not a bot")
        return mode["info"]
main.yt_dlp.YoutubeDL = FakeYDL
main._probe_on_boot = lambda: None
c = TestClient(main.app)

r = c.get("/frames", params={"id": "abcdefghijk", "at": "2,5,5.2,8,9,40"})
print("ok", r.status_code, r.headers.get("x-frame-seconds"), len(r.content))
assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
assert r.headers["x-frame-seconds"] == "2,5,8,9", r.headers["x-frame-seconds"]
assert "m3u8" in seen_opts["format"] and "download_ranges" not in seen_opts
out = Path(tempfile.mkdtemp()) / "s.jpg"; out.write_bytes(r.content)
wh = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(out)],
                    capture_output=True, text=True).stdout.strip()
w, h = map(int, wh.split(","))
print("sheet", w, h); assert w >= 4 * 480 and h >= 270

# HLS only → no usable stream
mode["info"] = {"url": "https://x/playlist.m3u8", "protocol": "m3u8_native", "vcodec": "avc1"}
assert c.get("/frames", params={"id": "abcdefghijk", "at": "2"}).json() == {"error": "no_stream"}
# YouTube refuses
mode["raise"] = True
assert c.get("/frames", params={"id": "abcdefghijk", "at": "2"}).status_code == 502
# nothing asked
assert c.get("/frames", params={"id": "abcdefghijk", "at": "x,y"}).status_code == 400
# no more than FRAMES_MAX
assert len(main._parse_seconds(",".join(str(i) for i in range(40)))) == main.FRAMES_MAX
print("ALL OK")
