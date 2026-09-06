/**
 * FIVE GATES, ONE RENDER — INSTEAD OF ONE GATE PER RENDER.
 *
 * ── What this is for ────────────────────────────────────────────────────────────────────────
 *
 * Three consecutive production renders were refused by three different gates:
 *
 *     14/14 filled beat(s) got ONLY the color/text fallback     (coverage)
 *     NO_VERIFIED_OWN_VISUAL: 0 of 16 beat(s) approved          (indefensible)
 *     MOSTLY_UNVERIFIED_CLIPS: 12 of 14 clip(s)                 (indefensible)
 *
 * Each was a real finding and each cleared the one before it. But every gate throws at its own
 * point in the sequence, so a render reports the first and stops — and a render is an hour. The
 * other answers were never hidden; they were never asked for.
 *
 * ── The rule these tests protect ────────────────────────────────────────────────────────────
 *
 * A readiness report that can disagree with the gate it describes is worse than none. So every
 * entry must come from the same predicate the real gate uses, and this file's job is to hold the
 * two together — including the gate whose threshold an operator is least likely to expect.
 */
import { describe, expect, it } from "vitest";

import {
  assertVisualCoverageExportGate,
  buildVideoQualityReport,
  exportGateReadiness,
  formatExportGateReadiness,
  indefensibleExportConditions,
  type VideoQualityReport,
} from "./videoQualityReport";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

const POLICY = { hardTier: false, blockVisualMismatch: true, strictQuality: true, minScore: 45 };

const adopt = (sceneIndex: number, beatIndex: number, source: string): ClipAdoptEntry => ({
  sceneIndex,
  beatIndex,
  beatText: "b",
  basename: `${source}_${sceneIndex}${beatIndex}.mp4`,
  source,
});

const reportFor = (opts: {
  adoptAudit: ClipAdoptEntry[];
  clips?: string[];
  provider?: (c: string) => string | null;
  drawn?: (c: string) => boolean;
}) =>
  buildVideoQualityReport(opts.clips ?? [], "A documentary", {
    adoptAudit: opts.adoptAudit,
    resolveSource: opts.provider ? (c) => opts.provider!(c) : undefined,
    isGeneratedClip: opts.drawn,
  });

const gate = (r: VideoQualityReport, name: string, scenes = 0, policy = POLICY) =>
  exportGateReadiness(r, scenes, policy).find((g) => g.gate === name)!;

describe("every gate is reported, blocking or not", () => {
  const clean = reportFor({ adoptAudit: [adopt(0, 0, "archive"), adopt(0, 1, "wikimedia")] });

  it("names all five", () => {
    expect(exportGateReadiness(clean, 0, POLICY).map((g) => g.gate)).toEqual([
      "visual_coverage",
      "no_verified_own_visual",
      "mostly_unverified_clips",
      "voice_visual_match",
      "quality_score",
    ]);
  });

  it("a gate that would not block is still listed", () => {
    expect(gate(clean, "visual_coverage").blocking).toBe(false);
    expect(gate(clean, "visual_coverage").detail).toContain("0/2 beat(s) got ONLY a card");
  });

  it("the summary line counts the blocking ones", () => {
    const lines = formatExportGateReadiness(569, exportGateReadiness(clean, 0, POLICY));
    expect(lines[0]).toMatch(/video=569 \d of 5 gate\(s\) would block/);
    expect(lines).toHaveLength(6);
  });
});

describe("the report agrees with the gate it describes", () => {
  /** A film of cards: the coverage gate throws, and readiness must say so before it does. */
  const cards = reportFor({
    adoptAudit: [adopt(0, 0, "fallback"), adopt(0, 1, "fallback"), adopt(0, 2, "archive")],
  });

  it("visual_coverage matches assertVisualCoverageExportGate", () => {
    const readiness = gate(cards, "visual_coverage").blocking;
    let threw = false;
    try {
      assertVisualCoverageExportGate(cards, 0);
    } catch {
      threw = true;
    }
    expect(readiness).toBe(threw);
  });

  it("a whole scene on a placeholder blocks in both", () => {
    expect(gate(cards, "visual_coverage", 1).blocking).toBe(true);
    expect(() => assertVisualCoverageExportGate(cards, 1)).toThrow();
  });

  it.each(["no_verified_own_visual", "mostly_unverified_clips"])(
    "%s matches indefensibleExportConditions",
    (name) => {
      const r = reportFor({
        adoptAudit: [adopt(0, 0, "archive")],
        clips: ["/w/a.mp4", "/w/b.mp4"],
        provider: () => null,
        drawn: () => false,
      });
      const codes = indefensibleExportConditions(r).map((c) => c.code.toLowerCase());
      expect(gate(r, name).blocking).toBe(codes.includes(name));
    }
  );
});

describe("the gate an operator is least likely to expect", () => {
  /**
   * `voice_visual_match` blocks on ANY card-only beat, not a majority, whenever
   * BLOCK_EXPORT_ON_VISUAL_MISMATCH is on. One beat out of twenty is enough — which is a policy
   * choice, and one worth seeing before spending an hour on a render.
   */
  const oneCard = reportFor({
    adoptAudit: [...Array.from({ length: 19 }, (_, i) => adopt(0, i, "archive")), adopt(0, 19, "fallback")],
  });

  it("one card-only beat in twenty blocks it", () => {
    expect(gate(oneCard, "voice_visual_match").blocking).toBe(true);
    expect(gate(oneCard, "voice_visual_match").detail).toContain("ANY card-only beat blocks");
  });

  it("while the coverage gate, which needs a majority, does not", () => {
    expect(gate(oneCard, "visual_coverage").blocking).toBe(false);
  });

  it("and it is reported as unenforced when the flag is off", () => {
    const off = { ...POLICY, blockVisualMismatch: false };
    expect(gate(oneCard, "voice_visual_match", 0, off).blocking).toBe(false);
    expect(gate(oneCard, "voice_visual_match", 0, off).detail).toContain("not enforced");
  });
});

describe("the score floor reports which tier it is on", () => {
  const low = reportFor({ adoptAudit: [adopt(0, 0, "fallback")] });

  it("blocks on the hard tier", () => {
    const g = gate(low, "quality_score", 0, { ...POLICY, hardTier: true });
    expect(g.blocking).toBe(low.score < 45);
    expect(g.detail).toContain("hard tier: blocks");
  });

  it("is healed rather than blocking on the soft tier", () => {
    const g = gate(low, "quality_score");
    expect(g.blocking).toBe(false);
    expect(g.detail).toContain("does not block");
  });
});

describe("reporting decides nothing", () => {
  /** The whole point: this function must never be able to change an outcome. */
  it("is pure — the report is unchanged by asking", () => {
    const r = reportFor({ adoptAudit: [adopt(0, 0, "fallback")] });
    const before = JSON.stringify(r);
    exportGateReadiness(r, 0, POLICY);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("never throws, whatever it is handed", () => {
    const empty = buildVideoQualityReport([], "t", {});
    expect(() => exportGateReadiness(empty, 0, POLICY)).not.toThrow();
    expect(() => formatExportGateReadiness("-", exportGateReadiness(empty, 0, POLICY))).not.toThrow();
  });
});
