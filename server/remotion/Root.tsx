/**
 * RONDE 150 §4 — the Remotion entry point.
 *
 * ONE composition, whose dimensions and length come from the props rather than from a constant.
 * `calculateMetadata` is how Remotion asks the props what shape the video is, which is what lets a
 * 9:16 short and a 16:9 documentary go through the same composition without a second registration.
 *
 * The defaults exist only so the composition can be selected before real props arrive; every real
 * render overrides all of them.
 */
import React from "react";
import { Composition } from "remotion";
import { FastVidComposition, type FastVidProps } from "./FastVidComposition";

const EMPTY: FastVidProps = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 30,
  durationSec: 1,
  look: null,
  clips: [],
  captions: [],
  texts: [],
  graphics: [],
  audio: [],
  words: [],
  meta: { videoId: 0, timelineVersion: 0, schemaVersion: 1 },
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="FastVid"
    component={FastVidComposition}
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
