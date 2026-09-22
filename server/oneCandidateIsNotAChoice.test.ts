/**
 * ONE CANDIDATE IS NOT A CHOICE — RONDE 618.
 *
 * ── Two halves of one design, disagreeing ───────────────────────────────────────────────────
 *
 * `youtubeMaxDownloadsPerRender()` is 60, and its own note says that at the measured rates it
 * "yields roughly 10-27 — enough for YouTube to be a real supplier rather than a garnish".
 *
 * It could not. The one production call to the provider was handed `req.maxPerQuery ?? 1`, and
 * `maxPerQuery` is a declared field that no route sets — so it was 1, everywhere, always. One turn
 * per beat is enforced separately by `claimYoutubeTurn`. A fourteen-beat film therefore topped out
 * at FOURTEEN downloads: the ceiling of 60 was unreachable by construction, and reaching even the
 * bottom of "10-27" would have required ten of those fourteen to survive REAL_FUNNEL, the
 * strictest adoption route there is.
 *
 * Render 597 is that arithmetic at its floor — one search, one download, nothing adopted.
 *
 * ── What changed ────────────────────────────────────────────────────────────────────────────
 *
 * One value: a turn brings back two candidates instead of one. No budget is raised — 60 per render
 * is the authorisation that already existed and does not move; it is now reachable instead of
 * theoretical. No wall is widened either: the second transfer's cost was measured against the
 * scope that already exists.
 *
 * ── What did NOT change, and why each one matters ───────────────────────────────────────────
 *
 *   the door's price      still one search plus one download floor. Charging for two transfers
 *                         would decline turns that can comfortably afford one.
 *   the render ceiling    still 60, still checked inside the download loop
 *   every adoption gate   a second candidate is a second thing for the editor to look at, judged
 *                         by the same gates at the same thresholds
 *
 * ── On evidence ─────────────────────────────────────────────────────────────────────────────
 *
 * No provider is called here and nothing is mocked. What is asserted is arithmetic over the real
 * constants, the real wall functions, and the guards that are actually in the loop. Whether two
 * candidates raise the number of ADOPTED clips is a render question, and this file does not claim
 * to answer it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  YOUTUBE_CANDIDATES_PER_TURN,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_SEARCH_TIMEOUT_MS,
  beatVisualWallMs,
  beatWallWithYoutubeTurn,
  youtubeBeatFetchTimeoutMs,
} from "./videoPipeline";
import { youtubeMaxDownloadsPerRender } from "./sourcingPolicy";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The download floor, which is what a second transfer costs. */
const DOWNLOAD_FLOOR_MS = YOUTUBE_MIN_TURN_MS - YOUTUBE_SEARCH_TIMEOUT_MS;

/** Render 597's shape: fourteen beats, one turn each. */
const BEATS = 14;

/* ═══════════ §1 — the contradiction, in its own numbers ═══════════ */

describe("§1 — a ceiling that could not be reached", () => {
  it("THE DEFECT: one candidate per turn cannot fill a ceiling of sixty", () => {
    const reachableWithOne = 1 * BEATS;
    expect(reachableWithOne).toBeLessThan(youtubeMaxDownloadsPerRender());
    /** And the documented expectation is not merely unmet — it is arithmetically impossible. */
    expect(reachableWithOne, "ten adopted clips out of fourteen downloads").toBeLessThan(20);
  });

  it("the ceiling still says what it said — this round did not touch it", () => {
    expect(youtubeMaxDownloadsPerRender()).toBe(60);
  });

  it("and two candidates stay well inside it", () => {
    expect(YOUTUBE_CANDIDATES_PER_TURN * BEATS).toBeLessThan(youtubeMaxDownloadsPerRender());
  });
});

/* ═══════════ §2 — the one value that changed ═══════════ */

describe("§2 — what a turn brings back", () => {
  it("A TURN RETURNS TWO CANDIDATES, NOT ONE", () => {
    expect(YOUTUBE_CANDIDATES_PER_TURN).toBe(2);
  });

  it("the single production call to the provider reads it", () => {
    expect(SRC).toContain("req.maxPerQuery ?? YOUTUBE_CANDIDATES_PER_TURN,");
    expect(SRC, "the old literal survived somewhere").not.toContain("req.maxPerQuery ?? 1,");
  });

  it("and it is still the ONE call — a second one would need its own accounting", () => {
    expect(SRC).toContain("/** THE ONE PRODUCTION CALL TO THE PROVIDER.");
    const calls = [...SRC.matchAll(/await fetchYouTubeCCClips\(/g)].length;
    expect(calls, "a second call site appeared").toBe(1);
  });
});

/* ═══════════ §3 — THE TIME WAS THERE ALREADY, WHICH HAD TO BE CHECKED ═══════════ */

describe("§3 — a second transfer fits the scope that exists", () => {
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

  it("ONE SEARCH PLUS TWO TRANSFERS FITS, so no wall had to move", () => {
    const needed = YOUTUBE_SEARCH_TIMEOUT_MS + 2 * DOWNLOAD_FLOOR_MS;
    withYoutube(() => {
      /** The narrowest scope of the nest a turn opens under — see RONDE 615 §6. */
      const slice = youtubeBeatFetchTimeoutMs(true);
      const beat = beatWallWithYoutubeTurn(22_000);
      const scene = beatVisualWallMs({
        fastStockMode: true,
        beatClipTimeoutMs: 22_000,
        transformTimeoutMs: 25_000,
      } as never);
      for (const [name, wall] of [["slice", slice], ["beat", beat], ["scene", scene]] as const) {
        expect(wall, `${name} cannot hold one search and two transfers`).toBeGreaterThanOrEqual(
          needed
        );
      }
    });
  });

  it("THE DOOR'S PRICE IS UNCHANGED — it still charges for one transfer, not two", () => {
    /**
     * Deliberate. Charging two would decline turns that can comfortably afford one, which is
     * render 586's failure inverted: a requirement that cannot be met empties the film.
     */
    expect(YOUTUBE_MIN_TURN_MS).toBe(YOUTUBE_SEARCH_TIMEOUT_MS + DOWNLOAD_FLOOR_MS);
    expect(YOUTUBE_MIN_TURN_MS).toBeLessThan(
      YOUTUBE_SEARCH_TIMEOUT_MS + 2 * DOWNLOAD_FLOOR_MS
    );
  });
});

/* ═══════════ §4 — the second transfer cannot overrun ═══════════ */

describe("§4 — what makes a second candidate safe", () => {
  /** The guards are per ITEM, so the second download is re-checked, not assumed. */
  const loopBody = () => {
    const at = SRC.indexOf("for (const row of ordered.slice(0, 5)) {");
    expect(at, "the download loop moved").toBeGreaterThan(-1);
    return SRC.slice(at, at + 600);
  };

  it("EVERY CANDIDATE IS RE-CHECKED AGAINST THE CLOCK", () => {
    expect(loopBody()).toContain("if (Date.now() > ytDeadline) break;");
  });

  it("and against the render-wide ceiling, which is what bounds a long film", () => {
    /** Two per beat over many beats would otherwise pass 60; the ceiling still binds. */
    expect(loopBody()).toContain("if (downloadsSoFar() >= maxDownloadAttempts) {");
  });

  it("the count itself is checked per candidate, so two is a maximum and not a quota", () => {
    expect(loopBody()).toContain("if (fetched >= count) break;");
  });

  it("CANDIDATE TWO IS THE SECOND-BEST ROW, not the next one the API returned", () => {
    /** RONDE 602 ranks before any download slot is spent; it reorders and never refuses. */
    const at = SRC.indexOf("const ordered = await youtubeRowsRankedByThumbnail(");
    const loopAt = SRC.indexOf("for (const row of ordered.slice(0, 5)) {");
    expect(at).toBeGreaterThan(-1);
    expect(at, "the ranking must happen before the loop that spends slots").toBeLessThan(loopAt);
  });
});

/* ═══════════ §5 — nothing was let in ═══════════ */

describe("§5 — a candidate is not an adoption", () => {
  it("the strictest adoption route is unchanged — YouTube still needs an explicit yes", () => {
    const policy = readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8");
    expect(policy).toContain("  youtube_cc: REAL_FUNNEL(),");
    expect(policy).toContain('visionRequirement: "approved",');
  });

  it("and one turn per beat still means ONE — this round did not add turns", () => {
    expect(SRC).toContain("export function claimYoutubeTurn(");
    expect(SRC).toContain("return { granted: false, record: existing };");
  });
});
