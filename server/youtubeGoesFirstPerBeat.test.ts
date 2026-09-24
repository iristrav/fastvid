/**
 * RONDE 648 — YOUTUBE FIRST, PER BEAT, LIVE.
 *
 * The operator's order (2026-09-24): no scene-wide search of every provider at once; each beat
 * searches YouTube itself, downloads and uses what it finds, for up to two minutes; only then the
 * own archive, the open sources and stock, one tier at a time. Three beats at a time.
 *
 * Render 605 measured why: its scene pools abandoned their YouTube downloads at a 45 s cap, while
 * the per-beat turn — given 22 s on the 1-minute Railway profile — still adopted five live shots.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  YOUTUBE_FIRST_BEAT_WORST_MS,
  YOUTUBE_FIRST_PARALLEL_BEATS,
  YOUTUBE_FIRST_TURN_MS,
  sceneCandidatePoolEnabled,
  youtubeBeatBudgetMs,
  youtubeFirstPerBeatEnabled,
} from "./sourcingPolicy";
import {
  applyYoutubeFirstPerf,
  beatVisualWallMs,
  getPipelinePerfProfile,
  sceneRetrieveParallelism,
  sceneVisualFlatMs,
  youtubeBeatFetchTimeoutMs,
} from "./videoPipeline";

const KEYS = [
  "SOURCING_YOUTUBE_FIRST",
  "ENABLE_SCENE_CANDIDATE_POOL",
  "YOUTUBE_BEAT_BUDGET_MS",
  "ENABLE_YOUTUBE_SOURCING",
  "YOUTUBE_API_KEY",
  "YOUTUBE_CC_DL_SERVICE",
];
/** A build that CAN ask YouTube: search key and downloader configured. Nothing is contacted. */
const withYoutube = () => {
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
  process.env.YOUTUBE_API_KEY = "test-key";
  process.env.YOUTUBE_CC_DL_SERVICE = "http://127.0.0.1:9";
};
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the switch", () => {
  it("is on by default, and SOURCING_YOUTUBE_FIRST=false turns it off", () => {
    expect(youtubeFirstPerBeatEnabled()).toBe(true);
    process.env.SOURCING_YOUTUBE_FIRST = "false";
    expect(youtubeFirstPerBeatEnabled()).toBe(false);
  });

  it("no scene asks every provider at once — not even when the old pool flag says yes", () => {
    expect(sceneCandidatePoolEnabled()).toBe(false);
    process.env.ENABLE_SCENE_CANDIDATE_POOL = "true";
    expect(sceneCandidatePoolEnabled()).toBe(false);
  });

  it("with the switch off, the pool route is exactly what it was", () => {
    process.env.SOURCING_YOUTUBE_FIRST = "false";
    expect(sceneCandidatePoolEnabled()).toBe(true);
    process.env.ENABLE_SCENE_CANDIDATE_POOL = "false";
    expect(sceneCandidatePoolEnabled()).toBe(false);
  });
});

describe("two minutes of YouTube per beat, and nothing above it ends them early", () => {
  const oneMinute = getPipelinePerfProfile("1");
  beforeEach(withYoutube);

  it("the YouTube slice is two minutes; an explicit override still wins", () => {
    expect(YOUTUBE_FIRST_TURN_MS).toBe(120_000);
    expect(youtubeBeatBudgetMs("1")).toBe(120_000);
    process.env.YOUTUBE_BEAT_BUDGET_MS = "45000";
    expect(youtubeBeatBudgetMs("1")).toBe(45_000);
  });

  it("the YouTube turn's own window is at least two minutes, fast profile included", () => {
    expect(youtubeBeatFetchTimeoutMs(true)).toBeGreaterThanOrEqual(YOUTUBE_FIRST_TURN_MS);
    expect(youtubeBeatFetchTimeoutMs(false)).toBeGreaterThanOrEqual(YOUTUBE_FIRST_TURN_MS);
  });

  it("the beat's wall holds the turn and the fallback after it", () => {
    expect(beatVisualWallMs(oneMinute)).toBeGreaterThanOrEqual(YOUTUBE_FIRST_BEAT_WORST_MS);
  });

  it("a scene's share fits six beats run one after another — render 605's scene 1 had six", () => {
    expect(sceneVisualFlatMs(oneMinute)).toBeGreaterThanOrEqual(6 * YOUTUBE_FIRST_BEAT_WORST_MS);
  });

  it("three beats search at the same time", () => {
    expect(YOUTUBE_FIRST_PARALLEL_BEATS).toBe(3);
    expect(sceneRetrieveParallelism(oneMinute)).toBe(3);
  });

  it("the render runs with those numbers: its own profile copy carries them", () => {
    const perf = applyYoutubeFirstPerf(oneMinute);
    expect(perf.sceneParallelism).toBe(3);
    expect(perf.sceneVisualTimeoutMs).toBe(sceneVisualFlatMs(oneMinute));
    const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(SRC).toContain("const perf = applyYoutubeFirstPerf(getPipelinePerfProfile(videoLength));");
  });

  it("a build that cannot ask YouTube keeps every wall exactly as it was", () => {
    delete process.env.YOUTUBE_API_KEY;
    const p = getPipelinePerfProfile("1");
    expect(sceneVisualFlatMs(p)).toBe(p.sceneVisualTimeoutMs);
    expect(beatVisualWallMs(p)).toBeLessThan(YOUTUBE_FIRST_BEAT_WORST_MS);
  });

  it("with the switch off, every one of those numbers is the profile's own", () => {
    process.env.SOURCING_YOUTUBE_FIRST = "false";
    const p = getPipelinePerfProfile("1");
    expect(sceneVisualFlatMs(p)).toBe(p.sceneVisualTimeoutMs);
    expect(sceneRetrieveParallelism(p)).toBe(p.sceneParallelism);
    expect(beatVisualWallMs(p)).toBeLessThan(YOUTUBE_FIRST_BEAT_WORST_MS);
  });
});

describe("the order on the route the 1-minute Railway profile takes", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const start = SRC.indexOf("async function resolveBeatClipFastTurbo(");
  const body = SRC.slice(start, SRC.indexOf("\n}\n", start));

  it("YouTube is asked before the stills, and the stills come after the archive", () => {
    // In YouTube-first mode the stills-first opening is skipped...
    expect(body).toContain("if (!youtubeFirst) {\n    clip = await fetchBeatInternetStillsFirst(");
    // ...so the first provider work is beatPrimaryFetch, which opens with the YouTube-first slice...
    const primary = body.indexOf("() => beatPrimaryFetch(");
    const stillsAfter = body.indexOf("const stills = await fetchBeatInternetStillsFirst(");
    expect(primary).toBeGreaterThan(-1);
    expect(stillsAfter).toBeGreaterThan(primary);
    const archival = SRC.slice(SRC.indexOf("export async function fetchBeatArchivalThenPexels("));
    const slice = archival.indexOf("const ytFirstClip = await youtubeFirstBeatSlice(");
    const ownArchive = archival.indexOf("fetchCuratedArchiveBeatClipWithLineage(");
    expect(slice).toBeGreaterThan(-1);
    expect(ownArchive).toBeGreaterThan(slice);
  });

  it("the scene-wide retrieval and its TTS prefetch both hang off the switch that is now off", () => {
    expect(SRC).toContain("if (sceneCandidatePoolEnabled() && !curatedArchiveOnlyVisuals()) {");
    expect(SRC).toContain("if (!archiveOnly && sceneCandidatePoolEnabled()) {");
  });
});
