/**
 * RONDE 150 §5 — the Remotion entry point.
 *
 * ONE composition, and it renders a transparent GRAPHICS OVERLAY, not a video. Its dimensions and
 * length come from the props rather than from a constant, which is what lets a 9:16 short and a
 * 16:9 documentary go through the same registration.
 *
 * The id is `FastVidGraphics` rather than `FastVid` on purpose: this bundle cannot produce a
 * finished video, and a name suggesting otherwise would invite exactly the "render it with
 * Remotion instead" mistake §5 rules out.
 *
 * The defaults exist only so the composition can be selected before real props arrive; every real
 * render overrides all of them.
 */
import React from "react";
import { Composition } from "remotion";
import { GraphicsOverlay, type GraphicsOverlayProps } from "./GraphicsOverlay";

const EMPTY: GraphicsOverlayProps = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 30,
  durationSec: 1,
  captions: [],
  texts: [],
  graphics: [],
  words: [],
  meta: { videoId: 0, timelineVersion: 0, schemaVersion: 1 },
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="FastVidGraphics"
    component={GraphicsOverlay}
    durationInFrames={EMPTY.durationInFrames}
    fps={EMPTY.fps}
    width={EMPTY.width}
    height={EMPTY.height}
    defaultProps={EMPTY}
    calculateMetadata={({ props }) => ({
      // The timeline is the source of truth for the video's shape, not this file.
      durationInFrames: Math.max(1, props.durationInFrames),
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
