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
import { formatYoutubeLicenseLine, youtubeLicenseDecision } from "./youtubeLicenseStatus";
/**
 * RONDE 91 (§4) — the scene candidate pool asks the same providers the beat path asks, and until
 * this round it asked them without passing the gate. It could not: videoPipeline imports this
 * module, so the gate could not be imported back out of it. searchQueryContract has no imports of
 * its own, which is why the decision now lives there and every module can reach it.
 */
import { rankedPool } from "./poolRanking";
import { penaliseDuplicates, type UsageLedger } from "./duplicateGuard";
import { youtubePoolCandidates, type YoutubeRowLike } from "./youtubePoolSource";

/**
 * RONDE 175 — the shape of the EXISTING YouTube search, as this module needs it.
 *
 * Named here rather than imported from videoPipeline so a 39k-line module does not become a
 * dependency of the pool. The production caller passes `searchYoutubeVideoCandidates` itself; a
 * test asserts the two signatures stay compatible.
 */
export type YoutubePoolSearch = (
  query: string,
  sceneIndex: number,
  license: YoutubeLicenseMode,
  relevanceKeywords: string[],
  minRelevanceScore: number,
  requiredPersonName: string,
  maxResults: number
) => Promise<YoutubeRowLike[]>;
import type { YoutubeLicenseMode } from "./videoPipeline";
import type { VisualIntent as RankingIntent } from "./visualMatchingV2/types";
import {
  emptyQueryContext,
  getSearchProvenance,
  searchGateDecision,
  withSearchProvenance,
} from "./searchQueryContract";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_CANDIDATES_PER_SOURCE = 25;
export const MAX_POOL_SIZE = 100;

/** RONDE 3 / FIX A — how many per-item detail requests a single provider may have in flight.
 *
 *  Wikimedia, Internet Archive, Europeana, NASA and Library of Congress all need a second
 *  request per search hit (imageinfo / metadata / record / asset / item JSON) before a
 *  candidate can be built. Those were issued strictly one at a time, so a provider's latency
 *  was the SUM of its detail calls. Render 516, from the [ScenePool] line: Library of
 *  Congress made 51 sequential calls and took 150975ms — ~2.96s each — which by itself was
 *  the entire funnel's 151s latency while the other eight providers had long finished.
 *
 *  Batching those same calls 5 at a time is a scheduling change only: identical URLs,
 *  identical headers, identical per-request timeouts, identical parsing, identical filters,
 *  identical candidate objects, identical order (each batch is applied in input order before
 *  the next one starts). It cannot produce more candidates than before — the per-item
 *  `candidates.length >= max` check still runs on every item, in order. */
const DETAIL_FETCH_CONCURRENCY = 5;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * RONDE 132 §13 — the providers this beat never asked, and why.
 *
 * `[ProviderSkipped] scene=2 pexels=no_api_key europeana=disabled_by_flag`
 *
 * "provider had nothing" and "provider was never called" are different findings that lead to
 * different work, and the render could not tell them apart — which is why "Geen Wikimedia-stills"
 * had no actionable follow-up.
 */
export function formatProviderSkips(skipped: Record<string, string>): string {
  return Object.entries(skipped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, reason]) => `${source}=${reason}`)
    .join(" ");
}

export type PoolCandidateSource =
  | "pexels"
  | "pixabay"
  | "wikimedia"
  | "archive"
  | "internet_archive"
  | "europeana"
  | "openverse"
  | "nasa"
  | "nara"
  | "loc"
  /**
   * RONDE 169 — YouTube, so it can be RANKED rather than only reached.
   *
   * Until now YouTube existed solely in `HISTORICAL_SOURCE_TIER_ORDER`, a first-hit-wins cascade
   * where being second in a fixed list is the whole of a source's chance. RULE 6 asks that an
   * excellent YouTube clip be able to beat a poor archive one, which is not expressible in a
   * cascade — a candidate has to be in the pool the ranking runs over.
   *
   * Candidates are produced by `youtubePoolSource.ts`, which injects the EXISTING
   * `searchYoutubeVideoCandidates` (quota cooldown, RapidAPI fallback, licence modes and per-render
   * budgets all intact) rather than searching for itself.
   */
  | "youtube_cc";

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
  /** FASE 3: NARA requires a key, same shape as europeanaApiKey — Openverse/NASA/LOC don't. */
  naraApiKey?: string;
  /** If true, skip Pexels (no API key or not applicable). */
  skipPexels?: boolean;
  /** If true, skip Pixabay. */
  skipPixabay?: boolean;
  /** If true, skip Internet Archive. */
  skipInternetArchive?: boolean;
  /** If true, skip Europeana (also skipped automatically when europeanaApiKey is absent). */
  skipEuropeana?: boolean;
  /** If true, skip Openverse. */
  skipOpenverse?: boolean;
  /** If true, skip NASA. */
  skipNasa?: boolean;
  /** If true, skip NARA (also skipped automatically when naraApiKey is absent). */
  skipNara?: boolean;
  /** If true, skip Library of Congress. */
  skipLoc?: boolean;
  /**
   * RONDE 175 — the EXISTING YouTube search, injected.
   *
   * Injected rather than imported so this module never acquires a YouTube client of its own: the
   * caller passes `searchYoutubeVideoCandidates` from videoPipeline, which owns the API key, the
   * quota cooldown, the RapidAPI fallback, the licence modes and the per-render download budget.
   * Absent means YouTube is simply not one of this pool's sources, which is what happens today on
   * every route that does not supply it.
   */
  youtubeSearch?: YoutubePoolSearch;
  /** Which licence question to ask YouTube. Defaults to the CC-only pass. */
  youtubeLicenseMode?: YoutubeLicenseMode;
  maxPerSource?: number;
  maxTotal?: number;
};

// ─── Deduplication ───────────────────────────────────────────────────────────

function dedupCandidates(candidates: PoolCandidate[]): PoolCandidate[] {
  const seen = new Set<string>();
  const urlSeen = new Set<string>();
  const out: PoolCandidate[] = [];
  /**
   * RONDE 175 — the provider's own identity beats a URL heuristic.
   *
   * The URL rule below strips the query string, which is right for a CDN that puts cache-busting
   * or signing parameters there and wrong for a provider that puts the ASSET ID there. YouTube is
   * the second kind: `watch?v=a1` and `watch?v=a2` both strip to `youtube.com/watch`, so the whole
   * of a YouTube search collapsed to a single candidate — silently, and only visible as "2 raw → 1
   * deduped" in a log nobody reads.
   *
   * So a candidate is exempt from the URL rule when the provider has already told us it is a
   * different asset. Two assetIds from one source ARE two assets; that is what an assetId means.
   * This only ever makes dedup less aggressive, and only in the case where the provider itself
   * disagrees with the heuristic.
   */
  const seenAssetKeys = new Set<string>();
  for (const c of candidates) {
    // Dedup on stable id first
    if (seen.has(c.id)) continue;

    /** The provider's own identity for this asset, when it gave one. */
    const assetKey = c.assetId ? `${c.source}:${c.assetId}`.toLowerCase() : null;
    if (assetKey && seenAssetKeys.has(assetKey)) continue;

    // Dedup on canonical URL (normalised: strip query params for image URLs)
    const canonUrl = c.remoteUrl.split("?")[0].toLowerCase();
    /** The URL rule applies only where the provider gave us nothing better to go on. */
    if (!assetKey && urlSeen.has(canonUrl)) continue;

    seen.add(c.id);
    if (assetKey) seenAssetKeys.add(assetKey);
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
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("pexels", query, "scenePool:searchPexelsCandidates").admitted) continue;
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
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("pixabay", query, "scenePool:searchPixabayCandidates").admitted) continue;
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
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("wikimedia", query, "scenePool:searchWikimediaCandidates").admitted) continue;
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
      type WikiInfoData = { query?: { pages?: Record<string, WikiInfoPage> } };

      // FIX A: same imageinfo requests, DETAIL_FETCH_CONCURRENCY at a time. Applied below in
      // input order, so candidate order and the max-cap behaviour are the sequential ones.
      for (let i = 0; i < titles.length; i += DETAIL_FETCH_CONCURRENCY) {
        if (candidates.length >= max) break;
        const batch = titles
          .slice(i, i + DETAIL_FETCH_CONCURRENCY)
          .filter((title) => !seenTitles.has(title));

        /**
         * RONDE 136 — one request for the whole batch, not one per title.
         *
         * Same defect as the videoPipeline route, same evidence: video 558 logged 32 HTTP 429s on
         * Wikimedia imageinfo and stood the provider down 34 times, ending with 38 search results
         * and zero downloads. MediaWiki's query API takes up to 50 pipe-separated titles per call,
         * so a batch of DETAIL_FETCH_CONCURRENCY titles costs ONE request instead of five.
         *
         * The shape below is preserved exactly — a `fetched` array in input order, each entry
         * carrying its title, whether the API was called, and its own page data — so the loop that
         * consumes it, the apiCalls accounting and the max-cap behaviour are all untouched.
         */
        const fetched = await (async () => {
          const empty = batch.map((title) => ({ title, called: false, data: null as WikiInfoData | null }));
          if (batch.length === 0) return empty;
          try {
            const infoUrl =
              `https://commons.wikimedia.org/w/api.php?action=query` +
              `&titles=${encodeURIComponent(batch.join("|"))}&prop=imageinfo` +
              `&iiprop=url|mime|size|extmetadata&format=json&origin=*`;
            const infoResp = await withTimeoutFetch(infoUrl, UA, 8_000, `Wikimedia pool info batch (${batch.length})`);
            // One request was made, so exactly one entry counts as an API call — see the
            // `called` accounting in the consumer. Marking all of them would inflate apiCalls
            // fivefold and misreport the very saving this change makes.
            if (!infoResp.ok) return batch.map((title, n) => ({ title, called: n === 0, data: null as WikiInfoData | null }));
            const data = (await infoResp.json()) as WikiInfoData & {
              query?: { normalized?: Array<{ from: string; to: string }> };
            };
            // MediaWiki normalises titles and says so; without applying that mapping back, a
            // normalised answer is never found again under the name this code asked with.
            const askedFor = new Map<string, string>();
            for (const n of data.query?.normalized ?? []) askedFor.set(n.to, n.from);
            const byTitle = new Map<string, WikiInfoData>();
            for (const page of Object.values(data.query?.pages ?? {})) {
              const pageTitle = (page as { title?: string })?.title;
              if (!pageTitle) continue;
              // Re-wrap as a single-page payload so the consumer below is unchanged.
              const single = { query: { pages: { "0": page } } } as WikiInfoData;
              byTitle.set(askedFor.get(pageTitle) ?? pageTitle, single);
              byTitle.set(pageTitle, single);
            }
            return batch.map((title, n) => ({ title, called: n === 0, data: byTitle.get(title) ?? null }));
          } catch {
            return batch.map((title) => ({ title, called: false, data: null as WikiInfoData | null }));
          }
        })();

        for (const { title, called, data: infoData } of fetched) {
          if (candidates.length >= max) break;
          if (called) apiCalls++;
          if (!infoData || seenTitles.has(title)) continue;
          try {
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
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("internet_archive", query, "scenePool:searchInternetArchiveCandidates").admitted) continue;
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
      type IaMetaData = {
        metadata?: {
          licenseurl?: string | string[];
          rights?: string | string[];
        };
        files?: Array<{ name: string; format: string; size?: string }>;
      };

      // FIX A: same metadata requests, DETAIL_FETCH_CONCURRENCY at a time. Applied below in
      // input order, so candidate order and the max-cap behaviour are the sequential ones.
      for (let i = 0; i < docs.length; i += DETAIL_FETCH_CONCURRENCY) {
        if (candidates.length >= max) break;
        const batch = docs
          .slice(i, i + DETAIL_FETCH_CONCURRENCY)
          .filter((doc) => !seenIds.has(doc.identifier));

        const fetched = await Promise.all(
          batch.map(async (doc) => {
            let called = false;
            try {
              const metaUrl = `https://archive.org/metadata/${doc.identifier}`;
              const metaResp = await withTimeoutFetch(metaUrl, UA, 8_000, `Internet Archive pool metadata "${doc.identifier}"`);
              called = true;
              if (!metaResp.ok) return { doc, called, data: null as IaMetaData | null };
              return { doc, called, data: (await metaResp.json()) as IaMetaData };
            } catch {
              return { doc, called, data: null as IaMetaData | null };
            }
          })
        );

        for (const { doc, called, data: metaData } of fetched) {
          if (candidates.length >= max) break;
          if (called) apiCalls++;
          if (!metaData || seenIds.has(doc.identifier)) continue;
          try {
          const rawLicenseUrl = metaData.metadata?.licenseurl;
          const licenseUrlRaw = (Array.isArray(rawLicenseUrl) ? rawLicenseUrl[0] : rawLicenseUrl)?.trim();
          const rawRights = metaData.metadata?.rights;
          const rights = (Array.isArray(rawRights) ? rawRights[0] : rawRights)?.trim();
          /**
           * RONDE 124 — the second copy of the same gate.
           *
           * The brief asked for the WHOLE chain rather than the first hit, and this is the other
           * place a `youtube-*` item is refused. `youtubeLicenseStatus` has no pipeline imports,
           * so using it here does not create the cycle this file's own comment warns about.
           */
          const poolLicense = youtubeLicenseDecision({
            identifier: doc.identifier,
            licenseUrl: licenseUrlRaw,
            rights,
          });
          if (poolLicense.youtubeVideoId) {
            console.log(`[ScenePool] ${formatYoutubeLicenseLine(poolLicense)}`);
          }
          if (!poolLicense.allowed) continue;

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
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("europeana", query, "scenePool:searchEuropeanaCandidates").admitted) continue;
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
      type EuropeanaRecord = {
        object?: {
          aggregations?: Array<{ edmIsShownBy?: string; edmIsShownAt?: string; edmRights?: string | string[] }>;
          proxies?: Array<{ dcCreator?: string[] | Record<string, string[]> }>;
        };
      };

      // FIX A: same record requests, DETAIL_FETCH_CONCURRENCY at a time. Applied below in
      // input order, so candidate order and the max-cap behaviour are the sequential ones.
      for (let i = 0; i < items.length; i += DETAIL_FETCH_CONCURRENCY) {
        if (candidates.length >= max) break;
        const batch = items
          .slice(i, i + DETAIL_FETCH_CONCURRENCY)
          .map((item) => ({ item, recordId: item.id }))
          .filter((e) => !!e.recordId && !seenIds.has(e.recordId));

        const fetched = await Promise.all(
          batch.map(async ({ item, recordId }) => {
            let called = false;
            try {
              const recordUrl = `https://api.europeana.eu/record/v2${recordId}.json?profile=rich`;
              const recordResp = await withTimeoutFetch(recordUrl, authHeader, 8_000, `Europeana pool record "${recordId}"`);
              called = true;
              if (!recordResp.ok) return { item, recordId: recordId!, called, data: null as EuropeanaRecord | null };
              return { item, recordId: recordId!, called, data: (await recordResp.json()) as EuropeanaRecord };
            } catch {
              return { item, recordId: recordId!, called, data: null as EuropeanaRecord | null };
            }
          })
        );

        for (const { item, recordId, called, data: recordData } of fetched) {
          if (candidates.length >= max) break;
          if (called) apiCalls++;
          if (!recordData || seenIds.has(recordId)) continue;
          try {
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
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: Openverse (FASE 3 — Priority A open-licensed images) ───────────
// Metadata-only mirror of searchWebWideVideoClips's Openverse call (videoPipeline.ts) — same
// endpoint, same license_type filter, same license-safety gate. Images only: Openverse's
// catalog covers images + audio, not video (matches existing precedent in this codebase —
// fetchOpenverseImages/searchWebWideVideoClips both only ever call /v1/images/, never a video
// endpoint — so this pool adapter does the same rather than inventing a video search that
// doesn't exist on the provider side).
export async function searchOpenverseCandidates(
  queries: string[],
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<string>();
  const UA = { "User-Agent": "Fastvid/1.0 (video generation; contact@fastvid.ai)" };

  for (const query of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("openverse", query, "scenePool:searchOpenverseCandidates").admitted) continue;
    if (candidates.length >= max) break;
    const searchUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=${max}&format=json`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, UA, 8_000, `Openverse pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      type OpenverseItem = {
        id: string; url: string; title?: string; license?: string; license_url?: string;
        creator?: string; foreign_landing_url?: string;
      };
      const payload = (await searchResp.json()) as { results?: OpenverseItem[] };
      const items = payload.results ?? [];

      for (const item of items) {
        if (candidates.length >= max) break;
        // License-safety gate: reject anything without an explicit license tag — belt-and-
        // braces even though license_type= should already guarantee one (same gate already
        // used by the existing searchWebWideVideoClips in videoPipeline.ts).
        if (!item.id || !item.url || !item.license?.trim()) continue;
        if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(item.url)) continue;
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        candidates.push({
          id: `openverse:${item.id}`,
          assetId: item.id,
          source: "openverse",
          remoteUrl: item.url,
          thumbnailUrl: item.url,
          title: item.title || query,
          description: null,
          tags: [query],
          mediaType: "image",
          durationSec: null,
          license: item.license.trim(),
          width: null,
          height: null,
          sourceCreator: item.creator || null,
          licenseUrl: item.license_url || null,
          clipSimilarity: null,
          embeddingSimilarity: null,
          rankingScore: null,
          visionScore: null,
          selectionScore: null,
        });
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: NASA Images & Video Library (FASE 3 — Priority A historical/open source) ───
// Metadata-only mirror of fetchNasaVideoClips's search→asset-manifest steps (videoPipeline.ts)
// — same two endpoints, same mp4-selection logic — without the download/trim. NASA media is
// U.S. government work, inherently public domain under 17 U.S.C. §105; there is no per-item
// rights field to check (matches the existing eager fetcher, which also never checks one).
// Deliberately does NOT touch the existing NASA circuit-breaker state
// (isNasaInCooldown/markNasaSearchResult in videoPipeline.ts) — this is a separate, independent
// search path; sharing that state would let this pool search trip or be blocked by a cooldown
// meant for the unrelated eager-fetch fallback cascade.
export async function searchNasaCandidates(
  queries: string[],
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<string>();
  const UA = { "User-Agent": "Fastvid/1.0 (NASA public domain footage)" };

  for (const query of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("nasa", query, "scenePool:searchNasaCandidates").admitted) continue;
    if (candidates.length >= max) break;
    const searchUrl = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, UA, 10_000, `NASA pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      type NasaItem = { data?: Array<{ nasa_id?: string; title?: string }> };
      const searchData = (await searchResp.json()) as { collection?: { items?: NasaItem[] } };
      const items = searchData.collection?.items ?? [];
      type NasaAssetData = { collection?: { items?: Array<{ href?: string }> } };

      // FIX A: same asset requests, DETAIL_FETCH_CONCURRENCY at a time. Applied below in
      // input order, so candidate order and the max-cap behaviour are the sequential ones.
      for (let i = 0; i < items.length; i += DETAIL_FETCH_CONCURRENCY) {
        if (candidates.length >= max) break;
        const batch = items
          .slice(i, i + DETAIL_FETCH_CONCURRENCY)
          .map((item) => ({ nasaId: item.data?.[0]?.nasa_id, title: item.data?.[0]?.title }))
          .filter((e) => !!e.nasaId && !seenIds.has(e.nasaId));

        const fetched = await Promise.all(
          batch.map(async ({ nasaId, title }) => {
            let called = false;
            try {
              const assetUrl = `https://images-api.nasa.gov/asset/${nasaId}`;
              const assetResp = await withTimeoutFetch(assetUrl, UA, 8_000, `NASA pool asset "${nasaId}"`);
              called = true;
              if (!assetResp.ok) return { nasaId: nasaId!, title, called, data: null as NasaAssetData | null };
              return { nasaId: nasaId!, title, called, data: (await assetResp.json()) as NasaAssetData };
            } catch {
              return { nasaId: nasaId!, title, called, data: null as NasaAssetData | null };
            }
          })
        );

        for (const { nasaId, title, called, data: assetData } of fetched) {
          if (candidates.length >= max) break;
          if (called) apiCalls++;
          if (!assetData || seenIds.has(nasaId)) continue;
          try {
          // RONDE 26: NASA asset hrefs contain literal spaces in the folder name. Escaping only
          // the space keeps this idempotent for hrefs that already come percent-encoded.
          const assetUrls = (assetData.collection?.items ?? [])
            .map(i => i.href)
            .filter((u): u is string => typeof u === "string" && u.length > 0)
            .map(u => u.replace(/ /g, "%20"));
          const mp4Url = assetUrls.find(u => /\.mp4$/i.test(u) && !/~mobile|~thumb|~preview|~small/i.test(u))
            ?? assetUrls.find(u => /\.mp4$/i.test(u));
          if (!mp4Url) continue;

          seenIds.add(nasaId);
          candidates.push({
            id: `nasa:${nasaId}`,
            assetId: nasaId,
            source: "nasa",
            remoteUrl: mp4Url,
            thumbnailUrl: null,
            title: title ?? nasaId,
            description: null,
            tags: [query],
            mediaType: "video",
            durationSec: null,
            license: "Public Domain (NASA / U.S. Government Work)",
            width: null,
            height: null,
            sourceCreator: null,
            licenseUrl: "https://www.nasa.gov/multimedia/guidelines/index.html",
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
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: NARA (US National Archives, FASE 3 — Priority A historical source) ─────────
// Metadata-only mirror of fetchNaraClips's search step (videoPipeline.ts) — same endpoint,
// same digitalObjects parsing — without the download/trim. Requires a free NARA_API_KEY
// (register at https://catalog.archives.gov/api/v2), passed in from the caller (like
// europeanaApiKey) rather than read from process.env here, keeping scenePool.ts free of direct
// env access — same pattern already used for Pexels/Pixabay/Europeana. NARA holdings are U.S.
// federal records — public domain under 17 U.S.C. §105, same legal basis as NASA above; no
// per-item rights field exists to check (matches the existing eager fetcher).
export async function searchNaraCandidates(
  queries: string[],
  apiKey: string,
  max: number
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenUrls = new Set<string>();
  const headers = { "x-api-key": apiKey, "User-Agent": "Fastvid/1.0 (NARA public archives)" };

  for (const query of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // repaired, widened or replaced. The pool simply has one candidate source fewer.
    if (!searchGateDecision("nara", query, "scenePool:searchNaraCandidates").admitted) continue;
    if (candidates.length >= max) break;
    const searchUrl = `https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(query)}&limit=${max * 3}`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, headers, 10_000, `NARA pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      type NaraHit = { _source?: { record?: {
        title?: string;
        digitalObjects?: Array<{ objectUrl?: string; objectType?: string }>;
      } } };
      const searchData = (await searchResp.json()) as { body?: { hits?: { hits?: NaraHit[] } } };
      const hits = searchData.body?.hits?.hits ?? [];

      for (const hit of hits) {
        if (candidates.length >= max) break;
        const record = hit._source?.record;
        const videoObject = record?.digitalObjects?.find(
          o => /\.(mp4|mov|m4v)$/i.test(o.objectUrl ?? "") || /video/i.test(o.objectType ?? "")
        );
        const videoUrl = videoObject?.objectUrl;
        // NARA's typed search response never carries a discrete naId field (same limitation
        // documented next to fetchNaraClips), so the objectUrl itself is the identity.
        if (!videoUrl || seenUrls.has(videoUrl)) continue;
        seenUrls.add(videoUrl);
        candidates.push({
          id: `nara:${videoUrl}`,
          assetId: videoUrl,
          source: "nara",
          remoteUrl: videoUrl,
          thumbnailUrl: null,
          title: record?.title || query,
          description: null,
          tags: [query],
          mediaType: "video",
          durationSec: null,
          license: "Public Domain (NARA / U.S. Government Work)",
          width: null,
          height: null,
          sourceCreator: null,
          licenseUrl: "https://www.archives.gov/global-pages/using-nara-materials",
          clipSimilarity: null,
          embeddingSimilarity: null,
          rankingScore: null,
          visionScore: null,
          selectionScore: null,
        });
      }
    } catch {
      /* skip this query */
    }
  }
  return { candidates, apiCalls };
}

// ─── Provider: Library of Congress (FASE 3 — Priority A historical/open source) ───────────
// NEW — no existing fetcher in this codebase to mirror (unlike NASA/NARA/Openverse above).
// Built directly against the public loc.gov JSON API (https://www.loc.gov/apis/json-and-yaml/),
// no API key required — same two-step search→item-detail shape already established for
// Internet Archive (FASE 2: advancedsearch.php → /metadata/{id}).
// CAVEAT (see FASE 3 report): this sandbox has no outbound network access to loc.gov, so this
// implementation could not be smoke-tested against a live response — field names follow the
// public API documentation, not a verified live payload. The license gate below is
// deliberately conservative (reject unless an explicit public-domain / no-known-restrictions
// signal is present) so a wrong or missing field degrades to "0 candidates from this source"
// rather than ever admitting an item with unclear rights.
/**
 * RONDE 136 — the media types this pipeline can actually open.
 *
 * A provider listing a file as `image/*` is not a promise that ffmpeg can read it. The Library of
 * Congress serves newspaper scans as image/jp2 and image/tiff; both are legitimate images and
 * neither survives the still-to-video conversion, so a candidate offering only those is a wasted
 * download and a wasted shortlist slot.
 *
 * Deliberately a short allow-list rather than a deny-list of the formats seen failing: a new
 * exotic type should be excluded by default and added here on purpose, not discovered in a render.
 */
export function isDecodableMediaMime(
  mimetype: string | undefined | null,
  kind: "video" | "image"
): boolean {
  const m = (mimetype ?? "").trim().toLowerCase();
  if (!m) return false;
  if (kind === "video") {
    return /^video\/(mp4|webm|quicktime|x-msvideo|mpeg|ogg)\b/.test(m);
  }
  return /^image\/(jpeg|jpg|png|webp|gif)\b/.test(m);
}

export function isAllowedLocRights(rightsText: string | undefined | null): boolean {
  const r = rightsText?.trim().toLowerCase();
  if (!r) return false;
  return /no known restrictions|public domain|not protected by copyright/.test(r);
}

/**
 * RONDE 27: wall-clock ceiling for the whole Library of Congress sweep.
 *
 * Every provider in this pool runs concurrently under a single Promise.allSettled, so the pool's
 * duration is the SLOWEST provider's duration. Render 528 measured
 *   loc=60905ms, internet_archive=39090ms, wikimedia=887ms, openverse=623ms, pexels=132ms
 * against a 60s pool budget: Wikimedia and Pexels were done inside a second, and the pool still
 * sat there until LOC ran out the clock — 28 calls, 85 candidates, and no room left for anyone
 * to top up. LOC is worth having (it holds real public-domain historical film), so this bounds it
 * rather than dropping it: past the deadline it returns what it already found.
 */
export function locPoolBudgetMs(): number {
  const raw = process.env.LOC_POOL_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5_000 && n <= 120_000) return n;
  }
  return 20_000;
}

export async function searchLibraryOfCongressCandidates(
  queries: string[],
  max: number,
  budgetMs: number = locPoolBudgetMs()
): Promise<{ candidates: PoolCandidate[]; apiCalls: number }> {
  const candidates: PoolCandidate[] = [];
  let apiCalls = 0;
  const seenIds = new Set<string>();
  const UA = { "User-Agent": "Fastvid/1.0 (video generation)" };
  const deadline = Date.now() + budgetMs;
  const outOfTime = (): boolean => Date.now() >= deadline;

  for (const query of queries) {
    if (candidates.length >= max) break;
    if (outOfTime()) {
      console.warn(
        `[ScenePool] Library of Congress budget spent (${budgetMs}ms) — keeping ${candidates.length} candidate(s), skipping remaining queries`
      );
      break;
    }
    const searchUrl = `https://www.loc.gov/search/?q=${encodeURIComponent(query)}&fo=json&c=${max}`;
    try {
      const searchResp = await withTimeoutFetch(searchUrl, UA, 10_000, `Library of Congress pool search "${query}"`);
      apiCalls++;
      if (!searchResp.ok) continue;
      type LocResult = {
        id?: string; title?: string; url?: string;
        image_url?: string[] | string; access_restricted?: boolean;
      };
      const searchData = (await searchResp.json()) as { results?: LocResult[] };
      const results = searchData.results ?? [];
      type LocItem = {
        item?: { rights_advisory?: string[]; rights?: string | string[] };
        resources?: Array<{ files?: Array<Array<{ mimetype?: string; url?: string }>> }>;
      };

      // FIX A: same item requests, DETAIL_FETCH_CONCURRENCY at a time instead of one at a
      // time. Each batch is applied below in input order before the next batch starts, so
      // both the candidate order and the max-cap behaviour are the sequential ones.
      for (let i = 0; i < results.length; i += DETAIL_FETCH_CONCURRENCY) {
        if (candidates.length >= max) break;
        // The detail fetches are what actually burn the clock — one per search hit, five at a
        // time, 8s each. Checked per batch rather than per item so a batch already in flight is
        // still consumed instead of thrown away.
        if (outOfTime()) break;
        const batch = results
          .slice(i, i + DETAIL_FETCH_CONCURRENCY)
          .map((result) => ({ result, itemUrl: result.url || result.id }))
          .filter((e) => !!e.itemUrl && !e.result.access_restricted && !seenIds.has(e.itemUrl));

        const fetched = await Promise.all(
          batch.map(async ({ result, itemUrl }) => {
            let called = false;
            try {
              const itemJsonUrl = `${itemUrl!.replace(/\/$/, "")}/?fo=json`;
              const itemResp = await withTimeoutFetch(itemJsonUrl, UA, 8_000, `Library of Congress pool item "${itemUrl}"`);
              called = true;
              if (!itemResp.ok) return { result, itemUrl: itemUrl!, called, data: null as LocItem | null };
              return { result, itemUrl: itemUrl!, called, data: (await itemResp.json()) as LocItem };
            } catch {
              return { result, itemUrl: itemUrl!, called, data: null as LocItem | null };
            }
          })
        );

        for (const { result, itemUrl, called, data: itemData } of fetched) {
          if (candidates.length >= max) break;
          if (called) apiCalls++;
          if (!itemData || seenIds.has(itemUrl)) continue;
          try {
          const rawRights = itemData.item?.rights ?? itemData.item?.rights_advisory;
          const rightsText = Array.isArray(rawRights) ? rawRights.join(" ") : rawRights;
          if (!isAllowedLocRights(rightsText)) continue;

          /**
           * RONDE 136 — LOC may only offer a file this pipeline can actually decode.
           *
           * ── What video 558 showed, and what it did NOT show ──────────────────────────────────
           *
           *     [TechnicalGate] REJECT s2b2 source=loc
           *       asset=https://www.loc.gov/item/sn81002003/1945-07-09/ed-1/
           *       type=image reason=file_too_small actual=0B required=50000B
           *
           * That `asset=` is the ITEM id, which is the catalogue URL by design — the log prints
           * the identity, not the download address. This adapter has always required a real file
           * (`if (!mediaFile?.url) continue`), so a catalogue page was never handed out as
           * remoteUrl. Worth stating plainly, because the opposite is easy to read into that line.
           *
           * ── The real defect ─────────────────────────────────────────────────────────────────
           *
           * `mimetype?.includes("image")` accepts EVERY image type LOC publishes, and for
           * Chronicling America newspaper issues — which is exactly what sn81002003 is — that
           * means image/jp2 and image/tiff. Nothing downstream can decode a JPEG 2000: it is
           * downloaded, it fails, and it has cost a request, a shortlist slot and a beat's chance
           * of a picture. The 0 bytes above is the same story one step earlier.
           *
           * So the type test moves from "is it an image" to "can we open it". Absence of a usable
           * file drops the candidate here, before the download, which is where it costs least.
           */
          const files = (itemData.resources ?? []).flatMap(r => r.files ?? []).flat();
          const videoFile = files.find(f => isDecodableMediaMime(f.mimetype, "video") && f.url);
          const imageFile = files.find(f => isDecodableMediaMime(f.mimetype, "image") && f.url);
          const mediaFile = videoFile ?? imageFile;
          if (!mediaFile?.url) continue;

          seenIds.add(itemUrl);
          candidates.push({
            id: `loc:${itemUrl}`,
            assetId: itemUrl,
            source: "loc",
            remoteUrl: mediaFile.url,
            thumbnailUrl: Array.isArray(result.image_url) ? (result.image_url[0] ?? null) : (result.image_url ?? null),
            title: result.title || query,
            description: null,
            tags: [query],
            mediaType: videoFile ? "video" : "image",
            durationSec: null,
            license: rightsText?.trim() || null,
            width: null,
            height: null,
            sourceCreator: null,
            licenseUrl: itemUrl,
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

/**
 * RONDE 93 (§1/§7) — the scene's own words, as the proof for the pool's searches.
 *
 * The audit traced every `LEGACY_QUERY_BUILDER` in the log to one place: legacyQueryTicket, minted
 * by the gate when a provider search runs with NO ambient provenance. It never meant "an old query
 * builder ran" — there is no such builder left in this codebase. It meant "this search happened
 * outside any scope that could say where its words came from", and the scene candidate pool was
 * the largest source of them: it runs once per SCENE, above the beat loop, so none of RONDE 90's
 * eleven beat scopes covered it.
 *
 * The pool's queries come from the scene (visualCue, pexelsQueries, brollQueries), so the scene's
 * text is the right evidence for them — the same class of evidence a beat scope uses, and no
 * broader: buildVerifiedQueryContextForBeat already folds sceneText into every beat context.
 *
 * A beat scope that is already active WINS, because it is the more specific claim. This only fills
 * the gap where there is none.
 */
export async function buildSceneCandidatePool(
  req: BuildPoolRequest
): Promise<SceneCandidatePool> {
  if (getSearchProvenance()) return buildSceneCandidatePoolInner(req);
  return withSearchProvenance(emptyQueryContext(req.sceneText ?? ""), () =>
    buildSceneCandidatePoolInner(req)
  );
}

async function buildSceneCandidatePoolInner(
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
    naraApiKey,
    skipPexels = false,
    skipPixabay = false,
    skipInternetArchive = false,
    skipEuropeana = false,
    skipOpenverse = false,
    skipNasa = false,
    skipNara = false,
    skipLoc = false,
    maxPerSource = MAX_CANDIDATES_PER_SOURCE,
    maxTotal = MAX_POOL_SIZE,
  } = req;

  const queries = Array.from(new Set([primaryQuery, ...extraQueries].filter(Boolean)));
  const t0 = Date.now();
  const apiCallsPerProvider: Record<string, number> = {};
  /** FIX C: wall-clock ms per provider task (search + detail fetches). Observability only. */
  const msPerProvider: Record<string, number> = {};

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
  // FIX C: every task below is created synchronously in this tick, so one timestamp is the
  // common start for all of them and `Date.now() - liveT0` inside each .then() is that
  // provider's own wall-clock duration — search plus detail fetches. Purely observational:
  // no extra await, no extra request, no change to which providers are queried.
  const liveT0 = Date.now();
  const tasks: Promise<{ candidates: PoolCandidate[]; apiCalls: number; source: string; ms: number }>[] = [];

  /**
   * RONDE 132 §13 — a provider that was never asked says so.
   *
   * The render reported "Geen Wikimedia-stills" and there was no way to tell whether Wikimedia had
   * been asked and returned nothing, or had never been asked at all. Every `if (!skipX && key)`
   * below silently drops a whole provider, and the two cases need completely different work:
   * "the queries are wrong" versus "the key is missing".
   *
   * Recorded here rather than inferred later: this is the one place that knows WHY.
   */
  const skipped: Record<string, string> = {};
  const noteSkip = (source: string, flagged: boolean, hasKey: boolean): boolean => {
    if (flagged) {
      skipped[source] = "disabled_by_flag";
      return true;
    }
    if (!hasKey) {
      skipped[source] = "no_api_key";
      return true;
    }
    return false;
  };

  // The guard keeps its own key check so the type still narrows; noteSkip only records WHY.
  if (!noteSkip("pexels", skipPexels, Boolean(pexelsApiKey)) && pexelsApiKey) {
    tasks.push(
      searchPexelsCandidates(queries, pexelsApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pexels",
        ms: Date.now() - liveT0,
      }))
    );
  }
  if (!noteSkip("pixabay", skipPixabay, Boolean(pixabayApiKey)) && pixabayApiKey) {
    tasks.push(
      searchPixabayCandidates(queries, pixabayApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pixabay",
        ms: Date.now() - liveT0,
      }))
    );
  }
  tasks.push(
    searchWikimediaCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "wikimedia",
        ms: Date.now() - liveT0,
      }))
  );

  /**
   * RONDE 175 — YouTube joins the pool, so it can be RANKED rather than only reached.
   *
   * R169 built the adapter and R174 found the gap this closes: the adapter existed and nothing
   * called it, so YouTube could still only be reached through the first-hit-wins cascade where
   * position in a fixed list is the whole of a source's chance.
   *
   * `youtubeSearch` is the pipeline's own `searchYoutubeVideoCandidates`. Nothing here searches,
   * downloads, checks a licence or holds a key — this is one more entry in the same task list as
   * every other provider, and its candidates go through the same dedup, the same ranking, the same
   * duplicate penalty and the same download and rehydration as everything else.
   */
  if (req.youtubeSearch) {
    const mode = req.youtubeLicenseMode ?? "creative_common";
    /**
     * Built with `.then` rather than an async IIFE, like every other task above.
     *
     * Not a style preference: RONDE 3's guard asserts this whole block contains no `await`, because
     * an await HERE would run the providers one after another instead of building promises for
     * `Promise.allSettled` to run together. An IIFE's await is in fact still parallel, but the
     * guard is a text scan and cannot see that — and a guard that has to be reasoned around is one
     * people edit. Matching the established shape keeps it exact.
     */
    tasks.push(
      youtubePoolCandidates({
        query: queries[0] ?? primaryQuery,
        sceneIndex,
        mode,
        maxResults: maxPerSource,
        search: req.youtubeSearch,
      }).then(({ candidates, log }) => {
        console.log(log);
        return {
          candidates: candidates as unknown as PoolCandidate[],
          /** One search call, whatever it returned — the same accounting every provider gets. */
          apiCalls: 1,
          source: "youtube_cc",
          ms: Date.now() - liveT0,
        };
      })
    );
  } else {
    skipped.youtube_cc = "no_search_function_supplied";
  }
  // FASE 2 — Priority A historical/open sources: no API key required for Internet Archive
  // (like Wikimedia); Europeana needs a key, same shape as Pexels/Pixabay above.
  if (!noteSkip("internet_archive", skipInternetArchive, true)) {
    tasks.push(
      searchInternetArchiveCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "internet_archive",
        ms: Date.now() - liveT0,
      }))
    );
  }
  if (!noteSkip("europeana", skipEuropeana, Boolean(europeanaApiKey)) && europeanaApiKey) {
    tasks.push(
      searchEuropeanaCandidates(queries, europeanaApiKey, maxPerSource).then(r => ({
        ...r,
        source: "europeana",
        ms: Date.now() - liveT0,
      }))
    );
  }
  // FASE 3 — Priority A historical/open sources: Openverse/NASA/Library of Congress need no
  // API key (same shape as Internet Archive above); NARA needs a key, same shape as Europeana.
  if (!noteSkip("openverse", skipOpenverse, true)) {
    tasks.push(
      searchOpenverseCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "openverse",
        ms: Date.now() - liveT0,
      }))
    );
  }
  if (!noteSkip("nasa", skipNasa, true)) {
    tasks.push(
      searchNasaCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "nasa",
        ms: Date.now() - liveT0,
      }))
    );
  }
  if (!noteSkip("nara", skipNara, Boolean(naraApiKey)) && naraApiKey) {
    tasks.push(
      searchNaraCandidates(queries, naraApiKey, maxPerSource).then(r => ({
        ...r,
        source: "nara",
        ms: Date.now() - liveT0,
      }))
    );
  }
  if (!noteSkip("loc", skipLoc, true)) {
    tasks.push(
      searchLibraryOfCongressCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "loc",
        ms: Date.now() - liveT0,
      }))
    );
  }

  if (Object.keys(skipped).length > 0) {
    console.log(`[ProviderSkipped] scene=${sceneIndex} ${formatProviderSkips(skipped)}`);
  }

  const results = await Promise.allSettled(tasks);

  const rawCandidates: PoolCandidate[] = [];
  for (const result of results) {
    if (result.status === "rejected") continue;
    const { candidates, apiCalls, source, ms } = result.value;
    apiCallsPerProvider[source] = apiCalls;
    msPerProvider[source] = ms;
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
    `in ${latencyMs}ms | calls: ${Object.entries(apiCallsPerProvider).map(([k, v]) => `${k}=${v}`).join(", ")}` +
    // FIX C: which provider actually consumed the scene's retrieval window. Sorted slowest
    // first so the bottleneck is the first thing on the line.
    ` | ms: ${Object.entries(msPerProvider).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`
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
/**
 * RONDE 160 (FASE 7) — use the real ranking engine instead of the keyword counter below.
 *
 * Off by default. The engine is connected, tested and reachable by configuration; switching it on
 * changes which asset every beat of every render picks, and this environment has no provider
 * credentials, so that change cannot be MEASURED here. Turning it on is therefore a deliberate
 * production decision with a before/after comparison behind it — not something a deploy inherits
 * from an audit round. Set POOL_RANKING_V2=true to activate.
 */
export function poolRankingV2Enabled(): boolean {
  const explicit = (process.env.POOL_RANKING_V2 ?? "").trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  /**
   * RONDE 170 — ON for the cinematic route, OFF for the legacy one, unless told otherwise.
   *
   * The brief asks for the ranking to become part of the NORMAL cinematic retrieval path, and it
   * is bound to that route rather than switched on globally for a reason: the legacy compose path
   * has years of tuning built around the keyword scorer's behaviour, and changing what every
   * existing render picks is not something an integration round should do as a side effect.
   *
   * `POOL_RANKING_V2` still overrides in both directions, so either route can be forced either way
   * for a comparison render.
   */
  return (process.env.CINEMATIC_EDITING_ENGINE ?? "").trim().toLowerCase() === "true";
}

/**
 * What the Director and the render already know about this beat, passed through to the ranking
 * engine. Every field is optional: absent means the engine simply does not use that signal, which
 * is exactly what it does today.
 */
export type PoolSelectionContext = {
  intent?: RankingIntent;
  targetDurationSec?: number;
  targetOrientation?: "landscape" | "portrait" | "square";
  targetMotionLevel?: number;
  usedPaths?: ReadonlySet<string>;
  usedCategories?: ReadonlyMap<string, number>;
  entityTerms?: readonly string[];
  /**
   * RONDE 170 — every asset this VIDEO has already adopted, keyed by provider + id.
   *
   * Video-wide rather than per-scene or per-query: the complaint this answers is a viewer seeing
   * the same shot come back, and that does not care which query found it the second time.
   */
  usageLedger?: UsageLedger;
  /** Where this selection is happening, so a repeat can be reported as same-beat/scene/video. */
  at?: { sceneIndex: number; beatIndex: number };
};

/**
 * The beat's own words, tokenised — extracted from `selectCandidatesFromPool` unchanged.
 */
function beatTokensFor(beatText: string, powerWord: string, keywords: string[]): string[] {
  return Array.from(new Set(
    [powerWord, ...keywords, ...beatText.toLowerCase().split(/\s+/)]
      .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(t => t.length > 2)
  ));
}

/**
 * How well a candidate's own text matches the beat's words.
 *
 * ── RONDE 180: why this is now a named function ──────────────────────────────────────────────
 *
 * This is the pool's original scorer, lifted out of `selectCandidatesFromPool` with its arithmetic
 * untouched — same token rules, same +3 for a power word in the title, same +2 in the tags.
 *
 * It had to be reachable from the V2 path because of what the audit found there. `poolRanking`
 * hands the engine `keywordScore: null`, on the stated belief that "the engine already reads title,
 * tags and description itself". It does not: `buildKeywordNormalizer` only normalises scores it is
 * GIVEN, so the 0.17 keyword weight contributed exactly zero on every ranked candidate, and the
 * ordering came down to source priority and resolution. A ranking with no textual relevance in it
 * is worse than the word-stem sort it replaced, and it is the opposite of RULE 7.
 *
 * So the same scorer feeds both paths. The engine min-max normalises the batch, which is what makes
 * an arbitrary scale like this one safe to hand over — and a second scorer here would be a second
 * opinion about relevance, which is exactly what §28 forbids.
 */
function keywordRelevanceScore(
  c: Pick<PoolCandidate, "title" | "tags" | "description">,
  beatTokens: string[],
  powerWord: string
): number {
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
  return score;
}

export function selectCandidatesFromPool(
  beatText: string,
  powerWord: string,
  keywords: string[],
  pool: SceneCandidatePool,
  count = 5,
  /** RONDE 160 — supplied by the caller that has it; absent keeps the historical behaviour. */
  ctx?: PoolSelectionContext
): PoolCandidate[] {
  if (pool.candidates.length === 0) return [];

  /**
   * RONDE 160 (FASE 7) — thirteen signals instead of one.
   *
   * The scorer below counts shared word-stems. It has no notion of source priority, diversity,
   * duplicate penalty, motion, aspect, duration fit or freshness, and no idea what shot the
   * Director asked for — all of which `rankCandidates` has implemented and tested all along. This
   * routes the same candidates through that engine rather than growing a second one here.
   */
  if (poolRankingV2Enabled() && ctx?.intent) {
    /**
     * RONDE 180 — the engine is given a keyword score, because it does not compute one.
     *
     * `poolCandidateToAsset` passes `keywordScore: null` and says the engine reads the title itself.
     * It does not — `buildKeywordNormalizer` normalises scores it is given — so the 0.17 keyword
     * weight contributed zero and the ordering was decided by source priority and resolution. This
     * hands over the pool's OWN scorer's answer, the same one the non-V2 path below sorts by, so
     * both paths agree about relevance and the engine adds twelve signals on top rather than
     * replacing the one that was working.
     */
    const beatTokens = beatTokensFor(beatText, powerWord, keywords);
    const ranked = rankedPool({
      intent: ctx.intent,
      candidates: pool.candidates,
      /**
       * Handed over as a function rather than stamped onto the candidates. This module does not
       * write score fields onto pool candidates — a rule R3 pins, and a good one: a score written
       * here would outlive this call and be read later as if some other stage had measured it.
       */
      keywordScoreOf: (c) => keywordRelevanceScore(c as PoolCandidate, beatTokens, powerWord),
      ...(ctx.targetDurationSec != null ? { targetDurationSec: ctx.targetDurationSec } : {}),
      ...(ctx.targetOrientation ? { targetOrientation: ctx.targetOrientation } : {}),
      ...(ctx.targetMotionLevel != null ? { targetMotionLevel: ctx.targetMotionLevel } : {}),
      ...(ctx.usedPaths ? { usedPaths: ctx.usedPaths } : {}),
      ...(ctx.usedCategories ? { usedCategories: ctx.usedCategories } : {}),
      ...(ctx.entityTerms ? { entityTerms: ctx.entityTerms } : {}),
    });

    /**
     * RONDE 170 — repetition is settled AFTER relevance, never inside it.
     *
     * The ranking engine owns relevance and `penaliseDuplicates` owns repetition. Keeping them
     * apart is the only way RULE 6 and RULE 7 can both hold: a second scorer would have its own
     * opinion about relevance and start disagreeing with the first one. The penalty is small
     * enough to settle a near-tie and too small to overturn a real difference in relevance.
     *
     * Without a ledger there is nothing to be a duplicate OF, and the engine's order stands.
     */
    if (!ctx.usageLedger) return ranked.slice(0, count);
    return penaliseDuplicates({
      ranked,
      identityOf: (c) => ({ provider: c.source, providerAssetId: c.assetId }),
      scoreOf: (c) => c.rankingScore ?? 0,
      ledger: ctx.usageLedger,
      at: ctx.at ?? { sceneIndex: pool.sceneIndex, beatIndex: 0 },
    })
      .map((r) => r.candidate)
      .slice(0, count);
  }

  const scored = pool.candidates.map(c => ({
    candidate: c,
    score: keywordRelevanceScore(c, beatTokensFor(beatText, powerWord, keywords), powerWord),
  }));

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
