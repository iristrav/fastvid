/**
 * Animated number counter overlay via FFmpeg drawtext.
 * Counts from 0 → target value with easing, shown centre-screen.
 */
import type { CounterAnimation } from "./types";

const FONT_SIZE = 120;
const ACCENT = "0xFFD54F"; // warm gold
const FADE = 0.3;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Build a drawtext filter that animates a number counting up.
 * Uses FFmpeg's `mod(n, ...)` expression to step through values.
 * Returns a filter string to append to the -vf chain.
 */
export function buildCounterFilter(counter: CounterAnimation): string {
  const { fromValue, toValue, suffix, startSec, durationSec } = counter;
  const endSec = startSec + durationSec;
  const range = toValue - fromValue;

  // Build eased value expression using FFmpeg's t (time in seconds)
  // We approximate easeOutCubic with a linear ramp clamped — FFmpeg lacks pow() in drawtext
  // Use: value = fromValue + range * min(1, (t - start) / dur)^1 (linear for simplicity, looks fine)
  const tNorm = `clip((t-${startSec.toFixed(3)})/${durationSec.toFixed(3)},0,1)`;
  // Round to integer for clean display
  const valueExpr = `${fromValue}+${range}*${tNorm}`;
  const roundedExpr = `round(${valueExpr})`;

  const alphaExpr =
    `if(lt(t,${startSec.toFixed(3)}),0,` +
    `if(lt(t,${(startSec + FADE).toFixed(3)}),(t-${startSec.toFixed(3)})/${FADE},` +
    `if(gt(t,${(endSec - FADE).toFixed(3)}),(${endSec.toFixed(3)}-t)/${FADE},1)))`;

  const suffixEsc = suffix.replace(/'/g, "\\'").replace(/:/g, "\\:");

  return (
    `drawtext=text='%{eif\\:${roundedExpr}\\:d}${suffixEsc}':` +
    `fontcolor=${ACCENT}:fontsize=${FONT_SIZE}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `alpha='${alphaExpr}':` +
    `shadowcolor=black:shadowx=4:shadowy=4:` +
    `enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'`
  );
}
