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
import { askYoutubeEgress } from "./youtubeEgressProbe";

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

/**
 * How long the BOOT egress probe may wait — the value this file already used, kept.
 *
 * `YOUTUBE_EGRESS_PROBE_TIMEOUT_MS` is deliberately short (3s) because at render time the probe
 * runs on a beat that has just lost its budget to a transfer that never arrived; it must answer or
 * get out of the way. Startup has no such constraint and a blocked service is exactly what we want
 * to hear about, so the boot probe keeps its own patience. Neither number is changed by this round.
 */
const WORKER_EGRESS_PROBE_TIMEOUT_MS = 25_000;
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
  /**
   * LAYER 1 — are the migration artifacts internally consistent?
   *
   * Runs BEFORE the migrator and before any schema comparison, because a count derived from a
   * broken artifact set is worse than no count: a `.sql` the journal does not name produced
   * "47/47 recorded — nothing to apply" and a crash-loop two steps later. Throws on failure, so an
   * inconsistent set never reaches the database and the app never half-starts.
   *
   * LAYER 2 is the schema validation further down, which asks the different question of whether
   * the live database matches what the code declares. Both are needed; neither replaces the other.
   */
  const { assertMigrationIntegrity } = await import("./migrationIntegrity");
  assertMigrationIntegrity(migrationsFolder);

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

  /**
   * RONDE 95 FINAL — the preflight runs where the renders run, not only from a terminal.
   *
   * `productionPreflight` has existed since RONDE 191 and had exactly one caller: a CLI somebody
   * has to remember to run. So the environment that actually renders never checked itself, and a
   * missing dependency was discovered by a render — which is the case the preflight was built to
   * prevent.
   *
   * Placed AFTER the CLIP warm-up on purpose: the vision probe loads the model, the warm-up has
   * just loaded it, and `ensureClipPipelinesLoaded` caches — so the check costs nothing here and
   * would cost a cold load anywhere earlier.
   *
   * It reports and does not refuse. A BLOCKED verdict is printed as a banner and written to the
   * heartbeat, but the queue still starts: the pipeline already refuses to SHIP a bad render
   * (RONDE 89's export gate), so the only thing a boot refusal would save is wasted compute, and
   * the only thing a false positive would cost is the entire product. Visibility is what §29 asks
   * for and what can be justified without a production render to check the verdict against.
   */
  try {
    const { productionPreflight, formatPreflight } = await import("./productionPreflight");
    const { execSync } = await import("child_process");
    const { ensureClipPipelinesLoaded } = await import("./localClipVision");
    const { graphicsOverlayAvailable } = await import("./graphicsOverlayDeps");
    const report = await productionPreflight({
      hasBinary: (name) => {
        try {
          execSync(`command -v ${name}`, { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      },
      hasBrowser: () => graphicsOverlayAvailable(),
      canReachDatabase: async () => {
        try {
          const { getDb } = await import("./db");
          const db = await getDb();
          if (!db) return false;
          await db.execute("SELECT 1" as never);
          return true;
        } catch {
          return false;
        }
      },
      canReachRedis: async () => true,
      canLoadVisionModel: async () => ensureClipPipelinesLoaded().catch(() => false),
      /**
       * Ask the download service whether it can reach YouTube, rather than whether it exists.
       *
       * The service runs its own probe — one metadata call through the same yt-dlp options a
       * download uses — so this is a cheap read of an answer it already has. Presence only in the
       * request: the bearer token is sent, never logged, and the service's reply carries no
       * credential (see `_probe_egress` in services/ytdlp-download/main.py).
       *
       * `null` on any failure to ASK, which the preflight reports differently from a failure to
       * REACH: "the service did not answer" and "the service answered that it is blocked" send an
       * operator to two different places.
       *
       * ── A SECOND READER OF ONE CONTRACT, AND IT HAD DRIFTED ─────────────────────────────
       *
       * This was an inline copy of the request, and it read the STATUS:
       *
       *     if (!res.ok) return null;
       *
       * RONDE 258 gives `/health/egress` an honest status code — 503 when the probe failed — and
       * `youtubeEgressProbe.ts` says in as many words why that line is wrong: "The STATUS is not
       * the answer; the BODY is … reading the status would discard the very verdict this call
       * exists to fetch." A 503 is exactly what the service returns when YouTube blocks it, so
       * the one case this probe exists for was the one case it threw away.
       *
       * Measured in production on de1c88b, 2026-09-20:
       *
       *     17:46:19  GET /health/egress  200 OK
       *     17:46:22  GET /health/egress  200 OK
       *     17:46:42  ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot.
       *     17:46:42  GET /health/egress  503 Service Unavailable
       *     [Preflight] NO youtube_egress — the yt-dlp service did not answer its own egress probe
       *
       * The preflight has a branch that says "CANNOT reach YouTube (bot_check) … check PROXY_URL
       * on the download service". It was unreachable from here, and the operator was told to
       * restart a service that had answered correctly.
       *
       * RONDE 258's own note states the intent this now meets: "`worker.ts` already asks this
       * endpoint at boot, inline. A second copy in the pipeline would be a second reader of one
       * contract, free to drift; both now call this." There is one reader again.
       *
       * The boot probe keeps its own generous timeout: the render-time default is short because
       * it runs on a beat that has already lost its budget, and startup has no such constraint.
       */
      canReachYoutubeEgress: async () => askYoutubeEgress(WORKER_EGRESS_PROBE_TIMEOUT_MS),
    });
    console.log(formatPreflight(report));
    if (report.verdict === "PRODUCTION_RENDER_BLOCKED") {
      console.error(
        "[Preflight] PRODUCTION_RENDER_BLOCKED — a render started now cannot produce a " +
          `shippable video. Blockers: ${report.blockers.join(" | ")}`
      );
    }
    await recordWorkerHeartbeat("worker", {
      clipReady,
      clipHint: `preflight=${report.verdict}${clipStatus.hint ? ` ${clipStatus.hint}` : ""}`,
    }).catch(() => {});
  } catch (err) {
    /** A preflight that cannot run must never be the reason a worker does not start. */
    console.warn("[Preflight] could not run at boot:", (err as Error).message);
  }

  startVideoQueueWorker();
  /**
   * RONDE 148 — render jobs poll alongside the generation queue, in the same process.
   *
   * A separate poll loop rather than a stage inside the generation queue, because the two have
   * nothing in common but ffmpeg: a render job has no script, no TTS, no sourcing and no per-user
   * depth limit, and folding it into `processQueueTick` would put an edit behind every video
   * waiting to be generated. Its own concurrency cap (MAX_CONCURRENT_RENDER_JOBS, 1 by default)
   * keeps it from competing with a generation run for the box.
   */
  const { startRenderJobWorker } = await import("./renderJobWorker");
  startRenderJobWorker();
  const { scheduleClipEmbeddingBackfill } = await import("./archiveClipIndexBackfill");
  scheduleClipEmbeddingBackfill();
  const { startClipBackgroundAuditor } = await import("./clipBackgroundAuditor");
  startClipBackgroundAuditor();
  /**
   * RONDE 640 — YouTube found during a render is fetched here, between renders, into the archive.
   * Render 603 found 49 videos and downloaded none: every scene reached YouTube with seconds left.
   */
  /**
   * RONDE 641 — can a YouTube FILE arrive, per route? The preflight only asks whether the service
   * can reach YouTube, and it said yes on the deployment where 49 of 49 downloads failed.
   */
  const { scheduleYoutubeRouteTest } = await import("./youtubeRouteTest");
  scheduleYoutubeRouteTest();
  const { startYoutubePrefetchWorker } = await import("./youtubePrefetch");
  await startYoutubePrefetchWorker().catch((err) =>
    console.warn("[YouTubePrefetch] could not start:", (err as Error).message)
  );

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
