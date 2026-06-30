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
