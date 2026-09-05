/**
 * RONDE 142 — the two bugs production video 548 proved.
 *
 * ── BUG 1: 41.38 seconds of one picture ──────────────────────────────────────────────────────
 *
 *     duration 95.84s · longest still 41.38s at 28.13s · imagesOver5Sec 1 · limit 5.00s · NO
 *
 * 13 of 15 beats came back `status=rejected origin=none offered=0` — nothing found at all. Each
 * one was filled by `extendLastClip` on `dedup.lastRealClip`, producing 13 `extend_sXbY` clips
 * from the same source. Every individual extension is short, loops rather than freezes, and
 * carries RONDE 111's slow zoom; nothing counted the RUN. The fix charges a budget, in seconds,
 * against the source clip — RONDE 128's existing `stillImageMaxSec()`, no new limit.
 *
 * ── BUG 2: 79% of refusals never reached the feedback chain ──────────────────────────────────
 *
 *     vision gate does_not_fit    24
 *     [MismatchFeedback] counted   5
 *
 * `classifyMismatch` / `recordMismatch` / `decideResearch` lived on ONE of five
 * `checkBeatRelevance` call sites — the funnel. The other four, including
 * `beatClipPassesVisionGate` through which every rescue and adoption route passes, classified
 * nothing. Consequences, all measured in 548: the provider table reported `pexels 1/1 accepted
 * (100%)` on a render whose log holds ten refused Pexels clips; and `research attempts = 0`
 * despite four QUESTION-blame refusals.
 *
 * A second, independent cause of research=0: the research branch sat inside
 * `if (winner && beatImageRelevanceGateEnabled())`, so a beat that found NO candidate skipped it
 * entirely — research was unreachable in exactly the situation it exists for.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  createExtendHoldState,
  formatExtendRefusal,
  mayExtendAgain,
  recordExtension,
  resetExtendHold,
} from "./extendHoldBudget";
import { stillImageMaxSec } from "./stillImagePolicy";
import {
  classifyMismatch,
  createMismatchTally,
  mismatchFault,
  recordMismatch,
} from "./visualMismatchFeedback";
import { decideResearch } from "./mismatchResearch";
import { emptyQueryContext, provenToken, type VerifiedQueryContext } from "./searchQueryContract";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

// ─── BUG 1 ───────────────────────────────────────────────────────────────────────────────────

describe("RONDE 142 BUG 1 — one picture cannot be extended past the limit", () => {
  it("A. the run that produced 41.38s is refused", () => {
    // Video 548's shape: the same source, extended beat after beat with ~3.5s holds.
    const state = createExtendHoldState();
    const source = "/w/scene_0_b2_wiki.mp4";
    let granted = 0;
    let grantedSec = 0;
    for (let beat = 0; beat < 13; beat++) {
      const d = mayExtendAgain({ state, sourceClipPath: source, holdSec: 3.5 });
      if (!d.allowed) continue;
      recordExtension(state, source, 3.5);
      granted++;
      grantedSec += 3.5;
    }
    // Thirteen requests, and the same picture never outstays the cap.
    expect(granted).toBeLessThan(13);
    expect(grantedSec).toBeLessThanOrEqual(stillImageMaxSec() + 0.04);
  });

  it("B. a first extension that fits is still allowed — this is a budget, not a ban", () => {
    const state = createExtendHoldState();
    const d = mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 3.5 });
    expect(d.allowed).toBe(true);
  });

  it("C. a different source starts its own budget — the rule is about one picture", () => {
    const state = createExtendHoldState();
    recordExtension(state, "/w/a.mp4", 5);
    expect(mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 2 }).allowed).toBe(false);
    // A different clip is a different picture.
    expect(mayExtendAgain({ state, sourceClipPath: "/w/b.mp4", holdSec: 2 }).allowed).toBe(true);
  });

  it("D. adopting a real clip resets the run", () => {
    const state = createExtendHoldState();
    recordExtension(state, "/w/a.mp4", 5);
    expect(mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 2 }).allowed).toBe(false);
    resetExtendHold(state);
    // Something else has been on screen in between, so the picture genuinely changed.
    expect(mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 2 }).allowed).toBe(true);
  });

  it("E. the budget is RONDE 128's five seconds, not a new number", () => {
    expect(stillImageMaxSec()).toBe(5);
    const state = createExtendHoldState();
    const d = mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 5.5 });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.limitSec).toBe(stillImageMaxSec());
  });

  it("F. an attempt that never reached the screen is not charged", () => {
    const state = createExtendHoldState();
    // mayExtendAgain alone must not consume budget — only recordExtension does, and the pipeline
    // calls it after the push succeeds.
    for (let i = 0; i < 5; i++) mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 3 });
    expect(state.extendedSec).toBe(0);
  });

  it("G. the refusal line names the numbers", () => {
    const state = createExtendHoldState();
    recordExtension(state, "/w/a.mp4", 4);
    const d = mayExtendAgain({ state, sourceClipPath: "/w/a.mp4", holdSec: 3 });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    const line = formatExtendRefusal(1, 2, d);
    expect(line).toContain("s1b2");
    expect(line).toContain("extendLastClip REFUSED");
    expect(line).toContain("4.0s");
    expect(line).toContain("3.0s");
  });

  it("H. the production call site is guarded, and charges only on adoption", () => {
    const idx = PIPE.indexOf("// Try extending the last real clip before falling back to color");
    expect(idx).toBeGreaterThan(0);
    /**
     * Bounded by the block's own end marker rather than a character count. RONDE 167 documented
     * the extension's outcome branch inside this block and a fixed +N window stopped reaching
     * `recordExtension` — a green test turning red on a change that did not touch the rule.
     */
    const end = PIPE.indexOf("P0 (final visual coverage & zero-blue-fallback hardening", idx);
    expect(end).toBeGreaterThan(idx);
    const block = PIPE.slice(idx, end);
    expect(block).toContain("mayExtendAgain({");
    expect(block).toContain("if (!extendDecision.allowed)");
    expect(block).toContain("formatExtendRefusal(");
    // Charged after the push, never before. RONDE 94 wrapped the push in the adoption intent
    // that names this route (`rescue_extend`); the ordering rule is untouched.
    expect(block).toContain('withAdoptionIntent("rescue_extend"');
    const push = block.indexOf("pushClip(extended, holdSec)");
    const charge = block.indexOf("recordExtension(dedup.extendHold");
    expect(push).toBeGreaterThan(0);
    expect(charge).toBeGreaterThan(push);
  });

  it("I. the run resets wherever a real clip is adopted", () => {
    // Three adopt sites set lastRealClip; all three must reset, or a run survives a real picture.
    const sets = PIPE.split("dedup.lastRealClip = clipPath;").length - 1;
    const resets = PIPE.split("resetExtendHold(dedup.extendHold);").length - 1;
    expect(sets).toBe(3);
    expect(resets).toBe(sets);
  });

  it("J. the stillness audit is untouched — it must stay able to fail", () => {
    const audit = readFileSync(join(__dirname, "videoStillnessAudit.ts"), "utf8");
    expect(audit).toContain("violations.length === 0 && !report.endsOnBlack");
    expect(audit).toContain("const tolerance = 0.25");
    // No new escape hatch that would let a long still pass.
    expect(audit).not.toMatch(/rescue|extend|backfill/i);
  });
});

// ─── BUG 2 ───────────────────────────────────────────────────────────────────────────────────

function goringContext(): VerifiedQueryContext {
  const evidence = "In April 1945 Hermann Göring left Berlin for the south.";
  const ctx = emptyQueryContext(evidence);
  ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
  ctx.places = [provenToken("Berlin", "place", "beat_text", evidence)];
  ctx.years = [provenToken("1945", "year", "beat_text", evidence)];
  return ctx;
}

describe("RONDE 142 BUG 2 — every refusal reaches the feedback chain", () => {
  it("K. the shared gate classifies and records, where every route passes", () => {
    const idx = PIPE.indexOf("if (!relevance.allowed) {");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 2200);
    expect(block).toContain("classifyMismatch(relevance)");
    expect(block).toContain("recordMismatch(dedup.mismatchTally");
    // The provider comes from the lineage ledger, not the filename — RONDE 87 unchanged.
    expect(block).toContain("lineage.providerBucketFor(");
    expect(block).not.toContain("inferClipSourceFromPath");
  });

  it("L. the same candidate on the same beat is counted once", () => {
    const tally = createMismatchTally();
    const key = "content-abc|s1b2";
    expect(recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: key })).toBe(true);
    expect(recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: key })).toBe(false);
    expect(tally.total).toBe(1);
    expect(tally.byKind.get("MODERN_FOOTAGE")).toBe(1);
  });

  it("M. the same candidate on a DIFFERENT beat is counted again", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: "c|s1b2" });
    recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels", dedupeKey: "c|s1b3" });
    // A picture can be wrong for two different beats, and both refusals are real.
    expect(tally.total).toBe(2);
  });

  it("N. a caller with no dedupe key keeps the old unconditional behaviour", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "UNRELATED", source: "loc" });
    recordMismatch(tally, { kind: "UNRELATED", source: "loc" });
    expect(tally.total).toBe(2);
  });

  it("O. the research pass no longer requires a funnel winner", () => {
    // The judging loop needs a candidate; the research pass does not. Video 548 had 13 beats with
    // offered=0 that skipped the whole block, research included.
    const idx = PIPE.indexOf("if (beatImageRelevanceGateEnabled()) {");
    expect(idx).toBeGreaterThan(0);
    // RONDE 168: bounded by the adopt block's own end marker rather than a character count.
    const blockEnd = PIPE.indexOf("[VisualDiscovery] audit line", idx);
    expect(blockEnd).toBeGreaterThan(idx);
    const block = PIPE.slice(idx, blockEnd);
    const loopGuard = block.indexOf("const hasCandidateToJudge = winner !== null;");
    const endLoop = block.indexOf("end: candidates existed and were judged");
    const research = block.indexOf("const researchKey =");
    expect(loopGuard).toBeGreaterThan(0);
    expect(endLoop).toBeGreaterThan(loopGuard);
    // The research branch sits AFTER the winner-only block closes.
    expect(research).toBeGreaterThan(endLoop);
    expect(PIPE).not.toContain("if (winner && beatImageRelevanceGateEnabled())");
  });

  it("P. research reads the beat's kind from the shared gate, not only the funnel loop", () => {
    expect(PIPE).toContain("dedup.lastMismatchByBeat.get(researchKey)");
    expect(PIPE).toContain("kind: beatMismatchKind");
    expect(PIPE).toContain("lastMismatchByBeat: new Map<string, MismatchKind>()");
  });

  it("Q. a QUESTION fault can still trigger research when nothing won", () => {
    const d = decideResearch({
      kind: "MODERN_FOOTAGE",
      ctx: goringContext(),
      alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.blame).toBe("QUESTION");
    expect(d.correctedQuery).toContain("1945");
  });

  it("R. a MATERIAL fault never rewrites the subject", () => {
    const d = decideResearch({
      kind: "TITLE_CARD", ctx: goringContext(), alreadyResearched: false,
    });
    expect(d.blame).toBe("MATERIAL");
    if (d.action !== "RESEARCH") return;
    expect(d.strategy).toBe("ADD_ARCHIVAL_INTENT");
    expect(d.correctedQuery).toContain("Hermann Göring");
  });

  it("S. a beat with no better question is told so", () => {
    const evidence = "The decision was his alone.";
    const bare = emptyQueryContext(evidence);
    const d = decideResearch({ kind: "MODERN_FOOTAGE", ctx: bare, alreadyResearched: false });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("NO_BETTER_QUERY");
  });

  it("T. still at most one research pass per beat", () => {
    const d = decideResearch({
      kind: "MODERN_FOOTAGE", ctx: goringContext(), alreadyResearched: true,
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("ALREADY_RESEARCHED");
    expect(PIPE).toContain("dedup.mismatchResearchedBeats.add(researchKey);");
  });

  it("U. entity and provenance rules are untouched", () => {
    const kind = classifyMismatch({
      depicts: "a modern street", reason: "present-day footage, unrelated protest",
    });
    expect(mismatchFault(kind)).toBe("QUESTION");
    const d = decideResearch({ kind, ctx: goringContext(), alreadyResearched: false });
    if (d.action !== "RESEARCH") return;
    for (const w of ["present", "protest", "unrelated", "modern"]) {
      expect(d.correctedQuery.toLowerCase()).not.toContain(w);
    }
    expect(d.correctedQuery).toContain("Göring");
  });
});

describe("RONDE 142 — what this round must not have changed", () => {
  it("V. historical source preference, licence flow and cooldowns are as they were", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(funnel).toContain("internet_archive: 0.15");
    expect(funnel).toContain("STOCK_TIER_WIN_MARGIN");
    const lic = readFileSync(join(__dirname, "youtubeLicenseStatus.ts"), "utf8");
    expect(lic).toContain("ALLOW_UNVERIFIED_YOUTUBE");
    const fail = readFileSync(join(__dirname, "providerFailureClass.ts"), "utf8");
    expect(fail).toContain("DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000");
  });

  it("W. the closing tail and end-frame checks are as they were", () => {
    const tail = readFileSync(join(__dirname, "closingTail.ts"), "utf8");
    expect(tail).toContain("closingTailFrameSeek");
    expect(tail).not.toContain("params.lastSceneDurationSec - 0.1");
    const audit = readFileSync(join(__dirname, "videoStillnessAudit.ts"), "utf8");
    expect(audit).toContain("END_FRAME_BLACK_LUMA = 22");
  });

  it("X. the still-image policy is as it was", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toContain("export const MAX_STILL_IMAGE_DURATION_SEC = 5");
    expect(still).toContain("force_original_aspect_ratio=decrease");
  });
});
