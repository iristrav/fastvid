/** Visual Matching Engine V2 — Semantic Own-Archive Search Provider (Priority 1).
 *  Builds the `EmbeddingSearchProvider` the Retrieval Orchestrator's embedding group calls
 *  for own-archive semantic search. Wires VoyageEmbeddingProvider to a Qdrant-backed
 *  `ResilientVectorStore`, so a Qdrant outage degrades silently to zero embedding hits
 *  instead of throwing — the orchestrator's keyword group is unaffected either way, and the
 *  Strategy Engine's `fast` mode never calls this at all.
 *
 *  Qdrant payloads written by the backfill (see archiveEmbeddingBackfill.ts) carry enough
 *  asset metadata that hits map straight to a CandidateAsset without an extra MySQL query —
 *  see candidateFromEmbeddingHit() in retrievalOrchestrator.ts, which reads exactly the
 *  fields written here. */

import { warmupVectorStore } from "./warmup";
import { VoyageEmbeddingProvider } from "./voyageProvider";
import { EmbeddingSearchEngine } from "./embeddingSearchEngine";
import type { EmbeddingSearchProvider } from "../types";

let cached: Promise<EmbeddingSearchProvider> | null = null;

async function buildProvider(): Promise<EmbeddingSearchProvider> {
  const embeddingProvider = new VoyageEmbeddingProvider();
  const warm = await warmupVectorStore(embeddingProvider.dimensions);
  const engine = new EmbeddingSearchEngine(embeddingProvider, warm.resilientStore);
  return {
    search: (queryText: string, topK: number) => engine.search(queryText, topK),
  };
}

/** Lazily constructs and caches the semantic own-archive search provider for the process
 *  lifetime — Qdrant/health-manager warmup runs at most once, on first real use, never at
 *  module import time and never at plain worker startup unless something actually calls
 *  this. */
export function getSemanticOwnArchiveSearchProvider(): Promise<EmbeddingSearchProvider> {
  if (!cached) cached = buildProvider();
  return cached;
}

/** Qdrant payload fields the backfill writes for every asset, matched 1:1 by
 *  candidateFromEmbeddingHit() in retrievalOrchestrator.ts — keep these two in sync. */
export type ArchiveAssetVectorPayload = {
  assetId: number;
  title: string | null;
  tags: string[];
  mediaType: "video" | "image";
  license: string | null;
  source: string | null;
  thumbnail: string | null;
  localPath: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  language: string | null;
};
