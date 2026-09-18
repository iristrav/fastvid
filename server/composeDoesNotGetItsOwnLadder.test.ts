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
  /** C5 */
  it("C5: compose inherits exactly what the beat attempted and declined", async () => {
    walkBeatLoopIteration(0, () => {
      declineTier("YOUTUBE", "ENTITY_CEILING_SPENT");
      admitProviderForTier("archive");
    });
    await resumeBeatSourcing(at(), async () => {
      const ladder = currentBeatLadder()!;
      expect(ladder.attempted.has("OWN_ARCHIVE")).toBe(true);
      expect(ladder.declined.get("YOUTUBE")).toBe("ENTITY_CEILING_SPENT");
      expect(ladder.attempted.has("OPEN_SOURCES"), "tier 3 was never asked").toBe(false);
    });
  });

  /** C6 */
  it("C6: a beat with no remembered ladder starts strict, not with the higher tiers declined", async () => {
    await resumeBeatSourcing(at(7), async () => {
      const ladder = currentBeatLadder()!;
      expect(ladder.attempted.size, "a fresh compose ladder claimed attempts").toBe(0);
      expect(ladder.declined.size, "a fresh compose ladder declined tiers nobody decided on").toBe(0);
      expect(admitProviderForTier("pexels").admitted).toBe(false);
    });
  });

  it("and it says so, rather than opening one silently", () => {
    const at2 = CENTRAL.indexOf("export async function resumeBeatSourcing");
    const body = CENTRAL.slice(at2, CENTRAL.indexOf("\n}\n", at2));
    expect(body).toContain("LADDER_OPENED_AT_COMPOSE");
    expect(body, "a fresh compose ladder must not seed itself with declines").not.toContain(
      "declineTier("
    );
  });

  it("the beat's own ladder is what compose resumes — the same object, not a copy", async () => {
    walkBeatLoopIteration(0, () => {
      admitProviderForTier("youtube");
    });
    const remembered = rememberedLadderFor(RENDER, 0, 0);
    expect(remembered).toBeDefined();
    await resumeBeatSourcing(at(), async () => {
      expect(currentBeatLadder()).toBe(remembered);
    });
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

  /**
   * The case a mutation caught: `if (open) return run()` — simpler, and wrong.
   *
   * The compose stage iterates beats while one beat's ladder may still be ambient (the scene
   * backfill runs inside `fetchSceneVisualsInner`, whose last beat has only just closed, and a
   * rescue helper can be called for a neighbour). Riding whatever ladder happens to be open would
   * let beat B spend beat A's attempts — the ladder would be per-render-moment instead of per-beat.
   */
  it("a resume for a DIFFERENT beat switches ladders instead of riding the open one", async () => {
    const closeA = beginBeatSourcing(at(0));
    try {
      admitProviderForTier("youtube");
      admitProviderForTier("archive");
      admitProviderForTier("wikimedia");
      expect(currentBeatLadder()?.beatIndex).toBe(0);
      await resumeBeatSourcing(at(1), async () => {
        expect(currentBeatLadder()?.beatIndex, "beat 1 ran inside beat 0's ladder").toBe(1);
        expect(
          admitProviderForTier("pexels").admitted,
          "beat 1 spent beat 0's attempts to reach stock"
        ).toBe(false);
      });
      /** And beat 0 is still the ambient one afterwards, unharmed. */
      expect(currentBeatLadder()?.beatIndex).toBe(0);
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    } finally {
      closeA();
    }
  });

  it("re-entering the beat that is already open is not a continuation", async () => {
    const close = beginBeatSourcing(at(0));
    try {
      await resumeBeatSourcing(at(0), async () => {
        const ladder = currentBeatLadder()!;
        expect(ladder.loopClosed, "the loop marked itself closed while still running").toBe(false);
        admitProviderForTier("youtube");
        expect(ladder.composeSearches, "the loop charged itself a continuation").toBe(0);
      });
    } finally {
      close();
    }
  });

  it("a scene's discovery is left alone — it is not a beat continuing", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 0 }, async () => {
      await resumeBeatSourcing(at(3), async () => {
        expect(currentBeatLadder()?.kind).toBe("scene");
      });
    });
    expect(rememberedLadderFor(RENDER, 0, 3), "discovery opened a beat ladder").toBeUndefined();
  });
});

/* ═════════════════ C7–C8: only sourcing needs authorisation ═════════════════ */

describe("transformation is not sourcing", () => {
  /**
   * C7 — a pure transformation of an already-adopted asset asks the ladder nothing.
   *
   * Proven where the distinction is actually made: the functions that transform or re-select an
   * asset the render already holds — `adoptBestSimilarBeatClip`, `rescueFastShortComposeClips`,
   * `adoptArchiveBeatClip`, `trySubjectFallbackForBeat` — contain no provider call at all, so
   * nothing in them can reach the gate. The audit checked every one against the provider list.
   */
  it("C7: the compose functions that only reuse existing assets call no provider", () => {
    const providerCalls = [
      "fetchPexels", "fetchPixabay", "fetchWikimedia", "fetchInternetArchive",
      "fetchNasa", "fetchNara", "fetchEuropeana", "fetchFlickr", "fetchOpenverse",
      "searchGateDecision(", "admitProviderQuery(", "cachedProviderSearch(",
    ];
    for (const fn of [
      "adoptBestSimilarBeatClip",
      "rescueFastShortComposeClips",
      "trySubjectFallbackForBeat",
    ]) {
      const start = PIPELINE.indexOf(`async function ${fn}(`);
      expect(start, `${fn} moved`).toBeGreaterThan(-1);
      const body = PIPELINE.slice(start, PIPELINE.indexOf("\n}\n", start));
      for (const call of providerCalls) {
        expect(body, `${fn} acquires a new external visual via ${call}`).not.toContain(call);
      }
    }
  });

  /**
   * C8 — every function that DOES acquire a new external visual runs inside the sourcing scope.
   *
   * These seven are the complete set of provider-touching beat leaves; the audit found them by
   * matching every provider fetcher against every function body. Each is wrapped in
   * `withBeatProvenance`, which now carries the ladder continuation — or, for `beatPrimaryFetch`,
   * opens the same scope directly.
   */
  it("C8: every provider-touching beat leaf runs inside the central sourcing scope", () => {
    const leaves = [
      "fetchBeatStockFallbackInner",
      "adoptStockBeatClipFallbackInner",
      "adoptEmergencyGeoStockClipInner",
      "fetchLastResortRealClipInner",
      "rescueBeatVisualWhenEmptyInner",
    ];
    for (const leaf of leaves) {
      const call = `withBeatProvenance(beat, scene, () => ${leaf}(`;
      expect(PIPELINE, `${leaf} is not behind withBeatProvenance`).toContain(call);
    }
    /** And the one that opens its provenance itself carries the continuation itself. */
    const at2 = PIPELINE.indexOf("async function beatPrimaryFetch(");
    const body = PIPELINE.slice(at2, PIPELINE.indexOf("\n}\n", at2));
    expect(body).toContain("resumeBeatSourcing(");
    expect(body.indexOf("resumeBeatSourcing(")).toBeLessThan(body.indexOf("beatPrimaryFetchInner("));
  });

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
  /** C9 */
  it("C9: a beat's own budget stop still reads BUDGET_EXHAUSTED", async () => {
    await resumeBeatSourcing(at(), async () => {
      declineTier("OPEN_SOURCES", BUDGET_EXHAUSTED);
      expect(currentBeatLadder()?.declined.get("OPEN_SOURCES")).toBe("BUDGET_EXHAUSTED");
    });
  });

  /**
   * ── RENDER 592: THE BUDGET COUNTED THE WRONG THING ──────────────────────────────────────────
   *
   * It charged one unit per SCOPE ENTRY, and a scope is entered once per provider-touching leaf.
   * `fillBeatVisual` walks three of them and `refillSceneStrictVoiceMatch` four, so a single rescue
   * round spent a budget meant to bound several — 931 refusals on `entries=4 cap=3`.
   *
   * Walking the leaves is free now; asking a provider is what costs. This is that test: several
   * continuations that search nothing spend nothing.
   */
  it("walking several compose leaves without searching spends no budget", async () => {
    const cap = 2;
    for (let i = 0; i < 6; i++) {
      await resumeBeatSourcing({ ...at(), maxComposeSearches: cap }, async () => {
        expect(currentBeatLadder()?.composeBudgetSpent).toBe(false);
      });
    }
    expect(rememberedLadderFor(RENDER, 0, 0)?.composeSearches).toBe(0);
  });

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

  /**
   * Spending the continuation budget REFUSES; it must not decline a tier, because a decline
   * unlocks everything below it — which would turn running out of budget into a licence for stock.
   */
  it("and spending it declines no tier, so it cannot become a licence for stock", async () => {
    walkBeatLoopIteration(0, () => {
      for (const p of ["youtube", "archive", "wikimedia"]) admitProviderForTier(p);
    });
    await resumeBeatSourcing({ ...at(), maxComposeSearches: 1 }, async () => {
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
      const ladder = currentBeatLadder()!;
      expect(admitProviderForTier("pexels").admitted).toBe(false);
      expect(ladder.composeBudgetSpent).toBe(true);
      expect(ladder.declined.size).toBe(0);
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
  /**
   * DEFECT 1 — the ladder held back the archives and waved the stock through.
   *
   * Render 592's scenes were built by the funnel, which searches tiers 2, 3 and 4 at scene level
   * and does NOT search YouTube. Every beat therefore opened `1=NOT_REACHED 2=ATTEMPTED
   * 3=ATTEMPTED 4=ATTEMPTED`, and ninety-nine tier-3 queries — Internet Archive, Wikimedia,
   * SepiaSearch, Europeana, GDELT, media.ccc, Openverse — were refused for skipping a tier 1 that
   * nothing was going to ask. Not one Pexels or Pixabay query was refused.
   *
   * `tierMayRun`'s own docstring said "same tier … is always allowed" from the first version. The
   * code never did it.
   */
  it("a tier already attempted admits its next query, even with a higher tier unreached", async () => {
    await resumeBeatSourcing(
      { ...at(), seedAttempted: ["OWN_ARCHIVE", "OPEN_SOURCES", "STOCK"] },
      async () => {
        const ladder = currentBeatLadder()!;
        expect(ladder.attempted.has("YOUTUBE"), "tier 1 was never asked").toBe(false);
        for (const p of ["internet_archive", "wikimedia", "sepiasearch", "europeana", "gdelt_tv"]) {
          expect(admitProviderForTier(p).admitted, `${p} refused while tier 3 is attempted`).toBe(true);
        }
        expect(ladder.refusals, "a re-ask of an attempted tier was counted as out of order").toEqual([]);
      }
    );
  });

  it("but a tier opened for the FIRST time still waits for the one above it", async () => {
    await resumeBeatSourcing({ ...at(1), seedAttempted: ["OWN_ARCHIVE"] }, async () => {
      /** Tier 3 is untouched and tier 1 unreached — the refusal this rule exists for. */
      const verdict = admitProviderForTier("wikimedia");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.skipped).toEqual(["YOUTUBE"]);
    });
  });

  /**
   * DEFECT 3 — a compose-opened ladder knew none of the render's facts.
   *
   * `beatSourcingDeclines` needs the render's state and `withBeatProvenance` has no access to it,
   * so a beat the loop never reached opened with nothing declined and sat at `1=NOT_REACHED`
   * forever. The loop records them once; a later continuation reads them back.
   */
  it("a ladder opened at compose time inherits the render's declines", async () => {
    walkBeatLoopIteration(0, () => {});
    /** The loop recorded the render's declines when it opened beat 0. */
    const close = beginBeatSourcing({
      ...at(0),
      declined: [{ tier: "YOUTUBE", reason: "ENABLE_YOUTUBE_SOURCING_OFF" }],
    });
    close();
    await resumeBeatSourcing(at(5), async () => {
      const ladder = currentBeatLadder()!;
      expect(ladder.declined.get("YOUTUBE")).toBe("ENABLE_YOUTUBE_SOURCING_OFF");
      expect(admitProviderForTier("archive").admitted, "tier 2 still blocked by a declined tier 1").toBe(
        true
      );
    });
  });

  it("and those declines are released with the render", async () => {
    const close = beginBeatSourcing({
      ...at(0),
      declined: [{ tier: "YOUTUBE", reason: "ENABLE_YOUTUBE_SOURCING_OFF" }],
    });
    close();
    forgetRenderSourcing(RENDER);
    await resumeBeatSourcing(at(5), async () => {
      expect(currentBeatLadder()?.declined.size, "a dead render's declines outlived it").toBe(0);
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
     * There are three in the pipeline, and all three are DETAIL fetches: `fetchFlickrCCVideos`
     * resolves the sizes of a photo its gated search already returned, and `fetchNasaVideoClips`
     * reads the asset manifest of an item its gated search already returned. Neither introduces a
     * new query, so neither is a new sourcing decision — the tier was spent on the search.
     */
    const raw = [...PIPELINE.matchAll(/fetch\(\s*`?(https?:\/\/[^`"')\s]+)/g)]
      .map((m) => ({ url: m[1]!, line: PIPELINE.slice(0, m.index).split("\n").length }))
      .filter((f) =>
        /archive\.org|wikimedia|europeana|loc\.gov|nasa\.gov|flickr|sepiasearch|vimeo\.com|media\.ccc|openverse|gdeltproject|pexels|pixabay|unsplash|serpapi|catalog\.archives\.gov/.test(
          f.url
        )
      );
    expect(raw.length, "a new direct provider fetch appeared — classify it").toBe(3);
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
    expect(names.size, "no provider names found — the gate helpers were renamed").toBeGreaterThan(14);
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

  /** C14 */
  it("C14: no compose path can turn an unreached tier into a decline", async () => {
    await resumeBeatSourcing(at(9), async () => {
      const ladder = currentBeatLadder()!;
      expect(ladder.declined.size).toBe(0);
      /** And the refusal names the tiers that are unreached, rather than swallowing them. */
      const verdict = admitProviderForTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) {
        expect(verdict.skipped).toEqual(["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES"]);
      }
      expect(ladder.declined.size, "a refusal quietly became a decline").toBe(0);
    });
  });

  it("and a render releases its beat ladders when its visuals are done", async () => {
    walkBeatLoopIteration(0, () => {
      admitProviderForTier("youtube");
    });
    expect(rememberedLadderFor(RENDER, 0, 0)).toBeDefined();
    forgetRenderSourcing(RENDER);
    expect(rememberedLadderFor(RENDER, 0, 0)).toBeUndefined();
    expect(PIPELINE).toContain('forgetRenderSourcing(String(videoId ?? "-"))');
  });
});
