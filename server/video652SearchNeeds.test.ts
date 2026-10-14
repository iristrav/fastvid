/**
 * VIDEO 652 — BETTER QUESTIONS, AND ONE QUESTION FOR THE PERSON ON SCREEN.
 *
 *   [MULTI_PERSON_SEARCH] entities=["Tesla first car","Lotus chassis","Elon Musk triumph",…]
 *   entity "Tesla first car" NO_QUERY — the search gate narrows it to "Tesla", and that fewer than 2 meaningful words
 *   entity "Lotus chassis"  query="Lotus chassis footage"   → 46 "usable" Lotus restoration videos
 *   [MULTI_PERSON_SUMMARY] searches=3 budget=4
 *
 * 1. The need the sentence was about was never asked: the gate shortened it, and the shortened form
 *    failed the rules. A need the gate admits but shortens is now asked in its own words.
 * 2. The Musk sentences were searched only inside "Tesla Fremont Elon Musk footage" (factory film).
 *    A person the visual plan puts on screen gets one search of their own, inside the same budget.
 *
 * Nothing here judges a picture: a search only decides what the thumbnail look and the picture editor
 * are shown. Every candidate below goes through `triage`; nothing is approved by a title or a query.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as contract from "./searchQueryContract";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { beatRowsInStockOrder } from "./youtubeShotStock";
import {
  analyzeVideo,
  keptAsAsked,
  planEntityQuery,
  planPersonQuery,
  queryNames,
  refuseQuery,
  type GateVerdict,
  type PlannerInput,
  type VisualNeed,
} from "./youtubeVideoSearchPlanner";
import {
  askedForPerson,
  buildVideoYoutubePool,
  centralPeople,
  namedSubjectCoverage,
  type NamedSubject,
  type PoolDeps,
  type SearchItem,
  type Triage,
} from "./youtubeVideoPool";
import { beatNamedEntitiesByKind, buildVerifiedQueryContextForBeat, extractPersonNamesFromText } from "./videoPipeline";

/** Production's extractors, exactly as `productionVideoPoolDeps` wires them. */
const namedSubjects = (sentence: string): NamedSubject[] => {
  const e = beatNamedEntitiesByKind(sentence);
  return [
    ...extractPersonNamesFromText(sentence).map((name) => ({ name, kind: "name" as const })),
    ...e.companies.map((name) => ({ name, kind: "company" as const })),
    ...e.brands.map((name) => ({ name, kind: "brand" as const })),
  ];
};

/** 652's gate on its need: admitted, and shortened to the subject ("Tesla first car" → "Tesla"). */
const gate652 = (q: string): GateVerdict =>
  /\bTesla first car\b/.test(q) ? { ok: true, sentAs: q.replace(/\s*first car\b/, "").trim() } : { ok: true, sentAs: q };

const FILM_652: PlannerInput = {
  prompt: "How Tesla changed the car industry",
  title: "How Tesla Changed the Car Industry",
  sceneTexts: [
    "Tesla's first car, built on a Lotus chassis, ignited a revolution.",
    "At the Tesla Fremont factory, Elon Musk pushed a manufacturing revolution.",
    "When Tesla's valuation surpassed traditional manufacturers, it was a seismic jolt.",
    "On stage, Elon Musk celebrated his triumph.",
  ],
};
const NEEDS_652: VisualNeed[] = [
  { subject: "Tesla first car", beats: [0] },
  { subject: "Lotus chassis", beats: [0] },
  { subject: "Tesla valuation", beats: [2] },
  { subject: "Elon Musk triumph", beats: [3] },
];
const a652 = analyzeVideo(FILM_652);

/** A small YouTube: each subject has its own videos; the look says what a video shows. */
type Video = { title: string; shows: string[]; footageType?: Triage["footageType"] };
function deps(
  film: { input: PlannerInput; query: string; needs: VisualNeed[]; catalogue: Record<string, Video[]> },
  over: Partial<PoolDeps> = {}
): PoolDeps & { searches: string[]; lines: string[]; looked: string[] } {
  const searches: string[] = [];
  const lines: string[] = [];
  const looked: string[] = [];
  const byTitle = new Map(Object.values(film.catalogue).flat().map((v) => [v.title, v]));
  const id = (title: string) => `v${[...byTitle.keys()].indexOf(title).toString().padStart(10, "0")}`;
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
                ? { mainSubject: "Tesla", recurringSubjects: [], query: film.query, visualNeeds: film.needs }
                : { mainSubject: "Tesla", recurringSubjects: [], query: "Tesla archive" }
            ),
          },
        },
      ],
    }),
    gate: gate652,
    search: async (query) => {
      searches.push(query);
      const items = Object.entries(film.catalogue)
        .filter(([subject]) => queryNames(query, subject))
        .flatMap(([, videos]) => videos)
        .map((v): SearchItem => ({ videoId: id(v.title), title: v.title, description: "", channel: "c", thumb: "t" }));
      return { status: 200, items };
    },
    details: async (list) => new Map(list.map((v) => [v, { durationSec: 600, embeddable: true, live: false }])),
    triage: async (it, _title, sentences, subjects = []): Promise<Triage> => {
      looked.push(it.title);
      const v = byTitle.get(it.title)!;
      const shows = (s: string) => v.shows.some((x) => queryNames(x, s) && queryNames(s, x));
      return {
        footageType: v.footageType ?? "real_footage",
        /** The main videos serve every sentence (no coverage gap); the others the sentences that need what they show. */
        servesBeats: sentences.map((_, i) => i).filter((i) => v.shows.includes("main") || film.needs.some((n) => n.beats.includes(i) && shows(n.subject))),
        depicts: "",
        shows: subjects.map((s, k) => (shows(s) ? k : -1)).filter((k) => k >= 0),
      };
    },
    archive: async () => [],
    namedSubjects,
    log: (l) => lines.push(l),
    ...over,
  };
}
const many = (subject: string, n: number, shows: string[]): Video[] =>
  Array.from({ length: n }, (_, i) => ({ title: `${subject} clip ${i + 1}`, shows }));

/** 652's pool: search #1 shows the factory and (by the look's word) Musk's triumph and the valuation. */
const CATALOGUE_652: Record<string, Video[]> = {
  "Tesla Fremont": many("Tesla Fremont", 10, ["main", "Tesla Fremont", "Elon Musk triumph", "Tesla valuation"]),
  "Tesla first car": many("Tesla first car", 3, ["Tesla first car"]),
  "Lotus chassis": many("Lotus chassis", 3, ["Lotus chassis"]),
  /** found only by a query that asks for him on stage, not by search #1's "Tesla Fremont Elon Musk" */
  "Elon Musk stage": many("Elon Musk stage", 3, ["Elon Musk"]),
};
const run652 = (over: Partial<PoolDeps> = {}, query = "Tesla Fremont Elon Musk", needs = NEEDS_652, input = FILM_652, videoId = 65201) => {
  const d = deps({ input, query, needs, catalogue: CATALOGUE_652 }, over);
  return buildVideoYoutubePool(d, { videoId, ...input }).then((pool) => ({ d, pool }));
};

const plan = (name: string, asked: string[], gate: (q: string) => GateVerdict = gate652, beats = [0]) => {
  const lines: string[] = [];
  const p = planEntityQuery({ gate, log: (l) => lines.push(l) }, FILM_652, a652, { name, asked, beats });
  return { query: p?.query ?? null, lines };
};

/* ═══════════ 1 + 2 — a shortened need is not dropped; its own words are kept ═══════════ */

describe("1. 'Tesla first car' is no longer skipped because the gate shortened it", () => {
  it("652: the gate shortens it to 'Tesla' → it is asked as 'Tesla first car footage', and the log says why", () => {
    const { query, lines } = plan("Tesla first car", ["Tesla Fremont Elon Musk footage"]);
    expect(query).toBe("Tesla first car footage");
    expect(lines).toEqual([
      '[YouTubeSearchPlanner] entity "Tesla first car" kept as asked — the search gate would narrow it to "Tesla", which drops "car"; query="Tesla first car footage"',
    ]);
    expect(lines.join("\n")).not.toMatch(/NO_QUERY/);
  });

  it("before the fix this exact case was NO_QUERY (the rules on the shortened form, reproduced)", () => {
    const why = refuseQuery("Tesla first car", { analysis: a652, mustDifferFrom: "Tesla Fremont Elon Musk footage", gate: gate652, allowSingleScene: true, minWords: 2 });
    expect(why).toBe('the search gate narrows it to "Tesla", and that fewer than 2 meaningful words');
  });

  it("the real gate on a 652-like script: still a query that names the need, never NO_QUERY", () => {
    const input: PlannerInput = {
      ...FILM_652,
      sceneTexts: [
        "Tesla's first car, built on a Lotus chassis, ignited a revolution. Elon Musk bet everything on it.",
        "At the Tesla Fremont factory, Elon Musk pushed a manufacturing revolution.",
        "When Tesla's valuation surpassed traditional manufacturers, it was a seismic jolt.",
        "As Mary Barra watched from New York City, the industry's future seemed to pivot overnight.",
      ],
    };
    const narration = input.sceneTexts.join(" ");
    const ctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
    const real = (q: string): GateVerdict =>
      contract.withSearchProvenance(ctx, () => {
        const d = contract.searchGateDecision("youtube", q, "video_pool");
        return d.admitted ? { ok: true, sentAs: d.text } : { ok: false, reason: "REFUSED" };
      });
    /** the real gate does shorten it — to another subject that drops "car" */
    expect(queryNames(real("Tesla first car").sentAs ?? "", "Tesla first car")).toBe(false);
    const lines: string[] = [];
    const p = planEntityQuery({ gate: real, log: (l) => lines.push(l) }, input, analyzeVideo(input), {
      name: "Tesla first car", asked: ["Tesla Fremont Elon Musk footage"], beats: [0],
    });
    expect(p?.query).toBe("Tesla first car footage");
    expect(lines[0]).toMatch(/^\[YouTubeSearchPlanner\] entity "Tesla first car" kept as asked/);
  });
});

describe("2. the meaningful original words are kept when the plan has no other term", () => {
  it("the query holds every word of the need, and nothing the script does not say", () => {
    const { query } = plan("Tesla first car", ["Tesla Fremont Elon Musk footage"]);
    expect(queryNames(query!, "Tesla first car")).toBe(true);
    expect(query).not.toMatch(/Roadster/);
  });

  it("when the gate refuses the production phrase, the need's own words still go out, without it", () => {
    const gate = (q: string): GateVerdict => (/footage/.test(q) ? { ok: false, reason: "X" } : gate652(q));
    expect(plan("Tesla first car", ["Tesla Fremont Elon Musk footage"], gate).query).toBe("Tesla first car");
  });

  it("a gate that puts OTHER words in the name's place is not a shortening: still no search (as before)", () => {
    const gate = (q: string): GateVerdict => (/Tesla first car/.test(q) ? { ok: true, sentAs: "electric vehicle startup" } : { ok: true, sentAs: q });
    const { query, lines } = plan("Tesla first car", ["Tesla Fremont Elon Musk footage"], gate);
    expect(query).toBeNull();
    expect(lines[0]).toMatch(/NO_QUERY/);
  });

  it("a refused need stays refused, and the other rules still hold on the words as asked", () => {
    expect(keptAsAsked("Tesla first car", () => ({ ok: false, reason: "UNVERIFIED_TERM" }), () => null)).toBeNull();
    /** "adds nothing to search #1": the words as asked break a rule → no query */
    expect(plan("Tesla first car", ["Tesla first car footage"]).query).toBeNull();
  });
});

/* ═══════════ 3 — the Tesla first-car sentence is not handled by a Lotus-chassis search alone ═══════════ */

describe("3. the first-car sentence gets its own search, before the part it was built on", () => {
  it("652 replayed: #2 'Tesla first car footage', and the Lotus search comes after it, not instead of it", async () => {
    const { d, pool } = await run652();
    const car = d.searches.indexOf("Tesla first car footage");
    const lotus = d.searches.indexOf("Lotus chassis footage");
    expect(car).toBe(1);
    expect(lotus === -1 || lotus > car).toBe(true);
    expect(pool.entityTargets?.find((t) => t.name === "Tesla first car")).toMatchObject({ beats: [0], query: "Tesla first car footage" });
    expect(d.lines.some((l) => /entity "Tesla first car" NO_QUERY/.test(l))).toBe(false);
  });

  it("a Lotus answer never counts as showing the first car", () => {
    const pool = {
      sentences: a652.sentences,
      query1: "Tesla Fremont Elon Musk footage",
      visualNeeds: NEEDS_652,
      candidates: [{ videoId: "lotus", title: "Lotus chassis clip 1", description: "", channel: "c", from: 3, usable: true, serves: [0], shows: ["Lotus chassis"] }],
    };
    const cov = namedSubjectCoverage(pool as never, namedSubjects, { asked: ["Lotus chassis footage"] });
    expect(cov.find((e) => e.name === "Tesla first car")).toMatchObject({ covered: false });
  });

  it("a need is asked only when ONE query asked for all of it — 'Tesla' in one and 'car' in another is not", () => {
    const pool = { sentences: a652.sentences, query1: "Tesla Fremont Elon Musk footage", visualNeeds: NEEDS_652, candidates: [] };
    const names = (asked: string[]) => namedSubjectCoverage(pool as never, namedSubjects, { asked }).map((e) => e.name);
    expect(names(["Lotus chassis car footage"])).toContain("Tesla first car");
    expect(names(["Tesla first car footage"])).not.toContain("Tesla first car");
  });
});

/* ═══════════ 4 — a person the plan puts on screen gets a person query ═══════════ */

describe("4. a Musk-central sentence can lead to one person query", () => {
  it("the plan lists 'Elon Musk triumph' for sentence 3 → Elon Musk is central there (not in the factory sentence)", () => {
    expect(centralPeople({ sentences: a652.sentences, visualNeeds: NEEDS_652 }, namedSubjects)).toEqual([
      { name: "Elon Musk", beats: [3], score: 2 },
    ]);
  });

  it("the word for how he is filmed comes from his own sentence: 'On stage' → 'Elon Musk stage footage'", () => {
    const lines: string[] = [];
    const p = planPersonQuery({ gate: gate652, log: (l) => lines.push(l) }, FILM_652, a652, { name: "Elon Musk", beats: [3] });
    expect(p?.query).toBe("Elon Musk stage footage");
  });

  it("a sentence that says nothing of how → 'Elon Musk footage'; no 'interview' or 'speech' the script does not say", () => {
    const p = planPersonQuery({ gate: gate652 }, FILM_652, a652, { name: "Elon Musk", beats: [1] });
    expect(p?.query).toBe("Elon Musk footage");
  });

  it("the real gate admits no form word the script lacks (so none is invented)", () => {
    const narration = FILM_652.sceneTexts.join(" ");
    const ctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: FILM_652.prompt });
    const real = (q: string) => contract.withSearchProvenance(ctx, () => contract.searchGateDecision("youtube", q, "video_pool").admitted);
    expect(real("Elon Musk interview")).toBe(false);
    expect(real("Elon Musk stage")).toBe(true);
  });

  it("652 replayed: one person search, inside the budget, its target the person's own sentence", async () => {
    const { d, pool } = await run652();
    expect(d.searches.filter((q) => askedForPerson(q, "Elon Musk") && !/Fremont/.test(q))).toEqual(["Elon Musk stage footage"]);
    expect(pool.entityTargets?.find((t) => t.reason === "person_on_screen")).toMatchObject({ name: "Elon Musk", beats: [3], kind: "name" });
    expect(d.lines).toContain('[PERSON_SEARCH] video=65201 person="Elon Musk" sentences=[3] score=2 pending');
  });
});

/* ═══════════ 5 — object and event sentences ask for no person ═══════════ */

describe("5. object and event sentences cause no needless person query", () => {
  const objectsOnly: VisualNeed[] = [
    { subject: "Tesla first car", beats: [0] },
    { subject: "Lotus chassis", beats: [0] },
    { subject: "Tesla valuation", beats: [2] },
  ];

  it("Musk named, but the plan lists only objects and events → nobody is central, no person search", async () => {
    expect(centralPeople({ sentences: a652.sentences, visualNeeds: objectsOnly }, namedSubjects)).toEqual([]);
    const { d, pool } = await run652({}, "Tesla Fremont Elon Musk", objectsOnly, FILM_652, 65202);
    expect(d.lines.some((l) => l.startsWith("[PERSON_SEARCH]"))).toBe(false);
    expect(pool.entityTargets?.some((t) => t.reason === "person_on_screen")).toBeFalsy();
  });

  it("a product or a place is not a person: 'Ford Model T', 'Tesla Model 3', 'Tesla Fremont' (Tesla stands alone elsewhere)", () => {
    const sentences = ["The Ford Model T changed roads.", "The Tesla Model 3 changed them again.", "At Tesla Fremont the line ran.", "Tesla's valuation soared."];
    const needs: VisualNeed[] = [
      { subject: "Ford Model T", beats: [0] },
      { subject: "Tesla Model 3", beats: [1] },
      { subject: "Tesla Fremont factory", beats: [2] },
    ];
    expect(centralPeople({ sentences, visualNeeds: needs }, namedSubjects)).toEqual([]);
  });

  it("no namedSubjects reader → no person (and no crash)", () => {
    expect(centralPeople({ sentences: a652.sentences, visualNeeds: NEEDS_652 })).toEqual([]);
  });
});

/* ═══════════ 6 — budget, dedup and targeted stock stay as they were ═══════════ */

describe("6. budget, dedup and the targeted marking are unchanged", () => {
  it("never more than MAX_YOUTUBE_SEARCHES_PER_VIDEO searches; a second build spends nothing", async () => {
    const d = deps({ input: FILM_652, query: "Tesla Fremont Elon Musk", needs: NEEDS_652, catalogue: CATALOGUE_652 });
    const pool = await buildVideoYoutubePool(d, { videoId: 65203, ...FILM_652 });
    expect(pool.searches).toBeLessThanOrEqual(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect(d.searches.length).toBe(pool.searches);
    expect(d.store.rows.get(65203)?.searchCount).toBe(pool.searches);
    const before = d.searches.length;
    await buildVideoYoutubePool(d, { videoId: 65203, ...FILM_652 });
    expect(d.searches.length).toBe(before);
  });

  it("at most ONE person search per video, however many people the plan puts on screen", async () => {
    const input: PlannerInput = {
      ...FILM_652,
      sceneTexts: ["On stage, Elon Musk celebrated his triumph.", "Mary Barra answered at a conference.", "Tesla's first car ignited a revolution."],
    };
    const needs: VisualNeed[] = [
      { subject: "Elon Musk triumph", beats: [0] },
      { subject: "Mary Barra", beats: [1] },
    ];
    const catalogue = { ...CATALOGUE_652, "Mary Barra": many("Mary Barra", 3, ["Mary Barra"]), "Tesla Fremont": many("Tesla Fremont", 10, ["main"]) };
    const d = deps({ input, query: "Tesla Fremont", needs, catalogue });
    const pool = await buildVideoYoutubePool(d, { videoId: 65204, ...input });
    expect((pool.entityTargets ?? []).filter((t) => t.reason === "person_on_screen")).toHaveLength(1);
    expect(pool.searches).toBeLessThanOrEqual(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
  });

  it("a person already asked for (alone, or with one other word) gets no second search", async () => {
    expect(askedForPerson("Elon Musk footage", "Elon Musk")).toBe(true);
    expect(askedForPerson("Kris Jenner Calabasas footage", "Kris Jenner")).toBe(true);
    expect(askedForPerson("Tesla Fremont Elon Musk footage", "Elon Musk")).toBe(false);
    expect(askedForPerson("Elon Musk 2020 Tesla market capitalization footage", "Elon Musk")).toBe(false);
    const { d } = await run652({}, "Elon Musk", NEEDS_652, FILM_652, 65205);
    expect(d.lines).toContain('[PERSON_SEARCH] video=65205 person="Elon Musk" sentences=[3] score=2 already asked for');
    expect(d.searches.filter((q) => /^Elon Musk (stage )?footage$/.test(q))).toEqual([]);
  });

  it("a video two searches return is in the pool once (dedup) and looked at once", async () => {
    const shared: Video = { title: "Elon Musk on the Tesla first car", shows: ["Elon Musk", "Tesla first car"] };
    const catalogue = { ...CATALOGUE_652, "Tesla first car": [shared], "Elon Musk stage": [shared] };
    const d = deps({ input: FILM_652, query: "Tesla Fremont Elon Musk", needs: NEEDS_652, catalogue });
    const pool = await buildVideoYoutubePool(d, { videoId: 65206, ...FILM_652 });
    expect(pool.candidates.filter((c) => c.title === shared.title)).toHaveLength(1);
    expect(d.looked.filter((t) => t === shared.title)).toHaveLength(1);
  });

  it("the person search's answers are marked targeted the way the stock reads it (entityTargets n = from)", async () => {
    const { pool } = await run652({}, "Tesla Fremont Elon Musk", NEEDS_652, FILM_652, 65207);
    const target = pool.entityTargets!.find((t) => t.reason === "person_on_screen")!;
    const answers = pool.candidates.filter((c) => c.from === target.n);
    expect(answers.length).toBeGreaterThan(0);
    /** videoPipeline's own test for a targeted row (pool side of `stockVideoTargeted ||` …) */
    for (const c of answers) expect((pool.entityTargets ?? []).some((t) => t.n === c.from)).toBe(true);
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("pool.candidates.some((c) => c.videoId === id && (pool.entityTargets ?? []).some((t) => t.n === c.from))");
  });
});

/* ═══════════ 7 — the branch fix still keeps targeted videos with their own sentences ═══════════ */

describe("7. a targeted video (need or person) stays away from sentences it does not serve", () => {
  type Row = { id: string; ready?: boolean; serves?: boolean; targeted?: boolean };
  const order = (rows: Row[]) =>
    beatRowsInStockOrder(rows, { ready: (r) => Boolean(r.ready), serves: (r) => Boolean(r.serves), shownRecently: () => false, targeted: (r) => Boolean(r.targeted) });

  it("the Musk person answer is not offered to the first-car sentence; the first-car answer not to Musk's", () => {
    const s0 = order([{ id: "musk-stage", ready: true, targeted: true }, { id: "first-car", ready: true, serves: true, targeted: true }]);
    expect([...s0.first, ...s0.rest].map((r) => r.id)).toEqual(["first-car"]);
    expect(s0.dropped.map((r) => r.id)).toEqual(["musk-stage"]);
    const s3 = order([{ id: "first-car", ready: true, targeted: true }, { id: "musk-stage", ready: true, serves: true, targeted: true }]);
    expect([...s3.first, ...s3.rest].map((r) => r.id)).toEqual(["musk-stage"]);
  });
});

/* ═══════════ 8 — nothing here approves a picture ═══════════ */

describe("8. no change can approve a picture without the picture editor", () => {
  it("a person search's answers the look refuses (someone else talking about him) are not usable", async () => {
    const catalogue = { ...CATALOGUE_652, "Elon Musk stage": many("Elon Musk stage", 3, ["Elon Musk"]).map((v) => ({ ...v, footageType: "talking_head" as const })) };
    const d = deps({ input: FILM_652, query: "Tesla Fremont Elon Musk", needs: NEEDS_652, catalogue });
    const pool = await buildVideoYoutubePool(d, { videoId: 65208, ...FILM_652 });
    const target = pool.entityTargets!.find((t) => t.reason === "person_on_screen")!;
    const answers = pool.candidates.filter((c) => c.from === target.n);
    expect(answers.length).toBe(3);
    expect(answers.every((c) => !c.usable)).toBe(true);
    /** every answer went through the look */
    for (const c of answers) expect(d.looked).toContain(c.title);
  });

  it("the search code holds no approval: no verdict, no 'judge_fit', no contentApproval", () => {
    for (const file of ["youtubeVideoSearchPlanner.ts", "youtubeVideoPool.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, file).not.toMatch(/judge_fit|contentApproval|markApproved/);
    }
  });
});
