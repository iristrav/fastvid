/**
 * RONDE 137 — two numbers that lied, and cost a round of investigation each.
 *
 * ── 1. The phase budget counted the same minutes twice ───────────────────────────────────────
 *
 * Video 558:
 *
 *     ✓ retrieval  actual=16m 32s / budget=1m 36s   OVER +14m 56s
 *     ✓ compose    actual=16m 15s / budget=4m 24s   OVER +11m 51s
 *
 * Compose read as the bottleneck, and a whole round was planned around finding double encodes in
 * it. There are none. The three scenes took 22.2s, 26.7s and 8.2s of ffmpeg — 57 seconds in total.
 *
 * The 16m15 is wall-clock, and compose runs INTERLEAVED with retrieval: stageStart("compose") sits
 * inside the chunk loop while stageEnd is after it, so both stages were open across the same window
 * and both measured all of it. Both ended on the same second in the log, which is what gave it
 * away. The same sixteen minutes, counted twice, and both blamed.
 *
 * `exclusive=` is the part of a stage's window during which no earlier stage was still open. It
 * does not replace the wall-clock figure — the budget is still compared against that — it separates
 * "this stage is slow" from "this stage is waiting".
 *
 * ── 2. "AI fallback: on" was printed with no provider behind it ──────────────────────────────
 *
 * The fallback ladder's own comment promises "AI clip when stock/YouTube miss — never grey", and
 * video 558 shipped seven colour cards with nothing in the log to explain it. The reason:
 *
 *     if (!perf.enableAiFallback && !cheapAiImageProvidersReady())  → "empty beats stay empty"
 *     else if (perf.enableAiFallback)                               → "AI fallback: cheap tier"
 *
 * Two independent facts joined with `&&`. With the feature ENABLED and no API key the first branch
 * is false, so the render announced "cheap image tier (Stability Core → Leonardo)" while holding
 * neither key. The one state that most needed saying was the one that printed the reassuring line —
 * and the remedy is a key, not a code change, so nobody could act on it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BudgetTracker } from "./renderBudgetTracker";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

function trackerAt(nowMs: number) {
  vi.setSystemTime(nowMs);
  // The budget shape the tracker needs; only totalMs is read by stageStart/stageEnd.
  return new BudgetTracker({ totalMs: 22 * 60_000 } as never, 558);
}

/* ═══════════════════════ 1. overlapping phases ═══════════════════════ */

describe("RONDE 137 — a stage that overlaps another says how much was its own", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("THE BUG, reproduced: video 558's two stages measured the same window", () => {
    /**
     * The real shape: retrieval opens, compose opens inside it, both close together. Before this
     * round both reported ~16 minutes and there was no way to tell which one was actually working.
     */
    const t0 = 1_700_000_000_000;
    const tracker = trackerAt(t0);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      tracker.stageStart("retrieval", 96_000); // 1m36s budget, as in 558
      vi.setSystemTime(t0 + 60_000); // a minute of retrieval alone
      tracker.stageStart("compose", 264_000); // 4m24s budget
      vi.setSystemTime(t0 + 16 * 60_000 + 32_000); // both run on to the same end
      tracker.stageEnd("retrieval");
      tracker.stageEnd("compose");
    } finally {
      log.mockRestore();
    }

    const retrieval = lines.find((l) => l.includes("✓ retrieval"))!;
    const compose = lines.find((l) => l.includes("✓ compose"))!;

    // The wall-clock numbers are unchanged — they were never wrong, only incomplete.
    expect(retrieval).toContain("actual=16m 32s");
    expect(compose).toContain("actual=15m 32s");

    // Retrieval started first, so the shared window is attributed to it and it reports no overlap.
    expect(retrieval).not.toContain("exclusive=");
    // Compose ran entirely inside retrieval's window: none of its time was its own.
    expect(compose).toContain("exclusive=0s");
    expect(compose).toContain("overlapped 15m 32s with an earlier stage");
  });

  it("a stage that does NOT overlap reports no exclusive figure at all", () => {
    // Repeating the same number twice is noise, not information.
    const t0 = 1_700_000_000_000;
    const tracker = trackerAt(t0);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      tracker.stageStart("concat", 60_000);
      vi.setSystemTime(t0 + 18_000);
      tracker.stageEnd("concat");
    } finally {
      log.mockRestore();
    }
    const concat = lines.find((l) => l.includes("✓ concat"))!;
    expect(concat).toContain("actual=18s");
    expect(concat).not.toContain("exclusive=");
  });

  it("partial overlap is measured, not rounded to all-or-nothing", () => {
    /**
     * The case between the two above: a stage that starts inside another and outlives it. Only the
     * shared part is subtracted.
     */
    const t0 = 1_700_000_000_000;
    const tracker = trackerAt(t0);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      tracker.stageStart("retrieval", 60_000);
      vi.setSystemTime(t0 + 100_000);
      tracker.stageStart("compose", 60_000);
      vi.setSystemTime(t0 + 160_000);
      tracker.stageEnd("retrieval"); // retrieval closes first
      vi.setSystemTime(t0 + 220_000); // compose runs on alone for another minute
      tracker.stageEnd("compose");
    } finally {
      log.mockRestore();
    }
    const compose = lines.find((l) => l.includes("✓ compose"))!;
    expect(compose).toContain("actual=2m 0s");
    expect(compose).toContain("exclusive=1m 0s");
  });

  it("the wall-clock number still drives the over/under verdict", () => {
    /**
     * `exclusive` is an explanation, never a decision. If it started deciding, a stage could sit
     * inside another for an hour and report itself on budget.
     */
    const t0 = 1_700_000_000_000;
    const tracker = trackerAt(t0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let result: { actualMs: number; budgetMs: number; overBudget: boolean };
    try {
      tracker.stageStart("retrieval", 600_000);
      vi.setSystemTime(t0 + 1_000);
      tracker.stageStart("compose", 60_000);
      vi.setSystemTime(t0 + 300_000);
      result = tracker.stageEnd("compose");
    } finally {
      log.mockRestore();
    }
    // Fully overlapped, so exclusive is ~0 — and it is still reported as over budget.
    expect(result.overBudget).toBe(true);
    expect(result.actualMs).toBeGreaterThan(result.budgetMs);
  });
});

/* ═══════════════════════ 2. the AI readiness line ═══════════════════════ */

describe("RONDE 137 — 'AI fallback: on' may not be printed without a provider", () => {
  it("THE BUG: the enabled-but-keyless state had no line of its own", () => {
    /**
     * Source-level, because the branch sits deep inside the render entrypoint. What is asserted is
     * the shape of the condition: the two facts must be tested independently, and the combination
     * that shipped video 558's colour cards must have its own branch.
     */
    const src = read("server/videoPipeline.ts");
    const idx = src.indexOf("const aiTierReady = cheapAiImageProvidersReady();");
    expect(idx, "the readiness check was not hoisted out of the conditions").toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1600);

    // The state that was silent before: enabled, no provider.
    expect(block).toContain("if (perf.enableAiFallback && !aiTierReady) {");
    expect(block).toContain("AI fallback is ENABLED but no image provider is configured");
    // ...and it names the remedy, because the remedy is a key rather than a code change.
    expect(block).toContain("STABILITY_AI_API_KEY");

    // The reassuring line is now unreachable without a provider.
    const reassuring = block.indexOf("AI fallback: cheap image tier");
    expect(reassuring).toBeGreaterThan(0);
    const guard = block.slice(0, reassuring);
    expect(guard).toContain("} else if (perf.enableAiFallback) {");
    expect(
      guard.indexOf("if (perf.enableAiFallback && !aiTierReady)"),
      "the keyless branch must be tested BEFORE the reassuring one"
    ).toBeLessThan(reassuring);
  });

  it("the pre-existing no-keys-and-disabled warning is still there", () => {
    // Not replaced — that state is different and still worth its own line.
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("if (!perf.enableAiFallback && !aiTierReady) {");
    expect(src).toContain("No cheap AI keys — empty beats stay empty");
  });

  it("the ladder's own promise is what this line is measured against", () => {
    // "never grey" is only keepable with a provider; the log has to say when there is none.
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("AI clip when stock/YouTube miss — never grey");
  });
});
