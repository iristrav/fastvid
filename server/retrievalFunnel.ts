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
  | "internet_archive";

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

const ARCHIVE_DOMINANT_THRESHOLD = 0.88;
const INTERNET_DOMINANT_THRESHOLD = 0.45;

/** When the archive has NO embedding index at all, fall back to normalised keyword
 *  score.  The keyword scorer returns raw integer points — 100 pts ~ good match. */
const KEYWORD_SCORE_MAX = 100;

// ─── Per-beat gap strategy (self-learning retrieval) ─────────────────────────

/**
 * Tiered confidence thresholds for per-beat archive gap detection.
 * When an archive candidate's per-beat embedding similarity meets one of these
 * thresholds, only the specified number of external sources are queried.
 */
export const BEAT_ARCHIVE_STOP_THRESHOLD = 0.90;       // archive wins — skip internet entirely
export const BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD = 0.75; // good match — hedge with one external
export const BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD = 0.50; // weak match — try all externals

export type BeatGapStrategy =
  | "archive_only"    // score > 0.90 — use archive, no internet call
  | "one_external"    // score 0.75–0.90 — archive + one external source as hedge
  | "all_external"    // score 0.50–0.75 — archive + all external sources
  | "aggressive";     // score < 0.50 — archive deprioritised, all external, more results

/** Determines how many external sources to query based on the best archive score for a beat. */
export function resolvePerBeatGapStrategy(bestArchiveScore: number | null): BeatGapStrategy {
  if (bestArchiveScore === null || bestArchiveScore < BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD) {
    return "aggressive";
  }
  if (bestArchiveScore >= BEAT_ARCHIVE_STOP_THRESHOLD) return "archive_only";
  if (bestArchiveScore >= BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD) return "one_external";
  return "all_external";
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
  beatEmbedding: number[]
): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (c.source !== "archive") continue;
    const score = scoreFunnelCandidateForBeat(c, beatEmbedding);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }
  return best;
}

/**
 * Orders funnel candidates for archive-first per-beat retrieval.
 * Archive candidates always come first; external candidates are appended
 * according to the gap strategy:
 *   archive_only  → external candidates removed
 *   one_external  → only the top-ranked external candidate kept
 *   all_external  → all external candidates kept (ranked by rankingScore)
 *   aggressive    → same as all_external but archive candidates are moved last
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
      return archiveCands;
    case "one_external":
      return [...archiveCands, ...externalCands.slice(0, 1)];
    case "all_external":
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
  topK = 5
): Promise<number> {
  if (candidates.length === 0) return 0;

  const top = candidates.slice(0, topK);

  // Try embedding similarity on top-K
  const embSims = await Promise.all(
    top.map(c => scoreBeatAgainstStoredEmbedding(beatDocument, c.asset.id).catch(() => null))
  );
  const maxEmb = Math.max(...embSims.filter((s): s is number => s !== null));
  if (isFinite(maxEmb) && maxEmb > 0) {
    return Math.min(1, maxEmb);
  }

  // Fallback: normalise keyword score (raw points → 0–1)
  const topScore = candidates[0].score;
  if (!topScore || topScore <= 0) return 0;
  return Math.min(1, topScore / KEYWORD_SCORE_MAX);
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
    powerWord: words.find(w => w.length > 4) ?? words[0] ?? "documentary",
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

function mergeCandidates(
  archivePicks: CuratedCandidatePick[],
  archiveEmbSims: (number | null)[],
  externalPool: PoolCandidate[],
  archiveWeight: number,
  internetWeight: number,
  max: number
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
    const rankingScore = (kwBase + embBoost) * archiveWeight;

    // Load stored embedding for fast per-beat cosine scoring (no extra API call)
    const storedEmb = loadStoredAssetEmbedding(pick.asset.id);

    merged.push({
      id,
      source: "archive",
      title: pick.asset.title ?? "archive clip",
      thumbnailUrl: null, // archive assets don't expose thumbnail URLs
      mediaType: (pick.asset.mediaType === "video" ? "video" : "image") as "video" | "image",
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

    const rankingScore = internetWeight * 0.7; // base internet weight (no embedding yet)
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
    skipPexels,
    skipPixabay,
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
      pexelsApiKey, pixabayApiKey, skipPexels, skipPixabay,
      maxPerSource, maxTotal,
    }).then(r => r.candidates),
  ]);

  const archiveSearchResult = archiveResult.status === "fulfilled"
    ? archiveResult.value
    : { candidates: [], beatDocument: primaryQuery };
  const externalCandidates = externalPool.status === "fulfilled"
    ? externalPool.value
    : [];

  const archivePicks = archiveSearchResult.candidates;
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

  const archiveCoverage = await computeArchiveCoverage(archivePicks, beatDoc);
  const strategy = resolveStrategy(archiveCoverage);
  const { archive: archiveWeight, internet: internetWeight } = sourceWeights(strategy);

  console.log(
    `[Funnel] Scene ${sceneIndex}: coverage=${archiveCoverage.toFixed(3)} strategy=${strategy} ` +
    `archive=${archivePicks.length} external=${externalCandidates.length}`
  );

  // ── 3. Merge + dedup + rank ────────────────────────────────────────────────
  const merged = mergeCandidates(
    archivePicks, allEmbSims, externalCandidates,
    archiveWeight, internetWeight, maxTotal
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
