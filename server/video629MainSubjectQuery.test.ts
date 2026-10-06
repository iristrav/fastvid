/**
 * P5 / VIDEO 629 — "How World War II Changed the Modern World" was never searched on YouTube.
 *
 * The model's three queries were refused (two lacked the main subject, one ran to nine words), and
 * the deterministic fallback had nothing to try: every name in the narration is said once. Yet
 * "World War II" — the subject the model itself named — passes every rule and the search gate.
 *
 * The fix, in the planner only: the main subject is tried alone, then beside one name the narration
 * says; the subject check also knows the subject's initials ("WWII"); and a decade ("1940s") counts
 * as a time, like a year. The search gate, the budget and every other rule are unchanged — these
 * tests run the REAL SEARCH_GATE_STRICT decision, with the whole narration as its evidence, exactly
 * as `youtubeVideoPoolProduction.ts` builds it.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { analyzeVideo, contentWords, planVideoQuery, refuseQuery, withoutProductionWords, type GateVerdict, type PlannerInput } from "./youtubeVideoSearchPlanner";
import { buildVideoYoutubePool, type PoolDeps, type SearchItem, type Triage } from "./youtubeVideoPool";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { searchGateDecision, validateSearchQuery, withSearchProvenance } from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

/** The production gate (youtubeVideoPoolProduction.ts), with the whole narration as evidence. */
function realGate(input: PlannerInput): (q: string) => GateVerdict {
  const narration = input.sceneTexts.join(" ");
  const ctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
  return (query) =>
    withSearchProvenance(ctx, () => {
      const decision = searchGateDecision("youtube", query, "video_pool");
      if (decision.admitted) return { ok: true, sentAs: decision.text };
      const why = validateSearchQuery(query, ctx);
      return { ok: false, reason: why.ok ? "NO_SEARCH_CONTEXT" : why.reason, offendingTerm: why.ok ? undefined : why.offendingTerm };
    });
}

/** A model that keeps answering with the given queries, naming `mainSubject` each time. */
const model = (mainSubject: string, ...queries: string[]) => {
  let i = 0;
  return vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({ mainSubject, recurringSubjects: [], query: queries[Math.min(i++, queries.length - 1)] }) } }],
  }));
};

/** Video 629's narration, as the render's log carried it. */
const v629: PlannerInput = {
  prompt: "How World War II Changed the Modern World",
  title: "Why World War II Changed Everything: A New Perspective",
  sceneTexts: [
    "Adolf Hitler, once a young, aspiring artist in Vienna, faced rejection from art school. This personal setback in Austria's capital propelled him toward a path of political ambition. But how did this intertwine with global war? These surprising beginnings contributed to a larger conflict.",
    "As tanks roared across Poland's borders in 1939, orchestrated by Heinz Guderian's Blitzkrieg, the world felt its thunderous echo. But amid this swiftly changing landscape, a daunting question loomed: how far would this storm reach? Amidst the chaos, a pivotal moment approaches that will change the war's direction. In June 1944, the D-Day landings on Normandy's shores marked the moment the Allies turned the tide. Dwight Eisenhower orchestrated a masterful campaign of deception, known as Operation Overlord. With this turning point, the war's outcome becomes increasingly certain.",
    "The smoldering ruins of cities like Berlin and London stood as stark reminders of the war's devastation. But the real legacy was forged in moments like the Yalta Conference, where leaders charted a new world order. From the ashes, Europe began to rebuild.",
  ],
};
/** The three queries render 629's model proposed, in order. */
const QUERIES_629 = [
  "Adolf Hitler Eisenhower Yalta Conference",
  "World War II Adolf Hitler Operation Overlord Yalta Conference",
  "Adolf Hitler Eisenhower Normandy Yalta Conference",
];
const allow = (): GateVerdict => ({ ok: true });

describe("Video 629 — the three production queries, and why each was refused", () => {
  const a = analyzeVideo(v629);
  const gate = realGate(v629);
  const refuse = (q: string) => refuseQuery(q, { analysis: a, mainSubject: "World War II", gate });

  it("each refusal still stands, for the same rule as in production", () => {
    expect(refuse(QUERIES_629[0]!)).toBe('the video\'s main subject "World War II" is not in the query');
    expect(refuse(QUERIES_629[1]!)).toBe("9 meaningful words (at most 8)");
    expect(refuse(QUERIES_629[2]!)).toBe('the video\'s main subject "World War II" is not in the query');
  });

  it("the planner no longer ends with no query: it searches the main subject", async () => {
    const lines: string[] = [];
    const plan = await planVideoQuery({ llm: model("World War II", ...QUERIES_629), gate, log: (l) => lines.push(l) }, v629);
    expect(plan).not.toBeNull();
    /** The subject, searched as archive film: the user asked for a historical subject. */
    expect(plan!.query).toBe("World War II archival footage");
    expect(plan!.source).toBe("fallback");
    expect(plan!.refused).toHaveLength(3);
    expect(lines.join("\n")).toContain("source=fallback_main_subject");
    expect(lines.join("\n")).not.toContain("NO_QUERY");
  });

  it("'World War II archival footage' is accepted: the rules judge the subject, the planner adds the film words", async () => {
    const q = withoutProductionWords("World War II archival footage");
    expect(q).toBe("World War II");
    expect(refuse(q)).toBeNull();
    const plan = await planVideoQuery({ llm: model("World War II", "World War II archival footage"), gate }, v629);
    expect(plan!.query).toBe("World War II archival footage");
    expect(plan!.source).toBe("llm");
    expect(plan!.attempts).toBe(1);
  });
});

describe("the subject check reads the subject, not its literal words", () => {
  const a = analyzeVideo(v629);

  it("the subject's initials name it: WWII and WW2 for World War II", () => {
    for (const q of ["WWII Allies", "WW2 Allies", "WWII Europe 1940s"]) {
      expect(refuseQuery(q, { analysis: a, mainSubject: "World War II", gate: allow })).toBeNull();
    }
  });

  it("a decade places the subject in time, like a year — it is not a second scene subject", () => {
    expect(refuseQuery("World War II Europe 1940s", { analysis: a, mainSubject: "World War II", gate: allow })).toBeNull();
    expect(refuseQuery("World War II Europe 1939", { analysis: a, mainSubject: "World War II", gate: allow })).toBeNull();
  });

  it("the gate still decides: an abbreviation the user and the narration never wrote is not sent", () => {
    expect(refuseQuery("WWII Europe", { analysis: a, mainSubject: "World War II", gate: realGate(v629) })).toContain(
      'the word "WWII" does not occur in the narration or the user\'s prompt'
    );
    const asked = { ...v629, prompt: "How WWII Changed the Modern World" };
    expect(refuseQuery("WWII Europe", { analysis: analyzeVideo(asked), mainSubject: "World War II", gate: realGate(asked) })).toBeNull();
  });
});

describe("the archive phrase: the planner's own, only for a historical request", () => {
  it("a historical prompt is searched as archive film; the model's own production words never are", async () => {
    const plan = await planVideoQuery({ llm: model("World War II", "World War II Allies documentary video"), gate: allow }, v629);
    expect(plan!.query).toBe("World War II Allies archival footage");
  });

  it("a modern prompt gets no ARCHIVE word, even when its narration names an old year — it asks for footage (video 635)", async () => {
    const planes: PlannerInput = {
      prompt: "How airplanes work",
      title: "How Do Airplanes Fly?",
      sceneTexts: ["Orville Wright flew the first airplanes in 1903.", "Wings shape the air.", "A jet engine burns fuel to push airplanes forward."],
    };
    expect(analyzeVideo(planes).historical).toBe(true);
    const plan = await planVideoQuery({ llm: model("airplanes", "airplanes wings footage"), gate: allow }, planes);
    expect(plan!.query).toBe("airplanes wings footage");
  });

  it("the gate has the last word on the phrase: refused or cut, the query goes out without it", async () => {
    const refusesFilm = (q: string): GateVerdict => (/archival/.test(q) ? { ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "archival" } : { ok: true });
    expect((await planVideoQuery({ llm: model("World War II", "World War II Allies"), gate: refusesFilm }, v629))!.query).toBe("World War II Allies");
    const dropsSubject = (q: string): GateVerdict => ({ ok: true, sentAs: /archival/.test(q) ? "Allies archival footage" : q });
    expect((await planVideoQuery({ llm: model("World War II", "World War II Allies"), gate: dropsSubject }, v629))!.query).toBe("World War II Allies");
  });
});

describe("negative cases: the rules are smarter, not gone", () => {
  const a = analyzeVideo(v629);
  const refuse = (q: string, main = "World War II") => refuseQuery(q, { analysis: a, mainSubject: main, gate: allow });

  it("an irrelevant query is refused", () => {
    expect(refuse("pizza recipe Italy")).toContain("is not in the query");
    expect(refuse("Taylor Swift Eras Tour")).toContain("is not in the query");
  });

  it("too general: one word of a three-word subject does not name it", () => {
    expect(refuse("war Europe")).toContain("is not in the query");
    expect(refuse("war footage")).toBe("fewer than 2 meaningful words");
    /** Two words of it, or all of it, still do. */
    expect(refuse("World War Europe")).toBeNull();
  });

  it("only stop words, or only production words, is no query", () => {
    expect(refuse("the of and")).toBe("fewer than 2 meaningful words");
    expect(refuse("archival footage documentary")).toBe("fewer than 2 meaningful words");
  });

  it("a wrong person or a wrong place is refused by the gate: the narration never names them", () => {
    const gate = realGate(v629);
    expect(refuseQuery("World War II Napoleon", { analysis: a, mainSubject: "World War II", gate })).toContain('the word "Napoleon"');
    expect(refuseQuery("World War II Tokyo", { analysis: a, mainSubject: "World War II", gate })).toContain('the word "Tokyo"');
  });

  it("initials are the subject's own, whole: WWI is not WWII, and a two-letter acronym never counts", () => {
    expect(refuse("WWI Europe")).toContain("is not in the query");
    expect(refuse("AR Europe", "Ancient Rome")).toContain("is not in the query");
  });

  it("a query built on one scene is still refused", () => {
    expect(refuse("World War II tanks Normandy London")).toContain("built on one scene");
    expect(refuse("World War II Normandy Berlin")).toContain("built on one scene");
  });

  it("the length rules still hold: one word is too few, nine too many", () => {
    expect(refuse("SpaceX", "SpaceX")).toBe("fewer than 2 meaningful words");
    expect(refuse(QUERIES_629[1]!)).toBe("9 meaningful words (at most 8)");
  });

  it("a subject the model invents is never searched: nothing the user or narration said proves it", async () => {
    const lines: string[] = [];
    const plan = await planVideoQuery(
      { llm: model("Pacific naval battles", ...QUERIES_629), gate: realGate(v629), log: (l) => lines.push(l) },
      v629
    );
    expect(plan).toBeNull();
    expect(lines.join("\n")).toContain("NO_QUERY");
  });

  it("the gate's narrowing still binds: what it would send must keep the main subject", async () => {
    /** "Kitty Hawk" is the only name, and the gate anchors every query to it; that is never sent as "airplanes". */
    const planes: PlannerInput = {
      prompt: "How airplanes work",
      title: "How Do Airplanes Fly?",
      sceneTexts: [
        "The Wright brothers flew the first airplanes at Kitty Hawk in 1903.",
        "Wings shape the air so the pressure below is higher than above.",
        "A jet engine pulls in air, compresses it and burns fuel to push airplanes forward.",
      ],
    };
    const plan = await planVideoQuery({ llm: model("airplanes", "Wright brothers Kitty Hawk jet engine"), gate: realGate(planes) }, planes);
    expect(plan?.query ?? null).not.toBe("Kitty Hawk");
  });
});

/**
 * GENERIC — twelve unrelated subjects, each with a model that misses the main subject three times.
 * Every one ends with a compact query that names its subject and passes the real gate.
 */
const TOPICS: Array<{ main: string; missed: string; input: PlannerInput; expected: string }> = [
  { main: "World War II", missed: QUERIES_629[0]!, input: v629, expected: "World War II archival footage" },
  {
    main: "Ancient Rome",
    missed: "Julius Caesar Rubicon Augustus Colosseum",
    /** VIDEO 635 — the archive phrase the planner adds for a historical request now survives the gate's narrowing. */
    expected: "Ancient Rome archival footage",
    input: {
      prompt: "The rise and fall of Ancient Rome",
      title: "How Ancient Rome Ruled the World",
      sceneTexts: [
        "Ancient Rome began as a small city on the Tiber. Julius Caesar crossed the Rubicon in 49 BC and changed the Republic forever.",
        "Augustus built roads and aqueducts that stretched across the empire. The Colosseum opened in 80 AD.",
        "In 476 the last emperor fell, and the Western Empire was gone.",
      ],
    },
  },
  {
    main: "Tesla",
    missed: "Elon Musk Roadster Gigafactory Nevada",
    expected: "Tesla Roadster footage",
    input: {
      prompt: "How Elon Musk built Tesla",
      title: "Elon Musk and the Tesla Gamble",
      sceneTexts: [
        "In 2008 Elon Musk nearly lost everything when the Tesla Roadster drained the company's cash.",
        "The Model S arrived in 2012 and changed what people expected from an electric car.",
        "The Gigafactory in Nevada now produces batteries at enormous scale for Tesla.",
      ],
    },
  },
  {
    main: "Taylor Swift",
    missed: "Eras Tour stadium Nashville Grammy 1989",
    expected: "Taylor Swift footage",
    input: {
      prompt: "Taylor Swift's rise to the top",
      title: "How Taylor Swift Became a Phenomenon",
      sceneTexts: [
        "Taylor Swift moved to Nashville at fourteen to chase a country music career.",
        "Her album 1989 won the Grammy for Album of the Year.",
        "The Eras Tour filled stadiums on five continents.",
      ],
    },
  },
  {
    main: "Amazon rainforest",
    missed: "Brazil deforestation jaguar Manaus river",
    expected: "Amazon rainforest footage",
    input: {
      prompt: "Why the Amazon rainforest matters",
      title: "The Amazon Rainforest Is Disappearing",
      sceneTexts: [
        "The Amazon rainforest covers more than five million square kilometres.",
        "Jaguars and river dolphins live in the forest around Manaus.",
        "Deforestation in Brazil has cleared an area larger than France.",
      ],
    },
  },
  {
    main: "SpaceX",
    missed: "Falcon 9 Starship Boca Chica Dragon",
    expected: "SpaceX International Space Station footage",
    input: {
      prompt: "How SpaceX changed spaceflight",
      title: "SpaceX: Rockets That Land",
      sceneTexts: [
        "In 2015 a SpaceX Falcon 9 booster landed upright for the first time.",
        "The Dragon capsule carried astronauts to the International Space Station in 2020.",
        "At Boca Chica, Starship is tested for missions to Mars.",
      ],
    },
  },
  {
    main: "internet",
    missed: "ARPANET Tim Berners-Lee CERN 1969 smartphones",
    expected: "internet Smartphones archival footage",
    input: {
      prompt: "The history of the internet",
      title: "How the Internet Was Born",
      sceneTexts: [
        "In 1969 ARPANET sent the first message of what would become the internet.",
        "At CERN, Tim Berners-Lee invented the World Wide Web in 1989.",
        "Smartphones put the internet in every pocket.",
      ],
    },
  },
  {
    main: "airplanes",
    missed: "Wright brothers Kitty Hawk jet engine wings",
    /**
     * VIDEO 635 — the fallback "airplanes Orville Wright" is no longer cut to "Orville Wright 1903"
     * (which lost the prompt's own word and was refused): the prompt's "airplanes" stays.
     */
    expected: "Orville Wright airplanes footage",
    input: {
      prompt: "How airplanes work",
      title: "How Do Airplanes Fly?",
      sceneTexts: [
        "Orville Wright and Wilbur Wright flew the first airplanes at Kitty Hawk in 1903.",
        "Wings shape the air so the pressure below is higher than above.",
        "A jet engine pulls in air, compresses it and burns fuel to push airplanes forward.",
      ],
    },
  },
  {
    main: "Dutch housing market",
    missed: "Amsterdam rents students campsites homes",
    expected: "Dutch housing market footage",
    input: {
      prompt: "Why the Dutch housing market is broken",
      title: "The Dutch Housing Market Crisis Explained",
      sceneTexts: [
        "In Amsterdam, rents on the Dutch housing market have doubled in ten years.",
        "Students sleep on campsites in Utrecht because there are no rooms.",
        "The government promised 900,000 new homes by 2030.",
      ],
    },
  },
  {
    main: "climate change",
    missed: "Greenland ice sheet wildfires Australia 2019",
    expected: "climate change footage",
    input: {
      prompt: "What climate change is doing to our planet",
      title: "Climate Change: The Evidence",
      sceneTexts: [
        "Climate change is melting the Greenland ice sheet faster every year.",
        "In 2019, wildfires burned across Australia for months.",
        "Rising seas now threaten cities like Jakarta.",
      ],
    },
  },
  {
    main: "football",
    missed: "Lionel Messi Barcelona Camp Nou Champions League",
    expected: "football Barcelona footage",
    input: {
      prompt: "Why football is the world's favourite sport",
      title: "How Football Conquered the World",
      sceneTexts: [
        "Football began in English schools in the nineteenth century.",
        "Lionel Messi turned Barcelona into the best team on the planet.",
        "The World Cup final is watched by more than a billion people.",
      ],
    },
  },
  {
    main: "Italian cooking",
    missed: "Naples pizza oven Bologna pasta",
    expected: "Italian cooking footage",
    input: {
      prompt: "The secrets of Italian cooking",
      title: "Why Italian Cooking Is So Good",
      sceneTexts: [
        "In Naples, pizza is baked in a wood-fired oven in ninety seconds.",
        "Bologna's fresh pasta is rolled by hand every morning.",
        "Italian cooking relies on a few ingredients of the highest quality.",
      ],
    },
  },
];

describe("generic: every subject gets one compact, relevant video-wide query", () => {
  for (const t of TOPICS) {
    it(`${t.main}: "${t.expected}"`, async () => {
      const gate = realGate(t.input);
      const plan = await planVideoQuery({ llm: model(t.main, t.missed), gate }, t.input);
      expect(plan?.query).toBe(t.expected);
      /** Compact, names the subject, and passes every rule the model's own queries had to. */
      const cw = contentWords(plan!.query);
      expect(cw.length).toBeGreaterThanOrEqual(2);
      expect(cw.length).toBeLessThanOrEqual(8);
      expect(plan!.query.toLowerCase()).toContain(t.main.toLowerCase().split(" ")[0]!);
      expect(refuseQuery(plan!.query, { analysis: analyzeVideo(t.input), mainSubject: t.main, gate })).toBeNull();
    });
  }

  it("no topic is named in the planner's code", () => {
    const src = fs.readFileSync(path.join(__dirname, "youtubeVideoSearchPlanner.ts"), "utf8");
    const fix = src
      .slice(src.indexOf("P5 / VIDEO 629 — THE MAIN SUBJECT ITSELF"), src.indexOf("#1 NO_QUERY"))
      .split("\n")
      .filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l))
      .join("\n");
    for (const t of TOPICS) expect(fix.toLowerCase()).not.toContain(t.main.toLowerCase());
  });
});

describe("the budget is unchanged: one query, at most two searches, beats never search", () => {
  const items = (prefix: string, n: number): SearchItem[] =>
    Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${String(i).padStart(10, "0")}`.slice(0, 11), title: `${prefix} ${i}`, description: "", channel: "c", thumb: "t" }));
  const deps = (over: Partial<PoolDeps> = {}): PoolDeps & { searches: string[] } => {
    const searches: string[] = [];
    return {
      searches,
      store: memoryYoutubeSearchBudgetStore(),
      llm: model("World War II", ...QUERIES_629),
      gate: realGate(v629),
      search: async (query) => {
        searches.push(query);
        return { status: 200, items: items(searches.length === 1 ? "A" : "B", 50) };
      },
      details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
      triage: async (): Promise<Triage> => ({ footageType: "archival", servesBeats: [], depicts: "" }),
      archive: async () => [],
      log: () => {},
      ...over,
    };
  };
  const input = { videoId: 629, ...v629 };

  it("video 629's pool now spends search #1 on the main subject, and never more than two", async () => {
    const d = deps();
    const pool = await buildVideoYoutubePool(d, input);
    expect(d.searches[0]).toBe("World War II archival footage");
    expect(d.searches.length).toBeLessThanOrEqual(2);
    expect(pool.searches).toBeLessThanOrEqual(2);
    /** A second render of the same video reuses the stored budget: no third search. */
    const again = await buildVideoYoutubePool(deps({ store: d.store }), input);
    expect(again.searches).toBeLessThanOrEqual(2);
  });

  it("a budget the database refuses is still refused: no search at all", async () => {
    const d = deps();
    d.store.claim = async () => false;
    await buildVideoYoutubePool(d, input);
    expect(d.searches).toEqual([]);
  });

  it("a beat still only reads the pool; it never searches YouTube itself", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("the pool brought back no usable YouTube — no YouTube for this beat");
    expect(src).toContain("const items = poolRows;");
  });
});
