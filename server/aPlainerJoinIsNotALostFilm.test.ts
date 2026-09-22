/**
 * A PLAINER JOIN IS NOT A LOST FILM — RONDE 628.
 *
 * ── What render 599 threw away ──────────────────────────────────────────────────────────────
 *
 *     [SegmentSpan] segments=11 unprobed=0 drifted=0 askedTotal=74.65s graphTotal=74.65s
 *     RENDER_FAILED — transition graph: Error while processing the decoded data for stream #10:0
 *     DELIVERY_GATE_FAIL video=599 AUTHORITATIVE_RENDER_FAILED
 *
 * Eleven segments. Every one of them measured, every one of them the length the graph believed,
 * every picture in them already passed by the picture editor. One `xfade` refused and the whole
 * documentary was discarded, because `runFfmpeg("transition graph")` threw and nothing caught it.
 *
 * ── The ladder, and why it has three rungs and not five ─────────────────────────────────────
 *
 * `planned` → `simple` → `cut`.
 *
 * `simple` renames every transition to `fade` and changes NOTHING else: same durations, same
 * offsets, same frames. That is the rung for a transition mode the binary dislikes on this footage.
 *
 * `cut` removes the overlaps — and is the rung that could silently desync the film, because
 * RONDE 184 renders each incoming segment with a HANDLE of extra material at the front for its
 * dissolve to eat. Concatenating those as they are would play the handles and run the picture
 * `Σ handles` long against a voice track it was cut to. So a downgraded join trims the handle it
 * is no longer going to consume, and both rungs land on the same total. §2 is that arithmetic.
 *
 * There is no "retry the identical command" rung. A filtergraph is deterministic; a retry spends
 * minutes to hear the same refusal.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────────────────
 *
 * Not a quality gate bypass. Every rung renders the same validated clips, in the same order, at
 * the same lengths. Only the join between them changes. Nothing becomes eligible that was not, and
 * a render that takes a lower rung says so where the render's other compromises are recorded.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join as pathJoin } from "path";

import {
  buildTransitionGraph,
  TRANSITION_LADDER,
  SIMPLE_TRANSITION_NAME,
} from "./timelineFilters";

const SRC = readFileSync(pathJoin(__dirname, "timelineRenderer.ts"), "utf8");

/** Three shots, two dissolves — the shape render 599 died on, in miniature. */
const DISSOLVES = {
  durations: [8, 6.6, 5.6],
  transitions: [
    { kind: "hard_cut" },
    { kind: "dissolve", durationSec: 0.6 },
    { kind: "dip_to_black", durationSec: 0.6 },
  ],
} as const;

const build = (step?: "planned" | "simple" | "cut") =>
  buildTransitionGraph({ ...DISSOLVES, ...(step ? { step } : {}) });

/* ═══════════ §1 — the rungs ═══════════ */

describe("§1 — three rungs, in order", () => {
  it("THE LADDER IS planned → simple → cut", () => {
    expect([...TRANSITION_LADDER]).toEqual(["planned", "simple", "cut"]);
  });

  it("planned is byte-identical to the graph built with no step at all", () => {
    /** The default must not have moved: every existing render depends on it. */
    expect(build("planned")!.filter).toBe(build()!.filter);
  });

  it("SIMPLE RENAMES EVERY TRANSITION and changes nothing else", () => {
    const planned = build("planned")!;
    const simple = build("simple")!;
    expect(planned.filter).toContain("transition=dissolve");
    expect(planned.filter).toContain("transition=fadeblack");
    expect(simple.filter).not.toContain("transition=dissolve");
    expect(simple.filter).not.toContain("transition=fadeblack");
    expect(simple.filter.match(/transition=fade\b/g)?.length).toBe(2);
    expect(SIMPLE_TRANSITION_NAME).toBe("fade");
  });

  it("and simple keeps every duration and offset exactly", () => {
    const strip = (f: string) => f.replace(/transition=[a-z]+/g, "transition=X");
    expect(strip(build("simple")!.filter)).toBe(strip(build("planned")!.filter));
  });

  it("CUT REPLACES EVERY XFADE WITH A CONCAT", () => {
    const cut = build("cut")!;
    expect(cut.filter).not.toContain("xfade");
    expect(cut.filter.match(/concat=n=2/g)?.length).toBe(2);
  });
});

/* ═══════════ §2 — THE ARITHMETIC: a cut may not desync the voice ═══════════ */

describe("§2 — every rung lands on the same length", () => {
  it("PLANNED AND CUT PRODUCE THE SAME TOTAL — this is what keeps audio in sync", () => {
    expect(build("cut")!.totalSec).toBeCloseTo(build("planned")!.totalSec, 6);
  });

  it("simple lands there too", () => {
    expect(build("simple")!.totalSec).toBeCloseTo(build("planned")!.totalSec, 6);
  });

  it("CUT TRIMS THE HANDLE IT NO LONGER EATS", () => {
    /**
     * Without this the concatenated picture plays the dissolve handles and runs long — RONDE 182's
     * drift, in the other direction. The trim is what makes the totals above agree.
     */
    const cut = build("cut")!.filter;
    expect(cut).toContain("trim=start=0.600,setpts=PTS-STARTPTS,settb=AVTB[t1]");
    expect(cut).toContain("trim=start=0.600,setpts=PTS-STARTPTS,settb=AVTB[t2]");
  });

  it("the first segment is never trimmed — nothing precedes it, so it carries no handle", () => {
    expect(build("cut")!.filter).toContain("[0:v]settb=AVTB[t0]");
    expect(build("cut")!.filter).not.toContain("trim=start=0.000");
  });

  it("a segment whose join was already a hard cut is not trimmed either", () => {
    const g = buildTransitionGraph({
      durations: [5, 5, 5],
      transitions: [{ kind: "hard_cut" }, { kind: "hard_cut" }, { kind: "dissolve", durationSec: 0.5 }],
      step: "cut",
    })!;
    expect(g.filter).toContain("[1:v]settb=AVTB[t1]");
    expect(g.filter).toContain("trim=start=0.500,setpts=PTS-STARTPTS,settb=AVTB[t2]");
  });
});

/* ═══════════ §3 — nothing was loosened ═══════════ */

describe("§3 — the ladder changes joins, never media", () => {
  it("EVERY RUNG USES THE SAME INPUTS IN THE SAME ORDER", () => {
    for (const step of ["planned", "simple", "cut"] as const) {
      const f = build(step)!.filter;
      for (const i of [0, 1, 2]) expect(f, `${step} lost input ${i}`).toContain(`[${i}:v]`);
    }
  });

  it("a pure-cut timeline still returns null, so the stream-copy path is unchanged", () => {
    expect(
      buildTransitionGraph({
        durations: [3, 3, 3],
        transitions: [{ kind: "hard_cut" }, { kind: "hard_cut" }, { kind: "hard_cut" }],
      })
    ).toBeNull();
  });

  it("and a single clip is still not a graph", () => {
    expect(buildTransitionGraph({ durations: [4], transitions: [{ kind: "dissolve" }] })).toBeNull();
  });
});

/* ═══════════ §4 — the renderer actually walks it ═══════════ */

describe("§4 — wired into the failure, and loud about it", () => {
  it("THE RENDERER LOOPS THE LADDER RATHER THAN CALLING ONCE", () => {
    expect(SRC).toContain("for (const step of TRANSITION_LADDER) {");
    expect(SRC).toContain("await runFfmpeg(argsFor(rung.filter), `transition graph (${step})`);");
  });

  it("the shapes are probed once, on the first failure", () => {
    expect(SRC).toContain("if (firstFailure == null) {");
    expect(SRC).toContain("await diagnoseSegmentShapes(graphErr);");
  });

  it("A FILM THAT TOOK A LOWER RUNG SAYS SO where its other compromises are recorded", () => {
    expect(SRC).toContain('if (ladderUsed !== "planned") {');
    expect(SRC).toContain("skipped.push(line);");
    expect(SRC).toContain("[TransitionLadder] RECOVERED via");
  });

  it("AND AN EXHAUSTED LADDER STILL FAILS — with the first fault, not the last", () => {
    expect(SRC).toContain("throw firstFailure;");
  });

  it("the length check downstream reads the rung that rendered, not the one that was planned", () => {
    expect(SRC).toContain("const shortfall = timeline.durationSec - renderedGraph.totalSec;");
  });
});
