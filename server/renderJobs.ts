/**
 * RONDE 148 §1/§2/§10 — the render job's rules, with no database and no ffmpeg in sight.
 *
 * ── Why the rules are here and not in the worker ──────────────────────────────────────────────
 *
 * The two decisions that can silently destroy someone's video are both one-liners:
 *
 *     "may this job publish its output?"
 *     "may a new job be created for this video?"
 *
 * Get the first wrong and a slow render that finished last overwrites a newer one; get the second
 * wrong and two workers render the same video into the same column. Neither needs a database to
 * decide and neither should be discovered by reading a worker loop, so both live here as pure
 * functions over plain values, and the worker calls them.
 *
 * ── The fencing rule, stated once ─────────────────────────────────────────────────────────────
 *
 * `videos.renderAttempt` is bumped every time a job is created, and each job records the value it
 * was given. A job may publish only while the two still match. That is the same token idiom
 * `generationAttempt` already uses for pipeline runs (§2 asked for the existing mechanism rather
 * than a new lock), and it has the property that matters: the check is against a value the NEWER
 * job already wrote, so a stale render discovers it has been superseded without anything having to
 * find it and stop it.
 *
 * A render is not cancelled by being superseded — it keeps running to completion and then declines
 * to publish. Killing it would be better for the machine and worse for the person, who might yet
 * want the older cut; the job row keeps its output URL either way, marked as not current.
 */

/* ═══════════════════════ status ═══════════════════════ */

export type RenderJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<RenderJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** A job in one of these is occupying the video: another render may not start (§7). */
export const ACTIVE_STATUSES: ReadonlySet<RenderJobStatus> = new Set(["queued", "running"]);

export function renderJobIsActive(status: RenderJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function renderJobIsTerminal(status: RenderJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Legal transitions. Everything not listed is refused rather than quietly allowed.
 *
 * `queued → cancelled` and `running → cancelled` are both legal because a person may give up at
 * either point. Nothing leaves a terminal status: a completed job that could go back to running
 * would make "which render produced this file" unanswerable.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RenderJobStatus, ReadonlyArray<RenderJobStatus>>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RenderJobStatus, to: RenderJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/* ═══════════════════════ §10 — progress that is not invented ═══════════════════════ */

/**
 * The phases a render actually goes through, in order.
 *
 * §10: "presenteer geen verzonnen 37%". ffmpeg's own progress output is not a trustworthy fraction
 * for this pipeline — a three-phase render (segments, concat, subtitles+audio) reports each pass
 * from zero, so a naive reading goes 0→100 three times. What IS true and checkable is how many of
 * these named phases are behind us, so that is the only number reported, and the phase NAME is what
 * the UI shows.
 */
export const RENDER_PHASES = [
  "queued",
  "rehydrating",
  /** RONDE 148 §4 — the cinematic planners run here when the flag is on. */
  "planning",
  "validating",
  "rendering",
  "uploading",
  "completed",
] as const;

export type RenderPhase = (typeof RENDER_PHASES)[number];

/** Percent of PHASES completed. A real fraction of a real list, never an ffmpeg guess. */
export function progressForPhase(phase: RenderPhase): number {
  const i = RENDER_PHASES.indexOf(phase);
  if (i < 0) return 0;
  return Math.round((i / (RENDER_PHASES.length - 1)) * 100);
}

/* ═══════════════════════ §22 — error codes ═══════════════════════ */

export const RENDER_ERROR = {
  VIDEO_NOT_FOUND: "VIDEO_NOT_FOUND",
  TIMELINE_NOT_FOUND: "TIMELINE_NOT_FOUND",
  TIMELINE_VERSION_CONFLICT: "TIMELINE_VERSION_CONFLICT",
  TIMELINE_INVALID: "TIMELINE_INVALID",
  RENDER_ALREADY_RUNNING: "RENDER_ALREADY_RUNNING",
  ASSET_NOT_REHYDRATABLE: "ASSET_NOT_REHYDRATABLE",
  RENDER_FAILED: "RENDER_FAILED",
  OUTPUT_UPLOAD_FAILED: "OUTPUT_UPLOAD_FAILED",
  /** The render finished but a newer one had already been started. Not a failure of this job. */
  RENDER_SUPERSEDED: "RENDER_SUPERSEDED",
} as const;

export type RenderErrorCode = (typeof RENDER_ERROR)[keyof typeof RENDER_ERROR];

/* ═══════════════════════ §2 — the fencing decision ═══════════════════════ */

export type PublishVerdict =
  | { publish: true }
  | { publish: false; code: RenderErrorCode; reason: string };

/**
 * May this finished render become the video's current output?
 *
 * The ONE question that decides whether a late render destroys a newer one. Deliberately a pure
 * function of two numbers so it can be tested exhaustively, and deliberately answered with a
 * reason so the job row records WHY an output was withheld rather than leaving an operator to
 * work out why a render "succeeded" and changed nothing.
 */
export function mayPublishRender(params: {
  jobAttempt: number;
  videoRenderAttempt: number;
}): PublishVerdict {
  const { jobAttempt, videoRenderAttempt } = params;
  if (jobAttempt === videoRenderAttempt) return { publish: true };
  /**
   * A job attempt ABOVE the video's is not "even fresher" — it means something is wrong. The video
   * row is the only writer of that counter and it writes it before the job exists, so a job that
   * claims a higher number was created against a row that has since been rolled back or reset.
   * Refusing is the safe answer to a state that should not occur.
   */
  if (jobAttempt > videoRenderAttempt) {
    return {
      publish: false,
      code: RENDER_ERROR.RENDER_SUPERSEDED,
      reason:
        `job attempt ${jobAttempt} is ahead of the video's ${videoRenderAttempt}; the counter ` +
        "only moves forward, so this job's row no longer matches the video it was made for",
    };
  }
  return {
    publish: false,
    code: RENDER_ERROR.RENDER_SUPERSEDED,
    reason:
      `a newer render was started for this video (attempt ${videoRenderAttempt}); this job ` +
      `rendered attempt ${jobAttempt} and will not overwrite it`,
  };
}

/* ═══════════════════════ §7 — the pre-flight decision ═══════════════════════ */

export type CreateVerdict =
  | { ok: true }
  | { ok: false; code: RenderErrorCode; reason: string };

/**
 * May a render be started for this video right now?
 *
 * "No other active render" is the whole rule. It is not a lock — two requests landing in the same
 * millisecond can both see zero, exactly as the existing enqueue check can (see videoQueue's note
 * on the same trade-off). The consequence here is bounded and self-correcting: the second job gets
 * the higher attempt number, so the first one declines to publish and the newer output wins, which
 * is the outcome the user wanted anyway. A transaction would buy a tidier job list and nothing else.
 */
export function mayCreateRenderJob(params: {
  activeJobs: ReadonlyArray<{ id: number; status: RenderJobStatus }>;
  timelineVersion: number;
  requestedVersion: number;
}): CreateVerdict {
  const active = params.activeJobs.filter((j) => renderJobIsActive(j.status));
  if (active.length > 0) {
    return {
      ok: false,
      code: RENDER_ERROR.RENDER_ALREADY_RUNNING,
      reason:
        `render job ${active[0]!.id} is already ${active[0]!.status} for this video — ` +
        "wait for it to finish or cancel it",
    };
  }
  /**
   * Rendering a version the server does not have is refused rather than reinterpreted as "the
   * latest". A client asking for version 7 when the server holds 8 has stale state, and quietly
   * rendering 8 would hand back a video of edits the person never saw.
   */
  if (params.requestedVersion !== params.timelineVersion) {
    return {
      ok: false,
      code: RENDER_ERROR.TIMELINE_VERSION_CONFLICT,
      reason:
        `asked to render timeline version ${params.requestedVersion} but the saved version is ` +
        `${params.timelineVersion} — reload the editor before rendering`,
    };
  }
  return { ok: true };
}

/* ═══════════════════════ §30 — observability ═══════════════════════ */

/**
 * One line per state change. Never the timeline, never the MP4, never a signed URL.
 *
 * The output is reported as a storage KEY-shaped tail rather than a full URL for the same reason
 * the rehydrator logs hosts: these lines get pasted into issues, and a presigned URL in a log is a
 * credential in a log.
 */
export function formatRenderJob(job: {
  id: number;
  videoId: number;
  timelineVersion: number;
  attempt: number;
  status: RenderJobStatus;
  progressStep?: string | null;
  outputUrl?: string | null;
  errorCode?: string | null;
}): string {
  const out = job.outputUrl ? job.outputUrl.split("?")[0]!.split("/").slice(-2).join("/") : "none";
  return (
    `[RenderJob] job=${job.id} video=${job.videoId} timelineVersion=${job.timelineVersion} ` +
    `attempt=${job.attempt} status=${job.status} phase=${job.progressStep ?? "-"} ` +
    `output=${out}` +
    (job.errorCode ? ` errorCode=${job.errorCode}` : "")
  );
}
