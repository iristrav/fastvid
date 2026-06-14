import type { Express } from "express";
import { existsSync } from "fs";
import path from "path";
import { getStorageBackend } from "./storageBackend";
import { storageGetSignedUrl } from "../storage";
import { LOCAL_UPLOADS_DIR } from "../storageLocal";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    if (getStorageBackend() === "local") {
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
      const signedUrl = await storageGetSignedUrl(key);
      if (signedUrl.startsWith("/")) {
        res.redirect(307, signedUrl);
        return;
      }

      const isMedia = /\.(mp4|webm|ogg|mp3|wav|m4a|mov)$/i.test(key);

      if (isMedia) {
        const rangeHeader = req.headers["range"];
        const upstreamHeaders: Record<string, string> = {};
        if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

        const upstream = await fetch(signedUrl, { headers: upstreamHeaders });

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

        res.status(upstream.status === 206 ? 206 : 200);

        if (!upstream.body) {
          res.status(502).send("Empty upstream body");
          return;
        }

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
        res.set("Cache-Control", "public, max-age=3600");
        res.redirect(307, signedUrl);
      }
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      const safeKey = key.replace(/\//g, "_");
      const localPath = path.join(LOCAL_UPLOADS_DIR, safeKey);
      if (existsSync(localPath)) {
        res.redirect(307, `/local-storage/${safeKey}`);
        return;
      }
      if (!res.headersSent) res.status(502).send("Storage proxy error");
    }
  });
}
