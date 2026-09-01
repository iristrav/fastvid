/**
 * RONDE 160 (FASE 7/10/11) — the live candidate pool, ranked by the ranking engine that already
 * exists, instead of by a keyword counter.
 *
 * ── What the audit found ─────────────────────────────────────────────────────────────────────
 *
 * FASE 7 asks for QUALITY > SOURCE: a perfect archive asset should beat a poor YouTube one, and an
 * excellent YouTube asset should be able to win. Two separate things turned out to be true, and
 * only one of them was the problem anybody expected.
 *
 *   1. The retrieval order in `HISTORICAL_SOURCE_TIER_ORDER` is a first-match-wins CASCADE:
 *      internet_archive, then youtube_cc, then wikimedia, then NARA… If a tier returns anything
 *      usable, the tiers below it are never asked. Under a cascade, source position IS the
 *      ranking, and quality cannot outrank it.
 *
 *   2. But a multi-source POOL also exists, it is ON by default
 *      (`ENABLE_SCENE_CANDIDATE_POOL !== "false"`), and it gathers candidates from ten providers
 *      before choosing. So a place where quality genuinely can outrank source is already running
 *      in production — and `selectCandidatesFromPool` scored it by counting shared word-stems:
 *      +1 per token the title/tags/description share with the beat, +3 if the power word is in the
 *      title, +2 if it is in the tags. No source priority, no diversity, no duplicate penalty, no
 *      motion, aspect, duration or freshness, and no idea what shot the Director asked for.
 *
 * Meanwhile `visualMatchingV2/candidateRanking.ts` implements all thirteen of those signals,
 * including `sourcePriority` (deliberately weighted at only 0.07, which is exactly what makes
 * "quality beats source" true rather than aspirational) and `diversity`. It was feature-flagged off
 * and imported by nothing in the live pipeline.
 *
 * ── Why this file is an adapter and not a ranker ─────────────────────────────────────────────
 *
 * FASE 17: no second search engine, no second ranking engine. So nothing here scores anything. It
 * translates one vocabulary into another and calls `rankCandidates` — the same function, the same
 * weights, the same tested behaviour. If a signal is wrong, it is wrong in one place.
 *
 * The source-token mapping is `engineSourceFor`, which `cinematicPipelineInputs` already uses for
 * exactly this translation. A second copy of that mapping would be a second opinion about what
 * "archival" means.
 */
import { rankCandidates, DEFAULT_RANKING_CONFIG } from "./visualMatchingV2/candidateRanking";
import type { CandidateAsset, RankedCandidate, VisualIntent } from "./visualMatchingV2/types";
import { engineSourceFor } from "./cinematicPipelineInputs";

/**
 * The subset of `PoolCandidate` this adapter reads.
 *
 * Declared structurally rather than imported so that `scenePool.ts` and this module do not become
 * mutually dependent, and so a caller holding a candidate from anywhere — including a source that
 * is not yet a `PoolCandidateSource` — can be ranked without widening a union first. A test
 * asserts the two shapes stay compatible.
 */
export type RankablePoolCandidate = {
  id: string;
  assetId: string;
  source: string;
  remoteUrl: string;
  thumbnailUrl: string | null;
  title: string;
  description: string | null;
  tags: string[];
  mediaType: "video" | "image";
  durationSec: number | null;
  license: string | null;
  width: number | null;
  height: number | null;
  clipSimilarity: number | null;
  embeddingSimilarity: number | null;
  rankingScore: number | null;
};

/**
 * A pool candidate in the ranking engine's vocabulary.
 *
 * Every field is copied from something the provider actually returned, or left null. §7's rule:
 * an unknown value is absent, never zero — `rankCandidates` redistributes the weight of a signal a
 * candidate carries no data for, so a null costs nothing while a fabricated 0 would score as
 * "measured, and bad".
 */
export function poolCandidateToAsset(c: RankablePoolCandidate): CandidateAsset {
  return {
    candidateId: c.id,
    source: engineSourceFor(c.source),
    assetType: c.mediaType,
    title: c.title || null,
    description: c.description,
    tags: c.tags,
    thumbnail: c.thumbnailUrl,
    localPath: null,
    remoteUrl: c.remoteUrl,
    metadata: null,
    searchQuery: "",
    retrievalMethod: "search",
    fetchedAt: new Date(0).toISOString(),
    language: null,
    license: c.license,
    attribution: null,
    width: c.width,
    height: c.height,
    duration: c.durationSec,
    mimeType: null,
    originalSource: null,
    downloadTimeMs: null,
    embeddingSimilarity: c.embeddingSimilarity,
    /**
     * The keyword score is left to the engine. `rankCandidates` normalises `keywordScore` across
     * the whole candidate list, so handing it a pre-computed number from the old counter would mix
     * two scales — and the engine already reads title, tags and description itself.
     */
    keywordScore: null,
    retrievalReasons: [],
    retrievalSources: [],
    clipSimilarity: c.clipSimilarity,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    editorialScore: null,
    motionLevel: null,
    rankingScore: null,
    rankingBreakdown: null,
  };
}

/**
 * What the Director asked for, in the ranking engine's own option vocabulary.
 *
 * FASE 11: the Director decides WHAT SHOT; retrieval decides WHICH ASSET realises it. This is the
 * one place those two meet, and it is a translation rather than a decision — every value comes
 * from the caller.
 */
export type PoolRankingRequest = {
  intent: VisualIntent;
  candidates: readonly RankablePoolCandidate[];
  /** 0..1 — how much movement the planned shot wants. A still photo scores badly for an aerial. */
  targetMotionLevel?: number;
  targetOrientation?: "landscape" | "portrait" | "square";
  /** The beat's length, so a two-second clip does not win a nine-second beat. */
  targetDurationSec?: number;
  /**
   * FASE 10 — assets this render has already used, so a repeat is PENALISED rather than
   * randomised away. Deterministic diversity: the same inputs always produce the same order.
   *
   * These are the legacy pipeline's own `VisualDedupState` shapes, read-only. Reusing them rather
   * than inventing a parallel dedup structure is why the diversity signal agrees with the dedup
   * the rest of the render already does — §17's "geen tweede cache", applied to bookkeeping.
   */
  usedPaths?: ReadonlySet<string>;
  usedCategories?: ReadonlyMap<string, number>;
  /** Entities the beat proved, so a candidate that names one is preferred over one that does not. */
  entityTerms?: readonly string[];
};

/**
 * Rank a pool with the real engine, highest first.
 *
 * Returns the engine's own `RankedCandidate[]`, breakdown included, so a caller can log WHY a
 * candidate won — which is what makes FASE 15's "why was this asset chosen" answerable at all.
 */
export function rankPoolCandidates(req: PoolRankingRequest): RankedCandidate[] {
  if (req.candidates.length === 0) return [];
  return rankCandidates(
    req.intent,
    req.candidates.map(poolCandidateToAsset),
    DEFAULT_RANKING_CONFIG,
    {
      ...(req.targetMotionLevel != null ? { targetMotionLevel: req.targetMotionLevel } : {}),
      ...(req.targetOrientation ? { targetOrientation: req.targetOrientation } : {}),
      ...(req.targetDurationSec != null ? { targetDurationSec: req.targetDurationSec } : {}),
      ...(req.usedPaths?.size ? { usedPaths: req.usedPaths } : {}),
      ...(req.usedCategories?.size ? { usedCategories: req.usedCategories } : {}),
      ...(req.entityTerms?.length ? { entityTerms: [...req.entityTerms] } : {}),
    }
  );
}

/**
 * The pool's candidates, reordered by the engine — same objects, best first.
 *
 * A drop-in for the old keyword sort: it takes and returns the caller's own candidates rather than
 * the engine's wrapper, so the call site does not have to learn a new type to get thirteen signals
 * instead of one. `rankingScore` is written back onto each candidate, because the pool's own type
 * has a slot for exactly that and a score nobody can read is a score nobody can audit.
 */
export function rankedPool<T extends RankablePoolCandidate>(
  req: Omit<PoolRankingRequest, "candidates"> & { candidates: readonly T[] }
): T[] {
  const byId = new Map(req.candidates.map((c) => [c.id, c]));
  const ranked = rankPoolCandidates(req as PoolRankingRequest);
  const out: T[] = [];
  for (const r of ranked) {
    const original = byId.get(r.candidate.candidateId);
    if (!original) continue;
    original.rankingScore = r.candidate.rankingScore;
    out.push(original);
  }
  /**
   * A candidate the engine did not return is appended rather than dropped. Ranking is an ORDERING;
   * silently losing a candidate would make the pool smaller than the caller built, which is a
   * different and much worse thing than putting it last.
   */
  for (const c of req.candidates) if (!out.includes(c)) out.push(c);
  return out;
}

/** One line for the retrieval log: who won, on what, and by how much. No URLs, no keys. */
export function formatPoolRanking(sceneIndex: number, ranked: readonly RankedCandidate[]): string {
  const top = ranked[0];
  if (!top) return `[Retrieval] s${sceneIndex} pool=0 ranked=none`;
  const runnerUp = ranked[1];
  return (
    `[Retrieval] s${sceneIndex} pool=${ranked.length} ` +
    `selected=${top.candidate.source}:${top.candidate.candidateId} ` +
    `score=${(top.candidate.rankingScore ?? 0).toFixed(4)}` +
    (runnerUp
      ? ` runnerUp=${runnerUp.candidate.source} margin=${(
          (top.candidate.rankingScore ?? 0) - (runnerUp.candidate.rankingScore ?? 0)
        ).toFixed(4)}`
      : "")
  );
}
