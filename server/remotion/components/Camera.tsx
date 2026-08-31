/**
 * RONDE 150 §7 — the camera move, interpolated per frame.
 *
 * This replaces zoompan for the Remotion route. The difference that matters is not quality but
 * WHERE the interpolation happens: zoompan evaluates an expression string inside ffmpeg, this
 * evaluates the same linear ramp in React with the frame number as its only input.
 *
 * DETERMINISTIC BY CONSTRUCTION. The scale at frame N is a pure function of N, the clip's own
 * length and the planner's endpoints — no clock, no randomness, no accumulated state. Render the
 * same clip twice and every frame is identical, which is what §23 requires.
 *
 * ── The upscale, kept from the ffmpeg route ──────────────────────────────────────────────────
 *
 * A zoom into a picture already at output size magnifies softness. `transform: scale()` on a
 * browser layer resamples from whatever the source resolution is, so a video element larger than
 * the frame gives the zoom real pixels to crop into — the same reason the ffmpeg chain scales to
 * 2× before zoompan.
 */
import React from "react";
import { useCurrentFrame, interpolate } from "remotion";

export type CameraProps = {
  camera: {
    type: string;
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null;
  durationInFrames: number;
  children: React.ReactNode;
};

export const Camera: React.FC<CameraProps> = ({ camera, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  if (!camera) return <>{children}</>;

  const span = Math.max(1, durationInFrames - 1);
  const ramp = (from: number, to: number) =>
    interpolate(frame, [0, span], [from, to], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  const scale = ramp(camera.startScale, camera.endScale);
  const x = ramp(camera.startX, camera.endX);
  const y = ramp(camera.startY, camera.endY);

  /**
   * The centre of interest becomes a transform origin: 0.5/0.5 is the middle, which is what a
   * plain zoom does. Moving it is what turns the same zoom into a pan.
   */
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        transform: `scale(${scale})`,
        transformOrigin: `${(x * 100).toFixed(4)}% ${(y * 100).toFixed(4)}%`,
        // Without this the scaled layer paints outside its box and over the next one.
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
};
