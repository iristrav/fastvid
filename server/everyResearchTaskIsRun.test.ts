import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * A TASK THAT IS BUILT MUST BE RUN.
 *
 * ── What was happening ──────────────────────────────────────────────────────────────────────
 *
 * The per-beat research round queues its sources into two arrays and then executes
 * `[...ytTasks, ...tasks].slice(0, maxTasks)`. That spread COPIES both arrays at the moment it
 * runs — and it ran two hundred lines above the last `tasks.push(...)`.
 *
 * So nine sources were constructed for every beat of every scene and never called: Europeana,
 * NASA, Wikimedia images, Openverse, Unsplash, SerpAPI, Pexels (two routes) and Pixabay (two
 * routes). Not refused, not budgeted away, not logged — built and dropped.
 *
 * ── Why it could not have been a budget ─────────────────────────────────────────────────────
 *
 * `maxTasks` is 10, 14 or 18 depending on mode, and the copied list held at most about nine. The
 * slice never bound anything. A ceiling of eighteen over a list that cannot reach ten was written
 * for the list WITH the tail in it.
 *
 * And it was there from the first day: the commit that introduced the line (60dc4f7, 17 Aug,
 * "limited cross-provider pooling") already had ten pushes below it. Nothing drifted.
 *
 * ── Why a test and not just a moved line ────────────────────────────────────────────────────
 *
 * Because the defect is invisible by construction. Nothing throws, nothing is logged, and the
 * funnel shows the sources contributing nothing — which reads like "these providers return
 * nothing useful" rather than "these providers were never asked". The ordering is the whole
 * contract, so the ordering is what is asserted: every push, then the copy, then the run.
 *
 * These providers are NOT idle elsewhere — each has between two and seven other call sites. What
 * was missing is their part in the round that looks for material for the sentence a shot will
 * play under.
 */

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
/** Comments stripped: this file's own prose quotes the line it is about. */
const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SNAPSHOT = "const allResearchTasks = [...ytTasks, ...tasks];";
const RUN = "allResearchTasks.slice(0, maxTasks)";

describe("the research round runs every task it builds", () => {
  it("the list is still copied once and run once", () => {
    expect(code.split(SNAPSHOT).length - 1, "the snapshot was duplicated or removed").toBe(1);
    expect(code.split(RUN).length - 1, "the run site was duplicated or removed").toBe(1);
  });

  it("NO TASK IS QUEUED AFTER THE LIST IS COPIED", () => {
    /**
     * The assertion the defect would have failed. A push below this line goes into an array
     * nothing reads again, and the source it carries is never called.
     */
    const snapshot = code.indexOf(SNAPSHOT);
    const run = code.indexOf(RUN);
    expect(snapshot, "the snapshot is gone").toBeGreaterThan(-1);
    expect(run, "the run site is gone").toBeGreaterThan(snapshot);

    const between = code.slice(snapshot + SNAPSHOT.length, run);
    expect(between).not.toMatch(/\btasks\.push\(/);
    expect(between).not.toMatch(/\bytTasks\.push\(/);
  });

  it("AND THE TASKS THAT USED TO BE DROPPED ARE ABOVE IT", () => {
    /**
     * Named one by one rather than counted, so a source that falls back below the copy is caught
     * by name instead of by a total that a second push elsewhere could restore.
     */
    const snapshot = code.indexOf(SNAPSHOT);
    const head = code.slice(0, snapshot);
    for (const fetcher of [
      "fetchEuropeanaVideos",
      "fetchNasaVideoClips",
      "fetchWikimediaImages",
      "fetchOpenverseImages",
      "fetchUnsplashImages",
      "fetchSerpAPIImages",
      "fetchPexelsClips",
      "fetchPixabayClips",
    ]) {
      expect(head, `${fetcher} is queued after the copy again — it will never run`).toContain(
        `await ${fetcher}(`
      );
    }
  });

  it("YOUTUBE IS STILL FIRST — the slice favours the front of the list", () => {
    /**
     * `[...ytTasks, ...tasks]`, in that order, and the run takes the first `maxTasks`. The YouTube
     * route is the primary one; putting the tail in front of it would be a different change and a
     * worse one.
     */
    expect(code).toContain("[...ytTasks, ...tasks]");
  });

  it("the ceiling was not raised to make room for them", () => {
    /**
     * It never bound anything before, and it binds now — which is its job. Raising it as part of
     * this would hide what the change actually costs.
     */
    expect(code).toContain("const maxTasks = archivalFirst");
    expect(code).toContain("? (perf.fastStockMode ? 14 : 18)");
    expect(code).toContain(": (perf.fastStockMode ? 10 : 18);");
  });
});
