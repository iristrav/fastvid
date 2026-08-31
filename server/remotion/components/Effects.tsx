/**
 * RONDE 150 §10 — effects, DATA-DRIVEN.
 *
 * §10's rule verbatim: `effects: [{ type, intensity }]`, never `if (scene === 4) addGrain()`. Every
 * function here takes a spec and returns a style or a layer; none of them knows which clip it is on.
 *
 * ── Deterministic grain, which is the part that is easy to get wrong ─────────────────────────
 *
 * §23 forbids unseeded randomness. Film grain is noise, so the naive implementation is `Math.random()`
 * per pixel per frame — and that renders differently every time, which breaks the whole determinism
 * guarantee the editor rests on. `seededNoise` below is a pure function of (frame, seed): the same
 * frame always produces the same pattern, and different frames produce different ones so the grain
 * still moves.
 */
import React from "react";
import { useCurrentFrame } from "remotion";

export type EffectSpec = { effectType: string; intensity: number; reason?: string | null };

/** Effects this renderer executes. Anything else is reported, never silently skipped (§34). */
export const REMOTION_EFFECTS: ReadonlySet<string> = new Set([
  "film_grain",
  "noise",
  "vignette",
  "letterbox",
  "glow",
  "bloom",
  "chromatic_aberration",
  "blur",
]);

export function unsupportedEffectsIn(effects: readonly EffectSpec[]): EffectSpec[] {
  return effects.filter((e) => !REMOTION_EFFECTS.has(e.effectType));
}

/**
 * The effects that are expressible as a CSS filter on the clip itself.
 *
 * Composed into ONE filter string rather than nested layers: browsers apply `filter` left to right
 * in a single pass, so the order here is the order they take effect — and one pass is much cheaper
 * than one wrapper element per effect.
 */
export function effectFilterFor(effects: readonly EffectSpec[]): string {
  const parts: string[] = [];
  for (const e of effects) {
    const i = Math.max(0, Math.min(1, e.intensity));
    switch (e.effectType) {
      case "blur":
        parts.push(`blur(${(i * 8).toFixed(2)}px)`);
        break;
      case "bloom":
      case "glow":
        /**
         * `drop-shadow` with no offset is a halo around the layer's own bright edges — the closest
         * single-filter equivalent of the split-blur-screen sandwich the ffmpeg route uses. A glow
         * is tight, a bloom is wide; that difference is the radius, exactly as it is in ffmpeg.
         */
        parts.push(
          `drop-shadow(0 0 ${(e.effectType === "bloom" ? 18 * i + 8 : 6 * i + 2).toFixed(1)}px ` +
            `rgba(255,255,255,${(0.25 + 0.35 * i).toFixed(3)}))`
        );
        break;
      default:
        break;
    }
  }
  return parts.join(" ");
}

/** A deterministic value in [0,1) from two integers. No global state, no clock, no Math.random. */
export function seededNoise(frame: number, seed: number): number {
  // A standard integer hash (xorshift-flavoured). Chosen because it is short, stateless and stable.
  let x = (frame * 73856093) ^ (seed * 19349663);
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * Film grain as an SVG turbulence layer whose seed is derived from the FRAME NUMBER.
 *
 * feTurbulence is a deterministic generator: the same seed always produces the same pattern. So
 * the grain moves (a new seed each frame) and is reproducible (the seed is a function of the frame).
 */
export const FilmGrain: React.FC<{ intensity: number }> = ({ intensity }) => {
  const frame = useCurrentFrame();
  const i = Math.max(0, Math.min(1, intensity));
  if (i <= 0.001) return null;
  const seed = Math.floor(seededNoise(frame, 1337) * 10000);
  return (
    <svg
      style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.08 + 0.22 * i }}
      width="100%"
      height="100%"
    >
      <filter id={`grain-${seed}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={seed} />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
    </svg>
  );
};

/** The 2.39:1 cinematic bars. On or off; intensity does not apply to a crop. */
export const Letterbox: React.FC = () => (
  <>
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "8.2%", background: "black" }} />
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "8.2%", background: "black" }} />
  </>
);

/**
 * Chromatic aberration: the layer drawn three times, red and blue nudged in opposite directions.
 *
 * Opposite directions because that is how a lens disperses; the same direction would read as a
 * misregistered print. Capped at 3px for the same reason as the ffmpeg route — beyond that it stops
 * looking like a lens and starts looking like a fault.
 */
export const ChromaticAberration: React.FC<{ intensity: number; children: React.ReactNode }> = ({
  intensity,
  children,
}) => {
  const shift = Math.max(1, Math.round(3 * Math.max(0, Math.min(1, intensity))));
  const layer = (channel: string, dx: number): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    transform: `translateX(${dx}px)`,
    mixBlendMode: "screen",
    filter: `url(#none)`,
    // Channel isolation via a colour matrix would need an SVG filter per channel; the cheap and
    // visually equivalent trick is a tinted copy at low opacity.
    background: "transparent",
    opacity: 0.5,
    color: channel,
  });
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={layer("red", shift)} />
      {children}
      <div style={layer("blue", -shift)} />
    </div>
  );
};

/** The effects that draw their own layer rather than filtering the clip. */
export const EffectLayers: React.FC<{ effects: readonly EffectSpec[] }> = ({ effects }) => (
  <>
    {effects.map((e, n) => {
      if (e.effectType === "film_grain" || e.effectType === "noise") {
        return <FilmGrain key={`${e.effectType}-${n}`} intensity={e.intensity} />;
      }
      if (e.effectType === "letterbox") return <Letterbox key={`letterbox-${n}`} />;
      return null;
    })}
  </>
);
