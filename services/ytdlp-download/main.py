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
import shutil
import subprocess
import tempfile
import threading
import time
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

SERVICE_TOKEN = os.environ.get("SERVICE_TOKEN", "").strip()
PROXY_URL = os.environ.get("PROXY_URL", "").strip()
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
RESULT_MAX_BYTES = int(os.environ.get("RESULT_CACHE_MB", "1024")) * 1024 * 1024
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
        if total <= RESULT_MAX_BYTES:
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
        "format": f"bv*[height>={MIN_HEIGHT}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
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
        "[Runtime] js=%s supported=%s clients=%s",
        result.get("jsRuntime"),
        result.get("jsRuntimeSupported"),
        result.get("playerClients"),
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


def _download_and_cut(id: str, start: float, duration: float, key: str) -> FileResponse:
    work = Path(tempfile.mkdtemp(prefix="ytdl-"))
    out_path = work / f"{uuid.uuid4().hex}.mp4"
    cleanup = BackgroundTask(shutil.rmtree, work, ignore_errors=True)
    end = start + duration

    try:
        with yt_dlp.YoutubeDL(_ydl_options(out_path, start, end)) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={id}"])
    except yt_dlp.utils.DownloadError as err:
        # The message is the useful part — "Sign in to confirm you're not a bot" and "Video
        # unavailable" need completely different responses from an operator, and collapsing them
        # into 500 is what made the RapidAPI route's failures unreadable for so long.
        detail = str(err).strip().replace("\n", " ")[:300]
        log.warning("download failed id=%s start=%.2f dur=%.2f: %s", id, start, duration, detail)
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=502, detail=detail) from err
    except Exception as err:  # noqa: BLE001 - the response must say something either way
        log.exception("unexpected failure id=%s", id)
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
        "ok id=%s start=%.2f dur=%.2f bytes=%d salvage=%s proxy=%s",
        id, start, duration, size, salvage, bool(PROXY_URL),
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
