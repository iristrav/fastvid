/** Visual Matching Engine V2 — permanent CLIP embedding cache for the Pre-Filter stage.
 *
 *  Mirrors the on-disk JSON-cache pattern already established by
 *  server/archiveClipEmbedding.ts, but keyed by candidate identity (a hash of whichever
 *  stable identifier the candidate carries — remoteUrl, then localPath, then candidateId)
 *  rather than a numeric archive asset id. This is what lets every source (own_archive,
 *  wikimedia, pexels, pixabay, internet_archive) be cached identically — clipPreFilter.ts
 *  never special-cases own_archive's existing per-asset-id cache in archiveClipEmbedding.ts,
 *  satisfying "CLIP mag niet weten of iets uit eigen archief... komt" without touching
 *  sourceAdapters.ts or the existing active-pipeline cache shape. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { LOCAL_UPLOADS_DIR } from "../storageLocal";

export type StoredCandidateClipEmbedding = {
  cacheKey: string;
  model: string;
  embeddingVersion: string;
  embedding: number[];
  updatedAt: string;
};

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "v2-clip-prefilter-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable per-candidate cache key. remoteUrl/localPath/candidateId identify the same
 *  underlying image across runs even though candidateId itself can vary by source prefix. */
export function clipCacheKeyFor(identity: { remoteUrl: string | null; localPath: string | null; candidateId: string }): string {
  const raw = identity.remoteUrl ?? identity.localPath ?? identity.candidateId;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function indexPath(cacheKey: string): string {
  return path.join(indexDir(), `${cacheKey}.json`);
}

export function loadCachedClipEmbedding(
  cacheKey: string,
  model: string,
  embeddingVersion: string
): number[] | null {
  const p = indexPath(cacheKey);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredCandidateClipEmbedding;
    if (parsed.model !== model || parsed.embeddingVersion !== embeddingVersion) return null;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    return parsed.embedding;
  } catch {
    return null;
  }
}

export function storeCachedClipEmbedding(
  cacheKey: string,
  model: string,
  embeddingVersion: string,
  embedding: number[]
): void {
  const record: StoredCandidateClipEmbedding = {
    cacheKey,
    model,
    embeddingVersion,
    embedding,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(indexPath(cacheKey), JSON.stringify(record));
  } catch {
    // Best-effort cache — a write failure just means this candidate re-embeds next run.
  }
}
