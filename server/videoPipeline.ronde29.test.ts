import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { isOffTopicProtestForBeat } from "./visualBeatTags";
import {
  DEFAULT_TARGET_MOVING_SHARE,
  MIN_MIX_SAMPLE,
  movingShareDeficit,
  resolveTargetMovingShare,
  summarizeMovingShare,
} from "./visualMixPolicy";
import { mergeCandidates, type FunnelCandidate } from "./retrievalFunnel";
import type { PoolCandidate } from "./scenePool";
import {
  createGateFiringStats,
  findSilentGates,
  formatGateFiringSummary,
  getActiveGateFiringStats,
  recordGateVerdict,
  runWithGateFiringStats,
  SILENT_GATE_MIN_ASKED,
  summarizeGateFiring,
} from "./gateFiringStats";

// RONDE 29 — the three items left open by the "bestaat, draait niet" audit:
//
//   1. the protest filter was wired into ONE route (the curated archive) and its
//      videoVisualTopic parameter was read by nobody, so a historical script could never
//      trigger it — the direct cause of a white-lives-matter clip in a Führerbunker film;
//   2. visualMixPolicy.ts had zero callers while a duplicate, weaker mechanism (RONDE 27's flat
//      moving-footage bonus) shipped without knowing it existed;
//   3. nothing counted how often a gate actually SAID NO, which is the one measurement that
//      would have caught the modern-mismatch bug (152 calls, 0 rejects, healthy logs, flag on).

describe("RONDE 29a — the protest filter covers historical topics", () => {
  const nonProtestBeat = "In the final days, Hitler retreated to the bunker beneath the Reich Chancellery.";
  const protestHay = "white lives matter protest march demonstrators";

  it("rejects modern protest footage in a WWII documentary — the case that shipped", () => {
    // Every geo/urban branch below is false for this beat, so before RONDE 29 this returned
    // false and the clip was adopted.
    expect(isOffTopicProtestForBeat(nonProtestBeat, protestHay, "wwii")).toBe(true);
  });

  it("rejects it for cold war topics too", () => {
    expect(isOffTopicProtestForBeat(nonProtestBeat, protestHay, "cold_war")).toBe(true);
  });

  it("keeps period material whose own metadata names the era", () => {
    // A Nuremberg rally described as a demonstration, or a 1953 uprising reel, is exactly the
    // footage a historical film wants. Rejecting it would trade one wrong clip for another.
    expect(
      isOffTopicProtestForBeat(nonProtestBeat, "1934 nazi party rally demonstration newsreel", "wwii")
    ).toBe(false);
    expect(
      isOffTopicProtestForBeat(nonProtestBeat, "bundesarchiv demonstration berlin", "wwii")
    ).toBe(false);
  });

  it("keeps protest footage when the narration is actually about protests", () => {
    expect(
      isOffTopicProtestForBeat("Crowds gathered in protest outside the Reichstag.", protestHay, "wwii")
    ).toBe(false);
  });

  it("ignores candidates that are not protest footage at all", () => {
    expect(isOffTopicProtestForBeat(nonProtestBeat, "aerial view of berlin ruins 1945", "wwii")).toBe(false);
  });

  it("leaves the pre-existing geo/urban behaviour exactly as it was", () => {
    // The rule added in RONDE 29 is keyed on the historical topics only — a "general" topic
    // still falls through to the beat-type branches, and still fires on a geo beat.
    expect(isOffTopicProtestForBeat("Amsterdam has more bikes than people.", protestHay, "general")).toBe(true);
    expect(isOffTopicProtestForBeat("She opened the letter slowly.", protestHay, "general")).toBe(false);
  });

  it("defaults to the general topic when no topic is passed", () => {
    expect(isOffTopicProtestForBeat("She opened the letter slowly.", protestHay)).toBe(false);
  });

  it("is wired into the universal vision gate, not just the archive path", () => {
    // The whole point of RONDE 29a: assetPassesBeatMinimum only ever sees curated-archive
    // assets. beatClipPassesVisionGate is the function every rescue/adoption route funnels
    // through, which is why the hook belongs there.
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const gateBody = src.slice(
      src.indexOf("async function beatClipPassesVisionGate("),
      src.indexOf("async function loadArchiveCandidatePool(")
    );
    expect(gateBody).toContain("beatClipIsOffTopicProtest");
    expect(gateBody).toContain("off_topic_protest");
  });

  it("judges the candidate's own provider text, never the search query", () => {
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const fn = src.slice(
      src.indexOf("function beatClipIsOffTopicProtest("),
      src.indexOf("async function beatClipPassesVisionGate(")
    );
    expect(fn).toContain("providerText");
    // No provider text = no evidence = leave the candidate alone.
    expect(fn).toContain("if (!hay.trim()) return false;");
  });
});

describe("RONDE 29b — the moving-footage target the ranking leans on", () => {
  afterEach(() => {
    delete process.env.TARGET_MOVING_SHARE;
    delete process.env.MOVING_FOOTAGE_BONUS;
  });

  it("reports no deficit before there is enough of a sample to judge", () => {
    // One still out of one clip is a 100% shortfall on paper and means nothing in practice.
    expect(movingShareDeficit(0, 1, 0.45)).toBe(0);
    expect(movingShareDeficit(0, MIN_MIX_SAMPLE - 1, 0.45)).toBe(0);
  });

  it("reports no deficit once the target is met or beaten", () => {
    expect(movingShareDeficit(5, 10, 0.45)).toBe(0);
    expect(movingShareDeficit(9, 10, 0.45)).toBe(0);
  });

  it("scales from 0 to 1 as the render drifts toward all stills", () => {
    expect(movingShareDeficit(0, 10, 0.5)).toBe(1);
    expect(movingShareDeficit(2, 10, 0.5)).toBeCloseTo(0.6, 5);
    expect(movingShareDeficit(4, 10, 0.5)).toBeCloseTo(0.2, 5);
  });

  it("reads the target from env and refuses nonsense values", () => {
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
    process.env.TARGET_MOVING_SHARE = "0.7";
    expect(resolveTargetMovingShare()).toBe(0.7);
    process.env.TARGET_MOVING_SHARE = "not a number";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
    process.env.TARGET_MOVING_SHARE = "4";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
  });

  it("summarises the mix for the quality report", () => {
    expect(summarizeMovingShare(7, 11)).toBe("7/18 moving (39%), 11 still");
    expect(summarizeMovingShare(0, 0)).toBe("no clips adopted");
  });

  it("ranks a video candidate higher when the render is behind on moving footage", () => {
    const neutral = mergeCandidates([], [], [poolVideo()], 1, 1, 10, 0);
    const behind = mergeCandidates([], [], [poolVideo()], 1, 1, 10, 1);
    expect(behind[0].rankingScore).toBeGreaterThan(neutral[0].rankingScore);
    // Bounded: at most one extra base bonus (0.08), which is under a single source-tier step.
    expect(behind[0].rankingScore - neutral[0].rankingScore).toBeCloseTo(0.08, 5);
  });

  it("leaves still candidates untouched no matter how large the deficit", () => {
    const neutral = mergeCandidates([], [], [poolImage()], 1, 1, 10, 0);
    const behind = mergeCandidates([], [], [poolImage()], 1, 1, 10, 1);
    expect(behind[0].rankingScore).toBe(neutral[0].rankingScore);
  });

  it("behaves exactly as RONDE 27 did when no deficit is supplied", () => {
    // The parameter defaults to 0, so every caller that does not track the mix — including the
    // TTS-time prefetch, where no clip has been adopted yet — is unaffected.
    const explicitZero = mergeCandidates([], [], [poolVideo()], 1, 1, 10, 0);
    const omitted = mergeCandidates([], [], [poolVideo()], 1, 1, 10);
    expect(omitted[0].rankingScore).toBe(explicitZero[0].rankingScore);
  });

  it("documents that the slot planner is deliberately left unwired", () => {
    // If a later audit finds planVisualMixForBeats with no callers again, the reason it has
    // none must be findable in the file itself rather than only in a chat log.
    const src = readFileSync(path.join(__dirname, "visualMixPolicy.ts"), "utf8");
    expect(src).toContain("NOT WIRED, on purpose");
    expect(src).toContain("planVisualMixForBeats");
  });
});

describe("RONDE 29c — per-gate ask/fire counters", () => {
  it("is inert outside a render instead of throwing or leaking", () => {
    // Gate helpers are shared with archive ingestion and exercised directly by unit tests;
    // neither has a collector, and neither should have to know that.
    expect(() => recordGateVerdict("baked_text", true)).not.toThrow();
    expect(getActiveGateFiringStats()).toBeNull();
  });

  it("counts every ask and only the rejections as fires", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("vision_gate", false);
      recordGateVerdict("vision_gate", true);
      recordGateVerdict("vision_gate", false);
    });
    expect(summarizeGateFiring(stats)).toEqual([{ gate: "vision_gate", asked: 3, fired: 1 }]);
  });

  it("orders the summary by how busy each gate was", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("still_cap", true);
      for (let i = 0; i < 5; i++) recordGateVerdict("baked_text", false);
    });
    expect(summarizeGateFiring(stats).map((r) => r.gate)).toEqual(["baked_text", "still_cap"]);
  });

  it("flags a gate that was asked repeatedly and never once said no", () => {
    // This is the modern-mismatch bug's exact signature.
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < SILENT_GATE_MIN_ASKED; i++) recordGateVerdict("modern_mismatch", false);
    });
    expect(findSilentGates(stats)).toEqual([
      { gate: "modern_mismatch", asked: SILENT_GATE_MIN_ASKED, fired: 0 },
    ]);
  });

  it("stays quiet about a gate that fired at least once", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 40; i++) recordGateVerdict("modern_mismatch", i === 17);
    });
    expect(findSilentGates(stats)).toEqual([]);
  });

  it("stays quiet about a gate that was barely asked — silence on 3 candidates is not evidence", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      for (let i = 0; i < 3; i++) recordGateVerdict("entity_evidence", false);
    });
    expect(findSilentGates(stats)).toEqual([]);
  });

  it("formats the per-gate line as fired/asked", () => {
    const stats = createGateFiringStats();
    runWithGateFiringStats(stats, () => {
      recordGateVerdict("baked_text", true);
      recordGateVerdict("baked_text", false);
      recordGateVerdict("still_cap", false);
    });
    expect(formatGateFiringSummary(stats)).toBe("baked_text=1/2 still_cap=0/1");
    expect(formatGateFiringSummary(createGateFiringStats())).toBe("no gates recorded");
  });

  it("keeps two concurrent renders' counters apart", async () => {
    // A bare module-level counter would merge these — the same class of bug that moved
    // elevenLabsQuotaExhausted onto RenderCtx.
    const a = createGateFiringStats();
    const b = createGateFiringStats();
    await Promise.all([
      runWithGateFiringStats(a, async () => {
        recordGateVerdict("vision_gate", true);
        await new Promise((r) => setTimeout(r, 5));
        recordGateVerdict("vision_gate", true);
      }),
      runWithGateFiringStats(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordGateVerdict("baked_text", false);
      }),
    ]);
    expect(summarizeGateFiring(a)).toEqual([{ gate: "vision_gate", asked: 2, fired: 2 }]);
    expect(summarizeGateFiring(b)).toEqual([{ gate: "baked_text", asked: 1, fired: 0 }]);
  });

  it("counts the vision gate only on fresh verdicts, never on cache hits", () => {
    // A cache hit is the same earlier judgment returned again; counting it would inflate
    // "asked" with candidates nobody actually looked at.
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const gateBody = src.slice(
      src.indexOf("async function beatClipPassesVisionGate("),
      src.indexOf("async function loadArchiveCandidatePool(")
    );
    expect(gateBody).toMatch(/if \(!result\.fromCache\) \{[\s\S]{0,200}recordGateVerdict\("vision_gate"/);
  });

  it("instruments the gate that motivated this whole mechanism", () => {
    const src = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(src).toContain('recordGateVerdict("modern_mismatch"');
    // After the not-armed / no-probes early returns, so "asked" means it genuinely judged.
    const idxNotArmed = src.indexOf("if (!topicNeedsHistoricalFootage(beatText, videoTitle)) return notArmed;");
    const idxRecord = src.indexOf('recordGateVerdict("modern_mismatch"');
    expect(idxNotArmed).toBeGreaterThan(-1);
    expect(idxRecord).toBeGreaterThan(idxNotArmed);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function poolVideo(): PoolCandidate {
  return {
    id: "pexels:1",
    source: "pexels",
    title: "archival looking clip",
    thumbnailUrl: null,
    mediaType: "video",
  } as PoolCandidate;
}

function poolImage(): PoolCandidate {
  return {
    id: "wikimedia:1",
    source: "wikimedia",
    title: "a photograph",
    thumbnailUrl: null,
    mediaType: "image",
  } as PoolCandidate;
}

// Keeps the FunnelCandidate import honest — mergeCandidates' return type is what these tests
// assert against.
export type _FunnelCandidateShape = FunnelCandidate;
