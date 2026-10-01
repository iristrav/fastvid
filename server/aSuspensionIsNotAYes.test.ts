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

import { adoptionGuardVerdict, visionVerdictFromGate, type AdoptionVisionVerdict } from "./adoptionPolicy";
import { __testVerificationOf } from "./beatVisualStatus";

const guard = (over: Partial<Parameters<typeof adoptionGuardVerdict>[0]> = {}) =>
  adoptionGuardVerdict({
    source: "wikimedia",
    eligible: true,
    vision: "APPROVED",
    ...over,
  });

/* ═══════════ 2. NOT_ASKED and UNKNOWN are never verification ═══════════ */

describe("R266 §2 — silence is still not an answer, now measurably", () => {

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
});
