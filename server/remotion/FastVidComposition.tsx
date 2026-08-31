/**
 * RONDE 150 §4 — the composition. It assembles; it does not decide.
 *
 * §29, in the one place it matters most: every value below comes from the props, and the props came
 * from the timeline, and the timeline came from the planners. There is no branch here that reads a
 * scene index, no threshold, no "if this looks like a title". The component knows how a location
 * card LOOKS; it does not know when one should appear.
 *
 * ── The layer order is the picture's order ───────────────────────────────────────────────────
 *
 *   clips → transition overlays → graphics → text → captions → audio
 *
 * Captions sit above graphics deliberately: a caption is the narration and must never be covered
 * by a decorative card. Audio has no z-order but is mounted last so a reader finds it where they
 * expect it.
 */
import React from "react";
import { AbsoluteFill, Audio, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { VideoClip } from "./components/VideoClip";
import { TextElement } from "./components/Text";
import { Graphic } from "./components/Graphics";
import { transitionStyleAt } from "./components/Transitions";

/**
 * The props shape, structurally identical to `RemotionRenderProps` in server/remotionProps.ts.
 *
 * Declared independently rather than imported: this file is compiled into a BROWSER bundle by
 * Remotion's webpack, and importing from a module that pulls in `documentaryStyle` would drag the
 * server's fs/path dependencies into it. A test asserts the two shapes stay compatible.
 */
export type FastVidProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  durationSec: number;
  look: { grade: string; strength?: number } | null;
  clips: Array<Record<string, unknown>>;
  captions: Array<Record<string, unknown>>;
  texts: Array<Record<string, unknown>>;
  graphics: Array<Record<string, unknown>>;
  audio: Array<Record<string, unknown>>;
  words: Array<{ word: string; startSec: number; endSec: number }>;
  meta: { videoId: number; timelineVersion: number; schemaVersion: number };
};

/** The words spoken inside one caption's window — its own slice of the measured alignment. */
function wordsWithin(
  words: FastVidProps["words"],
  fromFrame: number,
  durationInFrames: number,
  fps: number
): FastVidProps["words"] {
  const start = fromFrame / fps;
  const end = (fromFrame + durationInFrames) / fps;
  return words.filter((w) => w.endSec > start && w.startSec < end);
}

/**
 * A clip's transition overlay — the dip colour, when it is dipping.
 *
 * Separate from the clip itself so an unsupported transition can render NOTHING here while the
 * clip still renders normally. That is what "reported, not silently downgraded" looks like in
 * practice: the picture is a cut, and the render report says the film burn was not executed.
 */
const TransitionOverlay: React.FC<{
  kind: string;
  fromFrame: number;
  transitionInFrames: number;
}> = ({ kind, fromFrame, transitionInFrames }) => {
  const frame = useCurrentFrame();
  if (kind === "hard_cut" || transitionInFrames <= 0) return null;
  const style = transitionStyleAt(kind, frame - fromFrame, transitionInFrames);
  if (!style?.overlay) return null;
  if (frame < fromFrame || frame > fromFrame + transitionInFrames) return null;
  return <AbsoluteFill style={{ backgroundColor: style.overlay, pointerEvents: "none" }} />;
};

export const FastVidComposition: React.FC<FastVidProps> = (props) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {props.clips.map((raw, i) => {
        const c = raw as unknown as React.ComponentProps<typeof VideoClip> & {
          transitionIn: string;
          transitionInFrames: number;
        };
        return (
          <React.Fragment key={c.id ?? i}>
            <VideoClip {...c} look={props.look} />
            <TransitionOverlay
              kind={c.transitionIn}
              fromFrame={c.fromFrame}
              transitionInFrames={c.transitionInFrames}
            />
          </React.Fragment>
        );
      })}

      {props.graphics.map((raw, i) => (
        <Graphic key={(raw.id as string) ?? `g${i}`} g={raw as never} />
      ))}

      {props.texts.map((raw, i) => {
        const t = raw as never as {
          id: string; text: string; fromFrame: number; durationInFrames: number;
          style: never; animation: string;
        };
        return (
          <TextElement
            key={t.id ?? `t${i}`}
            text={t.text}
            fromFrame={t.fromFrame}
            durationInFrames={t.durationInFrames}
            style={t.style}
            animation={t.animation}
            fps={fps}
          />
        );
      })}

      {props.captions.map((raw, i) => {
        const c = raw as never as {
          id: string; text: string; fromFrame: number; durationInFrames: number;
          style: never; animation: string;
        };
        return (
          <TextElement
            key={c.id ?? `c${i}`}
            text={c.text}
            fromFrame={c.fromFrame}
            durationInFrames={c.durationInFrames}
            style={c.style}
            animation={c.animation}
            fps={fps}
            /** §13 — the caption gets the MEASURED word boundaries for its own window. */
            words={wordsWithin(props.words, c.fromFrame, c.durationInFrames, fps)}
          />
        );
      })}

      {props.audio.map((raw, i) => {
        const a = raw as unknown as {
          id: string; src: string | null; fromFrame: number; durationInFrames: number; gain: number;
        };
        if (!a.src) return null;
        return (
          <Sequence key={a.id ?? `a${i}`} from={a.fromFrame} durationInFrames={a.durationInFrames}>
            {/*
              Gain is applied here; DUCKING is not. Sidechain compression needs the voice as a
              control signal, which a browser audio graph cannot do — so the mix stays in ffmpeg,
              where `cinematicAudio`'s tuned sidechain already lives. See remotionRenderer.
            */}
            <Audio src={a.src} volume={Math.max(0, Math.min(4, a.gain))} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
