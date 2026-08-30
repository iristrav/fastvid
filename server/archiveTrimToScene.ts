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
import { validateTrimRange, type ArchiveTrimRange } from "@shared/archiveTrim";

const exec = promisify(execCb);

/** Shortest clip worth keeping — below this the result is a flash frame, not a scene. */
/**
 * RONDE 108: the range rule moved to @shared/archiveTrim so the archive UI can ask it too.
 *
 * It was server-only, so the trim panel offered its button for ranges the server was always going
 * to refuse — the operator clicked and got a message about a range they could not see was wrong.
 * Re-exported here so every existing importer of this module keeps working unchanged.
 */
export {
  MIN_TRIMMED_CLIP_SEC,
  validateTrimRange,
  type ArchiveTrimRange,
} from "@shared/archiveTrim";

export type ArchiveTrimResult = {
  assetId: number;
  newDurationSec: number;
  startSec: number;
  endSec: number;
  storageKey: string;
  storageUrl: string;
};

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
     *
     * ── RONDE 177: and every verdict that was reached about the OLD footage ──────────────────
     *
     * These five columns are not facts about the asset, they are conclusions drawn from watching
     * its frames. The frames just changed, so the conclusions are about a file that no longer
     * exists — and the most common reason to trim a clip is precisely that its first seconds were
     * the problem the conclusion recorded.
     *
     * Every one of them already treats NULL as "not looked at yet", which is the honest state
     * here: the annotator re-runs when annotationVersion no longer matches, the overlay filter
     * re-checks when hasBakedEditText is null, and the RONDE 118 preview sweep re-checks when
     * previewCheckedAt is null. Nothing is declared broken; it is declared unexamined.
     *
     * editorialScore deliberately survives. It is rewritten by the annotator on its next pass and
     * is read as a ranking signal in the meantime, where null is treated as a below-average 50 —
     * so clearing it would quietly demote every freshly trimmed clip for no gain.
     */
    await updateMediaArchiveAsset(asset.id, {
      storageUrl: url,
      storageKey: key,
      durationSec: newDuration > 0 ? newDuration : keepSec,
      annotationJson: null,
      annotationVersion: null,
      hasBakedEditText: null,
      previewCheckedAt: null,
      previewIssue: null,
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
