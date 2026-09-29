import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

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

// VIDEO 619 — Europeana, NASA and Library of Congress delivered nothing to any film across renders
// 597–619 and were removed from the pool. The runtime batching tests were written against LOC's
// item fetch; with LOC gone the batching is pinned below on the two providers that keep it.

describe("FIX A — scope", () => {
  const batched = [
    "searchWikimediaCandidates",
    "searchInternetArchiveCandidates",
  ];

  function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.indexOf("\n}\n");
    return rest.slice(0, end);
  }

  it("both detail-fetching providers use the batched loop", () => {
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
    // Pexels/Pixabay build candidates straight from the search response.
    for (const name of ["searchPexelsCandidates", "searchPixabayCandidates"]) {
      expect(codeOnly(bodyOf(name)), name).not.toContain("DETAIL_FETCH_CONCURRENCY");
    }
  });

  it("no request timeout, header or URL was changed", () => {
    expect(src).toContain(`withTimeoutFetch(metaUrl, UA, 8_000, \`Internet Archive pool metadata`);
    // RONDE 136: Wikimedia now sends ONE request for the whole batch, so its label and timeout
    // changed with it (8s for up to five titles' worth of metadata instead of 5s for one). Same
    // endpoint, same UA, same params — asserted here rather than dropped.
    expect(src).toContain(`withTimeoutFetch(infoUrl, UA, 8_000, \`Wikimedia pool info batch`);
    expect(src).toContain("https://commons.wikimedia.org/w/api.php?action=query");
    expect(src).toContain("&prop=imageinfo");
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

  /**
   * RONDE 246 — WHAT THIS GUARD PROTECTS, AND WHAT DELIBERATELY CHANGED.
   *
   * RONDE 3 exists because Library of Congress made 51 SEQUENTIAL calls and took 150 seconds.
   * Serialising retrieval is the regression it was written to catch, so a change that serialises
   * anything has to answer to it rather than edit it away.
   *
   * Tiering serialises retrieval ACROSS tiers, on purpose: the operator ranks YouTube first, then
   * their own archive, then Internet Archive and Wikimedia, then the rest, and a scene that is
   * already served never asks the later tiers at all. The cost moves from "the slowest of eleven"
   * to "the sum of the tiers actually visited", and the early exit is what pays for it.
   *
   * What must NOT change — and is what this test now pins — is parallelism WITHIN a group. That is
   * the property that stopped the 51 sequential calls, and it is intact: a tier's members are
   * still handed to one `Promise.allSettled`, so a slow or broken provider neither serialises its
   * neighbours nor takes their results down with it.
   */
  it("providers in the same tier still run in parallel with each other", () => {
    const runner = readFileSync(path.join(__dirname, "tieredRetrieval.ts"), "utf8");
    expect(runner).toContain("await Promise.allSettled(inTier.map((t) => t.run()))");
    expect(src, "the pool hands its tiers to that runner").toContain("runTieredRetrieval({");
  });

  /**
   * And the tasks are DEFERRED, which is the mechanism. `tasks.push(searchX(...))` starts the
   * search at push time — a list built that way is already running before anything can decide not
   * to run it, so tiering would have been decoration over eleven searches already in flight.
   */
  it("and a task is not started until its tier is reached", () => {
    const code = codeOnly(src);
    /** The tier is `poolTier("…")` since the integrity audit — see `retrievalInTiers.test.ts`. */
    expect(code).toMatch(/tasks\.push\(\{ tier: poolTier\("[a-z_]+"\), source: "[a-z_]+", run: \(\) =>/);
    expect(code, "a bare push would start the search immediately").not.toMatch(
      /tasks\.push\(\s*search[A-Z]/
    );
  });
});

// ─── FIX C: per-provider latency observability ───────────────────────────────

describe("FIX C — per-provider latency logging", () => {
  it("the [ScenePool] line reports ms per provider, slowest first", () => {
    expect(src).toContain("const msPerProvider: Record<string, number> = {};");
    expect(src).toContain("msPerProvider[source] = ms;");
    expect(src).toContain("` | ms: ${Object.entries(msPerProvider).sort((a, b) => b[1] - a[1])");
  });

  /**
   * RONDE 175 — counted against the tasks themselves, not against a literal.
   *
   * This pinned `9`, "one per provider task", and adding a tenth provider (YouTube) failed it for
   * the one reason that is not a defect: there was a tenth provider. A guard that has to be
   * renumbered every time the thing it guards grows teaches people to renumber it, and the next
   * person renumbers it without checking whether the new task actually carries the field.
   *
   * So it now counts BOTH sides and asserts they match. That is the invariant the name always
   * described — every provider task carries its own elapsed time — and it holds for ten providers
   * or for twenty, while still failing the moment a task is added without the field.
   */
  it("every provider task carries its own elapsed time from one shared start", () => {
    const code = codeOnly(src);
    const decls = code.match(/const liveT0 = Date\.now\(\);/g) ?? [];
    expect(decls, "the shared start must be declared exactly once").toHaveLength(1);

    const tasks = code.match(/tasks\.push\(/g) ?? [];
    const uses = code.match(/ms: Date\.now\(\) - liveT0,/g) ?? [];
    expect(tasks.length, "no provider tasks found — the scan is looking at the wrong thing")
      .toBeGreaterThanOrEqual(6);
    expect(
      uses.length,
      `${tasks.length} provider task(s) but ${uses.length} carry an elapsed time`
    ).toBe(tasks.length);
  });

  it("logging added no await, no retry and no extra request", () => {
    const start = src.indexOf("const liveT0 = Date.now();");
    // RONDE 246: the block now ENDS at the tiered run rather than at a single allSettled. Same
    // block, same guarantee — building the task list still does no work — and now more strictly
    // true, since the list holds thunks that have not been called.
    const end = src.indexOf("const tierReport = await runTieredRetrieval({");
    expect(end, "the tiered run is gone").toBeGreaterThan(start);
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
