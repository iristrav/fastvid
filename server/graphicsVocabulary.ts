/**
 * RONDE 160 §7 — what a graphic is, and whether it can be drawn. One answer, no React.
 *
 * ── The audit finding this module exists for ─────────────────────────────────────────────────
 *
 * "Can this graphic be drawn?" was being answered in THREE different places, by three lists that
 * had drifted apart until they had nothing in common:
 *
 *   `MotionGraphicType`      the 9 names the cinematic planner emits — progress_bar,
 *   (the planner)            statistic_counter, map, timeline, chart, comparison,
 *                            animated_icon, highlight_box, arrow
 *
 *   `GRAPHICS_WITH_A_LABEL`  9 names, hand-written in edlToTimeline.ts back when the only way to
 *   (the adapter)            draw a graphic was libass. Its own comment still said "those the ASS
 *                            pass can draw today" — it was never updated when RONDE 150/155 added
 *                            the Remotion graphics layer.
 *
 *   `RENDERABLE_GRAPHICS`    the 32 names that actually have a component.
 *   (the renderer)
 *
 * The first two sets have ZERO names in common, and the first and third also have zero. So every
 * motion graphic the cinematic engine planned was reported "kept on the GRAPHICS track, not drawn
 * by this renderer" — unconditionally, all of them, every render. The entire motion-graphics
 * feature was inert on the live route, and nothing failed, because the adapter reported the loss
 * honestly and nobody read the report.
 *
 * The second set was wrong in the other direction too: it says `statistic` is drawable but not
 * `title`, `counter`, `bar_chart`, `map_point` or any of the other 25 types that draw perfectly.
 * A hand-edited timeline with a bar chart was reported as undrawable while rendering fine.
 *
 * ── Why this file is plain .ts and not part of Graphics.tsx ──────────────────────────────────
 *
 * The predicate is pure — sets, string reads, number reads. It lived in a .tsx that imports React
 * and `remotion` at module scope, so the planning path could not consult it without pulling a
 * renderer into the API and worker processes. Moving the pure half here lets `edlToTimeline.ts`
 * ask the SAME question the component answers, which is the only way the two can never disagree
 * again. `Charts.tsx` and `Graphics.tsx` re-export everything below, so every existing import site
 * is unchanged.
 */

/* ═══════════════════════ reading a payload ═══════════════════════ */

export type ChartDatum = { label: string; value: number };

/**
 * The bars/slices/points a chart payload really contains.
 *
 * Returns an empty array for anything malformed, and the caller then reports the graphic as
 * unsupported rather than drawing an empty axis. A non-finite value is dropped rather than
 * coerced: an "NaN" bar would render as a zero-height rectangle and read as a real measurement of
 * nothing.
 */
export function readSeries(data: Record<string, unknown>): ChartDatum[] {
  const raw = data.series ?? data.values ?? data.data;
  if (!Array.isArray(raw)) return [];
  const out: ChartDatum[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const value = typeof row.value === "number" ? row.value : Number.NaN;
    if (!Number.isFinite(value)) continue;
    const label = typeof row.label === "string" ? row.label : "";
    out.push({ label, value });
  }
  return out;
}

/** A number the payload really carries, or null. Never a default that looks like data. */
export function readNumber(data: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function readText(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The number a ring fills to, whatever the planner called it.
 *
 * ── RONDE 160 §7 — the bug this closes ───────────────────────────────────────────────────────
 *
 * A real render of every graphic type found `progress` rendering a COMPLETELY EMPTY frame while
 * `graphicIsRenderable` said yes and the renderer counted it in `graphicsDrawn`. The cause was a
 * disagreement nobody could see from a unit test: `progress` was VALIDATED as a text card (needs a
 * label) and DRAWN as a percentage ring (needs a number), so a `progress` with a label and no
 * percent passed every check and put nothing on the screen — fake success, exactly.
 *
 * `toValue` is in this list because it is the codebase's OWN name for that number: the motion
 * graphics planner writes `{ toValue, suffix: "%", label }` for its percentage progress bar. It is
 * not a new field invented here to make a test pass.
 */
export function readRingPercent(data: Record<string, unknown>): number | null {
  return readNumber(data, "percent", "value", "toValue");
}

/** Normalised points for a route or a multi-point map. */
export function readRoute(data: Record<string, unknown>): Array<{ x: number; y: number; label: string }> {
  const raw = data.points ?? data.route;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ x: number; y: number; label: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const x = typeof row.normX === "number" ? row.normX : Number.NaN;
    const y = typeof row.normY === "number" ? row.normY : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      label: typeof row.label === "string" ? row.label : "",
    });
  }
  return out;
}

/* ═══════════════════════ the shapes this build can draw ═══════════════════════ */

/** SVG path data, in a -50..50 box. Pure data — the component that strokes it lives in Charts.tsx. */
export const SHAPE_PATHS: Readonly<Record<string, string>> = {
  circle: "M0,-40 A40,40 0 1 1 0,40 A40,40 0 1 1 0,-40 Z",
  line: "M-50,0 L50,0",
  arrow: "M-45,0 L30,0 M12,-18 L30,0 L12,18",
  rectangle: "M-50,-32 L50,-32 L50,32 L-50,32 Z",
  pin: "M0,0 C-14,-20 -22,-30 -22,-42 A22,22 0 1 1 22,-42 C22,-30 14,-20 0,0 Z",
  marker: "M0,-40 L12,-12 L40,-8 L20,10 L26,38 L0,24 L-26,38 L-20,10 L-40,-8 L-12,-12 Z",
  check: "M-32,2 L-10,24 L32,-22",
  x: "M-26,-26 L26,26 M26,-26 L-26,26",
  play: "M-18,-28 L30,0 L-18,28 Z",
  camera: "M-44,-20 L-24,-20 L-16,-30 L16,-30 L24,-20 L44,-20 L44,26 L-44,26 Z",
  location: "M0,0 C-14,-20 -22,-30 -22,-42 A22,22 0 1 1 22,-42 C22,-30 14,-20 0,0 Z",
};

/* ═══════════════════════ the vocabulary ═══════════════════════ */

/**
 * Graphics this build draws. Everything else keeps its payload and is REPORTED.
 *
 * Adding a name here means writing a component, not adding a string — and §7's render test proves
 * that by rendering every member and reading its pixels back.
 */
export const RENDERABLE_GRAPHICS: ReadonlySet<string> = new Set([
  "location_card",
  "date_card",
  "chapter_card",
  "chapter_title",
  "lower_third",
  "headline",
  "title",
  "subtitle",
  "quote",
  "statistic",
  "callout",
  "emphasis",
  "name",
  "label",
  "badge",
  "counter",
  "text",
  "stat",
  "progress",
  "warning",
  "timeline_event",
  "bar_chart",
  "horizontal_bar",
  "line_chart",
  "pie_chart",
  "donut_chart",
  "percentage_ring",
  "map_point",
  "route",
  "multi_point",
  "shape",
  "icon",
]);

/**
 * Graphic types whose renderability depends on their PAYLOAD, not just their name.
 *
 * A bar chart is drawable if and only if it has values; a map point if and only if it has a
 * coordinate. Text-shaped graphics answer the same question by having words.
 */
export const DATA_DRIVEN_GRAPHICS: ReadonlySet<string> = new Set([
  "bar_chart", "horizontal_bar", "line_chart", "pie_chart", "donut_chart",
  /**
   * RONDE 160 §7 — `progress` belongs here because the component DRAWS it as a ring.
   *
   * It used to be validated as a text card, so a `progress` with a label and no number passed the
   * gate, was counted as drawn, and rendered an empty frame. A real render caught it; a unit test
   * never could, because everything except the pixels reported success.
   */
  "progress",
  "percentage_ring", "map_point", "route", "multi_point",
]);

/** Graphic types drawn as a shape rather than as words. */
export const SHAPE_GRAPHICS: ReadonlySet<string> = new Set(["shape", "icon"]);

/**
 * Does this graphic have the data its type needs?
 *
 * One function, so the renderer's "can I draw this" answer and the component's "should I draw
 * this" answer cannot drift apart. The renderer calls it to report; the component calls it to
 * decide.
 */
export function chartPayloadIsRenderable(graphicType: string, data: Record<string, unknown>): boolean {
  switch (graphicType) {
    case "bar_chart":
    case "horizontal_bar":
    case "line_chart":
    case "pie_chart":
    case "donut_chart":
      return readSeries(data).length > 0;
    case "percentage_ring":
    case "progress":
      return readRingPercent(data) != null;
    case "map_point":
      return readNumber(data, "normX") != null && readNumber(data, "normY") != null;
    case "route":
      return readRoute(data).length >= 2;
    case "multi_point":
      return readRoute(data).length >= 1;
    default:
      return false;
  }
}

/**
 * Can this specific graphic be drawn, payload and all?
 *
 * The single answer. The component asks it to decide whether to render, the Remotion renderer asks
 * it to decide what to report as skipped, and `edlToTimeline` asks it to decide what to report as
 * unsupported — so a graphic can never be drawn without being reportable, reported as drawn without
 * appearing, or reported as undrawable while rendering fine.
 */
export function graphicIsRenderable(
  graphicType: string,
  data: Record<string, unknown>,
  label: string | null
): boolean {
  if (!RENDERABLE_GRAPHICS.has(graphicType)) return false;
  if (DATA_DRIVEN_GRAPHICS.has(graphicType)) return chartPayloadIsRenderable(graphicType, data);
  if (SHAPE_GRAPHICS.has(graphicType)) {
    const name = readText(data, "shape", "icon", "name") ?? label ?? "";
    return name in SHAPE_PATHS;
  }
  return Boolean(label?.trim() || readText(data, "label", "text", "title"));
}
