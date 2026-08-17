import { describe, expect, it, vi } from "vitest";
import { assertVisualCoverageExportGate, type VideoQualityReport } from "./videoQualityReport";
import { parseAppErrorCode, PIPELINE_ERROR } from "@shared/appErrors";

// FASTVID — PRODUCTION RENDER FAILURE FIX
//
// Real render finding ("Why Hitler Killed Himself and His Wife"): (1) a completely off-topic
// image (an "open letter to remove Richard M. Stallman" screenshot) was adopted onto a Hitler
// beat, and (2) real footage stopped after ~9s and a repeated text/color placeholder silently
// filled the rest of the video while the render still reported success.
//
// These tests cover the two structural fixes:
//   - Problem 10/11: assertVisualCoverageExportGate (server/videoQualityReport.ts) — a hard,
//     blocking final validation gate that fails the render instead of shipping it, plus
//     guaranteedTextOverlayDurationSec (server/videoPipeline.ts) — the scene-level text/color
//     placeholder duration cap fix (90s -> archiveVisualMaxClipSec()).
//   - Problem 1/2/9: scriptImageFallbackPassesRelevanceFloor (server/videoPipeline.ts) — the new
//     relevance floor adoptClip now applies to scriptImageFallback candidates (generic image
//     search, e.g. SerpAPI) using provider-authored title text as independent evidence, plus the
//     entity-evidence/documentary-beat-gate checks that were previously exempted for that path
//     (verified by direct code read + typecheck — the branching itself lives inside adoptClip,
//     which is unexported and side-effecting like the rest of this file's adopt path, matching
//     the established convention of testing the extracted pure logic rather than the full
//     ffprobe/ffmpeg/CLIP-calling function — see videoPipeline.p0p1ImageQuality.test.ts).
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

function baseReport(overrides: Partial<VideoQualityReport> = {}): VideoQualityReport {
  return {
    generatedAt: new Date().toISOString(),
    videoTitle: "Why Hitler Killed Himself and His Wife",
    visualTopic: "history",
    totalClips: 10,
    bySource: {},
    byMixKind: {} as VideoQualityReport["byMixKind"],
    wikimediaCount: 0,
    archiveCount: 0,
    stockCount: 0,
    warnings: [],
    offTopicSuspects: [],
    ...overrides,
  };
}

describe("Problem 10/11 — assertVisualCoverageExportGate (hard final validation)", () => {
  it("Test 1 — throws when a whole scene fell back to the color/text placeholder", () => {
    const report = baseReport({ adoptAuditSummary: { beatsFilled: 8, fallbackBeats: 0 } as any });
    expect(() => assertVisualCoverageExportGate(report, 1)).toThrow();
  });

  it("Test 2 — throws when a strict majority of filled beats used the fallback", () => {
    const report = baseReport({ adoptAuditSummary: { beatsFilled: 10, fallbackBeats: 6 } as any });
    expect(() => assertVisualCoverageExportGate(report, 0)).toThrow();
  });

  it("Test 3 — does NOT throw for a healthy render (no rescue, low fallback ratio)", () => {
    const report = baseReport({ adoptAuditSummary: { beatsFilled: 10, fallbackBeats: 1 } as any });
    expect(() => assertVisualCoverageExportGate(report, 0)).not.toThrow();
  });

  it("Test 4 — does NOT throw when beatsFilled is 0 (no false positive from a divide-by-zero ratio)", () => {
    const report = baseReport({ adoptAuditSummary: { beatsFilled: 0, fallbackBeats: 0 } as any });
    expect(() => assertVisualCoverageExportGate(report, 0)).not.toThrow();
  });

  it("Test 5 — thrown error carries PIPELINE_ERROR.QUALITY_GATE and concrete per-render diagnostics", () => {
    const report = baseReport({
      adoptAuditSummary: { beatsFilled: 4, fallbackBeats: 4 } as any,
      totalClips: 3,
      rejectSummary: { off_topic_visual: 5, entity_evidence: 2 },
      topRejects: [{ sceneIndex: 2, beatIndex: 1, basename: "x.mp4", reason: "off_topic_visual" } as any],
    });
    let caught: Error | undefined;
    try {
      assertVisualCoverageExportGate(report, 1);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(parseAppErrorCode(caught!.message)).toBe(PIPELINE_ERROR.QUALITY_GATE);
    expect(caught!.message).toContain("off_topic_visual");
    expect(caught!.message).toContain("s2b1");
  });
});

describe("Problem 3/10/11 — guaranteedTextOverlayDurationSec (scene-level placeholder duration cap)", () => {
  it("Test 6 — a long scene duration is capped to archiveVisualMaxClipSec(), never 90s", async () => {
    const { guaranteedTextOverlayDurationSec } = await freshPipeline();
    const { archiveVisualMaxClipSec } = await import("./sourcingPolicy");
    const capped = guaranteedTextOverlayDurationSec(600);
    expect(capped).toBe(archiveVisualMaxClipSec());
    expect(capped).toBeLessThanOrEqual(8);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation

  it("Test 7 — a very short requested duration still gets at least the 3s floor", async () => {
    const { guaranteedTextOverlayDurationSec } = await freshPipeline();
    expect(guaranteedTextOverlayDurationSec(0.5)).toBe(3);
  });
});

describe("Problem 10 — VisualDedupState.sceneRescueColorFallbackCount", () => {
  it("Test 8 — createVisualDedupState initializes the new counter to 0", async () => {
    const { createVisualDedupState } = await freshPipeline();
    const dedup = createVisualDedupState({} as any);
    expect(dedup.sceneRescueColorFallbackCount).toBe(0);
  });
});

describe("Problem 1/2/9 — scriptImageFallbackPassesRelevanceFloor (adoptClip relevance floor)", () => {
  it("Test 9 — a completely off-topic provider title on an unrelated beat is rejected (the Stallman-image bug)", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    const title = "An open letter to remove Richard M. Stallman from all leadership positions";
    const query = "Adolf Hitler final days Berlin bunker";
    const beatText = "In his final hours, Hitler and Eva Braun took their own lives in the bunker.";
    expect(scriptImageFallbackPassesRelevanceFloor(title, query, beatText, "Why Hitler Killed Himself and His Wife")).toBe(false);
  });

  it("Test 10 — a genuinely on-topic provider title (keyword overlap) is accepted", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    const title = "Adolf Hitler in the Führerbunker, Berlin, 1945";
    const query = "Adolf Hitler final days Berlin bunker";
    const beatText = "In his final hours, Hitler and Eva Braun took their own lives in the bunker.";
    expect(scriptImageFallbackPassesRelevanceFloor(title, query, beatText, "Why Hitler Killed Himself and His Wife")).toBe(true);
  });

  it("Test 11 — no provider title available at all -> passes unchanged (no regression for evidence-less candidates)", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(scriptImageFallbackPassesRelevanceFloor(undefined, "Adolf Hitler bunker", "He died in Berlin", "title")).toBe(true);
  });

  it("Test 12 — no usable keywords to evaluate against -> passes rather than blocking on nothing", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    // Every word here is under the 3-char / stopword floor tokenizeForRelevance applies, so
    // there is nothing meaningful to check the title against — must not block in that case.
    expect(scriptImageFallbackPassesRelevanceFloor("Some Title", "a of to", "is it", "")).toBe(true);
  });
});
