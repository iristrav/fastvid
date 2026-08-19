import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  clipSimToScore,
  cosineSimilarityRaw,
  minLocalClipSimilarity,
  scoreEmbeddingSimilarity,
} from "./localClipVision";

// FASE 7 DEEL 1 — VisionGate raw/clamped-similarity observability + calibration.
// scoreEmbeddingSimilarity() has always clamped a negative raw cosine similarity to 0 via
// Math.max(0, ...). That clamp is unchanged by this work — these tests exist to prove (a) the
// clamp still behaves exactly as before (no threshold/behavior change), and (b) the new
// cosineSimilarityRaw() escape hatch makes the pre-clamp value observable for diagnostics.

describe("cosineSimilarityRaw — pure cosine similarity, unclamped", () => {
  it("returns a negative value for opposite-pointing vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarityRaw(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineSimilarityRaw(a, b)).toBeCloseTo(0, 5);
  });

  it("returns a positive value for aligned vectors", () => {
    const a = [1, 1, 0];
    const b = [1, 1, 0];
    expect(cosineSimilarityRaw(a, b)).toBeCloseTo(1, 5);
  });

  it("returns 0 for an empty embedding on either side", () => {
    expect(cosineSimilarityRaw([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarityRaw([1, 2, 3], [])).toBe(0);
    expect(cosineSimilarityRaw([], [])).toBe(0);
  });
});

describe("scoreEmbeddingSimilarity — clamped to >=0, pass/fail decision unchanged", () => {
  it("clamps a negative raw cosine to exactly 0 (existing behavior, not a technical failure)", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarityRaw(a, b)).toBeLessThan(0);
    expect(scoreEmbeddingSimilarity(a, b)).toBe(0);
  });

  it("passes a zero raw cosine through unchanged", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(scoreEmbeddingSimilarity(a, b)).toBe(0);
  });

  it("passes a positive raw cosine through unchanged (raw === clamped, no clamping applied)", () => {
    const a = [1, 1, 0];
    const b = [1, 1, 0];
    const raw = cosineSimilarityRaw(a, b);
    expect(scoreEmbeddingSimilarity(a, b)).toBeCloseTo(raw, 10);
  });

  it("returns 0 for an empty embedding, matching cosineSimilarityRaw", () => {
    expect(scoreEmbeddingSimilarity([], [1, 2, 3])).toBe(0);
  });
});

describe("threshold conversion — minLocalClipSimilarity / clipSimToScore", () => {
  it("converts a 0-10 minScore into the matching 0-1 similarity floor (score/40)", () => {
    expect(minLocalClipSimilarity(8)).toBeCloseTo(0.2, 10);
    expect(minLocalClipSimilarity(7)).toBeCloseTo(0.175, 10);
  });

  it("clipSimToScore is the inverse direction of minLocalClipSimilarity (sim * 40, clamped 0-10)", () => {
    expect(clipSimToScore(0.2)).toBe(8);
    expect(clipSimToScore(0.175)).toBe(7);
    expect(clipSimToScore(-0.3)).toBe(0); // clamped floor
    expect(clipSimToScore(1)).toBe(10); // clamped ceiling — cosine can't exceed 1 anyway
  });

  it("LOCAL_VISION_MIN_SIMILARITY env override takes precedence when in the valid 0.08-0.55 range", () => {
    const prev = process.env.LOCAL_VISION_MIN_SIMILARITY;
    try {
      process.env.LOCAL_VISION_MIN_SIMILARITY = "0.3";
      expect(minLocalClipSimilarity(8)).toBeCloseTo(0.3, 10);
      // Out-of-range override is ignored, falls back to score/40.
      process.env.LOCAL_VISION_MIN_SIMILARITY = "0.9";
      expect(minLocalClipSimilarity(8)).toBeCloseTo(0.2, 10);
    } finally {
      if (prev === undefined) delete process.env.LOCAL_VISION_MIN_SIMILARITY;
      else process.env.LOCAL_VISION_MIN_SIMILARITY = prev;
    }
  });
});

describe("FASE 7 — source-level checks: raw similarity threaded through without changing pass/fail", () => {
  const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
  const gateSrc = readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");

  it("scoreEmbeddingSimilarity still clamps via Math.max(0, ...) — unchanged decision math", () => {
    expect(localSrc).toMatch(/scoreEmbeddingSimilarity\([^)]*\)[^{]*\{\s*return Math\.max\(0, cosineSimilarityRaw/);
  });

  it("LocalFrameScore/LocalClipScoreResult/StoredEmbeddingScore carry a raw-similarity field", () => {
    expect(localSrc).toContain("rawSimilarity: number");
    expect(localSrc).toMatch(/LocalClipScoreResult[\s\S]{0,400}worstRawSimilarity: number/);
    expect(localSrc).toMatch(/StoredEmbeddingScore[\s\S]{0,300}worstRawSimilarity: number/);
  });

  it("the reject log prints rawSimilarity and clampedSimilarity alongside the existing similarity= field", () => {
    const idx = gateSrc.indexOf("[LocalVision] Scene");
    expect(idx).toBeGreaterThan(-1);
    const scoped = gateSrc.slice(idx - 600, idx + 400);
    expect(scoped).toContain("similarity=${simStr}"); // backward-compat field kept
    expect(scoped).toContain("rawSimilarity=${rawStr}");
    expect(scoped).toContain("clampedSimilarity=${clampedStr}");
  });

  it("the pass/fail comparisons (worstScore10 >= minScore, etc.) are untouched by the observability change", () => {
    // Same literal comparisons that existed before FASE 7 — proves the decision logic itself
    // was not touched, only the diagnostic fields riding alongside it.
    expect(gateSrc).toContain("worstScore10 >= minScore &&");
    expect(gateSrc).toContain("result.score >= minScore");
  });
});
