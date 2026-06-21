/**
 * CLIP-guided in-clip trim start — archive + stock (stored frame embeddings).
 */
import {
  clipEmbeddingIndexEnabled,
  loadStoredFrameEmbeddings,
} from "./archiveClipEmbedding";
import {
  loadStoredStockFrameEmbeddings,
  stockClipEmbeddingEnabled,
} from "./stockClipEmbedding";
import { LOCAL_FRAME_FRACTIONS, scoreEmbeddingSimilarity } from "./localClipVision";
import { archiveVisualMinClipSec } from "./sourcingPolicy";

export function inClipOffsetEnabled(): boolean {
  if (process.env.ENABLE_IN_CLIP_OFFSET === "false") return false;
  return clipEmbeddingIndexEnabled();
}

/** CLIP-guided trim start for Pexels/Pixabay when stock embeddings exist. */
export function stockInClipOffsetEnabled(): boolean {
  if (process.env.ENABLE_STOCK_IN_CLIP_OFFSET === "false") return false;
  return stockClipEmbeddingEnabled();
}

/** Fallback hash offset (matches legacy trimVideoClip behavior). */
export function hashInClipStartSec(sourceDur: number, take: number, clipIndex = 0): number {
  if (sourceDur <= take + 0.35) return 0;
  const slack = sourceDur - take;
  return (clipIndex * 0.41 + 0.15) % slack;
}

/** Pick trim start from indexed frame embeddings + beat query (shared archive/stock logic). */
export function pickInClipStartFromFrameEmbeddings(
  sourceDur: number,
  holdSec: number,
  frameEmbeddings: number[][],
  queryEmbedding: number[] | null | undefined,
  clipIndex = 0
): number {
  const minDur = archiveVisualMinClipSec();
  const take = sourceDur > 0 ? Math.max(minDur, Math.min(holdSec, sourceDur)) : Math.max(minDur, holdSec);
  if (sourceDur <= take + 0.2) return 0;

  const maxStart = Math.max(0, sourceDur - take);
  if (!queryEmbedding?.length || frameEmbeddings.length < 2) {
    return Math.min(maxStart, hashInClipStartSec(sourceDur, take, clipIndex));
  }

  const sampleFractions =
    frameEmbeddings.length >= LOCAL_FRAME_FRACTIONS.length
      ? LOCAL_FRAME_FRACTIONS
      : frameEmbeddings.map((_, i) =>
          frameEmbeddings.length === 1 ? 0.38 : i / Math.max(1, frameEmbeddings.length - 1)
        );

  let bestFrac = sampleFractions[0] ?? 0.38;
  let bestSim = -1;
  for (let i = 0; i < frameEmbeddings.length; i++) {
    const emb = frameEmbeddings[i]!;
    const sim = scoreEmbeddingSimilarity(queryEmbedding, emb);
    if (sim > bestSim) {
      bestSim = sim;
      bestFrac = sampleFractions[Math.min(i, sampleFractions.length - 1)] ?? bestFrac;
    }
  }

  const idealStart = bestFrac * sourceDur - take * 0.32;
  return Math.max(0, Math.min(maxStart, idealStart));
}

/**
 * Pick trim start so the hold window aligns with the best-matching indexed frame.
 * Uses stored frame embeddings (no extra FFmpeg at pick time).
 */
export function pickInClipStartSec(
  sourceDur: number,
  holdSec: number,
  assetId: number,
  queryEmbedding: number[] | null | undefined,
  clipIndex = 0
): number {
  if (!inClipOffsetEnabled()) {
    const minDur = archiveVisualMinClipSec();
    const take = sourceDur > 0 ? Math.max(minDur, Math.min(holdSec, sourceDur)) : Math.max(minDur, holdSec);
    const maxStart = Math.max(0, sourceDur - take);
    return Math.min(maxStart, hashInClipStartSec(sourceDur, take, clipIndex));
  }
  return pickInClipStartFromFrameEmbeddings(
    sourceDur,
    holdSec,
    loadStoredFrameEmbeddings(assetId),
    queryEmbedding,
    clipIndex
  );
}

/** Stock clip trim start via cached Pexels/Pixabay frame embeddings (`pexels:123`). */
export function pickStockInClipStartSec(
  sourceDur: number,
  holdSec: number,
  stockKey: string,
  queryEmbedding: number[] | null | undefined,
  clipIndex = 0
): number {
  const minDur = archiveVisualMinClipSec();
  const take = sourceDur > 0 ? Math.max(minDur, Math.min(holdSec, sourceDur)) : Math.max(minDur, holdSec);
  const maxStart = Math.max(0, sourceDur - take);
  if (!stockInClipOffsetEnabled()) {
    return Math.min(maxStart, hashInClipStartSec(sourceDur, take, clipIndex));
  }
  return pickInClipStartFromFrameEmbeddings(
    sourceDur,
    holdSec,
    loadStoredStockFrameEmbeddings(stockKey),
    queryEmbedding,
    clipIndex
  );
}
