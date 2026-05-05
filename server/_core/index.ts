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

  // ─── Health Check ─────────────────────────────────────────────────────────
  app.get("/api/health", async (_req, res) => {
    const checks: Record<string, { ok: boolean; message?: string }> = {};

    // DB check
    try {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (db) {
        await db.execute("SELECT 1");
        checks.db = { ok: true };
      } else {
        checks.db = { ok: false, message: "DB not initialized" };
      }
    } catch (e) {
      checks.db = { ok: false, message: String(e) };
    }

    // Fish Audio check
    const fishKey = process.env.FISH_AUDIO_API_KEY;
    if (fishKey) {
      try {
        const r = await fetch("https://api.fish.audio/model?page_size=1", {
          headers: { Authorization: `Bearer ${fishKey}` },
          signal: AbortSignal.timeout(5000),
        });
        checks.fishAudio = { ok: r.ok, message: r.ok ? undefined : `HTTP ${r.status}` };
      } catch (e) {
        checks.fishAudio = { ok: false, message: String(e) };
      }
    } else {
      checks.fishAudio = { ok: false, message: "FISH_AUDIO_API_KEY not set" };
    }

    // Pexels check
    const pexelsKey = process.env.PEXELS_API_KEY;
    if (pexelsKey) {
      try {
        const r = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", {
          headers: { Authorization: pexelsKey },
          signal: AbortSignal.timeout(5000),
        });
        checks.pexels = { ok: r.ok, message: r.ok ? undefined : `HTTP ${r.status}` };
      } catch (e) {
        checks.pexels = { ok: false, message: String(e) };
      }
    } else {
      checks.pexels = { ok: false, message: "PEXELS_API_KEY not set" };
    }

    // Always return HTTP 200 — the server is healthy if it's running.
    // Missing API keys are informational only and do not mean the server is down.
    const allOk = Object.values(checks).every(c => c.ok);
    res.status(200).json({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
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
  const fishKey = process.env.FISH_AUDIO_API_KEY;
  const forgeKey = process.env.BUILT_IN_FORGE_API_KEY;
  if (!fishKey || !forgeKey) {
    console.log("[VoiceBootstrap] Skipping — FISH_AUDIO_API_KEY or BUILT_IN_FORGE_API_KEY not set");
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
    console.log(`[VoiceBootstrap] Generating example audio for ${missing.length} voice(s)...`);
    const previewText = "Hello! This is a preview of how this voice sounds. I hope you enjoy using it for your YouTube videos.";
    for (const voice of missing) {
      try {
        const resp = await fetch("https://api.fish.audio/v1/tts", {
          method: "POST",
          headers: { "Authorization": `Bearer ${fishKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: previewText, reference_id: voice.fishAudioReferenceId, format: "mp3", mp3_bitrate: 128, latency: "normal" }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!resp.ok) {
          console.warn(`[VoiceBootstrap] Fish Audio failed for voice ${voice.name} (${voice.fishAudioReferenceId}): HTTP ${resp.status}`);
          continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const { url } = await storagePut(`voice-examples/${voice.fishAudioReferenceId}.mp3`, buf, "audio/mpeg");
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
