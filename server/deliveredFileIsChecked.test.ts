/**
 * THE CHECKS MUST LOOK AT THE FILE THAT SHIPS.
 *
 * ── What the audit found ────────────────────────────────────────────────────────────────────
 *
 * Black-frame detection, freeze detection, silence detection, the stillness audit and the
 * repetition audit all run on `finalVideoPath` — the compose montage — at videoPipeline.ts:40671
 * onwards. The cinematic render runs afterwards and uploads to a different storage key entirely.
 * `finalVideoPath` is never reassigned.
 *
 * So after the delivery cutover, the file a viewer receives was inspected by ffprobe alone —
 * existence, byte size, stream presence, width/height/fps, duration — and every check that can
 * tell a finished documentary from six minutes of black was pointed at a file nobody would ever
 * see. Worse, `qualityReport.postRenderSpotCheck` reported those numbers as though they described
 * the delivery. A report about a different video is worse than no report, because it reads as
 * reassurance.
 *
 * ── The two properties guarded here ─────────────────────────────────────────────────────────
 *
 *   1. the render job runs the content check on its own output, before the work directory is swept
 *   2. the pipeline replaces the compose numbers with the delivered ones when the cutover happened,
 *      and leaves them alone when the compose file IS the deliverable
 *
 * Property 2 lives inside a 41,000-line function with a database, ffmpeg and a queue in it, so it
 * is asserted at source level. That is a weak test and it is not pretending otherwise; the
 * alternative for those lines is nothing at all, and each of them is a line whose deletion silently
 * restores a report about the wrong file.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { postRenderSpotCheckEnabled } from "./postRenderSpotCheck";

/* ═══════════════════════ the render job checks its own output ═══════════════════════ */

describe("the render job inspects the file it is about to deliver", () => {
  const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");

  it("runs the content check on the rendered file, not on a path from elsewhere", () => {
    expect(worker).toContain("spotCheckFinalVideo(outputPath)");
  });

  /**
   * Order is the whole test. The job's `finally` block removes its work directory; a check placed
   * after that inspects a path that no longer exists, and `spotCheckFinalVideo` answers
   * "missing or too small" — a warning that looks like a finding and is an artefact.
   */
  it("checks before the work directory is swept", () => {
    const checkAt = worker.indexOf("spotCheckFinalVideo(outputPath)");
    const sweepAt = worker.indexOf("fs.rmSync(workDir");
    expect(checkAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(sweepAt);
  });

  /**
   * Reported, never blocking — the same policy the compose path has always had. Spot-check
   * warnings are frequently about material that is legitimately dark or legitimately quiet: a
   * night-time archive shot, a held beat before a chapter card. Failing a finished render on a
   * heuristic would throw away a good video.
   */
  it("does not fail the render on a content warning", () => {
    /**
     * Bounded to the content-check block itself — up to the upload step that follows it. The
     * upload's own `fail(OUTPUT_UPLOAD_FAILED)` is correct and must stay; a fixed character window
     * would swallow it and turn this into a test of where the upload happens to sit.
     */
    const at = worker.indexOf("spotCheckFinalVideo(outputPath)");
    const uploadAt = worker.indexOf("/* 7. upload to a key", at);
    expect(at).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(at);
    expect(worker.slice(at, uploadAt)).not.toContain("fail(");
  });

  it("survives a check that throws, rather than losing a finished render to it", () => {
    expect(worker).toContain("spotCheckFinalVideo(outputPath).catch(() => null)");
  });

  it("hands the result back to the caller instead of only logging it", () => {
    expect(worker).toContain("spotCheck: PostRenderSpotCheckResult | null;");
    expect(worker).toContain("spotCheck };");
  });

  it("respects the existing switch rather than adding a second one", () => {
    expect(worker).toContain("postRenderSpotCheckEnabled()");
    expect(typeof postRenderSpotCheckEnabled()).toBe("boolean");
  });
});

/* ═══════════════════════ the report describes the delivery ═══════════════════════ */

describe("the quality report describes the file that was delivered", () => {
  const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("overwrites the compose numbers with the delivered file's", () => {
    expect(pipeline).toContain("if (jobOutcome.spotCheck) {");
    expect(pipeline).toContain("qualityReport.postRenderSpotCheck = {");
    expect(pipeline).toContain("Delivered file:");
  });

  /**
   * Only on the delivering path. When the cinematic render did not produce the file, the compose
   * montage IS the deliverable and its own numbers are the correct ones — overwriting them would
   * reintroduce the same bug pointing the other way.
   */
  it("only overwrites when the cinematic render actually delivered", () => {
    const okAt = pipeline.indexOf("cinematicDeliveredUrl = jobOutcome.outputUrl;");
    const spotAt = pipeline.indexOf("if (jobOutcome.spotCheck) {");
    const refusalAt = pipeline.indexOf("cinematicRefusal = `${jobOutcome.code}");
    expect(okAt).toBeGreaterThan(-1);
    expect(spotAt).toBeGreaterThan(okAt);
    expect(spotAt).toBeLessThan(refusalAt);
  });

  /**
   * The overwrite is pointless if the record was already written. The final `mergeVideoMetadata`
   * has to run after the cinematic block, or the stored report keeps the compose numbers whatever
   * this code does to the in-memory object.
   */
  it("is written before the record is persisted, not after", () => {
    const spotAt = pipeline.indexOf("if (jobOutcome.spotCheck) {");
    const persistAt = pipeline.lastIndexOf("await mergeVideoMetadata(videoId, {");
    expect(persistAt).toBeGreaterThan(spotAt);
  });
});
