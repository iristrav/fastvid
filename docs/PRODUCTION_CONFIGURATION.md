# FastVid production configuration

What has to be set before FastVid can render a video, what is optional, and what is not read at
all. Produced by the R201–R210 configuration audit.

Run `npm run preflight` (add `--json` for a machine-readable form) to get this same information for
a specific deployment. The preflight reports variable **names and presence only** — never a value.

> **This document does not claim production works.** No render has been performed with real
> credentials. It says what the code requires, which is a separate question from whether the
> result is any good.

---

## 1. The short answer

FastVid reads **418** distinct environment variables. Only **three** things must be set before it
can render at all:

| # | What | Set one of | Why |
|---|------|-----------|-----|
| 1 | Database | `DATABASE_URL` | **Must be a `mysql://` URL.** See §3. |
| 2 | Narration | `ELEVENLABS_API_KEY` **or** `FISH_AUDIO_API_KEY` **or** `GOOGLE_TTS_API_KEY` **or** `GOOGLE_CLOUD_TTS_API_KEY` | No voice-over, no video. |
| 3 | Script | `OPENAI_API_KEY` **or** `GEMINI_API_KEY` | Writes the script and the Director's judgement. |

Everything else is optional, has a working default, or is not read by production code. The other
415 variables are feature flags and tuning knobs — thresholds, concurrency limits, timeouts — each
with a default in code.

Strongly recommended in addition, though a render will run without them:

| What | Set | Without it |
|------|-----|-----------|
| Retrieval | `PEXELS_API_KEY` and/or `PIXABAY_API_KEY` | Retrieval falls back to the keyless sources (Wikimedia, Internet Archive, LoC, NASA). Thinner pool, worse matches. |
| Karaoke | `ELEVENLABS_API_KEY` specifically | Voice-over still works on any provider, but there are no per-word timings, so captions are whole lines and karaoke is off. |
| Durable storage | `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | Renders are written to local disk, which is ephemeral on a container platform. See §4. |

---

## 2. Traps found by the audit

These are the four places where the configuration surface disagreed with the code. All four are
fixed in the preflight; they are listed because a deployment may still carry the wrong values.

### `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` are not read

No production code reads them. The storage layer (`server/storageS3.ts`) reads `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_BUCKET` and `S3_ENDPOINT`. Setting the `AWS_*` names has
no effect on FastVid storage.

The only `AWS_*` variables that *are* read belong to a different feature: `AWS_REKOGNITION_ACCESS_KEY_ID`,
`AWS_REKOGNITION_SECRET_ACCESS_KEY` and `AWS_REKOGNITION_REGION`, for celebrity recognition.

### `DATABASE_URL` must be MySQL

`getDb()` opens a `mysql2/promise` pool and returns `null` for any URL that does not begin
`mysql://` or `mysql2://`, logging a warning and continuing. A PostgreSQL URL therefore **boots
successfully and silently loses every database operation**. The preflight now checks the scheme.

### `APP_URL` is not storage

It is the canonical public URL, used for Stripe redirects and password-reset emails. Both the
render worker and the rehydrator deliberately avoid needing it — they copy their own files off
disk. It never affects where a render is written.

### `REDIS_URL` is only for the BullMQ backend

The default queue polls the database. Redis is opened only when `QUEUE_BACKEND=bullmq`, and the
process refuses to boot with that flag set and no `REDIS_URL`. On a default deployment Redis is
**not required**, not "degraded".

---

## 3. Database

| | |
|---|---|
| Variable | `DATABASE_URL` |
| Engine | **MySQL** (`mysql2` + `drizzle-orm/mysql2`) |
| Scheme | `mysql://` or `mysql2://` — anything else is rejected by `getDb()` |
| Required | Yes, unconditionally |
| Migrations | Run at boot by `server/worker.ts` and `server/_core/index.ts`; skipped with a log line when `DATABASE_URL` is unset |

The database is the single hard infrastructure dependency. It stores videos, timelines and render
jobs, and the default queue polls it to find work.

`CALIBRATION_DATABASE_URL` is a separate, deliberately isolated database used only when
`CALIBRATION_MODE=true`; `calibrationGuard.ts` refuses to start if it is absent or points at the
same host as `DATABASE_URL`.

---

## 4. Storage

Selected by `getStorageBackend()` in `server/storageBackend.ts`, in this order:

1. **S3/R2** — when `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are all set.
   Optional: `S3_ENDPOINT` (for R2 and other S3-compatible services), `S3_REGION`, `S3_KEY_PREFIX`.
   A bucket without both keys is **not** S3 — it silently falls through to local disk.
2. **Manus Forge** — when `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY` are set.
3. **Local disk** — always available, and therefore storage is never a blocker.

Local disk works. On a container platform without a mounted volume it is **ephemeral**: renders are
lost on redeploy. That is a real operational problem and the preflight says so, but it is a
degradation, not a reason a render cannot start.

See [`STORAGE.md`](./STORAGE.md) for per-provider setup (R2, B2, endpoint and region handling).
That document is the detail; this section is only the requirement.

---

## 5. Queue

| Backend | Selected by | Needs |
|---------|-------------|-------|
| Database polling (default) | nothing — this is the default | `DATABASE_URL` |
| BullMQ | `QUEUE_BACKEND=bullmq` | `REDIS_URL`, or the process refuses to boot |

One render does not need a queue at all in the sense of a separate service; the default backend is
a poller over the `videos` table.

---

## 6. Narration and captions

Three TTS providers, read by `server/videoPipeline.ts`. They are **alternatives**, not a chain that
requires the first:

| Provider | Variable |
|----------|----------|
| ElevenLabs | `ELEVENLABS_API_KEY` |
| Fish Audio | `FISH_AUDIO_API_KEY` |
| Google Cloud TTS | `GOOGLE_TTS_API_KEY` or `GOOGLE_CLOUD_TTS_API_KEY` |

**Per-word timing is ElevenLabs-only.** `ttsWordAlignmentEnabled()` returns true only when
`ELEVENLABS_API_KEY` is set, because it is the provider that returns word timings. On another
provider the video gets a voice-over and whole-line captions, and no karaoke.

---

## 7. Retrieval providers

None is required. Four sources need no key at all, so retrieval always has something to search.

| Source | Variable | Needed for |
|--------|----------|-----------|
| Wikimedia, Internet Archive, Library of Congress, NASA | *(none)* | always available |
| Pexels | `PEXELS_API_KEY` | modern stock footage |
| Pixabay | `PIXABAY_API_KEY` | modern stock footage |
| Europeana | `EUROPEANA_API_KEY` | European archival |
| NARA | `NARA_API_KEY` | US national archives |
| SerpAPI | `SERPAPI_KEY` | stills for beats no video source covers |
| Freesound | `FREESOUND_API_KEY` | ambience / room tone |

YouTube needs **two** things, and one without the other is a trap: a clip can be found and then not
fetched.

| | Variable |
|---|---|
| Search | `YOUTUBE_API_KEY` |
| Download | `YOUTUBE_CC_DL_SERVICE` or `RAPIDAPI_KEY` |

YouTube is never required. It is also gated behind `ENABLE_YOUTUBE_SOURCING`.

---

## 8. Route flags

All default **off**. A deployment that sets none of them renders through the legacy route, which is
a valid render.

| Flag | Turns on |
|------|----------|
| `CINEMATIC_EDITING_ENGINE` | the cinematic Director and EDL; also switches on `POOL_RANKING_V2` |
| `CINEMATIC_RENDER_PATH` | the timeline renderer |
| `POOL_RANKING_V2` | the thirteen-signal ranking engine (follows the flag above unless set) |
| `ENABLE_YOUTUBE_SOURCING` | YouTube as a retrieval source |
| `AI_DIRECTOR` | the LLM Director |

`SEARCH_GATE_STRICT` defaults **on** and should stay on.

---

## 9. Not required for a first render

Billing (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`), email
(`RESEND_API_KEY`, `EMAIL_FROM`), celebrity recognition (`AWS_REKOGNITION_*`), the vector store
(`QDRANT_URL`, `QDRANT_API_KEY`), and every generative video provider (`RUNWAY_API_KEY`,
`KLING_API_KEY`, `LUMA_API_KEY`, `PIKA_API_KEY`, `LEONARDO_API_KEY`, `STABILITY_AI_API_KEY`,
`REPLICATE_API_KEY`, `HIGGSFIELD_API_KEY`, `FAL_API_KEY`) are all optional. The generative
providers are last-resort fallbacks after stock search fails.

---

## 10. Verdicts

`npm run preflight` returns one of three, and exits non-zero only for the last:

| Verdict | Meaning |
|---------|---------|
| `PRODUCTION_RENDER_POSSIBLE` | everything configured |
| `PRODUCTION_RENDER_DEGRADED` | a render will run and produce a real video, with something optional missing — fewer sources, no karaoke, ephemeral storage |
| `PRODUCTION_RENDER_BLOCKED` | there is no video at all until the named blockers are fixed |
