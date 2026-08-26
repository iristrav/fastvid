import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// videoPipeline.ts calls the National Archives Catalog API via `import fetch from "node-fetch"`
// (not the global fetch), so network behavior for fetchNaraClips is controlled by mocking that
// module directly — same target the real adapter code calls.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import { HISTORICAL_SOURCE_TIER_ORDER, fetchNaraClips } from "./videoPipeline";

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
describe("HISTORICAL_SOURCE_TIER_ORDER — F3-28 Test 2-8 (exact required source order)", () => {
  it("matches the exact required priority: Archive → YouTube CC → Wikimedia → NARA → other open-license, Pexels/Pixabay excluded entirely", () => {
    expect(HISTORICAL_SOURCE_TIER_ORDER).toEqual([
      "internet_archive",
      "youtube_cc",
      "wikimedia",
      "nara",
      "flickr",
      "sepiasearch",
      "vimeo",
      "media_ccc",
      "nasa",
    ]);
    // Pexels/Pixabay must never appear in this list — they stay the separate, absolute
    // last-resort tier tried only after every source above has failed for a beat.
    expect(HISTORICAL_SOURCE_TIER_ORDER).not.toContain("pexels");
    expect(HISTORICAL_SOURCE_TIER_ORDER).not.toContain("pixabay");
  });

  it("Internet Archive comes before YouTube CC, which comes before Wikimedia, which comes before NARA", () => {
    const order = HISTORICAL_SOURCE_TIER_ORDER;
    expect(order.indexOf("internet_archive")).toBeLessThan(order.indexOf("youtube_cc"));
    expect(order.indexOf("youtube_cc")).toBeLessThan(order.indexOf("wikimedia"));
    expect(order.indexOf("wikimedia")).toBeLessThan(order.indexOf("nara"));
    expect(order.indexOf("nara")).toBeLessThan(order.indexOf("flickr"));
  });
});

describe("fetchNaraClips — F3-28 Test 5 (national archives adapter, key-gated)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NARA_API_KEY;
    nodeFetchMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is a clean no-op (no network call at all) without NARA_API_KEY", async () => {
    const result = await fetchNaraClips("Kylie Jenner", 6, "/tmp", 0);
    expect(result).toEqual([]);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });

  it("is a clean no-op for an empty query, even with a key configured", async () => {
    process.env.NARA_API_KEY = "test-key";
    const result = await fetchNaraClips("", 6, "/tmp", 0);
    expect(result).toEqual([]);
    expect(nodeFetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the search request itself fails", async () => {
    process.env.NARA_API_KEY = "test-key";
    nodeFetchMock.mockRejectedValue(new Error("network down"));
    await expect(fetchNaraClips("Kylie Jenner", 6, "/tmp", 0)).resolves.toEqual([]);
  });

  it("returns [] (not a throw) when the search responds but not ok, and sends the configured key", async () => {
    process.env.NARA_API_KEY = "test-key";
    nodeFetchMock.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchNaraClips("Kylie Jenner", 6, "/tmp", 0);
    expect(result).toEqual([]);
    expect(nodeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = nodeFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("catalog.archives.gov");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "test-key" });
  });
});
