/**
 * Trim an archive clip to a range the user chose — and keep it trimmed.
 *
 * RONDE 98 rewrote this. Two things were wrong:
 *
 *   · It could only shorten from the END. `-t cutSec` takes 0 → cutSec, so a clip whose usable
 *     footage started three seconds in could not be fixed at all: the operator could cut the tail
 *     and nothing else. The admin UI matched, offering one marker.
 *   · storagePut appends a fresh random suffix to every key, so the trimmed file lands at a NEW
 *     object key. The old code wrote the new `storageUrl` to the row and left `storageKey`
 *     pointing at the original. resolveRemoteDownloadUrl prefers storageKey whenever storageUrl is
 *     not an absolute http URL — so the render, and any later load, kept fetching the UNTRIMMED
 *     file. The trim ran, the operator saw the toast, and the video still had the old footage in
 *     it. That is what "de knop werkt niet" was.
 *
 * The asset row keeps its identity throughout: same id, same archive, same provider columns, same
 * title and tags. Only the bytes, the storage location and the duration change, which is what
 * makes the trimmed clip still traceable to the source it came from.
 */
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

/** Shortest clip worth keeping — below this the result is a flash frame, not a scene. */
export const MIN_TRIMMED_CLIP_SEC = 0.5;

export type ArchiveTrimRange = {
  /** Seconds into the source where the kept footage begins. 0 keeps the head. */
  startSec?: number;
  /** Seconds into the source where the kept footage ends. Omitted keeps the tail. */
  endSec?: number;
};

export type ArchiveTrimResult = {
  assetId: number;
  newDurationSec: number;
  startSec: number;
  endSec: number;
  storageKey: string;
  storageUrl: string;
};

/**
 * Validate a requested range against the clip's own duration.
 *
 * Returns the reason as a string rather than throwing, because every one of these is an operator
 * mistake the UI should show, not a server fault.
 */
export function validateTrimRange(
  range: ArchiveTrimRange,
  sourceDurationSec: number
): { ok: true; startSec: number; endSec: number } | { ok: false; reason: string } {
  const start = Math.max(0, range.startSec ?? 0);
  const end = range.endSec ?? sourceDurationSec;
  if (!(end > 0)) return { ok: false, reason: "End point must be greater than zero" };
  if (end <= start) return { ok: false, reason: "End point must come after the start point" };
  if (end - start < MIN_TRIMMED_CLIP_SEC) {
    return { ok: false, reason: `Trimmed clip would be shorter than ${MIN_TRIMMED_CLIP_SEC}s` };
  }
  if (sourceDurationSec > 0 && start >= sourceDurationSec - 0.05) {
    return { ok: false, reason: "Start point is at or past the end of the clip" };
  }
  // A trim that changes nothing is refused rather than silently re-encoding the file: it would
  // move the asset to a new storage key for no reason.
  if (sourceDurationSec > 0 && start <= 0.05 && end >= sourceDurationSec - 0.05) {
    return { ok: false, reason: "That range is the whole clip — nothing to trim" };
  }
  return { ok: true, startSec: start, endSec: Math.min(end, sourceDurationSec || end) };
}

/**
 * Cut the asset down to [startSec, endSec) and store the result as the asset's own file.
 *
 * The old name said "ToFirstScene" because that is all it could do. It is kept as an alias below
 * so existing callers keep working.
 */
export async function trimArchiveAsset(
  asset: MediaArchiveAsset,
  range: ArchiveTrimRange
): Promise<ArchiveTrimResult> {
  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) throw new Error(`Cannot load asset ${asset.id}: ${loaded.reason}`);

  const { localPath, mimeType, cleanup } = loaded.result;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
  const ext = localPath.match(/\.[^.]+$/)?.[0] ?? ".mp4";
  const outPath = path.join(workDir, `trimmed${ext}`);

  try {
    // Probe the real file rather than trusting the stored durationSec, which is what the previous
    // trim may have left behind.
    const sourceDur = await probeVideoDurationSec(localPath);
    const verdict = validateTrimRange(range, sourceDur);
    if (!verdict.ok) throw new Error(verdict.reason);
    const { startSec, endSec } = verdict;
    const keepSec = endSec - startSec;

    const bin = ffmpegBin();
    // -ss BEFORE -i seeks fast; the re-encode that follows makes the cut frame-accurate anyway, so
    // there is no keyframe drift to pay for.
    const cmd =
      `"${bin}" -y -ss ${startSec.toFixed(3)} -i "${localPath}" -t ${keepSec.toFixed(3)} ` +
      `-c:v libx264 ${ffmpegThreadFlag()} -preset fast -crf 22 -movflags +faststart -c:a aac "${outPath}"`;
    await exec(cmd);

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      // Stream copy fallback: cuts on the nearest keyframe, which is less exact but survives
      // sources the encoder refuses.
      const cmd2 =
        `"${bin}" -y -ss ${startSec.toFixed(3)} -i "${localPath}" -t ${keepSec.toFixed(3)} -c copy "${outPath}"`;
      await exec(cmd2);
    }
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      throw new Error("Trim produced no usable file");
    }

    const newDuration = await probeVideoDurationSec(outPath);
    const buffer = fs.readFileSync(outPath);
    const baseKey = asset.storageKey ?? asset.storageUrl.replace(/^\/manus-storage\//, "");
    const { key, url } = await storagePut(baseKey, buffer, mimeType ?? "video/mp4");

    /**
     * BOTH columns, together.
     *
     * storagePut gives the trimmed file a new key every time (appendHashSuffix is random), and
     * resolveRemoteDownloadUrl prefers storageKey over storageUrl. Writing only the URL left the
     * row pointing at two different files and the loader picking the old one — the trim was real
     * on disk and invisible everywhere else.
     */
    await updateMediaArchiveAsset(asset.id, {
      storageUrl: url,
      storageKey: key,
      durationSec: newDuration > 0 ? newDuration : keepSec,
    });

    console.log(
      `[ArchiveTrim] asset=${asset.id} kept ${startSec.toFixed(2)}s–${endSec.toFixed(2)}s ` +
        `(${(newDuration > 0 ? newDuration : keepSec).toFixed(2)}s) key=${key}`
    );

    return {
      assetId: asset.id,
      newDurationSec: newDuration > 0 ? newDuration : keepSec,
      startSec,
      endSec,
      storageKey: key,
      storageUrl: url,
    };
  } finally {
    cleanup?.();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Backwards-compatible alias: cut everything after `cutSec`. */
export async function trimArchiveAssetToFirstScene(
  asset: MediaArchiveAsset,
  cutSec: number
): Promise<{ assetId: number; newDurationSec: number }> {
  return trimArchiveAsset(asset, { startSec: 0, endSec: cutSec });
}
