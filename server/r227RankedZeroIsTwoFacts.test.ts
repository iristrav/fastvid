/**
 * RONDE 227 — A COUNTER THAT CANNOT SEPARATE "DID NOT RUN" FROM "RAN AND PRODUCED NONE".
 *
 * Render 576 died with `Scene 1: 7 zinnen maar 0 voice/script-matchende clips`, and the fifty
 * shortlist refusals it printed all read:
 *
 *     [BeatShortlist] s1b5 not asked — SHORTLIST_FULL (8/8) route=internet_archive
 *                     eligible=53 ranked=0 unreviewed=45
 *
 * ── What was established statically before this round ───────────────────────────────────────
 *
 * `noteRanked` has exactly ONE caller, at videoPipeline.ts ~24415, inside `adoptClip`. Between
 * that function's first line and that call there is no body-level `return` and no `throw`, so the
 * call is reached whenever the route runs at all. It is called as
 * `noteRanked(state, s, b, finalPaths.length)`.
 *
 * `noteEligible` has TWO callers: one in `adoptClip` (~24754) and one in `beatClipPassesVisionGate`
 * (~29412), the rescue side. `admitToShortlist` likewise: ~24755 (route=adopt) and ~29435
 * (route=<provider>). Render 576's refusals are labelled `route=internet_archive`, i.e. the rescue
 * side, and they carry `eligible=53` with `ranked=0`.
 *
 * ── The gap this round closes ───────────────────────────────────────────────────────────────
 *
 * `ranked += 0` leaves the field at zero, and so does never calling the function. Both histories
 * print `ranked=0` and they demand opposite fixes: one accuses whatever was supposed to fill the
 * ranking route's input, the other accuses the ranking itself. RONDE 119 is the standing warning —
 * this exact counter read zero once before and the zero was interpreted rather than measured.
 *
 * So the call is now recorded separately from what it reports, and the input separately from the
 * output. Reporting only: no verdict changes, no gate moves, no threshold moves, no cap raised,
 * no shortlist reordered, no refused candidate re-admitted.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  admitToShortlist,
  beatFunnel,
  beatShortlistViolations,
  createBeatShortlistState,
  formatBeatShortlists,
  noteEligible,
  noteRanked,
} from "./beatShortlist";

const SHORTLIST = fs.readFileSync(path.join(__dirname, "beatShortlist.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 1. the two histories that both used to print ranked=0 ═══════════ */

describe("R227 §1 — a zero that says which zero it is", () => {
  it("MEASURED: a route that never ran leaves rankRuns at zero", () => {
    const state = createBeatShortlistState();
    noteEligible(state, 1, 5);
    const f = beatFunnel(state, 1, 5);
    expect(f.ranked).toBe(0);
    expect(f.rankRuns, "an untouched beat claims the ranking route ran").toBe(0);
  });

  it("MEASURED: a route that ran and ordered nothing leaves rankRuns at ONE", () => {
    const state = createBeatShortlistState();
    noteRanked(state, 1, 5, 0, 0);
    const f = beatFunnel(state, 1, 5);
    expect(f.ranked).toBe(0);
    expect(f.rankRuns, "the call left no trace — the R227 defect is back").toBe(1);
  });

  it("THE TWO ARE DISTINGUISHABLE — which is the entire point of the round", () => {
    const neverRan = createBeatShortlistState();
    noteEligible(neverRan, 0, 0);

    const ranEmpty = createBeatShortlistState();
    noteEligible(ranEmpty, 0, 0);
    noteRanked(ranEmpty, 0, 0, 0, 0);

    expect(beatFunnel(neverRan, 0, 0).ranked).toBe(beatFunnel(ranEmpty, 0, 0).ranked);
    expect(
      beatFunnel(neverRan, 0, 0).rankRuns,
      "the two histories still look identical"
    ).not.toBe(beatFunnel(ranEmpty, 0, 0).rankRuns);
  });

  it("AND THE INPUT IS RECORDED — eleven handed over, none ordered, is its own accusation", () => {
    const state = createBeatShortlistState();
    noteRanked(state, 1, 5, 0, 11);
    const f = beatFunnel(state, 1, 5);
    expect(f.rankRuns).toBe(1);
    expect(f.rankInput, "the ranking's supply is not recorded").toBe(11);
    expect(f.ranked).toBe(0);
  });

  it("repeated runs accumulate both, because a beat can be ranked by more than one route", () => {
    const state = createBeatShortlistState();
    noteRanked(state, 2, 3, 4, 9);
    noteRanked(state, 2, 3, 2, 5);
    const f = beatFunnel(state, 2, 3);
    expect(f.rankRuns).toBe(2);
    expect(f.rankInput).toBe(14);
    expect(f.ranked).toBe(6);
  });

  it("an omitted inputCount is not invented — the field stays at zero rather than copying count", () => {
    /**
     * Defaulting `rankInput` to `count` would make every legacy call report a supply it never
     * measured, which is exactly the cosmetic kind of metric this codebase forbids.
     */
    const state = createBeatShortlistState();
    noteRanked(state, 0, 1, 7);
    const f = beatFunnel(state, 0, 1);
    expect(f.ranked).toBe(7);
    expect(f.rankRuns).toBe(1);
    expect(f.rankInput, "an unmeasured input was filled in from the output").toBe(0);
  });

  it("a missing state is still a no-op — the guard is unchanged", () => {
    expect(() => noteRanked(undefined, 0, 0, 3, 3)).not.toThrow();
  });
});

/* ═══════════ 2. the numbers reach a reader ═══════════ */

describe("R227 §2 — printed beside the number it qualifies", () => {
  const lineFor = (state: ReturnType<typeof createBeatShortlistState>) =>
    formatBeatShortlists(state).find((l) => l.includes("s1b5")) ?? "";

  it("RANKRUNS IS ON THE FUNNEL LINE", () => {
    const state = createBeatShortlistState();
    noteEligible(state, 1, 5);
    expect(lineFor(state)).toContain("rankRuns=0");
  });

  it("printed ALWAYS, not only when zero — an absent field is not a signal a reader notices", () => {
    const state = createBeatShortlistState();
    noteRanked(state, 1, 5, 3, 8);
    const line = lineFor(state);
    expect(line).toContain("ranked=3");
    expect(line).toContain("rankRuns=1");
  });

  it("the input appears once the route has actually run", () => {
    const ran = createBeatShortlistState();
    noteRanked(ran, 1, 5, 0, 11);
    expect(lineFor(ran)).toContain("rankIn=11");

    const never = createBeatShortlistState();
    noteEligible(never, 1, 5);
    expect(lineFor(never), "a route that never ran reports a supply").not.toContain("rankIn=");
  });

  it("MEASURED: render 576's shape now reads unambiguously", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 53; i++) noteEligible(state, 1, 5);
    for (let i = 0; i < 8; i++) admitToShortlist(state, 1, 5, `clip-${i}`, 8);
    const refused = admitToShortlist(state, 1, 5, "clip-9", 8);

    expect(refused.admitted).toBe(false);
    if (refused.admitted) throw new Error("unreachable");
    expect(refused.reason).toBe("SHORTLIST_FULL");
    expect(refused.eligible).toBe(53);
    expect(refused.ranked).toBe(0);
    expect(
      refused.rankRuns,
      "the refusal still cannot say whether the ranking route ever ran"
    ).toBe(0);
  });

  it("the existing fields are untouched — this adds, it does not rewrite", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 3; i++) noteEligible(state, 0, 0);
    const line = formatBeatShortlists(state).find((l) => l.includes("s0b0")) ?? "";
    for (const field of [
      "retrieved=",
      "eligible=3",
      "shortlisted=0/",
      "visionAsked=",
      "approved=",
      "rejected=",
      "unclear=",
      "unavailable=",
      "notAsked=",
    ]) {
      expect(line, `${field} left the funnel line`).toContain(field);
    }
  });
});

/* ═══════════ 3. the invariant RONDE 119 predicted ═══════════ */

describe("R227 §3 — slots spent by arrival order, with nothing ranked", () => {
  const filledUnranked = () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 20; i++) noteEligible(state, 1, 5);
    for (let i = 0; i < 8; i++) admitToShortlist(state, 1, 5, `clip-${i}`, 8);
    admitToShortlist(state, 1, 5, "refused", 8);
    return state;
  };

  it("IT FIRES — every slot to arrival order, candidates refused, ranking never run", () => {
    const found = beatShortlistViolations(filledUnranked()).filter((l) =>
      l.includes("SHORTLIST_FILLED_UNRANKED")
    );
    expect(found.length, "the gap is still only inferable").toBe(1);
    expect(found[0]).toContain("s1b5");
    expect(found[0]).toContain("rankRuns=0");
    expect(found[0]).toContain("cappedOut=1");
  });

  it("IT DOES NOT FIRE once the ranking route has run", () => {
    const state = filledUnranked();
    noteRanked(state, 1, 5, 6, 12);
    expect(
      beatShortlistViolations(state).filter((l) => l.includes("SHORTLIST_FILLED_UNRANKED")).length
    ).toBe(0);
  });

  it("IT DOES NOT FIRE on a beat that never hit its bound — no cappedOut, no complaint", () => {
    /**
     * A beat served entirely by the rescue side without ever refusing anyone has lost nothing.
     * Firing there would turn a real finding into background noise.
     */
    const state = createBeatShortlistState();
    for (let i = 0; i < 3; i++) noteEligible(state, 0, 1);
    for (let i = 0; i < 3; i++) admitToShortlist(state, 0, 1, `c${i}`, 8);
    expect(
      beatShortlistViolations(state).filter((l) => l.includes("SHORTLIST_FILLED_UNRANKED")).length
    ).toBe(0);
  });

  it("BOTH HALVES ARE REQUIRED — a cap refusal alone is not the finding", () => {
    const source = SHORTLIST.slice(SHORTLIST.indexOf("SHORTLIST_FILLED_UNRANKED") - 900);
    expect(source).toContain("f.refusedForCap > 0 && f.rankRuns === 0");
  });

  it("REPORTED, NOT ENFORCED — nothing here admits, reorders or raises", () => {
    const at = SHORTLIST.indexOf("SHORTLIST_FILLED_UNRANKED shortlisted=");
    const block = SHORTLIST.slice(at - 1200, at + 400);
    expect(block).not.toContain("admitToShortlist(");
    expect(block).not.toContain("cap +");
    expect(block).not.toContain("f.shortlisted -=");
    expect(block).not.toContain("throw ");
  });

  it("the other four invariants still stand", () => {
    for (const name of [
      "SHORTLIST_OVER_CAP",
      "VISION_OUTSIDE_SHORTLIST",
      "VISION_REPEAT_ASKS",
      "APPROVED_WITHOUT_ASK",
      "UNEXPLAINED_NO_APPROVAL",
    ]) {
      expect(SHORTLIST, `${name} was dropped`).toContain(name);
    }
  });
});

/* ═══════════ 4. the answers reach the place the render dies ═══════════ */

describe("R227 §4 — read where it matters, not only in the report", () => {
  it("THE INVARIANTS ARE PRINTED AT THE SCENE GATE", () => {
    expect(
      PIPE,
      "beatShortlistViolations still has one reader, past the throw"
    ).toContain("for (const line of beatShortlistViolations(dedup.beatShortlist)) console.error(line);");
  });

  it("BEFORE the throw, and after the funnel it qualifies", () => {
    const funnel = PIPE.indexOf("formatBeatShortlists(dedup.beatShortlist)");
    const inv = PIPE.indexOf("beatShortlistViolations(dedup.beatShortlist)");
    const thrown = PIPE.indexOf("voice/script-matchende clips — export geblokkeerd");
    expect(inv).toBeGreaterThan(funnel);
    expect(inv, "the invariants print after the render has thrown").toBeLessThan(thrown);
  });

  it("the report's own copy is untouched — one checker, two readers", () => {
    expect((PIPE.match(/beatShortlistViolations\(/g) ?? []).length).toBe(2);
    expect(PIPE).toContain("for (const line of beatShortlistViolations(visualDedup.beatShortlist)) {");
  });

  it("THE ONE CALLER FEEDS ITS INPUT SIZE", () => {
    expect(PIPE).toContain(
      "noteRanked(dedup.beatShortlist, sceneIndex, beatIndex, finalPaths.length, paths.length);"
    );
  });

  it("still exactly one caller — a second would make rankRuns mean something else", () => {
    const calls = [...PIPE.matchAll(/^\s+noteRanked\(/gm)].length;
    expect(calls, "noteRanked gained or lost a call site").toBe(1);
  });

  it("BOTH refusal lines carry rankRuns — adopt and rescue alike", () => {
    expect((PIPE.match(/rankRuns=\$\{admission\.rankRuns \?\? 0\}/g) ?? []).length).toBe(2);
  });

  it("NOTHING WAS DECIDED — the scene gate still only reports", () => {
    const at = PIPE.indexOf("const why = formatNoVerdictReasons(dedup.beatImageGate);");
    const block = PIPE.slice(at, PIPE.indexOf("if (!curatedArchiveOnlyVisuals()) {", at));
    expect(block).not.toContain("continue;");
    expect(block).not.toContain("admitToShortlist");
    expect(block).not.toContain("noteAskImpossible");
  });
});
