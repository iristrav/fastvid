"""Run with the service requirements installed:  python check_retry.py

Video 614 — a cut that failed for the moment (ffmpeg dropped the stream, a bot check) is asked
again once; one that failed for the video (unavailable, country block) is not. yt-dlp is replaced
by a stand-in; nothing touches YouTube.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
import main
from pathlib import Path
from fastapi.testclient import TestClient

script: list = []
calls: list = []
class FakeYDL:
    def __init__(self, opts): self.opts = opts
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def download(self, urls):
        calls.append(self.opts)
        outcome = script.pop(0)
        if outcome != "ok":
            raise main.yt_dlp.utils.DownloadError(outcome)
        tmpl = self.opts.get("outtmpl")
        path = tmpl["default"] if isinstance(tmpl, dict) else tmpl
        with open(path, "wb") as f: f.write(b"\0" * 50_000)
main.yt_dlp.YoutubeDL = FakeYDL
main.RESULT_DIR = Path(tempfile.mkdtemp(prefix="ytdl-results-retry-"))
main._probe_on_boot = lambda: None
c = TestClient(main.app)

def ask(vid, outcomes):
    script[:] = outcomes; calls.clear()
    return c.get("/download", params={"id": vid, "duration": 4, "start": 10}).status_code, len(calls)

# 1. a dropped stream, then success: answered 200 after two attempts
assert ask("aaaaaaaaab1", ["ERROR: ffmpeg exited with code 251", "ok"]) == (200, 2)
# 2. a bot check, then success
assert ask("aaaaaaaaab2", ["ERROR: [youtube] x: Sign in to confirm you're not a bot.", "ok"]) == (200, 2)
# 3. the video itself is gone: asked once, 502
assert ask("aaaaaaaaab3", ["ERROR: [youtube] x: This video is not available"]) == (502, 1)
# 4. two dropped streams: two attempts, then 502 with the message
status, n = ask("aaaaaaaaab4", ["ERROR: ffmpeg exited with code 8", "ERROR: ffmpeg exited with code 8"])
assert (status, n) == (502, 2)
# 5. every attempt tells ffmpeg to reconnect
assert all(o["external_downloader_args"]["ffmpeg_i"][:2] == ["-reconnect", "1"] for o in calls)
print("check_retry: ok")
