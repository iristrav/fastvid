/**
 * Stat highlight renderer — single large number/stat centered on screen.
 * Used when the stat is the main point of the scene (not a counter animation).
 */
import type { StatHighlight } from "../types";

const FONT_MAIN  = 110;
const FONT_CTX   = 38;
const ACCENT     = "0xFFD54F";
const FADE       = 0.4;

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function alphaExpr(start: number, end: number): string {
  return (
    `if(lt(t,${start.toFixed(3)}),0,` +
    `if(lt(t,${(start + FADE).toFixed(3)}),(t-${start.toFixed(3)})/${FADE},` +
    `if(gt(t,${(end - FADE).toFixed(3)}),(${end.toFixed(3)}-t)/${FADE},1)))`
  );
}

export function buildStatHighlightFilters(stat: StatHighlight): string[] {
  const { value, context, startSec, durationSec } = stat;
  const end   = startSec + durationSec;
  const alpha = alphaExpr(startSec, end);
  const yOff  = context ? 40 : 0;

  return [
    // Main value
    `drawtext=text='${esc(value)}':fontcolor=${ACCENT}:fontsize=${FONT_MAIN}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${yOff}:alpha='${alpha}':shadowcolor=black:shadowx=4:shadowy=4`,
    // Optional context line
    ...(context ? [
      `drawtext=text='${esc(context)}':fontcolor=white:fontsize=${FONT_CTX}:` +
        `x=(w-text_w)/2:y=(h+text_h)/2+16:alpha='${alpha}':shadowcolor=black:shadowx=2:shadowy=2`,
    ] : []),
  ];
}
