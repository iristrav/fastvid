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
    }
    if PROXY_URL:
        opts["proxy"] = PROXY_URL
    if COOKIES_FILE and Path(COOKIES_FILE).is_file():
        opts["cookiefile"] = COOKIES_FILE
    return opts


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
    # Refused HERE rather than left for FastVid to discard: a body outside these bounds is a
    # transfer neither side can use, and the client's own reason codes (DOWNLOAD_EMPTY,
    # DOWNLOAD_UNSUPPORTED) read better when the service names the same fact first.
    if size < MIN_BYTES:
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=502, detail=f"file below floor ({size} < {MIN_BYTES} bytes)")
    if size > MAX_BYTES:
        cleanup.func(*cleanup.args, **cleanup.kwargs)
        raise HTTPException(status_code=502, detail=f"file over ceiling ({size} > {MAX_BYTES} bytes)")

    log.info("ok id=%s start=%.2f dur=%.2f bytes=%d proxy=%s", id, start, duration, size, bool(PROXY_URL))
    return FileResponse(
        produced,
        media_type="video/mp4",
        filename=f"{id}.mp4",
        background=cleanup,
    )
