/** Production sourcing policy — archive-first visuals; ElevenLabs for voice. */

import { burnedInTextAllowed } from "./onScreenTextPolicy";
import fs from "fs";
import os from "os";
import { normalizeVideoLength, targetVideoDurationMinutes } from "../shared/videoLengths";

/**
 * Archive-first mode: prefer the curated/admin media archive per beat. When a scene ends up
 * short, recoverSceneClipsIfEmpty() tops it up using the full external sourcing cascade
 * (Internet Archive, YouTube CC, Wikimedia, NARA, Flickr, SepiaSearch, Vimeo, media.ccc, NASA,
 * Europeana, Openverse, then Pexels/Pixabay last) — that cascade is a fallback for underfilled
 * scenes, not the primary per-beat path.
 */
export function curatedArchiveOnlyVisuals(): boolean {
  return process.env.CURATED_ARCHIVE_ONLY !== "false";
}

// F3-39: CURATED_ARCHIVE_ONLY's own doc comment above already says the external cascade is
// meant to run as a scene-level fallback in this mode — but getPipelinePerfProfile() forced
// enableArchival to false unconditionally whenever curatedArchiveOnlyVisuals() was true,
// which made that fallback structurally unreachable (fetchInternetArchiveClips/
// fetchHistoricalBeatVideo's internet_archive tier both gate on perf.enableArchival) instead of
// merely deprioritized. This flag controls only that override — the primary per-beat path
// (beatPrimaryFetch) never consults perf.enableArchival either way, so curated-archive-first
// behavior for the primary path is unaffected regardless of this flag's value. Default true
// (fallback reachable); set "false" to restore the old fully-archive-only behavior.
export function curatedArchiveExternalFallbackEnabled(): boolean {
  return process.env.CURATED_ARCHIVE_EXTERNAL_FALLBACK !== "false";
}

// ─── Visual Matching Engine V2 (build-out, off until proven — see /server/visualMatchingV2) ──

/** V2 VideoContext layer (one LLM call per video, cached/reused across videos). Inert until read by the active pipeline. */
export function visualMatchingV2ContextEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_CONTEXT === "true";
}

/** V2 VisualIntent Extractor (scene-batched, context-aware). Inert until read by the active pipeline. */
export function visualMatchingV2IntentEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_INTENT === "true";
}

/** V2 SourceAdapter framework (uniform candidate fetch across sources). Inert until read by the active pipeline. */
export function visualMatchingV2SourceAdaptersEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_ADAPTERS === "true";
}

/** V2 Candidate Fetcher (parallel search across all source adapters, search cache, fetch trace). Inert until read by the active pipeline. */
export function visualMatchingV2FetcherEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_FETCHER === "true";
}

/** V2 embedding infrastructure (provider interface, embedding cache, vector store, embedding search engine). Inert until read by the active pipeline. */
export function visualMatchingV2EmbeddingsEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_EMBEDDINGS === "true";
}

/** V2 Retrieval Orchestrator — single component deciding source order/parallelism/timeouts/
 *  fallback/dedup for every candidate fetch. Inert until read by the active pipeline. */
export function visualMatchingV2RetrievalOrchestratorEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_RETRIEVAL_ORCHESTRATOR === "true";
}

/** V2 Retrieval Strategy Engine — determines which retrieval strategy (mode, sources,
 *  timeouts, embedding/keyword flags) to use before the Orchestrator executes. Inert
 *  until read by the active pipeline. */
export function visualMatchingV2RetrievalStrategyEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_RETRIEVAL_STRATEGY === "true";
}

/** V2 CLIP Pre-Filter — second funnel stage (Candidate Pool -> top 3-5 by CLIP similarity).
 *  Wraps the existing localClipVision.ts CLIP infrastructure; no second CLIP implementation.
 *  Inert until read by the active pipeline. */
export function visualMatchingV2ClipPreFilterEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_CLIP_PREFILTER === "true";
}

/** V2 Candidate Ranking Layer — third funnel stage (CLIP Pre-Filter -> weighted ranking by
 *  existing retrieval signals, before LLM Vision scoring). Inert until read by the active
 *  pipeline. */
export function visualMatchingV2CandidateRankingEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_CANDIDATE_RANKING === "true";
}

/** V2 LLM Vision Scorer — fourth funnel stage (Ranked candidates -> per-dimension content
 *  scores via a single multi-image LLM call per beat). Inert until read by the active
 *  pipeline. */
export function visualMatchingV2VisionScorerEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_VISION_SCORER === "true";
}

/** V2 Candidate Selector — fifth and final funnel stage (scored candidates -> single winner
 *  or needsResearch signal). The only component in the V2 pipeline permitted to choose a
 *  winner. Inert until read by the active pipeline. */
export function visualMatchingV2SelectorEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_SELECTOR === "true";
}

/** V2 Pipeline Orchestrator — chains all V2 stages end-to-end for one scene.
 *  Off by default; enable only after individual stage flags have been validated.
 *  The active production pipeline is not affected regardless of this flag. */
export function visualMatchingV2PipelineEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_PIPELINE === "true";
}

/** V2 SelectionFeedback — enables human feedback submission on beat selections.
 *  Writes to selection_feedback + selection_feedback_events only; traces are immutable. */
export function visualMatchingV2SelectionFeedbackEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_SELECTION_FEEDBACK === "true";
}

/** V2 VideoQualityReport — generates aggregated quality reports from stored traces.
 *  Off by default; reads exclusively from beat_selection_traces and pipeline_run_traces. */
export function visualMatchingV2VideoQualityReportEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_VIDEO_QUALITY_REPORT === "true";
}

/** V2 PipelineRunTrace store — persists one run-level trace per complete video-scene run.
 *  Off by default; enable together with the pipeline flag for full observability. */
export function visualMatchingV2PipelineRunTraceEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_PIPELINE_RUN_TRACE === "true";
}

/** V2 BeatSelectionTrace store — persists SelectorTrace to the database after each beat.
 *  Off by default; enable to start recording selection decisions. Video production is
 *  unaffected if this flag is off or if the store write fails. */
export function visualMatchingV2BeatSelectionTraceEnabled(): boolean {
  return process.env.VISUAL_MATCHING_V2_BEAT_SELECTION_TRACE === "true";
}

/** Full external sourcing (YouTube, internet stills, Serp) — off by default; stock fallbacks still run in archive-first mode. */
export function externalVisualSourcingEnabled(): boolean {
  return process.env.ENABLE_EXTERNAL_VISUAL_SOURCING === "true";
}

/** Openverse CC stills — off in archive-first mode (unvetted random internet photos). */
export function openverseStillsEnabled(): boolean {
  if (process.env.ENABLE_OPENVERSE_STILLS === "false") return false;
  if (curatedArchiveOnlyVisuals()) return false;
  return true;
}

/** Openverse for geo/urban documentary beats even in archive-first strict mode. */
export function openverseGeoDocumentaryEnabled(): boolean {
  if (process.env.ENABLE_OPENVERSE_GEO === "false") return false;
  if (process.env.ENABLE_OPENVERSE_GEO === "true") return true;
  return strictVoiceVisualMatchEnabled() || visualFootageFocusEnabled();
}

/** Wikimedia Commons still photos — on when V1 matching is on (not random Openverse). */
export function wikimediaInternetStillsEnabled(): boolean {
  if (process.env.ENABLE_WIKIMEDIA_STILLS === "false") return false;
  return visualMatchingV1Enabled();
}

/** When true, voiceover uses ElevenLabs only (no Fish Audio). */
export function elevenLabsOnlyVoice(): boolean {
  if (process.env.ELEVENLABS_ONLY === "true") return true;
  if (process.env.ELEVENLABS_ONLY === "false") return false;
  return false;
}

/** Fish Audio when ElevenLabs fails (quota, 401). On by default when FISH_AUDIO_API_KEY is set. */
export function fishAudioFallbackEnabled(): boolean {
  if (process.env.ELEVENLABS_ONLY === "true") return false;
  return Boolean(process.env.FISH_AUDIO_API_KEY?.trim());
}

/** Google Cloud TTS as the final voiceover fallback (after ElevenLabs → Fish Audio both fail/are
 *  unconfigured). On by default when GOOGLE_TTS_API_KEY is set — free up to 1M chars/month
 *  (Neural2 voices) and, unlike ElevenLabs/Fish Audio's free tiers, explicitly licensed for
 *  commercial use. */
export function googleTtsFallbackEnabled(): boolean {
  if (process.env.ELEVENLABS_ONLY === "true") return false;
  return Boolean(process.env.GOOGLE_TTS_API_KEY?.trim() || process.env.GOOGLE_CLOUD_TTS_API_KEY?.trim());
}

/** Burn typewriter keywords on clips — default OFF (footage + voice only). Set ENABLE_FACELESS_SUBTITLES=true to enable. */
export function facelessSubtitlesEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.ENABLE_FACELESS_SUBTITLES === "true";
}

/** Extra on-screen overlays (stat pills, film grain, motion graphics cards). Default OFF. */
export function extraOnScreenTextEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.ENABLE_EXTRA_ONSCREEN_TEXT === "true";
}

/** When extra overlays are off, skip cinematic pills/grain (year labels use screenLabelsEnabled). */
export function yearsOnlyOnScreen(): boolean {
  return !extraOnScreenTextEnabled();
}

/** Year/stat labels burned on footage — default OFF. Set ENABLE_SCREEN_LABELS=true to enable. */
export function screenLabelsEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.ENABLE_SCREEN_LABELS === "true";
}

/** When true (default), use Pexels stock if no archive clip matches a sentence. */
export function archivePexelsFallbackEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_FALLBACK !== "false";
}

/** Pexels/Pixabay after Wikimedia + archive misses (default on). */
export function archivePexelsHybridEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_HYBRID !== "false" && archivePexelsFallbackEnabled();
}

/** Cap licensed stock (Pexels/Pixabay) per video — last resort; 0 when strict visual focus. */
export function curatedMaxStockBeatsPerVideo(videoLength?: string | null): number {
  if (!archivePexelsFallbackEnabled()) return 0;
  if (visualFootageFocusEnabled() && strictVoiceVisualMatchEnabled()) {
    const mins = targetVideoDurationMinutes(videoLength);
    if (mins <= 1) return 12;
    return 2;
  }
  const raw = process.env.MAX_STOCK_BEATS_PER_VIDEO?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 1;
  if (mins <= 10) return 2;
  return 3;
}

/** Max AI-generated clips when stock cap is full — 0 under visual focus (archive/stock only). */
export function curatedAiFallbackMaxClips(videoLength?: string | null): number {
  if (visualFootageFocusEnabled()) return 0;
  const raw = process.env.MAX_AI_CLIPS_PER_VIDEO?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 12;
  if (mins <= 10) return 20;
  return 28;
}

/** When true (default in archive-first mode), Pexels/Pixabay are tightly capped per video. */
export function curatedMinimizeStockFootage(): boolean {
  return process.env.MINIMIZE_STOCK_FOOTAGE !== "false";
}

/** Fail generation rather than loop, pad, or reuse any clip content in a video. */
export function strictNoVisualRepeat(): boolean {
  if (process.env.STRICT_NO_VISUAL_REPEAT === "false") return false;
  return curatedArchiveOnlyVisuals();
}

/** Subtle film grain + light flash overlays in effects pass. */
export function documentaryOverlaysEnabled(): boolean {
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_DOC_OVERLAYS !== "false";
}

/** Generation wall-clock minutes allowed per 1 minute of finished video (default 10:1). */
export function pipelineMinutesPerVideoMinute(): number {
  const raw = process.env.PIPELINE_MIN_PER_VIDEO_MIN?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 20) return n;
  }
  return 10;
}

/** Multiplier on target budget before hard-fail (default 1.3 → ~13 min pipeline per 1 min video). */
export function pipelineWallClockGraceFactor(): number {
  const raw = process.env.PIPELINE_WALL_CLOCK_GRACE?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1.05 && n <= 1.5) return n;
  }
  return 1.3;
}

/**
 * When true, enforce hard wall-clock fail + router race timeout. Default ON.
 *
 * RONDE 30: this doc comment used to say "Default OFF — jobs finish at their own pace", which
 * contradicted the code below it. Two test files (beatVisualRescue, pipelineStall) asserted the
 * documented OFF and had been failing ever since, unnoticed inside the known-failing baseline.
 *
 * Corrected the comment rather than the code: the watchdog work from RONDE 20/21/25 is built on
 * a render budget existing — RenderWatchdog derives its idle limit from the whole render budget,
 * and maxPipelineWallClockMin() returns PIPELINE_UNLIMITED_MS when this is off. Flipping the
 * default to match the old comment would silently remove the ceiling that stops a hung render
 * from running for hours. That is a product decision, not a test repair, so it is flagged rather
 * than made here.
 */
export function pipelineWallClockLimitEnabled(): boolean {
  return process.env.PIPELINE_WALL_CLOCK_LIMIT !== "false";
}

/** Re-queue jobs with no DB heartbeat (independent of wall-clock limit). Default ON. */
export function pipelineProgressStallRecoveryEnabled(): boolean {
  return process.env.PIPELINE_PROGRESS_STALL_RECOVERY !== "false";
}

/** Max automatic stall recoveries per video before marking failed. */
export function pipelineMaxStallRecoveries(): number {
  const raw = process.env.PIPELINE_MAX_STALL_RECOVERIES?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 10) return n;
  }
  return 3;
}

/**
 * No progress heartbeat (updatedAt stale) → zombie worker detection.
 * Used when wall-clock limit is off; also caps script/voice stalls when limit is on.
 */
export function pipelineProgressStallThresholdMs(
  videoLength?: string | null,
  status?: string | null
): number {
  const raw = process.env.PIPELINE_PROGRESS_STALL_MIN?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 3 && n <= 60) return Math.round(n * 60_000);
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (status === "generating_script" || status === "generating_voiceover") {
    return 10 * 60_000;
  }
  if (status === "generating_visuals") {
    return mins <= 1 ? 25 * 60_000 : 35 * 60_000;
  }
  if (status === "generating_effects") {
    return mins <= 1 ? 20 * 60_000 : 30 * 60_000;
  }
  return 15 * 60_000;
}

/** Practical "no limit" for withTimeout / setTimeout (7 days — below Node's max delay). */
export const PIPELINE_UNLIMITED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Target end-to-end generation budget (minutes).
 * 1-min videos: 9 min target; longer videos: video_minutes × PIPELINE_MIN_PER_VIDEO_MIN (default 10).
 */
export function maxPipelineWallClockMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const override = process.env.MAX_PIPELINE_WALL_CLOCK_MIN?.trim();
  if (override) {
    const n = parseInt(override, 10);
    if (!isNaN(n) && n >= 8 && n <= 300) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 20;
  return Math.round(mins * pipelineMinutesPerVideoMinute());
}

/** Hard wall-clock fail — 1-min videos: 22 min; longer: target × grace.
 *  Was 15 min — that only left ~8 min after the 7-min visual-sourcing emergency-finish
 *  cutoff for compose + assembly + upload, which we've measured taking 5+ min per scene
 *  under load on its own. Widened so a render that's merely slow (not actually stuck)
 *  gets to finish instead of being killed with a wall-clock error — the stall detector
 *  (server/db.ts, updatedAt-based) still catches a render that's genuinely hung. */
export function maxPipelineWallClockHardMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 22;
  return Math.ceil(maxPipelineWallClockMin(videoLength) * pipelineWallClockGraceFactor());
}

/** After this many ms on 1-min fast path, prefer licensed stock over slow archive retries. */
export function pipelineRushModeMs(videoLength?: string | null): number {
  const raw = process.env.PIPELINE_RUSH_MODE_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 90_000 && n <= 540_000) return n;
  }
  // RONDE 8: keeps its position ABOVE the widened 5min turbo threshold (ladder order
  // turbo < rush < emergency must hold — each rung is compared against the same clock).
  return escalationThresholdMs(videoLength, RUSH_FRACTION);
}

/** Near hard cap — finish compose before wall-clock hard fail (quality path keeps archive longer on 1-min). */
export function pipelineEmergencyFinishMs(videoLength?: string | null): number {
  const raw = process.env.PIPELINE_EMERGENCY_FINISH_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 300_000 && n <= 900_000) return n;
  }
  // RONDE 8: shifted up with the turbo/rush rungs (5/7/9). Still far under the 22min
  // wall-clock hard cap for 1-min videos, and the clock starts at the visual stage (FIX 7).
  return escalationThresholdMs(videoLength, EMERGENCY_FRACTION);
}

/** 1-min Railway: hard-cut plain montage — skip cinematic/year-label compose passes. */
export function fastShortPlainComposeEnabled(videoLength?: string | null): boolean {
  if (!isFastShortVideoLength(videoLength)) return false;
  if (process.env.FAST_SHORT_PLAIN_COMPOSE === "false") return false;
  return true;
}

/** 1-min: compose may only read clips already on disk — no Wikimedia/Pexels/archive fetch during render. */
export function composeLocalClipsOnly(videoLength?: string | null): boolean {
  if (!isFastShortVideoLength(videoLength)) return false;
  if (process.env.COMPOSE_LOCAL_CLIPS_ONLY === "false") return false;
  return true;
}

/** Extra wall-clock after hard cap while compose/upload finishes (1-min fast path). */
export function pipelineComposeGraceMs(videoLength?: string | null): number {
  const raw = process.env.PIPELINE_COMPOSE_GRACE_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30_000 && n <= 300_000) return n;
  }
  return isFastShortVideoLength(videoLength) ? 240_000 : 0;
}

/** ≤1 min videos — fast archive-first path (independent of wall-clock limit). */
export function isFastShortVideoLength(videoLength?: string | null): boolean {
  return targetVideoDurationMinutes(videoLength) <= 1;
}

/** Parallel beat fills on fast path. Was tuned for Railway's 24 vCPU box; the current
 *  Hetzner host has 4 vCPU total, shared with archive downloads, compose, and montage
 *  encodes — 6-way beat concurrency on top of that oversubscribed the box badly enough
 *  that per-clip probe checks (ComposeGate) routinely starved past their own timeout.
 *  isRailway is accepted but no longer used to scale this up — the box is what it is. */
export function fastBeatConcurrency(isRailway = false): number {
  const raw = process.env.FAST_BEAT_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 12) return n;
  }
  return 2;
}

/** Weak-beat archive polish before compose (always on when strict voice↔visual match). */
export function polishBeforeComposeEnabled(
  videoLength?: string | null,
  fastMode = false
): boolean {
  if (process.env.ENABLE_POLISH_BEFORE_COMPOSE === "false") return false;
  if (isFastShortVideoLength(videoLength)) return false;
  if (strictVoiceVisualMatchEnabled()) return true;
  if (fastMode && isFastShortVideoLength(videoLength)) return false;
  return true;
}

/** Parallel scene compose jobs. Was tuned for Railway's 24 vCPU/24GB RAM box; the current
 *  Hetzner host has 4 vCPU, so this now stays modest regardless of video length rather than
 *  scaling up for longer videos. Override via COMPOSE_PARALLELISM. */
/**
 * RONDE 63: how many CPUs this process may actually use.
 *
 * `os.cpus().length` reports the HOST's cores, not the container's share, so inside a cgroup it
 * can be wildly optimistic — which is the trap the numbers below have to avoid. The cgroup quota
 * is the real answer when there is one; the host count is the fallback.
 *
 * Cached: the quota does not change under a running process, and this is read on every compose.
 */
let cachedCpuCount: number | null = null;
export function availableCpuCount(): number {
  if (cachedCpuCount != null) return cachedCpuCount;
  const hostCount = Math.max(1, os.cpus().length);
  let quota = 0;
  try {
    // cgroup v2: "<quota> <period>", or "max <period>" when uncapped.
    const v2 = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (v2.length === 2 && v2[0] !== "max") {
      const q = Number.parseInt(v2[0]!, 10);
      const p = Number.parseInt(v2[1]!, 10);
      if (q > 0 && p > 0) quota = q / p;
    }
  } catch {
    try {
      // cgroup v1: -1 means uncapped.
      const q = Number.parseInt(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim(), 10);
      const p = Number.parseInt(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim(), 10);
      if (q > 0 && p > 0) quota = q / p;
    } catch {
      /* no cgroup limits readable — the host count stands */
    }
  }
  cachedCpuCount = Math.max(1, Math.floor(quota > 0 ? Math.min(quota, hostCount) : hostCount));
  return cachedCpuCount;
}

/** Test seam — the quota cannot change under a running process, so this is only for tests. */
export function _resetCpuCountCache(): void {
  cachedCpuCount = null;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * RONDE 63: scenes composed at once.
 *
 * This returned a flat 2 because it was tuned, per the comment it used to carry, for "the current
 * Hetzner host [with] 4 vCPU total". Render 532 ran on a box reporting 48 cores, and between this,
 * montageSegmentParallelism and the 2-thread ffmpeg flag the render used four of them.
 *
 * Deriving it from what is actually available keeps the old behaviour on a small box — a 4-core
 * host still gets 2 — and uses a large one.
 */
export function composeParallelismForVideo(videoLength?: string | null, isRailway = false): number {
  const raw = process.env.COMPOSE_PARALLELISM?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 6) return n;
  }
  return clampInt(availableCpuCount() / 12, 2, 4);
}

/**
 * Parallel montage segment encodes within a scene.
 *
 * RONDE 63: was a flat 2 for the same stale reason as composeParallelismForVideo — see there.
 * Derived from the real CPU allowance now, and still 2 on a small host.
 */
export function montageSegmentParallelism(isRailway = false): number {
  const raw = process.env.MONTAGE_SEGMENT_PARALLELISM?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 4) return n;
  }
  return clampInt(availableCpuCount() / 16, 2, 3);
}

/** FFmpeg thread cap per encode. Was 4 threads/process for Railway's 24 vCPU box; the
 *  current Hetzner host has 4 vCPU total, and several encodes now run concurrently
 *  (compose × montage-segment parallelism above), so each process gets fewer threads
 *  to avoid oversubscribing the whole box by itself.
 *  Without a cap, libx264 defaults to one thread per CPU core; under heavy concurrent
 *  encoding that can make libx264's own thread-pool creation fail outright, surfacing as
 *  a generic "Error while opening encoder" even though the command itself is fine.
 *  isRailway defaults from the same env check videoPipeline.ts uses, so callers in other
 *  modules (e.g. documentaryStyle.ts) don't need their own copy of that detection. */
export function ffmpegThreadFlag(isRailway = !process.env.BUILT_IN_FORGE_API_KEY): string {
  const raw = process.env.FFMPEG_THREADS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (n && !isNaN(n) && n >= 1) return `-threads ${Math.min(6, n)}`;
    return "";
  }
  // RONDE 63: split what is left between the encodes that will be running at once, rather than
  // handing every process a flat 2 threads. compose × montage-segment is the concurrency this
  // has to share with; the floor of 2 keeps the old behaviour on a small host.
  const concurrent = Math.max(1, composeParallelismForVideo() * montageSegmentParallelism());
  return `-threads ${clampInt(availableCpuCount() / concurrent, 2, 6)}`;
}

/** Burn faceless subtitles during montage segment encode (only when faceless subs enabled). */
export function deferFacelessSubtitlesToCompose(): boolean {
  if (!facelessSubtitlesEnabled()) return false;
  return process.env.ENABLE_DEFER_FACELESS_SUBTITLES !== "false";
}

/** No score self-heal; hard fail on sync/fallback beats — opt-in via ENABLE_QUALITY_EXPORT_HARD_TIER=true. */
export function qualityExportHardTierEnabled(): boolean {
  return process.env.ENABLE_QUALITY_EXPORT_HARD_TIER === "true";
}

/**
 * Strict voice↔visual CLIP matching — every beat must pass vision gate (default ON).
 * Set STRICT_VOICE_VISUAL_MATCH=false to restore relaxed fast-path scoring.
 */
export function strictVoiceVisualMatchEnabled(): boolean {
  return process.env.STRICT_VOICE_VISUAL_MATCH !== "false";
}

/**
 * Hard metadata blocks (geo tags, WWII, cycling-only, title domain rules, vision geo gate).
 * Default OFF — only the CLIP vision gate decides topic/script/voiceover fit.
 * Set ENABLE_METADATA_VISUAL_BLOCKS=true to restore legacy pre-filters.
 */
export function metadataVisualBlocksEnabled(): boolean {
  return process.env.ENABLE_METADATA_VISUAL_BLOCKS === "true";
}

/** Allow export when rescue tiers used (default ON with beat visual rescue). */
export function allowDegradedVisualExport(): boolean {
  if (process.env.ALLOW_DEGRADED_VISUAL_EXPORT === "false") return false;
  return beatVisualRescueEnabled();
}

/**
 * When no clip passes strict CLIP match, run a degraded rescue ladder instead of failing export.
 * Default ON — rescue uses lower CLIP floor, then stock, AI, then neutral placeholder still.
 */
export function beatVisualRescueEnabled(): boolean {
  return process.env.BEAT_VISUAL_RESCUE !== "false";
}

/** Min CLIP score (0–10) for rescue-tier archive/stock (default 5). */
export function beatVisualRescueVisionFloor(): number {
  const raw = process.env.BEAT_VISUAL_RESCUE_FLOOR?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 4 && n <= 7) return n;
  }
  return 5;
}

/** Max AI-generated clips in rescue tier only (strict match still blocks normal AI). */
export function beatVisualRescueAiMaxClips(videoLength?: string | null): number {
  if (!beatVisualRescueEnabled()) return 0;
  const raw = process.env.BEAT_VISUAL_RESCUE_AI_MAX?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 6) return n;
  }
  return isFastShortVideoLength(videoLength) ? 2 : 3;
}

/** 1-min archive pool warm — candidates pre-ranked for the whole video (default 200). */
export function fastShortArchivePoolMax(): number {
  const raw = process.env.FAST_ARCHIVE_POOL_MAX?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 60 && n <= 480) return n;
  }
  return 200;
}

/** Wall-clock ms to warm archive pool before 1-min visual stage (default 18s). */
export function fastShortArchivePoolWarmMs(): number {
  const raw = process.env.FAST_ARCHIVE_POOL_WARM_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 8_000 && n <= 45_000) return n;
  }
  return 18_000;
}

/** CLIP index pre-warm before 1-min visuals — max assets / budget ms. */
export function fastShortClipIndexPrewarmMax(): number {
  const raw = process.env.FAST_CLIP_INDEX_PREWARM_MAX?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 12 && n <= 120) return n;
  }
  return 48;
}

export function fastShortClipIndexPrewarmMs(): number {
  const raw = process.env.FAST_CLIP_INDEX_PREWARM_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 15_000 && n <= 90_000) return n;
  }
  return 45_000;
}

/** Max grey color-fallback beats per video (0 when strict match is on). */
export function maxFallbackBeatsPerVideo(): number {
  const raw = process.env.MAX_FALLBACK_BEATS_PER_VIDEO?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }
  if (beatVisualRescueEnabled()) return 20;
  return strictVoiceVisualMatchEnabled() ? 0 : 6;
}

/** Block export when visuals fail CLIP bar / use grey fallbacks (default on with strict match). */
export function blockExportOnVisualMismatch(): boolean {
  if (process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH === "false") return false;
  if (allowDegradedVisualExport()) return false;
  return strictVoiceVisualMatchEnabled();
}

/** Skip LLM semantic rerank when CLIP pre-rank top score ≥ this (default 8). */
export function semanticRerankClipSkipMin(): number {
  const raw = process.env.SEMANTIC_RERANK_CLIP_SKIP_MIN?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
}

/**
 * Prioritize archive + CLIP match over speed/stock (default ON with strict voice↔visual).
 * Raises per-beat archive tries and minimizes generic stock.
 */
export function visualFootageFocusEnabled(): boolean {
  if (process.env.VISUAL_FOOTAGE_FOCUS === "false") return false;
  return strictVoiceVisualMatchEnabled();
}

/** Max archive candidates to try per beat when wall-clock limit is on. Raised now that
 *  Railway has 24 vCPU headroom — more candidates per beat means a better CLIP match
 *  without slowing the video down, since beats are fetched/scored concurrently. */
export function maxVisualCandidatesPerBeatTry(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) return 14;
  if (isFastShortVideoLength(videoLength)) return 8;
  if (visualFootageFocusEnabled()) return 8;
  return 6;
}

/** Wall-clock budget for the visual sourcing stage (minutes). */
export function visualStageWallClockMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const total = maxPipelineWallClockMin(videoLength);
  const hard = maxPipelineWallClockHardMin(videoLength);
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) {
    return 8;
  }
  return Math.max(8, Math.min(total - 6, Math.round(total * 0.88)));
}

/** Stock clips on 1-min fast path — slightly lower bar than archive (7 vs 8) for speed. */
export function stockClipQualityFloor(videoLength?: string | null): number {
  if (isFastShortVideoLength(videoLength) && strictVoiceVisualMatchEnabled()) return 7;
  const raw = process.env.MIN_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
}

/** Beat cadence for 1-min fast path — fewer beats → faster visual stage (default 24s). */
// F3-23: this used to default to 24s (allowed range 12-24s) — on the 1-min fast/short path
// (isFastShortVideoLength), this value is used directly as several beats' holdSec (see e.g.
// videoPipeline.ts's fetchArchivalMontageBeat/rescue-clip call sites), so a single archive clip
// could be held on screen for up to 24s — nearly half of a 60s video. That's the exact "same
// image held far too long" defect a critical review of the "Why Hitler Killed Himself" 1-min
// render flagged. minBeatsForVisualCadence/maxBeatCapForVisualCadence's beat-count math already
// targets ~6s/beat regardless of video length (sceneBeatCapForCadenceForVideo's own comment), so
// tightening just this single hold-duration ceiling doesn't reduce how many distinct visuals a
// scene gets — it only stops any one of them from being held far longer than the others.
export function archiveVisualBeatSecForVideo(videoLength?: string | null): number {
  if (!isFastShortVideoLength(videoLength)) return archiveVisualBeatSec();
  const raw = process.env.FAST_ARCHIVE_BEAT_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 6 && n <= 12) return n;
  }
  return 10;
}


/**
 * RONDE 81 — the escalation thresholds, for every video length.
 *
 * The turbo / rush / emergency-finish ladder existed only for 1-minute videos: the three
 * predicates in videoPipeline.ts all opened with isFastShortVideoLength and returned false
 * otherwise, so a long video had no way to shed work as its deadline approached. It ran every
 * beat at the full budget until a stage deadline killed it. The values below the guard
 * (12s turbo, 3min rush, 7min emergency) were dead code for long videos and are far too tight
 * to simply switch on — a 20-minute video would have force-exported after seven minutes.
 *
 * The ladder is therefore expressed as a fraction of the length's own wall-clock target, using
 * the fractions the 1-minute path already proves work: 5/20, 7/20 and 9/20 of its 20-minute
 * target. A 1-minute video keeps exactly the thresholds it has today; every other length gets
 * the same shape, scaled to its own budget.
 */
function escalationThresholdMs(videoLength: string | null | undefined, fraction: number): number {
  return Math.round(maxPipelineWallClockMin(videoLength) * 60_000 * fraction);
}

/** Ladder order must hold — turbo < rush < emergency — against the same clock. */
const TURBO_FRACTION     = 0.25;
const RUSH_FRACTION      = 0.35;
const EMERGENCY_FRACTION = 0.45;

/** Wall-clock ms after pipeline start before turbo stock fallback on 1-min videos (default 12s; 3min on 1-min quality path). */
export function visualSourcingTurboMs(videoLength?: string | null): number {
  const raw = process.env.VISUAL_SOURCING_TURBO_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 8_000 && n <= 300_000) return n;
  }
  // RONDE 8 (render 518): 3min was too tight — the visual stage for a 3-scene 1-min video
  // took ~5min (scenes fill partly sequentially; IA search+metadata dominates), so the LAST
  // scene always landed in 12s turbo budgets and dropped its beats. The wall-clock hard cap
  // for 1-min videos is 22min, so 5min turbo still leaves ample headroom.
  return escalationThresholdMs(videoLength, TURBO_FRACTION);
}

/** Max ms per beat spent trying archive candidates before moving on. Beats are processed
 *  concurrently (fastBeatConcurrency) so this does NOT add up serially. Archive lookup
 *  is an embedding search — if nothing is found in 20s it won't be found at all. */
export function archiveBeatTryTimeoutMs(videoLength?: string | null): number {
  const raw = process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 4_000 && n <= 120_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 18_000;
  return 30_000;
}

/**
 * Wall-clock that must survive the sourcing stage, whatever else happens.
 *
 * Compose, concat, the music mix and the upload still have to run after every beat is decided.
 * Video 552 spent 33.5s on assemble+music and 12.2s on upload, with compose the large item; four
 * minutes is comfortably above that and is the amount no beat may eat into.
 */
export const SOURCING_RESERVE_MS = 240_000;

/**
 * How many further beats to assume are still waiting when handing one of them extra time.
 *
 * Nothing at the call site knows the real number, and guessing low would let one beat spend
 * headroom that twenty beats need. Video 552 had 22 beats, so twenty is a realistic worst case
 * rather than a flattering one: if every remaining beat took the extended budget, the render still
 * lands inside the reserve.
 */
const BEATS_ASSUMED_REMAINING = 20;

/** Never more than this multiple of the base, however much clock is left. */
const MAX_BEAT_BUDGET_MULTIPLE = 3;

/**
 * RONDE 159 — spend the clock the render actually has.
 *
 * Video 552 abandoned three beats on "archive beat budget exceeded — exceeded 18s" and then
 * finished the whole render in 10m 19s of a 22m budget: 47% used, 11m 41s left unspent. Footage
 * was thrown away for want of time by a render that had time to spare, and the beats it gave up on
 * are the ones that ended as coloured placeholder cards.
 *
 * The base stays the base. It is raised only out of headroom that genuinely exists, bounded three
 * ways so a generous clock cannot turn into an overrun: the reserve is untouchable, one beat may
 * take at most its share of what is left, and the result is capped at a multiple of the base.
 *
 * A render that is behind schedule gets exactly the old number, which is the case the 18s was
 * chosen for.
 */
export function archiveBeatBudgetMs(
  videoLength?: string | null,
  remainingWallClockMs?: number | null
): number {
  const base = archiveBeatTryTimeoutMs(videoLength);
  // An explicit override is an instruction, not a starting point.
  if (process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim()) return base;
  if (remainingWallClockMs == null || !Number.isFinite(remainingWallClockMs)) return base;
  const headroom = remainingWallClockMs - SOURCING_RESERVE_MS;
  if (headroom <= 0) return base;
  const share = Math.floor(headroom / BEATS_ASSUMED_REMAINING);
  return Math.min(Math.max(base, share), base * MAX_BEAT_BUDGET_MULTIPLE);
}

/**
 * RONDE 159 — may the compose stage still fetch, for a scene that has too little footage?
 *
 * composeLocalClipsOnly exists for a real reason: on the short-video path, compose runs against a
 * deadline and a fetch there can blow it. But it was unconditional, and video 552 shows what that
 * costs when it fires on a starved scene:
 *
 *     Scene 2: 2/7 compose-ready clips — pre-compose cache fill
 *     Scene 2: compose local-only — blocked visual rescue        (13 blocks in that render)
 *     12 assets VANISHED_WITHOUT_OUTCOME — found, chosen, never on disk
 *
 * Two clips for 21.5s of narration, and that shortfall is precisely the gap RONDE 157 and 158
 * had to fill with slowed and replayed footage. The footage existed; the render refused to go
 * and get it while holding eleven minutes of unused budget.
 *
 * So the block is kept, and lifted only where it is doing harm: a scene genuinely short of clips,
 * with real headroom left. A scene that has what it needs still never fetches at compose time.
 */
export function composeMayFetchForStarvedScene(params: {
  videoLength?: string | null;
  clipsOnDisk: number;
  clipsNeeded: number;
  remainingWallClockMs?: number | null;
}): boolean {
  // Not in local-only mode at all — fetching was never blocked, so there is nothing to lift.
  if (!composeLocalClipsOnly(params.videoLength)) return true;
  if (process.env.COMPOSE_LOCAL_CLIPS_ONLY === "true") return false;
  const { clipsOnDisk, clipsNeeded, remainingWallClockMs } = params;
  if (!(clipsNeeded > 0)) return false;
  // "Starved" means the montage cannot be built from what is here, not merely that it is thinner
  // than planned: below half of what the scene asked for.
  if (clipsOnDisk * 2 >= clipsNeeded) return false;
  if (remainingWallClockMs == null || !Number.isFinite(remainingWallClockMs)) return false;
  return remainingWallClockMs - SOURCING_RESERVE_MS > 0;
}

/**
 * RONDE 20: hard wall-clock cap for ONE scene's compose-time rescue (recoverSceneClipsIfEmpty).
 *
 * That path was the only major stage with no time bound at all: it loops up to ~7 fallback texts,
 * each running the full external cascade (Internet Archive, YouTube CC, Wikimedia, GDELT, ...).
 * Render 526 spent 1084s of its 25 min there — the single largest cost — and render 527 HUNG in it
 * outright: one await never settled after a GDELT "Archive TV metadata" timeout, so the pipeline
 * sat at zero activity until the watchdog gave up 22 minutes later. A cap turns "hangs forever"
 * into "returns what it found so far and moves on".
 *
 * Deliberately generous — this is a safety valve, not a pacing knob: it must not cut short a
 * rescue that is genuinely still finding footage, only stop an unbounded one.
 */
/**
 * RONDE 23: run the baked-in-text check on EXTERNALLY sourced beat clips, not just curated ones.
 *
 * archiveClipHasBakedEditText existed but was wired into exactly one call site: the curated
 * archive's own adoption path. Every external source — YouTube CC, GDELT TV news, Internet
 * Archive, SepiaSearch, Wikimedia, Openverse, SerpAPI, stock — reached the timeline with no
 * text check at all. GDELT is the clearest case: it serves CNN/FOX/MSNBC/BBC broadcast segments,
 * which essentially always carry lower-thirds and news tickers.
 *
 * Default on. Turn off with ENABLE_BEAT_CLIP_TEXT_FILTER=false. The underlying check has its own
 * independent kill switch (ENABLE_ARCHIVE_OVERLAY_FILTER) and returns "no text" when it has no
 * vision key, so this stays inert rather than rejecting everything when unconfigured.
 */
export function beatClipTextFilterEnabled(): boolean {
  return envFlagIsNotOff("ENABLE_BEAT_CLIP_TEXT_FILTER");
}

/**
 * RONDE 25: how many DISTINCT clips one render may text-check before the filter stops spending.
 *
 * Each check costs an ffprobe, two ffmpeg frame extractions and an LLM vision call (up to 18s) —
 * and the ffmpeg work queues behind the render's own on a semaphore of 3. Render 526/527 put 64
 * distinct clips through the shared beat gate, so RONDE 23 was unbounded: worst case roughly 64
 * vision calls and 128 extra ffmpeg operations on a render that already took 25 minutes. The
 * detector's existing ARCHIVE_OVERLAY_MAX_CLIPS valve does not apply here — it is driven by an
 * opts.clipCount the beat gate has no meaningful value for.
 *
 * The cap counts only cache MISSES, so re-offering the same asset to many beats stays free and a
 * normal render never reaches it. Past the cap the filter allows clips through rather than
 * rejecting them: refusing everything once the budget ran out would starve the cascade, which is
 * a worse failure than the text it is guarding against. Every skip is logged.
 */
export function beatClipTextFilterMaxChecks(): number {
  const raw = process.env.BEAT_CLIP_TEXT_FILTER_MAX_CHECKS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 500) return n;
  }
  return 40;
}

/**
 * RONDE 21: stall (idle) timeout for a download's BODY read.
 *
 * fetchWithTimeout arms an AbortController, awaits fetch(), then clears its timer in `finally`.
 * fetch() resolves as soon as the response HEADERS arrive — so by the time the caller streams the
 * actual bytes, that timer is already disarmed and nothing covers the transfer. Node streams have
 * no default inactivity timeout either, so a server that sends headers and then goes quiet (socket
 * open, zero bytes — routine for overloaded archive hosts) parks `await pipeline(...)` forever.
 * That is exactly how render 527 hung: one stalled body read, the whole render stopped behind it.
 *
 * This is deliberately an IDLE timeout, not a total-duration one: it measures the gap between
 * chunks, so a large file that is slowly but steadily arriving is never interrupted, while a
 * transfer that has genuinely stopped delivering is cut loose. Making it a total cap instead would
 * break legitimate slow downloads — the failure mode we are fixing is "no progress", not "slow".
 */
export function downloadStallTimeoutMs(): number {
  const raw = process.env.DOWNLOAD_STALL_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5_000 && n <= 300_000) return n;
  }
  return 30_000;
}

/**
 * RONDE 27: total budget for pulling one YouTube source file down.
 *
 * Was a flat 90s, and render 528 lost every YouTube clip to it — three relevant WWII finds, three
 * timeouts, nothing in the cut. Raising a total budget used to be dangerous because a stalled
 * connection would sit there consuming all of it; since RONDE 21 the body read has its own
 * 30s idle guard (downloadStallTimeoutMs), so a dead transfer now dies on idle rather than on
 * total time. That is what makes a longer ceiling safe: this budget is for a download that is
 * genuinely still moving, not for one that has hung.
 */
/**
 * How many YouTube videos one RENDER may download before the source stands down.
 *
 * RONDE 62 introduced this per scene; RONDE 68 discovered it was really per CALL, because the
 * counter was a local in a function invoked about twenty-six times per render. Render 533:
 *
 *     26 x "download ceiling reached (6/6 attempts, 0 accepted)"
 *     150 x "RapidAPI YouTube download ... cancelled by the enclosing scene budget"
 *
 * 26 x 6 = 156. The ceiling fired on every call and bounded nothing, and those 150 abandoned
 * video transfers are what left no scene budget for anything else — Wikimedia ran 0 searches
 * that render, Internet Archive downloaded 0 of 12 results, and the montage fell back to stock.
 *
 * 20 is deliberately generous: YouTube must stay a real participant, it just cannot be allowed
 * to spend the whole render's fetch budget on material it has yet to contribute a single clip
 * from in three renders.
 */
export function youtubeMaxDownloadsPerRender(): number {
  const raw = process.env.YOUTUBE_MAX_DOWNLOADS_PER_RENDER?.trim() ?? process.env.YOUTUBE_MAX_DOWNLOAD_ATTEMPTS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 200) return n;
  }
  return 20;
}

export function youtubeDownloadTimeoutMs(): number {
  const raw = process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30_000 && n <= 600_000) return n;
  }
  return 180_000;
}

/**
 * RONDE 27: lowest source height still worth downloading from YouTube.
 *
 * The clip is scaled into a 1920x1080 frame as B-roll behind narration. Below this the source
 * starts to look soft enough to notice; at or above it, the smallest file wins on download time.
 */
export function youtubeMinFormatHeight(): number {
  const raw = process.env.YOUTUBE_MIN_FORMAT_HEIGHT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 144 && n <= 1080) return n;
  }
  return 480;
}

export function composeRescueWallClockMs(videoLength?: string | null): number {
  const raw = process.env.COMPOSE_RESCUE_WALL_CLOCK_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30_000 && n <= 900_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 90_000;
  return 240_000;
}

/** Target on-screen duration per archive clip (seconds). */
export function archiveVisualBeatSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_BEAT_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 8) return n;
  }
  return 6;
}

/** Hard limits for archive clip length in generated videos. */
export function archiveVisualMinClipSec(): number {
  return 5;
}

export function archiveVisualMaxClipSec(): number {
  const raw = process.env.ARCHIVE_VISUAL_MAX_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 8) return n;
  }
  return 8;
}

/** Min beats per scene so no single shot exceeds archiveVisualMaxClipSec (default 8s). */
export function minBeatsForVisualCadence(sceneDurationSec: number): number {
  if (sceneDurationSec <= 0) return 1;
  return Math.max(1, Math.ceil(sceneDurationSec / archiveVisualMaxClipSec()));
}

/** Max beats per scene so clips stay at least archiveVisualMinClipSec (default 5s). */
export function maxBeatCapForVisualCadence(sceneDurationSec: number): number {
  if (sceneDurationSec <= 0) return 2;
  return Math.max(
    minBeatsForVisualCadence(sceneDurationSec),
    Math.ceil(sceneDurationSec / archiveVisualMinClipSec())
  );
}

/**
 * Beat cap for one scene — targets ~5–8s per visual (sentence length still splits within this band).
 * perfFloor is a profile minimum, not a ceiling.
 */
export function sceneBeatCapForCadence(
  sceneDurationSec: number,
  perfFloor = 1,
  beatSec = archiveVisualBeatSec()
): number {
  const minBeats = minBeatsForVisualCadence(sceneDurationSec);
  const maxBeats = maxBeatCapForVisualCadence(sceneDurationSec);
  const target = Math.max(minBeats, Math.ceil(sceneDurationSec / beatSec));
  const cappedFloor = Math.min(Math.max(1, perfFloor), maxBeats);
  return Math.max(minBeats, Math.min(maxBeats, Math.max(target, cappedFloor)));
}

/**
 * Beat cap per scene.
 *
 * RONDE 30: the comment here used to say "on 1-min fast path one archive clip covers the full
 * beat window", which stopped being true when the body was changed to always use the standard
 * 6s cadence (see the inline note below — that change was deliberate and is kept). Two
 * consequences were left behind: this comment described behaviour that no longer existed, and
 * `videoLength` became an ignored parameter — the exact shape of bug that made the protest
 * filter inert. Renamed to `_videoLength` so the signature says out loud that it is not read;
 * callers are unaffected because it is positional.
 */
export function sceneBeatCapForCadenceForVideo(
  sceneDurationSec: number,
  perfFloor = 1,
  _videoLength?: string | null,
  beatSec?: number
): number {
  // Always use the standard cadence (archiveVisualBeatSec = 6s) so beat count scales
  // with actual voiceover duration regardless of the configured target video length.
  const cadence = beatSec ?? archiveVisualBeatSec();
  return sceneBeatCapForCadence(sceneDurationSec, perfFloor, cadence);
}

/** Max on-screen clip length — 1-min fast path allows full beat holds (default 20s). */
export function archiveVisualMaxClipSecForVideo(videoLength?: string | null): number {
  if (!isFastShortVideoLength(videoLength)) return archiveVisualMaxClipSec();
  return archiveVisualBeatSecForVideo(videoLength);
}

/** Pipeline perf floor: enough beats for the longest typical scene in this video length. */
export function curatedPerfBeatsFloor(videoLength: string): number {
  const totalSec = targetVideoDurationMinutes(videoLength) * 60;
  const scenes =
    videoLength === "1" ? 3 : videoLength === "8-10" ? 18 : videoLength === "10-15" ? 25 : 35;
  const typicalSceneSec = totalSec / scenes;
  return sceneBeatCapForCadenceForVideo(typicalSceneSec, 1, videoLength);
}

/** Prefer moving archive video over Ken Burns stills (default on). */
export function archivePreferVideoClips(): boolean {
  return process.env.ARCHIVE_PREFER_VIDEO !== "false";
}

/** Target Ken Burns / heritage stills per minute of finished video (default ~2–3). */
export function archiveStillsPerMinute(): number {
  const raw = process.env.ARCHIVE_STILLS_PER_MINUTE?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1 && n <= 5) return n;
  }
  return 2.5;
}

/** Max still-image beats per generated video — scales with length (~2–3/min). */
export function archiveMaxImageClipsPerVideo(videoLength?: string | null): number {
  const raw = process.env.ARCHIVE_MAX_IMAGE_CLIPS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  return Math.max(2, Math.round(mins * archiveStillsPerMinute()));
}

/** Min moving archive/authentic video clips before stills fill the remaining beats. */
export function archiveMinVideoClipsTarget(videoLength?: string | null): number {
  const raw = process.env.ARCHIVE_OPENING_VIDEO_BEATS?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const mins = targetVideoDurationMinutes(videoLength);
  const beatSec = isFastShortVideoLength(videoLength)
    ? archiveVisualBeatSecForVideo(videoLength)
    : archiveVisualBeatSec();
  const expectedBeats = Math.max(1, Math.ceil((mins * 60) / beatSec));
  const maxStills = archiveMaxImageClipsPerVideo(videoLength);
  const target = Math.max(1, expectedBeats - maxStills);
  if (isFastShortVideoLength(videoLength)) return 0;
  return target;
}

/** @deprecated alias — prefer archiveMinVideoClipsTarget */
export function archiveOpeningVideoBeatsTarget(videoLength?: string | null): number {
  return archiveMinVideoClipsTarget(videoLength);
}

/** Archive stills on gray mat (smaller photo, documentary YouTube style). */
export function framedArchiveStillsEnabled(): boolean {
  return process.env.ENABLE_FRAMED_ARCHIVE_STILLS !== "false";
}

/** Archive stills: blurred fill background + sharp photo + light zoom (Locomotive Historian style). */
export function archiveBlurFillStillsEnabled(): boolean {
  return process.env.ARCHIVE_BLUR_FILL_STILLS !== "false";
}

/** On-screen label cadence (years + keywords) in seconds. */
export function screenLabelIntervalSec(): number {
  const raw = process.env.SCREEN_LABEL_INTERVAL_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 15 && n <= 60) return n;
  }
  return 30;
}

/** No yellow labels before this second in the final video timeline. */
export function screenLabelMinStartSec(): number {
  const raw = process.env.SCREEN_LABEL_MIN_START_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0 && n <= 30) return n;
  }
  return 10;
}

/** Minimum gap between on-screen labels (years / place names). */
export function screenLabelMinGapSec(): number {
  const raw = process.env.SCREEN_LABEL_MIN_GAP_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 20) return n;
  }
  return 9;
}

/** Max yellow labels per scene (years + places). */
export function screenLabelMaxPerScene(): number {
  const raw = process.env.SCREEN_LABEL_MAX_PER_SCENE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 3 && n <= 12) return n;
  }
  return 7;
}

/** Prefer different archive clips across consecutive videos on the same topic.
 *  Phase 10: previously disabled for fast/short videos, but the underlying
 *  lookup (getCrossVideoExcludeAssetIds) is a synchronous in-memory scan of an
 *  already-loaded store, not a DB round-trip — there's no latency reason to
 *  exclude the fast path, and short videos are exactly where the same handful
 *  of clips getting reused video after video is most visible to viewers. */
export function archiveCrossVideoVarietyEnabled(_videoLength?: string | null): boolean {
  return process.env.ARCHIVE_CROSS_VIDEO_VARIETY !== "false";
}

/** Phase 10: reject a candidate that matches neither the beat's literal visual-cue tags nor
 *  any broader fallback tag, for beats where the director/script gave an explicit visual
 *  description or search query (hasLiteralVisual). Previously computed but never wired to
 *  any caller — every call site passed literalVisualTags=[] regardless, so the gate was
 *  dead code. Env-tunable in case it turns out to lower beat-fill success rate in production. */
export function literalVisualGateEnabled(): boolean {
  return process.env.LITERAL_VISUAL_GATE !== "false";
}

/** How many recent same-topic videos contribute to the cross-video exclude set. */
export function archiveCrossVideoCooldownVideos(): number {
  const raw = process.env.ARCHIVE_CROSS_VIDEO_COOLDOWN?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 20) return n;
  }
  return 6;
}

/** FFmpeg-generated text cards, maps, and diagram beats (no external API). */
export function motionGraphicsInVideosEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  if (yearsOnlyOnScreen()) return false;
  return process.env.ENABLE_MOTION_GRAPHICS !== "false";
}

/** Automatic V3 text overlays — centered typewriter highlights (default on). */
export function autoMotionGraphicsLayerEnabled(): boolean {
  return process.env.ENABLE_AUTO_MOTION_GRAPHICS !== "false";
}

/**
 * Vidrush documentary quality gates — opening B-roll, pacing, non-doc filter,
 * geo consistency, motion-graphics QA. On by default for every topic/subject.
 */
export function vidrushDocumentaryQualityEnabled(): boolean {
  return process.env.ENABLE_VIDRUSH_QUALITY !== "false";
}

export function maxMotionGraphicsPerVideo(): number {
  const raw = process.env.MAX_MOTION_GRAPHICS_PER_VIDEO?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 20) return n;
  }
  return 5;
}

/**
 * Visual Matching Engine V1: Wikimedia Commons as a free/public fallback source.
 * On by default (Wikimedia needs no API key). Disable via VISUAL_MATCHING_V1=false.
 */
export function visualMatchingV1Enabled(): boolean {
  return process.env.VISUAL_MATCHING_V1 !== "false";
}

/** Lowest CLIP score still accepted as “looks similar” when strict match found nothing (default 5). */
export function archiveSimilarMatchVisionFloor(): number {
  const raw = process.env.ARCHIVE_SIMILAR_VISION_FLOOR?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 4 && n <= 7) return n;
  }
  return 5;
}

/** Min CLIP score for last-chance 1-min compose rescue (archive still preferred). */
export function fastShortComposeRescueVisionFloor(): number {
  const raw = process.env.FAST_COMPOSE_RESCUE_VISION_FLOOR?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 8) return n;
  }
  return 6;
}

/** Block upload when qualityReport fails thresholds (on by default). */
export function strictQualityExportEnabled(): boolean {
  return process.env.ENABLE_STRICT_QUALITY_EXPORT !== "false";
}

/** Minimum qualityReport.score before export (default 45). */
export function minQualityExportScore(videoLength?: string | null): number {
  const raw = process.env.MIN_QUALITY_EXPORT_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0 && n <= 100) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 70;
  return 45;
}

/**
 * Case/whitespace-tolerant env boolean parsing. A Railway variable set to "TRUE" or " true "
 * must read the same as "true"; otherwise a stray capital silently disables a whole source.
 * RONDE 18: ENABLE_YOUTUBE_SOURCING="TRUE" fails a bare `=== "true"` and turns YouTube fully off,
 * even though the operator clearly meant to enable it.
 */
export function envFlagIsOn(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/** Opt-out flag: on unless explicitly set to "false" (case/whitespace-tolerant). */
export function envFlagIsNotOff(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() !== "false";
}

/** YouTube Creative Commons clips — off unless ENABLE_YOUTUBE_SOURCING=true and keys set. */
export function youtubeSourcingEnabled(): boolean {
  return envFlagIsOn("ENABLE_YOUTUBE_SOURCING");
}

/**
 * WHY YOUTUBE IS OR IS NOT SEARCHING — the flag alone never answered that.
 *
 * ── What render 562 shows ───────────────────────────────────────────────────────────────────
 *
 *     [YouTubeUsage] used=0
 *     …and not one live YouTube search in the entire log.
 *
 * (The eleven `[YouTubeLicense]` lines in that render are archive.org's own `youtube-<id>`
 * mirrors, fetched from Internet Archive. Live YouTube never ran.)
 *
 * YouTube needs THREE things, not one: the flag, a key to SEARCH with, and a separate service to
 * DOWNLOAD with — YouTube does not serve media files directly, so the pipeline cannot fetch a
 * clip with the API key alone. `youtubeSourcingEnabled()` reports only the first, so a render
 * with the flag on and no key logged `youtube=on` and then quietly searched nothing.
 *
 * Names and presence only, never a value — a key must never reach a log.
 */
export type YoutubeSourcingReadiness = {
  ready: boolean;
  /** Empty when ready; otherwise the missing requirements, by env name. */
  missing: string[];
  /**
   * Configured, but in a shape that usually does not work. Not blocking — the code supports it —
   * so it is reported beside `ready` rather than instead of it.
   */
  warnings: string[];
};

export function youtubeSourcingReadiness(): YoutubeSourcingReadiness {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!envFlagIsOn("ENABLE_YOUTUBE_SOURCING")) missing.push("ENABLE_YOUTUBE_SOURCING");
  if (!process.env.YOUTUBE_API_KEY?.trim()) missing.push("YOUTUBE_API_KEY");

  const cloud = Boolean(process.env.YOUTUBE_CC_DL_SERVICE?.trim());
  const rapid = Boolean(process.env.RAPIDAPI_KEY?.trim());
  /** Either download route satisfies this — only their absence together blocks a download. */
  if (!cloud && !rapid) missing.push("RAPIDAPI_KEY|YOUTUBE_CC_DL_SERVICE");

  /**
   * The cloud yt-dlp service authenticates with `Authorization: Bearer <YOUTUBE_CC_DL_TOKEN>` and
   * answers 401 without it. `downloadYouTubeCCClip` omits the header when the token is unset, so a
   * token-less service is genuinely supported and this is NOT a missing requirement — but a
   * deployment that set the service URL and forgot the token gets 401 on every download, and the
   * first version of this readiness check would have called that configuration `ready`.
   */
  if (cloud && !process.env.YOUTUBE_CC_DL_TOKEN?.trim()) {
    warnings.push("YOUTUBE_CC_DL_TOKEN unset — the cloud download service answers 401 unless it is token-less");
  }
  return { ready: missing.length === 0, missing, warnings };
}

/** One field for the route line: `ready`, or what is missing. Never a key's value. */
export function formatYoutubeReadiness(): string {
  const { ready, missing, warnings } = youtubeSourcingReadiness();
  const head = ready ? "youtube=ready" : `youtube=BLOCKED(missing:${missing.join(",")})`;
  return warnings.length ? `${head} youtubeWarn=${warnings.length}` : head;
}

/** The warnings in full, for the render log — one line each, never a key's value. */
export function youtubeReadinessWarnings(): string[] {
  return youtubeSourcingReadiness().warnings.map((w) => `[YouTube] CONFIG_WARNING ${w}`);
}

/** Archive clip pick driven by asset.tags + title (default on). Set ENABLE_ARCHIVE_TAG_MATCH=false for semantic-only. */
export function archiveTagsPrimaryMatching(): boolean {
  return process.env.ENABLE_ARCHIVE_TAG_MATCH !== "false";
}

/** Stability AI image-gen fallback — off (out of credits); set STABILITY_AI_ENABLED=true to re-enable. */
export function stabilityAiEnabled(): boolean {
  return process.env.STABILITY_AI_ENABLED === "true";
}

/** Europeana EU heritage API — real, license-verified video (F3-30 web-wide discovery tier).
 *  Default ON, but only takes effect with EUROPEANA_API_KEY configured (still required) — same
 *  reasoning as the F3-27 flag flips: this doesn't turn anything on by itself, it just removes
 *  the need to also set a second flag once the key is present. Set ENABLE_EUROPEANA=false to
 *  opt back out. */
export function europeanaSourcingEnabled(): boolean {
  return process.env.ENABLE_EUROPEANA !== "false";
}

/** Run bulk geo-retag on all archive assets once at worker startup. */
export function autoArchiveGeoRetagOnStart(): boolean {
  return process.env.AUTO_ARCHIVE_GEO_RETAG_ON_START === "true";
}

// ─── Performance optimisation — caches ───────────────────────────────────────

/** Persistent Media Asset Cache (P3): cache downloaded Pexels/Wikimedia/Archive
 *  assets in R2/S3 so the same file is never re-downloaded across videos.
 *  Requires ENABLE_MEDIA_CACHE=true AND S3 storage configured (S3_BUCKET etc.).
 *  Off by default until cache warm-up is sufficient to see ROI. */
export function mediaCacheEnabled(): boolean {
  return process.env.ENABLE_MEDIA_CACHE === "true";
}

/** Persistent Scene Candidate Cache: cache search API responses per normalised
 *  query so Wikimedia/Archive providers are not re-queried for identical topics.
 *  Requires ENABLE_SCENE_CANDIDATE_CACHE=true. */
export function sceneCandidateCacheEnabled(): boolean {
  return process.env.ENABLE_SCENE_CANDIDATE_CACHE === "true";
}

/** Persistent Beat Semantic Profile Cache: the in-process Map cache in
 *  semanticVisualMatching.ts resets on every process restart, so a video retried
 *  after a redeploy re-pays full LLM cost for every beat's semantic analysis —
 *  confirmed as a real, non-trivial cost driver (2026-08-02 audit). Unlike the
 *  other P3 caches above this defaults ON: it's a straightforward cost fix, not
 *  an experimental feature waiting on ROI proof. Set ENABLE_BEAT_SEMANTIC_CACHE=false
 *  to opt out. */
export function beatSemanticCacheEnabled(): boolean {
  return process.env.ENABLE_BEAT_SEMANTIC_CACHE !== "false";
}

/** Scene-level Candidate Pool (P1): build ONE candidate pool per scene instead
 *  of one retrieval per beat.  Reduces 108 API calls to ~18.
 *  F3-27: default ON — this is the gate for the archive→web fallback→ingest→learning
 *  flow (F3-26). Falls back to the legacy per-beat waterfall on any pool/funnel error
 *  (see the try/catch around its call site in videoPipeline.ts), so this does not
 *  replace the legacy path, it only runs ahead of it. Set ENABLE_SCENE_CANDIDATE_POOL=false
 *  to opt back out. */
export function sceneCandidatePoolEnabled(): boolean {
  return process.env.ENABLE_SCENE_CANDIDATE_POOL !== "false";
}

/** Thumbnail-first selection (P2): download thumbnails for pool candidates and
 *  run CLIP similarity scoring before downloading the full asset.  Only the
 *  winner is fully downloaded.  Requires ENABLE_POOL_THUMBNAIL_RANKING=true
 *  AND local vision (ENABLE_LOCAL_VISION != false).  Off by default. */
export function poolThumbnailRankingEnabled(): boolean {
  return process.env.ENABLE_POOL_THUMBNAIL_RANKING === "true";
}

/** Hybrid Retrieval Funnel (parallel archive + internet with coverage-based weighting).
 *  Replaces the waterfall "archive first → fallback to internet" logic with a model
 *  where both are queried in parallel and the archive's embedding coverage determines
 *  how much weight it receives.  Requires ENABLE_SCENE_CANDIDATE_POOL=true.
 *  F3-27: default ON, same reasoning as sceneCandidatePoolEnabled() above — this is
 *  what makes web sourcing (Internet Archive/Wikimedia/YouTube CC/Pexels/Pixabay) an
 *  actual fallback when the archive alone is insufficient, instead of dormant code.
 *  Set ENABLE_RETRIEVAL_FUNNEL=false to opt back out. */
export function retrievalFunnelEnabled(): boolean {
  return process.env.ENABLE_RETRIEVAL_FUNNEL !== "false";
}

/** How long a scene may wait for its retrieval funnel to deliver, before falling back to
 *  per-beat retrieval. This is purely a delivery deadline: it decides whether the funnel's
 *  candidates are available in time, and has no bearing on how any candidate is scored,
 *  ranked or gated once they are.
 *
 *  Default is 60_000 — the value this await has always used — so production behaviour is
 *  unchanged unless FASTVID_FUNNEL_TIMEOUT_MS is explicitly set.
 *
 *  It exists as a knob because the funnel branch turned out to be reachable only by winning
 *  a race: in render 512 the funnel delivered with 1243ms to spare (`prefetch waited
 *  58757ms` against the 60s deadline), while in render 513 slower providers pushed it from
 *  91s to 140s and all three scenes timed out — which silently skipped the entire funnel
 *  scoring branch, and with it the code under test. Raising this for one controlled render
 *  lets that branch actually execute; it does not make the funnel produce anything it
 *  wouldn't otherwise produce, only wait long enough to receive it.
 *
 *  Bounded to [60_000, 600_000]: never below the production default (so a stray value can't
 *  tighten live behaviour) and never beyond the render's own wall-clock budget. */
export function funnelAwaitTimeoutMs(): number {
  const raw = process.env.FASTVID_FUNNEL_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 60_000 && n <= 600_000) return n;
  }
  return 60_000;
}

/** Archive-first per-beat gap detection (self-learning retrieval).
 *  When enabled, the archive is always consulted first per beat.  The embedding
 *  confidence score determines how many external sources are queried:
 *    > 0.90 → archive only (no internet call)
 *    0.75–0.90 → one external source
 *    0.50–0.75 → all external sources
 *    < 0.50 → aggressive external retrieval
 *  Requires ENABLE_RETRIEVAL_FUNNEL=true.
 *  F3-27: default ON — this is the "genuine coverage sufficiency" gate (F3-26 #11):
 *  archive-only when confidence is high, web sourcing only kicks in on a real gap.
 *  Set ENABLE_ARCHIVE_FIRST_BEATS=false to opt back out. */
export function archiveFirstBeatsEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_FIRST_BEATS !== "false";
}

/** Async QA (P6): move pipeline review + post-render spot check off the critical path.
 *  When enabled, the two LLM reviews (compose review + final review) are fired as
 *  background promises that run concurrently with the final concat/music stage.
 *  The post-render spot check runs in parallel with the S3 upload.
 *  Net saving: ~30–70 s depending on video length and LLM latency.
 *  Requires ENABLE_ASYNC_QA=true.  Off by default. */
export function asyncQaEnabled(): boolean {
  return process.env.ENABLE_ASYNC_QA === "true";
}

/** Self-learning ingestion: winning external clips are uploaded to the own archive
 *  (quality gate → R2 → DB record → embedding index) so future videos can use them
 *  without external API calls.  Best-effort; never blocks video production.
 *  F3-27: default ON — the "ingest" step of the archive→web fallback→ingest→learning
 *  flow (F3-26). Only takes effect when retrievalFunnelEnabled() is also on, since
 *  that's the only call site with the structured source metadata to ingest.
 *  Set ENABLE_EXTERNAL_ASSET_INGESTION=false to opt back out. */
export function externalAssetIngestionEnabled(): boolean {
  return process.env.ENABLE_EXTERNAL_ASSET_INGESTION !== "false";
}

/** P5A Scene Processing Pipeline: each scene runs fetch → recovery → compose as a unit,
 *  so Scene N+1 composes while Scene N+2 is still fetching.  Eliminates the Stage 3 →
 *  Stage 4 sequential barrier.  Aggregate polish steps (polishWeakAdoptBeats,
 *  ensureFastShortScenesReady) are skipped in pipeline mode — per-scene recovery still runs.
 *  Requires ENABLE_SCENE_PIPELINE=true. */
export function scenePipelineEnabled(): boolean {
  return process.env.ENABLE_SCENE_PIPELINE === "true";
}
