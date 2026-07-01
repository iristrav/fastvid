import "dotenv/config";
import http from "http";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { shouldRunQueueWorker } from "@shared/videoQueue";
import { recoverAllStuckVideos } from "./db";
import { logLlmStartupDiagnostics, assertProductionLlmReady } from "./llmStartupDiagnostics";
import { startVideoQueueWorker } from "./videoQueue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors server/_core/index.ts: an uncaughtException means Node's internal state is no
// longer guaranteed consistent, so exit and let Railway's restartPolicy (ON_FAILURE) restart
// us. An unhandledRejection (e.g. one stray ETIMEDOUT from an S3 fetch) is just one abandoned
// promise chain — log and keep the worker alive so it doesn't drop every in-flight render.
process.on("uncaughtException", (err) => {
  console.error("[Worker] Uncaught exception — exiting so Railway restarts the process:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Worker] Unhandled rejection (worker kept alive):", reason);
});

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.log("[Worker] DATABASE_URL not set, skipping migrations");
    return;
  }
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) {
      console.warn("[Worker] DB not available, skipping migrations");
      return;
    }
    const isDist = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist");
    const candidates = [
      path.join(process.cwd(), "drizzle"),
      path.join(process.cwd(), "dist", "drizzle"),
      isDist ? path.resolve(__dirname, "../drizzle") : path.resolve(__dirname, "../drizzle"),
    ];
    const migrationsFolder = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
    if (!migrationsFolder) {
      console.warn("[Worker] drizzle folder not found, skipping migrations");
      return;
    }
    console.log("[Worker] Running migrations from:", migrationsFolder);
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
    console.log("[Worker] Migrations applied");
  } catch (e) {
    console.error("[Worker] Migration failed:", e);
  }
}

/** Minimal HTTP probe for Railway deploy healthchecks (worker has no full web app). */
function startWorkerHealthServer(): void {
  const port = parseInt(process.env.PORT || "3000", 10);
  const server = http.createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && path === "/api/health") {
      void (async () => {
        const { getLocalVisionStatus } = await import("./localClipVision");
        const clip = getLocalVisionStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            role: "worker",
            timestamp: new Date().toISOString(),
            gitCommit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
            clipReady: clip.pipelineReady,
            clipHint: clip.hint,
          })
        );
      })().catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", role: "worker" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[Worker] Health probe on :${port}/api/health (Railway deploy check)`);
  });
}

async function main() {
  if (!shouldRunQueueWorker({ ...process.env, WORKER_MODE: "true" })) {
    console.error("[Worker] WORKER_MODE must be true");
    process.exit(1);
  }

  startWorkerHealthServer();

  console.log("[Worker] Fastvid video queue worker starting...");
  logLlmStartupDiagnostics("worker");
  assertProductionLlmReady();
  const { recordWorkerHeartbeat } = await import("./workerHeartbeat");
  await recordWorkerHeartbeat("worker").catch((e) =>
    console.warn("[Worker] Heartbeat failed:", (e as Error).message)
  );
  setInterval(async () => {
    const { getLocalVisionStatus } = await import("./localClipVision");
    const clipStatus = getLocalVisionStatus();
    await recordWorkerHeartbeat("worker", {
      clipReady: clipStatus.pipelineReady,
      clipHint: clipStatus.hint,
    }).catch(() => {});
  }, 60_000);
  const { getStorageBackend } = await import("./storageBackend");
  console.log("[Worker] Object storage:", getStorageBackend());
  await runMigrations();
  await recoverAllStuckVideos();
  const { warmUpLocalClipVision, clipPreloadEnabled, getLocalVisionStatus, clipModelCacheDir } =
    await import("./localClipVision");
  let clipReady = false;
  if (clipPreloadEnabled()) {
    console.log(`[Worker] Pre-loading CLIP model (cache: ${clipModelCacheDir()})...`);
    clipReady = await warmUpLocalClipVision().catch((err) => {
      console.warn("[Worker] CLIP warm-up failed (non-fatal):", (err as Error).message);
      return false;
    });
  }
  const clipStatus = getLocalVisionStatus();
  await recordWorkerHeartbeat("worker", {
    clipReady,
    clipHint: clipStatus.hint,
  }).catch((e) => console.warn("[Worker] Heartbeat (post-CLIP) failed:", (e as Error).message));
  startVideoQueueWorker();
  const { scheduleClipEmbeddingBackfill } = await import("./archiveClipIndexBackfill");
  scheduleClipEmbeddingBackfill();
  const { startClipBackgroundAuditor } = await import("./clipBackgroundAuditor");
  startClipBackgroundAuditor();

  // ── 5s heartbeat: logs which function the pipeline is currently blocking in ──
  // Diagnoses hangs: if label stays the same for many ticks, that's the hang site.
  let _lastHeartbeatLabel = "";
  let _heartbeatSameCount = 0;
  setInterval(async () => {
    const { getWorkerHeartbeat } = await import("./videoPipeline");
    const label = getWorkerHeartbeat();
    if (label !== "idle") {
      if (label === _lastHeartbeatLabel) {
        _heartbeatSameCount++;
        console.log(`[WorkerHeartbeat] ${label} (still running, ${_heartbeatSameCount * 5}s)`);
      } else {
        _heartbeatSameCount = 0;
        console.log(`[WorkerHeartbeat] ${label}`);
      }
    } else {
      _heartbeatSameCount = 0;
    }
    _lastHeartbeatLabel = label;
  }, 5_000);

  setInterval(() => {
    import("./db")
      .then(({ failAllStalledPipelines }) => failAllStalledPipelines())
      .then(({ failed, requeued }) => {
        if (failed > 0) console.log(`[Worker] Marked ${failed} stalled video(s) as failed`);
        if (requeued > 0) console.log(`[Worker] Re-queued ${requeued} stalled video(s)`);
      })
      .catch((e) => console.error("[Worker] Stall check failed:", e));
  }, 90_000);
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
