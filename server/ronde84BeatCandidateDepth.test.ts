import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_PREPARE_ATTEMPTS_MAX,
  archivePrepareAttemptsPerBeat,
} from "./videoPipeline";
import {
  isFastShortVideoLength,
  maxVisualCandidatesPerBeatTry,
  strictVoiceVisualMatchEnabled,
} from "./sourcingPolicy";

/**
 * RONDE 84 — a beat has to have something to choose between.
 *
 * Render 536 (18 scenes, 8-10 bucket, 168 minutes) finished with 13 of its 18 scenes carrying a
 * montage too short for their own duration, 594 "source video too short" rejections, and — the
 * measurement that pointed here — NOT ONE [VisualSelection] line in the entire render. That line
 * is only printed when a beat has more than one candidate to compare. No beat ever did.
 *
 * The cause was not the search. The scan builds a queue of candidates that have already passed
 * the beat minimum, the score floor and the geo/literal gates: on a long video that is
 * min(archiveBeatTopCandidates, maxVisualCandidatesPerBeatTry) = 8 of them. archivePrepareAttempts-
 * PerBeat then decided how many of those get downloaded and trimmed, and every branch answered 2:
 *
 *     if (relaxed) return 2;
 *     if (fastMode && strictVoiceVisualMatchEnabled()) return 2;
 *     return fastMode ? 2 : 2;        <- both arms of the ternary are the same number
 *
 * Six vetted candidates thrown away per beat, and if both of the two that were kept failed, the
 * beat came back empty. That is where the missing footage went.
 *
 * The wave loop that consumes this cap returns as soon as one candidate succeeds, so the raised
 * cap costs nothing on a beat whose first candidate works — it only spends time where the beat
 * would otherwise have produced nothing.
 */

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** tryCap, reproduced exactly as the scan computes it (non-relaxed) — videoPipeline.ts. */
const ARCHIVE_BEAT_TOP_CANDIDATES = 24;
function tryCapFor(videoLength: string): number {
  const fast = isFastShortVideoLength(videoLength);
  return Math.min(fast ? 5 : ARCHIVE_BEAT_TOP_CANDIDATES, maxVisualCandidatesPerBeatTry(videoLength));
}

/* ═════════════ §A — the long path prepares more than two ═════════════ */

describe("RONDE 84 §A — a long video's beat gets a real pool", () => {
  for (const len of ["8-10", "10-15", "15-20"] as const) {
    it(`${len} prepares more than the two it prepared before`, () => {
      const cap = archivePrepareAttemptsPerBeat(false, false, tryCapFor(len));
      expect(cap, `${len} still prepares only ${cap}`).toBeGreaterThan(2);
    });
  }

  it("it prepares as many as the scan vetted, up to the ceiling", () => {
    // The point is that the two numbers stop disagreeing: what the scan vetted is what gets
    // prepared, bounded so a widened scan cap can never fan out unbounded.
    for (const len of ["8-10", "10-15", "15-20"] as const) {
      const tryCap = tryCapFor(len);
      expect(archivePrepareAttemptsPerBeat(false, false, tryCap))
        .toBe(Math.min(tryCap, ARCHIVE_PREPARE_ATTEMPTS_MAX));
    }
  });

  it("a smaller scan cap lowers the prepare cap with it — never the other way round", () => {
    expect(archivePrepareAttemptsPerBeat(false, false, 3)).toBe(3);
    expect(archivePrepareAttemptsPerBeat(false, false, 4)).toBe(4);
    // And it is bounded above regardless of how wide the scan gets.
    expect(archivePrepareAttemptsPerBeat(false, false, 50)).toBe(ARCHIVE_PREPARE_ATTEMPTS_MAX);
    expect(archivePrepareAttemptsPerBeat(false, false, 500)).toBe(ARCHIVE_PREPARE_ATTEMPTS_MAX);
  });

  it("never below two, even if the scan vetted fewer", () => {
    // Two attempts is the floor the pipeline has always had; a narrow scan must not take it away.
    expect(archivePrepareAttemptsPerBeat(false, false, 0)).toBe(2);
    expect(archivePrepareAttemptsPerBeat(false, false, 1)).toBe(2);
    expect(archivePrepareAttemptsPerBeat(false, false, -5)).toBe(2);
  });
});

/* ═════════════ §B — nothing else moved ═════════════ */

describe("RONDE 84 §B — the paths this round is not about are unchanged", () => {
  it("the 1-minute path still prepares exactly two", () => {
    // It has the tight wall-clock budget; widening its per-beat work is a different decision.
    expect(archivePrepareAttemptsPerBeat(true, false, tryCapFor("1"))).toBe(2);
    expect(archivePrepareAttemptsPerBeat(true, false, 8)).toBe(2);
    expect(archivePrepareAttemptsPerBeat(true, false, 50)).toBe(2);
  });

  it("the 1-minute path holds at two with strict voice/visual matching OFF as well", () => {
    // Without this the fastMode guard is invisible to the suite: the branch above it
    // (fastMode && strictVoiceVisualMatchEnabled()) already returns 2 whenever the strict flag
    // is on, which it is by default — so deleting the fastMode guard would pass unnoticed on a
    // deployment that has STRICT_VOICE_VISUAL_MATCH=false.
    const previous = process.env.STRICT_VOICE_VISUAL_MATCH;
    process.env.STRICT_VOICE_VISUAL_MATCH = "false";
    try {
      expect(strictVoiceVisualMatchEnabled()).toBe(false);
      expect(archivePrepareAttemptsPerBeat(true, false, 8)).toBe(2);
      expect(archivePrepareAttemptsPerBeat(true, false, 50)).toBe(2);
      // And the long path is unaffected by that flag — it still gets its pool.
      expect(archivePrepareAttemptsPerBeat(false, false, 8)).toBeGreaterThan(2);
    } finally {
      if (previous === undefined) delete process.env.STRICT_VOICE_VISUAL_MATCH;
      else process.env.STRICT_VOICE_VISUAL_MATCH = previous;
    }
  });

  it("the relaxed retry still prepares exactly two, at every length", () => {
    // `relaxed` is already the widening pass and runs at concurrency 1.
    for (const cap of [0, 2, 6, 8, 50]) {
      expect(archivePrepareAttemptsPerBeat(false, true, cap)).toBe(2);
      expect(archivePrepareAttemptsPerBeat(true, true, cap)).toBe(2);
    }
  });

  it("MUTATION GUARD — the ternary whose arms were identical is gone", () => {
    expect(PIPELINE_SRC).not.toContain("return fastMode ? 2 : 2;");
    expect(PIPELINE_SRC).toContain("Math.max(2, Math.min(tryCap, ARCHIVE_PREPARE_ATTEMPTS_MAX))");
  });

  it("the cap the scan computes is the one handed over — not a second constant", () => {
    expect(PIPELINE_SRC).toContain(
      "archivePrepareAttemptsPerBeat(dedup.perf.fastStockMode, relaxed, tryCap)"
    );
  });
});

/* ═════════════ §C — more work, not more work at once ═════════════ */

describe("RONDE 84 §C — concurrency is untouched", () => {
  it("prepare concurrency is unchanged", () => {
    // RONDE 82/83's invariant: a longer video may take longer, it may not consume more at once.
    // The extra candidates are prepared in the SAME two-wide waves, just more waves of them.
    const start = PIPELINE_SRC.indexOf("function archivePrepareConcurrency(");
    expect(start).toBeGreaterThan(-1);
    const body = PIPELINE_SRC.slice(start, PIPELINE_SRC.indexOf("\n}", start));
    expect(body).toContain("if (relaxed) return 1;");
    expect(body).toContain("return fastMode ? 3 : 2;");
  });

  it("the wave loop still stops at the first success", () => {
    // This is what makes the raised cap free on a healthy beat: the extra attempts only happen
    // when the earlier ones failed.
    expect(PIPELINE_SRC).toContain("if (results.some(Boolean)) return true;");
  });

  it("the wave arithmetic covers the whole cap in two-wide waves", () => {
    // Reproduces the loop at the consuming call site for the new cap, so a future change to
    // either number cannot silently prepare fewer than the cap allows.
    const prepConcurrency = 2;
    const prepareCap = archivePrepareAttemptsPerBeat(false, false, tryCapFor("8-10"));
    const queueLength = tryCapFor("8-10");
    let prepared = 0;
    let waves = 0;
    for (let i = 0; i < queueLength && prepared < prepareCap; i += prepConcurrency) {
      const waveSize = Math.min(prepConcurrency, prepareCap - prepared, queueLength - i);
      prepared += waveSize;
      waves += 1;
      expect(waveSize, "a wave must never exceed the concurrency limit").toBeLessThanOrEqual(prepConcurrency);
    }
    expect(prepared).toBe(prepareCap);
    expect(waves).toBe(Math.ceil(prepareCap / prepConcurrency));
  });
});

/* ═════════════ §D — the shape of the fix ═════════════ */

describe("RONDE 84 §D — the scan and the prepare step agree", () => {
  it("prepare never exceeds what the scan vetted", () => {
    // The defect was the two disagreeing silently. Whatever the scan produces, the prepare step
    // asks for at most that many — the queue can never be shorter than the cap wants.
    for (const tryCap of [2, 3, 4, 5, 6, 8, 12, 24]) {
      const cap = archivePrepareAttemptsPerBeat(false, false, tryCap);
      expect(cap, `tryCap=${tryCap}`).toBeLessThanOrEqual(Math.max(2, tryCap));
    }
  });

  it("the ceiling is a named constant, not a magic number in the branch", () => {
    expect(ARCHIVE_PREPARE_ATTEMPTS_MAX).toBe(6);
    expect(PIPELINE_SRC).toContain("export const ARCHIVE_PREPARE_ATTEMPTS_MAX = 6;");
  });
});
