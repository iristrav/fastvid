/**
 * VIDEO 659 — THE RENDER USES THE FILES ITS PIPELINE ALREADY HOLDS, WHOEVER CLAIMS THE JOB.
 *
 * Production, 15 October, job 65: the pipeline queued its cinematic render, and the render-job poll
 * loop in the same process claimed it first. `runRenderJob` ran without the pipeline's local files,
 * three SerpAPI pictures that only ever lived on that disk could not be fetched again:
 *
 *   RENDER_CLIP_DROPPED clip=vc_c786f43c84 … slot=43.80-48.37s  REHYDRATION_UNSUPPORTED_PROVIDER
 *   RENDER_CLIP_DROPPED clip=vc_0f4ccc76d0 … slot=60.57-68.83s  REHYDRATION_UNSUPPORTED_PROVIDER
 *   RENDER_CLIP_DROPPED clip=vc_0f4ccc76d0_graphic7 … 68.83-71.55s
 *   duration 56.00s differs from the timeline's 71.55s by 15.55s → RENDER_FAILED
 *
 * Now the pipeline offers its files before it queues; the poll loop leaves an offered job alone,
 * and a render that starts without files of its own reads the offer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline } from "./projectTimeline";

const dbState = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  timeline: null as unknown,
  queue: [] as Array<{ id: number; videoId: number; timelineVersion: number }>,
  claimed: [] as number[],
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async (id: number) => (dbState.job && dbState.job.id === id ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: null, userId: 1 }),
  getVideoRenderAttempt: async () => 1,
  getStoredTimeline: async () =>
    dbState.timeline ? { raw: JSON.parse(JSON.stringify(dbState.timeline)), timelineVersion: 4 } : null,
  getVideoScenes: async () => null,
  updateRenderJobProgress: async () => undefined,
  touchRunningRenderJob: async () => undefined,
  finishRenderJob: async () => undefined,
  listQueuedRenderJobs: async () => dbState.queue.map((j) => ({ ...j, status: "queued" })),
  claimQueuedRenderJob: async (id: number) => {
    dbState.claimed.push(id);
    const at = dbState.queue.findIndex((j) => j.id === id);
    if (at < 0) return null;
    const [job] = dbState.queue.splice(at, 1);
    return { ...job, status: "running", attempt: 1 };
  },
}));

import {
  localFilesOfferedForRender,
  offerLocalFilesForRender,
  processRenderJobTick,
  runRenderJob,
} from "./renderJobWorker";

const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function timelineWithOneSerpClip(): ProjectTimeline {
  const t = emptyTimeline(659, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks[0] = {
    kind: "VIDEO",
    clips: [
      {
        id: "vc_c786f43c84", kind: "video",
        source: { provider: "serpapi", providerAssetId: "serp-1", mediaUrl: "https://example.invalid/a.jpg", contentApproval: "judge_fit", textCheck: "clean", heldLocallyAtRender: true },
        sourceIn: 0, sourceOut: 4, timelineStart: 0, timelineEnd: 4, sceneIndex: 0, beatIndex: 0,
        motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
      },
    ],
  } as never;
  t.durationSec = 4;
  t.sentences = [{ sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 4, timingBasis: "measured", text: "The harvest failed." }];
  return t;
}

afterEach(() => {
  dbState.job = null;
  dbState.timeline = null;
  dbState.queue = [];
  dbState.claimed = [];
});

describe("VIDEO 659 — the offer itself", () => {
  it("is found by video and timeline version, and gone once withdrawn", () => {
    const files = new Map([["vc_1", "/w/a.mp4"]]);
    const withdraw = offerLocalFilesForRender(659, 4, files);
    expect(localFilesOfferedForRender(659, 4)).toBe(files);
    expect(localFilesOfferedForRender(659, 3)).toBeUndefined();
    expect(localFilesOfferedForRender(658, 4)).toBeUndefined();
    withdraw();
    expect(localFilesOfferedForRender(659, 4)).toBeUndefined();
  });

  it("an older withdrawal never removes a newer offer of the same version", () => {
    const first = offerLocalFilesForRender(659, 4, new Map());
    const newer = new Map([["vc_1", "/w/b.mp4"]]);
    const second = offerLocalFilesForRender(659, 4, newer);
    first();
    expect(localFilesOfferedForRender(659, 4)).toBe(newer);
    second();
    expect(localFilesOfferedForRender(659, 4)).toBeUndefined();
  });
});

describe("VIDEO 659 — a render started without files of its own reads the offer", () => {
  const run = async (existingByClipId?: Map<string, string>) => {
    dbState.job = { id: 65, videoId: 659, status: "running", timelineVersion: 4, attempt: 1, progressStep: "queued", progress: 0 };
    dbState.timeline = timelineWithOneSerpClip();
    let handed: Map<string, string> | undefined | "not called" = "not called";
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v659-"));
    try {
      await runRenderJob({
        jobId: 65,
        ...(existingByClipId ? { existingByClipId } : {}),
        deps: {
          workRoot: () => workRoot,
          /** The test stops right after the hand-over: nothing recovered ends the job here. */
          rehydrate: (async (p: { existingByClipId?: Map<string, string> }) => {
            handed = p.existingByClipId;
            return { byClipId: new Map(), results: [], failures: [] };
          }) as never,
        },
      });
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
    return handed;
  };

  it("the poll loop's call (no files) gets the pipeline's offered files — the 659 case", async () => {
    const files = new Map([["vc_c786f43c84", "/w/serp-1.jpg"]]);
    const withdraw = offerLocalFilesForRender(659, 4, files);
    try {
      expect(await run()).toBe(files);
    } finally {
      withdraw();
    }
  });

  it("files passed by the caller win over the offer", async () => {
    const own = new Map([["vc_c786f43c84", "/w/own.jpg"]]);
    const withdraw = offerLocalFilesForRender(659, 4, new Map([["vc_c786f43c84", "/w/offered.jpg"]]));
    try {
      expect(await run(own)).toBe(own);
    } finally {
      withdraw();
    }
  });

  it("no offer and no files → unchanged: rehydration fetches everything itself", async () => {
    expect(await run()).toBeUndefined();
  });
});

describe("VIDEO 659 — the poll loop leaves an offered job to its pipeline", () => {
  it("claims the next, unoffered job and never the offered one", async () => {
    dbState.queue = [
      { id: 65, videoId: 659, timelineVersion: 4 },
      { id: 66, videoId: 660, timelineVersion: 1 },
    ];
    const withdraw = offerLocalFilesForRender(659, 4, new Map());
    try {
      await processRenderJobTick();
    } finally {
      withdraw();
    }
    expect(dbState.claimed).toEqual([66]);
    expect(dbState.queue.map((j) => j.id)).toEqual([65]);
  });

  it("once the offer is withdrawn the loop claims it as before (a pipeline that died never strands its job)", async () => {
    dbState.queue = [{ id: 65, videoId: 659, timelineVersion: 4 }];
    await processRenderJobTick();
    expect(dbState.claimed).toEqual([65]);
  });
});

describe("VIDEO 659 — the pipeline offers before it queues and withdraws when its render is over", () => {
  it("offer → enqueue → claim, and the withdrawal in a finally", () => {
    const offer = PIPE.indexOf("withdrawLocalFiles = offerLocalFilesForRender(videoId, outcome.timelineVersion, offeredLocalFiles);");
    const enqueue = PIPE.indexOf("cutover = await enqueueCinematicRender({");
    const claim = PIPE.indexOf("const claimed = await claimQueuedRenderJob(cutover.renderJobId);");
    expect(offer).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(offer);
    expect(claim).toBeGreaterThan(enqueue);
    const withdrawal = PIPE.indexOf("withdrawLocalFiles?.();", claim);
    expect(withdrawal).toBeGreaterThan(claim);
    expect(PIPE.slice(withdrawal - 200, withdrawal)).toContain("} finally {");
  });

  it("the in-process render is handed exactly the offered files", () => {
    expect(PIPE).toContain("const existingByClipId = offeredLocalFiles;");
  });

  it("runRenderJob reads the offer only when it was given no files", () => {
    expect(WORKER).toContain("existingByClipId: params.existingByClipId ?? offered,");
  });
});
