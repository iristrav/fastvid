/**
 * RONDE 200 — A PICTURE THE EDITOR REFUSED NEVER REACHES THE VIDEO.
 *
 * The owner's rule, in their words: "Er moet altijd worden gekeken. Er mag nooit een beeld in de
 * video die er niet bij past."
 *
 * The first half is RONDE 199 and 199b: every picture is looked at, and "nobody looked" stopped
 * counting as an answer anywhere. This file is the second half.
 *
 * ── What was still letting a refused picture through ────────────────────────────────────────
 *
 * The reprieve. RONDE 67 decided an imperfect picture beats a grey card, so a `does_not_fit` could
 * be taken back when every alternative had failed too. RONDE 166 narrowed it to the four kinds
 * that are still ABOUT the beat — a different decade, a different place, a different occasion, a
 * talking head — and video 554 is why it narrowed: six beats had shipped with a picture the gate
 * had refused, because "better than nothing" was applied to every refusal equally.
 *
 * Narrowing was a compromise between two goods. The owner has now said which one wins.
 *
 * ── Why this is not a gate being relaxed, in either direction ───────────────────────────────
 *
 * Nothing was loosened: a rule that could be overruled can no longer be overruled. Nothing was
 * deleted either — `reprieveBeatClip` still classifies the refusal and still logs the declined
 * attempt, so a render can say how many beats lost a picture to this rule. That number is the one
 * to look at if videos start arriving with more empty beats, and it exists precisely so the cost
 * of this decision is visible rather than inferred.
 *
 * ── The cost, stated ────────────────────────────────────────────────────────────────────────
 *
 * Both call sites already handled a declined reprieve the right way: the beat keeps every
 * remaining route — the rescue ladder, the curated archive, the research pass — exactly as a beat
 * that found nothing would. So the change is "look further", not "take the card". A colour card is
 * what happens when all of those fail too, and RONDE 89's export gate refuses a film made mostly
 * of those. The direction of failure is fewer wrong pictures and more renders that stop at the
 * export gate — which is the direction the owner asked for.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  classifyMismatch,
  mismatchSeverity,
  reprieveAllowedFor,
  type MismatchKind,
} from "./visualMismatchFeedback";
import {
  composeBarrierAllows,
  createBeatRelevanceLedger,
  inheritBeatRelevance,
  reprieveBeatClip,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const FEEDBACK = fs.readFileSync(path.join(__dirname, "visualMismatchFeedback.ts"), "utf8");

/** Every kind the classifier can produce. If one is added, this list must grow with it. */
const EVERY_KIND: MismatchKind[] = [
  "WRONG_PERIOD",
  "MODERN_FOOTAGE",
  "WRONG_SUBJECT",
  "WRONG_PLACE",
  "WRONG_EVENT",
  "TEXT_ON_SCREEN",
  "TITLE_CARD",
  "TALKING_HEAD",
  "LOW_INFORMATION",
  "UNRELATED",
  "UNCLEAR",
];

function refusedLedger(clipPath: string, depicts: string, reason: string): BeatRelevanceLedger {
  const ledger = createBeatRelevanceLedger();
  ledger.byClipPath.set(clipPath, {
    ctx: { sceneIndex: 1, beatIndex: 2, beatText: "Berlin, April 1945." },
    decision: {
      verdict: "does_not_fit",
      allowed: false,
      reprieved: false,
      cached: false,
      depicts,
      reason,
      route: "r200",
      evaluated: true,
    },
  });
  return ledger;
}

/* ═══════════ 1. no kind of refusal may be overruled ═══════════ */

describe("R200 §1 — a refusal is final, whatever kind it is", () => {
  it.each(EVERY_KIND)("%s may not be reprieved", (kind) => {
    expect(reprieveAllowedFor(kind), `${kind} can still be overruled`).toBe(false);
  });

  it("the severity vocabulary is kept — it answers a different question", () => {
    // Which refusals a render got still tells a reader whether the QUESTIONS or the CATALOGUE
    // were the problem. Only the permission to overrule the answer went away.
    expect(mismatchSeverity("WRONG_PERIOD")).toBe("SOFT_MISMATCH");
    expect(mismatchSeverity("WRONG_SUBJECT")).toBe("HARD_MISMATCH");
    expect(mismatchSeverity("UNRELATED")).toBe("TOTALLY_UNRELATED");
    expect(mismatchSeverity("UNCLEAR")).toBe("UNKNOWN");
  });

  it("it is one decision in one place, so there is no second way in", () => {
    const decisions = [...FEEDBACK.matchAll(/export function reprieveAllowedFor\(/g)];
    expect(decisions.length).toBe(1);
  });
});

/* ═══════════ 2. and the montage really does refuse it ═══════════ */

describe("R200 §2 — the soft mismatch that used to ship", () => {
  /** The gate's own wording for each, taken from the vocabulary its prompt invites. */
  const SOFT = {
    period: ["a newsreel crowd", "this is from a different decade than the narration describes"],
    place: ["a city square", "this was filmed in a different country from the one described"],
    event: ["a rally", "this is a different event from the one the narration describes"],
    head: ["a presenter", "this is a person talking to camera, not the event"],
  } as const;

  it.each(Object.entries(SOFT))("a %s refusal is refused by the barrier too", (name, [d, r]) => {
    const clip = `/w/${name}.mp4`;
    const ledger = refusedLedger(clip, d, r);
    expect(reprieveBeatClip(ledger, clip, "nothing else passed")).toBe(false);
    expect(composeBarrierAllows(ledger, clip).allow, `${name} reached the montage`).toBe(false);
  });

  it("and it cannot walk back in under a trimmed or overlaid name", () => {
    const ledger = refusedLedger("/w/newsreel.mp4", ...SOFT.period);
    reprieveBeatClip(ledger, "/w/newsreel.mp4", "nothing else passed");
    inheritBeatRelevance(ledger, "/w/newsreel.mp4", "/w/newsreel_text.mp4");
    expect(composeBarrierAllows(ledger, "/w/newsreel_text.mp4").allow).toBe(false);
  });

  it("the classifier still names what was wrong — the diagnosis is not lost", () => {
    // The refusal no longer buys the picture a place in the film; it still says what to fix.
    expect(classifyMismatch({ depicts: SOFT.period[0], reason: SOFT.period[1] })).toBe(
      "WRONG_PERIOD"
    );
    expect(mismatchSeverity(classifyMismatch({ depicts: SOFT.period[0], reason: SOFT.period[1] })))
      .toBe("SOFT_MISMATCH");
  });
});

/* ═══════════ 3. the cost is counted, not hidden ═══════════ */

describe("R200 §3 — how often the rule took a picture away is answerable", () => {
  it("every declined override is announced with the beat and the kind", () => {
    const ledger = refusedLedger(
      "/w/newsreel.mp4",
      "a newsreel crowd",
      "this is from a different decade than the narration describes"
    );
    const seen: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((l) => void seen.push(String(l)));
    try {
      reprieveBeatClip(ledger, "/w/newsreel.mp4", "nothing else passed");
    } finally {
      spy.mockRestore();
    }
    const line = seen.find((l) => l.includes("[VisualFitDecision]"))!;
    expect(line).toContain("beat=s1b2");
    expect(line).toContain("decision=REJECTED");
    expect(line).toContain("wrong_period_may_not_be_reprieved");
  });

  it("the verdict is never relabelled — declining an override is not a second refusal", () => {
    const ledger = refusedLedger(
      "/w/x.mp4",
      "a newsreel crowd",
      "this is from a different decade than the narration describes"
    );
    reprieveBeatClip(ledger, "/w/x.mp4", "nothing else passed");
    const d = ledger.byClipPath.get("/w/x.mp4")!.decision;
    expect(d.verdict).toBe("does_not_fit");
    expect(d.reprieved).toBe(false);
    expect(d.allowed).toBe(false);
  });
});

/* ═══════════ 4. the beat looks further; it is not handed a card ═══════════ */

describe("R200 §4 — a refused picture costs a candidate, not the beat", () => {
  it("the funnel keeps every remaining route when the override is declined", () => {
    const at = PIPE.indexOf("if (reprieveBeatClip(dedup.beatRelevance, gateReprieveWinner.clipPath");
    expect(at).toBeGreaterThan(0);
    // `winner` stays null, so the beat falls through to the rescue ladder, the curated archive
    // and the research pass — exactly as a beat that found nothing would.
    const block = PIPE.slice(at, at + 200);
    expect(block).toContain("winner = gateReprieveWinner;");
    expect(PIPE.slice(Math.max(0, at - 700), at)).toContain("falls through to every remaining route");
  });

  it("the adopt loop moves to the next candidate rather than adopting the refused one", () => {
    const at = PIPE.indexOf("const reprieved = reprieveBeatClip(");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 400);
    expect(block).toContain("if (!reprieved) {");
    expect(block).toContain("continue;");
  });

  it("both call sites read the answer — a returned boolean nobody reads would be the same bug", () => {
    expect(PIPE).toContain("if (!reprieved) {");
    expect(PIPE).toContain("if (reprieveBeatClip(dedup.beatRelevance, gateReprieveWinner.clipPath");
  });
});
