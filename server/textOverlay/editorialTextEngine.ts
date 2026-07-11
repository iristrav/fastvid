/**
 * Editorial On-Screen Text Engine
 *
 * Determines the overlay TYPE per beat, generates documentary-convention titles/subtitles
 * via LLM, applies intelligent line-breaking, and logs explainability per overlay.
 *
 * Overlay text is NEVER copied verbatim from beat text or video title.
 */

import { invokeLLM } from "../_core/llm";
import type { TextOverlay, TextOverlayType, TextAnimation, TextPosition } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EditorialOverlayKind =
  | "chapter"    // Act / section break — bold headline
  | "person"     // Named individual introduced for first time
  | "location"   // Geographical place + optional date
  | "event"      // Named historical event
  | "quote"      // Spoken attribution
  | "era"        // Time period / epoch
  | "statistic"  // Number / data point
  | "date"       // Specific date (day-month-year)
  | "none";      // No overlay needed

export type EditorialOverlay = {
  kind: EditorialOverlayKind;
  line1: string;          // Upper line (≤ 32 chars recommended)
  line2?: string;         // Lower line — only when line1 is a natural split
  subtitle?: string;      // Small annotation below (year, title, location)
  startTime: number;
  endTime: number;
  // Explainability
  reason: string;         // Why this kind was chosen
  templateUsed: string;   // Which template pattern matched
  llmGenerated: boolean;  // true = LLM wrote the text; false = rule-based
};

export type BeatEditorialInput = {
  beatText: string;          // Narration text for this beat
  beatIndex: number;
  sceneIndex: number;
  videoTitle: string;
  voiceStartSec: number;
  voiceEndSec: number;
  sceneDurationSec: number;
  previousOverlayKinds?: EditorialOverlayKind[];  // Avoid repetition
};

// ── Constants ─────────────────────────────────────────────────────────────────

// Words that must never be split across lines (phrase-level atoms)
const LOCKED_PHRASES = [
  /prime minister/i,
  /secretary of state/i,
  /united states/i,
  /united kingdom/i,
  /soviet union/i,
  /nazi germany/i,
  /world war (i{1,3}|one|two)/i,
  /cold war/i,
  /iron curtain/i,
  /d-day/i,
  /total control/i,
  /final solution/i,
  /new world order/i,
];

// Era keywords that strongly suggest an "era" overlay
const ERA_SIGNALS = [
  /\b(the\s+)?(\d{4})s\b/i,
  /\b(early|mid|late)\s+\d{4}s?\b/i,
  /\b(post|pre)-war\b/i,
  /\binter-?war\b/i,
  /\bweimar republic\b/i,
  /\bcold war era\b/i,
  /\bvictorian\b/i,
  /\bgilded age\b/i,
  /\bdepression era\b/i,
];

// Statistic signals
const STAT_SIGNALS = [
  /\b\d[\d,]*\s*(million|billion|thousand|percent|%|km|miles|troops|soldiers|deaths|casualties|people)\b/i,
  /\bone in (every\s+)?\d+/i,
];

// Date signals
const DATE_SIGNALS = [
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i,
  /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/i,
];

const PERSON_TITLE_RE = /\b(president|prime minister|chancellor|general|admiral|colonel|emperor|king|queen|dictator|führer|marshal|secretary)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi;
const YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/g;
const LOCATION_RE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;
const CHAPTER_RE = /^(chapter|part|section|act)\s+\d+/i;
const EVENT_RE = /\b(operation|battle|siege|invasion|landing|massacre|treaty|agreement|pact|revolution|coup|assassination)\s+(?:of\s+)?([A-Za-z\s]{3,30})/i;
const QUOTE_RE = /[""](.{20,120})[""]|(?:he|she|they|it)\s+said[,:]?\s+"(.{10,80})"/i;

// ── Kind classifier (rule-based, no LLM) ──────────────────────────────────────

export function classifyBeatKind(
  beatText: string,
  previousKinds: EditorialOverlayKind[] = []
): { kind: EditorialOverlayKind; reason: string } {
  const recent = new Set(previousKinds.slice(-3));

  if (CHAPTER_RE.test(beatText)) {
    return { kind: "chapter", reason: "explicit chapter/part/section marker in beat text" };
  }

  if (QUOTE_RE.test(beatText)) {
    return { kind: "quote", reason: "direct quote detected (quotation marks or 'said' attribution)" };
  }

  if (DATE_SIGNALS.some(re => re.test(beatText))) {
    const hasEvent = EVENT_RE.test(beatText);
    if (hasEvent) return { kind: "event", reason: "specific date + named event → event overlay" };
    return { kind: "date", reason: "specific calendar date detected" };
  }

  if (STAT_SIGNALS.some(re => re.test(beatText))) {
    return { kind: "statistic", reason: "numeric statistic with unit detected" };
  }

  if (EVENT_RE.test(beatText)) {
    return { kind: "event", reason: "named military/political/historical event detected" };
  }

  if (ERA_SIGNALS.some(re => re.test(beatText))) {
    return { kind: "era", reason: "era/decade/epoch language detected" };
  }

  // Person — only if not shown recently
  if (!recent.has("person")) {
    const persons = extractPersons(beatText);
    if (persons.length > 0) {
      return { kind: "person", reason: `named person with title detected: ${persons[0].title} ${persons[0].name}` };
    }
  }

  // Location — only if not shown recently
  const years = extractYears(beatText);
  const locs = extractCapitalizedPlaces(beatText);
  if (!recent.has("location") && locs.length > 0) {
    if (years.length > 0) {
      return { kind: "location", reason: `location "${locs[0]}" + year ${years[0]} → location/date combo` };
    }
    return { kind: "location", reason: `location "${locs[0]}" detected` };
  }

  if (years.length > 0 && !recent.has("era") && !recent.has("date")) {
    return { kind: "era", reason: `year ${years[0]} with no stronger signal → minimal era overlay` };
  }

  return { kind: "none", reason: "no sufficiently strong signal for an overlay" };
}

// ── Line-break engine ─────────────────────────────────────────────────────────

/**
 * Intelligently splits a headline into at most 2 lines.
 *
 * Rules (in priority order):
 * 1. Never split a locked phrase across lines
 * 2. Prefer breaking at conjunctions / prepositions: AND, BUT, WHEN, THAT, TO, IN, OF, WITH, FOR
 * 3. Prefer roughly equal line lengths (Δ ≤ 8 chars)
 * 4. Never break a word
 * 5. Max 40 chars per line (safe title zone at 1080p with 88px font)
 */
export function splitHeadline(text: string): { line1: string; line2?: string } {
  const words = text.trim().toUpperCase().split(/\s+/);
  const full = words.join(" ");

  if (full.length <= 32 || words.length <= 2) {
    return { line1: full };
  }

  // Connective words where it's natural to break
  const BREAK_WORDS = new Set(["AND", "BUT", "WHEN", "THAT", "WHICH", "WHERE", "WHY", "HOW",
    "TO", "IN", "OF", "WITH", "FOR", "AT", "BY", "AFTER", "BEFORE", "DURING", "AGAINST"]);

  // Find candidate break positions — after word i means line1 = words[0..i]
  type Candidate = { i: number; score: number };
  const candidates: Candidate[] = [];

  for (let i = 1; i < words.length - 1; i++) {
    const line1 = words.slice(0, i + 1).join(" ");
    const line2 = words.slice(i + 1).join(" ");

    if (line1.length > 40 || line2.length > 40) continue;

    // Reject if this split would sever a locked phrase
    const fullUpTo = words.slice(0, i + 2).join(" ");
    const lockedViolation = LOCKED_PHRASES.some(re => {
      const match = full.match(re);
      if (!match) return false;
      const phraseStart = full.indexOf(match[0]);
      const phraseEnd = phraseStart + match[0].length;
      const splitPos = line1.length; // char position of the split
      return phraseStart < splitPos && phraseEnd > splitPos;
    });
    if (lockedViolation) continue;

    // Score: prefer breaking BEFORE connective words, prefer equal lengths
    const nextWord = words[i + 1];
    const connectiveBonus = BREAK_WORDS.has(nextWord) ? 20 : 0;
    const lengthBalance = Math.abs(line1.length - line2.length);
    const score = connectiveBonus - lengthBalance;

    candidates.push({ i, score });
  }

  if (candidates.length === 0) {
    // Forced break at midpoint if no candidate found
    const mid = Math.ceil(words.length / 2);
    return {
      line1: words.slice(0, mid).join(" "),
      line2: words.slice(mid).join(" "),
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    line1: words.slice(0, best.i + 1).join(" "),
    line2: words.slice(best.i + 1).join(" "),
  };
}

// ── LLM text generator ────────────────────────────────────────────────────────

type LLMOverlayResult = {
  line1: string;
  line2?: string;
  subtitle?: string;
};

const TEMPLATE_PROMPTS: Record<Exclude<EditorialOverlayKind, "none">, string> = {
  chapter: `Generate a documentary chapter title for the following narration beat.
Rules: ALL CAPS. Max 6 words total across both lines. Do NOT copy the narration verbatim. Use strong, thematic, active language.
Return JSON: { "line1": "...", "line2": "..." (optional), "subtitle": "..." (optional, e.g. year or episode number) }`,

  person: `Generate a documentary lower-third name card for the person introduced in this narration beat.
Rules: line1 = FULL NAME IN CAPS (2-4 words). subtitle = their title/role (e.g. "Chancellor of Germany" or "Supreme Commander, Allied Forces"). line2 = omit.
Return JSON: { "line1": "PERSON NAME", "subtitle": "Title or Role" }`,

  location: `Generate a documentary location card for this narration beat.
Rules: line1 = PLACE NAME IN CAPS. subtitle = year or date if present (e.g. "1941" or "June 1944"). line2 = secondary location or qualifier (e.g. "EASTERN FRONT") if needed.
Return JSON: { "line1": "LOCATION", "line2": "..." (optional), "subtitle": "year" (optional) }`,

  event: `Generate a documentary event title card for this narration beat.
Rules: ALL CAPS. Max 8 words. Name the event concisely and dramatically (e.g. "OPERATION BARBAROSSA", "THE FALL OF BERLIN"). Do NOT copy the narration.
Return JSON: { "line1": "EVENT NAME", "line2": "..." (optional), "subtitle": "year or date" (optional) }`,

  quote: `Generate a documentary quote attribution card for this narration beat.
Rules: line1 = a SHORT punchy excerpt from the quote (max 8 words, ALL CAPS). subtitle = speaker name + role (e.g. "Adolf Hitler, 1933").
Return JSON: { "line1": "QUOTE EXCERPT", "subtitle": "Speaker Name, Year" }`,

  era: `Generate a documentary era/time-period card for this narration beat.
Rules: If a single year suffices, return only line1 = "1941". If a period is better, return line1 = "THE 1930S" or "POST-WAR EUROPE". subtitle = optional short qualifier.
Return JSON: { "line1": "ERA", "subtitle": "..." (optional) }`,

  statistic: `Generate a documentary statistic card for this narration beat.
Rules: line1 = the NUMBER formatted dramatically (e.g. "6 MILLION", "70%"). line2 = what it refers to in caps (e.g. "LIVES LOST"). subtitle = source/year if present.
Return JSON: { "line1": "NUMBER", "line2": "WHAT IT MEASURES", "subtitle": "source or year" (optional) }`,

  date: `Generate a documentary date card for this narration beat.
Rules: line1 = the date formatted as "1 SEPTEMBER 1939" or "JUNE 6, 1944" (ALL CAPS). line2 = optional event name at that date (e.g. "GERMANY INVADES POLAND"). subtitle = omit.
Return JSON: { "line1": "DATE", "line2": "EVENT" (optional) }`,
};

async function generateOverlayTextLLM(
  kind: Exclude<EditorialOverlayKind, "none">,
  beatText: string,
  videoTitle: string
): Promise<LLMOverlayResult | null> {
  const systemPrompt = TEMPLATE_PROMPTS[kind];
  const userMsg = `Video title: "${videoTitle}"\n\nNarration beat: "${beatText}"`;

  try {
    const llmPromise = invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      maxTokens: 120,
      responseFormat: { type: "json_object" },
    });

    // Hard 6s timeout per beat — prevents one slow LLM call from blowing the pipeline budget
    const result = await Promise.race([
      llmPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("editorial LLM timeout")), 6_000)),
    ]);

    const rawText = result.choices?.[0]?.message?.content ?? "";
    const parsed = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    if (!parsed?.line1 || typeof parsed.line1 !== "string") return null;

    return {
      line1: String(parsed.line1).trim().toUpperCase().slice(0, 50),
      line2: parsed.line2 ? String(parsed.line2).trim().toUpperCase().slice(0, 50) : undefined,
      subtitle: parsed.subtitle ? String(parsed.subtitle).trim().slice(0, 60) : undefined,
    };
  } catch {
    return null;
  }
}

// ── Rule-based fallback generators ───────────────────────────────────────────

function fallbackText(kind: EditorialOverlayKind, beatText: string): LLMOverlayResult {
  switch (kind) {
    case "person": {
      const p = extractPersons(beatText)[0];
      if (p) return { line1: p.name.toUpperCase(), subtitle: p.title };
      return { line1: "KEY FIGURE" };
    }
    case "location": {
      const locs = extractCapitalizedPlaces(beatText);
      const years = extractYears(beatText);
      const split = splitHeadline(locs[0] ?? "LOCATION");
      return { ...split, subtitle: years[0] };
    }
    case "event": {
      const m = EVENT_RE.exec(beatText);
      if (m) {
        const name = `${m[1].toUpperCase()} OF ${m[2].trim().toUpperCase()}`;
        return splitHeadline(name);
      }
      return { line1: "KEY EVENT" };
    }
    case "era": {
      const years = extractYears(beatText);
      if (years.length === 1) return { line1: years[0] };
      if (years.length >= 2) return { line1: `${years[0]}–${years[1]}` };
      const eraMatch = beatText.match(/\b(\d{4}s)\b/);
      return { line1: eraMatch ? `THE ${eraMatch[1].toUpperCase()}` : "THE ERA" };
    }
    case "date": {
      const m = DATE_SIGNALS.reduce<RegExpExecArray | null>((acc, re) => acc ?? re.exec(beatText), null);
      return { line1: m ? m[0].toUpperCase() : "DATE" };
    }
    case "statistic": {
      const m = STAT_SIGNALS.reduce<RegExpMatchArray | null>((acc, re) => acc ?? beatText.match(re), null);
      if (m) {
        const split = splitHeadline(m[0].toUpperCase());
        return split;
      }
      return { line1: "BY THE NUMBERS" };
    }
    case "quote": {
      const m = QUOTE_RE.exec(beatText);
      const excerpt = (m?.[1] ?? m?.[2] ?? "").slice(0, 60).toUpperCase();
      return { line1: excerpt || "IN THEIR OWN WORDS" };
    }
    case "chapter": {
      const words = beatText.split(/\s+/).slice(0, 6).join(" ").toUpperCase();
      return splitHeadline(words);
    }
    default:
      return { line1: "" };
  }
}

// ── Template name resolver (for explainability) ───────────────────────────────

function templateName(kind: EditorialOverlayKind, llmUsed: boolean): string {
  const base: Record<EditorialOverlayKind, string> = {
    chapter: "CHAPTER_TITLE",
    person: "PERSON_LOWER_THIRD",
    location: "LOCATION_DATE_CARD",
    event: "EVENT_TITLE_CARD",
    quote: "QUOTE_ATTRIBUTION",
    era: "ERA_STAMP",
    statistic: "STAT_CALLOUT",
    date: "DATE_CARD",
    none: "NO_OVERLAY",
  };
  return `${base[kind]}${llmUsed ? "/LLM" : "/RULE"}`;
}

// ── Overlay timing helpers ────────────────────────────────────────────────────

function overlayTiming(
  kind: EditorialOverlayKind,
  voiceStart: number,
  voiceEnd: number,
  sceneDuration: number
): { startTime: number; endTime: number } {
  const beatDur = voiceEnd - voiceStart;
  const holdExtra = kind === "chapter" ? 1.5 : kind === "statistic" ? 1.0 : 0.5;
  const maxDur = kind === "chapter" ? 5.0 : kind === "person" ? 4.5 : 3.5;
  const desiredDur = Math.min(beatDur * 0.85 + holdExtra, maxDur);
  const startTime = Math.max(voiceStart + 0.25, 0.2);
  const endTime = Math.min(startTime + desiredDur, sceneDuration - 0.4);
  return { startTime, endTime };
}

function overlayTypeForKind(kind: EditorialOverlayKind): TextOverlayType {
  const map: Record<EditorialOverlayKind, TextOverlayType> = {
    chapter: "headline",
    person: "person",
    location: "location",
    event: "headline",
    quote: "quote",
    era: "year",
    statistic: "headline",
    date: "year",
    none: "label",
  };
  return map[kind];
}

function positionForKind(kind: EditorialOverlayKind): TextPosition {
  if (kind === "person" || kind === "location") return "bottom-left";
  return "center";
}

function animationForKind(kind: EditorialOverlayKind): TextAnimation {
  if (kind === "chapter") return "fade";
  if (kind === "quote") return "fade";
  return "fade";
}

// ── Helper extractors ─────────────────────────────────────────────────────────

function extractPersons(text: string): Array<{ title: string; name: string }> {
  const results: Array<{ title: string; name: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(PERSON_TITLE_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    results.push({ title: m[1], name: m[2] });
    if (results.length >= 2) break;
  }
  return results;
}

function extractYears(text: string): string[] {
  const matches = Array.from(text.matchAll(new RegExp(YEAR_RE.source, "g")));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) { if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } }
  return out.slice(0, 2);
}

function extractCapitalizedPlaces(text: string): string[] {
  const matches = Array.from(text.matchAll(new RegExp(LOCATION_RE.source, "g")));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const place = m[1].trim();
    // Filter out single common words
    if (place.split(" ").length < 1 || place.length < 4) continue;
    if (!seen.has(place)) { seen.add(place); out.push(place); }
  }
  return out.slice(0, 3);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Generate an editorial overlay for a single beat.
 * Returns null when no overlay is appropriate.
 */
export async function generateEditorialOverlay(
  input: BeatEditorialInput
): Promise<EditorialOverlay | null> {
  const { beatText, beatIndex, sceneIndex, videoTitle, voiceStartSec, voiceEndSec, sceneDurationSec, previousOverlayKinds = [] } = input;

  const { kind, reason } = classifyBeatKind(beatText, previousOverlayKinds);
  if (kind === "none") {
    console.log(`[Editorial] s${sceneIndex}b${beatIndex} → NO_OVERLAY: ${reason}`);
    return null;
  }

  // Attempt LLM generation
  let text: LLMOverlayResult | null = null;
  let llmUsed = false;

  text = await generateOverlayTextLLM(kind, beatText, videoTitle);
  if (text?.line1) {
    llmUsed = true;
  } else {
    text = fallbackText(kind, beatText);
  }

  if (!text.line1) return null;

  // Apply line-break engine to line1 if it needs splitting and line2 not already set
  if (!text.line2 && text.line1.length > 32) {
    const split = splitHeadline(text.line1);
    text.line1 = split.line1;
    text.line2 = split.line2;
  }

  const timing = overlayTiming(kind, voiceStartSec, voiceEndSec, sceneDurationSec);

  // Guard: skip if timing window is too short to read
  if (timing.endTime - timing.startTime < 1.2) return null;

  // Compose the text field for the renderer: join lines with newline
  const displayText = text.line2 ? `${text.line1}\n${text.line2}` : text.line1;
  const template = templateName(kind, llmUsed);

  console.log(
    `[Editorial] s${sceneIndex}b${beatIndex} → ${template}\n` +
    `  Kind:     ${kind}\n` +
    `  Reason:   ${reason}\n` +
    `  Line1:    "${text.line1}"${text.line2 ? `\n  Line2:    "${text.line2}"` : ""}` +
    `${text.subtitle ? `\n  Subtitle: "${text.subtitle}"` : ""}\n` +
    `  Timing:   ${timing.startTime.toFixed(2)}s – ${timing.endTime.toFixed(2)}s`
  );

  return {
    kind,
    line1: text.line1,
    line2: text.line2,
    subtitle: text.subtitle,
    startTime: timing.startTime,
    endTime: timing.endTime,
    reason,
    templateUsed: template,
    llmGenerated: llmUsed,
  };
}

/**
 * Convert an EditorialOverlay to the TextOverlay format used by the renderer.
 */
export function editorialToTextOverlay(e: EditorialOverlay, style: import("./types").TextOverlayStyle): TextOverlay {
  return {
    type: overlayTypeForKind(e.kind),
    text: e.line2 ? `${e.line1} / ${e.line2}` : e.line1,
    subtitle: e.subtitle,
    startTime: e.startTime,
    endTime: e.endTime,
    animation: animationForKind(e.kind),
    position: positionForKind(e.kind),
    style,
  };
}
