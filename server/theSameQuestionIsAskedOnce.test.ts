/**
 * ONE BEAT ASKED THE SAME SEVEN QUESTIONS TWENTY-FOUR TIMES.
 *
 * ── What render 581 measured ────────────────────────────────────────────────────────────────
 *
 *     [SearchQueryAudit] render=581 scene=2 beat=1 provider=pexels  … × 168
 *     [SearchQueryAudit] render=581 scene=2 beat=1 provider=pixabay … × 168
 *     [SearchQueryAudit] render=581 scene=2 beat=2 provider=pexels  … ×   7
 *     [SearchQueryAudit] render=581 scene=2 beat=3 provider=pexels  … ×   7
 *
 * Seven queries per run of the ladder. Beats 2 and 3 ran it once. Beat 1 ran it twenty-four times,
 * asking the same seven questions of the same two providers about the same sentence. Six of the
 * seven came back `status=BLOCKED` from the search gate every single time.
 *
 * What it cost the render:
 *
 *     [VisualFunnel] pexels  retrieved=12855 downloadSucceeded=275 adopted=0 finalVideo=0
 *     [VisualFunnel] pixabay retrieved= 3676 downloadSucceeded=107 adopted=0 finalVideo=0
 *     Pexels search+download   2228 rows  472,4s
 *     Pixabay search+download  2228 rows  375,9s
 *
 * 382 stock video files fetched, none adopted, 848 seconds of a 180-second-per-scene budget — the
 * budget YouTube then found at zero and stood aside from 194 times.
 *
 * ── Why the beat could never finish, which is why it kept asking ────────────────────────────
 *
 * The archive had no row for it, stock found nothing usable, the guaranteed card was drawn, and
 * the backfill refused the card for want of an approval:
 *
 *     [BeatRelevance] s2b1: refusing to push scene_2_slot1_guaranteed.mp4 — backfill needs an
 *                     approval; the editor answered unknown on s2b1            (× 50)
 *
 * The beat stayed empty, so the next of the ladder's TEN call sites tried the same thing. The
 * refusal did not end the loop; it fed it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { maxStockLadderRunsPerBeat, formatStockLadderBounds } from "./videoPipeline";

describe("1. how many times one beat may run the stock ladder", () => {
  it("once, by default", () => {
    delete process.env.MAX_STOCK_LADDER_RUNS_PER_BEAT;
    expect(maxStockLadderRunsPerBeat()).toBe(1);
  });

  /**
   * A bound on RETRIES, not a gate on quality — so an operator may raise it, and the report says
   * what it cost. But it is clamped: a typo may not restore the twenty-four.
   */
  it.each([
    ["2", 2],
    ["4", 4],
    ["0", 1],
    ["24", 1],
    ["-1", 1],
    ["nonsense", 1],
    ["", 1],
  ])("MAX_STOCK_LADDER_RUNS_PER_BEAT=%s resolves to %i", (raw, expected) => {
    process.env.MAX_STOCK_LADDER_RUNS_PER_BEAT = raw;
    expect(maxStockLadderRunsPerBeat()).toBe(expected);
    delete process.env.MAX_STOCK_LADDER_RUNS_PER_BEAT;
  });
});

describe("2. the render says what the bounds cost, zero included", () => {
  it("a render that never repeated anything says so in words", () => {
    const line = formatStockLadderBounds({
      stockLadderStandAsides: 0,
      stockQueryRepeatsSkipped: 0,
      stockLadderRunsByBeat: new Map([["s0b0", 1], ["s0b1", 1]]),
    });
    expect(line).toContain("beatsAsked=2");
    expect(line).toContain("repeatRunsRefused=0");
    expect(line).toContain("repeatQueriesSkipped=0");
  });

  it("render 581's shape is legible in one line", () => {
    const line = formatStockLadderBounds({
      stockLadderStandAsides: 23,
      stockQueryRepeatsSkipped: 161,
      stockLadderRunsByBeat: new Map([["s2b1", 1], ["s2b2", 1], ["s2b3", 1]]),
    });
    expect(line).toContain("[StockLadder]");
    expect(line).toContain("repeatRunsRefused=23");
    expect(line).toContain("repeatQueriesSkipped=161");
  });
});

describe("3. the bound sits where all ten callers pass through it", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const WRAPPER = SRC.slice(
    SRC.indexOf("async function adoptStockBeatClipFallback("),
    SRC.indexOf("async function adoptStockBeatClipFallbackInner(")
  );

  /**
   * Ten call sites reach this ladder. A bound added to the callers is the
   * rule-registered-by-a-few pattern that produced the defect in the first place; the wrapper is
   * the one place that reaches all ten and the eleventh.
   */
  it("the ladder still has many callers, which is why the bound is not in them", () => {
    const callers = SRC.split("adoptStockBeatClipFallback(").length - 1;
    expect(callers).toBeGreaterThan(8);
  });

  it("the wrapper counts the run and stands aside past the bound", () => {
    expect(WRAPPER).toContain("stockLadderRunsByBeat");
    expect(WRAPPER).toContain("maxStockLadderRunsPerBeat()");
    expect(WRAPPER).toContain("stockLadderStandAsides");
  });

  it("the first run is untouched — the bound refuses repeats, not the ladder", () => {
    const guard = WRAPPER.indexOf("runs >= maxStockLadderRunsPerBeat()");
    const proceed = WRAPPER.indexOf("withBeatProvenance");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(proceed);
    expect(WRAPPER).toContain("stockLadderRunsByBeat.set(beatKey, runs + 1)");
  });

  it("every stand-aside is named in the log, never silent", () => {
    expect(WRAPPER).toContain("[StockLadder]");
    expect(WRAPPER).toContain("standing aside");
  });
});

describe("4. a query already asked for a beat is not asked again", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const INNER = SRC.slice(
    SRC.indexOf("async function adoptStockBeatClipFallbackInner("),
    SRC.indexOf("async function adoptEmergencyGeoStockClip(")
  );

  it("the skip is keyed on the beat AND the query, not on the query alone", () => {
    expect(INNER).toContain("const askKey = `${scene.index}:${beat.index}:${q}`");
    expect(INNER).toContain("dedup.stockQueriesAsked.has(askKey)");
  });

  /**
   * The gate's verdict depends on the beat's own terms, so the same word can honestly be refused
   * under one sentence and allowed under the next. A render-wide key would suppress an ask that
   * was never made.
   */
  it("a different beat may still ask the same word", () => {
    const key = (s: number, b: number, q: string) => `${s}:${b}:${q}`;
    const asked = new Set([key(2, 1, "spacex")]);
    expect(asked.has(key(2, 1, "spacex"))).toBe(true);
    expect(asked.has(key(2, 2, "spacex"))).toBe(false);
    expect(asked.has(key(0, 1, "spacex"))).toBe(false);
  });

  it("the skip is counted, so it cannot hide how much it removed", () => {
    expect(INNER).toContain("stockQueryRepeatsSkipped += 1");
  });

  it("the ask is remembered before the providers are called, not after", () => {
    const remember = INNER.indexOf("dedup.stockQueriesAsked.add(askKey)");
    const pexels = INNER.indexOf("fetchPexelsClips(");
    expect(remember).toBeGreaterThan(0);
    expect(remember).toBeLessThan(pexels);
  });
});

describe("5. what this round does NOT do", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  /** No provider is switched off and no gate is relaxed — only repetition is removed. */
  it("Pexels and Pixabay are still called", () => {
    expect(SRC).toContain("fetchPexelsClips(");
    expect(SRC).toContain("fetchPixabayClips(");
  });

  it("the search gate is untouched — a BLOCKED query is still BLOCKED", () => {
    expect(SRC).not.toMatch(/SEARCH_GATE_STRICT\s*=\s*false/);
  });

  /** The per-render state is per-render: two concurrent renders cannot see each other's beats. */
  it("the memo lives on the render's own dedup state", () => {
    expect(SRC).toContain("stockLadderRunsByBeat: new Map()");
    expect(SRC).toContain("stockQueriesAsked: new Set()");
  });
});
