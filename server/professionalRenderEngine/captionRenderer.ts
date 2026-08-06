/** Professional Render Engine — Caption Renderer (Phase 7).
 *
 *  Turns a CaptionInstruction (already decided by Phase 4's CaptionPlanner — this file makes
 *  no caption-content or timing decisions of its own) into real FFmpeg `drawtext`/`drawbox`
 *  filter strings.
 *
 *  textOverlay/renderer.ts already has proven `drawtext=`/`drawbox=` templates in production
 *  (buildHeadlineFilter, buildLabelFilter, buildYearFilter — confirmed by this phase's
 *  research), including the exact escaping rule for drawtext's `text=` value and an alpha-fade
 *  expression shape. None of those helpers are exported, and the file itself is not a pure
 *  module (it owns an `exec`-based ffmpeg runner and a canvas-based PNG-sequence typewriter
 *  renderer) — per this phase's "small pure helper -> import directly, large/coupled ->
 *  reuse the pattern" rule, `esc()` and the alpha-fade expression shape are reimplemented here
 *  verbatim rather than imported, keeping this module a pure string-in/string-out renderer.
 *
 *  Positioning deliberately uses FFmpeg's own `w`/`h`/`text_w`/`text_h` runtime variables
 *  (exactly like the legacy templates) instead of a literal pixel Dimensions parameter — unlike
 *  zoompan's `s=` output-size token, drawtext/drawbox coordinates already resolve against the
 *  actual output frame at render time, so this renderer needs no dimension-adapter step.
 *
 *  `slide` and `scale` are genuinely new here (confirmed missing anywhere in this codebase):
 *  `slide` eases the text up from a fixed offset using the same sine ease-out curve
 *  cameraRenderer.ts uses for its new camera movements (session-wide consistent easing
 *  vocabulary); `scale` eases `fontsize` itself from 0 to its resting size via the same curve.
 *  `typewriter` and `blur` are honestly documented as approximations, not reimplementations:
 *  a true typewriter effect requires compositing a sequence of per-character PNG frames (file
 *  I/O, out of scope for a pure filter-fragment function) — exactly what the legacy renderer's
 *  `renderTypewriterOverlay` does, falling back to a fade when canvas isn't available; this
 *  renderer always takes that same fade fallback. A true text blur-in would need the text
 *  rendered to its own alpha-masked image layer and composited through `gblur`+`overlay` (a
 *  multi-node graph, not a single drawtext fragment) — no such asset pipeline exists here, so
 *  `blur` approximates with the same alpha fade at a slower rate, which reads as a soft
 *  materialize rather than a hard cut.
 */
import type { CaptionAnimation, CaptionInstruction, CaptionPosition, CaptionType, FilterFragment } from "./types";

const MARGIN_X = 48;
const MARGIN_Y = 52;
const ACCENT_COLOR = "0xFFD54F";
const FADE_DUR = 0.45;
const BLUR_FADE_DUR = FADE_DUR * 1.6;
const SLIDE_DISTANCE_PX = 40;

// FFmpeg drawtext escaping: \ : ' must be escaped — same rule textOverlay/renderer.ts uses.
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function fadeAlphaExpr(start: number, end: number, fadeDur = FADE_DUR): string {
  const fadeIn = `if(lt(t,${start.toFixed(3)}),0,if(lt(t,${(start + fadeDur).toFixed(3)}),(t-${start.toFixed(3)})/${fadeDur.toFixed(3)},1))`;
  const fadeOut = `if(gt(t,${(end - fadeDur).toFixed(3)}),(${end.toFixed(3)}-t)/${fadeDur.toFixed(3)},${fadeIn})`;
  return `if(gt(t,${end.toFixed(3)}),0,${fadeOut})`;
}

function hardCutAlphaExpr(start: number, end: number): string {
  return `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
}

/** Sine ease-out progress term, 0 at `start` reaching 1 by `start + FADE_DUR` — same curve
 *  cameraRenderer.ts uses for its new eased camera movements. */
function easeOutProgress(start: number): string {
  return `sin(PI/2*min(max((t-${start.toFixed(3)})/${FADE_DUR.toFixed(3)},0),1))`;
}

type Style = { fontSize: number; color: string; boxed: boolean };

const CAPTION_STYLE: Record<CaptionType, Style> = {
  title: { fontSize: 88, color: "white", boxed: false },
  chapter_title: { fontSize: 88, color: "white", boxed: false },
  subtitle: { fontSize: 44, color: ACCENT_COLOR, boxed: false },
  lower_third: { fontSize: 44, color: "white", boxed: true },
  name: { fontSize: 44, color: "white", boxed: true },
  callout: { fontSize: 44, color: "white", boxed: true },
  date: { fontSize: 56, color: "white", boxed: false },
  location: { fontSize: 56, color: ACCENT_COLOR, boxed: false },
  timeline_label: { fontSize: 40, color: "white", boxed: true },
  statistic: { fontSize: 72, color: ACCENT_COLOR, boxed: false },
  quote: { fontSize: 52, color: "white", boxed: false },
  animated_text: { fontSize: 56, color: "white", boxed: false },
};

function baseXY(position: CaptionPosition): { x: string; y: string } {
  switch (position) {
    case "center":
      return { x: "(w-text_w)/2", y: "(h-text_h)/2" };
    case "top":
      return { x: "(w-text_w)/2", y: "h*0.08" };
    case "bottom":
      return { x: "(w-text_w)/2", y: "h-text_h-h*0.08" };
    case "bottom-left":
      return { x: `${MARGIN_X}`, y: `h-text_h-${MARGIN_Y}` };
    case "bottom-right":
      return { x: `w-text_w-${MARGIN_X}`, y: `h-text_h-${MARGIN_Y}` };
    case "lower-third":
      return { x: `${MARGIN_X}`, y: "h*0.78" };
    default:
      return { x: "(w-text_w)/2", y: "(h-text_h)/2" };
  }
}

function buildDrawText(text: string, x: string, y: string, fontSize: number | string, color: string, alpha: string): string {
  return (
    `drawtext=text='${esc(text)}':fontcolor=${color}:fontsize=${fontSize}:x=${x}:y=${y}:` +
    `alpha='${alpha}':shadowcolor=black:shadowx=2:shadowy=2`
  );
}

/** Box background for boxed caption types — sized the same way buildLabelFilter approximates
 *  text width (FFmpeg can't measure drawtext width ahead of time), and toggled with a hard
 *  `between()` enable rather than a fade, matching the legacy label box's own behavior of never
 *  fading the box itself, only the text drawn over it. */
function buildDrawBox(text: string, x: string, y: string, start: number, end: number): string {
  const approxTextW = Math.max(text.length * 22, 220);
  const boxW = approxTextW + 72;
  const boxH = 88;
  return `drawbox=x=${x}:y=${y}-18:w=${boxW}:h=${boxH}:color=0x00000099:t=fill:enable='${hardCutAlphaExpr(start, end)}'`;
}

function animatedXY(
  animation: CaptionAnimation,
  base: { x: string; y: string },
  startSec: number
): { x: string; y: string; fontSize: string | null } {
  if (animation === "slide") {
    const offset = `${SLIDE_DISTANCE_PX}*(1-${easeOutProgress(startSec)})`;
    return { x: base.x, y: `${base.y}+${offset}`, fontSize: null };
  }
  return { x: base.x, y: base.y, fontSize: null };
}

function alphaForAnimation(animation: CaptionAnimation, startSec: number, endSec: number): string {
  switch (animation) {
    case "none":
      return hardCutAlphaExpr(startSec, endSec);
    case "blur":
      return fadeAlphaExpr(startSec, endSec, BLUR_FADE_DUR);
    case "typewriter":
      // No per-character PNG-sequence path in a pure filter-fragment renderer — same fallback
      // the legacy typewriter overlay itself uses when canvas is unavailable.
      return fadeAlphaExpr(startSec, endSec);
    case "fade":
    case "slide":
    case "scale":
    default:
      return fadeAlphaExpr(startSec, endSec);
  }
}

/** Builds this caption's drawtext (and, for boxed caption types, drawbox) filter fragments. */
export function renderCaption(instruction: CaptionInstruction): FilterFragment[] {
  const { captionType, text, subtitle, startSec, endSec, animation, position, reason } = instruction;
  const style = CAPTION_STYLE[captionType];
  const base = baseXY(position);
  const animatedPos = animatedXY(animation, base, startSec);
  const alpha = alphaForAnimation(animation, startSec, endSec);

  const fontSize: number | string =
    animation === "scale"
      ? `round(${style.fontSize}*${easeOutProgress(startSec)})`
      : style.fontSize;

  const fragments: FilterFragment[] = [];

  if (style.boxed) {
    fragments.push({ filter: buildDrawBox(text, animatedPos.x, animatedPos.y, startSec, endSec), reason });
  }

  fragments.push({ filter: buildDrawText(text, animatedPos.x, animatedPos.y, fontSize, style.color, alpha), reason });

  if (subtitle) {
    const subtitleY = `${animatedPos.y}+${style.fontSize + 12}`;
    fragments.push({
      filter: buildDrawText(subtitle, animatedPos.x, subtitleY, Math.round(style.fontSize * 0.5), ACCENT_COLOR, alpha),
      reason,
    });
  }

  return fragments;
}
