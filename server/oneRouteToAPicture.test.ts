/**
 * ONE ROUTE TO A PICTURE.
 *
 * ── What the integrity audit found ───────────────────────────────────────────────────────────
 *
 * The previous round put the tier ladder inside `resolveBeatClip` and called that "the production
 * entry for a beat's visual sourcing". It is not. It is the pipeline's THIRD route to a picture:
 *
 *     1. the retrieval funnel   scene-level search, winner adopted in the beat loop
 *     2. the scene pool         scene-level search, candidate downloaded in the beat loop
 *     3. resolveBeatClip        the cascade, reached only when 1 and 2 produced nothing
 *
 * Routes 1 and 2 ran with no ladder at all, and "no ladder" meant "always admitted". They are also
 * the routes that resolve most beats. So a Pexels clip could become a beat's picture with tiers 1,
 * 2 and 3 reading NOT_REACHED, and nothing in the render log would have said so.
 *
 * Three more authorities were deciding order beside the ladder:
 *
 *   · `scenePool.ts` held its own tier numbers, five of which disagreed with `sourcingTiers.ts`
 *     — europeana, openverse, nasa, nara and loc sat at 4, the tier of licensed stock.
 *   · `tierTasksByNeed` moved a whole tier up or down per scene, so a media-form preference could
 *     promote Pexels out of tier 4.
 *   · `HISTORICAL_SOURCE_TIER_ORDER` listed the Internet Archive (tier 3) ahead of YouTube (tier 1).
 *
 * And `searchLibraryOfCongressCandidates` reached the network with no search gate at all — the one
 * external provider in the pipeline whose queries nothing validated and nothing counted.
 *
 * ── What these tests hold ────────────────────────────────────────────────────────────────────
 *
 * Tests A–N of the round's brief, plus the source-level checks that keep the three authorities
 * from growing back. Where a test reads source text it says so and explains why behaviour alone
 * could not have caught that particular regression.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  admitProviderForTier,
  admitPoolCandidateTier,
  beginBeatSourcing,
  currentBeatLadder,
  declineTier,
  forgetSceneDiscovery,
  runCentralVisualSourcing,
  runSceneVisualDiscovery,
  sceneDiscoverySeed,
  resetUnscopedProviderSearches,
  unscopedProviderSearches,
  BUDGET_EXHAUSTED,
} from "./centralVisualSourcing";
import { PROVIDER_TIER, providerTier, tierNumber } from "./sourcingTiers";
import { poolTier } from "./scenePool";
import { tierTasksByNeed } from "./providerCapability";

const read = (f: string): string => readFileSync(path.join(__dirname, f), "utf8");
const PIPELINE = read("videoPipeline.ts");
const POOL = read("scenePool.ts");
const CONTRACT = read("searchQueryContract.ts");

const RENDER = "test-render";

/** Run `body` inside a beat ladder, the way the production beat loop opens one. */
async function onBeat(
  body: () => Promise<void> | void,
  opts: {
    declined?: Array<{ tier: Parameters<typeof declineTier>[0]; reason: string }>;
    seedAttempted?: Parameters<typeof beginBeatSourcing>[0]["seedAttempted"];
    beatIndex?: number;
  } = {}
): Promise<void> {
  await runCentralVisualSourcing(
    {
      renderId: RENDER,
      sceneIndex: 0,
      beatIndex: opts.beatIndex ?? 0,
      declined: opts.declined,
      seedAttempted: opts.seedAttempted,
    },
    async () => {
      await body();
    }
  );
}

beforeEach(() => {
  forgetSceneDiscovery(RENDER);
  resetUnscopedProviderSearches();
});

/* ═════════════════ A–E: the ladder itself ═════════════════ */

describe("the ladder decides which tier may run", () => {
  /** A — YouTube attempted → the archive may run. */
  it("A: a tier that has been attempted unlocks the one below it", async () => {
    await onBeat(() => {
      expect(admitProviderForTier("youtube").admitted).toBe(true);
      expect(admitProviderForTier("archive").admitted).toBe(true);
    });
  });

  /** B — YouTube not reached → the archive may NOT run. */
  it("B: a tier nobody asked for blocks the one below it", async () => {
    await onBeat(() => {
      const verdict = admitProviderForTier("archive");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) {
        expect(verdict.reason).toBe("TIER_OUT_OF_ORDER");
        expect(verdict.skipped).toEqual(["YOUTUBE"]);
      }
    });
  });

  /** C — YouTube explicitly declined → the archive may run. */
  it("C: a tier declined with a reason unlocks the one below it", async () => {
    await onBeat(
      () => {
        expect(admitProviderForTier("archive").admitted).toBe(true);
      },
      { declined: [{ tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" }] }
    );
  });

  /** D — the archive not reached → tier 3 may NOT run. */
  it("D: the open collections wait for the archive", async () => {
    await onBeat(
      () => {
        const verdict = admitProviderForTier("wikimedia");
        expect(verdict.admitted).toBe(false);
        if (!verdict.admitted) expect(verdict.skipped).toEqual(["OWN_ARCHIVE"]);
      },
      { declined: [{ tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" }] }
    );
  });

  /** E — tier 3 not reached → tier 4 may NOT run. */
  it("E: licensed stock waits for the open collections", async () => {
    await onBeat(
      () => {
        const verdict = admitProviderForTier("pexels");
        expect(verdict.admitted).toBe(false);
        if (!verdict.admitted) expect(verdict.skipped).toEqual(["OPEN_SOURCES"]);
      },
      {
        declined: [
          { tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" },
          { tier: "OWN_ARCHIVE", reason: "ARCHIVE_EMPTY" },
        ],
      }
    );
  });

  it("and the whole ladder walks in order when nothing is declined", async () => {
    await onBeat(() => {
      for (const p of ["youtube", "archive", "wikimedia", "pexels"]) {
        expect(admitProviderForTier(p).admitted, p).toBe(true);
      }
      expect([...(currentBeatLadder()?.attempted ?? [])]).toEqual([
        "YOUTUBE",
        "OWN_ARCHIVE",
        "OPEN_SOURCES",
        "STOCK",
      ]);
    });
  });
});

/* ═════════════════ F–G: rescues and fallbacks ═════════════════ */

describe("rescues and fallbacks obey the same ladder", () => {
  /**
   * F and G, as ONE mechanism rather than two.
   *
   * A rescue is not a different kind of caller — it is the same beat asking again. Since the
   * ladder is now opened around the whole beat rather than inside `resolveBeatClip`, a rescue
   * cannot help but inherit the beat's tier state, and the test that proves it is a nested scope
   * seeing what the outer one recorded.
   */
  it("F: a rescue running inside the beat inherits its tier state and cannot skip a tier", async () => {
    await onBeat(async () => {
      expect(admitProviderForTier("youtube").admitted).toBe(true);
      /** The rescue re-enters the SAME beat — the production shape of `resolveBeatClip`. */
      await runCentralVisualSourcing(
        { renderId: RENDER, sceneIndex: 0, beatIndex: 0 },
        async () => {
          expect(currentBeatLadder()?.attempted.has("YOUTUBE")).toBe(true);
          const verdict = admitProviderForTier("pexels");
          expect(verdict.admitted, "stock reached from a rescue with tiers 2 and 3 unasked").toBe(false);
        }
      );
    });
  });

  it("G: a stock fallback is refused until every tier above it is attempted or declined", async () => {
    await onBeat(async () => {
      expect(admitProviderForTier("pexels").admitted).toBe(false);
      expect(admitProviderForTier("youtube").admitted).toBe(true);
      expect(admitProviderForTier("archive").admitted).toBe(true);
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });

  /**
   * The wiring that makes F and G true of the real pipeline rather than of this file.
   *
   * Source-level, and it has to be: the beat loop is seventeen hundred lines inside a function
   * that needs a render, a scene, a work directory and a live provider set. What can be proven
   * here is that the ladder opens around the WHOLE beat and not around one route inside it, which
   * is exactly the defect this round was called to fix.
   */
  it("the production beat loop opens the ladder around the whole beat", () => {
    const at = PIPELINE.indexOf("for (let bi = 0; bi < beats.length; bi++) {", PIPELINE.indexOf("const renderIdForLadder"));
    expect(at, "the beat loop moved").toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 4000);
    expect(body).toContain("closeBeatLadder = beginBeatSourcing({");
    /** Opened before anything in the body can reach a provider. */
    expect(body.indexOf("beginBeatSourcing")).toBeLessThan(body.indexOf("const beatPulse"));
    /** And the previous beat's ladder is closed at the top, so a `continue` cannot leak it. */
    expect(body.indexOf("closeBeatLadder?.()")).toBeLessThan(body.indexOf("beginBeatSourcing"));
  });

  it("every route the beat loop can take is inside that one ladder", () => {
    const from = PIPELINE.indexOf("const renderIdForLadder");
    const to = PIPELINE.indexOf("closeBeatLadder?.();", PIPELINE.indexOf("} finally {", from));
    expect(to).toBeGreaterThan(from);
    const loop = PIPELINE.slice(from, to);
    /** The three routes, and the fallbacks after them. */
    for (const route of [
      "admitPoolCandidateTier(candidate.source)",
      "downloadAndTrimPoolCandidate(",
      "resolveBeatClip(",
      "fetchBeatStockFallback(",
    ]) {
      expect(loop, route).toContain(route);
    }
  });
});

/* ═════════════════ H: unknown providers ═════════════════ */

describe("an unplaced provider cannot slip past the ladder", () => {
  /** H — an unknown provider cannot bypass the ladder. */
  it("H: a provider the tier table has never heard of is refused inside a beat", async () => {
    await onBeat(() => {
      const verdict = admitProviderForTier("some_new_provider");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) {
        expect(verdict.reason).toBe("TIER_UNKNOWN_PROVIDER");
        expect(verdict.tier).toBeNull();
      }
    });
  });

  it("and it is never silently sorted into a tier it was not given", async () => {
    await onBeat(() => {
      admitProviderForTier("some_new_provider");
      expect(currentBeatLadder()?.attempted.size, "an unplaced name marked a tier attempted").toBe(0);
      expect(currentBeatLadder()?.unknown).toEqual(["some_new_provider"]);
    });
  });

  /**
   * The refusal above is only safe because no provider the pipeline actually uses is unplaced.
   * This reads every provider name production passes to the three gate helpers and checks the
   * table covers it — so adding a provider without placing it fails here rather than at runtime.
   */
  it("every provider the production gates are given has a tier", () => {
    const names = new Set<string>();
    for (const src of [PIPELINE, POOL, read("wikimediaGeoSearch.ts")]) {
      for (const m of src.matchAll(
        /(?:searchGateDecision|admitProviderQuery|cachedProviderSearch)\(\s*"([a-z_0-9]+)"/g
      )) {
        names.add(m[1]!);
      }
    }
    expect(names.size, "no gate call-sites found — the helpers were renamed").toBeGreaterThan(10);
    for (const name of names) {
      expect(providerTier(name), `${name} reaches a provider gate with no tier`).not.toBeNull();
    }
  });

  /** The provider that had no gate at all until the audit counted call-sites against the table. */
  it("the Library of Congress passes the search gate like every other provider", () => {
    const at = POOL.indexOf("export async function searchLibraryOfCongressCandidates(");
    expect(at).toBeGreaterThan(-1);
    const body = POOL.slice(at, POOL.indexOf("\n}\n", at));
    expect(body).toContain('searchGateDecision("loc"');
    /** Before the request, or the gate would be refusing a query already sent. */
    expect(body.indexOf('searchGateDecision("loc"')).toBeLessThan(body.indexOf("const searchUrl ="));
  });
});

/* ═════════════════ I–J: what happens to a candidate after it is found ═════════════════ */

describe("a pool candidate is spent through the ladder, not beside it", () => {
  /**
   * I — an adopted asset stays traceable, and J — a downstream rejection has a reason.
   *
   * The scene pool searches one scope up, so by the time a beat picks a candidate there is no
   * query left for the search gate to refuse. `admitPoolCandidateTier` is the same question asked
   * where the beat actually spends the tier, and a refusal here is a REASON rather than a silence.
   */
  it("I: a candidate from a scene pool is admitted once its tier is reachable", async () => {
    await onBeat(
      () => {
        expect(admitPoolCandidateTier("pexels").admitted).toBe(true);
      },
      { seedAttempted: ["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES"] }
    );
  });

  it("J: a refused candidate carries a machine-readable reason, never a silence", async () => {
    await onBeat(() => {
      const verdict = admitPoolCandidateTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) {
        expect(verdict.reason).toBe("TIER_OUT_OF_ORDER");
        expect(verdict.skipped.length).toBeGreaterThan(0);
      }
    });
  });

  it("and the pool's download loop asks before it downloads, not after", () => {
    const at = PIPELINE.indexOf("for (const candidate of poolCandidates) {");
    expect(at).toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 1800);
    expect(body.indexOf("admitPoolCandidateTier(candidate.source)")).toBeLessThan(
      body.indexOf("downloadAndTrimPoolCandidate(")
    );
    expect(body, "a refusal must be recorded like any other rejection").toContain("_poolFailReasons.push(reason)");
    /**
     * The condition itself, verbatim. Asserting only that the call and the download appear in the
     * right ORDER let a mutation that neutered the branch — `if (false && !tierVerdict.admitted)`
     * — survive: the call was still there, still first, and still decided nothing.
     */
    expect(body).toContain("if (!tierVerdict.admitted) {");
    expect(body).not.toMatch(/if \((?:false &&|true \|\|)[^)]*tierVerdict\.admitted/);
  });

  /**
   * The funnel asks BEFORE its concurrent transfers start rather than inside them.
   *
   * Three downloads running at once would ask the ladder at once, each seeing a different set of
   * attempted tiers, and the answer would depend on which request happened to arrive first. That
   * is not a hypothetical: `FUNNEL_DOWNLOAD_CONCURRENCY` is three.
   */
  it("and the funnel filters its download order sequentially, before the transfers", () => {
    const at = PIPELINE.indexOf("const tierAdmittedOrder: FunnelCandidate[] = [];");
    expect(at, "the funnel's ladder filter moved").toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 1600);
    expect(body).toContain("admitPoolCandidateTier(candidate.source)");
    expect(body.indexOf("admitPoolCandidateTier")).toBeLessThan(body.indexOf("pLimit(FUNNEL_DOWNLOAD_CONCURRENCY)"));
    /** And the verdict decides, rather than merely being computed — see the pool test above. */
    expect(body).toContain("if (verdict.admitted) {");
    expect(body).not.toMatch(/if \((?:true \|\||false &&)[^)]*verdict\.admitted/);
    expect(body, "a refused candidate must keep its place for a later beat").not.toContain(
      "usedFunnelCandidateIds.add"
    );
  });
});

/* ═════════════════ K: budget truthfulness ═════════════════ */

describe("running out of clock is not the same as running out of footage", () => {
  /** K — budget exhaustion is distinguishable from an explicit provider decline. */
  it("K: a budget decline reads as BUDGET_EXHAUSTED, never as a provider verdict", async () => {
    await onBeat(() => {
      declineTier("OPEN_SOURCES", BUDGET_EXHAUSTED);
      expect(currentBeatLadder()?.declined.get("OPEN_SOURCES")).toBe("BUDGET_EXHAUSTED");
      expect(currentBeatLadder()?.declined.get("YOUTUBE")).toBeUndefined();
    });
  });

  it("and the reason is a constant, so the budget path cannot invent a provider-shaped one", () => {
    const at = PIPELINE.indexOf('budgetAllows(dedup.beatBudget, scene.index, beat.index, "queries")');
    expect(at).toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 1600);
    expect(body).toContain("declineTier(tier, BUDGET_EXHAUSTED)");
    expect(body, "a literal would let this path drift from the constant").not.toContain(
      'declineTier(tier, "BUDGET_EXHAUSTED")'
    );
  });

  it("a budget decline still unlocks the tiers below, so a starved beat is not left empty", async () => {
    await onBeat(() => {
      for (const t of ["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES"] as const) {
        declineTier(t, BUDGET_EXHAUSTED);
      }
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });

  it("but an unasked tier is still NOT_REACHED, never quietly declined", async () => {
    await onBeat(() => {
      expect(currentBeatLadder()?.declined.size).toBe(0);
      expect(currentBeatLadder()?.attempted.size).toBe(0);
    });
  });
});

/* ═════════════════ L: no legacy routing authority ═════════════════ */

describe("nothing but the ladder decides the order", () => {
  /** L — no legacy routing path can independently choose a lower tier. */
  /**
   * `poolTier` is CALLED here, not merely read.
   *
   * The first version of this test checked the source of `poolTier` and the values in
   * `PROVIDER_TIER`, and a mutation that made `poolTier` return 4 for every tier-3 source — the
   * exact defect this round removed — survived both. A function that answers a question has to be
   * asked the question.
   */
  it("L: poolTier answers with the ladder's own number for every provider", () => {
    for (const source of Object.keys(PROVIDER_TIER)) {
      expect(poolTier(source), source).toBe(tierNumber(providerTier(source)!));
    }
    /** And an unplaced name goes strictly last rather than into a tier it was not given. */
    expect(poolTier("a_source_nobody_placed")).toBeGreaterThan(4);
  });

  it("L: the scene pool holds no tier numbers of its own", () => {
    expect(POOL, "a literal tier number is a second tier table").not.toMatch(
      /tasks\.push\(\{ tier: \d/
    );
    expect(POOL).toContain("export function poolTier(source: string): number {");
    const at = POOL.indexOf("export function poolTier(source: string): number {");
    const body = POOL.slice(at, POOL.indexOf("\n}\n", at));
    expect(body).toContain("providerTier(source)");
    expect(body, "an unplaced source must go last, not into a default tier").toContain(
      "SOURCING_TIERS.length + 1"
    );
  });

  it("the media-form preference can reorder within a tier and never across one", () => {
    const tasks = [
      { tier: 1, source: "youtube_cc" },
      { tier: 3, source: "wikimedia" },
      { tier: 4, source: "pexels" },
    ];
    for (const need of [
      { preferred: ["ARCHIVAL_FOOTAGE"], acceptable: [] },
      { preferred: ["B_ROLL"], acceptable: [] },
      { preferred: ["PHOTO"], acceptable: [] },
    ] as Array<Parameters<typeof tierTasksByNeed>[1]>) {
      for (const moved of tierTasksByNeed(tasks, need)) {
        const original = tasks.find((t) => t.source === moved.source)!;
        expect(
          Math.abs(moved.tier - original.tier),
          `${moved.source} left tier ${original.tier} for ${moved.tier}`
        ).toBeLessThan(1);
      }
    }
  });

  /**
   * THE ONE LEGACY LIST THIS ROUND LEFT ALONE, AND WHY THAT IS SAFE.
   *
   * `HISTORICAL_SOURCE_TIER_ORDER` still reads tier 3 before tier 1 — `internet_archive` ahead of
   * `youtube_cc`. I reordered it by tier and reverted that: F3-28 states the sequence as a
   * requirement and `videoPipeline.f328SourceCascade.test.ts` asserts it exactly, and the reorder
   * changed no runtime behaviour, because every search in the cascade passes the gate and the
   * ladder already refuses the out-of-order one.
   *
   * So the property to hold is not "the literal is sorted" but "the literal cannot decide". This
   * asserts that: every member is a placed provider, and the loop that walks them reaches the gate.
   */
  it("the historical cascade supplies members, and the ladder supplies the order", () => {
    const at = PIPELINE.indexOf("export const HISTORICAL_SOURCE_TIER_ORDER = [");
    expect(at, "the historical cascade moved").toBeGreaterThan(-1);
    const members = [...PIPELINE.slice(at, PIPELINE.indexOf("] as const;", at)).matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1]!);
    expect(members.length, "a source was dropped from the cascade").toBe(9);
    for (const m of members) expect(providerTier(m), `${m} is unplaced`).not.toBeNull();

    /**
     * The list is out of tier order, which is exactly why the ladder has to be the one deciding.
     * If someone ever sorts it, this test should be revisited rather than silently pass.
     */
    const declared = members.map((m) => tierNumber(providerTier(m)!));
    expect(
      declared.some((t, i) => i > 0 && t < declared[i - 1]!),
      "the literal is now in tier order — reconcile this test with F3-28"
    ).toBe(true);

    /** And a beat refuses the first member until tier 1 is attempted or declined. */
    expect(members[0]).toBe("internet_archive");
    expect(tierNumber(providerTier("internet_archive")!)).toBe(3);
  });

  it("so a historical beat cannot reach the Internet Archive before YouTube", async () => {
    await onBeat(() => {
      expect(admitProviderForTier("internet_archive").admitted).toBe(false);
      expect(admitProviderForTier("youtube_cc").admitted).toBe(true);
    });
  });

  /**
   * The audit's own measure: how much provider traffic still runs with no scope at all.
   *
   * This is a counter rather than a refusal because a warm-up and a test legitimately have no
   * scope. What it must never become is invisible again — the previous round's silent "no ladder
   * means admitted" is exactly how three scene-level routes stayed outside the architecture.
   */
  it("a provider search with no scope is admitted but counted", () => {
    expect(admitProviderForTier("pexels").admitted).toBe(true);
    expect(unscopedProviderSearches()).toEqual({ pexels: 1 });
  });
});

/* ═════════════════ M–N: the same route for every subject and every length ═════════════════ */

describe("one route, whatever the video is about and however long it is", () => {
  /** M — all subjects use the same central route. */
  it("M: the ladder holds no topic, no subject and no era", () => {
    /**
     * Provider names are not topics, so `nasa` and `loc` are expected here — they are rows in the
     * tier table. What must never appear is a SUBJECT: a person, a war, a genre. A ladder that
     * knows what the video is about is a ladder with a route per topic.
     */
    const CENTRAL = read("centralVisualSourcing.ts") + read("sourcingTiers.ts");
    for (const word of ["hitler", "kardashian", "wwii", "ww2", "1945", "sport", "politic", "celebrit"]) {
      expect(CENTRAL.toLowerCase(), `the ladder mentions "${word}"`).not.toContain(word);
    }
  });

  it("and the same tier order is returned no matter what the beat is about", async () => {
    const walked: string[][] = [];
    for (const beatIndex of [0, 1, 2]) {
      await onBeat(
        () => {
          const order: string[] = [];
          for (const p of ["pexels", "wikimedia", "archive", "youtube"]) {
            if (admitProviderForTier(p).admitted) order.push(p);
          }
          walked.push(order);
        },
        { beatIndex }
      );
    }
    /** The provider names are the same three times over: the ladder is not reading the subject. */
    expect(walked[1]).toEqual(walked[0]);
    expect(walked[2]).toEqual(walked[0]);
  });

  /** N — video length does not change source capability. */
  it("N: no capability, tier or provider is a function of video length", () => {
    const CENTRAL = read("centralVisualSourcing.ts") + read("sourcingTiers.ts");
    for (const word of ["videoLength", "isShortVideoLength", "durationMinutes", "targetVideoDuration"]) {
      expect(CENTRAL, `the ladder reads ${word}`).not.toContain(word);
    }
    const at = POOL.indexOf("export function poolTier(source: string): number {");
    const body = POOL.slice(at, POOL.indexOf("\n}\n", at));
    expect(body).not.toContain("videoLength");
  });

  it("and every provider in the table is placed exactly once", () => {
    const names = Object.keys(PROVIDER_TIER);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(providerTier(name)).not.toBeNull();
  });
});

/* ═════════════════ the scene scope: discovery is not a decision ═════════════════ */

describe("a scene asks everything; a beat chooses in order", () => {
  it("a scene-level discovery enforces no order — asking everything skips nothing", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 3 }, async () => {
      expect(admitProviderForTier("pexels").admitted, "stock refused during discovery").toBe(true);
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
    });
  });

  it("but it writes down which tiers it really asked, and the beats inherit that", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 3 }, async () => {
      admitProviderForTier("youtube");
      admitProviderForTier("archive");
      admitProviderForTier("wikimedia");
    });
    const seed = sceneDiscoverySeed(RENDER, 3);
    expect(seed?.attempted.sort()).toEqual(["OPEN_SOURCES", "OWN_ARCHIVE", "YOUTUBE"]);
  });

  it("a tier the scene never asked is NOT inherited as attempted", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 4 }, async () => {
      admitProviderForTier("pexels");
    });
    const seed = sceneDiscoverySeed(RENDER, 4);
    expect(seed?.attempted).toEqual(["STOCK"]);
    /** And a beat seeded with that alone still cannot reach stock without the tiers above. */
    await onBeat(() => {
      expect(admitProviderForTier("pexels").admitted).toBe(false);
    });
  });

  it("two discoveries of one scene are merged, never replaced", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 5 }, async () => {
      admitProviderForTier("youtube");
    });
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 5 }, async () => {
      admitProviderForTier("archive");
    });
    expect(sceneDiscoverySeed(RENDER, 5)?.attempted.sort()).toEqual(["OWN_ARCHIVE", "YOUTUBE"]);
  });

  it("and a render's discoveries are released with the render", async () => {
    await runSceneVisualDiscovery({ renderId: RENDER, sceneIndex: 6 }, async () => {
      admitProviderForTier("youtube");
    });
    expect(sceneDiscoverySeed(RENDER, 6)).toBeDefined();
    forgetSceneDiscovery(RENDER);
    expect(sceneDiscoverySeed(RENDER, 6)).toBeUndefined();
    expect(PIPELINE, "the render never releases them").toContain(
      'forgetSceneDiscovery(String(videoId ?? "-"))'
    );
  });

  it("the production funnel and pool both build inside a scene scope", () => {
    for (const call of ["buildRetrievalFunnel({", "buildSceneCandidatePool({"]) {
      let from = 0;
      let seen = 0;
      for (;;) {
        const at = PIPELINE.indexOf(call, from);
        if (at < 0) break;
        seen++;
        const before = PIPELINE.slice(Math.max(0, at - 300), at);
        expect(before, `${call} #${seen} builds outside a scene scope`).toContain(
          "runSceneVisualDiscovery("
        );
        from = at + call.length;
      }
      expect(seen, `${call} not found`).toBe(2);
    }
  });
});

/* ═════════════════ the beat scope: one ladder, closed exactly once ═════════════════ */

describe("one ladder per beat", () => {
  it("re-entering the same beat reuses its ladder instead of resetting it", async () => {
    await onBeat(async () => {
      admitProviderForTier("youtube");
      await runCentralVisualSourcing(
        { renderId: RENDER, sceneIndex: 0, beatIndex: 0 },
        async () => {
          expect(currentBeatLadder()?.attempted.has("YOUTUBE")).toBe(true);
        }
      );
    });
  });

  it("a different beat gets its own ladder", async () => {
    await onBeat(async () => {
      admitProviderForTier("youtube");
      await runCentralVisualSourcing(
        { renderId: RENDER, sceneIndex: 0, beatIndex: 1 },
        async () => {
          expect(currentBeatLadder()?.attempted.has("YOUTUBE")).toBe(false);
        }
      );
    });
  });

  it("the closer leaves no ladder behind for whatever runs after the beat", () => {
    const close = beginBeatSourcing({ renderId: RENDER, sceneIndex: 0, beatIndex: 9 });
    expect(currentBeatLadder()?.beatIndex).toBe(9);
    close();
    expect(currentBeatLadder()).toBeUndefined();
    /** And calling it twice is harmless — the beat loop calls it from two places. */
    close();
    expect(currentBeatLadder()).toBeUndefined();
  });

  it("the search gate carries the ladder's own reason rather than a hardcoded one", () => {
    const at = CONTRACT.indexOf("export function searchGateDecision(");
    const body = CONTRACT.slice(at, CONTRACT.indexOf("\n}\n", at));
    expect(body).toContain("tierVerdict.reason");
    expect(body).not.toContain('"TIER_OUT_OF_ORDER"');
  });
});
