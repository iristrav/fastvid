/**
 * DID THE CINEMATIC EDITING ACTUALLY HAPPEN?
 *
 * ── The measurements that were taken and thrown away ────────────────────────────────────────
 *
 * `RenderedTimeline` carries `captionsDrawn`, `textsDrawn`, `transitionsRendered`,
 * `camerasExecuted`, `duckedTracks` and `ffmpegCommands`. Every one is a real count taken while
 * ffmpeg ran. The render job printed the graphics renderer and the clip count, and dropped the
 * rest.
 *
 * So four separate questions had no answer in the log:
 *
 *   did the captions get drawn?
 *   were there transitions, or just cuts?
 *   did any camera move?
 *   did anything duck under the narrator?
 *
 * Each could only be approached by noticing what was ABSENT from the log and inferring — the
 * guesswork this codebase keeps removing. A montage of pure hard cuts and a montage whose twelve
 * crossfades all failed to execute are the same file and a completely different problem.
 *
 * ── What this deliberately does not claim ───────────────────────────────────────────────────
 *
 * That the pixels are in the delivered file. These are counts of what the renderer drew, not an
 * inspection of the output. Proving a caption is legible in an MP4 needs OCR over sampled frames;
 * claiming it without that would be the fabricated validation this system has spent rounds
 * removing. Captions are therefore MEASURED AT THE RENDERER and NOT PRODUCTION VALIDATED in the
 * file, and the code says so where a reader will meet it.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const worker = () => fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");

describe("the render says what it executed, not only that it finished", () => {
  it("reports every measurement the renderer took", () => {
    const src = worker();
    for (const field of [
      "clips=${rendered.clipsRendered}",
      "cameras=${rendered.camerasExecuted}",
      "transitions=${rendered.transitionsRendered}",
      "captions=${rendered.captionsDrawn}",
      "texts=${rendered.textsDrawn}",
      "audioTracks=${rendered.audioTracks}",
      "ducked=${rendered.duckedTracks}",
      "ffmpegCommands=${rendered.ffmpegCommands}",
    ]) {
      expect(src, `${field} is measured and not reported`).toContain(field);
    }
  });

  /**
   * The three editorial silences. Each is a film that renders correctly and is not the film that
   * was planned, and each reads as nothing at all in a table of counts.
   */
  it("names a montage that is nothing but hard cuts", () => {
    const src = worker();
    expect(src).toContain("NO_TRANSITIONS");
    expect(src).toContain("rendered.clipsRendered > 1 && rendered.transitionsRendered === 0");
  });

  it("names a film in which no camera moved", () => {
    const src = worker();
    expect(src).toContain("NO_CAMERA_MOVEMENT");
    expect(src).toContain("rendered.camerasExecuted === 0");
  });

  /**
   * …and says WHICH of the two it is. The plan asked for stillness, or it asked for movement the
   * renderer could not produce: an editorial outcome and a defect, reading identically as zero.
   *
   * A feature-length run measured 159 shots, 159 holds and no moves — 124 planned as `medium`,
   * whose camera rule holds unless the pacing is "exciting", and 35 as archive video held by an
   * explicit rule. Nothing had failed, and the warning could not say so.
   */
  it("tells a deliberate hold apart from a move that failed to execute", () => {
    const src = worker();
    expect(src).toContain("rendered.camerasPlanned === 0");
    expect(src).toContain("The PLAN asked for no movement at all");
    expect(src).toContain("that is a renderer failure, not an editorial choice");
    // And the line reports both numbers, so the ratio is readable without the warning firing.
    expect(src).toContain("cameras=${rendered.camerasExecuted}/${rendered.camerasPlanned}");
  });

  /**
   * Planned and executed must be decided by the SAME function, or "planned 12, executed 0" could
   * mean the two disagree about what counts as a move rather than that anything went wrong.
   */
  it("counts planned and executed moves through one definition", () => {
    const fs2 = require("fs") as typeof import("fs");
    const path2 = require("path") as typeof import("path");
    const renderer = fs2.readFileSync(path2.join(__dirname, "timelineRenderer.ts"), "utf8");
    const at = renderer.indexOf("camerasExecuted: rendered.filter(");
    const end = renderer.indexOf("renderedClipIds:", at);
    expect(at).toBeGreaterThan(-1);
    const block = renderer.slice(at, end);
    expect([...block.matchAll(/cameraChain\(/g)]).toHaveLength(2);
    expect(block).toContain("camerasPlanned: clips.filter(");
  });

  it("names a mix in which nothing ducked under the narrator", () => {
    const src = worker();
    expect(src).toContain("NOTHING_DUCKED");
    expect(src).toContain("rendered.audioTracks > 1 && rendered.duckedTracks === 0");
  });

  /**
   * A single-shot film has nothing to transition between, and a film with one audio track has
   * nothing to duck. Warning on those would train a reader to ignore the warnings.
   */
  it("does not warn where the condition is impossible rather than unmet", () => {
    const src = worker();
    expect(src).toContain("rendered.clipsRendered > 1 && rendered.transitionsRendered === 0");
    expect(src).toContain("rendered.audioTracks > 1 && rendered.duckedTracks === 0");
  });

  /**
   * The honesty clause. Anyone reading this line will want to conclude the captions are in the
   * file, and they are not entitled to: nothing here reads the picture back.
   */
  it("states plainly that these are render counts and not an inspection of the file", () => {
    const src = worker();
    expect(src).toContain("What this line does NOT prove");
    expect(src).toContain("not an inspection of the output");
    expect(src).toContain("needs OCR over sampled frames");
  });

  /**
   * Reported, never blocking. A film with no camera movement is still a film, and a render that
   * finished is not thrown away over a heuristic about its style.
   *
   * The window ends at the ffprobe gate, which is the next step and whose own `fail(` is correct
   * and must stay — a file with no video stream is not a deliverable. Reaching past it would turn
   * this into a test of where that gate happens to sit.
   */
  it("none of the editorial silences fails the render", () => {
    const src = worker();
    const at = src.indexOf("NO_TRANSITIONS");
    const end = src.indexOf("6a. the ffprobe gate", at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    expect(src.slice(at, end)).not.toContain("fail(");
  });
});
