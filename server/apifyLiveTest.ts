/**
 * ONE CONTROLLED APIFY RUN, FROM THE WORKER, MEASURED END TO END. RONDE 644.
 *
 * The question: how many seconds does Apify actually need, from this worker, to a usable MP4?
 * Answered by doing it once per deployment — not once per replica: three workers boot the same code
 * and each Apify run is paid, so the first INSERT into `worker_once_claims` wins and the others
 * stand aside. Only when no render is running. The file is validated and then deleted.
 *
 * The test video is Big Buck Bunny, published by the Blender Foundation under CC BY 3.0.
 */
import fs from "fs";
import path from "path";

export const APIFY_LIVE_TEST_DEFAULT_VIDEO_ID = "aqz-KE-bpKQ";

export function apifyLiveTestVideoId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.YOUTUBE_APIFY_LIVE_TEST_VIDEO_ID?.trim();
  return raw && /^[A-Za-z0-9_-]{6,32}$/.test(raw) ? raw : APIFY_LIVE_TEST_DEFAULT_VIDEO_ID;
}

/** A measurement window, not a production budget: generous so the run's real length is observed. */
export function apifyLiveTestDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.YOUTUBE_APIFY_LIVE_TEST_DEADLINE_SEC ?? "", 10);
  return (Number.isFinite(n) && n >= 60 && n <= 1800 ? n : 600) * 1000;
}

/** One claim per deployed commit, so a redeploy measures again and a replica never duplicates. */
export function apifyLiveTestClaimKey(env: NodeJS.ProcessEnv = process.env): string {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? env.RAILWAY_DEPLOYMENT_ID ?? "unknown").trim().slice(0, 40);
  return `apify-live-test:${sha}`;
}

/** INSERT IGNORE on a unique key: true only for the one worker whose row landed. */
export async function claimOnce(claimKey: string, holder: string): Promise<boolean> {
  const { getDb, affectedRowCount } = await import("./db");
  const { workerOnceClaims } = await import("../drizzle/schema");
  const db = await getDb();
  if (!db) return false;
  const result = await db.insert(workerOnceClaims).ignore().values({ claimKey, holder: holder.slice(0, 128) });
  return affectedRowCount(result) === 1;
}

export async function runApifyLiveTest(): Promise<void> {
  const { acquireYoutubeVideoViaApify, apifyToken, apifyYoutubeEnabled, productionApifyDeps } = await import(
    "./apifyYoutubeProvider"
  );
  const token = apifyToken();
  if (!apifyYoutubeEnabled()) return void console.log("[YouTubeApify] LIVE_TEST skipped — YOUTUBE_APIFY_ENABLED=false");
  if (!token) return void console.log("[YouTubeApify] LIVE_TEST skipped — APIFY_API_TOKEN=MISSING");
  const { workerIsIdle } = await import("./youtubePrefetch");
  if (!(await workerIsIdle())) return void console.log("[YouTubeApify] LIVE_TEST skipped — a render is running");
  const key = apifyLiveTestClaimKey();
  const holder = `${process.env.RAILWAY_REPLICA_ID ?? "replica"}:${process.pid}`;
  if (!(await claimOnce(key, holder).catch(() => false))) {
    return void console.log(`[YouTubeApify] LIVE_TEST skipped — another worker holds ${key}`);
  }
  const { TMP_DIR } = await import("./videoPipeline");
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "fastvid_apifytest_"));
  const videoId = apifyLiveTestVideoId();
  console.log(`[YouTubeApify] LIVE_TEST claimed ${key} — one run, video=${videoId} (CC BY test video)`);
  try {
    const result = await acquireYoutubeVideoViaApify(
      {
        videoId,
        quality: "1080",
        outPath: path.join(dir, `${videoId}.mp4`),
        deadlineMs: apifyLiveTestDeadlineMs(),
        token,
        enabled: true,
      },
      await productionApifyDeps(token)
    );
    const t = result.timing;
    const iso = (ms: number | null) => (ms != null ? new Date(ms).toISOString() : "none");
    console.log(
      `[YouTubeApify] LIVE_TEST_RESULT videoId=${videoId} ok=${result.ok} runId=${result.runId ?? "none"} ` +
        (result.ok
          ? `bytes=${result.bytes} durationSec=${result.durationSec.toFixed(1)} resolution=${result.width}x${result.height} ` +
            `codec=${result.codec ?? "?"} fps=${result.fps ?? "?"} requestedQuality=${result.requestedQuality ?? "actor_default"} `
          : `class=${result.failure} detail=${result.detail} `) +
        `testStartedAt=${iso(t.startedAt)} apifyRunCreatedAt=${iso(t.runCreatedAt)} apifyRunFinishedAt=${iso(t.runFinishedAt)} ` +
        `apifyReportedStart=${t.apifyRunStartedAt ?? "none"} apifyReportedFinish=${t.apifyRunFinishedAt ?? "none"} ` +
        `fileDownloadStartedAt=${iso(t.fileDownloadStartedAt)} fileDownloadFinishedAt=${iso(t.fileDownloadFinishedAt)} ` +
        `validationStartedAt=${iso(t.validationStartedAt)} validationFinishedAt=${iso(t.validationFinishedAt)} ` +
        `apifyRunMs=${result.summary.providerWaitMs ?? "none"} fileDownloadMs=${result.summary.fileDownloadMs ?? "none"} ` +
        `validationMs=${result.summary.validationMs ?? "none"} totalMs=${result.summary.totalMs} usageUsd=${result.usageTotalUsd ?? "?"}`
    );
  } catch (err) {
    console.warn(`[YouTubeApify] LIVE_TEST could not run: ${(err as Error).message?.slice(0, 200)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Off with YOUTUBE_APIFY_LIVE_TEST=false. After the route test, so the two never overlap. */
export function scheduleApifyLiveTest(delayMs = 150_000): void {
  if (process.env.YOUTUBE_APIFY_LIVE_TEST?.trim() === "false") return;
  const t = setTimeout(() => void runApifyLiveTest(), delayMs);
  t.unref?.();
}
