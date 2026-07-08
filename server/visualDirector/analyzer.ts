/**
 * Scene content analyzer — extracts signals from metadata without LLM calls.
 * Used by the Visual Director to understand what a scene is about.
 */
import { WORLD_LOCATIONS } from "../cinematicMotion/locationMap";

export interface SceneSignals {
  /** Named persons detected: [{ name, title }] */
  persons: Array<{ name: string; title: string }>;
  /** Numeric stats: [{ raw, value, suffix, label }] */
  stats: Array<{ raw: string; value: number; suffix: string; label: string }>;
  /** Detected world locations */
  locations: Array<{ name: string; normX: number; normY: number }>;
  /** Years mentioned in order of appearance */
  years: string[];
  /** Travel / movement detected (two locations in sequence) */
  travel: boolean;
  /** Comparison keywords detected */
  comparison: { left: string; right: string } | null;
  /** List / enumeration detected (3+ items) */
  listItems: string[];
  /** Direct quote detected */
  quote: { text: string; attribution?: string } | null;
  /** Military / war context */
  isMilitary: boolean;
  /** Scientific / technical context */
  isScience: boolean;
  /** Economic / financial context */
  isEconomy: boolean;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

const YEAR_RE = /\b(1[0-9]{3}|20[0-2][0-9])\b/g;

const PERSON_TITLE_RE =
  /\b(President|Prime Minister|Premier|Chancellor|Emperor|General|Admiral|Colonel|Captain|Commander|King|Queen|Prince|Princess|CEO|Director|Minister|Secretary|Senator|Governor|Pope|Tsar|Führer|Marshal|Field Marshal)\s+([A-Z][a-z]+(?:\s+(?:von\s+|de\s+|van\s+)?[A-Z][a-z]+)?)/gi;

const STAT_RE =
  /\b([\d][0-9,.]*)(?:\s*(?:million|billion|miljoen|miljard|trillion|biljoen|duizend|thousand))?\s*(soldiers|troops|tanks|planes|aircraft|ships|vessels|doden|slachtoffers|mensen|inwoners|casualties|victims|people|workers|%|percent|procent|\$|€|£)?\b/gi;

const VS_RE = /\b([A-Z][A-Za-z\s]{2,20})\s+(?:vs\.?|versus|vs|tegenover|against)\s+([A-Z][A-Za-z\s]{2,20})/i;

const QUOTE_RE = /[""]([^"""]{20,200})[""](?:\s*[—–-]\s*([A-Z][a-zA-Z\s.]+))?/;

const MILITARY_KW = /\b(battle|war|attack|invasion|siege|bombing|troops|soldiers|army|navy|air force|artillery|tank|aircraft|division|regiment|front|offensive|campaign|conquest|occupation|resistance|liberation|defeat|victory)\b/i;
const SCIENCE_KW  = /\b(experiment|theory|discovery|atom|molecule|gravity|quantum|evolution|dna|gene|protein|virus|bacteria|climate|carbon|energy|radiation|orbit|rocket|satellite)\b/i;
const ECONOMY_KW  = /\b(economy|gdp|inflation|recession|stock|market|trade|export|import|billion|million|currency|bank|debt|growth|unemployment|investment|profit|revenue|budget)\b/i;

const LIST_RE = /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|ten|1\.|2\.|3\.)/i;
const LIST_BULLET_RE = /[•\-–]\s+([^\n]+)/g;

// ── Extractors ────────────────────────────────────────────────────────────────

function extractPersons(text: string): Array<{ name: string; title: string }> {
  const results: Array<{ name: string; title: string }> = [];
  const seen = new Set<string>();
  PERSON_TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PERSON_TITLE_RE.exec(text)) !== null) {
    const title = m[1];
    const name  = m[2].trim();
    if (!seen.has(name)) {
      seen.add(name);
      results.push({ name, title });
    }
    if (results.length >= 3) break;
  }
  return results;
}

function extractStats(text: string): Array<{ raw: string; value: number; suffix: string; label: string }> {
  const results: Array<{ raw: string; value: number; suffix: string; label: string }> = [];
  STAT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STAT_RE.exec(text)) !== null) {
    const numStr = m[1].replace(/,/g, ".");
    const val = parseFloat(numStr);
    if (isNaN(val) || val < 2) continue;
    const suffix = m[2] ?? "";
    const mult   = /million|miljoen/i.test(m[0]) ? 1_000_000
                 : /billion|miljard/i.test(m[0]) ? 1_000_000_000
                 : /duizend|thousand/i.test(m[0]) ? 1_000
                 : 1;
    const finalVal = val * mult;
    if (finalVal > 1e12) continue;
    results.push({ raw: m[0].trim(), value: finalVal, suffix: suffix.replace(/percent|procent/i, "%"), label: m[0].trim() });
    if (results.length >= 2) break;
  }
  return results;
}

function extractLocations(text: string): Array<{ name: string; normX: number; normY: number }> {
  const hay = text.toLowerCase();
  return WORLD_LOCATIONS.filter(loc =>
    loc.keywords.some(kw => hay.includes(kw.toLowerCase()))
  ).slice(0, 2);
}

function extractYears(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  YEAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = YEAR_RE.exec(text)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function detectComparison(text: string): { left: string; right: string } | null {
  const m = VS_RE.exec(text);
  if (!m) return null;
  return { left: m[1].trim(), right: m[2].trim() };
}

function detectQuote(text: string): { text: string; attribution?: string } | null {
  const m = QUOTE_RE.exec(text);
  if (!m) return null;
  return { text: m[1].trim(), attribution: m[2]?.trim() };
}

function detectListItems(text: string): string[] {
  // Extract bullet-style items
  const items: string[] = [];
  LIST_BULLET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_BULLET_RE.exec(text)) !== null) {
    items.push(m[1].trim().slice(0, 60));
    if (items.length >= 6) break;
  }
  return items;
}

function detectTravel(locations: Array<{ name: string }>): boolean {
  return locations.length >= 2;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function analyzeScene(
  sceneText: string,
  visualCue = "",
  pexelsQuery = "",
  beats: Array<{ text: string }> = []
): SceneSignals {
  const full = [sceneText, visualCue, pexelsQuery, ...beats.map(b => b.text)].join(" ");

  const persons   = extractPersons(full);
  const stats     = extractStats(full);
  const locations = extractLocations(full);
  const years     = extractYears(full);
  const comparison = detectComparison(full);
  const quote     = detectQuote(full);
  const listItems = detectListItems(sceneText);
  const travel    = detectTravel(locations);

  return {
    persons,
    stats,
    locations,
    years,
    travel,
    comparison,
    listItems,
    quote,
    isMilitary: MILITARY_KW.test(full),
    isScience:  SCIENCE_KW.test(full),
    isEconomy:  ECONOMY_KW.test(full),
  };
}
