import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import * as contract from "./searchQueryContract";
import { beatNamedEntitiesByKind, buildVerifiedQueryContextForBeat, extractPersonNamesFromText } from "./videoPipeline";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { analyzeVideo, planEntityQuery, validVisualNeeds, type GateVerdict, type PlannerInput, type VisualNeed } from "./youtubeVideoSearchPlanner";
import { buildVideoYoutubePool, type NamedSubject, type PoolDeps, type SearchItem, type Triage } from "./youtubeVideoPool";

/**
 * VIDEO 641 (OPTION A) — A NEED WITHOUT A NAME, NAMED BY ITS OWN SENTENCE.
 *
 * "Accountants in office" (sentence 8: "In the Calabasas corporate office, accountants lay out …")
 * could never reach YouTube: the video pool's gate refuses a query that names nothing in a film that
 * names someone (SUBJECT_NOT_NAMED), so planEntityQuery returned NO_QUERY and search #4 stayed unspent.
 * Only for that refusal it is now asked once more behind a name its own sentence writes —
 * "Calabasas Accountants in office" — and only when the rules and the REAL gate admit it unchanged.
 *
 * Every gate in this file is production's own decision (`productionVideoPoolDeps`), never `ok: true`.
 */

/** Production's video-pool gate, exactly as `productionVideoPoolDeps` builds it (pinned below). */
function realGate(input: PlannerInput): (q: string) => GateVerdict {
  const narration = input.sceneTexts.join(" ");
  const ctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
  return (query) =>
    contract.withSearchProvenance(ctx, () => {
      const decision = contract.searchGateDecision("youtube", query, "video_pool");
      if (decision.admitted) return { ok: true, sentAs: decision.text };
      const why = contract.validateSearchQuery(query, ctx);
      return { ok: false, reason: why.ok ? "NO_SEARCH_CONTEXT" : why.reason, offendingTerm: why.ok ? undefined : why.offendingTerm };
    });
}

/** Production's extractors, exactly as `productionVideoPoolDeps` wires them. */
const namedSubjects = (sentence: string): NamedSubject[] => {
  const entities = beatNamedEntitiesByKind(sentence);
  return [
    ...extractPersonNamesFromText(sentence).map((name) => ({ name, kind: "name" as const })),
    ...entities.companies.map((name) => ({ name, kind: "company" as const })),
    ...entities.brands.map((name) => ({ name, kind: "brand" as const })),
  ];
};

/** 641 as its production log gives it (the same script as `video641B5ConcreteNeeds.test.ts`). */
const SCRIPT_641: PlannerInput = {
  prompt: "Are the Kardashians really as rich as they seem",
  title: "The Kardashian Wealth Illusion",
  sceneTexts: [
    "Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think. " +
      "Much of their wealth is tied up in assets that can’t be easily turned into cash—a potential financial house of cards. " +
      "So, are the Kardashians really as rich as they seem?",
    "Much of the Kardashian wealth is an illusion, with assets locked in real estate and ventures controlled by Kris Jenner. " +
      "So, what's holding back their fortune from being more tangible? Let's delve deeper to understand the real financial dynamics. " +
      "Finance analysts reveal that the Kardashians' income relies heavily on volatile social media monetization. " +
      "Their wealth is a mirage shaped by media trends and unpredictable projections.",
    "In the Calabasas corporate office, accountants lay out the stark reality: operational expenses are massive, often overshadowing their earnings. " +
      "While Kim Kardashian excels at hype creation, sustaining that wealth is another story.",
  ],
};
/** The six needs 641's planner returned ([VISUAL_NEEDS] video=641, 2026-10-08 06:21:09). */
const NEEDS_641: VisualNeed[] = [
  { subject: "Kardashians", beats: [0, 3, 6, 7] },
  { subject: "Kris Jenner", beats: [3, 6] },
  { subject: "Calabasas corporate office", beats: [8] },
  { subject: "Finance analysts", beats: [6] },
  { subject: "Kim Kardashian hype creation", beats: [9] },
  { subject: "Accountants in office", beats: [8] },
];

const a641 = analyzeVideo(SCRIPT_641);
const gate641 = realGate(SCRIPT_641);
const plan = (
  name: string,
  beats: number[] | undefined,
  asked: string[],
  input = SCRIPT_641,
  a = a641,
  gate = gate641,
  people?: string[]
) => {
  const lines: string[] = [];
  const p = planEntityQuery({ gate, log: (l) => lines.push(l) }, input, a, { name, asked, beats, people });
  return { query: p?.query ?? null, lines };
};

describe("Option A — planEntityQuery against the real gate", () => {
  it("A. a person need is unchanged: Kris Jenner → Kris Jenner footage", () => {
    expect(plan("Kris Jenner", [3, 6], ["Kim Kardashian footage"]).query).toBe("Kris Jenner footage");
  });

  it("B. a concrete need with a name is unchanged: Calabasas corporate office → … footage", () => {
    expect(plan("Calabasas corporate office", [8], ["Kim Kardashian footage", "Kris Jenner Calabasas footage"]).query).toBe(
      "Calabasas corporate office footage"
    );
  });

  it("C. Accountants in office is refused as SUBJECT_NOT_NAMED, then named by its own sentence: Calabasas", () => {
    /** the refusal that made it unreachable before */
    expect(gate641("Accountants in office")).toMatchObject({ ok: false, reason: "SUBJECT_NOT_NAMED" });
    const { query, lines } = plan("Accountants in office", [8], ["Kim Kardashian footage", "Kris Jenner Calabasas footage", "Calabasas corporate office footage"]);
    expect(query).toBe("Calabasas Accountants in office footage");
    expect(lines.join("\n")).toContain('named by its own sentence: "Calabasas"');
    /** the real gate admits the query as asked: no narrowing, no canonical rewrite */
    expect(gate641("Calabasas Accountants in office")).toEqual({ ok: true, sentAs: "Calabasas Accountants in office" });
    expect(gate641(query!)).toEqual({ ok: true, sentAs: query });
  });

  it("C'. without its sentences the need stays unsearched, exactly as before", () => {
    const { query, lines } = plan("Accountants in office", undefined, ["Kim Kardashian footage"]);
    expect(query).toBeNull();
    expect(lines.join("\n")).toContain("SUBJECT_NOT_NAMED");
  });

  it("C''. only the gate's SUBJECT_NOT_NAMED opens the second try — another refusal stays NO_QUERY", () => {
    /** refused by the planner's own rule ("adds nothing"), before the gate is asked */
    const { query, lines } = plan("Accountants in office", [8], ["Accountants in office footage"]);
    expect(query).toBeNull();
    expect(lines.join("\n")).toContain("adds nothing");
    expect(lines.join("\n")).not.toContain("named by its own sentence");
  });

  it("D. a need whose own sentence names nothing → NO_QUERY", () => {
    /** sentence 7: "Their wealth is a mirage shaped by media trends …" names nobody */
    const { query, lines } = plan("Accountants in office", [7], ["Kim Kardashian footage"]);
    expect(query).toBeNull();
    expect(lines.join("\n")).toContain("its own sentences name nothing the gate admits it with");
  });

  const OTHER_SCENE: PlannerInput = {
    prompt: "Kim Kardashian and her money",
    title: "Kim Kardashian money",
    sceneTexts: [
      "Kim Kardashian and Kris Jenner launched another brand this year.",
      "Kim Kardashian sells millions every month.",
      "Late at night, accountants in the office count every expense.",
    ],
  };
  it("E. a name only another scene says is never used — nor a sentence's opening word", () => {
    const a = analyzeVideo(OTHER_SCENE);
    const gate = realGate(OTHER_SCENE);
    expect(gate("Accountants in office")).toMatchObject({ ok: false, reason: "SUBJECT_NOT_NAMED" });
    /** "Late" opens the sentence: the analysis reads it as a name, the sentence does not write it as one */
    expect(a.recurring.map((r) => r.term)).toContain("Late");
    const { query, lines } = plan("Accountants in office", [2], ["Kim Kardashian footage"], OTHER_SCENE, a, gate);
    expect(query).toBeNull();
    expect(lines.join("\n")).not.toMatch(/Kim Kardashian Accountants|Kris Jenner Accountants|Late Accountants/);
  });

  const PERSON_AND_PLACE: PlannerInput = {
    prompt: "How Kris Jenner runs the family money",
    title: "Kris Jenner money",
    sceneTexts: [
      "Kris Jenner built the family business from nothing.",
      "Every week, Kris Jenner meets the accountants in the Calabasas corporate office.",
    ],
  };
  it("F. a person and a place in the same sentence: the place is used, never the person", () => {
    const a = analyzeVideo(PERSON_AND_PLACE);
    const gate = realGate(PERSON_AND_PLACE);
    expect(gate("Accountants in office")).toMatchObject({ ok: false, reason: "SUBJECT_NOT_NAMED" });
    /** the person comes first in the analysis — and the gate would cut that query to the person */
    expect(a.recurring[0]!.term).toBe("Kris Jenner");
    expect(gate("Kris Jenner Accountants in office").sentAs).not.toBe("Kris Jenner Accountants in office");
    /** with the sentence's people (as the pool passes them) the place is tried first */
    expect(plan("Accountants in office", [1], ["Kris Jenner footage"], PERSON_AND_PLACE, a, gate, ["Kris Jenner"]).query).toBe(
      "Calabasas Accountants in office footage"
    );
    /** and even without them, and with nothing asked yet, a query the gate would narrow is never sent */
    expect(plan("Accountants in office", [1], ["Kris Jenner footage"], PERSON_AND_PLACE, a, gate).query).toBe(
      "Calabasas Accountants in office footage"
    );
    expect(plan("Accountants in office", [1], [], PERSON_AND_PLACE, a, gate).query).toBe("Calabasas Accountants in office footage");
  });

  const LONG: PlannerInput = {
    prompt: "Life at the Royal Naval College Greenwich",
    title: "Royal Naval College Greenwich",
    sceneTexts: [
      "The Royal Naval College Greenwich opened in 1712.",
      "At the Royal Naval College Greenwich, tired night shift security guards patrol the painted hall.",
    ],
  };
  it("G. a name that makes the query too long → NO_QUERY, never forced", () => {
    const a = analyzeVideo(LONG);
    const gate = realGate(LONG);
    expect(gate("tired night shift security guards")).toMatchObject({ ok: false, reason: "SUBJECT_NOT_NAMED" });
    /** 4 + 5 meaningful words: over the rules' 8 */
    const { query } = plan("tired night shift security guards", [1], ["Royal Naval College Greenwich footage"], LONG, a, gate);
    expect(query).toBeNull();
  });
});

/** 641's planner answers as production logged them; the gate is production's. */
function deps641(itemsFor: (n: number, query: string) => SearchItem[] = (n) =>
  n === 1 ? [{ videoId: "kim01", title: "Kim Kardashian red carpet", description: "", channel: "c", thumb: "t" }] : []
): PoolDeps & { searches: string[]; store: ReturnType<typeof memoryYoutubeSearchBudgetStore> } {
  const searches: string[] = [];
  const store = memoryYoutubeSearchBudgetStore();
  /** [YouTubeSearchPlanner] video=641: three #1 answers refused, then #2 "Kris Jenner Calabasas corporate office" */
  const answers = [
    { mainSubject: "The Kardashians' financial status", recurringSubjects: [], query: "Kardashians Kris Jenner Calabasas office", visualNeeds: NEEDS_641 },
    { mainSubject: "The Kardashians' financial status", recurringSubjects: [], query: "Kardashians Kris Jenner financial status assets Calabasas", visualNeeds: NEEDS_641 },
    { mainSubject: "The Kardashians' financial illusion", recurringSubjects: [], query: "Kardashians wealth management Calabasas Kris Jenner", visualNeeds: NEEDS_641 },
    { mainSubject: "Kris Jenner", recurringSubjects: [], query: "Kris Jenner Calabasas corporate office" },
  ];
  let asked = 0;
  return {
    searches,
    store,
    gate: gate641,
    namedSubjects,
    llm: async () => ({ choices: [{ message: { content: JSON.stringify(answers[asked++] ?? answers[3]) } }] }),
    search: async (query) => {
      searches.push(query);
      return { status: 200, items: itemsFor(searches.length, query) };
    },
    details: async (list) => new Map(list.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    triage: async (_it, _t, _s, subjects = []): Promise<Triage> => ({
      footageType: "real_footage",
      servesBeats: [0],
      depicts: "",
      shows: subjects.map((s, k) => (s === "Kardashians" ? k : -1)).filter((k) => k >= 0),
    }),
    archive: async () => [],
    log: () => {},
  };
}

describe("Option A + B5 — 641 replayed through the pool, the real gate, at most 4 searches", () => {
  it("I. B5 keeps the five needs (Finance analysts left out)", () => {
    expect(validVisualNeeds(NEEDS_641, a641, SCRIPT_641).map((n) => n.subject)).toEqual([
      "Kardashians",
      "Kris Jenner",
      "Calabasas corporate office",
      "Kim Kardashian",
      "Accountants in office",
    ]);
  });

  it("641: #1 Kim Kardashian, #2 Kris Jenner Calabasas, #3 Calabasas corporate office, #4 Calabasas Accountants in office", async () => {
    const d = deps641();
    const pool = await buildVideoYoutubePool(d, { videoId: 64101, ...SCRIPT_641 });
    expect(d.searches).toEqual([
      "Kim Kardashian footage",
      "Kris Jenner Calabasas footage",
      "Calabasas corporate office footage",
      "Calabasas Accountants in office footage",
    ]);
    expect((pool.entityTargets ?? []).map((t) => [t.n, t.name, t.beats])).toEqual([
      [3, "Calabasas corporate office", [8]],
      [4, "Accountants in office", [8]],
    ]);
    /** every query sent is the real gate's own text */
    for (const q of d.searches) expect(gate641(q)).toEqual({ ok: true, sentAs: q });
  });

  it("H. the budget stays 4: four claims, and a later attempt spends nothing", async () => {
    const d = deps641();
    const pool = await buildVideoYoutubePool(d, { videoId: 64102, ...SCRIPT_641 });
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(4);
    expect(pool.searches).toBe(4);
    expect(d.store.rows.get(64102)?.searchCount).toBe(4);
    await buildVideoYoutubePool(d, { videoId: 64102, ...SCRIPT_641 });
    expect(d.searches).toHaveLength(4);
  });

  it("J. pool dedup: a video #3 and #4 both return is in the pool once", async () => {
    const same: SearchItem = { videoId: "office01", title: "Calabasas office tour", description: "", channel: "c", thumb: "t" };
    const d = deps641((n) => (n === 1 ? [{ videoId: "kim01", title: "Kim", description: "", channel: "c", thumb: "t" }] : n >= 3 ? [same] : []));
    const pool = await buildVideoYoutubePool(d, { videoId: 64103, ...SCRIPT_641 });
    expect(d.searches).toHaveLength(4);
    expect(pool.candidates.filter((c) => c.videoId === "office01")).toHaveLength(1);
    expect(pool.candidates.find((c) => c.videoId === "office01")?.from).toBe(3);
  });
});

describe("Option A — wiring", () => {
  const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
  const POOL = fs.readFileSync(path.join(__dirname, "youtubeVideoPool.ts"), "utf8");
  it("this file's gate is production's own decision", () => {
    expect(PROD).toContain("pipeline.buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt })");
    expect(PROD).toContain('contract.searchGateDecision("youtube", query, "video_pool")');
    expect(PROD).toContain("if (decision.admitted) return { ok: true, sentAs: decision.text };");
  });
  it("the pool hands the need its sentences and their people", () => {
    expect(POOL).toContain("planEntityQuery(deps, input, analysis, { name: next.name, asked: asked(), beats: next.beats, people })");
  });
});
