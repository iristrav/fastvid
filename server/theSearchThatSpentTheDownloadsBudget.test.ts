/**
 * RONDE 259 — THE SEARCH THAT SPENT THE DOWNLOAD'S BUDGET.
 *
 * ── What three renders measured ─────────────────────────────────────────────────────────────
 *
 *   576   79 YouTube downloads refused for a spent budget — 75 of them at literally `0s left`
 *   585   downloadSlots spent=3 returned=189 (claimed, but no bytes ever moved)
 *   585   1751 search results,                                              1 file
 *
 * And, four lines after four of those refusals, twenty fresh candidates for a beat that could no
 * longer fetch anything.
 *
 * ── The mechanism, proven by arithmetic ─────────────────────────────────────────────────────
 *
 *     beat search window   clamp(perSceneRetrieveMs * 0.30, 10s, 40s)      ≤ 40s
 *     YouTube's slice      youtubeBeatBudgetMs                             45s, capped at 90s
 *     scope nesting        deadlineAtMs = min(now + ms, parentDeadline)
 *     download floor       YOUTUBE_MIN_DOWNLOAD_WINDOW_MS                  12s
 *
 * A child scope can never outlive its parent, so YouTube's 45-second slice inside a 40-second beat
 * is a 40-second slice — and the previous round's raise from 30s to 45s could not have changed one
 * outcome, and did not. Searching and transferring shared one clock, and searching, which comes
 * first, spent it.
 *
 * ── What changes ────────────────────────────────────────────────────────────────────────────
 *
 * The tail of a fetch scope belongs to the transfer. Searching may not spend it, and a search whose
 * answer could only arrive inside it is not issued.
 *
 * NO BUDGET IS RAISED. §5 pins every number this round could have been tempted to move, and they
 * are all the numbers they were. What moves is which half of an unchanged window pays for what.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  SEARCH_WINDOW_SPENT,
  TRANSFER_RESERVE_MS,
  cachedProviderSearch,
  createSourcingCache,
  remainingScopeMs,
  remainingSearchMs,
  transferReserveFor,
  withSceneFetchTimeout,
  withinSearchWindow,
} from "./videoPipeline";
import { emptyQueryContext, withSearchProvenance } from "./searchQueryContract";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The ambient proof a real beat search runs under, so the SearchGate admits these queries. */
const proven = <T,>(beatText: string, fn: () => Promise<T>): Promise<T> =>
  withSearchProvenance(emptyQueryContext(beatText), fn);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ═══════════ 1. the reserve exists, and it is a share of an unchanged window ═══════════ */

describe("R259 §1 — the tail of the window belongs to the transfer", () => {
  it("a window large enough to hold both reserves the download's floor twice over", () => {
    expect(TRANSFER_RESERVE_MS).toBe(24_000);
    expect(transferReserveFor(60_000)).toBe(TRANSFER_RESERVE_MS);
  });

  it("and the widest beat window there is — forty seconds — splits down the middle", () => {
    /**
     * `BEAT_SEARCH_MAX_MS` is 40s, so the half-rule binds before the reserve does: twenty seconds
     * of searching and twenty for the transfer. Render 585 gave the transfer none of it.
     */
    expect(transferReserveFor(40_000)).toBe(20_000);
  });

  it("A SOURCE MAY NOT BE SWITCHED OFF BY ARITHMETIC: searching always keeps at least half", () => {
    for (const windowMs of [1_000, 8_000, 16_000, 30_000, 47_999]) {
      const reserve = transferReserveFor(windowMs);
      expect(reserve, `reserve took more than half of ${windowMs}ms`).toBeLessThanOrEqual(
        windowMs / 2
      );
      expect(windowMs - reserve).toBeGreaterThanOrEqual(windowMs / 2);
    }
  });

  it("and a window with nothing in it reserves nothing", () => {
    expect(transferReserveFor(0)).toBe(0);
    expect(transferReserveFor(-5_000)).toBe(0);
    expect(transferReserveFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("outside any scope nothing is reserved, because there is no deadline to protect", () => {
    expect(remainingSearchMs()).toBe(Number.POSITIVE_INFINITY);
    expect(remainingScopeMs()).toBe(Number.POSITIVE_INFINITY);
  });
});

/* ═══════════ 2. the scope carries it, and a child cannot search past its parent ═══════════ */

describe("R259 §2 — a scope stops searching before it stops", () => {
  it("THE DOWNLOAD'S SHARE SURVIVES THE SEARCH WINDOW", async () => {
    await withSceneFetchTimeout(
      async () => {
        const forSearch = remainingSearchMs();
        const forEverything = remainingScopeMs();
        expect(forEverything - forSearch).toBeGreaterThanOrEqual(TRANSFER_RESERVE_MS - 50);
        expect(forSearch, "the whole window went to searching, as in render 585").toBeLessThan(
          forEverything
        );
      },
      60_000,
      "r259 scope"
    );
  });

  it("a child sized larger than its parent inherits the parent's search deadline too", async () => {
    await withSceneFetchTimeout(
      async () => {
        const parentSearch = remainingSearchMs();
        await withSceneFetchTimeout(
          async () => {
            /**
             * This is `youtubeFirstBeatSlice` exactly: a 45s slice asked for inside a beat that
             * has 40s. The grant was always the beat's; now the RESERVE is the beat's as well, so
             * the child cannot search into time its parent already promised to a transfer.
             */
            expect(remainingSearchMs()).toBeLessThanOrEqual(parentSearch + 5);
          },
          90_000,
          "r259 oversized child"
        );
      },
      40_000,
      "r259 parent"
    );
  });

  it("A CHILD OPENED LATE CANNOT SEARCH INTO ITS PARENT'S RESERVE", async () => {
    /**
     * The clamp the oversized child above cannot see, because there the two deadlines coincide.
     * Here the parent has already spent past its own search deadline when the child opens, and the
     * child's window — short, so its own reserve is small — would otherwise hand it fresh search
     * time carved out of time the parent had already promised to a transfer. That is the leak in
     * miniature: a nested scope reopening the window its parent had closed.
     */
    await withSceneFetchTimeout(
      async () => {
        await sleep(700);
        expect(remainingSearchMs(), "the parent's own search window is over").toBe(0);
        await withSceneFetchTimeout(
          async () => {
            expect(
              remainingSearchMs(),
              "the child reopened the search window its parent had closed"
            ).toBe(0);
          },
          5_000,
          "r259 late child"
        );
      },
      1_000,
      "r259 late-child parent"
    );
  });

  it("a short scope still searches — the reserve is a share, never a shutdown", async () => {
    await withSceneFetchTimeout(
      async () => {
        expect(remainingSearchMs()).toBeGreaterThan(0);
      },
      4_000,
      "r259 short scope"
    );
  });
});

/* ═══════════ 3. a search whose answer could not be fetched is not issued ═══════════ */

describe("R259 §3 — 1751 results and one file", () => {
  /** A provider search that counts how often it actually reaches "the network". */
  function countingProvider<T>(payload: T) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      search: async (): Promise<T> => {
        calls += 1;
        return payload;
      },
    };
  }

  it("BEFORE THE RESERVE, a spent search window still admitted fresh searches", () => {
    /**
     * The mechanism, stated as arithmetic rather than re-enacted: without a search deadline the
     * only thing that stopped a search was the scope's own abort, and the twenty candidates that
     * arrived after render 585's four `0s left` refusals are what that looks like in a log.
     */
    expect(PIPE).toContain("searchDeadlineAtMs");
    expect(
      PIPE,
      "the only clock a search answered to was the one the download needed"
    ).toContain("if (sceneScope && remainingSearchMs() <= 0) {");
  });

  it("AFTER: inside the reserve, the provider is not called at all", async () => {
    const cache = createSourcingCache();
    const provider = countingProvider(["a"]);
    await withSceneFetchTimeout(
      async () => {
        // A 200ms window: 100ms of searching, 100ms reserved for the transfer.
        await sleep(140);
        await proven("Churchill", async () => {
          await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test");
        });
      },
      200,
      "r259 spent search window"
    );
    expect(provider.calls, "a candidate nobody could fetch was fetched anyway").toBe(0);
  });

  it("and the source is remembered as CUT OFF, never as 'this source has nothing'", async () => {
    const cache = createSourcingCache();
    const provider = countingProvider(["a"]);
    await withSceneFetchTimeout(
      async () => {
        await sleep(140);
        await proven("Churchill", async () => {
          await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "test");
        });
      },
      200,
      "r259 cut off"
    );
    expect(cache.budgetCancelledProviders.has("pexels")).toBe(true);
  });

  it("IT IS NOT SILENT, and it says so once per scope rather than once per refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cache = createSourcingCache();
      const provider = countingProvider(["a"]);
      await withSceneFetchTimeout(
        async () => {
          await sleep(140);
          await proven("Churchill Stalin Roosevelt", async () => {
            for (const q of ["Churchill", "Stalin", "Roosevelt"]) {
              await cachedProviderSearch(cache, "pexels", q, provider.search, "test");
            }
          });
        },
        200,
        "r259 one line"
      );
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("transfer reserve"));
      expect(lines, "three refusals, three lines — that is how 356 hid").toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a scope with time left is untouched: the search goes out exactly as before", async () => {
    const cache = createSourcingCache();
    const provider = countingProvider(["a"]);
    await withSceneFetchTimeout(
      async () => {
        await proven("Churchill", async () => {
          const out = await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "t");
          expect(out).toEqual(["a"]);
        });
      },
      60_000,
      "r259 healthy scope"
    );
    expect(provider.calls).toBe(1);
  });

  it("and outside any scope nothing changes at all — the prefetch case", async () => {
    const cache = createSourcingCache();
    const provider = countingProvider(["a"]);
    await proven("Churchill", async () => {
      expect(
        await cachedProviderSearch(cache, "pexels", "Churchill", provider.search, "t")
      ).toEqual(["a"]);
    });
    expect(provider.calls).toBe(1);
  });
});

/* ═══════════ 4. a search still running when the window closes is abandoned ═══════════ */

describe("R259 §4 — the beat stops waiting", () => {
  it("A SEARCH THAT OUTLASTS THE WINDOW DOES NOT KEEP THE DOWNLOAD WAITING", async () => {
    await withSceneFetchTimeout(
      async () => {
        const slow = sleep(10_000).then(() => ["late"]);
        const t0 = Date.now();
        const answered = await withinSearchWindow(slow);
        expect(answered).toBe(SEARCH_WINDOW_SPENT);
        expect(Date.now() - t0, "it waited for the answer it could not use").toBeLessThan(2_000);
      },
      400,
      "r259 slow provider"
    );
  });

  it("the reserve is still intact when it gives up, which is the entire point", async () => {
    await withSceneFetchTimeout(
      async () => {
        await withinSearchWindow(sleep(10_000).then(() => ["late"]));
        expect(
          remainingScopeMs(),
          "the transfer's share was spent waiting for a search"
        ).toBeGreaterThan(0);
      },
      600,
      "r259 reserve intact"
    );
  });

  it("an answer that arrives in time is returned, not discarded", async () => {
    await withSceneFetchTimeout(
      async () => {
        expect(await withinSearchWindow(Promise.resolve(["fast"]))).toEqual(["fast"]);
      },
      60_000,
      "r259 fast provider"
    );
  });

  it("a failure is still a failure — abandoning is not swallowing", async () => {
    await withSceneFetchTimeout(
      async () => {
        await expect(withinSearchWindow(Promise.reject(new Error("provider 500")))).rejects.toThrow(
          "provider 500"
        );
      },
      60_000,
      "r259 failing provider"
    );
  });

  it("outside a scope it is a pass-through, with no timer at all", async () => {
    expect(await withinSearchWindow(Promise.resolve(["x"]))).toEqual(["x"]);
  });

  /**
   * The two tests below go through `cachedProviderSearch` rather than the wrapper, because that is
   * where a beat actually waits. A first version of this section tested only the wrapper, and
   * awaiting the provider bare inside `cachedProviderSearch` again sailed straight through it — the
   * helper was correct and unreachable, which is this codebase's signature defect wearing a test.
   */
  it("A SLOW PROVIDER DOES NOT HOLD THE BEAT — through the one function every search passes", async () => {
    const cache = createSourcingCache();
    const slow = async () => {
      await sleep(10_000);
      return ["late"];
    };
    const t0 = Date.now();
    await withSceneFetchTimeout(
      () =>
        proven("Churchill", async () => {
          expect(await cachedProviderSearch(cache, "pexels", "Churchill", slow, "test")).toEqual([]);
        }),
      400,
      "r259 slow provider, cached path"
    );
    expect(Date.now() - t0, "the beat waited out a search it could not use").toBeLessThan(2_000);
    expect(cache.budgetCancelledProviders.has("pexels")).toBe(true);
  });

  it("and on the uncached path too — RONDE 173's 37 call sites are not a second set of rules", async () => {
    const slow = async () => {
      await sleep(10_000);
      return ["late"];
    };
    const t0 = Date.now();
    await withSceneFetchTimeout(
      () =>
        proven("Churchill", async () => {
          expect(await cachedProviderSearch(undefined, "pexels", "Churchill", slow, "t")).toEqual([]);
        }),
      400,
      "r259 slow provider, uncached path"
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

/* ═══════════ 5. nothing was raised, lengthened or loosened ═══════════ */

describe("R259 §5 — the numbers this round could have moved, and did not", () => {
  it("the beat search window is the window it was", async () => {
    const budget = fs.readFileSync(path.join(__dirname, "renderBudget.ts"), "utf8");
    expect(budget).toContain("BEAT_SEARCH_MIN_MS   =  10_000;");
    expect(budget).toContain("BEAT_SEARCH_MAX_MS   =  40_000;");
    expect(budget).toContain("clampMs(perSceneRetrieveMs * 0.30, BEAT_SEARCH_MIN_MS,   BEAT_SEARCH_MAX_MS)");
  });

  it("the YouTube beat budget is the budget it was", async () => {
    const policy = fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(policy).toContain("isFastShortVideoLength(videoLength) ? 30_000 : 45_000");
    expect(policy).toContain("return Math.min(Math.max(base, share), base * 2);");
  });

  it("the download floor is the floor it was — RONDE 68's twelve seconds", () => {
    expect(PIPE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
  });

  it("and the reserve is derived from that floor, not from a number invented here", () => {
    expect(PIPE).toContain("export const TRANSFER_RESERVE_MS = YOUTUBE_MIN_DOWNLOAD_WINDOW_MS * 2;");
  });

  it("the download timeout and the scene search budget are untouched", async () => {
    const policy = await import("./sourcingPolicy");
    expect(policy.youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(policy.YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS).toBe(8_000);
    const scene = fs.readFileSync(path.join(__dirname, "sceneSearchBudget.ts"), "utf8");
    expect(scene).toContain("export const SCENE_SEARCH_MIN_MS = 60_000;");
  });

  it("RONDE 216's refusal on an ALREADY-CANCELLED scope still stands in front of this one", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("export async function cachedProviderSearch<T>("),
      PIPE.indexOf("export function getCachedProviderAsset(")
    );
    const aborted = fn.indexOf("if (sceneScope?.controller.signal.aborted)");
    const reserve = fn.indexOf("if (sceneScope && remainingSearchMs() <= 0) {");
    expect(aborted).toBeGreaterThan(0);
    expect(reserve).toBeGreaterThan(0);
    expect(aborted, "the cheaper check moved behind the newer one").toBeLessThan(reserve);
  });
});

/* ═══════════ 6. the slice the log reports is the slice the beat got ═══════════ */

describe("R259 §6 — a metric that reported the request and spent the grant", () => {
  const slice = PIPE.slice(
    PIPE.indexOf("async function youtubeFirstBeatSlice("),
    PIPE.indexOf("export async function fetchBeatArchivalThenPexels(")
  );

  it("THE 45s THAT WAS NEVER 45s: the effective slice is computed from the scope", () => {
    expect(slice).toContain("const sliceMs = Math.min(ytBudget, remainingScopeMs());");
  });

  it("and both log lines print it", () => {
    const printed = [...slice.matchAll(/Math\.round\(sliceMs \/ 1000\)/g)];
    expect(printed.length, "a line still reports the request as though it were the grant").toBe(2);
  });

  it("the request is still shown next to it, because the gap is the finding", () => {
    expect(slice).toContain("asked for ${Math.round(ytBudget / 1000)}s");
    expect(slice).toContain("of the ${Math.round(ytBudget / 1000)}s it asked for");
  });

  it("and the scope is still given the budget it asks for — only the REPORT changed", () => {
    expect(slice, "the fix quietly became a budget cut").toContain("      ytBudget,\n");
  });
});
