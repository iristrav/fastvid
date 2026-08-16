/**
 * DB-backed video generation queue.
 * Web enqueues jobs; one or more workers claim and run the pipeline.
 *
 * Scaling: set MAX_CONCURRENT_JOBS globally (e.g. 50), run N worker replicas each with
 * MAX_JOBS_PER_WORKER=10 and EMBED_QUEUE_WORKER=false on the web service.
 */

import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import { readQueueConfig, shouldRunQueueWorker } from "@shared/videoQueue";
import type { Video } from "../drizzle/schema";
import {
  claimQueuedVideo,
  countGlobalProcessingVideos,
  countProcessingVideosByUsers,
  countUserInFlightVideos,
  countUserProcessingVideos,
  getVideoById,
  getVideoQueuePosition,
  listQueuedVideosOrdered,
  pipelineStallThresholdMs,
  updateVideoStatus,
} from "./db";
import { activeJobsCount, decrementActiveJobs, incrementActiveJobs } from "./queue/activeJobsCounter";

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

let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function nudgeQueueWorker(): void {
  // On a process that isn't supposed to run jobs at all (the web service, when
  // EMBED_QUEUE_WORKER isn't set), claiming here would immediately re-hit the
  // "refuse and re-queue" path in _generateVideoWithAI, which itself calls enqueueVideoJob
  // → nudgeQueueWorker again — a tight, unbounded local loop that claims and re-queues the
  // same video thousands of times a second without ever actually handing it to the real
  // worker process. Only tick here when this process is actually allowed to process jobs.
  if (!shouldRunQueueWorker()) return;
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
    while (activeJobsCount() < config.maxJobsPerWorker) {
      const globalActive = await countGlobalProcessingVideos();
      if (globalActive >= config.maxConcurrentJobs) break;

      const next = await pickNextQueuedVideo();
      if (!next) break;

      const claimed = await claimQueuedVideo(next.id, "Starting generation...");
      if (!claimed) continue;

      incrementActiveJobs();
      console.log(
        `[VideoQueue] Claimed video ${claimed.id} for user ${claimed.userId} ` +
          `(local ${activeJobsCount()}/${config.maxJobsPerWorker}, global ${globalActive + 1}/${config.maxConcurrentJobs})`
      );

      // Watchdog: release worker slot after 3 hours even if the Promise hangs.
      // Prevents a stuck FFmpeg call from blocking all subsequent renders indefinitely.
      const maxJobMs = parseInt(process.env.MAX_JOB_MS ?? String(3 * 60 * 60_000), 10);
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        decrementActiveJobs();
        void processQueueTick();
      };
      const jobWatchdog = setTimeout(() => {
        // F3-47: this used to unconditionally requestVideoGenerationCancel() every job still
        // running at maxJobMs (3h default), regardless of whether it was still actively making
        // progress — a legitimately long render got cancelled purely for its age. Now checks
        // the same DB heartbeat-staleness definition failPipelineIfStalled() uses
        // (pipelineStallThresholdMs, driven by updatedAt) before cancelling: a video still
        // updating updatedAt keeps running, uninterrupted — only the local slot COUNTER is
        // freed (as it already was) so this worker can accept new work; requestVideoGenerationCancel
        // only fires for a job that's actually stale (no progress), same as before for that case.
        void (async () => {
          const video = await getVideoById(claimed.id).catch(() => undefined);
          const updatedAtMs = video?.updatedAt ? new Date(video.updatedAt).getTime() : 0;
          const stale = !video
            || video.status === "failed"
            || video.status === "completed"
            || Date.now() - updatedAtMs >= pipelineStallThresholdMs(video.videoLength, video.status);
          if (!stale) {
            console.warn(
              `[VideoQueue] Video ${claimed.id} exceeded ${Math.round(maxJobMs / 60_000)}min but is still ` +
              `actively progressing — freeing worker slot only, leaving the render running`
            );
            releaseSlot();
            return;
          }
          console.error(`[VideoQueue] Video ${claimed.id} exceeded ${Math.round(maxJobMs / 60_000)}min and is stale — force-releasing worker slot`);
          // Freeing the slot only stops the COUNTER from blocking new work — the original
          // runVideoJob() promise below keeps running for real (its .catch/.finally are still
          // attached and will fire whenever it eventually settles, however long that takes),
          // so without this the actual CPU/ffmpeg/network work behind a hung job was never
          // being stopped, only left uncounted — letting real concurrency drift arbitrarily
          // above maxJobsPerWorker under repeated hangs. requestVideoGenerationCancel() is the
          // same signal user-initiated cancellation already uses; the pipeline's existing
          // throwIfActiveRenderCancelled()/throwIfVideoGenerationCancelled() checks make it
          // actually unwind instead of just becoming invisible to the slot count.
          const { requestVideoGenerationCancel } = await import("./videoGenerationCancel");
          requestVideoGenerationCancel(claimed.id);
          // Bounded poll for the cancellation to actually land (DB status reaches a terminal
          // state) before freeing the slot — releasing immediately after only requesting
          // cancellation let a new job claim the freed slot while the old job's ffmpeg/CPU work
          // was still genuinely running, so real concurrency could still exceed
          // maxJobsPerWorker/maxConcurrentJobs for as long as the cancelled job took to actually
          // unwind. Capped at 5 minutes so a job whose cancellation checks never fire (e.g.
          // blocked inside a single uninterruptible external call) can't wedge this worker's
          // slot count forever — releaseSlot() below still runs either way.
          const POLL_INTERVAL_MS = 10_000;
          const MAX_POLLS = 30;
          for (let i = 0; i < MAX_POLLS && !slotReleased; i++) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            const polled = await getVideoById(claimed.id).catch(() => undefined);
            if (!polled || polled.status === "failed" || polled.status === "completed") break;
          }
          releaseSlot();
        })();
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

// NOTE: recoverAllStuckVideos() is deliberately NOT called here. It's a one-time,
// no-staleness-check "the previous process died, so anything mid-pipeline must be orphaned"
// recovery — correct at process startup (see server/_core/index.ts and server/worker.ts, which
// both already call it once on boot), but calling it on a recurring timer re-queues every
// currently-active, perfectly healthy render every single sweep, discarding all of its progress.
// The actual periodic staleness check (age/updatedAt-based) is failAllStalledPipelines(), run
// separately on a 90s interval by both entry points.
async function runStuckVideoCheck(): Promise<void> {
  try {
    const { expireStuckVideos } = await import("./db");
    const expired = await expireStuckVideos(STUCK_VIDEO_MINUTES);
    if (expired > 0) {
      console.log(`[VideoQueue] Stuck-video sweep: expired=${expired}`);
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
  return activeJobsCount();
}

export function throwEnqueueError(check: Extract<EnqueueCheckResult, { ok: false }>): never {
  throw appTrpcError("TOO_MANY_REQUESTS", check.code, check.message);
}

export { getVideoQueuePosition };
