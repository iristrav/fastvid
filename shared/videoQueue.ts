/** Video pipeline statuses that consume a global worker slot. */
export const PIPELINE_PROCESSING_STATUSES = [
  "pending",
  "generating_script",
  "generating_voiceover",
  "generating_visuals",
  "generating_effects",
] as const;

export type PipelineProcessingStatus = (typeof PIPELINE_PROCESSING_STATUSES)[number];

export function readQueueConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxConcurrentJobs: Math.max(1, parseInt(env.MAX_CONCURRENT_JOBS ?? "2", 10) || 2),
    maxActiveJobsPerUser: Math.max(1, parseInt(env.MAX_ACTIVE_JOBS_PER_USER ?? "1", 10) || 1),
    maxQueuedJobsPerUser: Math.max(1, parseInt(env.MAX_QUEUED_JOBS_PER_USER ?? "5", 10) || 5),
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
