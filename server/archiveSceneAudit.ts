/**
 * Audit archive clips — detect whether each video is one scene or multiple shots.
 */
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import {
  detectInteriorCutTimesInFile,
  probeVideoDurationSec,
} from "./archiveVideoSplitter";
import {
  filterMediaArchiveAssets,
  getMediaArchiveAssetById,
  getMediaArchiveAssets,
  getMediaArchiveById,
  type MediaArchiveAsset,
} from "./db";

export type ArchiveSceneAuditStatus =
  | "single_scene"
  | "multi_scene"
  | "skipped_image"
  | "file_missing"
  | "download_failed"
  | "analyze_failed";

export type ArchiveSceneAuditEntry = {
  assetId: number;
  status: ArchiveSceneAuditStatus;
  /** Estimated number of distinct shots (1 = OK). */
  sceneCount: number;
  interiorCutCount: number;
  durationSec?: number;
  cutTimesSec?: number[];
};

export type ArchiveSceneAuditBatchResult = {
  processed: number;
  singleScene: number;
  multiScene: number;
  skippedImage: number;
  fileMissing: number;
  downloadFailed: number;
  analyzeFailed: number;
  results: ArchiveSceneAuditEntry[];
};

const AUDIT_CONCURRENCY = 2;

export async function auditArchiveAssetScene(
  asset: Pick<
    MediaArchiveAsset,
    "id" | "mediaType" | "storageUrl" | "storageKey" | "mimeType" | "durationSec"
  >
): Promise<ArchiveSceneAuditEntry> {
  if (asset.mediaType !== "video") {
    return {
      assetId: asset.id,
      status: "skipped_image",
      sceneCount: 1,
      interiorCutCount: 0,
    };
  }

  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) {
    return {
      assetId: asset.id,
      status: loaded.reason === "download_failed" ? "download_failed" : "file_missing",
      sceneCount: 0,
      interiorCutCount: 0,
    };
  }

  const { localPath, cleanup } = loaded.result;
  try {
    let dur = asset.durationSec ?? 0;
    if (!dur || dur <= 0) {
      dur = await probeVideoDurationSec(localPath);
    }
    if (dur <= 0) {
      return {
        assetId: asset.id,
        status: "analyze_failed",
        sceneCount: 0,
        interiorCutCount: 0,
      };
    }

    const cuts = await detectInteriorCutTimesInFile(localPath, dur);
    const sceneCount = cuts.length + 1;
    return {
      assetId: asset.id,
      status: cuts.length > 0 ? "multi_scene" : "single_scene",
      sceneCount,
      interiorCutCount: cuts.length,
      durationSec: dur,
      cutTimesSec: cuts.slice(0, 12),
    };
  } catch (err) {
    console.warn(`[SceneAudit] asset ${asset.id} failed:`, (err as Error).message?.slice(0, 120));
    return {
      assetId: asset.id,
      status: "analyze_failed",
      sceneCount: 0,
      interiorCutCount: 0,
    };
  } finally {
    cleanup?.();
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

/** Scan up to 40 clips per call (FFmpeg per video). */
export async function auditArchiveAssetScenes(opts: {
  archiveId: number;
  ids: number[];
}): Promise<ArchiveSceneAuditBatchResult> {
  const archive = await getMediaArchiveById(opts.archiveId);
  if (!archive) {
    throw new Error("Archive not found");
  }

  const uniqueIds = [...new Set(opts.ids)].slice(0, 40);
  const assets: MediaArchiveAsset[] = [];
  for (const id of uniqueIds) {
    const asset = await getMediaArchiveAssetById(id);
    if (asset && asset.archiveId === opts.archiveId) assets.push(asset);
  }

  const results = await mapPool(assets, AUDIT_CONCURRENCY, (asset) => auditArchiveAssetScene(asset));

  const summary: ArchiveSceneAuditBatchResult = {
    processed: results.length,
    singleScene: 0,
    multiScene: 0,
    skippedImage: 0,
    fileMissing: 0,
    downloadFailed: 0,
    analyzeFailed: 0,
    results,
  };

  for (const r of results) {
    if (r.status === "single_scene") summary.singleScene++;
    else if (r.status === "multi_scene") summary.multiScene++;
    else if (r.status === "skipped_image") summary.skippedImage++;
    else if (r.status === "file_missing") summary.fileMissing++;
    else if (r.status === "download_failed") summary.downloadFailed++;
    else if (r.status === "analyze_failed") summary.analyzeFailed++;
  }

  return summary;
}

/** Resolve asset ids for a full-archive audit (respects search filter). */
export async function resolveArchiveAuditTargetIds(opts: {
  archiveId: number;
  search?: string;
  ids?: number[];
}): Promise<number[]> {
  if (opts.ids?.length) {
    return [...new Set(opts.ids)];
  }
  const assets = await getMediaArchiveAssets(opts.archiveId);
  const filtered = filterMediaArchiveAssets(assets, { search: opts.search });
  return filtered.filter((a) => a.mediaType === "video").map((a) => a.id);
}
