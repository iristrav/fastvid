/**
 * Backfill archive asset durationSec — fixes 0s from rounding and missing still durations.
 */
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import {
  archiveStoredDurationSec,
  minSavedArchiveClipSec,
  probeVideoDurationSec,
} from "./archiveVideoSplitter";
import { getMediaArchiveAssets, updateMediaArchiveAsset } from "./db";

export type ArchiveDurationRepairResult = {
  scanned: number;
  updated: number;
  skipped: number;
  deactivated: number;
  sampleUpdates: Array<{ assetId: number; from: number | null; to: number }>;
};

function needsDurationRepair(durationSec: number | null | undefined, minSec: number): boolean {
  if (durationSec == null) return true;
  return durationSec < minSec;
}

export async function repairArchiveAssetDurations(opts: {
  archiveId: number;
  ids?: number[];
}): Promise<ArchiveDurationRepairResult> {
  const minSec = minSavedArchiveClipSec();
  const all = await getMediaArchiveAssets(opts.archiveId);
  const idSet = opts.ids?.length ? new Set(opts.ids) : null;
  const targets = all.filter(
    (a) => a.isActive && (!idSet || idSet.has(a.id)) && needsDurationRepair(a.durationSec, minSec)
  );

  let updated = 0;
  let skipped = 0;
  let deactivated = 0;
  const sampleUpdates: ArchiveDurationRepairResult["sampleUpdates"] = [];

  for (const asset of targets) {
    const from = asset.durationSec ?? null;

    if (asset.mediaType === "image") {
      await updateMediaArchiveAsset(asset.id, { durationSec: minSec });
      updated++;
      if (sampleUpdates.length < 8) sampleUpdates.push({ assetId: asset.id, from, to: minSec });
      continue;
    }

    const loaded = await loadArchiveAssetFile(asset);
    if (!loaded.ok) {
      skipped++;
      continue;
    }

    try {
      const probed = await probeVideoDurationSec(loaded.result.localPath);
      const stored = archiveStoredDurationSec(probed);
      if (stored > 0) {
        await updateMediaArchiveAsset(asset.id, { durationSec: stored });
        updated++;
        if (sampleUpdates.length < 8) sampleUpdates.push({ assetId: asset.id, from, to: stored });
      } else if (probed > 0.05) {
        await updateMediaArchiveAsset(asset.id, {
          isActive: 0,
          durationSec: Math.round(probed * 10) / 10,
        });
        deactivated++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    } finally {
      loaded.result.cleanup?.();
    }
  }

  return {
    scanned: targets.length,
    updated,
    skipped,
    deactivated,
    sampleUpdates,
  };
}
