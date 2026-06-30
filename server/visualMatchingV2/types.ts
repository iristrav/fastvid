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
