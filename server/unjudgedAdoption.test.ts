/**
 * WHICH ROUTE PUT A PICTURE ON SCREEN THAT NOBODY LOOKED AT.
 *
 * ── What render 563 said about itself ───────────────────────────────────────────────────────
 *
 *     beat image gate — attempts=38 answered=38 (fits=20 does_not_fit=18) failed=0 never_asked=21
 *
 *     [BeatVisual] scene=0 beat=0 verification=never_asked reason=real_footage_never_judged source=archive
 *     [BeatVisual] scene=1 beat=0 verification=never_asked reason=real_footage_never_judged source=archive
 *     [BeatVisual] scene=1 beat=1 verification=never_asked reason=real_footage_never_judged source=rescue_stock
 *     [BeatVisual] scene=1 beat=2 verification=never_asked reason=real_footage_never_judged source=archive
 *
 * Real footage in the delivered video that the picture editor was never asked about. Both
 * innocent explanations are ruled out by the render's own numbers: `failed=0` and 38 of 38
 * questions answered means no outage, and 38 spent of a possible 120 means no exhausted budget.
 * The questions were simply never put.
 *
 * ── Why this is measured instead of reasoned out ────────────────────────────────────────────
 *
 * `recordClipAdopt` has 35 call sites. Two are known good: the funnel's look loop judges each
 * candidate and puts an unjudged winner back rather than adopting it, and the adopt loop requeues
 * a refused clip instead of dropping the beat. Reading the other thirty-three and deciding by eye
 * which can reach an adoption without a verdict is the kind of reasoning that has already been
 * wrong seven times in this codebase — most of them recorded in this very file's history.
 *
 * So the render answers it. Every adoption passes through `recordClipAdopt` (that is the whole
 * argument for `bindLineageLedger`), and there the relevance ledger can be asked whether THIS clip
 * was judged for THIS beat. When it was not, the ROUTE LABEL is recorded and printed.
 *
 * This observes and blocks nothing. Making those routes keep searching until something passes is
 * the change that follows — and it needs to know where to be made.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  bindRelevanceLedger,
  createClipAdoptAudit,
  formatUnjudgedAdoptions,
  recordClipAdopt,
  unjudgedAdoptions,
  type ClipAdoptEntry,
} from "./clipAdoptAudit";
import {
  createBeatRelevanceLedger,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";

const BEAT = "In 1941 Adolf Hitler's secret medical treatments could have changed the war.";

function verdict(v: BeatRelevanceDecision["verdict"]): BeatRelevanceDecision {
  return {
    verdict: v,
    allowed: v !== "does_not_fit",
    reprieved: false,
    cached: false,
    depicts: "",
    reason: "",
    route: "archive",
    evaluated: true,
  };
}

function judged(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  v: BeatRelevanceDecision["verdict"] = "fits"
): BeatRelevanceLedger {
  ledger.byClipPath.set(clipPath, {
    ctx: { sceneIndex, beatIndex, beatText: BEAT },
    decision: verdict(v),
  });
  return ledger;
}

/** An adoption, exactly as the 35 call sites make it. */
function adopt(
  audit: ClipAdoptEntry[],
  sceneIndex: number,
  beatIndex: number,
  clipPath: string,
  source: string
): void {
  recordClipAdopt(audit, sceneIndex, beatIndex, BEAT, clipPath, source, "Berlin 1941");
}

/* ═══════════════════════ the gap is recorded, with its route ═══════════════════════ */

describe("an adoption nobody judged is recorded where it happened", () => {
  /** Render 563's s0b0: a curated archive clip adopted with no verdict on that beat. */
  it("records the route that adopted an unjudged picture", () => {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, createBeatRelevanceLedger());
    adopt(audit, 0, 0, "/w/scene_0_b0_curated_a57670.mp4", "archive");

    expect(unjudgedAdoptions(audit)).toEqual([
      { sceneIndex: 0, beatIndex: 0, basename: "scene_0_b0_curated_a57670.mp4", source: "archive" },
    ]);
  });

  /** A judged adoption is not reported — this must not cry wolf on a healthy route. */
  it("says nothing about a picture that was judged", () => {
    const audit = createClipAdoptAudit();
    const ledger = judged(createBeatRelevanceLedger(), "/w/clip.mp4", 0, 0);
    bindRelevanceLedger(audit, ledger);
    adopt(audit, 0, 0, "/w/clip.mp4", "archive");

    expect(unjudgedAdoptions(audit)).toEqual([]);
  });

  /**
   * A refusal IS a judgement. The beat was looked at and overruled — a different problem, already
   * reported by the reprieve machinery, and not this one.
   */
  it("counts a refusal as having been looked at", () => {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, judged(createBeatRelevanceLedger(), "/w/clip.mp4", 0, 0, "does_not_fit"));
    adopt(audit, 0, 0, "/w/clip.mp4", "archive");
    expect(unjudgedAdoptions(audit)).toEqual([]);
  });

  /**
   * The case render 563 actually produced, and the one a beat-only lookup would have missed: one
   * candidate judged and refused, a DIFFERENT clip adopted. The second clip was never looked at.
   */
  it("catches a beat that judged one candidate and adopted another", () => {
    const audit = createClipAdoptAudit();
    const ledger = judged(createBeatRelevanceLedger(), "/w/refused.mp4", 0, 0, "does_not_fit");
    bindRelevanceLedger(audit, ledger);
    adopt(audit, 0, 0, "/w/adopted_instead.mp4", "archive");

    expect(
      unjudgedAdoptions(audit).map((u) => u.basename),
      "the beat's other verdict was borrowed for a clip nobody looked at"
    ).toEqual(["adopted_instead.mp4"]);
  });

  /** A verdict earned on another beat is about other narration and does not excuse this one. */
  it("does not accept a verdict from a different beat", () => {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, judged(createBeatRelevanceLedger(), "/w/clip.mp4", 2, 1));
    adopt(audit, 0, 0, "/w/clip.mp4", "archive");
    expect(unjudgedAdoptions(audit)).toHaveLength(1);
  });

  /** Outside a render nothing is bound and nothing is claimed. */
  it("records nothing when no relevance ledger is bound", () => {
    const audit = createClipAdoptAudit();
    adopt(audit, 0, 0, "/w/clip.mp4", "archive");
    expect(unjudgedAdoptions(audit)).toEqual([]);
  });

  /**
   * MAX_ENTRIES caps the audit array at 120 for the report. Provenance is not capped, and neither
   * is this: a long render must not stop noticing unjudged pictures at clip 120.
   */
  it("keeps noticing past the audit array's cap", () => {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, createBeatRelevanceLedger());
    for (let i = 0; i < 130; i++) adopt(audit, 0, i, `/w/c${i}.mp4`, "archive");
    expect(unjudgedAdoptions(audit).length).toBe(130);
  });
});

/* ═══════════════════════ the line the render prints ═══════════════════════ */

describe("the report names routes, not just a number", () => {
  function withRoutes(): ClipAdoptEntry[] {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, createBeatRelevanceLedger());
    adopt(audit, 0, 0, "/w/a.mp4", "archive");
    adopt(audit, 1, 0, "/w/b.mp4", "archive");
    adopt(audit, 1, 2, "/w/c.mp4", "archive");
    adopt(audit, 1, 1, "/w/d.mp4", "rescue_stock");
    return audit;
  }

  /** A clean render says nothing at all — silence here has to mean something. */
  it("prints nothing when every adopted picture was judged", () => {
    const audit = createClipAdoptAudit();
    bindRelevanceLedger(audit, judged(createBeatRelevanceLedger(), "/w/clip.mp4", 0, 0));
    adopt(audit, 0, 0, "/w/clip.mp4", "archive");
    expect(formatUnjudgedAdoptions(audit)).toEqual([]);
  });

  it("leads with the count", () => {
    expect(formatUnjudgedAdoptions(withRoutes())[0]).toContain(
      "[UnjudgedAdoption] 4 clip(s) became a beat's picture with no verdict on that beat"
    );
  });

  /** The whole point: WHICH route, and on which beats. */
  it("names each route and the beats it did it on", () => {
    const lines = formatUnjudgedAdoptions(withRoutes()).join("\n");
    expect(lines).toContain("route=archive count=3 beats=s0b0,s1b0,s1b2");
    expect(lines).toContain("route=rescue_stock count=1 beats=s1b1");
  });

  /** Worst offender first, so a long list still leads with the route worth fixing. */
  it("puts the worst route first", () => {
    const lines = formatUnjudgedAdoptions(withRoutes());
    expect(lines[1]).toContain("route=archive");
  });

  /** Render 563's exact shape — three archive, one rescue_stock — reproduced end to end. */
  it("reproduces render 563's four unjudged beats", () => {
    expect(formatUnjudgedAdoptions(withRoutes())).toHaveLength(3);
  });
});

/* ═══════════════════════ it sits where every route passes ═══════════════════════ */

describe("the measurement cannot be routed around", () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const PIPE = fs
    .readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  /**
   * Outside the `if (ledger)` block. The lineage may be absent — whether a picture was looked at
   * is a different question with its own ledger, and a render missing one must still answer the
   * other.
   */
  it("runs before the lineage block, not inside it", () => {
    const at = CODE.indexOf("export function recordClipAdopt(");
    expect(at, "recordClipAdopt has moved").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 1200);
    const note = body.indexOf("noteIfUnjudged(audit");
    const ledgerBlock = body.indexOf("if (ledger) {");
    expect(note, "the unjudged check is gone from the adopt chokepoint").toBeGreaterThan(-1);
    expect(note, "the check moved inside the lineage block and now depends on it").toBeLessThan(
      ledgerBlock
    );
  });

  /** Bound once, on the array all 35 call sites share. */
  it("the render binds the relevance ledger beside the lineage ledger", () => {
    expect(PIPE).toContain("bindRelevanceLedger(state.clipAdoptAudit, state.beatRelevance);");
  });

  /** And the render actually prints it, as a warning rather than a log line. */
  it("the render reports what it found", () => {
    expect(PIPE).toContain("for (const line of formatUnjudgedAdoptions(visualDedup.clipAdoptAudit))");
    const at = PIPE.indexOf("for (const line of formatUnjudgedAdoptions(visualDedup.clipAdoptAudit))");
    expect(
      PIPE.slice(at, at + 200),
      "an unjudged picture in a delivered video is logged as if it were routine"
    ).toContain("console.warn(");
  });
});
