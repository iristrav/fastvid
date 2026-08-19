import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  cosineSimilarityRaw,
  scoreEmbeddingSimilarity,
} from "./localClipVision";
import { findBestArchiveScoreForBeat } from "./retrievalFunnel";
import { cosineSimilarityVectors } from "./semanticVisualMatching";

// FASE 7.2 — embedding-space separation on the Retrieval Funnel path.
//
// Root cause proven in production render 512: the funnel computed its beat embedding with
// createTextEmbedding() (OpenAI text-embedding-3-small, 1536 dim) and passed that SAME vector
// to evaluateClipVisionGate() as queryEmb. VisionGate compares the query against CLIP
// ViT-B/32 *image* embeddings (512 dim). cosineSimilarity() short-circuits on a dimension
// mismatch (`a.length !== b.length -> return 0`), so every funnel candidate scored an exact
// 0.0000 and could never win — 38 such rejects in render 512, while the non-funnel path in
// the very same render produced real 0.18-0.24 scores because it lets VisionGate resolve its
// own CLIP embedding.
//
// The fix: stop passing the text vector as queryEmb on the funnel path. The text vector is
// KEPT for the archive/text ranking it is correct for (findBestArchiveScoreForBeat,
// computeSegmentSimilarities).

const CLIP_DIM = 512;
const TEXT_EMBED_DIM = 1536;

function vec(dim: number, seed = 1): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin((i + 1) * seed) * 0.5);
}

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const gateSrc = readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");

/** The funnel branch: from `funnelBeatEmb` declaration to the end of the scoring loop. */
function funnelBlock(): string {
  const start = pipelineSrc.indexOf("let funnelBeatEmb: number[] | null = null;");
  expect(start).toBeGreaterThan(-1);
  // RONDE 1 added the used-id argument to this call; anchor on the stable prefix.
  const end = pipelineSrc.indexOf("const winner = pickBestFunnelCandidate(scored", start);
  expect(end).toBeGreaterThan(start);
  return pipelineSrc.slice(start, end);
}

describe("FASE 7.2 Test 4 — dimension-mismatch regression (the actual bug)", () => {
  it("a 1536-dim text vector against a 512-dim CLIP vector yields exactly 0 — silently", () => {
    const textEmb = vec(TEXT_EMBED_DIM, 1);
    const clipImageEmb = vec(CLIP_DIM, 2);

    // This is the exact production symptom: not a low score, an exact zero, with no error.
    expect(cosineSimilarityVectors(textEmb, clipImageEmb)).toBe(0);
    expect(cosineSimilarityRaw(textEmb, clipImageEmb)).toBe(0);
    expect(scoreEmbeddingSimilarity(textEmb, clipImageEmb)).toBe(0);
  });

  it("two same-dimension CLIP vectors do produce a real non-zero similarity", () => {
    // Proves the exact-zero above is caused by the dimension guard, not by the vectors
    // themselves being orthogonal/degenerate.
    const a = vec(CLIP_DIM, 1);
    const b = vec(CLIP_DIM, 1);
    expect(cosineSimilarityRaw(a, b)).toBeGreaterThan(0.9);
    expect(scoreEmbeddingSimilarity(a, b)).toBeGreaterThan(0.9);
  });

  it("the exact-zero is indistinguishable from a legitimate zero score — why it stayed hidden", () => {
    const orthogonalSameDim = cosineSimilarityRaw([1, 0], [0, 1]);
    const mismatched = cosineSimilarityRaw(vec(TEXT_EMBED_DIM), vec(CLIP_DIM));
    expect(orthogonalSameDim).toBe(0);
    expect(mismatched).toBe(0);
    // Identical outputs from two completely different causes: this is exactly why render 511
    // and 512 both showed similarity=0.0000 without revealing a wiring bug.
  });
});

describe("FASE 7.2 Test 2 — VisionGate no longer receives the 1536-dim funnel embedding", () => {
  it("the funnel's evaluateClipVisionGate call does not pass funnelBeatEmb", () => {
    const block = funnelBlock();
    const callStart = block.indexOf("await evaluateClipVisionGate(");
    expect(callStart).toBeGreaterThan(-1);
    const call = block.slice(callStart, block.indexOf(");", callStart));
    expect(call).not.toContain("funnelBeatEmb");
  });

  it("queryEmb is the 11th positional argument and is explicitly undefined on this call", () => {
    // Guards against a future edit silently re-introducing a vector in that slot.
    const block = funnelBlock();
    const callStart = block.indexOf("await evaluateClipVisionGate(");
    const call = block.slice(callStart, block.indexOf(");", callStart));
    const args = call
      .slice(call.indexOf("(") + 1)
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    // clipPath, beat.text, videoTitle, workDir, scene.index, beat.index, fastMode,
    // minScore, visualDescription, segmentGeoLock, queryEmb  -> index 10
    expect(args[10]).toBe("undefined");
  });
});

describe("FASE 7.2 Test 1 — the text embedding is preserved for archive/text ranking", () => {
  it("createTextEmbedding is still computed on the funnel path", () => {
    const block = funnelBlock();
    expect(block).toContain("await createTextEmbedding(beatDoc)");
    expect(block).toContain("funnelBeatEmb = beatEmb");
  });

  it("findBestArchiveScoreForBeat still receives the text embedding", () => {
    const block = funnelBlock();
    expect(block).toMatch(/findBestArchiveScoreForBeat\(funnelResult\.candidates,\s*beatEmb\)/);
  });

  it("computeSegmentSimilarities still receives funnelBeatEmb", () => {
    // This call sits after pickBestFunnelCandidate (outside funnelBlock()'s window), in the
    // archive-annotation branch — there is exactly one call site in the file.
    const calls = pipelineSrc.match(/computeSegmentSimilarities\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("funnelBeatEmb");
  });

  it("findBestArchiveScoreForBeat operates in the text-embedding space (runtime, 1536 dim)", () => {
    // No archive candidates -> null, but the call must accept a 1536-dim vector unchanged.
    expect(findBestArchiveScoreForBeat([], vec(TEXT_EMBED_DIM))).toBeNull();
  });
});

describe("FASE 7.2 Test 3 — VisionGate resolves its own CLIP query embedding when queryEmb is absent", () => {
  it("scoreClipAcrossFrames falls back to resolveBeatQueryEmbedding when queryEmb is nullish", () => {
    expect(gateSrc).toMatch(
      /const queryEmbResolved\s*=\s*\n?\s*queryEmb\s*\?\?\s*\n?\s*\(await stepWithTimeout\([\s\S]{0,200}resolveBeatQueryEmbedding/
    );
  });

  it("resolveBeatQueryEmbedding produces a CLIP-space vector (embedTextQuery), not an OpenAI one", () => {
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    // resolveBeatVisionQueryEmbedding -> embedTextQuery -> CLIP text pipeline (same model as
    // embedImageFromPath), which is what makes it dimension-compatible with the image side.
    expect(localSrc).toMatch(
      /resolveBeatVisionQueryEmbedding\([\s\S]{0,200}return embedTextQuery\(buildBeatVisionQueryText\(ctx\)\)/
    );
    expect(localSrc).toContain('const CLIP_MODEL = "Xenova/clip-vit-base-patch32"');
  });
});

describe("FASE 7.2 Test 5 — non-funnel VisionGate paths are unchanged", () => {
  it("the two non-funnel call sites still pass what they passed before (null / a CLIP vector)", () => {
    // Call site A passes an explicit null (VisionGate resolves its own) — unchanged.
    expect(pipelineSrc).toMatch(/evaluateClipVisionGate\([\s\S]{0,400}gateVisualDesc,\s*\n\s*undefined,\s*\n\s*null,/);
    // Call site B passes `queryEmb`, which is fed by resolveBeatVisionQueryEmbedding (CLIP).
    expect(pipelineSrc).toMatch(/beatQueryEmb = await resolveBeatVisionQueryEmbedding\(visionCtx\)/);
  });

  it("no threshold or scoring constant was touched by FASE 7.2", () => {
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    // The similarity floor and the 0-10 conversion are byte-for-byte the pre-FASE-7.2 forms.
    expect(localSrc).toContain("return minScore10 / 40;");
    expect(localSrc).toContain("return Math.max(0, Math.min(10, Math.round(sim * 40)));");
    // The anti-anachronism gate was explicitly NOT recalibrated in FASE 7.2 — that was
    // deferred to FASE 7.3, which then rewrote its evidence rules (render 512 proved the
    // original conditions killed 14 of 14 above-floor candidates). What this test guards is
    // unchanged: the gate is still a term in the pass/fail expressions rather than something
    // FASE 7.2 rewired, and its two original conditions still exist verbatim — now only as
    // the `legacyWouldReject` observability signal, never in the decision.
    expect(localSrc).toContain("if (negSim >= beatSim - 0.01 || (negSim >= 0.18 && beatSim < 0.24)) legacyWouldReject = true;");
    expect(localSrc).toContain("const similarityPass = worst.similarity >= minSim && !modernMismatch;");
    // scoreEmbeddingSimilarity keeps its clamp.
    expect(localSrc).toMatch(/scoreEmbeddingSimilarity\([^)]*\)[^{]*\{\s*return Math\.max\(0, cosineSimilarityRaw/);
  });

  it("the shared cosineSimilarity guard itself is unchanged (fix is at the call site, not the primitive)", () => {
    const semSrc = readFileSync(path.join(__dirname, "semanticVisualMatching.ts"), "utf8");
    expect(semSrc).toContain("if (a.length !== b.length || a.length === 0) return 0;");
  });
});

describe("FASE 7.2 — observability", () => {
  it("the funnel logs which embedding source VisionGate will use, once per beat (not per frame)", () => {
    const block = funnelBlock();
    expect(block).toContain("[FunnelVisionGate]");
    expect(block).toContain("queryEmbeddingSource=resolved-by-vision-gate");
    // Must sit OUTSIDE the per-candidate loop so it cannot become per-frame noise.
    // RONDE 5 batched the downloads; the per-candidate work now starts at the batch loop.
    const logIdx = block.indexOf("[FunnelVisionGate]");
    const loopIdx = block.indexOf("for (let dlIdx = 0; dlIdx < toScore.length;");
    expect(logIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeLessThan(loopIdx);
  });
});
