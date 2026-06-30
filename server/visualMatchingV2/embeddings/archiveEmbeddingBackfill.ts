/** Visual Matching Engine V2 — Archive Embedding Backfill (Priority 1).
 *
 *  Fully standalone script. NEVER imported or triggered by any worker startup path
 *  (warmup.ts, server entrypoints, queue workers) — only ever run explicitly:
 *
 *    npm run archive-backfill
 *    tsx server/visualMatchingV2/embeddings/archiveEmbeddingBackfill.ts
 *
 *  As an extra safety net against an accidental import, this script refuses to run unless
 *  VISUAL_MATCHING_V2_ARCHIVE_BACKFILL=true is set explicitly in the environment — so even
 *  `tsx`-ing it by mistake on a worker does nothing.
 *
 *  Incremental: only processes assets that don't already have a current
 *  (provider, model, embeddingVersion) embedding — re-running after the first full pass is
 *  cheap, and switching EMBEDDING_VERSION/EMBEDDING_MODEL leaves old embeddings in place
 *  (different version => different rows => coexists until the next backfill completes).
 *
 *  Writes to two places per asset:
 *   - Qdrant: the vector + a complete payload (title/tags/mediaType/license/source/
 *     thumbnail/duration/width/height/language) so runtime search never needs an extra
 *     MySQL round-trip.
 *   - MySQL (media_archive_asset_embeddings): durable backup / source of truth for
 *     "already embedded" checks, independent of Qdrant's availability. */

import { listActiveMediaArchiveAssetsBatch, getBackfillCursor, setBackfillCursor } from "../../db";
import { storeAssetEmbedding, getAssetIdsWithCurrentEmbedding } from "./assetEmbeddings";
import { buildAssetSemanticDocument } from "./semanticDocumentBuilder";
import { VoyageEmbeddingProvider } from "./voyageProvider";
import { warmupVectorStore } from "./warmup";
import { logEmbedding } from "../logging";
import type { MediaArchiveAsset } from "../../../drizzle/schema";

const EMBEDDING_VERSION = "1";
const PAGE_SIZE = 200;
const PROVIDER_NAME = "voyage";
const JOB_NAME = "archive_embedding_backfill";

function requireBackfillEnabled(): void {
  if (process.env.VISUAL_MATCHING_V2_ARCHIVE_BACKFILL !== "true") {
    console.error(
      "[ArchiveEmbeddingBackfill] Refusing to run: VISUAL_MATCHING_V2_ARCHIVE_BACKFILL is not 'true'.\n" +
        "This is a standalone, explicitly-invoked job — normal workers must never wait on it.\n" +
        "Run it deliberately with:\n" +
        "  VISUAL_MATCHING_V2_ARCHIVE_BACKFILL=true npm run archive-backfill"
    );
    process.exitCode = 1;
    throw new Error("archive-backfill: disabled by default, set VISUAL_MATCHING_V2_ARCHIVE_BACKFILL=true to run");
  }
}

function pointIdFor(asset: MediaArchiveAsset): string {
  return `own_archive:${asset.id}`;
}

function payloadFor(asset: MediaArchiveAsset, provider: string, model: string, embeddingVersion: string): Record<string, unknown> {
  return {
    assetId: asset.id,
    title: asset.title ?? null,
    tags: asset.tags ?? [],
    mediaType: asset.mediaType,
    license: asset.licenseNote ?? null,
    source: asset.sourceNote ?? null,
    thumbnail: null,
    localPath: null,
    duration: asset.durationSec ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    language: null,
    // Mirrors exactly what's stored in MySQL (media_archive_asset_embeddings), so a future
    // migration could be driven entirely from Qdrant without consulting MySQL first.
    provider,
    model,
    embeddingVersion,
    createdAt: new Date().toISOString(),
  };
}

type RunStats = {
  processed: number;
  skipped: number;
  apiErrors: number;
  retries: number;
  totalEmbedMs: number;
  startedAt: number;
};

function logProgress(stats: RunStats, remainingEstimate: number | null): void {
  const elapsedSec = (Date.now() - stats.startedAt) / 1000;
  const perSec = elapsedSec > 0 ? stats.processed / elapsedSec : 0;
  const avgEmbedMs = stats.processed > 0 ? stats.totalEmbedMs / stats.processed : 0;
  logEmbedding("generated", {
    component: "archiveEmbeddingBackfill",
    progress: true,
    processed: stats.processed,
    skipped: stats.skipped,
    apiErrors: stats.apiErrors,
    retries: stats.retries,
    embeddingsPerSec: Number(perSec.toFixed(2)),
    avgEmbedMs: Number(avgEmbedMs.toFixed(1)),
    estimatedRemainingSec: remainingEstimate,
  });
  console.log(
    `[ArchiveEmbeddingBackfill] processed=${stats.processed} skipped=${stats.skipped} ` +
      `errors=${stats.apiErrors} retries=${stats.retries} rate=${perSec.toFixed(2)}/s ` +
      `avgEmbedMs=${avgEmbedMs.toFixed(0)}` +
      (remainingEstimate != null ? ` etaSec=${remainingEstimate.toFixed(0)}` : "")
  );
}

async function run(): Promise<void> {
  requireBackfillEnabled();

  const provider = new VoyageEmbeddingProvider();
  const warm = await warmupVectorStore(provider.dimensions);
  if (!warm.healthy) {
    console.warn(
      `[ArchiveEmbeddingBackfill] Qdrant health check failed at startup (provider=${warm.provider}). ` +
        "Continuing anyway — writes go through ResilientVectorStore, which logs and no-ops on failure " +
        "rather than crashing this run; check Qdrant connectivity if upserts don't show up."
    );
  }

  const alreadyEmbedded = await getAssetIdsWithCurrentEmbedding(PROVIDER_NAME, provider.modelId, EMBEDDING_VERSION);
  const resumeFromId = await getBackfillCursor(JOB_NAME, PROVIDER_NAME, provider.modelId, EMBEDDING_VERSION);
  console.log(
    `[ArchiveEmbeddingBackfill] starting. model=${provider.modelId} version=${EMBEDDING_VERSION} ` +
      `alreadyEmbedded=${alreadyEmbedded.size} resumeFromId=${resumeFromId}`
  );

  const stats: RunStats = { processed: 0, skipped: 0, apiErrors: 0, retries: 0, totalEmbedMs: 0, startedAt: Date.now() };
  let afterId = resumeFromId;
  let totalSeen = 0;

  for (;;) {
    const page = await listActiveMediaArchiveAssetsBatch(afterId, PAGE_SIZE);
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;
    totalSeen += page.length;

    const pending = page.filter((a) => !alreadyEmbedded.has(a.id));
    stats.skipped += page.length - pending.length;
    if (pending.length === 0) {
      logProgress(stats, null);
      continue;
    }

    const documents = pending.map((a) => buildAssetSemanticDocument(a));
    const batchStart = Date.now();
    let embeddings: number[][];
    try {
      embeddings = provider.embedBatch
        ? await provider.embedBatch(documents)
        : await Promise.all(documents.map((d) => provider.embedText(d)));
    } catch (err) {
      stats.apiErrors += 1;
      console.error(`[ArchiveEmbeddingBackfill] batch embed failed for assets ${pending[0].id}..${pending[pending.length - 1].id}:`, (err as Error).message);
      logProgress(stats, null);
      continue;
    }
    stats.totalEmbedMs += Date.now() - batchStart;

    const points = pending.map((asset, i) => ({
      id: pointIdFor(asset),
      vector: embeddings[i],
      payload: payloadFor(asset, PROVIDER_NAME, provider.modelId, EMBEDDING_VERSION),
    }));

    // batchUpsert always goes through the resilient store now, so it degrades (logs + no-op)
    // on a Qdrant outage exactly like every other write here, instead of a bespoke local
    // try/catch around the raw store. ResilientVectorStore.batchUpsert itself forwards to
    // the inner store's native batchUpsert (chunked HTTP, not one request per point).
    await warm.resilientStore.batchUpsert(points);

    for (let i = 0; i < pending.length; i++) {
      try {
        await storeAssetEmbedding(pending[i].id, PROVIDER_NAME, provider.modelId, EMBEDDING_VERSION, embeddings[i]);
        stats.processed += 1;
      } catch (err) {
        stats.apiErrors += 1;
        console.error(`[ArchiveEmbeddingBackfill] MySQL store failed for asset ${pending[i].id}:`, (err as Error).message);
      }
    }

    await setBackfillCursor(JOB_NAME, PROVIDER_NAME, provider.modelId, EMBEDDING_VERSION, afterId);
    logProgress(stats, null);
  }

  console.log(
    `[ArchiveEmbeddingBackfill] done. seen=${totalSeen} processed=${stats.processed} skipped=${stats.skipped} ` +
      `errors=${stats.apiErrors} elapsedSec=${((Date.now() - stats.startedAt) / 1000).toFixed(1)}`
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ArchiveEmbeddingBackfill] fatal:", err);
    process.exit(1);
  });
