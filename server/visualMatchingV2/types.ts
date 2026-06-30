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
  };
};

export type RetrievalOrchestratorOptions = {
  /** Own-archive metadata adapter + external adapters default to the standard registry
   *  (sourceAdapters.ts) — override only for tests. */
  ownArchiveAdapter?: SourceAdapter;
  externalAdapters?: SourceAdapter[];
  /** Optional embedding-backed own-archive search. Omit to skip the embedding phase
   *  entirely (e.g. when VISUAL_MATCHING_V2_EMBEDDINGS is off) — metadata search alone
   *  still runs. */
  embeddingSearch?: {
    search(queryText: string, topK: number): Promise<{ hits: { id: string; similarity: number; metadata?: Record<string, unknown> }[]; cacheHit: boolean }>;
    topK?: number;
  };
  perSourceTimeoutMs?: number;
  retriesPerSource?: number;
  /** Stop waiting on remaining (slower) external sources once the pool reaches this many
   *  candidates. Already-dispatched requests are not cancelled, only no longer awaited —
   *  same documented semantics as the per-source timeout in candidateFetcher.ts. */
  maxTotalCandidates?: number;
  workDir: string;
  sceneIndex: number;
  count?: number;
};
