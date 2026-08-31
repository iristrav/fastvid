/**
 * RONDE 152 — the animation vocabulary, as ARITHMETIC.
 *
 * ── Why this is not inside the components ────────────────────────────────────────────────────
 *
 * §152 asks for animations that are deterministic and not browser-only. Both follow from the same
 * decision: an animation here is a pure function from (frame, duration) to a transform, with no
 * `Math.random`, no `Date`, and no DOM. So the same frame always produces the same pixels, and the
 * behaviour can be tested without launching Chrome — which matters, because a headless browser is
 * the one dependency this environment cannot always provide.
 *
 * The components below `import` these and apply the result. They contain no timing of their own.
 */

/** What an animation does to an element at one instant. */
export type AnimationState = {
  opacity: number;
  /** Multiplier. 1 is the element's own size. */
  scale: number;
  /** Pixels. Positive x is right, positive y is down. */
  translateX: number;
  translateY: number;
  /**
   * How much of the element is revealed, 0..1, measured from the left.
   * Only `mask_reveal` uses it; everything else is fully revealed.
   */
  revealFraction: number;
};

export const NEUTRAL: AnimationState = {
  opacity: 1,
  scale: 1,
  translateX: 0,
  translateY: 0,
  revealFraction: 1,
};

/** Linear interpolation with clamped ends. Remotion's own `interpolate`, without the import. */
function lerp(frame: number, from: number, to: number, a: number, b: number): number {
  if (to <= from) return b;
  const t = Math.max(0, Math.min(1, (frame - from) / (to - from)));
  return a + (b - a) * t;
}

/** Ease-out cubic. Used where a move should arrive rather than stop dead. */
export function easeOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

/**
 * A spring-ish overshoot for `pop` and `bounce`, computed in closed form.
 *
 * A real spring simulation would be stateful and frame-rate dependent; this is a damped sine, so
 * frame N is a pure function of N and a render at 24fps and one at 30fps agree about what the
 * element looks like at the same INSTANT.
 */
export const OVERSHOOT_START = 0.25;

export function overshoot(t: number, amplitude = 0.18, frequency = 3): number {
  const c = Math.max(0, Math.min(1, t));
  if (c >= 1) return 1;
  /**
   * The `OVERSHOOT_START` term is not cosmetic.
   *
   * Without it the curve is exactly 0 at t=0, and `transform: scale(0)` is a degenerate transform:
   * the element has no size on its first frame, which some compositors treat as "nothing to draw"
   * and others as a divide-by-zero in the layer's matrix. Starting a quarter of the way up reads as
   * the same pop and is always a real rectangle.
   */
  return (
    1 -
    Math.exp(-6 * c) * Math.cos(frequency * Math.PI * c) * amplitude -
    (1 - c) * (1 - amplitude - OVERSHOOT_START)
  );
}

/**
 * How many frames an entrance or exit takes.
 *
 * A sixth of the element's life, capped at 10 frames, floored at 1. The cap keeps a long-lived
 * title from spending two seconds fading in; the floor keeps a very short caption from having a
 * zero-length entrance, which would make it appear at full opacity with a visible snap.
 */
export function transitionFrames(durationInFrames: number): number {
  return Math.min(10, Math.max(1, Math.floor(durationInFrames / 6)));
}

/**
 * The animation state for one element at one frame.
 *
 * `frame` is relative to the element's own start, which is what a Remotion `<Sequence>` provides.
 * An unknown animation name returns NEUTRAL — it does not animate, and the caller reports it as
 * unsupported. Guessing a similar animation would make the video do something nobody asked for.
 */
export function animationAt(
  animation: string,
  frame: number,
  durationInFrames: number
): AnimationState {
  const fade = transitionFrames(durationInFrames);
  const outStart = Math.max(fade, durationInFrames - fade);

  /** Every animation fades out the same way; only the entrance differs. */
  const exitOpacity = lerp(frame, outStart, durationInFrames, 1, 0);
  const enter = Math.max(0, Math.min(1, frame / Math.max(1, fade)));

  switch (animation) {
    case "none":
      return NEUTRAL;

    case "fade":
      return { ...NEUTRAL, opacity: Math.min(lerp(frame, 0, fade, 0, 1), exitOpacity) };

    case "fade_rise":
      return {
        ...NEUTRAL,
        opacity: Math.min(lerp(frame, 0, fade, 0, 1), exitOpacity),
        translateY: lerp(frame, 0, fade + 2, 14, 0),
      };

    case "fade_scale":
      return {
        ...NEUTRAL,
        opacity: Math.min(lerp(frame, 0, fade, 0, 1), exitOpacity),
        scale: lerp(frame, 0, fade + 2, 0.94, 1),
      };

    case "scale":
      return { ...NEUTRAL, opacity: exitOpacity, scale: lerp(frame, 0, fade, 0.8, 1) };

    case "pop":
      return {
        ...NEUTRAL,
        opacity: Math.min(lerp(frame, 0, Math.max(1, fade / 2), 0, 1), exitOpacity),
        scale: overshoot(enter),
      };

    case "bounce":
      return {
        ...NEUTRAL,
        opacity: exitOpacity,
        translateY: (1 - overshoot(enter, 0.3, 2)) * 40,
      };

    case "slide_up":
      return { ...NEUTRAL, opacity: exitOpacity, translateY: (1 - easeOut(enter)) * 60 };
    case "slide_down":
      return { ...NEUTRAL, opacity: exitOpacity, translateY: (easeOut(enter) - 1) * 60 };
    case "slide_left":
      return { ...NEUTRAL, opacity: exitOpacity, translateX: (1 - easeOut(enter)) * 80 };
    case "slide_right":
      return { ...NEUTRAL, opacity: exitOpacity, translateX: (easeOut(enter) - 1) * 80 };

    case "mask_reveal":
      return { ...NEUTRAL, opacity: exitOpacity, revealFraction: easeOut(enter) };

    /**
     * `type_on`, `word_reveal` and `character_reveal` are handled by the COMPONENT, because they
     * reveal parts of the text rather than transform the whole box. They animate nothing here, and
     * saying so explicitly stops a future reader from thinking they were forgotten.
     */
    case "type_on":
    case "word_reveal":
    case "character_reveal":
      return { ...NEUTRAL, opacity: exitOpacity };

    default:
      return NEUTRAL;
  }
}

/** Every animation this build can execute. Anything else is reported, never approximated. */
export const SUPPORTED_ANIMATIONS: ReadonlySet<string> = new Set([
  "none", "fade", "fade_rise", "fade_scale", "pop", "scale",
  "slide_up", "slide_down", "slide_left", "slide_right",
  "bounce", "type_on", "word_reveal", "character_reveal", "mask_reveal",
]);

/** Animations that reveal the text progressively rather than moving the whole box. */
export const PROGRESSIVE_ANIMATIONS: ReadonlySet<string> = new Set([
  "type_on", "word_reveal", "character_reveal",
]);

/**
 * How much of the text is visible, for a progressive animation.
 *
 * Returns 1 for every other animation, so a caller can apply it unconditionally.
 *
 * The reveal finishes at 80% of the element's life rather than at its end: a caption whose last
 * word appears on its final frame is a caption nobody reads.
 */
export function revealProgress(
  animation: string,
  frame: number,
  durationInFrames: number
): number {
  if (!PROGRESSIVE_ANIMATIONS.has(animation)) return 1;
  const end = Math.max(1, Math.floor(durationInFrames * 0.8));
  return Math.max(0, Math.min(1, frame / end));
}

/* ═══════════════════════ caption modes ═══════════════════════ */

export type CaptionWord = { word: string; startSec: number; endSec: number };

/**
 * One chunk of a caption: the words shown together, and when.
 *
 * The MODES differ only in how the caption's words are grouped, so they all produce this. The
 * component then draws chunks; it does not know what mode produced them.
 */
export type CaptionChunk = {
  words: CaptionWord[];
  startSec: number;
  endSec: number;
};

/**
 * Break a caption into the chunks its mode asks for.
 *
 * ── §12/§152: the TTS's timing is never recomputed ──────────────────────────────────────────
 *
 * Every boundary below comes from a measured `startSec`/`endSec`. Where the words run out — a
 * caption on a video with no alignment — the function returns ONE chunk spanning the whole caption
 * and the caller reports the mode as unsupported. It does not invent an even split, because an
 * evenly-split karaoke line is a line that highlights the wrong word for most of its life.
 */
export function chunkCaption(params: {
  mode: string | undefined;
  words: readonly CaptionWord[];
  startSec: number;
  endSec: number;
  /** Words per chunk for `phrase`. */
  phraseSize?: number;
}): { chunks: CaptionChunk[]; degraded: boolean } {
  const words = params.words.filter((w) => w.endSec > w.startSec);
  const whole: CaptionChunk = {
    words: [...words],
    startSec: params.startSec,
    endSec: params.endSec,
  };

  const mode = params.mode ?? "sentence";
  if (mode === "sentence") return { chunks: [whole], degraded: false };

  /** Every other mode needs real word boundaries. Without them, say so. */
  if (words.length === 0) return { chunks: [whole], degraded: true };

  switch (mode) {
    /**
     * The whole line is on screen throughout; the COMPONENT colours the current word. So one
     * chunk, exactly like `sentence` — the difference is in the drawing, not in the grouping.
     */
    case "karaoke":
    case "highlight_word":
    case "emphasis_word":
      return { chunks: [whole], degraded: false };

    case "word_by_word":
      return {
        chunks: words.map((w) => ({ words: [w], startSec: w.startSec, endSec: w.endSec })),
        degraded: false,
      };

    case "phrase": {
      const size = Math.max(2, params.phraseSize ?? 3);
      const chunks: CaptionChunk[] = [];
      for (let i = 0; i < words.length; i += size) {
        const group = words.slice(i, i + size);
        chunks.push({
          words: group,
          startSec: group[0]!.startSec,
          endSec: group[group.length - 1]!.endSec,
        });
      }
      return { chunks, degraded: false };
    }

    default:
      /** An unknown mode shows the caption whole and is reported. */
      return { chunks: [whole], degraded: true };
  }
}

export const SUPPORTED_CAPTION_MODES: ReadonlySet<string> = new Set([
  "sentence", "phrase", "word_by_word", "karaoke", "highlight_word", "emphasis_word",
]);
