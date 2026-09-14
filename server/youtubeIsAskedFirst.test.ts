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
import {
  buildDownloadShortlist,
  hoistBudgetSensitiveDownload,
  type FunnelCandidate,
  type FunnelCandidateSource,
} from "./retrievalFunnel";

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

/** The one line inside it that decides whether YouTube gets a turn at all. */
const guard = (): string => {
  const body = slice();
  const at = body.indexOf("if (!youtubeFirstEnabled()");
  expect(at, "the YouTube-first guard is gone").toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("\n", at));
};

/** Every place a beat can ask for its YouTube slice. */
const callSites = (): number =>
  (pipeline().match(/(?<!async function )youtubeFirstBeatSlice\(/g) ?? []).length;

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
    const yt = src.indexOf("youtubeFirstBeatSlice(", fn);
    const archive = src.indexOf("fetchCuratedArchiveBeatClip(", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(yt).toBeGreaterThan(fn);
    expect(archive).toBeGreaterThan(yt);
  });

  /**
   * RONDE 234 — THE OTHER ROUTE. `beatPrimaryFetchInner` opens with its own
   * `if (curatedArchiveOnlyVisuals())` branch whose every exit is a `return`, so with that flag at
   * its default it never reached the cascade — and RONDE 233's repaired guard sat in the cascade.
   * Fixing one guard left the turn absent on this path entirely.
   */
  it("also runs before the archive on beatPrimaryFetch's own curated branch", () => {
    const src = pipeline();
    const fn = src.indexOf("async function beatPrimaryFetchInner(");
    expect(fn).toBeGreaterThan(-1);
    const curated = src.indexOf("if (curatedArchiveOnlyVisuals()) {", fn);
    const yt = src.indexOf("youtubeFirstBeatSlice(", fn);
    const archive = src.indexOf("fetchCuratedArchiveBeatClipWithLineage(", fn);
    expect(yt, "the curated branch asks YouTube").toBeGreaterThan(curated);
    expect(archive, "and it asks before the archive, not after").toBeGreaterThan(yt);
  });

  /**
   * TWO CALL SITES, AND THEY ARE MUTUALLY EXCLUSIVE. The curated branch returns before reaching
   * the cascade, so no beat can spend two 45-second slices on the same query. A third call site
   * would break that argument, which is why the count is asserted and not just the presence.
   */
  it("is asked once per beat, never twice", () => {
    expect(callSites()).toBe(2);
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

  /** `youtubeOnly` asks YouTube and then Pexels, skipping the archive — a turn before the cascade
   * would be a turn before itself. It is the one mode this still stands down for. */
  it("does not double up with youtube-only mode", () => {
    // Inverted as an early return, so the mode that skips the archive reads as a stand-down.
    expect(guard()).toMatch(/\|\|\s*youtubeOnlySourcingEnabled\(\)/);
    expect(guard()).toContain("return null;");
  });

  /**
   * RONDE 233 — THE TURN THAT WAS CONFIGURED, DOCUMENTED, TESTED, AND UNREACHABLE.
   *
   * This guard also carried `&& !curatedArchiveOnlyVisuals()`, and that flag defaults to ON, so the
   * whole block stood down in the default configuration. Not rarely — never. Everything written
   * above about a bounded slice and a turn before the cascade described code that did not run, and
   * this test file asserted the dead condition verbatim, which is how it stayed dead.
   *
   * Render 582 is the receipt: YOUTUBE_FIRST on, proxy live, and ZERO occurrences of either of the
   * two lines the block cannot run without emitting. Scene 2's first YouTube search lands at
   * 17:55:02 with 11 seconds against a 12-second floor — 48 attempts refused before they began.
   *
   * Removing it is not a loosening. CURATED_ARCHIVE_ONLY means the archive is the source of RECORD,
   * not that nothing may be asked before it: past the slice this returns null and the cascade runs
   * in its original order, archive first, and the clip YouTube returns passed the same adoption
   * guard and the same picture editor as every other route's.
   */
  it("no longer stands down for CURATED_ARCHIVE_ONLY", () => {
    expect(guard()).not.toContain("curatedArchiveOnlyVisuals");
  });

  /** Which is what made the old condition dead rather than merely narrow. */
  it("and that flag really is on unless it is switched off", () => {
    expect(
      fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8")
    ).toContain('return process.env.CURATED_ARCHIVE_ONLY !== "false";');
  });

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
    expect(src, "the success says so").toContain("YouTube answered first");
    expect(src, "and so does the spent slice").toContain("YouTube-first slice spent");
  });
});

/* ═══════════════════ the route the render actually takes ═══════════════════ */

/**
 * THE CASCADE WAS NOT THE ROUTE.
 *
 * The block above orders `fetchBeatArchivalThenPexels`, and the production render never entered
 * it. Tracing the refusal backwards settles it: the `0s left in the scene budget` line lives in
 * `downloadYouTubeCCClip`, whose non-rehydration caller is `downloadAndTrimPoolCandidate`, called
 * by `downloadFunnelCandidate` — the RETRIEVAL FUNNEL, in `fetchSceneVisualsInner`. Every clip in
 * that render is named `scene_N_bM_curated_a<id>.mp4`, which only `prepareCuratedArchiveClip`
 * produces, and the strings `no archive/wiki match` and `external cascade` appear zero times in
 * five thousand lines of log.
 *
 * `fetchBeatArchivalThenPexels` has two call sites. The funnel branch is the one that runs. This
 * is the recurring seam in this codebase — a rule several routes must remember, remembered by one —
 * and it is why these tests pin the funnel route by name and not only the cascade.
 */
const candidate = (
  id: string,
  source: FunnelCandidateSource,
  rankingScore: number
): FunnelCandidate => ({
  id,
  source,
  title: `${source} ${id}`,
  thumbnailUrl: null,
  mediaType: "video",
  embeddingSimilarity: null,
  archiveKeywordScore: null,
  clipSimilarity: null,
  rankingScore,
  // Anything that is not the operator's own archive carries a poolCandidate; only its presence
  // matters here, and the subject screen reads these fields.
  ...(source === "archive"
    ? {}
    : { poolCandidate: { id, source, assetId: id, title: `${source} ${id}` } as never }),
});

describe("the funnel asks YouTube while the beat can still answer", () => {
  it("hoists the YouTube candidate to the front of the download order", () => {
    const shortlist = [
      candidate("a1", "archive", 9),
      candidate("a2", "archive", 8),
      candidate("p1", "pexels", 7),
      candidate("y1", "youtube_cc", 6),
    ];
    const ordered = hoistBudgetSensitiveDownload(shortlist);
    expect(ordered[0].id).toBe("y1");
  });

  /**
   * The downloads run in batches of three, so the front of the list is the only place a transfer
   * is attempted before the beat's own work has drained the scope it inherits.
   */
  it("puts it inside the first batch of three, not merely earlier", () => {
    const shortlist = [
      ...["a1", "a2", "a3"].map((id) => candidate(id, "archive", 9)),
      candidate("w1", "wikimedia", 5),
      candidate("y1", "youtube_cc", 4),
      candidate("p1", "pexels", 3),
    ];
    const ordered = hoistBudgetSensitiveDownload(shortlist);
    expect(ordered.slice(0, 3).map((c) => c.source)).toContain("youtube_cc");
  });

  /** Membership is `buildDownloadShortlist`'s decision. This changes order only. */
  it("drops nothing and duplicates nothing", () => {
    const shortlist = [
      candidate("a1", "archive", 9),
      candidate("y1", "youtube_cc", 6),
      candidate("p1", "pexels", 3),
    ];
    const ordered = hoistBudgetSensitiveDownload(shortlist);
    expect(ordered).toHaveLength(shortlist.length);
    expect(new Set(ordered.map((c) => c.id))).toEqual(new Set(shortlist.map((c) => c.id)));
  });

  /**
   * ONE candidate, and every other keeps its exact relative order. Hoisting the whole source
   * would invert the ranking and hand the beat to the slowest provider in the cascade — the defect
   * on the other side of this one.
   */
  it("moves one candidate and leaves the rest in their ranking order", () => {
    const shortlist = [
      candidate("a1", "archive", 9),
      candidate("y1", "youtube_cc", 8),
      candidate("p1", "pexels", 7),
      candidate("y2", "youtube_cc", 6),
    ];
    const ordered = hoistBudgetSensitiveDownload(shortlist);
    expect(ordered.map((c) => c.id)).toEqual(["y1", "a1", "p1", "y2"]);
  });

  /** The highest-ranked one, since the shortlist arrives sorted by score. */
  it("hoists the best YouTube candidate, not the last one", () => {
    const shortlist = [
      candidate("a1", "archive", 9),
      candidate("y_best", "youtube_cc", 8),
      candidate("y_worse", "youtube_cc", 2),
    ];
    expect(hoistBudgetSensitiveDownload(shortlist)[0].id).toBe("y_best");
  });

  it("is a no-op when YouTube is absent or already first", () => {
    const noYt = [candidate("a1", "archive", 9), candidate("p1", "pexels", 7)];
    expect(hoistBudgetSensitiveDownload(noYt).map((c) => c.id)).toEqual(["a1", "p1"]);
    const ytFirst = [candidate("y1", "youtube_cc", 9), candidate("a1", "archive", 7)];
    expect(hoistBudgetSensitiveDownload(ytFirst).map((c) => c.id)).toEqual(["y1", "a1"]);
  });

  it("does not mutate the shortlist it was given", () => {
    const shortlist = [
      candidate("a1", "archive", 9),
      candidate("y1", "youtube_cc", 6),
    ];
    hoistBudgetSensitiveDownload(shortlist);
    expect(shortlist.map((c) => c.id)).toEqual(["a1", "y1"]);
  });

  /** An empty beat must not throw on the way to its fallback. */
  it("survives an empty shortlist", () => {
    expect(hoistBudgetSensitiveDownload([])).toEqual([]);
  });
});

describe("the funnel's download loop uses that order", () => {
  it("orders the batches, and honours the same flag as the cascade", () => {
    const src = pipeline();
    const at = src.indexOf("const FUNNEL_DOWNLOAD_CONCURRENCY = 3;");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 2200);
    expect(block).toContain("youtubeFirstEnabled()");
    expect(block).toContain("hoistBudgetSensitiveDownload(subjectScreened)");
    // The loop must iterate the ORDERED list — slicing `subjectScreened` would compute an order
    // and then ignore it, which is the whole defect in a different shape.
    expect(block).toContain("dlIdx < downloadOrder.length");
    expect(block).toContain("downloadOrder.slice(dlIdx, dlIdx + FUNNEL_DOWNLOAD_CONCURRENCY)");
    expect(block).not.toContain("subjectScreened.slice(dlIdx");
  });

  /**
   * The ordering runs AFTER the subject screen, so a candidate the screen refused can never be
   * hoisted into a download — being first in line is not a way past a gate.
   */
  it("orders what survived the subject screen, not the raw shortlist", () => {
    const src = pipeline();
    const screened = src.indexOf("const subjectScreened: FunnelCandidate[] = [];");
    const hoist = src.indexOf("hoistBudgetSensitiveDownload(subjectScreened)");
    expect(screened).toBeGreaterThan(-1);
    expect(hoist).toBeGreaterThan(screened);
  });

  /** And the shortlist that feeds it is still built by the untouched budget/cap rules. */
  it("does not change who is in the shortlist", () => {
    const shortlist = buildDownloadShortlist(
      [
        candidate("a1", "archive", 9),
        candidate("y1", "youtube_cc", 6),
        candidate("p1", "pexels", 3),
      ],
      6
    );
    expect(shortlist.map((c) => c.id).sort()).toEqual(["a1", "p1", "y1"]);
    expect(hoistBudgetSensitiveDownload(shortlist)).toHaveLength(shortlist.length);
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
