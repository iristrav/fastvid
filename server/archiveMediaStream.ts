/**
 * Admin-only archive asset streaming with Range support (fixes clip preview upstream errors).
 */
import type { Express, Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { getUserFromRequest } from "./_core/context";
import { getMediaArchiveAssetById } from "./db";
import { LOCAL_UPLOADS_DIR, resolveLocalVideoPath } from "./storageLocal";
import { storageGetSignedUrl } from "./storage";

function resolveArchiveAssetPath(asset: { storageUrl: string; storageKey: string | null }): string | null {
  const fromUrl = resolveLocalVideoPath(asset.storageUrl);
  if (fromUrl) return fromUrl;

  if (asset.storageKey) {
    const fromKey = path.join(LOCAL_UPLOADS_DIR, asset.storageKey.replace(/\//g, "_"));
    if (existsSync(fromKey)) return fromKey;
  }

  if (asset.storageUrl.startsWith("/local-storage/")) {
    const fileName = asset.storageUrl.replace(/^\/local-storage\//, "");
    const p = path.join(LOCAL_UPLOADS_DIR, fileName);
    if (existsSync(p)) return p;
  }

  return null;
}

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
    if (start >= fileSize || end >= fileSize) {
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

async function proxyRemoteMedia(req: Request, res: Response, url: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(url, { headers });
  if (!upstream.ok || !upstream.body) return false;

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  if (contentRange) res.setHeader("Content-Range", contentRange);
  res.status(upstream.status === 206 ? 206 : 200);

  const { Readable } = await import("stream");
  Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
  return true;
}

export function archiveMediaStreamUrl(assetId: number): string {
  return `/api/admin/archive/media/${assetId}`;
}

/** User-facing stream URL for the video editor (authenticated users). */
export function editorArchiveMediaUrl(assetId: number): string {
  return `/api/editor/archive/media/${assetId}`;
}

async function streamArchiveAsset(req: Request, res: Response, assetId: number): Promise<void> {
  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const contentType =
    asset.mimeType || (asset.mediaType === "video" ? "video/mp4" : "image/jpeg");

  const localPath = resolveArchiveAssetPath(asset);
  if (localPath) {
    streamLocalFileWithRange(req, res, localPath, contentType);
    return;
  }

  if (asset.storageUrl.startsWith("/manus-storage/")) {
    const key = asset.storageUrl.replace(/^\/manus-storage\//, "");
    try {
      const signedUrl = await storageGetSignedUrl(key);
      const ok = await proxyRemoteMedia(req, res, signedUrl);
      if (ok) return;
    } catch (err) {
      console.warn("[ArchiveMedia] manus-storage proxy failed:", (err as Error).message);
    }
  } else if (asset.storageUrl.startsWith("http")) {
    const ok = await proxyRemoteMedia(req, res, asset.storageUrl);
    if (ok) return;
  }

  res.status(404).json({ error: "Media file not found on disk" });
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
