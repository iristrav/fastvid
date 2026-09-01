/**
 * RONDE 189 — the audio a viewer actually hears, measured.
 *
 * ── What R160 §9 already proved, and what this adds ──────────────────────────────────────────
 *
 * R160 rendered real mixes and measured them with `volumedetect`: voice audible, four tracks
 * together, gain, ducking under the voice with a no-duck control, fades, SFX placement, automation,
 * and an unrecoverable clip named rather than dropped. None of that is repeated here.
 *
 * What was NOT covered is the set of questions a listener would ask about a finished documentary:
 *
 *   · can the narration still be understood with room tone under it;
 *   · does the mix clip;
 *   · is the audio as long as the picture;
 *   · and when there is no music, does the render SAY there is no music rather than leaving a
 *     silent track that looks the same as a failure.
 *
 * The last one had the failure mode this series keeps finding: `formatCinematicAudio` was written
 * in R166 and had no caller, so `musicSourceUnavailable` appeared in no render log at all.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, timelineElementId, type ProjectTimeline } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { buildAudioGraph } from "./timelineFilters";
import { formatCinematicAudio, planCinematicAudio } from "./cinematicAmbient";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

const VIDEO_SEC = 6;

let dir = "";
let picture = "";
let voice = "";
let ambient = "";

/* ═══════════════════════ measuring ═══════════════════════ */

/** ffmpeg's own measurement, over a window and optionally one frequency band. */
async function levels(file: string, opts: { from?: number; to?: number; band?: string } = {}) {
  const filters: string[] = [];
  if (opts.from != null || opts.to != null) {
    filters.push(`atrim=start=${opts.from ?? 0}:end=${opts.to ?? VIDEO_SEC}`);
  }
  if (opts.band) filters.push(opts.band);
  filters.push("volumedetect");
  const { stderr } = await execFileAsync(FFMPEG, [
    "-hide_banner", "-i", file, "-map", "0:a:0", "-af", filters.join(","), "-f", "null", "-",
  ]);
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
  const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
  if (!Number.isFinite(mean) || !Number.isFinite(peak)) {
    throw new Error(`volumedetect reported nothing for ${path.basename(file)}`);
  }
  return { mean, peak };
}

async function durationOf(file: string, stream: "a" | "v"): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", `${stream}:0`,
    "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  const d = Number(stdout.trim());
  if (Number.isFinite(d) && d > 0) return d;
  const { stdout: fmt } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number(fmt.trim());
}

/* ═══════════════════════ the fixture ═══════════════════════ */

function timelineWith(opts: { ambient?: boolean; duck?: boolean }): ProjectTimeline {
  const t = emptyTimeline(189);
  t.durationSec = VIDEO_SEC;
  t.tracks = [
    {
      kind: "VIDEO",
      clips: [{
        id: timelineElementId("clip", "r189", 0),
        kind: "video",
        source: { provider: "internet_archive", providerAssetId: "r189" },
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
      clips: [{
        id: "voice", source: { provider: "narration", canonicalUrl: "file://voice" },
        start: 1, end: 5, gain: 1,
      }],
    },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    {
      kind: "AMBIENT",
      clips: opts.ambient
        ? [{
            id: "amb",
            source: { provider: "freesound", providerAssetId: "401178" },
            start: 0, end: VIDEO_SEC, gain: 0.35,
            ...(opts.duck === false ? {} : { duckUnderVoice: true }),
          }]
        : [],
    },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics: [] },
  ] as never;
  return t;
}

async function render(t: ProjectTimeline, name: string) {
  const out = path.join(dir, `${name}.mp4`);
  const result = await renderTimeline({
    timeline: t,
    workDir: path.join(dir, `w_${name}`),
    outputPath: out,
    resolveMedia: async () => picture,
    resolveAudio: async (_id, _url, source) =>
      source.provider === "narration" ? voice : ambient,
  });
  return { out, result };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r189-"));
  picture = path.join(dir, "pic.mp4");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=gray:s=320x180:d=${VIDEO_SEC + 2}:r=25`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", picture,
  ]);
  /**
   * The narration stands in as a 300 Hz tone and the room tone as 2 kHz noise, so a band filter can
   * ask "how loud is the SPEECH band" separately from "how loud is everything" — which is the only
   * way to measure masking rather than total level.
   */
  voice = path.join(dir, "voice.wav");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-c:a", "pcm_s16le", voice,
  ]);
  ambient = path.join(dir, "amb.wav");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=2000:duration=${VIDEO_SEC}`,
    "-af", "volume=0.8", "-c:a", "pcm_s16le", ambient,
  ]);
}, 300_000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ═══════════════════════ the narration stays intelligible ═══════════════════════ */

describe("R189 — the voice survives the mix", () => {
  it("the narration is audible in the finished file", async () => {
    const { out } = await render(timelineWith({ ambient: false }), "voiceonly");
    const { mean } = await levels(out, { from: 1.5, to: 4.5 });
    expect(mean, "the narration window is silent").toBeGreaterThan(-45);
  }, 300_000);

  /**
   * Room tone must sit UNDER the narration, not on top of it. Measured in the speech band, so this
   * is about masking rather than about how loud the file is overall.
   */
  it("ambience does not mask the narration", async () => {
    const { out } = await render(timelineWith({ ambient: true }), "mixed");
    const speechBand = "highpass=f=200,lowpass=f=500";
    const during = await levels(out, { from: 1.5, to: 4.5, band: speechBand });
    const before = await levels(out, { from: 0.1, to: 0.9, band: speechBand });
    expect(
      during.mean - before.mean,
      `speech band is ${during.mean.toFixed(1)}dB under the voice and ${before.mean.toFixed(1)}dB before it`
    ).toBeGreaterThan(6);
  }, 300_000);

  /** And the ducking is real: the ambience itself is quieter while the voice is speaking. */
  it("the ambience ducks under the voice", async () => {
    const { out } = await render(timelineWith({ ambient: true }), "ducked");
    const ambientBand = "highpass=f=1500";
    const under = await levels(out, { from: 2, to: 4, band: ambientBand });
    const clear = await levels(out, { from: 5.2, to: 5.9, band: ambientBand });
    expect(
      clear.mean - under.mean,
      `ambience ${under.mean.toFixed(1)}dB under the voice, ${clear.mean.toFixed(1)}dB clear of it`
    ).toBeGreaterThan(1);
  }, 300_000);
});

/* ═══════════════════════ technical correctness ═══════════════════════ */

describe("R189 — the finished audio is technically sound", () => {
  it("does not clip", async () => {
    const { out } = await render(timelineWith({ ambient: true }), "clip");
    const { peak } = await levels(out);
    expect(peak, `peak is ${peak.toFixed(2)} dBFS`).toBeLessThanOrEqual(0);
  }, 300_000);

  /**
   * The audio is as long as the picture. R184 fixed the picture ending early; this is the same
   * question asked from the other side, because a mix that stops short is the identical fault.
   */
  it("the audio runs the whole length of the video", async () => {
    const t = timelineWith({ ambient: true });
    const { out } = await render(t, "length");
    const audioSec = await durationOf(out, "a");
    const videoSec = await durationOf(out, "v");
    expect(Math.abs(audioSec - videoSec), `audio ${audioSec}s, video ${videoSec}s`).toBeLessThan(0.3);
    expect(Math.abs(videoSec - t.durationSec), `planned ${t.durationSec}s, video ${videoSec}s, audio ${audioSec}s`).toBeLessThan(0.3);
  }, 300_000);

  it("there is no long silence where the narration should be", async () => {
    const { out } = await render(timelineWith({ ambient: false }), "silence");
    const { stderr } = await execFileAsync(FFMPEG, [
      "-hide_banner", "-i", out, "-map", "0:a:0",
      "-af", "silencedetect=noise=-50dB:d=0.8", "-f", "null", "-",
    ]);
    const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    /** Silence before the voice starts and after it ends is the plan; silence DURING it is not. */
    const inVoice = starts.filter((s) => s > 1.2 && s < 4.5);
    expect(inVoice, `silence began at ${inVoice.join(", ")}s while the narration was playing`).toEqual([]);
  }, 300_000);
});

/* ═══════════════════════ one mixer, and one honest verdict ═══════════════════════ */

describe("R189 — the mix is built once, and says what it could not do", () => {
  /** §28 — no second audio mixer. Every track goes through the one graph builder. */
  it("there is exactly one buildAudioGraph", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
      }
    };
    walk("server");
    const defs = files.filter((f) =>
      /export function buildAudioGraph\s*\(/.test(fs.readFileSync(f, "utf8"))
    );
    expect(defs, defs.join("\n")).toHaveLength(1);
  });

  it("the graph mixes every track it is given, in one pass", () => {
    const graph = buildAudioGraph([
      { index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 4 },
      { index: 1, kind: "AMBIENT", startSec: 0, gain: 0.3, durationSec: 6, duckUnderVoice: true },
      { index: 2, kind: "SFX", startSec: 2, gain: 0.8, durationSec: 1 },
    ])!;
    expect(graph.filter).toContain("amix");
    expect(graph.filter).toContain("sidechaincompress");
    expect(graph.outLabel).toBeTruthy();
  });

  /**
   * §1 — when there is no music, SAY there is no music. A silent MUSIC track and a failed one look
   * identical to a reader, and `formatCinematicAudio` had no caller at all until R189.
   */
  it("reports musicSourceUnavailable rather than leaving a silent track unexplained", () => {
    const plan = planCinematicAudio({ scenes: [], sceneOffsetsSec: [] });
    expect(plan.music.available).toBe(false);
    expect(plan.music.reason).toContain("musicSourceUnavailable");
    expect(formatCinematicAudio(plan)).toContain("music=unavailable");
  });

  /** And the production route logs it — the caller that was missing. */
  it("the production route logs the audio verdict", () => {
    const src = fs.readFileSync("server/cinematicProduction.ts", "utf8");
    expect(src, "formatCinematicAudio still has no production caller").toContain(
      "formatCinematicAudio(result.audio)"
    );
    expect(src).toContain("result.audio.music.reason");
  });
});
