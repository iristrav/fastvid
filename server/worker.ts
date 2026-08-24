import "dotenv/config";
import http from "http";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { shouldRunQueueWorker } from "@shared/videoQueue";
import { recoverAllStuckVideos } from "./db";
import { logLlmStartupDiagnostics, assertProductionLlmReady } from "./llmStartupDiagnostics";
import { startVideoQueueWorker, stopVideoQueueWorker } from "./queue";
import { applyCalibrationGuard } from "./calibrationGuard";
import { workerLocalActiveJobs } from "./videoQueue";

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

// On redeploy/restart, Railway (and `docker stop`) send SIGTERM before SIGKILL. With no
// handler, Node terminates immediately mid-poll-tick, which can pick up a brand-new job just
// before the kill lands — that job's row then sits in a "generating_*" status until the next
// process's recoverAllStuckVideos() sweep or the periodic stuck-video check reclassifies it
// (up to STUCK_VIDEO_MINUTES). Stopping the poll loop immediately on signal — same primitive
// already used to pause the worker — closes that window.
//
// This used to call process.exit(0) immediately after stopping the poll loop, which — despite
// this comment's original claim of "not trying to force-kill whatever render is already
// mid-flight" — did exactly that: exiting the process kills every in-flight render just as hard
// as a force-kill would, abandoning it mid-ffmpeg-call with no chance to finish or write its
// final status. Redeploys are routine (every push to main), so this fired on essentially every
// deploy for whichever render happened to be active at that moment. Give any in-flight render a
// bounded grace window to finish before exiting — most renders are much shorter than this, and
// one that's already 95% done shouldn't be thrown away just because a deploy landed.
const SHUTDOWN_DRAIN_MS = Math.max(0, parseInt(process.env.WORKER_SHUTDOWN_DRAIN_MS ?? "25000", 10) || 25000);
let shuttingDown = false;
function handleShutdownSignal(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Worker] ${signal} received — no longer picking up new jobs`);
  stopVideoQueueWorker();
  const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
  const tryExit = () => {
    const active = workerLocalActiveJobs();
    if (active === 0) {
      console.log("[Worker] No active jobs — exiting");
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log(`[Worker] Drain window (${SHUTDOWN_DRAIN_MS}ms) elapsed with ${active} job(s) still active — exiting anyway`);
      process.exit(0);
    }
    setTimeout(tryExit, 1000).unref?.();
  };
  tryExit();
}
process.on("SIGTERM", handleShutdownSignal);
process.on("SIGINT", handleShutdownSignal);

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.log("[Worker] DATABASE_URL not set, skipping migrations");
    return;
  }
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) {
    throw new Error("[Worker] DB not available — cannot run migrations");
  }
  const isDist = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist");
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "dist", "drizzle"),
    isDist ? path.resolve(__dirname, "../drizzle") : path.resolve(__dirname, "../drizzle"),
  ];
  const migrationsFolder = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
  if (!migrationsFolder) {
    throw new Error("[Worker] drizzle folder not found — cannot apply migrations");
  }
  console.log("[Worker] Running migrations from:", migrationsFolder);
  const { runMigrationsWithGuard } = await import("./migrationGuard");
  // Guard handles all error logging internally; re-throw triggers process.exit(1) via uncaughtException.
  await runMigrationsWithGuard(
    db as Parameters<typeof migrate>[0],
    migrationsFolder,
    (guardDb, config) => migrate(guardDb as Parameters<typeof migrate>[0], config)
  );
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
    if (req.method === "GET" && path === "/api/health/r2") {
      void (async () => {
        const endpoint = process.env.S3_ENDPOINT?.trim();
        if (!endpoint) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "no_endpoint", message: "S3_ENDPOINT not set" }));
          return;
        }
        const attempts: Array<{ ok: boolean; ms: number; error?: string }> = [];
        for (let i = 0; i < 5; i++) {
          const started = Date.now();
          try {
            await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
            attempts.push({ ok: true, ms: Date.now() - started });
          } catch (err) {
            attempts.push({ ok: false, ms: Date.now() - started, error: (err as Error).message?.slice(0, 200) });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "done", endpoint, attempts }, null, 2));
      })().catch((err) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: (err as Error).message }));
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

  // RONDE 43: database isolation for a calibration worker.
  //
  // Placed here, at the very top of main(), rather than immediately before runMigrations() —
  // recordWorkerHeartbeat() below already writes to the database, so a guard sitting next to
  // the migration call would fire one write too late. Everything after this line resolves its
  // connection from process.env.DATABASE_URL (getDb() reads it lazily on first use), so pinning
  // it here pins the whole process.
  //
  // In production (CALIBRATION_MODE unset) this is a single string comparison that returns
  // immediately and changes nothing.
  try {
    applyCalibrationGuard();
  } catch (err) {
    console.error(`[CalibrationGuard] ${(err as Error).message}`);
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
  await recoverAllStuckVideos(() => { /* nudge happens after startVideoQueueWorker below */ });
  // A render killed from outside the process (redeploy, OOM, crash) never reaches its own
  // finally-block cleanup, leaving its downloaded archive/Wikimedia files behind in /var/tmp.
  // Sweep on boot (this is exactly when a prior process's abandoned renders would be found) and
  // every hour thereafter for any that accumulate mid-lifetime from the same failure modes.
  const { sweepStaleWorkDirs } = await import("./videoPipeline");
  await sweepStaleWorkDirs().catch((e) => console.warn("[Worker] sweepStaleWorkDirs (boot) failed:", (e as Error).message));
  setInterval(() => {
    sweepStaleWorkDirs().catch((e) => console.warn("[Worker] sweepStaleWorkDirs failed:", (e as Error).message));
  }, 60 * 60_000);
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

  // ── 5s heartbeat: logs every function the pipeline is currently blocking in ──
  // getWorkerHeartbeat() now tracks one entry per concurrent call (keyed by its own label) and
  // reports each one's own elapsed time directly, so a hang is visible as one specific entry
  // whose elapsed time keeps climbing — it no longer gets masked or falsely implied by whatever
  // single label happened to be set most recently across every concurrent scene/beat.
  setInterval(async () => {
    const { getWorkerHeartbeat } = await import("./videoPipeline");
    const label = getWorkerHeartbeat();
    if (label !== "idle") {
      console.log(`[WorkerHeartbeat] ${label}`);
    }
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
