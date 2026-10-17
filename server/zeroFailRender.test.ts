/**
 * G/H — ZERO-FAIL DELIVERY IN THE RENDER WORKER: a missing picture file keeps its slot as a fallback
 * scene; owner, 15 October: "er moet wel altijd een video uitkomen" — so a film that is mostly or even
 * entirely fallback scenes is still made, and named for what it is; the recovery's last resort renders
 * every picture as its fallback scene; an editor render keeps the owner's own pictures. Driven through `runRenderJob` with the database and the
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
  videoMetadata: null as unknown,
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async (id: number) => (dbState.job && dbState.job.id === id ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: null, userId: 1, metadata: dbState.videoMetadata }),
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
  dbState.videoMetadata = null;
});

/** The run went past every refusal and reached the encode (the stand-in renderer stops it there). */
const reachedEncode = (result: unknown) => expect(`${JSON.stringify(result)}\n${lines.join("\n")}`).toMatch(/STOP_BEFORE_ENCODE/);

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

  it("no real picture came back at all: still a film — every slot its sentence's fallback scene, named ALL_FALLBACK", async () => {
    const { result, fetched } = await run(film([clip(0), clip(1)]), { available: [] });
    const said = lines.join("\n");
    expect(fetched).toEqual(expect.arrayContaining(["vc_0:synthetic_placeholder", "vc_1:synthetic_placeholder"]));
    expect(said).toMatch(/QUALITY_PROBLEM ALL_FALLBACK 8\.00s of 8\.00s \(100%\) are fallback scenes, not footage — delivered anyway \(always a video\)/);
    /** each scene carries its sentence's words — VIDEO 663: one or two words, the year alone */
    expect(said).toMatch(/clip=vc_0 s0b0 words="1932" \(date_card\)/);
    expect(said).not.toMatch(/ASSET_NOT_REHYDRATABLE/);
    reachedEncode(result);
  }, 60_000);

  it(`more than ${Math.round(FALLBACK_SCENE_MAX_SHARE * 100)}% fallback because files are missing: made anyway, named MOSTLY_FALLBACK as a quality problem`, async () => {
    const { result } = await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0"] });
    const said = lines.join("\n");
    expect(said).toMatch(/QUALITY_PROBLEM MOSTLY_FALLBACK 8\.00s of 12\.00s \(67%\) are fallback scenes, not footage/);
    expect(said).not.toMatch(/FALLBACK_SHARE_TOO_HIGH/);
    reachedEncode(result);
  }, 60_000);

  it("more than half the film unchecked: the unchecked pictures are replaced (never shown) and the film is still made", async () => {
    const { result, fetched } = await run(film([clip(0), clip(1, { contentApproval: "unverified" }), clip(2, { textCheck: "unchecked" })]), { available: ["vc_0", "vc_1", "vc_2"] });
    const said = lines.join("\n");
    expect(fetched).not.toContain("vc_1:serpapi");
    expect(fetched).not.toContain("vc_2:serpapi");
    expect(said).toMatch(/FALLBACK_SCENES replaced=2 captioned=2 withoutWords=0/);
    expect(said).toMatch(/QUALITY_PROBLEM MOSTLY_FALLBACK 8\.00s of 12\.00s \(67%\)/);
    expect(said).not.toMatch(/Delivery blocked/);
    reachedEncode(result);
  }, 60_000);

  it("a few fallback scenes: a QUALITY_NOTE, not a problem", async () => {
    await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0", "vc_2"] });
    expect(lines.join("\n")).toMatch(/QUALITY_NOTE SOME_FALLBACK 4\.00s of 12\.00s \(33%\)/);
  }, 60_000);

  it("the recovery's LAST RESORT: every picture is rendered as its fallback scene — no footage fetched, named, and still made", async () => {
    dbState.videoMetadata = { renderRecovery: { attempts: 3, jobIds: [70, 71, 72], log: [], lastResort: true } };
    const { result, fetched } = await run(film([clip(0), clip(1), clip(2)]), { available: ["vc_0", "vc_1", "vc_2"] });
    const said = lines.join("\n");
    expect(said).toMatch(/LAST_RESORT_RENDER — 3 picture\(s\) rendered as fallback scenes so the film is delivered at all \(not footage\)/);
    expect(fetched.filter((f) => f.endsWith(":serpapi"))).toEqual([]);
    expect(said).toMatch(/QUALITY_PROBLEM ALL_FALLBACK 12\.00s of 12\.00s \(100%\)/);
    reachedEncode(result);
  }, 60_000);

  it("no last resort without the flag: a normal pipeline render fetches its real pictures", async () => {
    dbState.videoMetadata = { renderRecovery: { attempts: 1, jobIds: [70], log: [] } };
    const { fetched } = await run(film([clip(0), clip(1)]), { available: ["vc_0", "vc_1"] });
    expect(fetched).toEqual(["vc_0:serpapi", "vc_1:serpapi"]);
    expect(lines.join("\n")).not.toMatch(/LAST_RESORT_RENDER/);
  }, 60_000);

  it("an editor render never takes the last resort, even with the flag set", async () => {
    dbState.videoMetadata = { renderRecovery: { attempts: 3, jobIds: [70, 71, 72], log: [], lastResort: true } };
    const { fetched } = await run(film([clip(0), clip(1)]), { available: ["vc_0", "vc_1"], requestedByUserId: 7 });
    expect(fetched).toEqual(["vc_0:serpapi", "vc_1:serpapi"]);
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

  it("VIDEO 660: a sentence under the previous sentence's held picture gets its own fallback scene, drawn, and the render goes on", async () => {
    /** clip 1 is held over sentence 2 (8–12 s), which has no picture of its own */
    const t = film([clip(0), { ...clip(1), timelineEnd: 12, sourceOut: 4, holdAtSourceOut: true } as TimelineVideoClip]);
    t.sentences = [...t.sentences!, { sceneIndex: 0, beatIndex: 2, startSec: 8, endSec: 12, timingBasis: "measured", text: "Crowds gathered at the border." }];
    t.durationSec = 12;
    const { result, fetched } = await run(t, { available: ["vc_0", "vc_1"] });
    const said = lines.join("\n");
    expect(said).toMatch(/\[FallbackScene\] s0b2 slot=8\.00-12\.00s had NO picture of its own .* — a fallback scene of exactly this sentence \(not footage\); vc_1 ends at 8\.00s/);
    expect(fetched).toEqual(["vc_0:serpapi", "vc_1:serpapi", "vc_fallback_s0b2:synthetic_placeholder"]);
    expect(said).toMatch(/QUALITY_NOTE SOME_FALLBACK 4\.00s of 12\.00s \(33%\)/);
    reachedEncode(result);
  }, 60_000);

  it("an EDITOR render (a requesting user) keeps the owner's own pictures: nothing replaced, nothing drawn", async () => {
    const { fetched } = await run(film([clip(0), clip(1, { contentApproval: "unverified" })]), { available: ["vc_0", "vc_1"], requestedByUserId: 7 });
    expect(fetched).toEqual(["vc_0:serpapi", "vc_1:serpapi"]);
    expect(lines.join("\n")).not.toMatch(/\[FallbackScene\]/);
  }, 60_000);
});
