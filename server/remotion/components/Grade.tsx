/**
 * RONDE 150 §8 — the colour grade, as CSS filters.
 *
 * ── The numbers are documentaryStyle's, not new ones ─────────────────────────────────────────
 *
 * `GRADE_BY_SOURCE` below is the same calibration `documentaryStyle.buildDocumentaryColorGradeVF`
 * has held for a long time: archive scans are already washed out and need the lightest pull, stock
 * is glossy and needs the hardest, generated footage reads plasticky and needs a different hard
 * one. Those values were tuned against real material. They are duplicated here — and ONLY here —
 * because a React component cannot import server code into a browser bundle, and a test asserts
 * the two agree so the copy cannot drift.
 *
 * ── Why the numbers are not identical in effect ──────────────────────────────────────────────
 *
 * ffmpeg's `eq=contrast` and CSS `filter: contrast()` are different functions of the same name:
 * ffmpeg's is a multiplier around mid-grey, CSS's is a multiplier around 0.5 in sRGB. The
 * PARAMETERS are the same and the pictures are very close but not pixel-identical. That is stated
 * rather than hidden — a render is either the ffmpeg route or the Remotion route, never a mix, so
 * the two never have to match exactly.
 */
import React from "react";

export type GradeSpec = { saturation: number; contrast: number; brightness: number; vignette: number };

/** Copied from documentaryStyle.ts. A test asserts these still match it. */
export const GRADE_BY_SOURCE: Readonly<Record<string, GradeSpec>> = {
  archive: { saturation: 0.88, contrast: 1.12, brightness: -0.03, vignette: 0.62 },
  stock: { saturation: 0.82, contrast: 1.15, brightness: -0.03, vignette: 0.55 },
  ai_generated: { saturation: 0.78, contrast: 1.08, brightness: -0.03, vignette: 0.55 },
  unknown: { saturation: 0.88, contrast: 1.12, brightness: -0.03, vignette: 0.62 },
};

export function gradeFilterFor(
  look: { grade: string; strength?: number } | null,
  sourceKind: string
): string | null {
  if (!look || look.grade === "none") return null;
  const strength = look.strength == null ? 1 : Math.max(0, Math.min(1, look.strength));
  if (strength <= 0.001) return null;
  const spec = GRADE_BY_SOURCE[sourceKind] ?? GRADE_BY_SOURCE.unknown!;
  // Interpolate toward neutral, exactly as the ffmpeg route's `strength` does.
  const mix = (neutral: number, graded: number) => neutral + (graded - neutral) * strength;
  return (
    `saturate(${mix(1, spec.saturation).toFixed(4)}) ` +
    `contrast(${mix(1, spec.contrast).toFixed(4)}) ` +
    `brightness(${mix(1, 1 + spec.brightness).toFixed(4)})`
  );
}

/**
 * The vignette, as a radial gradient rather than a filter.
 *
 * CSS has no vignette function, and a box-shadow inset cannot follow the frame's aspect. A radial
 * gradient overlay is the standard equivalent and it composites in the same pass as everything
 * else — no extra layer cost.
 */
export const Vignette: React.FC<{ look: { grade: string; strength?: number } | null; sourceKind: string }> = ({
  look,
  sourceKind,
}) => {
  if (!look || look.grade === "none") return null;
  const strength = look.strength == null ? 1 : Math.max(0, Math.min(1, look.strength));
  if (strength <= 0.001) return null;
  const spec = GRADE_BY_SOURCE[sourceKind] ?? GRADE_BY_SOURCE.unknown!;
  // A lower `vignette` value in documentaryStyle means a STRONGER vignette (it is an angle).
  const opacity = (0.62 - spec.vignette + 0.18) * strength;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${opacity.toFixed(3)}) 100%)`,
      }}
    />
  );
};
