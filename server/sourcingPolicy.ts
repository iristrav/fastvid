/** Production sourcing policy — archive-first visuals; ElevenLabs for voice. */

import { burnedInTextAllowed } from "./onScreenTextPolicy";
import fs from "fs";
import os from "os";
import { targetVideoDurationMinutes } from "../shared/videoLengths";


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

/** When true (default), use Pexels stock if no archive clip matches a sentence. */
export function archivePexelsFallbackEnabled(): boolean {
  return process.env.ARCHIVE_PEXELS_FALLBACK !== "false";
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

/** Extra wall-clock after hard cap while compose/upload finishes (1-min fast path). */
export function pipelineComposeGraceMs(): number {
  const raw = process.env.PIPELINE_COMPOSE_GRACE_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30_000 && n <= 300_000) return n;
  }
  return 0;
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
export function composeParallelismForVideo(isRailway = false): number {
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

/**
 * Strict voice↔visual CLIP matching — every beat must pass vision gate (default ON).
 * Set STRICT_VOICE_VISUAL_MATCH=false to restore relaxed fast-path scoring.
 */
export function strictVoiceVisualMatchEnabled(): boolean {
  return process.env.STRICT_VOICE_VISUAL_MATCH !== "false";
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
export function maxVisualCandidatesPerBeatTry(): number {
  if (!pipelineWallClockLimitEnabled()) return 14;
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
const EMERGENCY_FRACTION = 0.45;

/** Max ms per beat spent trying archive candidates before moving on. Beats are processed
 *  concurrently (fastBeatConcurrency) so this does NOT add up serially. Archive lookup
 *  is an embedding search — if nothing is found in 20s it won't be found at all. */
export function archiveBeatTryTimeoutMs(): number {
  const raw = process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 4_000 && n <= 120_000) return n;
  }
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
  remainingWallClockMs?: number | null
): number {
  const base = archiveBeatTryTimeoutMs();
  // An explicit override is an instruction, not a starting point.
  if (process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim()) return base;
  if (remainingWallClockMs == null || !Number.isFinite(remainingWallClockMs)) return base;
  const headroom = remainingWallClockMs - SOURCING_RESERVE_MS;
  if (headroom <= 0) return base;
  const share = Math.floor(headroom / BEATS_ASSUMED_REMAINING);
  return Math.min(Math.max(base, share), base * MAX_BEAT_BUDGET_MULTIPLE);
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
 * ── Why 20 became 60 ────────────────────────────────────────────────────────────────────────
 *
 * The sentence above used to end "20 is deliberately generous", written when this route had yet
 * to contribute a single clip in three renders. The production logs since then say something the
 * sentence could not know, because the counter it describes only began to bind on 25 August
 * (`2866c8b`, `26094f9`):
 *
 *     24 aug   103 attempts   17 clips     ceiling not yet binding
 *     25 aug    97 attempts   44 clips     ceiling not yet binding
 *     31 aug    20 attempts    2 clips     ceiling binding
 *     10 sept   20 attempts    0 clips     ceiling binding
 *
 * So the download itself was never the thing that failed. RapidAPI delivered 63 clips across
 * those renders, at somewhere between 17% and 45% of attempts. What changed is that the budget
 * for finding those clips fell from about a hundred tries to twenty — and twenty tries at 17%
 * is three clips, for a film that needs fourteen.
 *
 * 60 is not a guess at a bigger number. It is under the ~100 those two renders actually spent
 * without harm (both completed, and 25 August produced 44 clips), and at the measured rates it
 * yields roughly 10-27 — enough for YouTube to be a real supplier rather than a garnish.
 *
 * What still bounds it, unchanged: every attempt is inside `youtubeBeatBudgetMs`, so the render's
 * wall clock caps this long before 60 does; a video refused for its own sake costs no second slot
 * (see `noteYoutubeDownloadRefusal`); and `YOUTUBE_MAX_DOWNLOADS_PER_RENDER` still overrides
 * without a deploy, in either direction.
 */
export function youtubeMaxDownloadsPerRender(): number {
  const raw = process.env.YOUTUBE_MAX_DOWNLOADS_PER_RENDER?.trim() ?? process.env.YOUTUBE_MAX_DOWNLOAD_ATTEMPTS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 200) return n;
  }
  return 60;
}

/**
 * The two duration slices this pipeline can actually use.
 *
 * `long` (>20 min) is deliberately absent and is not an oversight: the YouTube route downloads the
 * WHOLE source and only then trims, under an 80 MB ceiling. A forty-minute upload spends a
 * download slot and the scene's remaining time to arrive at a file the size guard then refuses.
 */
/**
 * Video 613 — `short` (under 4 min) is where every YouTube Short lives, and Shorts are never
 * downloaded: the operator's rule. `medium` is 4–20 min, which YouTube itself guarantees is no Short
 * (a Short is at most 3 min). The price is stated plainly: sub-4-minute archive clips are no longer
 * searched per beat. The whole-video pool still sees every length, and drops Shorts by their
 * measured length before any download (`youtubeVideoPool.ts`).
 */
export type YoutubeSearchDuration = "medium";

/**
 * How long the YouTube-first attempt may spend on one beat before the cascade moves on.
 *
 * Same shape as `archiveBeatBudgetMs` — a share of the real headroom, floored at a base and capped
 * so one beat cannot take the scene — and deliberately SMALLER, because this is the first source
 * asked rather than the one the render is relying on. A beat that finds nothing on YouTube must
 * still reach the archive with time to spare; that is the whole reason this is bounded at all.
 *
 * The floor is above `YOUTUBE_MIN_DOWNLOAD_WINDOW_MS` (12s) on purpose. Below that the download
 * guard refuses to start, so a smaller slice would reproduce the exact defect this fixes: a source
 * that is asked and can never answer.
 */
export function youtubeBeatBudgetMs(
  remainingWallClockMs?: number | null
): number {
  const raw = process.env.YOUTUBE_BEAT_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    // An explicit override is an instruction, not a starting point — but never below the download
    // guard's own minimum, or the source is switched off by arithmetic rather than by choice.
    if (!isNaN(n) && n >= 15_000 && n <= 120_000) return n;
  }
  /** RONDE 648 — the operator's two minutes, when a beat asks YouTube first itself. */
  return YOUTUBE_FIRST_TURN_MS;
}

/**
 * HOW LONG ONE YOUTUBE TRANSFER MAY TAKE — and why it may never exceed what the caller waits.
 *
 * ── What render 579 measured ────────────────────────────────────────────────────────────────
 *
 * Twenty-three downloads failed, every one of them with `reason=download_timeout`, and five of
 * them filed DOWNLOAD_SUCCEEDED *after* their own failure:
 *
 *     FOUND               OK
 *     DOWNLOAD_STARTED    OK
 *     DOWNLOAD_FAILED     FAILED   reason=download_timeout
 *     DOWNLOAD_SUCCEEDED  OK          ← after the timeout
 *
 * A transfer cannot succeed after its own abort fired. So the abort that fired was not this one.
 *
 * ── The contradiction ───────────────────────────────────────────────────────────────────────
 *
 * This function returned 180 000 ms. The wrapper the beat round puts around the same call,
 * `youtubeBeatFetchTimeoutMs`, allows 22 000 / 55 000 / 80 000 ms on Railway. The inner operation
 * was therefore handed three minutes by a caller who would wait at most twenty-two seconds.
 *
 * The outer wrapper fires first and files `download_timeout`; the inner fetch was never actually
 * cancelled, runs to completion, and files DOWNLOAD_SUCCEEDED into a ledger nobody is reading any
 * more. The clip exists on disk and no beat will ever use it.
 *
 * ── What this changes, and what it deliberately does not ────────────────────────────────────
 *
 * It LOWERS the inner ceiling to the caller's own budget. It raises nothing: `YOUTUBE_DOWNLOAD_
 * TIMEOUT_MS`, the 180 s default and the 30 s/600 s bounds are all untouched, and a caller that
 * passes no cap gets exactly the number it got before.
 *
 * The gain is not more time — it is a transfer that gives up while the beat can still do something
 * with the answer. A download that cannot finish inside the beat's budget is a download the beat
 * cannot use, and spending the whole budget discovering that costs the beat every other candidate
 * it might have tried.
 *
 * The floor exists so a nearly-spent budget cannot produce a zero or negative timeout, which
 * `AbortSignal.timeout` would treat as "abort immediately" and would report as a transfer failure
 * rather than as the budget exhaustion it is.
 */
export function youtubeDownloadTimeoutMs(capMs?: number): number {
  const raw = process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS?.trim();
  let base = 180_000;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30_000 && n <= 600_000) base = n;
  }
  if (capMs == null || !Number.isFinite(capMs)) return base;
  return Math.max(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS, Math.min(base, Math.floor(capMs)));
}

/** Below this a transfer has no chance at all, and an instant abort would misreport the cause. */
export const YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS = 8_000;

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

/** Archive stills on gray mat (smaller photo, documentary YouTube style). */
export function framedArchiveStillsEnabled(): boolean {
  return process.env.ENABLE_FRAMED_ARCHIVE_STILLS !== "false";
}

/** Archive stills: blurred fill background + sharp photo + light zoom (Locomotive Historian style). */
export function archiveBlurFillStillsEnabled(): boolean {
  return process.env.ARCHIVE_BLUR_FILL_STILLS !== "false";
}

/** Prefer different archive clips across consecutive videos on the same topic.
 *  Phase 10: previously disabled for fast/short videos, but the underlying
 *  lookup (recentUsageCounts) is a synchronous in-memory scan of an
 *  already-loaded store, not a DB round-trip — there's no latency reason to
 *  exclude the fast path, and short videos are exactly where the same handful
 *  of clips getting reused video after video is most visible to viewers. */
export function archiveCrossVideoVarietyEnabled(_videoLength?: string | null): boolean {
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
 * Case/whitespace-tolerant env boolean parsing. A Railway variable set to "TRUE" or " true "
 * must read the same as "true"; otherwise a stray capital silently disables a whole source.
 * RONDE 18: ENABLE_YOUTUBE_SOURCING="TRUE" fails a bare `=== "true"` and turns YouTube fully off,
 * even though the operator clearly meant to enable it.
 *
 * Re-exported from ./envFlag rather than defined here since render 569, where the preflight's own
 * route table read the same variable with a bare `=== "true"` and reported OFF for a source the
 * pipeline had switched on. One definition, so a report cannot contradict the code it describes.
 */
export { envFlagIsOn, envFlagIsNotOff } from "./envFlag";
import { envFlagIsOn } from "./envFlag";
import { pipelineWallClockGraceFactor, pipelineWallClockLimitEnabled } from "./config";

/** YouTube clips — off unless ENABLE_YOUTUBE_SOURCING=true and keys set. */
export function youtubeSourcingEnabled(): boolean {
  return envFlagIsOn("ENABLE_YOUTUBE_SOURCING");
}

/* ═══════════════ YouTube: which licence question retrieval asks ═══════════════ */

/** The three retrieval modes, as the YouTube Data API's own `videoLicense` parameter takes them. */
export type YoutubeLicenseMode = "creative_common" | "youtube" | "any";

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
  if (!cloud) missing.push("YOUTUBE_CC_DL_SERVICE");

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


/** The operator's choice: how long one beat may spend on YouTube before it moves on. */
export const YOUTUBE_FIRST_TURN_MS = 120_000;

/**
 * What the tiers after YouTube get, at the least. The 1-minute profile's per-beat wall is 22 s on
 * Railway — sized for a beat that arrived with a scene pool already in hand. Without the pool the
 * archive, the open sources and stock are asked from nothing, and 22 s is not enough for that.
 */
export const YOUTUBE_FIRST_FALLBACK_MIN_MS = 60_000;

/** One beat's worst case in this mode: the whole YouTube turn, then the whole fallback. */
export const YOUTUBE_FIRST_BEAT_WORST_MS = YOUTUBE_FIRST_TURN_MS + YOUTUBE_FIRST_FALLBACK_MIN_MS;

/**
 * How many beats search at the same time. Beats inside a scene run one after another, scenes run
 * side by side, so this is the scene parallelism. The operator chose three.
 */
export const YOUTUBE_FIRST_PARALLEL_BEATS = 3;

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

