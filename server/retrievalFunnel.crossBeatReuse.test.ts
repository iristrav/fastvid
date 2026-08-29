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

describe("FIX 1 — Test 1: the winner is not chosen again on the next beat", () => {
  it("beat 1 picks A, beat 2 picks B even though A still scores highest", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const C = cand("loc:C", "loc", 0.7);
    const used = new Set<string>();

    const beat1 = pickBestFunnelCandidate([scored(A, 10), scored(B, 9)], used);
    expect(beat1?.candidate.id).toBe("loc:A");
    used.add(beat1!.candidate.id);

    const beat2 = pickBestFunnelCandidate([scored(A, 10), scored(B, 9), scored(C, 8)], used);
    expect(beat2?.candidate.id).toBe("loc:B");
  });

  it("without a used-set the pre-fix behaviour is byte-for-byte unchanged", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const list = [scored(A, 10), scored(B, 9)];
    expect(pickBestFunnelCandidate(list)?.candidate.id).toBe("loc:A");
    expect(pickBestFunnelCandidate(list, new Set())?.candidate.id).toBe("loc:A");
  });
});

describe("FIX 1 — Test 2: several used candidates in sequence", () => {
  it("three beats yield three different assets", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const C = cand("loc:C", "loc", 0.7);
    const all = [scored(A, 10), scored(B, 9), scored(C, 8)];
    const used = new Set<string>();
    const picks: string[] = [];

    for (let beat = 0; beat < 3; beat++) {
      const w = pickBestFunnelCandidate(all, used);
      expect(w).not.toBeNull();
      picks.push(w!.candidate.id);
      used.add(w!.candidate.id);
    }
    expect(picks).toEqual(["loc:A", "loc:B", "loc:C"]);
    expect(new Set(picks).size).toBe(3);
  });
});

describe("FIX 1 — Test 3: the runner-up is used when the winner is taken", () => {
  it("A used, B available -> B wins", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const w = pickBestFunnelCandidate([scored(A, 10), scored(B, 9)], new Set(["loc:A"]));
    expect(w?.candidate.id).toBe("loc:B");
  });

  it("the best UNUSED passer wins, not blindly the runner-up by score order", () => {
    // A (10) and B (9) are both used; C (8) is the runner-up of the runner-up. Picking
    // "the runner-up" naively would return B — a used asset. The best unused must win.
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const C = cand("loc:C", "loc", 0.7);
    const D = cand("loc:D", "loc", 0.6);
    const w = pickBestFunnelCandidate(
      [scored(A, 10), scored(B, 9), scored(C, 8), scored(D, 7)],
      new Set(["loc:A", "loc:B"])
    );
    expect(w?.candidate.id).toBe("loc:C");
  });

  it("a used candidate that FAILED VisionGate does not shield an unused failing one", () => {
    // Only passers are ever eligible — the used-set never promotes a reject.
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const w = pickBestFunnelCandidate([scored(A, 10), scored(B, 9, false)], new Set(["loc:A"]));
    expect(w?.candidate.id).toBe("loc:A"); // B failed; exhaustion restores A
  });
});

describe("FIX 1 — Test 4: exhaustion never loses a beat", () => {
  it("all passers used -> still returns a winner (reuse), never null", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const w = pickBestFunnelCandidate(
      [scored(A, 10), scored(B, 9)],
      new Set(["loc:A", "loc:B"])
    );
    expect(w).not.toBeNull();
    expect(w?.candidate.id).toBe("loc:A"); // best of the full set, exactly as before
  });

  it("on exhaustion the winner equals what the pre-fix code would have picked", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const list = [scored(A, 10), scored(B, 9)];
    const exhausted = pickBestFunnelCandidate(list, new Set(["loc:A", "loc:B"]));
    expect(exhausted?.candidate.id).toBe(pickBestFunnelCandidate(list)?.candidate.id);
  });

  it("no passers at all still returns null — unchanged", () => {
    const A = cand("loc:A", "loc", 0.9);
    expect(pickBestFunnelCandidate([scored(A, 10, false)], new Set())).toBeNull();
    expect(pickBestFunnelCandidate([], new Set(["loc:A"]))).toBeNull();
  });
});

describe("FIX 1 — the stock/non-stock rule is applied to the remaining set, unchanged", () => {
  it("stock still needs STOCK_TIER_WIN_MARGIN over the best unused non-stock", () => {
    expect(STOCK_TIER_WIN_MARGIN).toBe(1.0);
    const locA = cand("loc:A", "loc", 0.9);
    const locB = cand("loc:B", "loc", 0.8);
    const pex = cand("pexels:1", "pexels", 0.5);
    // locA used. Remaining: locB (8) and pexels (9). 9 >= 8 + 1.0 -> stock wins.
    const w1 = pickBestFunnelCandidate(
      [scored(locA, 10), scored(locB, 8), scored(pex, 9)],
      new Set(["loc:A"])
    );
    expect(w1?.candidate.id).toBe("pexels:1");
    // Same shape but pexels at 8: 8 < 8 + 1.0 -> non-stock keeps it.
    const w2 = pickBestFunnelCandidate(
      [scored(locA, 10), scored(locB, 8), scored(cand("pexels:2", "pexels", 0.5), 8)],
      new Set(["loc:A"])
    );
    expect(w2?.candidate.id).toBe("loc:B");
  });
});

describe("FIX 2 — Test 5: shortlist excludes already-used assets", () => {
  it("with A and B used, the shortlist starts at C and D", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const C = cand("loc:C", "loc", 0.7);
    const D = cand("loc:D", "loc", 0.6);
    const out = buildDownloadShortlist([A, B, C, D], 6, new Set(["loc:A", "loc:B"]));
    expect(out.map((c) => c.id)).toEqual(["loc:C", "loc:D"]);
  });

  it("the existing per-source caps still apply to the reduced set", () => {
    // Non-stock cap is 2 per source, stock cap 1 — unchanged by the exclusion.
    const used = new Set(["loc:A"]);
    const out = buildDownloadShortlist(
      [
        cand("loc:A", "loc", 0.99),
        cand("loc:B", "loc", 0.9),
        cand("loc:C", "loc", 0.8),
        cand("loc:D", "loc", 0.7),
        cand("pexels:1", "pexels", 0.6),
        cand("pexels:2", "pexels", 0.5),
      ],
      6,
      used
    );
    expect(out.filter((c) => c.source === "loc")).toHaveLength(2);
    expect(out.filter((c) => c.source === "pexels")).toHaveLength(1);
    expect(out.map((c) => c.id)).toEqual(["loc:B", "loc:C", "pexels:1"]);
  });

  it("ranking order inside the reduced set is untouched (still rankingScore desc)", () => {
    const out = buildDownloadShortlist(
      [
        cand("nasa:X", "nasa", 0.4),
        cand("loc:A", "loc", 0.9),
        cand("nara:Y", "nara", 0.7),
      ],
      6,
      new Set(["loc:A"])
    );
    expect(out.map((c) => c.id)).toEqual(["nara:Y", "nasa:X"]);
  });

  it("exhaustion: everything used -> the full list comes back, no empty shortlist", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const out = buildDownloadShortlist([A, B], 6, new Set(["loc:A", "loc:B"]));
    expect(out.map((c) => c.id)).toEqual(["loc:A", "loc:B"]);
    expect(out).toHaveLength(2);
  });

  it("an empty or absent used-set reproduces the pre-fix shortlist exactly", () => {
    const list = [
      cand("loc:A", "loc", 0.9),
      cand("loc:B", "loc", 0.8),
      cand("pexels:1", "pexels", 0.7),
    ];
    const before = buildDownloadShortlist(list, 6).map((c) => c.id);
    expect(buildDownloadShortlist(list, 6, new Set()).map((c) => c.id)).toEqual(before);
    expect(buildDownloadShortlist(list, 6, undefined).map((c) => c.id)).toEqual(before);
  });

  it("budget 0 and an empty candidate list still return [] — unchanged guards", () => {
    expect(buildDownloadShortlist([cand("loc:A", "loc", 1)], 0, new Set())).toEqual([]);
    expect(buildDownloadShortlist([], 6, new Set(["loc:A"]))).toEqual([]);
  });
});

describe("Test 6 — a single beat behaves exactly as before", () => {
  it("first beat of a render (empty used-set) is identical on both functions", () => {
    const list = [
      cand("loc:A", "loc", 0.9),
      cand("wikimedia:W", "wikimedia", 0.85),
      cand("pexels:1", "pexels", 0.8),
    ];
    expect(buildDownloadShortlist(list, 6, new Set()).map((c) => c.id)).toEqual(
      buildDownloadShortlist(list, 6).map((c) => c.id)
    );
    const s = [scored(list[0]!, 9), scored(list[1]!, 8), scored(list[2]!, 10)];
    expect(pickBestFunnelCandidate(s, new Set())?.candidate.id).toBe(
      pickBestFunnelCandidate(s)?.candidate.id
    );
  });
});

describe("wiring + scope", () => {
  it("the pipeline passes usedFunnelCandidateIds to both functions and registers the winner", () => {
    expect(pipelineSrc).toContain("usedFunnelCandidateIds: Set<string>;");
    expect(pipelineSrc).toContain("usedFunnelCandidateIds: new Set(),");
    expect(pipelineSrc).toMatch(
      /buildDownloadShortlist\(\s*funnelCandidates,\s*MAX_FUNNEL_CANDIDATES_TO_SCORE,\s*dedup\.usedFunnelCandidateIds\s*\)/
    );
    expect(pipelineSrc).toMatch(
      // RONDE 61 added a third argument (the gate's refusal set); the used-set is still passed.
      /pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds[,)]/
    );
    expect(pipelineSrc).toContain("dedup.usedFunnelCandidateIds.add(candidate.id);");
  });

  it("ranking constants and caps are untouched", () => {
    expect(funnelSrc).toContain("export const STOCK_TIER_WIN_MARGIN = 1.0;");
    expect(funnelSrc).toContain("const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;");
    expect(funnelSrc).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
    /**
     * RONDE 163 gave the curated archive its own cap. The two constants above are unchanged —
     * every other source is still capped exactly as before — and the point of this guard, that
     * the caps are stated as constants rather than scattered as literals, still holds.
     */
    expect(funnelSrc).toContain("const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;");
    expect(funnelSrc).toContain("export const FUNNEL_CANDIDATE_POOL_LIMIT = 15;");
    expect(funnelSrc).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    expect(funnelSrc).toContain("internet_archive: 0.15,");
    expect(funnelSrc).toContain("wikimedia: 0.10,");
    expect(funnelSrc).toContain("pexels: 0,");
    // The sort is still the original one — relevance decides who fills the slots.
    expect(funnelSrc).toContain("const sorted = [...pool].sort((a, b) => b.rankingScore - a.rankingScore);");
    /**
     * The cap loop still consults capFor and still skips a candidate whose source is full. RONDE
     * 163 counts the skip on the way past so a log can say where candidates were lost, which is
     * why the statement is no longer a one-liner. The rule it enforces is identical.
     */
    expect(funnelSrc).toContain("if (used >= capFor(c.source)) {");
    expect(funnelSrc).toContain("cutByCap++;");
  });

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

  it("the preceding fixes are still in place", () => {
    // FASE 7.2 queryEmb slot, FASE 7.1 abort merge, STAP 1 download logging.
    expect(pipelineSrc).toContain("queryEmbeddingSource=resolved-by-vision-gate");
    expect(pipelineSrc).toContain("AbortSignal.any([controller.signal, scopeSignal])");
    expect(pipelineSrc).toContain("[FunnelDownload] rejected source=");
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MIN_SIM = visionThreshold\("MODERN_EVIDENCE_MIN_SIM", 0\.235\)/);
  });
});
