/**
 * RONDE 169/170 — YouTube as a POOL CANDIDATE, so it can win on merit instead of on position.
 *
 * ── What the R160 audit found, and why this file is the fix ─────────────────────────────────
 *
 * There are two places a clip can be chosen in this codebase, and they behave completely
 * differently:
 *
 *   the CASCADE   `HISTORICAL_SOURCE_TIER_ORDER` — internet_archive, then youtube_cc, then
 *                 wikimedia… First tier that returns anything usable wins and the rest are never
 *                 asked. Under a cascade, POSITION IS THE RANKING.
 *
 *   the POOL      `buildSceneCandidatePool` gathers from ten providers and then chooses between
 *                 them. This is where quality can outrank source — and `PoolCandidateSource` did
 *                 not include YouTube at all.
 *
 * So YouTube could only ever be reached through the cascade, where being second in a fixed list is
 * the whole of its chance. RULE 6 asks that an excellent YouTube clip be able to beat a poor
 * archive one; that is impossible while YouTube is not in the pool the ranking runs over.
 *
 * ── What this file is NOT ────────────────────────────────────────────────────────────────────
 *
 * Not a second YouTube client. It does no searching, no downloading, no licence checking and holds
 * no key. `searchYoutubeVideoCandidates` is injected, so the caller passes the SAME function the
 * cascade already uses — with its quota cooldown, its RapidAPI fallback, its licence modes and its
 * per-render budgets intact. This file translates that function's rows into the pool's vocabulary
 * and nothing else. RULE 4 and RULE 5, in one shape.
 */
import type { RankablePoolCandidate } from "./poolRanking";
import type { YoutubeLicenseMode } from "./videoPipeline";

/**
 * The subset of a YouTube search row this adapter reads.
 *
 * Declared structurally rather than imported so this module does not depend on the 39k-line
 * pipeline. A test asserts the two shapes stay compatible.
 */
export type YoutubeRowLike = {
  item: {
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
    };
  };
  title: string;
  desc: string;
  thumb?: string;
  rel: number;
};

/**
 * §4 of RONDE 160, carried through: everything the provider said about the video, kept.
 *
 * `license` is METADATA and never permission. `retrievedUnder` records which question was asked —
 * `any` filtered nothing and therefore asserts nothing, which is why `reported` is absent for it.
 */
export type YoutubeCandidateMeta = {
  youtubeVideoId: string;
  title: string;
  channel: string | null;
  publishedAt: string | null;
  thumbnail: string | null;
  description: string | null;
  license: { reported?: string; retrievedUnder: string };
  /** When this render asked. Not the upload date — that is `publishedAt`. */
  retrievedAt: string;
};

export type YoutubePoolCandidate = RankablePoolCandidate & {
  source: "youtube_cc";
  youtube: YoutubeCandidateMeta;
};

/**
 * One YouTube row, in the pool's vocabulary.
 *
 * ── Why width, height and duration are null ──────────────────────────────────────────────────
 *
 * The YouTube Data API's `search` endpoint returns none of them: it returns a snippet. A separate
 * `videos.list` call would, and costs quota this render has a budget for. §7's rule decides the
 * rest — an unmeasured value is NULL, never a plausible-looking default. `rankCandidates`
 * redistributes the weight of a signal a candidate carries no data for, so a null costs nothing
 * while a fabricated 1920x1080 would score as "measured, and good".
 *
 * ── Why the canonical URL is the watch page ─────────────────────────────────────────────────
 *
 * `remoteUrl` on a pool candidate is what a downloader is pointed at, and for YouTube that is the
 * watch URL the existing download layer already takes — never a media URL this code resolved
 * itself, which would bypass the licence gate that layer owns.
 */
export function youtubeRowToPoolCandidate(
  row: YoutubeRowLike,
  mode: YoutubeLicenseMode,
  retrievedAt = new Date().toISOString()
): YoutubePoolCandidate | null {
  const videoId = row.item.id?.videoId?.trim();
  /** No id means nothing downstream could ever fetch it again. Dropped, not patched. */
  if (!videoId) return null;

  const snippet = row.item.snippet ?? {};
  const thumb = row.thumb ?? snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url ?? null;
  const title = (row.title || snippet.title || "").trim();

  return {
    /** The pool's dedup key, in the pool's own `${source}:${assetId}` shape. */
    id: `youtube_cc:${videoId}`,
    assetId: videoId,
    source: "youtube_cc",
    remoteUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: thumb,
    title,
    description: (row.desc || snippet.description || "").trim() || null,
    tags: [],
    mediaType: "video",
    durationSec: null,
    /**
     * The licence LABEL, which is what the pool's `license` field is for. The full assertion —
     * including which mode asked — lives in `youtube.license` below, because the pool's field is a
     * string and the distinction between "YouTube says CC" and "nobody filtered" is not one a
     * string can carry honestly.
     */
    license: mode === "any" ? null : mode,
    width: null,
    height: null,
    clipSimilarity: null,
    /**
     * The relevance the search layer already measured for this row, passed through as the
     * embedding-similarity signal rather than recomputed. It is a keyword-overlap score in 0..1
     * from `scoreVisualRelevance`, which is the same kind of quantity.
     */
    embeddingSimilarity: Number.isFinite(row.rel) ? Math.max(0, Math.min(1, row.rel)) : null,
    rankingScore: null,
    youtube: {
      youtubeVideoId: videoId,
      title,
      channel: snippet.channelTitle?.trim() || null,
      publishedAt: snippet.publishedAt ?? null,
      thumbnail: thumb,
      description: (row.desc || snippet.description || "").trim() || null,
      license: {
        retrievedUnder: mode,
        ...(mode === "creative_common" ? { reported: "creativeCommon" } : {}),
        ...(mode === "youtube" ? { reported: "youtube" } : {}),
      },
      retrievedAt,
    },
  };
}

/**
 * How many of a beat's queries YouTube is asked, at most.
 *
 * Every query is one Data API search and therefore real quota. Six is enough for the pool to hold
 * results from several angles on a beat — the event, the person, the place, the period — while
 * staying far below the per-render download budget that governs what can actually be used.
 *
 * The cap is on QUERIES ISSUED, not on queries considered: the caller ranks them, and this takes
 * the best ones.
 */
export const MAX_YOUTUBE_QUERIES_PER_BEAT = 6;

/**
 * Search YouTube and return pool candidates.
 *
 * The search function is INJECTED — this is the existing `searchYoutubeVideoCandidates`, with its
 * quota cooldown, its RapidAPI fallback and its licence handling. Nothing here re-implements any
 * of it, and nothing here holds a key.
 *
 * ── MASTER YOUTUBE BUILD — why this takes a LIST of queries ─────────────────────────────────
 *
 * It used to take one string, and `buildSceneCandidatePool` handed it `queries[0]`. Every other
 * provider in that file receives the whole `queries` array; YouTube alone got the first element,
 * so a beat with four good search angles asked YouTube about one of them and then ranked whatever
 * that single phrasing happened to return.
 *
 * That is the difference between "YouTube is a source" and "YouTube is a source we actually
 * search". A pool of five results from one phrasing cannot be ranked into a good choice; the
 * ranking engine can only pick the best of what retrieval brought it.
 *
 * Queries are issued in the order given — the caller has already ranked them — and stop early once
 * the pool is full, so a beat whose first query answers well does not spend quota on the rest.
 */
export async function youtubePoolCandidates(params: {
  /** The beat's queries, best first. A single string is accepted for callers that have one. */
  queries: readonly string[] | string;
  sceneIndex: number;
  mode: YoutubeLicenseMode;
  maxResults?: number;
  /** Cap on searches issued; see MAX_YOUTUBE_QUERIES_PER_BEAT. */
  maxQueries?: number;
  search: (
    query: string,
    sceneIndex: number,
    license: YoutubeLicenseMode,
    relevanceKeywords: string[],
    minRelevanceScore: number,
    requiredPersonName: string,
    maxResults: number
  ) => Promise<YoutubeRowLike[]>;
  relevanceKeywords?: string[];
  minRelevanceScore?: number;
  requiredPersonName?: string;
  retrievedAt?: string;
}): Promise<{ candidates: YoutubePoolCandidate[]; log: string; apiCalls: number }> {
  const max = params.maxResults ?? 8;
  const requested = typeof params.queries === "string" ? [params.queries] : [...params.queries];
  /** Empty and duplicate phrasings are dropped before they cost a search. */
  const queries = [...new Set(requested.map((q) => q.trim()).filter(Boolean))].slice(
    0,
    Math.max(1, params.maxQueries ?? MAX_YOUTUBE_QUERIES_PER_BEAT)
  );

  const candidates: YoutubePoolCandidate[] = [];
  /** Provider identity, so the same video found by two queries is one candidate. */
  const seenVideoIds = new Set<string>();
  const failures: string[] = [];
  let withoutId = 0;
  let duplicates = 0;
  let apiCalls = 0;

  for (const query of queries) {
    if (candidates.length >= max) break;
    /**
     * One line per query, so a production log answers "what did this beat actually ask YouTube".
     * The query is beat-derived text and carries no credential; the key lives in the injected
     * search function and never reaches this module.
     */
    console.log(
      `[SearchQuery] beat=s${params.sceneIndex} type=youtube query=${JSON.stringify(query)} ` +
        `reason=pool_query_${queries.indexOf(query) + 1}_of_${queries.length}`
    );
    let rows: YoutubeRowLike[] = [];
    try {
      apiCalls += 1;
      rows = await params.search(
        query,
        params.sceneIndex,
        params.mode,
        params.relevanceKeywords ?? [],
        params.minRelevanceScore ?? 0,
        params.requiredPersonName ?? "",
        max
      );
    } catch (err) {
      /**
       * §8 — a source that FAILED and a source that found nothing are different facts, and a log
       * that cannot tell them apart cannot answer "why was YouTube not used for this beat".
       *
       * One query failing no longer takes the beat's whole YouTube search down with it: quota
       * errors and transient 5xx are exactly what the other angles exist to survive.
       */
      failures.push((err as Error).message?.slice(0, 120) ?? "unknown error");
      continue;
    }

    for (const row of rows) {
      const c = youtubeRowToPoolCandidate(row, params.mode, params.retrievedAt);
      if (!c) {
        withoutId++;
        continue;
      }
      if (seenVideoIds.has(c.assetId)) {
        duplicates++;
        continue;
      }
      seenVideoIds.add(c.assetId);
      candidates.push(c);
      if (candidates.length >= max) break;
    }
  }

  const log =
    `[Retrieval] s${params.sceneIndex} source=youtube mode=${params.mode} ` +
    `queries=${queries.length} searches=${apiCalls} candidates=${candidates.length}` +
    (duplicates > 0 ? ` deduped=${duplicates}` : "") +
    (withoutId > 0 ? ` dropped_no_id=${withoutId}` : "") +
    (failures.length > 0 ? ` failed=${failures.length} reason=${JSON.stringify(failures[0])}` : "");

  return { candidates, log, apiCalls };
}
