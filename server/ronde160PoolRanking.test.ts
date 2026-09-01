/**
 * RONDE 160 (FASE 7/10/11) — QUALITY > SOURCE, proven on the real ranking engine.
 *
 * ── What these tests are actually asserting ─────────────────────────────────────────────────
 *
 * Not "the adapter calls rankCandidates". FASE 12 forbids that kind of test, and it would prove
 * nothing anyway. Every test below builds REAL candidates, runs the REAL engine through the
 * adapter, and asserts the ORDER that comes out — because the order is the product.
 *
 * The two that matter most are the two the brief singles out:
 *
 *   · a perfect archive asset beats a poor YouTube one, and
 *   · an excellent YouTube asset actually WINS.
 *
 * Both have to be true at once. A ranking where the archive always wins is a cascade wearing a
 * ranking's clothes, and a ranking where YouTube always wins has simply moved the bias.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  formatPoolRanking,
  poolCandidateToAsset,
  rankPoolCandidates,
  rankedPool,
  type RankablePoolCandidate,
} from "./poolRanking";
import { DEFAULT_SOURCE_PRIORITY } from "./visualMatchingV2/candidateRanking";
import type { VisualIntent } from "./visualMatchingV2/types";

/* ═══════════════════════ fixtures ═══════════════════════ */

const INTENT: VisualIntent = {
  beatId: "s0b0",
  spokenText: "A helicopter sweeps over the Apple Park ring campus in Cupertino.",
  visualSubject: "Apple Park",
  visualAction: "flying over",
  visualLocation: "Cupertino",
  visualTime: "",
  historicalContext: "",
  emotion: "",
  visualDescription: "",
  primaryKeyword: "Apple Park",
  secondaryKeyword: "Cupertino",
  negativeKeywords: [],
  secondaryVisualSubjects: [],
  objects: [],
  brands: [],
  companies: [],
  countries: [],
  events: [],
  people: [],
  intentHash: "h",
  cacheHit: false,
};

function candidate(over: Partial<RankablePoolCandidate> & { id: string; source: string }): RankablePoolCandidate {
  return {
    assetId: over.id,
    remoteUrl: `https://example.invalid/${over.id}.mp4`,
    thumbnailUrl: null,
    title: "",
    description: null,
    tags: [],
    mediaType: "video",
    durationSec: 10,
    license: null,
    width: 1920,
    height: 1080,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    ...over,
  };
}

/** A candidate that is genuinely about the beat, with a strong visual-similarity measurement. */
const strong = (id: string, source: string) =>
  candidate({
    id,
    source,
    title: "Apple Park ring campus aerial, Cupertino",
    description: "A helicopter flight over the Apple Park ring in Cupertino.",
    tags: ["apple park", "cupertino", "aerial"],
    clipSimilarity: 0.95,
    embeddingSimilarity: 0.93,
  });

/** A candidate about something else entirely, and measured as such. */
const weak = (id: string, source: string) =>
  candidate({
    id,
    source,
    title: "A cat sitting on a windowsill",
    description: "Domestic cat, indoors.",
    tags: ["cat", "pet"],
    clipSimilarity: 0.05,
    embeddingSimilarity: 0.04,
  });

const idsOf = (cs: readonly RankablePoolCandidate[]) => cs.map((c) => c.id);

/* ═══════════════════════ the ordering claim ═══════════════════════ */

describe("FASE 7 — quality outranks source, in both directions", () => {
  /**
   * The premise of the whole section: the source table really does prefer the archive. If it did
   * not, "quality beat source" below would be true for an uninteresting reason.
   */
  it("the source table genuinely favours the archive over YouTube", () => {
    expect(DEFAULT_SOURCE_PRIORITY.own_archive).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY.youtube_cc);
  });

  it("a perfect archive asset beats a poor YouTube one", () => {
    const out = rankedPool({
      intent: INTENT,
      candidates: [weak("yt-weak", "youtube_cc"), strong("arch-strong", "own_archive")],
    });
    expect(idsOf(out)[0]).toBe("arch-strong");
  });

  /**
   * The one the brief insists on. Same two sources, quality swapped — and the answer must swap
   * with it. A YouTube clip that is genuinely the best match has to be able to win, or the
   * ranking is just the cascade again.
   */
  it("an excellent YouTube asset beats a poor archive one", () => {
    const out = rankedPool({
      intent: INTENT,
      candidates: [weak("arch-weak", "own_archive"), strong("yt-strong", "youtube_cc")],
    });
    expect(idsOf(out)[0], "YouTube cannot win, so this is a cascade and not a ranking").toBe("yt-strong");
  });

  /**
   * And with quality held EQUAL, the source table is what breaks the tie — which is what makes it
   * a tiebreak rather than a veto. Both halves have to hold for the weighting to be meaningful.
   */
  it("with equal quality, the higher-priority source wins the tie", () => {
    const out = rankedPool({
      intent: INTENT,
      candidates: [strong("yt-equal", "youtube_cc"), strong("arch-equal", "own_archive")],
    });
    expect(idsOf(out)[0]).toBe("arch-equal");
  });

  /** Every candidate that went in comes out. Ranking reorders; it must never quietly drop. */
  it("ranking is an ordering, not a filter", () => {
    const input = [weak("a", "pexels"), strong("b", "wikimedia"), weak("c", "youtube_cc")];
    const out = rankedPool({ intent: INTENT, candidates: input });
    expect(out).toHaveLength(3);
    expect(idsOf(out).sort()).toEqual(["a", "b", "c"]);
  });

  it("writes the score back where the pool's own type expects it", () => {
    const out = rankedPool({ intent: INTENT, candidates: [strong("x", "wikimedia")] });
    expect(typeof out[0]!.rankingScore).toBe("number");
    expect(out[0]!.rankingScore!).toBeGreaterThan(0);
  });

  it("an empty pool ranks to an empty result rather than throwing", () => {
    expect(rankPoolCandidates({ intent: INTENT, candidates: [] })).toEqual([]);
    expect(rankedPool({ intent: INTENT, candidates: [] })).toEqual([]);
  });
});

/* ═══════════════════════ determinism ═══════════════════════ */

describe("FASE 10 — the order is deterministic, never randomised", () => {
  it("the same pool ranks identically every time", () => {
    const build = () => [weak("a", "pexels"), strong("b", "youtube_cc"), strong("c", "own_archive")];
    const first = idsOf(rankedPool({ intent: INTENT, candidates: build() }));
    for (let i = 0; i < 5; i++) {
      expect(idsOf(rankedPool({ intent: INTENT, candidates: build() }))).toEqual(first);
    }
  });

  /** Input order must not decide output order — otherwise "deterministic" only means "stable". */
  it("shuffling the input does not change the winner", () => {
    const a = strong("arch", "own_archive");
    const b = weak("yt", "youtube_cc");
    expect(idsOf(rankedPool({ intent: INTENT, candidates: [a, b] }))[0]).toBe(
      idsOf(rankedPool({ intent: INTENT, candidates: [b, a] }))[0]
    );
  });
});

/* ═══════════════════════ diversity ═══════════════════════ */

describe("FASE 10 — repetition is penalised deterministically, not randomised away", () => {
  /**
   * Two candidates identical in every respect except that one has already been used this render.
   * The unused one must win — and it must win because of the diversity signal, which is why the
   * pair is otherwise indistinguishable.
   */
  it("an asset this render already used loses to an equally good unused one", () => {
    const used = strong("already-used", "wikimedia");
    const fresh = strong("not-yet-used", "wikimedia");
    const out = rankedPool({
      intent: INTENT,
      candidates: [used, fresh],
      usedPaths: new Set([used.remoteUrl]),
    });
    expect(idsOf(out)[0]).toBe("not-yet-used");
  });

  /** The control: with nothing marked used, the same pair keeps its natural order. */
  it("without a used-set the same pair is not reordered", () => {
    const a = strong("first", "wikimedia");
    const b = strong("second", "wikimedia");
    const out = rankedPool({ intent: INTENT, candidates: [a, b] });
    expect(idsOf(out)).toEqual(["first", "second"]);
  });
});

/* ═══════════════════════ the Director's shot reaches retrieval ═══════════════════════ */

describe("FASE 11 — the Director decides the shot, retrieval decides which asset realises it", () => {
  /**
   * A beat whose planned shot is nine seconds long. Two otherwise-equal candidates, one far too
   * short to cover it. The Director's requirement has to change the answer, or it never arrived.
   */
  it("a clip that cannot cover the beat loses to one that can", () => {
    const short = candidate({
      ...strong("too-short", "wikimedia"),
      id: "too-short",
      durationSec: 1,
    });
    const long = candidate({ ...strong("long-enough", "wikimedia"), id: "long-enough", durationSec: 12 });
    const out = rankedPool({
      intent: INTENT,
      candidates: [short, long],
      targetDurationSec: 9,
    });
    expect(idsOf(out)[0]).toBe("long-enough");
  });

  /** The same pair, with no duration requirement, is not reordered — the signal did the work. */
  it("without a duration requirement the short clip is not penalised", () => {
    const short = candidate({ ...strong("too-short", "wikimedia"), id: "too-short", durationSec: 1 });
    const long = candidate({ ...strong("long-enough", "wikimedia"), id: "long-enough", durationSec: 12 });
    expect(idsOf(rankedPool({ intent: INTENT, candidates: [short, long] }))).toEqual([
      "too-short",
      "long-enough",
    ]);
  });

  it("a portrait clip loses to a landscape one when the format asks for landscape", () => {
    const portrait = candidate({ ...strong("portrait", "wikimedia"), id: "portrait", width: 1080, height: 1920 });
    const landscape = candidate({ ...strong("landscape", "wikimedia"), id: "landscape", width: 1920, height: 1080 });
    const out = rankedPool({
      intent: INTENT,
      candidates: [portrait, landscape],
      targetOrientation: "landscape",
    });
    expect(idsOf(out)[0]).toBe("landscape");
  });
});

/* ═══════════════════════ the translation itself ═══════════════════════ */

describe("FASE 5 — a pool candidate becomes a normalized candidate without inventing anything", () => {
  it("carries the provider's own text and measurements through", () => {
    const asset = poolCandidateToAsset(strong("x", "wikimedia"));
    expect(asset.candidateId).toBe("x");
    expect(asset.title).toContain("Apple Park");
    expect(asset.tags).toContain("cupertino");
    expect(asset.width).toBe(1920);
    expect(asset.duration).toBe(10);
    expect(asset.clipSimilarity).toBeCloseTo(0.95);
  });

  /**
   * §7's rule. An unknown measurement is null, never 0: the engine redistributes the weight of a
   * signal a candidate carries no data for, so null costs nothing while a fabricated 0 would score
   * as "measured, and bad".
   */
  it("an unmeasured field is null rather than zero", () => {
    const asset = poolCandidateToAsset(
      candidate({ id: "bare", source: "pexels", width: null, height: null, durationSec: null })
    );
    expect(asset.width).toBeNull();
    expect(asset.height).toBeNull();
    expect(asset.duration).toBeNull();
    expect(asset.clipSimilarity).toBeNull();
  });

  /** The source token comes from the shared classifier, so "nara" is archival here too. */
  it("classifies a provider the engine's union does not name", () => {
    expect(poolCandidateToAsset(candidate({ id: "n", source: "nara" })).source).toBe("internet_archive");
    expect(poolCandidateToAsset(candidate({ id: "p", source: "pexels" })).source).toBe("pexels");
    expect(poolCandidateToAsset(candidate({ id: "y", source: "youtube_cc" })).source).toBe("youtube_cc");
  });

  /** An unclassifiable provider must not be silently promoted to archival. */
  it("an unknown provider is not called archival", () => {
    const source = poolCandidateToAsset(candidate({ id: "u", source: "some_new_provider" })).source;
    expect(source).not.toBe("own_archive");
    expect(source).not.toBe("internet_archive");
  });
});

/* ═══════════════════════ observability ═══════════════════════ */

describe("FASE 15 — the log says who won and by how much", () => {
  it("names the winner, its score and the margin over the runner-up", () => {
    const ranked = rankPoolCandidates({
      intent: INTENT,
      candidates: [weak("yt", "youtube_cc"), strong("arch", "own_archive")],
    });
    const line = formatPoolRanking(3, ranked);
    expect(line).toContain("[Retrieval] s3");
    expect(line).toContain("selected=own_archive:arch");
    expect(line).toContain("score=");
    expect(line).toContain("margin=");
  });

  it("says so plainly when there was nothing to rank", () => {
    expect(formatPoolRanking(3, [])).toContain("ranked=none");
  });

  /** §15 — no URLs, no keys, no signed links in a retrieval line. */
  it("leaks no URL and no credential", () => {
    const ranked = rankPoolCandidates({ intent: INTENT, candidates: [strong("x", "pexels")] });
    const line = formatPoolRanking(1, ranked);
    expect(line).not.toMatch(/https?:/);
    expect(line).not.toContain("example.invalid");
  });
});

/* ═══════════════════════ reachable from the live selector ═══════════════════════ */

/**
 * The audit's own lesson, applied to this round: a ranking engine nobody calls is exactly what
 * `visualMatchingV2` already was. So the last tests go through `selectCandidatesFromPool` — the
 * function the production pipeline actually calls — and prove the engine is reachable from it.
 *
 * PRODUCTION STATUS: LOCAL. The switch is OFF by default and this environment has no provider
 * credentials, so no claim is made about how the new order performs on real footage. What is
 * proven is that the switch routes, that both branches work, and that the engine's order is the
 * one that comes out when it is on.
 */
describe("FASE 7 — the live pool selector can reach the engine", () => {
  const ORIGINAL = process.env.POOL_RANKING_V2;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.POOL_RANKING_V2;
    else process.env.POOL_RANKING_V2 = ORIGINAL;
  });

  function poolOf(candidates: RankablePoolCandidate[]) {
    return {
      sceneIndex: 0,
      sceneText: INTENT.spokenText,
      queries: [],
      candidates: candidates as never,
      metrics: {
        retrievalLatencyMs: 0, cacheHit: false, apiCallsPerProvider: {},
        candidatesBeforeDedup: candidates.length, candidatesAfterDedup: candidates.length,
        candidatesAfterLimit: candidates.length, poolSize: candidates.length,
        estimatedMemoryBytes: 0,
      },
    };
  }

  /** The whole point: with the engine on, a great YouTube clip beats a poor archive one. */
  it("with the switch on, the engine's order is what the selector returns", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");
    const out = selectCandidatesFromPool(
      INTENT.spokenText,
      "Apple Park",
      ["cupertino"],
      poolOf([weak("arch-weak", "own_archive"), strong("yt-strong", "youtube_cc")]) as never,
      5,
      { intent: INTENT }
    );
    expect(out[0]!.id).toBe("yt-strong");
  });

  it("is OFF by default — an audit round does not change what every render picks", async () => {
    delete process.env.POOL_RANKING_V2;
    const { poolRankingV2Enabled } = await import("./scenePool");
    expect(poolRankingV2Enabled()).toBe(false);
    process.env.POOL_RANKING_V2 = "true";
    expect(poolRankingV2Enabled()).toBe(true);
    /** Opt-in: anything that is not "true" leaves the historical scorer in place. */
    for (const v of ["yes", "1", "", "false"]) {
      process.env.POOL_RANKING_V2 = v;
      expect(poolRankingV2Enabled(), v).toBe(false);
    }
  });

  /** With the switch off the old scorer still runs, unchanged — nothing was replaced by stealth. */
  it("with the switch off the historical keyword scorer still decides", async () => {
    delete process.env.POOL_RANKING_V2;
    const { selectCandidatesFromPool } = await import("./scenePool");
    const out = selectCandidatesFromPool(
      "Apple Park ring campus",
      "Apple Park",
      ["cupertino"],
      poolOf([weak("cat", "own_archive"), strong("apple", "youtube_cc")]) as never,
      5,
      { intent: INTENT }
    );
    /** The keyword counter picks the title that shares words with the beat, as it always has. */
    expect(out[0]!.id).toBe("apple");
    expect(out[0]!.rankingScore, "the old path must not write an engine score").toBeNull();
  });

  /** Without an intent there is nothing to rank against, so the old path runs even when on. */
  it("falls back to the historical scorer when no intent is supplied", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");
    const out = selectCandidatesFromPool(
      "Apple Park ring campus",
      "Apple Park",
      ["cupertino"],
      poolOf([strong("apple", "youtube_cc")]) as never,
      5
    );
    expect(out[0]!.rankingScore).toBeNull();
  });
});
