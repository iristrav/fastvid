import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// F3-33: testdekking voor de F3-32-audit's belangrijkste bevinding — in de standaardconfiguratie
// (CURATED_ARCHIVE_ONLY ongezet) wordt de F3-28/29/30/31-source-cascade NIET rechtstreeks vanuit
// de primaire per-beat-lus aangeroepen, maar uitsluitend via recoverSceneClipsIfEmpty() als
// scene-niveau top-up wanneer de archive-only pass te weinig clips opleverde. Dit is bevestigd,
// gedocumenteerd gedrag (zie het commentaar boven curatedArchiveOnlyVisuals() in
// server/sourcingPolicy.ts: "that cascade is a fallback for underfilled scenes, not the primary
// per-beat path") — deze tests leggen die architectuur vast zoals hij vandaag al bestaat, ze
// dwingen niets nieuws af.
//
// adoptArchiveBeatClip, recoverSceneClipsIfEmpty en fetchBeatArchivalThenPexels waren
// module-private (geen export) in videoPipeline.ts. Om ze vanuit een apart testbestand te kunnen
// aanroepen/observeren is een visibility-only "export" toegevoegd aan alle drie — nul
// gedragswijziging, exact het patroon dat F3-28/29/30 al gebruikten voor
// fetchNaraClips/fetchEuropeanaVideos/HISTORICAL_SOURCE_TIER_ORDER.
//
// Same-module function calls (recoverSceneClipsIfEmpty calling fetchBeatArchivalThenPexels
// internally) cannot be intercepted by vi.mock/vi.spyOn from outside the module — that's a
// fundamental JS/ESM limitation, not something specific to this file. So Test 3/4 prove the
// bridge behaviorally through the one cross-module dependency both functions actually call
// (fetchCuratedArchiveBeatClip from ./curatedMediaSourcing) and through the resulting real
// network-bound call (via the already-mocked node-fetch) that only the external cascade itself
// would ever make — never by asserting on private call counts/implementation details.
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

import {
  recoverSceneClipsIfEmpty,
  createVisualDedupState,
  type Scene,
  type PipelinePerfProfile,
} from "./videoPipeline";
import { curatedArchiveOnlyVisuals, openverseStillsEnabled } from "./sourcingPolicy";

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

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 0,
    text: "A calm scene about the history of bicycles in the twentieth century.",
    visualCue: "bicycles",
    pexelsQuery: "bicycles",
    aiImagePrompt: "bicycles",
    duration: 20,
    ...overrides,
  };
}

describe("curatedArchiveOnlyVisuals — F3-33 Test 1 (standaard archive-only gedrag)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to true when CURATED_ARCHIVE_ONLY is unset (the documented archive-first default)", () => {
    delete process.env.CURATED_ARCHIVE_ONLY;
    expect(curatedArchiveOnlyVisuals()).toBe(true);
  });

  it("also defaults to true for any value other than the literal string \"false\"", () => {
    process.env.CURATED_ARCHIVE_ONLY = "true";
    expect(curatedArchiveOnlyVisuals()).toBe(true);
    process.env.CURATED_ARCHIVE_ONLY = "1";
    expect(curatedArchiveOnlyVisuals()).toBe(true);
  });
});

// The main per-beat dispatch loop (which of archiveOnly/funnel/pool/resolveBeatClip is taken)
// lives entirely inside the monolithic runVideoPipeline() — invoking it in isolation would
// require a full script/TTS/ffmpeg/DB render (explicitly out of scope: "geen volledige
// codebase-audit", "analyseer alleen de direct relevante code", and it would make real network
// calls that are also explicitly forbidden). So this specific claim ("the archiveOnly branch
// uses adoptArchiveBeatClip and never calls the external cascade directly") is proven
// structurally instead: read the actual, current archiveOnly branch out of the real source file
// (anchored on the two adjacent, semantically-stable branch-boundary strings, not on line
// numbers) and assert its content — a source-level invariant, not a behavioral one, documented
// here as the deliberate trade-off it is.
describe("Main per-beat loop — F3-33 Test 1 (archiveOnly branch uses adoptArchiveBeatClip, not the external cascade directly)", () => {
  it("the archiveOnly branch calls adoptArchiveBeatClip and contains no direct call to any F3-28/29/30/31 external-cascade entry point", () => {
    const source = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const startMarker = "if (archiveOnly) {";
    const endMarker = "} else if (funnelResult && funnelResult.candidates.length > 0) {";
    const startIdx = source.indexOf(startMarker);
    const endIdx = source.indexOf(endMarker, startIdx);
    expect(startIdx, "archiveOnly branch start marker not found — branch structure changed").toBeGreaterThan(-1);
    expect(endIdx, "funnel branch boundary not found after archiveOnly start — branch structure changed").toBeGreaterThan(startIdx);

    const archiveOnlyBranch = source.slice(startIdx, endIdx);
    expect(archiveOnlyBranch).toContain("adoptArchiveBeatClip(");

    const externalCascadeEntryPoints = [
      "fetchBeatArchivalThenPexels(",
      "fetchInternetArchiveClips(",
      "fetchYouTubeCCClips(",
      "fetchWikimediaVideos(",
      "fetchNaraClips(",
      "fetchFlickrCCVideos(",
      "fetchSepiaSearchVideos(",
      "fetchVimeoCCVideos(",
      "fetchMediaCccVideos(",
      "fetchNasaVideoClips(",
      "fetchEuropeanaVideos(",
      "searchWebWideVideoClips(",
    ];
    for (const entryPoint of externalCascadeEntryPoints) {
      expect(archiveOnlyBranch, `unexpected direct call to ${entryPoint} from the archiveOnly branch`).not.toContain(entryPoint);
    }
  });
});

describe("curatedArchiveOnlyVisuals opt-out — F3-33 Test 2 (CURATED_ARCHIVE_ONLY=false)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("curatedArchiveOnlyVisuals() becomes false", () => {
    process.env.CURATED_ARCHIVE_ONLY = "false";
    expect(curatedArchiveOnlyVisuals()).toBe(false);
  });

  // Directly relevant, real branching that flips with the flag (not the whole cascade):
  // openverseStillsEnabled() unconditionally returns false in archive-only mode regardless of
  // its own env var, and only "unlocks" once CURATED_ARCHIVE_ONLY=false.
  it("relevant downstream gate openverseStillsEnabled() flips from forced-off to available", () => {
    delete process.env.ENABLE_OPENVERSE_STILLS;
    process.env.CURATED_ARCHIVE_ONLY = "true";
    expect(openverseStillsEnabled()).toBe(false);

    process.env.CURATED_ARCHIVE_ONLY = "false";
    expect(openverseStillsEnabled()).toBe(true);
  });
});

describe("recoverSceneClipsIfEmpty — F3-33 Test 3/4 (bridge to the F3-28/29/30/31 cascade)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURATED_ARCHIVE_ONLY; // archive-only default
    process.env.VISUAL_MATCHING_V1 = "false"; // skip the unrelated legacy Wikimedia-stills pre-step
    nodeFetchMock.mockReset();
    fetchCuratedArchiveBeatClipMock.mockReset();
    getActiveVideoIdMock.mockReturnValue(undefined);
    isVideoGenerationCancelRequestedMock.mockReturnValue(false);
    // Every external tier fetcher in the cascade eventually calls node-fetch; a generic
    // not-ok response lets each tier fail fast and move to the next one without needing a
    // real, valid response body for every one of the 9 historical tiers.
    nodeFetchMock.mockResolvedValue({ ok: false, status: 404 });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("Test 3 — scene shortage (archive-only pass finds nothing) reaches the external cascade as a top-up via fetchBeatArchivalThenPexels", async () => {
    fetchCuratedArchiveBeatClipMock.mockResolvedValue(null); // own archive: nothing found, ever
    const dedup = createVisualDedupState(makePerf());
    const scene = makeScene({ duration: 20 });

    const result = await recoverSceneClipsIfEmpty(scene, "/tmp", "bicycles documentary", dedup);

    // Minimal, robust proof of "the top-up reached the cascade": Internet Archive is the FIRST
    // tier in HISTORICAL_SOURCE_TIER_ORDER, reached only via
    // recoverSceneClipsIfEmpty -> fetchBeatArchivalThenPexels -> fetchHistoricalBeatVideo ->
    // fetchInternetArchiveClips -> node-fetch(archive.org). recoverSceneClipsIfEmpty's own
    // initial archive-only loop never calls node-fetch at all (it only calls
    // fetchCuratedArchiveBeatClip), so this call can only originate from the top-up bridge.
    const archiveOrgCalls = nodeFetchMock.mock.calls.filter(([url]) => String(url).includes("archive.org"));
    expect(archiveOrgCalls.length).toBeGreaterThan(0);
    // Every mocked tier failed (generic 404), so nothing real was adopted from the cascade
    // itself — recoverSceneClipsIfEmpty's own unrelated last-resort guaranteed-fill safety net
    // (outside F3-28/29/30/31 and outside this test's scope) still fills the scene with local
    // placeholder clips, so `result` isn't asserted on further here — the cascade reach itself
    // (proven above) is this test's only claim.
    void result;
  }, 45_000); // Real ffmpeg work (3 text-overlay fallback encodes, ~3.8s standalone) can exceed
  // the default 5000ms under full-suite CPU contention from other concurrent real-ffmpeg tests —
  // not a functional regression (deterministic, passes reliably standalone); same rationale as
  // the explicit testTimeout bump in videoPipeline.f349HistoricalCascadeDedup.test.ts.
  //
  // Raised from 20s to 45s on MEASURED evidence, not to hide a flake: this test also imports
  // videoPipeline.ts (~40,000 lines), and adding thirty-five lines of PURE COMMENT to that module
  // — no behaviour, no new code path — makes this test time out, reproducibly, while removing them
  // makes it pass. The budget was measuring the module's import cost on top of the ffmpeg work.
  // Nothing else in this test is changed: a real regression in the cascade still fails it.

  it("Test 4 — a sufficiently filled scene (clips.length >= minNeeded after the archive-only pass) never triggers the top-up/cascade", async () => {
    let n = 0;
    fetchCuratedArchiveBeatClipMock.mockImplementation(async () => `/tmp/fake_archive_clip_${n++}.mp4`);
    const dedup = createVisualDedupState(makePerf());
    const scene = makeScene({ duration: 20 });

    const result = await recoverSceneClipsIfEmpty(scene, "/tmp", "bicycles documentary", dedup);

    expect(result.clips.length).toBeGreaterThan(0);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });
});
