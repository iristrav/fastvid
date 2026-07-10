/**
 * Trim a media archive video clip to its first scene.
 *
 * Downloads the asset, re-encodes from 0 to cutTimeSec via FFmpeg,
 * uploads the result back to storage, and updates the DB record.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { storagePut } from "./storage";
import { updateMediaArchiveAsset } from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

const exec = promisify(execCb);

export async function trimArchiveAssetToFirstScene(
  asset: MediaArchiveAsset,
  cutTimeSec: number,
): Promise<{ assetId: number; newDurationSec: number }> {
  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) {
    throw new Error(
      loaded.reason === "download_failed"
        ? "Bestand kon niet worden gedownload van opslag"
        : "Bestand ontbreekt op server"
    );
  }

  const { localPath, cleanup } = loaded.result;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
  const outPath = path.join(workDir, `trimmed_${asset.id}.mp4`);

  try {
    const dur = cutTimeSec.toFixed(3);

    // Re-encode to ensure clean I-frame at start; mirrors extractVideoSegment strategy.
    const strategies = [
      `${ffmpegBin()} -y -ss 0 -i "${localPath}" -t ${dur} ` +
        `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p -movflags +faststart ` +
        `-avoid_negative_ts make_zero -reset_timestamps 1 -threads 2 "${outPath}"`,
      `${ffmpegBin()} -y -i "${localPath}" -t ${dur} ` +
        `-c:v libx264 -preset ultrafast -crf 23 -an -pix_fmt yuv420p -movflags +faststart ` +
        `-avoid_negative_ts make_zero -reset_timestamps 1 -threads 2 "${outPath}"`,
    ];

    let trimmed = false;
    for (const cmd of strategies) {
      try {
        await exec(cmd, { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        if (size >= 8000) { trimmed = true; break; }
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[TrimToScene] ffmpeg error asset ${asset.id}:`, (err as Error).message?.slice(0, 200));
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
      }
    }

    if (!trimmed) throw new Error("FFmpeg kon de clip niet bijknippen");

    // Upload trimmed file to storage under a new key so the original is not immediately lost.
    const ext = path.extname(asset.storageUrl || asset.storageKey || ".mp4") || ".mp4";
    const relKey = `archive/trimmed/${asset.id}_scene1${ext}`;
    const fileBuffer = fs.readFileSync(outPath);
    const { key, url } = await storagePut(relKey, fileBuffer, "video/mp4");

    const newDurationSec = Math.floor(cutTimeSec);

    await updateMediaArchiveAsset(asset.id, {
      storageUrl: url,
      storageKey: key,
      durationSec: newDurationSec,
    });

    console.log(`[TrimToScene] asset ${asset.id} trimmed to ${newDurationSec}s → ${url}`);
    return { assetId: asset.id, newDurationSec };
  } finally {
    cleanup?.();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
