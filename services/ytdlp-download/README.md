# FastVid YouTube download service (route A)

The service `YOUTUBE_CC_DL_SERVICE` points at. FastVid's `downloadYouTubeCCClip`
(`server/videoPipeline.ts`) tries this first and falls through to the RapidAPI
route when it does not answer usefully.

## The contract

    GET  {SERVICE}/download?id=<videoId>&duration=<sec>&start=<sec>
    Authorization: Bearer <token>     omitted when YOUTUBE_CC_DL_TOKEN is unset
    ->   200, video/mp4, THE ALREADY-TRIMMED SEGMENT
         > 10 000 bytes, <= 80 MB, within 180 s

The segment must already be cut. FastVid renames the response straight to the
beat's clip file and does not trim again — return the whole video and the whole
video lands in the montage. `server/ytdlpServiceContract.test.ts` pins both
halves of this against each other; it runs in the normal suite.

Any non-200, an empty body or a timeout is fine: FastVid falls through to
RapidAPI and records the reason.

## Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `SERVICE_TOKEN` | no | When set, requests must carry `Authorization: Bearer <it>`. Must match FastVid's `YOUTUBE_CC_DL_TOKEN`. Leave both unset for an open service. |
| `PROXY_URL` | no, but see below | Routes YouTube traffic through a proxy. This is the difference between working and not working on Railway. |
| `COOKIES_FILE` | no | Path to a `cookies.txt` from a signed-in browser. A second answer to the same problem `PROXY_URL` solves. |
| `MIN_FORMAT_HEIGHT` | no | Default 480, mirroring `youtubeMinFormatHeight()` on the client. |
| `PORT` | no | Supplied by Railway. |

## The part that decides whether this works

**YouTube blocks datacentre IPs far more aggressively than home connections,
and Railway is a datacentre.** The same yt-dlp call that works on a laptop can
answer "Sign in to confirm you're not a bot" here. This is not a bug in the
service and no amount of code fixes it.

Three configurations, in increasing order of reliability:

1. **Bare on Railway.** Cheapest, and likely to return 403s. Try it first
   anyway — it costs nothing to find out, and `/health` plus the 502 detail
   will tell you plainly.
2. **`COOKIES_FILE`.** Free, works, and expires. Puts a YouTube account at
   risk of being flagged. Needs periodic manual refreshing.
3. **`PROXY_URL` with a residential proxy.** Addresses the IP reputation
   directly, which is what commercial download APIs do internally. Roughly
   $1–3.50/GB in 2026; this service fetches only the requested seconds, so a
   20-download render moves something like 40–100 MB.

## Deploying on Railway

New service in the same project, pointed at this directory:

- **Root directory:** `services/ytdlp-download`
- **Builder:** Dockerfile (detected automatically)
- Set `SERVICE_TOKEN`, and `PROXY_URL` when you have one.

Then on the FastVid service:

    YOUTUBE_CC_DL_SERVICE = https://<this-service>.up.railway.app
    YOUTUBE_CC_DL_TOKEN   = <the same value as SERVICE_TOKEN>

`GET /health` reports the yt-dlp version, whether ffmpeg is present, and
whether auth, a proxy and cookies are configured — presence only, never a
value.

## Keeping it alive

yt-dlp is in a running arms race with YouTube. Versions stop working in weeks,
not years, and the failure is silent: no error, just no footage, and a render
full of colour cards. `requirements.txt` is deliberately unpinned, so a
redeploy is the upgrade. Redeploy on a schedule rather than when something
looks wrong.
