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
 * Search YouTube and return pool candidates.
 *
 * The search function is INJECTED — this is the existing `searchYoutubeVideoCandidates`, with its
 * quota cooldown, its RapidAPI fallback and its licence handling. Nothing here re-implements any
 * of it, and nothing here holds a key.
 */
export async function youtubePoolCandidates(params: {
  query: string;
  sceneIndex: number;
  mode: YoutubeLicenseMode;
  maxResults?: number;
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
}): Promise<{ candidates: YoutubePoolCandidate[]; log: string }> {
  const max = params.maxResults ?? 8;
  let rows: YoutubeRowLike[] = [];
  let failure: string | null = null;
  try {
    rows = await params.search(
      params.query,
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
     */
    failure = (err as Error).message?.slice(0, 120) ?? "unknown error";
  }

  const candidates: YoutubePoolCandidate[] = [];
  let withoutId = 0;
  for (const row of rows) {
    const c = youtubeRowToPoolCandidate(row, params.mode, params.retrievedAt);
    if (c) candidates.push(c);
    else withoutId++;
  }

  const log =
    `[Retrieval] s${params.sceneIndex} source=youtube mode=${params.mode} ` +
    (failure
      ? `attempted=true failed=true reason=${JSON.stringify(failure)}`
      : `attempted=true candidates=${candidates.length}` +
        (withoutId > 0 ? ` dropped_no_id=${withoutId}` : ""));

  return { candidates, log };
}
