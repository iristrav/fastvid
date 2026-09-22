# FASTVID — PHASE 0 IMPLEMENTATION MATRIX

Audit only. Nothing was built for this document. Every status below cites a file and a symbol I
actually opened; anything I have not yet opened is marked `NOT YET AUDITED` rather than guessed.

Repo state: branch `main`, commits `780cd37` + `218c95d` local (unpushed), 12.398 tests green,
`tsc --noEmit` clean.

---

## A. Requirements that are COMPLETE

### A1 — Production lock / stale job recovery (Patch §14, Phase 14)
**STATUS: COMPLETE**

| | |
|---|---|
| File | `server/renderLock.ts` |
| Symbols | `acquireRenderLock`, `releaseRenderLock`, `extendRenderLock`, `RENDER_LOCK_LEASE_MS` (40 min), `RENDER_LOCK_HEARTBEAT_MS` (5 min), `RenderLockOutcome.recoveredStale` |
| Telemetry | `STALE_LOCK_RECOVERED` emitted in `formatRenderLock` (line 225) |
| Test | `server/renderLockKeepsRendersApart.test.ts` |

Lease + heartbeat + stale recovery + the exact `STALE_LOCK_RECOVERED` event the patch asks for
already exist. **ACTION: none.**

### A2 — Delivery gate failure taxonomy (Patch §19, Phase 20)
**STATUS: COMPLETE**

`server/deliveryGate.ts`, `DeliveryGateFailureCode`:

```
AUTHORITATIVE_RENDER_FAILED   TIMELINE_MISSING
CLIP_WITHOUT_ARCHIVE_ASSET    CLIP_UNRESOLVED
PLACEHOLDER_IN_DELIVERY       DELIVERED_FILE_MISSING
DELIVERED_FILE_UNREADABLE     DELIVERED_FILE_NO_VIDEO
DELIVERED_FILE_NO_AUDIO       DELIVERED_DURATION_WRONG
```

`DeliveredFileFacts` = `{ exists, readable, durationSec, hasVideoStream, hasAudioStream, sizeBytes }`.

This covers Phase 20 items 1–9 and 11. **ACTION: none on the taxonomy.**

### A3 — Real-file validation on the authoritative route (Phase 20)
**STATUS: COMPLETE (cinematic route)**

`server/renderJobWorker.ts:943` calls `deliveryGate` with real measurements:
`delivered: { exists: check.fileExists, readable: check.fileExists && check.sizeBytes > 0,
durationSec: check.durationSec, … }`, plus per-clip `isPlaceholder` from `isPipelineFallbackClip`
and `fromArchive` read from the rehydration **provenance** rather than the identity.

### A4 — Placeholder blocked at delivery (Patch §13, Phase 13)
**STATUS: COMPLETE at the gate**

`PLACEHOLDER_IN_DELIVERY`, `deliveryGate.ts:186`, fed by `isPipelineFallbackClip`.
Earlier-stage prevention: see D3.

### A5 — Timeline repair exists (Phase 12)
**STATUS: PARTIAL → see C1**

`server/timelineRepair.ts`: `repairTimelineForRender`, `formatTimelineRepairs`.

### A6 — R626 / R627 (Phase 24 regression protection)
**STATUS: COMPLETE, must not regress**

- R626: `server/mediaResearchEngine.ts`, `EVENT_PHRASE_STOP` + the break in
  `extractEventPhraseForQuery`. Test `server/aQuestionHasNoObject.test.ts` (9 tests; verified red
  when the fix is reverted).
- R627: `server/timelineRenderer.ts`, `probeSegmentShape`, `oddSegmentsOut`, the widened
  `FFMPEG_LINES_THAT_ONLY_REPORT_FAILURE`. Test
  `server/theJoinNamedAStreamNotAReason.test.ts` (12 tests).

### A7 — YouTube searched/no-results distinction (Phase 4)
**STATUS: PARTIAL → see C2**

`videoPipeline.ts:5298` already does it correctly:
`attempt.searched ? "YOUTUBE_NO_RESULTS" : "YOUTUBE_NOT_SEARCHED"` (RONDE 600).

---

## B. Requirements that are MISSING

### B1 — SAFE_RENDER (Patch §9, Phase 10)
**STATUS: MISSING**

`grep -rl "SAFE_RENDER\|safeRender" server` → **no matches.** No safe render mode exists in any
form. **ACTION: implement.**

This is the single highest-value missing item, because render 599 is exactly the case it exists
for: eleven rendered segments of validated real media, one failing `xfade`, and the entire film
discarded.

### B2 — Central ProductionRecoveryEngine (Patch §2, Phase 18)
**STATUS: MISSING**

No module matches `recover*` except three test files. There is no failure classifier, no recovery
strategy selector, no bounded-retry ledger, no recovery telemetry.

Existing near-neighbours that must be **extended rather than duplicated** (Phase 25, Absolute Rule
15): `renderLock.ts` (attempt state), `timelineRepair.ts` (patching), `visualSourceLineage.ts`
(asset identity + outcomes), `clipRejectAudit.ts` (per-render refusal memory),
`providerFailureClass.ts` (provider-level failure classes and latches).

### B3 — Transition / effect fallback ladder (Patch §8, Phase 7)
**STATUS: MISSING**

`grep` for a transition fallback → **no matches.** `timelineRenderer.ts` calls
`runFfmpeg(args, "transition graph")` and the throw propagates. There is no
complex → safe → crossfade → hard cut ladder.

**This is what killed render 599.** With B1 and B3 in place that render would have delivered.

### B4 — FFmpeg failure classification (Patch §10, Phase 8)
**STATUS: MISSING**

`ffmpegComplaint` (R601/R627) extracts the *message*, and `classifyYoutubeDownloadError` classifies
downloads — but nothing classifies an ffmpeg render failure into geometry / pixel format / timebase
/ filter graph / stream mapping / codec / resource / mux. R627's `probeSegmentShape` supplies the
evidence for the geometry class only.

### B5 — Production state machine (Phase 21)
**STATUS: MISSING**

No `RECOVERING` / `VALIDATING` / `FAILED_RECOVERABLE` / `FAILED_EXHAUSTED` /
`FAILED_CONTENT_QUALITY` states. Render 599 surfaced as a generic failure with a 900-character
ffmpeg command as its reason.

### B6 — Exhaustion proof (Patch §20, Phase 22)
**STATUS: MISSING** — follows from B2; there is no recovery ledger to report.

---

## C. Requirements that are PARTIAL

### C1 — One authoritative timeline (Phase 12)
**STATUS: PARTIAL — two builders confirmed to exist**

Confirmed present: `edlToTimeline.ts`, `timelineFromManifest.ts`, plus `projectTimeline.ts`,
`timelineStore.ts`, `timelineValidator.ts`, `timelineRepair.ts`, `timelineHistory.ts`,
`timelineRouter.ts`, `timelineFilters.ts`, `timelineRenderer.ts`.

I have **not** yet traced which is authoritative or whether one can silently override the other.
That trace is required before any consolidation, per the standing rule *"DO NOT GUESS WHAT IS
REDUNDANT — trace callers, imports, production reachability, tests."*

**ACTION: trace, then report. No deletion in this pass.**

### C2 — `YOUTUBE_NOT_SEARCHED` accounting (Phase 4)
**STATUS: PARTIAL — the logic is right in one place and wrong at another**

`videoPipeline.ts:5298` is correct. But render 599 logged:

```
[YouTube] YOUTUBE_TURN_ENDED s1b1 … outcome=YOUTUBE_NO_RESULTS
[CentralSourcing] s1b1 TIER_DECLINED tier=1:YOUTUBE reason=YOUTUBE_NOT_SEARCHED
```

Both on the same beat, seconds apart. A second site is producing the label without consulting
`attempt.searched`. **ACTION: find that site and route it through the existing predicate.**

### C3 — Two delivery gate call sites (Phase 1, Phase 20)
**STATUS: PARTIAL, and deliberate**

- `renderJobWorker.ts:943` — cinematic route, full file facts.
- `videoPipeline.ts:52778` — `delivered: null, assetsOnly: true`, with a documented reason: the
  file was already measured by the export gate, the stillness audit and the post-render spot
  check, and *"inventing `exists: true` would be a claim nobody made."*

That reasoning is sound. What is **not** yet proven is that those three upstream checks together
cover every item in Phase 20. **ACTION: verify coverage, do not duplicate the probe.**

### C4 — Legacy compose as a competing route (Phase 1, Phase 25)
**STATUS: PARTIAL**

`route: cinematicDeliveredUrl ? "cinematic_timeline" : "legacy_compose"` appears at
`videoPipeline.ts:52556`, `:52780`, `:52873`. `deliveryGate.ts:133` treats a legacy delivery with a
cinematic refusal as a fallback and blocks it unless `legacyFallbackDeliveryAllowed()`.

So legacy compose **cannot silently become the delivery**; it is gated and loud
(`RENDER_FALLBACK_USED`). It is therefore not a silent second route — it is a marked one. Phase 1
asks for exactly that boundary, so this is closer to compliant than it first looks.
**ACTION: confirm the migration boundary is documented; do not delete.**

---

## D. NOT YET AUDITED

Listed so the final matrix has no `UNKNOWN`, and so I do not claim coverage I have not earned.

| # | Requirement | Phase |
|---|---|---|
| D1 | Unified Media Engine / ApprovedMedia boundary | 2 |
| D2 | Source priority engine (YouTube → archive → open web → fallback) as one function | 3 |
| D3 | Placeholder prevention *before* delivery | 13 |
| D4 | Asset rehydration recovery (`ASSET_NOT_FOUND`, `ASSET_NOT_REHYDRATABLE`) | 6 |
| D5 | Open-web / web-screenshot provider | 7 |
| D6 | Audio/mux duration authority and `-shortest` audit | 11 |
| D7 | Resource fairness: `usedCategories`, render-wide counters, provider budgets | 14 |
| D8 | Graphics overload (13/min vs threshold 12) | 15 |
| D9 | Editor / project model / autosave / history | 16 |
| D10 | Natural-language editing foundation | 17 |
| D11 | Recovery idempotence | 19 |

---

## E. BLOCKED — external dependency

### E1 — Final end-to-end production render (Phase 28, Patch §26, Master §32/§40)
**STATUS: BLOCKED**

**Reason:** enqueueing a production render is gated on the authenticated user.
`server/routers.ts` → `assertUserCanEnqueueVideo(ctx.user.id)` → `createVideo` → `enqueueVideoJob`.
There is no service path I can call, and I will not fabricate credentials or bypass the check.

**External action required:** the account holder starts the render from the app. I can then read
Railway logs, diagnose, patch, and hand back a new build for the next attempt.

This is the only requirement in the two prior prompts and this one that I cannot complete myself.
Everything else in B, C and D is mine to do.

---

## F. Order of work proposed for Phase 1+

Ranked by what actually blocked a real render, not by prompt order.

1. **B3 + B1** — transition fallback ladder, then SAFE_RENDER. Render 599 is the proof case: real
   validated media for all eleven segments, one filter failure, nothing delivered.
2. **B4** — ffmpeg failure classification, using R627's `probeSegmentShape` as the geometry
   evidence source.
3. **B2** — the recovery engine, built by *extending* `renderLock` + `timelineRepair` +
   `visualSourceLineage`, not as a new subsystem beside them.
4. **C2** — the `YOUTUBE_NOT_SEARCHED` mislabel, so §6 of the final report can be trusted.
5. **B5 + B6** — production states and exhaustion proof, which are reporting layers over 3.
6. **C1** — trace the two timeline builders and report before touching either.
7. **D1–D11** — audit, then decide.

---

## G. One standing correction

An earlier report of mine claimed a vision-approved clip was being discarded by a bug. That was
wrong and it is worth recording here so it is not built on. `passingScored` filters on
`visionResult.pass` (a CLIP-similarity funnel), while `vision_rejected` is filed from
`dedup.beatImageRejectedIds` (the beat image gate, a VLM that reads the frames). Two gates, two
questions. Render 599's YouTube clips were refused by the second one with correct reasons — a
soldier with an Iron Cross, and a map of the 1st Belorussian Front, against narration about
Hitler's orders in the bunker.

**Phase 3's rule states the same thing and must be kept: "A CLIP/similarity score is NOT equivalent
to approval. Never convert a similarity score into an approval decision."** The code already obeys
it. Any "fix" that made those clips win would have broken it.
