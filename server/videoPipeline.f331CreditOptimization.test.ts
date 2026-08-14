import { describe, expect, it } from "vitest";
import { uniqueQueryStrings } from "./stringCoercion";

// F3-31 (minimal credit optimization on the F3-28/29/30 source cascade): fetchHistoricalBeatVideo
// builds its per-tier query list as `uniqueQueryStrings([...entityYt, ...queries]).slice(0,
// queryCap)`, with queryCap now 3 in normal mode (was 6) and unchanged at 2 in fastStockMode —
// applied identically across all 9 historical tiers (Internet Archive/YouTube CC/Wikimedia/NARA/
// Flickr/SepiaSearch/Vimeo/media.ccc/NASA), so this directly bounds the worst-case tier-fetch
// count from ~54 to ~27 per beat (18 in fastStockMode) without dropping any tier or changing
// query ranking/content. fetchHistoricalBeatVideo itself is deep inside videoPipeline.ts with a
// heavy VisualDedupState/Scene/SceneBeat dependency graph — rather than construct a large fixture
// (or export/refactor it purely for testability, which would be a mini-refactor of unrelated
// production code), this tests the exact same query-construction expression directly via the
// shared, already-exported uniqueQueryStrings helper it's built from — proving the dedup +
// cap behavior the production code relies on, without touching fetchHistoricalBeatVideo itself.
describe("F3-31 — per-tier query cap + dedup (fetchHistoricalBeatVideo's query construction)", () => {
  it("Test 1 — normal mode: caps at 3 queries, strongest/first-listed queries win", () => {
    const entityYt = ["Kylie Jenner interview", "Kylie Jenner 2020"];
    const queries = ["Kylie Jenner archival footage", "Kylie Jenner documentary", "Kylie Jenner ship"];
    const queryCap = 3; // fastStockMode ? 2 : 3
    const allQueries = uniqueQueryStrings([...entityYt, ...queries]).slice(0, queryCap);
    expect(allQueries).toHaveLength(3);
    expect(allQueries).toEqual(["Kylie Jenner interview", "Kylie Jenner 2020", "Kylie Jenner archival footage"]);
  });

  it("Test 2 — fastStockMode: caps at 2 queries", () => {
    const entityYt = ["Kylie Jenner interview", "Kylie Jenner 2020"];
    const queries = ["Kylie Jenner archival footage"];
    const queryCap = 2;
    const allQueries = uniqueQueryStrings([...entityYt, ...queries]).slice(0, queryCap);
    expect(allQueries).toHaveLength(2);
    expect(allQueries).toEqual(["Kylie Jenner interview", "Kylie Jenner 2020"]);
  });

  it("Test 3 — exact-duplicate queries across entityYt/queries are removed before the cap is applied", () => {
    const entityYt = ["Kylie Jenner interview", "Kylie Jenner archival footage"];
    // Same string appears in both lists — must count once toward the cap, not twice.
    const queries = ["Kylie Jenner archival footage", "Kylie Jenner documentary"];
    const queryCap = 3;
    const allQueries = uniqueQueryStrings([...entityYt, ...queries]).slice(0, queryCap);
    expect(allQueries).toEqual([
      "Kylie Jenner interview",
      "Kylie Jenner archival footage",
      "Kylie Jenner documentary",
    ]);
    expect(new Set(allQueries).size).toBe(allQueries.length);
  });

  it("does not treat near-duplicates (different case/content) as the same query — only exact strings collapse", () => {
    const result = uniqueQueryStrings(["Kylie Jenner", "kylie jenner", "Kylie Jenner "]);
    // "Kylie Jenner " is trimmed by toQueryString (existing, pre-F3-31 behavior) so it collapses
    // with "Kylie Jenner"; the differently-cased variant is left alone — content is not altered
    // beyond the pre-existing trim, per the "verander de inhoud verder niet" requirement.
    expect(result).toEqual(["Kylie Jenner", "kylie jenner"]);
  });
});
