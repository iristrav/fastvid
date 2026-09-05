import { AsyncLocalStorage } from "node:async_hooks";

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
  /**
   * RONDE 94 — the three montage insertion points that adopted without declaring anything.
   *
   * `fetchSceneVisualsInner` pushes the beat's own fetched clip, the forced script image, and the
   * research re-fetch straight into the montage. None of the three calls `recordClipAdopt`, so
   * they were invisible to every audit RONDE 90-93 built, and — because they declared no intent —
   * the RONDE 93 guard let them past on the null branch.
   *
   * They are declared REAL_FUNNEL because that is what they are: candidates the normal retrieval
   * ladder produced for this beat. It is also the strictest category available, which is the right
   * direction for a route whose classification was in doubt — a REAL_FUNNEL claim without
   * eligibility and vision is refused, so an over-generous reading here cannot smuggle anything
   * through; it can only block the route until it registers the evidence it claims to have.
   */
  beat_fetch: REAL_FUNNEL(),
  script_image: REAL_FUNNEL(),
  research_refetch: REAL_FUNNEL(),

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
   * RONDE 94 — `recoverSceneClipsIfEmpty` re-pushes clips it assembled for a scene that produced
   * none at all. The clips are real (curated archive, Commons, stock), but they were selected
   * against a sentence stub rather than the beat, one rung below the beat's own sourcing.
   */
  recovered_scene: RESCUE_REAL(
    "scene-level recovery after the scene's own beats produced no clip at all"
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


/* ═══════════════════════ RONDE 93 — enforcement at the montage boundary ═══════════════════════ */

/**
 * WHAT THIS ROUTE IS ABOUT TO ADOPT, in scope while it pushes.
 *
 * ── Why an ambient scope and not a parameter ────────────────────────────────────────────────
 *
 * RONDE 92 established where the guard has to live: `recordClipAdopt` runs AFTER
 * `if (await pushClip(...))`, so by the time it sees the route label the clip is already in
 * `clips[]` and on its way into the montage. Refusing there refuses a record, not a picture.
 *
 * The place a clip actually enters the film is `clips.push(clipPath)` inside the four
 * `pushSceneClip` variants — and those take `(clipPath, holdSec, beatIndex)`. They do not know the
 * adopt route, and threading it would mean changing the `pushClip` callback signature that dozens
 * of call sites pass around.
 *
 * So the route states its intent the way this codebase already states a beat's provenance
 * (`withBeatProvenance`), its query scope (`withQueryScope`) and its planned shot
 * (`withPlannedShot`): ambiently, around the work. `pushSceneClip` reads it.
 *
 * ── Absent intent means "as before" ─────────────────────────────────────────────────────────
 *
 * A route that opens no scope yields `null`, and the guard passes. That is deliberate: it makes
 * this incremental instead of a flag day, and it means no existing route can be broken by a rule
 * it does not yet participate in. A route that DOES state its intent gets enforced, and the set of
 * such routes can grow one at a time with a render between each.
 */
const adoptionIntentStorage = new AsyncLocalStorage<string>();

/** The adopt-route label the current call is pushing under, or null outside any intent. */
export function currentAdoptionIntent(): string | null {
  return adoptionIntentStorage.getStore() ?? null;
}

/** Run `fn` while declaring that anything pushed inside it is being adopted as `source`. */
export function withAdoptionIntent<T>(source: string | undefined, fn: () => T): T {
  const label = (source ?? "").trim();
  return label ? adoptionIntentStorage.run(label, fn) : fn();
}

export type AdoptionGuardVerdict =
  | { allowed: true }
  | { allowed: false; code: "UNDECLARED_ADOPT_ROUTE" | "FUNNEL_WITHOUT_EVIDENCE"; reason: string };

/**
 * RONDE 94 — WHAT THE PICTURE EDITOR ACTUALLY SAID.
 *
 * RONDE 93's guard asked a boolean: was there a verdict? That is not the question. The gate's own
 * vocabulary is `"fits" | "does_not_fit" | "unknown"`, and RONDE 93 counted all three as "judged" —
 * so a picture the editor had just REFUSED satisfied the vision requirement, and so did one it
 * could not read. Absence of a verdict was the only thing that failed.
 *
 * That is the implicit approval this round exists to remove. A REAL_FUNNEL claim means an editor
 * looked at this picture under this narration and said yes. Everything else — refused, unreadable,
 * never asked — is not a yes, and the four are now distinguishable so the refusal can say which.
 */
export type AdoptionVisionVerdict = "APPROVED" | "REJECTED" | "UNCLEAR" | "NOT_ASKED";

/** The gate's own vocabulary, translated once so no call site has to remember the mapping. */
export function visionVerdictFromGate(verdict: string | null | undefined): AdoptionVisionVerdict {
  if (verdict === "fits") return "APPROVED";
  if (verdict === "does_not_fit") return "REJECTED";
  if (verdict === "unknown") return "UNCLEAR";
  return "NOT_ASKED";
}

/**
 * RONDE 93 — may this clip enter the montage?
 *
 * Two refusals, and they are deliberately not the same kind of thing.
 *
 * UNDECLARED_ADOPT_ROUTE is unconditional. A route nobody has declared cannot be reasoned about,
 * and every label the pipeline actually produces IS declared — a structural test walks the call
 * sites and a behavioural one covers the runtime producers. So this refusal has no legitimate
 * traffic to break, which is exactly why it can be switched on with no measurement first.
 *
 * FUNNEL_WITHOUT_EVIDENCE is the rule this sequence of rounds is ultimately for: a REAL_FUNNEL
 * route must have been found eligible and its picture must have been APPROVED.
 *
 * RONDE 93 shipped it behind `ENFORCE_FUNNEL_ADOPTION`, off by default, and that was not timidity —
 * `ELIGIBLE` was written at two sites in the whole pipeline while 35 routes adopted, so switching
 * it on then would have refused nearly every adoption, driven `verifiedOwnVisual` to zero and made
 * RONDE 89's export gate reject every render.
 *
 * RONDE 94 removed the reason instead of waiting for a measurement that could only have confirmed
 * it: eligibility is now recorded centrally at the one point every route passes through, every
 * route declares what it is adopting, and the default is ON. `=false` remains as the explicit
 * opt-out for a test that is proving something else, or for an operator during an incident.
 */
export function adoptionGuardVerdict(input: {
  source: string | null;
  eligible: boolean;
  vision: AdoptionVisionVerdict;
  /**
   * RONDE 94 — false ONLY when the picture editor could not be reached at all in this process.
   *
   * ── Why this is not a hole ──────────────────────────────────────────────────────────────────
   *
   * `beatClipPassesVisionGate` fails open when the local CLIP model will not load: it returns
   * `skipped: true` and the relevance ledger records `unknown`. That predates this round and it is
   * deliberate — a model-loading failure must not stop the product. But it means that in such a
   * render EVERY picture is UNCLEAR, so enforcing the vision requirement there does not enforce a
   * standard, it refuses every real adoption for a reason that has nothing to do with any picture.
   *
   * What is suspended is exactly one requirement, render-wide, for a reason the render logs. What
   * is NOT suspended: eligibility, the declared-route rule, and RONDE 89's export gate — which
   * refuses a film whose beats hold no verified visual. A render with no editor produces precisely
   * that film, so it still cannot ship; it simply fails at the gate that can say why, instead of
   * disappearing into thousands of per-clip refusals.
   *
   * The flag is a fact about the environment, never about a clip. A single unjudged picture in a
   * render where the editor answered other questions is REFUSED, and there is a test for it.
   */
  visionAvailable?: boolean;
}): AdoptionGuardVerdict {
  if (!input.source) return { allowed: true };
  const policy = adoptionPolicyFor(input.source);

  if (policy.category === "UNDECLARED") {
    return {
      allowed: false,
      code: "UNDECLARED_ADOPT_ROUTE",
      reason: `no adoption policy is declared for route "${normalise(input.source)}"`,
    };
  }

  if (!funnelAdoptionEnforced()) return { allowed: true };

  const missing: string[] = [];
  if (policy.requiresEligibility && !input.eligible) missing.push("eligibility");
  /**
   * RONDE 94 — only APPROVED satisfies a vision requirement.
   *
   * The three failing states are named separately because they are three different problems and
   * the log has to be able to tell them apart: REJECTED means the editor looked and said no,
   * UNCLEAR means it looked and could not tell, NOT_ASKED means nobody looked. Collapsing them
   * into "unjudged" is how render 568 reported 15 of 17 beats as `never_asked` while the gate had
   * in fact refused some of them.
   */
  const visionAvailable = input.visionAvailable !== false;
  if (policy.requiresVision && visionAvailable && input.vision !== "APPROVED") {
    missing.push(`vision (${input.vision})`);
  }
  if (missing.length === 0) return { allowed: true };
  return {
    allowed: false,
    code: "FUNNEL_WITHOUT_EVIDENCE",
    reason: `route "${normalise(input.source)}" claims ${policy.category} without ${missing.join(" and ")}`,
  };
}

/**
 * RONDE 94 — ON IN PRODUCTION, AND THE DEFAULT SAYS SO.
 *
 * RONDE 93 shipped this off, waiting for one production render to prove that eligibility was
 * registered widely enough for enforcement not to refuse the pipeline's own work. That reasoning
 * was sound and it is now spent: RONDE 94 fixed the thing the measurement was going to measure.
 * `ELIGIBLE` is no longer written at two sites out of thirty-five — `beatClipPassesVisionGate`
 * records it centrally, for every route that reaches the picture editor, which is every real
 * adoption route in the file.
 *
 * So the default inverts. `ENFORCE_FUNNEL_ADOPTION=false` still disables it, because a few tests
 * need to assert the permissive behaviour explicitly and because an operator must be able to turn
 * a gate off in an incident. Absent that explicit opt-out, production is strict: a route that
 * claims REAL_FUNNEL without eligibility and an APPROVED verdict does not reach the montage.
 *
 * What this costs is stated plainly rather than hidden: if a real render turns out to judge fewer
 * pictures than this assumes, the refusals cascade into RONDE 89's export gate and the render
 * fails instead of shipping unverified footage as verified. That is the failure direction this
 * whole sequence of rounds was for.
 */
export function funnelAdoptionEnforced(): boolean {
  return process.env.ENFORCE_FUNNEL_ADOPTION !== "false";
}
