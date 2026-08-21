"""
ytdlp-service — server-side YouTube clip extraction for the FastVid render pipeline.

WHY THIS EXISTS
---------------
videoPipeline.downloadYouTubeCCClip has two routes. The RapidAPI route resolves a format URL and
downloads the ENTIRE source video, then trims out the few seconds a beat actually needs. For a
half-hour documentary that is hundreds of megabytes to keep five seconds, and render 528 lost every
YouTube clip to it — three relevant WWII finds, three "exceeded 90s" timeouts, nothing in the cut.

This service does the trimming where the video lives. yt-dlp's --download-sections fetches only the
requested byte range, so what crosses the network is a few seconds of video rather than the whole
film. It also runs yt-dlp's ANDROID_VR player client, which is what actually gets past YouTube's
server-side bot detection (see the F3-40 diagnosis in videoPipeline.ts) — and yt-dlp is deliberately
not a dependency of the main repo, which is why this is a separate service rather than a module.

CONTRACT (fixed by the caller — do not change without changing videoPipeline.ts)
-------------------------------------------------------------------------------
    GET /download?id=<videoId>&duration=<seconds>&start=<seconds>
    Authorization: Bearer <SERVICE_TOKEN>
    → 200 with the trimmed MP4 as the response body

The caller rejects anything at or below 10,000 bytes and anything above 80 MB, and gives up after
YOUTUBE_DOWNLOAD_TIMEOUT_MS (180s by default). DOWNLOAD_TIMEOUT_SEC below sits under that on
purpose, so this service returns a clean error before the caller times out and falls back.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import shutil
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("ytdlp-service")

# ─── Configuration ───────────────────────────────────────────────────────────


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if raw:
        try:
            value = int(raw)
            if lo <= value <= hi:
                return value
            log.warning("%s=%s out of range [%d, %d] — using %d", name, raw, lo, hi, default)
        except ValueError:
            log.warning("%s=%r is not a number — using %d", name, raw, default)
    return default


SERVICE_TOKEN = (os.environ.get("SERVICE_TOKEN") or "").strip()

# Matches the caller's own 80 MB ceiling exactly. Returning something larger only wastes the
# transfer — videoPipeline discards it on arrival.
MAX_BYTES = _int_env("MAX_BYTES", 80 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024)

# The caller treats <= 10,000 bytes as "no usable file". Anything at or below that is a failed
# extraction, so it is reported as an error here rather than shipped as a success.
MIN_BYTES = _int_env("MIN_BYTES", 10_000, 1_000, 10 * 1024 * 1024)

# Deliberately under the caller's 180s budget: a clean 504 lets it fall back to RapidAPI with time
# to spare, where a hang would burn the whole allowance and leave the beat with nothing.
DOWNLOAD_TIMEOUT_SEC = _int_env("DOWNLOAD_TIMEOUT_SEC", 150, 15, 600)

# The clip is scaled into a 1920x1080 frame as B-roll behind narration, so source beyond 720p buys
# nothing visible and costs download time.
MAX_HEIGHT = _int_env("MAX_HEIGHT", 720, 240, 2160)

# yt-dlp runs one ffmpeg per request and the container is small. Unbounded concurrency turns a
# burst of scenes into swap.
MAX_CONCURRENT = _int_env("MAX_CONCURRENT_DOWNLOADS", 3, 1, 16)

# F3-40: the ANDROID_VR client is the one that reliably avoids YouTube's bot checks. Overridable
# because YouTube changes what works every few months.
PLAYER_CLIENT = (os.environ.get("YTDLP_PLAYER_CLIENT") or "android_vr").strip()

# Optional Netscape-format cookie jar for age-restricted material. Not required.
COOKIES_FILE = (os.environ.get("COOKIES_FILE") or "").strip()

MAX_DURATION_SEC = 120.0
MAX_START_SEC = 86_400.0

# YouTube IDs are exactly 11 characters of [A-Za-z0-9_-]. This is a security boundary, not a
# convenience: the value goes into a subprocess argument list, and validating its shape here means
# no caller can smuggle a flag (e.g. "--exec") through as a video id.
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Startup checks. A misconfigured container should say so on boot, not on first render."""
    if not SERVICE_TOKEN:
        log.warning(
            "SERVICE_TOKEN is not set — /download accepts unauthenticated requests. "
            "Set it, and set YOUTUBE_CC_DL_TOKEN to the same value on the render worker."
        )
    for binary in ("yt-dlp", "ffmpeg"):
        if shutil.which(binary) is None:
            log.error("%s not found on PATH — /download cannot work", binary)
    log.info(
        "ready: maxConcurrent=%d timeout=%ds maxHeight=%d player_client=%s",
        MAX_CONCURRENT, DOWNLOAD_TIMEOUT_SEC, MAX_HEIGHT, PLAYER_CLIENT,
    )
    yield


app = FastAPI(title="ytdlp-service", version="1.0.0", lifespan=lifespan)
_download_slots = asyncio.Semaphore(MAX_CONCURRENT)


# ─── Pure helpers (unit-tested directly) ─────────────────────────────────────


def valid_video_id(video_id: str) -> bool:
    return bool(VIDEO_ID_RE.match(video_id or ""))


def section_spec(start: float, duration: float) -> str:
    """yt-dlp --download-sections range for the window the beat asked for.

    A small lead-in is NOT added: the caller already picked `start`, and shifting it would silently
    return different footage than it asked for. The trailing edge gets a little slack instead,
    because --force-keyframes-at-cuts lands on a keyframe and can come up marginally short.
    """
    begin = max(0.0, float(start))
    end = begin + max(0.1, float(duration)) + 0.5
    return f"*{begin:.2f}-{end:.2f}"


def format_selector(max_height: int) -> str:
    """Prefer a merged MP4 at or below max_height, then any MP4, then anything at all.

    Ordered widest-net-last so a video with unusual formats still yields something rather than
    failing outright — the caller can use a slightly odd container, it cannot use nothing.
    """
    return (
        f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/"
        f"b[height<={max_height}][ext=mp4]/"
        f"b[height<={max_height}]/"
        f"bv*+ba/b"
    )


def build_ytdlp_args(
    video_id: str,
    out_path: str,
    start: float,
    duration: float,
    *,
    use_sections: bool,
    max_height: int = MAX_HEIGHT,
    player_client: str = PLAYER_CLIENT,
    cookies_file: str = "",
    max_bytes: int = MAX_BYTES,
) -> list[str]:
    """Argument list for yt-dlp. Never a shell string — see VIDEO_ID_RE."""
    args = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--no-part",
        "--retries", "3",
        "--socket-timeout", "20",
        "--extractor-args", f"youtube:player_client={player_client}",
        "-f", format_selector(max_height),
        "--merge-output-format", "mp4",
        "-o", out_path,
    ]
    if use_sections:
        # The whole point of this service: fetch only the requested window.
        args += ["--download-sections", section_spec(start, duration), "--force-keyframes-at-cuts"]
    else:
        # Whole-file fallback. Capped so a feature-length source cannot run away with the budget —
        # yt-dlp aborts rather than downloading past the ceiling.
        args += ["--max-filesize", str(max_bytes)]
    if cookies_file:
        args += ["--cookies", cookies_file]
    args.append(f"https://www.youtube.com/watch?v={video_id}")
    return args


def build_ffmpeg_args(src: str, dst: str, duration: float, *, from_sections: bool) -> list[str]:
    """Normalise whatever yt-dlp produced into a clean, exactly-`duration` MP4.

    When yt-dlp already cut the section, the window starts at 0 and only the length needs trimming.
    Otherwise the whole file is there and the seek has to happen here. `-ss` before `-i` in that
    case so ffmpeg seeks instead of decoding everything up to the start point.
    """
    args = ["ffmpeg", "-y", "-loglevel", "error"]
    if not from_sections:
        args += ["-ss", "0"]
    args += [
        "-i", src,
        "-t", f"{max(0.1, float(duration)):.3f}",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        dst,
    ]
    return args


def authorised(header_value: str | None, expected: str = "") -> bool:
    """Bearer check.

    An unset SERVICE_TOKEN means the service is open — matching the caller, which omits the header
    entirely when YOUTUBE_CC_DL_TOKEN is unset. That combination is only sensible on a private
    network; startup logs a warning so it is never an accident in production.
    """
    token = expected if expected != "" else SERVICE_TOKEN
    if not token:
        return True
    if not header_value:
        return False
    scheme, _, presented = header_value.partition(" ")
    if scheme.lower() != "bearer":
        return False
    # Constant-time: a naive == leaks the token one character at a time under timing analysis.
    return secrets.compare_digest(presented.strip(), token)


# ─── Subprocess layer (patched out in tests) ─────────────────────────────────


async def run_command(args: list[str], timeout_sec: int) -> tuple[int, str]:
    """Run a command, return (exit code, tail of stderr). Killed hard on timeout."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, (stderr or b"").decode("utf-8", "replace")[-400:]


def find_download_output(directory: Path, stem: str) -> Path | None:
    """The file yt-dlp actually produced, matched by stem because it picks the extension.

    Merging separate video and audio streams leaves per-format fragments next to the result —
    `raw.f137.mp4` alongside `raw.mp4`. Those sort BEFORE the merged file alphabetically, so
    taking the first match would hand ffmpeg a video-only fragment. The merged output is the one
    with nothing between the stem and the extension; anything else is a leftover.
    """
    candidates = [p for p in directory.glob(f"{stem}.*") if p.is_file() and p.stat().st_size > 0]
    if not candidates:
        return None
    merged = [p for p in candidates if "." not in p.name[len(stem) + 1 :]]
    if merged:
        return max(merged, key=lambda p: p.stat().st_size)
    # No clean match (unusual container naming) — the largest fragment beats an arbitrary one.
    return max(candidates, key=lambda p: p.stat().st_size)


async def extract_clip(video_id: str, start: float, duration: float, workdir: Path) -> Path:
    """Fetch the window and normalise it. Raises HTTPException on any failure.

    All three subprocess steps share ONE deadline. Giving each its own full timeout would let a
    worst case run to three times the configured budget — well past the point where the caller has
    given up and moved to its RapidAPI fallback, so the work would be finished for nobody.
    """
    deadline = asyncio.get_running_loop().time() + DOWNLOAD_TIMEOUT_SEC

    def remaining(minimum: int = 5) -> int:
        left = deadline - asyncio.get_running_loop().time()
        if left < minimum:
            raise asyncio.TimeoutError
        return int(left)

    raw_stem = "raw"
    raw_template = str(workdir / f"{raw_stem}.%(ext)s")
    out_path = workdir / "clip.mp4"

    used_sections = True
    code, err = await run_command(
        build_ytdlp_args(video_id, raw_template, start, duration, use_sections=True),
        remaining(),
    )
    raw = find_download_output(workdir, raw_stem)

    if code != 0 or raw is None:
        # Section download is not supported for every source (live streams, some HLS variants).
        # Falling back to a size-capped whole-file fetch keeps those usable instead of dropping
        # the beat, and the cap stops it becoming the very problem this service exists to avoid.
        log.info("video=%s section download failed (%s) — retrying whole file", video_id, err[:120])
        used_sections = False
        # Leave room for the ffmpeg pass: a whole-file fetch that eats the entire remaining budget
        # would leave nothing to trim with, and an untrimmed file is not what the caller asked for.
        code, err = await run_command(
            build_ytdlp_args(video_id, raw_template, start, duration, use_sections=False),
            max(5, remaining() - 20),
        )
        raw = find_download_output(workdir, raw_stem)

    if code != 0 or raw is None:
        raise HTTPException(status_code=502, detail=f"yt-dlp failed: {err[:200] or 'no output file'}")

    code, err = await run_command(
        build_ffmpeg_args(str(raw), str(out_path), duration, from_sections=used_sections),
        remaining(),
    )
    if code != 0 or not out_path.exists():
        raise HTTPException(status_code=502, detail=f"ffmpeg failed: {err[:200] or 'no output file'}")

    size = out_path.stat().st_size
    if size <= MIN_BYTES:
        # The caller discards anything this small, so calling it a success would just move the
        # failure downstream and cost it a fallback attempt it could have started sooner.
        raise HTTPException(status_code=502, detail=f"extracted clip too small ({size} bytes)")
    if size > MAX_BYTES:
        raise HTTPException(status_code=502, detail=f"extracted clip too large ({size} bytes)")

    log.info(
        "video=%s start=%.2f duration=%.2f → %.1fMB (%s)",
        video_id, start, duration, size / 1024 / 1024,
        "section" if used_sections else "whole-file",
    )
    return out_path


# ─── Routes ──────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> JSONResponse:
    """Liveness plus the two binaries this service is useless without."""
    return JSONResponse(
        {
            "status": "ok",
            "ytdlp": shutil.which("yt-dlp") is not None,
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "auth": "required" if SERVICE_TOKEN else "open",
            "maxConcurrent": MAX_CONCURRENT,
        }
    )


@app.get("/download")
async def download(
    request: Request,
    id: str = Query(..., description="YouTube video id"),
    duration: float = Query(..., description="Clip length in seconds"),
    start: float = Query(0.0, description="Offset into the source in seconds"),
) -> FileResponse:
    if not authorised(request.headers.get("authorization")):
        raise HTTPException(status_code=401, detail="missing or invalid bearer token")
    if not valid_video_id(id):
        raise HTTPException(status_code=400, detail="id must be 11 characters of [A-Za-z0-9_-]")
    if not (0.1 <= duration <= MAX_DURATION_SEC):
        raise HTTPException(status_code=400, detail=f"duration must be 0.1–{MAX_DURATION_SEC}s")
    if not (0.0 <= start <= MAX_START_SEC):
        raise HTTPException(status_code=400, detail=f"start must be 0–{MAX_START_SEC}s")

    workdir = Path(tempfile.mkdtemp(prefix="ytdlp-clip-"))
    cleanup = BackgroundTask(shutil.rmtree, workdir, ignore_errors=True)
    try:
        async with _download_slots:
            clip = await asyncio.wait_for(
                extract_clip(id, start, duration, workdir),
                timeout=DOWNLOAD_TIMEOUT_SEC + 15,
            )
    except HTTPException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    except asyncio.TimeoutError:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(status_code=504, detail=f"extraction exceeded {DOWNLOAD_TIMEOUT_SEC}s")
    except Exception as exc:  # noqa: BLE001 — any failure must free the temp dir
        shutil.rmtree(workdir, ignore_errors=True)
        log.exception("video=%s unexpected failure", id)
        raise HTTPException(status_code=500, detail=str(exc)[:200]) from exc

    # Cleanup runs after the body has been sent, not before — deleting here would race the send.
    return FileResponse(
        clip,
        media_type="video/mp4",
        filename=f"{id}.mp4",
        background=cleanup,
    )


if __name__ == "__main__":  # pragma: no cover — container uses uvicorn directly
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
