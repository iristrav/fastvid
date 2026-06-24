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
  const maxConcurrentJobs = Math.max(1, parseInt(env.MAX_CONCURRENT_JOBS ?? "25", 10) || 25);
  const maxJobsPerWorkerRaw = env.MAX_JOBS_PER_WORKER?.trim();
  const maxJobsPerWorker = maxJobsPerWorkerRaw
    ? Math.max(1, parseInt(maxJobsPerWorkerRaw, 10) || maxConcurrentJobs)
    : 1;

  return {
    /** Platform-wide cap (all workers combined). Raise via MAX_CONCURRENT_JOBS on Railway. */
    maxConcurrentJobs,
    /** Max jobs this Node process runs at once. Scale out: add worker replicas, lower per worker. */
    maxJobsPerWorker: Math.min(maxJobsPerWorker, maxConcurrentJobs),
    maxActiveJobsPerUser: Math.max(1, parseInt(env.MAX_ACTIVE_JOBS_PER_USER ?? "1", 10) || 1),
    maxQueuedJobsPerUser: Math.max(1, parseInt(env.MAX_QUEUED_JOBS_PER_USER ?? "1", 10) || 1),
    pollIntervalMs: Math.max(2000, parseInt(env.QUEUE_POLL_INTERVAL_MS ?? "5000", 10) || 5000),
  };
}

/** Dedicated worker service (Railway service 2). */
export function isWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKER_MODE === "true";
}

/** Run queue poller inside the web process only when explicitly enabled. */
export function shouldRunQueueWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isWorkerMode(env)) return true;
  return env.EMBED_QUEUE_WORKER === "true";
}
