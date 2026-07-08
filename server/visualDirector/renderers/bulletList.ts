/**
 * Bullet list renderer — items appear sequentially bottom-left via drawtext.
 * Each bullet fades in at its own time, accumulates on screen.
 */
import type { BulletList } from "../types";

const FONT     = 36;
const ACCENT   = "0xFFD54F";
const MARGIN_X = 80;
const MARGIN_B = 240;
const LINE_H   = 56;
const FADE     = 0.3;
const BULLET   = "•";

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

export function buildBulletListFilters(bl: BulletList): string[] {
  const filters: string[] = [];
  const items    = bl.items.slice(0, 5);
  const itemDur  = bl.durationSec / items.length;
  const totalEnd = bl.startSec + bl.durationSec;

  // Background box — appears with first bullet, fades with last
  const boxH = items.length * LINE_H + 32;
  const boxW = Math.max(...items.map(i => i.length)) * 22 + MARGIN_X;
  filters.push(
    `drawbox=x=${MARGIN_X - 20}:y=h-${MARGIN_B + boxH}:w=${boxW}:h=${boxH}:` +
    `color=0x00000088:t=fill:enable='between(t,${bl.startSec.toFixed(3)},${totalEnd.toFixed(3)})'`
  );

  for (let i = 0; i < items.length; i++) {
    const itemStart = bl.startSec + i * itemDur;
    const itemEnd   = totalEnd;
    const alpha     = alphaExpr(itemStart, itemEnd);
    const y         = `h-${MARGIN_B + boxH - 16 - i * LINE_H}`;

    // Bullet dot
    filters.push(
      `drawtext=text='${BULLET}':fontcolor=${ACCENT}:fontsize=${FONT + 4}:` +
      `x=${MARGIN_X}:y=${y}:alpha='${alpha}'`
    );
    // Item text
    filters.push(
      `drawtext=text='${esc(items[i].slice(0, 55))}':fontcolor=white:fontsize=${FONT}:` +
      `x=${MARGIN_X + 36}:y=${y}:alpha='${alpha}'`
    );
  }

  return filters;
}
