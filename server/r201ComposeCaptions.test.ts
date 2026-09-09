/**
 * RONDE 201 — the subtitle switch that could not affect a frame.
 *
 * `const subtitleDrawtext = enableSubtitles ? "" : "";` — both branches empty, on the route that
 * delivers whenever the cinematic render does not. And the line under it drops the fragment again
 * when the documentary look is on, so there were two dead ends in adjacent lines.
 *
 * These tests hold the formatter to the two rules that make a subtitle better than no subtitle:
 * it says exactly what was spoken, and it says it exactly when it was spoken. Everything else —
 * wrapping, minimum duration, no overlap — follows from a viewer being able to read it.
 *
 * The last block burns a file with the real ffmpeg and reads the frames back, because "libass is
 * available" and "this filter string draws characters on this video" are different claims and only
 * the second one is the feature.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captionForceStyle,
  escapeFilterPath,
  planSceneCaptions,
  renderSrt,
  srtTimestamp,
  wrapCaptionText,
  writeSceneCaptionFilter,
} from "./composeCaptions";

const beat = (text: string, voiceStartSec?: number, voiceEndSec?: number) => ({
  text,
  ...(voiceStartSec != null ? { voiceStartSec } : {}),
  ...(voiceEndSec != null ? { voiceEndSec } : {}),
});

/* ═══════════ 1. the timing is measured, never guessed ═══════════ */

describe("R201 §1 — a caption is only as good as the timing under it", () => {
  it("uses the beat's own measured voice window", () => {
    const plan = planSceneCaptions([beat("The bunker lay beneath the garden.", 1.5, 4.25)], 20);
    expect(plan.cues).toHaveLength(1);
    expect(plan.cues[0]!.startSec).toBeCloseTo(1.5, 3);
    expect(plan.cues[0]!.endSec).toBeCloseTo(4.25, 3);
  });

  it("A BEAT WITH NO MEASURED WINDOW GETS NO CAPTION, and is counted", () => {
    /**
     * The whole reason this module refuses to fall back on `holdSec`: that is a PLAN, and RONDE
     * 190 measured narration routinely running faster or slower than one. A caption timed from a
     * plan drifts against the voice it transcribes, and a drifting subtitle is worse than none.
     */
    const plan = planSceneCaptions([beat("No window was ever measured for this line.")], 20);
    expect(plan.cues).toEqual([]);
    expect(plan.skippedUnmeasured).toBe(1);
  });

  it("half a window is still no window", () => {
    expect(planSceneCaptions([beat("Only a start.", 2)], 20).skippedUnmeasured).toBe(1);
    expect(planSceneCaptions([beat("Only an end.", undefined, 5)], 20).skippedUnmeasured).toBe(1);
  });

  it("a caption never runs past the picture it sits on", () => {
    const plan = planSceneCaptions([beat("Runs long.", 8, 30)], 10);
    expect(plan.cues[0]!.endSec).toBeLessThanOrEqual(10);
  });

  it("a beat that starts after the scene ends is dropped and counted", () => {
    const plan = planSceneCaptions([beat("Never seen.", 12, 15)], 10);
    expect(plan.cues).toEqual([]);
    expect(plan.skippedOutOfRange).toBe(1);
  });
});

/* ═══════════ 2. it is readable ═══════════ */

describe("R201 §2 — readable, or not shown at all", () => {
  it("wraps to at most two lines and never breaks a word", () => {
    const lines = wrapCaptionText(
      "Hitler spent his final days in the Fuhrerbunker beneath the Chancellery"
    );
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeLessThanOrEqual(2);
    for (const l of lines!) expect(l.length).toBeLessThanOrEqual(42);
    expect(lines!.join(" ")).toBe(
      "Hitler spent his final days in the Fuhrerbunker beneath the Chancellery"
    );
  });

  it("a sentence too long for two lines is SPLIT, never truncated", () => {
    const long =
      "The Red Army had encircled the city by the twenty-fifth of April and the last defenders " +
      "were boys and old men drawn from the Volkssturm militia in the final week of the war";
    const plan = planSceneCaptions([beat(long, 0, 12)], 20);
    expect(plan.cues.length).toBeGreaterThan(1);
    // Every word survives, in order.
    expect(plan.cues.flatMap((c) => c.lines).join(" ")).toBe(long);
    /**
     * The split DIVIDES the window: no part starts before its words are spoken, and the first one
     * starts exactly where the sentence does. The last part may linger a little past the sentence
     * when its share came out too short to read — ordinary subtitling, and bounded below by the
     * scene's own length and by the next caption.
     */
    expect(plan.cues[0]!.startSec).toBeCloseTo(0, 3);
    for (const cue of plan.cues) expect(cue.startSec).toBeLessThan(12);
    expect(plan.cues.at(-1)!.endSec).toBeGreaterThanOrEqual(12);
    expect(plan.cues.at(-1)!.endSec).toBeLessThanOrEqual(20);
  });

  it("a lingering caption still never overlaps the next one or leaves the scene", () => {
    const plan = planSceneCaptions(
      [beat("A very short tail.", 0, 0.15), beat("The next line follows.", 0.5, 3)],
      4
    );
    for (const cue of plan.cues) expect(cue.endSec).toBeLessThanOrEqual(4);
    for (let i = 0; i < plan.cues.length - 1; i++) {
      expect(plan.cues[i]!.endSec).toBeLessThanOrEqual(plan.cues[i + 1]!.startSec);
    }
  });

  it("two captions are never on screen at once", () => {
    const plan = planSceneCaptions(
      [beat("First line here.", 0, 3.5), beat("Second line here.", 3.2, 6)],
      20
    );
    for (let i = 0; i < plan.cues.length - 1; i++) {
      expect(plan.cues[i]!.endSec).toBeLessThanOrEqual(plan.cues[i + 1]!.startSec);
    }
  });

  it("a flash-length caption is given time to be read", () => {
    const plan = planSceneCaptions([beat("Yes.", 2, 2.2)], 20);
    expect(plan.cues[0]!.endSec - plan.cues[0]!.startSec).toBeGreaterThanOrEqual(0.7);
  });

  it("an empty beat produces nothing at all", () => {
    expect(planSceneCaptions([beat("   ", 1, 3)], 20).cues).toEqual([]);
    expect(wrapCaptionText("   ")).toBeNull();
  });
});

/* ═══════════ 3. the file is a real SubRip document ═══════════ */

describe("R201 §3 — the file", () => {
  it("writes SubRip timestamps", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(1.5)).toBe("00:00:01,500");
    expect(srtTimestamp(3661.25)).toBe("01:01:01,250");
    expect(srtTimestamp(-4)).toBe("00:00:00,000");
  });

  it("numbers the cues from one and separates them with a blank line", () => {
    const srt = renderSrt([
      { startSec: 0, endSec: 1, lines: ["One"] },
      { startSec: 2, endSec: 3, lines: ["Two", "lines"] },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\nOne\n\n2\n00:00:02,000 --> 00:00:03,000\nTwo\nlines\n"
    );
  });

  it("no cues means no document — never an empty file with a filter pointing at it", () => {
    expect(renderSrt([])).toBe("");
  });

  it("escapes the three characters ffmpeg eats inside a filter argument", () => {
    expect(escapeFilterPath("/tmp/a:b/c'd\\e.srt")).toBe("/tmp/a\\:b/c\\'d\\\\e.srt");
  });

  it("the style scales with the frame rather than being tuned for one format", () => {
    expect(captionForceStyle(48)).toContain("FontSize=48");
    expect(captionForceStyle(48)).toContain("Alignment=2");
    // A box behind the text, so it survives a light frame as well as a dark one.
    expect(captionForceStyle(48)).toContain("BorderStyle=3");
  });
});

/* ═══════════ 4. and it really does draw on the picture ═══════════ */

describe("R201 §4 — burned in by the real ffmpeg, read back off the frames", () => {
  let dir: string;
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", ...args], { stdio: "ignore" });

  /** Mean luma of one frame. A drawn subtitle lifts it; nothing else in this clip can. */
  const meanLumaAt = (video: string, atSec: number): number => {
    const out = path.join(dir, `probe_${atSec}.txt`);
    execFileSync(
      "ffmpeg",
      ["-y", "-ss", String(atSec), "-i", video, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=" + out, "-f", "null", "-"],
      { stdio: "ignore" }
    );
    const text = fs.readFileSync(out, "utf8");
    const m = text.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    return m ? Number(m[1]) : NaN;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r201-"));
  }, 60_000);

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("the filter this module builds puts characters on the frame", () => {
    const black = path.join(dir, "black.mp4");
    ff(["-f", "lavfi", "-i", "color=c=black:s=640x360:r=25", "-t", "6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", black]);

    const built = writeSceneCaptionFilter({
      beats: [beat("BERLIN NINETEEN FORTY FIVE", 1, 4)],
      sceneOutSec: 6,
      sceneIndex: 0,
      workDir: dir,
      frameHeight: 360,
    })!;
    expect(built, "nothing was built for a beat with a measured window").not.toBeNull();
    expect(fs.existsSync(built.filePath)).toBe(true);

    const burned = path.join(dir, "burned.mp4");
    // The leading comma is what makes this spliceable onto an existing chain, so it is used the
    // way the compose route uses it rather than being stripped for the test.
    ff(["-i", black, "-vf", `format=yuv420p${built.filter}`, "-t", "6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", burned]);

    const during = meanLumaAt(burned, 2.5);
    const after = meanLumaAt(burned, 5.5);
    expect(Number.isNaN(during)).toBe(false);
    expect(during, "no characters were drawn while the caption was on screen").toBeGreaterThan(after);
  }, 300_000);

  it("nothing is written, and no filter returned, when no beat has a window", () => {
    const built = writeSceneCaptionFilter({
      beats: [beat("Unmeasured.")],
      sceneOutSec: 6,
      sceneIndex: 7,
      workDir: dir,
      frameHeight: 360,
    });
    expect(built).toBeNull();
    expect(fs.existsSync(path.join(dir, "captions_s7.srt"))).toBe(false);
  }, 60_000);
});
