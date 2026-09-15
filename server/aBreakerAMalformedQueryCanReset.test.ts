/**
 * RONDE 251 — THE BREAKER A MALFORMED QUERY COULD RESET.
 *
 * GDELT has had a breaker since RONDE 19: three consecutive search failures park it for three
 * minutes rather than re-paying 22 seconds a query on every beat. Render 584 spent roughly eighty
 * seconds on GDELT inside one eight-minute window — measured from the log's own timestamps, where
 * the silences are 40.0s, 20.0s and 19.9s, the round numbers of a timeout rather than a transfer —
 * and the breaker fired zero times.
 *
 * The accounting was why. "Reachable" was recorded whenever the fetch returned WITHOUT THROWING,
 * which includes a non-ok status, an unparseable body, and GDELT's own "must contain at least one
 * station" refusal of a query we had malformed. Then `if (anyResponse) mark(true)` reset the streak
 * for the whole batch — so one fast refusal cancelled three 22-second timeouts standing beside it.
 *
 * These tests exist because that is a claim about a rule, and the rule now lives in a pure function
 * instead of beside a network call no test can reach.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { breakerVerdictForBatch, type ProviderBatchOutcome } from "./providerBreakerVerdict";

const batch = (o: Partial<ProviderBatchOutcome>): ProviderBatchOutcome => ({
  served: false,
  fault: false,
  refused: false,
  ...o,
});

describe("1. the reset that kept render 584 paying", () => {
  /** THE EXACT SHAPE. Three queries in their timeout, one fast refusal of a query we malformed. */
  it("a refusal beside real faults does not reset the streak", () => {
    expect(breakerVerdictForBatch(batch({ fault: true, refused: true }))).toBe("advance");
  });

  it("and a fault alone advances it", () => {
    expect(breakerVerdictForBatch(batch({ fault: true }))).toBe("advance");
  });
});

describe("2. what a refusal does and does not prove", () => {
  /**
   * Our query was unusable. That neither shows the endpoint healthy nor accuses it, so folding it
   * into either answer is wrong in a different direction: into "reset" it opens a breaker that
   * should be closing, into "advance" it parks a provider for a question we got wrong.
   */
  it("a batch of nothing but refusals leaves the streak where it was", () => {
    expect(breakerVerdictForBatch(batch({ refused: true }))).toBe("untouched");
  });

  it("and so does a batch that neither served, faulted nor was refused", () => {
    expect(breakerVerdictForBatch(batch({}))).toBe("untouched");
  });
});

describe("3. evidence that it works still outranks everything", () => {
  /** A provider that answered one real question is up, whatever else happened in the batch. */
  it("served beats fault", () => {
    expect(breakerVerdictForBatch(batch({ served: true, fault: true }))).toBe("reset");
  });

  it("served beats refused", () => {
    expect(breakerVerdictForBatch(batch({ served: true, refused: true }))).toBe("reset");
  });

  it("and served beats both at once", () => {
    expect(breakerVerdictForBatch(batch({ served: true, fault: true, refused: true }))).toBe("reset");
  });
});

describe("4. GDELT is wired to the rule rather than carrying its own copy", () => {
  const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the call site asks the shared function for its verdict", () => {
    expect(PIPE).toContain("breakerVerdictForBatch({");
    expect(PIPE, "the old any-response reset must be gone").not.toContain(
      "if (gdeltAnyResponse) markGdeltSearchResult(true)"
    );
  });

  /** The three facts have to be recorded separately or the rule has nothing to judge. */
  it("and records the three outcomes apart from one another", () => {
    for (const flag of ["gdeltServed", "gdeltFault", "gdeltRefusedOurQuery"]) {
      expect(PIPE, flag).toContain(`let ${flag} = false;`);
    }
    /** A refusal of our own query is classified as such, not as reachability. */
    expect(PIPE).toMatch(/must contain at least one station[\s\S]{0,200}gdeltRefusedOurQuery = true/);
    /** A status GDELT chose, and a 200 whose body is not JSON, are both its fault. */
    expect(PIPE).toContain("if (!resp.ok) { gdeltFault = true; return null; }");
  });

  /**
   * NOTHING HERE MOVES A THRESHOLD. The streak that trips the cooldown is the shared
   * VISUAL_PROVIDER_FAILURE_STREAK_TRIP and it is the number it was; what changed is that a
   * genuine failure is now counted at all.
   */
  it("without changing how many failures trip it", () => {
    expect(PIPE).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
    expect(PIPE).toContain("const GDELT_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;");
  });
});
