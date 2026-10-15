/**
 * G/H — ZERO-FAIL DELIVERY IN THE RENDER WORKER: a missing picture file keeps its slot as a fallback
 * scene; a film is never mostly fallback; no real picture at all is an outage, not a film; an editor
 * render keeps the owner's own pictures. Driven through `runRenderJob` with the database and the
 * rehydrator stood in — the run stops at the point under test (before any encode).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const dbState = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  timeline: null as unknown,
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async (id: number) => (dbState.job && dbState.job.id === id ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: null, userId: 1 }),
  getVideoRenderAttempt: async () => 1,
  getStoredTimeline: async () => (dbState.timeline ? { raw: JSON.parse(JSON.stringify(dbState.timeline)), timelineVersion: 4 } : null),
  getVideoScenes: async () => null,
  updateRenderJobProgress: async () => undefined,
  touchRunningRenderJob: async () => undefined,
  finishRenderJob: async (p: Record<string, unknown>) => {
    dbState.job = { ...(dbState.job ?? {}), ...p };
  },
}));

import { runRenderJob } from "./renderJobWorker";
import { FALLBACK_SCENE_MAX_SHARE } from "./fallbackScene";

const checked = { contentApproval: "judge_fit" as const, textCheck: "clean" as const };
const clip = (i: number, over: Partial<TimelineVideoClip["source"]> = checked): TimelineVideoClip =>
  ({
    id: `vc_${i}`,
    kind: "video",
    source: { provider: "serpapi", providerAssetId: `img-${i}`, mediaUrl: `https://example.invalid/${i}.jpg`, heldLocallyAtRender: true, ...over },
    sourceIn: 0,
    sourceOut: 4,
    timelineStart: i * 4,
    timelineEnd: i * 4 + 4,
    sceneIndex: 0,
    beatIndex: i,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
  }) as TimelineVideoClip;

function film(clips: TimelineVideoClip[]): ProjectTimeline {
  const t = emptyTimeline(661, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks[0] = { kind: "VIDEO", clips } as never;
  t.durationSec = clips.length * 4;
  t.sentences = clips.map((_, i) => ({ sceneIndex: 0, beatIndex: i, startSec: i * 4, endSec: i * 4 + 4, timingBasis: "measured", text: ["The harvest failed in 1932.", "Otto von Bismarck spoke.", "Crowds gathered at the border."][i % 3] }));
  return t;
}

let root: string;
let lines: string[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zerofail-"));
  lines = [];
  const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  dbState.job = null;
  dbState.timeline = null;
});

/**
 * Runs the job. `available` are the clip ids whose ORIGINAL file comes back; a fallback scene is
 * "drawn" when `drawable`. Every other clip fails like a vanished SerpAPI picture (job 66).
 */
async function run(t: ProjectTimeline, opts: { available: string[]; drawable?: boolean; requestedByUserId?: number | null }) {
  dbState.timeline = t;
  dbState.job = { id: 66, videoId: 661, status: "running", timelineVersion: 4, attempt: 1, progressStep: "queued", progress: 0, requestedByUserId: opts.requestedByUserId ?? null };
  const fetched: string[] = [];
  const result = await runRenderJob({
    jobId: 66,
    deps: {
      workRoot: () => root,
      rehydrate: (async (p: { timeline: ProjectTimeline }) => {
        const byClipId = new Map<string, string>();
        const failures: Array<{ clipId: string; result: { status: "failed"; errorCode: string; errorMessage: string } }> = [];
        for (const c of p.timeline.tracks.flatMap((x) => (x.kind === "VIDEO" ? x.clips : []))) {
          if (c.disabled) continue;
          fetched.push(`${c.id}:${c.source.provider}`);
          const ok = c.source.provider === "synthetic_placeholder" ? opts.drawable !== false : opts.available.includes(c.id);
          if (ok) byClipId.set(c.id, path.join(root, `${c.id}.mp4`));
          else failures.push({ clipId: c.id, result: { status: "failed", errorCode: "REHYDRATION_UNSUPPORTED_PROVIDER", errorMessage: "provider=serpapi" } });
        }
        return { byClipId, results: [], failures };
      }) as never,
      /** never reached in the cases that stop before the render; a throw here would say so */
      render: (async () => {
        throw new Error("STOP_BEFORE_ENCODE");
      }) as never,
    },
  });
  return { result, fetched };
}

describe("G/H — a picture whose file is gone keeps its slot as a fallback scene", () => {
  it("one of three files missing: a fallback scene is drawn for exactly that slot, named, and the render goes on", async () => {
    const { fetched } = await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0", "vc_2"] });
    const said = lines.join("\n");
    expect(said).toMatch(/\[FallbackScene\] clip=vc_1 slot=4\.00-8\.00s file of serpapi:img-1 could not be recovered — fallback scene drawn for exactly this slot \(not footage\)/);
    expect(fetched).toContain("vc_1:synthetic_placeholder");
    expect(said).not.toMatch(/RENDER_CLIP_DROPPED clip=vc_1/);
    /** it reached the encode: the film was not refused for the missing file */
    expect(said).toMatch(/STOP_BEFORE_ENCODE|render/i);
  }, 60_000);

  it("no real picture came back at all: an outage, not a film — ASSET_NOT_REHYDRATABLE, nothing drawn", async () => {
    const { result, fetched } = await run(film([clip(0), clip(1)]), { available: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ASSET_NOT_REHYDRATABLE");
    expect(result.message).toMatch(/no real picture could be recovered \(2 failed; fallback scenes alone are not a film\)/);
    expect(fetched.some((f) => f.endsWith("synthetic_placeholder"))).toBe(false);
  }, 60_000);

  it(`more than ${Math.round(FALLBACK_SCENE_MAX_SHARE * 100)}% fallback because files are missing: refused before the encode, as a TECHNICAL fault (an outage may pass)`, async () => {
    const { result } = await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^FALLBACK_SHARE_TOO_HIGH_MISSING_FILES — fallback scenes would fill 8\.00s of 12\.00s \(67%, limit 50%\); 2 picture file\(s\) could not be recovered/);
    const { classifyRenderFailure } = await import("./recoveryCoordinator");
    expect(classifyRenderFailure(result.code, result.message)).toBe("technical");
  }, 60_000);

  it("more than half the film unchecked: refused as a CONTENT matter — a person decides, nothing retried", async () => {
    const { result } = await run(film([clip(0), clip(1, { contentApproval: "unverified" }), clip(2, { textCheck: "unchecked" })]), { available: ["vc_0", "vc_1", "vc_2"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^Delivery blocked for video 661: 1 requirement\(s\) failed — FALLBACK_SHARE_TOO_HIGH \(fallback scenes would fill 8\.00s of 12\.00s/);
    const { classifyRenderFailure } = await import("./recoveryCoordinator");
    expect(classifyRenderFailure(result.code, result.message)).toBe("content");
  }, 60_000);

  it("an unchecked picture is replaced BEFORE anything is fetched — the refused source is never even downloaded", async () => {
    const { fetched } = await run(film([clip(0), clip(1, { contentApproval: "unverified" }), clip(2)]), { available: ["vc_0", "vc_1", "vc_2"] });
    expect(fetched).toContain("vc_1:synthetic_placeholder");
    expect(fetched).not.toContain("vc_1:serpapi");
    expect(lines.join("\n")).toMatch(/FALLBACK_SCENES replaced=1 captioned=1 withoutWords=0/);
  }, 60_000);

  it("the fallback scene itself cannot be drawn: the clip is dropped and named — the duration check then decides (never a silently shorter success)", async () => {
    await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0", "vc_2"], drawable: false });
    const said = lines.join("\n");
    expect(said).toMatch(/\[FallbackScene\] clip=vc_1 file of .* missing AND the fallback scene could not be drawn/);
    expect(said).toMatch(/RENDER_CLIP_DROPPED clip=vc_1/);
    expect(said).toMatch(/PICTURE_SHORT 4\.00s of picture could not be recovered/);
  }, 60_000);

  it("a picture with NO route to its file at all (refused by the timeline check): a fallback scene of its slot, not a shorter film", async () => {
    const lost = clip(1, { ...checked, heldLocallyAtRender: false, mediaUrl: undefined, provider: "unknown_route" } as never);
    const { fetched } = await run(film([clip(0), lost, clip(2)]), { available: ["vc_0", "vc_2"] });
    const said = lines.join("\n");
    expect(said).toMatch(/\[FallbackScene\] clip=vc_1 slot=4\.00-8\.00s unknown_route:img-1 has no route to its file \(missing_asset\)/);
    expect(said).not.toMatch(/RENDER_CLIP_DROPPED clip=vc_1/);
    expect(fetched).toContain("vc_1:synthetic_placeholder");
  }, 60_000);

  it("an EDITOR render (a requesting user) keeps the owner's own pictures: nothing replaced, nothing drawn", async () => {
    const { fetched } = await run(film([clip(0), clip(1, { contentApproval: "unverified" })]), { available: ["vc_0", "vc_1"], requestedByUserId: 7 });
    expect(fetched).toEqual(["vc_0:serpapi", "vc_1:serpapi"]);
    expect(lines.join("\n")).not.toMatch(/\[FallbackScene\]/);
  }, 60_000);
});
