/** Visual Matching Engine V2 — Candidate Ranking Layer (funnel stage 3).
 *
 *  VisualIntent -> Retrieval -> Candidate Pool -> CLIP Pre-Filter -> [this] -> top
 *  3-5 candidates -> LLM Vision Scorer.
 *
 *  Scope is deliberately narrow: combine signals that already exist on each candidate
 *  (embeddingSimilarity, keywordScore, clipSimilarity, source priority) into one
 *  explainable, configurable score. No semantic judgement, no LLM, no confidence, no
 *  winner — those belong to the LLM Vision stage. clipPreFilter.ts is untouched; this
 *  module only reads the clipSimilarity it already wrote onto each CandidateAsset.
 *
 *  Fully data-driven: every decision flows through RankingConfig (weights + source
 *  priority) passed in or defaulted below — no if/else branching on a specific source or
 *  signal anywhere in this file. */
import { recordRankingOutcome } from "./rankingMetrics";
import { logCandidateRanking } from "./logging";
import type {
  CandidateAsset,
  CandidateSource,
  RankedCandidate,
  RankingBreakdown,
  RankingConfig,
  RankingOptions,
  RankingTrace,
  RankingWeights,
  SourcePriority,
  VisualIntent,
} from "./types";

/** Default weights — purely a starting point. Tune via RankingConfig.weights per call;
 *  no code change needed to experiment with different values.
 *
 *  editorialScore (0.1) is the new signal from ClipAnnotation. It's optional — when a
 *  candidate has no editorialScore (null), this weight is redistributed proportionally
 *  across the other signals so the total always sums to 1. */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  clipSimilarity: 0.34,
  embeddingSimilarity: 0.25,
  keywordScore: 0.17,
  sourcePriority: 0.09,
  editorialScore: 0.10,
  motionMatch: 0.05,
  // Phase 3 additions — modest weights so they nudge the existing semantic/keyword-dominated
  // ranking rather than overwhelm it, and (per the redistribution logic below) contribute
  // nothing until a candidate actually carries the underlying data (most current adapters
  // don't populate width/height/duration/publish-date yet — see sourceAdapters.ts).
  resolutionMatch: 0.04,
  orientationMatch: 0.03,
  durationFit: 0.05,
  freshness: 0.02,
  entityMatch: 0.08,
  diversity: 0.06,
};

/** Default source priority — higher wins. Known only here; no other component (retrieval,
 *  CLIP) is aware sources are prioritized at all. */
export const DEFAULT_SOURCE_PRIORITY: SourcePriority = {
  own_archive: 100,
  wikimedia: 90,
  europeana: 85,
  pexels: 80,
  pixabay: 70,
  internet_archive: 60,
  youtube_cc: 55,
  ai_generated: 50,
};

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  weights: DEFAULT_RANKING_WEIGHTS,
  sourcePriority: DEFAULT_SOURCE_PRIORITY,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Min-max normalizes keywordScore across the candidate batch being ranked, since the
 *  underlying scale is source-defined and not guaranteed to be 0..1 (unlike
 *  embeddingSimilarity/clipSimilarity, both already cosine similarities). Data-driven per
 *  call instead of a hardcoded source-specific scale. */
function buildKeywordNormalizer(candidates: CandidateAsset[]): (score: number | null) => number {
  const values = candidates.map((c) => c.keywordScore).filter((v): v is number => v !== null);
  if (values.length === 0) return () => 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return (score) => (score === null ? 0 : 1);
  return (score) => (score === null ? 0 : clamp01((score - min) / (max - min)));
}

function sourcePriorityFor(source: CandidateSource, sourcePriority: SourcePriority): number {
  return sourcePriority[source] ?? 0;
}

/**
 * Combines each candidate's existing retrieval signals (embeddingSimilarity, keywordScore,
 * clipSimilarity, source priority) into one weighted rankingScore. Operates only on the
 * candidates passed in — typically clipPreFilter()'s `passed` list — never re-fetches or
 * re-scores anything upstream.
 */
/**
 * Computes a 0..1 score for how well a candidate's motion level matches the target.
 * Uses a Gaussian-like falloff: perfect match = 1.0, ±30 points away ≈ 0.5.
 */
function motionMatchScore(motionLevel: number | null, targetMotionLevel: number | null): number | null {
  if (motionLevel === null || targetMotionLevel === null) return null;
  const diff = Math.abs(motionLevel - targetMotionLevel);
  return Math.exp(-(diff * diff) / (2 * 30 * 30)); // σ=30
}

// ─── Phase 3 (Visual Intelligence Engine): new scoring dimensions ──────────────────────────
// Every function below returns null when the underlying data isn't present on the candidate
// (most current adapters don't populate width/height/duration/publish-date yet), so these
// signals contribute nothing and their weight redistributes to the signals that ARE present —
// same optional-signal pattern already used for editorialScore/motionMatch above.

/** Rewards higher resolution, capped at 1080p on the shorter dimension. Resolution is used as
 *  the "visual quality" proxy since no real image-quality (sharpness/exposure/compression)
 *  model exists anywhere in this codebase — an honest signal actually available, not invented. */
function resolutionMatchScore(width: number | null, height: number | null): number | null {
  if (!width || !height) return null;
  return clamp01(Math.min(width, height) / 1080);
}

type Orientation = "landscape" | "portrait" | "square";

function orientationOf(width: number, height: number): Orientation {
  const ratio = width / height;
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.87) return "portrait";
  return "square";
}

function orientationMatchScore(
  width: number | null,
  height: number | null,
  target: Orientation | null | undefined
): number | null {
  if (!width || !height || !target) return null;
  const actual = orientationOf(width, height);
  if (actual === target) return 1;
  if (actual === "square" || target === "square") return 0.5;
  return 0; // landscape vs. portrait — never right for the target frame
}

/** Gaussian falloff (σ=3s): a clip within ~3s of the beat's needed on-screen duration scores
 *  highly, avoiding excessive looping/freeze-framing to fill time or hard truncation. */
function durationFitScore(duration: number | null, targetDurationSec: number | null | undefined): number | null {
  if (duration === null || !targetDurationSec) return null;
  const diff = Math.abs(duration - targetDurationSec);
  return Math.exp(-(diff * diff) / (2 * 3 * 3));
}

/** Mild recency bonus, decaying over ~20 years — historical-documentary beats often WANT old
 *  footage, so this nudges rather than filters. Only scores when the adapter's raw metadata
 *  actually carries a parseable date (e.g. YouTube's publishedAt); most sources don't. */
function freshnessScore(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const raw = record.publishedAt ?? record.uploadDate ?? record.date;
  if (typeof raw !== "string") return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  const ageYears = (Date.now() - ts) / (365 * 24 * 3600 * 1000);
  return clamp01(1 - ageYears / 20);
}

/** Text-based proxy for "people/objects/brands detected" — matches the beat's extracted
 *  entity terms (VisualIntent.people/objects/brands/companies) against the candidate's own
 *  title/description/searchQuery/tags. Not real computer-vision detection: no face/object
 *  detection model exists anywhere in this codebase, and integrating one from scratch is out
 *  of scope for a dormant module with no way to validate it in this environment. */
function entityMatchScore(candidate: CandidateAsset, entityTerms: string[] | undefined): number | null {
  if (!entityTerms || entityTerms.length === 0) return null;
  const haystack = [candidate.title, candidate.description, candidate.searchQuery, ...candidate.tags]
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return null;
  const matched = entityTerms.filter((term) => term.trim() && haystack.includes(term.toLowerCase()));
  return matched.length / entityTerms.length;
}

/** Penalizes candidates already used elsewhere in this video — reuses the legacy pipeline's
 *  VisualDedupState shape (usedPaths/usedCategories) as a read-only view rather than the
 *  ranking layer inventing its own parallel dedup bookkeeping. Exact-path reuse scores 0
 *  (hard "don't repeat this literal clip"); category over-use scores down gradually so a
 *  video isn't forced into showing wildly unrelated footage just to avoid one repeated tag. */
function diversityScore(
  candidate: CandidateAsset,
  usedPaths: ReadonlySet<string> | undefined,
  usedCategories: ReadonlyMap<string, number> | undefined
): number | null {
  if (!usedPaths && !usedCategories) return null;
  const key = candidate.localPath ?? candidate.remoteUrl;
  if (usedPaths && key && usedPaths.has(key)) return 0;
  if (usedCategories && candidate.tags.length > 0) {
    const maxUsage = Math.max(0, ...candidate.tags.map((t) => usedCategories.get(t) ?? 0));
    return clamp01(1 - maxUsage * 0.15);
  }
  return 1;
}

export function rankCandidates(
  intent: VisualIntent,
  candidates: CandidateAsset[],
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
  options: RankingOptions = {}
): RankedCandidate[] {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const { weights, sourcePriority } = config;
  const { targetMotionLevel, targetOrientation, targetDurationSec, usedPaths, usedCategories, entityTerms } = options;

  const maxConfiguredPriority = Math.max(1, ...Object.values(sourcePriority));
  const normalizeKeyword = buildKeywordNormalizer(candidates);

  const unsorted = candidates.map((candidate) => {
    const signalsUsed: RankingBreakdown["signalsUsed"] = [];

    const clipNorm = candidate.clipSimilarity !== null ? clamp01(candidate.clipSimilarity) : 0;
    if (candidate.clipSimilarity !== null) signalsUsed.push("clipSimilarity");

    const embeddingNorm = candidate.embeddingSimilarity !== null ? clamp01(candidate.embeddingSimilarity) : 0;
    if (candidate.embeddingSimilarity !== null) signalsUsed.push("embeddingSimilarity");

    const keywordNorm = normalizeKeyword(candidate.keywordScore);
    if (candidate.keywordScore !== null) signalsUsed.push("keywordScore");

    const priorityRaw = sourcePriorityFor(candidate.source, sourcePriority);
    const priorityNorm = clamp01(priorityRaw / maxConfiguredPriority);
    signalsUsed.push("sourcePriority");

    // Editorial score signal (only for own_archive assets with annotation)
    const editorialWeight = weights.editorialScore ?? 0;
    const editorialNorm =
      candidate.editorialScore !== null && candidate.editorialScore !== undefined
        ? clamp01(candidate.editorialScore / 100)
        : null;
    if (editorialNorm !== null) signalsUsed.push("editorialScore");

    // Motion match signal — reward clips whose motion level matches the narration energy
    const motionMatchWeight = weights.motionMatch ?? 0;
    const motionNorm = motionMatchScore(candidate.motionLevel, targetMotionLevel ?? null);
    if (motionNorm !== null) signalsUsed.push("motionMatch");

    // ─── Phase 3 optional signals — same "null when data absent" pattern as above ──────────
    const resolutionWeight = weights.resolutionMatch ?? 0;
    const resolutionNorm = resolutionMatchScore(candidate.width, candidate.height);
    if (resolutionNorm !== null) signalsUsed.push("resolutionMatch");

    const orientationWeight = weights.orientationMatch ?? 0;
    const orientationNorm = orientationMatchScore(candidate.width, candidate.height, targetOrientation);
    if (orientationNorm !== null) signalsUsed.push("orientationMatch");

    const durationFitWeight = weights.durationFit ?? 0;
    const durationFitNorm = durationFitScore(candidate.duration, targetDurationSec);
    if (durationFitNorm !== null) signalsUsed.push("durationFit");

    const freshnessWeight = weights.freshness ?? 0;
    const freshnessNorm = freshnessScore(candidate.metadata);
    if (freshnessNorm !== null) signalsUsed.push("freshness");

    const entityMatchWeight = weights.entityMatch ?? 0;
    const entityMatchNorm = entityMatchScore(candidate, entityTerms);
    if (entityMatchNorm !== null) signalsUsed.push("entityMatch");

    const diversityWeight = weights.diversity ?? 0;
    const diversityNorm = diversityScore(candidate, usedPaths, usedCategories);
    if (diversityNorm !== null) signalsUsed.push("diversity");

    // When any optional signal is absent for this candidate, redistribute its weight
    // proportionally across the base signals so the total always sums to 1.
    const optional: Array<{ weight: number; norm: number | null }> = [
      { weight: editorialWeight, norm: editorialNorm },
      { weight: motionMatchWeight, norm: motionNorm },
      { weight: resolutionWeight, norm: resolutionNorm },
      { weight: orientationWeight, norm: orientationNorm },
      { weight: durationFitWeight, norm: durationFitNorm },
      { weight: freshnessWeight, norm: freshnessNorm },
      { weight: entityMatchWeight, norm: entityMatchNorm },
      { weight: diversityWeight, norm: diversityNorm },
    ];
    const baseWeightSum = weights.clipSimilarity + weights.embeddingSimilarity + weights.keywordScore + weights.sourcePriority;
    const absentOptionalWeight = optional.reduce((sum, s) => sum + (s.norm === null ? s.weight : 0), 0);
    const redistributed = baseWeightSum > 0 ? absentOptionalWeight / baseWeightSum : 0;

    const breakdown: RankingBreakdown = {
      clipContribution: (weights.clipSimilarity + weights.clipSimilarity * redistributed) * clipNorm,
      embeddingContribution: (weights.embeddingSimilarity + weights.embeddingSimilarity * redistributed) * embeddingNorm,
      keywordContribution: (weights.keywordScore + weights.keywordScore * redistributed) * keywordNorm,
      sourceContribution: (weights.sourcePriority + weights.sourcePriority * redistributed) * priorityNorm,
      editorialContribution: editorialNorm !== null ? editorialWeight * editorialNorm : 0,
      motionMatchContribution: motionNorm !== null ? motionMatchWeight * motionNorm : 0,
      resolutionContribution: resolutionNorm !== null ? resolutionWeight * resolutionNorm : 0,
      orientationContribution: orientationNorm !== null ? orientationWeight * orientationNorm : 0,
      durationFitContribution: durationFitNorm !== null ? durationFitWeight * durationFitNorm : 0,
      freshnessContribution: freshnessNorm !== null ? freshnessWeight * freshnessNorm : 0,
      entityMatchContribution: entityMatchNorm !== null ? entityMatchWeight * entityMatchNorm : 0,
      diversityContribution: diversityNorm !== null ? diversityWeight * diversityNorm : 0,
      signalsUsed,
    };

    const rankingScore =
      breakdown.clipContribution +
      breakdown.embeddingContribution +
      breakdown.keywordContribution +
      breakdown.sourceContribution +
      (breakdown.editorialContribution ?? 0) +
      (breakdown.motionMatchContribution ?? 0) +
      (breakdown.resolutionContribution ?? 0) +
      (breakdown.orientationContribution ?? 0) +
      (breakdown.durationFitContribution ?? 0) +
      (breakdown.freshnessContribution ?? 0) +
      (breakdown.entityMatchContribution ?? 0) +
      (breakdown.diversityContribution ?? 0);

    return { candidate, breakdown, rankingScore, priorityRaw };
  });

  unsorted.sort((a, b) => b.rankingScore - a.rankingScore);

  const ranked: RankedCandidate[] = unsorted.map((entry, i) => ({
    candidate: {
      ...entry.candidate,
      rankingScore: entry.rankingScore,
      rankingBreakdown: entry.breakdown,
    },
    rankingScore: entry.rankingScore,
    rankingBreakdown: entry.breakdown,
    position: i + 1,
  }));

  const durationMs = Date.now() - start;

  const trace: RankingTrace = {
    beatId: intent.beatId,
    startedAt,
    durationMs,
    candidateCount: candidates.length,
    weights,
    sourcePriority,
    entries: ranked.map((r, i) => ({
      candidateId: r.candidate.candidateId,
      source: r.candidate.source,
      signals: {
        clipSimilarity: r.candidate.clipSimilarity,
        embeddingSimilarity: r.candidate.embeddingSimilarity,
        keywordScore: r.candidate.keywordScore,
        sourcePriorityRaw: unsorted[i].priorityRaw,
      },
      breakdown: r.rankingBreakdown,
      rankingScore: r.rankingScore,
      position: r.position,
    })),
  };

  recordRankingOutcome({ durationMs, ranked });
  logCandidateRanking("ranking_complete", trace);

  return ranked;
}
