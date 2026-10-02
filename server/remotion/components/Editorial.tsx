/**
 * OCTOBER 2026 — three treatments the planner could ask for and nothing drew.
 *
 *   timeline_event   one dated event was a plain text card; now a year with its event, and — when
 *                    the film has named more than one year — the chronology itself: a line that
 *                    draws from year to year, each dot arriving in turn, the current one lit.
 *   comparison       "A versus B": two halves sliding in from their own sides, a rule between them.
 *   kinetic_type     a short key phrase, word by word: each word rises out of a mask on its own
 *                    beat (the spoken word's time when the payload has it), one word can carry the
 *                    accent.
 *
 * Same rule as every other component here: the payload decides the words, the component the look.
 * Nothing is drawn that the payload does not carry, and the motion is a pure function of the frame.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { easeInOut, easeOut } from "./animation";

const CARD_FONT = "Inter, Noto Sans, DejaVu Sans, Liberation Sans, sans-serif";
const SERIF_FONT = "Noto Serif, DejaVu Serif, Liberation Serif, serif";
const DISPLAY_FONT = "Oswald, Inter, Noto Sans, DejaVu Sans, sans-serif";
const ACCENT = "#d9b45a";
const HALO = "0 2px 10px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)";

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export type TimelineEntry = { year: string; label: string };

/** The events a timeline payload carries, in order; entries with neither year nor label are dropped. */
export function readTimelineEvents(data: Record<string, unknown>): TimelineEntry[] {
  const raw = Array.isArray(data.events) ? data.events : [];
  return raw
    .map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      const year = typeof r.year === "string" ? r.year.trim() : typeof r.year === "number" ? String(r.year) : "";
      const label = typeof r.label === "string" ? r.label.trim() : "";
      return { year, label };
    })
    .filter((e) => e.year || e.label);
}

/** Which entry is "now": the payload's `current`, else the last one. */
export function currentTimelineIndex(data: Record<string, unknown>, count: number): number {
  const c = typeof data.current === "number" ? Math.round(data.current) : count - 1;
  return Math.max(0, Math.min(count - 1, c));
}

export const TimelineGraphic: React.FC<{ data: Record<string, unknown>; primary?: string; durationInFrames: number }> = ({ data, primary, durationInFrames }) => {
  const frame = useCurrentFrame();
  /** A payload with no `events` list is one event: its own `year` and the graphic's words. */
  const listed = readTimelineEvents(data);
  const year = typeof data.year === "string" || typeof data.year === "number" ? String(data.year).trim() : "";
  const events = listed.length ? listed : year || primary?.trim() ? [{ year, label: year && primary?.trim() === year ? "" : primary?.trim() ?? "" }] : [];
  if (events.length === 0) return null;
  const current = currentTimelineIndex(data, events.length);

  if (events.length === 1) {
    const e = events[0]!;
    const t = easeOut(clamp01(frame / Math.max(1, durationInFrames * 0.25)));
    return (
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: SERIF_FONT, fontSize: "1.2em", color: "white", letterSpacing: "0.1em", textShadow: HALO }}>{e.year}</div>
        <div style={{ height: 2, width: `${(4 * t).toFixed(2)}em`, background: ACCENT, margin: "8px auto" }} />
        {e.label && (
          <div style={{ fontFamily: CARD_FONT, fontSize: "0.55em", color: "white", letterSpacing: "0.12em", textShadow: HALO, opacity: t }}>
            {e.label.toUpperCase()}
          </div>
        )}
      </div>
    );
  }

  /** The line draws across the first 60% of the graphic's life; each dot lands as the line reaches it. */
  const draw = easeInOut(clamp01(frame / Math.max(1, durationInFrames * 0.6)));
  const span = Math.max(1, events.length - 1);
  const widthEm = Math.min(18, 4.2 * events.length);
  return (
    <div style={{ position: "relative", width: `${widthEm}em`, height: "3.4em" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: "1.55em", height: 2, background: "rgba(255,255,255,0.25)" }} />
      <div style={{ position: "absolute", left: 0, top: "1.55em", height: 2, width: `${(draw * 100).toFixed(2)}%`, background: ACCENT }} />
      {events.map((e, i) => {
        const at = i / span;
        const arrived = clamp01((draw - at) * span * 2 + (i === 0 ? 1 : 0));
        const lit = i === current;
        return (
          <div
            key={`${e.year}-${i}`}
            style={{
              position: "absolute",
              left: `${(at * 100).toFixed(2)}%`,
              top: 0,
              transform: "translateX(-50%)",
              textAlign: "center",
              opacity: arrived,
              width: "6em",
            }}
          >
            <div
              style={{
                fontFamily: SERIF_FONT,
                fontSize: lit ? "0.85em" : "0.6em",
                color: lit ? "white" : "rgba(255,255,255,0.75)",
                letterSpacing: "0.08em",
                textShadow: HALO,
                height: "1.3em",
              }}
            >
              {e.year}
            </div>
            <div
              style={{
                width: lit ? 16 : 10,
                height: lit ? 16 : 10,
                borderRadius: "50%",
                margin: lit ? "-2px auto 0" : "1px auto 0",
                background: lit ? ACCENT : "white",
                boxShadow: lit ? `0 0 ${(12 * arrived).toFixed(1)}px ${ACCENT}` : "none",
              }}
            />
            {e.label && (
              <div style={{ fontFamily: CARD_FONT, fontSize: "0.36em", color: lit ? ACCENT : "rgba(255,255,255,0.8)", letterSpacing: "0.1em", marginTop: 6, textShadow: HALO }}>
                {e.label.toUpperCase()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export function readComparison(data: Record<string, unknown>): { left: string; right: string; connector: string } | null {
  const left = typeof data.leftLabel === "string" ? data.leftLabel.trim() : "";
  const right = typeof data.rightLabel === "string" ? data.rightLabel.trim() : "";
  if (!left || !right) return null;
  const connector = typeof data.connector === "string" && data.connector.trim() ? data.connector.trim() : "VS";
  return { left, right, connector };
}

export const ComparisonGraphic: React.FC<{ data: Record<string, unknown>; durationInFrames: number }> = ({ data, durationInFrames }) => {
  const frame = useCurrentFrame();
  const c = readComparison(data);
  if (!c) return null;
  const t = easeOut(clamp01(frame / Math.max(1, durationInFrames * 0.3)));
  const rule = easeOut(clamp01((frame - durationInFrames * 0.15) / Math.max(1, durationInFrames * 0.3)));
  const side = (text: string, from: number): React.ReactNode => (
    <div
      style={{
        fontFamily: DISPLAY_FONT,
        fontSize: "1em",
        fontWeight: 600,
        color: "white",
        letterSpacing: "0.04em",
        textShadow: HALO,
        transform: `translateX(${((1 - t) * from).toFixed(1)}px)`,
        opacity: t,
        width: "7.5em",
        textAlign: from < 0 ? "right" : "left",
      }}
    >
      {text.toUpperCase()}
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6em" }}>
      {side(c.left, -80)}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 2, height: `${(1.1 * rule).toFixed(2)}em`, background: ACCENT }} />
        <div style={{ fontFamily: CARD_FONT, fontSize: "0.42em", color: ACCENT, letterSpacing: "0.2em", margin: "4px 0", opacity: rule }}>{c.connector}</div>
        <div style={{ width: 2, height: `${(1.1 * rule).toFixed(2)}em`, background: ACCENT }} />
      </div>
      {side(c.right, 80)}
    </div>
  );
};

/**
 * When each word of a kinetic phrase arrives, in frames from the graphic's start: the payload's
 * spoken times (`wordStarts`, seconds from the graphic's start) when it carries one per word, else
 * evenly across the first half of the graphic.
 */
export function kineticWordFrames(words: number, data: Record<string, unknown>, fps: number, durationInFrames: number): number[] {
  const starts = Array.isArray(data.wordStarts) ? data.wordStarts : [];
  if (starts.length === words && starts.every((s) => typeof s === "number" && Number.isFinite(s))) {
    return (starts as number[]).map((s) => Math.max(0, Math.round(s * fps)));
  }
  const step = words > 1 ? (durationInFrames * 0.5) / (words - 1) : 0;
  return Array.from({ length: words }, (_, i) => Math.round(i * step));
}

export const KineticType: React.FC<{ data: Record<string, unknown>; primary: string; durationInFrames: number }> = ({ data, primary, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = primary.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const arrive = kineticWordFrames(words.length, data, fps, durationInFrames);
  const emphasis = typeof data.emphasis === "string" ? data.emphasis.trim().toLowerCase() : "";
  const rise = Math.max(4, Math.round(fps * 0.35));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 0.32em", maxWidth: "16em" }}>
      {words.map((w, i) => {
        const t = easeOut(clamp01((frame - arrive[i]!) / rise));
        const accent = emphasis && w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === emphasis;
        return (
          <div key={i} style={{ overflow: "hidden", paddingBottom: "0.08em" }}>
            <div
              style={{
                fontFamily: DISPLAY_FONT,
                fontSize: "1.25em",
                fontWeight: 600,
                lineHeight: 1.1,
                color: accent ? ACCENT : "white",
                letterSpacing: `${(0.06 - 0.04 * t).toFixed(3)}em`,
                textShadow: HALO,
                transform: `translateY(${((1 - t) * 110).toFixed(1)}%)`,
              }}
            >
              {w.toUpperCase()}
            </div>
          </div>
        );
      })}
    </div>
  );
};
