/**
 * OCTOBER 2026 — MOTION AND EDITORIAL TEXT, AT LEAST TWO OF EACH PER STARTED MINUTE.
 *
 *     required = ceil(durationSec / 60) * 2        (for both)
 *
 * Counted on the directed timeline — what the viewer will actually see — after
 * `directOnScreenText` has applied its rules. Captions never count.
 *
 *   motion     a graphic that moves information: a map, a chart, a counter, a progress ring, a
 *              chronology, a comparison, a key phrase set word by word.
 *   editorial  a card or text that states a fact in a few words: a name, a year, a place, a quote,
 *              an event's name.
 *
 * When the film is short of either, this fills from what the planners ALREADY produced for this
 * script and nothing else — never a number, a place or a phrase the narration does not contain:
 *
 *   1  CHRONOLOGY   a year after the film's first one becomes a timeline of the years named so far,
 *                   the current one lit (a date card turned into motion; its year stays on screen).
 *   2  KINETIC      the scene's own kinetic-typography words (`animated_text`, which the director
 *                   switches off as loose pop-ups) are set together as one phrase, word by word, on
 *                   the times they are spoken.
 *   3  EVENT        a named event the caption planner labelled (`callout`) comes back as a label.
 *   4  RE-NAME      a person the film named more than a minute earlier is named again by their
 *                   lower third — the way a documentary re-identifies someone after a long gap.
 *
 * Each candidate goes where the film is thinnest (the minute with the fewest elements) and only
 * where it is free: never beside two other texts, never in the same place as another one. What
 * cannot be filled is REPORTED as a shortfall — a planning finding, not a reason to invent.
 */
import type { ProjectTimeline, TimelineGraphic, TimelineText } from "./projectTimeline";

export const MOTION_GRAPHICS: ReadonlySet<string> = new Set([
  "map_point", "route", "multi_point",
  "line_chart", "bar_chart", "horizontal_bar", "pie_chart", "donut_chart", "percentage_ring", "progress",
  "counter", "statistic", "stat",
  "timeline_event", "comparison", "kinetic_type",
]);
export const EDITORIAL_GRAPHICS: ReadonlySet<string> = new Set([
  "lower_third", "name", "date_card", "location_card", "quote", "chapter_card", "chapter_title",
]);

export const RE_NAME_AFTER_SEC = 60;
const MAX_AT_ONCE = 2;
const MIN_KINETIC_SEC = 2.5;
const MIN_TIMELINE_SEC = 3.5;

export type CoverageAddition = { id: string; kind: "chronology" | "kinetic" | "event" | "re_name"; at: number; text: string };

export type GraphicsCoverage = {
  durationSec: number;
  requiredMotion: number;
  requiredEditorial: number;
  motion: number;
  editorial: number;
  /** Per started minute, after filling. */
  perMinute: Array<{ minute: number; motion: number; editorial: number }>;
  added: CoverageAddition[];
  /** Null when both minimums are met; otherwise what is short and why nothing could fill it. */
  shortfall: string | null;
};

export function requiredPerKind(durationSec: number): number {
  return Math.ceil(Math.max(0, durationSec) / 60) * 2;
}

type Span = { start: number; end: number; region: string; id: string };

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

function regionOfGraphic(g: TimelineGraphic): string {
  return g.graphicType === "lower_third" ? "lower_third" : (g.style?.position ?? "bottom");
}

function isMotion(g: TimelineGraphic): boolean {
  return MOTION_GRAPHICS.has(g.graphicType);
}
function isEditorialGraphic(g: TimelineGraphic): boolean {
  return EDITORIAL_GRAPHICS.has(g.graphicType);
}

const yearOf = (s: string): string | null => s.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)?.[0] ?? null;

export function ensureGraphicsCoverage(timeline: ProjectTimeline): GraphicsCoverage {
  const textTrack = timeline.tracks.find((t) => t.kind === "TEXT");
  const graphicTrack = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  const texts: TimelineText[] = textTrack && textTrack.kind === "TEXT" ? textTrack.texts : [];
  const graphics: TimelineGraphic[] = graphicTrack && graphicTrack.kind === "GRAPHICS" ? graphicTrack.graphics : [];
  const durationSec = timeline.durationSec > 0
    ? timeline.durationSec
    : Math.max(0, ...graphics.map((g) => g.end), ...texts.map((t) => t.end));
  const required = requiredPerKind(durationSec);
  const minutes = Math.max(1, Math.ceil(durationSec / 60));
  const added: CoverageAddition[] = [];

  const live = (): { motion: TimelineGraphic[]; editorial: Array<TimelineGraphic | TimelineText> } => ({
    motion: graphics.filter((g) => !g.disabled && isMotion(g)),
    editorial: [
      ...graphics.filter((g) => !g.disabled && isEditorialGraphic(g)),
      ...texts.filter((t) => !t.disabled && t.text.trim()),
    ],
  });
  const minuteOf = (sec: number) => Math.min(minutes - 1, Math.max(0, Math.floor(sec / 60)));
  const perMinute = () => {
    const now = live();
    return Array.from({ length: minutes }, (_, minute) => ({
      minute,
      motion: now.motion.filter((g) => minuteOf(g.start) === minute).length,
      editorial: now.editorial.filter((e) => minuteOf(e.start) === minute).length,
    }));
  };
  const spans = (): Span[] => [
    ...graphics.filter((g) => !g.disabled).map((g) => ({ start: g.start, end: g.end, region: regionOfGraphic(g), id: g.id })),
    ...texts.filter((t) => !t.disabled).map((t) => ({ start: t.start, end: t.end, region: t.style.position, id: t.id })),
  ];
  /** Free: fewer than two other texts at once, none in the same place. `except` is the element being replaced. */
  const free = (start: number, end: number, region: string, except: readonly string[] = []): boolean => {
    const concurrent = spans().filter((s) => !except.includes(s.id) && overlaps(s, { start, end }));
    return concurrent.length < MAX_AT_ONCE && !concurrent.some((s) => s.region === region);
  };
  /** Thinnest minute first, then earliest. */
  const byNeed = <T extends { at: number }>(list: T[], kind: "motion" | "editorial"): T[] => {
    const counts = perMinute();
    return list.slice().sort((a, b) => counts[minuteOf(a.at)]![kind] - counts[minuteOf(b.at)]![kind] || a.at - b.at);
  };
  const nextStartAfter = (sec: number, except: string): number => {
    const later = spans().filter((s) => s.id !== except && s.start > sec + 0.01).map((s) => s.start);
    return Math.min(durationSec || Number.POSITIVE_INFINITY, ...later);
  };

  /* 1 — CHRONOLOGY: a later year becomes the timeline of the years named so far. */
  if (live().motion.length < required) {
    const dated = graphics
      .filter((g) => !g.disabled && g.graphicType === "date_card" && yearOf(g.label ?? String(g.data?.text ?? "")))
      .sort((a, b) => a.start - b.start);
    const years = dated.map((g) => yearOf(g.label ?? String(g.data?.text ?? ""))!);
    const candidates = dated
      .map((g, i) => ({ g, i, at: g.start }))
      .filter((c) => c.i >= 1 && years.slice(0, c.i + 1).filter((y, k, a) => a.indexOf(y) === k).length >= 2);
    for (const c of byNeed(candidates, "motion")) {
      if (live().motion.length >= required) break;
      const sofar = years.slice(0, c.i + 1).filter((y, k, a) => a.indexOf(y) === k).slice(-4);
      const g = c.g;
      g.graphicType = "timeline_event";
      g.data = {
        ...(g.data ?? {}),
        events: sofar.map((year) => ({ year, label: "" })),
        current: sofar.length - 1,
        coverage: "chronology",
      };
      delete (g.data as Record<string, unknown>).typewriter;
      g.end = Number(Math.max(g.end, Math.min(g.start + MIN_TIMELINE_SEC, nextStartAfter(g.start, g.id))).toFixed(3));
      added.push({ id: g.id, kind: "chronology", at: g.start, text: sofar.join(" → ") });
    }
  }

  /* 2 — KINETIC: a scene's kinetic-typography words, set as one phrase on their spoken times. */
  if (live().motion.length < required) {
    const words = texts
      .filter((t) => t.disabled && t.role === "animated_text" && t.disabledReason === "keyword_popup" && t.text.trim())
      .sort((a, b) => a.start - b.start);
    const groups: TimelineText[][] = [];
    for (const t of words) {
      const last = groups[groups.length - 1];
      if (last && t.start - last[last.length - 1]!.end <= 0.6 && last.length < 6) last.push(t);
      else groups.push([t]);
    }
    const candidates = groups
      .map((group) => ({ group, at: group[0]!.start, phrase: group.map((t) => t.text.trim()).join(" ") }))
      .filter((c) => {
        const n = c.phrase.split(/\s+/).length;
        return n >= 1 && n <= 8 && c.phrase.length <= 48;
      });
    for (const c of byNeed(candidates, "motion")) {
      if (live().motion.length >= required) break;
      const start = c.at;
      const end = Number(Math.max(c.group[c.group.length - 1]!.end, start + MIN_KINETIC_SEC).toFixed(3));
      if (!free(start, end, "lower_third")) continue;
      const wordStarts = c.group.flatMap((t) => {
        const n = t.text.trim().split(/\s+/).length;
        return Array.from({ length: n }, () => Number((t.start - start).toFixed(3)));
      });
      const id = `${c.group[0]!.id}_kinetic`;
      graphics.push({
        id,
        graphicType: "kinetic_type",
        data: { text: c.phrase, wordStarts, coverage: "kinetic" },
        start,
        end,
        label: c.phrase,
        /**
         * The lower-third band, not the centre: with no face position known, the centre of the frame
         * is where a documentary's subject usually is, and a phrase set there would sit on them.
         */
        style: { ...(c.group[0]!.style ?? {}), position: "lower_third" } as TimelineGraphic["style"],
        reason: "OCTOBER 2026 — coverage: the scene's kinetic-typography words, set together as one phrase",
      });
      added.push({ id, kind: "kinetic", at: start, text: c.phrase });
    }
  }

  /* 3 — EVENT: a named event the caption planner labelled. */
  if (live().editorial.length < required) {
    const candidates = texts
      .filter((t) => t.disabled && t.role === "callout" && t.disabledReason === "keyword_popup")
      .filter((t) => {
        const n = t.text.trim().split(/\s+/).length;
        return n >= 2 && n <= 8;
      })
      .map((t) => ({ t, at: t.start }));
    for (const c of byNeed(candidates, "editorial")) {
      if (live().editorial.length >= required) break;
      const end = Math.max(c.t.end, c.t.start + 2);
      if (!free(c.t.start, end, c.t.style.position)) continue;
      c.t.disabled = false;
      delete c.t.disabledReason;
      c.t.end = Number(end.toFixed(3));
      added.push({ id: c.t.id, kind: "event", at: c.t.start, text: c.t.text });
    }
  }

  /* 4 — RE-NAME: a person last named more than a minute ago, by their own lower third. */
  if (live().editorial.length < required) {
    const named = new Map<string, number>();
    const candidates: Array<{ g: TimelineGraphic; at: number }> = [];
    for (const g of graphics.filter((x) => x.graphicType === "lower_third").sort((a, b) => a.start - b.start)) {
      const who = (g.label ?? "").trim().toLowerCase();
      if (!who) continue;
      if (!g.disabled) {
        named.set(who, g.start);
        continue;
      }
      const last = named.get(who);
      if (g.disabledReason === "name_already_shown" && last != null && g.start - last >= RE_NAME_AFTER_SEC) {
        candidates.push({ g, at: g.start });
        named.set(who, g.start);
      }
    }
    for (const c of byNeed(candidates, "editorial")) {
      if (live().editorial.length >= required) break;
      if (!free(c.g.start, c.g.end, "lower_third")) continue;
      c.g.disabled = false;
      delete c.g.disabledReason;
      added.push({ id: c.g.id, kind: "re_name", at: c.g.start, text: c.g.label ?? "" });
    }
  }

  const now = live();
  const short: string[] = [];
  if (now.motion.length < required) short.push(`motion ${now.motion.length}/${required}`);
  if (now.editorial.length < required) short.push(`editorial text ${now.editorial.length}/${required}`);
  return {
    durationSec,
    requiredMotion: required,
    requiredEditorial: required,
    motion: now.motion.length,
    editorial: now.editorial.length,
    perMinute: perMinute(),
    added,
    shortfall: short.length
      ? `${short.join(", ")} — the script names too few figures, places, years, people or events to fill it without inventing`
      : null,
  };
}

/** One line for the render log. */
export function formatGraphicsCoverage(videoId: number, c: GraphicsCoverage): string {
  return (
    `[Graphics] coverage video=${videoId} ${Math.round(c.durationSec)}s ` +
    `motion=${c.motion}/${c.requiredMotion} editorial=${c.editorial}/${c.requiredEditorial} ` +
    `perMinute=[${c.perMinute.map((m) => `${m.motion}m+${m.editorial}t`).join(" ")}]` +
    (c.added.length ? ` added=${c.added.map((a) => `${a.kind}:"${a.text}"@${a.at.toFixed(1)}s`).join(", ")}` : "") +
    (c.shortfall ? ` SHORTFALL: ${c.shortfall}` : "")
  );
}
