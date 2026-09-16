/**
 * RONDE 257 — ONE BROKEN SHOT IS NOT THE WHOLE FILM.
 *
 * Three renders, one shape:
 *
 *   563   one clip overlapped its neighbour by 3.5s   → plan discarded → legacy compose
 *   574   four seconds of arithmetic overlapped two scenes → discarded → legacy
 *   585   one SerpAPI still could not be promised re-fetchable → discarded → legacy
 *
 * Each time the cause was repaired and the all-or-nothing was left standing, so the next cause cost
 * the same thing again. Render 585 threw away four camera moves, two transitions, the ambience bed
 * and the ducking over one picture — and then delivered the film through the old route using that
 * same picture.
 *
 * These tests hold the repair and, just as hard, its limits: the validator is untouched, a fault
 * about the FILM is still a fallback, and every shot that is removed is named.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_REPAIR_PASSES,
  formatTimelineRepairs,
  repairTimelineForRender,
} from "./timelineRepair";
import { NON_BLOCKING_ISSUES, validateTimeline } from "./timelineValidator";
import type { AssetSourceIdentity } from "./projectTimeline";

const wikimedia: AssetSourceIdentity = {
  provider: "wikimedia",
  providerAssetId: "File:Kim_Kardashian_2013.png",
};
/** Render 585's own orphan: a provider FastVid could not prove. */
const orphan: AssetSourceIdentity = { provider: "UNVERIFIED" };

type Clip = {
  id: string;
  timelineStart: number;
  timelineEnd: number;
  source: AssetSourceIdentity;
  transitionIn?: string;
  transitionOut?: string;
};

const clip = (id: string, start: number, end: number, over: Partial<Clip> = {}): Clip => ({
  id,
  timelineStart: start,
  timelineEnd: end,
  source: wikimedia,
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  ...over,
});

const timeline = (clips: Clip[], durationSec = 40) =>
  ({
    schemaVersion: 1,
    version: 1,
    videoId: 585,
    durationSec,
    format: { widthPx: 1920, heightPx: 1080, fps: 30 },
    tracks: [{ kind: "VIDEO", clips }],
    createdAt: "2026-09-15T21:01:04.103Z",
  }) as never;

const videoClipIds = (t: { tracks: Array<{ kind: string; clips?: Array<{ id: string }> }> }) =>
  t.tracks.find((tr) => tr.kind === "VIDEO")!.clips!.map((c) => c.id);

const blockingOf = (t: unknown) =>
  validateTimeline(t as never).issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));

describe("1. a healthy plan is not touched", () => {
  it("a clean timeline comes back unchanged, with no repairs", () => {
    const t = timeline([clip("a", 0, 10), clip("b", 10, 20), clip("c", 20, 40)]);
    const result = repairTimelineForRender(t);
    expect(result.repairs).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.timeline).toBe(t);
  });
});

describe("2. render 585's shot, and the three that stood beside it", () => {
  /** THE EXACT LOSS. One unrecoverable picture at 49.83s took four good shots with it. */
  it("an unrecoverable clip is dropped and the rest of the plan survives", () => {
    const t = timeline([
      clip("keep1", 0, 10),
      clip("keep2", 10, 20),
      clip("vc_bcc6087010", 20, 30, { source: orphan }),
      clip("keep3", 30, 40),
    ]);
    const result = repairTimelineForRender(t);
    expect(result.remaining, "the plan must be renderable now").toEqual([]);
    expect(videoClipIds(result.timeline as never)).toEqual(["keep1", "keep2", "keep3"]);
  });

  it("and the drop is named, with the validator's own reason", () => {
    const t = timeline([clip("good", 0, 20), clip("bad", 20, 30, { source: orphan }), clip("end", 30, 40)]);
    const { repairs } = repairTimelineForRender(t);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.clipId).toBe("bad");
    expect(repairs[0]!.code).toBe("missing_asset");
    expect(repairs[0]!.action).toBe("clip_dropped");
    expect(repairs[0]!.reason).toContain("UNVERIFIED");
  });

  /** Render 563 and 574's shape: two clips on one concatenated track. */
  it("an overlapping clip is dropped rather than the whole plan", () => {
    const t = timeline([clip("first", 0, 20), clip("second", 16.677, 30), clip("last", 30, 40)]);
    const before = blockingOf(t);
    expect(before.map((i) => i.code)).toContain("video_overlap");
    const result = repairTimelineForRender(t);
    expect(result.remaining).toEqual([]);
    expect(videoClipIds(result.timeline as never)).toEqual(["first", "last"]);
  });

  /**
   * THE LIMIT THAT MATTERS MOST, and it is not a fixture detail.
   *
   * `duration_mismatch` compares the LAST clip's end against the film's declared length. Dropping a
   * shot in the middle leaves that untouched; dropping the CLOSING shot shortens the picture, and
   * the repair may not answer that by quietly shortening the film — the narration still runs to the
   * end. So it is reported and the caller falls back, which is the honest outcome: you cannot fix a
   * broken final shot by deleting it.
   */
  it("a broken CLOSING shot is not repaired, because deleting it would shorten the film", () => {
    const t = timeline([clip("a", 0, 20), clip("closing", 20, 40, { source: orphan })]);
    const result = repairTimelineForRender(t);
    expect(result.remaining.map((i) => i.code)).toContain("duration_mismatch");
    expect(result.remaining.length, "the caller must still fall back here").toBeGreaterThan(0);
  });
});

describe("3. a shot is kept where the flourish alone is the fault", () => {
  /**
   * RONDE 148 already established that an unexecutable flourish is a plainer video, not a broken
   * one. Dropping the shot over its transition would throw away a picture for a wipe.
   */
  it("an unknown transition is normalised and the clip stays", () => {
    const t = timeline([clip("a", 0, 20), clip("b", 20, 40, { transitionIn: "star_wipe" })]);
    const result = repairTimelineForRender(t);
    expect(result.remaining).toEqual([]);
    expect(videoClipIds(result.timeline as never)).toEqual(["a", "b"]);
    expect(result.repairs.map((r) => r.action)).toEqual(["transition_normalised"]);
  });

  it("and a clip refused for two reasons at once is dropped, not normalised", () => {
    const t = timeline([
      clip("a", 0, 20),
      clip("b", 20, 30, { source: orphan, transitionIn: "star_wipe" }),
      clip("c", 30, 40),
    ]);
    const result = repairTimelineForRender(t);
    expect(videoClipIds(result.timeline as never)).toEqual(["a", "c"]);
    expect(
      result.repairs.some((r) => r.clipId === "b" && r.action === "clip_dropped"),
      "the drop answers both faults; normalising would leave one in a kept shot"
    ).toBe(true);
  });
});

describe("4. a fault about the FILM is still a fallback", () => {
  /**
   * THE LIMIT, AND THE REASON THIS IS NOT A LOOSENING. A format with no frame rate is not a fact
   * about one shot, and deleting shots to answer it would make the film worse while claiming to fix
   * it. The caller still falls back, and still says so.
   */
  it("a timeline-level fault is reported, not repaired", () => {
    const broken = {
      ...(timeline([clip("a", 0, 40)]) as unknown as Record<string, unknown>),
      format: { widthPx: 0, heightPx: 0, fps: 0 },
    };
    const result = repairTimelineForRender(broken as never);
    expect(result.repairs, "no shot may be deleted to answer this").toEqual([]);
    expect(result.remaining.map((i) => i.code)).toContain("out_of_track_range");
  });

  /**
   * `picture_short_of_voice` names a clip and is deliberately NOT repairable: dropping shots is the
   * one action guaranteed to make a film that already stops mid-sentence stop earlier.
   */
  it("the codes that must never be answered by deleting a shot are not on the list", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "timelineRepair.ts"), "utf8");
    const list = /CLIP_SCOPED_BLOCKING[\s\S]*?\]\)/.exec(src)![0];
    for (const forbidden of ["picture_short_of_voice", "duration_mismatch", "unsupported_schema_version"]) {
      expect(list, forbidden).not.toContain(forbidden);
    }
  });
});

describe("5. the repair is bounded and never silent", () => {
  it("it gives up rather than looping on a plan it cannot fix", () => {
    expect(MAX_REPAIR_PASSES).toBeLessThanOrEqual(4);
  });

  it("every repair reaches the log, with a total", () => {
    const t = timeline([clip("a", 0, 20), clip("b", 20, 30, { source: orphan }), clip("c", 30, 40)]);
    const lines = formatTimelineRepairs(repairTimelineForRender(t).repairs);
    expect(lines.some((l) => l.includes("clip_dropped b missing_asset"))).toBe(true);
    const total = lines.find((l) => l.includes("TOTAL"))!;
    expect(total).toContain("repairs=1");
    expect(total).toContain("dropped=1");
  });

  it("and a clean plan prints nothing at all", () => {
    expect(formatTimelineRepairs([])).toEqual([]);
  });
});

describe("6. the validator was not weakened to achieve this", () => {
  it("it still refuses everything it refused", () => {
    const t = timeline([clip("a", 0, 20), clip("b", 20, 30, { source: orphan }), clip("c", 30, 40)]);
    expect(blockingOf(t).map((i) => i.code), "the input is still refused").toContain("missing_asset");
  });

  it("the non-blocking set was not widened", async () => {
    for (const code of [
      "missing_asset", "video_overlap", "negative_duration", "end_before_start",
      "zero_duration", "invalid_transition", "picture_short_of_voice", "duration_mismatch",
    ]) {
      expect(NON_BLOCKING_ISSUES.has(code as never), code).toBe(false);
    }
  });

  /** The repaired plan is judged by the same function, not by a friendlier one. */
  it("and the result is proven renderable by the validator itself", () => {
    const t = timeline([clip("a", 0, 20), clip("b", 20, 30, { source: orphan }), clip("c", 30, 40)]);
    const result = repairTimelineForRender(t);
    expect(blockingOf(result.timeline)).toEqual([]);
  });

  it("the input timeline is never mutated", () => {
    const t = timeline([clip("a", 0, 20), clip("b", 20, 30, { source: orphan }), clip("c", 30, 40)]);
    repairTimelineForRender(t);
    expect(videoClipIds(t as never)).toEqual(["a", "b", "c"]);
  });
});
