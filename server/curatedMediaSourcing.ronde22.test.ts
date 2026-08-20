import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasKnownBakedEditText } from "./curatedMediaSourcing";

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
  it("applies it in all three loops", () => {
    const hits = src.match(/hasKnownBakedEditText\(asset\)\) continue/g) ?? [];
    expect(hits).toHaveLength(3);
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
    expect(src).toContain("archiveClipHasBakedEditText(rawPath, asset.mimeType)");
  });
});
