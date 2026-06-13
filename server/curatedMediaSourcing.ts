/**
 * Curated media archive — pick tagged assets from admin libraries for pipeline beats.
 */
import { exec as execCb } from "child_process";
import { extractVisualSearchTags, extractSceneSearchTags, extractEntitySearchTags, extractPrimaryVisualAnchor } from "./visualBeatTags";
import { promisify } from "util";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { resolveLocalVideoPath, LOCAL_UPLOADS_DIR } from "./storageLocal";
import { storageGetSignedUrl } from "./storage";
import { archiveClipHasBakedEditText } from "./archiveClipFilter";
import {
  buildBlurFillStillVF,
  buildFitGrayVideoVF,
  buildMatFramedStillVF,
  buildStillEncodeArgs,
  archiveStillKenBurnsVariant,
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
} from "./sourcingPolicy";
import { seededShuffle } from "./archiveUsageMemory";
import {
  getAllMediaArchives,
  getMediaArchiveAssets,
  normalizeMediaTags,
  type MediaArchiveAsset,
} from "./db";

const exec = promisify(execCb);
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
};

export type BeatMatchTags = {
  /** Words/phrases from this beat's narration — primary match keys. */
  beatTags: string[];
  /** Topic from video title/prompt — niche filter, lower weight per beat. */
  topicAnchors: string[];
  allTags: string[];
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
        "No active media archive — upload clips in Admin → Media Archief and mark the archive active",
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
        "Media archive is empty — upload tagged clips or images in Admin → Media Archief",
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

export function extractTopicAnchorTags(videoTitle?: string, extraText?: string): string[] {
  const raw = [videoTitle ?? "", extraText ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        (w.length >= 4 || SHORT_TOPIC_TOKENS.has(w)) && !QUERY_STOP_WORDS.has(w)
    );
  return normalizeMediaTags(raw).slice(0, 8);
}

/** Tokenize narration into searchable tags (beat text first). */
function tokenizeBeatText(raw: string): string[] {
  return normalizeMediaTags(
    raw
      .toLowerCase()
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
  const topicAnchors = extractTopicAnchorTags(videoTitle, [beat.text, scene.text].join(" "));
  const visualTags = extractVisualSearchTags(beat.text);
  const visualAnchor = extractPrimaryVisualAnchor(beat.text);
  const beatRaw = [
    beat.text,
    visualAnchor ?? "",
    beat.powerWord ?? "",
    beat.searchQuery ?? "",
    ...beat.keywords,
    ...visualTags,
    scene.visualCue ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const beatTags = tokenizeBeatText(beatRaw).filter((t) => !topicAnchors.includes(t) || beat.text.toLowerCase().includes(t));
  const sceneTags = tokenizeBeatText([scene.text, scene.pexelsQuery ?? ""].join(" "));
  const mergedBeat = normalizeMediaTags([...beatTags, ...sceneTags.filter((t) => beat.text.toLowerCase().includes(t))]).slice(0, 16);
  const allTags = normalizeMediaTags([...mergedBeat, ...topicAnchors]).slice(0, 24);
  return { beatTags: mergedBeat, topicAnchors, allTags };
}

/** How strongly an asset matches geo/visual tags from the spoken beat. */
export function countVisualTagHits(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  visualTags: string[]
): number {
  if (!visualTags.length) return 0;
  const title = (asset.title ?? "").toLowerCase();
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  let hits = 0;
  for (const vt of visualTags) {
    if (title.includes(vt)) hits += 2;
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) hits++;
    }
  }
  return hits;
}

export function buildCuratedQueryTags(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  videoTitle?: string
): string[] {
  return buildBeatMatchTags(beat, scene, videoTitle).allTags;
}

function archiveMatchesQuery(
  archiveName: string,
  archiveNicheTags: string[],
  queryTags: string[],
  anchorTags: string[]
): boolean {
  return (
    scoreArchiveMetadata(
      { name: archiveName, nicheTags: archiveNicheTags },
      queryTags,
      anchorTags
    ) >= 8
  );
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
  assets: MediaArchiveAsset[],
  combinedTags: string[],
  sampleSize = 48
): number {
  if (!combinedTags.length || !assets.length) return 0;
  let hits = 0;
  for (const asset of assets.slice(0, sampleSize)) {
    const title = (asset.title ?? "").toLowerCase();
    const assetTags = normalizeMediaTags(asset.tags ?? []);
    const matched = combinedTags.some(
      (q) =>
        title.includes(q) ||
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

export function scoreCuratedAsset(
  asset: MediaArchiveAsset,
  archiveNicheTags: string[],
  beatTags: string[],
  topicAnchors: string[] = [],
  beatText?: string
): number {
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  const title = (asset.title ?? "").toLowerCase();
  let score = 0;
  let beatHits = 0;

  if (beatText?.trim()) {
    const bl = beatText.toLowerCase();
    if (title.length >= 5 && bl.includes(title)) {
      score += 55;
      beatHits += 2;
    }
    const titleWords = title.split(/\s+/).filter((w) => w.length >= 4);
    const titleInBeat = titleWords.filter((w) => bl.includes(w)).length;
    if (titleWords.length >= 2 && titleInBeat >= Math.min(2, titleWords.length)) {
      score += 28;
      beatHits++;
    }
  }

  for (const q of beatTags) {
    if (title === q) {
      score += 40;
      beatHits++;
      continue;
    }
    if (title.includes(q)) {
      score += 24;
      beatHits++;
    }
    for (const t of assetTags) {
      if (t === q) {
        score += 34;
        beatHits++;
      } else if (t.includes(q) || q.includes(t)) {
        score += 12;
        beatHits++;
      }
    }
  }

  const visualTags = beatText ? extractVisualSearchTags(beatText) : [];
  for (const vt of visualTags) {
    if (title.includes(vt)) {
      score += 32;
      beatHits += 2;
    }
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) {
        score += 22;
        beatHits++;
      }
    }
  }

  score += curatedSceneContextScore(asset, beatText);

  if (beatHits >= 2) score += 18;
  if (beatHits >= 3) score += 12;

  for (const anchor of topicAnchors) {
    if (title.includes(anchor)) score += 10;
    for (const t of assetTags) {
      if (t === anchor) score += 16;
      else if (t.includes(anchor) || anchor.includes(t)) score += 6;
    }
    for (const n of archiveNicheTags) {
      if (n === anchor || tMatches(n, anchor)) score += 4;
    }
  }

  for (const n of archiveNicheTags) {
    for (const t of assetTags) {
      if (t === n || t.includes(n) || n.includes(t)) score += 3;
    }
  }

  if (beatTags.length >= 2 && beatHits === 0) score = Math.max(0, score - 60);

  score += curatedArchiveVisualBoost(asset);
  score += curatedVideoFootageBoost(asset);
  score += curatedActionFootageBoost(asset);
  score += curatedImagePenalty(asset);
  score += curatedPosterPenalty(asset);
  score += curatedStaticInteriorPenalty(asset);
  score += curatedInterviewPenalty(asset);

  score += curatedOffTopicPenalty(asset, topicAnchors, beatTags);

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
  const required = [...sceneTags, ...entityTags];
  if (required.length === 0) return 0;

  const title = (asset.title ?? "").toLowerCase();
  const hay = `${title} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
  let score = 0;

  for (const tag of sceneTags) {
    if (hay.includes(tag)) score += 38;
  }
  for (const tag of entityTags) {
    if (hay.includes(tag)) score += 28;
  }

  const sceneHits = countVisualTagHits(asset, sceneTags);
  const entityHits = countVisualTagHits(asset, entityTags);
  if (sceneTags.length > 0 && sceneHits === 0) {
    if (/\b(man|men|person|portrait|unknown|civilian|people|crowd)\b/.test(title)) score -= 55;
    else score -= 30;
  }
  if (entityTags.length > 0 && entityHits === 0 && sceneTags.length > 0 && sceneHits === 0) {
    score -= 20;
  }
  if (sceneHits > 0 && entityHits > 0) score += 25;

  return score;
}

/** Obvious era/topic mismatches (e.g. medieval sign in WWII Hitler doc). */
function curatedOffTopicPenalty(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  topicAnchors: string[],
  beatTags: string[]
): number {
  return isCuratedOffTopicAsset(asset, topicAnchors, beatTags) ? -250 : 0;
}

export function isCuratedOffTopicAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  topicAnchors: string[],
  beatTags: string[]
): boolean {
  const title = (asset.title ?? "").toLowerCase();
  const hay = `${title} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
  const wwiiLike =
    topicAnchors.some((a) =>
      /hitler|nazi|wwii|world.?war|oorlog|berlin|1945|1944|holocaust|duitsland|germany|third reich/i.test(a)
    ) ||
    beatTags.some((t) => /hitler|nazi|berlin|1945|1944|oorlog|war|holocaust/i.test(t));
  if (!wwiiLike) return false;
  return /\b(middeleeuws|medieval|uithangbord|titanic|prehistoric|steentijd|dinosaur|sprookje|fantasy|mytholog)\b/i.test(
    hay
  );
}

/** Modern talking-head / historian interview clips — poor B-roll for documentaries. */
export function isCuratedInterviewAsset(asset: Pick<MediaArchiveAsset, "title" | "tags">): boolean {
  const title = (asset.title ?? "").toLowerCase();
  const tags = normalizeMediaTags(asset.tags ?? []).join(" ");
  const hay = `${title} ${tags}`;
  return /\b(interview|historicus|bespreekt|talking head|woonkamer|bibliotheek|oudere man|man geeft|gesprek met)\b/i.test(
    hay
  );
}

/** Archival parade footage, speeches, period video — not generic stills. */
export function isCuratedHistoricalFootage(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">): boolean {
  const title = (asset.title ?? "").toLowerCase();
  const hay = `${title} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
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

function curatedVideoFootageBoost(asset: Pick<MediaArchiveAsset, "mediaType" | "durationSec">): number {
  if (!archivePreferVideoClips() || asset.mediaType !== "video") return 0;
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
  const hay = `${(asset.title ?? "").toLowerCase()} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
  return /\b(portret|portrait|poster|propagandabeeld|propaganda poster|affiche|foto|photo|still|portrait)\b/i.test(
    hay
  );
}

/** Bunker/cell/interior shots — often a single static frame even as MP4. */
export function isCuratedStaticInteriorAsset(
  asset: Pick<MediaArchiveAsset, "title" | "tags">
): boolean {
  const hay = `${(asset.title ?? "").toLowerCase()} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
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
  const hay = `${(asset.title ?? "").toLowerCase()} ${normalizeMediaTags(asset.tags ?? []).join(" ")}`;
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

function tMatches(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

function assetMatchesTopicAnchors(asset: MediaArchiveAsset, topicAnchors: string[]): boolean {
  if (!topicAnchors.length) return false;
  const title = (asset.title ?? "").toLowerCase();
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  return topicAnchors.some(
    (q) =>
      title.includes(q) ||
      assetTags.some((t) => t === q || t.includes(q) || q.includes(t))
  );
}

function resolveArchiveAssetLocalPath(asset: MediaArchiveAsset): string | null {
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

function assetMatchesBeatTags(asset: MediaArchiveAsset, beatTags: string[]): boolean {
  if (!beatTags.length) return true;
  const title = (asset.title ?? "").toLowerCase();
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  return beatTags.some(
    (q) =>
      title.includes(q) ||
      assetTags.some((t) => t === q || t.includes(q) || q.includes(t))
  );
}

export async function listCuratedArchiveCandidates(
  beatTags: string[],
  excludeIds: Set<number>,
  excludeStorageUrls: Set<string>,
  topicAnchors: string[] = [],
  filterTags?: string[],
  beatText?: string,
  crossVideoExcludeIds: Set<number> = new Set(),
  assetsCache?: Map<number, MediaArchiveAsset[]>
): Promise<CuratedCandidatePick[]> {
  const queryTags = filterTags ?? normalizeMediaTags([...beatTags, ...topicAnchors]);
  const archives = await resolveArchivesForVisualQuery(queryTags, topicAnchors);
  if (!archives.length) return [];

  const scored: CuratedCandidatePick[] = [];
  const fallback: CuratedCandidatePick[] = [];

  for (const archive of archives) {
    const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
    const assets = await loadArchiveAssetsForSearch(archive.id, assetsCache);
    for (const asset of assets) {
      if (excludeIds.has(asset.id)) continue;
      if (excludeStorageUrls.has(asset.storageUrl)) continue;
      if (isCuratedOffTopicAsset(asset, topicAnchors, beatTags)) continue;
      const score = scoreCuratedAsset(asset, nicheTags, beatTags, topicAnchors, beatText);
      if (score > 0) scored.push({ asset, score, archiveName: archive.name, archiveNicheTags: nicheTags });
      else if (assetMatchesBeatTags(asset, beatTags) || assetMatchesTopicAnchors(asset, topicAnchors)) {
        fallback.push({ asset, score: 1, archiveName: archive.name, archiveNicheTags: nicheTags });
      }
    }
  }

  if (scored.length === 0 && fallback.length === 0 && archives.length > 0) {
    for (const archive of archives) {
      const assets = await loadArchiveAssetsForSearch(archive.id, assetsCache);
      for (const asset of assets) {
        if (excludeIds.has(asset.id)) continue;
        if (excludeStorageUrls.has(asset.storageUrl)) continue;
        if (isCuratedOffTopicAsset(asset, topicAnchors, beatTags)) continue;
        fallback.push({ asset, score: 1, archiveName: archive.name, archiveNicheTags: normalizeMediaTags(archive.nicheTags ?? []) });
      }
    }
  }

  const pool = scored.length > 0 ? scored : fallback;
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: MediaArchiveAsset) => (x.mediaType === "video" ? 2 : 0);
    return videoBoost(b.asset) - videoBoost(a.asset);
  });
  if (crossVideoExcludeIds.size === 0) return pool;
  const filtered = pool.filter((c) => !crossVideoExcludeIds.has(c.asset.id));
  const minKeep = Math.max(8, Math.ceil(pool.length * 0.15));
  if (filtered.length >= minKeep) return filtered;
  if (filtered.length > 0) return filtered;
  return pool;
}

export function orderCuratedCandidatesForBeat(
  candidates: CuratedCandidatePick[]
): CuratedCandidatePick[] {
  if (!archivePreferVideoClips()) return candidates;
  const videos = candidates.filter((c) => c.asset.mediaType === "video");
  const images = candidates.filter((c) => c.asset.mediaType === "image");
  if (videos.length === 0) return candidates;
  return [...videos, ...images];
}

async function probeMediaDurationSec(filePath: string): Promise<number> {
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const dur = parseFloat(String(probe.stdout).trim());
    return !isNaN(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

async function materializeArchiveAsset(asset: MediaArchiveAsset, destPath: string): Promise<void> {
  const local = resolveArchiveAssetLocalPath(asset);
  if (local) {
    fs.copyFileSync(local, destPath);
    return;
  }
  if (asset.storageUrl.startsWith("/manus-storage/")) {
    const key = asset.storageKey ?? asset.storageUrl.replace(/^\/manus-storage\//, "");
    const signedUrl = await storageGetSignedUrl(key);
    const resp = await fetch(signedUrl, { signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) throw new Error(`Archive asset download HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) throw new Error("Archive asset download too small");
    fs.writeFileSync(destPath, buf);
    return;
  }
  const fetchUrl = asset.storageUrl.startsWith("/")
    ? `http://127.0.0.1:${process.env.PORT || 3000}${asset.storageUrl}`
    : asset.storageUrl;
  const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`Archive asset download HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 500) throw new Error("Archive asset download too small");
  fs.writeFileSync(destPath, buf);
}

export type CuratedClipStyleContext = StillStyleContext;

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
      `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, styled.filterComplex)}`
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
    const filterComplex = archiveBlurFillStillsEnabled()
      ? buildBlurFillStillVF(duration, 0.78, "center")
      : buildMatFramedStillVF(duration, 0.74, sceneIndex, beatIndex);
    await exec(
      `${ffmpegBin()} ${buildStillEncodeArgs(imgPath, outPath, duration, filterComplex)}`
    );
  } else {
    const fps = 25;
    const totalFrames = Math.max(50, Math.round(duration * fps));
    const zoomEnd = 1.1;
    const zoomStep = (zoomEnd - 1.0) / totalFrames;
    const padW = Math.round(VIDEO_WIDTH * 1.12);
    const padH = Math.round(VIDEO_HEIGHT * 1.12);
    const variant = archiveStillKenBurnsVariant(sceneIndex, beatIndex);
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
        `-c:v libx264 -preset ${preset} -crf 18 -an -pix_fmt yuv420p "${outPath}"`
    );
  }
  const outDur = await probeMediaDurationSec(outPath);
  if (outDur < duration * 0.85) {
    throw new Error(`Ken Burns clip too short (${outDur.toFixed(2)}s < ${duration.toFixed(2)}s)`);
  }
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
  const take = sourceDur > 0 ? Math.min(duration, sourceDur) : duration;
  let startSec = 0;
  if (sourceDur > take + 0.35) {
    const slack = sourceDur - take;
    startSec = (clipIndex * 0.41 + 0.15) % slack;
  }

  const frameVf = buildFitGrayVideoVF();
  const preset = process.env.RAILWAY_ENVIRONMENT ? "ultrafast" : "veryfast";

  await exec(
    `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inPath}" -t ${take.toFixed(3)} ` +
      `-vf "${frameVf}" -an -c:v libx264 -preset ${preset} -crf 18 -pix_fmt yuv420p "${outPath}"`
  );

  const outDur = await probeMediaDurationSec(outPath);
  if (outDur < take * 0.8) {
    throw new Error(`trimmed clip too short (${outDur.toFixed(2)}s < ${take.toFixed(2)}s)`);
  }
}

/** Download a curated archive asset and return a beat-ready MP4 path. */
export async function prepareCuratedArchiveClip(
  asset: MediaArchiveAsset,
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
  const rawPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}_raw.${ext}`);
  const outPath =
    asset.mediaType === "image"
      ? path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}_still.mp4`)
      : path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}.mp4`);

  await materializeArchiveAsset(asset, rawPath);

  const rawBuffer = fs.readFileSync(rawPath);
  if (await archiveClipHasBakedEditText(rawBuffer, asset.mimeType)) {
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch { /* ignore */ }
    throw new Error(`curated asset ${asset.id} has baked edit text — skipped`);
  }

  if (asset.mediaType === "image") {
    await convertImageToKenBurns(rawPath, outPath, duration, sceneIndex, beatIndex, styleContext);
  } else {
    await trimVideoClip(rawPath, outPath, duration, beatIndex, styleContext, sceneIndex, beatIndex);
  }

  try {
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  } catch {
    /* ignore */
  }

  return outPath;
}

export type CuratedCandidatePick = {
  asset: MediaArchiveAsset;
  archiveName: string;
  score: number;
  archiveNicheTags?: string[];
};

async function loadArchiveAssetsForSearch(
  archiveId: number,
  assetsCache?: Map<number, MediaArchiveAsset[]>
): Promise<MediaArchiveAsset[]> {
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
  beatIndex = 0
): CuratedCandidatePick[] {
  const ranked = pool.map((c) => ({
    ...c,
    score: scoreCuratedAsset(
      c.asset,
      c.archiveNicheTags ?? normalizeMediaTags(c.asset.tags ?? []),
      beatTags,
      topicAnchors,
      beatText
    ),
  }));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: MediaArchiveAsset) => (x.mediaType === "video" ? 2 : 0);
    if (videoBoost(b.asset) !== videoBoost(a.asset)) {
      return videoBoost(b.asset) - videoBoost(a.asset);
    }
    return ((a.asset.id * 92821 + varietySeed) >>> 0) - ((b.asset.id * 92821 + varietySeed) >>> 0);
  });
  const banded: CuratedCandidatePick[] = [];
  let i = 0;
  while (i < ranked.length) {
    const topScore = ranked[i]!.score;
    let j = i + 1;
    while (j < ranked.length && ranked[j]!.score >= topScore - 3) j++;
    const band = ranked.slice(i, j);
    banded.push(...seededShuffle(band, varietySeed + beatIndex * 9973 + i * 17));
    i = j;
  }
  return rotateCuratedCandidates(banded, varietySeed, beatIndex);
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
    assetsCache?: Map<number, MediaArchiveAsset[]>;
  }
): Promise<CuratedCandidatePick[]> {
  const varietySeed = options?.varietySeed ?? 0;
  const crossVideoExcludeIds = options?.crossVideoExcludeIds ?? new Set<number>();
  const { beatTags, topicAnchors, allTags } = buildBeatMatchTags(beat, scene, videoTitle);
  const sceneTags = extractSceneSearchTags(beat.text);
  const visualTags = extractVisualSearchTags(beat.text);

  const listed = await listCuratedArchiveCandidates(
    beatTags,
    usedAssetIds,
    usedStorageUrls,
    topicAnchors,
    allTags,
    beat.text,
    crossVideoExcludeIds,
    options?.assetsCache
  );

  let ranked = rankCuratedCandidatesForBeat(
    orderCuratedCandidatesForBeat(listed),
    beatTags,
    topicAnchors,
    beat.text,
    varietySeed,
    beat.index
  );

  const prioritize = sceneTags.length > 0 ? sceneTags : visualTags;
  if (prioritize.length > 0) {
    const matched = ranked.filter((p) => countVisualTagHits(p.asset, prioritize) > 0);
    if (matched.length > 0) {
      ranked = [...matched, ...ranked.filter((p) => !matched.includes(p))];
    }
  }

  return ranked;
}

/** Skip FFmpeg when metadata already rules out an asset. */
export function archiveAssetPreflight(
  asset: MediaArchiveAsset,
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
  } = {}
): boolean {
  if (usedAssetIds.has(asset.id) || usedStorageUrls.has(asset.storageUrl)) return false;
  if (isCuratedOffTopicAsset(asset, topicAnchors, beatTags)) return false;
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
    assetsCache?: Map<number, MediaArchiveAsset[]>;
  }
): Promise<string | null> {
  const relaxed = options?.relaxed === true;
  const varietySeed = options?.varietySeed ?? 0;
  const crossVideoExcludeIds = options?.crossVideoExcludeIds ?? new Set<number>();
  const { beatTags } = buildBeatMatchTags(beat, scene, videoTitle);
  const candidates = await searchCuratedCandidatesForBeat(
    beat,
    scene,
    usedAssetIds,
    usedStorageUrls,
    videoTitle,
    { varietySeed, crossVideoExcludeIds, assetsCache: options?.assetsCache }
  );
  if (!candidates.length) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: no unused curated archive asset` +
        (beatTags.length ? ` (beat tags: ${beatTags.slice(0, 6).join(", ")})` : "")
    );
    return null;
  }

  const topScore = candidates[0]?.score ?? 0;
  const minAcceptScore = relaxed ? 1 : Math.max(6, Math.round(topScore * 0.35));
  const tryOrder = rotateCuratedCandidates(candidates, varietySeed, beat.index);

  for (const picked of tryOrder) {
    if (!relaxed && picked.score < minAcceptScore && topScore > minAcceptScore + 8) {
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
        const title = (picked.asset.title ?? "").toLowerCase();
        const tags = normalizeMediaTags(picked.asset.tags ?? []);
        return title.includes(t) || tags.some((x) => x === t || x.includes(t));
      });
      console.log(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated archive "${picked.asset.title ?? picked.asset.id}" ` +
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
    }
  }

  return null;
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
