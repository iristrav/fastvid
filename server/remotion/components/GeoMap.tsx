/**
 * OCTOBER 2026 — A REAL MAP, WHEN THE PLANNER KNOWS THE REAL PLACE.
 *
 * `MapPoint` and `RouteMap` in Charts.tsx draw an abstract map: a grid and a pin, because the
 * composition had no geography to draw. It has now: Natural Earth's 1:110m country outlines (public
 * domain), reduced to 156 KB and bundled with the composition — no tiles, no network at render
 * time, a frame is still a pure function of the payload and the frame number.
 *
 * A payload with `lon`/`lat` (or route points with them) is drawn here:
 *
 *   · the world, in the Natural Earth projection (the published polynomial, as d3's
 *     `geoNaturalEarth1` uses it — written out rather than adding d3 to the browser bundle);
 *   · a camera that starts on the whole world and moves in to the place (or to the route's extent),
 *     easing in and out, the way a documentary map establishes where we are going;
 *   · the place's country highlighted when the payload names it (`iso3`, Natural Earth's ADM0_A3);
 *   · a pin with a pulse and the place's name once the camera has arrived; for a route, the line
 *     drawn from stop to stop after that.
 *
 * Nothing is invented: no `lon`/`lat`, no real map — the abstract one, or nothing, as before.
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { easeInOut, easeOut } from "./animation";
import { readGeoPoint, readGeoPoints, readText } from "../../graphicsVocabulary";
import WORLD from "../data/countries110m.json";

type Country = { iso: string; name: string; rings: number[][][] };
const COUNTRIES = (WORLD as { countries: Country[] }).countries;

const W = 900;
const H = 520;
const FONT = "Inter, Noto Sans, DejaVu Sans, sans-serif";
const INK = "#ffffff";

/**
 * VIDEO 663 — the map's looks. One dark slate with grey land and a gold pin, every time, was "steeds
 * dezelfde animaties van de kaart"; the owner asked for more colour. Each full-frame map takes the
 * look of its `lookVariant` (the director numbers them in film order), so two maps in a row never
 * look alike. No violet anywhere: the owner had just asked for the purple haze to go.
 */
export type MapLook = { name: string; ocean: string; land: string; border: string; highlight: string };
export const MAP_LOOKS: readonly MapLook[] = [
  { name: "atlas", ocean: "#2b7bb9", land: "#f1e3c2", border: "rgba(90,70,40,0.45)", highlight: "#e4572e" },
  { name: "forest", ocean: "#0d4f73", land: "#5c9e5a", border: "rgba(255,255,255,0.35)", highlight: "#ffd23f" },
  { name: "lagoon", ocean: "#127c84", land: "#f6f1e4", border: "rgba(20,60,60,0.35)", highlight: "#d7263d" },
  { name: "sunset", ocean: "#1f4e8c", land: "#f4a259", border: "rgba(255,255,255,0.4)", highlight: "#c0392b" },
  { name: "night", ocean: "#12355b", land: "#2f6690", border: "rgba(255,255,255,0.3)", highlight: "#ff9f1c" },
];
export function mapLookFor(variant: number | undefined): MapLook {
  const n = MAP_LOOKS.length;
  return MAP_LOOKS[(((Math.trunc(variant ?? 0) % n) + n) % n)]!;
}

const RAD = Math.PI / 180;

/** Natural Earth I, in projection units (x right, y up). */
export function naturalEarth(lon: number, lat: number): [number, number] {
  const l = lon * RAD;
  const p = lat * RAD;
  const p2 = p * p;
  const p4 = p2 * p2;
  return [
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

/** Screen units of the un-zoomed world: projection units scaled to fill the panel, y down. */
const WORLD_EXTENT = (() => {
  const [xMax] = naturalEarth(180, 0);
  const [, yMax] = naturalEarth(0, 85);
  return { xMax, yMax };
})();
const BASE_SCALE = Math.min((W * 0.96) / (2 * WORLD_EXTENT.xMax), (H * 0.96) / (2 * WORLD_EXTENT.yMax));
export function toScreen(lon: number, lat: number): [number, number] {
  const [x, y] = naturalEarth(lon, lat);
  return [W / 2 + x * BASE_SCALE, H / 2 - y * BASE_SCALE];
}

/**
 * One country as SVG path data. A ring that jumps more than half the globe between two points
 * (a polygon that crosses the antimeridian) starts a new sub-path instead of a line across the map.
 */
function countryPath(c: Country): string {
  let d = "";
  for (const ring of c.rings) {
    let prevLon: number | null = null;
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i] as [number, number];
      const [x, y] = toScreen(lon, lat);
      const jump = prevLon != null && Math.abs(lon - prevLon) > 180;
      d += `${i === 0 || jump ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      prevLon = lon;
    }
    d += "Z";
  }
  return d;
}
const PATHS: Array<{ iso: string; d: string }> = COUNTRIES.map((c) => ({ iso: c.iso, d: countryPath(c) }));

/** The camera: the screen point it looks at and how far it is zoomed in. */
type Camera = { cx: number; cy: number; zoom: number };
const WORLD_CAMERA: Camera = { cx: W / 2, cy: H / 2, zoom: 1 };

/** A camera framing these screen points with room around them; one point gets a regional view. */
export function cameraFor(points: Array<[number, number]>, maxZoom = 6): Camera {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  /** A single place is shown with about a sixth of the panel around it. */
  const spanX = Math.max(maxX - minX, W / 7);
  const spanY = Math.max(maxY - minY, H / 7);
  const zoom = Math.max(1, Math.min(maxZoom, (W * 0.7) / spanX, (H * 0.7) / spanY));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom };
}

/** The camera at `t` (0..1) on its way from `from` (the world) to `to`: zoom in log space, centre linearly. */
export function cameraAt(to: Camera, t: number, from: Camera = WORLD_CAMERA): Camera {
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t);
  return {
    cx: from.cx + (to.cx - from.cx) * t,
    cy: from.cy + (to.cy - from.cy) * t,
    zoom,
  };
}

/**
 * VIDEO 663 — where the camera starts, by look: every map flew in from the whole world. Now the
 * first flies in from the world, the next drifts in from the side at a regional height, the third
 * starts close on the place and pulls back to show where it lies.
 */
export function cameraStartFor(to: Camera, variant: number | undefined): Camera {
  switch (((Math.trunc(variant ?? 0) % 3) + 3) % 3) {
    case 1: {
      const zoom = Math.max(1, to.zoom * 0.45);
      return { cx: to.cx - (W * 0.35) / zoom, cy: to.cy + (H * 0.12) / zoom, zoom };
    }
    case 2:
      return { cx: to.cx, cy: to.cy, zoom: Math.min(14, to.zoom * 2.4) };
    default:
      return WORLD_CAMERA;
  }
}

const Pin: React.FC<{ x: number; y: number; size: number; colour: string }> = ({ x, y, size, colour }) => (
  <g transform={`translate(${x} ${y}) scale(${size})`}>
    <path d="M0,0 C-14,-20 -22,-30 -22,-42 A22,22 0 1 1 22,-42 C22,-30 14,-20 0,0 Z" fill={colour} stroke="rgba(0,0,0,0.45)" strokeWidth={2} />
    <circle cx={0} cy={-42} r={8} fill="rgba(0,0,0,0.65)" />
  </g>
);

/** Whether this payload is for the real map (it carries real degrees). */
export function isGeoPayload(data: Record<string, unknown>): boolean {
  return readGeoPoint(data) != null || readGeoPoints(data).length > 0;
}

export const GeoMap: React.FC<{
  data: Record<string, unknown>;
  durationInFrames: number;
  /** "point" for one place, "route" to draw the line between the stops, "points" for stops only. */
  mode: "point" | "route" | "points";
  /** VIDEO 663 — the look and camera move (`lookVariant`); absent: the first look. */
  variant?: number;
  /** VIDEO 663 — the map is the whole frame: no rounded panel corners. */
  fullBleed?: boolean;
}> = ({ data, durationInFrames, mode, variant, fullBleed }) => {
  const look = mapLookFor(variant);
  const HIGHLIGHT = look.highlight;
  const frame = useCurrentFrame();
  const single = readGeoPoint(data);
  const stops =
    mode === "point"
      ? single
        ? [{ ...single, label: readText(data, "label", "locationName", "location", "title") ?? "" }]
        : []
      : readGeoPoints(data);
  if (stops.length === 0 || (mode === "route" && stops.length < 2)) return null;

  const highlight = readText(data, "iso3", "countryIso3");
  const screen = stops.map((s) => toScreen(s.lon, s.lat));
  const target = cameraFor(screen);

  /** The life of the graphic: the camera travels over the first 45%, the marks arrive after it. */
  const life = Math.max(1, durationInFrames);
  const travel = easeInOut(Math.min(1, frame / (life * 0.45)));
  const arrived = easeOut(Math.max(0, Math.min(1, (frame - life * 0.4) / (life * 0.2))));
  const lineT = easeOut(Math.max(0, Math.min(1, (frame - life * 0.45) / (life * 0.3))));
  const cam = cameraAt(target, travel, cameraStartFor(target, variant));
  const view = `translate(${W / 2} ${H / 2}) scale(${cam.zoom.toFixed(4)}) translate(${(-cam.cx).toFixed(2)} ${(-cam.cy).toFixed(2)})`;
  /** Marks keep their size on screen while the map under them grows. */
  const inv = 1 / cam.zoom;

  const routeD = screen.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <clipPath id="geomap-panel">
          <rect width={W} height={H} rx={fullBleed ? 0 : 10} />
        </clipPath>
      </defs>
      <g clipPath="url(#geomap-panel)">
        <rect width={W} height={H} fill={look.ocean} />
        <g transform={view}>
          {PATHS.map((p, i) => (
            <path
              key={`${p.iso}-${i}`}
              d={p.d}
              fill={highlight && p.iso === highlight ? HIGHLIGHT : look.land}
              fillOpacity={highlight && p.iso === highlight ? 0.25 + 0.55 * arrived : 1}
              fillRule="evenodd"
              stroke={look.border}
              strokeWidth={0.8 * inv}
            />
          ))}
          {mode === "route" && (
            <path
              d={routeD}
              fill="none"
              stroke={HIGHLIGHT}
              strokeWidth={4 * inv}
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - lineT}
            />
          )}
          {screen.map(([x, y], i) => {
            /** A route's stop appears when the line reaches it; a single place when the camera arrives. */
            const reached = mode === "route" ? lineT >= (i / Math.max(1, screen.length - 1)) * 0.98 : arrived > 0.02;
            if (!reached) return null;
            const label = stops[i]!.label;
            /**
             * Two stops close together on screen would print their names over each other: then the
             * second one's name goes above its pin instead of below.
             */
            const prev = screen[i - 1];
            const crowded = prev != null && Math.hypot((x - prev[0]) * cam.zoom, (y - prev[1]) * cam.zoom) < 170;
            const labelY = crowded && i % 2 === 1 ? y - 58 * inv : y + 34 * inv;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={(14 + 46 * arrived) * inv} fill="none" stroke={HIGHLIGHT} strokeWidth={2 * inv} opacity={1 - arrived} />
                <Pin x={x} y={y} size={inv * Math.min(1, 0.4 + arrived)} colour={HIGHLIGHT} />
                {label && (
                  <text
                    x={x}
                    y={labelY}
                    fill={INK}
                    fontFamily={FONT}
                    fontSize={26 * inv}
                    fontWeight={700}
                    textAnchor="middle"
                    opacity={arrived}
                    style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.75)", strokeWidth: 5 * inv }}
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
};
