/**
 * VIDEO 651, RENDER-JOB 56 — THE 5 s YOUTUBE RULE NEVER LENDS A SENTENCE'S SLOT TO ANOTHER SENTENCE,
 * AND NEVER STRETCHES A SHOT PAST ITS OWN SOURCE.
 *
 * Job 56 logged (server/youtubeShotLimit.ts, the VIDEO 622 "no repeat" branch):
 *   vc_11cf9744a2: no repeat — vc_cdcfeaf1cc holds 2.56s longer instead   → s1b1 showed 2.56 s of s1b0
 *   vc_5b95c3a774: no repeat — vc_4d5d30cfa9 starts 2.07s earlier instead → s1b3 showed s1b4's picture
 *   vc_4d5d30cfa9: 8.40s on screen … source holds 4.00s … the last 0.40s hold its final frame
 *                                                                          → s1b4: 0.12 s held past its source
 * The timelines below are rebuilt from those lines (scene 1; s1b0 16.52–21.29, s1b1 21.67–26.47,
 * s1b3 32.60–36.00, s1b4 36.73–42.78 spoken).
 *
 * VIDEO 658 (the owner's rule, later than 651): NO SLOW MOTION, EVER. A shot whose source runs out
 * plays at 1×, once, in order, and its LAST FRAME HOLDS the rest of its own slot (the camera move
 * keeps it alive). What 651 forbade still stands: a sentence never shows another sentence's picture,
 * and no source is ever read again from an earlier second.
 */
import { describe, expect, it } from "vitest";

import { limitYoutubeShots, YOUTUBE_MAX_SHOT_SEC, type YoutubeSourceFacts } from "./youtubeShotLimit";
import { limitLongShots } from "./longShotLimit";
import type { TimelineVideoClip } from "./projectTimeline";

const oneShot = (sourceDurationSec: number): YoutubeSourceFacts => ({ sourceDurationSec, cutsSec: [], measured: true });
const clip = (
  id: string,
  start: number,
  end: number,
  beatIndex: number | undefined,
  over: Partial<TimelineVideoClip> = {}
): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "archive", archiveAssetId: 1 },
  sourceIn: 0,
  sourceOut: end - start,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex: 1,
  ...(beatIndex == null ? {} : { beatIndex }),
  ...over,
});
const yt = (id: string, start: number, end: number, beatIndex: number) =>
  clip(id, start, end, beatIndex, { source: { provider: "youtube_cc", archiveAssetId: 2 }, sourceIn: 0, sourceOut: undefined });

/** Which sentence's clip is on screen at `t`. */
const beatAt = (clips: TimelineVideoClip[], t: number) =>
  clips.find((c) => !c.disabled && t >= c.timelineStart - 1e-6 && t < c.timelineEnd - 1e-6)?.beatIndex;
/** Seconds of [from, to) on which another sentence's clip is on screen. */
const otherSentenceSec = (clips: TimelineVideoClip[], beat: number, from: number, to: number) => {
  const steps = Math.round((to - from) / 0.01);
  let n = 0;
  for (let k = 0; k < steps; k++) if (beatAt(clips, from + (k + 0.5) * 0.01) !== beat) n++;
  return Number((n * 0.01).toFixed(2));
};
/** Every piece of one clip reads on from the piece before it — a held piece reads only the last frame. Never back. */
const neverReadsBack = (pieces: TimelineVideoClip[]) =>
  pieces.every((p, i) => i === 0 || (p.sourceIn ?? 0) >= (pieces[i - 1]!.sourceOut ?? 0) - 0.1);
const span = (clips: TimelineVideoClip[]) => ({
  start: Math.min(...clips.map((c) => c.timelineStart)),
  end: Math.max(...clips.map((c) => c.timelineEnd)),
});

describe("job 56 — s1b1: no 2.56 s of s1b0's picture", () => {
  /** s1b0's clip (4.77 s of source), then s1b1's 5.12 s YouTube clip whose source holds one 2.56 s window, then s1b2's YouTube. */
  const build = () => [
    clip("vc_cdcfeaf1cc", 16.52, 21.67, 0, { sourceOut: 4.77 }),
    yt("vc_11cf9744a2", 21.67, 26.79, 1),
    yt("vc_3d5d281d84", 26.79, 32.25, 2),
  ];
  const youtube = new Map([
    ["vc_11cf9744a2", oneShot(2.6)],
    ["vc_3d5d281d84", oneShot(60)],
  ]);

  it("s1b0's clip keeps its end and every spoken second of s1b1 shows s1b1's own picture", () => {
    const { clips, notes } = limitYoutubeShots({ clips: build(), youtube });
    expect(clips.find((c) => c.id === "vc_cdcfeaf1cc")!.timelineEnd).toBeCloseTo(21.67, 3);
    expect(notes.join("\n")).not.toContain("vc_cdcfeaf1cc holds");
    expect(otherSentenceSec(clips, 1, 21.67, 26.47)).toBe(0);
  });

  it("the YouTube clip plays its own source once at 1×, in pieces of at most 5 s, inside its own window; then its last frame holds (VIDEO 658)", () => {
    const { clips, notes } = limitYoutubeShots({ clips: build(), youtube });
    const pieces = clips.filter((c) => c.id.startsWith("vc_11cf9744a2"));
    expect(pieces.length).toBe(2);
    expect(notes.join("\n")).toContain("vc_11cf9744a2: the source holds 1 distinct 2.56s window(s) for 2 piece(s) — 1 hold the last frame instead of a repeat");
    for (const p of pieces) {
      expect(p.timelineEnd - p.timelineStart).toBeLessThanOrEqual(YOUTUBE_MAX_SHOT_SEC + 1e-6);
      expect(p.sourceOut!).toBeLessThanOrEqual(2.6 + 1e-6);
      expect(p.speed ?? 1, "no slow motion").toBe(1);
    }
    /** no window shown twice: the second piece only holds the first piece's last frame */
    expect(neverReadsBack(pieces)).toBe(true);
    expect(pieces[1]!.holdAtSourceOut).toBe(true);
    /** as the pipeline runs it: the long-shot rule after the YouTube rule — still s1b1's own picture */
    const long = limitLongShots({ clips }).clips;
    expect(otherSentenceSec(long, 1, 21.67, 26.47)).toBe(0);
    expect(span(clips)).toEqual({ start: 16.52, end: 32.25 });
  });
});

describe("job 56 — s1b3: no 1.34 s of s1b4's picture; s1b4: no still frame past its source", () => {
  /** s1b2's YouTube, s1b3's 4.14 s YouTube clip from a 3.92 s source, then s1b4's clip with 4.00 s of source. */
  const build = () => [
    yt("vc_3d5d281d84", 26.79, 32.25, 2),
    yt("vc_5b95c3a774", 32.25, 36.39, 3),
    clip("vc_4d5d30cfa9", 36.39, 42.72, 4, { sourceOut: 4.0 }),
  ];
  const youtube = new Map([
    ["vc_3d5d281d84", oneShot(60)],
    ["vc_5b95c3a774", oneShot(3.92)],
  ]);

  it("s1b4's clip does not start early: every spoken second of s1b3 shows s1b3's own picture", () => {
    const { clips, notes } = limitYoutubeShots({ clips: build(), youtube });
    expect(clips.find((c) => c.id === "vc_4d5d30cfa9")!.timelineStart).toBeCloseTo(36.39, 3);
    expect(notes.join("\n")).not.toContain("vc_4d5d30cfa9 starts");
    expect(otherSentenceSec(clips, 3, 32.6, 36.0)).toBe(0);
  });

  it("after the long-shot rule, s1b4's clip plays its 4.00 s once at 1×, in order, and its last frame holds the rest of ITS OWN slot (VIDEO 658)", () => {
    const limited = limitYoutubeShots({ clips: build(), youtube });
    const long = limitLongShots({ clips: limited.clips });
    const s1b4 = long.clips.filter((c) => c.id.startsWith("vc_4d5d30cfa9"));
    expect(long.notes.join("\n")).toMatch(/vc_4d5d30cfa9: .*played at 1× speed, once, in order; the last 2\.33s hold its final frame/);
    expect(s1b4.every((c) => c.speed === 1)).toBe(true);
    expect(neverReadsBack(s1b4)).toBe(true);
    expect(s1b4.at(-1)!.holdAtSourceOut).toBe(true);
    expect(s1b4.at(-1)!.sourceOut).toBe(4);
    /** the held seconds are s1b4's own picture: never another sentence's */
    expect(otherSentenceSec(long.clips, 4, 36.73, 42.72)).toBe(0);
    expect(span(long.clips)).toEqual({ start: 26.79, end: 42.72 });
  });
});

describe("the rule for a neighbour: same sentence, and its own source fills the time", () => {
  /** A 10 s YouTube slot from a 4 s source: two of its pieces would repeat; 5 s go to a neighbour or are slowed. */
  const facts = new Map([["y", oneShot(4)]]);

  it("a neighbour of the SAME sentence with enough source takes the time, as before", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("own", 0, 4, 1, { sourceOut: 30 }), yt("y", 4, 14, 1)],
      youtube: facts,
    });
    expect(notes.join("\n")).toContain("no repeat — own holds");
    expect(clips[0]!.timelineEnd).toBeGreaterThan(4);
    expect(span(clips)).toEqual({ start: 0, end: 14 });
  });

  it("a neighbour of ANOTHER sentence does not, however much source it has", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("other", 0, 4, 0, { sourceOut: 30 }), yt("y", 4, 14, 1)],
      youtube: facts,
    });
    expect(clips[0]!.timelineEnd).toBe(4);
    expect(notes.join("\n")).not.toContain("other holds");
    expect(otherSentenceSec(clips, 1, 4, 14)).toBe(0);
  });

  it("a neighbour of the same sentence whose source is too short does not either — no still frame", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("short", 0, 4, 1, { sourceOut: 4 }), yt("y", 4, 14, 1)],
      youtube: facts,
    });
    expect(clips[0]!.timelineEnd).toBe(4);
    expect(notes.join("\n")).not.toContain("short holds");
    const long = limitLongShots({ clips });
    /** the neighbour is not stretched into a still */
    expect(long.notes.join("\n")).not.toMatch(/^short: .*hold its final frame/m);
    /**
     * VIDEO 656 — the YouTube clip's own tail used to repeat a window here; it now plays slower and
     * holds its last frame (a held piece, `holdAtSourceOut`), placed on purpose — not stretched again.
     */
    expect(long.clips.find((c) => c.id === "short")!.timelineEnd).toBe(4);
    expect(long.notes.join("\n")).not.toMatch(/^y_p\d+: .*hold its final frame/m);
  });

  it("step 1 (over 5 s): a same-sentence neighbour with too little source does not take the excess; the clip is cut instead", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [yt("y", 0, 9, 1), clip("short", 9, 12, 1, { sourceOut: 3.1 })],
      youtube: new Map([["y", oneShot(60)]]),
    });
    expect(clips.find((c) => c.id === "short")!.timelineStart).toBe(9);
    expect(notes.join("\n")).toContain("y: no non-YouTube shot beside it");
    for (const p of clips.filter((c) => c.id.startsWith("y"))) {
      expect(p.timelineEnd - p.timelineStart).toBeLessThanOrEqual(YOUTUBE_MAX_SHOT_SEC + 1e-6);
    }
  });

  it("step 1: a same-sentence neighbour with enough source still takes the excess, unchanged", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [yt("y", 0, 7, 1), clip("own", 7, 10, 1, { sourceOut: 30 })],
      youtube: new Map([["y", oneShot(60)]]),
    });
    expect(notes.join("\n")).toContain("y: 7.00s of YouTube → 5s; own starts 2.00s earlier to fill it");
    expect(clips.find((c) => c.id === "own")!.timelineStart).toBe(5);
  });
});

describe("the related refusal branch (RONDE 654): a clip that cannot be cut gives its slot only to its own sentence", () => {
  /** Unmeasured shot boundaries: the plan is refused and the whole slot goes to a neighbour — or the clip stays. */
  const unmeasured = new Map([["y", { sourceDurationSec: 30, cutsSec: [], measured: false } as YoutubeSourceFacts]]);

  it("the previous shot of another sentence does not take it; the next shot of the same sentence, with source, does", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("prevOther", 0, 4, 0, { sourceOut: 30 }), yt("y", 4, 8, 1), clip("nextOwn", 8, 12, 1, { sourceOut: 30 })],
      youtube: unmeasured,
    });
    expect(clips.find((c) => c.id === "prevOther")!.timelineEnd).toBe(4);
    expect(clips.find((c) => c.id === "nextOwn")!.timelineStart).toBe(4);
    expect(notes.join("\n")).toContain("nextOwn starts 4.00s earlier instead");
  });

  it("with only other sentences, or too little source, beside it, the clip stays where it was (KEPT_UNCUT)", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("prevOther", 0, 4, 0, { sourceOut: 30 }), yt("y", 4, 8, 1), clip("nextShort", 8, 9, 1, { sourceOut: 1 })],
      youtube: unmeasured,
    });
    expect(notes.join("\n")).toContain("y: KEPT_UNCUT");
    expect(clips.find((c) => c.id === "prevOther")!.timelineEnd).toBe(4);
    expect(clips.find((c) => c.id === "nextShort")!.timelineStart).toBe(8);
    expect(otherSentenceSec(clips, 1, 4, 8)).toBe(0);
  });
});

describe("unchanged for clips that do not say their sentence or their source end", () => {
  it("the earlier rule applies (no beatIndex, no sourceOut)", () => {
    const { notes } = limitYoutubeShots({
      clips: [clip("a", 0, 4, undefined, { sourceOut: undefined }), yt("y", 4, 14, 1)],
      youtube: new Map([["y", oneShot(4)]]),
    });
    expect(notes.join("\n")).toContain("no repeat — a holds");
  });
});

describe("a YouTube source shorter than its slot, with nobody to take the time", () => {
  it("is played once at 1× within its own source — never past it, never back to its start; its last frame holds the rest (VIDEO 658)", () => {
    const { clips } = limitYoutubeShots({
      clips: [clip("other", 0, 4, 0), yt("y", 4, 10, 1), clip("other2", 10, 14, 2)],
      youtube: new Map([["y", oneShot(3.5)]]),
    });
    const pieces = clips.filter((c) => c.id.startsWith("y"));
    for (const p of pieces) {
      expect(p.sourceOut!).toBeLessThanOrEqual(3.5 + 1e-6);
      expect(p.speed ?? 1, "no slow motion").toBe(1);
    }
    expect(neverReadsBack(pieces)).toBe(true);
    /** only the pieces past the source hold its last frame, and they are marked as such */
    expect(pieces.slice(1).every((p) => p.holdAtSourceOut === true)).toBe(true);
    expect(otherSentenceSec(clips, 1, 4, 10)).toBe(0);
    expect(span(clips)).toEqual({ start: 0, end: 14 });
  });
});
