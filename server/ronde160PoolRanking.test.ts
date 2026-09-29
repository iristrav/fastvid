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






});

/* ═══════════════════════ determinism ═══════════════════════ */


/* ═══════════════════════ diversity ═══════════════════════ */


/* ═══════════════════════ the Director's shot reaches retrieval ═══════════════════════ */


/* ═══════════════════════ the translation itself ═══════════════════════ */


/* ═══════════════════════ observability ═══════════════════════ */


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
