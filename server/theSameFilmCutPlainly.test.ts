/**
 * THE SAME FILM, CUT PLAINLY — RONDE 630.
 *
 * ── The case ────────────────────────────────────────────────────────────────────────────────
 *
 * Render 599 held eleven segments of validated real media and delivered nothing, because the graph
 * that joins them refused. RONDE 628 gave the join a ladder. This is the rung below it: when the
 * flourishes themselves are implicated, the film renders without them rather than not at all.
 *
 * ── The line this file exists to hold ───────────────────────────────────────────────────────
 *
 * SAFE_RENDER is a TECHNICAL fallback, and the whole risk is that it quietly becomes a content
 * one. So §2 checks what survives rather than what is taken away: every clip, in the same order,
 * from the same source, at the same in/out points and the same position, with every audio, caption,
 * text and graphics element untouched.
 *
 * A viewer of the safe render sees the same documentary, cut plainly. Not a shorter one, not an
 * emptier one, and never one with a picture in it that the editor refused.
 *
 * §4 states the thing that must never change: a timeline whose PICTURES are wrong is exactly as
 * wrong afterwards. SAFE_RENDER answers "the renderer could not execute this treatment" and has no
 * answer at all for "we never found a valid shot".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { SAFE_RENDER_ANSWERS } from "./ffmpegFailureClass";

import {
  safeRenderTimeline,
  safeRenderWouldChangeAnything,
  formatSafeRender,
} from "./timelineRepair";
import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const clip = (id: string, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "youtube_cc", providerAssetId: `yt-${id}` } as never,
  sourceIn: 12.5,
  sourceOut: 18.5,
  timelineStart: 0,
  timelineEnd: 6,
  motion: "none" as never,
  previewSource: "asset",
  transitionIn: "hard_cut" as never,
  transitionOut: "hard_cut" as never,
  ...over,
});

/** A timeline shaped like a real documentary scene: moves, effects, dissolves, voice and captions. */
function dressed(): ProjectTimeline {
  const t = emptyTimeline(599);
  t.tracks = [
    {
      kind: "VIDEO",
      clips: [
        clip("vc_0", { camera: { startScale: 1, endScale: 1.12 } as never }),
        clip("vc_1", {
          timelineStart: 6,
          timelineEnd: 12,
          transitionIn: "dissolve" as never,
          transitionInSec: 0.6,
          effects: [{ effectType: "letterbox", intensity: 1 }] as never,
        }),
      ],
    },
    { kind: "VOICE", clips: [{ id: "a_0", start: 0, end: 12 }] },
    { kind: "MUSIC", clips: [{ id: "m_0", start: 0, end: 12 }] },
    { kind: "CAPTIONS", clips: [{ id: "c_0", start: 0, end: 4, text: "In April 1945" }] },
    { kind: "GRAPHICS", clips: [{ id: "g_0", start: 1, end: 3 }] },
  ] as never;
  return t;
}

const videoClips = (t: ProjectTimeline): TimelineVideoClip[] =>
  ((t.tracks.find((x) => x.kind === "VIDEO") as never as { clips: TimelineVideoClip[] })?.clips) ?? [];

/* ═══════════ §1 — what it takes off ═══════════ */

describe("§1 — the flourishes, and only the flourishes", () => {
  it("EFFECTS, CAMERA AND TRANSITIONS ARE ALL REMOVED", () => {
    const out = videoClips(safeRenderTimeline(dressed()).timeline);
    expect(out[0]!.camera).toBeUndefined();
    expect(out[1]!.effects).toBeUndefined();
    expect(out[1]!.transitionIn).toBe("hard_cut");
    expect(out[1]!.transitionInSec).toBeUndefined();
  });

  it("the outgoing transition is normalised too — a plan may not describe a film nobody made", () => {
    const t = dressed();
    videoClips(t)[0]!.transitionOut = "dissolve" as never;
    expect(videoClips(safeRenderTimeline(t).timeline)[0]!.transitionOut).toBe("hard_cut");
  });

  it("each removal is named against its clip", () => {
    const { changes } = safeRenderTimeline(dressed());
    expect(changes).toContainEqual({ clipId: "vc_0", change: "camera_removed" });
    expect(changes).toContainEqual({ clipId: "vc_1", change: "effects_removed" });
    expect(changes).toContainEqual({ clipId: "vc_1", change: "transition_normalised" });
  });

  it("a timeline that is already plain reports no changes and needs no second attempt", () => {
    const plain = emptyTimeline(1);
    plain.tracks = [{ kind: "VIDEO", clips: [clip("vc_0")] }] as never;
    expect(safeRenderTimeline(plain).changes).toEqual([]);
    expect(safeRenderWouldChangeAnything(plain)).toBe(false);
    expect(safeRenderWouldChangeAnything(dressed())).toBe(true);
  });
});

/* ═══════════ §2 — THE LINE: it is the same film ═══════════ */

describe("§2 — every clip survives, unmoved and unshortened", () => {
  const before = dressed();
  const after = safeRenderTimeline(before).timeline;

  it("NO CLIP IS DROPPED AND THE ORDER IS UNCHANGED", () => {
    expect(videoClips(after).map((c) => c.id)).toEqual(videoClips(before).map((c) => c.id));
  });

  it("EVERY CLIP KEEPS ITS SOURCE — no picture is swapped for an easier one", () => {
    for (const [i, c] of videoClips(after).entries()) {
      expect(c.source).toEqual(videoClips(before)[i]!.source);
    }
  });

  it("EVERY CLIP KEEPS ITS IN/OUT POINTS AND ITS POSITION — the length cannot move", () => {
    for (const [i, c] of videoClips(after).entries()) {
      const b = videoClips(before)[i]!;
      expect([c.sourceIn, c.sourceOut, c.timelineStart, c.timelineEnd]).toEqual([
        b.sourceIn, b.sourceOut, b.timelineStart, b.timelineEnd,
      ]);
    }
  });

  it("VOICE, MUSIC, CAPTIONS AND GRAPHICS ARE UNTOUCHED", () => {
    for (const kind of ["VOICE", "MUSIC", "CAPTIONS", "GRAPHICS"]) {
      expect(after.tracks.find((t) => t.kind === kind)).toEqual(
        before.tracks.find((t) => t.kind === kind)
      );
    }
  });

  it("and the input timeline is not mutated", () => {
    const t = dressed();
    safeRenderTimeline(t);
    expect(videoClips(t)[0]!.camera).toBeDefined();
    expect(videoClips(t)[1]!.transitionIn).toBe("dissolve");
  });
});

/* ═══════════ §3 — the log says what was given up ═══════════ */

describe("§3 — loud, not quiet", () => {
  it("SAFE_RENDER_STARTED carries the counts", () => {
    const lines = formatSafeRender(safeRenderTimeline(dressed()));
    expect(lines[0]).toContain("SAFE_RENDER_STARTED");
    expect(lines[0]).toContain("effectsRemoved=1");
    expect(lines[0]).toContain("cameraRemoved=1");
    expect(lines[0]).toContain("transitionsNormalised=1");
  });

  it("and states what it kept, so nobody reads it as a shortened film", () => {
    expect(formatSafeRender(safeRenderTimeline(dressed()))[1]).toContain("this is the same film");
  });

  it("a plain timeline says there was nothing to simplify", () => {
    const plain = emptyTimeline(1);
    plain.tracks = [{ kind: "VIDEO", clips: [clip("vc_0")] }] as never;
    expect(formatSafeRender(safeRenderTimeline(plain))[0]).toContain("nothing to simplify");
  });
});

/* ═══════════ §4 — it is not a quality gate ═══════════ */

describe("§4 — a wrong picture is exactly as wrong afterwards", () => {
  it("SAFE_RENDER ADDS NOTHING — no clip appears that was not already there", () => {
    const before = dressed();
    expect(videoClips(safeRenderTimeline(before).timeline)).toHaveLength(videoClips(before).length);
  });

  it("a disabled clip stays disabled — nothing is switched back on to fill the picture", () => {
    const t = dressed();
    videoClips(t)[1]!.disabled = true;
    expect(videoClips(safeRenderTimeline(t).timeline)[1]!.disabled).toBe(true);
  });

  it("A GAP IS STILL A GAP — the safe pass does not stretch a neighbour over it", () => {
    /**
     * The one thing that would turn this into a content fallback: closing a hole by holding a
     * picture longer. The positions are asserted unchanged in §2; this states the intent.
     */
    const t = dressed();
    videoClips(t)[1]!.timelineStart = 8;
    const out = videoClips(safeRenderTimeline(t).timeline);
    expect(out[0]!.timelineEnd).toBe(6);
    expect(out[1]!.timelineStart).toBe(8);
  });
});

/* ═══════════ §5 — wired into the worker, and bounded ═══════════ */

describe("§5 — the second attempt exists, and is not a blind retry", () => {
  const WORKER = readFileSync(join(__dirname, "renderJobWorker.ts"), "utf8");

  it("THE WORKER RENDERS THE SAFE TIMELINE ON A FAILURE", () => {
    expect(WORKER).toContain("rendered = await renderWith(safe.timeline);");
  });

  it("IT CLASSIFIES BEFORE IT RETRIES — a blind second render is what this is not", () => {
    expect(WORKER).toContain("const diagnosis = classifyFfmpegFailure(renderErr);");
    expect(WORKER).toContain("const treatable = SAFE_RENDER_ANSWERS.has(diagnosis.cls);");
    expect(WORKER).toContain("if (!treatable || safe.changes.length === 0) throw renderErr;");
  });

  it("A CLASS A SIMPLER TREATMENT CANNOT ANSWER IS NOT RETRIED", () => {
    /**
     * The omissions are the point: a missing file is exactly as missing without a zoompan in front
     * of it, and a full disk does not become emptier. Attempting those would spend a whole second
     * render to fail the same way.
     */
    for (const cls of ["INPUT_MISSING", "DECODE", "RESOURCE", "CODEC", "MUX", "TIMEOUT", "UNKNOWN"] as const) {
      expect(SAFE_RENDER_ANSWERS.has(cls), `${cls} must not trigger a safe render`).toBe(false);
    }
  });

  it("and the classes it CAN answer are the ones a filter chain created", () => {
    for (const cls of ["FILTER_GRAPH", "GEOMETRY", "PIXEL_FORMAT", "TIMEBASE", "STREAM_MAPPING"] as const) {
      expect(SAFE_RENDER_ANSWERS.has(cls), `${cls} should be answerable`).toBe(true);
    }
  });

  it("A SAFE RENDER THAT ALSO FAILS THROWS THE FIRST ERROR, not the second", () => {
    /** The first names the original fault; the second names what the simplified graph tripped on. */
    const at = WORKER.indexOf("rendered = await renderWith(safe.timeline);");
    expect(at).toBeGreaterThan(-1);
    expect(WORKER.slice(at, at + 200)).toContain("throw renderErr;");
  });

  it("and what it gave up is printed beside the renderer's own skipped list", () => {
    expect(WORKER).toContain("skippedFromSafeRender.push(");
    expect(WORKER).toContain("[...skippedFromSafeRender, ...(rendered.skipped ?? [])]");
    expect(WORKER).toContain("SAFE_RENDER_SUCCEEDED");
  });
});
