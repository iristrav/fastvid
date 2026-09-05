/**
 * RONDE 89 P0 — A SCORE MAY NOT OVERRULE "WE CANNOT SAY WHAT THIS IS SHOWING".
 *
 * ── The line this file exists for ───────────────────────────────────────────────────────────
 *
 *     [Quality] Video 568: visual quality raw=24/100, availabilityAdjusted=82/100
 *               (export minimum 45) … The adjusted number is an availability decision, NOT a
 *               measurement of picture quality; raw is the measurement.
 *     [Quality] Video 568: export gate passed (score=82/100)
 *
 * The pipeline measured the picture at 24, a policy raised it to 82, and the gate decided on 82.
 * The log stated in the same breath that the number it was deciding on was not a measurement.
 *
 * What that render actually delivered, from its own log:
 *
 *     15 of 17 beats   visual_status=no_verified_visual verification=never_asked
 *     17 of 20 clips   provider=UNVERIFIED
 *     240              beeldgate-momenten niet bevraagd — "die clips zijn ONGEZIEN aangenomen"
 *
 * ── Why two conditions and not a higher threshold ───────────────────────────────────────────
 *
 * A threshold trades one arbitrary number for another and leaves the availability policy as the
 * thing being compared. These two are not about degree — they are the cases where the film as a
 * whole cannot answer "why is this picture on screen?". The tests below are written in both
 * directions: what must block, and just as carefully, what must still ship.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  indefensibleExportConditions,
  type VideoQualityReport,
} from "./videoQualityReport";
import { enforceQualityExportGate } from "./pipelineSelfHeal";

/** A report with nothing wrong with it; each test breaks exactly one thing. */
function healthyReport(over: Partial<VideoQualityReport> = {}): VideoQualityReport {
  return {
    generatedAt: new Date().toISOString(),
    videoTitle: "Why Adolf Hitler Chose to End His Life",
    visualTopic: "ww2",
    totalClips: 20,
    bySource: { ww2: 12, wikimedia: 5, internet_archive: 3 },
    diagnosticBySource: {},
    byMixKind: {} as VideoQualityReport["byMixKind"],
    wikimediaCount: 5,
    archiveCount: 12,
    stockCount: 0,
    warnings: [],
    offTopicSuspects: [],
    score: 82,
    qualityStatus: "ok" as VideoQualityReport["qualityStatus"],
    qualityReason: "",
    beatVisuals: {
      beats: 17,
      verifiedOwnVisual: 9,
      ownFootage: 12,
      byCoverage: {
        own_footage: 12, subject_only: 3, held_frame: 0, graphic: 0,
        placeholder: 2, generated: 0, none: 0,
      },
      byVerification: {
        verified_fit: 9, verified_mismatch: 2, reprieved_after_refusal: 0,
        unknown: 4, never_asked: 2,
      },
    },
    ...over,
  } as VideoQualityReport;
}

/** Render 568, as its own log described it. */
function render568(): VideoQualityReport {
  return healthyReport({
    totalClips: 20,
    bySource: { UNVERIFIED: 17, wikimedia: 1, ww2: 1, serpapi: 1 },
    score: 82,
    rawVisualQualityScore: 24,
    availabilityAdjustedScore: 82,
    beatVisuals: {
      beats: 17,
      verifiedOwnVisual: 0,
      ownFootage: 9,
      byCoverage: {
        own_footage: 9, subject_only: 6, held_frame: 0, graphic: 0,
        placeholder: 2, generated: 0, none: 0,
      },
      byVerification: {
        verified_fit: 0, verified_mismatch: 0, reprieved_after_refusal: 0,
        unknown: 2, never_asked: 15,
      },
    },
  });
}

/* ═══════════════ the conditions ═══════════════ */

describe("render 568 would not have been delivered", () => {
  it("fires both conditions on the render that shipped", () => {
    const codes = indefensibleExportConditions(render568()).map((c) => c.code);
    expect(codes).toContain("NO_VERIFIED_OWN_VISUAL");
    expect(codes).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  /** The numbers have to be in the message, or nobody can act on the refusal. */
  it("says how bad it was, in the render's own figures", () => {
    const [beats, clips] = indefensibleExportConditions(render568());
    expect(beats!.detail).toContain("0 of 17");
    expect(beats!.detail).toContain("never_asked=15");
    expect(clips!.detail).toContain("17 of 20");
    expect(clips!.detail).toContain("85%");
  });

  it("is silent on a render that verified its pictures", () => {
    expect(indefensibleExportConditions(healthyReport())).toEqual([]);
  });
});

describe("NO_VERIFIED_OWN_VISUAL", () => {
  const codes = (r: VideoQualityReport) => indefensibleExportConditions(r).map((c) => c.code);

  it("fires when not one beat got an approved picture of its own", () => {
    const r = healthyReport();
    r.beatVisuals!.verifiedOwnVisual = 0;
    expect(codes(r)).toContain("NO_VERIFIED_OWN_VISUAL");
  });

  /** ONE verified beat is a poor film, not an unaccountable one. That is the score's job. */
  it("does not fire on a single verified beat", () => {
    const r = healthyReport();
    r.beatVisuals!.verifiedOwnVisual = 1;
    expect(codes(r)).not.toContain("NO_VERIFIED_OWN_VISUAL");
  });

  /** No beats measured is not evidence of a bad render — a tool, a test, a caller with no ledger. */
  it("does not fire when nothing was measured", () => {
    expect(codes(healthyReport({ beatVisuals: undefined }))).not.toContain("NO_VERIFIED_OWN_VISUAL");
    const empty = healthyReport();
    empty.beatVisuals!.beats = 0;
    empty.beatVisuals!.verifiedOwnVisual = 0;
    expect(codes(empty)).not.toContain("NO_VERIFIED_OWN_VISUAL");
  });
});

describe("MOSTLY_UNVERIFIED_CLIPS", () => {
  const codes = (r: VideoQualityReport) => indefensibleExportConditions(r).map((c) => c.code);
  const withUnverified = (unverified: number, total: number) =>
    healthyReport({ totalClips: total, bySource: { UNVERIFIED: unverified, ww2: total - unverified } });

  it("fires above half", () => {
    expect(codes(withUnverified(11, 20))).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  /** Exactly half is not "most" — the limit is a strict majority, and the boundary is tested. */
  it("does not fire at exactly half", () => {
    expect(codes(withUnverified(10, 20))).not.toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  it("does not fire on a render whose sources are proven", () => {
    expect(codes(withUnverified(0, 20))).not.toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  it("does not fire when there are no clips to judge", () => {
    expect(codes(healthyReport({ totalClips: 0, bySource: {} }))).not.toContain("MOSTLY_UNVERIFIED_CLIPS");
  });
});

/* ═══════════════ and the gate acts on them, whatever the flags say ═══════════════ */

describe("the export gate refuses, with every switch off", () => {
  const ENV = [
    "ENABLE_STRICT_QUALITY_EXPORT",
    "ENABLE_QUALITY_EXPORT_HARD_TIER",
    "BLOCK_EXPORT_ON_VISUAL_MISMATCH",
  ] as const;
  const saved = new Map(ENV.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  const allFlagsOff = () => {
    for (const k of ENV) process.env[k] = "false";
  };

  /**
   * THE WHOLE POINT. Render 568 shipped with all three of these off, and every other blocking
   * check in the gate hangs off one of them. If this test starts passing because a flag was
   * turned on, the fix has been undone.
   */
  it("blocks render 568 with strict, hard-tier and visual-mismatch all off", () => {
    allFlagsOff();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => enforceQualityExportGate(568, render568(), "8-10", { ok: true } as never))
      .toThrow(/EXPORT BLOCKED|Export blocked/);
  });

  it("names both conditions in the thrown error, not just the first", () => {
    allFlagsOff();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let message = "";
    try {
      enforceQualityExportGate(568, render568(), "8-10", { ok: true } as never);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("NO_VERIFIED_OWN_VISUAL");
    expect(message).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  /** The reason has to reach the log too, so a render can be diagnosed from the worker output. */
  it("logs each condition before throwing", () => {
    allFlagsOff();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      enforceQualityExportGate(568, render568(), "8-10", { ok: true } as never);
    } catch { /* expected */ }
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("EXPORT BLOCKED NO_VERIFIED_OWN_VISUAL");
    expect(logged).toContain("EXPORT BLOCKED MOSTLY_UNVERIFIED_CLIPS");
  });

  /**
   * A GOOD RENDER STILL SHIPS. Without this the change could be "block everything", which would
   * pass every test above and destroy the product.
   */
  it("still lets a render with verified pictures through", () => {
    allFlagsOff();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => enforceQualityExportGate(569, healthyReport(), "8-10", { ok: true } as never))
      .not.toThrow();
  });

  /** And a merely WEAK render still ships — this gate is not a quality threshold. */
  it("does not block a low score on its own", () => {
    allFlagsOff();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const weak = healthyReport({ score: 30, rawVisualQualityScore: 30 });
    expect(indefensibleExportConditions(weak)).toEqual([]);
    expect(() => enforceQualityExportGate(570, weak, "8-10", { ok: true } as never)).not.toThrow();
  });
});

/* ═══════════════ the check cannot be flagged away ═══════════════ */

describe("the check runs before any flag is read", () => {
  const SRC = () =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("fs").readFileSync(require("path").join(__dirname, "pipelineSelfHeal.ts"), "utf8") as string;

  it("is the first thing enforceQualityExportGate does", () => {
    const src = SRC();
    const at = src.indexOf("export function enforceQualityExportGate(");
    const body = src.slice(at, src.indexOf("\n}", at));
    const check = body.indexOf("indefensibleExportConditions(report)");
    expect(check).toBeGreaterThan(-1);
    for (const flag of [
      "strictQualityExportEnabled()",
      "qualityExportHardTierEnabled()",
      "blockExportOnVisualMismatch()",
    ]) {
      const flagAt = body.indexOf(flag);
      expect(flagAt, `${flag} is read before the unconditional check`).toBeGreaterThan(check);
    }
  });

  /** It must throw, not warn — a console line is what render 568 already had. */
  it("throws rather than warning", () => {
    const src = SRC();
    const at = src.indexOf("const indefensible = indefensibleExportConditions(report);");
    const block = src.slice(at, at + 700);
    expect(block).toContain("throw pipelineError(");
    expect(block).toContain("PIPELINE_ERROR.QUALITY_GATE");
  });
});
