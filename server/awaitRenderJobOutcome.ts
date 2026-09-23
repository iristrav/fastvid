/**
 * LOSING THE CLAIM IS NOT THE SAME AS THE RENDER FAILING — RONDE 633.
 *
 * ── Render 600, in milliseconds ─────────────────────────────────────────────────────────────
 *
 *     07:49:37.199  [RenderJob] video=600 job=19 route=cinematic_timeline queued
 *     07:49:37.260  [RenderJob] route=legacy_compose RENDER_FALLBACK_USED
 *                       reason=the render job worker claimed job 19 first
 *     07:49:37.260  [DeliveryGate] DELIVERY_GATE_FAIL video=600 AUTHORITATIVE_RENDER_FAILED
 *     07:49:37.443  [Video Generation] Error: Delivery blocked for video 600
 *     07:49:45.334  [RenderJob] job=19 status=running phase=rehydrating   ← the winner starts
 *     07:52:06      [DeliveryGate] DELIVERY_GATE_PASS … clips=4 checks=assets+file
 *     07:52:11      [RenderJob] job=19 status=completed published=true
 *
 * Sixty-one milliseconds between "job queued" and "the authoritative render did not deliver".
 * The film was fine. It was rendered, it passed the gate reading the real file, and it was
 * published — and the pipeline had already written the video off as failed, eight seconds before
 * the renderer took its first breath.
 *
 * ── The defect, stated exactly ──────────────────────────────────────────────────────────────
 *
 * `claimQueuedRenderJob` is a conditional UPDATE and exactly one caller wins it. Losing it is
 * handled correctly in one respect — this process must NOT render the job a second time, and it
 * does not. What was wrong is the sentence written down afterwards:
 *
 *     I did not produce the cinematic file   →   the cinematic file was not produced
 *
 * Those are different facts, and only the first one was measured. It is this session's signature
 * defect in its smallest form: an answer computed on one side of a race, handed to a decider
 * asking a different question.
 *
 * ── What this does instead ──────────────────────────────────────────────────────────────────
 *
 * Reads the row the winner is writing, until it reaches a state that settles the question, or
 * until the same in-process budget the claiming path already spends runs out. The job row is the
 * one place both processes agree, which is why the claim lives there too.
 *
 * Nothing here renders, retries, re-queues or touches the row: the whole module only reads. It
 * cannot produce two ffmpeg runs for one job, which is the property `claimQueuedRenderJob`'s
 * comment protects and the reason a waiter is safe where a second claim would not be.
 *
 * The budget still ends the wait, and ends it honestly: `STILL_RUNNING` is not a failure, it is
 * this render saying it stopped watching. The job keeps going and publishes on its own, exactly
 * as an over-budget claimed render already does.
 */

/** The four things the row can tell a waiter, each with the evidence for it. */
export type RenderJobWaitOutcome =
  | { kind: "DELIVERED"; outputUrl: string; waitedMs: number }
  | { kind: "FAILED"; code: string; message: string; waitedMs: number }
  /** Still queued or running when the budget ran out. Not a verdict on the render. */
  | { kind: "STILL_RUNNING"; status: string; waitedMs: number }
  /** The row is gone, or a completed job carries no file. Nothing can be concluded from it. */
  | { kind: "UNKNOWN"; detail: string; waitedMs: number };

/** Exactly the columns this decision reads. Injected so a test states a row, not a database. */
export type RenderJobRowForWait = {
  status: string;
  outputUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

/** Statuses the job will not move on from, so there is nothing left to wait for. */
export const TERMINAL_RENDER_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Watch a render job this process did not claim, for as long as it is worth waiting.
 *
 * `budgetMs <= 0` polls exactly once, so a caller with no budget still learns a job that already
 * finished — the 61 ms case above, where the answer was available immediately and never asked for.
 */
export async function awaitRenderJobOutcome(params: {
  jobId: number;
  /** The same in-process budget the claiming path spends. */
  budgetMs: number;
  /** How often the row is read. Kept well above the poll loop's own cadence. */
  pollEveryMs?: number;
  readJob: (jobId: number) => Promise<RenderJobRowForWait | null>;
  /** Called on every poll that did not settle it, so a long wait is visible and the watchdog fed. */
  onWaiting?: (info: { waitedMs: number; status: string }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RenderJobWaitOutcome> {
  const now = params.now ?? (() => Date.now());
  const sleep = params.sleep ?? sleepFor;
  const pollEveryMs = Math.max(250, params.pollEveryMs ?? 3_000);
  const startedAt = now();
  let lastStatus = "unknown";
  for (;;) {
    const waitedMs = now() - startedAt;
    let row: RenderJobRowForWait | null = null;
    try {
      row = await params.readJob(params.jobId);
    } catch (err) {
      /**
       * A read that threw says nothing about the render, so it does not end the wait — one
       * unreachable database moment must not be recorded as a failed film. The budget still ends
       * it, and the caller still falls back, with a reason that names what was actually observed.
       */
      lastStatus = `unreadable: ${(err as Error).message.slice(0, 80)}`;
      if (waitedMs >= params.budgetMs) {
        return { kind: "UNKNOWN", detail: lastStatus, waitedMs };
      }
      await sleep(pollEveryMs);
      continue;
    }
    if (!row) {
      return { kind: "UNKNOWN", detail: `no render job row for job=${params.jobId}`, waitedMs };
    }
    lastStatus = row.status;
    if (row.status === "completed") {
      return row.outputUrl
        ? { kind: "DELIVERED", outputUrl: row.outputUrl, waitedMs }
        : {
            kind: "UNKNOWN",
            detail: "the job completed and recorded no output file",
            waitedMs,
          };
    }
    if (TERMINAL_RENDER_JOB_STATUSES.has(row.status)) {
      return {
        kind: "FAILED",
        code: row.errorCode ?? row.status.toUpperCase(),
        message: row.errorMessage ?? `the render job ended ${row.status}`,
        waitedMs,
      };
    }
    if (waitedMs >= params.budgetMs) {
      return { kind: "STILL_RUNNING", status: row.status, waitedMs };
    }
    params.onWaiting?.({ waitedMs, status: row.status });
    await sleep(pollEveryMs);
  }
}

/** The one-line reason a caller writes down when the wait did not produce a file. */
export function formatRenderJobWait(jobId: number, outcome: RenderJobWaitOutcome): string {
  const waited = `${(outcome.waitedMs / 1000).toFixed(1)}s`;
  switch (outcome.kind) {
    case "DELIVERED":
      return `job=${jobId} DELIVERED_BY=render_job_worker after ${waited}`;
    case "FAILED":
      return `job=${jobId} the render job worker ran it and it failed after ${waited}: ${outcome.code} — ${outcome.message}`;
    case "STILL_RUNNING":
      return `job=${jobId} the render job worker is still ${outcome.status} after ${waited}, past this render's in-process budget — it will publish on its own`;
    case "UNKNOWN":
      return `job=${jobId} nothing could be established about the worker's run after ${waited}: ${outcome.detail}`;
  }
}
