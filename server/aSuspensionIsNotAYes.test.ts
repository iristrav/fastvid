/**
 * RONDE 266 — A SUSPENSION IS NOT A YES.
 *
 * ── The one thing `allowed: true` could not say ─────────────────────────────────────────────
 *
 * `adoptionGuardVerdict` returned `{ allowed: true }` for two different things:
 *
 *     the editor was shown this picture and said yes
 *     there was no editor in this render at all, so the requirement was suspended
 *
 * The suspension is deliberate and RONDE 94 argues for it: when the picture editor cannot be
 * reached, EVERY picture is unjudged, so enforcing the requirement refuses every real adoption for
 * a reason that has nothing to do with any picture. The export gate still refuses the film.
 *
 * But both answers arrived at every caller wearing the same word — which is precisely the shape
 * RONDE 199 removed one layer down, where "the editor looked and could not tell" and "nobody
 * looked" had collapsed into `unknown`. One layer up, the same collapse was still there.
 *
 * ── What changes, and what deliberately does not ────────────────────────────────────────────
 *
 * WHO IS ALLOWED DOES NOT CHANGE. §4 checks that every allow and every refusal is the one it was.
 * What changes is that the verdict now names what satisfied the requirement, so a caller cannot
 * count a suspension as verification — and four acceptance metrics stop being an argument and
 * become a number. §5 measures them.
 */
import { describe, expect, it } from "vitest";

import {
  adoptionGuardVerdict,
  adoptionIsVisionVerified,
  visionVerdictFromGate,
  type AdoptionVisionVerdict,
} from "./adoptionPolicy";
import { __testVerificationOf } from "./beatVisualStatus";

const guard = (over: Partial<Parameters<typeof adoptionGuardVerdict>[0]> = {}) =>
  adoptionGuardVerdict({
    source: "wikimedia",
    eligible: true,
    vision: "APPROVED",
    ...over,
  });

/* ═══════════ 1. the four evidences ═══════════ */

describe("R266 §1 — the verdict says what satisfied it", () => {
  it("an editor's yes is APPROVED", () => {
    const v = guard({ vision: "APPROVED" });
    expect(v).toEqual({ allowed: true, visionEvidence: "APPROVED" });
    expect(adoptionIsVisionVerified(v)).toBe(true);
  });

  it("A RENDER WITH NO EDITOR IS SUSPENDED, AND THAT IS NOT VERIFICATION", () => {
    const v = guard({ vision: "NOT_ASKED", visionAvailable: false });
    expect(v).toMatchObject({ allowed: true, visionEvidence: "SUSPENDED_NO_EDITOR" });
    expect(
      adoptionIsVisionVerified(v),
      "a render with no picture editor produced a verified visual"
    ).toBe(false);
  });

  it("THE SUSPENSION WINS OVER A STALE YES — it is what let this adoption through", () => {
    const v = guard({ vision: "APPROVED", visionAvailable: false });
    expect(v).toMatchObject({ visionEvidence: "SUSPENDED_NO_EDITOR" });
    expect(adoptionIsVisionVerified(v)).toBe(false);
  });

  it("a route with no source at all claims nothing", () => {
    expect(guard({ source: null })).toEqual({ allowed: true, visionEvidence: "NOT_REQUIRED" });
    expect(adoptionIsVisionVerified(guard({ source: null }))).toBe(false);
  });

  it("and a refusal carries no evidence field to be misread", () => {
    const v = guard({ source: "no_such_route_declared_anywhere" });
    expect(v.allowed).toBe(false);
    expect(adoptionIsVisionVerified(v)).toBe(false);
  });
});

/* ═══════════ 2. NOT_ASKED and UNKNOWN are never verification ═══════════ */

describe("R266 §2 — silence is still not an answer, now measurably", () => {
  it("NOT_ASKED_verified = 0", () => {
    for (const source of ["wikimedia", "rescue_archive", "subject_fallback"]) {
      const v = guard({ source, vision: "NOT_ASKED" });
      expect(
        adoptionIsVisionVerified(v),
        `${source} counted a picture nobody looked at as verified`
      ).toBe(false);
    }
  });

  it("UNKNOWN_verified = 0", () => {
    for (const source of ["wikimedia", "rescue_archive", "subject_fallback"]) {
      const v = guard({ source, vision: "UNCLEAR" });
      expect(adoptionIsVisionVerified(v), `${source} counted UNCLEAR as verified`).toBe(false);
    }
  });

  it("REJECTED is never verification either", () => {
    expect(adoptionIsVisionVerified(guard({ vision: "REJECTED" }))).toBe(false);
  });

  it("and the gate's own mapping keeps the two silences apart", () => {
    expect(visionVerdictFromGate("unknown", false)).toBe("NOT_ASKED");
    expect(visionVerdictFromGate("unknown", true)).toBe("UNCLEAR");
    expect(visionVerdictFromGate("fits", true)).toBe("APPROVED");
    expect(visionVerdictFromGate("does_not_fit", true)).toBe("REJECTED");
  });

  it("nor does the beat's verification vocabulary call them verified", () => {
    expect(__testVerificationOf({ reprieved: false, verdict: "fits" })).toBe("verified_fit");
    expect(__testVerificationOf({ reprieved: false, verdict: "unknown", evaluated: false })).toBe(
      "never_asked"
    );
    expect(__testVerificationOf({ reprieved: false, verdict: "unknown", evaluated: true })).toBe(
      "unknown"
    );
  });
});

/* ═══════════ 3. a fallback is never a verified primary ═══════════ */

describe("R266 §3 — fallbackVerifiedAsPrimary = 0", () => {
  it("a subject fallback with no editor's yes is not verified, whatever it is allowed", () => {
    for (const vision of ["UNCLEAR", "NOT_ASKED"] as AdoptionVisionVerdict[]) {
      const v = guard({ source: "subject_fallback", vision });
      expect(
        adoptionIsVisionVerified(v),
        `a fallback on ${vision} was counted as a verified primary`
      ).toBe(false);
    }
  });

  it("and a fallback that the editor DID approve reports approval, not a category promotion", () => {
    const v = guard({ source: "subject_fallback", vision: "APPROVED" });
    if (v.allowed) expect(v.visionEvidence).toBe("APPROVED");
    /** Evidence is about the picture. The ROUTE is still a fallback; nothing here renames it. */
    expect(adoptionIsVisionVerified(v)).toBe(true);
  });
});

/* ═══════════ 4. nothing about who is allowed moved ═══════════ */

describe("R266 §4 — the same adoptions are allowed and refused as before", () => {
  it("a REAL_FUNNEL route still needs eligibility AND an approval", () => {
    expect(guard({ eligible: false }).allowed).toBe(false);
    expect(guard({ vision: "UNCLEAR" }).allowed).toBe(false);
    expect(guard({ vision: "NOT_ASKED" }).allowed).toBe(false);
    expect(guard({ vision: "REJECTED" }).allowed).toBe(false);
    expect(guard({ eligible: true, vision: "APPROVED" }).allowed).toBe(true);
  });

  it("an undeclared route is still refused outright", () => {
    const v = guard({ source: "something_nobody_declared" });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("UNDECLARED_ADOPT_ROUTE");
  });

  it("THE SUSPENSION STILL ALLOWS — this round did not quietly close RONDE 94's escape hatch", () => {
    /**
     * Deliberate. Closing it would refuse every real adoption in a render whose editor is down,
     * for a reason that has nothing to do with any picture, and drive the export gate to reject
     * every such film — the exact failure RONDE 94 removed. What this round adds is that the
     * adoptions it lets through can no longer be counted as verified.
     */
    expect(guard({ vision: "NOT_ASKED", visionAvailable: false }).allowed).toBe(true);
  });

  it("and a refusal still says which requirement was missing", () => {
    const v = guard({ eligible: false, vision: "UNCLEAR" });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
      expect(v.reason).toContain("eligibility");
      expect(v.reason).toContain("vision (UNCLEAR)");
    }
  });
});

/* ═══════════ 5. the acceptance metrics, as numbers ═══════════ */

describe("R266 §5 — four metrics that were UNKNOWN are now measured", () => {
  /** Real route labels the pipeline actually reports — not the policy CATEGORY names. */
  const ROUTES = ["wikimedia", "rescue_archive", "subject_fallback", "backfill", "graphic"];
  const VERDICTS: AdoptionVisionVerdict[] = ["APPROVED", "REJECTED", "UNCLEAR", "NOT_ASKED"];

  /** Every combination the guard can be asked, so the counts below are exhaustive, not sampled. */
  const all = ROUTES.flatMap((source) =>
    VERDICTS.flatMap((vision) =>
      [true, false].flatMap((eligible) =>
        [true, false].map((visionAvailable) => ({
          source,
          vision,
          eligible,
          visionAvailable,
          verdict: adoptionGuardVerdict({ source, vision, eligible, visionAvailable }),
        }))
      )
    )
  );

  it("adoptedWithoutEvidence = 0", () => {
    /** An allowed REAL_FUNNEL adoption with a live editor must hold eligibility and an approval. */
    const offenders = all.filter(
      (c) =>
        c.verdict.allowed &&
        c.source === "wikimedia" &&
        c.visionAvailable &&
        (!c.eligible || c.vision !== "APPROVED")
    );
    expect(offenders).toHaveLength(0);
  });

  it("verifiedWithoutVisionEvidence = 0", () => {
    const offenders = all.filter(
      (c) => adoptionIsVisionVerified(c.verdict) && !(c.visionAvailable && c.vision === "APPROVED")
    );
    expect(offenders.map((o) => `${o.source}/${o.vision}/avail=${o.visionAvailable}`)).toEqual([]);
  });

  it("NOT_ASKED_verified = 0", () => {
    expect(all.filter((c) => c.vision === "NOT_ASKED" && adoptionIsVisionVerified(c.verdict))).toHaveLength(0);
  });

  it("UNKNOWN_verified = 0", () => {
    expect(all.filter((c) => c.vision === "UNCLEAR" && adoptionIsVisionVerified(c.verdict))).toHaveLength(0);
  });

  it("fallbackVerifiedAsPrimary = 0", () => {
    const offenders = all.filter(
      (c) =>
        c.source !== "wikimedia" &&
        adoptionIsVisionVerified(c.verdict) &&
        c.vision !== "APPROVED"
    );
    expect(offenders).toHaveLength(0);
  });

  it("AND THE MATRIX IS NOT EMPTY — a metric measured over nothing is not measured", () => {
    expect(all.length).toBe(ROUTES.length * VERDICTS.length * 4);
    expect(all.filter((c) => c.verdict.allowed).length).toBeGreaterThan(0);
    expect(all.filter((c) => !c.verdict.allowed).length).toBeGreaterThan(0);
    expect(all.filter((c) => adoptionIsVisionVerified(c.verdict)).length).toBeGreaterThan(0);
  });
});
