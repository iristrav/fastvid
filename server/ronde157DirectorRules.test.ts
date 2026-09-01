/**
 * RONDE 157B — the quality rules, and the promise that they never repair anything.
 *
 * The most important assertion in this file is the negative one: `judgeTimeline` returns findings
 * and the timeline it was handed is unchanged. §157B forbids silent renderer correction, and the
 * cheapest way for that promise to rot is for a rule to start "helpfully" clamping something.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_CAMERA_SHARE,
  MAX_CAPTIONS_PER_MINUTE,
  MAX_CONSECUTIVE_SAME_SHOT,
  MAX_CONSECUTIVE_SAME_TRANSITION,
  MAX_EFFECT_SHARE,
  MAX_GRAPHICS_PER_MINUTE,
  MAX_UNDUCKED_BED_GAIN,
  formatQualityFindings,
  formatQualitySummary,
  judgeTimeline,
} from "./directorQualityRules";
import {
  DEFAULT_CAPTION_STYLE,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";

/* ═══════════════════════ fixtures ═══════════════════════ */

function clip(i: number, overrides: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: `vc${i}`,
    kind: "video",
    source: { provider: "pexels", providerAssetId: String(i) },
    sourceIn: 0,
    sourceOut: 4,
    timelineStart: i * 4,
    timelineEnd: i * 4 + 4,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    ...overrides,
  } as TimelineVideoClip;
}

function timelineOf(
  clips: TimelineVideoClip[],
  extras: {
    durationSec?: number;
    captions?: Array<Record<string, unknown>>;
    graphics?: Array<Record<string, unknown>>;
    audio?: Array<{ kind: "VOICE" | "MUSIC" | "SFX" | "AMBIENT"; clip: Record<string, unknown> }>;
  } = {}
): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: 1920, heightPx: 1080, fps: 25 });
  t.durationSec = extras.durationSec ?? Math.max(1, clips.length * 4);
  for (const track of t.tracks) {
    if (track.kind === "VIDEO") track.clips.push(...clips);
    if (track.kind === "CAPTIONS") track.captions.push(...((extras.captions ?? []) as never[]));
    if (track.kind === "GRAPHICS") track.graphics.push(...((extras.graphics ?? []) as never[]));
    for (const a of extras.audio ?? []) {
      if (track.kind === a.kind && "clips" in track) track.clips.push(a.clip as never);
    }
  }
  return t;
}

function audioClip(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: { provider: "storage", providerAssetId: id },
    start: 0,
    end: 20,
    gain: 1,
    ...overrides,
  };
}

/* ═══════════════════════ the promise ═══════════════════════ */

describe("RONDE 157B — the rules report, they never repair", () => {
  it("leaves the timeline byte-identical", () => {
    const t = timelineOf([
      clip(0, { motion: "slow_push", camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }),
      clip(1, { motion: "slow_push", camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }),
      clip(2, { motion: "slow_push", camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }),
      clip(3, { motion: "slow_push", camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }),
    ]);
    const before = JSON.stringify(t);
    const findings = judgeTimeline(t);
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(t)).toBe(before);
  });

  it("never blocks — even a badly-made edit only produces findings", () => {
    const t = timelineOf(Array.from({ length: 8 }, (_, i) =>
      clip(i, {
        motion: "slow_push",
        camera: { type: "slow_push", startScale: 1, endScale: 1.2 },
        effects: [{ effectType: "film_grain", intensity: 0.8 }],
        transitionIn: "crossfade",
      })
    ));
    expect(() => judgeTimeline(t)).not.toThrow();
    expect(Array.isArray(judgeTimeline(t))).toBe(true);
  });

  it("says so explicitly when there is nothing wrong", () => {
    const t = timelineOf([clip(0), clip(1, { motion: "slow_push" })]);
    const findings = judgeTimeline(t);
    expect(findings).toEqual([]);
    expect(formatQualitySummary(findings)).toContain("0 finding");
    expect(formatQualitySummary(findings)).toContain("nothing was changed");
  });

  it("is deterministic", () => {
    const build = () => timelineOf(Array.from({ length: 6 }, (_, i) => clip(i, { motion: "pan_left" })));
    expect(JSON.stringify(judgeTimeline(build()))).toBe(JSON.stringify(judgeTimeline(build())));
  });
});

/* ═══════════════════════ repetition ═══════════════════════ */

describe("RONDE 157B — repetition", () => {
  it("allows a short run and flags a long one", () => {
    const short = timelineOf(
      Array.from({ length: MAX_CONSECUTIVE_SAME_SHOT }, (_, i) => clip(i, { motion: "slow_push" }))
    );
    expect(judgeTimeline(short).filter((f) => f.code === "repeated_shot")).toEqual([]);

    const long = timelineOf(
      Array.from({ length: MAX_CONSECUTIVE_SAME_SHOT + 2 }, (_, i) => clip(i, { motion: "slow_push" }))
    );
    const found = judgeTimeline(long).filter((f) => f.code === "repeated_shot");
    expect(found).toHaveLength(1);
    expect(found[0]!.elementIds.length).toBe(MAX_CONSECUTIVE_SAME_SHOT + 2);
    expect(found[0]!.reason).toContain("slow_push");
  });

  it("a run that crosses a scene boundary is still a run — a viewer does not see scenes", () => {
    const clips = Array.from({ length: 4 }, (_, i) =>
      clip(i, { motion: "pan_left", sceneIndex: i < 2 ? 0 : 1 })
    );
    expect(judgeTimeline(timelineOf(clips)).some((f) => f.code === "repeated_shot")).toBe(true);
  });

  it("flags a run of identical transitions", () => {
    const clips = Array.from({ length: MAX_CONSECUTIVE_SAME_TRANSITION + 2 }, (_, i) =>
      clip(i, { transitionIn: "crossfade" })
    );
    const found = judgeTimeline(timelineOf(clips)).filter((f) => f.code === "repeated_transition");
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("crossfade");
  });

  it("a varied edit produces nothing", () => {
    const motions = ["none", "slow_push", "pan_left", "slow_pull", "none", "pan_right"] as const;
    const clips = motions.map((m, i) => clip(i, { motion: m }));
    expect(judgeTimeline(timelineOf(clips)).filter((f) => f.code === "repeated_shot")).toEqual([]);
  });

  it("escalates a very long run from notice to warning", () => {
    const clips = Array.from({ length: 8 }, (_, i) => clip(i, { motion: "slow_push" }));
    const found = judgeTimeline(timelineOf(clips)).find((f) => f.code === "repeated_shot")!;
    expect(found.severity).toBe("warning");
  });
});

/* ═══════════════════════ excess ═══════════════════════ */

describe("RONDE 157B — too much of a good thing", () => {
  it("flags camera moves on most of the video", () => {
    const clips = Array.from({ length: 10 }, (_, i) =>
      clip(i, {
        motion: i < 8 ? (i % 2 ? "pan_left" : "slow_push") : "none",
        ...(i < 8 ? { camera: { type: "slow_push", startScale: 1, endScale: 1.1 } } : {}),
      })
    );
    const found = judgeTimeline(timelineOf(clips)).find((f) => f.code === "excessive_camera");
    expect(found).toBeDefined();
    expect(found!.reason).toContain("emphasis");
    expect(MAX_CAMERA_SHARE).toBeLessThan(1);
  });

  it("does not flag a restrained edit", () => {
    const clips = Array.from({ length: 10 }, (_, i) =>
      clip(i, {
        motion: i < 3 ? "slow_push" : "none",
        ...(i < 3 ? { camera: { type: "slow_push", startScale: 1, endScale: 1.1 } } : {}),
      })
    );
    expect(judgeTimeline(timelineOf(clips)).some((f) => f.code === "excessive_camera")).toBe(false);
  });

  it("flags effects on most of the clips", () => {
    const clips = Array.from({ length: 10 }, (_, i) =>
      clip(i, { effects: i < 8 ? [{ effectType: "film_grain", intensity: 0.5 }] : [] })
    );
    const found = judgeTimeline(timelineOf(clips)).find((f) => f.code === "excessive_effects");
    expect(found).toBeDefined();
    expect(found!.reason).toContain("filter applied to the film");
    expect(MAX_EFFECT_SHARE).toBeLessThan(1);
  });
});

/* ═══════════════════════ density ═══════════════════════ */

describe("RONDE 157B — density is measured per minute, not per video", () => {
  it("flags caption overload", () => {
    const captions = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`, text: "word", start: i * 0.2, end: i * 0.2 + 0.2, style: DEFAULT_CAPTION_STYLE,
    }));
    const t = timelineOf([clip(0)], { captions, durationSec: 30 });
    const found = judgeTimeline(t).find((f) => f.code === "caption_overload");
    expect(found).toBeDefined();
    expect(MAX_CAPTIONS_PER_MINUTE).toBeGreaterThan(0);
  });

  it("the SAME caption count over a LONGER video is fine", () => {
    const captions = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`, text: "word", start: i * 4, end: i * 4 + 2, style: DEFAULT_CAPTION_STYLE,
    }));
    const t = timelineOf([clip(0)], { captions, durationSec: 600 });
    expect(judgeTimeline(t).some((f) => f.code === "caption_overload")).toBe(false);
  });

  it("flags graphics overload", () => {
    const graphics = Array.from({ length: 20 }, (_, i) => ({
      id: `g${i}`, graphicType: "lower_third", label: "x", data: {}, start: i, end: i + 0.5,
    }));
    const t = timelineOf([clip(0)], { graphics, durationSec: 30 });
    expect(judgeTimeline(t).some((f) => f.code === "graphics_overload")).toBe(true);
    expect(MAX_GRAPHICS_PER_MINUTE).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ §157B — audio must never mask the voice ═══════════════════════ */

describe("RONDE 157B — audio never masks the voice", () => {
  it("flags a loud music bed that does not duck", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      audio: [
        { kind: "VOICE", clip: audioClip("v1") },
        { kind: "MUSIC", clip: audioClip("m1", { gain: 0.9 }) },
      ],
    });
    const found = judgeTimeline(t).find((f) => f.code === "voice_masked");
    expect(found).toBeDefined();
    expect(found!.elementIds).toContain("m1");
    expect(found!.severity).toBe("warning");
  });

  it("does NOT flag the same bed when it ducks", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      audio: [
        { kind: "VOICE", clip: audioClip("v1") },
        { kind: "MUSIC", clip: audioClip("m1", { gain: 0.9, duckUnderVoice: true }) },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "voice_masked")).toBe(false);
  });

  it("does not flag a quiet bed", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      audio: [
        { kind: "VOICE", clip: audioClip("v1") },
        { kind: "MUSIC", clip: audioClip("m1", { gain: MAX_UNDUCKED_BED_GAIN - 0.05 }) },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "voice_masked")).toBe(false);
  });

  /** A bed that plays where nobody is speaking cannot mask anything. */
  it("does not flag a bed that never overlaps the narration", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 40,
      audio: [
        { kind: "VOICE", clip: audioClip("v1", { start: 0, end: 10 }) },
        { kind: "MUSIC", clip: audioClip("m1", { start: 20, end: 40, gain: 1 }) },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "voice_masked")).toBe(false);
  });

  it("checks ambient the same way as music", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      audio: [
        { kind: "VOICE", clip: audioClip("v1") },
        { kind: "AMBIENT", clip: audioClip("a1", { gain: 0.9 }) },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "voice_masked")).toBe(true);
  });
});

/* ═══════════════════════ graphics vs captions ═══════════════════════ */

describe("RONDE 157B — a graphic competing with a caption", () => {
  it("is a NOTICE, because the layout engine resolves it before the render", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      captions: [{ id: "c1", text: "hello", start: 0, end: 5, style: DEFAULT_CAPTION_STYLE }],
      graphics: [
        { id: "g1", graphicType: "lower_third", label: "Tim Cook", data: {}, start: 1, end: 4,
          style: { ...DEFAULT_CAPTION_STYLE } },
      ],
    });
    const found = judgeTimeline(t).find((f) => f.code === "graphic_covers_caption");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("notice");
    expect(found!.elementIds).toEqual(["g1", "c1"]);
  });

  it("says nothing when the two want different positions", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      captions: [{ id: "c1", text: "hello", start: 0, end: 5, style: DEFAULT_CAPTION_STYLE }],
      graphics: [
        { id: "g1", graphicType: "title", label: "1945", data: {}, start: 1, end: 4,
          style: { ...DEFAULT_CAPTION_STYLE, position: "top" } },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "graphic_covers_caption")).toBe(false);
  });

  it("says nothing when they do not share a moment", () => {
    const t = timelineOf([clip(0)], {
      durationSec: 20,
      captions: [{ id: "c1", text: "hello", start: 0, end: 2, style: DEFAULT_CAPTION_STYLE }],
      graphics: [
        { id: "g1", graphicType: "lower_third", label: "Tim Cook", data: {}, start: 8, end: 12,
          style: { ...DEFAULT_CAPTION_STYLE } },
      ],
    });
    expect(judgeTimeline(t).some((f) => f.code === "graphic_covers_caption")).toBe(false);
  });
});

/* ═══════════════════════ the report ═══════════════════════ */

describe("RONDE 157B — the findings read as a report", () => {
  it("are ordered by time", () => {
    const t = timelineOf(Array.from({ length: 8 }, (_, i) => clip(i, { motion: "slow_push" })), {
      durationSec: 40,
      audio: [
        { kind: "VOICE", clip: audioClip("v1") },
        { kind: "MUSIC", clip: audioClip("m1", { gain: 1, start: 10, end: 30 }) },
      ],
    });
    const findings = judgeTimeline(t);
    const times = findings.map((f) => f.atSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("each line names the code, the time and the ids, and carries no payload", () => {
    const t = timelineOf(Array.from({ length: 6 }, (_, i) => clip(i, { motion: "slow_push" })));
    const lines = formatQualityFindings(judgeTimeline(t));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[Director\] (notice|warning) \w+ at [\d.]+s/);
      expect(line).not.toMatch(/https?:/);
      expect(line).not.toContain("/tmp/");
    }
  });

  it("the summary counts warnings separately from notices", () => {
    const t = timelineOf(Array.from({ length: 8 }, (_, i) => clip(i, { motion: "slow_push" })));
    const summary = formatQualitySummary(judgeTimeline(t));
    expect(summary).toMatch(/\d+ finding\(s\), \d+ warning\(s\)/);
  });

  it("an empty timeline is judged without incident", () => {
    expect(judgeTimeline(timelineOf([]))).toEqual([]);
  });
});
