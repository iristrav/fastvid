/**
 * P0-7 — A DECLINE THAT CANNOT SAY WHY.
 *
 * ── The two logs that were about the same 228 candidates ────────────────────────────────────
 *
 * Render 580:
 *
 *     [BeatImageGate] no verdict: 219x gate could not ask: No vision-capable provider is
 *                     available | 7x provider unavailable (gemini 403) | 4x timeout
 *     [BeatFunnel]    TOTAL … notAsked=228
 *
 * Every one of those 228 declines had a known cause at the moment it happened. `judgeBeatImage`
 * distinguishes eight of them and returns each with its own sentence. And then the beat's own
 * account of itself recorded `f.notAsked += 1` — a bare counter, no reason bumped — so the two
 * lines above could never be joined, and a reader could not tell whether that render needed a
 * provider restored, a shortlist re-ordered, or not to have shipped.
 *
 * It is the signature defect of this codebase for the twenty-somethingth time: the answer is
 * computed, written down, and not carried to where the decision is made. `NotAskedReason` had
 * carried `VISION_BUDGET_EXHAUSTED`, `PREPARATION_FAILURE` and `PROVIDER_FAILURE` since RONDE 95
 * and NOTHING IN THE CODEBASE COULD PRODUCE ANY OF THEM. §2 is that measurement.
 *
 * ── What this round changes, and what it deliberately does not ──────────────────────────────
 *
 * The gate names its decline as a VALUE at the site that declines, the value rides the ledger
 * entry beside `evaluated`, and the funnel maps it once. No budget moves, no bound is relaxed, no
 * candidate is adopted that was not adopted before, and no decline becomes a judgement: §5 checks
 * all four. What changes is that a render can now say whether it was blind, starved or settled.
 */
import { describe, expect, it } from "vitest";

import {
  createBeatImageGateState,
  judgeBeatImage,
  maxBeatImageJudgementsPerRender,
  type VisionDeclineCause,
} from "./beatImageRelevanceGate";
import {
  admitToShortlist,
  beatFunnel,
  createBeatShortlistState,
  declineCensus,
  formatDeclineCensus,
  beatShortlistViolations,
  noteVisionOutcome,
  notAskedReasonForDecline,
  reasonsFor,
  type NotAskedReason,
} from "./beatShortlist";
import { stripComments, callSitesOf, lineOf } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const read = (f: string) => stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));
const GATE = read("beatImageRelevanceGate.ts");
const RELEVANCE = read("beatVisualRelevance.ts");
const SHORTLIST = read("beatShortlist.ts");
const PIPE = read("videoPipeline.ts");

/* ═══════════ 1. the gate names its decline as a value ═══════════ */

describe("P0-7 §1 — every decline says which decline it is", () => {
  it("EVERY `declined(` CALL PASSES A CAUSE — the parameter is leading and required", () => {
    /** Offsets, so a failure names the line rather than leaving it to be hunted. */
    const sites = callSitesOf(GATE, "declined");
    expect(sites.length, "the gate stopped declining anywhere").toBeGreaterThanOrEqual(7);
    for (const at of sites) {
      const site = GATE.slice(at, at + 60);
      expect(site, `a decline named no cause at line ${lineOf(GATE, at)}`).toMatch(
        /declined\(\s*"(GATE_DISABLED|NO_NARRATION|RENDER_BUDGET_SPENT|BEAT_LOOK_CEILING|NO_FRAME|FRAMES_UNREADABLE|PROVIDER_UNREACHABLE|PROVIDER_UNAVAILABLE)"/
      );
    }
  });

  it("and the relevance layer's own two declines do the same", () => {
    for (const cause of ["GATE_DISABLED", "NO_NARRATION", "BEAT_LOOK_CEILING"]) {
      expect(RELEVANCE, `pass() lost its ${cause} cause`).toContain(`pass("${cause}"`);
    }
  });

  it("A GATE THAT IS OFF DECLINES WITH GATE_DISABLED — the one decline reachable without a model", async () => {
    const before = process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
    try {
      process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
      const j = await judgeBeatImage({
        framePaths: [],
        beatText: "a line of narration",
        contentKey: "test:1",
        state: createBeatImageGateState(),
      });
      expect(j.evaluated).toBe(false);
      expect(j.declineCause).toBe("GATE_DISABLED");
    } finally {
      if (before === undefined) delete process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
      else process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = before;
    }
  });

  it("A BEAT WITH NO NARRATION DECLINES WITH NO_NARRATION, not with a provider failure", async () => {
    const j = await judgeBeatImage({
      framePaths: [],
      beatText: "   ",
      contentKey: "test:2",
      state: createBeatImageGateState(),
    });
    expect(j.evaluated).toBe(false);
    expect(j.declineCause).toBe("NO_NARRATION");
  });

  it("A SPENT RENDER BUDGET DECLINES WITH RENDER_BUDGET_SPENT — and no frame is even read", async () => {
    const state = createBeatImageGateState();
    /** Exactly the condition the gate checks, set directly rather than by burning real calls. */
    state.judgementAttempts = maxBeatImageJudgementsPerRender();
    const j = await judgeBeatImage({
      framePaths: ["/nonexistent/frame.jpg"],
      beatText: "a line of narration",
      contentKey: "test:3",
      state,
    });
    expect(j.declineCause).toBe("RENDER_BUDGET_SPENT");
    /**
     * The ORDER matters and this is what pins it: a budget check that ran after the frame read
     * would report NO_FRAME here, and the render would be told its clips were undecodable when
     * what actually happened is that it had stopped paying for looks.
     */
    expect(j.declineCause).not.toBe("NO_FRAME");
  });

  it("A CLIP WITH NO FRAME DECLINES WITH NO_FRAME — the bytes arrived, nothing showable came out", async () => {
    const j = await judgeBeatImage({
      framePaths: [path.join(__dirname, "no_such_frame_p07.jpg")],
      beatText: "a line of narration",
      contentKey: "test:4",
      state: createBeatImageGateState(),
    });
    expect(j.declineCause).toBe("NO_FRAME");
  });

  it("the cause is absent when a model LOOKED — there is no decline to name", () => {
    /**
     * `unknown(reason, true)` is a model that looked and settled nothing. `declineCause` is
     * spread in conditionally so that case carries no field at all, rather than a cause meaning
     * "not applicable" that a reader would have to know to exclude.
     */
    expect(GATE).toContain("...(declineCause ? { declineCause } : {})");
  });
});

/* ═══════════ 2. the three reasons that nothing could produce ═══════════ */

describe("P0-7 §2 — a taxonomy member with no producer is a comment, not a measurement", () => {
  const PRODUCED_BY_MAPPING: NotAskedReason[] = [
    "VISION_BUDGET_EXHAUSTED",
    "PREPARATION_FAILURE",
    "VISION_UNAVAILABLE",
    "VISION_GATE_DISABLED",
    "NO_NARRATION_TO_JUDGE",
  ];

  it("VISION_BUDGET_EXHAUSTED AND PREPARATION_FAILURE NOW HAVE PRODUCERS", () => {
    /**
     * Before this round, a grep for either of these across every non-test file in the server
     * returned only their own declarations. They were vocabulary for a finding the pipeline was
     * structurally unable to report.
     */
    const produced = new Set(
      (
        [
          "GATE_DISABLED",
          "NO_NARRATION",
          "RENDER_BUDGET_SPENT",
          "BEAT_LOOK_CEILING",
          "NO_FRAME",
          "FRAMES_UNREADABLE",
          "PROVIDER_UNREACHABLE",
          "PROVIDER_UNAVAILABLE",
        ] as VisionDeclineCause[]
      ).map(notAskedReasonForDecline)
    );
    for (const reason of PRODUCED_BY_MAPPING) {
      expect(produced.has(reason), `${reason} still has no producer`).toBe(true);
    }
  });

  it("both look ceilings are the same finding for the funnel, and it is the budget one", () => {
    expect(notAskedReasonForDecline("RENDER_BUDGET_SPENT")).toBe("VISION_BUDGET_EXHAUSTED");
    expect(notAskedReasonForDecline("BEAT_LOOK_CEILING")).toBe("VISION_BUDGET_EXHAUSTED");
  });

  it("A DISABLED GATE IS NOT AN OUTAGE — the two would send an operator to opposite places", () => {
    expect(notAskedReasonForDecline("GATE_DISABLED")).toBe("VISION_GATE_DISABLED");
    expect(notAskedReasonForDecline("PROVIDER_UNREACHABLE")).toBe("VISION_UNAVAILABLE");
    expect(notAskedReasonForDecline("GATE_DISABLED")).not.toBe(
      notAskedReasonForDecline("PROVIDER_UNREACHABLE")
    );
  });

  it("undecodable bytes are a PREPARATION failure, not a provider one", () => {
    expect(notAskedReasonForDecline("NO_FRAME")).toBe("PREPARATION_FAILURE");
    expect(notAskedReasonForDecline("FRAMES_UNREADABLE")).toBe("PREPARATION_FAILURE");
  });

  it("and the mapping is TOTAL — a new cause cannot fall through to a default", () => {
    /**
     * The switch has no `default`, so TypeScript's exhaustiveness check refuses the file until a
     * new `VisionDeclineCause` member is named. A default clause would compile and would quietly
     * file every future cause under whatever it returned.
     */
    const fn = SHORTLIST.slice(
      SHORTLIST.indexOf("export function notAskedReasonForDecline"),
      SHORTLIST.indexOf("export function notAskedReasonForDecline") + 900
    );
    expect(fn).not.toContain("default:");
  });
});

/* ═══════════ 3. the funnel records the reason, never a bare count ═══════════ */

describe("P0-7 §3 — NOT_ASKED can no longer be reasonless", () => {
  const funnelWith = (reason?: NotAskedReason) => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 1, 2, "NOT_ASKED", reason);
    return beatFunnel(state, 1, 2);
  };

  it("A CAUSE THAT WAS GIVEN IS THE CAUSE THAT IS COUNTED", () => {
    const f = funnelWith("VISION_BUDGET_EXHAUSTED");
    expect(f.notAsked).toBe(1);
    expect(f.notAskedReasons.get("VISION_BUDGET_EXHAUSTED")).toBe(1);
    expect(reasonsFor(f)).toEqual(["VISION_BUDGET_EXHAUSTED×1"]);
  });

  it("AND AN OMISSION IS COUNTED AS AN OMISSION — not distributed over the reasons that did report", () => {
    const f = funnelWith(undefined);
    expect(f.notAsked).toBe(1);
    expect(f.notAskedReasons.get("DECLINE_CAUSE_NOT_REPORTED")).toBe(1);
    /**
     * The alternative — leaving the bare counter alone — is what render 580 did, and it makes an
     * unattributed decline indistinguishable from an attributed one in every total downstream.
     */
    expect(f.notAskedReasons.size).toBe(1);
  });

  it("an unattributed decline is reported as an INVARIANT VIOLATION, not just a row", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "NOT_ASKED");
    const violations = beatShortlistViolations(state);
    expect(violations.join("\n")).toContain("DECLINES_NOT_ATTRIBUTED");
  });

  it("and a fully attributed render reports no violation at all", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "NOT_ASKED", "VISION_UNAVAILABLE");
    noteVisionOutcome(state, 0, 1, "NOT_ASKED", "PREPARATION_FAILURE");
    expect(beatShortlistViolations(state).join("\n")).not.toContain("DECLINES_NOT_ATTRIBUTED");
  });

  it("the four SELF-EXPLAINING outcomes are unchanged — this round touched one branch", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 3, 0, "APPROVED");
    noteVisionOutcome(state, 3, 0, "REJECTED");
    noteVisionOutcome(state, 3, 0, "UNCLEAR");
    noteVisionOutcome(state, 3, 0, "VISION_UNAVAILABLE");
    const f = beatFunnel(state, 3, 0);
    expect(f.approved).toBe(1);
    expect(f.rejected).toBe(1);
    expect(f.unclear).toBe(1);
    expect(f.unavailable).toBe(1);
    expect(f.notAsked, "an answered outcome was counted as a non-ask").toBe(0);
    expect(f.notAskedReasons.get("DECLINE_CAUSE_NOT_REPORTED")).toBeUndefined();
  });
});

/* ═══════════ 4. blind, starved, settled ═══════════ */

describe("P0-7 §4 — which kind of decline, as three numbers", () => {
  const census = (rows: Array<[NotAskedReason, number]>) => {
    const state = createBeatShortlistState();
    let beat = 0;
    for (const [reason, n] of rows) {
      for (let i = 0; i < n; i++) noteVisionOutcome(state, 0, beat, "NOT_ASKED", reason);
      beat++;
    }
    return declineCensus(state);
  };

  it("A RENDER WITH NO PICTURE EDITOR IS BLIND, AND NOTHING ELSE", () => {
    const c = census([
      ["VISION_UNAVAILABLE", 219],
      ["VISION_GATE_DISABLED", 9],
    ]);
    expect(c.blind).toBe(228);
    expect(c.starved).toBe(0);
    expect(c.settled).toBe(0);
  });

  it("A RENDER WHOSE EDITOR WAS AVAILABLE AND STILL NEVER LOOKED IS STARVED", () => {
    /** The four declines that are about this pipeline's own choices — P0-7's actual subject. */
    const c = census([
      ["SHORTLIST_FULL", 37],
      ["SHORTLIST_SOURCE_SHARE", 21],
      ["VISION_BUDGET_EXHAUSTED", 12],
      ["PREPARATION_FAILURE", 4],
    ]);
    expect(c.starved).toBe(74);
    expect(c.blind).toBe(0);
    expect(c.settled).toBe(0);
  });

  it("an answered beat is SETTLED — a refusal is not a starvation", () => {
    const c = census([
      ["REJECTED_BY_EDITOR", 37],
      ["UNCLEAR_BY_EDITOR", 5],
      ["NO_CANDIDATES", 2],
      ["NO_NARRATION_TO_JUDGE", 1],
    ]);
    expect(c.settled).toBe(45);
    expect(c.starved).toBe(0);
    expect(c.blind).toBe(0);
  });

  it("THE THREE BUCKETS PARTITION — every decline lands in exactly one", () => {
    const ALL: NotAskedReason[] = [
      "NO_CANDIDATES", "NO_ELIGIBLE_CANDIDATES", "SHORTLIST_EMPTY", "SHORTLIST_FULL",
      "SHORTLIST_SOURCE_SHARE", "VISION_BUDGET_EXHAUSTED", "VISION_UNAVAILABLE", "DUPLICATE",
      "REJECTED_BY_EDITOR", "UNCLEAR_BY_EDITOR", "PROVIDER_FAILURE", "DOWNLOAD_FAILURE",
      "PREPARATION_FAILURE", "NOT_REACHED", "POLICY_BLOCKED", "ADOPTED_WITHOUT_JUDGEMENT",
      "VISION_GATE_DISABLED", "NO_NARRATION_TO_JUDGE", "DECLINE_CAUSE_NOT_REPORTED",
    ];
    const c = census(ALL.map((r) => [r, 1] as [NotAskedReason, number]));
    expect(c.blind + c.starved + c.settled + c.unattributed).toBe(ALL.length);
    /** And every one of them is present in the by-reason detail, so the totals are checkable. */
    expect([...c.byReason.keys()].sort()).toEqual([...ALL].sort());
  });

  it("the line names the three and flags an unattributed count loudly", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "NOT_ASKED", "SHORTLIST_FULL");
    noteVisionOutcome(state, 0, 1, "NOT_ASKED");
    const line = formatDeclineCensus(state);
    expect(line).toContain("declines=2");
    expect(line).toContain("starved=1");
    expect(line).toContain("UNATTRIBUTED=1");
    expect(line).toContain("SHORTLIST_FULL×1");
  });

  it("AND A RENDER WITH NO DECLINES PRINTS NOTHING — silence is not a zero", () => {
    expect(formatDeclineCensus(createBeatShortlistState())).toBe("");
    expect(formatDeclineCensus(undefined)).toBe("");
  });
});

/* ═══════════ 5. nothing about who is asked, adopted or bounded moved ═══════════ */

describe("P0-7 §5 — a report, not a policy", () => {
  it("THE BOUND IS THE BOUND IT WAS — admission is unchanged", () => {
    const state = createBeatShortlistState();
    const cap = 3;
    for (let i = 0; i < cap; i++) {
      expect(admitToShortlist(state, 0, 0, `k${i}`, cap).admitted).toBe(true);
    }
    const over = admitToShortlist(state, 0, 0, "k99", cap);
    expect(over.admitted).toBe(false);
    expect(over.admitted === false && over.reason).toBe("SHORTLIST_FULL");
  });

  it("a decline is still a decline — nothing here turns one into a judgement", () => {
    const state = createBeatShortlistState();
    noteVisionOutcome(state, 0, 0, "NOT_ASKED", "VISION_BUDGET_EXHAUSTED");
    const f = beatFunnel(state, 0, 0);
    expect(f.visionAsked).toBe(0);
    expect(f.approved).toBe(0);
  });

  it("NO BUDGET, CEILING OR CAP WAS RAISED IN THIS ROUND", () => {
    /**
     * The brief forbids raising a limit as a first solution, and this round is the case where it
     * would have been tempting: the finding IS that candidates go unlooked-at. The repair is to
     * make the cause reportable, which is why these three defaults are pinned here rather than
     * being left to a reviewer to notice.
     */
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500)');
    expect(RELEVANCE).toContain("MAX_JUDGEMENTS_PER_BEAT + 1");
  });

  it("and the release rule is untouched — a place still comes back only if nobody looked", () => {
    expect(SHORTLIST).toContain('if (f.askedKeys.has(id)) return { released: false, reason: "ALREADY_ASKED" };');
    expect(SHORTLIST).toContain('if (f.slotsReleased >= cap) return { released: false, reason: "RELEASE_BUDGET_SPENT" };');
  });
});

/* ═══════════ 6. the cause survives the trip to the decision ═══════════ */

describe("P0-7 §6 — the cause reaches the place the record is written", () => {
  it("THE LEDGER READBACK RETURNS IT — this is the join that did not exist", () => {
    /**
     * `relevanceVerdictForRenderedAsset` is the pipeline's only reader of the relevance ledger.
     * `evaluated` was added to it once for exactly this reason — the fact stopped at the function
     * and every reader had to treat two opposite events as one. The cause had the same problem one
     * field over.
     */
    expect(RELEVANCE).toContain("declineCause?: VisionDeclineCause;");
    expect(RELEVANCE).toContain(
      "...(entry.decision.declineCause ? { declineCause: entry.decision.declineCause } : {}),"
    );
  });

  it("and EVERY call site that can record NOT_ASKED passes one", () => {
    /**
     * Not every call site needs a cause, and demanding one everywhere would be the wrong check.
     * `noteVisionOutcome(…, "REJECTED")` is a refusal: it explains itself, and there is no decline
     * to attribute. The rule is narrower and exactly the defect: a site that can record NOT_ASKED
     * must also be able to say why.
     */
    const sites = callSitesOf(PIPE, "noteVisionOutcome").map((at) => ({
      at,
      args: (() => {
        const from = PIPE.slice(at, at + 900);
        return from.slice(0, from.indexOf(");"));
      })(),
    }));
    expect(sites.length, "a vision-outcome call site appeared or disappeared").toBe(3);
    /**
     * A site that hardcodes an outcome which is not NOT_ASKED can never record a decline, so it
     * has nothing to attribute. Exactly one does — the requeue-after-refusal branch, which passes
     * a literal "REJECTED".
     */
    const cannotDecline = sites.filter(({ args }) =>
      /,\s*"(APPROVED|REJECTED|UNCLEAR|VISION_UNAVAILABLE)"\s*$/.test(args)
    );
    expect(cannotDecline.length).toBe(1);
    const canDecline = sites.filter((s) => !cannotDecline.includes(s));
    expect(canDecline.length, "no call site records a decline any more").toBe(2);
    for (const { at, args } of canDecline) {
      expect(
        args,
        `a decline is recorded with no cause at line ${lineOf(PIPE, at)}`
      ).toContain("beatDeclineReasonFor(");
    }
  });

  it("the pipeline never maps a cause itself — there is one mapping, in one place", () => {
    /**
     * Two mappings would drift, and the drift would be invisible: both would produce valid
     * `NotAskedReason` values and only their disagreement would be wrong. The pipeline calls
     * `notAskedReasonForDecline` through `beatDeclineReasonFor` and nowhere else.
     */
    expect(PIPE.match(/notAskedReasonForDecline\(/g)?.length ?? 0).toBe(1);
  });

  it("AND IT IS READ OFF THE RECORD, NOT PARSED OUT OF A MESSAGE", () => {
    /**
     * This module's own RONDE 115 note: "a caller matching on message substrings rots the moment
     * a message is reworded". The reason strings are still there and still logged; nothing counts
     * them.
     */
    const fn = PIPE.slice(
      PIPE.indexOf("function beatDeclineReasonFor("),
      PIPE.indexOf("function beatDeclineReasonFor(") + 700
    );
    expect(fn).toContain("found?.declineCause");
    expect(fn, "the cause was recovered from prose").not.toMatch(/\.reason[\s\S]{0,40}(includes|match|startsWith)/);
  });
});
