/**
 * Local file-backed text embedding index for archive assets (one-time index, reuse at search — no per-beat asset API calls).
 */
import fs from "fs";
import path from "path";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import { buildAssetSemanticDocument, createTextEmbedding, cosineSimilarityVectors } from "./semanticVisualMatching";

export type StoredAssetEmbedding = {
  assetId: number;
  model: string;
  embedding: number[];
  document: string;
  updatedAt: string;
};

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(assetId: number): string {
  return path.join(indexDir(), `${assetId}.json`);
}

export function archiveEmbeddingIndexEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_EMBEDDING_INDEX !== "false";
}

export function loadStoredAssetEmbedding(assetId: number): StoredAssetEmbedding | null {
  if (!archiveEmbeddingIndexEnabled()) return null;
  const p = indexPath(assetId);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredAssetEmbedding;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Index one asset after upload or retitle — persists embedding to disk. */
export async function indexArchiveAssetEmbedding(asset: {
  id: number;
  title?: string | null;
  tags?: string[] | null;
  sourceNote?: string | null;
}): Promise<boolean> {
  if (!archiveEmbeddingIndexEnabled()) return false;
  const document = buildAssetSemanticDocument(asset);
  const embedding = await createTextEmbedding(document);
  if (!embedding?.length) return false;

  const record: StoredAssetEmbedding = {
    assetId: asset.id,
    model: process.env.SEMANTIC_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    embedding,
    document: document.slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(indexPath(asset.id), JSON.stringify(record));
  return true;
}

/** Score beat vs pre-indexed asset — only one embedding API call (beat side). */
export async function scoreBeatAgainstStoredEmbedding(
  beatDocument: string,
  assetId: number
): Promise<number | null> {
  const stored = loadStoredAssetEmbedding(assetId);
  if (!stored) return null;
  const beatEmb = await createTextEmbedding(beatDocument);
  if (!beatEmb?.length) return null;
  return Math.max(0, cosineSimilarityVectors(beatEmb, stored.embedding));
}
