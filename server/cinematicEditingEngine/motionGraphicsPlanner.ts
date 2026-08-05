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

  return out;
}
