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

  it("I. the run resets wherever a real clip is adopted", () => {
    // One adopt site sets lastRealClip (the stock-ladder and curated-montage ones were deleted); it must reset.
    const sets = PIPE.split("dedup.lastRealClip = clipPath;").length - 1;
    const resets = PIPE.split("resetExtendHold(dedup.extendHold);").length - 1;
    expect(sets).toBe(1);
    expect(resets).toBe(sets);
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

  it("X. the still-image policy is as it was", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toContain("export const MAX_STILL_IMAGE_DURATION_SEC = 5");
    expect(still).toContain("force_original_aspect_ratio=decrease");
  });
});
