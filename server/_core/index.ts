import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerStripeWebhook } from "../stripeWebhook";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
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
        // Fish Audio: check if the API key is valid by listing models (GET /model)
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

    const allOk = Object.values(checks).every(c => c.ok);
    res.status(allOk ? 200 : 503).json({
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

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
