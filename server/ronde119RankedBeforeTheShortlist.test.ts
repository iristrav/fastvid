/**
 * RONDE 119 — THE ZERO THAT MADE ME DIAGNOSE THE WRONG THING.
 *
 * ── What every beat of render 572 said ──────────────────────────────────────────────────────
 *
 *     [BeatFunnel] s0b0 retrieved=0 eligible=40 ranked=0 shortlisted=8/8 visionAsked=8
 *                  notAsked=32 cappedOut=32 reasons=SHORTLIST_FULL×32
 *
 * I read that `ranked=0` in RONDE 117 as "admission has no ranking in it, so the eight questions
 * are spent on the first eight candidates that happen to arrive". That reading is wrong, and this
 * file exists so nobody repeats it.
 *
 * `noteRanked` was written for this counter, exported, documented — "One candidate was placed in
 * a route's ranked order" — and never called once in production. The zero was not measuring an
 * unranked funnel; it was measuring nothing at all. Meanwhile the adopt loop reads
 * `finalPaths = [...tasteResult.rankedPaths]` and walks it from the top, so on that route the
 * editor is asked about the BEST eight, not the earliest eight.
 *
 * ── Why the counter still earns its keep ────────────────────────────────────────────────────
 *
 * The shortlist is shared across every route that can fill a beat. A rescue ladder spending slots
 * before the ranked loop runs would leave `shortlisted=8` with `ranked` far below it — and that
 * gap is the actual question: is the editor being shown the best pictures, or the earliest ones?
 * Nothing could show it before. Now the number is a measurement and can be trusted as one.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  admitToShortlist,
  createBeatShortlistState,
  formatBeatShortlists,
  noteEligible,
  noteRanked,
  type BeatShortlistState,
} from "./beatShortlist";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("the ranked counter has a caller", () => {
  it("is called where the ranked list is built, with that list's length", () => {
    const at = PIPE.indexOf("const finalPaths = [...tasteResult.rankedPaths];");
    expect(at).toBeGreaterThan(-1);
    const after = PIPE.slice(at, at + 1800);
    expect(after).toContain("noteRanked(dedup.beatShortlist, sceneIndex, beatIndex, finalPaths.length)");
  });

  it("counts the ranked order BEFORE the loop that spends the shortlist", () => {
    const ranked = PIPE.indexOf("noteRanked(dedup.beatShortlist, sceneIndex, beatIndex");
    const spend = PIPE.indexOf("beatShortlistExhausted(dedup.beatShortlist, sceneIndex, beatIndex)");
    expect(ranked).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(ranked);
  });

  it("the list it counts is the ranked one, not the raw pool", () => {
    /** `applyDocumentaryTasteModel` over the director's ranked paths — the order is the point. */
    const at = PIPE.indexOf("const finalPaths = [...tasteResult.rankedPaths];");
    const before = PIPE.slice(Math.max(0, at - 700), at);
    expect(before).toContain("applyDocumentaryTasteModel(");
  });
});

describe("what the counter now lets a render say", () => {
  const beat = (): BeatShortlistState => createBeatShortlistState();

  it("ranked matches the offered order when one ranked route filled the shortlist", () => {
    const state = beat();
    for (let i = 0; i < 12; i++) noteEligible(state, 0, 0);
    noteRanked(state, 0, 0, 12);
    for (let i = 0; i < 12; i++) admitToShortlist(state, 0, 0, `asset:${i}`, 8);
    const line = formatBeatShortlists(state).find((l) => l.includes("s0b0"))!;
    expect(line).toContain("eligible=12");
    expect(line).toContain("ranked=12");
    expect(line).toContain("shortlisted=8/8");
  });

  it("and shows the gap when slots were spent by a route that ranked nothing", () => {
    /**
     * The shape that used to be invisible: eight questions asked, none of them from a ranked
     * order. Before this round it printed `ranked=0` and so did the healthy case.
     */
    const state = beat();
    for (let i = 0; i < 12; i++) noteEligible(state, 0, 0);
    for (let i = 0; i < 8; i++) admitToShortlist(state, 0, 0, `rescue:${i}`, 8);
    noteRanked(state, 0, 0, 4);
    const line = formatBeatShortlists(state).find((l) => l.includes("s0b0"))!;
    expect(line).toContain("ranked=4");
    expect(line).toContain("shortlisted=8/8");
  });
});

/* ═══════════════ the design facts this round proved, held in place ═══════════════ */

describe("the shortlist's actual behaviour, asserted rather than assumed", () => {
  it("is per beat — one beat's slots are not another's", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 8; i++) admitToShortlist(state, 0, 0, `a:${i}`, 8);
    expect(admitToShortlist(state, 0, 0, "a:9", 8).admitted).toBe(false);
    /** A different beat still has all eight. */
    expect(admitToShortlist(state, 0, 1, "a:9", 8).admitted).toBe(true);
  });

  it("a slot is spent by the ASK, not returned by the answer", () => {
    /**
     * Deliberate, and worth stating: the cap IS the vision budget
     * (`maxShortlistPerBeat()` derives from MAX_JUDGEMENTS_PER_BEAT). Returning a slot when the
     * editor says no would mean asking a ninth question — spending budget the render does not
     * have. So a refused candidate keeps its slot, and a beat that spends eight on refusals ends
     * without an approved picture. That is a trade-off, not a bug, and changing it is a budget
     * decision rather than a code fix.
     */
    const state = createBeatShortlistState();
    for (let i = 0; i < 8; i++) admitToShortlist(state, 0, 0, `a:${i}`, 8);
    expect(admitToShortlist(state, 0, 0, "better-candidate", 8)).toMatchObject({
      admitted: false,
      reason: "SHORTLIST_FULL",
    });
  });

  it("the same asset offered twice does not spend a second slot", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 0, "asset:same", 8);
    const again = admitToShortlist(state, 0, 0, "asset:same", 8);
    expect(again.admitted).toBe(true);
    expect(again.alreadyOnList).toBe(true);
    expect(again.slotsUsed).toBe(1);
  });
});
