/**
 * RONDE 148 §8/§9/§14/§19 — the ffmpeg filter strings, as pure functions.
 *
 * ── Why these are not inside the renderer ────────────────────────────────────────────────────
 *
 * Two reasons, and the second is the one that matters.
 *
 * The first is §31: the renderer was becoming a god-function, and a filtergraph builder is a
 * genuinely separate responsibility from orchestrating three ffmpeg passes.
 *
 * The second is testability. A filter string is where a render goes wrong — an off-by-one in a
 * zoompan expression produces a jitter nobody notices until it is in a customer's video, and the
 * only way to catch it is to look at the string. Here it can be asserted exactly, character for
 * character, without spending forty seconds of ffmpeg per case.
 *
 * ── THE DETERMINISM RULE THAT SHAPES EVERY FUNCTION HERE ─────────────────────────────────────
 *
 * A clip with no transform, no camera and no effects MUST produce the byte-identical filter chain
 * the renderer produced before this round. RONDE 144's golden test proves bit-for-bit determinism
 * over 25 cases, and §38/§40 forbid relaxing it. So every addition below is strictly opt-in: the
 * absence of a field is not "the default value of that field", it is "this stage does not appear
 * in the chain at all". That is why `buildVideoFilter` starts from the old string and appends,
 * rather than building a general pipeline that happens to reduce to the old one.
 *
 * ── Ducking is the existing filter, not a new one ────────────────────────────────────────────
 *
 * `cinematicAudio/mixer.ts` already ducks with `sidechaincompress`, with thresholds and ratios
 * someone tuned against real narration. §14 says to use it rather than a fixed gain, and §34 says
 * not to build a second audio system, so `duckingChain` reproduces that filter's parameters
 * exactly — see the constants, which are copied from it rather than re-invented.
 */
import type {
  AudioDucking,
  AudioKeyframe,
  ClipCamera,
  ClipEffect,
  ClipSourceKind,
  ClipTransform,
  TimelineFormat,
  TimelineLook,
  TimelineVideoClip,
} from "./projectTimeline";
/**
 * The grade itself comes from `documentaryStyle`, which has held these calibrations for a long
 * time. RONDE 149 connects them to the timeline; it does not re-tune them.
 */
import {
  buildPerClipDocumentaryGradeVF,
  type DocGradeSourceKind,
} from "./documentaryStyle";

/* ═══════════════════════ video ═══════════════════════ */

/** The scale-and-pad every clip has always had. Kept as one string so it can be compared. */
export function containChain(fmt: TimelineFormat): string {
  return (
    `scale=${fmt.widthPx}:${fmt.heightPx}:force_original_aspect_ratio=decrease,` +
    `pad=${fmt.widthPx}:${fmt.heightPx}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,fps=${fmt.fps},format=yuv420p`
  );
}

/**
 * Fill the frame and crop the overflow, rather than padding it.
 *
 * `force_original_aspect_ratio=increase` scales until BOTH dimensions cover, then the crop takes
 * the middle. The two-step is necessary: a single scale to the exact frame would squash the
 * picture, which is the one thing nobody ever wants.
 */
export function coverChain(fmt: TimelineFormat, position?: { x?: number; y?: number }): string {
  // 0.5/0.5 keeps the middle; the planner can bias toward a subject that is not centred.
  const px = clamp01(position?.x ?? 0.5);
  const py = clamp01(position?.y ?? 0.5);
  return (
    `scale=${fmt.widthPx}:${fmt.heightPx}:force_original_aspect_ratio=increase,` +
    `crop=${fmt.widthPx}:${fmt.heightPx}:(iw-ow)*${px.toFixed(4)}:(ih-oh)*${py.toFixed(4)},` +
    `setsar=1,fps=${fmt.fps},format=yuv420p`
  );
}

/**
 * An explicit rectangle of the source, in normalised coordinates.
 *
 * Normalised because the crop must survive rehydration: the same asset re-fetched at a different
 * resolution would make a pixel rectangle mean a different part of the picture, and a crop that
 * silently moves is worse than no crop.
 */
export function cropChain(fmt: TimelineFormat, crop: NonNullable<ClipTransform["crop"]>): string {
  const w = clamp01(crop.width) || 1;
  const h = clamp01(crop.height) || 1;
  const x = clamp01(crop.x);
  const y = clamp01(crop.y);
  return (
    `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},` +
    containChain(fmt)
  );
}

/**
 * Ken Burns and pans, as a zoompan expression.
 *
 * ── Why zoompan and not scale+crop per frame ────────────────────────────────────────────────
 *
 * zoompan exists in both the system build and the bundled ffmpeg-static (checked, along with
 * xfade — drawtext is the one that is missing, which is why text goes through libass). It
 * interpolates over `d` frames, so the move is defined by its endpoints and is frame-exact rather
 * than accumulated, which is what makes it deterministic.
 *
 * ── The upscale in front of it ───────────────────────────────────────────────────────────────
 *
 * zoompan samples from the INPUT resolution, so zooming a frame that is already the output size
 * produces visible softness. Scaling up first (a common documentary trick, and what the old
 * compose path did) means the zoom crops into real pixels. 2× is enough for a 1.12 push with
 * headroom and cheap enough not to matter.
 */
export function cameraChain(
  camera: ClipCamera,
  fmt: TimelineFormat,
  durationSec: number
): string | null {
  const start = camera.startScale ?? 1;
  const end = camera.endScale ?? 1;
  const sx = camera.startX ?? 0.5;
  const sy = camera.startY ?? 0.5;
  const ex = camera.endX ?? 0.5;
  const ey = camera.endY ?? 0.5;

  const still = Math.abs(start - 1) < 0.001 && Math.abs(end - 1) < 0.001;
  const noPan = Math.abs(sx - ex) < 0.001 && Math.abs(sy - ey) < 0.001;
  // A camera_hold is not a move, and emitting a no-op zoompan would cost a re-encode for nothing —
  // and, worse, would change the pixels of every held shot in every existing render.
  if (still && noPan) return null;

  const frames = Math.max(1, Math.round(durationSec * fmt.fps));
  // Linear in `on` (the output frame index). Deterministic: the same clip yields the same frames.
  const t = `(on/${frames})`;
  const zoomExpr = `${start.toFixed(4)}+(${(end - start).toFixed(4)})*${t}`;
  const cx = `${sx.toFixed(4)}+(${(ex - sx).toFixed(4)})*${t}`;
  const cy = `${sy.toFixed(4)}+(${(ey - sy).toFixed(4)})*${t}`;

  return (
    `scale=${fmt.widthPx * 2}:${fmt.heightPx * 2}:force_original_aspect_ratio=decrease,` +
    `pad=${fmt.widthPx * 2}:${fmt.heightPx * 2}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `zoompan=z='${zoomExpr}':x='iw*${cx}-(iw/zoom/2)':y='ih*${cy}-(ih/zoom/2)':` +
    `d=${frames}:s=${fmt.widthPx}x${fmt.heightPx}:fps=${fmt.fps},` +
    `setsar=1,format=yuv420p`
  );
}

/**
 * The effects this renderer can execute, and only those.
 *
 * Each is a filter that exists in both ffmpeg builds — CHECKED, not assumed: zoompan, xfade,
 * sidechaincompress, vignette, noise, rgbashift, gblur, blend, split and colorchannelmixer were all
 * confirmed present in the system build AND in the bundled ffmpeg-static before being used here.
 *
 * An effect not in this table is not silently dropped — `unsupportedEffects` names it, the clip
 * keeps carrying it, and the render reports it with the planner's own reason.
 */
export function effectChain(effect: ClipEffect): string | null {
  const i = Math.max(0, Math.min(1, effect.intensity));
  switch (effect.effectType) {
    case "film_grain":
    case "noise":
      // noise strength is 0..100; a documentary grain lives at the very bottom of that range.
      return `noise=alls=${Math.round(4 + 16 * i)}:allf=t+u`;
    case "vignette":
      // The angle is the falloff: PI/5 is a heavy vignette, PI/2.6 barely visible.
      return `vignette=angle=${(Math.PI / 2.6 - (Math.PI / 2.6 - Math.PI / 5) * i).toFixed(4)}`;
    case "letterbox":
      // A 2.39:1 crop-and-pad, the cinematic bar. Independent of intensity: it is on or it is not.
      return `crop=iw:ih*0.836:0:ih*0.082,pad=iw:ih/0.836:0:(oh-ih)/2:color=black`;

    /**
     * RONDE 149 — glow and bloom, as the classic split-blur-screen sandwich.
     *
     * The picture is split in two, one copy is blurred, and the blurred copy is screen-blended back
     * over the original. Screen only ever brightens, so the effect gathers in the highlights and
     * leaves the shadows alone — which is what makes it read as light bleeding rather than as a
     * soft-focus filter over everything.
     *
     * The two differ by radius and weight, which is genuinely what separates them: a glow is a tight
     * halo around bright edges, a bloom is a wide wash across the frame.
     */
    case "glow":
      return (
        `split[glowa][glowb];[glowb]gblur=sigma=${(2 + 6 * i).toFixed(2)}[glowblur];` +
        `[glowa][glowblur]blend=all_mode=screen:all_opacity=${(0.25 + 0.35 * i).toFixed(3)}`
      );
    case "bloom":
      return (
        `split[blooma][bloomb];[bloomb]gblur=sigma=${(8 + 18 * i).toFixed(2)}[bloomblur];` +
        `[blooma][bloomblur]blend=all_mode=screen:all_opacity=${(0.2 + 0.3 * i).toFixed(3)}`
      );

    /**
     * Chromatic aberration: the red and blue channels pulled apart by a pixel or two.
     *
     * `rgbashift` does exactly this natively, so there is no channel-splitting graph to get wrong.
     * Red goes one way and blue the other, which is how a real lens disperses — shifting them the
     * same way would just look like a misregistered print.
     *
     * Deliberately capped at 3px. Beyond that it stops reading as a lens and starts reading as a
     * broken video, and this is a documentary tool.
     */
    case "chromatic_aberration": {
      const shift = Math.max(1, Math.round(3 * i));
      return `rgbashift=rh=${shift}:bh=${-shift}`;
    }

    /* ══════════ RONDE 153B — the tone and colour effects ══════════
     *
     * Every one of these is a single, well-understood ffmpeg filter with a BOUNDED parameter, and
     * the bound is the interesting part. `eq` will happily take a contrast of 1000 and produce a
     * frame of pure primaries; `intensity` is 0..1 and each range below was chosen so that
     * intensity 1 is the strongest setting that still looks like a graded shot rather than a
     * broken one. A documentary tool should not be able to express a broken frame.
     */
    case "blur":
      return `gblur=sigma=${(0.5 + 7.5 * i).toFixed(2)}`;
    case "sharpen":
      // unsharp's amount, kept under 2.0 — past that it rings visibly on any compressed source.
      return `unsharp=5:5:${(0.3 + 1.5 * i).toFixed(2)}`;
    case "exposure":
      // A stop either way. `intensity` is the magnitude; `direction` chooses the sign.
      return `eq=brightness=${signed(effect, 0.35 * i).toFixed(4)}`;
    case "contrast":
      return `eq=contrast=${(1 + signed(effect, 0.6 * i)).toFixed(4)}`;
    case "saturation":
      return `eq=saturation=${Math.max(0, 1 + signed(effect, 0.8 * i)).toFixed(4)}`;
    /**
     * Temperature and tint move the picture on the two axes a colourist uses. Implemented with
     * `colorbalance`'s midtone controls rather than `colorchannelmixer`, because midtones are where
     * a white-balance error actually lives — pushing the whole channel would tint the blacks too.
     */
    case "temperature": {
      const t = signed(effect, 0.3 * i);
      return `colorbalance=rm=${t.toFixed(4)}:bm=${(-t).toFixed(4)}`;
    }
    case "tint": {
      const t = signed(effect, 0.3 * i);
      return `colorbalance=gm=${t.toFixed(4)}:rm=${(t / 2).toFixed(4)}`;
    }
    case "monochrome":
      return `hue=s=${Math.max(0, 1 - i).toFixed(3)}`;
    /**
     * Sepia is a fixed matrix, so `intensity` blends toward it rather than scaling it — a
     * half-strength sepia is half-way between the original and the full tone, which is what the
     * word means. Scaling the matrix itself would produce a different, muddier colour.
     */
    case "sepia": {
      const k = i;
      const mix = (a: number, b: number) => (a + (b - a) * k).toFixed(4);
      return (
        `colorchannelmixer=` +
        `rr=${mix(1, 0.393)}:rg=${mix(0, 0.769)}:rb=${mix(0, 0.189)}:` +
        `gr=${mix(0, 0.349)}:gg=${mix(1, 0.686)}:gb=${mix(0, 0.168)}:` +
        `br=${mix(0, 0.272)}:bg=${mix(0, 0.534)}:bb=${mix(1, 0.131)}`
      );
    }
    /**
     * Scanlines: a horizontal comb, drawn by squeezing the picture to half height and back with
     * nearest-neighbour sampling so alternate rows keep their own value.
     *
     * `intensity` controls how dark the dropped rows go, via a blend against the original.
     */
    case "scanlines":
      return (
        `split[scana][scanb];` +
        `[scanb]scale=iw:ih/2:flags=neighbor,scale=iw:ih*2:flags=neighbor[scanl];` +
        `[scana][scanl]blend=all_mode=multiply:all_opacity=${(0.15 + 0.45 * i).toFixed(3)}`
      );

    default:
      return null;
  }
}

/**
 * An effect's direction, for the ones that can go either way.
 *
 * Exposure, contrast, saturation, temperature and tint are all signed: a colourist warms OR cools.
 * `intensity` carries the magnitude, so the sign needs its own field, and `direction: "down"` is
 * the only thing that makes it negative. Absent means up — which is what every effect written
 * before this round meant.
 */
function signed(effect: ClipEffect, magnitude: number): number {
  return effect.direction === "down" ? -magnitude : magnitude;
}

/* ═══════════════════════ RONDE 153B §"gebruik schema-validatie" ═══════════════════════ */

/**
 * Every effect this renderer can execute, and nothing else.
 *
 * A closed set rather than an open string is the whole defence against the injection §153B names:
 * `effectChain` is the only place an effect name becomes part of an ffmpeg command, it switches on
 * this vocabulary, and an unknown name falls through to `null` — it cannot reach the command line.
 * The numbers are computed from a CLAMPED 0..1 and formatted with `toFixed`, so no caller-supplied
 * string is ever interpolated into a filter.
 */
export const RENDERABLE_EFFECTS: ReadonlySet<string> = new Set([
  "film_grain", "noise", "vignette", "letterbox", "glow", "bloom", "chromatic_aberration",
  "blur", "sharpen", "exposure", "contrast", "saturation", "temperature", "tint",
  "monochrome", "sepia", "scanlines",
]);

/**
 * Effects that need a real overlay ASSET and are therefore never approximated.
 *
 * `film_dust` is footage of dust and scratches on a print; `vhs` is a tape artefact chain that
 * genuinely needs a reference. ffmpeg can composite either perfectly once the asset exists — what
 * it cannot do is invent one. Reported with this reason, never faked.
 */
export const OVERLAY_EFFECTS: Readonly<Record<string, string>> = {
  film_dust: "needs a dust-and-scratches overlay clip; none is configured",
  vhs: "needs a VHS artefact reference; a procedural approximation would be a different effect",
};

/** Why an effect cannot be executed, in the planner's terms. Null when it can. */
export function effectUnsupportedReason(effectType: string): string | null {
  if (RENDERABLE_EFFECTS.has(effectType)) return null;
  if (effectType in OVERLAY_EFFECTS) return OVERLAY_EFFECTS[effectType]!;
  return "no ffmpeg filter chain implements this effect";
}

/**
 * Validate an effect before it is allowed near a filtergraph.
 *
 * Returns the effect with its intensity clamped, or a reason it was refused. Deliberately
 * conservative about non-finite numbers: NaN formats as "NaN" through `toFixed`, which ffmpeg
 * parses as a filter syntax error and takes the whole render down.
 */
export function validateEffect(
  effect: ClipEffect
): { ok: true; effect: ClipEffect } | { ok: false; reason: string } {
  const reason = effectUnsupportedReason(effect.effectType);
  if (reason) return { ok: false, reason };
  if (!Number.isFinite(effect.intensity)) {
    return { ok: false, reason: `intensity is ${String(effect.intensity)}, not a number` };
  }
  if (effect.direction != null && effect.direction !== "up" && effect.direction !== "down") {
    return { ok: false, reason: `direction "${String(effect.direction)}" is neither up nor down` };
  }
  return { ok: true, effect: { ...effect, intensity: Math.max(0, Math.min(1, effect.intensity)) } };
}

/* ═══════════════════════ RONDE 149 — the look ═══════════════════════ */

/**
 * The video's colour treatment, from `documentaryStyle`'s own calibration.
 *
 * NOT re-derived here. Those saturation and contrast numbers were tuned per source kind so that
 * archive, stock and generated material end up looking like one film, and inventing a second set
 * would mean two answers to the same question with the tested one losing.
 *
 * `strength` scales the grade toward neutral — 1 is the shipped calibration, 0 is no grade at all.
 * It interpolates rather than switching, so a strength of 0.5 is genuinely half the correction and
 * not a different look.
 */
/**
 * RONDE 153 — what each look ADDS on top of the documentary calibration.
 *
 * Every value is a small `eq`/`colorbalance` adjustment applied AFTER the source-aware grade, and
 * that ordering is the whole design: the calibration is what makes mixed sources belong together,
 * so a look modifies the result rather than replacing the correction. §153 forbids a second colour
 * system, and this is how that promise is kept structurally rather than by convention.
 *
 * The numbers are small on purpose. A look is a mood, not a filter — anything strong enough to be
 * obvious in isolation is strong enough to fight the calibration underneath it.
 */
export const LOOK_MODIFIERS: Readonly<Record<string, string | null>> = {
  /** The calibration alone. */
  documentary: null,
  /** Cooler shadows, a little more contrast, slightly desaturated — the feature-film reading. */
  cinematic: "eq=contrast=1.08:saturation=0.94,colorbalance=bs=0.06:rs=-0.04",
  /** Warm highlights, lifted blacks, softer colour: the look of an aged print. */
  vintage: "eq=contrast=0.95:saturation=0.82:brightness=0.02,colorbalance=rm=0.10:bm=-0.08",
  /** Nearly monochrome with a cool cast, for material that should read as a record. */
  archival: "eq=contrast=1.05:saturation=0.55,colorbalance=bs=0.05",
  cold: "colorbalance=bm=0.12:rm=-0.08",
  warm: "colorbalance=rm=0.12:bm=-0.08",
  high_contrast: "eq=contrast=1.25:saturation=1.05",
  muted: "eq=contrast=0.96:saturation=0.7",
};

/** Every look this renderer can execute. `none` is handled before the table is consulted. */
export const RENDERABLE_LOOKS: ReadonlySet<string> = new Set(["none", ...Object.keys(LOOK_MODIFIERS)]);

export function lookUnsupportedReason(grade: string): string | null {
  return RENDERABLE_LOOKS.has(grade) ? null : `no grade chain implements the look "${grade}"`;
}

export function gradeChain(
  look: TimelineLook | undefined,
  sourceKind: ClipSourceKind | undefined
): string | null {
  if (!look || look.grade === "none") return null;
  /** An unknown look leaves the pixels alone and is reported — never approximated by a near one. */
  if (!RENDERABLE_LOOKS.has(look.grade)) return null;
  const strength = look.strength == null ? 1 : Math.max(0, Math.min(1, look.strength));
  if (strength <= 0.001) return null;

  const kind: DocGradeSourceKind =
    sourceKind === "archive" || sourceKind === "stock" || sourceKind === "ai_generated"
      ? sourceKind
      : "unknown";

  /**
   * RONDE 153 — the look's modifier is appended at EVERY exit, not just one.
   *
   * An earlier version of this appended it only to the interpolated branch below, so a look at full
   * strength — the common case — returned through `buildPerClipDocumentaryGradeVF` and quietly lost
   * its modifier. The video graded, looked plausible, and was not the look that was chosen. Hence
   * one helper used by both returns.
   */
  const modifier = LOOK_MODIFIERS[look.grade];
  const withLook = (calibration: string) => (modifier ? `${calibration},${modifier}` : calibration);

  const full = buildPerClipDocumentaryGradeVF(kind);
  if (strength >= 0.999) return withLook(full);

  /**
   * Interpolating a filter string is not possible, so the NUMBERS are interpolated instead and the
   * chain rebuilt. Each parameter moves from its neutral value toward the graded one:
   * contrast and saturation from 1, brightness and the colour balance from 0, gamma from 1.
   */
  const mix = (neutral: number, graded: number) => neutral + (graded - neutral) * strength;
  const { saturation, contrast } =
    kind === "ai_generated"
      ? { saturation: 0.78, contrast: 1.08 }
      : kind === "stock"
        ? { saturation: 0.82, contrast: 1.15 }
        : { saturation: 0.88, contrast: 1.12 };
  const angle = kind === "ai_generated" || kind === "stock" ? 0.55 : 0.62;
  const calibration =
    `eq=contrast=${mix(1, contrast).toFixed(4)}:saturation=${mix(1, saturation).toFixed(4)}:` +
    `brightness=${mix(0, -0.03).toFixed(4)}:gamma=${mix(1, 1.02).toFixed(4)},` +
    `colorbalance=rs=${mix(0, -0.02).toFixed(4)}:gs=0:bs=${mix(0, 0.04).toFixed(4)}:` +
    `rm=${mix(0, -0.01).toFixed(4)}:gm=0:bm=${mix(0, 0.02).toFixed(4)}:` +
    `rh=${mix(0, -0.01).toFixed(4)}:gh=0:bh=${mix(0, 0.02).toFixed(4)},` +
    `vignette=angle=${mix(Math.PI / 2, angle).toFixed(4)}:mode=forward`;

  return withLook(calibration);
}

export function unsupportedEffects(effects: readonly ClipEffect[] | undefined): ClipEffect[] {
  return (effects ?? []).filter((e) => effectChain(e) === null);
}

/**
 * The whole video filter chain for one clip.
 *
 * THE ORDER IS THE POINT: fit, then camera, then effects, then opacity. A grain applied before a
 * zoom gets zoomed (so the grain size changes as the camera moves, which looks like a fault); a
 * vignette applied before a crop has its corners cut off. Fixing the order here is what stops
 * every future effect from having to think about it.
 *
 * A clip with none of the new fields returns EXACTLY `containChain` — the string this renderer has
 * always produced. That equality is asserted by a test, because it is what keeps the golden
 * render bit-for-bit identical.
 */
export function buildVideoFilter(
  clip: TimelineVideoClip,
  fmt: TimelineFormat,
  durationSec: number,
  /** RONDE 149 — the video's look. Absent leaves the pixels untouched. */
  look?: TimelineLook
): string {
  const t = clip.transform;
  const parts: string[] = [];

  if (t?.fit === "crop" && t.crop) parts.push(cropChain(fmt, t.crop));
  else if (t?.fit === "cover") parts.push(coverChain(fmt, { x: t.positionX, y: t.positionY }));
  else parts.push(containChain(fmt));

  const camera = clip.camera ? cameraChain(clip.camera, fmt, durationSec) : null;
  if (camera) parts.push(camera);

  /**
   * The grade goes AFTER the camera and BEFORE the effects, and both halves of that matter.
   *
   * After the camera, because zoompan resamples: grading first would grade pixels that are then
   * thrown away, and the correction would drift as the frame moves.
   *
   * Before the effects, because grain and glow are meant to sit ON the graded picture. Grading a
   * frame that already has synthetic grain in it pulls the saturation of the grain itself, which
   * turns a subtle texture into visible coloured speckle.
   */
  const grade = gradeChain(look, clip.sourceKind);
  if (grade) parts.push(grade);

  for (const effect of clip.effects ?? []) {
    const chain = effectChain(effect);
    if (chain) parts.push(chain);
  }

  // Scale is applied last of the geometry so it composes with whatever fit produced the frame.
  if (t?.scale != null && Math.abs(t.scale - 1) > 0.001) {
    const s = Math.max(0.1, Math.min(4, t.scale));
    parts.push(
      `scale=iw*${s.toFixed(4)}:ih*${s.toFixed(4)},` +
        `crop=${fmt.widthPx}:${fmt.heightPx}:(iw-ow)/2:(ih-oh)/2`
    );
  }
  if (t?.opacity != null && t.opacity < 0.999) {
    const o = Math.max(0, Math.min(1, t.opacity));
    // Composited over black rather than left with an alpha channel, which the concat cannot carry.
    parts.push(`format=yuva420p,colorchannelmixer=aa=${o.toFixed(4)},format=yuv420p`);
  }
  return parts.join(",");
}

/* ═══════════════════════ transitions ═══════════════════════ */

/**
 * The renderer's transitions, mapped to xfade's own vocabulary.
 *
 * `hard_cut` is deliberately absent: a cut is the ABSENCE of a transition, and the concat path
 * that produces one is both faster and lossless. Giving it an xfade name would send every cut
 * through a re-encode for no picture difference at all.
 */
export const XFADE_TRANSITIONS: Readonly<Record<string, string>> = {
  crossfade: "fade",
  dissolve: "dissolve",
  dip_to_black: "fadeblack",
  dip_to_white: "fadewhite",

  /* ── RONDE 153 — every one of these is a real xfade mode, VERIFIED present ────────────────
   *
   * Checked against BOTH binaries this repo can run: the system ffmpeg 6.1.1 and the bundled
   * ffmpeg-static 5.3.0. Nothing here is aspirational — an xfade name that only one binary knows
   * would produce a video on a developer's machine and a filtergraph error in production.
   */
  slide_left: "slideleft",
  slide_right: "slideright",
  slide_up: "slideup",
  slide_down: "slidedown",
  /** `push` is a cover: the incoming shot pushes the outgoing one out of frame. */
  push: "coverleft",
  push_right: "coverright",
  wipe: "wipeleft",
  wipe_right: "wiperight",
  wipe_up: "wipeup",
  wipe_down: "wipedown",
  /** A blurred dissolve — the honest reading of "blur" as a transition between two shots. */
  blur: "hblur",
  /**
   * `whip` is a fast horizontal wind smear, which is what a whip pan looks like between two
   * locked-off shots. It is NOT a camera move; the engine's camera vocabulary handles those.
   */
  whip: "hlwind",
  whip_right: "hrwind",
  zoom: "zoomin",
  /**
   * `flash` uses fadewhite. A flash is a dip to white with a much shorter duration, and the
   * duration is the planner's to choose — so this is the same filter, not a different one, and
   * saying so here stops someone adding a duplicate.
   */
  flash: "fadewhite",
  radial: "radial",
  pixelize: "pixelize",
  squeeze: "squeezeh",
};

/**
 * RONDE 153 — transitions that need a real overlay asset, and are therefore NOT faked.
 *
 * `film_burn` and `light_leak` are optical effects: real ones are footage of film burning or light
 * striking a lens, composited over the join. ffmpeg can composite such a clip perfectly well — what
 * it cannot do is invent one, and a procedural approximation would be a different effect wearing
 * the name of the one the planner chose.
 *
 * So they stay OUT of `XFADE_TRANSITIONS` and are reported as `unsupported_transition` with this
 * reason attached. `transitionOverlayAsset` below is the hook a real asset plugs into.
 */
export const OVERLAY_TRANSITIONS: Readonly<Record<string, string>> = {
  film_burn: "needs a film-burn overlay clip; none is configured",
  light_leak: "needs a light-leak overlay clip; none is configured",
};

export function transitionIsRenderable(kind: string): boolean {
  return kind === "hard_cut" || kind in XFADE_TRANSITIONS;
}

/**
 * Why a transition cannot be executed, in the planner's terms. Null when it can.
 *
 * §153: "Niet terugvallen naar hard_cut zonder melding." This is the melding.
 */
export function transitionUnsupportedReason(kind: string): string | null {
  if (transitionIsRenderable(kind)) return null;
  if (kind in OVERLAY_TRANSITIONS) return OVERLAY_TRANSITIONS[kind]!;
  return "no ffmpeg xfade mode implements this transition";
}

/** The default a planner-less timeline gets. Short enough to read as a cut with a soft edge. */
export const DEFAULT_TRANSITION_SEC = 0.5;

/**
 * The filtergraph that joins a list of segments with transitions.
 *
 * Returns null when every join is a hard cut, which sends the render down the concat path — the
 * one that is a stream copy. Building an xfade graph for a video of pure cuts would re-encode the
 * whole thing to produce the same pixels.
 *
 * ── The offset arithmetic, which is the part that is easy to get wrong ───────────────────────
 *
 * xfade's `offset` is measured on the OUTPUT of the chain so far, and each transition overlaps its
 * two inputs, so every join shortens the running total by its own duration. `elapsed` tracks that,
 * which is why the offsets are cumulative rather than the clips' own start times.
 */
export function buildTransitionGraph(params: {
  durations: readonly number[];
  /** The transition INTO each segment. Index 0 is ignored: nothing precedes the first clip. */
  transitions: readonly { kind: string; durationSec?: number }[];
}): { filter: string; totalSec: number } | null {
  const { durations, transitions } = params;
  if (durations.length < 2) return null;

  const joins = durations.slice(1).map((_, i) => {
    const t = transitions[i + 1];
    const name = t ? XFADE_TRANSITIONS[t.kind] : undefined;
    if (!name) return null;
    // Never longer than either neighbour, or xfade produces a negative offset and fails.
    const maxSec = Math.min(durations[i]!, durations[i + 1]!) * 0.5;
    return { name, sec: Math.max(0.05, Math.min(t?.durationSec ?? DEFAULT_TRANSITION_SEC, maxSec)) };
  });
  if (joins.every((j) => j === null)) return null;

  const steps: string[] = [];
  let label = "0:v";
  let elapsed = durations[0]!;
  for (let i = 1; i < durations.length; i++) {
    const join = joins[i - 1];
    const out = i === durations.length - 1 ? "vout" : `v${i}`;
    if (!join) {
      // A hard cut inside an otherwise-transitioned sequence: concat the two, no overlap.
      steps.push(`[${label}][${i}:v]concat=n=2:v=1:a=0[${out}]`);
      elapsed += durations[i]!;
    } else {
      const offset = Math.max(0, elapsed - join.sec);
      steps.push(
        `[${label}][${i}:v]xfade=transition=${join.name}:duration=${join.sec.toFixed(3)}:` +
          `offset=${offset.toFixed(3)}[${out}]`
      );
      elapsed = elapsed - join.sec + durations[i]!;
    }
    label = out;
  }
  return { filter: steps.join(";"), totalSec: elapsed };
}

/* ═══════════════════════ audio ═══════════════════════ */

/**
 * The ducking parameters, copied verbatim from `cinematicAudio/mixer.ts`.
 *
 * §14/§34: reuse the existing approach rather than inventing a second one. Those numbers were
 * tuned against real narration — music ducks harder and faster than ambience, because a music bed
 * competes with speech in the same frequencies and a room tone does not. Re-deriving them here
 * would mean two answers to one question, and the other one is the tested one.
 */
export const DUCK_MUSIC = { threshold: 0.02, ratio: 8, attack: 5, release: 200, makeup: 1 } as const;
export const DUCK_AMBIENT = { threshold: 0.03, ratio: 4, attack: 10, release: 300, makeup: 1 } as const;

export type MixInput = {
  /** ffmpeg input index. */
  index: number;
  kind: "VOICE" | "MUSIC" | "SFX" | "AMBIENT";
  startSec: number;
  gain: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  durationSec: number;
  duckUnderVoice?: boolean;
  /* ── RONDE 154 ── */
  ducking?: AudioDucking;
  automation?: AudioKeyframe[];
  delaySec?: number;
};

/* ═══════════════════════ RONDE 154 — ducking, bounded ═══════════════════════ */

/**
 * The sidechain parameters for one track: the calibrated default, adjusted by whatever the timeline
 * asked for, and CLAMPED.
 *
 * The clamps are not defensive politeness. `ratio` is the one that matters: sidechaincompress
 * accepts values into the hundreds, and anything past about 20 stops being a duck and becomes a
 * gate — the music does not dip under the voice, it vanishes and reappears, which sounds like a
 * broken file rather than a mix. `threshold` at 0 makes the compressor act on silence, so the
 * track is permanently suppressed even where there is no narration at all.
 */
export function duckingParams(
  kind: MixInput["kind"],
  override: AudioDucking | undefined
): { threshold: number; ratio: number; attack: number; release: number; makeup: number } {
  const base = kind === "AMBIENT" ? DUCK_AMBIENT : DUCK_MUSIC;
  const clamp = (v: number | undefined, lo: number, hi: number, fallback: number) =>
    v == null || !Number.isFinite(v) ? fallback : Math.max(lo, Math.min(hi, v));
  return {
    threshold: clamp(override?.threshold, 0.001, 0.5, base.threshold),
    ratio: clamp(override?.ratio, 1, 20, base.ratio),
    attack: clamp(override?.attack, 1, 2000, base.attack),
    release: clamp(override?.release, 1, 5000, base.release),
    makeup: clamp(override?.makeup, 1, 4, base.makeup),
  };
}

/** Is this track ducked at all? An explicit `enabled: false` wins over `duckUnderVoice`. */
export function duckingEnabled(input: MixInput): boolean {
  if (input.kind === "VOICE") return false;
  /**
   * §154: "SFX: niet automatisch ducking toepassen." A sound effect is a short accent that is
   * MEANT to cut through — ducking it would remove the thing it was placed for. It can still be
   * ducked, but only by asking explicitly.
   */
  if (input.kind === "SFX") return input.ducking?.enabled === true;
  if (input.ducking?.enabled === false) return false;
  return Boolean(input.duckUnderVoice || input.ducking?.enabled);
}

/* ═══════════════════════ RONDE 154 — volume automation ═══════════════════════ */

/**
 * A volume curve as a `volume` filter with a time-dependent expression.
 *
 * ── Why an expression and not a chain of fades ──────────────────────────────────────────────
 *
 * A chain of `afade` segments would need one filter per keyframe pair and would still step at the
 * boundaries. `volume=eval=frame` evaluates its expression per sample, so the ramp between two
 * points is genuinely continuous — which is the whole reason §154 asks for interpolation rather
 * than levels: a step in a gain curve is an audible click.
 *
 * The expression is built as nested `if(lt(t,...))` clauses, one per segment, ending in the last
 * keyframe's value. `t` is seconds into the track, which is what the keyframes are measured in.
 *
 * Returns null for fewer than two points — a single keyframe is a level, not a curve, and the
 * clip's own `gain` already expresses that.
 */
export function automationChain(keyframes: readonly AudioKeyframe[] | undefined): string | null {
  const points = (keyframes ?? [])
    .filter((k) => Number.isFinite(k.atSec) && Number.isFinite(k.gain) && k.atSec >= 0)
    .map((k) => ({ atSec: k.atSec, gain: Math.max(0, Math.min(4, k.gain)) }))
    .sort((a, b) => a.atSec - b.atSec);
  if (points.length < 2) return null;

  /**
   * Built from the LAST segment backwards, so each `if` wraps the ones after it. Written forwards
   * it would need the whole tail before it could emit its own clause.
   */
  let expr = points[points.length - 1]!.gain.toFixed(4);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const span = Math.max(0.001, b.atSec - a.atSec);
    // Linear interpolation between the two points, in the filter's own arithmetic.
    const ramp =
      `${a.gain.toFixed(4)}+(${(b.gain - a.gain).toFixed(4)})*` +
      `((t-${a.atSec.toFixed(4)})/${span.toFixed(4)})`;
    expr = `if(lt(t,${a.atSec.toFixed(4)}),${a.gain.toFixed(4)},if(lt(t,${b.atSec.toFixed(4)}),${ramp},${expr}))`;
  }
  return `volume=eval=frame:volume='${expr}'`;
}

/**
 * The complete audio filtergraph: delays, gains, fades, ducking and the mix.
 *
 * ── Why ducking needs the voice twice ────────────────────────────────────────────────────────
 *
 * `sidechaincompress` consumes its sidechain input, so a voice stream used to duck the music
 * cannot also be mixed into the output. `asplit` makes the copies — one per ducked track plus one
 * for the mix — which is the same shape `cinematicAudio`'s own filter uses.
 *
 * ── What happens with no voice ───────────────────────────────────────────────────────────────
 *
 * Ducking is skipped entirely and the gains stand. Ducking against silence would attenuate nothing
 * while still costing a filter, and a music-only video is a legitimate thing to render.
 */
export function buildAudioGraph(inputs: readonly MixInput[]): { filter: string; outLabel: string } | null {
  if (inputs.length === 0) return null;

  const chains: string[] = [];
  const voices = inputs.filter((i) => i.kind === "VOICE");
  const ducked = inputs.filter((i) => duckingEnabled(i));
  const canDuck = voices.length > 0 && ducked.length > 0;

  /** Per-track: delay to its start, set its gain, then its fades. Order matters — a fade is
   *  measured from the track's own start, so it must come after the delay. */
  const prepared = inputs.map((input, n) => {
    const label = `p${n}`;
    /**
     * RONDE 154 — `delaySec` is ADDED to the clip's start, not a replacement for it.
     *
     * `startSec` is where the clip sits on the timeline; `delaySec` is an offset the editor applies
     * on top, for nudging a sound effect a few frames later without moving the clip itself.
     */
    const delayMs = Math.max(0, Math.round((input.startSec + (input.delaySec ?? 0)) * 1000));
    const bits = [`[${input.index}:a]`];
    const filters = [`adelay=${delayMs}|${delayMs}`, `volume=${input.gain.toFixed(3)}`];
    /**
     * The automation curve runs AFTER the static gain, so the two multiply: `gain` is the track's
     * level and the curve is a shape applied to it. Ordering them the other way would make the
     * curve's own values absolute and silently discard whatever gain the editor set.
     */
    const curve = automationChain(input.automation);
    if (curve) filters.push(curve);
    if (input.fadeInSec != null && input.fadeInSec > 0) {
      filters.push(`afade=t=in:st=${input.startSec.toFixed(3)}:d=${input.fadeInSec.toFixed(3)}`);
    }
    if (input.fadeOutSec != null && input.fadeOutSec > 0) {
      const at = Math.max(0, input.startSec + input.durationSec - input.fadeOutSec);
      filters.push(`afade=t=out:st=${at.toFixed(3)}:d=${input.fadeOutSec.toFixed(3)}`);
    }
    chains.push(`${bits.join("")}${filters.join(",")}[${label}]`);
    return { input, label };
  });

  let mixLabels = prepared.map((p) => p.label);

  if (canDuck) {
    const voice = prepared.find((p) => p.input.kind === "VOICE")!;
    // One copy per ducked track, plus the copy that reaches the mix.
    const copies = ducked.length + 1;
    const splitLabels = Array.from({ length: copies }, (_, i) => `vs${i}`);
    chains.push(`[${voice.label}]asplit=${copies}[${splitLabels.join("][")}]`);

    mixLabels = prepared.map((p) => {
      if (p.input.kind === "VOICE") return splitLabels[0]!;
      const at = ducked.indexOf(p.input);
      if (at < 0) return p.label;
      const params = duckingParams(p.input.kind, p.input.ducking);
      const out = `d${at}`;
      chains.push(
        `[${p.label}][${splitLabels[at + 1]}]sidechaincompress=` +
          `threshold=${params.threshold}:ratio=${params.ratio}:attack=${params.attack}:` +
          `release=${params.release}:makeup=${params.makeup}[${out}]`
      );
      return out;
    });
  }

  const mix =
    mixLabels.length === 1
      ? `[${mixLabels[0]}]anull[aout]`
      : `[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=first:` +
        `dropout_transition=2:normalize=0[aout]`;

  return { filter: `${chains.join(";")};${mix}`, outLabel: "aout" };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
