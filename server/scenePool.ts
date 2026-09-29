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
import { foldSearchText } from "./searchTextNormalize";
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
import type { MediaForm } from "./beatVisualIntent";
import { penaliseDuplicates, type UsageLedger } from "./duplicateGuard";
import { youtubePoolCandidates, type YoutubeRowLike } from "./youtubePoolSource";
import { archivePoolCandidates, type ArchiveRowLike } from "./archivePoolSource";
import { enoughForEveryBeat, runTieredRetrieval, type RetrievalTask } from "./tieredRetrieval";
import { youtubeRetrievalMode } from "./sourcingPolicy";
import { tierTasksByNeed, describeTierChanges } from "./providerCapability";
import { SOURCING_TIERS, providerTier, tierNumber } from "./sourcingTiers";

/**
 * The tier this pool asks a source in — read from the central ladder, never decided here.
 *
 * A source the ladder has never heard of goes strictly LAST rather than into a default tier. That
 * is the one behaviour the integrity audit forbids defaulting: a provider silently landing in
 * tier 4 looks identical to a provider deliberately placed there, and `everyPoolSourceHasATier`
 * fails on it instead. Last is the only position that cannot cause a classified tier to be skipped.
 */
export function poolTier(source: string): number {
  const tier = providerTier(source);
  if (tier) return tierNumber(tier);
  console.warn(
    `[ScenePool] provider "${source}" has no tier in sourcingTiers.PROVIDER_TIER — ` +
      `asked last so it cannot displace a classified tier`
  );
  return SOURCING_TIERS.length + 1;
}

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

/**
 * RONDE 244 — the archive scan, injected for the same reason the YouTube search is.
 *
 * Structural, so this module never acquires database access or an opinion about what a good
 * archive match is. The caller passes the curated route's own scan; this file only translates.
 */
export type ArchivePoolSearch = () => Promise<
  ReadonlyArray<{ asset: ArchiveRowLike; score?: number | null; archiveName?: string | null }>
>;
import type { YoutubeLicenseMode } from "./videoPipeline";
import type { VisualIntent as RankingIntent } from "./visualMatchingV2/types";
import {
  emptyQueryContext,
  getSearchProvenance,
  searchGateDecision,
  withQueryScope,
  withSearchProvenance,
} from "./searchQueryContract";
import { getActiveVideoId } from "./videoGenerationCancel";

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
  /**
   * THE QUERY THIS CANDIDATE CAME BACK FOR.
   *
   * The pool records `queries` for the whole scene, but the ranking engine's `keywordScore`
   * normaliser wants the string THIS candidate answered — and every provider search already holds
   * it: each builds its candidates inside `for (const query of queries)`. It was simply never
   * carried out of that loop, so `poolCandidateToAsset` had nothing to pass and set `searchQuery`
   * to `""`, which reads to the engine as "asked, and the answer was empty".
   *
   * Optional because a candidate can reach the pool from a cache or a route with no single query
   * behind it. Absent stays absent — the adapter passes null rather than inventing one.
   */
  searchQuery?: string;

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
  /** If true, skip Internet Archive. */
  skipInternetArchive?: boolean;
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
  /**
   * RONDE 246 — how many sentences this scene has, so the tiered run can stop when it has enough.
   *
   * Absent means never stop early: every tier is asked. A caller that does not say how many
   * sentences it has cannot be told it has enough for them, and guessing here would turn a missing
   * fact into a confident early exit.
   */
  beatCount?: number;
  /**
   * RONDE 244 — the operator's own archive, injected for exactly the reason YouTube's search is.
   *
   * `PoolCandidateSource` has listed `"archive"` since this pool was written and nothing ever
   * produced one: the union admitted a source the pool could not receive. So the archive was
   * reachable only through `fetchCuratedArchiveBeatClip`, a route beside the pool rather than in
   * it — which means an excellent archive clip and a poor YouTube one were never compared, each
   * winning or losing on which route happened to run first.
   *
   * This module gains no database access and no notion of a good archive match. The caller passes
   * the curated route's own scan, with its scoring, niche tags and budgets intact; absent means
   * the archive is simply not one of this pool's sources, which is what happens on every route
   * that does not supply it.
   */
  archiveSearch?: ArchivePoolSearch;
  /**
   * P0-8 — WHAT KIND OF PICTURE THIS SCENE NEEDS, so the tier order can answer for THIS scene.
   *
   * The same `{ preferred, acceptable }` shape `selectCandidatesFromPool` already takes, and the
   * same registry answers both — but this one arrives BEFORE any provider is asked, which is the
   * decision the capability registry could not reach until now. See `tierTasksByNeed`.
   *
   * Absent means the tiers are exactly the constants the author wrote, which is what the prefetch
   * route gets: it runs during TTS, before any beat's intent exists, and inventing a need there
   * would be a guess driving real API calls.
   */
  mediaFormNeed?: { preferred: readonly MediaForm[]; acceptable: readonly MediaForm[] };
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

  for (const rawQuery of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // widened, substituted or repaired into a different question. The pool simply has one
    // candidate source fewer. The gate may NARROW a query to its canonical form, which asks
    // something smaller rather than something else — see `narrowToCanonicalQuery`.
    const gate = searchGateDecision("pexels", rawQuery, "scenePool:searchPexelsCandidates");
    if (!gate.admitted) continue;
    /* §3: the CANONICAL text is what this provider is asked. The gate owns the
       semantics; everything below adds only this provider's own syntax. */
    const query = gate.text;
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
          searchQuery: query,
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

  for (const rawQuery of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // widened, substituted or repaired into a different question. The pool simply has one
    // candidate source fewer. The gate may NARROW a query to its canonical form, which asks
    // something smaller rather than something else — see `narrowToCanonicalQuery`.
    const gate = searchGateDecision("pixabay", rawQuery, "scenePool:searchPixabayCandidates");
    if (!gate.admitted) continue;
    /* §3: the CANONICAL text is what this provider is asked. The gate owns the
       semantics; everything below adds only this provider's own syntax. */
    const query = gate.text;
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
          searchQuery: query,
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

  for (const rawQuery of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // widened, substituted or repaired into a different question. The pool simply has one
    // candidate source fewer. The gate may NARROW a query to its canonical form, which asks
    // something smaller rather than something else — see `narrowToCanonicalQuery`.
    const gate = searchGateDecision("wikimedia", rawQuery, "scenePool:searchWikimediaCandidates");
    if (!gate.admitted) continue;
    /* §3: the CANONICAL text is what this provider is asked. The gate owns the
       semantics; everything below adds only this provider's own syntax. */
    const query = gate.text;
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
            searchQuery: query,
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

  for (const rawQuery of queries) {
    // RONDE 91 (§4): the central gate, per query. A refused query is skipped — never
    // widened, substituted or repaired into a different question. The pool simply has one
    // candidate source fewer. The gate may NARROW a query to its canonical form, which asks
    // something smaller rather than something else — see `narrowToCanonicalQuery`.
    const gate = searchGateDecision("internet_archive", rawQuery, "scenePool:searchInternetArchiveCandidates");
    if (!gate.admitted) continue;
    /* §3: the CANONICAL text is what this provider is asked. The gate owns the
       semantics; everything below adds only this provider's own syntax. */
    const query = gate.text;
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
            searchQuery: query,
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
  /**
   * RONDE 88A P3 — the pool runs above the beat loop, so it states the SCENE and no beat.
   *
   * `beat=?` on a pool query is the truthful answer: the pool is asked once per scene, before any
   * beat is being filled. `scene=?` was not — `req.sceneIndex` has always been right here. Merged
   * rather than replaced (see withQueryScope), so a beat scope that is already open keeps its own,
   * more specific identity.
   */
  return withQueryScope({ videoId: getActiveVideoId(), sceneIndex: req.sceneIndex }, () => {
    if (getSearchProvenance()) return buildSceneCandidatePoolInner(req);
    return withSearchProvenance(emptyQueryContext(req.sceneText ?? ""), () =>
      buildSceneCandidatePoolInner(req)
    );
  });
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
    skipPexels = false,
    skipPixabay = false,
    skipInternetArchive = false,
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
  /**
   * RONDE 246 — DEFERRED, and grouped into tiers.
   *
   * This was `Promise<...>[]`, and `tasks.push(searchX(...))` therefore STARTED each search at
   * push time: the list was already running before anyone could decide whether it should. Holding
   * thunks is what makes "do not ask tier 4 when tier 1 covered the scene" expressible at all.
   *
   * Within a tier nothing changes — its members still run together under `Promise.allSettled`, so
   * one slow or broken provider neither serialises its neighbours nor takes their results with it.
   * See `runTieredRetrieval` for the trade this makes and what pays for it.
   *
   * ── THE INTEGRITY AUDIT: these numbers used to be a SECOND tier table ──────────────────────
   *
   * They were written here as literals, and five of them disagreed with `sourcingTiers.ts`:
   * europeana, openverse, nasa, nara and loc all sat at 4 — the same tier as Pexels and Pixabay.
   * Since `runTieredRetrieval` stops as soon as a tier covers the scene, that is not a cosmetic
   * disagreement. It meant the open collections could never be asked BEFORE licensed stock; they
   * were asked beside it, and skipped with it. A render whose tier 3 came back thin went straight
   * to a tier where a Pexels answer and a Library of Congress answer were equally likely to be the
   * one it kept.
   *
   * `poolTier` reads the central ladder instead, so this list can no longer hold an opinion of its
   * own about order. The grouping is still real work — it is what lets a covered scene stop early
   * — but the grouping is now the pipeline's one ordering, not a copy of it that drifted.
   */
  const tasks: RetrievalTask<{ candidates: PoolCandidate[]; apiCalls: number; source: string; ms: number }>[] = [];

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
    tasks.push({ tier: poolTier("pexels"), source: "pexels", run: () =>
      searchPexelsCandidates(queries, pexelsApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pexels",
        ms: Date.now() - liveT0,
      }))
    });
  }
  if (!noteSkip("pixabay", skipPixabay, Boolean(pixabayApiKey)) && pixabayApiKey) {
    tasks.push({ tier: poolTier("pixabay"), source: "pixabay", run: () =>
      searchPixabayCandidates(queries, pixabayApiKey, maxPerSource).then(r => ({
        ...r,
        source: "pixabay",
        ms: Date.now() - liveT0,
      }))
    });
  }
  tasks.push({ tier: poolTier("wikimedia"), source: "wikimedia", run: () =>
    searchWikimediaCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "wikimedia",
        ms: Date.now() - liveT0,
      }))
  });

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
    const youtubeSearch = req.youtubeSearch;
    /**
     * The licence question this pool asks YouTube.
     *
     * The fallback used to be a hardcoded `"creative_common"`, and `youtubeLicenseMode` had NO
     * production caller — so every render's ranked YouTube retrieval was Creative Commons only,
     * from a default nobody had chosen. It now falls through to the project's sourcing policy, so
     * a caller that does not name a mode gets the authorised one rather than the narrowest one.
     */
    const mode = req.youtubeLicenseMode ?? youtubeRetrievalMode();
    /**
     * Built with `.then` rather than an async IIFE, like every other task above.
     *
     * Not a style preference: RONDE 3's guard asserts this whole block contains no `await`, because
     * an await HERE would run the providers one after another instead of building promises for
     * `Promise.allSettled` to run together. An IIFE's await is in fact still parallel, but the
     * guard is a text scan and cannot see that — and a guard that has to be reasoned around is one
     * people edit. Matching the established shape keeps it exact.
     */
    tasks.push({ tier: poolTier("youtube_cc"), source: "youtube_cc", run: () =>
      youtubePoolCandidates({
        /**
         * MASTER YOUTUBE BUILD — the whole query list, like every other provider in this file.
         *
         * This was `queries[0]`. Pexels, Wikimedia and Internet Archive all receive `queries`;
         * YouTube alone received its first element, so a beat with four good search angles asked
         * YouTube about one of them. The ranking engine can only choose from what retrieval
         * returned, so a one-phrasing pool made the ranking decorative for this source.
         *
         * The adapter bounds how many it issues (MAX_YOUTUBE_QUERIES_PER_BEAT) and stops early
         * once the pool is full, so this widens the search without spending unbounded quota.
         */
        queries: queries.length > 0 ? queries : [primaryQuery],
        sceneIndex,
        mode,
        maxResults: maxPerSource,
        /** Narrowed before the thunk: `req.youtubeSearch` is optional and the guard is outside. */
        search: youtubeSearch,
      }).then(({ candidates, log, apiCalls }) => {
        console.log(log);
        return {
          candidates: candidates as unknown as PoolCandidate[],
          /** The searches actually issued — one per query, not a hardcoded 1. */
          apiCalls,
          source: "youtube_cc",
          ms: Date.now() - liveT0,
        };
      })
    });
  } else {
    skipped.youtube_cc = "no_search_function_supplied";
  }
  // FASE 2 — Priority A historical/open sources: no API key required for Internet Archive
  // (like Wikimedia); Europeana needs a key, same shape as Pexels/Pixabay above.
  /**
   * RONDE 244 — the operator's own archive, as one more entry in this same task list.
   *
   * Pushed here rather than given a phase of its own, because the point is precisely that it is
   * ranked ALONGSIDE the others: an excellent archive clip beating a poor YouTube one is a
   * comparison the pool can make and the old two-route arrangement could not.
   *
   * `noteSkip` records the absence with the same vocabulary as every other source, so a render
   * that had no archive search wired says so rather than looking like an archive with nothing in
   * it — the distinction that kept this gap invisible for as long as it lasted.
   */
  if (req.archiveSearch && !noteSkip("archive", false, true)) {
    const archiveSearch = req.archiveSearch;
    tasks.push({ tier: poolTier("archive"), source: "archive", run: () =>
      archivePoolCandidates({
        sceneIndex,
        maxResults: maxPerSource,
        search: archiveSearch,
      }).then((r) => ({
        candidates: r.candidates,
        log: r.log,
        apiCalls: 0,
        source: "archive",
        ms: Date.now() - liveT0,
      }))
    });
  } else if (!req.archiveSearch) {
    skipped["archive"] = "not_wired";
  }

  if (!noteSkip("internet_archive", skipInternetArchive, true)) {
    tasks.push({ tier: poolTier("internet_archive"), source: "internet_archive", run: () =>
      searchInternetArchiveCandidates(queries, maxPerSource).then(r => ({
        ...r,
        source: "internet_archive",
        ms: Date.now() - liveT0,
      }))
    });
  }
  // VIDEO 619 — Europeana, Openverse, NASA, NARA and the Library of Congress are removed: none
  // of them delivered footage to a finished film from render 597 to 619 (see REMOVED_PROVIDERS).

  if (Object.keys(skipped).length > 0) {
    console.log(`[ProviderSkipped] scene=${sceneIndex} ${formatProviderSkips(skipped)}`);
  }

  const rawCandidates: PoolCandidate[] = [];
  /**
   * RONDE 246 — the accumulation is UNCHANGED; it simply runs once per tier instead of once.
   *
   * Every line below did exactly this before, in a single pass over one `allSettled`. Keeping it
   * byte-for-byte and moving only when it runs is deliberate: the per-source cache write, the
   * api-call bookkeeping and the latency record are all load-bearing, and a tier change is not a
   * licence to quietly rewrite them.
   */
  const absorb = (results: PromiseSettledResult<{ candidates: PoolCandidate[]; apiCalls: number; source: string; ms: number }>[]): void => {
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
  };

  /**
   * Enough when there are distinct candidates enough that every sentence COULD have one — see
   * `enoughForEveryBeat` for why that is the true, weaker claim and not "the scene is covered".
   *
   * Measured on what has arrived so far, deduped the way the final pool will be, so a tier that
   * returned forty near-copies of one asset does not read as forty candidates.
   */
  /**
   * P0-8 — THE TIER TABLE, RE-ANSWERED FOR THIS SCENE'S NEED.
   *
   * Every `tier:` above is a constant: the same number on every beat of every topic. That is the
   * defect `contextualSourcePriority` already names for the ranking table one layer down — pexels
   * and pixabay outranking both archives on a beat dated to 1945 — except here it decides what is
   * FETCHED rather than how what came back is ordered, and `runTieredRetrieval` stops as soon as a
   * tier satisfies the scene, so a source in a late tier may not be asked at all.
   *
   * No source is added or dropped, no key is read, no skip flag is touched, and the movement is
   * bounded at one tier. See `tierTasksByNeed` for the rule and for why it has no threshold to tune.
   */
  const tieredTasks = tierTasksByNeed(tasks, req.mediaFormNeed);
  {
    const changes = describeTierChanges(tasks, tieredTasks);
    if (changes) console.log(`${changes} (scene ${sceneIndex})`);
  }

  const tierReport = await runTieredRetrieval({
    tasks: tieredTasks,
    onTierResults: absorb,
    satisfied: () =>
      enoughForEveryBeat({
        beatCount: req.beatCount,
        distinctCandidates: dedupCandidates(rawCandidates).length,
      }),
    log: (line) => console.log(line),
  });
  if (tierReport.stoppedEarly) {
    console.log(
      `[ScenePool] Scene ${sceneIndex}: covered after ${tierReport.tiersRun} tier(s) — ` +
        `tier(s) ${tierReport.tiersSkipped.join(",")} were not asked`
    );
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
 * ── Who decides ─────────────────────────────────────────────────────────────────────────────
 *
 * `POOL_RANKING_V2` decides, in both directions, when it is set at all. When it is NOT set, this
 * follows `CINEMATIC_EDITING_ENGINE`: on for the cinematic route, off for the legacy one.
 *
 * That inheritance is deliberate (RONDE 170) and it is also a real coupling worth stating plainly,
 * because on a deployment that never sets `POOL_RANKING_V2` — which is the normal case — turning
 * the cinematic editing engine off ALSO changes which asset every beat picks, and nothing about the
 * name of that switch says so. `describePoolRankingV2()` exists so the render's own route line can
 * report which of the two decided, rather than leaving an operator to work it out from two
 * variables.
 *
 * The reason for binding it to that route rather than switching it on globally: the legacy compose
 * path has years of tuning built around the keyword scorer's behaviour, and changing what every
 * existing render picks is not something an integration round should do as a side effect.
 */
export function poolRankingV2Enabled(): boolean {
  return describePoolRankingV2().on;
}

/**
 * The same answer, plus which switch produced it.
 *
 * `decidedBy` is the honest part: "explicit" means an operator asked for this, "cinematic_route"
 * means it was inherited. A log line that says only `POOL_RANKING_V2=on` cannot tell those apart,
 * and they call for completely different actions when a render ranks its footage unexpectedly.
 *
 * Not `source`. In this codebase that word means the provider a clip came from, in the pool's own
 * candidate type and in every report built on it — and `ronde203ProviderMatrix` reads the pool's
 * provider list straight out of this file's `source: "..."` literals, so a second meaning here
 * would put "explicit" in a table of footage providers.
 */
export function describePoolRankingV2(): {
  on: boolean;
  decidedBy: "explicit" | "cinematic_route";
} {
  const explicit = (process.env.POOL_RANKING_V2 ?? "").trim().toLowerCase();
  if (explicit === "true") return { on: true, decidedBy: "explicit" };
  if (explicit === "false") return { on: false, decidedBy: "explicit" };
  return {
    on: (process.env.CINEMATIC_EDITING_ENGINE ?? "").trim().toLowerCase() === "true",
    decidedBy: "cinematic_route",
  };
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
  /**
   * What KIND of picture this beat needs, from `mediaFormsForIntent`.
   *
   * Carried through to the ranking engine so the source-priority table can answer for THIS beat
   * instead of applying one fixed order to every beat of every topic. Optional and absent-safe:
   * without it the engine uses `DEFAULT_SOURCE_PRIORITY` exactly as it always did.
   */
  mediaFormNeed?: { preferred: readonly MediaForm[]; acceptable: readonly MediaForm[] };
};

/**
 * The beat's own words, tokenised — extracted from `selectCandidatesFromPool` unchanged.
 */
function beatTokensFor(beatText: string, powerWord: string, keywords: string[]): string[] {
  return Array.from(new Set(
    [powerWord, ...keywords, ...beatText.toLowerCase().split(/\s+/)]
      // RONDE 88A: fold before the ASCII strip. Without it "Führerbunker" became "fhrerbunker",
      // which no provider's title, tag or description contains — the beat's most distinctive word
      // scored zero against every candidate that actually showed it.
      .map(t => foldSearchText(t).replace(/[^a-z0-9]/g, ""))
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
    // RONDE 88A: folded on this side too — see beatTokensFor. Both sides of a comparison have to
    // agree about what a word is, or the fix on one side only moves the mismatch.
  ].map(t => foldSearchText(t).replace(/[^a-z0-9]/g, "")).filter(t => t.length > 2);

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
      /**
       * The beat's media-form need, so `contextualSourcePriority` can re-answer the source table
       * for this beat. Omitted when the beat proved nothing, which is the same as before.
       */
      ...(ctx.mediaFormNeed ? { mediaFormNeed: ctx.mediaFormNeed } : {}),
    });

    return settleRepetition(ranked, (c) => c.rankingScore ?? 0, pool, ctx).slice(0, count);
  }

  const scored = pool.candidates.map(c => ({
    candidate: c,
    score: keywordRelevanceScore(c, beatTokensFor(beatText, powerWord, keywords), powerWord),
  }));

  scored.sort((a, b) => b.score - a.score);
  /**
   * RONDE 206 — the keyword branch settles repetition too.
   *
   * ── What was wrong ────────────────────────────────────────────────────────────────────────
   *
   * The penalty used to live inside the branch above, which runs only when
   * `poolRankingV2Enabled()`. On a deployment where that is off — and unless `POOL_RANKING_V2` is
   * set it simply follows `CINEMATIC_EDITING_ENGINE` — R180 handed this function a usage ledger and
   * nothing ever read it. Every beat of a scene ranked the SAME pool by keyword overlap alone and
   * sorted it stably, which is deterministic and deterministically returns the same candidate
   * first.
   *
   * Both branches ship. Which one a render uses is a matter of configuration, so the repetition
   * rule has to hold in both; that is the whole point of applying it here as well.
   *
   * The damage lands precisely where it is hardest to see: on a TIE. Two stock clips whose titles
   * both carry the beat's nouns score identically, so beat 0 and beat 1 both took the first one —
   * the same picture twice, a few seconds apart, with a perfectly good alternative in the pool.
   *
   * ── Why applying it here is safe ─────────────────────────────────────────────────────────
   *
   * This scorer returns a COUNT: one per matched stem, three extra for a power word in the title.
   * The largest duplicate penalty is 0.35. A candidate that is more relevant by even a single
   * matched word therefore cannot be displaced by having been used before — repetition settles
   * ties and never overrules the picture being right, which is RULE 7 exactly.
   *
   * And it is not a second ranker. Relevance is decided entirely by the sort above; this only
   * adjusts the order that sort produced, the same way it has always adjusted the engine's.
   */
  const keywordScores = new Map(scored.map((s) => [s.candidate, s.score] as const));
  return settleRepetition(
    scored.map((s) => s.candidate),
    (c) => keywordScores.get(c) ?? 0,
    pool,
    ctx
  ).slice(0, count);
}

/**
 * Apply R170's duplicate penalty to an order that has already been decided.
 *
 * Shared by both branches of `selectCandidatesFromPool` so there is ONE place that decides what a
 * repeat costs. The alternative — a copy in each branch — is how the two routes would end up
 * disagreeing about whether a shot counts as repeated, which is the kind of difference that only
 * shows up as a finished video with the same clip in it twice.
 *
 * Without a ledger there is nothing to be a duplicate OF, and the incoming order stands untouched.
 */
function settleRepetition<T extends { source: PoolCandidateSource; assetId: string }>(
  ordered: readonly T[],
  scoreOf: (candidate: T) => number,
  pool: SceneCandidatePool,
  ctx?: PoolSelectionContext
): T[] {
  if (!ctx?.usageLedger) return [...ordered];
  return penaliseDuplicates({
    ranked: ordered,
    identityOf: (c) => ({ provider: c.source, providerAssetId: c.assetId }),
    scoreOf,
    ledger: ctx.usageLedger,
    at: ctx.at ?? { sceneIndex: pool.sceneIndex, beatIndex: 0 },
  }).map((r) => r.candidate);
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
/**
 * RONDE 602 — what the thumbnail ranker actually reads.
 *
 * It was typed `PoolCandidate[]`, and it touches four of that type's twenty-odd fields. The
 * difference stopped mattering the moment a second caller appeared: the YouTube cascade route has
 * rows the existing mapper turns into a `YoutubePoolCandidate`, which carries every field this
 * function reads and four fewer than `PoolCandidate` declares. Widening the parameter to the shape
 * the body uses lets that caller in without inventing `sourceCreator: null` to satisfy a compiler.
 *
 * Generic, so every existing caller still gets its own type back.
 */
export type ThumbnailRankable = Pick<
  PoolCandidate,
  "id" | "assetId" | "thumbnailUrl" | "clipSimilarity"
>;

export async function rankCandidatesByThumbnailClip<T extends ThumbnailRankable>(
  candidates: T[],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  sceneIndex: number,
  beatIndex: number
): Promise<T[]> {
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

  const downloadThumb = async (candidate: T): Promise<void> => {
    if (!candidate.thumbnailUrl) return;
    const ext = candidate.thumbnailUrl.includes(".png") ? ".png" : ".jpg";
    const tmpPath = path.join(
      tmpDir,
      // ascii-safe: filename, not search text.
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
