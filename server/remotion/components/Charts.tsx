/**
 * RONDE 155B / §14 — charts, maps and shapes, drawn from the planner's payload.
 *
 * ── The rule every component here obeys ─────────────────────────────────────────────────────
 *
 * DRAW ONLY WHAT THE PAYLOAD CONTAINS.
 *
 * A bar chart with no values is not a chart with zero bars and it is certainly not the word
 * "chart" on screen — it is an unsupported graphic, and the caller reports it. Every component
 * below returns `null` when its payload does not validate, and `validateChartPayload` is what
 * decides. That keeps §"GEEN FEATURE-FAKE" true structurally rather than by discipline.
 *
 * ── §14: maps without map data ──────────────────────────────────────────────────────────────
 *
 * "Geen echte geografische kaart renderen als er geen kaartdata beschikbaar is." FastVid has no
 * tile server, no GeoJSON and no offline basemap, and a render must not reach the network. What it
 * does have, when the planner supplies it, is a coordinate.
 *
 * So `MapPoint` draws an ABSTRACT map: a graticule, a marker at the coordinate's normalised
 * position, and the place name. It does not draw coastlines, because it does not know where they
 * are. That is a real, useful, honest graphic — a viewer reads "somewhere at this latitude and
 * longitude" — and it is not a picture pretending to be a map of anywhere in particular.
 *
 * ── Everything is SVG, and everything is deterministic ──────────────────────────────────────
 *
 * No canvas, no external tiles, no icon API, no fetch at render time. A frame is a pure function
 * of the payload and the frame number.
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { easeOut } from "./animation";
import {
  SHAPE_PATHS,
  readDecimals,
  readNumber,
  readRingPercent,
  readRoute,
  readSeries,
  readText,
} from "../../graphicsVocabulary";

/** OCTOBER 2026 — Inter is bundled (remotion/fonts.ts); the system faces stay behind it. */
const CHART_FONT = "Inter, DejaVu Sans, Liberation Sans, sans-serif";
const ACCENT = "#ffd54a";
const INK = "#ffffff";
const MUTED = "rgba(255,255,255,0.55)";

/* ═══════════════════════ payload validation ═══════════════════════ */

/**
 * RONDE 160 §7 — the payload readers and the renderability predicate now live in
 * `server/graphicsVocabulary.ts`, a plain module with no React in it, so the PLANNING path can ask
 * the same question this file answers. Re-exported here so every existing import site is unchanged.
 */
export {
  readSeries,
  readNumber,
  readText,
  readRingPercent,
  readRoute,
  chartPayloadIsRenderable,
  SHAPE_PATHS,
  type ChartDatum,
} from "../../graphicsVocabulary";

/* ═══════════════════════ how far an animation has run ═══════════════════════ */

/**
 * 0..1 across the graphic's life, eased, finishing at 70%.
 *
 * Finishing early matters: a bar that is still growing when the graphic leaves never showed its
 * value, which is the one thing a chart exists to do.
 */
function growth(frame: number, durationInFrames: number): number {
  const end = Math.max(1, Math.floor(durationInFrames * 0.7));
  return easeOut(Math.max(0, Math.min(1, frame / end)));
}

/* ═══════════════════════ charts ═══════════════════════ */

const W = 900;
const H = 520;

/**
 * OCTOBER 2026 — "nice" tick values for an axis: 3–6 round steps (1, 2, 2.5 or 5 × 10ⁿ) covering
 * [min, max]. A chart's axis is how a viewer reads the size of a change; 0, 2.5, 5, 7.5 reads,
 * 0, 2.37, 4.74 does not.
 */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => (max - min) / s <= target + 1) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toFixed(10)));
  return ticks;
}

/** A value as the chart prints it: the payload's decimals, thousands separators, its unit. */
export function formatValue(v: number, decimals: number, prefix = "", suffix = ""): string {
  const n = v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix}${n}${suffix}`;
}

const chartUnits = (data: Record<string, unknown>) => ({
  prefix: readText(data, "prefix") ?? "",
  suffix: (() => {
    const s = readText(data, "suffix", "unit");
    if (!s) return "";
    return s === "%" ? "%" : ` ${s}`;
  })(),
});

export const BarChart: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
  horizontal?: boolean;
}> = ({ data, durationInFrames, horizontal }) => {
  const frame = useCurrentFrame();
  const series = readSeries(data);
  if (series.length === 0) return null;

  const t = growth(frame, durationInFrames);
  const title = readText(data, "title", "label");
  const { prefix, suffix } = chartUnits(data);
  const decimals = Math.max(...series.map((d) => readDecimals(data, d.value)));
  /** OCTOBER 2026 — an axis with round steps; the bars are scaled to its top, not to the largest bar. */
  const ticks = niceTicks(0, Math.max(...series.map((d) => Math.abs(d.value)), 1e-6));
  const max = ticks[ticks.length - 1]!;
  const pad = 70;
  const top = title ? 84 : pad;
  const plotW = W - pad * 2;
  const plotH = H - pad - top;
  const slot = (horizontal ? plotH : plotW) / series.length;
  const thickness = slot * 0.6;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      <rect width={W} height={H} fill="rgba(9,14,22,0.72)" rx={10} />
      {title && (
        <text x={pad} y={50} fill={INK} fontFamily={CHART_FONT} fontSize={30} fontWeight={800}>
          {title}
        </text>
      )}
      {/* The value axis: faint gridlines at round values, each labelled. */}
      {!horizontal &&
        ticks.map((v) => {
          const y = H - pad - (v / max) * plotH;
          return (
            <g key={`t${v}`}>
              <line x1={pad} x2={W - pad} y1={y} y2={y} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
              <text x={pad - 10} y={y + 7} fill={MUTED} fontFamily={CHART_FONT} fontSize={18} textAnchor="end">
                {formatValue(v, decimals, prefix, suffix.trim() === "%" ? "%" : "")}
              </text>
            </g>
          );
        })}
      {/* The baseline. A chart without one leaves the eye nothing to measure against. */}
      <line
        x1={pad}
        y1={horizontal ? top : H - pad}
        x2={horizontal ? pad : W - pad}
        y2={H - pad}
        stroke={MUTED}
        strokeWidth={2}
      />
      {series.map((d, i) => {
        /** OCTOBER 2026 — bars grow one after another, a little apart, each over the same time. */
        const stagger = series.length > 1 ? (i / (series.length - 1)) * 0.25 : 0;
        const ti = easeOut(Math.max(0, Math.min(1, (t - stagger) / 0.75)));
        const extent = (Math.abs(d.value) / max) * (horizontal ? plotW : plotH) * ti;
        const offset = (horizontal ? top : pad) + slot * i + (slot - thickness) / 2;
        return (
          <g key={`${d.label}-${i}`}>
            <rect
              x={horizontal ? pad : offset}
              y={horizontal ? offset : H - pad - extent}
              width={horizontal ? extent : thickness}
              height={horizontal ? thickness : extent}
              fill={ACCENT}
              rx={3}
            />
            <text
              x={horizontal ? pad - 12 : offset + thickness / 2}
              y={horizontal ? offset + thickness / 2 + 8 : H - pad + 30}
              fill={INK}
              fontFamily={CHART_FONT}
              fontSize={22}
              textAnchor={horizontal ? "end" : "middle"}
            >
              {d.label}
            </text>
            {/* OCTOBER 2026 — the value counts with its bar and rests on its top. */}
            {ti > 0.05 && (
              <text
                x={horizontal ? pad + extent + 12 : offset + thickness / 2}
                y={horizontal ? offset + thickness / 2 + 8 : H - pad - extent - 12}
                fill={ACCENT}
                fontFamily={CHART_FONT}
                fontSize={24}
                fontWeight={800}
                textAnchor={horizontal ? "start" : "middle"}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatValue(d.value * ti, decimals, prefix, suffix)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

export const LineChart: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
}> = ({ data, durationInFrames }) => {
  const frame = useCurrentFrame();
  const series = readSeries(data);
  if (series.length < 2) return null;

  const t = growth(frame, durationInFrames);
  /**
   * OCTOBER 2026 — a chart a viewer can read: its title, a value axis with round steps, the label
   * of every point under it, the value of every point once the line reaches it, and a head that
   * carries the current value while the line is drawn.
   */
  const title = readText(data, "title", "label");
  const { prefix, suffix } = chartUnits(data);
  const decimals = Math.max(...series.map((d) => readDecimals(data, d.value)));
  const pad = 80;
  const top = title ? 96 : 60;
  const plotW = W - pad * 2;
  const plotH = H - 70 - top;
  const ticks = niceTicks(Math.min(...series.map((d) => d.value), 0), Math.max(...series.map((d) => d.value)));
  const min = ticks[0]!;
  const max = ticks[ticks.length - 1]!;
  const span = Math.max(1e-6, max - min);
  const yOf = (v: number) => H - 70 - ((v - min) / span) * plotH;

  const points = series.map((d, i) => ({
    x: pad + (plotW * i) / (series.length - 1),
    y: yOf(d.value),
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const area = `${path} L${points[points.length - 1]!.x.toFixed(2)},${yOf(min).toFixed(2)} L${points[0]!.x.toFixed(2)},${yOf(min).toFixed(2)} Z`;

  /**
   * The line DRAWS itself with a dash offset rather than by slicing the path.
   *
   * Slicing would move the endpoint every frame and make the last segment jitter as it snaps
   * between data points; a dash offset reveals a fixed path, so the geometry never changes.
   */
  const length = points.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const q = points[i - 1]!;
    return sum + Math.hypot(p.x - q.x, p.y - q.y);
  }, 0);
  /** Where the head of the line is now, and the value it stands on — interpolated along the segment. */
  const along = t * (points.length - 1);
  const seg = Math.min(points.length - 2, Math.floor(along));
  const f = along - seg;
  const head = {
    x: points[seg]!.x + (points[seg + 1]!.x - points[seg]!.x) * f,
    y: points[seg]!.y + (points[seg + 1]!.y - points[seg]!.y) * f,
    v: series[seg]!.value + (series[seg + 1]!.value - series[seg]!.value) * f,
  };

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <clipPath id="line-reveal">
          <rect x={0} y={0} width={head.x} height={H} />
        </clipPath>
        <linearGradient id="line-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
          <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="rgba(9,14,22,0.72)" rx={10} />
      {title && (
        <text x={pad - 20} y={56} fill={INK} fontFamily={CHART_FONT} fontSize={30} fontWeight={800}>
          {title}
        </text>
      )}
      {ticks.map((v) => (
        <g key={`t${v}`}>
          <line x1={pad} x2={W - pad} y1={yOf(v)} y2={yOf(v)} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
          <text x={pad - 10} y={yOf(v) + 6} fill={MUTED} fontFamily={CHART_FONT} fontSize={17} textAnchor="end">
            {formatValue(v, decimals, prefix, suffix.trim() === "%" ? "%" : "")}
          </text>
        </g>
      ))}
      <line x1={pad} y1={yOf(min)} x2={W - pad} y2={yOf(min)} stroke={MUTED} strokeWidth={2} />
      {series.map((d, i) => (
        <text key={`x${i}`} x={points[i]!.x} y={H - 40} fill={MUTED} fontFamily={CHART_FONT} fontSize={18} textAnchor="middle">
          {d.label}
        </text>
      ))}
      <path d={area} fill="url(#line-area)" clipPath="url(#line-reveal)" />
      <path
        d={path}
        fill="none"
        stroke={ACCENT}
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - t)}
      />
      {points.map((p, i) => {
        // A point and its value appear when the line reaches it, not before.
        const reached = t >= (i / (points.length - 1)) * 0.98;
        return (
          <g key={i} opacity={reached ? 1 : 0}>
            <circle cx={p.x} cy={p.y} r={5} fill={ACCENT} />
            {(i === points.length - 1 || series.length <= 6) && (
              <text x={p.x} y={p.y - 14} fill={INK} fontFamily={CHART_FONT} fontSize={20} fontWeight={700} textAnchor="middle">
                {formatValue(series[i]!.value, decimals, prefix, suffix)}
              </text>
            )}
          </g>
        );
      })}
      {t < 0.995 && (
        <g>
          <circle cx={head.x} cy={head.y} r={9} fill={ACCENT} stroke="rgba(0,0,0,0.5)" strokeWidth={2} />
          {/* Near the right edge the running value sits to the left of the head, so it is never cut off. */}
          <text
            x={head.x > W - 220 ? head.x - 14 : head.x + 14}
            y={head.y - 14}
            textAnchor={head.x > W - 220 ? "end" : "start"}
            fill={ACCENT}
            fontFamily={CHART_FONT}
            fontSize={24}
            fontWeight={800}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatValue(head.v, decimals, prefix, suffix)}
          </text>
        </g>
      )}
    </svg>
  );
};

export const DonutChart: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
  filled?: boolean;
}> = ({ data, durationInFrames, filled }) => {
  const frame = useCurrentFrame();
  const series = readSeries(data);
  if (series.length === 0) return null;

  const t = growth(frame, durationInFrames);
  const total = series.reduce((s, d) => s + Math.abs(d.value), 0);
  if (total <= 0) return null;

  const cx = W / 2;
  const cy = H / 2;
  const r = 170;
  const inner = filled ? 0 : 100;

  /** Distinct hues around the wheel — deterministic, and never two adjacent slices the same. */
  const colour = (i: number) => `hsl(${(45 + (i * 360) / Math.max(1, series.length)) % 360} 78% 62%)`;

  let angle = -Math.PI / 2;
  const arcs = series.map((d, i) => {
    const sweep = (Math.abs(d.value) / total) * Math.PI * 2 * t;
    const from = angle;
    const to = angle + sweep;
    angle = from + (Math.abs(d.value) / total) * Math.PI * 2;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    const path =
      inner > 0
        ? `M${p(r, from)} A${r},${r} 0 ${large} 1 ${p(r, to)} L${p(inner, to)} A${inner},${inner} 0 ${large} 0 ${p(inner, from)} Z`
        : `M${cx},${cy} L${p(r, from)} A${r},${r} 0 ${large} 1 ${p(r, to)} Z`;
    return { path, colour: colour(i), datum: d };
  });

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {arcs.map((a, i) => (
        <path key={i} d={a.path} fill={a.colour} />
      ))}
      {arcs.map((a, i) => (
        <g key={`l${i}`}>
          <rect x={W - 260} y={90 + i * 34} width={18} height={18} fill={a.colour} rx={3} />
          <text
            x={W - 232}
            y={105 + i * 34}
            fill={INK}
            fontFamily={CHART_FONT}
            fontSize={20}
          >
            {a.datum.label || a.datum.value.toLocaleString("en-US")}
          </text>
        </g>
      ))}
    </svg>
  );
};

export const PercentageRing: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
}> = ({ data, durationInFrames }) => {
  const frame = useCurrentFrame();
  const percent = readRingPercent(data);
  if (percent == null) return null;

  const t = growth(frame, durationInFrames);
  const target = Math.max(0, Math.min(100, percent));
  const shown = target * t;
  const r = 150;
  const circumference = 2 * Math.PI * r;
  const label = readText(data, "label", "title");

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <circle cx={W / 2} cy={H / 2} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={26} />
      <circle
        cx={W / 2}
        cy={H / 2}
        r={r}
        fill="none"
        stroke={ACCENT}
        strokeWidth={26}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - shown / 100)}
        transform={`rotate(-90 ${W / 2} ${H / 2})`}
      />
      <text
        x={W / 2}
        y={H / 2 + 18}
        fill={INK}
        fontFamily={CHART_FONT}
        fontSize={78}
        fontWeight={800}
        textAnchor="middle"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {Math.round(shown)}%
      </text>
      {label && (
        <text x={W / 2} y={H / 2 + 76} fill={MUTED} fontFamily={CHART_FONT} fontSize={26} textAnchor="middle">
          {label}
        </text>
      )}
    </svg>
  );
};

/* ═══════════════════════ §14 — maps, abstract and honest ═══════════════════════ */

/**
 * A graticule: the lat/long grid an abstract map is drawn on.
 *
 * This is what makes the graphic READ as geography without claiming to be a map of anywhere. It is
 * the honest half of §14 — the viewer sees a coordinate system, not a coastline that was invented.
 */
const Graticule: React.FC = () => (
  <g stroke="rgba(255,255,255,0.16)" strokeWidth={1}>
    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
      <line key={`v${i}`} x1={(W / 8) * i} y1={0} x2={(W / 8) * i} y2={H} />
    ))}
    {[1, 2, 3, 4, 5].map((i) => (
      <line key={`h${i}`} x1={0} y1={(H / 6) * i} x2={W} y2={(H / 6) * i} />
    ))}
  </g>
);

/** A dropped pin, drawn as a path so it needs no icon font or external asset. */
const Pin: React.FC<{ x: number; y: number; scale?: number }> = ({ x, y, scale = 1 }) => (
  <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path
      d="M0,0 C-14,-20 -22,-30 -22,-42 A22,22 0 1 1 22,-42 C22,-30 14,-20 0,0 Z"
      fill={ACCENT}
      stroke="rgba(0,0,0,0.4)"
      strokeWidth={2}
    />
    <circle cx={0} cy={-42} r={8} fill="rgba(0,0,0,0.65)" />
  </g>
);

export const MapPoint: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
}> = ({ data, durationInFrames }) => {
  const frame = useCurrentFrame();
  const nx = readNumber(data, "normX");
  const ny = readNumber(data, "normY");
  if (nx == null || ny == null) return null;

  const t = growth(frame, durationInFrames);
  const x = Math.max(0, Math.min(1, nx)) * W;
  const y = Math.max(0, Math.min(1, ny)) * H;
  const label = readText(data, "label", "locationName", "location", "title");

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <rect width={W} height={H} fill="rgba(10,22,40,0.82)" rx={10} />
      <Graticule />
      {/* A ring that expands from the point, so the eye is led to it. */}
      <circle cx={x} cy={y} r={20 + 70 * t} fill="none" stroke={ACCENT} strokeWidth={2} opacity={1 - t} />
      <Pin x={x} y={y} scale={Math.min(1, t * 1.4)} />
      {label && (
        <text
          x={x}
          y={y + 34}
          fill={INK}
          fontFamily={CHART_FONT}
          fontSize={26}
          fontWeight={800}
          textAnchor="middle"
          opacity={t}
        >
          {label}
        </text>
      )}
    </svg>
  );
};

export const RouteMap: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
  pointsOnly?: boolean;
}> = ({ data, durationInFrames, pointsOnly }) => {
  const frame = useCurrentFrame();
  const points = readRoute(data);
  if (points.length < (pointsOnly ? 1 : 2)) return null;

  const t = growth(frame, durationInFrames);
  const xy = points.map((p) => ({ x: p.x * W, y: p.y * H, label: p.label }));
  const path = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const length = xy.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const q = xy[i - 1]!;
    return sum + Math.hypot(p.x - q.x, p.y - q.y);
  }, 0);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <rect width={W} height={H} fill="rgba(10,22,40,0.82)" rx={10} />
      <Graticule />
      {!pointsOnly && (
        /** A → B, drawn as the route is travelled. */
        <path
          d={path}
          fill="none"
          stroke={ACCENT}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - t)}
        />
      )}
      {xy.map((p, i) => {
        /** Each stop appears as the line reaches it. */
        const reachedAt = pointsOnly ? 0 : i / Math.max(1, xy.length - 1);
        const visible = t >= reachedAt * 0.98;
        return (
          <g key={i} opacity={visible ? 1 : 0}>
            <Pin x={p.x} y={p.y} scale={0.7} />
            {p.label && (
              <text
                x={p.x}
                y={p.y + 28}
                fill={INK}
                fontFamily={CHART_FONT}
                fontSize={22}
                fontWeight={700}
                textAnchor="middle"
              >
                {p.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

/* ═══════════════════════ shapes and icons ═══════════════════════ */

/**
 * Simple shapes, as SVG paths.
 *
 * No icon font, no icon API, no network at render time. Each is a handful of coordinates, which is
 * all these shapes ever needed — reaching for a library would have added a dependency and a
 * failure mode for the sake of eleven outlines.
 */
export const Shape: React.FC<{
  shape: string;
  durationInFrames: number;
  colour?: string;
}> = ({ shape, durationInFrames, colour }) => {
  const frame = useCurrentFrame();
  const path = SHAPE_PATHS[shape];
  if (!path) return null;
  const t = growth(frame, durationInFrames);
  /** Outline shapes are stroked; closed ones are filled. Deciding by name keeps it declarative. */
  const stroked = shape === "line" || shape === "arrow" || shape === "check" || shape === "x";
  return (
    <svg width={140} height={140} viewBox="-70 -70 140 140">
      <path
        d={path}
        fill={stroked ? "none" : colour ?? ACCENT}
        stroke={stroked ? colour ?? ACCENT : "none"}
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={`scale(${Math.min(1, t * 1.2).toFixed(3)})`}
      />
    </svg>
  );
};
