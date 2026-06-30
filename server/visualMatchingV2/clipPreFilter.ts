/** Visual Matching Engine V2 — CLIP Pre-Filter (funnel stage 2).
 *
 *  VisualIntent -> Retrieval Strategy -> Candidate Pool -> [this] -> top 3-5 candidates.
 *
 *  Scope is deliberately narrow: similarity scoring + top-N selection only. No LLM Vision,
 *  no confidence tiers, no winner. Those belong to the next stage.
 *
 *  Reuses the existing active-pipeline CLIP infrastructure end to end — no second CLIP
 *  implementation:
 *   - server/localClipVision.ts: text/image embedding, pipeline loading, batch embedding.
 *   - server/archiveClipEmbedding.ts: confirms the on-disk permanent-cache pattern this
 *     module mirrors (clipEmbeddingCache.ts) for non-own-archive candidates.
 *
 *  Every source (own_archive, wikimedia, pexels, pixabay, internet_archive) is resolved to
 *  an embeddable local image the same way and goes through the same batch call — nothing
 *  here branches on `candidate.source`. CLIP never sees which source a candidate came from. */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  localVisionEnabled,
  embedTextQuery,
  embedImagesFromPaths,
  scoreEmbeddingSimilarity,
  extractFrameAtFraction,
  buildBeatVisionQueryText,
} from "../localClipVision";
import { clipCacheKeyFor, loadCachedClipEmbedding, storeCachedClipEmbedding } from "./clipEmbeddingCache";
import { recordClipBatchOutcome } from "./clipMetrics";
import { logClipPreFilter } from "./logging";
import type {
  CandidateAsset,
  ClipCandidateOutcome,
  ClipFilterResult,
  ClipFilterTrace,
  ClipPreFilterOptions,
  VisualIntent,
} from "./types";

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const CLIP_EMBEDDING_VERSION = "1";
const DEFAULT_TOP_N = 5;
const MIN_TOP_N = 3;
const FRAME_EXTRACT_FRACTION = 0.4;

type ResolvedImage = {
  imagePath: string;
  /** Set when the file is a temp download/extraction this function must delete afterwards. */
  cleanup: boolean;
};

function tmpDir(): string {
  return os.tmpdir();
}

/** Resolves any candidate (regardless of source) to a single local image file to embed.
 *  Image assets with a local path are used directly; video assets with a local path get
 *  one extracted frame; anything without a local path falls back to downloading
 *  remoteUrl/thumbnail. Returns null when nothing embeddable is available. */
async function resolveCandidateImage(candidate: CandidateAsset): Promise<ResolvedImage | null> {
  if (candidate.localPath && fs.existsSync(candidate.localPath)) {
    if (candidate.assetType === "image") {
      return { imagePath: candidate.localPath, cleanup: false };
    }
    const framePath = path.join(tmpDir(), `fv_v2_clip_${crypto.randomBytes(6).toString("hex")}.jpg`);
    const ok = await extractFrameAtFraction(candidate.localPath, framePath, FRAME_EXTRACT_FRACTION);
    if (ok && fs.existsSync(framePath)) return { imagePath: framePath, cleanup: true };
    return null;
  }

  const remoteImageUrl = candidate.assetType === "image" ? candidate.remoteUrl ?? candidate.thumbnail : candidate.thumbnail;
  if (!remoteImageUrl || !remoteImageUrl.startsWith("http")) return null;

  const tmpPath = path.join(tmpDir(), `fv_v2_clip_dl_${crypto.randomBytes(6).toString("hex")}.jpg`);
  try {
    const resp = await Promise.race([
      fetch(remoteImageUrl, { signal: AbortSignal.timeout(6_000) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 6_000)),
    ]);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) return null;
    fs.writeFileSync(tmpPath, buf);
    return { imagePath: tmpPath, cleanup: true };
  } catch {
    return null;
  }
}

function cleanupResolved(resolved: ResolvedImage | null): void {
  if (!resolved || !resolved.cleanup) return;
  try {
    if (fs.existsSync(resolved.imagePath)) fs.unlinkSync(resolved.imagePath);
  } catch {
    /* ignore */
  }
}

/**
 * Scores `candidates` (already retrieved, deduped, and pool-bounded — never the full
 * unbounded source results) against `intent`'s CLIP text query, and returns the top 3-5 by
 * similarity. Sole entry point for the CLIP Pre-Filter stage.
 */
export async function clipPreFilter(
  intent: VisualIntent,
  candidates: CandidateAsset[],
  options: ClipPreFilterOptions = {}
): Promise<ClipFilterResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const topN = Math.max(MIN_TOP_N, options.topN ?? DEFAULT_TOP_N);
  const minSimilarity = options.minSimilarity ?? 0;

  if (!localVisionEnabled() || candidates.length === 0) {
    const trace: ClipFilterTrace = {
      beatId: intent.beatId,
      startedAt,
      durationMs: Date.now() - start,
      candidateCount: candidates.length,
      batchMode: "sequential",
      batchSize: 0,
      model: CLIP_MODEL,
      embeddingVersion: CLIP_EMBEDDING_VERSION,
      outcomes: [],
      passedCandidateIds: [],
      rejectedCandidateIds: candidates.map((c) => c.candidateId),
      avgSimilarity: null,
      cacheHitRate: 0,
    };
    logClipPreFilter("filter_complete", trace);
    return { passed: [], rejected: candidates, trace };
  }

  const queryText = buildBeatVisionQueryText({ beatText: intent.visualDescription || intent.spokenText, videoTitle: undefined });
  const queryEmbedding = await embedTextQuery(queryText);

  // ─── Resolve cache hits + the set that still needs embedding, uniformly across sources ──
  const cacheKeys = candidates.map((c) => clipCacheKeyFor(c));
  const cachedEmbeddings = cacheKeys.map((key) => loadCachedClipEmbedding(key, CLIP_MODEL, CLIP_EMBEDDING_VERSION));

  const toResolve: { index: number; resolved: ResolvedImage | null }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (cachedEmbeddings[i]) continue;
    toResolve.push({ index: i, resolved: await resolveCandidateImage(candidates[i]) });
  }

  const embeddablePaths = toResolve.filter((r) => r.resolved !== null) as { index: number; resolved: ResolvedImage }[];
  const batchStart = Date.now();
  const { embeddings: freshEmbeddings, mode } =
    embeddablePaths.length > 0
      ? await embedImagesFromPaths(embeddablePaths.map((r) => r.resolved.imagePath))
      : { embeddings: [] as (number[] | null)[], mode: "sequential" as const };
  const batchDurationMs = Date.now() - batchStart;

  for (const r of embeddablePaths) cleanupResolved(r.resolved);

  const finalEmbeddings: (number[] | null)[] = candidates.map((_, i) => cachedEmbeddings[i] ?? null);
  embeddablePaths.forEach((r, j) => {
    finalEmbeddings[r.index] = freshEmbeddings[j] ?? null;
  });

  // Persist freshly computed embeddings to the permanent cache.
  embeddablePaths.forEach((r, j) => {
    const emb = freshEmbeddings[j];
    if (emb) storeCachedClipEmbedding(cacheKeys[r.index], CLIP_MODEL, CLIP_EMBEDDING_VERSION, emb);
  });

  const outcomes: ClipCandidateOutcome[] = [];
  const scored: { candidate: CandidateAsset; similarity: number | null }[] = [];

  let cacheHitCount = 0;
  const perCandidateLatency = embeddablePaths.length > 0 ? batchDurationMs / embeddablePaths.length : 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const embedding = finalEmbeddings[i];
    const wasCacheHit = !!cachedEmbeddings[i];
    if (wasCacheHit) cacheHitCount += 1;

    let similarity: number | null = null;
    let skippedReason: string | null = null;
    const latencyMs = wasCacheHit ? 0 : embedding ? perCandidateLatency : 0;

    if (!queryEmbedding) {
      skippedReason = "no_query_embedding";
    } else if (!embedding) {
      skippedReason = "no_embeddable_image";
    } else {
      similarity = scoreEmbeddingSimilarity(queryEmbedding, embedding);
    }

    outcomes.push({
      candidateId: candidate.candidateId,
      clipSimilarity: similarity,
      clipLatencyMs: latencyMs,
      cacheHit: wasCacheHit,
      skippedReason,
    });

    scored.push({
      candidate: {
        ...candidate,
        clipSimilarity: similarity,
        clipModel: CLIP_MODEL,
        clipEmbeddingVersion: CLIP_EMBEDDING_VERSION,
        clipLatencyMs: latencyMs,
      },
      similarity,
    });
  }

  const eligible = scored.filter((s) => s.similarity !== null && s.similarity >= minSimilarity);
  eligible.sort((a, b) => (b.similarity as number) - (a.similarity as number));
  const passed = eligible.slice(0, topN).map((s) => s.candidate);
  const passedIds = new Set(passed.map((c) => c.candidateId));
  const rejected = scored.filter((s) => !passedIds.has(s.candidate.candidateId)).map((s) => s.candidate);

  const similarities = outcomes.map((o) => o.clipSimilarity).filter((s): s is number => s !== null);
  const avgSimilarity = similarities.length > 0 ? similarities.reduce((a, b) => a + b, 0) / similarities.length : null;
  const cacheHitRate = candidates.length > 0 ? cacheHitCount / candidates.length : 0;

  const trace: ClipFilterTrace = {
    beatId: intent.beatId,
    startedAt,
    durationMs: Date.now() - start,
    candidateCount: candidates.length,
    batchMode: mode,
    batchSize: embeddablePaths.length,
    model: CLIP_MODEL,
    embeddingVersion: CLIP_EMBEDDING_VERSION,
    outcomes,
    passedCandidateIds: passed.map((c) => c.candidateId),
    rejectedCandidateIds: rejected.map((c) => c.candidateId),
    avgSimilarity,
    cacheHitRate,
  };

  recordClipBatchOutcome({
    batchSize: candidates.length,
    durationMs: batchDurationMs,
    similarities,
    cacheHits: cacheHitCount,
  });
  logClipPreFilter("filter_complete", trace);

  return { passed, rejected, trace };
}
