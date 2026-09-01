import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// F3-36: runtime-measured PER-SCENE Europeana record-fetch ceiling, through
// recoverSceneClipsIfEmpty()'s existing top-up loop (up to 7 fallbackTexts iterations, each
// potentially invoking fetchBeatArchivalThenPexels -> fetchEuropeanaVideos). F3-35 already
// proved the PER-CALL ceiling (one fetchEuropeanaVideos invocation: max 18 record-fetches, 3
// queries x 6 rows). The F3-32 audit (§8) flagged that this per-call figure does not bound the
// PER-SCENE total, since recoverSceneClipsIfEmpty can reach that call up to 7x for one
// under-filled scene. This file measures the real number, empirically, rather than assuming
// 7 x 18 = 126 — see the measured result and the query-count explanation below.
//
// Reuses, unmodified: recoverSceneClipsIfEmpty (exported in F3-33), the dedup/scene/perf test
// fixtures and mocking conventions from videoPipeline.f333ArchiveOnlyBridge.test.ts, and the
// Europeana "no rights, 6 items per query" mock from videoPipeline.f335CreditCallCeiling.test.ts.
// No production code touched; no new exports.
//
// server/videoPipeline.ts reads EUROPEANA_API_KEY into a module-level constant at import time
// (`const EUROPEANA_API_KEY = process.env.EUROPEANA_API_KEY || ""`), so — same requirement as
// videoPipeline.f330EuropeanaRealVideo.test.ts and f335CreditCallCeiling.test.ts — process.env
// must be set BEFORE the module is (re-)imported: vi.resetModules() + dynamic import() per
// test, not a top-level static import (which is what F3-33's own test file uses, since it never
// needed EUROPEANA_API_KEY to be "present").
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

const fetchCuratedArchiveBeatClipMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("./curatedMediaSourcing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./curatedMediaSourcing")>();
  return {
    ...actual,
    fetchCuratedArchiveBeatClip: (...args: unknown[]) => fetchCuratedArchiveBeatClipMock(...args),
  };
});

const getActiveVideoIdMock = vi.fn<() => number | undefined>(() => undefined);
const isVideoGenerationCancelRequestedMock = vi.fn<(id: number) => boolean>(() => false);
vi.mock("./videoGenerationCancel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./videoGenerationCancel")>();
  return {
    ...actual,
    getActiveVideoId: () => getActiveVideoIdMock(),
    isVideoGenerationCancelRequested: (id: number) => isVideoGenerationCancelRequestedMock(id),
  };
});

// Keeps fetchBeatArchivalThenPexels' webWideQueries deterministic (no DB call, no extra
// primed query prepended) — same mock target F3-27's own test file uses for this exact helper.
const getVisualSearchMemoryForEntityMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
vi.mock("./visualSearchMemory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./visualSearchMemory")>();
  return {
    ...actual,
    getVisualSearchMemoryForEntity: (...args: unknown[]) => getVisualSearchMemoryForEntityMock(...args),
  };
});

import type { Scene, PipelinePerfProfile } from "./videoPipeline";

/**
 * RONDE 90 — this file calls provider fetchers directly, outside any beat.
 *
 * In production every provider search runs inside a beat's provenance scope
 * (withSearchProvenance), and that scope is what lets the gate verify a query against what the
 * script actually says. A direct call has no such scope, so strict mode refuses it — correctly,
 * and by design: a query nobody can trace is exactly what RONDE 90 exists to stop.
 *
 * That refusal is not what this file is about. Its subject is what happens AFTER a query is
 * admitted — the render-scoped query cache, the per-item licence gates, the dedup skips, the call
 * ceilings. The gate's own behaviour, including the refusal above, is covered by
 * ronde89ProviderGate and ronde90SearchProvenance; restating it in every assertion here would
 * test the gate twice and these mechanics not at all.
 */
// Set at module scope, not in beforeAll: several suites here snapshot `process.env` into an
// ORIGINAL_ENV constant while the file is being evaluated and restore it before every test, so a
// value written later is wiped again before the first assertion runs.
process.env.SEARCH_GATE_STRICT = "false";


async function loadRecoverSceneClipsIfEmpty() {
  vi.resetModules();
  const mod = await import("./videoPipeline");
  return { recoverSceneClipsIfEmpty: mod.recoverSceneClipsIfEmpty, createVisualDedupState: mod.createVisualDedupState };
}

function makePerf(overrides: Partial<PipelinePerfProfile> = {}): PipelinePerfProfile {
  return {
    targetWallClockMin: 90,
    maxBeatsPerScene: 5,
    maxTopicQueries: 3,
    skipFairUseTransform: true,
    transformTimeoutMs: 40_000,
    enableArchival: true,
    enableNasa: true,
    enableMuskHeroFetch: false,
    maxEntityYoutubePerVideo: 0,
    enableAiFallback: false,
    maxAiClipsPerVideo: 0,
    sceneParallelism: 1,
    pexelsDownloadRetries: 1,
    maxStockQueriesPerBeat: 3,
    beatClipTimeoutMs: 120_000,
    sceneVisualTimeoutMs: 10 * 60_000,
    fastStockMode: false,
    scriptOnlyVisuals: false,
    minimizeStockFootage: false,
    maxStockBeatsPerVideo: 999,
    ...overrides,
  };
}

// Long, non-historical, generic text so all 7 of recoverSceneClipsIfEmpty's fallbackTexts
// entries (including scene.text.slice(120,180)) are non-empty and >=3 chars — the top-up loop
// only tries as many iterations as fallbackTexts actually has non-empty entries for.
const LONG_SCENE_TEXT =
  "A calm documentary scene describing everyday city life, traffic, architecture, and public " +
  "transport in a modern metropolitan area during the early afternoon on a clear autumn day.";

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 0,
    text: LONG_SCENE_TEXT,
    visualCue: "city street traffic",
    pexelsQuery: "city street traffic",
    aiImagePrompt: "city street traffic",
    duration: 20,
    ...overrides,
  };
}

// Every Europeana search page returns 6 items with a valid video URL but no edmRights — every
// one fails the F3-30 license gate, forcing the record-fetch loop to check all 6 (the actual
// worst-case path the ceiling describes) before the query loop moves on.
function noRightsSearchResponse(queryTag: string) {
  return {
    ok: true,
    json: async () => ({
      items: Array.from({ length: 6 }, (_, i) => ({ id: `/${queryTag}/item${i}`, title: [`clip ${i}`] })),
    }),
  };
}

function noRightsRecordResponse() {
  return {
    ok: true,
    json: async () => ({
      object: { aggregations: [{ edmIsShownBy: "https://example.com/clip.mp4" }] }, // no edmRights
    }),
  };
}

describe("recoverSceneClipsIfEmpty — F3-36 (runtime-measured per-scene Europeana record-fetch ceiling)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURATED_ARCHIVE_ONLY; // archive-only default (matches F3-33's Test 3)
    process.env.VISUAL_MATCHING_V1 = "false"; // skip the unrelated legacy Wikimedia-stills pre-step
    process.env.EUROPEANA_API_KEY = "test-key";
    process.env.ENABLE_EUROPEANA = "true";
    nodeFetchMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockResolvedValue(null); // own archive: nothing found, ever
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
    getVisualSearchMemoryForEntityMock.mockReset();
    getVisualSearchMemoryForEntityMock.mockResolvedValue([]);

    let europeanaQueryCounter = 0;
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.europeana.eu/record/v2/search.json")) {
        const tag = `q${europeanaQueryCounter++}`;
        return Promise.resolve(noRightsSearchResponse(tag));
      }
      if (u.includes("api.europeana.eu/record/v2/")) {
        return Promise.resolve(noRightsRecordResponse());
      }
      // Every other source (Internet Archive, YouTube CC, Wikimedia, NARA, Flickr, SepiaSearch,
      // Vimeo, media.ccc, NASA, Openverse) fails immediately — proven safe by the existing
      // F3-28/29/30 tests for each of these adapters individually; here they only need to fail
      // fast and cleanly so the cascade always falls through to Europeana on every attempt.
      return Promise.resolve({ ok: false, status: 404 });
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("measures the actual maximum Europeana record-fetch calls across the full top-up loop for one under-filled scene", async () => {
    const { recoverSceneClipsIfEmpty, createVisualDedupState } = await loadRecoverSceneClipsIfEmpty();
    const dedup = createVisualDedupState(makePerf());
    const scene = makeScene({ duration: 20 });

    const result = await recoverSceneClipsIfEmpty(scene, "/tmp", "city documentary", dedup);
    void result; // only the call counts below are asserted — see F3-33 Test 3 for why

    const searchCalls = nodeFetchMock.mock.calls.filter(([u]) =>
      String(u).includes("api.europeana.eu/record/v2/search.json")
    );
    const recordCalls = nodeFetchMock.mock.calls.filter(
      ([u]) => String(u).includes("api.europeana.eu/record/v2/") && !String(u).includes("search.json")
    );

    // eslint-disable-next-line no-console
    console.log(
      `[F3-36] measured: ${searchCalls.length} Europeana search calls, ${recordCalls.length} Europeana record-fetch calls ` +
        `across the full recoverSceneClipsIfEmpty top-up loop.`
    );

    // F3-35 proved the per-call ceiling is 3 queries x 6 rows = 18. fetchBeatArchivalThenPexels
    // itself only ever passes fetchEuropeanaVideos a query list built as
    // primeQueriesWithSearchMemory(videoTitle, buildHistoricalArchivalQueries(intent, beat.text).slice(0, 2))
    // (server/videoPipeline.ts ~1748-1750) — capped to 2 queries BEFORE fetchEuropeanaVideos'
    // own 3-query cap ever applies (with no search-memory hit, per this test's mock). So the
    // real per-call ceiling reached via this specific recover-fallback path is at most
    // 2 queries x 6 rows = 12, not the full 18. The top-up loop runs at most
    // fallbackTexts.length (7) iterations, and this scene's fallbackTexts are all non-empty
    // (see LONG_SCENE_TEXT), so all 7 iterations are genuinely reached. Measured, not assumed:
    // 7 x 2 = 14 search calls, 7 x 12 = 84 record-fetch calls — exactly matching the
    // theoretical worst case for THIS path (7 x 18 = 126 does not occur in practice, because
    // the query cap here is 2, not Europeana's own standalone 3-query cap).
    expect(searchCalls.length).toBe(14);
    expect(recordCalls.length).toBe(84);
  }, 60_000);
});
