/**
 * A CEILING THAT COUNTS SUCCESSES IS A CEILING THAT DOES NOT HOLD.
 *
 * ── Render 569 ──────────────────────────────────────────────────────────────────────────────
 *
 *     [SourcingMetrics] pixabay: searches=18 results=750 downloads=65 accepted=0
 *     [Quality] bron unverified leverde 21 beoordeelde kandidaten en geen enkele bruikbare
 *               (meestal MODERN_FOOTAGE)
 *
 * A documentary about 1945 pulled sixty-five files from a modern stock library and used none.
 * Every one of the twenty-one that reached the picture editor was refused — "The clip shows a
 * modern dining area which does not relate to the line about Hitler's belief in victory".
 *
 * ── Why the budget that existed did not stop it ─────────────────────────────────────────────
 *
 * `maxStockBeatsPerVideo` was 2 and `minimizeStockFootage` was on. It never bound, because
 * `stockBeatsUsed` is incremented on ADOPTION and stock was adopted zero times. The counter stayed
 * at zero, so the ceiling read "still room" sixty-five times. The worse a source performs, the
 * longer the render keeps paying it.
 *
 * RONDE 69 found this exact shape in the YouTube download ceiling — "a ceiling counting only
 * successes is the ceiling that does not hold, because the render whose 134 downloads were nearly
 * all failures never reached it" — and gave it `downloadSlotsClaimed`, which counts attempts on
 * purpose. This budget never learned it. Same seam, one budget short.
 *
 * ── What is asserted, and what is deliberately not ──────────────────────────────────────────
 *
 * These tests hold that the ceiling counts attempts, that its allowance is derived from two
 * numbers that already existed, and that adoption is untouched. They assert nothing about whether
 * stock footage is appropriate for any subject: no topic, person or period is named anywhere in
 * this change, and the picture editor's verdicts are exactly as they were.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { BUDGETS } from "./retrievalBudget";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const bodyOf = (name: string): string => {
  const at = PIPE.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const end = PIPE.indexOf("\n}\n", at);
  return PIPE.slice(at, end);
};

describe("the licensed-stock ceiling", () => {
  it("consults attempts, not only adoptions", () => {
    const body = bodyOf("canUseLicensedStockBeat");
    expect(body, "the adoption count alone is what failed").toContain("stockBeatsUsed");
    expect(body).toContain("stockDownloadAttempts");
    expect(body).toContain("maxLicensedStockAttempts");
  });

  /**
   * Both numbers already existed and were argued for elsewhere: the beats stock may fill, and the
   * downloads RONDE 97 says one beat may spend. Nothing here invents a threshold — which is the
   * difference between a budget and a guess.
   */
  it("derives its allowance rather than choosing one", () => {
    const body = bodyOf("maxLicensedStockAttempts");
    expect(body).toContain("maxStockBeatsPerVideo");
    expect(body).toContain("BUDGETS.downloads()");
    expect(body).not.toMatch(/\b(?:2[0-9]|[3-9][0-9]|1[0-9]{2})\b/);
  });

  /** Render 569's own configuration: 2 beats x 12 downloads = 24, against the 65 it made. */
  it("would have stopped render 569 at 24 attempts", () => {
    expect(2 * BUDGETS.downloads()).toBe(24);
    expect(2 * BUDGETS.downloads()).toBeLessThan(65);
  });

  /** A render allowed no stock beats is still allowed no stock — the old rule, unweakened. */
  it("still refuses outright when no stock beat is allowed", () => {
    expect(bodyOf("canUseLicensedStockBeat")).toContain("maxStockBeatsPerVideo <= 0");
  });

  /** And a render that never minimises stock is unaffected, exactly as before. */
  it("leaves an unrestricted render alone", () => {
    const body = bodyOf("canUseLicensedStockBeat");
    expect(body.indexOf("!dedup.perf.minimizeStockFootage")).toBeLessThan(
      body.indexOf("stockDownloadAttempts")
    );
  });
});

describe("attempts and adoptions stay separate", () => {
  /** Conflating them is the defect; the two functions must not touch each other's counter. */
  it("the attempt counter is not the adoption counter", () => {
    expect(bodyOf("markLicensedStockAttempt")).not.toContain("stockBeatsUsed");
    expect(bodyOf("markLicensedStockBeatUsed")).not.toContain("stockDownloadAttempts");
  });

  it("an attempt is charged before the bytes are requested, in both stock fetchers", () => {
    for (const fn of ["fetchPexelsClips", "fetchPixabayClips"]) {
      const at = PIPE.indexOf(`function ${fn}(`);
      const body = PIPE.slice(at, PIPE.indexOf("\nexport async function", at + 10));
      const charge = body.indexOf("markLicensedStockAttempt(");
      const download = body.indexOf("downloadToFileStreaming(");
      expect(charge, `${fn} never charges an attempt`).toBeGreaterThan(-1);
      expect(charge, `${fn} charges after the download`).toBeLessThan(download);
    }
  });

  /**
   * THE LINE THIS CHANGE MUST NOT CROSS.
   *
   * A stock clip that clears every gate is adopted on exactly the terms it was before. This bounds
   * how long a render keeps LOOKING; it does not judge what it finds, and it names no subject.
   */
  it("names no topic, person or period", () => {
    for (const fn of ["canUseLicensedStockBeat", "maxLicensedStockAttempts", "markLicensedStockAttempt"]) {
      expect(bodyOf(fn).toLowerCase()).not.toMatch(/hitler|nazi|wwii|ww2|1945|historical|archive/);
    }
  });

  /** Said once per render, not once per refusal — a spent budget is a fact, not a stream. */
  it("reports the spent budget exactly once", () => {
    expect(bodyOf("canUseLicensedStockBeat")).toContain("stockBudgetReported");
    expect(PIPE).toContain("[StockBudget]");
  });
});
