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

export type PoolCandidateSource =
  | "pexels"
  | "pixabay"
  | "wikimedia"
  | "archive"
  | "internet_archive"
  | "europeana";

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
  /** Creator/uploader/photographer name, when the provider exposes one. */
  sourceCreator: string | null;
  /** A real license deed/rights URL, when the provider exposes one (distinct from
   *  `license`, which is a label like "pexels-free" or "CC BY-SA 4.0", not a URL). */
  licenseUrl: string | null;

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
  /** FASE 2: Europeana requires a key, like Pexels/Pixabay — Internet Archive/Wikimedia don't. */
  europeanaApiKey?: string;
  /** If true, skip Pexels (no API key or not applicable). */
  skipPexels?: boolean;
  /** If true, skip Pixabay. */
  skipPixabay?: boolean;
  /** If true, skip Internet Archive. */
  skipInternetArchive?: boolean;
  /** If true, skip Europeana (also skipped automatically when europeanaApiKey is absent). */
  skipEuropeana?: boolean;
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
        user?: { name?: string };
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
          sourceCreator: v.user?.name?.trim() || null,
          licenseUrl: null,
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
        user?: string;
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
          sourceCreator: v.user?.trim() || null,
          licenseUrl: null,
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
              extmetadata?: {
                LicenseShortName?: { value: string };
                ImageDescription?: { value: string };
                LicenseUrl?: { value: string };
                Artist?: { value: string };
              };
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
          const licenseUrl = info.extmetadata?.LicenseUrl?.value ?? null;
          const sourceCreator = info.extmetadata?.Artist?.value
            ? info.extmetadata.Artist.value.replace(/<[^>]+>/g, "").trim().slice(0, 256) || null
            : null;
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
            sourceCreator,
            licenseUrl,
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

// ─── Provider: Internet Archive (FASE 2 — Priority A historical source) ───────

// Duplicated (not imported) from videoPipeline.ts's isAllowedInternetArchiveLicense: pure,
// dependency-free logic, and scenePool.ts deliberately avoids importing from videoPipeline.ts
// to avoid a circular dependency (videoPipeline.ts already imports from scenePool.ts). Keep
// this in sync with the original if its license rules ever change.
export function isAllowedInternetArchiveLicensePool(
  licenseUrl: string | undefined | null,
  rights?: string | undefined | null
): boolean {
  const u = licenseUrl?.trim().toLowerCase();
  if (u) {
    if (u.includes("publicdomain")) return true;
    if (u.includes("creativecommons.org/licenses/")) {
      if (u.includes("-nc") || u.includes("-nd")) return false;
      if (u.includes("/by/") || u.includes("/by-sa/")) return true;
    }
    return false;
  }
  const r = rights?.trim().toLowerCase();
  if (!r) return false;
  if (r.includes("-nc") || r.includes("-nd") || /non.?commercial|no derivative/.test(r)) return false;
  return /public domain|no known copyright|no copyright restrictions/.test(r);
}

async function searchInternetArchiveCandidates(
  queries: string[],
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<string>();
  const UA = { "User-Agent": "Fastvid/1.0 (video generation)" };

  for (const query of queries) {
    if (candidates.length >= max) break;
    const searchUrl =
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies` +
      `&fl[]=identifier,title&rows=10&output=json`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, UA, 8_000, `Internet Archive pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      const searchData = (await searchResp.json()) as {
        response?: { docs?: Array<{ identifier: string; title: string }> };
      };
      const docs = searchData.response?.docs ?? [];

      for (const doc of docs) {
        if (candidates.length >= max) break;
        if (seenIds.has(doc.identifier)) continue;
        try {
          const metaUrl = `https://archive.org/metadata/${doc.identifier}`;
          const metaResp = await withTimeoutFetch(metaUrl, UA, 8_000, `Internet Archive pool metadata "${doc.identifier}"`);
          apiCalls++;
          if (!metaResp.ok) continue;
          type IaMetaData = {
            metadata?: {
              licenseurl?: string | string[];
              rights?: string | string[];
            };
            files?: Array<{ name: string; format: string; size?: string }>;
          };
          const metaData = (await metaResp.json()) as IaMetaData;
          const rawLicenseUrl = metaData.metadata?.licenseurl;
          const licenseUrlRaw = (Array.isArray(rawLicenseUrl) ? rawLicenseUrl[0] : rawLicenseUrl)?.trim();
          const rawRights = metaData.metadata?.rights;
          const rights = (Array.isArray(rawRights) ? rawRights[0] : rawRights)?.trim();
          if (!isAllowedInternetArchiveLicensePool(licenseUrlRaw, rights)) continue;

          const videoFiles = (metaData.files ?? []).filter(f =>
            ["h.264", "MPEG4", "MP4", "Ogg Video", "WebM"].includes(f.format)
          );
          if (!videoFiles.length) continue;
          const videoFile = videoFiles.sort(
            (a, b) => parseInt(a.size || "999999999") - parseInt(b.size || "999999999")
          )[0];
          const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
          const knownSize = parseInt(videoFile.size || "0");
          if (knownSize > MAX_ARCHIVE_SIZE) continue;

          seenIds.add(doc.identifier);
          candidates.push({
            id: `internet_archive:${doc.identifier}`,
            assetId: doc.identifier,
            source: "internet_archive",
            remoteUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(videoFile.name)}`,
            // Stable, documented archive.org thumbnail convention — no extra API call needed.
            thumbnailUrl: `https://archive.org/services/img/${doc.identifier}`,
            title: doc.title,
            description: null,
            tags: [query],
            mediaType: "video",
            durationSec: null,
            license: licenseUrlRaw ?? rights ?? null,
            width: null,
            height: null,
            sourceCreator: null,
            licenseUrl: licenseUrlRaw ?? null,
            clipSimilarity: null,
            embeddingSimilarity: null,
            rankingScore: null,
            visionScore: null,
            selectionScore: null,
          });
        } catch {
          /* skip this item */
        }
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: Europeana (FASE 2 — Priority A historical source) ──────────────

async function searchEuropeanaCandidates(
  queries: string[],
  apiKey: string,
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<string>();
  const authHeader = { Authorization: `ApiKey ${apiKey}`, "User-Agent": "Fastvid/1.0" };

  for (const query of queries) {
    if (candidates.length >= max) break;
    const searchUrl = new URL("https://api.europeana.eu/record/v2/search.json");
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("qf", "TYPE:VIDEO");
    searchUrl.searchParams.set("reusability", "open");
    searchUrl.searchParams.set("rows", "6");
    try {
      const searchResp = await withTimeoutFetch(searchUrl.toString(), authHeader, 10_000, `Europeana pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      type EuropeanaItem = { id?: string; title?: string[]; edmPreview?: string };
      const searchData = (await searchResp.json()) as { items?: EuropeanaItem[] };
      const items = searchData.items ?? [];

      for (const item of items) {
        if (candidates.length >= max) break;
        const recordId = item.id;
        if (!recordId || seenIds.has(recordId)) continue;
        try {
          const recordUrl = `https://api.europeana.eu/record/v2${recordId}.json?profile=rich`;
          const recordResp = await withTimeoutFetch(recordUrl, authHeader, 8_000, `Europeana pool record "${recordId}"`);
          apiCalls++;
          if (!recordResp.ok) continue;
          type EuropeanaRecord = {
            object?: {
              aggregations?: Array<{ edmIsShownBy?: string; edmIsShownAt?: string; edmRights?: string | string[] }>;
              proxies?: Array<{ dcCreator?: string[] | Record<string, string[]> }>;
            };
          };
          const recordData = (await recordResp.json()) as EuropeanaRecord;
          const aggregations = recordData.object?.aggregations ?? [];
          const mediaAgg = aggregations.find(a => a.edmIsShownBy) ?? aggregations.find(a => a.edmIsShownAt);
          const mediaUrl = mediaAgg?.edmIsShownBy ?? mediaAgg?.edmIsShownAt;
          if (!mediaUrl || !/\.(mp4|webm|mov|m4v)/i.test(mediaUrl)) continue;

          const rawRights = mediaAgg?.edmRights;
          const rightsUrl = Array.isArray(rawRights) ? rawRights[0] : rawRights;
          if (!rightsUrl?.trim()) continue;

          const creatorField = recordData.object?.proxies?.find(p => p.dcCreator)?.dcCreator;
          const sourceCreator = Array.isArray(creatorField)
            ? (creatorField[0] ?? null)
            : creatorField
            ? (Object.values(creatorField)[0]?.[0] ?? null)
            : null;

          seenIds.add(recordId);
          candidates.push({
            id: `europeana:${recordId}`,
            assetId: recordId,
            source: "europeana",
            remoteUrl: mediaUrl,
            thumbnailUrl: item.edmPreview ?? null,
            title: (item.title ?? []).join(" ").trim() || query,
            description: null,
            tags: [query],
            mediaType: "video",
            durationSec: null,
            license: rightsUrl.trim(),
            width: null,
            height: null,
            sourceCreator,
            licenseUrl: rightsUrl.trim(),
            clipSimilarity: null,
            embeddingSimilarity: null,
            rankingScore: null,
            visionScore: null,
            selectionScore: null,
          });
        } catch {
          /* skip this item */
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
      sourceCreator: c.sourceCreator,
      licenseUrl: c.licenseUrl,
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
    sourceCreator: (meta.sourceCreator as string | null) ?? null,
    licenseUrl: (meta.licenseUrl as string | null) ?? null,
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
    europeanaApiKey,
    skipPexels = false,
    skipPixabay = false,
    skipInternetArchive = false,
    skipEuropeana = false,
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
  // FASE 2 — Priority A historical/open sources: no API key required for Internet Archive
  // (like Wikimedia); Europeana needs a key, same shape as Pexels/Pixabay above.
  if (!skipInternetArchive) {
    tasks.push(
      searchInternetArchiveCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "internet_archive",
      }))
    );
  }
  if (!skipEuropeana && europeanaApiKey) {
    tasks.push(
      searchEuropeanaCandidates(queries, europeanaApiKey, maxPerSource).then(r => ({
        ...r,
        source: "europeana",
      }))
    );
  }

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

  console.log(`[Pool P2] BEFORE resolveBeatQueryEmbedding s${sceneIndex}b${beatIndex}`);
  const beatEmb = await Promise.race([
    resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle).catch(() => null),
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error(`[Pool P2] TIMEOUT resolveBeatQueryEmbedding 30s s${sceneIndex}b${beatIndex}`)), 30_000)),
  ]).catch((err: Error) => { console.warn(err.message); return null; });
  console.log(`[Pool P2] AFTER resolveBeatQueryEmbedding s${sceneIndex}b${beatIndex} emb=${!!beatEmb}`);
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
      const emb = await Promise.race([
        embedImageFromPath(tmpPath),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error(`[Pool P2] TIMEOUT embedImageFromPath 20s`)), 20_000)),
      ]).catch(() => null as null);
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
