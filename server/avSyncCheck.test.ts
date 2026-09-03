/**
 * THE CHECK NOBODY WAS DOING.
 *
 * FastVid measured resolution, frame rate, stream presence, black frames, freezes and silence — and
 * never once asked whether the picture and the sound line up. Every one of those gates asks about a
 * single stream on its own, so a film whose narration runs four seconds past its picture, or opens
 * on silence, or ends with the narrator cut mid-word, passed all of them.
 *
 * That last case is not hypothetical. A beat dropped for want of a provable source used to shorten
 * the picture track, and `-shortest` — bounded by the video — then cut the audio to match. Three
 * checks agreed the file was correct while it ended mid-sentence, because none of them compared the
 * two streams to each other.
 */
import { describe, expect, it } from "vitest";

import {
  EDGE_SILENCE_SEC,
  LENGTH_TOLERANCE_SEC,
  checkAvSync,
  formatAvSync,
  type StreamEnvelope,
} from "./avSyncCheck";

const healthy: StreamEnvelope = {
  videoSec: 600,
  audioSec: 600,
  firstSoundSec: 0.4,
  lastSoundSec: 599.2,
};

describe("a film whose streams agree raises nothing", () => {
  it("passes a clean envelope", () => {
    const r = checkAvSync(healthy);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  /**
   * An AAC frame does not divide evenly into a video frame, and containers round. A tolerance set
   * at zero would report every well-made film.
   */
  it("container rounding is not a finding", () => {
    const r = checkAvSync({ ...healthy, audioSec: 600 + LENGTH_TOLERANCE_SEC - 0.01 });
    expect(r.ok).toBe(true);
  });

  /** A documentary opens and closes on a beat of air. That is a choice, not a defect. */
  it("a beat of air at either end is allowed", () => {
    const r = checkAvSync({
      ...healthy,
      firstSoundSec: EDGE_SILENCE_SEC - 0.1,
      lastSoundSec: 600 - (EDGE_SILENCE_SEC - 0.1),
    });
    expect(r.ok).toBe(true);
  });
});

describe("the four ways the envelope goes wrong", () => {
  it("catches streams that disagree about how long the film is", () => {
    const r = checkAvSync({ ...healthy, audioSec: 604 });
    const f = r.findings.find((x) => x.code === "stream_length_mismatch");
    expect(f).toBeDefined();
    expect(f!.deltaSec).toBe(4);
    expect(f!.reason).toContain("longer than the video stream");
  });

  it("names which stream is longer, in both directions", () => {
    expect(
      checkAvSync({ ...healthy, audioSec: 596 }).findings[0]!.reason
    ).toContain("shorter than the video stream");
  });

  it("catches a film that opens on nothing", () => {
    const r = checkAvSync({ ...healthy, firstSoundSec: 6.5 });
    const f = r.findings.find((x) => x.code === "leading_silence");
    expect(f).toBeDefined();
    expect(f!.deltaSec).toBe(6.5);
  });

  it("catches a film that ends on silent picture", () => {
    const r = checkAvSync({ ...healthy, lastSoundSec: 570 });
    const f = r.findings.find((x) => x.code === "trailing_silence");
    expect(f).toBeDefined();
    expect(f!.deltaSec).toBe(30);
  });

  /**
   * The case a mux "fixes" by padding the picture: the container lengths agree and there is still
   * sound the viewer will never see anything under.
   */
  it("catches sound that runs past the picture even when the lengths agree", () => {
    const r = checkAvSync({ videoSec: 600, audioSec: 600, firstSoundSec: 0.2, lastSoundSec: 604 });
    const f = r.findings.find((x) => x.code === "audio_past_picture");
    expect(f).toBeDefined();
    expect(f!.deltaSec).toBe(4);
  });

  it("a missing stream is named as such rather than measured against nothing", () => {
    expect(
      checkAvSync({ videoSec: 600, audioSec: null, firstSoundSec: null, lastSoundSec: null })
        .findings.map((f) => f.code)
    ).toContain("no_audio");
    expect(
      checkAvSync({ videoSec: null, audioSec: 600, firstSoundSec: 0, lastSoundSec: 600 })
        .findings.map((f) => f.code)
    ).toContain("no_video");
  });

  /** Two missing streams is two facts, not one. */
  it("an empty file reports both absences", () => {
    const codes = checkAvSync({
      videoSec: null, audioSec: null, firstSoundSec: null, lastSoundSec: null,
    }).findings.map((f) => f.code);
    expect(codes).toContain("no_video");
    expect(codes).toContain("no_audio");
  });

  it("every finding says what is wrong in words, not only in a code", () => {
    const r = checkAvSync({ videoSec: 600, audioSec: 640, firstSoundSec: 9, lastSoundSec: 640 });
    expect(r.findings.length).toBeGreaterThan(1);
    for (const f of r.findings) expect(f.reason.length, f.code).toBeGreaterThan(20);
  });
});

describe("the report", () => {
  it("states the measurements even when everything is fine", () => {
    const lines = formatAvSync(checkAvSync(healthy));
    expect(lines[0]).toContain("video=600.00s");
    expect(lines[0]).toContain("audio=600.00s");
    expect(lines[0]).toContain("OK");
    expect(lines).toHaveLength(1);
  });

  it("one line per finding, each naming its own code", () => {
    const r = checkAvSync({ videoSec: 600, audioSec: 640, firstSoundSec: 9, lastSoundSec: 640 });
    const lines = formatAvSync(r);
    expect(lines).toHaveLength(r.findings.length + 1);
    expect(lines.join("\n")).toContain("stream_length_mismatch");
    expect(lines.join("\n")).toContain("leading_silence");
  });

  it("an unreadable measurement prints as unknown rather than as zero", () => {
    const lines = formatAvSync(
      checkAvSync({ videoSec: null, audioSec: null, firstSoundSec: null, lastSoundSec: null })
    );
    expect(lines[0]).toContain("video=?s");
    expect(lines[0]).toContain("audio=?s");
  });
});

/* ═══════════════════════ wired to the delivered file ═══════════════════════ */

describe("it runs on the file that ships", () => {
  it("the render job measures its own output", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(worker).toContain("checkFileAvSync(outputPath)");
  });

  /**
   * Reported, not blocking. A documentary that deliberately opens on atmosphere is indistinguishable
   * from one that lost its first second of narration, and this cannot tell them apart — so failing a
   * finished render on it would throw away good videos over a heuristic.
   */
  it("does not fail a finished render on a heuristic", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    const at = worker.indexOf("checkFileAvSync(outputPath)");
    /**
     * Bounded by the next step's own marker rather than a character window, so adding a paragraph
     * of commentary cannot turn a documentation change into a red test.
     */
    const nextStep = worker.indexOf("6c. THE CONTENT CHECK", at);
    expect(nextStep).toBeGreaterThan(at);
    expect(worker.slice(at, nextStep)).not.toContain("fail(");
  });

  it("survives a probe that throws rather than losing the render to it", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(worker).toContain("checkFileAvSync(outputPath).catch(() => null)");
  });
});
