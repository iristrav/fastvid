/** Visual Matching Engine V2 — Retrieval Orchestrator.
 *  The single component that decides how candidates are fetched. No source adapter
 *  searches on its own — every source goes through here, which centrally owns: source
 *  selection, ordering, parallelism, per-source timeouts, retry policy, cache usage,
 *  vector vs. keyword search, fallback policy, deduplication, source priority, max
 *  candidates per source, total pool size, logging, and metrics.
 *
 *  Strategy:
 *   1. Own archive — metadata search (existing ownArchiveAdapter, via the existing
 *      Candidate Fetcher's per-source logic) and, when an embedding search is supplied,
 *      embedding search — combined.
 *   2. External sources (Wikimedia, Pexels, Pixabay, Internet Archive) start in parallel.
 *      Once the pool already has enough candidates, slower external sources are no longer
 *      awaited — see candidateFetcher.ts's documented cancellation semantics: their
 *      in-flight request isn't forcibly killed, the orchestrator just stops waiting on it.
 *   3. All results pass through one central dedup pass (dedup.ts).
 *
 *  Returns only a CandidatePool — no scoring, no selection, no CLIP, no LLM. Those are
 *  later stages. Reuses the existing Candidate Fetcher's per-source dispatch
 *  (searchOneSourceWithRetry) rather than re-implementing cache/timeout/retry logic. Gated
 *  by visualMatchingV2RetrievalOrchestratorEnabled() in sourcingPolicy.ts; not called from
 *  the active pipeline yet. */

import { searchOneSourceWithRetry } from "./candidateFetcher";
import { dedupeCandidates } from "./dedup";
import { ownArchiveAdapter, ALL_SOURCE_ADAPTERS } from "./sourceAdapters";
import { logRetrievalOrchestrator } from "./logging";
import type {
  CandidateAsset,
  CandidatePool,
  RetrievalOrchestratorOptions,
  RetrievalSourceOutcome,
  SourceAdapter,
  SourceAdapterSearchCtx,
  VisualIntent,
} from "./types";

const DEFAULT_PER_SOURCE_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES_PER_SOURCE = 1;
const DEFAULT_MAX_TOTAL_CANDIDATES = 60;

function defaultExternalAdapters(ownArchive: SourceAdapter): SourceAdapter[] {
  return ALL_SOURCE_ADAPTERS.filter((a) => a.name !== ownArchive.name);
}

/** Maps an embedding-search hit (id + similarity + opaque metadata) back to a
 *  CandidateAsset. Own-archive embeddings are stored with enough metadata to round-trip
 *  this; assets that predate embedding backfill simply never produce a hit here, so this
 *  is purely additive over the metadata-search phase. */
function candidateFromEmbeddingHit(hit: { id: string; similarity: number; metadata?: Record<string, unknown> }, searchQuery: string): CandidateAsset {
  const metadata = hit.metadata ?? {};
  return {
    candidateId: `own_archive:embedding:${hit.id}`,
    source: "own_archive",
    assetType: (metadata.assetType as CandidateAsset["assetType"]) ?? "video",
    title: (metadata.title as string) ?? null,
    description: (metadata.description as string) ?? null,
    tags: (metadata.tags as string[]) ?? [],
    thumbnail: (metadata.thumbnail as string) ?? null,
    localPath: (metadata.localPath as string) ?? (metadata.path as string) ?? null,
    remoteUrl: (metadata.remoteUrl as string) ?? null,
    metadata: { ...metadata, embeddingSimilarity: hit.similarity },
    searchQuery,
    retrievalMethod: "search",
    language: (metadata.language as string) ?? null,
    license: (metadata.license as string) ?? null,
    attribution: (metadata.attribution as string) ?? null,
    width: (metadata.width as number) ?? null,
    height: (metadata.height as number) ?? null,
    duration: (metadata.duration as number) ?? null,
    mimeType: (metadata.mimeType as string) ?? null,
    originalSource: (metadata.originalSource as string) ?? null,
    downloadTimeMs: null,
    fetchedAt: new Date().toISOString(),
  };
}

function searchQueryFromIntent(intent: VisualIntent): string {
  return intent.primaryKeyword || intent.visualDescription || intent.visualSubject;
}

/** Runs the external-source phase with early exit: starts every adapter immediately, but
 *  stops awaiting remaining ones as soon as `targetTotal` more candidates aren't needed —
 *  i.e. the pool (existing + collected so far) already has enough. Reuses
 *  searchOneSourceWithRetry (cache/timeout/retry/metrics) for every individual source. */
async function runExternalPhaseWithEarlyExit(
  adapters: SourceAdapter[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  perSourceTimeoutMs: number,
  retriesPerSource: number,
  existingCandidateCount: number,
  maxTotalCandidates: number
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; earlyExitTriggered: boolean }> {
  type Pending = { adapter: SourceAdapter; promise: Promise<RetrievalSourceOutcome> };

  const pending: Pending[] = adapters.map((adapter) => ({
    adapter,
    promise: searchOneSourceWithRetry(adapter, intent, ctx, perSourceTimeoutMs, retriesPerSource).then(
      (outcome) => ({ ...outcome, phase: "external_parallel" as const, skippedForEarlyExit: false })
    ),
  }));

  const settled: RetrievalSourceOutcome[] = [];
  const collected: CandidateAsset[] = [];
  let remaining = [...pending];
  let earlyExitTriggered = false;

  while (remaining.length > 0) {
    const total = existingCandidateCount + collected.length;
    if (total >= maxTotalCandidates) {
      earlyExitTriggered = true;
      for (const r of remaining) {
        settled.push({
          source: r.adapter.name,
          candidates: [],
          durationMs: 0,
          cacheHit: false,
          timedOut: false,
          retries: 0,
          error: null,
          phase: "external_parallel",
          skippedForEarlyExit: true,
        });
        logRetrievalOrchestrator("early_exit", { beatId: intent.beatId, skippedSource: r.adapter.name, poolSize: total });
      }
      break;
    }

    const winnerIndex = await Promise.race(remaining.map((r, i) => r.promise.then(() => i)));
    const winner = remaining[winnerIndex];
    const outcome = await winner.promise;
    settled.push(outcome);
    collected.push(...outcome.candidates);
    remaining = remaining.filter((_, i) => i !== winnerIndex);
  }

  return { outcomes: settled, candidates: collected, earlyExitTriggered };
}

/** Runs the own-archive phase: metadata search always; embedding search only when
 *  `options.embeddingSearch` is supplied (i.e. the caller has embeddings enabled). */
async function runOwnArchivePhase(
  ownArchive: SourceAdapter,
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  perSourceTimeoutMs: number,
  retriesPerSource: number,
  embeddingSearch: RetrievalOrchestratorOptions["embeddingSearch"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; embeddingHits: number }> {
  logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "own_archive_metadata" });
  const metadataOutcome = await searchOneSourceWithRetry(ownArchive, intent, ctx, perSourceTimeoutMs, retriesPerSource);
  const outcomes: RetrievalSourceOutcome[] = [
    { ...metadataOutcome, phase: "own_archive_metadata", skippedForEarlyExit: false },
  ];
  let candidates = [...metadataOutcome.candidates];
  let embeddingHits = 0;

  if (embeddingSearch) {
    logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "own_archive_embedding" });
    const start = Date.now();
    try {
      const queryText = searchQueryFromIntent(intent);
      const { hits, cacheHit } = await embeddingSearch.search(queryText, embeddingSearch.topK ?? 10);
      const embeddingCandidates = hits.map((hit) => candidateFromEmbeddingHit(hit, queryText));
      candidates = candidates.concat(embeddingCandidates);
      embeddingHits = hits.length;
      outcomes.push({
        source: "own_archive",
        candidates: embeddingCandidates,
        durationMs: Date.now() - start,
        cacheHit,
        timedOut: false,
        retries: 0,
        error: null,
        phase: "own_archive_embedding",
        skippedForEarlyExit: false,
      });
    } catch (err) {
      outcomes.push({
        source: "own_archive",
        candidates: [],
        durationMs: Date.now() - start,
        cacheHit: false,
        timedOut: false,
        retries: 0,
        error: (err as Error).message,
        phase: "own_archive_embedding",
        skippedForEarlyExit: false,
      });
      logRetrievalOrchestrator("error", { beatId: intent.beatId, phase: "own_archive_embedding", error: (err as Error).message });
    }
  }

  logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "own_archive", candidateCount: candidates.length });
  return { outcomes, candidates, embeddingHits };
}

/** The single entry point every caller must use to retrieve candidates. Returns a
 *  deduplicated CandidatePool — no scoring, selection, CLIP, or LLM involvement. */
export async function retrieveCandidatePool(
  intent: VisualIntent,
  options: RetrievalOrchestratorOptions
): Promise<CandidatePool> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const ownArchive = options.ownArchiveAdapter ?? ownArchiveAdapter;
  const externalAdapters = options.externalAdapters ?? defaultExternalAdapters(ownArchive);
  const perSourceTimeoutMs = options.perSourceTimeoutMs ?? DEFAULT_PER_SOURCE_TIMEOUT_MS;
  const retriesPerSource = options.retriesPerSource ?? DEFAULT_RETRIES_PER_SOURCE;
  const maxTotalCandidates = options.maxTotalCandidates ?? DEFAULT_MAX_TOTAL_CANDIDATES;
  const ctx: SourceAdapterSearchCtx = { workDir: options.workDir, sceneIndex: options.sceneIndex, count: options.count };

  const ownArchiveResult = await runOwnArchivePhase(
    ownArchive,
    intent,
    ctx,
    perSourceTimeoutMs,
    retriesPerSource,
    options.embeddingSearch
  );

  logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "external_parallel", sourceCount: externalAdapters.length });
  const externalResult = await runExternalPhaseWithEarlyExit(
    externalAdapters,
    intent,
    ctx,
    perSourceTimeoutMs,
    retriesPerSource,
    ownArchiveResult.candidates.length,
    maxTotalCandidates
  );
  logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "external_parallel", candidateCount: externalResult.candidates.length });

  const allCandidates = [...ownArchiveResult.candidates, ...externalResult.candidates];
  const { deduped, duplicateGroups } = dedupeCandidates(allCandidates);
  logRetrievalOrchestrator("dedup_complete", {
    beatId: intent.beatId,
    before: allCandidates.length,
    after: deduped.length,
    duplicateGroups: duplicateGroups.length,
  });

  const sources: RetrievalSourceOutcome[] = [...ownArchiveResult.outcomes, ...externalResult.outcomes];
  const cacheHits = sources.filter((s) => s.cacheHit).length;
  const keywordHits = sources.filter((s) => s.phase !== "own_archive_embedding").reduce((sum, s) => sum + s.candidates.length, 0);

  const pool: CandidatePool = {
    beatId: intent.beatId,
    candidates: deduped,
    duplicateGroups,
    sources,
    stats: {
      startedAt,
      durationMs: Date.now() - start,
      totalCandidatesBeforeDedup: allCandidates.length,
      totalCandidatesAfterDedup: deduped.length,
      cacheHits,
      embeddingHits: ownArchiveResult.embeddingHits,
      keywordHits,
      duplicatesRemoved: allCandidates.length - deduped.length,
      earlyExitTriggered: externalResult.earlyExitTriggered,
    },
  };

  logRetrievalOrchestrator("pool_complete", { beatId: intent.beatId, stats: pool.stats });
  return pool;
}
