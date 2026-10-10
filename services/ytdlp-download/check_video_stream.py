"""Run with the service requirements and ffmpeg installed:  python check_video_stream.py

VIDEO 644 — a cut of the right size is not yet a video. Render 644 was handed four "ok" bodies of
~16 KB/s (the audio track alone); FastVid's ffprobe then found no video stream in them. The service
now asks ffprobe itself, before the "ok" line and before the result cache. Driven through the real
`/download` endpoint; only yt-dlp is replaced by a stand-in that writes a prepared file. Nothing
touches YouTube.
"""
import glob, logging, os, shutil, subprocess, sys, tempfile, threading
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
import main
from fastapi.testclient import TestClient

FX = Path(tempfile.mkdtemp(prefix="ytdl-check-fixtures-"))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=3",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(FX / "video.mp4")], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                "-c:a", "aac", str(FX / "audio_only.mp4")], check=True)
(FX / "corrupt.mp4").write_bytes(os.urandom(20_000))
(FX / "empty.mp4").write_bytes(b"")
for name in ("video", "audio_only", "corrupt"):
    assert (FX / f"{name}.mp4").stat().st_size >= main.MIN_BYTES, name  # all pass the size floor

# ── the stand-in: the video id names the file yt-dlp "downloaded" ──
BODY = {"vvvvvvvvvvv": "video.mp4", "aaaaaaaaaaa": "audio_only.mp4", "ccccccccccc": "corrupt.mp4", "eeeeeeeeeee": "empty.mp4"}
calls: list = []


class FakeYDL:
    def __init__(self, opts): self.opts = opts
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def download(self, urls):
        video_id = urls[0].split("v=")[1]
        calls.append(video_id)
        tmpl = self.opts.get("outtmpl")
        path = tmpl["default"] if isinstance(tmpl, dict) else tmpl
        shutil.copyfile(FX / BODY[video_id[:11]], path)


main.yt_dlp.YoutubeDL = FakeYDL
main.RESULT_DIR = Path(tempfile.mkdtemp(prefix="ytdl-results-check-"))
main._probe_on_boot = lambda: None

records: list[str] = []


class Keep(logging.Handler):
    def emit(self, record): records.append(record.getMessage())


main.log.addHandler(Keep())
client = TestClient(main.app)
work_dirs = lambda: set(glob.glob(os.path.join(tempfile.gettempdir(), "ytdl-????????????????????????????")))  # noqa: E731
dirs_before = work_dirs()


def ask(video_id: str, start: float = 2):
    records.clear()
    return client.get(f"/download?id={video_id}&duration=4&start={start}")


# 1 — a real video: 200, the bytes themselves, the "ok" line as before, kept under its key
r = ask("vvvvvvvvvvv")
assert r.status_code == 200 and r.content == (FX / "video.mp4").read_bytes(), r.status_code
assert r.headers["content-type"].startswith("video/mp4")
assert any(x.startswith("ok id=vvvvvvvvvvv start=2.00 dur=4.00 bytes=") and " salvage=none " in x for x in records), records
assert main._cached_result(main._result_key("vvvvvvvvvvv", 2, 4)) is not None
assert len(calls) == 1

# 6 — the same ask again is served from the kept result: no second cut, same bytes
r2 = ask("vvvvvvvvvvv")
assert r2.status_code == 200 and r2.content == r.content and len(calls) == 1
assert any("cached=hit" in x for x in records), records

# 2 — audio only: refused with its own reason, logged, NOT kept; the next ask cuts again
r = ask("aaaaaaaaaaa")
assert r.status_code == 502, f"an audio-only body was accepted: HTTP {r.status_code}, {len(r.content)} bytes"
assert r.json()["detail"].startswith("file has no video stream (bytes="), r.json()
assert any(x.startswith("cut refused id=aaaaaaaaaaa") and "picture=none" in x for x in records), records
assert not any(x.startswith("ok id=aaaaaaaaaaa") for x in records), records
assert main._cached_result(main._result_key("aaaaaaaaaaa", 2, 4)) is None
n = len(calls)
r = ask("aaaaaaaaaaa")
assert r.status_code == 502 and len(calls) == n + 1, "a refused body must not answer the next ask"

# 3 — corrupt bytes above the floor: refused as unreadable; an empty file still fails the floor
r = ask("ccccccccccc")
assert r.status_code == 502 and r.json()["detail"].startswith("file is not readable media ("), r.json()
assert any("picture=unreadable" in x for x in records), records
r = ask("eeeeeeeeeee")
assert r.status_code == 502 and r.json()["detail"].startswith("file below floor ("), r.json()

# 4 — ffprobe does not answer: never a success, never kept
real_run = main.subprocess.run
def probe_times_out(args, *a, **kw):
    if args and args[0] == "ffprobe":
        raise subprocess.TimeoutExpired(args, 30)
    return real_run(args, *a, **kw)
main.subprocess.run = probe_times_out
try:
    r = ask("vvvvvvvvvvv", start=9)
finally:
    main.subprocess.run = real_run
assert r.status_code == 502 and r.json()["detail"].startswith("video stream unverified (ffprobe timed out"), r.json()
assert main._cached_result(main._result_key("vvvvvvvvvvv", 9, 4)) is None
def probe_missing(args, *a, **kw):
    if args and args[0] == "ffprobe":
        raise FileNotFoundError("ffprobe")
    return real_run(args, *a, **kw)
main.subprocess.run = probe_missing
try:
    r = ask("vvvvvvvvvvv", start=11)
finally:
    main.subprocess.run = real_run
assert r.status_code == 502 and "ffprobe did not run" in r.json()["detail"], r.json()
# and with ffprobe back, the same cut is made and served
r = ask("vvvvvvvvvvv", start=9)
assert r.status_code == 200

# 5 — the kept results hold only video: every refused ask left nothing behind
kept = sorted(p.name for p in main.RESULT_DIR.glob("*.mp4"))
assert all(name.startswith("vvvvvvvvvvv_") for name in kept), kept
assert len(kept) == 2, kept  # start 2 and start 9

# 7 — three cuts at once, each judged on its own file; no work directory left behind
answers: dict = {}
jobs = [threading.Thread(target=lambda v=v: answers.__setitem__(v, client.get(f"/download?id={v}&duration=4&start=5").status_code))
        for v in ("vvvvvvvvvvv", "aaaaaaaaaaa", "ccccccccccc")]
for j in jobs: j.start()
for j in jobs: j.join()
assert answers == {"vvvvvvvvvvv": 200, "aaaaaaaaaaa": 502, "ccccccccccc": 502}, answers
assert work_dirs() == dirs_before, "a work directory was left behind"

# 8 — the probe itself, on the files
assert main._video_stream(FX / "video.mp4") == ("video", "320x180")
assert main._video_stream(FX / "audio_only.mp4") == ("none", "")
assert main._video_stream(FX / "corrupt.mp4")[0] == "unreadable"
assert main._video_stream(FX / "missing.mp4")[0] == "unreadable"

print("check_video_stream: ok")
