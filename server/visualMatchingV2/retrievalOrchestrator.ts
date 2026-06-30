/** Visual Matching Engine V2 — Retrieval Orchestrator.
 *  Pure executor: receives a fully-resolved `RetrievalStrategy` and a `VisualIntent`, then
 *  dispatches adapters, handles early exit, runs deduplication, and assembles a
 *  `CandidatePool`. Contains NO strategic decisions — no if/else about which sources to
 *  use, which timeouts to apply, whether to enable embeddings, or how many candidates to
 *  collect. All of that is determined by the Strategy Engine before this is called.
 *
 *  Execution model (driven entirely by the strategy):
 *   - Phase 1 (own archive): sources with phase "own_archive_metadata" run via keyword
 *     search; if strategy.enableEmbedding and an embeddingSearch provider is supplied,
 *     sources with phase "own_archive_embedding" run in parallel.
 *   - Phase 2 (external parallel): sources with phase "external_parallel" all start
 *     simultaneously; if strategy.allowEarlyExit, the Orchestrator stops awaiting
 *     remaining ones once the pool is full. If strategy.allowFallback is false and the
 *     archive phase already met maxCandidates, phase 2 is skipped entirely.
 *   - Deduplication (dedup.ts) runs once across all phases.
 *
 *  Returns only a CandidatePool — no scoring, selection, CLIP, or LLM.
 *  Gated by visualMatchingV2RetrievalOrchestratorEnabled(); not called from the active
 *  pipeline yet. */

import { searchOneSourceWithRetry } from "./candidateFetcher";
import { dedupeCandidates } from "./dedup";
import { ALL_SOURCE_ADAPTERS, ownArchiveAdapter as defaultOwnArchiveAdapter } from "./sourceAdapters";
import { logRetrievalOrchestrator } from "./logging";
import type {
  CandidateAsset,
  CandidatePool,
  CandidateSource,
  EmbeddingSearchProvider,
  RetrievalOrchestratorOptions,
  RetrievalSourceOutcome,
  RetrievalStrategy,
  SourceAdapter,
  SourceAdapterSearchCtx,
  SourcePlan,
  VisualIntent,
} from "./types";

// ─── Adapter registry ─────────────────────────────────────────────────────────

/** Maps a source name to its adapter instance. The orchestrator resolves strategy
 *  SourcePlan names to real adapters here — this is the only registry lookup; no other
 *  decision about which source to use. */
function resolveAdapter(
  source: CandidateSource,
  overrides?: Partial<Record<CandidateSource, SourceAdapter>>
): SourceAdapter | undefined {
  if (overrides?.[source]) return overrides[source];
  if (source === "own_archive") return defaultOwnArchiveAdapter;
  return ALL_SOURCE_ADAPTERS.find((a) => a.name === source);
}

// ─── Candidate mapping ────────────────────────────────────────────────────────

function searchQueryFromIntent(intent: VisualIntent): string {
  return intent.primaryKeyword || intent.visualDescription || intent.visualSubject;
}

function candidateFromEmbeddingHit(
  hit: { id: string; similarity: number; metadata?: Record<string, unknown> },
  searchQuery: string
): CandidateAsset {
  const metadata = hit.metadata ?? {};
  return {
    candidateId: `own_archive:embedding:${hit.id}`,
    source: "own_archive",
    assetType: ((metadata.assetType as string) ?? (metadata.mediaType as string) ?? "video") as CandidateAsset["assetType"],
    title: (metadata.title as string) ?? null,
    description: (metadata.description as string) ?? null,
    tags: (metadata.tags as string[]) ?? [],
    thumbnail: (metadata.thumbnail as string) ?? null,
    localPath: (metadata.localPath as string) ?? (metadata.path as string) ?? null,
    remoteUrl: (metadata.remoteUrl as string) ?? null,
    metadata,
    searchQuery,
    retrievalMethod: "search",
    language: (metadata.language as string) ?? null,
    license: (metadata.license as string) ?? null,
    attribution: (metadata.attribution as string) ?? null,
    width: (metadata.width as number) ?? null,
    height: (metadata.height as number) ?? null,
    duration: (metadata.duration as number) ?? null,
    mimeType: (metadata.mimeType as string) ?? null,
    originalSource: (metadata.originalSource as string) ?? (metadata.source as string) ?? null,
    downloadTimeMs: null,
    embeddingSimilarity: hit.similarity,
    keywordScore: null,
    retrievalReason: "semantic",
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Phase executors ──────────────────────────────────────────────────────────

/** Runs the keyword/metadata sources for the own-archive phase. Sequential across sources
 *  within this group (today there's only ever one: own_archive), but this whole group runs
 *  concurrently with the embedding group below — see runArchivePhase. */
async function runKeywordGroup(
  archivePlans: SourcePlan[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  strategy: RetrievalStrategy,
  adapterOverrides: RetrievalOrchestratorOptions["adapterOverrides"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[] }> {
  const outcomes: RetrievalSourceOutcome[] = [];
  const candidates: CandidateAsset[] = [];
  if (!strategy.enableMetadataSearch) return { outcomes, candidates };

  for (const plan of archivePlans) {
    const adapter = resolveAdapter(plan.source, adapterOverrides);
    if (!adapter) continue;
    logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "own_archive_metadata", source: plan.source });
    const outcome = await searchOneSourceWithRetry(adapter, intent, ctx, plan.timeoutMs, strategy.retriesPerSource);
    outcomes.push({ ...outcome, phase: "own_archive_metadata", skippedForEarlyExit: false });
    candidates.push(...outcome.candidates);
  }
  return { outcomes, candidates };
}

/** Runs the semantic/embedding search for the own-archive phase. Never throws — a failed
 *  or unavailable vector store (already degraded to an empty result by ResilientVectorStore
 *  upstream of embeddingSearch) just yields zero embedding candidates, so this phase can
 *  never block or fail the pipeline. Runs concurrently with runKeywordGroup. */
async function runEmbeddingGroup(
  embeddingPlans: SourcePlan[],
  intent: VisualIntent,
  strategy: RetrievalStrategy,
  embeddingSearch: EmbeddingSearchProvider | undefined
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; embeddingHits: number }> {
  if (!strategy.enableEmbedding || !embeddingSearch || embeddingPlans.length === 0) {
    return { outcomes: [], candidates: [], embeddingHits: 0 };
  }

  logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "own_archive_embedding" });
  const start = Date.now();
  const queryText = searchQueryFromIntent(intent);
  try {
    const { hits, cacheHit } = await embeddingSearch.search(queryText, embeddingPlans[0]?.maxCandidates ?? 10);
    const embCandidates = hits.map((h) => candidateFromEmbeddingHit(h, queryText));
    return {
      outcomes: [
        {
          source: "own_archive",
          candidates: embCandidates,
          durationMs: Date.now() - start,
          cacheHit,
          timedOut: false,
          retries: 0,
          error: null,
          phase: "own_archive_embedding",
          skippedForEarlyExit: false,
        },
      ],
      candidates: embCandidates,
      embeddingHits: hits.length,
    };
  } catch (err) {
    logRetrievalOrchestrator("error", { beatId: intent.beatId, phase: "own_archive_embedding", error: (err as Error).message });
    return {
      outcomes: [
        {
          source: "own_archive",
          candidates: [],
          durationMs: Date.now() - start,
          cacheHit: false,
          timedOut: false,
          retries: 0,
          error: (err as Error).message,
          phase: "own_archive_embedding",
          skippedForEarlyExit: false,
        },
      ],
      candidates: [],
      embeddingHits: 0,
    };
  }
}

/** Own-archive phase: keyword/metadata search and semantic/embedding search run in
 *  parallel (never one waiting on the other), per the Strategy Engine's per-mode plan —
 *  in "fast" mode the strategy simply produces no embedding SourcePlan, so this group is a
 *  no-op there; every other mode that enables embedding runs both groups concurrently and
 *  lets dedup reconcile overlapping results afterward. Embedding failures never block or
 *  fail keyword results, and vice versa. */
async function runArchivePhase(
  archivePlans: SourcePlan[],
  embeddingPlans: SourcePlan[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  strategy: RetrievalStrategy,
  embeddingSearch: EmbeddingSearchProvider | undefined,
  adapterOverrides: RetrievalOrchestratorOptions["adapterOverrides"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; embeddingHits: number }> {
  const [keywordResult, embeddingResult] = await Promise.all([
    runKeywordGroup(archivePlans, intent, ctx, strategy, adapterOverrides),
    runEmbeddingGroup(embeddingPlans, intent, strategy, embeddingSearch),
  ]);

  const outcomes = [...keywordResult.outcomes, ...embeddingResult.outcomes];
  const candidates = [...keywordResult.candidates, ...embeddingResult.candidates];

  logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "own_archive", candidateCount: candidates.length });
  return { outcomes, candidates, embeddingHits: embeddingResult.embeddingHits };
}

async function runExternalPhase(
  externalPlans: SourcePlan[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  strategy: RetrievalStrategy,
  existingCount: number,
  adapterOverrides: RetrievalOrchestratorOptions["adapterOverrides"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; earlyExitTriggered: boolean }> {
  type Pending = { plan: SourcePlan; adapter: SourceAdapter; promise: Promise<RetrievalSourceOutcome> };

  const resolvable = externalPlans
    .map((plan) => ({ plan, adapter: resolveAdapter(plan.source, adapterOverrides) }))
    .filter((x): x is { plan: SourcePlan; adapter: SourceAdapter } => !!x.adapter);

  const pending: Pending[] = resolvable.map(({ plan, adapter }) => ({
    plan,
    adapter,
    promise: searchOneSourceWithRetry(adapter, intent, ctx, plan.timeoutMs, strategy.retriesPerSource).then(
      (outcome) => ({ ...outcome, phase: "external_parallel" as const, skippedForEarlyExit: false })
    ),
  }));

  const settled: RetrievalSourceOutcome[] = [];
  const collected: CandidateAsset[] = [];
  let remaining = [...pending];
  let earlyExitTriggered = false;

  while (remaining.length > 0) {
    if (strategy.allowEarlyExit && existingCount + collected.length >= strategy.maxCandidates) {
      earlyExitTriggered = true;
      for (const r of remaining) {
        settled.push({
          source: r.plan.source,
          candidates: [],
          durationMs: 0,
          cacheHit: false,
          timedOut: false,
          retries: 0,
          error: null,
          phase: "external_parallel",
          skippedForEarlyExit: true,
        });
        logRetrievalOrchestrator("early_exit", { beatId: intent.beatId, skippedSource: r.plan.source });
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

// ─── Public entry point ───────────────────────────────────────────────────────

/** Executes the given strategy for the given intent. Contains no retrieval decisions. */
export async function retrieveCandidatePool(
  intent: VisualIntent,
  options: RetrievalOrchestratorOptions
): Promise<CandidatePool> {
  const { strategy, embeddingSearch, adapterOverrides } = options;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const ctx: SourceAdapterSearchCtx = { workDir: options.workDir, sceneIndex: options.sceneIndex, count: options.count };

  const archivePlans = strategy.sources.filter((s) => s.phase === "own_archive_metadata").sort((a, b) => a.priority - b.priority);
  const embeddingPlans = strategy.sources.filter((s) => s.phase === "own_archive_embedding");
  const externalPlans = strategy.sources.filter((s) => s.phase === "external_parallel").sort((a, b) => a.priority - b.priority);

  logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "own_archive", mode: strategy.mode });
  const archiveResult = await runArchivePhase(archivePlans, embeddingPlans, intent, ctx, strategy, embeddingSearch, adapterOverrides);

  let externalResult: { outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[]; earlyExitTriggered: boolean } = {
    outcomes: [],
    candidates: [],
    earlyExitTriggered: false,
  };

  const skipExternal = !strategy.allowFallback && archiveResult.candidates.length >= strategy.maxCandidates;
  if (externalPlans.length > 0 && !skipExternal) {
    logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: "external_parallel", sourceCount: externalPlans.length });
    externalResult = await runExternalPhase(externalPlans, intent, ctx, strategy, archiveResult.candidates.length, adapterOverrides);
    logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "external_parallel", candidateCount: externalResult.candidates.length });
  } else if (skipExternal) {
    logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "external_parallel", skipped: true, reason: "archive_sufficient_no_fallback" });
  }

  const allCandidates = [...archiveResult.candidates, ...externalResult.candidates];
  const { deduped, duplicateGroups } = dedupeCandidates(allCandidates);
  logRetrievalOrchestrator("dedup_complete", { beatId: intent.beatId, before: allCandidates.length, after: deduped.length });

  const sources: RetrievalSourceOutcome[] = [...archiveResult.outcomes, ...externalResult.outcomes];
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
      embeddingHits: archiveResult.embeddingHits,
      keywordHits,
      duplicatesRemoved: allCandidates.length - deduped.length,
      earlyExitTriggered: externalResult.earlyExitTriggered,
    },
  };

  logRetrievalOrchestrator("pool_complete", { beatId: intent.beatId, mode: strategy.mode, stats: pool.stats });
  return pool;
}
