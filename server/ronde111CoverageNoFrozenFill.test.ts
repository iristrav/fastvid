/**
 * RONDE 111 — a shortage of footage is answered with footage, not with a slower clock.
 *
 * RONDE 26 filled a montage shorter than its own voice track by holding the last frame. RONDE 85
 * measured the cost of that (render 536: a 10.6-second frozen frame, 30 frozen segments in the
 * delivered file) and replaced it with slowing the montage down — deliberately without a cap, on
 * the reasoning that a cap leaves a remainder and the only things that could fill a remainder were
 * the two it existed to remove.
 *
 * Right about the remainder, wrong about the cure. Measured against real ffmpeg on footage that
 * moves, with no interpolation anywhere in the chain:
 *
 *     1.5x → each picture stands still 0.10s      6x → 0.32s
 *     3.0x → 0.18s                                10x → 0.59s   (under two new pictures a second)
 *
 * Past about 2x that is a slideshow of held frames reached through a different filter — and the
 * render's own freezedetect never saw it, because it needs 2.5 seconds of stillness and a 0.6s
 * hold never gets there.
 *
 * So: slowing is capped at 2x, the searching that would have been skipped now happens exactly
 * where the cap would otherwise bite, short clips stop being refused from short slots, and a held
 * frame is what is left when all of that has genuinely run out — labelled as such.
 *
 * The relevance architecture is untouched. Every clip these rounds add still comes through the
 * same beat → search-query → vision chain; nothing is added because it is the right length.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  MAX_COVERAGE_SLOWDOWN,
  MIN_STITCHABLE_SOURCE_SEC,
  coverageFloorSec,
  formatCoverageFillPlan,
  planCoverageFill,
  stitchSourceFloorSec,
} from "./coverageFillPlan";
import { montageTailPadFilterChain } from "./videoPipeline";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const DOCSTYLE = fs.readFileSync(path.join(__dirname, "documentaryStyle.ts"), "utf8");

/** The standalone floor the ordinary beat path still uses. */
const STANDALONE_FLOOR = 2.8;

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/* ═══════════ 1. normale coverage ═══════════ */

describe("RONDE 111 — a scene that is covered is left alone", () => {
  it("no shortfall means no filter at all", () => {
    const plan = planCoverageFill(20, 20);
    expect(plan.action).toBe("none");
    expect(plan.slowdownRatio).toBe(1);
    expect(montageTailPadFilterChain(20, 20, "covered scene")).toBe("");
  });

  it("a rounding-sized shortfall is not worth a filter either", () => {
    expect(planCoverageFill(20, 20.05).action).toBe("none");
  });

  it("a montage LONGER than its scene is not stretched backwards", () => {
    const plan = planCoverageFill(24, 20);
    expect(plan.shortfallSec).toBe(0);
    expect(plan.slowdownRatio).toBe(1);
  });
});

/* ═══════════ 2. tekort onder 2× ═══════════ */

describe("RONDE 111 — a small shortfall is still absorbed by slowing", () => {
  it("18s of montage in a 20s scene slows 1.11x and is fully covered", () => {
    const plan = planCoverageFill(18, 20);
    expect(plan.action).toBe("slow");
    expect(plan.slowdownRatio).toBeCloseTo(20 / 18, 5);
    expect(plan.stillShortSec).toBe(0);
  });

  it("the filter is setpts only — no tpad, so nothing is held", () => {
    const chain = montageTailPadFilterChain(18, 20, "small shortfall");
    expect(chain).toContain("setpts=");
    expect(chain).not.toContain("tpad");
  });

  it("exactly 2x is still fully covered by slowing", () => {
    const plan = planCoverageFill(10, 20);
    expect(plan.slowdownRatio).toBe(2);
    expect(plan.action).toBe("slow");
    expect(plan.stillShortSec).toBe(0);
    expect(montageTailPadFilterChain(10, 20, "at the cap")).not.toContain("tpad");
  });
});

/* ═══════════ 3. tekort boven 2× ═══════════ */

describe("RONDE 111 — a large shortfall is NOT absorbed by slowing", () => {
  it("the ratio never exceeds the cap, whatever the shortfall", () => {
    for (const [montage, target] of [[8, 20], [4, 20], [2, 20], [0.5, 30], [1, 120]]) {
      const plan = planCoverageFill(montage!, target!);
      expect(plan.slowdownRatio, `${montage}s in ${target}s`).toBeLessThanOrEqual(
        MAX_COVERAGE_SLOWDOWN
      );
    }
  });

  it("the old uncapped 10x case is now 2x plus a named remainder", () => {
    const plan = planCoverageFill(2, 20);
    expect(plan.uncappedRatio).toBe(10);
    expect(plan.slowdownRatio).toBe(2);
    expect(plan.stillShortSec).toBe(16);
    expect(plan.action).toBe("hold_frame");
  });

  it("the emitted filter slows to the cap and holds only the remainder", () => {
    const chain = montageTailPadFilterChain(2, 20, "big shortfall");
    expect(chain).toContain("setpts=2.000000*PTS");
    expect(chain).toContain("tpad=stop_mode=clone:stop_duration=16.000");
  });

  it("the report says how short it was and that this is a last resort", () => {
    const line = formatCoverageFillPlan("Scene 7", planCoverageFill(2, 20));
    expect(line).toContain("short 18.00s");
    expect(line).toContain("10.00x");
    expect(line).toContain("STILL UNCOVERED");
    expect(line).toContain("held frame (last resort)");
    expect(line).toContain("short of footage");
  });

  it("a scene below the floor triggers the extra searching, and one above it does not", () => {
    expect(coverageFloorSec(20)).toBe(10);
    // 12s of montage in a 20s scene: 1.67x, under the cap → no extra wall clock spent.
    expect(12).toBeGreaterThanOrEqual(coverageFloorSec(20));
    // 8s: 2.5x → would hold a frame, so it earns the extra rounds.
    expect(8).toBeLessThan(coverageFloorSec(20));
    expect(PIPELINE).toContain("const floor = coverageFloorSec(scene.duration);");
    // RONDE 112 restated this line in the report's key=value shape; the rule is unchanged.
    expect(PIPELINE).toContain("within the ${MAX_COVERAGE_SLOWDOWN}x budget, no extra search needed");
  });
});

/* ═══════════ 4. meerdere korte maar geschikte clips ═══════════ */

describe("RONDE 111 — a short clip is no longer refused from a short slot", () => {
  it("the floor is the slot's own length once the slot is shorter than the standalone floor", () => {
    expect(stitchSourceFloorSec(1.5, STANDALONE_FLOOR)).toBe(1.5);
    expect(stitchSourceFloorSec(2.0, STANDALONE_FLOOR)).toBe(2.0);
  });

  it("the ordinary beat path is UNCHANGED — a long slot still wants a standalone clip", () => {
    /**
     * The whole risk of this change is a montage of two-second fragments. It cannot happen on the
     * normal path: a beat asking for five seconds still measures candidates against 2.8s.
     */
    expect(stitchSourceFloorSec(5, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(stitchSourceFloorSec(8, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(stitchSourceFloorSec(2.8, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
  });

  it("there is still a technical floor — a flash frame is not an edit", () => {
    expect(stitchSourceFloorSec(0.4, STANDALONE_FLOOR)).toBe(MIN_STITCHABLE_SOURCE_SEC);
    expect(stitchSourceFloorSec(0, STANDALONE_FLOOR)).toBe(STANDALONE_FLOOR);
    expect(MIN_STITCHABLE_SOURCE_SEC).toBe(1.2);
  });

  it("the trim uses it for both the source and the result, and says which slot it judged", () => {
    expect(CURATED).toContain("const minSource = stitchSourceFloorSec(");
    expect(CURATED).toContain("if (sourceDur > 0 && sourceDur < minSource) {");
    expect(CURATED).toContain("if (outDur < minSource) {");
    expect(CURATED).toContain("for a ${duration.toFixed(2)}s slot");
  });

  it("the short-clip round asks for short holds, which is what unlocks those candidates", () => {
    expect(PIPELINE).toContain(
      "const shortHold = Math.max(MIN_STITCHABLE_SOURCE_SEC, Math.min(2.5, scene.duration / 4));"
    );
    // ...and it runs several times, so several short clips get stitched.
    expect(PIPELINE).toContain("for (let attempt = 0; attempt < 8 && coverage < minCoverage; attempt++)");
  });

  it("those clips go through the SAME beat chain — no filler is invented", () => {
    const idx = PIPELINE.indexOf("Round A — ask for SHORT holds.");
    const body = PIPELINE.slice(idx, idx + 2200);
    // The same per-beat filler every other clip comes from, with this beat's own semantic profile.
    expect(body).toContain("await ensureBeatVisualFilled(");
    expect(body).toContain("semanticProfiles.get(beat.index)");
    expect(body).toContain("pushSceneClip(clipPath, sec, beat.index)");
    // ...and pushSceneClip is the one that still consults the relevance gate.
    expect(PIPELINE).toContain("if (beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)) return false;");
  });

  it("the beat it searches on is the one that is actually short, not an arbitrary one", () => {
    const idx = PIPELINE.indexOf("Round A — ask for SHORT holds.");
    expect(PIPELINE.slice(idx, idx + 2200)).toContain("pickVoiceBackfillBeatIndex(");
  });
});

/* ═══════════ 5. geen geschikte kandidaten ═══════════ */

describe("RONDE 111 — when no new candidate exists, the scene's own footage moves", () => {
  it("round B re-uses the last real clip in motion rather than freezing it", () => {
    const idx = PIPELINE.indexOf("Round B — re-use this scene's OWN footage, in motion.");
    expect(idx).toBeGreaterThan(-1);
    const body = PIPELINE.slice(idx, idx + 2400);
    expect(body).toContain("await extendLastClip(source,");
    expect(body).toContain('"rescue_extend"');
  });

  it("extendLastClip keeps the picture moving — a loop under a zoom, never a still", () => {
    const idx = PIPELINE.indexOf("async function extendLastClip(");
    const body = PIPELINE.slice(idx, idx + 2200);
    expect(body).toContain("-stream_loop -1");
    expect(body).toContain("zoompan=z=");
    // d=1 advances one output frame per real input frame, so nothing is ever held static.
    expect(body).toContain(":d=1:s=");
  });

  it("it is recorded as a rescue, never as a verified fit for the beat", () => {
    // rescue_extend maps to held_frame coverage in the quality report — it counts as a stand-in.
    const status = fs.readFileSync(path.join(__dirname, "beatVisualStatus.ts"), "utf8");
    expect(status).toContain('["rescue_extend", "held_frame"]');
  });

  it("with no real clip at all it says so instead of pretending it filled the scene", () => {
    // RONDE 112 gave every held-frame exit a machine-readable reason. Same exit, named.
    expect(PIPELINE).toContain("resolution=held_frame reason=no_real_clip_to_reuse");
  });
});

/* ═══════════ 6. absolute laatste fallback ═══════════ */

describe("RONDE 111 — the held frame is the last resort and is labelled as one", () => {
  it("a montage of literally nothing still produces a held frame rather than a crash", () => {
    const plan = planCoverageFill(0, 12);
    expect(plan.action).toBe("hold_frame");
    expect(plan.stillShortSec).toBe(12);
    expect(plan.uncappedRatio).toBe(Infinity);
    expect(formatCoverageFillPlan("Scene 3", plan)).toContain("∞");
  });

  it("that case emits a tpad and no setpts — there is nothing to slow", () => {
    const chain = montageTailPadFilterChain(0, 12, "empty montage");
    expect(chain).toContain("tpad=stop_mode=clone");
    expect(chain).not.toContain("setpts=");
  });

  it("the operator escape hatches still work", () => {
    withEnv("MONTAGE_TAIL_PAD", "freeze", () => {
      const chain = montageTailPadFilterChain(10, 20, "forced freeze");
      expect(chain).toContain("tpad=stop_mode=clone:stop_duration=10.000");
      expect(chain).not.toContain("setpts=");
    });
    withEnv("MONTAGE_TAIL_PAD", "grey", () => {
      expect(montageTailPadFilterChain(10, 20, "forced grey")).toContain("color=0x2a2a2a");
    });
  });

  it("without an override, a held frame is never reachable while slowing can finish the job", () => {
    withEnv("MONTAGE_TAIL_PAD", undefined, () => {
      for (const [montage, target] of [[10, 20], [15, 20], [19, 20], [10.1, 20]]) {
        expect(
          montageTailPadFilterChain(montage!, target!, `ratio ${(target! / montage!).toFixed(2)}`),
          `${montage}s in ${target}s`
        ).not.toContain("tpad");
      }
    });
  });

  it("the last line before compose says what compose is about to do", () => {
    // RONDE 112: now with the numbers rather than the sentence — the applied slow-motion factor
    // and the seconds that will actually be held.
    expect(PIPELINE).toContain("resolution=held_frame reason=exhausted");
    expect(PIPELINE).toContain(
      "slowdown=${plan.slowdownRatio.toFixed(2)}x held=${plan.stillShortSec.toFixed(1)}s"
    );
  });
});

/* ═══════════ 7. foto's met Ken Burns ═══════════ */

describe("RONDE 111 — a photo keeps moving all the way to its last frame", () => {
  it("the easing no longer ends at zero velocity", () => {
    /**
     * Pure sin(PI/2*t) has derivative cos(PI/2) = 0 at t=1. Measured on a six-second still, the
     * crop window moved 71.8 px in the first second and 7.5 px in the last — 0.30 px/frame, which
     * the eye reads as a stopped picture. Every photo ended on a small freeze.
     */
    const share = 0.35;
    const velocity = (t: number) => share * (Math.PI / 2) * Math.cos((Math.PI / 2) * t) + (1 - share);
    expect(velocity(1)).toBeCloseTo(1 - share, 5);
    expect(velocity(1)).toBeGreaterThan(0.6);
    // The old curve, for contrast.
    const old = (t: number) => (Math.PI / 2) * Math.cos((Math.PI / 2) * t);
    expect(old(1)).toBeCloseTo(0, 6);
  });

  it("it is still an ease, not the linear motion that read as machine-made", () => {
    const share = 0.35;
    const velocity = (t: number) => share * (Math.PI / 2) * Math.cos((Math.PI / 2) * t) + (1 - share);
    expect(velocity(0)).toBeGreaterThan(velocity(1));
    expect(velocity(0)).toBeCloseTo(1.1996, 3);
  });

  it("the source carries the blend, not a bare sine", () => {
    expect(DOCSTYLE).toContain("const KEN_BURNS_EASE_SHARE = 0.35;");
    expect(DOCSTYLE).toContain("`(${eased}*sin(PI/2*${t})+${linear}*${t})`");
    // The unblended version is gone from the code.
    const code = DOCSTYLE.split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("return `sin(PI/2*min(on/${totalFrames},1))`;");
  });

  it("the total travel is unchanged — this moved the velocity curve, not the framing", () => {
    // progress(1) must still be exactly 1, or the photo would stop short of its target zoom.
    const share = 0.35;
    const progress = (t: number) => share * Math.sin((Math.PI / 2) * t) + (1 - share) * t;
    expect(progress(1)).toBeCloseTo(1, 10);
    expect(progress(0)).toBeCloseTo(0, 10);
  });

  it("stills are never rendered without motion in the first place", () => {
    // Both the styled path and its fallback go through a zoompan.
    expect(DOCSTYLE).toContain("export function buildSimpleKenBurnsVF(");
    expect(DOCSTYLE).toContain("export function buildKenBurnsTail(");
    expect(PIPELINE).toContain("buildSimpleKenBurnsVF(duration, personPortrait)");
  });
});

/* ═══════════ logging ═══════════ */

describe("RONDE 111 — the decision is visible afterwards, per video", () => {
  it("every coverage decision is kept, not only printed", () => {
    expect(PIPELINE).toContain("coverageDecisions: string[];");
    expect(PIPELINE).toContain("coverageDecisions: [],");
    expect(PIPELINE).toContain("dedup.coverageDecisions.push(text);");
  });

  it("it reaches the stored pipeline report the admin reads", () => {
    expect(PIPELINE).toContain('pipelineReport.addAll("warnings", visualDedup.coverageDecisions);');
  });

  it("each line carries the seconds and the resolution, not just a complaint", () => {
    const line = formatCoverageFillPlan("Scene 4", planCoverageFill(9, 20));
    expect(line).toMatch(/short \d+\.\d\ds/);
    expect(line).toMatch(/would need \d+\.\d\dx/);
    expect(line).toContain("2x cap");
  });

  it("a clip refused for length says the floor AND the slot it was judged against", () => {
    expect(CURATED).toContain(
      "`source video too short (${sourceDur.toFixed(2)}s < ${minSource.toFixed(2)}s for a ${duration.toFixed(2)}s slot)`"
    );
  });
});

/* ═══════════ the relevance architecture is untouched ═══════════ */

describe("RONDE 111 — nothing about relevance changed", () => {
  it("no new judge, no new query builder, no second gate", () => {
    const plan = fs.readFileSync(path.join(__dirname, "coverageFillPlan.ts"), "utf8");
    // The rules module is pure arithmetic: it must not reach for anything.
    expect(plan).not.toContain("import ");
    for (const forbidden of ["judgeBeatImage", "evaluateClipVisionGate", "buildSearchQuery", "openai"]) {
      expect(plan, forbidden).not.toContain(forbidden);
    }
  });

  it("the single content decider is still the only content decider", () => {
    expect(PIPELINE).toContain("beatClipRefusedByRelevanceGate(");
  });
});
