/** Visual Matching Engine V2 — Intelligent Entity Fallback (Phase 3, Visual Intelligence
 *  Engine).
 *
 *  Extends the existing tiered-relaxation pattern already used for archive search
 *  (curatedMediaSourcing.ts: filtered -> relaxed threshold -> drop-specifier-and-retry) with
 *  one more tier: when a beat's search is built around a SPECIFIC named entity (a company,
 *  brand, or object) that yields no candidates at all, retry with a small set of generic,
 *  semantically-related categories instead of falling straight through to unrelated stock
 *  footage. Matches the spec's own example: no footage of a specific startup -> show
 *  office/servers/employees/conference/technology, not random stock.
 */
import type { VisualIntent } from "./types";

/** Generic, safe-default categories for "a named organization/object exists but we have no
 *  footage of it specifically." Deliberately broad and inoffensive — a last-resort substitute,
 *  not a precise match. Exported so other modules (e.g. cinematicEditingEngine's ShotPlanner)
 *  can recognize footage retrieved via this fallback tier without hardcoding a second copy of
 *  the same list. */
export const GENERIC_ENTITY_FALLBACK_CATEGORIES = [
  "office",
  "servers",
  "employees",
  "conference",
  "technology",
  "workspace",
  "meeting room",
];

/** True when this beat's search hinges on a specific named entity (company/brand/object)
 *  narrow enough that "no results" plausibly means "this specific thing has no footage,"
 *  rather than a broader visual concept that's simply hard to find. */
export function reliesOnSpecificEntity(intent: VisualIntent): boolean {
  return intent.companies.length > 0 || intent.brands.length > 0 || intent.objects.length > 0;
}

/** Builds a fallback VisualIntent per generic category, in priority order, for retrying
 *  search after the beat's specific-entity queries returned nothing. Each fallback keeps the
 *  original beat's action/emotion context (still an editorial intent, not a blind generic
 *  search) but swaps the search-driving fields to the generic category. */
export function buildEntityFallbackIntents(intent: VisualIntent): VisualIntent[] {
  if (!reliesOnSpecificEntity(intent)) return [];
  return GENERIC_ENTITY_FALLBACK_CATEGORIES.map((category) => ({
    ...intent,
    primaryKeyword: category,
    secondaryKeyword: intent.visualAction ? `${category} ${intent.visualAction}` : category,
    visualDescription: `${category}${intent.visualAction ? `, ${intent.visualAction}` : ""}`,
  }));
}
