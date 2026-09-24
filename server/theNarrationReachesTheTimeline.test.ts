/**
 * THE NARRATION REACHES THE TIMELINE, WITH OR WITHOUT WORD TIMING — RONDE 647.
 *
 * Renders 603 (twice) and 604:
 *
 *   [RenderPersistence] video=604 voiceover stored … bytes=1960481 words=0
 *   [RenderJob] audioBed voice=0 ambient=3
 *
 * The voice-over existed and was uploaded; the timeline had no VOICE clip, because the plan only
 * received a voice when the TTS alignment carried a total duration — and only ElevenLabs returns
 * character timing. These tests hold the difference between "no narration" and "no word timing".
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { narrationForTimeline } from "./renderPersistence";
import { probeMediaFacts } from "./assetRehydrator";
import { translateEdl } from "./edlToTimeline";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const stored = { ok: true as const, url: "https://cdn/x/voiceover.mp3", key: "k", bytes: 1960481, sourcePath: "/tmp/v.mp3" };

describe("the narration's length, from the best evidence there is", () => {
  it("VIDEO 604: no alignment, a measured file — the narration is on the timeline", () => {
    expect(
      narrationForTimeline({ persisted: stored, alignmentDurationSec: null, measuredDurationSec: 81.62 })
    ).toEqual({ url: stored.url, durationSec: 81.62, durationSource: "measured_file" });
  });

  it("an alignment, when there is one, is the length", () => {
    expect(
      narrationForTimeline({ persisted: stored, alignmentDurationSec: 80.9, measuredDurationSec: 81.62 })
    ).toEqual({ url: stored.url, durationSec: 80.9, durationSource: "alignment" });
  });

  it("no stored file, or nothing measurable, is no narration — never an invented length", () => {
    expect(
      narrationForTimeline({
        persisted: { ok: false, reason: "no_voiceover_file", detail: "x" },
        alignmentDurationSec: 80,
        measuredDurationSec: 80,
      })
    ).toBeNull();
    expect(narrationForTimeline({ persisted: stored, alignmentDurationSec: 0, measuredDurationSec: null })).toBeNull();
  });

  it("the probe measures a real mp3 with no video stream", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r647-voice-"));
    try {
      const mp3 = path.join(dir, "full_voiceover.mp3");
      await run(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=7.5", "-c:a", "libmp3lame", mp3,
      ]);
      const facts = await probeMediaFacts(mp3);
      expect(facts?.durationSec).toBeGreaterThan(7.3);
      expect(facts?.durationSec).toBeLessThan(7.7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("and with it the timeline carries a VOICE clip of that length", () => {
    const { timeline } = translateEdl({
      videoId: 604,
      voice: { url: stored.url, durationSec: 81.62 },
      inputs: [],
    });
    const voice = timeline.tracks.find((t) => t.kind === "VOICE");
    expect(voice && voice.kind === "VOICE" ? voice.clips.length : 0).toBe(1);
    expect(timeline.durationSec).toBe(81.62);
  });
});

describe("the pipeline asks the narration, not the word timing", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the plan's voice comes from `narrationForTimeline`", () => {
    expect(PIPE).toContain("voice: narration ? { url: narration.url, durationSec: narration.durationSec } : null,");
    expect(PIPE).not.toContain("persisted?.ok && storedAlignment?.totalDurationSec");
  });

  it("the file is measured only when there is no alignment, and the outcome is logged either way", () => {
    expect(PIPE).toContain("(await probeMediaFacts(persisted.sourcePath).catch(() => null))?.durationSec ?? null");
    expect(PIPE).toContain("NO NARRATION ON THE TIMELINE");
  });
});
