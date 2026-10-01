/**
 * Curated media archive — pick tagged assets from admin libraries for pipeline beats.
 */
import { youtubeResultIsShort } from "./youtubeNonFootage";
import pLimit from "p-limit";
import { exec as execCb } from "child_process";
import { foldSearchText } from "./searchTextNormalize";
import { checkPersonName } from "./searchQueryContract";
import { stitchSourceFloorSec } from "./coverageFillPlan";
import {
  getSourceFloorMemo,
  noteSourceFloorFailure,
  parseSourceFloorFailure,
  sourceFloorWouldFailAgain,
} from "./sourceFloorMemo";
import { containCenterFilter, stillImageMaxSec } from "./stillImagePolicy";
import { preparationKey, runPreparation } from "./preparationCache";
import { extractVisualSearchTags, extractSceneSearchTags, extractEntitySearchTags, extractPrimaryVisualAnchor, extractSalientBeatTokens, extractBeatGeoPlaceTags, isGenericPeopleAsset, isWrongGeoForBeat, inferVideoVisualTopic, isWwiiWarArchiveAsset, refineVisualSearchTagsForTopic, expandBeatTagsWithTranslations, expandBeatTagsWithSynonyms, isGeoWelcomeBeat, buildGeoWelcomeVisualQueries, isCyclingBeat, extractBeatCyclingTags, assetShowsCycling, isCarBeat, extractBeatCarTags, assetShowsCars, isGovernmentBeat, extractBeatGovernmentTags, assetShowsGovernment, isUrbanPlanningBeat, extractBeatUrbanPlanningTags, buildUrbanPlanningVisualQueries, assetShowsUrbanPlanning, isInfrastructureBeat, extractBeatInfrastructureTags, buildInfrastructureVisualQueries, assetShowsInfrastructure, beatMentionsWwiiContent, type VideoVisualTopic } from "./visualBeatTags";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import { withForkRetry } from "./_core/execForkRetry";
import { ffmpegSemaphore } from "./_core/semaphore";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { resolveLocalVideoPath, LOCAL_UPLOADS_DIR } from "./storageLocal";
import { storageGetSignedUrl } from "./storage";
import { buildArchiveStillFilterComplex, buildArchiveStillFilterComplexBoxBlur, buildFitGrayGradedVideoVF, classifyDocGradeSourceKind, buildMatFramedStillVF, buildStillEncodeArgs } from "./documentaryStyle";
import { type MotionGraphicsBudget, type StillStyleContext } from "./motionGraphicsEngine";
import { archiveBlurFillStillsEnabled, archiveVisualMinClipSec, archivePreferVideoClips, framedArchiveStillsEnabled, maxVisualCandidatesPerBeatTry, visualFootageFocusEnabled, archiveTagsPrimaryMatching, semanticRerankClipSkipMin, ffmpegThreadFlag } from "./sourcingPolicy";
import { asVideoTitleString, coerceVisionString } from "./stringCoercion";
import { hydrateBeatScriptVisuals } from "./scriptVisualKeywords";
import { vidrushStillPhotoScale, VIDRUSH_MIN_SOURCE_VIDEO_SEC, type BeatGeoRegion } from "./vidrushQuality";
import {
  formatBelowQualityBar,
  formatTechnicalReject,
  stillResolutionVerdict,
  videoResolutionVerdict,
} from "./technicalMediaGate";
import {
  analyzeBeatSemantics,
  analyzeBeatSemanticsFallback,
  applySemanticAiRerank,
  assetMeetsSemanticMinimum,
  scoreArchiveAssetSemantically,
  semanticMinRelevanceScore,
  semanticVisualMatchingEnabled,
  type BeatSemanticProfile,
  type SemanticMatchResult,
} from "./semanticVisualMatching";
import { goodClipCacheBoost } from "./clipGoodCache";
import {
  clipEmbeddingIndexEnabled,
  beatVisionContextForSearch,
  preRankCuratedCandidatesByClipEmbedding,
} from "./archiveClipEmbedding";
import { applyBackgroundClipAuditScore } from "./clipBackgroundAuditor";
import { buildDocumentaryShotQueries } from "./pipelineSelfHeal";
import { pickInClipStartSec } from "./clipInClipOffset";
import {
  getAllMediaArchives,
  getMediaArchiveAssets,
  normalizeMediaTags,
  updateMediaArchiveAsset,
} from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { STOCK_ARCHIVE_SLUG } from "./stockArchive";
import { preferLessUsed } from "./usageDiversity";
import { throwIfActiveRenderCancelled } from "./videoGenerationCancel";
import { countVisualTagHits, isCuratedHistoricalFootage, isCuratedInterviewAsset, judgeArchiveAsset, judgeArchiveAssetMaterial, judgeArchiveAssetScore, judgeOnScreenText, hasKnownBakedEditText } from "./visualJudge";
import { pipelineWallClockLimitEnabled } from "./config";

/** getMediaArchiveAssets() excludes annotationJson from the SQL query (large, no bulk caller
 *  needs it) — this is the real shape flowing through every list/cache/search path in this
 *  file. annotationJson stays present-but-optional (not omitted) rather than forbidden: a
 *  handful of downstream call sites (AssetDirector ranking) opportunistically read it when a
 *  candidate happens to carry it (e.g. fetched individually elsewhere), and an omitted key
 *  would make those reads a type error instead of the harmless `undefined` they actually are. */
export type ArchiveAssetRow = Omit<MediaArchiveAsset, "annotationJson"> & {
  annotationJson?: MediaArchiveAsset["annotationJson"];
};

// Routed through ffmpegSemaphore — previously this file's own exec() (used for Ken Burns/still
// encoding, called per-beat whenever a curated/stock still image is turned into a clip) ran
// entirely outside FFMPEG_CONCURRENCY_LIMIT despite a comment elsewhere claiming it was already
// gated. withForkRetry() only retries on EAGAIN/fork pressure — it never touches the semaphore.
const execRaw = promisify(execCb);

// F3-12: every call site now passes an explicit timeoutMs. Uses child_process.exec's own native
// `timeout` option (same mechanism F3-06 already established for execFile's ffprobe duration
// probe) instead of a hand-rolled Promise.race — Node itself sends killSignal (default SIGTERM)
// to the child when it runs longer than timeoutMs, so a hung ffmpeg/ffprobe is actually
// terminated rather than merely abandoned. That termination makes execRaw's promise reject,
// which lets withForkRetry (unchanged — still only retries real EAGAIN/fork-pressure errors, a
// timeout error matches neither) propagate the failure, which lets ffmpegSemaphore.run()'s
// `finally` release the slot instead of leaking it forever.
const EXEC_TIMEOUT_PROBE_MS = 15_000; // ffprobe-only calls — same value as F3-06's duration probe
const EXEC_TIMEOUT_ENCODE_MS = 45_000; // Ken Burns still-to-video ffmpeg encodes (filter_complex)
const EXEC_TIMEOUT_TRIM_MS = 35_000; // ffmpeg trim/re-encode — matches videoPipeline.ts's own trimDownloadedStockClip budget
// Production fix (log-confirmed): unlike videoPipeline.ts's own exec() (which calls
// throwIfActiveRenderCancelled() before every spawn — see its comment on that check), this
// file's exec() never checked cancellation at all. A Railway production log showed exactly the
// consequence: once a render was cancelled/superseded (a stall-requeue's requestVideoGenerationCancel,
// or an explicit user cancel), videoPipeline.ts's own ffmpeg calls (e.g. trimRemoteVideoToClip)
// correctly started failing with "Video generation cancelled" — but curated-archive trims/Ken
// Burns encodes routed through *this* exec() kept running ffmpeg successfully for the rest of
// that render's already-cancelled lifetime (18+ minutes in the observed log), burning CPU and
// ffmpegSemaphore slots that the real, still-running attempt for the same video needed. Adding
// the same check here closes that gap without changing anything about this exec()'s existing
// semaphore/timeout/retry behavior for a render that hasn't been cancelled.
//
// Exported only for direct testability (F3-12) — same zero-behavior-change pattern used
// throughout F3-05 through F3-10 for other module-private functions.
//
// `async` here is deliberate, not incidental: videoPipeline.ts's own exec() is declared `async`
// for the exact same reason (its throwIfActiveRenderCancelled() call is the first line of its
// body too) — inside an async function body, a synchronous throw is automatically converted into
// a rejected Promise, matching this function's existing Promise-returning contract exactly. A
// plain (non-async) arrow function that throws before its first `return` would instead throw
// synchronously out of the call site itself, which every caller here already assumes can't happen
// (they all `await`/`.catch()` this call expecting a rejection, never a synchronous throw).
export const exec = (async (cmd: string, timeoutMs: number, opts?: Record<string, unknown>) => {
  throwIfActiveRenderCancelled();
  return ffmpegSemaphore.run(() =>
    withForkRetry(() => execRaw(cmd, { ...(opts ?? {}), timeout: timeoutMs } as never))
  );
}) as (cmd: string, timeoutMs: number, opts?: Record<string, unknown>) => ReturnType<typeof execRaw>;
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const CLIP_MIN_SEC = 2.5;
const CLIP_MAX_SEC = 7.0;

export type CuratedBeatContext = {
  keywords: string[];
  text: string;
  index: number;
  searchQuery?: string;
  powerWord?: string;
  /** Visual director on-screen description — primary match source (not spoken narration). */
  visualDescription?: string;
  /** LLM-generated English stock search queries — used for archive tag matching too. */
  pexelsQueries?: string[];
};

export type BeatMatchTags = {
  /** Words/phrases from this beat's narration — primary match keys. */
  beatTags: string[];
  /** Main subject only (1 token) — used as last-resort fallback when beatTags find nothing. */
  mainSubject: string[];
  /** Topic from video title/prompt — niche filter, lower weight per beat. */
  topicAnchors: string[];
  allTags: string[];
  videoVisualTopic: VideoVisualTopic;
  /** True when this beat has a visual description or search query to search on. Note:
   *  hydrateBeatScriptVisuals (scriptVisualKeywords.ts) always synthesizes a fallback search
   *  query from the beat text when the caller doesn't set one explicitly (down to a
   *  last-resort generic default), so in practice this is true for nearly every beat — it's
   *  a defensive gate for the rare case a beat truly has nothing to search on, not a strong
   *  abstract-vs-literal classifier. Phase 10: feeds the VisualJudge's archive literalVisualTags
   *  gate, which was previously always called with an empty array (dead code). */
  hasLiteralVisual: boolean;
  /** Tags extracted from that literal visual description/search query specifically (a subset
   *  of allTags's sources) — only meaningful when hasLiteralVisual is true. */
  literalVisualTags: string[];
};

export type CuratedSceneContext = {
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
};

/**
 * Stable dedup key for compose + cross-beat checks.
 *
 * Defined in `visualSourceLineage` — it is a ledger key before it is a sourcing detail, and the
 * replay engine needs it without dragging this module's graph along. Re-exported here so every
 * existing caller keeps importing it from where it has always lived.
 */
export { curatedAssetContentKey } from "./visualSourceLineage";

export function curatedClipPathAssetId(filePath: string): number | null {
  const m = path.basename(filePath).match(/_curated_a(\d+)(?:_still)?\.mp4$/i);
  return m ? Number(m[1]) : null;
}

/** Beat clip from archive still (Ken Burns applied in prepareCuratedArchiveClip). */
export function isCuratedPreparedStillClip(filePath: string): boolean {
  return /_curated_a\d+_still\.mp4$/i.test(path.basename(filePath));
}

/** Ken Burns still with intentional blur-fill sides (archive, Wikimedia, Openverse, etc.). */
export function isPipelineBlurFillStillClip(filePath: string): boolean {
  if (isCuratedPreparedStillClip(filePath)) return true;
  const base = path.basename(filePath);
  /**
   * RONDE 165 — `_still` is the marker every still now carries.
   *
   * The provider list below names the sources that had a filename rule; loc, nara, nasa,
   * internet_archive and europeana never did, so their photographs were labelled as whatever came
   * next. The download stamps `_still` for any image-derived clip, so the marker answers for all
   * of them without a sixth provider pattern.
   */
  if (/_still\.mp4$/i.test(base)) return true;
  return /_wiki_|_openverse_|_serp_|_unsplash_|_p0_|_p2_/i.test(base) && /\.mp4$/i.test(base);
}

/** Beat clip from archive video — already trimmed and framed to 1080p in prepareCuratedArchiveClip. */
export function isCuratedPreparedVideoClip(filePath: string): boolean {
  return /_curated_a\d+\.mp4$/i.test(path.basename(filePath)) && !isCuratedPreparedStillClip(filePath);
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

function clampHoldSec(holdSec: number): number {
  
  return Math.max(CLIP_MIN_SEC, Math.min(CLIP_MAX_SEC, holdSec));
}

const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "were", "was", "are", "has", "had",
  "his", "her", "its", "their", "about", "into", "over", "after", "before", "when", "where",
  "what", "how", "why", "who", "which", "your", "you", "our", "not", "but", "all", "one",
  "rise", "fall", "story", "world", "life", "video", "documentary", "history", "historical",
  "them", "they", "then", "than", "just", "amidst",
]);

/** High-signal topic tokens from the video title/prompt (e.g. hitler, titanic). */
const SHORT_TOPIC_TOKENS = new Set([
  "ww2", "wwii", "ww1", "ufo", "cia", "fbi", "dna", "nazi", "ss", "kgb",
]);

export function extractTopicAnchorTags(videoTitle?: unknown, extraText?: unknown): string[] {
  // RONDE 51: fold diacritics before the ASCII strip (see searchTextNormalize) — otherwise
  // "Führerbunker" arrives here as "f hrerbunker" and the anchor tag is lost.
  const raw = foldSearchText([asVideoTitleString(videoTitle), asVideoTitleString(extraText)].join(" "))
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        (w.length >= 4 || SHORT_TOPIC_TOKENS.has(w)) && !QUERY_STOP_WORDS.has(w)
    );
  return normalizeMediaTags(raw).slice(0, 8);
}

/** Tokenize narration into searchable tags (beat text first). */
function tokenizeBeatText(raw: unknown): string[] {
  const text = asVideoTitleString(raw).trim();
  if (!text) return [];
  return normalizeMediaTags(
    // RONDE 51: same folding as extractTopicAnchorTags — this is the function that produced
    // beatTags: [claustrophobic, depths, hrerbunker] in render 530.
    foldSearchText(text)
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !QUERY_STOP_WORDS.has(w))
  );
}

/** Build beat-specific vs topic tags for archive title/tag matching. */
export function buildBeatMatchTags(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  videoTitle?: string
): BeatMatchTags {
  const anchored = hydrateBeatScriptVisuals(beat);
  const beatText = asVideoTitleString(coerceVisionString(anchored.text));
  const sceneText = asVideoTitleString(coerceVisionString(scene.text));
  const titleStr = asVideoTitleString(coerceVisionString(videoTitle));
  const searchQuery = asVideoTitleString(coerceVisionString(anchored.searchQuery));
  const visualDescription = asVideoTitleString(coerceVisionString(anchored.visualDescription));
  const videoVisualTopic = inferVideoVisualTopic(titleStr, [beatText, sceneText].join(" "));
  const topicAnchors = extractTopicAnchorTags(titleStr, [beatText, sceneText].join(" "));
  // English-only sources. beatText is Dutch narration — never use it for tags.
  // Strategy: 1 main subject + 1 specifier + 1 secondary token (max 3 tags total).
  const pexelsQueries = (beat.pexelsQueries ?? []).filter(Boolean);
  const bestQuery = pexelsQueries[0] || searchQuery.trim() || visualDescription.trim();
  const hasLiteralVisual = Boolean(visualDescription.trim() || searchQuery.trim());

  // Main subject: first meaningful token of the best query (e.g. "napoleon")
  const allBestTokens = tokenizeBeatText(bestQuery);
  const mainSubject = allBestTokens.slice(0, 1);

  // 1 specifier from the second token of pexelsQueries[0] or from pexelsQueries[1]
  const specifierSource = pexelsQueries[1] || pexelsQueries[0] || searchQuery.trim();
  const specifier = tokenizeBeatText(specifierSource)
    .filter((t) => !mainSubject.includes(t))
    .slice(0, 1);

  // Round 10B forensic audit (production render, "Why Hitler Killed Himself and His Wife"):
  // a beat naming two people/an entity+event/an entity+location routinely carries a THIRD
  // distinct, meaningful token (e.g. "braun" in "Hitler Eva Braun wedding") that mainSubject+
  // specifier above structurally cannot hold — real archive assets tagged with that second
  // entity (confirmed in production: an asset tagged "eva braun" scored #1 for a beat about
  // "Hitler and Eva Braun exchanged vows", yet the tag-match log/score only ever saw "hitler")
  // were then invisible to this function's own tag-intersection matching and score.log line.
  // Pulled from the same bestQuery tokenization mainSubject already reads — no new extraction
  // source, still deterministic, still capped, purely additive (can only add a tag-match point,
  // never remove one).
  const secondaryToken = allBestTokens
    .filter((t) => !mainSubject.includes(t) && !specifier.includes(t))
    .slice(0, 1);

  const beatTags = normalizeMediaTags([...mainSubject, ...specifier, ...secondaryToken]).slice(0, 3);

  const visualSource = bestQuery;
  const visualTags = extractVisualSearchTags(visualSource, videoTitle);
  const mergedBeat = beatTags;
  const beatLower = beatText.toLowerCase();
  const scopedTopicAnchors = topicAnchors.filter(
    (a) => beatLower.includes(a) || visualTags.some((v) => v.includes(a) || a.includes(v))
  );
  const effectiveTopicAnchors =
    (scopedTopicAnchors.length > 0 ? scopedTopicAnchors : topicAnchors).slice(0, 2);
  // allTags: beatTags (3) + max 2 topic anchors — keep it tight
  const allTags = normalizeMediaTags([...beatTags, ...effectiveTopicAnchors]).slice(0, 5);
  const refinedBeat = expandBeatTagsWithSynonyms(
    expandBeatTagsWithTranslations(
      refineVisualSearchTagsForTopic(mergedBeat, videoVisualTopic, beatText)
    )
  );
  const refinedAll = expandBeatTagsWithSynonyms(
    expandBeatTagsWithTranslations(
      refineVisualSearchTagsForTopic(allTags, videoVisualTopic, beatText)
    )
  );
  return {
    beatTags: refinedBeat,
    mainSubject,
    topicAnchors: effectiveTopicAnchors,
    allTags: refinedAll,
    videoVisualTopic,
    hasLiteralVisual,
    literalVisualTags: hasLiteralVisual ? normalizeMediaTags(visualTags).slice(0, 5) : [],
  };
}

/**
 * Detect clips whose title looks like a broadcast/editorial production notation label
 * that has been pre-burned into the video file (e.g. "MEDIC", "UNCERTAINTY WIDE SHOT MED",
 * "ECU FACE", "CU HANDS"). These clips will show the label on-screen in the output.
 */
function hasProductionNotationTitle(asset: Pick<MediaArchiveAsset, "title">): boolean {
  const title = (asset.title ?? "").trim();
  if (!title) return false;
  // All-uppercase title → likely a production/editorial shot label
  if (title === title.toUpperCase() && /^[A-Z0-9 _\-]+$/.test(title) && title.length <= 60) {
    // Common shot-type words from broadcast archives
    if (/\b(MEDIC|WIDE\s*SHOT|CLOSE\s*UP|MED(?:IUM)?|ECU|BCU|MCU|CU|WS|MS|LS|XLS|OTS|UNCERTAINTY|SHOT|ANGLE|FRAME|SCENE|TAKE|SLATE)\b/.test(title)) {
      return true;
    }
  }
  return false;
}

export function buildCuratedQueryTags(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  videoTitle?: string
): string[] {
  return buildBeatMatchTags(beat, scene, videoTitle).allTags;
}

export type ArchiveRouteInput = {
  name: string;
  description?: string | null;
  nicheTags?: string[] | null;
};

/** Score how well archive metadata matches a video topic (name, description, niche tags). */
export function scoreArchiveMetadata(
  archive: ArchiveRouteInput,
  queryTags: string[],
  anchorTags: string[]
): number {
  const combined = normalizeMediaTags([...queryTags, ...anchorTags]);
  if (!combined.length) return 1;

  const name = archive.name.toLowerCase();
  const desc = (archive.description ?? "").toLowerCase();
  const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
  const nameWords = name.split(/[\s\-_/]+/).filter((w) => w.length >= 3);
  let score = 0;

  for (const q of combined) {
    if (nicheTags.some((t) => t === q || t.includes(q) || q.includes(t))) score += 28;
    if (q.length >= 3 && name.includes(q)) score += 22;
    if (q.length >= 3 && desc.includes(q)) score += 14;
    for (const w of nameWords) {
      if (w === q || w.includes(q) || q.includes(w)) score += 16;
    }
  }

  for (const anchor of anchorTags) {
    if (nicheTags.includes(anchor)) score += 20;
    if (name.includes(anchor)) score += 18;
  }

  return score;
}

function scoreArchiveAssetSample(
  assets: ArchiveAssetRow[],
  combinedTags: string[],
  sampleSize = 48
): number {
  if (!combinedTags.length || !assets.length) return 0;
  let hits = 0;
  for (const asset of assets.slice(0, sampleSize)) {
    const assetTags = normalizeMediaTags(asset.tags ?? []);
    const matched = combinedTags.some(
      (q) =>
        assetTags.some((t) => t === q || t.includes(q) || q.includes(t))
    );
    if (matched) hits++;
  }
  return Math.min(50, hits * 6);
}

export type RankedArchive = {
  id: number;
  name: string;
  score: number;
};

/** Pick the best archive(s) for a video — no manual linking required. */
export async function rankArchivesForVisualQuery(
  queryTags: string[],
  anchorTags: string[] = [],
  opts?: { assetSampleSize?: number; assetsCache?: Map<number, ArchiveAssetRow[]> }
): Promise<RankedArchive[]> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1 && a.slug !== STOCK_ARCHIVE_SLUG);
  if (!archives.length) return [];

  const combined = normalizeMediaTags([...queryTags, ...anchorTags]);
  const ranked: RankedArchive[] = [];

  for (const archive of archives) {
    let score = scoreArchiveMetadata(archive, queryTags, anchorTags);
    if (score < 20 && combined.length > 0) {
      /**
       * Through the render's own asset cache, not a fresh query.
       *
       * This sampling is the expensive half of routing, and routing now runs on the per-beat
       * path (see `resolveArchivesForVisualQuery`). `getMediaArchiveAssets` is an uncached
       * SELECT over every active asset of an archive, so asking it once per beat would add a
       * full scan per sentence — and the budget is already the thing render 593 ran out of.
       * `loadArchiveAssetsForSearch` is the same helper the candidate scan below uses and fills
       * the same map, so the first beat pays for the read and the rest of the render does not.
       */
      const assets = await loadArchiveAssetsForSearch(archive.id, opts?.assetsCache);
      score += scoreArchiveAssetSample(assets, combined, opts?.assetSampleSize ?? 48);
    }
    ranked.push({ id: archive.id, name: archive.name, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

const ARCHIVE_ROUTE_MIN_SCORE = 8;

/**
 * WHICH ARCHIVES MAY ANSWER THIS BEAT — and the outcome that used to be missing.
 *
 * ── What render 593 delivered ───────────────────────────────────────────────────────────────
 *
 * A one-minute video about Kim Kardashian in 2018 was offered clips from a WW2 archive, on
 * every sentence. The picture editor refused each one and said exactly why:
 *
 *     s0b3  "The frames show Adolf Hitler, who is unrelated to the narration about the
 *            Kardashians."
 *     s1b0  "The clip shows historical footage of Adolf Hitler, which is unrelated to the
 *            narration about Kim Kardashian and Khloe Kardashian."
 *     s2b0  "a historical event likely from early 20th century Europe, unrelated to the
 *            narration about a modern E! News interview with Kim Kardashian."
 *
 *     [Quality] bron ww2 leverde 7 beoordeelde kandidaten en geen enkele bruikbare (UNRELATED)
 *     [Quality] score=0/100, clips=15 [ww2=1, UNVERIFIED=10, wikimedia=4]
 *
 * One WW2 clip reached the montage anyway, and the export gate refused the film for
 * `10/16 beat(s) got ONLY a card`. The render spent 18 of its 25 minutes on sourcing.
 *
 * ── The two holes, and the one that mattered ────────────────────────────────────────────────
 *
 * The 593 log contains NO `[ArchiveRouter]` line at all. Every branch below prints one, so the
 * function was never called: all four production call sites of `listCuratedArchiveCandidates`
 * pass `searchAllArchives: true`, which used to take every active archive and skip routing
 * entirely. The router was written, and no sourcing route read it.
 *
 * And it would not have helped if they had. There was no outcome meaning "nothing here fits":
 * a score below the floor fell through to "using anyway", and no score at all fell through to
 * `return archives` — every archive, which is the opposite of a routing decision. A router
 * whose worst case is "all of them" cannot keep anything out.
 *
 * ── What changes, and what deliberately does not ────────────────────────────────────────────
 *
 * The scoring is untouched: `scoreArchiveMetadata`, `scoreArchiveAssetSample` and
 * `ARCHIVE_ROUTE_MIN_SCORE` are exactly as they were. What is added is the fourth outcome —
 * tags present, nothing scored above zero, so NO archive answers this beat — and the removal of
 * the `archives.length <= 1` shortcut, which let a single archive through without ever being
 * asked whether it fits.
 *
 * A beat with NO tags at all is left alone on purpose. Relevance cannot be judged without
 * something to judge against, and this codebase's standing rule is that missing information is
 * never a reason to refuse (see `providerCapability`'s note on UNKNOWN). Such a beat keeps the
 * behaviour it had.
 *
 * Returning `[]` is not a coverage loss dressed up as a fix: the caller yields zero curated
 * candidates, and the beat then walks the provider ladder, the rescue routes and the guaranteed
 * fill exactly as a beat whose archive search found nothing always has. What it no longer does
 * is spend the picture editor's budget refusing a different documentary.
 */
export async function resolveArchivesForVisualQuery(
  queryTags: string[],
  anchorTags: string[] = [],
  opts?: {
    /** Every relevant archive (scene-wide pool), or only the strongest one. */
    allRelevant?: boolean;
    /** The render's asset cache, so routing does not re-read the archive per beat. */
    assetsCache?: Map<number, ArchiveAssetRow[]>;
  }
): Promise<Array<Awaited<ReturnType<typeof getAllMediaArchives>>[number]>> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1 && a.slug !== STOCK_ARCHIVE_SLUG);
  if (archives.length === 0) return [];
  const allRelevant = opts?.allRelevant !== false;

  /**
   * Nothing to judge against. Not a match and not a refusal — see the note above on UNKNOWN.
   * This is the one path that still hands back every archive, and it is the honest one.
   */
  if (normalizeMediaTags([...queryTags, ...anchorTags]).length === 0) {
    console.log(
      `[ArchiveRouter] no query tags — relevance cannot be judged, keeping all ${archives.length} active archive(s)`
    );
    return archives;
  }

  const ranked = await rankArchivesForVisualQuery(queryTags, anchorTags, {
    ...(opts?.assetsCache ? { assetsCache: opts.assetsCache } : {}),
  });
  const relevant = ranked.filter((r) => r.score >= ARCHIVE_ROUTE_MIN_SCORE);
  if (relevant.length > 0) {
    const chosen = allRelevant ? relevant : relevant.slice(0, 1);
    const ids = new Set(chosen.map((r) => r.id));
    const selected = archives.filter((a) => ids.has(a.id));
    console.log(
      `[ArchiveRouter] Auto-routed to ${selected.length} archive(s): ${chosen
        .slice(0, 4)
        .map((r) => `"${r.name}" (${r.score})`)
        .join(", ")}` +
        (queryTags.length ? ` | tags: ${queryTags.slice(0, 6).join(", ")}` : "")
    );
    return selected;
  }

  if (ranked[0] && ranked[0].score > 0) {
    const best = archives.find((a) => a.id === ranked[0]!.id);
    if (best) {
      console.log(
        `[ArchiveRouter] Best-match archive "${best.name}" (score ${ranked[0].score}) — weak tag overlap, using anyway`
      );
      return [best];
    }
  }

  /**
   * NO_RELEVANT_ARCHIVE — the outcome this router never had. See the note above.
   */
  console.log(
    `[ArchiveRouter] NO_RELEVANT_ARCHIVE — none of ${archives.length} active archive(s) scored ` +
      `above zero for this beat | tags: ${queryTags.slice(0, 6).join(", ") || "(none)"} ` +
      `| best: ${ranked[0] ? `"${ranked[0].name}" (${ranked[0].score})` : "n/a"} ` +
      `— no curated candidates, the beat uses its other routes`
  );
  return [];
}

/** Everything scoreCuratedAsset derives purely from beatText — identical for every candidate
 *  asset scored against the same beat, so callers looping over a candidate pool for one beat
 *  should compute this once (via computeBeatScoringContext) and pass it in, instead of paying
 *  the same ~10 regex/classifier passes again for every single candidate. */
export interface BeatScoringContext {
  visualTags: string[];
  geoTags: string[];
  isCycling: boolean;
  cyclingTags: string[];
  isCar: boolean;
  carTags: string[];
  isGovernment: boolean;
  govTags: string[];
  isUrbanPlanning: boolean;
  planTags: string[];
  isInfrastructure: boolean;
  infraTags: string[];
  anchorWords: string[];
}

export function computeBeatScoringContext(beatText?: string): BeatScoringContext {
  const t = beatText?.trim() ? beatText : undefined;
  const isCycling = !!t && isCyclingBeat(t);
  const isCar = !!t && isCarBeat(t);
  const isGovernment = !!t && isGovernmentBeat(t);
  const isUrbanPlanning = !!t && isUrbanPlanningBeat(t);
  const isInfrastructure = !!t && isInfrastructureBeat(t);
  let anchorWords: string[] = [];
  if (t) {
    const anchor = extractPrimaryVisualAnchor(t);
    if (anchor) {
      anchorWords = anchor.toLowerCase().trim().split(/\s+/).filter((w) => w.length >= 4);
    }
  }
  return {
    visualTags: beatText ? extractVisualSearchTags(beatText) : [],
    geoTags: t ? extractBeatGeoPlaceTags(t) : [],
    isCycling,
    cyclingTags: isCycling ? extractBeatCyclingTags(t!) : [],
    isCar,
    carTags: isCar ? extractBeatCarTags(t!) : [],
    isGovernment,
    govTags: isGovernment ? extractBeatGovernmentTags(t!) : [],
    isUrbanPlanning,
    planTags: isUrbanPlanning ? extractBeatUrbanPlanningTags(t!) : [],
    isInfrastructure,
    infraTags: isInfrastructure ? extractBeatInfrastructureTags(t!) : [],
    anchorWords,
  };
}

/**
 * THE "PERSON-NAME GUARANTEE" THAT NEVER CHECKED FOR A PERSON.
 *
 * ── What the delivered film did ─────────────────────────────────────────────────────────────
 *
 * A 76-second documentary about Hitler's death opened on a modern Brink's armoured security van
 * and held it for seventeen seconds. Its first sentence is:
 *
 *     "Standing on the BRINK of utter defeat, his empire crumbling..."
 *
 * and the van has BRINKS painted down its side. It came back for the closing nineteen seconds,
 * 36.3 of the film's 76 seconds in total.
 *
 * ── What the code said, and what it did ─────────────────────────────────────────────────────
 *
 * The rule this replaces read, in full:
 *
 *     // Person-name guarantee: if a tag names a specific person AND the beat text
 *     // mentions that person → strong boost, clip is guaranteed to rank above generics.
 *     for (const t of assetTags) {
 *       if (t.length >= 4 && bl.includes(t)) { score += 200; beatHits += 3; break; }
 *     }
 *
 * It never asked whether the tag named a person. Any tag of four characters or more that appeared
 * ANYWHERE inside the beat sentence — as a substring, so not even a whole word — scored 200. That
 * is more than twice the next largest term in this function (85 for a double geo hit) and nearly
 * five times an exact tag match (42), which is what "guaranteed to rank above generics" means in
 * practice: one accidental word overlap decides the shot.
 *
 * On a WWII script the overlaps are not rare, they are constant. `bunker`, `defeat`, `empire`,
 * `reich`, `berlin`, `surrender`, `betrayal` are ordinary archive tags and ordinary narration
 * words. Every one of them bought a guaranteed win. Substring matching made it worse: `rink`
 * matched "brink", `eich` matched "Reich".
 *
 * ── What it does now ────────────────────────────────────────────────────────────────────────
 *
 * The guarantee is kept for the case it was written for and taken away from the case it was not.
 * A tag is matched on WHOLE WORDS, and the span it matched is then put to `checkPersonName` —
 * this pipeline's one definition of "is that a person" — reading the beat text with its original
 * capitalisation. A real person mention still scores 200 and still outranks everything. Any other
 * word the narration happens to share with a tag scores below an exact tag match, which is the
 * ordering the rest of this function already encodes: a curated beat tag is better evidence than
 * a word that happens to occur in a sentence.
 *
 * Nothing is relaxed and no film is emptied: a generic overlap still scores, it just no longer
 * wins on its own.
 */
export const PERSON_TAG_BONUS = 200;
export const BEAT_TEXT_WORD_BONUS = 30;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The best reason a tag has to claim this beat — a named person if there is one, otherwise the
 * first whole-word overlap. Returns the span AS WRITTEN in the beat text, because capitalisation
 * is what `checkPersonName` reads and asset tags are stored lower-cased.
 */
export function beatTextTagMatch(
  assetTags: readonly string[],
  beatText: string
): { tag: string; matched: string; isPerson: boolean } | null {
  const text = beatText ?? "";
  if (!text.trim()) return null;
  let generic: { tag: string; matched: string; isPerson: boolean } | null = null;

  for (const raw of assetTags) {
    const tag = (raw ?? "").trim();
    if (tag.length < 4) continue;
    let re: RegExp;
    try {
      re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegex(tag)}(?![\\p{L}\\p{N}])`, "iu");
    } catch {
      /** A tag that cannot be made into a pattern proves nothing; it simply does not match. */
      continue;
    }
    const m = re.exec(text);
    if (!m) continue;
    const matched = m[0];
    /** The whole point: 200 is for a person, and this is the pipeline's only test for one. */
    if (checkPersonName(matched, text).ok) return { tag, matched, isPerson: true };
    if (!generic) generic = { tag, matched, isPerson: false };
  }
  return generic;
}

export function scoreCuratedAsset(
  asset: ArchiveAssetRow,
  archiveNicheTags: string[],
  beatTags: string[],
  topicAnchors: string[] = [],
  beatText?: string,
  videoVisualTopic: VideoVisualTopic = "general",
  beatCtx?: BeatScoringContext
): number {
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  const assetHay = assetTags.join(" ");
  if (judgeArchiveAssetMaterial(asset).decision === "REJECT") return 0;
  let score = 0;
  let beatHits = 0;
  const ctx = beatCtx ?? computeBeatScoringContext(beatText);

  if (beatText?.trim()) {
    const hit = beatTextTagMatch(assetTags, beatText);
    if (hit) {
      score += hit.isPerson ? PERSON_TAG_BONUS : BEAT_TEXT_WORD_BONUS;
      beatHits += hit.isPerson ? 3 : 1;
    }
  }

  for (const q of beatTags) {
    for (const t of assetTags) {
      if (t === q) {
        score += 42;
        beatHits++;
      } else if (t.includes(q) || q.includes(t)) {
        score += 16;
        beatHits++;
      }
    }
  }

  for (const vt of ctx.visualTags) {
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) {
        score += 22;
        beatHits++;
      }
    }
  }

  if (beatText?.trim() && ctx.geoTags.length > 0) {
    const geoHits = countVisualTagHits(asset, ctx.geoTags);
    if (geoHits >= 2) {
      score += 85;
      beatHits += 2;
    } else if (geoHits >= 1) {
      score += 50;
      beatHits++;
    } else if (beatHits < 2) {
      // Only penalize when asset tags don't match the beat at all (geo slugs optional on upload).
      score -= 60;
    }
    if (isWrongGeoForBeat(asset, ctx.geoTags)) score = Math.max(0, score - 250);
  }

  if (ctx.isCycling) {
    const cyclingHits = countVisualTagHits(asset, ctx.cyclingTags);
    if (assetShowsCycling(asset)) {
      score += 55 + cyclingHits * 18;
      beatHits += 2;
    } else {
      score -= 140;
    }
  }

  if (ctx.isCar) {
    const carHits = countVisualTagHits(asset, ctx.carTags);
    if (assetShowsCars(asset)) {
      score += 55 + carHits * 18;
      beatHits += 2;
    } else {
      score -= 140;
    }
  }

  if (ctx.isGovernment) {
    const govHits = countVisualTagHits(asset, ctx.govTags);
    if (assetShowsGovernment(asset)) {
      score += 55 + govHits * 18;
      beatHits += 2;
    } else {
      score -= 140;
    }
  }

  if (ctx.isUrbanPlanning) {
    const planHits = countVisualTagHits(asset, ctx.planTags);
    if (assetShowsUrbanPlanning(asset, beatText)) {
      score += 55 + planHits * 18;
      beatHits += 2;
    } else {
      score -= 140;
    }
  }

  if (ctx.isInfrastructure) {
    const infraHits = countVisualTagHits(asset, ctx.infraTags);
    if (assetShowsInfrastructure(asset, beatText)) {
      score += 55 + infraHits * 18;
      beatHits += 2;
    } else {
      score -= 140;
    }
  }

  if (ctx.anchorWords.length >= 2 && ctx.anchorWords.every((w) => assetHay.includes(w))) {
    score += 48;
    beatHits += 2;
  }

  score += curatedSceneContextScore(asset, beatText);

  // 2+ tag matches = take the clip (strong guaranteed boost)
  if (beatHits >= 2) score += 150;
  if (beatHits >= 3) score += 80;

  const beatLower = beatText?.toLowerCase() ?? "";
  for (const anchor of topicAnchors) {
    const inBeat = beatLower.includes(anchor);
    const topicWeight = inBeat ? 1 : 0.3;
    for (const t of assetTags) {
      if (t === anchor) score += Math.round(16 * topicWeight);
      else if (t.includes(anchor) || anchor.includes(t)) score += Math.round(6 * topicWeight);
    }
    // Note: archive niche-tags intentionally NOT used here —
    // scores must reflect clip title + clip tags only.
  }

  // Note: archive niche-tag vs asset-tag boost intentionally removed —
  // clip relevance is determined solely by the clip's own title and tags.

  if (beatTags.length >= 2 && beatHits === 0) score = Math.max(0, score - 60);

  // Thematic WW2 category boost: if the beat is about WW2/Hitler/war and the clip is
  // a WW2 archive asset, give a base positive score even when tags don't have exact matches.
  // This ensures clips with generic tags ("world war 2 footage") are found for WW2 beats.
  if (isWwiiWarArchiveAsset(asset) && beatMentionsWwiiContent(beatText ?? "")) {
    score += 40;
  }

  score += curatedArchiveVisualBoost(asset);
  score += curatedVideoFootageBoost(asset, beatHits);
  score += curatedActionFootageBoost(asset);
  score += curatedImagePenalty(asset);
  score += curatedPosterPenalty(asset);
  score += curatedStaticInteriorPenalty(asset);
  score += curatedInterviewPenalty(asset);

  // Hard-zero clips with pre-burned production notation titles (defense-in-depth)
  if (hasProductionNotationTitle(asset)) {
    return 0;
  }

  score += applyBackgroundClipAuditScore(asset.id);

  return score;
}

/** Boost scene-matched footage; penalize generic portraits when narration is specific. */
function curatedSceneContextScore(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  beatText?: string
): number {
  if (!beatText?.trim()) return 0;
  const sceneTags = extractSceneSearchTags(beatText);
  const entityTags = extractEntitySearchTags(beatText);
  const salient = extractSalientBeatTokens(beatText).slice(0, 4);
  const required = [...sceneTags, ...entityTags, ...salient];
  if (required.length === 0) return 0;

  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  let score = 0;

  for (const tag of sceneTags) {
    if (hay.includes(tag)) score += 38;
  }
  for (const tag of entityTags) {
    if (hay.includes(tag)) score += 28;
  }
  for (const tag of salient) {
    if (tag.length >= 4 && hay.includes(tag)) score += 16;
  }

  const sceneHits = countVisualTagHits(asset, sceneTags);
  const entityHits = countVisualTagHits(asset, entityTags);
  const salientHits = countVisualTagHits(asset, salient);
  const hasSpecificBeat = sceneTags.length > 0 || entityTags.length > 0 || salient.length >= 2;

  if (hasSpecificBeat && sceneHits === 0 && entityHits === 0 && salientHits === 0) {
    if (isGenericPeopleAsset(asset)) score -= 85;
    else score -= 45;
  } else if (sceneTags.length > 0 && sceneHits === 0) {
    if (/\b(man|men|person|portrait|unknown|civilian|people|crowd)\b/.test(hay)) score -= 55;
    else score -= 30;
  }
  if (entityTags.length > 0 && entityHits === 0 && sceneTags.length > 0 && sceneHits === 0) {
    score -= 20;
  }
  if (sceneHits > 0 && entityHits > 0) score += 25;
  if (sceneHits > 0 && salientHits > 0) score += 18;

  return score;
}


function curatedVideoFootageBoost(
  asset: Pick<MediaArchiveAsset, "mediaType" | "durationSec">,
  beatHits = 0
): number {
  if (!archivePreferVideoClips() || asset.mediaType !== "video") return 0;
  if (beatHits === 0) return 0;
  if (beatHits === 1) return 22;
  let boost = 58;
  if (asset.durationSec != null && asset.durationSec >= 3) boost += 12;
  return boost;
}

function curatedImagePenalty(asset: Pick<MediaArchiveAsset, "mediaType">): number {
  if (!archivePreferVideoClips() || asset.mediaType !== "image") return 0;
  return -95;
}

function curatedInterviewPenalty(asset: Pick<MediaArchiveAsset, "title" | "tags">): number {
  return isCuratedInterviewAsset(asset) ? -140 : 0;
}

/** Posters, portraits, propaganda stills — look like frozen photos in the montage. */
export function isCuratedPosterOrStillAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType">
): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return /\b(portret|portrait|poster|propagandabeeld|propaganda poster|affiche|foto|photo|still|portrait)\b/i.test(
    hay
  );
}

/** Bunker/cell/interior shots — often a single static frame even as MP4. */
export function isCuratedStaticInteriorAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags">
): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return /\b(cel met|bunker|interieur|bed en tafel|fuhrerbunker|slachthuis|gevangenis|kamer met)\b/i.test(
    hay
  );
}

function curatedStaticInteriorPenalty(asset: Pick<MediaArchiveAsset, "title" | "tags">): number {
  return isCuratedStaticInteriorAsset(asset) ? -55 : 0;
}

function curatedPosterPenalty(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType">): number {
  return isCuratedPosterOrStillAsset(asset) ? -80 : 0;
}

/** Parades, speeches, crowds — clearly moving archival footage. */
export function isCuratedActionFootage(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType">
): boolean {
  if (asset.mediaType !== "video") return false;
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return /\b(parade|toespraak|speech|militair|march|rally|bijeenkomst|ceremonie|troepen|crowd|sporting|gebouw|omgeving)\b/i.test(
    hay
  );
}

function curatedActionFootageBoost(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType">): number {
  return isCuratedActionFootage(asset) ? 32 : 0;
}

function curatedArchiveVisualBoost(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">): number {
  if (isCuratedHistoricalFootage(asset)) return 35;
  if (asset.mixKind === "photo") return 20;
  return 0;
}

function resolveArchiveAssetLocalPath(asset: ArchiveAssetRow): string | null {
  const fromUrl = resolveLocalVideoPath(asset.storageUrl);
  if (fromUrl) return fromUrl;
  if (asset.storageKey) {
    const fromKey = path.join(LOCAL_UPLOADS_DIR, asset.storageKey.replace(/\//g, "_"));
    if (fs.existsSync(fromKey)) return fromKey;
  }
  if (asset.storageUrl.startsWith("/local-storage/")) {
    const fileName = asset.storageUrl.replace(/^\/local-storage\//, "");
    const p = path.join(LOCAL_UPLOADS_DIR, fileName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function listCuratedArchiveCandidates(
  beatTags: string[],
  excludeIds: Set<number>,
  excludeStorageUrls: Set<string>,
  topicAnchors: string[] = [],
  filterTags?: string[],
  beatText?: string,
  assetsCache?: Map<number, ArchiveAssetRow[]>,
  /** When true, score assets in every active archive (per-sentence search). */
  searchAllArchives = false,
  /** When true, never dump the entire archive as score-1 fallback (sentence montage). */
  noUniversalFallback = false,
  videoVisualTopic: VideoVisualTopic = "general"
): Promise<CuratedCandidatePick[]> {
  const queryTags = filterTags ?? normalizeMediaTags([...beatTags, ...topicAnchors]);
  /**
   * ROUTED, ALWAYS. `searchAllArchives` no longer means "skip the router".
   *
   * It used to take every active archive and never call `resolveArchivesForVisualQuery` at all,
   * and all four production call sites pass `true` — which is why render 593's log contains no
   * `[ArchiveRouter]` line and why a WW2 archive answered a video about Kim Kardashian.
   *
   * The flag keeps the job its name describes, INSIDE relevance: `true` admits every archive the
   * router finds relevant (the scene-wide pool wants breadth), `false` narrows to the strongest.
   * Neither admits an archive that scored nothing. See `resolveArchivesForVisualQuery`.
   */
  const archives = await resolveArchivesForVisualQuery(queryTags, topicAnchors, {
    allRelevant: searchAllArchives,
    ...(assetsCache ? { assetsCache } : {}),
  });
  if (!archives.length) return [];

  const scored: CuratedCandidatePick[] = [];
  const fallback: CuratedCandidatePick[] = [];
  // beatText is fixed for this whole call — compute its derived tags/classifiers once instead
  // of re-deriving them from scratch for every candidate asset scored below (can be hundreds).
  const beatCtx = computeBeatScoringContext(beatText);

  for (const archive of archives) {
    const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
    const assets = await loadArchiveAssetsForSearch(archive.id, assetsCache);
    for (const asset of assets) {
      if (excludeIds.has(asset.id)) continue;
      if (excludeStorageUrls.has(asset.storageUrl)) continue;
      // RONDE 22: adoption would throw on this asset anyway — don't spend a pick (and a
      // download) rediscovering that. See hasKnownBakedEditText.
      if (hasKnownBakedEditText(asset)) continue;
      /** ONE ROUTE: not documentary material is the VisualJudge's rule, asked here before scoring. */
      if (judgeArchiveAssetMaterial(asset).decision === "REJECT") continue;
      const score = scoreCuratedAsset(asset, nicheTags, beatTags, topicAnchors, beatText, videoVisualTopic, beatCtx);
      // RONDE 9 (render 519): a NEGATIVE score is active evidence of a mismatch — it must never
      // be laundered into the score=1 "no signal" floor (assets scoring -65 were adopted for
      // beats they demonstrably did not fit). Only a true no-signal (score === 0) may floor to 1.
      // ONE ROUTE — the refusal of a negative score is the VisualJudge's (`judgeArchiveAssetScore`).
      if (judgeArchiveAssetScore(score).decision === "REJECT") continue;
      scored.push({
        asset,
        score: Math.max(score, 1),
        archiveName: archive.name,
        archiveNicheTags: nicheTags,
      });
    }
  }

  if (scored.length === 0 && fallback.length === 0 && archives.length > 0) {
    // Still score every candidate against the video's general topic (nicheTags, videoVisualTopic)
    // instead of a flat score=1 for the whole archive — a beat with no exact tag match should
    // fall back to the archive's next-most-relevant clip, not a literally random one. tryOrder
    // downstream (fetchCuratedArchiveBeatClip) walks this list roughly by score, so a genuine
    // topic match still gets tried well before an unrelated clip.
    for (const archive of archives) {
      const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
      const assets = await loadArchiveAssetsForSearch(archive.id, assetsCache);
      for (const asset of assets) {
        if (excludeIds.has(asset.id)) continue;
        if (excludeStorageUrls.has(asset.storageUrl)) continue;
        if (hasKnownBakedEditText(asset)) continue; // RONDE 22 — unadoptable, see above
        /** ONE ROUTE: not documentary material is the VisualJudge's rule, asked here before scoring. */
        if (judgeArchiveAssetMaterial(asset).decision === "REJECT") continue;
        const score = scoreCuratedAsset(asset, nicheTags, [], [], beatText, videoVisualTopic, beatCtx);
        // RONDE 9: same rule as the primary pool — the VisualJudge refuses a negative score.
        if (judgeArchiveAssetScore(score).decision === "REJECT") continue;
        fallback.push({ asset, score: Math.max(score, 1), archiveName: archive.name, archiveNicheTags: nicheTags });
      }
    }
  }

  const pool = scored.length > 0 ? scored : fallback;

  /**
   * ONE ROUTE — no "pool exhausted, allow reuse" tier: the same asset twice in one film is the
   * dedup's hard rule, and the fetch below skips used assets and the push refuses them anyway, so
   * re-offering them only spent a scan. An empty pool sends the beat to the suppliers.
   */
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: ArchiveAssetRow) => (x.mediaType === "video" ? 2 : 0);
    return videoBoost(b.asset) - videoBoost(a.asset);
  });
  return pool;
}

export function orderCuratedCandidatesForBeat(
  candidates: CuratedCandidatePick[],
  preferImages = false
): CuratedCandidatePick[] {
  if (preferImages) {
    const images = candidates.filter((c) => c.asset.mediaType === "image");
    const videos = candidates.filter((c) => c.asset.mediaType === "video");
    if (images.length > 0) return [...images, ...videos];
  }
  if (!archivePreferVideoClips()) return candidates;
  const videos = candidates.filter((c) => c.asset.mediaType === "video");
  const images = candidates.filter((c) => c.asset.mediaType === "image");
  if (videos.length === 0) return candidates;
  return [...videos, ...images];
}

async function probeMediaDurationSec(filePath: string): Promise<number> {
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      EXEC_TIMEOUT_PROBE_MS
    );
    const dur = parseFloat(String(probe.stdout).trim());
    return !isNaN(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

/** Persistent on-disk cache for assets fetched from S3/R2 — survives across renders on the
 * same volume, so repeat use of the same archive clip (the common case) skips the network. */
const ARCHIVE_S3_CACHE_DIR = path.join(LOCAL_UPLOADS_DIR, "archive-s3-cache");

function archiveS3CachePath(key: string): string {
  return path.join(ARCHIVE_S3_CACHE_DIR, key.replace(/\//g, "_"));
}

/** Distinguishes two temp names within one process; the pid separates processes. */
let archiveCacheWriteSeq = 0;

// Caps concurrent archive-asset network downloads. Unlike ffmpeg/ffprobe spawns (already
// gated by ffmpegSemaphore), these fetch() calls had no limit — under a burst of many
// scenes/beats downloading at once on a modest host, that could open more simultaneous
// outbound TLS connections than the box could service, causing some to fail mid-handshake
// ("Client network socket disconnected before secure TLS connection was established") even
// though the storage endpoint itself was reachable and fast.
// Raised from 4 -> 8 alongside the CPU upgrade (2 -> 4 vCPU), then dialed back to 5 after
// the Hetzner graphs showed the server pinned at 400% (100% on all 4 cores) for a sustained
// period, unresponsive enough to lock out Coolify's own dashboard. This download concurrency
// isn't the only consumer (CLIP embedding, ffmpeg, LLM calls all compete for the same cores),
// but it's the one lever here that's cheap to turn down without touching render quality.
// Override via env if a future server resize warrants a different value without a code change.
function archiveDownloadConcurrency(): number {
  const raw = process.env.ARCHIVE_DOWNLOAD_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 32) return n;
  }
  return 5;
}
const archiveDownloadLimit = pLimit(archiveDownloadConcurrency());

// F3-10: streams the response body straight to destPath (stream/promises' pipeline()) instead
// of Buffer.from(await resp.arrayBuffer()) — archive assets can be tens of MB, and this path is
// the highest-frequency download in the render pipeline (archive is the preferred visual
// source). AbortSignal.timeout(timeoutMs) is unchanged — it already covers the body-read, not
// just headers, so no timeout behavior changes here, only where the bytes end up while in
// transit. On any error (HTTP not-ok, stream failure, or a completed-but-undersized file) the
// caller's existing throw-and-fallback contract is preserved exactly, and any partial destPath
// is removed before the error propagates.
async function streamArchiveAssetDownload(url: string, destPath: string, timeoutMs: number): Promise<void> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`Archive asset download HTTP ${resp.status}`);
  try {
    await pipeline(resp.body!, fs.createWriteStream(destPath));
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    throw err;
  }
  if (fs.statSync(destPath).size < 500) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    throw new Error("Archive asset download too small");
  }
}

export async function materializeArchiveAsset(asset: ArchiveAssetRow, destPath: string): Promise<void> {
  const local = resolveArchiveAssetLocalPath(asset);
  if (local) {
    fs.copyFileSync(local, destPath);
    return;
  }
  if (asset.storageUrl.startsWith("/manus-storage/")) {
    const key = asset.storageKey ?? asset.storageUrl.replace(/^\/manus-storage\//, "");
    const cachePath = archiveS3CachePath(key);
    /**
     * A CACHE HIT THAT FAILS IS A CACHE MISS, NOT A DEAD ASSET.
     *
     * Render 566 lost eighteen distinct archive assets to twenty-eight of these:
     *
     *     [Pipeline] Scene 2 beat 1: curated asset 57364 failed: ENOENT: no such file or directory,
     *     copyfile '/app/uploads/archive-s3-cache/media-archive_37_…mp4' -> '/var/tmp/…mp4'
     *
     * The ENOENT is on the SOURCE — the cache file `existsSync` had just confirmed. Between the
     * check and the copy it was gone, which is what a non-atomic cache write produces: the writer
     * below used to `copyFileSync(destPath, cachePath)` straight onto the live path, and
     * `copyFileSync` TRUNCATES its target before refilling it. Two renders wanting the same asset —
     * the normal case, since a scene reuses its best archive clips across beats — put one process
     * inside that window while another was reading it. A redeploy's SIGTERM mid-copy leaves the
     * same hole.
     *
     * Both halves are fixed: the write is atomic (below), and a failed read falls through to the
     * download instead of failing the asset. The fallthrough is not papering over the race — it is
     * the correct behaviour for a CACHE, whose entries may legitimately vanish at any moment
     * (eviction, a wiped ephemeral volume, a half-written file from a killed process). Nothing is
     * silent: the miss is logged with its reason.
     */
    if (fs.existsSync(cachePath)) {
      try {
        fs.copyFileSync(cachePath, destPath);
        return;
      } catch (err) {
        console.warn(
          `[CuratedMedia] cache entry for ${key} could not be read (${(err as Error).message}) — ` +
            `re-fetching from storage`
        );
        try { fs.unlinkSync(cachePath); } catch { /* already gone, which is the point */ }
      }
    }
    await archiveDownloadLimit(async () => {
      const signedUrl = await storageGetSignedUrl(key);
      await streamArchiveAssetDownload(signedUrl, destPath, 120_000);
      try {
        fs.mkdirSync(ARCHIVE_S3_CACHE_DIR, { recursive: true });
        /**
         * Written beside the entry and renamed onto it. `rename` within one filesystem is atomic,
         * so a concurrent reader sees either the previous complete file or the new complete file,
         * and never the truncation window `copyFileSync` opened. The temp name carries the pid and
         * a counter so two writers cannot collide on it either.
         */
        const tmpPath = `${cachePath}.${process.pid}.${archiveCacheWriteSeq++}.tmp`;
        try {
          fs.copyFileSync(destPath, tmpPath);
          fs.renameSync(tmpPath, cachePath);
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
          throw err;
        }
      } catch (err) {
        console.warn(`[CuratedMedia] Failed to cache archive asset ${key}:`, (err as Error).message);
      }
    });
    return;
  }
  const fetchUrl = asset.storageUrl.startsWith("/")
    ? `http://127.0.0.1:${process.env.PORT || 3000}${asset.storageUrl}`
    : asset.storageUrl;
  await archiveDownloadLimit(async () => {
    await streamArchiveAssetDownload(fetchUrl, destPath, 60_000);
  });
}

export type CuratedClipStyleContext = StillStyleContext & {
  assetId?: number;
  queryEmbedding?: number[] | null;
  trimStartSec?: number;
  /** asset.id → resolved raw file path (one copy per video), for observability only. F3-19:
   *  the actual cross-caller synchronization for the shared raw file lives in
   *  prepareCuratedArchiveClip's module-level sharedRawMaterializations, not here — this map is
   *  no longer read for ownership/cleanup decisions. */
  rawCache?: Map<number, string>;
  /** Lighter FFmpeg trim for 1-min fast path. */
  fastTrim?: boolean;
  /**
   * RONDE 111 — override the slot length the source floor is measured against.
   *
   * Defaults to the requested duration, which is the right answer almost everywhere. A caller
   * that KNOWS the clip is going to be concatenated (the montage coverage backfill) can lower it
   * explicitly, so several short on-topic clips can be stitched instead of the scene falling back
   * to slowed frames. See stitchSourceFloorSec.
   */
  minSourceSec?: number;
};

/** Ken Burns motion — visible pan/zoom for full beat duration (avoids frozen stills). */
async function convertImageToKenBurns(
  imgPath: string,
  outPath: string,
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  styleContext?: CuratedClipStyleContext
): Promise<void> {
  /**
   * RONDE 128 — a photograph is a shot, not a slide.
   *
   * `duration` is whatever the beat asked for, and it had no ceiling: the measured render put a
   * single archive still on screen for tens of seconds. Five seconds is a shot length; past that
   * the pipeline has to find another picture, and the caller reports a coverage gap if it cannot.
   *
   * Capped HERE, at the one function that turns an image into a clip, rather than at each of its
   * callers — a cap a caller has to remember to apply is a cap that eventually gets forgotten.
   */
  const cap = stillImageMaxSec();
  if (duration > cap) {
    console.log(
      `[StillPlan] s${sceneIndex}b${beatIndex}: still capped at ${cap.toFixed(1)}s ` +
        `(asked ${duration.toFixed(1)}s) — the rest of this beat needs another picture`
    );
    duration = cap;
  }
  if (framedArchiveStillsEnabled()) {
    const filterComplex = buildArchiveStillFilterComplex(
      duration,
      sceneIndex,
      beatIndex,
      false
    );
    try {
      await exec(
        `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, filterComplex)}`,
        EXEC_TIMEOUT_ENCODE_MS
      );
    } catch (err) {
      if (archiveBlurFillStillsEnabled()) {
        console.warn(
          `[Curated] Scene ${sceneIndex} beat ${beatIndex}: blur-fill still failed, retrying boxblur:`,
          (err as Error).message?.slice(0, 120)
        );
        try {
          const boxFc = buildArchiveStillFilterComplexBoxBlur(
            duration,
            sceneIndex,
            beatIndex,
            false
          );
          await exec(
            `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, boxFc)}`,
            EXEC_TIMEOUT_ENCODE_MS
          );
          const boxDur = await probeMediaDurationSec(outPath);
          if (boxDur >= duration * 0.85) return;
        } catch {
          /* fall through to gray mat */
        }
        console.warn(
          `[Curated] Scene ${sceneIndex} beat ${beatIndex}: boxblur still failed, retrying gray mat`
        );
        const matFc = buildMatFramedStillVF(duration, vidrushStillPhotoScale());
        await exec(
          `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, matFc)}`,
          EXEC_TIMEOUT_ENCODE_MS
        );
      } else {
        throw err;
      }
    }
  } else {
    /**
     * RONDE 128 — the whole picture, in the middle, at its own shape.
     *
     * What this replaces did three things to every archive photograph: scaled it PAST the frame
     * (`force_original_aspect_ratio=increase` on a 1.12x canvas), cropped the overflow away, and
     * then zoomed and panned across what was left. A documentary shows an archive photograph
     * whole; it does not enlarge it and slide around inside it.
     *
     * `decrease` is the single word that turns cover into contain — the image scales until it
     * fits and never past it — and the pad offsets centre what is left over. No crop, because
     * after a contain scale there is nothing outside the frame to cut. No zoompan at all.
     */
    /**
     * RONDE 656 — held, like every still: the camera move is the timeline's (cameraPlanner →
     * cameraChain), so the encoder bakes none in. RONDE 152's frozen-picture concern is answered
     * there — edlToTimeline gives every still a camera move.
     */
    const preset = process.env.RAILWAY_ENVIRONMENT ? "ultrafast" : "veryfast";
    const contain = containCenterFilter({ widthPx: VIDEO_WIDTH, heightPx: VIDEO_HEIGHT });
    await exec(
      `${ffmpegBin()} -y -loop 1 -i "${imgPath}" -t ${duration.toFixed(3)} ` +
        `-vf "${contain},fps=25,format=yuv420p" ` +
        `-c:v libx264 ${ffmpegThreadFlag()} -preset ${preset} -crf 18 -an "${outPath}"`,
      EXEC_TIMEOUT_ENCODE_MS
    );
  }
  const outDur = await probeMediaDurationSec(outPath);
  if (outDur < duration * 0.85) {
    throw new Error(`Still clip too short (${outDur.toFixed(2)}s < ${duration.toFixed(2)}s)`);
  }
}

type VideoStreamMeta = {
  width: number;
  height: number;
  codec: string;
  pixFmt: string;
};

async function probeVideoStreamMeta(filePath: string): Promise<VideoStreamMeta | null> {
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -select_streams v:0 ` +
        `-show_entries stream=width,height,codec_name,pix_fmt ` +
        `-of csv=p=0 "${filePath}"`,
      EXEC_TIMEOUT_PROBE_MS
    );
    const parts = String(probe.stdout).trim().split(",");
    if (parts.length < 4) return null;
    const width = parseInt(parts[0]!, 10);
    const height = parseInt(parts[1]!, 10);
    const codec = (parts[2] ?? "").toLowerCase();
    const pixFmt = (parts[3] ?? "").toLowerCase();
    if (!width || !height || !codec) return null;
    return { width, height, codec, pixFmt };
  } catch {
    return null;
  }
}

/** Stream-copy trim when source is already 1080p H.264 — skips re-encode. */
function canStreamCopyTrim(meta: VideoStreamMeta | null): boolean {
  if (!meta) return false;
  if (meta.codec !== "h264") return false;
  if (meta.pixFmt && meta.pixFmt !== "yuv420p" && meta.pixFmt !== "yuvj420p") return false;
  return meta.width === VIDEO_WIDTH && meta.height === VIDEO_HEIGHT;
}

async function trimVideoClip(
  inPath: string,
  outPath: string,
  duration: number,
  clipIndex = 0,
  styleContext?: CuratedClipStyleContext,
  sceneIndex = 0,
  beatIndex = 0
): Promise<void> {
  const sourceDur = await probeMediaDurationSec(inPath);
  const minDur = archiveVisualMinClipSec();
  /**
   * RONDE 111 — never demand more source than this slot is going to use.
   *
   * This was a flat 2.8s for every request. Render 536 refused 594 clips against it in one video,
   * while thirteen of that render's eighteen scenes ended up too short for their own voice track
   * and were padded with slowed frames. Some of those refusals were a 2.2-second clip turned away
   * from a 1.5-second gap: a safeguard about whether a clip can carry a beat ON ITS OWN, applied
   * to a slot where it would have been concatenated between two others.
   *
   * stitchSourceFloorSec keeps 2.8s wherever the slot is long enough to want it — so the ordinary
   * beat path is untouched — and lowers it to the slot's own length, never below the point where
   * a clip stops being an edit and becomes a flash frame.
   */
  const minSource = stitchSourceFloorSec(
    styleContext?.minSourceSec ?? duration,
    VIDRUSH_MIN_SOURCE_VIDEO_SEC
  );
  if (sourceDur > 0 && sourceDur < minSource) {
    throw new Error(
      `source video too short (${sourceDur.toFixed(2)}s < ${minSource.toFixed(2)}s for a ${duration.toFixed(2)}s slot)`
    );
  }
  const take = sourceDur > 0 ? Math.max(minDur, Math.min(duration, sourceDur)) : Math.max(minDur, duration);
  let startSec = styleContext?.trimStartSec;
  if (startSec == null || !Number.isFinite(startSec)) {
    startSec =
      styleContext?.assetId != null
        ? pickInClipStartSec(
            sourceDur,
            take,
            styleContext.assetId,
            styleContext.queryEmbedding,
            clipIndex
          )
        : (() => {
            if (sourceDur > take + 0.35) {
              const slack = sourceDur - take;
              return (clipIndex * 0.41 + 0.15) % slack;
            }
            return 0;
          })();
  }
  startSec = Math.max(0, Math.min(Math.max(0, sourceDur - take), startSec));

  const fastTrim = styleContext?.fastTrim === true;
  const streamMeta = await probeVideoStreamMeta(inPath);
  const useStreamCopy = fastTrim && canStreamCopyTrim(streamMeta);

  if (useStreamCopy) {
    try {
      await exec(
        `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inPath}" -t ${take.toFixed(3)} ` +
          `-c copy -avoid_negative_ts make_zero -an "${outPath}"`,
        EXEC_TIMEOUT_TRIM_MS
      );
      const outDur = await probeMediaDurationSec(outPath);
      if (outDur >= take * 0.8) return;
    } catch {
      /* fall through to re-encode */
    }
  }

  const frameVf = fastTrim
    ? "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
    : buildFitGrayGradedVideoVF(classifyDocGradeSourceKind(inPath));
  const preset = fastTrim || process.env.RAILWAY_ENVIRONMENT ? "ultrafast" : "veryfast";
  const crf = fastTrim ? 20 : 18;

  await exec(
    `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inPath}" -t ${take.toFixed(3)} ` +
      `-vf "${frameVf}" -an -c:v libx264 ${ffmpegThreadFlag()} -preset ${preset} -crf ${crf} -pix_fmt yuv420p "${outPath}"`,
    EXEC_TIMEOUT_TRIM_MS
  );

  const outDur = await probeMediaDurationSec(outPath);
  // RONDE 111: the same slot-relative floor as the source check above — a 1.5s result for a 1.5s
  // gap is exactly right, and rejecting it sent the scene back to slowed frames instead.
  if (outDur < minSource) {
    throw new Error(`trimmed clip too short (${outDur.toFixed(2)}s < ${minSource.toFixed(2)}s)`);
  }
  if (outDur < take * 0.8) {
    // Short of the requested duration but still usable — accept it and let
    // padShortClipWithNext (videoPipeline.ts) stitch on the remainder rather
    // than discarding a perfectly good, on-topic clip.
    console.warn(`[CuratedTrim] clip shorter than requested (${outDur.toFixed(2)}s < ${take.toFixed(2)}s) — accepting, will pad`);
  }
}

/**
 * Measures with THIS file's exec — semaphore-gated and cancellation-aware. The threshold it is
 * compared against moved to ./technicalMediaGate in RONDE 133, so the external provider routes
 * apply the same rule; the probe itself stays here on purpose (see that module's note).
 */
async function probeImageWidthPx(filePath: string): Promise<number> {
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${filePath}"`,
      EXEC_TIMEOUT_PROBE_MS
    );
    const w = parseInt(String(probe.stdout).trim(), 10);
    return Number.isFinite(w) && w > 0 ? w : 0;
  } catch {
    return 0;
  }
}

/**
 * RONDE 134 — the same measurement for archive video that the pool route now makes.
 *
 * One ffprobe, both dimensions, through this file's semaphore-gated exec. Returns nulls when it
 * cannot tell, which the shared verdict treats as neutral.
 */
async function probeVideoDimensions(
  filePath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      EXEC_TIMEOUT_PROBE_MS
    );
    const [w, h] = String(probe.stdout).trim().split(",").map((n) => parseInt(n, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}

// F3-19: prepareCuratedArchiveClip's rawPath is deterministic — workDir + asset.id + ext only —
// so that a popular archive asset picked by more than one scene/beat in the same render job can
// share a single download instead of each caller fetching its own copy. The previous guard for
// that sharing was `isSharedRaw = rawCache.get(id) === rawPath`, a one-time snapshot with no
// synchronization: two concurrent callers could each observe "not yet shared", each start their
// own materializeArchiveAsset() against the identical rawPath, and whichever one's download
// failed (or simply finished first and considered itself the sole owner) would unlink rawPath
// out from under the other while it was still mid-read in ffmpeg — surfacing as
// "archive_raw_a{id}.{ext}: No such file or directory" (confirmed in production logs, including
// two ENOENTs on the same path 565 microseconds apart — proof of genuinely concurrent trims).
//
// The fix below makes "start a materialization for this rawPath" a single atomic step: the very
// first synchronous statement in acquireSharedRawMaterialization() is a Map check-then-set with
// no `await` in between, so JS's run-to-completion semantics guarantee only one caller can ever
// win the "create" branch for a given rawPath — every other concurrent caller finds the winner's
// entry already registered and awaits that same promise instead of starting a second download.
// A refcount (not a boolean snapshot) tracks how many callers are still relying on rawPath, and
// the shared file is only ever unlinked once that count returns to zero — so no caller can ever
// delete a file a sibling call is still using, regardless of success/failure/ordering.
type SharedRawMaterialization = {
  /** Resolves with rawPath once the (single) materialization attempt for it has completed. */
  promise: Promise<string>;
  /** Number of prepareCuratedArchiveClip() calls currently relying on this rawPath. */
  refCount: number;
};

// Keyed by the absolute rawPath, which already encodes workDir (unique per render job — see
// videoPipeline.ts's fastvid_{videoId}_{Date.now()} workDir naming) and asset.id, so this can
// never collide across jobs or across different assets in the same job. Entries are removed as
// soon as the last concurrent consumer releases (see releaseSharedRawMaterialization), so this
// never accumulates across the lifetime of a long-running worker process.
const sharedRawMaterializations = new Map<string, SharedRawMaterialization>();

function acquireSharedRawMaterialization(
  rawPath: string,
  materialize: () => Promise<void>
): SharedRawMaterialization {
  let entry = sharedRawMaterializations.get(rawPath);
  if (!entry) {
    // No `await` between the .get() above and the .set() below — this whole branch runs as one
    // synchronous turn, so no other concurrent caller can observe the "missing" state and also
    // take this branch for the same rawPath.
    entry = { promise: materialize().then(() => rawPath), refCount: 0 };
    sharedRawMaterializations.set(rawPath, entry);
  }
  entry.refCount++;
  return entry;
}

/** Releases this caller's hold on rawPath's shared materialization; deletes the file once no
 *  concurrent caller still needs it (refCount reaches 0), never before. */
function releaseSharedRawMaterialization(rawPath: string): void {
  const entry = sharedRawMaterializations.get(rawPath);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    sharedRawMaterializations.delete(rawPath);
    try {
      if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
    } catch {
      /* ignore */
    }
  }
}

/** Download a curated archive asset and return a beat-ready MP4 path. */
export async function prepareCuratedArchiveClip(
  asset: ArchiveAssetRow,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  holdSec: number,
  styleContext?: CuratedClipStyleContext
): Promise<string> {
  const duration = clampHoldSec(holdSec);
  /**
   * RENDER 562 — do not download an asset to ask it a question it has already answered.
   *
   * 222 length refusals over 34 assets in one render, one of them refused 26 times. Each repeat
   * cost a materialization and an ffprobe for a verdict the render already held. RONDE 86 fixed
   * this in the two routes it examined; three of the five routes into this function still catch
   * the throw and register nothing, so the check lives HERE, where every route passes.
   *
   * Keyed by the floor rather than by the asset: the length refusal depends on the SLOT, so an
   * asset refused for a long slot is still asked about a short one. The refusal itself is
   * unchanged — this only declines to make it twice.
   */
  const floorForThisSlot = stitchSourceFloorSec(
    styleContext?.minSourceSec ?? duration,
    VIDRUSH_MIN_SOURCE_VIDEO_SEC
  );
  if (sourceFloorWouldFailAgain(getSourceFloorMemo(), asset.id, floorForThisSlot)) {
    throw new Error(
      `source video too short (already refused this render at a ${floorForThisSlot.toFixed(2)}s floor)`
    );
  }
  const ext =
    asset.mediaType === "video"
      ? asset.mimeType.includes("webm")
        ? "webm"
        : "mp4"
      : asset.mimeType.includes("png")
        ? "png"
        : asset.mimeType.includes("webp")
          ? "webp"
          : "jpg";
  const rawPath = path.join(workDir, `archive_raw_a${asset.id}.${ext}`);
  const outPath =
    asset.mediaType === "image"
      ? path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}_still.mp4`)
      : path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}.mp4`);

  const materialization = acquireSharedRawMaterialization(rawPath, () =>
    materializeArchiveAsset(asset, rawPath)
  );
  try {
    await materialization.promise;

    // F3-19: acquireSharedRawMaterialization already guarantees only one materialization is ever
    // in flight for this rawPath, so this can no longer be a concurrent sibling's doing — it is
    // only reachable via something outside our own concurrency control (e.g. an OS-level eviction
    // under memory pressure). One direct re-materialize covers that residual, non-concurrency case
    // without masking any race, because the race itself is now structurally impossible.
    if (!fs.existsSync(rawPath)) {
      await materializeArchiveAsset(asset, rawPath);
    }

    if (asset.mediaType === "image") {
      /**
       * RONDE 133 — the same verdict function the external provider routes now call.
       *
       * The rule is unchanged (an unmeasurable width still passes, the threshold is still
       * VIDRUSH_MIN_STILL_WIDTH); what changed is that it is no longer written out only here.
       * The archive used to be the only route in the pipeline that looked at a still's pixel
       * width at all.
       */
      const width = await probeImageWidthPx(rawPath);
      const verdict = stillResolutionVerdict(width);
      if (!verdict.ok) {
        throw new Error(`curated asset ${asset.id} still too low-res (${verdict.detail})`);
      }
    } else {
      /**
       * RONDE 134 — archive VIDEO is measured too, by the same rule as every external provider.
       *
       * The archive had a resolution check for stills and none at all for video, so an ingested
       * clip of any size whatsoever went straight through to Vision and the montage. That is the
       * same one-route-only asymmetry RONDE 133 removed for stills, in the other direction.
       *
       * The floor is deliberately the absolute one (144 lines), not the 480-line quality bar: an
       * archive is precisely where a genuine 352×240 newsreel lives, and refusing that would throw
       * away the material this pipeline exists to find. See technicalMediaGate.
       */
      const dims = await probeVideoDimensions(rawPath);
      const verdict = videoResolutionVerdict(dims?.width, dims?.height);
      if (!verdict.ok) {
        console.warn(
          formatTechnicalReject({
            beatLabel: `s${sceneIndex}b${beatIndex}`,
            source: "archive",
            assetId: String(asset.id),
            contentKey: `archive:${asset.id}`,
            mediaType: "video",
            verdict,
          })
        );
        throw new Error(`curated asset ${asset.id} video too low-res (${verdict.detail})`);
      }
      /**
       * Video 613 — a YouTube Short is never looked at. One an earlier render archived without a
       * hashtag is known by its frame: taller than it is wide. Refused here, on the measurement,
       * before the text check or the picture editor ever sees it.
       */
      if (dims && /youtube/i.test(asset.sourcePlatform ?? "") && dims.height > dims.width) {
        console.warn(
          `[YouTubeNotFootage] archive asset ${asset.id} s${sceneIndex}b${beatIndex} is a vertical YouTube video ` +
            `(${dims.width}x${dims.height}) — the Short format, never used`
        );
        throw new Error(`curated asset ${asset.id} is a vertical YouTube video (${dims.width}x${dims.height}) — Short format`);
      }
      if (verdict.belowQualityBar && dims) {
        console.log(
          formatBelowQualityBar({
            beatLabel: `s${sceneIndex}b${beatIndex}`,
            source: "archive",
            contentKey: `archive:${asset.id}`,
            width: dims.width,
            height: dims.height,
          })
        );
      }
    }

    let hasBakedText: boolean;
    if (asset.hasBakedEditText != null) {
      // Cached verdict from a prior check of this exact asset — clip content never changes,
      // so the result stays valid forever and re-running the LLM check would be wasted time.
      hasBakedText = asset.hasBakedEditText === 1;
    } else {
      // Pass the path, not a read-into-memory Buffer — for video content
      // archiveClipHasBakedEditText only needs a handful of extracted frames, so materializing the
      // whole clip in RAM here (and, previously, having the callee write it right back to disk
      // unchanged) was pure overhead.
      const text = await judgeOnScreenText({ path: rawPath, mimeType: asset.mimeType });
      hasBakedText = text.decision === "REJECT";
      /**
       * VIDEO 626 — a check that could not look is not written down as "clean".
       *
       * This wrote `hasBakedEditText: 0` whenever the detector did not answer (its budget spent, a
       * timeout, a refused image), and the row then told every later render the clip had been
       * checked for a broadcaster's logo or burnt-in subtitles and had none. The clip is used
       * unchecked for this render, as ingestion already does (RONDE 222), and the row stays
       * unjudged so the next render asks.
       */
      if (text.evaluated === false) {
        console.warn(
          `[CuratedMedia] asset ${asset.id}: on-screen text not checked (${text.notAskedReason ?? "no answer"}) — ` +
            "used unchecked this render, left unjudged in the archive"
        );
      } else {
        try {
          await updateMediaArchiveAsset(asset.id, { hasBakedEditText: hasBakedText ? 1 : 0 });
          asset.hasBakedEditText = hasBakedText ? 1 : 0;
        } catch (err) {
          console.warn(`[CuratedMedia] Failed to cache overlay verdict for asset ${asset.id}:`, (err as Error).message);
        }
      }
    }
    if (hasBakedText) {
      throw new Error(`curated asset ${asset.id} has baked edit text — skipped`);
    }

    /**
     * RONDE 97 §3 — THE TRANSCODE HAPPENS ONCE PER (ASSET, SLOT), NOT ONCE PER BEAT.
     *
     * `acquireSharedRawMaterialization` above already shares the DOWNLOAD. What it does not share
     * is this ffmpeg pass, because `outPath` carries the scene and beat in its name — so two beats
     * that want the same asset for the same duration produce two byte-identical files by running
     * ffmpeg twice. Render 568 paid for one asset thirty-eight times, and after RONDE 88A fixed
     * the search half of that, this is what remained.
     *
     * The key deliberately does NOT contain the scene or the beat: those change the file's NAME
     * and not its CONTENT. It contains what does change the bytes — the asset, the duration
     * rounded to a tenth, the media type and the style the caller asked for. A caller that
     * transforms differently gets a different key and a real second preparation.
     *
     * On reuse the cached file is COPIED to this beat's own `outPath` rather than returned in its
     * place. That is the conservative choice and it is deliberate: several places in this codebase
     * still read a scene and a beat out of a curated filename, and handing beat 3 a file called
     * `scene_0_b0_curated_a57364.mp4` would fix a performance problem by creating a provenance
     * one. A local copy costs a file write; the transcode it replaces costs an ffmpeg process.
     */
    const prepKey = preparationKey({
      assetIdentity: `archive:${asset.id}`,
      holdSec: duration,
      variant: [
        asset.mediaType,
        styleContext?.minSourceSec != null ? `floor${floorForThisSlot.toFixed(2)}` : "",
      ]
        .filter(Boolean)
        .join(":"),
    });
    const runTrim = async () => {
      const outcome = await runPreparation(workDir, prepKey, async () => {
        if (asset.mediaType === "image") {
          await convertImageToKenBurns(rawPath, outPath, duration, sceneIndex, beatIndex, styleContext);
        } else {
          await trimVideoClip(rawPath, outPath, duration, beatIndex, styleContext, sceneIndex, beatIndex);
        }
        return outPath;
      });
      if (outcome.status === "FAILED") throw outcome.error;
      if (outcome.path !== outPath) {
        /** A reuse. Copy rather than alias — see the note above on filename provenance. */
        await fs.promises.copyFile(outcome.path, outPath);
      }
    };
    try {
      await runTrim();
    } catch (err) {
      // Same residual, non-concurrency case as above (external eviction) — no sibling call can
      // have deleted rawPath while we hold a reference to its shared materialization.
      if (!fs.existsSync(rawPath) && (err as Error).message?.includes("No such file or directory")) {
        await materializeArchiveAsset(asset, rawPath);
        await runTrim();
      } else {
        /**
         * The one place the length refusal is recorded, so no route can forget to.
         *
         * Only a genuine length refusal — `parseSourceFloorFailure` returns null for a 404, an
         * undecodable file or a baked-text skip, and those keep RONDE 86's existing per-route
         * handling untouched.
         */
        const refusal = parseSourceFloorFailure((err as Error).message ?? "");
        if (refusal) noteSourceFloorFailure(getSourceFloorMemo(), asset.id, refusal);
        throw err;
      }
    }

    // Informational only — no longer consulted for ownership/cleanup decisions (see
    // acquireSharedRawMaterialization/releaseSharedRawMaterialization above), kept so the
    // per-video "asset.id -> resolved raw path" bookkeeping in videoPipeline.ts's dedup state
    // stays populated exactly as before.
    styleContext?.rawCache?.set(asset.id, rawPath);

    return outPath;
  } finally {
    releaseSharedRawMaterialization(rawPath);
  }
}

export type CuratedCandidatePick = {
  asset: ArchiveAssetRow;
  archiveName: string;
  score: number;
  archiveNicheTags?: string[];
  semantic?: SemanticMatchResult;
  /** Worst-frame CLIP score from pre-rank (0–10), when indexed. */
  clipVisionScore10?: number;
};

async function loadArchiveAssetsForSearch(
  archiveId: number,
  assetsCache?: Map<number, ArchiveAssetRow[]>
): Promise<ArchiveAssetRow[]> {
  if (assetsCache?.has(archiveId)) return assetsCache.get(archiveId)!;
  /**
   * Video 613 — a YouTube Short is never looked at, and that includes one an earlier render put
   * in the archive before the rule existed. Its title still carries the uploader's hashtag.
   */
  const assets = (await getMediaArchiveAssets(archiveId)).filter(
    (a) => !(/youtube/i.test(a.sourcePlatform ?? "") && youtubeResultIsShort(a.title))
  );
  assetsCache?.set(archiveId, assets);
  return assets;
}

export function rankCuratedCandidatesForBeat(
  pool: CuratedCandidatePick[],
  beatTags: string[],
  topicAnchors: string[] = [],
  beatText?: string
): CuratedCandidatePick[] {
  const beatCtx = computeBeatScoringContext(beatText);
  const ranked = pool.map((c) => ({
    ...c,
    score: scoreCuratedAsset(
      c.asset,
      c.archiveNicheTags ?? normalizeMediaTags(c.asset.tags ?? []),
      beatTags,
      topicAnchors,
      beatText,
      "general",
      beatCtx
    ),
  }));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: ArchiveAssetRow) => (x.mediaType === "video" ? 2 : 0);
    if (videoBoost(b.asset) !== videoBoost(a.asset)) {
      return videoBoost(b.asset) - videoBoost(a.asset);
    }
    return a.asset.id - b.asset.id;
  });

  /** ONE ROUTE: score order only; variety within a score band is `preferLessUsed`'s, applied after. */
  return ranked;
}

/** Per-sentence archive search — scores all assets against this beat's narration. */
export async function searchCuratedCandidatesForBeat(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  videoTitle?: string,
  options?: {
    /** Recent same-subject videos' uses per archive asset (usageDiversity.recentUsageCounts). */
    crossVideoUsage?: ReadonlyMap<number, number>;
    assetsCache?: Map<number, ArchiveAssetRow[]>;
    semanticProfile?: BeatSemanticProfile;
    /** Geo welcome / opening beat — archive images are not allowed. */
    videosOnly?: boolean;
    segmentLock?: BeatGeoRegion | null;
    fastMode?: boolean;
    videoLength?: string | null;
    /** Pre-built video pool — skips full archive DB scan per beat. */
    candidatePool?: CuratedCandidatePick[];
    skipSemantic?: boolean;
    /** F3-23: per-video count of how many times each archive has already been used this
     *  render (VisualDedupState.usedArchiveNames) — biases near-tied-score candidates toward
     *  less-recently-used archives via usageDiversity.preferLessUsed, without ever letting a
     *  lower-scoring candidate outrank a genuinely better one. */
    usedArchiveNames?: Map<string, number>;
  }
): Promise<CuratedCandidatePick[]> {
  const anchoredBeat = hydrateBeatScriptVisuals(beat);
  const skipLlmSemantic =
    options?.skipSemantic === true ||
    options?.fastMode === true;
  const semanticProfile =
    options?.semanticProfile ??
    (skipLlmSemantic
      ? analyzeBeatSemanticsFallback(anchoredBeat.text, videoTitle)
      : semanticVisualMatchingEnabled()
        ? await analyzeBeatSemantics(
            anchoredBeat.text,
            videoTitle,
            anchoredBeat.visualDescription?.trim() || undefined
          )
        : undefined);
  const shotQueries = buildDocumentaryShotQueries(
    anchoredBeat.visualDescription?.trim() || anchoredBeat.searchQuery?.trim() || anchoredBeat.text,
    anchoredBeat.index
  );
  const beatForMatch: CuratedBeatContext = {
    ...anchoredBeat,
    searchQuery: shotQueries[0] || anchoredBeat.searchQuery,
  };
  const { beatTags, topicAnchors, allTags, videoVisualTopic } =
    buildBeatMatchTags(beatForMatch, scene, videoTitle);

  console.log(
    `[ArchiveSearch] zin ${beat.index} "${beat.text.slice(0, 60)}"` +
    `\n  beatTags:     [${beatTags.join(", ")}]` +
    `\n  topicAnchors: [${topicAnchors.join(", ")}]` +
    `\n  topic:        ${videoVisualTopic}` +
    (options?.candidatePool ? `\n  pool:         ${options.candidatePool.length} clips (pre-built)` : `\n  pool:         full archive scan`)
  );

  let listed: CuratedCandidatePick[];
  if (options?.candidatePool && options.candidatePool.length > 0) {
    // Tier 1: same-video dedup respected. Cross-video use is a PREFERENCE (usageDiversity's
    // preferLessUsed, applied after scoring), never a filter, so a beat tries every clip that
    // matches before ever repeating a clip within THIS video.
    const dedupedForVideo = options.candidatePool.filter(
      (p) => !usedAssetIds.has(p.asset.id) && !usedStorageUrls.has(p.asset.storageUrl)
    );
    /**
     * ONE ROUTE — no reuse tier when the pool is exhausted: the fetch below skips used assets and the
     * push refuses them, so re-offering them adopted nothing. An empty list sends the beat on.
     */
    listed = dedupedForVideo;
  } else {
    listed = await listCuratedArchiveCandidates(
      beatTags,
      usedAssetIds,
      usedStorageUrls,
      topicAnchors,
      allTags,
      anchoredBeat.text,
      options?.assetsCache,
      true,
      true,
      videoVisualTopic
    );
  }

  let ranked = rankCuratedCandidatesForBeat(
    orderCuratedCandidatesForBeat(listed),
    beatTags,
    topicAnchors,
    beat.text
  );

  ranked = ranked.map((p) => ({
    ...p,
    score: p.score + goodClipCacheBoost(p.asset, beat.text),
  }));
  ranked.sort((a, b) => b.score - a.score);

  const matchTags = normalizeMediaTags([
    ...(beat.searchQuery ? tokenizeBeatText(beat.searchQuery) : []),
    ...(beat.visualDescription ? tokenizeBeatText(beat.visualDescription) : []),
    ...extractVisualSearchTags(beat.visualDescription?.trim() || beat.searchQuery?.trim() || beat.text),
  ]);
  const allArchiveMatchTags = normalizeMediaTags([...beatTags, ...topicAnchors, ...matchTags]);
  if (matchTags.length > 0) {
    const matched = ranked.filter((p) => countVisualTagHits(p.asset, matchTags) > 0);
    if (matched.length > 0) {
      ranked = [...matched, ...ranked.filter((p) => !matched.includes(p))];
    }
  }
  if (archiveTagsPrimaryMatching() && allArchiveMatchTags.length > 0) {
    ranked = ranked.map((p) => ({
      ...p,
      score: p.score + countVisualTagHits(p.asset, allArchiveMatchTags) * 14,
    }));
    ranked.sort((a, b) => b.score - a.score);
  }

  if (ranked.length > 0) {
    const top5 = ranked.slice(0, 5).map((p, i) =>
      `    #${i + 1} score=${p.score} id=${p.asset.id} tags=[${(p.asset.tags ?? []).join(", ")}]`
    );
    console.log(
      `[ArchiveSearch] zin ${beat.index} — ${ranked.length} kandidaten gevonden:\n` + top5.join("\n")
    );
  } else {
    console.log(`[ArchiveSearch] zin ${beat.index} — GEEN kandidaten gevonden in archief`);
  }

  let clipPreRankDone = false;
  if (clipEmbeddingIndexEnabled() && skipLlmSemantic) {
    const visionCtxEarly = beatVisionContextForSearch(beat, videoTitle, semanticProfile);
    const { ranked: clipRankedEarly } = await preRankCuratedCandidatesByClipEmbedding(
      ranked,
      visionCtxEarly,
      { fastMode: true }
    );
    ranked = clipRankedEarly;
    clipPreRankDone = true;
    const topEarly = ranked[0]?.clipVisionScore10;
    if (topEarly != null) {
      console.log(
        `[ClipPreRank] zin ${beat.index}: early top vision ${topEarly}/10 (fast path)`
      );
    }
  }

  const skipSemanticPool = skipLlmSemantic;

  if (semanticProfile && semanticVisualMatchingEnabled() && !skipSemanticPool) {
    const poolCap = skipLlmSemantic ? 8 : pipelineWallClockLimitEnabled() ? 20 : 64;
    const pool = ranked.slice(0, poolCap);
    ranked = await Promise.all(
      pool.map(async (pick) => {
        const semantic = await scoreArchiveAssetSemantically(semanticProfile, pick.asset);
        const tagHits = countVisualTagHits(pick.asset, allArchiveMatchTags);
        const blended = archiveTagsPrimaryMatching()
          ? Math.round(pick.score * 0.62 + semantic.relevanceScore * 1.25 + tagHits * 10)
          : Math.round(pick.score * 0.35 + semantic.relevanceScore * 2.2);
        return {
          ...pick,
          semantic,
          score: blended,
        };
      })
    );
    ranked.sort((a, b) => b.score - a.score);
    const skipSemanticRerank =
      process.env.ENABLE_SEMANTIC_AI_RERANK === "false" ||
      options?.fastMode === true ||
      (ranked[0]?.clipVisionScore10 != null && ranked[0].clipVisionScore10 >= semanticRerankClipSkipMin());
    if (!skipSemanticRerank) {
      ranked = await applySemanticAiRerank(ranked, semanticProfile, videoTitle);
    }

    if (archiveTagsPrimaryMatching() && allArchiveMatchTags.length > 0) {
      const tagMatched = ranked.filter((p) => countVisualTagHits(p.asset, allArchiveMatchTags) > 0);
      const tagMiss = ranked.filter((p) => countVisualTagHits(p.asset, allArchiveMatchTags) === 0);
      if (tagMatched.length > 0) {
        ranked = [...tagMatched, ...tagMiss];
      }
    }

    const minSem = semanticMinRelevanceScore();
    const semanticOk = ranked.filter(
      (p) => p.semantic && assetMeetsSemanticMinimum(p.semantic)
    );
    /**
     * ONE ROUTE — the semantic minimum ORDERS, it does not remove: candidates that meet it first,
     * then those within the relaxed band, then the rest. Refusing below the minimum is the
     * VisualJudge's rule (`below_semantic_minimum` in `judgeArchiveAsset`).
     */
    const relaxedSem = ranked.filter(
      (p) => !semanticOk.includes(p) && (p.semantic?.relevanceScore ?? 0) >= Math.max(28, minSem - 12)
    );
    ranked = [...semanticOk, ...relaxedSem, ...ranked.filter((p) => !semanticOk.includes(p) && !relaxedSem.includes(p))];

    console.log(
      `[SemanticVisual] zin ${beat.index}: "${beat.text.slice(0, 50)}…" → top tier ${ranked[0]?.semantic?.tier ?? "?"} ` +
        `score ${ranked[0]?.semantic?.relevanceScore ?? 0} (${ranked[0]?.semantic?.tierLabel ?? "n/a"}) ` +
        `archiveTags=${countVisualTagHits(ranked[0]?.asset ?? { title: "", tags: [] }, allArchiveMatchTags)}`
    );
  }

  if (clipEmbeddingIndexEnabled() && !clipPreRankDone) {
    const visionCtx = beatVisionContextForSearch(beat, videoTitle, semanticProfile);
    const clipFast = options?.fastMode === true || pipelineWallClockLimitEnabled();
    const { ranked: clipRanked } = await preRankCuratedCandidatesByClipEmbedding(
      ranked,
      visionCtx,
      { fastMode: clipFast }
    );
    ranked = clipRanked;
    const topVision = ranked[0]?.clipVisionScore10;
    if (topVision != null) {
      const scored = ranked.filter((c) => c.clipVisionScore10 != null).length;
      console.log(
        `[ClipPreRank] zin ${beat.index}: top vision ${topVision}/10 ` +
          `"${beat.text.slice(0, 45)}…" (${scored} indexed)`
      );
    }
  }

  // F3-23 / ONE ROUTE: prefer the less-used — fewer recent same-subject videos, then archives drawn
  // on less this render — within score bands only (usageDiversity.preferLessUsed), so a genuinely best-scoring
  // candidate can never be displaced by a lower-scoring one just for the sake of variety. Applied
  // after every scoring pass above (tag boosts, semantic, CLIP) so it sees each candidate's final
  // score, and before the selection cascade below so a fresher-archive pick is actually tried first.
  ranked = preferLessUsed(ranked, {
    recentVideoUses: options?.crossVideoUsage,
    archiveUsesThisRender: options?.usedArchiveNames,
  });

  let filtered = ranked.filter((p) =>
    judgeArchiveAsset({ asset: p.asset, score: p.score }).decision === "ACCEPT"
  );
  if (options?.videosOnly) {
    filtered = filtered.filter((p) => p.asset.mediaType === "video");
    ranked = ranked.filter((p) => p.asset.mediaType === "video");
  }
  /**
   * ONE ROUTE — what the VisualJudge refused is not offered again under a looser name. The former
   * "medium" and "relaxed" tiers asked the same judge about a subset of what it had just refused
   * (always empty); "main subject only" offered refused assets with no judgement at all.
   */
  if (filtered.length > 0) return filtered;

  // No match at all — return empty so the pipeline falls back to Pexels/Pixabay stock.
  // We must never pick a random archive clip that has nothing to do with this sentence.
  return [];
}

/**
 * RONDE 645 — THE ROUTE THAT PREPARED A CURATED CLIP TELLS THE LEDGER WHICH ASSET IT WAS.
 *
 * `fetchCuratedArchiveBeatClip` is called from seventeen places in the pipeline and opened no
 * lineage record, so every clip it prepared was adopted as a clip the ledger had never seen —
 * provider UNVERIFIED. Render 603 adopted archive asset 57802, a YouTube segment the background
 * prefetch had just filed, exactly that way (`UNTRACED_ADOPTION … adopted as UNVERIFIED`).
 *
 * This module cannot import the pipeline (the pipeline imports it), so the pipeline registers the
 * one function that knows the active render's ledger, and the pick — which is the proof of where
 * the clip came from — is handed to it the moment the file exists.
 */
type CuratedClipPreparedHook = (picked: CuratedCandidatePick, sceneIndex: number, beatIndex: number, clipPath: string) => void;
let curatedClipPreparedHook: CuratedClipPreparedHook | null = null;
export function setCuratedClipPreparedHook(hook: CuratedClipPreparedHook | null): void {
  curatedClipPreparedHook = hook;
}

/**
 * RONDE 649 — an asset THIS beat's editor already refused is not prepared for it again.
 *
 * Same arrangement as the hook above: the pipeline owns the render's verdict ledger and registers
 * the one question this module needs answered. The answer is per beat — see
 * `beatAlreadyRefusedPicture` — so an asset refused under one sentence stays offered to the rest.
 */
type CuratedAssetRefusedHook = (sceneIndex: number, beatIndex: number, assetId: number) => string | null;
let curatedAssetRefusedHook: CuratedAssetRefusedHook | null = null;
export function setCuratedAssetRefusedHook(hook: CuratedAssetRefusedHook | null): void {
  curatedAssetRefusedHook = hook;
}

export async function fetchCuratedArchiveBeatClip(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  workDir: string,
  sceneIndex: number,
  holdSec: number,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  videoTitle?: string,
  interviewBudget?: { used: number; max: number },
  imageBudget?: { used: number; max: number },
  motionGraphicsBudget?: MotionGraphicsBudget,
  options?: {
    /** Recent same-subject videos' uses per archive asset (usageDiversity.recentUsageCounts). */
    crossVideoUsage?: ReadonlyMap<number, number>;
    assetsCache?: Map<number, ArchiveAssetRow[]>;
    videosOnly?: boolean;
    segmentLock?: BeatGeoRegion | null;
    videoLength?: string | null;
    /** F3-23: see searchCuratedCandidatesForBeat's usedArchiveNames option. */
    usedArchiveNames?: Map<string, number>;
    /**
     * RONDE 33: filled in with the winning asset's own identity when this call returns a clip.
     *
     * This function returns a file path, so a caller that wants to mark the pick as used has
     * only the filename to go on — which yields the asset id (curatedClipPathAssetId) but never
     * the storageUrl, leaving markCuratedAssetUsed's usedStorageUrls set permanently empty and
     * two rows pointing at the same file both selectable. Handing the real values back through
     * an optional out-object keeps the return type and every existing caller untouched.
     */
    pickedOut?: {
      assetId?: number;
      storageUrl?: string;
      /**
       * RENDER 570 — the winning PICK, not only its two identifying fields.
       *
       * This function prepares a curated clip and returns a path. It never touches the lineage
       * ledger, which lives on the render's dedup state and is not reachable from this module. So
       * the two adopt sites in `adoptArchiveBeatClip` that fetch through here pushed a clip under
       * `{ source: "archive" }` — REAL_FUNNEL — with no record opened for it anywhere:
       *
       *     7x  route=archive  eligible=false  vision=APPROVED  blocked=FUNNEL_WITHOUT_EVIDENCE
       *
       * Seven pictures the editor had APPROVED, refused because `markEligible` had nothing to
       * resolve. The beats then fell through to `subject_fallback` and the film ended up carrying
       * sixteen unjudged pictures — both of render 570's blocking gates, from this one gap.
       *
       * The ranked queue in the same function does it correctly, with
       * `ensureCuratedAssetLineage(dedup, picked, …)`, and that needs the pick itself. Handing it
       * back through the out-object this comment's predecessor already established is the smallest
       * honest fix: the identity is known here, the ledger is reachable there, and neither module
       * learns about the other.
       */
      pick?: CuratedCandidatePick;
    };
  }
): Promise<string | null> {
  const { beatTags } = buildBeatMatchTags(beat, scene, videoTitle);
  const candidates = await searchCuratedCandidatesForBeat(
    beat,
    scene,
    usedAssetIds,
    usedStorageUrls,
    videoTitle,
    {
      crossVideoUsage: options?.crossVideoUsage,
      assetsCache: options?.assetsCache,
      segmentLock: options?.segmentLock,
      videosOnly: options?.videosOnly,
      videoLength: options?.videoLength,
      fastMode: false,
      usedArchiveNames: options?.usedArchiveNames,
    }
  );
  if (!candidates.length) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: no unused curated archive asset` +
        (beatTags.length ? ` (beat tags: ${beatTags.slice(0, 6).join(", ")})` : "")
    );
    return null;
  }

  const topScore = candidates[0]?.score ?? 0;
  const minAcceptScore = Math.max(28, Math.round(topScore * 0.4));
  /** ONE ROUTE: the ranked order, never rotated for variety — variety is `preferLessUsed`, applied in the search. */
  const tryOrder = candidates;
  const maxTries = maxVisualCandidatesPerBeatTry();

  const eligible: CuratedCandidatePick[] = [];
  for (const picked of tryOrder) {
    if (eligible.length >= maxTries) break;
    const judged = judgeArchiveAsset({ asset: picked.asset, score: picked.score });
    if (judged.decision === "REJECT") {
      continue;
    }
    if (picked.score < minAcceptScore && topScore > minAcceptScore + 6) {
      continue;
    }
    if (usedAssetIds.has(picked.asset.id) || usedStorageUrls.has(picked.asset.storageUrl)) {
      continue;
    }
    const refusedHere = curatedAssetRefusedHook?.(sceneIndex, beat.index, picked.asset.id) ?? null;
    if (refusedHere) {
      console.log(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: archive asset ${picked.asset.id} ` +
          `not offered again — this beat already refused it: ${refusedHere.slice(0, 100)}`
      );
      continue;
    }
    if (
      interviewBudget &&
      isCuratedInterviewAsset(picked.asset) &&
      interviewBudget.used >= interviewBudget.max
    ) {
      continue;
    }
    if (
      imageBudget &&
      picked.asset.mediaType === "image" &&
      imageBudget.used >= imageBudget.max
    ) {
      continue;
    }
    eligible.push(picked);
  }

  if (eligible.length === 0) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: no usable curated archive asset` +
        (beatTags.length ? ` (beat tags: ${beatTags.slice(0, 6).join(", ")})` : "")
    );
    return null;
  }

  const tryPrepare = async (picked: CuratedCandidatePick): Promise<string | null> => {
    try {
      const clipPath = await prepareCuratedArchiveClip(
        picked.asset,
        workDir,
        sceneIndex,
        beat.index,
        holdSec,
        {
          beatText: beat.text,
          videoTitle,
          motionGraphicsBudget,
        }
      );
      const matchedTags = beatTags.filter((t) => {
        const tags = normalizeMediaTags(picked.asset.tags ?? []);
        return tags.some((x) => x === t || x.includes(t));
      });
      try {
        curatedClipPreparedHook?.(picked, sceneIndex, beat.index, clipPath);
      } catch {
        /* provenance bookkeeping never costs a clip that was prepared correctly */
      }
      console.log(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated archive #${picked.asset.id} ` +
          `from "${picked.archiveName}" (score ${picked.score}, ${clampHoldSec(holdSec).toFixed(1)}s` +
          (matchedTags.length ? `, matched: ${matchedTags.slice(0, 4).join(", ")}` : "") +
          `)`
      );
      return clipPath;
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated asset ${picked.asset.id} failed:`,
        (err as Error).message
      );
      /**
       * RONDE 86 — an asset that cannot be prepared is out for the rest of the render.
       *
       * Every throw prepareCuratedArchiveClip can produce is a property of the ASSET, not of this
       * beat: "source video too short" (trimVideoClip), "trimmed clip too short", "Ken Burns clip
       * too short", "Styled still clip too short", a download that 404s, a file ffprobe cannot
       * decode. None of them get a different answer on the next beat. Without registering the
       * failure the same broken asset was re-selected, re-downloaded and re-rejected on every
       * beat that scored it well — render 536 logged 594 "source video too short" rejections
       * across 37 distinct assets, an average of sixteen identical failures per asset.
       *
       * preparePooledArchiveClip (videoPipeline.ts) — the sister route into exactly the same
       * prepare function — has always done this. This one did not, which is the whole bug: which
       * of the two routes a beat happened to take decided whether the render learned anything.
       *
       * Registering in the used-sets rather than in a separate "failed" set is deliberate: those
       * sets are already consulted by every selection path (searchCuratedCandidatesForBeat's pool
       * filter, listCuratedArchiveCandidates' excludeIds, the eligibility loop above, and
       * archiveAssetPreflight), so one line here reaches all of them. The cost of being wrong is
       * one unusable asset skipped for one render; the cost of not doing it is measured above.
       */
      usedAssetIds.add(picked.asset.id);
      if (picked.asset.storageUrl) usedStorageUrls.add(picked.asset.storageUrl);
      return null;
    }
  };

  /** RONDE 33: report the winning asset's identity, but only when a clip was actually produced. */
  const recordPicked = (picked: CuratedCandidatePick, clipPath: string | null): string | null => {
    if (clipPath && options?.pickedOut) {
      options.pickedOut.assetId = picked.asset.id;
      options.pickedOut.storageUrl = picked.asset.storageUrl;
      /** The whole pick, so the caller can open this asset's lineage — see the field's note. */
      options.pickedOut.pick = picked;
    }
    return clipPath;
  };

  if (eligible.length === 1) {
    return recordPicked(eligible[0]!, await tryPrepare(eligible[0]!));
  }

  const parallelTries = visualFootageFocusEnabled()
    ? Math.min(4, eligible.length)
    : Math.min(2, eligible.length);
  /**
   * VIDEO 618 — PREPARE IN SCORE ORDER, AND STOP AT THE FIRST GROUP THAT YIELDS A CLIP.
   *
   * Every eligible candidate used to be prepared — downloaded, trimmed, transcoded — and all but
   * the best-scoring success were deleted again without anyone looking at them. Render 618 did that
   * for 22 archive clips (`DOWNLOADED_ASSET_NEVER_JUDGED`), six to eight per beat, inside beat
   * budgets that then ran out before later beats could start.
   *
   * The winner is unchanged: it is still the best-scoring candidate that prepares. Groups are taken
   * in score order, so every candidate scoring higher than any success of a later group was already
   * tried in an earlier one; the first group with a success therefore holds the overall best. Only
   * the preparations whose result could never have been used are skipped.
   */
  const successes = await prepareInScoreOrder(eligible, parallelTries, tryPrepare);

  if (successes.length === 0) return null;

  successes.sort((a, b) => b.picked.score - a.picked.score);
  const winner = successes[0]!;
  for (const alt of successes.slice(1)) {
    try {
      if (fs.existsSync(alt.clipPath)) fs.unlinkSync(alt.clipPath);
    } catch {
      /* ignore */
    }
  }
  return recordPicked(winner.picked, winner.clipPath);
}

/**
 * VIDEO 618 — the candidates, prepared best-first in groups of `parallel`, stopping after the
 * first group that yields any clip. Returns that group's successes; see the note at the call site.
 */
export async function prepareInScoreOrder<T extends { score: number }>(
  eligible: readonly T[],
  parallel: number,
  tryPrepare: (picked: T) => Promise<string | null>
): Promise<Array<{ picked: T; clipPath: string }>> {
  const byScore = [...eligible].sort((a, b) => b.score - a.score);
  const size = Math.max(1, parallel);
  const parallelLimit = pLimit(size);
  const successes: Array<{ picked: T; clipPath: string }> = [];
  for (let from = 0; from < byScore.length && successes.length === 0; from += size) {
    const group = byScore.slice(from, from + size);
    const prepared = await Promise.all(group.map((picked) => parallelLimit(() => tryPrepare(picked))));
    group.forEach((picked, i) => {
      const clipPath = prepared[i];
      if (clipPath) successes.push({ picked, clipPath });
    });
  }
  return successes;
}

/** Targeted Pexels queries from beat geography + urban context. */
export function buildGeoStockSearchQueries(beatText: string, videoTitle?: string): string[] {
  const geoTags = extractBeatGeoPlaceTags(beatText);
  const visualTags = extractVisualSearchTags(beatText, videoTitle);
  const queries: string[] = [];
  const lower = beatText.toLowerCase();

  if (isGeoWelcomeBeat(beatText)) {
    queries.push(...buildGeoWelcomeVisualQueries(beatText));
  }
  if (isUrbanPlanningBeat(beatText)) {
    queries.push(...buildUrbanPlanningVisualQueries(beatText, videoTitle));
  }
  if (isInfrastructureBeat(beatText)) {
    queries.push(...buildInfrastructureVisualQueries(beatText, videoTitle));
  }

  const wantsNl = geoTags.some((t) =>
    /netherlands|holland|amsterdam|dutch|nederland|rotterdam|utrecht|hague|den haag/.test(t)
  );
  const wantsUs = geoTags.some((t) => /america|usa|united states|american/.test(t));

  if (wantsNl) {
    queries.push(
      "amsterdam canal bicycles",
      "netherlands cycling infrastructure",
      "rotterdam skyline modern",
      "dutch city tram",
      "amsterdam urban planning"
    );
  }
  if (wantsUs) {
    queries.push("american city skyline downtown", "usa urban street traffic", "united states city aerial");
  }
  if (/berlin|berlijn/i.test(lower) || geoTags.includes("berlin")) {
    queries.push("berlin city skyline", "berlin public transport");
  }

  for (const tag of geoTags.slice(0, 4)) {
    if (/transit|metro|subway|train|u-bahn|tram|ov\b/.test(lower)) {
      queries.push(`${tag} metro public transport`);
    } else if (/bike|cycl|fiets/.test(lower)) {
      queries.push(`${tag} cyclists street`, `${tag} people cycling`, `${tag} cycling bike lane`);
    } else if (/canal|gracht|water/.test(lower)) {
      queries.push(`${tag} canal waterfront`);
    } else if (/skyline|city|urban|planning/.test(lower)) {
      queries.push(`${tag} city skyline`);
    } else {
      queries.push(`${tag} city street`);
    }
  }

  const entities = extractEntitySearchTags(beatText);
  const salient = extractSalientBeatTokens(beatText).slice(0, 5);
  for (const token of [...entities, ...salient]) {
    if (token.length >= 4) queries.push(`${token} documentary footage`);
  }

  return [...new Set([...queries, ...visualTags.filter((t) => t.length >= 4)])].slice(0, 14);
}
