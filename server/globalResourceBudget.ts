/**
 * RONDE 86 — one budget for the machine, not one per render.
 *
 * RONDE 83 bounded everything a SINGLE render does at once: ffmpegSemaphore (3, process-wide),
 * archiveDownloadLimit (5, module-global), graphicEncodeLimit, composeParallelism,
 * montageSegmentParallelism. The RONDE 82/85 audits confirmed those hold. What neither of them
 * bounded is what happens when two renders run at the same time: the scene, beat, compose and
 * funnel limiters are created per render, so two renders is two of each, and three is three.
 * The ffmpeg semaphore does not multiply — but the network fetches, the vision-gate calls and the
 * database traffic behind them do, and those are what a second concurrent render actually
 * saturates first.
 *
 * This module is the missing half: a small number of process-wide gates that every render shares,
 * plus an explicit MAX_CONCURRENT_RENDERS so the operator can say how many renders a box may run
 * rather than inferring it from a queue setting that was chosen for a different reason.
 *
 * Design rules, deliberately narrow:
 *  - Nothing here reduces what ONE render may do. A single render sees exactly the RONDE 83
 *    limits it has today; the gates below only bite once a second render is competing for them.
 *  - Everything is a QUEUE, never a drop. A render may wait for a slot; it must never be told no
 *    and lose a beat over it. p-limit runs every queued task, in order.
 *  - No length-dependence anywhere (RONDE 82's short/long parity rule): a 20-minute render and a
 *    1-minute render get the same per-operation budget, and the long one simply takes longer.
 */

import pLimit from "p-limit";
import { readQueueConfig } from "@shared/videoQueue";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * How many renders this process may have in flight at once.
 *
 * Defaults to the queue's own per-worker cap so nothing changes for an existing deployment: that
 * value is 1 unless MAX_JOBS_PER_WORKER is set, which is why renders have effectively serialised
 * on a single worker until now. Setting MAX_CONCURRENT_RENDERS makes the intent explicit and
 * lets it be lowered independently of the queue's job accounting.
 */
export function maxConcurrentRenders(): number {
  const explicit = process.env.MAX_CONCURRENT_RENDERS?.trim();
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (!isNaN(n) && n >= 1 && n <= 16) return n;
  }
  return Math.max(1, readQueueConfig().maxJobsPerWorker);
}

/**
 * Media downloads in flight across ALL renders.
 *
 * downloadToFileStreaming is the single choke point every provider path funnels through, so one
 * gate there bounds the whole process. Sized so a single render is unaffected: the per-render
 * fan-out that reaches this point is the beat limiter times a small per-beat candidate count,
 * which sits well under this on one render and would otherwise double with the second.
 * curatedMediaSourcing's archiveDownloadLimit(5) is a separate, narrower gate on the own-archive
 * path and stays exactly as RONDE 83 left it.
 */
export function globalMediaFetchConcurrency(): number {
  return envInt("GLOBAL_MEDIA_FETCH_LIMIT", 12, 1, 64);
}

/**
 * Vision-gate evaluations in flight across ALL renders.
 *
 * Each one is a CLIP/LLM call with its own timeout. Two renders fanning out independently is how
 * a provider's rate limit gets hit — render 533 logged 16 `Gemini API error 429` and 5
 * `groq 400 Bad Request` on ONE render, and the gate reports an unavailable judgement as a
 * refusal, so exceeding the limit does not merely slow the render down, it silently lowers the
 * quality of every verdict.
 */
export function globalVisionGateConcurrency(): number {
  return envInt("GLOBAL_VISION_GATE_LIMIT", 6, 1, 64);
}

const mediaFetchLimit = pLimit(globalMediaFetchConcurrency());
const visionGateLimit = pLimit(globalVisionGateConcurrency());
const renderSlots = pLimit(maxConcurrentRenders());

/** Queues a media download behind the process-wide fetch budget. */
export function withGlobalMediaFetch<T>(fn: () => Promise<T>): Promise<T> {
  return mediaFetchLimit(fn);
}

/** Queues a vision-gate evaluation behind the process-wide judgement budget. */
export function withGlobalVisionGate<T>(fn: () => Promise<T>): Promise<T> {
  return visionGateLimit(fn);
}

/** Runs a whole render inside a global render slot, waiting when the process is already full. */
export function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  return renderSlots(fn);
}

/** Live counters, for the tests and for the budget line logged at render start. */
export function globalBudgetSnapshot(): {
  maxConcurrentRenders: number;
  rendersActive: number;
  rendersQueued: number;
  mediaFetchLimit: number;
  mediaFetchActive: number;
  mediaFetchQueued: number;
  visionGateLimit: number;
  visionGateActive: number;
  visionGateQueued: number;
} {
  return {
    maxConcurrentRenders: maxConcurrentRenders(),
    rendersActive: renderSlots.activeCount,
    rendersQueued: renderSlots.pendingCount,
    mediaFetchLimit: globalMediaFetchConcurrency(),
    mediaFetchActive: mediaFetchLimit.activeCount,
    mediaFetchQueued: mediaFetchLimit.pendingCount,
    visionGateLimit: globalVisionGateConcurrency(),
    visionGateActive: visionGateLimit.activeCount,
    visionGateQueued: visionGateLimit.pendingCount,
  };
}

export function formatGlobalBudget(): string {
  const s = globalBudgetSnapshot();
  return (
    `[GlobalBudget] renders=${s.rendersActive}/${s.maxConcurrentRenders} (queued ${s.rendersQueued}) ` +
    `mediaFetch=${s.mediaFetchActive}/${s.mediaFetchLimit} (queued ${s.mediaFetchQueued}) ` +
    `visionGate=${s.visionGateActive}/${s.visionGateLimit} (queued ${s.visionGateQueued})`
  );
}
