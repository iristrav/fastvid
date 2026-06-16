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
  for (const candidate of queued) {
    const userActive = await countUserProcessingVideos(candidate.userId);
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

      runVideoJob(claimed)
        .catch((err) => console.error(`[VideoQueue] Video ${claimed.id} failed:`, err))
        .finally(() => {
          localActiveJobs = Math.max(0, localActiveJobs - 1);
          void processQueueTick();
        });
    }
  } finally {
    tickInFlight = false;
  }
}

export function startVideoQueueWorker(): void {
  const config = readQueueConfig();
  if (pollTimer) return;

  console.log(
    `[VideoQueue] Worker started — global max ${config.maxConcurrentJobs}, ` +
      `${config.maxJobsPerWorker}/process, ${config.maxActiveJobsPerUser}/user, ` +
      `poll every ${config.pollIntervalMs}ms`
  );

  void processQueueTick();
  pollTimer = setInterval(() => {
    void processQueueTick();
  }, config.pollIntervalMs);
}

export function stopVideoQueueWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function throwEnqueueError(check: Extract<EnqueueCheckResult, { ok: false }>): never {
  throw appTrpcError("TOO_MANY_REQUESTS", check.code, check.message);
}

export { getVideoQueuePosition };
