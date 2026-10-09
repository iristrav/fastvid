import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import type { TimelineVideoClip } from "./projectTimeline";
import type { VideoYoutubePool } from "./youtubeVideoPool";

/**
 * STEP 0 (QUALITY RESCUE) — FIRST USE THE FOOTAGE THE RENDER ALREADY HAS.
 *
 * Before a sentence gets a card or a generated image, its last look (`finalReadyYoutubeLook`, run by
 * `runFinalReadyYoutubeStage` as the pipeline runs it) also judges the YouTube moments this render has
 * on disk for OTHER sentences — through the same picture editor, inside the same ceilings, placed by the
 * same final pass. Driven here through the real stage and the real late placement; the picture editor is
 * a stand-in that records its verdicts exactly like `adoptClip` does. Moments are real 6 s files.
 *
 * The five cases asked for: (1) a suitable downloaded picture is still placed; (2) an unsuitable one is
 * refused and the sentence keeps its fallback; (3) a picture of a video already in the film is reused
 * only for other seconds; (4) when truly nothing is left, no look is spent; (5) a targeted picture is
 * never handed to another sentence. Plus the guards: the owner first, one judge at a time, the ceilings.
 */

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-step0-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let logs: string[] = [];
const capture = () => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => void logs.push(String(m)));
};

const hashOf = (youtubeId: string) => vp.providerAssetKey("youtube_cc", youtubeId).split(":")[1]!;
let n = 0;
/** A real moment file of `youtubeId` at `startSec`, named exactly as `fetchYouTubeCCClips` names one. */
function moment(youtubeId: string, startSec: number, seconds = 6, durTag = 40): string {
  const p = path.join(dir, `scene_0_ytfu_${n++}_t${startSec * 10}d${durTag}__pid_youtube_cc-${hashOf(youtubeId)}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
  return p;
}

const beat = (index: number, text: string) => ({ index, text, holdSec: 3.5, keywords: [] as string[] });
function renderState(beats: ReturnType<typeof beat>[]) {
  return {
    lateYoutubeCandidates: [] as string[],
    beatRelevance: bvr.createBeatRelevanceLedger(),
    beatImageGate: { judgementAttempts: 0, judgementsFits: 0, judgementsMismatch: 0 },
    visionReviewPool: { beats: new Map() },
    usedContentKeys: new Set<string>(),
    usedPaths: new Set<string>(),
    refusedAssetsThisRender: new Map<string, string>(),
    sceneBeatsBySceneIndex: new Map([[0, beats]]),
  };
}
type State = ReturnType<typeof renderState>;
const asDedup = (d: State) => d as unknown as Parameters<VP["runFinalReadyYoutubeStage"]>[0];
const sceneResult = (clipBeatIndices: number[]) => ({
  clips: clipBeatIndices.map((b) => `/w/scene_clip_b${b}.mp4`),
  beatDurations: clipBeatIndices.map(() => 3.5),
  clipBeatIndices,
});
const FAST = { windowMs: 50, looksMs: 10_000 };
const FINAL = { sceneReturned: true, final: true } as const;

/** The picture editor as `adoptClip` reports it, for the sentence it is asked for: one look per unjudged moment. */
function editor(d: State, fits: (p: string, beatIndex: number) => boolean) {
  return vi.fn(async (b: { index: number }, s: number, paths: string[]) => {
    for (const p of paths) {
      const key = bvr.beatRelevanceBeatKey(s, b.index, "path", p);
      if (!d.beatRelevance.byBeat.has(key)) {
        d.beatRelevance.spendByBeat.set(`s${s}b${b.index}`, (d.beatRelevance.spendByBeat.get(`s${s}b${b.index}`) ?? 0) + 1);
        d.beatImageGate.judgementAttempts++;
        const ok = fits(p, b.index);
        if (ok) d.beatImageGate.judgementsFits++;
        else d.beatImageGate.judgementsMismatch++;
        const decision = { decision: { verdict: ok ? "fits" : "does_not_fit", evaluated: true } } as never;
        d.beatRelevance.byBeat.set(key, decision);
        /** Filed under the picture's identity too, as the ledger does: a refusal for one sentence is known to the others. */
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(s, b.index, "content", vp.clipContentKey(p)), decision);
      }
      if (fits(p, b.index)) {
        vp.noteApprovedPickForBeat(d, s, b.index, vp.clipContentKey(p));
        return p;
      }
    }
    return null;
  });
}
/** The sentence's own turn handed it these moments (`noteYoutubeAssigned` through the lookahead). */
function handTo(d: object, b: number, paths: string[]) {
  for (const p of paths) vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(0, b), p);
  return vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(0, b));
}
function closedScene(d: object) {
  const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 3.5 }));
  vp.openLatePlacement(d, 0, placer);
  vp.markSceneClosed(d, 0);
  return placer;
}
const offeredTo = (look: ReturnType<typeof editor>, beatIndex: number) =>
  look.mock.calls.filter((c) => c[0].index === beatIndex).flatMap((c) => c[2] as string[]);

/* ═══════════════════════ the five cases ═══════════════════════ */

describe("STEP 0 — the render's own footage before any card", () => {
  it("TEST 1 — a suitable picture downloaded for another sentence is judged on its frames and placed; the card is avoided", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "nothing of its own")]);
    const placer = closedScene(d);
    const spare = moment("spareVideo01", 120);
    /** s0b0 was handed it and got its picture elsewhere; s0b1 was handed nothing. */
    handTo(d, 0, [spare]);
    const look = editor(d, (p, b) => b === 1 && p === spare);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(offeredTo(look, 1)).toEqual([spare]);
    expect(offeredTo(look, 0)).toEqual([]);
    /** Placed by the same final pass every late approval takes. */
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 1, clip: spare, hold: 3.5 }]);
    expect(placer).toHaveBeenCalledWith(spare, 1);
    const inv = vp.inventoryTally(d);
    expect(inv.offered).toBe(1);
    expect([...inv.approved]).toEqual([[vp.clipContentKey(spare), "s0b1"]]);
    expect(logs.some((l) => l.startsWith("[LastChance] s0b1 inventory seen=1 offered=1"))).toBe(true);
    expect(logs.some((l) => l.includes("approved") && l.includes("(from the render's inventory)"))).toBe(true);
  });

  it("TEST 2 — an unsuitable picture is refused by the picture editor: nothing placed, the sentence keeps its fallback, the refusal is a verdict", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "the wrong footage")]);
    closedScene(d);
    const wrong = moment("wrongVideo01", 300);
    handTo(d, 0, [wrong]);
    const look = editor(d, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(offeredTo(look, 1)).toEqual([wrong]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([]);
    expect(vp.approvedPicksForBeat(d, 0, 1)).toBe(0);
    expect(bvr.pictureLookedAtOnBeat(d.beatRelevance, wrong, vp.clipContentKey(wrong), 0, 1)).toBe(true);
    expect(vp.inventoryTally(d).approved.size).toBe(0);
    expect(logs.some((l) => l.startsWith("[FinalReadyYouTube] s0b1 review completed — no fit"))).toBe(true);
    /** Asked again in a second stage: the verdict holds — never judged twice for the same sentence. */
    look.mockClear();
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(offeredTo(look, 1)).toEqual([]);
  });

  it("TEST 3 — a video already in the film: other seconds may be reused for another sentence, the same or overlapping seconds never", async () => {
    capture();
    const d = renderState([beat(0, "shows t100"), beat(1, "nothing of its own")]);
    closedScene(d);
    const inFilm = moment("reuseVideo01", 100);
    const overlapping = moment("reuseVideo01", 102);
    const otherSeconds = moment("reuseVideo01", 500);
    handTo(d, 0, [inFilm, overlapping, otherSeconds]);
    /** s0b0 shows t100: its seconds are in the film. */
    d.usedContentKeys.add(vp.clipContentKey(inFilm));
    d.usedPaths.add(inFilm);
    const look = editor(d, (p, b) => b === 1 && p === otherSeconds);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(offeredTo(look, 1)).toEqual([otherSeconds]);
    expect(vp.inventoryTally(d).excluded).toMatchObject({ seconds_in_film: 2 });
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 1, clip: otherSeconds, hold: 3.5 }]);
    /** It must fit THIS sentence too: the picture editor's FIT for s0b1, not the earlier use, put it there. */
    expect(vp.pictureApprovedForBeat(d, 0, 1, vp.clipContentKey(otherSeconds))).toBe(true);
  });

  it("TEST 4 — truly nothing suitable left: no look is spent, the sentence gets its card with the reason it had", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "nothing at all")]);
    closedScene(d);
    const shown = moment("onlyVideo001", 40);
    const black = moment("onlyVideo001", 900);
    const short = moment("onlyVideo001", 700, 2.2);
    handTo(d, 0, [shown, black, short]);
    d.usedContentKeys.add(vp.clipContentKey(shown));
    d.refusedAssetsThisRender.set(vp.clipContentKey(black), "mostly_black");
    const look = editor(d, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    expect(look).not.toHaveBeenCalled();
    expect(vp.inventoryTally(d).excluded).toMatchObject({ seconds_in_film: 1, refused_everywhere: 1, too_short: 1 });
    expect(logs.some((l) => l.startsWith("[LastChance] s0b1 inventory seen=3 offered=0"))).toBe(true);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([]);
    const { createRejectionRegistry } = await import("./rejectionRegistry");
    expect(vp.graphicOnlyReasonFor({ rejections: createRejectionRegistry() } as never, 0, 1)).toBe("NO_CANDIDATES");
  });

  it("TEST 5 — a targeted picture is never handed to another sentence; its own sentence still gets it", async () => {
    capture();
    const sentences = ["The family dinner was loud.", "Kendall walks the runway in Paris."];
    const pool = {
      videoId: 5501,
      sentences,
      query1: "family",
      query2: null,
      searches: 2,
      candidates: [
        { videoId: "kendallRunwy", title: "Kendall Jenner runway", description: "Paris show", thumb: "", durationSec: 600, footageType: "real_footage", serves: [], from: 2, usable: true, why: "ok" },
        { videoId: "dinnerVideo1", title: "Family dinner", description: "dinner", thumb: "", durationSec: 600, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" },
      ],
      entityTargets: [{ name: "Kendall Jenner", kind: "name", beats: [1], reason: "not covered", n: 2, query: "Kendall Jenner", score: 3 }],
      coverage1: 0, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 0, decided: true,
    } as unknown as VideoYoutubePool;
    const runway = moment("kendallRunwy", 60);
    const unknown = moment("notInThePool", 60);
    /** The targeted moment was handed to s0b2 (a third sentence that got its picture); s0b0 and s0b1 are empty. */
    const d = renderState([beat(0, sentences[0]!), beat(1, sentences[1]!), beat(2, "a third sentence")]);
    closedScene(d);
    handTo(d, 2, [runway, unknown]);
    const look = editor(d, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([2])], look, FAST, undefined, (b) =>
      vp.poolInventoryCheck(pool, 5501, b)
    );
    /** s0b0 is not a sentence the Kendall search was made for: never offered there. */
    expect(offeredTo(look, 0)).not.toContain(runway);
    /** s0b1 is: offered there. A moment whose video the pool cannot name is offered nowhere. */
    expect(offeredTo(look, 1)).toEqual([runway]);
    expect([...offeredTo(look, 0), ...offeredTo(look, 1)]).not.toContain(unknown);
    expect(vp.inventoryTally(d).excluded).toMatchObject({ targeted_other_sentence: 1, video_unknown: 2 });
    /** The rule as a function: targeted → only where it serves; not targeted → anywhere, serving first. */
    expect(vp.poolInventoryCheck(pool, 5501, { text: sentences[0]! })(runway)).toEqual({ allowed: false, reason: "targeted_other_sentence" });
    expect(vp.poolInventoryCheck(pool, 5501, { text: sentences[1]! })(runway)).toEqual({ allowed: true, serves: true });
    expect(vp.poolInventoryCheck(null, 5501, { text: sentences[1]! })(runway)).toEqual({ allowed: false, reason: "video_unknown" });
  });
});

/* ═══════════════════════ the guards around it ═══════════════════════ */

describe("STEP 0 — guards: the owner first, one judge at a time, the ceilings unchanged", () => {
  it("a moment handed to a sentence whose own last look has not judged it yet stays that sentence's", async () => {
    capture();
    const d = renderState([beat(0, "empty, first in line"), beat(1, "empty, owns the moment")]);
    closedScene(d);
    const owned = moment("ownedVideo01", 200);
    handTo(d, 1, [owned]);
    /** s0b0 runs first; s0b1's look has not judged `owned` yet. */
    const look = editor(d, (p, b) => b === 1 && p === owned);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([])], look, FAST);
    expect(offeredTo(look, 0)).toEqual([]);
    expect(offeredTo(look, 1)).toEqual([owned]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 1, clip: owned, hold: 3.5 }]);
  });

  it("once the owner's last look is over, what it did not take is free for a sentence whose look starts later", async () => {
    capture();
    /** Three looks run at once: s0b0–s0b2 start together, s0b3 only when a place is free. */
    const d = renderState([beat(0, "owner"), beat(1, "empty"), beat(2, "empty"), beat(3, "starts later")]);
    closedScene(d);
    const owned = [10, 60, 110, 160, 210, 260].map((t) => moment("ownerVideo01", t));
    handTo(d, 0, owned);
    const look = editor(d, (p, b) => b === 3 && p === owned[5]);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([])], look, FAST);
    expect(offeredTo(look, 1)).toEqual([]);
    expect(offeredTo(look, 2)).toEqual([]);
    /** The owner judged five and is done; the sixth (never judged) goes first, its five refusals last. */
    expect(offeredTo(look, 3)[0]).toBe(owned[5]);
    expect(await vp.placeApprovedAfterSceneClosed(d, 0, FINAL)).toEqual([{ beatIndex: 3, clip: owned[5], hold: 3.5 }]);
  });

  it("a moment whose video serves the sentence is judged before one that does not, when one look is left", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "empty")]);
    closedScene(d);
    const own = [10, 60, 110, 160].map((t) => moment("ownVideo0002", t));
    handTo(d, 1, own);
    const other = moment("otherVideo01", 10);
    const serving = moment("servingVid01", 10);
    handTo(d, 0, [other, serving]);
    const look = editor(d, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST, undefined, () => (p) => ({
      allowed: true,
      serves: p === serving,
    }));
    expect(offeredTo(look, 1)).toEqual([...own, serving]);
  });

  it("two empty sentences never judge the same inventory moment at once; a moment one approved is not offered to the other", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "empty A"), beat(2, "empty B")]);
    closedScene(d);
    const spare = moment("sharedVideo1", 80);
    handTo(d, 0, [spare]);
    const look = editor(d, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    const takers = [1, 2].filter((b) => offeredTo(look, b).includes(spare));
    expect(takers.length).toBe(1);
    const placed = await vp.placeApprovedAfterSceneClosed(d, 0, FINAL);
    expect(placed).toEqual([{ beatIndex: takers[0], clip: spare, hold: 3.5 }]);
  });

  it("inventory never buys a look past the sentence's 5 or the render's 120; own moments are judged first", async () => {
    capture();
    const d = renderState([beat(0, "has its picture"), beat(1, "empty")]);
    closedScene(d);
    const own = [moment("ownVideo0001", 10), moment("ownVideo0001", 60), moment("ownVideo0001", 110), moment("ownVideo0001", 160)];
    handTo(d, 1, own);
    const spares = [moment("spareVideo02", 10), moment("spareVideo02", 60), moment("spareVideo02", 110)];
    handTo(d, 0, spares);
    const look = editor(d, () => false);
    await vp.runFinalReadyYoutubeStage(asDedup(d), [{ index: 0 }], [sceneResult([0])], look, FAST);
    const seen = offeredTo(look, 1);
    expect(seen.length).toBe(bvr.maxRelevanceLooksPerBeat());
    expect(seen.slice(0, own.length)).toEqual(own);
    /** Only the one look left after its own four is taken from the inventory — and only that one is held. */
    expect(logs.some((l) => l.startsWith("[LastChance] s0b1 inventory seen=3 offered=1 "))).toBe(true);
    expect(d.beatRelevance.spendByBeat.get("s0b1")).toBe(bvr.maxRelevanceLooksPerBeat());

    /** At the render's ceiling, no inventory moment is even measured. */
    capture();
    const d2 = renderState([beat(0, "has its picture"), beat(1, "empty")]);
    closedScene(d2);
    handTo(d2, 0, [moment("spareVideo03", 10)]);
    const { maxBeatImageJudgementsPerRender } = await import("./beatImageRelevanceGate");
    d2.beatImageGate.judgementAttempts = maxBeatImageJudgementsPerRender();
    const look2 = editor(d2, () => true);
    await vp.runFinalReadyYoutubeStage(asDedup(d2), [{ index: 0 }], [sceneResult([0])], look2, FAST);
    expect(look2).not.toHaveBeenCalled();
  });

  it("no search, no download: the inventory reads only files already on disk", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("export async function youtubeInventoryForBeat(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).not.toMatch(/fetchYouTubeCCClips|downloadYouTubeCCClip|searchYouTube|runCentralYoutubeTurn|claimYoutubeDownloadSlot|buildVideoYoutubePool/);
    /** And the pipeline wires the pool's rule (targeted, serving) into the stage. */
    expect(PIPE).toContain("(beat) => poolInventoryCheck(lateStockPool, videoId, beat)");
  });
});

/* ═══════════════════════ [QualityRescue] ═══════════════════════ */

describe("STEP 0 — [QualityRescue]: what the viewer got, from the rendered timeline", () => {
  const clip = (id: string, s: number, b: number, start: number, end: number, extra: Partial<TimelineVideoClip> = {}) =>
    ({ id, kind: "video", sceneIndex: s, beatIndex: b, timelineStart: start, timelineEnd: end, source: { provider: "youtube_cc" } , ...extra }) as TimelineVideoClip;

  it("moving, still, card and grey seconds; sentences with moving footage; pieces of one shot count once", async () => {
    const { qualitySecondsOfTimeline } = await import("./qualityRescue");
    const clips = [
      clip("vc_a_p0", 0, 0, 0, 4),
      clip("vc_a_p1", 0, 0, 4, 6),
      clip("vc_still", 0, 1, 6, 10, { kind: "image" }),
      clip("vc_card", 0, 2, 10, 14, { transform: { opacity: 0 } as never }),
      /** 14–16: nothing on the track */
      clip("vc_b", 0, 3, 16, 20),
      clip("vc_off", 0, 3, 20, 30, { disabled: true }),
    ];
    const sentences = [0, 1, 2, 3, 4].map((b) => ({ sceneIndex: 0, beatIndex: b }));
    const q = qualitySecondsOfTimeline(clips, sentences, "rendered_timeline");
    expect(q).toMatchObject({
      filmSec: 20,
      realMovingSec: 10,
      stillSec: 4,
      cardSec: 4,
      greySec: 2,
      sentences: 5,
      sentencesWithMoving: 2,
      renderedShots: 3,
    });
  });

  it("a number the render does not have is printed UNKNOWN, never 0; a second render's head start is named", async () => {
    const { formatQualityRescue } = await import("./qualityRescue");
    const lines = formatQualityRescue(
      643,
      null,
      { foundVideos: 15, downloadedVideos: null, deliveredTransfers: null, judged: 40, mismatch: 30, approved: 3, placed: 2, lossCauses: { DUPLICATE: 1 } },
      { sentencesOffered: 2, offered: 3, approved: 1, placed: 1, excluded: { owner_still_looking: 2 } },
      { poolSearchesBefore: 3, poolUsableBefore: 15, poolUsable: 15, archiveUsable: 19, prefetchedBefore: 1, viaArchiveSec: null }
    );
    expect(lines[0]).toContain("basis=unmeasured");
    expect(lines[0]).toContain("downloadedVideos=UNKNOWN");
    expect(lines[0]).toContain("renderedShots=UNKNOWN");
    expect(lines[0]).toContain("approvedNotPlaced=1 {DUPLICATE=1}");
    expect(lines[0]).toContain("inventory sentences=2 offered=3 approved=1 placed=1 excluded={owner_still_looking=2}");
    expect(lines[1]).toContain("poolSearchesBefore=3");
    expect(lines[1]).toContain("viaArchiveSec=UNKNOWN");
    expect(lines[1]).toContain("REUSED");
    expect(lines[1]).toContain("ARCHIVE_HEAD_START");
    const fresh = formatQualityRescue(1, null, { foundVideos: null, downloadedVideos: null, deliveredTransfers: null, judged: null, mismatch: null, approved: null, placed: null },
      { sentencesOffered: 0, offered: 0, approved: 0, placed: null, excluded: {} },
      { poolSearchesBefore: 0, poolUsableBefore: 0, poolUsable: null, archiveUsable: null, prefetchedBefore: 0, viaArchiveSec: null });
    expect(fresh[1]).not.toContain("REUSED");
    expect(fresh[1]).not.toContain("ARCHIVE_HEAD_START");
    expect(fresh[0]).toContain("approvedNotPlaced=UNKNOWN");
  });

  it("the baseline is read without writing: the prefetch count is a select, null without a database", async () => {
    const { prefetchedIntoArchiveBefore } = await import("./youtubePrefetch");
    expect(await prefetchedIntoArchiveBefore([], new Date())).toBe(0);
    const PF = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");
    const at = PF.indexOf("export async function prefetchedIntoArchiveBefore(");
    const body = PF.slice(at, PF.indexOf("\n}\n", at));
    expect(body).toContain(".select(");
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
    /** The pipeline prints it beside [YouTubeInFilm], from the registers the render already keeps. */
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("for (const l of formatQualityRescue(");
    expect(PIPE.indexOf("for (const l of formatQualityRescue(")).toBeLessThan(PIPE.indexOf("closeYoutubeDownloadFunnel();\n    }"));
  });

  it("the pool's start is what this attempt found before any search of its own, read once", async () => {
    const { buildVideoYoutubePool, takeYoutubePoolStart } = await import("./youtubeVideoPool");
    const { memoryYoutubeSearchBudgetStore } = await import("./youtubeSearchBudget");
    const store = memoryYoutubeSearchBudgetStore();
    const stored = { videoId: 7701, sentences: [], query1: "q", query2: null, searches: 4, candidates: [
      { videoId: "a", title: "t", description: "d", thumb: "", durationSec: 600, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" },
    ], coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true };
    await store.record(7701, { searchCount: 4, poolJson: JSON.stringify(stored) } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const search = vi.fn();
    await buildVideoYoutubePool(
      { store, search, details: vi.fn(), namedSubjects: () => [], log: () => {} } as never,
      { videoId: 7701, prompt: "Harbour", title: "Harbour", sceneTexts: ["The harbour works through the night."] }
    );
    /** A later render of this video: the searches were spent before, nothing is searched now. */
    expect(search).not.toHaveBeenCalled();
    expect(takeYoutubePoolStart(7701)).toEqual({ searchesBefore: 4, candidatesBefore: 1, usableBefore: 1 });
    expect(takeYoutubePoolStart(7701)).toBeNull();
  });
});
