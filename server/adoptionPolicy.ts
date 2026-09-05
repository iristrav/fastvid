/**
 * RONDE 90 PHASE 2 — WHAT EVERY ADOPTION ROUTE IS ALLOWED TO CLAIM.
 *
 * ── The audit that produced this file ───────────────────────────────────────────────────────
 *
 * videoPipeline.ts has 35 `recordClipAdopt` call sites, 2 `noteBeatEligible` call sites and 22
 * vision-gate call sites. A rule 35 routes must satisfy is registered by 2 of them. That ratio,
 * on its own, is the whole of render 568's funnel:
 *
 *     [VisualFunnel] wikimedia   retrieved=400 eligible=0 adopted=2  finalVideo=1
 *     [VisualFunnel] ww2         retrieved=0   eligible=0 adopted=6  finalVideo=1
 *     [VisualFunnel] loc         retrieved=0   eligible=0 adopted=1
 *     [VisualFunnel] UNVERIFIED  retrieved=0   eligible=0 adopted=23 finalVideo=17
 *     [VisualFunnel] TOTAL       retrieved=3995 eligible=4
 *
 * Four eligible candidates out of 3995 is not a retrieval collapse. It is 33 adoption routes that
 * never register the fact, and one of them supplying 17 of the 20 delivered clips.
 *
 * ── The two mechanisms, both measured in the code ───────────────────────────────────────────
 *
 * 1. `adoptRouteForSource` classified a route by string shape — `rescue_*` is a rescue, a handful
 *    of names are fallbacks — and returned `"primary"` for everything else. "Primary" means "a
 *    beat filled by the route that was supposed to fill it". So an unrecognised label was assumed
 *    to be the GOOD case. A default that generous is not a classification, it is a hope.
 *
 * 2. `guaranteedAdoptSource("wikimedia")` returned the literal string `"wikimedia"` — the same
 *    label the real Wikimedia retrieval route uses. The guaranteed ladder's last-resort image and
 *    a properly retrieved, ranked, judged Wikimedia asset were recorded as the same thing, and
 *    `adoptRouteForSource` then called both `primary`. That is exactly `wikimedia eligible=0
 *    adopted=2 finalVideo=1`: an adoption wearing the funnel's name without having walked it.
 *
 * ── What this module is, and is not ─────────────────────────────────────────────────────────
 *
 * It is one declared table. Every adopt-source label the pipeline uses says, explicitly, what it
 * is and what it may claim. It is NOT a second selection engine, it makes no ranking decision and
 * it adopts nothing: it is the vocabulary the existing routes were already using, written down so
 * that the answers stop being inferred from the spelling of a string.
 *
 * It lives beside `clipAdoptAudit`, which every one of the 35 routes already calls, because that
 * is where a rule reaches all of them without being added to any of them — the same reasoning as
 * `returnComposed` for compose and `withBeatProvenance` for query scope.
 *
 * ── Why an undeclared source is not "primary" ───────────────────────────────────────────────
 *
 * A route nobody declared is a route nobody has reasoned about. Treating it as real, verified,
 * funnel-backed footage is the assumption that produced render 568. It is classified as the most
 * conservative thing it could be and reported by name, so the next unknown route shows up in the
 * log as a gap instead of as a clean number.
 */

/** What KIND of picture a route puts on screen. Existing pipeline vocabulary, written down. */
export type AdoptCategory =
  /** Real media the normal retrieval funnel produced for this beat. */
  | "REAL_FUNNEL"
  /** Real media, but reached off the funnel — a rescue ladder rung. */
  | "RESCUE_REAL"
  /** Real media of the beat's SUBJECT rather than what the beat describes. */
  | "FALLBACK_SUBJECT"
  /** Real media, held or extended to cover time the beat had no picture for. */
  | "BACKFILL_TIME"
  /** Model-generated imagery. Real pixels, no provenance in the world. */
  | "GENERATED"
  /** A drawn card: motion graphic, map, title. Depicts nothing photographic. */
  | "GRAPHIC"
  /** A colour/text card standing in for a picture that was never found. */
  | "PLACEHOLDER"
  /** No declaration exists for this label — a gap, reported as one. */
  | "UNDECLARED";

export type AdoptionPolicy = {
  category: AdoptCategory;
  /** Did this route go through eligibility? False means it is a declared exception. */
  requiresEligibility: boolean;
  /** Must the picture editor have judged this picture against its beat? */
  requiresVision: boolean;
  /** May this count toward "the film is made of real footage"? */
  countsAsRealFootage: boolean;
  /** May this count toward "this beat has an approved picture of its own"? */
  countsAsVerifiedVisual: boolean;
  /** Why the route is allowed to skip what it skips. Required for every exception. */
  exceptionReason?: string;
};

const REAL_FUNNEL = (): AdoptionPolicy => ({
  category: "REAL_FUNNEL",
  requiresEligibility: true,
  requiresVision: true,
  countsAsRealFootage: true,
  countsAsVerifiedVisual: true,
});

const RESCUE_REAL = (reason: string): AdoptionPolicy => ({
  category: "RESCUE_REAL",
  requiresEligibility: false,
  requiresVision: true,
  countsAsRealFootage: true,
  countsAsVerifiedVisual: false,
  exceptionReason: reason,
});

const SYNTHETIC = (category: AdoptCategory, reason: string): AdoptionPolicy => ({
  category,
  requiresEligibility: false,
  requiresVision: false,
  countsAsRealFootage: false,
  countsAsVerifiedVisual: false,
  exceptionReason: reason,
});

/**
 * THE DECLARED VOCABULARY.
 *
 * Every label any `recordClipAdopt` call site can produce, including the ones built at runtime by
 * `guaranteedAdoptSource` and `SUBJECT_FALLBACK_ROUTE`. A structural test walks the call sites and
 * fails when a literal is missing from this table, so a new route cannot be added without saying
 * what it is.
 */
const POLICIES: Readonly<Record<string, AdoptionPolicy>> = {
  // ── Real media, through the funnel ────────────────────────────────────────────────────────
  archive: REAL_FUNNEL(),
  archive_fetch: REAL_FUNNEL(),
  archive_topic: REAL_FUNNEL(),
  internet_archive: REAL_FUNNEL(),
  wikimedia: REAL_FUNNEL(),
  openverse: REAL_FUNNEL(),
  europeana: REAL_FUNNEL(),
  pexels: REAL_FUNNEL(),
  pixabay: REAL_FUNNEL(),
  stock: REAL_FUNNEL(),
  pool: REAL_FUNNEL(),
  own_archive: REAL_FUNNEL(),
  wikimedia_video: REAL_FUNNEL(),
  /**
   * RONDE 91 — the provider labels the scene-pool path reports.
   *
   * These reach `recordClipAdopt` through runtime expressions (`candidate.source`, `label`,
   * `stockAdoptSource`), not string literals, so RONDE 90's structural test — which reads the
   * literals at the call sites — could not see them. The suite could: three existing tests failed
   * the moment an undeclared label stopped counting as `own_footage`, which is the check working.
   * `clipAdoptAudit` and `editorialReviewEngine` already knew all of these by name.
   */
  loc: REAL_FUNNEL(),
  nara: REAL_FUNNEL(),
  nasa: REAL_FUNNEL(),
  flickr: REAL_FUNNEL(),
  gdelt: REAL_FUNNEL(),
  mediaccc: REAL_FUNNEL(),
  sepiasearch: REAL_FUNNEL(),
  youtube: REAL_FUNNEL(),
  youtube_cc: REAL_FUNNEL(),

  // ── Real media, off the funnel ────────────────────────────────────────────────────────────
  rescue_archive: RESCUE_REAL(
    "the guaranteed ladder searches the curated archive directly after the beat's own sourcing failed"
  ),
  rescue_wikimedia: RESCUE_REAL(
    "the guaranteed ladder asks Commons for one more real image after every other route failed"
  ),
  rescue_stock: RESCUE_REAL(
    "licensed stock reached after the beat's own sourcing failed"
  ),
  /**
   * Real archive media found by SIMILARITY to another beat's picture rather than by this beat's
   * own query. Genuinely sourced, and an answer to a different question — which is why it is a
   * rescue and may not claim to be the beat's verified visual.
   */
  archive_similar: RESCUE_REAL(
    "archive media matched by similarity to a neighbouring beat, not by this beat's own query"
  ),
  rescue_similar: RESCUE_REAL(
    "archive media matched by similarity after the beat's own sourcing failed"
  ),

  /**
   * A picture of the beat's SUBJECT, not of what the beat describes. Real footage, correctly
   * sourced, and an answer to a narrower question than the beat asked — which is why it may not
   * count as the beat's own verified visual. Render 568 filled 10 of 17 beats this way.
   */
  subject_fallback: {
    category: "FALLBACK_SUBJECT",
    requiresEligibility: false,
    requiresVision: true,
    countsAsRealFootage: true,
    countsAsVerifiedVisual: false,
    exceptionReason:
      "footage of the beat's subject when its event, place or action could not be found",
  },

  /** Holding or extending a picture already on screen. Real pixels, no new claim about the beat. */
  rescue_extend: {
    category: "BACKFILL_TIME",
    requiresEligibility: false,
    requiresVision: false,
    countsAsRealFootage: true,
    countsAsVerifiedVisual: false,
    exceptionReason: "extends a picture already adopted for this scene; makes no new claim",
  },
  extend: {
    category: "BACKFILL_TIME",
    requiresEligibility: false,
    requiresVision: false,
    countsAsRealFootage: true,
    countsAsVerifiedVisual: false,
    exceptionReason: "extends a picture already adopted for this scene; makes no new claim",
  },
  backfill: {
    category: "BACKFILL_TIME",
    requiresEligibility: false,
    requiresVision: false,
    countsAsRealFootage: true,
    countsAsVerifiedVisual: false,
    exceptionReason: "fills scene time the beat loop left uncovered",
  },

  // ── Generated ─────────────────────────────────────────────────────────────────────────────
  ai: {
    category: "GENERATED",
    requiresEligibility: false,
    requiresVision: true,
    countsAsRealFootage: false,
    countsAsVerifiedVisual: false,
    exceptionReason: "generated from the beat's own words; has no provider to be eligible at",
  },
  rescue_ai: {
    category: "GENERATED",
    requiresEligibility: false,
    requiresVision: true,
    countsAsRealFootage: false,
    countsAsVerifiedVisual: false,
    exceptionReason: "generated after every real-media route failed",
  },
  kling: {
    category: "GENERATED",
    requiresEligibility: false,
    requiresVision: true,
    countsAsRealFootage: false,
    countsAsVerifiedVisual: false,
    exceptionReason: "generated video; has no provider to be eligible at",
  },

  // ── Drawn ─────────────────────────────────────────────────────────────────────────────────
  graphic: SYNTHETIC("GRAPHIC", "a drawn card; there is no photograph to judge"),
  motion_graphic: SYNTHETIC("GRAPHIC", "a drawn card; there is no photograph to judge"),
  mgfx: SYNTHETIC("GRAPHIC", "a drawn card; there is no photograph to judge"),
  rescue_graphic: SYNTHETIC("GRAPHIC", "a drawn card produced after every media route failed"),

  /**
   * The guaranteed ladder's two synthetic rungs, under their tier names.
   *
   * `guaranteedAdoptSource` collapses both to "fallback", but the tier words reach the adopt
   * audit by other paths and `beatVisualStatus` has always had to handle them. Declared here so
   * that handling comes from one table instead of two.
   */
  text_overlay: SYNTHETIC("GRAPHIC", "a card with the beat's own words on it; depicts nothing"),
  color_fallback: SYNTHETIC("PLACEHOLDER", "a drawn colour card; depicts nothing"),

  // ── Nothing was found ─────────────────────────────────────────────────────────────────────
  fallback: SYNTHETIC("PLACEHOLDER", "a colour/text card standing in for a picture never found"),
  guaranteed: SYNTHETIC("PLACEHOLDER", "the guaranteed ladder's last rung; depicts nothing"),
  rescue_placeholder: SYNTHETIC(
    "PLACEHOLDER",
    "a colour/text card standing in for a picture never found"
  ),
};

/** The conservative reading of a label nobody declared. Never counts as anything good. */
const UNDECLARED: AdoptionPolicy = {
  category: "UNDECLARED",
  requiresEligibility: false,
  requiresVision: false,
  countsAsRealFootage: false,
  countsAsVerifiedVisual: false,
  exceptionReason: "no adoption policy is declared for this route — see adoptionPolicy.ts",
};

/** True when this label has a declared policy. A `false` here is a gap in the vocabulary. */
export function isDeclaredAdoptSource(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(POLICIES, normalise(source));
}

function normalise(source: string): string {
  return (source ?? "").trim().toLowerCase();
}

/**
 * What this adoption route is allowed to claim.
 *
 * An undeclared label yields `UNDECLARED` rather than a guess. That is the whole difference from
 * the string-shape classifier this replaces: the unknown case is now the conservative one and it
 * is visible, instead of being the permissive one and invisible.
 */
export function adoptionPolicyFor(source: string): AdoptionPolicy {
  const key = normalise(source);
  const exact = POLICIES[key];
  if (exact) return exact;
  /**
   * `rescue_similar` is a FAMILY, not a label: the codebase already treats it as a prefix
   * (`editorialReviewEngine` matches `startsWith("rescue_similar")`, so does `clipAdoptAudit`),
   * and `rescue_similar_v2` exists. One prefix, declared once, rather than a row per version —
   * and deliberately the only prefix, so this cannot quietly become a second shape-based
   * classifier with the permissive default this module was written to remove.
   */
  if (key.startsWith("rescue_similar")) return POLICIES.rescue_similar!;
  return UNDECLARED;
}

/** Every declared label, for the structural test and for reporting. */
export function declaredAdoptSources(): string[] {
  return Object.keys(POLICIES).sort();
}

/**
 * RONDE 91 — WHAT KIND OF PICTURE THIS BEAT ENDED UP WITH, decided by the declared policy.
 *
 * ── The third permissive default ────────────────────────────────────────────────────────────
 *
 * `beatVisualStatus.coverageOfAdoptEntry` held a second source→coverage table of twelve entries
 * and returned `"own_footage"` for everything else. So did `adoptRouteForSource` with `"primary"`.
 * Three tables, three defaults, and in every one of them the UNKNOWN case was the flattering one.
 *
 * That default has teeth. `verifiedOwnVisual = coverage === "own_footage" && verification ===
 * "verified_fit"` feeds `beatVisuals.verifiedOwnVisual`, which is what RONDE 89's
 * `NO_VERIFIED_OWN_VISUAL` export condition reads. An undeclared route landing on `own_footage`
 * could therefore become a beat's verified visual and help a render past the delivery gate.
 *
 * Deriving coverage from the declared policy closes that: a route that may not count as real
 * footage cannot be `own_footage`, so it cannot be a verified visual, so it cannot answer for a
 * beat at the export gate. This is the enforcement `countsAsRealFootage` was declared for.
 *
 * ── Where an undeclared route lands, and why ────────────────────────────────────────────────
 *
 * `"none"`. Not `own_footage` — that is the claim being withdrawn — and not `placeholder`, which
 * would assert it is a drawn card when nobody knows what it is. "This beat has a picture this
 * render cannot classify" is exactly `none`, and it is the honest answer.
 */
export function coverageForAdoptSource(
  source: string
): "own_footage" | "subject_only" | "held_frame" | "graphic" | "placeholder" | "generated" | "none" {
  const policy = adoptionPolicyFor(source);
  switch (policy.category) {
    case "REAL_FUNNEL":
    case "RESCUE_REAL":
      return "own_footage";
    case "FALLBACK_SUBJECT":
      return "subject_only";
    case "BACKFILL_TIME":
      return "held_frame";
    case "GENERATED":
      return "generated";
    case "GRAPHIC":
      return "graphic";
    case "PLACEHOLDER":
      return "placeholder";
    case "UNDECLARED":
      return "none";
  }
}

/**
 * What the render adopted, by category — and which labels nobody has declared.
 *
 * ── Why this does not also re-map `adoptRouteForSource` ─────────────────────────────────────
 *
 * The obvious next step is to have the ledger's primary/fallback/rescue/backfill route derive
 * from these categories, so the pipeline has one vocabulary instead of a table and a string-shape
 * heuristic. It is deliberately NOT done here. That mapping disagrees with the current one for
 * `guaranteed`, `ai`, `kling` and `rescue_ai`, so making both changes at once would move the
 * `[VisualFunnel] fallback=/rescue=/backfill=` counts in the same commit that introduces the
 * policy — and the next production render would no longer be comparable to 568, which is the
 * measurement this whole round exists to make. The unification is a later phase, with its own
 * before/after.
 */
export type AdoptionPolicyCensus = {
  byCategory: Record<AdoptCategory, number>;
  /** Labels reaching adoption with no declared policy, with how often each occurred. */
  undeclared: Record<string, number>;
  total: number;
};

export function censusAdoptionPolicies(sources: readonly string[]): AdoptionPolicyCensus {
  const byCategory: Record<AdoptCategory, number> = {
    REAL_FUNNEL: 0, RESCUE_REAL: 0, FALLBACK_SUBJECT: 0, BACKFILL_TIME: 0,
    GENERATED: 0, GRAPHIC: 0, PLACEHOLDER: 0, UNDECLARED: 0,
  };
  const undeclared: Record<string, number> = {};
  for (const raw of sources) {
    const policy = adoptionPolicyFor(raw);
    byCategory[policy.category]++;
    if (policy.category === "UNDECLARED") {
      const key = normalise(raw) || "(empty)";
      undeclared[key] = (undeclared[key] ?? 0) + 1;
    }
  }
  return { byCategory, undeclared, total: sources.length };
}

/**
 * The render's adoption census, as log lines.
 *
 * The first line is what the film is made of, in the categories that mean different things. The
 * second only appears when a route adopted under a label nobody declared — the case that used to
 * be silently classified as `primary`, i.e. as the good one.
 */
export function formatAdoptionPolicyCensus(census: AdoptionPolicyCensus): string[] {
  const c = census.byCategory;
  const lines = [
    `[AdoptionPolicy] adoptions=${census.total} realFunnel=${c.REAL_FUNNEL} ` +
      `rescueReal=${c.RESCUE_REAL} subjectFallback=${c.FALLBACK_SUBJECT} ` +
      `backfillTime=${c.BACKFILL_TIME} generated=${c.GENERATED} graphic=${c.GRAPHIC} ` +
      `placeholder=${c.PLACEHOLDER} undeclared=${c.UNDECLARED}`,
  ];
  for (const [label, count] of Object.entries(census.undeclared).sort((a, b) => b[1] - a[1])) {
    lines.push(
      `[AdoptionPolicy] UNDECLARED_ADOPT_SOURCE route=${label} count=${count} — ` +
        `no policy declared, so it counts as neither real footage nor a verified visual`
    );
  }
  return lines;
}
