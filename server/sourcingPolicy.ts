/** Production sourcing policy — archive-first visuals; ElevenLabs for voice. */

import { normalizeVideoLength, targetVideoDurationMinutes } from "../shared/videoLengths";

/**
 * Archive-first mode: prefer admin media archive, then Wikimedia / Pexels / Pixabay fallbacks.
 * YouTube, Serp, and AI clip generation stay off unless explicitly re-enabled elsewhere.
 */
export function curatedArchiveOnlyVisuals(): boolean {
  return process.env.CURATED_ARCHIVE_ONLY !== "false";
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

/** Burn typewriter keywords on clips — default OFF (footage + voice only). Set ENABLE_FACELESS_SUBTITLES=true to enable. */
export function facelessSubtitlesEnabled(): boolean {
  return process.env.ENABLE_FACELESS_SUBTITLES === "true";
}

/** Extra on-screen overlays (stat pills, film grain, motion graphics cards). Default OFF. */
export function extraOnScreenTextEnabled(): boolean {
  return process.env.ENABLE_EXTRA_ONSCREEN_TEXT === "true";
}

/** When extra overlays are off, skip cinematic pills/grain (year labels use screenLabelsEnabled). */
export function yearsOnlyOnScreen(): boolean {
  return !extraOnScreenTextEnabled();
}

/** Year/stat labels burned on footage — default OFF. Set ENABLE_SCREEN_LABELS=true to enable. */
export function screenLabelsEnabled(): boolean {
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

/** When true, enforce hard wall-clock fail + router race timeout. Default OFF — jobs finish at their own pace. */
export function pipelineWallClockLimitEnabled(): boolean {
  return process.env.PIPELINE_WALL_CLOCK_LIMIT === "true";
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
  if (mins <= 1) return 14;
  return Math.round(mins * pipelineMinutesPerVideoMinute());
}

/** Hard wall-clock fail — 1-min videos: 15 min; longer: target × grace. */
export function maxPipelineWallClockHardMin(videoLength?: string | null): number {
  if (!pipelineWallClockLimitEnabled()) {
    return Math.round(PIPELINE_UNLIMITED_MS / 60_000);
  }
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 15;
  return Math.ceil(maxPipelineWallClockMin(videoLength) * pipelineWallClockGraceFactor());
}

/** After this many ms on 1-min fast path, prefer licensed stock over slow archive retries. */
export function pipelineRushModeMs(videoLength?: string | null): number {
  const raw = process.env.PIPELINE_RUSH_MODE_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 90_000 && n <= 540_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 10 * 60_000;
  return 3 * 60_000;
}

/** Near hard cap — finish compose before wall-clock hard fail (quality path keeps archive longer on 1-min). */
export function pipelineEmergencyFinishMs(videoLength?: string | null): number {
  const raw = process.env.PIPELINE_EMERGENCY_FINISH_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 300_000 && n <= 900_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 12 * 60_000;
  return 7 * 60_000;
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
  return isFastShortVideoLength(videoLength) ? 120_000 : 0;
}

/** ≤1 min videos — fast archive-first path (independent of wall-clock limit). */
export function isFastShortVideoLength(videoLength?: string | null): boolean {
  return targetVideoDurationMinutes(videoLength) <= 1;
}

/** Parallel beat fills on 1-min fast path. Railway has 24 vCPU but the container's pids
 *  cgroup limit (process/thread count, not CPU) is hit well before vCPU saturation when
 *  combined with compose/montage parallelism below — keep this moderate. */
export function fastBeatConcurrency(isRailway = false): number {
  const raw = process.env.FAST_BEAT_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 8) return n;
  }
  return 4;
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

/** Parallel scene compose jobs (1–4). Railway has 24 vCPU/24GB RAM, but each compose job
 *  forks a shell + ffmpeg + N encode threads — multiplied across compose × montage ×
 *  thread parallelism this hit the container's pids/fork limit ("Cannot fork") well
 *  before CPU/RAM did. Keep this moderate; override via COMPOSE_PARALLELISM if needed. */
export function composeParallelismForVideo(videoLength?: string | null, isRailway = false): number {
  const raw = process.env.COMPOSE_PARALLELISM?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 4) return n;
  }
  // 1-min fast path has a tight 420s hard cap on the compose stage — keep it at the
  // original safe level since extra parallelism + fork-pressure retries can blow that budget.
  if (isFastShortVideoLength(videoLength)) return 2;
  return 3;
}

/** Parallel montage segment encodes within a scene (1–3). See composeParallelismForVideo —
 *  combined process/thread fan-out hit the container's fork limit; fork-pressure retries
 *  now cover transient spikes, so this can run a bit hotter than the original safe floor. */
export function montageSegmentParallelism(isRailway = false): number {
  const raw = process.env.MONTAGE_SEGMENT_PARALLELISM?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 3) return n;
  }
  return 2;
}

/** FFmpeg thread cap per encode (0 = libx264 default). Combined with compose ×
 *  montage parallelism, higher values risk the container's fork/pids limit, not CPU —
 *  fork-pressure retries now cover transient spikes from this. */
export function ffmpegThreadFlag(isRailway = false): string {
  const raw = process.env.FFMPEG_THREADS?.trim();
  const n = raw ? parseInt(raw, 10) : isRailway ? 3 : 0;
  if (!n || isNaN(n) || n < 1) return "";
  return `-threads ${Math.min(4, n)}`;
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
export function archiveVisualBeatSecForVideo(videoLength?: string | null): number {
  if (!isFastShortVideoLength(videoLength)) return archiveVisualBeatSec();
  const raw = process.env.FAST_ARCHIVE_BEAT_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 12 && n <= 24) return n;
  }
  return 24;
}

/** Wall-clock ms after pipeline start before turbo stock fallback on 1-min videos (default 12s; 8min on 1-min quality path). */
export function visualSourcingTurboMs(videoLength?: string | null): number {
  const raw = process.env.VISUAL_SOURCING_TURBO_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 8_000 && n <= 300_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 8 * 60_000;
  return 12_000;
}

/** Max ms per beat spent trying archive candidates before moving on. Raised slightly so the
 *  extra candidates from maxVisualCandidatesPerBeatTry have time to actually run — beats
 *  are processed concurrently (fastBeatConcurrency), so this doesn't add up serially. */
export function archiveBeatTryTimeoutMs(videoLength?: string | null): number {
  const raw = process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 4_000 && n <= 120_000) return n;
  }
  if (isFastShortVideoLength(videoLength)) return 26_000;
  return 50_000;
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
 * Beat cap per scene — on 1-min fast path one archive clip covers the full beat window
 * (no 8s min-splitting that would force 3× more CLIP work per scene).
 */
export function sceneBeatCapForCadenceForVideo(
  sceneDurationSec: number,
  perfFloor = 1,
  videoLength?: string | null,
  beatSec?: number
): number {
  const cadence = beatSec ?? archiveVisualBeatSecForVideo(videoLength);
  if (isFastShortVideoLength(videoLength)) {
    return Math.max(1, Math.min(Math.max(1, perfFloor), Math.ceil(sceneDurationSec / cadence)));
  }
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

/** Prefer different archive clips across consecutive videos on the same topic. */
export function archiveCrossVideoVarietyEnabled(videoLength?: string | null): boolean {
  if (isFastShortVideoLength(videoLength)) return false;
  return process.env.ARCHIVE_CROSS_VIDEO_VARIETY !== "false";
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

/** YouTube Creative Commons clips — off unless ENABLE_YOUTUBE_SOURCING=true and keys set. */
export function youtubeSourcingEnabled(): boolean {
  return process.env.ENABLE_YOUTUBE_SOURCING === "true";
}

/** Archive clip pick driven by asset.tags + title (default on). Set ENABLE_ARCHIVE_TAG_MATCH=false for semantic-only. */
export function archiveTagsPrimaryMatching(): boolean {
  return process.env.ENABLE_ARCHIVE_TAG_MATCH !== "false";
}

/** Stability AI image-gen fallback — off (out of credits); set STABILITY_AI_ENABLED=true to re-enable. */
export function stabilityAiEnabled(): boolean {
  return process.env.STABILITY_AI_ENABLED === "true";
}

/** Europeana EU heritage API — off by default; set ENABLE_EUROPEANA=true + EUROPEANA_API_KEY. */
export function europeanaSourcingEnabled(): boolean {
  return process.env.ENABLE_EUROPEANA === "true";
}

/** Run bulk geo-retag on all archive assets once at worker startup. */
export function autoArchiveGeoRetagOnStart(): boolean {
  return process.env.AUTO_ARCHIVE_GEO_RETAG_ON_START === "true";
}
