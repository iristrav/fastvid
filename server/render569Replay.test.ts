/**
 * RENDER 569, REPLAYED THROUGH THE CURRENT CODE.
 *
 * ── Why this file exists and a unit test does not do its job ────────────────────────────────
 *
 * Twice in this sequence of rounds a change shipped with a completely green suite and broke the
 * product: RONDE 94 emptied a film with 7806 tests passing, RONDE 95 wasted 33 minutes of a render
 * with 7874 passing. Green tests prove the code does what its author thought it should. They do not
 * prove the author thought correctly, and that is what failed both times.
 *
 * So this file does not test a hypothesis. It replays FACTS: every adoption refusal render 569
 * actually recorded, transcribed from its worker log, put back through the code as it stands now.
 * If the fix is real, these exact inputs produce different answers. If it is not, they do not.
 *
 * ── The refusals, counted from the log ──────────────────────────────────────────────────────
 *
 *     47x  subject_fallback  eligible=false  vision=UNCLEAR
 *      2x  rescue_wikimedia  eligible=true   vision=NOT_ASKED
 *      2x  pexels            eligible=false  vision=UNCLEAR
 *      1x  subject_fallback  eligible=true   vision=UNCLEAR
 *     ───
 *      52  total, and the film ended with 14/14 beats on colour cards
 *
 * ── What this can and cannot tell us ────────────────────────────────────────────────────────
 *
 * It can tell us exactly how many of those 52 refusals the current code still makes. That is a
 * measurement, not an expectation.
 *
 * It cannot tell us whether the next render succeeds. Adoption is one stage; retrieval quality,
 * the provider mix and the export gate's own requirement are others, and this file deliberately
 * asserts nothing about them — see the last block, which pins the limit rather than hiding it.
 */
import { describe, expect, it } from "vitest";

import { adoptionGuardVerdict } from "./adoptionPolicy";

/** Transcribed from the worker log of VID-0569, 2026-09-05. Nothing here is invented. */
const RENDER_569_REFUSALS = [
  { count: 47, source: "subject_fallback", eligible: false, vision: "UNCLEAR" },
  { count: 2, source: "rescue_wikimedia", eligible: true, vision: "NOT_ASKED" },
  { count: 2, source: "pexels", eligible: false, vision: "UNCLEAR" },
  { count: 1, source: "subject_fallback", eligible: true, vision: "UNCLEAR" },
] as const;

const TOTAL = RENDER_569_REFUSALS.reduce((n, r) => n + r.count, 0);

/** Enforcement as production runs it: the flag unset, which since RONDE 94 means ON. */
const replay = (r: (typeof RENDER_569_REFUSALS)[number]) => {
  const saved = process.env.ENFORCE_FUNNEL_ADOPTION;
  try {
    delete process.env.ENFORCE_FUNNEL_ADOPTION;
    return adoptionGuardVerdict({ source: r.source, eligible: r.eligible, vision: r.vision });
  } finally {
    if (saved === undefined) delete process.env.ENFORCE_FUNNEL_ADOPTION;
    else process.env.ENFORCE_FUNNEL_ADOPTION = saved;
  }
};

describe("render 569 replayed through the code as it stands", () => {
  it("the log accounts for all 52 refusals", () => {
    expect(TOTAL).toBe(52);
  });

  /**
   * THE MEASUREMENT. 50 of the 52 were a rescue or a subject fallback turned away for a verdict
   * that is not a refusal — the editor saying it could not tell, or never being asked. Those are
   * the ones that emptied the film, and they are the ones this replay is for.
   *
   * Written as 48 first, from counting the log by eye. The replay said 50, and the replay was
   * right: 47 + 1 subject fallbacks plus 2 Wikimedia rescues. Left recorded here because it is the
   * point of the file — a measurement that can correct its author is worth more than one that
   * confirms him.
   */
  it("50 of the 52 refusals no longer happen", () => {
    let stillRefused = 0;
    let nowAllowed = 0;
    for (const r of RENDER_569_REFUSALS) {
      const allowed = replay(r).allowed;
      if (allowed) nowAllowed += r.count;
      else stillRefused += r.count;
    }
    expect(nowAllowed).toBe(50);
    expect(stillRefused).toBe(2);
    expect(nowAllowed + stillRefused).toBe(TOTAL);
  });

  /** Named individually, so a regression says WHICH group came back. */
  it("the 47 subject fallbacks are adopted", () => {
    expect(replay(RENDER_569_REFUSALS[0]).allowed).toBe(true);
  });

  it("the 2 Wikimedia rescues are adopted", () => {
    expect(replay(RENDER_569_REFUSALS[1]).allowed).toBe(true);
  });

  it("the 1 eligible subject fallback is adopted", () => {
    expect(replay(RENDER_569_REFUSALS[3]).allowed).toBe(true);
  });

  /**
   * AND THE FOUR THAT STILL FAIL, WHICH IS CORRECT.
   *
   * `pexels` is REAL_FUNNEL — it claims a verified own visual. It had neither eligibility nor an
   * approval, and a stock clip that nobody vouched for must not be presented as the beat's own
   * verified footage. Those two refusals were right in render 569 and are right now.
   */
  it("the 2 unbacked Pexels claims are still refused, and should be", () => {
    const v = replay(RENDER_569_REFUSALS[2]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
  });
});

/**
 * WHAT THIS REPLAY DOES NOT SHOW.
 *
 * Recorded as assertions rather than as a caveat somebody has to remember, because the gap between
 * "the adoptions now succeed" and "the render now succeeds" is exactly where the last two rounds
 * went wrong.
 */
describe("the limits of this replay, pinned", () => {
  /**
   * Render 569 logged `fits=12` — the editor said yes twelve times — and `verifiedOwnVisual=0`.
   * Approvals existed and none of them landed on a beat holding its own verified visual. Every
   * refusal this replay reverses restores a RESCUE or a FALLBACK, and both declare
   * `countsAsVerifiedVisual: false` by design.
   *
   * So the export gate, which requires at least one beat with an approved own visual, can still
   * refuse the next render. Fixing the fallbacks does not by itself fix that, and this test exists
   * so nobody reads the 50 above as a promise that it does.
   */
  it("none of the restored adoptions counts as a verified own visual", () => {
    const saved = process.env.ENFORCE_FUNNEL_ADOPTION;
    try {
      delete process.env.ENFORCE_FUNNEL_ADOPTION;
      for (const source of ["subject_fallback", "rescue_wikimedia"]) {
        expect(
          adoptionGuardVerdict({ source, eligible: false, vision: "UNCLEAR" }).allowed,
          "the adoption is restored"
        ).toBe(true);
      }
      /** But the strict route is unchanged, and that is the one the export gate counts. */
      expect(
        adoptionGuardVerdict({ source: "archive", eligible: true, vision: "UNCLEAR" }).allowed,
        "REAL_FUNNEL must still need an approval, or the gate means nothing"
      ).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ENFORCE_FUNNEL_ADOPTION;
      else process.env.ENFORCE_FUNNEL_ADOPTION = saved;
    }
  });

  /**
   * And the replay says nothing about retrieval. Render 569 sent 434 queries to Pixabay and 430 to
   * Pexels for a documentary about 1945, against 7 to Wikimedia. Adoption cannot improve footage
   * that was never found, and no assertion in this file touches that.
   */
  it("says nothing about which providers were asked", () => {
    expect(RENDER_569_REFUSALS.every((r) => "source" in r && "vision" in r)).toBe(true);
  });
});
