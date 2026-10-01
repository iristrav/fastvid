/**
 * COMPOSE DOES NOT GET ITS OWN LADDER.
 *
 * ── The gap the previous round left open, and what made it bigger than it looked ─────────────
 *
 * The beat ladder bounded the beat LOOP. Sourcing does not stop there. When a scene comes out
 * short, when a clip is refused at the last moment, when a beat is still empty as the montage is
 * assembled, the pipeline goes looking for another picture — and every one of those paths ran with
 * no ladder, which the gate reads as "admitted".
 *
 * The audit for this round counted them. It is not the two functions the brief names:
 *
 *     fillBeatVisual                       4× adoptStockBeatClipFallback, adoptAiBeatClip
 *     refillSceneStrictVoiceMatch          4× adoptStockBeatClipFallback, 3× rescueBeatVisual…
 *     recoverSceneClipsIfEmptyInner        2× adoptStockBeatClipFallback, beatPrimaryFetch
 *     ensureBeatVisualFilled               adoptStockBeatClipFallback, fetchLastResortRealClip
 *     rescueFastShortComposeClips          adoptStockBeatClipFallback
 *     _runVideoPipelineInner               adoptStockBeatClipFallback, fetchBeatAIClip
 *     ensureArchiveMontageVoiceCoverage    trySubjectFallbackForBeat
 *     fetchSceneVisualsInner, AFTER the loop — the scene backfill, 13 more sourcing call-sites
 *
 * ── Why the repair is one hook and not eight ────────────────────────────────────────────────
 *
 * Only seven functions in the pipeline actually touch a provider for a beat:
 * `fetchBeatStockFallbackInner`, `adoptStockBeatClipFallbackInner`,
 * `adoptEmergencyGeoStockClipInner`, `fetchLastResortRealClipInner`,
 * `rescueBeatVisualWhenEmptyInner`, `generateGuaranteedBeatClipInner` and `beatPrimaryFetchInner`.
 * Everything above delegates to those. And every one of them is wrapped in `withBeatProvenance`
 * or, in `beatPrimaryFetch`'s case, opens the same provenance directly — because RONDE 100B made
 * that mandatory and SearchGate strict BLOCKS any query built outside it.
 *
 * So the beat's sourcing continuation goes where the beat's PROOF already goes. Wrapping the eight
 * entry points by hand would have been eight chances to miss the ninth.
 *
 * ── What "continuation" means, and what it must never mean ──────────────────────────────────
 *
 * The beat's ladder is remembered rather than discarded, so a compose rescue re-enters the ladder
 * the beat actually walked. It does NOT start at tier 4 because compose is late, it does NOT
 * declare the higher tiers declined to let stock through, and a beat with no remembered ladder
 * opens one STRICTLY — nothing attempted — and says so in the log.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  admitProviderForTier,
  beginBeatSourcing,
  currentBeatLadder,
  declineTier,
  declineTiersNotServedBy,
  forgetRenderSourcing,
  rememberedLadderFor,
  resumeBeatSourcing,
  runSceneVisualDiscovery,
  BUDGET_EXHAUSTED,
  DEFAULT_COMPOSE_SEARCHES_PER_BEAT,
} from "./centralVisualSourcing";
import { providerTier } from "./sourcingTiers";

const read = (f: string): string => readFileSync(path.join(__dirname, f), "utf8");
const PIPELINE = read("videoPipeline.ts");
const CENTRAL = read("centralVisualSourcing.ts");

const RENDER = "compose-test";
const at = (beatIndex = 0) => ({ renderId: RENDER, sceneIndex: 0, beatIndex });

/** One beat, run through the loop the way production does, then closed. */
function walkBeatLoopIteration(beatIndex: number, body: () => void): void {
  const close = beginBeatSourcing(at(beatIndex));
  try {
    body();
  } finally {
    close();
  }
}

beforeEach(() => {
  forgetRenderSourcing(RENDER);
});

/* ═════════════════ C1–C4: the ladder still decides, after the loop ═════════════════ */

describe("compose-time sourcing obeys the same ladder", () => {
  /** C1 */
  it("C1: compose cannot run tier 4 while tier 1 is NOT_REACHED", async () => {
    await resumeBeatSourcing(at(), async () => {
      const verdict = admitProviderForTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.skipped).toContain("YOUTUBE");
    });
  });

  /** C2 */
  it("C2: compose cannot run tier 4 while tier 2 is NOT_REACHED", async () => {
    walkBeatLoopIteration(0, () => {
      declineTier("YOUTUBE", "NO_YOUTUBE_CAPABILITY");
    });
    await resumeBeatSourcing(at(), async () => {
      const verdict = admitProviderForTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.skipped).toContain("OWN_ARCHIVE");
    });
  });

  /** C3 */
  it("C3: compose cannot run tier 4 while tier 3 is NOT_REACHED", async () => {
    walkBeatLoopIteration(0, () => {
      declineTier("YOUTUBE", "NO_YOUTUBE_CAPABILITY");
      expect(admitProviderForTier("archive").admitted).toBe(true);
    });
    await resumeBeatSourcing(at(), async () => {
      const verdict = admitProviderForTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.skipped).toEqual(["OPEN_SOURCES"]);
    });
  });

  /** C4 */
  it("C4: compose may run tier 4 once tiers 1–3 are attempted or declined", async () => {
    walkBeatLoopIteration(0, () => {
      for (const p of ["youtube", "archive", "wikimedia"]) {
        expect(admitProviderForTier(p).admitted, p).toBe(true);
      }
    });
    await resumeBeatSourcing(at(), async () => {
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });
});

/* ═════════════════ C5–C6: the continuation is a continuation ═════════════════ */

describe("a compose rescue continues the beat rather than restarting it", () => {


  it("and it says so, rather than opening one silently", () => {
    const at2 = CENTRAL.indexOf("export async function resumeBeatSourcing");
    const body = CENTRAL.slice(at2, CENTRAL.indexOf("\n}\n", at2));
    expect(body).toContain("LADDER_OPENED_AT_COMPOSE");
    expect(body, "a fresh compose ladder must not seed itself with declines").not.toContain(
      "declineTier("
    );
  });


  it("each beat resumes its own ladder, never its neighbour's", async () => {
    walkBeatLoopIteration(0, () => {
      admitProviderForTier("youtube");
      admitProviderForTier("archive");
      admitProviderForTier("wikimedia");
    });
    walkBeatLoopIteration(1, () => {
      declineTier("YOUTUBE", "NO_YOUTUBE_CAPABILITY");
    });
    await resumeBeatSourcing(at(0), async () => {
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
    await resumeBeatSourcing(at(1), async () => {
      expect(admitProviderForTier("pexels").admitted, "beat 1 inherited beat 0's tiers").toBe(false);
    });
  });



});

/* ═════════════════ C7–C8: only sourcing needs authorisation ═════════════════ */

describe("transformation is not sourcing", () => {

  it("and withBeatProvenance opens the continuation before the body it wraps", () => {
    const at2 = PIPELINE.indexOf("function withBeatProvenance<T>(");
    const body = PIPELINE.slice(at2, PIPELINE.indexOf("\n}\n", at2));
    expect(body).toContain("resumeBeatSourcing(");
    expect(body).toContain("maxComposeSearches: BUDGETS.queries()");
    /** A caller with no beat identity opens no ladder rather than inventing one. */
    expect(body).toContain("beat.index != null && scene.index != null");
    /**
     * And the condition DECIDES. A mutation that left the call in place and short-circuited the
     * ternary — `false && beat.index != null` — survived the first version of this test, which is
     * precisely the failure mode the brief names: an authorisation call syntactically present and
     * made irrelevant. `withBeatProvenance` is private to a 50 000-line module and needs a live
     * render to invoke, so this link is proven statically; everything it leads to is behavioural.
     */
    expect(body, "the continuation condition is short-circuited").not.toMatch(
      /(?:false\s*&&|true\s*\|\|)\s*\n?\s*beat\.index != null/
    );
    expect(body, "the ternary was replaced by an unconditional miss").toMatch(
      /const ladderRun =\s*\n?\s*beat\.index != null && scene\.index != null\s*\n?\s*\?/
    );
  });
});

/* ═════════════════ C9: the budget ═════════════════ */

describe("compose sourcing is bounded, and says which bound it hit", () => {


  it("a compose rescue cannot search one beat without limit", async () => {
    const cap = 2;
    walkBeatLoopIteration(0, () => {
      for (const p of ["youtube", "archive", "wikimedia"]) admitProviderForTier(p);
    });
    await resumeBeatSourcing({ ...at(), maxComposeSearches: cap }, async () => {
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
      expect(admitProviderForTier("pexels").admitted).toBe(true);
      const verdict = admitProviderForTier("wikimedia");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toBe("COMPOSE_BUDGET_EXHAUSTED");
    });
  });


  it("the cap is a per-beat query budget, not a rescue-round count", () => {
    expect(DEFAULT_COMPOSE_SEARCHES_PER_BEAT).toBeGreaterThan(0);
    expect(PIPELINE, "the cap must count what it bounds — searches, not rescue rounds").toContain(
      "maxComposeSearches: BUDGETS.queries()"
    );
    expect(PIPELINE).not.toContain("maxComposeEntries");
  });
});

/* ═════════════════ render 592: the three defects the ladder shipped with ═════════════════ */

describe("render 592 — what the first production render caught", () => {

  it("but a tier opened for the FIRST time still waits for the one above it", async () => {
    await resumeBeatSourcing({ ...at(1), seedAttempted: ["OWN_ARCHIVE"] }, async () => {
      /** Tier 3 is untouched and tier 1 unreached — the refusal this rule exists for. */
      const verdict = admitProviderForTier("wikimedia");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.skipped).toEqual(["YOUTUBE"]);
    });
  });



  /**
   * DEFECT 2's other half — tier 1 must be able to CLOSE, or it blocks everything under it.
   *
   * The central YouTube turn is the only thing that knows how a beat's tier 1 ended. A turn that
   * finishes without a clip and without leaving itself open now declines the tier with its own
   * outcome, in the vocabulary the turn register already uses.
   */
  it("the YouTube turn closes tier 1 with its outcome when it ends empty-handed", () => {
    const at2 = PIPELINE.indexOf("const finish = (");
    const body = PIPELINE.slice(at2, PIPELINE.indexOf("\n  };", at2));
    expect(body).toContain('declineTier("YOUTUBE", outcome)');
    /** Never for an outcome that leaves the turn open — the beat may still get a real turn. */
    expect(body).toContain("!YOUTUBE_OUTCOME_LEAVES_TURN_OPEN.has(outcome) && !clip");
  });
});

/* ═════════════════ render 592-B: a route cannot be asked for what it lacks ═════════════════ */

describe("render 592-B — a tier no route can serve must not block the ones below it", () => {
  /**
   * The defect, in one sentence: `HISTORICAL_SOURCE_TIER_ORDER` has nine members, one of tier 1 and
   * eight of tier 3, and NO tier-2 member — so the cascade could never attempt the own archive, and
   * every one of its tier-3 members was refused for skipping it. Beats s2b4 and s2b5 ended with
   * twenty-four refusals each and `providers=0`: two sentences that asked nobody anything.
   */
  it("the historical cascade genuinely has no tier-2 member — this is why the rule was unsatisfiable", () => {
    const at2 = PIPELINE.indexOf("export const HISTORICAL_SOURCE_TIER_ORDER = [");
    const members = [...PIPELINE.slice(at2, PIPELINE.indexOf("] as const;", at2)).matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1]!);
    /** Nine before VIDEO 619 removed the six that never delivered to a film. */
    /** Two since the code audit took YouTube out of the cascade (it has its own turn). */
    expect(members.length).toBe(2);
    expect(members.some((m) => providerTier(m) === "OWN_ARCHIVE"), "add an archive member and this test should be revisited").toBe(false);
    expect(members.some((m) => providerTier(m) === "OPEN_SOURCES")).toBe(true);
  });


  /**
   * The declaration unlocks nothing on its own. A tier the route DOES serve still has to be
   * attempted, and stock still waits for everything above it — which is the whole point of the
   * ladder and the thing a careless fix here would destroy.
   */
  it("and it unlocks nothing on its own — the route's own tiers must still be walked in order", async () => {
    await resumeBeatSourcing(at(1), async () => {
      declineTiersNotServedBy(["youtube_cc", "internet_archive", "wikimedia"], "historical_cascade");

      /** Stock is refused: tier 1 is served by this route and has not been asked yet. */
      expect(admitProviderForTier("pexels").admitted, "stock ran before tier 1").toBe(false);
      /** And so is tier 3, for the same reason — the decline of tier 2 did not excuse tier 1. */
      expect(admitProviderForTier("wikimedia").admitted, "tier 3 ran before tier 1").toBe(false);

      /** Walk the route's own first tier, and the rest follows in order. */
      expect(admitProviderForTier("youtube_cc").admitted).toBe(true);
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
      /**
       * Stock is admitted only now, and note what the decline did NOT do: `NOT_SERVED_BY` says this
       * route has no stock member, not that stock is unavailable. A later stock fallback is a
       * different route and is not barred by it.
       */
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });

  it("the production cascade declares itself before it walks", () => {
    const at2 = PIPELINE.indexOf('declineTiersNotServedBy(HISTORICAL_SOURCE_TIER_ORDER, "historical_cascade")');
    expect(at2, "the cascade no longer declares what it cannot serve").toBeGreaterThan(-1);
    const walk = PIPELINE.indexOf("for (const tier of HISTORICAL_SOURCE_TIER_ORDER) {", at2);
    expect(walk, "the walk moved away from the declaration").toBeGreaterThan(at2);
    expect(walk - at2, "the declaration must sit immediately before the walk").toBeLessThan(1600);
  });

  it("the declaration is computed from the member list, not written down a second time", () => {
    const at2 = CENTRAL.indexOf("export function declineTiersNotServedBy");
    const body = CENTRAL.slice(at2, CENTRAL.indexOf("\n}\n", at2));
    expect(body).toContain("providerTier(p)");
    expect(body, "a hardcoded tier name is a second copy of the route's contents").not.toMatch(
      /"(YOUTUBE|OWN_ARCHIVE|OPEN_SOURCES|STOCK)"/
    );
  });

});

/* ═════════════════ C10–C14: no second authority ═════════════════ */

describe("there is still exactly one sourcing authority", () => {
  /** C10 */
  it("C10: every direct provider fetch sits inside a function whose search was gated", () => {
    /**
     * Every provider SEARCH reaches the network through `cachedProviderSearch`,
     * `admitProviderQuery` or `searchGateDecision`, and all three ask the ladder. What a count of
     * gate call-sites does not show is the handful of places that fetch a provider URL directly.
     *
     * The first version of this test asserted there were none, and passed — because its regex
     * required `await fetch(` on the same line as the URL and none of them are written that way.
     * A test that proves an absence by failing to look is worse than no test, so this one finds
     * them and classifies each instead.
     *
     * There were three, all DETAIL fetches in `fetchFlickrCCVideos` and `fetchNasaVideoClips`.
     * VIDEO 619 removed both providers, so there are none — and a new one must be classified.
     */
    const raw = [...PIPELINE.matchAll(/fetch\(\s*`?(https?:\/\/[^`"')\s]+)/g)]
      .map((m) => ({ url: m[1]!, line: PIPELINE.slice(0, m.index).split("\n").length }))
      .filter((f) =>
        /archive\.org|wikimedia|europeana|loc\.gov|nasa\.gov|flickr|sepiasearch|vimeo\.com|media\.ccc|openverse|gdeltproject|pexels|pixabay|unsplash|serpapi|catalog\.archives\.gov/.test(
          f.url
        )
      );
    expect(raw.length, "a new direct provider fetch appeared — classify it").toBe(0);
    for (const f of raw) {
      /** The enclosing function, and the gate its search passes. */
      const before = PIPELINE.slice(0, PIPELINE.indexOf(f.url));
      const fnStart = Math.max(
        before.lastIndexOf("\nasync function "),
        before.lastIndexOf("\nexport async function ")
      );
      const body = PIPELINE.slice(fnStart, PIPELINE.indexOf("\n}\n", fnStart));
      expect(
        /cachedProviderSearch\(|admitProviderQuery\(|searchGateDecision\(/.test(body),
        `${f.url} is fetched in a function whose search never passes a gate`
      ).toBe(true);
    }
  });

  /**
   * And the one outside the pipeline: re-resolving the current URL of an asset the render has
   * ALREADY adopted. A rehydration carries an asset id and no query — it finds nothing new, so it
   * spends no tier. Category A of §6, asserted rather than assumed.
   */
  it("rehydration re-resolves a known asset and never searches for a new one", () => {
    const deps = read("rehydrationDeps.ts");
    expect(deps).toContain("https://api.pexels.com/videos/videos/${encodeURIComponent(id)}");
    for (const searchy of ["/search?", "query=", "&q=", "?q="]) {
      expect(deps, `rehydration issues a search (${searchy})`).not.toContain(searchy);
    }
  });

  /** C11 */
  it("C11: every compose-time provider name has a valid tier", () => {
    const names = new Set<string>();
    for (const m of PIPELINE.matchAll(
      /(?:searchGateDecision|admitProviderQuery)\(\s*"([a-z_0-9]+)"/g
    )) {
      names.add(m[1]!);
    }
    /** `cachedProviderSearch` takes the cache first and the provider second, on its own line. */
    for (const m of PIPELINE.matchAll(/cachedProviderSearch\(\s*\w+,\s*"([a-z_0-9]+)"/g)) {
      names.add(m[1]!);
    }
    /** More than fourteen before VIDEO 619; five since the code audit removed the per-beat YouTube search. */
    expect(names.size, "no provider names found — the gate helpers were renamed").toBeGreaterThanOrEqual(5);
    for (const n of names) expect(providerTier(n), `${n} has no tier`).not.toBeNull();
  });

  /** C12 */
  it("C12: a compose-time asset keeps its provider and its provenance", () => {
    /**
     * The continuation rides on `withBeatProvenance`, so a compose-time acquisition carries the
     * same beat proof, the same query scope and the same planned shot as a beat-time one. That is
     * the mechanism, and this asserts it rather than re-proving the lineage ledger: a compose
     * rescue that lost provenance would be refused by SearchGate strict long before it downloaded.
     */
    const at2 = PIPELINE.indexOf("function withBeatProvenance<T>(");
    const body = PIPELINE.slice(at2, PIPELINE.indexOf("\n}\n", at2));
    expect(body).toContain("withQueryScope(");
    expect(body).toContain("beatSearchProvenance(");
    expect(body.indexOf("resumeBeatSourcing(")).toBeGreaterThan(body.indexOf("withQueryScope("));
  });

  /** C13 */
  it("C13: there is one sourcing orchestrator and one tier table", () => {
    const orchestrators = [...PIPELINE.matchAll(/export (?:async )?function run\w*Sourcing/g)];
    expect(orchestrators, "a second orchestrator was declared in the pipeline").toEqual([]);
    expect(CENTRAL).toContain("export async function runCentralVisualSourcing");
    expect(CENTRAL).toContain("export async function resumeBeatSourcing");
    /** Both are the SAME ladder type and the same gate — not two engines sharing a name. */
    expect(CENTRAL.match(/const ladderStore = new AsyncLocalStorage/g) ?? []).toHaveLength(1);
    expect(CENTRAL.match(/export function admitProviderForTier/g) ?? []).toHaveLength(1);
    expect(read("sourcingTiers.ts").match(/export const SOURCING_TIERS/g) ?? []).toHaveLength(1);
    expect(CENTRAL, "a second tier table in the orchestrator").not.toMatch(/PROVIDER_TIER\s*[:=]\s*\{/);
  });


});
