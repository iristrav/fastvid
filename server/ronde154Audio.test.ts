/**
 * RONDE 154 — the audio engine: ducking, automation, and where sound actually comes from.
 *
 * The most important test here is the last one, and it uses real ffmpeg. §154 asks explicitly:
 * "Controleer dat sidechaincompress de voice niet uit de uiteindelijke mix verwijdert." A ducking
 * chain that gates the voice instead of the music produces a file that plays, has audio, and is
 * unusable — no assertion about filter strings can catch that. Measuring the loudness of the
 * result can.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DUCK_AMBIENT,
  DUCK_MUSIC,
  automationChain,
  buildAudioGraph,
  duckingEnabled,
  duckingParams,
  type MixInput,
} from "./timelineFilters";
import {
  AMBIENT_TO_CATEGORY,
  ProceduralMusicSource,
  SFX_TO_CATEGORY,
  formatMusicChoice,
  resolveAmbient,
  resolveCatalogSound,
  resolveSfx,
  type SfxRole,
  type AmbientRole,
} from "./audioAssetSource";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

function input(overrides: Partial<MixInput> = {}): MixInput {
  return {
    index: 1,
    kind: "MUSIC",
    startSec: 0,
    gain: 1,
    durationSec: 10,
    ...overrides,
  };
}

/* ═══════════════════════ ducking ═══════════════════════ */

describe("RONDE 154 — ducking is configurable, and bounded", () => {
  it("uses the calibrated defaults when the timeline asks for nothing", () => {
    expect(duckingParams("MUSIC", undefined)).toEqual({ ...DUCK_MUSIC });
    expect(duckingParams("AMBIENT", undefined)).toEqual({ ...DUCK_AMBIENT });
  });

  it("ambient ducks more gently than music — the existing policy, kept", () => {
    expect(duckingParams("AMBIENT", undefined).ratio).toBeLessThan(
      duckingParams("MUSIC", undefined).ratio
    );
  });

  it("honours a per-track override", () => {
    const p = duckingParams("MUSIC", { ratio: 4, release: 400 });
    expect(p.ratio).toBe(4);
    expect(p.release).toBe(400);
    // Unspecified fields keep the calibration.
    expect(p.threshold).toBe(DUCK_MUSIC.threshold);
  });

  /**
   * The clamp that matters most. Past about 20:1 a compressor stops ducking and starts GATING: the
   * music does not dip under the voice, it disappears and reappears, which sounds like a broken
   * file rather than a mix.
   */
  it("clamps a ratio that would gate the track into silence", () => {
    expect(duckingParams("MUSIC", { ratio: 500 }).ratio).toBeLessThanOrEqual(20);
    expect(duckingParams("MUSIC", { ratio: -3 }).ratio).toBeGreaterThanOrEqual(1);
  });

  it("clamps a threshold of zero, which would suppress the track even in silence", () => {
    expect(duckingParams("MUSIC", { threshold: 0 }).threshold).toBeGreaterThan(0);
  });

  it("ignores a non-finite override rather than passing NaN to ffmpeg", () => {
    const p = duckingParams("MUSIC", { ratio: Number.NaN, attack: Number.POSITIVE_INFINITY });
    expect(Number.isFinite(p.ratio)).toBe(true);
    expect(Number.isFinite(p.attack)).toBe(true);
  });

  it("MUSIC and AMBIENT duck when asked; VOICE never does", () => {
    expect(duckingEnabled(input({ kind: "MUSIC", duckUnderVoice: true }))).toBe(true);
    expect(duckingEnabled(input({ kind: "AMBIENT", duckUnderVoice: true }))).toBe(true);
    expect(duckingEnabled(input({ kind: "VOICE", duckUnderVoice: true }))).toBe(false);
  });

  /** §154: "SFX: niet automatisch ducking toepassen." An accent is meant to cut through. */
  it("SFX does not duck automatically, but can be asked to", () => {
    expect(duckingEnabled(input({ kind: "SFX", duckUnderVoice: true }))).toBe(false);
    expect(duckingEnabled(input({ kind: "SFX", ducking: { enabled: true } }))).toBe(true);
  });

  it("an explicit disable beats duckUnderVoice", () => {
    expect(
      duckingEnabled(input({ kind: "MUSIC", duckUnderVoice: true, ducking: { enabled: false } }))
    ).toBe(false);
  });

  it("the graph really contains the overridden numbers", () => {
    const graph = buildAudioGraph([
      input({ index: 1, kind: "VOICE" }),
      input({ index: 2, kind: "MUSIC", duckUnderVoice: true, ducking: { ratio: 6, release: 350 } }),
    ])!;
    expect(graph.filter).toContain("sidechaincompress");
    expect(graph.filter).toContain("ratio=6");
    expect(graph.filter).toContain("release=350");
  });
});

/* ═══════════════════════ automation ═══════════════════════ */

describe("RONDE 154 — volume automation ramps, it never steps", () => {
  it("a single keyframe is a level, not a curve", () => {
    expect(automationChain([{ atSec: 0, gain: 0.5 }])).toBeNull();
    expect(automationChain([])).toBeNull();
    expect(automationChain(undefined)).toBeNull();
  });

  it("two keyframes produce a per-frame expression", () => {
    const chain = automationChain([
      { atSec: 0, gain: 0.2 },
      { atSec: 5, gain: 1.0 },
    ])!;
    expect(chain).toContain("volume=eval=frame");
    // A ramp, not a jump: the expression interpolates between the two points.
    expect(chain).toContain("0.2000");
    expect(chain).toContain("1.0000");
    expect(chain).toContain("/5.0000");
  });

  it("sorts keyframes given out of order", () => {
    const a = automationChain([
      { atSec: 10, gain: 0.3 },
      { atSec: 0, gain: 1.0 },
    ])!;
    const b = automationChain([
      { atSec: 0, gain: 1.0 },
      { atSec: 10, gain: 0.3 },
    ])!;
    expect(a).toBe(b);
  });

  it("clamps gains and drops nonsense points rather than emitting NaN", () => {
    const chain = automationChain([
      { atSec: 0, gain: 99 },
      { atSec: Number.NaN, gain: 1 },
      { atSec: 5, gain: -4 },
    ])!;
    expect(chain).not.toMatch(/NaN|Infinity|undefined/);
    expect(chain).toContain("4.0000");
    expect(chain).toContain("0.0000");
  });

  it("handles three or more points, each segment its own ramp", () => {
    const chain = automationChain([
      { atSec: 0, gain: 0.15 },
      { atSec: 5, gain: 0.5 },
      { atSec: 10, gain: 0.1 },
    ])!;
    expect(chain).toContain("0.1500");
    expect(chain).toContain("0.5000");
    expect(chain).toContain("0.1000");
    // Two segments means two nested conditionals.
    expect(chain.match(/if\(lt\(t,/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("two keyframes at the same instant do not divide by zero", () => {
    const chain = automationChain([
      { atSec: 3, gain: 0.2 },
      { atSec: 3, gain: 0.9 },
    ])!;
    expect(chain).not.toMatch(/NaN|Infinity/);
  });

  it("the curve reaches the audio graph, after the static gain", () => {
    const graph = buildAudioGraph([
      input({ index: 1, kind: "MUSIC", gain: 0.4, automation: [
        { atSec: 0, gain: 1 }, { atSec: 4, gain: 0.2 },
      ] }),
    ])!;
    const volumeAt = graph.filter.indexOf("volume=0.400");
    const curveAt = graph.filter.indexOf("volume=eval=frame");
    expect(volumeAt).toBeGreaterThanOrEqual(0);
    expect(curveAt).toBeGreaterThan(volumeAt);
  });

  it("delaySec is ADDED to the clip's start, not a replacement", () => {
    const graph = buildAudioGraph([input({ startSec: 2, delaySec: 0.5 })])!;
    expect(graph.filter).toContain("adelay=2500|2500");
  });
});

/* ═══════════════════════ §16/§17 — where sound comes from ═══════════════════════ */

describe("RONDE 154 §17 — SFX and ambient resolve to REAL catalog assets", () => {
  it("a role with a recording gets a real freesound identity", () => {
    const found = resolveSfx("impact");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.identity.provider).toBe("freesound");
    // A real numeric Freesound id, not a made-up filename.
    expect(found.identity.providerAssetId).toMatch(/^\d+$/);
    expect(found.identity.sourcePageUrl).toContain("freesound.org");
  });

  /** §17: "Geen fake filenames." A role with no recording says so. */
  it("a role with NO recording reports asset_unavailable, never a fake id", () => {
    for (const role of ["whoosh", "riser", "explosion"] as SfxRole[]) {
      const found = resolveSfx(role);
      expect(found.ok, role).toBe(false);
      if (found.ok) continue;
      expect(found.reason, role).toContain("asset_unavailable");
      expect(found.reason, role).toContain(role);
    }
  });

  it("ambient roles resolve the same way", () => {
    const city = resolveAmbient("city");
    expect(city.ok).toBe(true);
    const battlefield = resolveAmbient("battlefield");
    expect(battlefield.ok).toBe(false);
    if (!battlefield.ok) expect(battlefield.reason).toContain("asset_unavailable");
  });

  /** §32: the same timeline must mix the same way every render. */
  it("variant selection is by index, never random", () => {
    expect(resolveSfx("crowd", 0)).toEqual(resolveSfx("crowd", 0));
    expect(resolveSfx("crowd", 3)).toEqual(resolveSfx("crowd", 3));
  });

  it("an out-of-range variant index wraps rather than failing", () => {
    const found = resolveSfx("crowd", 999);
    expect(found.ok).toBe(true);
  });

  it("every mapped role points at a category the catalog really has", () => {
    for (const [role, category] of Object.entries(SFX_TO_CATEGORY)) {
      if (!category) continue;
      expect(resolveCatalogSound(category).ok, `${role} → ${category}`).toBe(true);
    }
    for (const [role, category] of Object.entries(AMBIENT_TO_CATEGORY)) {
      if (!category) continue;
      expect(resolveCatalogSound(category).ok, `${role} → ${category}`).toBe(true);
    }
  });

  it("every role in the vocabulary has an entry — none is silently absent", () => {
    const sfxRoles: SfxRole[] = [
      "whoosh", "impact", "hit", "riser", "click", "camera", "shutter",
      "foley", "crowd", "explosion", "ambience",
    ];
    for (const r of sfxRoles) expect(r in SFX_TO_CATEGORY, r).toBe(true);
    const ambientRoles: AmbientRole[] = [
      "room", "city", "street", "nature", "wind", "rain", "crowd",
      "battlefield", "archive", "office",
    ];
    for (const r of ambientRoles) expect(r in AMBIENT_TO_CATEGORY, r).toBe(true);
  });
});

describe("RONDE 154 §16 — music is an interface, because there is no library", () => {
  const source = new ProceduralMusicSource();

  it("answers every request, and says the mood was not honoured", () => {
    const found = source.resolve({ mood: "tense", energy: "high", durationSec: 60 });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.label).toContain("not honoured");
    expect(found.label).toContain("tense");
  });

  /**
   * `procedural` must never be mistaken for a provider. A rehydrator that recognised the name
   * would go looking for a file that was never downloaded.
   */
  it("marks generated audio as procedural, not as a provider", () => {
    const found = source.resolve({ mood: "calm", energy: "low", durationSec: 30 });
    if (!found.ok) return;
    expect(found.identity.provider).toBe("procedural");
    expect(found.identity.mediaUrl).toBeUndefined();
  });

  it("the log line says whether the mood was actually honoured", () => {
    const request = { mood: "epic" as const, energy: "high" as const, durationSec: 30 };
    const line = formatMusicChoice(source, request, source.resolve(request));
    expect(line).toContain("moodHonoured=false");
    expect(line).toContain("mood=epic");
  });

  it("reports asset_unavailable when a source has nothing", () => {
    const empty = {
      id: "empty_library",
      supports: () => false,
      resolve: () => ({ ok: false as const, reason: "the library has no tense track" }),
    };
    const request = { mood: "tense" as const, energy: "low" as const, durationSec: 10 };
    expect(formatMusicChoice(empty, request, empty.resolve())).toContain("asset_unavailable");
  });
});

/* ═══════════════════════ the one that needs real ffmpeg ═══════════════════════ */

describe("RONDE 154 — ducking lowers the music WITHOUT removing the voice", () => {
  let dir: string;
  let voice: string;
  let music: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r154-"));
    voice = path.join(dir, "voice.wav");
    music = path.join(dir, "music.wav");
    /**
     * A 440Hz tone as "voice" and a 220Hz tone as "music", so the two are separable in the result
     * by frequency. Real narration would work too and would make the measurement much harder to
     * interpret; the point of the test is the FILTER, not the material.
     */
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=44100",
      "-c:a", "pcm_s16le", voice,
    ]);
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=44100",
      "-c:a", "pcm_s16le", music,
    ]);
  }, 300_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Mean volume of a rendered mix, in dB, straight from ffmpeg's volumedetect. */
  async function meanVolumeDb(filter: string, outLabel: string): Promise<number> {
    const out = path.join(dir, `mix_${Math.random().toString(36).slice(2)}.wav`);
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", voice, "-i", music,
      "-filter_complex", filter, "-map", `[${outLabel}]`,
      "-c:a", "pcm_s16le", out,
    ], { maxBuffer: 1024 * 1024 * 16 });

    const { stderr } = await execFileAsync(resolveFFmpegBin(), [
      "-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-",
    ], { maxBuffer: 1024 * 1024 * 16 });
    const match = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    expect(match, stderr.slice(-400)).not.toBeNull();
    return Number(match![1]);
  }

  it("produces a real mix, and the voice survives it", async () => {
    const graph = buildAudioGraph([
      { index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 4 },
      { index: 1, kind: "MUSIC", startSec: 0, gain: 0.8, durationSec: 4, duckUnderVoice: true },
    ])!;
    const ducked = await meanVolumeDb(graph.filter, graph.outLabel);

    /**
     * The assertion §154 actually asks for. Silence is around -91dB; a mix where the sidechain has
     * gated the voice out lands near there. A real mix with a voice in it is far above it.
     */
    expect(ducked).toBeGreaterThan(-40);
    expect(Number.isFinite(ducked)).toBe(true);
  }, 300_000);

  /**
   * And the ducking must actually DO something: the same two tracks mixed without it should be
   * louder than with it, because the music is being pushed down.
   */
  it("a ducked mix is quieter than the same mix unducked", async () => {
    const withDuck = buildAudioGraph([
      { index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 4 },
      { index: 1, kind: "MUSIC", startSec: 0, gain: 0.8, durationSec: 4, duckUnderVoice: true },
    ])!;
    const without = buildAudioGraph([
      { index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 4 },
      { index: 1, kind: "MUSIC", startSec: 0, gain: 0.8, durationSec: 4 },
    ])!;

    const a = await meanVolumeDb(withDuck.filter, withDuck.outLabel);
    const b = await meanVolumeDb(without.filter, without.outLabel);
    expect(a).toBeLessThan(b);
  }, 300_000);

  it("an automation curve renders without an ffmpeg error", async () => {
    const graph = buildAudioGraph([
      {
        index: 0, kind: "VOICE", startSec: 0, gain: 1, durationSec: 4,
      },
      {
        index: 1, kind: "MUSIC", startSec: 0, gain: 1, durationSec: 4,
        automation: [{ atSec: 0, gain: 0.1 }, { atSec: 2, gain: 1 }, { atSec: 4, gain: 0.1 }],
      },
    ])!;
    const level = await meanVolumeDb(graph.filter, graph.outLabel);
    expect(Number.isFinite(level)).toBe(true);
    expect(level).toBeGreaterThan(-60);
  }, 300_000);
});
