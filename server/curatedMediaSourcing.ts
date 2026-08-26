/**
 * Curated media archive — pick tagged assets from admin libraries for pipeline beats.
 */
import pLimit from "p-limit";
import { exec as execCb } from "child_process";
import { foldSearchText } from "./searchTextNormalize";
import {
  extractVisualSearchTags,
  extractSceneSearchTags,
  extractEntitySearchTags,
  extractPrimaryVisualAnchor,
  extractSalientBeatTokens,
  extractRequiredVisualTags,
  extractBeatGeoPlaceTags,
  isGenericPeopleAsset,
  isWrongGeoForBeat,
  inferVideoVisualTopic,
  isWwiiWarArchiveAsset,
  refineVisualSearchTagsForTopic,
  expandBeatTagsWithTranslations,
  expandBeatTagsWithSynonyms,
  isGeoWelcomeBeat,
  buildGeoWelcomeVisualQueries,
  isCyclingBeat,
  extractBeatCyclingTags,
  buildCyclingVisualQueries,
  assetShowsCycling,
  isCarBeat,
  extractBeatCarTags,
  buildCarVisualQueries,
  assetShowsCars,
  isGovernmentBeat,
  extractBeatGovernmentTags,
  buildGovernmentVisualQueries,
  assetShowsGovernment,
  isUrbanPlanningBeat,
  extractBeatUrbanPlanningTags,
  buildUrbanPlanningVisualQueries,
  assetShowsUrbanPlanning,
  isInfrastructureBeat,
  extractBeatInfrastructureTags,
  buildInfrastructureVisualQueries,
  assetShowsInfrastructure,
  assetIsOffTopicProtest,
  beatMentionsWwiiContent,
  isClipTitleIrrelevantToBeat,
  effectiveArchiveAssetTags,
  type VideoVisualTopic,
} from "./visualBeatTags";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import { withForkRetry } from "./_core/execForkRetry";
import { ffmpegSemaphore } from "./_core/semaphore";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { resolveLocalVideoPath, LOCAL_UPLOADS_DIR } from "./storageLocal";
import { storageGetSignedUrl } from "./storage";
import { archiveClipHasBakedEditText } from "./archiveClipFilter";
import {
  buildArchiveStillFilterComplex,
  buildArchiveStillFilterComplexBoxBlur,
  buildFitGrayVideoVF,
  buildFitGrayGradedVideoVF,
  buildMontageBranchNormVF,
  classifyDocGradeSourceKind,
  buildMatFramedStillVF,
  buildStillEncodeArgs,
  archiveStillKenBurnsVariant,
  resolveStillKenBurnsVariant,
  standardArchiveKenBurnsZoomEnd,
} from "./documentaryStyle";
import {
  resolveStillImageFilterComplex,
  type MotionGraphicsBudget,
  type StillStyleContext,
} from "./motionGraphicsEngine";
import {
  curatedArchiveOnlyVisuals,
  archiveBlurFillStillsEnabled,
  archiveVisualMaxClipSec,
  archiveVisualMinClipSec,
  archivePreferVideoClips,
  framedArchiveStillsEnabled,
  archivePexelsHybridEnabled,
  vidrushDocumentaryQualityEnabled,
  maxVisualCandidatesPerBeatTry,
  visualFootageFocusEnabled,
  archiveTagsPrimaryMatching,
  pipelineWallClockLimitEnabled,
  isFastShortVideoLength,
  semanticRerankClipSkipMin,
  metadataVisualBlocksEnabled,
  ffmpegThreadFlag,
  literalVisualGateEnabled,
} from "./sourcingPolicy";
import {
  assetHasNlMarkers,
  assetHasUsMarkers,
  assetHasForeignMarkers,
  extractTitleGeoPlaceTags,
  isComparisonGeoTitle,
  geoTagsForRegion,
} from "./worldGeoSlugs";
import { asVideoTitleString, coerceVisionString, queryStringsMinLen } from "./stringCoercion";
import { hydrateBeatScriptVisuals } from "./scriptVisualKeywords";
import {
  isNonDocumentaryVisualHay,
  isOffTopicGeoUrbanVisual,
  isWrongRegionForSegmentLock,
  offTopicVisualAllowedForBeat,
  inferBeatGeoRegion,
  vidrushStillPhotoScale,
  VIDRUSH_MIN_SOURCE_VIDEO_SEC,
  VIDRUSH_MIN_STILL_WIDTH,
  type BeatGeoRegion,
} from "./vidrushQuality";
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
import type { ArchiveMatchTier } from "./viewerVisualPlan";
import {
  getAllMediaArchives,
  getMediaArchiveAssets,
  normalizeMediaTags,
  updateMediaArchiveAsset,
} from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { seededShuffle } from "./archiveUsageMemory";
import { throwIfActiveRenderCancelled } from "./videoGenerationCancel";

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
   *  abstract-vs-literal classifier. Phase 10: feeds assetPassesBeatMinimum's literalVisualTags
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

/** Stable dedup key for compose + cross-beat checks. */
export function curatedAssetContentKey(assetId: number): string {
  return `curated:asset:${assetId}`;
}

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
  return /_wiki_|_openverse_|_serp_|_unsplash_|_p0_|_p2_/i.test(base) && /\.mp4$/i.test(base);
}

/** Beat clip from archive video — already trimmed and framed to 1080p in prepareCuratedArchiveClip. */
export function isCuratedPreparedVideoClip(filePath: string): boolean {
  return /_curated_a\d+\.mp4$/i.test(path.basename(filePath)) && !isCuratedPreparedStillClip(filePath);
}

export type ArchiveVisualSourcesStatus = {
  ok: boolean;
  activeArchives: number;
  totalAssets: number;
  message?: string;
};

/** Pipeline startup check when visuals are archive-only. */
export async function archiveVisualSourcesReady(): Promise<ArchiveVisualSourcesStatus> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  if (!archives.length) {
    return {
      ok: false,
      activeArchives: 0,
      totalAssets: 0,
      message:
        "No active media archive — upload clips in Admin → Media Archive and mark the archive active",
    };
  }

  let totalAssets = 0;
  for (const archive of archives) {
    totalAssets += (await getMediaArchiveAssets(archive.id)).length;
  }
  if (totalAssets === 0) {
    return {
      ok: false,
      activeArchives: archives.length,
      totalAssets: 0,
      message:
        "Media archive is empty — upload tagged clips or images in Admin → Media Archive",
    };
  }

  return { ok: true, activeArchives: archives.length, totalAssets };
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

function clampHoldSec(holdSec: number): number {
  if (curatedArchiveOnlyVisuals()) {
    return Math.max(archiveVisualMinClipSec(), Math.min(archiveVisualMaxClipSec(), holdSec));
  }
  return Math.max(CLIP_MIN_SEC, Math.min(CLIP_MAX_SEC, holdSec));
}

const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "were", "was", "are", "has", "had",
  "his", "her", "its", "their", "about", "into", "over", "after", "before", "when", "where",
  "what", "how", "why", "who", "which", "your", "you", "our", "not", "but", "all", "one",
  "rise", "fall", "story", "world", "life", "video", "documentary", "history", "historical",
  "them", "they", "then", "than", "just", "amidst",
]);

function tagsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.includes(y) || y.includes(x)) return true;
    }
  }
  return false;
}

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
  const visualAnchor = extractPrimaryVisualAnchor(visualSource);
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

/** How strongly an asset matches geo/visual tags from the spoken beat. */
export function countVisualTagHits(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  visualTags: string[]
): number {
  if (!visualTags.length) return 0;
  const assetTags = effectiveArchiveAssetTags(asset);
  let hits = 0;
  for (const vt of visualTags) {
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) hits++;
    }
  }
  return hits;
}

/**
 * Archive search priority tiers (internal library only):
 * 1 exact — literal visual tag hits + tier-1/2 semantic
 * 2 semantic — strong semantic / partial literal match
 * 3 related — same topic, looser match
 */
export function filterCandidatesByArchiveTier(
  picks: CuratedCandidatePick[],
  tier: ArchiveMatchTier,
  literalTags: string[]
): CuratedCandidatePick[] {
  if (!picks.length) return [];
  const minSem = semanticMinRelevanceScore();

  return picks.filter((p) => {
    const literalHits = literalTags.length > 0 ? countVisualTagHits(p.asset, literalTags) : 0;
    const sem = p.semantic;

    if (tier === "exact") {
      return (
        literalHits >= 2 ||
        (sem != null && sem.tier <= 2 && sem.relevanceScore >= Math.max(60, minSem + 8)) ||
        (literalHits >= 1 && sem != null && sem.tier <= 2)
      );
    }

    if (tier === "semantic") {
      if (sem != null && sem.tier <= 3 && sem.relevanceScore >= minSem) return true;
      if (literalHits >= 1 && p.score >= 38) return true;
      if (sem != null && sem.tier <= 2 && sem.relevanceScore >= 50) return true;
      return false;
    }

    // related
    if (sem != null && sem.tier <= 4 && sem.relevanceScore >= 30) return true;
    if (literalHits >= 1) return true;
    if (p.score >= 22 && countVisualTagHits(p.asset, literalTags.slice(0, 2)) > 0) return true;
    return p.score >= Math.max(18, Math.round((picks[0]?.score ?? 40) * 0.22));
  });
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

/** Archive clip wrong for this beat — beat-driven, all video topics. */
export function archiveAssetRejectedForBeat(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">,
  beatText: string
): boolean {
  if (!metadataVisualBlocksEnabled()) return false;
  if (!beatText?.trim()) return false;
  if (isWwiiWarArchiveAsset(asset) && !beatMentionsWwiiContent(beatText)) return true;
  if (isCuratedInterviewAsset(asset) && !/\b(interview|historicus|expert|talking head|besprek)\b/i.test(beatText.toLowerCase())) {
    return true;
  }
  const beatHistorical =
    beatMentionsWwiiContent(beatText) ||
    /\b(18\d{2}|19\d{2}|20[01]\d|histor(y|ical)|archief|archive|war|oorlog|ancient|medieval)\b/i.test(
      beatText.toLowerCase()
    );
  if (!beatHistorical && isGeographyIncompatibleArchiveAsset(asset)) return true;
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  if (isOffTopicGeoUrbanVisual(hay) && !offTopicVisualAllowedForBeat(hay, beatText)) return true;
  return false;
}

export function assetPassesBeatMinimum(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">,
  beatText: string,
  score: number,
  topScore: number,
  semantic?: SemanticMatchResult,
  videoVisualTopic: VideoVisualTopic = "general",
  segmentLock: BeatGeoRegion | null = null,
  literalVisualTags: string[] = [],
  videoTitle?: string
): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  if (isNonDocumentaryVisualHay(hay)) return false;
  if (!metadataVisualBlocksEnabled()) return true;
  if (segmentLock && isWrongRegionForSegmentLock(hay, segmentLock)) return false;

  if (archiveAssetRejectedForBeat(asset, beatText)) return false;

  const requiredGeo = resolveRequiredGeoTagsForBeat(beatText, videoTitle, segmentLock);
  if (requiredGeo.length > 0) {
    if (isWrongGeoForBeat(asset, requiredGeo)) return false;
    const geoHits = countVisualTagHits(asset, requiredGeo);
    if (geoHits === 0) return false;
  }

  const geoTags = extractBeatGeoPlaceTags(beatText);
  if (geoTags.length > 0) {
    if (isWrongGeoForBeat(asset, geoTags)) return false;
    const geoHits = countVisualTagHits(asset, geoTags);
    if (geoHits === 0) return false;
  }

  if (isCyclingBeat(beatText) && !assetShowsCycling(asset)) {
    return false;
  }

  if (isCarBeat(beatText) && !assetShowsCars(asset)) {
    return false;
  }

  if (isGovernmentBeat(beatText) && !assetShowsGovernment(asset)) {
    return false;
  }

  if (isUrbanPlanningBeat(beatText) && !assetShowsUrbanPlanning(asset, beatText)) {
    if (!isGovernmentBeat(beatText) || !assetShowsGovernment(asset)) {
      return false;
    }
  }

  if (isInfrastructureBeat(beatText) && !assetShowsInfrastructure(asset, beatText)) {
    if (!isUrbanPlanningBeat(beatText) || !assetShowsUrbanPlanning(asset, beatText)) {
      return false;
    }
  }

  if (assetIsOffTopicProtest(asset, beatText, videoVisualTopic)) {
    return false;
  }

  if (isClipTitleIrrelevantToBeat(asset, beatText)) {
    return false;
  }

  if (literalVisualTags.length > 0) {
    const literalHits = countVisualTagHits(asset, literalVisualTags);
    const semStrong =
      semantic != null && semantic.tier <= 3 && semantic.relevanceScore >= Math.max(50, semanticMinRelevanceScore());
    if (literalHits === 0 && !semStrong) {
      const requiredTags = extractRequiredVisualTags(beatText);
      const sceneTags = extractSceneSearchTags(beatText);
      const fallbackHits = countVisualTagHits(asset, [...requiredTags, ...sceneTags, ...literalVisualTags.slice(0, 3)]);
      if (fallbackHits === 0) return false;
    }
  }

  if (semantic && semanticVisualMatchingEnabled()) {
    if (!assetMeetsSemanticMinimum(semantic)) return false;
    if (semantic.tier >= 5 && semantic.matchedEntities.length === 0) return false;
    return true;
  }

  const requiredTags = extractRequiredVisualTags(beatText);
  const sceneTags = extractSceneSearchTags(beatText);
  const entityTags = extractEntitySearchTags(beatText);
  const visualHits = countVisualTagHits(asset, requiredTags);
  const sceneEntityHits = countVisualTagHits(asset, [...sceneTags, ...entityTags]);

  const minScore = vidrushDocumentaryQualityEnabled() ? 28 : Math.max(22, Math.round(topScore * 0.32));
  if (score < minScore && visualHits < 2) return false;

  if ((sceneTags.length > 0 || entityTags.length > 0) && sceneEntityHits === 0 && visualHits < 2) {
    return false;
  }

  if (requiredTags.length >= 3 && visualHits === 0 && score < Math.round(topScore * 0.5)) {
    return false;
  }

  if (isGenericPeopleAsset(asset)) {
    const entities = extractEntitySearchTags(beatText);
    if (entities.length > 0 && countVisualTagHits(asset, entities) === 0) return false;
    if (visualHits === 0 && (entities.length > 0 || requiredTags.length >= 2)) return false;
  }

  return true;
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
  opts?: { assetSampleSize?: number }
): Promise<RankedArchive[]> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  if (!archives.length) return [];

  const combined = normalizeMediaTags([...queryTags, ...anchorTags]);
  const ranked: RankedArchive[] = [];

  for (const archive of archives) {
    let score = scoreArchiveMetadata(archive, queryTags, anchorTags);
    if (score < 20 && combined.length > 0) {
      const assets = await getMediaArchiveAssets(archive.id);
      score += scoreArchiveAssetSample(assets, combined, opts?.assetSampleSize ?? 48);
    }
    ranked.push({ id: archive.id, name: archive.name, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

const ARCHIVE_ROUTE_MIN_SCORE = 8;

/** Archives to search for clips — auto-routed from title/tags, not manually linked. */
export async function resolveArchivesForVisualQuery(
  queryTags: string[],
  anchorTags: string[] = []
): Promise<Array<Awaited<ReturnType<typeof getAllMediaArchives>>[number]>> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  if (archives.length <= 1) return archives;

  const ranked = await rankArchivesForVisualQuery(queryTags, anchorTags);
  const relevant = ranked.filter((r) => r.score >= ARCHIVE_ROUTE_MIN_SCORE);
  if (relevant.length > 0) {
    const ids = new Set(relevant.map((r) => r.id));
    const selected = archives.filter((a) => ids.has(a.id));
    console.log(
      `[ArchiveRouter] Auto-routed to ${selected.length} archive(s): ${relevant
        .slice(0, 4)
        .map((r) => `"${r.name}" (${r.score})`)
        .join(", ")}` +
        (queryTags.length ? ` | tags: ${queryTags.slice(0, 6).join(", ")}` : "")
    );
    return selected;
  }

  if (ranked[0]?.score > 0) {
    const best = archives.find((a) => a.id === ranked[0].id);
    if (best) {
      console.log(
        `[ArchiveRouter] Best-match archive "${best.name}" (score ${ranked[0].score}) — weak tag overlap, using anyway`
      );
      return [best];
    }
  }

  console.log("[ArchiveRouter] No strong archive match — searching all active archives");
  return archives;
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
  if (isNonDocumentaryVisualHay(assetHay)) return 0;
  let score = 0;
  let beatHits = 0;
  const ctx = beatCtx ?? computeBeatScoringContext(beatText);

  if (beatText?.trim()) {
    const bl = beatText.toLowerCase();
    // Person-name guarantee: if a tag names a specific person AND the beat text
    // mentions that person → strong boost, clip is guaranteed to rank above generics.
    for (const t of assetTags) {
      if (t.length >= 4 && bl.includes(t)) {
        score += 200;
        beatHits += 3;
        break; // one person match is enough
      }
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

  score += curatedOffTopicPenalty(asset, topicAnchors, beatTags, videoVisualTopic);
  if (metadataVisualBlocksEnabled()) {
    if (beatText && archiveAssetRejectedForBeat(asset, beatText)) return 0;
    if (isWwiiWarArchiveAsset(asset) && !beatMentionsWwiiContent(beatText ?? "") && videoVisualTopic !== "wwii") {
      score = Math.max(0, score - 400);
    }
    if (beatText && isClipTitleIrrelevantToBeat(asset, beatText)) {
      return 0;
    }
  }
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

/** Obvious era/topic mismatches (e.g. medieval sign in WWII Hitler doc). */
function curatedOffTopicPenalty(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">,
  topicAnchors: string[],
  beatTags: string[],
  videoVisualTopic: VideoVisualTopic = "general"
): number {
  return isCuratedOffTopicAsset(asset, topicAnchors, beatTags, videoVisualTopic) ? -250 : 0;
}

/**
 * RONDE 22: an asset already judged to have baked-in edit text (burnt-on subtitles, channel
 * bumpers, hard-coded captions) can never be adopted — adoptCuratedArchiveAsset throws on it.
 *
 * That verdict is cached on the row, but it was only ever read at adoption time, i.e. AFTER the
 * selector had already picked the asset and materialized it to disk. So the selector kept
 * re-choosing assets it already knew were dead: render 526/527 logged 255 "has baked edit text —
 * skipped" failures across just 10 distinct assets, each one paying a download/cache-restore
 * first. With a small archive that is severe — 10 of 17 assets were flagged, so roughly six in
 * ten picks were guaranteed to fail before the beat could reach a usable clip.
 *
 * Treating it as a selection-time filter (like the off-topic/geo/non-documentary checks beside it)
 * points the selector at the assets that can actually be used. Only `=== 1` is filtered: null
 * means "not checked yet" and must still flow through to the adoption-time check that fills it in.
 */
export function hasKnownBakedEditText(asset: Pick<MediaArchiveAsset, "hasBakedEditText">): boolean {
  return asset.hasBakedEditText === 1;
}

export function isCuratedOffTopicAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">,
  topicAnchors: string[],
  beatTags: string[],
  videoVisualTopic: VideoVisualTopic = "general"
): boolean {
  if (!metadataVisualBlocksEnabled()) return false;
  const beatHay = beatTags.join(" ");
  // Round 13: this check used to fire off beatTags alone, so a beat whose (possibly
  // LLM-truncated) beatTags lack an explicit WWII keyword — e.g. beatTags=["berlin"] for "In
  // Berlin's heart, Adolf Hitler, trapped beneath ground, gave orders." — incorrectly flagged a
  // genuinely on-topic WWII archive asset as off-topic and applied a -250 penalty, even though
  // the whole video is already classified videoVisualTopic==="wwii" (used correctly a few lines
  // below in this same function). Guard with that existing, reliable, LLM-independent signal.
  if (isWwiiWarArchiveAsset(asset) && !beatMentionsWwiiContent(beatHay) && videoVisualTopic !== "wwii") {
    return true;
  }
  // Round 13: isGeographyIncompatibleArchiveAsset's own first check is isWwiiWarArchiveAsset
  // (see that function, a few lines below) — so this block is the same beatTags-only WWII-vs-
  // video-topic gap as the one just above, reached via a different classifier. Same guard.
  if (
    isGeographyIncompatibleArchiveAsset(asset) &&
    !beatMentionsWwiiContent(beatHay) &&
    !/\b(18\d{2}|19\d{2}|20[01]\d|histor(y|ical)|archief|archive)\b/i.test(beatHay) &&
    videoVisualTopic !== "wwii"
  ) {
    return true;
  }

  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  const beatContextWwii =
    videoVisualTopic === "wwii" ||
    topicAnchors.some((a) =>
      /hitler|nazi|wwii|world.?war|oorlog|1945|1944|holocaust|duitsland|third reich/i.test(a)
    ) ||
    beatTags.some((t) => /hitler|nazi|1945|1944|holocaust|wehrmacht|bunker|fuhrer|third reich|wwii|ww2/i.test(t));
  if (!beatContextWwii) return false;
  return /\b(middeleeuws|medieval|uithangbord|titanic|prehistoric|steentijd|dinosaur|sprookje|fantasy|mytholog)\b/i.test(
    hay
  );
}

/** B&W / war-era / interview archive — wrong look for modern city/geography documentaries. */
export function isModernUrbanArchiveAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType">
): boolean {
  const hay = effectiveArchiveAssetTags(asset).join(" ");
  return /\b(timelapse|time.?lapse|drone|aerial|4k|uhd|hd\b|1080p|contemporary|modern|skyline|street view|kleur|color footage|cityscape|urban scene|stadsmilieu|vandaag|today|current|recent|living city|walkable|bike lane|fietspad|tram|metro|ns trein|train station|gracht|canal tour)\b/i.test(
    hay
  );
}

/** B&W / war-era / interview archive — wrong look for modern city/geography documentaries. */
export function isGeographyIncompatibleArchiveAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">
): boolean {
  if (isWwiiWarArchiveAsset(asset)) return true;
  if (isCuratedInterviewAsset(asset)) return true;
  const hay = effectiveArchiveAssetTags(asset).join(" ");
  if (/\b(protest(?:ing|ers?|s)?|demonstration|demonstrators?|demonstratie|betog(?:ing|ers?)?|riot(?:ing|ers?)?|activists?|picket(?:ing|ers?)?|civil unrest|protest march|street protest)\b/i.test(hay)) {
    return true;
  }
  if (isOffTopicGeoUrbanVisual(hay)) return true;
  if (isModernUrbanArchiveAsset(asset)) return false;
  if (isCuratedHistoricalFootage(asset)) return true;
  return /\b(zwart-wit|black.?white|b&w|monochrome|sepia|archief footage|old footage|1930|1934|1939|1945|propaganda|militair|soldaten|parade|historical archive|newsreel|zwart wit)\b/i.test(
    hay
  );
}

/** Modern talking-head / historian interview clips — poor B-roll for documentaries. */
export function isCuratedInterviewAsset(asset: Pick<MediaArchiveAsset, "title" | "tags">): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return /\b(interview|historicus|bespreekt|talking head|woonkamer|bibliotheek|oudere man|man geeft|gesprek met)\b/i.test(
    hay
  );
}

/** Archival parade footage, speeches, period video — not generic stills. */
export function isCuratedHistoricalFootage(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  if (asset.mediaType === "video") {
    return /\b(parade|militair|zwart-wit|archief|1930|1934|1939|1945|hitler|nazi|berlijn|troepen|soldaten|propaganda|rally|march|speech|toespraak|crowd|war|oorlog|wehrmacht|ss|bijeenkomst|sporting|balkon)\b/i.test(
      hay
    );
  }
  if (asset.mediaType === "image") {
    return /\b(propaganda poster|poster|portret|propaganda|archief|foto)\b/i.test(hay);
  }
  return false;
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
  crossVideoExcludeIds: Set<number> = new Set(),
  assetsCache?: Map<number, ArchiveAssetRow[]>,
  /** When true, score assets in every active archive (per-sentence search). */
  searchAllArchives = false,
  /** When true, never dump the entire archive as score-1 fallback (sentence montage). */
  noUniversalFallback = false,
  videoVisualTopic: VideoVisualTopic = "general"
): Promise<CuratedCandidatePick[]> {
  const queryTags = filterTags ?? normalizeMediaTags([...beatTags, ...topicAnchors]);
  const archives = searchAllArchives
    ? (await getAllMediaArchives()).filter((a) => a.isActive === 1)
    : await resolveArchivesForVisualQuery(queryTags, topicAnchors);
  if (!archives.length) return [];

  const geoRequired = beatText ? extractBeatGeoPlaceTags(beatText) : [];
  const scored: CuratedCandidatePick[] = [];
  const fallback: CuratedCandidatePick[] = [];
  const metadataBlocks = metadataVisualBlocksEnabled();
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
      const assetHay = normalizeMediaTags(asset.tags ?? []).join(" ");
      if (isNonDocumentaryVisualHay(assetHay)) continue;
      if (metadataBlocks && isCuratedOffTopicAsset(asset, topicAnchors, beatTags, videoVisualTopic)) continue;
      if (metadataBlocks && geoRequired.length > 0 && isWrongGeoForBeat(asset, geoRequired)) continue;
      const score = scoreCuratedAsset(asset, nicheTags, beatTags, topicAnchors, beatText, videoVisualTopic, beatCtx);
      // RONDE 9 (render 519): a NEGATIVE score is active evidence of a mismatch — it must never
      // be laundered into the score=1 "no signal" floor (assets scoring -65 were adopted for
      // beats they demonstrably did not fit). Only a true no-signal (score === 0) may floor to 1.
      const effectiveScore = score > 0 ? score : score < 0 || metadataBlocks ? 0 : 1;
      if (effectiveScore > 0) {
        scored.push({
          asset,
          score: effectiveScore,
          archiveName: archive.name,
          archiveNicheTags: nicheTags,
        });
      }
    }
  }

  const blockUniversalFallback =
    metadataBlocks && (noUniversalFallback || geoRequired.length > 0);

  if (scored.length === 0 && fallback.length === 0 && archives.length > 0 && !blockUniversalFallback) {
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
        const assetHay = normalizeMediaTags(asset.tags ?? []).join(" ");
        if (isNonDocumentaryVisualHay(assetHay)) continue;
        if (metadataBlocks && isCuratedOffTopicAsset(asset, topicAnchors, beatTags, videoVisualTopic)) continue;
        const score = scoreCuratedAsset(asset, nicheTags, [], [], beatText, videoVisualTopic, beatCtx);
        // RONDE 9: same rule as the primary pool — a negative score is an active mismatch and
        // never enters the fallback pool either. (The final exhausted-reuse pool below is left
        // as-is: it only re-offers clips that already passed scoring earlier this render.)
        if (score < 0) continue;
        fallback.push({ asset, score: Math.max(score, 1), archiveName: archive.name, archiveNicheTags: nicheTags });
      }
    }
  }

  let pool = scored.length > 0 ? scored : fallback;

  // Pool exhausted by same-video dedup — allow clip reuse rather than falling back to color
  if (pool.length === 0 && archives.length > 0 && !blockUniversalFallback) {
    console.warn("[ArchiveSearch] pool exhausted by dedup — allowing clip reuse");
    for (const archive of archives) {
      const assets = await loadArchiveAssetsForSearch(archive.id, assetsCache);
      const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
      for (const asset of assets) {
        if (excludeStorageUrls.has(asset.storageUrl)) continue;
        // RONDE 22: even this last-resort reuse pool must skip them — re-offering an unadoptable
        // clip cannot rescue the beat, it only guarantees another failed adoption.
        if (hasKnownBakedEditText(asset)) continue;
        const assetHay = normalizeMediaTags(asset.tags ?? []).join(" ");
        if (isNonDocumentaryVisualHay(assetHay)) continue;
        const score = scoreCuratedAsset(asset, nicheTags, beatTags, topicAnchors, beatText, videoVisualTopic, beatCtx);
        pool.push({ asset, score: Math.max(score, 1), archiveName: archive.name, archiveNicheTags: nicheTags });
      }
    }
  }

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: ArchiveAssetRow) => (x.mediaType === "video" ? 2 : 0);
    return videoBoost(b.asset) - videoBoost(a.asset);
  });
  return applyCrossVideoVarietyDegrade(pool, crossVideoExcludeIds);
}

/** Prefer clips not used in recent same-topic videos, but degrade gracefully rather than
 *  starving a beat of candidates: keep the cross-video-excluded filter only while it still
 *  leaves a workable pool (>=15%, floor 8); otherwise fall back to the full, unfiltered pool.
 *  Shared (Phase 10) by both the full archive scan and the pre-built video candidate-pool
 *  paths so cross-video variety degrades the same way regardless of which one is in use. */
export function applyCrossVideoVarietyDegrade(
  pool: CuratedCandidatePick[],
  crossVideoExcludeIds: Set<number>
): CuratedCandidatePick[] {
  if (crossVideoExcludeIds.size === 0 || pool.length === 0) return pool;
  const filtered = pool.filter((c) => !crossVideoExcludeIds.has(c.asset.id));
  const minKeep = Math.max(8, Math.ceil(pool.length * 0.15));
  if (filtered.length >= minKeep) return filtered;
  if (filtered.length > 0) return filtered;
  return pool;
}

/** Use prefetch when non-empty; empty [] or null triggers a fresh search. */
export async function resolvePrefetchedArchiveCandidates(
  prefetched: CuratedCandidatePick[] | null | undefined,
  search: () => Promise<CuratedCandidatePick[]>
): Promise<CuratedCandidatePick[]> {
  if (prefetched != null && prefetched.length > 0) return prefetched;
  return search();
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
    if (fs.existsSync(cachePath)) {
      fs.copyFileSync(cachePath, destPath);
      return;
    }
    await archiveDownloadLimit(async () => {
      const signedUrl = await storageGetSignedUrl(key);
      await streamArchiveAssetDownload(signedUrl, destPath, 120_000);
      try {
        fs.mkdirSync(ARCHIVE_S3_CACHE_DIR, { recursive: true });
        fs.copyFileSync(destPath, cachePath);
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
  const styled = resolveStillImageFilterComplex(duration, sceneIndex, beatIndex, styleContext);
  if (styled) {
    await exec(
      `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, styled.filterComplex)}`,
      EXEC_TIMEOUT_ENCODE_MS
    );
    if (styled.consumedBudget && styleContext?.motionGraphicsBudget) {
      styleContext.motionGraphicsBudget.used++;
    }
    const outDur = await probeMediaDurationSec(outPath);
    if (outDur < duration * 0.85) {
      throw new Error(`Styled still clip too short (${outDur.toFixed(2)}s < ${duration.toFixed(2)}s)`);
    }
    return;
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
        const matFc = buildMatFramedStillVF(duration, vidrushStillPhotoScale(), sceneIndex, beatIndex);
        await exec(
          `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, matFc)}`,
          EXEC_TIMEOUT_ENCODE_MS
        );
      } else {
        throw err;
      }
    }
  } else {
    const fps = 25;
    const totalFrames = Math.max(50, Math.round(duration * fps));
    const zoomEnd =
      process.env.ENABLE_AUTO_MOTION_GRAPHICS !== "false"
        ? standardArchiveKenBurnsZoomEnd(duration)
        : 1.1;
    const zoomStep = (zoomEnd - 1.0) / totalFrames;
    const padW = Math.round(VIDEO_WIDTH * 1.12);
    const padH = Math.round(VIDEO_HEIGHT * 1.12);
    const variant = resolveStillKenBurnsVariant(sceneIndex, beatIndex);
    const yExpr = "ih/2-(ih/zoom/2)";
    const xExpr =
      variant === "pan-left"
        ? `iw/2-(iw/zoom/2)-on*${Math.max(1, Math.round(totalFrames * 0.04))}`
        : "iw/2-(iw/zoom/2)";
    const preset = process.env.RAILWAY_ENVIRONMENT ? "ultrafast" : "veryfast";
    await exec(
      `${ffmpegBin()} -y -loop 1 -i "${imgPath}" -t ${duration.toFixed(3)} ` +
        `-vf "scale=${padW}:${padH}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':` +
        `x='${xExpr}':y='${yExpr}':` +
        `d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
        `-c:v libx264 ${ffmpegThreadFlag()} -preset ${preset} -crf 18 -an -pix_fmt yuv420p "${outPath}"`,
      EXEC_TIMEOUT_ENCODE_MS
    );
  }
  const outDur = await probeMediaDurationSec(outPath);
  if (outDur < duration * 0.85) {
    throw new Error(`Ken Burns clip too short (${outDur.toFixed(2)}s < ${duration.toFixed(2)}s)`);
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
  if (sourceDur > 0 && sourceDur < VIDRUSH_MIN_SOURCE_VIDEO_SEC) {
    throw new Error(`source video too short (${sourceDur.toFixed(2)}s)`);
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
  if (outDur < VIDRUSH_MIN_SOURCE_VIDEO_SEC) {
    throw new Error(`trimmed clip too short (${outDur.toFixed(2)}s < ${VIDRUSH_MIN_SOURCE_VIDEO_SEC.toFixed(2)}s)`);
  }
  if (outDur < take * 0.8) {
    // Short of the requested duration but still usable — accept it and let
    // padShortClipWithNext (videoPipeline.ts) stitch on the remainder rather
    // than discarding a perfectly good, on-topic clip.
    console.warn(`[CuratedTrim] clip shorter than requested (${outDur.toFixed(2)}s < ${take.toFixed(2)}s) — accepting, will pad`);
  }
}

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
      const width = await probeImageWidthPx(rawPath);
      if (width > 0 && width < VIDRUSH_MIN_STILL_WIDTH) {
        throw new Error(
          `curated asset ${asset.id} still too low-res (${width}px < ${VIDRUSH_MIN_STILL_WIDTH}px)`
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
      hasBakedText = await archiveClipHasBakedEditText(rawPath, asset.mimeType);
      try {
        await updateMediaArchiveAsset(asset.id, { hasBakedEditText: hasBakedText ? 1 : 0 });
        asset.hasBakedEditText = hasBakedText ? 1 : 0;
      } catch (err) {
        console.warn(`[CuratedMedia] Failed to cache overlay verdict for asset ${asset.id}:`, (err as Error).message);
      }
    }
    if (hasBakedText) {
      throw new Error(`curated asset ${asset.id} has baked edit text — skipped`);
    }

    const runTrim = () =>
      asset.mediaType === "image"
        ? convertImageToKenBurns(rawPath, outPath, duration, sceneIndex, beatIndex, styleContext)
        : trimVideoClip(rawPath, outPath, duration, beatIndex, styleContext, sceneIndex, beatIndex);
    try {
      await runTrim();
    } catch (err) {
      // Same residual, non-concurrency case as above (external eviction) — no sibling call can
      // have deleted rawPath while we hold a reference to its shared materialization.
      if (!fs.existsSync(rawPath) && (err as Error).message?.includes("No such file or directory")) {
        await materializeArchiveAsset(asset, rawPath);
        await runTrim();
      } else {
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
  const assets = await getMediaArchiveAssets(archiveId);
  assetsCache?.set(archiveId, assets);
  return assets;
}

export function hashVarietySeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Rotate ranked list so different videos start from different archive assets. */
export function rotateCuratedCandidates<T>(
  candidates: T[],
  varietySeed: number,
  beatIndex: number
): T[] {
  if (candidates.length <= 1) return candidates;
  const start = (varietySeed + beatIndex * 7919 + (varietySeed >>> 13)) % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}

export function rankCuratedCandidatesForBeat(
  pool: CuratedCandidatePick[],
  beatTags: string[],
  topicAnchors: string[] = [],
  beatText?: string,
  varietySeed = 0,
  beatIndex = 0,
  opts?: { strict?: boolean }
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

  if (opts?.strict || ranked.length <= 1) return ranked;

  const topScore = ranked[0]!.score;
  const secondScore = ranked[1]?.score ?? 0;
  if (topScore - secondScore >= 12) return ranked;

  const banded: CuratedCandidatePick[] = [];
  let i = 0;
  while (i < ranked.length) {
    const bandTop = ranked[i]!.score;
    let j = i + 1;
    while (j < ranked.length && ranked[j]!.score >= bandTop - 2) j++;
    const band = ranked.slice(i, j);
    if (band.length === 1 || bandTop - (band[band.length - 1]?.score ?? bandTop) >= 8) {
      banded.push(...band);
    } else {
      banded.push(...seededShuffle(band, varietySeed + beatIndex * 9973 + i * 17));
    }
    i = j;
  }
  return banded;
}

/** Phase 10: bias which near-tied-score candidate is tried first toward archives used less
 *  often so far this video, without ever letting a lower-scoring candidate be preferred over
 *  a higher-scoring one — candidates are grouped into descending score bands (bandWidth points
 *  wide) first, and only reordered *within* a band, so this can never lower match quality to
 *  gain diversity. Sort is stable, so ties within a band keep their original relative order. */
export function reorderForArchiveDiversity(
  ranked: CuratedCandidatePick[],
  usedArchiveNames: Map<string, number>,
  bandWidth = 3
): CuratedCandidatePick[] {
  if (ranked.length <= 1 || usedArchiveNames.size === 0) return ranked;
  const banded: CuratedCandidatePick[] = [];
  let i = 0;
  while (i < ranked.length) {
    const bandTop = ranked[i]!.score;
    let j = i + 1;
    while (j < ranked.length && ranked[j]!.score >= bandTop - bandWidth) j++;
    const band = ranked.slice(i, j);
    if (band.length > 1) {
      band.sort((a, b) => (usedArchiveNames.get(a.archiveName) ?? 0) - (usedArchiveNames.get(b.archiveName) ?? 0));
    }
    banded.push(...band);
    i = j;
  }
  return banded;
}

/** Words that are long enough to pass a naive length filter but say nothing about a subject. */
const STUB_POWER_WORD_STOPWORDS = new Set([
  "about", "after", "again", "against", "along", "already", "although", "always", "among",
  "another", "because", "before", "began", "behind", "being", "below", "between", "beyond",
  "could", "during", "every", "final", "first", "found", "still", "their", "there", "these",
  "thing", "things", "those", "through", "under", "until", "where", "which", "while", "whose",
  "would", "within", "without",
]);

/**
 * RONDE 26: a scene-level stand-in topic, chosen by what a scene is ABOUT.
 *
 * This used to be `text.split(/\s+/).find((w) => w.length > 4)` — the first word longer than four
 * letters — which for "In the dim chaos of the Führerbunker, Adolf Hitler's crumbling…" yields
 * "chaos". That word then travels on as the pool's topic anchor. Named subjects are what a
 * documentary scene is actually about, so they come first; a content word is the fallback, and
 * "documentary" only when the text carries nothing usable at all.
 */
export function stubPowerWordFromSceneText(text: string): string {
  const stripPossessive = (w: string): string => w.replace(/['’]s$/iu, "").replace(/['’]$/u, "");
  // Capitalisation at the very start of a sentence is grammar, not meaning, so those are skipped.
  const isSentenceStart = (at: number): boolean =>
    /(^|[.!?]["'’)\]]?)\s*$/u.test(text.slice(0, at));

  // Matched against the RAW text rather than punctuation-stripped words, because the punctuation
  // is the signal: "…the Führerbunker, Adolf Hitler's plans…" contains the name "Adolf Hitler",
  // and emphatically not "Führerbunker Adolf" — the comma between them says they are not one name.
  for (const m of text.matchAll(/(\p{Lu}[\p{L}'’-]*)[ \t]+(\p{Lu}[\p{L}'’-]*)/gu)) {
    if (isSentenceStart(m.index ?? 0)) continue;
    return `${stripPossessive(m[1]!)} ${stripPossessive(m[2]!)}`;
  }
  // Then a single mid-sentence capitalised word — a place, an organisation, a surname alone.
  for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]{2,}/gu)) {
    if (isSentenceStart(m.index ?? 0)) continue;
    return stripPossessive(m[0]);
  }
  // Then the longest ordinary content word, which at least beats picking whichever came first.
  let best = "";
  for (const raw of text.split(/\s+/)) {
    const w = stripPossessive(raw.replace(/[^\p{L}\p{N}'’-]/gu, ""));
    const lower = w.toLowerCase();
    if (lower.length > 4 && !STUB_POWER_WORD_STOPWORDS.has(lower) && lower.length > best.length) {
      best = w;
    }
  }
  return best || "documentary";
}

/** One-time per-video archive pool — avoids re-scanning every asset on each beat. */
export async function buildVideoArchiveCandidatePool(
  videoTitle: string | undefined,
  combinedSceneText: string,
  options?: {
    assetsCache?: Map<number, ArchiveAssetRow[]>;
    crossVideoExcludeIds?: Set<number>;
    excludeIds?: Set<number>;
    excludeStorageUrls?: Set<string>;
    maxPool?: number;
  }
): Promise<CuratedCandidatePick[]> {
  const text = combinedSceneText.trim().slice(0, 1200);
  const stubKeywords = text.split(/\s+/).filter((w) => w.length > 3).slice(0, 12);
  const stubBeat: CuratedBeatContext = {
    index: 0,
    text,
    keywords: stubKeywords.length > 0 ? stubKeywords : ["documentary"],
    searchQuery: text.split(/\s+/).slice(0, 8).join(" ") || "documentary",
    powerWord: stubPowerWordFromSceneText(text),
  };
  const stubScene: CuratedSceneContext = { text, pexelsQuery: stubBeat.searchQuery };
  const { beatTags, topicAnchors, allTags, videoVisualTopic } = buildBeatMatchTags(
    stubBeat,
    stubScene,
    videoTitle
  );
  const geoRequired = extractBeatGeoPlaceTags(text);
  const listed = await listCuratedArchiveCandidates(
    beatTags,
    options?.excludeIds ?? new Set(),
    options?.excludeStorageUrls ?? new Set(),
    topicAnchors,
    allTags,
    text,
    options?.crossVideoExcludeIds ?? new Set(),
    options?.assetsCache,
    true,
    geoRequired.length > 0,
    videoVisualTopic
  );
  const maxPool = options?.maxPool ?? 480;
  return orderCuratedCandidatesForBeat(listed).slice(0, maxPool);
}

/** Per-sentence archive search — scores all assets against this beat's narration. */
export async function searchCuratedCandidatesForBeat(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  videoTitle?: string,
  options?: {
    varietySeed?: number;
    crossVideoExcludeIds?: Set<number>;
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
     *  less-recently-used archives via reorderForArchiveDiversity, without ever letting a
     *  lower-scoring candidate outrank a genuinely better one. */
    usedArchiveNames?: Map<string, number>;
  }
): Promise<CuratedCandidatePick[]> {
  const anchoredBeat = hydrateBeatScriptVisuals(beat);
  const varietySeed = options?.varietySeed ?? 0;
  const crossVideoExcludeIds = options?.crossVideoExcludeIds ?? new Set<number>();
  const fastShort = isFastShortVideoLength(options?.videoLength);
  const skipLlmSemantic =
    options?.skipSemantic === true ||
    options?.fastMode === true ||
    fastShort;
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
  const { beatTags, mainSubject, topicAnchors, allTags, videoVisualTopic, hasLiteralVisual, literalVisualTags } =
    buildBeatMatchTags(beatForMatch, scene, videoTitle);
  const literalGateTags = literalVisualGateEnabled() && hasLiteralVisual ? literalVisualTags : [];

  console.log(
    `[ArchiveSearch] zin ${beat.index} "${beat.text.slice(0, 60)}"` +
    `\n  beatTags:     [${beatTags.join(", ")}]` +
    `\n  topicAnchors: [${topicAnchors.join(", ")}]` +
    `\n  topic:        ${videoVisualTopic}` +
    (options?.candidatePool ? `\n  pool:         ${options.candidatePool.length} clips (pre-built)` : `\n  pool:         full archive scan`)
  );

  let listed: CuratedCandidatePick[];
  if (options?.candidatePool && options.candidatePool.length > 0) {
    // Tier 1: same-video dedup respected. Cross-video variety degrades gracefully
    // (applyCrossVideoVarietyDegrade) rather than being an all-or-nothing gate, so a beat
    // tries every recently-unused-elsewhere clip before ever repeating a clip within THIS
    // video (Phase 10 — reusing a clip from a different video is far less visible to a
    // viewer than the same clip appearing twice in one video).
    const dedupedForVideo = options.candidatePool.filter(
      (p) => !usedAssetIds.has(p.asset.id) && !usedStorageUrls.has(p.asset.storageUrl)
    );
    if (dedupedForVideo.length > 0) {
      listed = applyCrossVideoVarietyDegrade(dedupedForVideo, crossVideoExcludeIds);
    } else {
      // Tier 2: pool exhausted even after every cross-video-variety relaxation — allow
      // same-video reuse rather than falling back to color, still preferring clips not
      // used in other recent videos when there's enough pool left to do so.
      console.warn(
        `[ArchiveSearch] zin ${beat.index}: pool exhausted by dedup — hergebruik toegestaan (${options.candidatePool.length} clips)`
      );
      listed = applyCrossVideoVarietyDegrade(options.candidatePool, crossVideoExcludeIds);
    }
  } else {
    listed = await listCuratedArchiveCandidates(
      beatTags,
      usedAssetIds,
      usedStorageUrls,
      topicAnchors,
      allTags,
      anchoredBeat.text,
      crossVideoExcludeIds,
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
    beat.text,
    varietySeed,
    beat.index,
    { strict: true }
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
      isFastShortVideoLength(options?.videoLength) ||
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
    if (semanticOk.length > 0) {
      ranked = [...semanticOk, ...ranked.filter((p) => !semanticOk.includes(p))];
    } else {
      const relaxedSem = ranked.filter(
        (p) => (p.semantic?.relevanceScore ?? 0) >= Math.max(28, minSem - 12)
      );
      if (relaxedSem.length > 0) ranked = relaxedSem;
    }

    console.log(
      `[SemanticVisual] zin ${beat.index}: "${beat.text.slice(0, 50)}…" → top tier ${ranked[0]?.semantic?.tier ?? "?"} ` +
        `score ${ranked[0]?.semantic?.relevanceScore ?? 0} (${ranked[0]?.semantic?.tierLabel ?? "n/a"}) ` +
        `archiveTags=${countVisualTagHits(ranked[0]?.asset ?? { title: "", tags: [] }, allArchiveMatchTags)}`
    );
  }

  if (clipEmbeddingIndexEnabled() && !clipPreRankDone) {
    const visionCtx = beatVisionContextForSearch(beat, videoTitle, semanticProfile);
    const clipFast = options?.fastMode === true || fastShort || pipelineWallClockLimitEnabled();
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

  // F3-23: bias near-tied-score candidates toward archives used less often so far this video —
  // reorders only within score bands (see reorderForArchiveDiversity), so a genuinely best-scoring
  // candidate can never be displaced by a lower-scoring one just for the sake of variety. Applied
  // after every scoring pass above (tag boosts, semantic, CLIP) so it sees each candidate's final
  // score, and before the selection cascade below so a fresher-archive pick is actually tried first.
  if (options?.usedArchiveNames && options.usedArchiveNames.size > 0) {
    ranked = reorderForArchiveDiversity(ranked, options.usedArchiveNames);
  }

  const topScore = ranked[0]?.score ?? 0;
  const segmentLock = options?.segmentLock ?? null;
  let filtered = ranked.filter((p) =>
    assetPassesBeatMinimum(p.asset, beat.text, p.score, topScore, p.semantic, videoVisualTopic, segmentLock, literalGateTags, videoTitle)
  );
  if (options?.videosOnly) {
    filtered = filtered.filter((p) => p.asset.mediaType === "video");
    ranked = ranked.filter((p) => p.asset.mediaType === "video");
  }
  if (filtered.length > 0) return filtered;

  if (topScore > 0) {
    const medium = ranked.filter(
      (p) =>
        p.score >= Math.max(40, Math.round(topScore * 0.5)) &&
        assetPassesBeatMinimum(p.asset, beat.text, p.score, topScore, p.semantic, videoVisualTopic, segmentLock, literalGateTags, videoTitle)
    );
    if (medium.length > 0) return medium;
  }

  if (topScore > 0) {
    const relaxed = ranked.filter(
      (p) =>
        p.score >= Math.max(18, Math.round(topScore * 0.28)) &&
        countVisualTagHits(p.asset, matchTags.length > 0 ? matchTags : beatTags) > 0 &&
        !isGenericPeopleAsset(p.asset) &&
        assetPassesBeatMinimum(p.asset, beat.text, p.score, topScore, p.semantic, videoVisualTopic, segmentLock, literalGateTags, videoTitle)
    );
    if (relaxed.length > 0) return relaxed;
  }

  // Fallback: retry with main subject only (drop the specifier)
  if (mainSubject.length > 0 && beatTags.length > 1) {
    console.log(`[ArchiveSearch] zin ${beat.index}: no match with [${beatTags.join(", ")}] — retrying with main subject only: [${mainSubject[0]}]`);
    const subjectOnly = ranked.filter((p) => countVisualTagHits(p.asset, mainSubject) > 0);
    if (subjectOnly.length > 0) return subjectOnly;
  }

  // No match at all — return empty so the pipeline falls back to Pexels/Pixabay stock.
  // We must never pick a random archive clip that has nothing to do with this sentence.
  return [];
}

/** Required geo tags for archive acceptance — beat text, title, or sticky segment lock. */
export function resolveRequiredGeoTagsForBeat(
  beatText: string,
  videoTitle?: string,
  segmentLock?: BeatGeoRegion | null
): string[] {
  const beatGeo = extractBeatGeoPlaceTags(beatText);
  if (beatGeo.length > 0) return beatGeo;

  if (isComparisonGeoTitle(videoTitle)) {
    let lock = segmentLock ?? inferBeatGeoRegion(beatText, videoTitle);
    if (lock === "both" || lock === "neutral") {
      if (segmentLock === "nl" || segmentLock === "us") {
        lock = segmentLock;
      } else {
        const beatRegion = inferBeatGeoRegion(beatText, videoTitle);
        lock = beatRegion === "nl" || beatRegion === "us" ? beatRegion : "nl";
      }
    }
    if (lock === "nl") return geoTagsForRegion("nl", videoTitle);
    if (lock === "us") return geoTagsForRegion("us", videoTitle);
    return [];
  }

  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  if (titleGeo.length > 0) return titleGeo;

  const region = inferBeatGeoRegion(beatText, videoTitle);
  if (region === "nl") return geoTagsForRegion("nl", videoTitle);
  if (region === "us") return geoTagsForRegion("us", videoTitle);
  return [];
}

/** Hard reject archive assets that are clearly from the wrong country for this beat. */
export function isArchiveGeoBlockedForBeat(
  asset: Pick<{ title?: string | null; tags?: string[] | null }, "title" | "tags">,
  beatText: string,
  videoTitle?: string,
  segmentLock?: BeatGeoRegion | null
): boolean {
  if (!metadataVisualBlocksEnabled()) return false;
  const required = resolveRequiredGeoTagsForBeat(beatText, videoTitle, segmentLock);
  if (required.length > 0) return isWrongGeoForBeat(asset, required);

  const beatRegion = inferBeatGeoRegion(beatText, videoTitle);
  if (beatRegion === "us" || beatRegion === "both") return false;
  if (beatRegion !== "nl") return false;

  const hasNl = assetHasNlMarkers(asset);
  const hasUs = assetHasUsMarkers(asset);
  const hasForeign = assetHasForeignMarkers(asset);
  if ((hasUs || hasForeign) && !hasNl) return true;
  return false;
}

/** Skip FFmpeg when metadata already rules out an asset. */
export function archiveAssetPreflight(
  asset: ArchiveAssetRow,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  topicAnchors: string[],
  beatTags: string[],
  opts: {
    minVideoSec?: number;
    interviewUsed?: number;
    interviewMax?: number;
    imageUsed?: number;
    imageMax?: number;
    beatText?: string;
    videoTitle?: string;
    segmentGeoLock?: BeatGeoRegion | null;
    videoVisualTopic?: VideoVisualTopic;
  } = {}
): boolean {
  if (usedAssetIds.has(asset.id) || usedStorageUrls.has(asset.storageUrl)) return false;
  if (metadataVisualBlocksEnabled()) {
    if (isCuratedOffTopicAsset(asset, topicAnchors, beatTags, opts.videoVisualTopic ?? "general")) return false;
    if (
      opts.beatText &&
      isArchiveGeoBlockedForBeat(asset, opts.beatText, opts.videoTitle, opts.segmentGeoLock)
    ) {
      return false;
    }
    if (opts.beatText && isGenericPeopleAsset(asset)) {
      const required = extractRequiredVisualTags(opts.beatText);
      if (required.length >= 2 && countVisualTagHits(asset, required) === 0) return false;
    }
  }
  if (
    opts.interviewMax != null &&
    opts.interviewUsed != null &&
    isCuratedInterviewAsset(asset) &&
    opts.interviewUsed >= opts.interviewMax
  ) {
    return false;
  }
  if (
    opts.imageMax != null &&
    opts.imageUsed != null &&
    asset.mediaType === "image" &&
    opts.imageUsed >= opts.imageMax
  ) {
    return false;
  }
  const minVideo = opts.minVideoSec ?? archiveVisualMinClipSec() - 0.5;
  if (
    asset.mediaType === "video" &&
    asset.durationSec != null &&
    asset.durationSec > 0 &&
    asset.durationSec < minVideo
  ) {
    return false;
  }
  return true;
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
    relaxed?: boolean;
    varietySeed?: number;
    crossVideoExcludeIds?: Set<number>;
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
    pickedOut?: { assetId?: number; storageUrl?: string };
  }
): Promise<string | null> {
  const relaxed = options?.relaxed === true;
  const varietySeed = options?.varietySeed ?? 0;
  const crossVideoExcludeIds = options?.crossVideoExcludeIds ?? new Set<number>();
  const { beatTags, videoVisualTopic, hasLiteralVisual, literalVisualTags } = buildBeatMatchTags(beat, scene, videoTitle);
  const literalGateTags = literalVisualGateEnabled() && hasLiteralVisual ? literalVisualTags : [];
  const candidates = await searchCuratedCandidatesForBeat(
    beat,
    scene,
    usedAssetIds,
    usedStorageUrls,
    videoTitle,
    {
      varietySeed,
      crossVideoExcludeIds,
      assetsCache: options?.assetsCache,
      segmentLock: options?.segmentLock,
      videosOnly: options?.videosOnly,
      videoLength: options?.videoLength,
      fastMode: isFastShortVideoLength(options?.videoLength),
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
  const minAcceptScore = relaxed ? Math.max(12, Math.round(topScore * 0.25)) : Math.max(28, Math.round(topScore * 0.4));
  const tryOrder = relaxed ? rotateCuratedCandidates(candidates, varietySeed, beat.index) : candidates;
  const maxTries = maxVisualCandidatesPerBeatTry(options?.videoLength);

  const eligible: CuratedCandidatePick[] = [];
  for (const picked of tryOrder) {
    if (eligible.length >= maxTries) break;
    if (
      isArchiveGeoBlockedForBeat(
        picked.asset,
        beat.text,
        videoTitle,
        options?.segmentLock ?? null
      )
    ) {
      continue;
    }
    if (
      !assetPassesBeatMinimum(
        picked.asset,
        beat.text,
        picked.score,
        topScore,
        undefined,
        videoVisualTopic,
        options?.segmentLock ?? null,
        literalGateTags,
        videoTitle
      )
    ) {
      continue;
    }
    if (!relaxed && picked.score < minAcceptScore && topScore > minAcceptScore + 6) {
      continue;
    }
    if (usedAssetIds.has(picked.asset.id) || usedStorageUrls.has(picked.asset.storageUrl)) {
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
    }
    return clipPath;
  };

  if (eligible.length === 1) {
    return recordPicked(eligible[0]!, await tryPrepare(eligible[0]!));
  }

  const parallelTries = visualFootageFocusEnabled()
    ? Math.min(4, eligible.length)
    : Math.min(2, eligible.length);
  const parallelLimit = pLimit(parallelTries);
  const prepared = await Promise.all(
    eligible.map((picked) => parallelLimit(() => tryPrepare(picked)))
  );
  const successes = eligible
    .map((picked, i) => ({ picked, clipPath: prepared[i] }))
    .filter((r): r is { picked: CuratedCandidatePick; clipPath: string } => !!r.clipPath);

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

/** Mark a curated asset as used after it is adopted into the montage. */
export function markCuratedAssetUsed(
  clipPath: string,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  storageUrl?: string
): void {
  const assetId = curatedClipPathAssetId(clipPath);
  if (assetId != null) usedAssetIds.add(assetId);
  if (storageUrl) usedStorageUrls.add(storageUrl);
}

/** Geo beats (Netherlands, US, Berlin…) — Pexels has better location B-roll than a mismatched archive clip. */
export function shouldTryPexelsFirstForBeat(
  beatText: string,
  videoVisualTopic: VideoVisualTopic
): boolean {
  if (visualFootageFocusEnabled()) return false;
  if (!archivePexelsHybridEnabled()) return false;
  if (isGeoWelcomeBeat(beatText)) return true;
  if (isCyclingBeat(beatText) || isCarBeat(beatText) || isGovernmentBeat(beatText) || isUrbanPlanningBeat(beatText) || isInfrastructureBeat(beatText)) {
    return true;
  }
  const geoTags = extractBeatGeoPlaceTags(beatText);
  return geoTags.length > 0;
}

/** Use Pexels when the best archive candidate is weak or geographically wrong. */
export function shouldPreferPexelsOverArchive(
  beatText: string,
  ranked: CuratedCandidatePick[],
  videoVisualTopic: VideoVisualTopic,
  segmentLock: BeatGeoRegion | null = null,
  videoTitle?: string
): boolean {
  if (!archivePexelsHybridEnabled()) return false;
  if (!metadataVisualBlocksEnabled()) {
    return ranked.length === 0;
  }
  if (visualFootageFocusEnabled()) {
    return ranked.length === 0;
  }
  if (ranked.length === 0) return true;

  const top = ranked[0]!;
  const geoTags = extractBeatGeoPlaceTags(beatText);
  if (geoTags.length > 0) {
    if (isWrongGeoForBeat(top.asset, geoTags)) return true;
    if (countVisualTagHits(top.asset, geoTags) < 2) return true;
  }
  if (!assetPassesBeatMinimum(top.asset, beatText, top.score, top.score, top.semantic, videoVisualTopic, segmentLock, [], videoTitle)) {
    return true;
  }
  const minScore = 45;
  return top.score < minScore;
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
