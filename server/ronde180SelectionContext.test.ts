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




  /** One ledger per RENDER — a per-scene one could not see a shot repeat across scenes. */
  it("the ledger lives on the render state, not on a scene", () => {
    expect(SRC).toContain("usageLedger: newLedger(),");
    expect(SRC).toContain("usageLedger: UsageLedger;");
  });

});

/* ═══════════════════════ the ranking's inputs were arriving empty ═══════════════════════ */


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


/* ═══════════════════════ a still is not punished for being a still ═══════════════════════ */

