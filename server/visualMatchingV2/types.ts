/** Visual Matching Engine V2 — shared types. Inert: nothing in the active pipeline imports
 *  from this directory yet. See server/sourcingPolicy.ts for the V2 feature flags. */

export type VideoContext = {
  videoId: string;
  topicHash: string;
  era: string;
  setting: string;
  keySubjects: string[];
  recurringLocations: string[];
  visualStyleNotes: string;
  cacheHit: boolean;
};

export type VisualIntent = {
  beatId: string;
  spokenText: string;
  visualSubject: string;
  visualAction: string;
  visualLocation: string;
  visualTime: string;
  historicalContext: string;
  emotion: string;
  visualDescription: string;
  primaryKeyword: string;
  secondaryKeyword: string;
  negativeKeywords: string[];
  intentHash: string;
  cacheHit: boolean;
};

export type CandidateSource = "own_archive" | "wikimedia" | "pexels" | "pixabay" | "internet_archive" | "ai_generated";
export type CandidateAssetType = "video" | "image";
export type CandidateRetrievalMethod = "search" | "cache";

/**
 * Uniform candidate model returned by every SourceAdapter and consumed by the (future)
 * Candidate Fetcher. Stage 2 scope: structure + normalization only — no scoring fields here.
 */
export type CandidateAsset = {
  candidateId: string;
  source: CandidateSource;
  assetType: CandidateAssetType;
  title: string | null;
  description: string | null;
  tags: string[];
  thumbnail: string | null;
  localPath: string | null;
  remoteUrl: string | null;
  /** Raw payload from the underlying adapter call, kept opaque at this stage. */
  metadata: unknown;
  searchQuery: string;
  retrievalMethod: CandidateRetrievalMethod;
  fetchedAt: string;
  // ─── Stage 2 completion: fields needed by later stages, not populated by every adapter yet ──
  language: string | null;
  license: string | null;
  attribution: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  mimeType: string | null;
  originalSource: string | null;
  downloadTimeMs: number | null;
  // ─── Semantic retrieval (Priority 1): kept separate, never blended into one score, so
  // later stages (scoring/explainability) can see exactly which signal(s) found a candidate. ──
  /** Cosine similarity from vector search, 0..1. Null when the candidate wasn't found via
   *  embedding search (e.g. keyword-only sources, or fast mode where semantic is disabled). */
  embeddingSimilarity: number | null;
  /** Relevance score from keyword/metadata search, on whatever scale that source produces.
   *  Null when the candidate wasn't found via keyword search. */
  keywordScore: number | null;
  /** Every retrieval path that produced this candidate. More than one entry when dedup
   *  merged a keyword hit and a semantic hit for the same underlying asset. */
  retrievalReasons: ("keyword" | "semantic")[];
  /** Provenance trail: one entry per retrieval path that found this candidate, carrying
   *  that path's own score on its own scale (never blended). Lets later stages (scoring,
   *  explainability) show exactly why a candidate was chosen. */
  retrievalSources: { source: string; score: number }[];
  // ─── CLIP Pre-Filter (stage: clipPreFilter.ts): populated only after clipPreFilter()
  // runs on this candidate. Deliberately just the raw signal + its provenance — no
  // overallScore/confidence/winner, which belong to the future LLM Vision scoring stage. ──
  /** Cosine similarity (0..1) between this candidate's resolved image and the beat's CLIP
   *  text query embedding. Null until clipPreFilter() has scored this candidate. */
  clipSimilarity: number | null;
  /** CLIP model id that produced clipSimilarity, e.g. "Xenova/clip-vit-base-patch32". */
  clipModel: string | null;
  /** Embedding schema version for the CLIP cache, so a future model/version bump doesn't
   *  silently reuse stale cached vectors. */
  clipEmbeddingVersion: string | null;
  /** Wall-clock ms spent embedding (or cache-hitting) this specific candidate's image. */
  clipLatencyMs: number | null;
  // ─── Candidate Ranking Layer (stage: candidateRanking.ts): combines existing retrieval
  // signals (embeddingSimilarity, keywordScore, clipSimilarity, source priority) into one
  // weighted score, purely so later stages don't have to re-weigh raw signals themselves.
  // No semantic judgement, no confidence, no winner — those belong to LLM Vision scoring. ──
  /** Weighted combination of this candidate's retrieval signals. Null until rankCandidates()
   *  has scored this candidate. */
  rankingScore: number | null;
  /** Per-signal normalized values and their weighted contributions to rankingScore, kept
   *  for explainability. Null until rankCandidates() has scored this candidate. */
  rankingBreakdown: RankingBreakdown | null;
};

export type SourceAdapter = {
  name: CandidateAsset["source"];
  /** Whether this source supports pre-computed embeddings for vector search (own archive only, for now). */
  supportsPreEmbedding: boolean;
  search(intent: VisualIntent, ctx: SourceAdapterSearchCtx): Promise<CandidateAsset[]>;
};

export type SourceAdapterSearchCtx = {
  workDir: string;
  sceneIndex: number;
  count?: number;
  /** Abort signal for this search. Adapters that can honor it (e.g. via fetch's `signal`
   *  option) should; adapters that wrap legacy functions without signal support may ignore
   *  it — the Candidate Fetcher still stops waiting on abort either way. */
  signal?: AbortSignal;
};

// ─── Stage 2: Candidate Fetcher / Parallel Search Engine ──────────────────────

export type SourceFetchOutcome = {
  source: CandidateSource;
  candidates: CandidateAsset[];
  durationMs: number;
  cacheHit: boolean;
  timedOut: boolean;
  retries: number;
  error: string | null;
};

export type CandidateFetchTrace = {
  beatId: string;
  startedAt: string;
  durationMs: number;
  sources: SourceFetchOutcome[];
  totalCandidates: number;
};

export type CandidateFetcherOptions = {
  /** Max concurrent source searches in flight at once. Default: all sources at once. */
  concurrency?: number;
  /** Per-source timeout in ms. A slow source is abandoned (not awaited) past this. */
  perSourceTimeoutMs?: number;
  /** Retries per source on failure (not on timeout). */
  retriesPerSource?: number;
  /** Subset of adapters to run; defaults to ALL_SOURCE_ADAPTERS. */
  adapters?: SourceAdapter[];
};

export type CandidateFetchResult = {
  candidates: CandidateAsset[];
  trace: CandidateFetchTrace;
};

// ─── Stage 2 completion: cache provider abstraction + metrics ─────────────────

export type SearchCacheKey = {
  source: CandidateSource;
  query: string;
  language?: string;
  filters?: Record<string, unknown>;
};

/**
 * Backend-agnostic cache contract. The Candidate Fetcher and Search Cache module only
 * depend on this interface, never on a concrete backend — swapping memory/Redis/DB
 * implementations later requires no changes to the Fetcher.
 */
export interface SearchCacheProvider {
  get(key: SearchCacheKey): Promise<CandidateAsset[] | undefined>;
  set(key: SearchCacheKey, candidates: CandidateAsset[], ttlMs: number): Promise<void>;
  delete(key: SearchCacheKey): Promise<void>;
  clear(): Promise<void>;
}

export type SourceMetricsSnapshot = {
  source: CandidateSource;
  searches: number;
  avgDurationMs: number;
  timeoutRate: number;
  retryRate: number;
  cacheHitRate: number;
  avgCandidatesPerSearch: number;
};

// ─── Retrieval Strategy Engine: determines what strategy to use before the Orchestrator
// executes it. Strict separation: the Engine decides, the Orchestrator executes. ──────

export type RetrievalStrategyMode =
  | "archive_only"
  | "archive_first"
  | "balanced"
  | "external_first"
  | "high_quality"
  | "fast";

/** Per-source execution plan produced by the Strategy Engine and consumed verbatim by
 *  the Orchestrator. No if/else in the Orchestrator — all per-source decisions are here. */
export type SourcePlan = {
  source: CandidateSource;
  /** Lower = higher priority; own archive is always 1, external sources start at 2. */
  priority: number;
  /** Max candidates to request from this source. */
  maxCandidates: number;
  /** Per-source timeout. Overrides the strategy-level archiveTimeoutMs/externalTimeoutMs. */
  timeoutMs: number;
  /** Which phase this source belongs to in the Orchestrator's two-phase execution plan. */
  phase: RetrievalSourcePhase;
};

/** Complete retrieval strategy — the only input the Orchestrator needs besides intent and
 *  execution context. The Orchestrator never contains if/else about retrieval behavior;
 *  every decision is in this object, produced by the Strategy Engine. */
export interface RetrievalStrategy {
  mode: RetrievalStrategyMode;
  sources: SourcePlan[];
  maxCandidates: number;
  enableEmbedding: boolean;
  enableKeywordSearch: boolean;
  enableMetadataSearch: boolean;
  allowEarlyExit: boolean;
  /** When true and the archive phase already found >= maxCandidates, skip the external
   *  parallel phase entirely instead of starting it and cutting it off mid-run. */
  allowFallback: boolean;
  retriesPerSource: number;
  externalTimeoutMs: number;
  archiveTimeoutMs: number;
}

/** Input to the Strategy Engine. Everything it needs to choose a strategy: the intent
 *  already holds keyword/topic/emotion signals; videoContext adds era/setting context;
 *  the remaining fields carry runtime flags. */
export type RetrievalStrategyContext = {
  videoContext?: VideoContext;
  videoLength?: string | null;
  performanceMode?: "fast" | "high_quality" | "balanced";
  /** Passed from visualMatchingV2EmbeddingsEnabled() — the engine doesn't import
   *  sourcingPolicy.ts to respect the layering: policy → engine, not engine → policy. */
  embeddingEnabled?: boolean;
  /** Passed from visualMatchingV2SourceAdaptersEnabled() / feature flag state. */
  availableSources?: CandidateSource[];
};

// ─── Retrieval Orchestrator: the single component that decides how candidates are
// fetched. Every source goes through this — no adapter or caller searches on its own.
// Returns only a CandidatePool: no scoring, no selection, no CLIP, no LLM. ───────────

/** One group of candidates considered duplicates of each other. `keptCandidateId` is the
 *  single survivor that remains in the pool's `candidates` list; the rest are recorded
 *  here for transparency but dropped from the pool. */
export type DuplicateGroup = {
  dedupKey: string;
  matchedOn: "candidateId" | "remoteUrl" | "hash" | "perceptualHash";
  keptCandidateId: string;
  droppedCandidateIds: string[];
};

export type RetrievalSourcePhase = "own_archive_metadata" | "own_archive_embedding" | "external_parallel";

/** Per-source outcome, tagged with which orchestration phase it ran in. Superset of
 *  SourceFetchOutcome (Candidate Fetcher's own per-source result shape) — the
 *  orchestrator reuses that shape rather than inventing a parallel one. */
export type RetrievalSourceOutcome = SourceFetchOutcome & {
  phase: RetrievalSourcePhase;
  /** True if this source's result was excluded from the final wait because the pool
   *  already had enough candidates by the time it would have settled. The source's
   *  underlying network call may still complete in the background — see
   *  candidateFetcher.ts's documented cancellation semantics. */
  skippedForEarlyExit: boolean;
};

export type CandidatePool = {
  beatId: string;
  /** Final, deduplicated candidate list — this is the orchestrator's sole output beyond
   *  bookkeeping. No scoring or ordering beyond source-phase order. */
  candidates: CandidateAsset[];
  duplicateGroups: DuplicateGroup[];
  sources: RetrievalSourceOutcome[];
  stats: {
    startedAt: string;
    durationMs: number;
    totalCandidatesBeforeDedup: number;
    totalCandidatesAfterDedup: number;
    cacheHits: number;
    embeddingHits: number;
    keywordHits: number;
    duplicatesRemoved: number;
    earlyExitTriggered: boolean;
    // ─── Refinement: per-path latency + hit-rate metrics, for objectively comparing
    // retrieval strategies later. All latencies are averages in ms; -1 when no samples. ──
    avgEmbeddingLatencyMs: number;
    avgQdrantSearchLatencyMs: number;
    avgKeywordLatencyMs: number;
    avgSemanticLatencyMs: number;
    dedupLatencyMs: number;
    mergeCount: number;
    semanticHitRate: number;
    keywordHitRate: number;
  };
};

export type EmbeddingSearchProvider = {
  search(queryText: string, topK: number): Promise<{ hits: { id: string; similarity: number; metadata?: Record<string, unknown> }[]; cacheHit: boolean }>;
};

// ─── CLIP Pre-Filter: second stage of the funnel, run on the already-fetched Candidate
// Pool only (never on the unbounded source results). Output is purely a similarity-ranked
// top-N — no overallScore, no confidence, no winner. Those belong to the future LLM Vision
// scoring stage. ────────────────────────────────────────────────────────────────────────

export type ClipCandidateOutcome = {
  candidateId: string;
  clipSimilarity: number | null;
  clipLatencyMs: number;
  cacheHit: boolean;
  /** Why this candidate has no similarity — e.g. no resolvable local image, pipeline not
   *  loaded, download failed. Null when clipSimilarity was computed successfully. */
  skippedReason: string | null;
};

/** Explainability trace for one clipPreFilter() call (one beat). Deliberately CLIP-only —
 *  not a BeatSelectionTrace, which is reserved for the future LLM Vision/selection stage. */
export type ClipFilterTrace = {
  beatId: string;
  startedAt: string;
  durationMs: number;
  candidateCount: number;
  batchMode: "batch" | "sequential";
  batchSize: number;
  model: string;
  embeddingVersion: string;
  outcomes: ClipCandidateOutcome[];
  passedCandidateIds: string[];
  rejectedCandidateIds: string[];
  avgSimilarity: number | null;
  cacheHitRate: number;
};

export type ClipPreFilterOptions = {
  /** Max candidates returned in `passed`, sorted by clipSimilarity descending. Default 5. */
  topN?: number;
  /** Minimum cosine similarity (0..1) required to be eligible for `passed`. Candidates
   *  below this are still scored and returned in `rejected`. Default: no floor (0). */
  minSimilarity?: number;
};

export type ClipFilterResult = {
  /** Top 3-5 candidates by clipSimilarity, descending. No further ranking signal attached. */
  passed: CandidateAsset[];
  /** Every candidate that was scored but didn't make the top-N cut, or couldn't be scored. */
  rejected: CandidateAsset[];
  trace: ClipFilterTrace;
};

// ─── Candidate Ranking Layer: third funnel stage, run on the CLIP Pre-Filter's already-
// narrowed candidate list. Purely combines existing retrieval signals (no semantic
// judgement) into one configurable, explainable score — no winner, no confidence, no LLM. ──

/** Relative weight given to each existing signal when computing rankingScore. Fully
 *  configurable so weighting can be tuned by experiment without code changes. Weights are
 *  applied to each signal's normalized (0..1) contribution — they don't need to sum to 1. */
export type RankingWeights = {
  clipSimilarity: number;
  embeddingSimilarity: number;
  keywordScore: number;
  sourcePriority: number;
};

/** Configured priority per source, higher = preferred. Known only to the Ranking Layer —
 *  no other component (retrieval, CLIP) is aware sources are prioritized at all. */
export type SourcePriority = Record<CandidateSource, number>;

export type RankingConfig = {
  weights: RankingWeights;
  sourcePriority: SourcePriority;
};

/** Per-signal normalized value and its weighted contribution to rankingScore, for one
 *  candidate. `signalsUsed` lists which signals were actually present (non-null) for this
 *  candidate, since not every candidate carries every signal. */
export type RankingBreakdown = {
  clipContribution: number;
  embeddingContribution: number;
  keywordContribution: number;
  sourceContribution: number;
  signalsUsed: ("clipSimilarity" | "embeddingSimilarity" | "keywordScore" | "sourcePriority")[];
};

export type RankedCandidate = {
  candidate: CandidateAsset;
  rankingScore: number;
  rankingBreakdown: RankingBreakdown;
  /** 1-based position in the ranked output, highest rankingScore first. */
  position: number;
};

/** Explainability trace for one rankCandidates() call (one beat) — per candidate: every
 *  signal used, its computed contribution, the final score, and final position. */
export type RankingTrace = {
  beatId: string;
  startedAt: string;
  durationMs: number;
  candidateCount: number;
  weights: RankingWeights;
  sourcePriority: SourcePriority;
  entries: {
    candidateId: string;
    source: CandidateSource;
    signals: {
      clipSimilarity: number | null;
      embeddingSimilarity: number | null;
      keywordScore: number | null;
      sourcePriorityRaw: number;
    };
    breakdown: RankingBreakdown;
    rankingScore: number;
    position: number;
  }[];
};

// ─── LLM Vision Scorer: fourth funnel stage, operates on the Ranking Layer's top 3-5
// candidates. Purely content/visual judgement — no retrieval signals, no ranking signals,
// no fallback, no winner selection. Those belong to the Selector stage. ─────────────────

/** Fixed scoring schema: every candidate gets exactly these six dimensions plus an
 *  overall score and a one-sentence reasoning string. No confidence tier, no accept/reject. */
export type VisionScores = {
  subjectMatch: number;       // 0-100
  actionMatch: number;        // 0-100
  historicalAccuracy: number; // 0-100
  contextMatch: number;       // 0-100
  locationMatch: number;      // 0-100
  emotionMatch: number;       // 0-100
  overallScore: number;       // 0-100
  /** One sentence max — for explainability only, not used for selection. */
  reasoning: string;
};

export type ScoredCandidate = {
  candidate: RankedCandidate;
  visionScores: VisionScores;
  /** Model id that produced visionScores, e.g. "gpt-4o-mini". */
  visionModel: string;
  promptVersion: string;
  /** Wall-clock ms for the LLM call that produced this candidate's score (0 for cache hits). */
  visionLatencyMs: number;
  cacheHit: boolean;
};

/** Explainability trace for one scoreCandidates() call (one beat). */
export type VisionScoreTrace = {
  beatId: string;
  startedAt: string;
  durationMs: number;
  candidateCount: number;
  model: string;
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  cacheHits: number;
  entries: {
    candidateId: string;
    visionLatencyMs: number;
    cacheHit: boolean;
    scores: VisionScores;
  }[];
};

// ─── Candidate Selector: fifth and final funnel stage. The only component that may choose
// a winner. All prior stages gather information; this stage decides. ─────────────────────

export type ConfidenceTier = "perfect" | "good" | "acceptable" | "reject";

/** Configurable tier boundaries — all thresholds are inclusive lower bounds on
 *  visionScores.overallScore (0-100). Callers may override via SelectionConfig.
 *  Deliberately separate from VisionScores so they can evolve independently. */
export type ConfidenceTierThresholds = {
  /** Minimum overallScore to qualify as "perfect". Default 85. */
  perfect: number;
  /** Minimum overallScore to qualify as "good". Default 70. */
  good: number;
  /** Minimum overallScore to qualify as "acceptable". Default 50. */
  acceptable: number;
  /** Anything below "acceptable" is "reject" — no explicit field needed. */
};

export type SelectionConfig = {
  thresholds: ConfidenceTierThresholds;
  /** Source priority map — same shape as RankingConfig.sourcePriority, used as the final
   *  tiebreaker so the Selector's tie-break logic stays data-driven, not hardcoded. If
   *  omitted, defaults from DEFAULT_SOURCE_PRIORITY in candidateRanking.ts are used. */
  sourcePriority?: SourcePriority;
};

/** Per-candidate verdict recorded in the trace for every candidate, winner and losers alike. */
export type CandidateVerdict = {
  candidateId: string;
  overallScore: number;
  confidenceTier: ConfidenceTier;
  rankingScore: number | null;
  clipSimilarity: number | null;
  embeddingSimilarity: number | null;
  keywordScore: number | null;
  /** Why this candidate was NOT selected (null for the winner). */
  rejectedReason: string | null;
};

/** Complete trace from one selectCandidate() call — designed so the future
 *  BeatSelectionTrace component only needs `trace.save(selectionResult.trace)`. Contains
 *  every signal and decision that went into the selection, with no post-hoc reconstruction
 *  needed. */
export type SelectorTrace = {
  beatId: string;
  startedAt: string;
  durationMs: number;
  candidateCount: number;
  thresholds: ConfidenceTierThresholds;
  /** Whether a tiebreak had to be applied to break a score tie among equal-scoring candidates. */
  tieBreakApplied: boolean;
  /** Human-readable description of the tiebreak step that resolved the tie, or null. */
  tieBreakReason: string | null;
  /** Id of the selected candidate, or null when needsResearch is true. */
  selectedCandidateId: string | null;
  /** Single human-readable sentence explaining the selection or rejection decision. */
  selectionReason: string;
  confidenceTier: ConfidenceTier | null;
  needsResearch: boolean;
  verdicts: CandidateVerdict[];
};

export type SelectionResult = {
  /** The winning ScoredCandidate — null when needsResearch is true. */
  selectedCandidate: ScoredCandidate | null;
  selectedCandidateId: string | null;
  confidenceTier: ConfidenceTier | null;
  /** True when every candidate scored below the "acceptable" threshold. The pipeline should
   *  trigger another retrieval pass rather than materializing a reject-tier clip. */
  needsResearch: boolean;
  selectionReason: string;
  /** Complete, self-contained trace ready to be persisted by BeatSelectionTrace. */
  trace: SelectorTrace;
  /** All candidates, sorted by overallScore descending, with their verdicts attached so
   *  the BeatSelectionTrace can present a full ranked explanation without re-sorting. */
  allCandidates: ScoredCandidate[];
};

export type RetrievalOrchestratorOptions = {
  /** The strategy produced by the Strategy Engine — the Orchestrator executes it
   *  verbatim, with no internal decisions. */
  strategy: RetrievalStrategy;
  /** Override the standard adapter registry (sourceAdapters.ts) — for tests only. */
  adapterOverrides?: Partial<Record<CandidateSource, SourceAdapter>>;
  /** The embedding-search provider instance; the Strategy must have enableEmbedding:true
   *  for this to be invoked. Omit if no embeddings are configured. */
  embeddingSearch?: EmbeddingSearchProvider;
  /** Execution context — workdir/index/count are pipeline state, not strategy. */
  workDir: string;
  sceneIndex: number;
  count?: number;
};
