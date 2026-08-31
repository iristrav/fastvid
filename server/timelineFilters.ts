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
  ClipCamera,
  ClipEffect,
  ClipTransform,
  TimelineFormat,
  TimelineVideoClip,
} from "./projectTimeline";

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
 * Each is a filter that exists in both ffmpeg builds. An effect not in this table is not silently
 * dropped — `unsupportedEffects` names it, the clip keeps carrying it, and the render reports it.
 */
export function effectChain(effect: ClipEffect): string | null {
  const i = Math.max(0, Math.min(1, effect.intensity));
  switch (effect.effectType) {
    case "film_grain":
      // noise strength is 0..100; a documentary grain lives at the very bottom of that range.
      return `noise=alls=${Math.round(4 + 16 * i)}:allf=t+u`;
    case "vignette":
      // The angle is the falloff: PI/5 is a heavy vignette, PI/2.6 barely visible.
      return `vignette=angle=${(Math.PI / 2.6 - (Math.PI / 2.6 - Math.PI / 5) * i).toFixed(4)}`;
    case "letterbox":
      // A 2.39:1 crop-and-pad, the cinematic bar. Independent of intensity: it is on or it is not.
      return `crop=iw:ih*0.836:0:ih*0.082,pad=iw:ih/0.836:0:(oh-ih)/2:color=black`;
    default:
      return null;
  }
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
  durationSec: number
): string {
  const t = clip.transform;
  const parts: string[] = [];

  if (t?.fit === "crop" && t.crop) parts.push(cropChain(fmt, t.crop));
  else if (t?.fit === "cover") parts.push(coverChain(fmt, { x: t.positionX, y: t.positionY }));
  else parts.push(containChain(fmt));

  const camera = clip.camera ? cameraChain(clip.camera, fmt, durationSec) : null;
  if (camera) parts.push(camera);

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
};

export function transitionIsRenderable(kind: string): boolean {
  return kind === "hard_cut" || kind in XFADE_TRANSITIONS;
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
};

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
  const ducked = inputs.filter((i) => i.duckUnderVoice && i.kind !== "VOICE" && i.kind !== "SFX");
  const canDuck = voices.length > 0 && ducked.length > 0;

  /** Per-track: delay to its start, set its gain, then its fades. Order matters — a fade is
   *  measured from the track's own start, so it must come after the delay. */
  const prepared = inputs.map((input, n) => {
    const label = `p${n}`;
    const delayMs = Math.max(0, Math.round(input.startSec * 1000));
    const bits = [`[${input.index}:a]`];
    const filters = [`adelay=${delayMs}|${delayMs}`, `volume=${input.gain.toFixed(3)}`];
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
      const params = p.input.kind === "AMBIENT" ? DUCK_AMBIENT : DUCK_MUSIC;
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
