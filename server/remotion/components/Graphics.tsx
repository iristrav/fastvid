/**
 * RONDE 150 §11/§12 — motion graphics, from the planner's payload.
 *
 * ── §11's rule: the payload decides the content, the component decides the look ──────────────
 *
 * "De renderer mag daar geen eigen tekst uit verzinnen."
 *
 * So every component below reads named fields out of `data` and renders nothing when they are
 * absent. A location card with no location does not become the word "Location" — it is reported as
 * an unsupported graphic and left out, because a card that says the wrong thing is worse than a
 * card that is missing.
 *
 * ── §12: maps are ARCHITECTURE, not a fake ───────────────────────────────────────────────────
 *
 * "Gebruik GEEN statische MAP tekst als fake fallback."
 *
 * `map` and `route` are deliberately absent from `RENDERABLE_GRAPHICS`. Their payload survives the
 * whole chain — normX, normY, locationName, the planner's reason — so a real map component can be
 * dropped in later and immediately have everything it needs. Until then they are reported.
 */
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { positionStyle, type TextStyleLike } from "./Text";

export type GraphicSpec = {
  id: string;
  graphicType: string;
  data: Record<string, unknown>;
  label: string | null;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyleLike | null;
  reason: string | null;
};

/**
 * Graphics this layer draws. Everything else keeps its payload and is REPORTED.
 *
 * Maps, routes and charts are not here on purpose — see the module note. Adding one means writing
 * a component, not adding a string.
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
]);

export function unsupportedGraphicsIn(graphics: readonly GraphicSpec[]): GraphicSpec[] {
  return graphics.filter(
    (g) => !RENDERABLE_GRAPHICS.has(g.graphicType) || !readString(g, "label", "text", "title")
  );
}

/** Read the first named field that is a non-empty string. Never falls back to a made-up value. */
function readString(g: GraphicSpec, ...keys: string[]): string | null {
  if (g.label?.trim()) return g.label.trim();
  for (const k of keys) {
    const v = g.data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function readAny(g: GraphicSpec, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = g.data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

const CARD_FONT = "DejaVu Sans, Liberation Sans, sans-serif";

/**
 * A location card: the place, with its country underneath when the payload has one.
 *
 * The rule in miniature — `country` is drawn if and only if the planner put one in the payload.
 */
const LocationCard: React.FC<{ g: GraphicSpec; primary: string }> = ({ g, primary }) => {
  const country = readAny(g, "country", "region", "subtitle");
  return (
    <div style={{ borderLeft: "4px solid #ffd54a", paddingLeft: 18 }}>
      <div style={{ fontFamily: CARD_FONT, fontSize: "1em", fontWeight: 800, color: "white", letterSpacing: "0.04em" }}>
        {primary.toUpperCase()}
      </div>
      {country && (
        <div style={{ fontFamily: CARD_FONT, fontSize: "0.55em", color: "rgba(255,255,255,0.75)", marginTop: 4 }}>
          {country}
        </div>
      )}
    </div>
  );
};

/** A lower third: a name and, when present, a role. */
const LowerThird: React.FC<{ g: GraphicSpec; primary: string }> = ({ g, primary }) => {
  const role = readAny(g, "role", "subtitle", "description", "title");
  return (
    <div style={{ background: "rgba(0,0,0,0.72)", padding: "0.5em 0.9em", borderRadius: 4 }}>
      <div style={{ fontFamily: CARD_FONT, fontSize: "0.9em", fontWeight: 800, color: "white" }}>{primary}</div>
      {role && (
        <div style={{ fontFamily: CARD_FONT, fontSize: "0.5em", color: "#ffd54a", marginTop: 2, letterSpacing: "0.08em" }}>
          {role.toUpperCase()}
        </div>
      )}
    </div>
  );
};

/**
 * A number counter that COUNTS, from the payload's own from/to.
 *
 * Deterministic: the value at frame N is a pure function of N. When the payload has no `fromValue`
 * the number is simply shown, because counting up from a value nobody specified would be inventing.
 */
const NumberCounter: React.FC<{ g: GraphicSpec; primary: string }> = ({ g, primary }) => {
  const frame = useCurrentFrame();
  const from = typeof g.data.fromValue === "number" ? g.data.fromValue : null;
  const to = typeof g.data.toValue === "number" ? g.data.toValue : null;
  const suffix = typeof g.data.suffix === "string" ? g.data.suffix : "";
  if (from == null || to == null) {
    return <div style={{ fontFamily: CARD_FONT, fontWeight: 800, color: "white" }}>{primary}</div>;
  }
  const value = interpolate(frame, [0, Math.max(1, g.durationInFrames - 6)], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ fontFamily: CARD_FONT, fontSize: "1.6em", fontWeight: 800, color: "white", fontVariantNumeric: "tabular-nums" }}>
      {Math.round(value).toLocaleString("en-US")}
      {suffix}
    </div>
  );
};

const QuoteCard: React.FC<{ g: GraphicSpec; primary: string }> = ({ g, primary }) => {
  const attribution = readAny(g, "attribution", "author", "source");
  return (
    <div style={{ maxWidth: "80%", textAlign: "center" }}>
      <div style={{ fontFamily: CARD_FONT, fontSize: "0.95em", fontStyle: "italic", color: "white", lineHeight: 1.35 }}>
        “{primary}”
      </div>
      {attribution && (
        <div style={{ fontFamily: CARD_FONT, fontSize: "0.5em", color: "rgba(255,255,255,0.7)", marginTop: 10 }}>
          — {attribution}
        </div>
      )}
    </div>
  );
};

export const Graphic: React.FC<{ g: GraphicSpec }> = ({ g }) => {
  const primary = readString(g, "label", "text", "title", "locationName", "location", "name", "caption");
  // No words, no card. The caller reports it; drawing the type name would be inventing content.
  if (!primary || !RENDERABLE_GRAPHICS.has(g.graphicType)) return null;

  const fontSizePx = g.style?.fontSizePx ?? 46;
  const position = g.style?.position ?? (g.graphicType === "lower_third" ? "lower_third" : "bottom");

  let body: React.ReactNode;
  switch (g.graphicType) {
    case "location_card":
      body = <LocationCard g={g} primary={primary} />;
      break;
    case "lower_third":
    case "name":
      body = <LowerThird g={g} primary={primary} />;
      break;
    case "counter":
    case "statistic":
      body = <NumberCounter g={g} primary={primary} />;
      break;
    case "quote":
      body = <QuoteCard g={g} primary={primary} />;
      break;
    case "chapter_card":
    case "chapter_title":
      body = (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: CARD_FONT, fontSize: "1.2em", fontWeight: 800, color: "white", letterSpacing: "0.06em" }}>
            {primary.toUpperCase()}
          </div>
          <div style={{ height: 3, width: 90, background: "#ffd54a", margin: "14px auto 0" }} />
        </div>
      );
      break;
    default:
      body = (
        <div style={{ fontFamily: CARD_FONT, fontSize: "1em", fontWeight: 800, color: "white" }}>{primary}</div>
      );
  }

  return (
    <Sequence from={g.fromFrame} durationInFrames={g.durationInFrames} name={`${g.graphicType} ${g.id}`}>
      <GraphicBody position={position} fontSizePx={fontSizePx} durationInFrames={g.durationInFrames}>
        {body}
      </GraphicBody>
    </Sequence>
  );
};

const GraphicBody: React.FC<{
  position: string;
  fontSizePx: number;
  durationInFrames: number;
  children: React.ReactNode;
}> = ({ position, fontSizePx, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const fade = Math.min(10, Math.max(1, Math.floor(durationInFrames / 6)));
  const opacity = interpolate(
    frame,
    [0, fade, Math.max(fade, durationInFrames - fade), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const slide = interpolate(frame, [0, fade], [18, 0], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ ...positionStyle(position), display: "flex", fontSize: fontSizePx }}>
      <div style={{ opacity, transform: `translateX(${slide}px)` }}>{children}</div>
    </AbsoluteFill>
  );
};
