# Production render runbook

How to start one real FastVid render and collect the evidence needed to judge
visual quality.

Written after RONDE 139, which established that the visual-sourcing work of
RONDE 123–136 can only be validated by a real render — and that a render cannot
be started from a Claude Code sandbox. This document exists so nobody has to
rediscover either fact.

---

## 1. Why this document exists

RONDE 131 measured a production render and found:

| metric | value |
| --- | --- |
| rawVisualQuality | 17 / 100 |
| visionAttempts | 34 |
| fits | 13 |
| does_not_fit | 21 |
| YouTube searches | 25 |

RONDE 123–136 then changed the sourcing pipeline substantially. Every change is
covered by tests and by mutation checks, and the full suite is green — but a
green suite proves the chain behaves as designed, not that providers return
better pictures. **The only proof of visual improvement is a real render.**

Four consecutive rounds (137–140) stopped at the same wall. The blockers are now
known precisely, and they are two independent things:

1. **No credentials.** None of the nine categories (database, LLM, TTS, YouTube,
   historical providers, image providers, Qdrant/Voyage, storage, auth) are
   present in a Claude Code sandbox.
2. **No network.** The sandbox's egress policy denies CONNECT to the production
   host *and* to the providers themselves. Measured directly:

   ```
   commons.wikimedia.org   CONNECT rejected (403, policy denial)
   archive.org             CONNECT rejected
   api.openai.com          CONNECT rejected
   fastvid-production-*    CONNECT rejected
   ```

The second blocker is the important one, because it is the one that is easy to
get wrong: **supplying credentials to a sandbox would not help.** A render
started there would fail at the first LLM call. The render has to run in the
real production environment.

---

## 2. Starting the render

Either route works. Both go through the same queue and the same worker.

### Option A — the FastVid UI

Create a video as normal with:

- **prompt**: the documentary title
- **videoLength**: `8-10`
- **videoType**: `documentary`

### Option B — the internal trigger endpoint

`server/_core/index.ts` exposes a purpose-built trigger. It creates the video row
and enqueues the job exactly as the UI does; there is no separate render path.

```bash
curl -X POST https://<production-host>/api/internal/generate \
  -H "x-internal-key: $INTERNAL_TRIGGER_KEY" \
  -H "content-type: application/json" \
  -d '{
        "prompt": "The Real Reason Hermann Göring Joined Hitler",
        "videoLength": "8-10",
        "videoType": "documentary",
        "userId": 1
      }'
```

Response:

```json
{ "videoId": 0, "status": "queued", "queuePosition": 0 }
```

Poll status with the same key:

```bash
curl -H "x-internal-key: $INTERNAL_TRIGGER_KEY" \
  https://<production-host>/api/internal/video/<videoId>
```

`INTERNAL_TRIGGER_KEY` lives in the Railway environment variables of the **web**
service. The code has a development fallback; it must never be used against
production.

### Health

`railway.json` sets `healthcheckPath: /api/health`, served by
`server/worker.ts`. `GET /api/health/r2` checks object storage separately.

---

## 3. What to collect

**The complete worker log for that one render**, unfiltered. Not a grep of the
successful beats — the refused ones carry the diagnosis.

All eight instrumentation blocks are in production code as of `7ef2e70`:

| log tag | emitted by | answers |
| --- | --- | --- |
| `[Quality]` | `videoPipeline.ts` | rawVisualQuality, fits, does_not_fit, attempts |
| `[VisualSourcingAudit]` | `visualSourcingAudit.ts` | mismatch breakdown + per-provider judged/accepted/refused |
| `[MismatchResearch]` | `visualSourcingAudit.ts` | per beat: context, originalQuery → correctedQuery, outcome |
| `[MismatchFeedback]` | `visualSourcingAudit.ts` | per refusal: kind, QUESTION vs MATERIAL, reorder |
| `[VisualIntegrity]` | `videoPipeline.ts` | longest stillness, image changes, imagesOver5Sec, endFrameLuma, endsOnBlack |
| `[ClosingTail]` | `videoPipeline.ts` | container vs video-stream duration, seek, plan |
| `[ProviderCooldown]` | `providerFailureClass.ts` | Wikimedia 429 and other rate-limit stand-downs |
| `[YouTubeLicense]` | `youtubeLicenseStatus.ts` | VERIFIED / UNVERIFIED / REJECTED per asset |

**Also collect the MP4 itself** (or its URL). The log says what the pipeline
believed; only the file says what a viewer sees. `[VisualIntegrity]` is measured
off the exported file, but an independent frame-by-frame check of the delivered
MP4 is the last link in the chain.

---

## 4. What the evidence answers

With the log and the MP4, these become measurable rather than argued:

- **rawVisualQuality vs 17** — did the sourcing work move the number that
  matters? (`availabilityAdjustedScore` does not; it reports availability.)
- **fits / does_not_fit vs 13 / 21** — did refusals actually fall?
- **mismatch breakdown** — which fault dominates now: MODERN_FOOTAGE,
  TITLE_CARD, WRONG_SUBJECT, …
- **QUESTION vs MATERIAL split** — a sourcing problem or a catalogue problem.
  These lead to different work.
- **per-provider acceptance** — which sources earn their place in the cascade.
- **research attempts / produced / accepted** — did RONDE 132/134's corrected
  queries bring back pictures the gate then approved.
- **stillness, imagesOver5Sec, endsOnBlack** — the RONDE 128/130/133/136 rules,
  verified on the delivered file.

---

## 5. Rules that must survive any future change

Established across RONDE 123–136 and each guarded by tests plus a mutation
check. Listed here so a later change does not quietly undo one.

- `SEARCH_GATE_STRICT` stays `true`. Never disabled to make a render succeed.
- Queries come only from `searchQueryContract`. Never assembled from a vision
  reason string, never from the video title.
- Entity spelling is preserved exactly: `Hermann Göring`, never `Goring`,
  never `G ring`. Title words like "Influential" are never entities.
- A still image is capped at 5 seconds, contained and centred, no crop, no zoom.
- The closing tail seeks against the **video stream** duration, never
  `format=duration` — the container's duration is the audio's on any scene with
  a voiceover.
- One mismatch-research pass per beat, inside the existing query cap and budget.
- `UNVERIFIED` YouTube material is never presented as `VERIFIED`.
- An unmeasurable check reports `NOT_MEASURED`, never `PASSED`.

---

## 6. Current state

- main: `7ef2e70` — RONDE 136.
- Suite: 4428 passed, 15 skipped, 0 failed. TypeScript clean, ESLint 0 errors,
  build ok.
- Structural improvement proven. **Production visual-quality improvement not yet
  empirically proven** — that is what the render in section 2 is for.
