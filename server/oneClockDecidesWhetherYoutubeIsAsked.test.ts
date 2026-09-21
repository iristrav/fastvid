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
  canAffordYoutubeTurn,
  beatWallWithYoutubeTurn,
  youtubeBeatWallSupplementMs,
  withSceneFetchTimeout,
  remainingScopeMs,
  remainingNonYoutubeScopeMs,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_TURN_WINDOW_MS,
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
