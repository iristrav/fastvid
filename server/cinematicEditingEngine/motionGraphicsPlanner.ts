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

const COMPARISON_SPLIT_RE = /\s+(?:vs\.?|versus|compared to)\s+/i;
const CHART_SIGNALS = ["growth", "increase", "decline", "decrease", "trend", "sales", "revenue", "market share", "rate rose", "rate fell"];
const ARROW_SIGNALS = ["points to", "shows", "reveals", "indicates", "highlights", "demonstrates"];

function parseNumericStat(text: string): { value: number; suffix: string } | null {
  const match = text.match(/([\d.,]+)\s*(%|k|K|M|B|million|billion|thousand)?/);
  if (!match) return null;
  const value = parseFloat(match[1]!.replace(/,/g, ""));
  if (Number.isNaN(value)) return null;
  return { value, suffix: match[2] ?? "" };
}

function findWorldLocation(text: string): (typeof WORLD_LOCATIONS)[number] | null {
  const lower = text.toLowerCase();
  return WORLD_LOCATIONS.find((loc) => loc.keywords.some((kw) => lower.includes(kw))) ?? null;
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
    if (parsed) {
      if (parsed.suffix === "%") {
        out.push(
          graphic(
            "progress_bar",
            { toValue: Math.min(100, parsed.value), suffix: "%", label: scene.statCallout },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${scene.statCallout}") is a percentage — shown as a filling progress bar.`
          )
        );
      } else {
        out.push(
          graphic(
            "statistic_counter",
            { fromValue: 0, toValue: parsed.value, suffix: parsed.suffix, label: scene.statCallout },
            beatVoiceStartSec,
            dur,
            `Scene's stat callout ("${scene.statCallout}") is a number — animated as a counting-up statistic.`
          )
        );
      }
    }
  }

  const location = findWorldLocation([intent.visualLocation, intent.spokenText].join(" "));
  if (location) {
    out.push(
      graphic(
        "map",
        { locationName: location.name, normX: location.normX, normY: location.normY },
        beatVoiceStartSec,
        dur,
        `Beat references a recognized location ("${location.name}") — shown as a pulsing marker on a world map.`
      )
    );
  }

  if (intent.events.length > 0 && intent.historicalContext.trim()) {
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

  const chartSignal = CHART_SIGNALS.find((s) => intent.spokenText.toLowerCase().includes(s));
  if (chartSignal) {
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
        { name: person, label: person, ...(brandOrCompany ? { subtitle: brandOrCompany } : {}) },
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
        { text: spokenYear[0] },
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
        { locationName: namedPlace, label: namedPlace },
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
