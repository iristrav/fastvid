import "dotenv/config";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { shouldRunQueueWorker } from "@shared/videoQueue";
import { recoverAllStuckVideos } from "./db";
import { logLlmStartupDiagnostics, assertProductionLlmReady } from "./llmStartupDiagnostics";
import { startVideoQueueWorker } from "./videoQueue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function main() {
  if (!shouldRunQueueWorker({ ...process.env, WORKER_MODE: "true" })) {
    console.error("[Worker] WORKER_MODE must be true");
    process.exit(1);
  }

  console.log("[Worker] Fastvid video queue worker starting...");
  logLlmStartupDiagnostics("worker");
  assertProductionLlmReady();
  const { recordWorkerHeartbeat } = await import("./workerHeartbeat");
  await recordWorkerHeartbeat("worker").catch((e) =>
    console.warn("[Worker] Heartbeat failed:", (e as Error).message)
  );
  setInterval(() => {
    recordWorkerHeartbeat("worker").catch(() => {});
  }, 60_000);
  const { getStorageBackend } = await import("./storageBackend");
  console.log("[Worker] Object storage:", getStorageBackend());
  await runMigrations();
  await recoverAllStuckVideos();
  startVideoQueueWorker();

  setInterval(() => {
    import("./db")
      .then(({ failAllStalledPipelines }) => failAllStalledPipelines())
      .then((n) => {
        if (n > 0) console.log(`[Worker] Marked ${n} stalled video(s) as failed`);
      })
      .catch((e) => console.error("[Worker] Stall check failed:", e));
  }, 90_000);
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
