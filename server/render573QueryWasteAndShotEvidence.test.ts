/**
 * RENDER 573 — 978 QUERIES BUILT TO BE REFUSED, AND TWO AUDITS MEASURING THE WRONG THING.
 *
 * ── What the render-wide summary lines said ─────────────────────────────────────────────────
 *
 *     [SearchGate] route=fetchPexelsClips  built=693 validated=236 rejected=457
 *     [SearchGate] route=fetchPixabayClips built=693 validated=236 rejected=457
 *     [SearchGate] rejectReasons UNVERIFIED_TERM=622 NO_CONTENT_ANCHOR=356
 *
 *     [GateFiring]    baked_text=6/267
 *     [ArchiveFilter] overlay budget spent (40/40) — clip allowed unchecked            ×75
 *
 *     [GlobalDirector] quality=poor issues=3 fallback_scene, no_wide_shots, no_close_ups
 *
 * Two thirds of every query the pipeline built was refused by its own gate. The baked-text gate
 * reported 267 answers while 75 of them were budget skips where nothing looked at the picture. And
 * the director's two variety findings were read off the NARRATION, so "no wide shots anywhere in
 * the video" was a statement about the script.
 *
 * None of the three is a gate being too strict. Each is a producer building, counting or measuring
 * something the consumer could never accept.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {  type BeatSemanticProfile } from "./semanticVisualMatching";
import { hasContentAnchor } from "./searchQueryContract";

const profile = (over: Partial<BeatSemanticProfile> = {}): BeatSemanticProfile => ({
  beatText: "In April 1945, deep in a bunker beneath Berlin, Adolf Hitler prepared to die.",
  summary: "a tense underground scene",
  entities: {
    persons: ["Adolf Hitler"],
    companies: [],
    objects: [],
    locations: ["Berlin"],
    events: [],
    emotions: [],
    timePeriods: [],
    years: ["1945"],
  },
  searchTiers: [["berlin 1945"]],
  topicDomain: "history",
  ...over,
});

describe("both analysers say which text they read", () => {
  const SEM = fs.readFileSync(path.join(__dirname, "semanticVisualMatching.ts"), "utf8");

  it("the fallback path is beat-authored on both fields, and says so", () => {
    const at = SEM.indexOf("searchTiers: dedupedTiers.length > 0");
    expect(at).toBeGreaterThan(-1);
    const region = SEM.slice(at, at + 400);
    expect(region).toContain('summarySource: "beat"');
    expect(region).toContain('searchTiersSource: "beat"');
  });

  it("the LLM path names the model only where the model actually wrote it", () => {
    const at = SEM.indexOf("summarySource: literalViewerVisual?.trim()");
    expect(at).toBeGreaterThan(-1);
    /** The caller's literal on-screen visual is the script, not the model. */
    const region = SEM.slice(at, at + 300);
    expect(region).toContain('? "beat"');
    expect(region).toContain('? "llm"');
  });
});

describe("an unchecked clip is not counted as a cleared one", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const FILTER = fs.readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");

  it("the counter is reset with the budget, so one render cannot inherit another's skips", () => {
    const at = FILTER.indexOf("export function resetOverlayBudget()");
    expect(at).toBeGreaterThan(-1);
    expect(FILTER.slice(at, at + 300)).toContain("overlayBudgetSkips = 0");
  });
});

describe("an expected refusal is a sentence, not a stack trace", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the two stock downloaders log the message", () => {
    /**
     * Fifteen two-frame bundled-worker stacks for `response exceeds maximum size of 83886080
     * bytes` — an ordinary refusal that already explains itself in its own sentence.
     */
    expect(PIPE).not.toContain("Pixabay download attempt ${attempt + 1} failed:`, dlErr)");
    expect(PIPE).not.toContain("Download attempt failed for Pexels clip ${idx}:`, err)");
    expect(PIPE).toContain("(dlErr as Error)?.message?.slice(0, 200)");
  });
});

describe("a skipped SELECTED event names the route that skipped it", () => {
  const LIN = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");

  it("the warning carries route= so 26 of them can be triaged", () => {
    const at = LIN.indexOf('code: "ADOPTED_WITHOUT_SELECTED"');
    expect(at).toBeGreaterThan(-1);
    expect(LIN.slice(at, at + 400)).toContain("route=${record.route}");
  });

  it("it stays a warning — a route that does no ranking legitimately skips it", () => {
    const at = LIN.indexOf('code: "ADOPTED_WITHOUT_SELECTED"');
    expect(LIN.slice(at - 1_400, at)).toContain("warnings.push({");
    /** No SELECTED event is invented anywhere to make this number go down. */
    expect(LIN.slice(at, at + 400)).not.toContain('recordEvent(id, "SELECTED"');
  });
});
