/**
 * Comparison renderer — side-by-side A vs B with drawtext.
 * Clean centered layout, gold connector, fade in/out.
 */
import type { Comparison } from "../types";

const FONT_MAIN    = 72;
const FONT_VS      = 52;
const ACCENT       = "0xFFD54F";
const FADE         = 0.4;

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

export function buildComparisonFilters(comp: Comparison): string[] {
  const { leftLabel, rightLabel, connector = "VS", startSec, durationSec } = comp;
  const end    = startSec + durationSec;
  const alpha  = alphaExpr(startSec, end);
  const enable = `between(t,${startSec.toFixed(3)},${end.toFixed(3)})`;

  // Semi-transparent background panel
  const panelW = 1600;
  const panelH = 160;
  const panelX = (1920 - panelW) / 2;
  const panelY = (1080 - panelH) / 2;

  return [
    // Background
    `drawbox=x=${panelX}:y=${panelY}:w=${panelW}:h=${panelH}:color=0x00000088:t=fill:enable='${enable}'`,
    // Left label
    `drawtext=text='${esc(leftLabel.toUpperCase())}':fontcolor=white:fontsize=${FONT_MAIN}:` +
      `x=(w/2-text_w)/2+60:y=(h-text_h)/2:alpha='${alpha}':shadowcolor=black:shadowx=2:shadowy=2`,
    // Connector (VS / →)
    `drawtext=text='${esc(connector)}':fontcolor=${ACCENT}:fontsize=${FONT_VS}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:alpha='${alpha}':shadowcolor=black:shadowx=2:shadowy=2`,
    // Right label
    `drawtext=text='${esc(rightLabel.toUpperCase())}':fontcolor=white:fontsize=${FONT_MAIN}:` +
      `x=w/2+(w/2-text_w)/2-60:y=(h-text_h)/2:alpha='${alpha}':shadowcolor=black:shadowx=2:shadowy=2`,
  ];
}
