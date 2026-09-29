import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildDownloadShortlist,
  pickBestFunnelCandidate,
  STOCK_TIER_WIN_MARGIN,
  type FunnelCandidate,
  type ScoredFunnelCandidate,
} from "./retrievalFunnel";

// RONDE 1, FIX 1 + FIX 2 — cross-beat asset memory on the funnel path.
//
// The funnel result is built once per SCENE and consumed once per BEAT. Both the shortlist
// and the winner selection were deterministic on the same inputs, and nothing recorded what
// an earlier beat had already adopted, so every beat of a scene received the identical
// shortlist and the identical winner. Production render 515: 47-49 candidates per scene
// collapsed to 3 unique downloaded assets and 2 unique winners across 13 beats — 85% reuse —
// while a runner-up was available on every single beat.
//
// FIX 1 makes pickBestFunnelCandidate prefer passers not yet used; FIX 2 makes
// buildDownloadShortlist drop already-used candidates before its (unchanged) sort and caps
// run. Neither changes a score, adds a penalty, or shuffles anything. Both restore the full
// set when everything has been used, so reuse stays available as a last resort.

function cand(id: string, source: FunnelCandidate["source"], rankingScore: number): FunnelCandidate {
  return {
    id,
    source,
    title: id,
    rankingScore,
    embeddingSimilarity: null,
    archiveKeywordScore: null,
    clipSimilarity: null,
  } as unknown as FunnelCandidate;
}

function scored(c: FunnelCandidate, score: number | null, pass = true): ScoredFunnelCandidate {
  return {
    candidate: c,
    clipPath: `/tmp/${c.id.replace(/[^a-z0-9]/gi, "_")}.mp4`,
    visionResult: { pass, worstScore10: score, skipped: false, fromCache: false },
  } as unknown as ScoredFunnelCandidate;
}

const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("wiring + scope", () => {

  it("no score is mutated, no penalty and no randomisation were introduced", () => {
    // No shuffling, no penalty term, and no write to a candidate's score fields. A local
    // `const rankingScore = ...` inside mergeCandidates is the legitimate computation and is
    // deliberately not matched here — only property assignment would be a ranking change.
    // Comments are stripped: the doc block legitimately contains the words "penalty" and
    // "random" while explaining that neither is used.
    const code = funnelSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("Math.random");
    expect(code.toLowerCase()).not.toContain("penalty");
    expect(code).not.toMatch(/\.rankingScore\s*=[^=]/);
    expect(code).not.toMatch(/\.worstScore10\s*=[^=]/);
    expect(code).not.toMatch(/\.visionScore\s*=[^=]/);
  });

});
