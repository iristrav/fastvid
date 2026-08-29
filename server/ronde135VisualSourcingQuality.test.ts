/**
 * RONDE 135 — from the right question to the right picture.
 *
 * ── What the audit found, before anything was changed ────────────────────────────────────────
 *
 * Two of this round's asks turned out to be already satisfied, and saying so is part of the work:
 *
 *  §9/§13 historical sources over modern stock. Implemented twice already, in both directions.
 *         `EXTERNAL_SOURCE_TIER_BONUS` in retrievalFunnel.ts ranks internet_archive 0.15 down to
 *         pexels/pixabay 0 BEFORE anything is downloaded, and `pickBestFunnelCandidate` then lets
 *         stock win only when it beats non-stock by a full point on a scale RONDE 65 measured as
 *         rarely discriminating at all. Adding a third mechanism would have been noise.
 *  §14    material faults look for other material first. Already true by construction: the
 *         research pass only runs at the point where `winner` is null, which is after the beat's
 *         whole candidate pool has been judged and refused.
 *
 * What was genuinely missing, and what this round adds:
 *
 *  1. The classification was too coarse. Seven kinds, with no way to say "the right people at the
 *     wrong event", "the frame IS a title card", or "present-day footage" as distinct from a
 *     general period error. Tests 1-14.
 *  2. WRONG_EVENT had no correction. Adding the person does not fix a picture the person is
 *     already in. Tests 15-18.
 *  3. Nothing carried a refusal across beats. RONDE 131 reorders within one beat and forgets.
 *     Tests 19-24.
 *  4. `byKindAndSource` has been recorded since RONDE 131 and never printed, so no render could
 *     say WHICH provider produced its refusals. Tests 25-31.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  classifyMismatch,
  createMismatchTally,
  mismatchFault,
  recordMismatch,
  reorderAfterMismatch,
  repeatOffenderSources,
  REPEAT_OFFENDER_MIN_REFUSALS,
  type MismatchKind,
} from "./visualMismatchFeedback";
import {
  correctionStrategyFor,
  decideResearch,
  buildResearchContext,
} from "./mismatchResearch";
import {
  findUnproductiveProviders,
  formatVisualSourcingAudit,
  REPORTED_MISMATCH_KINDS,
  summarizeProviderOutcomes,
} from "./visualSourcingAudit";
import {
  emptyQueryContext,
  provenToken,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

const SCENE_TEXT =
  "In April 1945 Hermann Göring left Berlin for the south. " +
  "He had commanded the Luftwaffe since 1935. " +
  "Adolf Hitler had already turned against him.";

const researchCtxFor = (beatText: string): VerifiedQueryContext =>
  buildResearchContext({
    beat: buildVerifiedQueryContextForBeat(beatText, { sceneText: SCENE_TEXT }),
    scene: buildVerifiedQueryContextForBeat(SCENE_TEXT, { sceneText: SCENE_TEXT }),
  });

describe("RONDE 135 — every refusal gets a name", () => {
  it("1. present-day footage is MODERN_FOOTAGE, not a generic period error", () => {
    expect(
      classifyMismatch({
        depicts: "a modern city street with parked cars, filmed in colour",
        reason: "present-day footage under narration about Berlin in April 1945",
      })
    ).toBe("MODERN_FOOTAGE");
  });

  it("2. a decade error is still WRONG_PERIOD", () => {
    expect(
      classifyMismatch({
        depicts: "a newsreel of a parade",
        reason: "this looks like a different decade — 1960s rather than the 1940s",
      })
    ).toBe("WRONG_PERIOD");
  });

  it("3. the frame that IS text is a TITLE_CARD", () => {
    expect(
      classifyMismatch({ depicts: "a title card with white lettering on black", reason: "not footage" })
    ).toBe("TITLE_CARD");
  });

  it("4. text OVER footage is TEXT_ON_SCREEN", () => {
    expect(
      classifyMismatch({
        depicts: "archive footage of a rally with a broadcaster's watermark in the corner",
        reason: "a watermark covers part of the frame",
      })
    ).toBe("TEXT_ON_SCREEN");
  });

  it("5. the right people at the wrong occasion is WRONG_EVENT", () => {
    expect(
      classifyMismatch({
        depicts: "Göring and other officers at a large rally",
        reason: "this is a different event from the one the narration describes",
      })
    ).toBe("WRONG_EVENT");
  });

  it("6. an empty frame is LOW_INFORMATION", () => {
    expect(classifyMismatch({ depicts: "a black screen", reason: "nothing is visible" }))
      .toBe("LOW_INFORMATION");
    expect(classifyMismatch({ depicts: "an out of focus blur", reason: "shows nothing" }))
      .toBe("LOW_INFORMATION");
  });

  it("7. a talking head is still a talking head", () => {
    expect(
      classifyMismatch({ depicts: "a man talking to camera", reason: "modern commentary" })
    ).toBe("TALKING_HEAD");
  });

  it("8. an unreadable refusal is still UNCLEAR and still acted on by nobody", () => {
    expect(classifyMismatch({ depicts: "a grey image", reason: "no" })).toBe("UNCLEAR");
    expect(correctionStrategyFor("UNCLEAR")).toBeNull();
  });
});

describe("RONDE 135 — QUESTION and MATERIAL stay distinct", () => {
  it("9. every period, subject, place and event fault indicts the QUESTION", () => {
    for (const k of [
      "WRONG_PERIOD", "MODERN_FOOTAGE", "WRONG_SUBJECT", "WRONG_PLACE", "WRONG_EVENT", "UNRELATED",
    ] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("QUESTION");
    }
  });

  it("10. every fault about the material indicts the MATERIAL", () => {
    for (const k of [
      "TEXT_ON_SCREEN", "TITLE_CARD", "TALKING_HEAD", "LOW_INFORMATION",
    ] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("MATERIAL");
    }
  });

  it("11. every kind has a fault and none falls through the switch", () => {
    for (const k of REPORTED_MISMATCH_KINDS) {
      expect(["QUESTION", "MATERIAL", "UNKNOWN"]).toContain(mismatchFault(k));
    }
  });

  it("12. the reported kind list covers every kind the classifier can return", () => {
    // A kind missing from the report would be counted and never shown — the RONDE 131 failure
    // shape, one level up.
    const kinds = new Set<MismatchKind>(REPORTED_MISMATCH_KINDS);
    const src = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");
    /**
     * Scoped to the MismatchKind declaration itself.
     *
     * This used to scrape every `| "UPPER_CASE"` line in the file and skip a hardcoded list of
     * MismatchFault's members — so any OTHER string union added to the module failed this test
     * while saying nothing about the kinds. RONDE 166 added MismatchSeverity and did exactly that.
     * Reading the one declaration the assertion is about keeps it guarding what it claims to.
     */
    const start = src.indexOf("export type MismatchKind =");
    const block = src.slice(start, src.indexOf(";", src.indexOf('| "UNCLEAR"', start)));
    const declared = [...block.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map((m) => m[1] as MismatchKind);
    expect(declared.length).toBeGreaterThan(5);
    for (const k of declared) {
      expect(kinds.has(k), `${k} is not in REPORTED_MISMATCH_KINDS`).toBe(true);
    }
  });

  it("13. a material fault never rewrites the subject of the question", () => {
    const ctx = researchCtxFor("The decision was his alone.");
    for (const k of ["TEXT_ON_SCREEN", "TITLE_CARD", "TALKING_HEAD"] as MismatchKind[]) {
      const d = decideResearch({ kind: k, ctx, alreadyResearched: false });
      expect(d.blame).toBe("MATERIAL");
      if (d.action !== "RESEARCH") continue;
      expect(d.strategy).toBe("ADD_ARCHIVAL_INTENT");
      expect(d.correctedQuery).toContain("Hermann Göring");
    }
  });

  it("14. LOW_INFORMATION starts no research at all", () => {
    expect(correctionStrategyFor("LOW_INFORMATION")).toBeNull();
    const d = decideResearch({
      kind: "LOW_INFORMATION", ctx: researchCtxFor("The decision was his alone."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("MATERIAL");
  });
});

describe("RONDE 135 — WRONG_EVENT gets its own correction", () => {
  function eventContext(): VerifiedQueryContext {
    const evidence = "The Reichstag fire brought Hermann Göring to Berlin in 1933.";
    const ctx = emptyQueryContext(evidence);
    ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
    ctx.places = [provenToken("Berlin", "place", "beat_text", evidence)];
    ctx.events = [provenToken("Reichstag fire", "event", "beat_text", evidence)];
    ctx.years = [provenToken("1933", "year", "beat_text", evidence)];
    return ctx;
  }

  it("15. WRONG_EVENT names the occasion instead of re-adding the person", () => {
    expect(correctionStrategyFor("WRONG_EVENT")).toBe("ADD_EVENT");
    const d = decideResearch({
      kind: "WRONG_EVENT", ctx: eventContext(), alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQuery.toLowerCase()).toContain("reichstag fire");
  });

  it("16. a beat that names no event is told so rather than given one", () => {
    const d = decideResearch({
      kind: "WRONG_EVENT", ctx: researchCtxFor("The decision was his alone."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("NO_BETTER_QUERY");
  });

  it("17. MODERN_FOOTAGE takes the period correction", () => {
    expect(correctionStrategyFor("MODERN_FOOTAGE")).toBe("ADD_TIME");
    const d = decideResearch({
      kind: "MODERN_FOOTAGE", ctx: researchCtxFor("The decision was his alone."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQuery).toContain("1945");
  });

  it("18. every WRONG_EVENT correction still passes the SearchGate", () => {
    const ctx = eventContext();
    const d = decideResearch({ kind: "WRONG_EVENT", ctx, alreadyResearched: false });
    if (d.action !== "RESEARCH") return;
    for (const q of d.correctedQueries) {
      const v = validateSearchQuery(q, ctx);
      expect(v.ok, `"${q}" rejected as ${v.reason}`).toBe(true);
    }
  });
});

describe("RONDE 135 — the render learns from its own refusals", () => {
  const cand = (id: string, source: string) => ({ id, source });

  it("19. a source refused repeatedly for period faults becomes a repeat offender", () => {
    const tally = createMismatchTally();
    for (let i = 0; i < REPEAT_OFFENDER_MIN_REFUSALS; i++) {
      recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "pexels" });
    }
    expect(repeatOffenderSources(tally).has("pexels")).toBe(true);
  });

  it("20. one refusal is noise, not a pattern", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "wikimedia" });
    expect(repeatOffenderSources(tally).size).toBe(0);
  });

  it("21. WRONG_PERIOD and MODERN_FOOTAGE count together — they are one family", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "youtube" });
    recordMismatch(tally, { kind: "WRONG_PERIOD", source: "youtube" });
    recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "youtube" });
    expect(repeatOffenderSources(tally).has("youtube")).toBe(true);
  });

  it("22. title cards do not make a source a period offender", () => {
    const tally = createMismatchTally();
    for (let i = 0; i < 6; i++) recordMismatch(tally, { kind: "TITLE_CARD", source: "youtube" });
    // A source that returns title cards is not a source that returns the wrong century.
    expect(repeatOffenderSources(tally).size).toBe(0);
  });

  it("23. a learned offender sorts last, and is never removed", () => {
    const field = [cand("a", "youtube"), cand("b", "wikimedia"), cand("c", "loc")];
    const tally = createMismatchTally();
    for (let i = 0; i < 4; i++) recordMismatch(tally, { kind: "MODERN_FOOTAGE", source: "youtube" });

    const out = reorderAfterMismatch(field, "MODERN_FOOTAGE", (c) => c.source, repeatOffenderSources(tally));
    expect(out).toHaveLength(3);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(["a", "b", "c"]));
    // wikimedia and loc are historical archives and lead; youtube, learned-bad, goes last.
    expect(out[out.length - 1]!.id).toBe("a");
  });

  it("24. with no learned offenders the reorder is exactly RONDE 131's", () => {
    const field = [cand("a", "pexels"), cand("b", "wikimedia")];
    const withEmpty = reorderAfterMismatch(field, "MODERN_FOOTAGE", (c) => c.source, new Set());
    const without = reorderAfterMismatch(field, "MODERN_FOOTAGE", (c) => c.source);
    expect(withEmpty.map((c) => c.id)).toEqual(without.map((c) => c.id));
  });
});

describe("RONDE 135 — the render can finally say which provider failed it", () => {
  function tallyWithSources(): ReturnType<typeof createMismatchTally> {
    const t = createMismatchTally();
    for (let i = 0; i < 8; i++) recordMismatch(t, { kind: "MODERN_FOOTAGE", source: "pexels" });
    for (let i = 0; i < 5; i++) recordMismatch(t, { kind: "TITLE_CARD", source: "youtube" });
    for (let i = 0; i < 2; i++) recordMismatch(t, { kind: "WRONG_SUBJECT", source: "wikimedia" });
    return t;
  }

  it("25. per-provider outcomes are derived from the tally and the adopt audit", () => {
    const rows = summarizeProviderOutcomes({
      tally: tallyWithSources(),
      adoptedByProvider: new Map([["wikimedia", 6], ["internet_archive", 4], ["youtube", 3]]),
    });
    const byName = new Map(rows.map((r) => [r.provider, r]));
    expect(byName.get("pexels")).toMatchObject({ judged: 8, refused: 8, accepted: 0 });
    expect(byName.get("youtube")).toMatchObject({ judged: 8, refused: 5, accepted: 3 });
    expect(byName.get("wikimedia")).toMatchObject({ judged: 8, refused: 2, accepted: 6 });
    // A provider that was never refused still appears, on the strength of its adoptions.
    expect(byName.get("internet_archive")).toMatchObject({ judged: 4, refused: 0, accepted: 4 });
  });

  it("26. the worst provider is reported first", () => {
    const rows = summarizeProviderOutcomes({ tally: tallyWithSources() });
    expect(rows[0]!.provider).toBe("pexels");
  });

  it("27. each provider carries the fault it is refused for most often", () => {
    const rows = summarizeProviderOutcomes({ tally: tallyWithSources() });
    expect(rows.find((r) => r.provider === "pexels")!.topKind).toBe("MODERN_FOOTAGE");
    expect(rows.find((r) => r.provider === "youtube")!.topKind).toBe("TITLE_CARD");
  });

  it("28. accepted and refused partition judged", () => {
    const rows = summarizeProviderOutcomes({
      tally: tallyWithSources(),
      adoptedByProvider: new Map([["wikimedia", 6]]),
    });
    for (const r of rows) expect(r.accepted + r.refused).toBe(r.judged);
  });

  it("29. a provider that supplied plenty and passed nothing is flagged, not removed", () => {
    const rows = summarizeProviderOutcomes({ tally: tallyWithSources() });
    const dead = findUnproductiveProviders(rows);
    expect(dead.map((d) => d.provider)).toContain("pexels");
    // Flagged only — the row is still in the report, and nothing removes the provider.
    expect(rows.map((r) => r.provider)).toContain("pexels");
  });

  it("30. the audit block reads as one thing", () => {
    const out = formatVisualSourcingAudit({
      beats: 34,
      visionAttempts: 34,
      fits: 13,
      doesNotFit: 21,
      research: { attempts: 6, produced: 4, accepted: 2, rejected: 2 },
      tally: tallyWithSources(),
      adoptedByProvider: new Map([["wikimedia", 6], ["youtube", 3]]),
    });
    expect(out).toContain("[VisualSourcingAudit]");
    expect(out).toContain("beats=34");
    expect(out).toContain("fits=13 doesNotFit=21");
    expect(out).toContain("research attempts=6 produced=4 accepted=2 rejected=2");
    expect(out).toContain("MODERN_FOOTAGE");
    expect(out).toContain("TITLE_CARD");
    expect(out).toContain("providers:");
    expect(out).toContain("pexels");
    // A kind that did not occur is not printed as a zero row.
    expect(out).not.toContain("WRONG_EVENT ");
  });

  it("31. an empty render produces a block with no invented rows", () => {
    const out = formatVisualSourcingAudit({
      beats: 0, visionAttempts: 0, fits: 0, doesNotFit: 0,
      research: { attempts: 0, produced: 0, accepted: 0, rejected: 0 },
      tally: createMismatchTally(),
    });
    expect(out).toContain("[VisualSourcingAudit]");
    expect(out).not.toContain("providers:");
    expect(out).not.toContain("mismatchTypes:");
  });
});

describe("RONDE 135 — regressions this round must not touch", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("32. the audit block is actually printed by a render", () => {
    expect(PIPE).toContain("formatVisualSourcingAudit({");
    expect(PIPE).toContain("tally: visualDedup.mismatchTally");
  });

  it("33. the learned signal is actually passed to the reorder", () => {
    expect(PIPE).toContain("repeatOffenderSources(dedup.mismatchTally)");
  });

  it("34. the stillness audit is still wired (RONDE 133)", () => {
    expect(PIPE).toContain("auditVideoStillness({");
    expect(PIPE).toContain("videoPath: finalVideoPath");
  });

  it("35. the closing tail still seeks on the video stream (RONDE 132)", () => {
    const tail = readFileSync(join(__dirname, "closingTail.ts"), "utf8");
    expect(tail).toContain("closingTailFrameSeek");
    expect(tail).not.toContain("params.lastSceneDurationSec - 0.1");
    expect(PIPE).toContain("lastSceneVideoDurationSec: lastSceneVideoDur");
  });

  it("36. the still-image rules are untouched (RONDE 128/130)", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toContain("export const MAX_STILL_IMAGE_DURATION_SEC = 5");
    expect(still).toContain("force_original_aspect_ratio=decrease");
  });

  it("37. the historical source preference already in the funnel is untouched", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    // §9/§13 were already implemented; this round added no third mechanism.
    expect(funnel).toContain("internet_archive: 0.15");
    expect(funnel).toContain("pexels: 0,");
    expect(funnel).toContain("STOCK_TIER_WIN_MARGIN");
  });
});

describe("RONDE 135 — mutation guards", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const FEEDBACK = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");

  it("M8. removing the learned ranking signal breaks the wiring", () => {
    expect(PIPE).toContain("repeatOffenderSources(dedup.mismatchTally)");
    expect(FEEDBACK).toContain("export function repeatOffenderSources");
    // It is merged into `avoid`, not applied as a filter — a signal, never a veto.
    expect(FEEDBACK).toContain("new Set([...preference.avoid, ...learnedOffenders])");
  });

  it("M10. the stillness audit cannot be silently unwired", () => {
    const idx = PIPE.indexOf("auditVideoStillness({");
    expect(idx).toBeGreaterThan(0);
    expect(PIPE.slice(idx, idx + 900)).toContain("checkStillnessLimit(stillness, stillImageMaxSec())");
  });

  it("M11. the five-second cap is a constant, not a threshold this round can move", () => {
    const still = readFileSync(join(__dirname, "stillImagePolicy.ts"), "utf8");
    expect(still).toMatch(/MAX_STILL_IMAGE_DURATION_SEC\s*=\s*5\b/);
    expect(still).toContain("Math.min(n, 15)");
  });

  it("M12. the closing-tail seek cannot fall back to the container duration", () => {
    const tail = readFileSync(join(__dirname, "closingTail.ts"), "utf8");
    expect(tail).toContain("videoStreamDurationSec");
    expect(tail).toContain("-update 1");
  });
});
