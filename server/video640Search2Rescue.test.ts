import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { memoryYoutubeSearchBudgetStore, MAX_YOUTUBE_SEARCHES_PER_VIDEO } from "./youtubeSearchBudget";
import { MAX_STOCK_VIDEOS, stockOrder } from "./youtubeShotStock";
import type { GateVerdict } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  missingNamedSubject,
  poolRowsForBeat,
  type NamedSubject,
  type PoolCandidate,
  type PoolDeps,
  type SearchItem,
  type Triage,
} from "./youtubeVideoPool";
import { beatNamedEntitiesByKind, extractPersonNamesFromText, youtubeRescueCandidates } from "./videoPipeline";

/**
 * VIDEO 640 — SEARCH #2 FOR THE SUBJECT SEARCH #1 COULD NOT SHOW.
 *
 * 640 (and 639) searched the video's main subject — "Kim Kardashian footage", "Kylie Jenner
 * footage" — and the sentences about Kris Jenner had no candidate that showed her: every moment
 * offered to them showed Kim (`entity_evidence`, `does_not_fit`), the archive's Kris Jenner clip was
 * judged FIT for the same sentence, and search #2 stayed unspent (coverage on paper 7/13).
 *
 * Here: the pool, built through `buildVideoYoutubePool` with the pipeline's own name extractors,
 * spends its second search — never a third — on the named subject no usable video names, and that
 * search's answer is stocked first so it can reach its sentence (637–640 downloaded nothing outside
 * the stock).
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

/* ── 640's film, its real sentences (639 for the Kris Jenner line, the same subject and week) ── */
const KARDASHIANS = {
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
/** 640's stock, by its real titles. */
const KIM_TITLES = [
  "73 Questions With Kim Kardashian West (ft. Kanye West) | Vogue",
  "Kim Kardashian's At Home Stripper Pole Workout | MTV Cribs",
  "Kim Kardashian West Monologue - SNL",
  "Kim Kardashian's Very First E! Interview: Rewind | E! News",
  "Kim Kardashian at the Met Gala",
  "Kim Kardashian red carpet arrivals",
  "Kim Kardashian Paris fashion week",
  "Kim Kardashian Skims launch event",
];
const KRIS_TITLES = ["Kris Jenner Interview | Vanity Fair", "Kris Jenner at the Kylie Cosmetics launch", "Kris Jenner red carpet"];

const item = (id: string, title: string): SearchItem => ({ videoId: id.padEnd(11, "x").slice(0, 11), title, description: "", channel: "c", thumb: "t" });

function deps(over: Partial<PoolDeps> & { secondLlm?: string } = {}): PoolDeps & { searches: string[]; lines: string[] } {
  const searches: string[] = [];
  const lines: string[] = [];
  let asked = 0;
  return {
    searches,
    lines,
    store: memoryYoutubeSearchBudgetStore(),
    /** Search #1 as in 640; for search #2 the model answers without the missing name first. */
    llm: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mainSubject: "Kardashians",
              recurringSubjects: [],
              query: ++asked === 1 ? "Kim Kardashian" : over.secondLlm ?? "Kardashian mansion deals",
            }),
          },
        },
      ],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      const titles = searches.length === 1 ? KIM_TITLES : KRIS_TITLES;
      return { status: 200, items: titles.map((t, i) => item(`${searches.length === 1 ? "K" : "J"}${i}`, t)) };
    },
    details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    /** The look: Kim's videos serve the Kim sentences; Kris Jenner's serve hers; a commentary title is talking_head. */
    triage: async (it, _title, sentences): Promise<Triage> => {
      if (/untold|billions/i.test(it.title)) return { footageType: "talking_head", servesBeats: [], depicts: "" };
      const who = /Kris Jenner/.test(it.title) ? "Kris Jenner" : "Kim Kardashian";
      const serves = sentences.map((s, i) => (s.includes(who) || (who === "Kim Kardashian" && i !== 3 && i !== 4) ? i : -1)).filter((i) => i >= 0);
      return { footageType: "real_footage", servesBeats: serves, depicts: who };
    },
    archive: async () => [],
    namedSubjects,
    log: (l) => lines.push(l),
    ...over,
  };
}
const input = { videoId: 640, ...KARDASHIANS };

describe("search #2 for the named subject no usable pool video shows (the Kris Jenner case of 640)", () => {
  /**
   * MULTI-PERSON SEARCH — the targeted search is now planned without the model: the missing name
   * plus "footage" (`planEntityQuery`), so the model can no longer answer without her first. The
   * reason is logged per subject (`[MULTI_PERSON_*]`) and kept on the pool as `entityTargets`
   * (was `search2Need`); `search2Reason` is again only the coverage-gap rules. The cap is 4, and
   * 640 spends 2: one subject was missing.
   */
  it("search #1 is the main subject; search #2 names Kris Jenner, says why, and no further search runs", async () => {
    const d = deps();
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kris Jenner footage"]);
    expect(pool.searches).toBe(2);
    expect(pool.entityTargets).toEqual([
      expect.objectContaining({ name: "Kris Jenner", reason: "missing_named_subject", beats: [3, 4], n: 2, query: "Kris Jenner footage" }),
    ]);
    expect(d.lines.some((l) => l.includes('[MULTI_PERSON_COVERAGE] video=640 covered=none missing=Kris Jenner'))).toBe(true);
    expect(d.lines.some((l) => l.includes('[MULTI_PERSON_SEARCH] video=640 search=#2 entity="Kris Jenner" reason=missing_named_subject query="Kris Jenner footage"'))).toBe(true);
    expect(d.lines.some((l) => l.includes("[MULTI_PERSON_SUMMARY] video=640 searches=2 budget=4 targeted_searches=1"))).toBe(true);
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(4);
    const again = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(2);
    expect(again.searches).toBe(2);
  });

  /** Was "the model's own query is used": the targeted query no longer depends on the model at all. */
  it("whatever the model would answer, the targeted query is the name itself", async () => {
    const d = deps({ secondLlm: "Kris Jenner perfume bottle" });
    await buildVideoYoutubePool(d, input);
    expect(d.searches[1]).toBe("Kris Jenner footage");
  });

  it("search #2's videos go through the same look: a commentary title stays unusable", async () => {
    const d = deps({
      search: async (query) => {
        d.searches.push(query);
        return d.searches.length === 1
          ? { status: 200, items: KIM_TITLES.map((t, i) => item(`K${i}`, t)) }
          : { status: 200, items: [item("J0", "How Kris Jenner Made Her BILLIONS: The UNTOLD story"), item("J1", KRIS_TITLES[0]!)] };
      },
    });
    const pool = await buildVideoYoutubePool(d, input);
    const second = pool.candidates.filter((c) => c.from === 2);
    expect(second.find((c) => c.videoId.startsWith("J0"))!.usable).toBe(false);
    expect(second.find((c) => c.videoId.startsWith("J1"))!.usable).toBe(true);
  });

  it("the Kris Jenner sentence is offered Kris Jenner first; Kim's sentence keeps Kim's videos first", async () => {
    const pool = await buildVideoYoutubePool(deps(), input);
    const kris = poolRowsForBeat(pool, "While Kris Jenner's name might be on the bottle, she receives smaller slice of the pie.", []);
    expect(kris[0]!.title).toMatch(/Kris Jenner/);
    expect(kris[0]!.servesBeat).toBe(true);
    const kim = poolRowsForBeat(pool, "Kim Kardashian flaunts a $60 million mansion, but her cash on hand tells a different story.", []);
    expect(kim[0]!.title).toMatch(/Kim Kardashian/);
  });

  it("search #2's answer is stocked first (at most two); the stock stays at six videos", async () => {
    const pool = await buildVideoYoutubePool(deps(), input);
    const usable = pool.candidates.filter((c) => c.usable && c.from !== 0);
    const rescue = youtubeRescueCandidates(pool, usable);
    expect(rescue.size).toBe(2);
    for (const id of rescue) expect(usable.find((c) => c.videoId === id)!.title).toMatch(/Kris Jenner/);
    const order = stockOrder(
      usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length, ...(rescue.has(c.videoId) ? { rescue: true } : {}) }))
    );
    expect(order).toHaveLength(MAX_STOCK_VIDEOS);
    expect(order.slice(0, 2).every((c) => rescue.has(c.videoId))).toBe(true);
    /** Without the mark (before this fix) Kris Jenner's videos, serving 2 sentences, were stocked last. */
    const before = stockOrder(usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: c.durationSec, serves: c.serves.length })));
    expect(before.some((c) => rescue.has(c.videoId))).toBe(false);
  });

  it("the pipeline marks them when it stocks the pool", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("const rescue = youtubeRescueCandidates(pool, usable);");
    expect(PIPE).toContain("...(rescue.has(c.videoId) ? { rescue: true } : {}),");
    const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(PROD).toContain("...pipeline.extractPersonNamesFromText(sentence).map((name) => ({ name, kind: \"name\" as const })),");
  });
});

describe("search #2 is spent only when it is needed", () => {
  it("a usable search #1 video already names Kris Jenner: one search, as before", async () => {
    const d = deps({
      search: async (query) => {
        d.searches.push(query);
        return { status: 200, items: [...KIM_TITLES, "Kris Jenner and Kim Kardashian at the Met Gala"].map((t, i) => item(`K${i}`, t)) };
      },
    });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual(["Kim Kardashian footage"]);
    expect(pool.search2Needed).toBe(false);
  });

  it("without the name extractors (older wiring) nothing changes: one search", async () => {
    const d = deps({ namedSubjects: undefined });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toHaveLength(1);
    expect(pool.entityTargets).toBeUndefined();
  });

  /**
   * MULTI-PERSON SEARCH — the coverage gap keeps its own search (#2, planned by the model for the
   * uncovered sentences, no name forced); the missing named subject now gets a search of its own
   * (#3) instead of competing for the same one.
   */
  it("a coverage gap keeps the existing search #2 (no name forced); the missing name gets #3", async () => {
    const d = deps({ triage: async () => ({ footageType: "talking_head", servesBeats: [], depicts: "" }) });
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual(["Kim Kardashian footage", "Kardashian mansion deals footage", "Kris Jenner footage"]);
    expect(pool.search2Reason).toContain("usable candidates 0");
    expect(pool.gapSearch).toBe(2);
    expect(pool.entityTargets?.map((t) => [t.name, t.n])).toEqual([["Kris Jenner", 3]]);
  });

  it("names search #1 already asked for, and one-word names, never trigger search #2", () => {
    const c = (title: string): PoolCandidate => ({ videoId: title, title, description: "", thumb: "", durationSec: 60, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" });
    const pool = {
      query1: "Berlin Wall November 1989 Berliners archival footage",
      sentences: ["Hollywood's magic blooms through product endorsements.", "Kim Kardashian flaunts a mansion.", "On November 9, 1989, Berliners poured through the Berlin Wall."],
      candidates: [c("Berlin Wall falls 1989")],
    };
    expect(missingNamedSubject(pool, namedSubjects)?.name).toBe("Kim Kardashian");
    expect(missingNamedSubject({ ...pool, sentences: [pool.sentences[0]!, pool.sentences[2]!] }, namedSubjects)).toBeNull();
    /** Search #1 asked for her by name; no title names her — still not a reason to search for her again. */
    expect(missingNamedSubject({ query1: "Kim Kardashian footage", sentences: ["Kim Kardashian flaunts a mansion."], candidates: [c("Met Gala red carpet 2019")] }, namedSubjects)).toBeNull();
  });
});

/* ── TEST 10 — the matrix: real production sentences, real search #1, real stock titles ── */
type Row = { video: string; q1: string; titles: string[]; sentence: string; kind: string; expect: string | null; quality: "GREEN" | "YELLOW" | "RED" };
const T640 = KIM_TITLES.slice(0, 4);
const T639 = ["Kylie Jenner: A Day in the Life", "Behind Kylie Jenner’s Glittering Met Gala Look | Vogue", "Official Kylie Jenner Office Tour"];
const T634 = ["Berlin Wall falls 1989 archive", "East Berliners cross the border 1989"];
const T636 = ["Tesla Fremont factory tour", "Elon Musk unveils Tesla Model S"];
const T630 = ["D-Day invasion archival footage", "Europe 1944 newsreel"];
const MATRIX: Row[] = [
  // celebrity / person
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "Kim Kardashian flaunts a $60 million mansion, but", kind: "person", expect: null, quality: "GREEN" },
  { video: "639", q1: "Kylie Jenner footage", titles: T639, sentence: "While Kris Jenner's name might be on the bottle, she receives smaller slice of the pie.", kind: "person", expect: "Kris Jenner", quality: "GREEN" },
  { video: "639", q1: "Kylie Jenner footage", titles: T639, sentence: "In June 2020, Forbes shocked the world by stripping Kylie Jenner of her billionaire title after uncovering inflated", kind: "person", expect: null, quality: "GREEN" },
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "Are the Kardashians truly affluent, or are they the unrivaled architects of perceived opulence?", kind: "person", expect: null, quality: "YELLOW" },
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "Kris Jenner turned media attention into a business machine.", kind: "person", expect: "Kris Jenner", quality: "GREEN" },
  // business / product
  { video: "635", q1: "Elon Musk 2008", titles: ["Elon Musk interview 2008"], sentence: "In 2020, for the first time, Tesla reported four consecutive quarters of profitability, shattering expectations and", kind: "business", expect: null, quality: "YELLOW" },
  { video: "636", q1: "Elon Musk Tesla Fremont Model S footage", titles: T636, sentence: "Yet today, it's reshaping the entire automotive industry and amassing billions.", kind: "business", expect: null, quality: "YELLOW" },
  { video: "638", q1: "Tesla Elon Musk Model 3 footage", titles: ["Tesla Model 3 production line"], sentence: "Discover the skepticism and resistance from traditional automakers.", kind: "business", expect: null, quality: "YELLOW" },
  { video: "639", q1: "Kylie Jenner footage", titles: T639, sentence: "Hollywood's magic blooms through product endorsements and partnerships.", kind: "business", expect: null, quality: "YELLOW" },
  // historical
  { video: "634", q1: "Berlin Wall November 1989 Berliners archival footage", titles: T634, sentence: "Berlin, 1961. Concrete and barbed wire cleaved the city in two, separating families.", kind: "historical", expect: null, quality: "GREEN" },
  { video: "631", q1: "East Berliners Wall", titles: T634, sentence: "As disbelief turned to joy, East Berliners poured through, erasing barrier dividing their lives.", kind: "historical", expect: null, quality: "GREEN" },
  { video: "630", q1: "Europe D-Day Invasion archival footage", titles: T630, sentence: "But despite the horrors, pivotal moments redefined the war and its outcome.", kind: "historical", expect: null, quality: "YELLOW" },
  // event / news
  { video: "631", q1: "East Berliners Wall", titles: T634, sentence: "The Wall's fall wasn't just an architectural collapse; it was the dawn of new era, fueling Germany's reunification", kind: "event", expect: null, quality: "GREEN" },
  { video: "631", q1: "East Berliners Wall", titles: T634, sentence: "In 1989, something unexpected began to unfold.", kind: "event", expect: null, quality: "YELLOW" },
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "deals, and an image that keeps the media and public guessing.", kind: "event", expect: null, quality: "RED" },
  // concrete actions
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "her cash on hand tells a different story.", kind: "action", expect: null, quality: "YELLOW" },
  { video: "634", q1: "Berlin Wall November 1989 Berliners archival footage", titles: T634, sentence: "Confusion and adrenaline filled the air.", kind: "action", expect: null, quality: "YELLOW" },
  { video: "640", q1: "Kim Kardashian footage", titles: T640, sentence: "The stakes are staggering: billions in economic clout versus actual wealth.", kind: "action", expect: null, quality: "RED" },
  // abstract concepts
  { video: "634", q1: "Berlin Wall November 1989 Berliners archival footage", titles: T634, sentence: "Many thought it was temporary, yet freedom was undeniable.", kind: "abstract", expect: null, quality: "RED" },
  { video: "634", q1: "Berlin Wall November 1989 Berliners archival footage", titles: T634, sentence: "How did one mistake topple seemingly unbreakable symbol?", kind: "abstract", expect: null, quality: "RED" },
  { video: "638", q1: "Tesla Elon Musk Model 3 footage", titles: ["Tesla Model 3 production line"], sentence: "But what follows such unexpected success?", kind: "abstract", expect: null, quality: "RED" },
  { video: "639", q1: "Kylie Jenner footage", titles: T639, sentence: "What does this mean for their supposed billionaire status?", kind: "abstract", expect: null, quality: "RED" },
];

describe("TEST 10 — 22 sentences (21 from production logs, 1 from the brief): what search #2 would be aimed at", () => {
  it("covers every category the brief names", () => {
    const n = (k: string) => MATRIX.filter((r) => r.kind === k).length;
    expect(MATRIX.length).toBeGreaterThanOrEqual(20);
    expect(n("person")).toBeGreaterThanOrEqual(5);
    for (const k of ["business", "historical", "event", "action", "abstract"]) expect(n(k)).toBeGreaterThanOrEqual(3);
  });
  for (const r of MATRIX) {
    it(`${r.video} ${r.kind}: "${r.sentence.slice(0, 60)}" → ${r.expect ?? "no named subject missing"}`, () => {
      const c = (title: string): PoolCandidate => ({ videoId: title, title, description: "", thumb: "", durationSec: 60, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" });
      const need = missingNamedSubject({ query1: r.q1, sentences: [r.sentence], candidates: r.titles.map(c) }, namedSubjects);
      expect(need?.name ?? null).toBe(r.expect);
    });
  }
});

/* ── TEST 12 J — a search #2 candidate through the real chain, to placement after its scene closed ── */
type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-640s2-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};

describe("TEST 12 J — the Kris Jenner candidate from search #2 reaches its sentence", () => {
  it("rescue stocked first → shot → moment → the sentence's turn → FIT after the scene closed → placed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = await buildVideoYoutubePool(deps(), input);
    const usable = pool.candidates.filter((c) => c.usable && c.from !== 0);
    const rescue = youtubeRescueCandidates(pool, usable);
    const { startYoutubeShotStock, takeStockShots, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
    const fetched: string[] = [];
    startYoutubeShotStock(
      640_200,
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
    await youtubeStockSettled(640_200);
    expect(fetched.length).toBe(MAX_STOCK_VIDEOS);
    expect(fetched.slice(0, 2).every((id) => rescue.has(id))).toBe(true);
    const krisId = [...rescue][0]!;
    const took = await takeStockShots(640_200, krisId, 0, () => false, 1);
    const moment = path.join(dir, `scene_1_ytfu_0m0_t0d6__pid_youtube_cc-${krisId}.mp4`);
    fs.copyFileSync(took.shots[0]!.path, moment);
    releaseYoutubeShotStock(640_200);

    /** Kris Jenner's sentence is scene 1 beat 0 of the render; its own turn takes the moment. */
    const d = {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sceneBeatsBySceneIndex: new Map([[1, [{ index: 0, text: "While Kris Jenner's name might be on the bottle, she receives smaller slice of the pie.", holdSec: 3.5, keywords: [] as string[] }]]]),
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
