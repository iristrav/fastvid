"""
THE YOUTUBE DOWNLOAD SERVICE — route A, in the pipeline's own words.

FastVid's `downloadYouTubeCCClip` (server/videoPipeline.ts) tries this service FIRST and falls
through to RapidAPI when it does not answer usefully. What it sends, and what it will accept back,
is a small contract this file implements exactly:

    GET  {SERVICE}/download?id=<videoId>&duration=<sec>&start=<sec>
    Authorization: Bearer <token>          omitted by FastVid when YOUTUBE_CC_DL_TOKEN is unset
    ->   200, video/mp4, THE ALREADY-TRIMMED SEGMENT
         larger than 10_000 bytes, no larger than 80 MB, within 180 s

── The one that bites ──────────────────────────────────────────────────────────────────────────

The segment must already be cut. FastVid renames the response straight to the beat's clip file and
does not trim again — hand it the whole video and the whole video lands in the montage. That is
also the entire advantage over the RapidAPI route, which fetches the complete source and trims
locally: render 528 lost three usable WWII clips to 90-second timeouts doing exactly that.

── The problem this service does NOT solve by existing ─────────────────────────────────────────

YouTube blocks datacentre IPs far more aggressively than home connections, and Railway is a
datacentre. The same yt-dlp call that works on a laptop can answer "Sign in to confirm you're not
a bot" here. `PROXY_URL` is the way out — a residential proxy — and the service runs without one so
the cheap configuration can be tried first. `/health` reports whether a proxy is configured, so a
render that starts failing can be told apart from one that never had a chance.

Nothing here decides anything about a video. It fetches bytes, cut to the requested window.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ytdlp-download")

# ── The client's limits, mirrored here so this service never wastes a transfer FastVid
#    would only discard. Kept as constants with the same numbers rather than as env knobs:
#    two ends of a contract that can drift apart independently is how the contract stops
#    being one. `services/ytdlp-download/README.md` names the client-side source of each.
MIN_BYTES = 10_000
MAX_BYTES = 80 * 1024 * 1024
# youtubeMinFormatHeight() in server/sourcingPolicy.ts — 480 by default.
MIN_HEIGHT = int(os.environ.get("MIN_FORMAT_HEIGHT", "480"))
# RONDE 648 — the resolution the service PREFERS. The format filter below only sets a floor, and
# yt-dlp's default order then takes the largest stream left: run against yt-dlp 2026.08.19 with a
# 144p–2160p ladder it picks 2160p. Every byte of that goes through the paid residential proxy
# (DataImpulse ran out at 07:53 on 2026-09-24) for a clip scaled into 1920x1080 as B-roll. `res:N`
# prefers the largest stream at or below N and, when there is none, the smallest above it.
MAX_HEIGHT = int(os.environ.get("MAX_FORMAT_HEIGHT", "720"))

SERVICE_TOKEN = os.environ.get("SERVICE_TOKEN", "").strip()
PROXY_URL = os.environ.get("PROXY_URL", "").strip()
# VIDEO 617 (A) — seconds without a byte before ffmpeg gives up on a read. See `_ydl_options`.
FFMPEG_IO_TIMEOUT_S = int(os.environ.get("FFMPEG_IO_TIMEOUT_S", "15"))
# A cookies.txt from a signed-in browser. Optional, and a second answer to the same IP-reputation
# problem PROXY_URL addresses — see the README on which to reach for.
COOKIES_FILE = os.environ.get("COOKIES_FILE", "").strip()
# WHICH VIDEO THE EGRESS PROBE ASKS ABOUT.
#
# "Me at the zoo", uploaded April 2005 and the oldest video on the platform. Chosen because the
# probe must not fail for a reason that is about the VIDEO — a removed or private one would answer
# "unavailable" and read as a healthy egress. Overridable so a future removal is a configuration
# change rather than a deploy.
PROBE_VIDEO_ID = os.environ.get("EGRESS_PROBE_VIDEO_ID", "jNQXAC9IVRw").strip()

app = FastAPI(title="FastVid YouTube download service")


# ── RONDE 642 — A FINISHED CUT IS KEPT FOR THE CALLER WHO ASKS AGAIN ─────────────────────────────
#
# Render 603, this service's own log against its own access log:
#
#     14:34:58  GET /download?id=yOPuuSeBfyo…   → 499 after 14.9 s   (the client hung up)
#     14:35:28  INFO ok id=yOPuuSeBfyo start=4.50 dur=4.00 bytes=1592852
#
# Thirteen of seventeen requests ended that way. The cut takes ~30 s through the proxy; the render
# could wait 12–22 s. Every file was made, finished seconds after nobody was listening, and deleted
# by the cleanup task — and the render then asked for the SAME id and start again (OwwcdkV30U8
# five times, yOPuuSeBfyo four), paying the full 30 s each time and hanging up each time.
#
# So a finished cut is kept for a while under (id, start, duration), and a request that is already
# being worked on is waited for instead of started twice. The second ask is then answered from
# disk in milliseconds. Nothing about what is cut, or how, changes.
RESULT_DIR = Path(tempfile.gettempdir()) / "ytdl-results"
RESULT_TTL_S = 30 * 60
RESULT_CACHE_CEILING_BYTES = int(os.environ.get("RESULT_CACHE_MB", "1024")) * 1024 * 1024
# How long a second caller waits for the first one's cut. Under FastVid's 180 s transfer ceiling.
INFLIGHT_WAIT_S = 150

_inflight: dict[str, threading.Event] = {}
_inflight_lock = threading.Lock()


def _result_key(video_id: str, start: float, duration: float) -> str:
    safe = "".join(c for c in video_id if c.isalnum() or c in "-_")
    return f"{safe}_{start:.2f}_{duration:.2f}"


def _cached_result(key: str) -> Path | None:
    path = RESULT_DIR / f"{key}.mp4"
    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return None
    if age > RESULT_TTL_S:
        path.unlink(missing_ok=True)
        return None
    return path


def _prune_results() -> None:
    """Expired files go; then the oldest, until the directory is under its ceiling."""
    try:
        files = sorted(RESULT_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    except FileNotFoundError:
        return
    now = time.time()
    kept: list[Path] = []
    for f in files:
        try:
            if now - f.stat().st_mtime > RESULT_TTL_S:
                f.unlink(missing_ok=True)
            else:
                kept.append(f)
        except FileNotFoundError:
            continue
    total = sum(f.stat().st_size for f in kept if f.exists())
    for f in kept:
        if total <= RESULT_CACHE_CEILING_BYTES:
            break
        try:
            size = f.stat().st_size
            f.unlink(missing_ok=True)
            total -= size
        except FileNotFoundError:
            continue


def _store_result(key: str, produced: Path) -> Path:
    """Move a finished cut under its key. Atomic: a reader sees the whole file or none."""
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    final = RESULT_DIR / f"{key}.mp4"
    staging = RESULT_DIR / f".{key}.{uuid.uuid4().hex}.part"
    shutil.copyfile(produced, staging)
    os.replace(staging, final)
    _prune_results()
    return final


def _require_token(authorization: str | None) -> None:
    """
    Bearer auth, only when a token is configured.

    A token-less service is deliberately supported: FastVid omits the header entirely when
    YOUTUBE_CC_DL_TOKEN is unset, and refusing those requests would make an unconfigured pair fail
    in a way that looks like YouTube blocking us rather than like a missing secret.
    """
    if not SERVICE_TOKEN:
        return
    expected = f"Bearer {SERVICE_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="bad or missing bearer token")


def _ydl_options(out_path: Path, start: float, end: float) -> dict:
    opts: dict = {
        # Smallest adequate file, not the sharpest: the clip is scaled into a 1920x1080 frame as
        # B-roll behind narration, where the difference between 480p and 720p is far less visible
        # than the difference between having the shot and not having it. RONDE 27 made the same
        # call on the RapidAPI route after a half-gigabyte 720p file cost a render three clips.
        #
        # VIDEO 619 — never an HLS stream (`m3u8`). ffmpeg cuts a window out of one by fetching its
        # segments one request at a time through the proxy: `Fgr4w50Rwus` (format 609, m3u8_native)
        # took 262-373 s for four seconds while three beats waited 35-70 s each and gave up. A video
        # that offers only HLS now fails at once ("Requested format is not available") instead.
        "format": (
            f"bv*[height>={MIN_HEIGHT}][ext=mp4][protocol!*=m3u8]+ba[ext=m4a][protocol!*=m3u8]"
            "/b[ext=mp4][protocol!*=m3u8]/b[protocol!*=m3u8]"
        ),
        # The filter above is a floor, not a choice — without this the largest stream wins.
        "format_sort": [f"res:{MAX_HEIGHT}"],
        # THE POINT OF THIS SERVICE. Only the requested window is fetched, so a 3.5-second beat
        # costs a few megabytes instead of the whole source video.
        "download_ranges": yt_dlp.utils.download_range_func(None, [(start, end)]),
        # Without this the cut lands wherever the nearest preceding keyframe is, which shows up as
        # a frozen or black opening frame on a clip that is only a few seconds long to begin with.
        "force_keyframes_at_cuts": True,
        "outtmpl": str(out_path),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        # A single retry: FastVid has its own 180-second ceiling and its own fallback route, so
        # long retry ladders here only spend that budget without adding an outcome.
        "retries": 1,
        "socket_timeout": 30,
        # WHICH JAVASCRIPT RUNTIMES MAY ANSWER YOUTUBE'S CHALLENGE.
        #
        # yt-dlp's default for this parameter is `{'deno': {}}` — deno alone — and this image had
        # no deno, no node, no quickjs and no bun. So the challenge could not be solved here under
        # any circumstances, and that failure looks exactly like YouTube refusing us.
        #
        # Both are named: node is what the image installs, deno is kept because it is the higher
        # priority runtime and yt-dlp picks the highest one that is enabled AND available. An
        # image that later gains deno therefore uses it without touching this file.
        #
        # Enabling a runtime does not fetch anything: `yt-dlp-ejs` in requirements.txt supplies
        # the components locally, which is why `remote_components` stays off.
        "js_runtimes": {"deno": {}, "node": {}},
        # VIDEO 614 — ffmpeg reads the range straight from googlevideo, through the proxy, and a
        # dropped connection ended the cut: `ffmpeg exited with code 251` (and 8, 187) on about half
        # of render 614's fresh downloads, the same ids succeeding a minute later. Told to reconnect,
        # ffmpeg resumes the stream instead of giving up on the first reset.
        #
        # VIDEO 617 (A) — and a stream that goes SILENT ends. ffmpeg's I/O timeout defaults to 0,
        # "never": cuts sat on a dead connection for 104–190 s before `code 251`, one for 30 minutes,
        # while FastVid's window for the beat ran out. After FFMPEG_IO_TIMEOUT_S without a byte the
        # read fails and the reconnect above takes over; a stream that stays dead fails in seconds.
        "external_downloader_args": {
            "ffmpeg_i": [
                "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4",
                "-rw_timeout", str(FFMPEG_IO_TIMEOUT_S * 1_000_000),
                # VIDEO 644 — after yt-dlp's own `-loglevel quiet`, so ffmpeg says why it stopped; it
                # says it into the cut's own capture file only (see `_install_ffmpeg_stderr_capture`).
                *(["-loglevel", "warning"] if _FFMPEG_CAPTURE_READY else []),
            ],
        },
    }
    if PROXY_URL:
        opts["proxy"] = PROXY_URL
    if COOKIES_FILE and Path(COOKIES_FILE).is_file():
        opts["cookiefile"] = COOKIES_FILE
    return opts


"""
AN OVERSIZED BODY IS A FAILED CUT, NOT A HEAVY CLIP.

This service asks yt-dlp for a RANGE, so a correct answer to a three-second beat is a few
megabytes. A body over the ceiling therefore does not mean "this footage is too big to use" — it
means the range did not bind and the whole source came down instead. The footage is fine. Only
the window is wrong, and ffmpeg is already installed on this machine to force keyframes at cuts.

── Why refusing it outright was the wrong answer ───────────────────────────────────────────────

The check runs AFTER the download. Every byte is already spent by the time the size is known, so
refusing recovers nothing that was at stake — it only declines to send on what was already paid
for, and hands the client a failure indistinguishable from YouTube blocking the fetch.

Render 575 is what that costs, on another provider against the same ceiling: one 92 216 473-byte
Pixabay asset, 111 identical refusals in 164 seconds — about one every second and a half, each
one re-fetching a file whose size was never going to change — while the beat it was for ran out
of time and the export gate then refused the scene for having no usable footage.

── The two things this deliberately does NOT do ────────────────────────────────────────────────

It does not raise the ceiling. `downloadYouTubeCCClip` renames this response straight to the
beat's clip file and does not trim again, so a whole video answered at 200 is a whole video in the
montage — the failure this file's header calls "the one that bites". The ceiling is still checked,
still at 80 MB, and still refuses; it is now checked against the CUT file rather than the raw one.

It does not re-encode a clip whose window is already correct. A file at the requested length that
is still over the ceiling is genuinely heavy footage, and shrinking it is a quality decision this
service has no business making on the client's behalf. That case is refused exactly as before, and
the refusal says which case it was.

── Why the probe, rather than cutting whatever arrives ─────────────────────────────────────────

Cutting `[start, start+duration]` out of a file that is ALREADY that window would take the wrong
seconds — the window's own offset, applied twice. So the file's real duration decides: longer than
asked by more than the margin means it contains more than the window, and only then is it cut.
"""

_SALVAGE_MARGIN_SEC = 2.0


def _probe_duration(path: Path) -> float | None:
    """Seconds of media in the file, or None when ffprobe cannot say. Never raises."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
        seconds = float(out)
        return seconds if seconds > 0 else None
    except Exception:  # noqa: BLE001 - an unreadable file is an answer, not an outage
        return None


def _cut_window(src: Path, dst: Path, start: float, duration: float) -> bool:
    """
    Cut [start, start+duration] out of src.

    `-ss` BEFORE `-i` so ffmpeg seeks to the window and decodes only that — cutting four seconds
    out of a forty-minute file costs about what cutting four seconds always costs. Re-encoded
    rather than stream-copied because a copy lands on the preceding keyframe, which is the frozen
    opening frame `force_keyframes_at_cuts` exists to prevent on the yt-dlp side.
    """
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", f"{start:.3f}",
                "-i", str(src),
                "-t", f"{duration:.3f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac",
                "-movflags", "+faststart",
                str(dst),
            ],
            capture_output=True, timeout=120, check=True,
        )
        return dst.is_file() and dst.stat().st_size > 0
    except Exception:  # noqa: BLE001 - a failed cut falls through to the ceiling refusal
        return False


def _salvage_oversized(
    produced: Path, work: Path, start: float, duration: float, size: int
) -> tuple[Path, int, str]:
    """
    Try to turn an over-ceiling body into the window that was asked for.

    Returns the file to answer with, its size, and WHICH CASE THIS WAS — the third value is the
    point: every outcome here is named and logged, so a render that keeps failing on size can say
    whether the cut was never attempted, attempted and failed, or never applicable.
    """
    probed = _probe_duration(produced)
    if probed is None:
        log.warning("over ceiling and unreadable: bytes=%d wanted=%.2fs", size, duration)
        return produced, size, "unprobed"
    if probed <= duration + _SALVAGE_MARGIN_SEC:
        # The window is right; the file is simply heavy. Not this service's call to re-encode.
        log.warning("over ceiling at the requested length: bytes=%d probed=%.1fs", size, probed)
        return produced, size, "already_cut"
    cut = work / f"{uuid.uuid4().hex}-cut.mp4"
    if not _cut_window(produced, cut, start, duration):
        log.warning("over ceiling and the cut failed: bytes=%d probed=%.1fs", size, probed)
        return produced, size, "cut_failed"
    cut_size = cut.stat().st_size
    log.info(
        "salvaged an untrimmed body: bytes=%d->%d probed=%.1fs wanted=%.2fs start=%.2f",
        size, cut_size, probed, duration, start,
    )
    return cut, cut_size, "salvaged"


@app.get("/health")
def health() -> JSONResponse:
    """
    Enough to tell a service that cannot work from one that is merely idle.

    Reports PRESENCE, never a value: a proxy URL carries credentials and an internal hostname, and
    neither belongs in a health response any more than in a log line.
    """
    return JSONResponse(
        {
            "ok": True,
            "ytdlp": yt_dlp.version.__version__,
            "ffmpeg": bool(shutil.which("ffmpeg")),
            "auth": "required" if SERVICE_TOKEN else "open",
            "proxy": bool(PROXY_URL),
            # VIDEO 644 — the route the STREAM takes, which is not the metadata's when the proxy is
            # not `http://` (see `_ffmpeg_proxy_route`). A scheme, never a host.
            "ffmpegRoute": _ffmpeg_proxy_route(),
            "ffmpegErrorCapture": _FFMPEG_CAPTURE_READY,
            "cookies": bool(COOKIES_FILE and Path(COOKIES_FILE).is_file()),
            "minHeight": MIN_HEIGHT,
            # Whether the LAST probe got through, not whether a proxy is configured. Null until
            # one has run. See /health/egress.
            "egress": _last_egress,
        }
    )


"""
CONFIGURED IS NOT THE SAME AS WORKING, AND ONLY ONE OF THEM MATTERS.

`/health` has always reported `proxy: true|false` — whether the variable is set. Render 581 shows
what that is worth: the proxy was configured, the service was up, `/health` was green, and every
single fetch came back

    {"detail":"ERROR: [youtube] ynJoy1OCeVQ: Sign in to confirm you're not a bot…"}

2609 candidates, 0 bytes. A service that cannot reach YouTube reported itself as healthy for the
entire render, and the client's preflight repeated it: `AVAILABLE youtube_download_primary`.

── What this probe is ──────────────────────────────────────────────────────────────────────────

One metadata call — `download=False`, no bytes, no file — through THE SAME options builder the
real route uses, so it exercises the proxy, the JS runtime and the cookies exactly as a download
would. It answers the only question that matters: does this machine's network identity get through?

── What it deliberately is not ─────────────────────────────────────────────────────────────────

Not on `/health`. A platform probes that endpoint every few seconds and this one costs a real
request to YouTube; running it there would turn a health check into rate-limit pressure and make
the thing it measures worse. It runs once at boot, and on demand at `/health/egress`.

Never fatal. A service that cannot reach YouTube today may reach it in an hour, and refusing to
start would remove the endpoint that says so.
"""

_last_egress: dict[str, object] | None = None


def _classify_probe_error(message: str) -> str:
    """
    The same vocabulary `classifyYoutubeServiceRefusal` uses on the client, so one word means one
    thing on both sides of the contract. Kept deliberately small: this names the cases an operator
    acts on differently, and everything else is `other` with the raw line beside it.
    """
    text = (message or "").lower()
    if "sign in to confirm" in text or "not a bot" in text or "confirm you're not" in text:
        return "bot_check"
    if "too many requests" in text or "429" in text or "rate" in text and "limit" in text:
        return "rate_limited"
    if "proxy" in text or "tunnel" in text or "connection reset" in text or "connection refused" in text:
        return "proxy"
    if "timed out" in text or "timeout" in text:
        return "timeout"
    if "unavailable" in text or "removed" in text or "private" in text:
        return "video_unavailable"
    return "other"


# The download-only options. A metadata call must not inherit them or it can fail for reasons that
# have nothing to do with egress — and then report a working proxy as blocked.
PROBE_DROPS = ("format", "download_ranges", "force_keyframes_at_cuts", "outtmpl", "merge_output_format")


def _probe_options() -> dict:
    """
    The probe's yt-dlp options, built by the same builder a real download uses so that the proxy,
    the cookies and the JS runtimes under test are the ones actually in service.

    Split out so it can be CALLED in a test rather than read as text. The first version of this
    probe passed no arguments to `_ydl_options`, which needs three; the contract test asserted the
    string "_ydl_options()" was present, saw it, and passed — while every call to the endpoint
    raised TypeError and returned 500. A test that reads a call cannot tell whether it can be made.

    The three arguments belong to a download and are all discarded below; they are supplied only
    because the shared builder requires them.
    """
    opts = dict(_ydl_options(Path(tempfile.gettempdir()) / "egress-probe.mp4", 0.0, 1.0))
    opts.update({"skip_download": True, "quiet": True, "no_warnings": True, "socket_timeout": 20})
    for key in PROBE_DROPS:
        opts.pop(key, None)
    return opts


def _runtime_facts(ydl: yt_dlp.YoutubeDL) -> dict[str, object]:
    """
    WHICH JS RUNTIME YT-DLP CHOSE, AND WHICH CLIENTS THAT LEAVES IT.

    ── Why this is on the egress answer at all ─────────────────────────────────────────────────

    A deploy that fixes the runtime and a deploy that silently did not both come back as
    `bot_check`, and an operator cannot tell them apart. The image shipped node 20 against yt-dlp's
    floor of 22 for weeks on exactly that ambiguity: nothing reported which runtime was in use, so
    "installed" and "accepted" were never distinguishable from outside.

    ── Why it asks yt-dlp instead of the shell ─────────────────────────────────────────────────

    Running `node --version` here would report what PATH resolves, which is NOT necessarily what
    yt-dlp uses: `utils/_jsruntime.py` `_find_exe` looks in Python's scripts directory first and
    only then falls back to PATH. On a machine with node 22 first on PATH and a node 20 in
    /usr/local/bin, the shell says 22 and yt-dlp uses 20. Reporting the shell's answer would
    produce a green line over a broken runtime — the precise failure this field exists to catch.

    So both values come from the YoutubeDL instance that just ran the probe: `_js_runtimes` is the
    same source yt-dlp's own "JS runtimes:" debug line reads, and the client list is asked of the
    extractor, offline — `_get_requested_clients` makes no network request.

    Never raises, and never fails the probe: these are diagnostics about the probe, and an
    unreadable diagnostic must not turn a working egress into a failed one. Internals of another
    package, reached deliberately and defensively; a yt-dlp release that moves them costs this
    field a `null`, not the service an error.
    """
    facts: dict[str, object] = {"jsRuntime": None, "jsRuntimeSupported": None, "playerClients": None}
    try:
        for runtime in (getattr(ydl, "_js_runtimes", None) or {}).values():
            info = getattr(runtime, "info", None)
            if info is None:
                continue
            # The first one yt-dlp would actually use: providers are tried in priority order and a
            # supported one ends the search. An unsupported one is still worth naming — that is
            # the whole point — so it is only kept while nothing better has been seen.
            if facts["jsRuntime"] is None or (info.supported and not facts["jsRuntimeSupported"]):
                facts["jsRuntime"] = f"{info.name}-{info.version}"
                facts["jsRuntimeSupported"] = bool(info.supported)
    except Exception:  # noqa: BLE001 — a diagnostic that cannot be read is a null, not an outage
        pass
    try:
        ie = ydl.get_info_extractor("Youtube")
        ie.initialize()
        facts["playerClients"] = list(
            ie._get_requested_clients(f"https://www.youtube.com/watch?v={PROBE_VIDEO_ID}", {}, False)
        )
    except Exception:  # noqa: BLE001
        pass
    return facts


def _probe_egress() -> dict[str, object]:
    """Ask YouTube for one video's metadata and report whether the answer got through."""
    global _last_egress
    result: dict[str, object]
    # Bound BEFORE the try. The handler below reads this, and `_probe_options` can raise — leaving
    # it assigned inside would turn a setup failure into a NameError in the very handler written to
    # make sure a setup failure still comes back as an answer.
    facts: dict[str, object] = {"jsRuntime": None, "jsRuntimeSupported": None, "playerClients": None}
    try:
        # Built INSIDE the try. `_probe_options` reads the environment and goes through the shared
        # builder, so it can raise — and a probe whose own setup throws must still come back as an
        # answer. Leaving this outside turned a wrong call into a 500 on the health endpoint,
        # which reads to a caller exactly like a service that is down.
        opts = _probe_options()
        # Read BEFORE the extraction, so the facts survive a failing one: a probe that fails is
        # exactly when an operator needs to know which runtime and clients were in play.
        with yt_dlp.YoutubeDL(opts) as ydl:
            facts = _runtime_facts(ydl)
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={PROBE_VIDEO_ID}", download=False)
        result = {
            "ok": True,
            "reason": None,
            "detail": None,
            "probeVideo": PROBE_VIDEO_ID,
            "title": (info or {}).get("title"),
            "proxyConfigured": bool(PROXY_URL),
            **facts,
        }
    except Exception as err:  # noqa: BLE001 — the probe reports every failure, it never raises
        message = str(err)
        result = {
            "ok": False,
            "reason": _classify_probe_error(message),
            # Truncated, and it is yt-dlp's own text: it carries a video id and a URL, never a
            # credential. PROXY_URL is not interpolated into it and is never printed.
            "detail": message[:200],
            "probeVideo": PROBE_VIDEO_ID,
            "title": None,
            "proxyConfigured": bool(PROXY_URL),
            # THE REASON THESE ARE HERE. `bot_check` on a supported runtime with ['visionos','web']
            # and `bot_check` on a deploy that never took are the same word and two different
            # problems; without these fields the second reads as the first.
            **facts,
        }
    _last_egress = result
    return result


@app.get("/health/egress")
def health_egress() -> JSONResponse:
    """
    A live answer to 'can this machine actually fetch from YouTube right now?'.

    ── RONDE 258: the status code says it too ──────────────────────────────────────────────────

    This answered 200 whether the probe passed or failed, with the verdict in the body. The
    deployment log shows what that costs:

        13:55:48  ERROR: [youtube] …: Sign in to confirm you're not a bot.
        13:55:48  INFO:  100.64.0.4:56122 - "GET /health/egress HTTP/1.1" 200 OK

    A refusal and a 200 OK on the same second. Anything watching by status code — a dashboard, an
    alert, a person skimming — reads a healthy service while YouTube is holding the door shut.

    503 is the honest answer: this endpoint exists to say whether the machine can do the one job it
    is deployed for, and right then it cannot.

    THIS IS NOT THE LIVENESS ENDPOINT. `/health` above reports that the process is up, yt-dlp is
    installed and ffmpeg is present, and it still answers 200 — that is the one an orchestrator
    should be pointed at. A container must not be restarted because YouTube is rate-limiting it;
    restarting changes nothing about the address it comes from.

    The body is unchanged, so a client that reads `ok` rather than the status keeps working. The
    pipeline's own probe reads the body for exactly that reason.
    """
    result = _probe_egress()
    return JSONResponse(result, status_code=200 if result.get("ok") else 503)


@app.on_event("startup")
def _probe_on_boot() -> None:
    """
    Say it once, at boot, where an operator reading a deploy log will see it.

    Wrapped because a probe that throws must never stop the service from starting: the endpoint
    above is how the question gets asked again, and it has to exist to be asked.
    """
    try:
        result = _probe_egress()
    except Exception as err:  # noqa: BLE001
        logging.warning("[Egress] probe could not run at boot: %s", str(err)[:200])
        return
    # Said on its own line and on every boot, healthy or not. A runtime below yt-dlp's floor is
    # silently downgraded to the JS-less client set, and that is invisible in every other signal
    # this service emits — see `_runtime_facts`.
    logging.info(
        "[Runtime] js=%s supported=%s clients=%s ffmpeg_route=%s ffmpeg_error_capture=%s",
        result.get("jsRuntime"),
        result.get("jsRuntimeSupported"),
        result.get("playerClients"),
        _ffmpeg_proxy_route(),
        _FFMPEG_CAPTURE_READY,
    )
    if result.get("jsRuntimeSupported") is False:
        logging.error(
            "[Runtime] yt-dlp has REJECTED this image's JavaScript runtime (%s). It has fallen "
            "back to the JS-less client set (%s), so every client needing the JS player is "
            "unreachable regardless of the network. The Dockerfile pins a supported one — this "
            "means the build did not take.",
            result.get("jsRuntime"),
            result.get("playerClients"),
        )
    if result.get("ok"):
        logging.info(
            "[Egress] YouTube is reachable from this machine (proxy %s)",
            "configured" if PROXY_URL else "NOT configured",
        )
        return
    logging.error(
        "[Egress] YouTube is NOT reachable from this machine: %s — proxy %s. "
        "Every download will fail until this changes; the client will read it as a timeout.",
        result.get("reason"),
        "configured" if PROXY_URL else "NOT configured",
    )


@app.get("/download")
def download(
    id: str = Query(..., min_length=5, max_length=32, description="YouTube video id"),
    duration: float = Query(..., gt=0, le=60, description="seconds of footage wanted"),
    start: float = Query(0, ge=0, description="offset into the source"),
    authorization: str | None = Header(default=None),
) -> FileResponse:
    _require_token(authorization)

    key = _result_key(id, start, duration)
    hit = _cached_result(key)
    if hit is None:
        with _inflight_lock:
            running = _inflight.get(key)
            if running is None:
                _inflight[key] = threading.Event()
        if running is not None:
            # Someone is already cutting exactly this. Their result is ours; starting a second
            # yt-dlp run for it is the waste render 603 paid four and five times over.
            running.wait(timeout=INFLIGHT_WAIT_S)
            hit = _cached_result(key)
            if hit is None:
                # The first cut failed or is still going. Asking again is what the caller did
                # before this existed, so that is what happens — with its own in-flight marker.
                with _inflight_lock:
                    _inflight.setdefault(key, threading.Event())
    if hit is not None:
        log.info("ok id=%s start=%.2f dur=%.2f bytes=%d cached=hit", id, start, duration, hit.stat().st_size)
        return FileResponse(hit, media_type="video/mp4", filename=f"{id}.mp4")
    try:
        return _download_and_cut(id, start, duration, key)
    finally:
        with _inflight_lock:
            done = _inflight.pop(key, None)
        if done is not None:
            done.set()


# VIDEO 614 — the failures that are about the moment, not the video.
#
# `ffmpeg exited with code …` is a stream that dropped mid-cut; `bot_check` is the proxy handing out
# an address YouTube distrusted. Both came back fine on the next attempt in render 614's own log
# (0fIJzO7EIYI, pvGoGXpUj58, fO16eDq9vPw). "Video unavailable", a country block or a removed video
# will say the same thing twice, so those are not asked again.
_RETRYABLE = ("ffmpeg exited with code", "confirm you", "not a bot", "timed out", "connection reset")
_ATTEMPTS = 2

# VIDEO 617 (B) — ffmpeg's exit status is its error code's low byte, and every HTTP error status
# (AVERROR_HTTP_*, 4xx or 5xx) ends in 0xF8, so `code 8` means googlevideo answered the stream with
# an HTTP error. It is not the moment: `lq12NIRM7Ug` failed with it 8 times and `eCpP1uSwU-8` 7
# times across four hours and three start points, while RapidAPI fetched `lq12` fine. Asking again
# only spends the beat's window before FastVid's own fallback gets it.
_NOT_RETRYABLE = re.compile(r"ffmpeg exited with code 8\b")


def _retryable(message: str) -> bool:
    text = message.lower()
    if _NOT_RETRYABLE.search(text):
        return False
    return any(marker in text for marker in _RETRYABLE)


class _YdlWarnings:
    """VIDEO 617 (C) — yt-dlp's own warnings, logged, where `no_warnings` used to drop them.

    Why googlevideo answers `code 8` for some videos (a PO token a client needs, a format it
    withheld) is something yt-dlp says in a warning, and this service switched warnings off. They are
    logged once each per request, at most `_MAX` of them, with any credential removed. Progress and
    debug output stay silent; errors already reach the log through the `DownloadError` they raise.
    """

    _MAX = 5

    def __init__(self, video_id: str):
        self.video_id = video_id
        self.seen: list[str] = []

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        text = _redact(str(msg)).strip().replace("\n", " ")[:300]
        if not text or text in self.seen or len(self.seen) >= self._MAX:
            return
        self.seen.append(text)
        log.warning("yt-dlp warning id=%s: %s", self.video_id, text)


def _redact(text: str) -> str:
    """No proxy address and no user:password in a URL ever reaches the log."""
    if PROXY_URL:
        text = text.replace(PROXY_URL, "<proxy>")
    return re.sub(r"(//)[^/\s:@]+:[^/\s@]+@", r"\1<credentials>@", text)


"""
VIDEO 644 — WHY GOOGLEVIDEO REFUSED THE STREAM, SAID WITHOUT THE STREAM'S ADDRESS.

57 of 73 failed downloads on 7–9 October ended `ffmpeg exited with code 8`, and nothing more. Two
facts made that all there was to read:

  · yt-dlp runs ffmpeg with `-loglevel quiet` whenever the service sets `quiet` (FFmpegFD,
    yt_dlp/downloader/external.py), so ffmpeg never wrote WHY it stopped;
  · and ffmpeg's stderr is not captured by yt-dlp at all — it goes to this process's stderr.

`code 8` is the low byte of every AVERROR_HTTP_* (they all start 0xF8): ANY 4xx/5xx — and, measured
locally against ffmpeg 6.1, also a proxy that refuses the CONNECT (403, 407, 502 all exit 8 with the
same "Server returned …" line). What tells the two apart is the line before it, at `warning`:
`[https @ …] HTTP error 403` (googlevideo answered) or `[httpproxy @ …] HTTP error 403` (the proxy
did). So each attempt's ffmpeg now writes at `warning` into a file of its own, and a failure is
logged from it — but the next line ffmpeg prints is "Error opening input file <the signed stream
URL>", which carries the signature and the address the URL was issued to. `_redact` only removes the
proxy's own URL and user:password pairs; it leaves such a URL whole. So nothing from that file is
logged before `_sanitize` has replaced every URL with what it is (host kind, itag, whether it is
bound to one address), removed the proxy host and every IPv4 address, and cut each line short.

Nothing about the download changes: the format, the range, the retries, the response and its
detail (which the client classifies) are exactly as before.
"""

_FFMPEG_TAIL_LINES = 20
_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"<>]+")
_IPV4_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_FFMPEG_HTTP_ERROR_RE = re.compile(r"\[(https?|httpproxy|tls|tcp)(?: @ 0x[0-9a-fA-F]+)?\]\s*HTTP error (\d{3})")
_FFMPEG_NETWORK_RE = re.compile(
    r"connection to .* failed|connection refused|connection timed out|connection reset|i/o error|timed out|end of file",
    re.I,
)


def _proxy_scheme() -> str:
    """The proxy's scheme only — never its host or credentials. yt-dlp treats a bare host as http."""
    if not PROXY_URL:
        return "none"
    return PROXY_URL.split("://", 1)[0].lower() if "://" in PROXY_URL else "http"


def _ffmpeg_proxy_route() -> str:
    """
    How ffmpeg reaches googlevideo. yt-dlp hands ffmpeg the proxy as the `http_proxy` environment
    variable only (FFmpegFD), and ffmpeg's tls/http code uses it only when it starts with
    `http://` — measured locally: an `https://` or `socks5://` proxy is ignored WITHOUT a warning,
    so the metadata goes through the proxy while the stream goes out from this machine.
    """
    scheme = _proxy_scheme()
    if scheme == "none":
        return "direct(no_proxy)"
    return "proxy" if scheme == "http" else f"direct({scheme}_proxy_ignored_by_ffmpeg)"


def _proxy_host() -> str | None:
    try:
        return urllib.parse.urlsplit(PROXY_URL if "://" in PROXY_URL else f"http://{PROXY_URL}").hostname
    except ValueError:
        return None


def _describe_url(url: str) -> str:
    """A URL said without itself: the kind of host, the stream (itag), whether it is address-bound."""
    try:
        parts = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parts.query)
        host = (parts.hostname or "").lower()
    except ValueError:
        return "<url>"
    kind = (
        "googlevideo" if host.endswith("googlevideo.com")
        else "youtube" if host.endswith(("youtube.com", "ytimg.com", "youtu.be"))
        else "other"
    )
    said = [f"<url {kind}"]
    itag = (query.get("itag") or [""])[0]
    if itag.isdigit():
        said.append(f"itag={itag}")
    if kind == "googlevideo":
        signed = ",".join(query.get("sparams") or []).split(",")
        said.append("iplock=" + ("yes" if "ip" in signed and "ip" in query else "no"))
    return " ".join(said) + ">"


def _sanitize(text: str) -> str:
    """For any text that may hold a stream URL, the proxy or an address: none of them survive."""
    text = _redact(text)
    text = _URL_RE.sub(lambda m: _describe_url(m.group(0)), text)
    host = _proxy_host()
    if host:
        text = text.replace(host, "<proxy>")
    text = _IPV4_RE.sub("<ip>", text)
    return re.sub(r" @ 0x[0-9a-fA-F]+\]", "]", text)


def _ffmpeg_failure(stderr_text: str) -> dict[str, object]:
    """
    What ffmpeg said when it stopped: the HTTP status and WHO answered it (`server` = googlevideo
    through the tunnel, `proxy` = the proxy refused the CONNECT, `network` = no answer at all), which
    stream it was opening, and the last lines — every one sanitized.
    """
    lines = [line.strip() for line in (stderr_text or "").splitlines() if line.strip()]
    status: str | None = None
    origin = "unknown"
    for line in lines:
        m = _FFMPEG_HTTP_ERROR_RE.search(line)
        if m:
            status = m.group(2)
            origin = "proxy" if m.group(1) == "httpproxy" else "server"
            break
    if status is None and any(_FFMPEG_NETWORK_RE.search(line) for line in lines):
        origin = "network"
    stream = None
    for line in lines:
        if "Error opening input" in line:
            m = _URL_RE.search(line)
            if m:
                stream = _describe_url(m.group(0))
                break
    tail = [_sanitize(line)[:200] for line in lines[-_FFMPEG_TAIL_LINES:]]
    return {"status": status, "origin": origin, "stream": stream, "tail": " | ".join(tail)[:1500]}


def _failure_stage(timing: dict, text: str) -> str:
    """Where a cut stopped: the lookup (`metadata`), the HLS manifest inside it, or the stream (`data`)."""
    if timing.get("download_ms") is not None or timing.get("facts"):
        return "data"
    return "manifest" if "m3u8" in (text or "").lower() else "metadata"


# ── Each cut's ffmpeg writes its stderr to a file of its own ─────────────────────────────────────
#
# FFmpegFD starts ffmpeg through the `Popen` name in yt_dlp.downloader.external, without a stderr
# argument. That one name is replaced with a subclass that, while THIS thread's cut has a capture
# file open, hands ffmpeg that file as stderr. Every other call is untouched; another yt-dlp
# release that renames it simply leaves capture off (and with it the louder log level below, so an
# uncaptured ffmpeg never prints a signed URL into the service log).
_ffmpeg_capture = threading.local()


def _install_ffmpeg_stderr_capture() -> bool:
    try:
        from yt_dlp.downloader import external as _external
    except Exception:  # noqa: BLE001
        return False
    base = getattr(_external, "Popen", None)
    if not isinstance(base, type):
        return False
    if getattr(base, "_fastvid_stderr_capture", False):
        return True

    class _CapturingPopen(base):  # type: ignore[misc, valid-type]
        _fastvid_stderr_capture = True

        def __init__(self, *args, **kwargs):
            if kwargs.get("stderr") is None:
                sink = getattr(_ffmpeg_capture, "sink", None)
                cmd = args[0] if args else kwargs.get("args")
                if sink is not None:
                    kwargs["stderr"] = sink
                elif isinstance(cmd, (list, tuple)) and "-loglevel" in cmd and "warning" in cmd:
                    # No capture open on this thread: an ffmpeg asked to speak is silenced rather than
                    # allowed to print its stream URL into the service log.
                    kwargs["stderr"] = subprocess.DEVNULL
            super().__init__(*args, **kwargs)

    _external.Popen = _CapturingPopen
    return True


_FFMPEG_CAPTURE_READY = _install_ffmpeg_stderr_capture()


def _format_facts(info: dict) -> str:
    """VIDEO 618 — which video and which stream a cut asked for, for the log.

    Code 8 kept coming back for the same few videos while others worked, and nothing said which
    stream yt-dlp had chosen or from which YouTube client. Title and channel say what the video is;
    `format_id`, `protocol` and `format_note` (yt-dlp writes the client there, and "MISSING POT"
    when a PO token was absent) say what was asked for. Never a URL: a stream URL is signed and
    names the proxy's address.
    """
    def clean(value: object, limit: int) -> str:
        return str(value or "").replace('"', "'").replace("\n", " ").strip()[:limit]

    streams = info.get("requested_formats") or [info]
    return (
        f'title="{clean(info.get("title"), 80)}" '
        f'channel="{clean(info.get("channel") or info.get("uploader"), 60)}" '
        f'format={"+".join(clean(f.get("format_id"), 20) for f in streams)} '
        f'protocol={"+".join(clean(f.get("protocol"), 20) for f in streams)} '
        f'note="{" + ".join(clean(f.get("format_note"), 40) for f in streams)}"'
    )


def _fetch_window(id: str, out_path: Path, start: float, end: float, timing: dict | None = None) -> None:
    """One cut, asked again once when the failure was about the moment. Raises the last error.

    VIDEO 615 — where the time goes. Cuts took 20–60 s through the proxy and nobody could say
    whether that was the lookup (the watch page, the player JavaScript challenge, the format list)
    or the transfer and cut itself. yt-dlp calls `process_info` once the lookup is done and the
    format is chosen, right before the transfer starts, so that call is the line between the two:
    `extract_ms` is everything before it, `download_ms` everything after. `ydl.download` itself is
    unchanged. A lookup that fails never reaches the line and reports `download_ms=None`.
    `timing` receives the numbers of the last attempt, and `attempt` which one that was.
    """
    timing = timing if timing is not None else {}
    for attempt in range(1, _ATTEMPTS + 1):
        timing.update(attempt=attempt, extract_ms=None, download_ms=None, facts=None, ffmpeg=None)
        began = time.monotonic()
        lookup_done: list[float] = []
        hooked: list[bool] = []

        def settle() -> None:
            if not hooked:
                return  # no line to split on: say nothing rather than call the whole cut a lookup
            ended = time.monotonic()
            split = lookup_done[0] if lookup_done else ended
            timing["extract_ms"] = int((split - began) * 1000)
            timing["download_ms"] = int((ended - split) * 1000) if lookup_done else None

        # VIDEO 644 — this attempt's ffmpeg stderr. OUTSIDE the work directory on purpose:
        # `_download_and_cut` takes any single file it finds there as the cut.
        capture = tempfile.NamedTemporaryFile(prefix="ytdl-ffmpeg-", suffix=".log", delete=False) if _FFMPEG_CAPTURE_READY else None
        _ffmpeg_capture.sink = capture
        try:
            opts = _ydl_options(out_path, start, end)
            opts["no_warnings"] = False
            opts["logger"] = _YdlWarnings(id)
            with yt_dlp.YoutubeDL(opts) as ydl:
                # A measurement, never a condition: without the hook the cut runs exactly as before.
                process_info = getattr(ydl, "process_info", None)
                if callable(process_info):

                    def timed_process_info(info_dict, _inner=process_info):
                        if not lookup_done:
                            lookup_done.append(time.monotonic())
                        try:
                            timing["facts"] = _format_facts(info_dict)
                        except Exception:  # noqa: BLE001 — a log field never stops a cut
                            timing["facts"] = None
                        return _inner(info_dict)

                    ydl.process_info = timed_process_info
                    hooked.append(True)
                ydl.download([f"https://www.youtube.com/watch?v={id}"])
            settle()
            return
        except yt_dlp.utils.DownloadError as err:
            settle()
            _note_ffmpeg_failure(id, start, timing, str(err), capture)
            if attempt >= _ATTEMPTS or not _retryable(str(err)):
                raise
            log.info(
                "retrying id=%s start=%.2f extract_ms=%s download_ms=%s after: %s",
                id, start, timing.get("extract_ms"), timing.get("download_ms"), str(err).strip()[:120],
            )
            for leftover in out_path.parent.glob("*"):
                leftover.unlink(missing_ok=True)
        finally:
            _ffmpeg_capture.sink = None
            if capture is not None:
                capture.close()
                Path(capture.name).unlink(missing_ok=True)


def _note_ffmpeg_failure(id: str, start: float, timing: dict, message: str, capture) -> None:
    """
    VIDEO 644 — one line per attempt that ffmpeg ended: its exit code, the HTTP status and who gave
    it, the stream, the proxy route ffmpeg took, and its last lines — sanitized. Logged on the
    attempt itself, so a retried one is not lost to the attempt after it. Never raises.
    """
    m = re.search(r"ffmpeg exited with code (\d+)", message or "")
    if not m:
        return
    try:
        text = ""
        if capture is not None:
            capture.flush()
            text = Path(capture.name).read_text(errors="replace")
    except Exception:  # noqa: BLE001 — a log field never stops a cut
        text = ""
    failure = _ffmpeg_failure(text)
    timing["ffmpeg"] = failure
    log.warning(
        'ffmpeg failure id=%s start=%.2f attempt=%s stage=data exit=%s http=%s from=%s stream=%s '
        'ffmpeg_route=%s download_ms=%s captured=%s tail="%s"',
        id, start, timing.get("attempt"), m.group(1), failure["status"] or "none", failure["origin"],
        failure["stream"] or "unknown", _ffmpeg_proxy_route(), timing.get("download_ms"),
        "yes" if capture is not None else "no", failure["tail"],
    )


def _download_and_cut(id: str, start: float, duration: float, key: str) -> FileResponse:
    work = Path(tempfile.mkdtemp(prefix="ytdl-"))
    out_path = work / f"{uuid.uuid4().hex}.mp4"
    cleanup = BackgroundTask(shutil.rmtree, work, ignore_errors=True)
    end = start + duration

    timing: dict = {}
    try:
        _fetch_window(id, out_path, start, end, timing)
    except yt_dlp.utils.DownloadError as err:
        # The message is the useful part — "Sign in to confirm you're not a bot" and "Video
        # unavailable" need completely different responses from an operator, and collapsing them
        # into 500 is what made the RapidAPI route's failures unreadable for so long.
        detail = str(err).strip().replace("\n", " ")[:300]
        log.warning(
            "download failed id=%s start=%.2f dur=%.2f stage=%s attempt=%s extract_ms=%s download_ms=%s %s: %s",
            id, start, duration, _failure_stage(timing, detail), timing.get("attempt"), timing.get("extract_ms"),
            timing.get("download_ms"), timing.get("facts") or "facts=none", detail,
        )
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=502, detail=detail) from err
    except Exception as err:  # noqa: BLE001 - the response must say something either way
        log.exception("unexpected failure id=%s stage=%s", id, _failure_stage(timing, traceback.format_exc()))
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=500, detail=str(err)[:300]) from err

    # yt-dlp may land on a sibling name when it remuxes; take whatever single file appeared.
    produced = out_path if out_path.exists() else next(iter(work.glob("*")), None)
    if produced is None or not produced.is_file():
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=502, detail="yt-dlp produced no file")

    size = produced.stat().st_size
    # An over-ceiling body is a failed cut, not a heavy clip — see `_salvage_oversized`. Tried
    # before the bounds are enforced, and the bounds below are then enforced on the result.
    salvage = "none"
    if size > MAX_BYTES:
        produced, size, salvage = _salvage_oversized(produced, work, start, duration, size)

    # Refused HERE rather than left for FastVid to discard: a body outside these bounds is a
    # transfer neither side can use, and the client's own reason codes (DOWNLOAD_EMPTY,
    # DOWNLOAD_UNSUPPORTED) read better when the service names the same fact first.
    if size < MIN_BYTES:
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        # `salvage=` matters here too: since the cut runs first, a below-floor body can now also be
        # a cut that produced almost nothing, which is a different fault from an empty download.
        raise HTTPException(
            status_code=502,
            detail=f"file below floor ({size} < {MIN_BYTES} bytes, salvage={salvage})",
        )
    if size > MAX_BYTES:
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        # `salvage=` names which case this was, so the operator is not left to guess whether the
        # cut was attempted. See `_salvage_oversized` for what each value means.
        raise HTTPException(
            status_code=502,
            detail=f"file over ceiling ({size} > {MAX_BYTES} bytes, salvage={salvage})",
        )

    log.info(
        "ok id=%s start=%.2f dur=%.2f bytes=%d salvage=%s proxy=%s attempt=%s extract_ms=%s download_ms=%s %s",
        id, start, duration, size, salvage, bool(PROXY_URL),
        timing.get("attempt"), timing.get("extract_ms"), timing.get("download_ms"),
        timing.get("facts") or "facts=none",
    )
    # Kept under its key BEFORE the response goes out, so it survives a caller that has already
    # hung up. A cache that cannot be written costs only the reuse; the response is unchanged.
    try:
        produced = _store_result(key, produced)
    except OSError as err:
        log.warning("result not kept id=%s: %s", id, err)
    return FileResponse(
        produced,
        media_type="video/mp4",
        filename=f"{id}.mp4",
        background=cleanup,
    )
