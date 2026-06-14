/**
 * DB-backed video generation queue.
 * Web enqueues jobs; worker(s) claim and run the pipeline with concurrency limits.
 */

import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import { readQueueConfig } from "@shared/videoQueue";
import type { Video } from "../drizzle/schema";
import {
  claimQueuedVideo,
  countGlobalProcessingVideos,
  countUserAwaitingScriptApproval,
  countUserProcessingVideos,
  countUserQueuedVideos,
  getVideoById,
  getVideoQueuePosition,
  listQueuedVideosOrdered,
  updateVideoStatus,
} from "./db";

export type EnqueueCheckResult =
  | { ok: true }
  | { ok: false; code: number; message: string };

export async function assertUserCanEnqueueVideo(userId: number): Promise<EnqueueCheckResult> {
  const config = readQueueConfig();

  const awaitingScript = await countUserAwaitingScriptApproval(userId);
  if (awaitingScript > 0) {
    return {
      ok: false,
      code: APP_ERROR.SCRIPT_REVIEW_PENDING,
      message: "Approve or reject your pending script before starting a new video",
    };
  }

  const queued = await countUserQueuedVideos(userId);
  if (queued >= config.maxQueuedJobsPerUser) {
    return {
      ok: false,
      code: APP_ERROR.QUEUE_LIMIT_REACHED,
      message: `You already have ${queued} videos waiting in the queue (max ${config.maxQueuedJobsPerUser})`,
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

let activeJobs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function nudgeQueueWorker(): void {
  void processQueueTick();
}

async function pickNextQueuedVideo(): Promise<Video | undefined> {
  const config = readQueueConfig();
  const globalActive = await countGlobalProcessingVideos();
  if (globalActive + activeJobs >= config.maxConcurrentJobs) return undefined;

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
    while (activeJobs < config.maxConcurrentJobs) {
      const globalActive = await countGlobalProcessingVideos();
      if (globalActive + activeJobs >= config.maxConcurrentJobs) break;

      const next = await pickNextQueuedVideo();
      if (!next) break;

      const claimed = await claimQueuedVideo(next.id, "Starting generation...");
      if (!claimed) continue;

      activeJobs++;
      console.log(`[VideoQueue] Claimed video ${claimed.id} for user ${claimed.userId}`);

      runVideoJob(claimed)
        .catch((err) => console.error(`[VideoQueue] Video ${claimed.id} failed:`, err))
        .finally(() => {
          activeJobs = Math.max(0, activeJobs - 1);
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
    `[VideoQueue] Worker started — max ${config.maxConcurrentJobs} global, ` +
      `${config.maxActiveJobsPerUser}/user, poll every ${config.pollIntervalMs}ms`
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
