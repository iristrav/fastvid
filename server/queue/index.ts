/**
 * Queue backend switch — Phase 1.
 *
 * Defaults to the existing DB-polling queue (server/videoQueue.ts) completely unchanged.
 * BullMQ only activates when QUEUE_BACKEND=bullmq is set, and boot refuses to start with
 * that flag on unless REDIS_URL is also set — so this file is a no-op for every deployment
 * that hasn't explicitly opted in, and the bullmq/ioredis modules are never even imported
 * (dynamic import, gated below) unless the flag is on.
 *
 * All 5 enqueueVideoJob call sites in routers.ts and the worker.ts boot sequence import
 * from here instead of ./videoQueue directly — that's the only touch point in those call
 * sites, everything else about them is unchanged regardless of which backend is active.
 */
import * as dbQueue from "../videoQueue";

const useBullMq = process.env.QUEUE_BACKEND === "bullmq";

if (useBullMq && !process.env.REDIS_URL) {
  throw new Error(
    "[Fastvid] QUEUE_BACKEND=bullmq is set but REDIS_URL is not. Refusing to start — " +
      "set REDIS_URL, or unset QUEUE_BACKEND to use the default DB-polling queue."
  );
}

// Backend-agnostic: these only read/compute from the videos table, which stays the single
// source of truth regardless of which backend is triggering job execution.
export const assertUserCanEnqueueVideo = dbQueue.assertUserCanEnqueueVideo;
export const getVideoQueuePosition = dbQueue.getVideoQueuePosition;
export const getUserQueuePosition = dbQueue.getUserQueuePosition;
export const userQueueDepthLimit = dbQueue.userQueueDepthLimit;
export const throwEnqueueError = dbQueue.throwEnqueueError;

export async function enqueueVideoJob(
  videoId: number,
  progressStep: string
): Promise<{ queuePosition: number; userQueuePosition: number }> {
  if (useBullMq) {
    const { enqueueVideoJob: bullmqEnqueue } = await import("./bullmqQueue");
    return bullmqEnqueue(videoId, progressStep);
  }
  return dbQueue.enqueueVideoJob(videoId, progressStep);
}

export function startVideoQueueWorker(): void {
  if (useBullMq) {
    void import("./bullmqQueue").then((m) => m.startVideoQueueWorker());
    return;
  }
  dbQueue.startVideoQueueWorker();
}

export function stopVideoQueueWorker(): void {
  if (useBullMq) {
    void import("./bullmqQueue").then((m) => m.stopVideoQueueWorker());
    return;
  }
  dbQueue.stopVideoQueueWorker();
}
