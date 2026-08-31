import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  searchLibraryOfCongressCandidates,
  searchNasaCandidates,
  type PoolCandidate,
} from "./scenePool";

/**
 * RONDE 91 — this file calls the scene candidate pool's provider searches directly, outside any
 * beat.
 *
 * In production those searches run inside a beat's provenance scope (withSearchProvenance), which
 * is what lets the gate verify a query against what the script actually says. A direct call has no
 * such scope, so strict mode refuses it — correctly: a query nobody can trace is exactly what the
 * gate exists to stop.
 *
 * That refusal is not this file's subject. It tests what happens AFTER a query is admitted — the
 * response parsing, the per-source dedup, the concurrency ceiling, the allSettled isolation. The
 * gate's own behaviour, including the refusal above, is covered by ronde89ProviderGate,
 * ronde90SearchProvenance and ronde91SearchCleanup.
 *
 * Set at module scope, not in beforeAll: suites here snapshot process.env while the file is being
 * evaluated and restore it before every test.
 */
process.env.SEARCH_GATE_STRICT = "false";


// RONDE 3 / FIX A + FIX C — funnel retrieval latency.
//
// Wikimedia, Internet Archive, Europeana, NASA and Library of Congress each need a second
// request per search hit before a candidate can be built, and those were issued one at a
// time. Render 516: Library of Congress made 51 sequential calls and took 150975ms, which by
// itself was the whole funnel's 151s while the other eight providers had long finished — the
// retrieval budget for that render was 96s.
//
// FIX A batches those SAME requests DETAIL_FETCH_CONCURRENCY (5) at a time. The tests below
// exist to prove the batching is semantically invisible: same candidates, same order, same
// cap, same error isolation, same apiCalls accounting — only faster. The order guarantee is
// the important one, because candidate order feeds the funnel's ranking downstream.

const src = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function jsonResponse(ok: boolean, data: unknown): Response {
  return { ok, json: async () => data } as unknown as Response;
}

/** LOC search payload with `n` items, ids item0..item{n-1}, in a fixed order. */
function locSearchPayload(n: number, prefix = "item") {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      id: `https://www.loc.gov/${prefix}/${i}/`,
      url: `https://www.loc.gov/${prefix}/${i}/`,
      title: `${prefix} ${i}`,
      image_url: [`https://www.loc.gov/${prefix}/${i}/thumb.jpg`],
    })),
  };
}

const LOC_ITEM_OK = {
  item: { rights: "No known restrictions on publication." },
  resources: [{ files: [[{ mimetype: "image/jpeg", url: "https://tile.loc.gov/x.jpg" }]] }],
};

/**
 * Installs a fetch stub that answers the LOC search once and then answers every item URL,
 * while recording concurrency and call order. `delayMs` makes the latency measurable.
 */
function installLocFetch(opts: {
  searchPayload: unknown;
  delayMs?: number;
  itemFor?: (url: string) => unknown | Error | { notOk: true };
}) {
  const state = { inFlight: 0, maxInFlight: 0, itemCalls: [] as string[] };
  const delayMs = opts.delayMs ?? 0;

  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/search/?q=")) return jsonResponse(true, opts.searchPayload);

    state.itemCalls.push(url);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const result = opts.itemFor ? opts.itemFor(url) : LOC_ITEM_OK;
      if (result instanceof Error) throw result;
      if (result && typeof result === "object" && "notOk" in result) return jsonResponse(false, {});
      return jsonResponse(true, result);
    } finally {
      state.inFlight--;
    }
  }) as unknown as typeof fetch;

  return state;
}

/**
 * Reference implementation of the PRE-FIX behaviour: the exact same filters applied strictly
 * one item at a time. Used to prove the batched version produces an identical result set.
 */
function sequentialReference(payload: ReturnType<typeof locSearchPayload>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const result of payload.results) {
    if (out.length >= max) break;
    const itemUrl = result.url || result.id;
    if (!itemUrl || seen.has(itemUrl)) continue;
    seen.add(itemUrl);
    out.push(`loc:${itemUrl}`);
  }
  return out;
}

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

// ─── FIX A: concurrency bound ────────────────────────────────────────────────

describe("FIX A — concurrency is bounded at 5", () => {
  it("never has more than 5 LOC item requests in flight, with 25 items", async () => {
    const state = installLocFetch({ searchPayload: locSearchPayload(25), delayMs: 5 });
    await searchLibraryOfCongressCandidates(["berlin 1945"], 25);
    expect(state.maxInFlight).toBeLessThanOrEqual(5);
    expect(state.maxInFlight).toBeGreaterThan(1); // it really is parallel, not still serial
  });

  it("never exceeds 5 for NASA either", async () => {
    const state = { inFlight: 0, maxInFlight: 0 };
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("images-api.nasa.gov/search")) {
        return jsonResponse(true, {
          collection: {
            items: Array.from({ length: 20 }, (_, i) => ({
              data: [{ nasa_id: `n${i}`, title: `clip ${i}` }],
            })),
          },
        });
      }
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse(true, { collection: { items: [{ href: "https://x.test/a.mp4" }] } });
      } finally {
        state.inFlight--;
      }
    }) as unknown as typeof fetch;

    await searchNasaCandidates(["apollo"], 20);
    expect(state.maxInFlight).toBeLessThanOrEqual(5);
    expect(state.maxInFlight).toBeGreaterThan(1);
  });

  it("a batch fully settles before the next one starts (no unbounded fan-out)", async () => {
    // With 20 items, 5 at a time, in-flight must return to a level that cannot exceed 5 —
    // if batches overlapped, maxInFlight would climb past the bound.
    const state = installLocFetch({ searchPayload: locSearchPayload(20), delayMs: 3 });
    await searchLibraryOfCongressCandidates(["q"], 20);
    expect(state.maxInFlight).toBe(5);
    expect(state.itemCalls).toHaveLength(20);
  });
});

// ─── FIX A: the latency win is real ──────────────────────────────────────────

describe("FIX A — latency", () => {
  it("20 items at 20ms each finish in roughly 4 batches, not 20 serial waits", async () => {
    installLocFetch({ searchPayload: locSearchPayload(20), delayMs: 20 });
    const t0 = Date.now();
    await searchLibraryOfCongressCandidates(["q"], 20);
    const elapsed = Date.now() - t0;
    // Sequential would be >=400ms. Four batches of 5 is ~80ms; allow generous CI slack.
    expect(elapsed).toBeLessThan(300);
  });
});

// ─── FIX A: semantics are unchanged ──────────────────────────────────────────

describe("FIX A — candidate ORDER is identical to the sequential version", () => {
  it("candidates come back in search-result order, not completion order", async () => {
    // Later items resolve FIRST — the classic way parallelism corrupts ordering. Item i waits
    // (25 - i) ms, so completion order is the exact reverse of input order within a batch.
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/search/?q=")) return jsonResponse(true, locSearchPayload(15));
      const idx = Number(/\/item\/(\d+)\//.exec(url)?.[1] ?? 0);
      await new Promise((r) => setTimeout(r, (15 - idx) * 2));
      return jsonResponse(true, LOC_ITEM_OK);
    }) as unknown as typeof fetch;

    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 15);
    const ids = candidates.map((c: PoolCandidate) => c.id);
    expect(ids).toEqual(sequentialReference(locSearchPayload(15), 15));
    // Spelled out: strictly ascending, no reordering by who answered first.
    expect(ids[0]).toContain("/item/0/");
    expect(ids[14]).toContain("/item/14/");
  });

  it("order survives a slow item in the middle of a batch", async () => {
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/search/?q=")) return jsonResponse(true, locSearchPayload(5));
      if (url.includes("/item/1/")) await new Promise((r) => setTimeout(r, 40));
      return jsonResponse(true, LOC_ITEM_OK);
    }) as unknown as typeof fetch;

    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 5);
    expect(candidates.map((c) => c.id)).toEqual(sequentialReference(locSearchPayload(5), 5));
  });
});

describe("FIX A — the candidate cap still holds", () => {
  it("max=3 returns exactly 3 candidates even though the batch fetched 5", async () => {
    const state = installLocFetch({ searchPayload: locSearchPayload(20) });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 3);
    expect(candidates).toHaveLength(3);
    // The cap is applied per item in order, so it is the FIRST three, unchanged.
    expect(candidates.map((c) => c.id)).toEqual(sequentialReference(locSearchPayload(20), 3));
    // Bounded overshoot: one batch was in flight when the cap was hit, never the whole list.
    expect(state.itemCalls.length).toBeLessThanOrEqual(5);
  });

  it("the fix can never return MORE candidates than the sequential version would", async () => {
    for (const max of [1, 2, 3, 4, 5, 6, 9, 12, 25]) {
      installLocFetch({ searchPayload: locSearchPayload(25) });
      const { candidates } = await searchLibraryOfCongressCandidates(["q"], max);
      expect(candidates.map((c) => c.id), `max=${max}`).toEqual(
        sequentialReference(locSearchPayload(25), max)
      );
      expect(candidates.length, `max=${max}`).toBeLessThanOrEqual(max);
    }
  });

  it("the max check is still evaluated per item, not only per batch", async () => {
    // 7 items, max 6: the second batch starts (cap not yet reached at 5) and must stop at 6.
    installLocFetch({ searchPayload: locSearchPayload(7) });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 6);
    expect(candidates).toHaveLength(6);
  });
});

describe("FIX A — filters, dedup and error isolation are unchanged", () => {
  it("a rights-rejected item is still dropped, and does not shift the others", async () => {
    installLocFetch({
      searchPayload: locSearchPayload(6),
      itemFor: (url) =>
        url.includes("/item/2/")
          ? { item: { rights: "All rights reserved" }, resources: LOC_ITEM_OK.resources }
          : LOC_ITEM_OK,
    });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toHaveLength(5);
    expect(ids.some((id) => id.includes("/item/2/"))).toBe(false);
    expect(ids).toEqual([0, 1, 3, 4, 5].map((i) => `loc:https://www.loc.gov/item/${i}/`));
  });

  it("an item with no media file is still dropped", async () => {
    installLocFetch({
      searchPayload: locSearchPayload(4),
      itemFor: (url) => (url.includes("/item/1/") ? { item: LOC_ITEM_OK.item, resources: [] } : LOC_ITEM_OK),
    });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 10);
    expect(candidates.map((c) => c.id)).toEqual(
      [0, 2, 3].map((i) => `loc:https://www.loc.gov/item/${i}/`)
    );
  });

  it("one throwing item does not take down the rest of its batch", async () => {
    installLocFetch({
      searchPayload: locSearchPayload(5),
      itemFor: (url) => (url.includes("/item/2/") ? new Error("socket hang up") : LOC_ITEM_OK),
    });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 10);
    expect(candidates.map((c) => c.id)).toEqual(
      [0, 1, 3, 4].map((i) => `loc:https://www.loc.gov/item/${i}/`)
    );
  });

  it("a non-ok item response is skipped but still counted as an API call", async () => {
    installLocFetch({
      searchPayload: locSearchPayload(4),
      itemFor: (url) => (url.includes("/item/1/") ? { notOk: true as const } : LOC_ITEM_OK),
    });
    const { candidates, apiCalls } = await searchLibraryOfCongressCandidates(["q"], 10);
    expect(candidates).toHaveLength(3);
    expect(apiCalls).toBe(5); // 1 search + 4 item calls, the 404 included — as before
  });

  it("a THROWN item request is not counted as an API call (pre-fix accounting)", async () => {
    installLocFetch({
      searchPayload: locSearchPayload(3),
      itemFor: (url) => (url.includes("/item/1/") ? new Error("timeout") : LOC_ITEM_OK),
    });
    const { apiCalls } = await searchLibraryOfCongressCandidates(["q"], 10);
    expect(apiCalls).toBe(3); // 1 search + 2 successful items; the throw is not counted
  });

  it("duplicate item URLs are still deduped to one candidate", async () => {
    const dup = { results: [0, 0, 1].map((i) => ({
      id: `https://www.loc.gov/item/${i}/`,
      url: `https://www.loc.gov/item/${i}/`,
      title: `item ${i}`,
      image_url: [],
    })) };
    installLocFetch({ searchPayload: dup });
    const { candidates } = await searchLibraryOfCongressCandidates(["q"], 10);
    expect(candidates.map((c) => c.id)).toEqual([
      "loc:https://www.loc.gov/item/0/",
      "loc:https://www.loc.gov/item/1/",
    ]);
  });

  it("an empty result set and a failing search are both still no-ops", async () => {
    installLocFetch({ searchPayload: { results: [] } });
    expect((await searchLibraryOfCongressCandidates(["q"], 10)).candidates).toEqual([]);

    global.fetch = vi.fn(async () => jsonResponse(false, {})) as unknown as typeof fetch;
    expect((await searchLibraryOfCongressCandidates(["q"], 10)).candidates).toEqual([]);
  });

  it("the candidate object itself is byte-for-byte the pre-fix shape", async () => {
    installLocFetch({ searchPayload: locSearchPayload(1) });
    const { candidates } = await searchLibraryOfCongressCandidates(["berlin"], 10);
    expect(candidates[0]).toEqual({
      id: "loc:https://www.loc.gov/item/0/",
      assetId: "https://www.loc.gov/item/0/",
      source: "loc",
      remoteUrl: "https://tile.loc.gov/x.jpg",
      thumbnailUrl: "https://www.loc.gov/item/0/thumb.jpg",
      title: "item 0",
      description: null,
      tags: ["berlin"],
      mediaType: "image",
      durationSec: null,
      license: "No known restrictions on publication.",
      width: null,
      height: null,
      sourceCreator: null,
      licenseUrl: "https://www.loc.gov/item/0/",
      clipSimilarity: null,
      embeddingSimilarity: null,
      rankingScore: null,
      visionScore: null,
      selectionScore: null,
    });
  });
});

// ─── FIX A: applied to exactly the five providers named ──────────────────────

describe("FIX A — scope", () => {
  const batched = [
    "searchWikimediaCandidates",
    "searchInternetArchiveCandidates",
    "searchEuropeanaCandidates",
    "searchNasaCandidates",
    "searchLibraryOfCongressCandidates",
  ];

  function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.indexOf("\n}\n");
    return rest.slice(0, end);
  }

  it("all five detail-fetching providers use the batched loop", () => {
    /**
     * The property under test is "a batch of search hits does not cost one sequential request
     * each". `await Promise.all(` was the way every provider achieved that.
     *
     * RONDE 136 gave Wikimedia something stronger: MediaWiki's query API takes up to 50
     * pipe-separated titles, so a whole batch is now ONE request rather than five concurrent ones.
     * That is the same property, better satisfied — video 558 logged 32 HTTP 429s and 34
     * provider stand-downs from the old shape, ending with 38 search results and zero downloads.
     *
     * So the assertion allows either mechanism, and still demands the batching loop and the cap
     * from every provider. It has NOT been loosened for the other four: they must still show a
     * concurrent fan-out.
     */
    for (const name of batched) {
      const body = codeOnly(bodyOf(name));
      expect(body, name).toContain("i += DETAIL_FETCH_CONCURRENCY");
      expect(body, name).toContain("if (candidates.length >= max) break;");
      if (name === "searchWikimediaCandidates") {
        // One request for the whole batch — the pipe-separated multi-title form.
        expect(body, name).toContain("batch.join(\"|\")");
      } else {
        expect(body, name).toContain("await Promise.all(");
      }
    }
  });

  it("the concurrency bound is 5 and is defined once", () => {
    expect(src).toContain("const DETAIL_FETCH_CONCURRENCY = 5;");
    const decls = codeOnly(src).match(/DETAIL_FETCH_CONCURRENCY\s*=/g) ?? [];
    expect(decls).toHaveLength(1);
  });

  it("providers without a per-item detail fetch were not touched", () => {
    // Pexels/Pixabay/Openverse/NARA build candidates straight from the search response.
    for (const name of ["searchPexelsCandidates", "searchPixabayCandidates", "searchOpenverseCandidates", "searchNaraCandidates"]) {
      expect(codeOnly(bodyOf(name)), name).not.toContain("DETAIL_FETCH_CONCURRENCY");
    }
  });

  it("no request timeout, header or URL was changed", () => {
    expect(src).toContain(`withTimeoutFetch(itemJsonUrl, UA, 8_000, \`Library of Congress pool item`);
    expect(src).toContain(`withTimeoutFetch(metaUrl, UA, 8_000, \`Internet Archive pool metadata`);
    // RONDE 136: Wikimedia now sends ONE request for the whole batch, so its label and timeout
    // changed with it (8s for up to five titles' worth of metadata instead of 5s for one). Same
    // endpoint, same UA, same params — asserted here rather than dropped.
    expect(src).toContain(`withTimeoutFetch(infoUrl, UA, 8_000, \`Wikimedia pool info batch`);
    expect(src).toContain("https://commons.wikimedia.org/w/api.php?action=query");
    expect(src).toContain("&prop=imageinfo");
    expect(src).toContain(`withTimeoutFetch(recordUrl, authHeader, 8_000, \`Europeana pool record`);
    expect(src).toContain(`withTimeoutFetch(assetUrl, UA, 8_000, \`NASA pool asset`);
    expect(src).toContain('const UA = { "User-Agent": "Fastvid/1.0 (video generation)" };');
  });

  it("no ranking, cap or pool constant moved", () => {
    expect(src).toContain("export const MAX_CANDIDATES_PER_SOURCE = 25;");
    expect(src).toContain("export const MAX_POOL_SIZE = 100;");
    const code = codeOnly(src);
    expect(code).not.toContain("Math.random");
    expect(code).not.toMatch(/\.rankingScore\s*=[^=]/);
    expect(code).not.toMatch(/\.selectionScore\s*=[^=]/);
    expect(code).not.toMatch(/\.visionScore\s*=[^=]/);
  });

  it("providers still run in parallel with each other, unchanged", () => {
    expect(src).toContain("const results = await Promise.allSettled(tasks);");
  });
});

// ─── FIX C: per-provider latency observability ───────────────────────────────

describe("FIX C — per-provider latency logging", () => {
  it("the [ScenePool] line reports ms per provider, slowest first", () => {
    expect(src).toContain("const msPerProvider: Record<string, number> = {};");
    expect(src).toContain("msPerProvider[source] = ms;");
    expect(src).toContain("` | ms: ${Object.entries(msPerProvider).sort((a, b) => b[1] - a[1])");
  });

  it("every provider task carries its own elapsed time from one shared start", () => {
    const decls = codeOnly(src).match(/const liveT0 = Date\.now\(\);/g) ?? [];
    expect(decls).toHaveLength(1);
    const uses = codeOnly(src).match(/ms: Date\.now\(\) - liveT0,/g) ?? [];
    expect(uses).toHaveLength(9); // one per provider task
  });

  it("logging added no await, no retry and no extra request", () => {
    const start = src.indexOf("const liveT0 = Date.now();");
    const end = src.indexOf("const results = await Promise.allSettled(tasks);");
    const block = codeOnly(src.slice(start, end));
    expect(block).not.toContain("await ");
    expect(block).not.toMatch(/\bretry\b|\bbackoff\b/i);
    expect(block).not.toContain("fetch(");
  });

  it("the existing calls: section of the log is unchanged", () => {
    expect(src).toContain(
      "`in ${latencyMs}ms | calls: ${Object.entries(apiCallsPerProvider).map(([k, v]) => `${k}=${v}`).join(\", \")}`"
    );
  });
});

// ─── Untouched: RONDE 1 + RONDE 2 ────────────────────────────────────────────

describe("RONDE 1 + RONDE 2 are untouched by RONDE 3", () => {
  const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
  const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("FIX 1/2 cross-beat memory is intact", () => {
    expect(funnelSrc).toContain("const unused = usedCandidateIds?.size");
    expect(funnelSrc).toContain("const unusedPassers = usedCandidateIds?.size");
    expect(pipelineSrc).toMatch(/pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds[,)]/);
  });

  it("FIX 3 failed-download registration is intact", () => {
    // RONDE 132 counts both forms: the winner's registration moved into markAssetUsedInVideo,
    // which writes this same Set plus the identities the funnel never recorded. Same invariant.
    const code = codeOnly(pipelineSrc);
    const occurrences = code.match(/dedup\.usedFunnelCandidateIds\.add\(candidate\.id\);/g) ?? [];
    const viaRegistry = code.match(/funnelCandidateId: candidate\.id,/g) ?? [];
    expect(occurrences.length + viaRegistry.length).toBe(2);
  });

  it("FIX 4 gap strategy still eliminates no candidates", () => {
    expect(funnelSrc).toContain('case "archive_only":\n    case "one_external":\n    case "all_external":');
    expect(codeOnly(funnelSrc)).not.toContain("externalCands.slice(0, 1)");
  });

  it("no funnel or pipeline constant was touched by RONDE 3", () => {
    expect(funnelSrc).toContain("export const STOCK_TIER_WIN_MARGIN = 1.0;");
    expect(funnelSrc).toContain("export const FUNNEL_CANDIDATE_POOL_LIMIT = 15;");
    expect(funnelSrc).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    expect(funnelSrc).toContain("const KEYWORD_SCORE_MAX = 100;"); // FIX 5 still not done
  });
});
