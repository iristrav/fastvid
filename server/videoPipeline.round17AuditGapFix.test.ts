import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// ROUND 17 — recordClipAdopt audit-gap fix (+ third site closed in the follow-up review).
//
// Traced fetchSceneVisualsInner (the live, production-called scene-visual-fill path, reached via
// fetchSceneVisuals at two call sites in the main render flow) and composeSceneVideo's own
// "no usable clips from upstream search" guaranteed-fill blocks. Neither called recordClipAdopt,
// so a scene that fell back entirely to generateGuaranteedBeatClip placeholders here was invisible
// to BOTH assertVisualCoverageExportGate signals: dedup.clipAdoptAudit-derived fallbackBeats/
// beatsFilled (videoQualityReport.ts) AND sceneRescueColorFallbackCount (only incremented when
// composeSceneVideo throws twice — a different, narrower failure mode than "proactively found zero
// usable clips and padded"). It also meant canAddGuaranteedFallbackClip's own per-video fallback
// cap (countFallbackAdopts reads the same dedup.clipAdoptAudit array) could never see fallback
// clips generated through this specific path either. Fixed by recording each guaranteed-fill clip
// with the same "fallback" source label ensureBeatVisualFilled's own guaranteed-clip tier already
// uses — additive bookkeeping only, no change to which clip is selected or rendered.
//
// A follow-up review of this same fix found a third, structurally identical instance in the same
// function: the "compose empty — guaranteed clip rescue" branch (triggered when the real ffmpeg
// montage produces a missing/empty output file) also used a successfully generated
// generateGuaranteedBeatClip result without recording it. Closed with the same additive
// recordClipAdopt(..., scene.index, 8888, scene.text, clip, "fallback") pattern.
//
// Structural check (same extractFunctionSource convention as
// videoPipeline.p0VisualCoverageHardening.test.ts) — verified to FAIL against this file's git-HEAD
// version (recordClipAdopt did not appear inside composeSceneVideo at all) before the fix landed.

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

describe("Round 17 — composeSceneVideoInner's guaranteed-fill blocks now record into the adopt audit", () => {
  // composeSceneVideo itself is a thin heartbeat wrapper (videoPipeline.ts:24587-24610) that just
  // calls composeSceneVideoInner — the actual guaranteed-fill logic (and this round's fix) lives
  // in the Inner function.
  const src = extractFunctionSource("composeSceneVideoInner");

  it("calls recordClipAdopt for the minNeeded guaranteed-fill loop (the 'geen bruikbare clips — guaranteed compose fill' branch)", () => {
    const loopMarker = "geen bruikbare clips — guaranteed compose fill";
    const loopIdx = src.indexOf(loopMarker);
    expect(loopIdx).toBeGreaterThan(-1);
    // recordClipAdopt must appear within this branch, before the branch's closing structure —
    // scoped to comfortably cover the loop body (including its explanatory comment) without
    // reaching into the unrelated "else" branch that follows.
    const scoped = src.slice(loopIdx, loopIdx + 1400);
    expect(scoped).toContain("generateGuaranteedBeatClip");
    expect(scoped).toContain("recordClipAdopt");
    expect(scoped).toContain('"fallback"');
  });

  it("calls recordClipAdopt for the final standalone guaranteed-fill fallback (validClips still empty after every other branch)", () => {
    // The second, standalone `generateGuaranteedBeatClip(scene.index, 999, ...)` call — distinct
    // from the loop above (slot 999 vs. loop index i).
    const standaloneMarker = "generateGuaranteedBeatClip(scene.index, 999,";
    const standaloneIdx = src.indexOf(standaloneMarker);
    expect(standaloneIdx).toBeGreaterThan(-1);
    const scoped = src.slice(standaloneIdx, standaloneIdx + 400);
    expect(scoped).toContain("recordClipAdopt");
    expect(scoped).toContain('"fallback"');
  });

  it("the fix is additive — validClips.push still happens for both guaranteed-fill sites (selection/output unchanged)", () => {
    const loopIdx = src.indexOf("geen bruikbare clips — guaranteed compose fill");
    expect(src.slice(loopIdx, loopIdx + 800)).toContain("validClips.push(clip)");
    const standaloneIdx = src.indexOf("generateGuaranteedBeatClip(scene.index, 999,");
    expect(src.slice(standaloneIdx, standaloneIdx + 400)).toContain("validClips.push(clip)");
  });

  it("calls recordClipAdopt for the compose-empty guaranteed clip rescue (third audit-gap site, slot 8888)", () => {
    // The "compose empty — guaranteed clip rescue" branch — triggered when the real ffmpeg
    // montage produces a missing/empty output file, distinct from both guaranteed-fill sites
    // above (synthetic slot 8888, not a loop index or 999).
    const rescueMarker = "generateGuaranteedBeatClip(scene.index, 8888,";
    const rescueIdx = src.indexOf(rescueMarker);
    expect(rescueIdx).toBeGreaterThan(-1);
    const scoped = src.slice(rescueIdx, rescueIdx + 700);
    expect(scoped).toContain("recordClipAdopt");
    expect(scoped).toContain('"fallback"');
  });
});
