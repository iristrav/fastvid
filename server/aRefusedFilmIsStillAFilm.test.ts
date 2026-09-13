import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  visionCoverageRefusal,
  assertVisionCoverageExportGate,
  type VisionCoverageBeat,
} from "./videoQualityReport";

/**
 * REFUSING TO PUBLISH A FILM AND DESTROYING IT ARE NOT THE SAME ACT.
 *
 * ── What render 580 cost ────────────────────────────────────────────────────────────────────
 *
 *     [Pipeline] Stage 4 (compose): 3 scenes in 3788.7s
 *     [Hang] composeSceneVideo EXIT s0 out=.../scene_0_composed.mp4
 *     [Hang] composeSceneVideo EXIT s1 out=.../scene_1_composed.mp4
 *     [Hang] composeSceneVideo EXIT s2 out=.../scene_2_composed.mp4
 *     [Video Generation] Error: Render rejected — the picture editor was unreachable ...
 *
 * Sixty-three minutes, three finished scenes on disk, and the operator received nothing at all.
 * Stage 5 never ran, so there was no assembled film, no upload, no URL — and the container is
 * reclaimed afterwards. The verdict was correct: every vision provider was gone (219x "no
 * vision-capable provider", 7x gemini 403, 4x timeout) and a beat of real footage had no verdict.
 * What was wrong is that the operator could not look at the thing that had been judged.
 *
 * ── The rule that already existed and did not reach this gate ───────────────────────────────
 *
 * RONDE 202 settled it for every gate downstream of the upload, and built `recordBlockedExport` to
 * write `failed` AND the refused file's location in one statement. Its closing sentence is the
 * whole principle: "This is only the difference between 'may not go out' and 'does not exist'."
 *
 * That protection sits at the export-gate block. This gate threw about twelve hundred lines
 * earlier — before the concatenation, before the music, before anything was uploaded — so it fell
 * outside the one rule written to cover exactly this case.
 *
 * ── What this changes, and what it deliberately does not ────────────────────────────────────
 *
 * Only WHEN the refusal is thrown. The two conditions, the message, the error code and the `failed`
 * status are identical. Nothing is published that was not published before: a blocked export is
 * still `failed`, still carries the reason, and is never `completed`.
 */

const beat = (sceneIndex: number, beatIndex: number, verdicts: number, hasRealFootage = true): VisionCoverageBeat =>
  ({ sceneIndex, beatIndex, verdicts, hasRealFootage });

/** Render 580's shape: providers gone, one beat of real footage with no verdict. */
const RENDER_580 = {
  providerUnavailable: 228,
  beats: [beat(0, 0, 3), beat(1, 0, 2), beat(2, 2, 0)],
  noVerdictSummary: "[BeatImageGate] no verdict: 219x gate could not ask",
};

describe("the refusal itself is unchanged", () => {
  it("RENDER 580 IS STILL REFUSED", () => {
    const refusal = visionCoverageRefusal(RENDER_580);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain("1 of 3 beat(s) with real footage received no verdict");
    expect(refusal).toContain("s2b2");
    expect(refusal).toContain("228 judgement(s) were declined");
  });

  it("and the message still names the way out without recommending the shortcut", () => {
    const refusal = visionCoverageRefusal(RENDER_580)!;
    expect(refusal).toContain("Restore a vision provider");
    /** The escape hatch is named with its price attached, never as advice. */
    expect(refusal).toContain("only if you accept unjudged footage");
  });

  it("BOTH CONDITIONS ARE STILL REQUIRED — a thrifty render is not a blind one", () => {
    /**
     * The gate's own rule. A budget ceiling, a missing frame or the gate being switched off are the
     * render working as configured; only an unreachable PROVIDER counts, and only when real footage
     * actually reached an unjudged beat.
     */
    expect(visionCoverageRefusal({ ...RENDER_580, providerUnavailable: 0 })).toBeNull();
    expect(
      visionCoverageRefusal({ ...RENDER_580, beats: [beat(0, 0, 3), beat(1, 0, 2)] })
    ).toBeNull();
    /** An outage that cost only candidates nobody used is not a refusal either. */
    expect(
      visionCoverageRefusal({ ...RENDER_580, beats: [beat(2, 2, 0, false)] })
    ).toBeNull();
  });

  it("the thrown form and the value form say exactly the same thing", () => {
    let thrown = "";
    try {
      assertVisionCoverageExportGate(RENDER_580);
    } catch (e) {
      thrown = (e as Error).message;
    }
    /**
     * Contains rather than equals: `pipelineError` appends its own numeric code to the message
     * (`… (10115)`), which is the error channel's business and not the gate's sentence. The
     * guarantee that matters is that the value form and the thrown form carry the same reasoning.
     */
    expect(thrown).toContain(visionCoverageRefusal(RENDER_580));
    expect(thrown).toContain("10115");
  });

  it("and a clean render throws nothing", () => {
    expect(() =>
      assertVisionCoverageExportGate({ providerUnavailable: 0, beats: [beat(0, 0, 0)] })
    ).not.toThrow();
  });
});

describe("the refused film is kept where the operator can see it", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("THE GATE IS DECIDED BEFORE STAGE 5 AND THROWN AFTER THE UPLOAD", () => {
    /**
     * The whole point. Deciding early keeps the evidence exactly what it was — the beat audit at
     * the moment it is complete — while throwing late puts the refusal inside the block that
     * records a blocked export against its film.
     */
    const decided = PIPE.indexOf("const visionCoverageBlock = visionCoverageRefusal(visionCoverageParams)");
    const stage5 = PIPE.indexOf("Stage 5: Concatenate");
    const thrown = PIPE.indexOf("assertVisionCoverageExportGate(visionCoverageParams)");
    const upload = PIPE.indexOf("storagePutFromFile(`videos/${videoId}/final.mp4`");

    expect(decided).toBeGreaterThan(-1);
    expect(decided, "the verdict must be taken while the beat audit is complete").toBeLessThan(stage5);
    expect(upload, "the film must be uploaded before the refusal is thrown").toBeLessThan(thrown);
  });

  it("AND THE THROW SITS IN THE BLOCK THAT RECORDS THE BLOCKED EXPORT", () => {
    /**
     * Render 580's actual loss. A throw one line outside this `try` would read as fixed and lose
     * the film exactly as before, which is why the position is asserted rather than the intent.
     */
    const thrown = PIPE.indexOf("assertVisionCoverageExportGate(visionCoverageParams)");
    const record = PIPE.indexOf("recordBlockedExport(videoId, url,");
    expect(record).toBeGreaterThan(thrown);
    const between = PIPE.slice(thrown, record);
    expect(between, "the refusal is not inside the blocked-export try").toContain("catch (gateError)");
  });

  it("the operator hears about it at the moment it is decided, not only at the end", () => {
    /**
     * Sixty-three minutes is a long time to be told nothing. The render still finishes the assembly
     * — that is the point — but the log says why from the moment the evidence is in.
     */
    expect(PIPE).toContain("[VisionCoverage] EXPORT WILL BE BLOCKED");
    expect(PIPE).toContain("finishing the assembly anyway so the refused film can be looked at");
  });

  it("IT IS REPORTED BEFORE THE OTHER EXPORT GATES", () => {
    /**
     * When more than one gate would refuse, unjudged footage on screen is the graver finding and
     * the one RONDE 562 exists for — so it is the reason the operator is given.
     */
    const vision = PIPE.indexOf("assertVisionCoverageExportGate(visionCoverageParams)");
    const quality = PIPE.indexOf("enforceQualityExportGate(videoId, qualityReport");
    expect(vision).toBeLessThan(quality);
  });
});

describe("nothing was weakened to stop losing the film", () => {
  const REPORT = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("A BLOCKED EXPORT IS STILL failed, NEVER completed", () => {
    const DB = readFileSync(join(__dirname, "db.ts"), "utf8");
    const fn = DB.slice(DB.indexOf("export async function recordBlockedExport"));
    expect(fn.slice(0, 900)).toContain('status: "failed"');
    expect(fn.slice(0, 900)).toContain("videoUrl,");
  });

  it("the gate keeps both of its conditions in the source, not only in the tests", () => {
    const fn = REPORT.slice(REPORT.indexOf("export function visionCoverageRefusal"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("if (params.providerUnavailable <= 0) return null;");
    expect(body).toContain("b.hasRealFootage && b.verdicts === 0");
  });

  it("and no other export gate was moved or removed", () => {
    expect(PIPE).toContain("assertVisualCoverageExportGate(qualityReport");
    expect(PIPE).toContain("enforceQualityExportGate(videoId, qualityReport");
    expect(REPORT).toContain("FINAL_PICTURE_IS_BLACK");
    expect(REPORT).toContain("NO_VERIFIED_OWN_VISUAL");
    expect(REPORT).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  it("the assert wrapper still has a production caller", () => {
    /**
     * It would otherwise be an export whose only callers are tests — the shape this codebase has
     * now found four times (`formatAssetTrace`, `metadata.publishedAt`, `beatIndex`,
     * `externalVisualSourcingEnabled`). The pipeline throws through it rather than around it.
     */
    expect(PIPE).toContain("assertVisionCoverageExportGate(visionCoverageParams)");
  });
});
