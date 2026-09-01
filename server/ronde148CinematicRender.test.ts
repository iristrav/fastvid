/**
 * RONDE 148 §26/§39 — transforms, camera, transitions, effects, graphics and the audio mix.
 *
 * ── The determinism block comes first, and it is the most important one ──────────────────────
 *
 * §38/§40: RONDE 144's golden test proves bit-for-bit determinism over 25 cases and may not be
 * relaxed. Everything this round added to the renderer is therefore strictly OPT-IN, and the first
 * describe below asserts that directly: a clip with no transform, no camera and no effects must
 * produce the byte-identical filter string the renderer produced before. If that assertion ever
 * fails, the golden test is about to fail too — and this one says why in a millisecond instead of
 * sixty seconds.
 *
 * ── Filter strings are tested as strings ─────────────────────────────────────────────────────
 *
 * The interesting failures in a filtergraph are off-by-ones and wrong operand orders, and both are
 * visible in the text. Rendering a video to check them would take forty seconds per case and prove
 * less. The blocks that DO need real ffmpeg — that a zoompan chain actually encodes, that an xfade
 * really joins two clips, that a sidechain mix produces audio — run it at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import {
  DEFAULT_TEXT_STYLE,
  DEFAULT_FORMAT,
  emptyTimeline,
  graphicsTrack,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";
import {
  DEFAULT_TRANSITION_SEC,
  DUCK_AMBIENT,
  DUCK_MUSIC,
  XFADE_TRANSITIONS,
  buildAudioGraph,
  buildTransitionGraph,
  buildVideoFilter,
  cameraChain,
  containChain,
  coverChain,
  cropChain,
  effectChain,
  transitionIsRenderable,
  unsupportedEffects,
  type MixInput,
} from "./timelineFilters";
import { renderTimeline, checkRenderedFile } from "./timelineRenderer";
import { assertRenderableTimeline, validateTimeline } from "./timelineValidator";
import { cameraFor, graphicLabel, RENDERABLE_EFFECTS } from "./edlToTimeline";

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";
const FMT = { widthPx: 320, heightPx: 180, fps: 25 };

let ROOT = "";
let SOURCE_A = "";
let SOURCE_B = "";
let SILENCE = "";
let TONE = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r148c-"));
  const video = async (name: string, pattern: string) => {
    const out = path.join(ROOT, `${name}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `${pattern}=size=320x180:rate=25:duration=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
    ]);
    return out;
  };
  const audio = async (name: string, src: string) => {
    const out = path.join(ROOT, `${name}.mp3`);
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", src, "-t", "6", "-c:a", "libmp3lame", out,
    ]);
    return out;
  };
  SOURCE_A = await video("src_a", "smptebars");
  SOURCE_B = await video("src_b", "testsrc");
  SILENCE = await audio("silence", "anullsrc=r=44100:cl=stereo");
  TONE = await audio("tone", "sine=frequency=440:sample_rate=44100");
}, 300_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

function clip(over: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: "vc_0",
    kind: "video",
    source: { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://loc/1.mp4" },
    timelineStart: 0,
    timelineEnd: 4,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  };
}

/* ═══════════════════════ §38 — the determinism guarantee ═══════════════════════ */

describe("§38 — a clip with no new fields renders EXACTLY as it did before", () => {
  it("THE FILTER STRING IS BYTE-IDENTICAL TO THE OLD INLINE ONE", () => {
    /**
     * This literal is the string `renderSegment` held inline before RONDE 148, copied here
     * character for character. It is the contract that keeps the golden test's bit-for-bit
     * determinism intact: if the new builder ever produces anything else for a plain clip, every
     * existing render changes and 25 golden cases fail.
     */
    const old =
      `scale=320:180:force_original_aspect_ratio=decrease,` +
      `pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=25,format=yuv420p`;
    expect(buildVideoFilter(clip(), FMT, 4)).toBe(old);
    expect(containChain(FMT)).toBe(old);
  });

  it("an EMPTY transform object is still the old string — absence and emptiness agree", () => {
    expect(buildVideoFilter(clip({ transform: {} }), FMT, 4)).toBe(containChain(FMT));
  });

  it("a camera_hold adds nothing, because a no-op zoompan would change every held shot", () => {
    const held = clip({ camera: { type: "camera_hold", startScale: 1, endScale: 1 } });
    expect(buildVideoFilter(held, FMT, 4)).toBe(containChain(FMT));
    expect(cameraChain({ type: "camera_hold" }, FMT, 4)).toBeNull();
  });

  it("an empty effects array adds nothing", () => {
    expect(buildVideoFilter(clip({ effects: [] }), FMT, 4)).toBe(containChain(FMT));
  });

  it("a timeline of hard cuts takes the CONCAT path, not the xfade one", () => {
    // The concat path is a stream copy: no re-encode, no generation loss, deterministic output.
    expect(
      buildTransitionGraph({
        durations: [3, 3, 3],
        transitions: [{ kind: "hard_cut" }, { kind: "hard_cut" }, { kind: "hard_cut" }],
      })
    ).toBeNull();
  });

  it("the same clip built twice gives the same string — nothing here is random or clocked", () => {
    const c = clip({
      transform: { fit: "cover", positionX: 0.4 },
      camera: { type: "slow_push", startScale: 1, endScale: 1.1 },
      effects: [{ effectType: "film_grain", intensity: 0.4 }],
    });
    expect(buildVideoFilter(c, FMT, 4)).toBe(buildVideoFilter(c, FMT, 4));
  });
});

/* ═══════════════════════ §8 — transforms ═══════════════════════ */

describe("§8 — fit, crop, scale, position, opacity", () => {
  it("cover fills the frame and crops the overflow, never squashing it", () => {
    const s = coverChain(FMT);
    // `increase` then crop: a single scale to the exact frame would distort the picture.
    expect(s).toContain("force_original_aspect_ratio=increase");
    expect(s).toContain("crop=320:180");
    expect(s).not.toContain("pad=");
  });

  it("cover can bias toward a subject that is not centred", () => {
    expect(coverChain(FMT, { x: 0.2, y: 0.8 })).toContain("(iw-ow)*0.2000:(ih-oh)*0.8000");
  });

  it("crop takes a NORMALISED rectangle, so it survives a re-fetch at another resolution", () => {
    const s = cropChain(FMT, { x: 0.1, y: 0.2, width: 0.5, height: 0.6 });
    // Expressed against iw/ih rather than pixels — the whole reason it is normalised.
    expect(s).toContain("crop=iw*0.5000:ih*0.6000:iw*0.1000:ih*0.2000");
    expect(s).toContain(containChain(FMT));
  });

  it("scale is applied after the fit and re-cropped to the frame", () => {
    const s = buildVideoFilter(clip({ transform: { scale: 1.4 } }), FMT, 4);
    expect(s.indexOf("scale=iw*1.4000")).toBeGreaterThan(s.indexOf("pad="));
    expect(s).toContain("crop=320:180");
  });

  /**
   * RONDE 160 §8 — this test's NAME was always right and its assertion was always wrong.
   *
   * It asserted `colorchannelmixer=aa=0.5000`, which sets an alpha channel. The chain then
   * converted to `yuv420p`, a format with no alpha — so the alpha was DISCARDED rather than
   * composited, and a clip at opacity 0.5 rendered at full brightness. Measured on a real file:
   * mean red 250 where 127 was correct. The assertion pinned the bug in place.
   *
   * Over black, compositing at opacity O is multiplying the colour by O, which is what the chain
   * does now. `ronde160EditingRender.test.ts` renders it and reads the pixels back; this keeps
   * checking the cheap structural half — that it ends in a format the concat can carry.
   */
  it("opacity composites over black rather than leaving an alpha the concat cannot carry", () => {
    const s = buildVideoFilter(clip({ transform: { opacity: 0.5 } }), FMT, 4);
    expect(s).toContain("colorchannelmixer=rr=0.5000:gg=0.5000:bb=0.5000");
    expect(s, "an alpha channel the concat cannot carry").not.toContain("colorchannelmixer=aa=");
    expect(s.endsWith("format=yuv420p")).toBe(true);
  });

  /**
   * RONDE 160 §8 — the other half of the scale control, which used to make the render FAIL.
   *
   * The test above covers scale > 1, where cropping back to the frame is right. Below 1 there is
   * less picture than frame, and asking ffmpeg to crop the full frame size out of a half-size
   * image is an error it refuses to run — so the clip did not encode at all.
   */
  it("scaling down pads to the frame instead of cropping a picture that is too small", () => {
    const s = buildVideoFilter(clip({ transform: { scale: 0.5 } }), FMT, 4);
    expect(s).toContain("scale=iw*0.5000");
    expect(s).toContain("pad=320:180");
    expect(s, "cropping a frame larger than the picture is an ffmpeg error").not.toContain("crop=320:180");
  });

  /** A scaled clip is placed where the editor asked; only the cover chain used to read these. */
  it("positionX/positionY place a scaled clip rather than always centring it", () => {
    const centred = buildVideoFilter(clip({ transform: { scale: 0.5 } }), FMT, 4);
    const corner = buildVideoFilter(
      clip({ transform: { scale: 0.5, positionX: 0.25, positionY: 0.75 } }),
      FMT,
      4
    );
    expect(centred).toContain("pad=320:180:(ow-iw)*0.5000:(oh-ih)*0.5000");
    expect(corner).toContain("pad=320:180:(ow-iw)*0.2500:(oh-ih)*0.7500");
  });

  it("opacity 1 adds nothing", () => {
    expect(buildVideoFilter(clip({ transform: { opacity: 1 } }), FMT, 4)).toBe(containChain(FMT));
  });
});

/* ═══════════════════════ §14 — camera / Ken Burns ═══════════════════════ */

describe("§14 — camera moves become a zoompan expression", () => {
  it("a push interpolates from its start scale to its end scale over the clip's frames", () => {
    const s = cameraChain({ type: "slow_push", startScale: 1, endScale: 1.12 }, FMT, 4)!;
    expect(s).toContain("zoompan=");
    // 4s at 25fps is 100 frames — the move must be defined over the clip's OWN length.
    expect(s).toContain("d=100");
    expect(s).toContain("z='1.0000+(0.1200)*(on/100)'");
    expect(s).toContain("s=320x180");
  });

  it("IT UPSCALES FIRST, so zooming crops into real pixels rather than softening them", () => {
    const s = cameraChain({ type: "slow_push", startScale: 1, endScale: 1.12 }, FMT, 4)!;
    expect(s.startsWith("scale=640:360")).toBe(true);
    expect(s.indexOf("scale=640:360")).toBeLessThan(s.indexOf("zoompan"));
  });

  it("a pan moves the centre of interest while the scale stays put", () => {
    const s = cameraChain(
      { type: "pan_right", startScale: 1.1, endScale: 1.1, startX: 0.4, endX: 0.6, startY: 0.5, endY: 0.5 },
      FMT, 4
    )!;
    expect(s).toContain("0.4000+(0.2000)*(on/100)");
    expect(s).toContain("z='1.1000+(0.0000)*(on/100)'");
  });

  it("the planner's vocabulary becomes real numbers, and intensity 0 becomes no move", () => {
    expect(cameraFor({ movement: "camera_hold", intensity: 0.8, reason: "r" })).toMatchObject({
      startScale: 1, endScale: 1,
    });
    const push = cameraFor({ movement: "slow_push", intensity: 1, reason: "r" });
    expect(push.startScale).toBe(1);
    expect(push.endScale).toBeCloseTo(1.12, 5);
    const gentle = cameraFor({ movement: "slow_push", intensity: 0.25, reason: "r" });
    expect(gentle.endScale).toBeCloseTo(1.03, 5);
  });

  it("zoom_out starts wide and ends at the frame", () => {
    const pull = cameraFor({ movement: "zoom_out", intensity: 1, reason: "r" });
    expect(pull.startScale).toBeCloseTo(1.12, 5);
    expect(pull.endScale).toBe(1);
  });

  it("every movement the engine knows produces a camera, so none can fall through unmapped", () => {
    for (const m of [
      "ken_burns", "zoom_in", "zoom_out", "slow_push", "slow_pull", "pan_left", "pan_right",
      "tilt_up", "tilt_down", "parallax", "virtual_dolly", "camera_drift", "camera_hold",
    ] as const) {
      const c = cameraFor({ movement: m, intensity: 0.5, reason: "r" });
      expect(c.type, m).toBe(m);
      expect(c.startScale, m).toBeDefined();
    }
  });
});

/* ═══════════════════════ §9 — transitions ═══════════════════════ */

describe("§9 — transitions the renderer can execute, and those it cannot", () => {
  it("the four fade families map to xfade names", () => {
    expect(XFADE_TRANSITIONS.crossfade).toBe("fade");
    expect(XFADE_TRANSITIONS.dissolve).toBe("dissolve");
    expect(XFADE_TRANSITIONS.dip_to_black).toBe("fadeblack");
    expect(XFADE_TRANSITIONS.dip_to_white).toBe("fadewhite");
  });

  it("hard_cut is renderable and is NOT an xfade — a cut is the absence of a transition", () => {
    expect(transitionIsRenderable("hard_cut")).toBe(true);
    expect(XFADE_TRANSITIONS.hard_cut).toBeUndefined();
  });

  /**
   * RONDE 153 changed the answer for `whip`, deliberately.
   *
   * When this test was written neither transition had an implementation, so both were unrenderable
   * and either served as the example. §153 then asked for `whip` specifically, and ffmpeg's
   * `hlwind` xfade mode — verified present in both binaries — is genuinely what a whip pan between
   * two locked-off shots looks like. So `whip` renders now.
   *
   * `film_burn` still does not, and for a reason that will not change with effort: a film burn is
   * FOOTAGE of film burning. ffmpeg can composite such a clip once it exists; it cannot invent one,
   * and a procedural approximation would be a different effect wearing the planner's chosen name.
   * That makes it the better permanent example of the rule this test is really about.
   */
  it("a transition needing an overlay asset is reported, never silently downgraded", () => {
    expect(transitionIsRenderable("film_burn")).toBe(false);
    expect(transitionIsRenderable("light_leak")).toBe(false);
    // Implemented in RONDE 153 — see the note above.
    expect(transitionIsRenderable("whip")).toBe(true);
    // And a name nobody has implemented is still refused.
    expect(transitionIsRenderable("kaleidoscope")).toBe(false);
  });

  it("THE OFFSETS ARE CUMULATIVE, because each overlap shortens the running total", () => {
    /**
     * The arithmetic that is easy to get wrong. Three 3-second clips joined by two 0.5s crossfades
     * run 3 + 2.5 + 2.5 = 8 seconds, and the second xfade's offset is measured on the output of
     * the first — 2.5, not 6.
     */
    const g = buildTransitionGraph({
      durations: [3, 3, 3],
      transitions: [
        { kind: "hard_cut" },
        { kind: "crossfade", durationSec: 0.5 },
        { kind: "crossfade", durationSec: 0.5 },
      ],
    })!;
    expect(g.filter).toContain("offset=2.500");
    expect(g.filter).toContain("offset=5.000");
    expect(g.totalSec).toBeCloseTo(8, 5);
  });

  it("a transition can never be longer than half of its shorter neighbour", () => {
    // xfade with an overlap longer than a clip produces a negative offset and simply fails.
    const g = buildTransitionGraph({
      durations: [1, 1],
      transitions: [{ kind: "hard_cut" }, { kind: "crossfade", durationSec: 10 }],
    })!;
    expect(g.filter).toContain("duration=0.500");
  });

  it("a hard cut INSIDE a transitioned sequence concatenates without an overlap", () => {
    const g = buildTransitionGraph({
      durations: [2, 2, 2],
      transitions: [{ kind: "hard_cut" }, { kind: "hard_cut" }, { kind: "crossfade" }],
    })!;
    expect(g.filter).toContain("concat=n=2:v=1:a=0");
    expect(g.filter).toContain("xfade=transition=fade");
    // 2 + 2 + 2 - 0.5 = 5.5
    expect(g.totalSec).toBeCloseTo(6 - DEFAULT_TRANSITION_SEC, 5);
  });

  it("a single clip has nothing to join", () => {
    expect(buildTransitionGraph({ durations: [4], transitions: [{ kind: "crossfade" }] })).toBeNull();
  });
});

/* ═══════════════════════ §15 — effects ═══════════════════════ */

describe("§15 — effects that run, and effects that are reported", () => {
  it("the three supported effects produce real filters", () => {
    expect(effectChain({ effectType: "film_grain", intensity: 0.5 })).toContain("noise=");
    expect(effectChain({ effectType: "vignette", intensity: 0.5 })).toContain("vignette=angle=");
    expect(effectChain({ effectType: "letterbox", intensity: 1 })).toContain("crop=iw:ih*0.836");
  });

  it("intensity actually changes the filter", () => {
    const light = effectChain({ effectType: "film_grain", intensity: 0 })!;
    const heavy = effectChain({ effectType: "film_grain", intensity: 1 })!;
    expect(light).not.toBe(heavy);
    expect(light).toContain("alls=4");
    expect(heavy).toContain("alls=20");
  });

  it("AN UNSUPPORTED EFFECT IS NAMED, not silently dropped", () => {
    /**
     * RONDE 149 moved glow, bloom, chromatic_aberration and noise OUT of this list by implementing
     * them. What remains needs an overlay ASSET (a flare sprite, a dust plate) rather than a
     * filter, which is a content problem and not an engine one.
     */
    for (const t of ["lens_flare", "particles", "dust"]) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).toBeNull();
    }
    const unsupported = unsupportedEffects([
      { effectType: "film_grain", intensity: 0.5 },
      { effectType: "lens_flare", intensity: 0.5, reason: "the sun breaks through" },
    ]);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.effectType).toBe("lens_flare");
    expect(unsupported[0]!.reason).toBe("the sun breaks through");
  });

  it("the renderer's list and the adapter's list agree", () => {
    // Two lists of supported effects would drift, and the wide one lets a plan promise too much.
    for (const t of RENDERABLE_EFFECTS) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).not.toBeNull();
    }
  });

  it("effects are applied AFTER the camera, so grain does not get zoomed", () => {
    const s = buildVideoFilter(
      clip({
        camera: { type: "slow_push", startScale: 1, endScale: 1.1 },
        effects: [{ effectType: "film_grain", intensity: 0.5 }],
      }),
      FMT, 4
    );
    expect(s.indexOf("zoompan")).toBeLessThan(s.indexOf("noise="));
  });
});

/* ═══════════════════════ §13/§24 — the audio mix ═══════════════════════ */

describe("§13/§24 — the mix, its fades and its ducking", () => {
  const input = (over: Partial<MixInput> = {}): MixInput => ({
    index: 1, kind: "MUSIC", startSec: 0, gain: 1, durationSec: 10, ...over,
  });

  it("each track is delayed to its start and set to its gain", () => {
    const g = buildAudioGraph([input({ startSec: 2.5, gain: 0.3 })])!;
    expect(g.filter).toContain("adelay=2500|2500");
    expect(g.filter).toContain("volume=0.300");
  });

  it("a fade-out is measured from the track's own END, not from zero", () => {
    const g = buildAudioGraph([input({ startSec: 2, durationSec: 8, fadeOutSec: 1.5 })])!;
    // start 2 + duration 8 - fade 1.5 = 8.5
    expect(g.filter).toContain("afade=t=out:st=8.500:d=1.500");
  });

  it("a fade-in starts where the track does", () => {
    const g = buildAudioGraph([input({ startSec: 3, fadeInSec: 2 })])!;
    expect(g.filter).toContain("afade=t=in:st=3.000:d=2.000");
  });

  it("MUSIC DUCKS UNDER VOICE WITH THE EXISTING SIDECHAIN, not a fixed gain", () => {
    /**
     * §14/§34 — `cinematicAudio/mixer.ts` already ducks with sidechaincompress and parameters
     * someone tuned against real narration. Reproducing those numbers rather than inventing new
     * ones is the whole point; this asserts they are the same ones.
     */
    const g = buildAudioGraph([
      input({ index: 1, kind: "VOICE" }),
      input({ index: 2, kind: "MUSIC", gain: 0.2, duckUnderVoice: true }),
    ])!;
    expect(g.filter).toContain("sidechaincompress=");
    expect(g.filter).toContain(`threshold=${DUCK_MUSIC.threshold}`);
    expect(g.filter).toContain(`ratio=${DUCK_MUSIC.ratio}`);
    expect(g.filter).toContain(`attack=${DUCK_MUSIC.attack}`);
    expect(g.filter).toContain(`release=${DUCK_MUSIC.release}`);
  });

  it("AMBIENT ducks more gently than music, because a room tone is not a competing melody", () => {
    const g = buildAudioGraph([
      input({ index: 1, kind: "VOICE" }),
      input({ index: 2, kind: "AMBIENT", duckUnderVoice: true }),
    ])!;
    expect(g.filter).toContain(`ratio=${DUCK_AMBIENT.ratio}`);
    expect(DUCK_AMBIENT.ratio).toBeLessThan(DUCK_MUSIC.ratio);
  });

  it("the voice is SPLIT, because a sidechain consumes its input", () => {
    // Without asplit the voice used to duck the music could not also reach the mix — silent voice.
    const g = buildAudioGraph([
      input({ index: 1, kind: "VOICE" }),
      input({ index: 2, kind: "MUSIC", duckUnderVoice: true }),
      input({ index: 3, kind: "AMBIENT", duckUnderVoice: true }),
    ])!;
    // Two ducked tracks plus the copy that reaches the mix.
    expect(g.filter).toContain("asplit=3");
    expect(g.filter).toContain("[vs0]");
  });

  it("with no voice there is no ducking — attenuating against silence buys nothing", () => {
    const g = buildAudioGraph([input({ kind: "MUSIC", duckUnderVoice: true })])!;
    expect(g.filter).not.toContain("sidechaincompress");
  });

  it("SFX are never ducked — a whoosh under a word is the point of the whoosh", () => {
    const g = buildAudioGraph([
      input({ index: 1, kind: "VOICE" }),
      input({ index: 2, kind: "SFX", duckUnderVoice: true }),
    ])!;
    expect(g.filter).not.toContain("sidechaincompress");
  });

  it("no inputs means no graph, and the renderer copies the silent video through", () => {
    expect(buildAudioGraph([])).toBeNull();
  });
});

/* ═══════════════════════ §12 — graphics ═══════════════════════ */

describe("§12 — the GRAPHICS track carries a payload, not just a string", () => {
  it("a graphic's words come from the planner's own data, never invented", () => {
    expect(graphicLabel("location_card", { locationName: "Berlin" })).toBe("Berlin");
    expect(graphicLabel("date_card", { text: "APRIL 1945" })).toBe("APRIL 1945");
    expect(graphicLabel("chart", { series: [1, 2, 3] })).toBeUndefined();
  });

  it("A LEGACY GRAPHICS TRACK IS READ, not rejected", () => {
    /**
     * The compatibility case that broke eighteen golden tests at once when it was missing. Every
     * timeline saved before this round holds `texts` on this track; reading `.graphics` gives
     * undefined and the first `.filter` throws.
     */
    const t = emptyTimeline(1, DEFAULT_FORMAT);
    t.tracks = [
      { kind: "VIDEO", clips: [] },
      { kind: "GRAPHICS", texts: [
        { id: "g_old", text: "BERLIN", start: 1, end: 3, style: DEFAULT_TEXT_STYLE, animation: "fade" },
      ] } as unknown as ProjectTimeline["tracks"][number],
    ];
    const graphics = graphicsTrack(t);
    expect(graphics).toHaveLength(1);
    // The words survive the migration — that is what makes it a migration and not a loss.
    expect(graphics[0]!.label).toBe("BERLIN");
    expect(graphics[0]!.start).toBe(1);
  });

  it("an empty GRAPHICS track in either shape is simply empty", () => {
    const t = emptyTimeline(1, DEFAULT_FORMAT);
    expect(graphicsTrack(t)).toEqual([]);
  });

  it("a graphic with no words is REPORTED by the validator, not drawn as its own type name", () => {
    const t = emptyTimeline(1, DEFAULT_FORMAT);
    t.tracks = [
      { kind: "VIDEO", clips: [clip()] },
      { kind: "GRAPHICS", graphics: [
        { id: "g_map", graphicType: "map", data: { normX: 0.3 }, start: 0, end: 2, reason: "the route east" },
      ] },
    ];
    t.durationSec = 4;
    const issue = validateTimeline(t).issues.find((i) => i.code === "unsupported_graphic")!;
    expect(issue).toBeDefined();
    expect(issue.reason).toContain("draws no words");
    expect(issue.reason).toContain("the route east");
  });
});

/* ═══════════════════════ §28 — the validator's new checks ═══════════════════════ */

describe("§28 — the validator checks the geometry before ffmpeg sees it", () => {
  const withClip = (over: Partial<TimelineVideoClip>): ProjectTimeline => {
    const t = emptyTimeline(1, FMT);
    t.tracks = [{ kind: "VIDEO", clips: [clip(over)] }];
    t.durationSec = 4;
    return t;
  };
  const codes = (t: ProjectTimeline) => validateTimeline(t).issues.map((i) => i.code);

  it("A ZERO-WIDTH CROP IS CAUGHT — ffmpeg accepts it and yields nothing", () => {
    const t = withClip({ transform: { fit: "crop", crop: { x: 0, y: 0, width: 0, height: 1 } } });
    const issue = validateTimeline(t).issues.find((i) => i.code === "invalid_crop")!;
    expect(issue.reason).toContain("no pixels");
  });

  it("a crop that runs off the edge is caught", () => {
    const t = withClip({ transform: { fit: "crop", crop: { x: 0.8, y: 0, width: 0.5, height: 1 } } });
    expect(validateTimeline(t).issues.find((i) => i.code === "invalid_crop")!.reason)
      .toContain("extends past the source");
  });

  it('fit "crop" with no rectangle is caught', () => {
    expect(codes(withClip({ transform: { fit: "crop" } }))).toContain("invalid_crop");
  });

  it("an out-of-range scale, position and opacity are caught", () => {
    expect(codes(withClip({ transform: { scale: 9 } }))).toContain("invalid_scale");
    expect(codes(withClip({ transform: { positionX: 1.5 } }))).toContain("invalid_position");
    expect(codes(withClip({ transform: { opacity: 2 } }))).toContain("invalid_position");
  });

  it("A CAMERA SCALE BELOW 1 IS CAUGHT — zoompan clamps it and says nothing", () => {
    const t = withClip({ camera: { type: "slow_push", startScale: 0.5, endScale: 1 } });
    const issue = validateTimeline(t).issues.find((i) => i.code === "invalid_camera")!;
    expect(issue.reason).toContain("clamped");
  });

  it("an out-of-range centre of interest is caught", () => {
    expect(codes(withClip({ camera: { type: "pan_left", startX: -1 } }))).toContain("invalid_camera");
  });

  it("a valid transform and camera produce no issues at all", () => {
    const t = withClip({
      transform: { fit: "cover", positionX: 0.4, positionY: 0.5, scale: 1.1, opacity: 1 },
      camera: { type: "slow_push", startScale: 1, endScale: 1.12, intensity: 0.6 },
      effects: [{ effectType: "film_grain", intensity: 0.3 }],
    });
    expect(validateTimeline(t).issues).toEqual([]);
  });

  it("an unsupported effect is reported and does NOT block the render", () => {
    const t = withClip({ effects: [{ effectType: "lens_flare", intensity: 0.5, reason: "sunset" }] });
    const result = validateTimeline(t);
    expect(result.issues.map((i) => i.code)).toContain("unsupported_effect");
    // A plainer video is a real loss; refusing to render at all would be a bigger one.
    expect(() => assertRenderableTimeline(t)).not.toThrow();
  });
});

/* ═══════════════════════ REAL FFMPEG — the chains actually encode ═══════════════════════ */

describe("REAL FFMPEG — every new chain produces a real file", () => {
  const timelineWith = (clips: TimelineVideoClip[]): ProjectTimeline => {
    const t = emptyTimeline(1, FMT);
    t.tracks = [
      { kind: "VIDEO", clips },
      { kind: "VOICE", clips: [] },
      { kind: "MUSIC", clips: [] },
      { kind: "SFX", clips: [] },
      { kind: "AMBIENT", clips: [] },
      { kind: "CAPTIONS", captions: [] },
      { kind: "TEXT", texts: [] },
      { kind: "GRAPHICS", graphics: [] },
    ];
    t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
    return t;
  };

  const render = async (t: ProjectTimeline, name: string) => {
    const out = path.join(ROOT, `${name}.mp4`);
    const result = await renderTimeline({
      timeline: t,
      workDir: path.join(ROOT, `w_${name}`),
      outputPath: out,
      resolveMedia: async (c) => (c.id.endsWith("1") ? SOURCE_B : SOURCE_A),
      resolveAudio: async (id) => (id.startsWith("music") || id.startsWith("amb") ? TONE : SILENCE),
    });
    const check = await checkRenderedFile({ filePath: out, timeline: t, expectAudio: false });
    return { result, check };
  };

  it("A KEN BURNS PUSH RENDERS, and the output is the timeline's own length", async () => {
    const t = timelineWith([
      clip({ id: "vc_0", camera: { type: "slow_push", startScale: 1, endScale: 1.12 } }),
    ]);
    const { result, check } = await render(t, "camera");
    expect(result.camerasExecuted).toBe(1);
    expect(check.problems).toEqual([]);
    expect(check.durationSec).toBeGreaterThan(3.5);
    expect(check.widthPx).toBe(320);
  }, 300_000);

  it("A CROSSFADE RENDERS, and the total length is preserved", async () => {
    /**
     * ── RONDE 184 changed this test's proof, because the old one was the defect ────────────────
     *
     * It used to assert the output was SHORTER than the sum of its clips — 7s for two 4s clips —
     * and called that "the measurable proof that the transition really happened". It was a true
     * measurement of a fault: nothing rendered the handle a crossfade needs, so the fade ate a
     * second of programme. R182 measured the same thing at scale, a 12.00s plan coming out at
     * 10.70s with the picture ending before the narration.
     *
     * `transitionsRendered` is the honest answer to "did the xfade path run", and it does not
     * depend on the video being wrong. The duration then asserts the contract: an overlap consumes
     * MATERIAL, not screen time.
     */
    const t = timelineWith([
      clip({ id: "vc_0", timelineStart: 0, timelineEnd: 4 }),
      clip({
        id: "vc_1", timelineStart: 4, timelineEnd: 8,
        transitionIn: "crossfade", transitionInSec: 1,
        source: { provider: "loc", providerAssetId: "item/2", mediaUrl: "https://loc/2.mp4" },
      }),
    ]);
    const { result, check } = await render(t, "xfade");
    expect(result.transitionsRendered, "the crossfade fell back to a cut").toBe(1);
    expect(check.durationSec).toBeGreaterThan(7.9);
    expect(check.durationSec).toBeLessThan(8.1);
  }, 300_000);

  it("cover, crop and effects all encode", async () => {
    const t = timelineWith([
      clip({ id: "vc_0", timelineStart: 0, timelineEnd: 2, transform: { fit: "cover" } }),
      clip({
        id: "vc_1", timelineStart: 2, timelineEnd: 4,
        transform: { fit: "crop", crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
        effects: [{ effectType: "vignette", intensity: 0.6 }],
        source: { provider: "loc", providerAssetId: "item/2", mediaUrl: "https://loc/2.mp4" },
      }),
    ]);
    const { check } = await render(t, "transforms");
    expect(check.problems).toEqual([]);
    expect(check.hasVideo).toBe(true);
  }, 300_000);

  it("AN UNSUPPORTED EFFECT IS REPORTED BY THE RENDER, and the video is still produced", async () => {
    const t = timelineWith([
      clip({ id: "vc_0", effects: [{ effectType: "lens_flare", intensity: 0.5, reason: "sunset" }] }),
    ]);
    const { result, check } = await render(t, "unsupported_fx");
    expect(check.ok).toBe(true);
    const line = result.skipped.find((s) => s.includes("unsupported_effect"))!;
    expect(line).toContain("lens_flare");
    expect(line).toContain("sunset");
    expect(line).toContain("kept on the timeline");
  }, 300_000);

  it("A DUCKED MIX RENDERS WITH REAL AUDIO", async () => {
    const t = timelineWith([clip({ id: "vc_0", timelineStart: 0, timelineEnd: 4 })]);
    t.tracks = t.tracks.map((tr) => {
      if (tr.kind === "VOICE") {
        return { kind: "VOICE", clips: [{
          id: "voice_0",
          source: { provider: "narration", canonicalUrl: "/local-storage/v.mp3" },
          start: 0, end: 4, gain: 1,
        }] };
      }
      if (tr.kind === "MUSIC") {
        return { kind: "MUSIC", clips: [{
          id: "music_0",
          source: { provider: "cinematic_audio", canonicalUrl: "/local-storage/m.mp3" },
          start: 0, end: 4, gain: 0.25, fadeInSec: 0.5, fadeOutSec: 0.5, duckUnderVoice: true,
        }] };
      }
      return tr;
    });

    const out = path.join(ROOT, "ducked.mp4");
    const result = await renderTimeline({
      timeline: t,
      workDir: path.join(ROOT, "w_ducked"),
      outputPath: out,
      resolveMedia: async () => SOURCE_A,
      resolveAudio: async (id) => (id.startsWith("music") ? TONE : SILENCE),
    });
    expect(result.audioTracks).toBe(2);
    expect(result.duckedTracks).toBe(1);

    const check = await checkRenderedFile({ filePath: out, timeline: t, expectAudio: true });
    expect(check.problems).toEqual([]);
    expect(check.hasAudio).toBe(true);
  }, 300_000);

  it("a labelled graphic is DRAWN through the same ASS pass as text", async () => {
    const t = timelineWith([clip({ id: "vc_0" })]);
    t.tracks = t.tracks.map((tr) =>
      tr.kind === "GRAPHICS"
        ? { kind: "GRAPHICS", graphics: [{
            id: "g_0", graphicType: "location_card", data: { locationName: "BERLIN" },
            start: 0.5, end: 3, label: "BERLIN",
          }] }
        : tr
    );
    const { result, check } = await render(t, "graphic_label");
    expect(result.textsDrawn).toBe(1);
    expect(check.ok).toBe(true);
  }, 300_000);
});
