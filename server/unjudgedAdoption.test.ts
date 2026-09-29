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
