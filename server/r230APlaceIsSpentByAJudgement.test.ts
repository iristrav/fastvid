/**
 * RONDE 230 — A PLACE IS SPENT BY A JUDGEMENT, NOT BY AN ARRIVAL.
 *
 * ── What render 576 measured ────────────────────────────────────────────────────────────────
 *
 * Beat s1b5 refused fifty candidates with `SHORTLIST_FULL (8/8)` over eleven minutes while the
 * render's own reject tally held `beat_image_gate:2` FIXED and FUNNEL_WITHOUT_EVIDENCE climbed
 * 78 → 138. Eight places, two real looks. Five genuine Internet Archive clips — past the technical
 * gate, already on disk — were turned away by a bound that had never been spent on a judgement.
 *
 * ── The two halves of the defect ────────────────────────────────────────────────────────────
 *
 * 1. `admitToShortlist` reserves the place BEFORE the editor is asked (videoPipeline 24764 admits,
 *    24785 records the ask), and nothing ever gave one back: no release, no eviction, no
 *    replacement existed anywhere in this codebase.
 *
 * 2. The rescue route called `noteVisionAsked` UNCONDITIONALLY on the line above the judgement.
 *    That is why 576's funnel could report `eligible=53 … unreviewed=45` — visionAsked stood at 8
 *    while only two clips had actually been looked at. The adopt route already did the opposite
 *    and said so in its own comment: "A decline costs no judgement, so it is not counted as one."
 *    The counter was right there and wrong here; the SLOT was wrong in both.
 *
 * ── What this round does NOT do ─────────────────────────────────────────────────────────────
 *
 * The cap is unchanged at MAX_JUDGEMENTS_PER_BEAT × 2. No vision budget moves. No threshold moves.
 * NOT_ASKED does not become FIT. The number of real judgements a beat may buy is still `cap` — a
 * released place was, by definition, never spent on one. Releases are bounded at `cap` per beat so
 * RONDE 97's cost bound survives: at most 2× cap admissions, not a walk of the whole candidate list.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  admitToShortlist,
  beatFunnel,
  createBeatShortlistState,
  formatBeatShortlists,
  noteEligible,
  noteVisionAsked,
  noteVisionOutcome,
  releaseShortlistSlot,
  type BeatShortlistState,
} from "./beatShortlist";

const SRC = fs.readFileSync(path.join(__dirname, "beatShortlist.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const CAP = 8;

/** Admit a candidate the way both production routes do. */
function admit(s: BeatShortlistState, key: string, sc = 1, b = 5) {
  noteEligible(s, sc, b);
  return admitToShortlist(s, sc, b, key, CAP);
}
/** A real look: the editor was asked and answered. */
function looked(s: BeatShortlistState, key: string, sc = 1, b = 5) {
  noteVisionAsked(s, sc, b, key);
}
/** A decline: the gate refused to look, so the place goes back. */
function declined(s: BeatShortlistState, key: string, sc = 1, b = 5) {
  return releaseShortlistSlot(s, sc, b, key, CAP);
}

/* ═══════════ §12 — the render 576 regression ═══════════ */

describe("R230 §12 — eight arrivals nobody looked at do not close the beat", () => {
  it("THE NINTH CANDIDATE IS STILL ADMITTED", () => {
    const s = createBeatShortlistState();
    for (let i = 0; i < CAP; i++) {
      admit(s, `clip-${i}`);
      declined(s, `clip-${i}`);
    }
    expect(beatFunnel(s, 1, 5).visionAsked, "something was asked").toBe(0);
    const ninth = admit(s, "the-good-one");
    expect(ninth.admitted, "render 576's deadlock is still here").toBe(true);
  });

  it("MEASURED: render 576's own shape — fifty arrivals, none looked at", () => {
    const s = createBeatShortlistState();
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      const a = admit(s, `ia-${i}`);
      if (!a.admitted) refused++;
      else declined(s, `ia-${i}`);
    }
    /**
     * Bounded, not unbounded: `cap` releases, so `cap` extra admissions and then the bound holds
     * again. 8 admitted + 8 re-admitted = 16 through, 34 refused. That ceiling is R97's.
     */
    expect(refused, "either the deadlock returned or the release is unbounded").toBe(50 - CAP * 2);
    expect(beatFunnel(s, 1, 5).slotsReleased).toBe(CAP);
  });
});

/* ═══════════ §13 — the cap still caps ═══════════ */

describe("R230 §13 — eight real looks DO close the beat", () => {
  it("SHORTLIST_FULL when the capacity was actually consumed", () => {
    const s = createBeatShortlistState();
    for (let i = 0; i < CAP; i++) {
      admit(s, `clip-${i}`);
      looked(s, `clip-${i}`);
    }
    const ninth = admit(s, "clip-9");
    expect(ninth.admitted, "the cap stopped capping").toBe(false);
    if (ninth.admitted) throw new Error("unreachable");
    expect(ninth.reason).toBe("SHORTLIST_FULL");
  });

  it("and a judged candidate's place is NEVER handed back", () => {
    const s = createBeatShortlistState();
    admit(s, "judged");
    looked(s, "judged");
    const back = declined(s, "judged");
    expect(back.released).toBe(false);
    if (back.released) throw new Error("unreachable");
    expect(back.reason).toBe("ALREADY_ASKED");
  });
});

/* ═══════════ §14 — the two consume differently ═══════════ */

describe("R230 §14 — A declines, B is judged", () => {
  it("A frees its place, B keeps its own", () => {
    const s = createBeatShortlistState();
    admit(s, "A");
    declined(s, "A");
    admit(s, "B");
    looked(s, "B");
    const f = beatFunnel(s, 1, 5);
    expect(f.shortlisted, "only B should still hold a place").toBe(1);
    expect(f.visionAsked).toBe(1);
    expect(f.slotsReleased).toBe(1);
  });
});

/* ═══════════ §15 — no deadlock in front of a good candidate ═══════════ */

describe("R230 §15 — two declines do not bury the third", () => {
  it("C REACHES THE EDITOR", () => {
    const s = createBeatShortlistState();
    for (const k of ["A", "B"]) {
      admit(s, k);
      declined(s, k);
    }
    const c = admit(s, "C");
    expect(c.admitted).toBe(true);
    looked(s, "C");
    noteVisionOutcome(s, 1, 5, "APPROVED");
    expect(beatFunnel(s, 1, 5).approved).toBe(1);
  });
});

/* ═══════════ §16 — a refusal is a verdict, not a vacancy ═══════════ */

describe("R230 §16 — MISMATCH is a judgement and keeps its place", () => {
  it("A=FIT, B=MISMATCH, C=FIT — all three judged, none released", () => {
    const s = createBeatShortlistState();
    for (const [k, outcome] of [["A", "APPROVED"], ["B", "REJECTED"], ["C", "APPROVED"]] as const) {
      admit(s, k);
      looked(s, k);
      noteVisionOutcome(s, 1, 5, outcome);
    }
    const f = beatFunnel(s, 1, 5);
    expect(f.shortlisted).toBe(3);
    expect(f.approved).toBe(2);
    expect(f.rejected).toBe(1);
    expect(f.slotsReleased, "a refusal was treated as a vacancy").toBe(0);
  });

  it("MISMATCH IS NOT A REPLACEMENT MECHANISM — its place stays spent", () => {
    const s = createBeatShortlistState();
    admit(s, "refused");
    looked(s, "refused");
    noteVisionOutcome(s, 1, 5, "REJECTED");
    expect(declined(s, "refused").released).toBe(false);
  });
});

/* ═══════════ §17 — determinism ═══════════ */

describe("R230 §17 — the same candidates give the same pool", () => {
  const run = (order: string[]) => {
    const s = createBeatShortlistState();
    for (const k of order) {
      const a = admit(s, k);
      if (a.admitted) declined(s, k);
    }
    const f = beatFunnel(s, 1, 5);
    return { shortlisted: f.shortlisted, released: f.slotsReleased, capped: f.refusedForCap };
  };

  it("two identical sequences produce identical state", () => {
    const seq = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(run(seq)).toEqual(run(seq));
  });

  it("the outcome depends on the candidates, not on when they arrived", () => {
    /** No clock, no async ordering, no network timing reaches this record. */
    expect(SRC).not.toContain("Date.now()");
    expect(SRC).not.toContain("setTimeout");
    expect(SRC).not.toContain("await ");
  });
});

/* ═══════════ §18 — render isolation ═══════════ */

describe("R230 §18 — one render cannot spend another's places", () => {
  it("two states are independent", () => {
    const a = createBeatShortlistState();
    const b = createBeatShortlistState();
    for (let i = 0; i < CAP; i++) {
      admit(a, `x-${i}`);
      looked(a, `x-${i}`);
    }
    expect(admit(a, "x-9").admitted).toBe(false);
    expect(admit(b, "x-9").admitted, "render B inherited render A's bound").toBe(true);
  });

  it("the record is render-scoped state, not a module-level map", () => {
    expect(SRC).toContain("export function createBeatShortlistState()");
    expect(SRC, "a module-level cache would leak between renders").not.toMatch(
      /^const [a-zA-Z]+ = new Map\(\)/m
    );
  });
});

/* ═══════════ §19 — every provider route, one rule ═══════════ */

describe("R230 §19 — no provider gets an exception", () => {
  it("the release is keyed on content identity, not on a provider name", () => {
    const at = SRC.indexOf("export function releaseShortlistSlot(");
    const fn = SRC.slice(at, at + 1400);
    for (const provider of ["internet_archive", "wikimedia", "pexels", "pixabay", "archive"]) {
      expect(fn, `${provider} got its own branch`).not.toContain(provider);
    }
  });

  it("BOTH production admission routes release, and only on a real decline", () => {
    expect((PIPE.match(/releaseShortlistSlot\(/g) ?? []).length).toBe(2);
    /** The rescue route: gated on the verdict that means nobody looked. */
    expect(PIPE).toContain('if (gateVerdict === "NOT_ASKED") {');
    /** The adopt route: gated on its existing UNREVIEWED evidence. */
    const adopt = PIPE.indexOf('if (beatEvidence !== "UNREVIEWED") {');
    expect(adopt).toBeGreaterThan(0);
    expect(PIPE.slice(adopt, adopt + 900)).toContain("releaseShortlistSlot(");
  });
});

/* ═══════════ §4/§9 — the metric now means what it says ═══════════ */

describe("R230 §9 — visionAsked counts looks, not intentions", () => {
  it("THE RESCUE ROUTE NO LONGER COUNTS AN ASK BEFORE THE JUDGEMENT", () => {
    /**
     * `noteVisionAsked` used to sit on the line above `judgeBeatClipRelevance`. Render 576's
     * `eligible=53 … unreviewed=45` was that lie: 8 asks recorded, 2 looks taken.
     */
    const judge = PIPE.indexOf("const relevance = await judgeBeatClipRelevance(");
    expect(judge).toBeGreaterThan(0);
    const before = PIPE.slice(judge - 400, judge);
    expect(before, "the ask is still recorded before anybody looked").not.toContain(
      "noteVisionAsked(dedup.beatShortlist, scene.index, beat.index, shortlistKey)"
    );
  });

  it("it is recorded after, and only for a verdict that means somebody looked", () => {
    expect(PIPE).toContain('if (gateVerdict !== "NOT_ASKED") {');
    const at = PIPE.indexOf('if (gateVerdict !== "NOT_ASKED") {');
    expect(PIPE.slice(at, at + 260)).toContain("noteVisionAsked(");
  });

  it("VISION_UNAVAILABLE still counts as an ask — that policy is untouched", () => {
    expect(PIPE).toContain('? "VISION_UNAVAILABLE"');
    const at = PIPE.indexOf("const gateVerdict = visionPipelineIsUnavailable()");
    expect(at).toBeGreaterThan(0);
  });

  it("the outcome is still recorded for every candidate", () => {
    expect(PIPE).toContain("noteVisionOutcome(dedup.beatShortlist, scene.index, beat.index, gateVerdict);");
  });
});

/* ═══════════ §33 — structural protection ═══════════ */

describe("R230 §33 — the rules that must not quietly return", () => {
  it("ADMISSION IS NOT AN ASK — the two are separate calls with separate meanings", () => {
    /**
     * Bounded to `admitToShortlist` itself. R230 inserted `releaseShortlistSlot` between it and
     * `beatShortlistExhausted`, and that function must read `askedKeys` — that is precisely how it
     * refuses to hand back a place the editor used. Widening the window past it would assert the
     * opposite of what this round is for.
     */
    const admitAt = SRC.indexOf("export function admitToShortlist(");
    const admitFn = SRC.slice(admitAt, SRC.indexOf("export type SlotRelease ="));
    expect(admitFn.length).toBeGreaterThan(200);
    /**
     * READING the ask count is legitimate and deliberate: R227 made the SHORTLIST_FULL refusal
     * carry `unreviewed = eligible - visionAsked` so the line says whether the bound cost anything.
     * What admission must never do is RECORD one — that is the conflation this round exists to end.
     */
    expect(admitFn, "admission started recording an ask").not.toContain("visionAsked +=");
    expect(admitFn, "admission started marking a key as asked").not.toContain("askedKeys.add");
    /** It reads it, and that read is the R227 refusal line. */
    expect(admitFn).toContain("f.eligible - f.visionAsked");
  });

  it("A RELEASE CANNOT INVENT CAPACITY — it only gives back a place actually held", () => {
    const s = createBeatShortlistState();
    expect(declined(s, "never-admitted").released).toBe(false);
    expect(beatFunnel(s, 1, 5).shortlisted).toBe(0);
    /** And it can never drive the count negative. */
    expect(beatFunnel(s, 1, 5).shortlisted).toBeGreaterThanOrEqual(0);
  });

  it("THE RELEASE IS BOUNDED — R97's cost bound is a hard requirement, not a hope", () => {
    const s = createBeatShortlistState();
    for (let i = 0; i < CAP; i++) {
      admit(s, `k${i}`);
      declined(s, `k${i}`);
    }
    admit(s, "extra");
    const refusedRelease = declined(s, "extra");
    expect(refusedRelease.released).toBe(false);
    if (refusedRelease.released) throw new Error("unreachable");
    expect(refusedRelease.reason).toBe("RELEASE_BUDGET_SPENT");
  });

  it("THE CAP ITSELF IS UNCHANGED", () => {
    expect(SRC).toContain('return envInt("MAX_BEAT_SHORTLIST", MAX_JUDGEMENTS_PER_BEAT * 2, 1, 40);');
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain('export const MAX_JUDGEMENTS_PER_BEAT = envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12);');
    expect(gate).toContain('return envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500);');
  });

  it("NOT_ASKED IS NOT PROMOTED ANYWHERE IN THE RELEASE", () => {
    const at = SRC.indexOf("export function releaseShortlistSlot(");
    const fn = SRC.slice(at, at + 1400);
    for (const forbidden of ["APPROVED", "fits", "approved +=", "visionAsked +="]) {
      expect(fn, `the release rewrote a verdict (${forbidden})`).not.toContain(forbidden);
    }
  });

  it("the returned places are visible on the funnel line", () => {
    const s = createBeatShortlistState();
    admit(s, "a");
    declined(s, "a");
    const line = formatBeatShortlists(s).find((l) => l.includes("s1b5")) ?? "";
    expect(line).toContain("slotsReturned=1");
  });

  it("and stay off it when there were none", () => {
    const s = createBeatShortlistState();
    admit(s, "a");
    looked(s, "a");
    expect(formatBeatShortlists(s).find((l) => l.includes("s1b5")) ?? "").not.toContain("slotsReturned");
  });
});
