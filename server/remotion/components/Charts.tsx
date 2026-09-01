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
  readNumber,
  readRingPercent,
  readRoute,
  readSeries,
  readText,
} from "../../graphicsVocabulary";

const CHART_FONT = "DejaVu Sans, Liberation Sans, sans-serif";
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

export const BarChart: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
  horizontal?: boolean;
}> = ({ data, durationInFrames, horizontal }) => {
  const frame = useCurrentFrame();
  const series = readSeries(data);
  if (series.length === 0) return null;

  const t = growth(frame, durationInFrames);
  /** Scaled to the largest value, so a chart of small numbers still fills the frame. */
  const max = Math.max(...series.map((d) => Math.abs(d.value)), 1);
  const title = readText(data, "title", "label");
  const pad = 70;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const slot = (horizontal ? plotH : plotW) / series.length;
  const thickness = slot * 0.6;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      {title && (
        <text x={pad} y={38} fill={INK} fontFamily={CHART_FONT} fontSize={30} fontWeight={800}>
          {title}
        </text>
      )}
      {/* The baseline. A chart without one leaves the eye nothing to measure against. */}
      <line
        x1={pad}
        y1={horizontal ? pad : H - pad}
        x2={horizontal ? pad : W - pad}
        y2={H - pad}
        stroke={MUTED}
        strokeWidth={2}
      />
      {series.map((d, i) => {
        const extent = (Math.abs(d.value) / max) * (horizontal ? plotW : plotH) * t;
        const offset = pad + slot * i + (slot - thickness) / 2;
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
            {/* The value appears only once the bar has finished growing to it. */}
            {t > 0.98 && (
              <text
                x={horizontal ? pad + extent + 12 : offset + thickness / 2}
                y={horizontal ? offset + thickness / 2 + 8 : H - pad - extent - 12}
                fill={ACCENT}
                fontFamily={CHART_FONT}
                fontSize={24}
                fontWeight={800}
                textAnchor={horizontal ? "start" : "middle"}
              >
                {d.value.toLocaleString("en-US")}
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
  const pad = 70;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const max = Math.max(...series.map((d) => d.value));
  const min = Math.min(...series.map((d) => d.value), 0);
  const span = Math.max(1e-6, max - min);

  const points = series.map((d, i) => ({
    x: pad + (plotW * i) / (series.length - 1),
    y: H - pad - ((d.value - min) / span) * plotH,
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

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

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke={MUTED} strokeWidth={2} />
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
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={5}
          fill={ACCENT}
          // A point appears when the line reaches it, not before.
          opacity={t >= (i / (points.length - 1)) * 0.98 ? 1 : 0}
        />
      ))}
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
