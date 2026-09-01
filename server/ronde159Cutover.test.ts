/**
 * R159 §24/§25/§26 — the cutover: a new video rendering from its own timeline.
 *
 * The thing worth testing here is not that a job gets queued — it is the SAFETY around that.
 * A cutover that queues a render without claiming an attempt, or that reports itself as the
 * cinematic route when it actually fell back, is worse than no cutover at all: it makes the
 * migration unmeasurable, which is exactly what §25 forbids.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cinematicPlanningEnabled,
  cinematicRenderPathEnabled,
  enqueueCinematicRender,
  formatRenderRoute,
} from "./cinematicProduction";

const ORIGINAL_ENGINE = process.env.CINEMATIC_EDITING_ENGINE;
const ORIGINAL_PATH = process.env.CINEMATIC_RENDER_PATH;

beforeEach(() => {
  process.env.CINEMATIC_EDITING_ENGINE = "true";
  process.env.CINEMATIC_RENDER_PATH = "true";
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("CINEMATIC_EDITING_ENGINE", ORIGINAL_ENGINE);
  restore("CINEMATIC_RENDER_PATH", ORIGINAL_PATH);
});

/** A queue that records what it was asked to do. */
function recordingQueue(opts: { attempt?: number | null; jobId?: number | null } = {}) {
  const claims: number[] = [];
  const jobs: Array<{ videoId: number; timelineVersion: number; attempt: number }> = [];
  return {
    claims,
    jobs,
    claimAttempt: async (videoId: number) => {
      claims.push(videoId);
      return opts.attempt === undefined ? 3 : opts.attempt;
    },
    createJob: async (p: { videoId: number; timelineVersion: number; attempt: number }) => {
      jobs.push(p);
      return opts.jobId === undefined ? { id: 91 } : opts.jobId == null ? null : { id: opts.jobId };
    },
  };
}

/* ═══════════════════════ §24 — the flag really routes ═══════════════════════ */

describe("R159 §24 — CINEMATIC_RENDER_PATH activates the new route", () => {
  it("queues a render job from the stored timeline", async () => {
    const q = recordingQueue();
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.renderJobId).toBe(91);
    expect(out.timelineVersion).toBe(4);
    expect(q.jobs).toEqual([{ videoId: 7, requestedByUserId: null, timelineVersion: 4, attempt: 3 }]);
  });

  /**
   * §22's fencing, applied to the new route. Without a claimed attempt a late render could
   * overwrite a newer one — and the cinematic route would be the single path where that can happen.
   */
  it("claims a render attempt BEFORE creating the job", async () => {
    const q = recordingQueue();
    await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(q.claims).toEqual([7]);
    expect(q.jobs[0]!.attempt).toBe(3);
  });

  it("does nothing at all when the flag is off, and says which flag", async () => {
    delete process.env.CINEMATIC_RENDER_PATH;
    const q = recordingQueue();
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("CINEMATIC_RENDER_PATH");
    // Nothing was claimed and nothing was queued.
    expect(q.claims).toEqual([]);
    expect(q.jobs).toEqual([]);
  });

  /** A video already rendering must not get a second job. The claim is what says so. */
  it("does not queue when the attempt cannot be claimed", async () => {
    const q = recordingQueue({ attempt: null });
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("claim");
    expect(q.jobs).toEqual([]);
  });

  it("reports a job that could not be created rather than claiming success", async () => {
    const q = recordingQueue({ jobId: null });
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("could not be created");
  });

  it("logs the job, the attempt and the route", async () => {
    const q = recordingQueue();
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    const log = out.log.join(" ");
    expect(log).toContain("[RenderJob]");
    expect(log).toContain("route=cinematic_timeline");
    expect(log).toContain("attempt=3");
    expect(log).toContain("timelineVersion=4");
  });

  it("carries the requesting user through when there is one", async () => {
    const q = recordingQueue();
    await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      requestedByUserId: 42,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(q.jobs[0]).toMatchObject({ requestedByUserId: 42 });
  });
});

/* ═══════════════════════ §25 — the fallback is never hidden ═══════════════════════ */

describe("R159 §25 — PRIMARY and FALLBACK are always distinguishable", () => {
  it("planning and rendering are separate switches", () => {
    process.env.CINEMATIC_EDITING_ENGINE = "true";
    delete process.env.CINEMATIC_RENDER_PATH;
    expect(cinematicPlanningEnabled()).toBe(true);
    expect(cinematicRenderPathEnabled()).toBe(false);
  });

  it("a legacy render always carries RENDER_FALLBACK_USED and a reason", () => {
    const flagOff = formatRenderRoute({ videoId: 3, route: "legacy_compose", planOk: true });
    expect(flagOff).toContain("RENDER_FALLBACK_USED");
    expect(flagOff).toContain("reason=");
  });

  /**
   * The specific failure this test guards. When the flag is ON but the queue refused the job, the
   * video is still delivered by compose — and reporting `route=cinematic_timeline` because the FLAG
   * was on would make the migration look complete while every video still came from the old path.
   */
  it("does NOT claim the cinematic route when the job was not actually queued", async () => {
    const q = recordingQueue({ attempt: null });
    const cutover = await enqueueCinematicRender({
      videoId: 3,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(cutover.ok).toBe(false);

    // This mirrors what videoPipeline does with the result.
    const line = formatRenderRoute({
      videoId: 3,
      route: cutover.ok ? "cinematic_timeline" : "legacy_compose",
      planOk: true,
      reason: cutover.ok ? undefined : cutover.reason,
    });
    expect(line).toContain("legacy_compose");
    expect(line).toContain("RENDER_FALLBACK_USED");
  });

  it("a genuine cinematic render says so and carries no fallback marker", () => {
    const line = formatRenderRoute({ videoId: 3, route: "cinematic_timeline", planOk: true });
    expect(line).toContain("route=cinematic_timeline");
    expect(line).not.toContain("RENDER_FALLBACK_USED");
  });

  it("no route line leaks a URL or a path", () => {
    for (const route of ["cinematic_timeline", "legacy_compose"] as const) {
      const line = formatRenderRoute({ videoId: 3, route, planOk: false, reason: "x" });
      expect(line).not.toMatch(/https?:/);
      expect(line).not.toContain("/tmp/");
    }
  });
});

/* ═══════════════════════ §26 — one timeline, one renderer ═══════════════════════ */

describe("R159 §26 — the new route uses the SAME renderer as a hand edit", () => {
  /**
   * Stated as a structural fact rather than a behavioural one: `enqueueCinematicRender` has no
   * render code in it at all. It claims an attempt and creates a job row, and the existing worker
   * does the rest — the same worker an editor-triggered render uses.
   *
   * If somebody ever added a second render path here, this test would still pass — so it is backed
   * by the module-shape assertion below, which would not.
   */
  it("queues a job and renders nothing itself", async () => {
    const q = recordingQueue();
    const out = await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 4,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    expect(out.ok).toBe(true);
    // One claim, one job, no other side effect the caller can observe.
    expect(q.claims).toHaveLength(1);
    expect(q.jobs).toHaveLength(1);
  });

  it("cinematicProduction imports no renderer — the job worker owns rendering", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/cinematicProduction.ts", "utf8");

    /**
     * The assertion is about IMPORTS, not about the words in the file.
     *
     * An earlier version of this test searched the whole source for "ffmpeg" and failed on the
     * module's own comment explaining what the WORKER does — which is documentation the file
     * should have. What §44 actually forbids is this module reaching for a renderer, and that is
     * visible in its import statements and nowhere else.
     */
    const imports = source
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /await import\(/.test(l))
      .join("\n");

    for (const forbidden of [
      "timelineRenderer",
      "remotionRenderer",
      "graphicsOverlayDeps",
      "child_process",
      "ffmpegBinary",
    ]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });

  it("the job it queues names a TIMELINE VERSION, not a set of render instructions", async () => {
    const q = recordingQueue();
    await enqueueCinematicRender({
      videoId: 7,
      timelineVersion: 12,
      claimAttempt: q.claimAttempt,
      createJob: q.createJob,
    });
    // The worker re-reads the timeline at that version. Nothing about HOW to render travels here.
    expect(Object.keys(q.jobs[0]!).sort()).toEqual(
      ["attempt", "requestedByUserId", "timelineVersion", "videoId"].sort()
    );
  });
});
