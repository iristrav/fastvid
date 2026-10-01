/**
 * RONDE 134 — the corrected question reaches a provider, and it carries the scene's evidence.
 *
 * ── What RONDE 133 measured, and why this round exists ───────────────────────────────────────
 *
 * RONDE 132 wired a research pass: a refusal the gate blames on the QUESTION makes the beat ask a
 * different one. RONDE 133 then measured how far that reaches and found the ceiling:
 *
 *     WRONG_PERIOD fires on 2 of 10 realistic beats
 *
 * because a period correction needs a year, years are read from the BEAT's own words, and a
 * documentary states its period once per scene and then relies on it. The scene's text was
 * already admissible evidence to the SearchGate — `validateSearchQuery` proves a content word
 * against `ctx.evidence`, and `beatSearchProvenance` builds that from beat text PLUS scene text —
 * so nothing was forbidden. Nothing was building queries from it either.
 *
 * ── What is proved here ──────────────────────────────────────────────────────────────────────
 *
 *   1-9    the scene widens the research context, and every widened query still passes the gate.
 *   10-14  material faults now get a correction too, without changing the subject.
 *   15-19  the invariant: a "correction" that says nothing new is not sent.
 *   20-22  budget.
 *   23-27  entity integrity, international names, negative cases.
 *   28-30  THE WIRING: a corrected query reaching a real outbound provider request.
 *   M1-M8  mutations.
 *
 * Test 28 is the one that matters most. Everything else could be true of a research pass that
 * never causes a search; 28 mocks the transport and reads the URL that leaves the process.
 */
/**
 * Provider keys are captured into module-level consts when videoPipeline is imported, so they
 * have to exist BEFORE the import — `vi.hoisted` runs ahead of the hoisted imports. These are
 * placeholders against a mocked transport; no request reaches a real service.
 */
vi.hoisted(() => {
  process.env.YOUTUBE_API_KEY = "r134-test-key-not-a-credential";
  /** Video 619: RapidAPI is switched off, so the download route that makes YouTube searchable is the service. */
  process.env.YOUTUBE_CC_DL_SERVICE = "http://ytdl.test.invalid";
  // The YouTube tier is opt-in by flag (sourcingPolicy.youtubeSourcingEnabled). Production has
  // it on — video 546 retrieved 25 YouTube candidates — so the wiring test runs with it on too.
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
});

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fetchModule from "node-fetch";

import {
  buildResearchContext,
  correctionStrategyFor,
  decideResearch,
  formatResearchContext,
  queryImprovesOn,
  selectCorrectedQueries,
  RESEARCH_ESTIMATED_COST_MS,
} from "./mismatchResearch";
import { classifyMismatch, mismatchFault } from "./visualMismatchFeedback";
import { buildPrioritisedQueries, validateSearchQuery, type VerifiedQueryContext } from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat, createVisualDedupState, getPipelinePerfProfile } from "./videoPipeline";
import { buildMediaSearchIntent } from "./mediaResearchEngine";
import { resetYoutubeSearchQuotaState } from "./youtubeSearchQuota";
import { searchGateStrict } from "./config";

const mockedFetch = vi.mocked(fetchModule);

/** The scene under audit, in the shape a real script produces. */
const SCENE_TEXT =
  "In April 1945 Hermann Göring left Berlin for the south. " +
  "He had commanded the Luftwaffe since 1935. " +
  "Adolf Hitler had already turned against him.";

const ctxFor = (beatText: string): VerifiedQueryContext =>
  buildVerifiedQueryContextForBeat(beatText, { sceneText: SCENE_TEXT });

const researchCtxFor = (beatText: string): VerifiedQueryContext =>
  buildResearchContext({ beat: ctxFor(beatText), scene: ctxFor(SCENE_TEXT) });

/**
 * The real factories, not hand-made stubs.
 *
 * The wiring tests drive `fetchHistoricalBeatVideo`, which reads a dozen fields off the perf
 * profile and the search intent. A stub that happens to satisfy the type is not evidence about
 * production: the first version of these tests used one and the cascade threw on a field it
 * never set, which reads exactly like "the provider was not called".
 */
const RESEARCH_BEAT = {
  index: 0,
  text: "The decision was his alone.",
  holdSec: 4,
  keywords: [] as string[],
  powerWord: "",
  searchQuery: "Hermann Göring Berlin",
};
const RESEARCH_SCENE = { index: 0, text: SCENE_TEXT, visualCue: "", pexelsQuery: "" };
const VIDEO_TITLE = "The real reason Hermann Göring joined Hitler";

const researchDedup = (videoId: number) =>
  createVisualDedupState(getPipelinePerfProfile("5min"), {
    primaryPerson: "Hermann Göring",
    personTopicLock: false,
    videoId,
  });

const researchIntent = () =>
  buildMediaSearchIntent({
    beatText: RESEARCH_BEAT.text,
    searchQueries: [RESEARCH_BEAT.searchQuery],
    keywords: [],
    primaryPerson: "Hermann Göring",
    persons: ["Hermann Göring"],
    videoTitle: VIDEO_TITLE,
    powerWord: "",
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: false,
  });

describe("RONDE 134 — entity integrity survives the widening", () => {

  it("27. the SearchGate is still strict", () => {
    expect(process.env.SEARCH_GATE_STRICT).not.toBe("false");
    expect(searchGateStrict()).toBe(true);
  });
});

describe("RONDE 134 — mutation guards", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const MOD = readFileSync(join(__dirname, "mismatchResearch.ts"), "utf8");

  it("M5. leadQueries lead inside the existing cap", () => {
    const idx = PIPE.indexOf("const allQueries = uniqueQueryStrings([...(opts.leadQueries ?? [])");
    expect(idx).toBeGreaterThan(0);
    expect(PIPE.slice(idx, idx + 260)).toContain("queryCap");
  });

  it("M8. the existing cache and dedup are what the pass uses", () => {
    const idx = PIPE.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    const block = PIPE.slice(idx, idx + 2000);
    expect(block).toContain("dedup.sourcingCache");
    expect(block).toContain("dedup.usedContentKeys");
  });
});
