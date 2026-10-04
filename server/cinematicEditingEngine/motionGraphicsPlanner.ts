/** Cinematic Editing Engine — Motion Graphics Planner (Phase 4).
 *
 *  Decides which motion-graphic overlays apply to a beat and describes them (position, data,
 *  timing) — never renders them, per "support future motion graphics... do not render them
 *  yet, only describe them in the EDL."
 *
 *  Deliberately scoped to graphic types visualDirector/ (Directive) doesn't already own:
 *  progress_bar, chart, highlight_box, arrow, animated_icon are new here. statistic_counter,
 *  map, timeline, and comparison mirror visualDirector's counter/map_marker/timeline/comparison
 *  Directive kinds — not duplicated logic, just the same editorial idea expressed as a Phase 4
 *  instruction rather than wired through visualDirector's own live directScene()/directVideo().
 *  The map graphic reuses cinematicMotion/locationMap.ts's WORLD_LOCATIONS keyword-matched
 *  geocode table directly instead of re-deriving coordinates.
 *
 *  A beat can have zero, one, or several motion graphics — this returns an array, same
 *  convention as CaptionPlanner.
 */
import { WORLD_LOCATIONS } from "../cinematicMotion/locationMap";
import type { Scene } from "../pipeline/types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { MotionGraphicInstruction } from "./types";
import { graphicIsRenderable } from "../graphicsVocabulary";
import { graphicLabel, rendererGraphicType } from "../edlToTimeline";
import { subjectWords } from "../youtubeNonFootage";

/** The renderer's answer for one planned graphic, under the name and label the timeline gives it. */
export function plannedGraphicIsDrawable(g: Pick<MotionGraphicInstruction, "data"> & { graphicType: string }): boolean {
  const type = rendererGraphicType(g.graphicType);
  return graphicIsRenderable(type, g.data, graphicLabel(type, g.data) ?? null);
}

const COMPARISON_SPLIT_RE = /\s+(?:vs\.?|versus|compared to)\s+/i;
const CHART_SIGNALS = ["growth", "increase", "decline", "decrease", "trend", "sales", "revenue", "market share", "rate rose", "rate fell"];
const ARROW_SIGNALS = ["points to", "shows", "reveals", "indicates", "highlights", "demonstrates"];

/**
 * OCTOBER 2026 — the number as the script wrote it: its value, its decimals ("3.5" keeps one), a
 * currency sign in front, its unit behind, and the token itself — the word the graphic waits for.
 */
export function parseNumericStat(
  text: string
): { value: number; suffix: string; prefix: string; decimals: number; token: string } | null {
  /**
   * GRAPHICS FIX — the unit is a whole word: "1945 Berlin" is a year before a city, never "1945B".
   * "percent" is the spoken spelling of "%".
   */
  const match = text.match(
    /([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:(%|k|K|M|B|bn|million|billion|thousand|trillion|percent)(?![\p{L}\p{N}]))?/u
  );
  if (!match) return null;
  const digits = match[2]!.replace(/,/g, "");
  const value = parseFloat(digits);
  if (Number.isNaN(value)) return null;
  const dot = digits.indexOf(".");
  return {
    value,
    suffix: match[3] === "percent" ? "%" : (match[3] ?? ""),
    prefix: match[1] ?? "",
    decimals: dot < 0 ? 0 : Math.min(3, digits.length - dot - 1),
    token: match[2]!,
  };
}

/**
 * AUDIT RC3 — does this sentence state a quantity, or how one moved? A number with a unit or a
 * currency ("40 percent", "$3.5 billion" — `parseNumericStat`), a series over years, or a word that
 * only describes a measured change: this planner's own `CHART_SIGNALS`, and the verbs and nouns of
 * the same kind ("soared", "doubled", "market value"). Topic-neutral; a bare year is not a quantity.
 */
const QUANTITY_WORDS = [
  ...CHART_SIGNALS,
  "market value", "market cap", "valuation", "profit", "profits", "prices", "inflation",
  "soared", "surged", "skyrocketed", "exploded", "plunged", "plummeted", "doubled", "tripled", "halved",
];
export function statesAQuantity(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  /** Every number the sentence says, not only the first: "By 1945, 70 million people…" */
  for (const m of t.matchAll(/[$€£]?\s?\d/g)) {
    const stat = parseNumericStat(t.slice(m.index));
    if (stat && (stat.suffix || stat.prefix)) return true;
  }
  if (yearSeriesFromText(t)) return true;
  const lower = ` ${t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")} `;
  return QUANTITY_WORDS.some((w) => lower.includes(` ${w} `));
}

/**
 * GRAPHICS FIX — the first figure the sentence itself SAYS with a unit or a currency ("10%",
 * "70 million", "$2.4 billion"), as the words that say it. A bare number or a year is not a figure.
 * Nothing is added: the label is the sentence's own spelling of the figure.
 */
export function spokenStat(text: string | undefined): (ReturnType<typeof parseNumericStat> & { label: string }) | null {
  const t = (text ?? "").trim();
  for (const m of t.matchAll(/[$€£]?\s?\d/g)) {
    const stat = parseNumericStat(t.slice(m.index));
    if (!stat || !(stat.suffix || stat.prefix)) continue;
    const unit = stat.suffix === "%" ? "%" : stat.suffix ? ` ${stat.suffix}` : "";
    return { ...stat, label: `${stat.prefix}${stat.token}${unit}` };
  }
  return null;
}

/**
 * OCTOBER 2026 — whether a beat speaks the number a scene's stat callout carries. A callout with
 * no number in it is not checked (it is a phrase, not a figure).
 */
export function statSpokenInBeat(callout: string, spokenText: string): boolean {
  const parsed = parseNumericStat(callout);
  if (!parsed) return true;
  const digits = (s: string) => s.replace(/[^\d.]/g, "");
  const want = digits(parsed.token);
  return spokenText.split(/\s+/).some((w) => digits(w).replace(/\.$/, "") === want);
}

const UNIT_WORD = "(million|billion|thousand|trillion|bn|%)?";
const NUMBER = "([$€£])?(\\d[\\d,]*(?:\\.\\d+)?)";
const YEAR = "((?:1[5-9]|20)\\d{2})";

/**
 * OCTOBER 2026 — a series the narration itself states: two or more years, each with a number, in
 * the same unit ("from 3 million in 2007 to 8 billion in 2023" is two units and is not a series;
 * "1.2 billion in 2015, 2.4 billion in 2019 and 3.1 billion in 2023" is). Only the script's own
 * numbers; nothing is interpolated, estimated or filled in. Fewer than two points, no chart.
 */
export function yearSeriesFromText(
  text: string
): { series: Array<{ label: string; value: number }>; unit: string; prefix: string; decimals: number; firstToken: string } | null {
  const pairs: Array<{ year: string; value: number; unit: string; prefix: string; decimals: number; token: string; at: number }> = [];
  const push = (year: string, prefix: string | undefined, digits: string, unit: string | undefined, at: number) => {
    const clean = digits.replace(/,/g, "");
    const value = parseFloat(clean);
    if (!Number.isFinite(value) || /^(1[5-9]|20)\d{2}$/.test(clean)) return;
    const dot = clean.indexOf(".");
    pairs.push({ year, value, unit: (unit ?? "").toLowerCase(), prefix: prefix ?? "", decimals: dot < 0 ? 0 : clean.length - dot - 1, token: digits, at });
  };
  const numberThenYear = new RegExp(`${NUMBER}\\s*${UNIT_WORD}[^.;\\d]{0,30}?\\b(?:in|by)\\s+${YEAR}`, "gi");
  for (const m of text.matchAll(numberThenYear)) push(m[4]!, m[1], m[2]!, m[3], m.index ?? 0);
  const yearThenNumber = new RegExp(`\\b(?:in|by)\\s+${YEAR},?\\s+(?:[a-z]+\\s+){0,5}?${NUMBER}\\s*${UNIT_WORD}`, "gi");
  for (const m of text.matchAll(yearThenNumber)) push(m[1]!, m[2], m[3]!, m[4], m.index ?? 0);
  const byYear = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs.sort((a, b) => a.at - b.at)) if (!byYear.has(p.year)) byYear.set(p.year, p);
  const points = [...byYear.values()].sort((a, b) => Number(a.year) - Number(b.year));
  if (points.length < 2) return null;
  const unit = points[0]!.unit;
  if (points.some((p) => p.unit !== unit)) return null;
  return {
    series: points.map((p) => ({ label: p.year, value: p.value })),
    unit,
    prefix: points[0]!.prefix,
    decimals: Math.min(3, Math.max(...points.map((p) => p.decimals))),
    firstToken: [...byYear.values()][0]!.token,
  };
}

/** Past-tense verbs a clause fragment ends on; "-ed" covers the regular ones. */
const CLAUSE_END_VERBS = new Set([
  "ran", "was", "were", "had", "did", "went", "came", "took", "made", "said", "got", "began", "became",
  "fell", "rose", "grew", "held", "stood", "led", "left", "saw", "gave", "found", "built", "won", "lost",
  "met", "sent", "kept", "broke", "spoke", "told", "brought", "thought", "is", "are", "has",
]);

/** OCTOBER 2026 — whether a VisualIntent event label names an event rather than a clause fragment. */
export function isEventName(label: string): boolean {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const last = words[words.length - 1]!.toLowerCase();
  if (/\p{Lu}/u.test(label) && words.length > 1 && !CLAUSE_END_VERBS.has(last)) return true;
  return !CLAUSE_END_VERBS.has(last) && !/ed$/.test(last);
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * OCTOBER 2026 — a chart's title from the sentence itself: the measure it names right before its
 * first figure ("Its population was 79.8 million…" → "Population") and the subject the beat is
 * about ("Population of Germany"). Nothing is added that the narration does not say; with neither,
 * the title is empty and the chart shows only its axis.
 */
export function chartTitle(spokenText: string, subject?: string): string {
  const measure = spokenText.match(
    /\b([a-z]+)\s+(?:was|were|is|are|reached|hit|stood at|grew to|rose to|fell to|of)\s+(?:about\s+|around\s+|nearly\s+|over\s+)?[$€£]?\d/i
  )?.[1];
  const what = measure && !/^(it|its|this|that|they|there|which|and|but)$/i.test(measure) ? titleCase(measure.toLowerCase()) : "";
  const who = subject?.trim() ? titleCase(subject.trim().toLowerCase()) : "";
  if (what && who && !what.toLowerCase().includes(who.toLowerCase())) return `${what} of ${who}`;
  return what || who;
}

/**
 * GRAPHICS FIX — a map keyword is a whole word or phrase, never a fragment of one: "uk" is in
 * "the UK", not in "Duke"; "gaza" is not in "magazine".
 */
function saysWholeWord(lowerText: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(lowerText);
}

function findWorldLocation(text: string): { loc: (typeof WORLD_LOCATIONS)[number]; keyword: string } | null {
  const lower = text.toLowerCase();
  for (const loc of WORLD_LOCATIONS) {
    const keyword = loc.keywords.find((kw) => saysWholeWord(lower, kw));
    if (keyword) return { loc, keyword };
  }
  return null;
}

/** GRAPHICS FIX — whether the text names a place the world map can draw (whole words only). */
export function namesAMappablePlace(text: string): boolean {
  return findWorldLocation(text) !== null;
}

function graphic(
  graphicType: MotionGraphicInstruction["graphicType"],
  data: Record<string, unknown>,
  startSec: number,
  durationSec: number,
  reason: string
): MotionGraphicInstruction {
  return { graphicType, data, startSec, durationSec, reason };
}

/** Builds every motion-graphic instruction that applies to this beat. */
export function planMotionGraphics(
  intent: VisualIntent,
  scene: Scene | undefined,
  beatVoiceStartSec: number,
  beatVoiceDurationSec: number
): MotionGraphicInstruction[] {
  const out: MotionGraphicInstruction[] = [];
  const dur = Math.max(2, Math.min(beatVoiceDurationSec, 3.5));

  if (scene?.statCallout) {
    const parsed = parseNumericStat(scene.statCallout);
    /**
     * OCTOBER 2026 — the scene's stat belongs under the sentence that SAYS it. The showcase render
     * counted to 140 under three sentences in a row because every beat of the scene got it.
     */
    if (parsed && statSpokenInBeat(scene.statCallout, intent.spokenText)) {
      if (parsed.suffix === "%") {
        out.push(
          graphic(
            "progress_bar",
            { toValue: Math.min(100, parsed.value), suffix: "%", label: scene.statCallout, anchorWord: parsed.token },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${scene.statCallout}") is a percentage — shown as a filling progress bar.`
          )
        );
      } else {
        out.push(
          graphic(
            "statistic_counter",
            {
              fromValue: 0,
              toValue: parsed.value,
              suffix: parsed.suffix,
              label: scene.statCallout,
              /** OCTOBER 2026 — "$3.5 billion" counts to $3.5 billion, on the word that says it. */
              ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
              decimals: parsed.decimals,
              anchorWord: parsed.token,
            },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${scene.statCallout}") is a number — animated as a counting-up statistic.`
          )
        );
      }
    }
  }

  /**
   * GRAPHICS FIX — the figure the sentence itself says, when the scene's callout did not already
   * put one under it. Same payload, same anchor rule (it appears on the word that says it); a
   * sentence stating a series gets the line chart below instead.
   */
  const spoken = spokenStat(intent.spokenText);
  const statPlanned = out.some((g) => g.graphicType === "progress_bar" || g.graphicType === "statistic_counter");
  if (spoken && !statPlanned && !yearSeriesFromText(intent.spokenText)) {
    out.push(
      spoken.suffix === "%"
        ? graphic(
            "progress_bar",
            { toValue: Math.min(100, spoken.value), suffix: "%", label: spoken.label, anchorWord: spoken.token },
            beatVoiceStartSec,
            dur,
            `Narration states a percentage ("${spoken.label}") — shown as a filling progress bar.`
          )
        : graphic(
            "statistic_counter",
            {
              fromValue: 0,
              toValue: spoken.value,
              suffix: spoken.suffix,
              label: spoken.label,
              ...(spoken.prefix ? { prefix: spoken.prefix } : {}),
              decimals: spoken.decimals,
              anchorWord: spoken.token,
            },
            beatVoiceStartSec,
            dur,
            `Narration states a figure ("${spoken.label}") — animated as a counting-up statistic.`
          )
    );
  }

  const found = findWorldLocation([intent.visualLocation, intent.spokenText].join(" "));
  const location = found?.loc ?? null;
  if (found && location) {
    out.push(
      graphic(
        "map",
        {
          locationName: location.name,
          normX: location.normX,
          normY: location.normY,
          /** OCTOBER 2026 — the real place: drawn on the real map, its country highlighted, the camera moving in. */
          lon: location.lon,
          lat: location.lat,
          iso3: location.iso3,
          anchorWord: found.keyword.split(/\s+/)[0],
        },
        beatVoiceStartSec,
        /** The camera needs time to travel and the place to be read: a little longer than a card. */
        Math.max(3, Math.min(beatVoiceDurationSec, 4.5)),
        `Beat references a recognized location ("${location.name}") — shown on the world map, the camera moving in to it.`
      )
    );
  }

  /**
   * OCTOBER 2026 — only a NAMED event goes on a timeline card ("Battle of Berlin"). The showcase
   * render put "1961 — border ran" on screen: a fragment of "the border that ran through Berlin".
   * A label that ends in a verb is a clause, not an event; the year is then shown by the date card.
   */
  if (intent.events.length > 0 && intent.historicalContext.trim() && isEventName(intent.events[0] ?? "")) {
    const yearMatch = intent.visualTime.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
    out.push(
      graphic(
        "timeline",
        { events: [{ year: yearMatch?.[0] ?? intent.visualTime, label: intent.events[0] }] },
        beatVoiceStartSec,
        dur,
        `Beat marks a dated historical event ("${intent.events[0]}") — placed on a timeline graphic.`
      )
    );
  }

  const comparisonMatch = intent.spokenText.match(COMPARISON_SPLIT_RE);
  if (comparisonMatch) {
    const [left, right] = intent.spokenText.split(COMPARISON_SPLIT_RE);
    if (left && right) {
      out.push(
        graphic(
          "comparison",
          { leftLabel: left.trim().slice(-60), rightLabel: right.trim().slice(0, 60), connector: "VS" },
          beatVoiceStartSec,
          dur,
          `Narration draws an explicit comparison ("${comparisonMatch[0].trim()}") — shown as a side-by-side graphic.`
        )
      );
    }
  }

  /**
   * OCTOBER 2026 — a chart only when the narration states the numbers. The years and values are
   * the script's own; the chart draws them on a real axis (`line_chart`, the renderer's own name).
   */
  const series = yearSeriesFromText(intent.spokenText);
  const chartSignal = CHART_SIGNALS.find((s) => intent.spokenText.toLowerCase().includes(s));
  if (series) {
    const unit = series.unit === "%" ? "%" : series.unit;
    out.push(
      graphic(
        "line_chart",
        {
          title: chartTitle(intent.spokenText, intent.visualSubject),
          series: series.series,
          ...(unit ? { suffix: unit } : {}),
          ...(series.prefix ? { prefix: series.prefix } : {}),
          decimals: series.decimals,
          anchorWord: series.firstToken,
        },
        beatVoiceStartSec,
        Math.max(3.5, Math.min(beatVoiceDurationSec, 6)),
        `Narration states ${series.series.length} values over time (${series.series.map((p) => p.label).join(", ")}) — drawn as a line chart.`
      )
    );
  } else if (chartSignal) {
    out.push(
      graphic(
        "chart",
        { keyword: chartSignal, label: intent.spokenText },
        beatVoiceStartSec,
        dur,
        `Narration references a trend/data concept ("${chartSignal}") — a chart visualizes it better than narration alone.`
      )
    );
  }

  if (intent.objects.length > 0) {
    out.push(
      graphic(
        "highlight_box",
        { label: intent.objects[0] },
        beatVoiceStartSec,
        Math.min(beatVoiceDurationSec, 2.5),
        `Beat names a specific object ("${intent.objects[0]}") in frame — a highlight box draws the eye to it.`
      )
    );
  }

  const arrowSignal = ARROW_SIGNALS.find((s) => intent.visualAction.toLowerCase().includes(s));
  if (arrowSignal) {
    out.push(
      graphic(
        "arrow",
        { label: intent.objects[0] ?? intent.visualSubject },
        beatVoiceStartSec,
        Math.min(beatVoiceDurationSec, 2),
        `Beat's action ("${intent.visualAction}") matches "${arrowSignal}" — an arrow points out what's being indicated.`
      )
    );
  }

  const brandOrCompany = intent.brands[0] ?? intent.companies[0];
  if (brandOrCompany) {
    out.push(
      graphic(
        "animated_icon",
        { label: brandOrCompany },
        beatVoiceStartSec,
        Math.min(beatVoiceDurationSec, 2),
        `Beat names a specific brand/company ("${brandOrCompany}") — a small animated icon reinforces it visually.`
      )
    );
  }

  /* ═════════ GRAPHICS MASTER FIX — the four the renderer could always draw ═════════ */

  /**
   * A person the beat NAMES gets their name under them. The most ordinary graphic a documentary
   * has, and until now the planner had no way to ask for it.
   *
   * `intent.people` is extracted from the beat, so the name is the beat's own word — never the
   * title's, never the model's guess about who is on screen. A company or brand the same beat
   * names becomes the subtitle line, which is exactly the "ELON MUSK / CEO — Tesla" shape; when
   * the beat names no organisation the card is just the name, rather than inventing a role.
   */
  const person = intent.people[0]?.trim();
  if (person) {
    out.push(
      graphic(
        "lower_third",
        {
          name: person,
          label: person,
          ...(brandOrCompany ? { subtitle: brandOrCompany } : {}),
          anchorWord: person.split(/\s+/)[0],
        },
        beatVoiceStartSec,
        /** Long enough to read a name and a role without outstaying the sentence. */
        Math.max(2.5, Math.min(beatVoiceDurationSec, 4)),
        `Beat names a person ("${person}")${brandOrCompany ? ` and an organisation ("${brandOrCompany}")` : ""} — identified with a lower third.`
      )
    );
  }

  /**
   * A YEAR the beat states, when it is not already carried by the timeline graphic above.
   *
   * The timeline needs an EVENT plus historical context; a beat that simply says "in 2019" has
   * neither and previously got nothing. The guard is what keeps this from doubling up: if the
   * timeline fired, the date is already on screen.
   */
  const plannedTimeline = out.some((g) => g.graphicType === "timeline");
  const spokenYear = `${intent.visualTime} ${intent.spokenText}`.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (!plannedTimeline && spokenYear) {
    out.push(
      graphic(
        "date_card",
        { text: spokenYear[0], anchorWord: spokenYear[0] },
        beatVoiceStartSec,
        Math.max(2, Math.min(beatVoiceDurationSec, 3)),
        `Beat states a year ("${spokenYear[0]}") with no dated event to place on a timeline — shown as a date card.`
      )
    );
  }

  /**
   * A place the beat names that the world map does not know.
   *
   * `findWorldLocation` only matches the curated coordinate list, so every other real place — a
   * building, a street, a region — produced no graphic at all. A location card needs no
   * coordinates. Guarded against the map for the same reason as the date card.
   */
  const namedPlace = intent.visualLocation?.trim();
  if (!location && namedPlace) {
    out.push(
      graphic(
        "location_card",
        { locationName: namedPlace, label: namedPlace, anchorWord: namedPlace.split(/[\s,]+/)[0] },
        beatVoiceStartSec,
        Math.max(2, Math.min(beatVoiceDurationSec, 3)),
        `Beat names a place ("${namedPlace}") that is not on the world-map list — shown as a location card.`
      )
    );
  }

  /**
   * A quotation the narration actually contains.
   *
   * Only a real quoted span counts: the text between the quotation marks in the beat's own words.
   * Nothing is paraphrased into a quote card, and a span too short to be a sentence is skipped
   * rather than shown as an empty-looking card.
   */
  const quoted = intent.spokenText.match(/[""«]([^""»]{12,180})[""»]/);
  if (quoted?.[1]) {
    out.push(
      graphic(
        "quote",
        { text: quoted[1].trim(), ...(person ? { label: person } : {}) },
        beatVoiceStartSec,
        /** A quote is read, not glanced at — longer than a label, still inside the beat. */
        Math.max(3, Math.min(beatVoiceDurationSec, 5)),
        `Narration quotes ${person ? `${person} ` : ""}directly — shown as a quote card.`
      )
    );
  }

  /**
   * AUDIT RC2 — only what this build can draw is planned. `highlight_box` without a region and
   * `chart`, `arrow`, `animated_icon`, `comparison` (no component) were planned on every render and
   * dropped later (video 627: 14 planned, 5 drawn). Asked with the timeline's own translation and
   * the renderer's own predicate, so a graphic planned here is a graphic the renderer will draw.
   */
  return out.filter(plannedGraphicIsDrawable);
}

/* ═════════ GRAPHICS FIX — a graphic as the sentence's own picture ═════════ */

/**
 * The planner's graphics that can stand as a sentence's PICTURE, not only lie over one: the data
 * graphics (a chart, a counter, a ring) and the real map. A name, a year, a place card or a quote is
 * text and stays an overlay.
 */
const PRIMARY_DATA_GRAPHICS = ["line_chart", "statistic_counter", "progress_bar"] as const;
const PRIMARY_MAP_GRAPHICS = ["map"] as const;

/**
 * GRAPHICS FIX — the graphic that becomes a sentence's picture when sourcing found none.
 *
 * Asked only for a sentence with NO approved picture; footage and photos always come first. The
 * sentence's MediaForm decides which kind may stand in: DATA_VISUALIZATION a data graphic, MAP a
 * map, GRAPHIC either. The graphic itself is the planner's own, so it carries only what the sentence
 * says and is drawable by construction (`plannedGraphicIsDrawable`); a form with no drawable
 * graphic here (PROCESS, DOCUMENT, …) gets none. It fills the sentence's whole window.
 */
export function primaryGraphicFor(
  intent: VisualIntent,
  scene: Scene | undefined,
  preferredForms: readonly string[],
  startSec: number,
  durationSec: number
): PictureGraphic | null {
  if (!(durationSec > 0)) return null;
  const wants = new Set(preferredForms);
  const types: string[] = [
    ...(wants.has("DATA_VISUALIZATION") || wants.has("GRAPHIC") ? PRIMARY_DATA_GRAPHICS : []),
    ...(wants.has("MAP") || wants.has("GRAPHIC") ? PRIMARY_MAP_GRAPHICS : []),
  ];
  if (!types.length) return null;
  const planned = planMotionGraphics(intent, scene, startSec, durationSec);
  for (const type of types) {
    const g = planned.find((p) => p.graphicType === type);
    if (g) {
      return {
        ...g,
        startSec,
        durationSec,
        reason: `${g.reason} No picture was approved for this sentence, so this graphic is its picture.`,
      };
    }
  }
  return null;
}

/* ═════════ GRAPHICS FIX — an extracted entity is checked before it goes on screen ═════════ */

const LOCATIVE_BEFORE = /\b(?:in|at|from|to|near|across|into|over|outside|inside)\s+(?:the\s+)?$/i;

/** Whether `name` is written in `text` right after a word that places something ("in Qatar"). */
function placedByPreposition(name: string, text: string): boolean {
  const at = text.indexOf(name);
  return at > 0 && LOCATIVE_BEFORE.test(text.slice(0, at));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A person name a lower third may carry: two to four words, each capitalised; not a company,
 * brand or object the same sentence names ("Tesla"), and not a place the sentence puts something
 * in ("in San Francisco"). Unsure is no.
 */
export function plausiblePersonName(name: string, text: string, notPersons: readonly string[] = []): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every((w) => /^\p{Lu}/u.test(w))) return false;
  if (notPersons.some((n) => sameName(n, name))) return false;
  return !placedByPreposition(name, text);
}

/**
 * A place a location card or caption may carry: one the world map knows ("Battle of Berlin"), or one
 * written after a word that places something ("in Qatar", "at Waterloo"); never something else the
 * sentence names (an event like "Macworld", a person, a company). "Soviet troops" and "the Duke of
 * Wellington" name no place. Unsure is no.
 */
export function plausiblePlace(place: string, text: string, otherEntities: readonly string[] = []): boolean {
  const p = place.trim();
  if (!p || !/^\p{Lu}/u.test(p)) return false;
  if (otherEntities.some((n) => sameName(n, p))) return false;
  return namesAMappablePlace(p) || placedByPreposition(p, text);
}

/**
 * An event a timeline card may carry: a named one ("Battle of Berlin", "Marshall Plan"), not a
 * clause fragment ("border ran") and not a lower-case phrase the extractor took from the sentence
 * ("trillion dollars", "modern world").
 */
export function plausibleEventName(label: string): boolean {
  return /\p{Lu}/u.test(label) && isEventName(label);
}

/* ═════════ GENERATED_IMAGE_FALLBACK — the last picture a sentence can have ═════════ */

/**
 * A graphic that is a sentence's PICTURE: one of the planner's own, or the drawn title card of the
 * last fallback. `chapter_card` is deliberately not in `MotionGraphicType` — it is never planned as
 * an overlay, only drawn here as the picture of a sentence nothing else could illustrate.
 */
export type PictureGraphic = Omit<MotionGraphicInstruction, "graphicType"> & {
  graphicType: MotionGraphicInstruction["graphicType"] | "chapter_card";
};

/** The log and reason marker of a picture Remotion drew because no source had one. */
export const GENERATED_IMAGE_FALLBACK = "GENERATED_IMAGE_FALLBACK";

/**
 * GENERATED_IMAGE_FALLBACK — a picture Remotion draws for a sentence no source could illustrate.
 *
 * Asked last: only for a sentence with no approved picture from YouTube, the archive, the open
 * sources or stock, and only when neither a data graphic nor a map could stand in. Remotion draws
 * designs, not photographs, so the picture is the renderer's own designed title card
 * (`chapter_card`) carrying what the sentence is ABOUT, in this order: the named event it states
 * ("Marshall Plan"), the person it names, or its VisualIntent subject — the last one only when it
 * shares a subject word with the sentence, so the card can never be about something the voice does
 * not say. A year the sentence states is added. Nothing else is written; with no such subject, or
 * only production words ("documentary broll scene"), there is no card.
 */
export function generatedImageFallbackFor(
  intent: VisualIntent,
  startSec: number,
  durationSec: number
): PictureGraphic | null {
  if (!(durationSec > 0)) return null;
  const said = new Set(subjectWords(intent.spokenText));
  const event = intent.events[0]?.trim() ?? "";
  const person = intent.people[0]?.trim() ?? "";
  const subject = subjectWords(intent.visualSubject ?? "").filter(Boolean);
  const subjectSaid = subject.some((w) => said.has(w));
  const main =
    (event && plausibleEventName(event) ? event : "") ||
    person ||
    (subjectSaid ? titleCase(subject.slice(0, 5).join(" ")) : "");
  if (!main.trim()) return null;
  const year = `${intent.visualTime} ${intent.spokenText}`.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)?.[0];
  const title = year && !main.includes(year) ? `${main} · ${year}` : main;
  const g: PictureGraphic = {
    graphicType: "chapter_card",
    data: { title, label: title },
    startSec,
    durationSec,
    reason:
      `${GENERATED_IMAGE_FALLBACK}: no source had a picture for this sentence — Remotion draws a title ` +
      `card of what it is about ("${title}").`,
  };
  return plannedGraphicIsDrawable(g) ? g : null;
}
