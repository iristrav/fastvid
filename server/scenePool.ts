/**
 * Scene Candidate Pool — P1 optimisation.
 *
 * Performs ONE retrieval round per scene (not per beat) and returns a pool
 * of metadata-only candidates.  No downloads happen here.  Downloads occur
 * only after a winner is selected (P2 / download-after-selection).
 *
 * Entry point: buildSceneCandidatePool(request) → SceneCandidatePool
 *
 * Pipeline contract
 * ─────────────────
 *  1. Build pool   → buildSceneCandidatePool()   [all API calls happen here]
 *  2. Select beat  → selectCandidatesFromPool()   [no API calls]
 *  3. Download     → caller (videoPipeline.ts)    [only the winner]
 *
 * Feature flag: ENABLE_SCENE_CANDIDATE_POOL=true (off by default).
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getCandidatePool, putCandidatePool } from "./sceneCandidateCache";
import type { CachedCandidate, CandidateSource } from "./sceneCandidateCache";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_CANDIDATES_PER_SOURCE = 25;
export const MAX_POOL_SIZE = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PoolCandidateSource = "pexels" | "pixabay" | "wikimedia" | "archive";

/** Metadata-only representation of one retrieval candidate.
 *  No binary data, no local paths, no presigned URLs that may expire (except
 *  remoteUrl which callers should treat as best-effort).
 *  Ranking score slots are null until filled by P2 / V2 ranking. */
export type PoolCandidate = {
  /** Stable dedup key: `${source}:${assetId}`. */
  id: string;
  /** Provider-specific stable identifier (Pexels video id, Wikimedia title, etc.). */
  assetId: string;
  source: PoolCandidateSource;

  // ── Retrieval metadata ──────────────────────────────────────────────────────
  /** Direct download URL.  For Pexels this may be a presigned CDN URL. */
  remoteUrl: string;
  /** Thumbnail URL suitable for CLIP scoring without a full download.
   *  Null when the provider does not expose a thumbnail URL. */
  thumbnailUrl: string | null;
  title: string;
  description: string | null;
  /** Space-separated or array of topical tags from the provider. */
  tags: string[];
  mediaType: "video" | "image";
  /** Clip duration in seconds; null for static images. */
  durationSec: number | null;
  /** SPDX-style license string or provider label ("pexels-free", "cc-by", etc.). */
  license: string | null;
  /** Video/image width in pixels; null when unknown. */
  width: number | null;
  /** Video/image height in pixels; null when unknown. */
  height: number | null;

  // ── Ranking score slots (filled by P2 / V2 — null until then) ───────────────
  clipSimilarity: number | null;
  embeddingSimilarity: number | null;
  rankingScore: number | null;
  visionScore: number | null;
  selectionScore: number | null;
};

export type PoolMetrics = {
  retrievalLatencyMs: number;
  cacheHit: boolean;
  /** Number of API calls issued per provider (0 on cache hit). */
  apiCallsPerProvider: Record<string, number>;
  candidatesBeforeDedup: number;
  candidatesAfterDedup: number;
  candidatesAfterLimit: number;
  poolSize: number;
  /** Rough estimate: candidates × 400 bytes. */
  estimatedMemoryBytes: number;
};

export type SceneCandidatePool = {
  sceneIndex: number;
  sceneText: string;
  /** Queries used to populate the pool. */
  queries: string[];
  candidates: PoolCandidate[];
  metrics: PoolMetrics;
};

export type BuildPoolRequest = {
  sceneIndex: number;
  sceneText: string;
  /** Primary search query (e.g. scene.visualCue or powerWord). */
  primaryQuery: string;
  /** Additional queries (pexelsQueries, brollQueries, etc.). */
  extraQueries?: string[];
  pexelsApiKey?: string;
  pixabayApiKey?: string;
  /** If true, skip Pexels (no API key or not applicable). */
  skipPexels?: boolean;
  /** If true, skip Pixabay. */
  skipPixabay?: boolean;
  maxPerSource?: number;
  maxTotal?: number;
};

// ─── Deduplication ───────────────────────────────────────────────────────────

function dedupCandidates(candidates: PoolCandidate[]): PoolCandidate[] {
  const seen = new Set<string>();
  const urlSeen = new Set<string>();
  const out: PoolCandidate[] = [];
  for (const c of candidates) {
    // Dedup on stable id first
    if (seen.has(c.id)) continue;
    // Dedup on canonical URL (normalised: strip query params for image URLs)
    const canonUrl = c.remoteUrl.split("?")[0].toLowerCase();
    if (urlSeen.has(canonUrl)) continue;
    seen.add(c.id);
    urlSeen.add(canonUrl);
    out.push(c);
  }
  return out;
}

// ─── Provider: Pexels ────────────────────────────────────────────────────────

async function searchPexelsCandidates(
  queries: string[],
  apiKey: string,
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<number>();

  for (const query of queries) {
    if (candidates.length >= max) break;
    const perPage = Math.min(15, max - candidates.length + 5);
    const url =
      `https://api.pexels.com/videos/search` +
      `?query=${encodeURIComponent(query)}&per_page=${perPage}` +
      `&size=large&orientation=landscape&min_duration=4`;
    try {
      const resp = await withTimeoutFetch(url, { Authorization: apiKey }, 10_000, `Pexels pool "${query}"`);
      apiCalls++;
      if (!resp.ok) continue;
      type PexelsVideo = {
        id: number;
        duration: number;
        image?: string;
        url?: string;
        video_files: Array<{ width: number; height: number; link: string }>;
      };
      const data = (await resp.json()) as { videos?: PexelsVideo[] };
      for (const v of data.videos ?? []) {
        if (candidates.length >= max) break;
        if (seenIds.has(v.id)) continue;
        if (v.duration < 3) continue;
        const bestFile =
          v.video_files.filter(f => f.width <= 1920).sort((a, b) => b.width - a.width)[0] ??
          v.video_files.sort((a, b) => a.width - b.width)[0];
        if (!bestFile?.link) continue;
        seenIds.add(v.id);
        candidates.push({
          id: `pexels:${v.id}`,
          assetId: String(v.id),
          source: "pexels",
          remoteUrl: bestFile.link,
          thumbnailUrl: v.image ?? null,
          title: v.url ?? query,
          description: null,
          tags: [query],
          mediaType: "video",
          durationSec: v.duration,
          license: "pexels-free",
          width: bestFile.width,
          height: bestFile.height,
          clipSimilarity: null,
          embeddingSimilarity: null,
          rankingScore: null,
          visionScore: null,
          selectionScore: null,
        });
      }
    } catch {
      /* network error — skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: Pixabay ───────────────────────────────────────────────────────

async function searchPixabayCandidates(
  queries: string[],
  apiKey: string,
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<number>();

  for (const query of queries) {
    if (candidates.length >= max) break;
    const url =
      `https://pixabay.com/api/videos/` +
      `?key=${apiKey}&q=${encodeURIComponent(query)}` +
      `&per_page=10&video_type=film&min_width=1280&safesearch=true`;
    try {
      const resp = await withTimeoutFetch(url, {}, 10_000, `Pixabay pool "${query}"`);
      apiCalls++;
      if (!resp.ok) continue;
      type PixVideo = {
        id: number;
        duration: number;
        tags?: string;
        videos: {
          large?: { url: string; width: number; height: number };
          medium?: { url: string; width: number; height: number };
          small?: { url: string; width: number; height: number };
        };
      };
      const data = (await resp.json()) as { hits?: PixVideo[] };
      for (const v of data.hits ?? []) {
        if (candidates.length >= max) break;
        if (seenIds.has(v.id)) continue;
        if (v.duration < 3) continue;
        const file = v.videos.large ?? v.videos.medium ?? v.videos.small;
        if (!file?.url) continue;
        seenIds.add(v.id);
        candidates.push({
          id: `pixabay:${v.id}`,
          assetId: String(v.id),
          source: "pixabay",
          remoteUrl: file.url,
          thumbnailUrl: null,
          title: (v.tags ?? query).split(",")[0].trim() || query,
          description: v.tags ?? null,
          tags: (v.tags ?? "").split(",").map(t => t.trim()).filter(Boolean),
          mediaType: "video",
          durationSec: v.duration,
          license: "pixabay-free",
          width: file.width,
          height: file.height,
          clipSimilarity: null,
          embeddingSimilarity: null,
          rankingScore: null,
          visionScore: null,
          selectionScore: null,
        });
      }
    } catch {
      /* skip */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: Wikimedia ─────────────────────────────────────────────────────

async function searchWikimediaCandidates(
  queries: string[],
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenTitles = new Set<string>();
  const UA = { "User-Agent": "Fastvid/1.0 (video generation)" };

  for (const query of queries) {
    if (candidates.length >= max) break;
    const searchUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=10&format=json&origin=*`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, UA, 5_000, `Wikimedia pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      const searchData = (await searchResp.json()) as {
        query?: { search?: Array<{ title: string }> };
      };
      const titles = searchData.query?.search?.map(r => r.title) ?? [];

      for (const title of titles) {
        if (candidates.length >= max) break;
        if (seenTitles.has(title)) continue;
        const infoUrl =
          `https://commons.wikimedia.org/w/api.php?action=query` +
          `&titles=${encodeURIComponent(title)}&prop=imageinfo` +
          `&iiprop=url|mime|size|extmetadata&format=json&origin=*`;
        try {
          const infoResp = await withTimeoutFetch(infoUrl, UA, 5_000, `Wikimedia pool info "${title}"`);
          apiCalls++;
          if (!infoResp.ok) continue;
          type WikiInfoPage = {
            imageinfo?: Array<{
              url: string;
              mime: string;
              size: number;
              extmetadata?: { LicenseShortName?: { value: string }; ImageDescription?: { value: string } };
            }>;
          };
          const infoData = (await infoResp.json()) as {
            query?: { pages?: Record<string, WikiInfoPage> };
          };
          const page = Object.values(infoData.query?.pages ?? {})[0];
          const info = page?.imageinfo?.[0];
          if (!info?.url) continue;
          if (!info.mime.startsWith("image/jpeg") && !info.mime.startsWith("image/png")) continue;
          if (info.size < 10_000) continue;
          seenTitles.add(title);
          const license = info.extmetadata?.LicenseShortName?.value ?? null;
          const desc = info.extmetadata?.ImageDescription?.value
            ? info.extmetadata.ImageDescription.value.replace(/<[^>]+>/g, "").slice(0, 200)
            : null;
          // Wikimedia supports thumbnail resizing via URL param
          const thumbUrl = info.url.includes("?")
            ? null
            : `${info.url}?width=640`;
          candidates.push({
            id: `wikimedia:${encodeURIComponent(title)}`,
            assetId: title,
            source: "wikimedia",
            remoteUrl: info.url,
            thumbnailUrl: thumbUrl,
            title,
            description: desc,
            tags: [query],
            mediaType: "image",
            durationSec: null,
            license,
            width: null,
            height: null,
            clipSimilarity: null,
            embeddingSimilarity: null,
            rankingScore: null,
            visionScore: null,
            selectionScore: null,
          });
        } catch {
          /* skip this title */
        }
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── CachedCandidate ↔ PoolCandidate bridge ──────────────────────────────────

function toCachedCandidate(c: PoolCandidate): CachedCandidate {
  return {
    assetId: c.assetId,
    title: c.title,
    url: c.remoteUrl,
    thumbnailUrl: c.thumbnailUrl,
    contentType: c.mediaType === "video" ? "video/mp4" : "image/jpeg",
    durationSec: c.durationSec,
    meta: {
      source: c.source,
      tags: c.tags,
      license: c.license,
      width: c.width,
      height: c.height,
      description: c.description,
    },
  };
}

function fromCachedCandidate(c: CachedCandidate, source: PoolCandidateSource): PoolCandidate {
  const meta = c.meta as Record<string, unknown>;
  return {
    id: `${source}:${c.assetId}`,
    assetId: c.assetId,
    source,
    remoteUrl: c.url ?? "",
    thumbnailUrl: c.thumbnailUrl,
    title: c.title,
    description: (meta.description as string | null) ?? null,
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    mediaType: c.contentType.startsWith("video") ? "video" : "image",
    durationSec: c.durationSec,
    license: (meta.license as string | null) ?? null,
    width: (meta.width as number | null) ?? null,
    height: (meta.height as number | null) ?? null,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    visionScore: null,
    selectionScore: null,
  };
}

// ─── Internal fetch helper (no videoPipeline dependency) ─────────────────────

async function withTimeoutFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    throw new Error(`${label} timeout/error: ${(err as Error).message?.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main: buildSceneCandidatePool ───────────────────────────────────────────

export async function buildSceneCandidatePool(
  req: BuildPoolRequest
): Promise<SceneCandidatePool> {
  const {
    sceneIndex,
    sceneText,
    primaryQuery,
    extraQueries = [],
    pexelsApiKey,
    pixabayApiKey,
    skipPexels = false,
    skipPixabay = false,
    maxPerSource = MAX_CANDIDATES_PER_SOURCE,
    maxTotal = MAX_POOL_SIZE,
  } = req;

  const queries = Array.from(new Set([primaryQuery, ...extraQueries].filter(Boolean)));
  const t0 = Date.now();
  const apiCallsPerProvider: Record<string, number> = {};

  // ── 1. Scene candidate cache check ──────────────────────────────────────────
  // Cache is keyed on the primary query — check each source that would be used.
  // On a full cache hit we skip ALL provider API calls for this scene.
  // Pexels URLs are presigned CDN URLs that expire quickly — not cacheable in the scene candidate cache.
  // Only Pixabay and Wikimedia have stable URLs worth caching per query.
  const sources: CandidateSource[] = [];
  if (!skipPixabay && pixabayApiKey) sources.push("pixabay");
  sources.push("wikimedia");

  let fromCache = true;
  const cachedRaw: PoolCandidate[] = [];
  for (const src of sources) {
    const hit = await getCandidatePool(primaryQuery, src);
    if (!hit) { fromCache = false; break; }
    cachedRaw.push(...hit.map(c => fromCachedCandidate(c, src as PoolCandidateSource)));
    apiCallsPerProvider[src] = 0;
  }

  if (fromCache && cachedRaw.length > 0) {
    const deduped = dedupCandidates(cachedRaw).slice(0, maxTotal);
    const latencyMs = Date.now() - t0;
    return {
      sceneIndex,
      sceneText,
      queries,
      candidates: deduped,
      metrics: {
        retrievalLatencyMs: latencyMs,
        cacheHit: true,
        apiCallsPerProvider,
        candidatesBeforeDedup: cachedRaw.length,
        candidatesAfterDedup: deduped.length,
        candidatesAfterLimit: deduped.length,
        poolSize: deduped.length,
        estimatedMemoryBytes: deduped.length * 400,
      },
    };
  }

  // ── 2. Live retrieval — parallel across providers ─────────────────────────
  const tasks: Promise<{ candidates: PoolCandidate[]; apiCalls: number; source: string }>[] = [];

  if (!skipPexels && pexelsApiKey) {
    tasks.push(
      searchPexelsCandidates(queries, pexelsApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pexels",
      }))
    );
  }
  if (!skipPixabay && pixabayApiKey) {
    tasks.push(
      searchPixabayCandidates(queries, pixabayApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pixabay",
      }))
    );
  }
  tasks.push(
    searchWikimediaCandidates(queries, maxPerSource).then(r => ({
      ...r,
      source: "wikimedia",
    }))
  );

  const results = await Promise.allSettled(tasks);

  const rawCandidates: PoolCandidate[] = [];
  for (const result of results) {
    if (result.status === "rejected") continue;
    const { candidates, apiCalls, source } = result.value;
    apiCallsPerProvider[source] = apiCalls;
    rawCandidates.push(...candidates);

    // Populate scene candidate cache per source (best-effort).
    // Pexels URLs expire quickly — skip caching for pexels.
    if (candidates.length > 0 && (source === "wikimedia" || source === "pixabay" || source === "archive")) {
      void putCandidatePool(
        primaryQuery,
        source as CandidateSource,
        candidates.map(toCachedCandidate)
      );
    }
  }

  const candidatesBeforeDedup = rawCandidates.length;
  const deduped = dedupCandidates(rawCandidates);
  const candidatesAfterDedup = deduped.length;
  const limited = deduped.slice(0, maxTotal);

  const latencyMs = Date.now() - t0;
  console.log(
    `[ScenePool] Scene ${sceneIndex}: ${limited.length} candidates ` +
    `(${candidatesBeforeDedup} raw → ${candidatesAfterDedup} deduped → ${limited.length} capped) ` +
    `in ${latencyMs}ms | calls: ${Object.entries(apiCallsPerProvider).map(([k, v]) => `${k}=${v}`).join(", ")}`
  );

  return {
    sceneIndex,
    sceneText,
    queries,
    candidates: limited,
    metrics: {
      retrievalLatencyMs: latencyMs,
      cacheHit: false,
      apiCallsPerProvider,
      candidatesBeforeDedup,
      candidatesAfterDedup,
      candidatesAfterLimit: limited.length,
      poolSize: limited.length,
      estimatedMemoryBytes: limited.length * 400,
    },
  };
}

// ─── Beat selection from pool ─────────────────────────────────────────────────

/**
 * Returns up to `count` candidates from the pool that best match the beat.
 * Scoring: exact keyword overlap on title + tags. Returns highest-scoring
 * candidates first (or all candidates if pool is small).
 * No API calls — pure in-memory selection.
 */
export function selectCandidatesFromPool(
  beatText: string,
  powerWord: string,
  keywords: string[],
  pool: SceneCandidatePool,
  count = 5
): PoolCandidate[] {
  if (pool.candidates.length === 0) return [];

  const beatTokens = Array.from(new Set(
    [powerWord, ...keywords, ...beatText.toLowerCase().split(/\s+/)]
      .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(t => t.length > 2)
  ));

  const scored = pool.candidates.map(c => {
    const candidateTokens = [
      ...c.title.toLowerCase().split(/\s+/),
      ...c.tags.flatMap(t => t.toLowerCase().split(/\s+/)),
      ...(c.description ?? "").toLowerCase().split(/\s+/),
    ].map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length > 2);

    let score = 0;
    for (const token of beatTokens) {
      if (candidateTokens.includes(token)) score += 1;
    }
    // Power word match is worth extra
    const pwLower = powerWord.toLowerCase();
    if (c.title.toLowerCase().includes(pwLower)) score += 3;
    if (c.tags.some(t => t.toLowerCase().includes(pwLower))) score += 2;

    return { candidate: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map(s => s.candidate);
}

// ─── P2: Thumbnail-first CLIP ranking ────────────────────────────────────────

/**
 * Downloads thumbnail images for the given candidates (parallel, bounded),
 * runs CLIP embedding on each, and returns the same candidates sorted by
 * `clipSimilarity` descending.  Mutates `clipSimilarity` in-place on each
 * candidate so the score is available to downstream code.
 *
 * Candidates without a `thumbnailUrl`, or whose thumbnail fails to download/
 * embed, keep their original keyword-based order (clipSimilarity stays null).
 * Best-effort: never throws.
 *
 * Requires ENABLE_LOCAL_VISION != false (checked by caller).
 */
export async function rankCandidatesByThumbnailClip(
  candidates: PoolCandidate[],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  sceneIndex: number,
  beatIndex: number
): Promise<PoolCandidate[]> {
  if (candidates.length === 0) return candidates;

  let embedImageFromPath: (p: string) => Promise<number[] | null>;
  let resolveBeatQueryEmbedding: (b: string, v?: string, t?: string) => Promise<number[] | null>;
  let scoreEmbeddingSimilarity: (a: number[], b: number[]) => number;
  try {
    // Dynamic import to avoid circular deps and keep scenePool.ts standalone
    const vision = await import("./localClipVision");
    embedImageFromPath = vision.embedImageFromPath;
    resolveBeatQueryEmbedding = vision.resolveBeatQueryEmbedding;
    scoreEmbeddingSimilarity = vision.scoreEmbeddingSimilarity;
  } catch {
    return candidates;
  }

  const beatEmb = await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle).catch(() => null);
  if (!beatEmb) return candidates;

  const tmpDir = os.tmpdir();
  const MAX_THUMB_CONCURRENT = 5;

  const downloadThumb = async (candidate: PoolCandidate): Promise<void> => {
    if (!candidate.thumbnailUrl) return;
    const ext = candidate.thumbnailUrl.includes(".png") ? ".png" : ".jpg";
    const tmpPath = path.join(
      tmpDir,
      `pool_thumb_s${sceneIndex}_b${beatIndex}_${candidate.assetId.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}${ext}`
    );
    try {
      // Download thumbnail
      const resp = await withTimeoutFetch(candidate.thumbnailUrl, {}, 12_000, `thumb ${candidate.id}`);
      if (!resp.ok) return;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1_000) return;
      fs.writeFileSync(tmpPath, buf);

      // CLIP embed
      const emb = await embedImageFromPath(tmpPath);
      if (!emb) return;
      const sim = scoreEmbeddingSimilarity(beatEmb, emb);
      candidate.clipSimilarity = sim;
    } catch {
      // best-effort
    } finally {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  };

  // Process in batches of MAX_THUMB_CONCURRENT
  for (let i = 0; i < candidates.length; i += MAX_THUMB_CONCURRENT) {
    await Promise.allSettled(candidates.slice(i, i + MAX_THUMB_CONCURRENT).map(downloadThumb));
  }

  // Rerank: scored first (by clipSimilarity desc), then unscored (preserve keyword order)
  const scored = candidates.filter(c => c.clipSimilarity !== null);
  const unscored = candidates.filter(c => c.clipSimilarity === null);
  scored.sort((a, b) => (b.clipSimilarity ?? 0) - (a.clipSimilarity ?? 0));

  console.log(
    `[Pool P2] Scene ${sceneIndex} beat ${beatIndex}: CLIP-ranked ${scored.length}/${candidates.length} candidates` +
    (scored.length > 0 ? ` (top sim=${scored[0].clipSimilarity?.toFixed(3)})` : "")
  );

  return [...scored, ...unscored];
}
