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
    def process_info(self, info_dict):
        # the transfer, after the lookup — the line the service times on
        if info_dict["outcome"] != "ok":
            raise main.yt_dlp.utils.DownloadError(info_dict["outcome"])
        tmpl = self.opts.get("outtmpl")
        path = tmpl["default"] if isinstance(tmpl, dict) else tmpl
        with open(path, "wb") as f: f.write(b"\0" * 50_000)
    def download(self, urls):
        calls.append(self.opts)
        outcome = script.pop(0)
        if outcome.startswith("lookup:"):
            raise main.yt_dlp.utils.DownloadError(outcome[len("lookup:"):])
        self.process_info({"outcome": outcome})
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
# 6. VIDEO 615 — the lookup and the transfer are timed apart, on success and on failure
seen: list = []
real_fetch = main._fetch_window
def spy(id, out_path, start, end, timing=None):
    try:
        real_fetch(id, out_path, start, end, timing)
    finally:
        seen.append(dict(timing))
main._fetch_window = spy
assert ask("aaaaaaaaab5", ["ok"]) == (200, 1)
t = seen[-1]
assert t["attempt"] == 1 and isinstance(t["extract_ms"], int) and isinstance(t["download_ms"], int), t
# a lookup that fails never reaches the transfer: no download time, only lookup time
assert ask("aaaaaaaaab6", ["lookup:ERROR: [youtube] x: This video is not available"]) == (502, 1)
t = seen[-1]
assert isinstance(t["extract_ms"], int) and t["download_ms"] is None, t
# a transfer that drops twice: the numbers are those of the second attempt
assert ask("aaaaaaaaab7", ["ERROR: ffmpeg exited with code 8", "ERROR: ffmpeg exited with code 8"]) == (502, 2)
t = seen[-1]
assert t["attempt"] == 2 and isinstance(t["download_ms"], int), t
main._fetch_window = real_fetch
print("check_retry: ok")
