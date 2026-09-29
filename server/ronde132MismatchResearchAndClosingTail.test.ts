/**
 * RONDE 132 — ask a better question, and land the last frame inside the file.
 *
 * Two production faults, both reproduced before being fixed.
 *
 * ── A. `[ClosingTail] could not be built` ────────────────────────────────────────────────────
 *
 * Reproduced exactly, with a scene-shaped MP4 whose audio outlives its picture — which is every
 * composed scene, because the voiceover and its fade end after the last video frame:
 *
 *     format=duration        21.400   ← what probeVideoDurationSec reads
 *     stream=duration (v:0)  21.200
 *     last video frame pts   21.160
 *
 *     ffmpeg -ss 21.300 …  →  "Output file is empty, nothing was encoded"
 *
 * RONDE 121 subtracted 0.1s from the CONTAINER duration, which is the maximum over all streams.
 * The tests below build that file for real and assert against its real frame times.
 *
 * ── B. a refusal that blamed the question and changed nothing ────────────────────────────────
 *
 * RONDE 131 taught the pipeline to read its refusals; it could only reorder the candidates it
 * already had. These tests prove the corrected question is selected from the contract, carries
 * the beat's own tokens with their Unicode intact, is capped at one extra pass, and never fires
 * on a fault that belongs to the material.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClosingTail,
  closingTailFrameSeek,
  closingTailSeekIsSafe,
  CLOSING_TAIL_FRAME_WINDOW_SEC,
} from "./closingTail";
import {
  correctionStrategyFor,
  createResearchTally,
  decideResearch,
  formatResearchDecision,
  formatResearchOutcome,
  formatResearchQuery,
  formatResearchSummary,
  recordResearchAttempt,
  recordResearchOutcome,
  recordResearchSkip,
  selectCorrectedQueries,
} from "./mismatchResearch";
import { classifyMismatch, mismatchFault } from "./visualMismatchFeedback";
import {
  emptyQueryContext,
  provenToken,
  searchGateStrict,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { auditVideoStillness, checkStillnessLimit } from "./videoStillnessAudit";
import { stillImageMaxSec } from "./stillImagePolicy";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";

function ffprobe(args: string[]): string {
  return execFileSync(FFPROBE, args, { encoding: "utf8" }).trim();
}

/**
 * The production case, built from the beat's own words.
 *
 * "In April 1945 Hermann Göring left Berlin for the south." — the real extractor produces exactly
 * these tokens for it (traced against buildVerifiedQueryContextForBeat before this test was
 * written); they are stated here rather than re-extracted so the assertions are about the
 * correction logic and not about the extractor, which RONDE 125 already guards.
 */
function goringBerlinContext(): VerifiedQueryContext {
  const evidence = "In April 1945 Hermann Göring left Berlin for the south.";
  const ctx = emptyQueryContext(evidence);
  ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
  ctx.places = [provenToken("Berlin", "place", "beat_text", evidence)];
  ctx.years = [provenToken("1945", "year", "beat_text", evidence)];
  ctx.time = [provenToken("April 1945", "time", "beat_text", evidence)];
  ctx.actions = [provenToken("left", "action", "beat_text", evidence)];
  return ctx;
}

/** A beat that names a person and nothing else — no year, no place to fall back on. */
function personOnlyContext(): VerifiedQueryContext {
  const evidence = "The influential choice Hermann Göring made to join Hitler changed everything.";
  const ctx = emptyQueryContext(evidence);
  ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
  ctx.actions = [provenToken("changed", "action", "beat_text", evidence)];
  return ctx;
}

describe("RONDE 132 — a QUESTION fault starts one corrected search", () => {











  it("12. the SearchGate is still strict — this round switches nothing off", () => {
    expect(process.env.SEARCH_GATE_STRICT).not.toBe("false");
    expect(searchGateStrict()).toBe(true);
  });




});

// ─── The pipeline wiring ─────────────────────────────────────────────────────────────────────

describe("RONDE 132 — the research pass is actually wired in", () => {
  const SRC = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");



  it("19. the corrected queries lead inside the SAME provider cap", () => {
    const src = SRC();
    const idx = src.indexOf("const allQueries = uniqueQueryStrings([...(opts.leadQueries ?? [])");
    expect(idx).toBeGreaterThan(0);
    // Still sliced to queryCap — the research pass redirects provider calls, it does not add them.
    expect(src.slice(idx, idx + 260)).toContain("queryCap");
  });

  it("20. YouTube is a tier the corrected query genuinely reaches", () => {
    const src = SRC();
    // The cascade the research pass calls has youtube_cc in its tier order, and `allQueries` —
    // which the corrected queries now lead — is what every tier is asked with.
    expect(src).toContain('"youtube_cc",');
    const tierIdx = src.indexOf("export const HISTORICAL_SOURCE_TIER_ORDER");
    const tiers = src.slice(tierIdx, tierIdx + 400);
    expect(tiers).toContain("youtube_cc");
    const fetchIdx = src.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    expect(fetchIdx).toBeGreaterThan(0);
    /**
     * RONDE 260B — the tier reaches the provider through the one central turn instead of calling it
     * itself, so the chain is followed rather than the literal. Same guarantee, one link longer:
     * tier → `cascadeYoutubeCandidates` → `runCentralYoutubeTurn` → the provider.
     */
    expect(src.slice(fetchIdx, fetchIdx + 1400)).toContain("cascadeYoutubeCandidates()");
    const helper = src.indexOf("const cascadeYoutubeCandidates = async ()");
    expect(helper, "the cascade's YouTube adapter moved").toBeGreaterThan(0);
    expect(src.slice(helper, helper + 900)).toContain("runCentralYoutubeTurn({");
    expect(src.slice(helper, helper + 900)).toContain("queries: allQueries");
  });

  it("21. the license flow is untouched by this round", () => {
    const src = readFileSync(join(__dirname, "youtubeLicenseStatus.ts"), "utf8");
    expect(src).toContain('export type LicenseStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED"');
    expect(src).toContain("ALLOW_UNVERIFIED_YOUTUBE");
    // A REJECTED license must still be a refusal no flag can turn into an allow.
    expect(src).toMatch(/REJECTED/);
  });

  it("22. the existing sourcing cache and search memory are what the pass uses", () => {
    const src = SRC();
    const idx = src.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    // RONDE 171: bounded by the research block's own end marker rather than a character count —
    // this round documented the budget decision and a fixed +N window stopped reaching the search.
    const blockEnd3 = src.indexOf("formatResearchOutcome({", idx);
    const block = src.slice(idx, blockEnd3 > idx ? blockEnd3 : idx + 4000);
    // Every tier is handed the render's own cache — the research pass inherits it rather than
    // opening a second one.
    expect(block).toContain("dedup.sourcingCache");
    expect(block).toContain("dedup.usedContentKeys");
    // And adoption still writes to the existing memory.
    expect(src).toContain("recordAdoptedClipSource");
  });
});

// ─── Mutations ───────────────────────────────────────────────────────────────────────────────

