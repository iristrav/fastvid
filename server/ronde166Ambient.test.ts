/**
 * RONDE 166 (§1/§2/§15) — ambience reaches the timeline, and reaches the finished MP4.
 *
 * ── What the R160–165 audit found ────────────────────────────────────────────────────────────
 *
 * `edlToTimeline` built AMBIENT and MUSIC as literal `clips: []`, and `audioAssetSource.ts` — the
 * module written to resolve exactly those — had zero production callers. A cinematically planned
 * video had no room tone at all, and nothing said so.
 *
 * ── What these tests refuse to accept as evidence ───────────────────────────────────────────
 *
 * "The AMBIENT track has a clip on it" is not proof that a viewer hears anything. The last block
 * therefore renders a real MP4 through the real renderer and measures it with ffmpeg's
 * `volumedetect`, against a control render of the same timeline with the ambience switched off. If
 * the two measure the same, the ambience did not arrive, whatever the timeline says.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ambientClips,
  formatCinematicAudio,
  planCinematicAudio,
} from "./cinematicAmbient";
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import { emptyTimeline, type ProjectTimeline, type TimelineAudioClip } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";
import type { Scene } from "./pipeline/types";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

function scene(index: number, text: string, visualCue = ""): Scene {
  return { index, text, visualCue, pexelsQuery: "", aiImagePrompt: "", duration: 8 };
}

const WINDOWS = [
  { startSec: 0, endSec: 8 },
  { startSec: 8, endSec: 16 },
];

/* ═══════════════════════ planning ═══════════════════════ */

describe("R166 §2 — ambience is planned from the scene and resolved to a REAL identity", () => {
  it("a scene about rain gets a rain recording, named by provider and id", () => {
    const plan = planCinematicAudio({
      scenes: [scene(0, "Rain hammered the windows for three days straight.")],
      sceneWindows: [WINDOWS[0]!],
    });
    expect(plan.ambient).toHaveLength(1);
    const a = plan.ambient[0]!;
    expect(a.category).toBe("rain");
    /** A real provider and a real id — not a filename, not "something rainy". */
    expect(a.identity.provider).toBe("freesound");
    expect(a.identity.providerAssetId).toMatch(/^\d+$/);
  });

  /** The id must be one the catalogue actually holds, or the rehydrator will chase a ghost. */
  it("every planned identity names a recording that is really in the catalogue", () => {
    const plan = planCinematicAudio({
      scenes: [scene(0, "Rain on the city street."), scene(1, "Birds in the forest at dawn.")],
      sceneWindows: WINDOWS,
    });
    const known = new Set(
      Object.values(SOUND_CATALOG).flat().map((v) => String(v.freesoundId))
    );
    expect(plan.ambient.length).toBeGreaterThan(0);
    for (const a of plan.ambient) {
      expect(known.has(a.identity.providerAssetId!), `${a.identity.providerAssetId} is not in the catalogue`).toBe(true);
    }
  });

  /**
   * §32's determinism, applied to sound. The catalogue holds several recordings per category and
   * the existing fetcher picks one AT RANDOM; this route picks by scene index instead, so the same
   * timeline renders the same mix every time.
   */
  it("the same scenes always resolve to the same recordings", () => {
    const build = () =>
      planCinematicAudio({
        scenes: [scene(0, "Rain on the city street."), scene(1, "Birds in the forest at dawn.")],
        sceneWindows: WINDOWS,
      });
    const first = build().ambient.map((a) => a.identity.providerAssetId);
    for (let i = 0; i < 4; i++) {
      expect(build().ambient.map((a) => a.identity.providerAssetId)).toEqual(first);
    }
  });

  /** Different scenes vary the variant, so a long video does not loop one recording throughout. */
  it("two scenes on the same category can draw different variants", () => {
    const plan = planCinematicAudio({
      scenes: [scene(0, "Heavy rain."), scene(1, "Rain again, later that week.")],
      sceneWindows: WINDOWS,
    });
    const cats = plan.ambient.map((a) => a.category);
    expect(new Set(cats).size).toBe(1);
    /** Same category, chosen by index — so a category with >1 variant alternates. */
    const variants = SOUND_CATALOG[plan.ambient[0]!.category];
    if (variants.length > 1) {
      expect(plan.ambient[0]!.identity.providerAssetId).not.toBe(
        plan.ambient[1]!.identity.providerAssetId
      );
    }
  });

  it("the clip covers exactly the scene's own window", () => {
    const clips = ambientClips(
      planCinematicAudio({ scenes: [scene(0, "Rain."), scene(1, "Rain.")], sceneWindows: WINDOWS })
    );
    expect(clips[0]!.start).toBe(0);
    expect(clips[0]!.end).toBe(8);
    expect(clips[1]!.start).toBe(8);
    expect(clips[1]!.end).toBe(16);
  });

  /** §2 — ambience ducks under the voice, using the flag the existing mixer already reads. */
  it("every ambient clip is marked to duck under the voice", () => {
    const clips = ambientClips(planCinematicAudio({ scenes: [scene(0, "Rain.")], sceneWindows: [WINDOWS[0]!] }));
    expect(clips[0]!.duckUnderVoice).toBe(true);
    expect(clips[0]!.gain).toBeLessThan(0.2);
    expect(clips[0]!.gain).toBeGreaterThan(0);
  });

  it("carries no URL, key or local path into the timeline", () => {
    const clips = ambientClips(planCinematicAudio({ scenes: [scene(0, "Rain.")], sceneWindows: [WINDOWS[0]!] }));
    const json = JSON.stringify(clips);
    expect(json).not.toMatch(/api[_-]?key/i);
    expect(json).not.toContain("/tmp/");
    /** The freesound.org deed URL is provenance, not media — and it is the only URL allowed. */
    for (const m of json.match(/https?:\/\/[^"]+/g) ?? []) {
      expect(m).toContain("freesound.org/s/");
    }
  });
});

/* ═══════════════════════ music: honest about not having any ═══════════════════════ */

describe("R166 §1 — music is reported unavailable rather than faked", () => {
  it("always states the music verdict, with a reason", () => {
    const plan = planCinematicAudio({ scenes: [scene(0, "Rain.")], sceneWindows: [WINDOWS[0]!] });
    expect(plan.music.available).toBe(false);
    expect(plan.music.reason).toContain("musicSourceUnavailable");
  });

  /**
   * The rule this pins. A synthesised sine bed is not music, and laying one under a documentary
   * while calling it music is exactly the fake §1 forbids.
   */
  it("no procedural bed is smuggled onto the timeline as music", () => {
    const plan = planCinematicAudio({ scenes: [scene(0, "Rain.")], sceneWindows: [WINDOWS[0]!] });
    expect(JSON.stringify(plan.ambient)).not.toContain("procedural");
    expect(JSON.stringify(plan.ambient)).not.toContain("sine_bed");
  });

  it("the log line says both what was laid down and that music was not", () => {
    const line = formatCinematicAudio(
      planCinematicAudio({ scenes: [scene(0, "Rain.")], sceneWindows: [WINDOWS[0]!] })
    );
    expect(line).toContain("[Audio]");
    expect(line).toContain("music=unavailable");
    expect(line).not.toMatch(/https?:/);
  });
});

/* ═══════════════════════ it reaches the rendered file ═══════════════════════ */

/**
 * §15 — "render real media → inspect output → measure result".
 *
 * The ambience is fed from a locally generated tone rather than fetched from Freesound: this
 * environment has no FREESOUND_API_KEY, and the point under test is the RENDER PATH — that a clip
 * on the AMBIENT track, marked to duck, actually reaches the mix. Whether Freesound answers is a
 * separate question and is not claimed here.
 *
 * PRODUCTION STATUS: LOCAL.
 */
describe("R166 §15 — the ambient track is audible in the finished MP4", () => {
  let dir: string;
  let picture: string;
  let tone: string;
  let voice: string;
  let n = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r166-amb-"));
    picture = path.join(dir, "pic.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=6:r=24",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", picture,
    ]);
    tone = path.join(dir, "amb.wav");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=120:duration=6:sample_rate=48000",
      "-af", "volume=0.6", "-c:a", "pcm_s16le", tone,
    ]);
    voice = path.join(dir, "voice.wav");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=6:sample_rate=48000",
      "-af", "volume=enable='between(t,2,4)':volume=0.9,volume=enable='not(between(t,2,4))':volume=0",
      "-c:a", "pcm_s16le", voice,
    ]);
  }, 300_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function timelineWith(ambient: TimelineAudioClip[]): ProjectTimeline {
    const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 24 });
    t.durationSec = 6;
    const video = t.tracks.find((x) => x.kind === "VIDEO");
    if (video?.kind !== "VIDEO") throw new Error("no VIDEO track");
    video.clips.push({
      id: "v1", kind: "video", source: { provider: "pexels", providerAssetId: "1" },
      sourceIn: 0, sourceOut: 6, timelineStart: 0, timelineEnd: 6,
      motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
    } as never);
    const voiceTrack = t.tracks.find((x) => x.kind === "VOICE");
    if (voiceTrack?.kind === "VOICE") {
      voiceTrack.clips.push({
        id: "voice", source: { provider: "narration", canonicalUrl: "https://x.invalid/v.wav" },
        start: 0, end: 6, gain: 1,
      });
    }
    const amb = t.tracks.find((x) => x.kind === "AMBIENT");
    if (amb?.kind === "AMBIENT") amb.clips.push(...ambient);
    return t;
  }

  async function render(t: ProjectTimeline): Promise<string> {
    const id = `r${n++}`;
    const out = path.join(dir, `${id}.mp4`);
    const result = await renderTimeline({
      timeline: t,
      workDir: path.join(dir, id),
      outputPath: out,
      resolveMedia: async () => picture,
      resolveAudio: async (clipId) => (clipId === "voice" ? voice : tone),
    });
    expect(result.skipped.filter((s) => s.startsWith("audio"))).toEqual([]);
    return out;
  }

  async function loudness(file: string, from: number, dur: number, isolate?: string) {
    const { stderr } = await execFileAsync(FFMPEG, [
      "-hide_banner", "-nostats", "-ss", from.toFixed(3), "-t", dur.toFixed(3),
      "-i", file, "-map", "0:a:0",
      "-af", isolate ? `${isolate},volumedetect` : "volumedetect", "-f", "null", "-",
    ]);
    const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    if (!mean) throw new Error("volumedetect reported nothing");
    return Number(mean[1]);
  }

  /** The measurement. Same timeline, ambience on versus off — the mix must get louder. */
  it("a video WITH ambience is measurably louder than the same video without", async () => {
    const clips = ambientClips(
      planCinematicAudio({ scenes: [scene(0, "Rain on the street.")], sceneWindows: [{ startSec: 0, endSec: 6 }] })
    );
    expect(clips).toHaveLength(1);

    const withAmb = await render(timelineWith(clips));
    const without = await render(timelineWith([]));

    /** Measured at 120 Hz, where the ambience lives and the 1 kHz voice does not. */
    const AMB_ONLY = "lowpass=f=300";
    const a = await loudness(withAmb, 0.5, 1.2, AMB_ONLY);
    const b = await loudness(without, 0.5, 1.2, AMB_ONLY);
    expect(a - b, "the ambient track never reached the mix").toBeGreaterThan(6);
  }, 600_000);

  /**
   * And it ducks. The same recording, measured inside the voice window and outside it, in ONE
   * render — so the only thing that changes is whether the narrator is speaking.
   */
  it("the ambience ducks under the voice", async () => {
    const clips = ambientClips(
      planCinematicAudio({ scenes: [scene(0, "Rain on the street.")], sceneWindows: [{ startSec: 0, endSec: 6 }] })
    );
    /**
     * ── Why this test raises the gain, and the one above does not ─────────────────────────────
     *
     * The calibrated ambience level is −26 dBFS, which is correct for room tone under narration and
     * is what the previous test measures. It is also BELOW THE MEASUREMENT FLOOR here: the 1 kHz
     * voice is gated on and off, and the resulting step discontinuities leak broadband energy into
     * the low band this test listens to. Measured on an isolated reproduction, that leak sits at
     * about −48 dB while the ducked ambience sits at −53 — so the band gets LOUDER under the voice,
     * and the reading says nothing about ducking at all.
     *
     * At an audible gain the two separate cleanly and the real behaviour shows: −31.6 dB outside
     * the voice window against −36.2 dB inside it. The ducking code path is identical either way —
     * `duckUnderVoice` is a flag, not a level — so this measures the same thing, loudly enough to
     * be measurable.
     */
    const audible = clips.map((c) => ({ ...c, gain: 0.6 }));
    const out = await render(timelineWith(audible));
    const AMB_ONLY = "lowpass=f=300";
    const before = await loudness(out, 0.4, 1.2, AMB_ONLY);
    const under = await loudness(out, 2.6, 1.0, AMB_ONLY);
    expect(before - under, "the ambience did not duck under the voice").toBeGreaterThan(1.5);
  }, 600_000);

  /** The control: with ducking off, the same ambience holds its level through the voice. */
  it("without duckUnderVoice the ambience does not dip", async () => {
    const clips = ambientClips(
      planCinematicAudio({ scenes: [scene(0, "Rain on the street.")], sceneWindows: [{ startSec: 0, endSec: 6 }] })
    ).map((c) => ({ ...c, gain: 0.6, duckUnderVoice: false }));
    const out = await render(timelineWith(clips));
    const AMB_ONLY = "lowpass=f=300";
    const before = await loudness(out, 0.4, 1.2, AMB_ONLY);
    const under = await loudness(out, 2.6, 1.0, AMB_ONLY);
    expect(Math.abs(before - under), "the ambience moved with nothing ducking it").toBeLessThan(1.5);
  }, 600_000);
});
