import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { MAX_STOCK_VIDEOS, STOCK_FIRST_BATCH } from "./youtubeShotStock";
import { analyzeVideo, queryNames, validVisualNeeds, type GateVerdict, type VisualNeed } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  candidateShows,
  formatMultiPersonOutcome,
  namedSubjectCoverage,
  scriptVisualNeeds,
  type NamedSubject,
  type PoolDeps,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import { youtubeTriagePrompt } from "./youtubeVideoPoolProduction";
import { beatNamedEntitiesByKind, extractPersonNamesFromText, youtubeRescueCandidates } from "./videoPipeline";
import { VisualSourceLedger, type LineageStage } from "./visualSourceLineage";
import { beatRelevanceBeatKey, type BeatRelevanceLedger } from "./beatVisualRelevance";
import { traceYoutubeLifecycle, YOUTUBE_PROVIDER } from "./youtubeLifecycleTrace";

/**
 * VISUAL NEEDS — NOT ONLY PEOPLE.
 *
 * The script's concrete visual subjects — places, buildings, events, wars, companies, products,
 * vehicles, technology, animals, objects, teams, matches, and people — are read by the planner in the
 * call that plans search #1 (`visualNeeds`), beside the narration's own names. "The pool has it" is
 * the look's answer (`shows`: the thumbnail triage asked which subjects the video really shows), not a
 * word in a title. Each subject the pool cannot show, most important first, gets one targeted search
 * while the budget of MAX_YOUTUBE_SEARCHES_PER_VIDEO lasts, and its answer goes through the same look,
 * stock, Judge and placement as every other YouTube candidate. Found is not succeeded: the tests follow
 * the candidate as far as a unit test can, and the render reports the rest per subject.
 */

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
 * A small YouTube where a video is known by what it SHOWS, not by its title: "November 9, 1989
 * newsreel" shows the Berlin Wall without saying so. A search returns every video filed under a
 * subject the query names. The look answers `shows` from that truth, and serves the sentences that
 * need what it shows (the main subject's videos also serve the sentences that need nothing named).
 */
type Video = { title: string; shows: string[] };
type Film = {
  videoId: number;
  prompt: string;
  title: string;
  scenes: string[];
  main: string;
  /** Search #1's query as the planner writes it (default: the main subject). */
  query?: string;
  /** The look assigns the main subject's videos every sentence (as Kim's in 640): no coverage gap. */
  mainServesAll?: boolean;
  needs: VisualNeed[];
  catalogue: Record<string, Video[]>;
};
const ids = new Map<string, string>();
const idOf = (title: string): string => {
  if (!ids.has(title)) ids.set(title, `n${String(ids.size + 1).padStart(10, "0")}`);
  return ids.get(title)!;
};
const same = (a: string, b: string) => queryNames(a, b) && queryNames(b, a);

function deps(film: Film, over: Partial<PoolDeps> = {}): PoolDeps & { searches: string[]; lines: string[]; looked: string[][] } {
  const searches: string[] = [];
  const lines: string[] = [];
  const looked: string[][] = [];
  const byTitle = new Map(Object.values(film.catalogue).flat().map((v) => [v.title, v]));
  let asked = 0;
  return {
    searches,
    lines,
    looked,
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              ++asked === 1
                ? { mainSubject: film.main, recurringSubjects: [], query: film.query ?? film.main, visualNeeds: film.needs }
                : { mainSubject: film.main, recurringSubjects: [], query: `${film.main} archive` }
            ),
          },
        },
      ],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      const found = Object.entries(film.catalogue)
        .filter(([subject]) => queryNames(query, subject))
        .flatMap(([, videos]) => videos);
      return {
        status: 200,
        items: found.map((v): SearchItem => ({ videoId: idOf(v.title), title: v.title, description: "", channel: "c", thumb: "t" })),
      };
    },
    details: async (list) => new Map(list.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    triage: async (it, _title, sentences, subjects = []): Promise<Triage> => {
      looked.push([...subjects]);
      const v = byTitle.get(it.title)!;
      const needOf = (i: number) => film.needs.filter((n) => n.beats.includes(i)).map((n) => n.subject);
      const serves = sentences
        .map((_, i) =>
          needOf(i).some((n) => v.shows.some((s) => same(s, n))) || (v.shows.includes(film.main) && (film.mainServesAll || !needOf(i).length)) ? i : -1
        )
        .filter((i) => i >= 0);
      return {
        footageType: "real_footage",
        servesBeats: serves,
        depicts: "",
        shows: subjects.map((s, k) => (v.shows.some((x) => same(x, s)) ? k : -1)).filter((k) => k >= 0),
      };
    },
    archive: async () => [],
    namedSubjects,
    log: (l) => lines.push(l),
    ...over,
  };
}
const build = (film: Film, over: Partial<PoolDeps> = {}) => {
  const d = deps(film, over);
  return buildVideoYoutubePool(d, { videoId: film.videoId, prompt: film.prompt, title: film.title, sceneTexts: film.scenes }).then((pool) => ({ d, pool }));
};
const many = (subject: string, kinds: string[], shows = [subject]): Video[] => kinds.map((k) => ({ title: `${subject} ${k}`, shows }));
const GENERIC = ["interview", "on stage", "keynote", "walking outside", "press event", "arrival"];

/* ── the films: one per kind of subject ── */
const BERLIN: Film = {
  videoId: 9101,
  prompt: "How Germany was divided in 1961",
  title: "A Divided Germany",
  scenes: [
    "Germany lay divided after the war. Germany had two governments and two armies.",
    "In November 1989, East Berliners began crossing the Berlin Wall. The Berlin Wall had stood since 1961.",
    "Germany reunified less than a year later.",
  ],
  main: "Germany",
  query: "divided Germany",
  needs: [{ subject: "Berlin Wall", beats: [2, 3] }],
  catalogue: {
    Germany: [...many("Germany", ["street scenes 1980s", "parliament Bonn", "countryside", "Autobahn traffic", "harbour Hamburg", "market square"])],
    /** The newsreel shows the Wall; its title never says "Berlin Wall". */
    "Berlin Wall": [{ title: "November 9, 1989 newsreel", shows: ["Berlin Wall"] }, { title: "Checkpoint Charlie crossing film", shows: ["Berlin Wall"] }],
  },
};

type Case = { kind: string; film: Film; expect: string; reason?: string };
const CASES: Case[] = [
  { kind: "historical event", film: BERLIN, expect: "Berlin Wall archival footage" },
  {
    kind: "place",
    film: {
      videoId: 9102,
      prompt: "Why Broadway musicals never die",
      title: "Broadway Forever",
      scenes: ["Broadway musicals sell millions of tickets. Broadway musicals tour the world.", "Every night, crowds fill Times Square before the curtain rises."],
      main: "Broadway musicals",
      needs: [{ subject: "Times Square", beats: [2] }],
      catalogue: { "Broadway musicals": many("Broadway musicals", GENERIC), "Times Square": many("Times Square", ["at night", "crowds"]) },
    },
    expect: "Times Square footage",
  },
  {
    kind: "building",
    film: {
      videoId: 9103,
      prompt: "How New York built upward",
      title: "New York Rising",
      scenes: ["New York grew faster than any city. New York needed room.", "The Empire State Building rose in just over a year."],
      main: "New York",
      query: "New York city",
      needs: [{ subject: "Empire State Building", beats: [2] }],
      catalogue: { "New York": many("New York", GENERIC), "Empire State Building": many("Empire State Building", ["construction", "aerial"]) },
    },
    expect: "Empire State Building footage",
  },
  {
    kind: "company (one word, written as a name)",
    film: {
      videoId: 9104,
      prompt: "How Elon Musk became Elon Musk",
      title: "Elon Musk",
      scenes: ["Elon Musk sold his first company young. Elon Musk wanted rockets.", "He founded SpaceX with the money."],
      main: "Elon Musk",
      needs: [{ subject: "SpaceX", beats: [2] }],
      catalogue: { "Elon Musk": many("Elon Musk", GENERIC), SpaceX: many("SpaceX", ["launch", "factory Hawthorne"]) },
    },
    expect: "SpaceX footage",
  },
  {
    kind: "product",
    film: {
      videoId: 9105,
      prompt: "How Elon Musk sold electric cars",
      title: "Elon Musk and the Electric Car",
      scenes: ["Elon Musk promised cheap electric cars. Elon Musk was doubted.", "Tesla introduced the Model 3 to bring electric cars to a mass market."],
      main: "Elon Musk",
      needs: [{ subject: "Tesla Model 3", beats: [2] }],
      catalogue: {
        "Elon Musk": many("Elon Musk", GENERIC),
        /** Any Tesla is not a Model 3: a Roadster video does not cover the need. */
        Tesla: [{ title: "Tesla Roadster review", shows: ["Tesla Roadster"] }],
        "Tesla Model 3": many("Tesla Model 3", ["unveiling", "production line"]),
      },
    },
    expect: "Tesla Model 3 footage",
  },
  {
    kind: "vehicle",
    film: {
      videoId: 9106,
      prompt: "How Henry Ford changed work",
      title: "Henry Ford",
      scenes: ["Henry Ford hated waste. Henry Ford timed every task.", "The Ford Model T rolled off the line every few minutes."],
      main: "Henry Ford",
      needs: [{ subject: "Ford Model T", beats: [2] }],
      catalogue: { "Henry Ford": many("Henry Ford", GENERIC), "Ford Model T": many("Ford Model T", ["assembly line", "driving"]) },
    },
    expect: "Ford Model T footage",
  },
  {
    kind: "technology",
    film: {
      videoId: 9107,
      prompt: "How Steve Jobs sold computers",
      title: "Steve Jobs",
      scenes: ["Steve Jobs was a salesman first. Steve Jobs loved a stage.", "The Macintosh computer arrived in 1984 with a mouse."],
      main: "Steve Jobs",
      needs: [{ subject: "Macintosh computer", beats: [2] }],
      catalogue: { "Steve Jobs": many("Steve Jobs", GENERIC), "Macintosh computer": many("Macintosh computer", ["unboxing", "1984 demo"]) },
    },
    expect: "Macintosh computer footage",
  },
  {
    kind: "war / conflict",
    film: {
      videoId: 9108,
      prompt: "How Lyndon Johnson lost his country",
      title: "Lyndon Johnson",
      scenes: ["Lyndon Johnson passed civil rights laws. Lyndon Johnson was a master of the Senate.", "Then the Vietnam War swallowed his presidency."],
      main: "Lyndon Johnson",
      needs: [{ subject: "Vietnam War", beats: [2] }],
      catalogue: { "Lyndon Johnson": many("Lyndon Johnson", GENERIC), "Vietnam War": many("Vietnam War", ["helicopters", "jungle patrol"]) },
    },
    expect: "Vietnam War footage",
  },
  {
    kind: "sport / event",
    film: {
      videoId: 9109,
      prompt: "Who was Bobby Moore",
      title: "Bobby Moore",
      scenes: ["Bobby Moore captained England. Bobby Moore never lost his calm.", "He lifted the trophy after the World Cup final at Wembley."],
      main: "Bobby Moore",
      needs: [{ subject: "World Cup final", beats: [2] }],
      catalogue: { "Bobby Moore": many("Bobby Moore", GENERIC), "World Cup final": many("World Cup final", ["Wembley crowd", "trophy lift"]) },
    },
    expect: "World Cup final footage",
  },
  {
    kind: "concrete object",
    film: {
      videoId: 9110,
      prompt: "Why Itzhak Perlman sounds like no one else",
      title: "Itzhak Perlman",
      scenes: ["Itzhak Perlman learned on a toy fiddle. Itzhak Perlman practised for hours.", "Today he plays a Stradivarius violin made in 1714."],
      main: "Itzhak Perlman",
      needs: [{ subject: "Stradivarius violin", beats: [2] }],
      catalogue: { "Itzhak Perlman": many("Itzhak Perlman", GENERIC), "Stradivarius violin": many("Stradivarius violin", ["close up", "workshop"]) },
    },
    expect: "Stradivarius violin footage",
  },
  {
    kind: "animal",
    film: {
      videoId: 9111,
      prompt: "What Charles Darwin saw",
      title: "Charles Darwin",
      scenes: ["Charles Darwin sailed for five years. Charles Darwin filled notebooks.", "On the islands he found the Galapagos tortoise."],
      main: "Charles Darwin",
      needs: [{ subject: "Galapagos tortoise", beats: [2] }],
      catalogue: { "Charles Darwin": many("Charles Darwin", GENERIC), "Galapagos tortoise": many("Galapagos tortoise", ["walking", "close up"]) },
    },
    expect: "Galapagos tortoise footage",
  },
];

describe("VISUAL NEEDS — every kind of concrete subject the pool cannot show gets its targeted search", () => {
  for (const c of CASES) {
    it(`${c.kind}: "${c.film.needs[0]!.subject}" → "${c.expect}"`, async () => {
      const { d, pool } = await build(c.film);
      expect(d.searches[0]).toMatch(new RegExp(`^${c.film.query ?? c.film.main}`));
      expect(d.searches[1]).toBe(c.expect);
      expect(d.searches.length).toBeLessThanOrEqual(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
      const t = pool.entityTargets?.find((x) => x.n === 2);
      /** A subject the narration also names as a name keeps that kind ("Ford Model T"); otherwise a visual subject. */
      expect(t).toMatchObject({ name: c.film.needs[0]!.subject });
      expect(t!.reason).toMatch(/^missing_(visual|named)_subject$/);
      /** Its answer is looked at like every other video, and the look says which of it shows the subject. */
      const answer = pool.candidates.filter((x) => x.from === 2 && x.usable);
      const showing = answer.filter((x) => candidateShows(x, c.film.needs[0]!.subject));
      expect(showing.length).toBeGreaterThan(0);
      /** … and only what shows it, or serves its sentences, is stocked first. */
      const rescue = youtubeRescueCandidates(pool, pool.candidates.filter((x) => x.usable && x.from !== 0));
      expect(rescue.size).toBeGreaterThan(0);
      expect([...rescue].every((id) => showing.some((x) => x.videoId === id))).toBe(true);
    });
  }

  it("TEST 11 — abstract ideas are not searched: the planner's 'strategy' and 'wealth' are dropped, the film keeps one search", async () => {
    const film: Film = {
      videoId: 9120,
      prompt: "How Warren Buffett thinks",
      title: "Warren Buffett",
      scenes: ["Warren Buffett reads all day. Warren Buffett lives in Omaha.", "His strategy changed the way people thought about wealth."],
      main: "Warren Buffett",
      needs: [
        { subject: "strategy", beats: [2] },
        { subject: "wealth", beats: [2] },
      ],
      catalogue: { "Warren Buffett": many("Warren Buffett", GENERIC) },
    };
    const { d, pool } = await build(film);
    expect(d.searches).toEqual(["Warren Buffett footage"]);
    expect(pool.visualNeeds).toBeUndefined();
    const a = analyzeVideo({ prompt: film.prompt, title: film.title, sceneTexts: film.scenes });
    expect(validVisualNeeds(film.needs, a, { prompt: film.prompt, title: film.title, sceneTexts: film.scenes })).toEqual([]);
  });

  it("TEST 12 — several different subjects in one film: ranked by how many sentences need them, capped", async () => {
    const film: Film = {
      videoId: 9121,
      prompt: "How Elon Musk built his companies",
      title: "Elon Musk",
      scenes: [
        "Elon Musk sold PayPal in 2002. Elon Musk had money to burn.",
        "He founded SpaceX to build rockets. SpaceX nearly went bankrupt. SpaceX finally reached orbit.",
        "Tesla introduced the Model 3. The Tesla Model 3 became a best seller.",
        "He also bought Twitter. Starship rose over Boca Chica.",
      ],
      main: "Elon Musk",
      mainServesAll: true,
      needs: [
        { subject: "SpaceX", beats: [2, 3, 4] },
        { subject: "Tesla Model 3", beats: [5, 6] },
        { subject: "PayPal", beats: [0] },
        { subject: "Twitter", beats: [7] },
        { subject: "Starship", beats: [8] },
      ],
      catalogue: {
        "Elon Musk": many("Elon Musk", GENERIC),
        SpaceX: many("SpaceX", ["launch", "landing"]),
        "Tesla Model 3": many("Tesla Model 3", ["unveiling", "production"]),
        PayPal: many("PayPal", ["office 2001"]),
        Twitter: many("Twitter", ["headquarters"]),
        Starship: many("Starship", ["launch"]),
      },
    };
    const { d, pool } = await build(film);
    expect(d.searches).toEqual(["Elon Musk footage", "SpaceX footage", "Tesla Model 3 footage", "PayPal footage"]);
    expect(pool.entityTargets?.map((t) => `${t.name}=${t.score}`)).toEqual(["SpaceX=4", "Tesla Model 3=3", "PayPal=2"]);
    expect(d.lines.find((l) => l.startsWith("[MULTI_PERSON_PRIORITY] video=9121"))).toMatch(/4=Twitter.*5=Starship.*6=Boca Chica/);
    /** Three subjects, one stock slot each first. */
    const rescue = youtubeRescueCandidates(pool, pool.candidates.filter((x) => x.usable && x.from !== 0));
    expect([...rescue].map((id) => pool.candidates.find((x) => x.videoId === id)!.from)).toEqual([2, 3, 4]);
  });

  it("TEST 13 — covered by what the video SHOWS, not by its title: the 1989 newsreel answers the Berlin Wall, no second search", async () => {
    const film: Film = {
      ...BERLIN,
      videoId: 9122,
      catalogue: { Germany: [...BERLIN.catalogue.Germany!, { title: "November 9, 1989 newsreel", shows: ["Germany", "Berlin Wall"] }] },
    };
    const { d, pool } = await build(film);
    expect(d.lines).toContain("[MULTI_PERSON_COVERAGE] video=9122 covered=Berlin Wall missing=East Berliners");
    expect(d.searches.some((q) => /Berlin Wall/.test(q))).toBe(false);
    expect(pool.entityTargets?.map((t) => t.name)).toEqual(["East Berliners"]);
  });

  it("TEST 13b — not covered by a title alone: 'Germany Berlin Wall street' that the look says shows only streets is no cover", async () => {
    const film: Film = {
      ...BERLIN,
      videoId: 9123,
      catalogue: { ...BERLIN.catalogue, Germany: [...BERLIN.catalogue.Germany!, { title: "Germany Berlin Wall street walk 2023", shows: ["Germany"] }] },
    };
    const { d } = await build(film);
    expect(d.searches[1]).toBe("Berlin Wall archival footage");
  });

  it("TEST 14 — the look is asked about every subject, for search #1 and the targeted search alike", async () => {
    const { d } = await build(CASES[4]!.film);
    expect(d.looked.length).toBeGreaterThan(0);
    for (const subjects of d.looked) expect(subjects).toEqual(["Tesla Model 3", "Elon Musk"]);
    /** "Tesla Roadster review" was never searched; and if it had been, any Tesla is not the Model 3. */
    expect(candidateShows({ title: "Tesla Model 3 Roadster", description: "", shows: ["Tesla Roadster"] }, "Tesla Model 3")).toBe(false);
  });
});

describe("VISUAL NEEDS — the reading of the script", () => {
  it("the planner's subjects are kept only where the narration proves them", () => {
    const input = { prompt: "How Elon Musk built SpaceX", title: "SpaceX", sceneTexts: ["Elon Musk founded SpaceX. SpaceX launched from Florida.", "The crowd cheered."] };
    const a = analyzeVideo(input);
    expect(
      validVisualNeeds(
        [
          { subject: "SpaceX", beats: [0, 1] },
          { subject: "Falcon 9 rocket", beats: [1] },
          { subject: "crowd", beats: [2] },
          { subject: "SpaceX launch footage", beats: [1, 9] },
          { subject: "Florida", beats: [] },
        ],
        a,
        input
      )
    ).toEqual([
      { subject: "SpaceX", beats: [0, 1] },
      { subject: "SpaceX launch", beats: [1] },
    ]);
  });

  it("the planner's subject and the narration's name are one subject; a person keeps its kind", () => {
    const pool = {
      sentences: ["Kris Jenner negotiated every deal.", "Kris Jenner calls herself the momager.", "The Berlin Wall fell in 1989.", "Buyers queued for the Tesla Model 3 in every city."],
      visualNeeds: [
        { subject: "Kris Jenner", beats: [0] },
        { subject: "Berlin Wall 1989", beats: [2] },
        { subject: "Tesla Model 3", beats: [] as number[] },
        { subject: "Tesla Model 3", beats: [3] },
      ],
    };
    expect(scriptVisualNeeds(pool, namedSubjects)).toEqual([
      { name: "Kris Jenner", kind: "name", beats: [0, 1], listed: true },
      { name: "Berlin Wall 1989", kind: "subject", beats: [2], listed: true },
      /** The name reader reads "Tesla Model" (it drops the "3"): one subject with the planner's, not a second search. */
      { name: "Tesla Model 3", kind: "name", beats: [3], listed: true },
    ]);
    /** Listed by the planner: one more in weight than the sentences alone. */
    expect(namedSubjectCoverage({ ...pool, query1: "Kim Kardashian footage", candidates: [] }, namedSubjects).map((e) => `${e.name}=${e.score}`)).toEqual([
      "Kris Jenner=3",
      "Berlin Wall 1989=2",
      "Tesla Model 3=2",
    ]);
  });

  it("the production look is asked which subjects it shows — and only when there are subjects", () => {
    const item = { title: "November 9, 1989 newsreel", channel: "c", description: "" };
    expect(youtubeTriagePrompt(item, "A Divided Germany", ["The Berlin Wall fell."])).not.toContain("Subjects:");
    const p = youtubeTriagePrompt(item, "A Divided Germany", ["The Berlin Wall fell."], ["Berlin Wall", "Germany"]);
    expect(p).toContain("Subjects:\n[0] Berlin Wall\n[1] Germany");
    expect(p).toContain("one family member is not another");
    const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(PROD).toContain("response_format: subjects.length ? TRIAGE_WITH_SUBJECTS_SCHEMA : TRIAGE_SCHEMA,");
  });
});

/* ── TEST 15 — a targeted candidate, all the way: stock → shot → moment → FIT → placed → FINAL ── */
type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-visualneeds-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};

describe("TEST 15 — the Berlin Wall newsreel from the targeted search ends up in the film", () => {
  it("stocked first → shot → moment → its sentence's turn → FIT → placed; the lifecycle reports it FINAL for its subject", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool } = await build({ ...BERLIN, videoId: 9150 });
    const usable = pool.candidates.filter((c) => c.usable && c.from !== 0);
    const rescue = youtubeRescueCandidates(pool, usable);
    const { startYoutubeShotStock, takeStockShots, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
    const fetched: string[] = [];
    startYoutubeShotStock(
      9_150,
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
    await youtubeStockSettled(9_150);
    /** VIDEO 642 — the first batch is what the wait covers; more stock follows as slots free up. */
    expect(fetched.length).toBeGreaterThanOrEqual(STOCK_FIRST_BATCH);
    expect(fetched.length).toBeLessThanOrEqual(MAX_STOCK_VIDEOS);
    const wallId = pool.candidates.find((c) => c.title === "November 9, 1989 newsreel")!.videoId;
    expect(rescue.has(wallId)).toBe(true);
    expect(fetched.slice(0, rescue.size)).toContain(wallId);
    const took = await takeStockShots(9_150, wallId, 0, () => false, 1);
    const moment = path.join(dir, `scene_1_ytfu_0m0_t0d6__pid_youtube_cc-${wallId}.mp4`);
    fs.copyFileSync(took.shots[0]!.path, moment);
    releaseYoutubeShotStock(9_150);

    const sentence = "In November 1989, East Berliners began crossing the Berlin Wall.";
    const d = {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sceneBeatsBySceneIndex: new Map([[1, [{ index: 0, text: sentence, holdSec: 3.5, keywords: [] as string[] }]]]),
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

    /**
     * The rest of the walk — composed, rendered, in the final video — is the render's own lineage. Filed
     * the way the render files it for this asset, the lifecycle calls it FINAL, and the per-subject
     * outcome attributes it to the Berlin Wall search.
     */
    const ledger = new VisualSourceLedger({ renderId: "r9150" });
    const contentKey = `${YOUTUBE_PROVIDER}:${"9150".padEnd(16, "0")}`;
    const record = ledger.createLineage({
      sceneIndex: 1,
      beatIndex: 0,
      candidateId: contentKey,
      contentKey,
      localPath: moment,
      provider: YOUTUBE_PROVIDER,
      providerAssetId: wallId,
    });
    const walk: LineageStage[] = [
      "ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED", "ADOPTED",
      "COMPOSE_INPUT", "COMPOSE_SELECTED", "CINEMATIC_SELECTED", "RENDER_INPUT", "FINAL_VIDEO", "DELIVERED",
    ];
    for (const stage of walk) ledger.recordEvent(record.lineageId, stage, {} as never);
    const relevance: BeatRelevanceLedger = { byClipPath: new Map(), byContentKey: new Map(), byBeat: new Map(), spendByBeat: new Map(), finalSayRetried: new Set() };
    relevance.byBeat.set(beatRelevanceBeatKey(1, 0, "content", contentKey), {
      ctx: {} as never,
      decision: { verdict: "fits", allowed: true, reprieved: false, cached: false, depicts: "", reason: "", route: "adopt", evaluated: true },
    });
    const rows = traceYoutubeLifecycle(ledger, relevance);
    expect(rows[0]!.status).toBe("FINAL");
    const all = formatMultiPersonOutcome(9150, pool as VideoYoutubePool, rows);
    /** VIDEO 641 — and the answer itself, by video id, as far as it came. */
    expect(all).toContain(`[TARGETED_VISUAL] video=9150 subject="Berlin Wall" search=#2 videoId=${wallId} stage=FINAL_VIDEO sentences=[s1b0]`);
    const outcome = all.filter((l) => l.startsWith("[MULTI_PERSON_"));
    expect(outcome[0]).toBe(`[MULTI_PERSON_OUTCOME] video=9150 entity="Berlin Wall" search=#2 downloaded=1 adopted=1 final=1 finalBeats=s1b0 entityBeats=[2,3]`);
    /** East Berliners got search #3 and nothing from it reached the film: reported as such, not hidden. */
    expect(outcome[1]).toBe(`[MULTI_PERSON_OUTCOME] video=9150 entity="East Berliners" search=#3 downloaded=0 adopted=0 final=0 entityBeats=[2]`);
    expect(outcome[2]).toBe(`[MULTI_PERSON_SUMMARY] video=9150 searches=3 targeted_searches=2 targeted_downloaded=1 targeted_adopted=1 targeted_final=1`);
  });
});
