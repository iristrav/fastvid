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

async function startServer() {
  // ─── Startup diagnostics (visible in Railway logs) ─────────────────────────
  console.log("[Fastvid] Starting server...");
  console.log("[Fastvid] NODE_ENV:", process.env.NODE_ENV);
  console.log("[Fastvid] PORT:", process.env.PORT || "3000 (default)");
  console.log("[Fastvid] DATABASE_URL:", process.env.DATABASE_URL ? "✓ set" : "✗ NOT SET — database features disabled");
  console.log("[Fastvid] JWT_SECRET:", process.env.JWT_SECRET ? "✓ set" : "✗ NOT SET — auth will not work");
  console.log("[Fastvid] FISH_AUDIO_API_KEY:", process.env.FISH_AUDIO_API_KEY ? "✓ set" : "✗ NOT SET — voiceover disabled");
  console.log("[Fastvid] STABILITY_AI_API_KEY:", process.env.STABILITY_AI_API_KEY ? "✓ set" : "✗ NOT SET — AI images disabled");
  console.log("[Fastvid] PEXELS_API_KEY:", process.env.PEXELS_API_KEY ? "✓ set" : "✗ NOT SET — stock footage disabled");
  console.log("[Fastvid] BUILT_IN_FORGE_API_KEY:", process.env.BUILT_IN_FORGE_API_KEY ? "✓ set" : "✗ NOT SET — file storage disabled");
  // ───────────────────────────────────────────────────────────────────────────

  const app = express();
  const server = createServer(app);

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
