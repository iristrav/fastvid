/**
 * VIDEO 634 — THE MINIMAL FIXES.
 *
 *   E1  a YouTube clip's time over 5 s never goes to the invisible ground under a sentence's card
 *       (`…_graphicN`): in 634 that was 10.1 s of black inside the clip's OWN, approved sentence
 *         vc_71f0ae0d18: 11.18s of YouTube → 5s; vc_71f0ae0d18_graphic1 holds 6.18s longer
 *         vc_08407e7de4: 6.44s of YouTube → 5s; vc_08407e7de4_graphic5 starts 1.44s earlier
 *   E2  an approved picture never disappears without a named reason (s0b0's press photo: ADOPTED,
 *       then nothing)
 *   E3  a FIT after its scene closed is not placed, and says so (s0b2: approved 62 s after scene 0)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { limitYoutubeShots, type YoutubeSourceFacts } from "./youtubeShotLimit";
import type { TimelineVideoClip } from "./projectTimeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const oneShot = (sourceDurationSec: number): YoutubeSourceFacts => ({ sourceDurationSec, cutsSec: [], measured: true });
const clip = (id: string, start: number, end: number, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "youtube", archiveAssetId: 60140 },
  sourceIn: 0,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex: 0,
  ...over,
} as TimelineVideoClip);
/** A sentence's card ground, exactly as `placePrimaryGraphics` makes it: the neighbour's copy at opacity 0. */
const ground = (id: string, start: number, end: number) => clip(id, start, end, { transform: { opacity: 0 } });

const span = (cs: TimelineVideoClip[], prefix: string) => {
  const own = cs.filter((c) => c.id === prefix || c.id.startsWith(`${prefix}_p`));
  return { start: Math.min(...own.map((c) => c.timelineStart)), end: Math.max(...own.map((c) => c.timelineEnd)), pieces: own };
};
const noGaps = (cs: TimelineVideoClip[]) => {
  const sorted = [...cs].sort((a, b) => a.timelineStart - b.timelineStart);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.timelineStart).toBeCloseTo(sorted[i - 1]!.timelineEnd, 3);
};

describe("E1 — YouTube time over 5 s never goes to a card's invisible ground", () => {
  it("634 s0b1: the card ground BEFORE the clip keeps its window; the approved clip is cut into ≤5 s pieces in its own sentence", () => {
    const before = ground("vc_71f0ae0d18_graphic1", 0, 5.782);
    const yt = clip("vc_71f0ae0d18", 5.782, 16.964);
    const { clips, notes } = limitYoutubeShots({ clips: [before, yt], youtube: new Map([["vc_71f0ae0d18", oneShot(8.36)]]) });

    const g = clips.find((c) => c.id === "vc_71f0ae0d18_graphic1")!;
    expect(g.timelineStart).toBe(0);
    expect(g.timelineEnd, "the card's ground does not grow past its card").toBeCloseTo(5.782, 3);
    expect(notes.join(" | ")).not.toContain("graphic1 holds");

    const own = span(clips, "vc_71f0ae0d18");
    expect(own.start, "the approved shot still starts where its sentence starts").toBeCloseTo(5.782, 3);
    expect(own.end, "…and fills its sentence to the end").toBeCloseTo(16.964, 3);
    for (const p of own.pieces) {
      expect(p.timelineEnd - p.timelineStart, p.id).toBeLessThanOrEqual(5 + 1e-6);
      expect(p.transform?.opacity ?? 1, `${p.id} is visible`).toBe(1);
    }
    noGaps(clips);
  });

  it("634 s1b3: card grounds on BOTH sides keep their windows; the approved clip keeps its whole sentence", () => {
    const prev = ground("vc_71f0ae0d18_graphic4", 27.91, 32.89);
    const yt = clip("vc_08407e7de4", 32.89, 39.33, { source: { provider: "youtube", archiveAssetId: 60188 } });
    const next = ground("vc_08407e7de4_graphic5", 39.33, 43.28);
    const { clips, notes } = limitYoutubeShots({
      clips: [prev, yt, next],
      youtube: new Map([["vc_08407e7de4", oneShot(3.3)]]),
    });
    const g4 = clips.find((c) => c.id === "vc_71f0ae0d18_graphic4")!;
    const g5 = clips.find((c) => c.id === "vc_08407e7de4_graphic5")!;
    expect([g4.timelineStart, g4.timelineEnd]).toEqual([27.91, 32.89]);
    expect([g5.timelineStart, g5.timelineEnd]).toEqual([39.33, 43.28]);
    expect(notes.join(" | ")).not.toMatch(/graphic\d+ (holds|starts)/);

    const own = span(clips, "vc_08407e7de4");
    expect(own.start).toBeCloseTo(32.89, 3);
    expect(own.end).toBeCloseTo(39.33, 3);
    for (const p of own.pieces) expect(p.timelineEnd - p.timelineStart, p.id).toBeLessThanOrEqual(5 + 1e-6);
    noGaps(clips);
  });

  it("a REAL non-YouTube shot beside it still takes the time, exactly as before (the rule itself is unchanged)", () => {
    const yt = clip("yt", 0, 8);
    const ia = clip("ia_shot", 8, 12, { source: { provider: "internet_archive", providerAssetId: "x" } });
    const { clips, notes } = limitYoutubeShots({ clips: [yt, ia], youtube: new Map([["yt", oneShot(20)]]) });
    expect(clips.find((c) => c.id === "yt")!.timelineEnd).toBe(5);
    expect(clips.find((c) => c.id === "ia_shot")!.timelineStart).toBe(5);
    expect(notes.join(" ")).toContain("ia_shot starts 3.00s earlier");
  });

  it("a ground under a card is never a YouTube piece and never changes its opacity", () => {
    const before = ground("vc_a_graphic1", 0, 4);
    const yt = clip("vc_a", 4, 15);
    const { clips } = limitYoutubeShots({ clips: [before, yt], youtube: new Map([["vc_a", oneShot(30)]]) });
    const g = clips.filter((c) => c.id.startsWith("vc_a_graphic1"));
    expect(g).toHaveLength(1);
    expect(g[0]!.transform?.opacity).toBe(0);
  });
});

describe("E2 — an approved picture never disappears in silence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("FIT → ADOPTED → the scene: the approved answer comes back to the scene as approved (no APPROVED_NOT_PLACED)", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    const photo = "/tmp/scene_0_b0_primary_inet_img_serp_serp_0__pid_serpapi-22c4362d252b9807_transformed.mp4";
    vp.noteLadderForBeat(dedup, 0, 0, 0, Promise.resolve(photo));
    vp.noteApprovedPickForBeat(dedup, 0, 0, vp.clipContentKey(photo));
    await wait(5);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0)).toEqual([{ beatIndex: 0, clip: photo, approved: true }]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("APPROVED_NOT_PLACED");
  });

  it("approved, but the sentence's ladder settled WITHOUT a clip → named once: never reached the scene", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.noteLadderForBeat(dedup, 0, 0, 0, Promise.resolve(null));
    vp.noteApprovedPickForBeat(dedup, 0, 0, "serpapi:22c4362d252b9807");
    await wait(5);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0)).toEqual([]);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"));
    expect(lines).toEqual([
      "[APPROVED_NOT_PLACED] s0b0 reason=approved picture never reached the scene — the sentence's ladder settled without a clip",
    ]);
    expect(vp.approvedNotPlacedNoted(dedup, 0, 0)).toBe(true);
  });

  it("the ladder settling empty with NO approval is not an approved loss — nothing is named", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.noteLadderForBeat(dedup, 1, 2, 0, Promise.resolve(null));
    await wait(5);
    await vp.takeLateApprovedPicks(dedup, 1, 0);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("APPROVED_NOT_PLACED");
  });

  it("an answer that reached the push is the push's to explain ([PushTrace]) — not named a second time here", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.noteLadderForBeat(dedup, 0, 1, 0, Promise.resolve(null));
    vp.noteApprovedPickForBeat(dedup, 0, 1, "archive:60140");
    vp.noteOfferedToScene(dedup, 0, 1, "/tmp/scene_0_b1_curated_a60140.mp4");
    expect(vp.offeredToBeat(dedup, 0, 1)).toBe(true);
    expect(vp.offeredToBeat(dedup, 0, 2)).toBe(false);
    await wait(5);
    await vp.takeLateApprovedPicks(dedup, 0, 0);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("APPROVED_NOT_PLACED");
  });

  it("a reason is logged once per sentence, however many routes report it", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.noteApprovedNotPlaced(dedup, 2, 1, "first reason");
    vp.noteApprovedNotPlaced(dedup, 2, 1, "second reason");
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(["[APPROVED_NOT_PLACED] s2b1 reason=first reason"]);
  });

  it("every legitimate refusal route is named in the pipeline: technical check, failed ladder, push refusal, scene closed", () => {
    expect(PIPE).toContain("`technical check refused the approved picture: ${refusal}`");
    expect(PIPE).toContain("`the sentence's ladder failed: ${(err as Error)?.message ?? String(err)}`");
    expect(PIPE).toContain('"refused at the push (reason logged by [PushTrace])"');
    expect(PIPE).toContain('"approved picture never reached the scene before it closed (not handed to the push)"');
    expect(PIPE).toContain('"approved after scene closed — not placed"');
    /** The scene's last word runs after its late answers and its fill, then the scene is marked closed. */
    const end = PIPE.indexOf("await placeLateApprovedPicks(true);");
    expect(PIPE.indexOf("approvedNotPlacedNoted(dedup, scene.index, b.index)", end)).toBeGreaterThan(end);
    expect(PIPE.indexOf("markSceneClosed(dedup, scene.index);", end)).toBeGreaterThan(end);
  });
});

describe("E3 — a FIT after its scene closed: not placed, named, nothing else", () => {
  afterEach(() => vi.restoreAllMocks());

  it("634 s0b2: approved 62 s after scene 0 closed → named, no clip handed back, no crash, no second clip", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    /** the scene's end took its still-running search off the list ("no answer to place") */
    vp.noteLadderForBeat(dedup, 0, 2, 0, new Promise<string | null>(() => {}));
    expect(await vp.takeLateApprovedPicks(dedup, 0, 1)).toEqual([]);
    vp.markSceneClosed(dedup, 0);
    expect(vp.sceneIsClosed(dedup, 0)).toBe(true);

    expect(() => vp.noteApprovedPickForBeat(dedup, 0, 2, "youtube_cc:678709a1da058fd4@t3633d38")).not.toThrow();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"));
    expect(lines).toEqual(["[APPROVED_NOT_PLACED] s0b2 reason=approved after scene closed — not placed"]);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0), "nothing is handed to a closed scene").toEqual([]);

    /** a second late approval for the same sentence does not log twice */
    vp.noteApprovedPickForBeat(dedup, 0, 2, "youtube_cc:678709a1da058fd4@t3673d40");
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"))).toHaveLength(1);
  });

  it("an approval in a scene that is still open is not named (it may still be placed)", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.markSceneClosed(dedup, 0);
    vp.noteApprovedPickForBeat(dedup, 1, 0, "archive:1");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("APPROVED_NOT_PLACED");
  });
});
