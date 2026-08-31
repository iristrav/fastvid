/**
 * RONDE 150 §6 — one clip on screen, with its framing, camera, grade and effects.
 *
 * ── OffthreadVideo, not Video ────────────────────────────────────────────────────────────────
 *
 * Remotion offers both. `<Video>` uses the browser's own decoder, which seeks approximately and can
 * hand back a neighbouring frame — fine for a preview, wrong for a render that must be identical
 * every time. `<OffthreadVideo>` extracts the exact frame with ffmpeg outside the browser, which is
 * both frame-accurate and what makes §23's determinism achievable at all.
 *
 * ── The order of the wrappers is the order of the picture ────────────────────────────────────
 *
 *   fit (object-fit / crop)  → what part of the source is visible
 *   camera (scale/origin)    → where it moves
 *   grade (CSS filter)       → its colour
 *   effects (filter + layers)→ its treatment
 *
 * Identical to the ffmpeg chain's order, and for the same reasons: a grade applied before a zoom
 * would drift as the frame moves, and grain applied before a grade gets its saturation pulled.
 */
import React from "react";
import { AbsoluteFill, OffthreadVideo, Img, Sequence } from "remotion";
import { Camera } from "./Camera";
import { Vignette, gradeFilterFor } from "./Grade";
import { EffectLayers, effectFilterFor, type EffectSpec } from "./Effects";

export type ClipProps = {
  id: string;
  kind: "video" | "image";
  src: string | null;
  fromFrame: number;
  durationInFrames: number;
  sourceIn: number | null;
  fit: "contain" | "cover" | "crop";
  crop: { x: number; y: number; width: number; height: number } | null;
  scale: number;
  positionX: number;
  positionY: number;
  opacity: number;
  camera: React.ComponentProps<typeof Camera>["camera"];
  effects: EffectSpec[];
  sourceKind: string;
  look: { grade: string; strength?: number } | null;
};

export const VideoClip: React.FC<ClipProps> = (clip) => {
  /**
   * A clip with no media renders BLACK rather than nothing.
   *
   * Rendering nothing would collapse the sequence and shorten the video — the silent
   * timing change §22's drift check exists to catch. Black holds the slot, and the missing asset
   * has already been reported by the validator and the rehydrator.
   */
  if (!clip.src) {
    return (
      <Sequence from={clip.fromFrame} durationInFrames={clip.durationInFrames} name={`${clip.id} (no media)`}>
        <AbsoluteFill style={{ backgroundColor: "black" }} />
      </Sequence>
    );
  }

  const objectFit = clip.fit === "cover" || clip.fit === "crop" ? "cover" : "contain";
  const gradeFilter = gradeFilterFor(clip.look, clip.sourceKind);
  const fxFilter = effectFilterFor(clip.effects);
  const filter = [gradeFilter, fxFilter].filter(Boolean).join(" ") || undefined;

  /**
   * An explicit crop rectangle is expressed as a scale-and-offset on the media element: showing
   * the middle 50% means drawing it at 2× and shifting it. Normalised, so it survives the source
   * being re-fetched at another resolution — the same reason the timeline stores it that way.
   */
  const cropStyle: React.CSSProperties = clip.crop
    ? {
        width: `${(100 / Math.max(0.01, clip.crop.width)).toFixed(4)}%`,
        height: `${(100 / Math.max(0.01, clip.crop.height)).toFixed(4)}%`,
        left: `${(-clip.crop.x * (100 / Math.max(0.01, clip.crop.width))).toFixed(4)}%`,
        top: `${(-clip.crop.y * (100 / Math.max(0.01, clip.crop.height))).toFixed(4)}%`,
        position: "absolute",
      }
    : { width: "100%", height: "100%" };

  const media =
    clip.kind === "image" ? (
      <Img src={clip.src} style={{ ...cropStyle, objectFit }} />
    ) : (
      <OffthreadVideo
        src={clip.src}
        // The trim inside the source. Null means "nobody wrote it down" — §15 — so the renderer
        // starts at 0 and that decision is taken HERE, visibly, rather than defaulted upstream.
        startFrom={clip.sourceIn != null ? undefined : undefined}
        style={{ ...cropStyle, objectFit }}
        muted
      />
    );

  return (
    <Sequence from={clip.fromFrame} durationInFrames={clip.durationInFrames} name={clip.id}>
      <AbsoluteFill style={{ opacity: clip.opacity, backgroundColor: "black" }}>
        <Camera camera={clip.camera} durationInFrames={clip.durationInFrames}>
          <AbsoluteFill
            style={{
              filter,
              transform: clip.scale !== 1 ? `scale(${clip.scale})` : undefined,
              transformOrigin: `${(clip.positionX * 100).toFixed(2)}% ${(clip.positionY * 100).toFixed(2)}%`,
              overflow: "hidden",
            }}
          >
            {media}
          </AbsoluteFill>
        </Camera>
        <Vignette look={clip.look} sourceKind={clip.sourceKind} />
        <EffectLayers effects={clip.effects} />
      </AbsoluteFill>
    </Sequence>
  );
};
