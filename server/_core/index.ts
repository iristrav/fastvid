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
import { fileURLToPath } from "url";

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
    // Migrations folder is relative to the compiled output location
    // In production: __dirname = /app/dist, drizzle folder = /app/drizzle → go up 1 level
    // In development: __dirname = /home/.../server/_core, drizzle folder = /home/.../drizzle → go up 2 levels
    const isDist = __dirname.endsWith('/dist') || __dirname.endsWith('\\dist');
    const migrationsFolder = isDist
      ? path.resolve(__dirname, "../drizzle")
      : path.resolve(__dirname, "../../drizzle");
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
  console.log("[Fastvid] STABILITY_AI_API_KEY:", process.env.STABILITY_AI_API_KEY ? "✓ set" : "✗ NOT SET — AI images disabled");
  console.log("[Fastvid] PEXELS_API_KEY:", process.env.PEXELS_API_KEY ? "✓ set" : "✗ NOT SET — stock footage disabled");
  console.log("[Fastvid] BUILT_IN_FORGE_API_KEY:", process.env.BUILT_IN_FORGE_API_KEY ? "✓ set" : "✗ NOT SET — file storage disabled");
  // ─────────────────────────────────────────────────────────────────────────

  const app = express();
  const server = createServer(app);

  // Trust Railway's proxy so req.protocol === 'https' and secure cookies work correctly
  app.set('trust proxy', 1);

  // Configure body parser with larger size limit for file uploads
  // Register Stripe webhook BEFORE express.json() for raw body access
  registerStripeWebhook(app);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
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
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: {
        BUILT_IN_FORGE_API_KEY: !!process.env.BUILT_IN_FORGE_API_KEY,
        LLM_API_KEY: !!process.env.LLM_API_KEY,
        FISH_AUDIO_API_KEY: !!process.env.FISH_AUDIO_API_KEY,
        PEXELS_API_KEY: !!process.env.PEXELS_API_KEY,
        STABILITY_AI_API_KEY: !!process.env.STABILITY_AI_API_KEY,
        NODE_ENV: process.env.NODE_ENV,
      },
    });
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

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Railway injects PORT automatically — always use it directly
  const port = parseInt(process.env.PORT || "3000", 10);

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
// On startup, mark any videos stuck in processing states as failed.
// This handles the case where the server was restarted while a pipeline was running.
async function recoverStuckPipelines() {
  try {
    const { getDb } = await import("../db");
    const { videos } = await import("../../drizzle/schema");
    const { inArray } = await import("drizzle-orm"); // eslint-disable-line @typescript-eslint/no-unused-vars
    const db = await getDb();
    if (!db) return;
    const result = await db.update(videos)
      .set({
        status: 'failed',
        errorMessage: 'Server restarted during generation. Please try again.',
        progressStep: 'Failed — server restarted, please retry',
      })
      .where(inArray(videos.status, ['generating_script', 'generating_voiceover', 'generating_visuals', 'generating_effects'] as ('generating_script' | 'generating_voiceover' | 'generating_visuals' | 'generating_effects')[]));
    const count = (result as unknown as [{ affectedRows?: number }])?.[0]?.affectedRows ?? 0;
    if (count > 0) {
      console.log(`[PipelineRecovery] Marked ${count} stuck video(s) as failed`);
    }
  } catch (e) {
    console.error("[PipelineRecovery] Recovery failed:", e);
  }
}

recoverStuckPipelines().catch(console.error);
