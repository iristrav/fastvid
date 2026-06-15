/**
 * Resolve archive clip files for AI tagging, dedup, and admin streaming.
 */
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "node-fetch";
import type { MediaArchiveAsset } from "../drizzle/schema";
import { storageGetSignedUrl } from "./storage";
import { getStorageBackend } from "./storageBackend";
import { LOCAL_UPLOADS_DIR, resolveLocalStorageFilePath, resolveLocalVideoPath } from "./storageLocal";

export type ArchiveAssetLoadResult = {
  localPath: string;
  mimeType: string;
  cleanup?: () => void;
};

export type ArchiveAssetLoadFailure = "missing" | "download_failed";

function assetMimeType(asset: Pick<MediaArchiveAsset, "mimeType" | "mediaType">): string {
  if (asset.mimeType?.startsWith("video/") || asset.mimeType?.startsWith("image/")) {
    return asset.mimeType;
  }
  return asset.mediaType === "image" ? "image/jpeg" : "video/mp4";
}

function fileExtForMime(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("quicktime") || mimeType.includes("mov")) return "mov";
  return "mp4";
}

async function downloadToTempFile(url: string, ext: string): Promise<string | null> {
  const tempPath = path.join(
    os.tmpdir(),
    `archive-load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 64) return null;
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function resolveRemoteDownloadUrl(
  asset: Pick<MediaArchiveAsset, "storageUrl" | "storageKey">
): Promise<string | null> {
  if (asset.storageUrl.startsWith("http://") || asset.storageUrl.startsWith("https://")) {
    return asset.storageUrl;
  }

  const backend = getStorageBackend();
  const objectKey =
    asset.storageKey?.trim() ||
    (asset.storageUrl.startsWith("/manus-storage/")
      ? asset.storageUrl.replace(/^\/manus-storage\//, "")
      : null);

  if (!objectKey) return null;
  if (backend !== "s3" && backend !== "forge") return null;

  try {
    const signed = await storageGetSignedUrl(objectKey);
    if (signed.startsWith("http://") || signed.startsWith("https://")) return signed;
    if (signed.startsWith("/local-storage/")) {
      const local = resolveLocalVideoPath(signed);
      return local ? signed : null;
    }
    return signed;
  } catch {
    return null;
  }
}

/** Load an archive asset to a readable local path (disk, volume, or temp download from S3). */
export async function loadArchiveAssetFile(
  asset: Pick<MediaArchiveAsset, "storageUrl" | "storageKey" | "mimeType" | "mediaType">
): Promise<{ ok: true; result: ArchiveAssetLoadResult } | { ok: false; reason: ArchiveAssetLoadFailure }> {
  const mimeType = assetMimeType(asset);

  const local = resolveLocalStorageFilePath({
    storageUrl: asset.storageUrl,
    storageKey: asset.storageKey,
  });
  if (local && fs.existsSync(local)) {
    return { ok: true, result: { localPath: local, mimeType } };
  }

  const remoteUrl = await resolveRemoteDownloadUrl(asset);
  if (!remoteUrl) {
    return { ok: false, reason: "missing" };
  }

  if (remoteUrl.startsWith("/local-storage/")) {
    const localFromSigned = resolveLocalVideoPath(remoteUrl);
    if (localFromSigned && fs.existsSync(localFromSigned)) {
      return { ok: true, result: { localPath: localFromSigned, mimeType } };
    }
    return { ok: false, reason: "missing" };
  }

  const tempPath = await downloadToTempFile(remoteUrl, fileExtForMime(mimeType));
  if (!tempPath) {
    return { ok: false, reason: "download_failed" };
  }

  return {
    ok: true,
    result: {
      localPath: tempPath,
      mimeType,
      cleanup: () => {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
      },
    },
  };
}

/** Quick check whether an asset likely still has retrievable media. */
export function archiveAssetHasLocalCopy(
  asset: Pick<MediaArchiveAsset, "storageUrl" | "storageKey">
): boolean {
  const local = resolveLocalStorageFilePath({
    storageUrl: asset.storageUrl,
    storageKey: asset.storageKey,
  });
  if (local && fs.existsSync(local)) return true;

  if (asset.storageUrl.startsWith("http://") || asset.storageUrl.startsWith("https://")) return true;
  if (asset.storageUrl.startsWith("/manus-storage/")) return getStorageBackend() === "s3" || getStorageBackend() === "forge";
  if (asset.storageKey && (getStorageBackend() === "s3" || getStorageBackend() === "forge")) return true;

  if (asset.storageUrl.startsWith("/local-storage/")) {
    const fileName = asset.storageUrl.replace(/^\/local-storage\//, "");
    return fs.existsSync(path.join(LOCAL_UPLOADS_DIR, fileName));
  }

  return false;
}
