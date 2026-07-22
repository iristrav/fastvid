/**
 * Trim an archive video clip to its first scene cut point.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { updateMediaArchiveAsset } from "./db";
import { storagePut } from "./storage";

const execFileAsync = promisify(execFile);

async function ffmpegTrim(
  inputPath: string,
  cutSec: number,
  outputPath: string,
): Promise<void> {
  // Try with explicit -ss 0 first for accuracy, fall back without it
  for (const args of [
    ["-y", "-ss", "0", "-i", inputPath, "-t", String(cutSec), "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", outputPath],
    ["-y", "-i", inputPath, "-t", String(cutSec), "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", outputPath],
  ]) {
    try {
      await execFileAsync("ffmpeg", args, { timeout: 120_000 });
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) return;
    } catch {
      // try next
    }
  }
  throw new Error("ffmpeg trim failed");
}

export async function trimArchiveAssetToFirstScene(
  asset: MediaArchiveAsset,
  cutTimeSec: number,
): Promise<{ assetId: number; newDurationSec: number }> {
  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) throw new Error(`Could not load asset file: ${loaded.reason}`);

  const { localPath, cleanup } = loaded.result;
  const ext = path.extname(localPath) || ".mp4";
  const tmpOut = path.join(os.tmpdir(), `archive-trim-${asset.id}-${Date.now()}${ext}`);

  try {
    await ffmpegTrim(localPath, cutTimeSec, tmpOut);
    const data = fs.readFileSync(tmpOut);
    const storageKey = `archive/trimmed/${asset.id}_scene1${ext}`;
    const { key, url } = await storagePut(storageKey, data, asset.mimeType ?? "video/mp4");
    const newDurationSec = Math.round(cutTimeSec * 10) / 10;
    await updateMediaArchiveAsset(asset.id, {
      storageKey: key,
      storageUrl: url,
      durationSec: newDurationSec,
    });
    return { assetId: asset.id, newDurationSec };
  } finally {
    cleanup?.();
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}
