/**
 * Curated media archive — pick tagged assets from admin libraries for pipeline beats.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { resolveLocalVideoPath } from "./storageLocal";
import { archiveClipHasBakedEditText } from "./archiveClipFilter";
import { curatedArchiveOnlyVisuals, archiveVisualMaxClipSec } from "./sourcingPolicy";
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
  const m = path.basename(filePath).match(/_curated_a(\d+)\.mp4$/i);
  return m ? Number(m[1]) : null;
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
  const maxSec = curatedArchiveOnlyVisuals() ? archiveVisualMaxClipSec() : CLIP_MAX_SEC;
  return Math.max(CLIP_MIN_SEC, Math.min(maxSec, holdSec));
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
export function extractTopicAnchorTags(videoTitle?: string, extraText?: string): string[] {
  const raw = [videoTitle ?? "", extraText ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !QUERY_STOP_WORDS.has(w));
  return normalizeMediaTags(raw).slice(0, 8);
}

export function buildCuratedQueryTags(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  videoTitle?: string
): string[] {
  const anchors = extractTopicAnchorTags(videoTitle, scene.text);
  const raw = [
    ...anchors,
    ...beat.keywords,
    beat.searchQuery ?? "",
    beat.text,
    scene.visualCue ?? "",
    scene.pexelsQuery ?? "",
    scene.text,
    videoTitle ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return normalizeMediaTags([...anchors, ...raw]).slice(0, 24);
}

function archiveMatchesQuery(
  archiveName: string,
  archiveNicheTags: string[],
  queryTags: string[],
  anchorTags: string[]
): boolean {
  const name = archiveName.toLowerCase();
  const combined = normalizeMediaTags([...anchorTags, ...queryTags]);
  if (!combined.length) return true;
  if (tagsOverlap(combined, archiveNicheTags)) return true;
  return combined.some((q) => q.length >= 4 && name.includes(q));
}

export function scoreCuratedAsset(
  asset: MediaArchiveAsset,
  archiveNicheTags: string[],
  queryTags: string[],
  anchorTags: string[] = []
): number {
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  const title = (asset.title ?? "").toLowerCase();
  let score = 0;
  for (const anchor of anchorTags) {
    if (title.includes(anchor)) score += 18;
    for (const t of assetTags) {
      if (t === anchor) score += 36;
      else if (t.includes(anchor) || anchor.includes(t)) score += 12;
    }
    for (const n of archiveNicheTags) {
      if (n === anchor || tMatches(n, anchor)) score += 8;
    }
  }
  for (const q of queryTags) {
    if (anchorTags.includes(q)) continue;
    if (title.includes(q)) score += 6;
    for (const t of assetTags) {
      if (t === q) score += 12;
      else if (t.includes(q) || q.includes(t)) score += 4;
    }
    for (const n of archiveNicheTags) {
      if (n === q || tMatches(n, q)) score += 2;
    }
  }
  for (const n of archiveNicheTags) {
    for (const t of assetTags) {
      if (t === n || t.includes(n) || n.includes(t)) score += 3;
    }
  }
  return score;
}

function tMatches(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

export async function listCuratedArchiveCandidates(
  queryTags: string[],
  excludeIds: Set<number>,
  excludeStorageUrls: Set<string>,
  anchorTags: string[] = []
): Promise<Array<{ asset: MediaArchiveAsset; archiveName: string; score: number }>> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  if (!archives.length) return [];

  const matchingArchives = archives.filter((archive) =>
    archiveMatchesQuery(archive.name, normalizeMediaTags(archive.nicheTags ?? []), queryTags, anchorTags)
  );
  const searchArchives = matchingArchives.length > 0 ? matchingArchives : archives;

  const scored: Array<{ asset: MediaArchiveAsset; archiveName: string; score: number }> = [];
  const fallback: typeof scored = [];

  for (const archive of searchArchives) {
    const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
    const assets = await getMediaArchiveAssets(archive.id);
    for (const asset of assets) {
      if (excludeIds.has(asset.id)) continue;
      if (excludeStorageUrls.has(asset.storageUrl)) continue;
      const score = scoreCuratedAsset(asset, nicheTags, queryTags, anchorTags);
      if (score > 0) scored.push({ asset, score, archiveName: archive.name });
      else fallback.push({ asset, score: 1, archiveName: archive.name });
    }
  }

  const pool = scored.length > 0 ? scored : fallback;
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const videoBoost = (x: MediaArchiveAsset) => (x.mediaType === "video" ? 1 : 0);
    return videoBoost(b.asset) - videoBoost(a.asset);
  });
  return pool;
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

async function materializeAssetUrl(storageUrl: string, destPath: string): Promise<void> {
  const local = storageUrl.startsWith("/local-storage/")
    ? resolveLocalVideoPath(storageUrl)
    : fs.existsSync(storageUrl)
      ? storageUrl
      : null;
  if (local) {
    fs.copyFileSync(local, destPath);
    return;
  }
  const fetchUrl = storageUrl.startsWith("/")
    ? `http://127.0.0.1:${process.env.PORT || 3000}${storageUrl}`
    : storageUrl;
  const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`Archive asset download HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 500) throw new Error("Archive asset download too small");
  fs.writeFileSync(destPath, buf);
}

/** Ken Burns motion — visible pan/zoom for full beat duration (avoids frozen stills). */
async function convertImageToKenBurns(
  imgPath: string,
  outPath: string,
  duration: number
): Promise<void> {
  const fps = 25;
  const totalFrames = Math.max(50, Math.round(duration * fps));
  const zoomEnd = 1.12;
  const zoomStep = (zoomEnd - 1.0) / totalFrames;
  const padW = Math.round(VIDEO_WIDTH * 1.12);
  const padH = Math.round(VIDEO_HEIGHT * 1.12);
  await exec(
    `${ffmpegBin()} -y -loop 1 -i "${imgPath}" -t ${duration.toFixed(3)} ` +
      `-vf "scale=${padW}:${padH}:force_original_aspect_ratio=increase,` +
      `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
      `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
      `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
  );
  const outDur = await probeMediaDurationSec(outPath);
  if (outDur < duration * 0.85) {
    throw new Error(`Ken Burns clip too short (${outDur.toFixed(2)}s < ${duration.toFixed(2)}s)`);
  }
}

async function trimVideoClip(
  inPath: string,
  outPath: string,
  duration: number,
  clipIndex = 0
): Promise<void> {
  const sourceDur = await probeMediaDurationSec(inPath);
  const take = sourceDur > 0 ? Math.min(duration, sourceDur) : duration;
  let startSec = 0;
  if (sourceDur > take + 0.35) {
    const slack = sourceDur - take;
    startSec = (clipIndex * 0.41 + 0.15) % slack;
  }

  const fps = 25;
  const totalFrames = Math.max(50, Math.round(take * fps));
  const zoomEnd = take >= 2.8 ? 1.06 : 1.0;
  const zoomStep = zoomEnd > 1 ? (zoomEnd - 1.0) / totalFrames : 0;

  const vf =
    zoomEnd > 1
      ? `scale=${Math.round(VIDEO_WIDTH * 1.08)}:${Math.round(VIDEO_HEIGHT * 1.08)}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
        `d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}`
      : `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`;

  await exec(
    `${ffmpegBin()} -y -ss ${startSec.toFixed(3)} -i "${inPath}" -t ${take.toFixed(3)} ` +
      `-vf "${vf}" ` +
      `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
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
  holdSec: number
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
  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_a${asset.id}.mp4`);

  await materializeAssetUrl(asset.storageUrl, rawPath);

  const rawBuffer = fs.readFileSync(rawPath);
  if (await archiveClipHasBakedEditText(rawBuffer, asset.mimeType)) {
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch { /* ignore */ }
    throw new Error(`curated asset ${asset.id} has baked edit text — skipped`);
  }

  if (asset.mediaType === "image") {
    await convertImageToKenBurns(rawPath, outPath, duration);
  } else {
    await trimVideoClip(rawPath, outPath, duration, beatIndex);
  }

  try {
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  } catch {
    /* ignore */
  }

  return outPath;
}

export async function fetchCuratedArchiveBeatClip(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  workDir: string,
  sceneIndex: number,
  holdSec: number,
  usedAssetIds: Set<number>,
  usedStorageUrls: Set<string>,
  videoTitle?: string
): Promise<string | null> {
  const queryTags = buildCuratedQueryTags(beat, scene, videoTitle);
  const anchorTags = extractTopicAnchorTags(videoTitle, scene.text);
  const candidates = await listCuratedArchiveCandidates(
    queryTags,
    usedAssetIds,
    usedStorageUrls,
    anchorTags
  );
  if (!candidates.length) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: no unused curated archive asset` +
        (queryTags.length ? ` (tags: ${queryTags.slice(0, 6).join(", ")})` : "")
    );
    return null;
  }

  for (const picked of candidates) {
    if (usedAssetIds.has(picked.asset.id) || usedStorageUrls.has(picked.asset.storageUrl)) {
      continue;
    }
    try {
      const clipPath = await prepareCuratedArchiveClip(
        picked.asset,
        workDir,
        sceneIndex,
        beat.index,
        holdSec
      );
      console.log(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated archive "${picked.asset.title ?? picked.asset.id}" ` +
          `from "${picked.archiveName}" (score ${picked.score}, ${clampHoldSec(holdSec).toFixed(1)}s)`
      );
      usedAssetIds.add(picked.asset.id);
      usedStorageUrls.add(picked.asset.storageUrl);
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
