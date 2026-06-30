/** Visual Matching Engine V2 — Retrieval Orchestrator.
 *  Pure executor: receives a fully-resolved `RetrievalStrategy` and a `VisualIntent`, then
 *  dispatches every source in `strategy.sources[]` uniformly, handles early exit, runs
 *  deduplication, and assembles a `CandidatePool`. Contains NO strategic decisions — no
 *  if/else about which sources to use, which timeouts to apply, whether to enable
 *  embeddings, or how many candidates to collect. All of that is determined by the Strategy
 *  Engine before this is called, and there is no hardcoded knowledge here of "semantic" vs.
 *  "keyword" — every source (including the own-archive embedding source) is resolved to a
 *  uniform SourceAdapter and dispatched through the same searchOneSourceWithRetry() call.
 *
 *  Execution model (driven entirely by strategy.sources[]):
 *   - Phase 1 (own archive): every source plan whose phase starts with "own_archive_" runs
 *     concurrently (Promise.all) — there may be a metadata/keyword plan, an embedding plan,
 *     both, or neither, entirely as decided by the Strategy Engine.
 *   - Phase 2 (external parallel): sources with phase "external_parallel" all start
 *     simultaneously; if strategy.allowEarlyExit, the Orchestrator stops awaiting
 *     remaining ones once the pool is full. If strategy.allowFallback is false and the
 *     archive phase already met maxCandidates, phase 2 is skipped entirely.
 *   - Deduplication (dedup.ts) runs once across all phases and merges (not drops) candidates
 *     that resolve to the same underlying asset via different retrieval paths.
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
  RetrievalSourcePhase,
  RetrievalStrategy,
  SourceAdapter,
  SourceAdapterSearchCtx,
  SourcePlan,
  VisualIntent,
} from "./types";

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
    retrievalReasons: ["semantic"],
    retrievalSources: [{ source: "own_archive_embedding", score: hit.similarity }],
    fetchedAt: new Date().toISOString(),
    clipSimilarity: null,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    rankingScore: null,
    rankingBreakdown: null,
  };
}

// ─── Uniform adapter resolution ────────────────────────────────────────────────

/** Resolves any SourcePlan (including the own-archive embedding phase) to a uniform
 *  SourceAdapter, so the Orchestrator's dispatch loop never special-cases retrieval paths.
 *  The embedding phase is wrapped as a synthetic adapter whose `search()` calls the
 *  embeddingSearch provider and maps hits through candidateFromEmbeddingHit — everything
 *  downstream of this function treats it exactly like any other adapter. */
function resolvePlanAdapter(
  plan: SourcePlan,
  embeddingSearch: EmbeddingSearchProvider | undefined,
  overrides?: Partial<Record<CandidateSource, SourceAdapter>>
): SourceAdapter | undefined {
  if (plan.phase === "own_archive_embedding") {
    if (!embeddingSearch) return undefined;
    return {
      name: "own_archive",
      supportsPreEmbedding: true,
      async search(intent: VisualIntent) {
        const queryText = searchQueryFromIntent(intent);
        const { hits } = await embeddingSearch.search(queryText, plan.maxCandidates);
        return hits.map((h) => candidateFromEmbeddingHit(h, queryText));
      },
    };
  }
  if (overrides?.[plan.source]) return overrides[plan.source];
  if (plan.source === "own_archive") return defaultOwnArchiveAdapter;
  return ALL_SOURCE_ADAPTERS.find((a) => a.name === plan.source);
}

// ─── Generic dispatch ───────────────────────────────────────────────────────────

/** Dispatches a group of SourcePlans concurrently through the exact same uniform call,
 *  regardless of phase. The only per-plan distinction is the cache-key discriminator
 *  (plan.phase), which prevents two plans sharing an adapter name (e.g. own_archive
 *  keyword vs. own_archive embedding) from colliding on the same cached search result. */
async function runPlanGroup(
  plans: SourcePlan[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  strategy: RetrievalStrategy,
  embeddingSearch: EmbeddingSearchProvider | undefined,
  adapterOverrides: RetrievalOrchestratorOptions["adapterOverrides"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[] }> {
  const resolvable = plans
    .map((plan) => ({ plan, adapter: resolvePlanAdapter(plan, embeddingSearch, adapterOverrides) }))
    .filter((x): x is { plan: SourcePlan; adapter: SourceAdapter } => !!x.adapter);

  const results = await Promise.all(
    resolvable.map(async ({ plan, adapter }) => {
      logRetrievalOrchestrator("phase_start", { beatId: intent.beatId, phase: plan.phase, source: plan.source });
      const outcome = await searchOneSourceWithRetry(adapter, intent, ctx, plan.timeoutMs, strategy.retriesPerSource, {
        phase: plan.phase,
      });
      return { ...outcome, phase: plan.phase, skippedForEarlyExit: false } as RetrievalSourceOutcome;
    })
  );

  const candidates = results.flatMap((r) => r.candidates);
  return { outcomes: results, candidates };
}

async function runArchivePhase(
  archivePlans: SourcePlan[],
  embeddingPlans: SourcePlan[],
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx,
  strategy: RetrievalStrategy,
  embeddingSearch: EmbeddingSearchProvider | undefined,
  adapterOverrides: RetrievalOrchestratorOptions["adapterOverrides"]
): Promise<{ outcomes: RetrievalSourceOutcome[]; candidates: CandidateAsset[] }> {
  const metadataPlans = strategy.enableMetadataSearch ? archivePlans : [];
  const semanticPlans = strategy.enableEmbedding ? embeddingPlans : [];

  const { outcomes, candidates } = await runPlanGroup(
    [...metadataPlans, ...semanticPlans],
    intent,
    ctx,
    strategy,
    embeddingSearch,
    adapterOverrides
  );

  logRetrievalOrchestrator("phase_complete", { beatId: intent.beatId, phase: "own_archive", candidateCount: candidates.length });
  return { outcomes, candidates };
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
    .map((plan) => ({ plan, adapter: resolvePlanAdapter(plan, undefined, adapterOverrides) }))
    .filter((x): x is { plan: SourcePlan; adapter: SourceAdapter } => !!x.adapter);

  const pending: Pending[] = resolvable.map(({ plan, adapter }) => ({
    plan,
    adapter,
    promise: searchOneSourceWithRetry(adapter, intent, ctx, plan.timeoutMs, strategy.retriesPerSource, {
      phase: plan.phase,
    }).then((outcome) => ({ ...outcome, phase: "external_parallel" as const, skippedForEarlyExit: false })),
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

// ─── Metrics helpers ────────────────────────────────────────────────────────────

function avgDurationFor(sources: RetrievalSourceOutcome[], phase: RetrievalSourcePhase): number {
  const matches = sources.filter((s) => s.phase === phase && !s.skippedForEarlyExit);
  if (matches.length === 0) return -1;
  return matches.reduce((sum, s) => sum + s.durationMs, 0) / matches.length;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/** Executes the given strategy for the given intent. Contains no retrieval decisions —
 *  every source distinction comes from strategy.sources[] and is resolved generically. */
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
  const dedupStart = Date.now();
  const { deduped, duplicateGroups, mergeCount } = dedupeCandidates(allCandidates);
  const dedupLatencyMs = Date.now() - dedupStart;
  logRetrievalOrchestrator("dedup_complete", { beatId: intent.beatId, before: allCandidates.length, after: deduped.length, mergeCount });

  const sources: RetrievalSourceOutcome[] = [...archiveResult.outcomes, ...externalResult.outcomes];
  const cacheHits = sources.filter((s) => s.cacheHit).length;
  const keywordHits = sources.filter((s) => s.phase !== "own_archive_embedding").reduce((sum, s) => sum + s.candidates.length, 0);
  const embeddingHits = sources.filter((s) => s.phase === "own_archive_embedding").reduce((sum, s) => sum + s.candidates.length, 0);

  const semanticCount = deduped.filter((c) => c.retrievalReasons.includes("semantic")).length;
  const keywordCount = deduped.filter((c) => c.retrievalReasons.includes("keyword")).length;

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
      embeddingHits,
      keywordHits,
      duplicatesRemoved: allCandidates.length - deduped.length,
      earlyExitTriggered: externalResult.earlyExitTriggered,
      avgEmbeddingLatencyMs: avgDurationFor(sources, "own_archive_embedding"),
      avgQdrantSearchLatencyMs: avgDurationFor(sources, "own_archive_embedding"),
      avgKeywordLatencyMs: avgDurationFor(sources, "own_archive_metadata"),
      avgSemanticLatencyMs: avgDurationFor(sources, "own_archive_embedding"),
      dedupLatencyMs,
      mergeCount,
      semanticHitRate: deduped.length > 0 ? semanticCount / deduped.length : 0,
      keywordHitRate: deduped.length > 0 ? keywordCount / deduped.length : 0,
    },
  };

  logRetrievalOrchestrator("pool_complete", { beatId: intent.beatId, mode: strategy.mode, stats: pool.stats });
  return pool;
}
