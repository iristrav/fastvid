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
 * RONDE 150 left `map` and `route` out of the vocabulary entirely and kept their payload — normX,
 * normY, locationName, the planner's reason — travelling intact through the whole chain, so that a
 * real component could be dropped in later with everything it needs. RONDE 155B dropped it in:
 * `map_point`, `route` and `multi_point` draw an ABSTRACT coordinate map from that payload. A map
 * with no coordinate is still refused rather than faked — `chartPayloadIsRenderable` decides.
 */
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { animationAt } from "./animation";
import { positionStyle, type TextStyleLike } from "./Text";
import {
  BarChart,
  DonutChart,
  LineChart,
  MapPoint,
  PercentageRing,
  RouteMap,
  Shape,
  readNumber,
  readText,
} from "./Charts";
import { graphicIsRenderable, readRegion } from "../../graphicsVocabulary";

export type GraphicSpec = {
  id: string;
  graphicType: string;
  data: Record<string, unknown>;
  label: string | null;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyleLike | null;
  /**
   * RONDE 185 — where the layout engine put this graphic, when it had to move it out of another's
   * way. Absent when nothing collided, which is the ordinary case.
   */
  layout?: { x: number; y: number; width: number; height: number };
  reason: string | null;
};

/**
 * RONDE 160 §7 — the vocabulary and the renderability predicate now live in
 * `server/graphicsVocabulary.ts`, a plain module with no React in it.
 *
 * They moved because "can this be drawn?" was being answered in three places that had drifted
 * apart — see that module's header. `edlToTimeline.ts` now asks the SAME function this component
 * asks, which is the only way the planning path and the drawing path can never disagree again.
 * Re-exported here so every existing import site is unchanged.
 */
export {
  RENDERABLE_GRAPHICS,
  DATA_DRIVEN_GRAPHICS,
  SHAPE_GRAPHICS,
  graphicIsRenderable,
} from "../../graphicsVocabulary";

export function unsupportedGraphicsIn(graphics: readonly GraphicSpec[]): GraphicSpec[] {
  return graphics.filter((g) => !graphicIsRenderable(g.graphicType, g.data, g.label));
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

/**
 * RONDE 152 — the constant lift is gone; geometry replaced it.
 *
 * RONDE 150 lifted a bottom-anchored card by a derived 12% of the frame height whenever a caption
 * shared its window. The number was reasoned about, but it was still one constant applied to every
 * case, and §152 asked for the real thing: measure both boxes, compute the free space, choose a
 * position, and report when there is none.
 *
 * `captionLayout.ts` now does that BEFORE the render starts, and moves the CAPTION rather than the
 * card — the card is where the planner put it, and a caption has somewhere else it can legibly go.
 * So this component draws a graphic at its own position and nothing else.
 */
export const Graphic: React.FC<{ g: GraphicSpec }> = ({ g }) => {
  const primary = readString(g, "label", "text", "title", "locationName", "location", "name", "caption");
  /**
   * One gate for every kind of graphic, payload included.
   *
   * A card needs words; a chart needs values; a map needs a coordinate; a shape needs a name this
   * build has a path for. `graphicIsRenderable` answers all four, and the renderer calls the same
   * function to decide what to report — so a graphic is never drawn without being reportable, or
   * reported as drawn without appearing.
   */
  if (!graphicIsRenderable(g.graphicType, g.data, g.label)) return null;

  /**
   * RONDE 124 — a highlight box is placed by its REGION, so it never reaches `GraphicBody`.
   *
   * Every other graphic is positioned by a named anchor — bottom, lower_third, centre — and
   * `GraphicBody` turns that name into a flex alignment over the whole frame. A box drawn around a
   * part of the picture has no anchor: its position IS its content. Routing it through the anchor
   * layout would centre it and it would stop being a highlight of anything, which is why this
   * returns before that layout rather than adding a case to the switch inside it.
   *
   * `graphicIsRenderable` above has already established the region exists and has area, so
   * `readRegion` cannot be null here; the guard is kept because a component that trusts an
   * invariant it does not check is one refactor away from drawing at NaN.
   */
  if (g.graphicType === "highlight_box") {
    const region = readRegion(g.data);
    if (!region) return null;
    return (
      <Sequence from={g.fromFrame} durationInFrames={g.durationInFrames} name={`highlight_box ${g.id}`}>
        <HighlightBox region={region} durationInFrames={g.durationInFrames} colour={g.style?.color} />
      </Sequence>
    );
  }

  const fontSizePx = g.style?.fontSizePx ?? 46;
  const position = g.style?.position ?? (g.graphicType === "lower_third" ? "lower_third" : "bottom");

  /**
   * The words a text-shaped graphic draws.
   *
   * `graphicIsRenderable` has already established that a text-shaped type HAS words, so this is
   * never empty for the branches that use it. Charts, maps and shapes ignore it entirely — they
   * draw from `g.data`.
   */
  const words = primary ?? "";

  let body: React.ReactNode;
  switch (g.graphicType) {
    /* ── RONDE 155B — charts, maps and shapes draw from the payload ─────────────────────── */
    case "bar_chart":
      body = <BarChart data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "horizontal_bar":
      body = <BarChart data={g.data} durationInFrames={g.durationInFrames} horizontal />;
      break;
    case "line_chart":
      body = <LineChart data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "pie_chart":
      body = <DonutChart data={g.data} durationInFrames={g.durationInFrames} filled />;
      break;
    case "donut_chart":
      body = <DonutChart data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "percentage_ring":
    case "progress":
      body = <PercentageRing data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "map_point":
      body = <MapPoint data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "route":
      body = <RouteMap data={g.data} durationInFrames={g.durationInFrames} />;
      break;
    case "multi_point":
      body = <RouteMap data={g.data} durationInFrames={g.durationInFrames} pointsOnly />;
      break;
    case "shape":
    case "icon":
      body = (
        <Shape
          shape={readText(g.data, "shape", "icon", "name") ?? g.label ?? ""}
          durationInFrames={g.durationInFrames}
          colour={g.style?.color}
        />
      );
      break;
    /**
     * A stat is a number with a label under it, and it reads the SAME payload a counter does — so
     * it counts when the payload says from/to and simply shows the number when it does not.
     */
    case "stat":
      body = <NumberCounter g={g} primary={words || String(readNumber(g.data, "value") ?? "")} />;
      break;
    case "location_card":
      body = <LocationCard g={g} primary={words} />;
      break;
    case "lower_third":
    case "name":
      body = <LowerThird g={g} primary={words} />;
      break;
    case "counter":
    case "statistic":
      body = <NumberCounter g={g} primary={words} />;
      break;
    case "quote":
      body = <QuoteCard g={g} primary={words} />;
      break;
    case "chapter_card":
    case "chapter_title":
      body = (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: CARD_FONT, fontSize: "1.2em", fontWeight: 800, color: "white", letterSpacing: "0.06em" }}>
            {words.toUpperCase()}
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
      <GraphicBody
        position={position}
        layout={g.layout}
        fontSizePx={fontSizePx}
        durationInFrames={g.durationInFrames}
      >
        {body}
      </GraphicBody>
    </Sequence>
  );
};

/**
 * RONDE 124 — the rectangle the planner asked to draw the eye to, over the region it named.
 *
 * ── Why it is percentages and not pixels ────────────────────────────────────────────────────
 *
 * The payload is in fractions of the frame, and the composition's dimensions are the composition's
 * business. Expressing the box as CSS percentages means it lands in the right place at 1920x1080,
 * at 1080x1920 and at any square the format list gains later, with no dimension read here and no
 * aspect-ratio arithmetic to get wrong. `readRegion` has already clamped the far edge into the
 * frame, so the box cannot run off it whatever the source's own dimensions were.
 *
 * ── What it draws ───────────────────────────────────────────────────────────────────────────
 *
 * An outline and nothing else. The picture underneath is the point — a filled box would hide the
 * thing it exists to point at — so the fill stays transparent and only the border carries ink,
 * with a soft outer shadow so the line reads against both a bright and a dark shot.
 *
 * The border animates in by drawing its opacity up over the first third of the graphic's life,
 * matching the `fade_rise` timing every other graphic uses, and never moves after that: a box that
 * drifts is a box that stops framing what it framed.
 */
export const HighlightBox: React.FC<{
  region: { x: number; y: number; width: number; height: number };
  durationInFrames: number;
  colour?: string;
}> = ({ region, durationInFrames, colour }) => {
  const frame = useCurrentFrame();
  const fadeFrames = Math.max(1, Math.round(durationInFrames / 3));
  const opacity = interpolate(frame, [0, fadeFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const stroke = colour ?? "#ffd166";
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: `${(region.x * 100).toFixed(3)}%`,
          top: `${(region.y * 100).toFixed(3)}%`,
          width: `${(region.width * 100).toFixed(3)}%`,
          height: `${(region.height * 100).toFixed(3)}%`,
          border: `4px solid ${stroke}`,
          borderRadius: 6,
          boxShadow: `0 0 0 2px rgba(0,0,0,0.45), 0 0 18px ${stroke}55`,
          background: "transparent",
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};

const GraphicBody: React.FC<{
  position: string;
  /**
   * RONDE 185 — where the layout engine decided this goes, when it had to move it.
   *
   * A resolved box WINS over the named anchor, exactly as it does for a text element: the engine
   * that knows what else is on screen at this moment outranks a name chosen before anything else
   * was placed. Absent means nothing collided and the anchor is used, unchanged.
   */
  layout?: { x: number; y: number; width: number; height: number };
  fontSizePx: number;
  durationInFrames: number;
  children: React.ReactNode;
  animation?: string;
}> = ({ position, layout, fontSizePx, durationInFrames, animation, children }) => {
  const frame = useCurrentFrame();
  /**
   * RONDE 155 — the same animation vocabulary the captions use, from the same pure functions.
   *
   * A graphic that wants to slide, pop or mask-reveal uses `animationAt` rather than a second set
   * of curves living here. `fade_rise` is the default because it is what every graphic did before
   * this round, so a timeline that names no animation still renders identically.
   */
  const state = animationAt(animation ?? "fade_rise", frame, durationInFrames);
  /**
   * RONDE 185 — a resolved box is an INNER absolutely-positioned div, not a restyled AbsoluteFill.
   *
   * The first attempt put `left`/`top` on the AbsoluteFill itself and the graphic did not move: an
   * AbsoluteFill sets its own inset, so the offsets were overridden and two graphics still drew in
   * one band. The pixel test caught it — the props were right and the picture was not, which is
   * exactly the difference that test exists to find.
   *
   * `Text.tsx` already had the correct shape for the same job, so this is that shape.
   */
  const body = (
    <AbsoluteFill style={{ ...positionStyle(position), display: "flex", fontSize: fontSizePx }}>
      <div
        style={{
          opacity: state.opacity,
          transform:
            `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`,
          clipPath:
            state.revealFraction < 1
              ? `inset(0 ${((1 - state.revealFraction) * 100).toFixed(2)}% 0 0)`
              : undefined,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
  if (!layout) return body;
  return (
    <AbsoluteFill style={{ fontSize: fontSizePx }}>
      <div
        style={{
          position: "absolute",
          left: layout.x,
          top: layout.y,
          width: layout.width,
          display: "flex",
          justifyContent: "center",
          transform:
            `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`,
          opacity: state.opacity,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
