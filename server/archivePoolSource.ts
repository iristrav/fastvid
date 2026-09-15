/**
 * RONDE 244 — THE OPERATOR'S OWN ARCHIVE AS A POOL CANDIDATE, so it can be ranked against the rest.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * `PoolCandidateSource` has listed `"archive"` since the pool was written. Nothing ever produced
 * one. The union admitted a source the pool could not receive, which is a particularly quiet way
 * for a gap to survive: every type-level search for "is the archive in the pool" answers yes.
 *
 * So the archive was reachable only through `fetchCuratedArchiveBeatClip` — a separate route with
 * its own scoring, its own budget and its own dedup, running beside the pool rather than in it.
 * That is exactly the shape RONDE 169 described for YouTube before it was adapted:
 *
 *     the CASCADE   first source that returns anything usable wins; POSITION IS THE RANKING.
 *     the POOL      gathers from every source and then chooses; quality can outrank source.
 *
 * While the archive sits outside the pool, an excellent archive clip and a poor YouTube one are
 * never compared — each wins or loses on which route ran first. Putting it in the pool is what
 * makes "the best picture for this sentence" a question the ranking can actually answer.
 *
 * ── What this file is NOT ────────────────────────────────────────────────────────────────────
 *
 * Not a second archive engine. It does not query the database, score assets, apply niche tags,
 * dedup against the render, or know what a good archive match is. `search` is INJECTED, so the
 * caller passes the SAME archive search the curated route already uses, with its scoring and its
 * budgets intact. This file translates its rows into the pool's vocabulary and nothing else.
 *
 * That is deliberate and it is the whole design: a second source-selection engine is the one thing
 * this pipeline must not grow, and the way to avoid growing one is to translate, never re-derive.
 */
/**
 * A type-only import, so this module still has no runtime dependency on the pool it feeds — the
 * same separation `youtubePoolSource` keeps. It extends `PoolCandidate` rather than the narrower
 * `RankablePoolCandidate` the YouTube adapter uses, because the pool's array is typed
 * `PoolCandidate[]` and the YouTube task only reaches it through `as unknown as PoolCandidate[]`.
 * That cast is precisely what let four required fields go unnoticed there; naming the real type is
 * what makes the compiler answer the question instead of being told to stop asking.
 */
import type { PoolCandidate } from "./scenePool";

/**
 * The subset of an archive row this adapter reads.
 *
 * Declared structurally rather than imported from `curatedMediaSourcing`, for the same reason
 * `YoutubeRowLike` is: so this module does not depend on the sourcing engine it adapts. A test
 * asserts the two shapes stay compatible.
 */
export type ArchiveRowLike = {
  id: number;
  title?: string | null;
  storageUrl?: string | null;
  mediaType?: string | null;
  tags?: string[] | string | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  licenseNote?: string | null;
  sourceNote?: string | null;
  archiveId?: number | null;
  sourceCreator?: string | null;
  licenseUrl?: string | null;
};

/** What the injected search already worked out about this asset, kept rather than recomputed. */
export type ArchiveCandidateMeta = {
  assetId: number;
  archiveId: number | null;
  /** The archive's own name, when the caller knows it — for the log, not for the ranking. */
  archiveName: string | null;
  /** The relevance the curated scorer measured. Its scale is the scorer's, not 0..1. */
  archiveScore: number | null;
  retrievedAt: string;
};

export type ArchivePoolCandidate = PoolCandidate & {
  source: "archive";
  archive: ArchiveCandidateMeta;
};

/** Tags arrive as an array or a JSON string depending on the driver; both, or neither, are fine. */
function normaliseTags(raw: ArchiveRowLike["tags"]): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      /** Not JSON — a plain comma list is the other shape seen in this column. */
      return raw.split(",").map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * One archive row, in the pool's vocabulary.
 *
 * ── Why an unmeasured field is null ─────────────────────────────────────────────────────────
 *
 * §7's rule, the same one `youtubeRowToPoolCandidate` follows: a value nobody measured is NULL,
 * never a plausible-looking default. `rankCandidates` redistributes the weight of a signal a
 * candidate carries no data for, so a null costs the candidate nothing — while a fabricated
 * 1920x1080 would score as "measured, and good" and beat an honest candidate that said nothing.
 *
 * ── Why the archive's own score is NOT the embedding similarity ─────────────────────────────
 *
 * YouTube's adapter passes `row.rel` through as `embeddingSimilarity`, and can, because that is a
 * keyword-overlap score in 0..1 — the same kind of quantity. The curated scorer's number is not:
 * it is an unbounded tally of tag, entity and niche matches on its own scale. Feeding it into a
 * 0..1 slot would not be a conversion, it would be a fiction that outranks every real similarity.
 * It is kept in `archive.archiveScore`, where its scale is its own business, and the ranking
 * measures this candidate the way it measures every other one.
 */
export function archiveRowToPoolCandidate(
  row: ArchiveRowLike,
  opts: { archiveName?: string | null; score?: number | null; retrievedAt?: string } = {}
): ArchivePoolCandidate | null {
  const assetId = Number(row.id);
  /** No id, or no file behind it, means nothing downstream could ever fetch it. Dropped, not patched. */
  if (!Number.isFinite(assetId) || assetId <= 0) return null;
  const storageUrl = row.storageUrl?.trim();
  if (!storageUrl) return null;

  const mediaType = row.mediaType === "image" ? "image" : "video";
  const duration = Number(row.durationSec);
  const width = Number(row.width);
  const height = Number(row.height);

  return {
    /** The pool's dedup key, in the pool's own `${source}:${assetId}` shape. */
    id: `archive:${assetId}`,
    assetId: String(assetId),
    source: "archive",
    remoteUrl: storageUrl,
    /** The archive stores no separate thumbnail; the asset itself is what a screen would show. */
    thumbnailUrl: mediaType === "image" ? storageUrl : null,
    title: (row.title ?? "").trim(),
    description: row.sourceNote?.trim() || null,
    tags: normaliseTags(row.tags),
    mediaType,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    /**
     * The operator uploaded it, so the licence question is theirs and already settled — but this
     * field is metadata, not permission, and it reports what the row says rather than asserting
     * anything. An empty note stays null instead of becoming a cheerful "owned".
     */
    license: row.licenseNote?.trim() || null,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    /**
     * Attribution the archive row actually carries, mapped rather than cast past. The YouTube
     * adapter reaches the pool through `as unknown as PoolCandidate[]`, which is why these four
     * fields were never noticed as missing there — a cast silences the one question the type was
     * asked to answer. These two are real columns; the two below are measurements nobody has taken
     * yet, and §7 says an unmeasured value is null.
     */
    sourceCreator: row.sourceCreator?.trim() || null,
    licenseUrl: row.licenseUrl?.trim() || null,
    visionScore: null,
    selectionScore: null,
    archive: {
      assetId,
      archiveId: Number.isFinite(Number(row.archiveId)) ? Number(row.archiveId) : null,
      archiveName: opts.archiveName?.trim() || null,
      archiveScore: Number.isFinite(Number(opts.score)) ? Number(opts.score) : null,
      retrievedAt: opts.retrievedAt ?? new Date().toISOString(),
    },
  };
}

/**
 * Search the operator's archive and return pool candidates.
 *
 * The search is INJECTED — the caller hands in the curated route's own scan, with its scoring,
 * its niche tags and its budget. Nothing here queries a database and nothing here decides what a
 * good match is.
 *
 * A failure is reported, never swallowed into "found nothing": §8's distinction, because a log
 * that cannot tell a broken archive from an empty one cannot answer why the archive was not used.
 */
export async function archivePoolCandidates(params: {
  sceneIndex: number;
  maxResults?: number;
  search: () => Promise<
    ReadonlyArray<{ asset: ArchiveRowLike; score?: number | null; archiveName?: string | null }>
  >;
  retrievedAt?: string;
}): Promise<{ candidates: ArchivePoolCandidate[]; log: string }> {
  const max = params.maxResults ?? 8;
  const candidates: ArchivePoolCandidate[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let duplicates = 0;
  let failure: string | null = null;

  let rows: ReadonlyArray<{ asset: ArchiveRowLike; score?: number | null; archiveName?: string | null }> = [];
  try {
    rows = await params.search();
  } catch (err) {
    failure = (err as Error).message?.slice(0, 120) ?? "unknown error";
  }

  for (const row of rows) {
    if (candidates.length >= max) break;
    const c = archiveRowToPoolCandidate(row.asset, {
      archiveName: row.archiveName,
      score: row.score,
      retrievedAt: params.retrievedAt,
    });
    if (!c) {
      dropped++;
      continue;
    }
    if (seen.has(c.assetId)) {
      duplicates++;
      continue;
    }
    seen.add(c.assetId);
    candidates.push(c);
  }

  const log =
    `[Retrieval] s${params.sceneIndex} source=archive candidates=${candidates.length}` +
    (duplicates > 0 ? ` deduped=${duplicates}` : "") +
    (dropped > 0 ? ` dropped_unusable=${dropped}` : "") +
    (failure ? ` failed=1 reason=${JSON.stringify(failure)}` : "");

  return { candidates, log };
}
