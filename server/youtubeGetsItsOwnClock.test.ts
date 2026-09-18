/**
 * YOUTUBE GETS ITS OWN CLOCK — a turn refused for time it never had.
 *
 * ── The line this removes ───────────────────────────────────────────────────────────────────
 *
 *     [YouTube] TURN_DECLINED scene=2 — 20s left and a turn costs 24s
 *       (one 12s search plus the 12s download floor)
 *
 * RONDE 260 put that question at the door on purpose: nothing should be started that cannot
 * finish. The question is right and the answer was decided before YouTube was ever asked — the
 * scene's clock is shared, and archive searches and their retries had already spent it.
 *
 * ── The shape of the fix, and why it is not a bigger budget ─────────────────────────────────
 *
 * RONDE 259 already established the pattern: `searchDeadlineAtMs` holds back the tail that belongs
 * to the transfer, so a candidate found late can still be fetched. This is the same idea one tier
 * up. A slice of the scene's window belongs to the YouTube turn from the moment the scope opens,
 * so "is there time" has the same answer whether it is asked first or last.
 *
 * Nothing is raised. No timeout is longer, no retry is added, the scene's total window is
 * identical, and no gate moves. What changes is only who may spend which part of it — and the
 * moment YouTube's turn ends, whatever its outcome, the reserve goes back to the tiers behind it.
 *
 * ── The invariant, in one line ──────────────────────────────────────────────────────────────
 *
 *     NON_YOUTUBE_SPEND <= TOTAL_BUDGET - YOUTUBE_RESERVED_BUDGET
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  withSceneFetchTimeout,
  remainingScopeMs,
  remainingNonYoutubeScopeMs,
  scopedTimeoutMs,
  endYoutubeTurn,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_SEARCH_TIMEOUT_MS,
} from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** A scene window big enough that the reserve is the real constant, not the half-window clamp. */
const WINDOW_MS = 120_000;

const inScope = <T>(fn: () => T | Promise<T>, ms = WINDOW_MS): Promise<T> =>
  withSceneFetchTimeout(async () => fn(), ms, "test scene");

/* ═══════════ 1 — the reserve exists before anything has spent ═══════════ */

describe("§1 — the reservation is made when the scope opens", () => {
  it("a non-YouTube caller sees less than the whole clock, by exactly the turn's cost", async () => {
    await inScope(() => {
      const whole = remainingScopeMs();
      const forOthers = remainingNonYoutubeScopeMs();
      /** Within a millisecond: both readings race `Date.now()` against the same deadline. */
      expect(Math.abs(whole - forOthers - YOUTUBE_MIN_TURN_MS)).toBeLessThanOrEqual(2);
    });
  });

  it("the YouTube turn sees the whole clock — the reserve is its own", async () => {
    await inScope(() => {
      expect(remainingScopeMs()).toBeGreaterThan(remainingNonYoutubeScopeMs());
      expect(remainingScopeMs()).toBeGreaterThanOrEqual(YOUTUBE_MIN_TURN_MS);
    });
  });

  it("the reserve is the turn's real cost — one search plus the download floor", () => {
    /**
     * §6: derived from the constants that already governed the turn, not invented. The download
     * floor is the remainder, and both are what `fetchYouTubeCCClips` already measured itself
     * against before any of this existed.
     */
    expect(YOUTUBE_MIN_TURN_MS).toBe(YOUTUBE_SEARCH_TIMEOUT_MS + 12_000);
    expect(PIPELINE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
  });

  it("a scene too small to share is not handed to one provider", async () => {
    /** Never more than half the window: a guaranteed turn, not a guaranteed monopoly. */
    await inScope(() => {
      const whole = remainingScopeMs();
      expect(whole - remainingNonYoutubeScopeMs()).toBeLessThanOrEqual(Math.ceil(whole / 2) + 50);
    }, 10_000);
  });
});

/* ═══════════ 2 — other providers cannot spend it ═══════════ */

describe("§2 — NON_YOUTUBE_SPEND <= TOTAL - RESERVED", () => {
  it("every provider timeout is sized against the reduced clock", async () => {
    /**
     * `scopedTimeoutMs` is the one funnel every non-YouTube provider timeout in this pipeline goes
     * through, which is why the reserve is honoured there and nowhere else has to remember.
     */
    await inScope(() => {
      const asked = WINDOW_MS; // more than the scope can give
      expect(scopedTimeoutMs(asked)).toBeLessThanOrEqual(remainingNonYoutubeScopeMs());
      expect(scopedTimeoutMs(asked)).toBeLessThan(remainingScopeMs());
    });
  });

  it("archive work cannot be granted the seconds the turn is holding", async () => {
    await inScope(() => {
      const granted = scopedTimeoutMs(WINDOW_MS);
      const whole = remainingScopeMs();
      expect(whole - granted).toBeGreaterThanOrEqual(YOUTUBE_MIN_TURN_MS);
    });
  });

  it("outside a scope nothing is withheld — there is no clock to reserve from", () => {
    expect(remainingNonYoutubeScopeMs()).toBe(Number.POSITIVE_INFINITY);
    expect(remainingScopeMs()).toBe(Number.POSITIVE_INFINITY);
  });
});

/* ═══════════ 3 — released only after the turn, and then fully ═══════════ */

describe("§3 — the reserve returns to the pool when the turn ends", () => {
  it("unused budget is released ONLY after the turn finishes, and then in full", async () => {
    await inScope(() => {
      const before = remainingNonYoutubeScopeMs();
      expect(Math.abs(remainingScopeMs() - before - YOUTUBE_MIN_TURN_MS)).toBeLessThanOrEqual(2);

      endYoutubeTurn("YOUTUBE_NO_RESULTS");

      const after = remainingNonYoutubeScopeMs();
      expect(after).toBeGreaterThan(before);
      expect(remainingScopeMs() - after).toBeLessThanOrEqual(2);
    });
  });

  it("the release is idempotent — a second ending cannot re-open the turn", async () => {
    await inScope(() => {
      endYoutubeTurn("YOUTUBE_NO_RESULTS");
      const after = remainingNonYoutubeScopeMs();
      endYoutubeTurn("ADOPTABLE_CANDIDATES:1");
      expect(remainingScopeMs() - remainingNonYoutubeScopeMs()).toBeLessThanOrEqual(2);
      expect(remainingNonYoutubeScopeMs()).toBeLessThanOrEqual(after);
    });
  });

  it("a scope's reserve is its own — a sibling scene does not inherit the release", async () => {
    await inScope(() => {
      endYoutubeTurn("YOUTUBE_NO_RESULTS");
      expect(remainingScopeMs() - remainingNonYoutubeScopeMs()).toBeLessThanOrEqual(2);
    });
    await inScope(() => {
      expect(
        Math.abs(remainingScopeMs() - remainingNonYoutubeScopeMs() - YOUTUBE_MIN_TURN_MS)
      ).toBeLessThanOrEqual(2);
    });
  });
});

/* ═══════════ 4 — the turn always ends, and says how ═══════════ */

describe("§4 — every exit of the turn names its outcome", () => {
  const fetcher = (): string => {
    const at = PIPELINE.indexOf("export async function fetchYouTubeCCClips(");
    expect(at).toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
  };

  it("every return from the fetcher has released the reserve first", () => {
    /**
     * A reserve still held after the turn would starve the tiers behind it for the rest of the
     * scene — the mirror image of the bug this fixes, and the one a new branch would reintroduce.
     */
    const body = fetcher();
    const returns = [...body.matchAll(/\n\s*return (results|\[\]);/g)];
    expect(returns.length, "the fetcher's exits moved").toBeGreaterThanOrEqual(4);
    const releases = [...body.matchAll(/endYoutubeTurn\(/g)];
    expect(releases.length, "an exit leaves without ending the turn").toBeGreaterThanOrEqual(
      returns.length
    );
  });

  it("the outcomes are §8's vocabulary, not a bare boolean", () => {
    const body = fetcher();
    for (const outcome of [
      "YOUTUBE_CAPABILITY_UNAVAILABLE:no_api_key",
      "YOUTUBE_CAPABILITY_UNAVAILABLE:no_downloader",
      "TURN_DECLINED_NO_WINDOW",
      "YOUTUBE_NO_RESULTS",
    ]) {
      expect(body, outcome).toContain(outcome);
    }
    expect(body).toContain("ADOPTABLE_CANDIDATES:");
  });

  it("a decline says which kind it is — §21's distinction", () => {
    /**
     * BAD  TURN_DECLINED reason=shared budget exhausted
     * GOOD TURN_DECLINED reserved=24000ms reserveState=HELD
     *
     * With a reserve held, "not enough time" can no longer mean "an archive search took it".
     */
    const body = fetcher();
    expect(body).toContain("reserveState=");
    expect(body).toContain('reserved=${reserved}ms');
    expect(body).toContain("ALREADY_RELEASED");
  });

  it("YOUTUBE_TURN_COMPLETED reports what was reserved and how it ended", () => {
    expect(PIPELINE).toContain("YOUTUBE_TURN_COMPLETED reserved=");
    expect(PIPELINE).toContain("the reserve is released to the remaining tiers");
  });
});

/* ═══════════ 5 — nothing was loosened to achieve it ═══════════ */

describe("§5 — no budget was raised and no gate moved", () => {
  it("the turn's own constants are unchanged", () => {
    expect(YOUTUBE_SEARCH_TIMEOUT_MS).toBe(12_000);
    expect(PIPELINE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
  });

  it("the door question RONDE 260 built is still asked", () => {
    expect(PIPELINE).toContain("TURN_DECLINED");
    expect(PIPELINE).toContain("turnMs < YOUTUBE_MIN_TURN_MS");
  });

  it("the transfer reserve RONDE 259 built is untouched", () => {
    expect(PIPELINE).toContain("searchDeadlineAtMs: Math.min(deadlineAtMs - reserveMs, parentSearchDeadline)");
    expect(PIPELINE).toContain("export function remainingSearchMs()");
  });

  it("the reservation happens at scope open, before any provider runs", () => {
    /** §20's ordering: a reserve asked for later could already be too late to matter. */
    const at = PIPELINE.indexOf("const scope: SceneFetchScope = {");
    const after = PIPELINE.slice(at, at + 1400);
    expect(after).toContain("reserveYoutubeTurn(scope);");
    expect(
      after.indexOf("reserveYoutubeTurn(scope);"),
      "the reserve must be taken before the scope is handed to anyone"
    ).toBeLessThan(after.indexOf("return new Promise<T>"));
  });
});
