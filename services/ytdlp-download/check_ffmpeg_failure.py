"""Run with the service requirements and ffmpeg installed:  python check_ffmpeg_failure.py

Video 644 — when ffmpeg ends a cut, the service logs WHY (HTTP status, who answered it, which
stream, the proxy route), sanitized, and changes nothing else. Driven through the real
`/download` endpoint, the real `_fetch_window`, real yt-dlp (its FFmpegFD) and real ffmpeg, against
a local TLS server and local proxies. Only the YouTube lookup is replaced: `download()` hands
yt-dlp a prepared video whose streams live on 127.0.0.1. Nothing touches YouTube.
"""
import glob, http.server, logging, os, select, socket, socketserver, ssl, subprocess, sys, tempfile, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
for var in ("no_proxy", "NO_PROXY", "http_proxy", "HTTP_PROXY"):
    os.environ.pop(var, None)  # the proxies under test must be the only ones ffmpeg sees
import main
from fastapi.testclient import TestClient

WORK = tempfile.mkdtemp(prefix="check-ffmpeg-")
SECRET_USER, SECRET_PASS = "userX", "SECRETPASS"

# ── a TLS "googlevideo": 403 on request, or a real video and audio stream ──
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{WORK}/k.pem",
                "-out", f"{WORK}/c.pem", "-days", "1", "-subj", "/CN=localhost"], check=True, capture_output=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=12",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", f"{WORK}/v.mp4"], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
                "-c:a", "aac", f"{WORK}/a.m4a"], check=True)


class Media(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if "code=" in self.path:
            self.send_response(int(self.path.split("code=")[1][:3]))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = open(f"{WORK}/{'v.mp4' if 'itag=398' in self.path else 'a.m4a'}", "rb").read()
        size, first, last = len(body), 0, len(body) - 1
        wanted = self.headers.get("Range", "")  # ffmpeg seeks with byte ranges, as on googlevideo
        if wanted.startswith("bytes="):
            a, _, b = wanted[6:].partition("-")
            first, last = int(a or 0), min(int(b) if b else size - 1, size - 1)
        self.send_response(206 if wanted else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        if wanted:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(last - first + 1))
        self.end_headers()
        try:
            self.wfile.write(body[first:last + 1])
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass  # ffmpeg closes a read it no longer needs

    def log_message(self, *a):
        pass


media = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Media)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(f"{WORK}/c.pem", f"{WORK}/k.pem")
media.socket = ctx.wrap_socket(media.socket, server_side=True)
MEDIA_PORT = media.server_address[1]
threading.Thread(target=media.serve_forever, daemon=True).start()


def proxy(answer: str | None) -> int:
    """An HTTP CONNECT proxy: tunnels when `answer` is None, otherwise refuses the CONNECT with it."""

    class Tunnel(socketserver.BaseRequestHandler):
        def handle(self):
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                data += chunk
            if answer:
                self.request.sendall(f"HTTP/1.1 {answer}\r\nContent-Length: 0\r\n\r\n".encode())
                return
            host, port = data.split(b"\r\n")[0].split()[1].decode().split(":")
            up = socket.create_connection(("127.0.0.1", int(port)))
            self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            while True:
                ready, _, _ = select.select([self.request, up], [], [], 5)
                if not ready:
                    return
                for s in ready:
                    chunk = s.recv(65536)
                    if not chunk:
                        return
                    (up if s is self.request else self.request).sendall(chunk)

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Tunnel)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


TUNNEL, REFUSE_403 = proxy(None), proxy("403 Forbidden")
CLOSED = socket.socket()
CLOSED.bind(("127.0.0.1", 0))
CLOSED_PORT = CLOSED.getsockname()[1]
CLOSED.close()  # a port nothing listens on

# ── the lookup, replaced: yt-dlp gets a prepared video and does everything else itself ──
VIDEO_CODE: list = [None]
CODE_BY_ID: dict = {}  # per video, for cuts that run at the same time


def stream_url(video_id: str, itag: int) -> str:
    wanted = CODE_BY_ID.get(video_id, VIDEO_CODE[0])
    code = f"&code={wanted}" if wanted and itag == 398 else ""
    return (f"https://127.0.0.1:{MEDIA_PORT}/videoplayback?expire=9&ip=203.0.113.9&itag={itag}"
            f"&sparams=expire,ip,itag&sig=AJfQdSswRAIgSECRETSIG{code}")


class LocalYDL(main.yt_dlp.YoutubeDL):
    def download(self, urls):
        video_id = urls[0].split("v=")[1]
        info = {
            "id": video_id, "title": "Local test video", "channel": "Local", "extractor": "youtube",
            "extractor_key": "Youtube", "webpage_url": urls[0], "duration": 12, "_type": "video",
            "formats": [
                {"format_id": "398", "url": stream_url(video_id, 398), "ext": "mp4", "protocol": "https", "height": 720,
                 "width": 1280, "vcodec": "avc1", "acodec": "none", "tbr": 1000},
                {"format_id": "140", "url": stream_url(video_id, 140), "ext": "m4a", "protocol": "https", "vcodec": "none",
                 "acodec": "mp4a.40.2", "tbr": 128},
            ],
        }
        self.process_ie_result(info, download=True)
        return 0


main.yt_dlp.YoutubeDL = LocalYDL

records: list[str] = []


class Keep(logging.Handler):
    def emit(self, record):
        records.append(record.getMessage())


main.log.addHandler(Keep())
client = TestClient(main.app)


def ask(video_id: str):
    records.clear()
    r = client.get(f"/download?id={video_id}&duration=4&start=2")
    return r, [x for x in records if x.startswith("ffmpeg failure")]


def no_secret(texts) -> None:
    for t in texts:
        for bad in (SECRET_USER, SECRET_PASS, "SECRETSIG", "sig=", "203.0.113.9", "127.0.0.1", "videoplayback?"):
            assert bad not in t, (bad, t)


assert main._FFMPEG_CAPTURE_READY, "capture not installed: this yt-dlp has no external.Popen"
captures_before = set(glob.glob(os.path.join(tempfile.gettempdir(), "ytdl-ffmpeg-*")))

# 1 — googlevideo answers 403: logged as the server's 403, code 8, NOT retried, response unchanged
main.PROXY_URL = ""
VIDEO_CODE[0] = 403
r, lines = ask("aaaaaaaa403")
assert r.status_code == 502 and r.json()["detail"] == "ERROR: ffmpeg exited with code 8", r.text
assert len(lines) == 1, lines
assert "attempt=1 stage=data exit=8 http=403 from=server stream=<url other itag=398>" in lines[0], lines[0]
assert "ffmpeg_route=direct(no_proxy)" in lines[0] and "captured=yes" in lines[0], lines[0]
assert "HTTP error 403 Forbidden" in lines[0], lines[0]
assert any("download failed id=aaaaaaaa403" in x and "stage=data" in x for x in records), records
no_secret(records + [r.text])

# 2 — through a proxy that tunnels: the same 403, still the server's, the route says proxy
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{TUNNEL}"
r, lines = ask("aaaaaaaa4t3")
assert r.status_code == 502 and len(lines) == 1, (r.text, lines)
assert "http=403 from=server" in lines[0] and "ffmpeg_route=proxy" in lines[0], lines[0]
no_secret(records + [r.text])

# 3 — the PROXY refuses the CONNECT with 403: same exit 8, but from=proxy
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{REFUSE_403}"
VIDEO_CODE[0] = None
r, lines = ask("aaaaaaapx03")
assert r.status_code == 502 and r.json()["detail"] == "ERROR: ffmpeg exited with code 8", r.text
assert len(lines) == 1 and "exit=8 http=403 from=proxy" in lines[0], lines
no_secret(records + [r.text])

# 4 — the proxy port answers nothing: a network failure, not code 8 — retried once as before,
#     and each attempt is logged on its own
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{CLOSED_PORT}"
r, lines = ask("aaaaaaanet1")
assert r.status_code == 502, r.text
assert len(lines) == 2 and "attempt=1" in lines[0] and "attempt=2" in lines[1], lines
assert all("http=none from=network" in x for x in lines), lines
assert any(x.startswith("retrying id=aaaaaaanet1") for x in records), records
no_secret(records + [r.text])

# 5 — an https:// proxy: ffmpeg ignores it, and the log says the stream went out directly
main.PROXY_URL = f"https://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{REFUSE_403}"
VIDEO_CODE[0] = 404
r, lines = ask("aaaaaahttps")
assert len(lines) == 1 and "http=404 from=server" in lines[0], lines
assert "ffmpeg_route=direct(https_proxy_ignored_by_ffmpeg)" in lines[0], lines[0]
no_secret(records + [r.text])

# 6 — a cut that works: the same bytes back as before, no failure line, no capture file left behind,
#     and the file served is the video (never the capture file)
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{TUNNEL}"
VIDEO_CODE[0] = None
r, lines = ask("aaaaaaaaaok")
assert r.status_code == 200, r.text
assert lines == [], lines
assert r.content[4:8] == b"ftyp", r.content[:16]
dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", "-"],
                     input=r.content, capture_output=True).stdout.decode().strip()
assert 3.0 <= float(dur) <= 5.5, dur
assert any(x.startswith("ok id=aaaaaaaaaok") for x in records), records
no_secret(records)
assert set(glob.glob(os.path.join(tempfile.gettempdir(), "ytdl-ffmpeg-*"))) == captures_before, "capture file left behind"

# 7 — an ffmpeg asked to speak with no capture open on its thread is silenced, never printed
from yt_dlp.downloader import external
leak = tempfile.TemporaryFile()
saved = os.dup(2)
os.dup2(leak.fileno(), 2)
try:
    external.Popen([sys.executable, "-c", "import sys; sys.stderr.write('LEAKED-URL')", "-loglevel", "warning"]).wait()
finally:
    os.dup2(saved, 2)
leak.seek(0)
assert b"LEAKED-URL" not in leak.read(), "uncaptured ffmpeg output reached the service's stderr"

# 8 — the sanitizer on what ffmpeg and yt-dlp really print
sample = (
    "[https @ 0x55aa] HTTP error 403 Forbidden\n"
    "Error opening input file https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&ip=203.0.113.9"
    "&itag=398&sparams=expire,ip,itag&sig=AJfQSECRETSIG&lsig=LSECRET.\n"
    f"[tcp @ 0x1] Connection to tcp://gw.proxyprov.example:823 failed\n"
    f"via http://{SECRET_USER}:{SECRET_PASS}@gw.proxyprov.example:823"
)
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@gw.proxyprov.example:823"
clean = main._sanitize(sample)
for bad in (SECRET_USER, SECRET_PASS, "SECRETSIG", "LSECRET", "203.0.113.9", "gw.proxyprov.example", "0x55aa"):
    assert bad not in clean, (bad, clean)
assert "<url googlevideo itag=398 iplock=yes>" in clean, clean
f = main._ffmpeg_failure(sample)
assert f["status"] == "403" and f["origin"] == "server" and f["stream"] == "<url googlevideo itag=398 iplock=yes>", f
assert main._ffmpeg_failure("[httpproxy @ 0x1] HTTP error 407 Proxy Authentication Required")["origin"] == "proxy"
assert main._ffmpeg_failure("")["origin"] == "unknown"
assert "<url googlevideo itag=18 iplock=no>" in main._sanitize("https://x.googlevideo.com/videoplayback?itag=18&sparams=expire")
# _redact alone leaves a signed stream URL whole — the reason `_sanitize` exists
assert "SECRETSIG" in main._redact(sample)

# 9 — stage: lookup, manifest, stream
assert main._failure_stage({"download_ms": None, "facts": None}, "Sign in to confirm you're not a bot") == "metadata"
assert main._failure_stage({"download_ms": None, "facts": None}, "in _extract_m3u8_formats_and_subtitles") == "manifest"
assert main._failure_stage({"download_ms": 1900, "facts": "format=398+140"}, "ffmpeg exited with code 8") == "data"

# 10 — two cuts at once, one refused and one fine: each failure line is the refused cut's own, read
#      from its own capture — the working cut logs none and still delivers
main.PROXY_URL = f"http://{SECRET_USER}:{SECRET_PASS}@127.0.0.1:{TUNNEL}"
VIDEO_CODE[0] = None
CODE_BY_ID.update({"cccccccc403": 403, "cccccccc404": 404})
records.clear()
answers: dict = {}
jobs = [threading.Thread(target=lambda v=v, s=s: answers.__setitem__(v, client.get(f"/download?id={v}&duration=4&start={s}")))
        for v, s in (("cccccccc403", 1), ("cccccccc404", 1), ("ccccccccc0k", 3), ("ccccccccc0k", 6))]
for j in jobs:
    j.start()
for j in jobs:
    j.join()
failures = [x for x in records if x.startswith("ffmpeg failure")]
assert answers["cccccccc403"].status_code == 502 and answers["cccccccc404"].status_code == 502, answers
assert answers["ccccccccc0k"].status_code == 200, answers["ccccccccc0k"].text
assert len(failures) == 2, failures
assert any("id=cccccccc403" in x and "http=403 from=server" in x and "404" not in x for x in failures), failures
assert any("id=cccccccc404" in x and "http=404 from=server" in x and "403" not in x for x in failures), failures
assert sum(x.startswith("ok id=ccccccccc0k") for x in records) == 2, records
no_secret(records)
assert set(glob.glob(os.path.join(tempfile.gettempdir(), "ytdl-ffmpeg-*"))) == captures_before, "capture file left behind"

print("check_ffmpeg_failure: ok")
