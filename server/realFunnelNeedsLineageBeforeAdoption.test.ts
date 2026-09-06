/**
 * ELIGIBILITY → VISION → ADOPTION, IN THAT ORDER.
 *
 * ── The order render 570 got backwards ──────────────────────────────────────────────────────
 *
 *     [ExportReadiness] video=570 2 of 5 gate(s) would block
 *       ok      visual_coverage          0/16 beat(s) got ONLY a card
 *       BLOCKS  no_verified_own_visual   0 of 16 (never_asked=16, own_footage=2)
 *       BLOCKS  mostly_unverified_clips  9 of 12 fetched clip(s)
 *
 *     7x  route=archive  eligible=false  vision=APPROVED  blocked=FUNNEL_WITHOUT_EVIDENCE
 *
 * Every beat held real footage — the coverage gate passed for the first time. Seven curated
 * archive clips were shown to the picture editor and APPROVED. All seven were refused anyway,
 * because the other half of REAL_FUNNEL — a resolvable lineage record — was missing. The beats
 * then fell through to `subject_fallback`, which needs neither, and the film ended up carrying
 * sixteen pictures nobody had judged:
 *
 *     14x  coverage=subject_only  verification=never_asked  reason=real_footage_never_judged
 *      2x  coverage=own_footage   verification=never_asked  reason=real_footage_never_judged
 *
 * Both blocking gates come from that one point. The pictures were there and approved; the
 * bookkeeping could not say where they came from.
 *
 * ── The rule, stated as behaviour ───────────────────────────────────────────────────────────
 *
 * A route may not adopt as REAL_FUNNEL and then go looking for evidence. The evidence comes
 * first. These five cases are the whole contract, and four of them are refusals — because the
 * temptation under an export gate is always to make the one that passes easier to reach.
 */
import { describe, expect, it } from "vitest";

import {
  adoptionGuardVerdict,
  adoptionPolicyFor,
  type AdoptionVisionVerdict,
} from "./adoptionPolicy";

const ENV = "ENFORCE_FUNNEL_ADOPTION";

/** Enforcement as production runs it: the flag unset, which since RONDE 94 means ON. */
const guard = (source: string, eligible: boolean, vision: AdoptionVisionVerdict) => {
  const saved = process.env[ENV];
  try {
    delete process.env[ENV];
    return adoptionGuardVerdict({ source, eligible, vision });
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
};

/** Every label the policy table declares REAL_FUNNEL — the contract holds for all of them. */
const REAL_FUNNEL_ROUTES = [
  "archive",
  "archive_fetch",
  "archive_topic",
  "internet_archive",
  "wikimedia",
  "wikimedia_video",
  "openverse",
  "europeana",
  "pexels",
  "pixabay",
  "stock",
  "pool",
  "own_archive",
  "loc",
  "nara",
  "nasa",
  "flickr",
  "gdelt",
  "mediaccc",
  "sepiasearch",
  "youtube",
  "youtube_cc",
  "beat_fetch",
  "script_image",
  "research_refetch",
] as const;

describe("the five cases, on every REAL_FUNNEL route", () => {
  /** CASE A — the only one that adopts. */
  it.each(REAL_FUNNEL_ROUTES)("A: %s with eligibility and APPROVED is adopted", (route) => {
    expect(guard(route, true, "APPROVED").allowed).toBe(true);
  });

  /**
   * CASE B — render 570's seven clips, exactly. Approved and refused, and it must stay that way:
   * a picture whose origin the render cannot state is not a verified own visual, however good it
   * looks and however inconvenient the export gate is.
   */
  it.each(REAL_FUNNEL_ROUTES)("B: %s APPROVED but not eligible is refused", (route) => {
    const v = guard(route, false, "APPROVED");
    expect(v.allowed, "this is render 570's seven archive clips").toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
  });

  /** CASE C — the editor looked and said no. Eligibility does not overrule a refusal. */
  it.each(REAL_FUNNEL_ROUTES)("C: %s eligible but REJECTED is refused", (route) => {
    expect(guard(route, true, "REJECTED").allowed).toBe(false);
  });

  /** CASE D — "I cannot tell" is not a yes for the category that claims verification. */
  it.each(REAL_FUNNEL_ROUTES)("D: %s eligible but UNCLEAR is refused", (route) => {
    expect(guard(route, true, "UNCLEAR").allowed).toBe(false);
  });

  /** CASE E — never asked is not a yes either. */
  it.each(REAL_FUNNEL_ROUTES)("E: %s eligible but NOT_ASKED is refused", (route) => {
    expect(guard(route, true, "NOT_ASKED").allowed).toBe(false);
  });

  /** And the table itself still says why: this category claims a verified own visual. */
  it.each(REAL_FUNNEL_ROUTES)("%s declares both requirements", (route) => {
    const policy = adoptionPolicyFor(route);
    expect(policy.category).toBe("REAL_FUNNEL");
    expect(policy.requiresEligibility).toBe(true);
    expect(policy.visionRequirement).toBe("approved");
    expect(policy.countsAsVerifiedVisual).toBe(true);
  });
});

/**
 * RESCUE AND FALLBACK ARE NOT DILUTED — the other way this gate could be made to pass.
 *
 * A fallback may put a picture on screen; RONDE 97 restored exactly that, and render 570 shows it
 * working (0 card-only beats). What it may never do is start counting as a verified own visual,
 * because then NO_VERIFIED_OWN_VISUAL goes green without a single verified picture existing.
 */
describe("a fallback never becomes a verified visual", () => {
  it.each(["subject_fallback", "rescue_wikimedia", "rescue_archive", "rescue_similar", "ai"])(
    "%s may adopt without an approval and still not count as verified",
    (route) => {
      const policy = adoptionPolicyFor(route);
      expect(policy.countsAsVerifiedVisual, "this is the line that must not move").toBe(false);
      expect(policy.visionRequirement).not.toBe("approved");
      expect(guard(route, false, "NOT_ASKED").allowed).toBe(true);
    }
  );

  it.each(["subject_fallback", "rescue_wikimedia", "rescue_archive"])(
    "%s is still refused a picture the editor REJECTED",
    (route) => {
      expect(guard(route, false, "REJECTED").allowed).toBe(false);
    }
  );

  /** The synthetic categories claim nothing and are counted as nothing. */
  it.each(["fallback", "rescue_placeholder", "motion_graphic", "rescue_extend"])(
    "%s claims no verified visual",
    (route) => {
      expect(adoptionPolicyFor(route).countsAsVerifiedVisual).toBe(false);
    }
  );

  /** An undeclared route is refused outright — no route may adopt anonymously. */
  it("an undeclared route is refused", () => {
    const v = guard("some_new_route_nobody_declared", true, "APPROVED");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("UNDECLARED_ADOPT_ROUTE");
  });
});
