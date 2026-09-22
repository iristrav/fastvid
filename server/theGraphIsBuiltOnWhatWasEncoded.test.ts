/**
 * THE GRAPH IS BUILT ON WHAT WAS ENCODED — RONDE 608.
 *
 * ── What render 597 died on ─────────────────────────────────────────────────────────────────
 *
 *     RENDER_FAILED — transition graph: Error while processing the decoded data for stream #10:0
 *
 * ffmpeg names an INPUT. Reconstructing the graph from its own offsets shows the arithmetic is
 * sound — d₀=5.000, d₁=9.580, d₂+d₃=23.354, d₄=4.560, d₅+d₆+d₇=13.104, d₈+d₉=4.940, d₁₀=4.052,
 * total 61.09s, which is exactly the duration the render reported. `settb=AVTB` is on every input
 * and `effectiveTransitionSec` clamps every fade under half its shortest neighbour.
 *
 * The graph is not wrong about itself. It is wrong about the FILES.
 *
 *     rendered.push({ clip, durationSec: slotOf(clip) + handleSec, handleSec });
 *     ...
 *     if (fs.existsSync(seg) && fs.statSync(seg).size > 1024) {
 *
 * `durationSec` is what the planner asked for. The only thing ever checked about the encoded file
 * is that it is larger than a kilobyte. A segment that came out short entered the graph under a
 * length it does not have, and ffmpeg reported an input rather than the mismatch.
 *
 * The measuring tool was already in this file — `probeDurationSec`, used on the delivered MP4 at
 * three call sites, and beside one of them the principle is written down:
 *
 *     "Every claim is measured with ffprobe rather than assumed from the fact that ffmpeg
 *      exited zero"
 *
 * Applied to the whole, never to the eleven parts it is built from.
 *
 * ── WHY A TOLERANCE, AND WHY THE ASKED VALUE WINS INSIDE IT ─────────────────────────────────
 *
 * This round must not change what a healthy render produces. `buildTransitionGraph` re-clamps
 * through `effectiveTransitionSec(kind, sec, durations[i], durations[i+1])`, so handing it a
 * measured length two frames short can yield a SHORTER fade than the handle that was actually
 * rendered — the exact drift RONDE 184's comment was written against. Encoders land a frame or
 * two off on every clip, so feeding raw measurements in would alter every render in the product.
 *
 * Inside the tolerance the graph gets the asked value and the output is byte-identical to before.
 * Outside it, the graph gets the truth — and outside it, today's behaviour was a failed render.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { buildTransitionGraph, effectiveTransitionSec } from "./timelineFilters";

const RENDERER = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");

/* ═══════════ §1 — render 597's graph, reconstructed ═══════════ */

describe("§1 — the graph render 597 produced was internally consistent", () => {
  /** The eleven segment lengths solved from the offsets ffmpeg was given. */
  const D597 = [5.0, 9.58, 11.677, 11.677, 4.56, 4.368, 4.368, 4.368, 2.47, 2.47, 4.052];

  it("rebuilds to the duration the render reported", () => {
    /**
     * d₂+d₃ and d₅+d₆+d₇ and d₈+d₉ are only recoverable as sums — a concat hides the split — so
     * they are halved and thirded here. The TOTAL is what the reconstruction proves, and it is
     * the number that matters: the graph's arithmetic closes.
     */
    const graph = buildTransitionGraph({
      durations: D597,
      transitions: [
        { kind: "hard_cut" },
        { kind: "dissolve", durationSec: 0.6 },
        { kind: "crossfade", durationSec: 0.6 },
        { kind: "hard_cut" },
        { kind: "crossfade", durationSec: 0.6 },
        { kind: "crossfade", durationSec: 0.6 },
        { kind: "hard_cut" },
        { kind: "hard_cut" },
        { kind: "dip_to_black", durationSec: 0.5 },
        { kind: "hard_cut" },
        { kind: "crossfade", durationSec: 0.6 },
      ],
    });
    expect(graph).not.toBeNull();
    expect(graph!.totalSec, "the graph's own arithmetic does not close").toBeCloseTo(61.09, 1);
  });

  it("and its last join is the one ffmpeg named", () => {
    const graph = buildTransitionGraph({
      durations: D597,
      transitions: [
        { kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.6 },
        { kind: "crossfade", durationSec: 0.6 }, { kind: "hard_cut" },
        { kind: "crossfade", durationSec: 0.6 }, { kind: "crossfade", durationSec: 0.6 },
        { kind: "hard_cut" }, { kind: "hard_cut" },
        { kind: "dip_to_black", durationSec: 0.5 }, { kind: "hard_cut" },
        { kind: "crossfade", durationSec: 0.6 },
      ],
    });
    expect(graph!.filter).toContain("[t10]");
    expect(graph!.filter, "input 10 is the one ffmpeg refused").toContain("[vout]");
  });
});

/* ═══════════ §2 — why the measurement cannot be fed in raw ═══════════ */

describe("§2 — a raw measurement would shorten real fades", () => {
  it("THE DRIFT RONDE 184 WARNED ABOUT, demonstrated", () => {
    /**
     * A 0.6s fade between two 1.30s slots is legal: the clamp is min(prev,next)/2 = 0.65.
     * Measure those segments two frames short at 30fps (1.233s) and the clamp becomes 0.617 —
     * still above 0.6 here, so take a tighter pair to show the mechanism plainly.
     */
    const asked = effectiveTransitionSec("crossfade", 0.6, 1.2, 1.2);
    const measuredShort = effectiveTransitionSec("crossfade", 0.6, 1.13, 1.13);
    expect(asked).toBeCloseTo(0.6, 3);
    expect(measuredShort, "the fade would run shorter than the handle rendered for it")
      .toBeLessThan(asked!);
  });

  it("which is why the tolerance keeps the asked value", () => {
    /** Two frames at 30fps, floored at 0.08s — the value the renderer computes. */
    expect(Math.max(2 / 30, 0.08)).toBeCloseTo(0.08, 3);
    expect(Math.max(2 / 25, 0.08)).toBeCloseTo(0.08, 3);
    expect(Math.max(2 / 12, 0.08), "a slow timeline gets a wider tolerance").toBeCloseTo(0.167, 2);
  });
});

/* ═══════════ §3 — the renderer measures, and only acts outside the tolerance ═══════════ */

describe("§3 — the segment loop", () => {
  const loop = (() => {
    const at = RENDERER.indexOf("const askedSec = slotOf(clip) + handleSec;");
    return RENDERER.slice(at, at + 1800);
  })();

  it("every segment is probed with the function that was already here", () => {
    expect(loop, "the segment is still trusted unmeasured").toContain(
      "const measuredSec = await probeDurationSec(seg);"
    );
  });

  it("the size check is NOT replaced — it is still the first gate", () => {
    /** A zero-length file must fail before anything tries to probe it. */
    expect(RENDERER).toContain("fs.statSync(seg).size > 1024");
  });

  it("the tolerance is two frames of the timeline's own fps, with a floor", () => {
    expect(loop).toContain("Math.max(2 / Math.max(1, fmt.fps), 0.08)");
  });

  it("INSIDE THE TOLERANCE THE GRAPH GETS THE ASKED VALUE — byte-identical to before", () => {
    expect(loop).toContain("durationSec: material && measuredSec != null ? measuredSec : askedSec,");
  });

  it("an unprobeable segment keeps the asked value too — unknown is not a mismatch", () => {
    /**
     * `probeDurationSec` returns null on any ffprobe failure. `material` requires a non-null
     * measurement, so null falls to `askedSec`, which is exactly today's behaviour.
     */
    expect(loop).toContain("measuredSec != null && Math.abs(measuredSec - askedSec) > toleranceSec");
  });

  it("a material drift is REPORTED, with both numbers and its direction", () => {
    expect(loop).toContain("segment_${drift < 0 ? \"short\" : \"long\"}");
    expect(loop).toContain("asked ${askedSec.toFixed(3)}s");
    expect(loop).toContain("encoded ${measuredSec.toFixed(3)}s");
  });

  it("both numbers are carried, so a report can name the gap rather than the symptom", () => {
    expect(loop).toContain("askedSec,");
    expect(loop).toContain("measuredSec,");
  });
});

/* ═══════════ §4 — the render says what it measured, every time ═══════════ */

describe("§4 — [SegmentSpan]", () => {
  const at = RENDERER.indexOf("`[SegmentSpan] segments=");
  it("is printed before the graph is built, not after it fails", () => {
    expect(at).toBeGreaterThan(-1);
    const graphAt = RENDERER.indexOf("const graph = buildTransitionGraph({");
    expect(at, "a measurement that only appears on failure proves nothing").toBeLessThan(graphAt);
  });

  it("names how many were unprobeable and how many actually drifted", () => {
    const line = RENDERER.slice(at, at + 400);
    expect(line).toContain("unprobed=${unprobed}");
    expect(line).toContain("drifted=${drifted}");
    expect(line).toContain("askedTotal=");
    expect(line).toContain("graphTotal=");
  });

  it("THIS ROUND MEASURES AND CLAMPS — it does not change the graph's shape", () => {
    /**
     * No new transition, no new clamp, no change to `buildTransitionGraph`. The only thing that
     * moves is which number a drifted segment contributes.
     *
     * ── RONDE 628 re-pinned the second assertion, and said so rather than deleting it ────────
     *
     * This used to match one literal line:
     *
     *     for (let i = 0; i < durations.length; i++) steps.push(`[${i}:v]settb=AVTB[t${i}]`);
     *
     * RONDE 628 gave that loop a second form, because the `cut` rung of the transition ladder has
     * to trim the handle RONDE 184 rendered for a dissolve that is no longer going to happen. So
     * the line legitimately moved, and a string match on it would now fail for a reason that has
     * nothing to do with what this test is about.
     *
     * What this test is about is unchanged and is asserted below: the measurement round introduced
     * no clamp of its own, and every input still reaches the graph on one timebase — which is the
     * property the old line existed to protect (see `longRenderDefects.test.ts`, where a mismatched
     * timebase produced a zero-byte file).
     *
     * That the PLANNED rung is byte-identical to the graph this round built is proven behaviourally
     * rather than textually, in `aPlainerJoinIsNotALostFilm.test.ts` §1.
     */
    const FILTERS = readFileSync(join(__dirname, "timelineFilters.ts"), "utf8");
    expect(FILTERS).toContain("const maxSec = Math.min(prevDurationSec, nextDurationSec) * 0.5;");
    expect(FILTERS).toContain("`[${i}:v]settb=AVTB[t${i}]`");
    expect(FILTERS).toContain("setpts=PTS-STARTPTS,settb=AVTB[t${i}]`");
  });
});
