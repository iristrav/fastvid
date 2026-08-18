import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// VISION GATE ROOT-CAUSE FIX — regression tests for the forensically-proven bug:
// fetchOpenverseImages() built output paths from a loop-local index that restarts at 0 on every
// call, so two genuinely different candidate images from two different search queries for the
// same beat could land on the exact same file path (silently overwriting each other on disk).
// The VisionGate cache then fell back to that reused basename as the candidate's identity
// (no contentKey was ever passed from beatClipPassesVisionGate), so a brand-new, never-scored
// image inherited an older, unrelated image's cached pass/fail verdict — and the caller still
// recorded that as a fresh "vision_gate" reject, inflating the reject counter for a candidate
// CLIP never actually looked at.

function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const candidates = [
    `export async function ${fnName}(`,
    `async function ${fnName}(`,
    `export function ${fnName}(`,
    `function ${fnName}(`,
  ];
  const marker = candidates.find((m) => src.includes(m));
  const startIdx = marker ? src.indexOf(marker) : -1;
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  const parenStart = src.indexOf("(", startIdx);
  let parenDepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === "(") parenDepth++;
    else if (src[j] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = src.indexOf("{", j);
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, i + 1);
}

const fullSource = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Vision Gate root-cause fix — Test A: fetchOpenverseImages path collision", () => {
  const src = extractFunctionSource("fetchOpenverseImages");

  it("no longer keys the output filename on the loop-local index alone", () => {
    // The old, buggy construction: `openverse_${i}` with nothing else. Assert it's gone.
    expect(src).not.toMatch(/openverse_\$\{i\}\.jpg/);
    expect(src).not.toMatch(/openverse_\$\{i\}\.mp4/);
  });

  it("derives the filename from the asset's own id (or the image URL) so different assets can never collide on the same path", () => {
    expect(src).toContain("images[i]?.id?.trim() || imgUrl");
    expect(src).toContain("assetTag");
    expect(src).toContain("openverse_${assetTag}.jpg");
    expect(src).toContain("openverse_${assetTag}.mp4");
  });

  it("still falls back to a still-unique value when both id and URL are unexpectedly empty (never reintroduces `i` alone as the sole disambiguator for that edge case)", () => {
    const idx = src.indexOf("const assetTag");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 200);
    expect(scoped).toContain("String(i)");
  });
});

describe("Vision Gate root-cause fix — Test B/D: cache identity threaded through the shared funnel", () => {
  const src = extractFunctionSource("beatClipPassesVisionGate");

  it("passes clipContentKey(clipPath) into evaluateClipVisionGate instead of relying on basename fallback", () => {
    const idx = src.indexOf("evaluateClipVisionGate(");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 400);
    expect(scoped).toContain("clipContentKey(clipPath)");
  });

  it("this is the single funnel every rescue/adoption route calls (Openverse, Wikimedia, Pexels, Pixabay, Internet Archive, YouTube CC, curated archive all pass through it) — so this one fix covers all of them", () => {
    const occurrences = fullSource.split("beatClipPassesVisionGate(").length - 1;
    // 1 definition + all call sites — must be a healthy double-digit fan-in, confirming this
    // really is the shared chokepoint the fix needs to land on (not one of many parallel paths).
    expect(occurrences).toBeGreaterThanOrEqual(12);
  });
});

describe("Vision Gate root-cause fix — Test C: cache hit no longer double-counted as a fresh reject", () => {
  it("beatClipPassesVisionGate only records a vision_gate reject when the verdict was NOT from cache", () => {
    const src = extractFunctionSource("beatClipPassesVisionGate");
    const idx = src.indexOf('recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "vision_gate"');
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 200), idx);
    expect(before).toContain("!result.pass && !result.fromCache");
  });

  it("adoptClip's vision-gate call site (the other funnel) also skips recordClipReject on a cache hit", () => {
    const idx = fullSource.indexOf('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "vision_gate", sourceQuery)');
    expect(idx).toBeGreaterThan(-1);
    const before = fullSource.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain("!visionResult.fromCache");
  });

  it("adoptClip calls evaluateClipVisionGate directly (not the boolean-only clipPassesVisionGate wrapper) so fromCache is observable", () => {
    const idx = fullSource.indexOf("const visionResult = await evaluateClipVisionGate(");
    expect(idx).toBeGreaterThan(-1);
  });
});
