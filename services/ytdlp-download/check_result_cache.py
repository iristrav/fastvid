"""Run with the service requirements installed:  python check_result_cache.py

RONDE 642 — a finished cut is kept for the caller who asks again, and one cut is made for three
simultaneous asks. yt-dlp is replaced by a slow stand-in that writes a file; nothing touches YouTube.
"""
import os, sys, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import os
os.environ["SERVICE_TOKEN"] = ""
import main
from fastapi.testclient import TestClient

calls = []
class FakeYDL:
    def __init__(self, opts): self.opts = opts
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def download(self, urls):
        calls.append(urls[0]); time.sleep(1.0)
        # write the file yt-dlp would have written
        tmpl = self.opts.get("outtmpl")
        path = tmpl["default"] if isinstance(tmpl, dict) else tmpl
        with open(path, "wb") as f: f.write(b"\0" * 50_000)
main.yt_dlp.YoutubeDL = FakeYDL
# A directory of its own, so an earlier run's kept results cannot answer for this one.
import tempfile
from pathlib import Path
main.RESULT_DIR = Path(tempfile.mkdtemp(prefix="ytdl-results-check-"))
main._probe_on_boot = lambda: None
c = TestClient(main.app)

# 1. first ask cuts, second ask is served from the kept result
r1 = c.get("/download", params={"id": "abcdefghijk", "duration": 4, "start": 99.2})
t = time.time(); r2 = c.get("/download", params={"id": "abcdefghijk", "duration": 4, "start": 99.2}); dt = time.time() - t
print("first", r1.status_code, len(r1.content), "second", r2.status_code, len(r2.content), f"{dt:.3f}s", "ytdlp calls", len(calls))
assert r1.status_code == 200 and r2.status_code == 200 and len(calls) == 1 and dt < 0.5

# 2. two concurrent asks for the same cut run yt-dlp once
calls.clear(); res = []
def ask(): res.append(c.get("/download", params={"id": "zzzzzzzzzzz", "duration": 4, "start": 12}).status_code)
th = [threading.Thread(target=ask) for _ in range(3)]
[x.start() for x in th]; [x.join() for x in th]
print("concurrent", res, "ytdlp calls", len(calls)); assert res == [200]*3 and len(calls) == 1

# 3. a different start is a different cut
calls.clear(); c.get("/download", params={"id": "abcdefghijk", "duration": 4, "start": 50})
assert len(calls) == 1
# 4. an expired result is cut again
key = main._result_key("abcdefghijk", 99.2, 4); p = main.RESULT_DIR / f"{key}.mp4"
old = time.time() - main.RESULT_TTL_S - 5; os.utime(p, (old, old))
calls.clear(); c.get("/download", params={"id": "abcdefghijk", "duration": 4, "start": 99.2})
assert len(calls) == 1 and p.exists()
print("ALL OK")
