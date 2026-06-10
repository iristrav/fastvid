import type { Express } from "express";
import { existsSync } from "fs";
import path from "path";
import { ENV } from "./env";
import { LOCAL_UPLOADS_DIR } from "../storageLocal";

/** Resolve a storage key to a presigned GET URL from Forge */
async function getPresignedUrl(key: string): Promise<string | null> {
  if (!ENV.forgeApiUrl || !process.env.BUILT_IN_FORGE_API_KEY) return null;
  const forgeUrl = new URL(
    "v1/storage/presign/get",
    ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
  );
  forgeUrl.searchParams.set("path", key);
  const forgeResp = await fetch(forgeUrl, {
    headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
  });
  if (!forgeResp.ok) {
    const body = await forgeResp.text().catch(() => "");
    console.error(`[StorageProxy] forge presign error: ${forgeResp.status} ${body}`);
    return null;
  }
  const { url } = (await forgeResp.json()) as { url: string };
  return url || null;
}

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    if (!ENV.forgeApiUrl || !process.env.BUILT_IN_FORGE_API_KEY) {
      const safeKey = key.replace(/\//g, "_");
      const localPath = path.join(LOCAL_UPLOADS_DIR, safeKey);
      if (existsSync(localPath)) {
        res.redirect(307, `/local-storage/${safeKey}`);
        return;
      }
      res.status(404).send("Storage file not found");
      return;
    }

    try {
      const signedUrl = await getPresignedUrl(key);
      if (!signedUrl) {
        const safeKey = key.replace(/\//g, "_");
        const localPath = path.join(LOCAL_UPLOADS_DIR, safeKey);
        if (existsSync(localPath)) {
          res.redirect(307, `/local-storage/${safeKey}`);
          return;
        }
        res.status(502).send("Storage backend error");
        return;
      }

      // For video/audio files: proxy the bytes with proper streaming headers
      // so HTML5 <video> can seek and buffer correctly.
      const isMedia = /\.(mp4|webm|ogg|mp3|wav|m4a|mov)$/i.test(key);

      if (isMedia) {
        // Forward Range header from client to upstream for seek support
        const rangeHeader = req.headers["range"];
        const upstreamHeaders: Record<string, string> = {};
        if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

        const upstream = await fetch(signedUrl, { headers: upstreamHeaders });

        // Determine content type
        const contentType =
          upstream.headers.get("content-type") ||
          (key.endsWith(".mp4") ? "video/mp4" :
           key.endsWith(".webm") ? "video/webm" :
           key.endsWith(".mp3") ? "audio/mpeg" :
           "application/octet-stream");

        const contentLength = upstream.headers.get("content-length");
        const contentRange = upstream.headers.get("content-range");
        const acceptRanges = upstream.headers.get("accept-ranges") || "bytes";

        res.set("Content-Type", contentType);
        res.set("Accept-Ranges", acceptRanges);
        res.set("Cache-Control", "public, max-age=3600");
        if (contentLength) res.set("Content-Length", contentLength);
        if (contentRange) res.set("Content-Range", contentRange);

        // Use 206 Partial Content if upstream returned it
        res.status(upstream.status === 206 ? 206 : 200);

        if (!upstream.body) {
          res.status(502).send("Empty upstream body");
          return;
        }

        // Stream bytes to client
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.writableEnded) res.write(value);
          }
          if (!res.writableEnded) res.end();
        };
        pump().catch((err) => {
          console.error("[StorageProxy] stream error:", err);
          if (!res.writableEnded) res.end();
        });
      } else {
        // For non-media files (images, JSON, etc.) a redirect is fine
        res.set("Cache-Control", "public, max-age=3600");
        res.redirect(307, signedUrl);
      }
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      if (!res.headersSent) res.status(502).send("Storage proxy error");
    }
  });
}
