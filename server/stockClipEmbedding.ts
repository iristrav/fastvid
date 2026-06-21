/**
 * CLIP frame index for stock clips (Pexels/Pixabay) — reused across videos.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import {
  clipEmbeddingIndexEnabled,
  indexVideoFrameEmbeddings,
  meanEmbedding,
  scoreEmbeddingSimilarity,
  clipSimToScore,
  minLocalClipSimilarity,
} from "./localClipVision";

export type StoredStockClipEmbedding = {
  key: string;
  provider: "pexels" | "pixabay";
  videoId: number;
  model: string;
  embedding: number[];
  frameEmbeddings?: number[][];
  updatedAt: string;
};

export function stockClipEmbeddingEnabled(): boolean {
  if (process.env.ENABLE_STOCK_CLIP_EMBEDDING === "false") return false;
  return clipEmbeddingIndexEnabled();
}

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "stock-clip-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(key: string): string {
  return path.join(indexDir(), `${key.replace(/[^a-zA-Z0-9:_-]/g, "_")}.json`);
}

/** Parse stable stock id from pipeline clip filename. */
export function stockClipKeyFromPath(clipPath: string): string | null {
  const base = path.basename(clipPath);
  const pixMatch = base.match(/(?:^|_)(?:pix|pixabay)_vid(\d+)\.mp4$/i);
  if (pixMatch) return `pixabay:${pixMatch[1]}`;
  const pexMatch = base.match(/_vid(\d+)\.mp4$/i);
  if (pexMatch && !/_pix_/i.test(base)) return `pexels:${pexMatch[1]}`;
  return null;
}

export function loadStoredStockFrameEmbeddings(key: string): number[][] {
  if (!stockClipEmbeddingEnabled()) return [];
  const p = indexPath(key);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredStockClipEmbedding;
    if (Array.isArray(parsed.frameEmbeddings) && parsed.frameEmbeddings.length > 0) {
      return parsed.frameEmbeddings;
    }
    if (Array.isArray(parsed.embedding) && parsed.embedding.length > 0) {
      return [parsed.embedding];
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function loadStoredStockFrameEmbeddingsFromPath(clipPath: string): number[][] {
  const key = stockClipKeyFromPath(clipPath);
  if (!key) return [];
  return loadStoredStockFrameEmbeddings(key);
}

export type StockClipPreRankScore = {
  worstScore10: number;
  bestScore10: number;
  hasEmbeddings: boolean;
  definiteFail: boolean;
};

/** Index raw stock download if missing (enables in-clip offset + pre-rank). */
export async function ensureStockClipIndexed(key: string, localVideoPath: string): Promise<boolean> {
  if (!stockClipEmbeddingEnabled() || !fs.existsSync(localVideoPath)) return false;
  if (loadStoredStockFrameEmbeddings(key).length > 0) return true;
  return indexStockClipEmbedding(key, localVideoPath);
}

/** Non-blocking background index (hot path uses hash offset until cache warm). */
export function scheduleStockClipEmbeddingByKey(key: string, localVideoPath: string): void {
  if (!stockClipEmbeddingEnabled()) return;
  if (loadStoredStockFrameEmbeddings(key).length > 0) return;
  if (pendingKeys.has(key)) return;
  if (!fs.existsSync(localVideoPath)) return;
  pendingKeys.add(key);
  void indexStockClipEmbedding(key, localVideoPath).finally(() => pendingKeys.delete(key));
}

/** Re-order Pexels/Pixabay search hits when cached embeddings match the beat query. */
export function rankStockVideoIdsByEmbedding<
  T extends { id: number; duration?: number },
>(
  videos: T[],
  provider: "pexels" | "pixabay",
  queryEmbedding: number[] | null | undefined,
  minScore10 = 7
): T[] {
  if (!stockClipEmbeddingEnabled() || !queryEmbedding?.length || videos.length < 2) {
    return videos;
  }
  const scored = videos.map((v) => ({
    v,
    pr: scoreStockClipPreRank(`${provider}:${v.id}`, queryEmbedding, minScore10),
  }));
  const withEmb = scored.filter((s) => s.pr.hasEmbeddings && !s.pr.definiteFail);
  const withoutEmb = scored.filter((s) => !s.pr.hasEmbeddings);
  const fails = scored.filter((s) => s.pr.hasEmbeddings && s.pr.definiteFail);
  withEmb.sort((a, b) => b.pr.bestScore10 - a.pr.bestScore10);
  return [...withEmb, ...withoutEmb, ...fails].map((s) => s.v);
}

export function scoreStockClipPreRank(
  key: string,
  queryEmbedding: number[],
  minScore10 = 7
): StockClipPreRankScore {
  const frames = loadStoredStockFrameEmbeddings(key);
  if (!frames.length || !queryEmbedding.length) {
    return { worstScore10: 0, bestScore10: 0, hasEmbeddings: false, definiteFail: false };
  }
  const minSim = minLocalClipSimilarity(minScore10);
  let worst = Infinity;
  let best = 0;
  for (const emb of frames) {
    const sim = scoreEmbeddingSimilarity(queryEmbedding, emb);
    worst = Math.min(worst, sim);
    best = Math.max(best, sim);
  }
  const worstSim = worst === Infinity ? 0 : worst;
  return {
    worstScore10: clipSimToScore(worstSim),
    bestScore10: clipSimToScore(best),
    hasEmbeddings: true,
    definiteFail: worstSim < minSim - 0.04,
  };
}

const pendingKeys = new Set<string>();

/** Index stock clip frames in the background (non-blocking). */
export function scheduleStockClipEmbedding(clipPath: string): void {
  if (!stockClipEmbeddingEnabled()) return;
  const key = stockClipKeyFromPath(clipPath);
  if (!key || pendingKeys.has(key)) return;
  if (loadStoredStockFrameEmbeddings(key).length > 0) return;
  if (!fs.existsSync(clipPath)) return;

  pendingKeys.add(key);
  void indexStockClipEmbedding(key, clipPath).finally(() => pendingKeys.delete(key));
}

export async function indexStockClipEmbedding(key: string, localVideoPath: string): Promise<boolean> {
  if (!stockClipEmbeddingEnabled() || !fs.existsSync(localVideoPath)) return false;
  if (loadStoredStockFrameEmbeddings(key).length > 0) return true;

  const [provider, idStr] = key.split(":");
  const videoId = parseInt(idStr ?? "", 10);
  if (!provider || !videoId || (provider !== "pexels" && provider !== "pixabay")) return false;

  const workDir = path.join(os.tmpdir(), `fv_stock_clip_${provider}_${videoId}`);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const frameEmbeddings = await indexVideoFrameEmbeddings(
      localVideoPath,
      workDir,
      `${provider}${videoId}`
    );
    if (frameEmbeddings.length === 0) return false;

    const embedding = meanEmbedding(frameEmbeddings);
    if (!embedding) return false;

    const record: StoredStockClipEmbedding = {
      key,
      provider,
      videoId,
      model: "Xenova/clip-vit-base-patch32",
      embedding,
      frameEmbeddings,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(indexPath(key), JSON.stringify(record), "utf8");
    console.log(`[StockClipEmbedding] Indexed ${key} (${frameEmbeddings.length} frames)`);
    return true;
  } catch (err) {
    console.warn(`[StockClipEmbedding] ${key}:`, (err as Error).message?.slice(0, 80));
    return false;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
