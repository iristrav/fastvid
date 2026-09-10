/**
 * RONDE 228 — THE ESCAPE HATCH THAT WAS SHORT-CIRCUITED ONE LINE BEFORE IT COULD FIRE.
 *
 * ── What render 576 measured ────────────────────────────────────────────────────────────────
 *
 * The film died with `Scene 1: 7 zinnen maar 0 voice/script-matchende clips — export geblokkeerd`.
 * Its adoption guard was reached seventy-four times, by five files:
 *
 *     17× scene_1_slot5_guaranteed.mp4     eligible=false  (a colour card — correctly refused)
 *     17× scene_1_slot105_guaranteed.mp4   eligible=false
 *     17× scene_1_slot205_guaranteed.mp4   eligible=false
 *     17× scene_1_slot305_guaranteed.mp4   eligible=false
 *      6× scene_1_rescue_wiki_wiki_0__pid_wikimedia-b064575e6d22ec37.mp4   ELIGIBLE=TRUE
 *
 * The last one is real footage that passed every gate it met, and all six times it read
 * `vision=NOT_ASKED blocked=FUNNEL_WITHOUT_EVIDENCE`. Over the same eleven minutes the render's
 * own reject tally held `beat_image_gate:2` FIXED while `FUNNEL_WITHOUT_EVIDENCE` climbed 78 → 138
 * and `shortlist_full` climbed 50 → 84. Two real looks in the entire render; everything after them
 * refused for want of a look.
 *
 * ── Why it could never recover ──────────────────────────────────────────────────────────────
 *
 * `pass()` in beatVisualRelevance describes itself: "a verdict-free pass — every caller below is a
 * case where the gate DID NOT LOOK, so `evaluated` is false". It calls `record()`. So a non-verdict
 * is written into the ledger looking exactly like a decision, and `ensureVerdictBeforeCompose`
 * returned `already_judged` for it without ever asking whether anybody had looked.
 *
 * RONDE 215 gave the adoption guard its own last look for precisely this moment, passing
 * `finalSay: true`, which is allowed to overrule both spend caps because it is the look that
 * decides something. It could never fire — it was short-circuited by the ledger read one line
 * before the budgets it exists to bypass.
 *
 * A cache that cannot tell "we have an answer" from "we recorded that we failed to get one". The
 * same defect RONDE 222 found in the overlay check, in a different place.
 *
 * ── The rule, and its limits ────────────────────────────────────────────────────────────────
 *
 * Nothing here turns NOT_ASKED into APPROVED, suspends the guard or moves a threshold. A clip that
 * comes back unjudged a second time is still unjudged and still refused, and RONDE 89's export
 * blocks still stand over the film. One retry per clip per render — a genuinely unjudgeable clip
 * costs one extra look, never a loop.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  createBeatRelevanceLedger,
  ensureVerdictBeforeCompose,
  maxComposePhaseJudgements,
  withComposeJudgeScope,
  type BeatRelevanceDecision,
  type ComposeJudgeScope,
} from "./beatVisualRelevance";
import { createBeatImageGateState } from "./beatImageRelevanceGate";

const SRC = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");

const BEAT = "As the noose tightened, the Reich's last defenders held a city already lost.";
/** Render 576's one piece of real footage to reach the guard, refused six times unlooked-at. */
const WIKI = "/w/scene_1_rescue_wiki_wiki_0__pid_wikimedia-b064575e6d22ec37.mp4";

/**
 * The gate is switched off for the retry tests, so `checkBeatRelevance` takes its "gate disabled"
 * path — a REAL path that records an entry and contacts no provider. That is what lets the
 * plumbing be measured end to end without inventing a model answer.
 */
const saved = process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
afterEach(() => {
  if (saved === undefined) delete process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
  else process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = saved;
});

function decision(evaluated: boolean, reason = "render judgement budget spent"): BeatRelevanceDecision {
  return {
    verdict: "unknown",
    allowed: true,
    reprieved: false,
    cached: false,
    depicts: "",
    reason,
    route: "archive",
    evaluated,
  };
}

function scope(overrides: Partial<ComposeJudgeScope> = {}): ComposeJudgeScope {
  return {
    workDir: "/w",
    state: createBeatImageGateState(),
    ledger: createBeatRelevanceLedger(),
    beatForClip: () => ({ sceneIndex: 1, beatIndex: 5 }),
    contextFor: () => ({ sceneIndex: 1, beatIndex: 5, beatText: BEAT }),
    isPlaceholder: () => false,
    budget: maxComposePhaseJudgements(),
    spent: 0,
    ...overrides,
  };
}

/** Seed the ledger the way `pass()` does — an entry nobody actually looked at. */
function withUnlookedEntry(s: ComposeJudgeScope, clipPath = WIKI): ComposeJudgeScope {
  s.ledger.byClipPath.set(clipPath, {
    ctx: { sceneIndex: 1, beatIndex: 5, beatText: BEAT },
    decision: decision(false),
  });
  return s;
}

const ask = (s: ComposeJudgeScope, opts: { finalSay?: boolean } = {}) =>
  withComposeJudgeScope(s, () =>
    ensureVerdictBeforeCompose({
      clipPath: WIKI,
      contentKey: "wikimedia:b064575e6d22ec37",
      sceneIndex: 1,
      beatIndex: 5,
      route: "adoption_guard",
      ...opts,
    })
  );

/* ═══════════ 1. a recorded non-verdict no longer blocks the last look ═══════════ */

describe("R228 §1 — the picture about to be used gets looked at", () => {
  it("MEASURED: an unlooked-at entry no longer answers a finalSay caller with already_judged", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const s = withUnlookedEntry(scope());
    const r = await ask(s, { finalSay: true });
    expect(
      r.outcome,
      "the guard's last look is still short-circuited by a record of not looking"
    ).not.toBe("already_judged");
  });

  it("MEASURED: render 576's exact shape — six asks, and the first one now looks", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const s = withUnlookedEntry(scope());
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push((await ask(s, { finalSay: true })).outcome);
    expect(outcomes[0]).not.toBe("already_judged");
    expect(
      outcomes.filter((o) => o !== "already_judged").length,
      "the retry is not bounded to one look per clip"
    ).toBe(1);
  });

  it("A REAL VERDICT IS STILL CONCLUSIVE — this only reopens non-verdicts", async () => {
    const s = scope();
    s.ledger.byClipPath.set(WIKI, {
      ctx: { sceneIndex: 1, beatIndex: 5, beatText: BEAT },
      decision: { ...decision(true), verdict: "does_not_fit", allowed: false },
    });
    const r = await ask(s, { finalSay: true });
    expect(r.outcome, "a clip the editor actually refused was asked about again").toBe("already_judged");
    expect(r.verdict).toBe("does_not_fit");
    expect(s.spent, "a judged clip spent budget anyway").toBe(0);
  });

  it("AN ORDINARY CALLER STILL GETS THE CACHE — only the deciding look reopens it", async () => {
    const s = withUnlookedEntry(scope());
    const r = await ask(s);
    expect(
      r.outcome,
      "every candidate comparison now pays for a second look — the R97 cost regression"
    ).toBe("already_judged");
    expect(s.spent).toBe(0);
  });

  it("the retry is recorded per clip, so a second clip gets its own chance", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const s = withUnlookedEntry(scope());
    await ask(s, { finalSay: true });
    expect(s.ledger.finalSayRetried.has(WIKI)).toBe(true);
    expect(s.ledger.finalSayRetried.size).toBe(1);
  });

  it("a fresh render starts with no retries spent", () => {
    expect(createBeatRelevanceLedger().finalSayRetried.size).toBe(0);
  });
});

/* ═══════════ 2. nothing was loosened ═══════════ */

describe("R228 §2 — no verdict moved", () => {
  it("NOT_ASKED IS NOT PROMOTED — the retry changes who is asked, never what was answered", () => {
    const at = SRC.indexOf("const neverLookedAt = existing.decision.evaluated === false;");
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at - 200, at + 900);
    for (const forbidden of ['verdict: "fits"', "allowed: true,", "evaluated: true", "reprieved: true"]) {
      expect(block, `the retry rewrote a decision (${forbidden})`).not.toContain(forbidden);
    }
  });

  it("THE RETRY IS GATED ON finalSay — not on the outcome being inconvenient", () => {
    /** The predicate spans two statements: the `neverLookedAt` binding and `mayRetry` reading it. */
    const at = SRC.indexOf("const neverLookedAt = existing.decision.evaluated === false;");
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at, at + 400);
    expect(block).toContain("existing.decision.evaluated === false");
    expect(block).toContain("params.finalSay === true");
    expect(block).toContain("finalSayRetried.has(params.clipPath)");
    /** All three conjoined — any one of them alone would reopen far more than the deciding look. */
    expect(block).toContain("neverLookedAt && ");
  });

  it("IT IS NEVER SILENT — a second look is announced with the reason it was needed", () => {
    const at = SRC.indexOf("was recorded without a look");
    expect(at, "the retry happens quietly").toBeGreaterThan(0);
    const block = SRC.slice(at - 300, at + 400);
    expect(block).toContain("console.warn");
    expect(block).toContain("existing.decision.reason");
  });

  it("the verdict-free pass still records itself — this reads the record, it does not stop it", () => {
    expect(SRC).toContain("const pass = (verdict: BeatImageVerdict, reason: string, cached = false)");
    expect(SRC).toContain("evaluated: false }");
  });

  it("the compose budget is untouched — finalSay's bypass is the one RONDE 215 already had", () => {
    expect(SRC).toContain("if (!params.finalSay && scope.spent >= scope.budget) return { outcome: \"budget_spent\" };");
  });

  it("the three 'nothing to ask against' outcomes still suspend the requirement, unchanged", () => {
    expect(SRC).toContain('if (!scope) return { outcome: "no_scope" };');
    expect(SRC).toContain('if (!at) return { outcome: "beat_unknown" };');
    expect(SRC).toContain('if (!ctx?.beatText?.trim()) return { outcome: "no_narration" };');
  });
});

/* ═══════════ 3. the guard still demands what it always demanded ═══════════ */

describe("R228 §3 — the export blocks stand", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const POLICY = fs.readFileSync(path.join(__dirname, "adoptionPolicy.ts"), "utf8");

  it("RONDE 215's last look still passes finalSay", () => {
    const at = PIPE.indexOf('route: "adoption_guard",');
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 260)).toContain("finalSay: true");
  });

  it("FUNNEL_WITHOUT_EVIDENCE still refuses a route that claims without a verdict", () => {
    expect(POLICY).toContain("FUNNEL_WITHOUT_EVIDENCE");
  });

  it("RONDE 89's export blocks are untouched", () => {
    /** They live in the quality report, which is what actually refuses to ship the film. */
    const REPORT = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    for (const block of ["NO_VERIFIED_OWN_VISUAL", "MOSTLY_UNVERIFIED_CLIPS"]) {
      expect(REPORT, `${block} was removed`).toContain(block);
    }
    expect(REPORT).toContain('code: "NO_VERIFIED_OWN_VISUAL" | "MOSTLY_UNVERIFIED_CLIPS";');
  });

  it("the scene gate still throws rather than shipping an empty scene", () => {
    expect(PIPE).toContain("voice/script-matchende clips — export geblokkeerd");
  });
});
