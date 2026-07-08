/**
 * Person label renderer — draws name + title bottom-left, documentary style.
 * Matches Johnny Harris / VOX naming cards.
 */
import type { PersonLabel } from "../types";

const LABEL_ACCENT   = "0xFFD54F";
const FONT_NAME      = 48;
const FONT_TITLE     = 30;
const PAD_W          = 28;
const PAD_H          = 18;
const MARGIN_X       = 52;
const MARGIN_B       = 60;
const LINE_GAP       = 8;
const BOX_H          = FONT_NAME + FONT_TITLE + PAD_H * 2 + LINE_GAP;
const FADE           = 0.35;

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function alphaExpr(start: number, end: number): string {
  return (
    `if(lt(t,${start.toFixed(3)}),0,` +
    `if(lt(t,${(start+FADE).toFixed(3)}),(t-${start.toFixed(3)})/${FADE},` +
    `if(gt(t,${(end-FADE).toFixed(3)}),(${end.toFixed(3)}-t)/${FADE},1)))`
  );
}

function enableExpr(start: number, end: number): string {
  return `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
}

export function buildPersonLabelFilters(p: PersonLabel): string[] {
  const { name, title, startSec, durationSec } = p;
  const end   = startSec + durationSec;
  const alpha = alphaExpr(startSec, end);
  const enable = enableExpr(startSec, end);

  const nameW  = Math.max(name.length * 30, title.length * 18, 240) + PAD_W * 2;
  const boxY   = `h-${MARGIN_B + BOX_H}`;

  return [
    // Background box
    `drawbox=x=${MARGIN_X}:y=${boxY}:w=${nameW}:h=${BOX_H}:color=0x00000099:t=fill:enable='${enable}'`,
    // Accent bar (left edge)
    `drawbox=x=${MARGIN_X}:y=${boxY}:w=5:h=${BOX_H}:color=${LABEL_ACCENT}:t=fill:enable='${enable}'`,
    // Name
    `drawtext=text='${esc(name)}':fontcolor=white:fontsize=${FONT_NAME}:` +
      `x=${MARGIN_X + PAD_W + 8}:y=h-${MARGIN_B + BOX_H - PAD_H}:alpha='${alpha}'`,
    // Title
    `drawtext=text='${esc(title)}':fontcolor=${LABEL_ACCENT}:fontsize=${FONT_TITLE}:` +
      `x=${MARGIN_X + PAD_W + 8}:y=h-${MARGIN_B + FONT_TITLE + PAD_H - LINE_GAP}:alpha='${alpha}'`,
  ];
}
