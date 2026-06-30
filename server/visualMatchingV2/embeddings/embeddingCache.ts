/** Visual Matching Engine V2 — permanent Embedding Cache (stage 3).
 *  Keyed on (subjectId, model, embeddingVersion) so an embedding is computed at most once
 *  per provider/version regardless of how many times the same subject is processed.
 *  subjectId is either a stable asset id (own archive) or a content hash (ad-hoc text,
 *  e.g. a search query). Backed by the embedding_cache MySQL table; degrades to "no cache"
 *  (always miss) when DATABASE_URL is unset, same pattern as the stage-1 caches. */

import { createEmbeddingCache, getEmbeddingCache } from "../../db";
import { logEmbedding } from "../logging";

export async function getCachedEmbedding(
  subjectId: string,
  model: string,
  embeddingVersion: string
): Promise<number[] | undefined> {
  const row = await getEmbeddingCache(subjectId, model, embeddingVersion);
  if (row) {
    logEmbedding("cache_hit", { subjectId, model, embeddingVersion });
    return row.embedding;
  }
  logEmbedding("cache_miss", { subjectId, model, embeddingVersion });
  return undefined;
}

export async function setCachedEmbedding(
  subjectId: string,
  model: string,
  embeddingVersion: string,
  embedding: number[]
): Promise<void> {
  await createEmbeddingCache({ subjectId, model, embeddingVersion, embedding });
}
