/**
 * AN ALTERNATIVE YOUTUBE SEARCH RUNS UNDER A PROOF — RONDE 647.
 *
 * Production, 2026-09-24 07:53:
 *
 *   [SearchQueryAudit] provider=youtube_cc route=searchYoutubeVideoCandidates
 *     query="Hitler documentary footage archive footage…" status=BLOCKED reason=LEGACY_QUERY_BUILDER
 *   [YouTubePrefetch] ALTERNATIVES for=ffQvjROypp0 reason=BAKED_EDIT_TEXT … found=0
 *
 * The background has no beat, so no provenance scope was open and the strict gate refused every
 * alternative: RONDE 645's feature never searched once. The proof now is the render's own query,
 * which that render's gate had already verified. The gate itself is unchanged, and still refuses
 * a word the original query did not prove.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { searchGateDecision, withSearchProvenance } from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { alternativeQueries, queueAlternativesFor } from "./youtubePrefetch";

const base = "Hitler documentary footage";
let strict: string | undefined;

beforeEach(() => {
  strict = process.env.SEARCH_GATE_STRICT;
  process.env.SEARCH_GATE_STRICT = "true";
});
afterEach(() => {
  if (strict === undefined) delete process.env.SEARCH_GATE_STRICT;
  else process.env.SEARCH_GATE_STRICT = strict;
});

describe("the real gate, with and without the render's proof", () => {
  it("WITHOUT a scope the alternative is blocked — the production failure", () => {
    for (const alt of alternativeQueries(base)) {
      expect(searchGateDecision("youtube_cc", alt, "searchYoutubeVideoCandidates").admitted).toBe(false);
    }
  });

  it("UNDER the original query's proof, both alternatives are admitted", () => {
    const ctx = buildVerifiedQueryContextForBeat(base, { sceneText: base });
    for (const alt of alternativeQueries(base)) {
      const decision = withSearchProvenance(ctx, () =>
        searchGateDecision("youtube_cc", alt, "searchYoutubeVideoCandidates")
      );
      expect(decision.admitted, alt).toBe(true);
    }
  });

  it("and the proof admits nothing the original query did not say", () => {
    const ctx = buildVerifiedQueryContextForBeat(base, { sceneText: base });
    const decision = withSearchProvenance(ctx, () =>
      searchGateDecision("youtube_cc", "Hitler Mussolini archive footage", "searchYoutubeVideoCandidates")
    );
    expect(decision.admitted).toBe(false);
  });
});

describe("the prefetcher hands its search the evidence", () => {
  it("the render's query travels with every alternative search", async () => {
    const seen: string[] = [];
    await queueAlternativesFor(
      { videoId: "ffQvjROypp0", query: base, licenseMode: null },
      {
        claim: async () => true,
        search: async (_q, _m, _w, evidence) => {
          seen.push(evidence);
          return [];
        },
        enqueue: () => {},
        takeDailySlot: () => true,
        log: () => {},
      }
    );
    expect(seen).toEqual([base]);
  });

  it("the production search opens the scope around the call", () => {
    const SRC = readFileSync(join(__dirname, "youtubePrefetch.ts"), "utf8");
    expect(SRC).toContain("const ctx = pipeline.buildVerifiedQueryContextForBeat(evidence, { sceneText: evidence });");
    expect(SRC).toContain("await withSearchProvenance(ctx, () =>");
  });
});
