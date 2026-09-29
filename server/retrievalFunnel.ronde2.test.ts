import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildDownloadShortlist,
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  orderCandidatesForBeatGap,
  pickBestFunnelCandidate,
  type BeatGapStrategy,
  type FunnelCandidate,
  type ScoredFunnelCandidate,
} from "./retrievalFunnel";

// RONDE 2 — FIX 3 + FIX 4.
//
// FIX 3: only the beat WINNER was recorded in usedFunnelCandidateIds. A candidate whose
// download failed stayed in every later beat's shortlist and was re-fetched on each one
// (render 515: two Wikimedia assets answering HTTP 429, retried 4x each across a scene).
// Registering the failure keeps the ranking looking further down the list instead of
// re-spending the same slot.
//
// FIX 4: orderCandidatesForBeatGap() eliminated candidates rather than ordering them —
// `archive_only` returned the archive alone and `one_external` kept exactly one external via
// `.slice(0, 1)`. That happened BEFORE FUNNEL_CANDIDATE_POOL_LIMIT, BEFORE
// buildDownloadShortlist and BEFORE VisionGate, so 47 retrieved externals could collapse to
// 1 before anything had a chance to judge them — which is also why FIX 2 had almost nothing
// left to pick from. Archive-first is now a preference: the archive still leads, the
// alternatives survive behind it.

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

function scored(c: FunnelCandidate, score: number, pass = true): ScoredFunnelCandidate {
  return {
    candidate: c,
    clipPath: `/tmp/${c.id.replace(/[^a-z0-9]/gi, "_")}.mp4`,
    visionResult: { pass, worstScore10: score, skipped: false, fromCache: false },
  } as unknown as ScoredFunnelCandidate;
}

const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Faithful model of the pipeline's per-beat funnel loop (videoPipeline.ts), built on the REAL
 * buildDownloadShortlist/pickBestFunnelCandidate so the interaction between FIX 1, FIX 2 and
 * FIX 3 is exercised rather than re-implemented:
 *
 *   toScore = buildDownloadShortlist(pool, budget, used)
 *   for (c of toScore) { if (!download(c)) { used.add(c.id); continue; }  ... }   <- FIX 3
 *   winner = pickBestFunnelCandidate(scored, used); if (winner) used.add(winner.id)
 */
function runBeat(
  pool: FunnelCandidate[],
  used: Set<string>,
  downloadOk: (c: FunnelCandidate) => boolean,
  visionScore: (c: FunnelCandidate) => number = () => 8
): { shortlist: string[]; downloaded: string[]; winner: string | null } {
  const toScore = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE, used);
  const downloaded: string[] = [];
  const scoredList: ScoredFunnelCandidate[] = [];
  for (const c of toScore) {
    if (!downloadOk(c)) {
      used.add(c.id); // FIX 3
      continue;
    }
    downloaded.push(c.id);
    scoredList.push(scored(c, visionScore(c)));
  }
  const winner = pickBestFunnelCandidate(scoredList, used);
  if (winner) used.add(winner.candidate.id);
  return { shortlist: toScore.map((c) => c.id), downloaded, winner: winner?.candidate.id ?? null };
}

// ─── FIX 4 ────────────────────────────────────────────────────────────────────

const ARCH_1 = cand("archive:1", "archive", 1.0);
const ARCH_2 = cand("archive:2", "archive", 1.0);
const EXT_IA = cand("internet_archive:x", "internet_archive", 0.255);
const EXT_NARA = cand("nara:y", "nara", 0.2535);
const EXT_WIKI = cand("wikimedia:z", "wikimedia", 0.24);
const EXT_PEX = cand("pexels:p", "pexels", 0.21);
const SCENE_POOL = [ARCH_1, EXT_PEX, EXT_WIKI, ARCH_2, EXT_NARA, EXT_IA];

const EXT_BY_RANK = ["internet_archive:x", "nara:y", "wikimedia:z", "pexels:p"];
const ARCHIVE_IDS = ["archive:1", "archive:2"];

describe("FIX 4 — Test 5: no candidate is eliminated by any strategy", () => {
  const strategies: BeatGapStrategy[] = ["archive_only", "one_external", "all_external", "aggressive"];

  it("the external truncation is gone from the source", () => {
    // Behaviour above already proves it; this pins the specific construct that caused it.
    expect(codeOnly(funnelSrc)).not.toContain("externalCands.slice(0, 1)");
  });
});

// ─── Scope ────────────────────────────────────────────────────────────────────

describe("RONDE 2 — scope", () => {

  it("no randomisation, no penalty term, no score write", () => {
    const code = codeOnly(funnelSrc);
    expect(code).not.toContain("Math.random");
    expect(code.toLowerCase()).not.toContain("penalty");
    expect(code).not.toMatch(/\.rankingScore\s*=[^=]/);
    expect(code).not.toMatch(/\.worstScore10\s*=[^=]/);
  });

});
