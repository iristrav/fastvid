import fs from "fs";
import os from "os";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { storagePut } from "./storage";
import { updateMediaArchiveAsset } from "./db";
import { ffmpegBin } from "./localClipVision";
import { probeVideoDurationSec } from "./archiveVideoSplitter";
import { ffmpegThreadFlag } from "./sourcingPolicy";

const exec = promisify(execCb);

export async function trimArchiveAssetToFirstScene(
  asset: MediaArchiveAsset,
  cutSec: number
): Promise<{ assetId: number; newDurationSec: number }> {
  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) throw new Error(`Cannot load asset ${asset.id}: ${loaded.reason}`);

  const { localPath, mimeType, cleanup } = loaded.result;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
  const ext = localPath.match(/\.[^.]+$/)?.[0] ?? ".mp4";
  const outPath = path.join(workDir, `trimmed${ext}`);

  try {
    const bin = ffmpegBin();
    const cmd = `"${bin}" -y -i "${localPath}" -t ${cutSec} -c:v libx264 ${ffmpegThreadFlag()} -preset fast -crf 22 -movflags +faststart -c:a aac "${outPath}"`;
    await exec(cmd);

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      // fallback without -ss 0
      const cmd2 = `"${bin}" -y -ss 0 -i "${localPath}" -t ${cutSec} -c copy "${outPath}"`;
      await exec(cmd2);
    }

    const newDuration = await probeVideoDurationSec(outPath);
    const buffer = fs.readFileSync(outPath);
    const storageKey = asset.storageKey ?? asset.storageUrl.replace(/^\/manus-storage\//, "");
    const { url } = await storagePut(storageKey, buffer, mimeType ?? "video/mp4");

    await updateMediaArchiveAsset(asset.id, {
      storageUrl: url,
      durationSec: newDuration > 0 ? newDuration : cutSec,
    });

    return { assetId: asset.id, newDurationSec: newDuration > 0 ? newDuration : cutSec };
  } finally {
    cleanup?.();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
