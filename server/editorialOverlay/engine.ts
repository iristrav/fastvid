/**
 * Editorial Overlay Engine — beat-level, type-first overlay planner.
 *
 * Design principles:
 * 1. Type-first: determine WHAT kind of overlay before deciding what text to show.
 * 2. Beat-level: every beat is evaluated independently; overlays merge when the
 *    same entity continues across consecutive beats.
 * 3. No video title: text comes exclusively from beat/scene metadata.
 * 4. Lifecycle: max MAX_OVERLAY_SEC per overlay, new one when content changes.
 * 5. Explainability: every decision is logged with reason + metadata source.
 */

import type { EditorialOverlayType, BeatOverlay, SceneOverlayPlan, VideoOverlayPlan } from "./types";
import type { RetrievalContract, VisualGoal } from "../documentaryPlanningEngine";
import type { BeatVisualDirective, NarrativeAct, VideoBlueprint } from "../masterDocumentaryDirector";
import type { DocumentaryPlan } from "../documentaryPlanningEngine";

// ── Constants ─────────────────────────────────────────────────────────────────

/** An overlay may stay on screen at most this many seconds. */
const MAX_OVERLAY_SEC = 5.5;
/** An overlay must be visible at least this many seconds to be worth showing. */
const MIN_OVERLAY_SEC = 2.0;
/** Fade in + fade out time (cosmetic, not enforced here — renderer handles it). */
const FADE_DUR = 0.4;

// ── Entity extraction ─────────────────────────────────────────────────────────

const PERSON_TITLE_RE = /\b(President|Prime Minister|General|Admiral|Chancellor|Emperor|King|Queen|CEO|Colonel|Captain|Major|Führer|Dictator|Minister|Senator|Governor|Lord|Sir|Dr\.?|Professor)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;

// Match capitalized 2-3 word sequences that look like person names (no leading title needed)
const BARE_PERSON_RE = /\b([A-Z][a-z]{1,14})\s+([A-Z][a-z]{1,14})(?:\s+([A-Z][a-z]{1,14}))?\b/g;

// Known historical figures — matched case-insensitively in beat text
const KNOWN_PERSONS = new Set([
  "hitler", "adolf hitler", "napoleon", "napoleon bonaparte", "churchill", "winston churchill",
  "stalin", "joseph stalin", "mussolini", "benito mussolini", "roosevelt", "franklin roosevelt",
  "eisenhower", "dwight eisenhower", "caesar", "julius caesar", "augustus", "nero",
  "cleopatra", "alexander", "alexander the great", "genghis khan", "attila",
  "lincoln", "abraham lincoln", "washington", "george washington", "jefferson",
  "marx", "karl marx", "lenin", "vladimir lenin", "trotsky", "mao", "mao zedong",
  "goebbels", "himmler", "göring", "rommel", "eisenhower",
]);

// Event patterns
const EVENT_RE = /\b((?:battle|siege|fall|invasion|attack|bombing|massacre|revolution|uprising|coup|assassination|liberation|annexation|occupation|war|treaty|conference|agreement|signing)\s+(?:of\s+)?[A-Z][a-zA-Z\s]{2,30})/gi;
const OPERATION_RE = /\boperation\s+([A-Za-z\s]{3,25})/gi;

// Location patterns
const LOCATION_RE = /\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,2})\b/g;
const KNOWN_PLACES = new Set([
  "berlin", "paris", "london", "moscow", "rome", "warsaw", "stalingrad", "normandy",
  "pearl harbor", "hiroshima", "nagasaki", "auschwitz", "dachau", "dunkirk",
  "versailles", "munich", "nuremberg", "dresden", "hamburg", "vienna", "budapest",
  "amsterdam", "brussels", "athens", "cairo", "jerusalem", "baghdad", "tokyo",
  "beijing", "shanghai", "washington", "new york", "los angeles",
  "germany", "france", "britain", "england", "russia", "soviet union", "ussr",
  "italy", "spain", "poland", "austria", "hungary", "czechoslovakia",
  "japan", "china", "america", "united states", "europe", "africa", "asia",
]);

// Year / era patterns
const YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/g;
const ERA_RE = /\b((?:early|mid|late)\s+)?(\d{4}s|(?:19|20)\d{2}s)\b/gi;

// Quote patterns
const QUOTE_RE = /[""]([^""]{15,120})[""]|'([^']{15,120})'/;

// Statistic patterns
const STAT_RE = /\b(\d[\d,]*(?:\.\d+)?(?:\s*(?:million|billion|thousand|percent|%))?(?:\s*(?:people|soldiers|deaths|casualties|dollars|km|miles))?)\b/;

// ── Text utilities ─────────────────────────────────────────────────────────────

/** Semantic line break: split a title into two roughly equal lines at a word boundary. */
export function semanticLineBreak(text: string, maxCharsLine1 = 28): [string, string?] {
  if (text.length <= maxCharsLine1) return [text];

  // Try to break at ~50% of length, near a word boundary
  const mid = Math.floor(text.length / 2);
  let bestBreak = -1;
  let bestDist = Infinity;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestBreak = i;
      }
    }
  }

  if (bestBreak <= 0) return [text.slice(0, maxCharsLine1).trim()];

  const line1 = text.slice(0, bestBreak).trim();
  const line2 = text.slice(bestBreak + 1).trim();

  // If either line is very long, just truncate
  const l1 = line1.slice(0, 32).trim();
  const l2 = line2.slice(0, 32).trim();
  return [l1, l2 || undefined];
}

function extractYear(text: string): string | null {
  YEAR_RE.lastIndex = 0;
  const m = YEAR_RE.exec(text);
  return m ? m[1] : null;
}

function extractEra(text: string): string | null {
  ERA_RE.lastIndex = 0;
  const m = ERA_RE.exec(text);
  if (m) return m[0].trim();
  const yr = extractYear(text);
  if (yr) return yr;
  return null;
}

function extractPersonName(text: string): { name: string; role?: string } | null {
  // Check known persons first
  const lower = text.toLowerCase();
  const knownArr = Array.from(KNOWN_PERSONS);
  for (let ki = 0; ki < knownArr.length; ki++) {
    const known = knownArr[ki];
    if (lower.includes(known)) {
      const name = known.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      return { name };
    }
  }

  // Try titled persons
  PERSON_TITLE_RE.lastIndex = 0;
  const m = PERSON_TITLE_RE.exec(text);
  if (m) return { name: m[2], role: m[1] };

  // Try bare 2-word capitalized names
  BARE_PERSON_RE.lastIndex = 0;
  const bm = BARE_PERSON_RE.exec(text);
  if (bm) {
    const candidate = bm[0];
    // Skip if it's a place name or common word
    if (!KNOWN_PLACES.has(candidate.toLowerCase())) {
      return { name: candidate };
    }
  }

  return null;
}

function extractEventName(text: string): string | null {
  // Operation
  OPERATION_RE.lastIndex = 0;
  const op = OPERATION_RE.exec(text);
  if (op) return `OPERATION ${op[1].trim().toUpperCase()}`;

  // Battle/event
  EVENT_RE.lastIndex = 0;
  const ev = EVENT_RE.exec(text);
  if (ev) return ev[1].trim().toUpperCase();

  return null;
}

function extractLocation(text: string, visualCue?: string): string | null {
  const sources = [visualCue ?? "", text];
  const placesArr = Array.from(KNOWN_PLACES);
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    if (!src) continue;
    const lower = src.toLowerCase();
    for (let pi = 0; pi < placesArr.length; pi++) {
      const place = placesArr[pi];
      if (lower.includes(place)) {
        return place.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
    }
  }

  // Try regex — 2+ consecutive Title-Case words
  for (const src of sources) {
    if (!src) continue;
    LOCATION_RE.lastIndex = 0;
    const m = src.match(/\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+)\b/);
    if (m && m[1].split(" ").length >= 2) return m[1];
  }

  return null;
}

function extractStat(text: string): string | null {
  const m = STAT_RE.exec(text);
  return m ? m[1] : null;
}

function extractQuote(text: string): string | null {
  const m = QUOTE_RE.exec(text);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

// ── Overlay type determination ─────────────────────────────────────────────────

/**
 * Map VisualGoal → EditorialOverlayType.
 * This is the core "type-first" logic.
 */
function overlayTypeFromVisualGoal(
  goal: VisualGoal,
  act: NarrativeAct,
  beatText: string
): EditorialOverlayType | null {
  switch (goal) {
    case "introduce_person":   return "person_introduction";
    case "introduce_location": return "location";
    case "establish_era":      return "date_era";
    case "explain_event":
    case "build_tension":
    case "show_consequence":   return "historical_event";
    case "emotional_moment":
    case "reveal_information": return "historical_event";
    case "ending":
    case "reflection":         return "closing_statement";
    case "transition":
      if (act === "intro") return "chapter_title";
      return null; // skip pure transitions
    case "context":
    case "setup":              return "context_label";
    case "aftermath":          return "historical_event";
    case "callback":           return null; // callbacks don't need new overlays
    default:                   return null;
  }
}

/**
 * For beats without a contract/directive, infer overlay type from content.
 */
function inferOverlayTypeFromText(
  beatText: string,
  visualCue: string,
  act: NarrativeAct,
  beatIndexInScene: number
): EditorialOverlayType | null {
  // Opening beats of intro act → chapter title
  if (act === "intro" && beatIndexInScene === 0) return "chapter_title";
  if (act === "resolution") return "closing_statement";

  // Content-driven
  if (extractQuote(beatText)) return "quote";
  if (extractEventName(beatText)) return "historical_event";
  if (extractPersonName(beatText)) return "person_introduction";

  const era = extractEra(beatText);
  const loc = extractLocation(beatText, visualCue);
  if (era && !loc) return "date_era";
  if (loc && !era) return "location";
  if (era && loc) return "location"; // prefer location when both present

  if (extractStat(beatText)) return "statistic";

  return null; // no overlay for this beat
}

// ── Text generation ───────────────────────────────────────────────────────────

interface OverlayText {
  line1: string;
  line2?: string;
}

function generateOverlayText(
  type: EditorialOverlayType,
  beatText: string,
  visualCue: string,
  chapterTitle?: string,
  sectionTitle?: string
): OverlayText | null {
  switch (type) {
    case "chapter_title": {
      const src = (chapterTitle || sectionTitle || "").trim().toUpperCase();
      if (src && src.length > 2) {
        const [l1, l2] = semanticLineBreak(src);
        return { line1: l1, line2: l2 };
      }
      // Derive from beat text — extract the main noun phrase
      const event = extractEventName(beatText);
      if (event) {
        const [l1, l2] = semanticLineBreak(event);
        return { line1: l1, line2: l2 };
      }
      const person = extractPersonName(beatText);
      if (person) {
        const [l1, l2] = semanticLineBreak(`THE ${person.name.toUpperCase()}`);
        return { line1: l1, line2: l2 };
      }
      return null;
    }

    case "person_introduction": {
      const p = extractPersonName(beatText);
      if (!p) return null;
      const name = p.name.toUpperCase();
      // Find role/title from beat text
      const roleMatch = beatText.match(/\b(?:was|became|served as|appointed|elected|crowned|born)\s+(?:as\s+)?(?:the\s+)?([A-Za-z\s]{3,30}?)(?:\s+of\s+[A-Z]|[,.])/);
      const role = p.role ?? roleMatch?.[1]?.trim() ?? undefined;
      const year = extractYear(beatText);
      const [l1, l2] = semanticLineBreak(name);
      if (l2) return { line1: l1, line2: l2 };
      return {
        line1: name,
        line2: role
          ? (year ? `${role} • ${year}` : role)
          : (year ?? undefined),
      };
    }

    case "historical_event": {
      const event = extractEventName(beatText);
      if (!event) return null;
      const year = extractYear(beatText);
      const loc = extractLocation(beatText, visualCue);
      const [l1, l2] = semanticLineBreak(event);
      if (l2) return { line1: l1, line2: l2 };
      const context = [loc, year].filter(Boolean).join(" • ");
      return { line1: event, line2: context || undefined };
    }

    case "location": {
      const loc = extractLocation(beatText, visualCue);
      if (!loc) return null;
      const year = extractYear(beatText);
      return { line1: loc.toUpperCase(), line2: year ?? undefined };
    }

    case "date_era": {
      const era = extractEra(beatText);
      if (!era) return null;
      return { line1: era.toUpperCase() };
    }

    case "quote": {
      const q = extractQuote(beatText);
      if (!q) return null;
      // Keep it short — max 60 chars
      const trimmed = q.length > 60 ? q.slice(0, 57).trim() + "…" : q;
      const [l1, l2] = semanticLineBreak(`"${trimmed}"`);
      return { line1: l1, line2: l2 };
    }

    case "statistic": {
      const stat = extractStat(beatText);
      if (!stat) return null;
      return { line1: stat.toUpperCase() };
    }

    case "closing_statement": {
      // Use the final part of the beat text — last sentence
      const sentences = beatText.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
      const last = sentences[sentences.length - 1] ?? "";
      if (last.length < 5) return null;
      const [l1, l2] = semanticLineBreak(last.toUpperCase().slice(0, 60));
      return { line1: l1, line2: l2 };
    }

    case "context_label": {
      const event = extractEventName(beatText);
      if (event) {
        const [l1, l2] = semanticLineBreak(event.slice(0, 50));
        return { line1: l1, line2: l2 };
      }
      const loc = extractLocation(beatText, visualCue);
      if (loc) {
        const year = extractYear(beatText);
        return { line1: loc.toUpperCase(), line2: year ?? undefined };
      }
      return null;
    }

    default:
      return null;
  }
}

// ── Beat interface ────────────────────────────────────────────────────────────

interface BeatMeta {
  index: number;
  text: string;
  holdSec: number;
  voiceStartSec?: number;
  voiceEndSec?: number;
  powerWord?: string;
  visualDescription?: string;
}

interface SceneMeta {
  index: number;
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
  chapterTitle?: string;
  sectionTitle?: string;
  duration: number;
  beats: BeatMeta[];
}

// ── Per-beat overlay decision ─────────────────────────────────────────────────

interface BeatDecision {
  beatIndex: number;
  startSec: number;
  endSec: number;
  type: EditorialOverlayType;
  text: OverlayText;
  reason: string;
  metadataUsed: string[];
}

function decideBeatOverlay(
  beat: BeatMeta,
  scene: SceneMeta,
  sceneIndex: number,
  contract: RetrievalContract | null,
  directive: BeatVisualDirective | null,
  startSec: number,
  endSec: number
): BeatDecision | null {
  const metadataUsed: string[] = [];
  let type: EditorialOverlayType | null = null;
  let reason = "";

  // Determine narrative act
  const act: NarrativeAct = directive?.narrativeAct ?? (sceneIndex === 0 ? "intro" : "conflict");

  // overlayPriority="none" from blueprint → skip
  if (directive?.overlayPriority === "none") {
    return null;
  }

  // Type from RetrievalContract.visualGoal (highest confidence)
  if (contract?.visualGoal) {
    const fromGoal = overlayTypeFromVisualGoal(contract.visualGoal, act, beat.text);
    if (fromGoal) {
      type = fromGoal;
      reason = `visualGoal=${contract.visualGoal}`;
      metadataUsed.push("RetrievalContract.visualGoal");
    }
  }

  // Type from blueprint TextOverlayPlan (second priority)
  if (!type && directive?.overlayPriority === "high") {
    type = inferOverlayTypeFromText(beat.text, scene.visualCue ?? "", act, beat.index);
    if (type) {
      reason = `blueprintPriority=high, inferred from content`;
      metadataUsed.push("BeatVisualDirective.overlayPriority");
    }
  }

  // Content-based inference (fallback)
  if (!type) {
    type = inferOverlayTypeFromText(beat.text, scene.visualCue ?? "", act, beat.index);
    if (type) {
      reason = `content-inferred (act=${act})`;
      metadataUsed.push("beat.text");
    }
  }

  if (!type) return null;

  // Generate text
  const text = generateOverlayText(
    type,
    beat.text,
    scene.visualCue ?? "",
    scene.chapterTitle,
    scene.sectionTitle
  );
  if (!text) return null;

  metadataUsed.push(...(contract ? ["RetrievalContract.mustContain"] : []));
  if (scene.visualCue) metadataUsed.push("scene.visualCue");

  return { beatIndex: beat.index, startSec, endSec, type, text, reason, metadataUsed };
}

// ── Overlay merging ───────────────────────────────────────────────────────────

/**
 * Two consecutive beat decisions can be merged into one overlay when:
 * - Same overlay type
 * - Same line1 text (same entity/event)
 * - Combined duration doesn't exceed MAX_OVERLAY_SEC
 */
function canMerge(a: BeatDecision, b: BeatDecision): boolean {
  if (a.type !== b.type) return false;
  if (a.text.line1 !== b.text.line1) return false;
  if (b.endSec - a.startSec > MAX_OVERLAY_SEC) return false;
  return true;
}

// ── Scene planner ─────────────────────────────────────────────────────────────

/** Track which entities have already been introduced (video-wide). */
interface IntroducedEntities {
  persons: Set<string>;
  locations: Set<string>;
  events: Set<string>;
}

function planSceneOverlays(
  scene: SceneMeta,
  documentaryPlan: DocumentaryPlan | null | undefined,
  blueprint: VideoBlueprint | null | undefined,
  introduced: IntroducedEntities
): SceneOverlayPlan {
  if (!scene.beats.length) {
    return { sceneIndex: scene.index, overlays: [] };
  }

  // Calculate beat timings (cumulative within scene)
  const beatTimings: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const beat of scene.beats) {
    const start = cursor;
    const dur = beat.voiceEndSec != null && beat.voiceStartSec != null
      ? Math.max(beat.holdSec, beat.voiceEndSec - beat.voiceStartSec)
      : beat.holdSec;
    const end = Math.min(cursor + dur, scene.duration - 0.1);
    beatTimings.push({ start, end });
    cursor = end;
  }

  // Get per-beat overlay decisions
  const decisions: Array<BeatDecision | null> = [];
  for (let i = 0; i < scene.beats.length; i++) {
    const beat = scene.beats[i];
    const { start, end } = beatTimings[i];
    const contract = documentaryPlan?.contracts.get(`s${scene.index}b${beat.index}`) ?? null;
    const directive = blueprint?.beatDirectives.get(`${scene.index}_${beat.index}`) ?? null;
    const duration = end - start;
    if (duration < MIN_OVERLAY_SEC) {
      decisions.push(null);
      continue;
    }
    decisions.push(decideBeatOverlay(beat, scene, scene.index, contract, directive, start, end));
  }

  // Filter decisions where entity was already introduced (avoid repetition)
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;
    const key = d.text.line1;
    if (d.type === "person_introduction") {
      if (introduced.persons.has(key)) { decisions[i] = null; continue; }
    }
    if (d.type === "location") {
      if (introduced.locations.has(key)) { decisions[i] = null; continue; }
    }
    if (d.type === "historical_event") {
      if (introduced.events.has(key)) { decisions[i] = null; continue; }
    }
  }

  // Merge consecutive same decisions into one overlay
  const overlays: BeatOverlay[] = [];
  let i = 0;
  while (i < decisions.length) {
    const d = decisions[i];
    if (!d) { i++; continue; }

    // Try to extend this overlay over following beats
    let j = i + 1;
    while (j < decisions.length) {
      const next = decisions[j];
      if (!next || !canMerge(d, next)) break;
      j++;
    }

    const firstBeat = scene.beats[i];
    const lastBeat = scene.beats[j - 1];
    const startSec = beatTimings[i].start + FADE_DUR;
    const rawEnd = beatTimings[j - 1].end;
    const endSec = Math.min(rawEnd, beatTimings[i].start + MAX_OVERLAY_SEC) - FADE_DUR;

    if (endSec - startSec >= MIN_OVERLAY_SEC) {
      const overlay: BeatOverlay = {
        type: d.type,
        line1: d.text.line1,
        line2: d.text.line2,
        startBeatIndex: firstBeat.index,
        endBeatIndex: lastBeat.index,
        startSec,
        endSec,
        reason: d.reason,
        metadataUsed: d.metadataUsed,
      };
      overlays.push(overlay);

      // Register as introduced
      const key = d.text.line1;
      if (d.type === "person_introduction") introduced.persons.add(key);
      if (d.type === "location") introduced.locations.add(key);
      if (d.type === "historical_event") introduced.events.add(key);
    }

    i = j;
  }

  // Log decisions
  if (overlays.length > 0) {
    for (const ov of overlays) {
      console.log(
        `[EditorialOverlay] s${scene.index}b${ov.startBeatIndex}-b${ov.endBeatIndex} ` +
        `Type: ${ov.type} | "${ov.line1}"${ov.line2 ? ` / "${ov.line2}"` : ""} | ` +
        `${ov.startSec.toFixed(1)}s→${ov.endSec.toFixed(1)}s | ` +
        `reason: ${ov.reason} | meta: [${ov.metadataUsed.join(", ")}]`
      );
    }
  } else {
    console.log(`[EditorialOverlay] s${scene.index}: no overlays (${scene.beats.length} beats evaluated)`);
  }

  return { sceneIndex: scene.index, overlays };
}

// ── Video-level planner (public) ──────────────────────────────────────────────

export function planEditorialOverlays(
  scenes: SceneMeta[],
  documentaryPlan: DocumentaryPlan | null | undefined,
  blueprint: VideoBlueprint | null | undefined
): VideoOverlayPlan {
  const introduced: IntroducedEntities = {
    persons: new Set(),
    locations: new Set(),
    events: new Set(),
  };

  const scenePlans = scenes.map(scene =>
    planSceneOverlays(scene, documentaryPlan, blueprint, introduced)
  );

  const totalOverlays = scenePlans.reduce((n, sp) => n + sp.overlays.length, 0);
  console.log(
    `[EditorialOverlay] Plan complete: ${totalOverlays} overlay(s) across ${scenes.length} scene(s)`
  );

  return { scenes: scenePlans };
}
