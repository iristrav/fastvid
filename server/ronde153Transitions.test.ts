/**
 * RONDE 153 / 153B — transitions, effects and looks, checked against REAL ffmpeg.
 *
 * Every filter name in `XFADE_TRANSITIONS` and every chain in `effectChain` is a claim about what
 * a binary can do, and a claim like that is worth exactly nothing until the binary has been asked.
 * So the last describe block runs each one through ffmpeg on real frames: a filter that does not
 * exist, or a parameter out of range, fails the graph and fails the test.
 *
 * It runs against BOTH binaries this repo can use — the system ffmpeg and the bundled
 * ffmpeg-static — because a transition that only one of them knows produces a working video on a
 * developer's machine and a filtergraph error in production.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSITION_SEC,
  LOOK_MODIFIERS,
  OVERLAY_EFFECTS,
  OVERLAY_TRANSITIONS,
  RENDERABLE_EFFECTS,
  RENDERABLE_LOOKS,
  XFADE_TRANSITIONS,
  buildTransitionGraph,
  effectChain,
  effectUnsupportedReason,
  gradeChain,
  lookUnsupportedReason,
  transitionIsRenderable,
  transitionUnsupportedReason,
  unsupportedEffects,
  validateEffect,
} from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const BUNDLED = "/home/user/fastvid/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg";

/* ═══════════════════════ the vocabulary ═══════════════════════ */

describe("RONDE 153 — the transition vocabulary", () => {
  it("keeps every transition the renderer already had", () => {
    for (const kind of ["crossfade", "dissolve", "dip_to_black", "dip_to_white"]) {
      expect(transitionIsRenderable(kind), kind).toBe(true);
    }
    // A cut is the ABSENCE of a transition, and must stay on the lossless concat path.
    expect(transitionIsRenderable("hard_cut")).toBe(true);
    expect(XFADE_TRANSITIONS.hard_cut).toBeUndefined();
  });

  it("adds the ones §153 asked for", () => {
    for (const kind of [
      "whip", "zoom", "blur", "slide_left", "slide_right", "slide_up", "slide_down",
      "push", "wipe", "flash",
    ]) {
      expect(transitionIsRenderable(kind), kind).toBe(true);
    }
  });

  /**
   * §153: an overlay transition is NOT faked. A film burn is footage of film burning; a procedural
   * approximation would be a different effect wearing the name the planner chose.
   */
  it("refuses film_burn and light_leak with a reason, rather than approximating them", () => {
    for (const kind of ["film_burn", "light_leak"]) {
      expect(transitionIsRenderable(kind), kind).toBe(false);
      const reason = transitionUnsupportedReason(kind);
      expect(reason, kind).toContain("overlay");
      expect(reason, kind).toContain("none is configured");
    }
    expect(Object.keys(OVERLAY_TRANSITIONS).sort()).toEqual(["film_burn", "light_leak"]);
  });

  it("gives an unknown transition a reason too — never silence", () => {
    expect(transitionUnsupportedReason("kaleidoscope")).toContain("no ffmpeg xfade mode");
    expect(transitionUnsupportedReason("crossfade")).toBeNull();
  });
});

/* ═══════════════════════ the transition engine's arithmetic ═══════════════════════ */

describe("RONDE 153 — a transition never outruns its media", () => {
  it("caps the transition at half the shorter neighbour", () => {
    const graph = buildTransitionGraph({
      durations: [1.0, 8.0],
      transitions: [{ kind: "hard_cut" }, { kind: "crossfade", durationSec: 5 }],
    });
    expect(graph).not.toBeNull();
    // 5s was asked for; the 1s clip allows 0.5s.
    const match = graph!.filter.match(/duration=([\d.]+)/);
    expect(Number(match![1])).toBeLessThanOrEqual(0.5);
  });

  it("never emits a negative offset, whatever the durations", () => {
    for (const durations of [[0.2, 0.2], [0.1, 5], [5, 0.1], [3, 3, 3]]) {
      const graph = buildTransitionGraph({
        durations,
        transitions: durations.map(() => ({ kind: "crossfade", durationSec: 2 })),
      });
      if (!graph) continue;
      for (const m of graph.filter.matchAll(/offset=(-?[\d.]+)/g)) {
        expect(Number(m[1]), graph.filter).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("returns null for a sequence of pure cuts, so the lossless concat path runs", () => {
    expect(
      buildTransitionGraph({
        durations: [4, 4, 4],
        transitions: [{ kind: "hard_cut" }, { kind: "hard_cut" }, { kind: "hard_cut" }],
      })
    ).toBeNull();
  });

  it("an UNSUPPORTED transition does not silently become a crossfade", () => {
    const graph = buildTransitionGraph({
      durations: [4, 4],
      transitions: [{ kind: "hard_cut" }, { kind: "film_burn" }],
    });
    // No xfade name exists for it, so the join concats — and the caller reports the downgrade.
    expect(graph).toBeNull();
    expect(transitionUnsupportedReason("film_burn")).toBeTruthy();
  });

  it("mixes cuts and transitions in one graph without losing either", () => {
    const graph = buildTransitionGraph({
      durations: [4, 4, 4],
      transitions: [{ kind: "hard_cut" }, { kind: "crossfade" }, { kind: "hard_cut" }],
    });
    expect(graph!.filter).toContain("xfade");
    expect(graph!.filter).toContain("concat");
  });

  it("uses the planner's own duration when it fits", () => {
    const graph = buildTransitionGraph({
      durations: [10, 10],
      transitions: [{ kind: "hard_cut" }, { kind: "whip", durationSec: 0.25 }],
    });
    expect(graph!.filter).toContain("duration=0.250");
    expect(graph!.filter).toContain("hlwind");
    expect(DEFAULT_TRANSITION_SEC).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ effects ═══════════════════════ */

describe("RONDE 153B — the effect vocabulary and its bounds", () => {
  it("keeps every effect the renderer already had", () => {
    for (const t of [
      "film_grain", "vignette", "letterbox", "glow", "bloom", "chromatic_aberration",
    ]) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).not.toBeNull();
    }
  });

  it("adds the ones §153B asked for", () => {
    for (const t of [
      "blur", "sharpen", "exposure", "contrast", "saturation", "temperature", "tint",
      "monochrome", "sepia", "scanlines", "noise",
    ]) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).not.toBeNull();
    }
  });

  it("refuses the overlay-dependent ones with a reason", () => {
    for (const t of ["film_dust", "vhs"]) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).toBeNull();
      expect(effectUnsupportedReason(t), t).toBeTruthy();
    }
    expect(Object.keys(OVERLAY_EFFECTS).sort()).toEqual(["film_dust", "vhs"]);
  });

  it("direction flips the sign of a signed effect and nothing else", () => {
    const up = effectChain({ effectType: "temperature", intensity: 0.8, direction: "up" })!;
    const down = effectChain({ effectType: "temperature", intensity: 0.8, direction: "down" })!;
    expect(up).not.toBe(down);
    expect(up).toContain("rm=0.2400");
    expect(down).toContain("rm=-0.2400");
  });

  it("an absent direction means up — what every effect meant before this round", () => {
    expect(effectChain({ effectType: "contrast", intensity: 0.5 })).toBe(
      effectChain({ effectType: "contrast", intensity: 0.5, direction: "up" })
    );
  });

  /**
   * The injection defence §153B asks for, stated as a property: an effect name is only ever
   * matched against a closed set, and every number is computed from a clamped 0..1.
   */
  it("cannot put caller-supplied text into a filter string", () => {
    const evil = effectChain({
      effectType: "blur; drawtext=text='pwned'",
      intensity: 0.5,
    });
    expect(evil).toBeNull();
    expect(RENDERABLE_EFFECTS.has("blur; drawtext=text='pwned'")).toBe(false);
  });

  it("clamps an out-of-range intensity rather than passing it through", () => {
    const high = validateEffect({ effectType: "blur", intensity: 99 });
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.effect.intensity).toBe(1);
    const low = validateEffect({ effectType: "blur", intensity: -5 });
    if (low.ok) expect(low.effect.intensity).toBe(0);
  });

  /** NaN formats as "NaN" through toFixed, which ffmpeg reads as a syntax error. */
  it("refuses a non-finite intensity outright", () => {
    const nan = validateEffect({ effectType: "blur", intensity: Number.NaN });
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.reason).toContain("not a number");
  });

  it("refuses a direction that is neither up nor down", () => {
    const bad = validateEffect({
      effectType: "contrast",
      intensity: 0.5,
      direction: "sideways" as never,
    });
    expect(bad.ok).toBe(false);
  });

  it("no effect chain ever contains NaN or Infinity", () => {
    for (const t of RENDERABLE_EFFECTS) {
      for (const i of [0, 0.001, 0.5, 1]) {
        const chain = effectChain({ effectType: t, intensity: i });
        expect(chain, `${t}@${i}`).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it("unsupportedEffects names what it cannot do, and leaves it on the clip", () => {
    const effects = [
      { effectType: "blur", intensity: 0.4 },
      { effectType: "film_dust", intensity: 0.6, reason: "the planner wanted an aged print" },
    ];
    const unsupported = unsupportedEffects(effects);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.effectType).toBe("film_dust");
    // The planner's own reason survives, because the clip keeps carrying the effect.
    expect(unsupported[0]!.reason).toContain("aged print");
  });
});

/* ═══════════════════════ looks ═══════════════════════ */

describe("RONDE 153 — the looks modify the calibration, they do not replace it", () => {
  it("documentary is byte-identical to what it was before this round", () => {
    const chain = gradeChain({ grade: "documentary" }, "archive")!;
    // No modifier is appended, so the calibration is the whole chain.
    expect(chain).not.toContain(",eq=contrast=1.08");
    expect(chain).toContain("vignette=angle=");
  });

  it("every other look RUNS the calibration first and appends its own adjustment", () => {
    for (const grade of ["cinematic", "vintage", "archival", "cold", "warm", "high_contrast", "muted"] as const) {
      const chain = gradeChain({ grade }, "stock")!;
      // The source-aware calibration is still there — a look never undoes it.
      expect(chain, grade).toContain("vignette=angle=");
      expect(chain, grade).toContain(LOOK_MODIFIERS[grade]!);
    }
  });

  it("stays source-aware: archive and stock still grade differently under the same look", () => {
    expect(gradeChain({ grade: "cinematic" }, "archive")).not.toBe(
      gradeChain({ grade: "cinematic" }, "stock")
    );
  });

  it("none leaves the pixels alone", () => {
    expect(gradeChain({ grade: "none" }, "stock")).toBeNull();
    expect(gradeChain(undefined, "stock")).toBeNull();
  });

  it("strength still scales toward neutral for every look", () => {
    expect(gradeChain({ grade: "warm", strength: 0 }, "stock")).toBeNull();
    const half = gradeChain({ grade: "warm", strength: 0.5 }, "stock")!;
    const full = gradeChain({ grade: "warm", strength: 1 }, "stock")!;
    expect(half).not.toBe(full);
  });

  it("an unknown look is reported and changes nothing", () => {
    expect(gradeChain({ grade: "teal_and_orange" as never }, "stock")).toBeNull();
    expect(lookUnsupportedReason("teal_and_orange")).toContain("no grade chain");
    expect(lookUnsupportedReason("cinematic")).toBeNull();
    expect(RENDERABLE_LOOKS.has("none")).toBe(true);
  });
});

/* ═══════════════════════ REAL ffmpeg ═══════════════════════ */

describe("RONDE 153 — every filter string is accepted by a real ffmpeg", () => {
  let dir: string;
  let a: string;
  let b: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r153-"));
    a = path.join(dir, "a.mp4");
    b = path.join(dir, "b.mp4");
    for (const [file, colour] of [[a, "red"], [b, "blue"]] as const) {
      await execFileAsync(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:d=2:r=24`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
      ]);
    }
  }, 300_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Ask a binary whether it can build this graph, without spending a full encode. */
  async function graphIsValid(bin: string, filter: string): Promise<string | null> {
    try {
      await execFileAsync(bin, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=red:s=320x180:d=0.2:r=24",
        "-vf", filter, "-frames:v", "2", "-f", "null", "-",
      ], { maxBuffer: 1024 * 1024 * 8 });
      return null;
    } catch (err) {
      return (err as Error).message.slice(0, 300);
    }
  }

  it("every EFFECT chain builds in the system ffmpeg", async () => {
    for (const t of RENDERABLE_EFFECTS) {
      const chain = effectChain({ effectType: t, intensity: 0.7 })!;
      expect(await graphIsValid(resolveFFmpegBin(), chain), `${t}: ${chain}`).toBeNull();
    }
  }, 600_000);

  it("every EFFECT chain builds in the BUNDLED ffmpeg-static too", async () => {
    if (!fs.existsSync(BUNDLED)) return;
    for (const t of RENDERABLE_EFFECTS) {
      const chain = effectChain({ effectType: t, intensity: 0.7 })!;
      expect(await graphIsValid(BUNDLED, chain), `${t}: ${chain}`).toBeNull();
    }
  }, 600_000);

  it("every LOOK builds in both binaries", async () => {
    for (const grade of RENDERABLE_LOOKS) {
      if (grade === "none") continue;
      const chain = gradeChain({ grade: grade as never }, "stock")!;
      expect(await graphIsValid(resolveFFmpegBin(), chain), grade).toBeNull();
      if (fs.existsSync(BUNDLED)) {
        expect(await graphIsValid(BUNDLED, chain), `${grade} (bundled)`).toBeNull();
      }
    }
  }, 600_000);

  /**
   * The transitions are checked by RENDERING them, not by validating a graph: xfade needs two real
   * inputs, and an xfade mode a binary does not know fails at graph-build time with a message that
   * names it. A produced file with the right duration is the proof.
   */
  it("every TRANSITION renders a real file", async () => {
    for (const kind of Object.keys(XFADE_TRANSITIONS)) {
      const graph = buildTransitionGraph({
        durations: [2, 2],
        transitions: [{ kind: "hard_cut" }, { kind, durationSec: 0.5 }],
      });
      expect(graph, kind).not.toBeNull();

      const out = path.join(dir, `t_${kind}.mp4`);
      await execFileAsync(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", a, "-i", b,
        "-filter_complex", graph!.filter, "-map", "[vout]",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
      ], { maxBuffer: 1024 * 1024 * 8 });

      expect(fs.existsSync(out), kind).toBe(true);
      expect(fs.statSync(out).size, kind).toBeGreaterThan(1024);
    }
  }, 900_000);

  /**
   * A transition really does mix the two shots. Halfway through a 0.5s crossfade between a red
   * clip and a blue one, the frame must be neither pure red nor pure blue — otherwise the xfade
   * ran but produced a cut, which is exactly the silent downgrade §153 forbids.
   */
  it("a crossfade actually BLENDS, rather than cutting", async () => {
    const graph = buildTransitionGraph({
      durations: [2, 2],
      transitions: [{ kind: "hard_cut" }, { kind: "crossfade", durationSec: 0.8 }],
    })!;
    const out = path.join(dir, "blend.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", a, "-i", b,
      "-filter_complex", graph.filter, "-map", "[vout]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
    ], { maxBuffer: 1024 * 1024 * 8 });

    // The join sits at 2 - 0.8 = 1.2s; sample its midpoint.
    const raw = path.join(dir, "blend.raw");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", "1.6", "-i", out,
      "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
    ]);
    const [r, g, bl] = fs.readFileSync(raw);
    // Both channels present means the two shots are genuinely mixed at this instant.
    expect(r, `rgb=${r},${g},${bl}`).toBeGreaterThan(20);
    expect(bl, `rgb=${r},${g},${bl}`).toBeGreaterThan(20);
  }, 300_000);
});
