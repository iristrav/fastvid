import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  indefensibleExportConditions,
  exportGateReadiness,
  type VideoQualityReport,
} from "./videoQualityReport";
import { isInformationalSpotWarning } from "./postRenderSpotCheck";

/**
 * A BLANK FILM MAY NOT BE PUBLISHED.
 *
 * ── What was already true ───────────────────────────────────────────────────────────────────
 *
 * `spotCheckFinalVideo` samples the DELIVERED file at 12%, 38%, 62% and 88% and writes its own
 * conclusion into the warnings:
 *
 *     `Final video appears fully black (worst luma ...)`
 *
 * `isInformationalSpotWarning` then singles that sentence out — together with "Final video missing
 * or too small" — as the one kind of warning that is NOT informational, which is exactly what makes
 * `ok: blockingWarnings.length === 0` come back false. The render measured the blankness and
 * classified it as blocking.
 *
 * ── And then nothing read it ────────────────────────────────────────────────────────────────
 *
 * Both call sites in the pipeline do the same two things with `spot.ok`: a `console.warn`, and
 * `postRenderOk` into the merit score — which the availability heal can raise again. Neither
 * refuses anything, and the async branch runs the check INSIDE a `Promise.all` with the S3 upload,
 * so the file is already published by the time the verdict exists.
 *
 * A film with no picture was uploaded, scored and delivered. The same shape as `formatAssetTrace`
 * exported to no caller, `metadata.publishedAt` written as null while the ranking engine read it,
 * and `beatIndex` dropped at the one call that filed the record: a value computed, carried all the
 * way, and dropped by the only reader that needed it.
 */

/** A report with nothing wrong in it, so each test can break exactly one thing. */
function cleanReport(over: Partial<VideoQualityReport> = {}): VideoQualityReport {
  return {
    videoId: 1,
    score: 80,
    qualityStatus: "good",
    qualityReason: "",
    totalClips: 10,
    archiveCount: 10,
    stockCount: 0,
    generatedClips: 0,
    bySource: {},
    warnings: [],
    offTopicSuspects: [],
    ...over,
  } as unknown as VideoQualityReport;
}

const spot = (over: Partial<NonNullable<VideoQualityReport["postRenderSpotCheck"]>> = {}) => ({
  ok: true,
  blackFrameCount: 0,
  framesChecked: 4,
  worstMeanLuma: 120,
  warnings: [] as string[],
  ...over,
});

describe("the export gate reads the blankness the render already measured", () => {
  it("EVERY SAMPLED FRAME BLACK IS REFUSED", () => {
    const conditions = indefensibleExportConditions(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 4, framesChecked: 4, worstMeanLuma: 0 }),
      })
    );
    const hit = conditions.find((c) => c.code === "FINAL_PICTURE_IS_BLACK");
    expect(hit, "a film with no picture at any sampled point was declared deliverable").toBeTruthy();
    expect(hit!.detail).toContain("4 sampled frame(s)");
  });

  it("and the refusal says what was measured, not that something is wrong", () => {
    const [hit] = indefensibleExportConditions(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 3, framesChecked: 3, worstMeanLuma: 2 }),
      })
    ).filter((c) => c.code === "FINAL_PICTURE_IS_BLACK");
    /** The operator must be able to tell this from a scoring decision without reading the source. */
    expect(hit.detail).toContain("worst mean luma 2");
    expect(hit.detail).toContain("no picture at any point that was looked at");
  });
});

describe("what it refuses to convict on", () => {
  it("A FILM THAT WAS NEVER SAMPLED IS NOT CALLED BLANK", () => {
    /**
     * This function's own rule, stated in its header: "nothing was measured" is not evidence of a
     * bad render. A missing spot check means the probe could not run — a tool, a test, a caller
     * outside a render — and convicting on absence would refuse every one of them.
     */
    expect(indefensibleExportConditions(cleanReport())).toEqual([]);
    expect(
      indefensibleExportConditions(
        cleanReport({ postRenderSpotCheck: spot({ framesChecked: 0, blackFrameCount: 0, worstMeanLuma: null }) })
      )
    ).toEqual([]);
  });

  it("one black sample out of four is a held frame, not an empty render", () => {
    /**
     * The warning that prompted this fires on `worstMeanLuma < 1` — ONE dark sample — while its
     * sentence says "fully black". Promoting it as written would refuse a film that opens on a held
     * black frame, which is an edit, not a fault. So the condition reads the COUNT.
     */
    const conditions = indefensibleExportConditions(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 1, framesChecked: 4, worstMeanLuma: 0 }),
      })
    );
    expect(conditions.find((c) => c.code === "FINAL_PICTURE_IS_BLACK")).toBeUndefined();
  });

  it("and a night sequence — two of four dark — still ships", () => {
    const conditions = indefensibleExportConditions(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 2, framesChecked: 4, worstMeanLuma: 4 }),
      })
    );
    expect(conditions.find((c) => c.code === "FINAL_PICTURE_IS_BLACK")).toBeUndefined();
  });

  it("a single sample is not enough to convict a whole film", () => {
    const conditions = indefensibleExportConditions(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 1, framesChecked: 1, worstMeanLuma: 0 }),
      })
    );
    expect(conditions.find((c) => c.code === "FINAL_PICTURE_IS_BLACK")).toBeUndefined();
  });
});

describe("the readiness list never reports an unsampled film as a pass", () => {
  const policy = { hardTier: false, blockVisualMismatch: false, strictQuality: false, minScore: 45 };

  it("THE NEW GATE APPEARS IN THE LIST AT ALL", () => {
    /**
     * The whole point of `exportGateReadiness` is that an operator learns about every refusal in
     * one render instead of one per render. A gate that can throw and is missing from the list
     * rebuilds exactly the problem that list was written to solve.
     */
    const gates = exportGateReadiness(cleanReport(), 0, policy);
    expect(gates.map((g) => g.gate)).toContain("final_picture_is_black");
  });

  it("and says so in words when the delivered file has not been sampled", () => {
    const row = exportGateReadiness(cleanReport(), 0, policy).find(
      (g) => g.gate === "final_picture_is_black"
    )!;
    expect(row.blocking).toBe(false);
    expect(row.detail).toContain("not been sampled yet");
    expect(row.detail).toContain("not a pass");
  });

  it("reports the real counts once it has been", () => {
    const row = exportGateReadiness(
      cleanReport({ postRenderSpotCheck: spot({ blackFrameCount: 1, framesChecked: 4, worstMeanLuma: 9 }) }),
      0,
      policy
    ).find((g) => g.gate === "final_picture_is_black")!;
    expect(row.blocking).toBe(false);
    expect(row.detail).toContain("1/4 sampled frame(s) dark");
  });

  it("and turns to BLOCKS on the film the gate would refuse", () => {
    const row = exportGateReadiness(
      cleanReport({
        postRenderSpotCheck: spot({ ok: false, blackFrameCount: 4, framesChecked: 4, worstMeanLuma: 0 }),
      }),
      0,
      policy
    ).find((g) => g.gate === "final_picture_is_black")!;
    expect(row.blocking).toBe(true);
  });
});

describe("nothing was loosened to make room for it", () => {
  const QR = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
  const SPOT = readFileSync(join(__dirname, "postRenderSpotCheck.ts"), "utf8");

  it("the two existing indefensible conditions are untouched", () => {
    expect(QR).toContain("const UNVERIFIED_CLIP_SHARE_LIMIT = 0.5;");
    const beats = indefensibleExportConditions(
      cleanReport({ beatVisuals: { beats: 16, verifiedOwnVisual: 0, ownFootage: 0, byVerification: { never_asked: 16 } } as never })
    );
    expect(beats.map((c) => c.code)).toContain("NO_VERIFIED_OWN_VISUAL");
  });

  it("THE CONDITION IS UNCONDITIONAL — no flag has to be remembered", () => {
    /**
     * RONDE 89's reason, which applies unchanged here: render 568 shipped because every switch that
     * could have stopped it was off. A blank film must not need a flag either.
     */
    const fn = QR.slice(QR.indexOf("export function indefensibleExportConditions"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/process\.env|envFlagIs|Enabled\(\)/);
  });

  it("and the spot check's own classification still calls a blank film blocking", () => {
    /** If this ever became informational, the gate above would go quiet without a line changing. */
    expect(isInformationalSpotWarning("Final video appears fully black (worst luma 0)")).toBe(false);
    expect(isInformationalSpotWarning("Final video missing or too small")).toBe(false);
    expect(SPOT).toContain("Final video appears fully black");
  });

  it("the warning itself was not rewritten to fit the gate", () => {
    /**
     * It fires on `worstMeanLuma < 1` and says "appears". That is a warning doing warning's work;
     * the gate reads the stricter count instead of bending the warning to match it.
     */
    expect(SPOT).toContain("(worstMeanLuma ?? 255) < 1");
    expect(SPOT).toContain("const BLACK_LUMA_THRESHOLD = 22;");
    expect(SPOT).toContain("const SAMPLE_FRACTIONS = [0.12, 0.38, 0.62, 0.88];");
  });
});

describe("the gate runs after the measurement exists", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("THE SPOT CHECK IS RECORDED BEFORE THE EXPORT GATE IS ASKED", () => {
    /**
     * Ordering is the whole fix. `enforceQualityExportGate` reads `qualityReport`, so a spot check
     * written after it would leave the condition permanently invisible — a gate that exists and
     * never fires, which is indistinguishable from not having written it.
     */
    const recorded = PIPE.indexOf("qualityReport.postRenderSpotCheck = {");
    const gate = PIPE.indexOf("enforceQualityExportGate(videoId, qualityReport");
    expect(recorded).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(recorded).toBeLessThan(gate);
  });

  it("and a refused film is still kept where the person who asked for it can see it", () => {
    /**
     * RONDE 202's rule, which this gate now also depends on: a blocked export writes `failed` AND
     * the location of the refused file. A blank render the operator cannot open is a bug report
     * with the evidence deleted.
     */
    expect(PIPE).toContain("recordBlockedExport(videoId, url,");
  });
});
