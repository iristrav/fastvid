/**
 * RONDE 147 §9–§12, TEST 13–26 — the validator refuses, and never repairs.
 *
 * ── Why every test here checks what is NOT reported as well ──────────────────────────────────
 *
 * A validator's failure mode is not missing a fault; it is inventing one. A gap between two
 * captions is silence, an absent `sourceIn` is an unrecorded trim, and a timeline written before
 * this round has no `schemaVersion`. Report any of those as an error and the honest answer becomes
 * "turn the validator off", which costs the real faults their only chance of being seen. So each
 * block below names both halves: what must be caught, and what must be left alone.
 *
 * ── The other rule ───────────────────────────────────────────────────────────────────────────
 *
 * The validator returns issues. It does not touch the timeline. Several tests here compare a deep
 * snapshot taken before validation with the object afterwards, because "reports and never repairs"
 * is only worth writing down if something checks it.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FORMAT,
  DEFAULT_TEXT_STYLE,
  TIMELINE_SCHEMA_VERSION,
  type ProjectTimeline,
  type TimelineAudioClip,
  type TimelineCaption,
  type TimelineText,
  type TimelineVideoClip,
} from "./projectTimeline";
import {
  NON_BLOCKING_ISSUES,
  TRACK_POLICY,
  TimelineValidationError,
  assertRenderableTimeline,
  formatTimelineIssue,
  formatTimelineValidation,
  validateTimeline,
  type TimelineIssueCode,
} from "./timelineValidator";

/* ═══════════════════════ fixtures ═══════════════════════ */

const identity = (n: number) => ({
  provider: "loc",
  providerAssetId: `item/${n}`,
  mediaUrl: `https://www.loc.gov/item/${n}/media.mp4`,
});

function clip(over: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: "vc_0",
    kind: "video",
    source: identity(1),
    timelineStart: 0,
    timelineEnd: 4,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  };
}

function audio(over: Partial<TimelineAudioClip> = {}): TimelineAudioClip {
  return {
    id: "a_0",
    source: { provider: "curated", canonicalUrl: "/local-storage/videos/1/voiceover.mp3" },
    start: 0,
    end: 8,
    gain: 1,
    ...over,
  } as TimelineAudioClip;
}

function caption(over: Partial<TimelineCaption> = {}): TimelineCaption {
  return {
    id: "cap_0",
    text: "spoken words",
    start: 0,
    end: 2,
    style: DEFAULT_CAPTION_STYLE,
    animation: "fade",
    ...over,
  } as TimelineCaption;
}

function text(over: Partial<TimelineText> = {}): TimelineText {
  return {
    id: "t_0",
    text: "APRIL 1945",
    start: 0,
    end: 2,
    style: DEFAULT_TEXT_STYLE,
    animation: "fade",
    ...over,
  } as TimelineText;
}

/** Two clips, 0→4 and 4→8, an 8-second timeline. The shape everything else deviates from. */
function goodTimeline(over: Partial<ProjectTimeline> = {}): ProjectTimeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    version: 1,
    videoId: 1,
    durationSec: 8,
    format: DEFAULT_FORMAT,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    tracks: [
      {
        kind: "VIDEO",
        clips: [
          clip({ id: "vc_0", timelineStart: 0, timelineEnd: 4, source: identity(1) }),
          clip({ id: "vc_1", timelineStart: 4, timelineEnd: 8, source: identity(2) }),
        ],
      },
    ],
    ...over,
  };
}

const codes = (t: ProjectTimeline): TimelineIssueCode[] =>
  validateTimeline(t).issues.map((i) => i.code);

const issueFor = (t: ProjectTimeline, code: TimelineIssueCode) =>
  validateTimeline(t).issues.find((i) => i.code === code);

/** Deep-freeze-by-comparison: prove validation left the document exactly as it found it. */
function expectUntouched(t: ProjectTimeline, run: () => void): void {
  const before = JSON.stringify(t);
  run();
  expect(JSON.stringify(t), "the validator modified the timeline").toBe(before);
}

/* ═══════════════════════ TEST 13 ═══════════════════════ */

describe("TEST 13 — a valid timeline passes", () => {
  it("no issues at all, and nothing was changed to achieve that", () => {
    const t = goodTimeline();
    expectUntouched(t, () => {
      const result = validateTimeline(t);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    });
    expect(() => assertRenderableTimeline(t)).not.toThrow();
    expect(formatTimelineValidation(validateTimeline(t))).toEqual(["[TimelineValidator] ok — no issues"]);
  });

  it("a full timeline — video, voice, music, captions, text — also passes", () => {
    const t = goodTimeline();
    t.tracks.push(
      { kind: "VOICE", clips: [audio({ id: "v_0", start: 0, end: 8 })] },
      { kind: "MUSIC", clips: [audio({ id: "m_0", start: 0, end: 8, gain: 0.2 })] },
      { kind: "CAPTIONS", captions: [caption({ id: "cap_0", start: 0, end: 3 }), caption({ id: "cap_1", start: 3, end: 6 })] },
      { kind: "TEXT", texts: [text({ id: "t_0", start: 0.5, end: 3 })] }
    );
    expect(validateTimeline(t).issues).toEqual([]);
  });
});

/* ═══════════════════════ TEST 14–16 — the arithmetic ═══════════════════════ */

describe("TEST 14 — a negative duration is caught", () => {
  it("end before start on the VIDEO track", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.timelineEnd = -1;
    const issue = issueFor(t, "negative_duration")!;
    expect(issue).toBeDefined();
    expect(issue.elementId).toBe("vc_0");
    expect(issue.reason).toContain("before it starts");
    // and it BLOCKS: a negative segment is what ffmpeg answers with a zero-frame file.
    expect(NON_BLOCKING_ISSUES.has("negative_duration")).toBe(false);
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("on an audio clip too", () => {
    const t = goodTimeline();
    t.tracks.push({ kind: "MUSIC", clips: [audio({ id: "m_0", start: 5, end: 2 })] });
    const issue = issueFor(t, "negative_duration")!;
    expect(issue.track).toBe("MUSIC");
    expect(issue.elementId).toBe("m_0");
  });
});

describe("TEST 15 — start >= end is caught, and a one-second clip is not", () => {
  it("equal start and end has no duration and would render as nothing", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[0]!.timelineEnd = 0;
    expect(codes(t)).toContain("zero_duration");
  });

  it("REGRESSION: start 0 → end 1 is a ONE-SECOND CLIP, not a fault", () => {
    /**
     * This test exists because I wrote the opposite assertion first and it was wrong. `end` is an
     * absolute position, not a duration, so 0→1 is a perfectly good second of video. Had the
     * validator been "fixed" to match that mistaken test, every opening clip would have been
     * rejected.
     */
    const t = goodTimeline();
    t.tracks = [{ kind: "VIDEO", clips: [clip({ id: "vc_0", timelineStart: 0, timelineEnd: 1 })] }];
    t.durationSec = 1;
    expect(validateTimeline(t).issues).toEqual([]);
  });
});

describe("TEST 16 — NaN and Infinity are caught with their own code", () => {
  it("NaN on a boundary is non_finite_time, not an ordering complaint", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.timelineEnd = NaN;
    const issue = issueFor(t, "non_finite_time")!;
    expect(issue).toBeDefined();
    expect(issue.elementId).toBe("vc_0");
    expect(issue.reason).toContain("NaN");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("Infinity likewise", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.timelineStart = -Infinity;
    expect(codes(t)).toContain("non_finite_time");
  });

  it("a NaN clip does not silently corrupt the continuity check around it", () => {
    /**
     * Every comparison against NaN is false, so a naive sort leaves the array in an arbitrary
     * order and the overlap check reports nonsense about the OTHER clips. The fault must stay
     * attached to the clip that has it.
     */
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[0]!.timelineEnd = NaN;
    const result = validateTimeline(t);
    expect(result.issues.filter((i) => i.code === "video_overlap")).toEqual([]);
    expect(result.issues.filter((i) => i.elementId === "vc_1" && i.code !== "video_gap")).toEqual([]);
  });

  it("a non-finite timeline duration is caught", () => {
    const t = goodTimeline({ durationSec: NaN });
    expect(codes(t)).toContain("negative_duration");
  });
});

/* ═══════════════════════ TEST 17–20 — the track policy ═══════════════════════ */

describe("TEST 17 — VIDEO overlap is a fault, because the track is concatenated", () => {
  it("the overlap is reported against the later clip, with the amount", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[1]!.timelineStart = 2.5;
    const issue = issueFor(t, "video_overlap")!;
    expect(issue.elementId).toBe("vc_1");
    expect(issue.reason).toContain("overlaps vc_0");
    expect(issue.reason).toContain("1.500s");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("the policy says WHY, and the policy is what the check follows", () => {
    expect(TRACK_POLICY.VIDEO.overlap).toBe("exclusive");
    expect(TRACK_POLICY.VIDEO.gap).toBe("fault");
    expect(TRACK_POLICY.VIDEO.because).toContain("concat");
  });

  it("a boundary off by less than a frame is the same instant, not an overlap", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[1]!.timelineStart = 3.995;
    expect(codes(t)).not.toContain("video_overlap");
  });

  it("a DISABLED clip is excluded from continuity — the hole it leaves is intentional", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips.push(clip({ id: "vc_x", timelineStart: 0, timelineEnd: 8, disabled: true, source: identity(3) }));
    expect(codes(t)).not.toContain("video_overlap");
  });
});

describe("TEST 18 — MUSIC overlap is allowed, because the renderer mixes it", () => {
  it("a bed running under narration produces no issue at all", () => {
    const t = goodTimeline();
    t.tracks.push({
      kind: "MUSIC",
      clips: [
        audio({ id: "m_0", start: 0, end: 8, gain: 0.2 }),
        audio({ id: "m_1", start: 3, end: 8, gain: 0.2 }),
      ],
    });
    expect(validateTimeline(t).issues).toEqual([]);
  });

  it("VOICE and SFX likewise — amix sums them", () => {
    const t = goodTimeline();
    t.tracks.push(
      { kind: "VOICE", clips: [audio({ id: "v_0", start: 0, end: 5 }), audio({ id: "v_1", start: 2, end: 8 })] },
      { kind: "SFX", clips: [audio({ id: "s_0", start: 1, end: 3 }), audio({ id: "s_1", start: 1, end: 3 })] }
    );
    expect(validateTimeline(t).issues).toEqual([]);
    for (const k of ["VOICE", "MUSIC", "SFX"] as const) {
      expect(TRACK_POLICY[k].overlap, k).toBe("allowed");
      expect(TRACK_POLICY[k].because, k).toContain("amix");
    }
  });

  it("but a gain the mixer cannot be trusted with IS a fault", () => {
    const t = goodTimeline();
    t.tracks.push({ kind: "MUSIC", clips: [audio({ id: "m_0", gain: 40 })] });
    expect(codes(t)).toContain("invalid_gain");
  });

  it("and a fade longer than the clip it fades", () => {
    const t = goodTimeline();
    t.tracks.push({ kind: "VOICE", clips: [audio({ id: "v_0", start: 0, end: 2, fadeInSec: 5 })] });
    expect(issueFor(t, "invalid_fade")!.reason).toContain("longer than the clip");
  });
});

describe("TEST 19 — TEXT overlap is allowed; CAPTIONS overlap is reported but never blocks", () => {
  it("two texts on screen at once is a legitimate composition", () => {
    const t = goodTimeline();
    t.tracks.push({
      kind: "TEXT",
      texts: [text({ id: "t_0", start: 0, end: 4 }), text({ id: "t_1", start: 1, end: 3 })],
    });
    expect(validateTimeline(t).issues).toEqual([]);
    expect(TRACK_POLICY.TEXT.overlap).toBe("allowed");
    expect(TRACK_POLICY.TEXT.overlapAdvisory).toBeUndefined();
  });

  it("two CAPTIONS at once is reported — and the render still goes ahead", () => {
    const t = goodTimeline();
    t.tracks.push({
      kind: "CAPTIONS",
      captions: [caption({ id: "cap_0", start: 0, end: 3 }), caption({ id: "cap_1", start: 2, end: 5 })],
    });
    const issue = issueFor(t, "caption_overlap")!;
    expect(issue).toBeDefined();
    expect(issue.elementId).toBe("cap_1");
    expect(issue.reason).toContain("two lines of narration");
    expect(NON_BLOCKING_ISSUES.has("caption_overlap")).toBe(true);
    expect(() => assertRenderableTimeline(t)).not.toThrow();
    expect(TRACK_POLICY.CAPTIONS.overlapAdvisory).toBe(true);
  });

  it("a disabled caption cannot overlap anything — it is not drawn", () => {
    const t = goodTimeline();
    t.tracks.push({
      kind: "CAPTIONS",
      captions: [
        caption({ id: "cap_0", start: 0, end: 3 }),
        caption({ id: "cap_1", start: 2, end: 5, disabled: true }),
      ],
    });
    expect(codes(t)).not.toContain("caption_overlap");
  });

  it("an enabled element with no text would draw nothing, and that is a fault", () => {
    const t = goodTimeline();
    t.tracks.push({ kind: "TEXT", texts: [text({ id: "t_0", text: "   " })] });
    expect(codes(t)).toContain("zero_duration");
  });
});

describe("TEST 20 — a VIDEO gap is reported; a gap on every other track is not", () => {
  it("the hole between two clips is named, with the seconds", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[1]!.timelineStart = 5;
    clips[1]!.timelineEnd = 9;
    t.durationSec = 9;
    const issue = issueFor(t, "video_gap")!;
    expect(issue.reason).toContain("1.000s of nothing");
  });

  it("a gap does NOT block: black is visible and recoverable, a refused render is not", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[1]!.timelineStart = 5;
    clips[1]!.timelineEnd = 9;
    t.durationSec = 9;
    expect(NON_BLOCKING_ISSUES.has("video_gap")).toBe(true);
    expect(() => assertRenderableTimeline(t)).not.toThrow();
    expect(validateTimeline(t).ok).toBe(false); // reported all the same
  });

  it("video that does not start at zero is a gap", () => {
    const t = goodTimeline();
    t.tracks = [{ kind: "VIDEO", clips: [clip({ timelineStart: 2, timelineEnd: 8 })] }];
    expect(issueFor(t, "video_gap")!.reason).toContain("not at zero");
  });

  it("SILENCE between two captions is not a fault, and neither is silence between music cues", () => {
    const t = goodTimeline();
    t.tracks.push(
      { kind: "CAPTIONS", captions: [caption({ id: "cap_0", start: 0, end: 1 }), caption({ id: "cap_1", start: 6, end: 7 })] },
      { kind: "MUSIC", clips: [audio({ id: "m_0", start: 0, end: 1 }), audio({ id: "m_1", start: 6, end: 8 })] }
    );
    expect(validateTimeline(t).issues).toEqual([]);
    for (const k of ["CAPTIONS", "MUSIC", "TEXT", "VOICE", "SFX", "GRAPHICS"] as const) {
      expect(TRACK_POLICY[k].gap, k).toBe("normal");
    }
  });

  it("a last clip that ends somewhere other than the timeline's own duration is a fault", () => {
    const t = goodTimeline({ durationSec: 30 });
    const issue = issueFor(t, "duration_mismatch")!;
    expect(issue.reason).toContain("never silently get a different length");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });
});

/* ═══════════════════════ TEST 21–23 — the trim points ═══════════════════════ */

describe("TEST 21 — a negative sourceIn is caught", () => {
  it("named, with the value", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.sourceIn = -2;
    const issue = issueFor(t, "negative_source_in")!;
    expect(issue.reason).toContain("-2.000");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("a NaN trim is caught as an invalid source range", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.sourceOut = NaN;
    expect(codes(t)).toContain("invalid_source_range");
  });
});

describe("TEST 22 — sourceOut <= sourceIn is caught", () => {
  it("equal in and out selects no frames", () => {
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    c.sourceIn = 3;
    c.sourceOut = 3;
    expect(issueFor(t, "source_out_before_in")!.reason).toContain("is not after sourceIn");
  });

  it("out before in likewise", () => {
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    c.sourceIn = 5;
    c.sourceOut = 2;
    expect(codes(t)).toContain("source_out_before_in");
  });

  it("a normal trim passes untouched", () => {
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    c.sourceIn = 2.5;
    c.sourceOut = 6.5;
    expect(validateTimeline(t).issues).toEqual([]);
  });
});

describe("TEST 23 — §15: A MISSING TRIM IS NOT ZERO AND IS NOT A FAULT", () => {
  it("absent sourceIn/sourceOut produce no issue whatsoever", () => {
    /**
     * The distinction the whole optionality exists for: "we used the whole file" and "nobody wrote
     * the trim down" are different facts. Typing these as required numbers forced every unrecorded
     * trim to be spelled 0, which is exactly the silent invention §15 forbids — and reporting the
     * absence as an error would make the missing instrumentation block real renders.
     */
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    expect(c.sourceIn).toBeUndefined();
    expect(c.sourceOut).toBeUndefined();
    expect(validateTimeline(t).issues).toEqual([]);
  });

  it("HALF a trim is not completed by the validator either", () => {
    // sourceIn without sourceOut: the ordering check has nothing to compare and must stay quiet.
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    c.sourceIn = 4;
    expectUntouched(t, () => {
      expect(validateTimeline(t).issues).toEqual([]);
    });
    expect(c.sourceOut).toBeUndefined();
  });

  it("sourceIn = 0 is a REAL value and is still valid", () => {
    const t = goodTimeline();
    const c = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!;
    c.sourceIn = 0;
    c.sourceOut = 4;
    expect(validateTimeline(t).issues).toEqual([]);
  });
});

/* ═══════════════════════ TEST 24–26 — documents and assets ═══════════════════════ */

describe("TEST 24 — a legacy timeline with no schemaVersion reads as v1", () => {
  it("absent is not a fault; everything written before RONDE 147 still validates", () => {
    const t = goodTimeline();
    delete t.schemaVersion;
    expect(validateTimeline(t).issues).toEqual([]);
    expect(() => assertRenderableTimeline(t)).not.toThrow();
  });

  it("the current version validates", () => {
    expect(validateTimeline(goodTimeline({ schemaVersion: TIMELINE_SCHEMA_VERSION })).issues).toEqual([]);
  });

  it("a version from the FUTURE is refused rather than half-read", () => {
    const t = goodTimeline({ schemaVersion: TIMELINE_SCHEMA_VERSION + 1 });
    const issue = issueFor(t, "unsupported_schema_version")!;
    expect(issue).toBeDefined();
    expect(issue.reason).toContain("silently drop");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("a nonsense version is caught too", () => {
    expect(codes(goodTimeline({ schemaVersion: 0 }))).toContain("unsupported_schema_version");
    expect(codes(goodTimeline({ schemaVersion: 1.5 }))).toContain("unsupported_schema_version");
  });
});

describe("TEST 25 — a clip with no recoverable identity is reported, and nothing is invented", () => {
  it("the provider and both ids are named exactly as stored", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.source = {
      provider: "wikimedia",
    };
    const issue = issueFor(t, "missing_asset")!;
    expect(issue.elementId).toBe("vc_0");
    expect(issue.reason).toContain("provider=wikimedia");
    expect(issue.reason).toContain("providerAssetId=null");
    expect(issue.reason).toContain("archiveAssetId=null");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("THE VALIDATOR DOES NOT FILL IN A SUBSTITUTE — the timeline comes back byte-identical", () => {
    /**
     * The single most damaging repair available to this code would be to quietly point a broken
     * clip at a working asset. The render would succeed and show the wrong picture.
     */
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.source = { provider: "pexels" };
    expectUntouched(t, () => {
      const result = validateTimeline(t);
      expect(result.ok).toBe(false);
    });
  });

  it("an UNVERIFIED provider cannot be rehydrated and says so", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.source = {
      provider: "UNVERIFIED",
      mediaUrl: "https://somewhere/x.mp4",
    };
    expect(codes(t)).toContain("missing_asset");
  });

  it("a transition the renderer does not know is reported, never swapped", () => {
    const t = goodTimeline();
    (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.transitionIn =
      "film_burn" as TimelineVideoClip["transitionIn"];
    const issue = issueFor(t, "invalid_transition")!;
    expect(issue.reason).toContain("film_burn");
    expect(
      (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips[0]!.transitionIn
    ).toBe("film_burn");
  });
});

describe("TEST 26 — the whole-document faults", () => {
  it("a duplicate element id is caught across tracks", () => {
    const t = goodTimeline();
    t.tracks.push({ kind: "TEXT", texts: [text({ id: "vc_0" })] });
    const issue = issueFor(t, "duplicate_element_id")!;
    expect(issue.reason).toContain("already used on the VIDEO track");
  });

  it("a format that cannot render is caught", () => {
    const t = goodTimeline({ format: { widthPx: 0, heightPx: 1080, fps: 30 } });
    expect(codes(t)).toContain("out_of_track_range");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });

  it("EVERY issue is reported at once, not one at a time", () => {
    /**
     * A validator that stops at the first fault turns one bad render into five bad renders. The
     * operator gets the whole list.
     */
    const t = goodTimeline({ durationSec: 30, format: { widthPx: 0, heightPx: 0, fps: 0 } });
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[0]!.timelineEnd = -1;
    clips[1]!.sourceIn = -5;
    clips[1]!.source = { provider: "pexels" };
    const found = new Set(codes(t));
    for (const expected of [
      "out_of_track_range", "negative_duration", "negative_source_in", "missing_asset",
    ] as TimelineIssueCode[]) {
      expect(found.has(expected), expected).toBe(true);
    }
  });

  it("the error message and the log lines name every blocking issue", () => {
    const t = goodTimeline();
    const clips = (t.tracks[0] as { kind: "VIDEO"; clips: TimelineVideoClip[] }).clips;
    clips[0]!.timelineEnd = -1;
    let thrown: TimelineValidationError | null = null;
    try {
      assertRenderableTimeline(t);
    } catch (e) {
      thrown = e as TimelineValidationError;
    }
    expect(thrown).toBeInstanceOf(TimelineValidationError);
    expect(thrown!.message).toContain("negative_duration");
    expect(thrown!.issues.every((i) => !NON_BLOCKING_ISSUES.has(i.code))).toBe(true);

    const lines = formatTimelineValidation(validateTimeline(t));
    expect(lines[0]).toContain("blocking");
    expect(lines.join("\n")).toContain("vc_0");
    expect(formatTimelineIssue(validateTimeline(t).issues[0]!)).toContain("VIDEO/vc_0");
  });

  it("every track kind has a policy, so no track can be checked by accident", () => {
    for (const k of ["VIDEO", "VOICE", "MUSIC", "SFX", "CAPTIONS", "TEXT", "GRAPHICS"] as const) {
      expect(TRACK_POLICY[k], k).toBeDefined();
      expect(TRACK_POLICY[k].because.length, k).toBeGreaterThan(10);
    }
  });
});
