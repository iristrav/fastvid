/**
 * BullMQ-backed video queue — Phase 1, opt-in via QUEUE_BACKEND=bullmq + REDIS_URL.
 *
 * Mirrors server/videoQueue.ts's public surface (enqueueVideoJob, startVideoQueueWorker,
 * stopVideoQueueWorker) so server/queue/index.ts can switch between the two backends
 * without any caller caring which one is active. The actual pipeline invocation
 * (generateFullVideoInternal) and claim step (claimQueuedVideo, the same atomic
 * conditional UPDATE + generationAttempt fencing token used by the DB-polling backend) are
 * reused unchanged — this file only replaces *how a job is picked up*, not what running one
 * does. Jobs persist in Redis, so a queued/in-progress job survives this process
 * restarting (BullMQ's stalled-job detection returns it to the queue automatically), unlike
 * the DB-polling backend where the only durable state is the videos row itself.
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { readQueueConfig } from "@shared/videoQueue";
import { claimQueuedVideo, getVideoById, getVideoQueuePosition, updateVideoStatus } from "../db";
import { activeJobsCount, decrementActiveJobs, incrementActiveJobs } from "./activeJobsCounter";

const QUEUE_NAME = "video-generation";

function createConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("[BullMQ] REDIS_URL is not set");
  // BullMQ requires this — it manages its own retry/blocking semantics.
  return new IORedis(url, { maxRetriesPerRequest: null });
}

let queue: Queue<{ videoId: number }> | null = null;
function getQueue(): Queue<{ videoId: number }> {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: createConnection() });
  return queue;
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
  // jobId: dedupe key — re-enqueueing the same video (e.g. a retry path) doesn't create a
  // second queue entry.
  await getQueue().add(
    "generate",
    { videoId },
    { jobId: String(videoId), removeOnComplete: true, removeOnFail: { count: 200 } }
  );
  const queuePosition = (await getVideoQueuePosition(videoId)) ?? 1;
  return { queuePosition };
}

async function runVideoJob(videoId: number): Promise<void> {
  // The video may have been cancelled/retried through another path between being queued
  // and this job actually being picked up — re-check status before claiming, same
  // defensive check pickNextQueuedVideo's caller effectively gets from the atomic UPDATE
  // in claimQueuedVideo below.
  const video = await getVideoById(videoId);
  if (!video || video.status !== "queued") return;

  const claimed = await claimQueuedVideo(videoId, "Starting generation...");
  if (!claimed) return;

  const { generateFullVideoInternal } = await import("../routers");
  const enableSubtitles = claimed.enableSubtitles !== 0;
  await generateFullVideoInternal(
    claimed.id,
    claimed.prompt,
    claimed.videoLength ?? "15-20",
    claimed.videoType ?? "documentary",
    claimed.voiceId ?? undefined,
    claimed.customVoiceoverUrl ?? undefined,
    enableSubtitles
  );
}

let worker: Worker<{ videoId: number }> | null = null;

export function startVideoQueueWorker(): void {
  if (worker) return;
  const config = readQueueConfig();
  worker = new Worker<{ videoId: number }>(
    QUEUE_NAME,
    async (job: Job<{ videoId: number }>) => {
      incrementActiveJobs();
      try {
        await runVideoJob(job.data.videoId);
      } finally {
        decrementActiveJobs();
      }
    },
    { connection: createConnection(), concurrency: config.maxJobsPerWorker }
  );
  worker.on("failed", (job, err) => {
    console.error(`[BullMQ] Video ${job?.data?.videoId} failed:`, err);
  });
  console.log(
    `[BullMQ] Worker started — concurrency ${config.maxJobsPerWorker} (local process only; ` +
      `global concurrency across all workers is bounded by however many worker replicas run)`
  );
}

export async function stopVideoQueueWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
