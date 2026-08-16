import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// F3-49: fetchHistoricalBeatVideo's full HISTORICAL_SOURCE_TIER_ORDER cascade (Internet Archive,
// YouTube CC, Wikimedia, NARA, Flickr, SepiaSearch, Vimeo, media.ccc, NASA — up to 27 external
// search/metadata/license/download attempts) used to be able to run twice for the exact same
// beat: once from the primary path (fetchBeatArchivalThenPexels) and again from the rescue path
// (fetchHistoricalBeatRescue), with near-identical queries built from the same beat.text /
// beat.searchQuery, and nothing remembered that the first attempt already missed. This mirrors
// the already-fixed strictRefillAttemptedScenes problem (VisualDedupState) one level down, at
// beat instead of scene granularity.
//
// This test proves the new historicalCascadeAttemptedBeats guard makes a 2nd call for the exact
// same scene/beat a true no-op (zero external calls), that a different beat still gets a
// completely normal first attempt, and that the guard is set before the cascade's first external
// call — so it can't be left unset by a mid-cascade error, but also can't fire for a beat whose
// cascade never actually started.
//
// videoPipeline.ts imports `fetch` from "node-fetch" — every tier's search call goes through
// that single import, so counting node-fetch invocations is a reliable proxy for "how many times
// did the archival cascade actually reach out externally". Every mocked response is a deliberate
// HTTP 500 (or, in one test, a rejection) so every tier misses — existing, unmodified behavior in
// every fetch* function already treats that as "no results, continue"; this test adds no new
// provider logic of its own.
//
// Each `it()` below does its own vi.resetModules() + fresh dynamic import specifically because
// Internet Archive has its own pre-existing, out-of-scope cooldown breaker
// (internetArchiveFailureStreak/-CooldownUntilMs, module-level state): without a fresh module per
// test, failed searches in one test could trip that breaker and make a later test's tier attempt
// silently short-circuit for a reason unrelated to the new guard being verified here.
// Each real (mocked-miss) cascade run still pays every tier's real timeout/retry/semaphore
// plumbing even though the HTTP call itself resolves instantly, so the default 5s test timeout
// isn't enough once a test runs more than one real cascade.
vi.setConfig({ testTimeout: 30_000 });

let fetchCallCount = 0;
let rejectInsteadOfMiss = false;

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  const mockFetch = vi.fn(async () => {
    fetchCallCount++;
    if (rejectInsteadOfMiss) throw new Error("simulated network failure");
    return new actual.Response("", { status: 500 });
  });
  return { ...actual, default: mockFetch };
});

function makeBeat(index: number, text: string) {
  return {
    index,
    text,
    searchQuery: text,
    powerWord: "",
    keywords: [] as string[],
    holdSec: 4,
  };
}

function makeScene(index: number, text: string) {
  return {
    index,
    text,
    visualCue: "",
    pexelsQuery: text,
    aiImagePrompt: "",
    duration: 10,
  };
}

describe("F3-49 historical archival cascade — beat-level dedup guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f349-test-"));
    fetchCallCount = 0;
    rejectInsteadOfMiss = false;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not re-run the cascade for the same beat, but still runs it for a different beat", async () => {
    // Two real (mocked-miss) cascades in this test — each tier's real timeout/retry plumbing
    // adds up past the 5s default, even though every HTTP call itself resolves instantly.
    const { fetchHistoricalBeatVideo, createVisualDedupState, getPipelinePerfProfile } =
      await import("./videoPipeline");
    const { buildMediaSearchIntent } = await import("./mediaResearchEngine");

    const dedup = createVisualDedupState(getPipelinePerfProfile("8-10"));
    const scene = makeScene(0, "A documentary scene about the 1969 moon landing");
    const beatA = makeBeat(0, "Apollo 11 astronauts on the launch pad");
    const beatB = makeBeat(1, "Mission control celebrates the landing");
    const intentFor = (beat: ReturnType<typeof makeBeat>) =>
      buildMediaSearchIntent({
        beatText: beat.text,
        searchQueries: [beat.searchQuery],
        keywords: [],
        primaryPerson: "",
        persons: [],
        videoTitle: "Apollo 11",
        powerWord: "",
        personTopicLock: false,
        spaceTopic: false,
        muskTopic: false,
      });

    // 1) First attempt for beat A: cascade actually runs and reaches out externally.
    const first = await fetchHistoricalBeatVideo(
      beatA, scene, dir, scene.index, 4, dedup, intentFor(beatA), {}, "test"
    );
    expect(first).toBeNull(); // every tier deliberately misses (mocked HTTP 500s)
    const callsAfterFirst = fetchCallCount;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(dedup.historicalCascadeAttemptedBeats.has(`s${scene.index}b${beatA.index}`)).toBe(true);

    // 2) Second attempt for the EXACT same scene/beat: guard short-circuits, zero new calls.
    const second = await fetchHistoricalBeatVideo(
      beatA, scene, dir, scene.index, 4, dedup, intentFor(beatA), {}, "test"
    );
    expect(second).toBeNull();
    expect(fetchCallCount).toBe(callsAfterFirst); // no new external calls at all

    // 3) A DIFFERENT beat in the same scene still gets a completely normal first attempt.
    const third = await fetchHistoricalBeatVideo(
      beatB, scene, dir, scene.index, 4, dedup, intentFor(beatB), {}, "test"
    );
    expect(third).toBeNull();
    expect(fetchCallCount).toBeGreaterThan(callsAfterFirst); // beat B made its own real attempt
    expect(dedup.historicalCascadeAttemptedBeats.has(`s${scene.index}b${beatB.index}`)).toBe(true);
  });

  it("marks the beat as attempted even when an external call inside the cascade throws", async () => {
    rejectInsteadOfMiss = true;
    const { fetchHistoricalBeatVideo, createVisualDedupState, getPipelinePerfProfile } =
      await import("./videoPipeline");
    const { buildMediaSearchIntent } = await import("./mediaResearchEngine");

    const dedup = createVisualDedupState(getPipelinePerfProfile("8-10"));
    const scene = makeScene(0, "A documentary scene");
    const beat = makeBeat(0, "A hard-to-find archival moment");
    const intent = buildMediaSearchIntent({
      beatText: beat.text,
      searchQueries: [beat.searchQuery],
      keywords: [],
      primaryPerson: "",
      persons: [],
      videoTitle: "Test",
      powerWord: "",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });

    // Whether the existing per-tier try/catch inside e.g. fetchInternetArchiveClips absorbs the
    // rejection (its existing, unmodified behavior) or something propagates, the NEW guard must
    // already be set: it's written synchronously before the cascade's first external call, so it
    // does not depend on how the cascade ends.
    try {
      await fetchHistoricalBeatVideo(beat, scene, dir, scene.index, 4, dedup, intent, {}, "test");
    } catch {
      /* either outcome is acceptable for this assertion */
    }
    expect(fetchCallCount).toBeGreaterThan(0); // the cascade did actually start
    expect(dedup.historicalCascadeAttemptedBeats.has(`s${scene.index}b${beat.index}`)).toBe(true);
  });

  it("never marks a beat whose cascade was never invoked (guard is scoped, not global)", async () => {
    const { fetchHistoricalBeatVideo, createVisualDedupState, getPipelinePerfProfile } =
      await import("./videoPipeline");
    const { buildMediaSearchIntent } = await import("./mediaResearchEngine");

    const dedup = createVisualDedupState(getPipelinePerfProfile("8-10"));
    const scene = makeScene(0, "A documentary scene");
    const beat = makeBeat(0, "Only this beat is fetched");
    const untouchedBeat = makeBeat(1, "This beat is never passed to the function");
    const intent = buildMediaSearchIntent({
      beatText: beat.text,
      searchQueries: [beat.searchQuery],
      keywords: [],
      primaryPerson: "",
      persons: [],
      videoTitle: "Test",
      powerWord: "",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });

    await fetchHistoricalBeatVideo(beat, scene, dir, scene.index, 4, dedup, intent, {}, "test");

    expect(dedup.historicalCascadeAttemptedBeats.has(`s${scene.index}b${beat.index}`)).toBe(true);
    expect(
      dedup.historicalCascadeAttemptedBeats.has(`s${scene.index}b${untouchedBeat.index}`)
    ).toBe(false);
  });
});
