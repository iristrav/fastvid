/** Video pipeline statuses that consume a global worker slot. */
export const PIPELINE_PROCESSING_STATUSES = [
  "pending",
  "generating_script",
  "generating_voiceover",
  "generating_visuals",
  "generating_effects",
] as const;

export type PipelineProcessingStatus = (typeof PIPELINE_PROCESSING_STATUSES)[number];

/** Blocks starting another video until these reach completed or failed. */
export const USER_IN_FLIGHT_VIDEO_STATUSES = [
  "queued",
  ...PIPELINE_PROCESSING_STATUSES,
  "awaiting_approval",
] as const;

export function readQueueConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxConcurrentJobs: Math.max(1, parseInt(env.MAX_CONCURRENT_JOBS ?? "6", 10) || 6),
    maxActiveJobsPerUser: Math.max(1, parseInt(env.MAX_ACTIVE_JOBS_PER_USER ?? "1", 10) || 1),
    maxQueuedJobsPerUser: Math.max(1, parseInt(env.MAX_QUEUED_JOBS_PER_USER ?? "1", 10) || 1),
    pollIntervalMs: Math.max(2000, parseInt(env.QUEUE_POLL_INTERVAL_MS ?? "5000", 10) || 5000),
  };
}

/** Dedicated worker service (Railway service 2). */
export function isWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKER_MODE === "true";
}

/** Run queue poller inside the web process unless explicitly disabled. */
export function shouldRunQueueWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isWorkerMode(env)) return true;
  return env.EMBED_QUEUE_WORKER !== "false";
}
