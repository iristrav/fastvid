# YouTube download service (`YOUTUBE_CC_DL_SERVICE`)

FastVid can **search** YouTube with `YOUTUBE_API_KEY` alone. It cannot **fetch** a clip without a
download route, and the two are separate capabilities on purpose — the preflight reports them
separately, and a deployment with search but no download produces exactly what the first production
render showed: twelve videos found, `[YouTubeUsage] used=0`.

There are two possible routes. FastVid tries them in this order:

1. **`YOUTUBE_CC_DL_SERVICE`** — a small service you run, described below. Primary.
2. **`RAPIDAPI_KEY`** — a third-party API. Fallback, used when the first is unset or fails.

Setting either one makes YouTube usable. This document specifies the first, because it is the one
with no documentation and because `videoPipeline.ts` calls it "the intended primary route": it runs
yt-dlp on its own infrastructure, which is what works around YouTube's server-side bot detection.
yt-dlp is deliberately **not** a dependency of this repository.

---

## 1. The contract FastVid expects

Derived from `downloadYouTubeCCClip` in `server/videoPipeline.ts` — this is what the code actually
does, not a proposal.

### Request

```
GET  {YOUTUBE_CC_DL_SERVICE}/download?id=<videoId>&duration=<seconds>&start=<seconds>
Authorization: Bearer <YOUTUBE_CC_DL_TOKEN>      # only when the token is set
```

| Part | Meaning |
|------|---------|
| `id` | the YouTube video id, e.g. `dQw4w9WgXcQ` |
| `duration` | how many seconds of clip FastVid wants |
| `start` | offset into the source video to start at |
| `Authorization` | omitted entirely when `YOUTUBE_CC_DL_TOKEN` is unset — a token-less service works |

A trailing slash on the env var is stripped, so `https://svc.example.com` and
`https://svc.example.com/` behave identically.

### Response

**The raw MP4 bytes in the body.** Not JSON, not a redirect to a URL — FastVid streams the response
straight to a temp file.

| Rule | Value | What happens otherwise |
|------|-------|------------------------|
| Status | `200` | any other status → logged, falls through to RapidAPI |
| Body | non-empty | empty → falls through to RapidAPI |
| Size floor | **> 10 000 bytes** | smaller → discarded silently, falls through |
| Size ceiling | **≤ 80 MB** | larger → discarded, falls through |
| Timeout | **180 s** default | configurable 30–600 s via `YOUTUBE_DOWNLOAD_TIMEOUT_MS` |

On success FastVid renames the temp file into place atomically and logs
`✅ YouTube CC via cloud service`.

---

## 2. Reference implementation

A complete service. Node 22 + yt-dlp + ffmpeg, roughly forty lines.

**`server.js`**

```js
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const run = promisify(execFile);
const app = express();
const TOKEN = process.env.SERVICE_TOKEN?.trim();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/download", async (req, res) => {
  if (TOKEN && req.get("authorization") !== `Bearer ${TOKEN}`) {
    return res.status(401).send("unauthorized");
  }
  const id = String(req.query.id ?? "");
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return res.status(400).send("bad id");

  const start = Math.max(0, Number(req.query.start) || 0);
  const duration = Math.min(120, Math.max(1, Number(req.query.duration) || 8));
  const dir = await mkdtemp(join(tmpdir(), "ytdl-"));
  const out = join(dir, "clip.mp4");

  try {
    await run("yt-dlp", [
      // The client workaround that gets past bot detection. Without it most fetches 403.
      "--extractor-args", "youtube:player_client=android_vr",
      "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      // Ask yt-dlp for only the span FastVid wants, so a 2-hour source is not pulled whole.
      "--download-sections", `*${start}-${start + duration}`,
      "--force-keyframes-at-cuts",
      "--no-playlist", "--no-warnings",
      "-o", out,
      `https://www.youtube.com/watch?v=${id}`,
    ], { timeout: 150_000, maxBuffer: 32 * 1024 * 1024 });

    const buf = await readFile(out);
    if (buf.length < 10_001) return res.status(422).send("clip too small");
    res.type("video/mp4").send(buf);
  } catch (err) {
    res.status(502).send(String(err).slice(0, 300));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(process.env.PORT || 8080);
```

**`package.json`**

```json
{
  "name": "fastvid-ytdlp-service",
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.21.2" }
}
```

**`Dockerfile`**

```dockerfile
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
CMD ["npm", "start"]
```

Keep yt-dlp current — YouTube changes its player often, and a stale binary is the usual cause of a
service that worked last month and 403s today. Rebuilding the image re-pulls the latest release.

---

## 3. Deploying it on Railway

1. Put those three files in their own repository.
2. Railway → your project → **New** → **GitHub Repo** → pick it. It builds from the Dockerfile.
3. On the **new service**: Variables → `SERVICE_TOKEN` = a long random string you generate.
4. Settings → Networking → **Generate Domain**. Note the URL.
5. On the **FastVid** service (and the **worker** — it does the rendering, so it needs these too):

   | Variable | Value |
   |---|---|
   | `YOUTUBE_CC_DL_SERVICE` | the new service's URL, e.g. `https://ytdlp-production.up.railway.app` |
   | `YOUTUBE_CC_DL_TOKEN` | the same string as `SERVICE_TOKEN` |

6. Redeploy. Check `GET {url}/health` returns `{"ok":true}`.

Both FastVid services need the variables — the worker is what renders, and setting them only on
the web service leaves downloads unconfigured where it matters.

If you would rather not run a service, set `RAPIDAPI_KEY` instead and skip all of this. It is the
fallback route and needs no infrastructure.

---

## 4. Verifying it worked

After the next render, the log distinguishes three outcomes explicitly:

```
✅ YouTube CC via cloud service: "<title>" (<videoId>)      the clip was fetched
[YouTubeDownload] video=… status=DOWNLOAD_FAILED …          a route was configured and failed
[YouTubeDownload] video=… status=DOWNLOAD_UNAVAILABLE …     no route configured at all
```

`[YouTubeUsage] used=0` with no `[YouTubeDownload]` line at all is the state this document exists to
end.

---

## 5. What this does not change

FastVid's licence handling is unaffected by configuring a download route. The pool still searches
under `creative_common` by default, `ALLOW_UNVERIFIED_YOUTUBE` still governs whether an unverified
clip may be adopted, and every YouTube download still carries the `_ytcc_` marker that makes the
fair-use transform apply to it. Adding a fetch route makes a licence-approved clip usable; it does
not approve anything.
