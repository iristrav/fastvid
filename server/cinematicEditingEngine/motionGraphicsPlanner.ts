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
import { WORLD_LOCATIONS, mentionsLocationKeyword } from "../cinematicMotion/locationMap";
import type { Scene } from "../pipeline/types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { MotionGraphicInstruction } from "./types";

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
  const match = text.match(/([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|k|K|M|B|bn|million|billion|thousand|trillion)?/);
  if (!match) return null;
  const digits = match[2]!.replace(/,/g, "");
  const value = parseFloat(digits);
  if (Number.isNaN(value)) return null;
  const dot = digits.indexOf(".");
  return {
    value,
    suffix: match[3] ?? "",
    prefix: match[1] ?? "",
    decimals: dot < 0 ? 0 : Math.min(3, digits.length - dot - 1),
    token: match[2]!,
  };
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
 * OCTOBER 2026 — the two sides of "A versus B" as short labels: the last words before the
 * connector and the first words after it, at most four each, stopping at a clause break. "In 1960
 * West Berlin versus East Berlin, the gap grew" → "West Berlin" | "East Berlin". Too long or empty
 * on either side: no comparison.
 */
export function comparisonSides(leftRaw: string, rightRaw: string): { left: string; right: string } | null {
  const tidy = (s: string) => s.replace(/^[\s,;:—-]+|[\s,;:.!?—-]+$/g, "").trim();
  const leftClause = tidy(leftRaw.split(/[,;:—]/).pop() ?? "");
  const rightClause = tidy(rightRaw.split(/[,;:.!?—]/)[0] ?? "");
  const drop = /^(in|on|at|by|the|a|an|and|but|of|from|to|\d{4})$/i;
  const leftWords = leftClause.split(/\s+/).filter(Boolean);
  while (leftWords.length > 4 || (leftWords.length > 1 && drop.test(leftWords[0]!))) leftWords.shift();
  const rightWords = rightClause.split(/\s+/).filter(Boolean).slice(0, 4);
  while (rightWords.length > 1 && drop.test(rightWords[rightWords.length - 1]!)) rightWords.pop();
  const left = leftWords.join(" ");
  const right = rightWords.join(" ");
  if (!left || !right || left.length > 32 || right.length > 32) return null;
  return { left, right };
}

/**
 * OCTOBER 2026 — the figure a sentence states, as a counter can show it: a currency amount, a
 * number with a scale word or a percentage, or a whole number of at least 100 that is not a year.
 * The word after it ("people", "dollars") is its caption when it is a plain lower-case word.
 */
export function statFromSentence(text: string): { callout: string; caption: string } | null {
  const re = /([$€£])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(%|(?:percent|million|billion|thousand|trillion|bn)\b))?(?:\s+(dollars|euros|pounds)\b)?(?:\s+([a-z]{3,})\b)?/g;
  for (const m of text.matchAll(re)) {
    const digits = m[2]!.replace(/,/g, "");
    const value = parseFloat(digits);
    if (!Number.isFinite(value)) continue;
    const isYear = /^(1[5-9]|20)\d{2}$/.test(m[2]!) && !m[1] && !m[3];
    if (isYear) continue;
    const scale = m[3] === "percent" ? "%" : m[3] ?? "";
    if (!m[1] && !scale && value < 100) continue;
    const currency = m[1] ?? (m[4] === "dollars" ? "$" : m[4] === "euros" ? "€" : m[4] === "pounds" ? "£" : "");
    const noun = m[5] && !/^(and|the|for|from|with|that|than|into|over|after|before|in|of|to|by|on|at|was|were|is|are)$/.test(m[5]) ? m[5] : "";
    return { callout: `${currency}${m[2]}${scale ? (scale === "%" ? "%" : ` ${scale}`) : ""}`, caption: noun };
  }
  return null;
}

function findWorldLocation(text: string): { loc: (typeof WORLD_LOCATIONS)[number]; keyword: string } | null {
  const lower = text.toLowerCase();
  for (const loc of WORLD_LOCATIONS) {
    const keyword = loc.keywords.find((kw) => mentionsLocationKeyword(lower, kw));
    if (keyword) return { loc, keyword };
  }
  return null;
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

  /**
   * OCTOBER 2026 — the script-built scenes never carry a `statCallout` (it is written as ""), so a
   * sentence that says "Musk bought Twitter for 44 billion dollars" got no counter. When the scene
   * has none, the sentence's own figure is used — see `statFromSentence`; never a year, never a
   * small count, never a number the sentence does not say.
   */
  /** A sentence that states a series gets the chart, not a counter of its first value. */
  const ownStat = scene?.statCallout || yearSeriesFromText(intent.spokenText) ? null : statFromSentence(intent.spokenText);
  const statCallout = scene?.statCallout || ownStat?.callout || "";
  if (statCallout) {
    const parsed = parseNumericStat(statCallout);
    /**
     * OCTOBER 2026 — the scene's stat belongs under the sentence that SAYS it. The showcase render
     * counted to 140 under three sentences in a row because every beat of the scene got it.
     */
    if (parsed && statSpokenInBeat(statCallout, intent.spokenText)) {
      if (parsed.suffix === "%") {
        out.push(
          graphic(
            "progress_bar",
            { toValue: Math.min(100, parsed.value), suffix: "%", label: statCallout, anchorWord: parsed.token },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${statCallout}") is a percentage — shown as a filling progress bar.`
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
              label: statCallout,
              /** OCTOBER 2026 — "$3.5 billion" counts to $3.5 billion, on the word that says it. */
              ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
              decimals: parsed.decimals,
              anchorWord: parsed.token,
              ...(ownStat?.caption ? { caption: ownStat.caption } : {}),
            },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${statCallout}") is a number — animated as a counting-up statistic.`
          )
        );
      }
    }
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

  /**
   * OCTOBER 2026 — a sentence that names two or more years ("between 1961 and 1989") is a stretch
   * of time: a timeline of exactly those years, nothing in between. A sentence that pairs each
   * year with a value is a series and gets the chart below instead.
   */
  const yearsSaid = [...new Set([...intent.spokenText.matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((m) => m[1]!))];
  if (yearsSaid.length >= 2 && !yearSeriesFromText(intent.spokenText) && !out.some((g) => g.graphicType === "timeline")) {
    out.push(
      graphic(
        "timeline",
        { events: yearsSaid.slice(0, 5).map((year) => ({ year, label: "" })), anchorWord: yearsSaid[0] },
        beatVoiceStartSec,
        Math.max(3.5, Math.min(beatVoiceDurationSec, 5)),
        `Narration names ${yearsSaid.length} years (${yearsSaid.join(", ")}) — drawn as a timeline of exactly those years.`
      )
    );
  }

  /**
   * OCTOBER 2026 — "from A to B": a change the sentence states, drawn as before → after when both
   * sides are short phrases (not figures, not years — those are the counter's and the chart's).
   */
  const fromTo = intent.spokenText.match(/\bfrom\s+(?:an?\s+|the\s+)?([a-z][a-z' -]{2,40}?)\s+(?:to|into)\s+(?:an?\s+|the\s+)?([a-z][a-z' -]{2,40}?)(?=[,.;!?]|$)/i);
  if (fromTo && !COMPARISON_SPLIT_RE.test(intent.spokenText)) {
    const sides = comparisonSides(fromTo[1]!, fromTo[2]!);
    if (sides && !/\d/.test(sides.left + sides.right)) {
      out.push(
        graphic(
          "comparison",
          { leftLabel: sides.left, rightLabel: sides.right, connector: "→", label: `${sides.left} → ${sides.right}` },
          beatVoiceStartSec,
          Math.max(3, Math.min(beatVoiceDurationSec, 4.5)),
          `Narration states a change ("from ${sides.left} to ${sides.right}") — drawn as before → after.`
        )
      );
    }
  }

  const comparisonMatch = intent.spokenText.match(COMPARISON_SPLIT_RE);
  if (comparisonMatch) {
    const [leftRaw, rightRaw] = intent.spokenText.split(COMPARISON_SPLIT_RE);
    /** OCTOBER 2026 — the two things compared, not the half-sentences around them (see `comparisonSides`). */
    const sides = comparisonSides(leftRaw ?? "", rightRaw ?? "");
    if (sides) {
      const { left, right } = sides;
      out.push(
        graphic(
          "comparison",
          { leftLabel: left, rightLabel: right, connector: "VS", label: `${left} vs ${right}` },
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
  /** OCTOBER 2026 — "In the East, …" is a direction, not a place to put on a card. */
  const bareDirection = /^(the\s+)?(north|south|east|west|eastern|western|northern|southern)$/i.test(namedPlace ?? "");
  if (!location && namedPlace && !bareDirection) {
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

  return out;
}
