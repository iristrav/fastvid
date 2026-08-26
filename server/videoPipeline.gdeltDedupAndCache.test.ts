import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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


// Beeldkwaliteit vervolgpatch (Fase 1 + Fase 3/9) — GDELT TV news was the one provider that:
//   (a) never checked/registered a pre-download dedup key (providerAssetAlreadyUsed), and
//   (b) issued its per-query search as a raw fetch() outside the render-scoped query cache
//       every other provider already uses (cachedProviderSearch).
// Both are now fixed by reusing the exact existing mechanisms (providerAssetKey/
// tagPathWithProviderAsset for identity, cachedProviderSearch for the query cache) — no new
// cache/dedup system. These tests pin down both fixes without needing a real ffmpeg stream:
// the dedup check runs (and can short-circuit) before resolveArchiveVideoFileUrl's network call,
// and the query-cache check is provable from the raw GDELT search fetch count alone.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

function gdeltSearchOk(clips: Array<{ preview_url: string; snippet?: string; show?: string; station?: string }>) {
  return { ok: true, text: async () => JSON.stringify({ clips }) };
}

describe("fetchGdeltTvNewsClips — Fase 1/3/9 (dedup + query cache)", () => {
  beforeEach(() => {
    nodeFetchMock.mockReset();
  });

  it("Fase 1 — a segment already in usedProviderKeys is skipped before the archive.org metadata call", async () => {
    const { fetchGdeltTvNewsClips, providerAssetKey } = await freshPipeline();
    const previewUrl = "https://archive.org/details/CNN_20200101#start/100/end/110";
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.gdeltproject.org")) {
        return Promise.resolve(gdeltSearchOk([{ preview_url: previewUrl, show: "Show", station: "CNN" }]));
      }
      // Any archive.org metadata/download call means the dedup skip failed to short-circuit.
      return Promise.resolve({ ok: false, status: 404 });
    });

    // Segment identity = `${identifier}@${round(startSec)}` — matches the fix exactly.
    const usedProviderKeys = new Set([providerAssetKey("gdelt_tv", "CNN_20200101@100")]);

    const result = await fetchGdeltTvNewsClips(
      "Kylie Jenner", 6, "/tmp", 0, 1, "", "", [], false, undefined, usedProviderKeys
    );

    expect(result).toEqual([]);
    const archiveCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("archive.org"));
    expect(archiveCalls).toHaveLength(0);
  });

  it("Fase 3/9 — the exact same query is searched at most once per render (SourcingCache)", async () => {
    const { fetchGdeltTvNewsClips } = await freshPipeline();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.gdeltproject.org")) {
        return Promise.resolve(gdeltSearchOk([]));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const sourcingCache = {
      queries: new Map(), assets: new Map(), metrics: new Map(),
      totals: {
        queryCacheHits: 0, assetCacheHits: 0, duplicateCandidatesSkipped: 0,
        duplicateDownloadsPrevented: 0, visionCacheHits: 0,
      },
      visionHitBaseline: 0,
    } as unknown as Parameters<typeof fetchGdeltTvNewsClips>[9];

    await fetchGdeltTvNewsClips("Moon landing", 6, "/tmp", 0, 1, "", "", [], false, sourcingCache);
    await fetchGdeltTvNewsClips("Moon landing", 6, "/tmp", 1, 1, "", "", [], false, sourcingCache);

    const searchCalls = nodeFetchMock.mock.calls.filter(([u]) => String(u).includes("api.gdeltproject.org"));
    expect(searchCalls).toHaveLength(1);
  });

  it("never throws when the GDELT search request itself fails", async () => {
    const { fetchGdeltTvNewsClips } = await freshPipeline();
    nodeFetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      fetchGdeltTvNewsClips("X", 6, "/tmp", 0, 1)
    ).resolves.toEqual([]);
  });
});
