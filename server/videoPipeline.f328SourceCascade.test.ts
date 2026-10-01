import { describe, expect, it } from "vitest";

import { HISTORICAL_SOURCE_TIER_ORDER } from "./videoPipeline";

/**
 * RONDE 90 — this file calls provider fetchers directly, outside any beat.
 *
 * In production every provider search runs inside a beat's provenance scope
 * (withSearchProvenance), and that scope is what lets the gate verify a query against what the
 * script actually says. A direct call has no such scope, so strict mode refuses it — correctly,
 * and by design: a query nobody can trace is exactly what RONDE 90 exists to stop.
 *
 * That refusal is not what this file is about. Its subject is what happens AFTER a query is
 * admitted — the render-scoped query cache, the per-item licence gates, the dedup skips, the call
 * ceilings. The gate's own behaviour, including the refusal above, is covered by
 * ronde89ProviderGate and ronde90SearchProvenance; restating it in every assertion here would
 * test the gate twice and these mechanics not at all.
 */
// Set at module scope, not in beforeAll: several suites here snapshot `process.env` into an
// ORIGINAL_ENV constant while the file is being evaluated and restore it before every test, so a
// value written later is wiped again before the first assertion runs.
process.env.SEARCH_GATE_STRICT = "false";


// F3-28: source cascade expansion — extends the existing fetchHistoricalBeatVideo waterfall
// (previously Wiki/Archive interleaved per query, YouTube force-skipped on the live default
// path) into the exact requested priority order: own archive (handled by the caller before this
// list is even consulted) → Internet Archive → YouTube CC → Wikimedia → NARA (national archives)
// → other open-license sources (Flickr/SepiaSearch/Vimeo/media.ccc/NASA) → [web-wide discovery,
// deferred — see final report] → Pexels/Pixabay (unchanged, separate last-resort tier in
// fetchBeatArchivalThenPexels/fetchBeatStockFallback, not part of this list at all). Every tier
// dispatches to an existing, unmodified fetch function — only the NARA adapter is new, and it is
// a small, isolated, key-gated no-op without NARA_API_KEY, exactly like the existing
// FLICKR_API_KEY/VIMEO_ACCESS_TOKEN-gated adapters it's modeled on.
// VIDEO 619 — NARA, Flickr, SepiaSearch, Vimeo, media.ccc and NASA delivered nothing to any film
// across renders 597–619 and were removed; the cascade keeps the three sources that did deliver.
describe("HISTORICAL_SOURCE_TIER_ORDER — F3-28 Test 2-8 (exact required source order)", () => {
  it("matches the exact required priority: Archive → Wikimedia (YouTube has its own turn), Pexels/Pixabay excluded entirely", () => {
    /** Code audit P2/P12: YouTube is asked only by the beat's YouTube turn, never by the cascade. */
    expect(HISTORICAL_SOURCE_TIER_ORDER).toEqual(["internet_archive", "wikimedia"]);
    // Pexels/Pixabay must never appear in this list — they stay the separate, absolute
    // last-resort tier tried only after every source above has failed for a beat.
    expect(HISTORICAL_SOURCE_TIER_ORDER).not.toContain("pexels");
    expect(HISTORICAL_SOURCE_TIER_ORDER).not.toContain("pixabay");
  });
});
