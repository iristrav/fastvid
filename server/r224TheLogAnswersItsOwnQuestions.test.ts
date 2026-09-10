/**
 * RONDE 224 — TWO ANSWERS THIS PROGRAMME ALREADY HAD, AND COULD NOT READ.
 *
 * Three renders failed with the same sentence — `Scene N: X zinnen maar 0 voice/script-matchende
 * clips — export geblokkeerd` — and after each one the cause could only be narrowed, never named.
 * Not because the pipeline does not record it. Because neither recording is reachable from where
 * the render actually dies.
 *
 * ── A. The gate's decline tally is printed past the point of death ──────────────────────────
 *
 * `vision=NOT_ASKED` reaches the adoption guard from SEVEN distinct causes:
 *
 *     gate switched off · no provider reachable · no narration to judge against ·
 *     render budget spent · no readable frame · frames unusable as images ·
 *     provider with no capacity
 *
 * Only two of the seven latch `askImpossible`, so the other five leave the guard demanding
 * evidence that nothing was going to produce. RONDE 115 built the line that tells them apart —
 * `formatNoVerdictReasons` — and RONDE 105 counts every one. Both work. Both are called only past
 * line 43000, inside the export gate and the quality report.
 *
 * A scene that ends with nothing throws thousands of lines earlier. Measured: render 576 has ZERO
 * `[BeatImageGate]` lines; render 574, which survived to the report, has one. The render that
 * needs the explanation is precisely the render that never prints it.
 *
 * ── B. The refusal line asks where a term came from and answers "unknown" ───────────────────
 *
 *     [SearchQueryRejected] … query="documentary" term="documentary"
 *                           termSource=unknown reason=NO_CONTENT_ANCHOR
 *
 * 410 times in render 576, every one of them `unknown`. `formatSearchQueryRejected` has carried a
 * `termSource` field since RONDE 90 and its only caller never filled it in — while `ticket.tokens`
 * held the provenance the whole time.
 *
 * NEITHER CHANGE ALTERS A DECISION. No verdict moves, no gate moves, no threshold moves, nothing
 * is retried. This round only makes the render able to say what it already knew.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  createBeatImageGateState,
  formatNoVerdictReasons,
} from "./beatImageRelevanceGate";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CONTRACT = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

/* ═══════════ 1. the decline tally reaches the place a render dies ═══════════ */

describe("R224 §1 — the scene gate says why nobody could judge", () => {
  const block = () => {
    const at = PIPE.indexOf("const why = formatNoVerdictReasons(dedup.beatImageGate);");
    expect(at, "the scene gate still dies without printing the tally").toBeGreaterThan(0);
    return PIPE.slice(at - 200, at + 1400);
  };

  it("THE TALLY IS PRINTED WHERE THE SCENE GATE GIVES UP", () => {
    expect(block()).toContain("formatNoVerdictReasons(dedup.beatImageGate)");
  });

  it("BEFORE the throw, so a failing render carries its own explanation", () => {
    const why = PIPE.indexOf("const why = formatNoVerdictReasons(dedup.beatImageGate);");
    const thrown = PIPE.indexOf("voice/script-matchende clips — export geblokkeerd");
    expect(why).toBeGreaterThan(0);
    expect(thrown).toBeGreaterThan(0);
    expect(why, "the explanation prints after the render has already thrown").toBeLessThan(thrown);
  });

  it("AND BEFORE THE OTHER EXIT — the archive-only deployment needs it too", () => {
    const why = PIPE.indexOf("const why = formatNoVerdictReasons(dedup.beatImageGate);");
    const carriesOn = PIPE.indexOf("pipeline gaat door met lege montage");
    expect(carriesOn).toBeGreaterThan(0);
    expect(why).toBeLessThan(carriesOn);
  });

  it("the seven-way partition is reported by its own counters, not summarised away", () => {
    const b = block();
    for (const counter of [
      "judgementAttempts",
      "judgementsFits",
      "judgementsMismatch",
      "judgementsFailed",
      "judgementsSkipped",
      "judgementsProviderUnavailable",
      "askImpossible",
    ]) {
      expect(b, `${counter} is not on the line`).toContain(counter);
    }
  });

  it("NOTHING WAS DECIDED HERE — reporting only", () => {
    const b = block();
    expect(b, "the tally changed a verdict").not.toContain("askImpossible =");
    expect(b, "the tally retried something").not.toContain("continue;");
    expect(b).not.toContain("noteAskImpossible");
  });

  it("the tally itself is unchanged — RONDE 115's line, reached earlier", () => {
    expect(GATE).toContain("export function formatNoVerdictReasons(");
    expect(GATE).toContain("state.noVerdictReasons.set(reason,");
  });

  it("MEASURED: an empty gate says nothing, a declined one names the reason", () => {
    const state = createBeatImageGateState();
    expect(formatNoVerdictReasons(state)).toBe("");
    state.noVerdictReasons.set("provider unavailable (no capacity)", 44);
    state.noVerdictReasons.set("no frame available", 3);
    const line = formatNoVerdictReasons(state);
    expect(line).toContain("[BeatImageGate] no verdict:");
    expect(line).toContain("44x provider unavailable (no capacity)");
    /** Sorted by frequency: the useful signal is the one that happened forty-four times. */
    expect(line.indexOf("44x")).toBeLessThan(line.indexOf("3x"));
  });
});

/* ═══════════ 2. every decline still routes through one place ═══════════ */

describe("R224 §2 — the seven causes remain distinguishable", () => {
  it("ALL SEVEN DECLINES ARE STILL COUNTED BY REASON", () => {
    const declines = [...GATE.matchAll(/return declined\("([^"]+)"|return declined\(`([^`]+)`/g)];
    expect(
      declines.length,
      "a decline path stopped naming itself, so the tally can no longer tell it apart"
    ).toBeGreaterThanOrEqual(7);
  });

  it("EXACTLY THREE CAUSES LATCH askImpossible, and they are the three that mean nobody could look", () => {
    /**
     * The count is the assertion: a fourth latch would suspend the vision requirement for a cause
     * that is not "this render has no picture editor", which is the one thing this round must not
     * do by accident.
     *
     * Three, not two — recorded here because the analysis that led to this round got it wrong.
     * `provider has no capacity` (line ~920) DOES latch; the `return declined(...)` on the line
     * below it was read as the whole branch. So of the seven ways to reach `vision=NOT_ASKED`,
     * three latch and four do not:
     *
     *     latch:     gate switched off · no provider reachable · provider has no capacity
     *     no latch:  no narration · render budget spent · no readable frame · frames unusable
     *
     * Which matters for render 576: the guard demanded evidence, so no latch was set, so all three
     * latching causes are excluded. `no narration` prints RONDE 215's warning (absent from that
     * log) and `budget spent` is bypassed by `finalSay`, leaving the two FRAME causes.
     */
    const definition = [...GATE.matchAll(/function noteAskImpossible\(/g)].length;
    const callSites = [...GATE.matchAll(/^\s+noteAskImpossible\(/gm)].length;
    expect(definition).toBe(1);
    expect(callSites, "a decline path started or stopped latching").toBe(3);
  });

  it("a decline is still `evaluated: false`, so it still reads as NOT_ASKED", () => {
    expect(GATE).toContain("return unknown(reason, false);");
  });
});

/* ═══════════ 3. the refusal line names the term's origin ═══════════ */

describe("R224 §3 — termSource is filled in", () => {
  const caller = () => {
    const at = CONTRACT.indexOf("const offending = verdict.offendingTerm?.trim().toLowerCase();");
    expect(at, "the rejection line still reports termSource=unknown for everything").toBeGreaterThan(0);
    return CONTRACT.slice(at, at + 900);
  };

  it("THE OFFENDING TERM'S OWN TOKEN IS LOOKED UP", () => {
    expect(caller()).toContain("ticket.tokens.find(");
  });

  it("AND ITS SOURCE IS PASSED TO THE LINE", () => {
    expect(caller()).toContain("termSource: offendingToken?.source,");
  });

  it("matched case-insensitively, because the gate lowercases as it tokenises", () => {
    const c = caller();
    expect(c).toContain("trim().toLowerCase()");
    expect((c.match(/toLowerCase\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("NO TOKEN MATCH STILL READS `unknown` — which is itself a finding", () => {
    /**
     * A term that is not one of the ticket's own tokens is a real anomaly, and the field must keep
     * saying so rather than inventing a plausible source.
     */
    expect(CONTRACT).toContain(`termSource=${"${meta.termSource ?? \"unknown\"}"}`);
  });

  it("NOTHING ABOUT THE DECISION CHANGED — the refusal is still a refusal", () => {
    const c = caller();
    expect(c).toContain("reason: verdict.reason ?? \"UNVERIFIED_TERM\"");
    expect(c, "the gate started admitting what it refused").not.toContain("admitted: true");
  });

  it("the provenance vocabulary is untouched", () => {
    expect(CONTRACT).toContain("export type QueryTokenSource =");
    for (const src of ["beat_text", "scene_text", "proven_entity", "llm_generated", "unknown"]) {
      expect(CONTRACT).toContain(`"${src}"`);
    }
  });
});

/* ═══════════ 4. RONDE 226 — the funnel reaches the same place ═══════════ */

describe("R226 §4 — the beat funnel prints where the render dies", () => {
  it("THE FUNNEL IS EMITTED AT THE SCENE GATE", () => {
    expect(
      PIPE,
      "the funnel still only prints inside the report, past the throw"
    ).toContain("for (const line of formatBeatShortlists(dedup.beatShortlist)) console.error(line);");
  });

  it("BEFORE the throw, beside the vision tally", () => {
    const funnel = PIPE.indexOf("formatBeatShortlists(dedup.beatShortlist)");
    const tally = PIPE.indexOf("const why = formatNoVerdictReasons(dedup.beatImageGate);");
    const thrown = PIPE.indexOf("voice/script-matchende clips — export geblokkeerd");
    expect(funnel).toBeGreaterThan(0);
    expect(funnel).toBeGreaterThan(tally);
    expect(funnel, "the funnel prints after the render has thrown").toBeLessThan(thrown);
  });

  it("the report's own copy is untouched — one formatter, two readers", () => {
    /**
     * Two CALL sites: the scene gate added here, and the report's own at ~44187. The import is a
     * bare name without a paren and is deliberately not counted, so this asserts readers rather
     * than mentions.
     */
    expect((PIPE.match(/formatBeatShortlists\(/g) ?? []).length).toBe(2);
    expect(PIPE, "the report stopped printing its own funnel").toContain(
      "for (const line of formatBeatShortlists(visualDedup.beatShortlist)) {"
    );
  });

  it("it carries the counter the whole question turns on", () => {
    const shortlist = fs.readFileSync(path.join(__dirname, "beatShortlist.ts"), "utf8");
    expect(shortlist).toContain("visionAsked=${f.visionAsked}");
    expect(shortlist).toContain("ranked=${f.ranked}");
    expect(shortlist).toContain("shortlisted=${f.shortlisted}/${cap}");
  });
});
