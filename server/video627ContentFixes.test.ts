/**
 * VIDEO 627 — the first production render on the PNG overlay route. It rendered, and its content
 * was wrong in four ways that each trace to one line of code:
 *
 *   1. a scene that found nothing was searched on the main subject AND judged on it — Nazi rallies
 *      were approved under sentences about post-war cities and Antarctica;
 *   2. "World War II's" was counted as "War II's", so the main subject became "Nazi" and the
 *      whole-video YouTube search had no query — YouTube was skipped for the whole film;
 *   3. a query naming nobody was narrowed onto a person the sentence never names ("Nazi" →
 *      "Henri Guisan", "landscape entirely" → "Franklin D. Roosevelt landscape entirely");
 *   4. 49.7 s of the 90.6 s film were shots borrowed from other sentences, and it was delivered.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { borrowedShotsRefusal, finalTimelineFootageRefusal, type FinalTimelineClip } from "./deliveryGate";
import { videoMainSubject } from "./mainSubject";
import { narrowToCanonicalQuery, type VerifiedQueryContext } from "./searchQueryContract";
import { analyzeVideo, planVideoQuery } from "./youtubeVideoSearchPlanner";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Video 627's narration, three scenes, as the render log printed it. */
const V627 = {
  prompt: "Ww2 explained — Why WWII Became History's Most Extensive Conflict",
  title: "Why WWII Became History's Most Extensive Conflict",
  sceneTexts: [
    "In just one month, Poland's defenses collapsed under Nazi invasion. This rapid conquest was harbinger of chaos " +
      "that engulfed millions, shattering nations. Why did World War II escalate so swiftly, turning into humanity's " +
      "deadliest confrontation? The answer redefines our understanding of power and resilience.",
    "In an unexpected twist, Switzerland, led by Henri Guisan, fortified itself against potential Nazi invasion, " +
      "constructing the formidable Swiss National Redoubt. This tension typified the global struggle of ideologies. " +
      "And yet, pivotal moments would soon shift the entire balance of the war. In one of history's boldest " +
      "maneuvers, Dwight Eisenhower orchestrated the D-Day invasion of Normandy. This decisive action turned the " +
      "tide against the Axis powers.",
    "World War II's reach was staggering. Fueled by leaders like Franklin D. Roosevelt, it raged from the European " +
      "Theater to the Pacific, sparing no continent but Antarctica. It wasn't just extensive; it reshaped our " +
      "world's landscape entirely. It naturally leads us to explore how these changes still echo today.",
  ],
};

describe("1 — a scene searched on the main subject is still judged on its own sentences", () => {
  it("the rescue records each beat's own sentence as the text it is judged against", () => {
    expect(PIPE).toContain(
      "for (const b of beats) (dedup.beatJudgeTextOverride ??= new Map()).set(`${scene.index}:${b.index}`, b.text);"
    );
    expect(PIPE).not.toContain(".set(`${scene.index}:${b.index}`, rescue);");
  });
  it("the adopt judge reads it, so the search text never becomes the question", () => {
    expect(PIPE).toContain("const ownSentence = dedup.beatJudgeTextOverride?.get(`${sceneIndex}:${beatIndex}`);");
    expect(PIPE).toContain("...(ownSentence?.trim() ? { ctx: { ...params.ctx, beatText: ownSentence } } : {}),");
  });
  it("and the push/compose judge reads the same map", () => {
    expect(PIPE).toContain("visualDedup.beatJudgeTextOverride?.get(`${sceneIndex}:${beatIndex}`) ??");
  });
});

describe("2 — World War II is the main subject, and YouTube gets a query", () => {
  it('"World War II\'s" counts as "World War II", in both scenes that say it', () => {
    const a = analyzeVideo(V627);
    const ww2 = a.recurring.find((r) => r.term === "World War II");
    expect(ww2?.scenes).toBe(2);
    expect(a.recurring.some((r) => /War II's/.test(r.term))).toBe(false);
    expect(a.recurring.some((r) => /'s$/.test(r.term))).toBe(false);
  });
  it("the main subject is World War II, not Nazi", () => {
    expect(videoMainSubject(null, V627)).toBe("World War II");
  });
  it("the three refused model queries now leave the planner's own fallback a query", async () => {
    const answers = [
      "Eisenhower Normandy Nazi invasion",
      "World War II Nazi invasion Poland Eisenhower",
      "World War II Nazi Eisenhower Roosevelt",
    ];
    let n = 0;
    const plan = await planVideoQuery(
      {
        llm: async () => ({
          choices: [{ message: { content: JSON.stringify({ mainSubject: "World War II", recurringSubjects: [], query: answers[n++] }) } }],
        }),
        gate: () => ({ ok: true }),
      },
      V627
    );
    /** P5 — the user asked for World War II: the planner's own archive phrase is added (video629MainSubjectQuery). */
    expect(plan?.query).toBe("World War II Nazi archival footage");
    expect(plan?.source).toBe("fallback");
  });
  it("the possessive was a general bug: person, sport, science, company and place names all recur now", () => {
    const recurs = (scenes: string[]) =>
      analyzeVideo({ prompt: "", title: "", sceneTexts: scenes }).recurring.filter((r) => r.scenes >= 2).map((r) => r.term);
    expect(recurs(["Elon Musk founded SpaceX.", "By 2020, Elon Musk's Tesla led."])).toContain("Elon Musk");
    expect(recurs(["Lionel Messi joined Barcelona.", "Lionel Messi's left foot changed the game."])).toContain("Lionel Messi");
    expect(recurs(["The James Webb Space Telescope launched.", "The James Webb Space Telescope's mirror unfolded."])).toContain(
      "James Webb Space Telescope"
    );
    expect(recurs(["Apple's first computer was built in a garage.", "Apple's iPhone changed phones."])).toContain("Apple");
    expect(recurs(["Mount Everest rises high.", "Mount Everest's summit was reached in 1953."])).toContain("Mount Everest");
  });
  it("a one-word main subject still gets a query: the subject beside one more name (company video)", async () => {
    const plan = await planVideoQuery(
      {
        llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "x", recurringSubjects: [], query: "one two" }) } }] }),
        gate: () => ({ ok: true }),
      },
      {
        prompt: "company",
        title: "company",
        sceneTexts: [
          "Apple's first computer was built in a garage.",
          "Steve Jobs returned to Apple in 1997.",
          "Apple's iPhone changed phones forever.",
        ],
      }
    );
    /** VIDEO 635 — a modern subject is searched as footage of it. */
    expect(plan?.query).toBe("Apple Steve Jobs footage");
  });
  it("a sentence-opening word that is not a name is still dropped", () => {
    const a = analyzeVideo({ prompt: "", title: "", sceneTexts: ["Despite Elon Musk tweeting.", "Elon Musk again."] });
    expect(a.recurring.map((r) => r.term)).toContain("Elon Musk");
    expect(a.recurring.map((r) => r.term)).not.toContain("Despite Elon Musk");
  });
});

describe("3 — a query that names nobody is not narrowed onto a guessed person", () => {
  const ctx = (persons: Array<{ term: string; source?: string }>, evidence: string) =>
    ({
      persons: persons.map((p) => ({ ...p, type: "person", verified: true })),
      events: [], objects: [], places: [], countries: [], time: [], years: [], actions: [],
      evidence,
    }) as unknown as VerifiedQueryContext;

  it("three people named once each: the whole-video query stays the query", () => {
    const narration = V627.sceneTexts.join(" ");
    const out = narrowToCanonicalQuery(
      "World War II Nazi",
      ctx(
        [
          { term: "Henri Guisan", source: "beat_text" },
          { term: "Dwight D. Eisenhower", source: "beat_text" },
          { term: "Franklin D. Roosevelt", source: "beat_text" },
        ],
        narration
      )
    );
    expect(out).toEqual({ query: "World War II Nazi", narrowed: false });
  });
  it("a person only the scene names is not put in front of this sentence's query", () => {
    const out = narrowToCanonicalQuery(
      "landscape entirely",
      ctx([{ term: "Franklin D. Roosevelt", source: "scene_text" }], "It wasn't just extensive; it reshaped our world's landscape entirely.")
    );
    expect(out.narrowed).toBe(false);
  });
  it("a person video's query that names its own place keeps the place (any topic: Roosevelt / Pearl Harbor)", () => {
    const c = {
      ...ctx([{ term: "Franklin D. Roosevelt", source: "proven_entity" }], "The fleet burned at Pearl Harbor."),
      places: [{ term: "Pearl Harbor", type: "place", source: "beat_text", verified: true }],
    } as unknown as VerifiedQueryContext;
    expect(narrowToCanonicalQuery("Pearl Harbor fleet", c).narrowed).toBe(false);
  });
  it("a sentence about the locked person by pronoun still searches on that person", () => {
    const out = narrowToCanonicalQuery(
      "stage crowd",
      ctx([{ term: "Elon Musk", source: "proven_entity" }], "He turned it into a stage for the crowd.")
    );
    expect(out.query.toLowerCase()).toContain("elon musk");
  });
  it("two people in one sentence and a query naming neither: nobody is guessed (sport, politics)", () => {
    const out = narrowToCanonicalQuery(
      "World Cup final",
      ctx(
        [{ term: "Lionel Messi", source: "beat_text" }, { term: "Kylian Mbappe", source: "beat_text" }],
        "Lionel Messi and Kylian Mbappe met in the World Cup final."
      )
    );
    expect(out).toEqual({ query: "World Cup final", narrowed: false });
  });
  it("one person this text names still anchors, as in production render 595", () => {
    const out = narrowToCanonicalQuery(
      "Rumors kardashians Kardashians",
      ctx([{ term: "Kris Jenner", source: "beat_text" }], "Rumors about the Kardashians followed Kris Jenner everywhere.")
    );
    expect(out.narrowed).toBe(true);
    expect(out.query.toLowerCase()).toContain("kris jenner");
  });
});

describe("4 — a film made mostly of borrowed shots is not delivered", () => {
  const clip = (id: string, start: number, end: number, asset: number): FinalTimelineClip => ({
    id,
    timelineStart: start,
    timelineEnd: end,
    source: { provider: "ww2", archiveAssetId: asset },
  });
  /** Video 627's shape: 90.6 s, 49.7 s of it `_fill` pieces taking turns among nine sources. */
  const v627: FinalTimelineClip[] = [];
  let t = 0;
  for (let i = 0; i < 9; i++) {
    v627.push(clip(`vc_${i}`, t, t + 4.54, i));
    t += 4.54;
  }
  for (let i = 0; t < 90.6 - 0.01; i++) {
    const end = Math.min(90.6, t + 3.1);
    v627.push(clip(`vc_${i % 9}_fill${1 + Math.floor(i / 9)}${i % 2 ? "_p1" : ""}`, t, end, i % 9));
    t = end;
  }

  it("video 627 is refused, and the reason says why", () => {
    const why = borrowedShotsRefusal(v627);
    expect(why).toMatch(/shots borrowed from other sentences fill 5\d% of the final timeline/);
    /** Through the rule both call sites already ask — no single source was over 50 %. */
    expect(finalTimelineFootageRefusal(v627)).toBe(why);
  });
  it("a film with a few filled holes is delivered as before", () => {
    const few = [clip("a", 0, 30, 1), clip("b", 30, 60, 2), clip("a_fill1", 60, 70, 1), clip("c", 70, 90, 3)];
    expect(borrowedShotsRefusal(few)).toBeNull();
    expect(finalTimelineFootageRefusal(few)).toBeNull();
  });
  it("a disabled clip does not count", () => {
    const off = [clip("a", 0, 40, 1), { ...clip("b_fill1", 40, 90, 2), disabled: true }];
    expect(borrowedShotsRefusal(off)).toBeNull();
  });
});
