/** Visual Matching Engine V2 — Visual Continuity (Phase 3, Visual Intelligence Engine).
 *
 * Generalizes the legacy pipeline's existing person-only topic-lock
 * (isOffTopicVisualForPersonTopic, videoPipeline.ts:10478) to brand/company/era continuity —
 * "if discussing Apple, don't suddenly show Microsoft" / "if discussing WWII, don't mix in
 * modern footage." Same structural pattern as the original (scan the candidate's own
 * search-query/title/tag text for a conflicting entity, allow it through when it actually
 * matches what THIS beat established), reimplemented data-driven against the beat's own
 * VisualIntent.companies/brands instead of one hardcoded person/regex pair, since there's no
 * general-purpose named-entity knowledge base anywhere in this codebase to draw a fully
 * general version from.
 *
 * The known-brands list below is a starter set (same honesty level as the legacy pattern it
 * generalizes, which was itself hand-tuned to specific known problem cases) — extend it as
 * real mismatches are observed, the same way the original list grew over time.
 */
import type { CandidateAsset, VideoContext, VisualIntent } from "./types";

/** A modest set of well-known, easily-confused brand/company names — enough to catch the
 *  spec's own example (Apple vs. Microsoft) and similarly common tech-industry mix-ups.
 *  Not exhaustive; extend as real cases surface. */
const KNOWN_BRANDS = [
  "apple",
  "microsoft",
  "google",
  "amazon",
  "meta",
  "facebook",
  "tesla",
  "xai",
  "openai",
  "samsung",
  "nvidia",
  "intel",
  "amd",
  "netflix",
  "spotify",
  "twitter",
  "x corp",
];

/** Very coarse era classifier from free text — enough to flag "video is about WWII (1940s)
 *  but this candidate's own text reads as clearly modern," not a precise date parser. */
const MODERN_ERA_RE = /\b(smartphone|iphone|4k|streaming|social media|selfie|drone footage|livestream)\b/i;
const HISTORICAL_ERA_RE = /\b(19[0-4]\d|world war|wwii|ww2|black and white footage|archival newsreel)\b/i;

function candidateText(candidate: CandidateAsset): string {
  return [candidate.title, candidate.description, candidate.searchQuery, ...candidate.tags]
    .filter((s): s is string => !!s)
    .join(" ")
    .toLowerCase();
}

/**
 * Returns true when a candidate's own text signals a DIFFERENT established brand/company than
 * the ones this beat actually mentions, or a clearly mismatched era relative to the beat's
 * historical context — the same "don't show the wrong topic" guarantee the legacy person-lock
 * check provides, generalized beyond people.
 */
export function isOffTopicForVideoContext(
  candidate: CandidateAsset,
  intent: VisualIntent,
  videoContext?: VideoContext
): boolean {
  const text = candidateText(candidate);
  if (!text.trim()) return false;

  const expectedBrands = new Set(
    [...intent.brands, ...intent.companies, ...(videoContext?.keySubjects ?? [])].map((b) => b.toLowerCase())
  );

  if (expectedBrands.size > 0) {
    for (const brand of KNOWN_BRANDS) {
      if (expectedBrands.has(brand)) continue; // this brand IS the topic — never flag it
      if (text.includes(brand)) return true; // mentions a different known brand
    }
  }

  const isHistoricalBeat = HISTORICAL_ERA_RE.test(intent.historicalContext) || HISTORICAL_ERA_RE.test(intent.visualTime);
  if (isHistoricalBeat && MODERN_ERA_RE.test(text)) return true;

  return false;
}
