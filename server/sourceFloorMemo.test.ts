/**
 * THE RENDER PAID FOR THE SAME REFUSAL TWENTY-SIX TIMES.
 *
 * ── What render 562 measured ────────────────────────────────────────────────────────────────
 *
 *     222 × "source video too short (2.00s < 2.80s for a 3.50s slot)"
 *     34 distinct assets · 0 of them refused by any route other than the curated archive
 *     57358 × 26   57363 × 25   57360 × 23   57357 × 22   57371 × 18   57362 × 18
 *
 * Each repeat is a materialization and an ffprobe spent on a verdict the render already held.
 *
 * ── Why RONDE 86's fix did not hold ─────────────────────────────────────────────────────────
 *
 * R86 diagnosed exactly this on render 536 — "594 rejections across 37 distinct assets, an average
 * of sixteen identical failures per asset" — and registered the failure in the two routes it was
 * looking at. There are five routes into `prepareCuratedArchiveClip`, and three of them catch the
 * throw and register nothing (videoPipeline.ts 4412, 19618, 27827). Which route a beat happened to
 * take still decided whether the render learned anything, which is the sentence R86 itself wrote
 * about the previous version of this bug.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────
 *
 * The floor is unchanged. `VIDRUSH_MIN_SOURCE_VIDEO_SEC` is still 2.8, `stitchSourceFloorSec` still
 * decides it, and no clip that was refused before is accepted now. Whether 2.8 is the right number
 * needs a real render to answer; `formatSourceFloorLedger` is what will answer it, and the tests
 * below pin that it reports rather than decides.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  createSourceFloorMemo,
  formatSourceFloorLedger,
  noteSourceFloorFailure,
  parseSourceFloorFailure,
  sourceFloorWouldFailAgain,
} from "./sourceFloorMemo";
import { MAX_COVERAGE_SLOWDOWN } from "./coverageFillPlan";
import { VIDRUSH_MIN_SOURCE_VIDEO_SEC } from "./vidrushQuality";

/** The exact message trimVideoClip throws, taken from the production log. */
const REAL = "source video too short (2.00s < 2.80s for a 3.50s slot)";

/* ═══════════════════════ reading the refusal ═══════════════════════ */

describe("the refusal is read back into numbers", () => {
  it("parses the message the trim actually throws", () => {
    expect(parseSourceFloorFailure(REAL)).toEqual({
      sourceSec: 2.0,
      floorSec: 2.8,
      slotSec: 3.5,
    });
  });

  /**
   * Every OTHER failure must return null, or an undecodable file would be remembered as a length
   * problem and never retried at a shorter slot where it would fail for its real reason.
   */
  it.each([
    "curated asset 57358 has baked edit text — skipped",
    "curated asset 57358 still too low-res (220px)",
    "trimmed clip too short",
    "No such file or directory",
    "",
  ])("returns null for %s", (message) => {
    expect(parseSourceFloorFailure(message)).toBeNull();
  });

  /** The message must still be the one this parser expects — a reworded throw silently unwires it. */
  it("the message it parses is the message the trim throws", () => {
    const src = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(src, "trimVideoClip's message changed shape; the memo can no longer read it").toContain(
      "`source video too short (${sourceDur.toFixed(2)}s < ${minSource.toFixed(2)}s for a ${duration.toFixed(2)}s slot)`"
    );
  });
});

/* ═══════════════════════ asked once, not twenty-six times ═══════════════════════ */

describe("an asset refused for length is not asked the same question twice", () => {
  it("says yes for a slot demanding at least as much source", () => {
    const memo = createSourceFloorMemo();
    noteSourceFloorFailure(memo, 57358, { sourceSec: 2.0, floorSec: 2.8, slotSec: 3.5 });
    expect(sourceFloorWouldFailAgain(memo, 57358, 2.8)).toBe(true);
    expect(sourceFloorWouldFailAgain(memo, 57358, 2.9)).toBe(true);
  });

  /**
   * The narrowing that keeps this from being a ban. The floor comes from the SLOT, so a shorter
   * slot is a genuinely different question — a 2.0s asset refused at a 2.8s floor still fits a
   * 1.5s one, and refusing it there would throw away footage the render can use.
   */
  it("says no for a slot with a lower floor", () => {
    const memo = createSourceFloorMemo();
    noteSourceFloorFailure(memo, 57358, { sourceSec: 2.0, floorSec: 2.8, slotSec: 3.5 });
    expect(
      sourceFloorWouldFailAgain(memo, 57358, 1.5),
      "a short slot was refused footage that fits it — this is a ban, not a memo"
    ).toBe(false);
  });

  /** The LOWEST floor an asset has failed at is the one that counts. */
  it("keeps the lowest floor it has failed against", () => {
    const memo = createSourceFloorMemo();
    noteSourceFloorFailure(memo, 1, { sourceSec: 1.0, floorSec: 2.8, slotSec: 5 });
    noteSourceFloorFailure(memo, 1, { sourceSec: 1.0, floorSec: 1.5, slotSec: 1.5 });
    expect(sourceFloorWouldFailAgain(memo, 1, 1.5)).toBe(true);
    expect(sourceFloorWouldFailAgain(memo, 1, 1.4)).toBe(false);
  });

  it("knows nothing about an asset it has not seen", () => {
    expect(sourceFloorWouldFailAgain(createSourceFloorMemo(), 999, 2.8)).toBe(false);
  });

  /** No scope open — every accessor must be a no-op, so a caller behaves exactly as before. */
  it("is inert with no memo", () => {
    expect(() => noteSourceFloorFailure(undefined, 1, { sourceSec: 1, floorSec: 2, slotSec: 3 }))
      .not.toThrow();
    expect(sourceFloorWouldFailAgain(undefined, 1, 2.8)).toBe(false);
  });

  /** Render 562's worst asset, replayed: one real attempt instead of twenty-six. */
  it("turns 26 identical attempts into 1", () => {
    const memo = createSourceFloorMemo();
    let attempts = 0;
    for (let i = 0; i < 26; i++) {
      if (sourceFloorWouldFailAgain(memo, 57358, 2.8)) continue;
      attempts++;
      noteSourceFloorFailure(memo, 57358, { sourceSec: 2.0, floorSec: 2.8, slotSec: 3.5 });
    }
    expect(attempts, "the render still pays for the same refusal more than once").toBe(1);
  });
});

/* ═══════════════════════ the ledger measures, it does not decide ═══════════════════════ */

describe("the source-floor ledger", () => {
  /** Render 562's real distribution, from the log's own histogram. */
  function production() {
    const memo = createSourceFloorMemo();
    const rows: Array<[number, number, number, number]> = [
      // count, sourceSec, floorSec, slotSec
      [32, 2.0, 2.8, 3.5], [28, 2.0, 2.8, 5.0], [17, 1.96, 2.8, 3.5], [17, 1.44, 2.8, 3.5],
      [15, 2.04, 2.8, 3.5], [15, 1.28, 2.8, 3.5], [7, 2.0, 2.8, 7.0],
    ];
    let assetId = 0;
    for (const [count, sourceSec, floorSec, slotSec] of rows) {
      assetId++;
      for (let i = 0; i < count; i++) {
        noteSourceFloorFailure(memo, assetId, { sourceSec, floorSec, slotSec });
      }
    }
    return memo;
  }

  it("reports the repeats, not just the refusals", () => {
    const line = formatSourceFloorLedger(production(), MAX_COVERAGE_SLOWDOWN);
    expect(line).toContain("refusals=131");
    expect(line).toContain("uniqueAssets=7");
    expect(line, "the cost of asking twice is invisible").toContain("repeats=124");
  });

  /**
   * The number the threshold question turns on. The pipeline already slows footage up to
   * MAX_COVERAGE_SLOWDOWN to cover a gap without a held frame, so a 3.5s slot is fully coverable
   * by 1.75s of source. Every refusal at or above that length is footage the flat floor turned
   * away that this render's own machinery could have carried.
   */
  it("counts what the render's own coverage machinery could have carried", () => {
    const line = formatSourceFloorLedger(production(), MAX_COVERAGE_SLOWDOWN);
    /** 32 + 17 + 15 at a 3.5s slot (floor 1.75); the 5.0s and 7.0s rows are all below theirs. */
    expect(line).toContain("coverableAtSlowdown=64");
    expect(line).toContain(`slowdownCap=${MAX_COVERAGE_SLOWDOWN}x`);
  });

  it("names the assets worth looking at", () => {
    expect(formatSourceFloorLedger(production(), MAX_COVERAGE_SLOWDOWN)).toMatch(
      /mostRefused=1×32,2×28,/
    );
  });

  it("says so plainly when nothing was refused", () => {
    expect(formatSourceFloorLedger(createSourceFloorMemo(), MAX_COVERAGE_SLOWDOWN)).toBe(
      "[SourceFloor] no asset was refused for length"
    );
  });
});

/* ═══════════════════════ nothing was loosened ═══════════════════════ */

describe("no threshold moved", () => {
  it("the standalone floor is still 2.8s", () => {
    expect(VIDRUSH_MIN_SOURCE_VIDEO_SEC).toBe(2.8);
  });

  it("stitchSourceFloorSec still decides the floor from the slot", () => {
    const src = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const at = src.indexOf("async function trimVideoClip(");
    const body = src.slice(at, src.indexOf("\n}", src.indexOf("const take =", at)));
    expect(body).toContain("stitchSourceFloorSec(");
    expect(body).toContain("VIDRUSH_MIN_SOURCE_VIDEO_SEC");
    expect(body, "the refusal itself was weakened").toContain("sourceDur < minSource");
  });

  /** The memo must reject at the SAME floor the trim would, or it is a second policy. */
  it("the memo asks about the floor the trim would apply, not a number of its own", () => {
    const src = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const at = src.indexOf("export async function prepareCuratedArchiveClip(");
    const block = src.slice(at, at + 2400);
    expect(block, "the pre-check invents its own floor").toContain(
      "stitchSourceFloorSec(\n    styleContext?.minSourceSec ?? duration,\n    VIDRUSH_MIN_SOURCE_VIDEO_SEC\n  )"
    );
    expect(block).toContain("sourceFloorWouldFailAgain(getSourceFloorMemo(), asset.id");
  });
});

/* ═══════════════════════ one chokepoint, not five routes ═══════════════════════ */

describe("every route is covered because none of them has to remember", () => {
  const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  /**
   * The check and the record both sit inside `prepareCuratedArchiveClip`, which all five routes
   * call. A per-route rule is what failed in RONDE 86, and in R53, R62 and R70 before it.
   */
  it("the check and the record live in the function every route calls", () => {
    const at = CURATED.indexOf("export async function prepareCuratedArchiveClip(");
    const end = CURATED.indexOf("export type CuratedCandidatePick", at);
    const body = CURATED.slice(at, end);
    expect(body, "the pre-check is not in the shared function").toContain("sourceFloorWouldFailAgain(");
    expect(body, "the refusal is not recorded in the shared function").toContain(
      "noteSourceFloorFailure("
    );
  });

  /** And it must not have been sprinkled through the routes as well. */
  it("no route keeps its own copy", () => {
    expect(
      [...PIPE.matchAll(/noteSourceFloorFailure\(/g)],
      "a route is maintaining the memo by hand — that is the seam this replaces"
    ).toHaveLength(0);
  });

  /**
   * Render-scoped. A module-level Map would let one video's refusal ban an asset for another whose
   * slots are shorter.
   */
  it("the scope is opened once per render, around the whole render", () => {
    expect(PIPE).toContain("const sourceFloorMemo = createSourceFloorMemo()");
    /**
     * The property is ENCLOSURE, not the word `return` in front of it.
     *
     * This used to match `return withSourceFloorMemo(...)`, which held only while the memo happened
     * to be the outermost scope in the chain. It is not any more — the vision census wraps it — and
     * nothing about the memo changed. What has to stay true is that the scope opens before the
     * render body and closes after it, so every route inside shares one memo.
     */
    const scopes = [...PIPE.matchAll(/withSourceFloorMemo\(/g)];
    expect(scopes, "more than one scope is opened; renders would share a memo").toHaveLength(1);
    const scopeAt = PIPE.indexOf("withSourceFloorMemo(sourceFloorMemo, () =>");
    const bodyAt = PIPE.indexOf("_runVideoPipelineInner(");
    expect(scopeAt, "the memo scope is gone").toBeGreaterThan(-1);
    expect(bodyAt, "the render body moved out of the scope").toBeGreaterThan(scopeAt);
  });

  it("the render reports what the floor cost it", () => {
    expect(PIPE, "the ledger line is never emitted").toContain(
      "formatSourceFloorLedger(sourceFloorMemo, MAX_COVERAGE_SLOWDOWN)"
    );
  });
});
