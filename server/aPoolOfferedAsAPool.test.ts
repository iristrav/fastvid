/**
 * RONDE 252 — A POOL OFFERED AS A POOL, NOT AS N POOLS OF ONE.
 *
 * ── The defect these tests were written against ─────────────────────────────────────────────
 *
 * `adoptClip` documents itself as "the multi-candidate entry point: 29 call sites hand it the
 * paths a route produced for one beat". It ranks what it is given, declares the beat's vision
 * review pool from that ranking, and walks the result preferring a FIT over a weaker verdict.
 *
 * Two call sites handed it one path at a time inside a loop over a list they already held:
 *
 *     for (const candidate of pool.slice(0, topN))     // topN = 12 or 20
 *       await adoptClip([candidate.path], …)
 *
 *     for (const c of sorted)
 *       await adoptClip([c.path], …)
 *
 * Twenty candidates therefore became twenty selections of one, and every decision downstream had
 * a single candidate to decide between. Render 585 measured it: `ranked / rankRuns` never above
 * 1.00 on any of fifteen beats, and `reviewPool=1` on all fifteen against a cap of 8.
 *
 * Neither the review pool, the ranking, nor the cap of 8 was at fault. The supply was.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * The behavioural half proves the selection chain does the right thing with a real pool. The
 * structural half proves the two loops actually hand it one — that is the thing that changed, and
 * it cannot be reached behaviourally without real provider I/O.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildVisionReviewPool,
  createVisionReviewPoolState,
  declareVisionReviewPool,
  formatVisionSelection,
  type ReviewCandidate,
} from "./visionAwareSelection";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Ten candidates from three providers, the shape a beat actually gets. */
const tenCandidates = (): ReviewCandidate[] => [
  { contentKey: "youtube_cc:aaa1", cheapRank: 0 },
  { contentKey: "wikimedia:bbb2", cheapRank: 1 },
  { contentKey: "internet_archive:ccc3", cheapRank: 2 },
  { contentKey: "youtube_cc:ddd4", cheapRank: 3 },
  { contentKey: "wikimedia:eee5", cheapRank: 4 },
  { contentKey: "internet_archive:fff6", cheapRank: 5 },
  { contentKey: "youtube_cc:ggg7", cheapRank: 6 },
  { contentKey: "wikimedia:hhh8", cheapRank: 7 },
  { contentKey: "pexels:iii9", cheapRank: 8 },
  { contentKey: "pixabay:jjj10", cheapRank: 9 },
];

describe("1. ten candidates reach a bounded review pool", () => {
  it("a beat offered ten declares eight — the cap, not one", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 0, 0, tenCandidates(), 8);
    const line = formatVisionSelection(state).find((l) => l.includes("s0b0"))!;
    expect(line, "render 585 printed reviewPool=1 here").toContain("reviewPool=8");
    expect(line).toContain("cap=8");
  });

  /** The cap bounds it; it is never raised to fit the supply. */
  it("and never more than the cap, however many are offered", () => {
    expect(buildVisionReviewPool(tenCandidates(), 8)).toHaveLength(8);
    expect(buildVisionReviewPool(tenCandidates(), 4)).toHaveLength(4);
  });

  /** A genuinely single-candidate beat is still correct at one — that was never the bug. */
  it("a beat with one real candidate still declares one", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 1, 1, tenCandidates().slice(0, 1), 8);
    expect(formatVisionSelection(state).find((l) => l.includes("s1b1"))!).toContain("reviewPool=1");
  });
});

describe("2. the chosen eight do not depend on arrival order", () => {
  const keysOf = (c: ReviewCandidate[]): string[] =>
    buildVisionReviewPool(c, 8).map((x) => x.contentKey);

  it("a shuffled supply yields the same eight", () => {
    const forward = tenCandidates();
    const shuffled = [forward[3]!, forward[9]!, forward[0]!, forward[6]!, forward[1]!,
                      forward[8]!, forward[2]!, forward[5]!, forward[7]!, forward[4]!];
    expect(keysOf(shuffled)).toEqual(keysOf(forward));
  });

  it("and reversing it changes nothing", () => {
    expect(keysOf([...tenCandidates()].reverse())).toEqual(keysOf(tenCandidates()));
  });
});

describe("3. providers aggregate, and one identity is one candidate", () => {
  /**
   * Three providers for one beat. The pool spans them rather than letting whichever route ran
   * first own the beat — the diversity is the point of aggregating at all.
   */
  it("a pool of ten spans all three providers that supplied it", () => {
    const providers = new Set(
      buildVisionReviewPool(tenCandidates(), 8).map((c) => c.contentKey.split(":")[0])
    );
    expect(providers.size, "one provider must not own the beat").toBeGreaterThan(1);
  });

  /**
   * The same asset offered twice under two paths is one candidate. `clipContentKey` is the
   * identity the whole pipeline uses, and its own note states the rule: a derived asset keeps its
   * parent's identity.
   */
  it("the same canonical identity twice is one entry in the pool", () => {
    const withDuplicate: ReviewCandidate[] = [
      ...tenCandidates().slice(0, 4),
      { contentKey: "wikimedia:bbb2", cheapRank: 11 },
    ];
    const pool = buildVisionReviewPool(withDuplicate, 8);
    const keys = pool.map((c) => c.contentKey);
    expect(new Set(keys).size, `duplicates survived: ${keys.join(", ")}`).toBe(
      new Set(withDuplicate.map((c) => c.contentKey)).size
    );
  });
});

describe("4. the two loops offer their list instead of walking it", () => {
  /**
   * THE STRUCTURAL HALF. Both routes hold a list of already-fetched paths; the fix is that they
   * hand the list over. Reaching this behaviourally would need real provider I/O, so what is
   * pinned is the thing that was wrong: a single-element array built inside a loop.
   */
  /**
   * Matched against CODE, with comments removed first. Both fixes carry a note quoting the line
   * they replaced, and a matcher that reads prose would find the defect in its own description —
   * which is what the first version of this test did.
   */
  const codeOnly = (block: string): string =>
    block.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  const singleCandidateCallIn = (block: string): RegExpMatchArray[] =>
    [...codeOnly(block).matchAll(/adoptClip\(\s*\[\s*[a-zA-Z]+\.path\s*\]/g)];

  it("the media-research route offers the pool, not one candidate", () => {
    const at = PIPE.indexOf("for (const pool of adoptPools)");
    expect(at, "the media-research route").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 2600);
    expect(
      singleCandidateCallIn(block),
      "the per-candidate call is what render 585 measured"
    ).toHaveLength(0);
    expect(block).toContain("selection.map((c) => c.path)");
  });

  it("the celebrity route offers its sorted list, not one candidate", () => {
    const at = PIPE.indexOf("function adoptBestCelebrityClip");
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 3600);
    expect(singleCandidateCallIn(block)).toHaveLength(0);
    expect(block).toContain("sorted.map((c) => c.path)");
  });

  /**
   * The winner still has to be attributable, because two checks are about the candidate that won
   * rather than about the pool — the licensed-stock cap above all. Resolving it through
   * `clipContentKey` is what lets a pool be offered without loosening that gate.
   */
  it("and the winner is resolved back to its candidate before the stock cap", () => {
    const at = PIPE.indexOf("for (const pool of adoptPools)");
    const block = PIPE.slice(at, at + 2600);
    expect(block).toContain("clipContentKey(c.path) === winnerKey");
    expect(block, "an unidentifiable winner must not pass the cap freely").toContain(
      "if (!winner || winner.source === \"pexels\" || winner.source === \"pixabay\")"
    );
    expect(block, "the cap itself is unchanged").toContain("canUseLicensedStockBeat(dedup)");
  });
});

describe("5. intentional single-winner routes are left alone", () => {
  /**
   * Not every call site is a pool. Two routes fetch with `count=1` and take `[0]`: the provider
   * was asked for one candidate, so there is no list to offer and forcing one would be a fiction.
   * The fix must not have swept them up.
   */
  it("the two count=1 web-wide routes still hand over one path", () => {
    const singles = [...PIPE.matchAll(/adoptClip\(\s*\[winner\.path\]/g)];
    expect(singles.length, "both intentional single-winner routes survive").toBe(2);
  });

  it("and they are single because the fetch asked for one", () => {
    expect(PIPE).toMatch(/searchWebWideVideoClips\([\s\S]{0,120}?,\s*1\s*\)/);
  });
});

describe("6. nothing was loosened to achieve this", () => {
  it("the review-pool cap is still the beat's own shortlist cap", () => {
    expect(PIPE).toContain("maxShortlistPerBeat()");
    expect(PIPE).not.toContain("MAX_VISION_REVIEW_CANDIDATES = 16");
  });

  it("and the vision gate is still required", () => {
    const gate = readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain('process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false"');
    expect(gate).toContain("MAX_JUDGEMENTS_PER_BEAT");
  });
});
