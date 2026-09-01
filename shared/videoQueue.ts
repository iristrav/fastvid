/** Video pipeline statuses that consume a global worker slot. */
export const PIPELINE_PROCESSING_STATUSES = [
  "pending",
  "generating_script",
  "generating_voiceover",
  "generating_visuals",
  "generating_effects",
] as const;

export type PipelineProcessingStatus = (typeof PIPELINE_PROCESSING_STATUSES)[number];

/** Counts against a user's queue depth until these reach completed or failed. */
export const USER_IN_FLIGHT_VIDEO_STATUSES = [
  "queued",
  ...PIPELINE_PROCESSING_STATUSES,
  "awaiting_approval",
] as const;

/**
 * RONDE 109 — "this user already has a render underway", for the queue picker.
 *
 * Deliberately NOT the same list as USER_IN_FLIGHT_VIDEO_STATUSES: that one answers "how many
 * videos does this user have standing in line", and every waiting video is in it by definition.
 * This one answers "may the picker start one more for this user", so `queued` must be absent or
 * the picker would refuse to start anything.
 *
 * `awaiting_approval` IS in it, and that is the point. A full run passes THROUGH that status for a
 * second or two between finishing the script and starting the voiceover (generateScriptOnly writes
 * it; generateFullVideo moves on immediately). It is not a pipeline-processing status, so without
 * it a picker tick landing inside that window would see the user as idle and claim their next
 * queued video — two renders at once for one user, which is exactly what the queue exists to
 * prevent. Unreachable before this round only because a user could never have a second video
 * waiting; making the queue five deep makes it reachable.
 */
export const USER_ACTIVE_VIDEO_STATUSES = [
  ...PIPELINE_PROCESSING_STATUSES,
  "awaiting_approval",
] as const;

/**
 * RONDE 109 — how many videos one user may have standing in line at once.
 *
 * Asking for a video while one is running used to be refused outright. Now it is accepted and
 * parked: the render that is busy keeps running, the new one waits its turn, and the queue starts
 * it the moment the previous one ends. Five is the product rule — enough to line up an evening's
 * work, small enough that one account cannot monopolise the workers.
 *
 * This is a QUEUE depth, not a concurrency setting. maxActiveJobsPerUser (1) is what still decides
 * how many of those five may RUN at the same time, and that is unchanged.
 */
export const USER_QUEUE_DEPTH_DEFAULT = 5;

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
    /** How many of one user's videos may RUN at once. One: they go one after the other. */
    maxActiveJobsPerUser: Math.max(1, parseInt(env.MAX_ACTIVE_JOBS_PER_USER ?? "1", 10) || 1),
    /**
     * How many videos one user may have in flight at once — running plus waiting. Until RONDE 109
     * this was read but never enforced anywhere, and the real limit was a hard-coded "more than
     * zero is too many" in assertUserCanEnqueueVideo.
     */
    maxQueuedJobsPerUser: Math.max(
      1,
      parseInt(env.MAX_QUEUED_JOBS_PER_USER ?? String(USER_QUEUE_DEPTH_DEFAULT), 10) ||
        USER_QUEUE_DEPTH_DEFAULT
    ),
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
