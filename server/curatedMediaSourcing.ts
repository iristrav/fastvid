/**
 * Curated media archive — pick tagged assets from admin libraries for pipeline beats.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { resolveLocalVideoPath } from "./storageLocal";
import {
  getAllMediaArchives,
  getMediaArchiveAssets,
  normalizeMediaTags,
  type MediaArchiveAsset,
} from "./db";

const exec = promisify(execCb);
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

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

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

export function buildCuratedQueryTags(
  beat: CuratedBeatContext,
  scene: CuratedSceneContext,
  videoTitle?: string
): string[] {
  const raw = [
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
  return normalizeMediaTags(raw).slice(0, 24);
}

function scoreAsset(
  asset: MediaArchiveAsset,
  archiveNicheTags: string[],
  queryTags: string[]
): number {
  const assetTags = normalizeMediaTags(asset.tags ?? []);
  const title = (asset.title ?? "").toLowerCase();
  let score = 0;
  for (const q of queryTags) {
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

export async function pickCuratedArchiveAsset(
  queryTags: string[],
  excludeIds: Set<number>
): Promise<{ asset: MediaArchiveAsset; archiveName: string; score: number } | null> {
  const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
  if (!archives.length) return null;

  const candidates: { asset: MediaArchiveAsset; score: number; archiveName: string }[] = [];
  for (const archive of archives) {
    const nicheTags = normalizeMediaTags(archive.nicheTags ?? []);
    const assets = await getMediaArchiveAssets(archive.id);
    for (const asset of assets) {
      if (excludeIds.has(asset.id)) continue;
      const score = scoreAsset(asset, nicheTags, queryTags);
      if (score > 0) {
        candidates.push({ asset, score, archiveName: archive.name });
      }
    }
  }

  if (!candidates.length) {
    for (const archive of archives) {
      const assets = await getMediaArchiveAssets(archive.id);
      for (const asset of assets) {
        if (!excludeIds.has(asset.id)) {
          candidates.push({ asset, score: 1, archiveName: archive.name });
        }
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const videoBoost = (x: MediaArchiveAsset) => (x.mediaType === "video" ? 1 : 0);
    const vb = videoBoost(b.asset) - videoBoost(a.asset);
    if (vb !== 0) return vb;
    return b.score - a.score;
  });

  const top = candidates[0];
  return { asset: top.asset, archiveName: top.archiveName, score: top.score };
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

async function convertImageToKenBurns(
  imgPath: string,
  outPath: string,
  duration: number
): Promise<void> {
  const fps = 25;
  const totalFrames = Math.max(25, Math.round(duration * fps));
  const zoomEnd = 1.03;
  const zoomStep = (zoomEnd - 1.0) / totalFrames;
  const padW = Math.round(VIDEO_WIDTH * 1.05);
  const padH = Math.round(VIDEO_HEIGHT * 1.05);
  await exec(
    `${ffmpegBin()} -y -loop 1 -i "${imgPath}" -t ${duration} ` +
      `-vf "scale=${padW}:${padH}:force_original_aspect_ratio=increase,` +
      `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2,` +
      `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
      `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
  );
}

async function trimVideoClip(
  inPath: string,
  outPath: string,
  duration: number
): Promise<void> {
  await exec(
    `${ffmpegBin()} -y -i "${inPath}" -t ${duration} ` +
      `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" ` +
      `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
  );
  try {
    const probe = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outPath}"`
    );
    const dur = parseFloat(String(probe.stdout).trim());
    if (isNaN(dur) || dur < 0.5) throw new Error("trimmed clip too short");
  } catch {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 5000) {
      throw new Error("trimmed clip invalid");
    }
  }
}

/** Download a curated archive asset and return a beat-ready MP4 path. */
export async function prepareCuratedArchiveClip(
  asset: MediaArchiveAsset,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  clipDuration: number
): Promise<string> {
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
  const rawPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated_raw.${ext}`);
  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_curated.mp4`);

  await materializeAssetUrl(asset.storageUrl, rawPath);

  if (asset.mediaType === "image") {
    await convertImageToKenBurns(rawPath, outPath, clipDuration);
  } else {
    await trimVideoClip(rawPath, outPath, clipDuration);
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
  clipDuration: number,
  usedAssetIds: Set<number>,
  videoTitle?: string
): Promise<string | null> {
  const queryTags = buildCuratedQueryTags(beat, scene, videoTitle);
  const picked = await pickCuratedArchiveAsset(queryTags, usedAssetIds);
  if (!picked) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: no curated archive asset` +
        (queryTags.length ? ` (tags: ${queryTags.slice(0, 6).join(", ")})` : "")
    );
    return null;
  }

  try {
    const clipPath = await prepareCuratedArchiveClip(
      picked.asset,
      workDir,
      sceneIndex,
      beat.index,
      clipDuration
    );
    usedAssetIds.add(picked.asset.id);
    console.log(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated archive "${picked.asset.title ?? picked.asset.id}" ` +
        `from "${picked.archiveName}" (score ${picked.score})`
    );
    return clipPath;
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: curated asset failed:`,
      (err as Error).message
    );
    return null;
  }
}
