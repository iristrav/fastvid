/**
 * ONE CLOCK DECIDES WHETHER YOUTUBE IS ASKED — RONDE 604.
 *
 * ── Why RONDE 600 could be true and render 597 still search once ────────────────────────────
 *
 *     [YouTube] TURN_DECLINED scene=1 reserved=0ms reserveState=NONE —
 *       20s left and a turn costs 24s … clock="b3_fastyt-first s1 b3" granted=20s used=0s
 *     youtube_cc: searches=1 (508ms) results=100 downloads=1 accepted=0
 *
 * ONE search in a whole render, on a build where the budget was supposedly repaired. RONDE 600
 * widened `beatBudgetMs`, floored `youtubeBeatFetchTimeoutMs` and fixed `reserveYoutubeTurn` — and
 * left `runBeatClipFetch`, which opens its OWN scope on `dedup.perf.beatClipTimeoutMs` (22s on
 * Railway) and has never known the supplement exists. A turn opened underneath it is clamped to a
 * wall that cannot pay, so the door refuses it — correctly, for a window nobody meant to withhold.
 *
 * Five readers each did their own arithmetic on the same numbers. Repairing three left two intact,
 * and two is enough to keep the source shut.
 *
 * ── What this round does and does not do ────────────────────────────────────────────────────
 *
 * No constant moves. `YOUTUBE_MIN_TURN_MS` is still the price the door charges, `beatClipTimeoutMs`
 * still governs the stock work, and the two landing tiers still keep 5s and 6s. What changes is
 * that the question "can this clock pay for a turn" has one implementation instead of five.
 *
 * And a refusal is audible. The three bare `continue`s in `tryStockSources` ended the loop with a
 * single fetcher in the array and reported the provider as having found nothing — for a provider
 * that was never asked. `categoryAtLimit` is the worst of them: `usedCategories` is RENDER-wide and
 * `generic` is capped at 4, so on a documentary the source closes after the fourth adopted clip of
 * the whole video, silently.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  affordsYoutubeTurn,
  beatVisualWallMs,
  canAffordYoutubeTurn,
  beatWallWithYoutubeTurn,
  youtubeBeatWallSupplementMs,
  withSceneFetchTimeout,
  remainingScopeMs,
  remainingNonYoutubeScopeMs,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_TURN_WINDOW_MS,
  youtubeBeatFetchTimeoutMs,
  historicalRescueBudgetMs,
} from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Render 597's own numbers. */
const R597_STOCK_WALL_MS = 22_000;
const R597_GRANTED_MS = 20_000;

/* ═══════════ §1 — one predicate ═══════════ */

describe("§1 — affordsYoutubeTurn", () => {
  it("THE DEFECT, IN ITS OWN NUMBERS: render 597's wall could not pay", () => {
    expect(affordsYoutubeTurn(R597_GRANTED_MS, YOUTUBE_MIN_TURN_MS)).toBe(false);
    expect(affordsYoutubeTurn(R597_STOCK_WALL_MS, YOUTUBE_TURN_WINDOW_MS)).toBe(false);
  });

  it("THE REPAIR: the widened wall pays, with room for the nesting", () => {
    /**
     * With YouTube AVAILABLE — the supplement is deliberately zero otherwise, and a test that did
     * not say so would be measuring the build without a key and calling it the repair.
     */
    const saved = { ...process.env };
    try {
      process.env.ENABLE_YOUTUBE_SOURCING = "true";
      process.env.YOUTUBE_API_KEY = "test-key-present";
      process.env.YOUTUBE_CC_DL_SERVICE = "https://example.invalid/dl";
      const widened = beatWallWithYoutubeTurn(R597_STOCK_WALL_MS);
      expect(widened).toBe(R597_STOCK_WALL_MS + YOUTUBE_TURN_WINDOW_MS);
      expect(affordsYoutubeTurn(widened, YOUTUBE_TURN_WINDOW_MS)).toBe(true);
      expect(
        affordsYoutubeTurn(widened, YOUTUBE_MIN_TURN_MS),
        "and comfortably past the price the door charges"
      ).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("exactly the window is enough; a millisecond under is not", () => {
    expect(affordsYoutubeTurn(YOUTUBE_TURN_WINDOW_MS)).toBe(true);
    expect(affordsYoutubeTurn(YOUTUBE_TURN_WINDOW_MS - 1)).toBe(false);
  });

  it("no enclosing clock is not a short clock", () => {
    expect(affordsYoutubeTurn(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("canAffordYoutubeTurn reads the WHOLE clock, not the reduced one", () => {
    /**
     * The reserve is YouTube's own and the turn may spend all of it. Reading
     * `remainingNonYoutubeScopeMs` here would charge the turn for its own reservation — which is
     * that function's entire reason for existing separately.
     */
    const at = PIPELINE.indexOf("export function canAffordYoutubeTurn(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
    expect(body).toContain("remainingScopeMs()");
    expect(body, "the turn was charged for its own reserve").not.toContain("remainingNonYoutubeScopeMs");
  });
});

/* ═══════════ §2 — the wall that starved it ═══════════ */

describe("§2 — a wall that may host a turn is wide enough to hold one", () => {
  it("the stock wall now carries the supplement", () => {
    const at = PIPELINE.indexOf("async function runBeatClipFetch(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n/** Quick script-ordered rescue", at));
    expect(body).toContain("beatWallWithYoutubeTurn(beatClipTimeoutMs)");
    expect(
      body,
      "the profile's raw number still opens the scope, so the supplement never arrives"
    ).not.toMatch(/withSceneFetchTimeout\([\s\S]{0,400}?\n\s*beatClipTimeoutMs,/);
  });

  it("and the beat fill wall reads the same helper", () => {
    const at = PIPELINE.indexOf("const beatBudgetMs = dedup.forceExportMode");
    const decl = PIPELINE.slice(at, PIPELINE.indexOf(";", at));
    expect(decl).toContain("beatWallWithYoutubeTurn(");
    /** The landing tiers keep their numbers: a render that is finishing starts no turns. */
    expect(decl).toContain("? 5_000");
    expect(decl).toContain("? 6_000");
  });

  it("the supplement is zero when there is no YouTube, so other builds keep their wall", () => {
    const saved = { ...process.env };
    try {
      delete process.env.YOUTUBE_API_KEY;
      expect(youtubeBeatWallSupplementMs()).toBe(0);
      expect(beatWallWithYoutubeTurn(R597_STOCK_WALL_MS)).toBe(R597_STOCK_WALL_MS);
    } finally {
      process.env = saved;
    }
  });

  it("RUNTIME: a turn opened under the widened wall clears the door", async () => {
    /**
     * Two scopes deep, as production runs it: the beat's stock wall, then the turn's own. With the
     * old wall the inner clock lands under the price; with the widened one it does not.
     */
    const inner = async (wallMs: number): Promise<number> => {
      let left = -1;
      await withSceneFetchTimeout(
        async () => {
          await withSceneFetchTimeout(
            async () => { left = remainingScopeMs(); },
            YOUTUBE_TURN_WINDOW_MS,
            "the turn"
          );
        },
        wallMs,
        "beat stock wall"
      );
      return left;
    };
    expect(await inner(R597_STOCK_WALL_MS), "render 597's wall").toBeLessThan(YOUTUBE_MIN_TURN_MS);
    expect(
      await inner(R597_STOCK_WALL_MS + YOUTUBE_TURN_WINDOW_MS),
      "the widened wall"
    ).toBeGreaterThanOrEqual(YOUTUBE_MIN_TURN_MS);
  });
});

/* ═══════════ §3 — the reserve and the door read the same answer ═══════════ */

describe("§3 — five readers, one implementation", () => {
  it("the door guard asks the predicate rather than doing the arithmetic", () => {
    expect(PIPELINE).toContain("if (!canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS)) {");
    expect(
      PIPELINE,
      "the guard still carries its own comparison"
    ).not.toContain("turnMs < YOUTUBE_MIN_TURN_MS)");
  });

  it("the reserve asks it too", () => {
    const at = PIPELINE.indexOf("export function reserveYoutubeTurn(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", PIPELINE.indexOf("return scope.youtubeReservedMs;", at)));
    expect(body).toContain("affordsYoutubeTurn(window, want)");
  });

  it("the price the door charges has not moved", () => {
    expect(YOUTUBE_MIN_TURN_MS).toBe(24_000);
    expect(PIPELINE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
  });

  it("and the reserve still leaves the cascade exactly what it had", async () => {
    await withSceneFetchTimeout(
      async () => {
        const forOthers = remainingNonYoutubeScopeMs();
        expect(Math.abs(forOthers - R597_STOCK_WALL_MS)).toBeLessThanOrEqual(50);
      },
      R597_STOCK_WALL_MS + YOUTUBE_TURN_WINDOW_MS,
      "widened wall"
    );
  });
});

/* ═══════════ §4 — a source that is not asked says so ═══════════ */

describe("§4 — no silent starvation in tryStockSources", () => {
  const body = (() => {
    const at = PIPELINE.indexOf("async function tryStockSources(");
    return PIPELINE.slice(at, PIPELINE.indexOf("\n/** Guaranteed-unique stock for one beat", at));
  })();

  it("THE DEFECT: three refusals used to end the loop without a word", () => {
    expect(body, "a bare continue on a blocked query").not.toContain("if (isBlockedStockQuery(query)) continue;");
    expect(body, "a bare continue on a spent category").not.toContain(
      "if (categoryAtLimit(dedup, category, adoptOpts.muskTopic)) continue;"
    );
  });

  it("each names itself, the query and the scope of the limit", () => {
    expect(body).toContain("[SourceSkipped]");
    expect(body).toContain('declineSource("BLOCKED_QUERY", query)');
    expect(body).toContain('declineSource("MUSK_CATEGORY_NOT_APPROVED"');
    expect(body).toContain('declineSource(\n        "CATEGORY_AT_LIMIT"');
    expect(body, "a render-wide cap must say that it is render-wide").toContain("scope=render");
  });

  it("the limits themselves are untouched", () => {
    expect(PIPELINE).toContain("const STOCK_CATEGORY_LIMITS: Record<string, number> = {");
    expect(PIPELINE).toContain("  generic: 4,");
    expect(PIPELINE).toContain("function categoryAtLimit(");
  });
});

/* ═══════════ §5 — the three walls belong together ═══════════ */

describe("§5 — every wall a YouTube turn can open under", () => {
  /**
   * RONDE 605 — THE REASON THIS SECTION EXISTS AT ALL.
   *
   * Render 597 declined ten turns from TWO wall families, and RONDE 604 repaired one of them. That
   * looked like a success — nine of ten gone — and the tenth had a different wall behind it:
   *
   *     clock="b3_fastyt-first s1 b3"                    granted=20s   runBeatClipFetch   22s
   *     clock="historical cascade s2b2_research s2 b2"   granted=8s    beatVisualWallMs   23s
   *
   * Three walls compute how long a beat may take, and a YouTube turn can open under any of them.
   * They nest — `fetchSceneVisualsInner` opens the outer one, `runBeatClipFetch` the middle one,
   * the repair passes the third — so widening one and not the others fixes nothing: a child can
   * never outlive its parent.
   *
   * What follows is not three assertions about three numbers. It is ONE claim: a wall that a turn
   * can open under is wide enough to hold one, and there is no fourth that quietly is not. A layer
   * added later has to come past this test, which is the whole point — the defect this file is
   * named for was never a number, it was five readers doing their own arithmetic.
   */
  const withYoutube = <T>(fn: () => T): T => {
    const saved = { ...process.env };
    try {
      process.env.ENABLE_YOUTUBE_SOURCING = "true";
      process.env.YOUTUBE_API_KEY = "test-key-present";
      process.env.YOUTUBE_CC_DL_SERVICE = "https://example.invalid/dl";
      delete process.env.YOUTUBE_ONLY_SOURCING;
      return fn();
    } finally {
      process.env = saved;
    }
  };

  /** The fast/Railway profile, which is the one render 597 ran and the narrowest of them. */
  const FAST_PERF = { fastStockMode: true, beatClipTimeoutMs: 22_000, transformTimeoutMs: 25_000 };

  it("THE DEFECT: the outer wall used to clamp the inner one RONDE 604 had just widened", () => {
    /**
     * 12s search + 6s stock fallback + 5s = 23s, and the inner wall is 58s. A child can never
     * outlive its parent, so the repair could not reach the turn.
     */
    const outerBefore = 12_000 + 6_000 + 5_000;
    expect(outerBefore).toBeLessThan(YOUTUBE_MIN_TURN_MS);
    withYoutube(() => {
      /** Inside the closure: the supplement is deliberately zero when no YouTube is configured. */
      const innerAfter = beatWallWithYoutubeTurn(22_000);
      expect(innerAfter, "RONDE 604 widened the inside of a box").toBeGreaterThan(outerBefore);
    });
  });

  it("ALL THREE now hold a turn, and the nesting stays consistent", () => {
    withYoutube(() => {
      const outer = beatVisualWallMs(FAST_PERF as never);
      const inner = beatWallWithYoutubeTurn(FAST_PERF.beatClipTimeoutMs);

      for (const [name, wall] of [["scene wall", outer], ["beat wall", inner]] as const) {
        expect(affordsYoutubeTurn(wall), `${name} cannot hold a turn`).toBe(true);
        expect(wall, `${name} is under the price the door charges`).toBeGreaterThan(
          YOUTUBE_MIN_TURN_MS
        );
      }
      /** The outer must contain the inner, or the clamp makes the inner number a fiction. */
      expect(outer, "the scene wall clamps the beat wall").toBeGreaterThanOrEqual(inner);
    });
  });

  it("and every one of them reads the SAME helper — no fourth spelling of the sum", () => {
    /**
     * Three call sites, one addition. A wall that computes `+ YOUTUBE_TURN_WINDOW_MS` by hand is
     * the fourth reader this round exists to prevent.
     */
    const uses = [...PIPELINE.matchAll(/beatWallWithYoutubeTurn\(/g)].length;
    expect(uses, "a wall stopped using the helper, or a new one never started").toBeGreaterThanOrEqual(4);
    expect(
      PIPELINE.match(/\+\s*YOUTUBE_TURN_WINDOW_MS/g) ?? [],
      "a wall added the window by hand instead of asking"
    ).toHaveLength(0);
  });

  it("the YouTube-only branch is left alone — it already budgets a turn by name", () => {
    const at = PIPELINE.indexOf("export function beatVisualWallMs(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
    expect(body).toContain("youtubeBeatSearchBudgetMs()");
    /** Paying twice for one turn is the mirror image of the defect being fixed. */
    const onlyBranch = body.slice(body.indexOf("if (youtubeOnlySourcingEnabled())"), body.indexOf("return beatWallWithYoutubeTurn("));
    expect(onlyBranch).not.toContain("beatWallWithYoutubeTurn(");
  });

  it("a build without YouTube keeps every wall exactly as it is today", () => {
    const saved = { ...process.env };
    try {
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.YOUTUBE_ONLY_SOURCING;
      expect(beatVisualWallMs(FAST_PERF as never)).toBe(12_000 + 6_000 + 5_000);
      expect(beatWallWithYoutubeTurn(22_000)).toBe(22_000);
    } finally {
      process.env = saved;
    }
  });
});

/* ═══════════ §6 — ASK THE REAL DOOR, STANDING IN THE REAL NEST ═══════════ */

describe("§6 — the nest render 597 declined in, opened for real", () => {
  /**
   * RONDE 615 — WHY §5 WAS NOT YET PROOF.
   *
   * §5 compares numbers: each wall is wider than the price, and the outer contains the inner. That
   * is true and it is not the same claim. `withSceneFetchTimeout` clamps every child to
   * `min(now + ms, parentDeadline)`, so what the door actually reads is the remainder of the
   * INNERMOST scope after its ancestors have clamped it — a quantity no comparison of the inputs
   * produces. Render 597's whole defect was exactly that gap: every number looked adequate and the
   * clock the door read was 20s.
   *
   * So this section stops describing the nest and builds it — the real `withSceneFetchTimeout`,
   * the real wall functions, the real `canAffordYoutubeTurn` — then asks the real door.
   *
   * ── What it measured ────────────────────────────────────────────────────────────────────────
   *
   *     price (YOUTUBE_MIN_TURN_MS)                24000ms
   *     scene   beatVisualWallMs                   59000ms   granted 58999ms
   *     beat    beatWallWithYoutubeTurn(22s)       58000ms   granted 58000ms
   *     slice   youtubeBeatFetchTimeoutMs(fast)    55000ms   granted 55000ms   DOOR=OPEN
   *
   * Render 597 was granted 20s at that same innermost point. The wall it named is closed; the
   * render that named it ran on a build older than RONDE 604 and 605. That is a CODE-PROVEN
   * result and nothing more — only a render makes it RENDER-PROVEN.
   */
  const withYoutubeEnv = async (fn: () => Promise<void>) => {
    const saved = { ...process.env };
    try {
      process.env.ENABLE_YOUTUBE_SOURCING = "true";
      process.env.YOUTUBE_API_KEY = "test-key-present";
      process.env.YOUTUBE_CC_DL_SERVICE = "https://example.invalid/dl";
      delete process.env.YOUTUBE_ONLY_SOURCING;
      await fn();
    } finally {
      process.env = saved;
    }
  };

  const PERF = { fastStockMode: true, beatClipTimeoutMs: 22_000, transformTimeoutMs: 25_000 };

  it("THE DOOR OPENS at the innermost point of scene -> beat -> youtube-first", async () => {
    await withYoutubeEnv(async () => {
      let verdict: { left: number; ok: boolean } | null = null;
      await withSceneFetchTimeout(
        () =>
          withSceneFetchTimeout(
            () =>
              withSceneFetchTimeout(
                async () => {
                  verdict = { left: remainingScopeMs(), ok: canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS) };
                  return null;
                },
                youtubeBeatFetchTimeoutMs(true),
                "b3_fastyt-first s1 b3"
              ),
            beatWallWithYoutubeTurn(PERF.beatClipTimeoutMs),
            "Scene 1 beat 3 stock"
          ),
        beatVisualWallMs(PERF as never),
        "scene 1 visuals"
      );
      expect(verdict, "the innermost scope never ran").not.toBeNull();
      expect(verdict!.ok, `the door declined with ${verdict!.left}ms left`).toBe(true);
      expect(verdict!.left, "render 597 stood here with 20000ms").toBeGreaterThanOrEqual(
        YOUTUBE_MIN_TURN_MS
      );
    });
  });

  it("THE HARNESS CAN FAIL — one narrow wall anywhere in the nest and the door shuts", async () => {
    /**
     * Without this, the test above proves nothing: a door that never shuts is not a door. The
     * narrow wall is put in the MIDDLE, because a parent clamping a wide child is the exact shape
     * of render 597's defect and the shape a numbers-only comparison cannot see.
     */
    await withYoutubeEnv(async () => {
      let ok: boolean | null = null;
      await withSceneFetchTimeout(
        () =>
          withSceneFetchTimeout(
            () =>
              withSceneFetchTimeout(
                async () => {
                  ok = canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS);
                  return null;
                },
                youtubeBeatFetchTimeoutMs(true),
                "b3_fastyt-first s1 b3"
              ),
            20_000,
            "a wall that has not been widened"
          ),
        beatVisualWallMs(PERF as never),
        "scene 1 visuals"
      );
      expect(ok, "a 20s wall in the middle should have shut the door").toBe(false);
    });
  });

  it("and the historical cascade nest opens too — the other family render 597 declined in", async () => {
    await withYoutubeEnv(async () => {
      let ok: boolean | null = null;
      await withSceneFetchTimeout(
        () =>
          withSceneFetchTimeout(
            async () => {
              ok = canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS);
              return null;
            },
            historicalRescueBudgetMs({ perf: PERF }),
            "historical cascade s2b2_research s2 b2"
          ),
        beatVisualWallMs(PERF as never),
        "scene 2 visuals"
      );
      expect(ok, "the historical cascade was granted 8s in render 597").toBe(true);
    });
  });
});
