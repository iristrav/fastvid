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

import type { MediaForm } from "./beatVisualIntent";
import { type UsageLedger } from "./duplicateGuard";
import { type YoutubeRowLike } from "./youtubePoolSource";


import { tierTasksByNeed, describeTierChanges } from "./providerCapability";
import { SOURCING_TIERS, providerTier, tierNumber } from "./sourcingTiers";
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
