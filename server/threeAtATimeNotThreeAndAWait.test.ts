/**
 * THE BARRIER THAT MADE "YOUTUBE FIRST" WORTH NOTHING, AND THE METER THAT COULD NOT SEE IT.
 *
 * ── The barrier ─────────────────────────────────────────────────────────────────────────────
 *
 * The funnel's download loop was
 *
 *     for (let dlIdx = 0; dlIdx < order.length; dlIdx += 3) {
 *       const batch = order.slice(dlIdx, dlIdx + 3);
 *       await Promise.all(batch.map(...));      // ← settles on the SLOWEST of the three
 *       ...
 *     }
 *
 * `Promise.all` waits for its slowest member. Two downloads finishing in two seconds sat idle
 * until the third returned, and one `loc` transfer held a beat for twenty-five minutes while its
 * neighbours had long since finished. Being first in the order bought the hoisted YouTube
 * candidate nothing: it shared a batch with whatever was ranked next.
 *
 * ── The meter ───────────────────────────────────────────────────────────────────────────────
 *
 * `[Budget]` proved retrieval runs ten times over its allowance in every one of 39 measured
 * renders. `[Step]` could not say what inside it, because the only instrumented steps were the
 * provider searches — and those all read 0ms, being cache hits. RONDE 237 made that report
 * legible and it reported 1.7 seconds of an hour, which was every millisecond anyone had measured.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { hoistBudgetSensitiveDownload, type FunnelCandidate } from "./retrievalFunnel";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The funnel's download block, from the concurrency constant to the evaluation that follows. */
const block = (): string => {
  const at = PIPE.indexOf("const FUNNEL_DOWNLOAD_CONCURRENCY = 3;");
  expect(at, "the funnel download block is gone").toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("noteBeatCandidatesOffered(", at));
};

describe("1. the barrier is gone, the ceiling is not", () => {
  /** THE DEFECT. A batch boundary with an await on it is what made a beat wait. */
  it("no longer awaits a batch of three", () => {
    const src = block();
    expect(src).not.toContain("dlIdx += FUNNEL_DOWNLOAD_CONCURRENCY");
    expect(src, "nor slices the order into batches").not.toContain("downloadOrder.slice(dlIdx");
  });

  /**
   * The ceiling the batching existed to impose is kept exactly: three transfers in flight, never
   * four. Removing the barrier must not turn into removing the limit — that would put every
   * candidate on the wire at once and trade one problem for a worse one.
   */
  it("still allows exactly three downloads at a time", () => {
    const src = block();
    expect(src).toContain("pLimit(FUNNEL_DOWNLOAD_CONCURRENCY)");
    expect(PIPE).toContain("const FUNNEL_DOWNLOAD_CONCURRENCY = 3;");
  });

  /** A finished slot starts the next candidate rather than waiting for its neighbours. */
  it("every candidate is submitted to the limiter, not to a batch", () => {
    expect(block()).toContain("tierAdmittedOrder.map((candidate, slotIdx) =>");
    expect(block()).toContain("downloadLimit(async () => {");
  });
});

describe("2. the ranking order survives the change", () => {
  /**
   * THE TRAP THIS ROUND HAD TO AVOID. `downloadedClips` feeds the evaluation, and its order is the
   * ranking order — the order `hoistBudgetSensitiveDownload` exists to set. Pushing results as
   * they settle would order by SPEED, so a fast low-ranked candidate would be judged ahead of the
   * YouTube one deliberately put in front: RONDE 233/234 undone silently, with every test green.
   */
  it("results are written by position, never pushed as they finish", () => {
    const src = block();
    expect(src).toContain("downloadSlots[slotIdx] = { candidate, clipPath }");
    /**
     * The limiter body only — from the arrow to the `})` that closes it. A push ANYWHERE in the
     * download block would be fine (the compaction loop below does exactly that); a push in HERE
     * is the defect, because this is the part that runs out of order.
     */
    const bodyAt = src.indexOf("downloadLimit(async () => {");
    expect(bodyAt).toBeGreaterThan(0);
    const concurrentBody = src.slice(bodyAt, src.indexOf("        );", bodyAt));
    expect(concurrentBody, "no push inside the concurrent body").not.toContain("downloadedClips.push");
    expect(concurrentBody, "and no counter bumped out of order").not.toContain("downloadedCount++");
  });

  it("and the list is compacted in the order the ranking set", () => {
    const src = block();
    expect(src).toContain("for (let slotIdx = 0; slotIdx < tierAdmittedOrder.length; slotIdx++)");
    expect(src).toContain("const candidate = tierAdmittedOrder[slotIdx]!");
  });

  /** The hoist itself is untouched — still one candidate moved, the rest in ranking order. */
  it("the hoist still moves exactly one candidate", () => {
    const c = (id: string, source: string): FunnelCandidate =>
      ({ id, source, title: id, rankingScore: 1, mediaType: "video" }) as unknown as FunnelCandidate;
    const out = hoistBudgetSensitiveDownload([
      c("a1", "archive"), c("y1", "youtube_cc"), c("p1", "pexels"), c("y2", "youtube_cc"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["y1", "a1", "p1", "y2"]);
  });

  /** A failed download is still registered, so later beats look further down the same ranking. */
  it("a failure is still registered against the candidate", () => {
    expect(block()).toContain("dedup.usedFunnelCandidateIds.add(candidate.id)");
  });
});

describe("3. the three stages that spend a render are measured", () => {
  const timed = (label: string): boolean =>
    new RegExp(`recordPipelineTiming\\([\\s\\S]{0,120}?${label}`).test(PIPE);

  /** Finding candidates — the funnel await, which was never on the clock. */
  it("the candidate pool is timed", () => {
    expect(timed('"Funnel candidate pool"')).toBe(true);
  });

  it("the downloads are timed", () => {
    expect(timed("`Funnel downloads")).toBe(true);
  });

  it("and the picture editor's pass over them is timed", () => {
    expect(timed("`Clip vision gate")).toBe(true);
  });

  /**
   * Through the recorder the render already threads, rather than a new one. This codebase's
   * recurring defect is a rule several routes must remember, remembered by one — a second timing
   * object would be exactly that.
   */
  it("through dedup.stepTiming, not a new recorder", () => {
    const src = block();
    expect(src).toContain("dedup.stepTiming");
    expect(PIPE, "no second timing object was introduced").not.toContain("new PipelineStepTiming()\n        ");
  });

  /** Each is filed under the category its report groups by, so the totals mean something. */
  it("each is filed under the right category", () => {
    expect(PIPE).toMatch(/"image_search",\s*"Funnel candidate pool"/);
    expect(PIPE).toMatch(/"image_download",\s*\n?\s*`Funnel downloads/);
    expect(PIPE).toMatch(/"image_processing",\s*\n?\s*`Clip vision gate/);
  });

  /** And attributed to a scene, which is the question the budget lines cannot answer. */
  it("and attributed to its scene", () => {
    const at = PIPE.indexOf('"Funnel candidate pool"');
    expect(PIPE.slice(at, at + 160)).toContain("scene.index");
  });
});
