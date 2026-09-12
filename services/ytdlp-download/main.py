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

app = FastAPI(title="FastVid YouTube download service")


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
        }
    )


@app.get("/download")
def download(
    id: str = Query(..., min_length=5, max_length=32, description="YouTube video id"),
    duration: float = Query(..., gt=0, le=60, description="seconds of footage wanted"),
    start: float = Query(0, ge=0, description="offset into the source"),
    authorization: str | None = Header(default=None),
) -> FileResponse:
    _require_token(authorization)

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
    return FileResponse(
        produced,
        media_type="video/mp4",
        filename=f"{id}.mp4",
        background=cleanup,
    )
