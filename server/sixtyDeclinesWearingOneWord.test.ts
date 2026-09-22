/**
 * SIXTY DECLINES WEARING ONE WORD — RONDE 619.
 *
 * ── What render 597 said ────────────────────────────────────────────────────────────────────
 *
 *     [BeatRelevance] attempts=118 answered=117 fits=21 does_not_fit=96 never_asked=60
 *
 * Sixty pictures never put to the picture editor, reported as one number. "The render's budget was
 * spent", "this beat had already been looked at twice", "there was no readable frame" and "the gate
 * is switched off" are four findings with four different fixes, and a reader cannot tell from that
 * line whether the editor was overworked or never wired up at all.
 *
 * That distinction is the one this whole line of work needs: it is the difference between a
 * picture REFUSED and a picture NOT LOOKED AT, and every question about why a render is thin ends
 * up there.
 *
 * ── The causes were never missing ───────────────────────────────────────────────────────────
 *
 * `declined()` takes a `VisionDeclineCause` as its FIRST argument, deliberately, so that no call
 * site can omit one — and the per-beat `[BeatLookups]` line already prints a breakdown of its own.
 * Nothing carried them to the render's summary. That is this codebase's signature defect: an
 * answer computed correctly on one side and never handed to the side that reports.
 *
 * ── What changed ────────────────────────────────────────────────────────────────────────────
 *
 * A counter beside the one that already existed, moved by the same call, and printed. No verdict,
 * threshold, budget or gate is touched: a render that declined sixty looks still declines sixty,
 * and now says which sixty.
 *
 * A typed counter rather than a match on `noVerdictReasons`, for the reason that field's own note
 * already gives — prose rots the moment a message is reworded — and because `noVerdictReasons`
 * mixes evaluated non-verdicts in with the declines, so it cannot answer this question anyway.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { createBeatImageGateState, noteJudgementSkipped } from "./beatImageRelevanceGate";
import { createBeatRelevanceLedger, formatRelevanceSummary } from "./beatVisualRelevance";

const GATE_SRC = readFileSync(join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
const REL_SRC = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");

const summaryOf = (fill: (s: ReturnType<typeof createBeatImageGateState>) => void) => {
  const state = createBeatImageGateState();
  fill(state);
  return formatRelevanceSummary(state, createBeatRelevanceLedger());
};

/* ═══════════ §1 — render 597's own line, answered ═══════════ */

describe("§1 — sixty declines, now itemised", () => {
  /** The shape render 597 reported, spread over causes the gate can actually produce. */
  const sixty = summaryOf((s) => {
    for (let i = 0; i < 31; i++) noteJudgementSkipped(s, "RENDER_BUDGET_SPENT");
    for (let i = 0; i < 18; i++) noteJudgementSkipped(s, "BEAT_LOOK_CEILING");
    for (let i = 0; i < 7; i++) noteJudgementSkipped(s, "NO_FRAME");
    for (let i = 0; i < 4; i++) noteJudgementSkipped(s, "NO_NARRATION");
  });

  it("THE TOTAL IS UNCHANGED — this round reports, it does not decline less", () => {
    expect(sixty).toContain("never_asked=60");
  });

  it("AND THE LINE NOW SAYS WHICH SIXTY", () => {
    expect(sixty).toContain("render_budget_spent=31");
    expect(sixty).toContain("beat_look_ceiling=18");
    expect(sixty).toContain("no_frame=7");
    expect(sixty).toContain("no_narration=4");
  });

  it("most frequent first, so the line leads with the thing worth fixing", () => {
    const detail = sixty.slice(sixty.indexOf("never_asked=60 ("));
    const order = ["render_budget_spent", "beat_look_ceiling", "no_frame", "no_narration"].map((c) =>
      detail.indexOf(c)
    );
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b), "the causes are not in descending order").toEqual(order);
  });

  it("the two kinds of decline are now distinguishable — which is the whole point", () => {
    /**
     * "the render was thrifty" (budget, ceiling) vs "the render could not see" (no frame, no
     * narration, gate off). One number could not separate them; these four names do.
     */
    const thrifty = summaryOf((s) => noteJudgementSkipped(s, "RENDER_BUDGET_SPENT"));
    const blind = summaryOf((s) => noteJudgementSkipped(s, "NO_FRAME"));
    expect(thrifty).not.toEqual(blind);
    expect(thrifty).toContain("render_budget_spent=1");
    expect(blind).toContain("no_frame=1");
  });
});

/* ═══════════ §2 — the counters cannot drift apart ═══════════ */

describe("§2 — one call moves the total and the breakdown", () => {
  it("THE PARTS SUM TO THE TOTAL, by construction", () => {
    const state = createBeatImageGateState();
    for (const cause of ["NO_FRAME", "NO_FRAME", "GATE_DISABLED", "RENDER_BUDGET_SPENT"]) {
      noteJudgementSkipped(state, cause);
    }
    const parts = [...state.judgementsSkippedByCause.values()].reduce((a, b) => a + b, 0);
    expect(parts).toBe(state.judgementsSkipped);
  });

  it("and a total the parts DO NOT explain is named, not smoothed over", () => {
    const drift = summaryOf((s) => {
      noteJudgementSkipped(s, "NO_FRAME");
      /** As if some site incremented the total without naming a cause. */
      s.judgementsSkipped += 5;
    });
    expect(drift).toContain("never_asked=6");
    expect(drift, "a wiring fault must be visible in the line itself").toContain(
      "SKIP_CAUSES_INCOMPLETE parts=1"
    );
  });

  it("A DECLINE WITH NO CAUSE IS RECORDED, NOT DROPPED", () => {
    /** A decline this module cannot explain is itself the finding. */
    expect(summaryOf((s) => noteJudgementSkipped(s, "   "))).toContain("unnamed=1");
  });

  it("the total is moved in ONE place, so a new decline cannot forget the breakdown", () => {
    expect(GATE_SRC).toContain("export function noteJudgementSkipped(");
    /** The helper's own increment is the one that is allowed; every other one is the defect. */
    const at = GATE_SRC.indexOf("export function noteJudgementSkipped(");
    const helper = GATE_SRC.slice(at, GATE_SRC.indexOf("\n}", at));
    expect(helper).toContain("state.judgementsSkipped++");
    const outsideHelper = (GATE_SRC.slice(0, at) + GATE_SRC.slice(at + helper.length)).match(
      /judgementsSkipped\+\+/g
    );
    expect(outsideHelper ?? [], "a site in the gate increments the total on its own").toEqual([]);
    expect(
      REL_SRC.match(/judgementsSkipped\+\+/g) ?? [],
      "a site in the relevance module increments the total on its own"
    ).toEqual([]);
  });
});

/* ═══════════ §3 — a clean render says nothing extra ═══════════ */

describe("§3 — the line does not grow when there is nothing to say", () => {
  it("nothing skipped prints no bracket at all", () => {
    const clean = summaryOf(() => {});
    expect(clean).toContain("never_asked=0");
    expect(clean, "an empty bracket is noise").not.toContain("never_asked=0 (");
  });

  it("and the rest of the line is exactly as it was", () => {
    const clean = summaryOf(() => {});
    expect(clean).toContain("[BeatRelevance] render summary — attempts=0 answered=0");
    expect(clean).toContain("clips: fits=0 does_not_fit=0 (reprieved=0) unknown=0");
  });
});

/* ═══════════ §4 — nothing about the gate itself moved ═══════════ */

describe("§4 — reporting only", () => {
  it("the decline causes are still required at the call site", () => {
    /** `declined()` takes the cause FIRST so no site can omit it — unchanged. */
    expect(GATE_SRC).toContain("const declined = (cause: VisionDeclineCause, reason: string)");
  });

  it("the per-beat ceiling and the render budget are the numbers they were", () => {
    expect(REL_SRC).toContain("spentOnBeat >= maxRelevanceLooksPerBeat() && !params.finalSay");
    expect(GATE_SRC).toContain(
      "state.judgementAttempts >= maxBeatImageJudgementsPerRender() && !params.finalSay"
    );
  });

  it("and the final look still overrules both, as RONDE 199 left it", () => {
    expect(GATE_SRC).toContain("!params.finalSay");
    expect(REL_SRC).toContain("!params.finalSay");
  });
});
