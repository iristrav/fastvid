/**
 * RONDE 160 §9 — the audio mix, rendered by real ffmpeg and measured with `volumedetect`.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * RONDE 154 built ducking, gain, fades, delay and volume automation, and every test it wrote reads
 * the FILTER STRING: "the chain contains `sidechaincompress`", "the chain contains `volume=0.3`".
 * A filter string is not a sound. A `sidechaincompress` wired to the wrong sidechain input, an
 * `asplit` that fed the compressor a copy of the music instead of the voice, an `adelay` in
 * milliseconds where the code meant seconds — all of those produce a chain that contains exactly
 * the right words and a mix that is wrong, and no existing test can hear the difference.
 *
 * So every test here renders a real MP4 through the real renderer and then MEASURES the result with
 * ffmpeg's `volumedetect`, which reports mean and peak dB over a window. Loud and quiet are then
 * facts about the file rather than facts about a string.
 *
 * ── Why tones and not music ──────────────────────────────────────────────────────────────────
 *
 * A sine at a known frequency and level gives an exact expected dB, and two tones an octave apart
 * can be told from each other in the output. Real music would make every threshold a judgement.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline, type TimelineAudioClip } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/* ═══════════════════════ measuring the finished audio ═══════════════════════ */

type Loudness = { meanDb: number; peakDb: number };

/**
 * The real level of a window of the finished file.
 *
 * `volumedetect` is ffmpeg's own measurement and it reports over whatever it is fed, so the window
 * is selected with -ss/-t before the filter rather than after. A file with no audio at all reports
 * nothing, which is why the parse throws rather than defaulting to silence — "we could not measure
 * it" and "it was silent" are different answers and only one of them is a passing test.
 */
async function loudness(
  file: string,
  fromSec: number,
  durationSec: number,
  /**
   * An optional filter run BEFORE the measurement, to isolate one part of the mix.
   *
   * Needed because the interesting question — "is the music quieter under the voice" — cannot be
   * asked of the whole mix: the voice is inside that window and is louder than the music, so the
   * mix gets LOUDER exactly where the music gets quieter. Separating them by frequency is what
   * makes the music measurable on its own, in the same single render.
   */
  isolate?: string
): Promise<Loudness> {
  const { stderr } = await execFileAsync(FFMPEG, [
    "-hide_banner", "-nostats",
    "-ss", fromSec.toFixed(3), "-t", durationSec.toFixed(3),
    "-i", file,
    "-map", "0:a:0", "-af", isolate ? `${isolate},volumedetect` : "volumedetect", "-f", "null", "-",
  ]);
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const peak = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  if (!mean || !peak) throw new Error(`volumedetect reported nothing for ${path.basename(file)}`);
  return { meanDb: Number(mean[1]), peakDb: Number(peak[1]) };
}

/* ═══════════════════════ sources ═══════════════════════ */

/** A steady tone at a known amplitude. 0.5 is -6 dBFS, so the expected numbers are arithmetic. */
async function tone(out: string, hz: number, seconds: number, amplitude = 0.5): Promise<string> {
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`,
    "-af", `volume=${amplitude}`,
    "-c:a", "pcm_s16le", out,
  ]);
  return out;
}

/**
 * A "voice": a tone that is silent for the first and last third and loud in the middle.
 *
 * Ducking is only observable against a voice that starts and stops — a continuous voice would duck
 * the music for the whole video and there would be nothing to compare the ducked window against.
 */
async function intermittentVoice(out: string, seconds: number): Promise<string> {
  const third = seconds / 3;
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=1000:duration=${seconds}:sample_rate=48000`,
    "-af", `volume=enable='between(t,${third.toFixed(3)},${(third * 2).toFixed(3)})':volume=0.9,volume=enable='not(between(t,${third.toFixed(3)},${(third * 2).toFixed(3)}))':volume=0`,
    "-c:a", "pcm_s16le", out,
  ]);
  return out;
}

/* ═══════════════════════ timelines ═══════════════════════ */

function audioClip(over: Partial<TimelineAudioClip> & { id: string }): TimelineAudioClip {
  return {
    source: { provider: "elevenlabs", providerAssetId: over.id, mediaUrl: `https://example.invalid/${over.id}` },
    start: 0,
    end: 6,
    gain: 1,
    ...over,
  } as TimelineAudioClip;
}

describe("R160 §9 — the audio mix, measured rather than described", () => {
  let dir: string;
  let voice: string;
  let music: string;
  let sfx: string;
  let n = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r160-audio-"));
    voice = await intermittentVoice(path.join(dir, "voice.wav"), 6);
    music = await tone(path.join(dir, "music.wav"), 100, 6, 0.5);
    sfx = await tone(path.join(dir, "sfx.wav"), 880, 1, 0.5);
  }, 300_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A silent 6-second picture, so the only thing under measurement is the audio graph. */
  function timelineWith(audio: Partial<Record<"VOICE" | "MUSIC" | "AMBIENT" | "SFX", TimelineAudioClip[]>>): ProjectTimeline {
    const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 24 });
    t.durationSec = 6;
    const video = t.tracks.find((x) => x.kind === "VIDEO");
    if (video?.kind !== "VIDEO") throw new Error("no VIDEO track");
    video.clips.push({
      id: "v1",
      kind: "video",
      source: { provider: "pexels", providerAssetId: "v1" },
      sourceIn: 0,
      sourceOut: 6,
      timelineStart: 0,
      timelineEnd: 6,
      motion: "none",
      transitionIn: "hard_cut",
      transitionOut: "hard_cut",
    } as never);
    for (const track of t.tracks) {
      const list = audio[track.kind as keyof typeof audio];
      if (list && "clips" in track) (track.clips as TimelineAudioClip[]).push(...list);
    }
    return t;
  }

  const FILES: Record<string, () => string> = {};

  async function render(timeline: ProjectTimeline): Promise<string> {
    const id = `a${n++}`;
    const outputPath = path.join(dir, `${id}.mp4`);
    const picture = path.join(dir, "picture.mp4");
    if (!fs.existsSync(picture)) {
      await execFileAsync(FFMPEG, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=6:r=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", picture,
      ]);
    }
    const result = await renderTimeline({
      timeline,
      workDir: path.join(dir, id),
      outputPath,
      resolveMedia: async () => picture,
      resolveAudio: async (clipId) => FILES[clipId]?.() ?? null,
    });
    expect(result.skipped.filter((s) => s.startsWith("audio")), "an audio clip was skipped").toEqual([]);
    return outputPath;
  }

  /* ── the tracks arrive at all ─────────────────────────────────────────────────────────── */

  it("a rendered video with a voice track really contains audible audio", async () => {
    FILES.voice = () => voice;
    const out = await render(timelineWith({ VOICE: [audioClip({ id: "voice" })] }));

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_type,sample_rate", "-of", "default=nw=1", out,
    ]);
    expect(stdout).toContain("codec_type=audio");

    /** The middle third is where the voice speaks, and it must be genuinely loud there. */
    const speaking = await loudness(out, 2.2, 1.6);
    expect(speaking.peakDb).toBeGreaterThan(-20);
  }, 300_000);

  /**
   * Four tracks at once, which is the shape of a real documentary mix. The measurement is that the
   * result is louder than any single track would be — nothing was dropped on the way into the mix.
   */
  it("voice, music, ambient and sfx all reach the output together", async () => {
    FILES.voice = () => voice;
    FILES.music = () => music;
    FILES.amb = () => music;
    FILES.sfx = () => sfx;

    const musicOnly = await render(timelineWith({ MUSIC: [audioClip({ id: "music", gain: 0.5 })] }));
    const everything = await render(
      timelineWith({
        VOICE: [audioClip({ id: "voice" })],
        MUSIC: [audioClip({ id: "music", gain: 0.5 })],
        AMBIENT: [audioClip({ id: "amb", gain: 0.5 })],
        SFX: [audioClip({ id: "sfx", start: 2, end: 3 })],
      })
    );

    const a = await loudness(musicOnly, 2.2, 1.6);
    const b = await loudness(everything, 2.2, 1.6);
    expect(b.meanDb, "adding three more tracks did not make the mix louder").toBeGreaterThan(a.meanDb + 1);
  }, 600_000);

  /* ── gain ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * Halving the gain is -6 dB, and that is arithmetic rather than taste, so the assertion can be
   * tight. A gain applied to the wrong track, or applied twice, lands outside this window.
   */
  it("gain 0.5 really is about six decibels quieter", async () => {
    FILES.music = () => music;
    const loud = await render(timelineWith({ MUSIC: [audioClip({ id: "music", gain: 1 })] }));
    const quiet = await render(timelineWith({ MUSIC: [audioClip({ id: "music", gain: 0.5 })] }));

    const a = await loudness(loud, 1, 4);
    const b = await loudness(quiet, 1, 4);
    const delta = a.meanDb - b.meanDb;
    expect(delta).toBeGreaterThan(4.5);
    expect(delta).toBeLessThan(7.5);
  }, 600_000);

  /* ── ducking ──────────────────────────────────────────────────────────────────────────── */

  /**
   * The measurement RONDE 154 was built for and never took: the music must be QUIETER while the
   * voice is speaking than while it is not, in the same rendered file.
   *
   * Comparing two windows of ONE render is what makes this airtight — no encoding difference, no
   * gain difference, no second run. The only thing that changes between the two windows is whether
   * the voice is present.
   */
  it("music is measurably quieter under the voice than around it", async () => {
    FILES.voice = () => voice;
    FILES.music = () => music;
    const out = await render(
      timelineWith({
        VOICE: [audioClip({ id: "voice" })],
        MUSIC: [audioClip({ id: "music", gain: 0.7, duckUnderVoice: true })],
      })
    );

    /**
     * The music is a 100 Hz tone and the voice is 1000 Hz, so a low-pass at 200 Hz leaves the music
     * alone and removes the voice. What is measured below is therefore THE MUSIC, in three windows
     * of ONE render — no second encode, no gain difference, nothing changing between the windows
     * except whether the voice is speaking over it.
     */
    const MUSIC_ONLY = "lowpass=f=200";
    const before = await loudness(out, 0.5, 1.2, MUSIC_ONLY);
    const under = await loudness(out, 2.6, 1.0, MUSIC_ONLY);
    const after = await loudness(out, 4.6, 1.2, MUSIC_ONLY);

    expect(under.meanDb, "the music vanished entirely instead of ducking").toBeGreaterThan(-60);
    expect(
      Math.min(before.meanDb - under.meanDb, after.meanDb - under.meanDb),
      "the music was not ducked under the voice"
    ).toBeGreaterThan(2);
  }, 300_000);

  /**
   * The control, and the reason the test above proves anything: with ducking OFF the same music,
   * measured the same way, must hold its level right through the voice. If it dipped here too, the
   * dip above would be something other than ducking.
   */
  it("without duckUnderVoice the music holds its level right through the voice", async () => {
    FILES.voice = () => voice;
    FILES.music = () => music;
    const out = await render(
      timelineWith({
        VOICE: [audioClip({ id: "voice" })],
        MUSIC: [audioClip({ id: "music", gain: 0.7, duckUnderVoice: false })],
      })
    );
    const MUSIC_ONLY = "lowpass=f=200";
    const before = await loudness(out, 0.5, 1.2, MUSIC_ONLY);
    const under = await loudness(out, 2.6, 1.0, MUSIC_ONLY);
    expect(Math.abs(before.meanDb - under.meanDb), "the music moved even though nothing ducked it")
      .toBeLessThan(1.5);
  }, 300_000);

  /* ── fades ────────────────────────────────────────────────────────────────────────────── */

  /**
   * A two-second fade-in means the first half-second is quiet and the middle is not. Both windows
   * come from one render, so the comparison isolates the fade.
   */
  it("a fade-in really starts quiet and arrives at full level", async () => {
    FILES.music = () => music;
    const out = await render(
      timelineWith({ MUSIC: [audioClip({ id: "music", gain: 1, fadeInSec: 2 })] })
    );
    const start = await loudness(out, 0.05, 0.4);
    const later = await loudness(out, 3, 1);
    expect(later.meanDb - start.meanDb, "the fade-in did not run").toBeGreaterThan(6);
  }, 300_000);

  it("a fade-out really ends quieter than the middle", async () => {
    FILES.music = () => music;
    const out = await render(
      timelineWith({ MUSIC: [audioClip({ id: "music", gain: 1, fadeOutSec: 2 })] })
    );
    const middle = await loudness(out, 1, 1);
    const end = await loudness(out, 5.6, 0.35);
    expect(middle.meanDb - end.meanDb, "the fade-out did not run").toBeGreaterThan(6);
  }, 300_000);

  /* ── placement ────────────────────────────────────────────────────────────────────────── */

  /**
   * A sound effect placed at 3s must be silent at 0.5s and audible at 3.4s. This is the assertion
   * that catches an `adelay` given seconds where it wanted milliseconds — a bug that produces a
   * perfectly valid filter chain and a sound effect a thousand times too early.
   */
  it("a sound effect lands at the second it was placed at, not at zero", async () => {
    FILES.sfx = () => sfx;
    const out = await render(timelineWith({ SFX: [audioClip({ id: "sfx", start: 3, end: 4 })] }));
    const before = await loudness(out, 0.3, 1.5);
    const during = await loudness(out, 3.15, 0.6);
    expect(during.peakDb, "the sound effect never played").toBeGreaterThan(-30);
    expect(during.peakDb - before.peakDb, "the sound effect played at the wrong time").toBeGreaterThan(20);
  }, 300_000);

  /**
   * `delaySec` is documented as an offset ON TOP OF `start`, not a replacement for it. That
   * distinction has no visible effect on the filter string — both produce one `adelay` — so it can
   * only be checked by listening to when the sound actually arrives.
   */
  it("delaySec is added to the clip's start rather than replacing it", async () => {
    FILES.sfx = () => sfx;
    const out = await render(
      timelineWith({ SFX: [audioClip({ id: "sfx", start: 2, end: 3, delaySec: 2 })] })
    );
    const atStartOnly = await loudness(out, 2.15, 0.5);
    const atStartPlusDelay = await loudness(out, 4.15, 0.5);
    expect(atStartPlusDelay.peakDb, "the sound did not arrive at start+delay").toBeGreaterThan(-30);
    expect(
      atStartPlusDelay.peakDb - atStartOnly.peakDb,
      "the sound played at `start`, so delaySec replaced it instead of adding to it"
    ).toBeGreaterThan(20);
  }, 300_000);

  /* ── automation ───────────────────────────────────────────────────────────────────────── */

  /**
   * A volume ramp from full to silent across the clip. Measured at three points, it must fall
   * monotonically — an automation curve that was built but never applied gives three equal numbers.
   */
  it("a volume automation curve is really applied over the clip", async () => {
    FILES.music = () => music;
    const out = await render(
      timelineWith({
        MUSIC: [
          audioClip({
            id: "music",
            gain: 1,
            automation: [
              { atSec: 0, gain: 1 },
              { atSec: 5.5, gain: 0.05 },
            ],
          }),
        ],
      })
    );
    const early = await loudness(out, 0.2, 0.8);
    const middle = await loudness(out, 2.6, 0.8);
    const late = await loudness(out, 4.8, 0.8);
    expect(middle.meanDb, "the curve did not come down").toBeLessThan(early.meanDb - 2);
    expect(late.meanDb, "the curve did not keep coming down").toBeLessThan(middle.meanDb - 2);
  }, 300_000);

  /* ── honesty ──────────────────────────────────────────────────────────────────────────── */

  /**
   * §21 — an audio file that cannot be recovered must be REPORTED, not silently dropped and the
   * render declared a success. A video that quietly lost its narration is the worst possible
   * outcome, and it is the one a silent fallback produces.
   */
  it("an unrecoverable audio clip is named in `skipped`, not silently dropped", async () => {
    const timeline = timelineWith({ VOICE: [audioClip({ id: "gone" })] });
    const result = await renderTimeline({
      timeline,
      workDir: path.join(dir, "gone"),
      outputPath: path.join(dir, "gone.mp4"),
      resolveMedia: async () => path.join(dir, "picture.mp4"),
      resolveAudio: async () => null,
    });
    expect(result.skipped.some((s) => s.includes("gone"))).toBe(true);
    expect(result.audioTracks).toBe(0);
  }, 300_000);
});
