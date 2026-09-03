/**
 * Retrieval Funnel Engine — hybrid parallel retrieval with coverage-based weighting.
 *
 * All sources (own archive + Wikimedia + Pexels + Pixabay) are queried in parallel.
 * The archive's embedding similarity against the beat query determines an
 * `archiveCoverage` score (0–1) which automatically shifts the weight balance:
 *
 *   coverage > 0.88 → archive_dominant (archive weight 1.0, internet weight 0.3)
 *   coverage 0.45–0.88 → hybrid (weights proportional to coverage)
 *   coverage < 0.45 → internet_dominant (archive weight 0.3, internet weight 1.0)
 *
 * The user never sees "no results" from the archive — when coverage is low, internet
 * sources simply carry more weight and the archive fades out gracefully.
 *
 * Entry point: buildRetrievalFunnel(request) → RetrievalFunnelResult
 *
 * Feature flag: ENABLE_RETRIEVAL_FUNNEL=true (also requires ENABLE_SCENE_CANDIDATE_POOL=true).
 */

import {
  buildTopicMatcher,
  assessCandidateTopicality,
  topicalRankingBonus,
  type TopicMatcher,
} from "./candidateTopicalRelevance";
import {
  listCuratedArchiveCandidates,
  buildBeatMatchTags,
  applyCrossVideoVarietyDegrade,
  stubPowerWordFromSceneText,
  extractTopicAnchorTags,
  type CuratedCandidatePick,
} from "./curatedMediaSourcing";
import {
  scoreBeatAgainstStoredEmbedding,
  loadStoredAssetEmbedding,
} from "./archiveEmbeddingIndex";
import { cosineSimilarityVectors } from "./semanticVisualMatching";
import {
  matchCandidateToBeat,
  type BeatTemporalContext,
} from "./candidatePeriodMatch";
import {
  formatSearchMemoryLine,
  mergeRecalledIntoArchivePicks,
  recallProvenAssetsForEntity,
  type SearchMemoryRecallMetrics,
} from "./searchMemoryRecall";
import {
  recordShortlistStage,
  type ArchiveSourcingAudit,
} from "./archiveSourcingAudit";
import {
  buildSceneCandidatePool,
  type PoolCandidate,
  type BuildPoolRequest,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_POOL_SIZE,
} from "./scenePool";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FunnelCandidateSource =
  | "archive"
  | "pexels"
  | "pixabay"
  | "wikimedia"
  | "internet_archive"
  | "europeana"
  | "openverse"
  | "nasa"
  | "nara"
  | "loc"
  /** RONDE 169 — YouTube is a pool source now, so the funnel counts it like any other. */
  | "youtube_cc";

export type FunnelStrategy =
  | "archive_dominant"   // coverage > ARCHIVE_DOMINANT_THRESHOLD
  | "hybrid"             // coverage between thresholds
  | "internet_dominant"; // coverage < INTERNET_DOMINANT_THRESHOLD

/**
 * Unified candidate from any retrieval source.
 * Archive candidates carry an `archivePick`; external ones carry a `poolCandidate`.
 * Exactly one of the two is present.
 */
export type FunnelCandidate = {
  /** Stable dedup key. */
  id: string;
  source: FunnelCandidateSource;
  title: string;
  thumbnailUrl: string | null;
  mediaType: "video" | "image";

  // ── Ranking scores ──────────────────────────────────────────────────────────
  /** Cosine similarity of beat-text embedding vs asset embedding (0–1, null when not indexed). */
  embeddingSimilarity: number | null;
  /** Keyword-match score from the archive ranker (0–N, null for external). */
  archiveKeywordScore: number | null;
  /** CLIP image-text similarity (filled by P2 thumbnail ranking). */
  clipSimilarity: number | null;
  /** Final merged score after source-weight application. */
  rankingScore: number;

  // ── Payload for download step ───────────────────────────────────────────────
  /** Set when source === "archive" — pass to fetchCuratedArchiveBeatClip. */
  archivePick?: CuratedCandidatePick;
  /** Set when source !== "archive" — pass to downloadAndTrimPoolCandidate. */
  poolCandidate?: PoolCandidate;

  // ── Self-learning: per-beat scoring ────────────────────────────────────────
  /**
   * Pre-loaded text embedding for this asset (archive only).
   * Used by scoreFunnelCandidateForBeat() to do fast in-memory per-beat cosine
   * similarity without extra API calls.
   */
  storedEmbedding?: number[];
};

export type FunnelMetrics = {
  retrievalLatencyMs: number;
  archiveCoverage: number;
  strategy: FunnelStrategy;
  archiveCandidateCount: number;
  externalCandidateCount: number;
  mergedCount: number;
  finalCount: number;
  embeddingScoredCount: number;
};

export type RetrievalFunnelResult = {
  sceneIndex: number;
  candidates: FunnelCandidate[];
  archiveCoverage: number;
  strategy: FunnelStrategy;
  metrics: FunnelMetrics;
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

// RONDE 51: same recalibration as the per-beat thresholds below — these are compared against
// the same raw-cosine coverage value. Render 530 measured scene-level coverage at 0.4146,
// 0.4496 and 0.4671, so 0.88 was unreachable and every scene resolved the same way.
// Overridable from the environment; the pre-Ronde-51 values were 0.88 and 0.45.
const ARCHIVE_DOMINANT_THRESHOLD = envThreshold("ARCHIVE_DOMINANT_THRESHOLD", 0.46);
const INTERNET_DOMINANT_THRESHOLD = envThreshold("INTERNET_DOMINANT_THRESHOLD", 0.25);

function envThreshold(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** When the archive has NO embedding index at all, fall back to normalised keyword
 *  score.  The keyword scorer returns raw integer points — 100 pts ~ good match. */
const KEYWORD_SCORE_MAX = 100;

/** FASE 2/3 source priority (own archive is handled separately, always highest):
 *  historical/open sources get a small pre-CLIP ranking bonus over stock (Pexels/Pixabay), so
 *  they're more likely to land in the small top-N slice that actually gets downloaded and
 *  scored — without touching VisionGate or the final pickBestFunnelCandidate() margin logic,
 *  which still decides the real winner. FASE 3 inserts NARA/Library of Congress/NASA/Openverse
 *  between Internet Archive and Europeana, per the requested priority order (Internet Archive
 *  > NARA > Library of Congress > NASA > Openverse > Europeana > Wikimedia > stock); the FASE 2
 *  values for internet_archive/europeana/wikimedia/pexels/pixabay are left unchanged. */
const EXTERNAL_SOURCE_TIER_BONUS: Partial<Record<FunnelCandidateSource, number>> = {
  internet_archive: 0.15,
  nara: 0.145,
  loc: 0.14,
  nasa: 0.135,
  openverse: 0.125,
  europeana: 0.12,
  wikimedia: 0.10,
  pexels: 0,
  pixabay: 0,
};

/**
 * RONDE 27: nudge toward footage that actually moves.
 *
 * Render 528's final cut was 18 clips of which 7 were stills panned with Ken Burns — Wikimedia
 * photographs of Hitler, a Bundesarchiv plate, a curated still — because for this topic the
 * best-MATCHING material is photographic while the moving material is mostly generic stock.
 *
 * This is deliberately a shortlist nudge, not a veto. rankingScore decides which candidates get
 * downloaded and CLIP-scored at all (MAX_FUNNEL_CANDIDATES_TO_SCORE); the winner is still chosen
 * by pickBestFunnelCandidate on real VisionGate scores. So a clip gets a better chance to be
 * CONSIDERED, and a well-matching still still beats a poorly-matching clip. Sized at roughly half
 * a source-tier step (the tier bonuses above span 0–0.15) — pushing harder would trade the user's
 * "everything should match" against their "more video", which is the wrong trade to make blind.
 */
const MOVING_FOOTAGE_BONUS = 0.08;

/**
 * RONDE 29: the bonus now knows how the render is actually going.
 *
 * RONDE 27 applied a flat nudge whether the montage was already all video or all stills — it
 * could not tell the difference, because nothing measured the result. `deficit` (0–1, from
 * visualMixPolicy.movingShareDeficit) closes that loop: 0 when the render is at or above its
 * moving-footage target, rising to 1 when nothing adopted so far moves.
 *
 * The bonus scales between 1× and 2× the base — so at most 0.16, still inside a single
 * source-tier step (the tier bonuses span 0–0.15). A render on target behaves exactly as it did
 * before this change; only a render drifting toward an all-stills montage pulls harder. Still a
 * shortlist nudge, never a veto: the winner is decided by pickBestFunnelCandidate on real
 * VisionGate scores, so a well-matching still continues to beat a poorly-matching clip.
 */
function movingFootageBonus(mediaType: "video" | "image", deficit = 0): number {
  if (mediaType !== "video") return 0;
  let base = MOVING_FOOTAGE_BONUS;
  if (process.env.MOVING_FOOTAGE_BONUS?.trim()) {
    const n = parseFloat(process.env.MOVING_FOOTAGE_BONUS.trim());
    if (!isNaN(n) && n >= 0 && n <= 0.5) base = n;
  }
  return base * (1 + Math.max(0, Math.min(1, deficit)));
}

// ─── Per-beat gap strategy (self-learning retrieval) ─────────────────────────

/**
 * Tiered confidence thresholds for per-beat archive gap detection.
 * When an archive candidate's per-beat embedding similarity meets one of these
 * thresholds, only the specified number of external sources are queried.
 */
/**
 * RONDE 51 — recalibrated against the first real measurement (render 530, 14 beats).
 *
 * These thresholds are compared against the value computeArchiveCoverage returns, which on the
 * embedding path is a RAW text↔text cosine from text-embedding-3-small. They were set as if that
 * value were a normalised relevance score where 0.94 means "excellent". It is not: for two
 * genuinely related pieces of text that model lands around 0.4, and 0.94 would require nearly
 * identical strings.
 *
 * Render 530 measured, across every beat of a WWII documentary against a WWII archive:
 *
 *     0.2143  0.2488  0.2510  0.2526  0.2642  0.3529  0.3952
 *     0.3985  0.4200  0.4264  0.4373  0.4618  0.5069  0.5344
 *
 *     min 0.2143 · median ~0.40 · max 0.5344 · n=14
 *
 * Against 0.94 / 0.75 / 0.50 that produced twelve "aggressive" and two "all_external" — the
 * archive could not win a single beat, and the strategy decision carried no information because
 * it was the same for almost every beat. The archive was still used (a separate keyword path in
 * curatedMediaSourcing adopts assets on its own scores of 96–306), so this was never a hard
 * block; it made the funnel's verdict meaningless.
 *
 * The new defaults place the tiers inside the band that was actually observed: the top of the
 * measured range wins outright, the upper third hedges with one external, and the bottom third
 * still fans out. Every value stays overridable from the environment so the next render can move
 * them without a deploy, and reverting is setting three variables back to 0.94 / 0.75 / 0.50.
 *
 * n=14 from one render is a starting point, not a final calibration. The [FunnelBeatCalib] line
 * logs the score for every beat, so the next render measures these directly.
 */
function archiveThreshold(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export const BEAT_ARCHIVE_STOP_THRESHOLD = archiveThreshold("BEAT_ARCHIVE_STOP_THRESHOLD", 0.50);
export const BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD = archiveThreshold("BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD", 0.42);
export const BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD = archiveThreshold("BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD", 0.30);

/** Max consecutive archive-only beats before forcing at least one external source for variety. */
const MAX_CONSECUTIVE_ARCHIVE_ONLY = 2;

export type BeatGapStrategy =
  | "archive_only"    // score > 0.94 — use archive, no internet call
  | "one_external"    // score 0.75–0.94 — archive + one external source as hedge
  | "all_external"    // score 0.50–0.75 — archive + all external sources
  | "aggressive";     // score < 0.50 — archive deprioritised, all external, more results

/**
 * Determines how many external sources to query based on the best archive score for a beat.
 * `consecutiveArchiveBeats` — how many preceding beats were resolved from archive only.
 * When this exceeds MAX_CONSECUTIVE_ARCHIVE_ONLY, the strategy is capped at "one_external"
 * to ensure source diversity and prevent visual monoculture.
 */
export function resolvePerBeatGapStrategy(
  bestArchiveScore: number | null,
  consecutiveArchiveBeats = 0
): BeatGapStrategy {
  if (bestArchiveScore === null || bestArchiveScore < BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD) {
    return "aggressive";
  }

  let strategy: BeatGapStrategy;
  if (bestArchiveScore >= BEAT_ARCHIVE_STOP_THRESHOLD) strategy = "archive_only";
  else if (bestArchiveScore >= BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD) strategy = "one_external";
  else strategy = "all_external";

  // Diversity guard: cap archive_only → one_external after too many consecutive archive beats
  if (strategy === "archive_only" && consecutiveArchiveBeats >= MAX_CONSECUTIVE_ARCHIVE_ONLY) {
    return "one_external";
  }
  return strategy;
}

/**
 * Scores a FunnelCandidate against a pre-computed beat embedding using the
 * pre-loaded storedEmbedding (in-memory cosine similarity — no API call).
 * Returns null when no stored embedding is available.
 */
export function scoreFunnelCandidateForBeat(
  candidate: FunnelCandidate,
  beatEmbedding: number[]
): number | null {
  if (!candidate.storedEmbedding || candidate.storedEmbedding.length === 0) return null;
  return Math.max(0, cosineSimilarityVectors(beatEmbedding, candidate.storedEmbedding));
}

/**
 * Finds the best archive candidate for a specific beat, scoring each archive
 * candidate against the beat embedding.  Returns the best score (0–1) or null
 * when no archive candidates have stored embeddings.
 */
export function findBestArchiveScoreForBeat(
  candidates: FunnelCandidate[],
  beatEmbedding: number[],
  /**
   * RONDE 38: filled with the candidate that produced the returned score, for the
   * [FunnelBeatCalib] diagnostic line only. Same loop, same comparisons, same return value —
   * omit it and this function behaves exactly as before.
   */
  bestOut?: { candidate?: FunnelCandidate }
): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (c.source !== "archive") continue;
    const score = scoreFunnelCandidateForBeat(c, beatEmbedding);
    if (score !== null && (best === null || score > best)) {
      best = score;
      if (bestOut) bestOut.candidate = c;
    }
  }
  return best;
}

/**
 * Orders funnel candidates for archive-first per-beat retrieval.
 *
 * FIX 4 — archive-first is an ORDERING PREFERENCE, not candidate elimination.
 *
 * `archive_only` used to return the archive candidates alone and `one_external` used to keep
 * exactly one external (`externalCands.slice(0, 1)`). That discarded candidates before the
 * funnel could judge them: this function runs BEFORE the FUNNEL_CANDIDATE_POOL_LIMIT slice,
 * BEFORE buildDownloadShortlist() and BEFORE VisionGate, so a dropped candidate was never
 * ranked, never downloaded and never scored. Render 515 retrieved 47 external candidates for
 * a scene with 2 archive candidates and could act on at most 3 of the 49 — which is also why
 * the per-beat exclusion (FIX 2) had almost nothing left to choose from and 13 beats shared
 * 3 assets.
 *
 * Every strategy now returns the FULL candidate set; only the order differs:
 *   archive_only  → archive first, then all externals (was: externals removed)
 *   one_external  → archive first, then all externals (was: only the top external kept)
 *   all_external  → archive first, then all externals    [unchanged]
 *   aggressive    → externals first, then archive        [unchanged]
 *
 * The strategy therefore still expresses how strongly the archive is favoured — a stronger
 * archive signal keeps the archive at the head of the list, which is what decides who fills
 * the shortlist's limited slots first. What it no longer does is delete the alternatives.
 * No score is recomputed, no penalty is applied, no candidate is reordered within its own
 * group: externals keep their existing rankingScore sort, and everything downstream
 * (per-source caps, MAX_FUNNEL_CANDIDATES_TO_SCORE, VisionGate, pickBestFunnelCandidate's
 * stock/non-stock margin) is untouched.
 */
export function orderCandidatesForBeatGap(
  candidates: FunnelCandidate[],
  strategy: BeatGapStrategy
): FunnelCandidate[] {
  const archiveCands = candidates.filter(c => c.source === "archive");
  const externalCands = candidates
    .filter(c => c.source !== "archive")
    .sort((a, b) => b.rankingScore - a.rankingScore);

  switch (strategy) {
    case "archive_only":
    case "one_external":
    case "all_external":
      // Archive leads; externals stay available behind it, in ranking order.
      return [...archiveCands, ...externalCands];
    case "aggressive":
      // Archive still available as fallback but external leads
      return [...externalCands, ...archiveCands];
  }
}

// ─── Coverage scoring ─────────────────────────────────────────────────────────

/**
 * Computes archive coverage from the top-K archive candidates.
 * Tries embedding similarity first (requires ENABLE_ARCHIVE_EMBEDDING_INDEX).
 * Falls back to normalised keyword score.
 * Returns 0 when the archive has zero candidates.
 */
async function computeArchiveCoverage(
  candidates: CuratedCandidatePick[],
  beatDocument: string,
  /**
   * RONDE 36: only used for the [FunnelCalib] diagnostic line below. The coverage value itself
   * does not depend on it. This function runs once per scene (buildRetrievalFunnel), so there is
   * no beat index to log here — the beat-level decision is a separate call in videoPipeline.
   */
  sceneIndex: number,
  topK = 5
): Promise<number> {
  if (candidates.length === 0) return 0;

  const top = candidates.slice(0, topK);

  // Try embedding similarity on top-K
  const embSims = await Promise.all(
    top.map(c => scoreBeatAgainstStoredEmbedding(beatDocument, c.asset.id).catch(() => null))
  );
  // RONDE 36: same maximum the previous `Math.max(...embSims.filter(...))` produced, but the
  // index is kept so the calibration line can name the asset the coverage is actually based on.
  // An empty/all-null set leaves maxEmb at -Infinity, exactly as Math.max() of nothing did, and
  // a NaN entry never wins the comparison — both still fall through to the keyword branch below.
  let maxEmb = -Infinity;
  let maxEmbIdx = -1;
  for (let i = 0; i < embSims.length; i++) {
    const s = embSims[i];
    if (s === null) continue;
    if (s > maxEmb) {
      maxEmb = s;
      maxEmbIdx = i;
    }
  }
  if (isFinite(maxEmb) && maxEmb > 0) {
    logFunnelCalibration(sceneIndex, maxEmb, top[maxEmbIdx], beatDocument);
    return Math.min(1, maxEmb);
  }

  // Fallback: normalise keyword score (raw points → 0–1)
  const topScore = candidates[0].score;
  logFunnelCalibration(sceneIndex, null, candidates[0], beatDocument);
  if (!topScore || topScore <= 0) return 0;
  return Math.min(1, topScore / KEYWORD_SCORE_MAX);
}

/**
 * RONDE 36 — calibration measurement only. Emits nothing but a log line.
 *
 * The audit proved the two coverage branches are not on one scale: the embedding branch returns a
 * raw text↔text cosine in [0,1], the keyword branch an unbounded point sum divided by an
 * arbitrary KEYWORD_SCORE_MAX, and the strategy thresholds (0.50 / 0.75 / 0.94) sit on top of
 * both. Choosing a correct recalibration needs the two numbers PAIRED, per real beat, with the
 * asset they came from — which nothing logs today: the embedding score is reported alone, and the
 * keyword score only surfaces in a different message from a different code path.
 *
 * Deliberately reads nothing it is not handed: the pick is already in memory, so there is no DB
 * query, no embedding call, no asset lookup. Values are printed at full precision (cosine to four
 * decimals, keyword score raw and unnormalised) so the analysis is not fighting rounding.
 */
function logFunnelCalibration(
  sceneIndex: number,
  cosine: number | null,
  pick: CuratedCandidatePick | undefined,
  beatDocument: string
): void {
  const assetId = pick?.asset?.id;
  const archive = pick?.archiveName?.trim();
  const title = pick?.asset?.title?.trim();
  // RONDE 38: the archive NAME and the beat text turn this line from "two numbers" into
  // something a human can actually judge. Render 529 showed why both are needed: every curated
  // adoption came from an archive called "Pexels", so a rising coverage score there would mean
  // "more stock via the archive route", not "more historical footage" — and without the beat
  // text there is no way to tell whether the asset belonged to the sentence at all.
  const beat = beatDocument.replace(/\s+/g, " ").trim().slice(0, 60);
  console.log(
    `[FunnelCalib] s${sceneIndex} emb=${cosine === null ? "n/a" : cosine.toFixed(4)} ` +
      `kw=${pick?.score ?? "unknown"} asset=${assetId ?? "unknown"} ` +
      `archive="${archive || "unknown"}" title="${title || "unknown"}" beat="${beat || "unknown"}"`
  );
}

// ─── Strategy resolution ──────────────────────────────────────────────────────

function resolveStrategy(coverage: number): FunnelStrategy {
  if (coverage > ARCHIVE_DOMINANT_THRESHOLD) return "archive_dominant";
  if (coverage > INTERNET_DOMINANT_THRESHOLD) return "hybrid";
  return "internet_dominant";
}

function sourceWeights(strategy: FunnelStrategy): { archive: number; internet: number } {
  switch (strategy) {
    case "archive_dominant":  return { archive: 1.0, internet: 0.30 };
    case "hybrid":            return { archive: 0.70, internet: 0.70 };
    case "internet_dominant": return { archive: 0.30, internet: 1.0 };
  }
}

// ─── Archive search ───────────────────────────────────────────────────────────

async function searchArchiveCandidates(
  query: string,
  sceneText: string,
  videoTitle: string | undefined,
  max: number
): Promise<{ candidates: CuratedCandidatePick[]; beatDocument: string }> {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const stubBeat = {
    index: 0,
    text: sceneText.slice(0, 400),
    keywords: words.slice(0, 8),
    searchQuery: query.slice(0, 120),
    // RONDE 27: third instance of the "first word longer than four letters" anchor that RONDE 26
    // replaced elsewhere. Same failure — for a Führerbunker scene it yields "chaos".
    powerWord: stubPowerWordFromSceneText(sceneText.slice(0, 400)) || words[0] || "documentary",
  };
  const stubScene = { text: sceneText.slice(0, 200), pexelsQuery: query };
  const { beatTags, topicAnchors, allTags, videoVisualTopic } = buildBeatMatchTags(
    stubBeat, stubScene, videoTitle
  );

  const beatDocument = `${query}. ${sceneText.slice(0, 300)}`;

  let candidates: CuratedCandidatePick[] = [];
  try {
    candidates = await listCuratedArchiveCandidates(
      beatTags,
      new Set(),
      new Set(),
      topicAnchors,
      allTags,
      sceneText.slice(0, 400),
      new Set(),
      undefined,
      true,
      true,
      videoVisualTopic
    );
  } catch (err) {
    console.warn("[Funnel] Archive search failed:", (err as Error).message?.slice(0, 80));
  }

  return {
    candidates: candidates.slice(0, max),
    beatDocument,
  };
}

// ─── Merge + dedup ────────────────────────────────────────────────────────────

function archiveCandidateId(pick: CuratedCandidatePick): string {
  return `archive:${pick.asset.id}`;
}

export function mergeCandidates(
  archivePicks: CuratedCandidatePick[],
  archiveEmbSims: (number | null)[],
  externalPool: PoolCandidate[],
  archiveWeight: number,
  internetWeight: number,
  max: number,
  /** RONDE 29: 0–1 shortfall against the render's moving-footage target. 0 = neutral. */
  movingDeficit = 0,
  /**
   * RONDE 54: what this video is about, so an external candidate can be judged on the words its
   * own provider attached to it. Optional — omitted, every candidate is treated as unjudgeable
   * and the ranking is exactly what it was.
   */
  topicMatcher?: TopicMatcher,
  /**
   * RONDE 175 §2: the years, places and subjects this beat is established to be about.
   *
   * Optional for the same reason as topicMatcher — omitted, every candidate scores exactly as it
   * did before, because absence of period information is neutral by design.
   */
  beatTemporalContext?: BeatTemporalContext
): FunnelCandidate[] {
  const seen = new Set<string>();
  const merged: FunnelCandidate[] = [];
  /** RONDE 54: external candidates whose metadata argues against them. */
  const offTopic: Array<{ candidate: PoolCandidate; reason: string }> = [];

  // Archive candidates
  for (let i = 0; i < archivePicks.length; i++) {
    const pick = archivePicks[i];
    const id = archiveCandidateId(pick);
    if (seen.has(id)) continue;
    seen.add(id);

    const embSim = archiveEmbSims[i] ?? null;
    // Base score: normalised keyword match (0–1) × archive weight
    const kwBase = Math.min(1, pick.score / KEYWORD_SCORE_MAX);
    const embBoost = embSim !== null ? embSim * 0.4 : 0;
    const archiveMediaType = (pick.asset.mediaType === "video" ? "video" : "image") as "video" | "image";
    /**
     * RONDE 175 §2 — what the candidate says about its own period, place and subject.
     *
     * Applied to the archive too, and not only to stock: an archive holding a 1945 reel is no
     * better a fit for a 1926 beat than a stock clip would be. Absence is neutral, so the
     * catalogue-numbered titles this archive is full of ("Bundesarchiv Bild 183-S33882") score
     * exactly as they did before.
     */
    const archiveMatch = matchCandidateToBeat(
      [pick.asset.title, (pick.asset as { description?: string }).description, pick.archiveName]
        .filter(Boolean)
        .join(" "),
      beatTemporalContext
    );
    const rankingScore =
      (kwBase + embBoost + movingFootageBonus(archiveMediaType, movingDeficit) + archiveMatch.bonus) *
      archiveWeight;

    // Load stored embedding for fast per-beat cosine scoring (no extra API call)
    const storedEmb = loadStoredAssetEmbedding(pick.asset.id);

    merged.push({
      id,
      source: "archive",
      title: pick.asset.title ?? "archive clip",
      thumbnailUrl: null, // archive assets don't expose thumbnail URLs
      mediaType: archiveMediaType,
      embeddingSimilarity: embSim,
      archiveKeywordScore: pick.score,
      clipSimilarity: null,
      rankingScore,
      archivePick: pick,
      storedEmbedding: storedEmb?.embedding,
    });
  }

  // External candidates
  for (const c of externalPool) {
    const id = c.id;
    if (seen.has(id)) continue;
    seen.add(id);

    // FASE 2 / STAP 7: pre-CLIP source priority. All external candidates previously got the
    // exact same flat score (internetWeight * 0.7) regardless of provider, so historical/open
    // sources (Wikimedia, Internet Archive, Europeana) had no better a chance than Pexels/
    // Pixabay of landing in the small top-N slice that actually gets downloaded and CLIP-scored
    // (see videoPipeline.ts's MAX_FUNNEL_CANDIDATES_TO_SCORE cap). This bonus only affects which
    // candidates make that shortlist — the actual winner is still decided by
    // pickBestFunnelCandidate() on real VisionGate scores, unchanged.
    // RONDE 54: the candidate's own metadata finally gets a vote. Until now every external
    // candidate scored identically here regardless of subject, so "white-lives-matter-montana-
    // sticker" and "Signed Photograph of Adolf Hitler" arrived at the CLIP tie-break level —
    // and CLIP scored the sticker HIGHER (0.2226 vs 0.2116 in render 531).
    const topical = topicMatcher ? assessCandidateTopicality(c, topicMatcher) : null;
    if (topical?.verdict === "off_topic") {
      offTopic.push({ candidate: c, reason: topical.reason });
      continue;
    }
    const rankingScore =
      internetWeight *
      (0.7 +
        (EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0) +
        movingFootageBonus(c.mediaType, movingDeficit) +
        // RONDE 175 §2: agreement on year, place or subject lifts; a year that genuinely conflicts
        // costs. Saying nothing costs nothing.
        matchCandidateToBeat(`${c.title ?? ""} ${c.assetId ?? ""}`, beatTemporalContext).bonus +
        topicalRankingBonus(topical?.verdict ?? "neutral"));
    merged.push({
      id,
      source: c.source as FunnelCandidateSource,
      title: c.title,
      thumbnailUrl: c.thumbnailUrl,
      mediaType: c.mediaType,
      embeddingSimilarity: null,
      archiveKeywordScore: null,
      clipSimilarity: null,
      rankingScore,
      poolCandidate: c,
    });
  }

  // RONDE 54: never starve a scene. A beat with no candidates becomes a colour card, which is
  // worse than a weak clip — so when the topical filter would leave nothing, the rejects come
  // back and the ranking penalty decides the order instead. Same principle as the archive's
  // exhaustion rule.
  if (merged.length === 0 && offTopic.length > 0) {
    console.warn(
      `[Funnel] every external candidate read as off-topic (${offTopic.length}) — keeping them ` +
        `rather than leaving the scene empty: ${offTopic.slice(0, 3).map((o) => o.reason).join(" | ")}`
    );
    for (const { candidate: c } of offTopic) {
      merged.push({
        id: `${c.source}:${c.assetId}`,
        source: c.source as FunnelCandidateSource,
        title: c.title,
        thumbnailUrl: c.thumbnailUrl,
        mediaType: c.mediaType,
        embeddingSimilarity: null,
        archiveKeywordScore: null,
        clipSimilarity: null,
        rankingScore: internetWeight * 0.2,
        poolCandidate: c,
      });
    }
  } else if (offTopic.length > 0) {
    console.log(
      `[Funnel] dropped ${offTopic.length} off-topic candidate(s): ` +
        offTopic.slice(0, 4).map((o) => `"${(o.candidate.title || o.candidate.assetId).slice(0, 40)}" (${o.reason})`).join(", ")
    );
  }

  merged.sort((a, b) => b.rankingScore - a.rankingScore);
  return merged.slice(0, max);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type RetrievalFunnelRequest = BuildPoolRequest & {
  videoTitle?: string;
  /** Max archive candidates to retrieve (default: MAX_CANDIDATES_PER_SOURCE). */
  maxArchiveCandidates?: number;
  /**
   * Asset IDs used in recent same-topic videos (from getCrossVideoExcludeAssetIds).
   * When set, these archive picks are held back so a filled archive doesn't keep
   * shipping the same footage — the funnel then leans on external providers for fresh
   * material. Degrades gracefully (applyCrossVideoVarietyDegrade): if holding them back
   * would starve the archive pool, they are kept as a last resort. Defaults to none.
   */
  crossVideoExcludeIds?: Set<number>;
  /**
   * RONDE 29: how far this render currently sits below its moving-footage target (0–1, from
   * visualMixPolicy.movingShareDeficit). Scales the moving-footage ranking bonus so a montage
   * drifting toward all-stills pulls harder on video candidates. Defaults to 0 — neutral, i.e.
   * exactly the RONDE 27 behaviour — so callers that don't track the mix are unaffected.
   */
  movingShareDeficit?: number;
  /**
   * RONDE 131: the subject this video is about, for the persistent cross-video search memory.
   *
   * When set, assets this entity has proven in EARLIER videos are recalled and offered alongside
   * the archive's own keyword matches for this beat. They are candidates and nothing more — the
   * coverage scoring, ranking, shortlist, download, preview validation, licence check, VisionGate
   * and duplicate rules below are the same ones every other candidate meets.
   *
   * Absent (the default) the funnel behaves exactly as it did before this round.
   */
  memoryEntity?: string;
  /** Assets already used this render; recall must not re-serve them. */
  memoryExcludeAssetIds?: Set<number>;
  /**
   * RONDE 175 §2 — the years, places and subjects this beat is established to be about.
   *
   * Used to rank, never to filter: a candidate that says nothing about its period is scored
   * exactly as it was before. Absent (the default) the ranking is unchanged.
   */
  beatTemporalContext?: BeatTemporalContext;
  /** RONDE 132 §11: rotates which of the equally-proven memory assets is offered first. */
  memoryVarietySeed?: number;
  /** RONDE 132 §2: called for each memory asset the video's used-asset set refused. */
  onMemoryAssetExcluded?: (memory: { assetId: number; query: string; source: string }) => void;
  /** Injected in tests so the recall path can be driven without a database. */
  recallProvenAssets?: typeof recallProvenAssetsForEntity;
  /** Counters for the recall, when the caller is keeping them. */
  memoryMetrics?: SearchMemoryRecallMetrics;
  /**
   * Filled with the asset ids this funnel recalled from memory, so the caller can tell a
   * remembered candidate apart later — specifically, to count the ones a gate then refused.
   */
  memoryRecalledInto?: Set<number>;
};

/**
 * Builds a hybrid retrieval funnel: queries archive + external providers in
 * parallel, computes archive coverage, weights candidates, merges and deduplicates.
 */
export async function buildRetrievalFunnel(
  req: RetrievalFunnelRequest
): Promise<RetrievalFunnelResult> {
  const t0 = Date.now();
  const {
    sceneIndex,
    sceneText,
    primaryQuery,
    extraQueries,
    pexelsApiKey,
    pixabayApiKey,
    europeanaApiKey,
    naraApiKey,
    skipPexels,
    skipPixabay,
    skipInternetArchive,
    skipEuropeana,
    skipOpenverse,
    skipNasa,
    skipNara,
    skipLoc,
    maxPerSource = MAX_CANDIDATES_PER_SOURCE,
    maxTotal = MAX_POOL_SIZE,
    videoTitle,
    maxArchiveCandidates = MAX_CANDIDATES_PER_SOURCE,
  } = req;

  // ── 1. Parallel retrieval ──────────────────────────────────────────────────
  const [archiveResult, externalPool] = await Promise.allSettled([
    searchArchiveCandidates(primaryQuery, sceneText, videoTitle, maxArchiveCandidates),
    buildSceneCandidatePool({
      sceneIndex, sceneText, primaryQuery, extraQueries,
      pexelsApiKey, pixabayApiKey, europeanaApiKey, naraApiKey,
      skipPexels, skipPixabay, skipInternetArchive, skipEuropeana,
      skipOpenverse, skipNasa, skipNara, skipLoc,
      maxPerSource, maxTotal,
    }).then(r => r.candidates),
  ]);

  const archiveSearchResult = archiveResult.status === "fulfilled"
    ? archiveResult.value
    : { candidates: [], beatDocument: primaryQuery };
  const externalCandidates = externalPool.status === "fulfilled"
    ? externalPool.value
    : [];

  // Cross-video variety: hold back archive assets used in recent same-topic videos so a
  // filled archive doesn't keep shipping identical footage. This is the funnel-path wiring
  // of the same applyCrossVideoVarietyDegrade the older archive scan already used — until now
  // the funnel searched the archive with empty exclude sets, so the variety machinery never
  // ran on the path production actually takes. Applied BEFORE coverage scoring so coverage
  // honestly reflects the FRESH archive material: when only recently-used assets match, the
  // coverage drops, the strategy shifts toward internet_dominant, and the pipeline actively
  // pulls new external footage instead of reusing. Degrades gracefully — never starves a beat.
  const scannedPicks = req.crossVideoExcludeIds && req.crossVideoExcludeIds.size > 0
    ? applyCrossVideoVarietyDegrade(archiveSearchResult.candidates, req.crossVideoExcludeIds)
    : archiveSearchResult.candidates;
  const beatDoc = archiveSearchResult.beatDocument;

  /**
   * RONDE 131 — what earlier videos already proved about this subject.
   *
   * Placed here, BEFORE coverage scoring, deliberately. Coverage decides how hard the funnel leans
   * on the internet, and a beat whose subject FastVid has good footage for should read as covered
   * — that is the whole saving. Placed after, the recall would arrive too late to spare anything.
   *
   * Excluded from recall: assets this render already used, and (via the query itself) any asset
   * deleted or deactivated since it was remembered.
   */
  const recall = req.memoryEntity
    ? await (req.recallProvenAssets ?? recallProvenAssetsForEntity)(req.memoryEntity, {
        excludeAssetIds: req.memoryExcludeAssetIds,
        varietySeed: req.memoryVarietySeed ?? 0,
        // RONDE 132 §2: a memory asset this video already used is a duplicate ATTEMPT, and it is
        // reported as one. Filtering it away silently would make a working exclude set look
        // exactly like an empty memory.
        onExcluded: req.onMemoryAssetExcluded,
      })
    : [];
  const { picks: archivePicks, added: recalledAdded } = mergeRecalledIntoArchivePicks(
    scannedPicks,
    recall
  );
  if (req.memoryRecalledInto) {
    const scanned = new Set(scannedPicks.map((p) => p.asset.id));
    // Only assets the recall ADDED. One the archive scan found anyway is not a memory hit; it is
    // a beat whose own keywords matched, and crediting the memory for it would inflate the metric.
    for (const r of recall) {
      if (!scanned.has(r.pick.asset.id)) req.memoryRecalledInto.add(r.pick.asset.id);
    }
  }
  if (req.memoryEntity) {
    const hit = recalledAdded > 0;
    if (req.memoryMetrics) {
      if (hit) {
        req.memoryMetrics.memoryHits++;
        req.memoryMetrics.assetsReused += recalledAdded;
        req.memoryMetrics.providerSearchesAvoided++;
      } else {
        req.memoryMetrics.memoryMisses++;
        req.memoryMetrics.newSearches++;
      }
    }
    console.log(
      formatSearchMemoryLine({
        query: primaryQuery,
        hit,
        provider: recall[0]?.memory.source,
        assets: recalledAdded,
        // A recalled asset is already in FastVid's archive: adopting it costs no provider search
        // and no download from anyone else.
        networkAvoided: hit,
      })
    );
  }

  // ── 2. Coverage scoring ────────────────────────────────────────────────────
  // Score top-5 archive candidates against the beat embedding to get coverage.
  // Also collect per-candidate embedding scores for final ranking.
  const topK = Math.min(5, archivePicks.length);
  const allEmbSims: (number | null)[] = new Array(archivePicks.length).fill(null);

  if (topK > 0) {
    const topSims = await Promise.allSettled(
      archivePicks.slice(0, topK).map(c =>
        scoreBeatAgainstStoredEmbedding(beatDoc, c.asset.id).catch(() => null)
      )
    );
    for (let i = 0; i < topK; i++) {
      const r = topSims[i];
      allEmbSims[i] = r.status === "fulfilled" ? r.value : null;
    }
  }

  const archiveCoverage = await computeArchiveCoverage(archivePicks, beatDoc, sceneIndex);
  const strategy = resolveStrategy(archiveCoverage);
  const { archive: archiveWeight, internet: internetWeight } = sourceWeights(strategy);

  console.log(
    `[Funnel] Scene ${sceneIndex}: coverage=${archiveCoverage.toFixed(3)} strategy=${strategy} ` +
    `archive=${archivePicks.length} external=${externalCandidates.length}`
  );

  // ── 3. Merge + dedup + rank ────────────────────────────────────────────────
  const merged = mergeCandidates(
    archivePicks, allEmbSims, externalCandidates,
    archiveWeight, internetWeight, maxTotal,
    req.movingShareDeficit ?? 0,
    // RONDE 54: built from what the pipeline already knows about this video.
    buildTopicMatcher(req.videoTitle, extractTopicAnchorTags(req.videoTitle, req.sceneText), req.sceneText),
    req.beatTemporalContext
  );

  const latencyMs = Date.now() - t0;

  return {
    sceneIndex,
    candidates: merged,
    archiveCoverage,
    strategy,
    metrics: {
      retrievalLatencyMs: latencyMs,
      archiveCoverage,
      strategy,
      archiveCandidateCount: archivePicks.length,
      externalCandidateCount: externalCandidates.length,
      mergedCount: archivePicks.length + externalCandidates.length,
      finalCount: merged.length,
      embeddingScoredCount: allEmbSims.filter(s => s !== null).length,
    },
  };
}

// ─── FASE 1: score-all-then-pick-best candidate selection ──────────────────────

/** Minimal shape of a vision-gate verdict this module needs — matches
 *  `VisionGateResult` from visualQualityGate.ts without importing it, so this
 *  module stays free of a videoPipeline-adjacent dependency chain. */
export type FunnelCandidateVisionResult = {
  pass: boolean;
  worstScore10: number | null;
};

export type ScoredFunnelCandidate = {
  candidate: FunnelCandidate;
  clipPath: string;
  visionResult: FunnelCandidateVisionResult;
};

/**
 * FASE 1 — Visual Discovery Engine: Pexels/Pixabay must not win a marginal
 * CLIP-score edge over a demonstrably comparable non-stock candidate (own
 * archive, Wikimedia, or any future non-stock source). A stock candidate only
 * wins the comparison when its score clears the best non-stock passer's score
 * by at least STOCK_TIER_WIN_MARGIN points on the existing 0-10 VisionGate
 * scale — this does not touch VisionGate's own pass/fail threshold
 * (minClipQualityScore), it only governs which PASSING candidate is picked
 * when more than one is available.
 *
 * Examples (from the FASE 1 spec, used verbatim as test cases):
 *   Archive=7.2, Wikimedia=8.8, InternetArchive=9.1, Pexels=6.9 → best non-stock (9.1) wins.
 *   Archive=8.9, Wikimedia=8.7, Pexels=9.0 → best non-stock (8.9) wins; Pexels' +0.1 edge
 *     is not "demonstrably better," so it does not win despite the higher raw score.
 */
export const STOCK_TIER_WIN_MARGIN = 1.0;

const STOCK_SOURCES = new Set<FunnelCandidateSource>(["pexels", "pixabay"]);

/** FASE 4 — Candidate Expansion + Global Best-of-N: how many candidates are actually
 *  downloaded and VisionGate-scored per beat. Was a flat top-3 slice (FASE 1); raised to 6
 *  now that buildDownloadShortlist() below applies source diversity instead of just taking
 *  the top N by rank — a modest, bounded increase, not "download everything". */
export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;

/** FASE 4: how many metadata-only candidates survive from the merged funnel pool into
 *  shortlist selection for a beat (before any download happens). This was hard-capped at 3-4
 *  in FASE 1-3 — low enough that a genuinely better candidate ranked 5th or lower could never
 *  even be considered for download, regardless of buildDownloadShortlist()'s diversity logic.
 *  Raised to 15: purely a metadata-visibility limit (candidates here are already fetched —
 *  discovery already ran for the whole pool — so widening this costs zero extra network/API
 *  calls), independent of and upstream from MAX_FUNNEL_CANDIDATES_TO_SCORE, which remains the
 *  actual download/VisionGate budget. */
export const FUNNEL_CANDIDATE_POOL_LIMIT = 15;

/** Per-source caps used by buildDownloadShortlist(). Non-stock (historical/open) sources may
 *  contribute up to 2 candidates each to the download shortlist; stock (Pexels/Pixabay) is
 *  capped at 1 each, so a single source — especially stock — can never monopolize the
 *  shortlist. These are diversity caps on WHICH CANDIDATES GET DOWNLOADED, not a ranking
 *  change: relevance (rankingScore) still decides who fills the available slots, and the
 *  final winner is still decided purely by VisionGate scores via pickBestFunnelCandidate(). */
const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;
const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;

/**
 * RONDE 163 — the curated archive is not one source among interchangeable peers.
 *
 * The diversity cap above is right for what it was written against: several stock libraries that
 * answer the same query with much the same footage, where letting one fill the shortlist crowds
 * out a better result from another. It treats `archive` as one of those, and the archive is the
 * catalogue this pipeline is built on.
 *
 * What that costs, from render 553's own log:
 *
 *     [ArchiveRetrieval] s1b6 query="See how internal conflicts further destabilized the Nazi reg"
 *                        candidates=25 bestScore=0.444 knownSuccessful=11
 *     [VisualCoverageFinal] scene=1 beat=6 offered=3 visionJudged=0 eligible=0 adopted=0
 *
 * Twenty-five archive candidates were found and scored for that beat. Every one of them carries
 * source `archive`, so the cap allowed TWO of the twenty-five to be downloaded and judged. The
 * same shape on s1b5: 25 candidates, offered=2. Two chances out of twenty-five is why beats with
 * plenty of matching material still end as placeholders.
 *
 * 3 rather than 2, against a download budget of MAX_FUNNEL_CANDIDATES_TO_SCORE = 6. Half the
 * shortlist is the ceiling, and it is deliberate: 4 was tried first and broke the guard that
 * matters here — with five archive candidates outranking three other sources, a cap of 4 left one
 * slot and a source that had a candidate got none. Three keeps every other source reachable while
 * giving the primary catalogue 50% more chances per beat than it had.
 *
 * This is a bounded step, not the whole answer. Two of twenty-five becomes three of twenty-five.
 * The larger lever is the download budget itself, and that trades directly against download and
 * VisionGate cost per beat — a trade that needs a production measurement before it is made.
 *
 * Nothing else moves. Relevance (rankingScore) still decides who fills the slots, the download
 * budget still bounds how many are fetched, and VisionGate still decides the winner — this only
 * changes how many archive candidates are allowed to be considered.
 */
const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;

/**
 * FASE 4 — Candidate Expansion: replaces the old flat "take the top N by rank" download
 * selection with a source-diversity-aware shortlist, so a strong candidate from a
 * less-dominant source (e.g. ranked 4th overall but the best NARA result) still gets a
 * chance to be downloaded and scored instead of being crowded out by several candidates
 * from one source landing in positions 1-3.
 *
 * Walks `candidates` re-sorted by rankingScore descending (relevance first, per the FASE 4
 * spec) and fills the shortlist up to `budget`, skipping a candidate once its source has
 * already contributed its cap (2 for historical/open sources, 1 for stock — Pexels/Pixabay
 * each capped separately). The cap is never relaxed: `budget` is a ceiling on how many
 * candidates get downloaded+VisionGate-scored, not a fill target — if the diverse, capped
 * pool has fewer eligible candidates than `budget` (e.g. a beat where only Pexels returned
 * results), the shortlist is simply smaller than `budget`. This is deliberate: forcing extra
 * near-duplicate downloads from one already-represented source just to hit a target count
 * would contradict both "one source may never monopolize the shortlist" (STAP 3) and "no
 * unnecessary downloads" (STAP 16) at once. A pool with truly nothing usable still falls
 * through to the existing, untouched guaranteed-fill/rescue ladder (STAP 17) — this function
 * has no fallback logic of its own.
 *
 * Does not touch ranking (rankingScore, EXTERNAL_SOURCE_TIER_BONUS) or the final winner
 * decision (pickBestFunnelCandidate) — this only decides which candidates are worth the
 * download+VisionGate cost.
 */
/**
 * RONDE 176 — the beat's own sentence decides its order, not the scene's.
 *
 * ── The asymmetry this removes ───────────────────────────────────────────────────────────────
 *
 * The funnel searches once per SCENE and the shortlist is drawn once per BEAT. Between them,
 * nothing re-read the beat. `buildDownloadShortlist` takes the scene-level ranking and removes
 * what earlier beats already used (FIX 2), so a beat's order was: the scene's ordering, minus the
 * pictures its neighbours took first.
 *
 * That gives the last beat of a scene systematically worse options than the first — not because
 * its sentence is harder, but because it is later in the loop. And the scene-level ranking cannot
 * know that beat 4 is the one about Munich in 1926 while beat 0 was about the Luftwaffe.
 *
 * ── Why here and not by running the funnel per beat ──────────────────────────────────────────
 *
 * Running retrieval per beat would multiply provider searches and archive scans roughly fourfold,
 * on a render (555) whose retrieval was already 13m28s over a 1m36s budget. This costs nothing:
 * the pool is already in memory, the beat's text is already in scope, and the matcher is the one
 * RONDE 175 §2 already built. Same candidates, ordered for the sentence they are about to sit
 * under.
 *
 * ── Still a nudge ────────────────────────────────────────────────────────────────────────────
 *
 * It reorders; it never drops. Every candidate the scene found is still a candidate, and absence
 * of period information is still neutral — a catalogue-numbered archive title keeps its place.
 */
export function reorderShortlistForBeat(
  candidates: FunnelCandidate[],
  beatContext: BeatTemporalContext | undefined
): FunnelCandidate[] {
  if (!beatContext || candidates.length < 2) return candidates;
  const hasSignal =
    (beatContext.years?.length ?? 0) > 0 ||
    (beatContext.places?.length ?? 0) > 0 ||
    (beatContext.subjects?.length ?? 0) > 0;
  if (!hasSignal) return candidates;

  // Scored once, then sorted — `matchCandidateToBeat` is pure and this keeps it O(n log n) rather
  // than re-running the matcher inside every comparison.
  const scored = candidates.map((c, i) => ({
    c,
    i,
    bonus: matchCandidateToBeat(candidateTextOf(c), beatContext).bonus,
  }));
  scored.sort(
    (a, b) =>
      // The beat's own agreement first, then the scene ranking that got them here, then the
      // original position — so the order is fully determined and two runs cannot differ.
      b.bonus - a.bonus || b.c.rankingScore - a.c.rankingScore || a.i - b.i
  );
  return scored.map((x) => x.c);
}

/** Everything a candidate says about itself, whichever kind it is. */
function candidateTextOf(c: FunnelCandidate): string {
  const archive = c.archivePick;
  if (archive) {
    return [
      archive.asset.title,
      (archive.asset as { description?: string }).description,
      archive.archiveName,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return `${c.title ?? ""} ${c.poolCandidate?.assetId ?? ""}`;
}

export function buildDownloadShortlist(
  candidates: FunnelCandidate[],
  budget: number,
  usedCandidateIds?: ReadonlySet<string>,
  /** RONDE 164: filled in with this stage's counts when the caller is tracking a beat. */
  audit?: ArchiveSourcingAudit
): FunnelCandidate[] {
  if (budget <= 0 || candidates.length === 0) return [];
  // FIX 2 — per-beat shortlist exclusion. The funnel result is built once per SCENE but
  // consumed once per BEAT, and everything below is deterministic on rankingScore, so every
  // beat of a scene used to receive the identical shortlist and download the identical
  // assets. Render 515: 47-49 candidates per scene collapsed to 3 unique assets across 13
  // beats. Dropping candidates an earlier beat already selected lets the same ranking reach
  // further down the list on the next beat.
  //
  // This is not a ranking change: no score is altered, no penalty is applied, no shuffling
  // happens. The identical sort and the identical per-source caps run afterwards — only the
  // input set is smaller. When every candidate has already been used the full list comes
  // back, so reuse stays possible and a beat is never starved into fallback.
  const unused = usedCandidateIds?.size
    ? candidates.filter((c) => !usedCandidateIds.has(c.id))
    : candidates;
  const pool = unused.length > 0 ? unused : candidates;
  const sorted = [...pool].sort((a, b) => b.rankingScore - a.rankingScore);

  const capFor = (source: FunnelCandidateSource): number => {
    if (source === "archive") return MAX_SHORTLIST_PER_ARCHIVE_SOURCE;
    return STOCK_SOURCES.has(source) ? MAX_SHORTLIST_PER_STOCK_SOURCE : MAX_SHORTLIST_PER_NON_STOCK_SOURCE;
  };

  /**
   * RONDE 170 — the caps decide who goes FIRST, not how many slots are left empty.
   *
   * ── What render 555 measured ───────────────────────────────────────────────────────────────
   *
   *     beat=s2b0 afterMetadata=15 afterSourceCap=3 downloadBudget=6 downloaded=0
   *               cutBySourceCap=8 cutByBudget=0   verdict=LOST_BEFORE_VISION
   *     beat=s2b1 afterSourceCap=3 downloadBudget=6 cutBySourceCap=5 cutByBudget=0
   *     beat=s2b3 afterSourceCap=5 downloadBudget=6 cutBySourceCap=7 cutByBudget=0
   *     TOTAL     cutBySourceCap=106 cutByBudget=6
   *               beatsWithCapBinding=13 medianCapGap=0.00 capGapMax=0.01
   *
   * On three of the four beats the render printed in full, the shortlist came out SMALLER than the
   * download budget while the per-source cap was turning candidates away. s2b0 is the clearest:
   * ninety-three candidates found, fifteen visible, three shortlisted, eight refused by the cap —
   * and three of the six paid-for download slots left empty. The beat then downloaded nothing at
   * all and was scored LOST_BEFORE_VISION.
   *
   * Across the render the cap cut 106 candidates while the budget cut 6, and the thirteen beats
   * where the cap actually bound show a median score gap of 0.00 between what it kept and what it
   * refused. RONDE 164 and 165 both declined to act on one beat with a gap of 0.00; thirteen is
   * the evidence they were waiting for.
   *
   * ── Why this is not a cap raise ────────────────────────────────────────────────────────────
   *
   * RONDE 157 raised MAX_SHORTLIST_PER_ARCHIVE_SOURCE to 4 and measured the cost: the archive ate
   * slots the other providers needed, and the guard failed. Raising it again would repeat that.
   *
   * The caps are a DIVERSITY rule and they still decide the whole shortlist whenever there are
   * enough candidates to fill the budget — every source gets its share before anyone gets a
   * second. What they were also doing, silently, was shrinking the shortlist below the budget when
   * no other source had anything to put in those slots. An empty slot serves no diversity: nothing
   * is being kept out of it, it is simply unused.
   *
   * So the caps run first and unchanged, and only the slack they leave behind is filled, from the
   * candidates they refused, in ranking order. The budget stays 6 and the caps stay 3/2/1.
   */
  const capped: FunnelCandidate[] = [];
  const capOverflow: FunnelCandidate[] = [];
  const perSourceCount = new Map<FunnelCandidateSource, number>();
  for (const c of sorted) {
    const used = perSourceCount.get(c.source) ?? 0;
    if (used >= capFor(c.source)) {
      capOverflow.push(c);
      continue;
    }
    capped.push(c);
    perSourceCount.set(c.source, used + 1);
  }

  const shortlist = capped.slice(0, budget);
  /**
   * Candidates the caps refused that are taking a slot nobody else wanted.
   *
   * STOCK IS EXCLUDED, and that exclusion is the whole reason this is a backfill and not a raised
   * cap. An earlier round settled it — "niet te veel downloaden" — with a homogeneous Pexels pool:
   * six generic stock clips of the same query are interchangeable, so fetching six to fill a
   * six-slot budget buys nothing but wall time. That argument is about STOCK, whose catalogue is
   * commissioned and repetitive by construction, and it stays honoured exactly as written.
   *
   * It is not an argument about the archive. Render 555's s2b0 found ninety-three distinct archive
   * candidates, shortlisted three, downloaded none and scored LOST_BEFORE_VISION with three of six
   * paid-for slots unused. Those are different holdings of different material, not six versions of
   * one clip, and leaving the slots empty cost the beat its picture.
   */
  let backfilledFromCap = 0;
  for (const c of capOverflow) {
    if (shortlist.length >= budget) break;
    if (STOCK_SOURCES.has(c.source)) continue;
    shortlist.push(c);
    backfilledFromCap++;
  }

  /**
   * RONDE 163/164 — where candidates were lost, counted after the fact rather than during it.
   *
   * `cutBySourceCap` is what the caps refused AND the backfill did not reclaim, so it keeps
   * meaning "lost to the diversity rule". `cutByBudget` is what a full shortlist had no room for.
   * Both still add up to what did not make it, and `backfilledFromCap` says how much of the cap's
   * refusal the budget's slack bought back.
   */
  const cutByCap = capOverflow.length - backfilledFromCap;
  const cutByBudget = Math.max(0, capped.length - shortlist.length);
  const inShortlist = new Set(shortlist);
  const archiveTaken = shortlist.filter((c) => c.source === "archive").map((c) => c.rankingScore);
  const archiveCut = sorted
    .filter((c) => c.source === "archive" && !inShortlist.has(c))
    .map((c) => c.rankingScore);
  recordShortlistStage(audit, {
    afterMetadata: candidates.length,
    afterBeatDedup: pool.length,
    afterSourceCap: shortlist.length,
    downloadBudget: budget,
    cutBySourceCap: cutByCap,
    cutByBudget,
    backfilledFromCap,
    archive: { taken: archiveTaken, cut: archiveCut },
  });

  return shortlist;
}

/**
 * THE MOST EXPENSIVE DOWNLOAD GOES FIRST, OR IT NEVER GOES AT ALL.
 *
 * ── What the production render measured ─────────────────────────────────────────────────────
 *
 * Seventeen YouTube videos were FOUND and seventeen downloads were refused. Every refusal read
 * the same, and it is the `0s` that matters:
 *
 *     [Pipeline] Scene 1: skipping YouTube download of 9V7Zgx4rDDA
 *                — 0s left in the scene budget, not enough to finish
 *     [YouTubeDownload] ... status=DOWNLOAD_TIMEOUT reason=scene_budget_too_short_to_start
 *
 * Seventeen out of seventeen at zero. Not "too little" — nothing at all. So no picture editor
 * ever judged a YouTube clip on its merits, and not one byte was ever fetched, which rules out
 * both explanations `20 downloaded / 0 adopted` used to carry. It was neither relevance nor a
 * broken provider. The source was asked at a moment when the answer could not physically arrive.
 *
 * ── Why a bigger budget cannot fix it ───────────────────────────────────────────────────────
 *
 * `withSceneFetchTimeout` sets `deadlineAtMs: Math.min(Date.now() + delayMs, parentDeadline)` —
 * a nested scope can never outlive its parent, by design. So handing YouTube its own generous
 * slice buys nothing once the beat's own scope is spent: the slice is clamped to what is left,
 * which is zero. The only thing that moves is WHEN it is asked.
 *
 * ── Why one candidate, and why not a re-ranking ─────────────────────────────────────────────
 *
 * The shortlist is ordered by `rankingScore` and the downloads run in batches of three, so a
 * YouTube candidate in the second batch is attempted after the first batch's transfers and vision
 * work have already drained a 12-20s beat. Hoisting the single highest-ranked one into the first
 * batch is enough to give it a real window.
 *
 * It is deliberately ONE. Membership is not touched — `buildDownloadShortlist` still decides who
 * is in, with its caps and its budget unchanged — and every other candidate keeps its exact
 * relative order. No score is altered and nothing is dropped, so a hoisted candidate that fails
 * costs the beat one download slot's worth of time and the rest of the shortlist follows as it
 * always did. Hoisting the whole source would invert the ranking and let the slowest provider in
 * the cascade take the beat, which is the defect on the other side of this one.
 */
export function hoistBudgetSensitiveDownload(
  shortlist: readonly FunnelCandidate[]
): FunnelCandidate[] {
  const first = shortlist.findIndex((c) => c.source === "youtube_cc");
  // Already first, or not present: the order is already the one we want.
  if (first <= 0) return [...shortlist];
  const hoisted = shortlist[first];
  return [hoisted, ...shortlist.filter((_, i) => i !== first)];
}

/**
 * RONDE 65: score spread below which the CLIP ranking is treated as noise.
 *
 * One point on a 0-10 integer scale is 0.025 of cosine similarity — smaller than the gap render
 * 531 measured between a modern political sticker and a photograph of the subject himself.
 */
function scoreSpreadEnv(fallback: number): number {
  // Deliberately NOT envThreshold: that clamps to 0..1, which is right for a similarity and
  // wrong for a gap on a 0-10 point scale.
  const raw = process.env.NON_DISCRIMINATING_SCORE_SPREAD?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : fallback;
}
const NON_DISCRIMINATING_SCORE_SPREAD = scoreSpreadEnv(1);

/**
 * RONDE 168 — the beat may not end on a candidate nobody judged.
 *
 * ── The bug this exists to make impossible ───────────────────────────────────────────────────
 *
 * videoPipeline's judging loop runs `look < MAX_JUDGEMENTS_PER_BEAT` and, on each refusal, picks
 * the next-best candidate. It breaks the moment one passes, so a winner produced by a break has
 * been judged. When the CEILING ends the loop instead, the winner left in hand is whatever the
 * last refusal picked and nothing has ever looked at it — and it is not in the refused set either,
 * so the reprieve check does not fire and no severity is consulted. Video 555 shipped a NASA clip
 * about equality under narration on the Tehran Conference exactly this way.
 *
 * ── Why it lives here and not inline ─────────────────────────────────────────────────────────
 *
 * Written inline, the only thing a test could check was that the source text was present — and a
 * source-text assertion cannot tell whether the winner it ends on was judged, which is the entire
 * question. As a function the real rule is the thing under test, and a mutation to it fails.
 *
 * The look budget is spent on judging, not on shopping: with two looks a beat may try two
 * candidates properly, not two and then a third on trust. No gate call is added and no ceiling is
 * raised — what changes is which candidate the beat ends on when the ceiling binds.
 */
export type JudgedWinnerDecision<T> = {
  /** The candidate the beat may keep: judged, or none. */
  winner: T | null;
  /** The unjudged candidate that was put back, so the caller can log and account for it. */
  putBack: T | null;
  /** The outcome reason for `putBack`. Kept with the rule so the two cannot drift. */
  reason: "never_judged";
};

export function keepOnlyJudgedWinner<T extends { candidate: { id: string } }>(
  winner: T | null,
  judgedCandidateIds: ReadonlySet<string>,
  scored: readonly T[],
  /** RONDE 61's hard exclusion set: the candidates a judge looked at and refused. */
  refusedCandidateIds: ReadonlySet<string>
): JudgedWinnerDecision<T> {
  if (!winner || judgedCandidateIds.has(winner.candidate.id)) {
    return { winner, putBack: null, reason: "never_judged" };
  }
  // Back to the best candidate this beat actually looked at. Refused, so RONDE 67's reprieve and
  // RONDE 166's severity rules decide whether it may be used — which is the point: a known fault
  // judged on its merits beats an unknown one adopted on trust.
  const judged = scored.find((c) => refusedCandidateIds.has(c.candidate.id)) ?? null;
  return { winner: judged, putBack: winner, reason: "never_judged" };
}

export function pickBestFunnelCandidate(
  scored: ScoredFunnelCandidate[],
  usedCandidateIds?: ReadonlySet<string>,
  /**
   * RONDE 61: candidates a judge has looked at and REFUSED. Unlike usedCandidateIds — a soft
   * preference for variety, restored below when everything has been used — this is a hard
   * exclusion that is never restored. Returning null is the correct answer here: the beat falls
   * through to the next source, which is strictly better than showing a picture the pipeline has
   * already established does not belong.
   */
  rejectedCandidateIds?: ReadonlySet<string>
): ScoredFunnelCandidate | null {
  const allPassers = scored
    .filter(s => s.visionResult.pass)
    .filter(s => !rejectedCandidateIds?.has(s.candidate.id));
  if (allPassers.length === 0) return null;

  // FIX 1 — cross-beat asset memory. The funnel path never consulted any used-asset
  // registry, so the highest-scoring candidate won every beat of a scene: render 515 picked
  // the same asset for 11 of 13 beats while a runner-up was available on every one of them.
  //
  // Preferring the passers that have not been used yet, and running the UNCHANGED
  // stock/non-stock selection below on exactly that subset, keeps the ranking intact — the
  // best remaining candidate still wins, on its own VisionGate score, with the same
  // STOCK_TIER_WIN_MARGIN applied. Nothing is scored down and nothing is skipped at random.
  //
  // Exhaustion rule: when every passer has already been used, the full passer set is
  // restored and the winner is picked from it as before. Reuse is the last resort, never the
  // default, and a beat is never lost to null because of this.
  const unusedPassers = usedCandidateIds?.size
    ? allPassers.filter(s => !usedCandidateIds.has(s.candidate.id))
    : allPassers;
  const passers = unusedPassers.length > 0 ? unusedPassers : allPassers;

  const scoreOf = (s: ScoredFunnelCandidate): number => s.visionResult.worstScore10 ?? 0;

  // RONDE 65: refuse to rank on a spread that carries no information.
  //
  // worstScore10 is Math.round(similarity * 40) — an INTEGER 0-10. Render 531 measured, on one
  // beat:
  //
  //     white-lives-matter-montana-sticker   0.2226  ->  9
  //     faces-of-ancient-europe-1-500-a.d    0.2225  ->  9
  //     Signed Photograph of Adolf Hitler    0.2116  ->  8
  //     Bundesarchiv Bild 183-1989-0322      0.2077  ->  8
  //
  // Obviously-right and obviously-wrong material sat 0.0149 apart, and rounding turned that into
  // a one-point gap that decided the beat. The sticker did not beat the Hitler photograph
  // because CLIP preferred it; it beat it because 8.90 rounds up and 8.46 rounds down.
  //
  // So when the whole field is within a point of itself, the score is not a ranking and is not
  // used as one. The tier preference below still applies — provenance is a real signal — and
  // within a tier the candidates keep the order the funnel ranked them in, which is built from
  // topicality and source authority rather than image-text noise.
  const scores = allPassers.map(scoreOf);
  const discriminating =
    scores.length < 2 || Math.max(...scores) - Math.min(...scores) > NON_DISCRIMINATING_SCORE_SPREAD;
  const best = (list: ScoredFunnelCandidate[]): ScoredFunnelCandidate =>
    discriminating ? list.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a)) : list[0]!;

  const nonStock = passers.filter(s => !STOCK_SOURCES.has(s.candidate.source));
  const stock = passers.filter(s => STOCK_SOURCES.has(s.candidate.source));

  if (nonStock.length === 0) return best(stock);

  const bestNonStock = best(nonStock);
  if (stock.length === 0) return bestNonStock;

  const bestStock = best(stock);
  // A margin measured in the same noisy points cannot decide anything either: when the field is
  // flat, the non-stock tier simply wins, which is the preference this margin exists to bend.
  if (discriminating && scoreOf(bestStock) >= scoreOf(bestNonStock) + STOCK_TIER_WIN_MARGIN) {
    return bestStock;
  }
  return bestNonStock;
}
