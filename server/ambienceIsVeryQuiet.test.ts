import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { DUCK_AMBIENT, DUCK_MUSIC, buildAudioGraph, levelledGain, parseIntegratedLufs, type MixInput } from "./timelineFilters";
import { ambienceGainDb } from "./cinematicAmbient";

/**
 * RONDE 655 — "Zorg er ook voor dat de achtergrond geluiden heel zacht zijn." A Freesound recording
 * sat at -26 dB of whatever level it happened to be recorded at: a loud crowd stayed loud.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_amb_"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** mean_volume of a window of a file, in dB (volumedetect prints on stderr). */
function level(file: string, from: number, to: number): number {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -ss ${from} -to ${to} -i "${file}" -af volumedetect -f null - 2>&1`], {
    encoding: "utf8",
  });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(out);
  return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
}

/** The renderer's own measurement: one ebur128 pass, parsed by the renderer's own parser. */
function lufs(file: string): number | null {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i "${file}" -af ebur128 -f null - 2>&1`], { encoding: "utf8" });
  return parseIntegratedLufs(out);
}

function mix(voice: string, ambience: string, out: string) {
  const gain = levelledGain(10 ** (ambienceGainDb({}) / 20), lufs(ambience));
  const inputs: MixInput[] = [
    { index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 10 },
    { index: 1, kind: "AMBIENT", startSec: 0, gain, durationSec: 10, duckUnderVoice: true },
  ];
  const g = buildAudioGraph(inputs)!;
  ff(["-i", voice, "-i", ambience, "-filter_complex", `${g.filter};[${g.outLabel}]apad=whole_dur=10[m]`, "-map", "[m]", "-t", "10", out]);
}

describe("ambience sits far under the voice, whatever level it was recorded at", () => {
  /** A narration-like level: ffmpeg's sine is 1/8 full scale, so volume=2 puts it near -15 dB RMS. */
  const voice = path.join(dir, "voice.wav");
  const loud = path.join(dir, "loud.wav");
  const soft = path.join(dir, "soft.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-af", "volume=2,apad=whole_dur=10", voice]);
  ff(["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.8:duration=10", loud]);
  ff(["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.15:duration=10", soft]);

  it("reads ffmpeg's integrated loudness and never boosts a near-silent file by more than 6 dB", () => {
    expect(parseIntegratedLufs("  Integrated loudness:\n    I:         -31.4 LUFS\n")).toBe(-31.4);
    expect(parseIntegratedLufs("nothing")).toBeNull();
    expect(levelledGain(1, -13)).toBeCloseTo(10 ** (-10 / 20), 3);
    expect(levelledGain(1, -60)).toBeCloseTo(10 ** (6 / 20), 3);
    expect(levelledGain(0.5, null)).toBe(0.5);
  });

  it("defaults to -18 dB on a bed levelled to -23 LUFS, and can be set lower", () => {
    expect(ambienceGainDb({})).toBe(-18);
    expect(ambienceGainDb({ AMBIENCE_GAIN_DB: "-30" })).toBe(-30);
    expect(ambienceGainDb({ AMBIENCE_GAIN_DB: "0" })).toBe(-6);
  });

  it("ducks harder than before, still gentler than music", () => {
    expect(DUCK_AMBIENT.ratio).toBe(6);
    expect(DUCK_AMBIENT.ratio).toBeLessThan(DUCK_MUSIC.ratio);
  });

  it("a loud and a quiet recording come out at the same level, at least 20 dB under the voice", () => {
    const outLoud = path.join(dir, "mixLoud.wav");
    const outSoft = path.join(dir, "mixSoft.wav");
    mix(voice, loud, outLoud);
    mix(voice, soft, outSoft);
    const voiceLevel = level(outLoud, 0.5, 3.5);
    const pauseLoud = level(outLoud, 5, 9.5);
    const pauseSoft = level(outSoft, 5, 9.5);
    /** Levelled: a 14.5 dB difference at the source is a couple of dB after (a near-silent file is capped at +6 dB, tested above). */
    expect(Math.abs(pauseLoud - pauseSoft)).toBeLessThan(4);
    expect(pauseLoud).toBeLessThan(voiceLevel - 20);
    /** And still there — quiet, not gone. */
    expect(pauseLoud).toBeGreaterThan(-70);
  }, 60_000);
});
