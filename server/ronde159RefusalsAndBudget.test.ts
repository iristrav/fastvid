/**
 * RONDE 159 §A — the refusals the classifier could not read, read off two production renders.
 *
 * ── The measurement ──────────────────────────────────────────────────────────────────────────
 *
 *     video 551   10 refusals,  7 unclassified
 *     video 552   13 refusals,  8 unclassified
 *
 * An unclassified refusal has no fault, so no strategy, so no fresh search — the beat falls
 * through to a coloured placeholder card. Eight of thirteen is most of a render's chances.
 *
 * RONDE 155 started logging the prose instead of guessing at it. This is that log, read:
 *
 *     "The clip shows a wedding ceremony, which does not relate to the narrative…"
 *     "The images depict children greeting a woman, which does not relate…"
 *
 * The UNRELATED pattern carried `not related` — the adjective. The gate writes `does not relate` —
 * the verb. That single missing form is why those beats got a card instead of another search.
 *
 * ── What is deliberately NOT done ────────────────────────────────────────────────────────────
 *
 * Only the phrasings the logs actually contain, plus their immediate variations, are added. A
 * guessed pattern that fires wrongly reorders candidates away from a source for a reason nobody
 * gave, and UNCLEAR already exists for the honest case of "the chain does not understand this".
 *
 * Three of the five logged refusals were cut off mid-verdict by a 160-character window shared
 * between the picture description and the verdict. The two fields are printed separately now, so
 * the next round reads whole findings rather than preambles.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-minute length no longer takes the fast-short path by default — see
 * `isFastShortVideoLength`. That tuning still EXISTS and is what this file asserts, so the flag is
 * set here rather than the expectations being loosened: the behaviour is unchanged, only its
 * default is.
 */
beforeEach(() => { vi.stubEnv("FAST_SHORT_PATH", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

import {
  classifyMismatch,
  formatMismatchFeedback,
  mismatchFault,
  mismatchWasPreventableBySearch,
} from "./visualMismatchFeedback";

/**
 * Verbatim from the production logs of video 552, `unclassified prose` lines.
 *
 * Kept as data rather than paraphrased: the point of this round is that the real wording differs
 * from the wording anyone would have invented, and a paraphrase would quietly restore the
 * invented version.
 */
const VIDEO_552_REFUSALS = [
  "A historical wedding ceremony with military personnel, likely early to mid 20th century. " +
    "The clip shows a wedding ceremony, which does not relate to the narrative about Hitler's rise.",
  "A group of children greeting a woman with flowers on the steps of a building, mid-20th century. " +
    "The images depict children greeting a woman, which does not relate to the narration.",
] as const;

describe("RONDE 159 §A — the gate's real wording is now understood", () => {
  it.each(VIDEO_552_REFUSALS)("classifies a real refusal instead of shrugging: %s", (prose) => {
    const kind = classifyMismatch({ reason: prose });
    expect(kind).not.toBe("UNCLEAR");
    expect(kind).toBe("UNRELATED");
  });


  it("the adjective form still works — nothing was traded away", () => {
    expect(classifyMismatch({ reason: "This footage is not related to the topic." })).toBe("UNRELATED");
    expect(classifyMismatch({ reason: "Completely unrelated imagery." })).toBe("UNRELATED");
    expect(classifyMismatch({ reason: "It has no connection to the narration." })).toBe("UNRELATED");
  });

  it("the other verb forms the gate reaches for", () => {
    for (const reason of [
      "The clip does not correspond to what is being described.",
      "This does not match the narration at all.",
      "The picture does not align with the script.",
      "It is not relevant to this beat.",
      "The footage bears no relation to the events described.",
    ]) {
      expect(classifyMismatch({ reason }), reason).toBe("UNRELATED");
    }
  });

  it("a subject refusal without an article after the verb is read too", () => {
    // The old pattern required "the" or "any" right after "does not depict".
    expect(classifyMismatch({ reason: "It does not depict what the narration describes." })).toBe(
      "WRONG_SUBJECT"
    );
  });
});

describe("RONDE 159 §A — the specific kinds still win over the general one", () => {
  /**
   * UNRELATED is last in the list on purpose: it is the catch-all. A refusal that names a period
   * or a place must keep that more useful answer, because the strategy differs — a period error
   * sends the search to a historical collection, an unrelated one sends it to a different query.
   */
  it("a period error stays a period error even when it also says 'does not relate'", () => {
    expect(
      classifyMismatch({
        reason: "This is present-day footage and does not relate to the 1930s narration.",
      })
    ).toBe("MODERN_FOOTAGE");
  });

  it("a place error stays a place error", () => {
    expect(
      classifyMismatch({ reason: "A different country entirely; it does not relate to Munich." })
    ).toBe("WRONG_PLACE");
  });

  it("a title card stays a title card", () => {
    expect(
      classifyMismatch({ reason: "A title card with white lettering; does not relate to anything." })
    ).toBe("TITLE_CARD");
  });

  it("nothing it genuinely cannot read is forced into a kind", () => {
    expect(classifyMismatch({ reason: "Hmm." })).toBe("UNCLEAR");
    expect(classifyMismatch({})).toBe("UNCLEAR");
  });
});


/**
 * RONDE 159 §B — the render throws footage away for want of time it is not using.
 *
 * Video 552, from its own log:
 *
 *     Scene 1 beat 2: archive beat budget exceeded — exceeded 18s
 *     Scene 2 beat 0: archive beat budget exceeded — exceeded 18s
 *     Scene 1 beat 4: archive beat budget exceeded — exceeded 18s
 *     BudgetSummary   estimated=22m 0s  actual=10m 19s  used=47%
 *
 * Three beats abandoned on a clock, by a render that finished in under half its budget with
 * 11m 41s unspent. The beats it gave up on are the ones that ended as coloured cards.
 */
describe("RONDE 159 §B — the beat budget spends headroom that exists", () => {
  it("a render with no headroom gets exactly the old number", async () => {
    const { archiveBeatBudgetMs, archiveBeatTryTimeoutMs, SOURCING_RESERVE_MS } = await import(
      "./sourcingPolicy"
    );
    const base = archiveBeatTryTimeoutMs("1");
    expect(archiveBeatBudgetMs("1", SOURCING_RESERVE_MS)).toBe(base);
    expect(archiveBeatBudgetMs("1", 0)).toBe(base);
    // Nothing known about the clock is not a licence to spend it.
    expect(archiveBeatBudgetMs("1", null)).toBe(base);
    expect(archiveBeatBudgetMs("1", undefined)).toBe(base);
    expect(archiveBeatBudgetMs("1", NaN)).toBe(base);
  });

  it("video 552's actual clock would have bought those beats more time", async () => {
    const { archiveBeatBudgetMs, archiveBeatTryTimeoutMs } = await import("./sourcingPolicy");
    const base = archiveBeatTryTimeoutMs("1");
    // Roughly where the render stood when beats were being abandoned.
    const budget = archiveBeatBudgetMs("1", 15 * 60_000);
    expect(budget).toBeGreaterThan(base);
  });

  it("it is capped, so a generous clock cannot become an overrun", async () => {
    const { archiveBeatBudgetMs, archiveBeatTryTimeoutMs } = await import("./sourcingPolicy");
    const base = archiveBeatTryTimeoutMs("1");
    // An absurd amount of remaining time still buys a bounded amount of beat.
    expect(archiveBeatBudgetMs("1", 10 * 60 * 60_000)).toBeLessThanOrEqual(base * 3);
  });

  it("the extra time comes out of headroom only, never out of the reserve", async () => {
    const { archiveBeatBudgetMs, archiveBeatTryTimeoutMs, SOURCING_RESERVE_MS } = await import(
      "./sourcingPolicy"
    );
    const base = archiveBeatTryTimeoutMs("1");
    for (const remaining of [6 * 60_000, 12 * 60_000, 20 * 60_000]) {
      const per = archiveBeatBudgetMs("1", remaining);
      if (per <= base) continue; // no extension granted; nothing to bound
      /**
       * The rule the share is computed against: if twenty more beats each took this budget, the
       * total still fits inside the headroom, leaving the reserve for compose, music and upload.
       */
      expect(per * 20, `remaining ${remaining}`).toBeLessThanOrEqual(remaining - SOURCING_RESERVE_MS);
    }
  });

  it("an explicit override is an instruction, not a starting point", async () => {
    const { archiveBeatBudgetMs } = await import("./sourcingPolicy");
    const prev = process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS;
    try {
      process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS = "9000";
      expect(archiveBeatBudgetMs("1", 30 * 60_000)).toBe(9_000);
    } finally {
      if (prev === undefined) delete process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS;
      else process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS = prev;
    }
  });
});

/**
 * RONDE 159 §C — the scene that had two clips for twenty-one seconds of narration.
 *
 *     Scene 2: 2/7 compose-ready clips — pre-compose cache fill
 *     Scene 2: compose local-only — blocked visual rescue   (13 blocks in that render)
 *     12 assets VANISHED_WITHOUT_OUTCOME
 *
 * The footage existed. The render refused to fetch it while holding eleven unused minutes.
 */

describe("RONDE 159 §D — the funnel check no longer cries wolf", () => {
  const summaryOf = (counts: Record<string, number>) =>
    ({
      byProvider: { archive: counts },
      total: counts,
    }) as unknown as Parameters<typeof import("./visualSourceLineage").formatUsageInconsistencies>[0];

  it("video 552's real numbers no longer report a fault", async () => {
    const { formatUsageInconsistencies } = await import("./visualSourceLineage");
    /**
     * The curated route prepares a clip from the archive store and adopts it without downloading,
     * and the rescue route adopts without SELECTED — which this file's own lineage audit already
     * says is legitimate. The funnel check contradicted it on every render.
     */
    const out = formatUsageInconsistencies(
      summaryOf({
        results: 69,
        eligible: 40,
        selected: 4,
        downloadSucceeded: 11,
        adopted: 32,
        finalVideo: 5,
      }),
      true
    );
    expect(out).toEqual([]);
  });

  it("a genuine miscount still reports", async () => {
    const { formatUsageInconsistencies } = await import("./visualSourceLineage");
    // More rendered than were ever assigned: that cannot happen without a bad count.
    const out = formatUsageInconsistencies(
      summaryOf({
        results: 10,
        eligible: 8,
        selected: 4,
        downloadSucceeded: 4,
        adopted: 3,
        finalVideo: 5,
      }),
      true
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toContain("rendered=5 exceeds assigned=3");
  });

  it("a stage that exceeds what was validated still reports", async () => {
    /**
     * RONDE 198 — `selected` LEFT THIS SET, AND FOR THIS FILE'S OWN REASON.
     *
     * This round's argument is R159's: a check that contradicts the code fires on every healthy
     * render, and that is how a real finding gets ignored. `preparePooledArchiveClip` writes
     * SELECTED before any gate runs, and two of its three call sites never mark eligibility at
     * all — so `selected > eligible` is a normal curated render, exactly as `downloaded >
     * selected` was in R159 and `downloaded > validated` in R142.
     *
     * The fixture keeps its shape and moves the widening to `adopted`, which the ledger really
     * does order after eligibility: adoptClip writes both, one after the other. The per-asset
     * version of the question this pair used to ask now lives in `reconcile`
     * (ADOPTED_WITHOUT_ELIGIBLE), where the route is named instead of being averaged into a total.
     */
    const { formatUsageInconsistencies } = await import("./visualSourceLineage");
    const out = formatUsageInconsistencies(
      summaryOf({
        results: 10,
        eligible: 2,
        selected: 7,
        downloadSucceeded: 1,
        adopted: 7,
        finalVideo: 1,
      }),
      true
    );
    expect(out.some((l) => l.includes("assigned=7 exceeds validated=2"))).toBe(true);
    expect(out.some((l) => l.includes("selected=7 exceeds validated=2"))).toBe(false);
  });
});
