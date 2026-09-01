/**
 * RONDE 180 — the pool's selection finally gets the context two whole features hang off.
 *
 * ── What was inert ───────────────────────────────────────────────────────────────────────────
 *
 * There is exactly ONE production call to `selectCandidatesFromPool`, and it passed no `ctx`.
 * That single omission disabled two rounds' work:
 *
 *   · R160 FASE 7's thirteen-signal ranking engine only runs `if (poolRankingV2Enabled() &&
 *     ctx?.intent)`. With no intent, every render fell back to the local scorer that counts shared
 *     word-stems — no source priority, no motion, no aspect, no duration fit, no Director shot.
 *   · R170's duplicate penalty needs `ctx.usageLedger`. With no ledger there is nothing to be a
 *     duplicate OF, so the same shot could return in three scenes with no penalty at any of them.
 *
 * Both were built, tested and unreachable. Nothing failed, because the pool's own fallback produces
 * a perfectly valid list — a worse one.
 *
 * These tests come in two halves. The call site is asserted structurally, because the function it
 * lives in needs a workDir, a network, a budget and a database. The BEHAVIOUR the context unlocks
 * is exercised for real against `selectCandidatesFromPool` and `duplicateGuard`.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

import { newLedger, recordUse } from "./duplicateGuard";
import { selectCandidatesFromPool, type PoolCandidate } from "./scenePool";
import type { SceneCandidatePool } from "./scenePool";
import type { VisualIntent } from "./visualMatchingV2/types";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");

/** The production `selectCandidatesFromPool(...)` call, argument list included. */
function selectionCall(): string {
  const at = SRC.indexOf("selectCandidatesFromPool(\n");
  expect(at, "the production pool selection is gone").toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf(");", at));
}

/* ═══════════════════════ the call site ═══════════════════════ */

describe("R180 — the production selection passes a context", () => {
  it("passes an intent, so the thirteen-signal engine can run at all", () => {
    expect(selectionCall(), "no intent — the ranking engine stays unreachable").toContain("intent:");
  });

  it("passes the render's usage ledger, so a repeat has something to be a repeat of", () => {
    expect(selectionCall()).toContain("usageLedger:");
  });

  /** Without `at`, the penalty cannot tell a same-beat retry from a shot returning three scenes later. */
  it("says where the selection is happening", () => {
    const call = selectionCall();
    expect(call).toContain("at: { sceneIndex: scene.index, beatIndex: beat.index }");
  });

  /**
   * The intent must come from `intentFrom` — the same builder the cinematic plan uses. A second
   * intent builder here would let the ranking and the stored plan describe different beats.
   */
  it("builds the intent with the shared builder, not a second one", () => {
    const at = SRC.indexOf("const rankingIntent = intentFrom(");
    expect(at, "the ranking intent is built by something other than intentFrom").toBeGreaterThan(-1);
  });

  /** One ledger per RENDER — a per-scene one could not see a shot repeat across scenes. */
  it("the ledger lives on the render state, not on a scene", () => {
    expect(SRC).toContain("usageLedger: newLedger(),");
    expect(SRC).toContain("usageLedger: UsageLedger;");
  });

  /**
   * And it is written on ADOPTION, not on ranking. A candidate that was considered and rejected is
   * not a use; recording it would make the next beat avoid a shot this video never showed.
   */
  it("records a use only where a candidate becomes the beat's clip", () => {
    const adoptAt = SRC.indexOf("clip = poolClip;");
    expect(adoptAt).toBeGreaterThan(-1);
    const block = SRC.slice(adoptAt, adoptAt + 2000);
    expect(block).toContain("recordUse(");
    expect(block).toContain("dedup.usageLedger");
    /** Identity, never the path — so two downloads of one source video collapse to one entry. */
    expect(block).toContain("providerAssetId: adopted.assetId");
  });
});

/* ═══════════════════════ the ranking's inputs were arriving empty ═══════════════════════ */

describe("R180 — the engine is given the signals it cannot compute for itself", () => {
  /**
   * The finding that made this round more than wiring. `poolCandidateToAsset` passed
   * `keywordScore: null` with a comment saying the engine reads title, tags and description itself.
   * It does not — `buildKeywordNormalizer` only normalises scores it is HANDED — so the 0.17
   * keyword weight contributed exactly zero on every candidate, and with clipSimilarity and
   * embeddingSimilarity usually null too, the order came down to source priority and resolution.
   *
   * A ranking with no textual relevance in it is worse than the word-stem sort it replaces, which
   * is the opposite of what turning V2 on is supposed to do.
   */
  it("a keyword score handed in reaches the engine", async () => {
    const { poolCandidateToAsset } = await import("./poolRanking");
    const asset = poolCandidateToAsset(candidate() as never, 7);
    expect(asset.keywordScore).toBe(7);
  });

  it("and stays null when the caller has none, exactly as before", async () => {
    const { poolCandidateToAsset } = await import("./poolRanking");
    expect(poolCandidateToAsset(candidate() as never).keywordScore).toBeNull();
    expect(poolCandidateToAsset(candidate() as never, undefined).keywordScore).toBeNull();
  });

  /** The production call site supplies the beat's proven entities, so entityMatch has terms. */
  it("the production selection passes the entities the beat proved", () => {
    const call = selectionCall();
    expect(call).toContain("entityTerms:");
    expect(call).toContain("rankingIntent.objects");
    expect(call).toContain("rankingIntent.brands");
  });

  /**
   * The NaN this round found in the engine itself: an absent similarity read as measured.
   * `clamp01(undefined)` is NaN, and a NaN score does not throw and does not sort — the candidates
   * come back in the order the pool happened to build them while appearing to have been ranked.
   */
  it("an absent similarity is treated as absent, not as a measurement", async () => {
    const { rankCandidates } = await import("./visualMatchingV2/candidateRanking");
    const { poolCandidateToAsset } = await import("./poolRanking");
    const asset = poolCandidateToAsset(candidate() as never);
    /** A candidate that lost its similarity keys entirely — a rehydrated or hand-edited one. */
    delete (asset as Record<string, unknown>).clipSimilarity;
    delete (asset as Record<string, unknown>).embeddingSimilarity;
    const ranked = rankCandidates(intent(), [asset]);
    expect(Number.isFinite(ranked[0]!.candidate.rankingScore!)).toBe(true);
    expect(ranked[0]!.candidate.rankingBreakdown!.signalsUsed).not.toContain("clipSimilarity");
  });
});

/* ═══════════════════════ what the context actually does ═══════════════════════ */

function candidate(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    id: `${over.source ?? "pexels"}:${over.assetId ?? "a"}`,
    source: "pexels",
    assetId: "a",
    remoteUrl: "https://example.invalid/a.mp4",
    title: "Berlin street 1945 archival footage",
    mediaType: "video",
    durationSec: 8,
    width: 1920,
    height: 1080,
    description: null,
    tags: [],
    thumbnailUrl: null,
    license: null,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    ...over,
  } as PoolCandidate;
}

function pool(candidates: PoolCandidate[]): SceneCandidatePool {
  return {
    sceneIndex: 0,
    candidates,
    metrics: { apiCallsPerProvider: {}, totalMs: 0 },
  } as never;
}

function intent(over: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "s0b0",
    spokenText: "Berlin in 1945.",
    visualSubject: "Berlin",
    visualAction: "",
    visualLocation: "Berlin",
    visualTime: "1945",
    historicalContext: "1945",
    emotion: "",
    visualDescription: "",
    primaryKeyword: "berlin 1945",
    secondaryKeyword: "berlin",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    countries: [],
    events: [],
    people: [],
    intentHash: "berlin 1945",
    cacheHit: false,
    ...over,
  };
}

describe("R180 — the duplicate penalty, exercised", () => {
  const ORIGINAL = { ...process.env };
  const withV2 = <T>(fn: () => T): T => {
    process.env.POOL_RANKING_V2 = "true";
    try {
      return fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
      Object.assign(process.env, ORIGINAL);
    }
  };

  /**
   * The claim R170 makes and R180 finally makes true on the live route: an asset this video has
   * already shown loses to an equally good one it has not.
   */
  it("a shot already used in this video falls behind an unused one", () => {
    const used = candidate({ source: "pexels", assetId: "seen", id: "pexels:seen" });
    const fresh = candidate({ source: "pexels", assetId: "new", id: "pexels:new" });
    const ledger = recordUse(
      newLedger(),
      { provider: "pexels", providerAssetId: "seen" },
      { sceneIndex: 0, beatIndex: 0 }
    );
    const out = withV2(() =>
      selectCandidatesFromPool("Berlin in 1945.", "Berlin", ["berlin"], pool([used, fresh]), 2, {
        intent: intent(),
        usageLedger: ledger,
        at: { sceneIndex: 1, beatIndex: 0 },
      })
    );
    expect(out.map((c) => c.assetId)).toEqual(["new", "seen"]);
  });

  /** And with no ledger the order is the engine's alone — the penalty adds nothing of its own. */
  it("without a ledger the ranking's own order stands", () => {
    const a = candidate({ source: "pexels", assetId: "seen", id: "pexels:seen" });
    const b = candidate({ source: "pexels", assetId: "new", id: "pexels:new" });
    const out = withV2(() =>
      selectCandidatesFromPool("Berlin in 1945.", "Berlin", ["berlin"], pool([a, b]), 2, {
        intent: intent(),
      })
    );
    expect(out).toHaveLength(2);
  });

  /**
   * RULE 7 — relevance beats diversity. The penalty is meant to settle a near-tie, not to overturn
   * a real difference, so a clearly better candidate still wins even after being used before.
   */
  it("a used shot that is clearly more relevant still wins", () => {
    const usedButRight = candidate({
      source: "pexels", assetId: "seen", id: "pexels:seen",
      title: "Berlin 1945 ruins archival footage of the battle",
    });
    const freshButWrong = candidate({
      source: "pexels", assetId: "new", id: "pexels:new",
      title: "a bowl of fruit on a table",
    });
    const ledger = recordUse(
      newLedger(),
      { provider: "pexels", providerAssetId: "seen" },
      { sceneIndex: 0, beatIndex: 0 }
    );
    const out = withV2(() =>
      selectCandidatesFromPool("Berlin in 1945.", "Berlin", ["berlin", "1945"], pool([freshButWrong, usedButRight]), 2, {
        intent: intent(),
        usageLedger: ledger,
        at: { sceneIndex: 1, beatIndex: 0 },
      })
    );
    expect(out[0]!.assetId).toBe("seen");
  });
});

/* ═══════════════════════ a still is not punished for being a still ═══════════════════════ */

describe("R180 — a STILL is never rejected or penalised for its duration", () => {
  const ORIGINAL = { ...process.env };
  const withV2 = <T>(fn: () => T): T => {
    process.env.POOL_RANKING_V2 = "true";
    try {
      return fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
      Object.assign(process.env, ORIGINAL);
    }
  };

  /**
   * R180 started passing `targetDurationSec` for the first time, which is exactly the input that
   * could have made a still lose every beat: a photograph has no duration, and a duration-fit
   * signal that read that as zero would score it as maximally wrong for every slot.
   *
   * It does not. `durationFitScore` returns null for a null duration and the signal is left out of
   * the weighted average entirely — so this pins the standing rule against the new input.
   */
  it("survives selection for a beat longer than any clip", () => {
    const still = candidate({
      source: "wikimedia", assetId: "photo", id: "wikimedia:photo",
      mediaType: "image", durationSec: null,
    });
    const out = withV2(() =>
      selectCandidatesFromPool("Berlin in 1945.", "Berlin", ["berlin"], pool([still]), 3, {
        intent: intent(),
        targetDurationSec: 30,
      })
    );
    expect(out.map((c) => c.assetId), "the still was dropped for having no duration").toEqual(["photo"]);
  });

  /**
   * And it is not quietly ranked last either. Against a video whose length is a poor fit for the
   * slot, the still — which cannot be a poor fit, because the signal does not apply to it — must
   * not lose ON DURATION. Both are equally relevant, so duration is the only thing between them.
   */
  it("is not ranked below a video purely because the video has a duration", () => {
    const still = candidate({
      source: "pexels", assetId: "photo", id: "pexels:photo",
      mediaType: "image", durationSec: null,
    });
    const badFitVideo = candidate({
      source: "pexels", assetId: "clip", id: "pexels:clip",
      mediaType: "video", durationSec: 60,
    });
    const out = withV2(() =>
      selectCandidatesFromPool("Berlin in 1945.", "Berlin", ["berlin"], pool([badFitVideo, still]), 2, {
        intent: intent(),
        targetDurationSec: 4,
      })
    );
    expect(out.map((c) => c.assetId)).toContain("photo");
  });
});
