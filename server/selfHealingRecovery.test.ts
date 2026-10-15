/**
 * G/H — SELF-HEALING: A TECHNICAL RENDER FAILURE IS RETRIED AS A RENDER, BOUNDED, ONCE PER WORKER RACE,
 * AND NEVER AROUND A CHECK.
 *
 * The coordinator (`recoveryCoordinator.ts`) re-renders a pipeline film's STORED timeline after a
 * technical render failure: no search, no judge, no download, no paid call. These tests drive its
 * plan and its sweep against an in-memory stand-in of the two tables it reads (videos, render_jobs).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyRenderFailure,
  planRenderRecovery,
  readRecoveryState,
  RENDER_RECOVERY_MAX,
  RENDER_RECOVERY_WINDOW_MS,
  runRenderRecoverySweep,
  type RecoveryDeps,
  type RecoveryJob,
  type RecoveryVideo,
} from "./recoveryCoordinator";

const NOW = Date.parse("2026-10-15T14:00:00Z");
const job = (over: Partial<RecoveryJob> = {}): RecoveryJob => ({
  id: 66,
  videoId: 659,
  status: "failed",
  timelineVersion: 4,
  attempt: 3,
  requestedByUserId: null,
  errorCode: "RENDER_FAILED",
  errorMessage: "the worker rendering this job stopped reporting 17 min ago (no heartbeat): it was lost to a restart",
  outputUrl: null,
  updatedAt: new Date(NOW - 5 * 60_000),
  ...over,
});
const video = (over: Partial<RecoveryVideo> = {}): RecoveryVideo => ({ id: 659, status: "failed", renderAttempt: 3, videoUrl: null, metadata: {}, ...over });
const plan = (v: RecoveryVideo, jobs: RecoveryJob[], stored = true) => planRenderRecovery({ video: v, jobs, timelineStored: () => stored, now: NOW });

describe("G/H — which failures are retried as a render", () => {
  it("technical: a lost worker, a render that threw, a failed upload, a wrong-length file", () => {
    expect(classifyRenderFailure("RENDER_FAILED", "the worker rendering this job stopped reporting 17 min ago (no heartbeat)")).toBe("technical");
    expect(classifyRenderFailure("RENDER_FAILED", "ffmpeg exited with code 1")).toBe("technical");
    expect(classifyRenderFailure("OUTPUT_UPLOAD_FAILED", "S3 PUT 503")).toBe("technical");
    expect(classifyRenderFailure("RENDER_FAILED", "Delivery blocked for video 659: 1 requirement(s) failed — DELIVERED_DURATION_WRONG (the delivered file is 66.00s and the voiceover is 71.89s)")).toBe("technical");
  });
  it("content: refused for what the pictures show — a re-render would make the same film", () => {
    expect(classifyRenderFailure("RENDER_FAILED", "Delivery blocked for video 659: 2 requirement(s) failed — PICTURE_NOT_CHECKED (clip=vc_1 …)")).toBe("content");
    expect(classifyRenderFailure("RENDER_FAILED", "Delivery blocked for video 659: 1 requirement(s) failed — FINAL_PICTURE_IS_BLACK (…)")).toBe("content");
    expect(classifyRenderFailure("RENDER_FAILED", "Delivery blocked for video 659: 1 requirement(s) failed — SENTENCE_WITHOUT_CHECKED_PICTURE (s2b1 …)")).toBe("content");
  });
  it("permanent: no timeline, no video, a superseded render", () => {
    for (const code of ["TIMELINE_NOT_FOUND", "TIMELINE_INVALID", "VIDEO_NOT_FOUND", "RENDER_SUPERSEDED", "TIMELINE_VERSION_CONFLICT"]) {
      expect(classifyRenderFailure(code, "x")).toBe("permanent");
    }
  });
});

describe("G/H — the plan", () => {
  it("a lost worker on a finished, failed pipeline: one render-only retry of the same timeline", () => {
    const p = plan(video(), [job()]);
    expect(p.kind).toBe("retry_render");
    if (p.kind === "retry_render") {
      expect(p.failedJob.timelineVersion).toBe(4);
      /** the ordinary retries left plus the one last resort */
      expect(p.remainingAfter).toBe(RENDER_RECOVERY_MAX);
      expect(p.lastResort).toBe(false);
    }
  });
  it("never while a render of the video is queued or running (no second render)", () => {
    expect(plan(video(), [job({ id: 67, status: "queued" }), job()]).kind).toBe("none");
    expect(plan(video(), [job({ id: 67, status: "running" }), job()]).kind).toBe("none");
  });
  it("never while the pipeline still owns the video", () => {
    expect(plan(video({ status: "generating_effects" }), [job()])).toMatchObject({ kind: "none", reason: expect.stringMatching(/pipeline still owns/) });
  });
  it("never for an editor render (the owner's own action)", () => {
    expect(plan(video(), [job({ requestedByUserId: 7 })]).kind).toBe("none");
  });
  it("never for a superseded attempt", () => {
    expect(plan(video({ renderAttempt: 5 }), [job({ attempt: 3 })]).kind).toBe("none");
  });
  it("never for a delivered video", () => {
    expect(plan(video({ status: "completed", videoUrl: "https://x/v.mp4" }), [job()]).kind).toBe("none");
  });
  it("old failures are history", () => {
    expect(plan(video(), [job({ updatedAt: new Date(NOW - RENDER_RECOVERY_WINDOW_MS - 1) })]).kind).toBe("none");
  });
  it("a content refusal goes straight to the last resort (a film of fallback scenes) — the same pictures are never re-rendered", () => {
    const p = plan(video(), [job({ errorMessage: "Delivery blocked for video 659: 1 requirement(s) failed — PICTURE_NOT_CHECKED (clip=vc_1)" })]);
    expect(p).toMatchObject({ kind: "retry_render", lastResort: true, remainingAfter: 0 });
  });
  it("a content refusal of the last-resort film itself: failed for good — no endless loop", () => {
    const used = { renderRecovery: { attempts: 1, jobIds: [70], log: [], lastResort: true } };
    const p = plan(video({ metadata: used }), [job({ id: 70, errorMessage: "Delivery blocked for video 659: 1 requirement(s) failed — FINAL_PICTURE_IS_BLACK (…)" })]);
    expect(p).toMatchObject({ kind: "give_up", final: "failed" });
  });
  it("a timeline that is not stored cannot be re-rendered: NEEDS_HUMAN", () => {
    expect(plan(video(), [job()], false)).toMatchObject({ kind: "give_up", final: "needs_human" });
  });
  it("after RENDER_RECOVERY_MAX ordinary retries: ONE last-resort render (always a video)", () => {
    const used = { renderRecovery: { attempts: RENDER_RECOVERY_MAX, jobIds: [70, 71], log: [] } };
    const p = plan(video({ metadata: used }), [job({ id: 71 })]);
    expect(p).toMatchObject({ kind: "retry_render", lastResort: true, remainingAfter: 0 });
  });
  it("exhausted: the last resort failed too — failed for good, no endless loop", () => {
    const used = { renderRecovery: { attempts: RENDER_RECOVERY_MAX + 1, jobIds: [70, 71, 72], log: [], lastResort: true } };
    const p = plan(video({ metadata: used }), [job({ id: 72 })]);
    expect(p).toMatchObject({ kind: "give_up", final: "failed" });
  });
  it("a recovery that already ended does nothing more", () => {
    expect(plan(video({ metadata: { renderRecovery: { attempts: 1, jobIds: [70], log: [], final: "needs_human" } } }), [job({ id: 70 })]).kind).toBe("none");
  });
  it("a recovery render that completed and published: the video is recovered", () => {
    const meta = { renderRecovery: { attempts: 1, jobIds: [70], log: [] } };
    const p = plan(video({ status: "generating_effects", metadata: meta }), [job({ id: 70, status: "completed", outputUrl: "https://cdn/x.mp4", errorCode: null })]);
    expect(p).toMatchObject({ kind: "mark_recovered" });
  });
  it("a recovery render that completed WITHOUT publishing (superseded) is not a delivery", () => {
    const meta = { renderRecovery: { attempts: 1, jobIds: [70], log: [] } };
    const p = plan(video({ status: "generating_effects", metadata: meta }), [job({ id: 70, status: "completed", outputUrl: "https://cdn/x.mp4", errorCode: "RENDER_SUPERSEDED" })]);
    expect(p.kind).toBe("none");
  });
  it("a recovery render that failed again is the coordinator's own: retried while attempts remain", () => {
    const meta = { renderRecovery: { attempts: 1, jobIds: [70], log: [] } };
    const p = plan(video({ status: "generating_effects", renderAttempt: 4, metadata: meta }), [job({ id: 70, attempt: 4 })]);
    expect(p).toMatchObject({ kind: "retry_render", remainingAfter: 1, lastResort: false });
  });
});

/* ═══════════ the sweep, against an in-memory videos/render_jobs ═══════════ */

function world(opts: { video?: Partial<RecoveryVideo>; jobs?: RecoveryJob[]; stored?: boolean; createFails?: boolean } = {}) {
  const v: RecoveryVideo = video(opts.video);
  let jobs: RecoveryJob[] = opts.jobs ?? [job()];
  const lines: string[] = [];
  const statuses: Array<{ status: string; extra: Record<string, unknown> }> = [];
  let nextId = 100;
  const deps: RecoveryDeps = {
    listVideosWithFailedPipelineRenders: async () => [v.id],
    getVideo: async () => ({ ...v }),
    listJobs: async () => [...jobs].sort((a, b) => b.id - a.id),
    timelineStored: async () => opts.stored ?? true,
    claimAttemptIfCurrent: async (_id, expected) => {
      if (v.renderAttempt !== expected) return null;
      v.renderAttempt = expected + 1;
      return v.renderAttempt;
    },
    createJob: async (p) => {
      if (opts.createFails) return null;
      const j = job({ id: nextId++, status: "queued", attempt: p.attempt, timelineVersion: p.timelineVersion, errorCode: null, errorMessage: null, updatedAt: new Date(NOW) });
      jobs = [...jobs, j];
      return { id: j.id };
    },
    saveState: async (_id, state) => {
      v.metadata = { ...(v.metadata as object), renderRecovery: state };
    },
    setVideo: async (_id, status, extra) => {
      v.status = status;
      if (extra.videoUrl) v.videoUrl = extra.videoUrl;
      statuses.push({ status, extra });
    },
    log: (l) => lines.push(l),
    now: () => NOW,
  };
  const finish = (status: RecoveryJob["status"], over: Partial<RecoveryJob> = {}) => {
    const last = jobs.reduce((a, b) => (a.id > b.id ? a : b));
    jobs = jobs.map((j) => (j.id === last.id ? { ...j, status, updatedAt: new Date(NOW), ...over } : j));
  };
  return { deps, v, lines, statuses, finish, jobs: () => jobs };
}

describe("G/H — the sweep: retry, recover, give up, and never twice", () => {
  it("lost worker → one render-only job, logged with fault, action, result and attempts left", async () => {
    const w = world();
    const done = await runRenderRecoverySweep(w.deps);
    expect(done).toEqual([{ videoId: 659, plan: "retry_render", detail: "render job 100 queued" }]);
    expect(w.jobs().filter((j) => j.status === "queued")).toHaveLength(1);
    expect(w.lines[0]).toMatch(/\[Recovery\] video=659 fault="RENDER_FAILED: the worker rendering this job stopped reporting.*" action=render_only_retry timelineVersion=4 result="render job 100 queued" attempt=1\/3 remaining=2/);
    expect(readRecoveryState(w.v.metadata)).toMatchObject({ attempts: 1, jobIds: [100] });
    expect(w.v.status).toBe("generating_effects");
  });

  it("a second sweep while that job is queued does nothing (no duplicate render, no double cost)", async () => {
    const w = world();
    await runRenderRecoverySweep(w.deps);
    const again = await runRenderRecoverySweep(w.deps);
    expect(again[0]).toMatchObject({ plan: "none", detail: "a render is queued or running" });
    expect(w.jobs().filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("two workers sweeping at the same moment: the attempt is claimed once, one job is created", async () => {
    const w = world();
    const both = await Promise.all([runRenderRecoverySweep(w.deps), runRenderRecoverySweep(w.deps)]);
    const created = both.flat().filter((d) => d.plan === "retry_render");
    expect(created).toHaveLength(1);
    expect(w.jobs().filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("the recovery render delivers → the video is completed with ITS url, once", async () => {
    const w = world();
    await runRenderRecoverySweep(w.deps);
    w.finish("completed", { outputUrl: "https://cdn/renders/659-100.mp4", errorCode: null });
    const r = await runRenderRecoverySweep(w.deps);
    expect(r[0]).toMatchObject({ plan: "mark_recovered" });
    expect(w.v).toMatchObject({ status: "completed", videoUrl: "https://cdn/renders/659-100.mp4" });
    expect(readRecoveryState(w.v.metadata).final).toBe("recovered");
    expect(w.lines.at(-1)).toMatch(/RECOVERED — the render-only retry passed the delivery gate and was published/);
    /** and nothing further happens */
    expect((await runRenderRecoverySweep(w.deps))[0]?.plan).toBe("none");
  });

  it("a recovery render that fails every time: RENDER_RECOVERY_MAX retries, ONE last resort, then failed for good with the reason", async () => {
    const w = world();
    const flagWhenCreated: boolean[] = [];
    const createJob = w.deps.createJob;
    w.deps.createJob = async (p) => {
      /** the worker reads the flag when it claims the job: it must be stored BEFORE the job exists */
      flagWhenCreated.push(readRecoveryState(w.v.metadata).lastResort === true);
      return createJob(p);
    };
    for (let i = 0; i < 8; i++) {
      await runRenderRecoverySweep(w.deps);
      if (w.jobs().some((j) => j.status === "queued")) w.finish("failed", { errorCode: "RENDER_FAILED", errorMessage: "ffmpeg exited with code 1" });
    }
    expect(w.jobs().filter((j) => j.id >= 100)).toHaveLength(RENDER_RECOVERY_MAX + 1);
    expect(flagWhenCreated).toEqual([...Array(RENDER_RECOVERY_MAX).fill(false), true]);
    expect(w.lines.filter((l) => l.includes("action=last_resort_fallback_film"))).toHaveLength(1);
    expect(w.v.status).toBe("failed");
    expect(readRecoveryState(w.v.metadata)).toMatchObject({ attempts: RENDER_RECOVERY_MAX + 1, lastResort: true, final: "failed" });
    expect(w.statuses.at(-1)?.extra.errorMessage).toMatch(/^RECOVERY_EXHAUSTED: 3 render-only recoveries used, the last resort \(a film of fallback scenes\) included — .* last fault RENDER_FAILED: ffmpeg exited/);
  });

  it("a film refused for its pictures is never re-rendered with the same pictures: the last resort (fallback scenes) is made instead", async () => {
    const w = world({ jobs: [job({ errorMessage: "Delivery blocked for video 659: 1 requirement(s) failed — PICTURE_NOT_CHECKED (clip=vc_1)" })] });
    const r = await runRenderRecoverySweep(w.deps);
    expect(r[0]).toMatchObject({ plan: "retry_render", detail: "render job 100 queued" });
    expect(readRecoveryState(w.v.metadata)).toMatchObject({ attempts: 1, lastResort: true });
    expect(w.v.status).toBe("generating_effects");
    expect(w.statuses.at(-1)?.extra.progressStep).toBe("Recovering: simplified film (last resort)");
    /** the last resort delivers: completed, and named for what it is */
    w.finish("completed", { outputUrl: "https://cdn/renders/659-100.mp4", errorCode: null });
    await runRenderRecoverySweep(w.deps);
    expect(w.v).toMatchObject({ status: "completed", videoUrl: "https://cdn/renders/659-100.mp4" });
    expect(w.statuses.at(-1)?.extra.progressStep).toMatch(/simplified film of fallback scenes \(last resort\)/);
    expect(w.lines.at(-1)).toMatch(/RECOVERED — the last-resort film \(every picture a fallback scene, not footage\)/);
  });

  it("a timeline that is missing or invalid is still NEEDS_HUMAN: there is nothing to render", async () => {
    const w = world({ jobs: [job({ errorCode: "TIMELINE_INVALID", errorMessage: "every video clip was refused" })] });
    await runRenderRecoverySweep(w.deps);
    expect(w.jobs()).toHaveLength(1);
    expect(readRecoveryState(w.v.metadata).final).toBe("needs_human");
    expect(w.statuses.at(-1)?.extra.errorMessage).toMatch(/^NEEDS_HUMAN_ACTION:/);
  });

  it("the job row cannot be created: logged, counted, and the next sweep can try again within the limit", async () => {
    const w = world({ createFails: true });
    const r = await runRenderRecoverySweep(w.deps);
    expect(r[0]?.detail).toBe("the render job could not be created");
    expect(w.v.status).toBe("failed");
    expect(readRecoveryState(w.v.metadata).attempts).toBe(1);
  });

  it("restart during recovery: the state lives in the video row, so a fresh process continues where it was", async () => {
    const w = world();
    await runRenderRecoverySweep(w.deps);
    w.finish("failed", { errorCode: "RENDER_FAILED", errorMessage: "the worker rendering this job stopped reporting 16 min ago (no heartbeat)" });
    /** a "new process": the same rows, nothing in memory */
    const r = await runRenderRecoverySweep({ ...w.deps });
    expect(r[0]).toMatchObject({ plan: "retry_render" });
    expect(readRecoveryState(w.v.metadata).attempts).toBe(2);
  });

  it("a sweep that throws for one video goes on with the next", async () => {
    const w = world();
    const deps: RecoveryDeps = { ...w.deps, listVideosWithFailedPipelineRenders: async () => [1, 659], getVideo: async (id) => (id === 1 ? Promise.reject(new Error("db down")) : w.deps.getVideo(id)) };
    const r = await runRenderRecoverySweep(deps);
    expect(r.map((x) => x.videoId)).toEqual([659]);
    expect(w.lines[0]).toMatch(/video=1 sweep error: db down/);
  });
});

/* ═══════════ the wiring: one sweep, no second retry system, no full-pipeline rerun beside a recovery ═══════════ */

describe("G/H — wired into what exists, never beside it", () => {
  const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
  const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
  const body = (src: string, name: string) => src.slice(src.indexOf(name), src.indexOf("\n}\n", src.indexOf(name)));

  it("the recovery sweep runs on the stale sweep's existing two-minute timer, after it", () => {
    expect(WORKER).toContain("const sweep = setInterval(() => void sweepStaleRenderJobs().then(() => sweepRenderRecoveries()), 2 * 60_000);");
    expect(body(WORKER, "export async function sweepRenderRecoveries")).toContain("runRenderRecoverySweep(await productionRecoveryDeps())");
  });

  it("a stalled-pipeline sweep does NOT re-run the whole pipeline (search, judge, downloads) while a recovery render is active", () => {
    const stall = body(DB, "export async function failPipelineIfStalled");
    const guard = stall.indexOf("renderRecovery");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(stall.indexOf("requeueStalledPipeline("));
    expect(stall).toMatch(/if \(rec && \(rec\.attempts \?\? 0\) > 0 && !rec\.final\) return video;/);
  });

  it("a deploy that interrupts a recovery render does not re-queue the whole pipeline either", () => {
    const interrupted = body(DB, "export async function requeueInterruptedVideo");
    expect(interrupted.indexOf("renderRecovery")).toBeGreaterThan(0);
    expect(interrupted.indexOf("renderRecovery")).toBeLessThan(interrupted.indexOf("bumpGenerationAttempt("));
  });

  it("the attempt claim is conditional in the UPDATE itself (one winner when two workers sweep)", () => {
    const claim = body(DB, "export async function claimRenderAttemptIfCurrent");
    expect(claim).toContain(".where(and(eq(videos.id, videoId), eq(videos.renderAttempt, expected)));");
  });

  it("a recovery render is an ordinary PIPELINE render job: same worker, same strict delivery gate", () => {
    const COORD = fs.readFileSync(path.join(__dirname, "recoveryCoordinator.ts"), "utf8");
    expect(COORD).toContain("db.createRenderJob({ videoId: p.videoId, requestedByUserId: null,");
    expect(WORKER).toContain("enforcePictureChecks: job.requestedByUserId == null,");
  });
});
