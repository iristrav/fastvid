import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasKnownBakedEditText } from "./visualJudge";

// RONDE 22 — renders 526/527 logged 255 of these across only 10 distinct assets:
//
//   [Pipeline] Scene N beat M: curated asset 55965 failed:
//              curated asset 55965 has baked edit text — skipped
//
// The verdict IS cached on the row (hasBakedEditText), but it was only ever read at adoption
// time — i.e. after the selector had already picked the asset AND materialized it to disk. So
// the selector kept re-choosing assets it already knew could never be adopted, paying a
// download each time. With a small archive that is severe: 10 of 17 assets were flagged, so
// roughly six in ten picks were guaranteed to fail before the beat could reach a usable clip.
//
// The fix treats it as a selection-time filter, alongside the off-topic/geo/non-documentary
// checks that already sit in the same `continue` chain — in all three candidate loops.

const src = readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

describe("RONDE 22 — hasKnownBakedEditText", () => {
  it("flags an asset whose cached verdict says it has baked text", () => {
    expect(hasKnownBakedEditText({ hasBakedEditText: 1 })).toBe(true);
  });

  it("passes an asset explicitly cleared by a prior check", () => {
    expect(hasKnownBakedEditText({ hasBakedEditText: 0 })).toBe(false);
  });

  it("passes an UNCHECKED asset so it can still reach the adoption-time check", () => {
    // null means "never checked" — filtering these out would silently shrink the archive to
    // only previously-adopted assets and stop new ones from ever being evaluated.
    expect(hasKnownBakedEditText({ hasBakedEditText: null })).toBe(false);
    expect(hasKnownBakedEditText({ hasBakedEditText: undefined as unknown as null })).toBe(false);
  });
});

describe("RONDE 22 — every candidate loop honors the filter", () => {
  it("applies it in every candidate loop", () => {
    /** ONE ROUTE — the third loop was the exhausted-reuse pool, which is gone; every loop left filters. */
    const hits = src.match(/hasKnownBakedEditText\(asset\)\) continue/g) ?? [];
    const loops = src.split("for (const asset of assets)").length - 1;
    expect(loops).toBe(2);
    expect(hits).toHaveLength(loops);
  });

  it("filters before scoring, not after selection", () => {
    // The whole point is to skip the asset before it costs a pick and a download, so the guard
    // must sit above scoreCuratedAsset in each loop.
    for (const loop of src.split("for (const asset of assets)").slice(1)) {
      const guard = loop.indexOf("hasKnownBakedEditText(asset)) continue");
      const score = loop.indexOf("scoreCuratedAsset(");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(score);
    }
  });

  it("still throws at adoption time as the backstop for unchecked assets", () => {
    // Selection-time filtering is an optimisation, not a replacement: an asset that has never
    // been checked must still be caught (and have its verdict cached) when it is adopted.
    expect(src).toContain("has baked edit text — skipped");
    /** VIDEO 626 — through the verdict, so a check that could not look is not cached as clean. */
    expect(src).toContain("const text = await judgeOnScreenText({ path: rawPath, mimeType: asset.mimeType });");
    expect(src).toContain("if (text.evaluated === false) {");
  });
});
