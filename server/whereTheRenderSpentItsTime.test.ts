/**
 * THE REPORT THAT SAYS WHERE A RENDER'S TIME WENT, AND FOR FOUR RENDERS SAID `[object Object]`.
 *
 * ── What was stored ─────────────────────────────────────────────────────────────────────────
 *
 * Render 581's saved pipeline report contains exactly three timing lines, and this is all of them:
 *
 *     [Step] rows=[object Object],[object Object],[object Object],[object Object],…
 *     [Step] totalsByCategory=[object Object]
 *     [Step] totalsByScene=[object Object]
 *
 * ── Why ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `toReport()` returns a SHAPE — `{ rows, totalsByCategory, totalsByScene }` — and the call site
 * walked it as if it were a flat `{ step: ms }` map, stringifying whatever was not a number:
 *
 *     Object.entries(pipelineStepTiming.toReport() as Record<string, unknown>).map(
 *       ([step, ms]) => `[Step] ${step}=${typeof ms === "number" ? ... : String(ms)}`)
 *
 * `String()` of an array of objects is `[object Object],[object Object],…`; of an object, plain
 * `[object Object]`. Three keys, three useless lines, every render.
 *
 * ── What it cost ────────────────────────────────────────────────────────────────────────────
 *
 * The measurements were all taken. Every `record()` fired, every sum was computed — and thrown
 * away one line before it was written down. Meanwhile the question those numbers exist to answer,
 * "what spends the scene budget before YouTube's turn comes", went unanswered across renders 576,
 * 580, 581 and 582, each of which refused every YouTube download at `scene_budget_0s_left`.
 *
 * The instrument was not missing. It was installed, wired, and printing nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { PipelineStepTiming } from "./pipelineStepTiming";

/** `record()` logs as it goes; these tests are about what is REPORTED, so keep the output quiet. */
const timing = (): PipelineStepTiming => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const t = new PipelineStepTiming();
  t.record("image_search", "archive beat s0b0", 48_200, 0);
  t.record("image_download", "youtube s0b0", 12_400, 0);
  t.record("image_processing", "clip vision s0b0", 31_000, 0);
  t.record("image_search", "archive beat s1b0", 90_500, 1);
  t.record("llm_call", "director", 4_100);
  return t;
};

describe("1. the defect itself cannot come back", () => {
  /**
   * THE REGRESSION, stated the way the log showed it. Any future caller — or any future field on
   * the report — that reaches a line without being formatted trips this.
   */
  it("no line stringifies an object", () => {
    for (const line of timing().toReportLines()) {
      expect(line, line).not.toContain("[object Object]");
    }
  });

  it("and no line stringifies an array of them", () => {
    expect(timing().toReportLines().join("\n")).not.toMatch(/\[object Object\],/);
  });

  /**
   * The formatting lives on the report, not at the call site. A caller that has to know the shape
   * is a caller that can get the shape wrong, which is exactly what happened.
   */
  it("the report renders itself", () => {
    expect(typeof new PipelineStepTiming().toReportLines).toBe("function");
  });
});

describe("2. the numbers that were being thrown away are in it", () => {
  const lines = () => timing().toReportLines().join("\n");

  it("the instrumented total, and how many steps it covers", () => {
    // 48.2 + 12.4 + 31.0 + 90.5 + 4.1 = 186.2s
    expect(lines()).toContain("[Step] instrumented total=186.2s across 5 step(s)");
  });

  it("time per category, named rather than keyed", () => {
    expect(lines()).toContain("[Step] category Image / clip search=138.7s");
    expect(lines()).toContain("[Step] category Image / clip download=12.4s");
  });

  /** The question this round is about: which scene spent what. */
  it("time per scene", () => {
    expect(lines()).toContain("[Step] scene 0=91.6s");
    expect(lines()).toContain("[Step] scene 1=90.5s");
  });

  it("and the individual steps, so a total can be traced to a cause", () => {
    expect(lines()).toContain("[Step] slowest s1 archive beat s1b0=90.5s");
    expect(lines()).toContain("[Step] slowest s0 clip vision s0b0=31.0s");
  });

  /** A step with no scene is not attributed to one — a render-wide LLM call belongs to nobody. */
  it("a step outside any scene is not billed to a scene", () => {
    expect(lines()).toContain("[Step] slowest director=4.1s");
    expect(lines()).not.toMatch(/scene \d+=4\.1s/);
  });
});

describe("3. it reads as a diagnosis, not a dump", () => {
  /** Biggest first: the bottleneck is the point, and a reader should not have to sort by hand. */
  it("categories are ordered worst first", () => {
    const cats = timing()
      .toReportLines()
      .filter((l) => l.startsWith("[Step] category "))
      .map((l) => Number(/=([\d.]+)s/.exec(l)![1]));
    expect(cats).toEqual([...cats].sort((a, b) => b - a));
  });

  it("so are the individual steps", () => {
    const steps = timing()
      .toReportLines()
      .filter((l) => l.startsWith("[Step] slowest "))
      .map((l) => Number(/=([\d.]+)s/.exec(l)![1]));
    expect(steps).toEqual([...steps].sort((a, b) => b - a));
  });

  /** Shares, because "90.5s" only means something against the whole. */
  it("each line carries its share of the render", () => {
    expect(timing().toReportLines().join("\n")).toMatch(/=138\.7s 74%/);
  });

  /**
   * A render can run hundreds of steps. An unbounded list is how a report stops being read, so the
   * tail is capped — while the totals above it stay complete, which is what keeps the cap honest.
   */
  it("the step list is capped", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = new PipelineStepTiming();
    for (let i = 0; i < 200; i++) t.record("image_search", `beat ${i}`, 1_000 + i, i % 4);
    const out = t.toReportLines();
    expect(out.filter((l) => l.startsWith("[Step] slowest "))).toHaveLength(15);
    // Totals still count all 200 — the cap trims the list, never the arithmetic.
    expect(out[0]).toContain("across 200 step(s)");
  });

  /** An uninstrumented render says so, rather than printing a bare zero that reads as "instant". */
  it("nothing measured says nothing measured", () => {
    expect(new PipelineStepTiming().toReportLines()).toEqual([
      "[Step] nothing was instrumented for this render",
    ]);
  });
});
