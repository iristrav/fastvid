/**
 * MEASUREMENT BASE — ONE STRUCTURED QUALITY REPORT PER RENDER.
 *
 * Nothing in here decides anything about a video: this is the shape of what a render can be MEASURED
 * to have done, built from the summary lines the pipeline already prints (`railwayLogAnalyser.ts`)
 * and, later, from the stored RenderReport. Every number carries where it came from:
 *
 *   measured   read as such from a line the pipeline printed about the delivered result
 *   derived    computed from several stored/printed values (the formula is named in `notes`)
 *   estimated  a plausible figure that is NOT backed by a measurement (never silently)
 *   unknown    the value is `null`; it is never reported as 0
 *
 * Denominators are explicit: every `…Percent` says what it divides by. Planned and delivered time are
 * never mixed: `totalVideoSeconds` is the delivered file's duration when the render job reported one,
 * else the stored timeline's, and `totalVideoSecondsBasis` says which.
 */

export const REPORT_SCHEMA_VERSION = 1;

export type Provenance = "measured" | "derived" | "estimated" | "unknown";

export type RenderStatus = "delivered" | "completed_not_delivered" | "failed" | "cancelled" | "incomplete_log" | "unknown";

export type ProviderTally = {
  /** Requests the log shows this provider was asked for (what counts as one is named in `unit`). */
  requests: number | null;
  failures: number | null;
  /** Times the pipeline fell back from this provider to another for the same item. */
  fallbacks: number | null;
  /** Money, in the provider's currency — only when a line states an amount; otherwise null. */
  costs: { amount: number; currency: string } | null;
  /** Provider credits actually spent, when derivable; `creditsBasis` says how. */
  credits: number | null;
  creditsBasis: string | null;
  unit: string;
};

export type RenderQualityReport = {
  reportSchemaVersion: number;
  identification: {
    /** The FastVid video id (what the logs call `video=`). */
    videoId: number | null;
    /** The render lock's id for this attempt (`[RenderLock] … render=…`). */
    renderId: string | null;
    promptId: string | null;
    gitSha: string | null;
    status: RenderStatus;
    startedAt: string | null;
    finishedAt: string | null;
    durationSeconds: number | null;
  };
  visual: {
    totalVideoSeconds: number | null;
    totalVideoSecondsBasis: "delivered_file" | "stored_timeline" | "unknown";
    movingFootageSeconds: number | null;
    /** movingFootageSeconds / totalVideoSeconds × 100 */
    movingFootagePercent: number | null;
    sentenceCount: number | null;
    sentencesWithoutSuitableVisualCount: number | null;
    /** (sentenceCount − sentencesWithoutSuitableVisualCount) / sentenceCount × 100 */
    sentenceVisualCoveragePercent: number | null;
    /** The single source (one video or archive asset) whose FOOTAGE holds the most seconds of the film. */
    largestSource: { sourceId: string; provider: string } | null;
    largestSourceSeconds: number | null;
    /** largestSourceSeconds / totalVideoSeconds × 100 */
    largestSourcePercent: number | null;
    /** largestSourceSeconds / movingFootageSeconds × 100 */
    largestSourceShareOfFootagePercent: number | null;
    /** The provider (youtube_cc, archive, …) with the most seconds among ALL timeline clips, cards included — the older "source share" figure. */
    largestProvider: { provider: string; seconds: number; percentOfFilm: number } | null;
    uniqueSourceCount: number | null;
    /** Timeline clips in the delivered render (pieces of one shot count separately). */
    uniqueClipCount: number | null;
    /** Clips that are the same source seconds placed more than once; null when the lines do not carry source in-points. */
    repeatedClipCount: number | null;
    /** Timeline clips that are pieces of one shot decision (`vc_<id>_p2`, …): not repeats, named apart. */
    clipPiecesCount: number | null;
    stretchedBeyondSourceCount: number | null;
    titleCardSeconds: number | null;
    genericBackgroundSeconds: number | null;
    photoSeconds: number | null;
    graphicSeconds: number | null;
    mapSeconds: number | null;
    /** Chapter/text cards (the pipeline's `cardSec`); the same seconds as `titleCardSeconds` when the lines do not tell them apart. */
    textCardSeconds: number | null;
  };
  funnel: {
    /** YouTube Data API `search.list` calls (one per query). */
    searchQueries: number | null;
    /** Raw search results, summed over the searches (search results, not unique videos). */
    resultsFound: number | null;
    shortsFound: number | null;
    /** Unique YouTube videos the pipeline tried to download (one video with several attempts counts once). */
    downloadsAttempted: number | null;
    downloadsSucceeded: number | null;
    /** Candidate moments handed to a sentence's look (candidates, not unique videos). */
    candidatesOffered: number | null;
    /** Looks the picture editor actually took (judgements). */
    candidatesJudged: number | null;
    candidatesApproved: number | null;
    approvedClipsPlaced: number | null;
    approvedNotPlaced: number | null;
    rejectionReasons: Record<string, number> | null;
  };
  timing: {
    searchSeconds: number | null;
    downloadSeconds: number | null;
    judgeSeconds: number | null;
    assemblySeconds: number | null;
    renderSeconds: number | null;
    /** The pipeline's own stage rows (`[PipelineReport]`), as printed; names are the pipeline's. */
    stageSeconds: Record<string, number> | null;
    wallClockSeconds: number | null;
  };
  providers: Record<string, ProviderTally>;
  assembly: {
    transitionPlannedCount: number | null;
    transitionSucceededCount: number | null;
    movementPlannedCount: number | null;
    movementSucceededCount: number | null;
    movementStatus: "executed" | "planned_not_executed" | "not_planned" | "unknown";
    subtitlesEnabled: boolean | null;
    subtitleTimingStatus: "verified" | "unverified" | "disabled" | "unknown";
    voiceoverTimingStatus: "verified" | "unverified" | "unknown";
    finalOutputValidated: boolean | null;
  };
  /**
   * HARD RULE — every sentence has a picture that fits, and no blue-grey card ground in the file.
   * "Covered" = the sentence has visible footage or a content graphic (chart, map, photo …) as its
   * picture; a drawn chapter card (the blue-grey `PRIMARY_GROUND` of Graphics.tsx) is NOT cover.
   */
  coverage: {
    /** Sentences covered / sentences × 100 (sentences with visible footage or a content graphic). */
    sentenceVisualCoverage: number | null;
    uncoveredSentenceCount: number | null;
    /** Seconds the chapter-card ground (blue-grey) is the picture — from the timeline's card clips, NOT measured on the MP4. */
    blueGrayPlaceholderSeconds: number | null;
    blueGrayBasis: "timeline_card_clips" | "quality_rescue_cardSec" | "mp4_measured" | "unknown";
    placeholderDetected: boolean | null;
    /** The delivered file's own check (`[RenderJob] contentCheck`): black/freeze/silence only; it does not see the card ground. */
    deliveredFileCheck: { ok: boolean; black: number; freeze: number; silent: number; frames: number } | null;
    visualCoverageFailures: Array<{ sentence: string; text: string | null; reasons: string[] }>;
  };
  /** The second-section route (another 40 s section from a source already on disk): one event per attempt, never counted twice. */
  secondSection: {
    active: boolean | null;
    secondSectionAttempts: number | null;
    secondSectionCutsSucceeded: number | null;
    secondSectionCutsFailed: number | null;
    /** Moments from second sections handed to a sentence's look (sum of `moments=`). */
    secondSectionCandidatesOffered: number | null;
    secondSectionJudgeFitCount: number | null;
    /** Looks on second-section moments that ended without a fit (rounds, not moments). */
    secondSectionJudgeMismatchCount: number | null;
    /** FITs whose video is in the sentence's delivered picture ([SENTENCE_PICTURE]). */
    secondSectionPlacedCount: number | null;
    secondSectionApprovedNotPlacedCount: number | null;
    /** Download lines for a second-section video after its first attempt — expected 0. */
    secondSectionExtraDownloads: number | null;
    /** Paid Tunelio /create lines for a second-section video after its first attempt — expected 0. */
    secondSectionPaidTunelioRequests: number | null;
    /** cut_ms + look_ms over all attempts, seconds. */
    secondSectionProcessingSeconds: number | null;
  };
  /**
   * HARD QUALITY GATE — what the render worker measured on the delivered timeline and file, and what the
   * DeliveryGate decided ([SentenceCoverage] lines, the contentCheck placeholder fields, [DeliveryGate]).
   */
  hardGate: {
    sentences: number | null;
    fullyCovered: number | null;
    partiallyCovered: number | null;
    uncovered: number | null;
    coverageUnknown: number | null;
    stretchedClips: number | null;
    plannedPlaceholderSeconds: number | null;
    /** From the MP4 scan: planned card intervals whose every sample showed the ground. */
    mp4PlaceholderConfirmedSeconds: number | null;
    mp4PlaceholderIndicatedSeconds: number | null;
    mp4PlaceholderFrames: number | null;
    placeholderDetectionComplete: boolean | null;
    /** "proven=yes" on the TOTAL line: every sentence covered on measured timing. */
    coverageProven: boolean | null;
    gateDecision: "pass" | "fail" | "unknown";
    gateFailures: string[];
    perSentence: Array<{ sentence: string; status: string; timing: string; kinds: string[]; coveredSec: number | null; cardSec: number | null; reason: string | null }>;
  };
  /** Where each top-level figure came from. Keys are dotted paths (`visual.movingFootageSeconds`). */
  provenance: Record<string, Provenance>;
  /** Formulas, caveats and what could not be told from the data. */
  notes: string[];
  /** The analyser's view of the input: partial logs, duplicates dropped, lines it could not read. */
  input: {
    lines: number;
    duplicateLinesDropped: number;
    invalidLines: number;
    recognisedLines: number;
    partial: boolean;
    partialReasons: string[];
  };
};

/* ───────────────────────── arithmetic that never invents a number ───────────────────────── */

/** `part / whole × 100`, one decimal; null when either side is unknown or the whole is not positive. */
export function percent(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part == null || whole == null) return null;
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0 || part < 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** A duration read from a line: null unless it is a finite number above zero. */
export function validSeconds(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The per-source seconds of a list of clips, the largest first. */
export function sourceDistribution(
  clips: ReadonlyArray<{ sourceId: string; provider: string; durationSec: number }>
): Array<{ sourceId: string; provider: string; seconds: number }> {
  const by = new Map<string, { sourceId: string; provider: string; seconds: number }>();
  for (const c of clips) {
    if (!Number.isFinite(c.durationSec) || c.durationSec <= 0) continue;
    const key = `${c.provider}:${c.sourceId}`;
    const row = by.get(key) ?? { sourceId: c.sourceId, provider: c.provider, seconds: 0 };
    row.seconds = round2(row.seconds + c.durationSec);
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.seconds - a.seconds || a.sourceId.localeCompare(b.sourceId));
}

/**
 * Unique clips, pieces and repeats. A timeline clip id `vc_<hash>[_graphicN][_pM]`: the `_pM` suffix
 * marks a piece of one shot decision (not a repeat). A repeat is the same source AND the same source
 * in-point placed twice — only countable when the clips carry a source in-point.
 */
export function clipIdentityCounts(
  clips: ReadonlyArray<{ clipId: string; sourceId: string; provider: string; sourceInSec?: number | null }>
): { clips: number; shotDecisions: number; pieces: number; repeated: number | null } {
  const decisions = new Set<string>();
  let pieces = 0;
  for (const c of clips) {
    const base = c.clipId.replace(/_p\d+$/, "");
    if (base !== c.clipId) pieces++;
    decisions.add(base);
  }
  const withIn = clips.filter((c) => c.sourceInSec != null && Number.isFinite(c.sourceInSec));
  let repeated: number | null = null;
  if (withIn.length === clips.length && clips.length > 0) {
    const seen = new Set<string>();
    repeated = 0;
    for (const c of withIn) {
      const k = `${c.provider}:${c.sourceId}@${c.sourceInSec}`;
      if (seen.has(k)) repeated++;
      else seen.add(k);
    }
  }
  return { clips: clips.length, shotDecisions: decisions.size, pieces, repeated };
}

/* ───────────────────────── the human rating ───────────────────────── */

export const HUMAN_RATING_CRITERIA = [
  "pictureMatchesSpeech",
  "visualVariety",
  "editingAndPace",
  "voiceoverAndSubtitles",
  "chartsAndExplanation",
  "overallViewingQuality",
] as const;
export type HumanRatingCriterion = (typeof HUMAN_RATING_CRITERIA)[number];

export type HumanRating = {
  renderId: string;
  testId: string;
  gitSha: string;
  ratedAt: string;
  rater?: string;
  scores: Record<HumanRatingCriterion, number>;
  /** The mean of the six scores, two decimals — written by `averageHumanRating`, never by hand. */
  averageScore: number;
  note?: string;
};

export function averageHumanRating(scores: Record<HumanRatingCriterion, number>): number {
  const values = HUMAN_RATING_CRITERIA.map((k) => scores[k]);
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/** Why a rating record is not acceptable; an empty list means it is. Scores are whole numbers 1–5, all six present. */
export function validateHumanRating(raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return ["not an object"];
  const r = raw as Record<string, unknown>;
  for (const k of ["renderId", "testId", "gitSha", "ratedAt"]) {
    if (typeof r[k] !== "string" || !(r[k] as string).trim()) problems.push(`${k} missing`);
  }
  if (typeof r.ratedAt === "string" && Number.isNaN(Date.parse(r.ratedAt))) problems.push("ratedAt is not a date");
  const scores = r.scores as Record<string, unknown> | undefined;
  if (!scores || typeof scores !== "object") problems.push("scores missing");
  else {
    for (const k of HUMAN_RATING_CRITERIA) {
      const v = scores[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) problems.push(`score ${k} must be a whole number 1–5`);
    }
    for (const k of Object.keys(scores)) if (!(HUMAN_RATING_CRITERIA as readonly string[]).includes(k)) problems.push(`unknown score ${k}`);
    if (problems.length === 0) {
      const avg = averageHumanRating(scores as Record<HumanRatingCriterion, number>);
      if (typeof r.averageScore !== "number" || Math.abs(r.averageScore - avg) > 0.005) problems.push(`averageScore must be ${avg}`);
    }
  }
  return problems;
}

/* ───────────────────────── the fixed test set ───────────────────────── */

export const VISUAL_STRATEGIES = ["real_footage", "archival_footage", "chart_data", "map", "text_card"] as const;
export type VisualStrategy = (typeof VISUAL_STRATEGIES)[number];

export type QualityTestPrompt = {
  id: string;
  genre: string;
  title: string;
  prompt: string;
  /** A fixed script for repeatable runs, when one has been recorded; null until then. */
  scriptVersion: string | null;
  /** The visual strategy a reviewer expects for this subject — a test expectation, not a forced outcome. */
  expectedVisualStrategy: VisualStrategy[];
  notes?: string;
};

export function validateTestPrompts(raw: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return ["not an array"];
  const ids = new Set<string>();
  raw.forEach((p: Record<string, unknown>, i) => {
    const at = `prompt[${i}]`;
    if (typeof p.id !== "string" || !/^vq-\d{2}-[a-z0-9-]+$/.test(p.id)) problems.push(`${at}: id must look like vq-01-slug`);
    else if (ids.has(p.id)) problems.push(`${at}: duplicate id ${p.id}`);
    else ids.add(p.id);
    for (const k of ["genre", "title", "prompt"]) if (typeof p[k] !== "string" || !(p[k] as string).trim()) problems.push(`${at}: ${k} missing`);
    if (!("scriptVersion" in p) || (p.scriptVersion !== null && typeof p.scriptVersion !== "string")) problems.push(`${at}: scriptVersion must be a string or null`);
    const s = p.expectedVisualStrategy;
    if (!Array.isArray(s) || s.length === 0) problems.push(`${at}: expectedVisualStrategy missing`);
    else for (const x of s) if (!(VISUAL_STRATEGIES as readonly string[]).includes(x as string)) problems.push(`${at}: unknown strategy ${String(x)}`);
  });
  return problems;
}
