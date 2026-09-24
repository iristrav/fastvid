/**
 * RONDE 651 — ON-SCREEN TEXT, THE WAY A DOCUMENTARY DOES IT.
 *
 * ── What render 607 put on screen ─────────────────────────────────────────────────────────────
 *
 * Seventy seconds carried twenty-six text elements. Frame by frame:
 *
 *   · "Berlin" and "1945" drawn in the same spot, reading "Ber45n"; "Führerbunker" and "suicide"
 *     reading "Fühsuicideker".
 *   · every label twice — "Third Reich" in large white over a small "THIRD REICH" card, "Adolf
 *     Hitler" large on the left and small in a box in the middle of the same frame.
 *   · single words from the script popping up mid-frame: "suicide", "escape", "critical
 *     decision", "broader disintegration".
 *   · an empty dark-blue grid with a pin and "Berlin, Germany" covering the middle of the picture.
 *
 * Two planners each did their job: the caption planner writes a name, a date, a place and the
 * beat's key words as text; the motion-graphics planner writes a lower third, a date card and a
 * map for the same facts. Nothing looked at the two together.
 *
 * ── The rules, as an editor would state them ──────────────────────────────────────────────────
 *
 *   1  No key-word pop-ups. The narration already says the word; the picture should not.
 *   2  A map without geography is not a map: it is switched off and a location card stands in.
 *   3  A person is named once in the film, the first time, by one lower third — and only a name
 *      that looks like a person's (two capitalised words). "Führerbunker" is not a person.
 *   4  A place is shown once, and a year is shown once, the first time — by the card, not by loose
 *      text beside it; a place and a year that arrive together become one locator.
 *   5  Text that repeats a card on screen at the same time is not drawn.
 *   6  Never two texts in the same place at the same time, and never more than two texts at once.
 *   7  What stays is on screen long enough to read: at least two seconds.
 *
 * Nothing is deleted. An element the rules take off is `disabled`, with its reason, so the editor
 * can switch it back on — the renderer and the Remotion props already skip a disabled element.
 */
import type { ProjectTimeline, TimelineGraphic, TimelineText } from "./projectTimeline";

export const MIN_TEXT_ON_SCREEN_SEC = 2;
export const MAX_TEXTS_AT_ONCE = 2;

type Kind = "name" | "place" | "date" | "title" | "other";

type Element =
  | { track: "text"; el: TimelineText; kind: Kind; key: string; region: string; label: string }
  | { track: "graphic"; el: TimelineGraphic; kind: Kind; key: string; region: string; label: string };

export type TextDirection = {
  kept: number;
  disabled: Array<{ id: string; reason: string; label: string }>;
  converted: string[];
  extended: number;
};

const KEYWORD_ROLES = new Set(["animated_text", "callout"]);
const PRIORITY: Record<Kind, number> = { title: 0, name: 1, place: 2, date: 3, other: 4 };

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Berlin, Germany" and "Berlin" are one place; the part before the comma names it. */
const placeKey = (s: string): string => norm(s.split(",")[0] ?? s);

/** Two or more words, each capitalised: "Adolf Hitler", "Joseph Goebbels". Not "Führerbunker". */
export function looksLikePersonName(label: string): boolean {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^\p{Lu}/u.test(w));
}

function textKind(t: TimelineText): Kind {
  switch (t.role) {
    case "name":
      return "name";
    case "location":
      return "place";
    case "date":
    case "timeline_label":
      return "date";
    case "title":
    case "chapter_title":
    case "quote":
      return "title";
    default:
      return "other";
  }
}

function graphicKind(g: TimelineGraphic): Kind {
  switch (g.graphicType) {
    case "lower_third":
      return "name";
    case "location_card":
      return "place";
    case "date_card":
    case "timeline_event":
      return "date";
    case "quote":
      return "title";
    default:
      return "other";
  }
}

function keyFor(kind: Kind, label: string): string {
  if (kind === "place") return `place:${placeKey(label)}`;
  if (kind === "date") return `date:${label.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)?.[0] ?? norm(label)}`;
  return `${kind}:${norm(label)}`;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end;

function switchOff(e: Element, reason: string, out: TextDirection): void {
  e.el.disabled = true;
  e.el.disabledReason = reason;
  out.disabled.push({ id: e.el.id, reason, label: e.label });
}

/**
 * Apply the rules to a timeline, in place. Deterministic: the same timeline always gives the
 * same result, ordered by start time and then id.
 */
export function directOnScreenText(timeline: ProjectTimeline): TextDirection {
  const out: TextDirection = { kept: 0, disabled: [], converted: [], extended: 0 };
  const textTrack = timeline.tracks.find((t) => t.kind === "TEXT");
  const graphicTrack = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  const texts = textTrack && textTrack.kind === "TEXT" ? textTrack.texts : [];
  const graphics = graphicTrack && graphicTrack.kind === "GRAPHICS" ? graphicTrack.graphics : [];

  /*
   * Rule 2 — a map with no geography becomes the location card it was trying to be.
   *
   * `MapPoint` draws a blue panel, a graticule and a pin: no coastline, no country. The map stays
   * on the track, switched off with its payload intact, and a location card for the same place is
   * added beside it for the same span.
   */
  for (const g of [...graphics]) {
    if (g.disabled || (g as { editedByUser?: boolean }).editedByUser) continue;
    if (g.graphicType !== "map_point") continue;
    const place = typeof g.data?.locationName === "string" ? g.data.locationName : g.label ?? "";
    g.disabled = true;
    g.disabledReason = "map_without_geography";
    out.disabled.push({ id: g.id, reason: "map_without_geography", label: place || g.graphicType });
    if (!place.trim()) continue;
    graphics.push({
      id: `${g.id}_loc`,
      graphicType: "location_card",
      /** `standsInFor`: added by this director, not planned — so no count mistakes it for a plan. */
      data: { locationName: place, label: place, standsInFor: g.id },
      start: g.start,
      end: g.end,
      label: place,
      reason: `RONDE 651 — stands in for ${g.id}, a map drawn without geography`,
    });
    out.converted.push(`${g.id} map_point → location_card (${place})`);
  }

  const elements: Element[] = [
    ...texts
      .filter((t) => !t.disabled && t.text.trim())
      .map((t): Element => {
        const kind = textKind(t);
        const label = t.text.split("\n")[0]!.trim();
        return { track: "text", el: t, kind, key: keyFor(kind, label), region: t.style.position, label };
      }),
    ...graphics
      .filter((g) => !g.disabled && (g.label ?? "").trim())
      .map((g): Element => {
        const kind = graphicKind(g);
        const label = (g.label ?? "").trim();
        /** The anchor `Graphics.tsx` falls back to: a lower third on its band, everything else at the bottom. */
        const region = g.graphicType === "lower_third" ? "lower_third" : (g.style?.position ?? "bottom");
        return { track: "graphic", el: g, kind, key: keyFor(kind, label), region, label };
      }),
  ].sort(
    (a, b) =>
      a.el.start - b.el.start ||
      (a.track === b.track ? 0 : a.track === "graphic" ? -1 : 1) ||
      a.el.id.localeCompare(b.el.id)
  );

  /** A text or card the user edited is theirs: kept exactly as it is and never switched off. */
  const userEdited = (e: Element): boolean => (e.el as { editedByUser?: boolean }).editedByUser === true;

  /* Rule 1 — key-word pop-ups. */
  for (const e of elements) {
    if (userEdited(e) || e.track !== "text") continue;
    if (KEYWORD_ROLES.has(e.el.role ?? "")) switchOff(e, "keyword_popup", out);
  }

  /* Rule 3 — only a person's name is named as a person. */
  for (const e of elements) {
    if (userEdited(e) || e.el.disabled || e.kind !== "name") continue;
    if (!looksLikePersonName(e.label)) switchOff(e, "not_a_person_name", out);
  }

  /* Rules 3 and 4 — each person, place and year once, first, and by the card. */
  const seen = new Map<string, Element>();
  for (const e of elements) {
    if (userEdited(e) || e.el.disabled) continue;
    if (e.kind !== "name" && e.kind !== "place" && e.kind !== "date") continue;
    const first = seen.get(e.key);
    if (!first) {
      seen.set(e.key, e);
      continue;
    }
    /** A card arriving with a loose text for the same fact replaces it, rather than joining it. */
    if (e.track === "graphic" && first.track === "text" && Math.abs(e.el.start - first.el.start) < 0.75) {
      switchOff(first, "duplicate_of_card", out);
      seen.set(e.key, e);
      continue;
    }
    switchOff(e, `${e.kind}_already_shown`, out);
  }

  /*
   * Rule 4b — a place and a year that arrive together are one locator: "BERLIN / 1945", the way a
   * documentary marks where and when in a single slug, instead of two labels competing for room.
   */
  for (const e of elements) {
    if (userEdited(e) || e.el.disabled || e.kind !== "date") continue;
    const year = e.key.slice("date:".length);
    const place = elements.find(
      (p) => p.track === "graphic" && !p.el.disabled && p.kind === "place" && Math.abs(p.el.start - e.el.start) < 1
    );
    if (!place || place.track !== "graphic" || !/^\d{4}$/.test(year)) continue;
    const data = place.el.data ?? {};
    const existing = typeof data.country === "string" ? data.country : typeof data.subtitle === "string" ? data.subtitle : "";
    place.el.data = { ...data, subtitle: existing ? `${existing} · ${year}` : year };
    delete (place.el.data as Record<string, unknown>).country;
    place.el.end = Math.max(place.el.end, e.el.end);
    switchOff(e, "merged_into_locator", out);
  }

  /* Rule 5 — loose text that repeats a card on screen at the same time. */
  const cards = elements.filter((e) => e.track === "graphic" && !e.el.disabled);
  for (const e of elements) {
    if (userEdited(e) || e.el.disabled || e.track !== "text") continue;
    const twin = cards.find((c) => overlaps(c.el, e.el) && norm(c.label) === norm(e.label));
    if (twin) switchOff(e, "duplicate_of_card", out);
  }

  /* Rule 7 — long enough to read, before crowding is judged on the real on-screen spans. */
  const end = timeline.durationSec > 0 ? timeline.durationSec : Number.POSITIVE_INFINITY;
  for (const e of elements) {
    if (e.el.disabled || userEdited(e)) continue;
    if (e.el.end - e.el.start < MIN_TEXT_ON_SCREEN_SEC) {
      e.el.end = Number(Math.min(end, e.el.start + MIN_TEXT_ON_SCREEN_SEC).toFixed(3));
      out.extended++;
    }
  }

  /* Rule 6 — never two in one place, never more than two at once. Most important first. */
  const accepted: Element[] = [];
  const byImportance = elements
    .filter((e) => !e.el.disabled)
    .slice()
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.el.start - b.el.start || a.el.id.localeCompare(b.el.id));
  for (const e of byImportance) {
    if (userEdited(e)) {
      accepted.push(e);
      continue;
    }
    const concurrent = accepted.filter((a) => overlaps(a.el, e.el));
    if (concurrent.some((a) => a.region === e.region && (a.track === "text" || e.track === "text"))) {
      switchOff(e, "same_place_same_time", out);
      continue;
    }
    if (concurrent.length >= MAX_TEXTS_AT_ONCE) {
      switchOff(e, "too_much_text_at_once", out);
      continue;
    }
    accepted.push(e);
  }
  out.kept = accepted.length;
  return out;
}

/** One line for the render log. */
export function formatTextDirection(videoId: number, d: TextDirection): string {
  const reasons = new Map<string, number>();
  for (const x of d.disabled) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
  const why = [...reasons.entries()].map(([r, n]) => `${r}=${n}`).join(" ");
  return (
    `[Graphics] on-screen text video=${videoId} kept=${d.kept} off=${d.disabled.length}` +
    (why ? ` (${why})` : "") +
    ` converted=${d.converted.length} extended=${d.extended}`
  );
}
