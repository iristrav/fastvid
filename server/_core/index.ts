import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerStripeWebhook } from "../stripeWebhook";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { LOCAL_UPLOADS_DIR } from "../storageLocal";
import { registerArchiveUploadRoute } from "../archiveUpload";
import { registerArchiveMediaRoute } from "../archiveMediaStream";
import { archiveUploadRequestTimeoutMs } from "../archiveVideoSplitter";
import { registerCanonicalAppUrl } from "./appUrl";
import {
  curatedArchiveOnlyVisuals,
  externalVisualSourcingEnabled,
  elevenLabsOnlyVoice,
} from "../sourcingPolicy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Auto-Migration ───────────────────────────────────────────────────────────
// Runs all pending SQL migrations on startup so Railway DB is always up to date.
async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.log("[Migration] DATABASE_URL not set, skipping migrations");
    return;
  }
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) { console.warn("[Migration] DB not available, skipping migrations"); return; }
    const isDist = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist");
    const candidates = [
      path.join(process.cwd(), "drizzle"),
      path.join(process.cwd(), "dist", "drizzle"),
      isDist ? path.resolve(__dirname, "../drizzle") : path.resolve(__dirname, "../../drizzle"),
    ];
    const migrationsFolder = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
    if (!migrationsFolder) {
      console.warn("[Migration] drizzle folder not found, skipping migrations");
      return;
    }
    console.log("[Migration] Running migrations from:", migrationsFolder);
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
    console.log("[Migration] All migrations applied successfully");
  } catch (e) {
    console.error("[Migration] Migration failed (server will still start):", e);
  }
}

async function startServer() {
  // ─── Run DB migrations first ──────────────────────────────────────────────
  await runMigrations();

  // ─── Startup diagnostics (visible in Railway logs) ───────────────────────
  console.log("[Fastvid] Starting server...");
  console.log("[Fastvid] NODE_ENV:", process.env.NODE_ENV);
  console.log("[Fastvid] PORT:", process.env.PORT || "3000 (default)");
  console.log("[Fastvid] DATABASE_URL:", process.env.DATABASE_URL ? "✓ set" : "✗ NOT SET — database features disabled");
  console.log("[Fastvid] JWT_SECRET:", process.env.JWT_SECRET ? "✓ set" : "✗ NOT SET — auth will not work");
  console.log("[Fastvid] FISH_AUDIO_API_KEY:", process.env.FISH_AUDIO_API_KEY ? "✓ set" : "✗ NOT SET — voiceover disabled");
  console.log("[Fastvid] STABILITY_AI_API_KEY:", process.env.STABILITY_AI_API_KEY ? "✓ set" : "✗ NOT SET");
  console.log("[Fastvid] LEONARDO_API_KEY:", process.env.LEONARDO_API_KEY ? "✓ set" : "✗ NOT SET");
  console.log("[Fastvid] REPLICATE_API_KEY:", process.env.REPLICATE_API_KEY ? "✓ set" : "✗ NOT SET — Grok video");
  console.log("[Fastvid] RUNWAY_API_KEY:", process.env.RUNWAY_API_KEY ? "✓ set" : "✗ NOT SET");
  const cheapAi =
    process.env.ENABLE_AI_FALLBACK !== "false" &&
    !!(process.env.STABILITY_AI_API_KEY || process.env.LEONARDO_API_KEY);
  const premiumVideo = process.env.ENABLE_AI_VIDEO_FALLBACK === "true";
  console.log(
    "[Fastvid] AI fallback (cheap image, ~$0.03/beat):",
    cheapAi ? "✓ Stability/Leonardo" : "✗ set STABILITY_AI_API_KEY (recommended)"
  );
  console.log(
    "[Fastvid] AI video fallback (Runway/Grok, expensive):",
    premiumVideo ? "✓ enabled" : "✗ off (default — saves cost)"
  );
  const maxStock = process.env.MAX_STOCK_BEATS_PER_VIDEO?.trim();
  console.log(
    "[Fastvid] Minimize licensed stock:",
    process.env.MINIMIZE_STOCK_FOOTAGE !== "false"
      ? `✓ on (real footage → AI; ≤${maxStock || "1 short / 2 long"} Pexels/Pixabay per video)`
      : "✗ off (MINIMIZE_STOCK_FOOTAGE=false)"
  );
  console.log("[Fastvid] PEXELS_API_KEY:", process.env.PEXELS_API_KEY ? "✓ set" : "✗ NOT SET — stock footage disabled");
  console.log("[Fastvid] BUILT_IN_FORGE_API_KEY:", process.env.BUILT_IN_FORGE_API_KEY ? "✓ set" : "✗ NOT SET — file storage disabled");
  const ytSearch = !!process.env.YOUTUBE_API_KEY?.trim();
  const ytDownload = !!(process.env.RAPIDAPI_KEY?.trim() || process.env.YOUTUBE_CC_DL_SERVICE?.trim());
  console.log("[Fastvid] RAPIDAPI_KEY:", ytDownload ? "✓ set" : "✗ NOT SET — YouTube CC download disabled");
  console.log("[Fastvid] YOUTUBE_API_KEY:", ytSearch ? "✓ set" : "✗ NOT SET — YouTube CC search disabled");
  console.log("[Fastvid] YouTube clip sourcing: disabled");
  console.log(
    "[Fastvid] Visual sourcing:",
    curatedArchiveOnlyVisuals()
      ? "✓ media archive only (no external clip APIs)"
      : "✗ external sources enabled"
  );
  if (externalVisualSourcingEnabled()) {
    console.warn("[Fastvid] External visual sourcing should be off — check sourcingPolicy");
  }
  console.log(
    "[Fastvid] Voiceover:",
    elevenLabsOnlyVoice()
      ? "✓ ElevenLabs only"
      : "✗ Fish Audio fallback allowed (ELEVENLABS_ONLY=false)"
  );
  console.log(
    "[Fastvid] Video pipeline:",
    "single-pass compose (beelden + voice + jaartallen) — geen apart edit/effecten-stadium"
  );
  console.log("[Fastvid] SERPAPI_KEY:", process.env.SERPAPI_KEY ? "✓ set" : "✗ NOT SET — celebrity image search disabled");
  console.log("[Fastvid] UNSPLASH_ACCESS_KEY:", process.env.UNSPLASH_ACCESS_KEY?.trim() ? "✓ set" : "✗ NOT SET — Unsplash image search disabled");
  // ─────────────────────────────────────────────────────────────────────────

  const app = express();
  const server = createServer(app);

  // Trust Railway's proxy so req.protocol === 'https' and secure cookies work correctly
  app.set('trust proxy', 1);

  registerCanonicalAppUrl(app);

  // Configure body parser with larger size limit for file uploads
  // Register Stripe webhook BEFORE express.json() for raw body access
  registerStripeWebhook(app);
  // Binary archive upload (raw file bytes — avoids base64 JSON and HTML 413 errors)
  registerArchiveUploadRoute(app);
  registerArchiveMediaRoute(app);
  // Base64 uploads need ~33% headroom; archive videos up to 100MB raw.
  app.use(express.json({ limit: "150mb" }));
  app.use(express.urlencoded({ limit: "150mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // ─── Local Storage Serving (Railway fallback) ─────────────────────────────
  // When BUILT_IN_FORGE_API_KEY is not set, files are stored locally.
  // Serve them at /local-storage/* so the frontend can access them.
  if (!process.env.BUILT_IN_FORGE_API_KEY) {
    const { LOCAL_UPLOADS_DIR } = await import("../storageLocal");
    const expressStatic = (await import("express")).static;
    app.use("/local-storage", expressStatic(LOCAL_UPLOADS_DIR, {
      maxAge: "1d",
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
      },
    }));
    console.log(`[Fastvid] Local storage serving enabled at /local-storage → ${LOCAL_UPLOADS_DIR}`);
  }

  // ─── FFmpeg Debug Endpoint ────────────────────────────────────────────────────
  app.get("/api/debug/ffmpeg", async (_req, res) => {
    const { execSync: es } = await import("child_process");
    const { existsSync } = await import("fs");
    const tryCmd = (cmd: string) => { try { return es(cmd, { encoding: "utf8" }).trim(); } catch { return "(failed)"; } };
    res.json({
      which: tryCmd("which ffmpeg"),
      usrBin: existsSync("/usr/bin/ffmpeg"),
      usrLocalBin: existsSync("/usr/local/bin/ffmpeg"),
      nixProfile: existsSync("/nix/var/nix/profiles/default/bin/ffmpeg"),
      findNix: tryCmd("find /nix -name ffmpeg -type f 2>/dev/null | head -3"),
      findUsr: tryCmd("find /usr -name ffmpeg -type f 2>/dev/null | head -3"),
      lsNixStore: tryCmd("ls /nix/store/ 2>/dev/null | grep ffmpeg | head -3"),
      path: process.env.PATH,
      nixpacks: tryCmd("cat /etc/nix/nix.conf 2>/dev/null | head -5"),
    });
  });

  // ─── Health Check ─────────────────────────────────────────────────────────
  // IMPORTANT: This endpoint must respond immediately (no external API calls).
  // Railway uses it as a liveness probe with a strict timeout.
  app.get("/api/health", (_req, res) => {
    const storage =
      !process.env.BUILT_IN_FORGE_API_KEY
        ? (() => {
            const persistent =
              LOCAL_UPLOADS_DIR.startsWith("/data/") ||
              !!process.env.UPLOADS_DIR?.startsWith("/data") ||
              !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
            return {
              uploadsDir: LOCAL_UPLOADS_DIR,
              persistent,
              ...(!persistent
                ? {
                    warning:
                      "Videos are stored on ephemeral disk and disappear after redeploy. Attach a Railway Volume at /data and set UPLOADS_DIR=/data/uploads.",
                  }
                : {}),
            };
          })()
        : undefined;
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      appUrl: (await import("./appUrl")).getConfiguredAppUrl(),
      env: {
        BUILT_IN_FORGE_API_KEY: !!process.env.BUILT_IN_FORGE_API_KEY,
        LLM_API_KEY: !!process.env.LLM_API_KEY,
        FISH_AUDIO_API_KEY: !!process.env.FISH_AUDIO_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        voiceReady: !!(
          process.env.ELEVENLABS_API_KEY?.trim() ||
          process.env.FISH_AUDIO_API_KEY?.trim()
        ),
        curatedArchiveOnly: curatedArchiveOnlyVisuals(),
        externalVisualSourcingEnabled: externalVisualSourcingEnabled(),
        // Legacy keys below — configured but unused while archive-only visuals are enforced
        PEXELS_API_KEY: !!process.env.PEXELS_API_KEY,
        PIXABAY_API_KEY: !!process.env.PIXABAY_API_KEY,
        YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY,
        RAPIDAPI_KEY: !!process.env.RAPIDAPI_KEY,
        SERPAPI_KEY: !!process.env.SERPAPI_KEY,
        UNSPLASH_ACCESS_KEY: !!process.env.UNSPLASH_ACCESS_KEY?.trim(),
        youtubeSourcingEnabled: false,
        stockFootageReady: false,
        serpApiReady: false,
        unsplashReady: false,
        NODE_ENV: process.env.NODE_ENV,
      },
      storage,
    });
  });

  app.get("/api/health/youtube-probe", async (_req, res) => {
    try {
      const { probeYouTubeCcPipeline } = await import("../videoPipeline");
      const probe = await probeYouTubeCcPipeline();
      const ok =
        probe.ready &&
        probe.searchStatus === 200 &&
        probe.ccResultCount > 0 &&
        probe.rapidApiStatus === 200 &&
        probe.rapidApiHasFormat;
      res.status(ok ? 200 : 503).json({ ok, ...probe });
    } catch (err) {
      res.status(500).json({ ok: false, message: String(err) });
    }
  });

  app.get("/api/health/stability-probe", async (_req, res) => {
    try {
      const { probeStabilityAI } = await import("../videoPipeline");
      const probe = await probeStabilityAI();
      const ok =
        probe.ready &&
        probe.httpStatus === 200 &&
        probe.imageBytes > 50_000;
      res.status(ok ? 200 : 503).json({ ok, ...probe });
    } catch (err) {
      res.status(500).json({ ok: false, message: String(err) });
    }
  });

  // ─── Video Download Endpoint ─────────────────────────────────────────────
  // Streams the video file through the server so the browser can download it.
  // This avoids CORS issues with presigned S3 URLs that block the download attribute.
  app.get("/api/download/video/:id", async (req, res) => {
    try {
      // Verify auth via JWT cookie (same logic as createContext)
      const { parse: parseCookies } = await import("cookie");
      const { jwtVerify } = await import("jose");
      const { COOKIE_NAME } = await import("@shared/const");
      const { getVideoById, getUserById } = await import("../db");

      const cookies = parseCookies(req.headers.cookie ?? "");
      const token = cookies[COOKIE_NAME];
      if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

      const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "fallback-secret-change-in-production");
      let userId: number;
      try {
        const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
        userId = payload.userId as number;
        if (!userId) throw new Error("No userId in token");
      } catch {
        res.status(401).json({ error: "Invalid session" }); return;
      }

      const videoId = parseInt(req.params.id, 10);
      if (isNaN(videoId)) { res.status(400).json({ error: "Invalid video ID" }); return; }

      const video = await getVideoById(videoId);
      if (!video) { res.status(404).json({ error: "Video not found" }); return; }

      // Allow owner or admin
      const user = await getUserById(userId);
      if (video.userId !== userId && user?.role !== "admin") {
        res.status(403).json({ error: "Forbidden" }); return;
      }

      if (!video.videoUrl) { res.status(404).json({ error: "Video file not available" }); return; }

      const safeTitle = (video.title ?? `video-${videoId}`).replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
      const filename = `${safeTitle || `fastvid-VID-${String(videoId).padStart(4, "0")}`}.mp4`;

      // If it's a /manus-storage/ URL, get a presigned URL and proxy the bytes
      if (video.videoUrl.startsWith("/manus-storage/")) {
        const { storageGetSignedUrl } = await import("../storage");
        const key = video.videoUrl.replace(/^\/manus-storage\//, "");
        const signedUrl = await storageGetSignedUrl(key);
        const upstream = await fetch(signedUrl);
        if (!upstream.ok || !upstream.body) {
          res.status(502).json({ error: "Failed to fetch video from storage" }); return;
        }
        const contentLength = upstream.headers.get("content-length");
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        // Stream the response body to the client
        const { Readable } = await import("stream");
        const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
        nodeStream.pipe(res);
        return;
      }

      // If it's a /local-storage/ URL (sandbox dev), serve the local file
      if (video.videoUrl.startsWith("/local-storage/")) {
        const { LOCAL_UPLOADS_DIR } = await import("../storageLocal");
        const { createReadStream, existsSync } = await import("fs");
        const fileName = video.videoUrl.replace(/^\/local-storage\//, "");
        const filePath = `${LOCAL_UPLOADS_DIR}/${fileName}`;
        if (!existsSync(filePath)) { res.status(404).json({ error: "File not found on disk" }); return; }
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        createReadStream(filePath).pipe(res);
        return;
      }

      res.status(400).json({ error: "Unsupported video URL format" });
    } catch (err) {
      console.error("[Download] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── Video Stream Endpoint (inline playback with Range support) ───────────
  app.get("/api/stream/video/:id", async (req, res) => {
    try {
      const { parse: parseCookies } = await import("cookie");
      const { jwtVerify } = await import("jose");
      const { COOKIE_NAME } = await import("@shared/const");
      const { getVideoById, getUserById } = await import("../db");
      const { createReadStream, statSync } = await import("fs");

      const cookies = parseCookies(req.headers.cookie ?? "");
      const token = cookies[COOKIE_NAME];
      if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

      const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "fallback-secret-change-in-production");
      let userId: number;
      try {
        const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
        userId = payload.userId as number;
        if (!userId) throw new Error("No userId in token");
      } catch {
        res.status(401).json({ error: "Invalid session" }); return;
      }

      const videoId = parseInt(req.params.id, 10);
      if (isNaN(videoId)) { res.status(400).json({ error: "Invalid video ID" }); return; }

      const video = await getVideoById(videoId);
      if (!video) { res.status(404).json({ error: "Video not found" }); return; }

      const user = await getUserById(userId);
      if (video.userId !== userId && user?.role !== "admin") {
        res.status(403).json({ error: "Forbidden" }); return;
      }

      if (!video.videoUrl) { res.status(404).json({ error: "Video file not available" }); return; }

      const streamLocalFile = (filePath: string) => {
        const stat = statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "video/mp4");
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
        } else {
          res.setHeader("Content-Length", fileSize);
          createReadStream(filePath).pipe(res);
        }
      };

      if (video.videoUrl.startsWith("/local-storage/")) {
        const { resolveLocalVideoPath } = await import("../storageLocal");
        const filePath = resolveLocalVideoPath(video.videoUrl);
        if (!filePath) { res.status(404).json({ error: "File not found on disk" }); return; }
        streamLocalFile(filePath);
        return;
      }

      if (video.videoUrl.startsWith("/manus-storage/")) {
        const { storageGetSignedUrl } = await import("../storage");
        const key = video.videoUrl.replace(/^\/manus-storage\//, "");
        const signedUrl = await storageGetSignedUrl(key);
        const upstream = await fetch(signedUrl, {
          headers: req.headers.range ? { Range: req.headers.range } : {},
        });
        if (!upstream.ok || !upstream.body) {
          res.status(502).json({ error: "Failed to fetch video from storage" }); return;
        }
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (["content-type", "content-length", "content-range", "accept-ranges"].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        });
        const { Readable } = await import("stream");
        Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
        return;
      }

      res.status(400).json({ error: "Unsupported video URL format" });
    } catch (err) {
      console.error("[Stream] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── Internal Video Trigger (dev/testing only) ──────────────────────────────
  // Allows triggering video generation without OAuth authentication.
  // Protected by INTERNAL_TRIGGER_KEY env var.
  app.post("/api/internal/generate", async (req, res) => {
    const key = req.headers['x-internal-key'];
    const expectedKey = process.env.INTERNAL_TRIGGER_KEY || 'dev-trigger-key-2026';
    if (key !== expectedKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const { createVideo } = await import('../db');
      const { prompt, videoLength = '8-10', videoType = 'documentary', userId = 1 } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }
      const videoId = await createVideo({ userId, prompt, videoLength, videoType });
      // Import and call generateFullVideo dynamically to avoid circular deps
      const { generateFullVideoInternal } = await import('../routers');
      generateFullVideoInternal(videoId, prompt, videoLength, videoType, undefined, undefined, false).catch(console.error);
      res.json({ videoId, status: 'started' });
    } catch (err) {
      console.error('[Internal Trigger] Error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/internal/video/:id", async (req, res) => {
    const key = req.headers['x-internal-key'];
    const expectedKey = process.env.INTERNAL_TRIGGER_KEY || 'dev-trigger-key-2026';
    if (key !== expectedKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const { getVideoById } = await import('../db');
      const videoId = parseInt(req.params.id, 10);
      if (isNaN(videoId)) { res.status(400).json({ error: 'Invalid video ID' }); return; }
      const video = await getVideoById(videoId);
      if (!video) { res.status(404).json({ error: 'Video not found' }); return; }

      let fileProbe: { exists: boolean; sizeBytes?: number; durationSec?: number; path?: string } = { exists: false };
      if (video.videoUrl?.startsWith("/local-storage/")) {
        const { LOCAL_UPLOADS_DIR } = await import("../storageLocal");
        const fs = await import("fs");
        const fileName = video.videoUrl.replace(/^\/local-storage\//, "");
        const filePath = `${LOCAL_UPLOADS_DIR}/${fileName}`;
        if (fs.existsSync(filePath)) {
          const sizeBytes = fs.statSync(filePath).size;
          let durationSec: number | undefined;
          try {
            const { execFile } = await import("child_process");
            const { promisify } = await import("util");
            const execFileAsync = promisify(execFile);
            const probes = ["ffprobe", "/usr/bin/ffprobe", "/usr/local/bin/ffprobe"];
            for (const probe of probes) {
              try {
                const { stdout } = await execFileAsync(probe, [
                  "-v", "error", "-show_entries", "format=duration",
                  "-of", "default=noprint_wrappers=1:nokey=1", filePath,
                ]);
                const parsed = parseFloat(stdout.trim());
                if (!isNaN(parsed) && parsed > 0) { durationSec = Math.round(parsed * 10) / 10; break; }
              } catch { /* try next */ }
            }
          } catch { /* ignore */ }
          fileProbe = { exists: true, sizeBytes, durationSec, path: fileName };
        } else {
          fileProbe = { exists: false, path: fileName };
        }
      }

      const videoScenes = (video as { videoScenes?: unknown }).videoScenes;
      res.json({
        id: video.id,
        status: video.status,
        progressStep: video.progressStep,
        progressPercent: video.progressPercent,
        videoUrl: video.videoUrl,
        errorMessage: video.errorMessage,
        title: video.title,
        videoLength: video.videoLength,
        fileProbe,
        videoScenes: videoScenes ?? null,
      });
    } catch (err) {
      console.error('[Internal Status] Error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Always return JSON for payload-too-large (prevents "<!DOCTYPE" parse errors in the client)
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (
      err &&
      typeof err === "object" &&
      "type" in err &&
      (err as { type?: string }).type === "entity.too.large"
    ) {
      res.status(413).json({ error: "File too large (10013)" });
      return;
    }
    next(err);
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Railway injects PORT automatically — always use it directly
  const port = parseInt(process.env.PORT || "3000", 10);

  // Long archive uploads (scene split + storage) can take up to ~75 minutes for 2h sources.
  const archiveUploadTimeoutMs = Math.round(archiveUploadRequestTimeoutMs() + 120_000);
  server.timeout = Math.max(600_000, archiveUploadTimeoutMs);
  server.keepAliveTimeout = Math.round(server.timeout + 20_000);
  server.headersTimeout = Math.round(server.timeout + 25_000);

  server.listen(port, "0.0.0.0", () => {
    console.log(`[Fastvid] Server running on port ${port}`);
  });
}

startServer().catch(console.error);

// ─── Admin Bootstrap ──────────────────────────────────────────────────────────
// If ADMIN_EMAIL and ADMIN_PASSWORD are set and no admin exists yet,
// automatically create the first admin account on startup.
async function bootstrapAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return;

  try {
    const { getUserByEmail, createUser } = await import("../db");
    const existing = await getUserByEmail(adminEmail);
    if (existing) {
      // Already exists — ensure they are admin
      const { getDb } = await import("../db");
      const { users } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (db && existing.role !== "admin") {
        await db.update(users).set({ role: "admin" }).where(eq(users.id, existing.id));
        console.log("[Bootstrap] Promoted existing user to admin:", adminEmail);
      } else {
        console.log("[Bootstrap] Admin account already exists:", adminEmail);
      }
      return;
    }

    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await createUser({
      email: adminEmail,
      name: "Admin",
      passwordHash,
      loginMethod: "password",
      role: "admin",
      lastSignedIn: new Date(),
    });
    console.log("[Bootstrap] Admin account created:", adminEmail);
  } catch (e) {
    console.error("[Bootstrap] Failed to create admin account:", e);
  }
}

bootstrapAdmin().catch(console.error);

// ─── Voice Example Audio Bootstrap ───────────────────────────────────────────
// Pre-generate example audio for all voices that don't have one yet.
// Runs in the background after startup so it doesn't block the server.
async function bootstrapVoiceExampleAudio() {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) {
    console.log("[VoiceBootstrap] Skipping — ELEVENLABS_API_KEY not set");
    return;
  }
  try {
    const { getAllVoicesAdmin, updateVoice } = await import("../db");
    const { storagePut } = await import("../storage");
    const allVoices = await getAllVoicesAdmin();
    const missing = allVoices.filter(v => !v.exampleAudioUrl && !v.fishAudioReferenceId.startsWith("PLACEHOLDER"));
    if (missing.length === 0) {
      console.log("[VoiceBootstrap] All voices already have example audio");
      return;
    }
    console.log(`[VoiceBootstrap] Generating example audio for ${missing.length} voice(s) via ElevenLabs...`);
    const previewText = "Hello! This is a preview of how this voice sounds. I hope you enjoy using it for your YouTube videos.";
    for (const voice of missing) {
      try {
        // fishAudioReferenceId column stores ElevenLabs voice ID
        const elevenVoiceId = voice.fishAudioReferenceId;
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}`, {
          method: "POST",
          headers: { "xi-api-key": elevenKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
          body: JSON.stringify({ text: previewText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!resp.ok) {
          console.warn(`[VoiceBootstrap] ElevenLabs failed for voice ${voice.name} (${elevenVoiceId}): HTTP ${resp.status}`);
          continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const { url } = await storagePut(`voice-examples/${elevenVoiceId}.mp3`, buf, "audio/mpeg");
        await updateVoice(voice.id, { exampleAudioUrl: url });
        console.log(`[VoiceBootstrap] ✓ Example audio generated for voice: ${voice.name}`);
      } catch (e) {
        console.warn(`[VoiceBootstrap] Failed for voice ${voice.name}:`, e);
      }
    }
    console.log("[VoiceBootstrap] Done");
  } catch (e) {
    console.error("[VoiceBootstrap] Bootstrap failed:", e);
  }
}

bootstrapVoiceExampleAudio().catch(console.error);

// ─── Pipeline Recovery ────────────────────────────────────────────────────────
// On startup: recover videos whose MP4 was uploaded but status never finalized,
// then mark orphaned in-progress pipelines as failed (no worker survives a restart).
async function recoverStuckPipelines() {
  try {
    const { recoverAllStuckVideos } = await import("../db");
    await recoverAllStuckVideos();
  } catch (e) {
    console.error("[PipelineRecovery] Recovery failed:", e);
  }
}

recoverStuckPipelines().catch(console.error);

// Fail pipelines with no progress heartbeat (updatedAt stale) — every 90s
setInterval(() => {
  import("../db")
    .then(({ failAllStalledPipelines }) => failAllStalledPipelines())
    .then((n) => {
      if (n > 0) console.log(`[PipelineRecovery] Marked ${n} stalled video(s) as failed`);
    })
    .catch((e) => console.error("[PipelineRecovery] Stall check failed:", e));
}, 90_000);
