/**
 * THE AUDIO FILES DO NOT END THE FILM — RONDE 646.
 *
 * Render 603, job 21:
 *
 *   [MuxSpan] picture=56.30s audioMix=67.53s timeline=56.29s tracks=2 mux=yes
 *             shortestWouldTruncatePicture=no
 *   [RenderJob] … RENDER_FAILED — duration 50.23s differs from the timeline's 56.29s by 6.06s
 *
 * The picture was right before the mux. The mux copies it (`-c:v copy`), so the only thing that
 * could shorten it is `-shortest`, and `-shortest` cuts to the audio the FILES hold. The 67.53s was
 * the plan's arithmetic; the files ended at 50.23s. Render 597 (62.01s → 47.73s) had the same shape.
 *
 *   §1  the renderer, with real ffmpeg: a music file shorter than its planned span keeps the picture
 *   §2  the measurement reads the files, so the log says what `-shortest` will see
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emptyTimeline, timelineElementId, type ProjectTimeline } from "./projectTimeline";
import { formatMuxSpan, measuredAudioExtentSec, renderTimeline } from "./timelineRenderer";
import type { MixInput } from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const VIDEO_SEC = 6;

let dir = "";
let picture = "";
let voice = "";
let music = "";

async function formatDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number(stdout.trim());
}

/** Narration 1s→5s, and a music bed PLANNED across 0s→8s whose file holds only 3s. */
function timeline(): ProjectTimeline {
  const t = emptyTimeline(646);
  t.durationSec = VIDEO_SEC;
  t.tracks = [
    {
      kind: "VIDEO",
      clips: [{
        id: timelineElementId("clip", "r646", 0),
        kind: "video",
        source: { provider: "internet_archive", providerAssetId: "r646" },
        sourceIn: 0,
        timelineStart: 0,
        timelineEnd: VIDEO_SEC,
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
        previewSource: "asset",
      }],
    },
    {
      kind: "VOICE",
      clips: [{ id: "voice", source: { provider: "narration", canonicalUrl: "file://voice" }, start: 1, end: 5, gain: 1 }],
    },
    {
      kind: "MUSIC",
      clips: [{
        id: "music", source: { provider: "music", canonicalUrl: "file://music" },
        start: 0, end: 8, gain: 0.3, duckUnderVoice: true,
      }],
    },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "AMBIENT", clips: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics: [] },
  ] as never;
  return t;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r646-"));
  picture = path.join(dir, "pic.mp4");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=gray:s=320x180:d=${VIDEO_SEC + 2}:r=25`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", picture,
  ]);
  voice = path.join(dir, "voice.wav");
  await execFileAsync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=300:d=4", voice]);
  music = path.join(dir, "music.wav");
  await execFileAsync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=500:d=3", music]);
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("§1 — the renderer keeps the picture when the audio files run out", () => {
  it("a 6s timeline whose audio files end at 5s renders as 6s, and the log says why", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const out = path.join(dir, "out.mp4");
    try {
      await renderTimeline({
        timeline: timeline(),
        workDir: path.join(dir, "w"),
        outputPath: out,
        resolveMedia: async () => picture,
        resolveAudio: async (_id, _url, source) => (source.provider === "narration" ? voice : music),
      });
    } finally {
      spy.mockRestore();
    }
    /** Before the pad this file was 5.0s: the voice file (1s + 4s) was the longest real input. */
    expect(await formatDuration(out)).toBeGreaterThan(VIDEO_SEC - 0.1);
    expect(await formatDuration(out)).toBeLessThan(VIDEO_SEC + 0.1);

    const span = lines.find((l) => l.startsWith("[MuxSpan]"));
    expect(span, "the renderer no longer reports its mux").toBeDefined();
    expect(span).toContain("audioMix=8.00s");
    expect(span).toMatch(/audioFiles=5\.0\ds/);
    expect(span).toContain("shortestWouldTruncatePicture=YES");
    expect(span).toContain("padded with silence");
  }, 120_000);
});

describe("§2 — the measurement is of the files", () => {
  const input = (startSec: number, durationSec: number, delaySec?: number): MixInput =>
    ({ index: 1, kind: "MUSIC", startSec, gain: 1, durationSec, ...(delaySec != null ? { delaySec } : {}) }) as MixInput;

  it("start + delay + the file's own length, the furthest one", () => {
    expect(measuredAudioExtentSec([
      { input: input(1, 4), fileSec: 4 },
      { input: input(0, 8), fileSec: 3 },
      { input: input(2, 1, 0.5), fileSec: 1 },
    ])).toBe(5);
  });

  it("one unprobeable file makes the whole answer unknown, not smaller", () => {
    expect(measuredAudioExtentSec([{ input: input(0, 8), fileSec: 8 }, { input: input(0, 2), fileSec: null }])).toBeNull();
  });

  it("RENDER 603's numbers: the plan said no, the files say yes", () => {
    const planOnly = formatMuxSpan({ pictureSec: 56.3, audioExtentSec: 67.53, timelineSec: 56.29, tracks: 2, muxed: true });
    expect(planOnly).toContain("shortestWouldTruncatePicture=no");
    const measured = formatMuxSpan({
      pictureSec: 56.3, audioExtentSec: 67.53, audioFilesSec: 50.23, timelineSec: 56.29, tracks: 2, muxed: true, padded: true,
    });
    expect(measured).toContain("audioFiles=50.23s");
    expect(measured).toContain("shortestWouldTruncatePicture=YES");
    expect(measured).toContain("6.07s before the picture");
    expect(measured).toContain("padded with silence");
  });

  it("an unprobeable file is printed as unknown, and the plan decides", () => {
    const line = formatMuxSpan({
      pictureSec: 10, audioExtentSec: 12, audioFilesSec: null, timelineSec: 10, tracks: 1, muxed: true, padded: true,
    });
    expect(line).toContain("audioFiles=unknown");
    expect(line).toContain("shortestWouldTruncatePicture=no");
  });

  it("the mux pads the mix and keeps -shortest for the other direction", () => {
    const src = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
    expect(src).toContain("`${audioGraph.filter};[${audioGraph.outLabel}]apad=whole_dur=${padToSec.toFixed(3)}[${muxLabel}]`");
    expect(src).toContain('"-map", "0:v", "-map", `[${muxLabel}]`');
    expect(src).toContain('"-shortest",');
  });
});
