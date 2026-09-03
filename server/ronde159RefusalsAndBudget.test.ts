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

  it("and that verdict is one a different search can act on", () => {
    for (const prose of VIDEO_552_REFUSALS) {
      const kind = classifyMismatch({ reason: prose });
      // QUESTION fault → the beat tries a different search rather than falling through to a card.
      expect(mismatchFault(kind)).toBe("QUESTION");
      expect(mismatchWasPreventableBySearch(kind)).toBe(true);
    }
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

describe("RONDE 159 §A — the log shows the verdict, not just the description", () => {
  const long = (word: string, n: number) => Array(n).fill(word).join(" ");

  it("the reason and the description get their own windows", () => {
    const out = formatMismatchFeedback({
      sceneIndex: 1,
      beatIndex: 2,
      source: "archive",
      kind: "UNCLEAR",
      reordered: false,
      remaining: 0,
      depicts: long("picture", 60),
      reason: "and the verdict is right here at the end",
    });
    expect(out).toContain("unclassified reason:");
    expect(out).toContain("the verdict is right here at the end");
    expect(out).toContain("unclassified prose:");
  });

  it("a long description can no longer crowd the verdict out", () => {
    /**
     * The defect this replaces: one 160-character window shared between the two, description
     * first. Video 552's lines ended "…which do" and "…likely during the WWII perio" — cut off
     * exactly where the classifying words are.
     */
    const out = formatMismatchFeedback({
      sceneIndex: 2,
      beatIndex: 3,
      source: "archive",
      kind: "UNCLEAR",
      reordered: false,
      remaining: 0,
      depicts: long("a long description of the picture", 40),
      reason: "it shows a wedding, which does not belong here",
    });
    expect(out).toContain("does not belong here");
  });

  it("both are still bounded, so one answer cannot flood the log", () => {
    const out = formatMismatchFeedback({
      sceneIndex: 0,
      beatIndex: 0,
      source: "archive",
      kind: "UNCLEAR",
      reordered: false,
      remaining: 0,
      depicts: long("x", 500),
      reason: long("y", 500),
    });
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(400);
  });

  it("an empty answer is still reported as empty", () => {
    const out = formatMismatchFeedback({
      sceneIndex: 0,
      beatIndex: 0,
      source: "archive",
      kind: "UNCLEAR",
      reordered: false,
      remaining: 0,
    });
    expect(out).toContain("the gate returned no prose to classify");
  });

  it("a classified refusal still logs one line and no prose", () => {
    const out = formatMismatchFeedback({
      sceneIndex: 0,
      beatIndex: 0,
      source: "archive",
      kind: "UNRELATED",
      reordered: true,
      remaining: 2,
      depicts: "something",
      reason: "does not relate",
    });
    expect(out.split("\n")).toHaveLength(1);
    expect(out).not.toContain("unclassified");
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
describe("RONDE 159 §C — a starved scene may fetch, a thin one may not", () => {
  const starved = {
    videoLength: "1",
    clipsOnDisk: 2,
    clipsNeeded: 7,
    remainingWallClockMs: 11 * 60_000,
  };

  it("video 552's scene 2 would now be allowed to go and get its footage", async () => {
    const { composeMayFetchForStarvedScene } = await import("./sourcingPolicy");
    expect(composeMayFetchForStarvedScene(starved)).toBe(true);
  });

  it("a scene that is merely thinner than planned stays blocked", async () => {
    const { composeMayFetchForStarvedScene } = await import("./sourcingPolicy");
    // 4 of 7 is thin, not starved: the montage can still be built from what is here.
    expect(composeMayFetchForStarvedScene({ ...starved, clipsOnDisk: 4 })).toBe(false);
  });

  it("no headroom, no exemption — the deadline still wins", async () => {
    const { composeMayFetchForStarvedScene, SOURCING_RESERVE_MS } = await import("./sourcingPolicy");
    expect(
      composeMayFetchForStarvedScene({ ...starved, remainingWallClockMs: SOURCING_RESERVE_MS })
    ).toBe(false);
    expect(composeMayFetchForStarvedScene({ ...starved, remainingWallClockMs: null })).toBe(false);
  });

  it("longer videos were never blocked, so nothing changes for them", async () => {
    const { composeMayFetchForStarvedScene } = await import("./sourcingPolicy");
    expect(composeMayFetchForStarvedScene({ ...starved, videoLength: "8-10" })).toBe(true);
  });

  it("an operator who forces local-only keeps it", async () => {
    const { composeMayFetchForStarvedScene } = await import("./sourcingPolicy");
    const prev = process.env.COMPOSE_LOCAL_CLIPS_ONLY;
    try {
      process.env.COMPOSE_LOCAL_CLIPS_ONLY = "true";
      expect(composeMayFetchForStarvedScene(starved)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COMPOSE_LOCAL_CLIPS_ONLY;
      else process.env.COMPOSE_LOCAL_CLIPS_ONLY = prev;
    }
  });

  it("the exemption is per scene, and a caller that names no scene never gets it", async () => {
    const { isComposeNetworkBlocked } = await import("./pipelineStepTiming");
    const dedup = {
      composeNetworkBlocked: true,
      videoLength: "1",
      composeFetchExemptScenes: new Set([2]),
    };
    expect(isComposeNetworkBlocked(dedup, 2)).toBe(false);
    expect(isComposeNetworkBlocked(dedup, 1)).toBe(true);
    // A render-wide decision must not inherit one scene's exemption.
    expect(isComposeNetworkBlocked(dedup)).toBe(true);
  });
});

/**
 * RONDE 159 §D — footage that was chosen and then evaporated.
 *
 * Video 552's lineage audit reported twelve VANISHED_WITHOUT_OUTCOME warnings, and the funnel
 * check reported three inconsistencies on a render that was fine.
 */
describe("RONDE 159 §D — a dropped clip says what became of it", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("both drop branches in the compose filter file an ending", () => {
    const idx = PIPE.indexOf("async function composeReadySceneClips(");
    const body = PIPE.slice(idx, idx + 1800);
    expect(body).toContain('dropped(clipPath, `compose_gate:s${sceneIndex}`);');
    expect(body).toContain('dropped(clipPath, `duplicate_content:s${sceneIndex}`);');
    expect(body).toContain('lineage?.recordEventForPath(clipPath, "REMOVED"');
  });

  it("every caller hands it the ledger, or the recording cannot happen", () => {
    const calls = PIPE.match(/composeReadySceneClips\([^)]*\)/g) ?? [];
    // The definition plus three call sites.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      if (call.startsWith("composeReadySceneClips(clips: string[]")) continue;
      expect(call, call).toContain("lineage");
    }
  });

  it("a placeholder that is not used gets a reason like every other drop", () => {
    /**
     * CORRECTED BY RONDE 162, on production evidence.
     *
     * This round asserted the opposite — that a placeholder has no lineage record to settle, so
     * skipping it silently was right. Render 553 disproved it: six `_guaranteed.mp4` clips hold
     * ADOPTED events and were reported VANISHED_WITHOUT_OUTCOME for exactly this branch's silence.
     * A card that was made and then not used is an outcome like any other, and the rule this file
     * exists for — every drop names its reason — never had an exception.
     */
    const idx = PIPE.indexOf("async function composeReadySceneClips(");
    const body = PIPE.slice(idx, idx + 2400);
    expect(body).toContain("`placeholder_not_used:s${sceneIndex}`");
    expect(body).not.toContain("A placeholder is not an asset");
  });
});

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

  it("an optional stage that exceeds what was validated still reports", async () => {
    const { formatUsageInconsistencies } = await import("./visualSourceLineage");
    const out = formatUsageInconsistencies(
      summaryOf({
        results: 10,
        eligible: 2,
        selected: 7,
        downloadSucceeded: 1,
        adopted: 2,
        finalVideo: 1,
      }),
      true
    );
    expect(out.some((l) => l.includes("selected=7 exceeds validated=2"))).toBe(true);
  });
});
