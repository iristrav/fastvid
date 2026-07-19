/**
 * DB-backed video generation queue.
 * Web enqueues jobs; one or more workers claim and run the pipeline.
 *
 * Scaling: set MAX_CONCURRENT_JOBS globally (e.g. 50), run N worker replicas each with
 * MAX_JOBS_PER_WORKER=10 and EMBED_QUEUE_WORKER=false on the web service.
 */

import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import { readQueueConfig } from "@shared/videoQueue";
import type { Video } from "../drizzle/schema";
import {
  claimQueuedVideo,
  countGlobalProcessingVideos,
  countProcessingVideosByUsers,
  countUserInFlightVideos,
  countUserProcessingVideos,
  getVideoQueuePosition,
  listQueuedVideosOrdered,
  updateVideoStatus,
} from "./db";

export type EnqueueCheckResult =
  | { ok: true }
  | { ok: false; code: number; message: string };

export async function assertUserCanEnqueueVideo(
  userId: number,
  exceptVideoId?: number
): Promise<EnqueueCheckResult> {
  const inFlight = await countUserInFlightVideos(userId, exceptVideoId);
  if (inFlight > 0) {
    return {
      ok: false,
      code: APP_ERROR.VIDEO_IN_PROGRESS,
      message: "You already have a video in progress. Wait until it is finished before starting a new one",
    };
  }

  return { ok: true };
}

export async function enqueueVideoJob(
  videoId: number,
  progressStep: string
): Promise<{ queuePosition: number }> {
  await updateVideoStatus(videoId, "queued", {
    progressStep,
    progressPercent: 0,
    errorMessage: "",
  });
  const queuePosition = (await getVideoQueuePosition(videoId)) ?? 1;
  nudgeQueueWorker();
  return { queuePosition };
}

/** Jobs currently executing inside this Node process (per-worker RAM limit). */
let localActiveJobs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function nudgeQueueWorker(): void {
  void processQueueTick();
}

async function pickNextQueuedVideo(): Promise<Video | undefined> {
  const config = readQueueConfig();
  const globalActive = await countGlobalProcessingVideos();
  if (globalActive >= config.maxConcurrentJobs) return undefined;

  const queued = await listQueuedVideosOrdered(100);
  if (!queued.length) return undefined;

  // Fetch per-user active counts in one query instead of N individual queries
  const uniqueUserIds = Array.from(new Set(queued.map((v) => v.userId)));
  const activeByUser = await countProcessingVideosByUsers(uniqueUserIds);

  for (const candidate of queued) {
    const userActive = activeByUser.get(candidate.userId) ?? 0;
    if (userActive >= config.maxActiveJobsPerUser) continue;
    return candidate;
  }
  return undefined;
}

async function runVideoJob(video: Video): Promise<void> {
  const { generateFullVideoInternal } = await import("./routers");
  const enableSubtitles = video.enableSubtitles !== 0;
  await generateFullVideoInternal(
    video.id,
    video.prompt,
    video.videoLength ?? "15-20",
    video.videoType ?? "documentary",
    video.voiceId ?? undefined,
    video.customVoiceoverUrl ?? undefined,
    enableSubtitles
  );
}

export async function processQueueTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const config = readQueueConfig();
    while (localActiveJobs < config.maxJobsPerWorker) {
      const globalActive = await countGlobalProcessingVideos();
      if (globalActive >= config.maxConcurrentJobs) break;

      const next = await pickNextQueuedVideo();
      if (!next) break;

      const claimed = await claimQueuedVideo(next.id, "Starting generation...");
      if (!claimed) continue;

      localActiveJobs++;
      console.log(
        `[VideoQueue] Claimed video ${claimed.id} for user ${claimed.userId} ` +
          `(local ${localActiveJobs}/${config.maxJobsPerWorker}, global ${globalActive + 1}/${config.maxConcurrentJobs})`
      );

      // Watchdog: release worker slot after 3 hours even if the Promise hangs.
      // Prevents a stuck FFmpeg call from blocking all subsequent renders indefinitely.
      const maxJobMs = parseInt(process.env.MAX_JOB_MS ?? String(3 * 60 * 60_000), 10);
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        localActiveJobs = Math.max(0, localActiveJobs - 1);
        void processQueueTick();
      };
      const jobWatchdog = setTimeout(() => {
        console.error(`[VideoQueue] Video ${claimed.id} exceeded ${Math.round(maxJobMs / 60_000)}min — force-releasing worker slot`);
        releaseSlot();
      }, maxJobMs);

      runVideoJob(claimed)
        .catch((err) => console.error(`[VideoQueue] Video ${claimed.id} failed:`, err))
        .finally(() => {
          clearTimeout(jobWatchdog);
          releaseSlot();
        });
    }
  } catch (err) {
    console.warn("[VideoQueue] Queue tick error (DB may be unavailable):", (err as Error).message);
  } finally {
    tickInFlight = false;
  }
}

// How often to scan for videos stuck in generating_* longer than STUCK_VIDEO_MINUTES.
const STUCK_CHECK_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
const STUCK_VIDEO_MINUTES = parseInt(process.env.STUCK_VIDEO_MINUTES ?? "20", 10);

async function runStuckVideoCheck(): Promise<void> {
  try {
    const { expireStuckVideos, recoverAllStuckVideos } = await import("./db");
    const expired = await expireStuckVideos(STUCK_VIDEO_MINUTES);
    const { completed, failed } = await recoverAllStuckVideos(nudgeQueueWorker);
    if (expired > 0 || completed > 0 || failed > 0) {
      console.log(`[VideoQueue] Stuck-video sweep: expired=${expired} recovered=${completed} re-queued=${failed}`);
      void processQueueTick();
    }
  } catch (err) {
    console.warn("[VideoQueue] Stuck-video check error:", (err as Error).message?.slice(0, 100));
  }
}

export function startVideoQueueWorker(): void {
  const config = readQueueConfig();
  if (pollTimer) return;

  console.log(
    `[VideoQueue] Worker started — global max ${config.maxConcurrentJobs}, ` +
      `${config.maxJobsPerWorker}/process, ${config.maxActiveJobsPerUser}/user, ` +
      `poll every ${config.pollIntervalMs}ms, stuck check every ${STUCK_CHECK_INTERVAL_MS / 60_000}min`
  );

  void processQueueTick();
  pollTimer = setInterval(() => {
    void processQueueTick();
  }, config.pollIntervalMs);

  // Periodically recover videos stuck mid-pipeline (e.g. after a worker crash)
  setInterval(() => { void runStuckVideoCheck(); }, STUCK_CHECK_INTERVAL_MS);
}

export function stopVideoQueueWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Active pipeline jobs in this worker process (for deferring background CLIP work). */
export function workerLocalActiveJobs(): number {
  return localActiveJobs;
}

export function throwEnqueueError(check: Extract<EnqueueCheckResult, { ok: false }>): never {
  throw appTrpcError("TOO_MANY_REQUESTS", check.code, check.message);
}

export { getVideoQueuePosition };
