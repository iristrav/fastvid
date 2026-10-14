/**
 * VIDEO 656 — the same seconds of footage are never on screen twice (`removeRepeatedFootage`).
 *
 * Replays the two repeats of render 656: a 2.87 s window of one YouTube shot played three times in
 * a row (vc_c94d525f36_p1..p3, 9.13–17.75 s), and a 3 s clip shown again seven seconds later as a
 * filler (vc_032cede8cd_fill1). Where no different footage is left, the last frame holds
 * (`holdAtSourceOut`, which the renderer reads as the end of the read).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { footageKey, removeRepeatedFootage, sourceWindow } from "./noRepeatedFootage";
import type { TimelineVideoClip } from "./projectTimeline";

const clip = (
  id: string,
  archiveAssetId: number,
  start: number,
  end: number,
  sourceIn: number,
  sourceOut?: number,
  extra: Partial<TimelineVideoClip> = {}
): TimelineVideoClip =>
  ({
    id,
    kind: "video",
    source: { provider: "youtube_cc", archiveAssetId },
    timelineStart: start,
    timelineEnd: end,
    sourceIn,
    ...(sourceOut != null ? { sourceOut } : {}),
    ...extra,
  }) as TimelineVideoClip;

const ids = (cs: TimelineVideoClip[]) => cs.map((c) => c.id);
const span = (cs: TimelineVideoClip[]) => [Math.min(...cs.map((c) => c.timelineStart)), Math.max(...cs.map((c) => c.timelineEnd))];
/** No two kept clips of the same footage overlap in source seconds. */
function noRepeats(cs: TimelineVideoClip[]): boolean {
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      if (footageKey(cs[i]!) !== footageKey(cs[j]!)) continue;
      const a = sourceWindow(cs[i]!);
      const b = sourceWindow(cs[j]!);
      if (Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0.25) return false;
    }
  }
  return true;
}

describe("656 replayed", () => {
  it("three pieces of one 2.87 s window: the first plays on, slower, over the other two", () => {
    const film = [
      clip("vc_032cede8cd", 60952, 0, 3, 0, 3),
      clip("vc_36934b199e", 60948, 3, 9.13, 0, 4),
      clip("vc_c94d525f36_p1", 60944, 9.13, 12, 0.5, 3.37),
      clip("vc_c94d525f36_p2", 60944, 12, 14.87, 0.5, 3.37),
      clip("vc_c94d525f36_p3", 60944, 14.87, 17.75, 0.5, 3.37),
      clip("vc_bf2d3d8496_p1", 60949, 17.75, 20, 0, 2.25),
    ];
    const { clips, notes } = removeRepeatedFootage(film);
    expect(ids(clips)).toEqual(["vc_032cede8cd", "vc_36934b199e", "vc_c94d525f36_p1", "vc_bf2d3d8496_p1"]);
    const p1 = clips[2]!;
    expect(p1.timelineStart).toBe(9.13);
    expect(p1.timelineEnd).toBe(17.75);
    /** 2.87 s over 8.62 s would be 0.33×: it plays at the renderer's floor and its last frame holds */
    expect(p1.speed).toBe(0.5);
    expect(p1.sourceOut).toBe(3.37);
    expect(p1.holdAtSourceOut).toBe(true);
    expect(span(clips)).toEqual(span(film));
    expect(noRepeats(clips)).toBe(true);
    expect(notes.filter((n) => n.includes("REMOVED"))).toHaveLength(2);
  });

  it("a filler that shows a clip's own seconds again is taken out; the shot before it plays on", () => {
    const film = [
      clip("vc_032cede8cd", 60952, 0, 3, 0, 3),
      clip("vc_36934b199e", 60948, 3, 7, 0, 4),
      clip("vc_032cede8cd_fill1", 60952, 7, 9.12, 0, 2.12),
      clip("vc_c94d525f36", 60944, 9.12, 12, 0.5, 3.37),
    ];
    const { clips } = removeRepeatedFootage(film);
    expect(ids(clips)).toEqual(["vc_032cede8cd", "vc_36934b199e", "vc_c94d525f36"]);
    expect(clips[1]!.timelineEnd).toBe(9.12);
    expect(noRepeats(clips)).toBe(true);
  });
});

describe("what is and is not a repeat", () => {
  it("different seconds of the same source are different pictures", () => {
    const film = [clip("a", 1, 0, 3, 0, 3), clip("b", 2, 3, 6, 0, 3), clip("c", 1, 6, 9, 10, 13)];
    expect(ids(removeRepeatedFootage(film).clips)).toEqual(["a", "b", "c"]);
  });

  it("windows that only touch on a cut point are not a repeat", () => {
    const film = [clip("a", 1, 0, 3, 0, 3), clip("b", 1, 3, 6, 2.9, 5.9)];
    expect(ids(removeRepeatedFootage(film).clips)).toEqual(["a", "b"]);
  });

  it("the same still twice is a repeat, whatever the camera does", () => {
    const still = (id: string, s: number, e: number) =>
      ({ id, kind: "image", source: { provider: "wikimedia", providerAssetId: "File:X.jpg" }, timelineStart: s, timelineEnd: e }) as TimelineVideoClip;
    const film = [still("s1", 0, 4), clip("m", 5, 4, 8, 0, 4), still("s2", 8, 12)];
    const { clips } = removeRepeatedFootage(film);
    expect(ids(clips)).toEqual(["s1", "m"]);
    expect(clips[1]!.timelineEnd).toBe(12);
  });

  it("a clip the customer placed by hand is never taken out", () => {
    const film = [clip("a", 1, 0, 3, 0, 3), clip("b", 1, 3, 6, 0, 3, { editedByUser: true })];
    expect(ids(removeRepeatedFootage(film).clips)).toEqual(["a", "b"]);
  });

  it("the ground under a graphic is not footage; a repeat after it lets the next shot start earlier", () => {
    const backdrop = clip("graphic_bg", 99, 3, 6, 0, 3);
    const film = [clip("a", 1, 0, 3, 0, 3), backdrop, clip("a_again", 1, 6, 9, 0, 3), clip("b", 2, 9, 12, 0, 3)];
    const { clips } = removeRepeatedFootage(film, { skip: (c) => c.id === "graphic_bg" });
    expect(ids(clips)).toEqual(["a", "graphic_bg", "b"]);
    expect(clips[2]!.timelineStart).toBe(6);
    expect(noRepeats(clips)).toBe(true);
  });


  it("a stretched shot holds its own last frame; it does not read on into seconds a later clip shows", () => {
    const film = [
      clip("a_p1", 1, 0, 2, 0, 2),
      clip("a_p2", 1, 2, 6, 0, 2),
      clip("b", 2, 6, 8, 0, 2),
      clip("a_later", 1, 8, 10, 2.2, 4.2),
    ];
    const { clips } = removeRepeatedFootage(film);
    /** a_p1 plays 0–2 s at 0.5× (4 s of screen), then its frame at 2 s holds; a_later's 2.2–4.2 s is new */
    expect(ids(clips)).toEqual(["a_p1", "b", "a_later"]);
    expect(clips[0]!.sourceOut).toBe(2);
    expect(clips[0]!.holdAtSourceOut).toBe(true);
    expect(noRepeats(clips)).toBe(true);
  });

  it("a shot whose own seconds fill the slot plays on and does not hold", () => {
    const film = [clip("a", 1, 0, 3, 0, 6), clip("a_again", 1, 3, 5, 1, 3)];
    const { clips } = removeRepeatedFootage(film);
    expect(ids(clips)).toEqual(["a"]);
    expect(clips[0]!.timelineEnd).toBe(5);
    expect(clips[0]!.speed).toBe(1);
    expect(clips[0]!.holdAtSourceOut).toBeUndefined();
  });
});

describe("after the five-second YouTube rule: a held frame, never a longer shot", () => {
  it("a piece that lands on another clip's seconds becomes the last frame of the shot before it", () => {
    const film = [
      clip("y1_p1", 7, 0, 4, 10, 14),
      clip("other", 8, 4, 8, 0, 4),
      clip("y2_p1", 7, 8, 12, 0, 4),
      clip("y2_p2", 7, 12, 16, 11, 15),
    ];
    const { clips, notes } = removeRepeatedFootage(film, { holdInstead: true });
    expect(ids(clips)).toEqual(["y1_p1", "other", "y2_p1", "y2_p2_hold"]);
    const hold = clips[3]!;
    /** the frame y2_p1 ends on, read for one frame and held for 4 s */
    expect([hold.timelineStart, hold.timelineEnd]).toEqual([12, 16]);
    expect(hold.sourceIn).toBe(3.95);
    expect(hold.sourceOut).toBe(4);
    expect(hold.holdAtSourceOut).toBe(true);
    expect(hold.speed).toBeUndefined();
    /** no shot grew */
    expect(clips[2]!.timelineEnd).toBe(12);
    expect(noRepeats(clips)).toBe(true);
    expect(notes.join(" ")).toContain("the last frame of y2_p1 holds for 4.00s instead of a repeat");
  });

  it("with no shot before it (after a graphic's ground), the first frame of the next shot holds", () => {
    const film = [clip("a", 1, 0, 3, 0, 3), clip("graphic_bg", 99, 3, 6, 0, 3), clip("a_again", 1, 6, 9, 0, 3), clip("b", 2, 9, 12, 5, 8)];
    const { clips } = removeRepeatedFootage(film, { holdInstead: true, skip: (c) => c.id === "graphic_bg" });
    expect(ids(clips)).toEqual(["a", "graphic_bg", "b_hold", "b"]);
    expect([clips[2]!.timelineStart, clips[2]!.timelineEnd]).toEqual([6, 9]);
    expect(clips[2]!.sourceIn).toBe(5);
    expect(clips[2]!.holdAtSourceOut).toBe(true);
    /** b itself is untouched */
    expect([clips[3]!.timelineStart, clips[3]!.timelineEnd]).toEqual([9, 12]);
  });
});

describe("the YouTube pieces: no window twice", () => {
  const facts656 = { sourceDurationSec: 3.37, cutsSec: [], measured: true };

  it("656 replayed: one short source for 8.62 s — its footage once, then its last frame", async () => {
    const { planYoutubePieces } = await import("./youtubeShotLimit");
    const { pieces, notes } = planYoutubePieces({ inSec: 0.5, durationSec: 8.62, facts: facts656 });
    const moving = pieces.filter((p) => !p.hold);
    expect(moving.length).toBeGreaterThan(0);
    expect(new Set(moving.map((p) => p.inSec)).size).toBe(moving.length);
    expect(pieces.some((p) => p.hold)).toBe(true);
    expect(notes.join(" ")).toContain("hold the last frame instead of a repeat");
  });

  it("limitYoutubeShots: every piece at most 5 s, and what the renderer reads never overlaps", async () => {
    const { limitYoutubeShots } = await import("./youtubeShotLimit");
    const { sourceReadSec } = await import("./timelineRenderer");
    const yt = clip("vc_c94d525f36", 60944, 9.13, 17.75, 0.5, 3.37, { sceneIndex: 1, beatIndex: 2 });
    const { clips, notes } = limitYoutubeShots({ clips: [yt], youtube: new Map([["vc_c94d525f36", facts656]]) });
    expect(span(clips)).toEqual([9.13, 17.75]);
    for (const c of clips) expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(5 + 1e-6);
    expect(clips.some((c) => c.holdAtSourceOut)).toBe(true);
    /** slower first (the floor), the rest held */
    expect(notes.join(" ")).toContain("hold the last frame");
    const reads = clips.map((c) => {
      const from = c.sourceIn ?? 0;
      return [from, from + sourceReadSec(c, from, (c.timelineEnd - c.timelineStart) * (c.speed ?? 1))] as const;
    });
    for (let i = 0; i < reads.length; i++) {
      for (let j = i + 1; j < reads.length; j++) {
        expect(Math.min(reads[i]![1], reads[j]![1]) - Math.max(reads[i]![0], reads[j]![0])).toBeLessThanOrEqual(0.25);
      }
    }
  }, 120_000);
});

describe("the renderer reads no further than a held clip's out-point", () => {
  it("sourceReadSec", async () => {
    const { sourceReadSec } = await import("./timelineRenderer");
    expect(sourceReadSec({ holdAtSourceOut: true, sourceOut: 4 }, 3.95, 4)).toBeCloseTo(0.05, 6);
    expect(sourceReadSec({ holdAtSourceOut: true, sourceOut: 4 }, 0, 2)).toBe(2);
    /** without the flag, as before: the whole slot */
    expect(sourceReadSec({ sourceOut: 4 }, 3.95, 4)).toBe(4);
    /** never less than a frame */
    expect(sourceReadSec({ holdAtSourceOut: true, sourceOut: 1 }, 2, 4)).toBe(0.04);
  }, 120_000);

  it("the input is opened with that read", () => {
    const R = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");
    expect(R).toContain("const readSec = sourceReadSec(fitted, startAt, dur * speed);");
    expect(R).toContain('args.push("-ss", startAt.toFixed(3), "-t", readSec.toFixed(3), "-i", localMedia);');
  });
});

describe("the six-second rule: a piece past its window holds; a deliberate hold is left alone", () => {
  it("limitLongShots", async () => {
    const { limitLongShots } = await import("./longShotLimit");
    const { clips } = limitLongShots({ clips: [clip("l", 1, 0, 12, 0, 2)] });
    expect(clips.length).toBeGreaterThan(1);
    expect(clips.some((c) => c.holdAtSourceOut)).toBe(true);
    const held = { ...clip("h", 2, 0, 4, 3.95, 4), holdAtSourceOut: true };
    const kept = limitLongShots({ clips: [held] });
    expect(kept.clips).toEqual([held]);
    expect(kept.notes).toEqual([]);
  });
});

describe("wiring", () => {
  it("in the EDL translation: after the holds and fillers, before the YouTube pieces, and once more after them", () => {
    const EDL = readFileSync(join(__dirname, "edlToTimeline.ts"), "utf8");
    const holds = EDL.indexOf("const covered = holdPictureUnderVoice({");
    const noRepeat = EDL.indexOf("const noRepeat = removeRepeatedFootage(clips, { skip: isGraphicBackdrop });");
    const youtube = EDL.indexOf("const limited = limitYoutubeShots({ clips, youtube });");
    const after = EDL.indexOf("removeRepeatedFootage(clips, { skip: isGraphicBackdrop, holdInstead: true });");
    expect(holds).toBeGreaterThan(-1);
    expect(noRepeat).toBeGreaterThan(holds);
    expect(youtube).toBeGreaterThan(noRepeat);
    expect(after).toBeGreaterThan(youtube);
    /** and before the six-second rule */
    const PIPE = readFileSync(join(__dirname, "cinematicPipeline.ts"), "utf8");
    expect(PIPE.indexOf("translateEdl({")).toBeLessThan(PIPE.indexOf("limitLongShots({ clips: videoTrack.clips })"));
  });
});
