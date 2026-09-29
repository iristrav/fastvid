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


describe("RONDE 142 — what this round must not have changed", () => {

  it("X. the still-image policy is as it was", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toContain("export const MAX_STILL_IMAGE_DURATION_SEC = 5");
    expect(still).toContain("force_original_aspect_ratio=decrease");
  });
});
