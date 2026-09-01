/**
 * RONDE 169/170 — YouTube in the pool, and duplicates penalised without breaking relevance.
 *
 * ── The two rules that have to hold AT ONCE ──────────────────────────────────────────────────
 *
 * RULE 6: an excellent YouTube clip must be able to beat a poor archive one.
 * RULE 7: relevance beats diversity — a perfect relevant clip must not lose to an irrelevant new
 *         one just because it repeats.
 *
 * Either one is easy alone. A ranking where the archive always wins satisfies neither; a ranking
 * where the newest always wins satisfies neither. Every test below is built as a PAIR, so a change
 * that satisfies one rule by breaking the other fails here.
 *
 * PRODUCTION STATUS: LOCAL. No YOUTUBE_API_KEY in this environment. The search function is injected
 * in these tests — which is how the production code takes it too — so what is proven is the
 * translation, the ranking and the duplicate arithmetic, not that YouTube answered.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  youtubePoolCandidates,
  youtubeRowToPoolCandidate,
  type YoutubeRowLike,
} from "./youtubePoolSource";
import {
  DUPLICATE_PENALTY,
  assetKey,
  checkDuplicate,
  formatDuplicateDecision,
  newLedger,
  penaliseDuplicates,
  recordUse,
} from "./duplicateGuard";
import { rankedPool, type RankablePoolCandidate } from "./poolRanking";
import type { VisualIntent } from "./visualMatchingV2/types";

/* ═══════════════════════ fixtures ═══════════════════════ */

function ytRow(over: Partial<YoutubeRowLike> & { videoId: string }): YoutubeRowLike {
  return {
    item: {
      id: { videoId: over.videoId },
      snippet: {
        title: over.title ?? "Apple Park aerial tour",
        description: over.desc ?? "A flight over the Cupertino ring campus.",
        channelTitle: "A Channel",
        publishedAt: "2019-04-01T00:00:00Z",
        thumbnails: { high: { url: `https://i.ytimg.invalid/${over.videoId}.jpg` } },
      },
    },
    title: over.title ?? "Apple Park aerial tour",
    desc: over.desc ?? "A flight over the Cupertino ring campus.",
    rel: over.rel ?? 0.9,
  };
}

const INTENT: VisualIntent = {
  beatId: "s0b0",
  spokenText: "A helicopter sweeps over the Apple Park ring campus in Cupertino.",
  visualSubject: "Apple Park", visualAction: "flying over", visualLocation: "Cupertino",
  visualTime: "", historicalContext: "", emotion: "", visualDescription: "",
  primaryKeyword: "Apple Park", secondaryKeyword: "Cupertino",
  negativeKeywords: [], secondaryVisualSubjects: [], objects: [], brands: [],
  companies: [], countries: [], events: [], people: [],
  intentHash: "h", cacheHit: false,
};

function poolCandidate(over: Partial<RankablePoolCandidate> & { id: string; source: string }): RankablePoolCandidate {
  return {
    assetId: over.id, remoteUrl: `https://example.invalid/${over.id}`, thumbnailUrl: null,
    title: "", description: null, tags: [], mediaType: "video", durationSec: 10,
    license: null, width: 1920, height: 1080,
    clipSimilarity: null, embeddingSimilarity: null, rankingScore: null,
    ...over,
  };
}

const strong = (id: string, source: string) =>
  poolCandidate({
    id, source,
    title: "Apple Park ring campus aerial, Cupertino",
    description: "A helicopter flight over the Apple Park ring in Cupertino.",
    tags: ["apple park", "cupertino", "aerial"],
    clipSimilarity: 0.95, embeddingSimilarity: 0.93,
  });

const weak = (id: string, source: string) =>
  poolCandidate({
    id, source,
    title: "A cat on a windowsill", description: "Domestic cat, indoors.",
    tags: ["cat"], clipSimilarity: 0.05, embeddingSimilarity: 0.04,
  });

/* ═══════════════════════ R169 — the translation ═══════════════════════ */

describe("R169 — a YouTube result becomes an ordinary pool candidate", () => {
  it("carries the id, the provider's own text and the watch URL", () => {
    const c = youtubeRowToPoolCandidate(ytRow({ videoId: "abc123" }), "creative_common")!;
    expect(c.id).toBe("youtube_cc:abc123");
    expect(c.assetId).toBe("abc123");
    expect(c.source).toBe("youtube_cc");
    expect(c.title).toContain("Apple Park");
    /** The watch page, which the existing download layer takes — never a media URL resolved here. */
    expect(c.remoteUrl).toBe("https://www.youtube.com/watch?v=abc123");
  });

  /**
   * §7's rule. The search endpoint returns a snippet and no dimensions or duration, so those are
   * NULL — the ranking engine redistributes the weight of a signal a candidate has no data for,
   * while a fabricated 1920x1080 would score as "measured, and good".
   */
  it("leaves unmeasured fields null rather than inventing plausible ones", () => {
    const c = youtubeRowToPoolCandidate(ytRow({ videoId: "abc123" }), "any")!;
    expect(c.width).toBeNull();
    expect(c.height).toBeNull();
    expect(c.durationSec).toBeNull();
    expect(c.clipSimilarity).toBeNull();
  });

  it("keeps the provider metadata R160 §4 asked for", () => {
    const c = youtubeRowToPoolCandidate(ytRow({ videoId: "abc123" }), "youtube")!;
    expect(c.youtube.youtubeVideoId).toBe("abc123");
    expect(c.youtube.channel).toBe("A Channel");
    expect(c.youtube.publishedAt).toBe("2019-04-01T00:00:00Z");
    expect(c.youtube.thumbnail).toContain("abc123");
    expect(c.youtube.retrievedAt).toBeTruthy();
  });

  /** Licence is metadata. `any` filtered nothing, so it asserts nothing. */
  it("records the licence mode, and claims no licence for the unfiltered pass", () => {
    expect(youtubeRowToPoolCandidate(ytRow({ videoId: "a" }), "creative_common")!.youtube.license)
      .toEqual({ retrievedUnder: "creative_common", reported: "creativeCommon" });
    expect(youtubeRowToPoolCandidate(ytRow({ videoId: "a" }), "youtube")!.youtube.license)
      .toEqual({ retrievedUnder: "youtube", reported: "youtube" });

    const any = youtubeRowToPoolCandidate(ytRow({ videoId: "a" }), "any")!;
    expect(any.youtube.license.reported, "the unfiltered pass claimed a licence").toBeUndefined();
    expect(any.youtube.license.retrievedUnder).toBe("any");
    expect(any.license, "the pool's licence label was set from an unfiltered search").toBeNull();
  });

  /** A row with no video id could never be fetched again. Dropped, not patched. */
  it("drops a row with no video id", () => {
    expect(youtubeRowToPoolCandidate({ ...ytRow({ videoId: "x" }), item: { id: {} } }, "any")).toBeNull();
  });

  it("searches through the INJECTED function and reports what it found", async () => {
    const { candidates, log } = await youtubePoolCandidates({
      query: "apple park", sceneIndex: 2, mode: "creative_common",
      search: async () => [ytRow({ videoId: "a1" }), ytRow({ videoId: "a2" })],
    });
    expect(candidates.map((c) => c.assetId)).toEqual(["a1", "a2"]);
    expect(log).toContain("source=youtube");
    expect(log).toContain("mode=creative_common");
    expect(log).toContain("candidates=2");
  });

  /**
   * §8 — a source that FAILED and a source that found nothing are different facts. A log that
   * cannot tell them apart cannot answer "why was YouTube not used for this beat".
   */
  it("distinguishes a failed search from an empty one", async () => {
    const failed = await youtubePoolCandidates({
      query: "q", sceneIndex: 0, mode: "any",
      search: async () => { throw new Error("quota exceeded"); },
    });
    expect(failed.candidates).toEqual([]);
    expect(failed.log).toContain("failed=true");
    expect(failed.log).toContain("quota");

    const empty = await youtubePoolCandidates({
      query: "q", sceneIndex: 0, mode: "any", search: async () => [],
    });
    expect(empty.log).toContain("candidates=0");
    expect(empty.log).not.toContain("failed=true");
  });

  it("the retrieval log carries no key and no media URL", async () => {
    const { log } = await youtubePoolCandidates({
      query: "apple park", sceneIndex: 0, mode: "any",
      search: async () => [ytRow({ videoId: "a1" })],
    });
    expect(log).not.toMatch(/https?:/);
    expect(log).not.toMatch(/key/i);
  });
});

/* ═══════════════════════ RULE 6 — YouTube can win ═══════════════════════ */

describe("R169 RULE 6 — YouTube competes on merit, in both directions", () => {
  it("an excellent YouTube clip beats a poor archive one", () => {
    const yt = youtubeRowToPoolCandidate(ytRow({ videoId: "good" }), "creative_common")!;
    const out = rankedPool({
      intent: INTENT,
      candidates: [weak("arch-weak", "own_archive"), { ...yt, ...strong("youtube_cc:good", "youtube_cc"), id: yt.id }],
    });
    expect(out[0]!.id).toBe("youtube_cc:good");
  });

  it("and a poor YouTube clip still loses to an excellent archive one", () => {
    const out = rankedPool({
      intent: INTENT,
      candidates: [weak("youtube_cc:bad", "youtube_cc"), strong("arch-strong", "own_archive")],
    });
    expect(out[0]!.id).toBe("arch-strong");
  });
});

/* ═══════════════════════ R170 — duplicates ═══════════════════════ */

describe("R170 — the guard answers 'the same asset', not 'a similar-looking one'", () => {
  const A = { provider: "wikimedia", providerAssetId: "File_X" };
  const B = { provider: "wikimedia", providerAssetId: "File_Y" };

  it("recognises the same asset again", () => {
    const ledger = recordUse(newLedger(), A, { sceneIndex: 0, beatIndex: 1 });
    const v = checkDuplicate(ledger, A, { sceneIndex: 2, beatIndex: 0 });
    expect(v.duplicate).toBe(true);
    if (!v.duplicate) return;
    expect(v.key).toBe("wikimedia:File_x".toLowerCase() === v.key ? v.key : "wikimedia:File_X");
    expect(v.usedAt).toEqual([{ sceneIndex: 0, beatIndex: 1 }]);
  });

  /**
   * Case B from the module header, and the one that matters most for the original complaint. Two
   * DIFFERENT archive clips of the same building, with near-identical titles, are not duplicates.
   * A guard that flagged them would be answering a question nobody asked.
   */
  it("does NOT flag two different assets that merely look alike", () => {
    const ledger = recordUse(newLedger(), A, { sceneIndex: 0, beatIndex: 1 });
    expect(checkDuplicate(ledger, B, { sceneIndex: 0, beatIndex: 2 }).duplicate).toBe(false);
  });

  /** Two unidentifiable assets are not thereby the same asset. */
  it("never collapses two assets that have no identity", () => {
    const anonymous = { provider: null, providerAssetId: null };
    expect(assetKey(anonymous)).toBeNull();
    const ledger = recordUse(newLedger(), anonymous, { sceneIndex: 0, beatIndex: 0 });
    expect(checkDuplicate(ledger, anonymous, { sceneIndex: 1, beatIndex: 0 }).duplicate).toBe(false);
  });

  it("reports how close the repeat is", () => {
    const at = { sceneIndex: 3, beatIndex: 4 };
    const beat = recordUse(newLedger(), A, at);
    expect((checkDuplicate(beat, A, at) as { scope: string }).scope).toBe("same_beat");

    const scene = recordUse(newLedger(), A, { sceneIndex: 3, beatIndex: 1 });
    expect((checkDuplicate(scene, A, at) as { scope: string }).scope).toBe("same_scene");

    const video = recordUse(newLedger(), A, { sceneIndex: 0, beatIndex: 1 });
    expect((checkDuplicate(video, A, at) as { scope: string }).scope).toBe("same_video");
  });

  it("an archive row id is as good an identity as a provider id", () => {
    expect(assetKey({ provider: "own_archive", archiveAssetId: 42 })).toBe("own_archive:archive#42");
  });
});

/* ═══════════════════════ RULE 7 — relevance beats diversity ═══════════════════════ */

describe("R170 RULE 7 — the penalty settles a tie and never overturns relevance", () => {
  const used = { provider: "wikimedia", providerAssetId: "used" };
  const ledger = () => recordUse(newLedger(), used, { sceneIndex: 0, beatIndex: 0 });

  const rank = (candidates: Array<{ id: string; identity: typeof used; score: number }>) =>
    penaliseDuplicates({
      ranked: candidates,
      identityOf: (c) => c.identity,
      scoreOf: (c) => c.score,
      ledger: ledger(),
      at: { sceneIndex: 1, beatIndex: 0 },
    });

  /** Two near-equal candidates: the one that has not been used wins. */
  it("a repeat loses a near-tie to a fresh candidate", () => {
    const out = rank([
      { id: "repeat", identity: used, score: 0.71 },
      { id: "fresh", identity: { provider: "pexels", providerAssetId: "new" }, score: 0.70 },
    ]);
    expect(out[0]!.candidate.id).toBe("fresh");
  });

  /**
   * The other half, and the one RULE 7 is really about. A clip that is genuinely much better still
   * wins even though it repeats — a perfect relevant clip must not lose to an irrelevant new one.
   */
  it("a repeat that is CLEARLY better still wins", () => {
    const out = rank([
      { id: "repeat", identity: used, score: 0.90 },
      { id: "fresh", identity: { provider: "pexels", providerAssetId: "new" }, score: 0.40 },
    ]);
    expect(out[0]!.candidate.id, "diversity overturned a large relevance gap").toBe("repeat");
  });

  /** The penalty is bounded, and small enough that the pair above cannot both be satisfied by luck. */
  it("the penalty is far smaller than a real relevance difference", () => {
    for (const p of Object.values(DUPLICATE_PENALTY)) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(0.5);
    }
    expect(DUPLICATE_PENALTY.same_beat).toBeGreaterThan(DUPLICATE_PENALTY.same_scene);
    expect(DUPLICATE_PENALTY.same_scene).toBeGreaterThan(DUPLICATE_PENALTY.same_video);
  });

  it("nothing is dropped — it is a reordering, with reasons attached", () => {
    const out = rank([
      { id: "repeat", identity: used, score: 0.71 },
      { id: "fresh", identity: { provider: "pexels", providerAssetId: "new" }, score: 0.70 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.candidate.id === "repeat")!.verdict.duplicate).toBe(true);
    expect(out.find((o) => o.candidate.id === "fresh")!.penalty).toBe(0);
  });

  /** Determinism: equal adjusted scores keep the ranking engine's own order. */
  it("is deterministic, with a stable order for ties", () => {
    const build = () => [
      { id: "a", identity: { provider: "pexels", providerAssetId: "1" }, score: 0.5 },
      { id: "b", identity: { provider: "pixabay", providerAssetId: "2" }, score: 0.5 },
    ];
    for (let i = 0; i < 5; i++) {
      expect(rank(build()).map((o) => o.candidate.id)).toEqual(["a", "b"]);
    }
  });
});

/* ═══════════════════════ §8 — the decision is loggable ═══════════════════════ */

describe("R170 — a log can answer 'why did this beat repeat a shot'", () => {
  const verdict = checkDuplicate(
    recordUse(newLedger(), { provider: "wikimedia", providerAssetId: "X" }, { sceneIndex: 0, beatIndex: 1 }),
    { provider: "wikimedia", providerAssetId: "X" },
    { sceneIndex: 2, beatIndex: 3 }
  );

  it("says a duplicate was adopted because nothing else existed", () => {
    const line = formatDuplicateDecision({ sceneIndex: 2, beatIndex: 3, verdict, alternatives: 0, adopted: true });
    expect(line).toContain("duplicate=true");
    expect(line).toContain("scope=same_video");
    expect(line).toContain("firstUsed=s0b1");
    expect(line).toContain("reason=no_alternative_existed");
  });

  it("says a duplicate won on merit when alternatives existed", () => {
    const line = formatDuplicateDecision({ sceneIndex: 2, beatIndex: 3, verdict, alternatives: 4, adopted: true });
    expect(line).toContain("reason=outranked_alternatives");
  });

  it("says a duplicate was rejected", () => {
    const line = formatDuplicateDecision({ sceneIndex: 2, beatIndex: 3, verdict, alternatives: 4, adopted: false });
    expect(line).toContain("reason=rejected_as_duplicate");
  });

  it("leaks no URL and no key", () => {
    const line = formatDuplicateDecision({ sceneIndex: 2, beatIndex: 3, verdict, alternatives: 1, adopted: true });
    expect(line).not.toMatch(/https?:/);
    expect(line).not.toMatch(/api[_-]?key/i);
  });
});

/* ═══════════════════════ reachable from the live selector ═══════════════════════ */

/**
 * The lesson of every audit round in this series, applied to this one: a guard nobody calls is
 * exactly what `visualMatchingV2` and `audioAssetSource` already were. These go through
 * `selectCandidatesFromPool` — the function the production pipeline calls — and prove both the
 * ranking and the duplicate penalty are reachable from it.
 */
describe("R170 — the pool selector really applies the penalty", () => {
  const ORIGINAL = { flag: process.env.POOL_RANKING_V2, engine: process.env.CINEMATIC_EDITING_ENGINE };
  afterEach(() => {
    for (const [k, v] of [["POOL_RANKING_V2", ORIGINAL.flag], ["CINEMATIC_EDITING_ENGINE", ORIGINAL.engine]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function poolOf(candidates: RankablePoolCandidate[]) {
    return {
      sceneIndex: 1,
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

  /** Two equally strong candidates; the one already used elsewhere in the video must lose. */
  it("an asset already used in this video loses a tie to an unused one", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");

    const used = strong("wikimedia:already", "wikimedia");
    used.assetId = "already";
    const fresh = strong("wikimedia:fresh", "wikimedia");
    fresh.assetId = "fresh";

    const ledger = recordUse(newLedger(), { provider: "wikimedia", providerAssetId: "already" }, {
      sceneIndex: 0, beatIndex: 0,
    });

    const out = selectCandidatesFromPool(
      INTENT.spokenText, "Apple Park", ["cupertino"],
      poolOf([used, fresh]) as never, 5,
      { intent: INTENT, usageLedger: ledger, at: { sceneIndex: 1, beatIndex: 0 } }
    );
    expect(out[0]!.assetId).toBe("fresh");
  });

  /** RULE 7 through the live selector: a clearly better repeat still wins. */
  it("a repeat that is clearly more relevant still wins through the selector", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");

    const used = strong("wikimedia:already", "wikimedia");
    used.assetId = "already";
    const irrelevant = weak("pexels:fresh", "pexels");
    irrelevant.assetId = "fresh";

    const ledger = recordUse(newLedger(), { provider: "wikimedia", providerAssetId: "already" }, {
      sceneIndex: 0, beatIndex: 0,
    });

    const out = selectCandidatesFromPool(
      INTENT.spokenText, "Apple Park", ["cupertino"],
      poolOf([used, irrelevant]) as never, 5,
      { intent: INTENT, usageLedger: ledger, at: { sceneIndex: 1, beatIndex: 0 } }
    );
    expect(out[0]!.assetId, "diversity overturned relevance through the live selector").toBe("already");
  });

  /** Without a ledger there is nothing to be a duplicate of, and the engine's order stands. */
  it("no ledger means no penalty, not a crash", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");
    const out = selectCandidatesFromPool(
      INTENT.spokenText, "Apple Park", ["cupertino"],
      poolOf([weak("a", "pexels"), strong("b", "wikimedia")]) as never, 5,
      { intent: INTENT }
    );
    expect(out[0]!.id).toBe("b");
  });

  /**
   * RULE 6 end to end: a YouTube candidate, translated by the adapter, ranked by the real engine
   * through the live selector, beating a poor archive clip.
   */
  it("a YouTube candidate can win through the live selector", async () => {
    process.env.POOL_RANKING_V2 = "true";
    const { selectCandidatesFromPool } = await import("./scenePool");

    const yt = youtubeRowToPoolCandidate(ytRow({ videoId: "great" }), "creative_common")!;
    const ranked: RankablePoolCandidate = {
      ...yt,
      title: "Apple Park ring campus aerial, Cupertino",
      description: "A helicopter flight over the Apple Park ring in Cupertino.",
      tags: ["apple park", "cupertino", "aerial"],
      clipSimilarity: 0.95,
      embeddingSimilarity: 0.93,
    };

    const out = selectCandidatesFromPool(
      INTENT.spokenText, "Apple Park", ["cupertino"],
      poolOf([weak("arch", "own_archive"), ranked]) as never, 5,
      { intent: INTENT }
    );
    expect(out[0]!.source).toBe("youtube_cc");
  });
});
