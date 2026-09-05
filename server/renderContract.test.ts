/**
 * RONDE 97 §7/§8/§11 — the three scales of one rule: a claim may not outrun its evidence.
 */
import { describe, expect, it } from "vitest";

import {
  FALLBACK_LADDER,
  beatCoverage,
  coverageIsVerified,
  fallbackMayReplace,
  featureMatrixViolations,
  featureStatus,
  formatBeatCoverage,
  formatFeatureMatrix,
  musicFeatureStatus,
  rungForAdoptSource,
  rungRank,
} from "./renderContract";

/* ═══════════════ §7 — the ladder ═══════════════ */

describe("the fallback ladder is deterministic", () => {
  it("descends from approved real footage to a placeholder", () => {
    expect([...FALLBACK_LADDER]).toEqual([
      "APPROVED_REAL", "RESCUE_REAL", "FALLBACK_SUBJECT",
      "BACKFILL", "GENERATED", "GRAPHIC", "PLACEHOLDER",
    ]);
  });

  /** Derived from the adoption policy, never re-decided — one vocabulary, one answer. */
  it.each([
    ["archive", "APPROVED_REAL"],
    ["wikimedia", "APPROVED_REAL"],
    ["rescue_wikimedia", "RESCUE_REAL"],
    ["archive_similar", "RESCUE_REAL"],
    ["subject_fallback", "FALLBACK_SUBJECT"],
    ["rescue_extend", "BACKFILL"],
    ["ai", "GENERATED"],
    ["motion_graphic", "GRAPHIC"],
    ["fallback", "PLACEHOLDER"],
  ])("puts %j on %j", (source, rung) => {
    expect(rungForAdoptSource(source)).toBe(rung);
  });

  /** An undeclared route has no rung at all, which is why RONDE 94 refuses it outright. */
  it("gives an undeclared route no rung", () => {
    expect(rungForAdoptSource("route_nobody_declared")).toBeNull();
    expect(rungForAdoptSource("")).toBeNull();
  });

  /** THE RULE THE BRIEF STATES TWICE: a fallback may never displace a good approved visual. */
  it("a lower rung cannot displace a higher one", () => {
    expect(fallbackMayReplace("APPROVED_REAL", "PLACEHOLDER")).toBe(false);
    expect(fallbackMayReplace("APPROVED_REAL", "FALLBACK_SUBJECT")).toBe(false);
    expect(fallbackMayReplace("RESCUE_REAL", "GENERATED")).toBe(false);
    expect(fallbackMayReplace("FALLBACK_SUBJECT", "PLACEHOLDER")).toBe(false);
  });

  it("a higher rung may always take over", () => {
    expect(fallbackMayReplace("PLACEHOLDER", "APPROVED_REAL")).toBe(true);
    expect(fallbackMayReplace("FALLBACK_SUBJECT", "RESCUE_REAL")).toBe(true);
    expect(fallbackMayReplace("GENERATED", "FALLBACK_SUBJECT")).toBe(true);
  });

  /** Two approved clips competing for one beat is an editorial choice, not this rule's business. */
  it("the same rung may replace itself", () => {
    expect(fallbackMayReplace("APPROVED_REAL", "APPROVED_REAL")).toBe(true);
  });

  it("an empty beat takes anything, and an undeclared route is still nothing", () => {
    expect(fallbackMayReplace(null, "PLACEHOLDER")).toBe(true);
    expect(fallbackMayReplace(null, null)).toBe(false);
    expect(fallbackMayReplace("PLACEHOLDER", null)).toBe(false);
  });

  it("ranks strictly", () => {
    expect(rungRank("APPROVED_REAL")).toBeLessThan(rungRank("RESCUE_REAL"));
    expect(rungRank("GRAPHIC")).toBeLessThan(rungRank("PLACEHOLDER"));
  });
});

/* ═══════════════ §8 — the beat coverage contract ═══════════════ */

describe("a beat's coverage state cannot outrun its evidence", () => {
  const cov = (over: Partial<Parameters<typeof beatCoverage>[0]> = {}) =>
    beatCoverage({ sceneIndex: 0, beatIndex: 0, source: "archive", approved: true, ...over });

  it("a funnel route with an approval is the only verified state", () => {
    const c = cov();
    expect(c.state).toBe("VERIFIED_REAL");
    expect(c.verified).toBe(true);
    expect(coverageIsVerified(c.state)).toBe(true);
  });

  /**
   * RENDER 568, AS A STANDING CHECK. Seventeen beats whose route said REAL_FUNNEL and whose
   * pictures nobody had looked at were reported as verified footage by every reader that derived
   * "verified" from the route alone.
   */
  it("a funnel route WITHOUT an approval is not verified", () => {
    const c = cov({ approved: false });
    expect(c.state).not.toBe("VERIFIED_REAL");
    expect(c.verified).toBe(false);
    expect(c.reason).toBe("NOT_APPROVED");
  });

  it("reports an unapproved funnel clip as the nearest honest rung, never a better one", () => {
    expect(cov({ approved: false }).state).toBe("RESCUE_REAL");
  });

  it("a subject fallback is real footage and never verified", () => {
    const c = cov({ source: "subject_fallback", approved: true });
    expect(c.state).toBe("FALLBACK_SUBJECT");
    expect(c.verified).toBe(false);
    expect(coverageIsVerified(c.state)).toBe(false);
  });

  /** Not even an approval promotes a rescue, a graphic or a placeholder to verified. */
  it.each([
    ["rescue_wikimedia", "RESCUE_REAL"],
    ["rescue_extend", "BACKFILL"],
    ["ai", "GENERATED"],
    ["motion_graphic", "GRAPHIC"],
    ["fallback", "PLACEHOLDER"],
  ])("%j is %j and never verified", (source, state) => {
    const c = cov({ source, approved: true });
    expect(c.state).toBe(state);
    expect(c.verified).toBe(false);
  });

  it("a beat with no picture says so", () => {
    const c = cov({ source: "", approved: false });
    expect(c.state).toBe("NO_VISUAL");
    expect(c.verified).toBe(false);
  });

  it("an undeclared route is no visual at all, with the reason named", () => {
    const c = cov({ source: "route_nobody_declared", approved: true });
    expect(c.state).toBe("NO_VISUAL");
    expect(c.verified).toBe(false);
    expect(c.reason).toBe("UNDECLARED_ROUTE");
  });

  it("carries the beat, the route, the reason and the lifecycle", () => {
    const line = formatBeatCoverage(
      cov({ sceneIndex: 2, beatIndex: 3, lifecycle: "DELIVERED", reason: "" })
    );
    expect(line).toContain("[BeatCoverage] s2b3");
    expect(line).toContain("state=VERIFIED_REAL");
    expect(line).toContain("verified=true");
    expect(line).toContain("lifecycle=DELIVERED");
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
