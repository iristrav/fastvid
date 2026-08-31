/**
 * RONDE 150 §13/§14 — text, captions and word-level animation.
 *
 * ── §13: the timing is the TTS's, never recomputed ───────────────────────────────────────────
 *
 * `words` are the measured boundaries from the alignment that already ran. A word highlights at
 * exactly `word.startSec` because that is when it is spoken — not at an even share of the line's
 * length, which is what a renderer that recomputed timing would produce and what makes captions
 * feel a beat off without anyone being able to say why.
 *
 * ── §14: style is DATA ───────────────────────────────────────────────────────────────────────
 *
 * Position, size and colour come from the timeline's `TextStyle`. There are no hardcoded positions
 * in this file; `positionStyle` maps the vocabulary the rest of FastVid already uses.
 */
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";

export type TextStyleLike = {
  fontSizePx: number;
  color: string;
  backgroundColor?: string;
  backgroundOpacity: number;
  position: string;
  maxCharsPerLine?: number;
};

export type WordTiming = { word: string; startSec: number; endSec: number };

/** The vocabulary from projectTimeline's TextStyle, mapped to layout. Nothing invented. */
export function positionStyle(position: string): React.CSSProperties {
  switch (position) {
    case "top":
      return { justifyContent: "flex-start", alignItems: "center", paddingTop: "6%" };
    case "center":
      return { justifyContent: "center", alignItems: "center" };
    case "lower_third":
      return { justifyContent: "flex-end", alignItems: "flex-start", padding: "0 8% 22% 8%" };
    default:
      return { justifyContent: "flex-end", alignItems: "center", paddingBottom: "6%" };
  }
}

function boxStyle(style: TextStyleLike): React.CSSProperties {
  return {
    fontSize: style.fontSizePx,
    color: style.color,
    fontFamily: "DejaVu Sans, Liberation Sans, sans-serif",
    fontWeight: 700,
    lineHeight: 1.25,
    textAlign: "center",
    maxWidth: "84%",
    padding: style.backgroundOpacity > 0 ? "0.35em 0.6em" : 0,
    borderRadius: 6,
    backgroundColor:
      style.backgroundOpacity > 0
        ? `rgba(0,0,0,${Math.max(0, Math.min(1, style.backgroundOpacity)).toFixed(3)})`
        : "transparent",
    // Without a shadow, white text on bright archival footage is unreadable — the same reason the
    // ASS route gives an un-boxed style an outline.
    textShadow: style.backgroundOpacity > 0 ? undefined : "0 2px 6px rgba(0,0,0,0.85)",
  };
}

/** The animations the timeline's `TextAnimation` names. Unknown ones simply do not animate. */
function animationOpacity(animation: string, frame: number, durationInFrames: number): number {
  if (animation === "none") return 1;
  const fadeFrames = Math.min(8, Math.max(1, Math.floor(durationInFrames / 6)));
  return interpolate(
    frame,
    [0, fadeFrames, Math.max(fadeFrames, durationInFrames - fadeFrames), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

export const TextElement: React.FC<{
  text: string;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyleLike;
  animation: string;
  /** Present only for captions with measured word timing. */
  words?: WordTiming[];
  fps: number;
}> = ({ text, fromFrame, durationInFrames, style, animation, words, fps }) => (
  <Sequence from={fromFrame} durationInFrames={durationInFrames} name={text.slice(0, 24)}>
    <TextBody
      text={text}
      durationInFrames={durationInFrames}
      style={style}
      animation={animation}
      words={words}
      fps={fps}
      fromFrame={fromFrame}
    />
  </Sequence>
);

const TextBody: React.FC<{
  text: string;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyleLike;
  animation: string;
  words?: WordTiming[];
  fps: number;
}> = ({ text, fromFrame, durationInFrames, style, animation, words, fps }) => {
  const frame = useCurrentFrame();
  const opacity = animationOpacity(animation, frame, durationInFrames);
  const scale =
    animation === "fade_scale"
      ? interpolate(frame, [0, 10], [0.94, 1], { extrapolateRight: "clamp" })
      : 1;
  const rise =
    animation === "fade_rise"
      ? interpolate(frame, [0, 12], [14, 0], { extrapolateRight: "clamp" })
      : 0;

  /**
   * §13 — word highlighting, on the TTS's own clock.
   *
   * `absoluteSec` is where we are in the VIDEO, so a word's own start/end can be compared directly
   * without any per-line arithmetic. That is the whole point: the boundaries were measured once,
   * upstream, and are used here unchanged.
   */
  const absoluteSec = (fromFrame + frame) / fps;
  const spoken = words?.filter((w) => w.endSec > 0) ?? [];

  return (
    <AbsoluteFill style={{ ...positionStyle(style.position), display: "flex" }}>
      <div style={{ ...boxStyle(style), opacity, transform: `translateY(${rise}px) scale(${scale})` }}>
        {spoken.length > 0
          ? spoken.map((w, i) => {
              const active = absoluteSec >= w.startSec && absoluteSec < w.endSec;
              return (
                <span
                  key={`${w.word}-${i}`}
                  style={{
                    // The highlight is a colour change, not a size change: reflowing the line as
                    // each word lands makes the whole caption jitter.
                    color: active ? "#ffd54a" : style.color,
                    marginRight: "0.28em",
                  }}
                >
                  {w.word}
                </span>
              );
            })
          : text}
      </div>
    </AbsoluteFill>
  );
};
