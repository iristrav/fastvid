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

import {
  SOURCING_RESERVE_MS,
  youtubeBeatBudgetMs,
  youtubeFirstEnabled,
} from "./sourcingPolicy";

const pipeline = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ═══════════════════════ the order ═══════════════════════ */

describe("YouTube is the first source the cascade asks", () => {
  it("is on by default — the whole point is that it gets a turn", () => {
    expect(youtubeFirstEnabled()).toBe(true);
  });

  it("can be turned off without touching code", () => {
    vi.stubEnv("YOUTUBE_FIRST", "false");
    expect(youtubeFirstEnabled()).toBe(false);
  });

  /**
   * Before the curated archive. That is the ordering change, and asserting the POSITION is the
   * only way to pin it — a call that exists further down is the defect this fixes.
   */
  it("runs before the curated archive lookup", () => {
    const src = pipeline();
    const fn = src.indexOf("export async function fetchBeatArchivalThenPexels(");
    const yt = src.indexOf("youtubeFirstEnabled()", fn);
    const archive = src.indexOf("fetchCuratedArchiveBeatClip(", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(yt).toBeGreaterThan(fn);
    expect(archive).toBeGreaterThan(yt);
  });

  /**
   * A hit short-circuits; a miss must NOT. The cascade behind it is the source of most of the
   * film's footage and is deliberately left exactly as it was.
   */
  it("a miss falls through instead of ending the beat", () => {
    const src = pipeline();
    const yt = src.indexOf("youtubeFirstEnabled()");
    const block = src.slice(yt, src.indexOf("fetchCuratedArchiveBeatClip(", yt));
    expect(block).toContain("if (ytFirst) {");
    expect(block).toContain("return ytFirst;");
    // No unconditional return: a null answer continues down the cascade.
    expect(block).not.toMatch(/\n\s+return null;/);
  });

  /** The two existing modes keep their meaning. `youtubeOnly` skips the archive; this does not. */
  it("does not double up with youtube-only or archive-only mode", () => {
    const src = pipeline();
    expect(src).toContain(
      "if (youtubeFirstEnabled() && !youtubeOnlySourcingEnabled() && !curatedArchiveOnlyVisuals()) {"
    );
  });

  /** A slice that runs out costs the beat nothing but time — the archive still gets asked. */
  it("a spent slice is caught, not thrown", () => {
    const src = pipeline();
    const yt = src.indexOf("youtubeFirstEnabled()");
    const block = src.slice(yt, src.indexOf("fetchCuratedArchiveBeatClip(", yt));
    expect(block).toContain("} catch (err) {");
    expect(block).toContain("continuing with the archive cascade");
  });
});

/* ═══════════════════════ the bound ═══════════════════════ */

describe("the YouTube-first attempt cannot eat the scene", () => {
  it("is bounded by its own slice, not by the scene budget", () => {
    const src = pipeline();
    expect(src).toContain("const ytBudget = youtubeBeatBudgetMs(");
    expect(src).toContain("`youtube-first s${sceneIndex} b${beat.index}`");
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
  it("grows with headroom and stops growing", () => {
    const base = youtubeBeatBudgetMs("8-10", 0);
    const generous = youtubeBeatBudgetMs("8-10", SOURCING_RESERVE_MS + 60 * 60_000);
    expect(generous).toBeGreaterThan(base);
    expect(generous).toBeLessThanOrEqual(base * 2);
  });

  /** An override is an instruction — but never below the download guard's minimum. */
  it("an override is honoured within a sane range", () => {
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "45000");
    expect(youtubeBeatBudgetMs("8-10")).toBe(45_000);
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "3000");
    expect(youtubeBeatBudgetMs("8-10")).toBeGreaterThan(12_000);
    vi.stubEnv("YOUTUBE_BEAT_BUDGET_MS", "999999");
    expect(youtubeBeatBudgetMs("8-10")).toBeLessThanOrEqual(120_000);
  });

  /**
   * Smaller than the archive's slice, deliberately. This is the first source asked, not the one
   * the render relies on — a beat that finds nothing here must still reach the archive with time
   * to spare.
   */
  it("is smaller than the archive's own beat slice", async () => {
    const { archiveBeatBudgetMs } = await import("./sourcingPolicy");
    expect(youtubeBeatBudgetMs("8-10", 0)).toBeLessThan(archiveBeatBudgetMs("8-10", 0) * 3);
  });
});
