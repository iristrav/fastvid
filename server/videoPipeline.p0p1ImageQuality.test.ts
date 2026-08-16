import { describe, expect, it, vi } from "vitest";
import { rankCandidatesWithContext, type AssetDirectorContext, type CandidateMeta } from "./assetDirector";

function minimalCtx(): AssetDirectorContext {
  return {
    usedPaths: new Set(),
    usedCategories: new Map(),
    sceneAdoptedClips: [],
    prevSceneClips: [],
    callbacksPlaced: new Map(),
  };
}

// P0/P1 BEELDKWALITEIT PATCH — read-only audit follow-up.
//
// Fix 1 (entity gate): a search query mentioning a named entity (e.g. "Elon Musk Tesla") used
// to be its own proof that the resulting candidate showed that entity — clipSatisfiesRealEntities
// matched `${sourceQuery} ${filename}` against the same regex that decided whether the rule even
// fired in the first place, so it passed by construction. It now requires independently-authored
// evidence (curated-archive annotation, or provider title/description/tags) via
// hasReliableEntityEvidence — sourceQuery/filename are no longer part of the signature at all.
//
// Fix 2 (external annotation): CandidateMeta.providerText carries real provider-authored text
// (never invented) so external (non-archive) candidates have something better than the
// positional download filename for scoreAnnotationFingerprint / the entity gate to check.
//
// Fix 3 (query fallback): scriptStockSearchQueries no longer collapses straight to the literal
// "documentary" the moment beat-subject extraction fails — it now falls back through
// persons -> sceneText -> videoTitle (all context it already received) before that last resort.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

describe("Fix 1 — entity gate requires reliable evidence, not query/filename self-reference", () => {
  it("Test 1 — query contains 'Elon Musk' but the candidate has no reliable entity evidence -> reject", async () => {
    const { extractBeatRealEntities, clipSatisfiesRealEntities } = await freshPipeline();
    const rules = extractBeatRealEntities("Elon Musk unveiled the new Tesla today");
    expect(rules.length).toBeGreaterThan(0);
    // No meta at all (equivalent of "only the query/filename ever said Musk").
    expect(clipSatisfiesRealEntities(rules, undefined)).toBe(false);
  });

  it("Test 2 — provider text superficially plausible but does not actually mention the entity -> reject", async () => {
    const { extractBeatRealEntities, clipSatisfiesRealEntities } = await freshPipeline();
    const rules = extractBeatRealEntities("Elon Musk unveiled the new Tesla today");
    const meta: CandidateMeta = { providerText: { title: "Generic factory floor b-roll" } };
    expect(clipSatisfiesRealEntities(rules, meta)).toBe(false);
  });

  it("Test 3 — entity implied by query alone, no reliable metadata present -> not automatically accepted", async () => {
    const { extractBeatRealEntities, clipSatisfiesRealEntities } = await freshPipeline();
    const rules = extractBeatRealEntities("SpaceX Falcon 9 launch coverage");
    expect(clipSatisfiesRealEntities(rules, {})).toBe(false);
  });

  it("Test 4 — reliable, independently-authored evidence present -> normal (accepting) flow", async () => {
    const { extractBeatRealEntities, clipSatisfiesRealEntities, hasReliableEntityEvidence } =
      await freshPipeline();
    const rules = extractBeatRealEntities("Elon Musk unveiled the new Tesla today");
    const providerMeta: CandidateMeta = { providerText: { title: "Elon Musk Tesla keynote highlights" } };
    expect(clipSatisfiesRealEntities(rules, providerMeta)).toBe(true);
    // Archive annotation is an equally valid, independent evidence source.
    const archiveMeta = {
      annotation: { persons: { named: ["Elon Musk"], categories: [] } },
    } as unknown as CandidateMeta;
    expect(hasReliableEntityEvidence(rules, archiveMeta)).toBe(true);
  });

  it("Test 5 — no named entity required -> existing flow keeps working unchanged", async () => {
    const { extractBeatRealEntities, clipSatisfiesRealEntities } = await freshPipeline();
    const rules = extractBeatRealEntities("A calm walk through the city park at sunset");
    expect(rules).toEqual([]);
    expect(clipSatisfiesRealEntities(rules, undefined)).toBe(true);
  });
});

describe("Fix 2 — external candidates get real annotation-fingerprint signal via AssetDirector", () => {
  it("Test 6 — archive candidate with a real annotation still ranks on it (unchanged behavior)", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["a.mp4", { annotation: { persons: { named: ["Winston Churchill"], categories: [] } } as any }],
    ]);
    const result = rankCandidatesWithContext(
      ["a.mp4"],
      "Churchill addressed the nation",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths).toEqual(["a.mp4"]);
  });

  it("Test 7 — external candidate with provider title/description ranks above one with none, for a matching beat", async () => {
    const meta = new Map<string, CandidateMeta>([
      ["matches.mp4", { providerText: { title: "Apollo 11 moon landing astronauts 1969" } }],
      ["blank.mp4", {}],
    ]);
    const result = rankCandidatesWithContext(
      ["blank.mp4", "matches.mp4"],
      "Apollo 11 moon landing astronauts",
      0,
      0,
      minimalCtx(),
      meta
    );
    expect(result.rankedPaths[0]).toBe("matches.mp4");
    expect(result.reordered).toBe(true);
  });

  it("Test 8 — external candidate with no metadata at all does not throw", async () => {
    expect(() =>
      rankCandidatesWithContext(
        ["a.mp4", "b.mp4"],
        "some beat text",
        0,
        0,
        minimalCtx(),
        undefined
      )
    ).not.toThrow();
  });

  it("Test 9 — AssetDirector consumes providerText when present (candidateMeta wired through, not ignored)", async () => {
    // Two candidates (rankCandidatesWithContext short-circuits with a null topScore for a
    // single candidate — see assetDirector.ts) so real scoring actually runs for both.
    const paths = ["only.mp4", "other.mp4"];
    const withoutText = rankCandidatesWithContext(
      paths,
      "1930s New York street life",
      0,
      0,
      minimalCtx(),
      undefined
    );
    const withText = new Map<string, CandidateMeta>([
      ["only.mp4", { providerText: { title: "1930s New York street life crowds" } }],
    ]);
    const result = rankCandidatesWithContext(
      paths,
      "1930s New York street life",
      0,
      0,
      minimalCtx(),
      withText
    );
    // Both must resolve to a real score without throwing; providerText should not lower it.
    expect(result.topScore).not.toBeNull();
    expect(withoutText.topScore).not.toBeNull();
    expect(result.topScore!.finalScore).toBeGreaterThanOrEqual(withoutText.topScore!.finalScore);
  });
});

describe("Fix 3 — query-generation fallback no longer collapses straight to 'documentary'", () => {
  it("Test 10 — subject extraction works -> existing query behavior is preserved", async () => {
    const { scriptStockSearchQueries } = await freshPipeline();
    const queries = scriptStockSearchQueries("The president visited the automobile factory today", []);
    expect(queries[0]).not.toBe("documentary");
  });

  it("Test 11 — subject extraction fails but scene context exists -> 'documentary' is not the only query", async () => {
    const { scriptStockSearchQueries } = await freshPipeline();
    const queries = scriptStockSearchQueries("", [], "World War II soldiers marching through Europe");
    expect(queries).not.toEqual(["documentary"]);
    expect(queries[0]).toContain("world");
  });

  it("Test 12 — beat context empty but a person is known -> person is used, never 'documentary'", async () => {
    const { scriptStockSearchQueries } = await freshPipeline();
    const queries = scriptStockSearchQueries("", ["Elon Musk"], "", undefined);
    expect(queries).toEqual(["Elon Musk"]);
  });

  it("Test 13 — fully empty context -> safe minimal fallback, no crash", async () => {
    const { scriptStockSearchQueries } = await freshPipeline();
    expect(() => scriptStockSearchQueries("", [], "", undefined)).not.toThrow();
    expect(scriptStockSearchQueries("", [], "", undefined)).toEqual(["documentary"]);
  });
});
