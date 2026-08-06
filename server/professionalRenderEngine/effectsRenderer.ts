/** Professional Render Engine — Effects Renderer (Phase 7).
 *
 *  Turns an EffectInstruction (already decided by Phase 4's EffectsPlanner — this file makes
 *  no effect-choice decisions of its own) into real FFmpeg filter strings.
 *
 *  `film_grain` and `vignette` reuse documentaryStyle.ts's `buildFilmGrainVF()`/
 *  `buildDocumentaryVignetteVF()` directly — small, pure, already-proven-in-production
 *  functions (confirmed by this phase's research), called rather than reimplemented. Film
 *  grain stays governed by that module's own `ENABLE_FILM_GRAIN` env toggle even from here —
 *  this renderer doesn't duplicate that control, it defers to it, exactly like every other
 *  reused-function call in this directory.
 *
 *  Research confirmed zero implementation anywhere in this codebase for 5 of the 10
 *  VisualEffectTypes (glow, bloom, chromatic_aberration, lens_flare, and true VFX-letterbox).
 *  Where FFmpeg's own filter set has a real, purpose-built primitive, this uses it directly —
 *  `chromatic_aberration` uses `rgbashift` (FFmpeg's native RGB-channel-offset filter, exactly
 *  what chromatic aberration is), and `letterbox` uses `drawbox` bars (a real, simple technique
 *  distinct from aspectRatio.ts's pad-to-fit, which changes frame geometry — this VFX letterbox
 *  draws bars over an unchanged frame for a cinematic-crop look). Where no native primitive
 *  exists, this documents the approximation plainly rather than oversell it:
 *    - `glow`/`bloom` approximate with `gblur` alone (a soft-focus blur) — a true bloom needs
 *      isolating bright pixels, blurring only those, and screen-blending them back onto the
 *      sharp original (a multi-node split/blend graph), which doesn't fit this directory's
 *      linear single-stream FilterFragment contract; this is a softer, cheaper stand-in.
 *    - `lens_flare` approximates with a flat warm brightness/color pulse (`eq`+`colorbalance`)
 *      — not a positional flare sprite, since no flare texture asset exists anywhere in this
 *      codebase (same constraint as transitionRenderer.ts's film_burn/light_leak).
 *    - `particles`/`dust` reuse the exact noise primitive the legacy particle/dust overlay is
 *      built on (`noise=alls=X:allf=t+u`) applied directly to the stream, rather than as a
 *      separately composited alpha-blended overlay layer (the legacy version's `overlay=`
 *      compositing needs a second input stream, which doesn't fit this renderer's contract of
 *      one EffectInstruction -> one stream's filter fragments).
 */
import { buildDocumentaryVignetteVF, buildFilmGrainVF } from "../documentaryStyle";
import type { EffectInstruction, FilterFragment, VisualEffectType } from "./types";

function clampIntensity(intensity: number): number {
  return Math.max(0, Math.min(1, intensity));
}

/** buildFilmGrainVF() is written to be appended onto an existing chain string (leading comma,
 *  e.g. ",noise=..."), not used as a standalone fragment — this strips that leading comma so
 *  it fits this directory's "pure filter syntax, no surrounding punctuation" FilterFragment
 *  contract. Empty when film grain is disabled via ENABLE_FILM_GRAIN. */
function filmGrain(): string {
  return buildFilmGrainVF().replace(/^,/, "");
}

function renderGlowOrBloom(intensity: number, strong: boolean): string {
  const i = clampIntensity(intensity);
  const sigma = (strong ? 4 + 8 * i : 2 + 4 * i).toFixed(2);
  return `gblur=sigma=${sigma}`;
}

function renderChromaticAberration(intensity: number): string {
  const i = clampIntensity(intensity);
  const shift = Math.round(2 + 6 * i);
  return `rgbashift=rh=${shift}:bh=-${shift}`;
}

function renderLensFlare(intensity: number): string {
  const i = clampIntensity(intensity);
  const brightness = (0.02 + 0.06 * i).toFixed(3);
  return `eq=brightness=${brightness}:saturation=${(1 + 0.1 * i).toFixed(3)},colorbalance=rs=${(0.05 + 0.05 * i).toFixed(3)}:gs=${(0.02 + 0.02 * i).toFixed(3)}`;
}

function renderNoiseOrParticles(intensity: number, heavy: boolean): string {
  const i = clampIntensity(intensity);
  const alls = Math.round(heavy ? 10 + 20 * i : 3 + 12 * i);
  return `noise=alls=${alls}:allf=t+u`;
}

function renderLetterbox(intensity: number): string {
  const i = clampIntensity(intensity);
  const barFraction = (0.06 + 0.06 * i).toFixed(4);
  return (
    `drawbox=x=0:y=0:w=iw:h=ih*${barFraction}:color=black:t=fill,` +
    `drawbox=x=0:y=ih*(1-${barFraction}):w=iw:h=ih*${barFraction}:color=black:t=fill`
  );
}

/** Builds this effect's filter fragment(s). Returns an empty array only when a reused,
 *  independently-toggled legacy primitive (film grain) is currently disabled — every other
 *  effect always emits a fragment scaled by its instruction's intensity. */
export function renderEffect(instruction: EffectInstruction): FilterFragment[] {
  const { effectType, intensity, reason } = instruction;
  const filter = buildEffectFilter(effectType, intensity);
  if (!filter) return [];
  return [{ filter, reason }];
}

function buildEffectFilter(effectType: VisualEffectType, intensity: number): string {
  switch (effectType) {
    case "film_grain":
      return filmGrain();
    case "vignette":
      return buildDocumentaryVignetteVF();
    case "glow":
      return renderGlowOrBloom(intensity, false);
    case "bloom":
      return renderGlowOrBloom(intensity, true);
    case "chromatic_aberration":
      return renderChromaticAberration(intensity);
    case "lens_flare":
      return renderLensFlare(intensity);
    case "noise":
      return renderNoiseOrParticles(intensity, false);
    case "particles":
    case "dust":
      return renderNoiseOrParticles(intensity, true);
    case "letterbox":
      return renderLetterbox(intensity);
    default:
      return "";
  }
}
