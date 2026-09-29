"""Run with the service requirements installed:  python check_retry.py

Video 614 — a cut that failed for the moment (ffmpeg dropped the stream, a bot check) is asked
again once; one that failed for the video (unavailable, country block, googlevideo's HTTP error
`code 8`) is not. yt-dlp is replaced
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
status, n = ask("aaaaaaaaab4", ["ERROR: ffmpeg exited with code 251", "ERROR: ffmpeg exited with code 251"])
assert (status, n) == (502, 2)
# 5. every attempt tells ffmpeg to reconnect
assert all(o["external_downloader_args"]["ffmpeg_i"][:2] == ["-reconnect", "1"] for o in calls)
# 5b. VIDEO 617 (A) — and to give up on a read after 15 s of silence (microseconds)
for o in calls:
    args = o["external_downloader_args"]["ffmpeg_i"]
    assert args[args.index("-rw_timeout") + 1] == "15000000", args
# 5c. VIDEO 617 (B) — code 8 is googlevideo's HTTP error for this video: asked once, 502 at once
assert ask("aaaaaaaaab8", ["ERROR: ffmpeg exited with code 8", "ok"]) == (502, 1)
assert main._retryable("ERROR: ffmpeg exited with code 8") is False
# other codes that merely start with 8 are not that error; the moment-errors stay retryable
assert main._retryable("ERROR: ffmpeg exited with code 87") is True
assert main._retryable("ERROR: ffmpeg exited with code 146") is True
assert main._retryable("ERROR: ffmpeg exited with code 251") is True
assert main._retryable("ERROR: [youtube] x: Sign in to confirm you're not a bot.") is True
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
assert ask("aaaaaaaaab7", ["ERROR: ffmpeg exited with code 251", "ERROR: ffmpeg exited with code 251"]) == (502, 2)
t = seen[-1]
assert t["attempt"] == 2 and isinstance(t["download_ms"], int), t
main._fetch_window = real_fetch

# 7. VIDEO 617 (C) — yt-dlp's warnings reach the log, each once, at most five, never a credential
assert all(o["no_warnings"] is False and isinstance(o["logger"], main._YdlWarnings) for o in calls)
import logging
records: list = []
class Keep(logging.Handler):
    def emit(self, record): records.append(record.getMessage())
main.log.addHandler(Keep())
main.PROXY_URL = "http://proxyuser:proxypass@proxy.example:8080"
w = main._YdlWarnings("aaaaaaaaab9")
w.warning("[youtube] aaaaaaaaab9: Some web client https formats have been skipped as they are missing a url")
w.warning("[youtube] aaaaaaaaab9: Some web client https formats have been skipped as they are missing a url")
w.warning("could not reach http://proxyuser:proxypass@proxy.example:8080 in time")
w.warning("retrying via https://someone:s3cret@other.example/path")
w.debug("[download] 42%"); w.info("[info] noise"); w.error("ERROR: already raised")
for i in range(10):
    w.warning(f"warning number {i}")
assert len(records) == 5, records
assert records[0] == "yt-dlp warning id=aaaaaaaaab9: [youtube] aaaaaaaaab9: Some web client https formats have been skipped as they are missing a url", records
assert records[1] == "yt-dlp warning id=aaaaaaaaab9: could not reach <proxy> in time", records
assert records[2] == "yt-dlp warning id=aaaaaaaaab9: retrying via https://<credentials>@other.example/path", records
joined = " ".join(records)
assert "proxypass" not in joined and "proxyuser" not in joined and "s3cret" not in joined, records
assert "42%" not in joined and "noise" not in joined and "already raised" not in joined, records
assert all(len(r) < 400 for r in records)

# Video 618 — the ok and failed lines say which video and which stream: title, channel, format,
# protocol and yt-dlp's note (which names the client, and "MISSING POT"). Never a URL.
facts = main._format_facts({
    "title": 'Wildly Successful "Brands" | E!', "channel": "E! Entertainment",
    "url": "https://rr1.googlevideo.com/videoplayback?ip=1.2.3.4&sig=SECRET",
    "requested_formats": [
        {"format_id": "136", "protocol": "https", "format_note": "720p, visionos", "url": "https://x/SECRET"},
        {"format_id": "140", "protocol": "https", "format_note": "medium, visionos"},
    ],
})
assert facts == ('title="Wildly Successful \'Brands\' | E!" channel="E! Entertainment" format=136+140 '
                 'protocol=https+https note="720p, visionos + medium, visionos"'), facts
assert "SECRET" not in facts and "googlevideo" not in facts, facts
single = main._format_facts({"title": "t", "uploader": "u", "format_id": "96", "protocol": "m3u8_native",
                             "format_note": "1080p, web MISSING POT"})
assert single == 't="t" channel="u" format=96 protocol=m3u8_native note="1080p, web MISSING POT"'.replace('t="t"', 'title="t"'), single
assert main._format_facts({}) == 'title="" channel="" format= protocol= note=""'
records.clear()
ask("aaaaaaaaac1", ["ok"])
assert any(r.startswith("ok id=aaaaaaaaac1") and 'title="" channel=""' in r for r in records), records
records.clear()
ask("aaaaaaaaac2", ["ERROR: ffmpeg exited with code 8"])
assert any(r.startswith("download failed id=aaaaaaaaac2") and "format=" in r for r in records), records
records.clear()
ask("aaaaaaaaac3", ["lookup:ERROR: Video unavailable", "lookup:ERROR: Video unavailable"])
assert any(r.startswith("download failed id=aaaaaaaaac3") and "facts=none" in r for r in records), records
print("check_retry: ok")
