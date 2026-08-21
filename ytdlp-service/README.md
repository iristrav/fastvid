# ytdlp-service

Server-side YouTube clip extraction for the FastVid render pipeline.

## Why it exists

`videoPipeline.downloadYouTubeCCClip` has two download routes:

| Route | What it does |
| --- | --- |
| **This service** (`YOUTUBE_CC_DL_SERVICE`) | Fetches only the seconds the beat needs, trims where the video lives |
| RapidAPI (`RAPIDAPI_KEY`) | Downloads the **entire** source video, then trims locally |

The pipeline tries this service first and falls back to RapidAPI. When the service is not
configured, only the fallback runs — which is why render 528 found relevant WWII footage on three
separate queries and lost all three to `RapidAPI YouTube download scene N exceeded 90s`. Pulling a
half-hour documentary across the network to keep five seconds of it is not a workable primary path.

It is a separate service rather than a module because `yt-dlp` is a Python tool that needs frequent
updating, and because it runs the ANDROID_VR player client that gets past YouTube's server-side bot
detection (see the F3-40 note in `videoPipeline.ts`).

## API

```
GET /download?id=<videoId>&duration=<seconds>&start=<seconds>
Authorization: Bearer <SERVICE_TOKEN>
→ 200  the trimmed clip as an MP4 body
→ 400  malformed id / duration / start
→ 401  missing or wrong bearer token
→ 502  yt-dlp or ffmpeg failed, or the result was unusably small or large
→ 504  extraction ran past DOWNLOAD_TIMEOUT_SEC
```

```
GET /health
→ {"status":"ok","ytdlp":true,"ffmpeg":true,"auth":"required","maxConcurrent":3}
```

`id` must be exactly 11 characters of `[A-Za-z0-9_-]`. This is a security boundary, not a
convenience: the value becomes a subprocess argument, and the check is what stops a caller
smuggling a flag through as a video id.

## Deploying on Railway

1. **New service → Deploy from GitHub repo**, pick `iristrav/fastvid`.
2. Set the **Root Directory** to `ytdlp-service`. Railway then uses this folder's `Dockerfile` and
   ignores the Node app at the repo root.
3. Under **Variables**, set `SERVICE_TOKEN` to a long random string. Generate one with:
   ```
   openssl rand -hex 32
   ```
   Keep it somewhere safe — you need the same value in step 6.
4. Deploy. Railway assigns `PORT` itself; nothing to configure.
5. Under **Settings → Networking**, generate a public domain, then check it works:
   ```
   curl https://<your-service>.up.railway.app/health
   ```
   Both `ytdlp` and `ffmpeg` must come back `true`.
6. On the **fastvid worker** service, add two variables:

   | Variable | Value |
   | --- | --- |
   | `YOUTUBE_CC_DL_SERVICE` | `https://<your-service>.up.railway.app` (no trailing slash) |
   | `YOUTUBE_CC_DL_TOKEN` | the same string as `SERVICE_TOKEN` in step 3 |

7. Redeploy the worker and run a render. The log should show
   `✅ YouTube CC via cloud service` instead of `RapidAPI YouTube download ... exceeded`.

If you would rather not expose it publicly, use Railway's private networking instead and point
`YOUTUBE_CC_DL_SERVICE` at the internal hostname — the two services are in the same project.

## Configuration

Everything has a working default; set these only to change behaviour.

| Variable | Default | Notes |
| --- | --- | --- |
| `SERVICE_TOKEN` | *(empty)* | Empty means **no authentication**. The service logs a warning on boot. |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Each request spawns yt-dlp and ffmpeg; raise only with more memory. |
| `DOWNLOAD_TIMEOUT_SEC` | `150` | Must stay under the caller's `YOUTUBE_DOWNLOAD_TIMEOUT_MS` (180s) so it fails cleanly rather than being cut off. |
| `MAX_HEIGHT` | `720` | Source resolution ceiling. The clip is scaled into 1920x1080 as B-roll. |
| `MAX_BYTES` | `83886080` | 80 MB — matches what the caller accepts. |
| `MIN_BYTES` | `10000` | Below this the caller discards the file, so it is reported as a 502 here instead. |
| `YTDLP_PLAYER_CLIENT` | `android_vr` | Change when YouTube breaks this one. |
| `COOKIES_FILE` | *(empty)* | Path to a Netscape cookie jar, for age-restricted material. |

## Keeping it working

**Rebuild the image periodically.** `yt-dlp` is deliberately unpinned in `requirements.txt`:
YouTube changes its extraction surface every few weeks, and a stale `yt-dlp` is by far the most
common reason this service starts failing. A redeploy picks up the current release.

When downloads start failing across the board, check `/health` first, then the service logs — a
yt-dlp extraction failure is logged with the video id and the tail of its stderr.

## Local development

```
pip install -r requirements.txt -r requirements-dev.txt
uvicorn app:app --reload --port 8000
curl "http://localhost:8000/download?id=<videoId>&duration=5&start=10" -o clip.mp4
```

Tests need neither yt-dlp nor ffmpeg — the subprocess layer is patched out, so what they cover is
the request contract and the argument lists handed to the two binaries:

```
pytest tests/ -q
```

Or build and run the real container:

```
docker build -t ytdlp-service .
docker run --rm -p 8000:8000 -e SERVICE_TOKEN=dev ytdlp-service
```
