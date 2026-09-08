/**
 * RENDER 574 — THE STORED REPORT DESCRIBED A DIFFERENT RENDER, AND NOTHING SAID SO.
 *
 * ── How it was found ─────────────────────────────────────────────────────────────────────────
 *
 * Video 574's export read:
 *
 *     render         rmtspxhka-1
 *     render start   2026-09-08T13:58:29.109Z
 *     render eind    2026-09-08T13:58:29.256Z
 *     gateAnswered = 0
 *     gateAttempts = 0
 *
 * — nobody judged a single picture. That render's own log said, from the same counter:
 *
 *     [Quality] Video 574: beat image gate — attempts=54 answered=54 (fits=12 does_not_fit=42)
 *     [BeatImageGate] verdicts by provider: 54x openai
 *
 * Both lines read `judgementTally(visualDedup.beatImageGate)`, one object, so within a single
 * render they cannot disagree. They came from two: the delivered film was made by `rmtsu22cb-1`
 * over twenty-one minutes; the stored numbers came from a run whose whole report window was
 * 147 milliseconds.
 *
 * ── Why the record could be half of each ─────────────────────────────────────────────────────
 *
 * `pipelineReport` is stored TWICE — an early partial (the only record a render that dies at the
 * quality gate leaves) and a complete one at the end. `pipelineGlance` had exactly one writer, the
 * early merge. So a later render could replace the report and leave an earlier render's numbers
 * standing beside it, and neither half carried the id of the render it came from, so an export
 * could not tell a reader that it was showing two.
 *
 * That is not a cosmetic fault. Two rounds of analysis on this video held a log against a report
 * of a different render and reasoned about the difference.
 *
 * ── And the other half of §19: what a scene is made of ───────────────────────────────────────
 *
 * `composedUsedClips` had four readers and three of them already carried the "fall back to the
 * selected set" rule inline. `buildEditorScenesFromPipeline` read it raw, so a scene that composed
 * nothing reached the editor with no footage at all — a hazard the salvage path's own comment has
 * to work around. One rule now, in one place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import { formatPipelineExport } from "./pipelineExport";
import type { RenderPipelineReport, PipelineGlance } from "./renderPipelineReport";

const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function report(renderId: string): RenderPipelineReport {
  return {
    videoId: 574,
    renderId,
    startedAt: "2026-09-08T15:37:00.000Z",
    finishedAt: "2026-09-08T15:58:27.000Z",
    sections: { summary: ["[RenderJob] video=574 route=cinematic_timeline"] },
    truncated: {},
  };
}

function glance(renderId?: string): PipelineGlance {
  return {
    ...(renderId ? { renderId } : {}),
    qualityStatus: "PARTIALLY_VERIFIED",
    score: 36,
    beats: 15,
    gateAttempts: 54,
    gateAnswered: 54,
    warnings: 7,
  };
}

function exportWith(reportId: string, glanceId?: string): string {
  return formatPipelineExport({
    videoId: 574,
    status: "completed",
    title: "Why Adolf Hitler Took His Own Life in 1945",
    prompt: "This is why hitler killed himself",
    createdAt: "2026-09-08T12:55:14.000Z",
    errorMessage: null,
    pipelineReport: report(reportId),
    pipelineGlance: glance(glanceId),
    qualityReport: null,
    pipelineStepTiming: null,
  });
}

/* ═══════════════════════ §1 — the export refuses to present two renders as one ═══════════════════════ */

describe("an export says when its two halves come from different renders", () => {
  it("names both renders when they disagree", () => {
    const out = exportWith("rmtsu22cb-1", "rmtspxhka-1");
    expect(out).toContain("LET OP");
    expect(out).toContain("rmtspxhka-1");
    expect(out).toContain("rmtsu22cb-1");
  });

  it("says plainly not to compare them", () => {
    expect(exportWith("rmtsu22cb-1", "rmtspxhka-1")).toContain("vergelijk ze niet");
  });

  it("stays quiet when both halves are the same render", () => {
    /** A warning on every healthy export would be noise, and noise is not evidence. */
    expect(exportWith("rmtsu22cb-1", "rmtsu22cb-1")).not.toContain("LET OP");
  });

  it("stays quiet for an older record that has no render id to compare", () => {
    /** Absence is not disagreement — a report stored before this field existed is not suspect. */
    expect(exportWith("rmtsu22cb-1")).not.toContain("LET OP");
  });

  it("the numbers are still printed, warning or not", () => {
    /** The banner is a caveat on the figures, never a replacement for them. */
    const out = exportWith("rmtsu22cb-1", "rmtspxhka-1");
    expect(out).toContain("KERNCIJFERS");
    expect(out).toContain("gateAttempts = 54");
  });
});

/* ═══════════════════════ §2 — the glance is written where the report is ═══════════════════════ */

describe("both stores carry the glance, and it names its render", () => {
  it("the glance is stored at both merges, not only the early one", () => {
    const writes = PIPELINE.split("pipelineGlance:").length - 1;
    expect(writes, "the glance is written at fewer than both merges").toBe(2);
  });

  it("it is built at call time, so the second write is not the first one's numbers", () => {
    /**
     * A captured object would carry the early counters into the late store — the same shape of
     * fault, one step further along.
     */
    expect(PIPELINE).toContain("const glanceNow = (): PipelineGlance =>");
    expect(PIPELINE).toContain("pipelineGlance: glanceNow(),");
  });

  it("it carries the render it came from", () => {
    const at = PIPELINE.indexOf("const glanceNow = (): PipelineGlance =>");
    expect(PIPELINE.slice(at, at + 400)).toContain(
      "renderId: visualDedup.sourcingCache.lineage.renderId"
    );
  });

  it("the counters are still read from the render's own gate state", () => {
    /** Not recomputed, not estimated: the same tally the `[Quality]` line prints. */
    const at = PIPELINE.indexOf("const glanceNow = (): PipelineGlance =>");
    const body = PIPELINE.slice(at, at + 700);
    expect(body).toContain("judgementTally(visualDedup.beatImageGate).attempts");
    expect(body).toContain("judgementTally(visualDedup.beatImageGate).answered");
  });

  it("the early store is kept — a render that dies still leaves numbers", () => {
    /**
     * The early merge exists because the quality gate below it throws, and that partial record is
     * the only thing such a render leaves behind. This round adds a second store; it removes none.
     */
    const first = PIPELINE.indexOf("pipelineGlance: glanceNow(),");
    const second = PIPELINE.indexOf("pipelineGlance: glanceNow(),", first + 1);
    expect(second, "the second store is missing").toBeGreaterThan(first);
  });
});

/* ═══════════════════════ §3 — one rule for what a scene is made of ═══════════════════════ */

describe("compose is a fallback for every reader, not for three of four", () => {
  const clipsForScene = (): string => {
    const at = PIPELINE.indexOf("const clipsForScene = (i: number): string[] =>");
    expect(at, "clipsForScene is gone").toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n    };", at));
  };

  it("the rule prefers compose's list and falls back to the selected set", () => {
    const body = clipsForScene();
    expect(body).toContain("composedUsedClips[i] ?? []");
    expect(body).toContain("sceneVisualResults[i]?.clips ?? []");
  });

  it("the editor reads it instead of composedUsedClips raw", () => {
    /** This was the one reader without a fallback: a scene that composed nothing showed as empty. */
    const at = PIPELINE.indexOf("editorScenes = await buildEditorScenesFromPipeline(");
    const call = PIPELINE.slice(at, at + 320);
    expect(call).toContain("clipsForScene(i)");
    expect(call).not.toMatch(/\n\s*composedUsedClips,/);
  });

  it("the critical review and the review inputs read the same rule, not their own copies", () => {
    expect(PIPELINE).toContain("const clipsToReview = clipsForScene(i);");
    expect(PIPELINE).toContain("sceneReviewInputs(scenes, scenes.map((_, i) => clipsForScene(i)))");
  });

  it("allClipPaths deliberately does NOT use it", () => {
    /**
     * It feeds the quality report's "clips in the video". A scene that composed nothing put no
     * picture in the montage, so falling back there would turn a missing scene into a full one.
     * That number has to come from the delivered file — a larger change, and not a fallback.
     */
    expect(PIPELINE).toContain("const allClipPaths = composedUsedClips.flat().filter(Boolean);");
  });
});
