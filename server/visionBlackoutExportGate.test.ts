/**
 * A VIDEO NOBODY LOOKED AT MUST NOT SHIP.
 *
 * ── Render 562 ──────────────────────────────────────────────────────────────────────────────
 *
 * The beat image gate is the only judge in this pipeline that has seen the frame and read the
 * narration at the same time. On 2 September it lost every provider it has:
 *
 *     09:37:33  [LLM] OpenAI quota spent — standing down for 30min
 *     09:40:30  Gemini 403 PERMISSION_DENIED — "Your project has been denied access."
 *               Groq is excluded from image calls entirely — its vision models 404
 *     09:42:22  [BeatImageGate] no verdict: 23x gate could not ask
 *               [BeatImageGate] verdicts by provider: 45x openai
 *
 * The gate fails OPEN on purpose, so those 23 clips were adopted unjudged, the render finished,
 * uploaded, and was written to the database as `completed`. One of them was archive footage of a
 * present-day "White Lives Matter" demonstration in Montana, in a documentary about the Second
 * World War.
 *
 * ── Why the repair is a refusal and not a fallback ──────────────────────────────────────────
 *
 * The obvious fix — let CLIP decide when the model cannot — was already tried and measured wrong.
 * RONDE 58's header records four scores from render 531 on one beat:
 *
 *     white-lives-matter-montana-sticker    0.2226   wrong
 *     faces-of-ancient-europe-1-500-a.d     0.2225   wrong
 *     Signed Photograph of Adolf Hitler     0.2116   right, scores LOWER
 *     Bundesarchiv Bild 183-1989-0322       0.2077   right, scores LOWEST
 *
 * A CLIP veto deletes the Hitler photograph and keeps the sticker. There is no cheaper judge to
 * fall back to, so the only honest options are a working gate or an unshipped render.
 *
 * ── The line these tests hold ───────────────────────────────────────────────────────────────
 *
 * Refuse when an OUTAGE left real footage unjudged. Never refuse a render that was merely thrifty
 * (budget spent), deliberately unjudged (gate off), or unlucky in a way that cost nothing.
 */
import { describe, expect, it } from "vitest";

import {
  assertVisionCoverageExportGate,
  type VisionCoverageBeat,
} from "./videoQualityReport";
import { PIPELINE_ERROR } from "@shared/appErrors";
import {
  createBeatImageGateState,
  type BeatImageGateState,
} from "./beatImageRelevanceGate";

const judged = (s: number, b: number): VisionCoverageBeat => ({
  sceneIndex: s, beatIndex: b, verdicts: 2, hasRealFootage: true,
});
const unjudged = (s: number, b: number): VisionCoverageBeat => ({
  sceneIndex: s, beatIndex: b, verdicts: 0, hasRealFootage: true,
});
const emptyBeat = (s: number, b: number): VisionCoverageBeat => ({
  sceneIndex: s, beatIndex: b, verdicts: 0, hasRealFootage: false,
});

/* ═══════════════════════ the refusal ═══════════════════════ */

describe("an outage that put unjudged footage on screen stops the render", () => {
  /** Render 562's own shape: some beats judged before the outage, four after it with nothing. */
  const production = {
    providerUnavailable: 23,
    beats: [
      judged(0, 0), judged(0, 1), judged(0, 2), judged(0, 3),
      unjudged(2, 0), unjudged(2, 1), unjudged(2, 2), unjudged(2, 3),
    ],
    noVerdictSummary: "[BeatImageGate] no verdict: 23x gate could not ask",
  };

  it("refuses render 562", () => {
    expect(() => assertVisionCoverageExportGate(production)).toThrow();
  });

  /**
   * The same failure code the other export gates use, so `server/routers.ts` marks the video
   * `failed` with this reason instead of `completed`. `pipelineError` carries the code in the
   * message suffix, which is what the caller and the database both see.
   */
  it("fails with the quality-gate code, so the video is marked failed with a reason", () => {
    let message = "";
    try {
      assertVisionCoverageExportGate(production);
      throw new Error("the gate did not fire");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`(${PIPELINE_ERROR.QUALITY_GATE})`);
  });

  /** The message has to tell an operator what to do, not just that something is wrong. */
  it("names the beats, the scale, and the way out", () => {
    let message = "";
    try { assertVisionCoverageExportGate(production); } catch (e) { message = (e as Error).message; }
    expect(message, "the unjudged beats are not named").toContain("s2b0");
    expect(message, "the scale is missing").toMatch(/4 of 8 beat\(s\)/);
    expect(message, "the outage count is missing").toContain("23");
    expect(message, "the gate's own summary is not carried through").toContain("gate could not ask");
    expect(message, "no remedy is offered").toMatch(/OpenAI credit|Gemini key/);
  });

  /** One unjudged beat is enough — this is not a majority rule. */
  it("one unjudged beat among many judged ones is enough", () => {
    expect(() =>
      assertVisionCoverageExportGate({
        providerUnavailable: 1,
        beats: [judged(0, 0), judged(0, 1), judged(0, 2), unjudged(0, 3)],
      })
    ).toThrow(/1 of 4 beat\(s\)/);
  });
});

/* ═══════════════════════ what it must NOT refuse ═══════════════════════ */

describe("a render that was not blind still ships", () => {
  /**
   * The condition that keeps this from being a tripwire on every thrifty render. A budget
   * ceiling, a missing frame and a switched-off gate all produce unjudged beats, and none of
   * them means a provider was unreachable.
   */
  it("unjudged beats with no outage are not this gate's business", () => {
    expect(() =>
      assertVisionCoverageExportGate({
        providerUnavailable: 0,
        beats: [unjudged(0, 0), unjudged(0, 1), unjudged(0, 2)],
      })
    ).not.toThrow();
  });

  /** An outage that cost only candidates nobody used is a slow render, not a bad video. */
  it("an outage that left no footage unjudged is not a failure", () => {
    expect(() =>
      assertVisionCoverageExportGate({
        providerUnavailable: 40,
        beats: [judged(0, 0), judged(0, 1), emptyBeat(0, 2)],
      })
    ).not.toThrow();
  });

  /** A beat with no real footage carries nothing that needed approving. */
  it("beats without real footage never trigger it", () => {
    expect(() =>
      assertVisionCoverageExportGate({
        providerUnavailable: 12,
        beats: [emptyBeat(0, 0), emptyBeat(0, 1)],
      })
    ).not.toThrow();
  });

  it("a render with no beats at all does not throw", () => {
    expect(() =>
      assertVisionCoverageExportGate({ providerUnavailable: 5, beats: [] })
    ).not.toThrow();
  });

  /** Both conditions are required; neither alone is a defect. */
  it("needs the outage AND the unjudged footage together", () => {
    expect(() =>
      assertVisionCoverageExportGate({ providerUnavailable: 0, beats: [unjudged(0, 0)] })
    ).not.toThrow();
    expect(() =>
      assertVisionCoverageExportGate({ providerUnavailable: 9, beats: [judged(0, 0)] })
    ).not.toThrow();
    expect(() =>
      assertVisionCoverageExportGate({ providerUnavailable: 9, beats: [unjudged(0, 0)] })
    ).toThrow();
  });
});

/* ═══════════════════════ the counter it rests on ═══════════════════════ */

describe("providerUnavailable counts outages and nothing else", () => {
  it("a fresh render starts at zero", () => {
    expect(createBeatImageGateState().judgementsProviderUnavailable).toBe(0);
  });

  /**
   * It is a strict subset of the declines, and separate from them. Folding it into
   * `judgementsSkipped` would make "the budget ran out" and "nobody was home" the same number,
   * which is the confusion the whole vocabulary exists to prevent.
   */
  it("is separate from the skipped counter it is a subset of", () => {
    const state: BeatImageGateState = createBeatImageGateState();
    expect(Object.keys(state)).toContain("judgementsSkipped");
    expect(Object.keys(state)).toContain("judgementsProviderUnavailable");
  });

  /**
   * THE COUNTER MUST ACTUALLY BE FED — the half a unit test cannot reach.
   *
   * Everything above drives `assertVisionCoverageExportGate` with numbers handed to it. If nothing
   * increments the counter in the real gate, every one of those tests still passes and the export
   * gate never fires in production. Removing both increments was caught by no test until this one.
   *
   * Reaching the increment for real would mean making `invokeLLM` fail on demand — a simulated
   * provider, which this project does not allow. So the two branches are pinned by source: they
   * are the two `isLlm…` error classifiers, and they are the ONLY places that may increment.
   */
  it("both provider-outage branches increment it, and only those", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

    for (const classifier of ["isLlmPreflightRefusal(err)", "isLlmProviderUnavailable(err)"]) {
      const at = src.indexOf(`if (${classifier}) {`);
      expect(at, `${classifier} is gone — the outage counter has no source`).toBeGreaterThan(-1);
      const branch = src.slice(at, src.indexOf("}", src.indexOf("return declined", at)));
      expect(
        branch,
        `${classifier} no longer counts the outage — the export gate can never fire`
      ).toContain("state.judgementsProviderUnavailable++");
    }

    const increments = [...src.matchAll(/judgementsProviderUnavailable\+\+/g)];
    expect(
      increments.length,
      "a decline that is NOT a provider outage counts as one — a spent budget would block a render"
    ).toBe(2);
  });

  /** The ordinary declines must stay out of it, or a thrifty render reads as a blind one. */
  it("budget, frame and disabled declines do not count as an outage", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    for (const decline of [
      'declined("gate disabled")',
      'declined("render judgement budget spent")',
      'declined("no frame available")',
      'declined("no narration to judge against")',
    ]) {
      const at = src.indexOf(decline);
      expect(at, `${decline} has moved`).toBeGreaterThan(-1);
      const around = src.slice(Math.max(0, at - 200), at);
      expect(
        around,
        `${decline} was made to count as a provider outage — a render that was merely thrifty ` +
          "would now be refused"
      ).not.toContain("judgementsProviderUnavailable++");
    }
  });
});

/* ═══════════════════════ nothing was loosened to make this pass ═══════════════════════ */

describe("the gate still fails open per clip", () => {
  /**
   * The refusal is at EXPORT, not at the clip. The gate must keep adopting when it cannot judge —
   * a model outage that empties a montage is the failure mode RONDE 58 wrote fail-open to avoid.
   * What changed is only that the finished render is no longer called good.
   */
  it("per-clip behaviour is untouched — the check is at export time", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate, "the gate no longer fails open").toContain("Fail open, always.");
    expect(gate).toContain('process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false"');

    const quality = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(quality, "the export gate is missing").toContain("assertVisionCoverageExportGate");

    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe, "the pipeline never calls the export gate").toContain(
      "assertVisionCoverageExportGate({"
    );
    expect(pipe, "the gate is fed something other than the outage counter").toContain(
      "visualDedup.beatImageGate.judgementsProviderUnavailable"
    );
  });

  /** The existing coverage gate keeps its own job — this is a second question, not a rewrite. */
  it("the existing visual coverage gate still runs", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("assertVisualCoverageExportGate(qualityReport,");
  });
});
