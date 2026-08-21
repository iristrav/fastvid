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

describe("Vision Gate root-cause fix round 2 — Test 6: adopted real clip protected from later guaranteed-fill overwrite", () => {
  const src = extractFunctionSource("refillSceneStrictVoiceMatch");

  it("the already-attempted branch seeds `clips` from real (non-fallback) adopt-audit entries for this scene before topping up with guaranteed fill", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 3000);
    expect(scoped).toContain('entry.source !== "fallback" && entry.source !== "rescue_placeholder"');
    expect(scoped).toContain("fs.existsSync(candidate)");
    expect(scoped).toContain("appendGuaranteedSceneClips(");
  });

  it("still calls appendGuaranteedSceneClips to top up any remaining gap (doesn't remove the guaranteed-fill safety net)", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    const appendIdx = scoped.indexOf("await appendGuaranteedSceneClips(");
    expect(appendIdx).toBeGreaterThan(-1);
  });

  // Review finding (final review round): seeding `clips` with real entries means
  // appendGuaranteedSceneClips's `slot` counter (used as clips.length at entry) can start above
  // 0 for the first time from this call site — and that same `slot` value is also used as the
  // recordClipAdopt beatIndex a few lines later in appendGuaranteedSceneClips, where it can
  // collide with a genuine narrative beatIndex already used by one of the seeded real clips,
  // silently reclassifying that beat as "fallback" in the coverage audit even though the real
  // clip is still untouched in the actual `clips` array.
  it("seeded real entries are ordered by beatIndex, not by chronological adoption order, so the montage plays back in narrative beat order", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    expect(scoped).toContain(".sort((a, b) => a.beatIndex - b.beatIndex)");
  });
});

describe("Vision Gate root-cause fix round 2 — appendGuaranteedSceneClips: synthetic audit beatIndex can never collide with a real narrative beat", () => {
  const src = extractFunctionSource("appendGuaranteedSceneClips");

  it("offsets the recordClipAdopt beatIndex away from the raw array-position `slot`, matching the sentinel-slot pattern used by other guaranteed-fill call sites (999/1001/8888/9999)", () => {
    const idx = src.indexOf("recordClipAdopt(dedup.clipAdoptAudit, scene.index,");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 120);
    expect(scoped).not.toContain("scene.index, slot,");
    expect(scoped).toMatch(/scene\.index,\s*\d+\s*\+\s*slot/);
  });
});

describe("Vision Gate final hardening — Bug 1: appendGuaranteedSceneClips fills gaps in narrative beat order, not by blind append", () => {
  const src = extractFunctionSource("appendGuaranteedSceneClips");

  it("accepts an optional existingBeatIndices array so callers can identify which narrative beat each pre-seeded real clip belongs to", () => {
    expect(src).toContain("existingBeatIndices?: number[]");
  });

  it("computes the actually-missing narrative beat indices instead of assuming the seeded real clips fill [0, seedCount) contiguously", () => {
    expect(src).toContain("filled.has(beatIdx)");
    expect(src).toContain("missing.push(beatIdx)");
  });

  it("reassigns newly-generated guaranteed clips to the missing beat indices and re-sorts the merged array back into narrative beat order, instead of leaving real clips bunched before trailing fallbacks", () => {
    expect(src).toContain("missing[i] ?? minClips + i");
    const sortIdx = src.indexOf(".sort((a, b) => a.beatIndex - b.beatIndex)");
    expect(sortIdx).toBeGreaterThan(-1);
  });

  it("never drops or shrinks the pre-seeded real clips during the reorder — every existingBeatIndices entry is carried into the merge", () => {
    const idx = src.indexOf("existingBeatIndices.length === seedCount");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 800);
    expect(scoped).toContain("existingBeatIndices\n      .map((beatIndex, i) => ({ beatIndex, clip: clips[i], dur: beatDurations[i] }))");
  });
});

describe("Vision Gate final hardening — Test A: refillSceneStrictVoiceMatch threads real beatIndex gaps through to appendGuaranteedSceneClips", () => {
  const src = extractFunctionSource("refillSceneStrictVoiceMatch");

  it("collects a parallel clipBeatIndices array alongside the seeded real clips (beat 0 and 2 missing, beat 1 and 3 real -> indices [1, 3], not [0, 1])", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    expect(scoped).toContain("const clipBeatIndices: number[] = [];");
    expect(scoped).toContain("clipBeatIndices.push(entry.beatIndex);");
  });

  it("passes clipBeatIndices as the 7th argument to appendGuaranteedSceneClips so gap-filling knows the real beats' true positions", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    const appendIdx = scoped.indexOf("await appendGuaranteedSceneClips(");
    expect(appendIdx).toBeGreaterThan(-1);
    const callSite = scoped.slice(appendIdx, appendIdx + 200);
    expect(callSite).toContain("clipBeatIndices");
  });
});

describe("Vision Gate final hardening — Test C: a real adopted clip is never replaced by a guaranteed placeholder on a repeated refillSceneStrictVoiceMatch call", () => {
  const src = extractFunctionSource("refillSceneStrictVoiceMatch");

  it("seeds `clips` from real adopt-audit entries BEFORE calling appendGuaranteedSceneClips, so the real clip is already present when gap-filling runs (not replaced by it)", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    const seedLoopIdx = scoped.indexOf("for (const entry of realEntriesForScene)");
    const appendCallIdx = scoped.indexOf("await appendGuaranteedSceneClips(");
    expect(seedLoopIdx).toBeGreaterThan(-1);
    expect(appendCallIdx).toBeGreaterThan(-1);
    expect(seedLoopIdx).toBeLessThan(appendCallIdx);
  });

  it("only seeds entries whose source is a real adoption, excluding fallback/rescue_placeholder — a previously-placeholder-filled beat is correctly left for gap-filling, not falsely protected", () => {
    const idx = src.indexOf("strictRefillAttemptedScenes.has(scene.index)");
    const scoped = src.slice(idx, idx + 3000);
    expect(scoped).toContain('entry.source !== "fallback" && entry.source !== "rescue_placeholder"');
  });
});

describe("Vision Gate root-cause fix round 2 — Test 9: off_topic_visual rejects are now individually logged", () => {
  it("logs scene, beat, provider, query, and title before recording an off_topic_visual reject", () => {
    // Anchored on the reject itself, not on the first occurrence of the reason string —
    // RONDE 29 added a recordGateVerdict("off_topic_visual", …) counter that now appears
    // earlier in the file, and a bare indexOf would land on that instead.
    const idx = fullSource.indexOf('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "off_topic_visual"');
    expect(idx).toBeGreaterThan(-1);
    const before = fullSource.slice(Math.max(0, idx - 700), idx);
    expect(before).toContain("off_topic_visual provider=");
    expect(before).toContain("query=");
    expect(before).toContain("title=");
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
