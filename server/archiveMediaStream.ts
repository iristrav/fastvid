/**
 * Admin-only archive asset streaming with Range support (fixes clip preview upstream errors).
 */
import type { Express, Request, Response } from "express";
import { createReadStream, statSync } from "fs";
import { loadArchiveAssetFile } from "./archiveAssetLoad";
import { getUserFromRequest } from "./_core/context";
import { getMediaArchiveAssetById } from "./db";
import { getStorageBackend, normalizeStorageKey } from "./storageBackend";
import { storageGetSignedUrl } from "./storage";
import { withArchiveMediaVersion, type ArchiveMediaIdentity } from "@shared/archiveMediaVersion";

function streamLocalFileWithRange(req: Request, res: Response, filePath: string, contentType: string): void {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", fileSize);
  createReadStream(filePath).pipe(res);
}

/**
 * RONDE 177 — pass the asset row whenever the caller has it.
 *
 * Both routes answer with a private cache directive (an hour for a streamed file, five minutes for
 * the redirect to a signed URL), and both addresses are built from the id alone — so a trimmed clip
 * kept its address and the browser kept replaying the untrimmed bytes it already had. The optional
 * `asset` appends a token that changes exactly when storagePut writes a new file. Left out, the
 * behaviour is what it always was.
 */
export function archiveMediaStreamUrl(assetId: number, asset?: ArchiveMediaIdentity): string {
  return withArchiveMediaVersion(`/api/admin/archive/media/${assetId}`, asset);
}

/** User-facing stream URL for the video editor (authenticated users). */
export function editorArchiveMediaUrl(assetId: number, asset?: ArchiveMediaIdentity): string {
  return withArchiveMediaVersion(`/api/editor/archive/media/${assetId}`, asset);
}

async function streamArchiveAsset(req: Request, res: Response, assetId: number): Promise<void> {
  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  // For S3/Forge assets, redirect directly to a pre-signed URL so the browser
  // handles range requests natively — avoids an extra proxy hop that can timeout.
  const backend = getStorageBackend();
  if (backend === "s3" || backend === "forge") {
    // storageUrl always has the correct key (with hash suffix added by storagePut).
    // storageKey in DB may lack the hash suffix — do not use it as primary source.
    const key = asset.storageUrl.startsWith("/manus-storage/")
      ? asset.storageUrl.replace(/^\/manus-storage\//, "")
      : asset.storageKey
        ? normalizeStorageKey(asset.storageKey)
        : null;
    if (key) {
      try {
        const signedUrl = await storageGetSignedUrl(key);
        if (signedUrl.startsWith("http://") || signedUrl.startsWith("https://")) {
          res.setHeader("Cache-Control", "private, max-age=300");
          res.redirect(307, signedUrl);
          return;
        }
      } catch (err) {
        console.error("[ArchiveMedia] signed URL error for key", key, (err as Error).message?.slice(0, 80));
        res.status(502).json({ error: "Could not generate storage URL" });
        return;
      }
      // Signed URL is a local path (local backend) — fall through to file streaming
    }
  }

  // Local storage: stream directly with range support.
  const loaded = await loadArchiveAssetFile(asset);
  if (!loaded.ok) {
    const message =
      loaded.reason === "download_failed"
        ? "Could not download media from object storage — check S3 credentials or re-upload"
        : "Media file not found — attach a Railway volume or re-upload this clip";
    res.status(404).json({ error: message });
    return;
  }

  const { localPath, mimeType, cleanup } = loaded.result;
  if (cleanup) {
    res.on("close", cleanup);
    res.on("finish", cleanup);
  }

  streamLocalFileWithRange(req, res, localPath, mimeType);
}

export function registerArchiveMediaRoute(app: Express) {
  app.get("/api/admin/archive/media/:assetId", async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user || user.role !== "admin") {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const assetId = parseInt(String(req.params.assetId), 10);
      if (!assetId || Number.isNaN(assetId)) {
        res.status(400).json({ error: "Invalid asset id" });
        return;
      }

      await streamArchiveAsset(req, res, assetId);
    } catch (err) {
      console.error("[ArchiveMedia] stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    }
  });

  /** Editor: any logged-in user can preview archive assets for clip replacement. */
  app.get("/api/editor/archive/media/:assetId", async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const assetId = parseInt(String(req.params.assetId), 10);
      if (!assetId || Number.isNaN(assetId)) {
        res.status(400).json({ error: "Invalid asset id" });
        return;
      }

      await streamArchiveAsset(req, res, assetId);
    } catch (err) {
      console.error("[EditorArchiveMedia] stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    }
  });
}
