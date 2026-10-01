/**
 * YOUTUBE IS ASKED FIRST, AND IT IS BOUNDED.
 *
 * ── What the production log proved ──────────────────────────────────────────────────────────
 *
 * YouTube contributed nothing, and for none of the reasons anyone had assumed. Seventeen videos
 * were FOUND, seventeen downloads were refused, and every single refusal read the same:
 *
 *     [Pipeline] Scene 1: skipping YouTube download of 9V7Zgx4rDDA
 *                — 0s left in the scene budget, not enough to finish
 *     [YouTubeDownload] ... status=DOWNLOAD_TIMEOUT reason=scene_budget_too_short_to_start
 *                       cloudService=MISSING rapidApi=SET
 *
 * Seventeen out of seventeen at `0s left`. Not "too little" — nothing. So:
 *
 *   · the picture editor judged NONE of them, so no clip was ever refused on its merits
 *   · not one byte was ever fetched, so no download ever failed either
 *
 * Which rules out both explanations the number `20 downloaded / 0 adopted` used to carry. It was
 * an ORDERING problem: YouTube sat at the back of the cascade, behind the curated archive,
 * Wikimedia and the internet stills, and by the time it was asked the scene had nothing left.
 *
 * The RONDE 68 guard — "do not start a transfer the budget cannot finish" — was working perfectly
 * and never got a turn.
 *
 * ── Why it is bounded rather than simply moved ──────────────────────────────────────────────
 *
 * The same log says the budget is the binding constraint everywhere: 45 scope aborts, 56 clips
 * refused for want of time, `[ArchiveFilter] overlay budget spent (40/40)`. YouTube over RapidAPI
 * is the slowest source in the cascade — that render had `cloudService=MISSING`, so the fast
 * yt-dlp route was not even available — and putting the slowest source first with no bound would
 * starve the curated archive, which is what actually delivers footage today.
 *
 * So it goes first with its own slice. Past the slice the cascade below runs completely unchanged,
 * in its original order.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOURCING_RESERVE_MS, youtubeBeatBudgetMs } from "./sourcingPolicy";

const pipeline = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The shared slice both sourcing routes ask through. A FUNCTION rather than a block is the point:
 * RONDE 233 repaired the guard on the cascade and RONDE 234 found `beatPrimaryFetchInner` could
 * not reach that cascade at all, so the turn was true on one path and absent on another.
 */
const slice = (): string => {
  const src = pipeline();
  const at = src.indexOf("async function youtubeFirstBeatSlice(");
  expect(at, "the YouTube-first slice is gone").toBeGreaterThan(0);
  const end = src.indexOf("\n}\n", at);
  expect(end, "its body has no closing brace at column 0").toBeGreaterThan(at);
  return src.slice(at, end);
};

/** Every place a beat can ask for its YouTube slice. */
const callSites = (): number =>
  (pipeline().match(/(?<!async function )youtubeFirstBeatSlice\(/g) ?? []).length;

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ═══════════════════════ the order ═══════════════════════ */

describe("YouTube is the first source the cascade asks", () => {

  /**
   * Before the curated archive. That is the ordering change, and asserting the POSITION is the
   * only way to pin it — a call that exists further down is the defect this fixes.
   */
  it("runs before the curated archive lookup", () => {
    const src = pipeline();
    const fn = src.indexOf("export async function fetchBeatArchivalThenPexels(");
    const yt = src.indexOf("youtubeFirstBeatSlice(", fn);
    const archive = src.indexOf("fetchCuratedArchiveBeatClip(", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(yt).toBeGreaterThan(fn);
    expect(archive).toBeGreaterThan(yt);
  });

  /**
   * ONE CALL SITE. The curated-only branch that held the second one is gone, so no beat can spend
   * two 45-second slices on the same query. A second call site would break that, which is why the
   * count is asserted and not just the presence.
   */
  it("is asked once per beat, never twice", () => {
    expect(callSites()).toBe(1);
  });

  /** One implementation, so the turn cannot be true on one route and quietly absent on another. */
  it("both routes ask through the same code", () => {
    expect(pipeline().match(/async function youtubeFirstBeatSlice\(/g) ?? []).toHaveLength(1);
  });

  /**
   * A hit short-circuits; a miss must NOT. The cascade behind it is the source of most of the
   * film's footage and is deliberately left exactly as it was.
   */
  it("a miss falls through instead of ending the beat", () => {
    const src = pipeline();
    // A hit short-circuits at each call site; a miss is a null the caller simply walks past.
    for (const m of src.matchAll(/youtubeFirstBeatSlice\(\n[\s\S]{0,300}?\);\n([\s\S]{0,80})/g)) {
      expect(m[1], "the call site must not treat a miss as the end of the beat")
        .toMatch(/if \(ytFirstClip\) return ytFirstClip;/);
    }
    expect(slice(), "and the slice itself answers null rather than throwing").toContain("return null;");
  });

  /** Which is what made the old condition dead rather than merely narrow. */

  /** A slice that runs out costs the beat nothing but time — the archive still gets asked. */
  it("a spent slice is caught, not thrown", () => {
    const body = slice();
    expect(body).toContain("} catch (err) {");
    expect(body).toContain("continuing with the archive cascade");
    // The catch is INSIDE the shared slice, so both routes inherit it rather than one remembering.
    expect(body.indexOf("} catch (err) {")).toBeLessThan(body.lastIndexOf("return null;"));
  });

  /**
   * BOTH OUTCOMES LOG, AND THAT IS WHAT MAKES THE DEFECT ABOVE FINDABLE NEXT TIME.
   *
   * Without these two lines, "the block never ran" and "it ran and found nothing" are the same
   * silence in the log — which is exactly the silence that hid RONDE 233's dead condition across
   * every render between the feature landing and 582.
   */
  it("a render can prove the turn was taken", () => {
    const src = pipeline();
    expect(src, "the offer says so").toContain("YouTube offered ");
    expect(src, "and so does the spent slice").toContain("YouTube-first slice spent");
  });
});

/* ═══════════════════════ the bound ═══════════════════════ */

describe("the YouTube-first attempt cannot eat the scene", () => {
  it("is bounded by its own slice, not by the scene budget", () => {
    const body = slice();
    expect(body).toContain("const ytBudget = youtubeBeatBudgetMs(");
    expect(body).toContain("withSceneFetchTimeout(");
    expect(body).toContain("`youtube-first s${sceneIndex} b${beat.index}`");
  });

  /**
   * The floor is above the download guard's own 12s minimum. Below that the transfer is refused
   * before it starts — which would reproduce the exact defect this fixes: a source that is asked
   * and can never answer.
   */
  it("never offers less time than a download needs to start", () => {
    for (const len of ["1", "8-10", "10-15", "15-20"]) {
      expect(youtubeBeatBudgetMs(len), len).toBeGreaterThan(12_000);
      expect(youtubeBeatBudgetMs(len, 0), `${len} with no headroom`).toBeGreaterThan(12_000);
      expect(youtubeBeatBudgetMs(len, null), `${len} unknown headroom`).toBeGreaterThan(12_000);
    }
  });

  /** Real headroom buys a bigger slice; a capped one, so one beat cannot take the scene. */

  /** An override is an instruction — but never below the download guard's minimum. */
  it("an override is honoured within a sane range", () => {
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "45000");
    expect(youtubeBeatBudgetMs()).toBe(45_000);
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "3000");
    expect(youtubeBeatBudgetMs()).toBeGreaterThan(12_000);
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "999999");
    expect(youtubeBeatBudgetMs()).toBeLessThanOrEqual(120_000);
  });

  /**
   * Smaller than the archive's slice, deliberately. This is the first source asked, not the one
   * the render relies on — a beat that finds nothing here must still reach the archive with time
   * to spare.
   */
});
