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

import { buildSemanticPexelsQueries, type BeatSemanticProfile } from "./semanticVisualMatching";
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

describe("the query builder does not build what the gate refuses by name", () => {
  it("drops a query whose words are nothing but production vocabulary", () => {
    /**
     * `establishing` ×32, `documentary` ×30 and `historical` ×4 all came back NO_CONTENT_ANCHOR.
     * `hasContentAnchor` answers false for each without needing a beat context at all, so the
     * refusal was knowable at the moment of building.
     */
    const out = buildSemanticPexelsQueries(
      "a beat",
      profile({ searchTiers: [["documentary", "establishing", "historical footage"]] }),
      8
    );
    expect(out).not.toContain("documentary");
    expect(out).not.toContain("establishing");
    expect(out).not.toContain("historical footage");
  });

  it("keeps a query that pairs production vocabulary with a real subject", () => {
    const out = buildSemanticPexelsQueries(
      "a beat",
      profile({ searchTiers: [["berlin 1945 documentary footage"]] }),
      8
    );
    expect(out).toContain("berlin 1945 documentary footage");
  });

  it("every query it now emits clears the same check the gate applies", () => {
    const out = buildSemanticPexelsQueries(
      "In April 1945, deep in a bunker beneath Berlin, Adolf Hitler prepared to die.",
      profile({ searchTiers: [["documentary"], ["berlin"], ["establishing"], ["1945"]] }),
      8
    );
    expect(out.length).toBeGreaterThan(0);
    for (const q of out) expect(hasContentAnchor(q), `"${q}" has no subject`).toBe(true);
  });

  it("the named entities the script proves are untouched", () => {
    const out = buildSemanticPexelsQueries("a beat", profile(), 8);
    expect(out).toContain("adolf hitler");
    expect(out).toContain("berlin");
    expect(out).toContain("1945");
  });
});

describe("a sentence the model wrote is not a query the script authorises", () => {
  /**
   * RONDE 91 §3: the LLM/director route may not introduce content. `summary` is pushed as a search
   * query, and on the LLM path it is `parsed.summary` — free text the model produced. The gate then
   * refuses it as UNVERIFIED_TERM with `termSource=unknown`, because a bare string names no source.
   */
  it("an LLM-authored summary is not pushed", () => {
    const out = buildSemanticPexelsQueries(
      "a beat",
      profile({ summary: "a tense underground scene", summarySource: "llm" }),
      8
    );
    expect(out).not.toContain("a tense underground scene");
  });

  it("a beat-authored summary still is", () => {
    const out = buildSemanticPexelsQueries(
      "a beat",
      profile({ summary: "berlin bunker 1945", summarySource: "beat" }),
      8
    );
    expect(out).toContain("berlin bunker 1945");
  });

  it("a profile from before the field existed behaves exactly as it did", () => {
    const p = profile({ summary: "berlin bunker 1945" });
    delete (p as Partial<BeatSemanticProfile>).summarySource;
    expect(buildSemanticPexelsQueries("a beat", p, 8)).toContain("berlin bunker 1945");
  });
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

  it("the budget skip is counted where it happens", () => {
    const at = FILTER.indexOf("overlayChecksPerformed >= maxChecks");
    expect(at).toBeGreaterThan(-1);
    expect(FILTER.slice(at, at + 1_400)).toContain("overlayBudgetSkips++");
    expect(FILTER).toContain("export function overlayBudgetSkipCount()");
  });

  it("the counter is reset with the budget, so one render cannot inherit another's skips", () => {
    const at = FILTER.indexOf("export function resetOverlayBudget()");
    expect(at).toBeGreaterThan(-1);
    expect(FILTER.slice(at, at + 300)).toContain("overlayBudgetSkips = 0");
  });

  it("the caller records notArmed when the detector did not run", () => {
    /** `[GateFiring] baked_text=6/267` counted 75 clips nothing had looked at. */
    const at = PIPE.indexOf('recordGateVerdict("baked_text"');
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at - 600, at + 200);
    expect(region).toContain("const skipsBefore = overlayBudgetSkipCount();");
    expect(region).toContain("armed: overlayBudgetSkipCount() === skipsBefore");
  });

  it("the fail-open itself is untouched — an exhausted budget still allows the clip", () => {
    const at = FILTER.indexOf("overlayChecksPerformed >= maxChecks");
    const region = FILTER.slice(at, at + 1_600);
    expect(region).toContain("return false;");
  });
});

describe("the director's variety findings are about the film, not the script", () => {
  const DIR = fs.readFileSync(path.join(__dirname, "globalDocumentaryDirector.ts"), "utf8");
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("observed framings decide when any clip was judged", () => {
    const at = DIR.indexOf("const observed = clips");
    expect(at).toBeGreaterThan(-1);
    const region = DIR.slice(at, at + 900);
    expect(region).toContain("shotTypeOf?.(c)");
    expect(region).toContain('observed.length > 0 ? "observed_frames" : "narration_text"');
  });

  it("the narration reading survives as the fallback, unchanged", () => {
    const at = DIR.indexOf("const observed = clips");
    const region = DIR.slice(at, at + 900);
    expect(region).toContain("WIDE_TEXT_TOKENS.test(allText)");
    expect(region).toContain("CLOSE_TEXT_TOKENS.test(allText)");
  });

  it("the finding states which of the two it was built on", () => {
    const at = DIR.indexOf("const observedScenes = profiles.filter");
    expect(at).toBeGreaterThan(-1);
    const region = DIR.slice(at, at + 900);
    expect(region).toContain("no clip was judged — read from the narration's own words");
    expect(region).toContain("observed framings in ");
  });

  it("the pipeline hands it the same resolver assetDirector gets", () => {
    const at = PIPE.indexOf("analyzeVideoStructure(");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 900);
    expect(region).toContain("observedShotType");
    expect(region).toContain("cinematography?.shotType");
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
