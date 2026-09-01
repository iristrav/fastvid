/**
 * RONDE 166 — six beats shipped with a picture the gate had refused, and a number that hid it.
 *
 * ── What video 554 reported ──────────────────────────────────────────────────────────────────
 *
 *     verified_fit=6  verified_mismatch=6  never_asked=2
 *
 * ── Two separate faults, both real ───────────────────────────────────────────────────────────
 *
 * ONE — the decision. `reprieveBeatClip` implements RONDE 67's product call: when every
 * alternative was refused too, a real picture beats a grey card. It applied that to EVERY refusal
 * equally. A 1970s newsreel under 1945 narration and a football match under a Göring beat were
 * handed back with the same shrug, because nothing ever asked how wrong the picture was.
 *
 * TWO — the measurement. `verificationForBeat` looked up "the first ledger entry naming this
 * beat". That was written when a beat was judged once. The funnel now judges several candidates
 * per beat — render 554's s2b3 judged four — so the ledger holds a beat's LOSERS as well as its
 * winner, in insertion order, and the first entry is usually a loser. `verified_mismatch=6`
 * therefore did not mean six refused pictures were used; it meant six beats whose first recorded
 * candidate was refused, which is compatible with all six adopting a good picture afterwards. The
 * type's own docs say verified_mismatch is a picture that "was not used anyway" and the lookup had
 * no way to tell.
 *
 * Both are fixed here, and they must be fixed together: without the second, this round could not
 * tell whether the first had worked.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *
 *     verified fit        → wins
 *     soft mismatch       → last resort only
 *     hard mismatch       → never
 *     totally unrelated   → never
 *     nothing usable      → only then a placeholder
 *
 * Severity is read off the MismatchKind that `classifyMismatch` already derives from the gate's
 * own words. No second classifier, no second model call, nothing asked that was not already
 * answered — one more question put to the same answer.
 *
 * ── Why the guard sits in one function ───────────────────────────────────────────────────────
 *
 * `composeBarrierAllows` refuses every `does_not_fit` that nobody reprieved, and
 * `inheritBeatRelevance` carries that verdict across every rename. So `reprieveBeatClip` is the
 * ONLY way a refused clip can reach the timeline, from any route. Guarding it guards the funnel,
 * the curated archive, the rescue ladder, an extension, a cross-beat reuse and a compose rescue at
 * once — which is why this round adds no per-route checks.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import {
  beatClipSeverity,
  composeBarrierAllows,
  createBeatRelevanceLedger,
  formatAdoptedFitDecision,
  inheritBeatRelevance,
  recordExternalRelevanceVerdict,
  reprieveBeatClip,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import {
  buildBeatVisualStatuses,
  formatVisualFitAudit,
  neverAskedReason,
} from "./beatVisualStatus";
import {
  classifyMismatch,
  formatVisualFitDecision,
  mismatchSeverity,
  reprieveAllowedFor,
} from "./visualMismatchFeedback";
import { DEFAULT_TARGET_MOVING_SHARE, movingShareDeficit } from "./visualMixPolicy";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const RELEVANCE = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");

/** The gate's own prose, in the wording its prompt invites. */
const REFUSALS = {
  fit: null,
  wrongPeriod: {
    depicts: "a newsreel crowd",
    reason: "this is from a different decade than the narration describes",
  },
  wrongSubject: {
    depicts: "a wedding ceremony",
    reason: "it does not show Hermann Göring or anyone the beat is about",
  },
  /** The brief's own example, in the words the gate would use for it. */
  modernFootage: {
    depicts: "a modern wedding ceremony",
    reason: "this is present-day colour video, not 1930s footage",
  },
  unrelated: {
    depicts: "a football match",
    reason: "this is completely unrelated to the narration",
  },
  titleCard: {
    depicts: "a title card",
    reason: "the frame is a title card with text, not footage",
  },
  unclear: { depicts: "", reason: "no" },
} as const;

function judgedLedger(
  clipPath: string,
  words: { depicts: string; reason: string } | null,
  beat = { sceneIndex: 1, beatIndex: 6 }
): BeatRelevanceLedger {
  const ledger = createBeatRelevanceLedger();
  recordExternalRelevanceVerdict(
    ledger,
    clipPath,
    `test:${clipPath}`,
    { ...beat, beatText: "Hermann Göring joined Hitler in Munich" },
    words
      ? { verdict: "does_not_fit", ...words }
      : { verdict: "fits", depicts: "Hermann Göring in uniform", reason: "matches" },
    "funnel"
  );
  return ledger;
}

describe("RONDE 166 — severity is read from the kind that already exists", () => {
  it("the gate's own words classify to the kinds the severity is built on", () => {
    // No new classifier: these are the existing patterns, and the severity is a second question
    // put to their answer.
    expect(classifyMismatch(REFUSALS.wrongPeriod)).toBe("WRONG_PERIOD");
    expect(classifyMismatch(REFUSALS.wrongSubject)).toBe("WRONG_SUBJECT");
    expect(classifyMismatch(REFUSALS.unrelated)).toBe("UNRELATED");
    expect(classifyMismatch(REFUSALS.titleCard)).toBe("TITLE_CARD");
    expect(classifyMismatch(REFUSALS.unclear)).toBe("UNCLEAR");
  });

  it("the brief's own example — a modern wedding under a Göring beat — is hard", () => {
    /**
     * It classifies as MODERN_FOOTAGE rather than WRONG_SUBJECT, because "modern" is the most
     * specific thing said about it. That is exactly why MODERN_FOOTAGE is HARD despite sharing a
     * correction strategy with WRONG_PERIOD: present-day colour video under 1930s narration is the
     * one fault a viewer names unprompted, and it must never come back as a last resort.
     */
    expect(classifyMismatch(REFUSALS.modernFootage)).toBe("MODERN_FOOTAGE");
    expect(reprieveAllowedFor(classifyMismatch(REFUSALS.modernFootage))).toBe(false);
  });

  it("the four kinds that are still ABOUT the beat are soft", () => {
    for (const kind of ["WRONG_PERIOD", "WRONG_PLACE", "WRONG_EVENT", "TALKING_HEAD"] as const) {
      expect(mismatchSeverity(kind), kind).toBe("SOFT_MISMATCH");
      expect(reprieveAllowedFor(kind), kind).toBe(true);
    }
  });

  it("the kinds that put something else on screen are hard", () => {
    for (const kind of [
      "WRONG_SUBJECT", "MODERN_FOOTAGE", "TEXT_ON_SCREEN", "TITLE_CARD", "LOW_INFORMATION",
    ] as const) {
      expect(mismatchSeverity(kind), kind).toBe("HARD_MISMATCH");
      expect(reprieveAllowedFor(kind), kind).toBe(false);
    }
  });

  it("UNRELATED is its own severity and is never reprievable", () => {
    expect(mismatchSeverity("UNRELATED")).toBe("TOTALLY_UNRELATED");
    expect(reprieveAllowedFor("UNRELATED")).toBe(false);
  });

  it("UNCLEAR keeps the existing safe behaviour and is not treated as a mismatch", () => {
    /**
     * RONDE 160 already tried acting on UNCLEAR and had to be reverted: the gate refused but its
     * words say nothing about why, and inventing a severity for that is the guess this module was
     * written to avoid.
     */
    expect(mismatchSeverity("UNCLEAR")).toBe("UNKNOWN");
    expect(reprieveAllowedFor("UNCLEAR")).toBe(true);
  });
});

describe("RONDE 166 — the reprieve is the single choke point, and it now refuses", () => {
  it("a soft mismatch can still be taken back as a last resort", () => {
    const ledger = judgedLedger("/w/newsreel.mp4", REFUSALS.wrongPeriod);
    expect(reprieveBeatClip(ledger, "/w/newsreel.mp4", "nothing else passed")).toBe(true);
    expect(composeBarrierAllows(ledger, "/w/newsreel.mp4").allow).toBe(true);
  });

  it("a hard mismatch is never taken back", () => {
    const ledger = judgedLedger("/w/wedding.mp4", REFUSALS.wrongSubject);
    expect(reprieveBeatClip(ledger, "/w/wedding.mp4", "nothing else passed")).toBe(false);
    // And the compose barrier still refuses it, so declining the reprieve is enough on its own.
    expect(composeBarrierAllows(ledger, "/w/wedding.mp4").allow).toBe(false);
  });

  it("a totally unrelated picture is never taken back", () => {
    const ledger = judgedLedger("/w/football.mp4", REFUSALS.unrelated);
    expect(reprieveBeatClip(ledger, "/w/football.mp4", "nothing else passed")).toBe(false);
    expect(composeBarrierAllows(ledger, "/w/football.mp4").allow).toBe(false);
  });

  it("a title card is never taken back — burned-in text is not a last resort", () => {
    const ledger = judgedLedger("/w/card.mp4", REFUSALS.titleCard);
    expect(reprieveBeatClip(ledger, "/w/card.mp4", "nothing else passed")).toBe(false);
  });

  it("an unclear refusal keeps the pre-existing reprieve", () => {
    const ledger = judgedLedger("/w/vague.mp4", REFUSALS.unclear);
    expect(reprieveBeatClip(ledger, "/w/vague.mp4", "nothing else passed")).toBe(true);
  });

  it("a refused reprieve leaves the verdict exactly as the model gave it", () => {
    // No relabelling in either direction: declining an override is not a second refusal.
    const ledger = judgedLedger("/w/wedding.mp4", REFUSALS.wrongSubject);
    reprieveBeatClip(ledger, "/w/wedding.mp4", "nothing else passed");
    const d = ledger.byClipPath.get("/w/wedding.mp4")!.decision;
    expect(d.verdict).toBe("does_not_fit");
    expect(d.reprieved).toBe(false);
    expect(d.allowed).toBe(false);
  });

  it("a clip the ledger never saw is not reprieved into existence", () => {
    expect(reprieveBeatClip(createBeatRelevanceLedger(), "/w/unknown.mp4", "x")).toBe(false);
  });
});

describe("RONDE 166 — no route can bring a hard mismatch back", () => {
  /**
   * Each of these is a real route: the file is renamed by a trim, an overlay, a fair-use
   * transform, an extension or a compose rescue, and `inheritBeatRelevance` carries the verdict
   * with it. The barrier is what every one of them meets, so one refusal covers all of them.
   */
  const renamedBy = [
    ["the curated route", "/w/s1b6_curated_a56153.mp4"],
    ["the extension route", "/w/extend_s1b6_1700000000.mp4"],
    ["a compose rescue", "/w/scene_1_slot2_guaranteed.mp4"],
    ["a cross-beat reuse", "/w/scene_3_b0_reuse.mp4"],
    ["a fair-use transform", "/w/wedding_transformed.mp4"],
  ] as const;

  for (const [route, renamed] of renamedBy) {
    it(`${route} cannot walk a hard mismatch past the barrier`, () => {
      const ledger = judgedLedger("/w/wedding.mp4", REFUSALS.wrongSubject);
      reprieveBeatClip(ledger, "/w/wedding.mp4", "nothing else passed");
      inheritBeatRelevance(ledger, "/w/wedding.mp4", renamed);
      expect(composeBarrierAllows(ledger, renamed).allow).toBe(false);
    });
  }

  it("a soft mismatch that WAS reprieved survives the same renames", () => {
    // The reprieve is still a real product decision; only its scope changed.
    const ledger = judgedLedger("/w/newsreel.mp4", REFUSALS.wrongPeriod);
    reprieveBeatClip(ledger, "/w/newsreel.mp4", "nothing else passed");
    inheritBeatRelevance(ledger, "/w/newsreel.mp4", "/w/newsreel_transformed.mp4");
    expect(composeBarrierAllows(ledger, "/w/newsreel_transformed.mp4").allow).toBe(true);
  });

  it("both call sites in the pipeline act on the refusal instead of ignoring it", () => {
    // A returned boolean nobody reads would be the same bug with extra ceremony.
    expect(PIPE).toContain(
      "if (reprieveBeatClip(dedup.beatRelevance, gateReprieveWinner.clipPath, \"nothing else passed\")) {"
    );
    expect(PIPE).toContain("const reprieved = reprieveBeatClip(");
    expect(PIPE).toContain("if (!reprieved) {");
  });

  it("a declined reprieve looks for another picture — it does not reach for a colour card", () => {
    /**
     * §10 of the brief. In adoptClip the candidate is skipped and the loop continues to the next
     * path; in the funnel `winner` stays null, so the beat falls through to the rescue ladder, the
     * curated archive and the research pass exactly as a beat that found nothing would.
     */
    const idx = PIPE.indexOf("const reprieved = reprieveBeatClip(");
    const block = PIPE.slice(idx, idx + 500);
    expect(block).toContain("continue;");
    expect(block).not.toContain("guaranteed");
  });
});

describe("RONDE 166 — the ledger is read for the picture that is actually on screen", () => {
  /** One beat, judged three times: two losers then the winner — render 554's shape. */
  function beatWithLosers(): BeatRelevanceLedger {
    const ledger = createBeatRelevanceLedger();
    const ctx = { sceneIndex: 2, beatIndex: 3, beatText: "Göring in Munich" };
    recordExternalRelevanceVerdict(
      ledger, "/w/loser_a.mp4", "k:a", ctx,
      { verdict: "does_not_fit", ...REFUSALS.wrongSubject }, "funnel"
    );
    recordExternalRelevanceVerdict(
      ledger, "/w/loser_b.mp4", "k:b", ctx,
      { verdict: "does_not_fit", ...REFUSALS.unrelated }, "funnel"
    );
    recordExternalRelevanceVerdict(
      ledger, "/w/winner.mp4", "k:w", ctx,
      { verdict: "fits", depicts: "Göring in uniform", reason: "matches" }, "funnel"
    );
    return ledger;
  }

  const adopted = [
    { sceneIndex: 2, beatIndex: 3, source: "archive", basename: "winner.mp4", beatText: "x" },
  ];

  it("the bug: the first entry for the beat was a loser, and the beat was called a mismatch", () => {
    // Insertion order is the funnel's judging order, so the loser is found first.
    const first = [...beatWithLosers().byClipPath.values()][0];
    expect(first.decision.verdict).toBe("does_not_fit");
  });

  it("the adopted clip's own verdict is what the beat now reports", () => {
    const statuses = buildBeatVisualStatuses(adopted, beatWithLosers());
    expect(statuses[0].verification).toBe("verified_fit");
  });

  it("a beat that really did adopt a refused picture still reports the mismatch", () => {
    // The fix must not make mismatches disappear — only stop attributing losers to winners.
    const statuses = buildBeatVisualStatuses(
      [{ sceneIndex: 1, beatIndex: 6, source: "archive", basename: "wedding.mp4", beatText: "x" }],
      judgedLedger("/w/wedding.mp4", REFUSALS.wrongSubject)
    );
    expect(statuses[0].verification).toBe("verified_mismatch");
  });

  it("an adopted file the gate never saw falls back to the beat, not to never_asked", () => {
    // Losing "something on this beat was judged" would trade a wrong number for a missing one.
    const statuses = buildBeatVisualStatuses(
      [{ sceneIndex: 2, beatIndex: 3, source: "archive", basename: "renamed.mp4", beatText: "x" }],
      beatWithLosers()
    );
    expect(statuses[0].verification).toBe("verified_mismatch");
  });

  it("a beat with no ledger entry at all is never_asked", () => {
    const statuses = buildBeatVisualStatuses(adopted, createBeatRelevanceLedger());
    expect(statuses[0].verification).toBe("never_asked");
  });

  it("beatClipSeverity reads the adopted clip too", () => {
    expect(beatClipSeverity(beatWithLosers(), 2, 3, "winner.mp4")).toBe("NONE");
    expect(beatClipSeverity(beatWithLosers(), 2, 3, "loser_b.mp4")).toBe("TOTALLY_UNRELATED");
  });
});

describe("RONDE 166 — the render says why every picture is on screen", () => {
  it("an approved picture gets a line, not just the problems", () => {
    const ledger = judgedLedger("/w/goering.mp4", REFUSALS.fit);
    const line = formatAdoptedFitDecision(ledger, "/w/goering.mp4");
    expect(line).toContain("[VisualFitDecision]");
    expect(line).toContain("verdict=fits");
    expect(line).toContain("severity=NONE");
    expect(line).toContain("decision=ADOPTED");
  });

  it("a reprieved picture says so, and says it was a fallback", () => {
    const ledger = judgedLedger("/w/newsreel.mp4", REFUSALS.wrongPeriod);
    reprieveBeatClip(ledger, "/w/newsreel.mp4", "nothing else passed");
    const line = formatAdoptedFitDecision(ledger, "/w/newsreel.mp4")!;
    expect(line).toContain("severity=SOFT_MISMATCH");
    expect(line).toContain("reason=reprieved_soft_mismatch");
    expect(line).toContain("fallback=true");
  });

  it("a refused reprieve is logged as REJECTED with its severity", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reprieveBeatClip(judgedLedger("/w/football.mp4", REFUSALS.unrelated), "/w/football.mp4", "x");
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[VisualFitDecision]"));
      expect(line).toContain("decision=REJECTED");
      expect(line).toContain("severity=TOTALLY_UNRELATED");
      expect(line).toContain("reason=unrelated_may_not_be_reprieved");
    } finally {
      warn.mockRestore();
    }
  });

  it("every decision line carries both a severity and a decision", () => {
    const line = formatVisualFitDecision({
      beatLabel: "s1b6", candidate: "x.mp4", verdict: "does_not_fit",
      severity: "HARD_MISMATCH", decision: "REJECTED", reason: "why",
    });
    expect(line).toMatch(/severity=\S+/);
    expect(line).toMatch(/decision=\S+/);
    expect(line).not.toContain("fallback=true");
  });
});

describe("RONDE 166 — [VisualFitAudit] and the two never_asked beats", () => {
  const severityOf = (_s: number, _b: number, basename: string): string =>
    basename === "wedding.mp4" ? "HARD_MISMATCH" : "SOFT_MISMATCH";

  const statuses = [
    { sceneIndex: 0, beatIndex: 0, coverage: "own_footage", verification: "verified_fit",
      source: "archive", basename: "good.mp4", verifiedOwnVisual: true, reason: "" },
    { sceneIndex: 1, beatIndex: 6, coverage: "own_footage", verification: "verified_mismatch",
      source: "archive", basename: "wedding.mp4", verifiedOwnVisual: false, reason: "x" },
    { sceneIndex: 1, beatIndex: 7, coverage: "own_footage", verification: "reprieved_after_refusal",
      source: "loc", basename: "newsreel.mp4", verifiedOwnVisual: false, reason: "x" },
    { sceneIndex: 2, beatIndex: 0, coverage: "placeholder", verification: "never_asked",
      source: "fallback", basename: "scene_2_slot0_guaranteed.mp4", verifiedOwnVisual: false, reason: "x" },
  ] as const;

  it("the total line reports every category the brief asks for", () => {
    const line = formatVisualFitAudit([...statuses], severityOf)[0];
    expect(line).toContain("beats=4");
    expect(line).toContain("verifiedFit=1");
    expect(line).toContain("adoptedFit=1");
    expect(line).toContain("hardMismatch=1");
    expect(line).toContain("rejectedHardMismatch=1");
    expect(line).toContain("softMismatch=1");
    expect(line).toContain("reprievedSoftMismatch=1");
    expect(line).toContain("neverAsked=1");
  });

  it("a hard mismatch that reached adoption is called out, not absorbed", () => {
    const broken = [
      { ...statuses[1], verification: "reprieved_after_refusal" as const },
    ];
    const lines = formatVisualFitAudit(broken, severityOf);
    expect(lines.some((l) => l.includes("INVARIANT_BROKEN") && l.includes("HARD_MISMATCH"))).toBe(true);
  });

  it("a clean render raises no invariant line", () => {
    /**
     * RONDE 167 corrected this fixture, and the correction is the finding.
     *
     * It used to run on `statuses`, which holds s1b6 as `own_footage` + `verified_mismatch` with a
     * HARD severity — a refused picture on screen that nobody reprieved. That is a violation, and
     * this test asserted no violation was raised. It passed only because the audit could not see
     * that shape yet: it inspected reprieves, and there was no reprieve to inspect.
     *
     * So the assertion was true about the code and wrong about the render. A genuinely clean
     * render is the fixture without that beat.
     */
    const clean = statuses.filter((s) => s.verification !== "verified_mismatch");
    expect(formatVisualFitAudit(clean, severityOf).some((l) => l.includes("INVARIANT_BROKEN")))
      .toBe(false);
    // And the beat that was removed is exactly the one the audit now names.
    expect(formatVisualFitAudit([...statuses], severityOf).some((l) => l.includes("INVARIANT_BROKEN")))
      .toBe(true);
  });

  it("every never_asked beat gets a named reason", () => {
    const line = formatVisualFitAudit([...statuses], severityOf)
      .find((l) => l.includes("status=NEVER_ASKED"))!;
    expect(line).toContain("beat=s2b0");
    expect(line).toContain("reason=no_picture_to_judge:placeholder");
  });

  it("real footage nobody judged is named as the gap it is", () => {
    // "Nothing to judge" and "a picture nobody looked at" must not share one word.
    expect(neverAskedReason("placeholder")).toBe("no_picture_to_judge:placeholder");
    expect(neverAskedReason("held_frame")).toBe("no_picture_to_judge:held_frame");
    expect(neverAskedReason("own_footage")).toBe("real_footage_never_judged");
    expect(neverAskedReason("none")).toBe("no_clip_recorded");
  });

  it("the render prints the audit, and shouts when the invariant breaks", () => {
    const idx = PIPE.indexOf("formatVisualFitAudit(");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 500);
    expect(block).toContain("beatVisualStatuses");
    expect(block).toContain("beatClipSeverity(");
    expect(block).toContain('line.includes("INVARIANT_BROKEN")');
  });
});

describe("RONDE 166 — earlier rounds are intact", () => {
  it("the guard lives in the one function every route passes through", () => {
    // A per-route check would be a check a new route can forget to add.
    expect((RELEVANCE.match(/reprieveAllowedFor\(/g) ?? []).length).toBe(1);
    expect(RELEVANCE).toContain("export function composeBarrierAllows");
  });

  it("no gate was disabled to make room for this", () => {
    expect(PIPE).toContain("beatImageRelevanceGateEnabled()");
    expect(PIPE).toContain("evaluateClipVisionGate(");
    expect(PIPE).toContain("isMostlyBlackClip(");
  });

  it("RONDE 161's moving target is untouched, and relevance still runs after it", () => {
    /**
     * §5: fit beats movement. The moving bonus is a RANKING signal applied before the gate looks
     * at anything, and the gate's refusal happens afterwards — so a moving clip that does not fit
     * is refused exactly like a still one. Nothing here needed reordering; it needed asserting.
     */
    expect(DEFAULT_TARGET_MOVING_SHARE).toBe(0.8);
    expect(movingShareDeficit(9, 13, DEFAULT_TARGET_MOVING_SHARE)).toBeGreaterThan(0);
  });

  it("RONDE 163/164/165 accounting still runs", () => {
    expect(PIPE).toContain("recordBeatOutcome(sourcingAudit, {");
    expect(PIPE).toContain("formatAssetLifecycleAudit(ledger)");
    expect(PIPE).toContain('"superseded_by_winner"');
  });
});
