"""Run with the service requirements installed:  python check_storyboard.py

VIDEO 659 — `/storyboard` returns the sharpest storyboard level no wider than the cap and an English
json3 caption track, from metadata only. yt-dlp is replaced by a stand-in; nothing touches YouTube.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
import main
from fastapi.testclient import TestClient

INFO = {
    "duration": 600,
    "formats": [
        {"format_id": "sb2", "format_note": "storyboard", "width": 80, "height": 45, "rows": 10, "columns": 10,
         "fragments": [{"url": "https://i.ytimg.com/sb/x/L1/M0.jpg", "duration": 600}]},
        {"format_id": "sb1", "format_note": "storyboard", "width": 160, "height": 90, "rows": 5, "columns": 5,
         "fragments": [{"url": "https://i.ytimg.com/sb/x/L2/M0.jpg", "duration": 300}, {"url": "https://i.ytimg.com/sb/x/L2/M1.jpg", "duration": 300}]},
        {"format_id": "sb0", "format_note": "storyboard", "width": 640, "height": 360, "rows": 3, "columns": 3,
         "fragments": [{"url": "https://i.ytimg.com/sb/x/L3/M0.jpg", "duration": 90}]},
        {"format_id": "18", "ext": "mp4", "width": 640, "height": 360, "url": "https://googlevideo/stream"},
    ],
    "automatic_captions": {"en": [{"ext": "vtt", "url": "https://yt/auto.vtt"}, {"ext": "json3", "url": "https://yt/auto.json3"}]},
    "subtitles": {"en": [{"ext": "json3", "url": "https://yt/manual.json3"}]},
}
mode = {"raise": False, "info": INFO}
class FakeYDL:
    def __init__(self, opts): self.opts = opts
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def extract_info(self, url, download=True):
        assert download is False, "the storyboard is metadata only"
        assert "format" not in self.opts and "download_ranges" not in self.opts
        if mode["raise"]: raise Exception("Sign in to confirm you're not a bot")
        return mode["info"]
main.yt_dlp.YoutubeDL = FakeYDL
main._probe_on_boot = lambda: None
c = TestClient(main.app)

r = c.get("/storyboard", params={"id": "abcdefghijk"})
body = r.json(); print("ok", r.status_code, body["width"], len(body["fragments"]), body["captionUrl"])
assert r.status_code == 200 and body["width"] == 160 and body["rows"] == 5 and body["columns"] == 5
assert [f["duration"] for f in body["fragments"]] == [300.0, 300.0]
assert body["captionUrl"] == "https://yt/manual.json3" and body["duration"] == 600

# only an automatic track → it is used
mode["info"] = {**INFO, "subtitles": {}}
assert c.get("/storyboard", params={"id": "abcdefghijk"}).json()["captionUrl"] == "https://yt/auto.json3"

# no storyboard at all → 404, the caller falls back to downloading as before
mode["info"] = {"duration": 50, "formats": [{"format_id": "18", "ext": "mp4"}]}
r = c.get("/storyboard", params={"id": "abcdefghijk"}); print("none", r.status_code, r.json())
assert r.status_code == 404 and r.json()["error"] == "no_storyboard"

# YouTube refuses → 502, never a crash
mode["raise"] = True
r = c.get("/storyboard", params={"id": "abcdefghijk"}); print("refused", r.status_code, r.json())
assert r.status_code == 502 and r.json() == {"error": "extract_failed"}

# with a token configured, a missing bearer is refused
main.SERVICE_TOKEN = "t"
assert c.get("/storyboard", params={"id": "abcdefghijk"}).status_code == 401
print("ALL OK")
