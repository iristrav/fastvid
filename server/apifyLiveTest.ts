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

/**
 * MEASUREMENT MODE — no acquisition timeout of ours at all.
 *
 * The first question is how long Apify actually takes, not whether it fits a budget we already had.
 * So the run gets no FastVid deadline and no `timeout` is sent to Apify: it ends when the actor
 * finishes, or when Apify reports a failure, or on a real network failure.
 *
 * The only limit is this watchdog: a guard against a hung request or a programming error, set far
 * above any plausible run (45 minutes by default). If it fires, the result is WATCHDOG_TIMEOUT and
 * is reported as NOT being a measured acquisition time.
 */
export function apifyLiveTestWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.YOUTUBE_APIFY_LIVE_TEST_WATCHDOG_MIN ?? "", 10);
  return (Number.isFinite(n) && n >= 10 && n <= 180 ? n : 45) * 60_000;
}

/** The report in the order the brief asks for it. Seconds to one decimal, measured, never rounded up. */
export function formatApifyTimingReport(r: {
  ok: boolean;
  failure?: string;
  summary: { actorWaitMs: number | null; fileDownloadMs: number | null; validationMs: number | null; totalMs: number };
  bytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  codec?: string | null;
}): string {
  const sec = (ms: number | null | undefined) => (ms == null ? "not reached" : `${(ms / 1000).toFixed(1)}s`);
  const watchdog = r.failure === "WATCHDOG_TIMEOUT";
  return [
    "[YouTubeApify] REPORT",
    `APIFY_TOTAL_TIME=${watchdog ? "NOT MEASURED (watchdog)" : sec(r.summary.totalMs)}`,
    `ACTOR_WAIT=${sec(r.summary.actorWaitMs)}`,
    `FILE_DOWNLOAD=${sec(r.summary.fileDownloadMs)}`,
    `VALIDATION=${sec(r.summary.validationMs)}`,
    `FILE_SIZE=${r.bytes != null ? `${(r.bytes / 1024 / 1024).toFixed(1)}MB` : "none"}`,
    `VIDEO_DURATION=${r.durationSec != null ? `${r.durationSec.toFixed(1)}s` : "none"}`,
    `RESOLUTION=${r.width && r.height ? `${r.width}x${r.height}` : "none"}`,
    `CODEC=${r.codec ?? "none"}`,
    `RESULT=${r.ok ? "PASS" : `FAIL(${r.failure ?? "unknown"})`}`,
  ].join(" ");
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
  console.log(`[YouTubeApify] LIVE_TEST claimed ${key} — one run, video=${videoId} (CC BY test video), measurement mode: no deadline, watchdog ${apifyLiveTestWatchdogMs() / 60_000} min`);
  try {
    const result = await acquireYoutubeVideoViaApify(
      {
        videoId,
        quality: "1080",
        outPath: path.join(dir, `${videoId}.mp4`),
        deadlineMs: null,
        watchdogMs: apifyLiveTestWatchdogMs(),
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
        `actorWaitMs=${result.summary.actorWaitMs ?? "none"} apifyRunMs=${result.summary.providerWaitMs ?? "none"} fileDownloadMs=${result.summary.fileDownloadMs ?? "none"} ` +
        `validationMs=${result.summary.validationMs ?? "none"} totalMs=${result.summary.totalMs} usageUsd=${result.usageTotalUsd ?? "?"}`
    );
    console.log(
      formatApifyTimingReport(
        result.ok
          ? { ok: true, summary: result.summary, bytes: result.bytes, durationSec: result.durationSec, width: result.width, height: result.height, codec: result.codec }
          : { ok: false, failure: result.failure, summary: result.summary }
      )
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
