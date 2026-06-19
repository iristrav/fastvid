/**
 * Background CLIP frame index for archive assets (via localClipVision).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import {
  clipEmbeddingIndexEnabled,
  indexVideoFrameEmbeddings,
  meanEmbedding,
  embedTextQuery,
  scoreEmbeddingSimilarity,
} from "./localClipVision";

export type StoredClipEmbedding = {
  assetId: number;
  model: string;
  embedding: number[];
  frameEmbeddings?: number[][];
  updatedAt: string;
};

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-clip-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(assetId: number): string {
  return path.join(indexDir(), `${assetId}.json`);
}

export { clipEmbeddingIndexEnabled };

export function loadStoredClipEmbedding(assetId: number): StoredClipEmbedding | null {
  if (!clipEmbeddingIndexEnabled()) return null;
  const p = indexPath(assetId);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredClipEmbedding;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadStoredFrameEmbeddings(assetId: number): number[][] {
  const stored = loadStoredClipEmbedding(assetId);
  if (!stored) return [];
  if (Array.isArray(stored.frameEmbeddings) && stored.frameEmbeddings.length > 0) {
    return stored.frameEmbeddings;
  }
  return [stored.embedding];
}

/** Index archive video frames with CLIP in the background after upload. */
export async function indexArchiveClipEmbedding(
  assetId: number,
  localVideoPath: string
): Promise<boolean> {
  if (!clipEmbeddingIndexEnabled() || !fs.existsSync(localVideoPath)) return false;

  const workDir = path.join(os.tmpdir(), `fv_clip_idx_${assetId}`);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const frameEmbeddings = await indexVideoFrameEmbeddings(
      localVideoPath,
      workDir,
      `a${assetId}`
    );
    if (frameEmbeddings.length === 0) return false;

    const embedding = meanEmbedding(frameEmbeddings);
    if (!embedding) return false;

    const record: StoredClipEmbedding = {
      assetId,
      model: "Xenova/clip-vit-base-patch32",
      embedding,
      frameEmbeddings,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(indexPath(assetId), JSON.stringify(record), "utf8");
    console.log(`[ClipEmbedding] Indexed asset ${assetId} (${frameEmbeddings.length} frames)`);
    const { scheduleAuditForAsset } = await import("./clipBackgroundAuditor");
    scheduleAuditForAsset(assetId);
    return true;
  } catch (err) {
    console.warn(`[ClipEmbedding] asset ${assetId}:`, (err as Error).message?.slice(0, 80));
    return false;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      if (localVideoPath.includes(os.tmpdir()) && fs.existsSync(localVideoPath)) {
        fs.unlinkSync(localVideoPath);
      }
    } catch {
      /* ignore */
    }
  }
}

export async function createClipTextEmbedding(query: string): Promise<number[] | null> {
  return embedTextQuery(query);
}

export async function scoreAssetClipSimilarity(
  assetId: number,
  queryEmbedding: number[]
): Promise<number> {
  const frames = loadStoredFrameEmbeddings(assetId);
  if (!frames.length || queryEmbedding.length === 0) return 0;
  let best = 0;
  for (const emb of frames) {
    best = Math.max(best, scoreEmbeddingSimilarity(queryEmbedding, emb));
  }
  return Math.round(best * 100);
}
