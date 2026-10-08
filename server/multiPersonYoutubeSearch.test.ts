import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { claimYoutubeSearch, MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { MAX_STOCK_VIDEOS, STOCK_FIRST_BATCH, stockOrder } from "./youtubeShotStock";
import { queryNames, type GateVerdict } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  formatMultiPersonOutcome,
  namedSubjectCoverage,
  poolRowsForBeat,
  type NamedSubject,
  type PoolDeps,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import {
  beatNamedEntitiesByKind,
  extractPersonNamesFromText,
  MAX_RESCUE_STOCK_PER_SUBJECT,
  MAX_RESCUE_STOCK_VIDEOS,
  youtubeRescueCandidates,
} from "./videoPipeline";

/**
 * MULTI-PERSON YOUTUBE SEARCH — one search for the video's main subject, then one targeted search
 * ("[NAME] footage") per named person or entity the pool cannot show, most important first, while
 * the budget of MAX_YOUTUBE_SEARCHES_PER_VIDEO lasts. Every targeted answer goes through the same
 * look, is stocked first (at most 2 per subject, 3 in all, within the stock of 6) and reaches its
 * sentence through the same chain as every other YouTube candidate.
 */

/** The production extractors, exactly as `productionVideoPoolDeps` wires them. */
const namedSubjects = (sentence: string): NamedSubject[] => {
  const e = beatNamedEntitiesByKind(sentence);
  return [
    ...extractPersonNamesFromText(sentence).map((name) => ({ name, kind: "name" as const })),
    ...e.companies.map((name) => ({ name, kind: "company" as const })),
    ...e.brands.map((name) => ({ name, kind: "brand" as const })),
  ];
};
const allow = (q: string): GateVerdict => ({ ok: true, sentAs: q });

/**
 * A small YouTube: each person has their own videos; a search returns the videos of every person
 * the query names. The look: a video serves the sentences that name someone its title names — the
 * main subject's videos serve every sentence (as Kim's did in 640: the pool's coverage looked fine).
 */
type World = { main: string; people: Record<string, string[]>; mainServesAll?: boolean };
const ids = new Map<string, string>();
const idOf = (title: string): string => {
  if (!ids.has(title)) ids.set(title, `v${String(ids.size + 1).padStart(10, "0")}`);
  return ids.get(title)!;
};
const item = (title: string): SearchItem => ({ videoId: idOf(title), title, description: "", channel: "c", thumb: "t" });
const titlesOf = (name: string): string[] => [`${name} interview`, `${name} red carpet arrival`, `${name} at the awards`];

function deps(world: World, over: Partial<PoolDeps> & { gapLlm?: string } = {}): PoolDeps & { searches: string[]; lines: string[]; llmCalls: () => number } {
  const searches: string[] = [];
  const lines: string[] = [];
  let asked = 0;
  return {
    searches,
    lines,
    llmCalls: () => asked,
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mainSubject: world.main,
              recurringSubjects: [],
              query: ++asked === 1 ? world.main : over.gapLlm ?? `${world.main} archive scenes`,
            }),
          },
        },
      ],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      const titles = Object.entries(world.people)
        .filter(([name]) => queryNames(query, name))
        .flatMap(([, titles]) => titles);
      return { status: 200, items: titles.map(item) };
    },
    details: async (list) => new Map(list.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    triage: async (it, _title, sentences): Promise<Triage> => {
      const who = Object.keys(world.people).filter((name) => queryNames(it.title, name));
      const serves = sentences
        .map((s, i) => ((world.mainServesAll ?? true) && who.includes(world.main)) || who.some((name) => queryNames(s, name)) ? i : -1)
        .filter((i) => i >= 0);
      return { footageType: "real_footage", servesBeats: serves, depicts: who.join(", ") };
    },
    archive: async () => [],
    namedSubjects,
    log: (l) => lines.push(l),
    ...over,
  };
}

const KIM_TITLES = [
  "73 Questions With Kim Kardashian | Vogue",
  "Kim Kardashian at the Met Gala",
  "Kim Kardashian red carpet arrivals",
  "Kim Kardashian Paris fashion week",
  "Kim Kardashian Skims launch event",
  "Kim Kardashian Monologue - SNL",
  "Kim Kardashian's Very First E! Interview",
];

/* ── TEST 3's film: five named people, Kim Kardashian the main subject ── */
const FIVE = {
  videoId: 7001,
  prompt: "Why the Kardashians are so rich",
  title: "The Kardashian Money Machine",
  sceneTexts: [
    "Kim Kardashian turned a reality show into a billion dollar empire. Kim Kardashian launched Skims in 2019.",
    "Paris Hilton was the first reality star, and Paris Hilton brought Kim Kardashian to every party.",
    "Kris Jenner negotiated every contract. Kris Jenner calls herself the momager. Kris Jenner takes ten percent of everything.",
    "Kylie Jenner built a cosmetics line from lip kits. Kylie Jenner became the youngest billionaire on paper.",
    "Kanye West rebuilt her image.",
  ],
};
const FIVE_WORLD: World = {
  main: "Kim Kardashian",
  people: {
    "Kim Kardashian": KIM_TITLES,
    "Paris Hilton": titlesOf("Paris Hilton"),
    "Kris Jenner": titlesOf("Kris Jenner"),
    "Kylie Jenner": titlesOf("Kylie Jenner"),
    "Kanye West": titlesOf("Kanye West"),
  },
};

describe("MULTI-PERSON — how many searches a script gets", () => {
  it("TEST 1 — one person (the main subject): one search, no targeted search", async () => {
    const d = deps({ main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES } });
    const pool = await buildVideoYoutubePool(d, { ...FIVE, sceneTexts: [FIVE.sceneTexts[0]!, "Kim Kardashian built Skims into a brand."] });
    expect(d.searches).toEqual(["Kim Kardashian footage"]);
    expect(pool.searches).toBe(1);
    expect(pool.entityTargets).toBeUndefined();
    expect(d.lines).toContain(`[MULTI_PERSON_COVERAGE] video=${FIVE.videoId} covered=none missing=none`);
    expect(d.lines.some((l) => l.startsWith(`[MULTI_PERSON_SUMMARY] video=${FIVE.videoId} searches=1 budget=4 targeted_searches=0`))).toBe(true);
  });

  it("TEST 2 — two persons: the second gets her own search, named", async () => {
    const d = deps(FIVE_WORLD);
    const pool = await buildVideoYoutubePool(d, { ...FIVE, sceneTexts: [FIVE.sceneTexts[0]!, FIVE.sceneTexts[2]!] });
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage"]);
    expect(pool.entityTargets?.map((t) => [t.name, t.n, t.reason])).toEqual([["Kris Jenner", 2, "missing_named_subject"]]);
  });

  it("TEST 3 — five persons: the three most important missing ones are searched, the budget is the limit", async () => {
    const d = deps(FIVE_WORLD);
    const pool = await buildVideoYoutubePool(d, FIVE);
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage", "Kylie Jenner footage", "Paris Hilton footage"]);
    expect(pool.searches).toBe(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect(pool.entityTargets?.map((t) => `${t.name}#${t.n} score=${t.score}`)).toEqual(["Kris Jenner#2 score=3", "Kylie Jenner#3 score=2", "Paris Hilton#4 score=1"]);
    /** Every query carries its own name; none is a sentence. */
    for (const t of pool.entityTargets!) expect(t.query).toBe(`${t.name} footage`);
    expect(d.lines).toContain(`[MULTI_PERSON_SEARCH] video=${FIVE.videoId} entities=4 ["Kris Jenner","Kylie Jenner","Paris Hilton","Kanye West"]`);
    expect(d.lines).toContain(
      `[MULTI_PERSON_PRIORITY] video=${FIVE.videoId} 1=Kris Jenner(score=3,beats=[3,4,5]) 2=Kylie Jenner(score=2,beats=[6,7]) ` +
        `3=Paris Hilton(score=1,beats=[2]) 4=Kanye West(score=1,beats=[8])`
    );
    expect(d.lines.some((l) => l.startsWith(`[MULTI_PERSON_SEARCH] video=${FIVE.videoId} search=#3 entity="Kylie Jenner" reason=missing_named_subject query="Kylie Jenner footage" candidates=3 usable=3`))).toBe(true);
    expect(d.lines).toContain(`[MULTI_PERSON_SUMMARY] video=${FIVE.videoId} searches=4 budget=4 targeted_searches=3 targeted_candidates=9 targeted_usable=9`);
    /**
     * Each targeted video is offered to its own person's sentence among the ones the look assigned to
     * it (here Kim's videos were judged to serve every sentence, as in 640); the beat's own words rank it first.
     */
    const kylie = poolRowsForBeat(pool, "Kylie Jenner built a cosmetics line from lip kits.", ["Kylie", "Jenner"]);
    expect(kylie[0]!.title).toMatch(/^Kylie Jenner/);
    expect(kylie[0]!.servesBeat).toBe(true);
    expect(poolRowsForBeat(pool, "Paris Hilton was the first reality star, and Paris Hilton brought Kim Kardashian to every party.", ["Paris", "Hilton"])[0]!.title).toMatch(/^Paris Hilton/);
  });

  it("TEST 4 — ten persons: never more than the cap, never a claim for #5", async () => {
    const others = ["Taylor Swift", "Elon Musk", "Oprah Winfrey", "Jeff Bezos", "Bill Gates", "Mark Zuckerberg", "Paris Hilton", "Kris Jenner", "Kanye West"];
    const d = deps({ main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES, ...Object.fromEntries(others.map((n) => [n, titlesOf(n)])) } });
    const pool = await buildVideoYoutubePool(d, {
      ...FIVE,
      videoId: 7004,
      sceneTexts: [
        "Kim Kardashian built an empire. Kim Kardashian launched Skims.",
        ...others.map((n, i) => `${n} met Kim Kardashian at party number ${i + 1}.`),
      ],
    });
    expect(d.searches).toHaveLength(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect(pool.entityTargets).toHaveLength(MAX_YOUTUBE_SEARCHES_PER_VIDEO - 1);
    expect(d.lines.some((l) => l.includes("search=#5"))).toBe(false);
    expect(d.lines.find((l) => l.startsWith("[MULTI_PERSON_PRIORITY] video=7004"))).toContain("9=Kanye West");
    expect((await d.store.load(7004))!.searchCount).toBe(4);
    expect(await claimYoutubeSearch(d.store, 7004, 5, () => {})).toBe(false);
    /** The same video again: its budget is spent, nothing is searched. */
    const again = await buildVideoYoutubePool(d, { ...FIVE, videoId: 7004, sceneTexts: ["Kim Kardashian built an empire."] });
    expect(again.searches).toBe(4);
    expect(d.searches).toHaveLength(4);
  });

  it("TEST 5 — a person search #1 already shows is not searched; a targeted video that shows two answers both", async () => {
    const d = deps({
      main: "Kim Kardashian",
      people: {
        "Kim Kardashian": [...KIM_TITLES, "Kris Jenner and Kim Kardashian at the Met Gala"],
        "Kris Jenner": [],
        "Kylie Jenner": ["Kylie Jenner and Paris Hilton at the launch party", "Kylie Jenner interview"],
        "Paris Hilton": titlesOf("Paris Hilton"),
        "Kanye West": titlesOf("Kanye West"),
      },
    });
    const pool = await buildVideoYoutubePool(d, FIVE);
    expect(d.lines).toContain(`[MULTI_PERSON_COVERAGE] video=${FIVE.videoId} covered=Kris Jenner missing=Kylie Jenner,Paris Hilton,Kanye West`);
    /** Kylie's search answered Paris Hilton too: the next search goes to Kanye West. */
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kylie Jenner footage", "Kanye West footage"]);
    expect(pool.searches).toBe(3);
  });

  it("TEST 6/7 — named once ranks below named five times; the prompt's own name weighs one more", () => {
    const c = (title: string) => ({ videoId: title, title, description: "", thumb: "", durationSec: 60, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" });
    const pool = {
      query1: "Kim Kardashian footage",
      sentences: [
        "Jeff Bezos bought a house nearby.",
        ...Array.from({ length: 5 }, (_, i) => `Elon Musk visited the house in year ${i + 1}.`),
        "Bill Gates sent a letter.",
        "Bill Gates sent another letter.",
      ],
      candidates: [c("Kim Kardashian at home")],
    };
    const ranked = namedSubjectCoverage(pool, namedSubjects);
    expect(ranked.map((e) => `${e.name}=${e.score}`)).toEqual(["Elon Musk=5", "Bill Gates=2", "Jeff Bezos=1"]);
    /** The prompt names Jeff Bezos: one more, still below five sentences, now level with Bill Gates and earlier. */
    expect(namedSubjectCoverage(pool, namedSubjects, { important: "Why Jeff Bezos never moved" }).map((e) => `${e.name}=${e.score}`)).toEqual([
      "Elon Musk=5",
      "Jeff Bezos=2",
      "Bill Gates=2",
    ]);
  });

  it("TEST 7 — in a real build the five-times name is searched first, the once-named one waits for budget", async () => {
    const names = ["Elon Musk", "Jeff Bezos", "Bill Gates", "Taylor Swift"];
    const d = deps({ main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES, ...Object.fromEntries(names.map((n) => [n, titlesOf(n)])) } });
    await buildVideoYoutubePool(d, {
      ...FIVE,
      videoId: 7007,
      sceneTexts: [
        "Kim Kardashian built an empire. Jeff Bezos bought a house nearby. Taylor Swift sang at the party.",
        "Bill Gates sent a letter. Bill Gates sent another one. Kim Kardashian replied.",
        Array.from({ length: 5 }, (_, i) => `Elon Musk visited in year ${i + 1}.`).join(" "),
      ],
    });
    expect(d.searches).toEqual(["Kim Kardashian footage", "Elon Musk footage", "Bill Gates footage", "Jeff Bezos footage"]);
  });

  it("TEST 8 — two missing persons: both searched, each with its own number", async () => {
    const d = deps(FIVE_WORLD);
    const pool = await buildVideoYoutubePool(d, { ...FIVE, sceneTexts: [FIVE.sceneTexts[0]!, FIVE.sceneTexts[2]!, FIVE.sceneTexts[3]!] });
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage", "Kylie Jenner footage"]);
    expect(pool.entityTargets?.map((t) => [t.name, t.n])).toEqual([["Kris Jenner", 2], ["Kylie Jenner", 3]]);
    /** Each search's videos carry its number: the look and the stock know where they came from. */
    expect(new Set(pool.candidates.filter((c) => /^Kylie/.test(c.title)).map((c) => c.from))).toEqual(new Set([3]));
    expect(d.llmCalls()).toBe(1);
  });
});

describe("MULTI-PERSON — the targeted answers reach the stock", () => {
  it("TEST 9 — one per subject first (round robin), at most 3 in all, the stock stays within its limit", async () => {
    const pool = await buildVideoYoutubePool(deps(FIVE_WORLD), FIVE);
    const usable = pool.candidates.filter((c) => c.usable && c.from !== 0);
    const rescue = youtubeRescueCandidates(pool, usable);
    expect(rescue.size).toBe(MAX_RESCUE_STOCK_VIDEOS);
    const fromOf = (id: string) => usable.find((c) => c.videoId === id)!.from;
    expect([...rescue].map(fromOf)).toEqual([2, 3, 4]);
    const order = stockOrder(
      usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length, ...(rescue.has(c.videoId) ? { rescue: true } : {}) }))
    );
    expect(order.length).toBeLessThanOrEqual(MAX_STOCK_VIDEOS);
    expect(order.slice(0, 3).map((c) => c.videoId)).toEqual([...rescue]);
    /** Without the mark, Kim's videos (serving every sentence) would take all six slots. */
    const unmarked = stockOrder(usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length })), STOCK_FIRST_BATCH);
    expect(unmarked.some((c) => rescue.has(c.videoId))).toBe(false);
  });

  it("TEST 9b — two subjects: the first gets a second slot, never a third", () => {
    const cand = (videoId: string, from: number, title: string) => ({ videoId, title, description: "", from, serves: [1] });
    const pool = {
      entityTargets: [
        { name: "Kris Jenner", kind: "name" as const, beats: [1], reason: "missing_named_subject", n: 2, query: "Kris Jenner footage", score: 3 },
        { name: "Kylie Jenner", kind: "name" as const, beats: [2], reason: "missing_named_subject", n: 3, query: "Kylie Jenner footage", score: 2 },
      ],
    };
    const usable = [cand("k1", 2, "Kris Jenner a"), cand("k2", 2, "Kris Jenner b"), cand("k3", 2, "Kris Jenner c"), cand("y1", 3, "Kylie Jenner a"), cand("y2", 3, "Kylie Jenner b")];
    expect([...youtubeRescueCandidates(pool, usable)]).toEqual(["k1", "y1", "k2"]);
    expect(MAX_RESCUE_STOCK_PER_SUBJECT).toBe(2);
    /** A candidate of a targeted search that neither names the subject nor serves its sentences is not rescued. */
    expect([...youtubeRescueCandidates(pool, [{ videoId: "z", title: "Unrelated clip", description: "", from: 2, serves: [9] }])]).toEqual([]);
  });

  it("TEST 15b — the outcome lines: per subject downloaded / adopted / final, and the totals", async () => {
    const pool = await buildVideoYoutubePool(deps(FIVE_WORLD), FIVE);
    const krisId = pool.candidates.find((c) => c.from === 2)!.videoId;
    const kylieId = pool.candidates.find((c) => c.from === 3)!.videoId;
    const lines = formatMultiPersonOutcome(FIVE.videoId, pool, [
      { providerAssetId: krisId, sceneIndex: 1, beatIndex: 0, downloaded: true, adopted: true, finalVideo: true },
      { providerAssetId: krisId, sceneIndex: 1, beatIndex: 1, downloaded: true, adopted: false, finalVideo: false },
      { providerAssetId: kylieId, sceneIndex: 2, beatIndex: 0, downloaded: false, adopted: false, finalVideo: false },
      { providerAssetId: "other", sceneIndex: 0, beatIndex: 0, downloaded: true, adopted: true, finalVideo: true },
    ]);
    /** VIDEO 641 — one [TARGETED_VISUAL] line per answer that got anywhere, beside the totals. */
    expect(lines.filter((l) => l.startsWith("[TARGETED_VISUAL]"))).toEqual([
      `[TARGETED_VISUAL] video=${FIVE.videoId} subject="Kris Jenner" search=#2 videoId=${krisId} stage=FINAL_VIDEO sentences=[s1b0,s1b1]`,
      `[TARGETED_VISUAL] video=${FIVE.videoId} subject="Kylie Jenner" search=#3 videoId=${kylieId} stage=FOUND sentences=[s2b0]`,
    ]);
    expect(lines.filter((l) => l.startsWith("[MULTI_PERSON_"))).toEqual([
      `[MULTI_PERSON_OUTCOME] video=${FIVE.videoId} entity="Kris Jenner" search=#2 downloaded=2 adopted=1 final=1 finalBeats=s1b0 entityBeats=[3,4,5]`,
      `[MULTI_PERSON_OUTCOME] video=${FIVE.videoId} entity="Kylie Jenner" search=#3 downloaded=0 adopted=0 final=0 entityBeats=[6,7]`,
      `[MULTI_PERSON_OUTCOME] video=${FIVE.videoId} entity="Paris Hilton" search=#4 downloaded=0 adopted=0 final=0 entityBeats=[2]`,
      `[MULTI_PERSON_SUMMARY] video=${FIVE.videoId} searches=4 targeted_searches=3 targeted_downloaded=2 targeted_adopted=1 targeted_final=1`,
    ]);
    expect(formatMultiPersonOutcome(1, { searches: 1, candidates: [] }, [])).toEqual([]);
  });
});

describe("MULTI-PERSON — the budget and the edges", () => {
  it("TEST 11 — a search the store does not grant stops the round; nothing is sent past it", async () => {
    const base = memoryYoutubeSearchBudgetStore();
    const store = { ...base, claim: async (v: number, n: number) => (n >= 3 ? false : base.claim(v, n)) };
    const d = deps(FIVE_WORLD, { store });
    const pool = await buildVideoYoutubePool(d, FIVE);
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage"]);
    expect(pool.entityTargets).toHaveLength(1);
    expect(d.lines.filter((l) => l.includes("reason=already_spent"))).toHaveLength(1);
  });

  it("TEST 11b — a video whose budget is already spent searches nothing", async () => {
    const d = deps(FIVE_WORLD);
    for (let n = 1; n <= MAX_YOUTUBE_SEARCHES_PER_VIDEO; n++) await d.store.claim(FIVE.videoId, n);
    const pool = await buildVideoYoutubePool(d, FIVE);
    expect(d.searches).toEqual([]);
    expect(pool.searches).toBe(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect(d.lines.some((l) => l.includes("REUSED"))).toBe(true);
  });

  it("TEST 11c — in the quota cooldown no targeted search is spent", async () => {
    let cooling = false;
    const d = deps(FIVE_WORLD, { inCooldown: () => cooling, search: async (q) => ((cooling = true), d.searches.push(q), { status: 200, items: KIM_TITLES.map(item) }) });
    await buildVideoYoutubePool(d, FIVE);
    expect(d.searches).toEqual(["Kim Kardashian footage"]);
  });

  it("TEST 12 — no named people or entities: the main search works as before", async () => {
    const d = deps({ main: "Berlin Wall", people: { "Berlin Wall": ["Berlin Wall falls 1989 archive", "Berlin Wall 1961 construction", "Berlin Wall checkpoint newsreel", "Berlin Wall crowds 1989", "Berlin Wall torn down", "Berlin Wall guards"] } });
    const pool = await buildVideoYoutubePool(d, {
      videoId: 7012,
      prompt: "The night the Berlin Wall fell",
      title: "The Berlin Wall",
      sceneTexts: ["Concrete and barbed wire cleaved the city in two, along the Berlin Wall.", "Confusion and adrenaline filled the air at the Berlin Wall.", "Many thought it was temporary."],
    });
    expect(d.searches).toEqual(["Berlin Wall footage"]);
    expect(pool.entityTargets).toBeUndefined();
    expect(d.lines).toContain("[MULTI_PERSON_SEARCH] video=7012 entities=0 []");
    expect(d.lines.some((l) => l.includes("YouTube search DONE"))).toBe(true);
  });

  it("TEST 13 — Tesla Fremont, East Berliners, Kylie Cosmetics, Hollywood: bounded, every query names its subject, a dropped name costs nothing", async () => {
    const d = deps(
      {
        main: "Elon Musk",
        people: {
          "Elon Musk": ["Elon Musk unveils Model S", "Elon Musk interview 2008", "Elon Musk SpaceX launch", "Elon Musk factory walk", "Elon Musk keynote", "Elon Musk on stage"],
          "Tesla Fremont": ["Tesla Fremont factory tour"],
          "Kylie Cosmetics": ["Kylie Cosmetics warehouse"],
          "East Berliners": ["East Berliners cross 1989"],
        },
      },
      /** The gate drops "East Berliners" (as a sentence of a different film would): that subject is skipped, not spent. */
      { gate: (q: string) => (/East Berliners/.test(q) ? { ok: true, sentAs: q.replace(/East Berliners/, "").trim() || "crowd" } : allow(q)) }
    );
    const pool = await buildVideoYoutubePool(d, {
      videoId: 7013,
      prompt: "How Elon Musk saved Tesla",
      title: "Elon Musk and Tesla",
      sceneTexts: [
        "Elon Musk walked into the Tesla Fremont factory. Elon Musk slept on the floor of Tesla Fremont.",
        "East Berliners had once queued for cars. Hollywood loved the Model S.",
        "Kylie Cosmetics sold out the same week. Elon Musk smiled.",
      ],
    });
    expect(d.searches.length).toBeLessThanOrEqual(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect(d.searches).toEqual(["Elon Musk footage", "Tesla Fremont footage", "Kylie Cosmetics footage"]);
    expect(d.searches.some((q) => /Hollywood/.test(q))).toBe(false);
    for (const t of pool.entityTargets ?? []) expect(queryNames(t.query, t.name)).toBe(true);
    /** "Hollywood" is one word: never a targeted subject. "East Berliners" is refused before any claim. */
    expect(d.lines).toContain(`[MULTI_PERSON_SEARCH] video=7013 entities=3 ["Tesla Fremont","East Berliners","Kylie Cosmetics"]`);
    expect(d.lines).toContain('[YouTubeSearchPlanner] entity "East Berliners" NO_QUERY — the search gate drops "East Berliners"');
    expect(pool.searches).toBe(3);
  });

  it("TEST 13b — a gate that rewrites the name into other words: no search, so a targeted query always names its subject", async () => {
    const d = deps(
      { main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES, "Kris Jenner": titlesOf("Kris Jenner"), "Kylie Jenner": titlesOf("Kylie Jenner") } },
      { gate: (q: string) => (/Kris Jenner/.test(q) ? { ok: true, sentAs: q.replace(/Kris Jenner/, "celebrity mother manager") } : allow(q)) }
    );
    const pool = await buildVideoYoutubePool(d, { ...FIVE, sceneTexts: [FIVE.sceneTexts[0]!, FIVE.sceneTexts[2]!, FIVE.sceneTexts[3]!] });
    expect(d.lines).toContain('[YouTubeSearchPlanner] entity "Kris Jenner" NO_QUERY — the search gate drops "Kris Jenner"');
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kylie Jenner footage"]);
    expect(pool.entityTargets?.map((t) => t.name)).toEqual(["Kylie Jenner"]);
  });
});

/* ── TEST 14 / 15 — the 5444bca case and the 639/640 flows ── */
const KARDASHIANS_640 = {
  videoId: 640,
  prompt: "Why the Kardashians are really that rich",
  title: "The Kardashian Wealth Illusion",
  sceneTexts: [
    "Kim Kardashian flaunts a $60 million mansion, but her cash on hand tells a different story. " +
      "The stakes are staggering: billions in economic clout versus actual wealth. " +
      "Are the Kardashians truly affluent, or are they the unrivaled architects of perceived opulence?",
    "While Kris Jenner's name might be on the bottle, she receives smaller slice of the pie. " +
      "Kris Jenner turned media attention into a business machine for Kim Kardashian.",
    "Deals, and an image that keeps the media and public guessing. What does this mean for their supposed billionaire status?",
  ],
};

describe("MULTI-PERSON — no regression on the cases it came from", () => {
  it("TEST 14 — 5444bca's Kris Jenner case: still exactly two searches, the second for her", async () => {
    const d = deps({ main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES, "Kris Jenner": titlesOf("Kris Jenner") } });
    const pool = await buildVideoYoutubePool(d, KARDASHIANS_640);
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage"]);
    expect(pool.entityTargets?.map((t) => [t.name, t.beats])).toEqual([["Kris Jenner", [3, 4]]]);
    expect(youtubeRescueCandidates(pool, pool.candidates.filter((c) => c.usable)).size).toBe(2);
  });

  it("TEST 15 — 639's flow: Kylie Jenner is searched; Kris Jenner gets the targeted search; Hollywood and Forbes do not", async () => {
    const d = deps({
      main: "Kylie Jenner",
      people: {
        "Kylie Jenner": ["Kylie Jenner: A Day in the Life", "Behind Kylie Jenner’s Met Gala Look | Vogue", "Official Kylie Jenner Office Tour", "Kylie Jenner launch party", "Kylie Jenner interview", "Kylie Jenner red carpet"],
        "Kris Jenner": titlesOf("Kris Jenner"),
      },
    });
    await buildVideoYoutubePool(d, {
      videoId: 639,
      prompt: "Is Kylie Jenner really a billionaire",
      title: "Kylie Jenner's Billion",
      sceneTexts: [
        "In June 2020, Forbes stripped Kylie Jenner of her billionaire title. Kylie Jenner denied everything.",
        "Hollywood's magic blooms through product endorsements and partnerships.",
        "While Kris Jenner's name might be on the bottle, she receives smaller slice of the pie.",
      ],
    });
    expect(d.searches).toEqual(["Kylie Jenner footage", "Kris Jenner footage"]);
  });

  it("TEST 15c — a top-up after on-screen refusals keeps to the coverage gap; it adds no named-subject search", async () => {
    const d = deps({ main: "Kim Kardashian", people: { "Kim Kardashian": KIM_TITLES, "Kris Jenner": titlesOf("Kris Jenner") } });
    const first = await buildVideoYoutubePool(d, KARDASHIANS_640);
    const refused = first.candidates.filter((c) => c.from === 1).slice(0, 3).map((c) => c.videoId);
    const topped = await buildVideoYoutubePool(d, KARDASHIANS_640, { refusedVideoIds: refused });
    expect(d.searches).toHaveLength(3);
    expect(topped.gapSearch).toBe(3);
    expect(topped.entityTargets).toHaveLength(1);
    /** And once more: the gap was searched; nothing further. */
    await buildVideoYoutubePool(d, KARDASHIANS_640, { refusedVideoIds: refused });
    expect(d.searches).toHaveLength(3);
  });

  it("TEST 15d — subjects left unsearched when the pool was first built stay unsearched in a later top-up", async () => {
    const base = memoryYoutubeSearchBudgetStore();
    let busy = true;
    const store = { ...base, claim: async (v: number, n: number) => (busy && n >= 3 ? false : base.claim(v, n)) };
    const d = deps(FIVE_WORLD, { store });
    const first = await buildVideoYoutubePool(d, FIVE);
    expect(first.entityTargets?.map((t) => t.name)).toEqual(["Kris Jenner"]);
    busy = false;
    const refused = first.candidates.filter((c) => c.from === 1).slice(0, 3).map((c) => c.videoId);
    const topped = await buildVideoYoutubePool(d, FIVE, { refusedVideoIds: refused });
    expect(topped.gapSearch).toBe(3);
    expect(d.searches).toHaveLength(3);
    expect(topped.entityTargets?.map((t) => t.name)).toEqual(["Kris Jenner"]);
  });

  it("the pipeline prints the outcome per subject at the end of the render", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("for (const l of formatMultiPersonOutcome(videoId, searchedPool, youtubeLifecycle, visibleFilm, (id) => stockVideoState(videoId, id)))");
    expect(PIPE).toContain("const rescue = youtubeRescueCandidates(pool, usable);");
  });
});

/* ── TEST 10 — a targeted candidate through the real chain, to placement after its scene closed ── */
type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-multiperson-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};

describe("TEST 10 — Paris Hilton's video from search #4 reaches her sentence", () => {
  it("stocked among the first three → shot → moment → the sentence's turn → FIT after the scene closed → placed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool: VideoYoutubePool = await buildVideoYoutubePool(deps(FIVE_WORLD), FIVE);
    const usable = pool.candidates.filter((c) => c.usable && c.from !== 0);
    const rescue = youtubeRescueCandidates(pool, usable);
    const { startYoutubeShotStock, takeStockShots, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
    const fetched: string[] = [];
    startYoutubeShotStock(
      7_010,
      usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length, ...(rescue.has(c.videoId) ? { rescue: true } : {}) })),
      {
        workDir: dir,
        download: async (id, _s, _d, out) => {
          fetched.push(id);
          return fs.existsSync(video(out, 12));
        },
        cut: async (file) => [0, 6].map((t, i) => ({ path: video(`${file}.shot${i}.mp4`, 6), startSec: t, endSec: t + 6 })),
        startFor: () => 0,
        log: () => {},
      }
    );
    await youtubeStockSettled(7_010);
    expect(fetched.length).toBe(MAX_STOCK_VIDEOS);
    const parisId = [...rescue].find((id) => usable.find((c) => c.videoId === id)!.from === 4)!;
    expect(usable.find((c) => c.videoId === parisId)!.title).toMatch(/^Paris Hilton/);
    expect(fetched.slice(0, 3)).toContain(parisId);
    const took = await takeStockShots(7_010, parisId, 0, () => false, 1);
    const moment = path.join(dir, `scene_1_ytfu_0m0_t0d6__pid_youtube_cc-${parisId}.mp4`);
    fs.copyFileSync(took.shots[0]!.path, moment);
    releaseYoutubeShotStock(7_010);

    const d = {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sceneBeatsBySceneIndex: new Map([[1, [{ index: 0, text: "Paris Hilton was the first reality star, and Paris Hilton brought Kim Kardashian to every party.", holdSec: 3.5, keywords: [] as string[] }]]]),
    };
    vp.noteLookaheadCandidateReady(d, vp.youtubeTurnKey(1, 0), moment);
    expect(vp.takeReadyLookaheadCandidates(d, vp.youtubeTurnKey(1, 0))).toEqual([moment]);
    vp.noteReviewInFlight(d, vp.youtubeTurnKey(1, 0), new Promise(() => {}));
    const placer = vi.fn(async (_clip: string, _beat: number) => ({ hold: 3.5 }));
    vp.openLatePlacement(d, 1, placer);
    vp.markSceneClosed(d, 1);
    const look = vi.fn(async (_beat: unknown, _scene: number, paths: string[]) => {
      for (const p of paths) {
        d.beatImageGate.judgementAttempts++;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(1, 0, "path", p), { decision: { verdict: "fits", evaluated: true } } as never);
        vp.noteApprovedPickForBeat(d, 1, 0, vp.clipContentKey(p));
        return p;
      }
      return null;
    });
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 1 }], [{ clips: [], beatDurations: [], clipBeatIndices: [] }], look, { windowMs: 100, looksMs: 5_000 });
    expect(look).toHaveBeenCalledTimes(1);
    expect(await vp.placeApprovedAfterSceneClosed(d, 1, { sceneReturned: true, final: true })).toContainEqual({ beatIndex: 0, clip: moment, hold: 3.5 });
    expect(placer).toHaveBeenCalledWith(moment, 0);
  });
});
