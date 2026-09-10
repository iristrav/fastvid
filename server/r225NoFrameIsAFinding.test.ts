/**
 * RONDE 225 — THE LAST SILENT STEP IN THE CHAIN THAT EMPTIED THREE RENDERS.
 *
 * The chain, established over rounds 223–224 and narrowed by elimination against the logs:
 *
 *     no frames sampled
 *       → judgeBeatImage declines with "no frame available"
 *       → the decline is `evaluated: false`
 *       → that reads as `vision=NOT_ASKED`
 *       → the adoption guard refuses a candidate it has already found ELIGIBLE
 *       → the beat loops, the scene ends empty, the export gate blocks
 *
 * Video 576 did that seventy-four times. What made it undiagnosable is where the chain begins.
 *
 * `extractFrameAtFraction` reports every failure it can — throttled to one line a minute — except
 * one. A video path that is not on disk returns `false` WITHOUT throwing, so `sampleFrames`'s
 * `.catch(() => false)` never fires and the throttled warning never prints. Nothing anywhere says
 * the file was missing.
 *
 * MEASURED, and this is the whole reason to look here: video 576 has ZERO
 * `extractFrameAtFraction failed` lines while failing for want of judged footage; video 574, which
 * delivered, has two. At a sixty-second throttle, eleven minutes of genuinely failing extraction
 * would print roughly ten. Zero failures AND zero usable frames is the signature of the one path
 * that reports neither.
 *
 * Reporting only. No verdict changes, no gate moves, no threshold moves.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { extractFrameAtFraction } from "./localClipVision";

const VISION = fs.readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
const RELEVANCE = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");

/* ═══════════ 1. a missing clip says so ═══════════ */

describe("R225 §1 — the file that is not there", () => {
  it("THE SILENT RETURN IS GONE", () => {
    expect(
      VISION,
      "a missing clip still returns false without a word"
    ).not.toContain("if (!fs.existsSync(videoPath)) return false;");
  });

  it("it warns, and names the file", () => {
    const at = VISION.indexOf("if (!fs.existsSync(videoPath)) {");
    expect(at).toBeGreaterThan(0);
    const block = VISION.slice(at, at + 700);
    expect(block).toContain("console.warn");
    expect(block).toContain("path.basename(videoPath)");
    expect(block).toContain("the file is not");
  });

  it("AND SAYS WHAT IT COSTS — the reader should not have to know the chain", () => {
    const at = VISION.indexOf("if (!fs.existsSync(videoPath)) {");
    expect(VISION.slice(at, at + 700)).toContain("NOT_ASKED");
  });

  it("STILL RETURNS false — the behaviour is unchanged", () => {
    const at = VISION.indexOf("if (!fs.existsSync(videoPath)) {");
    const block = VISION.slice(at, at + 700);
    expect(block).toContain("return false;");
    expect(block, "the missing-file path started throwing").not.toContain("throw ");
  });

  it("on its own throttle, so one silence cannot mask the other", () => {
    expect(VISION).toContain("let lastMissingClipLogMs = 0;");
    const at = VISION.indexOf("if (!fs.existsSync(videoPath)) {");
    const block = VISION.slice(at, at + 700);
    expect(block).toContain("lastMissingClipLogMs");
    expect(block, "it shares the extraction clock").not.toContain("lastFrameExtractFailureLogMs");
  });

  it("the extraction failure path keeps its own warning, untouched", () => {
    expect(VISION).toContain("lastFrameExtractFailureLogMs = now;");
    expect(VISION).toContain("extractFrameAtFraction failed for");
  });

  it("MEASURED: a path that does not exist returns false and does not throw", async () => {
    const missing = path.join(os.tmpdir(), `r225-absent-${Date.now()}.mp4`);
    expect(fs.existsSync(missing)).toBe(false);
    await expect(
      extractFrameAtFraction(missing, path.join(os.tmpdir(), "r225-out.jpg"), 0.5, 2_000)
    ).resolves.toBe(false);
  });
});

/* ═══════════ 2. an empty sample is announced by the beat that paid for it ═══════════ */

describe("R225 §2 — no frames is a finding", () => {
  const fn = () => {
    const at = RELEVANCE.indexOf("async function sampleFrames(");
    expect(at).toBeGreaterThan(0);
    return RELEVANCE.slice(at, RELEVANCE.indexOf("function discardFrames("));
  };

  it("AN EMPTY RESULT IS REPORTED", () => {
    expect(fn(), "sampleFrames still returns nothing, quietly").toContain("if (out.length === 0)");
  });

  it("named by scene and beat, so the loop can be found in a log", () => {
    const f = fn();
    expect(f).toContain("ctx.sceneIndex");
    expect(f).toContain("ctx.beatIndex");
    expect(f).toContain("[BeatRelevance]");
  });

  it("AND SAYS WHETHER THE FILE EXISTED — the fact that separates the two causes", () => {
    expect(fn()).toContain("onDisk=${fs.existsSync(clipPath)}");
  });

  it("it warns rather than logs — an unjudgeable clip is not routine", () => {
    expect(fn()).toContain("console.warn");
  });

  it("NOTHING ELSE CHANGED — the sampling loop is as it was", () => {
    const f = fn();
    expect(f).toContain("extractFrameAtFraction(");
    expect(f).toContain(".catch(() => false)");
    expect(f).toContain("if (got) out.push(framePath);");
    expect(f, "the round started inventing frames").not.toContain("push(clipPath)");
  });

  it("the caller's own decline is untouched — this reports, it does not rescue", () => {
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain('if (usable.length === 0) return declined("no frame available");');
    expect(gate).toContain('if (dataUrls.length === 0) return declined("frames not usable as images");');
  });
});
