/** Visual Matching Engine V2 — SourceAdapter framework.
 *  Uniform interface over every visual source so the (future) Candidate Fetcher can treat
 *  them identically and new sources can be added by implementing one adapter, with no
 *  changes elsewhere. For stage 1, adapters wrap the existing battle-tested fetch
 *  functions as-is (still doing search+download together) — nothing about how those
 *  functions behave is changed. Not wired into the active pipeline yet — gated by
 *  visualMatchingV2SourceAdaptersEnabled() in sourcingPolicy.ts. */

import {
  fetchInternetArchiveClips,
  fetchPexelsClips,
  fetchPixabayClips,
  fetchWikimediaImages,
} from "../videoPipeline";
import { fetchCuratedArchiveBeatClip, type CuratedBeatContext, type CuratedSceneContext } from "../curatedMediaSourcing";
import { logSourceAdapter } from "./logging";
import type { CandidateAsset, SourceAdapter, SourceAdapterSearchCtx, VisualIntent } from "./types";

function searchQueryFromIntent(intent: VisualIntent): string {
  return intent.primaryKeyword || intent.visualDescription || intent.visualSubject;
}

async function withAdapterLogging<T extends CandidateAsset[]>(
  source: SourceAdapter["name"],
  intent: VisualIntent,
  fn: () => Promise<T>
): Promise<T> {
  logSourceAdapter("search_start", { source, beatId: intent.beatId });
  const start = Date.now();
  try {
    const result = await fn();
    logSourceAdapter("search_result", {
      source,
      beatId: intent.beatId,
      count: result.length,
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    logSourceAdapter("error", {
      source,
      beatId: intent.beatId,
      duration_ms: Date.now() - start,
      error: (err as Error).message,
    });
    return [] as unknown as T;
  }
}

function normalizeCandidate(
  partial: Pick<CandidateAsset, "candidateId" | "source" | "assetType" | "localPath" | "remoteUrl" | "metadata">,
  searchQuery: string,
  retrievalMethod: CandidateAsset["retrievalMethod"] = "search"
): CandidateAsset {
  return {
    candidateId: partial.candidateId,
    source: partial.source,
    assetType: partial.assetType,
    title: null,
    description: null,
    tags: [],
    thumbnail: null,
    localPath: partial.localPath ?? null,
    remoteUrl: partial.remoteUrl ?? null,
    metadata: partial.metadata,
    searchQuery,
    retrievalMethod,
    language: null,
    license: null,
    attribution: null,
    width: null,
    height: null,
    duration: null,
    mimeType: null,
    originalSource: null,
    downloadTimeMs: null,
    embeddingSimilarity: null,
    keywordScore: null,
    retrievalReason: "keyword",
    fetchedAt: new Date().toISOString(),
  };
}

export const ownArchiveAdapter: SourceAdapter = {
  name: "own_archive",
  supportsPreEmbedding: true,
  async search(intent, ctx) {
    return withAdapterLogging("own_archive", intent, async () => {
      const beatCtx: CuratedBeatContext = {
        keywords: [intent.primaryKeyword, intent.secondaryKeyword].filter(Boolean),
        text: intent.spokenText,
        index: 0,
        visualDescription: intent.visualDescription,
      };
      const sceneCtx: CuratedSceneContext = { text: intent.spokenText };
      const path = await fetchCuratedArchiveBeatClip(
        beatCtx,
        sceneCtx,
        ctx.workDir,
        ctx.sceneIndex,
        5,
        new Set<number>(),
        new Set<string>()
      );
      if (!path) return [];
      return [
        normalizeCandidate(
          {
            candidateId: `own_archive:${path}`,
            source: "own_archive",
            assetType: "video",
            localPath: path,
            remoteUrl: null,
            metadata: { path },
          },
          searchQueryFromIntent(intent)
        ),
      ];
    });
  },
};

export const wikimediaAdapter: SourceAdapter = {
  name: "wikimedia",
  supportsPreEmbedding: false,
  async search(intent, ctx) {
    return withAdapterLogging("wikimedia", intent, async () => {
      const query = searchQueryFromIntent(intent);
      const paths = await fetchWikimediaImages(query, 5, ctx.workDir, ctx.sceneIndex, ctx.count ?? 5);
      return paths.map((p): CandidateAsset =>
        normalizeCandidate(
          { candidateId: `wikimedia:${p}`, source: "wikimedia", assetType: "image", localPath: p, remoteUrl: null, metadata: { path: p } },
          query
        )
      );
    });
  },
};

export const pexelsAdapter: SourceAdapter = {
  name: "pexels",
  supportsPreEmbedding: false,
  async search(intent, ctx) {
    return withAdapterLogging("pexels", intent, async () => {
      const query = searchQueryFromIntent(intent);
      const paths = await fetchPexelsClips(query, 5, ctx.workDir, ctx.sceneIndex, ctx.count ?? 5);
      return paths.map((p): CandidateAsset =>
        normalizeCandidate(
          { candidateId: `pexels:${p}`, source: "pexels", assetType: "video", localPath: p, remoteUrl: null, metadata: { path: p } },
          query
        )
      );
    });
  },
};

export const pixabayAdapter: SourceAdapter = {
  name: "pixabay",
  supportsPreEmbedding: false,
  async search(intent, ctx) {
    return withAdapterLogging("pixabay", intent, async () => {
      const query = searchQueryFromIntent(intent);
      const paths = await fetchPixabayClips(query, 5, ctx.workDir, ctx.sceneIndex, ctx.count ?? 5);
      return paths.map((p): CandidateAsset =>
        normalizeCandidate(
          { candidateId: `pixabay:${p}`, source: "pixabay", assetType: "video", localPath: p, remoteUrl: null, metadata: { path: p } },
          query
        )
      );
    });
  },
};

export const internetArchiveAdapter: SourceAdapter = {
  name: "internet_archive",
  supportsPreEmbedding: false,
  async search(intent, ctx) {
    return withAdapterLogging("internet_archive", intent, async () => {
      const query = searchQueryFromIntent(intent);
      const candidates = await fetchInternetArchiveClips(query, 5, ctx.workDir, ctx.sceneIndex, ctx.count ?? 5);
      return candidates.map((c): CandidateAsset =>
        normalizeCandidate(
          {
            candidateId: `internet_archive:${JSON.stringify(c).slice(0, 64)}`,
            source: "internet_archive",
            assetType: "video",
            localPath: c.path ?? null,
            remoteUrl: null,
            metadata: c,
          },
          query
        )
      );
    });
  },
};

export const ALL_SOURCE_ADAPTERS: SourceAdapter[] = [
  ownArchiveAdapter,
  wikimediaAdapter,
  pexelsAdapter,
  pixabayAdapter,
  internetArchiveAdapter,
];

/** Runs every adapter in parallel for one beat. Not yet called by the active pipeline. */
export async function fetchAllCandidates(
  intent: VisualIntent,
  ctx: SourceAdapterSearchCtx
): Promise<CandidateAsset[]> {
  const results = await Promise.all(ALL_SOURCE_ADAPTERS.map((adapter) => adapter.search(intent, ctx)));
  return results.flat();
}
