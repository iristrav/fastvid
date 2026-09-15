/**
 * RONDE 247 — A METER THAT ONLY READ ON THE DAYS NOTHING WENT WRONG.
 *
 * RONDE 241 attached the step meter to the three retrieval stages that spend a render, to answer
 * the question thirty-nine renders had failed to answer: where do the forty-eight minutes go.
 * Render 584 was the first render after it shipped, and the report was absent from the log.
 *
 * Not because the meter did not record. Because `toReportLines()` had exactly one reader — the
 * success path, with no `catch` or `finally` over it — and the render threw at the export gate
 * eleven thousand lines earlier. The instrument printed for every render that worked and stayed
 * silent for every render that did not, which is the only kind anyone needs it for.
 *
 * That is the third commission of one defect: RONDE 226 found it in `[BeatFunnel]`, RONDE 227 in
 * the shortlist invariants, and RONDE 241's own meter walked into it. The test is written against
 * the exit these renders actually take, not against the one they are supposed to.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PipelineStepTiming } from "./pipelineStepTiming";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The export-gate block: everything between the scene's "bruikbare clips" line and the throw that
 * ends the render. This is the exit render 582 and render 584 both took.
 */
const exportGateBlock = (): string => {
  const from = PIPE.indexOf("bruikbare clips — ");
  const to = PIPE.indexOf("export geblokkeerd", from);
  expect(from, "the export gate's diagnostic line").toBeGreaterThan(-1);
  expect(to, "the throw that ends the render").toBeGreaterThan(from);
  return PIPE.slice(from, to);
};

describe("1. the render that failed says where its time went", () => {
  it("the time report is printed at the exit these renders take", () => {
    expect(
      exportGateBlock(),
      "RONDE 241's meter was unreachable from the only exit these renders reach"
    ).toContain("stepTiming?.toReportLines()");
  });

  /** The company it keeps is the argument: the same block already prints for the same reason. */
  it("beside the funnel and the invariants, which are there on the same argument", () => {
    const block = exportGateBlock();
    expect(block).toContain("formatBeatShortlists(dedup.beatShortlist)");
    expect(block).toContain("beatShortlistViolations(dedup.beatShortlist)");
  });

  /** And the success path keeps its own reader — this adds an exit, it does not move one. */
  it("without taking the report away from renders that succeed", () => {
    expect(PIPE).toContain('pipelineReport.addAll("timing", pipelineStepTiming.toReportLines())');
  });
});

describe("2. what it prints when there is nothing to print", () => {
  /**
   * A render that died before anything was instrumented must say so, not emit a confident zero.
   * An empty report read as "retrieval took no time" is how thirty-nine renders were misread.
   */
  it("an uninstrumented render says so rather than reporting nothing", () => {
    const lines = new PipelineStepTiming().toReportLines();
    expect(lines.join("\n")).toContain("nothing was instrumented");
  });

  it("and a partially instrumented one reports what it did measure", () => {
    const t = new PipelineStepTiming();
    t.record("image_search", "Funnel candidate pool", 12_000, 2);
    const out = t.toReportLines().join("\n");
    expect(out).toContain("Funnel candidate pool");
    expect(out, "the [object Object] of RONDE 237 must not come back").not.toContain("[object Object]");
  });
});
