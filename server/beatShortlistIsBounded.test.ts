/**
 * RONDE 95 — THE ENTRANCE, TESTED THE WAY RONDE 94 TESTED THE EXIT.
 *
 * RONDE 94 proved that a bad adoption cannot get out. This proves that the picture editor is asked
 * about a bounded, decided set of candidates rather than whatever happened to arrive first — which
 * is what render 568's `retrieved=3995 … attempts=38` actually described.
 *
 * ── The property that matters most, and why it needs no second gate ─────────────────────────
 *
 * The brief's rule is: a candidate outside the shortlist must not later be adopted as REAL_FUNNEL
 * by some other route. That is enforced by composition rather than by a duplicate check:
 *
 *     not admitted  →  the gate returns before judging  →  no verdict for this asset on this beat
 *                   →  RONDE 94's guard sees NOT_ASKED  →  REAL_FUNNEL refused
 *
 * Adding a separate "was it shortlisted" test in the guard would mean a THIRD identity lookup
 * (path, content key, filename) for a question two of them already answer, and this file's own
 * history says what that costs: RONDE 103's overlay rename, RONDE 94's derived-file chain. So the
 * composition is asserted here, at both ends, instead of being re-implemented at the guard.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_JUDGEMENTS_PER_BEAT } from "./beatImageRelevanceGate";
import {
  admitToShortlist,
  beatFunnel,
  beatShortlistViolations,
  createBeatShortlistState,
  formatBeatShortlists,
  isShortlisted,
  maxShortlistPerBeat,
  noteEligible,
  noteNotAsked,
  noteRetrieved,
  noteVisionAsked,
  noteVisionOutcome,
  reasonsFor,
} from "./beatShortlist";
import { adoptionGuardVerdict } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const ENV = "MAX_BEAT_SHORTLIST";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/* ═══════════════ the bound itself ═══════════════ */

describe("the shortlist bound is derived, not invented", () => {
  /**
   * The brief says not to pick a number blind. This is the derivation, asserted so a later change
   * to the judgement budget cannot silently leave the shortlist behind.
   */
  it("is twice the existing per-beat judgement budget", () => {
    delete process.env[ENV];
    expect(maxShortlistPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT * 2);
  });

  it("is never smaller than the judgements a beat is allowed to spend", () => {
    delete process.env[ENV];
    expect(maxShortlistPerBeat()).toBeGreaterThanOrEqual(MAX_JUDGEMENTS_PER_BEAT);
  });

  it("is configurable within sane limits and ignores nonsense", () => {
    process.env[ENV] = "3";
    expect(maxShortlistPerBeat()).toBe(3);
    process.env[ENV] = "0";
    expect(maxShortlistPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT * 2);
    process.env[ENV] = "9999";
    expect(maxShortlistPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT * 2);
    process.env[ENV] = "banana";
    expect(maxShortlistPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT * 2);
  });
});

/* ═══════════════ admission ═══════════════ */

describe("a beat may put only its shortlist to the picture editor", () => {
  it("admits up to the cap and then refuses by name", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 3; i++) {
      expect(admitToShortlist(state, 0, 0, `k${i}`, 3).admitted).toBe(true);
    }
    const over = admitToShortlist(state, 0, 0, "k3", 3);
    expect(over.admitted).toBe(false);
    expect(over.admitted === false && over.reason).toBe("SHORTLIST_FULL");
    expect(over.slotsUsed).toBe(3);
    expect(over.cap).toBe(3);
  });

  /** The bound is per beat, not per render — a full beat must not starve its neighbour. */
  it("each beat has its own bound", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 3; i++) admitToShortlist(state, 0, 0, `a${i}`, 3);
    expect(admitToShortlist(state, 0, 0, "a9", 3).admitted).toBe(false);
    expect(admitToShortlist(state, 0, 1, "b0", 3).admitted).toBe(true);
    expect(admitToShortlist(state, 1, 0, "c0", 3).admitted).toBe(true);
  });

  /**
   * The same asset reaching the gate twice (a rescue re-offering it, a derivative of one source)
   * must not take a second slot — refusing the second look would deny the beat a verdict for a
   * reason that has nothing to do with the bound.
   */
  it("re-offering the same asset does not spend a second slot", () => {
    const state = createBeatShortlistState();
    expect(admitToShortlist(state, 0, 0, "same", 2).admitted).toBe(true);
    const again = admitToShortlist(state, 0, 0, "same", 2);
    expect(again.admitted).toBe(true);
    expect(again.admitted === true && again.alreadyOnList).toBe(true);
    expect(beatFunnel(state, 0, 0).shortlisted).toBe(1);
    expect(admitToShortlist(state, 0, 0, "other", 2).admitted).toBe(true);
    expect(admitToShortlist(state, 0, 0, "third", 2).admitted).toBe(false);
  });

  /**
   * A candidate with no content identity is counted against the bound rather than waved past it.
   * The conservative direction: an unidentifiable asset is exactly the kind that must not get an
   * unbounded number of free looks.
   */
  it("an unidentifiable candidate still spends a slot", () => {
    const state = createBeatShortlistState();
    expect(admitToShortlist(state, 0, 0, "", 1).admitted).toBe(true);
    expect(admitToShortlist(state, 0, 0, "", 1).admitted).toBe(false);
    expect(isShortlisted(state, 0, 0, "")).toBe(false);
  });

  it("remembers what it admitted", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 2, 1, "asset:7", 4);
    expect(isShortlisted(state, 2, 1, "asset:7")).toBe(true);
    expect(isShortlisted(state, 2, 1, "asset:8")).toBe(false);
    expect(isShortlisted(state, 2, 0, "asset:7"), "a slot on one beat is not a slot on another")
      .toBe(false);
  });

  /** No state at all is a caller outside a render; it must not silently refuse the pipeline. */
  it("is inert without a render state", () => {
    expect(admitToShortlist(undefined, 0, 0, "k").admitted).toBe(true);
    expect(isShortlisted(undefined, 0, 0, "k")).toBe(false);
  });
});

/* ═══════════════ the boundary, as wired into the pipeline ═══════════════ */

describe("the gate is where the boundary is drawn", () => {
  /**
   * One place, for the reason the gate's own doc gives: every rescue and adoption route funnels
   * through it. A bound enforced anywhere else would be a bound some routes do not have.
   */
  it("admission is decided in the one function every route passes through", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("admitToShortlist(dedup.beatShortlist, scene.index, beat.index");
    expect([...PIPE.matchAll(/admitToShortlist\(/g)].length, "a second route admits its own").toBe(1);
  });

  /** THE PROPERTY. Refused admission returns BEFORE the editor is asked, not after. */
  it("a candidate outside the shortlist is never put to the editor", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const admit = body.indexOf("admitToShortlist(");
    const refuse = body.indexOf("if (!admission.admitted)");
    const judge = body.indexOf("judgeBeatClipRelevance(");
    expect(admit).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(admit);
    expect(judge, "the editor is asked before admission is decided").toBeGreaterThan(refuse);
  });

  /** Eligibility is recorded before admission: the bound selects among eligible candidates. */
  it("eligibility is decided before the shortlist, not after", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.indexOf("markEligible(clipPath")).toBeLessThan(body.indexOf("admitToShortlist("));
  });

  /** A refusal is named and recorded, never a silent drop. */
  it("a capped-out candidate is refused with a reason", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const block = body.slice(body.indexOf("if (!admission.admitted)"));
    expect(block).toContain("noteNotAsked(");
    expect(block).toContain("[BeatShortlist]");
    expect(block).toContain('"shortlist_full"');
  });

  /**
   * The composition that makes a second guard check unnecessary: an unadmitted candidate has no
   * verdict, and RONDE 94 already refuses a REAL_FUNNEL claim without an approval.
   */
  it("no verdict means no REAL_FUNNEL, which is what the bound relies on", () => {
    const savedEnv = process.env.ENFORCE_FUNNEL_ADOPTION;
    try {
      delete process.env.ENFORCE_FUNNEL_ADOPTION;
      expect(
        adoptionGuardVerdict({ source: "archive", eligible: true, vision: "NOT_ASKED" }).allowed
      ).toBe(false);
    } finally {
      if (savedEnv === undefined) delete process.env.ENFORCE_FUNNEL_ADOPTION;
      else process.env.ENFORCE_FUNNEL_ADOPTION = savedEnv;
    }
  });

  it("the outcome of every ask is recorded per beat", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("noteVisionAsked(dedup.beatShortlist");
    expect(body).toContain("noteVisionOutcome(");
    /** Read back from the ledger, not from `allowed`, which folds fits and unknown together. */
    expect(body).toContain("relevanceVerdictForRenderedAsset(dedup.beatRelevance");
    expect(body).toContain('"VISION_UNAVAILABLE"');
  });
});

/* ═══════════════ PHASE 2 — the five outcomes, kept apart ═══════════════ */

describe("only APPROVED counts as a positive selection", () => {
  it("records each outcome in its own column", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "APPROVED");
    noteVisionOutcome(state, 0, 0, "REJECTED");
    noteVisionOutcome(state, 0, 0, "UNCLEAR");
    noteVisionOutcome(state, 0, 0, "VISION_UNAVAILABLE");
    noteVisionOutcome(state, 0, 0, "NOT_ASKED");
    const f = beatFunnel(state, 0, 0);
    expect(f.approved).toBe(1);
    expect(f.rejected).toBe(1);
    expect(f.unclear).toBe(1);
    expect(f.unavailable).toBe(1);
    expect(f.notAsked).toBe(1);
  });

  /** A refusal and an unreadable answer are reasons in their own right, not silence. */
  it("a refusal and an unclear answer are named reasons", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "REJECTED");
    noteVisionOutcome(state, 0, 0, "UNCLEAR");
    const reasons = reasonsFor(beatFunnel(state, 0, 0));
    expect(reasons).toContain("REJECTED_BY_EDITOR×1");
    expect(reasons).toContain("UNCLEAR_BY_EDITOR×1");
  });
});

/* ═══════════════ PHASE 10 — never_asked always has a reason ═══════════════ */

describe("a beat without an approval always says why", () => {
  it("nothing retrieved", () => {
    const state = createBeatShortlistState();
    beatFunnel(state, 0, 0);
    expect(reasonsFor(beatFunnel(state, 0, 0))).toEqual(["NO_CANDIDATES×1"]);
  });

  it("retrieved but nothing eligible", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 12);
    expect(reasonsFor(beatFunnel(state, 0, 0))).toEqual(["NO_ELIGIBLE_CANDIDATES×1"]);
  });

  it("eligible but never shortlisted", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 12);
    noteEligible(state, 0, 0);
    expect(reasonsFor(beatFunnel(state, 0, 0))).toEqual(["SHORTLIST_EMPTY×1"]);
  });

  it("shortlisted, asked, and refused — the reason is the refusal", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 12);
    noteEligible(state, 0, 0);
    admitToShortlist(state, 0, 0, "k0");
    noteVisionAsked(state, 0, 0);
    noteVisionOutcome(state, 0, 0, "REJECTED");
    expect(reasonsFor(beatFunnel(state, 0, 0))).toEqual(["REJECTED_BY_EDITOR×1"]);
  });

  /** An approval needs no excuse, and printing one would be noise. */
  it("an approved beat has no reason to give", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 3);
    noteEligible(state, 0, 0);
    admitToShortlist(state, 0, 0, "k0");
    noteVisionAsked(state, 0, 0);
    noteVisionOutcome(state, 0, 0, "APPROVED");
    expect(reasonsFor(beatFunnel(state, 0, 0))).toEqual([]);
  });

  /**
   * THE RENDER-568 DEFECT, AS A STANDING CHECK. A beat that ends with no approval and no reason
   * is exactly `verification=never_asked reason=real_footage_never_judged`, and it can no longer
   * be reported as a blank.
   */
  it("never returns an empty explanation for a beat with no approval", () => {
    const state = createBeatShortlistState();
    for (const setup of [
      () => undefined,
      () => noteRetrieved(state, 0, 0, 5),
      () => noteEligible(state, 0, 0),
      () => admitToShortlist(state, 0, 0, "x"),
      () => noteVisionAsked(state, 0, 0),
    ]) {
      setup();
      expect(reasonsFor(beatFunnel(state, 0, 0)).length).toBeGreaterThan(0);
    }
  });

  it("every taxonomy reason survives into the beat's account", () => {
    const state = createBeatShortlistState();
    const reasons = [
      "NO_CANDIDATES", "NO_ELIGIBLE_CANDIDATES", "SHORTLIST_EMPTY", "SHORTLIST_FULL",
      "VISION_BUDGET_EXHAUSTED", "VISION_UNAVAILABLE", "DUPLICATE", "REJECTED_BY_EDITOR",
      "UNCLEAR_BY_EDITOR", "PROVIDER_FAILURE", "DOWNLOAD_FAILURE", "PREPARATION_FAILURE",
      "NOT_REACHED", "POLICY_BLOCKED",
    ] as const;
    for (const r of reasons) noteNotAsked(state, 5, 5, r);
    const printed = reasonsFor(beatFunnel(state, 5, 5)).join(",");
    for (const r of reasons) expect(printed, `${r} is not reported`).toContain(r);
  });
});

/* ═══════════════ the record, and the invariants it makes checkable ═══════════════ */

describe("the per-beat funnel is reported and checked", () => {
  it("prints nothing for a render that produced no beats", () => {
    expect(formatBeatShortlists(createBeatShortlistState())).toEqual([]);
    expect(formatBeatShortlists(undefined)).toEqual([]);
  });

  it("prints one line per beat plus a total, with the cap stated", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 40);
    noteEligible(state, 0, 0);
    admitToShortlist(state, 0, 0, "k");
    noteVisionAsked(state, 0, 0);
    noteVisionOutcome(state, 0, 0, "APPROVED");
    noteRetrieved(state, 1, 0, 7);
    const lines = formatBeatShortlists(state);
    expect(lines[0]).toContain("shortlist cap=");
    expect(lines.some((l) => l.includes("s0b0") && l.includes("approved=1"))).toBe(true);
    expect(lines.some((l) => l.includes("s1b0") && l.includes("NO_ELIGIBLE_CANDIDATES"))).toBe(true);
    expect(lines[lines.length - 1]).toContain("[BeatFunnel] TOTAL beats=2");
  });

  it("a healthy beat trips no invariant", () => {
    const state = createBeatShortlistState();
    noteRetrieved(state, 0, 0, 5);
    noteEligible(state, 0, 0);
    admitToShortlist(state, 0, 0, "k");
    noteVisionAsked(state, 0, 0);
    noteVisionOutcome(state, 0, 0, "APPROVED");
    expect(beatShortlistViolations(state)).toEqual([]);
  });

  /** Vision asked more often than the beat had shortlist slots means a route went round the bound. */
  it("catches a judgement spent outside the shortlist", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 0, "k");
    noteVisionAsked(state, 0, 0);
    noteVisionAsked(state, 0, 0);
    noteVisionOutcome(state, 0, 0, "APPROVED");
    expect(beatShortlistViolations(state).join(" ")).toContain("VISION_OUTSIDE_SHORTLIST");
  });

  it("catches an approval nobody asked for", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 0, "k");
    noteVisionOutcome(state, 0, 0, "APPROVED");
    expect(beatShortlistViolations(state).join(" ")).toContain("APPROVED_WITHOUT_ASK");
  });

  it("catches a shortlist that grew past its cap", () => {
    const state = createBeatShortlistState();
    const f = beatFunnel(state, 0, 0);
    f.shortlisted = maxShortlistPerBeat() + 1;
    f.approved = 1;
    f.visionAsked = 1;
    expect(beatShortlistViolations(state).join(" ")).toContain("SHORTLIST_OVER_CAP");
  });

  /** The render prints the record and the violations; a silent funnel is the old behaviour. */
  it("the render reports both", () => {
    expect(PIPE).toContain("formatBeatShortlists(visualDedup.beatShortlist)");
    expect(PIPE).toContain("beatShortlistViolations(visualDedup.beatShortlist)");
  });

  /** Retrieval is counted where a route's candidate list for one beat is complete. */
  it("retrieval is counted once, at the multi-candidate entry point", () => {
    expect([...PIPE.matchAll(/noteRetrieved\(/g)].length).toBe(1);
    const at = PIPE.indexOf("noteRetrieved(dedup.beatShortlist");
    expect(PIPE.slice(Math.max(0, at - 700), at)).toContain("uniqueKeys");
  });
});
