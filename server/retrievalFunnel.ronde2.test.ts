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

// ─── FIX 3 ────────────────────────────────────────────────────────────────────

describe("FIX 3 — Test 1: a failed download is registered", () => {
  it("the candidate whose download fails lands in the used-set", () => {
    const bad = cand("wikimedia:429", "wikimedia", 0.9);
    const good = cand("loc:A", "loc", 0.8);
    const used = new Set<string>();

    runBeat([bad, good], used, (c) => c.id !== "wikimedia:429");

    expect(used.has("wikimedia:429")).toBe(true);
  });

  it("it is registered under exactly the id FIX 1 + FIX 2 key on", () => {
    // Same Set, same id space — a failure and a win are interchangeable as exclusion keys.
    const bad = cand("wikimedia:429", "wikimedia", 0.9);
    const used = new Set<string>();
    runBeat([bad, cand("loc:A", "loc", 0.8)], used, (c) => c.id !== "wikimedia:429");
    // buildDownloadShortlist honours it on the next beat, which only works on an id match.
    expect(buildDownloadShortlist([bad, cand("loc:B", "loc", 0.1)], 6, used).map((c) => c.id))
      .toEqual(["loc:B"]);
  });
});

describe("FIX 3 — Test 2: a failed candidate is not offered again on the next beat", () => {
  it("beat 2's shortlist skips the failing asset and reaches further down the ranking", () => {
    const bad = cand("wikimedia:429", "wikimedia", 0.99);
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const C = cand("loc:C", "loc", 0.7);
    const pool = [bad, A, B, C];
    const used = new Set<string>();
    const failing = (c: FunnelCandidate) => c.id !== "wikimedia:429";

    const beat1 = runBeat(pool, used, failing);
    expect(beat1.shortlist).toContain("wikimedia:429");
    expect(beat1.downloaded).not.toContain("wikimedia:429");

    const beat2 = runBeat(pool, used, failing);
    expect(beat2.shortlist).not.toContain("wikimedia:429");
    const beat3 = runBeat(pool, used, failing);
    expect(beat3.shortlist).not.toContain("wikimedia:429");
  });

  it("without FIX 3 the same asset would be re-attempted every beat (contrast)", () => {
    // Same pool, but the failure is NOT registered — the pre-fix behaviour. The pool is large
    // enough that four beats do not exhaust it, so the only thing keeping the failing asset
    // out of a later shortlist is the registration itself.
    const bad = cand("wikimedia:429", "wikimedia", 0.99);
    const pool = [
      bad,
      cand("nara:a", "nara", 0.9),
      cand("nara:b", "nara", 0.85),
      cand("nasa:c", "nasa", 0.8),
      cand("nasa:d", "nasa", 0.75),
      cand("loc:e", "loc", 0.7),
      cand("loc:f", "loc", 0.65),
    ];
    const used = new Set<string>();
    let attempts = 0;
    for (let beat = 0; beat < 4; beat++) {
      const toScore = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE, used);
      const list: ScoredFunnelCandidate[] = [];
      for (const c of toScore) {
        if (c.id === "wikimedia:429") { attempts++; continue; } // no registration
        list.push(scored(c, 8));
      }
      const w = pickBestFunnelCandidate(list, used);
      if (w) used.add(w.candidate.id);
    }
    expect(attempts).toBe(4); // exactly the render-515 symptom

    // With FIX 3 the same four beats attempt it once.
    const used2 = new Set<string>();
    let attempts2 = 0;
    for (let beat = 0; beat < 4; beat++) {
      runBeat(pool, used2, (c) => {
        if (c.id === "wikimedia:429") { attempts2++; return false; }
        return true;
      });
    }
    expect(attempts2).toBe(1);
  });

  it("once the pool IS exhausted the failing asset becomes eligible again (no permanent ban)", () => {
    // Deliberate consequence of the unchanged exhaustion rule: a failure is a skip, not a
    // blacklist, so a transient failure can never permanently remove a candidate.
    const bad = cand("wikimedia:429", "wikimedia", 0.99);
    const pool = [bad, cand("loc:A", "loc", 0.9), cand("loc:B", "loc", 0.8)];
    const used = new Set<string>();
    const shortlists: string[][] = [];
    for (let beat = 0; beat < 4; beat++) {
      shortlists.push(runBeat(pool, used, (c) => c.id !== "wikimedia:429").shortlist);
    }
    expect(shortlists[0]).toContain("wikimedia:429"); // first attempt
    expect(shortlists[1]).not.toContain("wikimedia:429"); // excluded while alternatives remain
    expect(shortlists[2]).toContain("wikimedia:429"); // pool exhausted -> full list restored
  });
});

describe("FIX 3 — Test 3: a successful candidate keeps working normally", () => {
  it("a beat with only downloadable candidates behaves exactly as before the fix", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const used = new Set<string>();
    const beat1 = runBeat([A, B], used, () => true, (c) => (c.id === "loc:A" ? 10 : 9));
    expect(beat1.winner).toBe("loc:A");
    expect(beat1.downloaded).toEqual(["loc:A", "loc:B"]);
    // FIX 1 still moves the next beat on to the runner-up.
    const beat2 = runBeat([A, B], used, () => true, (c) => (c.id === "loc:A" ? 10 : 9));
    expect(beat2.winner).toBe("loc:B");
  });

  it("a mixed beat still adopts the downloadable candidate, not null", () => {
    const bad = cand("wikimedia:429", "wikimedia", 0.99);
    const good = cand("loc:A", "loc", 0.5);
    const used = new Set<string>();
    const beat = runBeat([bad, good], used, (c) => c.id !== "wikimedia:429");
    expect(beat.winner).toBe("loc:A");
  });
});

describe("FIX 3 — Test 4: exhaustion safety stays intact", () => {
  it("when every candidate has failed the shortlist comes back full, not empty", () => {
    const A = cand("loc:A", "loc", 0.9);
    const B = cand("loc:B", "loc", 0.8);
    const used = new Set<string>();
    const beat1 = runBeat([A, B], used, () => false);
    expect(beat1.winner).toBeNull(); // nothing downloaded -> existing fallback ladder takes over
    expect(used.size).toBe(2);

    // The exclusion never starves a later beat: the full list is restored.
    const beat2 = runBeat([A, B], used, () => true, () => 8);
    expect(beat2.shortlist).toEqual(["loc:A", "loc:B"]);
    expect(beat2.winner).not.toBeNull();
  });

  it("a transient failure does not permanently blacklist an asset", () => {
    // The candidate becomes downloadable again; once everything is used, exhaustion restores
    // it and it can still be adopted. FIX 3 skips, it does not ban.
    const A = cand("loc:A", "loc", 0.9);
    const used = new Set<string>(["loc:A"]);
    const beat = runBeat([A], used, () => true);
    expect(beat.shortlist).toEqual(["loc:A"]);
    expect(beat.winner).toBe("loc:A");
  });
});

describe("FIX 3 — Test 5: registration alone never causes a fallback", () => {
  it("as long as one candidate downloads, a beat still produces a winner", () => {
    // 5 of 6 shortlist slots fail; the survivor must still win.
    const pool = [
      cand("wikimedia:1", "wikimedia", 0.99),
      cand("wikimedia:2", "wikimedia", 0.98),
      cand("nara:1", "nara", 0.97),
      cand("nara:2", "nara", 0.96),
      cand("nasa:1", "nasa", 0.95),
      cand("loc:A", "loc", 0.10),
    ];
    const used = new Set<string>();
    const beat = runBeat(pool, used, (c) => c.id === "loc:A");
    expect(beat.winner).toBe("loc:A");
  });

  it("across a whole scene, failures increase asset variety instead of reducing it", () => {
    const pool = [
      cand("wikimedia:429", "wikimedia", 0.99),
      cand("loc:A", "loc", 0.9),
      cand("loc:B", "loc", 0.8),
      cand("nara:C", "nara", 0.7),
    ];
    const used = new Set<string>();
    const winners: (string | null)[] = [];
    for (let beat = 0; beat < 3; beat++) {
      winners.push(runBeat(pool, used, (c) => c.id !== "wikimedia:429").winner);
    }
    expect(winners).toEqual(["loc:A", "loc:B", "nara:C"]);
    expect(new Set(winners).size).toBe(3);
  });
});

describe("FIX 3 — wiring at the single call site", () => {
  it("the failed-download branch registers before it continues", () => {
    // The loop body lives inline in a very large function; there is no exported unit to call.
    // RONDE 5 batched the downloads (FIX 6); the failure branch now lives in the batch-apply
    // loop. Anchor on the batch loop start — the registration+continue shape is unchanged.
    const idx = pipelineSrc.indexOf("for (let dlIdx = 0; dlIdx < toScore.length;");
    expect(idx).toBeGreaterThan(-1);
    const branch = codeOnly(pipelineSrc.slice(idx, idx + 3200));
    expect(branch).toMatch(
      /if \(!clipPath\) \{[\s\S]{0,200}dedup\.usedFunnelCandidateIds\.add\(candidate\.id\);[\s\S]{0,80}continue;[\s\S]{0,20}\}/
    );
    // Still no retry/backoff introduced on this path.
    expect(branch).not.toMatch(/\bretry\b|\bbackoff\b|setTimeout|sleep\(/i);
  });

  it("the winner registration from FIX 1 is still there too", () => {
    /**
     * Counts BOTH forms of the registration. RONDE 132 replaced the winner's bare
     * `usedFunnelCandidateIds.add(candidate.id)` with `markAssetUsedInVideo`, which writes that
     * same Set plus the archive-asset, storage-url and provider identities the funnel never
     * recorded. The invariant this test guards — the winner is registered, so later beats cannot
     * repeat it — is unchanged; only the call that does it moved.
     */
    const src = codeOnly(pipelineSrc);
    const direct = src.match(/dedup\.usedFunnelCandidateIds\.add\(candidate\.id\);/g) ?? [];
    const viaRegistry = src.match(/funnelCandidateId: candidate\.id,/g) ?? [];
    expect(direct.length + viaRegistry.length).toBe(2); // failed download + winner
    expect(viaRegistry).toHaveLength(1);
    expect(pipelineSrc).toMatch(/pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds[,)]/);
  });

  it("downloadedCount still counts only real downloads", () => {
    const idx = pipelineSrc.indexOf("for (let dlIdx = 0; dlIdx < toScore.length;");
    const branch = pipelineSrc.slice(idx, idx + 3400);
    const addIdx = branch.indexOf("dedup.usedFunnelCandidateIds.add(candidate.id);");
    const countIdx = branch.indexOf("downloadedCount++;");
    expect(addIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(addIdx); // the increment stays on the success path
  });
});

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

describe("FIX 4 — Tests 1 & 2: all_external and aggressive are unchanged", () => {
  it("all_external is byte-for-byte the previous result", () => {
    expect(orderCandidatesForBeatGap(SCENE_POOL, "all_external").map((c) => c.id)).toEqual([
      ...ARCHIVE_IDS,
      ...EXT_BY_RANK,
    ]);
  });

  it("aggressive is byte-for-byte the previous result (externals lead)", () => {
    expect(orderCandidatesForBeatGap(SCENE_POOL, "aggressive").map((c) => c.id)).toEqual([
      ...EXT_BY_RANK,
      ...ARCHIVE_IDS,
    ]);
  });
});

describe("FIX 4 — Test 3: archive_only keeps external candidates available", () => {
  it("archive leads but the externals are still there", () => {
    const out = orderCandidatesForBeatGap(SCENE_POOL, "archive_only").map((c) => c.id);
    expect(out.slice(0, 2)).toEqual(ARCHIVE_IDS);
    expect(out).toEqual([...ARCHIVE_IDS, ...EXT_BY_RANK]);
    expect(out).toHaveLength(SCENE_POOL.length);
  });
});

describe("FIX 4 — Test 4: one_external keeps ALL relevant external candidates", () => {
  it("all four externals survive, not one", () => {
    const out = orderCandidatesForBeatGap(SCENE_POOL, "one_external").map((c) => c.id);
    expect(out.filter((id) => !id.startsWith("archive:"))).toEqual(EXT_BY_RANK);
    expect(out.slice(0, 2)).toEqual(ARCHIVE_IDS);
  });

  it("the render-515 shape — 2 archive + 47 externals — no longer collapses to 3", () => {
    const pool = [
      ARCH_1,
      ARCH_2,
      ...Array.from({ length: 47 }, (_, i) => cand(`nara:${i}`, "nara", 0.25 - i * 0.001)),
    ];
    expect(orderCandidatesForBeatGap(pool, "one_external")).toHaveLength(49);
    expect(orderCandidatesForBeatGap(pool, "archive_only")).toHaveLength(49);
  });
});

describe("FIX 4 — Test 5: no candidate is eliminated by any strategy", () => {
  const strategies: BeatGapStrategy[] = ["archive_only", "one_external", "all_external", "aggressive"];

  it("every strategy returns the full candidate set, only reordered", () => {
    for (const s of strategies) {
      const out = orderCandidatesForBeatGap(SCENE_POOL, s);
      expect(out, `${s} must not drop candidates`).toHaveLength(SCENE_POOL.length);
      expect(new Set(out.map((c) => c.id))).toEqual(new Set(SCENE_POOL.map((c) => c.id)));
    }
  });

  it("the external truncation is gone from the source", () => {
    // Behaviour above already proves it; this pins the specific construct that caused it.
    expect(codeOnly(funnelSrc)).not.toContain("externalCands.slice(0, 1)");
  });
});

describe("FIX 4 — Test 6: existing ordering and ranking are otherwise intact", () => {
  it("externals stay sorted by rankingScore descending in every strategy", () => {
    for (const s of ["archive_only", "one_external", "all_external", "aggressive"] as BeatGapStrategy[]) {
      const ext = orderCandidatesForBeatGap(SCENE_POOL, s).filter((c) => c.source !== "archive");
      expect(ext.map((c) => c.id), s).toEqual(EXT_BY_RANK);
    }
  });

  it("archive candidates keep their input order (no re-sort, no shuffle)", () => {
    const out = orderCandidatesForBeatGap(SCENE_POOL, "one_external").filter((c) => c.source === "archive");
    expect(out.map((c) => c.id)).toEqual(ARCHIVE_IDS);
  });

  it("no rankingScore is mutated by the ordering", () => {
    const before = SCENE_POOL.map((c) => c.rankingScore);
    for (const s of ["archive_only", "one_external", "all_external", "aggressive"] as BeatGapStrategy[]) {
      orderCandidatesForBeatGap(SCENE_POOL, s);
    }
    expect(SCENE_POOL.map((c) => c.rankingScore)).toEqual(before);
  });
});

describe("FIX 4 — Tests 7 & 8: empty pools", () => {
  it("an empty archive pool returns the externals for every strategy", () => {
    const onlyExt = [EXT_IA, EXT_PEX];
    expect(orderCandidatesForBeatGap(onlyExt, "archive_only").map((c) => c.id)).toEqual([
      "internet_archive:x",
      "pexels:p",
    ]);
    expect(orderCandidatesForBeatGap(onlyExt, "one_external").map((c) => c.id)).toEqual([
      "internet_archive:x",
      "pexels:p",
    ]);
    expect(orderCandidatesForBeatGap(onlyExt, "aggressive").map((c) => c.id)).toEqual([
      "internet_archive:x",
      "pexels:p",
    ]);
  });

  it("an empty external pool returns the archive candidates for every strategy", () => {
    const onlyArch = [ARCH_1, ARCH_2];
    for (const s of ["archive_only", "one_external", "all_external", "aggressive"] as BeatGapStrategy[]) {
      expect(orderCandidatesForBeatGap(onlyArch, s).map((c) => c.id), s).toEqual(ARCHIVE_IDS);
    }
  });

  it("a completely empty pool returns []", () => {
    for (const s of ["archive_only", "one_external", "all_external", "aggressive"] as BeatGapStrategy[]) {
      expect(orderCandidatesForBeatGap([], s), s).toEqual([]);
    }
  });
});

describe("FIX 4 — Test 9: the downstream source caps still apply unchanged", () => {
  it("buildDownloadShortlist enforces 2 per non-stock source and 1 per stock source on the ordered list", () => {
    const pool = [
      ARCH_1,
      ARCH_2,
      cand("archive:3", "archive", 1.0),
      cand("nara:a", "nara", 0.25),
      cand("nara:b", "nara", 0.24),
      cand("nara:c", "nara", 0.23),
      cand("pexels:1", "pexels", 0.21),
      cand("pexels:2", "pexels", 0.21),
    ];
    const ordered = orderCandidatesForBeatGap(pool, "one_external");
    const shortlist = buildDownloadShortlist(ordered, MAX_FUNNEL_CANDIDATES_TO_SCORE, new Set());
    /**
     * RONDE 163: the archive's cap is 3, every other source's is unchanged — 2 for historical/open
     * sources, 1 for stock. That is what this test verifies and it still verifies it; only the
     * archive's own number moved, on the evidence that render 553 offered a beat 2 of the 25
     * archive candidates it had found.
     */
    expect(shortlist.filter((c) => c.source === "archive")).toHaveLength(3);
    expect(shortlist.filter((c) => c.source === "nara")).toHaveLength(2);
    expect(shortlist.filter((c) => c.source === "pexels")).toHaveLength(1);
    expect(shortlist.length).toBeLessThanOrEqual(MAX_FUNNEL_CANDIDATES_TO_SCORE);
  });
});

describe("FIX 4 — Test 10: FIX 1 + FIX 2 now have something to work with", () => {
  it("under one_external, five beats yield five different assets instead of repeating", () => {
    const pool = [
      ARCH_1,
      ARCH_2,
      cand("nara:a", "nara", 0.25),
      cand("nara:b", "nara", 0.24),
      cand("nasa:c", "nasa", 0.23),
      cand("loc:d", "loc", 0.22),
    ];
    const ordered = orderCandidatesForBeatGap(pool, "one_external");
    const used = new Set<string>();
    const winners: (string | null)[] = [];
    for (let beat = 0; beat < 5; beat++) {
      winners.push(runBeat(ordered, used, () => true, () => 8).winner);
    }
    expect(new Set(winners).size).toBe(5);
    expect(winners).not.toContain(null);
  });

  it("the pre-fix pipeline could not have done that — the ordering fed it 3 candidates", () => {
    // Reproduces the old orderCandidatesForBeatGap output shape for one_external.
    const pool = [
      ARCH_1,
      ARCH_2,
      cand("nara:a", "nara", 0.25),
      cand("nara:b", "nara", 0.24),
      cand("nasa:c", "nasa", 0.23),
      cand("loc:d", "loc", 0.22),
    ];
    const preFix = [
      ...pool.filter((c) => c.source === "archive"),
      ...pool.filter((c) => c.source !== "archive").sort((a, b) => b.rankingScore - a.rankingScore).slice(0, 1),
    ];
    const used = new Set<string>();
    const winners: (string | null)[] = [];
    for (let beat = 0; beat < 5; beat++) {
      winners.push(runBeat(preFix, used, () => true, () => 8).winner);
    }
    expect(new Set(winners).size).toBe(3); // the ceiling the old filter imposed
  });
});

// ─── Scope ────────────────────────────────────────────────────────────────────

describe("RONDE 2 — scope", () => {
  it("no ranking constant, cap or tier bonus moved", () => {
    expect(funnelSrc).toContain("export const STOCK_TIER_WIN_MARGIN = 1.0;");
    expect(funnelSrc).toContain("const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;");
    expect(funnelSrc).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
    expect(funnelSrc).toContain("export const FUNNEL_CANDIDATE_POOL_LIMIT = 15;");
    expect(funnelSrc).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    expect(funnelSrc).toContain("internet_archive: 0.15,");
    expect(funnelSrc).toContain("nara: 0.145,");
    expect(funnelSrc).toContain("wikimedia: 0.10,");
    expect(funnelSrc).toContain("pexels: 0,");
  });

  it("FIX 5 was NOT implemented — the coverage scale is untouched", () => {
    expect(funnelSrc).toContain("const KEYWORD_SCORE_MAX = 100;");
    expect(funnelSrc).toMatch(/const ARCHIVE_DOMINANT_THRESHOLD = envThreshold\("ARCHIVE_DOMINANT_THRESHOLD", 0\.46\)/);
    expect(funnelSrc).toMatch(/const INTERNET_DOMINANT_THRESHOLD = envThreshold\("INTERNET_DOMINANT_THRESHOLD", 0\.25\)/);
    expect(funnelSrc).toContain('case "archive_dominant":  return { archive: 1.0, internet: 0.30 };');
    expect(funnelSrc).toContain("return Math.min(1, topScore / KEYWORD_SCORE_MAX);");
  });

  it("the gap-strategy thresholds themselves are unchanged (only the ORDERING changed)", () => {
    expect(funnelSrc).toMatch(/export const BEAT_ARCHIVE_STOP_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_STOP_THRESHOLD", 0\.50\)/);
    expect(funnelSrc).toMatch(/export const BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD", 0\.42\)/);
    expect(funnelSrc).toMatch(/export const BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD", 0\.30\)/);
    expect(funnelSrc).toContain("const MAX_CONSECUTIVE_ARCHIVE_ONLY = 2;");
  });

  it("no randomisation, no penalty term, no score write", () => {
    const code = codeOnly(funnelSrc);
    expect(code).not.toContain("Math.random");
    expect(code.toLowerCase()).not.toContain("penalty");
    expect(code).not.toMatch(/\.rankingScore\s*=[^=]/);
    expect(code).not.toMatch(/\.worstScore10\s*=[^=]/);
  });

  it("FASE 7.1 / 7.2 / 7.3 and STAP 1 are still in place", () => {
    expect(pipelineSrc).toContain("queryEmbeddingSource=resolved-by-vision-gate");
    expect(pipelineSrc).toContain("AbortSignal.any([controller.signal, scopeSignal])");
    expect(pipelineSrc).toContain("[FunnelDownload] rejected source=");
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MIN_SIM = visionThreshold\("MODERN_EVIDENCE_MIN_SIM", 0\.235\)/);
    expect(localSrc).toContain("export function decideModernContentMismatch(");
  });
});
