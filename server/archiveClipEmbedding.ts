/**
 * Optional local CLIP embeddings for archive frames (@xenova/transformers).
 * Off by default — enable with ENABLE_CLIP_EMBEDDING_INDEX=true.
 */
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import { cosineSimilarityVectors } from "./semanticVisualMatching";

const exec = promisify(execCb);

export type StoredClipEmbedding = {
  assetId: number;
  model: string;
  embedding: number[];
  updatedAt: string;
};

let clipPipeline: Awaited<ReturnType<typeof loadClipPipeline>> | null = null;

async function loadClipPipeline() {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
}

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-clip-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(assetId: number): string {
  return path.join(indexDir(), `${assetId}.json`);
}

export function clipEmbeddingIndexEnabled(): boolean {
  return process.env.ENABLE_CLIP_EMBEDDING_INDEX === "true";
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

async function extractFrameJpeg(videoPath: string, outPath: string): Promise<boolean> {
  try {
    await exec(
      `"${ffmpegBin()}" -y -ss 1.5 -i "${videoPath}" -vframes 1 -q:v 3 "${outPath}"`,
      { timeout: 20_000 }
    );
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 2000;
  } catch {
    return false;
  }
}

async function getClipPipeline() {
  if (!clipEmbeddingIndexEnabled()) return null;
  if (!clipPipeline) {
    try {
      clipPipeline = await loadClipPipeline();
    } catch (err) {
      console.warn("[ClipEmbedding] Failed to load @xenova/transformers:", (err as Error).message?.slice(0, 80));
      return null;
    }
  }
  return clipPipeline;
}

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

/** Index one archive video frame with CLIP (background-safe). */
export async function indexArchiveClipEmbedding(
  assetId: number,
  localVideoPath: string
): Promise<boolean> {
  if (!clipEmbeddingIndexEnabled() || !fs.existsSync(localVideoPath)) return false;
  const pipe = await getClipPipeline();
  if (!pipe) return false;

  const framePath = path.join(indexDir(), `_frame_${assetId}.jpg`);
  try {
    const ok = await extractFrameJpeg(localVideoPath, framePath);
    if (!ok) return false;

    const result = await pipe(framePath);
    const embedding = Array.from((result as { data: Float32Array }).data);
    if (embedding.length < 8) return false;

    const record: StoredClipEmbedding = {
      assetId,
      model: "Xenova/clip-vit-base-patch32",
      embedding,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(indexPath(assetId), JSON.stringify(record), "utf8");
    return true;
  } catch (err) {
    console.warn(`[ClipEmbedding] asset ${assetId}:`, (err as Error).message?.slice(0, 80));
    return false;
  } finally {
    try {
      if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
    } catch {
      /* ignore */
    }
  }
}

/** Text query → CLIP text embedding for similarity against stored frame embeddings. */
export async function createClipTextEmbedding(query: string): Promise<number[] | null> {
  if (!clipEmbeddingIndexEnabled() || !query.trim()) return null;
  try {
    const { pipeline } = await import("@xenova/transformers");
    const textPipe = await pipeline("feature-extraction", "Xenova/clip-vit-base-patch32");
    const result = await textPipe(query, { pooling: "mean", normalize: true });
    return Array.from(result.data as Float32Array);
  } catch {
    return null;
  }
}

export async function scoreAssetClipSimilarity(
  assetId: number,
  queryEmbedding: number[]
): Promise<number> {
  const stored = loadStoredClipEmbedding(assetId);
  if (!stored || queryEmbedding.length === 0) return 0;
  const sim = cosineSimilarityVectors(queryEmbedding, stored.embedding);
  return Math.round(Math.max(0, sim) * 100);
}
