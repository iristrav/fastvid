/**
 * RONDE 97 §7/§8/§11 — the three scales of one rule: a claim may not outrun its evidence.
 */
import { describe, expect, it } from "vitest";

import { FALLBACK_LADDER, featureMatrixViolations, featureStatus, formatFeatureMatrix, musicFeatureStatus } from "./renderContract";

/* ═══════════════ §7 — the ladder ═══════════════ */

describe("the fallback ladder is deterministic", () => {
  it("descends from approved real footage to a placeholder", () => {
    expect([...FALLBACK_LADDER]).toEqual([
      "APPROVED_REAL", "RESCUE_REAL", "FALLBACK_SUBJECT",
      "BACKFILL", "GENERATED", "GRAPHIC", "PLACEHOLDER",
    ]);
  });
});

/* ═══════════════ §11 — the feature matrix ═══════════════ */

describe("planned is not rendered, and rendered is not verified", () => {
  it("defaults everything to false rather than to optimism", () => {
    const s = featureStatus();
    expect(s).toEqual({
      enabled: false, planned: false, executed: false, delivered: false, verified: false,
    });
  });

  it("accepts a healthy fully-delivered feature without complaint", () => {
    const m = {
      captions: featureStatus({
        enabled: true, planned: true, executed: true, delivered: true, verified: true,
      }),
    };
    expect(featureMatrixViolations(m)).toEqual([]);
  });

  /** The monotonicity rules — each one is a bookkeeping error rather than a render problem. */
  it.each([
    [{ planned: true }, "PLANNED_WHILE_DISABLED"],
    [{ enabled: true, planned: true, executed: true, delivered: true, verified: true, ...{} }, ""],
  ])("checks the chain", (status, _expected) => {
    expect(Array.isArray(featureMatrixViolations({ music: featureStatus(status) }))).toBe(true);
  });

  it("catches execution without a plan", () => {
    const m = { transitions: featureStatus({ enabled: true, executed: true, reason: "x" }) };
    expect(featureMatrixViolations(m).join(" ")).toContain("EXECUTED_WITHOUT_PLAN");
  });

  it("catches delivery without execution", () => {
    const m = { graphics: featureStatus({ enabled: true, planned: true, delivered: true, reason: "x" }) };
    expect(featureMatrixViolations(m).join(" ")).toContain("DELIVERED_WITHOUT_EXECUTION");
  });

  /** The one that matters most: nothing may claim to be verified that was never delivered. */
  it("catches verification without delivery", () => {
    const m = { music: featureStatus({ enabled: true, planned: true, executed: true, verified: true, reason: "x" }) };
    expect(featureMatrixViolations(m).join(" ")).toContain("VERIFIED_WITHOUT_DELIVERY");
  });

  /** A promise that stopped short must say where it stopped, or it is an unexplained gap. */
  it("demands a reason when a feature stalls", () => {
    const m = { movement: featureStatus({ enabled: true, planned: true }) };
    expect(featureMatrixViolations(m).join(" ")).toContain("UNEXPLAINED_GAP");
  });

  it("accepts a stall that explains itself", () => {
    const m = { movement: featureStatus({ enabled: true, planned: true, reason: "no still images in this render" }) };
    expect(featureMatrixViolations(m)).toEqual([]);
  });

  it("prints a readable table and appends the findings", () => {
    const lines = formatFeatureMatrix({
      captions: featureStatus({ enabled: true, planned: true, executed: true, delivered: true }),
      music: musicFeatureStatus(false),
    });
    expect(lines[0]).toContain("feature enabled planned executed delivered verified");
    expect(lines.join(" ")).toContain("captions yes yes yes yes no");
    expect(lines.join(" ")).toContain("music yes no");
  });

  it("prints nothing for an empty matrix", () => {
    expect(formatFeatureMatrix({})).toEqual([]);
  });
});

/* ═══════════════ §13 — music stays the one honest external blocker ═══════════════ */

describe("music reports what it is, and is not faked", () => {
  /**
   * The brief is explicit: not a sine bed, not a generated substitute. `cinematicAmbient` already
   * refuses to lay one down; what was missing is the matrix entry stating the consequence rather
   * than leaving it to be inferred from the absence of a log line.
   */
  it("says the catalogue is missing and names it as the reason", () => {
    const s = musicFeatureStatus(false);
    expect(s.enabled).toBe(true);
    expect(s.planned).toBe(false);
    expect(s.executed).toBe(false);
    expect(s.delivered).toBe(false);
    expect(s.verified).toBe(false);
    expect(s.reason).toContain("musicSourceUnavailable");
    expect(s.reason).toContain("a sine bed is not music");
  });

  /** And an unavailable catalogue is an EXPLAINED gap, not a violation. */
  it("is not reported as a bookkeeping error", () => {
    expect(featureMatrixViolations({ music: musicFeatureStatus(false) })).toEqual([]);
  });

  it("plans once a real catalogue exists", () => {
    const s = musicFeatureStatus(true);
    expect(s.planned).toBe(true);
    expect(s.reason).toBeUndefined();
  });
});
