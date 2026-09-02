/**
 * THE BEAT LEDGER — what the funnel did, in numbers that mean one thing each.
 *
 * ── Where this comes from ───────────────────────────────────────────────────────────────────
 *
 * The previous round proved the retrieval funnel never reported to the beat outcome audit, so
 * `offered=0` and `noCandidates=10` described `adoptClip`'s bookkeeping rather than the video.
 * That is fixed. This round makes the rest of the funnel's account legible, and the tests below
 * are about SEMANTICS: each counter must mean exactly one thing, and two things that differ must
 * not share a number.
 *
 * ── The three that kept being confused ──────────────────────────────────────────────────────
 *
 *   vision_unclear        a model looked and could not decide — a fact about the PICTURE
 *   vision_never_asked    no model looked: budget, placeholder, gate off — a fact about the RENDER
 *   vision_unavailable    vision should have answered and could not — an outage, an unreadable frame
 *
 * All three used to arrive as `verdict: "unknown"`, and a beat that nobody looked at was reported
 * exactly like a beat whose picture had been examined and found wanting.
 */
import { describe, expect, it } from "vitest";

import {
  beatRecord,
  createBeatOutcomeAudit,
  formatBeatLedgerLine,
  noteBeatAdopted,
  noteBeatCandidatesOffered,
  noteBeatEligible,
  noteBeatVision,
  noteBeatVisionVerdict,
  resolveBeatCoverage,
} from "./beatOutcomeAudit";

/* ═══════════════════════ A / B — the funnel's own numbers ═══════════════════════ */

describe("ledger — the funnel's work reaches the beat record", () => {
  /** Test A: three candidates downloaded and handed to evaluation must read as three. */
  it("three offered candidates read as offered=3", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 1, 7, 3);
    expect(beatRecord(audit, 1, 7).offered).toBe(3);
    expect(formatBeatLedgerLine(beatRecord(audit, 1, 7))).toContain("offered=3");
  });

  /** Test B: one adoption must read as one, with the provider it came from. */
  it("one adoption reads as adopted=1 with its origin", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 1, 7, 3);
    noteBeatEligible(audit, 1, 7);
    noteBeatAdopted(audit, 1, 7, "pexels", "clip.mp4");
    const line = formatBeatLedgerLine(beatRecord(audit, 1, 7));
    expect(line).toContain("adopted=1");
    expect(line).toContain("origin=pexels");
  });
});

/* ═══════════════════════ C / D / E — three facts, three numbers ═══════════════════════ */

describe("ledger — never asked, unclear and unavailable are three different things", () => {
  const ledgerFor = (outcomes: Parameters<typeof noteBeatVisionVerdict>[3][]) => {
    const audit = createBeatOutcomeAudit();
    for (const o of outcomes) noteBeatVisionVerdict(audit, 0, 0, o);
    return beatRecord(audit, 0, 0);
  };

  /** Test C: a candidate nobody looked at is never_asked, and never a rejection. */
  it("a candidate that was never looked at counts as never_asked only", () => {
    const rec = ledgerFor(["never_asked"]);
    expect(rec.visionNeverAsked).toBe(1);
    expect(rec.visionRejected, "a decline was counted as a rejection").toBe(0);
    expect(rec.visionUnclear, "a decline was counted as an uncertainty").toBe(0);
    expect(rec.visionAccepted).toBe(0);
  });

  /** Test D: a model that looked and could not decide is unclear, and was evaluated. */
  it("an unclear verdict counts as unclear only", () => {
    const rec = ledgerFor(["unclear"]);
    expect(rec.visionUnclear).toBe(1);
    expect(rec.visionNeverAsked, "an uncertainty was counted as a decline").toBe(0);
    expect(rec.visionRejected).toBe(0);
  });

  /**
   * Test E: `vision_unavailable` counts a CALL that could not answer, and lives on its own
   * counter — it is not reachable from the verdict function at all, which is the point.
   */
  it("unavailable is a separate counter from never_asked and unclear", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatVision(audit, 0, 0, "unavailable");
    noteBeatVisionVerdict(audit, 0, 0, "never_asked");
    noteBeatVisionVerdict(audit, 0, 0, "unclear");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.visionUnavailable).toBe(1);
    expect(rec.visionNeverAsked).toBe(1);
    expect(rec.visionUnclear).toBe(1);
    const line = formatBeatLedgerLine(rec);
    expect(line).toContain("vision_unavailable=1");
    expect(line).toContain("vision_never_asked=1");
    expect(line).toContain("vision_unclear=1");
  });

  /** The verdict counters are disjoint: one candidate contributes to exactly one of them. */
  it("no candidate is counted twice", () => {
    const rec = ledgerFor(["accepted", "rejected", "rejected", "unclear", "never_asked"]);
    const evaluated = rec.visionAccepted + rec.visionRejected + rec.visionUnclear;
    expect(evaluated, "evaluated must exclude the ones nobody looked at").toBe(4);
    expect(formatBeatLedgerLine(rec)).toContain("vision_evaluated=4");
    expect(rec.visionNeverAsked).toBe(1);
  });
});

/* ═══════════════════════ F / G — REAL_ASSET keeps its meaning ═══════════════════════ */

describe("REAL_ASSET is what the viewer gets, not what the funnel touched", () => {
  /** Test F: an adopted asset — the one that becomes the beat's picture — is REAL_ASSET. */
  it("an adopted asset counts as REAL_ASSET", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 0, 0, "pexels", "clip.mp4");
    expect(resolveBeatCoverage(beatRecord(audit, 0, 0))).toBe("REAL_ASSET");
  });

  /**
   * Test G, the load-bearing one. Downloading, evaluating and even ACCEPTING a candidate is not
   * coverage — a funnel metric read as a viewer metric is the defect this whole programme keeps
   * rediscovering. Only adoption counts.
   */
  it("downloaded, evaluated and accepted is still NOT a REAL_ASSET without adoption", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 5);
    noteBeatVisionVerdict(audit, 0, 0, "accepted");
    noteBeatVisionVerdict(audit, 0, 0, "accepted");
    noteBeatEligible(audit, 0, 0);
    expect(
      resolveBeatCoverage(beatRecord(audit, 0, 0)),
      "an accepted-but-unadopted candidate was counted as coverage"
    ).toBe("NO_VALID_ASSET");
  });

  it("a rejected candidate is not coverage either", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 4);
    noteBeatVisionVerdict(audit, 0, 0, "rejected");
    expect(resolveBeatCoverage(beatRecord(audit, 0, 0))).toBe("NO_VALID_ASSET");
  });
});

/* ═══════════════════════ I / J — no double counting, and monotonic ═══════════════════════ */

describe("ledger — the counters hold together", () => {
  /**
   * Test I. Both routes write to the same record, and each event is counted once by whichever
   * route saw it. Two routes reporting one beat must not inflate it: the funnel offering three and
   * adopting one, plus adoptClip offering two and adopting none, is five offered and one adopted.
   */
  it("two routes on one beat add up rather than double-count", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 3);
    noteBeatAdopted(audit, 0, 0, "pexels", "a.mp4");
    noteBeatCandidatesOffered(audit, 0, 0, 2);
    const rec = beatRecord(audit, 0, 0);
    expect(rec.offered).toBe(5);
    expect(rec.adopted, "the second route re-counted the first route's adoption").toBe(1);
  });

  /**
   * Test J. `adopted <= eligible <= offered` holds wherever one route fed all three. It is
   * asserted here rather than clamped in the code: a counter that silently corrects itself cannot
   * report a wiring bug, and a wiring bug is exactly what this ledger exists to expose.
   */
  it("adopted <= eligible <= offered when one route fed all three", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 4);
    noteBeatEligible(audit, 0, 0);
    noteBeatEligible(audit, 0, 0);
    noteBeatAdopted(audit, 0, 0, "pexels", "a.mp4");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.adopted).toBeLessThanOrEqual(rec.eligible);
    expect(rec.eligible).toBeLessThanOrEqual(rec.offered);
  });

  /**
   * The documented exception. `visionJudged` counts CALLS and the verdict counters count VERDICTS,
   * so neither bounds the other: a cached verdict costs no call, and a timed-out call yields no
   * verdict. Pinned so nobody "fixes" the ledger by forcing them to agree.
   */
  it("vision calls and vision verdicts are allowed to disagree", () => {
    const audit = createBeatOutcomeAudit();
    /** A cached verdict: a verdict with no call behind it. */
    noteBeatVisionVerdict(audit, 0, 0, "accepted");
    /** A call that could not answer: a call with no verdict behind it. */
    noteBeatVision(audit, 0, 0, "unavailable");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.visionAccepted).toBe(1);
    expect(rec.visionJudged).toBe(0);
    expect(rec.visionUnavailable).toBe(1);
  });
});

/* ═══════════════════════ the line prints no invented stage ═══════════════════════ */

describe("ledger — no counter is printed that nothing feeds", () => {
  /**
   * The brief asks for `found`, `ranked`, `timeline` and `rendered` too. Nothing per beat feeds
   * them: the pool is built per scene, ranking runs over that pool before a beat is chosen, and
   * the EDL and render manifest name files rather than beats. Printing them as zeroes would
   * recreate the exact defect this line exists to end — a counter nobody feeds, read as a
   * measurement. This pins that they stay out until a stage really increments them.
   */
  it("omits the stages that are not instrumented rather than printing zeroes", () => {
    const line = formatBeatLedgerLine(beatRecord(createBeatOutcomeAudit(), 0, 0));
    for (const absent of ["found=", "ranked=", "timeline=", "rendered="]) {
      expect(line, `${absent} is printed but nothing feeds it`).not.toContain(absent);
    }
  });

  it("prints the beat it is about", () => {
    expect(formatBeatLedgerLine(beatRecord(createBeatOutcomeAudit(), 2, 5))).toContain("beat=s2b5");
  });
});

/* ═══════════════════════ never_asked reaches the beat's verification ═══════════════════════ */

describe("never_asked is finally producible", () => {
  /**
   * `BeatVerification` has carried a `never_asked` member since RONDE 166 and nothing could
   * produce it: `verificationOf` returned `unknown` for a decline and for a model that looked and
   * could not decide alike, and said so in a comment. The ledger now carries `evaluated`, so the
   * two reach their own words.
   */
  it("a decline reads as never_asked, not unknown", async () => {
    const { __testVerificationOf } = await import("./beatVisualStatus");
    expect(__testVerificationOf({ reprieved: false, verdict: "unknown", evaluated: false }))
      .toBe("never_asked");
  });

  it("a model that looked and could not decide still reads as unknown", async () => {
    const { __testVerificationOf } = await import("./beatVisualStatus");
    expect(__testVerificationOf({ reprieved: false, verdict: "unknown", evaluated: true }))
      .toBe("unknown");
  });

  /** A real verdict is unaffected by the new field, in either direction. */
  it("fits and does_not_fit are unchanged", async () => {
    const { __testVerificationOf } = await import("./beatVisualStatus");
    expect(__testVerificationOf({ reprieved: false, verdict: "fits", evaluated: true }))
      .toBe("verified_fit");
    expect(__testVerificationOf({ reprieved: false, verdict: "does_not_fit", evaluated: true }))
      .toBe("verified_mismatch");
    expect(__testVerificationOf({ reprieved: true, verdict: "does_not_fit", evaluated: true }))
      .toBe("reprieved_after_refusal");
  });
});

/* ═══════════════════════ the funnel really reports all of it ═══════════════════════ */

describe("the funnel is wired to every counter it can feed", () => {
  const CODE = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((l) => !l.trim().startsWith("//")).join("\n");
  })();

  it("records a verdict for every candidate its gate judges", () => {
    const at = CODE.indexOf("for (let look = 0; look < MAX_JUDGEMENTS_PER_BEAT && winner; look++)");
    expect(at, "the funnel's gate loop has moved").toBeGreaterThan(-1);
    const loop = CODE.slice(at, at + 3000);
    /**
     * The verdict is recorded by `judgeBeatClipRelevance`, which is the only thing that calls the
     * gate. It used to be recorded in this loop — which is precisely why the funnel was the ONLY
     * one of the gate's five routes whose answers were counted (61 calls, 16 verdicts on render
     * 562). The claim here is unchanged: this loop's judgements reach the verdict counter.
     */
    expect(loop, "the funnel judges candidates outside the recorder").toContain(
      "judgeBeatClipRelevance("
    );
    const wrapper = CODE.slice(CODE.indexOf("async function judgeBeatClipRelevance("));
    expect(wrapper, "the recorder records no verdict").toContain("noteBeatVisionVerdict(");
    /** And it must read the gate's own `evaluated`, not guess from the verdict alone. */
    expect(wrapper).toContain("decision.evaluated === false");
  });

  /** A decline must map to never_asked and to nothing else. */
  it("maps a decline to never_asked rather than to a rejection", () => {
    const at = CODE.indexOf("noteBeatVisionVerdict(");
    const call = CODE.slice(at, CODE.indexOf(");", CODE.indexOf('"unclear"', at)));
    expect(call).toContain('"never_asked"');
    expect(call).toContain('"accepted"');
    expect(call).toContain('"rejected"');
    expect(call).toContain('"unclear"');
  });
});
