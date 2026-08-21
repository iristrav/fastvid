import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  clipVisionGateEnabled,
  evaluateClipVisionGate,
  shouldVisionCheckClip,
  minClipQualityScore,
  clipVisionFrameCoverage,
  effectiveVisionSampleCount,
  cascadeVisionGateEnabled,
  cascadeVisionExpandBelow,
  effectiveMinClipQualityScore,
} from "./visualQualityGate";
import {
  filenameLexicalBoost,
  localVisionEnabled,
  minLocalClipSimilarity,
  buildBeatVisionQueryText,
} from "./localClipVision";

describe("visualQualityGate", () => {
  it("vision-checks all montage clips including openverse and stock", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_hist_archive_titanic.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_wiki2ov_openverse_0.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(true);
    expect(shouldVisionCheckClip("/tmp/scene_0_b1_v1wiki_b2.mp4")).toBe(true);
  });

  it("skips guaranteed and motion-graphic fallbacks", () => {
    expect(shouldVisionCheckClip("/tmp/scene_0_slot3_guaranteed.mp4")).toBe(false);
    expect(shouldVisionCheckClip("/tmp/scene_0_mgfx_card.mp4")).toBe(false);
  });

  it("skips vision when ENABLE_LOCAL_VISION=false", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(shouldVisionCheckClip("/tmp/scene_0_b0_pexels_ocean.mp4")).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prev;
  });

  it("clipVisionGateEnabled respects ENABLE_LOCAL_VISION=false", () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(clipVisionGateEnabled()).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prev;
  });

  it("defaults to 80% vision frame coverage, and strict mode keeps it there in fast mode too", () => {
    // RONDE 30: this asserted 0.5 for fast mode. Strict voice↔visual match is on by default and
    // deliberately removes the fast-path relaxation (same reasoning as effectiveMinClipQualityScore
    // right above it in visualQualityGate.ts), so fast mode also gets 0.8. The old 0.5 only
    // applies with strict mode off — now covered explicitly instead of assumed.
    const prev = process.env.CLIP_VISION_COVERAGE;
    const prevStrict = process.env.STRICT_VOICE_VISUAL_MATCH;
    delete process.env.CLIP_VISION_COVERAGE;

    expect(clipVisionFrameCoverage()).toBe(0.8);
    expect(clipVisionFrameCoverage(true)).toBe(0.8);
    expect(effectiveVisionSampleCount(false)).toBe(3);

    process.env.STRICT_VOICE_VISUAL_MATCH = "false";
    expect(clipVisionFrameCoverage(true)).toBe(0.5);
    expect(effectiveVisionSampleCount(true)).toBe(1);

    if (prevStrict === undefined) delete process.env.STRICT_VOICE_VISUAL_MATCH;
    else process.env.STRICT_VOICE_VISUAL_MATCH = prevStrict;
    if (prev === undefined) delete process.env.CLIP_VISION_COVERAGE;
    else process.env.CLIP_VISION_COVERAGE = prev;
  });
});

describe("localClipVision helpers", () => {
  it("filenameLexicalBoost rewards matching tokens in clip path", () => {
    const boost = filenameLexicalBoost(
      "/tmp/scene_0_amsterdam_cycling_pexels.mp4",
      "Cyclists cross a bridge in Amsterdam during rush hour.",
      "Amsterdam documentary"
    );
    expect(boost).toBeGreaterThan(0);
  });

  it("minLocalClipSimilarity scales with min quality score", () => {
    expect(minLocalClipSimilarity(8)).toBeCloseTo(0.2, 2);
    expect(minLocalClipSimilarity(6)).toBeCloseTo(0.15, 2);
  });

  it("cascadeVisionGateEnabled is on with local vision", () => {
    const prev = process.env.ENABLE_CASCADE_VISION_GATE;
    delete process.env.ENABLE_CASCADE_VISION_GATE;
    expect(cascadeVisionGateEnabled()).toBe(true);
    expect(cascadeVisionExpandBelow(8)).toBe(6);
    process.env.ENABLE_CASCADE_VISION_GATE = prev;
  });

  it("buildBeatVisionQueryText prefers visual description over narration", () => {
    const q = buildBeatVisionQueryText({
      beatText: "Something abstract about history.",
      visualDescription: "World War II soldiers marching in Berlin",
    });
    expect(q.indexOf("World War II")).toBeLessThan(q.indexOf("Something abstract"));
  });

  it("effectiveMinClipQualityScore stays at minClipQualityScore when strict voice visual match is on", () => {
    const prev = process.env.STRICT_VOICE_VISUAL_MATCH;
    process.env.STRICT_VOICE_VISUAL_MATCH = "true";
    expect(effectiveMinClipQualityScore(true, true)).toBe(minClipQualityScore());
    process.env.STRICT_VOICE_VISUAL_MATCH = prev;
  });

  // Production finding (Vision Gate root-cause fix, test F): buildBeatVisionQueryText used to
  // .slice() each field to a hard character cap before joining with ". " — a long
  // visualDescription could get chopped mid-word (observed in production as "Führerbunker"
  // becoming the fragment "hrerbunker"). truncateAtWordBoundary backs a cut off to the last
  // whitespace instead of slicing blindly.
  it("buildBeatVisionQueryText never cuts a word in half when a field exceeds its cap", () => {
    // "Führerbunker" starts at character 170 of this 200-char filler — well past the 180-char
    // visualDescription cap, so a blind .slice(0, 180) would land mid-word inside it.
    const filler = "battle scene ".repeat(13); // 169 chars
    const visualDescription = `${filler}Führerbunker collapse under artillery fire in the final days`;
    const q = buildBeatVisionQueryText({ beatText: "narration", visualDescription });
    // No word in the query should be a truncated fragment of "Führerbunker" — either the whole
    // word appears, or none of it does (cut before the word started).
    expect(q).not.toMatch(/\bhrerbunker\b/i);
    expect(q).not.toMatch(/\bFü?hrerbunke?\b/i);
  });

  it("buildBeatVisionQueryText truncates a normal long sentence at a word boundary, not mid-word", () => {
    const longNarration =
      "The soldiers marched through the ruined city streets past collapsed buildings and " +
      "burning vehicles while civilians fled toward the underground shelters for safety";
    const q = buildBeatVisionQueryText({ beatText: longNarration });
    // Every token in the produced query must be a real prefix of a token from the source text
    // (i.e. never a word chopped part-way through) — reconstruct the source word set and check.
    const sourceWords = new Set(longNarration.toLowerCase().split(/\s+/));
    const producedWords = q.toLowerCase().replace(/[.]/g, "").split(/\s+/).filter(Boolean);
    for (const w of producedWords) {
      expect(sourceWords.has(w)).toBe(true);
    }
  });

  // Test E (partial — the cheap, deterministic slice of evaluateClipVisionGate's cache-hit
  // tracking that doesn't require the real CLIP model): the gate-disabled early-out is not a
  // cache hit — it must report fromCache:false so a caller never mistakes "gate is off" for
  // "this exact candidate was already judged."
  it("evaluateClipVisionGate reports fromCache:false when the gate is disabled", async () => {
    const prev = process.env.ENABLE_LOCAL_VISION;
    process.env.ENABLE_LOCAL_VISION = "false";
    try {
      const result = await evaluateClipVisionGate(
        "/tmp/scene_0_b0_pexels_ocean.mp4",
        "beat text",
        "video title",
        "/tmp",
        0,
        0,
        false
      );
      expect(result.skipped).toBe(true);
      expect(result.fromCache).toBe(false);
    } finally {
      process.env.ENABLE_LOCAL_VISION = prev;
    }
  });
});

describe("Vision Gate root-cause fix — source-level checks (visualQualityGate.ts)", () => {
  const src = readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");

  it("VisionGateResult carries fromCache so callers can tell a cache hit from a fresh verdict", () => {
    expect(src).toMatch(/VisionGateResult\s*=\s*\{[\s\S]{0,600}fromCache:\s*boolean/);
  });

  it("the cache-hit return path sets fromCache: true", () => {
    const idx = src.indexOf("visionGateCache.has(cacheKey)");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 300);
    expect(scoped).toContain("fromCache: true");
  });

  it("scoreClipAcrossFrames tracks raw worstSimilarity alongside the rounded worstScore", () => {
    expect(src).toContain("worstSimilarity: number | null;");
    // Every return branch must be updated — count should match the number of `worstScore:`
    // occurrences (each return sets both together) rather than lag behind them.
    const worstScoreReturns = (src.match(/worstScore:\s/g) ?? []).length;
    const worstSimilarityReturns = (src.match(/worstSimilarity:\s/g) ?? []).length;
    expect(worstSimilarityReturns).toBeGreaterThanOrEqual(worstScoreReturns);
  });

  it("the reject log uses the same raw-similarity math for the shown score as the pass/fail decision, not a misleadingly-rounded one", () => {
    const idx = src.indexOf("[LocalVision] Scene");
    expect(idx).toBeGreaterThan(-1);
    // Window widened for FASE 7: the reject log now also computes rawSimilarity/
    // clampedSimilarity ahead of the console.warn call, pushing the pre-existing scoreStr
    // computation (which still does the same result.worstSimilarity * 40 math, unchanged)
    // further before the "[LocalVision] Scene" text than the original 400-char window covered.
    const scoped = src.slice(idx - 850, idx + 300);
    expect(scoped).toContain("similarity=");
    expect(scoped).toContain("threshold=");
    expect(scoped).toContain("result.worstSimilarity * 40");
  });

  it("FASE 7: the reject log also surfaces the unclamped raw similarity alongside the existing clamped one", () => {
    const idx = src.indexOf("[LocalVision] Scene");
    const scoped = src.slice(idx - 850, idx + 400);
    expect(scoped).toContain("rawSimilarity=");
    expect(scoped).toContain("clampedSimilarity=");
    expect(scoped).toContain("worstRawSimilarity");
  });
});
