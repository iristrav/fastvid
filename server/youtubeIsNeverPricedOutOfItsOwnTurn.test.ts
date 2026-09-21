/**
 * YOUTUBE IS NEVER PRICED OUT OF ITS OWN TURN — RONDE 600.
 *
 * ── What render 596 printed, sixteen times, and what it meant ───────────────────────────────
 *
 *     [YouTube] TURN_DECLINED scene=0 reserved=9996ms reserveState=HELD —
 *       20s left and a turn costs 24s (one 12s search plus the 12s download floor).
 *       Nothing is searched … clock="b0_fastyt-first s0 b0" granted=20s used=0s
 *
 *     [YouTube] YOUTUBE_TURN_ENDED s0b0 … outcome=YOUTUBE_NO_RESULTS clip=none ms=1
 *
 * Every YouTube turn in that render was refused before a query went out, and every one of them
 * was then reported as "YouTube had no results". `used=0s` and `reserveState=HELD` say the clock
 * was fresh and the reserve was still there: no provider had taken YouTube's time. The beat it
 * ran inside was simply twenty seconds wide, and the same file prices a turn at twenty-four.
 *
 *     beatBudgetMs (fillOneBeat)     20_000   what a beat is given
 *     YOUTUBE_MIN_TURN_MS            24_000   what a turn costs
 *
 * Two constants, four thousand lines apart, in one file, that had never been compared. Not a key,
 * not a quota, not the licence flags, not the queries — six to eight good queries were built per
 * beat and none of them was ever sent.
 *
 * ── What this round changes, and what it deliberately does not ──────────────────────────────
 *
 * The beat wall GROWS BY a turn rather than being asked to contain one it cannot afford. Carving
 * the seconds out of the cascade would buy YouTube its turn with the archive's, which is the exact
 * trade RONDE 259's reserve exists to prevent — so the supplement is additive and the cascade
 * keeps, to the millisecond, the twenty seconds it has today.
 *
 * NO GATE, THRESHOLD OR FLOOR MOVES. `YOUTUBE_MIN_TURN_MS`, `YOUTUBE_SEARCH_TIMEOUT_MS`,
 * `YOUTUBE_MIN_DOWNLOAD_WINDOW_MS` and `TRANSFER_RESERVE_MS` are the numbers they were; the door
 * guard still charges the same price; the two landing tiers (`forceExportMode`,
 * `isPipelineEmergencyFinish`) keep 5s and 6s, because a render that has reached them has decided
 * to stop sourcing and should not be opening new provider turns.
 *
 * And nothing about YouTube's TREATMENT changes. This round is about seconds only: a clip still
 * faces the same relevance gate, the same person gate, the same vision judgement, the same image
 * gate, the same adoption path and the same archive-first invariant it faced before.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  withSceneFetchTimeout,
  remainingScopeMs,
  remainingNonYoutubeScopeMs,
  reserveYoutubeTurn,
  transferReserveFor,
  youtubeBeatFetchTimeoutMs,
  youtubeBeatWallSupplementMs,
  TRANSFER_RESERVE_MS,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_SEARCH_TIMEOUT_MS,
  YOUTUBE_TURN_WINDOW_MS,
} from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The two numbers render 596 actually ran with, kept as names so the arithmetic stays readable. */
const RENDER_596_BEAT_WALL_MS = 20_000;
const RENDER_596_TURN_PRICE_MS = 24_000;

/** A minimal scope shape — `reserveYoutubeTurn` reads one field and writes one. */
const scopeWithWindow = (windowMs: number) =>
  ({ deadlineAtMs: Date.now() + windowMs, youtubeReservedMs: 0 }) as unknown as Parameters<
    typeof reserveYoutubeTurn
  >[0];

/* ═══════════ §1 — the arithmetic that silenced sixteen turns ═══════════ */

describe("§1 — a window handed to a turn is never below what a turn needs", () => {
  it("THE DEFECT, STATED: render 596's beat wall could not pay the price its own file quotes", () => {
    /**
     * Not a reconstruction — these are the two numbers in the log line, and this is the comparison
     * nothing in the pipeline made.
     */
    expect(YOUTUBE_MIN_TURN_MS).toBe(RENDER_596_TURN_PRICE_MS);
    expect(RENDER_596_BEAT_WALL_MS).toBeLessThan(YOUTUBE_MIN_TURN_MS);
  });

  it("the window that CONTAINS a turn is strictly larger than the price a guard CHARGES", () => {
    /**
     * The whole point of the second constant. A window sized at exactly the price is a few
     * milliseconds under it by the time the guard reads the clock, because opening each nested
     * scope costs some — so sizing to the price relocates the defect instead of removing it.
     */
    expect(YOUTUBE_TURN_WINDOW_MS).toBeGreaterThan(YOUTUBE_MIN_TURN_MS);
  });

  it("and it is derived from the constants that already governed this path, not invented", () => {
    expect(YOUTUBE_TURN_WINDOW_MS).toBe(YOUTUBE_SEARCH_TIMEOUT_MS + TRANSFER_RESERVE_MS);
    expect(YOUTUBE_MIN_TURN_MS).toBe(YOUTUBE_SEARCH_TIMEOUT_MS + 12_000);
    /** The floor the transfer reserve itself is built from — unchanged. */
    expect(TRANSFER_RESERVE_MS).toBe(12_000 * 2);
  });

  it("every mode's YouTube window can pay for a turn — including the two that could not", () => {
    const saved = { ...process.env };
    try {
      for (const mode of [true, false]) {
        /** The default configuration. */
        delete process.env.YOUTUBE_ONLY_SOURCING;
        delete process.env.REAL_FOOTAGE_FIRST;
        expect(youtubeBeatFetchTimeoutMs(mode)).toBeGreaterThanOrEqual(YOUTUBE_TURN_WINDOW_MS);

        /**
         * The fastStockMode branch on Railway asked for 22_000 — under the price, so a turn was
         * refused by arithmetic whenever REAL_FOOTAGE_FIRST was switched off.
         */
        process.env.REAL_FOOTAGE_FIRST = "false";
        expect(youtubeBeatFetchTimeoutMs(mode)).toBeGreaterThanOrEqual(YOUTUBE_TURN_WINDOW_MS);

        /**
         * The operator trap: `YOUTUBE_BEAT_BUDGET_MS` accepts 15_000, which switched YouTube off
         * through a setting whose name says nothing about switching YouTube off.
         */
        process.env.YOUTUBE_ONLY_SOURCING = "true";
        process.env.ENABLE_YOUTUBE_SOURCING = "true";
        process.env.YOUTUBE_BEAT_BUDGET_MS = "15000";
        expect(youtubeBeatFetchTimeoutMs(mode)).toBeGreaterThanOrEqual(YOUTUBE_TURN_WINDOW_MS);
      }
    } finally {
      process.env = saved;
    }
  });

  it("a window that could already pay is untouched — this is a floor, not a raise", () => {
    const saved = { ...process.env };
    try {
      delete process.env.YOUTUBE_ONLY_SOURCING;
      delete process.env.REAL_FOOTAGE_FIRST; // REAL_FOOTAGE_FIRST defaults ON
      /** 55s on Railway, 70s elsewhere, and 80s for the non-fast default: all above the floor. */
      expect(youtubeBeatFetchTimeoutMs(true)).toBeGreaterThanOrEqual(55_000);
      expect(youtubeBeatFetchTimeoutMs(false)).toBeGreaterThanOrEqual(55_000);
      /** The asks themselves are the ones that were always there. */
      expect(PIPELINE).toContain("if (realFootageFirstEnabled()) return IS_RAILWAY ? 55_000 : 70_000;");
      expect(PIPELINE).toContain("if (fastStockMode) return IS_RAILWAY ? 22_000 : 35_000;");
      expect(PIPELINE).toContain("return 80_000;");
    } finally {
      process.env = saved;
    }
  });
});

/* ═══════════ §2 — the door the window now fits through ═══════════ */

describe("§2 — a turn opened three scopes deep still has a window", () => {
  /**
   * The nesting render 596 ran: the beat's fill wall, then `youtube-first`, then the turn's own
   * scope. `withSceneFetchTimeout` clamps every child to `min(now + ms, parentDeadline)`, so the
   * innermost window is whatever the OUTERMOST one had — which is the reason flooring the ask
   * alone could never have been enough.
   */
  const threeDeep = async (beatWallMs: number): Promise<number> => {
    let innermost = -1;
    await withSceneFetchTimeout(
      async () => {
        await withSceneFetchTimeout(
          async () => {
            await withSceneFetchTimeout(
              async () => {
                innermost = remainingScopeMs();
              },
              youtubeBeatFetchTimeoutMs(true),
              "the turn"
            );
          },
          90_000, // youtubeBeatBudgetMs asks 45–90s and is clamped by the beat, as it always was
          "youtube-first"
        );
      },
      beatWallMs,
      "beat fill"
    );
    return innermost;
  };

  it("THE DEFECT, REPRODUCED: render 596's wall leaves the turn short of the door", async () => {
    const left = await threeDeep(RENDER_596_BEAT_WALL_MS);
    expect(left).toBeGreaterThan(0);
    expect(left, "this is the 20s the guard compared against 24s").toBeLessThan(YOUTUBE_MIN_TURN_MS);
  });

  it("THE REPAIR: the widened wall carries a window through all three scopes", async () => {
    const left = await threeDeep(RENDER_596_BEAT_WALL_MS + YOUTUBE_TURN_WINDOW_MS);
    expect(
      left,
      "the turn must clear the door guard it is about to be measured by"
    ).toBeGreaterThanOrEqual(YOUTUBE_MIN_TURN_MS);
  });

  it("the supplement is a whole turn's window, and zero when there is no YouTube to ask", () => {
    const saved = { ...process.env };
    try {
      process.env.ENABLE_YOUTUBE_SOURCING = "true";
      process.env.YOUTUBE_API_KEY = "test-key-present";
      process.env.YOUTUBE_CC_DL_SERVICE = "https://example.invalid/dl";
      expect(youtubeBeatWallSupplementMs()).toBe(YOUTUBE_TURN_WINDOW_MS);

      /** No search capability: the beat keeps exactly the wall it has today. */
      delete process.env.YOUTUBE_API_KEY;
      expect(youtubeBeatWallSupplementMs()).toBe(0);

      /** Branch switched off: likewise nothing is added. */
      process.env.YOUTUBE_API_KEY = "test-key-present";
      process.env.ENABLE_YOUTUBE_SOURCING = "false";
      expect(youtubeBeatWallSupplementMs()).toBe(0);
    } finally {
      process.env = saved;
    }
  });

  it("the beat wall ADDS it — the cascade is not asked to pay for the turn", () => {
    /**
     * The sourcing tiers keep their own numbers and the supplement is summed onto them. A carve-out
     * would read `Math.max(...)` or a smaller literal here; an addition is what keeps the archive
     * whole.
     */
    expect(PIPELINE).toContain(
      "      : (visualSourcingTurbo(dedup) || isPipelineRushMode(dedup) ? 12_000 : 20_000) +\n" +
        "        youtubeBeatWallSupplementMs();"
    );
  });

  it("the two landing tiers keep their numbers — a render that is finishing starts no turns", () => {
    const at = PIPELINE.indexOf("const beatBudgetMs = dedup.forceExportMode");
    expect(at).toBeGreaterThan(-1);
    const decl = PIPELINE.slice(at, PIPELINE.indexOf(";", at));
    expect(decl).toContain("? 5_000");
    expect(decl).toContain("? 6_000");
    /** Neither panic tier is summed with the supplement. */
    expect(decl).not.toContain("5_000 + youtubeBeatWallSupplementMs()");
    expect(decl).not.toContain("6_000 + youtubeBeatWallSupplementMs()");
  });
});

/* ═══════════ §3 — a reserve smaller than the turn reserves nothing ═══════════ */

describe("§3 — the reservation is all of the turn's window, or none of it", () => {
  it("a scope that can pay reserves the whole window, not half of it", () => {
    const scope = scopeWithWindow(120_000);
    expect(reserveYoutubeTurn(scope)).toBe(YOUTUBE_TURN_WINDOW_MS);
  });

  it("a scope sized at exactly the window still reserves it", () => {
    const scope = scopeWithWindow(YOUTUBE_TURN_WINDOW_MS);
    expect(reserveYoutubeTurn(scope)).toBe(YOUTUBE_TURN_WINDOW_MS);
  });

  it("THE OLD HALF-RESERVE, NAMED: 20s used to withhold ~10s for a turn priced at 24s", () => {
    /**
     * `reserved=9996ms` in render 596's log. Ten seconds held back from the archive to pay for a
     * turn that the door was always going to refuse — the source got no turn AND the tiers behind
     * it got less time than they could have had.
     */
    const half = Math.floor(RENDER_596_BEAT_WALL_MS / 2);
    expect(half).toBeLessThan(YOUTUBE_MIN_TURN_MS);
    const scope = scopeWithWindow(RENDER_596_BEAT_WALL_MS);
    expect(reserveYoutubeTurn(scope), "a part-reserve reserves nothing").toBe(0);
  });

  it("a scope that cannot pay withholds nothing from the tiers that can spend it", async () => {
    await withSceneFetchTimeout(
      async () => {
        expect(remainingNonYoutubeScopeMs()).toBe(remainingScopeMs());
      },
      10_000,
      "a window too small for a turn"
    );
  });

  it("and a scope that can pay leaves the cascade exactly what it had before", async () => {
    /**
     * The whole claim of the additive supplement, measured: widen the beat BY a turn and the
     * non-YouTube share is the wall the cascade always ran on.
     */
    await withSceneFetchTimeout(
      async () => {
        const forOthers = remainingNonYoutubeScopeMs();
        expect(Math.abs(forOthers - RENDER_596_BEAT_WALL_MS)).toBeLessThanOrEqual(50);
      },
      RENDER_596_BEAT_WALL_MS + YOUTUBE_TURN_WINDOW_MS,
      "beat fill with YouTube available"
    );
  });

  it("the transfer's own share inside that window is untouched", () => {
    /** RONDE 259's rule, unchanged, applied to the window this round guarantees. */
    expect(transferReserveFor(YOUTUBE_TURN_WINDOW_MS)).toBe(
      Math.min(TRANSFER_RESERVE_MS, Math.floor(YOUTUBE_TURN_WINDOW_MS / 2))
    );
    expect(transferReserveFor(YOUTUBE_TURN_WINDOW_MS)).toBeGreaterThanOrEqual(
      YOUTUBE_SEARCH_TIMEOUT_MS
    );
  });
});

/* ═══════════ §4 — "YouTube had nothing" is now only said when YouTube was asked ═══════════ */

describe("§4 — the two empty answers stopped wearing one label", () => {
  it("the turn distinguishes them, and chooses from the MEASURED flag", () => {
    const at = PIPELINE.indexOf("const emptyOutcome: CentralYoutubeOutcome =");
    expect(at, "the turn still collapses both empties into one label").toBeGreaterThan(-1);
    const decl = PIPELINE.slice(at, PIPELINE.indexOf(";", at));
    expect(decl).toContain('attempt.searched ? "YOUTUBE_NO_RESULTS" : "YOUTUBE_NOT_SEARCHED"');
  });

  it("both exits that used to report NO_RESULTS now report the measured one", () => {
    /**
     * `deliver: "candidates"` and the adopted path each had their own literal. Neither may keep it,
     * or the mislabel survives on one route and the next render is ambiguous again.
     */
    const body = PIPELINE.slice(
      PIPELINE.indexOf("const emptyOutcome: CentralYoutubeOutcome ="),
      PIPELINE.indexOf("const refusedNow = countBeatVisionRefusals(")
    );
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain("finish(emptyOutcome, null)");
    expect(
      (body.match(/finish\("YOUTUBE_NO_RESULTS"/g) ?? []).length,
      "a literal NO_RESULTS is an unmeasured claim"
    ).toBe(0);
  });

  it("the flag is read from the provider's OWN counter, not from a new record", () => {
    /**
     * The defect class this codebase keeps removing is a second bookkeeping store for a fact that
     * is already counted. `searchCount` on the render's provider metrics is that count.
     */
    expect(PIPELINE).toContain(
      'const searchesBefore = providerMetrics(dedup.sourcingCache, "youtube_cc").searchCount;'
    );
    expect(PIPELINE).toContain(
      'providerMetrics(dedup.sourcingCache, "youtube_cc").searchCount > searchesBefore'
    );
  });

  it("every exit of the attempt carries it — an unset flag would read as 'never searched'", () => {
    const at = PIPELINE.indexOf("async function tryBeatRealYouTubeFootage(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\nfunction buildTopicDocumentaryYoutubeQueries", at));
    expect(body.length).toBeGreaterThan(500);
    const returns = (body.match(/\n\s*return \{/g) ?? []).length;
    expect(returns).toBe(3);
    expect((body.match(/searched: searchedSince\(\),/g) ?? []).length).toBe(returns);
  });
});

/* ═══════════ §5 — nothing was relaxed to pay for this ═══════════ */

describe("§5 — no gate, floor or price moved", () => {
  it("the four constants this round reads are the constants they were", () => {
    expect(PIPELINE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPELINE).toContain("export const YOUTUBE_SEARCH_TIMEOUT_MS = 12_000;");
    expect(PIPELINE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
    expect(PIPELINE).toContain(
      "export const TRANSFER_RESERVE_MS = YOUTUBE_MIN_DOWNLOAD_WINDOW_MS * 2;"
    );
  });

  it("the door guard still charges the same price it always did", () => {
    expect(PIPELINE).toContain("turnMs < YOUTUBE_MIN_TURN_MS");
  });

  it("the download ceiling and the entity ceiling are untouched", () => {
    expect(PIPELINE).toContain("const maxDownloadAttempts = youtubeMaxDownloadsPerRender();");
    expect(PIPELINE).toContain(
      "dedup.entityYoutubeFetchesUsed >= dedup.perf.maxEntityYoutubePerVideo"
    );
  });

  it("this round bought seconds, not leniency — no gate is named anywhere in it", () => {
    /**
     * §7 of the previous round: no YouTube special case. The supplement and the floor decide how
     * long a turn may take and nothing about what may come back from it, so neither function may
     * mention a gate, a score or a threshold.
     */
    for (const fn of ["youtubeBeatWallSupplementMs", "youtubeBeatFetchWindowAsked"]) {
      const at = PIPELINE.indexOf(`function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
      for (const forbidden of ["Gate", "gate", "Score", "score", "threshold", "relevance"]) {
        expect(body, `${fn} decides more than seconds`).not.toContain(forbidden);
      }
    }
  });

  it("and it is topic-agnostic — no subject reaches a budget decision", () => {
    for (const fn of ["youtubeBeatWallSupplementMs", "youtubeBeatFetchTimeoutMs", "reserveYoutubeTurn"]) {
      const at = PIPELINE.indexOf(`function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
      for (const forbidden of ["topic", "person", "beat.text", "videoTitle"]) {
        expect(body, `${fn} looks at the subject`).not.toContain(forbidden);
      }
    }
  });
});
