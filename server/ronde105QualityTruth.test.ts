/**
 * RONDE 105 — the report tells the truth, including when the truth is bad news.
 *
 * A production render shipped this card:
 *
 *     Visual quality — 100/100 (Excellent)
 *     Archive 7   Wikimedia 1   Stock 1   Clips 15
 *     · 15 clip(s) met niet-bewezen bron (UNVERIFIED)
 *     · VoiceVisual: 13 beat(s) zonder eigen beeld
 *     · beeldgate kon 44 van 88 oordelen niet ophalen
 *
 * Every line of that is a subsystem telling a piece of the truth while the headline said the
 * opposite. Three defects made it possible and this file pins all three closed:
 *
 *   1. `judgementsUsed` counted ATTEMPTS and `judgementsFailed` counted the failures among them,
 *      so the report divided by used+failed and turned "the model answered nothing" into
 *      "44 of 88" — which reads as half.
 *   2. The score was `45 + avg*5.5 + min*0.5` over CLIP scores, the judge RONDE 103 fired.
 *   3. Beats filled with a held frame, a graphic or a generated clip cost nothing, because only
 *      the routes "fallback" and "rescue_placeholder" decremented anything.
 */
import { describe, expect, it } from "vitest";

import {
  createBeatImageGateState,
  judgementTally,
  type BeatImageGateState,
} from "./beatImageRelevanceGate";
import {
  buildBeatVisualStatuses,
  coverageOfAdoptEntry,
  tallyBeatVisualStatuses,
  formatBeatVisualProblems,
} from "./beatVisualStatus";
import { createBeatRelevanceLedger, type BeatRelevanceLedger } from "./beatVisualRelevance";
import { computeMeritQualityScore, buildVideoQualityReport } from "./videoQualityReport";
import { findSilentGates, createGateFiringStats } from "./gateFiringStats";
import { formatFinalVisualReport, formatRenderManifest } from "./visualSourceLineage";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

/* ── helpers ─────────────────────────────────────────────────────────────────────────────── */

function adopt(
  sceneIndex: number,
  beatIndex: number,
  source: string,
  basename = `scene_${sceneIndex}_b${beatIndex}_x.mp4`
): ClipAdoptEntry {
  return { sceneIndex, beatIndex, beatText: `beat ${beatIndex}`, basename, source };
}

/** A ledger holding one decision for one beat, exactly as checkBeatRelevance would record it. */
function ledgerWith(
  entries: Array<{
    scene: number;
    beat: number;
    verdict: "fits" | "does_not_fit" | "unknown";
    reprieved?: boolean;
    cached?: boolean;
    path?: string;
  }>
): BeatRelevanceLedger {
  const l = createBeatRelevanceLedger();
  for (const e of entries) {
    l.byClipPath.set(e.path ?? `clip-s${e.scene}b${e.beat}.mp4`, {
      ctx: { sceneIndex: e.scene, beatIndex: e.beat, beatText: `beat ${e.beat}` },
      decision: {
        verdict: e.verdict,
        allowed: e.verdict !== "does_not_fit" || e.reprieved === true,
        reprieved: e.reprieved === true,
        cached: e.cached === true,
        depicts: "",
        reason: "",
        route: "test",
      },
    });
  }
  return l;
}

const MIX = { real_video: 3, photo: 0, stock: 0, screenshot: 0, motion_graphics: 0 };
function scoreWith(over: Partial<Parameters<typeof computeMeritQualityScore>[0]> = {}) {
  return computeMeritQualityScore({
    totalClips: 3, archiveCount: 3, stockCount: 0, fallbackBeats: 0,
    offTopicCount: 0, geoViolationCount: 0, archiveOnly: true, fastShort: false,
    byMixKind: MIX, ...over,
  });
}

/* ── TEST 1 ──────────────────────────────────────────────────────────────────────────────── */

describe("RONDE 105 TEST 1 — 44 attempts + 44 failures = 0 successful judgements", () => {
  it("the counters partition, so the arithmetic cannot be got wrong", () => {
    const state: BeatImageGateState = createBeatImageGateState();
    state.judgementAttempts = 44;
    state.judgementsFailed = 44;
    state.judgementsFits = 0;
    state.judgementsMismatch = 0;
    state.judgementsSkipped = 17;

    const t = judgementTally(state);
    expect(t.attempts).toBe(44);
    expect(t.answered).toBe(0);
    expect(t.fits).toBe(0);
    expect(t.inconsistent).toBe(false);
    // The number the old report printed. 88 was attempts + failures, which double-counts.
    expect(t.attempts + t.failed).toBe(88);
    expect(t.answered).not.toBe(44);
  });

  it("a real answer moves fits or mismatch, never failed", () => {
    const s = createBeatImageGateState();
    s.judgementAttempts = 3;
    s.judgementsFits = 2;
    s.judgementsMismatch = 1;
    const t = judgementTally(s);
    expect(t.answered).toBe(3);
    expect(t.inconsistent).toBe(false);
  });

  it("counters that do not partition are reported, not hidden", () => {
    const s = createBeatImageGateState();
    s.judgementAttempts = 5;
    s.judgementsFits = 1;
    expect(judgementTally(s).inconsistent).toBe(true);
  });

  it("never_asked is never folded into the attempt count", () => {
    const s = createBeatImageGateState();
    s.judgementsSkipped = 17;
    const t = judgementTally(s);
    expect(t.attempts).toBe(0);
    expect(t.skipped).toBe(17);
  });
});

/* ── TEST 2, 3 ───────────────────────────────────────────────────────────────────────────── */

describe("RONDE 105 TEST 2/3 — no verification, no Excellent; CLIP cannot lift the score", () => {
  it("TEST 2 — 0 verified fits can never reach the Excellent band", () => {
    // shared/videoQuality.ts calls >= 85 "Excellent". That band must be unreachable.
    const audit = [adopt(0, 0, "archive"), adopt(0, 1, "archive"), adopt(0, 2, "archive")];
    const beatVisuals = tallyBeatVisualStatuses(
      buildBeatVisualStatuses(audit, ledgerWith([
        { scene: 0, beat: 0, verdict: "unknown" },
        { scene: 0, beat: 1, verdict: "unknown" },
        { scene: 0, beat: 2, verdict: "unknown" },
      ]))
    );
    const v = scoreWith({ beatVisuals });
    expect(beatVisuals.verifiedOwnVisual).toBe(0);
    expect(v.status).toBe("INSUFFICIENT_VERIFICATION");
    expect(v.score).toBeLessThan(85);
  });

  it("TEST 2b — a render with no ledger at all is INSUFFICIENT_VERIFICATION, not a free pass", () => {
    const report = buildVideoQualityReport(["/tmp/scene_0_b0_curated_a1.mp4"], "A documentary", {
      adoptAudit: [adopt(0, 0, "archive")],
    });
    expect(report.qualityStatus).toBe("INSUFFICIENT_VERIFICATION");
    expect(report.score).toBeLessThan(85);
  });

  it("TEST 3 — a perfect CLIP score changes nothing", () => {
    const beatVisuals = tallyBeatVisualStatuses(
      buildBeatVisualStatuses([adopt(0, 0, "archive")], ledgerWith([
        { scene: 0, beat: 0, verdict: "fits" },
      ]))
    );
    const withClip = scoreWith({
      beatVisuals,
      adoptAudit: [{ ...adopt(0, 0, "archive"), visionScore10: 10 }],
    });
    const withoutClip = scoreWith({ beatVisuals, adoptAudit: [adopt(0, 0, "archive")] });
    expect(withClip.score).toBe(withoutClip.score);
  });

  it("TEST 3b — the score source file no longer reads visionScore10 at all", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("visionScore10");
    expect(code).not.toContain("45 + avg");
  });

  it("a fully verified render CAN still be excellent — the gate is on evidence, not pessimism", () => {
    const audit = [adopt(0, 0, "archive"), adopt(0, 1, "archive"), adopt(0, 2, "archive")];
    const beatVisuals = tallyBeatVisualStatuses(
      buildBeatVisualStatuses(audit, ledgerWith([
        { scene: 0, beat: 0, verdict: "fits" },
        { scene: 0, beat: 1, verdict: "fits" },
        { scene: 0, beat: 2, verdict: "fits" },
      ]))
    );
    const v = scoreWith({ beatVisuals });
    expect(v.status).toBe("VERIFIED");
    expect(v.score).toBeGreaterThanOrEqual(85);
  });
});

/* ── TEST 4, 5, 6 ────────────────────────────────────────────────────────────────────────── */

describe("RONDE 105 TEST 4/5/6 — a stand-in is not a picture", () => {
  it("TEST 5 — a held frame is not a verified visual", () => {
    const st = buildBeatVisualStatuses(
      [adopt(0, 0, "rescue_extend")],
      ledgerWith([{ scene: 0, beat: 0, verdict: "fits" }])
    );
    expect(st[0]!.coverage).toBe("held_frame");
    // Even with a `fits` verdict: the model approved a repeat of the previous shot.
    expect(st[0]!.verifiedOwnVisual).toBe(false);
    expect(st[0]!.reason).toBe("held_frame");
  });

  it("TEST 6 — a graphic or text overlay is not a verified visual", () => {
    for (const source of ["rescue_graphic", "graphic", "motion_graphic", "text_overlay"]) {
      const st = buildBeatVisualStatuses(
        [adopt(0, 0, source)],
        ledgerWith([{ scene: 0, beat: 0, verdict: "fits" }])
      );
      expect(st[0]!.coverage, source).toBe("graphic");
      expect(st[0]!.verifiedOwnVisual, source).toBe(false);
    }
  });

  it("a guaranteed-ladder card is a placeholder even when its route says otherwise", () => {
    expect(
      coverageOfAdoptEntry({ source: "archive", basename: "scene_0_slot3_guaranteed.mp4" })
    ).toBe("placeholder");
  });

  it("generated footage is not filmed footage", () => {
    expect(coverageOfAdoptEntry({ source: "rescue_ai", basename: "x.mp4" })).toBe("generated");
    expect(coverageOfAdoptEntry({ source: "kling", basename: "x.mp4" })).toBe("generated");
  });

  it("TEST 4 — every beat without its own approved picture costs points and is named", () => {
    const audit = [
      adopt(0, 0, "archive"),
      adopt(0, 1, "rescue_extend"),
      adopt(0, 2, "rescue_graphic"),
      adopt(0, 3, "rescue_ai"),
    ];
    const ledger = ledgerWith([
      { scene: 0, beat: 0, verdict: "fits" },
      { scene: 0, beat: 1, verdict: "fits" },
      { scene: 0, beat: 2, verdict: "fits" },
      { scene: 0, beat: 3, verdict: "fits" },
    ]);
    const statuses = buildBeatVisualStatuses(audit, ledger);
    const beatVisuals = tallyBeatVisualStatuses(statuses);
    expect(beatVisuals.verifiedOwnVisual).toBe(1);
    expect(beatVisuals.beats).toBe(4);

    // The old score decremented for none of these three.
    const withStandIns = scoreWith({ beatVisuals });
    const allReal = scoreWith({
      beatVisuals: tallyBeatVisualStatuses(
        buildBeatVisualStatuses(
          [adopt(0, 0, "archive"), adopt(0, 1, "archive"), adopt(0, 2, "archive"), adopt(0, 3, "archive")],
          ledger
        )
      ),
    });
    expect(withStandIns.score).toBeLessThan(allReal.score);

    // ...and each one is named in the log rather than summed into a number.
    const lines = formatBeatVisualProblems(statuses);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("visual_status=no_verified_visual");
    expect(lines.join("\n")).toContain("coverage=held_frame");
  });

  it("the quality report warns about them, with a breakdown by reason", () => {
    const report = buildVideoQualityReport(["/tmp/a.mp4", "/tmp/b.mp4"], "A documentary", {
      adoptAudit: [adopt(0, 0, "archive"), adopt(0, 1, "rescue_extend")],
      relevanceLedger: ledgerWith([{ scene: 0, beat: 0, verdict: "fits" }]),
    });
    const warning = report.warnings.find((w) => w.includes("zonder goedgekeurd eigen"));
    expect(warning).toBeDefined();
    expect(warning).toContain("held_frame=1");
    expect(report.beatVisualProblems).toHaveLength(1);
  });
});

/* ── TEST 7, 8, 9 ────────────────────────────────────────────────────────────────────────── */

describe("RONDE 105 TEST 7/8/9 — reprieved, unknown and never_asked stay themselves", () => {
  it("TEST 7 — a reprieved does_not_fit is reported as reprieved_after_refusal, never as fits", () => {
    const st = buildBeatVisualStatuses(
      [adopt(0, 0, "archive")],
      ledgerWith([{ scene: 0, beat: 0, verdict: "does_not_fit", reprieved: true }])
    );
    expect(st[0]!.verification).toBe("reprieved_after_refusal");
    expect(st[0]!.verifiedOwnVisual).toBe(false);
    const t = tallyBeatVisualStatuses(st);
    expect(t.byVerification.verified_fit).toBe(0);
    expect(t.byVerification.reprieved_after_refusal).toBe(1);
  });

  it("a reprieve costs points — it is a known risk, not a pass", () => {
    const good = scoreWith({
      beatVisuals: tallyBeatVisualStatuses(
        buildBeatVisualStatuses(
          [adopt(0, 0, "archive"), adopt(0, 1, "archive")],
          ledgerWith([
            { scene: 0, beat: 0, verdict: "fits" },
            { scene: 0, beat: 1, verdict: "fits" },
          ])
        )
      ),
    });
    const reprieved = scoreWith({
      beatVisuals: tallyBeatVisualStatuses(
        buildBeatVisualStatuses(
          [adopt(0, 0, "archive"), adopt(0, 1, "archive")],
          ledgerWith([
            { scene: 0, beat: 0, verdict: "fits" },
            { scene: 0, beat: 1, verdict: "does_not_fit", reprieved: true },
          ])
        )
      ),
    });
    expect(reprieved.score).toBeLessThan(good.score);
  });

  it("TEST 8 — unknown stays unknown and never becomes a fit", () => {
    const st = buildBeatVisualStatuses(
      [adopt(0, 0, "archive")],
      ledgerWith([{ scene: 0, beat: 0, verdict: "unknown" }])
    );
    expect(st[0]!.verification).toBe("unknown");
    expect(st[0]!.verifiedOwnVisual).toBe(false);
  });

  it("TEST 9 — a beat the ledger never saw is never_asked, which is not unknown", () => {
    const st = buildBeatVisualStatuses([adopt(0, 0, "archive")], createBeatRelevanceLedger());
    expect(st[0]!.verification).toBe("never_asked");
    const t = tallyBeatVisualStatuses(st);
    expect(t.byVerification.never_asked).toBe(1);
    expect(t.byVerification.unknown).toBe(0);
  });

  it("the two are separate counters in the final report, not one bucket", () => {
    const lines = formatFinalVisualReport({
      finalVideoVerified: true, records: [], beats: 2, verifiedOwnVisual: 0,
      verification: { unknown: 1, never_asked: 1 }, coverage: {},
      attempts: 1, answered: 0, unavailable: 1, neverAsked: 1,
      qualityStatus: "INSUFFICIENT_VERIFICATION", score: 40,
    }).join("\n");
    expect(lines).toContain("unknown=1");
    expect(lines).toContain("never_asked=1");
    expect(lines).toContain("gate_unavailable=1");
    expect(lines).toContain("gate_never_asked=1");
    expect(lines).toContain("gate_answered=0");
  });
});

/* ── TEST 10, 11, 12, 13, 14 ─────────────────────────────────────────────────────────────── */

const REC = (over: Record<string, unknown> = {}) =>
  ({
    lineageId: "L1", sceneIndex: 0, beatIndex: 0, currentFilename: "a.mp4",
    finalVideoAt: 1, provider: "internet_archive", providerAssetId: "ia-1",
    query: "Hitler Berlin 1945", ...over,
  }) as never;

describe("RONDE 105 TEST 10–14 — the final montage is the source of truth", () => {
  it("TEST 13 — the manifest lists only what the delivered file contains", () => {
    const lines = formatRenderManifest(
      [REC(), REC({ lineageId: "L2", finalVideoAt: null, beatIndex: 1 })],
      true
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("assetId=L1");
    expect(lines[0]).toContain("rendered=true");
  });

  it("TEST 10 — every final clip carries a provider, or says unverified", () => {
    const lines = formatRenderManifest([REC(), REC({ lineageId: "L2", provider: null })], true);
    expect(lines[0]).toContain("provider=internet_archive");
    expect(lines[1]).toContain("provider=UNVERIFIED");
    for (const l of lines) expect(l).toMatch(/provider=\S+/);
  });

  it("TEST 12 — a clip with no verdict is reported as never_asked, not as fine", () => {
    const noVerdict = formatRenderManifest([REC()], true);
    expect(noVerdict[0]).toContain("verdict=never_asked");
    expect(noVerdict[0]).toContain("reprieved=false");

    const withVerdict = formatRenderManifest([REC()], true, () => ({
      verdict: "fits", cached: true, reprieved: false,
    }));
    expect(withVerdict[0]).toContain("verdict=fits");
    expect(withVerdict[0]).toContain("cached=true");
  });

  it("a reprieved clip says so in the manifest, and does not say fits", () => {
    const lines = formatRenderManifest([REC()], true, () => ({
      verdict: "does_not_fit", cached: false, reprieved: true,
    }));
    expect(lines[0]).toContain("verdict=reprieved_after_refusal");
    expect(lines[0]).toContain("reprieved=true");
    expect(lines[0]).not.toContain("verdict=fits");
  });

  it("TEST 11 — the manifest follows the ledger record, so a rename keeps its source", () => {
    // The record carries the CURRENT filename and the ORIGINAL provider, which is what makes a
    // trimmed, overlaid, renamed clip still attributable.
    const lines = formatRenderManifest(
      [REC({ currentFilename: "scene_0_b0_trimmed_text.mp4" })],
      true
    );
    expect(lines[0]).toContain("file=scene_0_b0_trimmed_text.mp4");
    expect(lines[0]).toContain("provider=internet_archive");
    expect(lines[0]).toContain("providerAssetId=ia-1");
    expect(lines[0]).toContain('query="Hitler Berlin 1945"');
  });

  it("TEST 14 — the source counts add up to the final clip count, or the render says so", () => {
    const ok = formatFinalVisualReport({
      finalVideoVerified: true,
      records: [REC(), REC({ lineageId: "L2", provider: "wikimedia" })],
      beats: 2, verifiedOwnVisual: 2,
      verification: { verified_fit: 2 }, coverage: { own_footage: 2 },
      attempts: 2, answered: 2, unavailable: 0, neverAsked: 0,
      qualityStatus: "VERIFIED", score: 95,
    }).join("\n");
    expect(ok).toContain("final_clips=2");
    expect(ok).toContain("source_internet_archive=1");
    expect(ok).toContain("source_wikimedia=1");
    expect(ok).not.toContain("SOURCE_COUNT_MISMATCH");
  });

  it("a clip with no proven provider lands in unverified, never silently missing", () => {
    const lines = formatFinalVisualReport({
      finalVideoVerified: true,
      records: [REC(), REC({ lineageId: "L2", provider: null })],
      beats: 2, verifiedOwnVisual: 1,
      verification: {}, coverage: {},
      attempts: 0, answered: 0, unavailable: 0, neverAsked: 2,
      qualityStatus: "INSUFFICIENT_VERIFICATION", score: 40,
    }).join("\n");
    expect(lines).toContain("final_clips=2");
    expect(lines).toContain("unverified_final_clips=1");
    expect(lines).not.toContain("SOURCE_COUNT_MISMATCH");
  });

  it("the report answers every question §16 asks, in one block", () => {
    const lines = formatFinalVisualReport({
      finalVideoVerified: true, records: [REC()], beats: 15, verifiedOwnVisual: 2,
      verification: { verified_fit: 2, verified_mismatch: 1, unknown: 3, never_asked: 7, reprieved_after_refusal: 2 },
      coverage: { own_footage: 2, held_frame: 13 },
      attempts: 44, answered: 0, unavailable: 44, neverAsked: 17,
      qualityStatus: "INSUFFICIENT_VERIFICATION", score: 40,
    }).join("\n");
    for (const key of [
      "beats=15", "verified_own_visual=2", "verified_fit=2", "verified_mismatch=1",
      "reprieved=2", "unknown=3", "never_asked=7", "coverage_held_frame=13",
      "gate_attempts=44", "gate_answered=0", "final_clips=1",
      "quality_status=INSUFFICIENT_VERIFICATION",
    ]) {
      expect(lines, key).toContain(key);
    }
  });
});

/* ── §11 silent gates ────────────────────────────────────────────────────────────────────── */

describe("RONDE 105 §11 — a gate demoted on purpose is not a broken gate", () => {
  it("vision_gate and off_topic_protest no longer raise a silent-gate alarm", () => {
    const stats = createGateFiringStats();
    stats.set("vision_gate", { asked: 41, fired: 0 });
    stats.set("off_topic_protest", { asked: 41, fired: 0 });
    expect(findSilentGates(stats)).toEqual([]);
  });

  it("baked_text still does — it reads the pixels and may still refuse", () => {
    const stats = createGateFiringStats();
    stats.set("baked_text", { asked: 41, fired: 0 });
    expect(findSilentGates(stats).map((g) => g.gate)).toEqual(["baked_text"]);
  });

  it("a gate that fires is never reported, demoted or not", () => {
    const stats = createGateFiringStats();
    stats.set("modern_mismatch", { asked: 85, fired: 2 });
    expect(findSilentGates(stats)).toEqual([]);
  });
});
