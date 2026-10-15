/**
 * G/H — THE RECOVERY COORDINATOR: A TECHNICAL RENDER FAILURE IS RETRIED AS A RENDER, NOT AS A WHOLE FILM.
 *
 * What already recovers (and is reused, not duplicated):
 *   · a pipeline that stops making progress   → `failPipelineIfStalled` re-queues it, bounded
 *   · a worker stopped by a deploy or restart → `requeueInterruptedVideo`, same allowance
 *   · a render job whose worker vanished      → `sweepStaleRunningRenderJobs` fails it (no heartbeat)
 *   · an encode that fails its own file check → ONE plain-cut retry inside `runRenderJob`
 *
 * What was missing: after a render job FAILED for a technical reason, the film stayed failed although
 * its timeline — every picture chosen, checked and stored — was intact. Re-running the pipeline would
 * search, judge and download again (the paid part). This coordinator re-renders the STORED timeline
 * instead: the same `enqueueCinematicRender` route, the same worker, the same delivery gate with the
 * same strict picture checks. Nothing is searched, judged or bought again.
 *
 * Bounded and single:
 *   · at most `RENDER_RECOVERY_MAX` render-only retries per video, counted in `videos.metadata`;
 *   · never while a render of the video is queued or running, never for a superseded job;
 *   · the render attempt is claimed only if it is still the failed job's attempt
 *     (`claimRenderAttemptIfCurrent`), so two workers sweeping at once start one render, not two;
 *   · only a TECHNICAL failure is retried. A delivery refused for what the pictures show (an
 *     unchecked picture, a black picture) is not a render fault: a retry would make the same film,
 *     so it is recorded as NEEDS_HUMAN at once.
 *
 * Every step is written to the log and to `videos.metadata.renderRecovery`: the original fault, the
 * action, the result, the attempts left, and the final state — recovered, failed, or needs a person.
 * A video becomes `completed` here only when its recovery render job completed, passed the delivery
 * gate (the worker refuses otherwise), was uploaded and was published as the current edit.
 */
import { RENDER_ERROR } from "./renderJobs";

export const RENDER_RECOVERY_MAX = 2;
/** Failures older than this are history, not a recovery to start now. */
export const RENDER_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type RecoveryJob = {
  id: number;
  videoId: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  timelineVersion: number;
  attempt: number;
  requestedByUserId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  outputUrl: string | null;
  updatedAt?: Date | string | null;
};

export type RecoveryVideo = { id: number; status: string; renderAttempt: number | null; videoUrl: string | null; metadata?: unknown };

export type RecoveryLogEntry = { at: string; jobId: number; fault: string; action: string; result: string; remaining: number };
export type RenderRecoveryState = {
  attempts: number;
  jobIds: number[];
  log: RecoveryLogEntry[];
  final?: "recovered" | "failed" | "needs_human";
};

export type FailureClass = "technical" | "content" | "permanent";

/** Delivery-gate refusals about what the pictures show: a second render makes the same film. */
const CONTENT_BLOCKS = /\b(PICTURE_NOT_CHECKED|SENTENCE_WITHOUT_CHECKED_PICTURE|FINAL_PICTURE_IS_BLACK|TIMELINE_MISSING|FALLBACK_SHARE_TOO_HIGH)\b/;

export function classifyRenderFailure(errorCode: string | null, errorMessage: string | null): FailureClass {
  const code = errorCode ?? "";
  const msg = errorMessage ?? "";
  if (
    code === RENDER_ERROR.VIDEO_NOT_FOUND ||
    code === RENDER_ERROR.TIMELINE_NOT_FOUND ||
    code === RENDER_ERROR.TIMELINE_INVALID ||
    code === RENDER_ERROR.TIMELINE_VERSION_CONFLICT ||
    code === RENDER_ERROR.RENDER_SUPERSEDED ||
    code === RENDER_ERROR.RENDER_ALREADY_RUNNING
  ) {
    return "permanent";
  }
  if (/^Delivery blocked\b/.test(msg) && CONTENT_BLOCKS.test(msg)) return "content";
  return "technical";
}

export function readRecoveryState(metadata: unknown): RenderRecoveryState {
  const m = (metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}).renderRecovery as Partial<RenderRecoveryState> | undefined;
  return {
    attempts: typeof m?.attempts === "number" ? m.attempts : 0,
    jobIds: Array.isArray(m?.jobIds) ? m!.jobIds!.filter((n): n is number => typeof n === "number") : [],
    log: Array.isArray(m?.log) ? (m!.log as RecoveryLogEntry[]) : [],
    ...(m?.final ? { final: m.final } : {}),
  };
}

export type RecoveryPlan =
  | { kind: "none"; reason: string }
  | { kind: "retry_render"; failedJob: RecoveryJob; fault: string; remainingAfter: number }
  | { kind: "give_up"; failedJob: RecoveryJob; final: "failed" | "needs_human"; fault: string; reason: string }
  | { kind: "mark_recovered"; job: RecoveryJob };

/**
 * What to do for one video, from its newest render jobs (newest first). Pure.
 *
 * Only pipeline renders (no requesting user) — an editor render is the owner's own action and stays
 * theirs. Only when the video is not completed and its pipeline has finished (`failed`), so the
 * pipeline's own handling always comes first.
 */
export function planRenderRecovery(params: {
  video: RecoveryVideo;
  jobs: readonly RecoveryJob[];
  timelineStored: (version: number) => boolean;
  now?: number;
}): RecoveryPlan {
  const { video, jobs } = params;
  const now = params.now ?? Date.now();
  const state = readRecoveryState(video.metadata);
  const latest = jobs.find((j) => j.requestedByUserId == null);
  if (!latest) return { kind: "none", reason: "no pipeline render job" };

  /* A recovery render that delivered: the film is recovered. */
  if (latest.status === "completed" && state.jobIds.includes(latest.id) && video.status !== "completed") {
    if (latest.outputUrl && !latest.errorCode) return { kind: "mark_recovered", job: latest };
    return { kind: "none", reason: `recovery job ${latest.id} completed without publishing (${latest.errorCode ?? "no output"})` };
  }
  if (video.status === "completed") return { kind: "none", reason: "the video is delivered" };
  if (state.final) return { kind: "none", reason: `recovery already ended: ${state.final}` };
  if (jobs.some((j) => j.status === "queued" || j.status === "running")) return { kind: "none", reason: "a render is queued or running" };
  if (latest.status !== "failed") return { kind: "none", reason: `latest pipeline render is ${latest.status}` };
  /** A failed recovery render is this coordinator's own; any other failed render waits for the pipeline to end. */
  const recoveryOwns = state.jobIds.includes(latest.id);
  if (!recoveryOwns && video.status !== "failed") return { kind: "none", reason: `the pipeline still owns the video (status ${video.status})` };
  const at = latest.updatedAt ? new Date(latest.updatedAt).getTime() : now;
  if (now - at > RENDER_RECOVERY_WINDOW_MS) return { kind: "none", reason: "the failure is older than the recovery window" };
  if (video.renderAttempt != null && latest.attempt !== video.renderAttempt) {
    return { kind: "none", reason: "a newer render attempt exists (the failed job is superseded)" };
  }

  const fault = `${latest.errorCode ?? "?"}: ${(latest.errorMessage ?? "").slice(0, 200)}`;
  const kind = classifyRenderFailure(latest.errorCode, latest.errorMessage);
  if (kind === "content") {
    return { kind: "give_up", failedJob: latest, final: "needs_human", fault, reason: "refused for what the pictures show; a re-render would make the same film" };
  }
  if (kind === "permanent") {
    return { kind: "give_up", failedJob: latest, final: "needs_human", fault, reason: "the render cannot be repeated as it is (timeline or video missing or invalid)" };
  }
  if (!params.timelineStored(latest.timelineVersion)) {
    return { kind: "give_up", failedJob: latest, final: "needs_human", fault, reason: `timeline version ${latest.timelineVersion} is not stored` };
  }
  if (state.attempts >= RENDER_RECOVERY_MAX) {
    return { kind: "give_up", failedJob: latest, final: "failed", fault, reason: `${RENDER_RECOVERY_MAX} render-only recoveries used` };
  }
  return { kind: "retry_render", failedJob: latest, fault, remainingAfter: RENDER_RECOVERY_MAX - state.attempts - 1 };
}

export type RecoveryDeps = {
  listVideosWithFailedPipelineRenders: (since: Date) => Promise<number[]>;
  getVideo: (id: number) => Promise<RecoveryVideo | null>;
  listJobs: (videoId: number) => Promise<RecoveryJob[]>;
  timelineStored: (videoId: number, version: number) => Promise<boolean>;
  /** Claims the next render attempt ONLY if the video is still at `expected`; null when another worker moved it. */
  claimAttemptIfCurrent: (videoId: number, expected: number) => Promise<number | null>;
  createJob: (p: { videoId: number; timelineVersion: number; attempt: number }) => Promise<{ id: number } | null>;
  saveState: (videoId: number, state: RenderRecoveryState) => Promise<void>;
  setVideo: (videoId: number, status: "completed" | "failed" | "generating_effects", extra: { videoUrl?: string; errorMessage?: string; progressStep: string }) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
};

/** One sweep over the recently failed pipeline renders. Returns what it did per video. */
export async function runRenderRecoverySweep(deps: RecoveryDeps): Promise<Array<{ videoId: number; plan: RecoveryPlan["kind"]; detail: string }>> {
  const now = deps.now?.() ?? Date.now();
  const out: Array<{ videoId: number; plan: RecoveryPlan["kind"]; detail: string }> = [];
  const ids = await deps.listVideosWithFailedPipelineRenders(new Date(now - RENDER_RECOVERY_WINDOW_MS));
  for (const videoId of ids) {
    try {
      const video = await deps.getVideo(videoId);
      if (!video) continue;
      const jobs = await deps.listJobs(videoId);
      const versions = new Map<number, boolean>();
      for (const j of jobs) if (!versions.has(j.timelineVersion)) versions.set(j.timelineVersion, await deps.timelineStored(videoId, j.timelineVersion));
      const plan = planRenderRecovery({ video, jobs, timelineStored: (v) => versions.get(v) ?? false, now });
      const state = readRecoveryState(video.metadata);
      const stamp = new Date(now).toISOString();
      if (plan.kind === "none") {
        out.push({ videoId, plan: plan.kind, detail: plan.reason });
        continue;
      }
      if (plan.kind === "mark_recovered") {
        await deps.setVideo(videoId, "completed", { videoUrl: plan.job.outputUrl!, progressStep: "Video complete! (recovered by a render-only retry)" });
        const next: RenderRecoveryState = {
          ...state,
          final: "recovered",
          log: [...state.log, { at: stamp, jobId: plan.job.id, fault: "-", action: "mark_delivered", result: "recovered", remaining: RENDER_RECOVERY_MAX - state.attempts }],
        };
        await deps.saveState(videoId, next);
        deps.log(`[Recovery] video=${videoId} job=${plan.job.id} RECOVERED — the render-only retry passed the delivery gate and was published`);
        out.push({ videoId, plan: plan.kind, detail: `job ${plan.job.id}` });
        continue;
      }
      if (plan.kind === "give_up") {
        const message = `${plan.final === "needs_human" ? "NEEDS_HUMAN_ACTION" : "RECOVERY_EXHAUSTED"}: ${plan.reason} — last fault ${plan.fault}`;
        await deps.setVideo(videoId, "failed", { errorMessage: message.slice(0, 900), progressStep: plan.final === "needs_human" ? "Blocked — needs a person" : "Failed — recovery attempts used" });
        await deps.saveState(videoId, {
          ...state,
          final: plan.final,
          log: [...state.log, { at: stamp, jobId: plan.failedJob.id, fault: plan.fault, action: "give_up", result: plan.final, remaining: Math.max(0, RENDER_RECOVERY_MAX - state.attempts) }],
        });
        deps.log(`[Recovery] video=${videoId} job=${plan.failedJob.id} ${plan.final.toUpperCase()} — ${plan.reason}; fault ${plan.fault}`);
        out.push({ videoId, plan: plan.kind, detail: plan.final });
        continue;
      }
      /* retry_render — claim the attempt first: of two sweeps only one gets it. */
      const attempt = await deps.claimAttemptIfCurrent(videoId, plan.failedJob.attempt);
      if (attempt == null) {
        out.push({ videoId, plan: "none", detail: "another worker claimed the attempt" });
        continue;
      }
      const job = await deps.createJob({ videoId, timelineVersion: plan.failedJob.timelineVersion, attempt });
      const result = job ? `render job ${job.id} queued` : "the render job could not be created";
      const next: RenderRecoveryState = {
        attempts: state.attempts + 1,
        jobIds: job ? [...state.jobIds, job.id] : state.jobIds,
        log: [...state.log, { at: stamp, jobId: plan.failedJob.id, fault: plan.fault, action: "retry_render_only", result, remaining: plan.remainingAfter }],
      };
      await deps.saveState(videoId, next);
      if (job) {
        await deps.setVideo(videoId, "generating_effects", { progressStep: `Recovering: render again (${next.attempts}/${RENDER_RECOVERY_MAX})` });
      }
      deps.log(
        `[Recovery] video=${videoId} fault="${plan.fault}" action=render_only_retry timelineVersion=${plan.failedJob.timelineVersion} ` +
          `result="${result}" attempt=${next.attempts}/${RENDER_RECOVERY_MAX} remaining=${plan.remainingAfter}`
      );
      out.push({ videoId, plan: plan.kind, detail: result });
    } catch (err) {
      deps.log(`[Recovery] video=${videoId} sweep error: ${(err as Error)?.message?.slice(0, 160)}`);
    }
  }
  return out;
}

/** The production wiring: the existing tables, the existing enqueue route, nothing new. */
export async function productionRecoveryDeps(): Promise<RecoveryDeps> {
  const db = await import("./db");
  return {
    listVideosWithFailedPipelineRenders: (since) => db.listVideosWithFailedPipelineRenders(since),
    getVideo: async (id) => {
      const v = await db.getVideoById(id);
      return v ? { id: v.id, status: v.status, renderAttempt: v.renderAttempt ?? null, videoUrl: v.videoUrl ?? null, metadata: v.metadata } : null;
    },
    listJobs: async (videoId) =>
      (await db.listRenderJobsForVideo(videoId, 10)).map((j) => ({
        id: j.id,
        videoId: j.videoId,
        status: j.status,
        timelineVersion: j.timelineVersion,
        attempt: j.attempt,
        requestedByUserId: j.requestedByUserId ?? null,
        errorCode: j.errorCode ?? null,
        errorMessage: j.errorMessage ?? null,
        outputUrl: j.outputUrl ?? null,
        updatedAt: j.updatedAt,
      })),
    /** Only the video's CURRENT stored timeline can be rendered again: an older version is history. */
    timelineStored: async (videoId, version) => {
      const stored = await db.getStoredTimeline(videoId);
      return Boolean(stored && stored.raw != null && stored.timelineVersion === version);
    },
    claimAttemptIfCurrent: (videoId, expected) => db.claimRenderAttemptIfCurrent(videoId, expected),
    createJob: (p) => db.createRenderJob({ videoId: p.videoId, requestedByUserId: null, timelineVersion: p.timelineVersion, attempt: p.attempt }),
    saveState: (videoId, state) => db.mergeVideoMetadata(videoId, { renderRecovery: state }),
    setVideo: (videoId, status, extra) =>
      db.updateVideoStatus(videoId, status, {
        ...(extra.videoUrl ? { videoUrl: extra.videoUrl } : {}),
        ...(extra.errorMessage != null ? { errorMessage: extra.errorMessage } : status === "completed" ? { errorMessage: "" } : {}),
        progressStep: extra.progressStep,
        ...(status === "completed" ? { progressPercent: 100 } : {}),
      }),
    log: (line) => console.log(line),
  };
}
