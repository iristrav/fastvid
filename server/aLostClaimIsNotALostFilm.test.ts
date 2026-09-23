/**
 * A LOST CLAIM IS NOT A LOST FILM — RONDE 633.
 *
 * ── Render 600, in milliseconds ─────────────────────────────────────────────────────────────
 *
 *     07:49:37.199  [RenderJob] video=600 job=19 route=cinematic_timeline queued
 *     07:49:37.260  [RenderJob] route=legacy_compose RENDER_FALLBACK_USED
 *                       reason=the render job worker claimed job 19 first
 *     07:49:37.260  [DeliveryGate] DELIVERY_GATE_FAIL video=600 AUTHORITATIVE_RENDER_FAILED
 *     07:49:45.334  [RenderJob] job=19 status=running phase=rehydrating   ← the winner starts
 *     07:52:06      [DeliveryGate] DELIVERY_GATE_PASS … clips=4 checks=assets+file
 *     07:52:11      [RenderJob] job=19 status=completed published=true
 *
 * Sixty-one milliseconds, and eight seconds before the renderer took its first breath. The film
 * was rendered, it passed the gate that read the real file, and it was published. The pipeline had
 * already recorded the video as failed.
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────
 *
 *     I did not produce the cinematic file   →   the cinematic file was not produced
 *
 * Only the first was measured. This session's signature defect at its smallest: an answer computed
 * on one side of a race, handed to a decider asking a different question.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * The mutual exclusion. `claimQueuedRenderJob`'s comment is emphatic that a claim which cannot be
 * proven is not a claim, and that two ffmpeg runs for one row cost more than a missed render. The
 * waiter never claims, never re-queues and never writes: it reads the row the winner is writing,
 * which is the one place both processes already agree.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  awaitRenderJobOutcome,
  formatRenderJobWait,
  TERMINAL_RENDER_JOB_STATUSES,
  type RenderJobRowForWait,
} from "./awaitRenderJobOutcome";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const WAIT = readFileSync(join(__dirname, "awaitRenderJobOutcome.ts"), "utf8");

const row = (over: Partial<RenderJobRowForWait>): RenderJobRowForWait => ({
  status: "queued",
  outputUrl: null,
  errorCode: null,
  errorMessage: null,
  ...over,
});

/**
 * A clock and a sleeper that advance together, so a test states a schedule rather than spending
 * one. Nothing here waits on real time.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Rows served in order; the last one repeats forever. */
const rowsInOrder = (rows: Array<RenderJobRowForWait | null>) => {
  let i = 0;
  return async () => rows[Math.min(i++, rows.length - 1)];
};

/* ═══════════ §1 — render 600's exact case ═══════════ */

describe("§1 — the answer was available and was never asked for", () => {
  it("A JOB THAT ALREADY FINISHED IS READ, EVEN WITH NO BUDGET AT ALL", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 0,
      readJob: async () => row({ status: "completed", outputUrl: "edits/render_19.mp4" }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out).toEqual({ kind: "DELIVERED", outputUrl: "edits/render_19.mp4", waitedMs: 0 });
  });

  it("and a job the worker has not started yet is waited for, not written off", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 600_000,
      pollEveryMs: 3_000,
      readJob: rowsInOrder([
        row({ status: "queued" }),
        row({ status: "running" }),
        row({ status: "running" }),
        row({ status: "completed", outputUrl: "edits/render_19_fef820f3.mp4" }),
      ]),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("DELIVERED");
    expect(out.kind === "DELIVERED" && out.outputUrl).toBe("edits/render_19_fef820f3.mp4");
  });
});

/* ═══════════ §2 — a real failure is still a failure ═══════════ */

describe("§2 — the wait does not turn a failed render into a good one", () => {
  it("A FAILED JOB REPORTS ITS OWN CODE AND MESSAGE", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      readJob: async () =>
        row({ status: "failed", errorCode: "FILTER_GRAPH", errorMessage: "seg_010 is odd" }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("FAILED");
    expect(out.kind === "FAILED" && out.code).toBe("FILTER_GRAPH");
    expect(out.kind === "FAILED" && out.message).toBe("seg_010 is odd");
  });

  it("a cancelled job is terminal too, and says so rather than waiting forever", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      readJob: async () => row({ status: "cancelled" }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("FAILED");
    expect(out.kind === "FAILED" && out.code).toBe("CANCELLED");
  });

  it("A COMPLETED JOB WITH NO FILE IS NOT A DELIVERY", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      readJob: async () => row({ status: "completed", outputUrl: null }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("UNKNOWN");
    expect(out.kind === "UNKNOWN" && out.detail).toContain("no output file");
  });

  it("and the terminal set is exactly the three statuses a job does not move on from", () => {
    expect([...TERMINAL_RENDER_JOB_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
    ]);
    expect(TERMINAL_RENDER_JOB_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_RENDER_JOB_STATUSES.has("queued")).toBe(false);
  });
});

/* ═══════════ §3 — the budget ends the wait, honestly ═══════════ */

describe("§3 — stopping watching is not a verdict on the render", () => {
  it("A RENDER STILL RUNNING AT THE BUDGET IS STILL_RUNNING, NOT FAILED", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 9_000,
      pollEveryMs: 3_000,
      readJob: async () => row({ status: "running" }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("STILL_RUNNING");
    expect(out.kind === "STILL_RUNNING" && out.status).toBe("running");
    expect(out.waitedMs).toBeGreaterThanOrEqual(9_000);
  });

  it("and it says the job will publish on its own rather than claiming it died", () => {
    const line = formatRenderJobWait(19, {
      kind: "STILL_RUNNING",
      status: "running",
      waitedMs: 600_000,
    });
    expect(line).toContain("still running");
    expect(line).toContain("publish on its own");
    expect(line).not.toContain("failed");
  });

  it("a missing row settles nothing and says so", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      readJob: async () => null,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("UNKNOWN");
  });
});

/* ═══════════ §4 — one bad read is not a bad film ═══════════ */

describe("§4 — an unreadable row does not end the wait", () => {
  it("A READ THAT THREW IS RETRIED, AND A LATER GOOD READ SETTLES IT", async () => {
    const clock = fakeClock();
    let call = 0;
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      pollEveryMs: 3_000,
      readJob: async () => {
        call++;
        if (call <= 2) throw new Error("connection reset");
        return row({ status: "completed", outputUrl: "edits/render_19.mp4" });
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("DELIVERED");
    expect(call).toBe(3);
  });

  it("but a database that never answers ends as UNKNOWN, never as a failed render", async () => {
    const clock = fakeClock();
    const out = await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 6_000,
      pollEveryMs: 3_000,
      readJob: async () => {
        throw new Error("connection reset");
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.kind).toBe("UNKNOWN");
    expect(out.kind === "UNKNOWN" && out.detail).toContain("connection reset");
  });
});

/* ═══════════ §5 — the watchdog is fed while the wait runs ═══════════ */

describe("§5 — a long wait is visible and does not look like a hang", () => {
  it("EVERY UNSETTLED POLL REPORTS, SO THE WATCHDOG IS PINGED", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 9_000,
      pollEveryMs: 3_000,
      readJob: rowsInOrder([
        row({ status: "queued" }),
        row({ status: "running" }),
        row({ status: "running" }),
        row({ status: "completed", outputUrl: "x.mp4" }),
      ]),
      onWaiting: ({ status }) => seen.push(status),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(seen).toEqual(["queued", "running", "running"]);
  });

  it("and a settled first poll reports nothing — there was nothing to wait for", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    await awaitRenderJobOutcome({
      jobId: 19,
      budgetMs: 60_000,
      readJob: async () => row({ status: "completed", outputUrl: "x.mp4" }),
      onWaiting: ({ status }) => seen.push(status),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(seen).toEqual([]);
  });
});

/* ═══════════ §6 — the mutual exclusion is untouched ═══════════ */

describe("§6 — the waiter reads and does nothing else", () => {
  it("IT NEVER CLAIMS, RE-QUEUES OR WRITES THE ROW", () => {
    /* The prose explains what it does not do, so the check is on the code that runs. */
    const code = WAIT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "claimQueuedRenderJob",
      "createRenderJob",
      "runRenderJob",
      "update(",
      "insert(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    /* And it reaches nothing on its own: every fact it uses is handed to it. */
    expect(code).not.toContain("import ");
  });

  it("and the pipeline still claims before it ever renders", () => {
    expect(PIPE).toContain("const claimed = await claimQueuedRenderJob(cutover.renderJobId);");
  });
});

/* ═══════════ §7 — the wiring, and the sentence that is gone ═══════════ */

describe("§7 — the pipeline asks whether it was rendered, not whether it rendered it", () => {
  it("THE SENTENCE THAT WROTE OFF RENDER 600 IS GONE", () => {
    expect(PIPE).not.toContain('"did not produce the cinematic file"');
    expect(PIPE).not.toContain(
      "`the render job worker claimed job ${cutover.renderJobId} first, so this render `"
    );
  });

  it("the lost claim now waits on the job the winner is running", () => {
    expect(PIPE).toContain("const waited = await awaitRenderJobOutcome({");
    expect(PIPE).toContain("readJob: (id) => getRenderJobById(id),");
    expect(PIPE).toContain("budgetMs: waitBudgetMs,");
  });

  it("and the worker's file becomes the delivered file, which is the whole point", () => {
    const at = PIPE.indexOf('if (waited.kind === "DELIVERED") {');
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 2500);
    expect(block).toContain("cinematicDeliveredUrl = waited.outputUrl;");
    expect(block).toContain("cinematicProgress.rendered = true;");
  });

  it("anything else is still a refusal, with the reason the row gave", () => {
    expect(PIPE).toContain(
      "cinematicRefusal = formatRenderJobWait(cutover.renderJobId, waited);"
    );
  });

  it("the same in-process budget the claiming path spends bounds the wait", () => {
    expect(PIPE).toContain("const waitBudgetMs = inProcessCinematicRenderBudgetMs();");
  });
});

/* ═══════════ §8 — no figure describes a file it never saw ═══════════ */

describe("§8 — what the report says after a delivery this process did not measure", () => {
  it("THE COMPOSE MONTAGE'S BLACK-FRAME VERDICT IS NOT LEFT STANDING", () => {
    const at = PIPE.indexOf('if (waited.kind === "DELIVERED") {');
    const block = PIPE.slice(at, at + 2500);
    expect(block).toContain("delete qualityReport.postRenderSpotCheck;");
  });

  it("and every figure that CAN be qualified names the file it measured", () => {
    const at = PIPE.indexOf('if (waited.kind === "DELIVERED") {');
    const block = PIPE.slice(at, at + 2500);
    expect(block).toContain('qualityReport.avSync.measuredOn = "compose_montage"');
    expect(block).toContain('qualityReport.stillness.measuredOn = "compose_montage"');
    expect(block).toContain('qualityReport.repeats.measuredOn = "compose_montage"');
    expect(block).toContain("qualityReport.warnings.push(");
  });
});
