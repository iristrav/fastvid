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
  listCuratedArchiveCandidates,
  buildBeatMatchTags,
  applyCrossVideoVarietyDegrade,
  stubPowerWordFromSceneText,
  type CuratedCandidatePick,
} from "./curatedMediaSourcing";
import {
  scoreBeatAgainstStoredEmbedding,
  loadStoredAssetEmbedding,
} from "./archiveEmbeddingIndex";
import { cosineSimilarityVectors } from "./semanticVisualMatching";
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
  | "loc";

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
  movingDeficit = 0
): FunnelCandidate[] {
  const seen = new Set<string>();
  const merged: FunnelCandidate[] = [];

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
    const rankingScore =
      (kwBase + embBoost + movingFootageBonus(archiveMediaType, movingDeficit)) * archiveWeight;

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
    const rankingScore =
      internetWeight *
      (0.7 + (EXTERNAL_SOURCE_TIER_BONUS[c.source] ?? 0) + movingFootageBonus(c.mediaType, movingDeficit));
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
  const archivePicks = req.crossVideoExcludeIds && req.crossVideoExcludeIds.size > 0
    ? applyCrossVideoVarietyDegrade(archiveSearchResult.candidates, req.crossVideoExcludeIds)
    : archiveSearchResult.candidates;
  const beatDoc = archiveSearchResult.beatDocument;

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
    req.movingShareDeficit ?? 0
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
export function buildDownloadShortlist(
  candidates: FunnelCandidate[],
  budget: number,
  usedCandidateIds?: ReadonlySet<string>
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

  const capFor = (source: FunnelCandidateSource): number =>
    STOCK_SOURCES.has(source) ? MAX_SHORTLIST_PER_STOCK_SOURCE : MAX_SHORTLIST_PER_NON_STOCK_SOURCE;

  const shortlist: FunnelCandidate[] = [];
  const perSourceCount = new Map<FunnelCandidateSource, number>();
  for (const c of sorted) {
    if (shortlist.length >= budget) break;
    const used = perSourceCount.get(c.source) ?? 0;
    if (used >= capFor(c.source)) continue;
    shortlist.push(c);
    perSourceCount.set(c.source, used + 1);
  }

  return shortlist;
}

export function pickBestFunnelCandidate(
  scored: ScoredFunnelCandidate[],
  usedCandidateIds?: ReadonlySet<string>
): ScoredFunnelCandidate | null {
  const allPassers = scored.filter(s => s.visionResult.pass);
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
  const best = (list: ScoredFunnelCandidate[]): ScoredFunnelCandidate =>
    list.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));

  const nonStock = passers.filter(s => !STOCK_SOURCES.has(s.candidate.source));
  const stock = passers.filter(s => STOCK_SOURCES.has(s.candidate.source));

  if (nonStock.length === 0) return best(stock);

  const bestNonStock = best(nonStock);
  if (stock.length === 0) return bestNonStock;

  const bestStock = best(stock);
  if (scoreOf(bestStock) >= scoreOf(bestNonStock) + STOCK_TIER_WIN_MARGIN) {
    return bestStock;
  }
  return bestNonStock;
}
