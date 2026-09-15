/**
 * RETRIEVAL IN TIERS — AND THE TRADE IT MAKES, TESTED RATHER THAN ASSERTED.
 *
 * The pool asked eleven providers at once, so a scene cost the SLOWEST of them. Tiers cost the SUM
 * of the tiers actually visited — worse for a scene that must reach the last one, and exactly the
 * shape RONDE 3's guard was written against when Library of Congress made 51 sequential calls and
 * took 150 seconds.
 *
 * What pays for it is the early exit: a scene whose first tier already has material never asks the
 * rest. These tests exist because that is a claim about BEHAVIOUR, and the pool's own providers are
 * imported rather than injected — a test of the ordering inside `buildSceneCandidatePool` would
 * have to make real HTTP calls. The rule lives in a pure function so "tier 2 is not asked" is a
 * fact that can be proven instead of a string that can be matched.
 */
import { describe, expect, it } from "vitest";
import {
  CANDIDATES_WANTED_PER_BEAT,
  enoughForEveryBeat,
  runTieredRetrieval,
  type RetrievalTask,
} from "./tieredRetrieval";

/** Records the order in which sources are actually asked. */
const spy = () => {
  const asked: string[] = [];
  const task = (tier: number, source: string, delayMs = 0): RetrievalTask<string> => ({
    tier,
    source,
    run: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      asked.push(source);
      return source;
    },
  });
  return { asked, task };
};

/** The operator's order: YouTube, their own archive, IA + Wikimedia, then everything else. */
const fourTiers = (s: ReturnType<typeof spy>) => [
  s.task(1, "youtube_cc"),
  s.task(2, "archive"),
  s.task(3, "internet_archive"),
  s.task(3, "wikimedia"),
  s.task(4, "pexels"),
  s.task(4, "loc"),
];

describe("1. tiers are asked in order, and only as far as needed", () => {
  it("a satisfied first tier means the other three are never asked", async () => {
    const s = spy();
    const r = await runTieredRetrieval({
      tasks: fourTiers(s),
      onTierResults: () => {},
      satisfied: () => s.asked.length >= 1,
    });
    expect(s.asked).toEqual(["youtube_cc"]);
    expect(r.tiersRun).toBe(1);
    expect(r.tiersSkipped).toEqual([2, 3, 4]);
    expect(r.stoppedEarly).toBe(true);
  });

  it("an unsatisfied run reaches every tier, in order", async () => {
    const s = spy();
    const r = await runTieredRetrieval({
      tasks: fourTiers(s),
      onTierResults: () => {},
      satisfied: () => false,
    });
    expect(s.asked.slice(0, 2)).toEqual(["youtube_cc", "archive"]);
    expect(new Set(s.asked.slice(2, 4))).toEqual(new Set(["internet_archive", "wikimedia"]));
    expect(r.tiersRun).toBe(4);
    expect(r.stoppedEarly).toBe(false);
  });

  /**
   * THE PROPERTY RONDE 3 EXISTS FOR. Within a tier the members run together — a slow neighbour
   * must not serialise the others, which is what turned 51 Library of Congress calls into 150
   * seconds. Tier 3's two members are timed to prove they overlap.
   */
  it("members of one tier run together, not one after another", async () => {
    const s = spy();
    const t0 = Date.now();
    await runTieredRetrieval({
      tasks: [s.task(3, "internet_archive", 40), s.task(3, "wikimedia", 40)],
      onTierResults: () => {},
    });
    expect(Date.now() - t0, "40ms each, run together — serial would be 80+").toBeLessThan(75);
  });

  /** And a tier is never abandoned half-way: work already paid for is collected. */
  it("satisfaction is checked between tiers, never inside one", async () => {
    const s = spy();
    await runTieredRetrieval({
      tasks: [s.task(3, "internet_archive"), s.task(3, "wikimedia")],
      onTierResults: () => {},
      satisfied: () => true,
    });
    expect(s.asked).toHaveLength(2);
  });
});

describe("2. a broken provider does not take its tier down", () => {
  it("its neighbours' results still arrive", async () => {
    const seen: string[] = [];
    await runTieredRetrieval<string>({
      tasks: [
        { tier: 1, source: "a", run: async () => { throw new Error("429"); } },
        { tier: 1, source: "b", run: async () => "b" },
      ],
      onTierResults: (results) => {
        for (const r of results) if (r.status === "fulfilled") seen.push(r.value);
      },
    });
    expect(seen).toEqual(["b"]);
  });

  it("and the failure is reported rather than swallowed", async () => {
    const lines: string[] = [];
    await runTieredRetrieval<string>({
      tasks: [{ tier: 1, source: "a", run: async () => { throw new Error("nope"); } }],
      onTierResults: () => {},
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("failed=1");
  });

  /** A tier that failed entirely is not "satisfied" — the run continues to the next one. */
  it("a tier that returned nothing does not end the run", async () => {
    const s = spy();
    const r = await runTieredRetrieval<string>({
      tasks: [
        { tier: 1, source: "a", run: async () => { throw new Error("down"); } },
        ...fourTiers(s).filter((t) => t.tier > 1),
      ],
      onTierResults: () => {},
      satisfied: () => s.asked.length > 0,
    });
    expect(s.asked).toContain("archive");
    expect(r.tiersRun).toBeGreaterThan(1);
  });
});

describe("3. 'enough' is the true, weaker claim", () => {
  /**
   * THE HONESTY THAT MATTERED MOST HERE. At pool-build time no candidate has been matched to a
   * sentence: the subject screen, the ranking and the picture editor all run afterwards and any of
   * them may refuse. So having candidates enough is NECESSARY for covering a scene and never proof
   * that it is covered — and the function is named for what it measures.
   */
  it("it is named for what it measures, not for what we wish it meant", async () => {
    const src = (await import("fs")).readFileSync(
      (await import("path")).join(__dirname, "tieredRetrieval.ts"), "utf8"
    );
    expect(src).toContain("export function enoughForEveryBeat");
    expect(src, "a coverage claim would be false at this point in the pipeline")
      .not.toContain("export function sceneIsCovered");
  });

  it("enough means headroom per sentence, not one apiece", () => {
    expect(CANDIDATES_WANTED_PER_BEAT).toBeGreaterThan(1);
    expect(enoughForEveryBeat({ beatCount: 4, distinctCandidates: 4 })).toBe(false);
    expect(
      enoughForEveryBeat({ beatCount: 4, distinctCandidates: 4 * CANDIDATES_WANTED_PER_BEAT })
    ).toBe(true);
  });

  /**
   * A caller that does not say how many sentences it has cannot be told it has enough for them.
   * Guessing would turn a missing fact into a confident early exit — the failure this pipeline
   * keeps paying for.
   */
  it("an unknown beat count never satisfies, so every tier runs", () => {
    expect(enoughForEveryBeat({ distinctCandidates: 9999 })).toBe(false);
    expect(enoughForEveryBeat({ beatCount: 0, distinctCandidates: 9999 })).toBe(false);
    expect(enoughForEveryBeat({ beatCount: NaN, distinctCandidates: 9999 })).toBe(false);
  });

  it("and the caller may ask for different headroom", () => {
    expect(enoughForEveryBeat({ beatCount: 2, distinctCandidates: 2, perBeat: 1 })).toBe(true);
  });
});

describe("4. the pool uses it, on the operator's order", () => {
  const POOL = (): string =>
    require("fs").readFileSync(require("path").join(__dirname, "scenePool.ts"), "utf8");

  it("YouTube first, the operator's archive second", () => {
    const src = POOL();
    expect(src).toMatch(/tasks\.push\(\{ tier: 1, source: "youtube_cc"/);
    expect(src).toMatch(/tasks\.push\(\{ tier: 2, source: "archive"/);
  });

  it("Internet Archive and Wikimedia share the third", () => {
    const src = POOL();
    expect(src).toMatch(/tasks\.push\(\{ tier: 3, source: "internet_archive"/);
    expect(src).toMatch(/tasks\.push\(\{ tier: 3, source: "wikimedia"/);
  });

  it("and everything else is the fourth", () => {
    const src = POOL();
    for (const s of ["pexels", "pixabay", "europeana", "openverse", "nasa", "nara", "loc"]) {
      expect(src, s).toMatch(new RegExp(`tasks\\.push\\(\\{ tier: 4, source: "${s}"`));
    }
  });

  /** Without a beat count the run cannot stop early, so the render has to supply one. */
  it("the render tells the pool how many sentences the scene has", () => {
    const pipe = require("fs").readFileSync(
      require("path").join(__dirname, "videoPipeline.ts"), "utf8"
    );
    expect(pipe).toContain("beatCount: beats.length,");
  });
});
